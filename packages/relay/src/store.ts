/**
 * Relay persistence abstraction and its in-memory implementation.
 *
 * Secrets and bearer tokens are hashed with SHA-256 before storage; only the
 * one-time plaintext returned by the issuing method ever leaves this module.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { KICK_CONFLICT_WINDOW_MS } from '@dsh-web-remote/protocol'
import { asDeviceId, asHostId, asDeviceToken, asHostToken, asPairToken } from '@dsh-web-remote/protocol'
import type { DeviceId, DeviceToken, HostId, HostToken, PairToken } from '@dsh-web-remote/protocol'

/** Default lifetime of a relay-issued host token: one hour. */
export const DEFAULT_HOST_TOKEN_TTL_MS = 60 * 60 * 1000

/** Secret-free view of a registered host. */
export interface RelayHostInfo {
  readonly hostId: HostId
  readonly name: string
  readonly createdAt: number
  readonly lastSeenAt: number
  readonly revokedAt?: number
}

/** Token-free view of a paired device. */
export interface RelayDeviceInfo {
  readonly deviceId: DeviceId
  readonly name?: string
  readonly platform?: string
  readonly createdAt: number
  readonly lastSeenAt: number
}

/** Input for {@link RelayStore.registerHost}. */
export interface RegisterHostInput {
  readonly hostId: HostId
  readonly hostSecret: string
  readonly hostName: string
}

/** Outcome of host registration; a mismatched secret never replaces a host. */
export type RegisterHostResult =
  | { readonly ok: true; readonly host: RelayHostInfo }
  | { readonly ok: false; readonly code: 'AUTH_FAILED' }

/** A freshly issued host bearer token and its absolute expiry. */
export interface IssuedHostToken {
  readonly token: HostToken
  readonly expiresAt: number
}

/** Options for minting a one-time pairing token. */
export interface CreatePairingOptions {
  /** Lifetime of the pairing token in milliseconds. */
  readonly ttlMs: number
}

/** A one-time pairing token together with the human-readable pairing code. */
export interface CreatedPairing {
  readonly pairToken: PairToken
  readonly pairingCode: string
  readonly expiresAt: number
}

/** Input for {@link RelayStore.claimPairing}. */
export interface ClaimPairingInput {
  readonly hostId: HostId
  readonly pairToken: PairToken
  readonly deviceName?: string
  readonly platform?: string
}

/** Why a pairing claim failed. */
export type ClaimPairingFailure = 'invalid' | 'expired' | 'consumed'

/** Outcome of a pairing claim. The device token is returned exactly once. */
export type ClaimPairingResult =
  | {
      readonly ok: true
      readonly deviceId: DeviceId
      readonly deviceToken: DeviceToken
      readonly hostId: HostId
      readonly hostName: string
    }
  | { readonly ok: false; readonly code: ClaimPairingFailure }

/** The host and device a device bearer token authenticates. */
export interface AuthenticatedDevice {
  readonly hostId: HostId
  readonly deviceId: DeviceId
}

/**
 * Relay state needed to authenticate hosts, pair devices, and detect repeated
 * device takeovers. Implementations must never persist plaintext secrets or
 * tokens, and must treat consumed pairing tokens as unusable.
 */
export interface RelayStore {
  /**
   * Create a host, or renew an existing host whose secret hash matches.
   *
   * @param input - Host identity and secret supplied by the Host.
   * @returns The stored host view, or `AUTH_FAILED` when the id exists with a
   * different secret.
   */
  registerHost(input: RegisterHostInput): Promise<RegisterHostResult>

  /**
   * Mint a short-lived bearer token for a registered host.
   *
   * @param hostId - Host that will use the token.
   * @returns The plaintext token and expiry, or `undefined` if the host is
   * unknown or revoked.
   */
  issueHostToken(hostId: HostId): Promise<IssuedHostToken | undefined>

