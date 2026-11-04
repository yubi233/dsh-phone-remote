import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  MAX_PHYSICAL_FRAME_BYTES,
  PROTOCOL_VERSION,
  asHostId,
  asHostToken,
  parseRelayControlMessage,
} from '@dsh-web-remote/protocol'
import type { RelayControlMessage } from '@dsh-web-remote/protocol'
import { filePersistence } from '../src/persistence.ts'
import { MemoryRelayStore } from '../src/store.ts'
import { startRelayServer } from '../src/server.ts'
import type { RelayServer, RelayServerOptions } from '../src/server.ts'

interface JsonResponse<T> {
  status: number
  body: T
}

interface ErrorBody {
  error: { code: string; message: string }
}

interface HostSession {
  hostId: string
  hostSecret: string
  hostToken: string
}

interface ClaimResult {
  deviceId: string
  deviceToken: string
  hostId: string
  hostName?: string
}

interface DeviceEntry {
  deviceId: string
  name?: string
  platform?: string
  createdAt: number
  lastSeenAt: number
  online: boolean
}

interface PendingWaiter {
  predicate: (message: RelayControlMessage) => boolean
  resolve: (message: RelayControlMessage) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** WebSocket client that queues relay messages until a predicate matches. */
class TestClient {
  readonly socket: WebSocket
  readonly closed: Promise<{ code: number; reason: string }>
  private readonly inbox: RelayControlMessage[] = []
  private readonly waiters: PendingWaiter[] = []

  constructor(socket: WebSocket) {
    this.socket = socket
    this.closed = new Promise((resolve) => {
      socket.once('close', (code, reason) => {
        resolve({ code, reason: reason.toString() })
      })
    })
    socket.on('error', () => {
      // The close event carries the observable outcome; tests assert on it.
    })
    socket.on('message', (data, isBinary) => {
      if (isBinary) return
      const text = rawDataText(data)
      if (text === undefined) return
      let message: RelayControlMessage
      try {
        message = parseRelayControlMessage(JSON.parse(text))
      } catch {
        return
      }
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message))
      const waiter = waiterIndex === -1 ? undefined : this.waiters.splice(waiterIndex, 1)[0]
      if (waiter !== undefined) {
        clearTimeout(waiter.timer)
        waiter.resolve(message)
        return
      }
      this.inbox.push(message)
    })
    socket.once('close', () => {
      for (const waiter of this.waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('socket closed before the expected message'))
      }
      this.waiters.length = 0
    })
  }

  send(message: RelayControlMessage): void {
    this.socket.send(JSON.stringify(message))
  }

  sendRaw(text: string): void {
    this.socket.send(text)
  }

  waitFor(
    predicate: (message: RelayControlMessage) => boolean,
    timeoutMs = 3_000,
  ): Promise<RelayControlMessage> {
    const inboxIndex = this.inbox.findIndex(predicate)
    if (inboxIndex !== -1) {
      const message = this.inbox.splice(inboxIndex, 1)[0]
      if (message !== undefined) return Promise.resolve(message)
    }
    return new Promise((resolve, reject) => {
      let waiter: PendingWaiter | undefined
      const timer = setTimeout(() => {
        if (waiter === undefined) return
        const index = this.waiters.indexOf(waiter)
        if (index !== -1) this.waiters.splice(index, 1)
        reject(new Error('timed out waiting for relay message'))
      }, timeoutMs)
      waiter = { predicate, resolve, reject, timer }
      this.waiters.push(waiter)
    })
  }
}

let server: RelayServer | undefined
const sockets = new Set<WebSocket>()

afterEach(async () => {
  for (const socket of sockets) {
    try {
      socket.terminate()
    } catch {
      // The socket already finished its close handshake.
    }
  }
  sockets.clear()
  if (server !== undefined) {
    const running = server
    server = undefined
    await running.close()
  }
})

