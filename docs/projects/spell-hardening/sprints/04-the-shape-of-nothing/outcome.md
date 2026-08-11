# Sprint 04 outcome — The shape of nothing

**Sprint:** 04, `the shape of nothing` · **Branch:** `fix/spell-hardening-04` ·
**Base:** `e22b281` · **Merged:** `c2c00a5` to `develop`, 2026-08-10 ·
**Released:** v2.2.0 · **Project:** [Spell Hardening](../../README.md) ·
[plan.md](./plan.md)

> **⚠ WRITTEN LATE — 2026-08-10, at sprint 05's convene, not at sprint 04's
> close.** That is the defect this document is partly about, so it is stated at
> the top rather than buried. See _Why this file was late_ at the end; it is the
> most transferable thing here.

## Summary

**The thesis the whole branch was built against:**

> A consumer must be able to distinguish **"nothing is there"** from **"I cannot
> tell you."**

Across the roster, spell CLIs answered a failed or skipped measurement with the
same shape they used for a real empty result — a count of `0`, an absent field,
a bare `ok:true`. An agent reading that has no way to tell an empty board from a
board it failed to read, or a restore that found no snapshot from one that found
a corrupt snapshot. **The failure surfaces later, as a wrong decision made
confidently, rather than as an error at the seam.**

## Planned vs. Shipped

**16 outcome-contract fixes**, each pinned to a test cell shown able to fail:

| spell         | what changed                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **bounty**    | a restore that FAILED says so (distinct from never-attempted) · keyed respawn restores its snapshot · `init` reports dropped tasks and why · `close` waits for the daemon and says whether it is down · `list` names the noun it counted, and a live board may answer _unknown_ · `state` reads full by default and names its mode · `block` refuses an edge to a task that does not exist |
| **grapevine** | `message_count` is `null` when it did not count, never `0` · `roll`'s version verify can answer _unknown_ and runs on the cold path · a truncated final line no longer destroys the next message                                                                                                                                                                                           |
| **imago**     | `context.add` names its outcome and returns the id it minted                                                                                                                                                                                                                                                                                                                               |
| **glamour**   | `gen.add` returns the id it minted and names its outcome                                                                                                                                                                                                                                                                                                                                   |
| **magpie**    | `element.add` returns the element it created and refuses a malformed one                                                                                                                                                                                                                                                                                                                   |
| **digestify** | a cancelled or timed-out review reports what was observed · every departure is reported, so read-and-declined is distinguishable                                                                                                                                                                                                                                                           |
| **astrolabe** | a benign no-op is success and names the state it found                                                                                                                                                                                                                                                                                                                                     |

**New canon:** `grimoire/outcome-contract.md` — the rules a spell's outcome
envelope must satisfy, with stable rule ids and a ward
(`grimoire/rule-id.test.ts`) that fails four ways. `house-style.md` and the
decay ledger point at it.