  /**
   * Resolve a host bearer token to its host.
   *
   * @param token - Plaintext token from the wire.
   * @returns The owning host id, or `undefined` when unknown, expired, or
   * revoked.
   */
  authenticateHostToken(token: HostToken): Promise<HostId | undefined>

  /**
   * Mint a single-use pairing token and its display code.
   *
   * @param hostId - Host the device will pair with.
   * @param options - Pairing token lifetime.
   * @returns The plaintext pairing token, or `undefined` if the host is
   * unknown or revoked.
   */
  createPairing(hostId: HostId, options: CreatePairingOptions): Promise<CreatedPairing | undefined>

  /**
   * Consume a pairing token and create the device credential.
   *
   * @param input - Host, pairing token, and optional device metadata.
   * @returns A new device identity and token, or the failure reason.
   */
  claimPairing(input: ClaimPairingInput): Promise<ClaimPairingResult>

  /**
   * Resolve a device bearer token to its host and device.
   *
   * @param token - Plaintext token from the wire.
   * @returns The authenticated device, or `undefined` when unknown, revoked,
   * or owned by a revoked host.
   */
  authenticateDeviceToken(token: DeviceToken): Promise<AuthenticatedDevice | undefined>

  /**
   * List a host's active (non-revoked) devices in creation order.
   *
   * @param hostId - Host whose devices are listed.
   * @returns Secret-free device views.
   */
  listDevices(hostId: HostId): Promise<RelayDeviceInfo[]>

  /**
   * Revoke a device and invalidate its token. Idempotent for a device that
   * belongs to the host.
   *
   * @param hostId - Owner host.
   * @param deviceId - Device to revoke.
   * @returns `true` when the device belongs to the host, `false` otherwise.
   */
  revokeDevice(hostId: HostId, deviceId: DeviceId): Promise<boolean>

  /**
   * Record activity on a host.
   *
   * @param hostId - Host that was seen.
   */
  touchHost(hostId: HostId): Promise<void>

  /**
   * Record activity on a device.
   *
   * @param deviceId - Device that was seen.
   */
  touchDevice(deviceId: DeviceId): Promise<void>

  /**
   * Record a device takeover and report whether it collides with a recent one.
   * A conflicting attempt is not recorded.
   *
   * @param hostId - Host whose device connection is being replaced.
   * @returns `true` when another takeover happened within
   * {@link KICK_CONFLICT_WINDOW_MS}; in that case the caller must reject the
   * newcomer instead of replacing the live connection.
   */
  noteTakeover(hostId: HostId): Promise<boolean>

  /**
   * Write any pending durable snapshot immediately. Optional: only stores
   * with persistence implement it. Call before process exit.
   */
  flush?(): void
}

/** Construction options for {@link MemoryRelayStore}. */
export interface MemoryRelayStoreOptions {
  /** Clock used for every timestamp and expiry check; defaults to `Date.now`. */
  readonly now?: () => number
  /** Host token lifetime in milliseconds; defaults to {@link DEFAULT_HOST_TOKEN_TTL_MS}. */
  readonly hostTokenTtlMs?: number
  /**
   * Durable snapshot sink. Only hashed secrets ever reach it, so a leaked
   * snapshot cannot be replayed as credentials. `load` runs once at
   * construction; `save` receives the debounced snapshot text.
   */
  readonly persistence?: RelayStorePersistence
  /** Debounce window for snapshot writes; defaults to 250ms. */
  readonly persistDelayMs?: number
}

/**
 * Durable snapshot sink for a relay store. Implementations must write
 * atomically (temp file + rename) so a crash never truncates the state.
 */
export interface RelayStorePersistence {
  load(): string | undefined
  save(snapshot: string): void
}

interface HostRecord {
  readonly hostId: HostId
  readonly secretHash: string
  name: string
  readonly createdAt: number
  lastSeenAt: number
  revokedAt?: number
}

