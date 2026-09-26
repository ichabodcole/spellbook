---
type: cycle
title: "Spell hardening 06: filed is not fixed"
description:
  "Spell-hardening's sixth sprint: drain the fix queue the project filed, then
  gate the rule-to-check link (clause ii)."
tags: [spell-hardening, conformance]
status: draft
lifecycle: planned
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
  (`c1`): the `--` terminator no longer swallows `--session-key`: row 2's
  demotion half.

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

_Written at close, not before._

## Sessions
