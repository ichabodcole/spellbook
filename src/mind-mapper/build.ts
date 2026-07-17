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

async function main(): Promise<number> {
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

  for (const artifact of result.outputs) {
    process.stdout.write(`${artifact.path.replace(`${OUTDIR}/`, "")} (${artifact.kind})\n`);
  }
  process.stdout.write(`mind-mapper: built ${result.outputs.length} file(s) -> ${OUTDIR}\n`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}

export { main };
