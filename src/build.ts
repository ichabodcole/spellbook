#!/usr/bin/env bun

// The ONE surface build (seams Contract 2), spell-parameterised. Run with root
// deps (no per-spell package.json):
//
//     bun run build                 # every relocated spell
//     bun run build astrolabe       # one spell
//     bun run src/build.ts mind-mapper
//
// It bundles `src/<spell>/surface/` into a flat, hashed, dependency-free
// `dist/` at the DEPLOYED spell folder
// (plugins/spellbook/skills/<spell>/dist/), so the published plugin can serve a
// working board with no surface/ source, no bunfig.toml, and no node_modules
// present (Contract 4's "source-free by construction"). Backend ships as source
// (Contract 3) — this script only ever touches the surface.
//
// The Tailwind plugin is passed explicitly here (not read off bunfig.toml,
// which only wires Bun's dev SERVE path) — same plugin, both modes, no second
// toolchain (Contract 2).
//
// clean → build. dist/ is rm'd before every build (hashed chunk names otherwise
// ACCUMULATE stale siblings across builds). Nothing else is written into dist/:
// the Round 4 (B1) build stamp (dist/build.json {commit, builtAt}) was REMOVED
// by Cole's ruling — "when it was built" earned nothing, and its timestamp was
// the one field that made a rebuilt dist/ differ from its committed self. With
// it gone dist/ is byte-reproducible from source with no exclusion list, and a
// rebuild of an unchanged tree leaves `git status --porcelain` empty.
//
// ⛔ DO NOT REINTRODUCE A STAMP — no commit, no timestamp, no version, no
// content hash. Surfacing the plugin version is a separate, unresolved item.
//
// ⛔ THIS FILE IS THE ONLY COPY OF THE BUILD. `src/<spell>/build.ts` is a
// two-line delegator, the per-spell entry point named by seams Contract 4; it
// holds no build logic. A second spell must never mean a second copy of
// Bun.build — that duplication is the thing spell-kit exists to remove.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";

const SRC_DIR = import.meta.dir;
const REPO_ROOT = join(SRC_DIR, "..");
const DEPLOY_ROOT = join(REPO_ROOT, "plugins", "spellbook", "skills");

const entryFor = (spell: string) => join(SRC_DIR, spell, "surface", "index.html");
const backendEntryFor = (spell: string) => join(SRC_DIR, spell, "backend", "cli.ts");
const outDirFor = (spell: string) => join(DEPLOY_ROOT, spell, "dist");

const hasSurface = (spell: string) => existsSync(entryFor(spell));
const hasBackend = (spell: string) => existsSync(backendEntryFor(spell));

/** A spell is buildable iff `src/<spell>/surface/index.html` exists. Derived
 *  from the tree rather than from a hand-kept list, so relocating a spell is
 *  the only step needed to put it in the build.
 *
 *  A spell is buildable iff it has EITHER aspect. The two are INDEPENDENT:
 *  astrolabe has both, magpie has only a backend (its surface still ships
 *  inside the plugin subtree), imago and mind-mapper have only a surface.
 *  Anything assuming a spell has both is wrong about three of the four. */
function buildableSpells(): string[] {
  return readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (hasSurface(e.name) || hasBackend(e.name)))
    .map((e) => e.name)
    .sort();
}

/**
 * Build one spell's BACKEND CLI (seams Contract 4's built-backend amendment,
 * ruled 2026-08-31). Returns a process exit code.
 *
 * THE LOCATION IS THE RULING, NOT THE EMITTED FILENAME. Every instrument in
 * this repo already defines "generated" as "under dist/" - biome excludes
 * dist, gate-blind-set's GENERATED regex matches it - so emitting there costs
 * ZERO instrument changes. Both alternatives were built and measured, and both
 * break something: a bundle named scripts/cli.ts fails bun run check with 5
 * errors (type erasure makes it FALSE TYPESCRIPT - noImplicitAnyLet x3 - and
 * lint-staged then REWRITES the artifact on every commit, breaking Contract
 * 18), while a bundle at scripts/cli.js is green and BLIND (three behavioural
 * wards stop seeing the CLI, and a shrunk population is not a red cell).
 *
 * sourcemap:"inline" IS A RULING (Cole), made knowing it embeds the complete
 * original TypeScript - astrolabe 13,733 bytes of source becomes roughly
 * 60,000 emitted. Contract 4's "source-free by construction" was redefined in
 * the same ruling to mean no source FILES.
 *
 * CLIs ONLY. A server does bundle, but drags the entire surface graph into the
 * backend artifact; that is unruled and out of scope. Do not add server.ts.
 */
