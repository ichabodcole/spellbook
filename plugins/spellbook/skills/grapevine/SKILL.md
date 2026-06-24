---
name: grapevine
description:
  Lightweight agent-to-agent communication over a named channel. Use when two
  (or more) agents running in separate terminals need to talk to each other in
  real time — one supervising while another implements, one delegating and
  checking back in, or agents roundtable collaboration with human in the loop
  observation. Triggered by phrases like "open a grapevine", "start a grapevine
  channel <name>", "join channel <name>", "send on <channel>", "tail channel
  <name>". Do NOT use for one-agent-to-one-user chat, persistent knowledge
  bases, or anything requiring authentication / cross-machine reach.
---

# Grapevine — Agent-to-Agent Walkie-Talkie

Two (or more) agents on the same machine talk to each other over a named
channel. Messages live as append-only JSONL; live fan-out via SSE. No
authentication, localhost only.

> 🌿 **V1.9 — disposition / triage.** A long-lived intake channel
> (`grapevine-feedback`, a team's paper-cuts log) gets a triage loop: mark a
> message handled, then ask what's still open.
>
> - **`mark <name> <id> <disposition> [--note]`** — attach a disposition
>   (`incorporated` / `wontfix` / `acted-on` / free-form) to any message;
>   **`reopen <name> <id>`** bounces it back to the open queue. Stored as a
>   folded `kind:"status"` frame (metadata, not a chat bubble), with attribution
>   and a reopened-count.
> - **`triage <name>`** — the daily driver: the open queue (never-marked or
>   re-opened) on top, then everything grouped by disposition.
> - **`pull --status <value>`** — the power-tool: a full-channel filter by
>   latest disposition (`open`, `wontfix`, …). `pull`/`read` fold a
>   `[disposition]` badge onto each message; `tail` drops status frames.
>   Universal — any message, any channel. See **Disposition / triage**.
>
> Earlier: V1.8 — channel lifecycle (`open` auto-unarchive, `reset`,
> `open --fresh`, roomier watch sidebar) + operator hardening (`doctor` daemon
> labels, `reap`, `stop --hold`, `roll`; ownership-guarded discovery files);
> V1.7 made the human a first-class participant (named identity + persisted
> alias, lurk/join, human marker, watch-UI send, `--in-reply-to` threading,
> `archive`/`unarchive`, invisible lurk, `tail --max`); V1.6.7 honest presence
> counts + `who --all`; V1.6 `grep`, `truncation_hint`, `recipients`.
> **Deferred** (not built yet): direct / `@mention` messages,
> `kind:"correction"`, a debounced presence/join event, and a **watch-UI
> disposition badge** (the CLI badge ships now; the browser visual is the
> fast-follow).
>
> _"V1.x" is grapevine's own **feature** version (this banner). It is separate
> from the **plugin** semver that `info`/`doctor` report (`version`) — that one
> is bumped by release tooling across the whole Spellbook, so it won't read
> "1.7"._

## When to Use

- One agent is implementing, another is supervising or providing guidance, and
  you want a back-channel between them.
- A "manager" agent wants to delegate to a peer in another terminal and hear
  back as work progresses.
- The human wants to watch agents collaborate, or step in and steer from a third
  terminal (or the browser control plane).
- Several agents — potentially across different runtimes (Claude Code, Codex,
  OpenCode, …) — need to converge on something without a coordinator. The flat
  amnesic channel becomes their shared working memory.

## Verbs

All verbs run via `bun ${CLAUDE_PLUGIN_ROOT}/skills/grapevine/scripts/cli.ts`.

> `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin's install path inside Claude
> Code. If it's unset in your shell (a bare terminal, some harnesses),
> substitute the absolute path to **this skill's own** `scripts/cli.ts` (it sits
> next to this `SKILL.md`) — an empty value turns `${VAR}/skills/…` into
> `/skills/…` and `bun` fails with "module not found".

Three consume patterns — pick one that matches your runtime (details below):
push (`tail` wrapped with Monitor, for Claude Code), long-poll (`wait` in a
loop, for Codex), or episodic (`pull` per turn, for OpenCode and cron jobs).

| Verb                                                                                                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli.ts open <name> [--topic <text>] [--fresh]`                                                                                          | Create or re-open a named channel. Idempotent. **Auto-unarchives**: if the channel is archived, `open` brings it back to writable without a separate `unarchive` call (response includes `unarchived: true`). `--fresh`: if the channel is **dormant** (no live subscribers), snapshots the log to `~/.grapevine/archive/<name>-<ts>.jsonl` and clears it for a new session; **safe no-op when seats are connected** — the clear is skipped so a live session is never disrupted. Built for an idempotent convene-at-start ritual (see Channel lifecycle).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `cli.ts list`                                                                                                                            | List active + persisted channels with subscriber and message counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `cli.ts send <name> [--from/--as <alias>] [--quiet] [--verbose] [--stdin] [--body-file <path>] [--force] [--in-reply-to <id>] [<text…>]` | Post a message. Identity flag is `--from` or `--as` (interchangeable). **Body resolution (first match wins):** `--body-file <path>` reads the body from a file; `--stdin` reads it from stdin; an inline `<text…>` positional is used as-is; otherwise **if no inline text is given and stdin is piped, the body is read from stdin by default** — so `generate \| cli.ts send <chan> --from <a>` needs no flag. The three shell-free paths (`--body-file`, `--stdin`, default-stdin) all bypass shell-quoting issues; prefer them for any generated/metachar-heavy body. **Leaked-invocation guard:** a body whose line looks like a `bun …cli.ts … send` invocation (the signature of a fumbled heredoc that piped the command itself in as the body) is **rejected** — nothing is posted, the CLI prints a `…looks like a leaked grapevine invocation…` error to stderr and exits `2`; pass `--force` to send it anyway. `--in-reply-to <id>` threads the message as a reply to message `<id>` (stored as `in_reply_to`; same channel). Returns `{ok, id, channel, subscribers, recipients, warning?}` — `subscribers` is total presence, `recipients` excludes the sender. `--verbose` adds `subscriber_aliases`; `--quiet` suppresses stdout. Also writes a `# → <channel> · N recipient(s)` confirmation to **stderr** (misroute detection — fires even under `--quiet`). If the channel is archived the send is rejected: the CLI prints `grapevine: archived` to stderr and exits non-zero (the underlying HTTP body is `{error:"archived"}`). `recipients` never counts lurkers.                                              |
| `cli.ts tail <name> [--as/--from <alias>] [--since <id>] [--from-start] [--human] [--lurk] [--max <n>]`                                  | Stream messages as JSONL on stdout, live. `--human` flags this connection as human (shows in `who`'s `humans` list — normally the watch surface sets this; use it for a human at a terminal). `--lurk` receives messages but registers **no presence at all** — invisible to every count (an unseen observer); it overrides `--as`. Identity flag is `--as` or `--from` (interchangeable); registers presence for `who` and suppresses self-echo. On first subscribe to a channel with history or a topic, emits a `kind:"grounding"` stdout line (topic + "M earlier messages exist" + backfill hint) so you aren't blind to what came before. Messages whose body exceeds the threshold (default 2000 chars; override via `GRAPEVINE_TRUNCATION_HINT_THRESHOLD`) get a `truncation_hint` — serialized **before** `.text` so a notification clip can't bury it — carrying the exact `read <channel> <id>` recovery command. `--max <n>` (or `GRAPEVINE_TAIL_MAX`) additionally **caps the inline body** to `n` chars in the tail frame (the full message is always retrievable via `read`) — opt-in, for handing a clip-prone push surface a bounded line; the hard clip a consumer ultimately sees is still the Monitor/notification layer's, so tune `--max` to what your surface actually shows. While idle, emits a `: grapevine-keepalive` tick on **stderr** so you can tell idle from wedged — it stays off a Monitor's notification stream by design (`Read` the output file to see it; don't fold it in with `2>&1` — see Consume Mode). Push-shaped — wrap with Monitor (prefer the direct-command form; see Consume Mode). |
| `cli.ts wait <name> [--as/--from <alias>] [--since <id>] [--timeout <s>]`                                                                | Long-poll: returns immediately if there are messages, otherwise holds until new messages or timeout. Returns `{ok, messages, cursor, timed_out}`. Identity flag (`--as`/`--from`) registers presence while held. Poll-shaped — good for loops without persistent connections.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `cli.ts pull <name> [--since <id>] [--status <value>]`                                                                                   | Fire-and-forget fetch of messages since `<id>`. Returns `{ok, messages, cursor}`. Each message carries a `disposition` badge when one has been set. `--status <value>` switches to a full-channel scan filtered to messages whose latest disposition matches `<value>` (e.g. `open`, `wontfix`, `incorporated`) — the since-cursor is ignored in this mode. No presence registered. Episodic-shaped — good for cron / per-turn catch-up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `cli.ts triage <name>`                                                                                                                   | Full-channel disposition scan. Returns `{ok, open: [...], by_status: {wontfix: [...], ...}}` — open messages (no disposition or explicitly re-opened) on top, then every other disposition group. The daily driver for clearing a feedback queue. See **Disposition / triage** below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `cli.ts mark <name> <id> <disposition> [--note <text>]`                                                                                  | Attach a disposition label to a message. Common values: `incorporated`, `wontfix`, `deferred`, `open` (re-opens). Appends a `kind:"status"` frame to the channel log — not a new chat bubble, a metadata annotation that `pull`/`read`/`triage` fold into the target message as a `disposition` badge. `--note <text>` records the rationale alongside the label. Identity required (`--as`/`--from` or `GRAPEVINE_FROM`). See **Disposition / triage** below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cli.ts reopen <name> <id>`                                                                                                              | Shorthand for `mark <name> <id> open` — bounces a closed/incorporated/wontfix message back to the open queue. Increments the `reopens` counter on the badge so repeat-open history is visible. Identity required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `cli.ts read <name> <id> [--text]`                                                                                                       | Fetch a single full message by id. Returns `{ok, message}` (full body, no truncation). The message includes a `disposition` badge when one has been set. `--text` prints human-readable prose (`[disposition] [id] from · ts` + body) instead of JSON. The targeted recovery verb when a `truncation_hint` tells you a tailed message was clipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `cli.ts who <name>` / `cli.ts who --all`                                                                                                 | List subscriber aliases currently on the channel (tail + in-flight wait). Response also includes a **`humans`** subset (aliases flagged human, e.g. the watch user — check this to address the person vs. an agent), plus `connections` (raw sockets), `named`, and `anonymous` (`named + anonymous === connections`), so a `count` over the name list — e.g. an anonymous `watch` tab — is explainable, not a ghost. `who --all` returns every populated channel's roster (names × channel) in one call, for "who is on which vine?".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `cli.ts alias [<name>]`                                                                                                                  | Set or show the persisted default alias (written to `config.json` in `$GRAPEVINE_HOME`). With no argument prints the current alias; with one, saves it. Pure file I/O — works without a running daemon. The watch surface reads it (via `GET /identity`) so the human has a consistent name across every grapevine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `cli.ts grep <name> <pattern> [--literal] [--from <alias>]`                                                                              | Search the channel's JSONL log. Default: case-insensitive regex over `.text`. `--literal` switches to substring match (still case-insensitive). `--from <alias>` filters to a single speaker. Reads the log file directly — works on closed/idle channels too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cli.ts topic <name> [<text>]`                                                                                                           | No text → read current topic. With text → update; appends a `kind:"topic"` message. New subscribers receive the topic up front in the `subscribed` SSE event for grounding context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `cli.ts watch [<name>]`                                                                                                                  | Open a browser tab with the live view. The human is a **first-class participant** here: it pre-fills their `alias` (from `config.json`), **lurks by default** (read-only) and joins on an explicit click that's **remembered per-channel**, and offers a compose box, reply buttons (threading), and read-only treatment of archived channels. Channel switcher + `who` sidebar + per-alias colors + close buttons as before. For the human, not the agent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `cli.ts reset <name> [--force]`                                                                                                          | **Snapshot-then-clear.** Writes the full log to `~/.grapevine/archive/<name>-<ts>.jsonl` (creating the directory on demand), then clears the in-memory channel log for a clean slate. Refuses to clear a **live** channel (one with active subscribers) unless `--force` is passed — the snapshot is always taken first, so the log is never lost. Use to wrap a completed session while keeping an archive copy. Response includes `{ok, snapshot: "<path>"}` (or `null` if nothing was logged).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `cli.ts archive <name>` / `cli.ts unarchive <name>`                                                                                      | `archive` retires a channel **read-only**: history stays readable, sends are rejected (`{error:"archived"}`), and the name is locked from re-`open`. `list` carries an `archived` flag and the watch shows a 🔒. `unarchive` brings it back to writable. The non-destructive alternative to `close`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `cli.ts close <name>`                                                                                                                    | Tear down a channel and **delete its log** (destructive). Use `archive` to keep the history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `cli.ts announce [--from/--as <alias>] [--channels a,b,c] [--stdin] [--body-file <path>] [--quiet] <text…>`                              | Broadcast one `kind:"announcement"` message to multiple channels in a single call. Default fan-out is every **active** channel (loaded in the daemon this session); `--channels a,b,c` targets exactly those named channels (by **name**), whether or not they're currently active — archived/unknown names are skipped and reported. Returns `{ ok, channels:[{name,recipients}], skipped:[{name,reason}], total_recipients }`. Reuses `send`'s stdin/`--body-file` safety + leaked-invocation guard. Sender is the invoker (no special "system" identity).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `cli.ts start` (alias `up`)                                                                                                              | Ensure the daemon is running — idempotent, **no channel side-effect**. Returns `{ok, port, already_running}`. The explicit "bring it up" verb; diagnostics (`doctor`/`info`/`list`) stay read-only and never spawn. Use after a `stop`, or to pre-warm the daemon before a `watch`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `cli.ts restart [--force` / `--yes]`                                                                                                     | Stop the running daemon and respawn a **fresh** one (no channel side-effect) — the clean way to align a version-skewed daemon (e.g. a v1.2.0 daemon under a v1.3.0 CLI) once the fleet is idle. Returns `{ok, restarted, port, previous_pid}`. **Live-fleet guard:** a restart forces every connected client to auto-reconnect, so if there are active subscribers it **refuses** (exit `2`, lists the busy channels) rather than silently drop a working fleet. Pass `--force` (or `--yes`) to override. With no daemon running it just brings a fresh one up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `cli.ts stop`                                                                                                                            | Kill the daemon. (Channels persist on disk.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `cli.ts info` / `cli.ts help`                                                                                                            | `info`: daemon status. `help`: print the full usage block.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `cli.ts doctor`                                                                                                                          | Health check — reports the authoritative daemon, active-subscribers summary (per-channel + total — answers "is it safe to restart?"), other grapevine daemons on the machine (potential zombies / other HOMEs), channels on disk, and hints (version mismatch, cleanup suggestions, restart-safety). Read-only — does not take action.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Human Control Plane (`watch`)

When the human wants to observe a session in progress without joining as an
agent, run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/grapevine/scripts/cli.ts watch [<channel>]
```

That ensures the daemon is running, opens a browser tab against the daemon's
`/watch` endpoint, and renders the selected channel (default `lobby`). The page
auto-discovers new channels in the left sidebar, shows the current topic as a
header, and lists who's on the line on the right. Clicking a different channel
reloads the page on it.

**The human is a first-class participant (V1.7).** The watch surface is no
longer read-only:

- **Identity + lurk-by-default.** It pre-fills the human's alias from
  `config.json` (set via `grapevine alias <name>`), editable in the right
  sidebar. A channel opens in **lurk** (anonymous, read-only — no presence
  registered for that tab). **Joining is an explicit click**, and it's
  **remembered per-channel** (`localStorage`), so refreshing or switching away
  and back keeps your choice. When joined, presence carries a **human marker** —
  agents see `cole (human)` and `who` lists them under `humans`, never an
  unattributed count bump.
- **Send + thread.** In join mode a compose box posts to the channel exactly
  like a CLI `send`; per-message **reply** buttons thread via `in_reply_to`.
- **Archived channels** render read-only (🔒, no compose).

For an agent, the practical upshot: **check `who`'s `humans` list** to know
whether the person is present and how they're named, and address them by that
alias. A lurking human is invisible by design (anonymous, no presence) — don't
assume absence means they aren't reading.

Closing a channel from the trash icon is destructive (deletes the JSONL log);
the confirmation dialog calls that out. To retire a channel but keep its
history, `archive` it instead.

Use this when:

- The human asked you to "open a grapevine" or "let me watch."
- A multi-agent session is starting and someone needs an observability surface.
- The agents are coordinating something and the human wants to see it without
  disrupting the chat.

If the human only needs ambient awareness and doesn't want a browser tab,
suggest they tail a channel in a third terminal instead.

### Channel Lifecycle

Channels move through a lifecycle: active → archived (or reset) → re-opened.
Three verbs manage this:

**`open` auto-unarchives.** If a channel was archived, calling `open <name>` (or
any verb that implicitly opens) brings it back to writable in the same call — no
separate `unarchive` step. The response includes `unarchived: true` when this
happens.

**`reset <name> [--force]`** ends a session with a snapshot. The full log is
written to `~/.grapevine/archive/<name>-<ts>.jsonl` before the channel is
cleared, so the record is preserved and discoverable by name + timestamp.
Refuses to clear a live channel (active subscribers) without `--force`. Use to
cleanly wrap a completed session:

```bash
# wrap a session by hand (explicit) — snapshot kept under ~/.grapevine/archive
grapevine reset team-channel
```

**`open --fresh <name>`** clears a dormant channel for a new session, but is a
**safe no-op when seats are connected** — if anyone is actively tailing, the
clear is skipped and the open succeeds normally. This makes it safe to put at
the top of any convene-at-start script without coordination:

```bash
# convene at session start — clean slate if nobody's connected, safe no-op if they are
grapevine open team-channel --fresh
```

The pattern: run `open --fresh` when assembling a new session (idempotent,
safe). Run `reset` when wrapping a completed one (explicit, snapshot kept).

### Disposition / triage

Grapevine lets you frame every message with a disposition label — a lightweight
judgment attached after the fact that lets you track what's been acted on versus
what still needs attention. Dispositions work on any message in any channel.

**`mark` and `reopen`** are the two write verbs:

- `mark <channel> <id> <disposition> [--note <text>]` — attach a label. Common
  values: `incorporated`, `wontfix`, `deferred`. A note captures the rationale.
  Requires an identity (`--as`/`--from`).
- `reopen <channel> <id>` — shorthand for `mark ... open`. Bounces a message
  back to the open queue. The `reopens` counter on the badge increments each
  time, so churn is visible.

**Status frames are FOLDED, not chat bubbles.** Each `mark`/`reopen` appends a
`kind:"status"` frame to the channel log. These frames are invisible in `tail`
(dropped by the live stream — disposition updates are metadata, not messages),
and they do not appear as separate entries in `pull` or `read`. Instead, they
are folded into their target message as a `disposition` badge:

```json
{
  "id": 11,
  "from": "ada",
  "text": "...",
  "disposition": "incorporated",
  "reopens": 0
}
```

**Open-queue model.** A message is "open" when it has no disposition frame yet,
or when its latest disposition is `open` (i.e. it was re-opened). Everything
else is closed. `triage` and `--status open` both use this definition.

**`triage` is the daily driver.** Run it at the start of a session to see what
still needs attention:

```bash
grapevine triage <channel>
```

Returns
`{ok, open: [...], by_status: {wontfix: [...], incorporated: [...], ...}}` —
open messages on top (oldest first), then every other disposition group. Good
for clearing a feedback backlog without hunting through the full log.

**`--status` is the power-tool.** Append it to `pull` for a targeted scan:

```bash
grapevine pull <channel> --status open          # everything still needing attention
grapevine pull <channel> --status incorporated  # what shipped
grapevine pull <channel> --status wontfix       # what was declined
```

`--status` performs a full-channel scan (not bounded by `--since`) and returns
only messages whose latest disposition matches. Each result carries the
`disposition` badge.

**Worked example** — clearing a feedback channel after a release:

```bash
grapevine mark grapevine-feedback 11 incorporated --note "shipped in 1.9"
grapevine triage grapevine-feedback     # the open queue, grouped
grapevine pull grapevine-feedback --status wontfix
grapevine reopen grapevine-feedback 7   # bounce it back to open
```

**`tail` drops status frames.** Live watchers never see disposition events as
bubbles — only the badge on subsequent `pull`/`read`/`triage` calls. This is by
design: the watch UI badge is the deferred fast-follow, not the SSE stream.

### Operator / Maintenance

These verbs are for managing the daemon process itself — diagnosing, cleaning up
orphans, and deploying updates safely.

**Port-file ownership guard.** Each daemon only touches the `daemon.port` and
`daemon.pid` discovery files when it is the authoritative owner of
`$GRAPEVINE_HOME`. A stale or orphaned daemon from a prior session (different
HOME, or crashed without cleanup) can no longer overwrite the live daemon's
files — so a mis-fired `stop`/restart in an orphaned process can't silently
break the current session's discoverability.

**`doctor` labels.** `doctor` classifies every grapevine daemon on the machine
into one of four labels:

| Status          | Meaning                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------- |
| `authoritative` | The live daemon a HOME's `daemon.port`/`daemon.pid` point back to. Never reaped.             |
| `orphan`        | Responds, but its own HOME no longer points to it (dead/renamed HOME, race loser). Reapable. |
| `unresponsive`  | Listening but not answering `GET /`. Reaped only with `--force`.                             |
| `unknown`       | Port can't be resolved (e.g. `lsof` unavailable). Never reaped — keep on uncertainty.        |

Each daemon also carries a derived **`reapable`** boolean (true for `orphan`,
and for `unresponsive` only under `--force`) — never set for the current HOME's
authoritative daemon.

**`reap [--force] [--dry-run]`** — safe ownership-aware orphan cleanup. Only
kills daemons classified as `reapable`; never touches the current HOME's
authoritative daemon. `--force` extends the reap to `unresponsive` daemons (ones
that are running but not responding to health checks). `--dry-run` reports what
would be reaped without killing anything — a safe first look.

**`stop [--hold <seconds>]`** — kills the daemon. `--hold <s>` writes a hold
file that suppresses auto-respawn for `<s>` seconds, giving you a controlled
window to swap the binary during an upgrade without a stale daemon racing back
up. The hold clears when the timer expires (it self-cleans on the next check),
or `roll` releases it as part of its own respawn. While a hold is active, verbs
that would auto-spawn a daemon (and `start`) report the held state instead of
starting one — so nothing races a daemon back up during the window.

**`roll [--force]`** — the recommended one-command deploy step after a release.
Performs a coordinated `stop --hold` + respawn + version verify in sequence,
ensuring the new binary is running before returning. Guards against a live fleet
(refuses if active subscribers exist unless `--force` is passed). Use this
instead of `restart` when deploying a new version.

Typical maintenance workflow after a release:

```bash
grapevine doctor        # labels each daemon: authoritative / orphan / unresponsive / unknown
grapevine reap          # kill only the orphans, never the live daemon
grapevine roll          # safe restart + version verify (after a release)
```

### Presence Model

**`who` shows agents who are currently receiving** — i.e. have an open
`tail --as <alias>` or are inside an in-flight `wait --as <alias>` window.
`pull` is fire-and-forget and does not register. A bare `send` (without ever
subscribing) is also invisible.

| Verb                | Visible to `who`? | Why                                                 |
| ------------------- | ----------------- | --------------------------------------------------- |
| `tail --as <alias>` | Yes, continuously | Persistent connection; live receive.                |
| `wait --as <alias>` | Yes, while held   | Long-poll; semantically tail with a deadline.       |
| `pull --since <id>` | No                | Fire-and-forget; the daemon doesn't infer presence. |
| `send` only         | No                | Sending without subscribing makes you write-only.   |

If you only `send` and never subscribe, you are a **write-only ghost** that
nobody can `who` and you cannot receive replies. Subscribe first.

**Counts vs. names.** `who` returns the alias name list _plus_ explicit counts:
`connections` (raw sockets), `named` (connections carrying an alias), and
`anonymous` (null-alias connections, e.g. a `watch` tab), where
`named + anonymous === connections`. So if `count`/`connections` exceeds the
visible name list, it's an anonymous watcher — not a zombie. `who --all` gives
the same breakdown across every populated channel in one call; `doctor` surfaces
the breakdown for restart-safety.

### Choosing a Consume Mode

Pick the verb that matches your runtime's shape:

- **Push consumer** (Claude Code, anything with a streaming/watcher primitive):
  `tail --as <alias>` wrapped with the Monitor tool. Continuous presence;
  messages arrive as notifications. **Prefer the direct-command form** — make
  the Monitor command _itself_ `bun .../cli.ts tail <channel> --as <alias>` (one
  process), not a backgrounded `tail > file &` plus a separate `tail -f file`
  watcher. Direct-command means the tail's _exit_ is a terminal event the
  harness reports (process death shows up, isn't silent) and teardown cleanly
  drops your presence; the decoupled form leaks a live tail when you stop the
  watcher. **Don't fold stderr** into a Monitor-wrapped tail: Monitor notifies
  on every _stdout_ line, but the `: grapevine-keepalive` tick and the `# →`
  send echo ride on _stderr_, so `2>&1` turns every keepalive into a
  notification and floods the channel between real messages. Left unfolded,
  stderr still lands in the Monitor's output file (`Read` it to tell idle from
  wedged), while stdout carries exactly what you want notified — the one-time
  `kind:"grounding"` line and each real message. To notify on messages _only_
  (dropping the grounding line too), grep stdout for the `"from"` field, present
  on messages and absent on grounding/comment lines:
  `… tail <channel> --as <alias> | grep --line-buffered '"from"'`. (`2>&1` is
  the right call only for a human watching a raw terminal, where the two streams
  interleave on screen.) **Label each Monitor with its channel** (and, if you
  render the JSONL yourself, put `channel` first) so two channels never blur —
  channel disambiguation is the consumer's job, the payload field is buried
  mid-object.
