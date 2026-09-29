---
type: cycle
title: Scriptorium from real use, round two
description:
  "Cole's asks from 2026-09-28 real use: tell the human when a new version
  appears, and render chat as markdown."
tags: [scriptorium, surfaces]
status: draft
lifecycle: closed
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

| #   | Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Options not taken                                                                                                                                     |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2026-09-28 | Convened after "Data you can't get back", on Cole's call: Scriptorium is what he uses most, and markdown chat will improve reading the most. The one open data-loss route (a restore dropping tasks from another bounty version) waits. A release follows this cycle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Fix the bounty edge first (needs a cross-version snapshot; not an ordinary act on one install).                                                       |
| 2   | 2026-09-28 | **Cole's UX ruling on the toast:** two separate actions, **Activate** (just activate) and **Show diff** (compare mode, active vs the new version, without activating). No combined action.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | One Activate button (his first description); Activate + Diff as one act (he ruled these are different use cases).                                     |
| 3   | 2026-09-28 | Two implementers in parallel, one per item, then a no-stake verifier in a real browser. Both touch `App.tsx`, so they are told to keep their `App.tsx` changes small and self-contained, and the lead resolves any overlap at integration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | One implementer for both (serial; the items share nothing but the file).                                                                              |
| 4   | 2026-09-28 | Toast shipped and driven in a real browser. Detection watches the version list (as E42 does), so opening, reconnecting and reloading announce nothing. The author is known (`Version.author`), so the toast says "the agent" or "you". Accepted: toasts with actions stay 15 s, and any toast pauses while the pointer or focus is on it. Only the open document gets a toast; another document's new version is announced when it is next opened, and the daemon's chat line already says it happened.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Toast other documents with open-then-act buttons (races compare's guard, which resets `against`); keep 6 s for action toasts (too short to decide).   |
| 5   | 2026-09-28 | Markdown chat shipped and viewed in a real browser in both themes. Agent **and** human messages render; stray-character prose (`snake_case`, `2 * 3`) is unchanged, and system lines stay plain. It is a second **declared** sink in `sinks.test.ts`, fed only by `renderMarkdown` (same renderer, same refusals), and not a fold into MarkdownView's sink, which carries E51/E63. Link handling was extracted to `renderedLink.ts` and shared with MarkdownView. It stays in Scriptorium, as a presentational `ChatMessageView` that can move to the kit; building it in the kit would mean moving the renderer and its sink rule. The "Agent"/"You" label moved above the body. Open: the collapsed chat's one-line preview still shows raw text; GFM footnotes would repeat ids across messages (wait for a real one). Gate 3097/0 after integration.                                                                                                                                                                                                                                                      | Fold into MarkdownView's sink (risks E51 selection); build in `src/kit` now (moves the renderer and sink rule: not cheap); render human messages raw. |
| 6   | 2026-09-28 | No-stake browser verifier (own headless Chromium, committed dist): **every claim held**. That covers Show diff from all four view modes, reconnects that were really simulated, keyboard and hover, a hostile markdown payload (`javascript:` variants, raw `<script>`/`<img onerror>`: all inert), and external/relative/refused links actually clicked. **Cole's rulings on its surprises:** (a) toasts move off the chat composer, which they covered and blocked clicks on, to the **bottom of the document pane**; (b) a version created while the browser is **disconnected** is toasted on reconnect, since it is the same silent stall he first reported. Also fixed as small: the collapsed chat preview shows plain text, not raw markdown. Filed ([scriptorium-chat-and-toast-nits](../items/scriptorium-chat-and-toast-nits.md)): a relative chat link to nowhere gives no feedback; footnote ids repeat; the agent's `version-new`+`activate` mounts the new-version toast for ~1 ms before "Now editing" replaces it. Kept, per Cole's original ask: a human-made version toasts "Made by you". | Top-right of the window, or click-through in place (Cole chose the document pane); leave the disconnect gap (Cole: fix it).                           |

## Outcome

Closed 2026-09-28. The appetite's last clause was met on 2026-09-29: Cole used
5.0.0 in a real session. The new-version toast worked (Show diff, then
Activate), a markdown test card rendered ("looks great"), and a relative chat
link opened its document.

**Shipped.**

- **New-version toast.** A version created on the open document without
  activation raises a toast saying who made it. It has two separate actions, by
  Cole's ruling: **Activate** (just that) and **Show diff** (compare active vs
  new, without activating).
  - Opening a document and reloading announce nothing.
  - A version made while the browser was disconnected is announced on reconnect
    (Cole's ruling).
  - Toasts with actions stay 15 s and pause under the pointer or focus.
  - All toasts now sit at the bottom of the document pane, off the chat composer
    (Cole's ruling).
- **Markdown chat.** Agent and human messages render through the one sanctioned
  renderer, as a second declared sink with the same refusals. Links behave as in
  documents (shared `renderedLink.ts`). A compact `.md-chat` style is used in
  both themes. The collapsed preview shows plain text.
- Built in Scriptorium as a presentational `ChatMessageView` that can move to
  the kit chat component later.

**Verified.** The implementers drove both features in a real browser, and a
no-stake verifier then broke nothing. Its checks covered:

- Show diff from every view mode;
- reconnects, simulated for real;
- keyboard and hover;
- a hostile markdown payload, which rendered inert;
- every link kind, actually clicked.

The three things it found that needed a ruling went to Cole; he ruled on two,
and both were fixed and browser-checked. Gate: 3111 pass, 0 fail.

**Learned.** The verifier's most useful finding was about layout, not logic: the
toasts covered the composer. Tests could not see that; a browser could. For
surface work, the browser verification is the check that matters.

**For the release note:** new-version toasts with Activate / Show diff, markdown
in chat, and toasts moved to the document pane. The agent no longer needs to
announce new versions in chat (scriptorium `SKILL.md`).

**Carried over:**
[scriptorium-chat-and-toast-nits](../items/scriptorium-chat-and-toast-nits.md).

## Sessions
