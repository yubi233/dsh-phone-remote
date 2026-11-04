import {
  ACK_WATCHDOG_MS,
  FrameAssembler,
  HEARTBEAT_INTERVAL_MS,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  OutboundReplayBuffer,
  asHostId,
  encodeMessage,
  parseAppPayload,
  parseRelayControlMessage,
} from '@dsh-web-remote/protocol'
import type {
  AppPayload,
  FrameMeta,
  RelayControlMessage,
  RelaySocket,
  RelaySocketFactory,
} from '@dsh-web-remote/protocol'
import { AsyncQueue } from './bridge.ts'
import type { HostBridge, HostRpcResult } from './bridge.ts'
import { PairingClient } from './pairing.ts'
import type { DeviceRecord, PairingOffer } from './pairing.ts'
import { createNodeSocketFactory } from './socket-node.ts'

/** Unary results above this serialized size travel as rpc-frame fragments. */
const RPC_RESULT_FRAGMENT_THRESHOLD = 512 * 1024

/** Configuration for the relay-facing Host connection. */
export interface HostRemoteConfig {
  /** Relay HTTP origin used for registration, pairing, and device calls. */
  relayHttpUrl: string
  /** Relay WebSocket URL the Host connects to. */
  relayWsUrl: string
  /** Stable Host identity minted by this Host. */
  hostId: string
  /** Long-lived secret the relay uses to authenticate the Host. */
  hostSecret: string
  /** Human-readable Host name advertised to devices. */
  hostName: string
  /** Optional Host build version advertised in `hello-ack`. */
  hostVersion?: string
  /** Capability tags advertised in `hello-ack`. */
  capabilities?: string[]
  /** Browser pairing page base URL; the pairing query is appended verbatim. */
  pairingUrlBase?: string
  /** Relay socket factory; defaults to the `ws` Node adapter. */
  createSocket?: RelaySocketFactory
  /** Fetch implementation used for relay HTTP calls. */
  fetchImpl?: typeof fetch
  /**
   * Value sent as `x-registration-token` when the relay requires one
   * (`RELAY_REGISTRATION_TOKEN` on public deployments). Optional.
   */
  registrationToken?: string
  /** Clock used for heartbeats, token liveness, and replay timestamps. */
  now?: () => number
  /** Heartbeat ping interval in milliseconds. */
  heartbeatIntervalMs?: number
  /** Maximum time without inbound relay traffic before the Host reconnects. */
  ackWatchdogMs?: number
  /** First reconnect delay in milliseconds. */
  reconnectMinMs?: number
  /** Maximum reconnect delay in milliseconds. */
  reconnectMaxMs?: number
}

/** Lifecycle state of the relay connection. */
export type HostRemoteState = 'idle' | 'connecting' | 'online' | 'offline' | 'stopped'

/** Relay-level error surfaced to diagnostics. */
export interface HostRemoteError {
  /** Relay or transport error code. */
  code: string
  /** Optional human-readable detail. */
  message?: string
}

interface HelloWait {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

interface StreamState {
  streamId: string
  generation: number
  seq: number
  messageSeq: number
  recoveryId?: string
  uplink: AsyncQueue<unknown>
  controller: AbortController
  closed: boolean
}

type RpcCallPayload = Extract<AppPayload, { type: 'rpc-call' }>
type RpcOpenPayload = Extract<AppPayload, { type: 'rpc-open' }>

const HELLO_TIMEOUT_MS = 10_000
/** Cap on concurrently reassembling inbound fragmented requests. */
const MAX_INBOUND_ASSEMBLIES = 32

/**
 * Host side of one relay connection.
 *
 * Owns registration, the WebSocket handshake, heartbeat/watchdog, automatic
 * reconnect with exponential backoff, replay of unacknowledged stream frames,
 * and dispatch of device RPC calls into a {@link HostBridge}.
 */
export class HostRemote {
  readonly #bridge: HostBridge
  readonly #pairing: PairingClient
  readonly #createSocket: RelaySocketFactory
  readonly #now: () => number
  readonly #relayWsUrl: string
  readonly #hostId: string
  readonly #hostName: string
  readonly #hostVersion: string | undefined
  readonly #capabilities: readonly string[]
  readonly #protocolVersion = PROTOCOL_VERSION
  readonly #heartbeatIntervalMs: number
  readonly #ackWatchdogMs: number
  readonly #reconnectMinMs: number
  readonly #reconnectMaxMs: number
  readonly #replay = new OutboundReplayBuffer()
  readonly #streams = new Map<string, StreamState>()
  readonly #inboundAssemblies = new Map<string, FrameAssembler>()
  readonly #stateListeners = new Set<(state: HostRemoteState) => void>()
  #state: HostRemoteState = 'idle'
  #running = false
  #stopped = false
  #initialConnecting = false
  #startPromise: Promise<void> | undefined
  #socket: RelaySocket | undefined
  #socketOpen = false
  #ready = false
  #hello: HelloWait | undefined
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined
  #watchdogTimer: ReturnType<typeof setTimeout> | undefined
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #reconnectAttempt = 0
  #lastError: HostRemoteError | undefined

