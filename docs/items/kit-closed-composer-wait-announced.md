---
type: item
title: A change in a wait isn't announced while the composer is closed
description:
  With the floating composer closed, the kit page has no live region, so a wait
  turning to may be stuck is not read out to a screen reader; the shipped app
  announces it through its always-shown float.
status: draft
lifecycle: triage
id: 01a1582d-f1a0-700c-b718-059a1a707047
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-20 }
tags: [kit, accessibility]
parent: feature/workspace-kit
from: cycle/2026-10-shell
---

# A change in a wait isn't announced while the composer is closed

Found by the `kit-composer-closed-waiting-mark` verifier on 2026-10-20. The
shipped Scriptorium keeps the float on screen whenever the chat column is
collapsed, and its `WaitingBadge` is an `aria-live="polite"` region, so a wait
turning to "may be stuck" is read out. On the kit path, with the float closed,
the page has no live region at all. The rail button's name and tooltip carry the
words, so they can be found, but the change happens silently.

## Definition of done

- [ ] With the composer closed, a change in the waiting mark is announced
      politely to a screen reader, for example by a visually hidden live region
      beside the rail dot carrying its label.
- [ ] Tested, and offered on kit-parity.
