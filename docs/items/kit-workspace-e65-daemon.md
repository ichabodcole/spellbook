---
type: item
title: A note shows it is with the agent, on the kit daemon
description:
  "E65's daemon half in the kit: notesWaiting, askedIn, the one-ask guard, the
  edit and reopen fields, and the shared badge rule, written to go back to Story
  Studio."
status: draft
lifecycle: triage
id: 01a1393e-acfb-72b4-93d1-a1f5fea2984a
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [kit, notes, e65]
cycle: 2026-10-workspace-daemon
parent: feature/workspace-kit
from: items/workspace-stack-port-shape/write-up.md
---

# A note shows it is with the agent, on the kit daemon

Part of [Workspace Kit](../features/workspace-kit/feature.md)'s workspace-stack
port ([the port-shape write-up](./workspace-stack-port-shape/write-up.md)).
Story Studio's kit has only about a third of E65 ("a note shows that it is with
the agent"). This item brings the daemon half into `src/kit/workspace`, in a
form that can go back to Story Studio as `kit-per-note-waiting`:

- `notesWaiting`, `askedIn` and the one-ask `say` guard;
- `editedBy`, `reopenedAt` and `reopenedBy`;
- a human edit or reopen carrying the note's facts;
- the shared `badgeFor`.

**Ruled (Cole, 2026-10-14):** Scriptorium's `note.edited` and `note.reopened`
events are kept.

## Definition of done

- [ ] E65's rules hold, by tests ported from Scriptorium's `waiting.test.ts` and
      the server's note tests:
  - two notes and then one reply clear both;
  - a human rewrite or reopen re-arms;
  - a double ask sends one message;
  - the state survives a restore.
- [ ] `PublicState.notesWaiting` exists.
- [ ] Story Studio's agent has been offered the diff on `kit-parity`.

## Related Documents

- [How to port the workspace stack](./workspace-stack-port-shape/write-up.md)
