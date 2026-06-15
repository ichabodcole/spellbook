---
name: bounty
description:
  Bounty is a duplex agent↔user task board in the browser. Agent posts tasks;
  user drags between todo/doing/review/done columns, edits titles inline, adds
  or deletes tasks, or submits to end the session. The Review column is a soft
  human-verification gate — the agent parks finished work there (rather than
  Done) when it needs human eyes a passing test can't give. Two host modes —
  STATIC (server.ts, one bounded interaction, agent reads final state on submit)
  and MONITORED (bg.ts + Monitor on the events file, long-lived, agent reacts to
  each event in a fresh turn). Multiple agents can share one board via join.ts.
  HOST trigger phrases — "open a task board", "spin up a bounty", "give me a
  board to track this", or obvious variants. JOIN trigger phrases — "join my
  bounty", "connect to the bounty", "the board is at <URL or id>", or obvious
  variants. Also propose when the agent has produced 5+ discrete TODOs the user
  might want as a workspace. Do NOT use for single tasks, narrative todos that
  aren't trackable, or anything the user wants in chat. Requires Bun on PATH.
---

# Bounty Board

A duplex agent ↔ user surface — woolly mammoth mascot, warm brown + ice blue
palette. Woolly mammoth puns are welcome where they fit naturally.

An agent posts a list of tasks into a browser board; the user interacts with it
(drags tasks between columns, edits titles inline, adds, deletes, submits) and
both sides receive updates in real time. Built on the
[`agent-surface-bun` recipe](../../../../recipes/skills/recipes/library/agent-surface-bun/RECIPE.md)
— see that for the underlying pattern.

**Two host modes** (static vs. monitored), plus a joiner path for multi-agent
collaboration. Pick by how the user is going to use the board:

