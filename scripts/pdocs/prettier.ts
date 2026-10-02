// The project's own Prettier, when it has one — never a downloaded one.
//
// `pdocs` has no dependencies and formats nothing on its own. But a command
// that rewrites a link in a file it did not write (promote, archive) changes a
// line's length, and in a project that formats its Markdown with Prettier the
// paragraph around that link no longer wraps the way Prettier wraps it: the
// next `prettier --check` fails on a file the person never touched. So the
// rewritten text goes through the project's Prettier — its version, its
// config, its ignore files — exactly as its own formatter would print it.
//
// The child runs under `bun --no-install`: a project with no Prettier gets
// none, rather than Bun fetching one from npm.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitEnv } from "./lint/rules.ts";

/**
 * Reads `{ root, ignores, items: [{ path, text }] }` on stdin and prints, as
 * its last line, `{ out }`: each text as Prettier prints it at its path, or
 * null where Prettier ignores the path, infers no Markdown parser, or fails.
 * Prettier 3's CLI reads `.gitignore` and `.prettierignore`; Prettier 2 reads
 * only `.prettierignore`, and its API takes one path.
 */
const CHILD = `
const { createRequire } = require("node:module");
const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const out = input.items.map(() => null);
let prettier = null;
try { prettier = createRequire(input.root + "/package.json")("prettier"); } catch {}
if (prettier) {
  const major = parseInt(String(prettier.version || "0"), 10);
  const ignorePath = major >= 3
    ? (input.ignores.length ? input.ignores : undefined)
    : input.ignores.find((p) => p.endsWith(".prettierignore"));
  for (const [i, { path, text }] of input.items.entries()) {
    try {
      const info = await prettier.getFileInfo(path, ignorePath ? { ignorePath } : {});
      if (info.ignored || info.inferredParser !== "markdown") continue;
      const config = (await prettier.resolveConfig(path, { editorconfig: true })) || {};
      out[i] = await prettier.format(text, { ...config, filepath: path });
    } catch {}
  }
}
console.log(JSON.stringify({ out }));
`;

/**
 * How long the project's Prettier gets before the move goes ahead without it.
 * A config is code (`prettier.config.cjs`), and one that never returns must not
 * hang `promote`, `archive` or `new --owner`. `PDOCS_PRETTIER_TIMEOUT_MS`
 * overrides it, so a test can prove the fallback without waiting this long.
 */
const TIMEOUT_MS = 30_000;

function timeoutMs(): number {
  const n = Number(process.env.PDOCS_PRETTIER_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : TIMEOUT_MS;
}

/** Whether `prettier` resolves from `root`, the way Node resolves a package. */
function hasPrettier(root: string): boolean {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules/prettier/package.json"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/**
 * Each `text` as the project's own Prettier prints it at `path` (absolute; it
 * need not exist yet), or null for that item where Prettier would leave it
 * alone. All null when the project has no Prettier, or the child could not run
 * or did not finish within the timeout:
 * formatting is the project's, and its absence is not an error. Writes nothing.
 */
export function projectPrettier(
  repoRoot: string,
  items: ReadonlyArray<{ path: string; text: string }>
): Array<string | null> {
  const none = items.map(() => null);
  if (items.length === 0 || !hasPrettier(repoRoot)) return none;
  const ignores = [".gitignore", ".prettierignore"]
    .map((f) => join(repoRoot, f))
    .filter((f) => existsSync(f));
  const r = Bun.spawnSync([process.execPath, "--no-install", "-e", CHILD], {
    cwd: repoRoot,
    stdin: Buffer.from(JSON.stringify({ root: repoRoot, ignores, items })),
    stdout: "pipe",
    stderr: "pipe",
    env: gitEnv(),
    timeout: timeoutMs(),
  });
  // A child killed at the timeout has no exit code of 0: nothing is formatted.
  if (r.exitCode !== 0) return none;
  try {
    const { out } = JSON.parse(r.stdout.toString().trim().split("\n").pop() ?? "");
    return Array.isArray(out) && out.length === items.length ? out : none;
  } catch {
    return none;
  }
}
