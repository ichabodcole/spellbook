---
type: feature
title: What still needs me
description:
  "One place in the page that lists what waits on the human, and what waits on
  the agent: agent versions, notes, relinks and the message waiting, each with
  its act."
tags: [scriptorium, kit, inbox]
status: draft
lifecycle: backlog
generated: { by: claude-opus-5-5, at: 2026-11-17 }
---

# What still needs me

## Overview

One place in the page that answers "what still needs me?": the agent's versions
waiting to be taken, notes waiting on either side, a document to relink, and the
message waiting. Each row opens its thing and carries its act. It comes from
Story Studio's inbox (`2026-11-inbox-and-copies`), which Cole found useful in
real use, and was chosen in the
[Story Studio port scan](../../items/story-studio-document-ux-port/write-up.md)
on 2026-11-17.

## Problem Statement

In Scriptorium, what waits on the human is spread out: agent versions show as
toasts that go away, owed notes as a box in the Notes panel, documents waiting
as a mark on the rail. Nothing gathers them, so a session's loose ends are easy
to miss, and nothing lets the human set an agent version aside without taking or
deleting it.

## Proposed Solution

In order, one item each:

1. [Leave an agent version](../../items/kit-leave-an-agent-version.md) without
   taking it, so every waiting thing can be answered.
2. [The inbox](../../items/kit-inbox.md): a top-bar button and popover, For you
   and With the agent, one row per document's agent versions.
3. [Owed notes go to the inbox](../../items/kit-owed-notes-in-the-inbox.md), and
   the Notes panel speaks only for its own document.

## Scope

**In scope:** the inbox in the kit, opt-in per spell, with Scriptorium first;
the kinds the kit's snapshot already has (notes for you, notes owed, agent
versions, relink, the message waiting).

**Out of scope:** Story Studio's asks, replies in other chats, failed tasks
(later, if a spell's real use produces them), and its map and board rows.

## Technical Approach

Story Studio's entries are a pure function of the snapshot
(`packages/kit/src/shell/inbox.ts`), which ports almost verbatim once the kinds
are trimmed. The popover and its hook need rework into our shell. The daemon
halves land in `session.ts` and `server.ts`, so the feature follows
[the kit split](../../items/kit-split-oversized-modules.md).

---

**Related Documents:**

- [Story Studio document UX, since the last scan](../../items/story-studio-document-ux-port/write-up.md)
