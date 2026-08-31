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
const outDirFor = (spell: string) => join(DEPLOY_ROOT, spell, "dist");

/** A spell is buildable iff `src/<spell>/surface/index.html` exists. Derived
 *  from the tree rather than from a hand-kept list, so relocating a spell is
 *  the only step needed to put it in the build. */
function buildableSpells(): string[] {
  return readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(entryFor(e.name)))
    .map((e) => e.name)
    .sort();
}

/** Build one spell's surface. Returns a process exit code. */
async function buildSpell(spell: string): Promise<number> {
  const entry = entryFor(spell);
  if (!existsSync(entry)) {
    // Name what was looked for AND what would have worked — an unknown spell
    // is the one failure this script can fully explain.
    process.stderr.write(
      `build: no surface for "${spell}" (looked for ${entry})\n` +
        `       buildable spells: ${buildableSpells().join(", ") || "(none)"}\n`,
    );
    return 1;
  }
  const outdir = outDirFor(spell);

  rmSync(outdir, { recursive: true, force: true });
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

export { buildableSpells, buildSpell, main };
