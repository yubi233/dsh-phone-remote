import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_LOCAL_RELAY_PORT, lanIpv4, LocalRelay } from '../src/local-relay.ts'

let relay: LocalRelay | undefined
let shellDir: string | undefined

function shell(): string {
  shellDir = mkdtempSync(join(tmpdir(), 'dsh-phone-remote-shell-'))
  writeFileSync(join(shellDir, 'index.html'), '<!doctype html><title>phone</title>\n')
  return shellDir
}

afterEach(async () => {
  await relay?.close()
  relay = undefined
  if (shellDir !== undefined) rmSync(shellDir, { recursive: true, force: true })
  shellDir = undefined
})

describe('LocalRelay', () => {
  it('serves the shell and health on an ephemeral port', async () => {
    relay = new LocalRelay({ port: 0, shellDir: shell() })
    const info = await relay.start()
    expect(info.port).toBeGreaterThan(0)
    expect(info.internalHttpUrl).toBe(`http://127.0.0.1:${String(info.port)}`)
    expect(info.lanUrl).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/)
    expect(info.lanUrl.endsWith(`:${String(info.port)}`)).toBe(true)

    const health = await fetch(`${info.internalHttpUrl}/health`)
    expect(health.status).toBe(200)
    const shellPage = await fetch(`${info.internalHttpUrl}/`)
    expect(shellPage.status).toBe(200)
    expect(await shellPage.text()).toContain('phone')
  })

  it('refuses to start without a built shell', async () => {
    relay = new LocalRelay({ port: 0, shellDir: join(tmpdir(), 'definitely-missing-shell-dir') })
    await expect(relay.start()).rejects.toThrow(/phone shell not found/)
    expect(relay.running).toBe(false)
  })

  it('closes idempotently', async () => {
    relay = new LocalRelay({ port: 0, shellDir: shell() })
    await relay.start()
    await relay.close()
    await relay.close()
    expect(relay.running).toBe(false)
  })

  it('falls back to an ephemeral port when the preferred one is busy', async () => {
    const first = new LocalRelay({ port: 0, shellDir: shell() })
    relay = first
    const info = await first.start()
    const second = new LocalRelay({ port: info.port, shellDir: shellDir })
    try {
      const fallback = await second.start()
      expect(fallback.port).not.toBe(info.port)
      expect(fallback.port).toBeGreaterThan(0)
    } finally {
      await second.close()
    }
  })
})

describe('lanIpv4', () => {
  it('returns a dotted IPv4 address', () => {
    expect(lanIpv4()).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
  })
})

describe('defaults', () => {
  it('prefers the conventional LAN port', () => {
    expect(DEFAULT_LOCAL_RELAY_PORT).toBe(8787)
  })
})
