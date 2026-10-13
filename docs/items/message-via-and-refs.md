---
type: item
title: Message via and refs, shared with Story Studio
description:
  "One change to the kit's protocol and chat, written to port both ways: a via
  channel on every message and an optional refs list beside the one subject."
status: draft
lifecycle: triage
id: 01a136e5-9834-7106-b8d1-f3d40eb4ea4c
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, chat, story-studio]
parent: feature/workspace-kit
from: items/workspace-kit-prior-direction/write-up.md
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

- The subject is unchanged: a text selection, or the pointed-at `docs`, one kind
  at a time, as Story Studio's composer holds it today.
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
- **A ref is added only by its own gesture, never by pointing.** The workspace
  context gains `refs`, `addRef`, `removeRef` and `clearRefs`. Examples: an
  app's "add as reference", imago's reference toggle, and a multi-select where
  the active document is the subject and the rest are refs. Refs do not take
  part in "one kind at a time": changing the selection keeps them. They clear
  when the message is sent, as the subject does.
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

## Definition of done

- [x] Story Studio's agent has checked this shape against Atlas (kit-parity,
      2026-10-13; app parts stay app parts, folded in above).
- [ ] Cole has approved the shape.
- [ ] One change to the kit's `protocol.ts`, daemon and chat, with tests for:
  - `via` stored, defaulted for an old message, and carried on the tail;
  - an unknown `via` or `role` stored, with the advisory;
  - `refs` on `about` through `say`, and on the tail;
  - dedup against the subject and between refs;
  - refs surviving a selection change and clearing on send;
  - `KIT_ABOUT_KEYS` refusing an app part named `refs`;
  - the chip's second row.
- [ ] The same change lands in Story Studio's kit and in Spellbook's ported kit,
      so neither diverges.

## Related Documents

- [Where our messaging and context direction meets Story Studio's kit](./workspace-kit-prior-direction/write-up.md)
