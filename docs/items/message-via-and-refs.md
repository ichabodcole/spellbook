---
type: item
title: Message via and refs, shared with Story Studio
description:
  "One change to the kit's protocol and chat, written to port both ways: a via
  channel on every message and an optional refs list beside the one subject."
status: stable
lifecycle: review
id: 01a136e5-9834-7106-b8d1-f3d40eb4ea4c
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, chat, story-studio]
parent: feature/workspace-kit
from: items/workspace-kit-prior-direction/write-up.md
cycle: 2026-10-panes
---

# Message via and refs, shared with Story Studio

Cole ruled on 2026-10-13, for both kits, that every message says which gesture
it came through (`via`) and can carry references beside its one subject
(`refs`). Story Studio takes both upstream and filed `kit-message-via-refs` for
it. This item is the shared shape: one change to the kit's `protocol.ts` and
chat, with tests, written against Story Studio's kit (`packages/kit`, unchanged
since `fd06b41`) so it lands there and arrives in Spellbook with the port. The
reasoning is in the
[prior-direction write-up](./workspace-kit-prior-direction/write-up.md), under
its open questions.

## The shape

### `via`: the gesture a message came through

- `Message` gains `via?: string`. A message without it predates the field and
  reads as `"chat"`.
- Both `say` ops (`ClientOp` from the surface, `AgentCmd` from the CLI) take
  `via?: string`. The composer sends `"chat"`. An app's own button sends its own
  value (Sound Stage's pace button: `"pace"`). The CLI takes `--via`.
- The kit exports `KIT_VIA = ["chat"] as const`, and an app passes its own
  values in `WorkspaceDaemonOptions.via`. The app builds one list,
  `[...KIT_VIA, "pace"] as const`, and derives its union type from it, for its
  own code's autocomplete and exhaustive switches.
- **Stored as sent, never refused.** A value outside the list is stored, shown
  generically, and answered with an advisory: the known values, and "add it to
  the app's list if it is real". The CLI prints the advisory to stderr, and the
  `say` result carries it as `warning`.
- The agent's tail carries `via` on a human message, so the agent can tell a
  typed question from a pressed button.
- The kit's list holds only `"chat"` until Cole rules on whether a human task or
  note is a channel. That ruling adds values; it does not change the shape.

### `refs`: what a message draws on, beside its one subject

- **The subject is one item** (Cole, 2026-10-13): a text selection, else the
  active document or image, or an app part such as a selected canvas card. A
  message is never about several things at once. Today `pointedDocs` can make
  several documents the subject (`about.docs`); under this shape the active one
  is the subject and the rest become refs. `about.docs` is no longer written,
  and old messages that carry it still read as before.
- `MessageAbout` gains `refs?: MessageRef[]`, where `MessageRef` is
  `{ path: string; doc?: string; version?: number; role?: string; label?: string; text?: string }`.
  `path` is required and absolute, because it is what the agent reads. `text` is
  an optional passage.
- `role` follows `via`'s pattern: `KIT_REF_ROLES = ["reference"] as const`,
  extended by `WorkspaceDaemonOptions.refRoles` (StoryLoom: `guidance`,
  `adherence`). A missing role means `"reference"`, and an unknown one is stored
  with an advisory.
- `refs` joins `KIT_ABOUT_KEYS`, so no app's `messageAbout` part can take the
  key. The `satisfies Record<keyof MessageAbout, true>` there enforces it.
- **Refs come from two gestures.**
  - **A multi-select in the file tree** (Cole, 2026-10-13): the documents and
    images selected there, other than the subject, are the refs for the next
    message. One document can be the subject with a few documents or images
    beside it, or a canvas card the subject with tree selections beside it.
    These refs are the tree's own selection, read at send, not a copy kept
    somewhere else. A ref chip's X deselects the entry in the tree.
  - **An explicit "Add as reference"** on a document row, a file card's menu, or
    imago's reference toggle, for something that is not in the tree's selection.
    The workspace context gains `refs`, `addRef`, `removeRef` and `clearRefs`
    for these.
- Refs do not take part in "one kind at a time": changing the subject keeps
  them. Explicit refs clear when the message is sent. The tree's selection is
  the tree's, and the human clears it there; the chip's second row shows that it
  will go with the next message too.
- A ref whose `path` is the subject's own is dropped, and so is a duplicate
  `path`. Dedup is against the kit's subject only, never against an app's
  `about` part: a file card can be both pointed at and a ref, because the two
  say different things.
- **An app's own pointing stays an app part.** Atlas's canvas selection is
  `about.canvas` (`{ board, nodes }`, built in `messageAbout`), and it stays
  there. Most cards have no file, the agent's canvas verbs need card ids, and a
  selection is pointing, not a ref gesture (checked by Story Studio's agent,
  2026-10-13). Refs fit Atlas through an explicit "Add as reference" on a
  document row or a file card's menu, with `path` set to the card's file.
- **The chip** shows the subject as it does now. The refs sit in a second,
  quieter row, each labelled by its role, each with its own X.
- **Nothing reaches the agent before send.** Held refs live in the surface, like
  `pointedDocs` (Cole's ruling: context arrives with the message, not as ambient
  state).

### The agent's side

- The SKILL text says how to read `about.refs`: the subject is what the message
  is about, and the refs are what to draw on.
- Scriptorium's acc config and census learn the new `say` flag and the tail
  field. This lands on Spellbook's side with the port.

**Story Studio builds it (Cole, 2026-10-13).** Story Studio implements the
change in its kit from this spec, and Spellbook ports it with the workspace
stack. Spellbook reviews Story Studio's diff against the spec.

## Definition of done

- [x] Story Studio's agent has checked this shape against Atlas (kit-parity,
      2026-10-13; app parts stay app parts, folded in above).
- [x] Cole has approved the shape (2026-10-13, through Story Studio's agent),
      adding the tree multi-select and the one-item subject.
- [x] One change to the kit's `protocol.ts`, daemon and chat, with tests for:
  - `via` stored, defaulted for an old message, and carried on the tail;
  - an unknown `via` or `role` stored, with the advisory;
  - `refs` on `about` through `say`, and on the tail;
  - dedup against the subject and between refs;
  - a tree multi-select giving one subject and the rest as refs;
  - a ref chip's X deselecting in the tree;
  - explicit refs surviving a subject change and clearing on send;
  - `KIT_ABOUT_KEYS` refusing an app part named `refs`;
  - the chip's second row.
- [x] The same change lands in Story Studio's kit and in Spellbook's ported kit,
      so neither diverges.

**Landed in both kits (2026-10-17).** Story Studio landed it as `bbc54fd`.
Spellbook ported the workspace half in the wiki-layer cycle
(`kit-port-via-refs`). It ported the chat half (the composer's `via`, ref chips,
"N more not sent") with [kit-port-chat](kit-port-chat.md), and the tree
multi-select and "Add as reference" with
[kit-port-context](kit-port-context.md), in the panes cycle. The tests above
came across with each half (`messageViaRefs.test.ts`, the chat tests,
`ContextSidebar.refs.test.tsx` and `model.test.ts`). `entryIds` was retired in
the same cycle ([kit-chat-about-chip](kit-chat-about-chip.md)).

## Related Documents

- [Where our messaging and context direction meets Story Studio's kit](./workspace-kit-prior-direction/write-up.md)
