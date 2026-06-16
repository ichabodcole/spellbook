# Bounty house-pattern migration — build + finalize — 2026-06-15

## Context

Bounty (the Kanban board spell, formerly _Tuskboard_) was the last Spellbook
spell still on the old file-pump agent substrate (`bg.ts` + a `tail -F | grep`
Monitor + stdin JSON-lines; in-memory state, no read-back, no persistence; a
`bun -e` seed snippet that broke on apostrophes). This session migrated it onto
the **house agent-interface pattern** Grapevine and Imago converged on — a
persistent daemon + thin `cli.ts` + `POST /cmd` / `GET /state` / `GET /events`
SSE + snapshot/restore — and the five filed issues (#6–#10) fell out of the
migration rather than being patched individually.

Built from the [proposal](../proposal.md), [plan](../plan.md), and
[test-plan](../test-plan.md) (all decision-complete going in). Worktree:
`feature/bounty-agent-usable`, base `develop`.

This was a **two-agent collaboration**: the implementing agent (this session)
and a tech-lead/reviewer agent ("warden") on a Grapevine channel
(`bounty-build`), with the human (cole) steering visual/scope decisions. The
contract-first cadence — pinging warden the contract shape _before_ building
each phase — was the backbone and repeatedly caught design problems before they
cost a rebuild.

## What Happened

The build ran in phases, each gated by a contract checkpoint with warden, TDD
against `server.test.ts`, and `bun test` green at every boundary:

- **Phase A (daemon + cli.ts; #7, #8).** Stood up the HTTP surface alongside the
  old stdin reader (additive), proved a `cli.ts`↔daemon parity E2E green, then
  cut the file-pump (`bg.ts` + `watch-events.sh` + stdin reader) in one commit.
  The **parity gate** held: the old path stayed green next to the new one until
  parity was proven.
- **`/cmd` trust-boundary fix.** Warden's Phase-A diff review caught that the
  agent `/cmd` path cast `body as AgentMsg` and dispatched unchecked. Extracted
  the WS narrowing into a shared `validateTask()` — now the single task-shape
  trust boundary for WS, `/cmd`, and (later) snapshot restore.
- **Phase B (durability; #6).** Debounced snapshot to `$BOUNTY_HOME` +
  `open --restore` with merge-over-defaults.
- **Surface — Alpine port.** Rewrote the 575-line vanilla `template.html` to
  Alpine-over-CDN (Grapevine tier), behavior-preserving, WS contract byte-
  identical. Browser-verified every interaction with Playwright + a live
  `join.ts` cross-check.
- **Submit → "Close board" collapse.** cole's call: the board is a _conjuration_
  ("stands until dismissed"), and the agent now sees every change live, so the
  cantrip-style submit/cancel didn't fit. Collapsed to one dismiss; a contract
  simplification (dropped the submit broadcast + 130/cancel; `join.ts` needed
  zero changes, proving the submit broadcast was redundant).
- **Phase C (ownership/scoping; #9).** `owner` field, `--as` identity, lead
  assign + cooperative `claim`, scoped `tail --owner/--mine`, self-echo
  suppression. cole reviewed the owner-badge visual.
- **Phase D (dependencies; #10).** `blockedBy`, `block`/`unblock` with a cycle
  guard, and an `unblocked` event via a blocked→unblocked transition walk. cole
  reviewed the `⛔ blocked by N` cue.

After Phase D, instead of finalizing, cole + warden ran a **live multi-agent
acceptance test** — the real validation, since #6–#10 originated in a real
multi-agent session, not a failing test. A lead + 2 _cold_ worker agents (given
only the SKILL + the board) drove a real coordination scenario. The experience
delivered cold (both fresh agents used the board correctly with zero narration),
and it surfaced real friction a green suite never would.

## Notable Discoveries

- **The `taskId`/cursor collision (Phase A contract checkpoint).** Imago's
  `emitEvent({id:++seq, ...msg})` works because imago payloads never carry a
  bare `id` — but Bounty's events carry the _task_ id, so the spread would
  clobber the monotonic cursor and silently break resume-from-cursor. Resolved
  by keeping the envelope `id` as the cursor (house-consistent) and renaming the
  task identifier to `taskId` on the net-new agent-facing frames. Caught before
  building on it.
- **Model B event log (Phase A→C).** Whether `/cmd` agent writes emit events was
  a real fork: under "browser-only events," a worker's scoped tail would never
  wake on another agent's `/cmd` change — defeating #9. So the event log
  captures _all_ state changes, with a `by` actor stamp (set up in A, populated
  in C), which self-echo + the scope filter key off.
- **The readback-parity gap (fresh-agent test).** The fleet exposed that the
  _live_ path (`tail`) scoped richly but the _snapshot_ path (`state`) was
  unscoped and un-computed. The load-bearing half: once `state --mine` filters
  to a worker's tasks, a blocker owned by someone else drops out of view — so a
  bare blocked flag leaves the agent "flagged but blind." Fixed with
  `liveBlockers: [{id,title,status}]` derived in `/state`, so a filtered blocked
  task stays actionable.
- **Test-isolation bug.** The suite's `spawnServerReady` helper wasn't setting
  `BOUNTY_HOME`, so e2e tests wrote 80+ snapshots into the user's real
  `~/.bounty`. Fixed + verified (a full run now leaks zero) + cleaned up.

## Changes Made

Net diff vs `develop`: ~3000 insertions / ~1400 deletions across 15 files.
`scripts/server.ts` (daemon), `scripts/cli.ts` (new), `scripts/template.html`
(Alpine rewrite), `scripts/server.test.ts` (71 tests), `SKILL.md` (rewritten to
the cli.ts model). `bg.ts` + `watch-events.sh` deleted; `join.ts` untouched in
substance (only its readiness-discovery in the test helper changed). 12 commits,
one clean chapter per phase + the review/acceptance follow-ups.

## Lessons Learned

- **Contract-first checkpoints earn their keep.** Every pre-build contract ping
  to warden caught something — the id-collision, Model B, claim-visibility, the
  cycle-guard bypass (`blockedBy` settable via raw `update`), the `liveBlockers`
  point. All cheap to settle before building, expensive to unwind after.
- **A green suite is not the experience.** The 71-green suite is what the _old_
  board had too. The fresh-agent acceptance test — cold agents with only the
  docs — found the readback-parity gap and the test-isolation leak that no unit
  assertion surfaced. It also validated the SKILL rewrite (cold agents used the
  board right with zero narration).
- **Visual/scope calls belong to the human.** cole's three calls (the de-pilled
  bottom-left owner badge, the single "Close board" dismiss, the blocked cue)
  each improved the result; surfacing screenshots before committing surface bits
  was the right cadence.

## Follow-up

Non-blocking, tracked in [backlog.md](../backlog.md):

- **W1** — the `wordmark.webp` image still reads "Tuskboard" (grep can't see
  inside a `.webp`); cole deferred to
  [spellbook#11](https://github.com/ichabodcole/spellbook/issues/11). This is
  the documented exception to the "no live Tuskboard" success criterion.
- **F1/F2** — `tail --drain`/`--once` (episodic consume mode) and a `sessions`
  filter/limit (fresh-agent friction).
- **R1/R2** — two benign code nits from the finalize review (stale `prevBlocked`
  entry on delete; non-numeric `?since=` → replay-all).

---

**Related Documents:**

- [Proposal](../proposal.md) · [Plan](../plan.md) · [Test Plan](../test-plan.md)
  (Results Addendum filled) · [Backlog](../backlog.md)
- GitHub issues #6–#10 (closed by this work); follow-up spellbook#11
- Commits `27c6359`…`3206f4b` on `feature/bounty-agent-usable`
