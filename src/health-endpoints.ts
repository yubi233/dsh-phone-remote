import { spawn } from 'node:child_process'
import { freemem, totalmem } from 'node:os'
import type { HostBridge, HostRpcResult } from './bridge.ts'

/** Endpoint returning the Host process memory sample. */
export const HOST_MEMORY_ENDPOINT = 'remote/host/memory'
/** Endpoint asking the supervisor to restart the Host process. */
export const HOST_RESTART_ENDPOINT = 'remote/host/restart'

/** Default budget for the phone's memory meter: 4 GiB, the size that once took DSH down. */
export const DEFAULT_MEMORY_BUDGET_BYTES = 4 * 1024 * 1024 * 1024

/** Memory sample served to the phone. All sizes are bytes. */
export interface HostMemorySample {
  /** Resident set size of the DSH process. */
  rss: number
  /** V8 heap currently used. */
  heapUsed: number
  /** V8 heap reserved. */
  heapTotal: number
  /** Buffers and other off-heap allocations V8 tracks. */
  external: number
  /** Physical memory on the Host machine. */
  systemTotal: number
  /** Free physical memory on the Host machine. */
  systemFree: number
  /** Process uptime in seconds. */
  uptimeSec: number
  /** Local sampling time (epoch ms). */
  sampledAt: number
  /** Budget the meter renders against. */
  budgetBytes: number
  /** True when a supervisor restart command is configured. */
  restartAvailable: boolean
}

/** Supervisor command that restarts the Host process. */
export interface HostRestartCommand {
  /** Executable resolved from PATH; never supplied by the phone. */
  command: string
  /** Fixed arguments from configuration. */
  args?: readonly string[]
}

/** Outcome of one restart request. */
export interface HostRestartResult {
  /** True when the supervisor command was scheduled. */
  accepted: boolean
}

/** Options for {@link withHealthEndpoints}. */
export interface HealthEndpointOptions {
  /** Meter denominator; defaults to {@link DEFAULT_MEMORY_BUDGET_BYTES}. */
  memoryBudgetBytes?: number
  /**
   * Restart command from configuration. Without it the restart endpoint
   * answers `host/restart-unavailable` and the phone shows why.
   */
  restart?: HostRestartCommand
  /** Sampling override for tests. */
  sample?: () => Omit<HostMemorySample, 'budgetBytes' | 'restartAvailable'>
  /** Restart scheduler override for tests; defaults to a detached execFile. */
  scheduleRestart?: (command: HostRestartCommand) => void
  /** Delay before the supervisor command runs, so the RPC answer can flush. */
  restartDelayMs?: number
}

/**
 * Add Host health endpoints to a bridge.
 *
 * `remote/host/memory` reports the DSH process RSS (the number that blew up
 * before) against a configured budget. `remote/host/restart` runs a command
 * fixed in configuration — the phone supplies no arguments — and answers
 * before the process goes down so the carrier can settle the call.
 *
 * @param bridge - bridge answering every other endpoint.
 * @param options - budget, restart command, and test overrides.
 */
export function withHealthEndpoints(bridge: HostBridge, options: HealthEndpointOptions = {}): HostBridge {
  const budgetBytes = options.memoryBudgetBytes ?? DEFAULT_MEMORY_BUDGET_BYTES
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
    throw new Error('memoryBudgetBytes must be a positive safe integer')
  }
  const restart = normalizeRestart(options.restart)
  const sample = options.sample ?? defaultSample
  const scheduleRestart = options.scheduleRestart ?? scheduleDetached
  const restartDelayMs = options.restartDelayMs ?? 500
  let restartRequested = false

  return {
    call(endpoint, payload, signal): Promise<HostRpcResult> {
      if (endpoint === HOST_MEMORY_ENDPOINT) {
        return Promise.resolve(memoryResult(sample, budgetBytes, restart !== undefined))
      }
      if (endpoint === HOST_RESTART_ENDPOINT) {
        return Promise.resolve(restartResult({
          restart,
          schedule: (command) => {
            if (restartRequested) return
            restartRequested = true
            const timer = setTimeout(() => {
              scheduleRestart(command)
            }, restartDelayMs)
            timer.unref?.()
          },
        }))
      }
      return bridge.call(endpoint, payload, signal)
    },
    open: (endpoint, payload, uplink, signal) => bridge.open(endpoint, payload, uplink, signal),
  }
}

function normalizeRestart(config: HostRestartCommand | undefined): HostRestartCommand | undefined {
  if (config === undefined) return undefined
  const command = config.command.trim()
  if (command === '' || command.includes('\u0000')) {
    throw new Error('restart.command must be a non-empty executable name')
  }
  const args = [...(config.args ?? [])]
  if (args.some((arg) => typeof arg !== 'string' || arg.includes('\u0000'))) {
    throw new Error('restart.args must be strings without NUL bytes')
  }
  return { command, args }
}

function memoryResult(
  sample: () => Omit<HostMemorySample, 'budgetBytes' | 'restartAvailable'>,
  budgetBytes: number,
  restartAvailable: boolean,
): HostRpcResult {
  let value: Omit<HostMemorySample, 'budgetBytes' | 'restartAvailable'>
  try {
    value = sample()
  } catch (error: unknown) {
    return failure('host/memory-unavailable', error instanceof Error ? error.message : String(error))
  }
  for (const [field, amount] of Object.entries(value)) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      return failure('host/memory-invalid', `sampled field ${field} is not a byte count`)
    }
  }
  return { ok: true, value: { ...value, budgetBytes, restartAvailable } }
}

function restartResult(input: {
  restart: HostRestartCommand | undefined
  schedule: (command: HostRestartCommand) => void
}): HostRpcResult {
  if (input.restart === undefined) {
    return failure(
      'host/restart-unavailable',
      'Host 未配置重启命令（DSH_REMOTE_RESTART_COMMAND）；请在部署环境配置后重试。',
    )
  }
  input.schedule(input.restart)
  return { ok: true, value: { accepted: true } satisfies HostRestartResult }
}

function defaultSample(): Omit<HostMemorySample, 'budgetBytes' | 'restartAvailable'> {
  const usage = process.memoryUsage()
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    systemTotal: totalmem(),
    systemFree: freemem(),
    uptimeSec: Math.round(process.uptime()),
    sampledAt: Date.now(),
  }
}

/**
 * Run the supervisor command detached so this dying process never waits on
 * it. `spawn` without a shell, with command/args from configuration only —
 * the phone cannot influence what runs.
 */
function scheduleDetached(command: HostRestartCommand): void {
  try {
    const child = spawn(command.command, [...(command.args ?? [])], {
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // The supervisor not being reachable only means the phone retries later.
  }
}

function failure(code: string, message: string): HostRpcResult {
  return { ok: false, error: { code, message } }
}
