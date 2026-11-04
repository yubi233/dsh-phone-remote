/**
 * Local console routes for the DSH web GUI (`/api/web-remote/*`).
 *
 * The client half of this plugin (injected into the DSH web app) talks to the
 * Host half through these routes: setup the relay, mint a pairing QR, and
 * manage paired devices. Access is fenced to loopback sockets and same-origin
 * browser requests — the same trust model the web app's own API uses.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DeviceRecord, PairingOffer } from './pairing.ts'
import type { HostRemoteState } from './remote.ts'

/** Minimal webServer surface the console attaches to (structural, test-stubbed). */
export interface RelayConsoleServer {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): (() => void) | void
}

/** Relay setup input accepted from the console. */
export interface RelaySetupInput {
  /** Relay HTTP origin; normalized and validated before use. */
  relayHttpUrl: string
  /** Registration token for public relays; replaces the previous value when given. */
  registrationToken?: string
  /** Pairing page base; defaults to the relay origin (shell hosted by relay). */
  pairingUrlBase?: string
}

/** What the console shows about the current setup. */
export interface RelayConsoleInfo {
  configured: boolean
  state: HostRemoteState | 'unconfigured'
  hostName: string
  relayHttpUrl?: string
  hostId?: string
  registrationTokenSet: boolean
  /** Present while the built-in LAN relay is serving the phone shell. */
  localRelay?: { lanUrl: string; port: number }
  lastError?: { code: string; message?: string }
}

/** Result of a successful setup. */
export interface RelaySetupResult {
  hostId: string
  hostName: string
  pairingUrlBase: string
}

/** What the console needs from the host service (structural, test-stubbed). */
export interface RelayConsoleService {
  /** Current setup snapshot for the status card. */
  consoleInfo(): RelayConsoleInfo
  /** Validate, connect, and persist a relay setup; throws on relay rejection. */
  configureRelay(input: RelaySetupInput): Promise<RelaySetupResult>
  /** Mint a one-time pairing offer (URL included when a page base is set). */
  createPairing(): Promise<PairingOffer>
  /** List paired devices. */
  listDevices(): Promise<DeviceRecord[]>
  /** Revoke one paired device. */
  revokeDevice(deviceId: string): Promise<void>
}

export interface RelayConsoleOptions {
  readonly service: RelayConsoleService
  /** Reconnect the Host transport (stop, re-attach, start); returns the new state. */
  readonly restart?: () => Promise<string>
  /** Built-in LAN relay controls; omitted when the deployment disables it. */
  readonly localRelay?: {
    /** Switch to the built-in relay (stopping any external one); returns its info. */
    start(port?: number): Promise<{ lanUrl: string; port: number }>
    /** Whether local mode is allowed at all. */
    enabled: boolean
  }
  readonly logger?: {
    info?(message: string): void
    warn?(message: string): void
    error?(message: string): void
  }
}

/** Bound on one console request body. */
const MAX_CONSOLE_BODY_BYTES = 64 * 1024

/**
 * Register the console route family under `/api/web-remote`.
 *
 * One prefix route owns the whole family so exact API routes of the web app
 * are never shadowed and the fence applies uniformly.
 *
 * @returns the disposer removing the route again; the caller binds it to the
 * plugin's effect lifetime so a reload re-registers cleanly.
 */
export function registerRelayConsole(
  server: RelayConsoleServer,
  options: RelayConsoleOptions,
): () => void {
  try {
    const dispose = server.register({
      kind: 'prefix',
      path: '/api/web-remote',
      handler: (req, res) => handleConsoleRequest(req, res, options),
    })
    return typeof dispose === 'function' ? dispose : () => undefined
  } catch (error) {
    // A second live instance (the desktop shell can activate a freshly
    // installed plugin while the startup composition still holds one) must not
    // fail the plugin: the first registration keeps serving the family.
    if (error instanceof Error && error.message.includes('duplicate')) {
      options.logger?.warn?.(
        'web-remote-host: console routes are already registered by another instance; reusing them',
      )
      return () => undefined
    }
    throw error
  }
}

