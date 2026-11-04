import { describe, expect, it } from 'vitest'
import { withUnreadEndpoints } from '../src/unread-endpoints.ts'
import type { UnreadEndpointController } from '../src/unread-endpoints.ts'
import type { HostBridge } from '../src/bridge.ts'

function baseBridge(): HostBridge & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async call(endpoint) {
      calls.push(endpoint)
      return { ok: true, value: { forwarded: endpoint } }
    },
    open() {
      throw new Error('streams are not used by this test')
    },
  }
}

function controller(): UnreadEndpointController & { requests: unknown[] } {
  const requests: unknown[] = []
  return {
    requests,
    baselines: async () => ({ items: [{ sessionId: 's1', readSeq: 4, readAt: 400 }] }),
    markRead: async (request) => {
      requests.push(request)
      return { cleared: true, unreadAt: null }
    },
  }
}

describe('withUnreadEndpoints', () => {
  it('serves baselines without reaching the Gateway', async () => {
    const bridge = baseBridge()
    const exposed = withUnreadEndpoints(bridge, controller())
    await expect(exposed.call('remote/unread/baselines', { args: {} })).resolves.toEqual({
      ok: true,
      value: { items: [{ sessionId: 's1', readSeq: 4, readAt: 400 }] },
    })
    expect(bridge.calls).toEqual([])
  })

  it('parses the compare-and-clear request from the nested args envelope', async () => {
    const unread = controller()
    const exposed = withUnreadEndpoints(baseBridge(), unread)
    await expect(
      exposed.call('remote/unread/markRead', {
        args: { request: { sessionId: 's1', expectedUnreadAt: 300 } },
      }),
    ).resolves.toEqual({ ok: true, value: { cleared: true, unreadAt: null } })
    expect(unread.requests).toEqual([{ sessionId: 's1', expectedUnreadAt: 300 }])
  })

  it('accepts a null expected cut for an already-read session', async () => {
    const unread = controller()
    const exposed = withUnreadEndpoints(baseBridge(), unread)
    await expect(
      exposed.call('remote/unread/markRead', {
        args: { request: { sessionId: 's1', expectedUnreadAt: null } },
      }),
    ).resolves.toMatchObject({ ok: true })
    expect(unread.requests).toEqual([{ sessionId: 's1', expectedUnreadAt: null }])
  })

  it('rejects malformed requests before calling the controller', async () => {
    const unread = controller()
    const exposed = withUnreadEndpoints(baseBridge(), unread)
    for (const payload of [
      { args: {} },
      { args: { request: { expectedUnreadAt: 1 } } },
      { args: { request: { sessionId: '', expectedUnreadAt: 1 } } },
      { args: { request: { sessionId: 's1', expectedUnreadAt: 'now' } } },
    ]) {
      await expect(exposed.call('remote/unread/markRead', payload)).resolves.toEqual({
        ok: false,
        error: { code: 'unread/invalid-request', message: expect.any(String) },
      })
    }
    expect(unread.requests).toEqual([])
  })

  it('maps controller failures to a structured unread error', async () => {
    const exposed = withUnreadEndpoints(baseBridge(), {
      baselines: async () => {
        throw new Error('storage offline')
      },
      markRead: async () => {
        throw new Error('session is not attached')
      },
    })
    await expect(exposed.call('remote/unread/baselines', { args: {} })).resolves.toEqual({
      ok: false,
      error: { code: 'unread/baselines-failed', message: 'storage offline' },
    })
    await expect(
      exposed.call('remote/unread/markRead', {
        args: { request: { sessionId: 's1', expectedUnreadAt: 1 } },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'unread/mark-read-failed', message: 'session is not attached' },
    })
  })

  it('forwards every other endpoint to the Gateway bridge', async () => {
    const bridge = baseBridge()
    const exposed = withUnreadEndpoints(bridge, controller())
    await expect(exposed.call('session/list', { args: {} })).resolves.toMatchObject({ ok: true })
    expect(bridge.calls).toEqual(['session/list'])
  })
})
