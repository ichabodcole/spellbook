---
type: item
title:
  "Move session.ts's tier 0 out: errors, names, paths, facts, types, manifest"
description:
  The module-level code of session.ts moves to session/errors.ts, names.ts,
  paths.ts, facts.ts, types.ts and manifest.ts, and session.ts re-exports every
  name it exports today.
status: draft
lifecycle: backlog
id: 01a20f86-8c31-70b9-bba9-cacf4bcd0674
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-8ba5-7686-8775-15ef37334619]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
---

# Move session.ts's tier 0 out: errors, names, paths, facts, types, manifest

This is step S2 of the kit split ([feature](../features/kit-split/feature.md)).
Tier 0, the pure module-level code (about 950 lines), into
`src/kit/workspace/session/`: `errors`, `names`, `paths`, `facts`, `types` and
our own `manifest`. `session.ts` re-exports every name.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-proposed-module-map-sessionts),
and its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] `session.test.ts`, `manifest.test.ts` and `manifestMigrate.test.ts` pass,
      and `index.ts`'s exports typecheck.
- [ ] `instanceof SessionError` still works: there is one class.
- [ ] No part imports back from `session.ts` (no cycle); the tier test's table
      lists the new parts.
- [ ] `session.ts`'s override is lowered to its new count.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, with the kit typecheck from G0).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
