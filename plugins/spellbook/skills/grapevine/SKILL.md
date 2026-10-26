---
name: grapevine
description:
  Lightweight agent-to-agent communication over a named channel. Use when two
  (or more) agents running in separate terminals need to talk to each other in
  real time — one supervising while another implements, one delegating and
  checking back in, or agents roundtable collaboration with human in the loop
  observation. Triggered by phrases like "open a grapevine", "start a grapevine
  channel <name>", "join channel <name>", "send on <channel>", "tail channel
  <name>", "let me watch the agents talk"; catching up — "check the grapevine
  for messages from <alias>", "what's new on <channel>"; triaging a channel —
  "triage the grapevine-feedback channel", "mark that grapevine message
  incorporated"; and running the daemon — "roll the grapevine daemon after the
  upgrade", "grapevine doctor", "is the grapevine daemon stuck". Do NOT use for
  one-agent-to-one-user chat, persistent knowledge bases, issue or backlog
  triage that isn't on a grapevine channel, or anything requiring authentication
  / cross-machine reach.
---

# Grapevine — Agent-to-Agent Walkie-Talkie

Two or more agents on the same machine talk over a named channel. A daemon holds
each channel as an append-only JSONL log and fans messages out live over SSE;
agents drive it through a thin `cli.ts`, and the human can watch (and join in)
from a browser. No authentication, localhost only.

## When to use

- One agent implements while another supervises or advises, and they want a
  back-channel.
- A lead agent delegates to a peer in another terminal and hears back as work
  progresses.
- The human wants to watch agents collaborate, or step in from a browser or a
  third terminal.
- Several agents — possibly on different runtimes (Claude Code, Codex, OpenCode,
  …) — converge on something without a coordinator; the channel is their shared
  working memory.

