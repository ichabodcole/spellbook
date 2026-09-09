/**
 * The house's ONE asset-serving trio for a spell daemon: which surface mode we
 * are in, what content type a file gets, and how a file under `dist/` is
 * answered.
 *
 * ⛔ THE KIT IS A LEAF. Nothing here may import out of `src/kit/` — ward 2's
 * assertion, and what makes this module safe to bundle into any spell's artifact.
 *
 * Extracted 2026-09-08 (Phase 1b chapter 2) from the eight `Bun.serve` backends
 * censused in `docs/investigations/2026-09-08-daemon-spine-census.md`, which
 * measured `resolveMode` as byte-identical in all eight (the only md5 difference
 * being the `export` keyword), the content-type map as differing in exactly
 * one cell, and the file half of `serveDist` as identical in five.
 *
 * ── WHAT DELIBERATELY DID NOT COME ALONG ────────────────────────────────────
 *
 * **The URL-to-filename mapping stays in each router.** The census marked two
 * of the eight `serveDist` divergences DELIBERATE and both live in that half:
 * digestify substitutes into the entry HTML in memory, and grapevine serves its
 * surface at `/watch` rather than at `/`. A signature wide enough to absorb
 * those stops being a file server and becomes a router. So the caller decides
 * WHICH file (`path === "/" ? "index.html" : path.slice(1)`), and this module
 * decides whether that file may be read and what it is served as.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Release iff `<distDir>/index.html` exists; else dev. The env override
 * (`SPELLBOOK_SURFACE_MODE`) wins either way — seams Contract 1.
 *
 * ⛔ **THE FILE, NEVER THE DIRECTORY, AND THAT IS A SCAR NOT A STYLE CHOICE.**
 * Re-homed from bounty and magpie, which earned it independently:
 *
 * - magpie's `dist/` ALREADY EXISTED holding `cli.js` and no `index.html`,
 *   which is precisely why its daemon stayed correctly in DEV mode through the
 *   whole of Slice 2. `dist/` existing is not the discriminator.
 * - bounty says the same thing from the other side: a built BACKEND puts
 *   `cli.js` (and now `server.js`) in `dist/` with no surface anywhere near it.
 *
 * ⚠ **AND THE PREDICATE IS AN UNHASHED FILENAME, WHICH IS A STANDING
 * ASSUMPTION ABOUT THE SURFACE BUILD.** Release mode is chosen by ONE literal
 * name. A surface build that ever emitted a content-hashed entry document would
 * leave no `index.html` here, every daemon would silently resolve DEV, and the
 * only symptom anyone can see is the `mode` field on a handshake nobody reads in
 * anger. `src/build.ts` emits the entry unhashed today (only the JS and CSS
 * chunks carry hashes) and Contract 2 pins that flat layout; this comment is
 * the note that says what the pin is load-bearing FOR.
 *
 * ⚠ Nothing announces the flip from dev to release either: the first surface
 * build to land an `index.html` beside a daemon flips it, silently, on the next
 * boot. That is why `mode` rides the ready frame — with root deps present a dev
 * daemon renders an identical-looking surface, so "it looks right" cannot
 * verify Contract 1.
 */
export function resolveMode(distDir: string): "dev" | "release" {
  const override = process.env.SPELLBOOK_SURFACE_MODE;
  if (override === "dev" || override === "release") return override;
  return existsSync(join(distDir, "index.html")) ? "release" : "dev";
}

/**
 * The content types a built surface actually ships. Extensions outside the
 * map get `application/octet-stream` — a deliberate refusal to guess, since
 * anything not in this list is not something Contract 2's build emits.
 *
 * ⚠ **`charset=utf-8` ON HTML IS THE CENSUS'S ONE DIVERGENCE, RESOLVED TOWARD
 * THE CORRECT COPY.** Three of the eight daemons carried it and five did not;
 * the census graded that `stale` with zero design content. It is kept because
 * it is the right answer — an HTML document served with no charset is decoded
 * by the browser's guess — and it is the one wire-observable change this
 * convergence makes to a response header. Recorded as D-note in the phase log
 * rather than smuggled.
 */
const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** The content type for a filename or an extension. Unknown extensions, and
 *  names with no extension at all, get `application/octet-stream`. */
export function contentTypeFor(nameOrExt: string): string {
  const dot = nameOrExt.lastIndexOf(".");
  const ext = dot === -1 ? "" : nameOrExt.slice(dot);
  return STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Answer ONE file from `distDir`, or `null` if the caller should keep routing.
 *
 * `rel` is a bare filename — the entry document or one hashed chunk. Contract
 * 2's built surface is FLAT and links its chunks relatively, so a legitimate
 * asset request is never nested and never contains `..`; both are refused
 * here rather than in the router, because the guard protects the read and the
 * read is what lives in this file.
 *
 * ⚠ The refusal is also what keeps an asset serve clear of a spell's own
 * routes: magpie has an `/assets/<name>` route one level deep, and this
 * returning `null` on anything with a slash in it is what stops the two
 * fighting.
 */
export function serveFromDist(distDir: string, rel: string): Response | null {
  if (!rel || rel.includes("..") || rel.includes("/")) return null;
  const file = join(distDir, rel);
  if (!existsSync(file)) return null;
  return new Response(Bun.file(file), { headers: { "Content-Type": contentTypeFor(rel) } });
}
