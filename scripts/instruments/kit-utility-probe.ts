#!/usr/bin/env bun

// Builds ONE spell's surface into a throwaway outdir and prints the emitted CSS
// path. Exists to be spawned with a CHOSEN CWD, because that is the variable
// under test.
//
// ⛔ WHY A SUBPROCESS AND NOT A FUNCTION CALL. Tailwind v4's automatic content
// detection roots at the PROCESS CWD (measured 2026-08-31). cwd is per-process,
// so the only way to build "as the dev daemon would" is to spawn. seams
// Contract 5 pins the dev daemon's cwd to `src/<spell>/`; `bun run build` runs
// from the repo root. Those two roots see DIFFERENT trees, and `src/kit/` falls
// on only one side of the line.
//
// Never writes into a deployed `dist/` — the outdir is always given by the
// caller, so a crashed probe cannot leave a shipped artifact half-built.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const [spell, outdir] = process.argv.slice(2);
if (!spell || !outdir) {
  console.error("usage: kit-utility-probe.ts <spell> <outdir>");
  process.exit(2);
}

const entry = join(REPO_ROOT, "src", spell, "surface", "index.html");
if (!existsSync(entry)) {
  console.error(`no surface entry for "${spell}" at ${entry}`);
  process.exit(2);
}

const result = await Bun.build({
  entrypoints: [entry],
  outdir,
  plugins: [tailwind],
  naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]", asset: "asset-[hash].[ext]" },
});
if (!result.success) {
  for (const l of result.logs) console.error(String(l));
  process.exit(1);
}

const css = readdirSync(outdir).filter((f) => f.endsWith(".css"));
// A build that emitted no CSS at all must not read as "the utility is missing"
// — that is a different failure and the caller has to be able to tell them
// apart (the outcome-contract's third state: no envelope, not a bad one).
if (css.length === 0) {
  console.error("build produced NO css file");
  process.exit(1);
}
console.log(JSON.stringify({ cwd: process.cwd(), css: css.map((f) => join(outdir, f)) }));
