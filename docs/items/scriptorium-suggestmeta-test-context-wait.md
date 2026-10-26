---
type: item
title:
  Frame.suggestMeta's 'Add a block' cell times out waiting for the document in
  the context
description:
  "src/scriptorium/surface/Frame.suggestMeta.test.tsx 'Add a block (E35) >
  rendered: the same, with no editor mounted' times out in openFile ('timed out
  waiting for the document in the context', ~2 s) on a busy machine: develop 5
  of 12, cycle/polish 3 of 12, interleaved (2026-10-23)."
status: stable
lifecycle: dropped
id: 01a16b64-a4fc-7280-ba2c-e3db0ff0cfcb
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-23 }
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-polish
priority: high
cycle: 2026-10-release-6
---

# Frame.suggestMeta's 'Add a block' cell times out waiting for the document in the context

During the polish cycle's last gate (2026-10-23), with `fseventsd` near 90% CPU
from other sessions' suites, this file failed alone in two reruns in a row. Run
interleaved, 12 times on each tree, it failed 5 times on `develop` and 3 times
on `cycle/polish`, so the cycle didn't cause it. Almost every failure is in "Add
a block (E35): offered, put in the buffer, written by Save > rendered: the same,
with no editor mounted", at `openFile` (around line 117): "timed out waiting for
the document in the context", after about 2 s. One develop run also failed the
"two tabs" cells.

It is probably the same family as `kit-watch-tests-unproven-watch`: a wait on
something the daemon learns from a file watch or a scan, with a short budget, on
a saturated machine. Unconfirmed.

## Definition of done

- [ ] Find what `openFile` is waiting on, and why it misses on a busy machine,
      from a trace.
- [ ] Fix the cause in the test (or the code, if a user could see it), with a
      budget only where the wait is the OS's own.
- [ ] The whole file passes 50 runs in a row, alone and beside a busy
      `bun test src/kit`.

Dropped by Cole, 2026-10-25: no longer reproduces. It never failed in about 100
full parallel runs and 50 reruns of the file beside a looping suite during
[spellbook-parallel-tests](spellbook-parallel-tests.md).
