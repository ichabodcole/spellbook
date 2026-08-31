# astrolabe's Quiet disclosure has no `aria-expanded`

**Added:** 2026-08-31 · **Found by:** `cassandra`, driving the board in a
browser during Phase 1a's local-sim (`sk-1a-sim`) · **Scope:** astrolabe
surface, one attribute · **Severity:** low — **no functional defect**, the
control works in both directions; the state is simply invisible to assistive
technology

## The measurement

Driving astrolabe's board from a surface-free, deps-free copy, the Quiet-zone
disclosure was confirmed to be a real toggle — it collapses **and re-expands**,
so it is not a one-way removal.

What it does not do is say so. The button carries no `aria-expanded`, so a
screen reader can operate the control but cannot report whether the region is
currently open or closed.

## Why it is filed rather than fixed

It was found during a verification drive whose card was scoped to _"does the
board work from a copy with no `node_modules` up-tree."_ Fixing an accessibility
attribute inside that card would have been a drive-by change to a spell the card
only reads — the same boundary that kept `astrolabe/bunfig.toml` byte-identical
in the same phase, and for the same reason.

## Acceptance

- [ ] The Quiet disclosure button carries `aria-expanded` reflecting its live
      state.
- [ ] A check, if one is cheap — this is the first accessibility finding
      recorded against a spell surface, and there is currently no ward,
      instrument, or convention covering the class. **Do not invent one for a
      single attribute**; note the absence and let a second instance decide
      whether it is a pattern.
