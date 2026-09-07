// The four board predicates BOTH sides need, and the blocker count under them.
//
// ⛔ THIS FILE EXISTS TO DELETE A MIRROR. Until 2026-09-06 the board was one
// inline-Alpine HTML file, so it could not import; `scripts/template.html`
// hand-re-implemented `cardPassesFilter`, `cardOverdue`, `ownersOverWip` and
// `expectedMinutes` in JavaScript beside their canonical TypeScript, with
// nothing testing the copy. Four comments in `server.ts` said "the inline
// Alpine surface mirrors it (it can't import). Keep in lockstep." — a house
// hazard with no instrument behind it. The surface can import now. **If you
// find yourself writing a second copy of anything below, the seam has broken
// and the right fix is another export here, never a re-implementation.**
//
// Every function here is PURE and clock-injected: `now` is a parameter, never
// `Date.now()`, so the daemon's sweep and the browser's 30 s tick can read the
// same code with different clocks. `scripts/server.test.ts` is the guard.

import type { Task } from "./types";
import { SIZE_MINUTES } from "./types";

/**
 * A task's expected time in minutes, or undefined when it isn't watched.
 * Heartbeat is opt-in per task: an explicit `expect` wins, else the size's
 * default, else undefined (no size/expect → never poked, never aged).
 */
export function expectedMinutes(task: Task): number | undefined {
  if (typeof task.expect === "number" && task.expect > 0) return task.expect;
  if (task.size && task.size in SIZE_MINUTES) return SIZE_MINUTES[task.size];
  return undefined;
}

/**
 * How many of a task's blockers are still LIVE — a `blockedBy` id pointing at
 * an EXISTING task that isn't done yet. A missing or done blocker doesn't
 * block.
 *
 * The count, not the boolean, is the primitive: the daemon only asks "is it
 * blocked?", the card renders "⛔ blocked by N", and one of the two used to be
 * a hand-written copy of the other.
 */
export function liveBlockerCount(task: Task, tasks: Task[]): number {
  return (task.blockedBy ?? []).filter((bid) => {
    const b = tasks.find((t) => t.id === bid);
    return b !== undefined && b.status !== "done";
  }).length;
}

/**
 * A task is blocked iff it has at least one live blocker — the same predicate
 * the /state projection uses for `blocked`/`liveBlockers`. A blocked doing card
 * is legitimately waiting on a peer, not stuck, so neither the heartbeat poke
 * nor the card-aging sweep fires on it (#40).
 */
export function isBlocked(task: Task, tasks: Task[]): boolean {
  return liveBlockerCount(task, tasks) > 0;
}

/**
 * Card-aging (#2): the surface companion to heartbeat. A doing card that has an
 * expected time (size/expect) and has overrun it reads as "stale". Returns null
 * when the card shouldn't be cued (not doing, unsized, unstamped, blocked, or
 * not yet overdue) — opt-in, mirroring heartbeat. Returns both `overdueByMs`
 * (an "Nm over" badge) and `ageMs` (a "Doing Nm" badge) so the surface picks
 * the wording.
 *
 * The DAEMON does not call this — `computeDuePokes` is its own path. The board
 * does, on a client-side `now` that ticks every 30 s.
 */
export function cardOverdue(
  task: Task,
  tasks: Task[],
  now: number,
): { overdueByMs: number; ageMs: number } | null {
  if (task.status !== "doing" || task.enteredStatusAt === undefined) return null;
  const exp = expectedMinutes(task);
  if (exp === undefined) return null;
  if (isBlocked(task, tasks)) return null; // legitimately waiting on a peer — not stale
  const ageMs = now - task.enteredStatusAt;
  const overdueByMs = ageMs - exp * 60_000;
  return overdueByMs >= 0 ? { overdueByMs, ageMs } : null;
}

/**
 * surface-filter: whether a card survives the human's view filter. Faceted — OR
 * within a facet (any selected tag matches), AND across facets (the tag-set AND
 * the owner-set). An empty facet means "no filter on this facet" → it passes,
 * so no active filters at all → every card passes.
 *
 * View-only: the daemon never calls it, nothing is sent, no event is emitted.
 * Cards that fail it are HIDDEN, not dimmed, so column counts track the visible
 * set.
 */
export function cardPassesFilter(
  task: Task,
  activeTags: string[],
  activeOwners: string[],
): boolean {
  const tagPass = activeTags.length === 0 || (task.tags ?? []).some((t) => activeTags.includes(t));
  const ownerPass =
    activeOwners.length === 0 || (task.owner !== undefined && activeOwners.includes(task.owner));
  return tagPass && ownerPass;
}

/**
 * wip-cue: the owners who have >= `threshold` cards in DOING — a soft,
 * per-owner WIP signal ("you've got a pileup; wrap one before pulling more").
 * Per-owner, so legitimate parallel owners each under the limit never trip it.
 * UNOWNED doing cards have no worker, so they're excluded and count toward
 * nobody's tally.
 *
 * The daemon does not call it: a purely visual, non-blocking nudge that can
 * never block a move. A card shows the cue iff it is doing AND its owner is in
 * this set.
 */
export function ownersOverWip(tasks: Task[], threshold: number): Set<string> {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    if (t.status === "doing" && t.owner !== undefined) {
      counts.set(t.owner, (counts.get(t.owner) ?? 0) + 1);
    }
  }
  const over = new Set<string>();
  for (const [owner, n] of counts) if (n >= threshold) over.add(owner);
  return over;
}
