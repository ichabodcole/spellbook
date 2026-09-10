# `outcome-contract.md` has no decay-ledger row, and structurally cannot get one

**Filed:** 2026-08-10 · **Found by:** `thoth`, sprint 05 finalize (deferral D2)
· **Status:** open, unsized · **Horizon:** sprint 06 · **Measured:** 0 mentions
of `outcome-contract` in `grimoire/decay-ledger.md`

## The measurement

```
grep -c "outcome-contract" grimoire/decay-ledger.md   ->  0
```

`grimoire/outcome-contract.md` is **ratified canon** — it carries the rules a
spell's outcome envelope must satisfy, it was extended twice during sprint 05
(the failure-side explanation; the `?.` guard-vs-value precision), and
`grimoire/rule-id.test.ts` gates its rule ids.

**It has no row in the decay ledger, and it cannot get one as the ledger is
currently keyed.** The ledger indexes on `house-style.md` rule-ids. An entire
canon file therefore sits outside the mechanism this project uses to notice that
a rule has gone stale.

## Why this is not "add a row"

**The ledger's unit is a `house-style.md` rule.** `outcome-contract.md` is a
sibling canon file with its own rule-ids, so the question is not a missing entry
— it is **what the ledger's coverage is over**, and whether canon files other
than `house-style.md` are in its domain at all.

That is a decision about the ledger, not a fix to a file, which is why it is
filed rather than patched.

## Why it matters more than a bookkeeping gap

This project's own thesis is that **a rule which exists and is not enforced is
not a rule.** The decay ledger is the instrument for a narrower version of the
same failure: _a rule that was true when written and is not re-walked._

So the situation is: **the canon file created to fix the unenforced-rule problem
is itself outside the instrument that detects unrewalked rules.** Same shape,
one level up — and it went unnoticed for the file's whole life because **nothing
anywhere reports which canon files the ledger does not cover.**

⚠ **A ledger that silently ranges over one file of several reports full coverage
of the set it happens to index.** That is clause (i) of the project's own end
condition — _a gate must state what it cannot see_ — arriving in the ledger
instead of the gate.

## What this item is NOT asking for

No recommendation between "widen the ledger's key", "give `outcome-contract.md`
its own ledger", or "rule that sibling canon files are out of the ledger's scope
and say so in the ledger". **All three are defensible and the choice needs a
design pass** — it belongs to whoever owns the grimoire tooling, not to the seat
that measured the zero.

## Provenance

Deferred deliberately at sprint 05 finalize with the reason stated: measured
during the sprint, **out of the s5-P lane's scope**, and it is the ledger's
coverage question rather than a canon-content question.

**Filed because it existed nowhere but a comms message**, and a finding that
lives only on a wire nobody re-reads is
[the unclosed unit](./2026-08-10-the-unclosed-unit.md) — which this session
produced as a finding three separate times. </content>
