---
name: bounty
description:
  Bounty is a duplex agent↔user task board in the browser. Agent posts tasks;
  user drags between todo/doing/review/done columns, edits titles inline, adds
  or deletes tasks, or closes the board to end the session. The Review column is
  a soft verification gate — the agent parks finished work there (rather than
  Done) when it needs a second set of eyes (human or agent) a passing test can't
  give. The agent drives the board through a thin `cli.ts` over a persistent
  daemon — `open` to spawn it, `state` to read back, `tail` (wrapped with
  Monitor) to react to user actions live. Multiple agents can share one board
  via join.ts. HOST trigger phrases — "open a task board", "spin up a bounty",
  "give me a board to track this", or obvious variants. JOIN trigger phrases —
  "join my bounty", "connect to the bounty", "the board is at <URL or id>", or
  obvious variants. Also propose when the agent has produced 5+ discrete TODOs
  the user might want as a workspace. Do NOT use for single tasks, narrative
  todos that aren't trackable, or anything the user wants in chat. Requires Bun
  on PATH.
---

# Bounty Board

A duplex agent ↔ user surface — woolly mammoth mascot, warm brown + ice blue
palette. Woolly mammoth puns are welcome where they fit naturally.

An agent posts a list of tasks into a browser board; the user interacts with it
(drags tasks between columns, edits titles inline, adds, deletes, closes the
board) and both sides receive updates in real time.

Bounty follows the **house agent-interface pattern** shared with grapevine and
imago: a **persistent daemon** holds the canonical state, and the agent drives
it through a thin **`cli.ts`** over HTTP —

- `cli.ts open` spawns the daemon (it survives the CLI process) and opens the
  user's browser to the board,
- `cli.ts state` reads the board back (`{ state, cursor }`) — confirm a command
  applied without parsing HTML,
- `cli.ts tail` streams user actions as JSONL (wrap with the **Monitor** tool to
  react live, in a fresh turn per event),
- `cli.ts add` / `update` / `remove` / `message` / `init` / `close` drive it.

The browser talks to the daemon over WebSocket; a second agent can join the same
board with `join.ts`. Same canonical state under all of them.

## The columns — and the review gate

The board has four columns: **To do → Doing → Review → Done**. Review is a
verification gate, and the principle is simply: **get a second set of eyes on
work before it counts as done.** _Who_ reviews — and _whether_ a task needs a
review at all — is a judgment call you make per task:

- **Park a finished task in Review** (not Done) when it wants another look first
  — UI/UX changes, anything that needs a manual smoke test, behavior that
  passing tests don't fully capture, or simply work that someone other than the
  author should confirm. The reviewer drags it to Done, or back to Doing if it
  needs more work.
- **The reviewer can be a human _or_ an agent.** Sometimes a human is the right
  judge ("does this UX feel right?"); sometimes the managing/lead agent
  merge-verifies; sometimes you assign a peer agent — or yourself — to review.
  Decide per task who's best placed to catch what a passing test can't. You can
  **assign the review explicitly with `--owner`** (hand it to the human, a peer
  agent, or yourself), so "you've been asked to review this" is itself a board
  signal that lands in the reviewer's lane.
- **Move straight to Done** when automated checks already cover it — pure
  functional changes or refactors where green tests are sufficient evidence. Not
  everything needs a review pass; routing trivially-verified work through Review
  just adds friction.

The gate is a **convention, not enforced** — the daemon accepts any status
transition from any participant. Let the task guide you: if it wants a human's
eye or a peer's review, route through Review and (optionally) assign the
reviewer; if green tests settle it, Done is fine. When genuinely unsure, prefer
Review — a cheap second look beats a missed regression. A `message` toast is a
good way to flag what you've put up for review and why.

## When to Use

**Host mode** — fire on phrases like "task board", "bounty", "open a board",
"spin up a board to track this", or any obvious variant.

**Join mode** — fire on phrases like "join my bounty", "join the bounty",
"connect to the bounty", "the board is at <URL>", "the session id is <id>", or
any obvious variant. The user is in a separate terminal / agent session from the
one that opened the board.

