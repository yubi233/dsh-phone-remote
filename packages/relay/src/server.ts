/**
 * Stateless relay: host registration, pairing, device management, and raw
 * WebSocket forwarding between one Host and one device per host.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import {
  HEARTBEAT_INTERVAL_MS,
  MAX_PHYSICAL_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  asConnectionId,
  asDeviceId,
  asDeviceToken,
  asHostId,
  asHostToken,
  asPairToken,
  parseRelayControlMessage,
  requireInteger,
  requireRecord,
  requireString,
} from '@dsh-web-remote/protocol'
import type {
  ConnectionId,
  DeviceId,
  HostId,
  PairStatus,
  RelayControlMessage,
  RelayErrorCode,
} from '@dsh-web-remote/protocol'
import { MemoryRelayStore } from './store.ts'
import {
  AUTH_TOKEN_TTL_MS,
  buildAuthCookie,
  buildClearAuthCookie,
  hashToken,
  issueAuthToken,
  readAuthCookie,
  verifyPassword,
} from './auth.ts'
import type { ClaimPairingInput, RegisterHostInput, RelayStore } from './store.ts'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 0
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000
const MAX_HTTP_BODY_BYTES = 64 * 1024
const IDLE_TIMEOUT_MS = 30_000
const POLICY_CLOSE_CODE = 1008
const IDLE_CLOSE_CODE = 1001

/**
 * Error codes returned by the relay's HTTP API. `AUTH_FAILED`, `WRONG_PARAM`,
 * `DEVICE_OFFLINE`, and `INTERNAL` mirror the WebSocket relay codes;
 * `PAIRING_INVALID` and `NOT_FOUND` are HTTP-local additions.
 */
export type RelayHttpErrorCode =
  | 'AUTH_FAILED'
  | 'WRONG_PARAM'
  | 'DEVICE_OFFLINE'
  | 'INTERNAL'
  | 'PAIRING_INVALID'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'

/**
 * Metadata-only lifecycle event. Tokens, pairing secrets, and forwarded
 * payloads never appear here.
 */
export type RelayLogEvent =
  | { readonly type: 'server_started'; readonly host: string; readonly port: number }
  | { readonly type: 'host_registered'; readonly hostId: string }
  | { readonly type: 'auth_login' }
  | { readonly type: 'host_connected'; readonly hostId: string; readonly connectionId: string }
  | { readonly type: 'host_disconnected'; readonly hostId: string; readonly connectionId: string }
  | {
      readonly type: 'device_connected'
      readonly hostId: string
      readonly deviceId: string
      readonly connectionId: string
    }
  | {
      readonly type: 'device_disconnected'
      readonly hostId: string
      readonly deviceId: string
      readonly connectionId: string
    }
  | { readonly type: 'device_replaced'; readonly hostId: string; readonly deviceId: string }
  | { readonly type: 'session_conflict'; readonly hostId: string; readonly deviceId: string }
  | { readonly type: 'device_revoked'; readonly hostId: string; readonly deviceId: string }
  | {
      readonly type: 'socket_error'
      readonly role: 'host' | 'device'
      readonly hostId: string
      /** Transport error text (never contains tokens or payloads). */
      readonly message: string
    }
  | {
      readonly type: 'connection_closed'
      readonly role: 'host' | 'device'
      readonly hostId: string
      readonly connectionId: string
      /** WebSocket close code: 1006 abnormal, 1008 policy, 1000/1001 clean. */
      readonly code: number
    }
  | { readonly type: 'internal_error' }

/** Construction options for {@link startRelayServer}. */
export interface RelayServerOptions {
  /** Interface to bind; defaults to `127.0.0.1`. */
  readonly host?: string
  /** TCP port to bind; `0` (the default) requests an ephemeral port. */
  readonly port?: number
  /** Clock used for store timestamps and idle checks; defaults to `Date.now`. */
  readonly now?: () => number
  /** Pairing token lifetime; defaults to five minutes. */
  readonly pairingTtlMs?: number
  /** Persistence implementation; defaults to a fresh `MemoryRelayStore`. */
  readonly store?: RelayStore
  /** Receives metadata-only lifecycle events; defaults to discarding them. */
  readonly log?: (event: RelayLogEvent) => void
  /**
   * Per-IP request budget for credential-bearing routes. Defaults to 30
   * requests per 60 seconds; `false` disables the limiter.
   */
  readonly rateLimit?: { readonly windowMs?: number; readonly maxPerWindow?: number } | false
  /**
   * Trust one reverse-proxy hop for rate-limit keying: use the rightmost
   * `X-Forwarded-For` address (the one our proxy appended) instead of the
   * socket address. Required behind Caddy/nginx, otherwise every client shares
   * the proxy's single budget. Off by default so a direct deployment cannot
   * have its limiter bypassed by a spoofed header.
   */
  readonly trustProxy?: boolean
  /**
   * Require `x-registration-token: <value>` on `POST /v1/hosts/register`.
   *
   * Public relays must set this: without it anyone on the internet can
   * register their own host and use the relay as a free forwarding bridge.
   * Compared with `timingSafeEqual` against the configured value.
   */
  readonly registrationToken?: string
  /**
   * Plaintext web-auth password guarding the phone shell's login screen.
   *
   * When set, `GET /v1/auth/status` reports `authRequired: true`, and the
   * phone shell renders its own login form instead of letting the browser pop
   * a native HTTP Basic dialog. LAN-only deployments may leave this unset:
   * the shell then skips the gate entirely.
   */
  readonly authPassword?: string
  /**
   * Directory of static files served for non-API GET/HEAD paths: the phone
   * shell hosted on the relay itself, so a pairing QR can point at one public
   * origin. `GET /` serves `<dir>/index.html`. API routes (`/v1/*`) and the
   * WebSocket endpoint are never shadowed. Omit for an API-only relay.
   */
  readonly staticDir?: string
}

