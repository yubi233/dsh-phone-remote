/**
 * Host-side unread baseline for the phone remote.
 *
 * The `unreadActivity` projection folds user prompts, assistant replies, and
 * approval requests into one activity cut. Read cursors live in a separate
 * storage domain, so marking a session read never appends to its transcript.
 * The phone compares the `unreadAt` it displayed with the current cut before
 * clearing (`expectedUnreadAt`), which prevents a stale list snapshot from
 * hiding a newer reply.
 */

/** Activity cut served through the `unreadActivity` projection. */
export interface SessionUnreadActivity {
  /** Seq of the latest unread-relevant event; -1 when none exists. */
  lastActivitySeq: number
  /** Local event time of that activity; null when none exists. */
  lastActivityAt: number | null
}

/** One durably recorded read cursor. */
interface SessionReadBaseline {
  /** Highest activity seq the reader has acknowledged. */
  readSeq: number
  /** Latest activity timestamp the reader has acknowledged; cold-session fallback. */
  readAt: number
}

/** One read cursor in the phone-facing baseline list. */
export interface SessionUnreadBaseline {
  sessionId: string
  readSeq: number
  readAt: number
}

/** Baseline list returned to the phone. */
export interface SessionUnreadBaselinesValue {
  items: SessionUnreadBaseline[]
}

/** compare-and-clear request. */
export interface SessionMarkReadRequest {
  sessionId: string
  /** The `unreadAt` the phone displayed; null means it believed the session read. */
  expectedUnreadAt: number | null
}

/** compare-and-clear outcome. */
export interface SessionMarkReadValue {
  /** True when the expected cut matched and the read cursor advanced. */
  cleared: boolean
  /** The current unread cut after the attempt; null means read. */
  unreadAt: number | null
}

/** Minimal schema surface used by projections and the storage domain. */
export interface SchemaLike<T> {
  parse(value: unknown): T
}

interface ProjectionDefinitionLike {
  key: string
  stateVersion: number
  stateSchema: SchemaLike<SessionUnreadActivity>
  init(): SessionUnreadActivity
  apply(state: SessionUnreadActivity, event: unknown): SessionUnreadActivity
  wire: {
    viewSchema: SchemaLike<SessionUnreadActivity>
    view(state: SessionUnreadActivity): SessionUnreadActivity
  }
}

interface DomainTableLike {
  get(key: string): SessionReadBaseline | undefined
  entries(): IterableIterator<[string, SessionReadBaseline]>
  put(key: string, value: SessionReadBaseline): Promise<void>
  update(key: string, fn: (current: SessionReadBaseline) => SessionReadBaseline): Promise<SessionReadBaseline>
}

interface StorageDomainLike {
  table(name: string): DomainTableLike
  close(): Promise<void>
}

interface DomainSpecLike {
  name: string
  version: number
  tables: Record<string, { valueSchema: SchemaLike<unknown> }>
}

/** Services the unread controller needs from the DSH Host context. */
export interface SessionUnreadContext {
  sessions: { get(sessionId: string): unknown }
  sessionQuery: {
    readSession(sessionId: string): Promise<{ session: { createdAt: number }; events: unknown[]; inheritedEventCount: number }>
  }
  sessionProjections: {
    register(definition: ProjectionDefinitionLike): () => void
    snapshot(session: unknown): { values: Record<string, unknown> }
  }
  storageDomain: { open(spec: DomainSpecLike): Promise<StorageDomainLike> }
  effect?(callback: () => void | Promise<void> | (() => void | Promise<void>)): void
  logger?: { error?(message: string): void }
}

const EMPTY_ACTIVITY: SessionUnreadActivity = Object.freeze({
  lastActivitySeq: -1,
  lastActivityAt: null,
})

const activitySchema: SchemaLike<SessionUnreadActivity> = {
  parse(value: unknown): SessionUnreadActivity {
    if (!isRecord(value)) throw new Error('unreadActivity must be an object')
    const lastActivitySeq = value['lastActivitySeq']
    const lastActivityAt = value['lastActivityAt']
    if (typeof lastActivitySeq !== 'number' || !Number.isInteger(lastActivitySeq) || lastActivitySeq < -1) {
      throw new Error('unreadActivity.lastActivitySeq must be an integer >= -1')
    }
    if (lastActivityAt !== null && (typeof lastActivityAt !== 'number' || !Number.isFinite(lastActivityAt))) {
      throw new Error('unreadActivity.lastActivityAt must be a finite number or null')
    }
    return { lastActivitySeq, lastActivityAt }
  },
}

