import { afterEach, describe, expect, it } from 'vitest'
import { startRelayServer } from '@dsh-web-remote/relay'
import type { RelayServer } from '@dsh-web-remote/relay'

let server: RelayServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('relay rate limiting', () => {
  it('returns 429 after the per-IP budget is spent', async () => {
    server = await startRelayServer({ port: 0, rateLimit: { windowMs: 60_000, maxPerWindow: 2 } })
    const claim = (): Promise<Response> =>
      fetch(`${server!.httpUrl}/v1/pair/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostId: 'missing', pairToken: 'missing' }),
      })

    expect((await claim()).status).toBe(400)
    expect((await claim()).status).toBe(400)
    const limited = await claim()
    expect(limited.status).toBe(429)
    await expect(limited.json()).resolves.toMatchObject({ error: { code: 'RATE_LIMITED' } })
  })

  it('can be disabled for trusted deployments', async () => {
    server = await startRelayServer({ port: 0, rateLimit: false })
    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(`${server.httpUrl}/v1/pair/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostId: 'missing', pairToken: 'missing' }),
      })
      expect(response.status).toBe(400)
    }
  })
})
