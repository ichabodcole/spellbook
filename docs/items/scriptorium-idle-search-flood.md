---
type: item
title: The shipped surface floods search requests while idle
description:
  An idle tab of the shipped Scriptorium surface sends about 850 search ops a
  second and gets as many results back, with or without a document open; the kit
  surface sends none.
status: draft
lifecycle: triage
id: 01a156a8-ccda-726a-822f-c5fd9bc0f945
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [scriptorium]
parent: feature/workspace-kit
from: cycle/2026-10-shell
---

# The shipped surface floods search requests while idle

Found by the `kit-second-tab-misses-edits` verifier on 2026-10-19. In headless
Chromium at 1400×900, one idle tab of the shipped Scriptorium surface sent about
850 `search` ops a second, and got as many `search.results` frames back: 2,520
to 2,893 in 3 s, with or without a document open. The kit surface sent none. The
shipped bundle (`dist/index-w940m06p.js`) is the same on `cycle/shell`'s base,
so this predates the shell cycle.

The cutover deletes the shipped surface, which would end it. Until then it costs
CPU on both sides of every open shipped session, and it is worth knowing whether
a real (headed) browser does it too.

## Definition of done

- [ ] Reproduced, or not, in a headed browser on a scratch home, and the cause
      named.
- [ ] Fixed in the shipped surface, or closed at the cutover with the reason, as
      Cole rules.
