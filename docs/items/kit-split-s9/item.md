---
type: item
title: Move session.ts's reconcile and watcher handling out
description:
  The file-event handling moves to session/reconcile.ts, with
  whose-write-was-that behaving exactly as today on macOS and Linux.
status: stable
lifecycle: done
id: 01a20f86-9015-7264-8ac2-4ba13e886670
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-8f88-70d1-bfc9-53d9b1eb9b9f]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move session.ts's reconcile and watcher handling out

This is step S9 of the kit split
([feature](../../features/kit-split/feature.md)). `reconcile`: `onFileEvents`,
`onFileEvent`, `markMissing`, `refreshBundle`, `revert`, `forgetDoc` and their
helpers. A mistake here reverts an outside edit or announces the daemon's own;
watch events differ by platform.

Detail, risks and the lessons that apply:
[the write-up](../kit-split-oversized-modules/write-up.md#the-proposed-module-map-sessionts),
and its
[step table](../kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [x] `fileGone.test.ts`, `quietTail.test.ts`, `history.follow.server.test.ts`,
      `links.integration.test.ts` and `daemon.integration.test.ts` pass.
- [x] `session.ts`'s override is lowered to its new count.
- [x] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [x] The gate passes (`bun run gate`, whose type-check ward covers the kit).
- [x] It lands alone: no other split step runs beside it.
- [x] Linux CI is green on it before the next step starts.

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](../kit-split-oversized-modules/item.md)