/** A running relay server. */
export interface RelayServer {
  /** WebSocket endpoint: `ws://<host>:<port>/v1/ws`. */
  readonly url: string
  /** HTTP base URL: `http://<host>:<port>`. */
  readonly httpUrl: string
  /** The store backing this server. */
  readonly store: RelayStore
  /**
   * Stop accepting work, close every socket, and release the port. Repeated
   * calls return the same promise.
   */
  close(): Promise<void>
}

type ConnectionRole = 'host' | 'device'

type ConnectionAuth =
  | { readonly role: 'host'; readonly hostId: HostId }
  | { readonly role: 'device'; readonly hostId: HostId; readonly deviceId: DeviceId }

interface ActiveConnection {
  readonly ws: WebSocket
  readonly role: ConnectionRole
  readonly hostId: HostId
  readonly deviceId?: DeviceId
  readonly connectionId: ConnectionId
  greeted: boolean
  lastSeenAt: number
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: RelayHttpErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/**
 * Start the relay HTTP and WebSocket server.
 *
 * @param options - Bind address, clock, pairing lifetime, store, and logger.
 * @returns The running server with its resolved URLs.
 */
export async function startRelayServer(options: RelayServerOptions = {}): Promise<RelayServer> {
  const boundHost = options.host ?? DEFAULT_HOST
  const requestedPort = options.port ?? DEFAULT_PORT
  const now = options.now ?? Date.now
  const pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS
  if (!Number.isFinite(pairingTtlMs) || pairingTtlMs <= 0) {
    throw new RangeError('pairingTtlMs must be a positive finite number')
  }
  const log = options.log ?? ((): void => undefined)
  const store = options.store ?? new MemoryRelayStore({ now })
  const rateLimit = options.rateLimit === false
    ? undefined
    : {
        windowMs: options.rateLimit?.windowMs ?? 60_000,
        maxPerWindow: options.rateLimit?.maxPerWindow ?? 30,
      }
  const trustProxy = options.trustProxy === true
  const registrationToken = options.registrationToken
  const authPassword = options.authPassword
  const staticRoot = options.staticDir === undefined ? undefined : resolve(options.staticDir)
  const activeAuthTokens = new Map<string, number>()
  const requestWindows = new Map<string, number[]>()

  /**
   * Enforce the per-IP budget for one route family.
   * @param request - incoming request whose socket address names the client.
   * @param family - route family sharing one budget.
   * @throws {HttpError} 429 when the budget is spent.
   */
  function enforceRateLimit(request: IncomingMessage, family: string): void {
    if (rateLimit === undefined) return
    const at = now()
    const address = clientAddressOf(request)
    const key = `${family}:${address}`
    const recent = (requestWindows.get(key) ?? []).filter((entry) => at - entry < rateLimit.windowMs)
    if (recent.length >= rateLimit.maxPerWindow) {
      requestWindows.set(key, recent)
      throw new HttpError(429, 'RATE_LIMITED', 'too many requests')
    }
    recent.push(at)
    requestWindows.set(key, recent)
    if (requestWindows.size > 4096) {
      for (const [entry, times] of requestWindows) {
        if (times.every((timestamp) => at - timestamp >= rateLimit.windowMs)) requestWindows.delete(entry)
      }
    }
  }

  /**
   * Resolve the client address for rate limiting.
   *
   * With `trustProxy`, the rightmost X-Forwarded-For entry is the source our
   * own proxy observed; entries further left are client-controlled and must
   * never be trusted. Without it, only the socket address counts.
   */
  function clientAddressOf(request: IncomingMessage): string {
    if (trustProxy) {
      const header = request.headers['x-forwarded-for']
      if (typeof header === 'string') {
        const hops = header.split(',').map((hop) => hop.trim()).filter((hop) => hop !== '')
        const observed = hops.at(-1)
        if (observed !== undefined) return observed
      }
    }
    return request.socket.remoteAddress ?? 'unknown'
  }

  /** Gate `POST /v1/hosts/register` when a registration token is configured. */
  function requireRegistrationToken(request: IncomingMessage): void {
    if (registrationToken === undefined) return
    const provided = request.headers['x-registration-token']
    const expected = Buffer.from(registrationToken, 'utf8')
    const actual = Buffer.from(typeof provided === 'string' ? provided : '', 'utf8')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new HttpError(401, 'AUTH_FAILED', 'registration token required')
    }
  }

