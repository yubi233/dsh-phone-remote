import { REPLAY_BUFFER_BYTES, REPLAY_TTL_MS } from './constants.ts'
import type { FrameMeta, RelayFrame } from './frames.ts'

/** One logical message kept for replay until acknowledged. */
export interface ReplayBatch {
  meta: FrameMeta
  frames: RelayFrame[]
  bytes: number
  firstSentAt: number
}

/** Batches removed by an ACK, TTL expiry, or a buffer-budget eviction. */
export interface ReplayDrop {
  batch: ReplayBatch
  reason: 'acknowledged' | 'expired' | 'overflow' | 'disposed'
}

/**
 * Keeps unacknowledged outbound frames so a reconnected bridge can resend them.
 *
 * ACK is cumulative per bridge: acknowledging message `N` releases every batch
 * up to `N`. When the byte budget or TTL forces a drop, the caller receives the
 * affected batches and must request a snapshot instead of silently losing them.
 */
export class OutboundReplayBuffer {
  readonly #batches = new Map<string, ReplayBatch>()
  readonly #drops: ReplayDrop[] = []
  #bytes = 0
  readonly #maxBytes: number
  readonly #ttlMs: number

  constructor(options: { maxBytes?: number; ttlMs?: number } = {}) {
    this.#maxBytes = options.maxBytes ?? REPLAY_BUFFER_BYTES
    this.#ttlMs = options.ttlMs ?? REPLAY_TTL_MS
  }

  /** Bytes currently held across all bridges. */
  get bytes(): number {
    return this.#bytes
  }

  /** Number of batches currently held. */
  get size(): number {
    return this.#batches.size
  }

  /** Record one sent logical message; frames must be non-empty and share metadata. */
  track(frames: RelayFrame[], now = Date.now()): void {
    const first = frames[0]
    if (first === undefined) throw new Error('cannot track an empty frame batch')
    const meta: FrameMeta = {
      bridgeSessionId: first.bridgeSessionId,
      bridgeGeneration: first.bridgeGeneration,
      seq: first.seq,
      messageSeq: first.messageSeq,
      ...(first.recoveryId === undefined ? {} : { recoveryId: first.recoveryId }),
    }
    const bytes = frames.reduce((sum, frame) => sum + JSON.stringify(frame).length, 0)
    this.#batches.set(batchKey(meta), { meta, frames: [...frames], bytes, firstSentAt: now })
    this.#bytes += bytes
    this.#prune(now)
  }

  /** Release batches up to and including `messageSeq` for one bridge. */
  ack(bridgeSessionId: string, bridgeGeneration: number, messageSeq: number): ReplayDrop[] {
    const acknowledged: ReplayDrop[] = []
    for (const [key, batch] of this.#batches) {
      if (
        batch.meta.bridgeSessionId === bridgeSessionId &&
        batch.meta.bridgeGeneration === bridgeGeneration &&
        batch.meta.messageSeq <= messageSeq
      ) {
        acknowledged.push({ batch, reason: 'acknowledged' })
        this.#delete(key)
      }
    }
    this.#drops.push(...acknowledged)
    return acknowledged
  }

  /** Unacknowledged batches for one bridge, oldest first. */
  pending(bridgeSessionId?: string, bridgeGeneration?: number): ReplayBatch[] {
    const result: ReplayBatch[] = []
    for (const batch of this.#batches.values()) {
      if (bridgeSessionId !== undefined && batch.meta.bridgeSessionId !== bridgeSessionId) continue
      if (bridgeGeneration !== undefined && batch.meta.bridgeGeneration !== bridgeGeneration) continue
      result.push(batch)
    }
    return result.sort((left, right) => left.meta.messageSeq - right.meta.messageSeq)
  }

  /** Frames to resend on a new socket, pruning expired batches first. */
  replay(now = Date.now()): RelayFrame[] {
    this.#prune(now)
    return this.pending().flatMap((batch) => batch.frames)
  }

  /** Drop every batch for a bridge, e.g. when it enters a terminal state. */
  disposeBridge(bridgeSessionId: string): ReplayDrop[] {
    const disposed: ReplayDrop[] = []
    for (const [key, batch] of this.#batches) {
      if (batch.meta.bridgeSessionId === bridgeSessionId) {
        disposed.push({ batch, reason: 'disposed' })
        this.#delete(key)
      }
    }
    this.#drops.push(...disposed)
    return disposed
  }

  /** Remove and return drops accumulated since the last drain. */
  drainDrops(): ReplayDrop[] {
    return this.#drops.splice(0, this.#drops.length)
  }

  #prune(now: number): void {
    for (const [key, batch] of this.#batches) {
      if (now - batch.firstSentAt >= this.#ttlMs) {
        this.#drops.push({ batch, reason: 'expired' })
        this.#delete(key)
      }
    }
    while (this.#bytes > this.#maxBytes) {
      let oldest: ReplayBatch | undefined
      let oldestKey: string | undefined
      for (const [key, batch] of this.#batches) {
        if (oldest === undefined || batch.firstSentAt < oldest.firstSentAt) {
          oldest = batch
          oldestKey = key
        }
      }
      if (oldest === undefined || oldestKey === undefined) break
      this.#drops.push({ batch: oldest, reason: 'overflow' })
      this.#delete(oldestKey)
    }
  }

  #delete(key: string): void {
    const batch = this.#batches.get(key)
    if (batch === undefined) return
    this.#bytes -= batch.bytes
    this.#batches.delete(key)
  }
}

function batchKey(meta: FrameMeta): string {
  return `${meta.bridgeSessionId}\u0000${meta.bridgeGeneration}\u0000${meta.messageSeq}`
}
