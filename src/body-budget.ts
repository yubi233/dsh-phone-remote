/**
 * Snapshot byte budget and full-body references for the phone.
 *
 * A Session opening snapshot carries the same payload the desktop receives,
 * including complete tool output and persisted assistant attempts. The phone
 * must render its first screen quickly over a relay connection, so the Host
 * replaces large display fields with a short preview and records how to fetch
 * the original text on demand.
 *
 * Trimming only changes the response; the Session log stays authoritative. A
 * `refId` names the durable event and the field path, so `remote/body` can
 * re-read the original text after a Host restart.
 */

import { createHash } from 'node:crypto'
import type { HostBridge, HostRpcResult } from './bridge.ts'

/** Preview marker attached to one trimmed field. */
export interface BodyRef {
  /** Opaque reference accepted by `remote/body`. */
  readonly refId: string
  /** SHA-256 of the complete UTF-8 text, lowercase hex. */
  readonly hash: string
  /** Complete text size in UTF-8 bytes. */
  readonly fullBytes: number
  /** Preview size in UTF-8 bytes. */
  readonly previewBytes: number
}

/** Complete text returned for one body reference. */
export interface BodyContent {
  readonly text: string
  /** SHA-256 of {@link text}; the phone verifies it against the preview marker. */
  readonly hash: string
  /** UTF-8 byte length of {@link text}. */
  readonly bytes: number
}

/** Options for {@link withBodyBudget}. */
export interface BodyBudgetOptions {
  /** Soft byte budget for one opening snapshot or history page. */
  maxBytes?: number
  /** Read one Session log for `remote/body`; returns events with `seq` and `data`. */
  readEvents(sessionId: string): Promise<readonly unknown[]>
}

/** Default first-screen budget, matching the ZCode mobile remote budget. */
export const DEFAULT_BODY_BUDGET_BYTES = 200_000

/** Tool arguments above this size are replaced with a preview when over budget. */
const TOOL_INPUT_THRESHOLD_BYTES = 1_024
/** Tool argument preview size. */
const TOOL_INPUT_PREVIEW_BYTES = 256
/** Tool output above this size is replaced with a preview when over budget. */
const TOOL_OUTPUT_THRESHOLD_BYTES = 4_096
/** Tool output preview size. */
const TOOL_OUTPUT_PREVIEW_BYTES = 512
/** Floor for the assistant/reasoning preview while shrinking to fit. */
const MIN_ASSISTANT_PREVIEW_BYTES = 2_048
/** Hard cap for the assistant/reasoning preview. */
const MAX_ASSISTANT_PREVIEW_BYTES = 32_768

interface Settings {
  maxBytes: number
  assistantPreviewBytes: number
  readEvents(sessionId: string): Promise<readonly unknown[]>
}

interface DecodedRef {
  sessionId: string
  seq: number
  path: (string | number)[]
}

/**
 * Add first-screen trimming and `remote/body` to a Host bridge.
 *
 * `session/follow` snapshot frames and `session/page` results over the budget
 * lose their largest display fields; every replacement carries a `remoteBody`
 * marker. Live event frames keep their display fields so an in-progress reply
 * renders completely, but drop the duplicate timed stream the phone never uses.
 *
 * @param bridge - Gateway-backed bridge used for every other endpoint.
 * @param options - budget and the Session reader used to resolve references.
 * @returns A bridge that trims opening payloads and serves `remote/body`.
 */
export function withBodyBudget(bridge: HostBridge, options: BodyBudgetOptions): HostBridge {
  const settings = resolveSettings(options)
  return {
    async call(endpoint, payload, signal): Promise<HostRpcResult> {
      if (endpoint === 'remote/body') return await bodyResult(settings, payload)
      const result = await bridge.call(endpoint, payload, signal)
      if (endpoint !== 'session/page' || !result.ok) return result
      const sessionId = sessionIdFromRequest(payload)
      if (sessionId === undefined) return result
      return { ok: true, value: budgetPage(result.value, sessionId, settings) }
    },
    open: (endpoint, payload, uplink, signal) => {
      const stream = bridge.open(endpoint, payload, uplink, signal)
      if (endpoint !== 'session/follow') return stream
      return budgetFollow(stream, payload, settings)
    },
  }
}