Drive the board live or one-shot — same daemon either way. The board is a
conjuration: it **stands until dismissed**. You see every change live (via
`tail`) or read `state` whenever you want — there's no "submit to flush" step.
If the user will finish in one sitting, `open` it, let them work, and read
`state` when they're done. If the board is long-lived and you want to react as
the user works, wrap `cli.ts tail` with Monitor so each action wakes a fresh
turn. When in doubt, propose: _"want a quick board, or one I'll keep watching as
you work?"_

**Heads up:** the daemon stays alive **even if the user closes the browser
tab.** Sessions end only when the human clicks **Close board**, you
`cli.ts close`, or the idle timeout fires (default 30 min). Agent activity
(`cli.ts state`/writes) resets the idle timer, so a board you're actively
driving won't expire mid-work — but a board you opened and walked away from sits
until the timer fires. Closing is non-destructive: canonical state is
snapshotted, so a closed board reopens with `cli.ts open --restore`.

Suggested invocation (propose first, don't fire): the agent has produced 5+
discrete TODOs **AND** the user is going to actually manipulate them (reorder,
prioritize, mark done as they work, add their own). Example:

> "I've got six discrete tasks from this session. Want me to spin up a bounty so
> you can drag them around as you work through them?"

**Don't propose bounty for memory-aid TODOs the user just needs to see listed**
— the chat-native TODO tracker is better for that. The bar is "the user wants a
workspace they manipulate," not "the agent has a list."

Don't use for:

- A single task or short narrative todo — chat is fine.
- "Tasks" that are really one big amorphous thing (e.g. "refactor everything") —
  break it down first, then maybe a board.
- A passive list the user will only read, not edit — chat or memory is fine.
- Anything the user explicitly said they want in chat.

## Prerequisite

`server.ts` (the daemon) and `cli.ts` run under [Bun](https://bun.sh) — assume
the user has `bun` on their PATH (it's the runtime this skill commits to). If
`bun` is missing, the Bash call fails fast with `command not found: bun`;
surface that to the user and stop. Don't try to install Bun for them.

## Host Mode — Drive the Board with `cli.ts`

The agent never talks to the daemon directly — it drives through `cli.ts`, a
thin, stateless wrapper. `open` spawns a detached daemon that holds the
canonical state and outlives the CLI process; every other verb is a one-shot
HTTP round-trip against it.

```bash
CLI=${CLAUDE_PLUGIN_ROOT}/skills/bounty/scripts/cli.ts
bun $CLI open --title "Refactor sprint" --timeout 1800   # spawn daemon + open browser
bun $CLI add "wire up the auth route" --status doing
bun $CLI state                                           # read board back
bun $CLI close                                           # end the session (exit 0)
```

`open` prints the session JSON (`{url, port, session_id, title}`) and writes
discovery files to `<tmpdir>/bounty-<session_id>.json` + `bounty-latest.json`,
so joiners and later verbs find the board. Every verb targets the most recent
session by default; pass `--session <id>` to target a specific one.

> **Heads up on `$CLAUDE_PLUGIN_ROOT`.** It resolves to the plugin's install
> path in Claude Code. If it's unset in your shell (some harnesses leave it
> empty), substitute the absolute path
> `plugins/spellbook/skills/bounty/scripts/...` relative to the repo root. An
> empty value silently turns `${VAR}/skills/...` into `/skills/...` and
> `bun run` fails with a confusing "module not found."

### Verbs

| Verb                                                                     | Does                                                                                   |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `open [--title T] [--timeout S] [--no-open] [--restore <id>]`            | spawn the daemon (or resume a saved session); print session JSON                       |
| `state [--full] [--owner <name> \| --mine] [--as <name>]`                | read-back `{ state, cursor }` — confirm a command applied; scope like `tail`           |
| `tail [--since N] [--owner <name> \| --mine] [--as <name>]`              | stream board events as JSONL (wrap with Monitor); scope to an owner; resumes `--since` |
| `add <title…> [--status S] [--notes N] [--owner N] [--id ID] [--stdin]`  | add a task (optionally assigned)                                                       |
| `update <id> [--status S] [--title T] [--notes N] [--owner N] [--stdin]` | patch a task (`--owner` assigns/reassigns)                                             |
| `claim <id> [--as <name>]`                                               | self-claim an **unowned** task (rejected if owned by another)                          |
| `block <id> --on <id>[,…]` / `unblock <id> --on <id>[,…]`                | add / remove blocker edges (block is cycle-guarded; rejection is visible)              |
| `remove <id>`                                                            | delete a task                                                                          |
| `message <text…> [--stdin]`                                              | transient toast on the board                                                           |
| `init [--title T] [--stdin-tasks]`                                       | seed the board (tasks = JSON array on stdin)                                           |
| `close` / `info` / `sessions` / `help`                                   | end session / show session / list snapshots / usage                                    |

**`--stdin` defeats shell quoting.** For any free text with apostrophes, quotes,
`&`, `<`, `>`, or `$`, pipe it through `--stdin` (which reads the title
verbatim) instead of putting it on the command line — the shell will otherwise
mangle it:

```bash
printf "it's a \"quoted\" & <urgent> task" | bun $CLI add --stdin --status doing
```

`init --stdin-tasks` seeds a whole board the same way — pipe a JSON array of
tasks on stdin (no shell-escaping, no inline-script seed dance):

```bash
echo '[{"id":"t1","title":"first","status":"todo"}]' | bun $CLI init --title Sprint --stdin-tasks
```

### Read-back, not inference

`cli.ts state` returns `{ state, cursor }` — the canonical board plus the
current event cursor. After any write, read `state` to **confirm it applied**;
you never have to render HTML or infer from the event stream. `cursor` is the
resume point you hand to `tail --since <cursor>`.

**Scope it like `tail`.** On a shared board, `state --mine --as <you>` (or
`--owner <name>`) filters the read-back to your own + claimable tasks — the
snapshot path scopes the same way the live path does, so orienting isn't a
firehose.

**Each task carries computed blocked-ness.** The `state` response adds derived,
read-only fields per task: `blocked` (bool) and `liveBlockers` — the not-done
blockers as `[{id, title, status}]`. So you see the same `⛔` signal the human's
surface shows, and a task that's been filtered down by `--mine` stays
**actionable**: its blocker may be owned by someone else (and thus absent from
your filtered view), but `liveBlockers` still tells you what you're waiting on
and its status — no unfiltered re-query. (These are derived at read time; the
stored task only carries the raw `blockedBy` ids.)

**Tip: use `message` toasts liberally.** A `cli.ts message "…"` renders a
transient toast on the board — good for acknowledging user actions ("nice — that
one's done"), signaling what you're doing ("starting on this now"), or flagging
what you parked in Review and why. Toasts don't mutate state; keep them to one
short sentence (they auto-dismiss).

### Live boards — wrap `tail` with Monitor

For a long-lived board you react to as the user works, wrap `cli.ts tail` with
the **Monitor** tool. Each user action arrives as a JSONL line on stdout that
wakes you into a fresh turn; the keepalive tick + diagnostics ride **stderr** —
don't merge them (`2>&1`), or every keepalive becomes a spurious notification.

```
Monitor({
  description: "bounty events for <short purpose>",
  persistent: true,
  timeout_ms: 3600000,
  command: "bun ${CLAUDE_PLUGIN_ROOT}/skills/bounty/scripts/cli.ts tail --since 0"
})
```

`tail` reconnects automatically on a transient drop and resumes from the last
event id, so nothing is missed across the gap. When a notification arrives,
react by issuing a `cli.ts update` / `message` (or nothing if it's not
interesting), then end the turn — the Monitor stays armed. The `closed` frame
ends the tail (exit 0); `TaskStop` the Monitor when you see it.

### Event frames

Each `tail` frame is `{ id, type, …, by }`:

- `id` — monotonic event cursor (the resume point for `--since`).
- `by` — the actor: `"user"` (browser action), an agent's `--as` identity (a
  `cli.ts` write; `"agent"` if none given), `"system"` (lifecycle). Cooperative
  attribution, not auth.
- task-bearing frames carry the task identifier as **`taskId`** (the envelope
  `id` is the cursor, so the task id can't be named `id`) and the task's
  **`owner`** at the moment of the event (for client-side scope filtering);
  `task.add` nests the full `task` object.

```
{id, type:"ready",        url, port, session_id, by:"system"}
{id, type:"connected" | "disconnected", by:"user"}
{id, type:"task.toggle",  taskId, status, by, owner}     // pill click
{id, type:"task.move",    taskId, status, index, by, owner}  // drag-drop
{id, type:"task.edit",    taskId, title, by, owner}      // inline title edit
{id, type:"task.add",     task, by, owner}               // task added
{id, type:"task.update",  taskId, patch, by, owner}      // agent patch
{id, type:"task.remove",  taskId, by, owner}             // task deleted
{id, type:"unblocked",    taskId, owner, by:"system"}    // last blocker cleared (owner-scoped)
{id, type:"closed",       reason, by:"system"}           // session ended (reason: user|timeout|close)
```

The board mutations + `closed` are the actionable ones; `ready` / `connected` /
`disconnected` are lifecycle noise you can usually ignore. Events are **not
commands** — by the time you see one, the daemon has already applied it; you're
being informed. Read `cli.ts state` when you want the full truth.

### Task shape

```ts
type Task = {
  id: string; // any unique string (you choose the scheme; cli.ts auto-generates if omitted)
  title: string;
  status: "todo" | "doing" | "review" | "done";
  notes?: string; // optional, shown under the title
  owner?: string; // optional assignee — shown as an @name badge; drives scoped tails
  blockedBy?: string[]; // ids this task waits on (set via block/unblock); drives the blocked cue + unblocked event
};
```

### Flags (`open`)

- `--title TEXT` — board/tab title (default `"Bounty Board"`)
- `--timeout SECONDS` — idle timeout (default `1800` / 30 min). Resets on any
  agent or browser activity.
- `--no-open` — don't auto-open the browser; useful in headless / SSH setups.
- `--port N` — bind specific port (default: random free port).
- `--host HOST` — bind host (default `127.0.0.1`).
- `--id SLUG` — stable session id. Auto-generated as `bounty-<rand>-p<port>` if
  omitted (the `-p<port>` suffix encodes the bound port for session-recovery
  semantics matching digestify).
- `--restore <id>` — resume a saved board (see Durability below).

### Durability

The daemon debounce-snapshots the board to
`$BOUNTY_HOME/snapshots/<session_id>.json` (default `$BOUNTY_HOME` is
`~/.bounty`) ~1s after any change, and writes a final snapshot on close — kept,
not deleted, so it's a resume point. Combined with idle-touch (every `cli.ts`
verb resets the idle timer), a board you're actively driving survives long
stretches and a restart.

- `cli.ts sessions` lists saved snapshots (id · task count · title).
- `cli.ts open --restore <id>` brings a saved board back. The snapshot is merged
  over defaults (old snapshots gain new fields cleanly) and its tasks are run
  through the same `validateTask` boundary, so a malformed or legacy entry is
  dropped rather than fatal — the rest of the board restores.

The restored daemon gets a **new** session id (and writes its own snapshot on
close); the snapshot you restored from is left intact.

### Ownership & scoping (multi-agent)

When several agents share a board (a lead + workers), `owner` + scoped tails
keep each worker's wake-set small instead of every event waking everyone.

- **Identity.** Pass `--as <name>` (or set `$BOUNTY_AS`) on your verbs. It
  stamps the event `by`, and drives `claim` + `--mine`. It's cooperative
  attribution, **not** auth — agents self-assert it; don't treat `by`/`owner` as
  a security boundary.
- **Assign (lead).** `cli.ts add <title> --owner <name>` or
  `cli.ts update <id> --owner <name>`. Assignment-first is the primary path;
  `update --owner` is also the **reassignment** path and always wins.
- **Self-claim (worker).** `cli.ts claim <id> --as <name>` takes an **unowned**
  task. A claim on a task someone else owns is **rejected** (stderr notice +
  non-zero exit) — never a silent steal; claiming your own task is a no-op
  success. (Reassignment is the lead's job via `update --owner`.)
- **Scoped tail.** `cli.ts tail --owner <name>` wakes only on that owner's
  tasks; `cli.ts tail --mine --as <name>` wakes on your own **plus claimable
  (unowned)** tasks. Lifecycle frames (`ready`/`closed`/…) always pass.
  Filtering is client-side in the CLI — the `# scoped to …` notice rides
  **stderr**.
- **Self-echo suppression.** A scoped tail drops frames your own `--as` identity
  caused, so you don't wake on your own writes (applied after the scope filter).
- **`review` is the handoff cue.** Moving a task to **Review** is a status
  change on an owned task — whoever's reviewing sees it: the human on the
  **surface** (the Review column), the lead on an **unfiltered** tail, and an
  assigned reviewer on their **scoped** tail (assign the review with `--owner`
  and it lands in their lane). No special event; the board _is_ the signal
  (board = state, chat = substance).

> **Ownership-transfer wake (by design).** An event frame carries the task's
> owner **at the moment it happened** (post-change). So when a task is
> reassigned A→B (or a worker claims an unowned task), only the **new** owner's
> scoped tail wakes — the **previous** owner A is _not_ board-woken that the
> task left their lane. That's intentional: the board reflects new state, A sees
> it on their next `cli.ts state`, and the reassigning lead conveys the _why_
> over chat. Don't rely on the board to notify a former owner.

### Multi-agent task-state ownership — who moves a card when

Ownership (above) says _which_ tasks are yours; this is the _lifecycle_ — who
slides a card across columns, and when. The rule that holds up under real
multi-agent load: **the doer owns task-state.**

- **Lead = dispatcher + reviewer.** Create the task, set `--owner`, and **leave
  it in To do** — then hand it off over the back-channel (chat / grapevine).
  Don't move it to Doing _for_ the worker: that records only _your_ intent (you
  assume someone's on it), not whether anyone actually picked it up, so the
  board fills with "Doing" cards nobody's working and you end up babysitting it.
- **Owner moves its own card.** When you _actually start_, move your card **To
  do → Doing** — that's the "I've taken this" signal the lead sees on `tail`.
  When it's done and green, move it **Doing → Review** and post what you
  parked + how to verify.
- **Reviewer closes.** Review means a second set of eyes — a human glance, the
  lead's merge-verify, or a peer agent you assign the review to (`--owner`).
  Whoever reviews moves **Review → Done**, or bounces it back to **Doing** for
  rework — the owner sees the bounce and picks it up.

Why it holds: **Doing** becomes a trustworthy "genuinely being worked" signal
instead of the lead's guess, the lead stops puppeteering the board, and the
owner stays in the loop on acceptance vs. rework. It layers on the Review-gate +
ownership/scoping above — those say _where the gate is_ and _whose lane it is_;
this says _who slides the card_. (Validated across a long multi-agent build —
the workers adopted it cleanly, even self-creating cards for work they picked
up.)

### Dependencies (blocking)

A task can declare what it's **blocked on** — the board's one real edge over a
flat list.

- **Set edges:** `cli.ts block <id> --on <id>[,<id>…]` adds blockers;
  `cli.ts unblock <id> --on <id>[,…]` removes them. (`blockedBy` is mutated
  **only** through these — a raw `update` can't set it, so the cycle guard
  always runs.)
- **Cycle guard:** a `block` that would create a self-reference or a cycle
  (direct or transitive) is **rejected** (stderr + non-zero exit, like a
  rejected claim) — the board can't wedge.
- **`unblocked` event:** when a task's **last** live blocker clears — the last
  blocker reaches `done`, _or_ its last blocking edge is removed — the daemon
  fires `{type:"unblocked", taskId, owner}` to the task's owner. It's in the
  wake-set (owner-scoped, so an `--owner`/`--mine` tail catches it), fires
  **once** on the blocked→unblocked transition, and never fires for a task
  that's already `done`. A blocker is "live" only if it still exists and isn't
  done — a deleted or done blocker doesn't block.
  - **A blocker must reach `done` — not `review` — to unblock dependents.**
    Review is the verification gate (the blocker isn't finished yet), so a
    blocker parked in Review keeps its dependents blocked until a reviewer moves
    it to Done. If you park a blocker in Review and its dependent stays stuck,
    that's why — flag the review for whoever's reviewing (`message`) rather than
    waiting.
- **Surface cue:** a blocked task shows `⛔ blocked by N` and is visually
  de-emphasized. It's a **convention, not a lock** — the board still lets anyone
  move a blocked task (same soft-gate spirit as Review). The cue counts down
  live as blockers clear.

## Exit Code Contract

| Code | Reason (the `closed` event's `reason` field) | What to do                                                                            |
| ---- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| 0    | `user`                                       | The human clicked **Close board**. Clean dismiss — state is snapshotted (restorable). |
| 0    | `close`                                      | You sent `cli.ts close` — clean shutdown you initiated.                               |
| 2    | (no reason — fails before session starts)    | Bad CLI args or port bind failure. stderr explains; fix args and retry.               |
| 124  | `timeout`                                    | Idle timeout fired. Tell the user the session expired; offer to relaunch/restore.     |

A board dismiss is always a **clean exit 0** — there's no "discard" path anymore
(the old `cancel`/130). The board holds canonical state and snapshots it, so any
ending is non-destructive and reopenable with `cli.ts open --restore`.

The session-ending outcome (a clean exit 0, or 124 on idle timeout) belongs to
the **daemon** and surfaces to the agent via the `closed` event's `reason` on
the tail. `cli.ts` itself exits `2` on bad args and `0` on a successful verb
(and `tail` exits `0` on the `closed` frame). One more: a **cooperatively
rejected** verb — `claim` on an other-owned task, or `block` that would form a
cycle — exits **`1`** (with the reason on stderr), distinct from `2` (bad args).
So `claim`/`block` exiting non-zero means "the daemon refused this," not "you
called it wrong" — check stderr and adjust, don't retry verbatim.

## Join Mode — Connect to an Existing Board

Another agent is already hosting a board (browser tab is open somewhere) and the
user wants you to participate. You'll spawn `join.ts` instead of `server.ts`; it
opens a WebSocket to the daemon and bridges it to its own stdio.

### How it works

1. **Find the board.** Three discovery paths, in order of explicitness:
   - User gave you a session id → `--id <session_id>`
   - User gave you a full URL → `--url <url>`
   - User said "just join the latest one" or didn't specify → omit both;
     `join.ts` reads `<tmpdir>/bounty-latest.json`.

   If discovery fails (no file, no host running at that URL), `join.ts` exits 2
   with a clear stderr message. Surface it to the user and ask for an explicit
   `--url` or `--id`.

2. **Spawn the joiner.** It opens the WebSocket and stays connected.

   ```bash
   bun run ${CLAUDE_PLUGIN_ROOT}/skills/bounty/scripts/join.ts \
     --id <session_id>          # or --url <url>, or no args for "latest"
   ```

3. **Wait for the `joined` event** on stdout — that's the handshake, with the
   current title and tasks.

4. **Write task.add / task.move / task.edit / task.remove to stdin** to act on
   the shared board. Read `event` lines from stdout to see everyone else's
   actions (host agent, user, other joiners). The board state stays in sync
   across all participants automatically.

5. **Disconnect by sending `{"type":"close"}`** on stdin, or just let the host
   close the session (you'll get a `disconnected` event with reason
   `server_closed`).

### Join protocol — Agent → join.ts (stdin, one JSON line per message)

```
{"type":"task.add",    "task": Task}              // append a new task
{"type":"task.toggle", "id": "...", "status": "todo|doing|review|done"}  // change status
{"type":"task.move",   "id": "...", "status": "...", "index": N}  // status + position
{"type":"task.edit",   "id": "...", "title": "..."}   // change the title
{"type":"task.remove", "id": "..."}
{"type":"close"}                                  // disconnect cleanly
```

These are the **WebSocket** verbs (the same ones the browser sends) — a joiner
is a browser-equivalent participant. Note there's no `task.update` over WS: use
the granular `task.toggle` (status) / `task.edit` (title) / `task.move` (drag)
instead. Joiners also CAN'T push toasts (`message`) or reset state (`init`) —
those are agent-`/cmd`-only; the daemon ignores them over WS.

### Join protocol — join.ts → agent (stdout, one JSON line per message)

> **⚠ Wrapping asymmetry.** The joiner's stdout wraps every incoming broadcast
> as `{"type":"event", "payload":{...}}`. Only the bookend handshakes (`joined`,
> `disconnected`) are bare. If you're copying handler logic from the
> `cli.ts tail` side, you'll need an unwrap step:
>
> ```ts
> if (line.type === "event")
>   handle(line.payload); // joiner side
> else if (line.type === "task.toggle") handle(line); // tail side
> ```

```
{"type":"joined",       "url":"...", "session_id":"...", "title":"...",
                        "tasks": Task[]}          // initial handshake
{"type":"event",        "payload": {...}}         // any WS broadcast:
                                                  //   init | task.add |
                                                  //   task.update |
                                                  //   task.remove |
                                                  //   message
{"type":"disconnected", "reason":"server_closed|stdin_close|timeout|error"}
```

**Session end is uniform.** When the board ends (the human dismisses it, the
host agent closes it, or the idle timer fires), every participant — joiners
included — receives a `message` payload of `session ended: <reason>` and then a
`disconnected` as the daemon tears down. There's no separate submit/cancel
signal anymore: the daemon held canonical state live the whole time (and
snapshotted it), so there's no "final state" to flush or "discard" to honor.
Treat `disconnected` as the end; the board is restorable via
`cli.ts open --restore` regardless of who ended it.

### Join exit codes

| Code | Meaning                                            | What to do                                  |
| ---- | -------------------------------------------------- | ------------------------------------------- |
| 0    | Clean disconnect (server closed or agent closed)   | Normal — tell the user the session is done  |
| 2    | Bad args, no discovery file, or connection refused | Ask the user for an explicit `--url`/`--id` |

### Join example

```bash
# User: "join my bounty"
# You (in a second terminal / agent session):
bun run ${CLAUDE_PLUGIN_ROOT}/skills/bounty/scripts/join.ts
# → reads <tmpdir>/bounty-latest.json
# → emits {"type":"joined", "session_id":"bounty-abc...", "tasks":[...]}
# Now write JSON-lines to its stdin to act on the board.
```

## Pattern Notes

- **The daemon is source of truth.** It holds the canonical task list and
  broadcasts updates to all WS clients (browser + joiners). Conflicting
  concurrent edits resolve to whoever's message arrived first.
- **Events are not commands.** When you receive a `tail` frame (host) or an
  `event` with a `task.*` payload (joiner), the daemon has already applied it.
  You're just being informed — read `cli.ts state` for the authoritative board.
- **`init` resets the list.** Use `add` / `update` / `remove` for incremental
  changes once the board is live; don't re-`init` mid-session or you'll blow
  away the user's in-progress edits.
- **`message` is a toast, not a chat replacement** — host-only, use sparingly.
- **Joiners are downstream.** They see every broadcast — including echoes of
  their own actions. Filter those out if duplicates would be a problem (match on
  the id of an action you just sent).

## Common Pitfalls

- **Use `--stdin` for any free text with shell metacharacters.** Titles or notes
  containing apostrophes, quotes, `&`, `<`, `>`, or `$` get mangled (or refused)
  by the shell if passed as a positional argument. Pipe them through `--stdin`
  instead — it reads the body verbatim, defeating the quoting problem that used
  to require an inline-script seed dance.
- **Read `state` to confirm, don't assume.** A `cli.ts add`/`update` returns
  `{ok:true, sent:…}` — that's a transport ack, not proof the daemon applied
  your intent. When it matters, follow with `cli.ts state` and check the board.
- **Don't merge tail's stderr into stdout.** Monitor notifies on every stdout
  line; the keepalive tick + diagnostics ride stderr by design. `2>&1` turns
  every keepalive into a spurious notification. Leave them split.
- **TaskStop the Monitor when the session ends.** When you see the `closed`
  frame, `TaskStop` the Monitor's task id before continuing. Otherwise the watch
  keeps running against a closed daemon until it times out.
- **The daemon outlives the browser tab.** Closing the tab doesn't end the
  session — only the human's **Close board**, your `cli.ts close`, or the idle
  timeout does. If you opened a board and the user wandered off, it sits until
  the timer fires.
