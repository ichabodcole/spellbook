---
type: item
title: A repeated refusal shows nothing while the context column is collapsed
description:
  With the context column collapsed and the app owning refusals, an identical
  refusal repeated after its toast expired shows nothing, because the daemon
  client keeps a refusal as its text alone.
status: stable
lifecycle: ready
id: 01a15842-5868-758e-8f18-f8f05d1ca130
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-20 }
tags: [kit]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-shell
cycle: 2026-10-polish
---

# A repeated refusal shows nothing while the context column is collapsed

Found by the `kit-shell-sidebar-slots` work (2026-10-20). The shell toasts an
owned refusal while the context column is collapsed, but `daemonClient` keeps a
refusal as its text (`lastError`), so an identical repeat after the toast
expires changes no state and shows nothing. The notice still holds it, so
reopening the column shows it.

## Definition of done

- [x] Each refusal carries a sequence or request id the shell can see, and a
      repeat while collapsed toasts again.
- [ ] Tested, and offered on kit-parity. _(Tested; the kit-parity offer is the
      lead's, with the port-back notes below.)_

## Done and verified

`bc8ddd31` (on `impl/kit-shell-robustness`). The daemon client's view gains
`lastErrorSeq`: one more for every refusal it sets (a daemon `error` that
answers no request, a refused link, or a send after the end), unchanged by
`clearError`. The shell answers each refusal once, by that number, so a refusal
repeated word for word is toasted again, and a re-render with the same refusal
is not.

Tested: the count in `daemonClient.test.ts`, and the repeat toasted again with
the column collapsed in `WorkspaceShell.slots.test.tsx`. In a real browser
(Scriptorium on a scratch home, context collapsed), clicking a chat link to a
file outside the context twice, the second time after the first toast expired on
its own, showed nothing before the fix and a second toast after it.

## Port-back notes

- `context/daemonClient.ts`: `DaemonView.lastErrorSeq: number` (0 at start), set
  by one helper (`refuse`) wherever `lastError` was set.
- `shell/WorkspaceShell.tsx`: the refusal effect keys on `lastErrorSeq` as well
  as the words (a `biome-ignore` names why the dependency is there). A first
  version also kept the last number answered (`shownSeq`) and skipped a re-run
  for it; nothing needed it (the effect's other dependencies are stable, and the
  shell clears what it does not own), so it was removed in review.
- A send after the end goes through `refuse` too, so every act after the end is
  a refusal of its own (`daemonClient.test.ts` holds it).
