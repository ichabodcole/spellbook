# Bounty: daemon idle-dies mid-session (reliability, priority: high)

**Added:** 2026-07-16 · **Tracks:** GitHub issue
[#64](https://github.com/ichabodcole/spellbook/issues/64) (bug, area: board,
priority: high)

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
- [ ] Close #64.

## Related

- `2026-06-15-bounty-daemon-robustness-nits.md` — the tail-retry-forever nit is
  the "fails silently" half of this bug's UX; consider fixing in the same pass.
