import type { HostBridge, HostRpcResult } from './bridge.ts'

/** DSH `workspaceChanges` service members used by the phone endpoints. */
export interface WorkspaceChangesLike {
  summary(sessionId: string, seq: number): unknown
  diff(sessionId: string, seq: number, index: number, signal: AbortSignal): Promise<unknown>
}

/** Optional changed-file service; absent when the deployment omits the plugin. */
export interface ChangesEndpointOptions {
  workspaceChanges?: WorkspaceChangesLike
}

/**
 * Expose per-turn changed-file summaries and comparisons to the relay.
 *
 * DSH serves these through exact Fetch routes (`/api/changes.summary` and
 * `/api/changes.diff`), which the relay does not proxy. These local endpoints
 * wrap the same service so the phone can review a turn over RPC.
 */
export function withChangesEndpoints(bridge: HostBridge, options: ChangesEndpointOptions): HostBridge {
  return {
    call(endpoint, payload, signal) {
      if (endpoint === 'remote/changes/summary') return changesSummary(options, payload)
      if (endpoint === 'remote/changes/diff') return changesDiff(options, payload, signal)
      return bridge.call(endpoint, payload, signal)
    },
    open(endpoint, payload, uplink, signal) {
      return bridge.open(endpoint, payload, uplink, signal)
    },
  }
}

async function changesSummary(
  options: ChangesEndpointOptions,
  payload: unknown,
): Promise<HostRpcResult> {
  const request = requestOf(payload)
  const sessionId = request['sessionId']
  const seq = request['seq']
  if (typeof sessionId !== 'string' || sessionId === '' || !validSeq(seq)) {
    return failure('changes/invalid-request', 'remote/changes/summary requires sessionId and seq')
  }
  const service = options.workspaceChanges
  if (service === undefined) return { ok: true, value: null }
  try {
    const summary = service.summary(sessionId, seq)
    return { ok: true, value: summary === undefined ? null : summaryView(summary) }
  } catch (error) {
    return failure('changes/summary-failed', messageOf(error))
  }
}

async function changesDiff(
  options: ChangesEndpointOptions,
  payload: unknown,
  signal?: AbortSignal,
): Promise<HostRpcResult> {
  const request = requestOf(payload)
  const sessionId = request['sessionId']
  const seq = request['seq']
  const index = request['index']
  if (
    typeof sessionId !== 'string'
    || sessionId === ''
    || !validSeq(seq)
    || !Number.isSafeInteger(index)
    || (index as number) < 0
  ) {
    return failure('changes/invalid-request', 'remote/changes/diff requires sessionId, seq, and index')
  }
  const service = options.workspaceChanges
  if (service === undefined) return { ok: true, value: null }
  try {
    const diff = await service.diff(sessionId, seq, index as number, signal ?? new AbortController().signal)
    return { ok: true, value: diff === undefined ? null : diff }
  } catch (error) {
    return failure('changes/diff-failed', messageOf(error))
  }
}

/** Strip Host-only snapshot identity and working directory from one summary. */
function summaryView(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return {
    turn: record['turn'],
    files: record['files'],
    total: record['total'],
    added: record['added'],
    deleted: record['deleted'],
  }
}

function requestOf(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return {}
  const args = (payload as Record<string, unknown>)['args']
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return {}
  const request = (args as Record<string, unknown>)['request']
  return typeof request === 'object' && request !== null && !Array.isArray(request)
    ? (request as Record<string, unknown>)
    : {}
}

function validSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function failure(code: string, message: string): HostRpcResult {
  return { ok: false, error: { code, message } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
