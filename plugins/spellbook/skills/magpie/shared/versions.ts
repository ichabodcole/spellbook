// shared/versions.ts
// Pure version helpers shared by the backend CLI (src/magpie/backend/cli.ts,
// which reads chosenVersion for export) AND the React client (MagpieShell,
// ExportView, RemoveGallery). server.ts does NOT import them — the daemon-side
// consumer is the CLI, and that is what makes this two-sided. No node:* — keep
// browser-safe. An element's produced assets are a model-tagged list (versions[]);
// these resolve "which one is shown" and "its cache-busted URL".

import type { Element, ElementVersion } from "./types";

// The version the surface renders: the explicitly chosen one, else the first
// (the crop). Tolerates an absent/empty list and a stale chosenVersionId.
export function chosenVersion(el: Element): ElementVersion | undefined {
  const vs = el.versions ?? [];
  return vs.find((v) => v.id === el.chosenVersionId) ?? vs[0];
}

// The /assets URL for a version, cache-busted by its rev. A re-run overwrites the
// file in place, so without ?v=<rev> the browser shows the stale cached image.
export function versionUrl(v: ElementVersion): string {
  return `/assets/${v.path.split("/").pop()}?v=${v.rev ?? 0}`;
}
