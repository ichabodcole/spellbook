---
type: item
title: A background --once tail stays quiet
description:
  Check whether the kit's tail --once prints keepalives and reconnect pairs
  while it waits, and if it does, make it print only its closing line.
status: draft
lifecycle: backlog
id: 01a1eb00-5476-7266-857f-40758b283d00
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-17 }
parent: feature/workspace-kit-follow-ups
from: 01a1eabb-ee28-7737-826d-38ba3dd5b5bf
---

# A background --once tail stays quiet

From the Story Studio port scan (2026-11-17). An agent that the human has left
alone runs `tail --once` as a background task, which wakes it on the next event.
Story Studio found theirs printed keepalives and reconnect pairs while it
waited, so a harness that shows background output filled with noise (`74eae9ec`,
`verbs/tail.ts`, `tailNotes.ts`). After the fix it prints one closing line on
stderr.

Our `tail --once` exists (`src/kit/workspace/verbs.ts`); whether it is noisy is
unchecked. Story Studio's `working --chat` half needs several chats, which
Scriptorium doesn't have.

## Definition of done

- [ ] Check whether our `tail --once` prints anything while it waits. If it
      doesn't, drop this item with that finding.
- [ ] If it does, it prints nothing until its event, then one closing line on
      stderr, with a test.
- [ ] Offered on kit-parity.

## Related Documents

- [Which of Story Studio's new document UX should Scriptorium take?](./story-studio-document-ux-port/item.md)
