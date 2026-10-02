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
import { type ReviewItem, REVIEW_SETTING, reviewViolations } from "../advisories.ts";
import { CONFIG_FILENAME, describeIssue } from "../docs-lint/config.ts";
import { join, relative } from "node:path";
import { parseFrontmatter } from "../docs-lint/index.ts";
import { CYCLE_ENDS, ENTITY_FILE, ITEMS_FOLDER, registryIndex } from "./registry.ts";
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
    ["cycle", model.cyclesBySlug],
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
  // A cycle's archive holds only a cycle that ended: `closed` or `abandoned`.
  for (const c of model.cycles) {
    if (!c.archived) continue;
    if (c.lifecycle === null || !CYCLE_ENDED.has(c.lifecycle))
      problems.push(
        `ARCHIVED NOT TERMINAL  ${c.path}: "${c.lifecycle ?? ""}"  (only a closed or abandoned cycle may sit in ${ARCHIVE}/; \`lifecycle\` is the source of truth)`
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
        `BAD CYCLE  ${rel}: "${e.cycle}"  (no cycle has that slug — a cycle's slug is its filename without \`.md\`, in cycles/ or cycles/_archive/)`
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
  problems.push(...cycleOutcomeProblems(ctx, model.cycles));
  return problems;
}

/** The states a cycle ends in, each of which owes an Outcome. */
const CYCLE_ENDED = new Set(CYCLE_ENDS);

/** An Outcome heading: `## Outcome` or `## Outcomes`, with anything after it. */
const OUTCOME_HEADING = /^##\s+outcomes?(?![\w-])/i;

/**
 * The paragraphs under a body's Outcome heading (`## Outcome`, `## Outcomes`,
 * or either with text after it — `## Outcome — shipped`), up to the next H2,
 * each with HTML comments removed and whitespace collapsed; empty ones dropped.
 * A heading inside a fenced code block is not a heading. `null` when there is
 * no Outcome heading.
 */
export function outcomeParagraphs(body: string): string[] | null {
  const lines = body.split("\n");
  let fence: string | null = null;
  let at = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      const mark = f[1] as string;
      if (fence === null) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (at === -1) {
      if (OUTCOME_HEADING.test(line)) at = i;
    } else if (/^## /.test(line)) {
      end = i;
      break;
    }
  }
  if (at === -1) return null;
  return lines
    .slice(at + 1, end)
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p !== "");
}

/**
 * The Outcome paragraphs every RELEASED cycle template has shipped, whitespace
 * collapsed as `outcomeParagraphs` leaves them. A migration replaces the
 * project's template but not the cycles created from it, so a cycle can hold
 * a placeholder its project's template no longer has. Add the old paragraphs
 * here whenever the template's Outcome changes.
 */
const RELEASED_OUTCOME_PLACEHOLDERS: readonly string[] = [
  // v7.0.0 – v9.0.0
  "_Written at close, not before._",
  "[What shipped. What was cut, and why. What was learned that will change how the next cycle is scoped. Two paragraphs is usually enough; the point is that a reader six months from now can tell what happened without reading every session.]",
  // v9.0.1 –
  "_Written at close, not before — and for an `abandoned` cycle too._",
  "[What shipped. What was cut, and why. What carried over to the next cycle: each item still open, and the cycle it joined. What was learned that will change how the next cycle is scoped. For an `abandoned` cycle, what was falsified: the assumption that stopped it. Two paragraphs is usually enough; the point is that a reader six months from now can tell what happened without reading every session.]",
];

/**
 * The italic prompt line, in whatever wording a template gave it: ONE italic
 * run. Prose after it on the same line — `_Written at close…_ We shipped A;
 * B was _cut_` — is an Outcome, and is not matched.
 */
const WRITTEN_AT_CLOSE = /^_Written at close\b[^_]*_$/;

/**
 * A `closed` or `abandoned` cycle whose `## Outcome` is missing, empty, or
 * still only placeholder paragraphs: the project's own cycle template's (so an
 * edited template's placeholder counts), any released template's, or a lone
 * `_Written at close…_` line. A `planned` or `active` cycle is not asked: the
 * Outcome is written at close.
 */
