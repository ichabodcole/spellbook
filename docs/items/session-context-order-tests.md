---
type: item
title: Pin relink and the rescans' order, and the context's other untested paths
description:
  Every swap or drop of relink against the rescans planted at S8 passed the
  whole suite; 27 of 56 faults in the context and workspace parts went uncaught.
status: draft
lifecycle: triage
id: 01a216e7-858b-730f-ac55-d8a11e036414
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-26 }
parent: feature/kit-split
from: items/kit-split-s8/sessions/2026-11-26-kit-split-s8.md
---

# Pin relink and the rescans' order, and the context's other untested paths

S8's adversarial review planted 56 single faults in `session/context.ts`,
`session/workspace.ts` and the calls into them. The `src/kit/workspace` and
`tests/architecture` suites missed 27; none came in with S8.

**The order nothing checks.** Each of these passed the whole suite, and only a
logged call order caught them: `addContext`, `restoreContext` or `rescan`
dropping `relink`; `refilter`, `followMove`, `save` or `trashed` running
`relink` before the rescans; `followMove` or `refreshBundle` dropping the final
`relink`.

**Other misses:** `addContext`'s dedupe comparing nodes for sets; restore not
keeping the label, its lower clamp removed (a negative index splices from the
end), its workspace-overlap guard inverted; a truncation change not counted, or
`truncated` never cleared; `filteredOut`'s folder flag off by one; `refilter`
not closing an open image; `overlapSaid` never forgotten; the no-home overlap
guard dropped; `setAppHome` not resolving its path; `rescanAround` matching a
prefix without the separator; a listed bundle not refreshed; the context's
`closeImage` hook bypassing the facade's persist.

## Definition of done

- [ ] A test fails when `relink` is dropped from, or moved before the rescans
      in, each method named above.
- [ ] Each other miss above, planted alone, fails a test (or is shown
      unobservable and noted here).
- [ ] No existing test's expectations change.
- [ ] The gate passes.

## Related Documents

- [The session's tree parts (S8) — 2026-11-26](./kit-split-s8/sessions/2026-11-26-kit-split-s8.md)
