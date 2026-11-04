import { FLOW_HIGH_WATER_BYTES, FLOW_LOW_WATER_BYTES } from './constants.ts'

/**
 * Byte-based backpressure with hysteresis.
 *
 * `paused` turns on at the high watermark and stays on until in-flight bytes
 * fall to the low watermark, so a sender near the limit does not oscillate.
 */
export class FlowController {
  readonly #highWaterBytes: number
  readonly #lowWaterBytes: number
  #inflightBytes = 0
  #paused = false

  constructor(options: { highWaterBytes?: number; lowWaterBytes?: number } = {}) {
    this.#highWaterBytes = options.highWaterBytes ?? FLOW_HIGH_WATER_BYTES
    this.#lowWaterBytes = options.lowWaterBytes ?? FLOW_LOW_WATER_BYTES
    if (this.#lowWaterBytes > this.#highWaterBytes) {
      throw new Error('low watermark must not exceed high watermark')
    }
  }

  /** Unacknowledged bytes counted against the window. */
  get inflightBytes(): number {
    return this.#inflightBytes
  }

  /** Whether the caller should hold new messages. */
  get paused(): boolean {
    return this.#paused
  }

  /** Account for bytes just sent. */
  add(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('bytes must be a non-negative integer')
    this.#inflightBytes += bytes
    if (this.#inflightBytes >= this.#highWaterBytes) this.#paused = true
  }

  /** Account for acknowledged bytes. */
  settle(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('bytes must be a non-negative integer')
    this.#inflightBytes = Math.max(0, this.#inflightBytes - bytes)
    if (this.#inflightBytes <= this.#lowWaterBytes) this.#paused = false
  }

  /** Reset after a socket replacement. */
  reset(): void {
    this.#inflightBytes = 0
    this.#paused = false
  }
}