interface DeviceRecord {
  readonly deviceId: DeviceId
  readonly hostId: HostId
  readonly tokenHash: string
  readonly name?: string
  readonly platform?: string
  readonly createdAt: number
  lastSeenAt: number
  revokedAt?: number
}

interface PairingRecord {
  readonly pairTokenHash: string
  readonly hostId: HostId
  readonly code: string
  readonly expiresAt: number
  consumedAt?: number
}

interface HostTokenRecord {
  readonly hostId: HostId
  readonly expiresAt: number
}

/**
 * Process-local relay store. State is lost when the process exits; production
 * deployments swap in a persistent {@link RelayStore}.
 */
export class MemoryRelayStore implements RelayStore {
  private readonly now: () => number
  private readonly hostTokenTtlMs: number
  private readonly persistence: RelayStorePersistence | undefined
  private readonly persistDelayMs: number
  private readonly hosts = new Map<string, HostRecord>()
  private readonly devices = new Map<string, DeviceRecord>()
  private readonly deviceTokens = new Map<string, string>()
  private readonly pairings = new Map<string, PairingRecord>()
  private readonly hostTokens = new Map<string, HostTokenRecord>()
  private readonly lastTakeovers = new Map<string, number>()
  #persistTimer: ReturnType<typeof setTimeout> | undefined
  #persistDirty = false

