---
name: bounty
description:
  Bounty is a duplex agent↔user task board in the browser. The agent posts
  tasks; the user drags them between todo/doing/review/done, edits titles
  inline, adds or deletes tasks, or closes the board. Review is a soft
  verification gate — park finished work there when it needs a second set of
  eyes (human or agent) that a passing test can't give. The agent drives the
  board through a thin `cli.ts` over a persistent daemon — `open` to spawn it,
  `state` to read it back, `tail` (wrapped with Monitor) to react to user
  actions live — and several agents can share one board. HOST trigger phrases —
  "open a task board", "spin up a bounty", "give me a board to track this", or
  obvious variants. JOIN trigger phrases — "join my bounty", "connect to the
  bounty", "the board is at <URL or id>", or obvious variants. Also propose it
  when the agent has produced 5+ discrete TODOs the user will want to
  manipulate. Do NOT use for single tasks, narrative todos that aren't
  trackable, a list the user only needs to read, or anything the user wants in
  chat. Requires Bun on PATH.
---

# Bounty Board

A duplex agent ↔ user surface — woolly mammoth mascot, warm brown + ice blue
palette. Woolly mammoth puns are welcome where they fit naturally.

An agent posts tasks into a browser board; the user drags, edits, adds, deletes
and closes; both sides see every change live. Bounty follows the house
agent-interface pattern shared with grapevine: a **persistent daemon** holds the
canonical board, and the agent drives it through a thin, stateless **`cli.ts`**
over HTTP. The browser talks to the same daemon over WebSocket, and a second
agent can join with `join.ts`.

## When to use

**Host mode** — "task board", "bounty", "open a board", "spin up a board to
track this", or any obvious variant.

**Join mode** — "join my bounty", "connect to the bounty", "the board is at
<URL>", "the session id is <id>". Another terminal or agent opened the board.

**Propose, don't fire**, when you have 5+ discrete TODOs **and** the user will
actually manipulate them (reorder, prioritise, mark done, add their own):

> "I've got six discrete tasks from this session. Want me to spin up a bounty so
> you can drag them around as you work through them?"

Don't use it for:

- a single task or a short narrative todo — chat is fine;
- one big amorphous "task" — break it down first, then maybe a board;
- a list the user will only read — the chat-native TODO tracker is better;
- anything the user said they want in chat.

The board is a conjuration: it **stands until dismissed**, and there is no
"submit" step. For a one-sitting job, `open` it, let the user work, and read
`state` when they're done. For a long-lived board you react to, wrap `tail` with
Monitor. When unsure, ask: _"want a quick board, or one I'll keep watching as
you work?"_

## The columns — and the review gate

**To do → Doing → Review → Done.** Review means _get a second set of eyes before
it counts as done_; who reviews, and whether a task needs it, is your call per
task:

- **Park it in Review** when it wants another look — UI/UX, a manual smoke test,
  behaviour tests don't capture, or work someone other than the author should
  confirm. The reviewer moves it to Done, or back to Doing for rework.
- **The reviewer can be a human or an agent** — the user, the lead agent, a
  peer, or you. Assign the review with `--owner` so it lands in that reviewer's
  lane.
- **Go straight to Done** when green tests are sufficient evidence (pure
  refactors, functional changes the suite covers).

The gate is a convention: the daemon accepts any transition from anyone. When
genuinely unsure, prefer Review, and post a `message` toast saying what you
parked and how to verify it.

## Prerequisite

