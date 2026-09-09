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
// present (Contract 4's "source-free by construction").
//
// ⚠ CORRECTED 2026-09-04. This header read "Backend ships as source (Contract
// 3) — this script only ever touches the surface" while `buildBackend()` sat 75
// lines below it emitting `dist/cli.js`. It described the file before Slice 2
// and nothing re-read it after. **This script builds BOTH:** a spell's surface
// always, and every BACKEND ENTRY it has — see `backendEntryNames` below for
// what makes a module an entry. Under Contract 3 as amended 2026-09-04, a
// backend builds when it imports from outside its own deployed skill folder;
// source remains the default for a backend that shares nothing.
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

/** The one specifier a daemon build leaves unresolved. Named once so the flag,
 *  the source comment and any future consumer cannot drift apart. */
const SURFACE_HTML_EXTERNAL = "*/surface/index.html";

const entryFor = (spell: string) => join(SRC_DIR, spell, "surface", "index.html");
const backendDirFor = (spell: string) => join(SRC_DIR, spell, "backend");
const backendEntryFor = (spell: string, name: string) => join(backendDirFor(spell), `${name}.ts`);
const launcherFor = (spell: string, name: string) =>
  join(DEPLOY_ROOT, spell, "scripts", `${name}.ts`);
const outDirFor = (spell: string) => join(DEPLOY_ROOT, spell, "dist");

const hasSurface = (spell: string) => existsSync(entryFor(spell));

/**
 * **A backend entry is `src/<spell>/backend/X.ts` for which a launcher
 * `plugins/spellbook/skills/<spell>/scripts/X.ts` exists.** (D43, ruled
 * 2026-09-09.)
 *
 * ⛔ THIS FUNCTION REPLACED TWO HARD-CODED NAMES, AND THE ROSTER IS WHY. Until
 * 2026-09-09 the entries were `backendEntryFor` = `backend/cli.ts` and
 * `serverEntryFor` = `backend/server.ts`, spelled as two constants and built by
 * two near-duplicate `Bun.build` calls. Measured across the whole roster before
 * bounty's port, that assumption is wrong for **three of the four remaining
 * ports, in three different ways**: bounty has a THIRD caller-facing entry
 * (`join.ts`, named twice in its SKILL.md), digestify has `review.ts` and NO
 * `cli.ts` at all (so the old code built nothing for it), and grapevine's
 * daemon is `daemon.ts` with no `server.ts`. Two names could not describe the
 * roster, and the duplication between the two build calls is what made a third
 * name unthinkable.
 *
 * **The launcher is the deployed contract, so it is the honest source of the
 * entry set.** It sits at a fixed path, it is what SKILL.md tells an agent to
 * spawn, it is what `grimoire/lib/entry-points.ts` enumerates and what
 * `exit-site-inventory` and `terminator-invariant` pin. So the entry set is a
 * FACT ABOUT THE TREE rather than a list anyone maintains — the same principle
 * `buildableSpells()` already follows, and the same principle three instrument
 * defects in this project (D36, D42 and its two siblings) came from violating.
 *
 * **Non-entry modules are excluded for free.** `reduce.ts`, `state.ts`,
 * `heartbeat.ts`, every `*.server.ts` and every test file have no launcher, so
 * they are not entries and never become one by being renamed. No naming
 * convention, no exclusion list.
 *
 * ⚠ THE CONVERSE IS NOT ASSERTED HERE. A launcher with no backend module of
 * that name is not this function's problem — `mind-mapper/scripts/cli.ts` is a
 * real unported CLI, not a launcher, and `astrolabe/scripts/state.ts` is a
 * two-sided module. **`grimoire/launcher-pairing-ward.test.ts` is what checks
 * the pairing in both directions**; this function only answers "what does the
 * build emit".
 */
function backendEntryNames(spell: string): string[] {
  const dir = backendDirFor(spell);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => f.slice(0, -".ts".length))
    .filter((name) => existsSync(launcherFor(spell, name)))
    .sort();
}

