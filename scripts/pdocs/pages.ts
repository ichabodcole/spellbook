// Every document in the tree, read once, as data.
//
// This is the substrate the READ commands stand on — `graph`, `find`,
// `backlinks` — and it deliberately covers BOTH TIERS.
//
// The obvious alternative was to build them on `graphTier`, which already
// returns a knowledge graph. It walks the library only: the workbench folders
// (`features`, `items`, `cycles`) are `nonPageDirs`, because the graph
// obligations — catalog reachability, `related` resolution — are library
// obligations. But the questions these commands answer — "what is in the
// active cycle", "which features claim `done`" — live in the workbench. A
// `find` built on `graphTier` would answer `--type feature` with silence,
// which is a worse failure than not shipping the command: an empty result
// reads as an answer.
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
import { basename, dirname, relative, sep } from "node:path";
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
import { ENTITY_FILE, FEATURES_FOLDER, ITEMS_FOLDER } from "./lint/registry.ts";

/** A frontmatter value with its surrounding quotes removed; `null` when absent. */
const unquoted = (v: string | undefined): string | null =>
  v === undefined || v === "" ? null : v.replace(/^(["'])(.*)\1$/, "$2");

/** One document, flattened. Every field is either frontmatter as written or
 *  something derived from the file's position — nothing here is a judgement. */
export interface Page {
  /** Repo-relative, e.g. `docs/features/foo/feature.md`. The only path
   *  vocabulary any read command speaks, so a `find` result can be handed
   *  straight back to `backlinks`. */
  path: string;
  /** The same path relative to the docs root, `/`-separated. Positions are
   *  read from this, so a folder that happens to share a name with an owner
   *  (`items/items/`) cannot be mistaken for one. */
  docsPath: string;
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
  /** A work item's `id`, as written (quotes removed); `null` elsewhere. */
  id: string | null;
  /** A work item's `kind`; `null` elsewhere. */
  kind: string | null;
  /** The work fields a `find` filters on, as written (quotes removed). */
  parent: string | null;
  cycle: string | null;
  scope: string | null;
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
      docsPath: relative(ctx.docsRoot, file.path).split(sep).join("/"),
      tier: file.tier,
      type: file.type,
      title: fields.get("title") ?? null,
      description: fields.get("description") ?? null,
      status: fields.get("status") ?? null,
      lifecycle: fields.get("lifecycle") ?? null,
      id: unquoted(fields.get("id")),
      kind: unquoted(fields.get("kind")),
      parent: unquoted(fields.get("parent")),
      cycle: unquoted(fields.get("cycle")),
      scope: unquoted(fields.get("scope")),
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
 * The addresses an entity answers to beyond `type/slug`: a feature or an item
 * by its slug — the folder, or a single-file item's own name — and an item by
 * its `id` (plan D6). A work entity's files have FIXED names (`feature.md`,
 * `item.md`), so `pageKey` alone would key every feature `feature/feature`.
 *
 * It is NOT a `related:` key and must not become one: `related:` still resolves
 * against library pages only. This is an ADDRESS a caller may type — for
 * `--owner`, `--parent`, `set` and `backlinks` — which is why it lives beside
 * `pageKey` rather than inside it.
 */
export function pageAliasKeys(page: Page): string[] {
  const keys: string[] = [];
  // The work taxonomy's entities are named by their slug — the folder, or a
  // single-file item's own name — wherever they sit, `_archive/` included, and
  // an item by its `id` as well (plan D6). The owner is the folder DIRECTLY
  // under the docs root, never a same-named folder further down.
  if (page.type === "feature" || page.type === "item") {
    const slug = entitySlug(page);
    if (slug) keys.push(`${page.type}/${slug}`);
    if (page.type === "item" && page.id) keys.push(`item/${page.id}`);
  }
  return keys;
}

/**
 * An entity's slug from its docs-root position: `items/<slug>.md`,
 * `items/<slug>/item.md` or `features/<slug>/feature.md`, with an optional
 * `_archive/` after the owner. `null` for anything else.
 */
function entitySlug(page: Page): string | null {
  const owner = page.type === "feature" ? FEATURES_FOLDER : ITEMS_FOLDER;
  const segs = page.docsPath.split("/");
  if (segs[0] !== owner) return null;
  let rest = segs.slice(1);
  if (rest[0] === "_archive" && rest.length > 1) rest = rest.slice(1);
  if (rest.length === 1 && page.type === "item")
    return basename(rest[0] as string, ".md");
  if (rest.length === 2 && rest[1] === ENTITY_FILE[owner]!.name)
    return rest[0] as string;
  return null;
}

/**
 * The document's slug: the half after `type/` in the reference a caller types.
 * A feature's or an item's is its entity slug — the folder, or a single-file
 * item's own name — and everything else's is its basename without `.md`.
 */
export function pageSlug(page: Page): string {
  return (
    ((page.type === "feature" || page.type === "item") && entitySlug(page)) ||
    basename(page.path, ".md")
  );
}

/** True for a folder entity's entry file, whose `type/slug` key would be
 *  `item/item` or `feature/feature` — a key every such entity shares. */
function isEntityEntryFile(page: Page): boolean {
  return (
    (page.type === "feature" || page.type === "item") &&
    basename(page.path) === ENTITY_FILE[page.type === "feature" ? FEATURES_FOLDER : ITEMS_FOLDER]!.name
  );
}

/** Every address a page answers to: its `type/slug` key, plus any alias. */
export function pageKeys(page: Page): string[] {
  // A folder entity's basename key names every folder entity and identifies
  // none (the `feature/feature` trap); its slug key is in the aliases.
  const key = isEntityEntryFile(page) ? null : pageKey(page);
  return [...new Set([...(key === null ? [] : [key]), ...pageAliasKeys(page)])];
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
