import { describe, expect, it } from 'vitest'
import type { HostBridge, HostRpcResult } from '../src/bridge.ts'
import {
  DEFAULT_MEMORY_BUDGET_BYTES,
  HOST_MEMORY_ENDPOINT,
  HOST_RESTART_ENDPOINT,
  withHealthEndpoints,
} from '../src/health-endpoints.ts'

function innerBridge(): HostBridge {
  return {
    async call(): Promise<HostRpcResult> {
      return { ok: true, value: 'inner' }
    },
    open() {
      return (async function* (): AsyncGenerator<unknown> {})()
    },
  }
}

const sample = {
  rss: 1_234_567,
  heapUsed: 500_000,
  heapTotal: 800_000,
  external: 40_000,
  systemTotal: 16_000_000_000,
  systemFree: 6_000_000_000,
  uptimeSec: 3600,
  sampledAt: 1_700_000_000_000,
}

describe('withHealthEndpoints', () => {
  it('serves the memory sample with the configured budget', async () => {
    const bridge = withHealthEndpoints(innerBridge(), { sample: () => sample })
    const result = await bridge.call(HOST_MEMORY_ENDPOINT, { args: {} })
    expect(result).toEqual({
      ok: true,
      value: { ...sample, budgetBytes: DEFAULT_MEMORY_BUDGET_BYTES, restartAvailable: false },
    })

    const narrowed = withHealthEndpoints(innerBridge(), {
      sample: () => sample,
      memoryBudgetBytes: 1024,
      restart: { command: 'launchctl' },
    })
    const tiny = await narrowed.call(HOST_MEMORY_ENDPOINT, { args: {} })
    expect(tiny).toMatchObject({ ok: true, value: { budgetBytes: 1024, restartAvailable: true } })
  })

  it('rejects malformed samples instead of leaking NaN to the phone', async () => {
    const bridge = withHealthEndpoints(innerBridge(), {
      sample: () => ({ ...sample, rss: Number.NaN }),
    })
    await expect(bridge.call(HOST_MEMORY_ENDPOINT, { args: {} })).resolves.toMatchObject({
      ok: false,
      error: { code: 'host/memory-invalid' },
    })
    const negative = withHealthEndpoints(innerBridge(), {
      sample: () => ({ ...sample, heapUsed: -1 }),
    })
    await expect(negative.call(HOST_MEMORY_ENDPOINT, { args: {} })).resolves.toMatchObject({
      ok: false,
      error: { code: 'host/memory-invalid' },
    })
  })

  it('reports restart-unavailable when no command is configured', async () => {
    const bridge = withHealthEndpoints(innerBridge())
    await expect(bridge.call(HOST_RESTART_ENDPOINT, { args: {} })).resolves.toMatchObject({
      ok: false,
      error: { code: 'host/restart-unavailable' },
    })
  })

  it('schedules the configured command exactly once', async () => {
    const scheduled: { command: string; args?: readonly string[] }[] = []
    const bridge = withHealthEndpoints(innerBridge(), {
      restart: { command: 'launchctl', args: ['kickstart', '-k', 'gui/501/label'] },
      restartDelayMs: 0,
      scheduleRestart: (command) => scheduled.push(command),
    })
    const first = await bridge.call(HOST_RESTART_ENDPOINT, { args: {} })
    const second = await bridge.call(HOST_RESTART_ENDPOINT, { args: {} })
    expect(first).toEqual({ ok: true, value: { accepted: true } })
    expect(second).toEqual({ ok: true, value: { accepted: true } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(scheduled).toEqual([{ command: 'launchctl', args: ['kickstart', '-k', 'gui/501/label'] }])
  })

  it('rejects unsafe restart configuration at construction', () => {
    expect(() => withHealthEndpoints(innerBridge(), { restart: { command: '  ' } })).toThrow(
      /restart\.command/,
    )
    expect(() =>
      withHealthEndpoints(innerBridge(), { restart: { command: 'sh', args: ['-c', 'x\u0000y'] } }),
    ).toThrow(/restart\.args/)
    expect(() => withHealthEndpoints(innerBridge(), { memoryBudgetBytes: 0 })).toThrow(
      /memoryBudgetBytes/,
    )
  })

  it('forwards unrelated endpoints to the inner bridge', async () => {
    const bridge = withHealthEndpoints(innerBridge())
    await expect(bridge.call('session/list', {})).resolves.toEqual({ ok: true, value: 'inner' })
  })
})
