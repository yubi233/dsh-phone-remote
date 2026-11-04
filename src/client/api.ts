/**
 * Same-origin console API client for the DSH web GUI panel.
 *
 * All requests go to the Host half's `/api/web-remote/*` routes registered by
 * the plugin (see src/console.ts). Responses are validated before they reach
 * the UI; failures are normalized to {@link ConsoleApiError} with a
 * user-facing message.
 */

/** Console status snapshot (mirrors `RelayConsoleInfo`). */
export interface ConsoleStatus {
  configured: boolean
  state: string
  hostName: string
  relayHttpUrl?: string
  hostId?: string
  registrationTokenSet: boolean
  /** Present while the built-in LAN relay is serving the phone shell. */
  localRelay?: { lanUrl: string; port: number }
  lastError?: { code: string; message?: string }
}

/** One paired device (mirrors `DeviceRecord`). */
export interface ConsoleDevice {
  deviceId: string
  name?: string
  platform?: string
  createdAt: number
  lastSeenAt: number
  online: boolean
}

/** One one-time pairing offer (mirrors `PairingOffer`). */
export interface ConsolePairing {
  pairToken: string
  pairingCode: string
  expiresAt: number
  url?: string
}

/** A console failure with its user-facing message. */
export class ConsoleApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ConsoleApiError'
  }
}

/** Relay setup input for `POST /api/web-remote/relay`. */
export interface RelaySetupInput {
  readonly relayHttpUrl: string
  readonly registrationToken?: string
}

/** Read the current console status snapshot. */
export async function fetchConsoleStatus(): Promise<ConsoleStatus> {
  return await request('/api/web-remote/status', parseStatus)
}

/** Apply a relay setup; rejects with the relay's rejection reason. */
export async function setupRelay(input: RelaySetupInput): Promise<void> {
  await request('/api/web-remote/relay', (value) => {
    if (typeof value !== 'object' || value === null) {
      throw new ConsoleApiError('response', '本机服务返回异常响应')
    }
    return undefined
  }, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      relayHttpUrl: input.relayHttpUrl,
      ...(input.registrationToken === undefined || input.registrationToken === ''
        ? {}
        : { registrationToken: input.registrationToken }),
    }),
  })
}

/** Mint a fresh one-time pairing offer (invalidates nothing by itself). */
export async function createConsolePairing(): Promise<ConsolePairing> {
  return await request('/api/web-remote/pairing', parsePairing, { method: 'POST' })
}

/** List the devices paired with this Host. */
export async function fetchConsoleDevices(): Promise<ConsoleDevice[]> {
  return await request('/api/web-remote/devices', (value) => {
    if (typeof value !== 'object' || value === null || !Array.isArray((value as { devices?: unknown }).devices)) {
      throw new ConsoleApiError('response', '本机服务返回异常响应')
    }
    return (value as { devices: unknown[] }).devices.map(parseDevice)
  })
}

/** Revoke one paired device. */
export async function revokeConsoleDevice(deviceId: string): Promise<void> {
  await request(`/api/web-remote/devices/${encodeURIComponent(deviceId)}/revoke`, () => undefined, {
    method: 'POST',
  })
}

/** Map any thrown value to a user-facing zh message. */
export function describeApiError(error: unknown): string {
  if (error instanceof ConsoleApiError) return error.message
  return '发生未知错误，请重试'
}

/** One JSON request against the console routes, validated and error-mapped. */
async function request<T>(
  path: string,
  validate: (value: unknown) => T,
  init: RequestInit = {},
): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { ...init, headers: { ...init.headers } })
  } catch {
    throw new ConsoleApiError('network', '无法访问本机服务：请确认 DSH 正在运行')
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ConsoleApiError('response', '本机服务返回异常响应')
  }
  if (!response.ok) {
    throw new ConsoleApiError(
      errorCodeOf(body),
      errorMessageOf(body) ?? `请求失败（HTTP ${response.status}）`,
    )
  }
  return validate(body)
}

