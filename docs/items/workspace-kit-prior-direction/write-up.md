---
type: write-up
title: Where our messaging and context direction meets Story Studio's kit
description:
  Sorts each idea from Spellbook's earlier context, chat and message-log
  thinking into superseded, evolution or open direction against Story Studio's
  kit, with code evidence from both
tags: [kit, chat, context, story-studio]
status: draft
generated: { by: claude-opus-5-5, at: 2026-10-13 }
---

# Where our messaging and context direction meets Story Studio's kit

**Outcome:** Work items to file on Workspace Kit, and a ruling from Cole on the
four earlier documents.

## What was found

- **Story Studio settled the naming and the selection, and it is ahead on
  both.** It names the speaker `from`, the author `by`, the display axis `type`
  and the wire frame `op`. That answers the message-log write-up's `who`/`role`
  and `kind` questions. Its `about` and its chip in the log do more than any
  Spellbook spell's. Its quiet tail puts the ambient-vs-intent canon into code,
  with tests.
- **It has no message provenance.** A message the human sends from a button
  ("Ask the agent to fix", "Ask the agent to describe") is posted exactly as a
  typed one. The code says so in a comment. Mind-mapper's channels, facets and
  collapse have nothing to replace them, so they are the main evolution to carry
  on top.
- **Its context sidebar is a file manager, not a headless list.** It takes props
  only, but the props are paths, `listDir`, Reveal, Trash and structure ops. It
  covers the disk host well. It does not cover the "disk, db or inline is
  invisible to the UI" direction. Workspace Kit's claim that it replaces Context
  and Chat Kit phase 3 holds only for the disk case.
- **Spellbook's Scriptorium is ahead in one place the port plan does not list.**
  E65 exists only in Spellbook: one feature in three parts, the "Ask the agent"
  button, the note showing it is with the agent, and the one-ask-at-a-time
  guard. Story Studio carries `about.noteId` on the wire, but nothing in its kit
  or apps produces it, and the daemon does not check it.
- **The port changes what Scriptorium's agent reads.** Scriptorium's `message`
  event carries `selection`, `active` and `note`. Story Studio's carries
  `about`. The information is the same, but the shape changes, so acc and the
  SKILL text have to move with it.
- **Three claims in the earlier documents do not hold against the code.** See
  [Claims checked](#claims-in-the-earlier-documents-checked-against-the-code).

## Question

For each idea in Spellbook's earlier context, chat and message-log thinking, and
for each idea Story Studio has that the earlier thinking lacked: is Story
Studio's version as good or better (superseded), is it worth carrying on top of
the ported module (evolution), or is it valid but outside Workspace Kit (open
direction)?

This feeds two decisions: what the workspace stack's chat and context modules
carry beyond the port, and in what order; and whether each of the four earlier
documents closes, continues, or folds into Workspace Kit.

Settled before this started, and not reopened here: the chat's refs (`about`,
`HeldSelection`) port as they are, and the broader ref contract comes later on
top (Cole, 2026-10-13).

## Method

- Read the four earlier documents and the item, then read the code each claim
  points at, in both repos. Story Studio was read at `fd06b41`
  (`~/Projects/dreamwood/story-studio/packages/kit/src`, plus `apps/atlas` and
  `apps/sound-stage` where an app is the only producer of something). Spellbook
  was read at `0392302f`.
- Checked each doc claim about code against the code. Where a claim was about
  what the code does at run time, ran the tests that pin it:
  `bun test src/mind-mapper/surface/state/messageChannel.test.ts src/mind-mapper/surface/state/groundRefs.test.ts src/scriptorium/backend/selection.test.ts`
  (30 pass, 0 fail). Nothing was run in Story Studio.
- Story Studio paths below are relative to its `packages/kit/src` unless they
  start with `apps/`. Spellbook paths are relative to this repo.
- The canon was read from `grimoire/house-style.md` and from the memories that
  hold it where house style does not (the message-surface paradigm and ambient
  vs. intent are not in house style; see finding 17).
- A second agent with no stake in the result then re-checked the load-bearing
  claims against the code in both repos. All held or partly held. The partial
  ones are corrected in place: Atlas's board selection already lives in the
  daemon (finding 11); Story Studio marks only one of the misaligned tail rows
  (finding 14); channels after `shell` is a preference, not a dependency; Sound
  Stage's pace button is a fourth producer of `say`.

## Classification

