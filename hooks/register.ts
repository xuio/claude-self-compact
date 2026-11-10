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
// The options alwaysInstructions / alwaysCarry apply to every self-compaction, and
// to a typed /compact and an auto-compaction wherever this plugin's session.compact
// hook sees them (see "Where the hook does not run" in the README).
//
// Calling request_compaction again in the same turn replaces the request;
// cancel_compaction drops it. Both are too late once the compaction runs.
//
// The compaction needs the turn to end, and models tend to keep working after
// the request (then the context fills up and the automatic compaction fires
// first). So while a request is waiting, every other tool call of the main agent
// is refused with the reason and the ways out: end the turn, replace the request,
// or cancel it. Sub-agents are not touched. An agent that still does not end its
// turn after MAX_REFUSALS refused calls has the turn ended for it, and the
// compaction runs. (blockToolsAfterRequest: false turns the refusal into a
// reminder beside each tool result; allowAfterRequest names tools that stay
// allowed.)
//
// A prompt can start a turn before the compaction does (the desktop app sends a
// message typed mid-turn right after the turn ends). The request then stays
// pending, the model is told so beside that prompt (once per turn), and the
// compaction runs when that turn ends.
//
// The resume prompt waits for an idle session, behind whatever was queued during
// the compaction (subagent messages, task notifications), and can be the second
// turn or later. So the resume text is also carried after the summary, where the
// model reads it before any next message.
//
// Guards:
//   - only the main agent: a sub-agent's call is refused (it would compact the
//     main conversation, not its own);
//   - one request at a time;
//   - three optional limits, all off unless the options set them: a burst
//     limit (burstLimit self-compactions per burstWindowMinutes, kept in
//     $.store per session, so a reload does not reset it), a fixed interval
//     (minIntervalMinutes) and a "context still small" check
//     (minContextTokens); a refusal says why and when to retry;
//   - nothing is cut: a field longer than MAX_TEXT, or an unknown field, refuses
//     the request;
//   - a turn that ends early (the person pressed Stop, an error) drops the request,
//     and the model is told so beside the next prompt.
// Every decision is logged to ~/.claude/self-compact/mod.log with the session id.
// Only failures show in the transcript; routine steps go to the debug log.

const TOOL = 'request_compaction'
const FULL = 'mcp__self-compact__request_compaction'
const CANCEL = 'cancel_compaction'
const CANCEL_FULL = 'mcp__self-compact__cancel_compaction'
const RETRIES = 120
const RETRY_MS = 1000
const MAX_TEXT = 8000
const MAX_REFUSALS = 6
const LOG_KEEP = 400
const HISTORY_KEEP = 20
const LAST_KEY = 'lastAt'
const DAY_MS = 24 * 3600_000
const IDLE = '(idle)'
const FIELDS = ['instructions', 'carry', 'resume'] as const
// Keys a tool.call input carries beside the tool's own arguments.
const RESERVED = ['tool', 'consent', 'tool_use_id', 'agentId', 'requestMeta']

type Job = {
  instructions?: string
  carry?: string
  resume?: string
  carried?: boolean // the session.compact hook placed the carried text
  turn?: string     // the turn the request was made in
  noted?: string    // the turn whose prompt last got the "still scheduled" note
  refused: number   // tool calls refused (or reminded) while this request waited
  forced?: boolean  // the plugin is ending the turn itself, so that the compaction can run
}
type Config = {
  alwaysInstructions?: string
  alwaysCarry?: string
  minIntervalMs: number
  burstLimit: number
  burstWindowMs: number
  minContextTokens: number
  blockTools: boolean
  allowAfter: string[]
}

let cfg: Config = {
  minIntervalMs: 0,
  burstLimit: 0,
  burstWindowMs: 30 * 60_000,
  minContextTokens: 0,
  blockTools: true,
  allowAfter: [],
}
let pending: Job | undefined   // requested, not started: replace and cancel act on it
let running: Job | undefined   // the compaction has started
let scheduled: Job | undefined // a turn.complete callback is working on it
let openTurn: string | undefined // the main loop's running turn (subagents raise no turn.start)
let lost: string | undefined   // why the last request did not end in a compaction, until the model is told
let logTail: Promise<void> = Promise.resolve()

