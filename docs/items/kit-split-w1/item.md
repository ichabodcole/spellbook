---
type: item
title: Move WorkspaceShell's top bar, status bar and chat column into components
description:
  TopBar.tsx, StatusBar.tsx and ChatColumn.tsx come out of WorkspaceShell's JSX,
  rendering exactly as today.
status: stable
lifecycle: done
id: 01a20f86-9926-72ec-8e93-934381ff98cf
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-8ba5-7686-8775-15ef37334619]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move WorkspaceShell's top bar, status bar and chat column into components

This is step W1 of the kit split
([feature](../../features/kit-split/feature.md)). `TopBar.tsx`, `StatusBar.tsx`
and `ChatColumn.tsx`, out of the 594 lines of JSX. First in lane B: the UX ports
wait on the shell.

Detail, risks and the lessons that apply:
[the write-up](../kit-split-oversized-modules/write-up.md#the-other-files), and
its [step table](../kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [x] The 17 `WorkspaceShell*.test.tsx` pass.
- [x] Each hook is called where its section sat, so effect order is unchanged.
- [x] `WorkspaceShell.tsx`'s override is lowered to its new count.
- [x] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [x] The gate passes (`bun run gate`, whose type-check ward covers the kit).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](../kit-split-oversized-modules/item.md)
