import type { HostBridge, HostRpcFailure, HostRpcResult } from './bridge.ts'

/** DSH fetch dispatcher for one shared channel and exact Fetch routes. */
export interface DshFetchHandler {
  fetch(request: Request, peer: unknown): Promise<Response>
}

/** DSH connection members used by the relay bridge. */
export interface DshConnectionHandle {
  createSharedFetchHandler(channel: '/api'): DshFetchHandler
  createPeer(options: { principal: { kind: 'owner' }; interactions?: 'answer' | 'none' }): unknown
}

/** DSH Gateway stream dispatcher. */
export interface DshWireStream {
  open(
    endpoint: string,
    payload: unknown,
    uplink: AsyncIterable<unknown>,
    peer: unknown,
    signal: AbortSignal,
  ): Promise<AsyncIterable<unknown>>
  failure(error: unknown): { code: string; message: string; details: object }
}

/** Options for {@link createDshHostBridge}. */
export interface DshBridgeOptions {
  connection: DshConnectionHandle
  wireStream: DshWireStream
  /** Pre-created Peer; omitted creates an owner Peer with approval interaction. */
  peer?: unknown
}

/** Stream failure carrying the Gateway-projected code for the relay stream close reason. */
export class DshStreamFailure extends Error {
  constructor(readonly failure: { code: string; message: string; details: object }) {
    super(failure.message)
    this.name = 'DshStreamFailure'
  }
}

/**
 * Bridge from relay RPC frames to the DSH Host.
 *
 * Unary calls use the same `/api` envelope the browser posts, so every
 * registered Remote endpoint works without a second dispatch path. Streams use
 * the Gateway wire stream directly because it already owns snapshot, uplink,
 * and cancellation semantics.
 *
 * Binary-result endpoints (`workspaceFiles/readBytes`, `officeToPdf/render`)
 * answer with multipart/form-data: the JSON envelope rides in a `metadata`
 * part with `null` placeholders, and raw byte parts follow. The bridge splices
 * the parts back in and projects every byte payload as a `{$bytes: base64}`
 * JSON value, so the relay still forwards plain JSON application payloads.
 */
const BINARY_ENDPOINTS = new Set(['workspaceFiles/readBytes', 'officeToPdf/render'])

