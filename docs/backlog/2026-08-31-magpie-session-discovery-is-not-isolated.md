# magpie's session discovery is a global temp file, and MAGPIE_HOME does not isolate it

**Found:** 2026-08-31, while running magpie's daemon for a visual check during
spell-kit Sprint 03 Phase 4b.

## What happens

`src/magpie/backend/cli.ts:166` resolves the session file to
`join(tmpdir(), "magpie-latest.json")` — a single global path, shared by every
magpie process on the machine.

`MAGPIE_HOME` (`cli.ts:504`) isolates **snapshots** and gives the impression the
spell is isolatable. It is not: the session-discovery file ignores it.

## Why it matters

**Running the magpie daemon breaks the test suite for everyone afterward, on the
same machine, until someone deletes a file in `$TMPDIR`.**

Measured: `bun test` went from 1528 pass / 0 fail to 1531 pass / **1 fail**
after a daemon was started in a scratch directory. The failing case is
`src/magpie/backend/cli.test.ts` → _"failure contract: no session to act on"_,
which runs `extract --pad 4` and requires exit **5** (`not_found`); it got exit
**1**, because the CLI found the leftover `magpie-latest.json` and proceeded.

The failure is **invisible in its own message** — it looks like a broken
exit-code contract, not like ambient state. An agent that finds it will debug
the CLI's error handling. Two separate agents on this session read it as
pre-existing.

## Why the isolation is worth having

The test asserts a **negative** — that no session exists. A negative assertion
resting on shared mutable global state can be flipped by anything on the box,
including a previous test run, and it fails **open**: the state is inherited,
not created, so nothing in the suite's own setup can be blamed or bisected to.

## Candidate fixes

- honour `MAGPIE_HOME` in the session path, the way snapshots already do; or
- have the test set `MAGPIE_HOME`/`TMPDIR` to a per-run directory; or
- namespace the discovery file per working directory rather than per machine.

The first is the smallest and makes the env var mean what it appears to mean.

## Related

- `docs/backlog/` sibling items on daemon robustness
- The visual check that surfaced it is recorded in spell-kit Sprint 03 Phase 4b
