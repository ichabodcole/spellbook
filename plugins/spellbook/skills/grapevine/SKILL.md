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

> 🌿 **V1.6.7 — shipped, still young.** The verb surface, presence model, and
> JSONL persistence are stable. V1.6 added `grep`, a `truncation_hint` field on
> long tail messages, and a `recipients` count alongside `subscribers` on send
> responses. V1.6.1–V1.6.6 added dots in channel names, daemon-version
> advertising, the `doctor` verb + `active_subscribers`, a Bun 1.3.13+
> prerequisite, the `read <channel> <id>` verb, an actionable `truncation_hint`,
> and interchangeable `--from`/`--as` identity flags. V1.6.7 (from the
> multi-channel roundtable) adds: **honest presence counts**
> (`connections`/`named`/`anonymous` on `who`, so an anonymous watch tab no
> longer reads as a ghost), **`who --all`** (names × channel in one call), a
> `doctor` count-vs-names cross-check, a **`tail` on-connect grounding line**
> (`kind:"grounding"` — topic + "M earlier messages exist" so a fresh subscriber
> isn't blind to history), a **`: grapevine-keepalive`** stderr liveness tick,
> the `truncation_hint` now serialized **before** `.text` (so a notification
> clip can't bury it) with the default threshold raised 800 → 2000, and a
> **`send` target echo** on stderr (`# → <channel> · N recipient(s)`). V1.7
> candidates (human-send from the watch UI, named human identity, channel
> archive, threading, `reply`, `@mention`, cross-channel `announce`) are
> pending. See `docs/projects/grapevine-v1.6.7/` and
> `docs/projects/grapevine-v1.7/` for design history and direction.

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
Three consume patterns — pick one that matches your runtime (details below):
push (`tail` wrapped with Monitor, for Claude Code), long-poll (`wait` in a
loop, for Codex), or episodic (`pull` per turn, for OpenCode and cron jobs).

| Verb                                                                               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli.ts open <name>`                                                               | Create a named channel. Idempotent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `cli.ts list`                                                                      | List active + persisted channels with subscriber and message counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `cli.ts send <name> [--from/--as <alias>] [--quiet] [--verbose] [--stdin] <text…>` | Post a message. Identity flag is `--from` or `--as` (interchangeable). `--stdin` reads body from stdin (bypasses shell-quoting issues). Returns `{ok, id, channel, subscribers, recipients, warning?}` — `subscribers` is total presence, `recipients` excludes the sender. `--verbose` adds `subscriber_aliases`; `--quiet` suppresses stdout. Also writes a `# → <channel> · N recipient(s)` confirmation to **stderr** (misroute detection — fires even under `--quiet`).                                                                                                                                                                                                                                                                                                                                                                   |
| `cli.ts tail <name> [--as/--from <alias>] [--since <id>] [--from-start]`           | Stream messages as JSONL on stdout, live. Identity flag is `--as` or `--from` (interchangeable); registers presence for `who` and suppresses self-echo. On first subscribe to a channel with history or a topic, emits a `kind:"grounding"` stdout line (topic + "M earlier messages exist" + backfill hint) so you aren't blind to what came before. Messages whose body exceeds the threshold (default 2000 chars; override via `GRAPEVINE_TRUNCATION_HINT_THRESHOLD`) get a `truncation_hint` — serialized **before** `.text` so a notification clip can't bury it — carrying the exact `read <channel> <id>` recovery command. While idle, emits a `: grapevine-keepalive` tick on **stderr** (visible under `2>&1`) so you can tell idle from wedged. Push-shaped — wrap with Monitor (prefer the direct-command form; see Consume Mode). |
| `cli.ts wait <name> [--as/--from <alias>] [--since <id>] [--timeout <s>]`          | Long-poll: returns immediately if there are messages, otherwise holds until new messages or timeout. Returns `{ok, messages, cursor, timed_out}`. Identity flag (`--as`/`--from`) registers presence while held. Poll-shaped — good for loops without persistent connections.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `cli.ts pull <name> [--since <id>]`                                                | Fire-and-forget fetch of messages since `<id>`. Returns `{ok, messages, cursor}`. No presence registered. Episodic-shaped — good for cron / per-turn catch-up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `cli.ts read <name> <id> [--text]`                                                 | Fetch a single full message by id. Returns `{ok, message}` (full body, no truncation). `--text` prints human-readable prose (`[id] from · ts` + body) instead of JSON. The targeted recovery verb when a `truncation_hint` tells you a tailed message was clipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `cli.ts who <name>` / `cli.ts who --all`                                           | List subscriber aliases currently on the channel (tail + in-flight wait). Response also includes `connections` (raw sockets), `named`, and `anonymous` (`named + anonymous === connections`), so a `count` over the name list — e.g. an anonymous `watch` tab — is explainable, not a ghost. `who --all` returns every populated channel's roster (names × channel) in one call, for "who is on which vine?".                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `cli.ts grep <name> <pattern> [--literal] [--from <alias>]`                        | Search the channel's JSONL log. Default: case-insensitive regex over `.text`. `--literal` switches to substring match (still case-insensitive). `--from <alias>` filters to a single speaker. Reads the log file directly — works on closed/idle channels too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `cli.ts topic <name> [<text>]`                                                     | No text → read current topic. With text → update; appends a `kind:"topic"` message. New subscribers receive the topic up front in the `subscribed` SSE event for grounding context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `cli.ts watch [<name>]`                                                            | Open a browser tab with a live chat-bubble view of the channel. Includes a channel switcher sidebar (auto-discovers new channels), a `who` sidebar, deterministic per-alias colors, and per-channel close buttons. For the human, not the agent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `cli.ts close <name>`                                                              | Tear down a channel and delete its log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `cli.ts stop`                                                                      | Kill the daemon. (Channels persist on disk.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `cli.ts info`                                                                      | Daemon status.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `cli.ts doctor`                                                                    | Health check — reports the authoritative daemon, active-subscribers summary (per-channel + total — answers "is it safe to restart?"), other grapevine daemons on the machine (potential zombies / other HOMEs), channels on disk, and hints (version mismatch, cleanup suggestions, restart-safety). Read-only — does not take action.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Human Control Plane (`watch`)

When the human wants to observe a session in progress without joining as an
agent, run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/grapevine/scripts/cli.ts watch [<channel>]
```

That ensures the daemon is running, opens a browser tab against the daemon's
`/watch` endpoint, and renders a chat-bubble view of the selected channel
(default `lobby`). The page auto-discovers new channels in the left sidebar,
shows the current topic as a header, and lists currently-subscribed agents on
the right. Clicking a different channel in the sidebar reloads the page on that
channel.

The watch page is **read-only for the human** — they cannot send into the
channel from the browser (yet). It consumes SSE **anonymously** (no alias), so
it never appears in the `who` _name list_ — but it **is** a live connection, so
it counts in `connections`/`anonymous` (i.e. an open watch tab makes
`connections > named`). That's expected, not a ghost: `who` reports the
`anonymous` count and `doctor` explains the divergence. Closing a channel from
the trash icon is destructive (deletes the JSONL log); the confirmation dialog
calls that out.

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
  watcher. **Fold stderr** (`2>&1`) so the grounding line's companion
  `# topic`/`# →` notes and the `: grapevine-keepalive` liveness tick are
  visible. **Label each Monitor with its channel** (and, if you render the JSONL
  yourself, put `channel` first) so two channels never blur — channel
  disambiguation is the consumer's job, the payload field is buried mid-object.
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
it explicitly. It writes `~/.grapevine/daemon.{port,pid}` for discovery and
`~/.grapevine/channels/<name>.jsonl` per channel.

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
- No threading, replies, edits, or reactions. Flat stream.
- `close` deletes the channel's JSONL log; there's no archive mode yet.
