import type { HostBridge, HostRpcResult } from './bridge.ts'
import type {
  SessionMarkReadRequest,
  SessionMarkReadValue,
  SessionUnreadBaselinesValue,
} from './unread.ts'

/** Unread operations exposed to the phone. */
export interface UnreadEndpointController {
  baselines(): Promise<SessionUnreadBaselinesValue>
  markRead(request: SessionMarkReadRequest): Promise<SessionMarkReadValue>
}

/**
 * Add phone-facing unread endpoints to a Host bridge.
 *
 * `remote/unread/baselines` lists durable read cursors; `remote/unread/markRead`
 * applies compare-and-clear. Both are answered by the Host plugin and never
 * forwarded to the DSH Gateway.
 *
 * @param bridge - Gateway-backed bridge used for every other endpoint.
 * @param unread - projection and storage owner.
 * @returns A bridge that also serves the unread endpoints.
 */
export function withUnreadEndpoints(bridge: HostBridge, unread: UnreadEndpointController): HostBridge {
  return {
    call(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<HostRpcResult> {
      if (endpoint === 'remote/unread/baselines') return baselines(unread)
      if (endpoint === 'remote/unread/markRead') return markRead(unread, payload)
      return bridge.call(endpoint, payload, signal)
    },
    open: (endpoint, payload, uplink, signal) => bridge.open(endpoint, payload, uplink, signal),
  }
}

async function baselines(unread: UnreadEndpointController): Promise<HostRpcResult> {
  try {
    return { ok: true, value: await unread.baselines() }
  } catch (error) {
    return failure('unread/baselines-failed', messageOf(error))
  }
}

async function markRead(unread: UnreadEndpointController, payload: unknown): Promise<HostRpcResult> {
  const request = requestOf(payload)
  if (request === undefined) {
    return failure('unread/invalid-request', 'remote/unread/markRead requires a sessionId and expectedUnreadAt')
  }
  try {
    return { ok: true, value: await unread.markRead(request) }
  } catch (error) {
    return failure('unread/mark-read-failed', messageOf(error))
  }
}

function requestOf(payload: unknown): SessionMarkReadRequest | undefined {
  if (!isRecord(payload) || !isRecord(payload['args']) || !isRecord(payload['args']['request'])) {
    return undefined
  }
  const request = payload['args']['request']
  const sessionId = request['sessionId']
  const expectedUnreadAt = request['expectedUnreadAt']
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  if (expectedUnreadAt !== null
    && (typeof expectedUnreadAt !== 'number' || !Number.isFinite(expectedUnreadAt))) {
    return undefined
  }
  return { sessionId, expectedUnreadAt }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function failure(code: string, message: string): HostRpcResult {
  return { ok: false, error: { code, message } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