const sameTurnNote = () =>
  'self-compact: the compaction you requested is still scheduled for the end of this turn; ' +
  'this message reached you before the turn ended. The request stands as you wrote it' +
  (cfg.blockTools ? ', and other tool calls stay refused until it has run' : '') +
  '. Call request_compaction again only if this message changes your next step (it replaces ' +
  'the carry and resume), or cancel_compaction if you now have to keep working. Otherwise ' +
  'end your turn.'

const laterTurnNote = () =>
  'self-compact: the compaction you requested with request_compaction has not run yet, ' +
  'because this prompt started a turn first. It runs when this turn ends, with the ' +
  'instructions, carry and resume you wrote before this prompt' +
  (cfg.blockTools ? '; until then your other tool calls are refused' : '') +
  '. So answer briefly and end your turn. If this prompt changes your next step, call ' +
  'request_compaction again first (it replaces the carry and resume, so put what this ' +
  'prompt asks into them); if it cannot wait, call cancel_compaction and handle it.'

// What a refused tool call answers while a request waits.
const refusal = (tool: string, count: number) =>
  `Not run (${tool}): you scheduled a compaction with request_compaction, and it can only ` +
  'run once this turn has ended. End your turn now with one short line; your carry and resume ' +
  'bring you back to this work right after the compaction. If only your next step changed, ' +
  'call request_compaction again with the new carry and resume. If this call has to happen ' +
  'first, call cancel_compaction, do the work, then request the compaction again.' +
  (count >= 3 ? ` This is refusal ${count} in a row: stop calling tools and end the turn.` : '')

const FORCED =
  'Not run: you did not end your turn, so the self-compact plugin is ending it now and the ' +
  'compaction you requested runs. Your carry and resume bring you back to this work.'

const REMINDER =
  'self-compact: a compaction you requested is waiting for this turn to end. Finish with one ' +
  'short line now, or call cancel_compaction if you have to keep working: every further call ' +
  'grows the context the compaction was meant to shrink.'

// Whether `tool` stays allowed while a request waits: the two tools of this
// plugin, and the names in allowAfterRequest (a trailing * matches a prefix).
const allowed = (tool: string) =>
  tool === FULL ||
  tool === CANCEL_FULL ||
  cfg.allowAfter.some(p => (p.endsWith('*') ? tool.startsWith(p.slice(0, -1)) : tool === p))

const lostNote = (why: string) =>
  `self-compact: the compaction you requested did not run (${why}). Your context was not ` +
  'compacted and nothing was carried. Call request_compaction again if you still need it.'

const SUBAGENT_REFUSAL =
  'Refused: only the main agent can use this tool, because it compacts the MAIN conversation ' +
  'and not yours. You are a sub-agent; nothing was scheduled or changed. If your own context ' +
  'is filling up, write your state to your notes file, report to the agent that started you ' +
  'and end your turn.'

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

