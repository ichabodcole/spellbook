// Project-in-URL (plan-v1x circe T2) — a board you can link to. Resolution
// order is explicit-first: URL ?project= > localStorage > undefined (which
// lets the daemon's default-project resolution decide). The resolver is pure
// (string in, id out) so the precedence is testable without a DOM; the two
// writers below are thin browser glue, verified live like the rest of the
// hook layer.

export const PROJECT_STORAGE_KEY = "mind-mapper:project";

/** URL param > stored value > undefined. Blank/whitespace values don't count. */
export function resolveInitialProject(search: string, stored: string | null): string | undefined {
  const fromUrl = new URLSearchParams(search).get("project")?.trim();
  if (fromUrl) return fromUrl;
  const fromStore = stored?.trim();
  if (fromStore) return fromStore;
  return undefined;
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
