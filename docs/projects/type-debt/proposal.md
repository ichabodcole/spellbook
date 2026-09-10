# Type debt — a ratchet, not a sweep

**Created:** 2026-09-10 · **Status:** scoped, not started · **Ruled by:** Cole
**Measured:** 2026-09-10, at `221c13b` (the convergence's last merge)

## The problem, stated once

`bunx tsc --noEmit` reports **584 errors across 69 files**, and **nothing in the
repo reds over any of them.** `bun run gate` is `build && check && test`; the
build is a bundler and does not type-check, `check` is biome, and `bun test`
only reaches a statement a test executes.

That gap was demonstrated end to end in Phase 7: an undefined identifier on an
uncovered path passed the build, passed biome, and passed 2,019 tests, shipping
a latent `ReferenceError` that reached a caller as
`{"kind":"internal","exit_code":1}`. Two lines of `biome.json`
(`correctness/noUndeclaredVariables` + `Bun` as a global) closed **that class**
at zero pre-existing debt. **This project is about the class biome cannot see:
types.**

⛔ **A blocking typecheck gate was RULED OUT in sprint 05**
(`scripts/instruments/type-sentinel-probe.ts:30`), and 584 errors say that was
correct. **This proposal does not reverse it.** It adds a **per-area baseline
that may only go down** — Cole approved that shape on 2026-09-10.

## The measurement

| area            | errors | note                             |
| --------------- | ------ | -------------------------------- |
| `src/grapevine` | 141    |                                  |
| `src/imago`     | 135    |                                  |
| `src/bounty`    | 128    |                                  |
| `src/glamour`   | 49     |                                  |
| `src/magpie`    | 39     |                                  |
| `scripts/`      | 27     | our own tooling                  |
| `plugins/`      | 21     |                                  |
| `src/astrolabe` | 20     |                                  |
| `grimoire/`     | 14     | our own instruments              |
| `src/digestify` | 8      |                                  |
| **`src/kit/`**  | **1**  | the shared code is already clean |

**By aspect:** backend **443**, surface **78**. **By kind:** shipped code
**294**, test files **290**.

**By class — 56% is one flag's consequence.** `noUncheckedIndexedAccess: true`
produces **325** errors (TS2532 ×193, TS18048 ×79, TS2454 ×53): _"object is
possibly undefined"_, _"used before being assigned"_. The rest: TS2345 ×114
(argument type), TS2322 ×52 (assignment), TS2307 ×29 (module resolution), TS2339
×26 (property), TS7006 ×13 (implicit any).

**Two hypotheses tested and killed before scoping:**

- _"Start with the shared code."_ `src/kit/` has **one** error. The instinct is
  right in general and wrong here.
- _"The root tsconfig mis-measures the `@/` surface aliases, so the number is
  inflated."_ Measured: bounty is **126** under its own tsconfig against **128**
  under the root. **Two.** The number is real.

## Rulings

- **R1 — Per-area baseline, monotone down** (Cole, 2026-09-10). Each area
  declares its count; the check fails if the count RISES. Debt is recorded, not
  waived — the house's existing `knownFailures` idiom.
- **R2 — Not a blocking whole-repo typecheck.** Sprint 05's ruling stands.
- **R3 — Read every possibly-undefined; do not silence it.** `arr[i]!` and
  `?? fallback` both make the error disappear and only one is honest. **The
  valuable output is the handful of sites where the undefined was reachable**,
  not the zero.

## Phases

**Phase 0 — the ratchet.** Wire the per-area baseline and prove it: raise a
count, see red; lower it, see green. Nothing is fixed in this phase. ⚠ The
instruments this session repaired went blind in four different ways; assume this
one will too, and obey **D42** — an area it names and cannot examine must say
"not looked at", never pass quietly.

**Phase 1 — our own instruments first (41).** `grimoire/` + `scripts/`. A type
error in the code that CHECKS the code means the check is unproven, and this
session shipped four instrument defects green. Smallest population, highest
leverage, and where the ratchet's mechanics get debugged.

**Phase 2 — digestify (8), the pathfinder.** Cheapest subject; its journal
becomes the pattern the rest follow, exactly as glamour's port produced playbook
Phase B.

**Phase 3 — the long tail** (astrolabe 20, magpie 39, glamour 49), one branch
each, **shipped code before test files**.

**Phase 4 — the three big ones** (bounty 128, imago 135, grapevine 141 = 404),
one branch each. By this point the pattern is known and the surprises are spent.

## Done means

- Every area's baseline is **0**, or its residue is a named ruling with a
  reason.
- The ratchet is green from a clean checkout and **calibrated by mutation**.
- **Every site where `undefined` was genuinely reachable is recorded as a defect
  with its sha** — that list is this project's real deliverable.
- The gate's reach is documented honestly: what biome catches, what the ratchet
  catches, and what still ships unchecked.

## What this deliberately does not reach

- Turning on the stricter flags currently disabled in `tsconfig.json`. A second
  project, after this one reaches zero.
- The surface's 78 errors are in scope but last: they are the least
  agent-facing.
- Re-litigating sprint 05.
