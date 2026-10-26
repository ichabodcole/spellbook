// enforces: none in house-style — seams Contract 4 as re-ruled 2026-10-14 (item shrink-shipped-dist): no shipped bundle carries a source map
//
// ⛔ THE WARD FOR A SOURCE MAP COMING BACK INTO A SHIPPED `dist/`.
//
// Until the shrink-shipped-dist item, every backend bundle was built with
// `sourcemap: "inline"` — Cole's 2026-08-31 ruling, made knowing it embedded the
// complete original TypeScript. Cole reversed it on 2026-10-14: the source is in
// the repo, so it does not ship inside the skills. Measured at the change, the
// inline maps were 10.39 MB of the 23.19 MB of shipped JS (44.8%).
//
// Nothing else would notice a map coming back. The bundles still run, every
// wards that reads them as text still finds what it looks for, and dist-check
// only asks whether the committed bundle reproduces — a map built on purpose
// reproduces perfectly. So this ward reads every file in every deployed `dist/`
// and fails on:
//
//   1. a `sourceMappingURL` directive of ANY kind — inline (`data:`) embeds the
//      source; a linked one names a `.map` that is not shipped, or is;
//   2. a `.map` file in `dist/` at all — written beside the bundle, it is one
//      `.gitignore` line from shipping and already inside the served directory.
//
// The population is EVERY `plugins/*/skills/*/dist/` on the DISK, not the
// build's roster: a dist/ the roster does not know (a spell whose source moved,
// a hand-copied artifact, a new plugin) still ships if it is tracked, so it is
// still this ward's subject. The roster is asserted to be a subset of the walk.
// The disk rather than the index because the gate builds before it tests: a map
// the build just emitted is on disk before anyone stages it.
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildableSpells } from "../src/build.ts";
import { distDirFor, REPO_ROOT } from "./lib/dist-artifacts.ts";

/** The directive as a line comment (JS) or a block comment (CSS), `#` or the
 *  legacy `@`. Anchored to a comment opener so a string that merely MENTIONS the
 *  word in a bundle's code is not a finding. */
const DIRECTIVE = /(?:\/\/|\/\*)\s*[#@]\s*sourceMappingURL\s*=/;

function walk(dir: string, out: string[]): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Every `plugins/<plugin>/skills/<skill>/dist` directory that exists on disk,
 *  absolute and sorted. */
export function deployedDists(root: string = REPO_ROOT): string[] {
  const out: string[] = [];
  const plugins = join(root, "plugins");
  for (const plugin of readdirSync(plugins, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const skills = join(plugins, plugin.name, "skills");
    if (!existsSync(skills)) continue;
    for (const skill of readdirSync(skills, { withFileTypes: true })) {
      const dist = join(skills, skill.name, "dist");
      if (skill.isDirectory() && existsSync(dist)) out.push(dist);
    }
  }
  return out.sort();
}

/** Every source-map finding under one `dist/`, as `<path>: <why>` lines. */
export function sourceMapFindings(dist: string): { files: number; findings: string[] } {
  const files = walk(dist, []);
  const findings: string[] = [];
  for (const f of files) {
    if (f.endsWith(".map")) {
      findings.push(`${f}: a .map file in dist/`);
      continue;
    }
    if (!/\.(js|mjs|cjs|css|html)$/.test(f)) continue;
    const m = DIRECTIVE.exec(readFileSync(f, "utf8"));
    if (m) findings.push(`${f}: carries a sourceMappingURL directive (${m[0]})`);
  }
  return { files: files.length, findings };
}

describe("no shipped source map", () => {
  test("calibration — the detector fires on each planted form and stays quiet on a mention", () => {
    const root = mkdtempSync(join(tmpdir(), "sourcemap-ward-"));
    try {
      const dist = join(root, "dist");
      mkdirSync(join(dist, "sub"), { recursive: true });
      writeFileSync(join(dist, "clean.js"), 'const s = "sourceMappingURL";\n');
      writeFileSync(
        join(dist, "inline.js"),
        "x();\n//# sourceMappingURL=data:application/json;base64,e30=\n",
      );
      writeFileSync(join(dist, "linked.js"), "x();\n//# sourceMappingURL=linked.js.map\n");
      writeFileSync(join(dist, "sub", "style.css"), "a{}\n/*# sourceMappingURL=style.css.map */\n");
      writeFileSync(join(dist, "linked.js.map"), "{}");
      const { files, findings } = sourceMapFindings(dist);
      expect(files).toBe(5);
      expect(findings.map((f) => relative(dist, f.split(":")[0] as string)).sort()).toEqual([
        "inline.js",
        "linked.js",
        "linked.js.map",
        "sub/style.css",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no deployed dist/ carries a source map, inline or linked", () => {
    const dists = deployedDists();
    // ZERO-GUARD ON THE POPULATION: no dist/ found, or dists that hold nothing,
    // would pass every assertion below over nothing.
    expect(dists.length).toBeGreaterThan(0);
    // The roster is a SUBSET of the disk walk, never the population: a spell
    // the build knows must not be missing from what this ward reads.
    const walked = new Set(dists);
    expect(buildableSpells().filter((s) => !walked.has(distDirFor(s)))).toEqual([]);
    let examined = 0;
    const all: string[] = [];
    const rows: string[] = [];
    for (const dist of dists) {
      const { files, findings } = sourceMapFindings(dist);
      examined += files;
      rows.push(`${relative(REPO_ROOT, dist)} ${files} file(s) ${findings.length} map(s)`);
      all.push(...findings.map((f) => relative(REPO_ROOT, f)));
    }
    console.log(`no-shipped-sourcemap: ${rows.join(" · ")}`);
    expect(examined).toBeGreaterThan(dists.length);
    expect(all).toEqual([]);
  });
});
