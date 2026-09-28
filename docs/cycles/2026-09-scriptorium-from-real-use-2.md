---
type: cycle
title: Scriptorium from real use, round two
description:
  "Cole's asks from 2026-09-28 real use: tell the human when a new version
  appears, and render chat as markdown."
tags: [scriptorium, surfaces]
status: draft
lifecycle: active
started: 2026-09-28
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
- ~~Candidate:
  [item/scriptorium-chat-context-does-not-mirror-the-selection](../items/scriptorium-chat-context-does-not-mirror-the-selection.md)~~:
  already done (2026-09-22), found at convene.

Out of scope, deliberately: building the shared kit chat component
([research](../items/shared-context-and-chat-components/item.md)), unless the
convene finds it is the cheaper path to markdown rendering.

## Decision log

Decisions as they are made, with the options not taken.

| #   | Date       | Decision                                                                                                                                                                                                                                                              | Options not taken                                                                                                 |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | 2026-09-28 | Convened after "Data you can't get back", on Cole's call: Scriptorium is what he uses most, and markdown chat will improve reading the most. The one open data-loss route (a restore dropping tasks from another bounty version) waits. A release follows this cycle. | Fix the bounty edge first (needs a cross-version snapshot; not an ordinary act on one install).                   |
| 2   | 2026-09-28 | **Cole's UX ruling on the toast:** two separate actions, **Activate** (just activate) and **Show diff** (compare mode, active vs the new version, without activating). No combined action.                                                                            | One Activate button (his first description); Activate + Diff as one act (he ruled these are different use cases). |
| 3   | 2026-09-28 | Two implementers in parallel, one per item, then a no-stake verifier in a real browser. Both touch `App.tsx`, so they are told to keep their `App.tsx` changes small and self-contained, and the lead resolves any overlap at integration.                            | One implementer for both (serial; the items share nothing but the file).                                          |

## Outcome

_Written at close._

## Sessions
