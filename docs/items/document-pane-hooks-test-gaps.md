---
type: item
title: Test DocumentPane's moved hooks where nothing does
description:
  No test passes a callback editor ref, ticks useNow, or resizes the pane after
  mount.
status: draft
lifecycle: triage
id: 01a216bc-d87c-715c-a7b2-3adbe75c2150
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-25 }
parent: feature/kit-split
from: items/kit-split-p1/sessions/2026-11-25-kit-split-p1.md
---

# Test DocumentPane's moved hooks where nothing does

Found reviewing P1. The moved hooks are covered for the common path (the first
width measurement, focus forwarding with an object ref, the status strip's
counts), not for:

- a **callback** `editor` ref (`typeof editor === "function"` in
  `useFocusMode.ts`);
- `useNow`'s 30-second tick and the "Updated" relative time it drives (no
  DocumentPane test uses fake timers);
- the `ResizeObserver` path that updates `usePaneWidth` after mount;
- `useDebouncedStats`' debounce itself.

## Definition of done

- [ ] A test covers each path above.
- [ ] No existing test's expectations change.
- [ ] The gate passes.

## Related Documents

- [DocumentPane's small hooks (P1) — 2026-11-25](./kit-split-p1/sessions/2026-11-25-kit-split-p1.md)
