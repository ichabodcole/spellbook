// A stored pane layout the layout library can use, or nothing.
//
// `react-resizable-panels`' `useDefaultLayout` reads its saved layout during
// render and parses it with `JSON.parse`, unguarded (4.12.4). One corrupt value
// (a hand edit, a crash mid-write, an older build's shape) throws, and the whole
// page renders nothing. So every `useDefaultLayout` the kit calls reads through
// this wrapper: a value under the hook's own key that is not a layout for exactly
// these panels reads as absent, and the hook opens its default layout, which it
// then writes over the bad one. Writes, and every other key, pass through.
//
// DOM-free.

import type { KeptStorage } from "./storage.ts";

/** The key `useDefaultLayout` keeps a group's layout under (`react-resizable-panels`' own rule). */
export function layoutKey(id: string, panelIds: readonly string[]): string {
  return `react-resizable-panels:${[id, ...panelIds].join(":")}`;
}

/** How far a stored layout's sizes may sum from 100 (rounding in what the library wrote). */
export const LAYOUT_SUM_SLACK = 0.5;

/**
 * Whether `raw` is a layout for exactly `panelIds`: a JSON object with one size
 * per panel, each a number from 0 to 100, and nothing else, the sizes summing to
 * 100 (within `LAYOUT_SUM_SLACK`). A layout summing elsewhere (300, 60, or all
 * zero) would open as something no one chose: equal thirds, or every side shut.
 */
export function isStoredLayout(raw: string, panelIds: readonly string[]): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const sizes = parsed as Record<string, unknown>;
  if (Object.keys(sizes).length !== panelIds.length) return false;
  let sum = 0;
  for (const id of panelIds) {
    const size = sizes[id];
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0 || size > 100) return false;
    sum += size;
  }
  return Math.abs(sum - 100) <= LAYOUT_SUM_SLACK;
}

/**
 * `storage`, with the layout of group `id` over `panelIds` read only when it is
 * one (`isStoredLayout`); otherwise null, so the default layout is used.
 */
export function guardedLayoutStorage(
  storage: KeptStorage,
  id: string,
  panelIds: readonly string[],
): KeptStorage {
  const key = layoutKey(id, panelIds);
  return {
    getItem: (k) => {
      const raw = storage.getItem(k);
      if (k !== key || raw === null) return raw;
      return isStoredLayout(raw, panelIds) ? raw : null;
    },
    setItem: (k, v) => storage.setItem(k, v),
  };
}
