---
type: cycle
title: Scriptorium from real use, round two
description:
  "Cole's asks from 2026-09-28 real use: tell the human when a new version
  appears, and render chat as markdown."
tags: [scriptorium, surfaces]
status: draft
lifecycle: planned
started: 2026-09-28
appetite:
  Stop when both ship and Cole has used them in a real session; the shared kit
  chat component is not built here unless it is the cheaper path.
after: []
generated: { by: claude-opus-5-5, at: 2026-09-28 }
---

# Scriptorium from real use, round two

## Why now

Both items come from Cole's own use of Scriptorium on 2026-09-28, which is the
signal this project waits for before building UI.

## Scope

- **[item/scriptorium-new-version-toast](../items/scriptorium-new-version-toast.md)**
  — a new version raises a toast with Activate (and perhaps Diff).
- **[item/chat-renders-markdown](../items/chat-renders-markdown.md)** — chat
  messages render as markdown through the one sanctioned renderer,
  rendered-only.
- Candidate, check at convene:
  [item/scriptorium-chat-context-does-not-mirror-the-selection](../items/scriptorium-chat-context-does-not-mirror-the-selection.md).

Out of scope, deliberately: building the shared kit chat component
([research](../items/shared-context-and-chat-components/item.md)), unless the
convene finds it is the cheaper path to markdown rendering.

## Decision log

Decisions as they are made, with the options not taken.

| #   | Date | Decision | Options not taken |
| --- | ---- | -------- | ----------------- |

## Outcome

_Written at close._

## Sessions
