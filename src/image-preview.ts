import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { HostBridge, HostRpcFailure, HostRpcResult } from './bridge.ts'

const execFileAsync = promisify(execFile)

/** Endpoint the phone calls for a display-sized workspace image. */
export const IMAGE_PREVIEW_ENDPOINT = 'webRemote/previewImage'

/** Input for one image resize attempt. */
export interface ImageResizeInput {
  /** Original image bytes. */
  readonly bytes: Uint8Array
  /** Sniffed image media type. */
  readonly mediaType: string
  /** Longest edge to keep. */
  readonly maxDimension: number
}

/** Injectable resizer so tests and non-macOS hosts can opt out. */
export type ImageResizer = (input: ImageResizeInput) => Promise<Uint8Array | undefined>

/** Options for {@link withImagePreview}. */
export interface ImagePreviewOptions {
  /** Longest edge kept inline; defaults to 800 pixels. */
  maxDimension?: number
  /** Images at or below this size skip resizing; defaults to 256 KiB. */
  minBytes?: number
  /** Cache byte budget; defaults to 32 MiB. */
  cacheBytes?: number
  /** Cache entry budget; defaults to 64. */
  cacheEntries?: number
  /** Resizer; defaults to macOS `sips`, disabled on other platforms. */
  resize?: ImageResizer
  /** Clock for cache recency; defaults to `Date.now`. */
  now?: () => number
}

interface CacheEntry {
  readonly data: string
  readonly mediaType: string
  readonly bytes: number
  touchedAt: number
}

const DEFAULT_MAX_DIMENSION = 800
const DEFAULT_MIN_BYTES = 256 * 1024
const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024
const DEFAULT_CACHE_ENTRIES = 64
const MIN_MAX_DIMENSION = 200
const MAX_MAX_DIMENSION = 1600

/**
 * Wrap a Host bridge with an inline-image preview endpoint.
 *
 * The phone asks for `webRemote/previewImage`; the wrapper reads the original
 * through `workspaceFiles/readBytes`, downsizes large images on the Host, and
 * caches the result by file version. Anything it cannot resize is returned
 * unchanged, so callers always receive a usable image.
 *
 * @param bridge - inner bridge that serves the DSH API.
 * @param options - sizing and cache budgets.
 * @returns a bridge with the preview endpoint prepended.
 */
export function withImagePreview(bridge: HostBridge, options: ImagePreviewOptions = {}): HostBridge {
  const maxDimensionDefault = options.maxDimension ?? DEFAULT_MAX_DIMENSION
  const minBytes = options.minBytes ?? DEFAULT_MIN_BYTES
  const cacheBytes = options.cacheBytes ?? DEFAULT_CACHE_BYTES
  const cacheEntries = options.cacheEntries ?? DEFAULT_CACHE_ENTRIES
  const resize = options.resize ?? resizeWithSips
  const now = options.now ?? Date.now
  const cache = new Map<string, CacheEntry>()
  let cachedBytes = 0

  const read = (key: string): CacheEntry | undefined => {
    const entry = cache.get(key)
    if (entry === undefined) return undefined
    entry.touchedAt = now()
    cache.delete(key)
    cache.set(key, entry)
    return entry
  }

  const store = (key: string, entry: CacheEntry): void => {
    const previous = cache.get(key)
    if (previous !== undefined) {
      cachedBytes -= previous.bytes
      cache.delete(key)
    }
    cache.set(key, entry)
    cachedBytes += entry.bytes
    while (cache.size > cacheEntries || cachedBytes > cacheBytes) {
      const oldest = cache.entries().next().value as [string, CacheEntry] | undefined
      if (oldest === undefined) break
      cache.delete(oldest[0])
      cachedBytes -= oldest[1].bytes
    }
  }

  return {
    call(endpoint, payload, signal): Promise<HostRpcResult> {
      if (endpoint !== IMAGE_PREVIEW_ENDPOINT) return bridge.call(endpoint, payload, signal)
      return previewImage({
        bridge,
        payload,
        signal,
        maxDimensionDefault,
        minBytes,
        resize,
        now,
        read,
        store,
      })
    },
    open(endpoint, payload, uplink, signal) {
      return bridge.open(endpoint, payload, uplink, signal)
    },
  }
}

interface PreviewContext {
  bridge: HostBridge
  payload: unknown
  signal: AbortSignal | undefined
  maxDimensionDefault: number
  minBytes: number
  resize: ImageResizer
  now(): number
  read(key: string): CacheEntry | undefined
  store(key: string, entry: CacheEntry): void
}

