import { describe, expect, it } from 'vitest'
import { DshStreamFailure, createDshHostBridge, deriveRelayWsUrl } from 'dsh-phone-remote'
import type { DshConnectionHandle, DshWireStream } from 'dsh-phone-remote'

interface CapturedRequest {
  url: string
  method: string
  body: unknown
  peer: unknown
}

function fakeConnection(respond: (captured: CapturedRequest) => Response | Promise<Response>): {
  connection: DshConnectionHandle
  captured: CapturedRequest[]
  peerCalls: number
} {
  const captured: CapturedRequest[] = []
  const handle = {
    peerCalls: 0,
    connection: {
      createSharedFetchHandler() {
        return {
          async fetch(request: Request, peer: unknown) {
            const body: unknown = await request.json()
            const record = { url: request.url, method: request.method, body, peer }
            captured.push(record)
            return respond(record)
          },
        }
      },
      createPeer() {
        handle.peerCalls += 1
        return { peer: handle.peerCalls }
      },
    },
  }
  return { connection: handle.connection, captured, get peerCalls() { return handle.peerCalls } }
}

function serverResponse(rpcId: string, result: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function binaryResponse(
  rpcId: string,
  value: unknown,
  attachments: { path: (string | number)[]; bytes: Uint8Array }[],
): Response {
  const form = new FormData()
  form.set(
    'metadata',
    JSON.stringify({
      type: 'server-response',
      rpcId,
      result: { ok: true, value },
      attachments: attachments.map((attachment, index) => ({
        path: [...attachment.path],
        codec: 'bytes',
        part: `bytes-${index}`,
      })),
    }),
  )
  attachments.forEach((attachment, index) => {
    form.set(`bytes-${index}`, new Blob([attachment.bytes]))
  })
  return new Response(form)
}

describe('createDshHostBridge.call', () => {
  it('posts the DSH client-request envelope and returns the result envelope', async () => {
    const fake = fakeConnection((captured) => {
      const body = captured.body as { rpcId: string; method: string; payload: unknown }
      expect(captured.url).toBe('http://dsh.internal/api/session/list')
      expect(captured.method).toBe('POST')
      expect(body).toMatchObject({ type: 'client-request', method: 'session/list', payload: { cursor: 'x' } })
      return serverResponse(body.rpcId, { ok: true, value: { items: [] } })
    })
    const bridge = createDshHostBridge({
      connection: fake.connection,
      wireStream: unusedStream(),
    })
    await expect(bridge.call('session/list', { cursor: 'x' })).resolves.toEqual({
      ok: true,
      value: { items: [] },
    })
    expect(fake.peerCalls).toBe(1)
  })

  it('passes through RPC failures and creates one peer across calls', async () => {
    const fake = fakeConnection((captured) => {
      const body = captured.body as { rpcId: string }
      return serverResponse(body.rpcId, {
        ok: false,
        error: { code: 'session/conflict', message: 'busy', details: { sessionId: 's1' } },
      })
    })
    const bridge = createDshHostBridge({ connection: fake.connection, wireStream: unusedStream() })
    await expect(bridge.call('session/prompt', {})).resolves.toEqual({
      ok: false,
      error: { code: 'session/conflict', message: 'busy', details: { sessionId: 's1' } },
    })
    await bridge.call('session/list', {})
    expect(fake.peerCalls).toBe(1)
  })

  it('reports HTTP failures without parsing the body', async () => {
    const fake = fakeConnection(() => new Response('nope', { status: 503 }))
    const bridge = createDshHostBridge({ connection: fake.connection, wireStream: unusedStream() })
    const result = await bridge.call('session/list', {})
    expect(result).toMatchObject({ ok: false, error: { code: 'transport/http-503' } })
  })

  it('rejects an rpcId mismatch', async () => {
    const fake = fakeConnection(() => serverResponse('different', { ok: true, value: 1 }))
    const bridge = createDshHostBridge({ connection: fake.connection, wireStream: unusedStream() })
    await expect(bridge.call('session/list', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'transport/rpc-mismatch' },
    })
  })

  it('rejects malformed response envelopes', async () => {
    const fake = fakeConnection(() => new Response(JSON.stringify({ type: 'nope' }), { status: 200 }))
    const bridge = createDshHostBridge({ connection: fake.connection, wireStream: unusedStream() })
    await expect(bridge.call('session/list', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'transport/invalid-result' },
    })
  })

  it('splices multipart byte parts into a base64 JSON value', async () => {
    const bytes = new Uint8Array([0, 255, 1, 65])
    const fake = fakeConnection((captured) => {
      const body = captured.body as { rpcId: string; method: string }
      expect(body.method).toBe('workspaceFiles/readBytes')
      return binaryResponse(
        body.rpcId,
        { absolutePath: '/w/a.png', version: 'v1', offset: 0, eof: true, bytes: 4, data: null },
        [{ path: ['data'], bytes }],
      )
    })
    const bridge = createDshHostBridge({ connection: fake.connection, wireStream: unusedStream() })
    await expect(bridge.call('workspaceFiles/readBytes', { args: {} })).resolves.toEqual({
      ok: true,
      value: {
        absolutePath: '/w/a.png',
        version: 'v1',
        offset: 0,
        eof: true,
        bytes: 4,
        data: { $bytes: 'AP8BQQ==' },
      },
    })
  })

  it('parses JSON failures for binary endpoints without multipart', async () => {
    const fake = fakeConnection((captured) => {
      const body = captured.body as { rpcId: string }
      return serverResponse(body.rpcId, {
        ok: false,
        error: { code: 'workspace-file/too-large', message: 'too large', details: { limit: 4 } },
      })
    })
    const bridge = createDshHostBridge({ connection: fake.connection, wireStream: unusedStream() })
    await expect(bridge.call('workspaceFiles/readBytes', { args: {} })).resolves.toEqual({
      ok: false,
      error: { code: 'workspace-file/too-large', message: 'too large', details: { limit: 4 } },
    })
  })

  it('rejects a binary response whose byte part is missing', async () => {
    const fake = fakeConnection((captured) => {
      const body = captured.body as { rpcId: string }
      const form = new FormData()
      form.set(
        'metadata',
        JSON.stringify({
          type: 'server-response',
          rpcId: body.rpcId,
          result: { ok: true, value: { data: null } },
          attachments: [{ path: ['data'], codec: 'bytes', part: 'bytes-0' }],
        }),
      )
      return new Response(form)
    })
    const bridge = createDshHostBridge({ connection: fake.connection, wireStream: unusedStream() })
    await expect(bridge.call('workspaceFiles/readBytes', { args: {} })).resolves.toMatchObject({
      ok: false,
      error: { code: 'transport/invalid-binary' },
    })
  })
})

