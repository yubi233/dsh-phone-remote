import { PROTOCOL_VERSION } from '@dsh-web-remote/protocol'

/** Configuration for relay registration and host pairing HTTP calls. */
export interface PairingConfig {
  /** Relay HTTP origin, for example `https://relay.example`. */
  relayHttpUrl: string
  /** Stable Host identity minted by this Host. */
  hostId: string
  /** Long-lived secret the relay uses to authenticate the Host. */
  hostSecret: string
  /** Human-readable Host name shown during pairing. */
  hostName: string
  /** Browser pairing page base URL; the pairing query is appended verbatim. */
  pairingUrlBase?: string
  /** Wire protocol revision; defaults to {@link PROTOCOL_VERSION}. */
  protocolVersion?: number
  /** Fetch implementation, primarily for tests. */
  fetchImpl?: typeof fetch
  /**
   * Value sent as `x-registration-token` when the relay requires one
   * (`RELAY_REGISTRATION_TOKEN` on public deployments). Optional.
   */
  registrationToken?: string
}

/** One device the relay has paired with this Host. */
export interface DeviceRecord {
  /** Relay-minted device identity. */
  deviceId: string
  /** Device name supplied during pairing. */
  name?: string
  /** Device platform label supplied during pairing. */
  platform?: string
  /** Creation timestamp in epoch milliseconds. */
  createdAt: number
  /** Last observed timestamp in epoch milliseconds. */
  lastSeenAt: number
  /** Whether the device currently has a live relay connection. */
  online: boolean
}

/** Host credential returned by relay registration. */
export interface RegisteredHost {
  /** Bearer token for relay HTTP and WebSocket authentication. */
  hostToken: string
  /** Token expiry in epoch milliseconds. */
  expiresAt: number
}

/** One-time pairing offer returned to the Host. */
export interface PairingOffer {
  /** One-time token embedded in the pairing URL. */
  pairToken: string
  /** Short code a person can enter manually. */
  pairingCode: string
  /** Offer expiry in epoch milliseconds. */
  expiresAt: number
  /** Pairing page URL, present when `pairingUrlBase` is configured. */
  url?: string
}

interface HttpResult {
  status: number
  ok: boolean
  body: unknown
}

/**
 * Relay HTTP client for host registration, pairing, and device management.
 *
 * A live host token is cached and reused. A 401 on an authenticated request
 * invalidates the cache, registers once more, and retries the request once.
 */
export class PairingClient {
  readonly #relayHttpUrl: string
  readonly #hostId: string
  readonly #hostSecret: string
  readonly #hostName: string
  readonly #pairingUrlBase: string | undefined
  readonly #protocolVersion: number
  readonly #registrationToken: string | undefined
  readonly #fetchImpl: typeof fetch
  #token: RegisteredHost | undefined
  #registering: Promise<RegisteredHost> | undefined

