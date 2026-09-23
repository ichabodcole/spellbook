---
type: session
title: "A note that says it is with the agent — 2026-09-22"
description:
  A human's note now shows it is with the agent and goes static "may be stuck"
  like E53's messages. Resolving is the close, the event carries short notes
  whole, and the review found the pure rule pinned but the wiring around it not
tags: [scriptorium, notes, co-presence, verification]
status: stable
generated: { by: claude-opus-5.5, at: 2026-09-22 }
---

# A note that says it is with the agent — 2026-09-22

Part of
[Scriptorium from real use](../../../cycles/2026-09-scriptorium-real-use.md),
its fourth branch. The third is
[room to read](./2026-09-22-room-to-read-and-the-width-the-anchors-forgot.md).

## What this was

The skill said "a note is not a request", and agents acted on nearly every
`note.added` anyway. Cole's reading, in his Operator write-up of 2026-09-20: the
instinct is right and the outcomes have been good, so the behaviour stays and
the design around it changes. What was missing was any sign, between adding a
note and the agent's answer, that something was happening. Messages had E53's
pulse and "may be stuck"; notes had nothing. The ask is in
`docs/backlog/2026-09-22-scriptorium-a-note-is-acted-on-and-nothing-shows-it.md`.

## Rulings

- **Derived, like E53, with no new agent duty.** A note shows it is with the
  agent until the agent answers in a way the daemon can see, then goes to a
  static "may be stuck" at the same 30 s. It does not pulse, because a pulse
  over a wedged agent is false liveness.
- **`note.added` carries the note when it is short**, and longer notes point at
  `notes --doc`. The event names its next act.
- **Resolving is the response signal** (his steer, mid-branch). Resolving a note
  closes it, and the event and the skill name `note-resolve` as the close.
  Whether a reply that does not resolve should also clear "pending" was left to
  us (it does; see below).
- **Three trade-offs are to be learned in real use, not theorised.** Any agent
  reply clears every earlier note; an agent that edits silently still reads as
  stuck; `working`'s snooze covers notes added after it. Left as built (see
  Known and not built).
- Batch review of notes stays out of scope for this cycle.

## What was built

