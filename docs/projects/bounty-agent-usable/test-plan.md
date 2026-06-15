# Test Plan: Bounty — house agent-interface migration

**Status:** Draft\
**Created:** 2026-06-15\
**Related Plan:** [Development Plan](./plan.md)\
**Related Proposal:** [Proposal](./proposal.md)

---

## Overview

This plan verifies the migration of Bounty onto the house agent-interface
pattern (persistent daemon + thin `cli.ts` + `POST /cmd` / `GET /state` /
`GET /events` SSE + snapshot/restore), and the four issue-driven features that
fall out of it (#6 durability, #7 quoting, #8 readback, #9 ownership/scoping,
#10 dependencies), plus the Alpine surface port.

Verification converges on the **proposal's eight Success Criteria** (each Tier-2
scenario traces to one) and the **plan's per-phase validation** sections. The
migration's non-negotiable safety net — `bun test` green every phase, `join.ts`
working throughout, file mode not deleted until the daemon path is proven at
parity — is encoded as Tier-1 regression + Tier-2 parity scenarios. The
substrate is mostly a **transport** swap over an unchanged board model, so the
existing `server.test.ts` suite is the regression floor rather than something
this plan re-derives.

**What this plan covers:** the agent-facing contract (`cli.ts` verbs, the three
HTTP surfaces, scoped tail, persistence) and the board's core UX surviving the
Alpine port. **What it leaves out:** visual-regression/pixel testing, perf
bounds, and unsettled surface/convention judgment calls (deferred in Tier 3).

## Test Environment

**Prerequisites:**

- **Bun on PATH** — the spell's committed runtime (`bun --version`).
- **Run the suite:** `bun test plugins/spellbook/skills/bounty` (the regression
  spine; must be green at every phase boundary).
- **Drive the daemon (manual/E2E):**
  `bun plugins/spellbook/skills/bounty/scripts/cli.ts open --no-open` → prints
  session JSON; then `cli.ts state`, `cli.ts add …`, `cli.ts tail …`,
  `cli.ts close`. The browser surface opens at the daemon's printed URL.
- **Isolate persistence in tests:** point `BOUNTY_HOME` at a tmp dir so snapshot
  scenarios don't touch `~/.bounty`.
- **Format gate before commits:** `bunx biome check --write` on changed
  `.ts`/`.tsx` (house style — biome, not prettier).

**External Dependencies:** None. Bounty is a self-contained local Bun spell — no
third-party services, credentials, API keys, or env beyond optional
`BOUNTY_HOME`/`BOUNTY_AS`.

---

## Verification Scenarios

### Tier 1 — Smoke Tests

_Always required. Cheap checks that the migration doesn't break the floor._

#### T1-01: Regression suite green

**Type:** Unit/Integration\
**Source:** Plan "Migration safety net" (every phase)

**Steps:**

1. `bun test plugins/spellbook/skills/bounty`

**Expected:** All existing pure-helper, WS-broadcast E2E, and `join.ts` tests
pass unchanged. (After Phase A, the removed `bg.ts`/`watch-events.sh` tests are
gone, not failing.)

---

#### T1-02: Daemon boots and is reachable

**Type:** Smoke\
**Source:** Plan Phase A (daemon + `cli.ts open`)

**Steps:**

1. `cli.ts open --no-open` (point `BOUNTY_HOME` at a tmp dir).
2. Observe the printed session JSON + discovery file
   (`<tmpdir>/bounty-<id>.json`).
3. `cli.ts state`.

**Expected:** Daemon spawns detached, `/state` is reachable, session JSON +
discovery file present, no errors on stderr beyond expected diagnostics.

---

#### T1-03: Surface renders (post Alpine port)

**Type:** Smoke\
**Source:** Surface — Alpine port

**Steps:**

1. With a daemon open, load the board URL in a browser.
2. Check the four columns (To do / Doing / Review / Done) render.
3. Open devtools console.

**Expected:** Board renders via Alpine with no console errors; no bundler step
introduced (single static HTML served by the daemon).

---

### Tier 2 — Critical Path

_Each maps to a proposal Success Criterion. This is the real value of the plan._

#### T2-01: State read-back / command ack (#8)

**Type:** Integration (E2E)\
**Source:** Proposal goal: "An agent can run `cli.ts state` and read back
confirmation a command applied — no HTML render, no event-stream inference."

**Steps:**

1. `cli.ts open --no-open`.
2. `cli.ts add "first task"`; then `cli.ts state`.
3. `cli.ts update <id> --status doing`; then `cli.ts state`.