const hasBackend = (spell: string) => backendEntryNames(spell).length > 0;

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
 * Build ONE backend entry (seams Contract 4's built-backend amendment, ruled
 * 2026-08-31; generalised past two fixed names by D43). Returns an exit code.
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
 * ⚠ CORRECTED 2026-09-08 (Phase 1b, D6). This block read "CLIs ONLY. A server
 * does bundle, but drags the entire surface graph into the backend artifact;
 * that is unruled and out of scope. Do not add server.ts."
 *
 * ⛔ THE `external` IS WHY A DAEMON CAN BUILD AT ALL, AND IT IS NOT A TIDINESS
 * FLAG — this is the measurement that used to live on the separate
 * `buildServer` this function absorbed. A daemon's dev branch does
 * `await import(".../surface/index.html")`, and with no `external` the bundler
 * FOLLOWS it, resolves the whole .tsx + Tailwind graph, and fails compiling
 * `@import "tailwindcss" source(none)`. D6 measured `--external` on the
 * surface-HTML glob (spelled once, at `SURFACE_HTML_EXTERNAL` above — a `*`
 * then a slash then `surface/index.html`; ⛔ IT CANNOT BE WRITTEN LITERALLY
 * INSIDE A BLOCK COMMENT, because those two characters CLOSE one. This build
 * failed exactly that way once, which is principles.md #2 live inside the file
 * that introduces the flag) as the remedy: that ONE specifier survives into the
 * artifact **BYTE-FOR-BYTE**, which means the specifier written in the source
 * is resolved at runtime relative to `dist/`, NOT relative to the source file.
 * See the block above that specifier in each daemon source; getting it wrong is
 * silent in release mode, which never executes the line. The pattern is safe
 * because the import sits behind `mode === "dev"` and a published artifact
 * resolves to release by `dist/index.html`'s presence.
 *
 * ⚠ THE FLAG IS PASSED FOR EVERY ENTRY, NOT ONLY DAEMONS, and that is what
 * makes one function possible. An entry that never imports the surface HTML has
 * no such specifier to leave external, so the flag is inert for it — measured
 * as the acceptance criterion of the D43 refactor: rebuilding the whole roster
 * with this one call in place of the old two left a `git diff` restricted to
 * the deployed dist folders EMPTY. Same bytes, different derivation. (⛔ That
 * pathspec is not written literally here for the reason two paragraphs up: a
 * doubled star followed by a slash CLOSES this comment.)
 *
 * ⛔ ONE `Bun.build` CALL PER ENTRY. This is a LOOP over entries, never one
 * call with several entrypoints, and that is deliberate: one call with two
 * entrypoints hoists whatever the entries share into a hashed common chunk,
 * which rewrites the OTHER entries' artifacts — a byte change in artifacts the
 * change did not touch, and Contract 18 verifies by reproduction.
 */
async function buildBackendEntry(spell: string, name: string): Promise<number> {
  const outdir = outDirFor(spell);
  const result = await Bun.build({
    entrypoints: [backendEntryFor(spell, name)],
    outdir,
    target: "bun",
    sourcemap: "inline",
    external: [SURFACE_HTML_EXTERNAL],
    // An entry naming of [name].[ext] off an `X.ts` entry emits exactly `X.js`,
    // which is the literal path the launcher at `scripts/X.ts` imports - so
    // this naming is load-bearing, not a free choice.
    naming: { entry: "[dir]/[name].[ext]", chunk: "[dir]/[name]-[hash].[ext]" },
  });

  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${log}\n`);
    process.stderr.write(`${spell}: backend build failed for entry ${name}\n`);
    return 1;
  }

  for (const artifact of result.outputs) {
    process.stdout.write(`${artifact.path.replace(`${outdir}/`, "")} (backend ${artifact.kind})\n`);
  }
  // Its own summary line: a backend-ONLY spell (magpie) never reaches the
  // surface summary, so without this it reports one bare filename and no spell
  // name - the build log stops naming what it built for exactly the spell this
  // slice introduced.
  process.stdout.write(
    `${spell}: built backend ${name} ${result.outputs.length} file(s) -> ${outdir}\n`,
  );
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
  const entries = backendEntryNames(spell);
  if (!hasSurface(spell) && entries.length === 0) {
    // Name what was looked for AND what would have worked - an unknown spell
    // is the one failure this script can fully explain. The backend half names
    // the RULE rather than two filenames, because the rule is what changed:
    // there is no fixed list of entry names to print.
    process.stderr.write(
      `build: nothing to build for "${spell}"\n` +
        `       looked for ${entryFor(spell)}\n` +
        `       and any ${backendDirFor(spell)}/X.ts whose launcher ${launcherFor(spell, "X")} exists\n` +
        `       buildable spells: ${buildableSpells().join(", ") || "(none)"}\n`,
    );
    return 1;
  }
  rmSync(outDirFor(spell), { recursive: true, force: true });
  let code = 0;
  if (hasSurface(spell)) code = (await buildSurface(spell)) || code;
  for (const name of entries) code = (await buildBackendEntry(spell, name)) || code;
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

export {
  backendEntryNames,
  buildableSpells,
  buildBackendEntry,
  buildSpell,
  buildSurface,
  launcherFor,
  main,
};
