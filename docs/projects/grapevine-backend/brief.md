# Grapevine backend — the three lifecycle-route gaps

**Created:** 2026-09-06 · **Author:** Cole Reed + Claude Code (orchestrator) ·
**Mode:** loose — a brief, not a plan; this file doubles as the proposal.
**Branch:** `fix/grapevine-lifecycle-routes`, cut from develop at `bf182bd`.
**Source:**
[the backlog item](../../backlog/2026-09-06-grapevine-lifecycle-route-gaps.md),
filed by the UX branch's implementing agent and its cold read.

## Why

Three grapevine branches gave the human parity with the agent on the watch
surface. All three deliberately refused to touch the daemon, and each one filed
what it found. This branch is that debt. The three gaps are ranked here by **how
badly they mislead an agent**, which is not the same as how wrong they are:

1. **Any read verb resurrects a deleted channel, silently.** `pull`, `read`,
   `wait`, `triage` and `topic` all `POST /channels {name}` to "ensure loaded",
   and the read routes themselves call `loadChannel`, which **registers the name
   in the in-memory map**. `listChannels()` merges that map with the files on
   disk, so the channel is back in `list` — with no file, no messages and no
   signal. An agent polling a channel a human just closed gets
   `{"ok":true,"messages":[]}` forever and can never discover why. **This is the
   worst of the three because it is unobservable from inside the agent.**
2. **Archive and unarchive emit nothing.** `list` flips a flag; no frame, no
   stream event. An agent tailing a channel cannot see either party retire it
   and finds out when its next send is rejected. Silent, but self-correcting.
3. **`PUT /channels/:name/topic` has no archived check, and neither does the CLI
   verb** — `cmdTopic` sends its ensure `POST /channels` and **discards the
   response**, so the 409 that answers for an archived name is ignored and the
   PUT lands. The watch surface refuses this (inventory L3a/L3c), so the UI is
   currently **stricter than the agent path**. Least harmful: nobody is misled
   about state, the agent just gets away with something.

## The mission

Close all three, plus the one thing that would otherwise move the trap in gap 1
rather than close it (see the third ruling).

## Rulings — these are decided; do not re-litigate them

**1. Only an act that declares intent to make a channel exist may create one.**

| creates                                                        | does NOT create — 404 when the channel is missing |
| -------------------------------------------------------------- | ------------------------------------------------- |
| `open` (explicit, idempotent, auto-unarchives)                 | `pull`, `read`, `wait`, `triage`                  |
| `tail` (a subscription is forward-looking — the documented     | `topic <name>` with **no text** (a read)          |
| "fresh `tail name` without an explicit open"; keep it)         | `who` (already non-creating — leave it)           |
| `watch` (the human is being pointed at a channel)              | `grep` (already reads the file directly)          |
| every write: `send`, `announce`, `mark`, `topic <name> <text>` |                                                   |

The discriminator is intent, not HTTP verb: a write says "this channel should
hold this", a subscribe says "tell me about this from now on", and a read says
"what is in this" — only the last is a question that a missing channel answers
by being missing. **Not taken:** a tombstone on delete so a read could
distinguish "deleted" from "never existed" — an agent's next act is the same
either way, and it costs a persistent artifact plus an expiry rule to answer a
question nobody asks. **Not taken:** making `tail` refuse too — it breaks the
convene-at-start wrappers and the watch surface's own first load.

**2. A refusal names the next act.** `{"error":"no channel \"x\"", …}` alone
makes the agent guess. The house pattern is that a response names the act it
makes likely, so the error carries the recovery — the `open` command that would
create it. Status **404**. Keep the daemon's existing error-envelope shape; do
not invent a new one.

**3. `tail` must say when it created the channel.** Today an agent that tails a
mistyped name waits forever inside a channel of its own making, with no signal —
the same silent-failure class as gap 1, just slower. The `subscribed` event
already carries `channel`, `since`, `as`, `topic`, `latest_id`; add the fact
that this subscribe brought the channel into being. **Without this, fixing the
read verbs moves the trap instead of closing it.**

**4. Archive and unarchive append a `kind:"status"` frame.** Persisted, so
`pull` shows it in history and a reconnecting tail replays it — an SSE-only
event would be invisible to both. The kind already exists in the wire types with
no emitter, and `POST /messages` coerces a caller-supplied `status` to
`message`, so agents cannot forge one — **keep that coercion**. It must be
folded out of `triage`'s open queue exactly as `topic` and `announcement` are:
an archive is an FYI, not a work item.

