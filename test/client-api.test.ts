import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createConsolePairing,
  describeApiError,
  fetchConsoleDevices,
  fetchConsoleStatus,
  revokeConsoleDevice,
  setupRelay,
  startLocalRelay,
} from '../src/client/api.ts'
import { ConsoleApiError } from '../src/client/api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubJson(reply: { status: number; body: unknown } | { error: Error }): void {
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if ('error' in reply) throw reply.error
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  vi.stubGlobal('fetch', fetchStub)
}

describe('console api client', () => {
  it('reads and validates the status snapshot', async () => {
    stubJson({
      status: 200,
      body: {
        configured: true,
        state: 'online',
        hostName: 'my-mac',
        relayHttpUrl: 'https://relay.example',
        hostId: 'host-1',
        registrationTokenSet: true,
      },
    })
    expect(await fetchConsoleStatus()).toMatchObject({
      configured: true,
      state: 'online',
      hostName: 'my-mac',
      relayHttpUrl: 'https://relay.example',
      registrationTokenSet: true,
    })
  })

  it('rejects a malformed status instead of trusting it', async () => {
    stubJson({ status: 200, body: { configured: 'yes' } })
    await expect(fetchConsoleStatus()).rejects.toMatchObject({ code: 'response' })
  })

  it('posts the relay setup with a registration token only when given', async () => {
    let capturedBody: unknown
    const fetchStub = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ hostId: 'host-1' }), { status: 200 })
    }
    vi.stubGlobal('fetch', fetchStub)

    await setupRelay({ relayHttpUrl: 'https://relay.example', registrationToken: 'reg' })
    expect(capturedBody).toEqual({ relayHttpUrl: 'https://relay.example', registrationToken: 'reg' })

    await setupRelay({ relayHttpUrl: 'https://relay.example' })
    expect(capturedBody).toEqual({ relayHttpUrl: 'https://relay.example' })
  })

  it('surfaces the relay rejection message from the error body', async () => {
    stubJson({
      status: 502,
      body: { error: { code: 'RELAY_SETUP_FAILED', message: 'relay setup failed: bad token' } },
    })
    const error = await setupRelay({ relayHttpUrl: 'https://relay.example' }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ConsoleApiError)
    expect((error as ConsoleApiError).message).toBe('relay setup failed: bad token')
  })

  it('maps a refused connection to a readable network error', async () => {
    stubJson({ error: new TypeError('fetch failed') })
    const error = await fetchConsoleStatus().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ConsoleApiError)
    expect((error as ConsoleApiError).message).toContain('无法访问本机服务')
  })

  it('parses pairing offers and device lists', async () => {
    stubJson({
      status: 200,
      body: { pairToken: 'pair-1', pairingCode: '12345678', expiresAt: 1_000, url: 'https://relay.example/?pair=pair-1' },
    })
    expect(await createConsolePairing()).toMatchObject({
      pairingCode: '12345678',
      url: 'https://relay.example/?pair=pair-1',
    })

    stubJson({
      status: 200,
      body: {
        devices: [
          {
            deviceId: 'device-1',
            name: 'phone',
            platform: 'mobile',
            createdAt: 1,
            lastSeenAt: 2,
            online: true,
          },
        ],
      },
    })
    expect(await fetchConsoleDevices()).toEqual([
      {
        deviceId: 'device-1',
        name: 'phone',
        platform: 'mobile',
        createdAt: 1,
        lastSeenAt: 2,
        online: true,
      },
    ])
  })

  it('encodes the device id in the revoke path', async () => {
    let capturedUrl = ''
    const fetchStub = async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = String(input)
      return new Response(JSON.stringify({ revoked: true }), { status: 200 })
    }
    vi.stubGlobal('fetch', fetchStub)
    await revokeConsoleDevice('device/1 x')
    expect(capturedUrl).toBe('/api/web-remote/devices/device%2F1%20x/revoke')
  })

  it('maps unknown errors to the fallback message', () => {
    expect(describeApiError(new Error('boom'))).toBe('发生未知错误，请重试')
    expect(describeApiError(new ConsoleApiError('network', '无法访问本机服务'))).toBe(
      '无法访问本机服务',
    )
  })
})


describe('local relay client', () => {
  it('parses localRelay in status', async () => {
    stubJson({
      status: 200,
      body: {
        configured: true,
        state: 'online',
        hostName: 'my-mac',
        registrationTokenSet: false,
        localRelay: { lanUrl: 'http://192.168.1.5:8787', port: 8787 },
      },
    })
    const status = await fetchConsoleStatus()
    expect(status.localRelay).toEqual({ lanUrl: 'http://192.168.1.5:8787', port: 8787 })
  })

  it('posts the local relay switch and returns the LAN URL', async () => {
    let capturedBody: unknown
    const fetchStub = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ ok: true, localRelay: { lanUrl: 'http://192.168.1.5:8787', port: 8787 } }), { status: 200 })
    }
    vi.stubGlobal('fetch', fetchStub)
    const info = await startLocalRelay(8787)
    expect(capturedBody).toEqual({ port: 8787 })
    expect(info).toEqual({ lanUrl: 'http://192.168.1.5:8787', port: 8787 })
  })
})
