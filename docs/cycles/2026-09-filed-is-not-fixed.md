---
type: cycle
title: "Spell hardening 06: filed is not fixed"
description:
  "Spell-hardening's sixth sprint: drain the fix queue the project filed, then
  gate the rule-to-check link (clause ii)."
tags: [spell-hardening, conformance]
status: draft
lifecycle: closed
appetite:
  Stop when the phase-1 fix queue lands; phase 2 (clause ii) runs only if phase
  1 left room, and is cut, not compressed, if it did not.
after: []
generated: { by: claude-opus-5-5, at: 2026-09-26 }
---

# Spell hardening 06: filed is not fixed

The sixth sprint of [spell-hardening](../features/spell-hardening/feature.md),
scaffolded 2026-08-11 and never convened. Its plan, **unratified**, is
[sprints/06-filed-is-not-fixed/plan.md](../features/spell-hardening/sprints/06-filed-is-not-fixed/plan.md):
the phase ordering, the two design calls phase 1 cannot start without, and the
five falsifiers the convene should shoot at first. This cycle is the index over
that work; the plan stays the argument.

## Why now

Cole ruled the shape on 2026-08-11: **fixes first, then the gate**, one cycle,
phase-ordered. The fix queue had been deferred by four consecutive scope
rulings, one of its items is another team's open issue (`#98`), and one destroys
data at `ok:true`. The thesis, which the plan marks as its most falsifiable
claim: a finding that is filed is not a finding that is fixed, and a rule that
is written is not a rule that is enforced.

## Scope

**Phase 1: the fix queue.** Every item was found by this team and filed with a
measurement. Phase 2 does not start until phase 1 lands.

- **[item/bounty-update-stdin-misroutes-to-title](../items/bounty-update-stdin-misroutes-to-title.md)**
  (`s5-9`) and
  **[item/bounty-notes-clear-vs-empty-substitution](../items/bounty-notes-clear-vs-empty-substitution.md)**
  (`s5-5`): `bounty update` stops misrouting `--stdin` and tells a deliberate
  clear from an empty substitution. Possibly one repair; the plan's design call
  1 decides.
- **[item/bounty-tail-unresolvable-target-retries-forever](../items/bounty-tail-unresolvable-target-retries-forever.md)**
  (`s5-6` / `#98`, inbound): a tail that resolves no board fails instead of
  retrying forever at exit 0.
- **[item/astrolabe-close-exits-zero-with-error-envelope](../items/astrolabe-close-exits-zero-with-error-envelope.md)**
  (`s5-8`): `astrolabe close` exit code and envelope agree.
- **[item/terminator-eats-session-key](../items/terminator-eats-session-key.md)**
  (`c1`; went to [2026-09-acc-conformance](./2026-09-acc-conformance.md) and
  came back on 2026-09-26: acc fixed the root-level hazard, and what is left, a
  flag-shaped positional after `--`, is product behaviour, see the item): row
  2's demotion half.

**Phase 2: clause (ii)**, cut rather than compressed if phase 1 eats the cycle.
Items get filed at the convene, once the ratify round has had its shot: the
rule-to-check link both directions and gated, second-seat calibration (D6), the
decay-ledger key ([D2](../items/outcome-contract-cannot-decay.md)), D1, D3, D4,
D5, and row 3 (the exit-code contract), which is the first thing to drop.

