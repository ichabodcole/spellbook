---
type: item
title: Run the test suite in parallel, as Story Studio does
description:
  bun test runs Spellbook's 462 files one after another (about 10–14 min quiet,
  21 min loaded); Story Studio's bun test --parallel with a timings file took
  its gate from about 180 s to 22 s after fixing the watch tests that flaked in
  parallel. Follow its playbook here.
status: stable
lifecycle: ready
id: 01a16c35-50b1-717e-a321-c3a963386a97
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-23 }
from: cycle/2026-10-polish
priority: high
cycle: 2026-10-release-6
---

# Run the test suite in parallel, as Story Studio does

`bun run gate` is `bun run build && bun run check && bun test`. The test step is
nearly all of it: 6,237 tests in 462 files, run one file after another
(`bunfig.toml` sets only the preloads). A full run took about 10–14 minutes on a
quiet machine during the polish cycle (2026-10-23), and 21 minutes while other
sessions' suites were loading `fseventsd`. Many files start a real kit daemon,
connect over a WebSocket and render the page in happy-dom, and they wait on real
file-watch events, so the CPU is mostly idle while the suite waits.

Cole moved Story Studio to parallel tests (Story Studio `f3c663b7`, 2026-10-09):
`bun test --parallel --timings=tests/timings.json --timeout 10000 …`, with a
checked-in timings file refreshed by `test:timings`. Its gate went from about
180 s to about 22 s, green 20 runs in a row. Every test that failed only in
parallel had one cause: a fresh macOS file watch misses a write made in its
first moments, and under load the write is lost, not late. The polish cycle hit
the same cause here (`kit-watch-tests-unproven-watch`). Story Studio's playbook,
`docs/playbooks/test-speed-playbook.md` (adapted from Image Farm's), records the
steps in payoff order: measure, run in parallel and fix each parallel-only
failure at its cause, remove waits, then cut tests that don't earn their time.
Read it with `git -C <story-studio> show` only, since Story Studio is read-only
from here.

Known hazards here: the open watch-test items
(`kit-links-check-watch-cells-timeout`,
`scriptorium-suggestmeta-test-context-wait`), the dist-check trap (never build
under `NODE_ENV=test`), and the wards, which scan the whole tree.

## Definition of done

- [x] Per-file timings measured, and the slowest files (the floor of a parallel
      run) split where that helps.
- [ ] `bun test --parallel` with a checked-in timings file in the gate, and
      every test that failed only in parallel fixed at its cause (no longer
      sleeps, no skips), each proven with `--rerun-each=50` beside a looping
      suite.
- [x] The gate passes 20 runs in a row, and its time is recorded before and
      after.
- [x] The repo's own test-speed playbook, adapted from Story Studio's, with this
      project's numbers.

## Done and verified

On `impl/spellbook-parallel-tests` (2026-10-24, Bun 1.4.0, 14-core Mac):

- `7e89dbbd` splits the two files that floored a parallel run: bounty's
  `server.test.ts` (128 s alone) into `server.test.ts` plus five
  `server.*.test.ts` siblings, and grapevine's `cli.test.ts` (62 s) into four,
  each harness moved verbatim into `fixtures/`. Test and `expect()` counts match
  (318 + 1 new, 152). The bounty P0e source scans now read every file of the
  split suite, with a population pin.
- `2412760d` puts `bun run test`
  (`bun test --parallel --timings=test-timings.json`) in the gate, and so in CI,
  with `test:timings` to rebuild the checked-in timings file from empty.
- `4c31ddec`, `8e2cd6a6` and `fb2bc83b` fix the failures the soaks found (see
  below), and make `--rerun-each` work under the scratch-home preload.
- The test step went from about 624 s serially and 130 s in a first parallel
  run, to 55 to 56 s (66 runs measured; up to 66 s when other suites loaded the
  machine). The gate's build and check add about 10 s.

Failures found in parallel, and what happened to each:

| Test                                                             | Rate seen                        | Cause                                                                                        | Status                                                                                                               |
| ---------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| setPromotion "the new folder is watched"                         | 2 / 50 under load                | read the surface's state before its frame (trace: id undefined in both)                      | fixed; 0 / 150 under load                                                                                            |
| relink.proposed "a link to a file is never offered a folder"     | 1 / 100 under load               | delete made inside the watch's arm window: lost, not late (trace: 15 s on)                   | fixed; 0 / 200 under load                                                                                            |
| server.test "an app that has an appState hook … once a frame"    | 1 in a soak; 0 / 300 reruns      | a frame still in flight after a fixed 300 ms (7 calls, 6 frames)                             | fixed from the failing run's values; not reproduced                                                                  |
| images.paste "once per burst"                                    | 1 in a soak; 0 / 100 reruns      | three serial uploads outgrew the 60 ms window (fact named only a.png)                        | fixed from the failing run's values; not reproduced                                                                  |
| editRelay "each frame carries the newest edit …"                 | 2 in 20 soak runs; 0 / 600 alone | a 5 s test timeout; in 30 instrumented full runs no kit wait passed 1.5 s and none failed    | twoOnSolo now waits for each surface's own open frame (same shape as setPromotion); cause of the timeout unconfirmed |
| profiles.integration "a profile file changed on disk pushes …"   | 1 in 20 soak runs                | a 5 s test timeout; did not recur in 30 instrumented runs                                    | open, unconfirmed; candidate: a profile write moments after `context.add` armed the watch                            |
| diskGuard "hard links: the session writer never writes into one" | 1 in 20 soak runs; 0 / 300       | `onDisk` resolved the twin with realpath, which on macOS can answer a hard link's other name | fixed in the kit (`onDisk`: a file is its folder's realpath and its own name), pinned by a case-insensitivity cell   |

