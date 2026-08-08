# House-wide: test temp dirs are never torn down

**Added:** 2026-08-08

Found by `cassandra`, `thoth` and `daedalus` during sprint 03's ratify round,
while chasing something else entirely — and **parked by the seat who opened the
thread**, because it is a defect in a different product than the one the sprint
is fixing. See
[sprint 03 decisions A10](../projects/spell-hardening/sprints/03-what-close-takes-with-it/decisions.md).

**Nothing here is a hypothesis.** Every figure was measured, and the two that
were _wrong_ when first published are recorded that way in §Method, because how
they were wrong is the most reusable part of this document.

## What it is

Test fixtures across the house mint temp directories under the system temp root
and **never remove them**. `TEST_TMPDIR` (a sprint-01 line) has no teardown. The
dirs accumulate indefinitely, and one spell's fixtures are indistinguishable
from another's without a prefix scan.

**It bites in three ways, none of them a crash:** it inflates the denominator of
any _"which boards/sessions exist"_ question that scans those paths (see the
sibling `list`/discovery item); it makes a genuine leak invisible inside the
noise; and it is a slow disk cost nobody is watching.

## Measured, 2026-08-08

| population                             | count     | note                                                                            |
| -------------------------------------- | --------- | ------------------------------------------------------------------------------- |
| **anthill's own tooling**              | **9,001** | **4× all of spellbook combined — and it is not our repo**                       |
| spellbook, house-wide                  | 856       | sum of the spell rows below                                                     |
| ‣ glamour                              | 790       | plus `glamour-home`, see below                                                  |
| ‣ `glamour-styles-*`                   | 951       | **still growing, and invisible to the ratified `tmpdir()` predicate by design** |
| ‣ bounty                               | 66        | the spell the sprint was actually looking at                                    |
| ‣ magpie                               | **0**     | **the control that proves a fix is possible**                                   |
| leaked discovery pointers (test suite) | 1,686     | stopped at `d650c97`; a scar, not a wound                                       |

**`magpie` at zero is the most useful number here** — it is an existence proof
that the fixture pattern can be written correctly, so this is a remediation with
a known-good target rather than a design question.

## Acceptance Criteria

- [ ] **Teardown for `TEST_TMPDIR`.** It has none. Every fixture that mints
      under it removes it, or it is minted under a root that is removed
      wholesale.
- [ ] **Adopt magpie's pattern house-wide** — it leaks zero. Port it rather than
      inventing a sixth approach.
- [ ] **`glamour-styles-*` and `glamour-home` need their own pass.** They are
      **invisible to the ratified `tmpdir()` predicate by design**, so a guard
      written against that predicate will report clean while they grow.
- [ ] **A gate cell, not a convention.** Per the `H-P1` answer ratified in
      sprint 03: a cleanup an author must remember is a definition; the
      un-skippable form fails the suite when a fixture leaks. **Forgetting must
      be red.**
- [ ] **The 1,686 existing pointers + the leaked dirs are a one-time sweep**,
      separate from the fix. Do not conflate the scar with the wound.

## ⚠ Not ours: the anthill 9,001

**The largest population by far is anthill's own tooling, which this repo does
not own.** Routed upstream via `anthill feedback` by the lead as a deduped
outward send — **not** filed here as work, and **not** opened as a GitHub issue
(issues are inbound from other teams; our own findings go to backlog).

## Method — and the two numbers that were wrong first

**Both `thoth` and `cassandra` independently published `1,686`, and both were
counting with a TOP-LEVEL glob.** The real populations were in subdirectories;
the corrected sweep is `find`-based with `-maxdepth 2`, by prefix.

> **Two seats, two instruments, one blind spot — and it is house-style's own
> `63 vs 37` scar, walked past by the seat who owns that rule and by the seat
> who had just cited it.**

**`daedalus`'s hand-built prefix list then missed `glamour-home`**, which is why
`thoth`'s 951 and his 790 disagreed until a wildcard reconciled them. **An
enumeration assembled by hand cannot notice a prefix its author never heard of**
— the same failure as a scrub-list that cannot notice an env var it never heard
of, which bit this team twice in one session.

**Keep the reconciliation, not just the total:** the number is only trustworthy
because two people disagreed about it and found out why.
