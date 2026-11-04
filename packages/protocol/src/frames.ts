import { base64ToBytes, bytesToBase64, isCanonicalBase64 } from './base64.ts'
import {
  ASSEMBLY_TIMEOUT_MS,
  FRAGMENT_BYTES,
  MAX_ASSEMBLIES,
  MAX_ASSEMBLY_BYTES,
  MAX_FRAGMENTS,
  MAX_MESSAGE_BYTES,
  MAX_PHYSICAL_FRAME_BYTES,
} from './constants.ts'
import { crc32Hex } from './crc32.ts'
import { ProtocolError, requireInteger, requireRecord, requireString } from './errors.ts'

/** Identity and ordering fields shared by every fragment of one logical message. */
export interface FrameMeta {
  /** Logical stream (bridge session) the message belongs to. */
  bridgeSessionId: string
  /** Bumped when the stream is re-established over a new bridge. */
  bridgeGeneration: number
  /** Per-bridge logical message sequence, starting at 1. */
  seq: number
  /** Per-message identity used for acknowledgement and replay. */
  messageSeq: number
  /** Resume token echoed on replay, absent for first transmissions. */
  recoveryId?: string
}

/** One physical relay frame. Field names are part of the wire contract. */
export interface RelayFrame extends FrameMeta {
  type: 'rpc-frame'
  fragmentIndex: number
  fragmentCount: number
  messageBytes: number
  checksum: { algorithm: 'crc32'; value: string }
  dataBase64: string
}

/** One reassembled logical message. */
export interface AssembledMessage {
  meta: FrameMeta
  payload: unknown
}

/** Result of feeding one fragment into an assembler. */
export type AssemblyResult =
  | { status: 'pending' }
  | { status: 'complete'; message: AssembledMessage }
  | { status: 'dropped'; code: ProtocolError['code']; reason: string }

/** A batch evicted by the size or count bound of an assembler. */
export interface AssemblyEviction {
  key: string
  meta: FrameMeta
  reason: 'timeout' | 'evicted'
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Serialize and fragment one logical payload into physical frames. */
export function encodeMessage(
  meta: FrameMeta,
  payload: unknown,
  fragmentBytes = FRAGMENT_BYTES,
): RelayFrame[] {
  requireString(meta.bridgeSessionId, 'bridgeSessionId')
  requireInteger(meta.bridgeGeneration, 'bridgeGeneration')
  requireInteger(meta.seq, 'seq', 1)
  requireInteger(meta.messageSeq, 'messageSeq', 1)
  if (meta.recoveryId !== undefined) requireString(meta.recoveryId, 'recoveryId')
  if (!Number.isSafeInteger(fragmentBytes) || fragmentBytes <= 0 || fragmentBytes > MAX_MESSAGE_BYTES) {
    throw new ProtocolError('invalid-message', 'fragmentBytes out of range')
  }
  const bytes = encoder.encode(JSON.stringify(payload))
  if (bytes.length > MAX_MESSAGE_BYTES) {
    throw new ProtocolError('message-too-large', `message is ${bytes.length} bytes`)
  }
  const fragmentCount = Math.max(1, Math.ceil(bytes.length / fragmentBytes))
  if (fragmentCount > MAX_FRAGMENTS) {
    throw new ProtocolError('too-many-fragments', `message needs ${fragmentCount} fragments`)
  }
  const checksum = { algorithm: 'crc32' as const, value: crc32Hex(bytes) }
  const frames: RelayFrame[] = []
  for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
    const start = fragmentIndex * fragmentBytes
    const frame: RelayFrame = {
      type: 'rpc-frame',
      ...meta,
      fragmentIndex,
      fragmentCount,
      messageBytes: bytes.length,
      checksum,
      dataBase64: bytesToBase64(bytes.subarray(start, Math.min(start + fragmentBytes, bytes.length))),
    }
    if (encoder.encode(JSON.stringify(frame)).length > MAX_PHYSICAL_FRAME_BYTES) {
      throw new ProtocolError('frame-too-large', `fragment ${fragmentIndex} exceeds physical frame limit`)
    }
    frames.push(frame)
  }
  return frames
}

