#!/usr/bin/env node
/**
 * Standalone relay entry point.
 *
 * Environment:
 * - `PORT` / `HOST` — bind address; HOST defaults to loopback, LAN/public
 *   deployments set it explicitly.
 * - `RELAY_STORE_FILE` — persist pairings and tokens to this JSON file so a
 *   restart does not force every phone to re-pair. Omit for the memory store.
 * - `RELAY_TRUST_PROXY` — `1`/`true` when behind one reverse proxy (Caddy,
 *   nginx): rate limits key on the proxy-observed client IP instead of the
 *   proxy's own address.
 * - `RELAY_REGISTRATION_TOKEN` — require `x-registration-token` on host
 *   registration. Public relays must set this.
 * - `RELAY_AUTH_PASSWORD` — access password for the phone shell's login
 *   screen. Set a strong value on any deployment reachable from the internet;
 *   omit it for a LAN-only relay where the shell skips the gate.
 * - `RELAY_STATIC_DIR` — serve the built phone shell (`apps/mobile-web/dist`)
 *   from the relay for non-API paths, so the pairing QR can point at this
 *   relay's single origin. Omit for an API-only relay behind a separate
 *   static host.
 *
 * Shuts down on SIGINT or SIGTERM, flushing any pending snapshot first.
 */

import { filePersistence } from './persistence.ts'
import { MemoryRelayStore } from './store.ts'
import { startRelayServer } from './server.ts'

const DEFAULT_PORT = 8787
/** Secure default: the relay has host registration and must not silently bind
 *  every interface; LAN deployments set HOST explicitly. */
const DEFAULT_HOST = '127.0.0.1'

async function main(): Promise<void> {
  const port = parsePort(process.env.PORT)
  const host = process.env.HOST ?? DEFAULT_HOST
  const storeFile = readNonEmpty(process.env.RELAY_STORE_FILE)
  const server = await startRelayServer({
    host,
    port,
    log: (event) => {
      console.log(`[${new Date().toISOString()}] ${JSON.stringify(event)}`)
    },
    ...(storeFile === undefined
      ? {}
      : { store: new MemoryRelayStore({ persistence: filePersistence(storeFile) }) }),
    ...(process.env.RELAY_TRUST_PROXY === '1' || process.env.RELAY_TRUST_PROXY === 'true'
      ? { trustProxy: true }
      : {}),
    ...(readNonEmpty(process.env.RELAY_REGISTRATION_TOKEN) === undefined
      ? {}
      : { registrationToken: readNonEmpty(process.env.RELAY_REGISTRATION_TOKEN) }),
    ...(readNonEmpty(process.env.RELAY_AUTH_PASSWORD) === undefined
      ? {}
      : { authPassword: readNonEmpty(process.env.RELAY_AUTH_PASSWORD) }),
    ...(readNonEmpty(process.env.RELAY_STATIC_DIR) === undefined
      ? {}
      : { staticDir: readNonEmpty(process.env.RELAY_STATIC_DIR) }),
  })
  console.log(server.httpUrl)

  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    server.store.flush?.()
    await server.close()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })
}

function readNonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got ${value}`)
  }
  return port
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
