---
type: item
title: "Scriptorium: the map shows relations, and its selection is chat context"
description:
  "GitHub #136: Story Studio reshaped the ported map; the move to the centre
  column has landed, while selection as chat context, relation colours, a
  neighbourhood view and an offered map have not."
status: stable
lifecycle: backlog
id: 01a1eabe-ef5a-76cf-bdeb-adb8a943c22b
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, scriptorium, map, chat]
parent: feature/workspace-kit-follow-ups
source: "#136"
priority: low
---

# Scriptorium: the map shows relations, and its selection is chat context

Filed as GitHub #136, from the changes Story Studio made to the ported map after
their user tried it (`ichabodcole/story-studio@8370d1b`,
`apps/atlas/surface/map/`). Related: #127.

The first point has landed. The map is the document pane's `appView`
(`src/scriptorium/surface/MapView.tsx`), from
[scriptorium-kit-map-view](_archive/scriptorium-kit-map-view.md). A check on
2026-11-17 found the rest open. Click opens the document, edges are coloured
only for prose or frontmatter, there are no wheel, pinch or pan handlers, and
nodes still use `onClick`. The only agent verb is `scriptorium.map`:

- **Selection is chat context.** A click selects a document, shift-click adds
  one. The selection is the chat's context chip and is sent as `about.docs`.
  "Ask the agent" focuses the composer; a double-click opens the document. The
  map's current view is in session state, so the agent knows what is shown.
- **Relations are shown.** Edges are coloured by `?rel=`, and a legend filters
  them.
- **A neighbourhood view.** A ring of the open document's links in and out,
  grouped by relation, from "Linked from".
- **The agent can offer a map.** A verb offers a filtered map that opens only
  when the user chooses. It is refused when nothing matches, and survives a
  reload.
- **Canvas.** It fits the pane. Wheel or pinch zooms; drag or two-finger scroll
  pans.
- **Taps come from pointer events, not `click`.** Chromium drops `click` when
  the pressed node is redrawn on top.

## Definition of done

- [ ] Each point above is ported, or dropped here with a reason.
- [ ] Driven in a real browser.
- [ ] #136 answered and closed once released.