/** Validate a parsed JSON value as a {@link RelayFrame}. */
export function parseRelayFrame(value: unknown): RelayFrame {
  const record = requireRecord(value, 'frame')
  if (record.type !== 'rpc-frame') throw new ProtocolError('invalid-frame', 'type must be rpc-frame')
  const bridgeSessionId = requireString(record.bridgeSessionId, 'bridgeSessionId')
  const bridgeGeneration = requireInteger(record.bridgeGeneration, 'bridgeGeneration')
  const seq = requireInteger(record.seq, 'seq', 1)
  const messageSeq = requireInteger(record.messageSeq, 'messageSeq', 1)
  const recoveryId =
    record.recoveryId === undefined ? undefined : requireString(record.recoveryId, 'recoveryId')
  const fragmentIndex = requireInteger(record.fragmentIndex, 'fragmentIndex')
  const fragmentCount = requireInteger(record.fragmentCount, 'fragmentCount', 1)
  const messageBytes = requireInteger(record.messageBytes, 'messageBytes')
  if (fragmentCount > MAX_FRAGMENTS) {
    throw new ProtocolError('too-many-fragments', `fragmentCount is ${fragmentCount}`)
  }
  if (fragmentIndex >= fragmentCount) {
    throw new ProtocolError('fragment-index-out-of-range', `${fragmentIndex}/${fragmentCount}`)
  }
  if (messageBytes > MAX_MESSAGE_BYTES) {
    throw new ProtocolError('message-too-large', `messageBytes is ${messageBytes}`)
  }
  const checksumRecord = requireRecord(record.checksum, 'checksum')
  if (checksumRecord.algorithm !== 'crc32') {
    throw new ProtocolError('invalid-frame', 'checksum.algorithm must be crc32')
  }
  const checksumValue = requireString(checksumRecord.value, 'checksum.value')
  if (!/^[0-9a-f]{8}$/.test(checksumValue)) {
    throw new ProtocolError('invalid-frame', 'checksum.value must be eight lowercase hex digits')
  }
  const dataBase64 = requireString(record.dataBase64, 'dataBase64', true)
  if (!isCanonicalBase64(dataBase64)) {
    throw new ProtocolError('invalid-base64', 'dataBase64 is not canonical base64')
  }
  return {
    type: 'rpc-frame',
    bridgeSessionId,
    bridgeGeneration,
    seq,
    messageSeq,
    ...(recoveryId === undefined ? {} : { recoveryId }),
    fragmentIndex,
    fragmentCount,
    messageBytes,
    checksum: { algorithm: 'crc32', value: checksumValue },
    dataBase64,
  }
}

/**
 * Reassembles fragmented logical messages.
 *
 * Assemblies are keyed by stream and message identity. A metadata conflict,
 * checksum failure, duplicate fragment with different bytes, or timeout drops
 * the whole assembly; partial payloads are never returned.
 */
export class FrameAssembler {
  readonly #assemblies = new Map<string, Assembly>()
  readonly #evictions: AssemblyEviction[] = []
  #bufferedBytes = 0
  readonly #timeoutMs: number
  readonly #maxAssemblies: number
  readonly #maxBytes: number

  constructor(options: { timeoutMs?: number; maxAssemblies?: number; maxBytes?: number } = {}) {
    this.#timeoutMs = options.timeoutMs ?? ASSEMBLY_TIMEOUT_MS
    this.#maxAssemblies = options.maxAssemblies ?? MAX_ASSEMBLIES
    this.#maxBytes = options.maxBytes ?? MAX_ASSEMBLY_BYTES
  }

  /** Number of assemblies currently buffering fragments. */
  get size(): number {
    return this.#assemblies.size
  }

  /** Bytes currently held by buffering assemblies. */
  get bufferedBytes(): number {
    return this.#bufferedBytes
  }

  /** Feed one parsed or raw frame; anomalies are reported, not thrown. */
  add(input: unknown, now = Date.now()): AssemblyResult {
    let frame: RelayFrame
    try {
      frame = parseRelayFrame(input)
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { status: 'dropped', code: error.code, reason: error.message }
      }
      throw error
    }

    this.sweep(now)
    const key = assemblyKey(frame)
    let assembly = this.#assemblies.get(key)
    if (assembly !== undefined && !sameMeta(assembly.meta, frame)) {
      this.#delete(key)
      return { status: 'dropped', code: 'metadata-mismatch', reason: 'fragment metadata differs' }
    }

    if (frame.fragmentCount === 1) {
      return this.#complete(frame, [base64ToBytes(frame.dataBase64)])
    }

    if (assembly === undefined) {
      if (this.#assemblies.size >= this.#maxAssemblies) {
        this.#evictOldest(now)
      }
      assembly = {
        meta: frameMeta(frame),
        fragmentCount: frame.fragmentCount,
        messageBytes: frame.messageBytes,
        checksum: frame.checksum.value,
        fragments: new Map(),
        bytes: 0,
        firstSeenAt: now,
      }
      this.#assemblies.set(key, assembly)
    } else if (
      assembly.fragmentCount !== frame.fragmentCount ||
      assembly.messageBytes !== frame.messageBytes ||
      assembly.checksum !== frame.checksum.value
    ) {
      this.#delete(key)
      return { status: 'dropped', code: 'metadata-mismatch', reason: 'fragment metadata differs' }
    }

