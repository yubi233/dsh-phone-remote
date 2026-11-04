/**
 * Built-in LAN relay: the plugin hosts the relay and the phone shell itself,
 * so installing the plugin is the whole setup. The panel then shows one LAN
 * URL (and a QR) that a phone can open immediately.
 */

import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { filePersistence, MemoryRelayStore, startRelayServer } from '@dsh-web-remote/relay'
import type { RelayServer } from '@dsh-web-remote/relay'

/** Default LAN port; a busy port falls back to an ephemeral one. */
export const DEFAULT_LOCAL_RELAY_PORT = 8787

/** Everything the panel needs to point a phone at this relay. */
export interface LocalRelayInfo {
  /** Loopback origin the Host itself connects to. */
  internalHttpUrl: string
  /** LAN origin a phone opens (first non-internal IPv4, else loopback). */
  lanUrl: string
  /** Actual bound port. */
  port: number
}

/** Options for one built-in relay instance. */
export interface LocalRelayOptions {
  /** Preferred port; defaults to {@link DEFAULT_LOCAL_RELAY_PORT}. */
  port?: number
  /** Interface to bind; defaults to `0.0.0.0` so phones on the LAN can reach it. */
  host?: string
  /** Directory of the built phone shell served for non-API paths. */
  shellDir?: string
  /** Persistence file; omit for an in-memory store (tests). */
  storeFile?: string
}

/**
 * Phone shell location shipped inside this package.
 *
 * `src/local-relay.ts` and `lib/index.js` both sit one level below the package
 * root, so `../shell/` resolves to the same directory in development and in
 * the published bundle. A missing directory means the package was published
 * without building the shell; local mode then refuses to start instead of
 * serving 404s to a paired phone.
 */
export function defaultShellDir(): string {
  return fileURLToPath(new URL('../shell/', import.meta.url))
}

/** First non-internal IPv4 of this machine, or `127.0.0.1` when offline. */
export function lanIpv4(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

/** One running built-in relay. */
export class LocalRelay {
  readonly #options: LocalRelayOptions
  #server: RelayServer | undefined

  constructor(options: LocalRelayOptions = {}) {
    this.#options = options
  }

  /** Whether the relay is currently serving. */
  get running(): boolean {
    return this.#server !== undefined
  }

  /**
   * Start the relay, preferring the configured port and falling back to an
   * ephemeral one when it is busy. The store persists pairings and device
   * tokens when a store file is configured.
   */
  async start(): Promise<LocalRelayInfo> {
    if (this.#server !== undefined) throw new Error('local relay is already running')
    const shellDir = this.#options.shellDir ?? defaultShellDir()
    if (!existsSync(join(shellDir, 'index.html'))) {
      throw new Error(
        `phone shell not found at ${shellDir}; build the package (pnpm build) before using the built-in relay`,
      )
    }
    const storeFile = this.#options.storeFile
    const server = await this.#listen(this.#options.port ?? DEFAULT_LOCAL_RELAY_PORT, shellDir, storeFile)
    this.#server = server
    return localRelayInfoFor(server)
  }

  /** Stop the relay; idempotent. */
  async close(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    if (server !== undefined) await server.close()
  }

  async #listen(port: number, shellDir: string, storeFile: string | undefined): Promise<RelayServer> {
    const store = storeFile === undefined
      ? undefined
      : new MemoryRelayStore({ persistence: filePersistence(storeFile) })
    const baseOptions = {
      host: this.#options.host ?? '0.0.0.0',
      staticDir: shellDir,
      ...(store === undefined ? {} : { store }),
    }
    try {
      return await startRelayServer({ ...baseOptions, port })
    } catch (error) {
      if (port === 0 || !isAddressInUse(error)) throw error
      // The preferred port is taken; fall back to an ephemeral one and let the
      // panel show the actual URL.
      return await startRelayServer({ ...baseOptions, port: 0 })
    }
  }
}

function localRelayInfoFor(server: RelayServer): LocalRelayInfo {
  // RelayServer exposes its bound origin; the port lives inside it.
  const port = Number(new URL(server.httpUrl).port)
  return {
    internalHttpUrl: server.httpUrl,
    lanUrl: `http://${lanIpv4()}:${String(port)}`,
    port,
  }
}

function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE'
}