| Role / Mode                  | Script               | When to use                                                                                                                                                                                                                                                                 |
| ---------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Host — Static (one-shot)** | `server.ts` directly | Agent seeds a board, user works, user submits, agent reads final state in the same turn. Like digestify but for tasks. Use when the interaction is bounded and the user will finish in one sitting.                                                                         |
| **Host — Monitored**         | `bg.ts` + `Monitor`  | Long-lived board the agent reacts to in near real time. Agent arms a `Monitor` on the events file; every user action wakes a fresh turn. Use when the user might leave the board open for a while, work in bursts, or want the agent to react as they edit, not at the end. |
| **Joiner**                   | `join.ts`            | A second agent connecting to a board another agent already opened. Browser-equivalent powers. See [Join mode](#join-mode--connect-to-an-existing-board).                                                                                                                    |

**Why two host modes?** A chat-style agent processes each user turn as one
discrete tool invocation. While `server.ts` is running in the foreground, the
agent can't simultaneously do anything else — it's blocked on that subprocess
until the user submits. That's perfect for short, bounded interactions and bad
for long-lived ones. `bg.ts` + `Monitor` solves the long-lived case: `bg.ts`
runs the board in the background and exposes two append-only files (events file
the agent reads, commands file it appends to); `Monitor` watches the events file
with a `tail -F` + grep and wakes the agent on each user action. The duplex
feels real-time even though the agent is still turn-based — each event becomes
its own turn.

All three entries above use the same JSON-lines contract under the hood — only
the transport varies (direct stdio vs. file-mediated).

## The columns — and the review gate

The board has four columns: **To do → Doing → Review → Done**. Review is a
human-verification gate, and deciding what passes through it is a judgment call
you make per task:

- **Park a finished task in Review** (not Done) when it wants a human to look
  before it counts as done — UI changes, anything that needs a manual smoke
  test, behavior that passing tests don't fully capture. The user eyeballs it
  and drags it to Done, or back to Doing if it needs more work.
- **Move straight to Done** when automated checks already cover it — pure
  functional changes or refactors where green tests are sufficient evidence. Not
  everything needs a human glance; routing trivially-verified work through
  Review just adds friction.

The gate is a **convention, not enforced** — the server accepts any status
transition from either side. Let the task's test plan guide you: if it calls for
human smoke-testing, route through Review; if green tests settle it, Done is
fine. When genuinely unsure, prefer Review — a cheap glance beats a missed
regression. A `message` toast is a good way to flag what you've put up for
review and why.

## When to Use

**Host mode (any variant)** — fire on phrases like "task board", "bounty", "open
a board", "spin up a board to track this", or any obvious variant.

**Join mode** — fire on phrases like "join my bounty", "join the bounty",
"connect to the bounty", "the board is at <URL>", "the session id is <id>", or
any obvious variant. The user is in a separate terminal / agent session from the
one that opened the board.

### Static vs. Monitored — pick by interaction shape

Both host modes look the same to the user (a board in their browser). The
difference is how the agent stays connected:

- **Use static (`server.ts`) when** the user is going to deal with the board
  immediately and finish in one sitting — bounded interaction, single submit
  ends it. Examples: "here are six tasks for this session, prioritize them";
  "I've got a backlog of decisions, drag them into categories."
- **Use monitored (`bg.ts` + `Monitor`) when** the interaction is open-ended or
  you want to react as the user works rather than only at the end. Examples:
  "open a board I'll work through over the next hour"; "give me a board, react
  as I add and reorder"; any time the user might leave and come back.

When in doubt, propose: _"want this as a quick one-shot board or one I'll keep
watching as you work?"_ Default to monitored when the user hasn't been explicit
and the work feels open-ended.

**Heads up on monitored sessions:** the host stays alive **even if the user
closes the browser tab.** Sessions only end on explicit submit/cancel, your own
`close` command, or the idle timeout (default 30 min). If you spawn a monitored
board and the user wanders off without submitting, the host process sits waiting
until the idle timer fires. Surface this expectation when you propose monitored
mode for short-lived interactions.

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

`server.ts` runs under [Bun](https://bun.sh) — assume the user has `bun` on
their PATH (it's the runtime this skill commits to). If `bun` is missing, the
Bash call fails fast with `command not found: bun`; surface that to the user and
stop. Don't try to install Bun for them.

## Host Mode — Start a New Board

### How it works

1. You spawn the script via the Bash tool. The script opens the user's browser
   to a local board.
2. **You send updates via stdin** (JSON-lines, one object per line) — initial
   tasks, new tasks, edits, removals, toasts.
3. **You read events from stdout** (JSON-lines) — every user interaction is a
   line: `task.toggle`, `task.edit`, `task.add`, `task.remove`.
4. The session ends when the user clicks **Submit** (you receive a final
   `submit` event with the full task list, then `closed reason=submit`, exit 0)
   or **Close without submitting** (exit 130). The script also exits on idle
   timeout (exit 124) or when you send `{"type":"close"}`.

Unlike digestify (one-shot), the script **stays running for the duration of the
interaction**. The Bash tool call blocks until the session ends.

**Tip: use `message` toasts liberally.** A `{"type":"message", "text":"..."}`
command renders a transient toast on the board — perfect for acknowledging user
actions ("nice — that one's done"), explaining context ("agent: I'm working on
this now"), or signaling milestones. Toasts don't add tasks or mutate state;
they're free UX texture. Underused in practice. Keep them short (one short
sentence) since they auto-dismiss.

When `server.ts` starts, it writes session info to two files in the system temp
directory so joining agents can discover the board without copy-paste:

- `<tmpdir>/bounty-<session_id>.json` — keyed by session id; persistent for the
  lifetime of this host.
- `<tmpdir>/bounty-latest.json` — always points at the most recently opened
  board.

Both files are cleaned up on normal exit.

### Host protocol — Agent → script (write to stdin, one JSON line per message)

```
{"type":"init",        "title": "...", "tasks": Task[]}
{"type":"task.add",    "task": Task}
{"type":"task.update", "id": "...", "patch": Partial<Task>}
{"type":"task.remove", "id": "..."}
{"type":"message",     "text": "..."}   // toast notification on the board
{"type":"close"}                        // end session cleanly (exit 0)
```

### Host protocol — Script → agent (read from stdout, one JSON line per message)

```
{"type":"ready",        "url":"...", "port":..., "session_id":"..."}
{"type":"connected"}                                       // browser opened WS
{"type":"disconnected"}                                    // browser closed WS
{"type":"task.toggle", "id":"...", "status":"todo|doing|review|done"}  // pill click
{"type":"task.move",   "id":"...", "status":"...", "index":N}   // drag-drop
{"type":"task.edit",   "id":"...", "title":"..."}          // title edit
{"type":"task.add",    "task": Task}                       // user added a task
{"type":"task.remove", "id":"..."}                         // user deleted
{"type":"submit",      "tasks": Task[]}                    // final state, session ending
{"type":"closed",      "reason":"submit|cancel|timeout|stdin_eof|close"}
```

### Task shape

```ts
type Task = {
  id: string; // any unique string (you choose the scheme)
  title: string;
  status: "todo" | "doing" | "review" | "done";
  notes?: string; // optional, shown under the title
};
```

## Invocation

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/skills/bounty/scripts/server.ts \
  --title "Refactor sprint" \
  --timeout 1800
```

Then write JSON-lines to its stdin to push state. The standard agent harness
pattern is to spawn the script with stdin piped and feed it events as they
happen — see the recipe's "Build a New Surface" walkthrough for the spawn
pattern.

## Flags

- `--title TEXT` — page/tab title (default `"Bounty Board"`)
- `--timeout SECONDS` — idle timeout (default `1800` / 30 min). Resets on any
  agent or browser activity.
- `--no-open` — don't auto-open the browser; useful in headless / SSH setups
- `--port N` — bind specific port (default: random free port)
- `--host HOST` — bind host (default `127.0.0.1`)
- `--id SLUG` — stable session id. Auto-generated as `bounty-<rand>-p<port>` if
  omitted (the `-p<port>` suffix encodes the bound port for session-recovery
  semantics matching digestify).

The script prints `{"type":"ready", "url":..., "port":N, "session_id":"..."}` to
**stdout** as soon as the server is listening (note: stdout, not stderr — the
JSON-lines protocol uses stdout for everything).

## Monitored Host Mode — `bg.ts` + `Monitor`

For long-lived boards. The agent spawns `bg.ts` in the background, arms a
`Monitor` on the events file, and reacts to each user action in a fresh turn. No
`/loop` invocation needed from the user — the agent sets this up itself when the
request fits.

### The setup, end-to-end

```
1. Spawn bg.ts with run_in_background: true. Capture its meta JSON line.
2. (Optional) Seed the board with a task.init via the cmds file.
3. Arm a Monitor on the events file with a grep filter for actionable
   events (task.* and submit/closed).
4. Tell the user the board is live, return control.
5. Each Monitor event wakes you into a brief turn — react by appending
   to cmds_file. No state to carry between turns beyond the file paths.
6. When the event is "submit" or "closed", TaskStop the Monitor and
   read the final task list from the submit event.
```

### Step 1 — Spawn `bg.ts`

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/skills/bounty/scripts/bg.ts \
  --title "Watch this board" \
  --timeout 1800
```

Use `run_in_background: true` on the Bash tool. The first line of the
subprocess's stdout is a meta record:

```json
{
  "type": "meta",
  "url": "http://127.0.0.1:53645",
  "port": 53645,
  "session_id": "bounty-abc12345-p53645",
  "events_file": "/tmp/bounty-abc12345-p53645-events.log",
  "cmds_file": "/tmp/bounty-abc12345-p53645-cmds.log"
}
```

Capture both file paths in conversation context.

### Step 2 — (Optional) Seed initial state

Append a JSON-lines `init` command to the commands file:

```bash
CMD='{"type": "init", "title": "My Project Board", "tasks": []}' \
bun -e '
import { appendFileSync } from "node:fs";
appendFileSync(process.env.CMDS, process.env.CMD + "\n");
'
```

Skip this if you'd rather let the user populate the board themselves.

### Step 3 — Arm `Monitor` on the events file

The Monitor tool runs a shell command persistently; each line of stdout becomes
a `task-notification` that wakes you in a fresh turn. The grep filter passes
through only actionable lines — user-driven board mutations plus session-ending
events.

Use the bundled `watch-events.sh` helper — it ships with the skill, handles the
`tail -F` + `grep` plumbing, and saves you from JSON-escaping the regex inside a
tool argument.

```
Monitor({
  description: "bounty events for <short purpose>",
  persistent: true,
  timeout_ms: 3600000,
  command: "bash ${CLAUDE_PLUGIN_ROOT}/skills/bounty/scripts/watch-events.sh <events_file>"
})
```

If `$CLAUDE_PLUGIN_ROOT` isn't set in your shell environment, substitute the
absolute path to the script (e.g. relative to repo root,
`plugins/spellbook/skills/bounty/scripts/watch-events.sh`).

The helper's filter is the canonical one — it passes through user-driven board
mutations (`task.add` / `task.move` / `task.toggle` / `task.edit` /
`task.remove`) and session-ending events (`submit` / `cancel` / `closed`),
filtering out lifecycle noise (`ready`, `connected`, `disconnected`, `meta`) and
broadcasts the agent already drove (`task.update` echoes of agent commands,
`message` toasts the agent posted itself).

**Capture the Monitor's return** — it gives you back a `task_id` you'll need
later to `TaskStop` the watch when the session ends. The shape is roughly:

```json
{ "task_id": "abc123def...", "task_type": "local_bash", "command": "..." }
```

### Step 4 — React to each event

Each `task-notification` you receive contains the raw matching line(s) in its
`event` field. **`tail -F` + `grep` may batch multiple lines into one
notification** if events arrive in a burst — split on newlines and parse each.
Decide what to do (push a `task.update` or `message`, or nothing if not
interesting), then append your response to `cmds_file`. No need to re-arm —
Monitor stays armed for the next event.

If you'd rather work from the file directly (e.g. to re-read everything from the
start), `events_file` is the canonical record. Use the Monitor stream when you
want freshness; use the file when you want completeness.

### Step 5 — End the session

When the notification contains `{"type":"submit", ...}`, `{"type":"cancel"}`, or
`{"type":"closed", ...}`:

1. Parse the `submit` event's `tasks` array for the final state (if submit).
2. Call `TaskStop({ task_id })` on the Monitor's task id from Step 3.
3. `bg.ts` self-terminates when the underlying `server.ts` exits — no `close`
   command needed. The events file persists on disk so you can re-read it.
4. Continue the conversation with the resolved task list.

### Worked example — verbatim tool-call sequence

A complete monitored session looks like this. Tool calls in chronological order
across multiple turns:

**Turn 1 — set up.** One Bash call (backgrounded) + a read of the meta line

- one Monitor call + a seed.

> **Heads up on `$CLAUDE_PLUGIN_ROOT`.** The env var resolves to the plugin's
> install path in Claude Code. If it's unset in your shell (some harnesses leave
> it empty), substitute the absolute path
> `plugins/spellbook/skills/bounty/scripts/...` relative to the repo root. An
> empty `$CLAUDE_PLUGIN_ROOT` silently turns `${VAR}/skills/...` into
> `/skills/...` and `bun run` fails with a confusing "module not found."

```
Bash({
  command: "bun run ${CLAUDE_PLUGIN_ROOT}/skills/bounty/scripts/bg.ts --title 'Sprint board' --timeout 1800 > /tmp/bg-meta.json 2>&1",
  run_in_background: true,
  description: "spawn bounty board host"
})

Bash({
  // Wait until bg.ts has emitted its meta line. Don't use a fixed sleep —
  // `until [ -s file ]` polls until the file is non-empty.
  command: "until [ -s /tmp/bg-meta.json ]; do sleep 0.1; done; head -1 /tmp/bg-meta.json",
  description: "wait for meta line and read it"
})
// Parse the meta JSON. Extract url, events_file, cmds_file.

Monitor({
  description: "bounty events",
  persistent: true,
  timeout_ms: 3600000,
  command: "bash ${CLAUDE_PLUGIN_ROOT}/skills/bounty/scripts/watch-events.sh /var/folders/.../bounty-<id>-events.log"
})
// Capture the returned task_id (e.g. "abc123") — you'll TaskStop it later.

Bash({
  command: "echo '{\"type\":\"init\",\"title\":\"Sprint\",\"tasks\":[...]}' >> $CMDS_FILE",
  description: "seed initial board state"
})
// Tell the user the board is live. End the turn — the Monitor is now the
// wake signal.
```

**Turn 2..N — woken by a Monitor `task-notification`.** Each notification
contains the matched event line(s). Read, react, end:

```
// Notification arrives, e.g.:
// {"type":"task.toggle","id":"t1","status":"done"}
// React by posting a toast:
Bash({
  command: "echo '{\"type\":\"message\",\"text\":\"nice — t1 done\"}' >> $CMDS_FILE",
  description: "react to user move"
})
// End the turn. Monitor stays armed.
```

**Reactive pattern: user adds a task → agent annotates it.** The most common
shape — the user types a task, the agent extends it with notes or moves it to
"doing" because it's about to start work on it. Use the id from the incoming
event:

```
// Notification:
// {"type":"task.add","task":{"id":"u-abc123","title":"set up CI","status":"todo"}}

// React: move to doing + attach context-aware notes (same id).
Bash({
  command: "echo '{\"type\":\"task.update\",\"id\":\"u-abc123\",\"patch\":{\"status\":\"doing\",\"notes\":\"agent: starting on this — using GitHub Actions\"}}' >> $CMDS_FILE",
  description: "promote and annotate user task"
})
```

**Final turn — session ends.** When the notification's event is `submit` or
`closed`:

```
// Notification:
// {"type":"submit","tasks":[...final list...]}
// {"type":"closed","reason":"submit"}

TaskStop({ task_id: "abc123" })  // the Monitor task_id from turn 1

// Parse the submit event's tasks array, continue the conversation with the
// resolved state.
```

### Commands and events at a glance

Commands (agent → board, append one JSON line per command to `cmds_file`):

```
{"type":"init",        "title":"...", "tasks": Task[]}
{"type":"task.add",    "task": Task}
{"type":"task.update", "id":"...", "patch": Partial<Task>}
{"type":"task.remove", "id":"..."}
{"type":"message",     "text":"..."}     // toast on the board
{"type":"close"}                          // end session, exit 0
```

Events you'll see in Monitor notifications (board → agent):

```
{"type":"task.toggle", "id":"...", "status":"..."}
{"type":"task.move",   "id":"...", "status":"...", "index": N}
{"type":"task.edit",   "id":"...", "title":"..."}
{"type":"task.add",    "task": Task}
{"type":"task.remove", "id":"..."}
{"type":"submit",      "tasks": Task[]}
{"type":"closed",      "reason":"..."}
```

### Notes on `bg.ts`

- **Lifecycle.** `bg.ts` is a thin wrapper that lives as long as the underlying
  `server.ts`. When the user submits/cancels (or `server.ts` hits an idle
  timeout), the server exits and `bg.ts` exits with the same code. You do
  **not** need to send `{"type":"close"}` to clean up — the exit cascades
  automatically. If you want to forcibly terminate from your side, append a
  `close` command to `cmds_file` (works the same as a host stdin close).
- **Discovery files** written to `<tmpdir>/bounty-<session_id>.json` and
  `bounty-latest.json` (same as `server.ts` host mode), so joiners can still
  find this board via `join.ts`.
- **On normal exit**, the commands file is removed; the events file stays so you
  can read the final state.
- **Re-launching with the same `--id`** truncates and reuses both files.
- **Multi-board caveat.** `bounty-latest.json` only points at the most recently
  launched board. If you spawn two `bg.ts` instances back-to-back, a no-arg
  `join.ts` will connect to whichever was newest. Prefer explicit `--id` when
  you have multiple boards live.
- **Failure modes.** If `bg.ts` itself is killed (SIGKILL, OOM) while
  `server.ts` is still alive, the board keeps running but the agent loses the
  command channel — there's no reconnect primitive today. The user closing the
  browser tab eventually triggers `server.ts`'s idle timeout (default 30 min)
  and the orphan exits. This is a known gap (no reconnect primitive today).

## Exit Code Contract

| Code | Reason (the `closed` event's `reason` field) | What to do                                                                                  |
| ---- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 0    | `submit`                                     | User clicked Submit. Parse the `submit` event's `tasks` array for the final state.          |
| 0    | `close`                                      | Agent sent `{"type":"close"}` — clean shutdown initiated by you, no submit event was fired. |
| 0    | `stdin_eof`                                  | The agent's stdin closed (host mode only). Same as `close` for practical purposes.          |
| 2    | (no reason — fails before session starts)    | Bad CLI args or port bind failure. stderr explains; fix args and retry.                     |
| 124  | `timeout`                                    | Idle timeout fired. Tell the user the session expired; offer to relaunch.                   |
| 130  | `cancel`                                     | User clicked "Close without submitting". Session intentionally discarded.                   |

## Join Mode — Connect to an Existing Board

Another agent is already hosting a board (browser tab is open somewhere) and the
user wants you to participate. You'll spawn `join.ts` instead of `server.ts`; it
bridges the WebSocket to your stdio the same way `server.ts` bridges the spawned
server to the host agent's stdio.

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
{"type":"task.update", "id": "...", "patch": Partial<Task>}
{"type":"task.move",   "id": "...", "status": "...", "index": N}
{"type":"task.remove", "id": "..."}
{"type":"close"}                                  // disconnect cleanly
```

Joiners CAN'T push toasts (`message`), reset state (`init`), or arbitrarily
patch the title — those are host-only. The server silently ignores them if sent
over WS.

### Join protocol — join.ts → agent (stdout, one JSON line per message)

> **⚠ Wrapping asymmetry.** Unlike the host's stdout, the joiner's stdout wraps
> every incoming broadcast as `{"type":"event", "payload":{...}}`. Only the
> bookend handshakes (`joined`, `disconnected`) are bare. If you're copying
> handler logic from the host side, you'll need an unwrap step:
>
> ```ts
> if (line.type === "event")
>   handle(line.payload); // joiner side
> else if (line.type === "task.toggle") handle(line); // host side
> ```

```
{"type":"joined",       "url":"...", "session_id":"...", "title":"...",
                        "tasks": Task[]}          // initial handshake
{"type":"event",        "payload": {...}}         // any WS broadcast:
                                                  //   init | task.add |
                                                  //   task.update |
                                                  //   task.remove |
                                                  //   message |
                                                  //   submit | cancel
{"type":"disconnected", "reason":"server_closed|stdin_close|timeout|error"}
```

**Submit and cancel are broadcast** with structured shapes. When the user
submits, joiners receive `event(submit, tasks=[...])`. When the user cancels (or
the host agent does), joiners receive `event(cancel)`. Both are followed by
`disconnected` as the server tears down. Treat either as the session-ending
signal — `submit` carries the final state, `cancel` means discard whatever local
mirror you've been building.

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

- **Server is source of truth.** The host's `server.ts` holds the canonical task
  list and broadcasts updates to all WS clients (browser + joiners). Conflicting
  concurrent edits resolve to whoever's message arrived first.
- **Events are not commands.** When you receive `task.toggle` (host) or `event`
  with `task.*` payload (joiner), the server has already applied it. You're just
  being informed.
- **`init` resets the list.** Use `task.update` / `task.add` / `task.remove` for
  incremental changes once the board is live.
- **`message` is a toast, not a chat replacement** — host-only, use sparingly.
- **Joiners are downstream.** They see every broadcast — including echoes of
  their own actions. Filter those out if duplicates would be a problem (match on
  the id of an action you just sent).

## Common Pitfalls

- **JSON-lines means one JSON object per line.** A multi-line `echo` with
  pretty-printed JSON puts real newlines into the file — `bg.ts` forwards each
  line to `server.ts`, which sees several broken fragments and silently rejects
  all of them. Always use `JSON.stringify(obj)` (no whitespace pretty-printing)
  before appending. The cleanest pattern is a small `bun -e` or script that
  builds the object in code and
  `appendFileSync(file, JSON.stringify(obj) + "\n")`.
- **Export environment variables before subprocesses use them.**
  `VAR=path bun -e '...'` works (inline assignment passes through).
  `VAR=path; bun -e '...'` does NOT — the variable is local to the parent shell.
  Use `export VAR=path` on a separate line, or inline `VAR=path` on the same
  command.
- **Static mode: the Bash tool call blocks until submit.** You can pipe agent
  commands via stdin (heredoc, `echo`, or a file fed to stdin) on the same Bash
  invocation, but you don't get to read stdout incrementally — you get the final
  `{type:"submit", tasks:[...]}` line at the end. If you need push-after-spawn
  (reactive updates while the user works), use monitored mode instead. Don't try
  to "shell into" a running static host.
- **Don't send `init` more than once mid-session.** It blows away the user's
  in-progress edits. Use `task.update` / `task.add` / `task.remove` for
  incremental changes once the board is live.
- **TaskStop the Monitor when the session ends.** When you see a `submit` or
  `closed` event, call `TaskStop` on the Monitor's task id before continuing.
  Otherwise the watch keeps running against a now-empty file until session
  timeout.
- **Static mode: set Bash timeout high enough.** Default Bash tool timeout is
  short. Pass a long timeout (in ms) on the Bash call, or shorten `--timeout` to
  match. Monitored mode doesn't have this problem — the Bash call returns as
  soon as `bg.ts` emits its meta line.