  /** Drop web-auth tokens whose expiry has passed; run after each issue. */
  function pruneAuthTokens(at: number): void {
    for (const [hash, expiresAt] of activeAuthTokens) {
      if (expiresAt <= at) activeAuthTokens.delete(hash)
    }
  }

  /** Bearer token from the `Authorization` header, if any. */
  function bearerTokenOf(request: IncomingMessage): string | undefined {
    const header = request.headers['authorization']
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined
    const token = header.slice('Bearer '.length).trim()
    return token === '' ? undefined : token
  }

  /**
   * Whether the client reached us over TLS.
   *
   * Behind the Caddy edge the container only sees plain HTTP, so the scheme
   * has to come from the proxy's `X-Forwarded-Proto` header; direct
   * deployments fall back to the socket. Only affects the cookie `Secure`
   * flag, so a spoofed header cannot weaken authentication.
   */
  function isSecureRequest(request: IncomingMessage): boolean {
    if (trustProxy) {
      const proto = request.headers['x-forwarded-proto']
      const value = Array.isArray(proto) ? proto[0] : proto
      if (typeof value === 'string') return value.split(',', 1)[0]?.trim().toLowerCase() === 'https'
    }
    return (request.socket as { encrypted?: boolean }).encrypted === true
  }

  let closing = false
  let closePromise: Promise<void> | undefined
  const allConnections = new Set<ActiveConnection>()
  const hostConnections = new Map<string, ActiveConnection>()
  const deviceConnections = new Map<string, ActiveConnection>()