function parseStatus(value: unknown): ConsoleStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConsoleApiError('response', '本机服务返回异常响应')
  }
  const record = value as Record<string, unknown>
  if (typeof record['configured'] !== 'boolean' || typeof record['state'] !== 'string' || typeof record['hostName'] !== 'string') {
    throw new ConsoleApiError('response', '本机服务返回异常响应')
  }
  const lastError = record['lastError']
  return {
    configured: record['configured'],
    state: record['state'],
    hostName: record['hostName'],
    ...(typeof record['relayHttpUrl'] === 'string' ? { relayHttpUrl: record['relayHttpUrl'] as string } : {}),
    ...(typeof record['hostId'] === 'string' ? { hostId: record['hostId'] as string } : {}),
    registrationTokenSet: record['registrationTokenSet'] === true,
    ...(typeof record['localRelay'] === 'object' && record['localRelay'] !== null
      ? { localRelay: parseLocalRelay(record['localRelay']) }
      : {}),
    ...(typeof lastError === 'object' && lastError !== null
      ? { lastError: lastError as { code: string; message?: string } }
      : {}),
  }
}

function parseLocalRelay(value: unknown): { lanUrl: string; port: number } {
  const record = value as Record<string, unknown>
  if (typeof record['lanUrl'] !== 'string' || typeof record['port'] !== 'number') {
    throw new ConsoleApiError('response', '本机服务返回异常响应')
  }
  return { lanUrl: record['lanUrl'], port: record['port'] }
}

/** Start (or restart) the built-in LAN relay and switch the Host onto it. */
export async function startLocalRelay(port?: number): Promise<{ lanUrl: string; port: number }> {
  return await request('/api/web-remote/local', (value) => {
    const relay = (value as { localRelay?: unknown } | null)?.localRelay
    return parseLocalRelay(relay)
  }, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(port === undefined ? {} : { port }),
  })
}

function parsePairing(value: unknown): ConsolePairing {
  if (typeof value !== 'object' || value === null) {
    throw new ConsoleApiError('response', '本机服务返回异常响应')
  }
  const record = value as Record<string, unknown>
  const pairToken = record['pairToken']
  const pairingCode = record['pairingCode']
  const expiresAt = record['expiresAt']
  if (typeof pairToken !== 'string' || typeof pairingCode !== 'string' || typeof expiresAt !== 'number') {
    throw new ConsoleApiError('response', '本机服务返回异常响应')
  }
  return {
    pairToken,
    pairingCode,
    expiresAt,
    ...(typeof record['url'] === 'string' ? { url: record['url'] as string } : {}),
  }
}

function parseDevice(value: unknown, index: number = 0): ConsoleDevice {
  if (typeof value !== 'object' || value === null) {
    throw new ConsoleApiError('response', '本机服务返回异常响应')
  }
  const record = value as Record<string, unknown>
  const deviceId = record['deviceId']
  const createdAt = record['createdAt']
  const lastSeenAt = record['lastSeenAt']
  if (typeof deviceId !== 'string' || typeof createdAt !== 'number' || typeof lastSeenAt !== 'number') {
    throw new ConsoleApiError('response', `设备列表第 ${index + 1} 项格式异常`)
  }
  return {
    deviceId,
    ...(typeof record['name'] === 'string' ? { name: record['name'] as string } : {}),
    ...(typeof record['platform'] === 'string' ? { platform: record['platform'] as string } : {}),
    createdAt,
    lastSeenAt,
    online: record['online'] === true,
  }
}

function errorCodeOf(body: unknown): string {
  const error = (body as { error?: { code?: unknown } } | null)?.error
  return typeof error?.code === 'string' ? error.code : 'http'
}

function errorMessageOf(body: unknown): string | undefined {
  const error = (body as { error?: { message?: unknown } } | null)?.error
  return typeof error?.message === 'string' && error.message !== '' ? error.message : undefined
}
