---
type: item
title: Owed notes go to the inbox
description:
  The Notes panel and its dot speak only for the open document; an unanswered
  note elsewhere is an inbox row, and the notes-elsewhere box goes.
status: draft
lifecycle: backlog
id: 01a1eb00-512b-72a6-b0d3-c95f34612dfc
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-17 }
parent: feature/scriptorium-inbox
from: 01a1eabb-ee28-7737-826d-38ba3dd5b5bf
blocked_by: [01a1eb00-509f-7179-a982-87bd52c9499a]
---

# Owed notes go to the inbox

From the Story Studio port scan (2026-11-17). Once the inbox lists notes that
wait on the agent, Scriptorium's notes-elsewhere box in the Notes panel
(`data-slot="notes-elsewhere"`, `src/kit/chat/NotesPanel.tsx`) shows the same
thing twice.

Story Studio did this in `365f91ea`: the Notes panel and its dot speak only for
the open document, and an unanswered note in another document is a With the
agent row in the inbox, which opens that document with the note focused. The
change is mostly deletions (`chat/NotesPanel.tsx`, `chat/noteWaiting.ts`), plus
the right column's tab rules.

Keep Spellbook's rail mark (`src/kit/shell/rail.ts`), which Story Studio lacks
and which does a different job: it shows which document in the tree waits.

Blocked by [kit-inbox](kit-inbox.md). [kit-icon-tabs](kit-icon-tabs.md) lands
with or after this one, so owed notes never lose their cue.

## Definition of done

- [ ] The Notes panel and its tab's dot count only the open document's notes.
- [ ] An unanswered note in another document is an inbox row that opens that
      document with the note focused.
- [ ] The notes-elsewhere box is gone; the rail's waiting mark still shows.
- [ ] Offered on kit-parity.

## Related Documents

- [Which of Story Studio's new document UX should Scriptorium take?](./story-studio-document-ux-port/item.md)