  const httpServer = createServer((request, response) => {
    void handleHttpRequest(request, response)
  })
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PHYSICAL_FRAME_BYTES,
    perMessageDeflate: false,
  })

  httpServer.on('upgrade', (request, socket, head) => {
    void handleUpgrade(request, socket, head)
  })
  httpServer.on('error', () => {
    log({ type: 'internal_error' })
  })
  webSocketServer.on('error', () => {
    log({ type: 'internal_error' })
  })

  await listen(httpServer, requestedPort, boundHost)

  const heartbeatTimer = setInterval(() => {
    if (closing) return
    const current = now()
    for (const connection of allConnections) {
      if (current - connection.lastSeenAt <= IDLE_TIMEOUT_MS) continue
      closeSocket(connection.ws, IDLE_CLOSE_CODE, 'idle timeout')
    }
  }, HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref()

  const address = httpServer.address()
  if (address === null || typeof address === 'string') {
    await close()
    throw new Error('relay failed to bind a TCP port')
  }
  const urlHost = displayHostFor(boundHost)
  const authority = urlHost.includes(':') ? `[${urlHost}]` : urlHost
  const url = `ws://${authority}:${address.port}/v1/ws`
  const httpUrl = `http://${authority}:${address.port}`

  function close(): Promise<void> {
    if (closePromise !== undefined) return closePromise
    closing = true
    clearInterval(heartbeatTimer)
    for (const connection of allConnections) connection.ws.terminate()
    allConnections.clear()
    hostConnections.clear()
    deviceConnections.clear()
    closePromise = (async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        webSocketServer.close(() => resolve())
      })
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
        httpServer.closeAllConnections()
      })
    })()
    return closePromise
  }

  log({ type: 'server_started', host: urlHost, port: address.port })
  return { url, httpUrl, store, close }

  async function handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      await routeHttpRequest(request, response)
    } catch (error: unknown) {
      // The claim exchange must expose its errors cross-origin too: a spent or
      // expired pair token is exactly what the pairing page needs to render a
      // readable failure (same rationale as the route-level header below).
      const claimPath = isClaimPath(request)
      const claimCors = { 'access-control-allow-origin': '*' }
      if (error instanceof HttpError) {
        writeJson(response, error.status, {
          error: { code: error.code, message: error.message },
        }, claimPath ? claimCors : {})
        return
      }
      log({ type: 'internal_error' })
      writeJson(response, 500, {
        error: { code: 'INTERNAL', message: 'internal error' },
      }, claimPath ? claimCors : {})
    }
  }

  /** Whether this request targets the pairing claim endpoint. */
  function isClaimPath(request: IncomingMessage): boolean {
    try {
      return new URL(request.url ?? '/', 'http://relay.invalid').pathname === '/v1/pair/claim'
    } catch {
      return false
    }
  }

  async function routeHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://relay.invalid')
    } catch {
      throw new HttpError(400, 'WRONG_PARAM', 'invalid request URL')
    }
    const path = url.pathname

    if (request.method === 'GET' && path === '/health') {
      writeJson(response, 200, { ok: true })
      return
    }

    // The pairing page may be hosted on a different origin than the relay
    // (development setups, LAN deployments without reverse proxying), so the
    // claim exchange allows any origin. This grants no extra capability: the
    // endpoint's only authority is the one-time pair token in the request body,
    // which a hostile origin must already know to get a response at all.
    if (request.method === 'OPTIONS' && path === '/v1/pair/claim') {
      request.resume()
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      })
      response.end()
      return
    }

    if (request.method === 'GET' && path === '/v1/auth/status') {
      writeJson(response, 200, { authRequired: authPassword !== undefined })
      return
    }

    if (request.method === 'POST' && path === '/v1/auth/login') {
      requireJsonContentType(request)
      enforceRateLimit(request, 'auth')
      const body = parseBody(parseAuthBody, await readJsonBody(request))
      if (authPassword === undefined || !verifyPassword(body.password, authPassword)) {
        throw new HttpError(401, 'AUTH_FAILED', 'invalid credentials')
      }
      const issued = issueAuthToken()
      const expiresAt = now() + AUTH_TOKEN_TTL_MS
      activeAuthTokens.set(issued.hash, expiresAt)
      pruneAuthTokens(now())
      log({ type: 'auth_login' })
      // The browser gets the token as an HttpOnly cookie so the edge can gate
      // static assets; API clients may still read it from the JSON body.
      writeJson(
        response,
        200,
        { token: issued.token, expiresAt },
        {
          'set-cookie': buildAuthCookie(issued.token, {
            maxAgeSeconds: Math.floor(AUTH_TOKEN_TTL_MS / 1000),
            secure: isSecureRequest(request),
          }),
        },
      )
      return
    }

    if (request.method === 'POST' && path === '/v1/auth/logout') {
      request.resume()
      const bearer = bearerTokenOf(request)
      const cookie = readAuthCookie(request.headers.cookie)
      for (const token of [bearer, cookie]) {
        if (token !== undefined) activeAuthTokens.delete(hashToken(token))
      }
      writeJson(response, 200, { ok: true }, { 'set-cookie': buildClearAuthCookie(isSecureRequest(request)) })
      return
    }

    if (request.method === 'GET' && path === '/v1/auth/verify') {
      // Caddy `forward_auth` treats 2xx as "allow" and anything else as deny,
      // so the decision must live in the status code, not a JSON field.
      const token = bearerTokenOf(request) ?? readAuthCookie(request.headers.cookie)
      const expiresAt = token === undefined ? undefined : activeAuthTokens.get(hashToken(token))
      if (expiresAt === undefined || expiresAt <= now()) {
        response.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
        response.end('unauthorized\n')
        return
      }
      response.writeHead(204, { 'cache-control': 'no-store' })
      response.end()
      return
    }

    if (request.method === 'POST' && path === '/v1/hosts/register') {
      requireRegistrationToken(request)
      requireJsonContentType(request)
      enforceRateLimit(request, 'register')
      const input = parseBody(parseRegisterBody, await readJsonBody(request))
      const registered = await store.registerHost(input)
      if (!registered.ok) throw authenticationFailed()
      const token = await store.issueHostToken(input.hostId)
      if (token === undefined) throw new HttpError(500, 'INTERNAL', 'host token unavailable')
      log({ type: 'host_registered', hostId: input.hostId })
      writeJson(response, 200, {
        hostToken: token.token,
        expiresAt: token.expiresAt,
        protocolVersion: PROTOCOL_VERSION,
      })
      return
    }

    if (request.method === 'POST' && path === '/v1/pair/claim') {
      requireJsonContentType(request)
      enforceRateLimit(request, 'claim')
      const input = parseBody(parseClaimBody, await readJsonBody(request))
      const claimed = await store.claimPairing(input)
      if (!claimed.ok) {
        if (claimed.code === 'expired' || claimed.code === 'consumed') {
          throw new HttpError(410, 'PAIRING_INVALID', `pairing ${claimed.code}`)
        }
        throw new HttpError(400, 'PAIRING_INVALID', 'pairing invalid')
      }
      writeJson(
        response,
        200,
        {
          deviceId: claimed.deviceId,
          deviceToken: claimed.deviceToken,
          hostId: claimed.hostId,
          hostName: claimed.hostName,
        },
        // Same rationale as the preflight above: the pairing page may be
        // hosted away from the relay, and the response's device token is only
        // readable by a request that already presented the pair token.
        { 'access-control-allow-origin': '*' },
      )
      return
    }

    if (request.method === 'POST') {
      const pairingMatch = /^\/v1\/hosts\/([^/]+)\/pairing$/.exec(path)
      if (pairingMatch !== null) {
        enforceRateLimit(request, 'pairing')
        request.resume()
        const hostId = asHostId(pathParameter(pairingMatch, 1, 'hostId'))
        await requireHostAccess(request, hostId)
        const pairing = await store.createPairing(hostId, { ttlMs: pairingTtlMs })
        if (pairing === undefined) throw new HttpError(404, 'NOT_FOUND', 'host not found')
        writeJson(response, 200, pairing)
        return
      }
    }

    if (request.method === 'GET') {
      const devicesMatch = /^\/v1\/hosts\/([^/]+)\/devices$/.exec(path)
      if (devicesMatch !== null) {
        const hostId = asHostId(pathParameter(devicesMatch, 1, 'hostId'))
        await requireHostAccess(request, hostId)
        const active = liveConnection(deviceConnections, hostId)
        const devices = await store.listDevices(hostId)
        writeJson(response, 200, {
          devices: devices.map((device) => ({
            deviceId: device.deviceId,
            ...(device.name === undefined ? {} : { name: device.name }),
            ...(device.platform === undefined ? {} : { platform: device.platform }),
            createdAt: device.createdAt,
            lastSeenAt: device.lastSeenAt,
            online: active !== undefined && active.deviceId === device.deviceId,
          })),
        })
        return
      }
    }

    if (request.method === 'POST') {
      const revokeMatch = /^\/v1\/hosts\/([^/]+)\/devices\/([^/]+)\/revoke$/.exec(path)
      if (revokeMatch !== null) {
        request.resume()
        const hostId = asHostId(pathParameter(revokeMatch, 1, 'hostId'))
        const deviceId = asDeviceId(pathParameter(revokeMatch, 2, 'deviceId'))
        await requireHostAccess(request, hostId)
        const revoked = await store.revokeDevice(hostId, deviceId)
        if (!revoked) throw new HttpError(404, 'NOT_FOUND', 'device not found')
        const wasActive = liveConnection(deviceConnections, hostId)?.deviceId === deviceId
        for (const connection of [...allConnections]) {
          if (
            connection.role !== 'device' ||
            connection.hostId !== hostId ||
            connection.deviceId !== deviceId
          ) {
            continue
          }
          if (deviceConnections.get(hostId) === connection) {
            deviceConnections.delete(hostId)
          }
          kickConnection(connection, 'revoked')
        }
        if (wasActive) {
          const hostConnection = liveConnection(hostConnections, hostId)
          if (hostConnection !== undefined) sendPairStatus(hostConnection, 'waiting')
        }
        log({ type: 'device_revoked', hostId, deviceId })
        writeJson(response, 200, { revoked: true })
        return
      }
    }

    if (
      staticRoot !== undefined &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      !path.startsWith('/v1/')
    ) {
      await serveStaticFile(request, response, staticRoot, path)
      return
    }

    request.resume()
    throw new HttpError(404, 'NOT_FOUND', 'not found')
  }

  async function requireHostAccess(
    request: IncomingMessage,
    pathHostId: HostId,
  ): Promise<HostId> {
    const header = request.headers.authorization
    if (header === undefined) throw authenticationFailed()
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
    const token = match?.[1]
    if (token === undefined) throw authenticationFailed()
    const tokenHostId = await store.authenticateHostToken(asHostToken(token))
    if (tokenHostId === undefined || tokenHostId !== pathHostId) throw authenticationFailed()
    await store.touchHost(tokenHostId)
    return tokenHostId
  }

  async function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    try {
      const auth = await authenticateUpgradeRequest(request)
      webSocketServer.handleUpgrade(request, socket, head, (ws) => {
        attachConnection(ws, auth)
      })
    } catch (error: unknown) {
      if (error instanceof HttpError) {
        rejectUpgrade(socket, error.status, error.code, error.message)
        return
      }
      log({ type: 'internal_error' })
      rejectUpgrade(socket, 500, 'INTERNAL', 'internal error')
    }
  }

  async function authenticateUpgradeRequest(request: IncomingMessage): Promise<ConnectionAuth> {
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://relay.invalid')
    } catch {
      throw new HttpError(400, 'WRONG_PARAM', 'invalid request URL')
    }
    if (url.pathname !== '/v1/ws') throw new HttpError(404, 'NOT_FOUND', 'not found')
    const role = url.searchParams.get('role')
    if (role !== 'host' && role !== 'device') {
      throw new HttpError(400, 'WRONG_PARAM', 'role must be host or device')
    }
    const token = url.searchParams.get('token')
    if (token === null || token.length === 0) throw authenticationFailed()

    if (role === 'host') {
      const hostId = await store.authenticateHostToken(asHostToken(token))
      if (hostId === undefined) throw authenticationFailed()
      await store.touchHost(hostId)
      return { role: 'host', hostId }
    }

    const device = await store.authenticateDeviceToken(asDeviceToken(token))
    if (device === undefined) throw authenticationFailed()
    await store.touchDevice(device.deviceId)
    return { role: 'device', hostId: device.hostId, deviceId: device.deviceId }
  }

  function attachConnection(ws: WebSocket, auth: ConnectionAuth): void {
    const connection: ActiveConnection = {
      ws,
      role: auth.role,
      hostId: auth.hostId,
      ...(auth.role === 'device' ? { deviceId: auth.deviceId } : {}),
      connectionId: asConnectionId(randomUUID()),
      greeted: false,
      lastSeenAt: now(),
    }
    allConnections.add(connection)
    let queue: Promise<void> = Promise.resolve()

    ws.on('message', (data, isBinary) => {
      if (closing) return
      connection.lastSeenAt = now()
      const text = isBinary ? undefined : rawDataText(data)
      queue = queue
        .then(() => handleIncomingMessage(connection, text, isBinary))
        .catch(() => {
          log({ type: 'internal_error' })
          failConnection(connection.ws, 'INTERNAL', 'internal error')
        })
    })
    ws.on('close', (code) => {
      log({
        type: 'connection_closed',
        role: connection.role,
        hostId: connection.hostId,
        connectionId: connection.connectionId,
        code: typeof code === 'number' && Number.isSafeInteger(code) ? code : 1006,
      })
      cleanupConnection(connection)
    })
    ws.on('error', (error: Error) => {
      log({
        type: 'socket_error',
        role: connection.role,
        hostId: connection.hostId,
        message: error.message.slice(0, 200),
      })
    })
    ws.on('pong', () => {
      connection.lastSeenAt = now()
    })
  }

  async function handleIncomingMessage(
    connection: ActiveConnection,
    text: string | undefined,
    isBinary: boolean,
  ): Promise<void> {
    if (closing || connection.ws.readyState !== WebSocket.OPEN) return
    if (isBinary || text === undefined) {
      failConnection(connection.ws, 'WRONG_PARAM', 'binary messages are not supported')
      return
    }

    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      failConnection(connection.ws, 'WRONG_PARAM', 'message must be valid JSON')
      return
    }

    let message: RelayControlMessage
    try {
      message = parseRelayControlMessage(value)
    } catch (error: unknown) {
      const detail = error instanceof ProtocolError ? error.message : 'invalid control message'
      failConnection(connection.ws, 'WRONG_PARAM', detail)
      return
    }

    if (!connection.greeted) {
      await handleHello(connection, message)
      return
    }

    switch (message.type) {
      case 'data':
        routeData(connection, text)
        return
      case 'ping':
        sendControl(connection.ws, { type: 'pong', ts: message.ts })
        return
      case 'pong':
        return
      case 'pair_status_query':
        sendPairStatus(connection, currentPairStatus(connection), message.clientTs)
        return
      default:
        failConnection(connection.ws, 'WRONG_PARAM', `unexpected ${message.type} message`)
    }
  }

  async function handleHello(
    connection: ActiveConnection,
    message: RelayControlMessage,
  ): Promise<void> {
    if (connection.role === 'host') {
      if (message.type !== 'host_hello') {
        failConnection(connection.ws, 'WRONG_PARAM', 'expected host_hello')
        return
      }
      if (message.hostId !== connection.hostId) {
        failConnection(connection.ws, 'WRONG_PARAM', 'hostId does not match token')
        return
      }
      await completeHostHello(connection)
      return
    }

    if (message.type !== 'device_hello') {
      failConnection(connection.ws, 'WRONG_PARAM', 'expected device_hello')
      return
    }
    if (
      message.hostId !== connection.hostId ||
      connection.deviceId === undefined ||
      (message.deviceId !== undefined && message.deviceId !== connection.deviceId)
    ) {
      failConnection(connection.ws, 'WRONG_PARAM', 'device identity does not match token')
      return
    }
    await completeDeviceHello(connection)
  }

  async function completeHostHello(connection: ActiveConnection): Promise<void> {
    const existing = liveConnection(hostConnections, connection.hostId)
    if (existing !== undefined && existing !== connection) {
      kickConnection(existing, 'replaced')
    }
    if (connection.ws.readyState !== WebSocket.OPEN) return

    connection.greeted = true
    hostConnections.set(connection.hostId, connection)
    await store.touchHost(connection.hostId)
    if (connection.ws.readyState !== WebSocket.OPEN) return

    const device = liveConnection(deviceConnections, connection.hostId)
    sendControl(connection.ws, {
      type: 'hello_ack',
      protocolVersion: PROTOCOL_VERSION,
      connectionId: connection.connectionId,
      hostId: connection.hostId,
      pairStatus: device === undefined ? 'waiting' : 'matched',
    })
    if (device !== undefined) sendPairStatus(device, 'matched')
    log({
      type: 'host_connected',
      hostId: connection.hostId,
      connectionId: connection.connectionId,
    })
  }

  async function completeDeviceHello(connection: ActiveConnection): Promise<void> {
    const existing = liveConnection(deviceConnections, connection.hostId)
    if (existing !== undefined && existing !== connection) {
      if (await store.noteTakeover(connection.hostId)) {
        if (connection.deviceId !== undefined) {
          log({
            type: 'session_conflict',
            hostId: connection.hostId,
            deviceId: connection.deviceId,
          })
        }
        failConnection(connection.ws, 'KICKED', 'session-conflict')
        return
      }
      kickConnection(existing, 'replaced')
      if (existing.deviceId !== undefined) {
        log({
          type: 'device_replaced',
          hostId: connection.hostId,
          deviceId: existing.deviceId,
        })
      }
    }
    if (connection.ws.readyState !== WebSocket.OPEN) return

    connection.greeted = true
    deviceConnections.set(connection.hostId, connection)
    if (connection.deviceId !== undefined) await store.touchDevice(connection.deviceId)
    if (connection.ws.readyState !== WebSocket.OPEN) return

    const host = liveConnection(hostConnections, connection.hostId)
    sendControl(connection.ws, {
      type: 'hello_ack',
      protocolVersion: PROTOCOL_VERSION,
      connectionId: connection.connectionId,
      hostId: connection.hostId,
      pairStatus: host === undefined ? 'offline' : 'matched',
    })
    if (host !== undefined) sendPairStatus(host, 'matched')
    if (connection.deviceId !== undefined) {
      log({
        type: 'device_connected',
        hostId: connection.hostId,
        deviceId: connection.deviceId,
        connectionId: connection.connectionId,
      })
    }
  }

  function routeData(connection: ActiveConnection, text: string): void {
    const peer =
      connection.role === 'host'
        ? liveConnection(deviceConnections, connection.hostId)
        : liveConnection(hostConnections, connection.hostId)
    if (peer === undefined || !sendText(peer.ws, text)) {
      sendControl(connection.ws, { type: 'error', code: 'DEVICE_OFFLINE' })
    }
  }

  function currentPairStatus(connection: ActiveConnection): PairStatus {
    if (connection.role === 'host') {
      return liveConnection(deviceConnections, connection.hostId) === undefined
        ? 'waiting'
        : 'matched'
    }
    return liveConnection(hostConnections, connection.hostId) === undefined ? 'offline' : 'matched'
  }

  function cleanupConnection(connection: ActiveConnection): void {
    if (!allConnections.delete(connection)) return
    if (connection.role === 'host') {
      if (hostConnections.get(connection.hostId) === connection) {
        hostConnections.delete(connection.hostId)
        const device = liveConnection(deviceConnections, connection.hostId)
        if (!closing && device !== undefined) sendPairStatus(device, 'offline')
      }
      if (connection.greeted) {
        log({
          type: 'host_disconnected',
          hostId: connection.hostId,
          connectionId: connection.connectionId,
        })
      }
      return
    }

    if (deviceConnections.get(connection.hostId) === connection) {
      deviceConnections.delete(connection.hostId)
      const host = liveConnection(hostConnections, connection.hostId)
      if (!closing && host !== undefined) sendPairStatus(host, 'waiting')
    }
    if (connection.greeted && connection.deviceId !== undefined) {
      log({
        type: 'device_disconnected',
        hostId: connection.hostId,
        deviceId: connection.deviceId,
        connectionId: connection.connectionId,
      })
    }
  }
}

