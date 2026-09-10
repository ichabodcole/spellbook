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
 *
 * ── AND "WHETHER IT MAY BE READ" IS NOW A WHITELIST ─────────────────────────
 *
 * Extracted with three guards (empty / `..` / nested) and `existsSync` for the
 * rest, which was true of a `dist/` that held only a surface. Phase 1b put every
 * daemon's BUNDLE in that same directory, and all five adopters served it:
 * `/cli.js`, `/server.js`, `/join.js` at 200, byte-identical to the committed
 * artifacts, embedded sourcemaps and all. `serveFromDist` now serves only what the
 * built `index.html` transitively links — see `surfaceWhitelist` below, which is
 * the shape digestify proved locally in `d8cbaff` and this is its one edit for
 * five spells.
 */

import { existsSync, readFileSync } from "node:fs";
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
 * ⛔ AND `existsSync` IS NO LONGER THE PERMISSION. A file under `distDir` is
 * served only if it is in `surfaceWhitelist(distDir)` — what the built
 * `index.html` transitively LINKS. `dist/` stopped being a surface directory
 * when the backend convergence built the daemons into it, and the guards above
 * do not distinguish `index-<hash>.js` from `server.js`. Read that function's
 * header before touching this line; the whitelist is the defence.
 *
 * ⚠ The nesting refusal is also what keeps an asset serve clear of a spell's
 * own routes: magpie, bounty, glamour and imago each have an `/assets/<name>`
 * route one level deep, and this returning `null` on anything with a slash in
 * it is what stops the two fighting. The whitelist governs `dist/` reads ONLY
 * — it never sees those routes and must never be widened into them.
 */
export function serveFromDist(distDir: string, rel: string): Response | null {
  if (!rel || rel.includes("..") || rel.includes("/")) return null;
  if (!surfaceWhitelist(distDir).has(rel)) return null;
  const file = join(distDir, rel);
  if (!existsSync(file)) return null;
  return new Response(Bun.file(file), { headers: { "Content-Type": contentTypeFor(rel) } });
}

/** `src`/`href` values in a built entry document, `./`-prefixed or bare. */
const ENTRY_REF_RE = /(?:src|href)\s*=\s*"(?:\.\/)?([^"]+)"/g;

/** A `./`-PREFIXED sibling specifier — `"./name"`, `'./name'`, `(./name)` — which
 *  is the only shape a bundler emits for a sibling chunk. Requiring the `./` is
 *  what keeps a string literal that merely SAYS `cli.js` out of the set. */
const RELATIVE_REF_RE = /["'(]\.\/([^"'()\s]+)["')]/g;

/** Only text the build emits as surface code is scanned for onward references.
 *  A `.png` is a leaf; opening it would be reading a binary for filenames. */
const TRANSITIVE_EXTS = [".js", ".css"];

/** One derivation per `dist/`, for the life of the process — `dist/` is a build
 *  artifact and does not change under a running daemon. Keyed by directory so
 *  two daemons in one process (and every test with its own temp tree) stay
 *  independent. */
const whitelistCache = new Map<string, ReadonlySet<string>>();

function refsIn(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)]
    .map(([, ref]) => ref)
    .filter(
      (ref) =>
        !!ref &&
        !ref.includes("/") &&
        !ref.includes("..") &&
        !ref.includes(":") &&
        !ref.startsWith("#") &&
        !ref.startsWith("?"),
    );
}

