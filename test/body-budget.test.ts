import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { withBodyBudget } from '../src/body-budget.ts'
import type { HostBridge, HostRpcResult } from '../src/bridge.ts'

interface EventRecord {
  type: 'event'
  event: { type: string; seq: number; time: number; data: Record<string, unknown> }
}

interface FollowSnapshot {
  type: 'snapshot'
  header: { id: string; version: number; createdAt: number; isSeeded: boolean }
  cursor: number
  records: EventRecord[]
  hasMore: boolean
  projections: { asOfSeq: number; values: Record<string, never> }
}

function assistantEvent(seq: number, text: string, stream: unknown[] = []): EventRecord {
  return {
    type: 'event',
    event: {
      type: 'assistant/message',
      seq,
      time: seq,
      data: {
        turn: 1,
        step: 1,
        message: { id: `m-${String(seq)}`, content: [{ type: 'text', text }] },
        stream,
      },
    },
  }
}

function toolResultEvent(seq: number, text: string): EventRecord {
  return {
    type: 'event',
    event: {
      type: 'tool/result',
      seq,
      time: seq,
      data: {
        turn: 1,
        step: 1,
        message: { toolCallId: 'call-1', content: [{ type: 'text', text }] },
        meta: { diff: 'x'.repeat(5_000) },
      },
    },
  }
}

function toolCallEvent(seq: number, args: string): EventRecord {
  return {
    type: 'event',
    event: {
      type: 'tool/call',
      seq,
      time: seq,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'write', arguments: args },
    },
  }
}

function snapshot(records: EventRecord[]): FollowSnapshot {
  return {
    type: 'snapshot',
    header: { id: 's-1', version: 1, createdAt: 0, isSeeded: false },
    cursor: records.at(-1)?.event.seq ?? 0,
    records,
    hasMore: false,
    projections: { asOfSeq: records.at(-1)?.event.seq ?? 0, values: {} },
  }
}

function bridgeWith(value: unknown, frames: readonly unknown[] = []): HostBridge {
  return {
    async call(): Promise<HostRpcResult> {
      return { ok: true, value }
    },
    open() {
      return (async function* () {
        for (const frame of frames) yield frame
      })()
    },
  }
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = []
  for await (const value of stream) values.push(value)
  return values
}

function openBridge(bridge: HostBridge, payload: unknown): Promise<unknown[]> {
  return collect(bridge.open('session/follow', payload, empty(), new AbortController().signal))
}

