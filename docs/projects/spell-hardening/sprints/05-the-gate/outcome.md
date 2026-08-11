# Sprint 05 outcome — The gate

**Sprint:** 05, `the gate` · **Branch:** `fix/spell-hardening-05` · **Base:**
`e65333a` · **Merged:** to `develop` 2026-08-10 · **Released:** ⛔ **NOT** —
held deliberately so 05 and 06 ship together · **Project:**
[Spell Hardening](../../README.md) · [plan.md](./plan.md) ·
[carries.md](./carries.md)

> **✅ WRITTEN AT THE MERGE, NOT AFTER IT.** Sprints 03 and 04 shipped with no
> `outcome.md`; 04's was written four days late, by the same lead, on the day
> this sprint convened. **This is the fourth consecutive opportunity and the
> first one taken on time.** It exists because a cold agent, asked to
> reconstruct the branch, reported that the sprint's own account was
> insufficient — not because anyone remembered.

## Summary

**Part 1 of the project's end condition was drained the same day** (issues #79
#85 #86 #87 #88 #97 closed — fixed in v2.2.0 and never closed). **Sprint 05 is
purely part 2: _the rules exist AND are enforced._**

**Nothing under `plugins/` changed. No spell behaviour ships from this branch.**
This is the enforcement layer and its record.

## Planned vs. Shipped

**Roster-wide conformance suites: 3 → 7.**

| suite                    | status         | what it asserts                                                                                             |
| ------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------- |
| `exit-site-inventory`    | pre-existing   | roster-wide exit inventory                                                                                  |
| `flag-invariant`         | **refactored** | now drives `grimoire/lib/entry-points.ts` instead of its own glob — the glob was a **latent silent filter** |
| `rule-id`                | pre-existing   | every rule carries a stable id                                                                              |
| `strict-parse-invariant` | NEW            | every `parseArgs` invocation refuses unknown flags                                                          |
| `terminator-invariant`   | NEW            | the `--` terminator — **see the half-solved note below**                                                    |
| `roster-drift`           | NEW            | mechanises `ward`'s prose-only drift check                                                                  |
| `gate-honesty`           | NEW            | pins the **16 shipped, hand-authored files (4,166 lines)** that `bun run check` structurally cannot read    |

Plus `grimoire/lib/entry-points.ts` — the shared behavioural enumerator, **with
what it cannot see stated in its own header**.

**33 commits. Gate: 1447 pass / 0 fail / 109 files.**

### ⛔ Three things the plan got wrong about its own deliverables

Found by cold reconstruction at the merge, recorded because a listing that reads
as complete is worse than one that admits a gap:

1. **Row 2 is HALF solved.** `terminator-invariant` solves **promotion** (free
   text → flag name, via `strict: true`). It does **not** solve **demotion** — a
   real flag silently swallowed as a positional, nothing thrown. **That is the
   live half**, and it is `c1`'s actual mechanism.
2. **`strict-parse-invariant` is deliberately NOT the behavioural drive the
   roadmap specified.** It is a structural pin plus a mechanism cell, because a
   daemon outranks a spell's home env var — so a spawning cell in the shared
   gate could write to a live board. **The single most consequential design
   decision in the sprint's code, and it lived only in a test-file comment.**
3. **Row 3 (the exit-code contract) was not cut.** Scoped with its cost named,
   under standing permission to build two and say so rather than round up.

## The two negative results, which are deliverables

- **`null` not `0` is NOT ratifiable as a gate.** Measured over the two files
  the rule was derived from: **0 true positives, 2 false, 26 of 33 scalar
  functions undecidable.** Kept as a corpse with a cause of death in
  `scripts/instruments/type-sentinel-probe.ts`.
- **The failure-side rule is not ratifiable as a biconditional.** Its non-zero
  half convicts astrolabe's **entire error channel — 15 `die(` sites** — an
  unruled canon question, not a defect verdict. **The zero-side half is now
  canon** in `grimoire/outcome-contract.md`.

## Decisions a reader needs

- **Mutation calibration runs in a detached git worktree, never a directory
  copy.** The copy silently ran **30 cells where the real tree runs 46** —
  `roster-drift` generates from files outside the copied subtree, and
  `gate-honesty` needs a real repo. `roadmap.md` amended; the old wording was
  **wrong, not merely loose**, and part of this sprint ran under it.
- **`outcome-contract.md` cannot decay** — the ledger keys on `house-style.md`
  rule-ids. **Stated** in `grimoire/decay-ledger.md` rather than papered over.
- **`?.` erases in a value position and erases nothing in a guard** — and
  **biome requires the erasing form at error severity**, so the canon-compliant
  idiom fails `bun run check`. Live, unresolved conflict between two enforcing
  documents; the exemption is **held pending measurement**, not granted.
- **mind-mapper's undeclared state is intentional** (Cole's ruling). The
  eight-spell roster row was withdrawn as unfounded — it was minted by the lead
  and was the only document in the repo asserting it.

## What was falsified

> ⚠ **TAKEN ON REPORT** — relayed from
> [`.anthill/retro.md`](../../../../../.anthill/retro.md), not re-measured here.

- **H1 — FALSIFIED at convene.** The red arm still convicts one sprint on: the
  **population was never drained, only the six issues were.**
- **H3 — PARTIALLY RUN, NOT TESTED.** Four of seven suites carry **only their
  author's calibration**.
- **`s5-7` — FALSE WHEN FILED.** The teardown guard is session-scoped in every
  installed version back to 1.10.0. **Retracted, not fixed.**
- **The lead was corrected three times on things he had not volunteered**, all
  one shape (WHO vs WHAT), all in his decision loop rather than in a tool.

## What this deliberately does NOT reach

- **No defect is fixed.** Six were found and held out on purpose. Five are
  written up in [`docs/backlog/`](../../../../backlog/); **`s5-9`**
  (`bounty update --stdin` misroutes; `valuesIgnored: null` reports a false
  negative on a data-destroying path) is the most severe.
- **Clause (ii)** — the bidirectional rule↔check link — ruled to sprint 06.
- **The `tsc --noEmit` gate** — its own project, 436 errors measured.
- **`bun run check` still says nothing about its blind set.** `gate-honesty` is
  a **`bun test`** suite; `bun run check` is biome alone and reports 356 files.
  A commit subject on this branch overstates that, and is **corrected forward
  rather than reworded** — eight shas here are cited by the project's own docs.

## Carry-forward

**[`carries.md`](./carries.md)** holds all nine cards **verbatim**, rescued from
the board before teardown. `retro.md` carried `s5-1`–`s5-4` as bare tokens with
no definition anywhere in the tree; sprint 06 would have inherited four opaque
strings. </content>
