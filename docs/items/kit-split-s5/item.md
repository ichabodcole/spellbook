---
type: item
title: "Move session.ts's read side out: links, profiles, relations, search"
description:
  The read side of the session, about 2,500 lines, moves to
  session/readIndex.ts, linkResolve.ts, profiles.ts, relations.ts, linkCheck.ts,
  linkReports.ts and search.ts.
status: stable
lifecycle: done
id: 01a20f86-8ddd-7780-8233-0ec66f9dbc98
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-8d4d-71ee-826d-c0c379a47214]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move session.ts's read side out: links, profiles, relations, search

This is step S5 of the kit split
([feature](../../features/kit-split/feature.md)). The read side: `readIndex`,
`linkResolve`, `profiles`, `relations`, `linkCheck`, `linkReports` and `search`.
The biggest dent in `session.ts`.

Detail, risks and the lessons that apply:
[the write-up](../kit-split-oversized-modules/write-up.md#the-proposed-module-map-sessionts),
and its
[step table](../kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [x] Every `links.*`, `*.cost.test.ts`, `profiles.*`, `relations.*`,
      `references.test.ts`, `search.*` and `headings.server.test.ts` passes.
- [x] The blind tests (`profiles.cost`, `profiles.session`, `relations.cost`,
      `relations.session`) are repointed from the session to the parts that now
      hold `profileReader` and `relationsReader`, and their counters are shown
      still to move.
- [x] The `.cost` tests pass when run on their own.
- [x] `session.ts`'s override is lowered to its new count.
- [x] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [x] The gate passes (`bun run gate`, whose type-check ward covers the kit).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](../kit-split-oversized-modules/item.md)
