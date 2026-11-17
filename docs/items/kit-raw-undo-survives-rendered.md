---
type: item
title: Raw undo survives a trip to the rendered view
description:
  Switching from raw to rendered and back keeps the raw editor's undo history.
status: stable
lifecycle: backlog
id: 01a1eb00-5247-7533-a08f-0a1329a9c378
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-17 }
blocked_by: [01a17a8e-259e-77a4-b704-af6c786e9732]
parent: feature/workspace-kit-follow-ups
from: 01a1eabb-ee28-7737-826d-38ba3dd5b5bf
---

# Raw undo survives a trip to the rendered view

From the Story Studio port scan (2026-11-17). Switching between raw and rendered
is a core Scriptorium habit. Today, edit in raw, switch to rendered and back,
and ⌘Z has lost the raw edits' history.

Story Studio fixed this in `92e657ed`: its `DocumentView.tsx` keeps CodeMirror's
`historyField` across the flip, with a change in `workspace/session.ts`. Nothing
in our `src/kit/document/DocumentView.tsx` does this. Our `DocumentView` has
drifted a long way from theirs, so this is a rewrite, not a copy; blocked by
[kit-split-oversized-modules](kit-split-oversized-modules/item.md).

## Definition of done

- [ ] Edit in raw, switch to rendered and back: ⌘Z undoes the raw edits, in
      order, and ⌘⇧Z redoes them. A test covers it.
- [ ] Switching documents still starts each one with its own history.
- [ ] Offered on kit-parity.

## Related Documents

- [Which of Story Studio's new document UX should Scriptorium take?](./story-studio-document-ux-port/item.md)
