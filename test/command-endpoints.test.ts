import { describe, expect, it } from 'vitest'
import { withCommandQueryEndpoint } from '../src/command-endpoints.ts'
import type { HostBridge } from '../src/bridge.ts'

function baseBridge(): HostBridge {
  return {
    async call() {
      return { ok: true, value: { forwarded: true } }
    },
    open() {
      throw new Error('streams are not used by this test')
    },
  }
}

function promptEvent(sessionId: string, requestId: string, seq: number, time: number): Record<string, unknown> {
  return {
    type: 'user/message',
    seq,
    time,
    data: {
      id: `m-${String(seq)}`,
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user', rpcId: requestId, sessionId },
    },
  }
}

function payload(items: unknown): Record<string, unknown> {
  return { args: { request: { items } } }
}

describe('withCommandQueryEndpoint', () => {
  it('reports a prompt already recorded in the Session log', async () => {
    const reads: string[] = []
    const bridge = withCommandQueryEndpoint(baseBridge(), {
      async readEvents(sessionId) {
        reads.push(sessionId)
        return [promptEvent('s1', 'req-1', 7, 1000)]
      },
    })
    await expect(bridge.call('remote/commands/query', payload([
      { sessionId: 's1', requestId: 'req-1' },
      { sessionId: 's1', requestId: 'req-missing' },
    ]))).resolves.toEqual({
      ok: true,
      value: {
        items: [
          { sessionId: 's1', requestId: 'req-1', settled: true, seq: 7, at: 1000 },
          { sessionId: 's1', requestId: 'req-missing', settled: false },
        ],
      },
    })
    expect(reads).toEqual(['s1'])
  })

  it('reads each Session once for a batch', async () => {
    const reads: string[] = []
    const bridge = withCommandQueryEndpoint(baseBridge(), {
      async readEvents(sessionId) {
        reads.push(sessionId)
        return [promptEvent(sessionId, `req-${sessionId}`, 1, 10)]
      },
    })
    await expect(bridge.call('remote/commands/query', payload([
      { sessionId: 's1', requestId: 'req-s1' },
      { sessionId: 's2', requestId: 'req-s2' },
      { sessionId: 's1', requestId: 'other' },
    ]))).resolves.toMatchObject({
      ok: true,
      value: {
        items: [
          { sessionId: 's1', requestId: 'req-s1', settled: true },
          { sessionId: 's2', requestId: 'req-s2', settled: true },
          { sessionId: 's1', requestId: 'other', settled: false },
        ],
      },
    })
    expect(reads).toEqual(['s1', 's2'])
  })

  it('rejects empty, oversized, and malformed batches', async () => {
    const bridge = withCommandQueryEndpoint(baseBridge(), { async readEvents() { return [] } })
    await expect(bridge.call('remote/commands/query', payload([]))).resolves.toMatchObject({
      ok: false,
      error: { code: 'commands/invalid-request' },
    })
    await expect(bridge.call('remote/commands/query', payload(
      Array.from({ length: 65 }, (_, index) => ({ sessionId: 's1', requestId: `r-${String(index)}` })),
    ))).resolves.toMatchObject({ ok: false, error: { code: 'commands/invalid-request' } })
    await expect(bridge.call('remote/commands/query', payload([{ sessionId: '', requestId: 'r' }])))
      .resolves.toMatchObject({ ok: false, error: { code: 'commands/invalid-request' } })
    await expect(bridge.call('remote/commands/query', payload([{ sessionId: 's1', requestId: 3 }])))
      .resolves.toMatchObject({ ok: false, error: { code: 'commands/invalid-request' } })
  })

  it('reports a log read failure so the caller can fall back to resending', async () => {
    const bridge = withCommandQueryEndpoint(baseBridge(), {
      async readEvents() {
        throw new Error('corrupt log')
      },
    })
    await expect(bridge.call('remote/commands/query', payload([{ sessionId: 's1', requestId: 'r' }])))
      .resolves.toEqual({
        ok: false,
        error: { code: 'commands/query-failed', message: 'corrupt log' },
      })
  })

  it('forwards every other endpoint unchanged', async () => {
    const bridge = withCommandQueryEndpoint(baseBridge(), { async readEvents() { return [] } })
    await expect(bridge.call('session/list', { args: { _request: {} } })).resolves.toEqual({
      ok: true,
      value: { forwarded: true },
    })
  })
})
