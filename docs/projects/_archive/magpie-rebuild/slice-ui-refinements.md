# Magpie — Slice UI refinements (dogfood backlog)

_Captured 2026-06-27 from Cole's hands-on Slice-mode dogfood. These are **paper
cuts**, not scheduled work — recorded so they're not lost. Build when we circle
back to polish Slice (after the Remove gallery's later tasks)._

Theme: the canvas (BreakdownCanvas) and the slices rail are **two views of the
same game pieces** — so the canvas should be calm/declutterable, actionable in
place, and kept in sync with the rail. (See the shared-state-board /
conversation-primary principles.)

## 1. Toggle the canvas label chrome (number + name)

**Paper cut:** a selected slice in the canvas shows its **list-position number**
_and_ its **name/ID**. All that overlaid text gets overwhelming — especially on
a smaller screen — when you're just manipulating boxes (move / resize / remove).

**Idea:** a **toggle to hide the extra info** (number + name) inside the canvas,
leaving only the transform/selection boxes. Great to have the labels when you
want them; nice to strip back to a clean view when you're only pushing boxes
around. Default on; one toggle for the calm view.

## 2. In-canvas flag toggle on the selected box

**Paper cut:** right after you **add** a new slice or **resize** one, the
natural next move is to **flag it for re-slice** — but flagging only lives in
the sidebar, away from where you're working.

**Idea:** when a slice box is **selected** (highlighted) in the canvas, surface
a small **flag toggle** right there, so you can mark it for re-slice without
leaving the canvas context. You're already focused on that box; the action
should be at hand.

## 3. Canvas ↔ sidebar selection sync

**Paper cut:** you select/resize a box in the canvas, then want to act on its
row in the slices rail — but you have to **scroll the sidebar and visually
hunt** for the matching thumbnail; it's not obvious which row is the one you
have selected. (This bit specifically around flagging: selected → resized →
wanted to flag → couldn't easily find the row.)

**Idea:** selecting a box in the canvas **indicates/scrolls to its row** in the
rail (and ideally vice-versa) — the two views share one selection. Partly
subsumed by #2 for the _flag_ action, but still valuable for reaching a slice's
_other_ rail actions.

## Open fork — where the in-canvas flag (and friends) live

For #2 (and future in-canvas actions), two shapes, to play with:

- **A — pinned to the transform.** A flag button anchored next to the selected
  box. Tightly coupled to context (the action sits on the thing). **Trade-off:**
  adds UI to the transform area, which is **already getting crowded**.
- **B — a contextual action strip.** Selecting a box reveals a small **toolbar
  of actions** (flag / re-slice / delete / …) in the canvas. More room,
  decoupled from the box chrome, and **composes** as actions grow.
  **Trade-off:** one more surface element to place/manage.

_Lean: **B** — the transform area is already busy, and a strip scales as we add
actions (delete, re-slice-now, etc.) without piling them onto each box. But
worth prototyping both._

## Not in scope of these notes

These are Slice-phase polish. They don't change the contract or the phase spine
— they're surface ergonomics on the existing `element.flag` / `element.update` /
selection plumbing. Schedule as a "Slice polish" task when we return to it.
