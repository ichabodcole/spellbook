---
type: item
title: Take yaml off the CLI's start path
description:
  verbs.ts imports docExtensions and isDocName from lib/docFormat.ts instead of
  tree.ts, so no CLI verb loads yaml, and the start-path test locks that in.
status: draft
lifecycle: backlog
id: 01a20f86-9f7d-76f4-b901-2c5fdc2e76a6
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-8ba5-7686-8775-15ef37334619]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
---

# Take yaml off the CLI's start path

This is decision 6 of the kit split
([feature](../features/kit-split/feature.md)). `verbs.ts` gets `docExtensions`
and `isDocName` from `./tree`, which pulls in `yaml`: 72 of the CLI's 98
modules, about half its import time on every verb. Importing them from
`lib/docFormat.ts` instead is a one-line change (decision 6). Not a move, so it
stays out of V1.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-start-up-path-measured),
and its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] `verbs.ts` imports the two helpers from `lib/docFormat.ts`, not `tree.ts`.
- [ ] The start-path test asserts the CLI entry loads no `yaml`, and passes.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, with the kit typecheck from G0).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