function resolveSettings(options: BodyBudgetOptions): Settings {
  const maxBytes = options.maxBytes ?? DEFAULT_BODY_BUDGET_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('body budget must be a positive safe integer')
  }
  return {
    maxBytes,
    assistantPreviewBytes: Math.min(
      MAX_ASSISTANT_PREVIEW_BYTES,
      Math.max(MIN_ASSISTANT_PREVIEW_BYTES, Math.floor(maxBytes / 3)),
    ),
    readEvents: options.readEvents,
  }
}

async function* budgetFollow(
  stream: AsyncIterable<unknown>,
  payload: unknown,
  settings: Settings,
): AsyncGenerator<unknown, void, undefined> {
  let sessionId = sessionIdFromRequest(payload)
  for await (const frame of stream) {
    if (!isRecord(frame)) {
      yield frame
      continue
    }
    if (frame['type'] === 'snapshot' && isRecord(frame['header'])) {
      const id = frame['header']['id']
      if (typeof id === 'string' && id !== '') sessionId = id
      if (sessionId !== undefined) {
        yield budgetSnapshot(frame, sessionId, settings)
        continue
      }
    }
    if (frame['type'] === 'event') {
      yield stripLiveEvent(frame)
      continue
    }
    yield frame
  }
}

function budgetSnapshot(
  frame: Record<string, unknown>,
  sessionId: string,
  settings: Settings,
): Record<string, unknown> {
  const records = frame['records']
  if (!Array.isArray(records)) return frame
  const overhead = jsonBytes({ ...frame, records: [] })
  const budget = Math.max(0, settings.maxBytes - overhead)
  const next = budgetRecords(records, sessionId, budget, settings)
  if (next === records) return frame
  return { ...frame, records: next }
}

function budgetPage(value: unknown, sessionId: string, settings: Settings): unknown {
  if (!isRecord(value) || !Array.isArray(value['records'])) return value
  const overhead = jsonBytes({ ...value, records: [] })
  const budget = Math.max(0, settings.maxBytes - overhead)
  const next = budgetRecords(value['records'], sessionId, budget, settings)
  if (next === value['records']) return value
  return { ...value, records: next }
}

function budgetRecords(
  records: readonly unknown[],
  sessionId: string,
  budget: number,
  settings: Settings,
): readonly unknown[] {
  const stripped = records.map(stripRecordStreams)
  const strippedChanged = stripped.some((record, index) => record !== records[index])
  if (jsonBytes(stripped) <= budget) {
    return strippedChanged ? stripped : records
  }

  for (const cap of assistantPreviewCaps(settings.assistantPreviewBytes)) {
    const trimmed = trimRecords(stripped, sessionId, cap, settings)
    if (jsonBytes(trimmed) <= budget) return trimmed
  }

  const minimal = trimRecords(stripped, sessionId, MIN_ASSISTANT_PREVIEW_BYTES, settings)
  const withoutHidden = dropHiddenPayloads(minimal)
  return jsonBytes(withoutHidden) <= jsonBytes(minimal) ? withoutHidden : minimal
}

function assistantPreviewCaps(start: number): number[] {
  const caps: number[] = []
  for (let cap = start; cap > MIN_ASSISTANT_PREVIEW_BYTES; cap = Math.floor(cap / 2)) {
    caps.push(cap)
  }
  caps.push(MIN_ASSISTANT_PREVIEW_BYTES)
  return caps
}

function stripRecordStreams(record: unknown): unknown {
  if (!isRecord(record) || record['type'] !== 'event') return record
  return stripEventStreams(record)
}

function stripLiveEvent(frame: Record<string, unknown>): unknown {
  return stripEventStreams(frame)
}

