---
date: 2026-06-27
spell: magpie
rule: A spell is a shared workspace — design for co-presence
disposition: judgment-only
---

# The surface is a shared-state game board, not a control panel

## The situation

Mid-build on magpie, articulating why the surface elements behave the way they
do — the editable bounding boxes, the phase stepper, the version rows, the
imperatives-only event stream. The question under it: what _are_ these UI
pieces?

## What the familiar concluded

The default mental model: UI widgets are functional controls — you operate them
and they make things happen under the hood.

## What the mage wanted instead

Treat the surface as a **shared-state game board** (and stigmergy — coordination
through state left in a shared environment). Like physical game pieces, moving a
piece doesn't _do_ anything functional; it **represents state** and **signals**
("I see you moved that → my move"). Most UI elements aren't doing magic — they
let the human and agent stay **aligned on the state of things and what comes
next**, and let either party manipulate that state so the other sees it. The
bbox boxes are the cleanest example: the user nudges/resizes one not to trigger
a function but to **show the agent** "this is what I mean"; the agent's
discovered boxes give the user a first look to react to. The surface's job, in
order: facilitate the conversation; keep both parties aligned on where we are
and signal when to move forward; hold the tools to do the work.

## The distilled judgment

Design surface elements as **state markers and signals on shared ground**, not
as a control panel of functional buttons. The _doing_ lives with the agent; the
board is the common ground both read and touch. This is the same distinction as
imperatives-only event push — ambient edits are state you read; only intentional
hand-offs are signals you push. Occasionally a control genuinely should be
programmatic (fine — the exception), but the default is: pieces signal, the
agent acts.

## Binding

- **Rule affected:** refines "A spell is a shared workspace — design for
  co-presence" — the operating frame beneath it. Pairs with
  conversation-primary-surfaces (same session); explains why imperatives-only
  (under "Drive a conjuration through a daemon + thin CLI") holds.
- **Repeal criterion:** none — this is the co-presence thesis stated concretely.
