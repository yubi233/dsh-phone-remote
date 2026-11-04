import { randomBytes, randomUUID } from 'node:crypto'
import type { SchemaLike } from './unread.ts'

/**
 * Relay connection settings the Host console owns at runtime.
 *
 * Stored in a DSH storage domain so a GUI setup survives restarts without
 * editing the profile patch. `hostSecret` is the Host's own outbound
 * credential and must be kept verbatim; the relay only ever sees its hash.
 */
export interface RelayRuntimeConfig {
  /** Relay HTTP origin, for example `https://relay.example`. Absent in local mode. */
  relayHttpUrl?: string
  /** Built-in LAN relay marker: its preferred port. Mutually exclusive with relayHttpUrl. */
  localRelay?: { port?: number }
  /** Stable Host identity; generated on first setup and kept afterwards. */
  hostId: string
  /** Long-lived registration secret; generated on first setup. */
  hostSecret: string
  /** Value sent as `x-registration-token` on public relays. */
  registrationToken?: string
  /** Pairing page base; defaults to {@link relayHttpUrl} (shell hosted by relay). */
  pairingUrlBase?: string
}

/** Narrow storage surface the config store needs (structural, test-stubbed). */
export interface RelayConfigStorage {
  open(spec: {
    name: string
    version: number
    tables: Record<string, { valueSchema: SchemaLike<unknown> }>
  }): Promise<{ table(name: string): RelayConfigTableLike; close(): Promise<void> }>
}

export interface RelayConfigTableLike {
  get(key: string): unknown
  put(key: string, value: unknown): Promise<void>
}

const CONFIG_KEY = 'current'
const DOMAIN_NAME = 'web_remote_relay'

/** Strict parse of one stored relay config; corrupt values are rejected whole. */
const relayConfigSchema: SchemaLike<RelayRuntimeConfig> = {
  parse(value: unknown): RelayRuntimeConfig {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('relay config must be an object')
    }
    const record = value as Record<string, unknown>
    const relayHttpUrl = optionalStringOf(record['relayHttpUrl'], 'relayHttpUrl')
    const localRelay = optionalLocalRelay(record['localRelay'])
    if (relayHttpUrl === undefined && localRelay === undefined) {
      throw new Error('relay config needs relayHttpUrl or localRelay')
    }
    return {
      ...(relayHttpUrl === undefined ? {} : { relayHttpUrl }),
      ...(localRelay === undefined ? {} : { localRelay }),
      hostId: requireString(record['hostId'], 'hostId'),
      hostSecret: requireString(record['hostSecret'], 'hostSecret'),
      ...optionalString(record['registrationToken'], 'registrationToken'),
      ...optionalString(record['pairingUrlBase'], 'pairingUrlBase'),
    }
  },
}

/**
 * Load/save the runtime relay configuration through a DSH storage domain.
 *
 * The domain is opened lazily on first use. A stored value that fails
 * validation is reported as absent (the caller falls back to patch config and
 * the console can set up again); this keeps one corrupt record from bricking
 * the plugin.
 */
export class RelayConfigStore {
  readonly #storage: RelayConfigStorage
  #table: RelayConfigTableLike | undefined
  #domain: { close(): Promise<void> } | undefined
  #opening: Promise<RelayConfigTableLike> | undefined

  constructor(storage: RelayConfigStorage) {
    this.#storage = storage
  }

  /** Stored runtime config, or `undefined` when none is stored or it is invalid. */
  async load(): Promise<RelayRuntimeConfig | undefined> {
    try {
      const table = await this.#open()
      const stored = table.get(CONFIG_KEY)
      return stored === undefined ? undefined : relayConfigSchema.parse(stored)
    } catch {
      return undefined
    }
  }

  /** Persist the runtime config, replacing any previous value. */
  async save(config: RelayRuntimeConfig): Promise<void> {
    const table = await this.#open()
    await table.put(CONFIG_KEY, relayConfigSchema.parse(config))
  }

  /** Release the storage domain; idempotent. */
  async close(): Promise<void> {
    const domain = this.#domain
    this.#domain = undefined
    this.#table = undefined
    this.#opening = undefined
    if (domain !== undefined) await domain.close()
  }

  async #open(): Promise<RelayConfigTableLike> {
    if (this.#table !== undefined) return this.#table
    if (this.#opening === undefined) {
      this.#opening = (async () => {
        const domain = await this.#storage.open({
          name: DOMAIN_NAME,
          version: 1,
          tables: { config: { valueSchema: relayConfigSchema as SchemaLike<unknown> } },
        })
        this.#domain = domain
        this.#table = domain.table('config')
        return this.#table
      })()
      this.#opening.catch(() => {
        if (this.#opening !== undefined) this.#opening = undefined
      })
    }
    return await this.#opening
  }
}

/** A fresh Host identity for first-time console setup. */
export function generateHostIdentity(): { hostId: string; hostSecret: string } {
  return { hostId: randomUUID(), hostSecret: randomBytes(32).toString('base64url') }
}

/**
 * Normalize a relay origin: trimmed, no trailing slashes, http(s) only.
 * @throws when the value is not an absolute http(s) URL.
 */
export function normalizeRelayHttpUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`relayHttpUrl must be an absolute http(s) URL, got ${JSON.stringify(value)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`relayHttpUrl must be an absolute http(s) URL, got ${parsed.protocol}`)
  }
  return trimmed
}

function optionalStringOf(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, field)
}

function optionalLocalRelay(value: unknown): { port?: number } | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('relay config localRelay must be an object')
  }
  const record = value as Record<string, unknown>
  const port = record['port']
  if (port === undefined) return {}
  if (!Number.isSafeInteger(port) || (port as number) < 0 || (port as number) > 65535) {
    throw new Error('relay config localRelay.port must be an integer between 0 and 65535')
  }
  return { port: port as number }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`relay config ${field} must be a non-empty string`)
  }
  return value
}

function optionalString(
  value: unknown,
  field: string,
): { [K in 'registrationToken' | 'pairingUrlBase']?: string } {
  if (value === undefined) return {}
  return { [field]: requireString(value, field) } as { [K in 'registrationToken' | 'pairingUrlBase']?: string }
}
