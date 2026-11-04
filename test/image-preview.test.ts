import { describe, expect, it } from 'vitest'
import { IMAGE_PREVIEW_ENDPOINT, withImagePreview } from '../src/index.ts'
import type { HostBridge } from '../src/index.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const LARGE_PNG = new Uint8Array([...PNG_MAGIC, ...new Array(200).fill(7)])
const SMALL_PNG = new Uint8Array([...PNG_MAGIC, 1, 2, 3])
const RESIZED = new Uint8Array(32).fill(9)

function bytesValue(bytes: Uint8Array, version = 'v1'): Record<string, unknown> {
  return {
    absolutePath: '/work/a.png',
    version,
    offset: 0,
    eof: true,
    bytes: bytes.length,
    data: Buffer.from(bytes).toString('base64'),
  }
}

function previewCall(bridge: HostBridge, payload: unknown = {
  args: { workspaceFileScopeId: 's1', path: 'a.png' },
}): ReturnType<HostBridge['call']> {
  return bridge.call(IMAGE_PREVIEW_ENDPOINT, payload)
}

describe('withImagePreview', () => {
  it('downsizes large images and caches the result by version', async () => {
    let current = bytesValue(LARGE_PNG, 'v1')
    let resizeCalls = 0
    const inner: HostBridge = {
      async call(endpoint) {
        if (endpoint === 'workspaceFiles/readBytes') return { ok: true, value: current }
        return { ok: false, error: { code: 'host/not-found', message: endpoint } }
      },
      open() {
        throw new Error('not used')
      },
    }
    const bridge = withImagePreview(inner, {
      minBytes: 64,
      resize: async () => {
        resizeCalls += 1
        return RESIZED
      },
    })

    const first = await previewCall(bridge)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value).toMatchObject({
      data: Buffer.from(RESIZED).toString('base64'),
      bytes: RESIZED.length,
      preview: true,
    })

    const second = await previewCall(bridge)
    expect(second.ok).toBe(true)
    expect(resizeCalls).toBe(1)

    current = bytesValue(LARGE_PNG, 'v2')
    await previewCall(bridge)
    expect(resizeCalls).toBe(2)
  })

  it('leaves non-images and small images unchanged', async () => {
    let resizeCalls = 0
    const inner: HostBridge = {
      async call() {
        return { ok: true, value: bytesValue(SMALL_PNG) }
      },
      open() {
        throw new Error('not used')
      },
    }
    const bridge = withImagePreview(inner, {
      minBytes: 64,
      resize: async () => {
        resizeCalls += 1
        return RESIZED
      },
    })

    const result = await previewCall(bridge)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(bytesValue(SMALL_PNG))
    expect(resizeCalls).toBe(0)
  })

  it('falls back to the original when resizing fails', async () => {
    const original = bytesValue(LARGE_PNG)
    const inner: HostBridge = {
      async call() {
        return { ok: true, value: original }
      },
      open() {
        throw new Error('not used')
      },
    }
    const bridge = withImagePreview(inner, {
      minBytes: 64,
      resize: async () => {
        throw new Error('sips failed')
      },
    })

    const result = await previewCall(bridge)
    expect(result).toEqual({ ok: true, value: original })
  })

  it('rejects malformed preview requests', async () => {
    const bridge = withImagePreview({
      async call() {
        throw new Error('should not be reached')
      },
      open() {
        throw new Error('not used')
      },
    }, { resize: async () => RESIZED })

    const result = await previewCall(bridge, { args: { path: 'a.png' } })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'web-remote/invalid-request' },
    })
  })

  it('delegates every other endpoint to the wrapped bridge', async () => {
    const inner: HostBridge = {
      async call(endpoint) {
        return { ok: true, value: endpoint }
      },
      open() {
        throw new Error('not used')
      },
    }
    const bridge = withImagePreview(inner)

    await expect(bridge.call('session/list', {})).resolves.toEqual({
      ok: true,
      value: 'session/list',
    })
  })
})