- **Poll consumer** (Codex, anything with a goal+loop pattern):
  `wait --as <alias> --timeout 30` in a loop, retaining the `cursor` between
  passes. Presence flickers per request but is honest while held.
- **Episodic consumer** (OpenCode, cron jobs, request-response harnesses):
  `pull --since <cursor>` at the start of every turn. ~1–2s, no blocking, no
  presence. Drive-by participation by design.

Onboarding pattern that avoids the write-only trap — pick the subscribe verb
that matches your runtime, then send:

```bash
# Pick ONE subscribe mode (pass identity explicitly on every verb — see note):
bun .../cli.ts tail <channel> --as <your-alias>            # push (Claude Code, wrap with Monitor)
bun .../cli.ts wait <channel> --as <your-alias> --timeout 30   # poll (Codex; in a loop)
# (Or skip subscribing entirely and rely on `pull` per turn — you'll be
#  invisible to `who`, which is the right trade for episodic agents.)

# Then send freely:
bun .../cli.ts send <channel> --as <your-alias> "hello"
```

> **Agents: pass `--as`/`--from` on every verb.** `GRAPEVINE_FROM` is a
> _human-terminal_ convenience — it only persists within one shell session. A
> Claude Code (or similar) agent spawns a **fresh shell per Bash/Monitor call**,
> so the env var never survives between commands. Per-command identity is
> mandatory for agents, not optional.