/**
 * The names under `distDir` a browser may fetch: the entry document, plus the
 * TRANSITIVE closure of what it links.
 *
 * ⛔ **A WHITELIST, AND THE LEAK IT REPLACED IS WHY.** Until this fix the file
 * half of this module had exactly three guards — empty, `..`, nested — and
 * `existsSync` decided the rest. That was correct for as long as `dist/` held
 * only a surface. The backend convergence moved every spell's IMPLEMENTATION
 * into the same directory, and the serve did what it was written to do:
 *
 *   GET /cli.js     200  242,431 B  text/javascript   ← bounty, byte-identical
 *   GET /server.js  200  276,415 B  text/javascript      to the committed
 *   GET /join.js    200   47,348 B  text/javascript      artifacts
 *
 * and those bundles are built with the sourcemap EMBEDDED, so each one carries
 * the complete original TypeScript. Five spells — astrolabe, bounty, glamour, imago, magpie
 * — eleven artifacts, all reachable by any browser that can reach the daemon.
 * Digestify hit the identical defect one branch earlier and answered it locally;
 * this is that answer re-homed to the one place all five callers already share.
 *
 * ⛔ **DERIVED, NOT ENUMERATED, AND NOT MATCHED BY SHAPE.** A literal name list
 * is wrong at the next build (the chunks carry content hashes). A shape match
 * (`index-<hash>.js`) is wrong the first time the bundler splits a chunk. Asking
 * the entry document what it loads is the only formulation that is true of
 * whatever `bun run build` actually emitted.
 *
 * ⛔ **AND THE CLOSURE IS TRANSITIVE FOR THE SAME REASON.** `index.html` links
 * one chunk today; a split build has that chunk `import "./chunk-<hash>.js"`,
 * which the entry document never names. So every admitted `.js`/`.css` is itself
 * scanned for `./`-prefixed siblings, until the set stops growing — a whitelist
 * that read only the entry would 404 a legitimate chunk in release, and only in
 * release.
 *
 * ⛔ **MEMBERSHIP IS AN EXACT MATCH, WHICH MAKES THE REFUSAL CASE-INSENSITIVE BY
 * CONSTRUCTION.** APFS is case-insensitive, so `/INDEX.HTML` and `/iNdEx.HtMl`
 * resolve to the same inode a case-sensitive blacklist would miss (measured on
 * all five spells before this fix: four variants, four 200s, three of them as
 * `application/octet-stream` because the content-type lookup is case-sensitive
 * too). A set of exactly the emitted names refuses every variant of every name
 * — servable or not — with no lower-case pass anywhere.
 *
 * ⚠ **THE TRADE:** a file the entry graph does not reference — a lazily fetched
 * chunk, a font pulled by a CSS `url()` this scan does not model, an asset the
 * build emits but nothing links — 404s in release with nothing red. Each
 * adopter's `release-serve.test.ts` holds the instrument: an INVENTORY cell that
 * accounts for every file in `dist/` as served or deliberately refused, so an
 * unlinked emission goes red at build time rather than silent at runtime.
 *
 * ⚠ The entry document is IN the set, because the house caller maps `/` to
 * `index.html` and that is the surface. A spell that must never hand over its
 * on-disk entry — digestify substitutes a payload into it in memory — refuses
 * that ONE name in its own router, above this call. That refusal is the spell's;
 * everything else here is the kit's.
 */
function surfaceWhitelist(distDir: string): ReadonlySet<string> {
  const cached = whitelistCache.get(distDir);
  if (cached) return cached;

  const names = new Set<string>();
  const entry = join(distDir, "index.html");
  if (existsSync(entry)) {
    names.add("index.html");
    const html = readFileSync(entry, "utf8");
    const pending = [...refsIn(html, ENTRY_REF_RE), ...refsIn(html, RELATIVE_REF_RE)];
    // Until the set stops growing: each admitted chunk may name the next one.
    while (pending.length > 0) {
      const name = pending.pop() as string;
      if (names.has(name)) continue;
      // ⚠ REFERENCED **AND** PRESENT. A minified bundle can contain a string
      // that merely LOOKS like one; admitting only names that
      // are actually on disk keeps the scan from widening the set on a
      // coincidence, and a name that is absent 404s identically either way.
      const file = join(distDir, name);
      if (!existsSync(file)) continue;
      names.add(name);
      if (!TRANSITIVE_EXTS.some((ext) => name.endsWith(ext))) continue;
      pending.push(...refsIn(readFileSync(file, "utf8"), RELATIVE_REF_RE));
    }
  }

  whitelistCache.set(distDir, names);
  return names;
}