`kit-links-check-watch-cells-timeout` and
`scriptorium-suggestmeta-test-context-wait` did not fail in any parallel run
(about 100 full runs), nor in 50 reruns each beside a looping suite.

Round 2 (2026-10-24): after the kit's `onDisk` fix and the editRelay wait, a
fresh soak ran **20 of 20 green** (`r2soak`, 55 to 56 s a run, load average 10
to 16, `fseventsd` 0 to 35% from other sessions). The full gate passed once
unpiped after it.

Worker count, measured with 10 full runs each: `--parallel=8` took 89 to 90 s,
`--parallel=10` 68 to 69 s, both 20 of 20 green; the default 14 takes 55 to 56
s, with about 6 failures in the 80 soak runs before round 2's fixes and none in
the 20 after. Workers grow during a run (RSS sampled every 5 s: the largest
reached 1.5 to 1.7 GB, others stay near 50 MB), which fits the
worker-accumulation idea, but 20 green runs at fewer workers against a 1-in-13
rate is not evidence enough to give up 13 to 35 s a run. The default stays.

## Port-back notes

- `src/kit/lib/scratchHome.ts`: under `bun test --rerun-each` the preload's
  afterAll fires after every rerun, so the folders are made again after each
  removal (the flag is read from `ps`, as Bun keeps it out of `process.argv`). A
  normal run is unchanged. Story Studio's preload, if it removes its folder the
  same way, has the same break.
- `src/kit/workspace/noHome.ts` (`onDisk`): a plain file (not a folder, not a
  link) is resolved as its folder's place on disk joined with the name written,
  at the top and for a file met on the walk; folders and links resolve as
  before. A hard link has no one real path, and macOS's realpath can answer
  either name. `notInSession`, `inOwnPlaces`, `holdsOwnPlaces` and `notASet`
  read through it. One visible difference on a case-insensitive disk: a file
  named in another case keeps the case written. Pinned in `diskGuard.test.ts`.
- `src/kit/workspace/setPromotion.server.test.ts`, `editRelay.server.test.ts`,
  `relink.proposed.server.test.ts`, `server.test.ts` (appState hook cell) and
  `images.paste.test.ts`: test-only fixes, generic, each with its reason in a
  comment.