async function startTestServer(options: RelayServerOptions = {}): Promise<RelayServer> {
  const started = await startRelayServer({ port: 0, ...options })
  server = started
  return started
}

describe('relay pairing and data forwarding', () => {
  it('registers a host, pairs a device, and forwards data both ways', async () => {
    const started = await startTestServer()
    const host = await registerHost(started)
    const device = await connectDevice(started, host, 'phone')

    expect(device.ack).toMatchObject({ type: 'hello_ack', pairStatus: 'offline' })
    device.client.send({ type: 'data', payload: { early: true } })
    const offline = await device.client.waitFor((message) => message.type === 'error')
    expect(offline).toMatchObject({ type: 'error', code: 'DEVICE_OFFLINE' })

    const hostClient = await connectHost(started, host)
    expect(hostClient.ack).toMatchObject({ type: 'hello_ack', pairStatus: 'matched' })
    const matched = await device.client.waitFor(
      (message) => message.type === 'pair_status_ack' && message.pairStatus === 'matched',
    )
    expect(matched).toMatchObject({ type: 'pair_status_ack', pairStatus: 'matched' })

    device.client.send({ type: 'data', payload: { from: 'device', value: 1 } })
    const toHost = await hostClient.client.waitFor((message) => message.type === 'data')
    expect(toHost).toMatchObject({ type: 'data', payload: { from: 'device', value: 1 } })

    hostClient.client.send({ type: 'data', payload: { from: 'host', value: 2 } })
    const toDevice = await device.client.waitFor((message) => message.type === 'data')
    expect(toDevice).toMatchObject({ type: 'data', payload: { from: 'host', value: 2 } })
  })

  it('rejects a pairing token after its first use', async () => {
    const started = await startTestServer()
    const host = await registerHost(started)
    const pairing = await createPairing(started, host)

    const first = await claimPairing(started, host, pairing.pairToken)
    expect(first.deviceToken.length).toBeGreaterThan(20)

    const second = await postJson<ErrorBody>(started, '/v1/pair/claim', {
      hostId: host.hostId,
      pairToken: pairing.pairToken,
    })
    expect(second.status).toBe(410)
    expect(second.body.error.code).toBe('PAIRING_INVALID')
  })

  it('rejects a pairing token after its TTL', async () => {
    let clock = 1_000_000
    const started = await startTestServer({ now: () => clock, pairingTtlMs: 5_000 })
    const host = await registerHost(started)
    const pairing = await createPairing(started, host)

    clock += 5_000
    const expired = await postJson<ErrorBody>(started, '/v1/pair/claim', {
      hostId: host.hostId,
      pairToken: pairing.pairToken,
    })
    expect(expired.status).toBe(410)
    expect(expired.body.error.code).toBe('PAIRING_INVALID')
  })

  it('answers the claim preflight and exposes the claim response cross-origin', async () => {
    const started = await startTestServer()
    const host = await registerHost(started)
    const pairing = await createPairing(started, host)

    const preflight = await fetch(`${started.httpUrl}/v1/pair/claim`, { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')
    expect(preflight.headers.get('access-control-allow-headers')).toContain('content-type')

    const claimed = await fetch(`${started.httpUrl}/v1/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hostId: host.hostId,
        pairToken: pairing.pairToken,
        deviceName: 'phone',
        platform: 'test',
      }),
    })
    expect(claimed.status).toBe(200)
    expect(claimed.headers.get('access-control-allow-origin')).toBe('*')
    const body = (await claimed.json()) as ClaimResult
    expect(body.deviceToken.length).toBeGreaterThan(20)

    // A spent pairing must still be readable cross-origin: the phone page
    // renders the failure reason from this response.
    const replay = await fetch(`${started.httpUrl}/v1/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hostId: host.hostId,
        pairToken: pairing.pairToken,
        deviceName: 'phone',
        platform: 'test',
      }),
    })
    expect(replay.status).toBe(410)
    expect(replay.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('rejects wrong bearer tokens and tokens used for the wrong role', async () => {
    const started = await startTestServer()
    const host = await registerHost(started)
    const pairing = await createPairing(started, host)

    const badToken = await postJson<ErrorBody>(
      started,
      `/v1/hosts/${encodeURIComponent(host.hostId)}/pairing`,
      {},
      'not-a-host-token',
    )
    expect(badToken.status).toBe(401)
    expect(badToken.body.error.code).toBe('AUTH_FAILED')

    const claimed = await claimPairing(started, host, pairing.pairToken)
    const wrongHttpRole = await postJson<ErrorBody>(
      started,
      `/v1/hosts/${encodeURIComponent(host.hostId)}/pairing`,
      {},
      claimed.deviceToken,
    )
    expect(wrongHttpRole.status).toBe(401)

    expect(await upgradeStatus(started, 'host', 'not-a-host-token')).toBe(401)
    expect(await upgradeStatus(started, 'device', host.hostToken)).toBe(401)
    expect(await upgradeStatus(started, 'host', claimed.deviceToken)).toBe(401)
    expect(await upgradeStatus(started, 'device', '')).toBe(401)
  })

  it('replaces the first device and rejects an immediate second takeover', async () => {
    const started = await startTestServer()
    const host = await registerHost(started)

    const first = await connectDevice(started, host, 'first')
    const second = await connectDevice(started, host, 'second')
    const kicked = await first.client.waitFor((message) => message.type === 'kicked')
    expect(kicked).toEqual({ type: 'kicked', reason: 'replaced' })
    await first.client.closed
    expect(second.ack).toMatchObject({ type: 'hello_ack', pairStatus: 'offline' })

    const thirdClaim = await pairAndClaim(started, host, 'third')
    const third = await connect(started, 'device', thirdClaim.deviceToken)
    third.send(deviceHello(host, thirdClaim.deviceId, 'third'))
    const conflict = await third.waitFor((message) => message.type === 'error')
    expect(conflict).toMatchObject({
      type: 'error',
      code: 'KICKED',
      message: 'session-conflict',
    })
    const thirdClose = await third.closed
    expect(thirdClose.code).toBe(1008)

    second.client.send({ type: 'ping', ts: 42 })
    const pong = await second.client.waitFor((message) => message.type === 'pong')
    expect(pong).toEqual({ type: 'pong', ts: 42 })
  })

  it('revokes a device, closes its socket, and invalidates its token', async () => {
    const started = await startTestServer()
    const host = await registerHost(started)
    const device = await connectDevice(started, host, 'phone')

    const before = await getJson<{ devices: DeviceEntry[] }>(
      started,
      `/v1/hosts/${encodeURIComponent(host.hostId)}/devices`,
      host.hostToken,
    )
    expect(before.status).toBe(200)
    expect(before.body.devices).toEqual([
      expect.objectContaining({ deviceId: device.deviceId, online: true }),
    ])

    const revoked = await postJson<{ revoked: boolean }>(
      started,
      `/v1/hosts/${encodeURIComponent(host.hostId)}/devices/${encodeURIComponent(device.deviceId)}/revoke`,
      {},
      host.hostToken,
    )
    expect(revoked.status).toBe(200)
    expect(revoked.body).toEqual({ revoked: true })

    const kicked = await device.client.waitFor((message) => message.type === 'kicked')
    expect(kicked).toEqual({ type: 'kicked', reason: 'revoked' })
    await device.client.closed
    expect(await upgradeStatus(started, 'device', device.deviceToken)).toBe(401)

    const after = await getJson<{ devices: DeviceEntry[] }>(
      started,
      `/v1/hosts/${encodeURIComponent(host.hostId)}/devices`,
      host.hostToken,
    )
    expect(after.body.devices).toEqual([])
  })

  it('rejects a hello whose identity does not match the token', async () => {
    const started = await startTestServer()
    const host = await registerHost(started)
    const claimed = await pairAndClaim(started, host, 'phone')
    const client = await connect(started, 'device', claimed.deviceToken)

    client.send({
      type: 'device_hello',
      protocolVersion: PROTOCOL_VERSION,
      hostId: asHostId('some-other-host'),
      deviceId: claimed.deviceId,
    })
    const error = await client.waitFor((message) => message.type === 'error')
    expect(error).toMatchObject({ type: 'error', code: 'WRONG_PARAM' })
    await client.closed
  })

  it('closes a connection that exceeds the maximum frame size', async () => {
    const started = await startTestServer()
    const host = await registerHost(started)
    const device = await connectDevice(started, host, 'phone')

    device.client.sendRaw(
      `{"type":"data","payload":"${'x'.repeat(MAX_PHYSICAL_FRAME_BYTES + 1024)}"}`,
    )
    const close = await device.client.closed
    expect([1006, 1009]).toContain(close.code)

    const health = await fetch(`${started.httpUrl}/health`)
    expect(health.status).toBe(200)
  })
})

async function registerHost(started: RelayServer): Promise<HostSession> {
  const hostId = `host-${randomUUID()}`
  const hostSecret = `secret-${randomUUID()}`
  const response = await postJson<{
    hostToken: string
    expiresAt: number
    protocolVersion: number
  }>(started, '/v1/hosts/register', {
    hostId,
    hostSecret,
    hostName: 'Test Host',
    protocolVersion: PROTOCOL_VERSION,
  })
  expect(response.status).toBe(200)
  expect(response.body.protocolVersion).toBe(PROTOCOL_VERSION)
  return { hostId, hostSecret, hostToken: response.body.hostToken }
}

async function createPairing(
  started: RelayServer,
  host: HostSession,
): Promise<{ pairToken: string; pairingCode: string; expiresAt: number }> {
  const response = await postJson<{
    pairToken: string
    pairingCode: string
    expiresAt: number
  }>(
    started,
    `/v1/hosts/${encodeURIComponent(host.hostId)}/pairing`,
    {},
    host.hostToken,
  )
  expect(response.status).toBe(200)
  expect(response.body.pairingCode).toMatch(/^\d{8}$/)
  return response.body
}

async function pairAndClaim(
  started: RelayServer,
  host: HostSession,
  deviceName: string,
): Promise<ClaimResult> {
  const pairing = await createPairing(started, host)
  return claimPairing(started, host, pairing.pairToken, deviceName)
}

async function claimPairing(
  started: RelayServer,
  host: HostSession,
  pairToken: string,
  deviceName = 'phone',
): Promise<ClaimResult> {
  const response = await postJson<ClaimResult>(started, '/v1/pair/claim', {
    hostId: host.hostId,
    pairToken,
    deviceName,
    platform: 'test',
  })
  expect(response.status).toBe(200)
  return response.body
}

async function connectDevice(
  started: RelayServer,
  host: HostSession,
  deviceName: string,
): Promise<{ client: TestClient; deviceId: string; deviceToken: string; ack: RelayControlMessage }> {
  const claimed = await pairAndClaim(started, host, deviceName)
  const client = await connect(started, 'device', claimed.deviceToken)
  client.send(deviceHello(host, claimed.deviceId, deviceName))
  const ack = await client.waitFor((message) => message.type === 'hello_ack')
  return { client, deviceId: claimed.deviceId, deviceToken: claimed.deviceToken, ack }
}

async function connectHost(
  started: RelayServer,
  host: HostSession,
): Promise<{ client: TestClient; ack: RelayControlMessage }> {
  const client = await connect(started, 'host', host.hostToken)
  client.send({
    type: 'host_hello',
    protocolVersion: PROTOCOL_VERSION,
    hostId: asHostId(host.hostId),
    hostName: 'Test Host',
  })
  const ack = await client.waitFor((message) => message.type === 'hello_ack')
  return { client, ack }
}

function deviceHello(
  host: HostSession,
  deviceId: string,
  deviceName: string,
): RelayControlMessage {
  return {
    type: 'device_hello',
    protocolVersion: PROTOCOL_VERSION,
    hostId: asHostId(host.hostId),
    deviceId,
    deviceName,
  }
}

function connect(
  started: RelayServer,
  role: 'host' | 'device',
  token: string,
): Promise<TestClient> {
  const socket = new WebSocket(
    `${started.url}?role=${role}&token=${encodeURIComponent(token)}`,
  )
  sockets.add(socket)
  return new Promise((resolve, reject) => {
    function onOpen(): void {
      socket.off('error', onError)
      resolve(new TestClient(socket))
    }
    function onError(error: Error): void {
      socket.off('open', onOpen)
      reject(error)
    }
    socket.once('open', onOpen)
    socket.once('error', onError)
  })
}

function upgradeStatus(
  started: RelayServer,
  role: 'host' | 'device',
  token: string,
): Promise<number> {
  const socket = new WebSocket(
    `${started.url}?role=${role}&token=${encodeURIComponent(token)}`,
  )
  sockets.add(socket)
  return new Promise((resolve, reject) => {
    socket.once('open', () => {
      socket.terminate()
      reject(new Error('expected the relay to reject the upgrade'))
    })
    socket.once('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0
      response.resume()
      try {
        socket.terminate()
      } catch {
        // The handshake already failed and the socket is closed.
      }
      resolve(status)
    })
    socket.once('error', reject)
  })
}

function rawDataText(data: WebSocket.RawData): string | undefined {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return undefined
}

async function postJson<T>(
  started: RelayServer,
  path: string,
  body: unknown,
  token?: string,
): Promise<JsonResponse<T>> {
  const response = await fetch(`${started.httpUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as T }
}

async function getJson<T>(
  started: RelayServer,
  path: string,
  token: string,
): Promise<JsonResponse<T>> {
  const response = await fetch(`${started.httpUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return { status: response.status, body: (await response.json()) as T }
}

describe('credential route content-type', () => {
  it('rejects simple cross-site POST media types on the claim route', async () => {
    const started = await startRelayServer()
    try {
      const response = await fetch(`${started.httpUrl}/v1/pair/claim`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ hostId: 'host-1', pairToken: 'tok' }),
      })
      expect(response.status).toBe(415)
      const body = (await response.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('WRONG_PARAM')
    } finally {
      await started.close()
    }
  })

  it('still accepts application/json with parameters and missing headers', async () => {
    const started = await startRelayServer()
    try {
      const withParams = await fetch(`${started.httpUrl}/v1/pair/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ hostId: 'host-1', pairToken: 'tok' }),
      })
      expect(withParams.status).toBe(400)

      // A raw body carries no auto content-type from fetch.
      const withoutHeader = await fetch(`${started.httpUrl}/v1/pair/claim`, {
        method: 'POST',
        body: new TextEncoder().encode(JSON.stringify({ hostId: 'host-1', pairToken: 'tok' })),
      })
      expect(withoutHeader.status).toBe(400)
    } finally {
      await started.close()
    }
  })
})

describe('public deployment hardening', () => {
  it('keys the rate limiter on the proxy-observed IP when trustProxy is on', async () => {
    const started = await startRelayServer({ trustProxy: true })
    try {
      // Two "clients" behind one proxy socket: distinct X-Forwarded-For tails.
      const headers = (ip: string): HeadersInit => ({
        'content-type': 'application/json',
        'x-forwarded-for': `10.9.9.9, ${ip}`,
      })
      const first = await fetch(`${started.httpUrl}/v1/hosts/register`, {
        method: 'POST',
        headers: headers('203.0.113.1'),
        body: JSON.stringify({ hostId: 'host-a', hostSecret: 's', hostName: 'a' }),
      })
      const second = await fetch(`${started.httpUrl}/v1/hosts/register`, {
        method: 'POST',
        headers: headers('203.0.113.2'),
        body: JSON.stringify({ hostId: 'host-b', hostSecret: 's', hostName: 'b' }),
      })
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)

      // The rightmost hop is the one counted: client-supplied junk on the
      // left cannot rotate the bucket, so the 31st request is limited.
      const spoofed: string[] = []
      for (let index = 0; index < 31; index += 1) {
        const response = await fetch(`${started.httpUrl}/v1/hosts/register`, {
          method: 'POST',
          headers: headers('203.0.113.3'),
          body: JSON.stringify({ hostId: 'host-a', hostSecret: 's', hostName: 'a' }),
        })
        spoofed.push(String(response.status))
      }
      expect(spoofed.at(-1)).toBe('429')
    } finally {
      await started.close()
    }
  })

  it('keeps socket-based keying when trustProxy is off', async () => {
    const started = await startRelayServer()
    try {
      const response = await fetch(`${started.httpUrl}/v1/hosts/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.99' },
        body: JSON.stringify({ hostId: 'host-a', hostSecret: 's', hostName: 'a' }),
      })
      expect(response.status).toBe(200)
    } finally {
      await started.close()
    }
  })

  it('requires the registration token when configured', async () => {
    const started = await startRelayServer({ registrationToken: 's3cret' })
    try {
      const missing = await fetch(`${started.httpUrl}/v1/hosts/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostId: 'host-a', hostSecret: 's', hostName: 'a' }),
      })
      expect(missing.status).toBe(401)

      const wrong = await fetch(`${started.httpUrl}/v1/hosts/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-registration-token': 'wrong' },
        body: JSON.stringify({ hostId: 'host-a', hostSecret: 's', hostName: 'a' }),
      })
      expect(wrong.status).toBe(401)

      const token = await started.store.issueHostToken(asHostId('host-a'))
      expect(token).toBeUndefined()

      const right = await fetch(`${started.httpUrl}/v1/hosts/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-registration-token': 's3cret' },
        body: JSON.stringify({ hostId: 'host-a', hostSecret: 's', hostName: 'a' }),
      })
      expect(right.status).toBe(200)
      const issued = await started.store.issueHostToken(asHostId('host-a'))
      expect(issued).toBeDefined()
    } finally {
      await started.close()
    }
  })

  it('persists pairings and tokens across store instances', async () => {
    const writes: string[] = []
    const persistence = {
      load: (): string | undefined => writes.at(-1),
      save: (snapshot: string): void => {
        writes.push(snapshot)
      },
    }
    const first = new MemoryRelayStore({ persistence, persistDelayMs: 5, now: () => 1_000 })
    await first.registerHost({ hostId: asHostId('host-p'), hostSecret: 'secret-1', hostName: 'p' })
    const token = await first.issueHostToken(asHostId('host-p'))
    expect(token).toBeDefined()
    const pairing = await first.createPairing(asHostId('host-p'), { ttlMs: 60_000 })
    expect(pairing).toBeDefined()
    first.flush()
    expect(writes.length).toBeGreaterThan(0)

    const second = new MemoryRelayStore({ persistence, persistDelayMs: 5, now: () => 2_000 })
    // The host token survives the restart.
    await expect(second.authenticateHostToken(token!.token)).resolves.toBe('host-p')
    // The pairing token survives and is claimable exactly once.
    const claim = await second.claimPairing({
      hostId: asHostId('host-p'),
      pairToken: pairing!.pairToken,
      deviceName: 'phone',
    })
    expect(claim.ok).toBe(true)
    const deviceId = claim.ok ? claim.deviceId : undefined
    const deviceToken = claim.ok ? claim.deviceToken : undefined
    await expect(second.authenticateDeviceToken(deviceToken!)).resolves.toEqual({
      hostId: 'host-p',
      deviceId,
    })
  })

  it('drops expired tokens and corrupts nothing on a bad snapshot', async () => {
    const writes: string[] = []
    const persistence = {
      load: (): string | undefined => writes.at(-1),
      save: (snapshot: string): void => {
        writes.push(snapshot)
      },
    }
    const first = new MemoryRelayStore({
      persistence,
      persistDelayMs: 5,
      now: () => 1_000,
      hostTokenTtlMs: 500,
    })
    await first.registerHost({ hostId: asHostId('host-x'), hostSecret: 's', hostName: 'x' })
    const shortToken = await first.issueHostToken(asHostId('host-x'))
    expect(shortToken).toBeDefined()
    first.flush()

    const second = new MemoryRelayStore({ persistence, persistDelayMs: 5, now: () => 9_000 })
    await expect(second.authenticateHostToken(shortToken!.token)).resolves.toBeUndefined()

    const broken = new MemoryRelayStore({
      persistence: { load: () => '{corrupt', save: () => undefined },
      now: () => 9_000,
    })
    await broken.registerHost({ hostId: asHostId('host-y'), hostSecret: 's', hostName: 'y' })
    await expect(broken.authenticateHostToken(asHostToken('nope'))).resolves.toBeUndefined()
  })

  it('writes file snapshots atomically and reloads them', async () => {
    const path = join(tmpdir(), `dsh-relay-test-${String(process.pid)}-${String(Date.now())}.json`)
    try {
      const first = new MemoryRelayStore({ persistence: filePersistence(path), persistDelayMs: 5 })
      await first.registerHost({ hostId: asHostId('host-f'), hostSecret: 'sf', hostName: 'f' })
      const token = await first.issueHostToken(asHostId('host-f'))
      first.flush()
      expect(existsSync(path)).toBe(true)
      expect(existsSync(`${path}.tmp-${String(process.pid)}`)).toBe(false)

      const second = new MemoryRelayStore({ persistence: filePersistence(path), persistDelayMs: 5 })
      await expect(second.authenticateHostToken(token!.token)).resolves.toBe('host-f')
    } finally {
      rmSync(path, { force: true })
    }
  })
})

describe('relay static shell hosting', () => {
  function writeShell(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-static-'))
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>phone</body></html>\n')
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("phone")\n')
    writeFileSync(join(dir, '.secret'), 'nope\n')
    return dir
  }

  it('serves the phone shell for non-API paths with typed responses', async () => {
    const dir = writeShell()
    try {
      const started = await startTestServer({ staticDir: dir })

      const index = await fetch(`${started.httpUrl}/`)
      expect(index.status).toBe(200)
      expect(index.headers.get('content-type')).toContain('text/html')
      expect(await index.text()).toContain('phone')

      const script = await fetch(`${started.httpUrl}/assets/app.js`)
      expect(script.status).toBe(200)
      expect(script.headers.get('content-type')).toContain('text/javascript')

      const head = await fetch(`${started.httpUrl}/`, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  it('keeps API routes authoritative and misses readable', async () => {
    const dir = writeShell()
    try {
      const started = await startTestServer({ staticDir: dir })

      const missing = await fetch(`${started.httpUrl}/no-such-file.html`)
      expect(missing.status).toBe(404)

      const api = await fetch(`${started.httpUrl}/v1/auth/status`)
      expect(api.status).toBe(200)
      expect(api.headers.get('content-type')).toContain('application/json')

      const health = await fetch(`${started.httpUrl}/health`)
      expect(health.status).toBe(200)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  it('refuses dotfiles and path escapes outside the shell root', async () => {
    const dir = writeShell()
    try {
      const started = await startTestServer({ staticDir: dir })

      const dotfile = await fetch(`${started.httpUrl}/.secret`)
      expect(dotfile.status).toBe(404)

      const escaped = await fetch(`${started.httpUrl}/..%2F..%2F..%2Fetc%2Fpasswd`)
      expect(escaped.status).toBe(404)

      const encoded = await fetch(`${started.httpUrl}/%2e%2e/etc/passwd`)
      expect(encoded.status).toBe(404)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
})
