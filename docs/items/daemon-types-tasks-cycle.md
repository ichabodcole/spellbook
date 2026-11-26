---
type: item
title: Close the type-only loop between daemon/types.ts and server.ts
description:
  daemon/types.ts imports from tasks.ts, which imports WorkspaceContext from
  server.ts; point tasks.ts at daemon/types.ts.
status: draft
lifecycle: triage
id: 01a21599-ed7f-74fb-a363-f02164b7f205
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-25 }
parent: feature/kit-split
from: items/kit-split-d1/sessions/2026-11-25-kit-split-d1.md
---

# Close the type-only loop between daemon/types.ts and server.ts

Found reviewing D1. `daemon/types.ts:16` imports types from `../tasks`, and
`tasks.ts:29` imports `type { WorkspaceContext } from "./server"`, so
`daemon/types.ts` → `tasks.ts` → `server.ts` → `daemon/types.ts` at type level.
It erases at run time and the tier test checks direct imports only, so nothing
fails; but the tier rule says nothing in `daemon/` reaches `server.ts`.

## Definition of done

- [ ] `tasks.ts` imports `WorkspaceContext` from `./daemon/types.ts`, not
      `./server`.
- [ ] No module that `daemon/` imports, at any depth, imports `server.ts` (types
      included); checked by a script or by the tier test.
- [ ] The gate passes.

## Related Documents

- [The daemon's tier 0 parts (D1) — 2026-11-25](./kit-split-d1/sessions/2026-11-25-kit-split-d1.md)