function stripEventStreams(record: Record<string, unknown>): unknown {
  const event = record['event']
  if (!isRecord(event) || event['type'] !== 'assistant/message' && event['type'] !== 'assistant/attempt') {
    return record
  }
  const data = event['data']
  if (!isRecord(data) || !Array.isArray(data['stream'])) return record
  const stream = event['type'] === 'assistant/message'
    ? []
    : data['stream'].filter(isDecisionChunk)
  if (stream.length === data['stream'].length) {
    // An already-minimal stream needs no copy.
    return record
  }
  return {
    ...record,
    event: { ...event, data: { ...data, stream } },
  }
}

/**
 * Keep the finish record the phone reads from a failed attempt. Packed delta
 * runs and block-end records repeat the full message content.
 */
function isDecisionChunk(entry: unknown): boolean {
  if (!isRecord(entry)) return false
  const chunk = entry['chunk']
  if (!isRecord(chunk)) return false
  return chunk['type'] === 'finish'
}

function trimRecords(
  records: readonly unknown[],
  sessionId: string,
  assistantCap: number,
  settings: Settings,
): readonly unknown[] {
  let changed = false
  const next = records.map((record) => {
    if (!isRecord(record) || record['type'] !== 'event') return record
    const event = record['event']
    if (!isRecord(event)) return record
    const data = event['data']
    if (!isRecord(data)) return record
    const seq = event['seq']
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return record
    const type = event['type']
    if (type !== 'assistant/message' && type !== 'tool/result' && type !== 'tool/call') return record

    const working = { ...record, event: { ...event, data: structuredClone(data) } }
    const workingData = working.event.data
    const trimmed = type === 'assistant/message'
      ? trimContent(workingData, ['message', 'content'], sessionId, seq, assistantCap, assistantCap)
      : type === 'tool/result'
        ? trimContent(
          workingData,
          ['message', 'content'],
          sessionId,
          seq,
          TOOL_OUTPUT_THRESHOLD_BYTES,
          TOOL_OUTPUT_PREVIEW_BYTES,
        )
        : trimToolArguments(workingData, sessionId, seq)
    if (!trimmed) return record
    changed = true
    return working
  })
  return changed ? next : records
}

function trimContent(
  data: Record<string, unknown>,
  prefix: (string | number)[],
  sessionId: string,
  seq: number,
  threshold: number,
  cap: number,
): boolean {
  const container = walk(data, prefix)
  if (!Array.isArray(container)) return false
  let changed = false
  for (let index = 0; index < container.length; index += 1) {
    const block = container[index]
    if (!isRecord(block)) continue
    const type = block['type']
    if (type !== 'text' && type !== 'reasoning') continue
    const text = block['text']
    if (typeof text !== 'string') continue
    const bytes = utf8Bytes(text)
    if (bytes <= threshold) continue
    const preview = truncateUtf8(text, cap)
    block['text'] = preview
    block['remoteBody'] = createRef(sessionId, seq, [...prefix, index, 'text'], text, preview)
    changed = true
  }
  return changed
}

function trimToolArguments(
  data: Record<string, unknown>,
  sessionId: string,
  seq: number,
): boolean {
  const text = data['arguments']
  if (typeof text !== 'string') return false
  if (utf8Bytes(text) <= TOOL_INPUT_THRESHOLD_BYTES) return false
  const preview = truncateUtf8(text, TOOL_INPUT_PREVIEW_BYTES)
  data['arguments'] = preview
  data['argumentsBody'] = createRef(sessionId, seq, ['arguments'], text, preview)
  return true
}

/** Remove payloads the phone never renders when previews still exceed the budget. */
function dropHiddenPayloads(records: readonly unknown[]): readonly unknown[] {
  return records.map((record) => {
    if (!isRecord(record) || record['type'] !== 'event') return record
    const event = record['event']
    if (!isRecord(event) || !isRecord(event['data'])) return record
    const type = event['type']
    const data = event['data']
    if (type === 'developer/message' || type === 'system/message') {
      if (!('message' in data)) return record
      const nextData = { ...data }
      delete nextData['message']
      return { ...record, event: { ...event, data: nextData } }
    }
    if (type === 'tool/result' && 'meta' in data) {
      const nextData = { ...data }
      delete nextData['meta']
      return { ...record, event: { ...event, data: nextData } }
    }
    return record
  })
}

