---
type: item
title: The shell passes the context pane's slots through
description:
  WorkspaceShell threads askLocation, beforeMove and uncheckedMoveNote, the
  refusal hint and Notes' addUnavailable to the panes, so an app on the shell
  keeps the slots the panes cycle added.
status: stable
lifecycle: ready
id: 01a15621-4cbc-7631-993b-c7f56626f53c
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [kit, shell]
parent: feature/workspace-kit
blocked_by: [01a15621-4526-739e-9a62-6a499cfa8561]
cycle: 2026-10-shell
---

# The shell passes the context pane's slots through

The panes cycle gave our `ContextSidebar` and Notes slots that Story Studio's
shell doesn't pass: `askLocation`, `beforeMove` with `beforeMoveTimeoutMs` and
`uncheckedMoveNote`, the refusal `notice` (the "To go on: …" hint), and Notes'
`addUnavailable`. An app on the shell would lose them, and Scriptorium needs
every one: it has no home workspace, and its move plan confirms through
`beforeMove`.

## Definition of done

- [ ] `WorkspaceShell` takes each slot as an optional prop and hands it to the
      pane, unchanged.
- [ ] A test shows each one reaching its pane through the shell.
- [ ] Without them, the shell behaves as Story Studio's does.
- [ ] Offered on kit-parity together with the slots themselves.
