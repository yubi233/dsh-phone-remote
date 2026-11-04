import { describe, expect, it } from 'vitest'
import { withDeviceEndpoints } from '../src/device-endpoints.ts'
import type { DeviceController } from '../src/device-endpoints.ts'
import type { HostBridge } from '../src/bridge.ts'
import type { DeviceRecord } from '../src/pairing.ts'

const DEVICE: DeviceRecord = {
  deviceId: 'd1',
  name: 'phone',
  platform: 'browser',
  createdAt: 100,
  lastSeenAt: 200,
  online: true,
}

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

function controller(overrides: Partial<DeviceController> = {}): DeviceController & {
  revoked: string[]
} {
  const revoked: string[] = []
  return {
    revoked,
    listDevices: async () => [DEVICE],
    revokeDevice: async (deviceId) => {
      revoked.push(deviceId)
    },
    ...overrides,
  }
}

describe('withDeviceEndpoints', () => {
  it('lists paired devices without reaching the Gateway', async () => {
    const bridge = baseBridge()
    const devices = controller()
    const exposed = withDeviceEndpoints(bridge, devices)
    await expect(exposed.call('remote/devices/list', { args: {} })).resolves.toEqual({
      ok: true,
      value: { devices: [DEVICE] },
    })
    expect(bridge.calls).toEqual([])
  })

  it('revokes the requested device from the nested args envelope', async () => {
    const devices = controller()
    const exposed = withDeviceEndpoints(baseBridge(), devices)
    await expect(
      exposed.call('remote/devices/revoke', { args: { request: { deviceId: 'd1' } } }),
    ).resolves.toEqual({ ok: true, value: { revoked: true } })
    expect(devices.revoked).toEqual(['d1'])
  })

  it('rejects a missing device id without calling the controller', async () => {
    const devices = controller()
    const exposed = withDeviceEndpoints(baseBridge(), devices)
    await expect(exposed.call('remote/devices/revoke', { args: { request: {} } })).resolves.toEqual({
      ok: false,
      error: { code: 'devices/invalid-request', message: expect.any(String) },
    })
    expect(devices.revoked).toEqual([])
  })

  it('maps controller failures to a structured device error', async () => {
    const exposed = withDeviceEndpoints(
      baseBridge(),
      controller({
        revokeDevice: async () => {
          throw new Error('relay rejected the revoke')
        },
      }),
    )
    await expect(
      exposed.call('remote/devices/revoke', { args: { request: { deviceId: 'd1' } } }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'devices/revoke-failed', message: 'relay rejected the revoke' },
    })
  })

  it('forwards every other endpoint to the Gateway bridge', async () => {
    const bridge = baseBridge()
    const exposed = withDeviceEndpoints(bridge, controller())
    await expect(exposed.call('session/list', { args: { _request: {} } })).resolves.toEqual({
      ok: true,
      value: { forwarded: 'session/list' },
    })
    expect(bridge.calls).toEqual([{ endpoint: 'session/list', payload: { args: { _request: {} } } }])
  })
})
