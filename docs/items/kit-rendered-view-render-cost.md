---
type: item
title: The rendered view re-renders a large document in seconds
description:
  One render of a 5k-line document with many links takes about 5 s in the kit's
  rendered view (and the shipped app's), so a second tab or split view falls
  behind on every typing pause.
status: stable
lifecycle: triage
id: 01a15711-af4d-71ff-bed6-e04e39add9e0
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [kit, document, performance]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-shell
---

# The rendered view re-renders a large document in seconds

Measured by the `kit-second-tab-misses-edits` verifiers on 2026-10-19, in
Chrome, on a 5,000-line document with about 3,500 links (`mid.md`):

| Measure                          | Shipped app | Kit       |
| -------------------------------- | ----------- | --------- |
| One full render                  | 5.4–6.2 s   | 3.7–5.8 s |
| One keystroke in split view      | 4.8–5.2 s   | 4.6–4.9 s |
| Same, 5k lines, no links: render | 0.84 s      | 0.77 s    |

A CPU profile puts most of it in micromark's `resolveAllText`, re-run over the
whole document on every change. The kit is as fast as the shipped app or faster,
so this is not a regression. The second-tab item coalesces redraws so a tab no
longer piles them up, but each one still costs the full render.

## Definition of done

- [ ] A render after a small edit costs time in proportion to the edit, not the
      document, for example by re-parsing only the changed blocks.
- [ ] On the `mid.md` case, a second tab in rendered view shows a keystroke
      within about 1 s of typing stopping.
- [ ] Offered on kit-parity.
