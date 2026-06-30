---
name: astrolabe
description:
  Astrolabe is a standing observatory board — one browser surface showing the
  live state of every project in flight, a level ABOVE grapevine (one team's
  channel) and bounty (one team's task board): the view ACROSS all of them. An
  agent registers a project, an agent tending it tunes in (presence lights the
  card), posts a current status, and flags "needs you" when blocked; the human
  pokes a card for a fresh update. Driven through a thin `cli.ts` over a
  persistent daemon. OPEN/OBSERVE triggers — "open the astrolabe / observatory",
  "raise the observatory", "show me everything in flight", "a board across my
  projects", "register this project on the board". TEND-A-PROJECT triggers —
  "tune this project in", "an agent joins / activates a project", "post a status
  to the observatory", "flag this for attention". NOT for one team's tasks
  (bounty), agent-to-agent chat (grapevine), or anything needing auth /
  cross-machine reach (localhost only).
---

# Astrolabe — a Standing Observatory for Projects in Flight

One board that shows the live state of every project you have going at once.
Where **grapevine** is a channel for one agent team and **bounty** is one team's
task board, the **astrolabe** is the higher-altitude window _across_ all of
them: glance at it instead of polling each terminal. Its lean is **observation
with the door open** — a window onto work the agents are doing underneath, where
you step in when a card flags that it needs you and dive into the real terminal
for anything detailed.

It's a **conjuration**: a persistent daemon holds the canonical state and the
board stands until you dismiss it. Canonical state in one daemon, an
agent-facing `cli.ts` over HTTP, the human's board over a WebSocket.

## When to Use

- You're running several projects in parallel and the context-switching tax —
  jumping across terminals, grapevines, and bounty boards to check "what's
  moving, what's blocked, what needs me?" — is the pain.
- An agent wants a sanctioned way to pull you in only when a decision is needed,
  rather than you over-polling or it working silently past a fork.
- You want one glanceable surface for the higher-level state of everything, with
  the detail still living in each project's own terminal/spell.

Not for: one team's tasks (use **bounty**), agent-to-agent messaging (use
**grapevine**), or anything needing authentication or cross-machine reach —
astrolabe is localhost-only, no auth.

## Prerequisite

