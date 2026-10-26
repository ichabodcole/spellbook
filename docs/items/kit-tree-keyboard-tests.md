---
type: item
title: The context tree's keyboard override and display fallback have no tests
description:
  The ArrowRight override that keeps a link row in place replaces the tree
  library's expandOrDown handler, and nothing presses ArrowRight in a test;
  display()'s listed-entry fallback is untested too.
status: draft
lifecycle: triage
id: 01a175f7-ef65-74c6-90a9-be3434c7f5eb
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-25 }
parent: feature/workspace-kit-follow-ups
from: items/kit-workspace-symlinked-sets.md
---

# The context tree's keyboard override and display fallback have no tests

Found by the verifier of the link-row polish in
[kit-workspace-symlinked-sets](./kit-workspace-symlinked-sets.md) (2026-10-25).
To keep ArrowRight on a link row, `EntryTree.tsx` overrides the tree library's
`expandOrDown` hotkey. A hotkey in the tree config replaces the library's whole
entry rather than merging, so the override carries a copy of the library's
handler. It is right today in a real browser, but nothing in `src/kit/context`
or `src/scriptorium/surface` presses ArrowRight. Three mutations survive: the
link exclusion removed, an open folder re-expanding, and `updateDomFocus()`
dropped. A library upgrade that changes that handler would go unnoticed.
happy-dom does not deliver the tree's hotkeys, which is why the author left it
to a browser drive.

`session.display()`'s listed-entry fallback (a document listed on its own, named
by its label) is also untested; mutation P6 survives.

## Definition of done

- [ ] A test presses ArrowRight on a link row, a shut folder, an open folder and
      a document, and the three surviving mutations go red (a browser test if
      happy-dom can't deliver the keys).
- [ ] A test covers `display()` for a document listed on its own.

## Related Documents

- [Mirrored sets follow symlinks out of the workspace and through loops](./kit-workspace-symlinked-sets.md)
