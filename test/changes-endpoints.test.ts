import { describe, expect, it } from 'vitest'
import { withChangesEndpoints } from '../src/changes-endpoints.ts'
import type { HostBridge } from '../src/bridge.ts'

function baseBridge(): HostBridge & { calls: { endpoint: string; payload: unknown }[] } {
  const calls: { endpoint: string; payload: unknown }[] = []
  return {
    calls,
    async call(endpoint, payload) {
      calls.push({ endpoint, payload })
      return { ok: true, value: { forwarded: endpoint } }
    },
    open() {
      throw new Error('streams are not used by this test')
    },
  }
}

const summary = {
  turn: 3,
  cwd: '/work/demo',
  files: [{ path: 'src/app.ts', display: 'src/app.ts', added: 2, deleted: 1 }],
  total: 1,
  added: 2,
  deleted: 1,
  snapshot: { before: 'a', after: 'b' },
}

describe('withChangesEndpoints', () => {
  it('serves a summary without the Host-only cwd and snapshot ids', async () => {
    const bridge = baseBridge()
    const exposed = withChangesEndpoints(bridge, {
      workspaceChanges: {
        summary: (sessionId, seq) => {
          expect(sessionId).toBe('s1')
          expect(seq).toBe(9)
          return summary
        },
        diff: async () => undefined,
      },
    })
    await expect(
      exposed.call('remote/changes/summary', { args: { request: { sessionId: 's1', seq: 9 } } }),
    ).resolves.toEqual({
      ok: true,
      value: {
        turn: 3,
        files: summary.files,
        total: 1,
        added: 2,
        deleted: 1,
      },
    })
    expect(bridge.calls).toEqual([])
  })

  it('serves one file comparison', async () => {
    const diff = {
      kind: 'text',
      path: 'src/app.ts',
      display: 'src/app.ts',
      before: true,
      after: true,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
      coarse: false,
    }
    const exposed = withChangesEndpoints(baseBridge(), {
      workspaceChanges: {
        summary: () => undefined,
        diff: async (sessionId, seq, index) => {
          expect([sessionId, seq, index]).toEqual(['s1', 9, 0])
          return diff
        },
      },
    })
    await expect(
      exposed.call('remote/changes/diff', { args: { request: { sessionId: 's1', seq: 9, index: 0 } } }),
    ).resolves.toEqual({ ok: true, value: diff })
  })

  it('returns null when the deployment has no changed-file service', async () => {
    const exposed = withChangesEndpoints(baseBridge(), {})
    await expect(
      exposed.call('remote/changes/summary', { args: { request: { sessionId: 's1', seq: 1 } } }),
    ).resolves.toEqual({ ok: true, value: null })
    await expect(
      exposed.call('remote/changes/diff', { args: { request: { sessionId: 's1', seq: 1, index: 0 } } }),
    ).resolves.toEqual({ ok: true, value: null })
  })

  it('rejects malformed requests and forwards every other endpoint', async () => {
    const bridge = baseBridge()
    const exposed = withChangesEndpoints(bridge, {})
    await expect(exposed.call('remote/changes/summary', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'changes/invalid-request' },
    })
    await expect(exposed.call('remote/changes/diff', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'changes/invalid-request' },
    })
    await expect(exposed.call('session/list', { args: {} })).resolves.toEqual({
      ok: true,
      value: { forwarded: 'session/list' },
    })
  })
})