const readBaselineSchema: SchemaLike<SessionReadBaseline> = {
  parse(value: unknown): SessionReadBaseline {
    if (!isRecord(value)) throw new Error('session read baseline must be an object')
    const readSeq = value['readSeq']
    const readAt = value['readAt']
    if (typeof readSeq !== 'number' || !Number.isInteger(readSeq) || readSeq < -1) {
      throw new Error('session read baseline readSeq must be an integer >= -1')
    }
    if (typeof readAt !== 'number' || !Number.isFinite(readAt) || readAt < 0) {
      throw new Error('session read baseline readAt must be a finite number >= 0')
    }
    return { readSeq, readAt }
  },
}

/** Fold one committed session event into the unread activity cut. */
export function unreadActivityProjectionDefinition(): ProjectionDefinitionLike {
  return {
    key: 'unreadActivity',
    stateVersion: 1,
    stateSchema: activitySchema,
    init: () => EMPTY_ACTIVITY,
    apply: (state, event) => {
      const cut = activityCut(event)
      return cut === undefined ? state : cut
    },
    wire: {
      viewSchema: activitySchema,
      view: (state) => state,
    },
  }
}

/** Read the current unread cut from a projection snapshot. */
export function unreadAtOf(
  activity: SessionUnreadActivity | undefined,
  readSeq: number,
): number | null {
  if (activity === undefined || activity.lastActivityAt === null) return null
  return activity.lastActivitySeq > readSeq ? activity.lastActivityAt : null
}

/**
 * Resolve the unread cut for one listed Session.
 *
 * The exact `unreadActivity` unit is authoritative once materialized. Cold or
 * historically cached sessions may not have that unit yet, so their
 * `sessionListMetadata.lastPromptAt` is the fallback; it covers user prompts
 * and is present for every listed Session.
 */
export function unreadCut(
  activity: SessionUnreadActivity | undefined,
  lastPromptAt: unknown,
  baseline: SessionReadBaseline | undefined,
): number | null {
  const readSeq = baseline?.readSeq ?? -1
  if (activity !== undefined && activity.lastActivityAt !== null) return unreadAtOf(activity, readSeq)
  return fallbackCut(typeof lastPromptAt === 'number' ? lastPromptAt : 0, baseline)
}

/** Prompt-time fallback used while the exact activity unit is not materialized. */
function fallbackCut(fallbackAt: number, baseline: SessionReadBaseline | undefined): number | null {
  if (!Number.isFinite(fallbackAt) || fallbackAt <= 0) return null
  return fallbackAt > (baseline?.readAt ?? 0) ? fallbackAt : null
}

/** Read the projection value from an unknown snapshot payload. */
export function activityOf(value: unknown): SessionUnreadActivity | undefined {
  if (value === undefined) return undefined
  try {
    return activitySchema.parse(value)
  } catch {
    return undefined
  }
}

/** Persisted read cursors plus compare-and-clear over the activity projection. */
export class SessionUnreadController {
  readonly #ctx: SessionUnreadContext
  readonly #ready: Promise<DomainTableLike>
  #domain: StorageDomainLike | undefined
  #closed = false

