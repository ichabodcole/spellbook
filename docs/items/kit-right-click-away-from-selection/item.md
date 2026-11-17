---
type: item
title: A right-click away from a selection still acts on that selection
description:
  "GitHub #146: the document menu takes the editor's selection whatever the
  pointer's position, so Paste can replace text the user isn't looking at."
status: stable
lifecycle: done
id: 01a1eabe-f49f-74c5-b302-64b76d6b2854
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, scriptorium, editor]
parent: feature/workspace-kit-follow-ups
source: "#146"
priority: high
cycle: 2026-11-research-and-safety
---

# A right-click away from a selection still acts on that selection

Filed as GitHub #146. The document menu acts on the selection even when the
right-click lands away from it. Cut, Copy and Add note can hit text the user
isn't looking at, and Paste replaces it. Not reproduced here yet. The issue's
repro, in Chromium: select a word in the raw view, right-click in another
paragraph, choose Paste. The distant word is replaced. Chromium often keeps the
selection on such a click, for example after Cmd+Z restores one.

**Where:** the raw editor's `contextmenu` handler in
`src/kit/document/DocumentView.tsx` (around line 917 on develop) passes
`v.state.selection.main` as `from`/`to`. The pointer's `posAtCoords` is used
only to find notes. The rendered view does the same with the DOM selection.

Story Studio's change (`e83eca9d`, `openMenu` in `DocumentPane.tsx`): when the
point falls outside a non-collapsed selection, the menu is built as though at a
caret there, in raw and rendered. Insert a link and Paste act at the point; Cut,
Copy and Add note aren't offered. The selection isn't collapsed, so dismissing
the menu loses nothing. Their test is "away from the selection" in
`DocumentPane.contextMenu.test.tsx`.

## Definition of done

- [ ] A right-click outside a selection opens the caret menu at that point, in
      raw and rendered. Inside it, nothing changes.
- [ ] Tested in `DocumentPane.contextMenu.test.tsx`.
- [ ] #146 answered and closed once released.
