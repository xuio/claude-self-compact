import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const TOOL = 'mcp__self-compact__request_compaction'
const summary: SessionMessage = { role: 'user', text: 'SUMMARY', toolUses: [] }

// Beneath the plugin: a store, HOME, a log that goes nowhere, and a compaction
// that answers one summary message.
const hello: SessionMessage = { role: 'user', text: 'hello', toolUses: [] }

function world(on: On, store: Record<string, unknown> = {}) {
  const seen = { instructions: [] as (string | undefined)[], logs: [] as { text: string; to: string }[] }
  mock.store(on, store)
  on('ui.log', ($, e) => {
    seen.logs.push(e)
    return { value: undefined }
  })
  mock.clock(on, { now: 1_000_000_000 })
  on('session.id', () => ({ value: 'S1' }))
  on('session.messages', () => ({ value: [summary] }))
  mock.env(on, { HOME: '/nonexistent-home' })
  on('session.compact', ($, e) => {
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

test('the tool refuses a second request in the same turn', async ($, on) => {
  world(on)
  const first = await $.tool.call({ tool: TOOL, carry: 'x' } as never)
  const second = await $.tool.call({ tool: TOOL } as never)
  expect(JSON.stringify(first)).toContain('Compaction scheduled')
  expect(JSON.stringify(second)).toContain('Already scheduled')
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
