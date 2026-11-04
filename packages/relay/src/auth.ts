/**
 * Shared credential verification for the edge login gate.
 *
 * The relay mints short-lived bearer tokens after a constant-time check
 * against the configured password. Plain HTTP deployments (LAN, local
 * development) do not need this layer: without a password the relay reports
 * `authRequired: false` and the phone shell skips the login screen entirely.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** Login token lifetime: one week, matching the phone shell's 24h gesture window. */
export const AUTH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Name of the HttpOnly cookie carrying the web-auth token.
 *
 * The edge (Caddy `forward_auth`) reads this cookie to decide whether the
 * static shell may be served at all; the SPA never touches it, so a page-level
 * bug cannot bypass the gate.
 */
export const AUTH_COOKIE_NAME = 'dsh_auth'

/**
 * Extract the web-auth token from a `Cookie` header.
 *
 * The header is client-controlled: parsing is tolerant, the first match wins,
 * and a malformed header simply yields `undefined` (treated as anonymous).
 *
 * @param header - raw `Cookie` request header value.
 * @returns the cookie value, or `undefined` when absent/empty.
 */
export function readAuthCookie(header: string | undefined): string | undefined {
  if (header === undefined || header === '') return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    if (name !== AUTH_COOKIE_NAME) continue
    const value = part.slice(index + 1).trim()
    return value === '' ? undefined : value
  }
  return undefined
}

/**
 * Build the `Set-Cookie` value that installs the web-auth token.
 *
 * `HttpOnly` keeps the credential out of reach of any script on the page, so
 * XSS cannot steal it; `SameSite=Lax` still allows the top-level redirect from
 * the login page back to the app.
 *
 * @param token - freshly issued bearer token.
 * @param options - `maxAgeSeconds` and whether the request arrived over TLS.
 * @returns one `Set-Cookie` header value.
 */
export function buildAuthCookie(
  token: string,
  options: { maxAgeSeconds: number; secure: boolean },
): string {
  const parts = [
    `${AUTH_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(Math.max(0, Math.floor(options.maxAgeSeconds)))}`,
  ]
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * Build the `Set-Cookie` value that deletes the web-auth cookie.
 *
 * @param secure - whether the request arrived over TLS.
 * @returns one `Set-Cookie` header value expiring the cookie immediately.
 */
export function buildClearAuthCookie(secure: boolean): string {
  const parts = [`${AUTH_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}


/**
 * Issue one opaque bearer token.
 *
 * The plaintext never leaves this function; callers persist only the hash.
 *
 * @returns the token to hand to the client and its SHA-256 hex digest.
 */
export function issueAuthToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token) }
}

/**
 * Verify a submitted password against the configured hash.
 *
 * The stored form is `scrypt:<salt hex>:<hash hex>`. The comparison is
 * constant-time on both the KDF and the raw fallback form.
 *
 * @param supplied - password typed by the user.
 * @param stored - hash previously minted with {@link hashPassword}.
 */
export function verifyPassword(supplied: string, stored: string): boolean {
  if (stored.startsWith('scrypt:')) {
    const parts = stored.slice('scrypt:'.length).split(':')
    if (parts.length !== 2) return false
    const saltHex = parts[0] ?? ''
    const hashHex = parts[1] ?? ''
    if (saltHex.length === 0 || hashHex.length === 0 || hashHex.length % 2 !== 0) return false
    const expected = Buffer.from(hashHex, 'hex')
    if (expected.length === 0) return false
    const actual = scryptSync(supplied, saltHex, expected.length)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  const expected = Buffer.from(stored, 'utf8')
  const actual = Buffer.from(supplied, 'utf8')
  if (expected.length !== actual.length) return false
  return timingSafeEqual(actual, expected)
}

/**
 * Hash a plaintext password for storage.
 *
 * `RELAY_AUTH_PASSWORD` in production already carries a `scrypt:` value; this
 * helper only exists so a deployer can generate one offline or a test can
 * exercise the raw-fallback branch.
 *
 * @param plaintext - password chosen by the deployer.
 * @returns the `scrypt:<salt>:<hash>` string.
 */
export function hashPassword(plaintext: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(plaintext, salt, 32).toString('hex')
  return `scrypt:${salt}:${hash}`
}

/** SHA-256 hex digest of one bearer token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
