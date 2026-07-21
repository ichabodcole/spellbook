#!/usr/bin/env bun

// P4.1 — release-mode build (seams Contract 2). Run with root deps
// (`bun run src/mind-mapper/build.ts`, no per-spell package.json): bundles
// the surface into a flat, hashed, dependency-free dist/ at the DEPLOYED
// spell folder (plugins/spellbook/skills/mind-mapper/dist/), so the
// published plugin can serve a working board with no surface/ source, no
// bunfig.toml, and no node_modules present (Contract 4's "source-free by
// construction"). Backend ships as source (Contract 3) — this script only
// ever touches the surface.
//
// The Tailwind plugin is passed explicitly here (not read off bunfig.toml,
// which only wires Bun's dev SERVE path) — same plugin, both modes, no
// second toolchain (Contract 2).

// Round 4 (B1): clean → build → stamp. dist/ is rm'd before every build
// (hashed chunk names otherwise ACCUMULATE stale siblings across builds),
// and a successful build writes dist/build.json {commit, builtAt} — the
// stamp server.ts reads once at boot in release mode to log provenance and
// detect a stale dist against a live src tree.

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";

const SCRIPT_DIR = import.meta.dir;
const ENTRY = join(SCRIPT_DIR, "surface", "index.html");
const OUTDIR = join(
  SCRIPT_DIR,
  "..",
  "..",
  "plugins",
  "spellbook",
  "skills",
  "mind-mapper",
  "dist",
);

// Best-effort commit stamp — "unknown" is tolerated (a tarball build has no
// .git; the stamp still dates the dist).
function currentCommit(): string {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: SCRIPT_DIR });
    const out = proc.stdout.toString().trim();
    return proc.exitCode === 0 && out !== "" ? out : "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<number> {
  rmSync(OUTDIR, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir: OUTDIR,
    plugins: [tailwind],
    // The HTML entry stays UNHASHED ("index.html") — server.ts's
    // resolveMode() (Contract 1) checks for that exact filename to detect
    // release mode; a hashed entry (index-<hash>.html) makes it invisible to
    // that check and the daemon silently stays in dev mode forever (caught
    // live: booting against this dist/ served dev's /_bun/asset/* paths,
    // not the built chunks). Referenced chunks/assets keep the hash for
    // cache-busting.
    naming: {
      entry: "[dir]/[name].[ext]",
      chunk: "[dir]/[name]-[hash].[ext]",
      asset: "[dir]/[name]-[hash].[ext]",
    },
  });

  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${log}\n`);
    process.stderr.write("mind-mapper: build failed\n");
    return 1;
  }

  // The stamp lands AFTER a successful build only — a failed build leaves no
  // dist/ (rm'd above), so a half-built tree can never wear a fresh stamp.
  const stamp = { commit: currentCommit(), builtAt: new Date().toISOString() };
  writeFileSync(join(OUTDIR, "build.json"), `${JSON.stringify(stamp, null, 2)}\n`);

  for (const artifact of result.outputs) {
    process.stdout.write(`${artifact.path.replace(`${OUTDIR}/`, "")} (${artifact.kind})\n`);
  }
  process.stdout.write(
    `mind-mapper: built ${result.outputs.length} file(s) -> ${OUTDIR} (${stamp.commit} @ ${stamp.builtAt})\n`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}

export { main };
