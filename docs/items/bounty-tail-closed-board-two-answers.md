---
type: item
title: A closed bounty board answers `tail` differently by how it is named
description:
  tail --session <id> on a closed board stops with tail.closed at exit 0; tail
  --session-key <k> for the same board exits 5 not_found after the grace.
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: ready
id: 01a0e1dc-1f1a-752c-8893-0a4dbe674ffc
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-27 }
parent: feature/spell-hardening
cycle: 2026-09-one-act-one-answer
---

# A closed bounty board answers `tail` differently by how it is named

Found by the sprint 06 no-stake verifier (2026-09-27, on `5554e12b`); not a
break of any sprint 06 claim, filed rather than chased.

```
$ bounty tail --session k-v1-…     # board opened, then closed
{"type":"tail.closed",…}   exit 0, 0.24 s
$ bounty tail --session-key V1      # same board
… not_found, exit 5, ~8 s; hint: "existed here and has closed; bring it back: open --session-key V1"
```

Both hints are correct, and #98's fix only promised the snapshot check for
`--session`. But a supervisor sees two outcomes for one board. Decide whether a
key whose derived id has a close snapshot should stop as `tail.closed` too.

## Fixed (2026-09-28)

Decided by the cycle's Decision log, row 3: a key whose board has a close
snapshot stops as `tail.closed`, exit 0, the same as `--session`.

Re-measured red first. On one closed keyed board, `tail --session <id>` printed
`tail.closed` and exited 0 in 0.02 s. `tail --session-key V1` retried for about
7.8 s and then exited 5 `not_found`.

What changed: in `cmdTail`'s `onUnresolved`, a named target that existed here
now stops. "Existed here" means the tail reached it once, or its snapshot is on
disk. This applies however the target was named. Before, the snapshot case
reached only `--session`, through the re-arm rule. So `--session-key` now stops
at once as `tail.closed`, and it does not wait out `NAMED_TARGET_GRACE_MS`. Its
come-back is `open --session-key <key> --no-open`.

Some behaviour is unchanged:

- A key with no board and no snapshot still retries and exits 5 `not_found`
  after the grace.
- A key from `$BOUNTY_SESSION_KEY` is not a named target, so an anthill seat's
  first arm (B1) still waits for its board.

The `not_found` hint lost its "existed here and has closed" branch, because a
target with a snapshot can no longer reach that path.

One consequence: a supervisor that starts `tail --session-key K` before it
re-opens K's closed board now gets `tail.closed` at once. Before, the tail could
catch the board if it came up within the grace. The come-back it prints is the
re-open.

Pinned by `tail-handoff.integration.test.ts` › "a --session-key whose board has
closed stops tail.closed at once, like --session". The no-snapshot path stays
pinned by "#98: a --session-key that never resolves exits not_found after the
grace, naming what it looked for".

Removing that branch made the keyed hint false in one case. A key whose board
was opened and closed here, and whose snapshot was then deleted, reaches the
`not_found` path, and its hint said "no board was opened under this key from
this directory". The hint now says only what the CLI knows: no board is running
under this key and none left a close snapshot. It still names
`open --session-key <key> --no-open`. Pinned by "a --session-key whose closed
board lost its snapshot: the not_found hint claims only what is known".
