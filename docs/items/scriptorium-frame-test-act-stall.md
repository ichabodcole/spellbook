---
type: item
title: Frame.test's 'after a create' cell stalls in act() for seconds
description:
  "src/scriptorium/surface/Frame.test.tsx 'after a create, the list the human
  went back to stays…' times out (5 s) about one run in five: one act() after
  backToList takes 4–5 s, driven by state the file's shared daemon builds up,
  not by load."
status: stable
lifecycle: ready
id: 01a166f9-5e4f-7550-b298-8900ed914b7b
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [scriptorium, tests]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-polish
cycle: 2026-10-polish
---

# Frame.test's 'after a create' cell stalls in act() for seconds

It failed the full gate in several branches during the polish cycle
(2026-10-23), and passed alone each time. The ward batch's verifier measured it:

- **How often:** alone, it failed 2 times in 10; beside a busy `bun test`, 1
  in 3.
- **When it fails:** one `settle()` (React `act`) takes about 4–5 s, either the
  one wrapping `client.send({op:"say"})` right after `backToList()`, or the one
  after the snapshot wait. No `waitFor` timed out.
- **Normal timing:** the test takes 60–260 ms.
- **What drives it:** it never failed in 12 runs of only its own describe, and
  failed 4 times in 14 runs of the whole file. So it depends on state the file's
  shared daemon builds up, more than on machine load.

Raising the timeout would hide it.

## Definition of done

- [x] Find what keeps `act` from settling after going back to the list, and fix
      it, in the component or in the test's shared daemon.
- [x] The whole file passes 50 runs in a row, alone and beside a busy
      `bun test`.

## Done and verified

**Cause.** The test's `watched()` wrapper, not the component. It handed the
frame fresh `send`, `request` and `importImage` functions on every render, which
breaks `useDaemon`'s promise that "its functions stay the same". The shell runs
`open` for a made document in an effect keyed on `[done, send]`, so with a new
`send` it re-ran on every snapshot. The daemon answers every `open` with a
snapshot (`state` and `version.text`, though nothing changed), so page and
daemon volleyed every 2–4 ms until unmount: 2,000–4,800 `open`s per run in the
logs, starting in every run, passing ones included. React's async `act` keeps
looping while its queue refills. It returned only when a round trip happened to
leave the queue empty between turns, and otherwise ran until the 5 s timeout
unmounted the page. The event loop never stalled (no gap over 200 ms), so it
wasn't machine load. Production mounts `<Frame daemon={useDaemon()} />`, whose
`send` and `done` are stable, so a user never saw this. The same volley also
explains the "with a selection…" cell's 20 s timeout, which its comment had put
down to load.

**Fix** (042d598d, in `Frame.test.tsx` only). `watched()` makes each stand-in
once per underlying function (a `WeakMap`), so it keeps `useDaemon`'s stable
identity. The "after a create" cell now asserts that the made document is opened
exactly once. The "with a selection" cell's 20 s timeout and its comment are
gone; it runs in about 0.23 s. The whole file dropped from about 23 s to about 3
s.

**Verified.** The same loop (the whole file, each run on fresh scratch homes),
before → after:

- alone: 46/50 → 50/50;
- beside a busy `bun test src/kit`: 37/50 → 50/50.

Before the fix, the failures were in the "after a create" cell (3 alone, 10
busy) and the "with a selection" cell (2, 6). Mutation check: making `once`
build a fresh stand-in on every call turns the new assertion red (7 and 10 extra
`open`s in two runs); restored byte-equal (shasum).

Out of scope, same hazard: `WorkspaceShell.refs.test.tsx` (always) and
`Frame.document.test.tsx` (when a cell passes `watch`) also give the shell a
fresh `send` on every render. Neither was loop-tested in this item.