async function previewImage(context: PreviewContext): Promise<HostRpcResult> {
  const args = readArgs(context.payload)
  if (args === undefined) {
    return failure('web-remote/invalid-request', 'previewImage requires workspaceFileScopeId and path')
  }
  const maxDimension = clampDimension(args.maxDimension ?? context.maxDimensionDefault)
  const source = await context.bridge.call(
    'workspaceFiles/readBytes',
    { args: { workspaceFileScopeId: args.workspaceFileScopeId, path: args.path, options: {} } },
    context.signal,
  )
  if (!source.ok) return source
  const value = source.value
  if (!isWorkspaceBytes(value)) {
    return failure('web-remote/invalid-response', 'workspaceFiles/readBytes returned an unexpected value')
  }
  const original = value
  let bytes: Uint8Array
  try {
    bytes = Buffer.from(original.data, 'base64')
  } catch {
    return failure('web-remote/invalid-response', 'workspace file bytes are not valid base64')
  }
  const mediaType = sniffImageType(bytes)
  if (mediaType === undefined || bytes.length <= context.minBytes) {
    return { ok: true, value: original }
  }

  const key = `${original.absolutePath}\u0000${original.version}\u0000${String(maxDimension)}`
  const cached = context.read(key)
  if (cached !== undefined) return { ok: true, value: withData(original, cached.data, cached.mediaType) }

  let resized: Uint8Array | undefined
  try {
    resized = await context.resize({ bytes, mediaType, maxDimension })
  } catch {
    resized = undefined
  }
  if (resized === undefined || resized.length === 0 || resized.length >= bytes.length) {
    return { ok: true, value: original }
  }
  const data = Buffer.from(resized).toString('base64')
  context.store(key, { data, mediaType, bytes: resized.length, touchedAt: context.now() })
  return { ok: true, value: withData(original, data, mediaType) }
}

interface PreviewArgs {
  workspaceFileScopeId: string
  path: string
  maxDimension: number | undefined
}

function readArgs(payload: unknown): PreviewArgs | undefined {
  if (!isRecord(payload) || !isRecord(payload['args'])) return undefined
  const args = payload['args']
  const workspaceFileScopeId = args['workspaceFileScopeId']
  const path = args['path']
  if (typeof workspaceFileScopeId !== 'string' || workspaceFileScopeId === '') return undefined
  if (typeof path !== 'string' || path === '') return undefined
  const rawDimension = args['maxDimension']
  const maxDimension = typeof rawDimension === 'number' && Number.isFinite(rawDimension)
    ? rawDimension
    : undefined
  return { workspaceFileScopeId, path, maxDimension }
}

interface WorkspaceBytesValue {
  absolutePath: string
  version: string
  offset: number
  eof: boolean
  bytes?: number
  data: string
  [key: string]: unknown
}

function isWorkspaceBytes(value: unknown): value is WorkspaceBytesValue {
  if (!isRecord(value)) return false
  return typeof value['absolutePath'] === 'string'
    && typeof value['version'] === 'string'
    && typeof value['data'] === 'string'
    && typeof value['offset'] === 'number'
    && typeof value['eof'] === 'boolean'
}

function withData(value: WorkspaceBytesValue, data: string, mediaType: string): WorkspaceBytesValue {
  return {
    ...value,
    data,
    bytes: base64Length(data),
    offset: 0,
    eof: true,
    mediaType,
    preview: true,
  }
}

function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_DIMENSION
  return Math.min(MAX_MAX_DIMENSION, Math.max(MIN_MAX_DIMENSION, Math.round(value)))
}

function base64Length(data: string): number {
  if (data === '') return 0
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

/** Sniff the common raster formats the phone can display inline. */
function sniffImageType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif'
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  return undefined
}

/** Downsize with the platform image tool; non-macOS hosts keep the original. */
async function resizeWithSips(input: ImageResizeInput): Promise<Uint8Array | undefined> {
  if (process.platform !== 'darwin') return undefined
  const directory = await mkdtemp(join(tmpdir(), 'dsh-web-remote-preview-'))
  try {
    const extension = input.mediaType === 'image/png'
      ? '.png'
      : input.mediaType === 'image/jpeg'
        ? '.jpg'
        : input.mediaType === 'image/gif'
          ? '.gif'
          : '.img'
    const source = join(directory, `source${extension}`)
    const target = join(directory, `target${extension}`)
    await writeFile(source, input.bytes)
    await execFileAsync(
      'sips',
      ['-Z', String(input.maxDimension), source, '--out', target],
      { timeout: 10_000 },
    )
    return new Uint8Array(await readFile(target))
  } catch {
    return undefined
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

function failure(code: string, message: string, details?: object): { ok: false; error: HostRpcFailure } {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
