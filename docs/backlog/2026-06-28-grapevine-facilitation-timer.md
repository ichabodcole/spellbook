# Grapevine: timed announcements / facilitation timer

**Added:** 2026-06-28 **Origin:** extracted from the grapevine-backlog living
doc (now archived); V1.7 design conversation. **Scope:** proposal-sized — the
durability/recovery open questions warrant a project folder when promoted, not a
one-shot backlog task.

A timer primitive that fires a deferred `announce`-style message after a delay —
for facilitating timed activities ("five-minute brainstorm — pencils down at the
buzzer"), session bumpers, pomodoro-style coordination.

**Sketch:**

- `cli.ts timer set <delay> <text> [--channels a,b] [--from <alias>]` (e.g.
  `timer set 5m "pencils down"`). A timer is conceptually a deferred `announce`
  — same `kind:"announcement"` payload, scheduled fire time. Shares infra with
  `announce` (the design symmetry that makes the pair satisfying).
- `timer list` (pending timers + eta + payload), `timer cancel <id>`.

**Open questions (why it's proposal-sized):**

- **Durability across daemon restart** — timers need persistence
  (`~/.grapevine/timers.jsonl`); restart loads and resumes.
- **Fire-on-recovery semantics** — if a timer should have fired while the daemon
  was down: fire immediately with a "(delayed by Nm)" tag, skip, or warn?
- **Scheduling primitive** — `setTimeout` for short delays; hour+ delays want a
  periodic-check loop.
- **Cancellation by alias?** — probably anyone (grapevine is symmetric /
  unauthenticated).

Part of a possible "facilitation primitives" family (timer, agenda steps,
rounds, voting) that could form a coherent release if several converge.

## References

- `plugins/spellbook/skills/grapevine/scripts/{cli.ts,daemon.ts}` — reuse
  `announce` fan-out + `kind:"announcement"`.
