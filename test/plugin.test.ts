import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/plugin.ts'
import type { DshWireStream } from '../src/dsh-bridge.ts'
import type { WebRemoteHostService, WebRemotePluginConfig, WebRemotePluginContext } from '../src/plugin.ts'
import type { WorkspaceChangesLike } from '../src/changes-endpoints.ts'

function unusedStream(): DshWireStream {
  return {
    async open() {
      return (async function* () {
        // Never opened by activation tests.
      })()
    },
    failure: () => ({ code: 'unused', message: 'unused', details: {} }),
  }
}

interface FakeContext {
  ctx: WebRemotePluginContext
  provided: Map<string, unknown>
  effects: Array<() => unknown>
}

function makeContext(options: { workspaceChanges?: 'throws' | WorkspaceChangesLike } = {}): FakeContext {
  const provided = new Map<string, unknown>()
  const effects: Array<() => unknown> = []
  const tables = new Map<string, Map<string, { readSeq: number; readAt: number }>>()
  const ctx = {
    connection: {} as WebRemotePluginContext['connection'],
    typertGateway: { wireStream: unusedStream() },
    sessions: { get: () => undefined },
    sessionQuery: {
      readSession: async () => ({ session: { createdAt: 0 }, events: [], inheritedEventCount: 0 }),
    },
    sessionProjections: {
      register: () => () => undefined,
      snapshot: () => ({ values: {} }),
    },
    storageDomain: {
      open: async (spec: { name: string }) => {
        const records = tables.get(spec.name) ?? new Map()
        tables.set(spec.name, records)
        return {
          table: () => ({
            get: (key: string) => records.get(key),
            entries: () => records.entries(),
            put: async (key: string, value: { readSeq: number; readAt: number }) => {
              records.set(key, value)
            },
            update: async (
              key: string,
              fn: (current: { readSeq: number; readAt: number }) => { readSeq: number; readAt: number },
            ) => {
              const next = fn(records.get(key) ?? { readSeq: -1, readAt: 0 })
              records.set(key, next)
              return next
            },
          }),
          close: async () => undefined,
        }
      },
    },
    effect: (callback: () => unknown) => {
      effects.push(callback)
    },
    provide: (name: string, value: unknown) => {
      provided.set(name, value)
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  } as WebRemotePluginContext
  if (options.workspaceChanges === 'throws') {
    Object.defineProperty(ctx, 'workspaceChanges', {
      get() {
        throw new Error('cannot get property "workspaceChanges" without inject')
      },
    })
  } else if (options.workspaceChanges !== undefined) {
    ctx.workspaceChanges = options.workspaceChanges
  }
  return { ctx, provided, effects }
}

const config: WebRemotePluginConfig = {
  relayHttpUrl: 'http://127.0.0.1:9',
  hostId: 'host-1',
  hostSecret: 'secret',
  hostName: 'test',
  autoStart: false,
}

describe('web-remote-host plugin activation', () => {
  it('activates when the workspaceChanges getter throws (service absent)', async () => {
    const { ctx, provided } = makeContext({ workspaceChanges: 'throws' })
    await expect(apply(ctx, config)).resolves.toBeUndefined()
    expect(provided.get('webRemoteHost')).toBeDefined()
  })

  it('activates when a workspaceChanges service is mounted', async () => {
    const changes: WorkspaceChangesLike = { summary: () => undefined, diff: async () => undefined }
    const { ctx, provided } = makeContext({ workspaceChanges: changes })
    await expect(apply(ctx, config)).resolves.toBeUndefined()
    expect(provided.get('webRemoteHost')).toBeDefined()
  })
})

describe('web-remote-host start retry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a failed start stays retryable and attempts registration again', async () => {
    let registerCalls = 0
    const failingSocket = async (): Promise<never> => {
      throw new Error('connection refused')
    }
    const { ctx, provided } = makeContext()
    await apply(ctx, {
      ...config,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        registerCalls += 1
        return new Response(
          JSON.stringify({ error: { code: 'INTERNAL', message: 'relay down' } }),
          { status: 500 },
        )
      }) as typeof fetch,
      createSocket: failingSocket,
    })
    const service = provided.get('webRemoteHost') as WebRemoteHostService

    await expect(service.start()).rejects.toThrow('relay request failed')
    expect(registerCalls).toBe(1)

    // The second start must attempt the relay again instead of being a no-op.
    await expect(service.start()).rejects.toThrow()
    expect(registerCalls).toBe(2)
    expect(service.status).toBe('offline')
  })

  it('apply retries autoStart with backoff until disposed', async () => {
    vi.useFakeTimers()
    const errors: string[] = []
    const { ctx, effects } = makeContext()
    ctx.logger = {
      info: () => undefined,
      warn: () => undefined,
      error: (message: string) => errors.push(message),
    }
    let registerCalls = 0
    await apply(ctx, {
      ...config,
      autoStart: true,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        registerCalls += 1
        return new Response(
          JSON.stringify({ error: { code: 'INTERNAL', message: 'relay down' } }),
          { status: 500 },
        )
      }) as typeof fetch,
      createSocket: async (): Promise<never> => {
        throw new Error('connection refused')
      },
    })
    // The test context records effect callbacks without running them; Cordis
    // would invoke these on activation (the first is the unread domain, the
    // second is the autoStart loop), so run every one here.
    const cleanups = effects.map((callback) => callback() as (() => void) | undefined)
    // Allow the first attempt to fail and enter the sleep.
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(registerCalls).toBeGreaterThanOrEqual(3)
    expect(errors.some((message) => message.includes('retrying'))).toBe(true)

    // Disposal must stop the retry loop.
    for (const cleanup of cleanups) cleanup?.()
    const before = registerCalls
    await vi.advanceTimersByTimeAsync(60_000)
    expect(registerCalls).toBe(before)
  })
})

