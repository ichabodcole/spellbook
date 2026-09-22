---
type: backlog
title:
  "Backlog — Scriptorium: a coalesced scroll is lost in two sub-frame windows"
description:
  In two sub-frame windows the split's guard swallows a human scroll that
  arrived in the same event as its own, in either pane, leaving the panes
  disagreeing until the next tick
tags: [scriptorium, split-view, scroll, known-hole]
status: draft
lifecycle: open
generated: { by: claude-opus-5, at: 2026-09-22 }
---

# Scriptorium: a coalesced scroll is lost in two sub-frame windows

⚠ The filename says "in one ordering" and is left alone deliberately: it is
cited from `place.ts`, from E63 in the decision log and from a commit message,
and a link that rots is worse than a name that is out of date. The title is the
corrected one.

E63 replaced the split's 150 ms settle window with an exact guard: a drive arms
the pane it moves, the first scroll event after a drive IS that drive, and a
human scroll **coalesced** into that same event is told apart by comparing where
the pane is against where the drive left it. That comparison needs `left` — the
position the drive left the pane at — and **`left` is recorded a frame after the
drive. There are two windows before it can answer, and both swallow a real
scroll.**

1. **The report arrives before `afterFrame`.** CodeMirror's `scrollIntoView` is
   applied a frame late, so the raw pane's own event arrives _after_ `left` has
   been recorded; the rendered pane sets `scrollTop` synchronously, so its event
   can be dispatched _before_. `left` is then `undefined`, `report` has nothing
   to compare against, and takes the conservative branch.
2. **The human scrolls between the drive and `afterFrame`.** Their position is
   then what `afterFrame` records as `left`, so the comparison asks "is the pane
   where the drive left it", is told yes, and swallows their scroll. **This one
   needs no particular ordering and happens in EITHER pane.**

⚠ **This item first claimed the hole was the rendered pane's ordering alone, and
that "only one of them is covered". A reviewer falsified it** with a probe
against unmutated source — `raw.human(1500)`, `rendered.yank(700)`, `frame()`,
`rendered.flush()` → `place.line()` 151, raw 1500, rendered 700 — which is case
2 above, in CodeMirror's ordering. The correction is recorded rather than
quietly swapped in: a wrong cause in a backlog item sends whoever picks it up to
the wrong place.

The existing `a follower yanked back to where it started` cell covers only the
special case of (2) where the yank lands exactly on the pane's pre-drive
position — which is why the one-frame disarm rescues that one and not the rest.

## Measurements

Taken by an independent verifier on the committed bundle (2026-09-22).

- **At the store level.** The rendered ordering gives `place.line()` **151**
  with raw at **1500** and rendered at **3000** — not agreed. The same sequence
  in CodeMirror's ordering gives **301 / 301**.
- **In the browser**, leading with raw and moving the rendered pane from inside
  raw's scroll event — after the drive ran and before its event dispatched: **35
  lines apart at +900 px, 84 lines apart at +2500 px, stable at 4 s.**
- **The mirror case with raw as the follower is 0 both times.** ⚠ That asymmetry
  is evidence for window (1) — the one the ordering decides — and says nothing
  either way about (2), which the store-level probe reaches in CodeMirror's
  ordering and which both panes have.
- **It self-heals completely on the very next scroll tick**: 84 lines apart →
  both panes on line 156 after one wheel tick.
- **The trigger needs a synthetic injection.** With real alternating wheel input
  the verifier could not provoke worse than **3 lines**.

## The ruling

**Cole ruled it filed rather than fixed**, on those measurements: it takes a
synthetic injection to reach, real input cannot provoke worse than three lines,
and it corrects itself on the next tick.

## Pinned, not left loose

`src/scriptorium/surface/state/place.test.ts` carries one cell per window:
**`PINNED 1/2: the event beats \`afterFrame\`, so there is nothing to compare
against`** and
**`PINNED 2/2: a scroll inside the drive→afterFrame window is folded into \`left\``**.
Both assert **what the code does today**, not what they should do, and say so at
the site. If either starts failing, this behaviour has moved — the hole is
closed or widened — and this item wants updating either way. Both also cover the
self-healing, which is the half that makes the ruling defensible.

Checked that they pin something: the naive inversion fails 1/2 at once, and a
synchronous `left` fails both.

## Where to start

Both windows come from the same thing: `left` is written by the `afterFrame`
callback in `createPlace`'s `drive`, and `report`'s armed branch —
`if (!pane || where === undefined || pane.at() === where) return;` — is its only
consumer. Inverting `where === undefined` closes (1) and not (2), and breaks
what that branch is really for: making an ordinary drive's own event
unnewsworthy before `afterFrame` has run.

Closing both needs the drive to record the position it produced **without
waiting a frame**. The rendered pane can — `to` sets `scrollTop` and could
return it — and the raw pane cannot, because CodeMirror's scroll has not landed
yet: measured on this branch, immediately after the dispatch `scrollTop` is
unchanged, and by the next frame it has landed. So the shape to consider is a
per-pane "do you know your landing position synchronously?", and the `Pane`
interface is where it would go.

**Tried, and it is not a one-liner.** Recording `left.set(id, pane.at())`
straight after `pane.to(current)` and not clobbering it a frame later does make
both pinned cells fail — the hole closes — but it also breaks
`the follower does not report back`, because for the RAW pane `pane.at()` at
that moment is still the PRE-scroll position, so `left` is wrong and the
follower's own event stops matching it. Whoever picks this up starts there.

## Acceptance Criteria

- [ ] A coalesced human scroll is heard in both windows and in both panes
- [ ] The two pinning cells are rewritten as aspirational ones (settled means
      agreed) rather than deleted
- [ ] `the follower does not report back` still passes — it is the cell a
      synchronous `left` breaks
- [ ] The browser measurements above are re-taken and the asymmetry is gone

## References

- `src/scriptorium/surface/state/place.ts` — `createPlace`, the armed branch of
  `report` and the `afterFrame` that records `left`
- `src/scriptorium/surface/state/place.test.ts` — the two pinning cells
- E63 in `docs/projects/scriptorium/decision-log.md` — why the guard is an event
  rather than a duration
- `docs/backlog/2026-09-22-scriptorium-view-switches-lose-scroll-position.md` —
  the item this came out of
