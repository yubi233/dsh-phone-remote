import { afterEach, describe, expect, it, vi } from 'vitest'
import { AsyncQueue, HostRemote } from 'dsh-phone-remote'
import type {
  HostBridge,
  HostRemoteConfig,
  HostRemoteState,
  HostRpcResult,
} from 'dsh-phone-remote'
import {
  FrameAssembler,
  PROTOCOL_VERSION,
  base64ToBytes,
  bytesToBase64,
  encodeMessage,
  parseAppPayload,
} from '@dsh-web-remote/protocol'
import type {
  AppPayload,
  RelayFrame,
  RelaySocket,
  RelaySocketCloseInfo,
  RelaySocketFactory,
} from '@dsh-web-remote/protocol'

type MessagePredicate = (message: unknown) => boolean
type StreamFramePayload = Extract<AppPayload, { type: 'stream-frame' }>

/** One end of an in-memory relay connection. */
class MemoryEndpoint implements RelaySocket {
  readonly received: unknown[] = []
  #peer: MemoryEndpoint | undefined
  #opened = false
  #closed = false
  readonly #openHandlers = new Set<() => void>()
  readonly #messageHandlers = new Set<(text: string) => void>()
  readonly #closeHandlers = new Set<(info: RelaySocketCloseInfo) => void>()
  readonly #waiters: Array<{ predicate: MessagePredicate; resolve: (message: unknown) => void }> = []

  attach(peer: MemoryEndpoint): void {
    this.#peer = peer
  }