`server.ts` (the daemon) and `cli.ts` run under [Bun](https://bun.sh) — assume
the user has `bun` on their PATH. If `bun` is missing the Bash call fails fast
with `command not found: bun`; surface that and stop. Don't try to install it.

The board is a **Bun-bundled React surface** (Tailwind v4), bundled lazily on
the first request — so the **first `open` can lag a few seconds** while it
builds (the cli returns as soon as the daemon binds, not when the bundle is
ready; the browser tab fills in once it lands). Later opens are instant.

## Two roles

The spell turns on keeping two lifecycles separate:

1. **Register a project** — _durable, infrequent._ Adds a persistent card (name,
   path, description, avatar). You mostly seed a batch up front and rarely touch
   it again. Reachable from an agent inside the project, an agent anywhere ("go
   register this path"), or the board's **+ Add** form.
2. **Tend a project** — _live, frequent._ An agent **tunes in** to an
   already-registered project, which flips its card to **active**, then posts
   status and raises/clears the attention flag. This is the everyday motion.

The human's part is to **watch the board** and **poke** a card when it's gone
quiet. That's it — the door stays open, you step through when it matters.

## Drive it with `cli.ts`

The agent never talks to the daemon directly — it drives through `cli.ts`, a
thin, stateless wrapper. The daemon is a **singleton per machine**
(`$ASTROLABE_HOME`, default `~/.astrolabe`); the first verb that needs it
auto-spawns it (detached, it outlives the CLI) and finds it via
`$ASTROLABE_HOME/daemon.port`.

### Verbs

| Verb                                                                                | What it does                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli.ts open [--no-open]`                                                           | Ensure the observatory daemon is up and open the board in the browser.                                                                                                                                                                                                                       |
| `cli.ts add <name> --path <p> [--description ..] [--avatar ..] [--id ..] [--stdin]` | Register a project (durable). Dedupe-guarded on name/path. The daemon derives the `id` (a lowercase, hyphenated slug of the name) and a seeded `avatar` when you don't pass them, and **echoes the derived `id` in the response** — you'll need it for `join`/`status`/`attention`/`remove`. |
| `cli.ts join <id> [--as <name>]`                                                    | Tune a project in: hold this open (wrap with **Monitor**) — it lights the card **active** and delivers **pokes**. The listening loop a project's agent runs.                                                                                                                                 |
| `cli.ts status <id> <summary...> [--phase ..] [--stdin]`                            | Replace the project's current status (no history — the card always shows the present).                                                                                                                                                                                                       |
| `cli.ts attention <id> [--clear] [--question ...]`                                  | Raise (or `--clear`) the "needs you" flag — the agent→human gate.                                                                                                                                                                                                                            |
| `cli.ts poke <id>`                                                                  | Ask the project's tending agent for a fresh status (human→agent). Usually the board's **Nudge** button.                                                                                                                                                                                      |
| `cli.ts state`                                                                      | Read the board back — project cards projected from the three layers.                                                                                                                                                                                                                         |
| `cli.ts list`                                                                       | The registered projects, compact.                                                                                                                                                                                                                                                            |
| `cli.ts remove <id>`                                                                | Unregister a project (durable).                                                                                                                                                                                                                                                              |
| `cli.ts tail [--since N] [--as <name>]`                                             | Unscoped event tail as JSONL (no presence). Note: `--since 0` (or no cursor) replays the **entire event backlog** first, so a cold tail can read like a burst of churn — pass a recent cursor for live-only.                                                                                 |
| `cli.ts close` / `info` / `help`                                                    | Dismiss the observatory · daemon status · usage.                                                                                                                                                                                                                                             |

Identity (`--as` / `--from`, or `$ASTROLABE_AS`) stamps the actor on events and
suppresses self-echo. `--stdin` reads a description/summary from stdin so
shell-special characters land verbatim. `cli.ts help` prints the full list.

### Read back, don't infer

After a write, confirm it with `cli.ts state` rather than assuming — the daemon
is canonical, and `state` returns the cards exactly as the surface renders them
(presence, status, the zone). A rejected command (a dedupe collision, an unknown
id) prints the reason to **stderr** and exits non-zero, so a failed write is
never silent. (`state` also carries a `cursor` — the event resume point for a
`tail`/`join --since`; ignorable for one-shot reads.)

The one exception to read-back: right after `cli.ts close`, `info`/`state` can
briefly still report the daemon up while it flushes and tears down (~half a
second). Don't treat a single post-close read as authoritative — it settles.

### Tend a project — `join`, wrapped with Monitor

A card is **active** only while an agent is _connected and watching_. That
presence is the live connection: `cli.ts join <id>` opens a scoped event stream
that lights the card the moment it connects and idles it when it drops. Hold it
open by wrapping it with the **Monitor** tool — the same stream delivers
**poke** events (the human asking for a fresh status); respond by posting one
with `cli.ts status`. To take a project offline, just **end the join**
(terminate the process) — there's no separate leave verb; the card idles on
disconnect.

Discipline (house pattern): the structured payload and events ride **stdout**
(one JSON line each); only diagnostics and an occasional keepalive go to
**stderr** — never merge the two under Monitor.

### The board — what the human sees

Three zones, calm by default (the literal `zone` value `state` reports is in
parens):

- **Needs you** (`attention`) — cards an agent has flagged, floated to the top
  with the question shown. The browser tab title and favicon carry a `● (N)` dot
  so the nudge lands even on another tab.
- **Active** (`active`) — projects with an agent connected and working; current
  status + phase.
- **Quiet** (collapsible) — `idle` and `stale` cards, muted. The _silence_ of
  the quiet board is the signal; only a card that needs you carries saturated
  color.

Each card shows the project avatar, a status chip, the agent-connected presence,
a relative timestamp, and a **Nudge** button (a poke). The **+ Add** button
opens the registration form.

## Exit Code Contract

`0` clean dismiss (the human closes the board, or an agent `cli.ts close`) · `2`
bad arguments or a rejected command (dedupe / unknown id) · `124` idle timeout
(only if a positive `--timeout` was set — the observatory stands indefinitely by
default). A conjuration has no "cancel"/`130` discard path.

## Limits

- Localhost only, no auth. One daemon per `$ASTROLABE_HOME`.
- Status is **current-only** — each post replaces the last; there's no history
  (a scoped, resettable work-session feed is a deliberate future, not the MVP).
- Presence and status are **live** — a restarted daemon restores the durable
  registry but starts every card disconnected and status-less until agents
  rejoin and re-post.

## Feedback touchpoint

At a natural close, surface friction so the tool improves. **Agent:** if a verb
misbehaved or an event shape fought you, file a GitHub issue against the
**Spellbook** repo (`github.com/ichabodcole/spellbook`). **Human:** when you're
on the board, an easy-to-skip offer — "anything about the astrolabe itself feel
off or worth improving?" — and route what they say to the same issues. This is
feedback about the _tool_, not the projects on it.