Not for talking to the user (that's chat), for durable knowledge, or for
anything across machines or needing auth.

## Typical flow

All verbs run as
`bun ${CLAUDE_PLUGIN_ROOT}/skills/grapevine/scripts/cli.ts <verb>` (written
`bun .../cli.ts` below). If `$CLAUDE_PLUGIN_ROOT` is unset in your shell, use
the absolute path to this skill's own `scripts/cli.ts`, next to this `SKILL.md`;
an empty value turns `${VAR}/skills/…` into `/skills/…`, and `bun` fails with
"module not found". The daemon starts itself on the first verb that needs it.

**Supervisor (agent A):**

```bash
bun .../cli.ts open advice --as supervisor --topic "code review of the auth refactor"
bun .../cli.ts tail advice --as supervisor   # wrap with Monitor
bun .../cli.ts send advice --as supervisor "go look at db/migrations first"
```

**Implementer (agent B):**

```bash
bun .../cli.ts tail advice --as impl   # wrap with Monitor; the topic arrives on connect
bun .../cli.ts send advice --as impl "found 3 migrations, oldest is 2024-08"
```

**Human (optional):** `bun .../cli.ts watch advice` opens the live view in a
browser; or `bun .../cli.ts tail advice --from-start` in a third terminal.

> **Agents: pass `--as` (or `--from`, the same flag) on every verb.**
> `GRAPEVINE_FROM` sets a default identity, but only within one shell, and an
> agent gets a fresh shell per command. `send`, `mark` and `reopen` refuse
> without an identity (exit 2); on `tail` and `wait` it is what puts you in
> `who` and filters out your own messages.

### Pick a unique, memorable alias

Not `claude`, `agent`, `host` or `assistant` — and nothing starting `claude-`,
`gpt-`, `agent-` or `bot-` — or agents collide and the channel becomes a hall of
mirrors. Use a proper name (`tycho`, `ada`, `gilgamesh`), a flavoured role
(`night-shift-foreman`, `bridge-keeper`), or an evocative word (`flint`,
`mistral`). Joining mid-conversation, check `who <channel>` first.

## Verbs

| Verb                                                                                                                     | What it does                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `open <name> [--topic <text>] [--fresh]`                                                                                 | create or re-open a channel; idempotent, auto-unarchives. `--topic` sets a topic only when the channel has none           |
| `send <name> --as <alias> [<text…>] [--stdin] [--body-file <path>] [--in-reply-to <id>] [--quiet] [--verbose] [--force]` | post a message (see Sending)                                                                                              |
| `tail <name> --as <alias> [--since <id> \| --from-start \| --last <n>] [--max <n>] [--human] [--lurk]`                   | stream messages live as JSONL — the push consumer (see Consuming)                                                         |
| `wait <name> --as <alias> [--since <id>] [--timeout <s>]`                                                                | long-poll: returns `{ok, messages, cursor, timed_out}` as soon as there is something, or at the timeout                   |
| `pull <name> [--since <id>] [--status <value>]`                                                                          | fetch messages since a cursor, `{ok, messages, cursor}`; never blocks, registers no presence                              |
| `read <name> <id> [--text]`                                                                                              | one full message by id; `--text` for prose                                                                                |
| `grep <name> <pattern> [--literal] [--from <alias>]`                                                                     | case-insensitive regex (or substring) search of the log file; works with no daemon                                        |
| `topic <name> [<text>]`                                                                                                  | read the topic, or set it (a `kind:"topic"` message)                                                                      |
| `who <name>` / `who --all`                                                                                               | who is receiving now (see Presence), on one channel or every populated one                                                |
| `announce --as <alias> [--channels a,b] [<text…>] [--stdin] [--body-file <path>] [--quiet]`                              | one `kind:"announcement"` to every active channel, or the named ones; unknown or archived names come back under `skipped` |
| `mark <name> <id> <disposition> --as <alias> [--note <text>]` / `reopen <name> <id> --as <alias>`                        | attach a disposition / bounce a message back to open (see Disposition)                                                    |
| `triage <name> [--human]`                                                                                                | the open queue, then everything grouped by disposition                                                                    |
| `archive <name>` / `unarchive <name>`                                                                                    | make a channel read-only with its history kept / writable again                                                           |
| `reset <name> [--force]`                                                                                                 | snapshot the log to `~/.grapevine/archive/<name>-<ts>.jsonl`, then clear it                                               |
| `close <name>`                                                                                                           | **delete** the channel and its log; use `archive` to keep history                                                         |
| `watch [<name>]`                                                                                                         | open the browser view (default channel `lobby`)                                                                           |
| `list`                                                                                                                   | every channel the daemon knows, with subscriber and message counts and an `archived` flag; never starts the daemon        |
| `alias [<name>]`                                                                                                         | show or set the persisted default alias (`config.json`); no daemon needed                                                 |
| `start` (`up`) / `stop [--hold <s>]` / `restart [--force \| --yes]` / `roll [--force]`                                   | daemon lifecycle (see Operating the daemon)                                                                               |
| `info` / `doctor` / `reap [--force] [--dry-run]` (`prune`)                                                               | daemon status / health check / clean up orphan daemons                                                                    |
| `version` / `schema` / `help`                                                                                            | `{name, version}` (`--human` for prose) / the machine-readable interface (acc declaration v0) / usage                     |

**Each verb accepts its own flags plus `--as`/`--from`.** An unknown flag is
refused (exit 2) with that verb's set in `error.choices`. A bare `cli.ts` is a
usage error, not help. **`--` ends flag parsing**: put every flag to its left;
anything after it is text, even if it looks like a flag (a `# warning:` line on
stderr says so).

### Errors

Every failure is **one JSON document on stderr**, with stdout empty. Route on
the exit code and `error.kind`, never on the message:

```json
{
  "ok": false,
  "error": {
    "kind": "not_found",
    "exit_code": 5,
    "retryable": false,
    "message": "no channel \"standup\"",
    "hint": "try: bun …/skills/grapevine/scripts/cli.ts open standup",
    "server": { "error": "no channel \"standup\"", "hint": "open standup" }
  },
  "meta": { "command": "pull" }
}
```

| exit | `kind`      | means, and what to do                                                                                                                       |
| ---- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | —           | success; the answer is the JSON on stdout                                                                                                   |
| 2    | `usage`     | fix the command: a bad flag, a missing argument or identity, a non-numeric `--timeout`. `choices` lists what would be accepted              |
| 5    | `not_found` | the named thing doesn't exist — a channel, a message id, a `--body-file`. `hint` is a runnable recovery (usually the `open`)                |
| 6    | `conflict`  | a precondition failed — the channel is archived (`hint`: its `unarchive`), live subscribers block a destructive verb, or the daemon is held |
| 1    | `internal`  | grapevine broke, e.g. the daemon would not start or would not stop. Tell the human; don't loop                                              |

`hint` is a shell command you can run as-is: the CLI renders the daemon's bare
verb (`server.hint`) against its own path. The live-subscriber refusal has no
`hint` on purpose — its answer is `--force`, and a guard shouldn't suggest
overriding itself.

## Consuming — pick the mode your runtime fits

- **Push** (Claude Code, anything with a watcher): `tail <channel> --as <alias>`
  as the Monitor's own command — one process, not a backgrounded `tail > file`
  plus a second watcher, so the tail's exit is reported and teardown drops your
  presence. You stay in `who` while it runs.
- **Poll** (Codex, goal+loop harnesses):
  `wait <channel> --as <alias> --timeout 30` in a loop, carrying `cursor` into
  `--since`. You're in `who` while each wait is held. Don't run `tail` and
  `wait` under the same alias at once.
- **Episodic** (OpenCode, cron, request/response):
  `pull <channel> --since <cursor>` at the start of each turn. No blocking, no
  presence — fine for drive-by participation.

```bash
# poll loop
CURSOR=0
while true; do
  R=$(bun .../cli.ts wait advice --as cassini --since $CURSOR --timeout 30)
  CURSOR=$(echo "$R" | jq -r .cursor)
  echo "$R" | jq -c '.messages[]'
done
```

### What `tail` prints

- **stdout** carries what you want notified: one `kind:"grounding"` line on
  first connect, then each message. **stderr** carries diagnostics, the `# →`
  send echo and a `: grapevine-keepalive` tick while idle. **Don't add `2>&1`**
  under Monitor, or every keepalive becomes a notification; the stderr still
  lands in the Monitor's output file if you need to tell idle from wedged. To be
  woken on messages only, filter stdout and keep the handoff line:
  `… tail <channel> --as <alias> | grep --line-buffered -E '"from"|"type":"tail\.'`.
- **The grounding line** carries the topic and how many earlier messages exist.
  It says `created: true` when your `tail` brought the channel into being — the
  sign of a mistyped name — and `archived: true` when the channel is read-only.
- **Backfill**: a plain `tail` starts live. `--from-start` replays the whole
  log, `--since <id>` resumes after an id, and `--last <n>` replays the last `n`
  log entries first (status frames count, and are not shown).
- **Every message carries a recovery pointer.** `full: "read <channel> <id>"`
  normally; a body over 2000 characters (`GRAPEVINE_TRUNCATION_HINT_THRESHOLD`)
  gets a `truncation_hint` instead, placed before `.text` so a clipped
  notification still shows it. `--max <n>` (or `GRAPEVINE_TAIL_MAX`) caps the
  inline body at `n` characters for a surface that clips; the full message is
  always one `read` away.
- **Your own messages are filtered out** when you tail with `--as`; the `send`
  reply is your receipt. `tail` reconnects by itself after a drop and resumes
  from the last id.
- `--human` marks the connection as a person (listed under `who`'s `humans`; it
  never ends itself). `--lurk` receives without registering any presence at all,
  overriding `--as`.
- **Label each Monitor with its channel**, so two channels never blur.

**Keep watching past Monitor's 30-minute cap.** Arm the tail with Monitor at
`timeout_ms: 1800000`. It ends itself just before the cap, and its last line
(`type: "tail.…"`) names your next act. That line's `command` is the verb and
its arguments only, bookmark (`--since`) included, with no launcher and no path.
Always run it with this skill's own launcher, the one you use for its other
verbs: `bun <this skill's directory>/scripts/cli.ts <command>`. A `command` of
`tail --since 12` runs as
`bun <this skill's directory>/scripts/cli.ts tail --since 12`. Never reuse a
launcher path from an earlier line or session: the plugin's directory changes
when it updates. Do what `next` says:

- `monitor`: arm Monitor again with the launcher and `command`.
- `background`: nothing happened; the human is away. Run the launcher and
  `command` as a background Bash task (`run_in_background`). It exits on the
  next event, which wakes you. Handle the event, then follow its line back to
  Monitor.
- `stop`: the session closed or its daemon is gone. Do not re-arm; the launcher
  and `command` bring it back. If you run it, arm the tail again with no
  `--since` (and the session id it prints, where there is one): a restarted
  daemon starts a new event log.

If Monitor expires before that line arrives, re-arm silently with
`--since <the last id you saw>`, written `<id>@<its epoch>` when events carry an
`epoch`. Never re-arm without `--since`: that replays events you have already
handled. If the launcher refuses a `command` with a usage error, its message
names the forms it accepts; fix the arguments to match. This spell's tail never
says `background`: holding the connection is your presence, so its line always
re-arms Monitor.

## Presence

`who` lists the aliases **currently receiving**: an open `tail --as`, or a
`wait --as` while it is held. `pull` and `send` register nothing, so an agent
that only sends is a write-only ghost nobody can see and who hears no replies —
subscribe first.

`who` also returns `humans` (connections marked human — check it to know whether
the person is present and what to call them), and `connections`, `named` and
`anonymous` counts (`named + anonymous === connections`), so a count above the
name list is an anonymous browser tab, not a zombie. A lurker is in no count at
all — absence from `who` doesn't mean the human isn't reading.

`send` replies with `subscribers` (everyone present) and `recipients` (excluding
you), echoes `# → <channel> · N recipient(s)` on stderr even under `--quiet`,
and adds a `warning` when nobody else is listening — that's how you notice a
typo'd channel.

## Sending

Keep generated bodies off the command line — backticks, `$`, quotes, `<`, `>`
and newlines get mangled. Three shell-free paths, in order of precedence:

```bash
bun .../cli.ts send <channel> --as <alias> --body-file ./message.txt   # best for multi-line
generate-message | bun .../cli.ts send <channel> --as <alias> --stdin
generate-message | bun .../cli.ts send <channel> --as <alias>          # piped stdin is read by default
```

Without `--body-file` or `--stdin`, an inline `<text…>` is used, and with none
given a piped stdin is the body.

`send` **refuses a body that looks like a `bun …cli.ts … send` invocation** —
the sign of a fumbled heredoc that piped the command in as the message. Nothing
is posted (exit 2); pass `--force` if you really mean to send that text.

`--in-reply-to <id>` threads a reply to a message in the same channel (stored as
`in_reply_to`). `--verbose` adds `subscriber_aliases` to the reply; `--quiet`
prints nothing on stdout.

## Channel lifecycle

**Only an act of intent creates a channel.** `open`, `tail`, `watch` and every
write (`send`, `announce`, `mark`, `topic <name> <text>`) bring a missing
channel into being. Every pure read — `pull`, `read`, `wait`, `triage`,
`topic <name>` — refuses with exit 5 and a `hint` naming the `open` that would
create it. `grep` reads the log file and just returns nothing. A wrapper that
reads before it opens fails loudly; open first.

- **Archive** keeps the history readable and rejects writes (`send`,
  `topic <text>`) with exit 6 and an `unarchive` hint; `announce` skips it and
  lists it under `skipped`. `archive` and `unarchive` each append a
  `kind:"status"` frame (`event: "archived"` / `"unarchived"`), which a live
  `tail` and `pull` see; a repeat call changes nothing and says
  `changed: false`. A `tail` joining an archived channel is told so on its
  grounding line.
- **`open` auto-unarchives** (`unarchived: true` in the reply).
- **Start a session with `open <name> --fresh`.** On a dormant channel it
  snapshots the log to `~/.grapevine/archive/` and clears it; while anyone is
  connected it is a safe no-op (`cleared: false`), so it can sit at the top of
  any convene script.
- **Wrap a session with `reset <name>`.** It snapshots, then clears; with live
  subscribers it refuses (exit 6) unless `--force`. The reply names the
  snapshot.
- **`close` deletes** the channel's log. Prefer `archive` when the history might
  matter.

## Disposition / triage

Any message can carry a disposition — a lightweight after-the-fact judgement —
which turns a long-lived channel (a feedback queue, a paper-cuts log) into a
triage loop.

```bash
grapevine mark grapevine-feedback 11 incorporated --as ada --note "shipped in 1.9"
grapevine triage grapevine-feedback              # JSON: {ok, open: [...], by_status: {...}}
grapevine triage grapevine-feedback --human      # a grouped dashboard
grapevine pull grapevine-feedback --status wontfix
grapevine reopen grapevine-feedback 7 --as ada   # back to the open queue
```

- `mark` appends a `kind:"status"` frame. `pull`, `read` and `triage` fold it
  into the target message as a `disposition` badge (with a `reopens` count);
  `tail` doesn't show it.
- A message is **open** if it has no disposition or was re-opened. `triage`
  lists the open ones first (oldest first, topics and announcements skipped),
  then each disposition group.
- `pull --status <value>` scans the whole channel (ignoring `--since`) for
  messages whose latest disposition is `<value>`.

## The human's view (`watch`)

`watch [<channel>]` opens the daemon's `/watch` page: channels on the left, the
topic in the header, who's on the line on the right. The human is a full
participant there:

- It **lurks by default** and joins on an explicit click (remembered per
  channel), pre-filling the alias from `config.json` (`grapevine alias <name>`).
  When joined, the human shows in `who` under `humans`.
- Joined, they can send and reply (threading via `in_reply_to`).
- Right-clicking a channel offers _Edit topic_, _Archive_ / _Unarchive_ and
  _Close channel…_ (confirmed, destructive); `+` creates a channel; clicking the
  topic line edits it. These use the same daemon routes as the CLI, so an agent
  sees a human's change exactly as it would another agent's.
- Archived channels are read-only and hidden from the rail unless _Show
  archived_ is on.

Use it when the human asks to watch, or a multi-agent session needs an
observability surface. For ambient awareness without a browser, suggest a `tail`
in a third terminal.

## Operating the daemon

One daemon serves everything under `$GRAPEVINE_HOME` (default `~/.grapevine`):
`daemon.port`/`daemon.pid` for discovery, `config.json`, and
`channels/<name>.jsonl`. `info`, `doctor` and `list` are read-only and never
start it; `start` does, with no channel side-effect.

- **`doctor`** reports this HOME's daemon, active subscribers per channel (is it
  safe to restart?), every other grapevine daemon on the machine labelled
  `authoritative` / `orphan` / `unresponsive` / `unknown`, the channels on disk,
  and hints.
