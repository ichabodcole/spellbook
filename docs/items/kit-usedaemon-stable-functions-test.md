---
type: item
title: "Kit: a test that useDaemon's functions stay the same across snapshots"
description:
  useDaemon promises send, request and importImage keep their identity, and the
  shell's effects depend on it; nothing in the kit tests it, so a regression
  only shows as a Scriptorium test's open/state volley.
status: draft
lifecycle: triage
id: 01a1681a-6652-7029-a5ec-f1a5f47845f5
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-23 }
parent: feature/workspace-kit-follow-ups
from: items/scriptorium-frame-test-act-stall.md
---

# Kit: a test that useDaemon's functions stay the same across snapshots

`useDaemon` (`src/kit/context/useDaemon.ts`) promises that the client's `send`,
`request` and `importImage` keep their identity from one snapshot to the next.
The shell depends on it: the effect that opens a newly made document is keyed on
`[done, send]` (`src/kit/shell/WorkspaceShell.tsx`), and compare mode resends
`diff` whenever `send` changes (`src/kit/document/DocumentPane.tsx`). A new
`send` per snapshot makes the page and the daemon volley `open` and `state`
until unmount.

Nothing in the kit guards the promise. The polish cycle's verifier planted
`send: (op) => send(op)` in `daemonClient.ts`'s `build()`, and all 616 tests in
`src/kit/context` and `src/kit/shell` still passed. Only Scriptorium's
`Frame.test.tsx` went red, through its "opened exactly once" assertion. Story
Studio has the same client, so a kit test protects both.

Two kit-side test files, `WorkspaceShell.refs.test.tsx` and
`Frame.document.test.tsx`, still give the shell a fresh `send` per render. They
don't volley today because none of their cells makes a document or enters
compare mode. They do if one ever does.

## Definition of done

- [ ] A kit test shows that `send`, `request` and `importImage` are the same
      functions across several snapshots and a reconnect, and the planted
      `build()` regression turns it red.
- [ ] `WorkspaceShell.refs.test.tsx` and `Frame.document.test.tsx` give the
      shell stable functions, as `Frame.test.tsx` now does.