async function handleConsoleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: RelayConsoleOptions,
): Promise<void> {
  try {
    if (!isTrustedConsoleRequest(req)) {
      writeJson(res, 403, { error: { code: 'FORBIDDEN', message: 'console is local-only' } })
      return
    }
    const path = new URL(req.url ?? '/', 'http://console.invalid').pathname
    const method = req.method ?? 'GET'

    if (method === 'GET' && path === '/api/web-remote/status') {
      writeJson(res, 200, options.service.consoleInfo())
      return
    }

    if (method === 'POST' && path === '/api/web-remote/relay') {
      const body = await readJsonBody(req)
      const input = parseSetupInput(body)
      try {
        writeJson(res, 200, await options.service.configureRelay(input))
      } catch (error) {
        if (error instanceof ConsoleError) throw error
        // Setup inputs are validated above, so a throw here is the relay
        // rejecting registration (unreachable, wrong registration token).
        throw new ConsoleError(
          502,
          'RELAY_SETUP_FAILED',
          error instanceof Error ? error.message : String(error),
        )
      }
      return
    }

    if (method === 'POST' && path === '/api/web-remote/restart') {
      req.resume()
      if (options.restart === undefined) {
        throw new ConsoleError(409, 'NOT_SUPPORTED', 'restart is not available on this deployment')
      }
      writeJson(res, 200, { ok: true, state: await options.restart() })
      return
    }

    if (method === 'POST' && path === '/api/web-remote/local') {
      const local = options.localRelay
      if (local === undefined || !local.enabled) {
        throw new ConsoleError(409, 'NOT_SUPPORTED', 'built-in LAN relay is disabled on this deployment')
      }
      const body = await readOptionalJsonBody(req)
      const port = parseOptionalPort(body)
      const info = await local.start(port)
      writeJson(res, 200, { ok: true, localRelay: { lanUrl: info.lanUrl, port: info.port } })
      return
    }

    if (method === 'POST' && path === '/api/web-remote/pairing') {
      req.resume()
      writeJson(res, 200, await options.service.createPairing())
      return
    }

    if (method === 'GET' && path === '/api/web-remote/devices') {
      writeJson(res, 200, { devices: await options.service.listDevices() })
      return
    }

    const revoke = /^\/api\/web-remote\/devices\/([^/]+)\/revoke$/.exec(path)
    if (method === 'POST' && revoke !== null) {
      req.resume()
      await options.service.revokeDevice(decodeURIComponent(revoke[1] ?? ''))
      writeJson(res, 200, { revoked: true })
      return
    }

    req.resume()
    writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } })
  } catch (error) {
    if (error instanceof ConsoleError) {
      writeJson(res, error.status, { error: { code: error.code, message: error.message } })
      return
    }
    options.logger?.error?.(
      `web-remote-host console: ${error instanceof Error ? error.message : String(error)}`,
    )
    writeJson(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } })
  }
}

/**
 * Trust decision for console access.
 *
 * Loopback sockets are trusted (local desktop browser, local proxy hop).
 * Remote sockets must present a same-origin browser request: an `Origin`
 * whose host equals the `Host` the server was addressed by. Cross-site
 * browsers and non-browser LAN clients get 403.
 */
export function isTrustedConsoleRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return true
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin !== 'string' || origin === '' || host === undefined || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Parse and validate the relay setup body before it reaches the service. */
function parseSetupInput(body: unknown): RelaySetupInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ConsoleError(400, 'WRONG_PARAM', 'relay setup body must be an object')
  }
  const record = body as Record<string, unknown>
  const relayHttpUrl = record['relayHttpUrl']
  if (typeof relayHttpUrl !== 'string' || relayHttpUrl.trim() === '') {
    throw new ConsoleError(400, 'WRONG_PARAM', 'relayHttpUrl is required')
  }
  const registrationToken = optionalNonEmpty(record['registrationToken'], 'registrationToken')
  const pairingUrlBase = optionalNonEmpty(record['pairingUrlBase'], 'pairingUrlBase')
  return {
    relayHttpUrl,
    ...(registrationToken === undefined ? {} : { registrationToken }),
    ...(pairingUrlBase === undefined ? {} : { pairingUrlBase }),
  }
}

/** A console-visible failure with its HTTP status. */
export class ConsoleError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ConsoleError'
  }
}

/** Read a JSON body when one was sent; an empty body is allowed. */
async function readOptionalJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = req.headers['content-length']
  if (declared === undefined && req.headers['transfer-encoding'] === undefined) return undefined
  return await readJsonBody(req)
}

function parseOptionalPort(body: unknown): number | undefined {
  if (body === undefined) return undefined
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ConsoleError(400, 'WRONG_PARAM', 'local relay body must be an object')
  }
  const port = (body as Record<string, unknown>)['port']
  if (port === undefined) return undefined
  if (!Number.isSafeInteger(port) || (port as number) < 0 || (port as number) > 65535) {
    throw new ConsoleError(400, 'WRONG_PARAM', 'port must be an integer between 0 and 65535')
  }
  return port as number
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > MAX_CONSOLE_BODY_BYTES) {
    throw new ConsoleError(413, 'TOO_LARGE', 'console body too large')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike)
    total += buffer.byteLength
    if (total > MAX_CONSOLE_BODY_BYTES) {
      throw new ConsoleError(413, 'TOO_LARGE', 'console body too large')
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0) {
    throw new ConsoleError(400, 'WRONG_PARAM', 'a JSON body is required')
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new ConsoleError(400, 'WRONG_PARAM', 'body must be valid JSON')
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function optionalNonEmpty(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConsoleError(400, 'WRONG_PARAM', `${field} must be a non-empty string when given`)
  }
  return value
}
