// The work taxonomy's corpus rules: what cannot be decided one document at a
// time.
//
// `documentProblems` checks each field's shape. This file checks what the
// fields POINT AT — a `parent` that must be a feature in the tree, a `cycle`
// that must be a cycle file, `blocked_by` ids that must be items and must not
// loop, a `from` in one of the four forms of the reference grammar (plan D6) —
// and what only the whole tree shows: two items with one id, an entity folder
// with no entity file, an archive holding unfinished work (D15), and one slug
// used twice, which would make `item/<slug>` ambiguous.
//
// It reads the documents the thin pass already read (`thinReport`), so the
// tree is walked once. The only other filesystem question it asks is whether a
// `from:` path names a file, which is a stat, not a walk.

import { existsSync, readFileSync } from "node:fs";
import { CONFIG_FILENAME } from "../docs-lint/config.ts";
import { join, relative } from "node:path";
import { parseFrontmatter } from "../docs-lint/index.ts";
import { ENTITY_FILE, ITEMS_FOLDER } from "./registry.ts";
import {
  type Ctx,
  type WorkbenchDocument,
  gitEnv,
  workbenchDocuments,
} from "./rules.ts";
import {
  ARCHIVE,
  type WorkEntity,
  type WorkModel,
  fromResolves,
  ownerPosition,
  parentResolves,
  scalar,
  workModel,
} from "../work.ts";

