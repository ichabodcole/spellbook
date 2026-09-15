// surface-filter — the human's view lens. Client-only: nothing here is ever
// sent, and no event is emitted (inventory F15).
//
// The predicate itself is NOT here. `cardPassesFilter` is imported from the
// skill's shared/ folder, where the daemon's own copy lives and where
// `scripts/server.test.ts` guards it. Until 2026-09-06 the page carried a
// hand-written JavaScript mirror of it with nothing testing the copy; deleting
// that mirror is the point of this module's existence.

import { cardPassesFilter } from "../../../../plugins/spellbook/skills/bounty/shared/predicates";
import type { Task } from "./types";

export { cardPassesFilter };

export type Filters = { tags: string[]; owners: string[] };

export const NO_FILTERS: Filters = { tags: [], owners: [] };

/** The localStorage key. Per-origin, which includes the port, so each board
 *  keeps its own filters. */
export const FILTERS_KEY = "bounty:filters";

/** The subset of `Storage` this module needs, so the persistence rules run
 *  under `bun test` against a Map instead of a browser. */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/**
 * The distinct tags on the board, UNIONED with the active tag filters and
 * sorted. The union is load-bearing: an active filter always has a visible,
 * individually-toggleable chip, even when its cards are hidden or its tag has
 * since vanished from every card — a stale persisted filter stays escapable
 * without reaching for "clear".
 */
export function boardTags(tasks: Task[], active: string[]): string[] {
  const s = new Set(active);
  for (const t of tasks) for (const tag of t.tags ?? []) s.add(tag);
  return [...s].sort();
}

/** The same, for owners. */
export function boardOwners(tasks: Task[], active: string[]): string[] {
  const s = new Set(active);
  for (const t of tasks) if (t.owner) s.add(t.owner);
  return [...s].sort();
}

export function hasActiveFilters(f: Filters): boolean {
  return f.tags.length > 0 || f.owners.length > 0;
}

/** Toggle one value in or out of one facet. */
export function toggleFacet(values: string[], value: string): string[] {
  const i = values.indexOf(value);
  return i === -1 ? [...values, value] : [...values.slice(0, i), ...values.slice(i + 1)];
}

/**
 * Best-effort persistence. A private-mode or quota throw MUST never break the
 * board — the write is a convenience, the filter is already applied in memory
 * (inventory F11, silent branch Z2).
 */
export function persistFilters(storage: StorageLike | undefined, f: Filters): void {
  try {
    storage?.setItem(FILTERS_KEY, JSON.stringify({ tags: f.tags, owners: f.owners }));
  } catch {}
}

/**
 * Best-effort restore, with a shape check: only arrays are read, and only their
 * `string` members survive. A missing, unreadable or corrupt value yields no
 * filters rather than an error (inventory F12/F13, silent branch Z3).
 */
export function loadFilters(storage: StorageLike | undefined): Filters {
  try {
    const raw = storage?.getItem(FILTERS_KEY);
    if (!raw) return NO_FILTERS;
    const v = JSON.parse(raw) as { tags?: unknown; owners?: unknown };
    return {
      tags: Array.isArray(v.tags) ? v.tags.filter((x): x is string => typeof x === "string") : [],
      owners: Array.isArray(v.owners)
        ? v.owners.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return NO_FILTERS;
  }
}

/**
 * The cards of one column, narrowed by the active filter. Both the rendered
 * cards and the column count read THIS call, so the count tracks what is
 * visible rather than what exists (inventory F9).
 */
export function tasksByStatus(tasks: Task[], status: string, f: Filters): Task[] {
  return tasks.filter((t) => t.status === status && cardPassesFilter(t, f.tags, f.owners));
}