const num = (v: unknown, fallback: number) => {
  const n = Number(v ?? fallback)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

const join = (...parts: (string | undefined)[]) =>
  parts.filter(p => p !== undefined && p !== '').join('\n\n') || undefined

const span = (ms: number) => (ms < 90_000 ? `${Math.ceil(ms / 1000)} s` : `${Math.ceil(ms / 60_000)} min`)
const kilo = (n: number) => `${Math.round(n / 1000)}k`

const carryMessage = (text: string): SessionMessage => ({
  role: 'user',
  text:
    '<self-compact-carry>\nCarried verbatim across the compaction above by the self-compact ' +
    'plugin (not summarized; written before compacting):\n\n' + text + '\n</self-compact-carry>',
  toolUses: [],
})

async function writeLog($: Engine, line: string) {
  const home = await $.env.get('HOME')
  if (!home) return
  const path = `${home}/.claude/self-compact/mod.log`
  const session = String(await $.session.id()).slice(0, 8)
  const old = (await $.fs.read(path).catch(() => '')).split('\n').filter(Boolean).slice(-LOG_KEEP)
  const stamp = new Date(await $.clock.now()).toISOString()
  await $.fs.write(path, [...old, `${stamp} ${session} ${line}`].join('\n') + '\n')
}

// One line to the debug log (or the transcript) and to the log file. The file is
// rewritten per line (the API has no append), so this session's lines are written
// one after another; lines of two sessions writing at the same moment can still
// be lost.
function log($: Engine, line: string, loud = false) {
  $.ui.log(`self-compact: ${line}`, { to: loud ? 'transcript' : 'debug' })
  logTail = logTail.then(() => writeLog($, line)).catch(() => {})
  return logTail
}

// When this session self-compacted, oldest first (0.3 stored one number per session).
async function history($: Engine): Promise<number[]> {
  const all = ((await $.store.get(LAST_KEY)) ?? {}) as Record<string, number | number[]>
  const mine = all[await $.session.id()]
  return (Array.isArray(mine) ? mine : typeof mine === 'number' ? [mine] : []).sort((a, b) => a - b)
}

async function markDone($: Engine) {
  const now = await $.clock.now()
  const session = await $.session.id()
  const all = ((await $.store.get(LAST_KEY)) ?? {}) as Record<string, number | number[]>
  const kept: Record<string, number[]> = {}
  for (const [id, at] of Object.entries(all)) {
    const recent = (Array.isArray(at) ? at : [at]).filter(t => now - t < DAY_MS)
    if (recent.length) kept[id] = recent
  }
  await $.store.set(LAST_KEY, { ...kept, [session]: [...(kept[session] ?? []), now].slice(-HISTORY_KEEP) })
}

// Why a new request is refused at `now`, or undefined.
function tooSoon(now: number, done: number[]): string | undefined {
  const last = done[done.length - 1]
  if (cfg.minIntervalMs && last !== undefined && now - last < cfg.minIntervalMs) {
    return (
      `the last self-compaction was ${span(now - last)} ago (minIntervalMinutes is ` +
      `${cfg.minIntervalMs / 60_000}); the next one is allowed in ${span(cfg.minIntervalMs - (now - last))}`
    )
  }
  const recent = done.filter(t => now - t < cfg.burstWindowMs)
  const first = recent[recent.length - cfg.burstLimit]
  if (cfg.burstLimit && first !== undefined) {
    return (
      `${recent.length} self-compactions in the last ${cfg.burstWindowMs / 60_000} min (the limit is ` +
      `${cfg.burstLimit}); the next one is allowed in ${span(first + cfg.burstWindowMs - now)}. A context ` +
      'that refills this fast usually means the same files are read again after each compaction: ' +
      'carry the few facts you need instead'
    )
  }
  return undefined
}

// The main conversation's context, where the host reports it (absent right after
// a compaction, until the next response).
async function contextNow($: Engine) {
  try {
    const c = (await $.session.usage()).context
    return typeof c.tokens === 'number' && c.tokens > 0 ? { tokens: c.tokens, window: c.window } : undefined
  } catch {
    return undefined
  }
}

// What the job carries after the summary: its carry, then its resume text.
const jobCarry = (job: Job) =>
  join(
    job.carry,
    job.resume &&
      'Next step (your resume prompt; it is also queued as a prompt, but a message ' +
        'queued during the compaction can start the next turn first, so act on it ' +
        'together with that message and skip it when the prompt arrives later):\n' + job.resume,
  )

// After a self-compaction: record it, carry the text if the session.compact hook
// did not (it does not run in every host), and queue the resume prompt.
async function finish($: Engine, job: Job, how: string) {
  await markDone($)
  await log($, `${how}: done`)
  const carry = job.carried ? undefined : join(cfg.alwaysCarry, jobCarry(job))
  if (carry) {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: carryMessage(carry).text }] } })
    await log($, `carry appended after the compaction (fallback, ${carry.length} chars)`)
  }
  $.ui.toast('Self-compacted')
  if (job.resume) {
    // Not awaited: it resolves only when its turn starts, which can be much later.
    await log($, 'resume prompt queued')
    void $.prompt
      .submit({ text: job.resume + '\n\n(Queued when the compaction finished; the same text is in the carry block. Skip what you already did.)' })
      .then(() => log($, 'resume prompt started its turn'))
      .catch(err => log($, `resume prompt failed: ${String(err).slice(0, 300)}`, true))
  }
}