**Expected:** `cli.ts state` returns `{ state, cursor }`; the returned `state`
reflects the add and the status change. `cursor` is the current monotonic event
id.

---

#### T2-02: Arbitrary text via `--stdin` survives quoting (#7)

**Type:** Integration (E2E)\
**Source:** Proposal goal: "The documented append path works with arbitrary text
(apostrophes, metachars) verbatim."

**Steps:**

1. Pipe a title containing an apostrophe, double-quote, ampersand, and angle
   brackets into `cli.ts add --stdin` (e.g. `it's a "quoted" & <ok>` cmd).
2. `cli.ts state`.

**Expected:** The task title is stored **literally**, character-for-character —
no shell truncation, no `Unterminated string literal`, no escaping artifacts.
(The #7 regression guard.)

---

#### T2-03: SSE event tail with resume-from-cursor (#8 / Phase A)

**Type:** Integration (E2E)\
**Source:** Proposal goal: house event channel (`/events`); Plan Phase A tail
validation.

**Steps:**

1. `cli.ts tail --since 0` (wrapped so output is captured).
2. Trigger a user WS action (or `cli.ts add`) and observe a JSONL event line.
3. Drop and reconnect `cli.ts tail --since <last cursor>`.
4. `cli.ts close` the daemon.

**Expected:** Events stream as JSONL on **stdout** (heartbeat/diagnostics on
stderr, never merged); reconnect resumes from the cursor with no lost or
duplicated events; a `closed` event ends the tail with exit 0.

---

#### T2-04: Agent-activity idle-touch (#6, part 1)

**Type:** Integration (E2E)\
**Source:** Proposal goal: "A board survives an agent-heavy idle stretch with no
spurious exit 124."

**Steps:**

1. `cli.ts open --no-open --timeout 1` (1s idle window).
2. Issue repeated `cli.ts state` calls spaced under 1s for several seconds.
3. Then stop and let the window elapse.

**Expected:** The daemon stays alive while agent requests arrive (each `/cmd` /
`/state` calls `touch()`); it exits 124 only after genuine inactivity.

---

#### T2-05: Snapshot-on-close + restore round-trip (#6, part 2)

**Type:** Integration (E2E)\
**Source:** Proposal goal: "restores its full state via one
`cli.ts open --restore <id>` if closed."

**Steps:**

1. `cli.ts open --no-open` (tmp `BOUNTY_HOME`), seed several tasks across
   columns, `cli.ts close`.
2. Confirm a snapshot file exists under `$BOUNTY_HOME/snapshots/<id>.json`.
3. `cli.ts open --restore <id>`; `cli.ts state`.

**Expected:** The restored board shows the same tasks/columns; snapshot is kept
(not deleted) as the resume point.

---

#### T2-06: Scoped tail + self-echo suppression (#9)

**Type:** Integration (E2E)\
**Source:** Proposal goal: "A worker tailing `--owner <name>` / `--mine` is
woken only by its own + claimable tasks … self-echo is suppressed and
payload/liveness are split across stdout/stderr."

**Steps:**

1. Seed tasks: one owned by `A`, one by `B`, one unassigned.
2. Run two tails: `cli.ts tail --owner A --as A` and
   `cli.ts tail --owner B --as B`.
3. Mutate the A-owned task (from a third actor); mutate the unassigned task.
4. As actor `A`, cause an event and watch A's own tail.

**Expected:** The A-mutation wakes only the A watcher; the unassigned-task event
reaches a `--mine` watcher (claimable); events the watcher's own `--as` identity
caused are suppressed from its stdout; the `# scoped to owner=…` notice rides
stderr.

---

#### T2-07: Ownership assignment + claim (#9)

**Type:** Integration (E2E)\
**Source:** Plan Phase C (assignment-first + light self-claim).

**Steps:**

1. `cli.ts add "lead-assigned" --owner worker1`; `cli.ts state` shows
   `owner=worker1`.
2. On an unassigned task, `cli.ts claim <id> --as worker2`; `cli.ts state`.

**Expected:** `owner` is set by `add --owner` (lead path) and by `claim` (sets
owner to the caller's `--as`). Both visible via `cli.ts state`.

---

#### T2-08: `unblocked` fires once, to the owner, on last blocker done (#10)

**Type:** Integration (E2E)\
**Source:** Proposal goal: "its owner receives an `unblocked` event when the
last blocker reaches `done`."

**Steps:**

1. Create task `X` owned by `worker1`, blocked by `B1` and `B2`.
2. Move `B1` → `done`. Observe no `unblocked`.
3. Move `B2` → `done`.

**Expected:** Exactly one `{type:"unblocked", id:X, owner:worker1}` event fires
when the **second** (last) blocker reaches done; it is in the curated wake-set
and surfaces on worker1's scoped tail.

---

#### T2-09: Cycle / self-reference guard (#10)

**Type:** Unit + E2E\
**Source:** Plan Phase D (cycle guard); Risk: "cycle wedging."

**Steps:**

1. Attempt `block X --on X` (self-ref).
2. Attempt a 2-node cycle (`X` on `Y`, then `Y` on `X`).
3. Attempt a 3-node cycle.

**Expected:** Each offending edge is **rejected with an error** and **state is
not mutated** (the board cannot wedge). Valid edges still apply.

---

#### T2-10: Board UX survives the Alpine port, reflected to all consumers

**Type:** UI/E2E (manual)\
**Source:** Proposal goal: house-shape parity; Plan Surface validation.

**Steps:**

1. With a daemon + a `join.ts` participant connected, on the Alpine board: drag
   a card between columns, edit a title inline, add a card, delete a card,
   submit.
2. Cross-check each against the `join.ts` participant's view and `cli.ts state`.

**Expected:** Every action renders correctly on the Alpine surface and
propagates identically to the `join.ts` participant and `cli.ts state`. Drag +
inline edit (the board's core UX) survive the port. Capture screenshots.

---

#### T2-11: File mode retired; `join.ts` intact; house shape complete

**Type:** Integration\
**Source:** Proposal goal: "`bg.ts`, `watch-events.sh`, and the `bun -e` snippet
are retired; `join.ts` still works."

**Steps:**

1. Confirm `scripts/bg.ts` and `scripts/watch-events.sh` are removed and have no
   remaining import references.
2. Confirm `SKILL.md` no longer documents the `bun -e` append snippet.
3. Run the existing `join.ts` E2E against the daemon.

**Expected:** File-pump artifacts gone; `join.ts` E2E green (WS `init`-on-open
frame preserved); agent interface is `cli.ts` + `/cmd` + `/state` + `/events`.

---

### Tier 3 — Edge Cases & Robustness

_Deferred with rationale._

#### T3-01: Legacy snapshot forward-compat (merge-over-defaults)

**Type:** Unit/E2E\
**Source:** Plan Phase B / D (restore merge-over-defaults)\
**Deferred rationale:** Important but narrow — a hand-written pre-`owner`/
pre-`blockedBy` snapshot should restore without error and default the missing
fields. Promote to Tier 2 if restore logic proves fragile during Phase B/D; the
T2-05 round-trip already exercises the common path.

---

#### T3-02: Blocked-state visual treatment

**Type:** Manual\
**Source:** Plan Open Question (surface judgment)\
**Deferred rationale:** Dim vs. badge vs. "blocked by N" is an unsettled surface
decision; functional behavior is covered by T2-08/T2-09. Verify presence of
_some_ distinct cue, defer the exact treatment.

---

#### T3-03: Claim-on-already-owned semantics

**Type:** E2E\
**Source:** Plan Open Question (claim ergonomics)\
**Deferred rationale:** Reject-with-notice vs. reassign is a convention call not
yet settled; default-to-reject is assumed. Test once the convention is fixed.

---

#### T3-04: Server-side scope filtering & scale

**Type:** Integration/Perf\
**Source:** Plan Open Question (scope-filter placement); Risk (event volume)\
**Deferred rationale:** Phase C filters client-side in `cli.ts tail`; a
server-side `?owner=` param and any scale/perf bounds are deferred unless event
volume measurably makes client filtering wasteful.

---

#### T3-05: Visual regression / pixel testing of the surface

**Type:** UI\
**Source:** Surface port\
**Deferred rationale:** The functional manual smoke (T1-03, T2-10) covers the
port; pixel-level regression (and the stray `e2e-1-baseline.png`) is out of
scope for this migration.

---

## Out of Scope

- **Full DAG editor UI for dependencies** — proposal Out of Scope; field + cue +
  `unblocked` signal only.
- **Hard locks on blocked tasks** — convention + cue, not enforcement.
- **React component breakup** — surface targets the Alpine tier.
- **Rewriting historical Tuskboard mentions** (CHANGELOG, manifesto, rebrand
  proposal) — history stays.
- **A shared `cli.ts`/daemon helper library** — copy-and-adapt now, consolidate
  later (Resolved Decision).

---

## Results Addendum

_Filled in during and after execution by the implementing agent._

| Scenario | Status  | Notes                                                                                                                                                                                                                                                                                                                    |
| -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1-01    | Pass    | Phase A: `bun test` green, 38 pass (bg.ts tests removed, not failing)                                                                                                                                                                                                                                                    |
| T1-02    | Pass    | Phase A: `cli.ts open` spawns detached daemon; `/state` reachable; discovery file written                                                                                                                                                                                                                                |
| T1-03    | Pass    | Alpine board renders 4 columns via Playwright, 0 console errors/warnings; SRI-pinned Alpine 3.14.1, single static file (no bundler)                                                                                                                                                                                      |
| T2-01    | Pass    | Phase A E2E: `cli.ts state` returns `{state,cursor}`, reflects add + update                                                                                                                                                                                                                                              |
| T2-02    | Pass    | Phase A E2E: `add --stdin` lands `it's a "quoted" & <ok> $title \`x\`` verbatim                                                                                                                                                                                                                                          |
| T2-03    | Pass    | Phase A E2E: tail streams JSONL, resumes from `--since <cursor>`, `closed`→exit 0                                                                                                                                                                                                                                        |
| T2-04    | Pass    | Phase A E2E: idle-touch keeps daemon alive past `--timeout 1`; exits 124 on real silence                                                                                                                                                                                                                                 |
| T2-05    | Pass    | Phase B E2E: snapshot-on-close under $BOUNTY_HOME; `open --restore <id>` round-trips tasks/columns; original snapshot kept                                                                                                                                                                                               |
| T2-06    | Pass    | Phase C E2E: `tail --owner` wakes on owned, filters others, suppresses self-echo (by===self after scope); `--mine` adds claimable/unowned; lifecycle always passes                                                                                                                                                       |
| T2-07    | Pass    | Phase C E2E: `add --owner` (lead) + `claim --as` (self) set owner; claim on other-owned rejected (stderr + exit 1, via the `/cmd` apply-result), unowned claim succeeds; `update --owner` reassigns. Owner badge browser-verified (cole-approved, bottom-left de-pilled @name)                                           |
| T2-08    | N/A     | Dependencies/unblocked — Phase D                                                                                                                                                                                                                                                                                         |
| T2-09    | N/A     | Cycle guard — Phase D                                                                                                                                                                                                                                                                                                    |
| T2-10    | Pass    | Browser-verified: render/pill-toggle/add/inline-edit/delete/drag(Doing→Done) all round-trip to the daemon; reverse push (agent update + toast) reactive; live join.ts joiner shows identical board. NOTE: wordmark image still reads "Tuskboard" — deferred to follow-up spellbook#11 (backlog W1), does not block merge |
| T2-11    | Pass    | Phase A: bg.ts + watch-events.sh removed, no import refs; SKILL.md `bun -e` snippet gone; join.ts E2E green                                                                                                                                                                                                              |
| T3-01    | Pass    | Promoted to Tier 2 in Phase B: legacy snapshot (no newer fields, one bad-status task) restores filter-and-keep-valid via validateTask + merge-over-defaults                                                                                                                                                              |
| T3-02    | Skipped | [Tier 3 — deferred]                                                                                                                                                                                                                                                                                                      |
| T3-03    | Skipped | [Tier 3 — deferred]                                                                                                                                                                                                                                                                                                      |
| T3-04    | Skipped | [Tier 3 — deferred]                                                                                                                                                                                                                                                                                                      |
| T3-05    | Skipped | [Tier 3 — deferred]                                                                                                                                                                                                                                                                                                      |

**Blocked scenarios:** None expected — no external prerequisites. A scenario for
a not-yet-implemented phase is **N/A until that phase lands** (mark in Notes),
not blocked.

## Visual Artifacts

**Screenshot directory:**
`docs/projects/bounty-agent-usable/artifacts/screenshots/`

**Naming convention:** `<scenario-id>-<description>.png` (e.g.,
`T2-10-alpine-board-drag.png`)

| Scenario | Screenshot                         | Description                    |
| -------- | ---------------------------------- | ------------------------------ |
| T1-03    | `T1-03-board-render.png`           | Alpine board, four columns     |
| T2-10    | `T2-10-alpine-board-drag.png`      | Card dragged between columns   |
| T2-10    | `T2-10-join-parity.png`            | Same state on a `join.ts` view |
| T2-08    | `T2-08-blocked-then-unblocked.png` | Blocked cue → unblocked        |