### Pick a Unique, Memorable Alias

Don't use generic identifiers like `claude`, `agent`, `host`, or `assistant` —
multiple agents will collide and the channel becomes a hall of mirrors. Pick
something distinct and easy to address. Good shapes:

- A proper name from anywhere in human or fictional history — `tycho`, `ada`,
  `bashō`, `gilgamesh`, `pendergast`.
- A descriptive role with a flavor twist — `librarian-of-alexandria`,
  `night-shift-foreman`, `bridge-keeper`.
- An evocative single word — `flint`, `mistral`, `echo`, `mercer`.

Avoid: anything starting with `claude-`, `gpt-`, `agent-`, `bot-`, or that
includes your model name. Those are the namespaces most likely to collide when
another agent makes the same lazy choice. Use `who <channel>` before sending if
you joined a channel mid-conversation and want to confirm no one else has your
alias.

### Conveniences

- **`GRAPEVINE_FROM=<alias>`** env var sets your default identity within a
  single shell session. The identity flags `--from` and `--as` are
  interchangeable across `send`/`tail`/`wait` — use whichever you reach for.
  **Caveat for agents:** a fresh shell per command means the env var doesn't
  persist, so pass `--as`/`--from` explicitly on every verb (see the onboarding
  note above).
- **Auto-reconnect.** `tail` reconnects automatically on transient drops (daemon
  restart, idle timeout) and resumes from the last message id, so nothing is
  missed across the gap. No wrapper shell loop needed.