  /**
   * @param options - Clock, token lifetime, and optional durable persistence.
   */
  constructor(options: MemoryRelayStoreOptions = {}) {
    const ttl = options.hostTokenTtlMs ?? DEFAULT_HOST_TOKEN_TTL_MS
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new RangeError('hostTokenTtlMs must be a positive finite number')
    }
    this.now = options.now ?? Date.now
    this.hostTokenTtlMs = ttl
    this.persistence = options.persistence
    this.persistDelayMs = options.persistDelayMs ?? 250
    const snapshot = this.persistence?.load()
    if (snapshot !== undefined) this.#restore(snapshot)
  }

  /** Write any pending snapshot immediately; safe to call repeatedly. */
  flush(): void {
    if (this.#persistTimer !== undefined) {
      clearTimeout(this.#persistTimer)
      this.#persistTimer = undefined
    }
    if (!this.#persistDirty) return
    this.#persistDirty = false
    this.persistence?.save(this.#snapshot())
  }

  #schedulePersist(): void {
    if (this.persistence === undefined) return
    this.#persistDirty = true
    if (this.#persistTimer !== undefined) return
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = undefined
      this.flush()
    }, this.persistDelayMs)
    this.#persistTimer.unref?.()
  }

  #snapshot(): string {
    return JSON.stringify({
      v: 1,
      hosts: [...this.hosts.values()],
      devices: [...this.devices.values()],
      deviceTokens: [...this.deviceTokens.entries()],
      pairings: [...this.pairings.values()],
      hostTokens: [...this.hostTokens.entries()],
      lastTakeovers: [...this.lastTakeovers.entries()],
    })
  }

  #restore(text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // A truncated or corrupted snapshot starts the relay empty.
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const record = parsed as Record<string, unknown>
    if (record['v'] !== 1) return
    const timestamp = this.now()
    if (Array.isArray(record['hosts'])) {
      for (const entry of record['hosts']) {
        const host = restoreHost(entry)
        if (host !== undefined) this.hosts.set(host.hostId, host)
      }
    }
    if (Array.isArray(record['devices'])) {
      for (const entry of record['devices']) {
        const device = restoreDevice(entry)
        if (device !== undefined && this.hosts.has(device.hostId)) {
          this.devices.set(device.deviceId, device)
        }
      }
    }
    if (Array.isArray(record['deviceTokens'])) {
      for (const pair of record['deviceTokens']) {
        if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') continue
        if (this.devices.has(pair[1])) this.deviceTokens.set(pair[0], pair[1])
      }
    }
    if (Array.isArray(record['pairings'])) {
      for (const entry of record['pairings']) {
        const pairing = restorePairing(entry)
        if (pairing !== undefined && pairing.expiresAt > timestamp) {
          this.pairings.set(pairing.pairTokenHash, pairing)
        }
      }
    }
    if (Array.isArray(record['hostTokens'])) {
      for (const pair of record['hostTokens']) {
        if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue
        const value = pair[1] as Record<string, unknown> | undefined
        if (
          typeof value !== 'object' || value === null ||
          typeof value['hostId'] !== 'string' || typeof value['expiresAt'] !== 'number'
        ) {
          continue
        }
        if (value['expiresAt'] > timestamp && this.hosts.has(value['hostId'])) {
          this.hostTokens.set(pair[0], { hostId: value['hostId'] as HostId, expiresAt: value['expiresAt'] })
        }
      }
    }
    if (Array.isArray(record['lastTakeovers'])) {
      for (const pair of record['lastTakeovers']) {
        if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'number') {
          this.lastTakeovers.set(pair[0], pair[1])
        }
      }
    }
  }

  /** @inheritDoc */
  async registerHost(input: RegisterHostInput): Promise<RegisterHostResult> {
    const secretHash = hashSecret(input.hostSecret)
    const timestamp = this.now()
    const existing = this.hosts.get(input.hostId)
    if (existing !== undefined) {
      if (existing.revokedAt !== undefined || !hashesEqual(existing.secretHash, secretHash)) {
        return { ok: false, code: 'AUTH_FAILED' }
      }
      existing.name = input.hostName
      existing.lastSeenAt = timestamp
      this.#schedulePersist()
      return { ok: true, host: toHostInfo(existing) }
    }
    const host: HostRecord = {
      hostId: input.hostId,
      secretHash,
      name: input.hostName,
      createdAt: timestamp,
      lastSeenAt: timestamp,
    }
    this.hosts.set(host.hostId, host)
    this.#schedulePersist()
    return { ok: true, host: toHostInfo(host) }
  }

  /** @inheritDoc */
  async issueHostToken(hostId: HostId): Promise<IssuedHostToken | undefined> {
    const current = this.now()
    this.pruneHostTokens(current)
    const host = this.hosts.get(hostId)
    if (host === undefined || host.revokedAt !== undefined) return undefined
    let token = randomToken()
    while (this.hostTokens.has(hashToken(token))) token = randomToken()
    const expiresAt = current + this.hostTokenTtlMs
    this.hostTokens.set(hashToken(token), { hostId, expiresAt })
    return { token: asHostToken(token), expiresAt }    
    this.#schedulePersist()
    return { token: asHostToken(token), expiresAt }
  }

  /** @inheritDoc */
  async authenticateHostToken(token: HostToken): Promise<HostId | undefined> {
    const tokenHash = hashToken(token)
    const record = this.hostTokens.get(tokenHash)
    if (record === undefined) return undefined
    const current = this.now()
    if (record.expiresAt <= current) {
      this.hostTokens.delete(tokenHash)
      this.#schedulePersist()
      return undefined
    }
    const host = this.hosts.get(record.hostId)
    if (host === undefined || host.revokedAt !== undefined) return undefined
    return record.hostId
  }

  /** @inheritDoc */
  async createPairing(
    hostId: HostId,
    options: CreatePairingOptions,
  ): Promise<CreatedPairing | undefined> {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new RangeError('ttlMs must be a positive finite number')
    }
    const host = this.hosts.get(hostId)
    if (host === undefined || host.revokedAt !== undefined) return undefined
    let pairToken = randomToken()
    while (this.pairings.has(hashToken(pairToken))) pairToken = randomToken()
    const expiresAt = this.now() + options.ttlMs
    const pairingCode = randomPairingCode()
    const pairTokenHash = hashToken(pairToken)
    this.pairings.set(pairTokenHash, { pairTokenHash, hostId, code: pairingCode, expiresAt })
    return { pairToken: asPairToken(pairToken), pairingCode, expiresAt }    
    this.#schedulePersist()
    return { pairToken: asPairToken(pairToken), pairingCode, expiresAt }
  }

  /** @inheritDoc */
  async claimPairing(input: ClaimPairingInput): Promise<ClaimPairingResult> {
    const pairTokenHash = hashToken(input.pairToken)
    const pairing = this.pairings.get(pairTokenHash)
    if (pairing === undefined || pairing.hostId !== input.hostId) {
      return { ok: false, code: 'invalid' }
    }
    const host = this.hosts.get(pairing.hostId)
    if (host === undefined || host.revokedAt !== undefined) {
      return { ok: false, code: 'invalid' }
    }
    if (pairing.consumedAt !== undefined) return { ok: false, code: 'consumed' }
    const timestamp = this.now()
    if (timestamp >= pairing.expiresAt) return { ok: false, code: 'expired' }

    const deviceId = this.newDeviceId()
    const deviceToken = this.newDeviceToken()
    pairing.consumedAt = timestamp
    this.devices.set(deviceId, {
      deviceId,
      hostId: pairing.hostId,
      tokenHash: deviceToken.tokenHash,
      ...(input.deviceName === undefined ? {} : { name: input.deviceName }),
      ...(input.platform === undefined ? {} : { platform: input.platform }),
      createdAt: timestamp,
      lastSeenAt: timestamp,
    })
    this.deviceTokens.set(deviceToken.tokenHash, deviceId)
    this.#schedulePersist()
    return {
      ok: true,
      deviceId,
      deviceToken: deviceToken.token,
      hostId: pairing.hostId,
      hostName: host.name,
    }
  }

  /** @inheritDoc */
  async authenticateDeviceToken(token: DeviceToken): Promise<AuthenticatedDevice | undefined> {
    const tokenHash = hashToken(token)
    const deviceId = this.deviceTokens.get(tokenHash)
    if (deviceId === undefined) return undefined
    const device = this.devices.get(deviceId)
    if (device === undefined || device.revokedAt !== undefined) {
      this.deviceTokens.delete(tokenHash)
      this.#schedulePersist()
      return undefined
    }
    const host = this.hosts.get(device.hostId)
    if (host === undefined || host.revokedAt !== undefined) return undefined
    return { hostId: device.hostId, deviceId: device.deviceId }
  }

  /** @inheritDoc */
  async listDevices(hostId: HostId): Promise<RelayDeviceInfo[]> {
    const result: RelayDeviceInfo[] = []
    for (const device of this.devices.values()) {
      if (device.hostId !== hostId || device.revokedAt !== undefined) continue
      result.push({
        deviceId: device.deviceId,
        ...(device.name === undefined ? {} : { name: device.name }),
        ...(device.platform === undefined ? {} : { platform: device.platform }),
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
      })
    }
    return result
  }

  /** @inheritDoc */
  async revokeDevice(hostId: HostId, deviceId: DeviceId): Promise<boolean> {
    const device = this.devices.get(deviceId)
    if (device === undefined || device.hostId !== hostId) return false
    if (device.revokedAt === undefined) {
      device.revokedAt = this.now()
      this.deviceTokens.delete(device.tokenHash)
      this.#schedulePersist()
    }
    return true
  }

  /** @inheritDoc */
  async touchHost(hostId: HostId): Promise<void> {
    const host = this.hosts.get(hostId)
    if (host === undefined || host.revokedAt !== undefined) return
    host.lastSeenAt = this.now()
    this.#schedulePersist()
  }

  /** @inheritDoc */
  async touchDevice(deviceId: DeviceId): Promise<void> {
    const device = this.devices.get(deviceId)
    if (device === undefined || device.revokedAt !== undefined) return
    device.lastSeenAt = this.now()
    this.#schedulePersist()
  }

  /** @inheritDoc */
  async noteTakeover(hostId: HostId): Promise<boolean> {
    const timestamp = this.now()
    const previous = this.lastTakeovers.get(hostId)
    if (previous !== undefined && timestamp - previous < KICK_CONFLICT_WINDOW_MS) {
      return true
    }
    this.lastTakeovers.set(hostId, timestamp)
    this.#schedulePersist()
    if (this.lastTakeovers.size > 1024) {
      for (const [entry, at] of this.lastTakeovers) {
        if (timestamp - at >= KICK_CONFLICT_WINDOW_MS) this.lastTakeovers.delete(entry)
      }
    }
    return false
  }

  private pruneHostTokens(timestamp: number): void {
    for (const [tokenHash, record] of this.hostTokens) {
      if (record.expiresAt <= timestamp) this.hostTokens.delete(tokenHash)
    }
  }

  private newDeviceId(): DeviceId {
    for (;;) {
      const candidate = `device-${randomBytes(16).toString('base64url')}`
      if (!this.devices.has(candidate)) return asDeviceId(candidate)
    }
  }

  private newDeviceToken(): { token: DeviceToken; tokenHash: string } {
    for (;;) {
      const candidate = randomToken()
      const tokenHash = hashToken(candidate)
      if (!this.deviceTokens.has(tokenHash)) {
        return { token: asDeviceToken(candidate), tokenHash }
      }
    }
  }
}

