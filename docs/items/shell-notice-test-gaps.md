---
type: item
title: Test the daemon notices the shell tests don't reach
description:
  "Four behaviours in useDaemonNotices have no shell-level test: a refusal
  cancelling a pending reveal, focus on a moved row, the done-driven open, and
  Escape with defaultPrevented."
status: draft
lifecycle: triage
id: 01a2146d-5480-70ba-8654-52743f878286
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-25 }
parent: feature/kit-split
from: items/kit-split-w4/sessions/2026-11-25-kit-split-w4.md
---

# Test the daemon notices the shell tests don't reach

W4's review found four behaviours in `src/kit/shell/useDaemonNotices.ts` that no
`WorkspaceShell*.test.tsx` reaches. They moved verbatim, so the split didn't
break them, but nothing would notice if a later change did.

## Definition of done

- [ ] A test shows a refusal cancels a pending search-result reveal
      (`setPendingShow(null)`).
- [ ] A test shows a `moved` result puts focus on the moved row.
- [ ] A test shows the `done`-driven open sends `{ op: "open" }` for a created
      document and a `bundle.create`, and that `stay: "rename"` suppresses it.
- [ ] A test shows Escape with `defaultPrevented` leaves the link refusal in
      place.

## Related Documents

- [WorkspaceShell's daemon notices (W4) — 2026-11-25](./kit-split-w4/sessions/2026-11-25-kit-split-w4.md)