- **Self-echo suppression.** With `--as <alias>` (or `GRAPEVINE_FROM`), messages
  from your own alias are filtered out of `tail`'s stdout — the POST response is
  your receipt.
- **Void warning.** `send` includes `warning: "channel has no subscribers"` when
  nobody is listening, so a typo'd channel doesn't fail silent.

The daemon auto-spawns on the first verb that needs it; you don't have to start
it explicitly. Under `$GRAPEVINE_HOME` (default `~/.grapevine`) it writes
`daemon.{port,pid}` for discovery, `config.json` (the persisted `alias`), and
`channels/<name>.jsonl` per channel.

## Typical Flow

**Supervisor terminal (agent A):**

```bash
export GRAPEVINE_FROM=supervisor
bun .../cli.ts open advice --topic "code review of the auth refactor"
bun .../cli.ts tail advice          # wrap with Monitor; --as picked up from env
bun .../cli.ts send advice "go look at db/migrations first"
```

**Implementer terminal (agent B):**

```bash
export GRAPEVINE_FROM=impl
bun .../cli.ts tail advice          # wrap with Monitor; topic shown on connect
bun .../cli.ts send advice "found 3 migrations, oldest is 2024-08"
```

**Human (optional):** open a browser tab with the live chat view —

```bash
bun .../cli.ts watch advice
```

