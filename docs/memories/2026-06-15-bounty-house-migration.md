# Bounty — migrated to the house daemon + cli.ts pattern (#6–#10)

**Date:** 2026-06-15

Migrated Bounty (the board spell, formerly Tuskboard) off the old file-pump
substrate onto the house agent-interface pattern: a persistent Bun daemon
(`server.ts`) + thin `cli.ts` over `POST /cmd` / `GET /state` / `GET /events`
SSE, plus snapshot+restore (#6), `--stdin` quoting (#7), state read-back (#8),
ownership + scoped tails + cooperative claim (#9), and task dependencies with a
cycle guard + `unblocked` event (#10). Surface ported vanilla→Alpine-over-CDN
(no build, CDN+SRI); submit/cancel collapsed to a single "Close board" dismiss
(the board is a conjuration). Built phase-by-phase with contract-first
checkpoints against a reviewer agent; validated by `bun test` (71 pass), a live
multi-agent acceptance test, a fresh cold-agent dogfood (which drove the scoped
`state --mine` + computed `liveBlockers` readback-parity fixes), and a
finalize-branch dual review. The retired file-pump path (`bg.ts`,
`watch-events.sh`) is gone; `join.ts` untouched. Follow-up: the wordmark.webp
still reads "Tuskboard" → spellbook#11 (deferred, non-blocking).

**Key files:**
`plugins/spellbook/skills/bounty/scripts/{server.ts,cli.ts,template.html,server.test.ts}`,
`plugins/spellbook/skills/bounty/SKILL.md`

**Docs:** `docs/projects/bounty-agent-usable/` (proposal, plan, test-plan,
backlog, sessions/2026-06-15-house-migration-build-finalize.md)
