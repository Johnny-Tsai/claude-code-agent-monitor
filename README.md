# agent-monitor

A Claude Code mod that shows, at a glance, what your session is doing: channel messages still waiting for a reply, tool calls and subagents in flight, external dispatches, cards fed by your own commands, and the session itself.

It is a plugin of function hooks: a one-line band above the prompt, and a `/monitor` side pane.

## Features

**The band** (always above the prompt):

```text
 ● INBOX 3  discord #general 18m +1ch  │  ● NOW  Bash "build" 12m +1  │  ● restart soon  │  no reply yet
```

- `INBOX`: channel messages (for example from a Discord channel plugin) that have not been answered yet, the oldest one's channel and wait time, and how many other channels are waiting.
- `NOW`: the oldest tool call or background subagent still running, and how long it has run.
- `restart soon` / `restart now`: shown only when context usage passes the warning or critical line.
- The time since the last reply.

While the pane is open, the band keeps only what is past a threshold (or disappears), because the pane already shows the rest. When the line is too narrow, segments drop from the right; `INBOX` always stays.

**The `/monitor` pane**, one card per topic, each expandable and collapsible:

| Card | Shows |
| --- | --- |
| header | clock, counts (inbox, now, agents), time since the last reply, restart warning |
| `INBOX` | waiting messages grouped by channel, with wait times |
| `RUNNING` | tool calls in flight and background subagents |
| `DISPATCHES` | external dispatches read from your `dispatchCommand`: running, stalled, recently ended (only when `dispatchCommand` is set) |
| custom cards | one card per `customCards` entry, filled from your own read-only command |
| `SESSION` | up time, the last wake prompt, number of compactions |

Status marks are shared by both views: `●` running (green), `◌` stalled (yellow), `✓` done, `✗` failed or rejected (red), `–` cancelled, `·` idle or waiting.

### Sample (60 columns, neutral sample data)

```text
╭──────────────────────────────────────────────────────────╮
│ AGENT MONITOR                                      12:08 │
│ inbox 1 · now 1 · agents 0 · no reply yet                │
│ restart soon                                             │
╰──────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────╮
│ - INBOX                                                1 │
│ ● discord #general                                    8m │
╰──────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────╮
│ - RUNNING                                              1 │
│ ● Bash "build"                                        8m │
╰──────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────╮
│ - DISPATCHES                       1 running · 1 stalled │
│   RUNTIME     ID       START AGE   TASK                  │
│ ● Alpha       a1b2c3d4 11:46 22m   T-108 parser          │
│ ◌ 1 stalled since 02:20                                  │
│ ─── recent ───────────────────────────────────────────── │
│ ✓ Alpha       e0e0e0e0 11:00 8m    T-104                 │
╰──────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────╮
│ - WAITING ON YOU                                       3 │
│ · approve the weekly release notes                       │
│ · T-107 channel reply settings                        4d │
│ · T-104 daily summary report                       today │
╰──────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────╮
│ + SCHEDULE                                  3 · 1 failed │
│ next 12:30 nightly-report-run · 1 failed                 │
╰──────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────╮
│ + SESSION                                                │
│ up 8m · woke never · compacted 0                         │
╰──────────────────────────────────────────────────────────╯
 updated 12:08 · refresh 60s
```

`WAITING ON YOU` and `SCHEDULE` are custom cards; `SCHEDULE` and `SESSION` are collapsed and show their one-line summary. The test suite prints samples like this at 48 and 60 columns (`claude plugin test .`).

## Requirements

- Claude Code with function-hook plugins (mods). Tested with **Claude Code 2.1.289**; no older minimum version has been verified.
- The function-hooks API is marked early access by Claude Code and may change between releases.

## Install

Clone the repository anywhere, then pick one of these:

1. **One session**: start Claude Code with the folder as a plugin directory.

   ```sh
   claude --plugin-dir /path/to/agent-monitor
   ```

