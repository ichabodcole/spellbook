# Backlog — digestify image viewer + feedback

**Status:** idea / backlog (not scheduled). Captured 2026-06-02.

## The idea

Expand **digestify** to support **image content** — an image viewer with
per-image feedback — alongside the text/markdown review it does today.

This sits squarely inside digestify's existing purpose: _take content an agent
produced, give the human a nice way to view it, and route feedback back to the
agent._ An image set (or a single image) is just another content type under that
umbrella. The agent presents a batch; the human views it as a contact sheet /
lightbox, stars the keepers, leaves per-image notes; `submit` returns that
structured feedback so the agent can continue.

## Why it came up

While building **glamour** we kept generating ad-hoc batches of images during
model evaluation (test rounds across many models/styles) and had no good way to
review them together or annotate them. Reviewing via Finder + one-at-a-time was
painful. The workflow is distinct from glamour itself: glamour is a _guided
convergence toward a style spec_ (phased, opinionated); this is just _"the agent
is producing images, let me see the batch and react."_ That review-and-react
loop is exactly digestify's shape, not a new spell.

## Seed prototype

A scrappy static gallery already exists from the model-test work:
`docs/projects/image-style-spell/artifacts/model-tests/gallery.ts` → generates a
self-contained `outputs/gallery.html` (grid grouped by model, click to enlarge
with the originating prompt, per-image star + note in localStorage, export notes
→ JSON). It's static/throwaway, but it's the v0 of the viewing surface and a
working reference for the interaction.

A sibling implementation also exists: **glamour's variants panel** already does
like / canonical / per-item comment / batched feedback against a live daemon.
The digestify image mode could borrow that interaction model. (Possible deeper
move: a shared "gallery primitive" used by both digestify and glamour — but
that's a later architecture question, not part of this item.)

## Rough shape (when picked up)

- digestify gains an **image content mode**: agent posts an image set (paths or
  URLs + optional per-image prompt/label/metadata); surface renders a contact
  sheet + lightbox.
- Per-image feedback: star/keep, free-text note, maybe a quick verdict chip.
- `submit` returns structured per-image feedback (id → {kept, note, …}) the
  agent can act on — same cast-and-resolve contract digestify already uses.
- Reuse digestify's existing surface/identity; this is an additive content type,
  not a new spell.

## Not now

Deliberately deferred. Logged so it isn't lost. Revisit after glamour coalesces
and the model-selection work settles — by then we'll know what the image-review
interaction really needs from real use.
