import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isTrustedConsoleRequest, registerRelayConsole } from '../src/console.ts'
import type { RelayConsoleOptions, RelayConsoleServer } from '../src/console.ts'

interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** A webServer double that captures the registered route. */
function captureServer(): { server: RelayConsoleServer; route: () => CapturedRoute } {
  const captured: { route: CapturedRoute | undefined } = { route: undefined }
  const server: RelayConsoleServer = {
    register(route) {
      captured.route = route
    },
  }
  return {
    server,
    route: () => {
      if (captured.route === undefined) throw new Error('console route was not registered')
      return captured.route
    },
  }
}

/** Serve the captured console handler on a real loopback HTTP server. */
async function serveHandler(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const httpServer: Server = createServer((req, res) => {
    void handler(req, res)
  })
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve)
  })
  const address = httpServer.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => httpServer.close((error) => (error === undefined || error === null ? resolve() : reject(error)))),
  }
}

function fakeService(overrides: Partial<RelayConsoleOptions['service']> = {}): RelayConsoleOptions['service'] {
  return {
    consoleInfo: () => ({
      configured: true,
      state: 'online',
      hostName: 'my-mac',
      relayHttpUrl: 'https://relay.example',
      hostId: 'host-1',
      registrationTokenSet: true,
    }),
    configureRelay: async () => ({ hostId: 'host-1', hostName: 'my-mac', pairingUrlBase: 'https://relay.example' }),
    createPairing: async () => ({ pairToken: 'pair-1', pairingCode: '12345678', expiresAt: 1 }),
    listDevices: async () => [],
    revokeDevice: async () => undefined,
    ...overrides,
  }
}

let stop: (() => Promise<void>) | undefined

afterEach(async () => {
  await stop?.()
  stop = undefined
  vi.restoreAllMocks()
})

