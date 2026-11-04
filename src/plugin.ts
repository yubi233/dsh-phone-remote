import type { RelaySocketFactory } from '@dsh-web-remote/protocol'
import { hostname } from 'node:os'
import { registerRelayConsole } from './console.ts'
import type { RelayConsoleInfo, RelayConsoleServer, RelaySetupInput, RelaySetupResult } from './console.ts'
import { withBodyBudget } from './body-budget.ts'
import { withChangesEndpoints } from './changes-endpoints.ts'
import { withHealthEndpoints } from './health-endpoints.ts'
import type { WorkspaceChangesLike } from './changes-endpoints.ts'
import { withCommandQueryEndpoint } from './command-endpoints.ts'
import type { DeviceRecord, PairingOffer } from './pairing.ts'
import { createDshHostBridge } from './dsh-bridge.ts'
import type { DshConnectionHandle, DshWireStream } from './dsh-bridge.ts'
import { withDeviceEndpoints } from './device-endpoints.ts'
import { withHostInfoEndpoint } from './host-endpoints.ts'
import { withImagePreview } from './image-preview.ts'
import { withUnreadEndpoints } from './unread-endpoints.ts'
import { SessionUnreadController } from './unread.ts'
import type { SessionUnreadContext } from './unread.ts'
import { PairingClient } from './pairing.ts'
import { generateHostIdentity, normalizeRelayHttpUrl, RelayConfigStore } from './relay-config.ts'
import type { RelayRuntimeConfig } from './relay-config.ts'
import { DEFAULT_LOCAL_RELAY_PORT, LocalRelay } from './local-relay.ts'
import type { LocalRelayInfo } from './local-relay.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HostRemote } from './remote.ts'
import type { HostRemoteConfig, HostRemoteState } from './remote.ts'
import type { HostBridge } from './bridge.ts'

/** Configuration read by the Cordis plugin entry. */
export interface WebRemotePluginConfig {
  /**
   * Relay HTTP origin, for example `https://relay.example`. Omit it to leave
   * the relay unconfigured at boot; the local console routes (DSH web GUI
   * panel) then perform first-time setup and persist it in a storage domain,
   * which overrides these patch values on later boots.
   */
  relayHttpUrl?: string
  /** Relay WebSocket URL; derived from {@link relayHttpUrl} when omitted. */
  relayWsUrl?: string
  /** Stable Host identity persisted by the deployment. Required together with `hostSecret` when `relayHttpUrl` is set. */
  hostId?: string
  /** Long-lived registration secret. Required together with `hostId` when `relayHttpUrl` is set. */
  hostSecret?: string
  /** Human-readable name shown during pairing. */
  hostName: string
  /** Host build version advertised to devices. */
  hostVersion?: string
  /** Pairing page base URL; the phone debug page URL in local deployments. */
  pairingUrlBase?: string
  /** Capability tags advertised in `hello-ack`. */
  capabilities?: string[]
  /** Soft byte budget for one opening snapshot or history page; defaults to 200000. */
  bodyBudgetBytes?: number
  /**
   * Built-in LAN relay. Enabled by default whenever no external relay is
   * configured: the plugin hosts the relay and the bundled phone shell itself
   * and the panel shows one LAN URL. `false` disables it; an object tunes the
   * port or points the shell at another directory (tests).
   */
  localRelay?:
    | false
    | {
        /** Preferred LAN port; defaults to 8787, falls back to ephemeral when busy. */
        port?: number
        /** Phone shell directory; defaults to the package's `shell/`. */
        shellDir?: string
        /** Relay state file; defaults to `~/.dsh/storages/web_remote_local_relay.json`. */
        storeFile?: string
        /** Bind interface; defaults to `0.0.0.0` so LAN phones can reach it. */
        host?: string
      }
  /** Start the relay connection immediately; defaults to true. */
  autoStart?: boolean
  /** Fetch implementation for relay HTTP calls; tests inject a stub. */
  fetchImpl?: typeof fetch
  /** Relay socket factory; tests inject an in-memory socket. */
  createSocket?: RelaySocketFactory
  /** `x-registration-token` value required by public relays; optional. */
  registrationToken?: string
  /** Meter denominator for the phone's host-memory bar; defaults to 4 GiB. */
  memoryBudgetBytes?: number
  /**
   * Supervisor command that restarts this Host process (executable + fixed
   * args, no shell). Without it the phone's restart button reports why it is
   * unavailable. Example: `launchctl` + `kickstart -k gui/501/<label>`.
   */
  restartCommand?: string
  /** Fixed arguments for {@link restartCommand}. */
  restartArgs?: string[]
}

