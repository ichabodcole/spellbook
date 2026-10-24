---
type: item
title: Run the test suite in parallel, as Story Studio does
description:
  bun test runs Spellbook's 462 files one after another (about 10–14 min quiet,
  21 min loaded); Story Studio's bun test --parallel with a timings file took
  its gate from about 180 s to 22 s after fixing the watch tests that flaked in
  parallel. Follow its playbook here.
status: draft
lifecycle: triage
id: 01a16c35-50b1-717e-a321-c3a963386a97
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-23 }
from: cycle/2026-10-polish
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

- [ ] Per-file timings measured, and the slowest files (the floor of a parallel
      run) split where that helps.
- [ ] `bun test --parallel` with a checked-in timings file in the gate, and
      every test that failed only in parallel fixed at its cause (no longer
      sleeps, no skips), each proven with `--rerun-each=50` beside a looping
      suite.
- [ ] The gate passes 20 runs in a row, and its time is recorded before and
      after.
- [ ] The repo's own test-speed playbook, adapted from Story Studio's, with this
      project's numbers.
