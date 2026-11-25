---
type: item
title: Test Enter on a resize handle, and quiet while an image is open
description:
  "Two shell behaviours no test covers: Enter on a resize handle collapses or
  expands its column, and reader mode's quiet is suppressed while an image is
  open."
status: draft
lifecycle: triage
id: 01a211f1-e25c-75d4-aa58-0d823351b1aa
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-25 }
parent: feature/kit-split
from: items/kit-split-w2/sessions/2026-11-25-kit-split-w2.md
---

# Test Enter on a resize handle, and quiet while an image is open

W2's review mapped what the 17 `WorkspaceShell*.test.tsx` cover and found two
behaviours in `src/kit/shell/useShellColumns.ts` that nothing tests. Both gaps
predate the split.

- **Enter on a resize handle.** `handleEnter` collapses or expands the column
  beside the handle and stops the key going further. No test presses Enter on a
  handle (the only Enter in the shell tests is Cmd-Enter in a note field). An
  inverted branch or a dropped `stopPropagation` would pass.
- **Quiet while an image is open.** `quiet = quietWanted && !state.openImage`:
  reader mode's faded chrome is off while an image is open. No test turns quiet
  on and then opens an image.

## Definition of done

- [ ] A shell test presses Enter on each resize handle and sees its column
      collapse, then expand, with the key not reaching the page.
- [ ] A shell test turns quiet on, opens an image, sees the chrome unfaded, and
      sees it fade again when the image closes.
- [ ] No source change: tests only.
