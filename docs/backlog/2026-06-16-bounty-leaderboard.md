# Bounty: a (fun, on-brand) bounty leaderboard

**Added:** 2026-06-16 **Origin:** Cole, reviewing the Kanban feature audit (#20)
via digestify. **Status:** future / fun — explicitly **not** for implementation
now.

It's a _bounty_ board — so lean into the theme: as tasks complete, track who
(which owner) claimed the "bounty," and surface a light leaderboard. When a
board is completed, someone takes home the most kudos.

The intent is **fun and on-brand, not competition** — think a list of little
"bounties earned" over the course of the work, with playful categories rather
than a single ranked score:

- fastest ticket closed
- longest-running ticket
- most tasks completed
- (others in the same spirit)

Each becomes an earned bounty/badge at session end — a fun coda to a multi-agent
build.

## Builds on

- Per-task **owner attribution** — already present (`owner`).
- Per-transition **timestamps** — see
  [task-metrics](2026-06-16-bounty-task-metrics.md) (shared substrate; the
  categories above are just queries over it).

So this is cheap _once_ the metrics substrate exists: mostly a presentation
layer over data we'd already be capturing.

## References

- `plugins/spellbook/skills/bounty/scripts/{server.ts,template.html}`
