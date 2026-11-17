---
type: session
title: Right-click away from the selection — 2026-11-17
description:
  A right-click outside a selection now opens the caret menu at the click, in
  raw and rendered, including past a line's end, in linear time.
tags: [kit, document, menu]
status: stable
generated: { by: claude-opus-5-5, at: 2026-11-17 }
---

# Right-click away from the selection — 2026-11-17

Part of
[Research first, and the bugs that bite](../../../cycles/2026-11-research-and-safety.md).

## Context

GitHub #146: the document menu acted on the selection wherever the right-click
landed, so Paste could replace a word the user wasn't looking at.

## What Happened

Three rounds, each reviewed.

1. **The rule**, following Story Studio's `e83eca9d`: the menu request now
   carries the point under the pointer (raw: `posAtCoords`, in the daemon's
   count; rendered: the caret mapped through the held text). In `DocumentPane`'s
   `openMenu`, a point outside a non-collapsed selection opens the caret menu at
   the point: Paste and Insert a link act there; Cut, Copy and Add note aren't
   offered; the selection isn't collapsed. Edges count as inside.
2. **The rendered gap**, found by review: the rendered view's point was null at
   the end of a text node and between blocks, so a right-click past a line's end
   still acted on the distant selection. `pointOffset` now probes the previous
   character at a node's end, and falls back to the nearest text.
3. **The cost**, found by the second review: that fallback resolved every text
   node before the caret, each a whole-document alignment, so a right-click in a
   long document's margin took seconds. It now finds the nearest text in one
   walk. A test counts page walks (at most 8; the old code made 6,002).

## Review

Census from the Agent tool's roster: `feature-dev:code-reviewer` rejected (no
Bash); `general-purpose` (`*`) chosen for each round.

- Round 1: gate (exit 0), mutation runs on the rule's edges and coordinate
  space, a probe that found the rendered gap. With fixes.
- Round 2: probes of end-of-node, whitespace between blocks, the root and an
  empty document; timings that found the quadratic fallback. With fixes.
- Round 3: a differential probe of old against new over 423 caret positions (no
  differences), the guard test failing on the old code, gate exit 0. Ready.

## Follow-up

Not filed: the walker skips comment nodes, which the renderer never emits; and
nothing was checked in a real browser, only happy-dom. A point inside a pending
change during a held redraw still falls back to the selection's menu.

---

**Related Documents:**

- [A right-click away from a selection still acts on that selection](../item.md)
