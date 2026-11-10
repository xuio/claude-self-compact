import { expect, mock, test, type TestBody } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const TOOL = 'mcp__self-compact__request_compaction'
const CANCEL = 'mcp__self-compact__cancel_compaction'
const WORK = 'mcp__lab__run' // any other tool the agent might call
const NOTES = 'mcp__notes__write'
const summary: SessionMessage = { role: 'user', text: 'SUMMARY', toolUses: [] }

// Beneath the plugin: a store, HOME, a log file kept in memory, the context size
// the host reports, and a compaction that answers one summary message.
const hello: SessionMessage = { role: 'user', text: 'hello', toolUses: [] }

// A store the test itself can change between calls (mock.store keeps a copy).
function liveStore(on: On, store: Record<string, unknown>) {
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
}

function world(on: On, store: Record<string, unknown> = {}, live = false, env: Record<string, string> = {}) {
  const seen = {
    instructions: [] as (string | undefined)[],
    logs: [] as { text: string; to: string }[],
    prompts: [] as { text: string; context?: readonly string[] }[],
    commands: [] as string[],
    args: [] as string[],
    appended: [] as string[],
    files: {} as Record<string, string>,
    hold: false, // the plugin's own prompts wait (the session never goes idle)
    skip: undefined as string | undefined, // another plugin's hook skips every compaction
    tries: 0, // the compactions asked for, skipped ones included
    refuses: false, // the host refuses a compaction between turns (as the desktop app does)
    usage: undefined as number | undefined, // the context tokens the host reports
    after: 100, // the context tokens a compaction leaves
    root: undefined as string | undefined, // the project root, where the host reports one
    compacts: 0,
    ran: [] as string[], // the other tools that really ran
    aborted: [] as string[], // the turns the plugin ended
    clock: mock.clock(on, { now: 1_000_000_000 }),
  }
  for (const tool of [WORK, NOTES]) {
    on('tool.call', { tool } as never, () => {
      seen.ran.push(tool)
      return { result: 'ran' } as never
    })
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
  on('session.append', ($, e, next) => {
    seen.appended.push(JSON.stringify(e.message))
    return next(e)
  })
  on('prompt.submit', async ($, e) => {
    if (seen.hold && e.origin?.kind === 'plugin') await seen.clock.sleep(1e9)
    seen.prompts.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('turn.abort', ($, e) => {
    seen.aborted.push(e.turnId)
    return { value: undefined }
  })
  on('command.run', ($, e) => {
    seen.commands.push(e.command)
    seen.args.push(e.args ?? '')
    return { text: '' }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: seen.usage === undefined ? { window: 200_000 } : { tokens: seen.usage, window: 200_000 },
      rateLimits: [],
    },
  }))
  on('fs.read', ($, e) => {
    // A missing file rejects, as the real fs.read does (the log reader catches it).
    const text = seen.files[e.path]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('session.root', () => {
    return seen.root === undefined ? { deny: 'no project root' } : { value: seen.root }
  })
  on('fs.write', ($, e) => {
    seen.files[e.path] = e.text
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'S1' }))
  on('session.messages', () => ({ value: [summary] }))
  mock.env(on, { HOME: '/nonexistent-home', ...env })
  on('session.compact', ($, e) => {
    if (seen.refuses) throw new Error('no compaction between turns here')
    seen.tries++
    if (seen.skip !== undefined) return { skip: seen.skip } as never
    seen.compacts++
    seen.instructions.push(e.instructions)
    return { messages: [summary], tokensBefore: 1000, tokensAfter: seen.after }
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
  expect(seen.prompts.map(p => p.text.split('\n')[0])).toEqual(['queued-test', 'go on'])
})

// A subagent message queued during the compaction starts the next turn; the
// resume prompt waits for an idle session (seen live in the desktop app).
test('the resume text is carried and a waiting resume prompt blocks nothing', async ($, on) => {
  const seen = world(on)
  seen.hold = true
  await $.turn.start({ turnId: 'T1', text: 'work' })
  await $.tool.call({ tool: TOOL, carry: 'ids', resume: 'add the row' } as never)
  await $.turn.complete(ended('T1'))
  await seen.clock.settle()
  expect(seen.compacts).toBe(1)
  expect(seen.appended.join()).toContain('add the row')
  expect(seen.prompts).toEqual([])
  await $.turn.start({ turnId: 'T2', text: 'agent message' })
  await seen.clock.advance(11 * 60_000)
  const again = await $.tool.call({ tool: TOOL } as never)
  expect(JSON.stringify(again)).toContain('Compaction scheduled')
})

test('a misspelled field is refused, not dropped', async ($, on) => {
  const seen = world(on)
  const bad = await $.tool.call({ tool: TOOL, carry: 'c', resume_prompt: 'go on' } as never)
  expect(JSON.stringify(bad)).toContain('unknown field resume_prompt')
  const none = await $.tool.call({ tool: CANCEL } as never)
  expect(JSON.stringify(none)).toContain('Nothing to cancel')
  const ok = await $.tool.call({ tool: TOOL, carry: 'c' } as never)
  expect(JSON.stringify(ok)).toContain('no resume')
  expect(seen.logs.some(l => l.text.includes('refused: unknown field'))).toBe(true)
})

const NOW = 1_000_000_000
const MIN = 60_000

// 0.3 refused every request within 10 minutes of the last self-compaction, also
// when the context had filled again. 0.3 stored one number per session.
test('a second self-compaction a minute later is allowed by default', async ($, on) => {
  world(on, { lastAt: { S1: NOW - MIN } })
  const res = await $.tool.call({ tool: TOOL } as never)
  expect(JSON.stringify(res)).toContain('Compaction scheduled')
})

// Since 0.5.1 the limits are options: nothing is refused for its rate or its
// size unless burstLimit, minIntervalMinutes or minContextTokens is set.
test('by default there is no burst limit', async ($, on) => {
  world(on, { lastAt: { S1: [NOW - 9 * MIN, NOW - 7 * MIN, NOW - 5 * MIN, NOW - 3 * MIN, NOW - MIN] } })
  const res = await $.tool.call({ tool: TOOL } as never)
  expect(JSON.stringify(res)).toContain('Compaction scheduled')
})

test('the burst limit refuses the next request and says when to retry', { options: { burstLimit: 3 } }, async ($, on) => {
  world(on, { lastAt: { S1: [NOW - 25 * MIN, NOW - 10 * MIN, NOW - MIN] } })
  const res = JSON.stringify(await $.tool.call({ tool: TOOL } as never))
  expect(res).toContain('Not scheduled: 3 self-compactions in the last 30 min')
  expect(res).toContain('allowed in 5 min')
})

test('self-compactions older than the window do not count', { options: { burstLimit: 3 } }, async ($, on) => {
  world(on, { lastAt: { S1: [NOW - 40 * MIN, NOW - 10 * MIN, NOW - MIN] } })
  const res = await $.tool.call({ tool: TOOL } as never)
  expect(JSON.stringify(res)).toContain('Compaction scheduled')
})

test('every self-compaction is recorded, so the burst limit holds across turns', { options: { burstLimit: 3 } }, async ($, on) => {
  const store: Record<string, unknown> = {}
  const seen = world(on, store, true)
  for (const turn of ['T1', 'T2', 'T3']) {
    await $.turn.start({ turnId: turn, text: 'work' })
    expect(JSON.stringify(await $.tool.call({ tool: TOOL } as never))).toContain('Compaction scheduled')
    await $.turn.complete(ended(turn))
    await seen.clock.settle()
    await seen.clock.advance(MIN)
  }
  expect(seen.compacts).toBe(3)
  expect((store.lastAt as Record<string, number[]>).S1?.length).toBe(3)
  const fourth = JSON.stringify(await $.tool.call({ tool: TOOL } as never))
  expect(fourth).toContain('Not scheduled: 3 self-compactions')
})

test('a context that is still small is refused; an unknown size is not', { options: { minContextTokens: 40000 } }, async ($, on) => {
  const seen = world(on)
  seen.usage = 20_000
  const small = JSON.stringify(await $.tool.call({ tool: TOOL } as never))
  expect(small).toContain('Not scheduled: your context holds 20k tokens')
  seen.usage = undefined
  const unknown = await $.tool.call({ tool: TOOL } as never)
  expect(JSON.stringify(unknown)).toContain('Compaction scheduled')
})

test('by default a small context is not refused', async ($, on) => {
  const seen = world(on)
  seen.usage = 20_000
  const res = JSON.stringify(await $.tool.call({ tool: TOOL } as never))
  expect(res).toContain('Compaction scheduled')
  expect(res).toContain('context 20k of 200k tokens')
})

// The tool compacts the main conversation: a sub-agent that calls it would
// compact (or un-schedule) under the main agent.
test('a sub-agent can neither request nor cancel', async ($, on) => {
  const seen = world(on)
  const asked = await $.tool.call({ tool: TOOL, carry: 'x', agentId: 'agent-1' } as never)
  expect(JSON.stringify(asked)).toContain('only the main agent')
  expect(JSON.stringify(await $.tool.call({ tool: CANCEL } as never))).toContain('Nothing to cancel')
  await $.tool.call({ tool: TOOL, carry: 'main' } as never)
  const cancel = await $.tool.call({ tool: CANCEL, agentId: 'agent-1' } as never)
  expect(JSON.stringify(cancel)).toContain('only the main agent')
  expect(JSON.stringify(await $.tool.call({ tool: CANCEL } as never))).toContain('Compaction cancelled')
  expect(seen.logs.filter(l => l.text.includes('sub-agent agent-1')).length).toBe(2)
})

test('a field over the limit is refused with its length, and nothing is cut', async ($, on) => {
  world(on)
  const first = await $.tool.call({ tool: TOOL, carry: 'short' } as never)
  expect(JSON.stringify(first)).toContain('Compaction scheduled')
  const long = JSON.stringify(await $.tool.call({ tool: TOOL, carry: 'x'.repeat(8001), resume: 'go on' } as never))
  expect(long).toContain('Not scheduled: carry is 8001 characters')
  expect(long).toContain('stays scheduled')
  const limit = await $.tool.call({ tool: TOOL, carry: 'x'.repeat(8000) } as never)
  expect(JSON.stringify(limit)).toContain('carry 8000 chars')
})

test('a stopped turn drops the request and the model is told once', async ($, on) => {
  const seen = world(on)
  await $.turn.start({ turnId: 'T1', text: 'work' })
  await $.tool.call({ tool: TOOL, carry: 'c' } as never)
  await $.turn.complete({ turnId: 'T1', reason: 'aborted', isAborted: true, answer: '', durationMs: 1 } as never)
  await seen.clock.settle()
  expect(seen.compacts).toBe(0)
  await $.prompt.submit({ text: 'next' } as never)
  await $.prompt.submit({ text: 'later' } as never)
  expect(JSON.stringify(seen.prompts[0]?.context ?? [])).toContain('did not run (the turn it was scheduled in was stopped')
  expect(seen.prompts[1]?.context).toBe(undefined)
})

// The desktop app: no compaction between turns, so /compact runs instead, and the
// session.compact hook does not see that either (seen live, 44 of 44).
test('the /compact fallback gets alwaysInstructions and alwaysCarry', { options: { alwaysInstructions: 'keep the branch name', alwaysCarry: 'Re-read HANDOFF.md' } }, async ($, on) => {
  const seen = world(on)
  seen.refuses = true
  await $.turn.start({ turnId: 'T1', text: 'work' })
  await $.tool.call({ tool: TOOL, instructions: 'the plan', carry: 'ids' } as never)
  await $.turn.complete(ended('T1'))
  for (let i = 0; i < 130; i++) await seen.clock.advance(1000) // past the retries
  expect(seen.compacts).toBe(0)
  expect(seen.commands).toEqual(['compact'])
  expect(seen.args).toEqual(['the plan\n\nkeep the branch name'])
  expect(seen.appended.length).toBe(1)
  expect(seen.appended[0]).toContain('Re-read HANDOFF.md')
  expect(seen.appended[0]).toContain('ids')
})

test('alwaysInstructions is not added twice', { options: { alwaysInstructions: 'keep the branch name' } }, async ($, on) => {
  const seen = world(on)
  await $.session.compact({ trigger: 'manual', instructions: 'the plan\n\nkeep the branch name', messages: [hello] })
  expect(seen.instructions).toEqual(['the plan\n\nkeep the branch name'])
})

// The plugin's own session.compact hook does not see a compaction the plugin
// starts: 0.3 lost alwaysInstructions and alwaysCarry on every self-compaction.
test('a self-compaction gets alwaysInstructions and carries alwaysCarry once', { options: { alwaysInstructions: 'keep the branch name', alwaysCarry: 'Re-read HANDOFF.md' } }, async ($, on) => {
  const seen = world(on)
  await $.turn.start({ turnId: 'T1', text: 'work' })
  await $.tool.call({ tool: TOOL, instructions: 'the plan', carry: 'ids' } as never)
  await $.turn.complete(ended('T1'))
  await seen.clock.settle()
  expect(seen.compacts).toBe(1)
  expect(seen.instructions).toEqual(['the plan\n\nkeep the branch name'])
  expect(seen.appended.length).toBe(1)
  expect(seen.appended[0]).toContain('Re-read HANDOFF.md')
  expect(seen.appended[0]).toContain('ids')
})

// A task notification or a typed message delivered into the turn that made the
// request (seen live: 67 notes for 43 requests, 25 needless replacements).
test('a prompt delivered into the turn of the request gets one short note', async ($, on) => {
  const seen = world(on)
  await $.turn.start({ turnId: 'T1', text: 'work' })
  await $.tool.call({ tool: TOOL, carry: 'c' } as never)
  await $.prompt.submit({ text: 'first', turnId: 'T1' } as never)
  await $.prompt.submit({ text: 'second', turnId: 'T1' } as never)
  const note = JSON.stringify(seen.prompts[0]?.context ?? [])
  expect(note).toContain('still scheduled for the end of this turn')
  expect(note).toContain('The request stands')
  expect(seen.prompts[1]?.context).toBe(undefined)
})

test('a later turn gets the long note once', async ($, on) => {
  const seen = world(on)
  await queuedTurn($, seen)
  await $.prompt.submit({ text: 'into T2', turnId: 'T2' } as never)
  expect(JSON.stringify(seen.prompts[0]?.context ?? [])).toContain('has not run yet')
  expect(seen.prompts[1]?.context).toBe(undefined)
})

test('what the engine adds beside the arguments is not taken for a misspelled field', async ($, on) => {
  world(on)
  const res = await $.tool.call({ tool: TOOL, carry: 'c', requestMeta: { trace: 'x' } } as never)
  expect(JSON.stringify(res)).toContain('Compaction scheduled')
})

test('log lines name the session', async ($, on) => {
  const seen = world(on)
  await $.tool.call({ tool: TOOL } as never)
  await $.tool.call({ tool: CANCEL } as never)
  const lines = (seen.files['/nonexistent-home/.claude/self-compact/mod.log'] ?? '').trim().split('\n')
  expect(lines.length).toBe(2)
  expect(lines[0]).toContain(' S1 scheduled for end of turn')
  expect(lines[1]).toContain(' S1 cancelled')
})

// The compaction needs the turn to end. Agents often kept working after the
// request, the context filled up and the automatic compaction fired first.
test('after a request the main agent\'s other tool calls are refused until it ran', async ($, on) => {
  const seen = world(on)
  await $.turn.start({ turnId: 'T1', text: 'work' })
  await $.tool.call({ tool: WORK } as never)
  expect(seen.ran).toEqual([WORK])
  await $.tool.call({ tool: TOOL, carry: 'c' } as never)
  const refused = JSON.stringify(await $.tool.call({ tool: WORK } as never))
  expect(refused).toContain('you scheduled a compaction')
  expect(refused).toContain('End your turn now')
  expect(seen.ran).toEqual([WORK])
  await $.tool.call({ tool: WORK, agentId: 'agent-1' } as never) // a sub-agent goes on working
  expect(seen.ran).toEqual([WORK, WORK])
  await $.turn.complete(ended('T1'))
  await seen.clock.settle()
  expect(seen.compacts).toBe(1)
  await $.tool.call({ tool: WORK } as never)
  expect(seen.ran).toEqual([WORK, WORK, WORK])
})

test('a refused agent can replace or cancel the request, and then work again', async ($, on) => {
  const seen = world(on)
  await $.tool.call({ tool: TOOL, carry: 'c' } as never)
  await $.tool.call({ tool: WORK } as never)
  await $.tool.call({ tool: WORK } as never)
  const third = JSON.stringify(await $.tool.call({ tool: WORK } as never))
  expect(third).toContain('refusal 3 in a row')
  const replaced = await $.tool.call({ tool: TOOL, carry: 'new step' } as never)
  expect(JSON.stringify(replaced)).toContain('request replaced')
  expect(JSON.stringify(await $.tool.call({ tool: CANCEL } as never))).toContain('Compaction cancelled')
  await $.tool.call({ tool: WORK } as never)
  expect(seen.ran).toEqual([WORK])
  expect(seen.logs.filter(l => l.text.includes(`refused ${WORK}`)).length).toBe(3)
})

test('a turn that starts before the compaction is refused tools too, then compacts', async ($, on) => {
  const seen = world(on)
  await queuedTurn($, seen)
  expect(JSON.stringify(seen.prompts[0]?.context ?? [])).toContain('your other tool calls are refused')
  expect(JSON.stringify(await $.tool.call({ tool: WORK } as never))).toContain('you scheduled a compaction')
  await $.turn.complete(ended('T2'))
  await seen.clock.settle()
  expect(seen.compacts).toBe(1)
  expect(seen.ran).toEqual([])
})

test('allowAfterRequest names tools that stay allowed', { options: { allowAfterRequest: 'SendMessage, mcp__notes__*' } }, async ($, on) => {
  const seen = world(on)
  await $.tool.call({ tool: TOOL, carry: 'c' } as never)
  await $.tool.call({ tool: NOTES } as never)
  expect(JSON.stringify(await $.tool.call({ tool: WORK } as never))).toContain('you scheduled a compaction')
  expect(seen.ran).toEqual([NOTES])
})

test('blockToolsAfterRequest off: the call runs and the agent is reminded', { options: { blockToolsAfterRequest: false } }, async ($, on) => {
  const seen = world(on)
  const scheduled = JSON.stringify(await $.tool.call({ tool: TOOL, carry: 'c' } as never))
  expect(scheduled).not.toContain('are refused')
  const res = JSON.stringify(await $.tool.call({ tool: WORK } as never))
  expect(seen.ran).toEqual([WORK])
  expect(res).toContain('waiting for this turn to end')
})

test('an agent that will not end its turn has it ended, and the compaction runs', async ($, on) => {
  const seen = world(on)
  await $.turn.start({ turnId: 'T1', text: 'work' })
  await $.tool.call({ tool: TOOL, carry: 'c', resume: 'go on' } as never)
  let last = ''
  for (let i = 0; i < 6; i++) last = JSON.stringify(await $.tool.call({ tool: WORK } as never))
  await seen.clock.settle()
  expect(last).toContain('the self-compact plugin is ending it now')
  expect(seen.aborted).toEqual(['T1'])
  expect(seen.ran).toEqual([])
  await $.turn.complete({ turnId: 'T1', reason: 'aborted', isAborted: true, answer: '', durationMs: 1 } as never)
  await seen.clock.settle()
  expect(seen.compacts).toBe(1)
  expect(seen.prompts.map(p => p.text.split('\n')[0])).toEqual(['go on'])
})

test('where the turn cannot be ended the request is cancelled and the agent is told', async ($, on) => {
  const seen = world(on) // no turn.start: the plugin knows no running turn
  await $.tool.call({ tool: TOOL, carry: 'c' } as never)
  for (let i = 0; i < 6; i++) await $.tool.call({ tool: WORK } as never)
  await seen.clock.settle()
  expect(seen.aborted).toEqual([])
  await $.tool.call({ tool: WORK } as never)
  expect(seen.ran).toEqual([WORK])
  await $.prompt.submit({ text: 'next' } as never)
  expect(JSON.stringify(seen.prompts[0]?.context ?? [])).toContain('the request was cancelled')
})

// 0.6.0: an agent that never asks ran into the host's automatic compaction mid-task,
// with nothing carried. remindAtTokens asks it to; autoCompactAtTokens is the safety net.
const remindAt = { remindAtTokens: 100_000, autoCompactAtTokens: 150_000 }

test('remindAtTokens: one note per turn, beside the first tool result, from the reminder point on', { options: remindAt }, async ($, on) => {
  const seen = world(on)
  seen.usage = 90_000
  await $.turn.start({ turnId: 'T1', text: 'work' })
  expect(JSON.stringify(await $.tool.call({ tool: WORK } as never))).not.toContain('self-compact')
  seen.usage = 120_000
  expect(JSON.stringify(await $.tool.call({ tool: WORK, agentId: 'agent-1' } as never))).not.toContain('self-compact')
  const first = JSON.stringify(await $.tool.call({ tool: WORK } as never))
  expect(first).toContain('your context holds 120k tokens, past the reminder point of 100k')
  expect(first).toContain('call request_compaction as the last action of this turn')
  expect(first).toContain('From 150k tokens the plugin compacts by itself')
  expect(JSON.stringify(await $.tool.call({ tool: WORK } as never))).not.toContain('self-compact')
  await $.turn.complete(ended('T1'))
  await seen.clock.settle()
  expect(seen.compacts).toBe(0) // below autoCompactAtTokens
  // A prompt that starts the next turn gets the note; that turn's tool results do not.
  await $.prompt.submit({ text: 'next' } as never)
  await $.turn.start({ turnId: 'T2', text: 'next' })
  expect(JSON.stringify(seen.prompts[0]?.context ?? [])).toContain('past the reminder point')
  expect(JSON.stringify(await $.tool.call({ tool: WORK } as never))).not.toContain('self-compact')
  expect(seen.ran.length).toBe(5)
})

test('remindAtTokens: within one long turn the note comes again after 20k of growth, and names the own compaction', { options: remindAt }, async ($, on) => {
  const seen = world(on)
  const call = async (tokens: number) => {
    seen.usage = tokens
    return JSON.stringify(await $.tool.call({ tool: WORK } as never))
  }
  await $.turn.start({ turnId: 'T1', text: 'work' })
  expect(await call(120_000)).toContain('your context holds 120k tokens')
  expect(await call(135_000)).not.toContain('self-compact')
  const second = await call(141_000)
  expect(second).toContain('your context has grown to 141k tokens and no compaction is requested (reminder point 100k)')
  expect(second).toContain('From 150k tokens the plugin compacts by itself')
  expect(await call(155_000)).not.toContain('self-compact')
  const third = await call(165_000)
  expect(third).toContain('has grown to 165k tokens')
  expect(third).toContain('It is past 150k tokens: when this turn ends the plugin compacts by itself')
  expect(seen.logs.filter(l => l.text.startsWith('self-compact: reminded')).length).toBe(3)
  // Once the agent has asked, the notes stop.
  await $.tool.call({ tool: TOOL, carry: 'c' } as never)
  expect(await call(199_000)).not.toContain('reminder point')
})

test('remindAtTokens: no note while a request waits, where the size is unknown, or by default', { options: { remindAtTokens: 100_000 } }, async ($, on) => {
  const seen = world(on)
  await $.turn.start({ turnId: 'T1', text: 'work' })
  const unknown = JSON.stringify(await $.tool.call({ tool: WORK } as never))
  expect(unknown).not.toContain('self-compact')
  seen.usage = 120_000
  const scheduled = JSON.stringify(await $.tool.call({ tool: TOOL, carry: 'c' } as never))
  expect(scheduled).not.toContain('reminder point')
  expect(JSON.stringify(await $.tool.call({ tool: WORK } as never))).not.toContain('reminder point')
  const note = JSON.stringify(await $.tool.call({ tool: CANCEL } as never))
  expect(note).not.toContain('reminder point')
  expect(seen.logs.some(l => l.text.startsWith('self-compact: reminded'))).toBe(false)
})

test('by default there is no reminder and no own compaction', async ($, on) => {
  const seen = world(on)
  seen.usage = 199_000
  await $.turn.start({ turnId: 'T1', text: 'work' })
  expect(JSON.stringify(await $.tool.call({ tool: WORK } as never))).not.toContain('self-compact')
  await $.turn.complete(ended('T1'))
  await seen.clock.settle()
  expect(seen.compacts).toBe(0)
})

const auto = { autoCompactAtTokens: 150_000, alwaysInstructions: 'keep the branch name', alwaysCarry: 'Re-read HANDOFF.md' }

test('autoCompactAtTokens: the plugin compacts by itself, with the fixed instructions, alwaysCarry and the note, no resume', { options: auto }, async ($, on) => {
  const store: Record<string, unknown> = {}
  const seen = world(on, store, true)
  seen.usage = 160_000
  await $.turn.start({ turnId: 'T1', text: 'work' })
  await $.turn.complete(ended('T1'))
  await seen.clock.settle()
  expect(seen.compacts).toBe(1)
  expect(seen.instructions).toEqual(['keep the branch name'])
  expect(seen.appended.length).toBe(1)
  const carried = seen.appended[0] ?? ''
  expect(carried).toContain('started this compaction by itself, because the context reached 160k tokens')
  expect(carried).toContain('no next step was carried')
  expect(carried.indexOf('Re-read HANDOFF.md')).toBeLessThan(carried.indexOf('by itself'))
  expect(seen.prompts).toEqual([])
  expect((store.lastAt as Record<string, number[]>).S1?.length).toBe(1) // recorded like any self-compaction
  expect(seen.logs.some(l => l.text.includes('compacting by itself'))).toBe(true)
})

test('autoCompactAtTokens: not below the threshold, not on a sub-agent turn, not after a stopped or failed turn', { options: auto }, async ($, on) => {
  const seen = world(on)
  seen.usage = 140_000
  await $.turn.start({ turnId: 'T1', text: 'work' })
  await $.turn.complete(ended('T1'))
  seen.usage = 160_000
  await $.turn.complete({ ...ended('A1'), agentId: 'agent-1' } as never)
  await $.turn.start({ turnId: 'T2', text: 'work' })
  await $.turn.complete({ turnId: 'T2', reason: 'aborted', isAborted: true, answer: '', durationMs: 1 } as never)
  await $.turn.start({ turnId: 'T3', text: 'work' })
  await $.turn.complete({ turnId: 'T3', reason: 'error', isAborted: false, answer: '', durationMs: 1 } as never)
  await seen.clock.settle()
  expect(seen.compacts).toBe(0)
  expect(seen.logs.filter(l => l.text.includes('own compaction not started')).length).toBe(2)
  // A stopped turn is not a dropped request: the model is not told anything.
  await $.prompt.submit({ text: 'next' } as never)
  expect(seen.prompts[0]?.context).toBe(undefined)
})

test('autoCompactAtTokens: a waiting request runs instead, with its own carry', { options: auto }, async ($, on) => {
  const seen = world(on)
  seen.usage = 160_000
  await $.turn.start({ turnId: 'T1', text: 'work' })
  await $.tool.call({ tool: TOOL, carry: 'my ids' } as never)
  await $.turn.complete(ended('T1'))
  await seen.clock.settle()
  expect(seen.compacts).toBe(1)
  expect(seen.appended[0]).toContain('my ids')
  expect(seen.appended[0]).not.toContain('by itself')
})

test('autoCompactAtTokens: a turn that starts first drops the own compaction', { options: auto }, async ($, on) => {
  const seen = world(on)
  seen.usage = 160_000
  await $.turn.start({ turnId: 'T1', text: 'work' })
  await $.turn.complete(ended('T1'))
  await $.turn.start({ turnId: 'T2', text: 'queued' })
  await seen.clock.settle()
  expect(seen.compacts).toBe(0)
  expect(seen.logs.some(l => l.text.includes('own compaction dropped: turn T2 started first'))).toBe(true)
})

test('autoCompactAtTokens: an own compaction that a hook skipped is not tried again at every turn\'s end', { options: auto }, async ($, on) => {
  const seen = world(on, {}, true)
  seen.usage = 160_000
  seen.skip = 'not now'
  for (const turn of ['T1', 'T2', 'T3']) {
    await $.turn.start({ turnId: turn, text: 'work' })
    await $.turn.complete(ended(turn))
    await seen.clock.settle()
    await seen.clock.advance(MIN)
  }
  expect(seen.tries).toBe(1)
  expect(seen.compacts).toBe(0)
  // Nothing was requested, so the model is not told that a request was lost.
  await $.prompt.submit({ text: 'next' } as never)
  expect(JSON.stringify(seen.prompts[0]?.context ?? [])).not.toContain('did not run')
  // After the 10 minutes it may try once more.
  await seen.clock.advance(10 * MIN)
  seen.skip = undefined
  await $.turn.start({ turnId: 'T4', text: 'work' })
  await $.turn.complete(ended('T4'))
  await seen.clock.settle()
  expect(seen.compacts).toBe(1)
})

test('autoCompactAtTokens: at most one per 10 minutes; the request limits do not refuse it', { options: { ...auto, burstLimit: 1, minIntervalMinutes: 60, minContextTokens: 500_000 } }, async ($, on) => {
  const seen = world(on, { lastAt: { S1: [NOW - MIN] } }, true)
  seen.usage = 160_000
  for (const turn of ['T1', 'T2']) {
    await $.turn.start({ turnId: turn, text: 'work' })
    await $.turn.complete(ended(turn))
    await seen.clock.settle()
    await seen.clock.advance(MIN)
  }
  expect(seen.compacts).toBe(1)
  expect(seen.logs.some(l => l.text.includes('the last one was 60 s ago (at most one per 10 min)'))).toBe(true)
  await seen.clock.advance(10 * MIN)
  await $.turn.start({ turnId: 'T3', text: 'work' })
  await $.turn.complete(ended('T3'))
  await seen.clock.settle()
  expect(seen.compacts).toBe(2)
})

test('autoCompactAtTokens: a compaction that leaves the context above holds until it has been below once', { options: auto }, async ($, on) => {
  const seen = world(on)
  seen.usage = 160_000
  seen.after = 155_000
  const turn = async (id: string) => {
    await $.turn.start({ turnId: id, text: 'work' })
    await $.turn.complete(ended(id))
    await seen.clock.settle()
    await seen.clock.advance(11 * MIN)
  }
  await turn('T1')
  expect(seen.compacts).toBe(1)
  await turn('T2')
  await turn('T3')
  expect(seen.compacts).toBe(1)
  const held = seen.logs.filter(l => l.text.includes('left the context at 155000 tokens'))
  expect(held.length).toBe(1)
  expect(held[0]?.to).toBe('transcript')
  seen.usage = 90_000
  await turn('T4')
  seen.usage = 160_000
  seen.after = 50_000
  await turn('T5')
  expect(seen.compacts).toBe(2)
})

// The desktop app: /compact reports no size afterwards, so the next measurement decides.
test('autoCompactAtTokens: via /compact, the next turn above the threshold holds instead of looping', { options: auto }, async ($, on) => {
  const seen = world(on)
  seen.refuses = true
  seen.usage = 160_000
  await $.turn.start({ turnId: 'T1', text: 'work' })
  await $.turn.complete(ended('T1'))
  for (let i = 0; i < 130; i++) await seen.clock.advance(1000) // past the retries
  expect(seen.commands).toEqual(['compact'])
  expect(seen.args).toEqual(['keep the branch name'])
  expect(seen.appended[0]).toContain('by itself')
  await seen.clock.advance(11 * MIN)
  await $.turn.start({ turnId: 'T2', text: 'work' })
  await $.turn.complete(ended('T2'))
  for (let i = 0; i < 5; i++) await seen.clock.advance(1000)
  expect(seen.commands).toEqual(['compact'])
  expect(seen.logs.some(l => l.text.includes('no further own compaction'))).toBe(true)
})

test('instructionsFile: relative to the project root, read fresh, after the request\'s own text and alwaysInstructions', { options: { instructionsFile: 'docs/compact.md', alwaysInstructions: 'keep the branch name' } }, async ($, on) => {
  const seen = world(on)
  seen.root = '/proj'
  seen.files['/proj/docs/compact.md'] = 'old text'
  await $.turn.start({ turnId: 'T1', text: 'work' })
  const res = JSON.stringify(await $.tool.call({ tool: TOOL, instructions: 'the plan' } as never))
  expect(res).toContain('instructions: yours (8 chars) + alwaysInstructions (20 chars) + file /proj/docs/compact.md (8 chars)')
  seen.files['/proj/docs/compact.md'] = 'file text'
  await $.turn.complete(ended('T1'))
  await seen.clock.settle()
  expect(seen.instructions).toEqual(['the plan\n\nkeep the branch name\n\nfile text'])
  // A typed /compact gets it too, and a text that already holds it is not doubled.
  await $.session.compact({ trigger: 'manual', instructions: 'mine', messages: [hello] })
  await $.session.compact({ trigger: 'manual', instructions: 'mine\n\nkeep the branch name\n\nfile text', messages: [hello] })
  expect(seen.instructions.slice(1)).toEqual(['mine\n\nkeep the branch name\n\nfile text', 'mine\n\nkeep the branch name\n\nfile text'])
})

test('instructionsFile: ~/ is under HOME', { options: { instructionsFile: '~/compact.md' } }, async ($, on) => {
  const seen = world(on)
  seen.files['/nonexistent-home/compact.md'] = 'home text'
  await $.session.compact({ trigger: 'auto', messages: [hello] })
  expect(seen.instructions).toEqual(['home text'])
})

test('instructionsFile: without a project root, CLAUDE_PROJECT_DIR is used', { options: { instructionsFile: 'compact.md' } }, async ($, on) => {
  const seen = world(on, {}, false, { CLAUDE_PROJECT_DIR: '/work/' })
  seen.files['/work/compact.md'] = 'env text'
  await $.session.compact({ trigger: 'auto', messages: [hello] })
  expect(seen.instructions).toEqual(['env text'])
})

test('instructionsFile: missing or unusable, the compaction goes ahead and the log says so once', { options: { instructionsFile: 'compact.md', alwaysInstructions: 'keep the branch name' } }, async ($, on) => {
  const seen = world(on)
  // No project root and no CLAUDE_PROJECT_DIR: a relative path is unusable.
  const res = JSON.stringify(await $.tool.call({ tool: TOOL } as never))
  expect(res).toContain('file compact.md (missing, empty or unreadable now; left out)')
  await $.session.compact({ trigger: 'manual', messages: [hello] })
  expect(seen.instructions).toEqual(['keep the branch name'])
  expect(seen.logs.filter(l => l.text.includes('project folder is unknown')).length).toBe(1)
  // With a root but no file: compacted without it, logged once.
  seen.root = '/proj'
  await $.session.compact({ trigger: 'manual', messages: [hello] })
  await $.session.compact({ trigger: 'manual', messages: [hello] })
  expect(seen.compacts).toBe(3)
  const missing = seen.logs.filter(l => l.text.includes('/proj/compact.md is missing or unreadable'))
  expect(missing.length).toBe(1)
  expect(missing[0]?.to).toBe('transcript')
})

test('instructionsFile: only the first 8000 characters are used, and the log says so', { options: { instructionsFile: '/abs/compact.md' } }, async ($, on) => {
  const seen = world(on)
  seen.files['/abs/compact.md'] = 'x'.repeat(8001)
  await $.session.compact({ trigger: 'manual', messages: [hello] })
  expect(seen.instructions[0]?.length).toBe(8000)
  expect(seen.logs.some(l => l.text.includes('is 8001 characters; only the first 8000'))).toBe(true)
})

test('instructionsFile: the tool description says that instructions can be left out', { options: { instructionsFile: 'docs/compact.md' } }, async ($, on) => {
  world(on)
  const described: string[] = []
  on('tool.register', ($, e) => {
    described.push(String((e as { description?: string }).description))
    return { value: undefined } as never
  })
  on('session.start', () => ({ cwd: '/proj' }))
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: false } as never)
  const mine = described.find(d => d.startsWith('Compact your own context')) ?? ''
  expect(mine).toContain('An instructions file is configured (docs/compact.md)')
  expect(mine).toContain('leave `instructions` out')
})
