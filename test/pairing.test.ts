import { describe, expect, it } from 'vitest'
import { PairingClient } from 'dsh-phone-remote'
import type { PairingConfig } from 'dsh-phone-remote'
import { PROTOCOL_VERSION } from '@dsh-web-remote/protocol'

interface RecordedRequest {
  url: string
  method: string
  authorization: string | undefined
  contentType: string | undefined
  body: unknown
}

type StubHandler = (request: RecordedRequest, index: number) => Response

interface FetchStub {
  fetchImpl: typeof fetch
  requests: RecordedRequest[]
}

function stubFetch(handler: StubHandler): FetchStub {
  const requests: RecordedRequest[] = []
  const fetchImpl: typeof fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers)
    let body: unknown
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization') ?? undefined,
      contentType: headers.get('content-type') ?? undefined,
      body,
    }
    requests.push(request)
    return handler(request, requests.length - 1)
  }
  return { fetchImpl, requests }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const baseConfig: PairingConfig = {
  relayHttpUrl: 'https://relay.test/',
  hostId: 'host-1',
  hostSecret: 'secret-1',
  hostName: 'Office Mac',
  pairingUrlBase: 'https://pair.example/pair',
  protocolVersion: PROTOCOL_VERSION,
}

describe('PairingClient', () => {
  it('registers once, caches a live token, and registers again after expiry', async () => {
    const { fetchImpl, requests } = stubFetch((_request, index) =>
      jsonResponse({ hostToken: `token-${index + 1}`, expiresAt: 10_000 }),
    )
    const client = new PairingClient({ ...baseConfig, fetchImpl })

    expect(await client.register(1_000)).toEqual({ hostToken: 'token-1', expiresAt: 10_000 })
    expect(await client.register(9_999)).toEqual({ hostToken: 'token-1', expiresAt: 10_000 })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'https://relay.test/v1/hosts/register',
      method: 'POST',
      contentType: 'application/json',
      authorization: undefined,
    })
    expect(requests[0]?.body).toEqual({
      hostId: 'host-1',
      hostSecret: 'secret-1',
      hostName: 'Office Mac',
      protocolVersion: PROTOCOL_VERSION,
    })

    expect(await client.register(10_000)).toEqual({ hostToken: 'token-2', expiresAt: 10_000 })
    expect(requests).toHaveLength(2)
  })

  it('builds the pairing URL with an encoded host name and bearer token', async () => {
    const { fetchImpl, requests } = stubFetch((request) => {
      if (request.url.endsWith('/v1/hosts/register')) {
        return jsonResponse({ hostToken: 'host-token', expiresAt: 9_999_999_999_999 })
      }
      return jsonResponse({ pairToken: 'pair-1', pairingCode: '123456', expiresAt: 9_000 })
    })
    const client = new PairingClient({
      ...baseConfig,
      hostName: 'My Mac / 手机',
      pairingUrlBase: 'https://pair.example/pair',
      fetchImpl,
    })

    const offer = await client.createPairing()
    expect(requests[1]).toMatchObject({
      url: 'https://relay.test/v1/hosts/host-1/pairing',
      method: 'POST',
      authorization: 'Bearer host-token',
    })
    expect(offer).toEqual({
      pairToken: 'pair-1',
      pairingCode: '123456',
      expiresAt: 9_000,
      url: 'https://pair.example/pair?host=host-1&pair=pair-1&name=My%20Mac%20%2F%20%E6%89%8B%E6%9C%BA&v=1',
    })
  })

  it('omits the pairing URL when no base URL is configured', async () => {
    const { fetchImpl } = stubFetch((request) => {
      if (request.url.endsWith('/v1/hosts/register')) {
        return jsonResponse({ hostToken: 'host-token', expiresAt: 9_999_999_999_999 })
      }
      return jsonResponse({ pairToken: 'pair-1', pairingCode: '123456', expiresAt: 9_000 })
    })
    const client = new PairingClient({ ...baseConfig, pairingUrlBase: undefined, fetchImpl })

    const offer = await client.createPairing()
    expect(offer.url).toBeUndefined()
  })

  it('re-registers and retries once after a 401', async () => {
    const responses: Response[] = [
      jsonResponse({ hostToken: 'token-a', expiresAt: 9_999_999_999_999 }),
      jsonResponse({ code: 'AUTH_FAILED' }, 401),
      jsonResponse({ hostToken: 'token-b', expiresAt: 9_999_999_999_999 }),
      jsonResponse({ pairToken: 'pair-b', pairingCode: '654321', expiresAt: 8_000 }),
    ]
    const { fetchImpl, requests } = stubFetch(
      (_request, index) => responses[index] ?? jsonResponse({ code: 'UNEXPECTED' }, 500),
    )
    const client = new PairingClient({ ...baseConfig, fetchImpl })

    const offer = await client.createPairing()
    expect(offer.pairToken).toBe('pair-b')
    expect(requests.map((request) => request.url)).toEqual([
      'https://relay.test/v1/hosts/register',
      'https://relay.test/v1/hosts/host-1/pairing',
      'https://relay.test/v1/hosts/register',
      'https://relay.test/v1/hosts/host-1/pairing',
    ])
    expect(requests[1]?.authorization).toBe('Bearer token-a')
    expect(requests[3]?.authorization).toBe('Bearer token-b')
  })

  it('lists and validates device records', async () => {
    const { fetchImpl, requests } = stubFetch((request) => {
      if (request.url.endsWith('/v1/hosts/register')) {
        return jsonResponse({ hostToken: 'host-token', expiresAt: 9_999_999_999_999 })
      }
      return jsonResponse({
        devices: [
          {
            deviceId: 'device-1',
            name: 'Phone',
            platform: 'ios',
            createdAt: 1,
            lastSeenAt: 2,
            online: true,
          },
          { deviceId: 'device-2', createdAt: 3, lastSeenAt: 4, online: false },
        ],
      })
    })
    const client = new PairingClient({ ...baseConfig, fetchImpl })

    const devices = await client.listDevices()
    expect(requests[1]).toMatchObject({
      url: 'https://relay.test/v1/hosts/host-1/devices',
      method: 'GET',
      authorization: 'Bearer host-token',
    })
    expect(devices).toEqual([
      {
        deviceId: 'device-1',
        name: 'Phone',
        platform: 'ios',
        createdAt: 1,
        lastSeenAt: 2,
        online: true,
      },
      { deviceId: 'device-2', createdAt: 3, lastSeenAt: 4, online: false },
    ])
  })

  it('rejects device records with invalid fields', async () => {
    const { fetchImpl } = stubFetch((request) => {
      if (request.url.endsWith('/v1/hosts/register')) {
        return jsonResponse({ hostToken: 'host-token', expiresAt: 9_999_999_999_999 })
      }
      return jsonResponse({ devices: [{ deviceId: 'device-1', createdAt: 1, lastSeenAt: 2 }] })
    })
    const client = new PairingClient({ ...baseConfig, fetchImpl })

    await expect(client.listDevices()).rejects.toThrow(/invalid response \(200\).*online/)
  })

  it('revokes a device with an encoded device id', async () => {
    const { fetchImpl, requests } = stubFetch((request) => {
      if (request.url.endsWith('/v1/hosts/register')) {
        return jsonResponse({ hostToken: 'host-token', expiresAt: 9_999_999_999_999 })
      }
      return jsonResponse({ revoked: true })
    })
    const client = new PairingClient({ ...baseConfig, fetchImpl })

    await expect(client.revokeDevice('device/1')).resolves.toBeUndefined()
    expect(requests[1]).toMatchObject({
      url: 'https://relay.test/v1/hosts/host-1/devices/device%2F1/revoke',
      method: 'POST',
      authorization: 'Bearer host-token',
    })
  })

  it('reports HTTP status and relay error code for failed requests', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ code: 'AUTH_FAILED' }, 403))
    const client = new PairingClient({ ...baseConfig, fetchImpl })

    await expect(client.register(0)).rejects.toThrow(/403.*AUTH_FAILED/)
  })

  it('reports nested relay error codes', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ error: { code: 'INTERNAL' } }, 500))
    const client = new PairingClient({ ...baseConfig, fetchImpl })

    await expect(client.register(0)).rejects.toThrow(/500.*INTERNAL/)
  })

  it('rejects non-JSON relay responses', async () => {
    const { fetchImpl } = stubFetch(() => new Response('not json', { status: 200 }))
    const client = new PairingClient({ ...baseConfig, fetchImpl })

    await expect(client.register(0)).rejects.toThrow(/invalid JSON \(200\)/)
  })
})