  send(text: string): void {
    if (!this.#opened || this.#closed) return
    this.#peer?.receive(text)
  }

  close(code = 1000, reason = ''): void {
    if (this.#closed) return
    this.#closed = true
    const info: RelaySocketCloseInfo = { code, reason }
    this.#peer?.markClosed()
    this.emitClose(info)
    this.#peer?.emitClose(info)
  }

  onOpen(handler: () => void): () => void {
    this.#openHandlers.add(handler)
    if (this.#opened && !this.#closed) queueMicrotask(handler)
    return (): void => {
      this.#openHandlers.delete(handler)
    }
  }

  onMessage(handler: (text: string) => void): () => void {
    this.#messageHandlers.add(handler)
    return (): void => {
      this.#messageHandlers.delete(handler)
    }
  }

  onClose(handler: (info: RelaySocketCloseInfo) => void): () => void {
    this.#closeHandlers.add(handler)
    return (): void => {
      this.#closeHandlers.delete(handler)
    }
  }

  open(): void {
    if (this.#opened || this.#closed) return
    this.#opened = true
    for (const handler of [...this.#openHandlers]) queueMicrotask(handler)
  }

  /** Deliver one relay-to-Host message. */
  deliver(message: unknown): void {
    this.#peer?.receive(JSON.stringify(message))
  }

  /** Resolve when a matching received message exists or arrives. */
  waitFor(predicate: MessagePredicate): Promise<unknown> {
    const existing = this.received.find(predicate)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise<unknown>((resolve) => {
      this.#waiters.push({ predicate, resolve })
    })
  }

  receive(text: string): void {
    if (!this.#opened || this.#closed) return
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    this.received.push(message)
    for (const waiter of [...this.#waiters]) {
      if (!waiter.predicate(message)) continue
      this.#waiters.splice(this.#waiters.indexOf(waiter), 1)
      waiter.resolve(message)
    }
    for (const handler of [...this.#messageHandlers]) handler(text)
  }

  markClosed(): void {
    this.#closed = true
  }

  emitClose(info: RelaySocketCloseInfo): void {
    for (const handler of [...this.#closeHandlers]) queueMicrotask(() => handler(info))
    this.#openHandlers.clear()
    this.#messageHandlers.clear()
    this.#closeHandlers.clear()
  }
}

interface MemoryPair {
  host: MemoryEndpoint
  relay: MemoryEndpoint
}

function createMemoryPair(): MemoryPair {
  const host = new MemoryEndpoint()
  const relay = new MemoryEndpoint()
  host.attach(relay)
  relay.attach(host)
  host.open()
  relay.open()
  return { host, relay }
}

interface MemoryFactory {
  pairs: MemoryPair[]
  createSocket: RelaySocketFactory
}

function memorySocketFactory(): MemoryFactory {
  const pairs: MemoryPair[] = []
  return {
    pairs,
    createSocket: async (): Promise<RelaySocket> => {
      const pair = createMemoryPair()
      pairs.push(pair)
      return pair.host
    },
  }
}

async function waitForPair(pairs: MemoryPair[], index: number): Promise<MemoryPair> {
  for (let turn = 0; turn < 10_000; turn += 1) {
    const pair = pairs[index]
    if (pair !== undefined) return pair
    await Promise.resolve()
  }
  throw new Error(`relay socket ${index} was not created`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageType(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined
  return value.type
}

function appPayload(value: unknown): AppPayload | undefined {
  if (!isRecord(value) || value.type !== 'data') return undefined
  try {
    return parseAppPayload(value.payload)
  } catch {
    return undefined
  }
}

function receivedFrames(messages: readonly unknown[]): StreamFramePayload[] {
  const frames: StreamFramePayload[] = []
  for (const message of messages) {
    const payload = appPayload(message)
    if (payload?.type === 'stream-frame') frames.push(payload)
  }
  return frames
}

function frameValue(frame: RelayFrame): unknown {
  expect(frame.fragmentCount).toBe(1)
  return JSON.parse(new TextDecoder().decode(base64ToBytes(frame.dataBase64)))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const registerFetch: typeof fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input)
  if (!url.endsWith('/v1/hosts/register')) throw new Error(`unexpected fetch ${url}`)
  return jsonResponse({ hostToken: 'host-token', expiresAt: Date.now() + 3_600_000 })
}

const baseConfig: HostRemoteConfig = {
  relayHttpUrl: 'https://relay.test',
  relayWsUrl: 'wss://relay.test/ws',
  hostId: 'host-1',
  hostSecret: 'host-secret',
  hostName: 'test host',
  hostVersion: '1.2.3',
  capabilities: ['session.follow', 'session.control'],
  fetchImpl: registerFetch,
  heartbeatIntervalMs: 5_000,
  ackWatchdogMs: 15_000,
  reconnectMinMs: 10,
  reconnectMaxMs: 20,
}

function idleOpen(): AsyncIterable<unknown> {
  return (async function* (): AsyncGenerator<unknown> {})()
}

function idleBridge(): HostBridge {
  return {
    async call(): Promise<HostRpcResult> {
      return { ok: true, value: null }
    },
    open: idleOpen,
  }
}

async function acceptHello(pair: MemoryPair): Promise<void> {
  const hello = await pair.relay.waitFor((message) => messageType(message) === 'host_hello')
  expect(hello).toMatchObject({
    type: 'host_hello',
    protocolVersion: PROTOCOL_VERSION,
    hostId: 'host-1',
    hostName: 'test host',
  })
  pair.relay.deliver({
    type: 'hello_ack',
    protocolVersion: PROTOCOL_VERSION,
    connectionId: 'connection-1',
    hostId: 'host-1',
    pairStatus: 'waiting',
  })
}

const running: HostRemote[] = []

interface Harness {
  remote: HostRemote
  pairs: MemoryPair[]
  states: HostRemoteState[]
}

async function startOnline(
  bridge: HostBridge,
  overrides: Partial<HostRemoteConfig> = {},
): Promise<Harness> {
  const factory = memorySocketFactory()
  const remote = new HostRemote(
    { ...baseConfig, ...overrides, createSocket: factory.createSocket },
    bridge,
  )
  running.push(remote)
  const states: HostRemoteState[] = []
  remote.onState((state) => states.push(state))
  const started = remote.start()
  const pair = await waitForPair(factory.pairs, 0)
  await acceptHello(pair)
  await started
  expect(remote.state).toBe('online')
  return { remote, pairs: factory.pairs, states }
}

async function flushMicrotasks(turns = 4): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve()
}

afterEach(async () => {
  for (const remote of running.splice(0)) await remote.stop()
  vi.useRealTimers()
})

describe('AsyncQueue', () => {
  it('buffers values, drains them before ending, and rejects pushes after end', async () => {
    const queue = new AsyncQueue<number>()
    const seen: number[] = []
    const consumed = (async (): Promise<void> => {
      for await (const value of queue.iterate()) seen.push(value)
    })()
    expect(queue.push(1)).toBe(true)
    expect(queue.push(2)).toBe(true)
    queue.end()
    expect(queue.push(3)).toBe(false)
    await consumed
    expect(seen).toEqual([1, 2])
  })
})

describe('HostRemote connection', () => {
  it('registers, sends host_hello, reaches online on hello_ack, and stops idempotently', async () => {
    const harness = await startOnline(idleBridge())
    expect(harness.states).toEqual(['connecting', 'online'])
    expect(harness.pairs[0]?.relay.received[0]).toMatchObject({
      type: 'host_hello',
      protocolVersion: PROTOCOL_VERSION,
      hostId: 'host-1',
      hostName: 'test host',
    })
    expect(harness.remote.state).toBe('online')
    await harness.remote.stop()
    expect(harness.remote.state).toBe('stopped')
    await harness.remote.stop()
    expect(harness.remote.state).toBe('stopped')
  })

  it('answers hello with hello-ack including host metadata and capabilities', async () => {
    const harness = await startOnline(idleBridge())
    const relay = harness.pairs[0]!.relay
    relay.deliver({ type: 'data', payload: { type: 'hello', protocolVersion: PROTOCOL_VERSION } })
    const reply = await relay.waitFor((message) => appPayload(message)?.type === 'hello-ack')
    expect(appPayload(reply)).toEqual({
      type: 'hello-ack',
      protocolVersion: PROTOCOL_VERSION,
      hostName: 'test host',
      hostVersion: '1.2.3',
      capabilities: ['session.follow', 'session.control'],
    })
    await harness.remote.stop()
  })

  it('forwards rpc-call results, failure details, and thrown errors', async () => {
    const bridge: HostBridge = {
      async call(endpoint: string): Promise<HostRpcResult> {
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'sessions/fail') {
          return {
            ok: false,
            error: { code: 'session/not-found', message: 'missing', details: { id: 's1' } },
          }
        }
        throw new Error('boom')
      },
      open: idleOpen,
    }
    const harness = await startOnline(bridge)
    const relay = harness.pairs[0]!.relay
    relay.deliver({
      type: 'data',
      payload: { type: 'rpc-call', rpcId: 'rpc-1', endpoint: 'sessions/list', payload: {} },
    })
    relay.deliver({
      type: 'data',
      payload: { type: 'rpc-call', rpcId: 'rpc-2', endpoint: 'sessions/fail', payload: {} },
    })
    relay.deliver({
      type: 'data',
      payload: { type: 'rpc-call', rpcId: 'rpc-3', endpoint: 'sessions/throw', payload: {} },
    })

    const first = await relay.waitFor(
      (message) => isRecord(message) && message.type === 'data' &&
        isRecord(message.payload) && message.payload.rpcId === 'rpc-1',
    )
    expect(appPayload(first)).toEqual({
      type: 'rpc-result',
      rpcId: 'rpc-1',
      ok: true,
      value: { sessions: [] },
    })

    const second = await relay.waitFor(
      (message) => isRecord(message) && message.type === 'data' &&
        isRecord(message.payload) && message.payload.rpcId === 'rpc-2',
    )
    expect(appPayload(second)).toEqual({
      type: 'rpc-result',
      rpcId: 'rpc-2',
      ok: false,
      error: { code: 'session/not-found', message: 'missing', data: { id: 's1' } },
    })

    const third = await relay.waitFor(
      (message) => isRecord(message) && message.type === 'data' &&
        isRecord(message.payload) && message.payload.rpcId === 'rpc-3',
    )
    expect(appPayload(third)).toEqual({
      type: 'rpc-result',
      rpcId: 'rpc-3',
      ok: false,
      error: { code: 'host/internal', message: 'boom' },
    })
    await harness.remote.stop()
  })

  it('fragments large rpc results into rpc-frame messages', async () => {
    const value = { blob: 'x'.repeat(700 * 1024), note: 'large' }
    const bridge: HostBridge = {
      async call(): Promise<HostRpcResult> {
        return { ok: true, value }
      },
      open: idleOpen,
    }
    const harness = await startOnline(bridge)
    const relay = harness.pairs[0]!.relay
    relay.deliver({
      type: 'data',
      payload: { type: 'rpc-call', rpcId: 'rpc-big', endpoint: 'big', payload: {} },
    })
    await flushMicrotasks(8)

    const frames = relay.received
      .map((message) => appPayload(message))
      .filter((payload): payload is Extract<AppPayload, { type: 'rpc-frame' }> =>
        payload?.type === 'rpc-frame' && payload.rpcId === 'rpc-big')
      .map((payload) => payload.frame)
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.every((frame) => frame.fragmentCount === frames.length)).toBe(true)

    const assembler = new FrameAssembler()
    let assembled: unknown
    for (const frame of frames) {
      const result = assembler.add(frame)
      if (result.status === 'complete') assembled = result.message.payload
    }
    expect(assembled).toEqual(value)
    await harness.remote.stop()
  })

  it('streams rpc-open values as frames and closes the stream on completion', async () => {
    const opened: Array<{ endpoint: string; payload: unknown }> = []
    const bridge: HostBridge = {
      async call(): Promise<HostRpcResult> {
        return { ok: true, value: null }
      },
      open(endpoint, payload): AsyncIterable<unknown> {
        opened.push({ endpoint, payload })
        return (async function* (): AsyncGenerator<unknown> {
          yield 1
          yield 2
          yield 3
        })()
      },
    }
    const harness = await startOnline(bridge)
    const relay = harness.pairs[0]!.relay
    relay.deliver({
      type: 'data',
      payload: {
        type: 'rpc-open',
        streamId: 'stream-1',
        endpoint: 'session.follow',
        payload: { sessionId: 's1' },
        recoveryId: 'recovery-1',
      },
    })

    await relay.waitFor((message) => {
      const payload = appPayload(message)
      return payload?.type === 'stream-frame' && payload.frame.messageSeq === 3
    })
    const close = await relay.waitFor((message) => appPayload(message)?.type === 'stream-close')

    const frames = receivedFrames(relay.received)
    expect(frames).toHaveLength(3)
    expect(frames.map((payload) => payload.frame.seq)).toEqual([1, 2, 3])
    expect(frames.map((payload) => payload.frame.messageSeq)).toEqual([1, 2, 3])
    for (const { frame } of frames) {
      expect(frame).toMatchObject({
        type: 'rpc-frame',
        bridgeSessionId: 'stream-1',
        bridgeGeneration: 1,
        recoveryId: 'recovery-1',
        fragmentCount: 1,
      })
    }
    expect(frames.map((payload) => frameValue(payload.frame))).toEqual([1, 2, 3])
    expect(appPayload(close)).toEqual({ type: 'stream-close', streamId: 'stream-1' })
    expect(opened).toEqual([{ endpoint: 'session.follow', payload: { sessionId: 's1' } }])
    await harness.remote.stop()
  })

  it('replays only unacknowledged frames after reconnecting', async () => {
    vi.useFakeTimers()
    const bridge: HostBridge = {
      async call(): Promise<HostRpcResult> {
        return { ok: true, value: null }
      },
      open(
        _endpoint: string,
        _payload: unknown,
        _uplink: AsyncIterable<unknown>,
        signal: AbortSignal,
      ): AsyncIterable<unknown> {
        return (async function* (): AsyncGenerator<unknown> {
          yield 1
          yield 2
          yield 3
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener('abort', () => resolve(), { once: true })
          })
        })()
      },
    }
    const factory = memorySocketFactory()
    const remote = new HostRemote(
      { ...baseConfig, createSocket: factory.createSocket, reconnectMinMs: 10, reconnectMaxMs: 10 },
      bridge,
    )
    running.push(remote)
    const started = remote.start()
    const first = await waitForPair(factory.pairs, 0)
    await acceptHello(first)
    await started

    first.relay.deliver({
      type: 'data',
      payload: { type: 'rpc-open', streamId: 'stream-1', endpoint: 'session.follow', payload: {} },
    })
    await first.relay.waitFor((message) => {
      const payload = appPayload(message)
      return payload?.type === 'stream-frame' && payload.frame.messageSeq === 3
    })
    first.relay.deliver({
      type: 'data',
      payload: { type: 'stream-frame-ack', streamId: 'stream-1', messageSeq: 2 },
    })

    first.relay.close(1006, 'network drop')
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(10)

    const second = await waitForPair(factory.pairs, 1)
    await acceptHello(second)

    const replayed = receivedFrames(second.relay.received)
    expect(replayed.map((payload) => payload.frame.messageSeq)).toEqual([3])
    expect(replayed.map((payload) => frameValue(payload.frame))).toEqual([3])
    await remote.stop()
  })

  it('pushes stream-uplink values into the bridge uplink iterator', async () => {
    const seen: unknown[] = []
    let resolveSeen!: () => void
    const twoSeen = new Promise<void>((resolve) => {
      resolveSeen = resolve
    })
    const bridge: HostBridge = {
      async call(): Promise<HostRpcResult> {
        return { ok: true, value: null }
      },
      open(
        _endpoint: string,
        _payload: unknown,
        uplink: AsyncIterable<unknown>,
      ): AsyncIterable<unknown> {
        return (async function* (): AsyncGenerator<unknown> {
          for await (const value of uplink) {
            seen.push(value)
            if (seen.length === 2) resolveSeen()
          }
        })()
      },
    }
    const harness = await startOnline(bridge)
    const relay = harness.pairs[0]!.relay
    relay.deliver({
      type: 'data',
      payload: { type: 'rpc-open', streamId: 'stream-1', endpoint: 'session.follow', payload: {} },
    })
    relay.deliver({
      type: 'data',
      payload: { type: 'stream-uplink', streamId: 'stream-1', value: { n: 1 } },
    })
    relay.deliver({
      type: 'data',
      payload: { type: 'stream-uplink', streamId: 'stream-1', value: { n: 2 } },
    })
    await twoSeen
    expect(seen).toEqual([{ n: 1 }, { n: 2 }])
    await harness.remote.stop()
  })

  it('aborts the bridge signal when the device closes the stream', async () => {
    let resolveSignal!: (signal: AbortSignal) => void
    const signalSeen = new Promise<AbortSignal>((resolve) => {
      resolveSignal = resolve
    })
    const bridge: HostBridge = {
      async call(): Promise<HostRpcResult> {
        return { ok: true, value: null }
      },
      open(
        _endpoint: string,
        _payload: unknown,
        _uplink: AsyncIterable<unknown>,
        signal: AbortSignal,
      ): AsyncIterable<unknown> {
        resolveSignal(signal)
        return (async function* (): AsyncGenerator<unknown> {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener('abort', () => resolve(), { once: true })
          })
        })()
      },
    }
    const harness = await startOnline(bridge)
    const relay = harness.pairs[0]!.relay
    relay.deliver({
      type: 'data',
      payload: { type: 'rpc-open', streamId: 'stream-1', endpoint: 'session.follow', payload: {} },
    })
    const signal = await signalSeen
    expect(signal.aborted).toBe(false)

    relay.deliver({
      type: 'data',
      payload: { type: 'stream-close', streamId: 'stream-1', reason: 'device closed' },
    })
    await flushMicrotasks()
    expect(signal.aborted).toBe(true)
    await harness.remote.stop()
  })

  it('pings on the heartbeat interval and reconnects when the watchdog expires', async () => {
    vi.useFakeTimers()
    const factory = memorySocketFactory()
    const remote = new HostRemote(
      {
        ...baseConfig,
        createSocket: factory.createSocket,
        heartbeatIntervalMs: 100,
        ackWatchdogMs: 250,
        reconnectMinMs: 10,
        reconnectMaxMs: 10,
      },
      idleBridge(),
    )
    running.push(remote)
    const started = remote.start()
    const first = await waitForPair(factory.pairs, 0)
    await acceptHello(first)
    await started

    await vi.advanceTimersByTimeAsync(100)
    const ping = await first.relay.waitFor((message) => messageType(message) === 'ping')
    expect(ping).toMatchObject({ type: 'ping' })

    await vi.advanceTimersByTimeAsync(300)
    const second = await waitForPair(factory.pairs, 1)
    await acceptHello(second)
    expect(remote.state).toBe('online')
    await remote.stop()
  })
})

describe('relay token recovery', () => {
  it('re-registers once when the upgrade is rejected with 401 (relay lost its store)', async () => {
    let registerCalls = 0
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (!url.endsWith('/v1/hosts/register')) throw new Error(`unexpected fetch ${url}`)
      registerCalls += 1
      return jsonResponse({ hostToken: `host-token-${String(registerCalls)}`, expiresAt: Date.now() + 3_600_000 })
    }
    const factory = memorySocketFactory()
    let rejectFirst = true
    const createSocket: RelaySocketFactory = async (url) => {
      if (rejectFirst) {
        rejectFirst = false
        throw Object.assign(new Error('relay rejected the upgrade with HTTP 401'), { statusCode: 401 })
      }
      return factory.createSocket(url)
    }
    const remote = new HostRemote(
      { ...baseConfig, fetchImpl, createSocket, reconnectMinMs: 10, reconnectMaxMs: 20 },
      idleBridge(),
    )
    running.push(remote)
    const starting = remote.start()
    const pair = await waitForPair(factory.pairs, 0)
    await acceptHello(pair)
    await starting
    expect(registerCalls).toBe(2)
    expect(remote.state).toBe('online')
  })

  it('does not re-register on a plain transport failure', async () => {
    let registerCalls = 0
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (!url.endsWith('/v1/hosts/register')) throw new Error(`unexpected fetch ${url}`)
      registerCalls += 1
      return jsonResponse({ hostToken: 'host-token-1', expiresAt: Date.now() + 3_600_000 })
    }
    const createSocket: RelaySocketFactory = async () => {
      throw new Error('ECONNREFUSED')
    }
    const remote = new HostRemote(
      { ...baseConfig, fetchImpl, createSocket, reconnectMinMs: 10, reconnectMaxMs: 20 },
      idleBridge(),
    )
    running.push(remote)
    await expect(remote.start()).rejects.toThrow('ECONNREFUSED')
    expect(registerCalls).toBe(1)
  })
})

describe('fragmented inbound requests', () => {
  it('reassembles rpc-frame batches into one bridge call', async () => {
    let seen: { endpoint: string; payload: unknown } | undefined
    const bridge: HostBridge = {
      async call(endpoint, payload) {
        seen = { endpoint, payload }
        return { ok: true, value: { endpoint, payload } }
      },
      open: idleOpen,
    }
    const harness = await startOnline(bridge)
    const pair = harness.pairs[0]!
    const inner = {
      type: 'rpc-call',
      rpcId: 'rpc-1',
      endpoint: 'session/prompt',
      payload: { blob: 'y'.repeat(600_000) },
    }
    const frames = encodeMessage(
      { bridgeSessionId: 'rpc-1', bridgeGeneration: 1, seq: 1, messageSeq: 1 },
      inner,
    )
    // Register the result watcher BEFORE delivering: the Host answers quickly.
    const assembler = new FrameAssembler()
    let resultValue: unknown
    const resultWaiter = pair.relay.waitFor((message) => {
      const payload = appPayload(message)
      if (payload?.type !== 'rpc-frame' || payload.rpcId !== 'rpc-1') return false
      const assembled = assembler.add(payload.frame)
      if (assembled.status !== 'complete') return false
      // The fragmented result carries the value itself, no envelope.
      resultValue = assembled.message.payload
      return true
    })
    for (const frame of frames) {
      pair.relay.deliver({ type: 'data', payload: { type: 'rpc-frame', rpcId: 'rpc-1', frame } })
    }
    await resultWaiter
    expect(resultValue).toEqual({ endpoint: 'session/prompt', payload: { blob: 'y'.repeat(600_000) } })
    expect(seen).toEqual({ endpoint: 'session/prompt', payload: { blob: 'y'.repeat(600_000) } })
  })

  it('answers a checksum-failed batch with a request failure', async () => {
    const harness = await startOnline(idleBridge())
    const pair = harness.pairs[0]!
    const inner = {
      type: 'rpc-call',
      rpcId: 'rpc-2',
      endpoint: 'session/prompt',
      payload: { blob: 'y'.repeat(600_000) },
    }
    const frames = encodeMessage(
      { bridgeSessionId: 'rpc-2', bridgeGeneration: 1, seq: 1, messageSeq: 1 },
      inner,
    )
    const original = base64ToBytes(frames[0]!.dataBase64)
    const corrupted = original.map((byte) => byte ^ 0xff)
    frames[0] = { ...frames[0]!, dataBase64: bytesToBase64(corrupted) }
    for (const frame of frames) {
      pair.relay.deliver({ type: 'data', payload: { type: 'rpc-frame', rpcId: 'rpc-2', frame } })
    }
    const result = await pair.relay.waitFor((message) => {
      const payload = appPayload(message)
      return payload?.type === 'rpc-result' && payload.rpcId === 'rpc-2'
    })
    const payload = appPayload(result) as Extract<AppPayload, { type: 'rpc-result' }>
    if (payload.ok !== false) throw new Error('expected a failed rpc-result')
    expect(payload.error.code).toBe('host/request-invalid')
  })
})

describe('registration token passthrough', () => {
  it('sends x-registration-token on host registration', async () => {
    // Pins the HostRemote -> PairingClient passthrough: the relay rejects the
    // socket upgrade with 401, but the registration fetch must have carried
    // the configured token header first.
    let sawHeader = false
    const fetchProbe: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.endsWith('/v1/hosts/register')) throw new Error(`unexpected fetch ${url}`)
      sawHeader = new Headers(init?.headers).get('x-registration-token') === 'pub-token'
      return jsonResponse({ hostToken: 'host-token-1', expiresAt: Date.now() + 3_600_000 })
    }
    const createSocket: RelaySocketFactory = async () => {
      throw Object.assign(new Error('relay rejected the upgrade with HTTP 401'), { statusCode: 401 })
    }
    const remote = new HostRemote(
      {
        ...baseConfig,
        fetchImpl: fetchProbe,
        createSocket,
        registrationToken: 'pub-token',
        reconnectMinMs: 10,
        reconnectMaxMs: 20,
      },
      idleBridge(),
    )
    running.push(remote)
    await expect(remote.start()).rejects.toThrow('HTTP 401')
    expect(sawHeader).toBe(true)
  })
})