  constructor(config: PairingConfig) {
    this.#relayHttpUrl = requireConfigString(config.relayHttpUrl, 'relayHttpUrl').replace(/\/+$/, '')
    this.#hostId = requireConfigString(config.hostId, 'hostId')
    this.#hostSecret = requireConfigString(config.hostSecret, 'hostSecret')
    this.#hostName = requireConfigString(config.hostName, 'hostName')
    this.#pairingUrlBase =
      config.pairingUrlBase === undefined
        ? undefined
        : requireConfigString(config.pairingUrlBase, 'pairingUrlBase')
    const protocolVersion = config.protocolVersion ?? PROTOCOL_VERSION
    if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 1) {
      throw new Error('protocolVersion must be an integer >= 1')
    }
    this.#protocolVersion = protocolVersion
    this.#registrationToken = config.registrationToken
    this.#fetchImpl =
      config.fetchImpl ??
      ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => fetch(input, init))
  }

  /**
   * Register this Host, or return the cached token while it is still live.
   *
   * @param now Clock value used to test token liveness; defaults to `Date.now()`.
   * @returns The host token and its expiry.
   */
  async register(now: number = Date.now()): Promise<RegisteredHost> {
    const cached = this.#token
    if (cached !== undefined && cached.expiresAt > now) return cached
    if (this.#registering !== undefined) return this.#registering
    const pending = this.#registerNow()
    this.#registering = pending
    try {
      return await pending
    } finally {
      if (this.#registering === pending) this.#registering = undefined
    }
  }

  /**
   * Drop the cached host token after the relay rejected it (restart or lost
   * store). The next {@link register} exchanges the long-lived secret again.
   */
  invalidate(): void {
    this.#token = undefined
  }

  /**
   * Mint a one-time pairing offer.
   *
   * @returns The pairing token, display code, expiry, and URL when configured.
   */
  async createPairing(): Promise<PairingOffer> {
    const { body, status } = await this.#authorizedRequest(`/v1/hosts/${encodeURIComponent(this.#hostId)}/pairing`, {
      method: 'POST',
    })
    const record = requireResponseRecord(body, status, 'pairing response')
    const pairToken = requireResponseString(record.pairToken, 'pairToken', status)
    const pairingCode = requireResponseString(record.pairingCode, 'pairingCode', status)
    const expiresAt = requireResponseTimestamp(record.expiresAt, 'expiresAt', status)
    const url = this.#pairingUrl(pairToken)
    return { pairToken, pairingCode, expiresAt, ...(url === undefined ? {} : { url }) }
  }

  /**
   * List devices paired with this Host.
   *
   * @returns Validated device records in relay order.
   */
  async listDevices(): Promise<DeviceRecord[]> {
    const { body, status } = await this.#authorizedRequest(
      `/v1/hosts/${encodeURIComponent(this.#hostId)}/devices`,
      { method: 'GET' },
    )
    const record = requireResponseRecord(body, status, 'device list response')
    const devices = record.devices
    if (!Array.isArray(devices)) {
      throw invalidResponse(status, 'devices must be an array')
    }
    return devices.map((item, index) => validateDevice(item, status, index))
  }

  /**
   * Revoke one paired device.
   *
   * @param deviceId Relay-minted device identity to revoke.
   */
  async revokeDevice(deviceId: string): Promise<void> {
    if (deviceId.length === 0) throw new Error('deviceId must be a non-empty string')
    const { body, status } = await this.#authorizedRequest(
      `/v1/hosts/${encodeURIComponent(this.#hostId)}/devices/${encodeURIComponent(deviceId)}/revoke`,
      { method: 'POST' },
    )
    const record = requireResponseRecord(body, status, 'revoke response')
    if (record.revoked !== true) {
      throw invalidResponse(status, 'revoked must be true')
    }
  }

  async #registerNow(): Promise<RegisteredHost> {
    const result = await this.#send(this.#url('/v1/hosts/register'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.#registrationToken === undefined
          ? {}
          : { 'x-registration-token': this.#registrationToken }),
      },
      body: JSON.stringify({
        hostId: this.#hostId,
        hostSecret: this.#hostSecret,
        hostName: this.#hostName,
        protocolVersion: this.#protocolVersion,
      }),
    })
    if (!result.ok) throw httpFailure(result.status, result.body)
    const record = requireResponseRecord(result.body, result.status, 'register response')
    const hostToken = requireResponseString(record.hostToken, 'hostToken', result.status)
    const expiresAt = requireResponseTimestamp(record.expiresAt, 'expiresAt', result.status)
    const token: RegisteredHost = { hostToken, expiresAt }
    this.#token = token
    return token
  }

  async #authorizedRequest(path: string, init: RequestInit): Promise<{ body: unknown; status: number }> {
    let token = await this.register()
    let result = await this.#sendAuthorized(path, init, token.hostToken)
    if (result.status === 401) {
      this.#token = undefined
      token = await this.register()
      result = await this.#sendAuthorized(path, init, token.hostToken)
    }
    if (!result.ok) throw httpFailure(result.status, result.body)
    return { body: result.body, status: result.status }
  }

  async #sendAuthorized(path: string, init: RequestInit, hostToken: string): Promise<HttpResult> {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${hostToken}`)
    return await this.#send(this.#url(path), { ...init, headers })
  }

  async #send(url: string, init: RequestInit): Promise<HttpResult> {
    // A hung relay must not hold the Host's connect flow forever; the socket
    // retry handles the transport, this only bounds the HTTP exchange.
    const signal = init.signal ?? AbortSignal.timeout(RELAY_HTTP_TIMEOUT_MS)
    const response = await this.#fetchImpl(url, { ...init, signal })
    const text = await response.text()
    let body: unknown
    if (text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(`relay returned invalid JSON (${response.status})`)
      }
    }
    return { status: response.status, ok: response.ok, body }
  }

  #url(path: string): string {
    return `${this.#relayHttpUrl}${path}`
  }

  #pairingUrl(pairToken: string): string | undefined {
    if (this.#pairingUrlBase === undefined) return undefined
    const query = [
      // hostId is config-owned but may contain reserved characters; an unencoded
      // '&' or '=' would truncate or inject query parameters.
      `host=${encodeURIComponent(this.#hostId)}`,
      `pair=${pairToken}`,
      `name=${encodeURIComponent(this.#hostName)}`,
      `v=${this.#protocolVersion}`,
    ].join('&')
    return `${this.#pairingUrlBase}?${query}`
  }
}

/** Bound on one relay HTTP exchange. */
const RELAY_HTTP_TIMEOUT_MS = 30_000

function validateDevice(value: unknown, status: number, index: number): DeviceRecord {
  const record = requireResponseRecord(value, status, `devices[${index}]`)
  const deviceId = requireResponseString(record.deviceId, `devices[${index}].deviceId`, status)
  const name = optionalResponseString(record.name, `devices[${index}].name`, status)
  const platform = optionalResponseString(record.platform, `devices[${index}].platform`, status)
  const createdAt = requireResponseTimestamp(record.createdAt, `devices[${index}].createdAt`, status)
  const lastSeenAt = requireResponseTimestamp(record.lastSeenAt, `devices[${index}].lastSeenAt`, status)
  if (typeof record.online !== 'boolean') {
    throw invalidResponse(status, `devices[${index}].online must be a boolean`)
  }
  return {
    deviceId,
    ...(name === undefined ? {} : { name }),
    ...(platform === undefined ? {} : { platform }),
    createdAt,
    lastSeenAt,
    online: record.online,
  }
}

function requireConfigString(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireResponseRecord(
  value: unknown,
  status: number,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponse(status, `${label} must be an object`)
  return value
}

function requireResponseString(value: unknown, field: string, status: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidResponse(status, `${field} must be a non-empty string`)
  }
  return value
}

function optionalResponseString(value: unknown, field: string, status: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidResponse(status, `${field} must be a string`)
  return value
}

function requireResponseTimestamp(value: unknown, field: string, status: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalidResponse(status, `${field} must be a non-negative number`)
  }
  return value
}

function invalidResponse(status: number, detail: string): Error {
  return new Error(`relay returned an invalid response (${status}): ${detail}`)
}

function httpFailure(status: number, body: unknown): Error {
  return new Error(`relay request failed with status ${status} (${relayErrorCode(body)})`)
}

function relayErrorCode(body: unknown): string {
  if (isRecord(body)) {
    if (typeof body.code === 'string' && body.code.length > 0) return body.code
    if (isRecord(body.error) && typeof body.error.code === 'string' && body.error.code.length > 0) {
      return body.error.code
    }
  }
  return 'HTTP_ERROR'
}
