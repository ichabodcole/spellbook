import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The git working tree `dir` is in, or null. A `.git` ENTRY, not a directory
 * test: a worktree and a submodule both have `.git` as a FILE.
 */
export function gitRootOf(dir: string): string | null {
  let at = dir;
  for (;;) {
    if (existsSync(join(at, ".git"))) return at;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}