describe('web-remote-host console setup', () => {
  function makeWebServerContext(): FakeContext & { webServerRoutes: { kind: string; path: string }[] } {
    const base = makeContext()
    const webServerRoutes: { kind: string; path: string }[] = []
    ;(base.ctx as { get?: (name: string) => unknown }).get = (name: string) =>
      name === 'webServer'
        ? {
            register: (route: { kind: string; path: string }) => {
              webServerRoutes.push({ kind: route.kind, path: route.path })
            },
          }
        : undefined
    return { ...base, webServerRoutes }
  }

  /** Fetch stub that answers relay registration (and nothing else). */
  function registerFetch(
    reply: { ok: true } | { ok: false; status: number },
    calls: { count: number } = { count: 0 },
  ): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      calls.count += 1
      expect(String(input)).toMatch(/\/v1\/hosts\/register$/)
      const status = reply.ok ? 200 : reply.status
      const body = reply.ok
        ? { hostToken: 'host-token-1', expiresAt: Date.now() + 60_000 }
        : { error: { code: 'AUTH_FAILED', message: 'bad registration token' } }
      return new Response(JSON.stringify(body), { status })
    }) as unknown as typeof fetch
  }

  /** A socket factory that never completes, so no real connection is attempted. */
  const pendingSocket = async (): Promise<never> => new Promise<never>(() => {})

  it('activates unconfigured without a relay URL and skips autoStart', async () => {
    const { ctx, provided, effects } = makeContext()
    await apply(ctx, { ...config, relayHttpUrl: undefined })
    const service = provided.get('webRemoteHost') as WebRemoteHostService
    expect(service.configured).toBe(false)
    expect(service.status).toBe('unconfigured')
    expect(service.consoleInfo()).toMatchObject({ configured: false, registrationTokenSet: false })
    await expect(service.createPairing()).rejects.toThrow(/not configured/)
    // Unconfigured start is a no-op, not an error; autoStart has nothing to do.
    await expect(service.start()).resolves.toBeUndefined()
    expect(effects.every((effect) => typeof effect === 'function')).toBe(true)
  })

  it('registers the console route family when a webServer is mounted', async () => {
    const { ctx, webServerRoutes } = makeWebServerContext()
    await apply(ctx, config)
    expect(webServerRoutes).toEqual([{ kind: 'prefix', path: '/api/web-remote' }])

    const { ctx: plain } = makeContext()
    await expect(apply(plain, config)).resolves.toBeUndefined()
  })

  it('configureRelay registers, replaces the connection, and persists the setup', async () => {
    const calls = { count: 0 }
    const { ctx, provided } = makeContext()
    // A fresh install: no relay URL and no identity in the patch config.
    const { hostId: _hostId, hostSecret: _hostSecret, relayHttpUrl: _relay, ...fresh } = config
    void _hostId
    void _hostSecret
    void _relay
    await apply(ctx, {
      ...fresh,
      fetchImpl: registerFetch({ ok: true }, calls),
      createSocket: pendingSocket,
    })
    const service = provided.get('webRemoteHost') as WebRemoteHostService
    expect(service.configured).toBe(false)

    const result = await service.configureRelay({
      relayHttpUrl: 'https://relay.example/',
      registrationToken: 'reg-token',
    })
    // One probe registration plus the live connection's own registration.
    expect(calls.count).toBe(2)
    expect(result.hostId).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.hostName).toBe('test')
    expect(result.pairingUrlBase).toBe('https://relay.example')
    expect(service.configured).toBe(true)
    expect(service.consoleInfo()).toMatchObject({
      configured: true,
      hostId: result.hostId,
      relayHttpUrl: 'https://relay.example',
      registrationTokenSet: true,
    })

    // A later boot reads the stored setup back over the patch values.
    await apply(ctx, { ...config, relayHttpUrl: 'http://patch.example', hostId: 'patch-host' })
    const service2 = provided.get('webRemoteHost') as WebRemoteHostService
    expect(service2.configured).toBe(true)
    expect(service2.consoleInfo()).toMatchObject({
      hostId: result.hostId,
      relayHttpUrl: 'https://relay.example',
    })
    expect(service2.consoleInfo().hostId).not.toBe('patch-host')
  })

  it('configureRelay keeps the unconfigured state when the relay rejects setup', async () => {
    const calls = { count: 0 }
    const { ctx, provided } = makeContext()
    await apply(ctx, {
      ...config,
      relayHttpUrl: undefined,
      fetchImpl: registerFetch({ ok: false, status: 401 }, calls),
    })
    const service = provided.get('webRemoteHost') as WebRemoteHostService

    await expect(
      service.configureRelay({ relayHttpUrl: 'https://relay.example', registrationToken: 'wrong' }),
    ).rejects.toThrow('relay setup failed')
    expect(calls.count).toBe(1)
    expect(service.configured).toBe(false)
    expect(service.status).toBe('unconfigured')

    // Nothing was persisted: a later boot stays unconfigured.
    await apply(ctx, { ...config, relayHttpUrl: undefined })
    const service2 = provided.get('webRemoteHost') as WebRemoteHostService
    expect(service2.configured).toBe(false)
  })
})
