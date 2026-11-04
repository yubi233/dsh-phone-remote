import type { HostBridge, HostRpcResult } from './bridge.ts'
import type { DeviceRecord } from './pairing.ts'

/** Device operations the Host owns outside the DSH Remote endpoint set. */
export interface DeviceController {
  /** List devices paired with this Host. */
  listDevices(): Promise<DeviceRecord[]>
  /** Revoke one paired device. */
  revokeDevice(deviceId: string): Promise<void>
}

/**
 * Add phone-reachable device management to a Host bridge.
 *
 * DSH has no Remote endpoint for relay device credentials, so these two
 * endpoints are answered by the Host plugin before the bridge forwards
 * everything else to the DSH Gateway.
 *
 * @param bridge - Gateway-backed bridge used for every other endpoint.
 * @param devices - Host-owned paired-device operations.
 * @returns A bridge that also serves `remote/devices/list` and
 *   `remote/devices/revoke`.
 */
export function withDeviceEndpoints(bridge: HostBridge, devices: DeviceController): HostBridge {
  return {
    call(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<HostRpcResult> {
      if (endpoint === 'remote/devices/list') return listDevices(devices)
      if (endpoint === 'remote/devices/revoke') return revokeDevice(devices, payload)
      return bridge.call(endpoint, payload, signal)
    },
    open: (endpoint, payload, uplink, signal) => bridge.open(endpoint, payload, uplink, signal),
  }
}

async function listDevices(devices: DeviceController): Promise<HostRpcResult> {
  try {
    return { ok: true, value: { devices: await devices.listDevices() } }
  } catch (error) {
    return failure('devices/list-failed', messageOf(error))
  }
}

async function revokeDevice(devices: DeviceController, payload: unknown): Promise<HostRpcResult> {
  const request = requestOf(payload)
  const deviceId = request['deviceId']
  if (typeof deviceId !== 'string' || deviceId.trim() === '') {
    return failure('devices/invalid-request', 'remote/devices/revoke requires a deviceId')
  }
  try {
    await devices.revokeDevice(deviceId)
    return { ok: true, value: { revoked: true } }
  } catch (error) {
    return failure('devices/revoke-failed', messageOf(error))
  }
}

function requestOf(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) return {}
  const args = (payload as { args?: unknown }).args
  if (typeof args !== 'object' || args === null) return {}
  const request = (args as { request?: unknown }).request
  return typeof request === 'object' && request !== null ? (request as Record<string, unknown>) : {}
}

function failure(code: string, message: string): HostRpcResult {
  return { ok: false, error: { code, message } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