    const existing = assembly.fragments.get(frame.fragmentIndex)
    const fragment = base64ToBytes(frame.dataBase64)
    if (existing !== undefined) {
      if (!sameBytes(existing, fragment)) {
        this.#delete(key)
        return { status: 'dropped', code: 'fragment-conflict', reason: 'duplicate fragment differs' }
      }
      return { status: 'pending' }
    }

    assembly.fragments.set(frame.fragmentIndex, fragment)
    assembly.bytes += fragment.length
    this.#bufferedBytes += fragment.length
    if (this.#bufferedBytes > this.#maxBytes) {
      this.#delete(key)
      return { status: 'dropped', code: 'assembly-evicted', reason: 'assembly byte budget exceeded' }
    }
    if (assembly.fragments.size < assembly.fragmentCount) return { status: 'pending' }

    const parts: Uint8Array[] = []
    for (let index = 0; index < assembly.fragmentCount; index += 1) {
      const part = assembly.fragments.get(index)
      if (part === undefined) return { status: 'pending' }
      parts.push(part)
    }
    this.#delete(key)
    return this.#complete(frame, parts, assembly)
  }

  /** Drop assemblies older than the timeout; returns what was dropped. */
  sweep(now = Date.now()): AssemblyEviction[] {
    const dropped: AssemblyEviction[] = []
    for (const [key, assembly] of this.#assemblies) {
      if (now - assembly.firstSeenAt >= this.#timeoutMs) {
        dropped.push({ key, meta: assembly.meta, reason: 'timeout' })
        this.#delete(key)
      }
    }
    this.#evictions.push(...dropped)
    return dropped
  }

  /** Remove and return eviction records accumulated since the last drain. */
  drainEvictions(): AssemblyEviction[] {
    return this.#evictions.splice(0, this.#evictions.length)
  }

  /** Drop every buffered assembly, for example when the connection generation changes. */
  clear(): void {
    this.#assemblies.clear()
    this.#bufferedBytes = 0
  }

  #complete(frame: RelayFrame, parts: Uint8Array[], assembly?: Assembly): AssemblyResult {
    const total = parts.reduce((sum, part) => sum + part.length, 0)
    if (total !== frame.messageBytes) {
      return {
        status: 'dropped',
        code: 'byte-length-mismatch',
        reason: `expected ${frame.messageBytes} bytes, got ${total}`,
      }
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.length
    }
    const actual = crc32Hex(bytes)
    if (actual !== frame.checksum.value) {
      return {
        status: 'dropped',
        code: 'checksum-mismatch',
        reason: `expected ${frame.checksum.value}, got ${actual}`,
      }
    }
    let payload: unknown
    try {
      payload = JSON.parse(decoder.decode(bytes))
    } catch {
      return { status: 'dropped', code: 'invalid-json', reason: 'payload is not JSON' }
    }
    return {
      status: 'complete',
      message: { meta: assembly?.meta ?? frameMeta(frame), payload },
    }
  }

  #evictOldest(now: number): void {
    let oldestKey: string | undefined
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [key, assembly] of this.#assemblies) {
      if (assembly.firstSeenAt < oldestAt) {
        oldestAt = assembly.firstSeenAt
        oldestKey = key
      }
    }
    if (oldestKey !== undefined) {
      const assembly = this.#assemblies.get(oldestKey)!
      this.#evictions.push({ key: oldestKey, meta: assembly.meta, reason: 'evicted' })
      this.#delete(oldestKey)
    }
    void now
  }

  #delete(key: string): void {
    const assembly = this.#assemblies.get(key)
    if (assembly === undefined) return
    this.#bufferedBytes -= assembly.bytes
    this.#assemblies.delete(key)
  }
}

interface Assembly {
  meta: FrameMeta
  fragmentCount: number
  messageBytes: number
  checksum: string
  fragments: Map<number, Uint8Array>
  bytes: number
  firstSeenAt: number
}

/** Stable assembly key for one logical message. */
function assemblyKey(frame: RelayFrame): string {
  return `${frame.bridgeSessionId}\u0000${frame.bridgeGeneration}\u0000${frame.messageSeq}`
}

function frameMeta(frame: RelayFrame): FrameMeta {
  return {
    bridgeSessionId: frame.bridgeSessionId,
    bridgeGeneration: frame.bridgeGeneration,
    seq: frame.seq,
    messageSeq: frame.messageSeq,
    ...(frame.recoveryId === undefined ? {} : { recoveryId: frame.recoveryId }),
  }
}

function sameMeta(left: FrameMeta, right: FrameMeta): boolean {
  return (
    left.bridgeSessionId === right.bridgeSessionId &&
    left.bridgeGeneration === right.bridgeGeneration &&
    left.seq === right.seq &&
    left.messageSeq === right.messageSeq &&
    left.recoveryId === right.recoveryId
  )
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}