// Whether `job` must not run now: cancelled or replaced, or another turn started
// first (then it stays pending and that turn's turn.complete runs it).
async function superseded($: Engine, job: Job) {
  if (pending !== job) return true
  if (openTurn === undefined) return false
  await log($, `deferred: turn ${openTurn} started first; compacting when it ends`)
  return true
}

// Compacts for `job` unless superseded.
async function compact($: Engine, job: Job, turnId: string) {
  await log($, `turn ${turnId} complete; compacting`)
  let lastErr = ''
  let headless = false
  for (let i = 0; i < RETRIES && !headless; i++) {
    if (await superseded($, job)) return
    running = job
    try {
      // This plugin's own session.compact hook does not see a compaction the
      // plugin starts, so the configured instructions go in here.
      const instructions = join(job.instructions, cfg.alwaysInstructions)
      const res = await $.session.compact(instructions ? { instructions } : {})
      pending = undefined
      if (res.skip !== undefined) {
        lost = `a hook skipped it: ${res.skip}`
        await log($, `skipped by a hook: ${res.skip}`)
        $.ui.toast(`Self-compaction skipped: ${res.skip}`)
        return
      }
      await finish($, job, `session.compact after ${i} retries`)
      return
    } catch (err) {
      running = undefined
      const msg = String(err).slice(0, 300)
      // SDK-hosted sessions (Claude Desktop) cannot compact between turns yet:
      // there a /compact command is the way, so stop retrying at once.
      if (msg.includes('headless')) headless = true
      else if (msg !== lastErr) await log($, `session.compact try ${i} rejected: ${msg}`)
      lastErr = msg
      if (!headless) await $.clock.sleep(RETRY_MS)
    }
  }
  if (await superseded($, job)) return
  // Headless (or still busy after the retries): run /compact as if the person
  // typed it ($.prompt.submit refuses text starting with "/"); the engine
  // queues it until the session is idle. The session.compact hook may not see
  // this compaction, so alwaysInstructions goes into the command's text here
  // (the hook skips text that is already there).
  running = job
  pending = undefined
  try {
    await $.command.run({ command: 'compact', args: join(job.instructions, cfg.alwaysInstructions) ?? '' })
    await finish($, job, `/compact via command.run (${headless ? 'headless host' : 'retries exhausted'})`)
  } catch (err) {
    lost = 'the /compact command failed'
    await log($, `/compact via command.run rejected: ${String(err).slice(0, 300)}`, true)
    $.ui.toast('Self-compaction failed; see ~/.claude/self-compact/mod.log')
  }
}

