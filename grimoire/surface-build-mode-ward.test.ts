// SURFACE BUILD MODE WARD — a shipped surface must be React's PRODUCTION build.
//
// Why this exists: v3.0.0 shipped all nine surfaces built against React's
// DEVELOPMENT build, because `buildSurface()` did not pin `process.env.NODE_ENV`
// and React's export conditions default to `development`. The development build
// carries the Performance Track instrumentation — `logComponentRender` writes a
// `performance.measure()` entry, with a structured-cloneable `detail`, on EVERY
// component render, into a buffer nothing clears. Any surface that re-renders on
// an interval (scriptorium's `useNow()`, every 30s, so "5 min ago" stays true)
// therefore fills that buffer WHILE THE HUMAN IS IDLE until the clone cannot
// allocate: `DataCloneError: ... out of memory` inside commitPassiveMountOnFiber,
// which abandons React's commit phase and leaves the tab dead behind
// `Should not already be working`.
//
// ⚠ IT WAS FOUND BY A CONSUMER, AND THE EVIDENCE WAS ALREADY IN THE REPO.
// `docs/projects/_archive/backend-convergence/phase-1b-journal.md:194` and
// `phase-2-journal.md:340` both recorded "the unminified DEV React graph" in
// September 2026. The dev build was observed TWICE and written down as a SIZE
// fact; no instrument read it as a correctness defect, because no instrument
// read it at all. That is the gap this file closes — not the bug, which is
// fixed in `src/build.ts`, but the silence around it.
//
// ⛔ WHAT THIS WARD CANNOT SEE — read this before citing a green from it.
//   1. MARKER-BASED, NOT SEMANTIC. It greps the emitted bundle for identifiers
//      React's development build is known to contain. A future React that
//      renames them makes this ward green by accident. The positive control
//      below is what keeps that honest: it fails if the detector stops
//      detecting, but it cannot tell you the marker list is COMPLETE.
//   2. SURFACES ONLY. Backends are built with a different call and are not
//      React; nothing here says anything about them.
//   3. NOT A MINIFY CHECK. `minify` also strips these markers, but minify is
//      deferred under register D7 behind a ward-calibration precondition. This
//      ward asserts the DEV BUILD is absent, never that the bundle is minified —
//      and it must keep passing under both, or it silently becomes a minify
//      check the day D7 is decided.
//   4. IT DOES NOT PROVE THE TAB SURVIVES. It proves the instrumentation is not
//      shipped. The idle-crash chain has other possible causes; this closes one.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Anchored on the INVOCATION root, as the sibling wards are, so an out-of-tree
 *  draft and the landed file are byte-identical. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, ".claude-plugin/marketplace.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found (no .claude-plugin/marketplace.json above cwd)");
}

const REPO = repoRoot();
const SKILLS = join(REPO, "plugins/spellbook/skills");

// Identifiers present in React's development build and absent from production.
// `logComponentRender`/`logComponentEffect` are the Performance Track writers —
// the actual leak. The track label is the string they measure under.
const DEV_MARKERS = ["logComponentRender", "logComponentEffect", "Components ⚛"];

/** Every shipped surface bundle: `<spell>/dist/index-<hash>.js`. */
function surfaceBundles(): { spell: string; path: string }[] {
  const out: { spell: string; path: string }[] = [];
  for (const d of readdirSync(SKILLS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dist = join(SKILLS, d.name, "dist");
    if (!existsSync(dist)) continue;
    for (const f of readdirSync(dist)) {
      if (/^index-[a-z0-9]+\.js$/.test(f)) out.push({ spell: d.name, path: join(dist, f) });
    }
  }
  return out.sort((a, b) => a.spell.localeCompare(b.spell));
}

/** The detector, factored out so the positive control exercises the SAME code
 *  the assertion does. A control that re-implements the check proves nothing. */
export function devMarkersIn(text: string): string[] {
  return DEV_MARKERS.filter((m) => text.includes(m));
}

describe("surface build mode ward", () => {
  const bundles = surfaceBundles();

  test("the denominator is not empty — a green over zero bundles proves nothing", () => {
    expect(bundles.length).toBeGreaterThan(0);
  });

  test("no shipped surface bundle carries React's development build", () => {
    const offenders: string[] = [];
    for (const b of bundles) {
      const found = devMarkersIn(readFileSync(b.path, "utf8"));
      if (found.length > 0) offenders.push(`${b.spell}: ${found.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  test("positive control — the detector NAMES a marker in a dev-build sample", () => {
    // Not a real bundle: the point is that the predicate fires, so a green above
    // means "looked and found nothing" rather than "never looked".
    expect(devMarkersIn("var x=1;function logComponentRender(a){}")).toEqual([
      "logComponentRender",
    ]);
    expect(devMarkersIn("var x=1;")).toEqual([]);
  });

  test("the population is PRINTED, so a green cannot mean `unexamined`", () => {
    console.warn(
      `\n  SURFACE BUILD MODE WARD — ${bundles.length} shipped surface bundle(s) read as text.\n` +
        `     markers: ${DEV_MARKERS.join(" · ")}\n` +
        `     ${bundles.map((b) => b.spell).join(" · ")}\n` +
        `  ⛔ BLIND TO: marker completeness (a renamed React internal passes) · backends · ` +
        `whether the tab actually survives · minify (D7), which this does NOT assert.\n`,
    );
    expect(bundles.length).toBe(new Set(bundles.map((b) => b.spell)).size);
  });
});
