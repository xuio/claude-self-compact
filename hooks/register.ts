import type { EngineInterface as Engine, Register, SessionMessage } from 'claude-code'

// The model calls request_compaction mid-turn; the tool only records the request,
// because a compaction cannot run while a turn runs. When the main loop's turn
// completes, the compaction runs (the same path as a typed /compact: the visible
// history stays, a summary replaces the context), then an optional resume prompt
// starts the next turn.
//
// What reaches the agent after a compaction:
//   instructions  what the summarizer must keep (the text after /compact)
//   carry         text placed verbatim after the summary (never summarized)
//   resume        a prompt that starts the next turn
// The options alwaysInstructions / alwaysCarry apply to EVERY compaction of the
// main conversation (a typed /compact and auto-compaction too).
//
// Calling request_compaction again in the same turn replaces the request;
// cancel_compaction drops it. Both are too late once the compaction runs.
//
// Guards: one request at a time; at least minIntervalMinutes between
// self-compactions (kept in $.store per session, so a reload does not reset it);
// an aborted turn (the person pressed Stop) drops the request; every decision is
// logged to ~/.claude/self-compact/mod.log. Only failures show in the transcript;
// routine steps go to the debug log.

const TOOL = 'request_compaction'
const FULL = 'mcp__self-compact__request_compaction'
const CANCEL = 'cancel_compaction'
const CANCEL_FULL = 'mcp__self-compact__cancel_compaction'
const RETRIES = 120
const RETRY_MS = 1000
const MAX_TEXT = 8000
const LOG_KEEP = 400
const LAST_KEY = 'lastAt'
const DAY_MS = 24 * 3600_000

type Job = { instructions?: string; carry?: string; resume?: string; carried?: boolean }
let pending: Job | undefined
let running: Job | undefined

const str = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined

const join = (...parts: (string | undefined)[]) =>
  parts.filter(p => p !== undefined && p !== '').join('\n\n') || undefined

const carryMessage = (text: string): SessionMessage => ({
  role: 'user',
  text:
    '<self-compact-carry>\nCarried verbatim across the compaction above by the self-compact ' +
    'plugin (not summarized; written before compacting):\n\n' + text + '\n</self-compact-carry>',
  toolUses: [],
})

async function log($: Engine, line: string, loud = false) {
  $.ui.log(`self-compact: ${line}`, { to: loud ? 'transcript' : 'debug' })
  const home = await $.env.get('HOME')
  if (!home) return
  const path = `${home}/.claude/self-compact/mod.log`
  const old = (await $.fs.read(path).catch(() => '')).split('\n').filter(Boolean).slice(-LOG_KEEP)
  const stamp = new Date(await $.clock.now()).toISOString()
  await $.fs.write(path, [...old, `${stamp} ${line}`].join('\n') + '\n').catch(() => {})
}

async function lastAt($: Engine) {
  const all = ((await $.store.get(LAST_KEY)) ?? {}) as Record<string, number>
  return all[await $.session.id()] ?? 0
}

async function markDone($: Engine) {
  const now = await $.clock.now()
  const all = ((await $.store.get(LAST_KEY)) ?? {}) as Record<string, number>
  const kept = Object.fromEntries(Object.entries(all).filter(([, t]) => now - t < DAY_MS))
  await $.store.set(LAST_KEY, { ...kept, [await $.session.id()]: now })
}

// After a self-compaction: record it, carry the text if the session.compact hook
// did not, and queue the resume prompt.
async function finish($: Engine, job: Job, how: string) {
  await markDone($)
  await log($, `${how}: done`)
  if (job.carry && !job.carried) {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: carryMessage(job.carry).text }] } })
    await log($, 'carry appended after the compaction (fallback)')
  }
  $.ui.toast('Self-compacted')
  if (job.resume) {
    await $.prompt.submit({ text: job.resume })
    await log($, 'resume prompt queued')
  }
}

