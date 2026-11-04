import { afterEach, describe, expect, it } from 'vitest'
import { hashPassword, issueAuthToken, verifyPassword } from '@dsh-web-remote/relay'
import { startRelayServer } from '@dsh-web-remote/relay'
import type { RelayServer } from '@dsh-web-remote/relay'

let server: RelayServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

function login(base: string, password: string): Promise<Response> {
  return fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
}

describe('web auth', () => {
  it('mints unique tokens and their hashes', () => {
    const first = issueAuthToken()
    const second = issueAuthToken()
    expect(first.token).not.toBe(second.token)
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(first.token.length).toBeGreaterThanOrEqual(32)
  })

  it('verifies scrypt-hashed passwords and rejects mismatches', () => {
    const stored = hashPassword('correct-horse')
    expect(verifyPassword('correct-horse', stored)).toBe(true)
    expect(verifyPassword('wrong', stored)).toBe(false)
    expect(verifyPassword('correct-horse', 'not-a-valid-hash')).toBe(false)
    expect(verifyPassword('x', '')).toBe(false)
  })

  it('falls back to constant-time compare for raw stored forms', () => {
    expect(verifyPassword('raw-secret', 'raw-secret')).toBe(true)
    expect(verifyPassword('raw-secret', 'other')).toBe(false)
  })

  it('gates the shell only when a password is configured', async () => {
    server = await startRelayServer({ port: 0 })
    const response = await fetch(`${server.httpUrl}/v1/auth/status`)
    expect(await response.json()).toEqual({ authRequired: false })
  })

  it('issues a session cookie plus a bearer token', async () => {
    server = await startRelayServer({ port: 0, authPassword: hashPassword('pw-1') })
    expect((await login(server.httpUrl, 'wrong')).status).toBe(401)

    const ok = await login(server.httpUrl, 'pw-1')
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { token: string; expiresAt: number }
    expect(body.token.length).toBeGreaterThanOrEqual(32)
    expect(body.expiresAt).toBeGreaterThan(Date.now())

    // The edge reads this cookie via forward_auth, so it must be HttpOnly.
    const cookie = ok.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('dsh_auth=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    // Plain HTTP test transport: no Secure flag, or the client would drop it.
    expect(cookie).not.toContain('Secure')

    const verifyBearer = await fetch(`${server.httpUrl}/v1/auth/verify`, {
      headers: { authorization: `Bearer ${body.token}` },
    })
    expect(verifyBearer.status).toBe(204)

    const verifyCookie = await fetch(`${server.httpUrl}/v1/auth/verify`, {
      headers: { cookie: `dsh_auth=${body.token}` },
    })
    expect(verifyCookie.status).toBe(204)

    const verifyAnonymous = await fetch(`${server.httpUrl}/v1/auth/verify`)
    expect(verifyAnonymous.status).toBe(401)
  })

  it('marks the cookie Secure behind an https proxy', async () => {
    server = await startRelayServer({ port: 0, authPassword: hashPassword('pw-1'), trustProxy: true })
    const response = await fetch(`${server.httpUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ password: 'pw-1' }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie') ?? '').toContain('Secure')
  })

  it('revokes the token on logout and clears the cookie', async () => {
    server = await startRelayServer({ port: 0, authPassword: hashPassword('pw-1') })
    const ok = await login(server.httpUrl, 'pw-1')
    const body = (await ok.json()) as { token: string }

    const logout = await fetch(`${server.httpUrl}/v1/auth/logout`, {
      method: 'POST',
      headers: { cookie: `dsh_auth=${body.token}` },
    })
    expect(logout.status).toBe(200)
    expect(logout.headers.get('set-cookie') ?? '').toContain('Max-Age=0')

    const after = await fetch(`${server.httpUrl}/v1/auth/verify`, {
      headers: { cookie: `dsh_auth=${body.token}` },
    })
    expect(after.status).toBe(401)
  })

  it('rejects a forged or malformed cookie', async () => {
    server = await startRelayServer({ port: 0, authPassword: hashPassword('pw-1') })
    for (const cookie of ['dsh_auth=forged', 'dsh_auth=', 'other=x', 'garbage']) {
      const response = await fetch(`${server.httpUrl}/v1/auth/verify`, { headers: { cookie } })
      expect(response.status).toBe(401)
    }
  })

  it('rejects login attempts without a configured password', async () => {
    server = await startRelayServer({ port: 0 })
    expect((await login(server.httpUrl, 'anything')).status).toBe(401)
  })
})