function listen(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function displayHostFor(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1'
  if (host === '::') return '::1'
  return host
}

function liveConnection(
  connections: Map<string, ActiveConnection>,
  hostId: HostId,
): ActiveConnection | undefined {
  const connection = connections.get(hostId)
  if (connection === undefined || connection.ws.readyState !== WebSocket.OPEN) return undefined
  return connection
}

function sendControl(ws: WebSocket, message: RelayControlMessage): boolean {
  return sendText(ws, JSON.stringify(message))
}

function sendText(ws: WebSocket, text: string): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false
  try {
    ws.send(text)
    return true
  } catch {
    // The socket can close between the readyState check and send.
    return false
  }
}

function sendPairStatus(
  connection: ActiveConnection,
  pairStatus: PairStatus,
  clientTs?: number,
): void {
  sendControl(connection.ws, {
    type: 'pair_status_ack',
    pairStatus,
    ...(clientTs === undefined ? {} : { clientTs }),
  })
}

function failConnection(ws: WebSocket, code: RelayErrorCode, message: string): void {
  sendControl(ws, { type: 'error', code, message })
  closeSocket(ws, POLICY_CLOSE_CODE, code)
}

function kickConnection(connection: ActiveConnection, reason: 'replaced' | 'revoked'): void {
  sendControl(connection.ws, { type: 'kicked', reason })
  closeSocket(connection.ws, POLICY_CLOSE_CODE, reason)
}

