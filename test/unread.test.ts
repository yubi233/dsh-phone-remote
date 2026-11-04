import { describe, expect, it } from 'vitest'
import {
  SessionUnreadController,
  activityOf,
  unreadActivityProjectionDefinition,
  unreadAtOf,
  unreadCut,
} from '../src/unread.ts'
import type { SessionUnreadActivity, SessionUnreadContext } from '../src/unread.ts'

interface Harness {
  controller: SessionUnreadController
  table: Map<string, { readSeq: number; readAt: number }>
  definition: ReturnType<typeof unreadActivityProjectionDefinition>
  setActivity(activity: SessionUnreadActivity): void
  onPut(fn: (key: string) => void): void
}

async function harness(initial: SessionUnreadActivity): Promise<Harness> {
  let definition: ReturnType<typeof unreadActivityProjectionDefinition> | undefined
  let activity = initial
  let putHook: ((key: string) => void) | undefined
  const table = new Map<string, { readSeq: number; readAt: number }>()
  const records = {
    get: (key: string) => table.get(key),
    entries: () => table.entries(),
    put: async (key: string, value: { readSeq: number; readAt: number }) => {
      table.set(key, value)
      putHook?.(key)
    },
    update: async (key: string, fn: (current: { readSeq: number; readAt: number }) => { readSeq: number; readAt: number }) => {
      const current = table.get(key)
      if (current === undefined) throw new Error('missing-key')
      const next = fn(current)
      table.set(key, next)
      return next
    },
  }
  const ctx: SessionUnreadContext = {
    sessions: {
      get: (sessionId) => (sessionId === 's1' ? { id: sessionId } : undefined),
    },
    sessionQuery: {
      readSession: async (sessionId) => {
        if (sessionId !== 'cold') throw new Error(`no such session: ${sessionId}`)
        return {
          session: { createdAt: 0 },
          inheritedEventCount: 0,
          events: [
            { type: 'user/message', seq: 0, time: 100, data: { source: { kind: 'user' } } },
            { type: 'assistant/message', seq: 1, time: 200, data: {} },
          ],
        }
      },
    },
    sessionProjections: {
      register: (value) => {
        definition = value
        return () => undefined
      },
      snapshot: () => ({ values: { unreadActivity: activity } }),
    },
    storageDomain: {
      open: async () => ({
        table: () => records,
        close: async () => undefined,
      }),
    },
  }
  const controller = new SessionUnreadController(ctx)
  await controller.ready()
  if (definition === undefined) throw new Error('projection was not registered')
  return {
    controller,
    table,
    definition,
    setActivity: (next) => {
      activity = next
    },
    onPut: (fn) => {
      putHook = fn
    },
  }
}

describe('unreadActivity projection', () => {
  it('tracks user prompts, assistant replies, and approval requests', () => {
    const definition = unreadActivityProjectionDefinition()
    let state = definition.init()
    state = definition.apply(state, {
      type: 'user/message',
      seq: 1,
      time: 100,
      data: { source: { kind: 'user' } },
    })
    expect(state).toEqual({ lastActivitySeq: 1, lastActivityAt: 100 })
    state = definition.apply(state, {
      type: 'assistant/message',
      seq: 2,
      time: 200,
      data: {},
    })
    expect(state).toEqual({ lastActivitySeq: 2, lastActivityAt: 200 })
    state = definition.apply(state, {
      type: 'approval/asked',
      seq: 3,
      time: 300,
      data: {},
    })
    expect(state).toEqual({ lastActivitySeq: 3, lastActivityAt: 300 })
  })

  it('keeps the same reference for unrelated and tool-sourced events', () => {
    const definition = unreadActivityProjectionDefinition()
    const state = definition.init()
    expect(definition.apply(state, {
      type: 'user/message',
      seq: 1,
      time: 100,
      data: { source: { kind: 'tool' } },
    })).toBe(state)
    expect(definition.apply(state, { type: 'session/title', seq: 2, time: 200, data: {} })).toBe(state)
    expect(definition.apply(state, { type: 'assistant/message', seq: 3 })).toBe(state)
  })
})