function createRef(
  sessionId: string,
  seq: number,
  path: (string | number)[],
  full: string,
  preview: string,
): BodyRef {
  const refId = Buffer.from(JSON.stringify({ v: 1, s: sessionId, q: seq, p: path }), 'utf8').toString('base64url')
  return {
    refId,
    hash: createHash('sha256').update(full, 'utf8').digest('hex'),
    fullBytes: utf8Bytes(full),
    previewBytes: utf8Bytes(preview),
  }
}

async function bodyResult(settings: Settings, payload: unknown): Promise<HostRpcResult> {
  const refId = refIdFromPayload(payload)
  if (refId === undefined) {
    return failure('body/invalid-request', 'remote/body requires a non-empty refId')
  }
  const ref = decodeRef(refId)
  if (ref === undefined) {
    return failure('body/invalid-ref', 'the body reference is not recognized')
  }
  let events: readonly unknown[]
  try {
    events = await settings.readEvents(ref.sessionId)
  } catch (error: unknown) {
    return failure('body/read-failed', messageOf(error))
  }
  const event = events.find((candidate) => isRecord(candidate) && candidate['seq'] === ref.seq)
  if (!isRecord(event)) return failure('body/not-found', 'the referenced event is no longer available')
  const text = walk(event['data'], ref.path)
  if (typeof text !== 'string') {
    return failure('body/not-found', 'the referenced field is no longer available')
  }
  return {
    ok: true,
    value: {
      text,
      hash: createHash('sha256').update(text, 'utf8').digest('hex'),
      bytes: utf8Bytes(text),
    } satisfies BodyContent,
  }
}

function refIdFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload['args']) || !isRecord(payload['args']['request'])) {
    return undefined
  }
  const refId = payload['args']['request']['refId']
  return typeof refId === 'string' && refId !== '' ? refId : undefined
}

function decodeRef(refId: string): DecodedRef | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(refId, 'base64url').toString('utf8'))
  } catch {
    // A malformed reference is a client error, reported as an invalid ref.
    return undefined
  }
  if (!isRecord(parsed) || parsed['v'] !== 1) return undefined
  const sessionId = parsed['s']
  const seq = parsed['q']
  const path = parsed['p']
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 256) return undefined
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return undefined
  if (!Array.isArray(path) || path.length === 0 || path.length > 12) return undefined
  const segments: (string | number)[] = []
  for (const segment of path) {
    if (typeof segment === 'string') {
      if (segment === '' || segment.length > 128 || segment === '__proto__'
        || segment === 'constructor' || segment === 'prototype') return undefined
      segments.push(segment)
      continue
    }
    if (typeof segment !== 'number' || !Number.isSafeInteger(segment) || segment < 0 || segment > 1_000_000) {
      return undefined
    }
    segments.push(segment)
  }
  return { sessionId, seq, path: segments }
}

function sessionIdFromRequest(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload['args']) || !isRecord(payload['args']['request'])) {
    return undefined
  }
  const address = payload['args']['request']['address']
  if (!isRecord(address)) return undefined
  if (address['kind'] === 'session') {
    return typeof address['sessionId'] === 'string' && address['sessionId'] !== ''
      ? address['sessionId']
      : undefined
  }
  if (address['kind'] === 'subagent') {
    return typeof address['childSessionId'] === 'string' && address['childSessionId'] !== ''
      ? address['childSessionId']
      : undefined
  }
  return undefined
}

function walk(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value
  for (const segment of path) {
    if (typeof segment === 'string') {
      if (!isRecord(current)) return undefined
      current = current[segment]
      continue
    }
    if (!Array.isArray(current) || segment >= current.length) return undefined
    current = current[segment]
  }
  return current
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1
  return `${buffer.subarray(0, end).toString('utf8')}\n\n…`
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value))
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
