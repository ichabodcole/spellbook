---
date: 2026-09-16
spell: cross-cutting
rule: none yet
disposition: judgment-only
---

# Ask what the fix supersedes, before the fix is small enough not to ask

## The situation

A consumer's scriptorium tab died after a few minutes idle. The cause was that
`buildSurface()` never pinned `process.env.NODE_ENV`, so React resolved to its
development build on all nine surfaces and shipped that way in v3.0.0; the
Performance Track instrumentation wrote a `performance.measure()` entry per
render into a buffer nothing clears, and a 30-second re-render interval filled
it until the structured clone could not allocate.

Two flags fix it — `define` and `minify` — and the obvious move was to pass
both. Minify was the larger win and looked free: it strips the same
instrumentation and takes the bundle down another third.

## What the familiar concluded

Ship both. The fix is one line in one shared build, the measurements were clean,
and both flags point the same direction.

## What the mage wanted instead

Cole did not dispute the diagnosis or the fix. He asked one question first:
**"check if there is any documentation this would supersede in regards to
minifying the code."**

There was. Register **D7** had measured minify on 2026-09-09 and **deferred**
it, behind an explicit precondition: the instruments that read emitted artifacts
AS TEXT — the spawn-path ward's anchor spellings, the launcher-pairing ward's
import specifiers, `exit-site-inventory` — have never seen renamed identifiers
and must be calibrated first. Passing `minify` inside a crash fix would have
silently overturned a live deferral and breached its stated precondition, in a
branch nobody would think to review for ward calibration.

The reasoning underneath the question: **a small diff is not a small decision.
Size is a property of the patch; supersession is a property of the record.** A
one-line change can overturn a ruling that took a day of measurement, and the
one-line-ness is exactly what stops anyone from looking.

## The distilled judgment

Before landing a fix, ask what it **supersedes** — not what it touches. The two
are different searches: "what does this change break" reads the code, "what did
someone already decide about this" reads the record, and only the second finds a
deferral.

And when the answer is "it supersedes something": look for the **separable
half**. Here `define` and `minify` pointed the same way and were assumed to be
one move; they were two. `define` alone removed the instrumentation and left the
bundle's text shape untouched — measured, 57 module-boundary comments and
`src/kit/lib/cn.ts` present before and after, 0 of each after minify — so the
crash fix shipped complete while the deferred decision stayed deferred and
un-breached. The blocked half of a change is rarely the whole change.

⚠ The near-miss worth keeping: the evidence was **already in this repo**. Two
backend-convergence journals recorded _"the unminified **dev** React graph"_ in
September. The dev build was observed twice, written down as a **size** fact,
and read by nobody as a **correctness** defect. Being in the record is not the
same as being read, and a fact filed under the wrong question is invisible.

## Binding

- **Rule affected:** none — judgment only. It is one instance; a rule wants a
  second. Its mechanical half now exists as a ward
  (`grimoire/surface-build-mode-ward.test.ts`), which is the part that does not
  depend on anyone remembering to ask.
- **If it becomes a rule, the repeal criterion:** repeal when the register is
  mechanically consulted at land time — when `land` or a ward can answer "does
  this diff touch anything a register row defers?" without a human asking. The
  rule exists only because that lookup is currently manual.
