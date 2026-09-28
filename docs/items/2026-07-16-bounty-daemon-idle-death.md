---
type: item
title: "Bounty: daemon idle-dies mid-session (reliability, priority: high)"
status: stable
description:
  Implement graceful daemon termination after idle timeout to prevent resource
  leaks
lifecycle: done
id: 019f6d0b-7fd1-77bd-b59f-b6cf434b71a8
kind: task
generated: { by: unknown, at: 2026-07-16 }
---

# Bounty: daemon idle-dies mid-session (reliability, priority: high)

The board daemon **dies during active sessions** — 4 times in one dream-flute
anthill session, **even with a host keep-alive tail running** — forcing teams to
abandon the board and fall back to grapevine + git as the durable record.
Anthill has already softened its finalize ritual to treat the board as
best-effort _because of this bug_; that's a downstream accommodation, not a fix.
This is the highest-value bounty fix on the books: every anthill session leans
on the board, and an unreliable board silently erodes the whole board-as-state
pattern.

## Root-cause investigation first (don't guess-fix)

The failure survived a keep-alive tail, so the obvious "idle timeout" theory is
incomplete. Enumerate before cutting:

- [ ] Reproduce with logging: what does the daemon's last output say when it
      dies? (Add a death-reason line / crash log if none exists.)
- [ ] Rule in/out: Bun `serve` idle behavior, the daemon's own idle-exit logic,
      SSE connection-drop cascades, macOS App Nap / system sleep of the spawned
      process, and OOM/uncaught-exception silent exits.
- [ ] Check whether the 4x deaths correlate with machine sleep or long gaps
      between events (dream-flute session timeline may still exist in
      `~/.grapevine/archive/`).

## Acceptance Criteria

- [ ] A board daemon survives a full working session (hours, incl. idle gaps)
      under a live tail.
- [ ] If the daemon dies anyway, it fails **loudly and recoverably**: tails exit
      with a clear "board is down — restart with
      `cli.ts open --restore     <id>`" message instead of hanging or looping
      (relates to `tail` retry nit R#4 in
      `2026-06-15-bounty-daemon-robustness-nits.md`).
- [ ] Death reason is logged to a discoverable place (the session file or a
      daemon log).
- [x] Close #64. (2026-09-28, on anthill's 2026-08-09 measurement.)

## Related

- `2026-06-15-bounty-daemon-robustness-nits.md` — the tail-retry-forever nit is
  the "fails silently" half of this bug's UX; consider fixing in the same pass.
- `2026-08-05-bounty-snapshot-clobber-data-loss.md` (#73, #74) — **this bug is
  the trigger for that one.** The daemon dies here; the recovery attempt
  (respawn-empty + `close`) then destroys the snapshot. Two halves of daemon
  lifecycle robustness that want one pass — though each is independently worth
  fixing, since an unguarded clobbering `close` is a footgun even on a daemon
  that never dies.

## Closed on evidence (2026-09-28)

`#64` was closed on anthill's 2026-08-09 measurement on the issue. On v2.1.0 an
idle board with a tail attached outlived its 7200 s idle timeout (8112 s and
counting), and the untailed control died at 7200 s. The fix was `idleTimeout`
raised above the SSE keepalive (`82dc3632`) and signal-death teardown
(`2cc513d4`), both in v2.1.0. A dead board is now loud (`tail.lost`, and `#98`'s
`not_found` in v4.0.0). The unchecked boxes above were not needed: the
measurement settled it without the logging reproduction. This is n=1; reopen if
a tailed board dies on ≥2.1.0.