export const register: Register = (on, options) => {
  const alwaysInstructions = str(options.alwaysInstructions, MAX_TEXT)
  const alwaysCarry = str(options.alwaysCarry, MAX_TEXT)
  const minIntervalMs = Math.max(0, Number(options.minIntervalMinutes ?? 10)) * 60_000

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: TOOL,
      description:
        'Compact your own context (the same as the user typing /compact; the visible chat ' +
        'history is kept). The compaction runs right after your current turn ends, so call ' +
        'this as the last action of a turn and then end the turn with one short line. ' +
        'Before calling, make sure durable state lives in files. `instructions`: what the ' +
        'summary must keep. `carry`: text you need verbatim afterwards (ids, paths, the exact ' +
        'next step); it is placed after the summary unchanged. `resume`: optional prompt that ' +
        'starts your next turn after the compaction (omit to wait for the user). Calling it ' +
        'again in the same turn replaces the request (fields left out are dropped); ' +
        'cancel_compaction cancels it. Refused if a self-compaction ran in the last ' +
        `${minIntervalMs / 60_000} min.`,
      inputSchema: {
        type: 'object',
        properties: {
          instructions: { type: 'string', description: 'What the summary must keep or stress.' },
          carry: { type: 'string', description: 'Text placed verbatim after the summary.' },
          resume: { type: 'string', description: 'Prompt to start the next turn after compaction.' },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: CANCEL,
      description: 'Cancel the compaction scheduled with request_compaction in this turn.',
      inputSchema: { type: 'object', properties: {} },
    })
    return started
  })

  // The spec's isDeferred is not always honoured in SDK hosts: pin the tool in front.
  on('tool.describe', { tool: FULL }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
    .catch(($, e, next) => next(e))

  on('tool.call', { tool: FULL }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    if (running) return { result: 'Not changed: the compaction is already running.' }
    const replaced = pending !== undefined
    const since = (await $.clock.now()) - (await lastAt($))
    if (!replaced && since < minIntervalMs) {
      const why = `refused: last self-compaction ${Math.round(since / 1000)} s ago (min ${minIntervalMs / 1000} s)`
      await log($, why)
      return { result: `Not scheduled (${why}).` }
    }
    pending = {
      instructions: str(input.instructions, MAX_TEXT),
      carry: str(input.carry, MAX_TEXT),
      resume: str(input.resume, MAX_TEXT),
    }
    const extras = [pending.carry && 'carry', pending.resume && 'resume'].filter(Boolean).join(', ')
    await log($, `${replaced ? 'replaced' : 'scheduled'} for end of turn${extras ? ` (+ ${extras})` : ''}`)
    return {
      result:
        `Compaction ${replaced ? 'request replaced' : 'scheduled'}: it runs when this turn ends. ` +
        'End your turn now with one short line; do not start new work in this turn.',
    }
  }).catch(() => ({ result: 'self-compact failed internally; nothing was scheduled.' }))

  on('tool.call', { tool: CANCEL_FULL }, async ($, e) => {
    if (running) return { result: 'Too late: the compaction is already running.' }
    if (!pending) return { result: 'Nothing to cancel: no compaction is scheduled.' }
    pending = undefined
    await log($, 'cancelled')
    return { result: 'Compaction cancelled.' }
  }).catch(() => ({ result: 'self-compact failed internally; the request may still be scheduled.' }))

  // Every compaction of the main conversation: add the configured instructions on
  // the way down, the carried text after the summary on the way up.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const job = running
    const instructions = join(e.instructions, alwaysInstructions)
    const res = await next(instructions === e.instructions ? e : { ...e, instructions })
    if (res.skip !== undefined) return res
    const carry = join(alwaysCarry, job?.carry)
    if (job) job.carried = true
    const sizes = res.tokensBefore ? ` ${res.tokensBefore} -> ${res.tokensAfter ?? '?'} tokens` : ''
    await log($, `compacted (${e.trigger}${job ? ', self' : ''})${sizes}${carry ? `; carried ${carry.length} chars` : ''}`)
    return carry ? { ...res, messages: [...res.messages, carryMessage(carry)] } : res
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || !pending) return done
    const job = pending
    pending = undefined
    if (e.isAborted || e.reason !== 'answer') {
      await log($, `dropped (turn ended: ${e.reason})`)
      return done
    }
    running = job
    // Run outside this hook: the session must be idle for the compaction to be
    // accepted (Stop hooks of other plugins may keep it busy after turn.complete).
    $.clock.after(0, async () => {
      try {
        await log($, `turn ${e.turnId} complete; compacting`)
        let lastErr = ''
        let headless = false
        for (let i = 0; i < RETRIES && !headless; i++) {
          try {
            const res = await $.session.compact(job.instructions ? { instructions: job.instructions } : {})
            if (res.skip !== undefined) {
              await log($, `skipped by a hook: ${res.skip}`)
              $.ui.toast(`Self-compaction skipped: ${res.skip}`)
              return
            }
            await finish($, job, `session.compact after ${i} retries`)
            return
          } catch (err) {
            const msg = String(err).slice(0, 300)
            // SDK-hosted sessions (Claude Desktop) cannot compact between turns yet:
            // there a /compact command is the way, so stop retrying at once.
            if (msg.includes('headless')) headless = true
            else if (msg !== lastErr) await log($, `session.compact try ${i} rejected: ${msg}`)
            lastErr = msg
            if (!headless) await $.clock.sleep(RETRY_MS)
          }
        }
        // Headless (or still busy after the retries): run /compact as if the person
        // typed it ($.prompt.submit refuses text starting with "/"); the engine
        // queues it until the session is idle.
        try {
          await $.command.run({ command: 'compact', args: job.instructions ?? '' })
          await finish($, job, `/compact via command.run (${headless ? 'headless host' : 'retries exhausted'})`)
        } catch (err) {
          await log($, `/compact via command.run rejected: ${String(err).slice(0, 300)}`, true)
          $.ui.toast('Self-compaction failed; see ~/.claude/self-compact/mod.log')
        }
      } finally {
        running = undefined
      }
    })
    return done
  })
}
