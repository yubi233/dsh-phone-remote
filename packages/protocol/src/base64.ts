/**
 * Canonical base64 helpers usable from Node and from a browser bundle.
 *
 * The wire format accepts only the canonical encoding (standard alphabet,
 * required padding, no whitespace) so two encoders cannot disagree about the
 * checksum input bytes.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const CANONICAL = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

interface NodeBufferLike {
  from(input: Uint8Array | string, encoding?: string): { toString(encoding: string): string }
}

const buffer = (globalThis as { Buffer?: NodeBufferLike }).Buffer

/** Encode bytes as canonical base64 without line breaks. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (buffer !== undefined) {
    return buffer.from(bytes, 'base64').toString('base64')
  }
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = index + 1 < bytes.length ? bytes[index + 1]! : undefined
    const third = index + 2 < bytes.length ? bytes[index + 2]! : undefined
    output += ALPHABET[first >> 2]
    output += ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)]
    output += second === undefined ? '=' : ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)]
    output += third === undefined ? '=' : ALPHABET[third & 0x3f]
  }
  return output
}

/** Decode canonical base64; throws on any non-canonical input. */
export function base64ToBytes(text: string): Uint8Array {
  if (!isCanonicalBase64(text)) {
    throw new Error('invalid canonical base64')
  }
  if (buffer !== undefined) {
    return new Uint8Array(buffer.from(text, 'base64') as unknown as ArrayBuffer)
  }
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const output = new Uint8Array((text.length / 4) * 3 - padding)
  let writeIndex = 0
  for (let index = 0; index < text.length; index += 4) {
    const a = ALPHABET.indexOf(text[index]!)
    const b = ALPHABET.indexOf(text[index + 1]!)
    const c = text[index + 2] === '=' ? 0 : ALPHABET.indexOf(text[index + 2]!)
    const d = text[index + 3] === '=' ? 0 : ALPHABET.indexOf(text[index + 3]!)
    if (writeIndex < output.length) output[writeIndex++] = (a << 2) | (b >> 4)
    if (writeIndex < output.length) output[writeIndex++] = ((b & 0x0f) << 4) | (c >> 2)
    if (writeIndex < output.length) output[writeIndex++] = ((c & 0x03) << 6) | d
  }
  return output
}

/** Whether `text` is the canonical base64 encoding of some byte sequence. */
export function isCanonicalBase64(text: string): boolean {
  if (text.length % 4 !== 0 || !CANONICAL.test(text)) return false
  if (buffer !== undefined) {
    const bytes = new Uint8Array(buffer.from(text, 'base64') as unknown as ArrayBuffer)
    return buffer.from(bytes, 'base64').toString('base64') === text
  }
  return true
}
