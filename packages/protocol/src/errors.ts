/** Machine-readable failure codes for wire-level protocol violations. */
export type ProtocolErrorCode =
  | 'invalid-message'
  | 'unknown-message'
  | 'invalid-frame'
  | 'invalid-base64'
  | 'invalid-json'
  | 'message-too-large'
  | 'too-many-fragments'
  | 'fragment-count-mismatch'
  | 'fragment-index-out-of-range'
  | 'fragment-conflict'
  | 'metadata-mismatch'
  | 'checksum-mismatch'
  | 'byte-length-mismatch'
  | 'assembly-timeout'
  | 'assembly-evicted'
  | 'frame-too-large'
  | 'replay-overflow'
  | 'flow-overflow'

/**
 * A protocol violation detected at a trust boundary.
 *
 * Thrown only for values the sender controls (wire bytes, JSON payloads).
 * Local programming errors surface as ordinary exceptions.
 */
export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message?: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message ?? code)
    this.name = 'ProtocolError'
  }
}

/** Return a finite non-negative integer, or throw `invalid-message`. */
export function requireInteger(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new ProtocolError('invalid-message', `${name} must be an integer >= ${minimum}`)
  }
  return value
}

/** Return a non-empty string, or throw `invalid-message`. */
export function requireString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new ProtocolError('invalid-message', `${name} must be a${allowEmpty ? '' : ' non-empty'} string`)
  }
  return value
}

/** Return a plain object record, or throw `invalid-message`. */
export function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolError('invalid-message', `${name} must be an object`)
  }
  return value as Record<string, unknown>
}
