---
type: item
title: Test the reveal's effect order and its untested paths
description:
  The order between clearing a reveal on a document change and applying a
  pending show is untestable today, and three reveal paths have no test.
status: draft
lifecycle: triage
id: 01a2122a-739a-70c2-a183-97b87d2c543c
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-25 }
parent: feature/kit-split
from: items/kit-split-w3/sessions/2026-11-25-kit-split-w3.md
---

# Test the reveal's effect order and its untested paths

W3's review planted the effect swap that a comment in
`src/kit/shell/useReveal.ts` forbids (the pending show declared after the effect
that clears a reveal when the document changes, in `useHeldSelection.ts`): every
shell, search and link test still passed. The order is invisible today because
`revealAfter` (`src/kit/context/selection.ts`) keeps a reveal that is on screen
on `shown`, and the pending show always targets the document now shown. It
becomes load-bearing the day that branch clears more.

The same review found three reveal paths no test covers:

- `lastError` cancelling a pending show
- an image search result (`r.image`) opening the image
- a pending show cancelled when the user leaves for a third document (`since`)

## Definition of done

- [ ] Either a test that fails when the two effects swap, or a note and a test
      on `revealAfter` pinning that `shown` keeps an on-screen reveal, so the
      order's dependence is written where a change to it would be made.
- [ ] A test for each of the three paths above.
- [ ] No source change beyond what a test needs.
