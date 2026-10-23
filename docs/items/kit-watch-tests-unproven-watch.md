---
type: item
title: Kit watch tests lean on a file watch they never proved live
description:
  The fileGone probe that says the watch is live was answered by the listing
  scan, so a delete made 30 ms later could fall before the FSEvents watch was
  live and go unreported; the cycle and develop gap was noise.
status: draft
lifecycle: triage
id: 01a16aa1-d5e1-707b-a92f-2e11f7e4aff9
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-23 }
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-polish
---

# Kit watch tests lean on a file watch they never proved live

The polish cycle's gate failed `src/kit/workspace/fileGone.test.ts` ("a deleted
parent folder…") and two `DocumentPane.test.tsx` change-on-disk tests, which
then passed on reruns. A first loop suggested the cycle had made them flakier
than `develop` (9 of 20 against 3 of 20).

**It had not.** Run interleaved (cycle, develop, cycle, …) on 2026-10-23,
`fileGone.test.ts` alone failed 11 of 30 times on `cycle/polish` (a0739a55) and
9 of 30 on `develop` (5ef5361a); the folder test, 10 and 8. No commit was
bisected, because there was no gap to bisect. The first loop ran the cycle first
and `develop` second, on a machine whose load changed between them.

## The cause

`addLive` in `fileGone.test.ts` sent `context.add` and then wrote
`watch-live.md` until the tree showed it, to prove the watch was live. But the
first write landed before the daemon had read `context.add`, so the listing's
own scan showed the file. The probe passed without the watch having reported
anything. A trace of the daemon's watch callbacks showed this in 61 of 62
probes: "live" came 13 ms after the watch was armed, with no watch event. The
folder test then deleted `set/part` once, about 30 ms after arming. When
FSEvents had not yet started delivering for the new watch, that delete was never
reported, and the test waited for an `original.missing` that never came. Even
with a 20 s budget the base still failed this way, because the event was lost,
not late.

Three other tests write once straight after a watch is armed, with no proof: the
backlinks integration test (`kit-backlinks-test-watch-race`) and DocumentPane's
two change-on-disk tests. Same cause.

**What made it common on this machine:** `fseventsd` was pinned at about 104 %
CPU the whole afternoon, from other sessions' parallel test suites and dev
servers. Once the probe was fixed, a new watch took 0.1 to 3.3 s to report its
first write (traced, 40 probes), against 13 ms when the probe passed through the
scan.

**Users are not affected.** The window is from arming a watch (adding a folder
or opening a file) until FSEvents starts delivering for it: milliseconds, or a
few seconds on a saturated machine. A folder deleted in that window would leave
its document not marked missing until a later event there. A person can't
realistically delete something within a second of adding it. The daemon's
missing-folder detection (`originalsUnder`, the 400 ms recheck) worked every
time its event arrived.

## The fix (tests only)

On `impl/watch-test-regression`:

- `8b4f2433`: `addLive` waits for the listing, then probes, and throws if a
  probe is written before the listing. The backlinks test and DocumentPane's two
  tests now write until the daemon has seen the write (`writeUntilSeen`).
- `a5e51669`: fileGone's six daemon tests get `WATCH_BUDGET_MS` (20 s). This
  commit fixes no race; it only gives time. Once the watch is proved live,
  proving it takes up to 3.3 s on a saturated `fseventsd`, and that ran past
  bun's 5 s default mid-test. It is a separate commit so it can be weighed, or
  dropped, on its own.
- `1d56cd6e`: Close's put-back and the conflict's other text are written until
  seen, as the deletes beside them already were. A single write was late or lost
  in 2 of 27 runs.

## Loops (2026-10-23, base a0739a55, interleaved with the fix)

| `fileGone.test.ts`                          | base                          | fix                                                                 |
| ------------------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `8b4f2433` only, alone                      | 21/40                         | 16/40, mostly 5 s test timeouts while proving the watch             |
| `8b4f2433` only, alone, `--timeout 20000`   | 1/10 (the folder delete lost) | 0/10                                                                |
| `8b4f2433` + `a5e51669`, alone              | 15/28                         | 2/28 (both "timed out waiting for back")                            |
| all three, alone                            | 18/40                         | 1/40 (a process stall: "the docs listed" got no state frame in 5 s) |
| all three, beside a busy `bun test src/kit` | 20/40                         | 0/40                                                                |

`DocumentPane.test.tsx`, alone, `8b4f2433`: the base failed its watch tests in 3
of 40 runs; the fix failed none. Both sides failed other, load-bound cells
(editor-text timeouts) in 1 to 3 runs. Beside a busy suite, only 5 runs each
were made before the loops were stopped: the base failed 1 and the fix 2, all in
load-bound cells.

`8b4f2433` + `1d56cd6e` without `a5e51669` was not measured. On the cause-only
row, its failures were bun's 5 s per-test timeout firing while `addLive` was
still proving the watch, which `1d56cd6e` does not change. On a machine whose
`fseventsd` is not saturated (proof in about 100 ms), 5 s is enough.

## Still open

- Other kit watch tests keep bun's 5 s default and wait on FSEvents more than
  once. `links.integration.test.ts`, "a listed document's \_meta/profiles…",
  failed in 2 of 11 base runs, though it already writes until seen. On a machine
  with `fseventsd` saturated, any of them can run out of time without having a
  race.
- Whether a saturated `fseventsd` can drop an event for a watch that is already
  live (FSEvents coalescing into "must scan subdirs") wasn't settled. The
  put-back failures could have been lost events or just late ones. If they can
  be dropped, a long-running daemon on a very busy machine could miss an outside
  change until the next event in that folder.

## Definition of done

- [x] The cycle/develop gap measured fairly: not real.
- [x] The cause confirmed by a trace, and fixed in the tests.
- [x] The probe's guard goes red when the listing wait is removed (6 of 6 daemon
      tests), and the file was restored byte-equal.
- [ ] Cole rules on keeping `a5e51669` (the watch budget).

## Related Documents

- [Polish before the release](../cycles/2026-10-polish.md)
- [The backlinks test's watch race](kit-backlinks-test-watch-race.md)
