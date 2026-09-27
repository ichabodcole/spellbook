// Move a document or a folder of documents, and rewrite every link that the
// move would break — the one path `promote` and `archive` share (plan D15).
//
// The files whose links are rewritten are every markdown file under the docs
// root, plus every tracked markdown file outside it that the lint also reads
// (`lint.exclude` taken out). That is wider than the link index `pages.ts`
// builds, on purpose: that index skips READMEs and templates, and a README
// linking the moved item is exactly the link the next `pdocs check` would
// report broken.
//
// Nothing is written until every new text has been computed and the
// destination is known to be free, so a refusal leaves the tree as it was.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { walkMarkdown } from "./docs-lint/index.ts";
import { trackedMarkdown } from "./docs-lint/unlinted-links.ts";
import { ConflictError } from "./envelope.ts";
import { movedTo, rewriteFromField, rewriteLinks } from "./links-rewrite.ts";
import { type Ctx, excluder, gitEnv } from "./lint/rules.ts";

export interface MoveResult {
  /** Repo-relative, before and after. */
  from: string;
  to: string;
  /** Repo-relative paths (after the move) of every file whose links changed. */
  rewritten: string[];
  /** How many links were respelled, in all of them. */
  links: number;
}

/** Every markdown file whose links a move may break, absolute and deduplicated. */
function linkingFiles(ctx: Ctx): string[] {
  const excluded = excluder(ctx);
  const inside = walkMarkdown(ctx.docsRoot);
  const docsPrefix = `${relative(ctx.repoRoot, ctx.docsRoot)}/`;
  const outside = trackedMarkdown(ctx.repoRoot, gitEnv())
    .filter((p) => !p.startsWith(docsPrefix) && !excluded(p))
    .map((p) => join(ctx.repoRoot, p))
    .filter((p) => existsSync(p));
  return [...new Set([...inside, ...outside])].sort();
}

/**
 * Move `from` to `to` (absolute; a file or a folder) and rewrite the links.
 * Throws `ConflictError`, writing nothing, when `to` already exists.
 */
export function moveAndRewrite(ctx: Ctx, from: string, to: string): MoveResult {
  const rel = (p: string) => relative(ctx.repoRoot, p);
  if (existsSync(to))
    throw new ConflictError(`${rel(to)} already exists — pdocs will not move ${rel(from)} over it.`);

  const moveMap = new Map([[from, to]]);
  const edits: Array<{ path: string; text: string; changed: number }> = [];
  for (const file of linkingFiles(ctx)) {
    const target = movedTo(file, moveMap);
    const r = rewriteLinks(readFileSync(file, "utf8"), file, target, moveMap, existsSync);
    // A path-form `from:` (D6) is a link too, written in frontmatter.
    const f = rewriteFromField(r.text, ctx.docsRoot, moveMap);
    const changed = r.changed + f.changed;
    if (changed > 0) edits.push({ path: target, text: f.text, changed });
  }

  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  for (const e of edits) writeFileSync(e.path, e.text);

  return {
    from: rel(from),
    to: rel(to),
    rewritten: edits.map((e) => rel(e.path)).sort(),
    links: edits.reduce((n, e) => n + e.changed, 0),
  };
}
