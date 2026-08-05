# Spell Hardening — fix what the shipped spells are getting wrong, then release

**Status:** Approved (scope + execution ratified by Cole, 2026-08-05)
**Created:** 2026-08-05 **Author:** Cole Reed (triaged with Claude Code)

---

## Overview

`bounty` and `grapevine` are the **most-used spells** — every anthill session in
this repo and others leans on them. Ten GitHub issues are open against them,
five filed on 2026-08-05 alone, and the triage that produced this project found
that **three of them actively mislead rather than merely annoy**: they return
plausible, well-formed, wrong results and exit 0.

This project fixes them in a **harm-ordered sequence** and cuts a release, so
teams already depending on these spells get the benefit immediately rather than
waiting on a feature round.

It is deliberately **not** a feature project. Everything here traces to a filed
issue or an existing backlog item.

## Problem Statement

Grouped by what they cost the people using the spells:

**1. Silent wrong data (correctness).** `grapevine pull` and
`bounty state --full` truncate at exactly 64KiB through a pipe, emit unparseable
JSON, and **exit 0**. Agents always read through a pipe, so this is the normal
path, not an edge case. It cut a real session: a joining agent read a channel as
ending at message #68 when it stood at #116, stamped a verdict on that stale
watermark, and the lead read the watermark as evidence the agent had ignored a
briefing — and broadcast that inference before retracting it. **One silent
truncation produced a wrong verdict and a wrong judgement of a teammate.**

**2. Data loss during recovery (integrity).** When the bounty daemon dies,
`open --session-key K` respawns an **empty** board under the same id, and
`close` then writes 0 tasks over the good snapshot, unconditionally, with no
rotation. Two independent sessions on different repos hit the identical sequence
months apart. One lost 10 completed-card histories. **The recovery move is what
destroys the data**, which is why it recurs.

**3. Signals that train their audience to ignore them.** The heartbeat pokes
cards that are legitimately blocked or session-length, so a lead receives alerts
he acts on none of and stops reading the channel. An alert that is correct but
meaningless is worse than the gap it was built for.

**4. Answers to questions nobody asked.** `bounty list` enumerates **boards**,
not tasks, and returns a **plausible zero** — indistinguishable from "your cards
don't exist." One caller was a message away from filing a false defect against a
tool that was working perfectly.

## Proposed Solution

Four phases, ordered by **harm first, and by dependency where it forces the
issue.**

| Phase  | Theme                       | Issues / items                                      |
| ------ | --------------------------- | --------------------------------------------------- |
| **P0** | Silent wrong data           | #77, #78 (+ audit every other spell CLI)            |
| **P1** | Daemon lifecycle + data     | #64, #73, #74, `bounty-daemon-robustness-nits`      |
| **P2** | Bounded reads               | #75 + `bounty-tail-drain` (one flag, both spells)   |
| **P3** | Legibility + honest signals | #79, #72, #11, #76, `bounty-heartbeat-skip-blocked` |

**P0 must go first, and not only because it is the worst.** A bounded
`tail --no-follow` (P2) is a command that prints a payload and exits — **exactly
the shape that loses its tail to the P0 bug.** Shipping P2 first would deliver a
brand-new way to silently lose history.

**P1's internal order is also forced.** #64 (the daemon dies) is the _trigger_;
#73/#74 (recovery clobbers the snapshot) is the _consequence_. But they are
independently worth fixing — an unguarded clobbering `close` is a loaded footgun
even on a daemon that never dies — so P1 does not block on a complete root-cause
for #64.

## Scope

**In scope.** The ten triaged issues, plus three adjacent backlog items that
touch the same code and are cheaper to do in the same pass than to schedule
separately:

- `2026-06-15-bounty-tail-drain` — the bounty twin of #75. **Do them together**
  so `--drain` and `--no-follow` don't become two spellings of one idea.
- `2026-06-15-bounty-daemon-robustness-nits` — R1/R2/#3/#4. **#4 in particular**
  (`tail` retries forever on abnormal daemon death) is the "fails silently" half
  of #64's UX and belongs in the same phase.
- `2026-06-22-bounty-heartbeat-skip-blocked` — **already fully designed and
  approved** (with the dream-flute lead, on the `bounty-heartbeat-design`
  channel). Same family as #76: both are heartbeat false-positives.

**Out of scope.**

- The two 2026-08-05 primitive investigations (context, communication log) —
  research, not release work.
- mind-mapper R13 finalize. Its branch is parked, not abandoned.
- `2026-07-09-bounty-grapevine-skill-review` as a standalone pass — but any
  `SKILL.md` line this project falsifies **must** be corrected as part of the
  change that falsifies it.