  constructor(ctx: SessionUnreadContext) {
    this.#ctx = ctx
    ctx.sessionProjections.register(unreadActivityProjectionDefinition())
    this.#ready = this.#open()
    void this.#ready.catch((error: unknown) => {
      ctx.logger?.error?.(`web-remote-host: unread storage failed: ${messageOf(error)}`)
    })
  }

  /** Wait until the durable read table is available. */
  async ready(): Promise<void> {
    await this.#ready
  }

  /** List every stored read cursor. */
  async baselines(): Promise<SessionUnreadBaselinesValue> {
    const table = await this.#ready
    return {
      items: [...table.entries()].map(([sessionId, value]) => ({
        sessionId,
        readSeq: value.readSeq,
        readAt: value.readAt,
      })),
    }
  }

  /**
   * Compare the cut the phone displayed with the current cut.
   *
   * A mismatch returns the newer cut without writing. A match advances the
   * durable cursor and reports the cut that remains after any racing activity.
   */
  async markRead(request: SessionMarkReadRequest): Promise<SessionMarkReadValue> {
    const table = await this.#ready
    const baseline = table.get(request.sessionId)
    const live = this.#ctx.sessions.get(request.sessionId)
    let activity: SessionUnreadActivity | undefined
    let fallbackAt: number
    if (live !== undefined) {
      const values = this.#ctx.sessionProjections.snapshot(live).values
      activity = activityOf(values['unreadActivity'])
      const metadata = values['sessionListMetadata']
      const lastPromptAt = isRecord(metadata) ? metadata['lastPromptAt'] : undefined
      fallbackAt = Math.max(createdAtOf(live), typeof lastPromptAt === 'number' ? lastPromptAt : 0)
    } else {
      const snapshot = await this.#ctx.sessionQuery.readSession(request.sessionId)
      const folded = foldColdActivity(snapshot.events, snapshot.inheritedEventCount)
      activity = folded.activity
      fallbackAt = Math.max(snapshot.session.createdAt, folded.lastPromptAt ?? 0)
    }
    const exact = unreadAtOf(activity, baseline?.readSeq ?? -1)
    const fallback = fallbackCut(fallbackAt, baseline)
    const currentUnreadAt = exact ?? fallback
    // The phone may see the exact cut (materialized unit) or the prompt
    // fallback (cold listing); either displayed value is a valid expectation.
    if (request.expectedUnreadAt !== exact && request.expectedUnreadAt !== fallback) {
      return { cleared: false, unreadAt: currentUnreadAt }
    }
    if (currentUnreadAt !== null) {
      const nextSeq = Math.max(baseline?.readSeq ?? -1, activity?.lastActivitySeq ?? -1)
      const nextAt = Math.max(
        baseline?.readAt ?? 0,
        request.expectedUnreadAt ?? 0,
        fallback ?? 0,
      )
      if (baseline === undefined) await table.put(request.sessionId, { readSeq: nextSeq, readAt: nextAt })
      else {
        await table.update(request.sessionId, current => ({
          readSeq: Math.max(current.readSeq, nextSeq),
          readAt: Math.max(current.readAt, nextAt),
        }))
      }
    }
    if (live === undefined) return { cleared: true, unreadAt: null }
    const afterValues = this.#ctx.sessionProjections.snapshot(live).values
    const after = activityOf(afterValues['unreadActivity'])
    const afterMetadata = afterValues['sessionListMetadata']
    const afterPrompt = isRecord(afterMetadata) ? afterMetadata['lastPromptAt'] : undefined
    return {
      cleared: true,
      unreadAt: unreadCut(
        after,
        Math.max(createdAtOf(live), typeof afterPrompt === 'number' ? afterPrompt : 0),
        table.get(request.sessionId),
      ),
    }
  }

  async #open(): Promise<DomainTableLike> {
    const domain = await this.#ctx.storageDomain.open({
      name: 'web_remote_unread',
      version: 1,
      tables: { sessions: { valueSchema: readBaselineSchema } },
    })
    this.#domain = domain
    if (this.#closed) {
      await domain.close()
      throw new Error('unread controller closed before storage opened')
    }
    this.#ctx.effect?.(() => () => domain.close())
    return domain.table('sessions')
  }

  /** Release the storage domain. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#ready.catch(() => undefined)
    const domain = this.#domain
    this.#domain = undefined
    if (domain !== undefined) await domain.close()
  }
}

function activityCut(event: unknown): SessionUnreadActivity | undefined {
  if (!isRecord(event)) return undefined
  const type = event['type']
  const seq = event['seq']
  const time = event['time']
  if (typeof seq !== 'number' || typeof time !== 'number') return undefined
  if (type === 'user/message') {
    const data = event['data']
    if (!isRecord(data)) return undefined
    const source = data['source']
    if (!isRecord(source) || source['kind'] !== 'user') return undefined
    return { lastActivitySeq: seq, lastActivityAt: time }
  }
  if (type === 'assistant/message' || type === 'approval/asked') {
    return { lastActivitySeq: seq, lastActivityAt: time }
  }
  return undefined
}

/** Fold a detached persisted log without attaching an Agent. */
function foldColdActivity(
  events: readonly unknown[],
  inheritedEventCount: number,
): { activity: SessionUnreadActivity | undefined; lastPromptAt: number | undefined } {
  let activity: SessionUnreadActivity | undefined
  let lastPromptAt: number | undefined
  for (let index = Math.max(0, inheritedEventCount); index < events.length; index += 1) {
    const event = events[index]
    const cut = activityCut(event)
    if (cut !== undefined) activity = cut
    if (isRecord(event) && event['type'] === 'user/message') {
      const data = event['data']
      if (isRecord(data) && isRecord(data['source']) && data['source']['kind'] === 'user') {
        const time = event['time']
        if (typeof time === 'number') lastPromptAt = time
      }
    }
  }
  return { activity, lastPromptAt }
}

function createdAtOf(session: unknown): number {
  if (!isRecord(session) || !isRecord(session['header'])) return 0
  const createdAt = session['header']['createdAt']
  return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