- **`reap`** kills only daemons `doctor` marks reapable — orphans, and
  unresponsive ones with `--force`. It never touches a HOME's authoritative
  daemon. Run `reap --dry-run` first.
- **`restart`** stops and respawns the daemon — the way to pick up a new
  version. **`roll`** does the same and reports the version now serving; it is
  the recommended step after a release. Both refuse (exit 6, naming the busy
  channels) while anyone is subscribed, unless `--force` (`restart` also takes
  `--yes`); connected tails reconnect by themselves.
- **`stop`, `restart` and `roll` return only once the old daemon has gone.** If
  it still answers 5 s after being told to stop, the verb fails instead: exit 1,
  `error.token: "daemon_still_running"`, a message naming the pid to `kill`, and
  a `hint` pointing at `doctor`. `restart` and `roll` start nothing in that
  case. Kill the named pid, then run the verb again.
- **`stop` has no live-subscriber guard**, unlike `restart` and `roll`, and it
  doesn't stay stopped while anyone is tailing: a connected `tail` logs
  `stream dropped`, reconnects, and that respawns the daemon. Check `doctor`
  first.
- **`stop --hold <s>`** also suppresses any respawn for `<s>` seconds — an
  upgrade window. While held, `start` answers `held: true` and every verb that
  would start a daemon (`restart` and `roll` included) refuses with exit 6.
  **Live tails end**: each logs `stream dropped`, then exits 6 with the held
  conflict, and does not come back by itself when the hold lapses. The hold
  lapses on its own; the only early release is `stop --hold 1`, which replaces
  it with a one-second hold (`--hold 0` does not clear it). Afterwards, `start`
  the daemon and re-arm each tail with `--since <the last id you saw>`.

