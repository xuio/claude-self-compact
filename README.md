# self-compact

A Claude Code plugin that lets Claude **compact its own context**: a real `/compact`, so the
visible chat history stays, triggered by the model itself. It can also hand itself text
**verbatim** across the compaction and **resume** work right after.

Claude Code has no built-in way for the model to start a compaction (see
[anthropics/claude-code#19877](https://github.com/anthropics/claude-code/issues/19877)). The
usual workarounds (`/clear` plus a handoff file) lose the visible history. This plugin uses the
plugin *mods* API (function hooks, early access) to run the same compaction a typed `/compact`
runs.

Works in the terminal and in the **Claude desktop app's Code tab** (an SDK-hosted session).

Its main use is a long-running coordinator of sub-agents: it compacts itself at a planned point
instead of running into the automatic compaction mid-task. Sub-agents do not compact; they
write their state down and hand off. The
[multi-agent playbook](https://github.com/xuio/claude-code-multi-agent-playbook) describes that
way of working (rules R-loop-6 and R-safe-6).

## Install

In a terminal Claude Code session:

```
/plugin install self-compact --marketplace xuio/claude-self-compact
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session,
desktop-app sessions included). From a shell: `claude plugin install self-compact --marketplace
xuio/claude-self-compact`. On a build without `--marketplace`:
`/plugin marketplace add xuio/claude-self-compact`, then
`/plugin install self-compact@claude-self-compact`.

To update an installed copy: `claude plugin marketplace update claude-self-compact`, then
`claude plugin update self-compact@claude-self-compact`, then start a new session.

The same plugin is also shipped in the
[multi-agent playbook](https://github.com/xuio/claude-code-multi-agent-playbook/tree/main/plugins/self-compact)
repository. Install it from one place only: both copies register the same tools.

Requires a Claude Code build with the plugin mods API (function hooks). Version 0.5.0 passes
`claude plugin test` on 2.1.301 and type-checks against the 2.1.321 API. The API is early
access and may change between releases.

## Use

The plugin adds the tool `mcp__self-compact__request_compaction`. Claude calls it as the
last action of a turn; the compaction runs when the turn ends. Calling it again in the same turn
replaces the request (fields left out are dropped), and `mcp__self-compact__cancel_compaction`
cancels it; both are too late once the compaction has started. After the request, Claude's
other tool calls are refused until the compaction has run, so that the turn really ends (see
"The turn has to end" below). (In the desktop app the tools can still be listed as deferred;
Claude then loads their schema with ToolSearch first.)

| Field | What it does |
| --- | --- |
| `instructions` | What the summary must keep or stress (the text after `/compact`). |
| `carry` | Text placed **verbatim** after the summary, never summarized: ids, paths, branch names, the exact next step. |
| `resume` | A prompt that starts Claude's next turn after the compaction. Omit it to wait for the user. |

Each field holds at most 8,000 characters. A longer field, or a field with another name, is
**refused** and nothing is scheduled: nothing is cut or dropped without a word. Long state
belongs in a file; carry its path. The tool's answer lists what was scheduled and, where the
host reports it, how full the context is.

A prompt that makes use of it:

> When your context gets large, write durable state to files, then call
> `request_compaction` with `carry` holding the exact next step and `resume` set to
> "continue from the carried next step".

What you see: a `/compact` row with the instructions, the usual "Compacted" line, then (with
`resume`) "The self-compact plugin sent a message" starting the next turn. The earlier chat
stays visible.

## When a request is refused

| Case | What the tool answers |
| --- | --- |
| A **sub-agent** calls either tool | Refused. The tool compacts the main conversation, so a sub-agent's call would compact (or un-schedule) under the main agent. The answer tells the sub-agent to write its state down and hand off. |
| More than `burstLimit` self-compactions in `burstWindowMinutes` | Refused, with the time until the next one is allowed. This stops a loop (compact, resume, compact, ...) without blocking a second compaction that is needed because the context filled up again. |
| The context holds fewer than `minContextTokens` tokens | Refused: a compaction now would free almost nothing. Skipped where the host does not report the size. |
| Within `minIntervalMinutes` of the last self-compaction | Refused, with the time left. Off by default. |
| A field is too long or misspelled | Refused, with the lengths or the field names. An earlier request in the same turn stays as it was. |

A replacement of a request that is already scheduled is never refused by the three limits.

## The turn has to end

A compaction cannot run while a turn runs. In practice agents often called the tool and then
kept working: a message arrived, or there was one more step to do. The turn went on, the
context kept growing, and the automatic compaction fired first, without the carry and without
the resume.

So while a request waits, the plugin holds the main agent to it:

1. Every other tool call of the main agent is **refused**. The answer says why and names the
   three ways on: end the turn now; call `request_compaction` again if the next step changed
   (it replaces `carry` and `resume`); or call `cancel_compaction`, do the work, and request
   again.
2. This also holds in a turn that a prompt starts before the compaction could run. The note
   beside that prompt says so, and asks Claude to put what the prompt needs into the carry or
   to cancel.
3. If Claude still makes tool calls, the sixth refused call ends the turn for it
   (`$.turn.abort`) and the compaction runs. If the host does not let the plugin end the turn,
   the request is cancelled instead and Claude is told, so that nothing stays blocked.

Sub-agents are never refused: their work goes on while the main agent compacts.

Two options change this. `allowAfterRequest` names tools that stay allowed, for example a
host's end-of-turn tool or a notes tool. `blockToolsAfterRequest: false` switches the refusal
off: the calls run, and Claude only reads a reminder beside each result.

Tell Claude to make `request_compaction` the only tool call of its message. A call issued in
the same message but run after it is refused like any other.

## Options

Set with `/config` (or `pluginConfigs` in `settings.json`):

| Option | Default | Meaning |
| --- | --- | --- |
| `alwaysInstructions` | empty | Added to the summarizer's instructions on every self-compaction. |
| `alwaysCarry` | empty | Placed verbatim after the summary on every self-compaction, e.g. `Re-read docs/HANDOFF.md before continuing.` |
| `blockToolsAfterRequest` | true | While a request waits, refuse the main agent's other tool calls. `false`: only remind. |
| `allowAfterRequest` | empty | Tool names, separated by commas, that stay allowed while a request waits. A trailing `*` matches a prefix: `SendMessage, mcp__notes__*`. |
| `burstLimit` | 3 | Most self-compactions per window in one session. 0 = no limit. |
| `burstWindowMinutes` | 30 | The window the limit counts over. |
| `minContextTokens` | 40000 | Smallest context worth compacting. 0 = no check. |
| `minIntervalMinutes` | 0 | Fixed minimum time between two self-compactions. 0 = off. |

### Where the two "always" options do not reach

They always apply to a compaction the plugin starts. For a typed `/compact` and for an
auto-compaction they apply only where this plugin's `session.compact` hook runs, and it does
not run everywhere: where an organization manages Claude Code, compaction events pass over the
plugins a person installed (`claude plugin validate` says so, and the engine reports "its
session.compact hook was skipped"). The desktop app's Code tab behaved that way in our use.

If you need a reminder after **every** compaction, whoever started it, use a classic
`SessionStart` hook with the matcher `compact`; the multi-agent playbook ships one in its
[`hooks/`](https://github.com/xuio/claude-code-multi-agent-playbook/blob/main/hooks/README.md)
folder.

## How it works

1. The tool only records the request (a compaction cannot run while a turn runs).
2. On the main loop's `turn.complete` it compacts:
   - `$.session.compact()` where the host allows it between turns (interactive terminal);
   - otherwise (SDK hosts such as the desktop app) `$.command.run({ command: 'compact' })`,
     exactly what typing `/compact` does.
   `alwaysInstructions` is added to the instructions on both paths.
3. The carried text (`alwaysCarry`, `carry`, and the `resume` text) is appended after the
   summary: by the `session.compact` hook where it sees the compaction, otherwise with
   `$.session.append` right after it. Either way it lands once.
4. `resume` is queued with `$.prompt.submit` and starts the next turn once the session is idle.
   Messages queued during the compaction (a subagent's message, a task notification) go
   first, so the resume text is also placed after the summary with the carried text: Claude
   reads it before whichever message starts the next turn.

What Claude is told beside a prompt, each at most once per turn:

- A message reaches Claude in the turn that made the request, before the turn ends: a short
  note that the request stands, and to change it only if the message changes the next step.
- A prompt starts a new turn before the compaction did (the desktop app sends a message typed
  during a turn right after the turn ends): the request stays pending and runs when that turn
  ends; the note says so, because `carry` and `resume` were written before that prompt.
- The request did not run (the user stopped the turn, the turn ended with an error, another
  hook skipped the compaction, or `/compact` failed): a note that nothing was compacted or
  carried.

Every decision is logged to `~/.claude/self-compact/mod.log` (last 400 lines, each with the
first 8 characters of the session id) and to the debug log; only failures show in the
transcript. The plugin API has no append, so the file is rewritten per line: lines of one
session are written in order, but two sessions logging at the same moment can lose a line.
The log is a debugging aid, not a record.

## Changes since 0.3.2

**0.5.0: the turn ends.** After a request the main agent's other tool calls are refused until
the compaction has run, and a turn that still goes on is ended by the plugin (see "The turn
has to end"). Before, the request depended on the agent ending its turn by itself, and it
often did not.

**0.4.0** comes out of a review of 26 hours of the plugin's own log in a multi-agent session
(43 requests, 44 compactions).

- **Rate limit.** The fixed "one self-compaction per 10 minutes" rule refused legitimate
  requests (5 in that log) and did not say when to retry. It is replaced by the burst limit
  and the small-context check above; `minIntervalMinutes` stays as an option, default 0.
- **`alwaysInstructions` and `alwaysCarry` now work on self-compactions.** Before, they were
  applied only by the `session.compact` hook, which does not see a compaction the plugin
  starts itself, so they were silently lost every time.
- **Sub-agents are refused.** Before, a sub-agent's call compacted the main conversation, and
  a sub-agent could cancel the main agent's request.
- **Fewer, clearer "still pending" notes.** Before, every prompt that arrived while a request
  was pending got a note inviting a new request (67 notes for 43 requests, 25 needless
  replacements). Now there is one note per turn, and it says to leave the request alone
  unless the next step changed.
- **Nothing is cut silently.** Fields over 8,000 characters were truncated; they are refused
  now, with their lengths.
- **A dropped request is reported.** Before, a request made in a turn that was then stopped
  vanished without a word; Claude could believe its context had been compacted.
- **Log lines carry the session id**, and one session's lines no longer overwrite each other.

Both versions are covered by the tests in `hooks/register.test.ts` (35 tests). At the time of
writing they had not yet run in a long live session; ending a turn from the plugin in
particular has only run in the test engine.

## Develop

```
claude plugin validate .
claude plugin test .
```

## License

[MIT-0](LICENSE)