- Feature-shaped backlog items: leaderboard, task metrics, sessions filter,
  grapevine rename/edit/presence/facilitation-timer, imago items.

## The two decisions that need a ruling before building

Everything else here has a known fix. These two do not, and they are why this is
a project rather than ten branches.

### D1 — Snapshot safety semantics (P1)

`close` currently overwrites the snapshot unconditionally. Options, not mutually
exclusive: **refuse** to write a materially smaller/empty state over a non-empty
snapshot; **rotate** (`<session>-<ts>.json`, keep N); **restore-on-respawn** by
default when a session key's snapshot is non-empty.

The ruling needs to answer: is the guard a **refusal** (safe, can block a
legitimate emptying) or a **backup-then-write** (never blocks, costs disk)? And
does `open --session-key` hydrate silently, or prompt? A silent hydrate changes
behaviour teams currently rely on for a clean board.

### D2 — The heartbeat card model (P3)

#76 (session-length cards) and `heartbeat-skip-blocked` (#40) are the same
defect class from two directions. Options: a per-card opt-out (`--size none` /
poke-mute), the approved blocked-skip, or **alert on evidence** — no commits by
this owner while holding an in-progress card — instead of elapsed time.

The evidence-based version subsumes both and removes the need for the human to
classify cards correctly up front, but it is the largest change. The ruling
should decide whether P3 ships the approved narrow fix now and leaves evidence-
based poking to a later round, or takes the bigger swing.

## Technical Approach

- **P0's fix is a drained exit, not pagination.** The payloads are already
  complete; only the write is lost. A control in #77 proves it isn't inherent to
  Bun: `anthill comms read` moved 983KB through a pipe intact because its
  success path returns naturally instead of calling `process.exit`.
- **The audit is part of P0, not a follow-up — and it is wider than the two
  reported spells.** A first-pass grep finds the same
  `main → process.exit(code)` shape in **seven** files: the two reported, plus
  `astrolabe`, `glamour`, `imago`, `magpie`, and grapevine's `daemon.ts`. Not
  all of them can emit an over-buffer payload, so the phase confirms per site
  rather than patching blind — but the reported count was two and the real
  exposure is larger. Fix the shape, not the call sites.
- **Regression tests must pipe.** The bug is invisible at a TTY, so a test that
  doesn't read through a pipe cannot catch it. This applies to P0 and to P2.
- **Surface mirrors stay in lockstep by hand.** Anything touching bounty's
  `server.ts` derivations must mirror into `template.html`'s Alpine copy — a
  known drift risk with no test guarding it.
- **Additive and non-destructive.** No snapshot format break; a new snapshot
  layout must still read an old one.
- **Versioning via release-please conventional commits.** No hand-edited
  versions.

## Risks

- **P1 changes recovery behaviour**, which teams have built habits around. A
  silent restore-on-respawn could surprise someone who expects a clean board —
  D1 must decide this deliberately.
- **The bounty surface mirror drifts silently** (P3 touches it). Mitigation:
  name the mirror in the same commit as the server change.
- **P0's audit may find more than two sites**, widening the phase. That is the
  point; better found here than in another session.
- **Scope creep from the backlog.** The three fold-ins are listed explicitly and
  exhaustively; anything else is a new decision, not an extension.

## Success Criteria

- [ ] All ten triaged issues closed or explicitly deferred with a reason.
- [ ] `grapevine pull` and `bounty state --full` return valid, complete JSON
      through a pipe on >64KiB payloads, with a piping regression test each.
- [ ] No spell CLI retains the undrained `process.exit` shape.
- [ ] A `close` cannot silently destroy a non-empty snapshot.
- [ ] Blocked and session-length cards produce no false pokes; genuinely stalled
      cards still do.
- [ ] `bun run check && bun test` green; cold-gate pass by the verify seat.
- [ ] A release is cut and the spells' `SKILL.md` files are true.

## References

- Backlog (the triage): `docs/backlog/2026-08-05-*.md`,
  `2026-07-16-bounty-daemon-idle-death.md`,
  `2026-07-16-bounty-board-ui-polish.md`
- Fold-ins: `2026-06-15-bounty-tail-drain.md`,
  `2026-06-15-bounty-daemon-robustness-nits.md`,
  `2026-06-22-bounty-heartbeat-skip-blocked.md`
- Issues: #11, #64, #72, #73, #74, #75, #76, #77, #78, #79
- Code: `plugins/spellbook/skills/{grapevine,bounty}/scripts/`
