---
type: item
title: A note's replies from another chat vanish until that chat opens
description:
  The Notes panel builds a note's replies from the chat on screen, so a reply
  posted in another chat is missing under its note; Story Studio fixed it with a
  reply index across chats (f557c49b).
status: draft
lifecycle: triage
id: 01a1eabe-f5ad-71ae-9f0f-d41813f8cfd1
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, notes, chat]
parent: feature/workspace-kit-follow-ups
---

# A note's replies from another chat vanish until that chat opens

Reported by Story Studio on `kit-parity` (message 62, point 1). A note-reply is
a chat message. The Notes panel builds a note's replies from the chat on screen,
so a reply posted in another chat vanishes from under its note until that chat
is opened. Not reproduced here yet.

Our counterpart: `repliesByNote` in `src/kit/chat/NotesPanel.tsx`, which
`WorkspaceShell.tsx` feeds from `state.chat` (`noteReplies`).

**Story Studio's fix** (`f557c49b`, `packages/kit/src/chat/NotesPanel.tsx`): a
reply index across chats, `noteReplies()`, which the panel reads whichever chat
is open. In the same change, the waiting mark clears only on an agent message
about that note (`about.noteId`); a plain `say` clears none. That is our
[note-reply-clears-every-waiting-note](note-reply-clears-every-waiting-note.md),
in the same code, so port the two together.

## Definition of done

- [ ] A reply posted in one chat shows under its note while another chat is
      open. Tested with two chats.
- [ ] Ported with, or after, note-reply-clears-every-waiting-note.
- [ ] Posted on `kit-parity`.
