// The board's wire shape — the ONE definition, read by both sides of the seam.
//
// Two-sided by consumer set: `scripts/server.ts` holds the canonical state in
// it, and `src/bounty/surface/` renders it. It lives here, INSIDE the tracked
// skill subtree, so a source-shipped daemon can reach `../shared/types` at the
// destination with nothing installed (seams Contract 3, row 1) while the
// surface reaches it across the artifact boundary the import-boundary wards
// permit.
//
// ⛔ NOTHING IMPERATIVE BELONGS HERE. Types and the size table only; the
// predicates that read them are in ./predicates.ts, and the daemon's mutators
// stay in scripts/server.ts. A module can be two-sided by file and disjoint by
// symbol — shipping the daemon's mutators to the board is the failure this
// split exists to avoid.

export type TaskStatus = "todo" | "doing" | "review" | "done";

/** A single status transition (unix ms). */
export type StatusVisit = { status: TaskStatus; at: number };

/**
 * Heartbeat sizing. Three sizes only — agents are fast, and the absence of an
 * XL is deliberate: a days-long task is a signal to BREAK IT DOWN, not to size
 * it bigger.
 */
export type TaskSize = "S" | "M" | "L";

export const SIZE_MINUTES: Record<TaskSize, number> = { S: 5, M: 10, L: 20 };

export type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  notes?: string;
  owner?: string; // assignee — lead sets via add/update --owner; worker self-claims
  blockedBy?: string[]; // ids this task is blocked on (mutated only via block/unblock)
  tags?: string[]; // free-form labels; clean string[]
  enteredStatusAt?: number; // unix ms the task entered its CURRENT status
  statusHistory?: StatusVisit[]; // capped transition log (heartbeat/aging/metrics substrate)
  size?: TaskSize; // heartbeat sizing — opt-in; maps to a default expected time
  expect?: number; // explicit expected minutes (overrides size); for the rare exception
};

export type BoardState = { title: string; tasks: Task[] };
