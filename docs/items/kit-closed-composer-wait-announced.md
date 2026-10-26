---
type: item
title: A change in a wait isn't announced while the composer is closed
description:
  With the floating composer closed, the kit page has no live region, so a wait
  turning to may be stuck is not read out to a screen reader; the shipped app
  announces it through its always-shown float.
status: stable
lifecycle: done
id: 01a1582d-f1a0-700c-b718-059a1a707047
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-20 }
tags: [kit, accessibility]
parent: feature/workspace-kit
from: cycle/2026-10-shell
cycle: 2026-10-cutover
---

# A change in a wait isn't announced while the composer is closed

Found by the `kit-composer-closed-waiting-mark` verifier on 2026-10-20. The
shipped Scriptorium keeps the float on screen whenever the chat column is
collapsed, and its `WaitingBadge` is an `aria-live="polite"` region, so a wait
turning to "may be stuck" is read out. On the kit path, with the float closed,
the page has no live region at all. The rail button's name and tooltip carry the
words, so they can be found, but the change happens silently.

## Definition of done

- [x] With the composer closed, a change in the waiting mark is announced
      politely to a screen reader, for example by a visually hidden live region
      beside the rail dot carrying its label.
- [x] Tested, and offered on kit-parity. _(Offered on kit-parity, message 47,
      2026-10-22.)_

## Done and verified

On `impl/kit-closed-composer-wait-announced` (from `cycle/cutover` at
`23dd202c`): commit `2cbe7810`, with the rebuilt kit surface in `dist`. Kit
work, not a port.

- **The region.** Beside the rail's waiting dot, inside the closed composer's
  `chat-float-show` wrapper, a visually hidden (`sr-only`) `aria-live="polite"`,
  `aria-atomic="true"` span (`data-slot="chat-rail-waiting-live"`) carries the
  mark's words, `composerWaiting.label`. Polite, as the float's `WaitingBadge`
  is; atomic, so "your message: …; may be stuck" is read whole, not just the
  changed tail.
- **No double announcement.** The region lives with the rail button, so it is in
  the page exactly while the float is closed (`floatOnRail`). With the float
  open it is absent and the float's badge speaks; with the column open both are
  gone and the conversation's badge speaks. The collapsed column's own badge is
  inside a `hidden`, `inert` subtree, so it is out of the accessibility tree and
  never a second voice.
- **Present while nothing waits.** The region stays, empty, while the float is
  closed and nothing waits, so the next wait (a note left with the float closed,
  say) is a change it can announce rather than a region that arrives with its
  words already in it.
- **Deliberate: closing the float does not re-announce.** The region mounts with
  the current words when the float closes. Screen readers generally do not read
  a live region's initial content, so the human, who just heard the float's
  badge, is not told the same wait again; only a later change is read.
- **The words** are the rail's own label (`waitingOnAgent`), which are the
  shipped `WaitingBadge`'s words: "working on this", "took this in, then went
  quiet ... may be stuck", "no word from the agent ... may be stuck". The kit's
  punctuation differs from the shipped app's (`;` and `...` for its em dash and
  ellipsis character), as everywhere in the kit's labels; a screen reader reads
  both the same. The rail prefixes "your message: " because, off the message,
  the words need their subject.

Tests: `shell/WorkspaceShell.railWaiting.test.tsx`, over a real daemon. With the
float closed, the region is polite, atomic and `sr-only`, and reads `working`,
then `stalled` ("may be stuck") on the same node, changed in place. It is the
only audible live region saying so. With the float open the region is absent and
only the float's badge says it; closed again, only the rail's region does. After
the answer the region stays, empty and still in the accessibility tree (not
inside a hidden, inert or `aria-hidden` subtree). Seven planted regressions each
turned a test red and were restored byte-equal: no region; the region also
present with the float open; not atomic; the region rendered only while
something waits; and, from the verifier's survivors, closed in `5913fa5f`:
`hidden` while nothing waits (M5), a `key` that remounts it on each change (M6),
and `sr-only` dropped (M7).

Checked in a real browser (Chromium via Playwright, real mouse and keys) on the
flagged Scriptorium (`SCRIPTORIUM_KIT=1`, `NODE_ENV=test`, scratch home),
reading live regions from Chrome's accessibility tree (CDP
`Accessibility.getFullAXTree`, ignored nodes excluded):

- Float closed, no agent: one region, `polite`, atomic, "your message: no agent
  is listening yet; this waits until one is".
- A `tail` started: "your message: working on this...".
- 30 s after sending: "your message: took this in, then went quiet; may be
  stuck". A MutationObserver showed the text changed in place on the same node,
  which is what a screen reader announces.
- Float opened: the rail region gone from the DOM; the only live region in the
  tree was the float's badge, "took this in, then went quiet; may be stuck".

Offering it on kit-parity is the lead's job, so that box is left open.

## Port-back notes

- **`WorkspaceShell.tsx`:** inside the rail's `chat-float-show` wrapper (the
  `relative` span added for the waiting dot), after the `aria-hidden` dot, a
  `sr-only` span with `aria-live="polite"`, `aria-atomic="true"`,
  `data-slot="chat-rail-waiting-live"`, holding `composerWaiting?.label ?? ""`.
  It depends on the waiting-dot change (`waitingOnAgent` in `shell/rail.ts`).
- **Tests:** a new case in `shell/WorkspaceShell.railWaiting.test.tsx`, and a
  check in the first case that the region stays empty after the answer. The test
  helper names live regions rather than comparing DOM elements in `toEqual`: a
  failing `toEqual` on happy-dom elements hung `bun test` here while it
  formatted the diff.
- **Story Studio's `develop` (`32eef7e1`) has the same gap**: its shell has no
  rail waiting mark and no live region by the `chat-float-show` button.