describe('PairingClient hardening', () => {
  it('encodes the hostId in the pairing URL query', async () => {
    const { fetchImpl } = stubFetch((request) =>
      request.url.endsWith('/register')
        ? jsonResponse({ hostToken: 'host-token-1', expiresAt: 10_000 })
        : jsonResponse({ pairToken: 'pair-1', pairingCode: '12345678', expiresAt: 5_000 }),
    )
    const client = new PairingClient({
      ...baseConfig,
      hostId: 'host/a&b=c',
      fetchImpl,
    })
    const offer = await client.createPairing()
    expect(offer.url).toBe(
      'https://pair.example/pair?host=host%2Fa%26b%3Dc&pair=pair-1&name=Office%20Mac&v=1',
    )
  })

  it('bounds every relay HTTP exchange with a timeout signal', async () => {
    const signals: unknown[] = []
    const fetchImpl: typeof fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal)
      return jsonResponse({ hostToken: 'token-1', expiresAt: 10_000 })
    }
    const client = new PairingClient({ ...baseConfig, fetchImpl })
    await client.register(0)
    expect(signals).toHaveLength(1)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
  })
})

describe('PairingClient registration token', () => {
  it('sends x-registration-token on register when configured', async () => {
    const { fetchImpl, requests } = stubFetch((_request, index) =>
      jsonResponse({ hostToken: `token-${index + 1}`, expiresAt: 10_000 }),
    )
    const client = new PairingClient({ ...baseConfig, fetchImpl, registrationToken: 'pub-token' })
    await client.register(0)
    expect(requests[0]?.url).toBe('https://relay.test/v1/hosts/register')

    const headers = new Headers()
    void headers
    const raw = requests[0]
    expect(raw).toBeDefined()
    // The stub records only a few headers; re-derive via a second capture.
    const captured: Record<string, string> = {}
    const probe: typeof fetch = async (_input, init) => {
      const h = new Headers(init?.headers)
      captured['x-registration-token'] = h.get('x-registration-token') ?? ''
      return jsonResponse({ hostToken: 'token-x', expiresAt: 10_000 })
    }
    const client2 = new PairingClient({ ...baseConfig, fetchImpl: probe, registrationToken: 'pub-token' })
    await client2.register(0)
    expect(captured['x-registration-token']).toBe('pub-token')
    void raw
  })

  it('omits the header when no token is configured', async () => {
    const captured: Record<string, string | undefined> = {}
    const probe: typeof fetch = async (_input, init) => {
      const h = new Headers(init?.headers)
      captured['x-registration-token'] = h.get('x-registration-token') ?? undefined
      return jsonResponse({ hostToken: 'token-x', expiresAt: 10_000 })
    }
    const client = new PairingClient({ ...baseConfig, fetchImpl: probe })
    await client.register(0)
    expect(captured['x-registration-token']).toBeUndefined()
  })
})
