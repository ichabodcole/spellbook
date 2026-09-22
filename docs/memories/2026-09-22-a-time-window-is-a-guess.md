---
type: memory
title: "A time window is a guess about which scroll a report came from"
description:
  Scriptorium's split-view sync suppressed reports for a time window after
  driving a pane, which discarded real scrolls; replacing the guess with an
  exact position test fixed both symptoms and left two pinned sub-frame holes
tags: [scriptorium, scrolling, guards, measurement]
status: stable
generated: { by: claude-opus-5, at: 2026-09-22 }
---

# A time window is a guess about which scroll a report came from

## What happened

Two panes that scroll together have to tell "the app moved this pane" from "the
human moved this pane", or they chase each other. The first implementation
suppressed reports for a **time window** after driving a pane. It did stop the
chasing, and it produced two defects instead: a human scroll inside the window
was discarded outright — the panes sat **50 lines apart and stayed there** — and
two overlapping windows let one expire under the other.

Both are the same error. A window is a **guess** about which scroll a report
came from, made from timing rather than from evidence. The replacement asks the
question exactly: a programmatic scroll produces one scroll event, dispatched
before that frame's animation callbacks, so a report can be told apart by
comparing where the pane **is** against where the drive **left** it. Nothing is
suppressed for any duration, so nothing can be lost inside a window.

## What to carry forward

- **Prefer an exact test over a temporal one.** If a guard suppresses by time,
  ask what it is really trying to identify, and whether the system can be asked
  directly. A timing window is the shape that silently eats real input.
- **When a guard rests on an ordering fact, state it and check it** — the
  reviewer verified this one against the HTML spec's "update the rendering"
  steps rather than the code's say-so, and the assumption that scrolling is
  instant (no `scroll-behavior: smooth`) is now written where someone would
  break it.
- **Pin a hole you choose not to fix.** Two sub-frame cases survive; each has a
  cell asserting today's behaviour, naming the backlog item, and verified to be
  capable of failing. A pin that cannot fail is theatre.
- **Test the invariant, not the mechanism.** The first cells asserted that a
  report was dropped — which was the bug. The right assertion is that when
  everything settles, the two panes agree.
- **Correct a wrong cause in the open.** The published cause for one hole was
  wrong; saying so plainly beats a quiet edit, because a wrong cause sends the
  next reader to the wrong place.

Session:
`docs/projects/scriptorium/sessions/2026-09-22-keeping-your-place-and-the-guard-that-guesses.md`.
