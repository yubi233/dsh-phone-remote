/** CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320) over bytes. */

const TABLE = new Uint32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  TABLE[index] = value >>> 0
}

/** Return the unsigned CRC-32 of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  let current = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    current = TABLE[(current ^ bytes[index]!) & 0xff]! ^ (current >>> 8)
  }
  return (current ^ 0xffffffff) >>> 0
}

/** Return the CRC-32 as eight lowercase hexadecimal digits. */
export function crc32Hex(bytes: Uint8Array): string {
  return crc32(bytes).toString(16).padStart(8, '0')
}