**5. The surface owns its half of ruling 4.** A new frame kind arrives in the
watch feed, which renders `topic` and `announcement` specially and everything
else as an ordinary message. A `status` frame must not render as somebody's
message. Give it the system-note treatment the `topic` frame has (they are the
same kind of thing: a channel-level fact, not a participant's utterance), add
the inventory row, and rebuild `dist/` in the same commit as the source. **This
branch is backend-led but it is not backend-only, and that is expected.**

## Technical direction

**The mechanism to understand before writing anything:** `loadChannel(name)`
(`daemon.ts:227`) returns the in-memory record or **builds one**, and
`listChannels()` (`:321`) unions `channels.keys()` with the `.jsonl` files on
disk. So a read route that calls `loadChannel` on a missing name resurrects it
in memory even though no file is written. **Fixing only the CLI's ensure calls
would leave every read route resurrecting on its own** — the daemon is where the
guard belongs, and the CLI change is what makes the error reach the agent well.

- **Daemon.** Introduce one non-creating lookup and route the read paths through
  it; a channel "exists" if it is in the map **or** its `.jsonl` is on disk.
  Read routes to convert: `GET …/messages`, `GET …/wait`, `GET …/topic`. Leave
  `GET …/subscribers` alone (it already uses `channels.get`). `PUT …/topic`
  gains the **archived** guard `POST …/messages` already has (`:808`) — same
  409, same shape. Decide and record whether `PUT …/topic` on a _missing_
  channel creates (it is a write under ruling 1, so yes) — say so either way.
- **`POST /channels`.** The read verbs need a way to ask without creating, or to
  stop asking. Prefer **stop asking**: with the daemon guarding its own read
  routes, the ensure call in
  `cmdPull`/`cmdRead`/`cmdWait`/`cmdTriage`/`cmdTopic` is redundant and its only
  remaining effect is the resurrection. Removing it is smaller than adding a
  flag. If you find a reason a read verb still needs it, record the reason.
- **CLI call sites**, all seven: `cmdTopic:405`, `cmdPull:505`, `cmdRead:545`,
  `cmdWait:579`, `cmdTail:690`, `cmdTriage:929`, `cmdWatch:1261`. Under ruling 1
  the last three keep theirs. `cmdTopic` additionally must **read its ensure's
  status and die on 409** the way `cmdOpen` does — that is gap 3, and it is two
  lines.
- **Tests.** `scripts/cli.test.ts` (117 tests) is the home; there is a
  `declared surface (schema / root routing / per-verb flags)` block — if the
  per-verb declaration names error behaviour, extend it. Every ruling above
  wants a cell: a read verb on a missing channel 404s **and `list` still does
  not show it** (that second assertion is the actual bug), a tail creates and
  says so, archive appends a frame that `triage` skips, `topic` on an archived
  channel dies.
- **Docs.** `SKILL.md`'s route table and its Channel-lifecycle prose describe
  the old behaviour in several places, including the `tail` row's "so a fresh
  `tail name` works without explicit open" (still true) and the `topic` row (now
  guarded). The narrative version banner is at V2.1; the `ward` skill decides
  whether this is V2.2. Amend the behaviour inventory for the surface half only.
- **Commit type.** These are `fix(` except the status frame and the subscribe
  field, which a consumer can see and are therefore `feat(`. Read verbs refusing
  a missing channel **is a breaking change for any wrapper that reads before it
  opens** — it is still the right fix, it fails loudly the first time, and the
  release note must say so plainly. Do not mark it `feat!` without saying why in
  the decision log.

## Conventions that bite

- `bunx biome check --write` on every changed `.ts`/`.tsx` before each commit.
- **Story-chapter commits**, not a fix-up diary. Source and rebuilt `dist/` in
  the same commit whenever surface source changes.
- Run the gate **unpiped**, exit read from a file:
  `bun run gate > /tmp/gate.log 2>&1; echo $?`. `| tail` reports tail's exit.
- Trailers on every commit:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01BiZGj5ZTDSZi1mB8YtuRcx`.
- **Never** stage, stash or edit `skills-lock.json` (modified) or
  `.claude/skills/shadcn/` (untracked) — the human's in-progress files.
- **Never kill pids 23127 or 66902.** Every daemon you start gets its own
  `GRAPEVINE_HOME` under the session scratchpad, and you tear yours down.
- **No push, no merge.** Land is the orchestrator's, after Cole reviews.

## Records — equal-weight deliverables, not an afterthought

- `decision-log.md` — live, as you go: every decision point, and the options not
  taken with what each would have cost.
- `backend-journal.md` — the process in order, for the agent who does this to
  another daemon: what you had to discover and how, what the code did that the
  brief did not say, every gotcha with symptom and fix, and what you would tell
  the next agent. `⚠` = a gotcha; `⛔` = something the brief did not say.
- `sessions/2026-09-06-the-lifecycle-routes.md` at the end.

## Done means

- A read verb on a missing channel refuses, names the recovery, and **leaves
  `list` unchanged** — the resurrection is gone at the daemon, not just the CLI.
- `tail` still creates, and says that it did.
- Archive and unarchive both append a frame that a tailing agent receives, that
  `pull` replays, that `triage` skips, and that the watch feed renders as a
  channel-level note rather than a message.
- `topic` on an archived channel is refused by the route **and** the verb.
- Tests cover each of the above; the gate is green unpiped; `dist-check` exits
  0; the `ward` skill has been run; the records above exist and are honest.
