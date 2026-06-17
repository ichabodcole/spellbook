# Bounty: per-task timing / cycle-time metrics

**Added:** 2026-06-16 **Origin:** Cole, reviewing the Kanban feature audit (#20)
via digestify.

Capture **when a task enters and leaves each column** so we can answer, at the
end of a session: how long did this take? How long did it sit in Doing? How long
in Review? Useful background meta for planning future work — explicitly **not**
a constant-notification feature; a quiet end-of-session rollup, surfaced on
demand.

## What to capture

- A per-transition timestamp on every status change (To do → Doing → Review →
  Done, including bounces). Today the event log carries a monotonic `id` cursor
  but **no wall-clock timestamp** on task transitions, and `Task` has no
  `created`/`updated` stamps — so this is net-new.
- Derived per task: time-in-column (Doing, Review), total cycle time
  (first-Doing → Done), and bounce count.
- A board-level rollup verb (e.g. `metrics` / `stats`) the agent reads at
  session end — not pushed.

## Shared substrate (important)

Per-transition timestamps are the **common foundation** for three things:

- **heartbeat** (#29, on the board) — needs "how long has this been in Doing?"
- **card-aging cue** (greenlit Keep) — the visual half of the same signal.
- **this metrics idea** + the [leaderboard](2026-06-16-bounty-leaderboard.md)
  future idea.

So whoever builds `heartbeat` should stamp **all** transitions generally (not
just Doing-entry), and the rest reuse it. Sequence the substrate once.

## References

- `plugins/spellbook/skills/bounty/scripts/server.ts` — `applyTaskUpdate` /
  `applyTaskMove`, `emitEvent`; `Task` shape.