**New instruments** under `scripts/instruments/` — the r8 outcome checks (three
generations, kept so the measurement's own evolution is auditable), the canon
ledger ward, and `uncovered-change-check`, which mechanizes _"a change landed
and no cell was added."_ They ship with their filters and their honest
denominators.

## Commits

**100 commits**, `e22b281..c2c00a5`. The 18 code commits:

```
44f6108  grapevine  message_count says null when it did not count, never 0
6fdf2a6  grapevine  a truncated final line no longer destroys the next message
4b92c64  grapevine  roll's version verify can say "unknown", and runs on the cold path
5e6aacd  imago      context.add names its outcome and returns the id it minted
34e8ab2  glamour    gen.add returns the id it minted and names its outcome
78563c6  magpie     element.add returns the element it created, refuses a malformed one
79257d9  digestify  a cancelled or timed-out review says what was observed
fbfe1d3  digestify  report every departure, so read-and-declined is distinguishable
3d863d5  astrolabe  a benign no-op is success and names the state it found
9713733  bounty     a restore that was attempted and FAILED says so
fb209f1  bounty     a keyed respawn restores its snapshot instead of coming up empty
cb25146  bounty     init reports the tasks it dropped, and names why
05d2591  bounty     close waits for the daemon to be down, and says whether it is
3e82b9a  bounty     list names the noun it enumerated; a live board can say unknown
0c19304  bounty     state reads FULL by default and says which mode answered it
39b4310  bounty     block refuses an edge to a task that does not exist
2a56e46  grimoire   every rule carries a stable id, and a ward that fails four ways
2b36726  instruments mechanize "change landed, no cell added"
```

**History was preserved deliberately** — 15 shas are cited by the project's own
docs and five seats hold `Anthill-Seat:` attribution. `land-check` refused a
squash, correctly.

## Decisions a reader needs

- **`null` is not absent.** A field present-and-null means _measured, and the
  answer is nothing_; an absent field means _the question was never asked_.
  Tests assert it with `"key" in envelope`, never `toBeUndefined()`.
- **Nouns over booleans.** An outcome names the state it found rather than
  answering true/false — **a noun emitted on only ONE branch of a decision
  cannot carry which branch was taken.**
- **Cells are mutation-calibrated.** Every new guard was shown to fail against a
  reconstructed pre-fix tree before being counted as a guard.

## What Was Falsified

Recorded in full in [`.anthill/retro.md`](../../../../../.anthill/retro.md); the
load-bearing ones:

- **Care and agreement are a trap that implausibility does not catch.** Two
  seats, independent methods, agreeing — and inverted. The split broke only when
  someone read where the noun is _emitted_ rather than counting nouns.
- **A probe is a lossy sample of a comparison you can do exactly.** Four
  false-MISSING probes across two read-backs, zero real losses. Every seat
  verified its land with a lossy instrument while holding an exact one.
- **The lead published four unmeasured claims at ruling strength**, including
  `c1`'s denominator. A relay from a lead does not look like a relay.

## Carry-Forward

`c1` (the `--` terminator sweep) · `s5-1` (bounty's boolean vs the contract's
nouns, blocked on the noun set) · `s5-2` (WHO vs WHAT) · `s5-3` (the
null-vs-absent allow-list, deliberately left cold) · `s5-4` · `s5-5` · `s5-6` (=
`spellbook#98`) · `s5-7`.

**All eight are open questions with recorded evidence, not unfinished work.**

## What it deliberately does NOT reach

- **Markdown canon is ungated by default.** `bun test` reads the specific
  markdown files some cells name; nothing reads the rest. **This is a gap, not a
  property** — and it became sprint 05's `s5-P`.
- **`s5-3` was carded UNRESOLVED, not decided.** Three measured positions with
  their evidence; the ruling left cold on purpose.

## Why this file was late — and it is the sprint's own thesis, turned on the sprint

**Sprints 03 and 04 both shipped with no `outcome.md`**, while
`docs/projects/TEMPLATES/SPRINT-OUTCOME.template.md` had been on disk since
2026-08-06. The container was authored here, deliberately, and then not filled
twice.

For four days sprint 04's only account lived in the merge body `c2c00a5` and in
`.anthill/retro.md` — **neither reachable from `docs/`.** The project README
carried **two ⚠ warnings** naming the absence, the second written on 2026-08-10
in a commit whose own body said _"naming the gap in the README is not a
substitute for the artifact; it is the marker that one is owed"_ — and that
commit did not produce the artifact either.

**The finding, which is
[`the unclosed unit`](../../../../backlog/2026-08-10-the-unclosed-unit.md):**

> Documenting an omission is not producing the artifact, and it **feels like**
> discharging the obligation. Nothing downstream can tell the difference between
> the record of a gap and the thing the gap is in.

It kills the two remedies a maintainer reaches for first. **A reminder cannot
help** — all five recorded instances already had one, and in two of them the
person writing the reminder was the person omitting the artifact. **A
disjunctive gate cannot help** — _"outcome written, **or** the deviation
recorded"_ passes **5 of 5**.

**Note the shape against this sprint's own thesis.** Sprint 04 taught seven
spells to distinguish _"nothing is there"_ from _"I cannot tell you."_ Its own
absent `outcome.md` was exactly the first shape masquerading as the second: the
tree said nothing, and nothing said whether that meant _no account exists_ or
_the account lives somewhere unreachable_. **The sprint shipped the fix to the
roster and not to itself.** </content>
