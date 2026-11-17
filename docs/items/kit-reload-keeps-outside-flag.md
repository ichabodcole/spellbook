---
type: item
title: A clean reload keeps the Changed-on-disk flag
description:
  When a watch event reloads a document with no unsaved edits while its
  Changed-on-disk flag is up, the flag and its hash stay set; Story Studio's
  reloadFromFile clears both.
status: draft
lifecycle: triage
id: 01a1eb85-9197-7202-b1cf-2783be6625f9
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-17 }
parent: feature/workspace-kit-follow-ups
from: items/kit-save-second-unseen-change/sessions/2026-11-17-keep-mine-hash.md
---

# A clean reload keeps the Changed-on-disk flag

Found by the review of
[kit-save-second-unseen-change](kit-save-second-unseen-change/item.md)
(2026-11-17). When a watch event arrives for a document with no unsaved edits,
`onFileEvent` (`src/kit/workspace/session.ts`) reloads the file's text but
leaves `outsideChanged` and `outsideHash` set. Story Studio's `reloadFromFile`
clears both. Nothing is lost (the next Save writes, since the disk matches the
original), but the banner can stay up over a document that has nothing to choose
between.

## Definition of done

- [ ] A clean reload clears the flag and its hash, as Story Studio's does.
- [ ] Tested: flag up, edits gone, an outside change arrives, and the banner
      clears.