function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

function randomPairingCode(): string {
  return randomInt(0, 100_000_000).toString().padStart(8, '0')
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function hashSecret(secret: string): string {
  return hashToken(secret)
}

function hashesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex')
  const rightBytes = Buffer.from(right, 'hex')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function toHostInfo(host: HostRecord): RelayHostInfo {
  return {
    hostId: host.hostId,
    name: host.name,
    createdAt: host.createdAt,
    lastSeenAt: host.lastSeenAt,
    ...(host.revokedAt === undefined ? {} : { revokedAt: host.revokedAt }),
  }
}

function restoreHost(value: unknown): HostRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record['hostId'] !== 'string' || typeof record['secretHash'] !== 'string') return undefined
  if (typeof record['name'] !== 'string' || typeof record['createdAt'] !== 'number' || typeof record['lastSeenAt'] !== 'number') {
    return undefined
  }
  return {
    hostId: asHostId(record['hostId']),
    secretHash: record['secretHash'],
    name: record['name'],
    createdAt: record['createdAt'],
    lastSeenAt: record['lastSeenAt'],
    ...(typeof record['revokedAt'] === 'number' ? { revokedAt: record['revokedAt'] } : {}),
  }
}

function restoreDevice(value: unknown): DeviceRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record['deviceId'] !== 'string' || typeof record['hostId'] !== 'string' || typeof record['tokenHash'] !== 'string') {
    return undefined
  }
  if (typeof record['createdAt'] !== 'number' || typeof record['lastSeenAt'] !== 'number') return undefined
  return {
    deviceId: asDeviceId(record['deviceId']),
    hostId: record['hostId'] as HostId,
    tokenHash: record['tokenHash'],
    ...(typeof record['name'] === 'string' ? { name: record['name'] } : {}),
    ...(typeof record['platform'] === 'string' ? { platform: record['platform'] } : {}),
    createdAt: record['createdAt'],
    lastSeenAt: record['lastSeenAt'],
    ...(typeof record['revokedAt'] === 'number' ? { revokedAt: record['revokedAt'] } : {}),
  }
}

function restorePairing(value: unknown): PairingRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record['pairTokenHash'] !== 'string' || typeof record['hostId'] !== 'string' || typeof record['code'] !== 'string') {
    return undefined
  }
  if (typeof record['expiresAt'] !== 'number') return undefined
  return {
    pairTokenHash: record['pairTokenHash'],
    hostId: record['hostId'] as HostId,
    code: record['code'],
    expiresAt: record['expiresAt'],
    ...(typeof record['consumedAt'] === 'number' ? { consumedAt: record['consumedAt'] } : {}),
  }
}