describe('createDshHostBridge.open', () => {
  it('delegates to the gateway wire stream with the shared peer', async () => {
    const fake = fakeConnection(() => serverResponse('x', { ok: true, value: null }))
    const calls: unknown[][] = []
    const stream: DshWireStream = {
      async open(...args) {
        calls.push(args)
        return (async function* () {
          yield 1
          yield 2
        })()
      },
      failure: () => ({ code: 'x', message: 'x', details: {} }),
    }
    const bridge = createDshHostBridge({ connection: fake.connection, wireStream: stream })
    const values: unknown[] = []
    for await (const value of bridge.open('session/follow', { a: 1 }, emptyUplink(), new AbortController().signal)) {
      values.push(value)
    }
    expect(values).toEqual([1, 2])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.slice(0, 2)).toEqual(['session/follow', { a: 1 }])
    expect(calls[0]![3]).toEqual({ peer: 1 })
  })

  it('maps stream errors through the gateway projection', async () => {
    const fake = fakeConnection(() => serverResponse('x', { ok: true, value: null }))
    const stream: DshWireStream = {
      async open() {
        throw new Error('boom')
      },
      failure: () => ({ code: 'gateway/context-failed', message: 'boom', details: { a: 1 } }),
    }
    const bridge = createDshHostBridge({ connection: fake.connection, wireStream: stream })
    const iterator = bridge.open('session/follow', {}, emptyUplink(), new AbortController().signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toMatchObject({
      name: 'DshStreamFailure',
      failure: { code: 'gateway/context-failed' },
    })
  })
})

describe('deriveRelayWsUrl', () => {
  it('converts http and https origins', () => {
    expect(deriveRelayWsUrl('http://127.0.0.1:8787')).toBe('ws://127.0.0.1:8787/v1/ws')
    expect(deriveRelayWsUrl('https://relay.example/base/')).toBe('wss://relay.example/base/v1/ws')
  })
})

async function* emptyUplink(): AsyncIterable<unknown> {
  // No device uplink values in these tests.
}

function unusedStream(): DshWireStream {
  return {
    async open() {
      return (async function* () {
        // Unused by unary tests.
      })()
    },
    failure: () => ({ code: 'unused', message: 'unused', details: {} }),
  }
}
