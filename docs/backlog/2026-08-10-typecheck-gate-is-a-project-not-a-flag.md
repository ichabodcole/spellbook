# The typecheck gate is a project, not a flag

**Filed:** 2026-08-10 · **Status:** open, unsized · **Source:** measured while
executing
[`docs/reports/2026-08-10-project-status-sweep.md`](../reports/2026-08-10-project-status-sweep.md)
· **Supersedes the framing in:** `docs/projects/spellbook-coherence/proposal.md`
Deliverable 3

## The measurement

`spellbook-coherence` has carried "Deliverable 3 — wire a `tsc --noEmit`
typecheck gate into `check`" as a **blocker** for months, and two independent
reads (the sweep's `docs-curator`, then me) both downgraded it to a two-line
known fix on the same reasoning: `tsconfig.json` already sets `strict: true`, so
the code must already be clean; only the wiring is missing.

Then it was run.

```
$ bunx tsc --noEmit ; echo $?
2
$ grep -c "error TS" tsc.log
436
```

| area                      | errors |
| ------------------------- | ------ |
| `imago/tests`             | 98     |
| `grapevine/scripts`       | 74     |
| `bounty/scripts`          | 68     |
| `astrolabe/scripts`       | 39     |
| `magpie/tests`            | 29     |
| `scripts/instruments`     | 27     |
| `glamour/tests`           | 23     |
| `imago/scripts`           | 17     |
| `grimoire`                | 11     |
| _(remainder spread thin)_ | ~50    |

**Every spell in the roster is affected.**

## The cause is one flag, and it is not `strict`

| code      | count | meaning                   |
| --------- | ----- | ------------------------- |
| `TS2532`  | 189   | object possibly undefined |
| `TS2345`  | 92    | argument type mismatch    |
| `TS18048` | 78    | value possibly undefined  |
| `TS2322`  | 32    | type not assignable       |

**267 of 436 — 61% — are the "possibly undefined" pair**, and they come from
`"noUncheckedIndexedAccess": true`, which `tsconfig.json` sets alongside
`strict`. Under that flag every `arr[i]` is `T | undefined`. The codebase was
written without the flag ever being **enforced**, so unchecked indexing is
pervasive, and it concentrates in tests where fixtures are indexed positionally.

**This is not latent breakage.** Almost none of it is a live bug — it is the
accumulated cost of a strictness setting that was declared and never gated.
Which is precisely the `spell-hardening` thesis in a different medium: _a rule
that exists but is not enforced is not a rule_, and nothing detects the gap.

## Why it cannot just be switched on

`bun run check` runs in the pre-commit hook. Adding `tsc --noEmit` to it today
makes the gate **permanently red and blocks every commit** — including the
commits that would fix it.

## The choice, which is a real design decision

1. **Fix all 436.** Honest, large, mostly mechanical (`?.`, non-null assertions
   in tests, narrowing helpers). Highest risk of a careless `!` that hides a
   real bug — the cure becoming the disease.
2. **Relax `noUncheckedIndexedAccess`.** Two-line change, gate goes green
   immediately, and it **discards a real safety property** the config has
   claimed since day one. Cheapest and the most likely to be regretted.
3. **Scope the gate and grow it.** Gate `plugins/spellbook/*/scripts/**` first
   (the shipped surface area, ~200 errors), leave tests and
   `scripts/instruments` ungated, and ratchet. Slowest to full coverage, but
   never red for a reason nobody is working on.

> ⚠ **Whichever is chosen, the gate must state what it cannot see** — clause (i)
> of `spell-hardening`'s end condition. Option 3 in particular must report
> "checked N of M files" rather than a bare green, or it becomes a new instance
> of the same defect: a check that passes because it did not look.

## What this item is NOT asking for

No recommendation between the three. This is the measurement and the framing;
the choice needs a design pass, and the cost of the last two attempts to size it
from the config alone is exactly why.

## The lesson, which is the durable part

**Two independent readers, both careful, both wrong by two orders of magnitude,
both reading the same config.** Neither ran the command. The sweep that produced
this file was written to name documents that disagree with the tree — and its
own estimate for this item was a document that disagreed with the tree.

**A claim about what the code will do is not evidence until something executes
it.** Reading a config tells you what was _declared_, never what is _true_.
</content>