describe('unreadAtOf and activityOf', () => {
  it('returns the activity time only while the cursor is behind', () => {
    expect(unreadAtOf({ lastActivitySeq: 5, lastActivityAt: 500 }, 4)).toBe(500)
    expect(unreadAtOf({ lastActivitySeq: 5, lastActivityAt: 500 }, 5)).toBeNull()
    expect(unreadAtOf(undefined, -1)).toBeNull()
  })


  it('falls back to the last prompt when the activity unit is not materialized', () => {
    expect(unreadCut(undefined, 700, undefined)).toBe(700)
    expect(unreadCut(undefined, 700, { readSeq: -1, readAt: 700 })).toBeNull()
    expect(unreadCut(undefined, 700, { readSeq: -1, readAt: 600 })).toBe(700)
    expect(unreadCut(undefined, undefined, undefined)).toBeNull()
    expect(unreadCut({ lastActivitySeq: 5, lastActivityAt: 500 }, 700, { readSeq: 5, readAt: 500 })).toBeNull()
  })

  it('rejects malformed projection values', () => {
    expect(activityOf({ lastActivitySeq: -2, lastActivityAt: 1 })).toBeUndefined()
    expect(activityOf({ lastActivitySeq: 1, lastActivityAt: 'now' })).toBeUndefined()
    expect(activityOf({ lastActivitySeq: 1, lastActivityAt: null })).toEqual({
      lastActivitySeq: 1,
      lastActivityAt: null,
    })
  })
})

describe('SessionUnreadController compare-and-clear', () => {
  it('rejects a stale expected cut without writing', async () => {
    const test = await harness({ lastActivitySeq: 3, lastActivityAt: 300 })
    await expect(test.controller.markRead({ sessionId: 's1', expectedUnreadAt: 999 })).resolves.toEqual({
      cleared: false,
      unreadAt: 300,
    })
    expect(test.table.size).toBe(0)
  })

  it('clears a matching cut, persists the cursor, and lists it', async () => {
    const test = await harness({ lastActivitySeq: 3, lastActivityAt: 300 })
    await expect(test.controller.markRead({ sessionId: 's1', expectedUnreadAt: 300 })).resolves.toEqual({
      cleared: true,
      unreadAt: null,
    })
    expect(test.table.get('s1')).toEqual({ readSeq: 3, readAt: 300 })
    await expect(test.controller.baselines()).resolves.toEqual({
      items: [{ sessionId: 's1', readSeq: 3, readAt: 300 }],
    })
  })

  it('reports activity that raced with a successful clear', async () => {
    const test = await harness({ lastActivitySeq: 3, lastActivityAt: 300 })
    test.onPut(() => {
      test.setActivity({ lastActivitySeq: 4, lastActivityAt: 400 })
    })
    await expect(test.controller.markRead({ sessionId: 's1', expectedUnreadAt: 300 })).resolves.toEqual({
      cleared: true,
      unreadAt: 400,
    })
    expect(test.table.get('s1')).toEqual({ readSeq: 3, readAt: 300 })
  })

  it('reads a persisted log without attaching an Agent', async () => {
    const test = await harness({ lastActivitySeq: 3, lastActivityAt: 300 })
    await expect(test.controller.markRead({ sessionId: 'cold', expectedUnreadAt: 100 })).resolves.toEqual({
      cleared: true,
      unreadAt: null,
    })
    expect(test.table.get('cold')).toEqual({ readSeq: 1, readAt: 100 })
  })

  it('rejects an unknown persisted session', async () => {
    const test = await harness({ lastActivitySeq: 3, lastActivityAt: 300 })
    await expect(test.controller.markRead({ sessionId: 'missing', expectedUnreadAt: 300 })).rejects.toThrow(
      /no such session/,
    )
  })
})
