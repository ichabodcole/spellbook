---
type: item
title: A note shows it is with the agent, on the kit daemon
description:
  "E65's daemon half in the kit, converged on Story Studio's 85a319e, plus an
  explicit one-ask guard for the Ask-the-agent button, offered back to Story
  Studio."
status: stable
lifecycle: done
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

**Superseded by convergence (Cole, 2026-10-14).** Story Studio built E65 in its
own kit as `85a319e` (kit-parity message 29): no `askedIn`, an agent `note-edit`
verb with `replacedBody` and undo, the agent's own note acts kept quiet, and the
wire unchanged (`note.edited` stays a fact; a reopen is still
`note.resolved{false}`). Cole ruled to converge on it:

- drop `d1ca788d` and port the workspace half of `85a319e`;
- add only an explicit one-ask guard: a `say` marked as the "Ask the agent" act
  is sent once per note, and a typed follow-up carrying a `noteId` is never
  dropped;
- offer the guard back to Story Studio on `kit-parity`.

If the converged behaviour causes a UX problem in use, it is fixed then,
possibly by going back to the earlier shape, and both apps follow the same path.
The earlier ruling to keep `note.edited` and `note.reopened` as events is
superseded by this one for the kit; Scriptorium's own daemon is unchanged until
the cutover.

The chat, shell and document halves of `85a319e` wait for their own cycles.

**Converged and verified (2026-10-14).** The revert is `4cfa9e49`, the port is
`3f33074e`, and the guard is `7aa3eea0` plus `14c9bb52`:

- the marker is `about: { noteId, ask: true }`, stored on the message and
  stripped from the agent's tail;
- a second marked ask while the note is owed answers the sender with an error
  frame for its `rid`, and nothing else sees it.

A no-stake verifier found the port byte-identical to `85a319e` apart from two
declared context hunks. It also confirmed the behaviour on a live daemon,
including across a restart.

**Superseded on the wire (2026-10-14, kit-parity messages 38 and 39).** Cole
ruled in Story Studio that the kit's buttons get their own `via` values
(`KIT_VIA = ["chat", "describe", "fix", "ask"]`). So the one-ask guard keys on
`via === "ask"` with `about.noteId`, and `about.ask` goes. Story Studio builds
that guard from `askOutstanding` and its tests, and we take it back with their
via-and-refs daemon half, dropping `about.ask` in the same port. Until then
nothing sends either marker.

**For the chat cycle:** the Ask-the-agent button sends the marker with a `rid`,
and reads an error frame as "already with the agent", not as an error. Typed
messages never set `ask`.

**For item 5 (the skill):** the `note-edit` row and example in `verbs.md`, and
the "with the agent" note in `SKILL.md`, as `85a319e` wrote them for Atlas.

## Definition of done

The boxes below record the first shape (`d1ca788d`), now superseded.

- [x] E65's rules hold, by tests ported from Scriptorium's `waiting.test.ts` and
      the server's note tests:
  - two notes and then one reply clear both;
  - a human rewrite or reopen re-arms;
  - a double ask sends one message;
  - the state survives a restore.
- [x] `PublicState.notesWaiting` exists.
- [x] Story Studio's agent has been offered the diff on `kit-parity` (message
      28).

Converged shape:

- [x] `d1ca788d` is reverted, and the workspace half of `85a319e` is ported,
      with its tests passing.
- [x] A marked ask is sent once per note; an unmarked `say` carrying a `noteId`
      is always delivered. Both are tested.
- [x] The guard has been offered to Story Studio on `kit-parity` (message 32).

## Related Documents

- [How to port the workspace stack](./workspace-stack-port-shape/write-up.md)
