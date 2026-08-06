// Project-in-URL (plan-v1x circe T2) — a board you can link to. Resolution
// order is explicit-first: URL ?project= > localStorage > undefined (which
// lets the daemon's default-project resolution decide). The resolver is pure
// (string in, id out) so the precedence is testable without a DOM; the two
// writers below are thin browser glue, verified live like the rest of the
// hook layer.

export const PROJECT_STORAGE_KEY = "mind-mapper:project";

/** URL param > stored value > undefined. Blank/whitespace values don't count. */
export function resolveInitialProject(search: string, stored: string | null): string | undefined {
  return resolveInitialProjectWithSource(search, stored).id;
}

// Round 3 (Claim P1): WHERE the initial id came from decides how a 404 on it
// degrades — a stale STORED id quietly falls back to the landing (and clears
// storage), but an explicit ?project= link is the user's own assertion, so
// its 404 gets said honestly instead of silently re-homed.
export type ProjectSource = "url" | "stored" | "none";

export function resolveInitialProjectWithSource(
  search: string,
  stored: string | null,
): { id: string | undefined; source: ProjectSource } {
  const fromUrl = new URLSearchParams(search).get("project")?.trim();
  if (fromUrl) return { id: fromUrl, source: "url" };
  const fromStore = stored?.trim();
  if (fromStore) return { id: fromStore, source: "stored" };
  return { id: undefined, source: "none" };
}

// The degrade half of the stale-stored-id rule: forget the id so the next
// boot doesn't retry it. URL untouched (a stored id never wrote one).
export function forgetStoredProject(): void {
  try {
    localStorage.removeItem(PROJECT_STORAGE_KEY);
  } catch {
    // storage can be unavailable — nothing to forget then.
  }
}

/** The search string with ?project= set to `id`, other params preserved. */
export function withProjectParam(search: string, id: string): string {
  const params = new URLSearchParams(search);
  params.set("project", id);
  return `?${params.toString()}`;
}

// Browser glue — mirror the active project into the address bar (replaceState,
// no history spam) and localStorage, so reload and next-visit land on the same
// board. Callers decide WHEN (switchProject, or the daemon-default mirror when
// no explicit choice existed).
export function rememberProject(id: string): void {
  try {
    localStorage.setItem(PROJECT_STORAGE_KEY, id);
  } catch {
    // storage can be unavailable (private mode) — the URL still carries it.
  }
  history.replaceState(null, "", `${withProjectParam(location.search, id)}${location.hash}`);
}
