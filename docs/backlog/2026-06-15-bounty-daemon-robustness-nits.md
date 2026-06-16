# Bounty: daemon / cli robustness nits

**Added:** 2026-06-15

Small, non-blocking robustness improvements to the bounty daemon + cli, surfaced
during the house-pattern migration's diff and finalize reviews. None bite in
practice today; bundled here so a single cleanup pass can knock them out.

## Acceptance Criteria

- [ ] **`prevBlocked` stale entry (R1).** On task removal, `prevBlocked` keeps
      the deleted id. Harmless (reconcile only walks `state.tasks`), but a
      recycled id could suppress its first `unblocked`. Fix:
      `prevBlocked.delete(id)` in the remove paths (agent + WS).
- [ ] **non-numeric `?since=` replays all (R2).** `parseInt("abc")` → `NaN`, and
      `id > NaN` is always false → a corrupt cursor replays everything. Fix:
      clamp `NaN` → `-1` (the intended "no cursor" behavior) or `400` on a
      non-numeric cursor.
- [ ] **`events[]` is unbounded (#3).** The event log grows for the session's
      lifetime; each tail reconnect replays `O(n)`. Fix: cap to the last N
      (drop-oldest, keep the monotonic `id` so `--since` still resolves; replay
      from the cap if a reconnect's cursor predates it).
- [ ] **`tail` retries forever on abnormal daemon death (#4).** Normal teardown
      emits `closed` (tail exits 0); a SIGKILLed daemon leaves no `closed` and
      the session file vanishes → tail loops "no session yet" until the Monitor
      times out. Fix: give up (non-zero exit) when the session file
      existed-then-vanished mid-tail.

## References

- `plugins/spellbook/skills/bounty/scripts/{server.ts,cli.ts}`
- Origin: `docs/projects/_archive/bounty-agent-usable/backlog.md` (R1, R2, #3,
  #4)