/** True when the raw value is written as a list, flow or block. */
const isList = (raw: string): boolean => /^\[/.test(raw.trim()) || /^-\s/.test(raw.trim());

/**
 * Every corpus problem in the workbench.
 *
 * `documents` defaults to a fresh read; `collect` passes the ones the thin
 * pass already has, so the gate walks the tree once.
 */
export function workProblems(
  ctx: Ctx,
  documents: readonly WorkbenchDocument[] = workbenchDocuments(ctx)
): string[] {
  const problems: string[] = [];

  // The same model `pdocs new`, `set` and `view` resolve against, so the lint
  // and the commands read a reference one way.
  const model = workModel(ctx, documents);
  const items = model.items;
  const features = model.features;
  const entities = [...features, ...items];
  const featureSlugs = new Set(model.featuresBySlug.keys());
  const cycleSlugs = new Set(model.cyclesBySlug.keys());

  // ---- ids ----------------------------------------------------------------------------
  const byId = model.itemsById;
  for (const [id, holders] of byId)
    if (holders.length > 1)
      problems.push(
        `DUPLICATE ID  ${id}  ${holders.map((h) => h.path).join(", ")}  (an id names one item)`
      );

  // ---- slugs --------------------------------------------------------------------------
  for (const [kind, bySlug] of [
    ["item", model.itemsBySlug],
    ["feature", model.featuresBySlug],
  ] as const)
    for (const [slug, holders] of bySlug)
      if (holders.length > 1)
        problems.push(
          `DUPLICATE SLUG  ${kind}/${slug}  ${holders.map((h) => h.path).join(", ")}  (\`${kind}/${slug}\` must name one ${kind})`
        );

  // ---- the archive holds only finished work (D15) --------------------------------------
  for (const e of entities) {
    if (!e.archived) continue;
    if (e.group !== "completed" && e.group !== "cancelled")
      problems.push(
        `ARCHIVED NOT TERMINAL  ${e.path}: "${e.lifecycle ?? ""}"  (only done or dropped may sit in ${ARCHIVE}/; \`lifecycle\` is the source of truth)`
      );
  }

  // ---- entity folders hold their entity file ------------------------------------------
  const folders = new Map<string, string>(); // docs-relative folder -> owner
  for (const d of documents) {
    const pos = ownerPosition(ctx, d.rel);
    if (!pos || pos.segs.length < 2) continue;
    const archivePart = pos.archived ? `${ARCHIVE}/` : "";
    folders.set(`${pos.owner}/${archivePart}${pos.segs[0]}`, pos.owner);
  }
  const withEntity = new Set(entities.map((e) => e.folder).filter(Boolean));
  for (const [folder, owner] of [...folders].sort())
    if (!withEntity.has(folder))
      problems.push(
        `MISSING ENTITY FILE  ${relative(ctx.repoRoot, join(ctx.docsRoot, folder))}/  (expected ${ENTITY_FILE[owner]!.name})`
      );

  // ---- references ---------------------------------------------------------------------
  const declaredScopes = new Set(ctx.config.lint.scopes);
  for (const e of entities) {
    const rel = e.path;

    const rawScope = e.fields.get("scope");
    if (rawScope) {
      if (isList(rawScope))
        problems.push(
          `BAD SCOPE  ${rel}: "${rawScope}"  (scope takes one value)`
        );
      else if (!declaredScopes.has(scalar(rawScope)))
        problems.push(
          `BAD SCOPE  ${rel}: "${scalar(rawScope)}"  (declare it in lint.scopes in .project-docs.json)`
        );
    }

    if (e.entity !== "item") continue;

    if (e.parent && !parentResolves(model, e.parent))
      problems.push(
        `BAD PARENT  ${rel}: "${e.parent}"  (a parent is \`feature/<slug>\`, naming a feature in the tree)`
      );

    if (e.cycle && !cycleSlugs.has(e.cycle))
      problems.push(
        `BAD CYCLE  ${rel}: "${e.cycle}"  (no cycle file by that slug)`
      );

    for (const blocker of e.blockedBy)
      if (!byId.has(blocker))
        problems.push(
          `BAD BLOCKED_BY  ${rel}: "${blocker}"  (no item has that id)`
        );

    if (e.from && !fromResolves(ctx, model, e.from))
      problems.push(
        `BAD FROM  ${rel}: "${e.from}"  (an item id, \`feature/<slug>\`, \`cycle/<slug>\`, or a docs-root-relative path to a document)`
      );
  }

  problems.push(...blockedCycles(items, byId));
  return problems;
}

/**
 * Every loop in the `blocked_by` graph, once each. An item blocking itself is a
 * loop of one. A loop is reported starting from its lexically first path, so
 * the same loop found from two of its members is one row.
 */
function blockedCycles(
  items: readonly WorkEntity[],
  byId: WorkModel["itemsById"]
): string[] {
  const edges = new Map<string, string[]>(); // rel -> blocker rels
  for (const it of items)
    edges.set(
      it.path,
      it.blockedBy.flatMap((id) => (byId.get(id) ?? []).map((e) => e.path))
    );

  const found = new Set<string>();
  const out: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (node: string): void => {
    state.set(node, "visiting");
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (state.get(next) === "visiting") {
        const loop = stack.slice(stack.indexOf(next));
        const start = loop.indexOf([...loop].sort()[0] as string);
        const canonical = [...loop.slice(start), ...loop.slice(0, start)];
        const key = canonical.join(" → ");
        if (!found.has(key)) {
          found.add(key);
          out.push(
            `BLOCKED CYCLE  ${key} → ${canonical[0]}  (blocked_by must not loop)`
          );
        }
      } else if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(node, "done");
  };
  for (const node of [...edges.keys()].sort()) if (!state.has(node)) visit(node);
  return out;
}

// ---------------------------------------------------------------------------------------
// No silent deletion (D9)
// ---------------------------------------------------------------------------------------

/** A git spawn from the lint: `gitEnv()` always, so a hook's index is not read. */
function gitRun(ctx: Ctx, args: string[], stdin?: string) {
  return Bun.spawnSync(["git", ...args], {
    cwd: ctx.repoRoot,
    env: gitEnv(),
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Whether `ref` names a commit in the repository at `ctx.repoRoot`. `null`
 *  when there is no repository at all. */
export function refExists(ctx: Ctx, ref: string): boolean | null {
  if (!gitRun(ctx, ["rev-parse", "--git-dir"]).success) return null;
  return gitRun(ctx, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).success;
}

/**
 * Items that were in the tree at `ref` and are not in it now, and were not
 * `dropped` there. A move, a promotion or an archive keeps the `id`, so it is
 * not a deletion; only an id that has gone from the working tree is.
 *
 * One `ls-tree` for the paths and one `cat-file --batch` for every blob, so
 * the cost is two spawns whatever the size of the backlog. No repository, or
 * a ref that does not resolve (a repository with no commits yet), is no
 * finding: there is nothing to compare against.
 */
export function deletedItems(
  ctx: Ctx,
  ref: string = ctx.against ?? "HEAD",
  documents: readonly WorkbenchDocument[] = workbenchDocuments(ctx)
): string[] {
  if (refExists(ctx, ref) !== true) return [];

  const itemsDir = join(ctx.config.docsRoot, ITEMS_FOLDER);
  // `-z`: without it git C-quotes any path with a non-ASCII byte in it
  // (`"docs/items/caf\303\251.md"`), which then names no blob.
  const listed = gitRun(ctx, ["ls-tree", "-r", "-z", "--name-only", ref, "--", itemsDir]);
  if (!listed.success) return [];
  const paths = listed.stdout
    .toString()
    .split("\0")
    .filter((p) => p.endsWith(".md"));
  if (paths.length === 0) return [];

  const batch = gitRun(
    ctx,
    ["cat-file", "--batch"],
    paths.map((p) => `${ref}:./${p}\n`).join("")
  );
  if (!batch.success) return [];

  // Ids compare lowercased: `BAD ID … (lowercase)` asks for exactly that
  // edit, and making it must not read as the item leaving the tree.
  const current = new Set(
    documents
      .filter((d) => d.type === "item")
      .map((d) => scalar(d.fields.get("id")).toLowerCase())
      .filter(Boolean)
  );

  // The id each working-tree document carries, by repo-relative path — the
  // same spelling `ls-tree` gives, since both are relative to the repo root.
  const idAt = new Map(
    documents.map((d) => [d.rel, scalar(d.fields.get("id"))] as const)
  );

  const problems: string[] = [];
  const out = Buffer.from(batch.stdout);
  let at = 0;
  for (const path of paths) {
    const eol = out.indexOf(0x0a, at);
    if (eol < 0) break;
    const header = out.subarray(at, eol).toString();
    at = eol + 1;
    const m = /^\S+ blob (\d+)$/.exec(header);
    if (!m) continue; // `missing`, or not a blob
    const size = Number(m[1]);
    const body = out.subarray(at, at + size).toString("utf8");
    at += size + 1; // the blob, and the newline cat-file writes after it

    const fm = /^---\n([\s\S]*?)\n---/.exec(body);
    if (!fm) continue;
    const fields = parseFrontmatter(fm[1] as string);
    if (scalar(fields.get("type")) !== "item") continue;
    const id = scalar(fields.get("id"));
    if (!id || current.has(id.toLowerCase())) continue;
    // Still there, at the same path, with no id that can be read — CRLF line
    // endings, a broken block, a dropped `id:` line. Its own parse problem is
    // the finding; it has not left the tree. A file there WITH a readable id
    // is a different item (an id rewritten in place, a slug reused): the old
    // id has gone, and that is a deletion.
    if (existsSync(join(ctx.repoRoot, path)) && !idAt.get(path)) continue;
    const state = scalar(fields.get("lifecycle"));
    if (state === "dropped") continue;
    problems.push(
      `ITEM DELETED  ${path}: ${id}  (it left the tree at "${state || "no lifecycle"}" without reaching \`dropped\` — restore it and set \`lifecycle: dropped\`; nothing is deleted, it is dropped)`
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------------------
// The work-taxonomy config
// ---------------------------------------------------------------------------------------

/**
 * `lint.scopes` in `.project-docs.json`, when it is present and not a list of
 * strings. `loadConfig` falls back to `[]` for it, as it does for every array;
 * without this row the only symptom is every `scope:` in the tree reporting
 * "declare it in lint.scopes" — about a key the project did declare.
 */
export function configProblems(ctx: Ctx): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(ctx.repoRoot, CONFIG_FILENAME), "utf8"));
  } catch {
    return []; // absent, or malformed — `loadConfig` has already thrown for that
  }
  const lint = (raw as { lint?: Record<string, unknown> } | null)?.lint;
  if (!lint || typeof lint !== "object" || !("scopes" in lint)) return [];
  const scopes = lint.scopes;
  if (Array.isArray(scopes) && scopes.every((x) => typeof x === "string")) return [];
  return [
    `BAD CONFIG  ${CONFIG_FILENAME}: lint.scopes is ${JSON.stringify(scopes)}  (expected a list of strings; until it is one, no scope is declared)`,
  ];
}
