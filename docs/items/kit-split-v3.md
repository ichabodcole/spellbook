---
type: item
title: Move verbs.ts's lifecycle and tail out
description:
  Starting and stopping the daemon and the tail move to verbs/lifecycle.ts and
  verbs/tail.ts, importing nothing verbs.ts doesn't import today.
status: draft
lifecycle: backlog
id: 01a20f86-97fd-7563-9968-df77ad20baf0
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-9762-74d4-84d2-19ea1beab608]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move verbs.ts's lifecycle and tail out

This is step V3 of the kit split ([feature](../features/kit-split/feature.md)).
`verbs/lifecycle.ts` and `verbs/tail.ts`.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-other-files), and
its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] Every `*.cli.test.ts` passes.
- [ ] The start-path test passes: the new parts import only what `verbs.ts`
      imports today.
- [ ] `verbs.ts`'s override is lowered to its new count.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, whose type-check ward covers the kit).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