function closeSocket(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason)
  } catch {
    // `close` throws only before the opening handshake completes.
    ws.terminate()
  }
}

function rawDataText(data: RawData): string | undefined {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return undefined
}

function rejectUpgrade(
  socket: Duplex,
  status: number,
  code: RelayHttpErrorCode,
  message: string,
): void {
  if (socket.destroyed) return
  const body = JSON.stringify({ error: { code, message } })
  socket.end(
    `HTTP/1.1 ${status} ${statusReason(status)}\r\n` +
      'content-type: application/json; charset=utf-8\r\n' +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      'connection: close\r\n' +
      '\r\n' +
      body,
  )
}

function statusReason(status: number): string {
  switch (status) {
    case 400:
      return 'Bad Request'
    case 401:
      return 'Unauthorized'
    case 404:
      return 'Not Found'
    case 410:
      return 'Gone'
    default:
      return 'Internal Server Error'
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (response.writableEnded) return
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  })
  response.end(text)
}

/** File extensions the phone shell is built from, mapped to response content types. */
const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json',
  woff: 'font/woff',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
}

/**
 * Serve one static file for the phone shell hosted by the relay.
 *
 * Requested paths are confined to `root`: the path is normalized under it and
 * any escape (`..`, backslashes, NUL) is rejected. `GET /` (and any directory
 * tail) maps to `index.html`. Responses are marked `no-cache` because the
 * deployment may be updated in place between phone visits.
 *
 * @throws unknown filesystem errors (not ENOENT/EACCES/ENOTDIR) to the caller's
 * 500 handler; expected misses answer 404 themselves.
 */
