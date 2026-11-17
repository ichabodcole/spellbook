---
type: item
title: new-doc can hold the agent's text
description:
  The new-doc verb takes --body-file or --stdin, so an agent's draft arrives as
  a document with no empty first version to activate.
status: draft
lifecycle: backlog
id: 01a1eb00-53e8-76e1-ac55-b1c03e02fc02
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-17 }
parent: feature/workspace-kit-follow-ups
from: 01a1eabb-ee28-7737-826d-38ba3dd5b5bf
---

# new-doc can hold the agent's text

From the Story Studio port scan (2026-11-17). An agent drafting a new document
in Scriptorium today runs `new-doc` (an empty document), then `version-new` with
its text, and the human activates it. The empty first version is noise.

Story Studio's `new-doc` takes `--body-file` or `--stdin` (`a5eeb703`, kit
`workspace/verbs.ts` and `session.ts`), and `240427bc` added `--many`. Our
`doc.create` op already accepts `text` (`src/kit/workspace/server.ts`); only the
verb (`src/kit/workspace/verbs.ts`) doesn't pass it. Undo of a seeded document
sends it to the Trash, as for any new document.

Small, and not blocked by the split. It edits `verbs.ts`, so it lands after
[#137](kit-unpinned-verbs-write-to-another-session/item.md) and
[#145](kit-task-done-takes-no-body-file/item.md) if those are still open.

## Definition of done

- [ ] `new-doc <path> --body-file <file>` and `--stdin` create the document
      holding that text, with no empty version before it.
- [ ] Without either, `new-doc` still creates an empty document.
- [ ] The SKILL tells the agent to seed a drafted document this way.
- [ ] Offered on kit-parity.

## Related Documents

- [Which of Story Studio's new document UX should Scriptorium take?](./story-studio-document-ux-port/item.md)
