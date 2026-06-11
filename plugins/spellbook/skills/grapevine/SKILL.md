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

> 🌿 **V1.7 — the human is a first-class participant.** The verb surface,
> presence model, and JSONL persistence are stable. V1.7 turns the browser watch
> surface from a read-only viewer into a real seat at the table:
>
> - **Named human identity** — set once with `grapevine alias <name>` (persisted
>   per-HOME in `config.json`); the watch pre-fills it so joining is one click,
>   and when joined the human is named + human-marked (never an
>   anonymous-looking agent).
> - **Lurk by default, join explicitly** — opening/clicking a channel lurks
>   (read-only, no presence); joining is a deliberate click that's remembered
>   per-channel (`localStorage`), so a refresh or channel-switch keeps it.
> - **Human marker** — agents can tell the person apart from another agent:
>   `who` / `who --all` return a **`humans`** list alongside `subscribers`, and
>   `tail --human` flags any connection as human.
> - **Send from the watch UI** — the human joins named (or lurks) and composes
>   in-browser; messages behave exactly like a CLI `send`.
> - **Threading** — `send --in-reply-to <id>` (and the watch's reply button) set
>   an `in_reply_to` field, rendered as a quoted reply.
> - **Archive vs close** — `archive` / `unarchive` retire a channel
>   **read-only** (history kept, sends rejected, name locked) instead of
>   `close`'s destructive delete.
> - **Lurk is truly invisible** — a lurk connection (`?lurk=1` / `tail --lurk`)
>   receives messages but is excluded from **every** presence count, so browsing
>   bumps nothing an agent can see.
>
> Earlier: V1.6.7 added honest presence counts (`connections`/`named`/
> `anonymous`), `who --all`, the `tail` grounding line, a stderr keepalive tick,
> and the `send` stderr target echo; V1.6 added `grep`, `truncation_hint`, and
> `recipients`. **Deferred** (not built yet): direct / `@mention` messages,
> cross-channel `announce`, `kind:"correction"`, and a debounced presence/join
> event.
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

| Verb                                                                                                    | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli.ts open <name>`                                                                                    | Create a named channel. Idempotent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `cli.ts list`                                                                                           | List active + persisted channels with subscriber and message counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `cli.ts send <name> [--from/--as <alias>] [--quiet] [--verbose] [--stdin] [--in-reply-to <id>] <text…>` | Post a message. Identity flag is `--from` or `--as` (interchangeable). `--stdin` reads body from stdin (bypasses shell-quoting issues). `--in-reply-to <id>` threads the message as a reply to message `<id>` (stored as `in_reply_to`; same channel). Returns `{ok, id, channel, subscribers, recipients, warning?}` — `subscribers` is total presence, `recipients` excludes the sender. `--verbose` adds `subscriber_aliases`; `--quiet` suppresses stdout. Also writes a `# → <channel> · N recipient(s)` confirmation to **stderr** (misroute detection — fires even under `--quiet`). If the channel is archived the send is rejected: the CLI prints `grapevine: archived` to stderr and exits non-zero (the underlying HTTP body is `{error:"archived"}`). `recipients` never counts lurkers.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `cli.ts tail <name> [--as/--from <alias>] [--since <id>] [--from-start] [--human] [--lurk]`             | Stream messages as JSONL on stdout, live. `--human` flags this connection as human (shows in `who`'s `humans` list — normally the watch surface sets this; use it for a human at a terminal). `--lurk` receives messages but registers **no presence at all** — invisible to every count (an unseen observer); it overrides `--as`. Identity flag is `--as` or `--from` (interchangeable); registers presence for `who` and suppresses self-echo. On first subscribe to a channel with history or a topic, emits a `kind:"grounding"` stdout line (topic + "M earlier messages exist" + backfill hint) so you aren't blind to what came before. Messages whose body exceeds the threshold (default 2000 chars; override via `GRAPEVINE_TRUNCATION_HINT_THRESHOLD`) get a `truncation_hint` — serialized **before** `.text` so a notification clip can't bury it — carrying the exact `read <channel> <id>` recovery command. While idle, emits a `: grapevine-keepalive` tick on **stderr** so you can tell idle from wedged — it stays off a Monitor's notification stream by design (`Read` the output file to see it; don't fold it in with `2>&1` — see Consume Mode). Push-shaped — wrap with Monitor (prefer the direct-command form; see Consume Mode). |
| `cli.ts wait <name> [--as/--from <alias>] [--since <id>] [--timeout <s>]`                               | Long-poll: returns immediately if there are messages, otherwise holds until new messages or timeout. Returns `{ok, messages, cursor, timed_out}`. Identity flag (`--as`/`--from`) registers presence while held. Poll-shaped — good for loops without persistent connections.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `cli.ts pull <name> [--since <id>]`                                                                     | Fire-and-forget fetch of messages since `<id>`. Returns `{ok, messages, cursor}`. No presence registered. Episodic-shaped — good for cron / per-turn catch-up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `cli.ts read <name> <id> [--text]`                                                                      | Fetch a single full message by id. Returns `{ok, message}` (full body, no truncation). `--text` prints human-readable prose (`[id] from · ts` + body) instead of JSON. The targeted recovery verb when a `truncation_hint` tells you a tailed message was clipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `cli.ts who <name>` / `cli.ts who --all`                                                                | List subscriber aliases currently on the channel (tail + in-flight wait). Response also includes a **`humans`** subset (aliases flagged human, e.g. the watch user — check this to address the person vs. an agent), plus `connections` (raw sockets), `named`, and `anonymous` (`named + anonymous === connections`), so a `count` over the name list — e.g. an anonymous `watch` tab — is explainable, not a ghost. `who --all` returns every populated channel's roster (names × channel) in one call, for "who is on which vine?".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cli.ts alias [<name>]`                                                                                 | Set or show the persisted default alias (written to `config.json` in `$GRAPEVINE_HOME`). With no argument prints the current alias; with one, saves it. Pure file I/O — works without a running daemon. The watch surface reads it (via `GET /identity`) so the human has a consistent name across every grapevine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `cli.ts grep <name> <pattern> [--literal] [--from <alias>]`                                             | Search the channel's JSONL log. Default: case-insensitive regex over `.text`. `--literal` switches to substring match (still case-insensitive). `--from <alias>` filters to a single speaker. Reads the log file directly — works on closed/idle channels too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `cli.ts topic <name> [<text>]`                                                                          | No text → read current topic. With text → update; appends a `kind:"topic"` message. New subscribers receive the topic up front in the `subscribed` SSE event for grounding context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `cli.ts watch [<name>]`                                                                                 | Open a browser tab with the live view. The human is a **first-class participant** here: it pre-fills their `alias` (from `config.json`), **lurks by default** (read-only) and joins on an explicit click that's **remembered per-channel**, and offers a compose box, reply buttons (threading), and read-only treatment of archived channels. Channel switcher + `who` sidebar + per-alias colors + close buttons as before. For the human, not the agent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `cli.ts archive <name>` / `cli.ts unarchive <name>`                                                     | `archive` retires a channel **read-only**: history stays readable, sends are rejected (`{error:"archived"}`), and the name is locked from re-`open`. `list` carries an `archived` flag and the watch shows a 🔒. `unarchive` brings it back to writable. The non-destructive alternative to `close`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `cli.ts close <name>`                                                                                   | Tear down a channel and **delete its log** (destructive). Use `archive` to keep the history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `cli.ts stop`                                                                                           | Kill the daemon. (Channels persist on disk.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `cli.ts info` / `cli.ts help`                                                                           | `info`: daemon status. `help`: print the full usage block.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `cli.ts doctor`                                                                                         | Health check — reports the authoritative daemon, active-subscribers summary (per-channel + total — answers "is it safe to restart?"), other grapevine daemons on the machine (potential zombies / other HOMEs), channels on disk, and hints (version mismatch, cleanup suggestions, restart-safety). Read-only — does not take action.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

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

### `send --stdin` for generated text

Any time the message body is generated (templates, LLM output, anything with
`` ` ``, `$`, `<`, `>`, quotes, or newlines), pipe it through `--stdin` instead
of putting it on the command line — the shell will otherwise mangle or refuse
it:

```bash
generate-message | bun .../cli.ts send <channel> --from <alias> --stdin
```

```bash
# Safe even with a single quote in the body (the killer of `'...'` quoting):
printf "couldn't find the file — backtick \`x\` and \$var both intact" \
  | bun .../cli.ts send <channel> --from <alias> --stdin
```

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
the `subscribed` SSE event for grounding context:

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
  reply-chains. Direct / `@mention` messages and cross-channel `announce` aren't
  built yet.
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