async function serveStaticFile(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  pathname: string,
): Promise<void> {
  if (response.writableEnded) return
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('bad request path\n')
    return
  }
  const segments = decoded.replaceAll('\\', '/').split('/').filter((segment) => segment !== '')
  if (segments.some((segment) => segment === '..' || segment.startsWith('.'))) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found\n')
    return
  }
  const relative = segments.length === 0 ? 'index.html' : segments.join('/')
  const target = resolve(root, relative)
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found\n')
    return
  }

  let info = await stat(target).catch(() => undefined)
  if (info?.isDirectory()) {
    info = await stat(resolve(target, 'index.html')).catch(() => undefined)
  }
  const file = info?.isFile() === true ? target : undefined
  if (file === undefined) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found\n')
    return
  }

  let body: Buffer
  try {
    body = await readFile(file)
  } catch (error) {
    if (isExpectedFsError(error)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found\n')
      return
    }
    throw error
  }
  const type = STATIC_CONTENT_TYPES[extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream'
  response.writeHead(200, {
    'content-type': type,
    'content-length': body.byteLength,
    'cache-control': 'no-cache',
  })
  response.end(request.method === 'HEAD' ? undefined : body)
}

/** Filesystem misses that mean "no such file" rather than "relay is broken". */
function isExpectedFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR'
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {  const declaredLength = request.headers['content-length']
  if (declaredLength !== undefined && Number(declaredLength) > MAX_HTTP_BODY_BYTES) {
    request.resume()
    throw new HttpError(400, 'WRONG_PARAM', 'request body too large')
  }

  const chunks: Buffer[] = []
  let total = 0
  let tooLarge = false
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_HTTP_BODY_BYTES) {
      tooLarge = true
      continue
    }
    chunks.push(buffer)
  }
  if (tooLarge) throw new HttpError(400, 'WRONG_PARAM', 'request body too large')
  if (total === 0) throw new HttpError(400, 'WRONG_PARAM', 'request body is required')

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'WRONG_PARAM', 'request body must be valid JSON')
  }
}

