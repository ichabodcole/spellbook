---
type: playbook
title: Speeding up a slow test suite
description:
  "Making a slow test gate fast without losing what it catches: measure, run the
  files in parallel and fix each parallel-only failure at its cause, remove
  waits, then cut tests that do not earn their time."
tags: [testing, performance, gate]
status: draft
generated: { by: claude-opus-5-5, at: 2026-10-24 }
---

# Speeding up a slow test suite

## Goal

The test gate runs fast enough to stay on every commit, and catches everything
it caught before. Use this when the gate has become a drag on the loop. It does
not cover choosing which tests to run per change, or CI sharding; try those only
after these steps, if the gate is still slow.

Adapted from Story Studio's `docs/playbooks/test-speed-playbook.md` (itself from
Image Farm's), read with `git -C <story-studio> show` only. The steps keep its
order, by payoff: parallelism first, then waits, then value cuts. The numbers
and hazards are this project's. Here (October 2026, item
[spellbook-parallel-tests](../items/spellbook-parallel-tests.md)) the test step
went from a 624 s serial gate (the polish cycle's last gate, 2026-10-23, build
and check included), and 130 s in a first parallel run, to about 56 s at 6,235
tests in 470 files, on a 14-core Mac.

## Steps

### Measure before changing anything

1. Time each gate step on its own (`bun run build`, `bun run check`, the tests).
   Here the tests are almost all of it.
2. Record per-file times with
   `bun test --parallel --timings=<scratch file> --update-timings`, and find the
   files that hold most of the time. The slowest file is the floor of a parallel
   run: no ordering gets the run under it. Here
   `src/bounty/backend/server.test.ts` took 128 s of a 130 s run.
3. Divide the summed per-file times by the worker count (one per core). That is
   the best a parallel run can do; once the floor is under it, splitting more
   files buys little. Here 696 s over 14 workers is about 50 s, against a 56 s
   run.
4. For a slow file, get per-test times from
   `bun test --reporter=junit --reporter-outfile=<file> <test file>` and sum
   them by describe block before choosing where to cut.

### Run in parallel

5. Split each file over the average at its describe blocks into sibling files
   (`server.test.ts`, `server.cli.test.ts`, …), and move the shared harness
   verbatim into a `fixtures/` module beside them. Keep every test body
   byte-identical and check the test and `expect()` counts match before and
   after. Put the harness under `fixtures/`, not beside the tests: the wards
   read any non-test `.ts` in `src/<spell>/backend/` as shipped code.
   - If a test reads its own source (`import.meta.path`) to police the file,
     make it read every file of the split suite and the harness, and pin that
     population in a test, or a site written in a sibling escapes it.
   - If a test reads a sibling suite's source by path, repoint it at the
     harness.
   - Keep tests that act machine-wide in one file. Grapevine's `reap` kills
     every orphan daemon it can see, so the cells that make an orphan on purpose
     stay in the same file as `reap`.
6. Run `bun run test` (`bun test --parallel --timings=test-timings.json`)
   several times before changing any test, and list every failure. Then loop it:
   20 runs, each with a fresh `HOME`, `SCRIPTORIUM_HOME` and `TMPDIR`. Before
   blaming a change for a red run, check `fseventsd`'s CPU
   (`ps -o pid,%cpu,comm -p $(pgrep -x fseventsd)`) and the load average: other
   sessions' suites load this machine. If the loop stays green, load it harder
   before concluding: run a second parallel suite beside it, or a
   `--rerun-each=50` of a watch-heavy file. Here ten plain runs were green, and
   the one parallel-only failure showed only beside a second load.