  constructor(config: HostRemoteConfig, bridge: HostBridge) {
    this.#bridge = bridge
    this.#relayWsUrl = configString(config.relayWsUrl, 'relayWsUrl')
    this.#hostId = configString(config.hostId, 'hostId')
    this.#hostName = configString(config.hostName, 'hostName')
    this.#hostVersion =
      config.hostVersion === undefined
        ? undefined
        : configString(config.hostVersion, 'hostVersion')
    const capabilities = config.capabilities ?? []
    if (!Array.isArray(capabilities) || !capabilities.every((item) => typeof item === 'string')) {
      throw new Error('capabilities must be a string array')
    }
    this.#capabilities = [...capabilities]
    this.#heartbeatIntervalMs = positiveNumber(
      config.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
      'heartbeatIntervalMs',
    )
    this.#ackWatchdogMs = positiveNumber(config.ackWatchdogMs ?? ACK_WATCHDOG_MS, 'ackWatchdogMs')
    this.#reconnectMinMs = positiveNumber(config.reconnectMinMs ?? 1_000, 'reconnectMinMs')
    this.#reconnectMaxMs = positiveNumber(config.reconnectMaxMs ?? 30_000, 'reconnectMaxMs')
    if (this.#reconnectMinMs > this.#reconnectMaxMs) {
      throw new Error('reconnectMinMs must not exceed reconnectMaxMs')
    }
    this.#now = config.now ?? Date.now
    this.#createSocket = config.createSocket ?? createNodeSocketFactory()
    this.#pairing = new PairingClient({
      relayHttpUrl: config.relayHttpUrl,
      hostId: config.hostId,
      hostSecret: config.hostSecret,
      hostName: config.hostName,
      ...(config.pairingUrlBase === undefined ? {} : { pairingUrlBase: config.pairingUrlBase }),
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
      ...(config.registrationToken === undefined
        ? {}
        : { registrationToken: config.registrationToken }),
    })
  }

  /** Current connection state. */
  get state(): HostRemoteState {
    return this.#state
  }

  /** Last relay-level error observed on this Host, if any. */
  get lastError(): HostRemoteError | undefined {
    const error = this.#lastError
    return error === undefined ? undefined : { ...error }
  }

  /**
   * Subscribe to connection-state changes.
   *
   * @param listener Called with each new state.
   * @returns Disposer that removes the listener.
   */
  onState(listener: (state: HostRemoteState) => void): () => void {
    this.#stateListeners.add(listener)
    return (): void => {
      this.#stateListeners.delete(listener)
    }
  }

  /**
   * Register with the relay, connect, and resolve once `hello_ack` arrives.
   *
   * Repeated calls while running are no-ops. A failed initial start rejects and
   * may be retried; automatic reconnect applies after a successful start.
   */
  async start(): Promise<void> {
    if (this.#stopped) throw new Error('HostRemote is stopped')
    if (this.#startPromise !== undefined) return await this.#startPromise
    if (this.#running) return
    this.#running = true
    this.#initialConnecting = true
    const startPromise = this.#connectOnce()
    this.#startPromise = startPromise
    try {
      await startPromise
    } catch (error) {
      if (!this.#stopped) {
        this.#running = false
        this.#ready = false
        this.#clearConnectionTimers()
        this.#setState('offline')
      }
      throw error
    } finally {
      this.#initialConnecting = false
      if (this.#startPromise === startPromise) this.#startPromise = undefined
    }
  }

  /** Close the relay connection and release every timer and stream. Idempotent. */
  async stop(): Promise<void> {
    if (this.#stopped) return
    this.#stopped = true
    this.#running = false
    this.#clearReconnectTimer()
    this.#clearConnectionTimers()
    const socket = this.#socket
    this.#socket = undefined
    this.#socketOpen = false
    this.#ready = false
    this.#rejectHello(new Error('HostRemote stopped'))
    for (const stream of [...this.#streams.values()]) this.#finishStream(stream)
    this.#streams.clear()
    if (socket !== undefined) {
      try {
        socket.close(1000, 'stopped')
      } catch {
        // The socket is already on its way down; no further cleanup is needed.
      }
    }
    this.#setState('stopped')
  }

  /** Mint a one-time pairing offer. See {@link PairingClient.createPairing}. */
  async createPairing(): Promise<PairingOffer> {
    return await this.#pairing.createPairing()
  }

  /** List devices paired with this Host. See {@link PairingClient.listDevices}. */
  async listDevices(): Promise<DeviceRecord[]> {
    return await this.#pairing.listDevices()
  }

  /** Revoke one paired device. See {@link PairingClient.revokeDevice}. */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.#pairing.revokeDevice(deviceId)
  }

  async #connectOnce(): Promise<void> {
    if (!this.#running || this.#stopped) throw new Error('HostRemote is not running')
    this.#setState('connecting')
    this.#ready = false
    let token = await this.#pairing.register(this.#now())
    if (!this.#running || this.#stopped) {
      throw new Error('HostRemote stopped during registration')
    }
    let socket: RelaySocket
    try {
      socket = await this.#createSocket(this.#socketUrl(token.hostToken))
    } catch (error) {
      if (!isAuthRejection(error)) throw error
      // The relay no longer knows the cached token (restart without a
      // persisted store, or a revoked host). Re-register once instead of
      // retrying the dead token until it expires.
      this.#pairing.invalidate()
      token = await this.#pairing.register(this.#now())
      if (!this.#running || this.#stopped) {
        throw new Error('HostRemote stopped during registration')
      }
      socket = await this.#createSocket(this.#socketUrl(token.hostToken))
    }
    if (!this.#running || this.#stopped) {
      try {
        socket.close(1000, 'stopped')
      } catch {
        // The socket never became the active connection.
      }
      throw new Error('HostRemote stopped during connect')
    }
    const hello = createHelloWait()
    this.#installSocket(socket, hello)
    await hello.promise
  }

  #installSocket(socket: RelaySocket, hello: HelloWait): void {
    this.#socket = socket
    this.#socketOpen = false
    this.#ready = false
    this.#hello = hello
    hello.timer = setTimeout(() => {
      if (this.#hello !== hello) return
      this.#dropSocket(socket, 4008, 'hello_ack timeout')
    }, HELLO_TIMEOUT_MS)
    socket.onOpen(() => this.#handleSocketOpen(socket))
    socket.onMessage((text) => this.#handleInbound(socket, text))
    socket.onClose((info) => this.#handleSocketClosed(socket, info))
  }

  #handleSocketOpen(socket: RelaySocket): void {
    if (this.#socket !== socket) return
    this.#socketOpen = true
    this.#sendControl({
      type: 'host_hello',
      protocolVersion: this.#protocolVersion,
      hostId: asHostId(this.#hostId),
      hostName: this.#hostName,
    })
  }

  #handleSocketClosed(socket: RelaySocket, info: { code: number; reason: string }): void {
    if (this.#socket !== socket) return
    const failedInitialHandshake = this.#initialConnecting && this.#hello !== undefined
    this.#socket = undefined
    this.#socketOpen = false
    this.#ready = false
    this.#clearConnectionTimers()
    const detail = info.reason.length === 0 ? '' : `: ${info.reason}`
    this.#failHello(new Error(`relay socket closed (${info.code})${detail}`))
    this.#afterConnectionLost(failedInitialHandshake)
  }

  #handleInbound(socket: RelaySocket, text: string): void {
    if (this.#socket !== socket) return
    if (this.#state === 'online') this.#armWatchdog()
    let message: RelayControlMessage
    try {
      message = parseRelayControlMessage(JSON.parse(text))
    } catch {
      return
    }
    switch (message.type) {
      case 'hello_ack':
        this.#handleHelloAck(socket, message.protocolVersion)
        break
      case 'data':
        this.#handleAppPayload(message.payload)
        break
      case 'error':
        this.#lastError = {
          code: message.code,
          ...(message.message === undefined ? {} : { message: message.message }),
        }
        break
      case 'ping':
        this.#sendControl({ type: 'pong', ts: message.ts })
        break
      case 'kicked':
        this.#lastError = { code: 'KICKED', message: message.reason }
        this.#dropSocket(socket, 4001, 'kicked')
        break
      default:
        break
    }
  }

  #handleHelloAck(socket: RelaySocket, protocolVersion: number): void {
    if (this.#socket !== socket) return
    const hello = this.#hello
    if (hello === undefined) return
    if (protocolVersion !== this.#protocolVersion) {
      const message = `relay speaks protocol ${protocolVersion}, expected ${this.#protocolVersion}`
      this.#lastError = { code: 'PROTOCOL_MISMATCH', message }
      this.#dropSocket(socket, 4002, message)
      return
    }
    this.#hello = undefined
    if (hello.timer !== undefined) {
      clearTimeout(hello.timer)
      hello.timer = undefined
    }
    this.#reconnectAttempt = 0
    this.#setState('online')
    this.#flushReplay()
    this.#startHeartbeat()
    this.#armWatchdog()
    hello.resolve()
  }

  #handleAppPayload(value: unknown): void {
    let payload: AppPayload
    try {
      payload = parseAppPayload(value)
    } catch {
      return
    }
    switch (payload.type) {
      case 'hello':
        this.#send({
          type: 'hello-ack',
          protocolVersion: this.#protocolVersion,
          hostName: this.#hostName,
          ...(this.#hostVersion === undefined ? {} : { hostVersion: this.#hostVersion }),
          capabilities: [...this.#capabilities],
        })
        break
      case 'rpc-call':
        void this.#handleRpcCall(payload)
        break
      case 'rpc-frame':
        this.#handleInboundRpcFrame(payload)
        break
      case 'rpc-open':
        this.#handleRpcOpen(payload)
        break
      case 'stream-frame-ack': {
        const stream = this.#streams.get(payload.streamId)
        this.#replay.ack(payload.streamId, stream?.generation ?? 1, payload.messageSeq)
        break
      }
      case 'stream-uplink': {
        const stream = this.#streams.get(payload.streamId)
        stream?.uplink.push(payload.value)
        break
      }
      case 'stream-close': {
        const stream = this.#streams.get(payload.streamId)
        if (stream !== undefined) this.#finishStream(stream)
        break
      }
      case 'error':
        this.#lastError = {
          code: payload.code,
          ...(payload.message === undefined ? {} : { message: payload.message }),
        }
        break
      default:
        break
    }
  }

  /**
   * Reassemble a fragmented inbound request (large image-bearing prompts and
   * file uploads arrive as `rpc-frame` batches) and dispatch it.
   */
  #handleInboundRpcFrame(payload: Extract<AppPayload, { type: 'rpc-frame' }>): void {
    let assembler = this.#inboundAssemblies.get(payload.rpcId)
    if (assembler === undefined) {
      assembler = new FrameAssembler()
      this.#inboundAssemblies.set(payload.rpcId, assembler)
      if (this.#inboundAssemblies.size > MAX_INBOUND_ASSEMBLIES) {
        const oldest = this.#inboundAssemblies.keys().next().value
        if (oldest !== undefined) this.#inboundAssemblies.delete(oldest)
      }
    }
    const result = assembler.add(payload.frame)
    if (result.status === 'pending') return
    this.#inboundAssemblies.delete(payload.rpcId)
    if (result.status === 'dropped') {
      this.#sendRpcFailure(payload.rpcId, 'host/request-invalid', result.reason)
      return
    }
    const inner: unknown = result.message.payload
    if (typeof inner !== 'object' || inner === null) {
      this.#sendRpcFailure(payload.rpcId, 'host/request-invalid', 'fragmented payload is not an object')
      return
    }
    const record = inner as Record<string, unknown>
    const type = record['type']
    if (type !== 'rpc-call' && type !== 'rpc-open') {
      this.#sendRpcFailure(payload.rpcId, 'host/request-invalid', 'fragmented payload is not a request')
      return
    }
    if (record['rpcId'] !== payload.rpcId) {
      this.#sendRpcFailure(payload.rpcId, 'host/request-invalid', 'fragmented payload rpcId mismatch')
      return
    }
    if (type === 'rpc-call') void this.#handleRpcCall(record as RpcCallPayload)
    else this.#handleRpcOpen(record as RpcOpenPayload)
  }

  async #handleRpcCall(payload: RpcCallPayload): Promise<void> {
    let result: HostRpcResult
    try {
      result = await this.#bridge.call(payload.endpoint, payload.payload)
    } catch (error) {
      result = { ok: false, error: { code: 'host/internal', message: errorMessage(error) } }
    }
    if (result.ok) {
      this.#sendRpcValue(payload.rpcId, result.value)
      return
    }
    this.#send({
      type: 'rpc-result',
      rpcId: payload.rpcId,
      ok: false,
      error: {
        code: result.error.code,
        message: result.error.message,
        ...(result.error.details === undefined ? {} : { data: result.error.details }),
      },
    })
  }

  /**
   * Send one successful unary result, fragmenting values that would exceed the
   * relay's physical frame limit. Large binary reads (workspace images, PDFs)
   * travel as `rpc-frame` batches and are reassembled by the carrier.
   */
  #sendRpcValue(rpcId: string, value: unknown): void {
    let serialized: string
    try {
      serialized = JSON.stringify(value)
    } catch (error) {
      this.#sendRpcFailure(rpcId, 'host/result-invalid', `RPC result is not serializable: ${errorMessage(error)}`)
      return
    }
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes <= RPC_RESULT_FRAGMENT_THRESHOLD) {
      this.#send({ type: 'rpc-result', rpcId, ok: true, value })
      return
    }
    if (bytes > MAX_MESSAGE_BYTES) {
      this.#sendRpcFailure(
        rpcId,
        'host/result-too-large',
        `RPC result is ${bytes} bytes; the logical message limit is ${MAX_MESSAGE_BYTES}`,
      )
      return
    }
    try {
      const frames = encodeMessage(
        { bridgeSessionId: rpcId, bridgeGeneration: 1, seq: 1, messageSeq: 1 },
        value,
      )
      for (const frame of frames) this.#send({ type: 'rpc-frame', rpcId, frame })
    } catch (error) {
      this.#sendRpcFailure(rpcId, 'host/result-too-large', errorMessage(error))
    }
  }

  #sendRpcFailure(rpcId: string, code: string, message: string): void {
    this.#send({ type: 'rpc-result', rpcId, ok: false, error: { code, message } })
  }

  #handleRpcOpen(payload: RpcOpenPayload): void {
    const existing = this.#streams.get(payload.streamId)
    if (existing !== undefined) this.#finishStream(existing)
    const stream: StreamState = {
      streamId: payload.streamId,
      generation: 1,
      seq: 1,
      messageSeq: 1,
      ...(payload.recoveryId === undefined ? {} : { recoveryId: payload.recoveryId }),
      uplink: new AsyncQueue<unknown>(),
      controller: new AbortController(),
      closed: false,
    }
    this.#streams.set(payload.streamId, stream)
    void this.#runStream(stream, payload.endpoint, payload.payload)
  }

  async #runStream(stream: StreamState, endpoint: string, payload: unknown): Promise<void> {
    try {
      const values = this.#bridge.open(endpoint, payload, stream.uplink.iterate(), stream.controller.signal)
      for await (const value of values) {
        if (stream.closed) break
        this.#emitStreamFrame(stream, value)
      }
      if (stream.closed) return
      this.#finishStream(stream)
      this.#send({ type: 'stream-close', streamId: stream.streamId })
    } catch (error) {
      if (stream.closed) return
      const reason = errorMessage(error)
      this.#finishStream(stream)
      this.#send({ type: 'stream-close', streamId: stream.streamId, reason })
    }
  }

  #emitStreamFrame(stream: StreamState, value: unknown): void {
    const meta: FrameMeta = {
      bridgeSessionId: stream.streamId,
      bridgeGeneration: stream.generation,
      seq: stream.seq,
      messageSeq: stream.messageSeq,
      ...(stream.recoveryId === undefined ? {} : { recoveryId: stream.recoveryId }),
    }
    const frames = encodeMessage(meta, value)
    for (const frame of frames) this.#send({ type: 'stream-frame', frame })
    this.#replay.track(frames, this.#now())
    stream.seq += 1
    stream.messageSeq += 1
  }

  #finishStream(stream: StreamState): void {
    if (stream.closed) return
    stream.closed = true
    this.#streams.delete(stream.streamId)
    this.#replay.disposeBridge(stream.streamId)
    stream.uplink.end()
    stream.controller.abort()
  }

  #flushReplay(): void {
    this.#ready = false
    for (const frame of this.#replay.replay(this.#now())) {
      this.#sendControl({ type: 'data', payload: { type: 'stream-frame', frame } })
    }
    this.#ready = true
  }

  #send(payload: AppPayload): void {
    if (!this.#ready) return
    this.#sendControl({ type: 'data', payload })
  }

  #sendControl(message: RelayControlMessage): void {
    const socket = this.#socket
    if (socket === undefined || !this.#socketOpen) return
    let text: string
    try {
      text = JSON.stringify(message)
    } catch {
      return
    }
    try {
      socket.send(text)
    } catch {
      // A send racing a remote close is recoverable through reconnect.
    }
  }

  #startHeartbeat(): void {
    this.#clearHeartbeat()
    this.#heartbeatTimer = setInterval(() => {
      if (!this.#socketOpen) return
      this.#sendControl({ type: 'ping', ts: this.#now() })
    }, this.#heartbeatIntervalMs)
  }

  #armWatchdog(): void {
    if (this.#watchdogTimer !== undefined) clearTimeout(this.#watchdogTimer)
    this.#watchdogTimer = setTimeout(() => {
      this.#watchdogTimer = undefined
      if (this.#state !== 'online') return
      const socket = this.#socket
      if (socket === undefined) return
      this.#dropSocket(socket, 4000, 'ack watchdog')
    }, this.#ackWatchdogMs)
  }

  #dropSocket(socket: RelaySocket, code: number, reason: string): void {
    if (this.#socket !== socket) return
    const failedInitialHandshake = this.#initialConnecting && this.#hello !== undefined
    this.#socket = undefined
    this.#socketOpen = false
    this.#ready = false
    this.#clearConnectionTimers()
    this.#failHello(new Error(reason))
    try {
      socket.close(code, reason)
    } catch {
      // The socket may already be closed; reconnect proceeds either way.
    }
    this.#afterConnectionLost(failedInitialHandshake)
  }

  #afterConnectionLost(failedInitialHandshake: boolean): void {
    if (this.#stopped || !this.#running) return
    this.#setState('offline')
    if (failedInitialHandshake) return
    this.#scheduleReconnect()
  }

  #scheduleReconnect(): void {
    if (this.#stopped || !this.#running || this.#reconnectTimer !== undefined) return
    const delay = Math.min(
      this.#reconnectMaxMs,
      this.#reconnectMinMs * 2 ** this.#reconnectAttempt,
    )
    this.#reconnectAttempt += 1
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      void this.#reconnect()
    }, delay)
  }

  async #reconnect(): Promise<void> {
    if (this.#stopped || !this.#running) return
    try {
      await this.#connectOnce()
    } catch {
      if (this.#stopped || !this.#running) return
      this.#setState('offline')
      this.#scheduleReconnect()
    }
  }

  #clearConnectionTimers(): void {
    this.#clearHeartbeat()
    if (this.#watchdogTimer !== undefined) {
      clearTimeout(this.#watchdogTimer)
      this.#watchdogTimer = undefined
    }
    const hello = this.#hello
    if (hello?.timer !== undefined) {
      clearTimeout(hello.timer)
      hello.timer = undefined
    }
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer)
      this.#heartbeatTimer = undefined
    }
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = undefined
    }
  }

  #failHello(error: Error): void {
    const hello = this.#hello
    if (hello === undefined) return
    this.#hello = undefined
    if (hello.timer !== undefined) {
      clearTimeout(hello.timer)
      hello.timer = undefined
    }
    hello.reject(error)
  }

  #rejectHello(error: Error): void {
    this.#failHello(error)
  }

  #socketUrl(hostToken: string): string {
    const separator = this.#relayWsUrl.includes('?') ? '&' : '?'
    return `${this.#relayWsUrl}${separator}role=host&token=${encodeURIComponent(hostToken)}`
  }

  #setState(state: HostRemoteState): void {
    if (this.#state === state) return
    if (this.#stopped && state !== 'stopped') return
    this.#state = state
    for (const listener of [...this.#stateListeners]) {
      try {
        listener(state)
      } catch {
        // A subscriber must not break relay connection handling.
      }
    }
  }
}

function createHelloWait(): HelloWait {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject, timer: undefined }
}

function configString(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

function positiveNumber(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number`)
  }
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a failed upgrade was an authentication rejection rather than a transport error. */
function isAuthRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const status = (error as { statusCode?: unknown }).statusCode
  if (status === 401 || status === 403) return true
  if (status === undefined) {
    const message = errorMessage(error)
    return /\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(message)
  }
  return false
}