Out of scope, deliberately: `s5-1` (a wire question that is Cole's), `s5-3`,
`s5-2`/`s5-4` (anthill feedback, not spellbook code), the
[`tsc --noEmit` gate](../items/typecheck-gate-is-a-project-not-a-flag.md) (its
own project), the r8 RED-set classification, and mind-mapper's packaging
question (Cole's). The stale-dist item the plan listed has since shipped
(`done`).

## Outcome

Closed 2026-09-27. Both phases shipped; phase 2 was re-scoped by measurement
before it started, and by Cole's canon rulings. The decision log with every
option not taken is at the bottom of
[the plan](../features/spell-hardening/sprints/06-filed-is-not-fixed/plan.md).

**Planned vs. shipped.**

- **Phase 1, all five shipped** (named merge `b12c07bc` on `develop`): `s5-9` +
  `s5-5` (`bounty update` refuses empty values and `--stdin` with `--title`;
  `--clear-notes`; the envelope names the fields it wrote), `#98` (`bounty tail`
  names what it looked for; a named target that never resolves exits 5), `s5-8`
  (`astrolabe close` with nothing to close is a no-op, and waits until down),
  and `c1`'s demotion half (the registry warns on a row-accepted flag after
  `--`: warned, not refused, by ruling).
- **Phase 2, three items shipped** (this merge): the canon pass (D3, D4 measured
  zero, D5, row 3's rule text, Boundary 3), terminator-invariant rewritten over
  the registry plus D6's calibration of four wards, and the house-style rule ↔
  check link, gated both ways.
- **Not done:** D1's build (a nine-spell wire change), D2 and outcome-contract's
  rule ids ([backlog](../items/outcome-contract-rule-ids.md), by Cole's
  house-style-only scope), row 3's session-ending ward (dropped first, as
  planned). None of the six same-class finds filed to triage was fixed here.

**What was falsified.**

- The plan's fix queue was measured in August; the acc cycle had since rewritten
  the parsers. The re-measure found three of five in a changed shape (`#98` half
  fixed with a new false "closed" claim; `s5-5` wider than filed; `c1`'s root
  half refused by Bun, not by the registry).
- Falsifier 1 ("`s5-9` and `s5-5` are one repair") half held: two edits in the
  same four lines, one implementer.
- Falsifier 3 ("clause (ii) cannot enumerate its rules") **did not fire** for
  house-style: sprint 04's gated rule ids had already fixed it. It does hold for
  every other canon doc.
- Five premises of the plan's Phase 2 were wrong on arrival (listed in
  [phase-2-scope.md](../features/spell-hardening/sprints/06-filed-is-not-fixed/phase-2-scope.md)):
  `c1`'s 7/16 entry points are now one parser; D6's cell counts; row 3's failure
  half was already built; D5 was already ruled (D52); outcome-contract has no
  rule ids.
- The canon pass's claim that the stderr warning **meets** Boundary 3 was wrong;
  it half meets it, deliberately (`1d857849`).
- **The author-calibrated wards were not calibrated.** A no-stake second seat
  planted its own defects against the rewritten terminator-invariant and the new
  rule-check-link: the terminator ward missed the `c1` bug's own shape (a flag
  after text after `--`), aliases, adopters imported under another name or
  outside `backend/`, a non-literal `allowPositionals`, and import side effects;
  the link ward's population missed files Bun collects. All were fixed
  (`4c577a3d`..`025c0e90`, `7aca0af0`) and re-planted: caught. D6's thesis held
  on the wards this cycle wrote itself.

**What was verified, and how.**

- **Pinned by tests:** each phase-1 behaviour (bounty CLI and tail integration
  tests, astrolabe CLI tests, registry tests, golden snapshot); the two phase-2
  wards, mutation-calibrated by their authors and then by a no-stake seat in a
  detached worktree (terminator-invariant 10 cells over 761 warning cases and
  115 no-warning cases; rule-check-link over 25 rules and 28 wards).
- **One-off runs:** the phase-1 re-measure and no-stake verification on the
  shipped launchers under a scratch `HOME` (it broke one claim, `fields` naming
  a dropped status write, fixed in `d8ba0578`); D6's four-ward calibration
  ([d6-calibration.md](../features/spell-hardening/sprints/06-filed-is-not-fixed/d6-calibration.md));
  the canon's exit-code facts spot-checked against source.
- **Gate:** full `bun run gate` green at each landing (2976 at phase 1; 2993 at
  phase 2, after `7aca0af0`).

**Carried over.** None of this cycle's items carries. Filed and not scheduled:
the six same-class triage bugs (`bounty init --stdin-tasks` wipes a live board;
`open --restore <missing>` exits 0; `astrolabe status` spawns a daemon when
refusing; `add --stdin` drops the positional; a closed board answers `tail` two
ways; the stale-port item, covered by `s5-8`'s fix and left to triage), and
[outcome-contract-rule-ids](../items/outcome-contract-rule-ids.md). The rule ↔
check link leaves 8 rules `none — checkable, unchecked`, each stating the check
it lacks: that is the next ward work, if anyone wants it.

## Sessions
