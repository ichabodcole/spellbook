// R4 B1 — the build-stamp footer, pure half. `/state.buildInfo` is spread
// AT THE HANDLER in release mode only (server.ts — the engine's exported
// ProjectState under-reports the wire here, presence's sibling): absent
// buildInfo (dev mode, a pre-stamp dist, an old daemon) = NO footer at all,
// absence over a fabricated "unknown build" row.

export type BuildInfo = {
  commit: string;
  builtAt: string;
  stale: boolean;
};

// "just now" | "34m ago" | "5h ago" | "3d ago"; null when builtAt doesn't
// parse (a corrupt stamp tolerated server-side stays tolerated here).
export function formatAge(builtAt: string, now: number = Date.now()): string | null {
  const t = Date.parse(builtAt);
  if (Number.isNaN(t)) return null;
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// The footer line: short commit + age, and the staleness said plainly when
// the daemon flagged the dist older than the surface source next to it.
export function buildFooterText(info: BuildInfo, now: number = Date.now()): string {
  const age = formatAge(info.builtAt, now);
  const base = `build ${info.commit}${age ? ` · ${age}` : ""}`;
  return info.stale ? `${base} · stale — surface source is newer than this dist` : base;
}
