// R5 ESC fix (bug #11) — the guard that decides whether a window-level Escape
// dismisses the search palette. Escape is lifted to a global handler (mirroring
// the ⌘K / "/" summon) so it works whether or not the palette input holds
// focus — but it must NOT hijack Escape from the nodeForm / composer / an open
// dialog, each of which owns its own Escape. Pure so the branching is tested
// without a DOM.
//
//  - search input focused        → dismiss (Escape while typing in search).
//  - another INPUT/TEXTAREA       → false (that field owns its Escape).
//  - board focus + lingering query → dismiss (clear a query left showing after
//    focus drifted back to the canvas).
//  - board focus, no query        → no-op.

export function shouldDismissSearch(
  activeTag: string | null,
  isSearchInput: boolean,
  hasQuery: boolean,
): boolean {
  if (isSearchInput) return true;
  if (activeTag === "INPUT" || activeTag === "TEXTAREA") return false;
  return hasQuery;
}
