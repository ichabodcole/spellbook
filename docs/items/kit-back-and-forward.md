---
type: item
title: Back and Forward through what you opened
description:
  Arrows and keys step back and forward through the documents opened in a
  session, and Back returns to the place you were reading.
status: draft
lifecycle: backlog
id: 01a1eb00-51ba-704a-9d0b-3eaa00bb214a
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-17 }
blocked_by: [01a17a8e-259e-77a4-b704-af6c786e9732]
parent: feature/workspace-kit-follow-ups
from: 01a1eabb-ee28-7737-826d-38ba3dd5b5bf
---

# Back and Forward through what you opened

From the Story Studio port scan (2026-11-17). A reviewer in Scriptorium follows
links and backlinks from document to document, and has no way back. The kit's
`HistoryArrows` undo the context's structural acts; they are not navigation.

Story Studio added a history of opens:

- `27589601`: the history (`packages/kit/src/context/navHistory.ts`, a pure
  module, `shell/navController.ts`, `useNavHistory.ts`) and the daemon's facts
  (`workspace/daemon/navFacts.ts`);
- `352133db`: arrows at the start of the top bar (`NavArrows.tsx`) and keys
  (`navKeys.ts`): ⌃- and ⌃⇧- on a Mac, Alt+[ and Alt+] elsewhere;
- `33d7d81d`: each entry keeps its place, so Back returns to the line you were
  reading (`document/useNavPlaces.ts`, `place.ts` gaining `go` and `watch`). Our
  `src/kit/document/place.ts` only keeps the line across a raw and rendered
  flip.

It works without a URL. Story Studio names a file from outside its project as
`@<entry id>/<path>`; in Scriptorium every file is held that way, which works
but reads less tidily. Mirroring the history to the URL is left for later: a
session's port dies with it, so links don't outlive the session.

`navHistory.ts` and `navKeys.ts` port cleanly; the controller and the top bar
need the kit split, so this is blocked by
[kit-split-oversized-modules](kit-split-oversized-modules.md).

## Definition of done

- [ ] Opening a document, by the tree, a link, a backlink, search or the agent,
      adds it to the session's history.
- [ ] Back and Forward arrows in the top bar, and the keys above, step through
      it, and are disabled at either end.
- [ ] Back returns to the line that was at the top when you left.
- [ ] Offered on kit-parity.

## Related Documents

- [Which of Story Studio's new document UX should Scriptorium take?](./story-studio-document-ux-port/item.md)
