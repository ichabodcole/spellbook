import type { ProjectCard } from "../../scripts/state";

// Surface-side board logic, ported from the t13 Alpine surface. The daemon
// sends a coarse `zone` (attention > active > quiet) as the floor; the surface
// refines it live from connected + needsAttention + lastUpdated, so a card slips
// idle → stale on its own clock without waiting for a server push.

export const STALE_MS = 30 * 60 * 1000;

export type Zone = "attention" | "working" | "idle" | "stale";

export function zoneOf(p: ProjectCard, now: number): Zone {
  if (p.needsAttention) return "attention";
  if (p.connected) return "working";
  if (p.status && now - p.status.lastUpdated > STALE_MS) return "stale";
  return "idle";
}

// One pass → the three rendered groups (quiet = idle + stale).
export function partition(projects: ProjectCard[], now: number) {
  const attention: ProjectCard[] = [];
  const active: ProjectCard[] = [];
  const quiet: ProjectCard[] = [];
  for (const p of projects) {
    const z = zoneOf(p, now);
    if (z === "attention") attention.push(p);
    else if (z === "working") active.push(p);
    else quiet.push(p);
  }
  return { attention, active, quiet };
}

export function relTime(lastUpdated: number | undefined, now: number): string {
  if (!lastUpdated) return "";
  const s = Math.max(0, Math.round((now - lastUpdated) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Project-identity ring tint, deterministic from the name (the same glyph the
// daemon seeds gets a stable tint). INTENTIONALLY OUTSIDE the @theme: these are
// 8 deliberately multi-hue identity tints (Tailwind's stock palette), not
// semantic palette — a rebrand leaves them be. Ported as-is from the t13 surface.
const RINGS = [
  "bg-violet-500/20 text-violet-200 ring-violet-500/40",
  "bg-emerald-500/20 text-emerald-200 ring-emerald-500/40",
  "bg-sky-500/20 text-sky-200 ring-sky-500/40",
  "bg-amber-500/20 text-amber-200 ring-amber-500/40",
  "bg-rose-500/20 text-rose-200 ring-rose-500/40",
  "bg-cyan-500/20 text-cyan-200 ring-cyan-500/40",
  "bg-fuchsia-500/20 text-fuchsia-200 ring-fuchsia-500/40",
  "bg-indigo-500/20 text-indigo-200 ring-indigo-500/40",
];

function hashString(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h;
}

export function avatarRing(name: string): string {
  return RINGS[hashString((name || "").toLowerCase()) % RINGS.length];
}
