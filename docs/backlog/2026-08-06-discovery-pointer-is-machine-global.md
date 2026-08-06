# The spell discovery pointer is a machine-global singleton, and cleanup only runs on a graceful exit

**Added:** 2026-08-06

Found during `spell-hardening` sprint 01 by three seats independently. **Cole
ruled 2026-08-06: file, don't fix** — the test-side harm is already closed and
the remainder wants its own scope, not a phase bolted onto a hardening sprint.
**This file is that ruling being carried out.**

Four spells resolve a running daemon through
`join(tmpdir(), "<spell>-latest.json")` — **bounty, glamour, imago and magpie**.
That path is **not scoped by `BOUNTY_HOME`** (or any per-instance home), so
every booting daemon on the machine overwrites the same file. Cleanup exists and
is **graceful-exit-only**, so a daemon that is killed never unlinks its pointer.

**Proven causally, not inferred:** injecting daemons named
`inj-<pid>-<run>-<iter>` produced a suite failure whose **own expectation
contained the injected id**.

The magnitude a coin-flip race cannot produce: the same 1291-test suite ran
**1125s shared** and **107s private**, and the shared run's slowest test burned
**1,020s** before dying on `ConnectionRefused` to its own `/state`.

## What is already fixed, and what is not

`d650c97` closed the **test-side** channel repo-wide — the harness now mints its
own `TMPDIR` and every spawn inherits it. **That is why `G5` exists and why
every gate in that project runs under `TMPDIR=$(mktemp -d)`.**

**Shipped-source sites remain, and the count is UNVERIFIED.** Three measurements
disagree — **22 / 19 / 10** — almost certainly because of differing denominators
(glob breadth, whether `src/` counts, whether tests are excluded) rather than a
moving target. **Re-measure with the denominator stated before quoting a number
anywhere reader-facing.**

## Two things this is NOT

- **Not `#64`.** The lead proposed that fixing the pointer would close `#64` and
  therefore cost nothing. **Withdrawn** — `#64`'s idle-timeout framing is
  arithmetically impossible on its own numbers. Do not close `#64` with this.
- **Not only a test problem.** Any machine running two spell daemons at once is
  in the same position. It bit our suite hardest because our suite boots ~40
  daemons a minute.

## Acceptance Criteria

- [ ] The shipped-source site count is re-measured **with its glob and
      denominator stated**.
- [ ] Discovery is scoped per-instance, or the collision is made detectable at
      the read site (a session id in the envelope would do it — see
      `2026-08-06-bounty-session-key-hijack-and-identity.md`, same root need).
- [ ] Cleanup survives a non-graceful exit, or stale pointers are detectably
      stale rather than silently wrong.

## References

- `docs/projects/spell-hardening/sprints/01-drained-exit/plan.md` — candidate 6,
  and Phase 0e for the causal proof
- `docs/investigations/2026-08-06-artifacts-with-no-defined-death.md` §4 — the
  **same graceful-exit-only root cause** produces ~11,889 orphaned temp dirs.
  One defect, two surfaces; fixing one should fix both.
- Related: `2026-08-06-bounty-session-key-hijack-and-identity.md`
