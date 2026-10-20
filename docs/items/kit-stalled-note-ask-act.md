---
type: item
title: A note waiting on the agent has no Ask the agent act
description:
  "E65's stalled-note act is missing on the kit path: the Notes panel shows a
  note waiting on the agent but offers no Ask the agent, which the shipped app
  does."
status: stable
lifecycle: ready
id: 01a157b8-bb40-77b6-a35c-5f67234ee539
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
from: cycle/2026-10-shell
cycle: 2026-10-shell
---

# A note waiting on the agent has no Ask the agent act

Found by the Atlas comparison (C7) on 2026-10-20. When a note waits on the agent
and stalls, the shipped Scriptorium offers "Ask the agent" on it (E65). The
kit's `NotesPanel` has no `onAsk`, so the act is missing on the flagged path.
E65 is one of the shipped behaviours the port must not lose.

## Definition of done

- [x] A stalled note in the Notes panel offers Ask the agent, which sends the
      ask as the shipped app does (`via: "ask"`, `about.noteId`).
- [ ] Tested over a real daemon, and offered on kit-parity. (Tested over a real
      daemon: done. Offering it on kit-parity is the lead's.)

**Done and verified (2026-10-20).** Commits `c0ba45c3` (kit), `a1e829bc`
(flagged frame) and `27876ae1` (dist). Kit work, not a port: Story Studio's kit
(`develop` at `2846a475`) has no ask act. The act is in the Notes panel and on
the floating composer's note line, offered only beside "may be stuck", and opted
into through `WorkspaceShell`'s `askAboutNotes` (the flagged frame passes
`true`, whose words are the shipped app's). The press sends one `say` with
`via: "ask"` and `about.noteId`; the daemon's existing one-ask guard
(`askOutstanding`) refuses a second. The surface reads the same rule off the
conversation (`askedAbout`), so an asked note reads "asked in the
conversation..." with the conversation's badge (the shipped `askedIn`'s
behaviour) and is not offered the act again until it is a new question; a press
is also held locally until the snapshot brings the message, so a double press
sends nothing twice. Checked in a real browser beside the shipped app, with
quiet agent tails: a double press in the panel and in the float each put one ask
on the tail. One deliberate difference: the shipped app brings the conversation
forward after the ask; the kit leaves the view where it is, as its other buttons
do (the 2026-10-14 ruling on kit buttons), and the note's own badge shows the
ask went.

## Port-back notes

For Story Studio's kit (none of this exists there yet):

- **A deliberate difference from shipped E65 (the lead's ruling, 2026-10-20):
  with no agent listening, no Ask is offered.** The note reads "no agent is
  listening yet" rather than the shipped app's false "may be stuck" (Atlas
  comparison call C3, which Cole took), and an ask would reach nobody. A note
  already asked keeps saying so: "asked; no agent is listening yet".
- `chat/WaitingBadge.tsx`: a third `WaitingOf`, `"asked"`, with `ASKED_LABEL`
  ("asked in the conversation...", "asked, and still no word; may be stuck") and
  `ASKED_UNHEARD_LABEL` ("asked; no agent is listening yet"); `labelOf` reads a
  table, and keeps the asked words under `unheard`.
- `chat/noteWaiting.ts`: `askedAbout(waiting, docs, chat)` (the owed notes whose
  ask is outstanding, by `workspace/waiting.ts`'s `askOutstanding`) and
  `askAboutNoteText(note, docName)` (the ask's default words, an excerpt).
- `chat/NotesPanel.tsx`: optional `asked` and `onAsk`; the button
  (`data-action="note-ask"`) shows only on a shown `stalled` badge, not once
  asked.
- `chat/FloatingComposer.tsx`: optional `asked` and `onAskNote`; `floatNote`
  takes `asked` and names the oldest note not yet asked about; the button is
  `data-action="float-note-ask"`.
- `shell/WorkspaceShell.tsx`: optional `askAboutNotes` (`true` or a words
  function); sends the ask with no held refs, holds the press until the snapshot
  shows it, and gives an asked note the conversation's wait badge. Grouped in
  the notes block beside `notesWaiting`.