Everything is in
[E65](../decision-log.md#e65--a-note-shows-that-it-is-with-the-agent).

- **The rule**, `notesWaiting` in `backend/waiting.ts`, sits beside E53's
  `waitingOn` and shares its badge function, so a note and a message that have
  waited equally long read the same. A note is answered when it is resolved,
  when the agent says anything after the human's latest write to it, or when the
  agent rewrites or reopens it. A system line never answers it. The human
  making, rewriting or reopening a note starts its clock.
- **The event.** A human's `note.added`, `note.edited` and `note.reopened` carry
  the quote, the body and the lines (up to 1000 characters, whole or not at all)
  and a hint naming `note-resolve`. A note whose passage is gone says
  `passage: "gone"`.
- **"May be stuck" has an act: "Ask the agent".** It sends one ordinary message
  carrying the note's reference. The note then waits on that message with E53's
  own badge, the button is not offered again, and the daemon drops a second ask.
- **One scope, the session, drawn in four places:** the notes panel (with a
  pointer to other documents' owed notes), the Notes tab's dot, the floating
  composer while the column is shut, and the note menu on the passage.
- **`SKILL.md`** no longer says "a note is not a request".

## Review

**Reviewer census** (roster read from the session's available agent types):
**`general-purpose`** (tools `*`) for both the verifier and the reviewer of
record. Both were fresh agents, neither was the implementer, and both could run
code, which is the bar the earlier sessions in this cycle set.

- **Implementer:** tests first for the rule, the event shaping and the surface
  helpers, then its own browser drives.
- **Verifier** (no stake): every headline claim held (the rule, the event at
  1000 and 1001 characters, reload and restore, the skill). It found four real
  defects and two small ones:
  - A second "Ask the agent" sent the same message again, because the note still
    read "may be stuck". An asked note now waits on the message.
  - "+N more" on the floating composer was clipped inside the truncated text.
  - The four places disagreed about scope: the tab and the panel read the open
    document, the composer read the session. Stuck notes on another document
    showed only once the column was collapsed.
  - The ask carried no note id, so the agent would have had to match prose to
    resolve it.
  - Small: a rewrite of a note whose passage was gone said "act on it" with
    nothing to find, and the cap counted UTF-16 units rather than characters.
    Also, a reopened note was timed from its creation.
- **Reviewer of record** (net diff). Verdict: _land, after one prose fix_ (E65
  said "nothing new is stored except `editedBy`", which was no longer true).
  **It found no code defect. Its sharpest finding was by mutation: the pure rule
  was pinned, and the wiring around it was not.** A tick whose change key
  ignored notes (so a note would never visibly flip to "may be stuck"), an edit
  not recording who made it, a reopen always attributed to the human, a human
  rewrite carrying no text, and an ask about a missing note not being refused:
  every one of those mutants survived. Each now has a cell, and each was
  re-applied to confirm it fails. The tick's key became a pure `attentionKey`
  rather than an integration wait on a real 30 s clock. The same pass sharpened
  two surface cells: an ordering that passed only because the input was already
  in order, and the emoji-safe cut.

## Rulings made here that Cole did not cover

All are recorded in E65 with the options not taken.

- **A reply that does not resolve still clears "pending"**, and the note stays
  open. Counting only resolve would raise a false "may be stuck" whenever the
  agent forgot to resolve, and E53's premise is that it forgets.
- **No drawn "acknowledged" state, and no ✓.** The daemon cannot tell a reply
  was about this note, so either would claim more than it knows.
- **No daemon nudge for a stuck note.** The human's act routes through the
  conversation, where E53's one nudge already lives.
- **1000 characters** is the event's cap: a phrase-to-paragraph note travels
  whole, and a whole section is worth the `notes` round trip.
- **The running text is not marked**: notes are already in the attention colour,
  so a stuck tint would not be told apart.
- **A human reopen re-arms a note from the reopen**, whether or not it had been
  answered: one rule for making, rewriting and reopening.

## Known and not built

- **Any agent reply clears pending on every earlier note, across documents**
  (Cole: learn it in use). The verifier's repro: an unrelated question and
  answer in the chat silenced a note nobody had touched, and one `say` cleared
  every stuck note across two documents. The notes stay open; only the signal
  goes.
- **An agent that edits the noted passage without speaking still reads as "may
  be stuck"** (Cole: learn it in use). The agent writes a new version, changes
  the passage, and says nothing; at 30 s the note says it may be stuck.
- **`working`'s snooze covers notes added after it** (Cole: learn it in use). A
  note made during a snooze pulses until the snooze ends.
- **The chip survives a document switch under the new document's name.** It
  predates this branch (`develop`'s build does the same), and the reviewer
  reproduced it with a real mouse. A `say` then sends alpha's text as if it were
  beta's. It is filed as the most serious edge in
  `docs/backlog/2026-09-22-scriptorium-selection-edges-the-review-found.md`, and
  it breaks this cycle's appetite ("the context chip always matches the
  selection"). The same file holds the verifier's other pre-existing find: a
  note added from the Notes panel does not consume the selection.

## Verification

`bun run gate` on the final tree, run unpiped: exit 0, tree clean afterwards
(the committed `dist/` reproduces). E65 is minted in
`docs/projects/scriptorium/decision-log.md`.

## What to exercise, next time the app is open

1. **Add a note and watch the agent pick it up.** It should pulse, then go quiet
   once the agent answers. Check whether the agent now resolves the note when it
   is done.
2. **Leave a note unanswered past 30 s** and try "Ask the agent". It should send
   once, then read "asked in the conversation…".
3. **Chat about something else while a note is outstanding.** The reply will
   clear the note's pending mark (known limit 1); notice whether that ever
   misleads you.
4. **Let the agent fix a passage in a new version without a word** (known limit
   2), and see whether "may be stuck" then feels false or fair.
5. **Switch documents with a passage selected** before sending a message, and
   look at the chip. Until the selection edge is fixed, it will be wrong.
