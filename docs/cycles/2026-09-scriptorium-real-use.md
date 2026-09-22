---
type: cycle
title: "Scriptorium from real use"
description:
  Fix what Cole's real editing sessions found in Scriptorium — selection and
  context bugs, losing your place, cramped layouts, silent notes, and the
  30-minute wake-ups
tags: [scriptorium, real-use, co-presence]
status: draft
lifecycle: active
started: 2026-09-22
appetite:
  "Stop when the context chip always matches the selection, switching views
  keeps your place, the side columns can get out of the way, a note shows that
  it is being worked on, and the 30-minute wake-up has an explanation and a
  ruling. Anything that needs more real use to decide waits for the next cycle."
scope:
  - backlog/2026-09-22-scriptorium-chat-context-does-not-mirror-the-selection
  - backlog/2026-09-22-scriptorium-rendered-selection-maps-to-wrong-lines
  - backlog/2026-09-22-scriptorium-view-switches-lose-scroll-position
  - backlog/2026-09-22-scriptorium-reader-mode-and-collapsible-sidebars
  - backlog/2026-09-22-scriptorium-a-note-is-acted-on-and-nothing-shows-it
  - backlog/2026-09-22-scriptorium-tail-monitor-expiry-wakes-the-agent-for-nothing
after: []
generated: { by: claude-opus-5, at: 2026-09-22 }
---

# Scriptorium from real use

## Why now

Scriptorium is the first spell Cole has used for sustained real work since it
shipped, and his notes (Operator, `Spells/Scriptorium`, 2026-09-20) are exactly
the real-use signal the project waits for before changing a surface. The bugs
cost trust in the thing that makes the app useful: the passage that rides along
with a message. The design findings (notes, timeouts) are one house rule — a
message to an agent must name its next act — showing up twice in one spell.

## Scope

Planned as five branches, in this order. Bugs go first because they are small
and well located. The spike goes last because it may turn into a change across
every spell.

1. **`fix/scriptorium-selection-context`**
   - **backlog/…-chat-context-does-not-mirror-the-selection** — dismissing the
     chip no longer blocks later selections, and click-to-deselect clears it in
     rendered mode. Both are cleared in the daemon's copy too, not just the
     surface's.
   - **backlog/…-rendered-selection-maps-to-wrong-lines** — reproduced on one of
     Cole's real documents, that document kept as a `projection.ts` test, and
     fixed. If it cannot be reproduced, the item records what was tried.
2. **`feat/scriptorium-keep-your-place`**
   - **backlog/…-view-switches-lose-scroll-position** — raw ↔ rendered keeps the
     visible section (or the selection), and split panes stay roughly aligned.
     Built on one "source line at the top of this pane" primitive.
3. **`feat/scriptorium-collapsible-sidebars`**
   - **backlog/…-reader-mode-and-collapsible-sidebars** — either side column, or
     both, can be collapsed, and that choice persists. Reader mode is in scope
     only if it turns out to be "rendered + collapsed + quieter chrome".
     Otherwise it gets split off. The composer stays reachable either way.
4. **`feat/scriptorium-note-in-progress`**
   - **backlog/…-a-note-is-acted-on-and-nothing-shows-it** — a new note shows
     that work has started, and that signal can go stale like E53's does.
     `SKILL.md` stops claiming "a note is not a request". Choosing between the
     surface-only and agent-acknowledged options is the branch's first step.
5. **Spike: Monitor expiry**
   - **backlog/…-tail-monitor-expiry-wakes-the-agent-for-nothing** — reproduced,
     and the source confirmed (Monitor's 30-min cap, or the daemon). Then a
     ruling. If the cause is the Monitor pattern the other skills share, the fix
     may leave this cycle as its own item.

Out of scope, deliberately:

- **Eager vs. lazy versioning**
  (`backlog/2026-09-22-scriptorium-eager-or-lazy-versioning`). Cole is
  undecided, and it needs more real use before anything is built.
- **Batched note review.** Cole flagged it as later work, and it may reshape
  branch 4's design rather than extend it.
- **The 2026-09-14/15 release-hygiene backlog** (dependency sweep, CI running
  `gate` twice, nested `node_modules`). A different theme, left for its own
  cycle.

## Outcome

_Written at close, not before._

## Sessions

- fix/scriptorium-selection-context (landed 2026-09-22)

- feat/scriptorium-keep-your-place (landed 2026-09-22)
