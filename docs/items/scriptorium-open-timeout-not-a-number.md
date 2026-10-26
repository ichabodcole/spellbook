---
type: item
title: Scriptorium's open accepts a --timeout that is not a number
description:
  open --timeout abc exits 0 and starts a daemon whose idle timeout is NaN, so
  it never closes (seen with both the shipped and the kit CLI by the panes
  cycle's verifiers); refuse a non-numeric timeout with a usage error.
status: stable
lifecycle: done
id: 01a14cb0-995b-70d4-9698-bfc2b0682bd2
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-17 }
from: features/workspace-kit/sessions/2026-10-17-panes.md
cycle: 2026-10-cutover
parent: feature/workspace-kit
---

# Scriptorium's open accepts a --timeout that is not a number

Seen by the panes cycle's verifiers (2026-10-17): `open --timeout abc` exits 0
and starts a daemon. Its idle timeout parses to `NaN`, which compares false
against every threshold, so the daemon never closes on its own. Several such
daemons were left running by test probes until they were stopped by hand. The
cutover survey (2026-10-20) found `--start-timeout` has the same flaw:
`Math.max(5000, NaN)` is `NaN`. Digestify documents the same parse
(`--timeout abc` means never) as filed but not fixed.

## Definition of done

- [x] `open --timeout <not a number>` and
      `open --start-timeout <not a     number>` are refused with a `usage` error
      (exit 2) on the kit CLI, and no daemon starts. (The shipped CLI goes at
      the cutover's deletion, so it is left as it is.)
- [x] A test covers a non-numeric and an empty value for each flag.

## Done and verified

`addb72c9` and `b8b6d537` (on `impl/scriptorium-open-timeout-not-a-number`).
`open` reads both flags first, before the restore check and before any spawn,
and refuses anything that is not a number of seconds as `usage` (exit 2), with a
hint. Checked on the kit CLI (`SCRIPTORIUM_KIT=1`, scratch homes) for `abc`,
empty, `NaN`, `Infinity` and `-5` on `--timeout`, and `abc` and empty on
`--start-timeout`: each exits 2 and no daemon process exists afterwards (checked
by PID). `--timeout 0` and `--timeout 90` still open. A daemon started directly
with `--timeout abc` exits 2 too. Integration tests pin what reaches the daemon:
`--timeout 1` closes the session on its own, a 24-place count goes on as typed
(not re-printed as `1e+23`, which the daemon would refuse), and
`--start-timeout 0` keeps the 5 s floor.

Deliberate choices:

- **What reads:** a plain non-negative decimal (`0`, `90`, `0.6`). Fractions are
  allowed because the daemon has always taken fractional seconds.
- **`Infinity` is refused.** `0` already means "stands until closed", so
  `Infinity` would be a second spelling of it. The same goes for negatives,
  which `shouldIdleClose` also reads as never. Before this change `--timeout=-5`
  never reached that point anyway: the CLI handed `--timeout -5` to the daemon,
  whose parser refused it as an ambiguous option (`internal`, exit 1).
- **Empty is refused.** It used to fall back to the default (1800 s) through a
  truthiness check.
- **`--start-timeout` has a ceiling, `--timeout` doesn't.** The start wait is
  one `setTimeout`, and past 2^31 - 1 ms the runtime sets the delay to 1 ms, so
  `--start-timeout 9999999` failed at once as `internal`. Anything over
  `TIMER_MAX_S` (2147483 s) is refused as `usage`. The idle timeout is compared
  on a 250 ms sweep rather than held in one timer, so any finite count works.
- The refusal names the valid form ("such as 90 or 0.5"), because `.5` and `5.`
  are refused.
- The `open` row's `describe` text is unchanged, so the CLI golden doesn't move.

Same class, not touched: the daemon's `--port` is read with `Number()` too. The
CLI never passes it, so it is reachable only by a direct daemon start.

## Port-back notes

- **New export `readSeconds(token)` in `wire/housekeeping.ts`**: pure, returns
  `{ok, seconds}` or `{ok: false, message}`. Accepts `^\d+(\.\d+)?$` and
  requires the result to be finite. Also new: `TIMER_MAX_S`, the longest single
  `setTimeout` delay in whole seconds.
- **`workspace/verbs.ts`:** new exported `flagSeconds(value, flag, hint, max?)`;
  `--start-timeout` passes `TIMER_MAX_S` as `max`. `cmdOpen` reads `--timeout`
  and `--start-timeout` through it at the top, and passes the trimmed token to
  the daemon. `--start-timeout` keeps its 5 s floor; fractions now count instead
  of being truncated by `parseInt`.
- **`workspace/server.ts` `runWorkspaceDaemon`:** reads `--timeout` through
  `readSeconds` and returns 2 with a stderr line before `build`.
- **Story Studio has the same parse** (read-only check at `32eef7e1`):
  `packages/kit/src/workspace/verbs.ts:625` passes `--timeout` through
  unchecked, `:649-650` is the same `Math.max(5000, parseInt(...))`, and
  `server.ts:5793` is `typeof flags.timeout === "string" ? Number(...)`. There,
  an empty `--timeout=` reads as `0`, so it stands until closed.
