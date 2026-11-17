---
type: item
title: Leave an agent version without taking it
description:
  "Let the human leave an agent's version: it stays in history and stops waiting
  on them, without being activated or deleted."
status: draft
lifecycle: backlog
id: 01a1eb00-5014-7393-9326-850d71951419
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-17 }
blocked_by: [01a17a8e-259e-77a4-b704-af6c786e9732]
parent: feature/scriptorium-inbox
from: 01a1eabb-ee28-7737-826d-38ba3dd5b5bf
---

# Leave an agent version without taking it

From the Story Studio port scan (2026-11-17). Today the only ways to stop an
agent's version waiting on the human are to activate it or delete it. Neither is
right when the human has read it and decided not to take it, and wants it kept
in history.

Story Studio added "Leave it" (and "Leave them" for several) in `221163b6`: a
`left` mark on the version, a `version.leave` op, and rules in its daemon
(`packages/kit/src/workspace/session/documents.ts`, `daemon/rules.ts`). A left
version stays in history, stops counting as waiting, and can still be activated
later. Story Studio built it before its inbox, so that the inbox's count can
always go down without the human having to take something.

It is first in [What still needs me](../features/scriptorium-inbox/feature.md).
It overlaps two backlog items about which versions to keep,
[scriptorium-keep-only-active-version](scriptorium-keep-only-active-version.md)
and
[scriptorium-eager-or-lazy-versioning](scriptorium-eager-or-lazy-versioning.md):
decide the three together.

The daemon half lands in `session.ts` and `server.ts`, so it is blocked by
[kit-split-oversized-modules](kit-split-oversized-modules.md); the split's build
items will replace that as the real blocker once they are filed.

## Definition of done

- [ ] The human can leave one agent version, or all of a document's waiting
      ones, from the version's own controls. A left version stays in history and
      can be activated later.
- [ ] A `version-leave` verb does the same for the agent, and `state` shows the
      `left` mark.
- [ ] A left version no longer counts as waiting on the human, and survives a
      restore.
- [ ] How this fits the two versioning items above is recorded in each.
- [ ] Offered on kit-parity.

## Related Documents

- [Which of Story Studio's new document UX should Scriptorium take?](./story-studio-document-ux-port/item.md)
