---
type: backlog
title:
  "Backlog — Scriptorium: a coalesced scroll is lost in one of the two split
  orderings"
description:
  In the rendered pane's event ordering the split's guard swallows a human
  scroll that arrived in the same event as its own, leaving the panes
  disagreeing until the next tick
tags: [scriptorium, split-view, scroll, known-hole]
status: draft
lifecycle: open
generated: { by: claude-opus-5, at: 2026-09-22 }
---

# Scriptorium: a coalesced scroll is lost in one of the two split orderings

E63 replaced the split's 150 ms settle window with an exact guard: a drive arms
the pane it moves, the first scroll event after a drive IS that drive, and a
human scroll **coalesced** into that same event is told apart by comparing where
the pane is against where the drive left it. That comparison needs to know where
the drive left it — `left`, recorded one frame after the drive.

**The two panes do not have the same event ordering, and only one of them is
covered.** CodeMirror's `scrollIntoView` is applied a frame late, so the raw
pane's own scroll event arrives _after_ `afterFrame` has recorded `left`. The
rendered pane sets `scrollTop` synchronously, so its event can be dispatched
_before_ `afterFrame` runs. `left` is then still `undefined`, `report` has
nothing to compare against, takes the conservative branch, and **swallows the
event — including the human's scroll inside it.** The panes are left
disagreeing.

## Measurements

Taken by an independent verifier on the committed bundle (2026-09-22).

- **At the store level.** The rendered ordering gives `place.line()` **151**
  with raw at **1500** and rendered at **3000** — not agreed. The same sequence
  in CodeMirror's ordering gives **301 / 301**.
- **In the browser**, leading with raw and moving the rendered pane from inside
  raw's scroll event — after the drive ran and before its event dispatched: **35
  lines apart at +900 px, 84 lines apart at +2500 px, stable at 4 s.**
- **The mirror case with raw as the follower is 0 both times**, exactly as the
  two orderings predict. That asymmetry is the evidence for the cause.
- **It self-heals completely on the very next scroll tick**: 84 lines apart →
  both panes on line 156 after one wheel tick.
- **The trigger needs a synthetic injection.** With real alternating wheel input
  the verifier could not provoke worse than **3 lines**.

## The ruling

**Cole ruled it filed rather than fixed**, on those measurements: it takes a
synthetic injection to reach, real input cannot provoke worse than three lines,
and it corrects itself on the next tick.

## Pinned, not left loose

`src/scriptorium/surface/state/place.test.ts` carries the cell
`PINNED: in the rendered pane's ordering a coalesced scroll is lost, then self-heals`.
It asserts **what the code does today**, not what it should do, and says so at
the site. If that cell starts failing, this behaviour has moved — the hole is
closed or widened — and this item wants updating either way. The cell also
covers the self-healing, which is the half that makes the ruling defensible.

## Where to start

The structural cause is one line: in `createPlace`'s `report`, the armed branch
reads `if (!pane || where === undefined || pane.at() === where) return;` — and
`where === undefined` is the hole. The fix is not simply to invert it, because
that branch is also what makes an ordinary drive's own event unnews-worthy
before `afterFrame` has run; closing it needs the drive to record a position the
event can be compared against **without waiting a frame**, which the rendered
pane can do synchronously (`to` already knows the offset it produced) and the
raw pane cannot (CodeMirror's scroll has not landed yet). A per-pane "do you
know your landing position synchronously?" is the shape to consider, and the
`Pane` interface is where it would go.

## Acceptance Criteria

- [ ] A coalesced human scroll is heard in BOTH orderings, not just CodeMirror's
- [ ] The pinning cell is rewritten as an aspirational one (settled means
      agreed) rather than deleted
- [ ] The browser measurements above are re-taken and the asymmetry is gone

## References

- `src/scriptorium/surface/state/place.ts` — `createPlace`, the armed branch of
  `report` and the `afterFrame` that records `left`
- `src/scriptorium/surface/state/place.test.ts` — the pinning cell
- E63 in `docs/projects/scriptorium/decision-log.md` — why the guard is an event
  rather than a duration
- `docs/backlog/2026-09-22-scriptorium-view-switches-lose-scroll-position.md` —
  the item this came out of
