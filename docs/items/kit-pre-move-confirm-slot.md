---
type: item
title:
  A pre-move confirm slot on the context pane; Scriptorium's move plan through
  it
description:
  The kit's context pane asks the app before a move and can show the human what
  the move would change; Scriptorium's move.plan (links a move would break)
  fills it, so a move waits for the human's confirm.
status: draft
lifecycle: triage
id: 01a14bca-15aa-7799-ac7c-13940a5dd463
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, story-studio, context]
parent: feature/workspace-kit
cycle: 2026-10-panes
---

# A pre-move confirm slot on the context pane; Scriptorium's move plan through it

The kit's sidebar moves a document at once (`onStructure({op:"move"})`). A hook
(`beforeKitAct`) can refuse a move, but it can't ask the human anything.
Scriptorium's shipped surface shows a move plan first: the links the move would
break, and which ones it would fix. The wiki-layer cycle made that plan a daemon
command (`move.plan`) and left the dialog for this cycle (Cole agreed,
2026-10-16).

The slot is generic: an app may answer "show the human this before moving", and
an app that doesn't fill it moves as today. Story Studio has no such slot yet
(kit-parity message 42 says they'd likely use it later to move a bundle's own
files), so it is built here and offered back.

## Definition of done

- [ ] The context pane takes an optional pre-move slot. Given the move, the app
      returns a plan to show, or nothing. With a plan, the move waits for the
      human's confirm or cancel. With no slot, nothing changes, and a test
      proves it.
- [ ] The flagged Scriptorium fills the slot from `move.plan`, so a drag or menu
      move shows the links it breaks and fixes before it happens.
- [ ] Cancel leaves the disk and the tree as they were, and a test shows it.
- [ ] The slot is offered to Story Studio on kit-parity.
