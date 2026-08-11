# Sprint 05 — The gate

**Created:** 2026-08-10 (retroactively, **during** the sprint — see the warning
below) · **Status:** 🟢 ACTIVE — convened 2026-08-10 on `fix/spell-hardening-05`
· **Base:** `e65333a` · **Project:** [Spell Hardening](../../README.md) ·
[roadmap.md](../../roadmap.md) · **Predecessor:**
[sprint 04 outcome](../04-the-shape-of-nothing/outcome.md)

> **⛔ THIS SPRINT RAN WITHOUT A PLAN DOCUMENT AND THIS FILE IS NOT ONE.**
>
> Sprint 05 was convened, scoped, and built to ten commits **with no `plan.md`
> in the tree.** It ran from three things that were never in `docs/`: the
> roadmap's sprint-05 forecast, a scope ruling Cole gave in conversation, and
> cards on a bounty board that will be torn down.
>
> **The gap was found at finalize, by the docs-of-record sweep, not by anyone
> noticing during nine hours of work.** This file exists to close the container
> in real time rather than four days later — which is exactly what
> [sprint 04's outcome](../04-the-shape-of-nothing/outcome.md) was written about
> **today**, by the same lead, hours earlier.
>
> **That is three consecutive sprints, and this one had the finding in front of
> it.** See
> [`the unclosed unit`](../../../../backlog/2026-08-10-the-unclosed-unit.md).
> Recording it rather than quietly authoring a plausible plan, because a
> retroactive plan is a document claiming a ratification that never happened.

## The scope, as ruled — not as planned

**Ruled by Cole, 2026-08-10, in conversation.** The sprint held this boundary
for nine hours and **six items were held out of it**, which is the only evidence
that the boundary was real.

**IN:**

| #   | lane                                                                                                                                                 | seat      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| (a) | **the harness** — share `flag-invariant`'s behavioural enumerator; mechanise the three behavioural rules; mutation-calibrate every cell              | daedalus  |
| (b) | **the restatement** — turn the two intent-bearing rules (`null` not `0`; a no-op is not a failure) into structural predicates. **Own ratify round.** | thoth     |
| —   | **prose gating** — nothing reads `house-style.md`                                                                                                    | thoth     |
| —   | **calibration** — every new cell mutation-checked by a second seat (retro H3)                                                                        | cassandra |
| —   | **no lane, by design** — testing retro H4                                                                                                            | circe     |

**OUT, and both were ruled explicitly because both would feel like they
belonged:**

- **Clause (ii)** — the bidirectional rule↔check link. **Moved to sprint 06.**
- **The `tsc --noEmit` gate.** Measured at **436 errors**, 61% from
  `noUncheckedIndexedAccess`. Its own project:
  [`typecheck-gate-is-a-project-not-a-flag`](../../../../backlog/2026-08-10-typecheck-gate-is-a-project-not-a-flag.md).

## What the sprint is against

**Part 1 of the [end condition](../../roadmap.md) is DRAINED** — issues #79 #85
#86 #87 #88 #97 shipped in v2.2.0 and were closed 2026-08-10. They had been
fixed and left open, which is why this project's defect count read worse than it
was.

**Sprint 05 is purely part 2: _the rules exist AND are enforced._**

## What landed

Ten commits on `fix/spell-hardening-05`. **The deliverable is legible in one
listing** — roster-wide conformance suites went from **3 to 7**:

```
grimoire/exit-site-inventory.test.ts      pre-existing
grimoire/flag-invariant.test.ts           pre-existing
grimoire/rule-id.test.ts                  pre-existing
grimoire/gate-honesty.test.ts             NEW — the gate states what it CANNOT see
grimoire/roster-drift.test.ts             NEW — would have caught mind-mapper shipping undeclared
grimoire/strict-parse-invariant.test.ts   NEW — row 1: unknown flags refuse
grimoire/terminator-invariant.test.ts     NEW — row 2 / c1: the `--` terminator
```

Plus `grimoire/lib/entry-points.ts` — the shared behavioural enumerator, with
**what it cannot see stated in its own header**.

> **⛔ H3 IS PARTIALLY RUN, NOT DISCHARGED — and the claim above is weaker than
> its listing looks.** Retro H3 proposed that a **second seat** mutation-checks
> each seat's cells. `cassandra` calibrated `flag-invariant` (finding its green
> no-op) and `s5-8`/C′ — and then spent the rest of her budget on _why the
> mandated harness disagreed with itself_ (see the roadmap amendment).
>
> **Uncalibrated by a second seat:** `terminator-invariant` (4 cells) ·
> `strict-parse-invariant` (3) · `roster-drift` (17) · `gate-honesty` (5).
> **They carry their AUTHORS' calibrations, which is what H3 exists to
> supplement and does not replace.**
>
> Four of the seven suites have **one pair of eyes each**. Recorded here rather
> than in the retro alone, because the listing above reads as seven equally
> warranted wards and it is not.

**Not cut:** row 3 (the exit-code contract). Standing permission was given to
**build two and say so** rather than round up to three.

## The two negative results, which are deliverables

- **Arm 2 (`null` not `0`) is NOT RATIFIABLE as a gate.** Measured, not
  reasoned: over the two files the rule was derived from, **0 true positives, 2
  false, 26 of 33 scalar functions declared blind.** The roadmap's
  `⛔ not as written` row is now backed by a run. **Sprint 06 inherits a corpse
  with a cause of death rather than an untried item.**
- **C′ is not ratifiable as a biconditional.** Its non-zero-side clause convicts
  astrolabe's entire error channel — **15 `die(` sites** — which is an undecided
  canon question, not a defect verdict. The **zero-side half survives** and
  convicts `s5-8` cleanly.

## Held out of scope — six, all real, none absorbed

`s5-5` · `s5-6` (#98) · `s5-8` (astrolabe close) · **mind-mapper undeclared and
shipped** · `STALE DIST` fires unconditionally · **`s5-9`**
(`bounty update --stdin` misroutes and `valuesIgnored: null` reports a false
negative on a data-destroying path — the highest-severity of the six).

**Five are written up in [`docs/backlog/`](../../../../backlog/); `s5-9` was
found late and is carded.** All await Cole.

## What this sprint does NOT reach

- **Clause (ii)** — sprint 06, ruled.
- **The typecheck gate** — its own project, ruled.
- **Row 3** — not cut; scoped with its cost named.
- **The population classification.** The r8 RED set (113 rows, inflated by a
  by-name mutator list) remains **unclassified by everyone**. Nobody turned it
  into a scope number.

---

_Container created at finalize, 2026-08-10. **The absence of this file for nine
hours is the record**; it is not being written as though it had been here._
</content>