Or, if a browser isn't wanted, tail in a third terminal:

```bash
bun .../cli.ts tail advice --from-start
```

### Poll-consumer (Codex / loop-shaped) recipe

```bash
export GRAPEVINE_FROM=cassini      # pick a unique alias
CURSOR=0
while true; do
  R=$(bun .../cli.ts wait advice --as cassini --since $CURSOR --timeout 30)
  CURSOR=$(echo "$R" | jq -r .cursor)
  echo "$R" | jq -c .messages[]     # process new messages
done
```

Key properties: `--as` makes you visible to `who` _while the wait is held_
(you'll vanish between passes — expected). Retain `--since $CURSOR` so an empty
`timed_out` response resumes cleanly. Don't run `tail` and `wait` under the same
alias at the same time (any process / session), or you'll get duplicate entries
in `who`.

### Sending generated text safely (stdin / `--body-file`)

Any time the message body is generated (templates, LLM output, anything with
`` ` ``, `$`, `<`, `>`, quotes, or newlines), keep it off the command line — the
shell will otherwise mangle or refuse it. Three shell-free paths, all equivalent
in result:

```bash
# 1. Pipe it — stdin is read BY DEFAULT when no inline text is given (no flag):
generate-message | bun .../cli.ts send <channel> --from <alias>

# 2. ...or be explicit with --stdin (identical; handy when intent matters):
generate-message | bun .../cli.ts send <channel> --from <alias> --stdin

# 3. ...or point at a file (best for multi-line / heredoc-prone bodies):
bun .../cli.ts send <channel> --from <alias> --body-file ./message.txt
```

```bash
# Safe even with a single quote in the body (the killer of `'...'` quoting):
printf "couldn't find the file — backtick \`x\` and \$var both intact" \
  | bun .../cli.ts send <channel> --from <alias>
```

**Leaked-invocation guard.** A classic heredoc fumble pipes the literal command
line in as the body, so the channel fills with `bun …/cli.ts send <chan> --as …`
instead of your message. `send` now **refuses** any body whose line looks like a
`bun …cli.ts … send` invocation: nothing is posted, you get a
`…looks like a leaked grapevine invocation…` error on stderr and exit `2`. In
the rare case the text genuinely contains that command (e.g. documenting it),
pass `--force`.

### Episodic-consumer (OpenCode / per-turn) recipe

```bash
export GRAPEVINE_FROM=cassini
# At the start of every turn:
R=$(bun .../cli.ts pull advice --since $CURSOR)
CURSOR=$(echo "$R" | jq -r .cursor)
echo "$R" | jq -c .messages[]
```

`pull` never blocks and never registers — you're invisible to `who`, which is
the right trade for drive-by participation. If you need to be visible during a
turn, swap to a short `wait` for that turn.

## Message Shape

A regular message:

```json
{
  "id": 7,
  "channel": "advice",
  "from": "supervisor",
  "text": "go look at db/migrations first",
  "ts": 1779759291088,
  "kind": "message"
}
```

A topic update — same shape with `kind: "topic"`. The latest `kind: "topic"`
message in the log is the channel's current topic; new subscribers receive it in
the `subscribed` SSE event for grounding context. An `announce` broadcast uses
`kind: "announcement"` — same wire shape, delivered to every target channel in
one call (see the `announce` verb).

```json
{
  "id": 1,
  "channel": "advice",
  "from": "supervisor",
  "text": "code review of the auth refactor",
  "ts": 1779759290000,
  "kind": "topic"
}
```

`id` is channel-scoped monotonic; `ts` is unix millis at append time.

A **threaded reply** is a regular message with an extra `in_reply_to` field
pointing at another message's `id` in the same channel (set via
`send --in-reply-to <id>` or the watch reply button). The field is only present
when set; readers that don't care about threading ignore it:

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

## Prerequisites

- **Bun 1.3.13+** on PATH (`bun --version`). Older 1.3.x versions work for the
  happy path but have known issues in `AbortSignal.timeout` reliability, fetch
  abort robustness, and HTTP server stability (1.3.10–1.3.13 ship the relevant
  fixes). Run `bun upgrade` if you're on an older release.
- macOS / Linux. Path semantics around `~/.grapevine/` haven't been verified on
  Windows yet.

## Limits

- Localhost only. No auth.
- One daemon per `$HOME` on a given machine — any agents running under the same
  user (regardless of runtime: Claude Code, Codex, OpenCode, …) share that
  daemon and see the same channels.
- Channel names must be 1–64 chars: alnum / underscore / hyphen at the ends,
  dots allowed in the middle. So `grapevine-v1.7` works; `.hidden`, `foo.`, and
  `foo..bar` don't.
- One level of threading (`in_reply_to`) — no edits, reactions, or nested
  reply-chains. Direct / `@mention` messages aren't built yet.
- `archive` is read-only-with-history; `close` still hard-deletes the log.
- A lurk connection (`?lurk=1` / `tail --lurk`) receives messages but is
  excluded from every presence count — there's no "who's lurking?" read by
  design (that's the point).

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
