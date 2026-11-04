import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RelayStorePersistence } from './store.ts'

/**
 * Durable snapshot sink backed by one JSON file.
 *
 * Every write goes to a sibling temp file and is renamed into place, so a
 * crash mid-write leaves the previous snapshot intact. Only hashed secrets
 * ever reach the snapshot — see `MemoryRelayStore`.
 *
 * @param path - Snapshot file path; parent directories are created on demand.
 */
export function filePersistence(path: string): RelayStorePersistence {
  return {
    load(): string | undefined {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        // Missing or unreadable snapshot: start empty.
        return undefined
      }
    },
    save(snapshot: string): void {
      try {
        mkdirSync(dirname(path), { recursive: true })
        const temp = `${path}.tmp-${String(process.pid)}`
        writeFileSync(temp, snapshot, 'utf8')
        renameSync(temp, path)
      } catch {
        // Persistence is best-effort: a failed write only means devices must
        // re-pair after the next restart, which matches the memory store.
      }
    },
  }
}
