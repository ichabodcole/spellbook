// Per-card derivations: what the blocked, stale and wip cues say.
//
// The four predicates underneath are IMPORTED from the skill's shared/ folder —
// `liveBlockerCount`, `cardOverdue`, `ownersOverWip`, `expectedMinutes` — where
// the daemon's copy lives and `scripts/server.test.ts` guards them. The old
// page re-implemented all four in Alpine (the b16 lockstep) with nothing
// testing the copies. What is left here is only the WORDING, which is the
// surface's own business.

import {
  cardOverdue,
  liveBlockerCount,
  ownersOverWip,
} from "../../../../plugins/spellbook/skills/bounty/shared/predicates";
import type { Task } from "./types";

export { cardOverdue, liveBlockerCount, ownersOverWip };

/** "⛔ blocked by 3". Rendered only when the count is > 0. */
export function blockedLabel(count: number): string {
  return `⛔ blocked by ${count}`;
}

/** Minutes, floored at 1: an overdue-by of 30 s reads "1m over", never "0m". */
function mins(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

/**
 * "⏱ Doing 25m · 12m over" — total age AND overdue-by (Cole's pick). Returns
 * "" when the card is not stale, so a caller that already checked can render
 * it unguarded.
 */
export function staleLabel(task: Task, tasks: Task[], now: number): string {
  const s = cardOverdue(task, tasks, now);
  if (!s) return "";
  return `⏱ Doing ${mins(s.ageMs)}m · ${mins(s.overdueByMs)}m over`;
}

/**
 * A card is wip-cued iff it is DOING and its owner is over the limit. A
 * todo/review/done card of the same owner never shows it.
 */
export function wipCued(task: Task, over: Set<string>): boolean {
  return task.status === "doing" && task.owner !== undefined && over.has(task.owner);
}

/**
 * "3 in Doing — wrap one before pulling more". N counts THAT owner's doing
 * cards, unfiltered by staleness or blocking.
 */
export function wipLabel(task: Task, tasks: Task[]): string {
  const n = tasks.filter((t) => t.status === "doing" && t.owner === task.owner).length;
  return `${n} in Doing — wrap one before pulling more`;
}