export function cycleOutcomeProblems(ctx: Ctx, cycles: readonly WorkEntity[]): string[] {
  const ended = cycles.filter((c) => c.lifecycle !== null && CYCLE_ENDED.has(c.lifecycle));
  if (ended.length === 0) return [];
  const template = [registryIndex(ctx.config).get("cycle")?.template ?? []].flat()[0];
  const tplPath = template ? join(ctx.repoRoot, template) : null;
  const placeholder = new Set([
    ...RELEASED_OUTCOME_PLACEHOLDERS,
    ...(tplPath && existsSync(tplPath) ? outcomeParagraphs(bodyOf(readFileSync(tplPath, "utf8"))) ?? [] : []),
  ]);
  const isPlaceholder = (p: string) => placeholder.has(p) || WRITTEN_AT_CLOSE.test(p);
  const problems: string[] = [];
  for (const c of ended) {
    const abs = join(ctx.repoRoot, c.path);
    if (!existsSync(abs)) continue;
    const paragraphs = outcomeParagraphs(bodyOf(readFileSync(abs, "utf8")));
    const why =
      paragraphs === null
        ? "has no `## Outcome` section"
        : paragraphs.length === 0
          ? "has an empty `## Outcome`"
          : paragraphs.every(isPlaceholder)
            ? "still has a cycle template's placeholder under `## Outcome`"
            : null;
    if (why)
      problems.push(
        `NO OUTCOME  ${c.path}: ${c.lifecycle}, but ${why}  (write what shipped, what was cut and what was learned)`
      );
  }
  return problems;
}

/** A document's text below its frontmatter block. */
const bodyOf = (raw: string): string => raw.replace(/^---\n[\s\S]*?\n---\n?/, "");

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
 * `.project-docs.json` settings that are present and invalid.
 *
 * - `lint.scopes`, when it is not a list of strings. `loadConfig` falls back to
 *   `[]` for it, as it does for every array; without this row the only symptom
 *   is every `scope:` in the tree reporting "declare it in lint.scopes" — about
 *   a key the project did declare.
 * - Every `checks` issue `loadConfig` recorded: a setting outside its
 *   vocabulary, an unknown key inside a section, a section that is not an
 *   object, a section this version does not take, or a `checks` that is not
 *   an object. A view that reads `checks` still runs and carries a
 *   `bad-config` advisory; this row is what makes the gate fail on it.
 */
export function configProblems(ctx: Ctx): string[] {
  const issues = ctx.config.issues.map(
    (i) => `BAD CONFIG  ${CONFIG_FILENAME}: ${describeIssue(i)}`
  );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(ctx.repoRoot, CONFIG_FILENAME), "utf8"));
  } catch {
    return issues; // absent, or malformed — `loadConfig` has already thrown for that
  }
  const lint = (raw as { lint?: Record<string, unknown> } | null)?.lint;
  if (!lint || typeof lint !== "object" || !("scopes" in lint)) return issues;
  const scopes = lint.scopes;
  if (Array.isArray(scopes) && scopes.every((x) => typeof x === "string")) return issues;
  return [
    `BAD CONFIG  ${CONFIG_FILENAME}: lint.scopes is ${JSON.stringify(scopes)}  (expected a list of strings; until it is one, no scope is declared)`,
    ...issues,
  ];
}

// ---------------------------------------------------------------------------------------
// Work item review
// ---------------------------------------------------------------------------------------

/**
 * Every item the review rule finds (`reviewViolations`) — started work, or
 * unstarted work in the active cycle, whose own document is not `stable`.
 * `pdocs check` reports them as an advisory in either mode; under
 * `checks.workItemReview.mode: strict` it also fails on each, through
 * `reviewProblems`.
 */
export function reviewFindings(
  ctx: Ctx,
  documents: readonly WorkbenchDocument[] = workbenchDocuments(ctx)
): ReviewItem[] {
  return reviewViolations(workModel(ctx, documents));
}

/** One `UNREVIEWED` row per finding. Only `collect` calls this, and only in strict mode. */
export function reviewProblems(findings: readonly ReviewItem[]): string[] {
  return findings.map((f) => {
    const where =
      f.reason === "active-cycle"
        ? `lifecycle ${f.lifecycle ?? "none"} in active cycle ${f.cycle}`
        : `lifecycle ${f.lifecycle ?? "none"}`;
    const what = f.reason === "active-cycle" ? "an active cycle's work" : "started work";
    return `UNREVIEWED  ${f.path}: status ${f.status ?? "missing"}, ${where}  (${what} needs \`status: stable\` — ${REVIEW_SETTING} is strict)`;
  });
}
