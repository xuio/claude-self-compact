import { expect, mock, test, type TestBody } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const TOOL = 'mcp__self-compact__request_compaction'
const CANCEL = 'mcp__self-compact__cancel_compaction'
const summary: SessionMessage = { role: 'user', text: 'SUMMARY', toolUses: [] }

// Beneath the plugin: a store, HOME, a log that goes nowhere, and a compaction
// that answers one summary message.
const hello: SessionMessage = { role: 'user', text: 'hello', toolUses: [] }

// A store the test itself can change between calls (mock.store keeps a copy).
function liveStore(on: On, store: Record<string, unknown>) {
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
}

function world(on: On, store: Record<string, unknown> = {}, live = false) {
  const seen = {
    instructions: [] as (string | undefined)[],
    logs: [] as { text: string; to: string }[],
    prompts: [] as { text: string; context?: readonly string[] }[],
    commands: [] as string[],
    compacts: 0,
    clock: mock.clock(on, { now: 1_000_000_000 }),
  }
  if (live) liveStore(on, store)
  else mock.store(on, store)
  on('ui.log', ($, e) => {
    seen.logs.push(e)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => {
    seen.prompts.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('command.run', ($, e) => {
    seen.commands.push(e.command)
    return { text: '' }
  })
  on('session.id', () => ({ value: 'S1' }))
  on('session.messages', () => ({ value: [summary] }))
  mock.env(on, { HOME: '/nonexistent-home' })
  on('session.compact', ($, e) => {
    seen.compacts++
    seen.instructions.push(e.instructions)
    return { messages: [summary], tokensBefore: 1000, tokensAfter: 100 }
  })
  return seen
}

test('carries text verbatim after the summary and adds alwaysInstructions', { options: { alwaysInstructions: 'keep the branch name' } }, async ($, on) => {
  const seen = world(on)
  const res = await $.session.compact({ trigger: 'manual', instructions: 'the plan', messages: [hello] })
  expect(seen.instructions).toEqual(['the plan\n\nkeep the branch name'])
  expect(res.messages?.length).toBe(1)
})

test('alwaysCarry lands after every compaction', { options: { alwaysCarry: 'Re-read HANDOFF.md' } }, async ($, on) => {
  world(on)
  const res = await $.session.compact({ trigger: 'auto', messages: [hello] })
  if (!res.messages) throw new Error('skipped')
  expect(res.messages.length).toBe(2)
  expect(res.messages[1]?.text).toContain('Re-read HANDOFF.md')
  expect(res.messages[1]?.text).toContain('<self-compact-carry>')
})

test('a second request in the same turn replaces the first', async ($, on) => {
  world(on)
  const first = await $.tool.call({ tool: TOOL, carry: 'x' } as never)
  const second = await $.tool.call({ tool: TOOL } as never)
  expect(JSON.stringify(first)).toContain('Compaction scheduled')
  expect(JSON.stringify(second)).toContain('request replaced')
})

test('a replacement is not refused by minIntervalMinutes', { options: { minIntervalMinutes: 10 } }, async ($, on) => {
  const store: Record<string, unknown> = {}
  world(on, store, true)
  await $.tool.call({ tool: TOOL } as never)
  store.lastAt = { S1: 1_000_000_000 }
  const res = await $.tool.call({ tool: TOOL, carry: 'y' } as never)
  expect(JSON.stringify(res)).toContain('request replaced')
})

test('cancel_compaction drops the request', async ($, on) => {
  world(on)
  const none = await $.tool.call({ tool: CANCEL } as never)
  await $.tool.call({ tool: TOOL } as never)
  const cancelled = await $.tool.call({ tool: CANCEL } as never)
  const again = await $.tool.call({ tool: TOOL } as never)
  expect(JSON.stringify(none)).toContain('Nothing to cancel')
  expect(JSON.stringify(cancelled)).toContain('Compaction cancelled')
  expect(JSON.stringify(again)).toContain('Compaction scheduled')
})

test('the tool refuses within minIntervalMinutes of the last self-compaction', { options: { minIntervalMinutes: 10 } }, async ($, on) => {
  world(on, { lastAt: { S1: 1_000_000_000 - 60_000 } })
  const res = await $.tool.call({ tool: TOOL } as never)
  expect(JSON.stringify(res)).toContain('Not scheduled')
})

test("another session's compaction does not count", async ($, on) => {
  world(on, { lastAt: { S2: 1_000_000_000 - 60_000 } })
  const res = await $.tool.call({ tool: TOOL } as never)
  expect(JSON.stringify(res)).toContain('Compaction scheduled')
})

test('routine steps stay off the transcript', async ($, on) => {
  const seen = world(on)
  await $.tool.call({ tool: TOOL } as never)
  await $.session.compact({ trigger: 'manual', messages: [hello] })
  expect(seen.logs.length).toBe(2)
  expect(seen.logs.every(l => l.to === 'debug')).toBe(true)
})

// The desktop app sends a message typed mid-turn right after the turn ends: its
// turn (T2) starts before the compaction requested in T1 runs (seen live).
const ended = (turnId: string) =>
  ({ turnId, reason: 'answer', isAborted: false, answer: '', durationMs: 1 }) as const

async function queuedTurn($: Parameters<TestBody>[0], seen: ReturnType<typeof world>) {
  await $.turn.start({ turnId: 'T1', text: 'work' })
  await $.tool.call({ tool: TOOL, carry: 'c', resume: 'go on' } as never)
  await $.turn.complete(ended('T1'))
  await $.prompt.submit({ text: 'queued-test' } as never)
  await $.turn.start({ turnId: 'T2', text: 'queued-test' })
  await seen.clock.settle()
}

test('a turn that starts first keeps the request pending and cancellable', async ($, on) => {
  const seen = world(on)
  await queuedTurn($, seen)
  expect(seen.compacts).toBe(0)
  expect(JSON.stringify(seen.prompts[0]?.context ?? [])).toContain('has not run yet')
  const cancelled = await $.tool.call({ tool: CANCEL } as never)
  expect(JSON.stringify(cancelled)).toContain('Compaction cancelled')
  await $.turn.complete(ended('T2'))
  await seen.clock.advance(200_000)
  expect(seen.compacts).toBe(0)
  expect(seen.commands).toEqual([])
})

test('a deferred request runs when the other turn ends, then resumes', async ($, on) => {
  const seen = world(on)
  await queuedTurn($, seen)
  expect(seen.compacts).toBe(0)
  await $.turn.complete(ended('T2'))
  await seen.clock.settle()
  expect(seen.compacts).toBe(1)
  expect(seen.prompts.map(p => p.text)).toEqual(['queued-test', 'go on'])
})