/** Minimal Cordis context surface this plugin needs. */
export interface WebRemotePluginContext {
  connection: DshConnectionHandle
  /** Gateway service; its `wireStream` member owns stream open/failure. */
  typertGateway: { readonly wireStream: DshWireStream }
  sessions: SessionUnreadContext['sessions']
  sessionQuery: SessionUnreadContext['sessionQuery']
  sessionProjections: SessionUnreadContext['sessionProjections']
  storageDomain: SessionUnreadContext['storageDomain']
  /** Optional changed-file service; present when the profile mounts it. */
  workspaceChanges?: WorkspaceChangesLike
  /** Cordis service lookup for optional dependencies. */
  get?<T = unknown>(name: string): T | undefined
  effect(callback: () => void | Promise<void> | (() => void | Promise<void>)): void
  provide?(name: string, value: unknown): void
  logger?: {
    info?(message: string): void
    warn?(message: string): void
    error?(message: string): void
  }
}

/** Stable Cordis plugin name. */
export const name = 'web-remote-host'

/** Services required before the plugin can start. */
export const inject = [
  'connection',
  'typertGateway',
  'sessions',
  'sessionQuery',
  'sessionProjections',
  'storageDomain',
]

/** Hooks the local console uses to set up the relay at runtime. */
export interface WebRemoteServiceHooks {
  /** Identity to register with: the deployment's, or freshly generated on first setup. */
  identity(): { hostId: string; hostSecret: string; hostName: string }
  /** Persist the runtime relay config after a validated setup. */
  persist(config: RelayRuntimeConfig): Promise<void>
}

/**
 * Relay-facing lifecycle exposed to other Host plugins.
 *
 * Pairing and device management pass through to the relay HTTP API; the relay
 * remains the authority for device credentials. When the patch config carries
 * no relay URL the service starts unconfigured and {@link configureRelay}
 * performs the first setup from the DSH web GUI console.
 */
export class WebRemoteHostService {
  readonly #config: WebRemotePluginConfig
  readonly #bridge: HostBridge
  readonly #hooks: WebRemoteServiceHooks | undefined
  readonly #holder: { remote?: HostRemote } = {}
  readonly #logger: WebRemotePluginContext['logger']
  #remote: HostRemote | undefined
  #active: { relayHttpUrl: string; hostId: string; registrationTokenSet: boolean } | undefined
  #local: LocalRelayInfo | undefined
  #started = false