`cli.ts`, the daemon and `join.ts` run under [Bun](https://bun.sh). If `bun` is
missing the call fails with `command not found: bun`; tell the user and stop.
Don't install Bun for them.

## Host mode — drive the board with `cli.ts`

```bash
CLI=${CLAUDE_PLUGIN_ROOT}/skills/bounty/scripts/cli.ts
bun $CLI open --title "Refactor sprint" --timeout 1800   # spawn daemon + open browser
bun $CLI add "wire up the auth route" --status doing
bun $CLI state                                           # read board back
bun $CLI close                                           # end the session (exit 0)
```

> If `$CLAUDE_PLUGIN_ROOT` is unset in your shell, use the absolute path to this
> skill's own `scripts/cli.ts` (it sits next to this `SKILL.md`). An empty value
> turns `${VAR}/skills/...` into `/skills/...`, and `bun` fails with "module not
> found".

`open` prints the session JSON (`url`, `port`, `session_id`, `title`, plus the
restore and backup fields below) and writes `<tmpdir>/bounty-<session_id>.json`
and `bounty-latest.json`, which joiners and later verbs use to find the board.

### Which board a verb targets

By default a verb targets the **most recently opened** board. When more than one
board may be open on the machine (another project, another team), pin it, or
your verbs silently land on the other board. Precedence, highest first:

`--session-key <key>` · `--session <id>` · `$BOUNTY_SESSION_KEY` ·
`$BOUNTY_SESSION` · a `.bounty-session` file found by walking up from the cwd ·
the latest board.

- `open --pin` writes `.bounty-session` into the cwd, so every later verb run
  from that directory tree targets this board.
- **`--session-key <key>` is a handle you choose.** It derives a stable,
  project-scoped id (`k-<key>-<hash of the repo root>`): the same key in the
  same repo (any subdirectory) is the same board, and in another repo a
  different one. Every verb re-derives it, so nothing has to be stored.
  - `open --session-key K` is **idempotent**: it attaches to K's live board, or
    respawns a dead one under the same id with its snapshot restored. Racing
    `open`s converge on one daemon. `--fresh` tears K's board down and starts
    clean.
  - A team coordinator runs `open --session-key <team>` once and passes
    `--session-key <team>` on every seat's command — no wrong-board writes.
  - `--title`, `--timeout` and `--restore` only take effect when a daemon is
    spawned. On the attach path `open` **refuses with exit 2** rather than
    dropping them, printing the live board's JSON on **stdout** with
    `restoreSkipped: {requested, reason}`. It is the one refusal that is not an
    error envelope, because the payload answers "then where is my board?".

### Verbs

**Each verb accepts only the flags on its row**, plus `--session <id>` and
`--session-key <key>` on every verb that talks to a board and `--as <name>` on
those that act on it. A flag from another verb, or a flag before the verb, is
refused (exit 2) with the accepted set in `error.choices`.
`bun $CLI help <verb>` shows one verb in full.

| Verb                                                                                                                  | Does                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `open [--title T] [--timeout S] [--no-open] [--restore <id>] [--pin] [--session-key <key> [--fresh]]`                 | spawn the daemon (or resume a saved board) and print the session JSON                                                         |
| `state [--owner <name> \| --mine]`                                                                                    | read the board back (see Read-back); `--full` is accepted but is already the default                                          |
| `tail [--since N] [--once] [--owner <name> \| --mine]`                                                                | stream board events as JSONL — wrap with Monitor                                                                              |
| `add <title…> [--status S] [--notes N] [--owner N] [--tag a,b] [--size S\|M\|L] [--expect <min>] [--id ID] [--stdin]` | add a task; the id is minted unless you give `--id`                                                                           |
| `update <id> [--status S] [--title T] [--notes N \| --clear-notes] [--owner N] [--tag a,b] [--size …] [--expect …]`   | patch a task (also `--stdin` for the title); `--owner` reassigns, `--tag ""` clears the tags                                  |
| `claim <id>`                                                                                                          | take an **unowned** task as `--as <name>`                                                                                     |
| `block <id> --on <id>[,…]` / `unblock <id> --on <id>[,…]`                                                             | add / remove blocker edges (see Dependencies)                                                                                 |
| `remove <id>`                                                                                                         | delete a task                                                                                                                 |
| `message <text…> [--stdin]`                                                                                           | a transient toast on the board                                                                                                |
| `init [--title T] [--stdin-tasks [--replace]]`                                                                        | seed the board from a JSON array on stdin; each task needs `id`, `title` and `status`                                         |
| `close` / `info`                                                                                                      | end the board (its snapshot is kept) / show the resolved board's session JSON                                                 |
| `list` / `sessions`                                                                                                   | prose lists: the **running** boards / the saved **snapshots** you can restore (closed boards and backups included)            |
| `version` / `schema` / `help [verb]`                                                                                  | `{name, version}` (also `--version`, `-V`) / the machine-readable interface (acc declaration v0) / usage, or one verb in full |

Every verb but `list`, `sessions` and `help` prints one JSON document on stdout
(`tail`: one per event). A bare `bounty` is a usage error, not help.

`--status` takes only `todo`, `doing`, `review` or `done`; anything else is
refused before anything is written. A bad `--size` or `--expect` is different:
it is ignored and reported in the reply's `valuesIgnored` (and on stderr), so a
typo can't set a bogus size.

**Free text with shell metacharacters goes through `--stdin`.** Apostrophes,
quotes, `&`, `<`, `>` and `$` get mangled on the command line:

```bash
printf "it's a \"quoted\" & <urgent> task" | bun $CLI add --stdin --status doing
```

`--stdin` **replaces the verb's positional argument**: the title on `add`, the
text on `message` — and on `update`, whose only positional is `<id>`, the new
**title**, never the notes. Passing both a positional and `--stdin` is refused.
For notes with metacharacters, build the value in a variable or a quoted heredoc
and pass `--notes "$NOTES"`.

`update` never blanks a field you didn't ask it to. An empty `--title`, an empty
`--notes` (it can't be told from a substitution that produced nothing) and an
empty `--stdin` are all refused; clear notes on purpose with `--clear-notes`.
Each refusal names its fix. The reply names what it wrote, so check it:

```bash
bun $CLI update t-abc --notes "$(cat notes.md)"   # {"ok":true,"updated":"t-abc","fields":["notes"],"valuesIgnored":null}
```

A no-op answers `noop: true` with `fields: []`.

**`--` ends flag parsing, and every flag must come before it.** Anything after
`--` is text, even if it looks like a flag: `add -- "fix the --stdin handler"`.
On `add` and `message` a flag-shaped word after `--` becomes part of the text,
with a `# warning:` line on stderr. **So `add -- --session-key K "text"` writes
to whatever board the environment resolves to, with `--session-key K` in the
title.** Write `add --session-key K -- "text"`.

**Seeding.** `init --stdin-tasks` replaces the board's tasks, so over a board
that already has tasks it is refused (exit 6) unless you add `--replace`; the
reply then counts what it discarded as `tasksReplaced`. Entries it could not
seed are listed in `tasksDropped`. To add to a live board, use `add`; don't
re-`init` mid-session over the user's edits.

```bash
echo '[{"id":"t1","title":"first","status":"todo"}]' | bun $CLI init --title Sprint --stdin-tasks
```

### Read-back, not inference

`state` returns `{ state, cursor, … }`: the canonical board and the event cursor
(the resume point for `tail --since`). You never render HTML or replay events to
know the board.

- **A write confirms itself.** `add`, `update`, `claim`, `block`/`unblock`,
  `remove`, `message` and `close` exit 0 with their result on stdout, or refuse
  with exit 5/6 and an envelope on stderr whose `error.server` carries the
  daemon's own `applied: false` reply. You don't need `state` to check that a
  write landed.
- **Scope it like `tail`.** On a shared board, `state --mine --as <you>` (or
  `--owner <name>`) returns your tasks plus the unowned, claimable ones.
- **Blocked-ness is computed for you.** Each task carries `blocked` and
  `liveBlockers` (`[{id, title, status}]` for blockers not yet done), even when
  the blocker itself is filtered out of a scoped read.
- `snapshotBackedUp`, `restoreFailed`, `restoreDropped` and `snapshotSaveFailed`
  are always present, and `null` or `[]` when nothing happened. See Durability.

**Use `message` toasts liberally** — one short sentence to acknowledge an action
("nice — that one's done"), say what you're starting, or flag what you parked in
Review. They change no state and auto-dismiss.

### Live boards — wrap `tail` with Monitor

Each user action arrives as one JSONL line on stdout and wakes you into a fresh
turn. The keepalive tick and diagnostics ride **stderr**: don't merge them with
`2>&1`, or every keepalive becomes a notification.

```
Monitor({
  description: "bounty events for <short purpose>",
  timeout_ms: 1800000,
  command: "bun ${CLAUDE_PLUGIN_ROOT}/skills/bounty/scripts/cli.ts tail --session <id>"
})
```

A fresh `tail` replays the board's event log from the start; `--since <id>`
resumes after an id you've already handled. `tail` reconnects by itself after a
transient drop. When a notification arrives, react (`update`, `message`, or
nothing) and end the turn; the Monitor stays armed. The `closed` frame ends the
tail with exit 0.

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
names the forms it accepts; fix the arguments to match.

**Pin a long-lived tail.** Pass `--session <id>` (or `--session-key`). An
unpinned tail pins itself to the first board it resolves
(`# pinned to session <id>` on stderr), so a board opened later can't hijack it.

**When the board isn't up yet**, each retry line on stderr names the id it is
looking for and where the id came from (a key's id depends on the directory you
run in, so this is how you spot the wrong cwd). A tail you named with
`--session` or `--session-key` gives up after about 8 s with exit 5; an unnamed
one keeps waiting. A named tail for a board that has already closed here ends at
once with `tail.closed`, whose `command` brings it back.

### Event frames

Each frame is `{ id, type, …, by }`. `id` is the cursor; `by` is `"user"` (the
browser), an agent's `--as` name (`"agent"` if none), or `"system"`. Task frames
carry the task as `taskId` plus its `owner` at that moment; `task.add` nests the
whole `task`.

```
{id, type:"ready",        url, port, session_id, by:"system"}
{     type:"connected" | "disconnected", by:"user"}   // live only — no id, never replayed
{id, type:"task.toggle",  taskId, status, by, owner}     // pill click
{id, type:"task.move",    taskId, status, index, by, owner}  // drag-drop
{id, type:"task.edit",    taskId, title, by, owner}      // inline title edit
{id, type:"task.add",     task, by, owner}               // task added
{id, type:"task.update",  taskId, patch, by, owner}      // agent patch
{id, type:"task.remove",  taskId, by, owner}             // task deleted
{id, type:"unblocked",    taskId, owner, by:"system"}    // last blocker cleared (owner-scoped)
{id, type:"heartbeat",    taskId, owner, overdueByMs, expectedMinutes, by:"system"}  // Doing task overran (owner-scoped)
{id, type:"closed",       reason, by:"system"}           // session ended (reason: user|timeout|close)
```

The task frames and `closed` are the actionable ones. **Events are not
commands**: the daemon has already applied what you see. Read `state` when you
want the whole truth.

### Task shape

```ts
type Task = {
  id: string; // unique; `add` mints one if you don't pass --id
  title: string;
  status: "todo" | "doing" | "review" | "done";
  notes?: string; // shown under the title, editable in the detail modal
  owner?: string; // assignee — an @name badge; drives scoped tails
  tags?: string[]; // labels (set with --tag)
  size?: "S" | "M" | "L"; // expected 5 / 10 / 20 minutes; drives the heartbeat
  expect?: number; // explicit expected minutes; overrides size
  blockedBy?: string[]; // set only through block/unblock
  enteredStatusAt?: number; // server-stamped, read-only
  statusHistory?: { status: string; at: number }[]; // server-stamped, read-only
};
```

## Lifetime and durability

- **`--timeout SECONDS`** (default `7200`, two hours) is how long the board
  lingers **after its last subscriber leaves** — a browser tab or a tail keeps
  it open, and any agent verb resets the countdown.
- **Closing the browser tab doesn't end the board.** Only the user's **Close
  board**, your `close`, or the idle timeout does.
- **Nothing is lost on close.** The daemon snapshots the board to
  `$BOUNTY_HOME/snapshots/<session_id>.json` (`$BOUNTY_HOME` defaults to
  `~/.bounty`) about a second after each change and on close. `sessions` lists
  what can be restored; `open --restore <id>` brings a board back under a new id
  (a keyed board keeps its key's id). A `--restore` naming no snapshot is
  refused, exit 5, and starts nothing.
- **A task the restore can't keep** (a shape from another bounty version, a
  duplicate id) is dropped and named in `restoreDropped`; the rest of the board
  restores. `restoreFailed: {path, reason}` means the snapshot exists but can't
  be read: the board comes up empty and the snapshot is the damaged thing.
  `restoreSkipped` is different — the restore was never attempted (see the
  attach refusal) and your command line is what to fix.

**Backups are named on the act that made them.** Before the daemon writes a
smaller board over a bigger snapshot, or over a file it didn't fully read, it
copies the snapshot aside. Every `open` and `close` reply carries
`snapshotBackups`: `[]` when nothing was backed up, otherwise
`[{ kind, path, taskCount, reason, restore }]`, where `restore` is the command
that brings that copy back (`null` for a copy that needs repair, or a dump that
a later save superseded). Run it with your launcher, like any printed command.
The copies also show in `sessions`.

> **⚠ Recover from the backup with the highest `taskCount`, not the newest
> timestamp.** Backups are never pruned, so a later empty one can sit beside the
> good one.

**If the snapshot can't be written**, the board is never dropped: each failed
write dumps it to an `<id>.unsaved-<ts>.json` file, and `state` reports
`snapshotSaveFailed` with the real error and a `fix`. `close` then exits 6 with
the dump's path and its `open --restore` command. If nothing at all is writable,
the board refuses to end (your `close`, the user's Close board and the idle
timeout are all held) until a save succeeds. A SIGTERM or SIGINT still stops it.

## Multi-agent boards

When several agents share a board, ownership and scoped tails keep each worker's
wake-set small.

- **Identity.** Pass `--as <name>` (or set `$BOUNTY_AS`) on your verbs. It
  stamps `by`, and drives `claim` and `--mine`. It is cooperative attribution,
  not auth.
- **Assign** with `add … --owner <name>` or `update <id> --owner <name>` (also
  the reassignment path). **Self-claim** an unowned task with
  `claim <id> --as <name>`; a claim on someone else's task is refused (exit 6),
  never a silent steal.
- **Scoped tail.** `tail --owner <name>` wakes only on that owner's tasks;
  `tail --mine --as <name>` on yours plus the unowned ones. Lifecycle frames
  always pass, and a tail run with `--as` drops the frames you caused. A frame
  carries the owner **after** the change, so on a reassignment only the new
  owner wakes; tell the previous owner over chat.

**The doer owns task-state.**

- **Lead = dispatcher + reviewer.** Create the task, set `--owner`, leave it in
  To do, and hand it off over the back-channel (chat, grapevine). Don't move it
  to Doing for the worker — that records your guess, not their start.
- **Owner moves its own card**: To do → Doing when it actually starts, Doing →
  Review when it's done and green, with a note on how to verify.
- **Reviewer closes**: Review → Done, or back to Doing for rework.

### Dependencies

- `block <id> --on <id>[,…]` adds blockers; `unblock` removes them. `blockedBy`
  changes only through these, so the cycle guard always runs: a self-reference
  or a cycle is refused (exit 6), and a `--on` naming a task the board doesn't
  have is refused (exit 5).
- When a task's last live blocker clears, its owner gets one `unblocked` event.
  **A blocker must reach Done, not Review**, to unblock its dependents; if you
  park a blocker in Review, flag it to the reviewer.
- The board shows `⛔ blocked by N` and de-emphasises the card, but anyone can
  still move it.

### Heartbeat — a nudge when a Doing task overruns

- **Opt in per task** with `--size S|M|L` (5 / 10 / 20 minutes) or
  `--expect <minutes>`. An unsized task is not watched. There is no XL on
  purpose: a task you'd size bigger should be broken down.
- When a Doing task overruns, its owner gets a `heartbeat` event and the board
  shows a toast; it re-pokes once per expected period until the card leaves
  Doing. An unowned task gets the toast only.
- **A blocked card is never poked.** If you're waiting on a peer, model it as
  `block <id> --on <peer-task>` and the nag goes quiet until the peer is done.
- Size long work honestly (`--size L` or a real `--expect`), or leave it
  unsized.
- **You only hear it if you're tailing.** Keep a standing `tail --mine` on your
  board; a worker living only on grapevine is board-blind.

### What the human sees

The board also shows, with no verb involved: a dimming "⏱ Doing Nm · over" badge
on an overrunning card; a soft "wrap one before pulling more" nudge when one
owner has 2+ cards in Doing; and a per-browser filter bar by tag and owner.

## Exit codes

Every `cli.ts` failure is **one JSON envelope on stderr**, with stdout empty:
`{"ok":false,"error":{"kind","exit_code","retryable","message",…},"meta":{"command"}}`.
Route on the exit code and `error.kind`, not the message. Where the daemon
refused, its reply is under `error.server`.

| Code | `kind`      | Means                         | Typical cause                                                                                                                                                                                      |
| ---- | ----------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | —           | success                       | `tail` also exits 0 on the `closed` frame                                                                                                                                                          |
| 2    | `usage`     | fix the command               | a bad or misplaced flag, a missing argument, an empty `update`, a bad `--status`                                                                                                                   |
| 5    | `not_found` | the named thing doesn't exist | no running board; a task id the board doesn't have; a named `tail` whose board never came up; `open --restore` of a missing snapshot                                                               |
| 6    | `conflict`  | a precondition failed         | a duplicate `--id`; `claim` on another's task; a `block` cycle; `init` over tasks without `--replace`; `close` whose final save failed; `open` that can't check or back up a board's lock/snapshot |
| 1    | `internal`  | the spell broke               | the daemon answered with an error, or isn't answering (`open` and `close` wait about 2 s)                                                                                                          |

A 5 or 6 means "the daemon refused this", not "you called it wrong": read
`error.message` and `error.hint`, adjust, and don't retry verbatim. The one
exception to the envelope is `open`'s attach refusal (exit 2, live board's JSON
on stdout).

How the **session** ended reaches you as the `closed` frame's `reason`: `user`
(Close board), `close` (your verb) or `timeout` (idle; the daemon exits 124).
Every ending is restorable.

## Join mode — connect to an existing board

Another agent is hosting the board and the user wants you on it. Run `join.ts`;
it opens a WebSocket to the daemon and bridges it to stdio.

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/bounty/scripts/join.ts --id <session_id>   # or --url <url>, or no args for the latest board
```

1. **Find the board**: `--id <session_id>` if you were given an id,
   `--url <url>` for a URL, neither for the latest board
   (`<tmpdir>/bounty-latest.json`). If none is found it exits 5 with the same
   envelope as `cli.ts`; ask the user for an explicit `--url` or `--id`.
2. **Wait for the `joined` line** on stdout: the title and current tasks.
3. **Write one JSON line per action to stdin**; read everyone's actions from
   stdout.
4. **Disconnect** with `{"type":"close"}`, or wait for the host to end it.

Agent → `join.ts` (stdin). These are the browser's WebSocket messages; there is
no `task.update`, toast or `init` over the socket:

```
{"type":"task.add",    "task": Task}
{"type":"task.toggle", "id": "...", "status": "todo|doing|review|done"}
{"type":"task.move",   "id": "...", "status": "...", "index": N}
{"type":"task.edit",   "id": "...", "title?": "...", "notes?": "..."}   // notes "" clears
{"type":"task.remove", "id": "..."}
{"type":"close"}
```

`join.ts` → agent (stdout). **Every broadcast is wrapped** as
`{"type":"event","payload":{…}}`; only `joined` and `disconnected` are bare.
That differs from `cli.ts tail`, so unwrap `payload` before reusing tail-side
handlers. You also see echoes of your own actions.

```
{"type":"joined",       "url":"...", "session_id":"...", "title":"...", "tasks": Task[]}
{"type":"event",        "payload": {...}}   // init | task.add | task.update | task.remove | message
{"type":"disconnected", "reason":"server_closed|stdin_close|timeout|error"}
```

When the board ends, every participant gets a `session ended: <reason>` message
and then `disconnected`. `join.ts` exits 0 on a clean disconnect, 2 on a bad
flag (an envelope) **or** when the socket errors mid-session (a `disconnected`
frame with `reason:"error"`, no envelope), and 5 when it can't find the board.

## Common pitfalls

- **`--stdin` on `update` sets the title**, not the notes.
- **Flags after `--` are text.** Put `--session-key` and every other flag before
  it.
- **Don't merge `tail`'s stderr into stdout** under Monitor.
- **Pin the board** (`--session-key`, `--session` or `open --pin`) whenever
  another board might be open on the machine.
- **The daemon outlives the tab**, and an abandoned board sits until its idle
  timeout.

## Feedback touchpoint

At a natural close — when the board is closed, not mid-session — surface
friction so the tool improves:

- **Agent friction** — if a verb misbehaved, an envelope or event shape fought
  you, or the host/join split was unclear, file a GitHub issue against the
  **Spellbook** repo (`github.com/ichabodcole/spellbook`).
- **Human** — when the user is on the board, offer once (easy to skip):
  "anything about bounty itself feel off or worth improving?" Route what they
  say to the same issues.

This is feedback about the **tool**, not the work on the cards. Worth asking
about specifically: anything the agent was told that the board never showed, or
the reverse — the surface is a hand-written mirror of the daemon's state, and
the two can drift.
