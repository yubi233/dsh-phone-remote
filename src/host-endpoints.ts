import type { HostBridge, HostRpcResult } from './bridge.ts'

/** Identity the Host advertises to a paired phone. */
export interface HostInfo {
  /** Human-readable machine name from the Host plugin config. */
  name: string
  /** Host build version, when configured. */
  version?: string
  /** Capability tags advertised by the Host. */
  capabilities: string[]
}

/**
 * Add the Host identity endpoint to a Host bridge.
 *
 * DSH's Remote surface does not expose the relay-side host name, so the phone
 * would otherwise show only the host-id prefix. The value is static config and
 * safe to serve to an already paired owner.
 *
 * @param bridge - Gateway-backed bridge used for every other endpoint.
 * @param info - Host name, version, and capability tags from config.
 * @returns A bridge that also serves `remote/hostInfo`.
 */
export function withHostInfoEndpoint(bridge: HostBridge, info: HostInfo): HostBridge {
  return {
    call(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<HostRpcResult> {
      if (endpoint === 'remote/hostInfo') {
        return Promise.resolve({ ok: true, value: { ...info, capabilities: [...info.capabilities] } })
      }
      return bridge.call(endpoint, payload, signal)
    },
    open: (endpoint, payload, uplink, signal) => bridge.open(endpoint, payload, uplink, signal),
  }
}
