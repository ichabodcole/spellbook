# House-wide: test temp dirs are never torn down

**Added:** 2026-08-08

Found by `cassandra`, `thoth` and `daedalus` during sprint 03's ratify round,
while chasing something else entirely — and **parked by the seat who opened the
thread**, because it is a defect in a different product than the one the sprint
is fixing. See
[sprint 03 decisions A10](../projects/spell-hardening/sprints/03-what-close-takes-with-it/decisions.md).

**Nothing here is a hypothesis.** Every figure was measured, and the three that
were _wrong_ when first published are recorded that way in §Method, because how
they were wrong is the most reusable part of this document.

> **⚠ The first published table was wrong in its headline, and the correction
> inverts it.** Every count below is from the re-measure; the superseded figures
> are kept in §Method rather than deleted. **anthill is not the largest
> population, and `bounty` is not a footnote at 66 — it is the largest
> population in the house at 12,830.**

## What it is

Test fixtures across the house mint temp directories under the system temp root
and **never remove them**. `TEST_TMPDIR` (a sprint-01 line) has no teardown. The
dirs accumulate indefinitely, and one spell's fixtures are indistinguishable
from another's without a prefix scan.

**It bites in three ways, none of them a crash:** it inflates the denominator of
any _"which boards/sessions exist"_ question that scans those paths (see the
sibling `list`/discovery item); it makes a genuine leak invisible inside the
noise; and it is a slow disk cost nobody is watching.

## Measured, 2026-08-08 (corrected sweep)

Directories only, depth 1 **and** 2 under `$TMPDIR`, one `find` per owner prefix
— so a fixture that mints inside a suite root is counted, which is the step the
first sweep skipped:

```sh
find "$TMPDIR" -maxdepth 2 -mindepth 1 -type d -name '<owner>-*' | wc -l
```

| population                             | count      | note                                                                            |
| -------------------------------------- | ---------- | ------------------------------------------------------------------------------- |
| **spellbook, house-wide**              | **15,623** | **1.7× anthill's — the house's largest population is our own**                  |
| ‣ bounty                               | **12,830** | **the single biggest leak anywhere, in the spell the sprint was looking at**    |
| ‣ mind-mapper                          | 1,450      | 20+ distinct fixture prefixes, none with teardown                               |
| ‣ glamour                              | 1,328      | `-persist` 660, `-styles` / `-home` / `-files` 220 each                         |
| ‣ magpie                               | **8**      | **0 from its own fixtures** — the 8 are nested under unattributed `tmp.*` roots |
| ‣ imago / grapevine                    | 4 / 3      | effectively clean                                                               |
| ‣ astrolabe / digestify                | **0 / 0**  | clean                                                                           |
| anthill's own tooling                  | 9,026      | not our repo; filed upstream — see ⚠ below                                      |
| leaked discovery pointers (test suite) | 1,686      | stopped at `d650c97`; a scar, not a wound                                       |

### bounty's 12,830 is two populations, and the split is the actionable part

| sub-population                         | count | dated                         | status              |
| -------------------------------------- | ----- | ----------------------------- | ------------------- |
| top-level `bounty-test-*`              | 7,745 | Jul 21 → **Aug 6 03:35**      | **frozen — a scar** |
| `bounty-suite-*` roots (`TEST_TMPDIR`) | 100   | Aug 6 01:34 → **Aug 8 02:03** | **live — a wound**  |
| nested inside those roots              | 4,985 | ongoing                       | **live — a wound**  |

`TEST_TMPDIR` landed around **Aug 6**, and top-level `bounty-test-*` minting
stops on that date — so the 7,745 are a one-time sweep like the 1,686 pointers.
**The 5,085 live dirs are the actual defect**, and they are the ones the first
sweep could not see, because they live one level below where it looked.

**`magpie` remains the control** — zero from its own fixtures — so this is still
a remediation with a known-good target rather than a design question. Its 8 hits
are `magpie-*-files` directories nested under `tmp.*` roots (260 of those exist,
minted by something we did not attribute), not fixture leaks.

## Acceptance Criteria