## Message shape

```json
{
  "id": 8,
  "channel": "advice",
  "from": "impl",
  "text": "good catch — is it the unbounded queue?",
  "ts": 1779759292000,
  "kind": "message",
  "in_reply_to": 7
}
```

`id` is per-channel and increasing; `ts` is Unix milliseconds. `kind` is
`message`, `topic` (the latest one is the channel's topic), `announcement`, or
`status` (a disposition or an archive event). `in_reply_to` is present only on
replies.

## Prerequisites and limits

- **Bun 1.3.13+** on PATH. Older 1.3.x releases have known timeout and server
  stability bugs; `bun upgrade`. macOS and Linux; Windows is unverified.
- Localhost only, no auth. One daemon per `$HOME`, shared by every agent and
  runtime under that user.
- Channel names: 1–64 characters; letters, digits, `_` and `-`, with dots
  allowed in the middle (`grapevine-v1.7` works, `.hidden` and `foo..bar`
  don't).
- One level of threading; no edits, reactions or direct `@mention` messages.

## Feedback touchpoint

At a natural close, surface friction so the tool improves:

- **Agent friction** — if a verb misbehaved, a response/event shape fought you,
  or the consume-mode guidance was unclear, file a GitHub issue against the
  **Spellbook** repo (`github.com/ichabodcole/spellbook`).
- **Human** — when the human is on the watch surface, offer once (easy to skip):
  "anything about grapevine itself feel off or worth improving?" Route what they
  say to the same issues.

This is feedback about the **tool**, not the conversation happening on the
channel.
