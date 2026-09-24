---
type: memory
title: "An observer is late for the event that beats it"
description:
  Scriptorium cached layout measurements and cleared them from a ResizeObserver,
  but a scroll event caused by the same resize is dispatched first and read the
  stale cache; keying the cache on the width it measured made staleness exact
tags: [scriptorium, layout, caching, measurement]
status: stable
generated: { by: claude-opus-5.5, at: 2026-09-22 }
---

# An observer is late for the event that beats it

## What happened

Scriptorium's rendered pane caches a table of block positions (measuring forces
layout, so it is not done per scroll) and clears the table from a
`ResizeObserver`. Collapsing a side column widened the pane in a single layout.
The browser's scroll anchoring then moved `scrollTop` to keep the same text in
view, and **that scroll event was dispatched before the observer's callback
ran**. The scroll handler read the table measured at the old width, reported a
line a section too early, and the split view that the extra width mounted opened
there.

A drag reaches the same widths in small steps, so the error per step was small
and nobody had seen it. It took a one-step width change to expose it, and it was
found by driving the new feature against the old feature's acceptance ("keeping
your place must not get worse"), not by a test.

## What to carry forward

- **An invalidation callback is only as early as its place in the frame.** A
  cache cleared by an observer (resize, mutation, intersection) is stale for any
  event dispatched before the observer runs, and scroll events are among those.
  Do not assume "the observer will have cleared it by then".
- **Key a cache on what it measured.** Store the input the measurement depended
  on (here, the width) and re-measure when it differs. That is exact evidence of
  staleness, with no timing in it — the same move as replacing a time window
  with a position test in
  [the branch before](./2026-09-22-a-time-window-is-a-guess.md).
- **Keep the observer too.** Some changes do not alter the key (content growing
  after a font swap); the observer still catches those. The key closes the gap
  the observer cannot.
- **Drive a new feature against the old feature's acceptance.** The defect lived
  in the seam between two branches; neither branch's own tests could see it.
- **Pull the rule out to where a cell can hold it.** The rule now lives in a
  DOM-free `anchorCache` with a cell that fails without the width check. The
  wiring into the component is still evidenced only by the browser run, and the
  docs say so.

Session:
`docs/projects/scriptorium/sessions/2026-09-22-room-to-read-and-the-width-the-anchors-forgot.md`.
