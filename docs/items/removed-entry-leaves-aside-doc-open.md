---
type: item
title: Removing an entry can leave its document on screen
description:
  "Open a document, open an image over it, remove the entry holding both: the
  centre shows the document whose entry is gone, because removeContext closes
  orphans before it closes the image."
status: draft
lifecycle: triage
id: 01a214e9-444a-7425-a0a0-015679f2d37a
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-25 }
from: items/kit-split-s6/sessions/2026-11-25-kit-split-s6.md
---

# Removing an entry can leave its document on screen

Found by S6's adversarial review; develop behaves the same, so S6 did not cause
it. Open `set/a.md`, open `set/skip.png` over it, then remove the `set` entry.
The centre ends with `openDoc: "a"`, a document whose entry is gone.
`removeContext` runs `closeOrphaned` (nothing to close: the image is showing)
and then `closeImage`, which brings the aside document back.

## Definition of done

- [ ] Decided: after the entry goes, the centre shows nothing (or the next held
      document), not a document from the removed entry.
- [ ] A test shows the sequence above ends that way.
- [ ] The case where the aside document belongs to another entry still brings it
      back (the existing test keeps passing).

## Related Documents

- [The session's tier 2 parts and the viewer (S6) — 2026-11-25](./kit-split-s6/sessions/2026-11-25-kit-split-s6.md)
