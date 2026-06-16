# Bounty: modernize to the house agent-interface pattern — Implementation Plan

**Created:** 2026-06-15 **Related Proposal:** [proposal.md](./proposal.md)
**Status:** Draft

---

## Overview

Bounty is the last Spellbook spell still on the **old agent-interface
substrate**: the agent drives the board through `bg.ts` (a background launcher
that re-exposes a blocking stdio host over two append-only files) and reads via
a `tail -F | grep` Monitor. State lives in-memory only, there is no
read-current-state primitive, no command ack, no persistence, and the documented
authoring path (`bun -e '…appendFileSync…'`) breaks on apostrophes. Two sibling
spells — **Grapevine** and **Imago** — have independently converged on the house
pattern: a **persistent daemon holding canonical state**, a **thin stateless
`cli.ts` verb wrapper**, `POST /cmd` (write) + `GET /state[?lean=1]` (read-back)

- `GET /events?since=<id>` (SSE tail wrapped by Monitor), plus debounced on-disk
  snapshots with `--restore`.

This plan migrates Bounty onto that pattern. The five filed issues (#6–#10) are
not patched individually — they fall out of the substrate migration. The work is
phased so each phase is independently shippable, the existing protocol tests
(`scripts/server.test.ts`) stay green throughout, and `scripts/join.ts` keeps
working at every step. The riskiest phase is **A** (stand up the daemon +
cli.ts, retire `bg.ts`); it is the most concrete below.

Reference implementations to mirror (read these while implementing):

- `plugins/spellbook/skills/imago/scripts/server.ts` — the daemon: `POST /cmd`
  (`server.ts:915`), `GET /state` lean projection (`server.ts:905`, `leanState`
  `:164`), SSE `GET /events?since=` (`emitEvent` `:289`, `sseResponse` `:514`),
  debounced snapshot (`saveSnapshot` `:324`, snap timer `:1079`), restore
  merge-over-defaults (`:249`), discovery files (`:1037`).
- `plugins/spellbook/skills/imago/scripts/cli.ts` — the thin CLI: detached
  `node:child_process` spawn + discovery-file readback (`cmdOpen` `:139`), SSE
  tail client with resume cursor (`cmdTail` `:190`), `state` (`:183`).
- `plugins/spellbook/skills/grapevine/scripts/cli.ts` — the refined agent CLI:
  verb dispatch (`main` `:958`), `--stdin` body path (`send` case `:983`),
  stdout(payload)/stderr(liveness) discipline, self-echo suppression + scoped
  reads (`cmdTail` `:505`, esp. `:641`), `--from`/`--as` identity (`:214`),
  exit-code contract (`die` `:229`).
- `plugins/spellbook/skills/grapevine/scripts/watch.html` — the Alpine-over-CDN
  no-build surface pattern (target for the Bounty surface port).

## Outcome & Success Criteria

**Definition of Done** (all trace to a proposal Success Criterion):

- [ ] An agent can run `cli.ts state` and **read back** confirmation a command
      applied — no HTML render, no event-stream inference (#8).
- [ ] The documented append path works with arbitrary text (apostrophes,
      metachars) verbatim via `cli.ts <verb> --stdin` (#7).
- [ ] A worker tailing `--owner <name>` / `--mine` is woken only by its own +
      claimable tasks, not the whole board; self-echo is suppressed and
      payload/liveness are split across stdout/stderr (#9).
- [ ] A blocked task renders distinctly, and its owner receives an `unblocked`
      event when the last blocker reaches `done` (#10).
- [ ] A board survives an agent-heavy idle stretch with no spurious exit 124,
      and restores its full state via one `cli.ts open --restore <id>` if closed
      (#6).
- [ ] Bounty's agent interface matches the house shape (`cli.ts` + `/cmd` +
      `/state` + `/events`) — the same surface an agent already knows from
      Grapevine and Imago.
- [ ] `bg.ts`, `watch-events.sh`, and the `bun -e` snippet are retired;
      `join.ts` still works; `server.test.ts` is green.
- [ ] No live "Tuskboard" string remains in the bounty spell surface/contract.

**Non-Goals** (from the proposal's Out of Scope):

- A full DAG editor UI for dependencies — field + cue + `unblocked` signal only.
- Hard locks on blocked tasks — gate is a convention + cue, like Review today.
- React component breakup — the surface targets the Alpine tier, not React.
- Rewriting historical docs that mention Tuskboard (CHANGELOG, manifesto,
  rebrand proposal stay as history).
- A shared `cli.ts`/daemon helper library across spells (copy-and-adapt now;
  consolidate later, per the proposal's Resolved Decision).

## Approach Summary

The migration replaces the **transport**, not the **board model**. The
`Task`/`BoardState` shapes and the pure mutation helpers (`applyTaskAdd`,
`applyTaskUpdate`, `applyTaskRemove`, `applyTaskMove` in `server.ts:214–265`)
already exist, are well-tested, and survive almost intact — they become the
state core the daemon mutates. What changes is everything around them:

| Concern         | Today (old substrate)                                                  | After migration (house pattern)                                  |
| --------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Agent write     | append JSON-line to a cmds file; `bg.ts` polls + pumps to server stdin | `cli.ts <verb>` → `POST /cmd` (with `--stdin` body)              |
| Agent read      | infer from event stream / render HTML                                  | `cli.ts state` → `GET /state[?lean=1]` ack + snapshot            |
| Agent live push | `tail -F \| grep` on the events file via Monitor                       | `cli.ts tail` → `GET /events?since=<id>` SSE, wrapped by Monitor |
| Process model   | one-shot stdio host (`server.ts`) + file-pump (`bg.ts`)                | persistent detached daemon; `cli.ts` is stateless per-verb       |
| Persistence     | in-memory only, dies with the process                                  | debounced snapshot to `$BOUNTY_HOME` + `--restore`               |
| Idle touch      | UI/browser activity only                                               | `touch()` on every `/cmd` + `/state` request too                 |
| Browser↔server  | WebSocket (unchanged)                                                  | WebSocket (unchanged)                                            |

`server.ts` is reshaped into the daemon (keep its `Bun.serve`, WS handlers,
state helpers, discovery files, idle timer, exit-code contract; add the HTTP
`/cmd`, `/state`, `/events` surface; drop the stdin JSON-lines reader as the
agent's write path). A new `cli.ts` is the agent's only entry point. `bg.ts`,
`watch-events.sh`, and the `bun -e` snippet retire. `join.ts` stays on the
WebSocket and is untouched in substance (it is a WS participant, not a
stdio-host consumer).

**Migration safety net (non-negotiable, every phase):**

1. `bun test plugins/spellbook/skills/bounty` stays green at each phase
   boundary. The pure-helper tests and the real-subprocess E2E tests are the
   regression floor.
2. `join.ts` is exercised by its existing E2E tests every phase — if a phase
   touches the WS broadcast shape, the join tests must still pass.
3. Do **not** delete `bg.ts`/`watch-events.sh`/their tests until the `cli.ts` +
   `/cmd` + `/events` path is proven at parity by new E2E tests (end of Phase
   A).

## Phases

### Phase A — Substrate core (the riskiest; most concrete)

**Goal:** Stand up the persistent daemon + a thin `cli.ts`, with `POST /cmd`
(write, incl. `--stdin`), `GET /state[?lean=1]` (read-back), and
`GET /events?since=<id>` (SSE tail wrapped by Monitor). Retire `bg.ts` and the
file-pump. Resolves **#7** and **#8**; agent-activity idle-touch comes free
(part of **#6**). Keep `join.ts` working.

**Closes:** #7 (apostrophe breakage), #8 (no state readback / ack); partial #6
(idle-touch on agent activity).

**Key Changes:**

- **`scripts/server.ts` → the daemon.** Keep `Bun.serve` (`:332`), the WS
  handlers (`:372–469`), the state mutation helpers (`:214–265`), discovery-file
  write/cleanup (`:505–539`), idle timer (`:569`), and the exit-code contract
  (0/2/124/130). **Add** an HTTP request surface alongside the existing `/`,
  `/ws`, `/assets/` routes (mirror imago `server.ts:897–955`):
  - `POST /cmd` — parse JSON body, `touch()`, dispatch the `AgentCommand` union
    (below) into the existing `apply*` helpers + `broadcast`, return
    `{"ok":true}` (or `400 {"error":"bad json"}`). This replaces the stdin
    JSON-lines reader (`readJsonLines` `:162`, the `for await` loop `:543–567`)
    as the agent's write path — remove that reader.
  - `GET /state[?lean=1]` — return `{ state, cursor }` where `cursor` is the
    current event id (the resume point) and `state` is `BoardState`. `lean=1` is
    the default the CLI uses; for Bounty there are no large blobs to strip, so
    lean ≈ full today, but keep the `?lean=1` shape for house consistency and
    forward-compat. `touch()` on this request (idle-touch on agent reads).
  - `GET /events?since=<id>` — SSE stream. Maintain an append-only
    `events: {id, ...}[]` log with a monotonic `eventSeq` and an `emitEvent()`
    that replays `events` with `id > since` on connect, then pushes live frames
    - a heartbeat comment (`: hb\n\n` every 15s). Mirror imago `emitEvent`
      `:289`
    - `sseResponse` `:514`. Every user-driven WS mutation that today calls
      `emitToAgent(...)` (`:376,396,404,415,439,443,452,461,467` and the
      `closed` at `:577`) now **also** calls `emitEvent(...)` with the same
      payload + an `id`. Keep `emitToAgent`/stdout only if any non-CLI consumer
      still needs it; otherwise the SSE log becomes the single agent-facing
      event channel.
- **`scripts/cli.ts` (new).** Copy-and-adapt grapevine + imago. Stateless; one
  HTTP round-trip per verb; detached `node:child_process` spawn for the daemon
  (the house spawn pattern — imago `cli.ts:152`, grapevine `:263`, with
  `detached:true` + `unref()`; **not** `Bun.spawn`, which can't detach a
  surviving daemon). Discovery via `<tmpdir>/bounty-<id>.json` +
  `bounty-latest.json` (already written by the daemon). Verb list (Phase A
  subset; C/D extend it):

  | Verb                                                            | Maps to                                                    | Notes                                                                                 |
  | --------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
  | `open [--title ..] [--timeout S] [--no-open] [--restore <id>]`  | spawn daemon, await `/state` reachable, print session JSON | mirror imago `cmdOpen` `:139`                                                         |
  | `state [--full]`                                                | `GET /state?lean=1` (or `/state` for `--full`)             | the #8 ack/readback primitive                                                         |
  | `tail [--since N]`                                              | `GET /events?since=N` SSE → JSONL on stdout                | wrap with Monitor; mirror imago/grapevine tail w/ resume-from-cursor + auto-reconnect |
  | `add <title...> [--status ..] [--notes ..] [--stdin] [--id ..]` | `POST /cmd {type:"task.add", task}`                        | `--stdin` reads the title/notes body raw (retires #7)                                 |
  | `update <id> [--status ..] [--title ..] [--notes ..] [--stdin]` | `POST /cmd {type:"task.update", id, patch}`                | `--stdin` for title/notes                                                             |
  | `remove <id>`                                                   | `POST /cmd {type:"task.remove", id}`                       |                                                                                       |
  | `message <text...> [--stdin]`                                   | `POST /cmd {type:"message", text}`                         | toast                                                                                 |
  | `init [--title ..] [--stdin-tasks]`                             | `POST /cmd {type:"init", ...}`                             | seeds the board (replaces the seed `bun -e`)                                          |
  | `close`                                                         | `POST /cmd {type:"close"}`                                 | clean shutdown (exit 0)                                                               |
  | `info` / `sessions` / `help`                                    | discovery readback / list snapshots / usage                | mirror imago                                                                          |

  Discipline: structured payload on **stdout** (one JSON line, `printJson`),
  liveness/echo/diagnostics on **stderr**; never `2>&1` them together. Honor
  exit codes: `2` for bad args (`die`), `0` for a successful verb; `tail` exits
  `0` on a `closed` event. The session-ending exit codes (124 idle, 130 cancel)
  belong to the **daemon** process, surfaced to the agent via the `closed`
  event's `reason` on the tail.

- **`AgentCommand` union (the write contract).** Lift the existing `AgentMsg`
  (`server.ts:65–71`) to the `/cmd` body shape — unchanged in Phase A:
  `init | task.add | task.update | task.remove | message | close`. The daemon's
  `/cmd` handler is the single dispatch point (mirror imago `handleAgentMsg`
  `:350`).
- **Event log shape (the read contract).** Each SSE frame is the existing
  server→agent event payload plus a monotonic `id`: `{id, type, ...}` where
  `type ∈ {ready, connected, disconnected, task.toggle, task.move, task.edit, task.add, task.remove, submit, closed}`.
  `ready` and `closed` bookend the stream (mirror imago `:1034`, `:1090`).
- **Retire the file-pump.** Delete `scripts/bg.ts` and `scripts/watch-events.sh`
  **only after** the new E2E tests below are green. Remove their tests from
  `server.test.ts` in the same commit (the `bg.ts wrapper` describe block,
  `server.test.ts:376–434`).
- **`join.ts` — verify, don't rewrite.** It opens a WS to the daemon and bridges
  to its own stdio; the daemon's WS surface is unchanged, so `join.ts` should
  work untouched. The one thing to watch: the daemon's first WS frame on `open`
  must still be `{type:"init", title, tasks}` (`server.ts:377`) — `join.ts` keys
  its `joined` handshake off that (`join.ts:221`). Do not change that frame.
- **`SKILL.md` + `scripts/template.html` placeholders.** Defer the full SKILL.md
  rewrite to land with the surface/ownership docs, but in Phase A replace the
  retired `bun -e` seed snippet (SKILL.md `~:288`) and the static/monitored-mode
  sections with the `cli.ts` verb walkthrough. The HTML template's
  `__WS_URL__`/`__SESSION_ID__` substitution path (`server.ts:492–495`) stays
  until the Alpine port.

**Validation:**

- [ ] `bun test plugins/spellbook/skills/bounty` green — existing pure-helper +
      WS-broadcast + `join.ts` tests pass unchanged.
- [ ] New E2E in `server.test.ts`: spawn the daemon via `cli.ts open --no-open`;
      `cli.ts add "it's a test — \"quoted\" & <ok>"` lands the literal title
      (verify via `cli.ts state`) — the #7 regression guard.
- [ ] New E2E: `cli.ts state` returns `{ state, cursor }`, and after an
      `add`/`update` the returned state reflects it (the #8 ack).
- [ ] New E2E: `cli.ts tail --since 0` streams JSONL events for a user WS action
      and resumes correctly from a `--since <cursor>` after a reconnect; a
      `closed` event ends the tail with exit 0.
- [ ] New E2E: agent-activity idle-touch — with `--timeout 1`, repeated
      `cli.ts     state` calls keep the daemon alive past the timeout window (no
      exit 124).
- [ ] `join.ts` E2E (existing, `server.test.ts:436–480`) still green against the
      daemon.
- [ ] `bg.ts` + `watch-events.sh` removed; their tests removed; no remaining
      import references.

**Dependencies:** None — this is the foundation.

---

### Phase B — Durability

**Goal:** Debounced snapshot persistence + `cli.ts open --restore` with
merge-over-defaults. Completes **#6**.

**Closes:** #6 (idle-timeout / durability) — combined with Phase A's idle-touch.

**Key Changes:**

- **`$BOUNTY_HOME` snapshots.** Introduce
  `BOUNTY_HOME = process.env.BOUNTY_HOME ?? join(homedir(), ".bounty")`, with
  `snapshots/<session_id>.json` (mirror imago `IMAGO_HOME`/`SNAPSHOTS_DIR`
  `server.ts:52–53`). Add a `snapDirty` flag set by every mutation, a debounced
  snap timer (~1s, mirror imago `:1079`), and a final `saveSnapshot()` on close
  (the resume point is **kept**, not deleted — imago `:1089`).
- **`--restore <id|path>` on the daemon.** Add a `restore` option to the
  daemon's `parseArgs` (mirror imago `:206`). On restore, load the snapshot and
  **merge over `defaultState`** so old snapshots gain any new fields without
  crashing: `state = { title: <arg>, tasks: [], ...snap }`. For Bounty this also
  means filtering restored tasks through `VALID_STATUS` (reuse the `init` guard
  at `server.ts:550`) and backfilling new optional fields (`owner`, `blockedBy`)
  with defaults so a Phase-A/B snapshot restores cleanly under Phase C/D.
- **`cli.ts open --restore <id>` + `cli.ts sessions`.** Wire the `--restore`
  flag through `cmdOpen` to the spawn args (imago `cli.ts:143`). `sessions`
  lists resumable snapshots from `$BOUNTY_HOME/snapshots` (imago `cmdSessions`
  `:295`).
- **No pre-close warning event.** Per the proposal's Resolved Decision, defer
  `closing_soon` — idle-touch + restore make it largely redundant.

**Validation:**

- [ ] `bun test` green.
- [ ] New E2E: open a daemon, seed tasks, let it close (`cli.ts close`); a
      snapshot file exists under `$BOUNTY_HOME/snapshots` (point `BOUNTY_HOME`
      at a tmp dir in the test).
- [ ] New E2E: `cli.ts open --restore <id>` brings the seeded board back —
      `cli.ts state` shows the same tasks.
- [ ] New unit/E2E: a hand-written legacy snapshot **without**
      `owner`/`blockedBy` restores without error and the missing fields default
      cleanly (forward-compat / merge-over-defaults guard).

**Dependencies:** Phase A (daemon + `cli.ts` exist).

---

### Surface — Alpine port (lands before Phase C)

**Goal:** Port the 575-line vanilla-inline-JS `template.html` to Alpine-over-CDN
(the Grapevine tier), so the #9/#10 views (owner badges, per-owner filtering,
blocked rendering) are built **once** on a reactive substrate, not in vanilla
then rewritten. Browser↔daemon stays WebSocket.

**Closes:** No issue directly — it is the prerequisite that makes C and D cheap
and avoids double-building the new views.

**Key Changes:**

- **`scripts/template.html` → Alpine.** Replace the imperative-DOM inline JS +
  the string `.replace()` templating with Alpine reactive bindings over the WS
  state, mirroring `grapevine/scripts/watch.html` (Alpine via CDN `<script>`, a
  single `x-data` store, `x-for` columns/cards, `@click`/drag handlers that send
  WS messages). The board reads `{title, tasks}` from the daemon's
  `init`/`state` broadcast and renders the four columns (To do / Doing / Review
  / Done).
- **WS contract unchanged.** The browser still sends `task.toggle`/`task.move`/
  `task.edit`/`task.add`/`task.remove`/`submit`/`cancel` and receives
  `init`/`task.*`/`message`/`submit`/`cancel` — the daemon's WS handlers
  (`server.ts:372–469`) and `join.ts` are untouched. This keeps the port a pure
  view-layer swap.
- **Serving model.** The daemon serves the HTML verbatim (no bundler, no Vite —
  honor the Bun no-build rule). Keep the
  `__TITLE__`/`__SESSION_ID__`/`__WS_URL__` substitution, or move the WS URL
  discovery into Alpine init reading `location` — match whichever
  grapevine/watch.html does.
- **Assets + palette preserved.** Keep `/assets/` serving (`server.ts:348`) and
  the mammoth palette tokens (assets/README.md). Drag-and-drop between columns
  and inline title edit must survive the port (they are the board's core UX).

**Validation:**

- [ ] Manual smoke (Tier-1): board renders, four columns, drag a card between
      columns, edit a title inline, add + delete a card, submit — all reflected
      to a `join.ts` participant and to `cli.ts state`.
- [ ] `bun test` green — the WS-broadcast E2E tests still pass (they assert the
      wire protocol, which the port does not change).
- [ ] No bundler introduced; the daemon serves the single HTML file.
- [ ] Playwright/browser check optional but recommended given the proposal's
      surface-complexity rationale (owner/blocked views land next).

**Dependencies:** Phase A (daemon serves the surface; WS shape stable). Phase B
not strictly required but ordered before for a clean cut.

---

### Phase C — Ownership + scoping

**Goal:** Add `owner` to `Task`; scoped tail (`--mine` / `--owner <name>`) with
self-echo + stdout/stderr discipline; `review` as the human-facing handoff
signal; light self-claim. Resolves **#9**.

**Closes:** #9 (ownership + scoped subs / notification flood).

**Key Changes:**

- **`Task` gains `owner?: string`** (`server.ts:54–59`). Additive and optional —
  existing tasks and restored snapshots default to no owner. Thread it through
  the `task.add` shape-validation (`server.ts:421–436`), `applyTaskUpdate`
  patches, the surface render (owner badge), and the snapshot.
- **`--as <name>` identity on `cli.ts`.** Mirror grapevine's `resolveAlias`
  (`cli.ts:214`) + a `BOUNTY_AS` env default. `cli.ts add --owner <name>` and
  `cli.ts claim <id>` (sets `owner` to the caller's `--as` identity) — the light
  self-claim path. Assignment is mostly lead-driven (`add --owner`), claim is
  the secondary path, per the Resolved Decision.
- **Scoped tail.** `cli.ts tail --owner <name>` and `--mine` (sugar for
  `--owner <my --as>`). Filtering is **client-side in `cli.ts tail`** (the
  simplest correct cut — the daemon streams all events; the CLI drops events
  whose task `owner` ≠ the filter, except claimable unassigned tasks which
  always pass to a `--mine` watcher). Add **self-echo suppression** (drop events
  the caller's own identity just caused — mirror grapevine `cli.ts:641`) and a
  **grounding line** on first subscribe (grapevine `:616`). Payload on stdout,
  the `# scoped to owner=…` notice on stderr.
- **`review` as the human cue.** No schema change — `review` already exists
  (`VALID_STATUS` `:95`). Make a task entering `review` a first-class event in
  the curated wake-set (it always passes the scope filter to the owner, and the
  surface renders it as the handoff signal). Document the board=state /
  chat=substance workflow convention in SKILL.md.
- **Curated wake-set.** Define the agent-facing event set the way imago's
  `AGENT_EVENT_TYPES` does: which event types wake a scoped watcher vs. which
  are read from `/state` on the next action. `review`-entry and (Phase D)
  `unblocked` are in the wake-set; pure reorders within a column may be
  filtered.

**Validation:**

- [ ] `bun test` green; new unit tests for the owner field on `applyTaskUpdate`
      and the `task.add` validation accepting/rejecting `owner`.
- [ ] New E2E: two `cli.ts tail --owner A` / `--owner B` watchers — a mutation
      to an A-owned task wakes only the A watcher; an unassigned task wakes a
      `--mine` watcher (claimable); self-caused events are suppressed for the
      actor.
- [ ] New E2E: `cli.ts claim <id> --as worker1` sets `owner=worker1`, visible
      via `cli.ts state`.
- [ ] Manual: a task dragged to `review` surfaces as the human handoff cue on
      the surface and as a wake event to the owner.

**Dependencies:** Phase A (cli.ts/tail), Surface (owner badge rendering). Phase
B recommended (owner persists across restore).

---

### Phase D — Dependencies

**Goal:** `blockedBy: id[]` on `Task`, a blocked-state visual cue, an
`unblocked` event in the curated wake-set, and a cycle/self-ref guard. Resolves
**#10**.

**Closes:** #10 (deps + unblocked).

**Key Changes:**

- **`Task` gains `blockedBy?: string[]`** (`server.ts:54–59`).
  Additive/optional; defaults to none on existing + restored tasks.
- **`cli.ts block <id> --on <id>[,<id>…]` / `unblock <id> --on <id>`.** Edit the
  `blockedBy` set via `task.update`. A **cycle/self-ref guard** in the daemon
  rejects an edge that would make `<id>` block itself directly or transitively
  (walk the `blockedBy` graph before applying — reject + return an error rather
  than wedge the board). Self-reference (`x` blockedBy `x`) is rejected
  outright.
- **`unblocked` event.** When a mutation moves a task to `done`, recompute which
  tasks had that task as their **last** remaining blocker; for each
  newly-unblocked task emit `{type:"unblocked", id, owner}` into the event log.
  It is in the curated wake-set, so the owner of a newly-unblocked task is woken
  (mirrors imago's targeted-event approach). Add `unblocked` to the
  `cli.ts tail` scope filter so an owner's `--mine` tail surfaces it.
- **Blocked-state visual.** The Alpine surface renders a blocked task distinctly
  (badge / dimmed / "blocked by N" cue). Convention-only gate — no hard lock on
  moving a blocked task (proposal Out of Scope).

**Validation:**

- [ ] `bun test` green; new unit tests: `block` applies an edge; the cycle guard
      rejects a self-ref and a 2-node and 3-node cycle without mutating state.
- [ ] New E2E: a task with two blockers becomes unblocked only when the
      **second** blocker reaches `done`, and exactly one `unblocked` event fires
      to its owner.
- [ ] New E2E: restoring a snapshot with `blockedBy` edges preserves them
      (durability + forward-compat).
- [ ] Manual: a blocked task renders distinctly on the surface.

**Dependencies:** Phase A (event log/tail), Phase C (owner for targeted
`unblocked`), Surface (blocked rendering). Phase B (persistence of edges).

---

### Branding — Tuskboard → Bounty (fold into any phase)

**Goal:** No live "Tuskboard" string remains in the bounty spell
surface/contract.

**Key Changes:** A `grep -rni tuskboard` over `plugins/spellbook/skills/bounty`
currently returns **no live hits** (the assets README already says "Bounty
Board"). This is a verification + guard task, not a rename: confirm no live
string appears as the daemon, surface, or SKILL.md is rewritten across phases,
and fold any stray occurrence into the touching phase. Historical docs
(CHANGELOG, manifesto, rebrand proposal) are explicitly out of scope.

**Validation:**

- [ ] `grep -rni tuskboard plugins/spellbook/skills/bounty` returns no hits in
      live surface/contract files at project close.

---

## Key Risks & Mitigations

- **Bigger refactor than the issues as filed.** → Phasing (A→D), each phase
  independently shippable. Keep `server.test.ts` green and `join.ts` working at
  every boundary. Don't delete file mode until the daemon path is proven at
  parity (end of Phase A).
- **Regressing a working board during the substrate swap (Phase A).** → The pure
  mutation helpers and WS handlers are reused verbatim, not rewritten — only the
  agent-facing transport changes. New E2E tests assert the
  `/cmd`//state`//events` parity before `bg.ts` is removed. The WS
  `init`-on-open frame is preserved so `join.ts` is untouched.
- **`join.ts` silently breaking** when an event-shape changes (C/D add fields).
  → `join.ts`'s existing E2E tests run every phase; new `owner`/`blockedBy`
  fields are additive and pass through the WS broadcast unchanged.
- **Surface port losing core UX** (drag, inline edit). → Port is a pure
  view-layer swap on an unchanged WS contract; the WS-broadcast E2E tests still
  pass, and a manual Tier-1 smoke covers drag/edit/add/delete/submit. Mirror a
  proven sibling (`watch.html`).
- **Discipline cost (#9): a board that lies is worse than no board.** → The
  workflow convention (card move _is_ the signal) + self-updating workers, plus
  `review` as the explicit human cue, documented in SKILL.md.
- **Cycle wedging (#10).** → A cycle/self-ref guard in the daemon rejects the
  edge before applying; tests cover self-, 2-node, and 3-node cycles.
- **Detached-daemon spawn portability.** → Use `node:child_process` `spawn` with
  `detached:true` + `unref()` (the documented house pattern — imago `cli.ts:147`
  notes why `Bun.spawn` can't detach a surviving daemon). Match the sibling
  spawn
  - discovery-file-readback loop exactly.

## Testing & Validation Strategy

`bun test` is the regression spine (`scripts/server.test.ts`). The existing
tests fall in three groups: pure mutation helpers, protocol-boundary
WS-broadcast E2E (real subprocess), and `join.ts`/`bg.ts` E2E. Strategy per
phase:

- **Extend, don't replace.** Add new `describe` blocks per phase; keep the
  pure-helper and WS-broadcast suites green untouched (they assert the board
  model
  - wire protocol, which the migration preserves).
- **Phase A is the parity gate.** New subprocess E2E must prove `/cmd` (incl.
  `--stdin` quoting), `/state` ack, and `/events` tail-with-resume **before**
  `bg.ts`/`watch-events.sh` and their tests are deleted in the same commit.
- **Durability (B):** point `BOUNTY_HOME` at a tmp dir in-test; assert
  snapshot-on-close and restore round-trip, plus a legacy-snapshot
  merge-over-defaults guard.
- **Ownership (C) / deps (D):** unit-test the new field plumbing + the cycle
  guard; E2E the scoped-tail filtering, self-echo suppression, and the targeted
  `unblocked` fire-once semantics.
- **Surface:** manual Tier-1 smoke (render + drag + edit + add/delete + submit),
  cross-checked against a `join.ts` participant and `cli.ts state`. Playwright
  optional.
- **Exit-code contract** (`0` submit/close, `2` bad args, `124` idle, `130`
  cancel) is asserted at the daemon boundary (existing cancel test at
  `server.test.ts:299` is the template); `cli.ts` exits `2` on bad args via
  `die`.

## Assumptions & Constraints

**Assumptions:**

- Bun is on PATH (the spell's committed runtime; `SKILL.md` Prerequisite).
- The `Task`/`BoardState` model and `apply*` helpers are correct and reusable —
  the migration is transport, not model.
- `join.ts` works against the daemon's unchanged WS surface without code changes
  (verified, not assumed, via its E2E tests each phase).
- Lean ≈ full state for Bounty today (no large blobs); the `?lean=1` shape is
  kept for house consistency and forward-compat, not size.

**Constraints:**

- Bun project: `bun test`, `bun <file>`, `Bun.serve`, no Vite/webpack/bundler.
  The Alpine surface is served as a single static file.
- The detached daemon must use `node:child_process` spawn (not `Bun.spawn`) per
  the house spawn pattern.
- Copy-and-adapt grapevine + imago; do **not** factor a shared lib yet (Resolved
  Decision — premature abstraction across differing domains).
- Format changed `.ts`/`.tsx` with `bunx biome check --write` before committing
  (house style; biome, not prettier).

## Open Questions

Per the proposal, none block. Plan-level details to settle during
implementation:

- **Snapshot cadence:** start with imago's ~1s debounce + final-write-on-close;
  tune only if it shows cost.
- **Scope-filter placement (Phase C):** client-side filtering in `cli.ts tail`
  is the proposed cut (daemon streams all, CLI drops out-of-scope). Revisit a
  server-side `?owner=` query param only if event volume makes client filtering
  wasteful — defer unless measured.
- **Claim ergonomics (Phase C):** `claim <id>` sets `owner` to the caller's
  identity; whether claiming an already-owned task is rejected or reassigns is a
  convention call — default to reject-with-notice unless lead-driven
  reassignment is wanted.
- **Blocked-state visual treatment (Phase D):** dim vs. badge vs. "blocked by N"
  label — a surface judgment call settled when the Alpine views are built.
- **`emitToAgent`/stdout retirement:** confirm no consumer outside the retired
  `bg.ts` reads the daemon's raw stdout before removing it in favor of the SSE
  event log.

---

**Related Documents:**

- [Proposal](./proposal.md)
- Architecture precedent (in-repo): `imago/scripts/{server.ts,cli.ts}`,
  `grapevine/scripts/{cli.ts,watch.html}`
- GitHub issues #6, #7, #8, #9, #10
- [Sessions](./sessions/) (created during implementation)