2. **Every session**: name the folder in `CLAUDE_CODE_PLUGIN_DIRS` (absolute paths, `~` allowed, separated by the platform's path-list separator), either in the process environment or in the `env` block of `~/.claude/settings.json`. Each folder is loaded exactly as a `--plugin-dir`.

   ```json
   { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/plugins/agent-monitor" } }
   ```

3. **Skills folder**: place the folder at `~/.claude/skills/agent-monitor/`; Claude Code auto-loads it in the next session as `agent-monitor@skills-dir`.

Then type `/monitor` to open the pane. In a terminal, a pane opened by a command is seated at any width; a pane opened unasked (`openOnStart`) waits until the terminal is at least 144 columns wide.

## Configuration

Options are the plugin's `userConfig` fields. Each one appears as a row in Claude Code's config menu, and is stored in settings under `pluginConfigs`, keyed by the plugin's name (`agent-monitor`, or `agent-monitor@inline`), in its `options` object. A change in the config menu reloads the mod with the new values. Every default works out of the box: no command runs until you configure one.

| Option | Default | Description |
| --- | --- | --- |
| `channelNames` | `""` | Display names for channel ids, as `id=name` pairs separated by commas (e.g. `123456=general,987654=ops`). Empty shows `<server> #<last 4 digits of the id>`. |
| `replyTools` | `""` | Comma-separated tool names that count as replying to a channel. Empty means any MCP tool whose name ends in `__reply` or `__voice_reply`, matched to its own server. |
| `waitingAlertMinutes` | `5` | A message waiting this long without a reply turns the inbox to the warning color and shows one toast. Clamped to 0 to 1440. |
| `longActionMinutes` | `10` | A tool call running this long is shown in the warning color. Clamped to 0 to 1440. |
| `contextWarnPercent` | `70` | Context usage at or above this shows `restart soon` and one toast each time it is crossed. Clamped to 1 to 100. |
| `contextCriticalPercent` | `85` | Context usage at or above this shows `restart now` in the error color. Never below `contextWarnPercent`. |
| `dispatchCommand` | `""` | A read-only command that prints dispatch events as JSONL (see below). `{since24h}` is replaced with an RFC 3339 time 24 hours ago. Empty hides the `DISPATCHES` card and runs nothing. |
| `dispatchCommandPattern` | `""` | A regular expression; a Bash call whose command matches it is labelled `dispatch -> <runtime>` (runtime taken from `--runtime <x>`), and the dispatches are re-read 5 s after it starts. Empty recognises nothing. |
| `runtimeNames` | `""` | Display names for runtime ids, as `id=name` pairs separated by commas (e.g. `codex-cli=Codex`). Empty shows the runtime id. |
| `timeZone` | `""` | IANA time zone for clock times in the pane (e.g. `Europe/Berlin`). Empty uses UTC. |
| `customCards` | `""` | Extra cards as `TITLE=command` pairs separated by `;;` (see below). Empty adds no cards. |
| `openOnStart` | `false` | Open the monitor pane when a session starts. |
| `wakePattern` | `""` | A regular expression marking prompts that woke the session (shown in `SESSION`). Empty counts scheduled and loop triggers. |
| `collapsedCards` | `"session"` | Comma-separated card ids collapsed until you expand them: `inbox`, `running`, `dispatches`, `session`, and each custom card's title in lower case with dashes. |
| `customCardMaxItems` | `5` | Most items an expanded custom card lists; the rest fold into one `+N more` line. Clamped to 1 to 100. |
| `paneMaxRows` | `44` | Rows the pane may use when the surface does not report its height. Past it, expanded cards are shortened first so every card title stays visible. Clamped to 10 to 500. |

Example `~/.claude/settings.json` fragment:

```json
{
  "pluginConfigs": {
    "agent-monitor": {
      "options": {
        "channelNames": "123456=general,987654=ops",
        "timeZone": "Europe/Berlin",
        "customCards": "TODO=python3 /path/to/todo.py;;BUILDS=/path/to/builds --json",
        "collapsedCards": "session,builds"
      }
    }
  }
}
```

## The `/monitor` command

```text
/monitor                              toggle the pane
/monitor expand <card|all>            expand cards
/monitor collapse <card|all>          collapse cards
/monitor hide <card>                  hide a card (the header card always stays)
/monitor show <card|all>              show hidden cards again
/monitor rows <card> <1-30|default>   how many items an expanded card lists
```

Card names ignore case, accept spaces for dashes (`waiting on you`) and unique prefixes (`wait`). An ambiguous prefix lists the candidates; a typo gets a suggestion. Expanded, hidden and row settings are remembered across sessions. The title of each card is also a button that toggles it.

## Custom cards

`customCards` holds `TITLE=command` pairs separated by `;;`. Each command is split into arguments like a shell would for plain words and quotes, but **runs without a shell** (no pipes, globbing or variable expansion), with a 10 second timeout, when the pane opens and every 60 seconds while it is open. It must print one JSON object:

```json
{
  "summary": "one line, shown when the card is collapsed",
  "items": [
    { "mark": "waiting", "text": "approve the weekly release notes", "right": "4d" },
    { "mark": "failed", "text": "disk-usage-check-daily", "right": "last 05:30" }
  ],
  "empty": "text shown when there are no items"
}
```

- `mark` is one of `running`, `stalled`, `done`, `failed`, `idle`, `waiting`, `warn`; anything else shows as `idle`.
- `text` is cut to 80 characters, `right` to 12, `summary` to 80, `empty` to 60. At most 30 items are read.
- Output that is not a JSON object, or a command that fails, shows `could not read: <reason>` in the card; nothing throws.

The card id is the title in lower case with other characters as dashes (`WAITING ON YOU` is `waiting-on-you`).

## Dispatch JSONL contract

`dispatchCommand` is for work you hand to other agents or tools outside this session. It runs without a shell, with a 20 second timeout, when the pane opens, every 60 seconds while it is open, and 5 seconds after a Bash call matching `dispatchCommandPattern` starts (timed reads happen only while the pane is open). It prints one JSON object per line:

```json
{"event_type":"DispatchStarted","timestamp":"2026-10-05T03:46:00Z","payload":{"dispatch_id":"a1b2c3d4-0001","runtime_id":"alpha-cli","task_id":"T-108 parser"}}
{"event_type":"DispatchHeartbeat","timestamp":"2026-10-05T04:00:00Z","payload":{"dispatch_id":"a1b2c3d4-0001"}}
{"event_type":"DispatchCompleted","timestamp":"2026-10-05T04:05:00Z","payload":{"dispatch_id":"a1b2c3d4-0001"}}
```

- `event_type`: `DispatchStarted`, `DispatchHeartbeat`, `DispatchCompleted`, `DispatchFailed`, `DispatchCancelled` or `DispatchRejected`.
- `timestamp`: RFC 3339.
- `payload.dispatch_id`: required; events are paired by it, and the first 8 characters are shown.
- `payload.runtime_id` (or `payload.runtime`): optional, mapped through `runtimeNames`.
- The summary is the first of `prompt_summary`, `summary`, `title`, `task_name`, `task`, `task_id` that is present, cut to 30 characters.
- Other fields are ignored. One unreadable line fails the whole read (shown as a one-line reason) rather than pairing half of it.
- A dispatch with no end event and no start or heartbeat in the last 3 minutes is **stalled**. Stalled dispatches older than 60 minutes fold into one line; the most recently ended ones are listed after the running ones.

## Design principles

- **Read-only.** Every hook passes its event on unchanged; the mod never blocks, rewrites or answers a tool call or prompt. Its own errors go to the debug log, so a failure in the mod never reaches your session.
- **No external commands by default.** Only `dispatchCommand` and `customCards` run anything, both empty by default, both without a shell and with a timeout.
- **Safe glyphs.** Every non-ASCII character either view may draw is in one whitelist (`●✓✗◌–·│─┊╭╮╰╯`), enforced by a test, so terminal fonts without wider symbol coverage still render it. The mod's own text is ASCII; only text from your channels or commands may contain other characters.
- **One model, two views.** The band and the pane read the same model, so their counts, marks and colors always agree.
- **Fits narrow panes.** Tested at 48 and 60 columns without overflow, and within 44 rows with every card title still visible.

## Development

```sh
claude plugin validate .            # manifest and hooks module, as the engine reads them
claude plugin test .                # runs tests/*.test.ts against the engine
npx -y -p typescript@5.9.3 tsc -p . --noEmit
```

The type declarations the hooks import (`claude-code`, `claude-code/testing`) are written by Claude Code into `.claude-plugin/types/` the first time it loads the mod from a folder you own (for example with `claude --plugin-dir .`), and again after an update. That folder is not committed; load the mod once before running `tsc`. `tsconfig.json` includes it, so no other setup is needed.

Layout:

```text
.claude-plugin/plugin.json   manifest and userConfig options
hooks/hooks.json             names the hooks module
hooks/register.tsx           the hooks: events, timers, /monitor
hooks/config.ts              option parsing and card name matching
hooks/model.ts               the one model both views read
hooks/view.ts, hooks/pane.ts the band and the pane
hooks/dispatch.ts            dispatch JSONL parsing and pairing
hooks/custom.ts              custom card JSON parsing
hooks/logic.ts               channel, reply and subagent tracking
types/index.d.ts             the mod's state contract
tests/                       claude plugin test suites
```

## License

MIT. See [LICENSE](LICENSE).
