import { describe, expect, it } from 'vitest'
import { withHostInfoEndpoint } from '../src/host-endpoints.ts'
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

describe('withHostInfoEndpoint', () => {
  it('serves the configured Host identity without reaching the Gateway', async () => {
    const bridge = baseBridge()
    const exposed = withHostInfoEndpoint(bridge, {
      name: 'studio-mac',
      version: '0.2.1',
      capabilities: ['terminal'],
    })
    await expect(exposed.call('remote/hostInfo', { args: {} })).resolves.toEqual({
      ok: true,
      value: { name: 'studio-mac', version: '0.2.1', capabilities: ['terminal'] },
    })
    expect(bridge.calls).toEqual([])
  })

  it('omits an unconfigured version', async () => {
    const exposed = withHostInfoEndpoint(baseBridge(), { name: 'studio-mac', capabilities: [] })
    await expect(exposed.call('remote/hostInfo', {})).resolves.toEqual({
      ok: true,
      value: { name: 'studio-mac', capabilities: [] },
    })
  })

  it('forwards every other endpoint unchanged', async () => {
    const bridge = baseBridge()
    const exposed = withHostInfoEndpoint(bridge, { name: 'studio-mac', capabilities: [] })
    await expect(exposed.call('session/list', { args: { _request: {} } })).resolves.toEqual({
      ok: true,
      value: { forwarded: 'session/list' },
    })
    expect(bridge.calls).toEqual([{ endpoint: 'session/list', payload: { args: { _request: {} } } }])
  })
})
