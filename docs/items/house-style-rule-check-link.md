---
type: item
title: Link every house-style rule to its check, both directions, gated
description:
  "Clause (ii) for house-style.md: each rule names its enforcing ward or 'none'
  with a reason; each grimoire ward names the rule it enforces or its outside
  authority; a ward gates the link both ways."
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: done
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

- [x] Each of the 25 rule blocks carries
      `<!-- enforced-by: grimoire/<ward>.test.ts[, …] -->` or
      `<!-- enforced-by: none — <reason> -->`.
- [x] Each `grimoire/*.test.ts` ward carries a header
      `// enforces: <rule-id>[, …]` or
      `// enforces: none in house-style — <authority>`.
- [x] A ward asserts both directions: every named ward exists and cites the rule
      back; every rule id a ward cites exists and names that ward; no empty
      reason or authority; a zero-denominator guard on each side (25 rules, ≥ 1
      ward), with the population taken from the files, not a hand list.
- [x] Mutation-calibrated: the ward goes red with a link removed on either side,
      with an empty reason, and with an empty population. Show the red runs.
- [x] `scripts/instruments/canon-ledger-ward.ts` (an instrument today, not
      gated; the path first written here as `grimoire/` was wrong) runs in
      `bun test`, keyed on the ledger's id column rather than title matching.
- [x] The ward states in its header what it cannot see: that a ward actually
      enforces the rule it cites.

## Fixed (2026-09-27)

Commits `97a2b591` (house-style annotations), `5312471b` (ward headers),
`30c7c871` (the ward, and canon-ledger-ward moved into `bun test`).

**Rule side, 25 rules** (rule-id's population: 21 `###` rules and 4 `####`
clauses):

- **5 name a ward.** Each link is partial: the ward checks part of the rule's
  behaviour, never all of it.
  - `name-canonical-handle-name` ↔ `roster-drift`: every shipped spell's folder
    name is the key in the trigger registry and the listings, both ways.
  - `drive-conjuration-through-daemon` ↔ `daemon-lifecycle-ward`: the daemon
    keeps the events connection open (`idleTimeout`), writes its discovery
    pointer atomically, and reads it only on a real ENOENT.
  - `carry-frame-just-value.reference-names-what-refers` ↔ `tail-since-refusal`:
    a bookmark naming an epoch the log cannot check is refused where it is read,
    not applied as a bare id.
  - `spells-are-porting-to-the-build` ↔ `dist-roster-ward` (the built `dist/` is
    committed), `kit-adoption-ward` (the kit is adopted through its stylesheet),
    `spell-css-scope-ward` (every surface declares `source(none)`).
  - `honor-exit-code-contract` ↔ `error-choices-census` (arm 2: an unknown verb
    or flag exits 2 with one `usage` envelope on stderr and empty stdout) and
    `tail-since-refusal` (the same shape, for a refused `--since`).
- **13 are `none — intent`**: architect-reader-s-context,
  reference-don-t-inline, context-attention-budget-exclusions,
  ask-what-number-is-for, start-minimal-subtract-before,
  surface-fit-match-interaction, spell-shared-workspace-design,
  shared-fact-one-state, keep-client-thin-mcp, carry-frame-just-value (the
  container), its response-states and other-party's-channel clauses, and
  enumerate-roster-behaviour-never.
- **7 are `none — checkable, unchecked`**, each saying what a check would
  assert: match-kind-interaction-cantrip, every-spell-ships-feedback, the
  noun-carries-class clause, registry-primitives-variant-extends-recipe,
  surface-dep-cap, carry-bun-gotchas-forward, mature-principle-imperative-plus.

