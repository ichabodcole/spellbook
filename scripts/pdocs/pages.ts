// Every document in the tree, read once, as data.
//
// This is the substrate the READ commands stand on — `graph`, `find`,
// `backlinks` — and it deliberately covers BOTH TIERS.
//
// The obvious alternative was to build them on `graphTier`, which already
// returns a knowledge graph. It walks the library only: `.project-docs.json`
// puts `projects`, `cycles`, `backlog`, `briefs`, `investigations`, `reports`
// and `fragments` in `nonPageDirs`, because the graph obligations — catalog
// reachability, `related` resolution — are library obligations. But the
// questions this cycle exists to answer are "what is in the active cycle" and
// "which proposals claim `implemented` and are lying", and both of those live
// in the workbench. A `find` built on `graphTier` would answer
// `--type proposal` with silence, which is a worse failure than not shipping
// the command: an empty result reads as an answer.
//
// So the tier is a FIELD here, not a filter. `orphans` is the one read command
// that stays on `graphTier`, because orphan-ness is defined against a catalog
// and only the library has one.
//
// Nothing in this file reports a problem. The parsers it borrows are the lint's
// — `parseFrontmatter`, `yamlList`, `parseGenerated`, `checkLinks` — so a
// document reads the same way here as it does at the gate, and a second
// frontmatter regex can never disagree with the first. `checkLinks` also
// returns the links that did NOT resolve; those are discarded, because a broken
// link is the lint's finding and reporting it twice in two vocabularies is how
// a caller ends up fixing it in the wrong place.

import { readFileSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import {
  checkLinks,
  parseFrontmatter,
  parseGenerated,
  yamlList,
} from "./docs-lint/index.ts";
import {
  CONTRACT_BASENAMES,
  type Ctx,
  templateTest,
  libraryFiles,
  workbenchFiles,
} from "./lint/rules.ts";
import { PROJECTS_FOLDER, TYPE_ALIAS } from "./lint/registry.ts";

/** One document, flattened. Every field is either frontmatter as written or
 *  something derived from the file's position — nothing here is a judgement. */
export interface Page {
  /** Repo-relative, e.g. `docs/projects/foo/proposal.md`. The only path
   *  vocabulary any read command speaks, so a `find` result can be handed
   *  straight back to `backlinks`. */
  path: string;
  tier: "library" | "workbench";
  /** The type the document's POSITION says it carries; `""` when its folder
   *  declares none. Not the `type:` field — a document whose frontmatter
   *  disagrees with its folder is a lint finding, and querying by the value the
   *  document claims for itself would hide exactly those. */
  type: string;
  title: string | null;
  description: string | null;
  status: string | null;
  lifecycle: string | null;
  tags: string[];
  /** Raw `type/slug` entries, as written. Unresolved on purpose: whether an
   *  edge points at a real page is the lint's question. */
  related: string[];
  /** `generated.at`, `YYYY-MM-DD`. */
  date: string | null;
  /** Repo-relative `.md` targets that resolve. Deduplicated and sorted. */
  linksOut: string[];
}

/**
 * Every document in the tree, sorted by path.
 *
 * Sorted because the output is a machine surface: two runs over an unchanged
 * tree must produce byte-identical JSON, and `readdirSync` order is not a
 * promise anybody made. The comparison is plain `<` rather than
 * `localeCompare` — a locale-sensitive collation is exactly the thing that
 * differs between the developer's machine and CI.
 *
 * Templates and contract pages are skipped, on the same terms as
 * `libraryFieldChecks`: a template's frontmatter is a form and its links are
 * placeholders, and a README/AGENTS/SCHEMA page is a document ABOUT the tree
 * rather than an entry in it.
 */
export function collectPages(ctx: Ctx): Page[] {
  const files = [
    ...libraryFiles(ctx).map((f) => ({ ...f, tier: "library" as const })),
    ...workbenchFiles(ctx).map((f) => ({ ...f, tier: "workbench" as const })),
  ];

  // `libraryFiles` already skips every workbench folder, so the two walks are
  // disjoint today. The guard is here anyway: the folder lists are user
  // configuration, and one folder named in both would otherwise produce a
  // document that exists twice with two different tiers.
  const seen = new Set<string>();
  // One anchor cache across the whole walk. `checkLinks` reads a link target to
  // slug its headings, and the hub pages of a documentation tree are read by
  // nearly every other page.
  const anchorCache = new Map<string, Set<string>>();
  const pages: Page[] = [];

  const isTpl = templateTest(ctx);
  for (const file of files) {
    if (CONTRACT_BASENAMES.has(basename(file.path)) || isTpl(file.path))
      continue;
    if (seen.has(file.path)) continue;
    seen.add(file.path);

    const raw = readFileSync(file.path, "utf8");
    const m = /^---\n([\s\S]*?)\n---/.exec(raw);
    const fields = m
      ? parseFrontmatter(m[1] as string)
      : new Map<string, string>();

    const linksOut = [
      ...new Set(
        checkLinks(file.path, raw, { anchorCache }).outbound.map((p) =>
          relative(ctx.repoRoot, p)
        )
      ),
    ].sort();

    pages.push({
      path: file.rel,
      tier: file.tier,
      type: file.type,
      title: fields.get("title") ?? null,
      description: fields.get("description") ?? null,
      status: fields.get("status") ?? null,
      lifecycle: fields.get("lifecycle") ?? null,
      tags: yamlList(fields.get("tags")),
      related: yamlList(fields.get("related")),
      date: parseGenerated(fields.get("generated"))?.at ?? null,
      linksOut,
    });
  }

  return pages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * `type/slug` — the key `related:` edges are written in, per SCHEMA.md. `slug`
 * is the basename without `.md`, so a page can move between folders without
 * every edge pointing at it having to be rewritten.
 *
 * `null` for a document whose folder declares no type: there is no key to write
 * and pretending there is one would invent an edge nothing can resolve.
 */
export function pageKey(page: Page): string | null {
  return page.type ? `${page.type}/${basename(page.path, ".md")}` : null;
}

/**
 * `project/<folder>` — how a PROJECT is addressed, which `type/slug` cannot do.
 *
 * `type/slug` is a library-tier scheme and SCHEMA.md says so: `related:` edges
 * "are resolved against library pages only". It works there because a library
 * page's basename is its own name. Extending it to the workbench broke on the
 * project folder, where every type has a FIXED filename — so `pageKey` answers
 * `proposal/proposal` for every project in the tree. That key names all of them
 * and identifies none, and it is the only string `pdocs new cycle --scope`
 * would accept: the documented `--scope project/oauth-upgrade` matched nothing.
 *
 * A project's name is its FOLDER, so that is what this keys on. The vocabulary
 * is not invented here — `TYPE_ALIAS` already spells it `project` for
 * `pdocs new project <name>`, `docs/cycles/TEMPLATE.md` writes `scope:` entries
 * as `project/[project-name]`, and the migration guide says the same. This
 * makes the tool agree with all three.
 *
 * It is NOT a `related:` key and must not become one: `related:` still resolves
 * against library pages only, and the thin tier does not resolve it at all.
 * This is an ADDRESS a caller may type — for `--scope` and for `backlinks` —
 * which is why it lives beside `pageKey` rather than inside it.
 */
export function pageAliasKeys(page: Page): string[] {
  const keys: string[] = [];
  for (const [name, alias] of Object.entries(TYPE_ALIAS)) {
    if (!alias.namesScope || page.type !== alias.type) continue;
    // `<docsRoot>/projects/<folder>/<fixed name>.md` — the folder is the
    // parent, and the grandparent proves this really is the project tree
    // rather than a same-named type somewhere else.
    const folder = basename(dirname(page.path));
    if (folder && basename(dirname(dirname(page.path))) === PROJECTS_FOLDER)
      keys.push(`${name}/${folder}`);
  }
  return keys;
}

/** Every address a page answers to: its `type/slug` key, plus any alias. */
export function pageKeys(page: Page): string[] {
  const key = pageKey(page);
  return [...(key === null ? [] : [key]), ...pageAliasKeys(page)];
}

/** `linksOut` inverted across the collection: path -> the paths that link to
 *  it, sorted. Every page gets an entry, including the ones nothing cites. */
export function linksInIndex(pages: Page[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const page of pages) index.set(page.path, []);
  for (const page of pages)
    for (const target of page.linksOut) index.get(target)?.push(page.path);
  for (const list of index.values()) list.sort();
  return index;
}