export function createDshHostBridge(options: DshBridgeOptions): HostBridge {
  let fetchHandler: DshFetchHandler | undefined
  let peer = options.peer

  const ensure = (): { handler: DshFetchHandler; peer: unknown } => {
    fetchHandler ??= options.connection.createSharedFetchHandler('/api')
    peer ??= options.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })
    return { handler: fetchHandler, peer }
  }

  return {
    async call(endpoint, payload, signal): Promise<HostRpcResult> {
      if (typeof endpoint !== 'string' || endpoint.length === 0) {
        return failure('host/invalid-endpoint', 'endpoint must be a non-empty string')
      }
      const current = ensure()
      const rpcId = randomId()
      let request: Request
      try {
        request = new Request(`http://dsh.internal/api/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (error) {
        return failure('host/request-invalid', messageOf(error))
      }

      let response: Response
      try {
        response = await current.handler.fetch(request, current.peer)
      } catch (error) {
        if (signal?.aborted === true) return failure('host/aborted', 'the call was cancelled')
        return failure('transport/request-failed', messageOf(error))
      }
      if (!response.ok) {
        return failure(`transport/http-${response.status}`, `Host returned HTTP ${response.status}`, {
          status: response.status,
        })
      }

      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (BINARY_ENDPOINTS.has(endpoint) && contentType === 'multipart/form-data') {
        return decodeBinaryResponse(response, rpcId)
      }

      let body: unknown
      try {
        body = await response.json()
      } catch (error) {
        return failure('transport/invalid-json', messageOf(error))
      }
      return parseServerResponse(body, rpcId).result
    },

    open(endpoint, payload, uplink, signal) {
      return streamValues(options.wireStream, ensure().peer, endpoint, payload, uplink, signal)
    },
  }
}

/** Splice one byte part back into the envelope value and project it as base64. */
function decodeBinaryResponse(response: Response, expectedRpcId: string): Promise<HostRpcResult> {
  return response.formData().then(
    async (form) => {
      const metadata = form.get('metadata')
      if (typeof metadata !== 'string') {
        return failure('transport/invalid-binary', 'binary response carries no metadata part')
      }
      let body: unknown
      try {
        body = JSON.parse(metadata)
      } catch (error) {
        return failure('transport/invalid-binary', messageOf(error))
      }
      const parsed = parseServerResponse(body, expectedRpcId)
      if (!parsed.result.ok) return parsed.result
      let value: unknown = parsed.result.value
      for (const attachment of parsed.attachments) {
        if (
          typeof attachment !== 'object' ||
          attachment === null ||
          (attachment as Record<string, unknown>)['codec'] !== 'bytes' ||
          typeof (attachment as Record<string, unknown>)['part'] !== 'string' ||
          !Array.isArray((attachment as Record<string, unknown>)['path'])
        ) {
          return failure('transport/invalid-binary', 'binary response declares a malformed attachment')
        }
        const record = attachment as { part: string; path: (string | number)[] }
        const part = form.get(record['part'])
        if (!(part instanceof Blob)) {
          return failure('transport/invalid-binary', `binary response part ${record['part']} is missing`)
        }
        const bytes = new Uint8Array(await part.arrayBuffer())
        try {
          value = spliceBytes(value, record['path'], bytesToBase64(bytes))
        } catch (error) {
          return failure('transport/invalid-binary', messageOf(error))
        }
      }
      return { ok: true, value }
    },
    (error: unknown) => failure('transport/invalid-binary', messageOf(error)),
  )
}

/** Replace the `null` placeholder at `path` with a base64 byte marker. */
function spliceBytes(value: unknown, path: readonly (string | number)[], base64: string): unknown {
  if (path.length === 0) return { $bytes: base64 }
  let container: unknown = value
  for (const segment of path.slice(0, -1)) {
    container = childAt(container, segment)
  }
  const key = path[path.length - 1]!
  if (Array.isArray(container)) {
    if (typeof key !== 'number' || !Number.isSafeInteger(key) || container[key] !== null) {
      throw new Error('binary attachment path does not address a placeholder')
    }
    container[key] = { $bytes: base64 }
    return value
  }
  if (typeof container === 'object' && container !== null && !Array.isArray(container)) {
    const record = container as Record<string, unknown>
    const field = typeof key === 'number' ? String(key) : key
    if (record[field] !== null) {
      throw new Error('binary attachment path does not address a placeholder')
    }
    record[field] = { $bytes: base64 }
    return value
  }
  throw new Error('binary attachment path does not address a placeholder')
}

function childAt(container: unknown, segment: unknown): unknown {
  if (Array.isArray(container)) {
    if (typeof segment !== 'number' || !Number.isSafeInteger(segment)) {
      throw new Error('binary attachment path is malformed')
    }
    return container[segment]
  }
  if (typeof container === 'object' && container !== null) {
    return (container as Record<string, unknown>)[String(segment)]
  }
  throw new Error('binary attachment path is malformed')
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const byte0 = bytes[index]!
    const byte1 = bytes[index + 1]
    const byte2 = bytes[index + 2]
    out += BASE64_ALPHABET[byte0 >> 2]
    out += BASE64_ALPHABET[((byte0 & 0x03) << 4) | ((byte1 ?? 0) >> 4)]
    out += byte1 === undefined ? '=' : BASE64_ALPHABET[((byte1 & 0x0f) << 2) | ((byte2 ?? 0) >> 6)]
    out += byte2 === undefined ? '=' : BASE64_ALPHABET[byte2 & 0x3f]
  }
  return out
}

async function* streamValues(
  wireStream: DshWireStream,
  peer: unknown,
  endpoint: string,
  payload: unknown,
  uplink: AsyncIterable<unknown>,
  signal: AbortSignal,
): AsyncIterable<unknown> {
  let values: AsyncIterable<unknown>
  try {
    values = await wireStream.open(endpoint, payload, uplink, peer, signal)
  } catch (error) {
    throw projectStreamFailure(wireStream, error)
  }
  try {
    for await (const value of values) yield value
  } catch (error) {
    throw projectStreamFailure(wireStream, error)
  }
}

function projectStreamFailure(wireStream: DshWireStream, error: unknown): DshStreamFailure {
  try {
    return new DshStreamFailure(wireStream.failure(error))
  } catch {
    return new DshStreamFailure({
      code: 'host/stream-failed',
      message: messageOf(error),
      details: {},
    })
  }
}

function parseServerResponse(
  body: unknown,
  expectedRpcId: string,
): { result: HostRpcResult; attachments: readonly unknown[] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { result: failure('transport/invalid-result', 'Host response is not an object'), attachments: [] }
  }
  const record = body as Record<string, unknown>
  if (record.type !== 'server-response') {
    return { result: failure('transport/invalid-result', 'Host response is not a server-response envelope'), attachments: [] }
  }
  if (record.rpcId !== expectedRpcId) {
    return { result: failure('transport/rpc-mismatch', 'Host response rpcId does not match the request'), attachments: [] }
  }
  const result = record.result
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return { result: failure('transport/invalid-result', 'Host result is not an object'), attachments: [] }
  }
  const envelope = result as Record<string, unknown>
  const attachments = Array.isArray(record['attachments']) ? record['attachments'] : []
  if (envelope.ok === true) return { result: { ok: true, value: envelope.value }, attachments }
  if (envelope.ok === false && typeof envelope.error === 'object' && envelope.error !== null) {
    const error = envelope.error as Record<string, unknown>
    if (typeof error.code === 'string' && typeof error.message === 'string') {
      return {
        result: {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(typeof error.details === 'object' && error.details !== null
              ? { details: error.details as object }
              : {}),
          },
        },
        attachments,
      }
    }
  }
  return { result: failure('transport/invalid-result', 'Host result is neither a success nor a failure envelope'), attachments: [] }
}

function failure(code: string, message: string, details?: object): { ok: false; error: HostRpcFailure } {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } }
}

function randomId(): string {
  return globalThis.crypto.randomUUID()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
