---
type: item
title: An agent's reply to a note can't overwrite the human's note
description:
  note-edit on a human's note replaces their words when an agent means to reply,
  and its help line says it answers the note as a reply does; replies must sit
  beside the note, and an agent must not rewrite a human's text.
status: stable
lifecycle: done
id: 01a17017-1a17-750a-95c5-bc307f6d078c
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-24 }
cycle: 2026-10-release-6
parent: feature/workspace-kit-follow-ups
priority: medium
from: cycle/2026-10-release-6
released_in: 6.0.0
---

# An agent's reply to a note can't overwrite the human's note

Found 2026-10-24 in Cole's triage review in Scriptorium. Cole left a note on the
proposal ("I think we go 6.0.0, since this will be a big release"). The agent
answered with `note-edit`, whose help line says it "answers the note, as a reply
does". It replaced Cole's words with the agent's answer, keeping his text only
as `replacedBody`. The CLI has no other way to reply to a note, so an agent
following the help does exactly this. The agent restored the text by hand.

A note is the human's words about a passage. An agent may answer it, but must
not change what the human wrote.

## Definition of done

- [x] An agent can reply to a note without changing the note's text, and the
      surface shows the reply with the note.
- [x] `note-edit` refuses a note the human wrote, naming the reply verb; it
      still edits the agent's own notes.
- [x] The CLI help and the Scriptorium SKILL say which verb answers a note.
- [x] Tested on the wire and checked in a real browser; offered on kit-parity
      (message 54, 2026-10-25). (Tested and checked: see below. The kit-parity
      offer is the lead's.)

## Done and verified

Commit `d9d8c100` on `impl/note-reply-cannot-overwrite`. The kit gains
`note-reply <id> [text]` (op `note.reply`). There was no reply shape on a note
before, but the conversation already had one: an agent message with
`about.noteId`, which the agent's `say` stored when it named a note. The reply
is that message, so nothing new is stored and the panel reads replies off the
conversation (`repliesByNote`). `note-edit` now refuses a note in the human's
words, meaning one the human wrote **or rewrote last**, with a 409 `conflict`,
`choices: ["note-reply", "note-resolve"]`, and a hint naming
`note-reply <id> --doc <slug>`. The hint on a human message about a note now
names `note-reply` too. The `replacedBody` machinery is left as it was: it can
now only hold the agent's own earlier words, and old sessions still show theirs.

Verified on the wire: `daemon.integration.test.ts` drives the launcher, so the
refusal envelope, the reply, the stored note and an unknown note are all checked
there. In a real Chromium (Playwright, scratch homes, `NODE_ENV=test`), the
human selected text with the mouse and typed the note. The real CLI's
`note-edit` was refused with exit 6, and `note-reply` showed under the note with
the note's text unchanged, in the conversation too, and still there after a
reload. Story Studio has the same bug:
`packages/kit/src/workspace/verbs.ts:1454` at `accf9b03`.

Fix round, after the verifier's "with fixes":

- The `note.added` hint now names `note-reply` first, and so do the human's
  rewrite and reopen events, which share it (`noteEventFacts`).
- Two new tests: two replies both show, and a reply arrives live when no wait
  changes.
- In the Notes panel:
  - the note's own "what it replaced" box and its footer sit with the note,
    above the replies;
  - each reply says "Agent replied" and renders through the chat's markdown sink
    (`ChatMarkdown`, now exported, still the kit's one conversation sink);
  - a long reply is clamped behind "more".
- The chat chip names the note a message is about: `note on <doc>: "<quote>"`.
- `note-edit`'s help says it refuses a note the human wrote or rewrote last.

All of it was checked in a real browser, with screenshots. Left for its own
item, as the coordinator ruled: a reply to one note clears the wait on every
note.

## Port-back notes

- `session.editNote`: refuses `by: "agent"` when `note.by === "human"` or
  `note.editedBy === "human"` (409, choices `note-reply`/`note-resolve`, hint).
- `session.replyToNote({ doc?, id, text })`: validates the note, then adds an
  agent message with `about: { noteId }`.
- Protocol: `AgentCmd` gains `{ op: "note.reply"; doc?; id; body }`. The daemon
  handles it in the agent switch, and it is in `AGENT_CMD_FIELDS`.
- CLI: new `note-reply` verb, and `note-edit`'s help line no longer claims it
  answers a note.
- Human-message hint about a note: names `note-reply` between `notes` and
  `note-resolve`.
- `NotesPanel`: `replies` prop, `repliesByNote` and `NoteReply` exported,
  `data-slot="note-body"`/`note-replies`/`note-reply`. `WorkspaceShell` passes
  `repliesByNote(state.chat)`.
- `noteEventFacts` (`waiting.ts`): every hint names
  `note-reply <id> --session <s> --doc <slug> "<answer>"` before `note-resolve`.
- `NotesPanel` layout: body, then what a rewrite replaced, then the footer and
  wait badge, then the replies. Each reply is rendered by `ChatMarkdown`
  (exported from `ChatMessageView.tsx`), and one over 280 characters or six
  lines is clamped (`replyIsLong`). The panel takes an `onFollowLink` prop.
- `aboutLabel` takes an optional fifth `noteName(noteId)`; `ChatSidebar` and
  `ChatMessageView` take a `noteName` prop. `WorkspaceShell` supplies
  `note on <doc>: "<quoteLabel(quote, 40)>"` and shares one `followChatLink`
  between the chat and the panel.
