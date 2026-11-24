---
type: item
title: An inbox for what still needs the human
description:
  A top-bar button and popover in the kit, opt-in per spell, listing what waits
  on the human and on the agent, each row opening its thing with its acts;
  Scriptorium first.
status: stable
lifecycle: backlog
id: 01a1eb00-509f-7179-a982-87bd52c9499a
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-17 }
parent: feature/scriptorium-inbox
from: 01a1eabb-ee28-7737-826d-38ba3dd5b5bf
blocked_by:
  [01a20f86-9926-72ec-8e93-934381ff98cf, 01a1eb00-5014-7393-9326-850d71951419]
---

# An inbox for what still needs the human

From the Story Studio port scan (2026-11-17). Cole reports Story Studio's inbox
helped in real use: one place that answers "what still needs me?". Scriptorium
has nothing like it. Waiting notes show in the Notes panel's notes-elsewhere box
(`src/kit/chat/NotesPanel.tsx`) and the rail's waiting mark
(`src/kit/shell/rail.ts`); agent versions show only as toasts
(`src/kit/chat/NewVersionToasts.tsx`).

Story Studio's version is in its kit:

- `98e34890`: the entries, derived from the snapshot by a pure function
  (`packages/kit/src/shell/inbox.ts`, 489 lines);
- `3539a3e1`: the top-bar button and its popover (`shell/InboxPopover.tsx`,
  `shell/useInbox.ts`, `TopBar.tsx`), with a slot for an app's own rows;
- `523e4834`: one row per document's agent versions ("v5 from the agent, and 2
  earlier"); taking v5 settles v2 to v4 (`isOpenProposal`,
  `lastTakenAgentVersion`). This rule went through two wrong versions in their
  review, so port the final one rather than working it out again.

The button counts what waits. Its popover has two groups, **For you** and **With
the agent**. Each row opens its thing (Back returns) and carries that thing's
acts.

**In the kit, opt-in per spell, Scriptorium first.** Every kind kept comes from
the kit's own snapshot. Keep: notes for you, notes owed, agent versions, relink,
and the message waiting. Drop Story Studio's asks, replies in other chats, and
its map and board rows. `inbox.ts` ports almost verbatim once the kinds are
trimmed; the hook and popover need rework, because ours has no split `TopBar`
(our top bar is inline in `WorkspaceShell.tsx`).

Blocked by [kit-leave-an-agent-version](kit-leave-an-agent-version.md) and by
[kit-split-oversized-modules](kit-split-oversized-modules/item.md).

## Definition of done

- [ ] A top-bar button counts what waits on the human. Its popover lists For you
      and With the agent, with the five kinds above and no others.
- [ ] Each row opens its document or note, and Back returns. Each row carries
      its acts: activate, show diff and leave for versions; open for notes;
      relink; open chat.
- [ ] A document's agent versions are one row, and activating the newest settles
      the earlier ones, with a test of Story Studio's final rule.
- [ ] A spell turns the inbox on in its frame; Scriptorium does, and a spell
      that doesn't shows no button.
- [ ] Offered on kit-parity.

## Related Documents

- [Which of Story Studio's new document UX should Scriptorium take?](./story-studio-document-ux-port/item.md)