export const register: Register = (on, options) => {
  cfg = {
    alwaysInstructions: str(options.alwaysInstructions)?.slice(0, MAX_TEXT),
    alwaysCarry: str(options.alwaysCarry)?.slice(0, MAX_TEXT),
    minIntervalMs: num(options.minIntervalMinutes, 0) * 60_000,
    burstLimit: Math.floor(num(options.burstLimit, 0)),
    burstWindowMs: num(options.burstWindowMinutes, 30) * 60_000,
    minContextTokens: num(options.minContextTokens, 0),
    blockTools: options.blockToolsAfterRequest !== false && options.blockToolsAfterRequest !== 'false',
    allowAfter: (str(options.allowAfterRequest) ?? '').split(/[\s,]+/).filter(Boolean),
  }
  const limits = [
    cfg.burstLimit && `after ${cfg.burstLimit} self-compactions within ${cfg.burstWindowMs / 60_000} min`,
    cfg.minIntervalMs && `within ${cfg.minIntervalMs / 60_000} min of the last one`,
    cfg.minContextTokens && `while the context is below ${kilo(cfg.minContextTokens)} tokens`,
  ].filter(Boolean).join(', ')

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    for (const name of ['alwaysInstructions', 'alwaysCarry'] as const) {
      const given = str(options[name])?.length ?? 0
      if (given > MAX_TEXT) await log($, `option ${name} is ${given} characters; only the first ${MAX_TEXT} are used`, true)
    }
    await $.tool.register({
      name: TOOL,
      description:
        'Compact your own context (the same as the user typing /compact; the visible chat ' +
        'history is kept). The compaction runs right after your current turn ends, so call ' +
        'this as the last action of a turn and then end the turn with one short line. ' +
        'Before calling, make sure durable state lives in files. `instructions`: what the ' +
        'summary must keep. `carry`: text you need verbatim afterwards (ids, paths, the exact ' +
        'next step); it is placed after the summary unchanged. `resume`: optional prompt that ' +
        'starts your next turn after the compaction (omit to wait for the user). Each field ' +
        `holds at most ${MAX_TEXT} characters (longer is refused, never cut: keep long state ` +
        'in a file and carry its path). Calling it again in the same turn replaces the ' +
        'request (fields left out are dropped); cancel_compaction cancels it (both work ' +
        'until the compaction starts). ' +
        (cfg.blockTools
          ? 'Make it the only tool call of its message: after it, every other tool call of ' +
            'yours is refused until the compaction has run. '
          : '') +
        'Only the main agent can call it; a sub-agent is refused.' +
        (limits ? ` Also refused ${limits}; the answer says why and when to retry.` : ''),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
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
      description: 'Cancel the compaction requested with request_compaction (until it starts). Main agent only.',
      inputSchema: { type: 'object', properties: {} },
    })
    return started
  })

  // The spec's isDeferred is not always honoured in SDK hosts: pin the tool in front.
  on('tool.describe', { tool: FULL }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
    .catch(($, e, next) => next(e))

  on('tool.call', { tool: FULL }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    // A sub-agent's request would compact the main conversation under the main agent.
    if (typeof input.agentId === 'string') {
      await log($, `refused: request from sub-agent ${input.agentId.slice(0, 12)}`)
      return { result: SUBAGENT_REFUSAL }
    }
    if (running) return { result: 'Not changed: the compaction is already running.' }
    const replaced = pending !== undefined
    const stays = replaced ? ' The request you made before stays scheduled as it was.' : ''
    // A misspelled field (seen live: resume_prompt) would be dropped without a word.
    // Text only: a key a later engine adds beside the arguments must not refuse every request.
    const unknown = Object.keys(input).filter(
      k => typeof input[k] === 'string' && !(FIELDS as readonly string[]).includes(k) && !RESERVED.includes(k),
    )
    if (unknown.length) {
      await log($, `refused: unknown field ${unknown.join(', ')}`)
      return {
        result:
          `Not scheduled: unknown field ${unknown.join(', ')}. The fields are ` +
          `${FIELDS.join(', ')}; call request_compaction again with those.${stays}`,
      }
    }
    const long = FIELDS.filter(f => (str(input[f])?.length ?? 0) > MAX_TEXT)
    if (long.length) {
      const sizes = long.map(f => `${f} is ${str(input[f])?.length} characters`).join(', ')
      await log($, `refused: ${sizes} (limit ${MAX_TEXT})`)
      return {
        result:
          `Not scheduled: ${sizes}; the limit is ${MAX_TEXT} per field and nothing is cut. Write ` +
          `the long part to a file, put its path into the field, and call request_compaction again.${stays}`,
      }
    }
    const context = await contextNow($)
    if (!replaced) {
      const why = tooSoon(await $.clock.now(), await history($))
      if (why) {
        await log($, `refused: ${why.split(';')[0]}`)
        return { result: `Not scheduled: ${why}.` }
      }
      if (context && context.tokens < cfg.minContextTokens) {
        await log($, `refused: context ${context.tokens} tokens is below minContextTokens ${cfg.minContextTokens}`)
        return {
          result:
            `Not scheduled: your context holds ${kilo(context.tokens)} tokens, below the minimum of ` +
            `${kilo(cfg.minContextTokens)} (minContextTokens). A compaction now would free almost nothing; keep working.`,
        }
      }
    }
    pending = {
      instructions: str(input.instructions),
      carry: str(input.carry),
      resume: str(input.resume),
      turn: openTurn,
      refused: 0,
    }
    lost = undefined
    const size = context ? `context ${kilo(context.tokens)} of ${kilo(context.window)} tokens` : undefined
    const extras = [pending.carry && 'carry', pending.resume && 'resume'].filter(Boolean).join(', ')
    await log($, `${replaced ? 'replaced' : 'scheduled'} for end of turn${extras ? ` (+ ${extras})` : ''}${size ? `; ${size}` : ''}`)
    const got = [
      pending.instructions && `instructions ${pending.instructions.length} chars`,
      pending.carry && `carry ${pending.carry.length} chars`,
      pending.resume ? `resume ${pending.resume.length} chars` : 'no resume: after it the session waits for the user',
      size,
    ].filter(Boolean).join('; ')
    return {
      result:
        `Compaction ${replaced ? 'request replaced' : 'scheduled'} (${got}): it runs when this turn ends. ` +
        'End your turn now with one short line; do not start new work in this turn.' +
        (cfg.blockTools ? ' Until the compaction has run, your other tool calls are refused.' : ''),
    }
  }).catch(() => ({ result: 'self-compact failed internally; nothing was scheduled.' }))

  // The generated tool types list only the tools connected at the last load.
  on('tool.call', { tool: CANCEL_FULL as typeof FULL }, async ($, e) => {
    const agentId = (e as unknown as Record<string, unknown>).agentId
    if (typeof agentId === 'string') {
      await log($, `refused: cancel from sub-agent ${agentId.slice(0, 12)}`)
      return { result: SUBAGENT_REFUSAL }
    }
    if (running) return { result: 'Too late: the compaction is already running.' }
    if (!pending) return { result: 'Nothing to cancel: no compaction is scheduled.' }
    pending = undefined
    await log($, 'cancelled')
    return { result: 'Compaction cancelled.' }
  }).catch(() => ({ result: 'self-compact failed internally; the request may still be scheduled.' }))

  // While a request waits for the turn to end, the main agent's other tool calls
  // are refused (or, with blockToolsAfterRequest off, answered with a reminder),
  // so that the turn ends and the compaction runs before the context fills up.
  on('tool.call', async ($, e, next) => {
    const input = e as unknown as { tool: string; agentId?: string }
    if (!pending || running || typeof input.agentId === 'string' || allowed(input.tool)) return next(e)
    const job = pending
    job.refused++
    if (cfg.blockTools && job.refused >= MAX_REFUSALS) {
      if (!job.forced) {
        job.forced = true
        const turnId = openTurn
        // Outside this hook: it belongs to the turn that is being ended.
        $.clock.after(0, async () => {
          try {
            if (turnId === undefined) throw new Error('no running turn is known')
            await log($, `ending turn ${turnId}: ${job.refused} tool calls refused and the turn went on`, true)
            await $.turn.abort({ turnId })
          } catch (err) {
            job.forced = false
            if (pending === job && !running) {
              pending = undefined
              lost = `you made ${job.refused} more tool calls instead of ending the turn, and the plugin could not end it, so the request was cancelled`
            }
            await log($, `could not end the turn (${String(err).slice(0, 200)}); request cancelled`, true)
          }
        })
      }
      return { deny: FORCED }
    }
    if (cfg.blockTools) {
      await log($, `refused ${input.tool}: the request waits for the turn to end (${job.refused})`)
      return { deny: refusal(input.tool, job.refused) }
    }
    const res = await next(e)
    if (res.deny !== undefined) return res
    if (job.refused === 1) await log($, `reminded after ${input.tool}: the request waits for the turn to end`)
    return { ...res, context: [...(res.context ?? []), REMINDER] }
  }).catch(($, e, next) => next(e))

  // Every compaction of the main conversation this hook sees: add the configured
  // instructions on the way down (unless the text already holds them: the
  // /compact fallback puts them there itself), the carried text after the summary
  // on the way up. No .catch fallback: it would run the compaction again when the
  // engine refuses it.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const job = running
    const always = cfg.alwaysInstructions
    const instructions = always && !(e.instructions ?? '').includes(always) ? join(e.instructions, always) : e.instructions
    const res = await next(instructions === e.instructions ? e : { ...e, instructions })
    if (res.skip !== undefined) return res
    const carry = join(cfg.alwaysCarry, job && jobCarry(job))
    if (job) job.carried = true
    const sizes = res.tokensBefore ? ` ${res.tokensBefore} -> ${res.tokensAfter ?? '?'} tokens` : ''
    await log($, `compacted (${e.trigger}${job ? ', self' : ''})${sizes}${carry ? `; carried ${carry.length} chars` : ''}`)
      .catch(() => {})
    return carry ? { ...res, messages: [...res.messages, carryMessage(carry)] } : res
  })

  // Beside a prompt, tell the model what it cannot see otherwise: that a request
  // is still waiting (once per turn: a prompt delivered into the turn of the
  // request gets the short note, a prompt that starts a turn before the
  // compaction the long one), or that its last request was dropped.
  on('prompt.submit', async ($, e, next) => {
    const notes: string[] = []
    if (lost && !pending && !running) {
      notes.push(lostNote(lost))
      await log($, `told the model: the request did not run (${lost})`)
      lost = undefined
    }
    if (pending && !running) {
      const turn = e.turnId ?? openTurn ?? IDLE
      if (pending.noted !== turn) {
        pending.noted = turn
        const same = turn === pending.turn
        notes.push(same ? sameTurnNote() : laterTurnNote())
        await log($, same
          ? `a prompt arrived in turn ${turn} before it ended; the request stands`
          : 'a prompt started a turn first; the request stays pending')
      }
    }
    return notes.length ? next({ ...e, context: [...(e.context ?? []), ...notes] }) : next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    openTurn = e.turnId
    // The prompt that got the note while the session was idle started this turn.
    if (pending?.noted === IDLE) pending.noted = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && openTurn === e.turnId) openTurn = undefined
    const done = await next(e)
    if (e.agentId !== undefined || !pending || running) return done
    // A turn that ended early drops the request, unless the plugin ended it itself.
    if ((e.isAborted || e.reason !== 'answer') && !pending.forced) {
      pending = undefined
      lost = e.isAborted || e.reason === 'aborted'
        ? 'the turn it was scheduled in was stopped, so the request was dropped'
        : `the turn it was scheduled in ended with ${e.reason}, so the request was dropped`
      await log($, `dropped (turn ended: ${e.reason})`)
      return done
    }
    const job = pending
    if (scheduled === job) return done
    scheduled = job
    // Run outside this hook: the session must be idle for the compaction to be
    // accepted (Stop hooks of other plugins may keep it busy after turn.complete).
    $.clock.after(0, async () => {
      try {
        await compact($, job, e.turnId)
      } finally {
        if (scheduled === job) scheduled = undefined
        if (running === job) running = undefined
      }
    })
    return done
  })
}
