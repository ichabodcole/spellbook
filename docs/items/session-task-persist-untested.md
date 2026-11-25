---
type: item
title: Test that removing and clearing tasks persist
description:
  Dropping removeTask's or clearFinishedTasks's persist, or persisting when
  nothing was cleared, fails no test.
status: draft
lifecycle: triage
id: 01a2122e-8a65-7382-b4fa-d6c5a745bb15
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-25 }
parent: feature/kit-split
from: items/kit-split-s4/sessions/2026-11-25-kit-split-s4.md
---

# Test that removing and clearing tasks persist

S4's review mutated each persist call in `src/kit/workspace/session/tasks.ts`
and ran 369 tests. These survived, the same before the move:

- dropping `removeTask`'s persist: a removed task comes back after `--restore`
- dropping `clearFinishedTasks`'s persist
- persisting in `clearFinishedTasks` when nothing was cleared (it should not)

Also untested at the session level: running to cancelled (reached only through
`TaskEngine.cancel`), `clearFinishedTasks()` returning 0, and `setTaskDetail` on
an unknown id.

## Definition of done

- [ ] A restore test fails when `removeTask` or `clearFinishedTasks` does not
      persist.
- [ ] A test fails when `clearFinishedTasks` persists with nothing cleared.
- [ ] Session-level tests for running to cancelled, zero cleared, and
      `setTaskDetail` on an unknown id.
- [ ] No source change beyond what a test needs.
