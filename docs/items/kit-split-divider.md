---
type: item
title: The split view's divider can't be moved or kept
description:
  The kit's split view is a fixed 50/50 with no divider, where the shipped
  Scriptorium lets the human drag it and keeps its width across sessions.
status: draft
lifecycle: triage
id: 01a157b8-b9f8-73ee-af86-5ebf6388782f
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
from: cycle/2026-10-shell
---

# The split view's divider can't be moved or kept

The shipped Scriptorium's split view has a divider the human drags, and its
width is kept in prefs (`SPLIT_LAYOUT_ID`, `src/scriptorium/surface/App.tsx`).
The kit's document pane splits raw and rendered into two fixed halves with no
divider at all. Found by `scriptorium-kit-shell` and the Atlas comparison (D5),
on 2026-10-20.

## Definition of done

- [ ] The split view has a divider the human can drag, by pointer and by
      keyboard.
- [ ] Its width is kept through the shell's storage slot, so it survives a new
      session.
- [ ] Offered on kit-parity.
