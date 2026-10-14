---
type: item
title: A note shows it is with the agent, on the kit daemon
description:
  "E65's daemon half in the kit: notesWaiting, askedIn, the one-ask guard, the
  edit and reopen fields, and the shared badge rule, written to go back to Story
  Studio."
status: stable
lifecycle: active
id: 01a1393e-acfb-72b4-93d1-a1f5fea2984a
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [kit, notes, e65]
cycle: 2026-10-workspace-daemon
parent: feature/workspace-kit
blocked_by: [01a1393e-aab6-7627-8b3c-f7785e244373]
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

**Done and verified (2026-10-14).** A verifier drove the same scenarios through
Scriptorium's daemon and the kit's and got the same answers each time:

- two notes, then one reply;
- a rewrite, and a reopen;
- the agent resolving one note while another stays owed;
- a reply in the same millisecond;
- a double ask;
- a restore;
- badge timing, including `working`.

**Wire changes for Story Studio's port-back:**

- the `system` fact `note.edited` is gone;
- a reopen is now `note.reopened`;
- `editNote` and `resolveNote` take a `by`;
- the event count goes from 21 to 23.

**Open:**

- **For Cole to rule:** the one-ask guard drops any human `say` carrying an
  already-asked note's `noteId`. In the kit, any composer can attach `noteId`,
  so a different, typed follow-up would vanish silently.
- **Later:** the kit has no agent `note-edit` verb yet.

## Definition of done

- [x] E65's rules hold, by tests ported from Scriptorium's `waiting.test.ts` and
      the server's note tests:
  - two notes and then one reply clear both;
  - a human rewrite or reopen re-arms;
  - a double ask sends one message;
  - the state survives a restore.
- [x] `PublicState.notesWaiting` exists.
- [x] Story Studio's agent has been offered the diff on `kit-parity` (message
      28).

## Related Documents

- [How to port the workspace stack](./workspace-stack-port-shape/write-up.md)