7. Fix each parallel-only failure at its cause, never by a sleep, a skip or a
   longer timeout. Prove each fix with `--rerun-each=50` on that file while the
   whole parallel suite loops beside it, and run the old version the same way to
   see it fail. Before blaming the timing, trace the value the wait depends on
   (a temporary `console.log` in the cell) and see it wrong in exactly the
   failing runs. `--rerun-each` works under the scratch-home preload
   (`src/kit/lib/scratchHome.ts` remakes its folders between reruns). The causes
   found here and in Story Studio:
   - **A read before the frame.** A test read the surface's state straight after
     `cmd` answered over HTTP, but the surface learns of the change from a
     WebSocket frame that can come later
     (`src/kit/workspace/setPromotion.server.test.ts`, 2 of 50 under load). Wait
     for the state with `waitUntil` instead of reading it.
   - **A write made before the watch is live.** A watch armed by adding a folder
     or opening a document (FSEvents on macOS) misses a write made in its first
     milliseconds, and under load that write is lost, not late. Make the write
     with `writeUntilSeen` (`src/kit/workspace/fixtures/harness.ts`), which
     repeats a harmless write until the daemon has seen it. When the act cannot
     be repeated (a delete), make each retry put the file back and do the act
     again (`removeUntilSeen` in `src/kit/workspace/fileGone.test.ts`; the
     relink cell "a link to a file is never offered a folder" in
     `relink.proposed.server.test.ts`, 1 of 100 under load, still unseen 15 s
     on), or first prove the watch live with a probe file the tree must show. A
     fixed polling loop is a deadline in disguise: it cannot save a lost event.
   - **A window or a pause sized for an idle machine.** A test that makes
     several acts one after another inside a short settle window, or counts
     frames after a fixed pause, breaks when load stretches the gaps. Give a
     cell that needs several acts inside a window a window that holds them
     (`BURST_MS` in `images.paste.test.ts`), and wait for the frames a count
     depends on (`server.test.ts`, the appState hook cell).
   - **If a failure does not reproduce** in a rerun loop under load, fix it only
     when its failing run shows the cause outright (the values it printed), say
     in the commit that it did not reproduce, and record the rest as a finding.
8. Keep file-level parallelism only: no `--concurrent`, since tests within a
   file share a daemon and a temp root. Before lowering the worker count to cut
   flakes, measure it: here `--parallel=8` took 90 s and `--parallel=10` 69 s
   against 56 s at the default 14, and 20 green runs at fewer workers did not
   outweigh that. A worker's memory grows across the files it runs (up to about
   1.7 GB); watch it with `ps` during a run.
9. Commit `test-timings.json`, refreshed with `bun run test:timings` (which
   rebuilds it from empty, so no row outlives its file). Rerun it after adding,
   splitting or much slowing a test file.

### Remove the waits

10. Make each real deadline a setting with the production value as its default;
    tests pass a short value. Keep both a lower and an upper bound in the
    assertion, so the test still proves the deadline fires.
11. Replace fixed sleeps in teardown with a condition, then soak the full suite:
    a fixed sleep can hide an ordering bug that only shows once it is gone.
12. Move debounce and type-ahead tests to fake timers. Install the fakes before
    the edit, switch back to real timers before any `waitFor`, restore them in
    `afterEach`, and never use them in a file that runs a real server on the
    same clock.

### Cut the tests that do not earn their time

13. Audit the slowest files in full and sample the rest. Sort each weak test
    into: repeats another, pins how the code is built, tests only a library, or
    cannot fail. Before cutting a repeat, break the code the twin covers and
    check the twin still fails.
14. Next candidates here, if the gate needs it:
    `src/kit/workspace/verbs.test.ts` (about 46 s, one cell about 18 s of window
    waits) and `grimoire/spell-css-scope-ward.test.ts` (about 36 s of Tailwind
    compiles).

## Verification

- [ ] The parallel test step is green 20 runs in a row locally, each run's time
      and result recorded, and once on CI, which runs the same script.
- [ ] Each split suite has the same test and `expect()` counts as the file it
      came from, and `git diff` shows no test body changed except the source
      scans retargeted at the suite.
- [ ] Every test fixed for parallel running passed `--rerun-each=50` under a
      looping parallel suite, and its old version failed under the same load (or
      the session says it did not reproduce).
- [ ] `test-timings.json` was rebuilt with `bun run test:timings` after the last
      test file was added or split.
- [ ] AGENTS.md states the test step's time and how to refresh the timings.
