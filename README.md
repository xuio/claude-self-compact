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

## Install

In a terminal Claude Code session:

```
/plugin install self-compact --marketplace xuio/claude-self-compact
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session,
desktop-app sessions included).

Requires a Claude Code build with the plugin mods API (function hooks); developed and tested on
2.1.293. The API is early access and may change between releases.

## Use

The plugin adds the tool `mcp__self-compact__request_compaction`. Claude calls it as the
last action of a turn; the compaction runs when the turn ends. Calling it again in the same turn
replaces the request (fields left out are dropped), and `mcp__self-compact__cancel_compaction`
cancels it; both are too late once the compaction has started. (In the desktop app the tools
can still be listed as deferred; Claude then loads their schema with ToolSearch first.)

| Field | What it does |
| --- | --- |
| `instructions` | What the summary must keep or stress (the text after `/compact`). |
| `carry` | Text placed **verbatim** after the summary, never summarized: ids, paths, branch names, the exact next step. |
| `resume` | A prompt that starts Claude's next turn after the compaction. Omit it to wait for the user. |

A prompt that makes use of it:

> When your context gets large, write durable state to files, then call
> `request_compaction` with `carry` holding the exact next step and `resume` set to
> "continue from the carried next step".

What you see: a `/compact` row with the instructions, the usual "Compacted" line, then (with
`resume`) "The self-compact plugin sent a message" starting the next turn. The earlier chat
stays visible.

## Options

Set with `/config` (or `pluginConfigs` in `settings.json`):

| Option | Default | Meaning |
| --- | --- | --- |
| `alwaysInstructions` | empty | Added to the summarizer's instructions on **every** compaction of the main conversation: a typed `/compact` and auto-compaction too. |
| `alwaysCarry` | empty | Placed verbatim after the summary on **every** compaction, e.g. `Re-read docs/HANDOFF.md before continuing.` |
| `minIntervalMinutes` | 10 | The tool refuses a new request within this many minutes of the last self-compaction in the same session. |

## How it works

1. The tool only records the request (a compaction cannot run while a turn runs).
2. On the main loop's `turn.complete` it compacts:
   - `$.session.compact()` where the host allows it between turns (interactive terminal);
   - otherwise (SDK hosts such as the desktop app) `$.command.run({ command: 'compact' })`,
     exactly what typing `/compact` does.
3. A `session.compact` hook adds `alwaysInstructions` on the way down and appends the carried
   text after the summary on the way up; if that hook did not see the compaction, the text is
   appended with `$.session.append` instead.
4. `resume` is queued with `$.prompt.submit` and starts the next turn once the session is idle.
   Messages queued during the compaction (a subagent's message, a task notification) go
   first, so the resume text is also placed after the summary with the carried text: Claude
   reads it before whichever message starts the next turn.

If a prompt starts a turn before the compaction does (the desktop app sends a message typed
during the turn right after the turn ends), the request stays pending and the compaction runs
when that turn ends. Beside that prompt Claude reads a note that the compaction has not run
yet, so it can replace the request (its `carry` and `resume` were written before the message)
or cancel it.

Guards: one request at a time; the minimum interval (kept per session in the plugin store, so
a reload does not reset it); a turn the user stopped drops the request; subagents' compactions
are left alone. Every decision is logged to `~/.claude/self-compact/mod.log` (last 400 lines)
and the debug log; only failures show in the transcript.

## Develop

```
claude plugin validate .
claude plugin test .
```

## License

[MIT-0](LICENSE)