function parseRegisterBody(value: unknown): RegisterHostInput {
  const record = requireRecord(value, 'body')
  const hostId = asHostId(requireString(record.hostId, 'hostId'))
  const hostSecret = requireString(record.hostSecret, 'hostSecret')
  const hostName = requireString(record.hostName, 'hostName')
  if (record.protocolVersion !== undefined) {
    requireInteger(record.protocolVersion, 'protocolVersion', 1)
  }
  return { hostId, hostSecret, hostName }
}

function parseAuthBody(value: unknown): { password: string } {
  const record = requireRecord(value, 'body')
  return { password: requireString(record.password, 'password') }
}

function parseClaimBody(value: unknown): ClaimPairingInput {
  const record = requireRecord(value, 'body')
  return {
    hostId: asHostId(requireString(record.hostId, 'hostId')),
    pairToken: asPairToken(requireString(record.pairToken, 'pairToken')),
    ...(record.deviceName === undefined
      ? {}
      : { deviceName: requireString(record.deviceName, 'deviceName', true) }),
    ...(record.platform === undefined
      ? {}
      : { platform: requireString(record.platform, 'platform', true) }),
  }
}

function parseBody<T>(parser: (value: unknown) => T, value: unknown): T {
  try {
    return parser(value)
  } catch (error: unknown) {
    if (error instanceof ProtocolError) throw new HttpError(400, 'WRONG_PARAM', error.message)
    throw error
  }
}

function pathParameter(match: RegExpExecArray, index: number, name: string): string {
  const raw = match[index]
  if (raw === undefined) throw new HttpError(400, 'WRONG_PARAM', `missing ${name}`)
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    throw new HttpError(400, 'WRONG_PARAM', `invalid ${name} encoding`)
  }
  if (decoded.length === 0) throw new HttpError(400, 'WRONG_PARAM', `empty ${name}`)
  return decoded
}

/**
 * Reject cross-site "simple request" bodies on credential routes.
 *
 * A form or text/plain POST cannot carry `application/json` without a CORS
 * preflight, so requiring it (when the header is present at all) closes the
 * blind-POST hole that could burn a one-time pairing token.
 */
function requireJsonContentType(request: IncomingMessage): void {
  const header = request.headers['content-type']
  if (header === undefined) return
  const mediaType = header.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (mediaType === 'application/json') return
  throw new HttpError(415, 'WRONG_PARAM', 'content-type must be application/json')
}

function authenticationFailed(): HttpError {
  return new HttpError(401, 'AUTH_FAILED', 'authentication failed')
}
