---
type: item
title: Move verbs.ts's argument parsing out
description:
  The CLI's argument parsing moves to verbs/parse.ts, importing nothing verbs.ts
  doesn't import today.
status: stable
lifecycle: done
id: 01a20f86-96d1-7069-96b6-7360b05f9f0d
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-8ba5-7686-8775-15ef37334619]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move verbs.ts's argument parsing out

This is step V1 of the kit split
([feature](../../features/kit-split/feature.md)). `verbs/parse.ts` (our lines
88–420).

Detail, risks and the lessons that apply:
[the write-up](../kit-split-oversized-modules/write-up.md#the-other-files), and
its [step table](../kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [x] Every `*.cli.test.ts` passes.
- [x] The start-path test passes: the new parts import only what `verbs.ts`
      imports today.
- [x] `verbs.ts`'s override is lowered to its new count.
- [x] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [x] The gate passes (`bun run gate`, whose type-check ward covers the kit).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](../kit-split-oversized-modules/item.md)