async function buildBackend(spell: string): Promise<number> {
  const outdir = outDirFor(spell);
  const result = await Bun.build({
    entrypoints: [backendEntryFor(spell)],
    outdir,
    target: "bun",
    sourcemap: "inline",
    // An entry naming of [name].[ext] off a cli.ts entry emits exactly cli.js,
    // which is the literal path the launcher at scripts/cli.ts imports - so
    // this naming is load-bearing, not a free choice.
    naming: { entry: "[dir]/[name].[ext]", chunk: "[dir]/[name]-[hash].[ext]" },
  });

  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${log}\n`);
    process.stderr.write(`${spell}: backend build failed\n`);
    return 1;
  }

  for (const artifact of result.outputs) {
    process.stdout.write(`${artifact.path.replace(`${outdir}/`, "")} (backend ${artifact.kind})\n`);
  }
  // Its own summary line: a backend-ONLY spell (magpie) never reaches the
  // surface summary, so without this it reports one bare filename and no spell
  // name - the build log stops naming what it built for exactly the spell this
  // slice introduced.
  process.stdout.write(`${spell}: built backend ${result.outputs.length} file(s) -> ${outdir}\n`);
  return 0;
}

/** Build one spell's surface into its ALREADY-CLEANED dist/. */
async function buildSurface(spell: string): Promise<number> {
  const entry = entryFor(spell);
  const outdir = outDirFor(spell);
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    plugins: [tailwind],
    // The HTML entry stays UNHASHED ("index.html") — server.ts's resolveMode()
    // (Contract 1) checks for that exact filename to detect release mode; a
    // hashed entry (index-<hash>.html) makes it invisible to that check and the
    // daemon silently stays in dev mode forever (caught live: booting against
    // such a dist/ served dev's /_bun/asset/* paths, not the built chunks).
    // Referenced chunks/assets keep the hash for cache-busting.
    naming: {
      entry: "[dir]/[name].[ext]",
      chunk: "[dir]/[name]-[hash].[ext]",
      asset: "[dir]/[name]-[hash].[ext]",
    },
  });

  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${log}\n`);
    process.stderr.write(`${spell}: build failed\n`);
    return 1;
  }

  for (const artifact of result.outputs) {
    process.stdout.write(`${artifact.path.replace(`${outdir}/`, "")} (${artifact.kind})\n`);
  }
  process.stdout.write(`${spell}: built ${result.outputs.length} file(s) -> ${outdir}\n`);
  return 0;
}

/**
 * Build every aspect a spell has, into ONE dist/.
 *
 * THE CLEAN HAPPENS ONCE, HERE, AND THAT ORDERING IS LOAD-BEARING. dist/ is
 * rm'd before any aspect builds, because hashed chunk names otherwise
 * accumulate stale siblings across builds. astrolabe is the first spell to
 * emit BOTH a surface and a backend into one directory - so a per-aspect clean
 * would have the second build delete the first one's output, and the failure
 * is SILENT: a dist/ holding index.html but no cli.js still serves a board,
 * and the CLI simply disappears. Clean once, then build each aspect present.
 */
async function buildSpell(spell: string): Promise<number> {
  if (!hasSurface(spell) && !hasBackend(spell)) {
    // Name what was looked for AND what would have worked - an unknown spell
    // is the one failure this script can fully explain.
    process.stderr.write(
      `build: nothing to build for "${spell}"\n` +
        `       looked for ${entryFor(spell)}\n` +
        `       and ${backendEntryFor(spell)}\n` +
        `       buildable spells: ${buildableSpells().join(", ") || "(none)"}\n`,
    );
    return 1;
  }
  rmSync(outDirFor(spell), { recursive: true, force: true });
  let code = 0;
  if (hasSurface(spell)) code = (await buildSurface(spell)) || code;
  if (hasBackend(spell)) code = (await buildBackend(spell)) || code;
  return code;
}

async function main(argv: string[]): Promise<number> {
  const spells = argv.length > 0 ? argv : buildableSpells();
  // ZERO-GUARD on the population, not on the finding: a discovery walk that
  // found nothing would build nothing, exit 0, and read exactly like a clean
  // build of an up-to-date tree.
  if (spells.length === 0) {
    process.stderr.write(`build: no buildable spells found under ${SRC_DIR}\n`);
    return 1;
  }
  let code = 0;
  for (const spell of spells) {
    code = (await buildSpell(spell)) || code;
  }
  return code;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}

export { buildableSpells, buildBackend, buildSpell, buildSurface, main };
