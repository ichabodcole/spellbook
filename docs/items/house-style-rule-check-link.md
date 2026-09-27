---
type: item
title: Link every house-style rule to its check, both directions, gated
description:
  "Clause (ii) for house-style.md: each rule names its enforcing ward or 'none'
  with a reason; each grimoire ward names the rule it enforces or its outside
  authority; a ward gates the link both ways."
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: ready
id: 01a0e213-3ab9-728b-a12b-c35b511fc19c
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-27 }
parent: feature/spell-hardening
cycle: 2026-09-filed-is-not-fixed
---

# Link every house-style rule to its check, both directions, gated

Part of [spell-hardening](../features/spell-hardening/feature.md), sprint 06
phase 2.

Clause (ii) of spell-hardening's end condition, scoped by Cole on 2026-09-27 to
**house-style.md only**
([phase-2 scope](../features/spell-hardening/sprints/06-filed-is-not-fixed/phase-2-scope.md)).
All 25 rules already carry gated `rule-id` markers (`grimoire/rule-id.test.ts`);
nothing links them to checks.

**Cole's rulings (2026-09-27):**

- Canon for this item is `house-style.md` only.
- `enforced-by: none` is an acceptable end state for a rule no mechanical check
  can hold, **with a reason**; an empty reason fails.
- A ward enforcing an authority outside house-style cites that authority as-is
  (e.g. seams Contract 21, D43, a dated Cole ruling); it is not promoted to
  canon.

## Definition of done

- [ ] Each of the 25 rule blocks carries
      `<!-- enforced-by: grimoire/<ward>.test.ts[, …] -->` or
      `<!-- enforced-by: none — <reason> -->`.
- [ ] Each `grimoire/*.test.ts` ward carries a header
      `// enforces: <rule-id>[, …]` or
      `// enforces: none in house-style — <authority>`.
- [ ] A ward asserts both directions: every named ward exists and cites the rule
      back; every rule id a ward cites exists and names that ward; no empty
      reason or authority; a zero-denominator guard on each side (25 rules, ≥ 1
      ward), with the population taken from the files, not a hand list.
- [ ] Mutation-calibrated: the ward goes red with a link removed on either side,
      with an empty reason, and with an empty population. Show the red runs.
- [ ] `grimoire/canon-ledger-ward.ts` (an instrument today, not gated) runs in
      `bun test`, keyed on the ledger's id column rather than title matching.
- [ ] The ward states in its header what it cannot see: that a ward actually
      enforces the rule it cites.