describe('relay console routes', () => {
  it('serves the status snapshot', async () => {
    const captured = captureServer()
    const service = fakeService()
    registerRelayConsole(captured.server, { service })
    const started = await serveHandler(captured.route().handler)
    stop = started.close

    const response = await fetch(`${started.url}/api/web-remote/status`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      configured: true,
      state: 'online',
      hostName: 'my-mac',
      hostId: 'host-1',
      registrationTokenSet: true,
    })
  })

  it('sets up the relay and maps relay rejection to 502', async () => {
    const captured = captureServer()
    const configureRelay = vi.fn().mockResolvedValue({ hostId: 'host-9', hostName: 'mac', pairingUrlBase: 'https://r.example' })
    const service = fakeService({ configureRelay })
    registerRelayConsole(captured.server, { service })
    const started = await serveHandler(captured.route().handler)
    stop = started.close

    const ok = await fetch(`${started.url}/api/web-remote/relay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ relayHttpUrl: 'https://r.example' }),
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ hostId: 'host-9' })
    expect(configureRelay).toHaveBeenCalledWith({ relayHttpUrl: 'https://r.example' })

    const rejected = fakeService({
      configureRelay: async () => {
        throw new Error('relay request failed with status 401 (AUTH_FAILED)')
      },
    })
    const captured2 = captureServer()
    registerRelayConsole(captured2.server, { service: rejected })
    const started2 = await serveHandler(captured2.route().handler)
    await stop?.()
    stop = started2.close
    const failed = await fetch(`${started2.url}/api/web-remote/relay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ relayHttpUrl: 'https://r.example' }),
    })
    expect(failed.status).toBe(502)
    expect(await failed.json()).toMatchObject({ error: { code: 'RELAY_SETUP_FAILED' } })
  })

  it('rejects malformed setup bodies with 400', async () => {
    const captured = captureServer()
    registerRelayConsole(captured.server, { service: fakeService() })
    const started = await serveHandler(captured.route().handler)
    stop = started.close

    for (const body of ['', '{}', '{"relayHttpUrl":""}', '{"relayHttpUrl":7}', 'not-json']) {
      const response = await fetch(`${started.url}/api/web-remote/relay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      expect(response.status).toBe(400)
    }
  })

  it('exposes pairing, devices, and revoke; unknown paths 404', async () => {
    const captured = captureServer()
    const revokeDevice = vi.fn().mockResolvedValue(undefined)
    registerRelayConsole(captured.server, { service: fakeService({ revokeDevice }) })
    const started = await serveHandler(captured.route().handler)
    stop = started.close

    const pairing = await fetch(`${started.url}/api/web-remote/pairing`, { method: 'POST' })
    expect(pairing.status).toBe(200)
    expect(await pairing.json()).toMatchObject({ pairToken: 'pair-1', pairingCode: '12345678' })

    const devices = await fetch(`${started.url}/api/web-remote/devices`)
    expect(devices.status).toBe(200)
    expect(await devices.json()).toEqual({ devices: [] })

    const revoke = await fetch(`${started.url}/api/web-remote/devices/device-1/revoke`, { method: 'POST' })
    expect(revoke.status).toBe(200)
    expect(revokeDevice).toHaveBeenCalledWith('device-1')

    const unknown = await fetch(`${started.url}/api/web-remote/unknown`)
    expect(unknown.status).toBe(404)
  })
})

describe('console route lifecycle', () => {
  it('returns the webserver disposer for the plugin to bind to its effect', () => {
    const removed: string[] = []
    const server: RelayConsoleServer = {
      register: (route) => {
        removed.push(route.path)
        return () => removed.push(`remove:${route.path}`)
      },
    }
    const dispose = registerRelayConsole(server, { service: fakeService() })
    expect(removed).toEqual(['/api/web-remote'])
    dispose()
    expect(removed).toEqual(['/api/web-remote', 'remove:/api/web-remote'])
  })

  it('tolerates a duplicate registration from a second live instance', () => {
    const server: RelayConsoleServer = {
      register: () => {
        throw new Error('webserver: duplicate prefix route "/api/web-remote"')
      },
    }
    const warnings: string[] = []
    const dispose = registerRelayConsole(server, {
      service: fakeService(),
      logger: { warn: (message: string) => warnings.push(message) },
    })
    expect(warnings.some((message) => message.includes('already registered'))).toBe(true)
    expect(() => dispose()).not.toThrow()
  })

  it('rethrows non-duplicate registration failures', () => {
    const server: RelayConsoleServer = {
      register: () => {
        throw new Error('unexpected failure')
      },
    }
    expect(() => registerRelayConsole(server, { service: fakeService() })).toThrow('unexpected failure')
  })
})

describe('console local relay route', () => {
  it('starts the built-in relay and returns its LAN URL', async () => {
    const captured = captureServer()
    const start = vi.fn().mockResolvedValue({ lanUrl: 'http://192.168.1.5:8787', port: 8787 })
    registerRelayConsole(captured.server, {
      service: fakeService(),
      localRelay: { start, enabled: true },
    })
    const started = await serveHandler(captured.route().handler)
    stop = started.close

    const response = await fetch(`${started.url}/api/web-remote/local`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 9000 }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      localRelay: { lanUrl: 'http://192.168.1.5:8787', port: 8787 },
    })
    expect(start).toHaveBeenCalledWith(9000)
  })

  it('rejects a disabled relay and an invalid port', async () => {
    const captured = captureServer()
    registerRelayConsole(captured.server, { service: fakeService() })
    const started = await serveHandler(captured.route().handler)
    stop = started.close

    const disabled = await fetch(`${started.url}/api/web-remote/local`, { method: 'POST' })
    expect(disabled.status).toBe(409)
    expect(await disabled.json()).toMatchObject({ error: { code: 'NOT_SUPPORTED' } })

    const enabledCaptured = captureServer()
    registerRelayConsole(enabledCaptured.server, {
      service: fakeService(),
      localRelay: { start: vi.fn().mockResolvedValue({ lanUrl: 'http://x:1', port: 1 }), enabled: true },
    })
    const enabledStarted = await serveHandler(enabledCaptured.route().handler)
    await stop?.()
    stop = enabledStarted.close
    const badPort = await fetch(`${enabledStarted.url}/api/web-remote/local`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 70000 }),
    })
    expect(badPort.status).toBe(400)
  })
})

describe('console trust fence', () => {
  function fakeRequest(address: string, headers: Record<string, string>): IncomingMessage {
    return { socket: { remoteAddress: address }, headers } as unknown as IncomingMessage
  }

  it('trusts loopback sockets regardless of headers', () => {
    expect(isTrustedConsoleRequest(fakeRequest('127.0.0.1', {}))).toBe(true)
    expect(isTrustedConsoleRequest(fakeRequest('::1', {}))).toBe(true)
    expect(isTrustedConsoleRequest(fakeRequest('::ffff:127.0.0.1', {}))).toBe(true)
  })

  it('trusts same-origin browser requests and nothing else remote', () => {
    const sameOrigin = fakeRequest('192.168.1.9', {
      host: 'dsh.example',
      origin: 'https://dsh.example',
    })
    expect(isTrustedConsoleRequest(sameOrigin)).toBe(true)

    expect(isTrustedConsoleRequest(fakeRequest('192.168.1.9', { host: 'dsh.example' }))).toBe(false)
    expect(
      isTrustedConsoleRequest(
        fakeRequest('192.168.1.9', { host: 'dsh.example', origin: 'https://evil.example' }),
      ),
    ).toBe(false)
    expect(isTrustedConsoleRequest(fakeRequest('192.168.1.9', { origin: 'https://evil.example' }))).toBe(
      false,
    )
  })
})