function empty(): AsyncIterable<unknown> {
  return (async function* () {})()
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

const payload = {
  args: { request: { address: { kind: 'session', sessionId: 's-1' }, assistantStream: true } },
}

function budgeted(bridge: HostBridge, readEvents: (sessionId: string) => Promise<readonly unknown[]>) {
  return withBodyBudget(bridge, {
    maxBytes: 10_000,
    readEvents,
  })
}

describe('withBodyBudget', () => {
  it('drops the duplicate assistant stream from an opening snapshot', async () => {
    const text = 'short answer'
    const frame = snapshot([assistantEvent(1, text, [
      { type: 'text-chunks', time0: 0, index: 0, dt: [1], texts: ['short answer'] },
    ])])
    const exposed = budgeted(bridgeWith(null, [frame]), async () => [])
    const [value] = await openBridge(exposed, payload)
    const record = (value as FollowSnapshot).records[0]!
    expect(record.event.data['stream']).toEqual([])
    expect((record.event.data['message'] as { content: { text: string }[] }).content[0]!.text).toBe(text)
  })

  it('trims large display fields with resolvable body references', async () => {
    const answer = 'A'.repeat(40_000)
    const output = 'B'.repeat(20_000)
    const args = '{"content":"' + 'C'.repeat(20_000) + '"}'
    const frame = snapshot([
      assistantEvent(1, answer),
      toolCallEvent(2, args),
      toolResultEvent(3, output),
    ])
    const events = [...frame.records.map((record) => record.event)]
    const exposed = budgeted(bridgeWith(null, [frame]), async () => events)
    const [value] = await openBridge(exposed, payload)
    const trimmed = value as FollowSnapshot
    expect(bytesOf(trimmed)).toBeLessThanOrEqual(10_000)

    const message = trimmed.records[0]!.event.data['message'] as {
      content: { text: string; remoteBody?: { refId: string; hash: string; fullBytes: number } }[]
    }
    const block = message.content[0]!
    expect(block.text.length).toBeLessThan(answer.length)
    expect(block.remoteBody?.fullBytes).toBe(Buffer.byteLength(answer))
    expect(block.remoteBody?.hash).toBe(createHash('sha256').update(answer).digest('hex'))

    const call = trimmed.records[1]!.event.data
    expect(String(call['arguments']).length).toBeLessThan(args.length)
    const callBody = call['argumentsBody'] as { refId: string }
    expect(callBody.refId).not.toBe('')

    const result = trimmed.records[2]!.event.data['message'] as {
      content: { text: string; remoteBody?: { refId: string } }[]
    }
    expect(result.content[0]!.text.length).toBeLessThan(output.length)
    expect(result.content[0]!.remoteBody).toBeDefined()

    const body = await exposed.call('remote/body', {
      args: { request: { refId: block.remoteBody!.refId } },
    })
    expect(body).toEqual({
      ok: true,
      value: {
        text: answer,
        hash: createHash('sha256').update(answer).digest('hex'),
        bytes: Buffer.byteLength(answer),
      },
    })
    await expect(exposed.call('remote/body', {
      args: { request: { refId: callBody.refId } },
    })).resolves.toMatchObject({ ok: true, value: { text: args } })
    await expect(exposed.call('remote/body', {
      args: { request: { refId: result.content[0]!.remoteBody!.refId } },
    })).resolves.toMatchObject({ ok: true, value: { text: output } })
  })

  it('drops payloads the phone never renders when previews still exceed the budget', async () => {
    const record = toolResultEvent(1, 'B'.repeat(20_000))
    record.event.data['meta'] = { diff: 'C'.repeat(50_000) }
    const exposed = budgeted(bridgeWith(null, [snapshot([record])]), async () => [record.event])
    const [value] = await openBridge(exposed, payload)
    const trimmed = value as FollowSnapshot
    expect(bytesOf(trimmed)).toBeLessThanOrEqual(10_000)
    expect('meta' in trimmed.records[0]!.event.data).toBe(false)
    const content = trimmed.records[0]!.event.data['message'] as { content: { remoteBody?: { refId: string } }[] }
    await expect(exposed.call('remote/body', {
      args: { request: { refId: content.content[0]!.remoteBody!.refId } },
    })).resolves.toMatchObject({ ok: true, value: { text: 'B'.repeat(20_000) } })
  })

  it('trims a history page with the same budget', async () => {
    const page = {
      records: [assistantEvent(1, 'A'.repeat(40_000))],
      hasMore: true,
    }
    const exposed = budgeted(bridgeWith(page), async () => [{ type: 'assistant/message', seq: 1, time: 1, data: {
      message: { content: [{ type: 'text', text: 'A'.repeat(40_000) }] },
    } }])
    const result = await exposed.call('session/page', payload)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as { records: EventRecord[]; hasMore: boolean }
    expect(value.hasMore).toBe(true)
    const content = value.records[0]!.event.data['message'] as { content: { text: string }[] }
    expect(content.content[0]!.text.length).toBeLessThan(40_000)
  })

  it('keeps live display fields and only drops delta runs', async () => {
    const answer = 'A'.repeat(40_000)
    const attempt = {
      type: 'event',
      event: {
        type: 'assistant/attempt',
        seq: 2,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          stream: [
            { type: 'text-chunks', time0: 0, index: 0, dt: [1], texts: ['A'.repeat(40_000)] },
            { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error' } } },
          ],
        },
      },
    }
    const frame = assistantEvent(1, answer)
    const exposed = budgeted(bridgeWith(null, [frame, attempt]), async () => [])
    const values = await openBridge(exposed, payload)
    const live = values[0] as EventRecord
    const message = live.event.data['message'] as { content: { text: string }[] }
    expect(message.content[0]!.text).toBe(answer)
    expect(live.event.data['stream']).toEqual([])
    const liveAttempt = values[1] as EventRecord
    expect(liveAttempt.event.data['stream']).toEqual([
      { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error' } } },
    ])
  })

  it('leaves a small snapshot otherwise untouched', async () => {
    const frame = snapshot([assistantEvent(1, 'hello')])
    const exposed = budgeted(bridgeWith(null, [frame]), async () => [])
    const [value] = await openBridge(exposed, payload)
    const content = (value as FollowSnapshot).records[0]!.event.data['message'] as {
      content: { text: string; remoteBody?: unknown }[]
    }
    expect(content.content[0]!.text).toBe('hello')
    expect(content.content[0]!.remoteBody).toBeUndefined()
  })

  it('rejects malformed and unknown references', async () => {
    const exposed = budgeted(bridgeWith(null), async () => [])
    await expect(exposed.call('remote/body', { args: { request: {} } })).resolves.toMatchObject({
      ok: false,
      error: { code: 'body/invalid-request' },
    })
    await expect(exposed.call('remote/body', { args: { request: { refId: 'not-a-ref' } } })).resolves.toMatchObject({
      ok: false,
      error: { code: 'body/invalid-ref' },
    })
    const unknown = Buffer.from(JSON.stringify({ v: 1, s: 's-1', q: 99, p: ['message'] })).toString('base64url')
    await expect(exposed.call('remote/body', { args: { request: { refId: unknown } } })).resolves.toMatchObject({
      ok: false,
      error: { code: 'body/not-found' },
    })
  })

  it('reports a Session read failure without exposing the error payload', async () => {
    const ref = [assistantEvent(1, 'A'.repeat(40_000))]
    const exposed = budgeted(bridgeWith(null, [snapshot(ref)]), async () => {
      throw new Error('corrupt log')
    })
    const [value] = await openBridge(exposed, payload)
    const content = (value as FollowSnapshot).records[0]!.event.data['message'] as {
      content: { remoteBody?: { refId: string } }[]
    }
    await expect(exposed.call('remote/body', {
      args: { request: { refId: content.content[0]!.remoteBody!.refId } },
    })).resolves.toEqual({
      ok: false,
      error: { code: 'body/read-failed', message: 'corrupt log' },
    })
  })

  it('forwards unrelated calls and streams unchanged', async () => {
    const calls: string[] = []
    const bridge: HostBridge = {
      async call(endpoint) {
        calls.push(endpoint)
        return { ok: true, value: { endpoint } }
      },
      open(endpoint) {
        return (async function* () {
          yield { endpoint }
        })()
      },
    }
    const exposed = budgeted(bridge, async () => [])
    await exposed.call('session/list', { args: {} })
    const values = await collect(exposed.open('workspace/follow', { args: {} }, empty(), new AbortController().signal))
    expect(calls).toEqual(['session/list'])
    expect(values).toEqual([{ endpoint: 'workspace/follow' }])
  })
})