  constructor(
    config: WebRemotePluginConfig,
    ctx: Pick<WebRemotePluginContext, 'connection' | 'typertGateway' | 'sessionQuery' | 'logger'>,
    unread: SessionUnreadController,
    workspaceChanges: WorkspaceChangesLike | undefined,
    hooks?: WebRemoteServiceHooks,
  ) {
    this.#config = config
    this.#hooks = hooks
    this.#logger = ctx.logger
    const logger = ctx.logger
    const bridge: HostBridge = withImagePreview(createDshHostBridge({
      connection: ctx.connection,
      wireStream: ctx.typertGateway.wireStream,
    }))
    const budgeted = withBodyBudget(bridge, {
      ...(config.bodyBudgetBytes === undefined ? {} : { maxBytes: config.bodyBudgetBytes }),
      readEvents: async (sessionId) => (await ctx.sessionQuery.readSession(sessionId)).events,
    })
    const commanded = withCommandQueryEndpoint(budgeted, {
      readEvents: async (sessionId) => (await ctx.sessionQuery.readSession(sessionId)).events,
    })
    const deviceBridge: HostBridge = withDeviceEndpoints(commanded, {
      listDevices: async () => {
        if (this.#holder.remote === undefined) throw new Error('web-remote-host is not ready')
        return await this.#holder.remote.listDevices()
      },
      revokeDevice: async (deviceId) => {
        if (this.#holder.remote === undefined) throw new Error('web-remote-host is not ready')
        await this.#holder.remote.revokeDevice(deviceId)
      },
    })
    const exposed = withHealthEndpoints(
      withChangesEndpoints(withHostInfoEndpoint(withUnreadEndpoints(deviceBridge, unread), {
        name: config.hostName,
        ...(config.hostVersion === undefined ? {} : { version: config.hostVersion }),
        capabilities: config.capabilities ?? [],
      }), {
        ...(workspaceChanges === undefined ? {} : { workspaceChanges }),
      }),
      {
        ...(config.memoryBudgetBytes === undefined ? {} : { memoryBudgetBytes: config.memoryBudgetBytes }),
        ...(config.restartCommand === undefined
          ? {}
          : { restart: { command: config.restartCommand, args: config.restartArgs ?? [] } }),
      },
    )
    this.#bridge = exposed
    if (config.relayHttpUrl !== undefined && config.hostId !== undefined && config.hostSecret !== undefined) {
      this.#attachRemote(this.#remoteConfig(config.relayHttpUrl))
    } else {
      logger?.info?.('web-remote-host: relay not configured yet; waiting for console setup')
    }
  }

  /** Whether a relay is configured and this service owns a connection. */
  get configured(): boolean {
    return this.#remote !== undefined
  }

  /** Current relay connection state. */
  get status(): HostRemoteState | 'unconfigured' {
    return this.#remote?.state ?? 'unconfigured'
  }

  /** Most recent relay-level failure, if any. */
  get lastError(): { code: string; message?: string } | undefined {
    return this.#remote?.lastError
  }

  /** Snapshot the DSH web GUI console shows in its status card. */
  consoleInfo(): RelayConsoleInfo {
    const remote = this.#remote
    const active = this.#active
    return {
      configured: remote !== undefined,
      state: this.status,
      hostName: this.#config.hostName,
      registrationTokenSet: active?.registrationTokenSet === true,
      ...(active === undefined ? {} : { relayHttpUrl: active.relayHttpUrl, hostId: active.hostId }),
      ...(this.#local === undefined
        ? {}
        : { localRelay: { lanUrl: this.#local.lanUrl, port: this.#local.port } }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    }
  }

  /**
   * Attach a freshly started built-in LAN relay: the Host connects over
   * loopback while pairing URLs point at the LAN origin a phone can open.
   * Registration is not probed here — the relay was just created by this
   * process, so only a bind-level failure could stop it.
   */
  attachLocalRelay(info: LocalRelayInfo): void {
    const hooks = this.#hooks
    if (hooks === undefined) {
      throw new Error('web-remote-host: runtime relay setup is not available in this deployment')
    }
    const identity = hooks.identity()
    const config = this.#config
    this.#local = info
    this.#attachRemote({
      relayHttpUrl: info.internalHttpUrl,
      relayWsUrl: deriveRelayWsUrl(info.internalHttpUrl),
      hostId: identity.hostId,
      hostSecret: identity.hostSecret,
      hostName: identity.hostName,
      pairingUrlBase: info.lanUrl,
      ...(config.hostVersion === undefined ? {} : { hostVersion: config.hostVersion }),
      ...(config.capabilities === undefined ? {} : { capabilities: config.capabilities }),
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
      ...(config.createSocket === undefined ? {} : { createSocket: config.createSocket }),
    })
  }

  /** Stop the Host connection but keep the local relay marker for the panel. */
  detachLocalRelay(): void {
    this.#local = undefined
  }

  /**
   * Validate, connect to, and persist a relay setup from the console.
   *
   * The registration exchange must succeed before anything is persisted, so a
   * wrong registration token or unreachable relay leaves the previous setup
   * (or the unconfigured state) intact. The live connection is replaced after
   * validation; its socket comes up in the background with normal reconnects.
   */
  async configureRelay(input: RelaySetupInput): Promise<RelaySetupResult> {
    const hooks = this.#hooks
    if (hooks === undefined) {
      throw new Error('web-remote-host: runtime relay setup is not available in this deployment')
    }
    const relayHttpUrl = normalizeRelayHttpUrl(input.relayHttpUrl)
    const identity = hooks.identity()
    const config = this.#config
    const pairingUrlBase = input.pairingUrlBase ?? config.pairingUrlBase ?? relayHttpUrl
    const registrationToken = input.registrationToken ?? config.registrationToken
    // Probe registration with a throwaway client: this is the one exchange the
    // relay can reject (unreachable, bad registration token, secret mismatch),
    // and it must not leave a half-attached connection behind.
    const probe = new PairingClient({
      relayHttpUrl,
      hostId: identity.hostId,
      hostSecret: identity.hostSecret,
      hostName: identity.hostName,
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
      ...(registrationToken === undefined ? {} : { registrationToken }),
    })
    try {
      await probe.register()
    } catch (error) {
      throw new Error(
        `relay setup failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const remoteConfig: HostRemoteConfig = {
      relayHttpUrl,
      relayWsUrl: deriveRelayWsUrl(relayHttpUrl),
      hostId: identity.hostId,
      hostSecret: identity.hostSecret,
      hostName: identity.hostName,
      ...(config.hostVersion === undefined ? {} : { hostVersion: config.hostVersion }),
      ...(config.capabilities === undefined ? {} : { capabilities: config.capabilities }),
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
      ...(config.createSocket === undefined ? {} : { createSocket: config.createSocket }),
      ...(registrationToken === undefined ? {} : { registrationToken }),
    }
    const previous = this.#remote
    this.#local = undefined
    this.#attachRemote(remoteConfig)
    const current = this.#remote
    if (current !== undefined) {
      this.#started = true
      void current.start().catch((error: unknown) => {
        this.#logger?.warn?.(
          `web-remote-host: relay connect after setup failed (${messageOf(error)})`,
        )
      })
    }
    if (previous !== undefined) await previous.stop().catch(() => undefined)
    await hooks.persist({
      relayHttpUrl,
      hostId: identity.hostId,
      hostSecret: identity.hostSecret,
      ...(input.registrationToken === undefined ? {} : { registrationToken: input.registrationToken }),
      ...(input.pairingUrlBase === undefined ? {} : { pairingUrlBase: input.pairingUrlBase }),
    })
    this.#logger?.info?.(`web-remote-host: relay configured (${relayHttpUrl})`)
    return { hostId: identity.hostId, hostName: identity.hostName, pairingUrlBase }
  }

  /** Build the HostRemote config for one relay origin under the patch config. */
  #remoteConfig(relayHttpUrl: string): HostRemoteConfig {
    const config = this.#config
    if (config.hostId === undefined || config.hostSecret === undefined) {
      throw new Error('web-remote-host: relay configured without a host identity')
    }
    return {
      relayHttpUrl,
      relayWsUrl: config.relayWsUrl ?? deriveRelayWsUrl(relayHttpUrl),
      hostId: config.hostId,
      hostSecret: config.hostSecret,
      hostName: config.hostName,
      ...(config.hostVersion === undefined ? {} : { hostVersion: config.hostVersion }),
      ...(config.pairingUrlBase === undefined ? {} : { pairingUrlBase: config.pairingUrlBase }),
      ...(config.capabilities === undefined ? {} : { capabilities: config.capabilities }),
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
      ...(config.createSocket === undefined ? {} : { createSocket: config.createSocket }),
      ...(config.registrationToken === undefined ? {} : { registrationToken: config.registrationToken }),
    }
  }

  /** Own a new HostRemote, updating the device-endpoint holder and state log. */
  #attachRemote(remoteConfig: HostRemoteConfig): void {
    const remote = new HostRemote(remoteConfig, this.#bridge)
    this.#remote = remote
    this.#holder.remote = remote
    this.#active = {
      relayHttpUrl: remoteConfig.relayHttpUrl,
      hostId: remoteConfig.hostId,
      registrationTokenSet: remoteConfig.registrationToken !== undefined,
    }
    remote.onState((state) => {
      this.#logger?.info?.(`web-remote-host: relay ${state}`)
    })
  }

  /** Start registration and the outbound relay connection. */
  async start(): Promise<void> {
    if (this.#started || this.#remote === undefined) return
    this.#started = true
    try {
      await this.#remote.start()
    } catch (error) {
      // A failed initial start must stay retryable; the relay may come up later.
      this.#started = false
      throw error
    }
  }

  /** Stop the connection; idempotent and safe when unconfigured. */
  async stop(): Promise<void> {
    this.#started = false
    if (this.#remote !== undefined) await this.#remote.stop()
  }

  /** Create a one-time pairing offer. */
  async createPairing(): Promise<PairingOffer> {
    return await this.#requireRemote().createPairing()
  }

  /** List devices paired with this Host. */
  async listDevices(): Promise<DeviceRecord[]> {
    return await this.#requireRemote().listDevices()
  }

  /** Revoke one device and disconnect it. */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.#requireRemote().revokeDevice(deviceId)
  }

  #requireRemote(): HostRemote {
    if (this.#remote === undefined) {
      throw new Error('web-remote-host: relay is not configured yet')
    }
    return this.#remote
  }
}

/**
 * Plugin entry: open unread storage, create the relay service, and tie both to
 * the reading fiber.
 *
 * Unread storage is part of the plugin's required composition, so an open
 * failure rejects activation instead of silently serving stale unread state.
 * The relay connection comes from the patch config, or — when the patch names
 * no relay — from the runtime setup the DSH web GUI console performs, which is
 * persisted in a storage domain and overrides the patch on later boots. A
 * failed background relay start is logged and retried with capped exponential
 * backoff until the relay becomes reachable; the retry loop ends when the
 * plugin is disposed. A live connection reconnects on its own, so the loop
 * only covers the initial handshake.
 */
export async function apply(ctx: WebRemotePluginContext, config?: WebRemotePluginConfig): Promise<void> {
  // The desktop shell can activate a fresh install while the startup
  // composition still holds a previous instance. Two live instances would own
  // two relays and the console would reach whichever registered first, so the
  // newcomer stands down instead of half-working: the owning instance keeps
  // serving and a full app restart hands over cleanly.
  if (getProvidedService(ctx) !== undefined) {
    reportStartFailure(ctx, 'another web-remote-host instance already owns this profile slot; standing down')
    return
  }
  // A published install needs no patch config at all: the relay is set up from
  // the DSH web GUI console and persisted in the storage domain.
  const normalized: WebRemotePluginConfig = {
    ...(config ?? {}),
    hostName: config?.hostName ?? defaultHostName(),
  }
  const unread = new SessionUnreadController(ctx)
  await unread.ready()
  const workspaceChanges = resolveWorkspaceChanges(ctx)
  const configStore = new RelayConfigStore(ctx.storageDomain)
  const stored = await configStore.load()
  const effective = mergeRuntimeConfig(normalized, stored)
  const identityMemo: { identity?: { hostId: string; hostSecret: string } } = {}
  const identityOf = (): { hostId: string; hostSecret: string; hostName: string } => {
    if (identityMemo.identity === undefined) {
      identityMemo.identity =
        effective.hostId !== undefined && effective.hostSecret !== undefined
          ? { hostId: effective.hostId, hostSecret: effective.hostSecret }
          : generateHostIdentity()
    }
    return { ...identityMemo.identity, hostName: effective.hostName }
  }
  const persistRuntime = async (runtime: RelayRuntimeConfig): Promise<void> => {
    await configStore.save(runtime)
  }
  const service = new WebRemoteHostService(
    effective,
    ctx,
    unread,
    workspaceChanges,
    { identity: identityOf, persist: persistRuntime },
  )

  // Built-in LAN relay: no external relay configured means "host it here".
  // Anyone who installs the plugin gets a LAN URL for the phone without any
  // further setup; the panel shows it and can switch modes at runtime.
  const localRelayOptions = typeof effective.localRelay === 'object' ? effective.localRelay : {}
  let localRelay: LocalRelay | undefined
  let liveLocalRelay: LocalRelayInfo | undefined
  const startLocalRelay = async (preferredPort?: number): Promise<LocalRelayInfo> => {
    await localRelay?.close().catch(() => undefined)
    const next = new LocalRelay({
      port: preferredPort ?? localRelayOptions.port ?? DEFAULT_LOCAL_RELAY_PORT,
      ...(localRelayOptions.host === undefined ? {} : { host: localRelayOptions.host }),
      ...(localRelayOptions.shellDir === undefined ? {} : { shellDir: localRelayOptions.shellDir }),
      storeFile: localRelayOptions.storeFile ?? defaultLocalStoreFile(),
    })
    const info = await next.start()
    localRelay = next
    liveLocalRelay = info
    return info
  }
  if (effective.relayHttpUrl === undefined && effective.localRelay !== false) {
    try {
      const info = await startLocalRelay()
      service.attachLocalRelay(info)
      const identity = identityOf()
      await persistRuntime({
        hostId: identity.hostId,
        hostSecret: identity.hostSecret,
        localRelay: { port: info.port },
      })
      ctx.logger?.info?.(`web-remote-host: built-in LAN relay at ${info.lanUrl}`)
    } catch (error: unknown) {
      // A missing shell build or a busy network is a UI-level problem, not an
      // activation failure: the panel stays available and reports the reason.
      reportStartFailure(ctx, `built-in LAN relay unavailable (${messageOf(error)})`)
    }
  }
  const restartConnection = async (): Promise<string> => {
    await service.stop()
    if (liveLocalRelay !== undefined) service.attachLocalRelay(liveLocalRelay)
    await service.start()
    return service.status
  }
  const switchToLocalRelay = async (port?: number): Promise<LocalRelayInfo> => {
    await service.stop()
    const info = await startLocalRelay(port)
    service.attachLocalRelay(info)
    const identity = identityOf()
    await persistRuntime({
      hostId: identity.hostId,
      hostSecret: identity.hostSecret,
      localRelay: { port: info.port },
    })
    await service.start().catch((error: unknown) => {
      reportStartFailure(ctx, `built-in LAN relay connect failed (${messageOf(error)})`)
    })
    return info
  }

  ctx.provide?.('webRemoteHost', service)
  const webServer = resolveWebServer(ctx)
  if (webServer !== undefined) {
    // Route registration lives on the fiber so a plugin reload unregisters the
    // family before the next activation re-registers it (Cordis re-runs apply
    // on reboots, and the desktop shell may activate a fresh install while the
    // startup composition still holds one).
    ctx.effect(() => registerRelayConsole(webServer, {
      service,
      ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
      localRelay: {
        start: switchToLocalRelay,
        enabled: effective.localRelay !== false,
      },
      restart: restartConnection,
    }))
  }
  let disposed = false
  ctx.effect(() => {
    if (effective.autoStart !== false && service.configured) void startWithRetry()
    return () => {
      disposed = true
      void service.stop()
      void localRelay?.close().catch(() => undefined)
      void configStore.close().catch(() => undefined)
      void unread.close()
    }
  })

  async function startWithRetry(): Promise<void> {
    let attempt = 0
    for (;;) {
      try {
        await service.start()
        return
      } catch (error: unknown) {
        if (disposed) return
        const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt)
        attempt += 1
        reportStartFailure(ctx, `relay start failed (${messageOf(error)}); retrying in ${Math.round(delay / 1000)}s`)
        await sleep(delay)
        if (disposed) return
      }
    }
  }
}

/**
 * Overlay the persisted runtime setup onto the patch config. Runtime values
 * win: after a console setup the storage domain is the deployment's source of
 * truth, and the patch keeps only what the runtime never owns.
 */
function mergeRuntimeConfig(
  config: WebRemotePluginConfig,
  stored: RelayRuntimeConfig | undefined,
): WebRemotePluginConfig {
  if (stored === undefined) return config
  return {
    ...config,
    ...(stored.relayHttpUrl === undefined ? {} : { relayHttpUrl: stored.relayHttpUrl }),
    hostId: stored.hostId,
    hostSecret: stored.hostSecret,
    ...(stored.localRelay === undefined
      ? {}
      : { localRelay: { ...(stored.localRelay.port === undefined ? {} : { port: stored.localRelay.port }) } }),
    ...(stored.pairingUrlBase === undefined ? {} : { pairingUrlBase: stored.pairingUrlBase }),
    ...(stored.registrationToken === undefined ? {} : { registrationToken: stored.registrationToken }),
  }
}

/** The already-provided host service, when a previous instance still owns it. */
function getProvidedService(ctx: WebRemotePluginContext): unknown {
  try {
    return ctx.get?.<unknown>('webRemoteHost')
  } catch {
    return undefined
  }
}

/**
 * Read the optional webServer service without tripping Cordis's
 * undeclared-property guard: profiles without a web app front end (ACP-style
 * hosts) legitimately have none, and the console routes are then simply absent.
 */
function resolveWebServer(ctx: WebRemotePluginContext): RelayConsoleServer | undefined {
  try {
    return ctx.get?.<RelayConsoleServer>('webServer')
  } catch {
    return undefined
  }
}

const RETRY_BASE_DELAY_MS = 1_000
const RETRY_MAX_DELAY_MS = 30_000

/**
 * Report a start failure through the context logger, falling back to stderr.
 *
 * The real DSH context exposes no logger, and a silently retrying start loop
 * once cost a full outage diagnosis — start failures must always be visible.
 */
function reportStartFailure(
  ctx: Pick<WebRemotePluginContext, 'logger'>,
  message: string,
): void {
  const line = `web-remote-host: ${message}`
  if (ctx.logger?.error !== undefined) {
    ctx.logger.error(line)
    return
  }
  console.error(line)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Convert the relay HTTP origin to its WebSocket endpoint. */
export function deriveRelayWsUrl(relayHttpUrl: string): string {
  const url = new URL(relayHttpUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/ws`
  url.search = ''
  url.hash = ''
  return url.toString()
}

/**
 * Read the optional workspace-changes service without tripping Cordis's
 * undeclared-property guard: the getter throws when the profile never
 * provided one (a fresh install with no sessions, for example), which would
 * otherwise abort plugin activation.
 */
function resolveWorkspaceChanges(ctx: WebRemotePluginContext): WorkspaceChangesLike | undefined {
  try {
    return ctx.workspaceChanges ?? ctx.get?.<WorkspaceChangesLike>('workspaceChanges')
  } catch {
    return undefined
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Relay state file for the built-in LAN relay, next to other DSH state. */
function defaultLocalStoreFile(): string {
  return join(homedir(), '.dsh', 'storages', 'web_remote_local_relay.json')
}

/** Host name used when the patch config does not name one. */
function defaultHostName(): string {
  try {
    return hostname()
  } catch {
    return 'DSH Host'
  }
}
