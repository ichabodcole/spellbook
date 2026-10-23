---
type: item
title: Frame.test's 'after a create' cell stalls in act() for seconds
description:
  "src/scriptorium/surface/Frame.test.tsx 'after a create, the list the human
  went back to stays…' times out (5 s) about one run in five: one act() after
  backToList takes 4–5 s, driven by state the file's shared daemon builds up,
  not by load."
status: draft
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

- [ ] Find what keeps `act` from settling after going back to the list, and fix
      it, in the component or in the test's shared daemon.
- [ ] The whole file passes 50 runs in a row, alone and beside a busy
      `bun test`.