- [ ] **Teardown for `TEST_TMPDIR`.** It has none. Every fixture that mints
      under it removes it, or it is minted under a root that is removed
      wholesale. **This is bounty's 5,085 live dirs and it is the largest single
      win available** — one `rm -rf` of the suite root at `afterAll` retires
      both the roots and everything nested in them.
- [ ] **Start with `bounty`, not `glamour`.** The first table pointed this work
      at glamour on a 790-vs-66 reading that was wrong by two orders of
      magnitude. `bounty` is 12,830.
- [ ] **`mind-mapper` needs a prefix-set pass, not a fixture pass.** 1,450 dirs
      across 20+ distinct prefixes
      (`mind-mapper-{actions,anchor,changes,…}-test-`) means the fix is one
      shared helper, not twenty edits.
- [ ] **Adopt magpie's pattern house-wide** — its own fixtures leak zero. Port
      it rather than inventing a sixth approach.
- [ ] **`glamour-styles-*` and `glamour-home` need their own pass.** They are
      **invisible to the ratified `tmpdir()` predicate by design**, so a guard
      written against that predicate will report clean while they grow.
- [ ] **A gate cell, not a convention.** Per the `H-P1` answer ratified in
      sprint 03: a cleanup an author must remember is a definition; the
      un-skippable form fails the suite when a fixture leaks. **Forgetting must
      be red.**
- [ ] **The 1,686 pointers + bounty's 7,745 top-level dirs are a one-time
      sweep**, separate from the fix. Do not conflate the scar with the wound.

## ⚠ Not ours: anthill's 9,026

**Real, but smaller than our own** — 9,026 against spellbook's 15,623, so it is
the second-largest population here and `bounty` alone exceeds it. Routed
upstream by the lead as
[`ichabodcole/anthill#100`](https://github.com/ichabodcole/anthill/issues/100)
via `anthill feedback`, **not** filed here as work (our own findings go to
backlog; the anthill tracker is that project's inbound).

**One correction went with it that is worth keeping here too:** the first draft
of that report said _anthill's tooling_ leaks, implying a runtime defect on
every user's machine. It does not —
`grep -rn mkdtemp scripts/ | grep -v '\.test\.ts'` returns **zero** in anthill
2.0.0. The leak is entirely in anthill's own test suite, so it hits maintainers
and nobody else. **Checking the source before sending is what caught it**, and
it is the same discipline that produced the correction below.

## Method — and the three numbers that were wrong first

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

### The third wrong number — and it is the same failure, in the row that mattered most

Superseded figures, kept deliberately:

| row                   | first published                | corrected  | wrong by     |
| --------------------- | ------------------------------ | ---------- | ------------ |
| `bounty`              | 66                             | **12,830** | **194×**     |
| spellbook, house-wide | 856                            | **15,623** | **18×**      |
| anthill vs spellbook  | "4× all of spellbook combined" | **0.58×**  | **inverted** |
| `glamour-styles-*`    | 951                            | 220        | 4.3×         |
| `magpie`              | 0                              | 8 (0 own)  | claim holds  |

**`bounty` at 66 counted the suite ROOTS and stopped there.** `bounty-suite-*`
really was ~66 directories at first measurement. What the sweep never opened is
that each root contains hundreds of per-test directories — 4,985 of them — and
that a **separate** 7,745 sit at the top level from before `TEST_TMPDIR`
existed.

> **This document's own §Method says the real populations were in
> subdirectories, and then published a number that had not looked in any. The
> `-maxdepth 2` remedy was written down and not applied to the row it was
> discovered for.**

**A remedy stated in prose is not a remedy applied.** Both earlier failures were
_"the instrument could not see the population"_; this one is _"the instrument
was fixed, the fix was documented, and the reading was taken with the old one
anyway."_ That is the sprint's `H-P1` result arriving one more time: **a
correction an author must remember to re-apply is a definition, not a guard** —
which is why the acceptance criteria ask for a gate cell rather than a
convention, and why the reproduction command now sits above the table instead of
in a seat's terminal.

**Caught by re-measuring before quoting the number outward.** The doc was about
to be cited in an upstream issue, and the row that did not survive contact was
the one describing the spell the sprint was named for.
