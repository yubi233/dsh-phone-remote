import type { HostBridge, HostRpcResult } from './bridge.ts'

/** One prompt identity the phone wants to reconcile. */
export interface CommandQueryItem {
  sessionId: string
  requestId: string
}

/** Durable settlement of one prompt identity. */
export interface CommandSettlement extends CommandQueryItem {
  /** True when the Session log already contains the accepted user message. */
  settled: boolean
  /** Event seq of the recorded message when settled. */
  seq?: number
  /** Durable event time when settled. */
  at?: number
}

/** Session-log reader used by the query endpoint. */
export interface CommandQuerySource {
  readEvents(sessionId: string): Promise<readonly unknown[]>
}

/** Maximum prompt identities accepted by one query. */
const MAX_QUERY_ITEMS = 64
/** Maximum accepted id length for a Session or request identity. */
const MAX_ID_LENGTH = 256

/**
 * Add the cross-device command settlement query to a Host bridge.
 *
 * `remote/commands/query` answers whether a previously sent prompt reached the
 * Session log. The phone's outbox checks it before resending, so a prompt that
 * was accepted before the reply was lost is cleared instead of retried. DSH's
 * own `requestId` dedupe remains the safety net when the log read fails.
 *
 * @param bridge - bridge answering every other endpoint.
 * @param source - Session log reader.
 * @returns A bridge that also serves `remote/commands/query`.
 */
export function withCommandQueryEndpoint(bridge: HostBridge, source: CommandQuerySource): HostBridge {
  return {
    call(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<HostRpcResult> {
      if (endpoint === 'remote/commands/query') return queryCommands(source, payload)
      return bridge.call(endpoint, payload, signal)
    },
    open: (endpoint, payload, uplink, signal) => bridge.open(endpoint, payload, uplink, signal),
  }
}

async function queryCommands(source: CommandQuerySource, payload: unknown): Promise<HostRpcResult> {
  const items = itemsFromPayload(payload)
  if (items === undefined) {
    return failure('commands/invalid-request', 'remote/commands/query requires 1-64 sessionId/requestId items')
  }
  const bySession = new Map<string, CommandQueryItem[]>()
  for (const item of items) {
    const list = bySession.get(item.sessionId) ?? []
    list.push(item)
    bySession.set(item.sessionId, list)
  }
  const settled = new Map<string, CommandSettlement>()
  try {
    for (const [sessionId, sessionItems] of bySession) {
      const events = await source.readEvents(sessionId)
      for (const item of sessionItems) {
        settled.set(keyOf(item), settlementFor(sessionId, item.requestId, events))
      }
    }
  } catch (error: unknown) {
    return failure('commands/query-failed', messageOf(error))
  }
  return {
    ok: true,
    value: {
      items: items.map((item) => settled.get(keyOf(item)) ?? { ...item, settled: false }),
    },
  }
}

function settlementFor(
  sessionId: string,
  requestId: string,
  events: readonly unknown[],
): CommandSettlement {
  for (const event of events) {
    if (!isRecord(event) || event['type'] !== 'user/message') continue
    const data = event['data']
    if (!isRecord(data)) continue
    const source = data['source']
    if (!isRecord(source) || source['kind'] !== 'user' || source['rpcId'] !== requestId) continue
    const seq = event['seq']
    const at = event['time']
    return {
      sessionId,
      requestId,
      settled: true,
      ...(typeof seq === 'number' && Number.isSafeInteger(seq) ? { seq } : {}),
      ...(typeof at === 'number' && Number.isFinite(at) ? { at } : {}),
    }
  }
  return { sessionId, requestId, settled: false }
}

function itemsFromPayload(payload: unknown): CommandQueryItem[] | undefined {
  if (!isRecord(payload) || !isRecord(payload['args']) || !isRecord(payload['args']['request'])) {
    return undefined
  }
  const items = payload['args']['request']['items']
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_QUERY_ITEMS) return undefined
  const parsed: CommandQueryItem[] = []
  for (const item of items) {
    if (!isRecord(item)) return undefined
    const sessionId = item['sessionId']
    const requestId = item['requestId']
    if (!validId(sessionId) || !validId(requestId)) return undefined
    parsed.push({ sessionId, requestId })
  }
  return parsed
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= MAX_ID_LENGTH
}

function keyOf(item: CommandQueryItem): string {
  return `${item.sessionId}\u0000${item.requestId}`
}

function failure(code: string, message: string): HostRpcResult {
  return { ok: false, error: { code, message } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
