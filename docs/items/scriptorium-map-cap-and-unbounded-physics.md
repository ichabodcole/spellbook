---
type: item
title: "Scriptorium: the map's draw cap and unbounded physics"
description:
  "GitHub #135: the map's draw cap kept documents in path order, and the physics
  layout lets unlinked documents drift off the canvas."
status: draft
lifecycle: ready
id: 01a1eabe-eed5-748e-8244-51395d72fe05
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, scriptorium, map]
parent: feature/workspace-kit-follow-ups
source: "#135"
priority: low
---

# Scriptorium: the map's draw cap and unbounded physics

Filed as GitHub #135, from Story Studio's port of the map
(`ichabodcole/story-studio@8370d1b`). Two problems:

- **The draw cap kept documents in path order.** In a set of more than 140, a
  hub that sorts late by path (`z-hub.md`) could be dropped while an unlinked
  leaf was kept.
- **Physics has no bounds.** On a sparse or filtered graph, documents with no
  drawn link drift off the canvas.

**The draw cap is fixed** (checked 2026-11-17, shipped in 6.0.0). The map moved
to `src/scriptorium/surface/MapView.tsx` and is fed from the kit's `linkGraph`
(`src/kit/workspace/links.ts`). That filters first, then ranks by distance from
the focus and by degree, and `links.graph.test.ts` holds a late-sorting hub.

**Still open:**

- `src/scriptorium/surface/forceLayout.ts` has only a `forceCenter`, with no
  bounds force.
- The canvas is a fixed 1500×1000 that scrolls.
- The simulation still runs on `.on("tick")`.

Story Studio's fix: a bounds force against the pane's real size, and a canvas
that fits the pane. d3-timer binds `requestAnimationFrame` when imported, which
froze physics in test DOMs, so their layout steps the simulation itself and
stops on close (`apps/atlas/surface/map/forceLayout.ts`, `viewport.tsx`).

## Definition of done

- [x] A heavily linked document that sorts late by path is drawn in a set of
      more than 140. A test holds it (`links.graph.test.ts`).
- [ ] Unlinked documents stay inside the pane in the physics layout, at any pane
      size.
- [ ] The canvas fits the pane instead of a fixed 1500×1000.
- [ ] The layout steps the simulation itself and stops on close, so physics runs
      in test DOMs.
- [ ] #135 answered and closed once released.
