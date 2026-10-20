---
type: item
title: A note waiting on the agent has no Ask the agent act
description:
  "E65's stalled-note act is missing on the kit path: the Notes panel shows a
  note waiting on the agent but offers no Ask the agent, which the shipped app
  does."
status: draft
lifecycle: triage
id: 01a157b8-bb40-77b6-a35c-5f67234ee539
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
from: cycle/2026-10-shell
---

# A note waiting on the agent has no Ask the agent act

Found by the Atlas comparison (C7) on 2026-10-20. When a note waits on the agent
and stalls, the shipped Scriptorium offers "Ask the agent" on it (E65). The
kit's `NotesPanel` has no `onAsk`, so the act is missing on the flagged path.
E65 is one of the shipped behaviours the port must not lose.

## Definition of done

- [ ] A stalled note in the Notes panel offers Ask the agent, which sends the
      ask as the shipped app does (`via: "ask"`, `about.noteId`).
- [ ] Tested over a real daemon, and offered on kit-parity.
