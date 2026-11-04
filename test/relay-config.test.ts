import { describe, expect, it } from 'vitest'
import { generateHostIdentity, normalizeRelayHttpUrl, RelayConfigStore } from '../src/relay-config.ts'
import type { RelayConfigStorage, RelayConfigTableLike } from '../src/relay-config.ts'

/** Storage double: one domain name -> one keyed map, like the DSH storage domain. */
function fakeStorage(): { storage: RelayConfigStorage; map: Map<string, unknown> } {
  const map = new Map<string, unknown>()
  const storage: RelayConfigStorage = {
    open: async () => {
      const table: RelayConfigTableLike = {
        get: (key) => map.get(key),
        put: async (key, value) => {
          map.set(key, value)
        },
      }
      return { table: () => table, close: async () => undefined }
    },
  }
  return { storage, map }
}

const SAMPLE = {
  relayHttpUrl: 'https://relay.example',
  hostId: 'host-1',
  hostSecret: 'secret-1',
}

describe('RelayConfigStore', () => {
  it('round-trips a runtime config', async () => {
    const { storage, map } = fakeStorage()
    const store = new RelayConfigStore(storage)
    await store.save(SAMPLE)
    expect(await store.load()).toEqual(SAMPLE)
    expect(map.get('current')).toEqual(SAMPLE)
    await store.close()
  })

  it('reports absent when nothing is stored', async () => {
    const { storage } = fakeStorage()
    const store = new RelayConfigStore(storage)
    expect(await store.load()).toBeUndefined()
    await store.close()
  })

  it('treats a corrupt stored value as absent instead of throwing', async () => {
    const { storage, map } = fakeStorage()
    const store = new RelayConfigStore(storage)
    await store.save(SAMPLE)
    map.set('current', { relayHttpUrl: 7 })
    expect(await store.load()).toBeUndefined()
    map.set('current', 'not-an-object')
    expect(await store.load()).toBeUndefined()
    await store.close()
  })

  it('rejects saving an invalid config', async () => {
    const { storage } = fakeStorage()
    const store = new RelayConfigStore(storage)
    await expect(store.save({ ...SAMPLE, hostSecret: '' })).rejects.toThrow(/hostSecret/)
    await store.close()
  })
})

describe('generateHostIdentity', () => {
  it('mints distinct ids with a long secret', () => {
    const first = generateHostIdentity()
    const second = generateHostIdentity()
    expect(first.hostId).not.toBe(second.hostId)
    expect(first.hostSecret.length).toBeGreaterThan(30)
    expect(first.hostSecret).not.toBe(second.hostSecret)
  })
})

describe('normalizeRelayHttpUrl', () => {
  it('trims trailing slashes and preserves the origin', () => {
    expect(normalizeRelayHttpUrl(' https://relay.example/ ')).toBe('https://relay.example')
    expect(normalizeRelayHttpUrl('http://10.0.0.5:8787')).toBe('http://10.0.0.5:8787')
  })

  it('rejects non-http and relative values', () => {
    expect(() => normalizeRelayHttpUrl('ftp://relay.example')).toThrow(/http/)
    expect(() => normalizeRelayHttpUrl('relay.example')).toThrow(/absolute/)
    expect(() => normalizeRelayHttpUrl('')).toThrow(/absolute/)
  })
})
