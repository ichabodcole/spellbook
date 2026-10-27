---
type: item
title: A sent message drops the selection it carried
description:
  After a typed message goes with the held text selection, the chip clears, so
  the next message does not send the same passage again unless the human selects
  it again.
status: stable
lifecycle: backlog
id: 01a17bfd-e3c2-7128-ad38-8cb03d45db99
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-26 }
tags: [kit, chat]
parent: feature/workspace-kit-follow-ups
---

# A sent message drops the selection it carried

Cole, 2026-10-26: he selects text, it shows in the composer's context chip, he
sends the message, and then he has to clear the chip by hand, or the next
message sends the same passage again. In real use he almost never wants to send
it twice.

Today `say` in `src/kit/shell/WorkspaceShell.tsx` already clears the references
added by hand once a message goes (`clearRefs()`), but leaves the held
selection, the tree's selected rows and the pointed documents. The chip _is_ the
held selection (`src/kit/context/selection.ts`), and the daemon holds the copy
`say` attaches, so clearing it means dropping the held selection the way the
chip's X does (`dropSelection`), which tells the daemon too. A second flag that
only hides the chip would be the defect `selection.ts` describes.

Settled with Cole, 2026-10-26:

- The editor's highlight needs nothing: clicking into the composer to type
  already clears it.
- The tree's selected rows and the pointed documents stay held after a send, as
  now. Cole wants more hands-on use of them before deciding.

## Definition of done

- [ ] After a typed message that carried the held selection is sent, the chip is
      gone and the next message carries no selection, in both the column and the
      floating composer.
- [ ] A message that did not go (no connection, session ended) keeps the
      selection held, as it keeps hand-added references now.
- [ ] The daemon's held selection is cleared too, so an agent reading it sees
      none.
- [ ] The tree's selected rows and the pointed documents are still held after
      the send.
- [ ] Tested.
