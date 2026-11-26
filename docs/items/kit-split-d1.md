---
type: item
title: "Move server.ts's module-level code out: types, rules, landings"
description:
  The daemon's types, rules and landing helpers move to daemon/types.ts,
  rules.ts and landings.ts, and server.ts re-exports them.
status: stable
lifecycle: active
id: 01a20f86-91ca-7673-92c9-1c4284d2c0f6
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-8ba5-7686-8775-15ef37334619]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move server.ts's module-level code out: types, rules, landings

This is step D1 of the kit split ([feature](../features/kit-split/feature.md)).
`daemon/types.ts`, `daemon/rules.ts` and `daemon/landings.ts`; `server.ts`
re-exports every name. Can run beside the session steps (lane B).

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-proposed-module-map-serverts),
and its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] It typechecks, and every test that imports a constant
      (`IMAGE_ARRIVAL_SETTLE_MS`, `rebaseLines`, `isDotPath`, …) passes
      unchanged.
- [ ] `server.ts`'s override is lowered to its new count.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, whose type-check ward covers the kit).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