| #   | Idea                                                                   | Verdict                    | One-line reason                                                                                                                     |
| --- | ---------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Ref modes: pinned and live, each read recorded                         | Evolution, later (CCK 1)   | `about.doc` + `version` is pinned; `about.docs` is bare paths, live, with no record of what was read.                               |
| 2   | Range as a tagged union                                                | Evolution, later (CCK 1)   | `about` keeps lines only; offsets, headings and notes' quote anchors exist elsewhere in the kit. Add the quote anchor to the union. |
| 3   | Role on a ref                                                          | Evolution, later (CCK 1)   | No role anywhere; the composer holds one kind of pointer at a time, so imago's focus-plus-references cannot be said.                |
| 4   | Resolution that refuses with candidates                                | Superseded (documents)     | `findDoc` + `SessionError(…, choices, hint)` already does it in both repos; one small gap (ambiguous reads as missing).             |
| 5   | Ref chips in messages                                                  | Superseded, plus evolution | `aboutLabel` and the about chip beat Scriptorium's; app parts of `about` are dropped from the log, and the chip does nothing.       |
| 6   | Gesture vs. typed provenance (channels)                                | Evolution                  | Story Studio posts button messages "exactly as the composer's send would"; nothing stamps where a message came from.                |
| 7   | Facets and collapse in the log                                         | Evolution                  | `ChatSidebar` has no filter and no collapse; mind-mapper's pure helpers port across once 6 exists.                                  |
| 8   | `ground` as the ref grammar                                            | Superseded                 | `about` plus the app's `messageAbout` hook covers what `ground` does, without flattening refs.                                      |
| 9   | Naming: `who`/`role`, what `kind` means                                | Superseded                 | Story Studio's protocol header fixes `from`, `by`, `type`, `op`; mind-mapper's `kind` carries two axes and shows why.               |
| 10  | Headless context list with backend adapters                            | Open direction             | Story Studio's sidebar is props-only but shaped by the file system; the backend-agnostic list is still unbuilt and still gated.     |
| 11  | The selected and active channels                                       | Superseded, plus evolution | Active and selected both exist; `pointedDocs` is surface-only state, and `entryIds` has no producer anywhere.                       |
| 12  | Drop intake and `DropZone`                                             | Open direction (CCK 1)     | Story Studio has no shared drop component; `splitDropped` and `rowDrag` are the best seed, and the port adds a sixth copy.          |
| 13  | Tasks and notes generalise                                             | Superseded, plus evolution | They generalised (runners in Sound Stage and Atlas); Spellbook's E65 is missing from Story Studio and from the port's merge list.   |
| 14  | Quiet tail vs. ambient-vs-intent                                       | Superseded, plus evolution | `TailRule` implements the canon with tests; a few rows (the agent's own acts, `task.progress`, `system`) need a look.               |
| 15  | The agent's cheap map                                                  | Open direction             | Covered for a workspace by `graph`, card summaries and `profiles`; the cross-project standard still needs it as a requirement.      |
| 16  | Document profiles and typed relations as inputs                        | Open direction             | Story Studio's profiles and `_relations.json` are the most concrete inputs yet to the context standard; they port with the stack.   |
| 17  | The paradigm and ambient-vs-intent in house style                      | Open direction, tied to 6  | Neither is written in house style; the channel evolution is the moment to write the paradigm.                                       |
| 18  | Imago and glamour catalog drift                                        | Open direction             | Neither spell is on the workspace stack; nothing in the port touches it.                                                            |
| 19  | Where the context standard lives (stewardship)                         | Open direction             | A cross-project question; Story Studio adds evidence but no answer.                                                                 |
| 20  | Story Studio's `messageActions`, `messageAbout`, `result`, reply hints | Superseded (new, take)     | Ideas the earlier thinking lacked; each is a slot or a field the port brings, and Atlas uses them.                                  |

"CCK 1" means Context and Chat Kit phase 1, which Workspace Kit leaves in place.
"Later" means after the port, on top of `about`, as Cole ruled.

## Current state

**Spellbook.** Scriptorium's chat message is
`ChatMessage {id, who, text, ts, selection?, activePath?, note?}`
(`src/scriptorium/backend/protocol.ts:331`), with `ChatWho` at line 290. The
held selection is `HeldSelection`
(`src/scriptorium/surface/state/selection.ts:18`). Mind-mapper's message is
`{who, kind, channel, text, ground}` (`src/mind-mapper/surface/types.ts:137`),
adapted from a wire shape `{role, kind, ground}` by `toDisplayMessage`
(`src/mind-mapper/surface/App.tsx:98`). Its channel vocabulary is in
`src/mind-mapper/surface/state/messageChannel.ts`, and its `ground` grammar in
`src/mind-mapper/surface/state/groundRefs.ts` (not in `messageChannel.ts`, as
the item says).

**Story Studio.** The message is `Message {id, from, type, text, about?, ts}`
(`workspace/protocol.ts:329`), and `MessageAbout` (line 308) is the selection's
fields plus `entryIds`, `docs` and `noteId`. `HeldSelection` and its rules
(`context/selection.ts:37`, `heldAfter` at 65) are Scriptorium's, nearly
unchanged. A test holds the surface's `selectionOnScreen` equal to the daemon's
(`context/selection.test.ts:4`, against `workspace/selection.ts:20`). The tail
rule is `TailRule` and `KIT_EVENT_TAIL` (`workspace/events.ts:50`, `58`).

## Findings, idea by idea

Each section gives the evidence from both repos, then the verdict, and for an
evolution where it attaches and roughly how big it is.

### 1. Ref modes: pinned and live, each read recorded

- **Spellbook's idea** (Context and Chat Kit, phase 1): `pinned` refs carry the
  version they were taken against (Scriptorium's E66 guard); `live` refs follow
  the target; either way each read records what was read.
- **Story Studio:** `about.doc` with `about.version` is pinned, and the
  selection carries both (`workspace/server.ts:2436`, `aboutFor`). `about.docs`
  is a list of absolute paths with no version (`workspace/protocol.ts:318-323`):
  a live ref. Nothing records what the agent then read. `DocView.hash` exists
  (`protocol.ts`, the `DocView` type) but does not ride the message.
- **Verdict: evolution, later.** It belongs to the ref contract, which Cole
  deferred to land on top of `about`. It attaches to `MessageAbout`
  (`workspace/protocol.ts:308`) and to `aboutFor` in the daemon. Small for the
  type, medium with the read record, because the agent's reads happen through
  verbs, not through the message.

### 2. Range as a tagged union

- **Spellbook's idea:** line range, char span or `#fragment`.
- **Story Studio:** `about` keeps `fromLine`/`toLine` only. The held selection
  has source offsets (`from`, `to` in `HeldSelection`) that `about` drops. Links
  to headings resolve `#fragment`s (`lib/headingAnchor.ts`, and the `heading`
  field on the agent's `show`, `workspace/protocol.ts:1752-1759`). Notes anchor
  by **quote plus surrounding text**, never by offset (`Note` at
  `workspace/protocol.ts:210`, `quote`, `before`, `after`; the same in
  Spellbook's `src/scriptorium/backend/anchors.ts`).
- **Verdict: evolution, later.** It attaches to `MessageAbout`. One addition the
  earlier thinking missed: the quote anchor is a fourth range kind, and it is
  the one that survives edits. The union should be lines, char span, `#fragment`
  and quote.

### 3. Role on a ref

- **Spellbook's idea:** an optional role with host-defined parameters (imago's
  focus vs. reference; StoryLoom's guidance and adherence).
- **Story Studio:** no role field. Two things in its code shape the problem:
  - The composer holds **one kind of pointer at a time**: a text selection or
    pointed-at documents, never both (`context/workspace.ts:87-93`;
    `shell/WorkspaceShell.tsx:721-740`). Imago sends a focus and references in
    one message, so this rule would have to relax.
  - The app hook `messageAbout` (`workspace/server.ts:565`) lets an app add its
    own parts to `about` on the agent's tail. Atlas adds `map` and the selected
    canvas cards (`apps/atlas/backend/server.ts:83-86`,
    `apps/atlas/backend/messageAbout.ts`). An app-defined role could ride there
    today, untyped.
- **Verdict: evolution, later.** It attaches to `MessageAbout` and to the
  `PointedDocs` rule. Medium, because relaxing "one kind at a time" touches the
  composer, the shell and the chip.

### 4. Resolution that refuses with candidates

- **Spellbook's idea:** the agent names a ref by id or title, and an ambiguous
  or missing one is refused with candidates.
- **Both codebases already do it for documents.** `findDoc` resolves by slug,
  absolute path, alias or unique base name, and a miss throws
  `SessionError(…, 404, choices, hint)` (Story Studio
  `workspace/session.ts:1222` and `1242`; Spellbook
  `src/scriptorium/backend/session.ts:617` and `622`).
- **One gap, in both:** a base name that matches two documents returns nothing
  (`byName.length === 1 ? … : undefined`), so the refusal says "no document"
  rather than "two documents have that name". That is a one-line fix to send
  back through the port-back item.
- **Verdict: superseded for documents.** Resolution by title for other kinds of
  ref (images, bundles, a spell's own types) stays with the ref contract.

### 5. Ref chips in messages

- **Spellbook's idea:** refs show as chips inside a message. Context and Chat
  Kit says no spell does this; that claim is wrong (see Claims checked).
- **Spellbook today:** Scriptorium draws the selection under the message,
  `doc · vN · lines a–b` plus the passage
  (`src/scriptorium/surface/components/ChatMessageView.tsx:64`, since
  `f718b296`, 2026-09-12). Glamour prints an `about:` line
  (`src/glamour/surface/components/MessageBubble.tsx:16-25`). Mind-mapper
  resolves each `ground` ref and draws a ground line
  (`src/mind-mapper/surface/MessageBubble.tsx:87`).
- **Story Studio:** `aboutLabel` (`chat/ChatMessageView.tsx:57`) names the
  document, version, lines, a note, pointed documents and context items in one
  chip, drawn under the message (line 132, `data-slot="about-chip"`), with tests
  (`chat/ChatMessageView.test.tsx:110-147`). Its comment states the rule: "the
  record shows what was sent."
- **Two gaps:**
  - **The app's parts of `about` never reach the log.** The daemon stores the
    kit's parts on the message and adds the app's parts to the tail event only
    (`workspace/server.ts:2873-2875`, "On the tail's message only: the chat
    keeps the kit's parts"). So when Atlas sends a message about selected canvas
    cards, the agent gets them and the human's log does not show them. That
    breaks the chip's own rule.
  - **The chip is a paragraph, not a control.** It cannot open or reveal what it
    names.
- **Verdict: superseded, plus evolution.** Take Story Studio's chip. Carry two
  small changes on top: store the app's `about` parts on the message, with a
  chip slot on `ChatSidebar` (`chat/ChatSidebar.tsx`) so the app labels its own
  parts; and make each part of the chip open or reveal its target. Small each.

### 6. Gesture vs. typed provenance (channels)

- **Spellbook's idea** (the message-surface paradigm, built in mind-mapper R11):
  every affordance is a channel into the one message bus and stamps where the
  message came from. Mind-mapper stores the channel and draws it as a tinted
  chip with an honest fallback for unknown channels
  (`src/mind-mapper/surface/state/messageChannel.ts:35-72`). The daemon keeps
  the vocabulary open and warns on an unknown one
  (`src/mind-mapper/backend/send.ts:24`, `MESSAGE_CHANNELS` in
  `src/mind-mapper/backend/events.ts:241`).
- **Story Studio:** messages sent from buttons are posted as typed ones, on
  purpose. "Ask the agent to fix" is "a chat message from the human, with the
  document pointed at, exactly as the composer's send would post it"
  (`document/DocumentPane.tsx:909-913`). "Ask the agent to describe" is the same
  (`shell/WorkspaceShell.tsx:981-1000`). `Message` has no field that could say
  otherwise (`workspace/protocol.ts:329`). `PointedDocs.from` names the view
  that pointed (`context/workspace.ts:121`), but it stays in the surface and
  never reaches the message.
- **What this means for the canon.** Story Studio already meets
  conversation-primary: a button posts a readable conversational message. What
  it lacks is the paradigm's second half, the stamp.
- **Verdict: evolution.** Add an optional `via?: string` (name to be settled) to
  `Message` and to the `say` op (`workspace/protocol.ts:329`, `1516-1521`), set
  by the surface that sends, defaulting to the composer. Draw it in
  `ChatMessageView`. Port mind-mapper's pure helpers (label, title, chip class,
  fallback) into `src/kit/chat/`. Medium-small: one field, its producers
  (composer, `askDescribe`, `askProfileFix`, and Sound Stage's pace button,
  `apps/sound-stage/surface/components/Toolbar.tsx:113-123`, if channels go
  upstream), one renderer, and an agent-facing field to declare in acc.
- **A question this raises for Cole.** Story Studio treats a human task as "a
  request for the agent, not a chat message" (`workspace/server.ts:2948-2950`),
  and a note as its own event. Under the paradigm both would be channels into
  the log. Whether they should be is a product call.

### 7. Facets and collapse in the log

- **Spellbook:** `channelFacets` and `filterByChannel` (present-only facets,
  empty means no filter) and `collapsesByDefault` (only the human's side-channel
  messages collapse) in `messageChannel.ts:86-117`, used by
  `ConversationPanel.tsx:101-102` and `MessageBubble.tsx:82-86`, with tests
  (passing).
- **Story Studio:** `ChatSidebar` maps every message straight to
  `ChatMessageView` (`chat/ChatSidebar.tsx`, the `messages.map`). No filter, no
  collapse.
- **Verdict: evolution, after 6.** Without a channel there is nothing to facet
  on. It attaches to `ChatSidebar`, as a filter strip above the log and a
  collapsed state in `ChatMessageView`. Small.

### 8. `ground` as the ref grammar

- **Spellbook:** mind-mapper's `ground: string[]`, bare id for a node, `doc:`
  and `zone:` prefixes, unknown refs dropped silently
  (`src/mind-mapper/surface/state/groundRefs.ts:21-37`); glamour's bare ids. The
  message-log write-up called `ground` "invented twice" and the seam between the
  two halves.
- **Story Studio:** `about` carries structured parts, never a flattened string,
  and the `messageAbout` hook lets an app add its own board refs (Atlas's map
  and cards). That is what `ground` does, without the `kind:id` flattening the
  cold read showed would reopen E66.
- **Verdict: superseded** as a grammar. The insight survives as the ref
  contract. Mind-mapper keeps `ground` until it decides whether to re-base
  (Workspace Kit's open question); nothing in the port forces it.

### 9. Naming: `who`/`role`, and what `kind` means

- **Spellbook:** Scriptorium says `who`; mind-mapper says `who` on the surface
  and `role` on the wire (`src/mind-mapper/surface/types.ts:139`, `159`);
  glamour's `kind` is narration. Mind-mapper's wire `kind` carries **two axes at
  once**: `toDisplayMessage` reads it as the display style (`App.tsx:102`) and
  as the channel (`App.tsx:107`). An agent line meant as `info` can only say so
  through a field the daemon also treats as a channel, and `info` is not in
  `MESSAGE_CHANNELS`. (Read from the code; not run.)
- **Story Studio:** the protocol's header settles it for every workspace
  (`workspace/protocol.ts:7-13`): `from` names a speaker, `by` an author, `type`
  the message's display axis, and `op` the wire frame, so `type` never collides
  with the wire.
- **Verdict: superseded.** Take Story Studio's names. It also answers the
  message-log write-up's open question about moving the channel off `kind`: the
  channel gets its own field (finding 6), never `type`.

### 10. Headless context list with backend adapters

- **Spellbook's idea** (Context and Chat Kit phase 3; Cole's 2026-09-25
  constraint): a headless display model plus a per-backend adapter with optional
  capabilities, so disk, db and inline are invisible to the UI; three layers of
  state; a closed kind union with a visible unknown; `reorder`, item properties
  and inline-editable items.
- **Story Studio:** `ContextSidebar` is "props only… no WebSocket, no fetch, no
  daemon beyond the wire's shapes" (`context/ContextSidebar.tsx:1-3`). But the
  props are the file system's: `ContextEntry.root` is "an absolute directory on
  disk" (`workspace/protocol.ts:92-99`), and the sidebar takes `listDir`,
  `onReveal`, `onTrash`, `onPick`, `StructureOp` and `userHome`
  (`ContextSidebar.tsx:113-176`). Its pure helpers are path helpers
  (`context/model.ts`: `joinPath`, `tildify`, `expandTilde`). Node kinds are a
  closed union (`doc`, `image`, `bundle`, `group`, `file`), but order "carries
  no meaning" (`protocol.ts:25-26`), so StoryLoom's ordered stack does not fit.
- **Verdict: open direction.** The port gives Spellbook a very good context
  sidebar for the disk host, and Scriptorium is its real consumer. It does not
  give a backend-agnostic list. Workspace Kit's line "this feature replaces its
  phase 3" should say "for the disk host". The backend-agnostic list stays where
  it was: gated on a consumer whose context is not files (StoryLoom, or the
  world-building app), in Context and Chat Kit or a successor.

### 11. The selected and active channels

- **Spellbook's idea:** a list needs _selected_ (rides the next message) and
  _active_ (the focus), and both are board state, mirrored to the daemon.
- **Story Studio:**
  - _Active_ is `openDoc` / `openImage`, in daemon state
    (`workspace/protocol.ts:542-562`).
  - _Selected_ is the held text selection, in daemon state (`selection`, same
    type), or `pointedDocs`, which is surface-only React state
    (`shell/WorkspaceShell.tsx:723`, `useState`). The agent cannot read what is
    pointed at until the message is sent. Atlas, the main app that points,
    already keeps its card selection in the daemon per surface
    (`apps/atlas/backend/liveBoards.ts:342-355`), so for Atlas the gap is only
    the kit's chip state, not the board selection.
  - `about.entryIds` is accepted by the daemon and drawn by the chip, but
    nothing in the kit or either app produces it. A search of all of Story
    Studio finds it only in the protocol, the daemon, the chip and their tests.
- **Verdict: superseded, plus two small evolutions.**
  - Mirror the kit's `pointedDocs` to the daemon, as the selection is (Atlas's
    board selection already is; see above). Ambient vs. intent says the board is
    state the agent pulls; today this part of it cannot be pulled. Small, in
    `workspace/protocol.ts` (`PublicState`, a `point` op) and `WorkspaceShell`.
    Whether this is a gap or acceptable is for Cole; under one-state-one-meaning
    it is not a second state, only an unreadable one.
  - Decide `entryIds`: wire a "select for chat" gesture in the sidebar, or
    remove it. A wire field with no producer is a promise nothing keeps.

### 12. Drop intake and `DropZone`

- **Spellbook:** five copies, as Context and Chat Kit says. Confirmed:
  `src/imago/surface/state/fileIntake.ts`,
  `src/magpie/surface/state/fileIntake.ts`,
  `src/mind-mapper/surface/state/intake.ts`, glamour's `App.tsx` and
  Scriptorium's `ContextSidebar.tsx`.
- **Story Studio:** no shared drop component. Drops are handled inline in
  `ContextSidebar.tsx` (around lines 330-360 and 744) and in `DocumentPane`. Two
  pure pieces are worth keeping: `splitDropped` (`context/model.ts:414`), which
  routes documents, images and SVGs and names what it refused, with a test
  (`context/model.test.ts:251`); and `context/rowDrag.ts`, a typed internal drag
  format like imago's custom MIME types.
- **Verdict: open direction**, as Context and Chat Kit phase 1 already holds it.
  The port adds a sixth copy (the ported sidebar) unless the normaliser lands
  first. `splitDropped` should be its core. It can land any time after `ui` is
  ported.

### 13. Tasks and notes

- **The earlier question** (Context and Chat Kit phase 2): do Scriptorium's
  tasks and notes generalise?
- **Story Studio answers yes.** The task engine has three creators and runners
  (`workspace/tasks.ts:1-25`). Sound Stage's renders and Atlas both register
  runners (`apps/sound-stage/backend/audio/index.ts`,
  `apps/atlas/backend/server.ts`). `NotesPanel` and `TasksPanel` are kit exports
  (`chat/index.ts`). Workspace Kit already takes "tasks the human creates, and
  cancel".
- **Spellbook is ahead on notes.** E65
  (`docs/items/scriptorium/decision-log.md`, "A note shows that it is with the
  agent") is in Scriptorium only:
  - `NoteWaiting` and `notesWaiting` (`src/scriptorium/backend/protocol.ts:315`,
    `backend/waiting.ts`; 49 non-test references in `src/scriptorium`). Story
    Studio has none (`grep NoteWaiting|notesWaiting|askedIn` finds nothing).
  - The "Ask the agent" button on a note
    (`src/scriptorium/surface/components/NotesPanel.tsx:171`), which sends a
    message carrying the note's reference. Story Studio has `about.noteId` on
    the wire but no producer.
  - The guard: the daemon checks the note exists and drops a second ask while
    one is unanswered (`src/scriptorium/backend/server.ts:728-746`). Story
    Studio's `aboutFor` passes `noteId` through unchecked
    (`workspace/server.ts:2455`).
  - Workspace Kit's list of places where Spellbook is ahead (links cycle,
    `tailHandoff`'s `by: human`, the registry's warning) does not include E65,
    and neither does the port-back write-up.
- **Verdict: superseded, plus an evolution.** Take Story Studio's tasks and
  notes. Carry E65 onto them: `waiting.ts` and the `say` guard in `workspace`,
  the button and badge in `chat/NotesPanel.tsx`. Medium. Then send it back to
  Story Studio. The paradigm question about human tasks is in finding 6.

### 14. The quiet tail vs. ambient-vs-intent

- **The canon** (memory `co-presence-ambient-vs-intent`): the board is ambient
  state the agent pulls; the agent is pushed only on intent (a human commit) or
  a completed mechanical fact.
- **Story Studio:** every event type names `wake` or `quiet`
  (`workspace/events.ts:50`), the kit's table gives a reason per row (`58-104`),
  an emit can override one frame, and the daemon refuses an unknown event type
  (`workspace/server.ts:935-945`). The tests cover the human's looks being
  quiet, the save rules and re-arming (`workspace/quietTail.test.ts`). The
  `system` event's `fact` field is the canon's "fact" half.
- **Rows that do not yet match the canon.** Story Studio marks only the first
  "for a later look" (`events.ts:52-57`, the agent's own confirmations other
  than `doc.opened`) and notes the third as "not split by fact yet"; the second
  carries no mark:
  - The agent's own acts wake the agent: "the version it made wakes"
    (`quietTail.test.ts:103`). That is neither a human commit nor a fact the
    agent missed.
  - `task.progress` wakes (`events.ts:96`). Progress is ambient by the canon.
  - `system` wakes for every fact, "not split by `fact` yet"
    (`events.ts:100-102`).
- **Verdict: superseded, plus a small audit.** Take the quiet tail. Review these
  rows against the canon, and send the result back to Story Studio rather than
  diverge.

### 15. The agent's cheap map

- **Spellbook's idea** (context-primitive write-up): the agent orients from a
  cheap summary without reading the corpus.
- **Story Studio:** the `graph` verb with focus, hops, relation, kind and folder
  filters (`AgentCmd`, `workspace/protocol.ts:1769`); `DocCardSummary` with
  title, kind, status, description and link count (`protocol.ts:998-1027`);
  `profiles`; and `state` carrying only the last ten messages unless asked
  (`StateSnapshot.chatTotal`).
- **Verdict: open direction.** For a workspace it is covered by the port. As a
  requirement on the cross-project context standard it stays open, with these as
  evidence of what a cheap map looks like in practice.

### 16. Document profiles and typed relations as inputs to the standard

- **Spellbook's idea:** typed edges (`rel`), metadata, hierarchy; Operator's
  11-relation vocabulary; OKF.
- **Story Studio:**
  - Profiles: a kind per frontmatter `type`, matched nearest-first from
    `_meta/profiles/`, with fields, warnings and a `canon` flag
    (`DocumentProfile`, `workspace/protocol.ts:1380`; `workspace/profiles.ts`).
  - Relations: `?rel=` on a link, and a vocabulary file `_relations.json` with
    `label`, `means`, `symmetric`, `inverse`, nearest wins per relation
    (`workspace/relations.ts:1-40`). Usage between kinds ranks the picker's
    suggestions (`lib/relationUse.ts`), the same anti-drift idea as Operator's
    `list_relationships`.
  - OKF: Story Studio's docs (and this repo's) now cite OKF 0.2 as their
    frontmatter standard (`docs/SCHEMA.md:16`, `198` in both repos), and
    profiles key on `type`, OKF's one required field.
- **Verdict: open direction.** These port with the workspace stack (profiles are
  already a taken candidate). As inputs to the cross-project standard, they are
  the most concrete yet, and the context-primitive write-up should record them.

### 17. The paradigm and ambient-vs-intent in house style

- `grimoire/house-style.md` has no entry for the message bus, channels or
  ambient vs. intent (searched for "message bus", "ambient", "channel"; the only
  "channel" hits are the co-presence rule and surface-fit). The message-log
  write-up's finding 4 still holds.
- **Verdict: open direction, tied to 6.** Write the paradigm into house style
  when channels land on the kit, so the rule and its one implementation arrive
  together.

### 18. Imago and glamour catalog drift

- The context-primitive write-up's finding 1 (glamour's `LibraryItem`
  hand-mirrors imago's `ContextEntry` and drifted) is about two spells that are
  not on the workspace stack.
- **Verdict: open direction**, unchanged by the port.

### 19. Where the context standard lives

- The stewardship question (HiveMind with a `Standards/` genre, a primitives
  repo, or distributed) is cross-project.
- **Verdict: open direction.** Story Studio is now a third contributor beside
  StoryLoom and Operator, which strengthens the case for a home above any one
  project. It answers nothing about where.

### 20. Ideas Story Studio has that the earlier thinking lacked

All superseded in the sense of "take them as they are":

- `type: "result"` on a message, marked in the log
  (`chat/ChatMessageView.tsx:98-120`).
- `messageActions`, an app's own controls under a message
  (`chat/ChatSidebar.tsx:44`; Atlas's "Review N changes",
  `apps/atlas/surface/App.tsx:227`). This is the paradigm's "buttons are
  shortcuts" from the other side: the agent's message offers the act.
- `messageAbout`, the app's parts of `about` (`workspace/server.ts:565`), with a
  guard that an app part cannot take a kit key (`KIT_ABOUT_KEYS`, line 453).
- Reply hints on every human message, and the `messageHint` slot
  (`workspace/server.ts:438`, `2878`): the response names the next act.
- The pointed-documents chip in the composer (`chat/ChatSidebar.tsx:29`).

## Claims in the earlier documents, checked against the code

- **"No spell shows its refs as chips inside a message"** (Context and Chat Kit,
  problem statement). Not true when written. Scriptorium has drawn the selection
  under the message since 2026-09-12 (`f718b296`), glamour prints an `about:`
  line and mind-mapper a ground line. The shared-context write-up's own visual
  survey said this of imago and glamour only; the feature widened it.
- **"`messageChannel.ts`… and its `ground` handling"** (this item). `ground`
  lives in `groundRefs.ts`; `messageChannel.ts` only holds the `zone:` prefix
  constant.
- **"OKF needs verification"** (context-primitive, finding 5). Since then both
  repos' `docs/SCHEMA.md` cite OKF 0.2 and a spec URL. That makes it a cited
  standard in use by our own doc tooling. I did not fetch the spec, so whether
  it is stable and maintained is still unchecked.
- **"The agent sees nothing new"** (Workspace Kit, on the chat's refs). True of
  the information. Not true of the shape: Scriptorium's `message` event carries
  `selection`, `active`, and for a note `note`, `doc` and `hint`
  (`src/scriptorium/backend/server.ts:753-766`); Story Studio's carries `about`
  and `hint` (`workspace/server.ts:2886-2894`). The SKILL text and acc
  declarations change with it.
- **"This feature replaces its phase 3"** (Workspace Kit). Only for the disk
  host; see finding 10.
- **Held up:** `HeldSelection` ports unchanged (identical fields in both repos);
  `channelFacets` derives present-only facets; the census's five drop copies;
  the message-log write-up's `who`/`role` split in mind-mapper; the paradigm
  missing from house style.

## Recommendations for the four earlier documents

These are recommendations. Each needs Cole's ruling, and nothing has been
changed.

1. **[Context and Chat Kit](../../features/context-and-chat-kit/feature.md):
   continue, narrowed.**
   - Phase 1 stays. Rewrite its premise on top of `MessageAbout`: Scriptorium's
     adopter case becomes the ported `about`, and the contract adds the quote
     anchor to the range union (finding 2) and lifts "one kind at a time" for
     roles (finding 3). The drop intake starts from `splitDropped` (finding 12).
   - Phase 2 is superseded by the ported chat, except channels, facets, collapse
     and the chip changes, which move to Workspace Kit as evolutions (findings
     5-7).
   - Phase 3 is superseded only for the disk host. Keep the backend-agnostic
     list as a gated phase here, or move it to its own item.
   - Correct the "no spell shows its refs as chips" line.
2. **[Shared context and chat components](../shared-context-and-chat-components/write-up.md):
   close as done.** Its recommendation became Context and Chat Kit, and its open
   questions are now answered (tasks and notes generalise) or owned elsewhere
   (image sets, by phase 3; StoryLoom's model, already surveyed).
3. **[The communication log as a primitive](../message-log-primitive/write-up.md):
   close as done, folded into Workspace Kit.** The naming is settled by Story
   Studio's protocol. Its live content (channels, facets, collapse, writing the
   paradigm into house style) becomes Workspace Kit evolutions 6, 7 and 17. Its
   "extract when a third spell needs it" path is replaced by the kit itself.
4. **[Context as a first-class primitive](../context-primitive/write-up.md):
   continue, outside Workspace Kit.** It is the cross-project standard: where it
   lives, OKF, relation vocabularies, the cheap map. Add Story Studio as a
   contributor (profiles, `_relations.json`, OKF in `pdocs`) and record that the
   OKF check is half done. Whether it becomes a feature, or stays research until
   a second repo pulls on it, is Cole's call.

## Where the evolutions go in the port order

The port order is `lib`, `wire` → `theme`, `ui`, `cli` → `workspace` → `chat`,
`context` → `document` → `shell`. Proposed:

| Step in the port  | Carry with it                                                                                                                     | Why here                                                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui`              | Nothing required. The drop normaliser (12) may land after it, as Context and Chat Kit phase 1 work.                               | It needs the primitives, and it saves the ported sidebar from being a sixth copy.                                                                                                                   |
| `workspace`       | E65's daemon half (13): `notesWaiting`, the `say` note guard. Scriptorium's agent-facing `message` shape change in acc and SKILL. | It is a Spellbook-ahead merge, like the links cycle, and it is daemon code.                                                                                                                         |
| `chat`, `context` | E65's surface half (13). Store and label the app's `about` parts (5). Decide `entryIds` (11).                                     | They sit in the files being ported; doing them later means reopening them.                                                                                                                          |
| After `shell`     | Channels (6), then facets and collapse (7), then the house-style entry (17). Mirror `pointedDocs` (11). Chip actions (5).         | Preferred, not required: the composer and `askDescribe` both live in the shell. The `via` field could land at `workspace`, defaulting to the composer, with each producer stamping as it is ported. |
| After the re-base | The quiet-tail audit (14), sent back to Story Studio. The ambiguous-name refusal (4), sent back.                                  | Once Scriptorium runs on the whole stack (after `shell`, the last port step). Both are fixes to shared behaviour, better made once and upstream.                                                    |
| Later, on `about` | The ref contract (1-3), as Context and Chat Kit phase 1.                                                                          | Cole's ruling: it comes after the port, on top.                                                                                                                                                     |

One cost applies to every row: each evolution makes Spellbook's kit differ from
Story Studio's, and the feature counts on "later Story Studio fixes port nearly
as they are". Evolutions that are fixes to shared behaviour (E65, the chip's app
parts, the tail audit, the refusal) should go back to Story Studio through
`item/kit-port-back-from-spellbook`. Channels are a design choice Story Studio
made the other way on purpose (finding 6), so they may stay a Spellbook
divergence; that is worth asking its side.

## Next steps

1. Cole rules on the four documents and on the two product questions: whether a
   human task and a note should appear in the log as channels (finding 6), and
   whether pointed-at documents should be readable in `state` before a send
   (finding 11).
2. Add the evolutions to Workspace Kit's chat and context work, in the order
   above, before that cycle starts. This is the item's third box, and it is not
   done here: this investigation edited no other document.
3. Add E65 to Workspace Kit's list of places where Spellbook is ahead.
4. Correct Workspace Kit's "replaces its phase 2 … and phase 3" (it holds for
   phase 3 only on the disk host) and "the agent sees nothing new" lines.

## What I could not determine

- **Whether OKF 0.2 is stable and maintained.** Both repos cite it; I did not
  fetch the spec.
- **Whether mind-mapper's agent ever sends a `kind: "info"` line in practice.**
  The overload in finding 9 is read from the code; I did not run mind-mapper,
  and I found no SKILL text telling the agent to send one.
- **Whether Story Studio dropped E65 on purpose or forked before it.** Story
  Studio's `waiting.ts` was added on 2026-09-30, after E65 was ruled
  (2026-09-22), but its git history does not say whether the note half was left
  out deliberately. Its port-back item may know.
- **How the agent experiences the `about` shape change.** That would take a run
  of Scriptorium's acc against the ported kit, which does not exist yet.
- **Whether `pointedDocs` being surface-only has bitten anyone.** It is a gap by
  the canon's reading; I found no bug report either way.
- **Story Studio's apps beyond the producers I searched for.** I read Atlas's
  `messageAbout`, `messageActions` and runner registration, and Sound Stage's
  runners. I did not survey either app's whole chat or context use.

## Open questions

- ~~Should `via` be free text with a fallback, as mind-mapper's channel is, or a
  closed union each host extends?~~ **Answered (Cole, 2026-10-13): both, from
  one list.** The stored message carries `via: string`, and the kit never
  rejects or drops a value. The kit exports its own `as const` list of channels,
  and each host extends it with its own. That one list gives the host a union
  type for its code (autocomplete, and an exhaustive renderer), and the daemon
  checks incoming values against it, answering an unknown one with mind-mapper's
  advisory: stored as sent, here are the known channels, add it if it is real. A
  type cannot check the wire (the agent's `--via`, old logs), and a
  host-extended union in the stored shape would thread a type parameter through
  every chat component for checking only the renderer needs.
- ~~Should the composer be able to hold a selection and pointed-at documents at
  once?~~ **Answered (Cole, 2026-10-13): one subject, plus references.** Story
  Studio's rule stays for the subject: a message is about one thing (a
  selection, or the pointed-at document), so "fix this" is never ambiguous.
  `about` gains an optional `refs` list, `{ doc, path, role?, text? }[]`, for
  things the message draws on: other documents, images, imago's reference set. A
  ref is added by its own gesture (imago's ref toggle, "add as reference", a
  multi-select where the active document is the subject and the rest are refs),
  never by pointing alone. `role` is open text with a host list, as `via` is
  (imago `reference`; StoryLoom `guidance`, `adherence`), which is where finding
  3 lands. The chip shows the subject as now and the refs in a quieter row
  labelled by role. The point is that the agent already holds what Cole is
  talking about, rather than searching for a file he named in passing. An app
  that adds no refs behaves as today, so this extends the port and does not
  change it; it belongs to Workspace Kit's chat work, after the port.
- Does Story Studio want channels upstream? If yes, they port both ways and the
  divergence cost disappears.

## Sources

- Spellbook: the four documents above;
  [Workspace Kit](../../features/workspace-kit/feature.md);
  [the Scriptorium decision log, E65](../scriptorium/decision-log.md);
  `grimoire/house-style.md`; the memories `message-surface-paradigm`,
  `co-presence-ambient-vs-intent`, `shared-ui-backend-agnostic` and
  `conversation-primary-surfaces`; code under `src/scriptorium`,
  `src/mind-mapper`, `src/glamour`, `src/imago`, `src/magpie` and `src/kit`.
- Story Studio (read only, `fd06b41`): `packages/kit/src/workspace`
  (`protocol.ts`, `server.ts`, `session.ts`, `events.ts`, `tasks.ts`,
  `relations.ts`, `profiles.ts`, `selection.ts`, `waiting.ts`), `chat`,
  `context`, `document/DocumentPane.tsx`, `shell/WorkspaceShell.tsx`,
  `lib/relationUse.ts`; `apps/atlas/backend` and `apps/atlas/surface/App.tsx`;
  `apps/sound-stage/backend`; `docs/SCHEMA.md`.

---

**Related Documents:**

- [Where our messaging and context direction meets Story Studio's kit](./item.md)
- [Workspace Kit](../../features/workspace-kit/feature.md)
- [Context and Chat Kit](../../features/context-and-chat-kit/feature.md)
- [What to take back from Story Studio](../story-studio-port-back/write-up.md)
