# bounty: skip the doing-column heartbeat for blocked cards

**Added:** 2026-06-22

The `doing`-column heartbeat ("overdue" poke) fires on cards that are correctly
in `doing` but **legitimately waiting** on a peer, so it reads as "stuck?" when
nothing is wrong (GitHub issue **#40**, filed by the dream-flute multi-agent
team). Design gut-checked with the team's lead (maestro) on the
`bounty-heartbeat-design` grapevine channel.

## The fix (approved scope: "blocked-skip only")

A `doing` card that is **blocked** (has at least one unresolved blocker) is
excluded from both the heartbeat poke and the surface's "stale" card-aging cue.

- **Blocked predicate** (reuses existing state): a task is blocked when
  `(task.blockedBy ?? [])` contains the id of any task whose `status !== "done"`
  — the same `blocked`/`liveBlockers` derivation the board already sends to the
  client. A missing or done blocker is not "live" → does not block.
- **`server.ts`** — add a small pure `isBlocked(task, tasks)` helper; consult it
  in `computeDuePokes` (`continue`, no poke) and `cardOverdue` (return `null`,
  no stale cue). `cardOverdue`'s signature gains the task list (blocked-ness
  needs sibling statuses).
- **`template.html` Alpine mirror** — the hand-copied `cardOverdue` gets the
  same skip. The surface already receives each card's derived `blocked` flag, so
  the mirror is a one-line `if (card.blocked) return null`. Keep this in
  lockstep with the server helper (no test guards that drift — see `grimoire`
  surface-mirror discipline).
- **`SKILL.md` workflow nudge** (the load-bearing addition): blocked-skip only
  bites if waits are actually modeled as block edges. maestro confirmed the
  team's real lockstep waits were **informal** (never `bounty block`), so add:
  _"model a lockstep/serialize wait as `block <id> --on <peer>` and the
  heartbeat goes quiet; size long-by-nature cards (e.g. browser verify) with
  `--size L` / `--expect <min>`."_ Without this nudge, a naive blocked-skip
  passes its unit tests but does nothing in a real session.

## Deliberately out of scope

- **Exponential poke backoff** (period → 2× → 4×) — parked as a documented
  fallback; revisit **only** if long-verify nags recur even when the card is
  correctly sized. maestro called it YAGNI-until-proven (their long-verify nag
  was under-sizing, fixable with `--size L`/`--expect`, not a tooling gap).
- A new `blocked-on-peer` status distinct from `doing` — rejected; reuse the
  `blockedBy` edge, don't split the state machine / add a column.

## Acceptance Criteria

- [ ] A blocked `doing` card that is overdue produces **no** heartbeat poke.
- [ ] The same blocked card produces **no** surface "stale" cue (server
      `cardOverdue` + the Alpine mirror agree).
- [ ] An **unblocked** overdue `doing` card still pokes / still cues (no
      regression).
- [ ] A card whose only blocker is now `done` is treated as unblocked → pokes
      again.
- [ ] `SKILL.md` carries the model-the-wait-as-a-block + size-long-cards nudge.
- [ ] `bun test` green (new pure tests for `computeDuePokes` + `cardOverdue`);
      read-only smoke test passes; version bump via release-please conventional
      commit (`feat(bounty)`); no hand-edited version.

## References

- `plugins/spellbook/skills/bounty/scripts/server.ts` — `computeDuePokes`
  (~L106–135), `cardOverdue` (~L145–152), `expectedMinutes` (~L97–101),
  `Task.blockedBy` (~L76)
- `plugins/spellbook/skills/bounty/scripts/template.html` — the Alpine
  `cardOverdue` mirror
- `plugins/spellbook/skills/bounty/SKILL.md` — heartbeat / sizing guidance
- GitHub issue: #40. Design review: `bounty-heartbeat-design` grapevine channel
  (maestro, dream-flute team).
- Memory: `bounty-surface-lockstep-mirror` (the server-helper ⇄ Alpine-mirror
  drift risk this touches).