**Ward side, 28 `grimoire/*.test.ts`:** 7 cite rules (the links above); 21 cite
an outside authority as-is: seams Contract 19 / Amendment to Contract 21
(kit-styling, kit-prose); D-numbers (D15 spawn-path, D43 launcher-pairing,
register D7 surface-build-mode); R6 (import-boundary, shipped-skill-references);
T37 (type-check); sprint-05 rows 1 and 2 and s5-P (strict-parse, terminator,
gate-honesty); P0f (exit-site-inventory); dated rulings and findings
(tail-printed-command, tail-rule-parity, origin-guard); the acc standard
(acc-conformance); card a4 (rule-id); the kit-registry move (cli-golden); the
flag invariant's own statement (flag-invariant); decay-ledger.md
(canon-ledger-ward); clause (ii) (rule-check-link).

Three links a prior read suggested were dropped after checking them.
`exit-site-inventory` pins where `process.exit` is called, not which codes are
used. `origin-guard-ward` and `surface-build-mode-ward` enforce things the rules
they were paired with never state.

**canon-ledger-ward** is now `grimoire/canon-ledger-ward.test.ts`, keyed on the
ledger's `Rule id` column. It is green on the real tree (21 top-level rules, 21
rows), so it needed no fix. It reds on a deleted row
(`surface-dep-cap: 0 ledger rows`), on a row keyed on a clause id
(`(a clause id)`), and on a reworded header (the denominator guard,
`Received: 0`).

**Mutation calibration of `rule-check-link.test.ts`**. Each plant was run and
then reverted with `git checkout`:

```
link removed, rule side (honor-exit-code-contract drops tail-since-refusal)   exit 1
  "grimoire/tail-since-refusal.test.ts cites honor-exit-code-contract, which does not name grimoire/tail-since-refusal.test.ts"
link removed, ward side (tail-since-refusal drops reference-names-what-refers) exit 1
  "carry-frame-just-value.reference-names-what-refers names grimoire/tail-since-refusal.test.ts, which does not cite carry-frame-just-value.reference-names-what-refers"
empty reason (`none — ` on architect-reader-s-context)                         exit 1
  "L19 architect-reader-s-context: none with an empty reason"
empty authority (launcher-pairing-ward)                                        exit 1
  "grimoire/launcher-pairing-ward.test.ts: none with an empty authority"
empty rule population (house-style.md truncated)                               exit 1
  the rule population guard: Expected: > 0, Received: 0
empty ward population (glob pointed at a suffix nothing has)                   exit 1
  the ward population guard: Expected: > 0, Received: 0
unknown rule id (roster-drift cites no-such-rule)                              exit 1
  "grimoire/roster-drift.test.ts cites no-such-rule, which is not a house-style rule id"
unknown ward path (a rule names grimoire/no-such-ward.test.ts)                 exit 1
  "name-canonical-handle-name names grimoire/no-such-ward.test.ts, which is not a grimoire ward"
```

The plants were calibrated by their author, which is the gap D6 names. They
still need a no-stake re-calibration.

**2026-09-27, no-stake verifier findings fixed** (`4c577a3d`, `41876232`). L1:
the ward population was the non-recursive `grimoire/*.test.ts`, blind to
`.spec.ts`, `.test.tsx` and subfolders; it is now what `bun test` collects under
`grimoire/`, measured by planting files (Bun 1.4.0 also collects
`.mts/.cts/.mjs/.cjs`). No file newly entered the population. L2: header wording
now says "the first comment block". Links: `enumerate-roster-behaviour-never` ↔
`flag-invariant` is now linked (its walk-vs-glob cell, partial, one population);
`response-states-conditions-was` moves from `none — intent` to
`none — checkable, unchecked`; the thin `drive-conjuration-through-daemon` ↔
`daemon-lifecycle-ward` link is kept as partial, its scope stated in the ward
header since the marker grammar has no note slot; `exit-site-inventory`'s header
now separates P0f (named sprint 01) from card t-a0c6c34a (sprint 03's
classification). Counts now: rules 6 name a ward, 11 `none — intent`, 8
`none — checkable, unchecked`; wards 8 cite rules, 20 an outside authority.
