// The rules the documentation gate enforces.
//
// Every check lives here as a function over a `Ctx`, returning problems as
// strings; `collect.ts` assembles them into a report and the CLI prints it.
// Nothing in this file writes to stdout — a rule that prints cannot be reused
// by a command that owns its own output envelope.
//
// Two tiers, keyed to folders rather than to location — see docs/SCHEMA.md.
// The LIBRARY (architecture, specifications, interaction-design, playbooks,
// lessons-learned, memories, and the three root pages) is checked by the ported
// core, which additionally enforces catalog reachability, `related` resolution
// and the graph. The WORKBENCH (backlog, briefs, investigations, projects,
// reports, fragments, cycles) is checked by `thinTier` below: presence and
// vocabulary, and links, and nothing about reachability — those documents are
// written once, they close, and nobody returns to them.
//
// Everything project-specific lives in this file and in `registry.ts`, which
// holds the type system as data and which every check below reads rather than
// carrying its own copy. `scripts/pdocs/docs-lint/` is a copy of a portable
// core and stays that way.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { type ProjectDocsConfig, loadConfig } from "../docs-lint/config.ts";
import {
  type DocsLintReport,
  type LintPage,
  checkLinks,
  collectDocsLint,
  parseFrontmatter,
  stripInlineComment,
  walkMarkdown,
  yamlList,
} from "../docs-lint/index.ts";
import {
  DURABLE_TYPE,
  PROJECT_FILE_TYPE,
  PROJECT_SPEC,
  type RegistryRow,
  ROOT_PAGE_TYPE,
  SPEC,
  buildRegistry,
  defaultRegistryIndex,
  registryIndex,
} from "./registry.ts";
import { isSeeded, loadManifest } from "../seed.ts";

/**
 * Where to lint, and by what rules.
 *
 * Every function below takes one rather than closing over this repository's
 * paths. A lint bound to its own root cannot be run against a fixture, and
 * cannot be shipped in the scaffold payload to run somewhere else — which are
 * the two things this file has to do.
 */
export interface Ctx {
  repoRoot: string;
  docsRoot: string;
  config: ProjectDocsConfig;
}

export function context(repoRoot: string): Ctx {
  const config = loadConfig(repoRoot);
  return { repoRoot, docsRoot: join(repoRoot, config.docsRoot), config };
}

// ---------------------------------------------------------------------------------------
// What counts as what
// ---------------------------------------------------------------------------------------

/**
 * Meta-documents ABOUT the tree rather than entries in its type system. They
 * carry no frontmatter; only their links are checked, because a folder contract
 * with a dead pointer misroutes the next document written.
 *
 * Exported because `pages.ts` has to skip exactly these, and a second list of
 * meta-document names would drift from this one the first time a fifth is
 * added.
 */
export const CONTRACT_BASENAMES = new Set([
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "SCHEMA.md",
]);

/**
 * A form, not a document: its links are placeholders by construction.
 *
 * This IS `seed.ts`'s `isSeeded` — the same function, not a copy — because a
 * migration reconciles templates through that module and the lint skips them
 * here, and two rules for one question is how a real specification named
 * `templates.md` went unread by every tier while `/template/i` called it a
 * form. See `isSeeded` for the five shapes it matches. `templateTest` below is
 * what a caller with a `Ctx` should use: it adds the seed manifest.
 */
export const isTemplate = isSeeded;

/**
 * `isTemplate`, plus every path `docs/.pdocs-seed.json` records.
 *
 * The manifest is the exact list of what the scaffold installed, so a seeded
 * file is a template whatever it is called. The name rule stays live beside it
 * rather than yielding to it, for two reasons: `collect` applies this to
 * tracked markdown OUTSIDE the docs root, which a docs-root manifest cannot
 * describe; and a template added after the manifest was written — this
 * repository's own next one, or an adopter's — would otherwise be linted as a
 * document with nothing saying why.
 *
 * Compiled once per context, like `excluder`: the manifest is read once, not
 * once per file.
 */
export function templateTest(ctx: Ctx): (path: string) => boolean {
  const seeded = new Set(Object.keys(loadManifest(ctx.docsRoot).files));
  return (path) => {
    if (isTemplate(path)) return true;
    if (seeded.size === 0) return false;
    const abs = isAbsolute(path) ? path : join(ctx.repoRoot, path);
    const rel = relative(ctx.docsRoot, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
    return seeded.has(rel);
  };
}

/**
 * Every file under the docs root the lint skips as a template, repo-relative.
 *
 * `pdocs check --format json` carries this so a project can see what the lint
 * decided not to look at — the one thing a wrong skip otherwise leaves no
 * trace of. Walked without pruning `TEMPLATES/`, because those are skipped as
 * templates too, by directory rather than by name.
 */
export function templatePaths(ctx: Ctx): string[] {
  const isTpl = templateTest(ctx);
  const excluded = excluder(ctx);
  const out: string[] = [];
  for (const path of walkMarkdown(ctx.docsRoot, new Set(ctx.config.lint.skip))) {
    const rel = relative(ctx.repoRoot, path);
    if (isTpl(path) && !excluded(rel)) out.push(rel);
  }
  return out.sort();
}

/**
 * Not documentation at all — `lint.exclude` in `.project-docs.json`, matched
 * against the path relative to the repository root.
 *
 * Compiled once per context rather than once per file: a glob is parsed on
 * construction, and the walk asks this of every `.md` in the tree.
 */
export function excluder(ctx: Ctx): (repoRelative: string) => boolean {
  const globs = ctx.config.lint.exclude.map((pattern) => new Bun.Glob(pattern));
  if (globs.length === 0) return () => false;
  return (repoRelative) => globs.some((g) => g.match(repoRelative));
}

/**
 * The type system's source tables, and the registry that unifies them, live in
 * `registry.ts`.
 *
 * They are re-exported here because this is the path that imports them: the
 * v2.6-to-v2.7 codemod's test reads all five from `rules.ts` to prove its own
 * copies are equal, and a moved export would have broken a test whose whole
 * purpose is to notice drift. See `registry.ts` for why the dependency runs the
 * way it does rather than the other way.
 */
export {
  DURABLE_TYPE,
  PROJECT_FILE_TYPE,
  PROJECT_SPEC,
  ROOT_PAGE_TYPE,
  SPEC,
};

/** Library types carry no lifecycle: a living page is current or it is not, and `status` says which. */
export const DURABLE_TYPES = [
  ...Object.values(DURABLE_TYPE),
  ...Object.values(ROOT_PAGE_TYPE),
];

/** OKF 0.2 §5.4. Required explicitly so a reader never has to know the default.
 *  Exported because `pdocs new` validates `--status` against it before writing:
 *  a second copy of three strings is a second thing to keep in step. */
export const OKF_STATUS = ["draft", "stable", "deprecated"];

/**
 * Required on every workbench document. `tags` is deliberately NOT here: a
 * library page is found by tag, a workbench document by its date and its folder
 * README, and requiring four keywords on forty-four session notes buys a tag
 * cloud nobody reads.
 */
const REQUIRED = ["type", "title", "description", "status", "generated"];
const OPTIONAL = new Set(["tags", "related", "supersedes"]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TAG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------------------
// The workbench: presence and vocabulary
// ---------------------------------------------------------------------------------------

/** Every workbench file, paired with the `type` its position says it must carry. */
export function workbenchFiles(ctx: Ctx): Array<{
  path: string;
  rel: string;
  type: string;
}> {
  const skip = new Set([...ctx.config.lint.skip, "TEMPLATES"]);
  const excluded = excluder(ctx);
  const out: Array<{ path: string; rel: string; type: string }> = [];

  for (const folder of ctx.config.lint.workbench) {
    const dir = join(ctx.docsRoot, folder);
    if (!existsSync(dir)) continue;
    for (const path of walkMarkdown(dir, skip)) {
      const rel = relative(ctx.repoRoot, path);
      if (excluded(rel)) continue;
      out.push({
        path,
        rel,
        type:
          folder === "projects"
            ? projectType(path)
            : (SPEC[folder]?.type ?? ctx.config.lint.types[folder] ?? ""),
      });
    }
  }
  return out;
}

function projectType(path: string): string {
  if (path.includes("/sessions/")) return "session";
  return PROJECT_FILE_TYPE[basename(path)] ?? "artifact";
}

/**
 * Every library file, paired with the `type` its position says it must carry —
 * the mirror of `workbenchFiles`, and it exists for the same reason.
 *
 * The frontmatter rules are about the DOCUMENT, not about the tier. The tier
 * decides what graph obligations a page has; it has never decided whether
 * `status: approved` is a legal value. Keeping the vocabulary checks inside
 * `thinTier` made it decide exactly that, silently, for forty pages.
 */
export function libraryFiles(ctx: Ctx): Array<{
  path: string;
  rel: string;
  type: string;
}> {
  const skip = new Set([
    ...ctx.config.lint.workbench,
    ...ctx.config.lint.skip,
    "TEMPLATES",
  ]);
  const excluded = excluder(ctx);
  const out: Array<{ path: string; rel: string; type: string }> = [];

  for (const path of walkMarkdown(ctx.docsRoot, skip)) {
    const name = basename(path);
    // A root-level page is a library page only if it is one of the three named
    // ones; anything else loose at the docs root is not ours to type.
    if (dirname(path) === ctx.docsRoot && !(name in ROOT_PAGE_TYPE)) continue;
    const rel = relative(ctx.repoRoot, path);
    if (excluded(rel)) continue;
    const folder = relative(ctx.docsRoot, dirname(path)).split("/")[0] ?? "";
    out.push({
      path,
      rel,
      type:
        ROOT_PAGE_TYPE[name] ??
        DURABLE_TYPE[folder] ??
        ctx.config.lint.types[folder] ??
        "",
    });
  }
  return out;
}

/**
 * Presence, vocabulary and field hygiene for ONE document. Pure over its inputs
 * so both tiers can call it, which is the whole point: these rules are about
 * the document, not about which folder it lives in.
 *
 * `requireTags` is the only thing the two tiers actually disagree about. A
 * library page is found by tag; a workbench document is found by its date and
 * its folder README, and requiring four keywords on forty session notes buys a
 * tag cloud nobody reads.
 *
 * Returns the active-cycle path separately, because "at most one" is a fact
 * about the corpus and cannot be decided one file at a time.
 *
 * `lifecycle` and `extra` come from the REGISTRY, one lookup for every type.
 * They used to come from two places that could not answer for the same set:
 * `vocabularyFor` read `PROJECT_SPEC` then `SPEC`, while `extra` was read from
 * `SPEC` alone — so an extra field was structurally unavailable to all eight
 * project-scoped types, and nothing in the code said so. The registry is passed
 * in rather than rebuilt per document; the default is exact, because neither
 * field depends on configuration.
 */
export function documentProblems(
  file: { path: string; rel: string; type: string },
  raw: string,
  docsRoot: string,
  requireTags: boolean,
  registry: ReadonlyMap<string, RegistryRow> = defaultRegistryIndex()
): { problems: string[]; activeCycle: boolean } {
  const { rel, type } = file;
  const problems: string[] = [];

  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!m) {
    problems.push(`NO FRONTMATTER ${rel}  (see ${docsRoot}/SCHEMA.md)`);
    return { problems, activeCycle: false };
  }

  const fields = parseFrontmatter(m[1] as string);
  const row = registry.get(type);
  const lifecycle = row?.lifecycle ?? null;
  const required = requireTags ? [...REQUIRED, "tags"] : REQUIRED;
  const allowed = new Set([
    ...REQUIRED,
    ...OPTIONAL,
    ...(lifecycle ? ["lifecycle"] : []),
    ...(row?.extra ?? []),
  ]);

  for (const key of required)
    if (!fields.get(key)) problems.push(`MISSING ${key}   ${rel}`);
  if (lifecycle && !fields.get("lifecycle"))
    problems.push(`MISSING lifecycle   ${rel}`);
  for (const key of fields.keys())
    if (!allowed.has(key)) problems.push(`UNKNOWN FIELD  ${rel}: "${key}"`);

  const declared = fields.get("type");
  if (declared && declared !== type)
    problems.push(
      `WRONG TYPE     ${rel}: "${declared}" (its position says "${type}")`
    );

  const status = fields.get("status");
  if (status && !OKF_STATUS.includes(status))
    problems.push(
      `BAD STATUS     ${rel}: "${status}"  (OKF 0.2: ${OKF_STATUS.join(" | ")})`
    );

  let activeCycle = false;
  const value = fields.get("lifecycle");
  if (value) {
    if (lifecycle === null)
      problems.push(
        `LIFECYCLE      ${rel}: a ${type} is a frozen record and carries no lifecycle`
      );
    else if (!lifecycle.includes(value))
      problems.push(
        `BAD LIFECYCLE  ${rel}: "${value}"  (${type}: ${lifecycle.join(" | ")})`
      );
    else if (type === "cycle" && value === "active") activeCycle = true;
  }

  problems.push(...generatedProblems(rel, fields.get("generated")));

  // Superseded by `generated.at` in OKF 0.2, and rejected rather than ignored
  // so a document cannot carry two disagreeing dates.
  for (const legacy of ["date", "timestamp", "updated"])
    if (fields.has(legacy))
      problems.push(
        `LEGACY FIELD   ${rel}: \`${legacy}\` is superseded by \`generated.at\` (OKF 0.2 §13.1)`
      );

  for (const tag of yamlList(fields.get("tags")))
    if (!TAG_RE.test(tag))
      problems.push(`BAD TAG        ${rel}: "${tag}"  (kebab-case)`);

  return { problems, activeCycle };
}

/**
 * The same field rules, applied to the library.
 *
 * This did not exist for the first six phases of the work, and the gap was
 * invisible: `SCHEMA.md` claimed the graph tier checked "everything Thin
 * checks, plus" the graph obligations, and it checked none of it. A library
 * page could carry `status: approved` — the exact hand-invented value this
 * whole layer was built to make impossible — and the gate said `clean`. A
 * cold-read agent found it by trying the thing the contract forbids.
 */
export function libraryFieldChecks(ctx: Ctx): string[] {
  const registry = registryIndex(ctx.config);
  const isTpl = templateTest(ctx);
  const problems: string[] = [];
  for (const file of libraryFiles(ctx)) {
    if (CONTRACT_BASENAMES.has(basename(file.path)) || isTpl(file.path))
      continue;
    problems.push(
      ...documentProblems(
        file,
        readFileSync(file.path, "utf8"),
        ctx.config.docsRoot,
        true,
        registry
      ).problems
    );
  }
  return problems;
}

export function thinTier(ctx: Ctx): string[] {
  const registry = registryIndex(ctx.config);
  const isTpl = templateTest(ctx);
  const problems: string[] = [];
  const activeCycles: string[] = [];

  for (const file of workbenchFiles(ctx)) {
    const { path, rel } = file;
    const raw = readFileSync(path, "utf8");
    const name = basename(path);

    // Links are checked on every file including the folder READMEs, which are
    // the contracts and cross-link each other constantly. Templates are the one
    // exception: their links are placeholders.
    if (!isTpl(path)) {
      for (const bad of checkLinks(path, raw).problems) {
        problems.push(
          bad.kind === "MISSING FILE"
            ? `MISSING FILE   ${rel}: ${bad.target}`
            : `MISSING ANCHOR ${rel}: ${bad.target}  (#${bad.anchor} not a heading)`
        );
      }
    }

    if (CONTRACT_BASENAMES.has(name) || isTpl(path)) continue;

    const r = documentProblems(file, raw, ctx.config.docsRoot, false, registry);
    problems.push(...r.problems);
    if (r.activeCycle) activeCycles.push(rel);
  }

  // The rule a cycle exists for: two answers to "what are we doing" is the
  // state it prevents.
  if (activeCycles.length > 1)
    problems.push(
      `TWO ACTIVE CYCLES  ${activeCycles.join(", ")}  (at most one cycle is \`lifecycle: active\`)`
    );

  return problems;
}

function generatedProblems(
  rel: string,
  generated: string | undefined
): string[] {
  if (!generated) return [];
  const g = /^\{\s*by:\s*([^,}]+?)\s*,\s*at:\s*([^,}]+?)\s*\}$/.exec(generated);
  if (!g)
    return [
      `BAD GENERATED  ${rel}: ${generated}  (expected \`{ by: <actor>, at: YYYY-MM-DD }\`)`,
    ];
  if (!DATE_RE.test(g[2] as string))
    return [`BAD generated.at  ${rel}: "${g[2]}"  (expected YYYY-MM-DD)`];
  return [];
}

/**
 * Frontmatter that this repo's lenient parser accepts and a real YAML parser
 * would not.
 *
 * `description: finalize-branch stopped assuming: it verifies …` is a mapping
 * with two colons, and every YAML library reads it as a syntax error or as a
 * nested key. `parseFrontmatter` here splits on the FIRST colon and hands back
 * the rest as a string, so the document looks fine to the gate and breaks in
 * the next tool that reads it.
 *
 * Checked across both tiers, because the hazard is the punctuation rather than
 * the folder — and hand-written `description` values are exactly where a colon
 * turns up.
 */
export function frontmatterSyntaxProblems(ctx: Ctx): string[] {
  const excluded = excluder(ctx);
  const isTpl = templateTest(ctx);
  const skip = new Set([...ctx.config.lint.skip, "TEMPLATES"]);
  const problems: string[] = [];

  for (const path of walkMarkdown(ctx.docsRoot, skip)) {
    if (CONTRACT_BASENAMES.has(basename(path)) || isTpl(path)) continue;
    const rel = relative(ctx.repoRoot, path);
    if (excluded(rel)) continue;
    const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path, "utf8"));
    if (!m) continue;

    for (const line of (m[1] as string).split("\n")) {
      const kv = /^([A-Za-z_][\w-]*):\s+(\S.*)$/.exec(line);
      if (!kv) continue;
      // A trailing ` # comment` is not part of the scalar — YAML strips it, so
      // this check has to as well. It did not, and the first document to carry
      // an explanatory comment on `status` was reported as broken frontmatter
      // when it was correct. `stripInlineComment` is the same helper the parser
      // uses, which is the point: two readings of one value is how the check
      // and the thing it checks come apart.
      const value = stripInlineComment((kv[2] as string).trim()).trim();
      if (!value) continue;
      // Quoted, a flow collection, or a mapping — all unambiguous.
      if (/^["'[{]/.test(value)) continue;
      if (/:\s/.test(value))
        problems.push(
          `BAD SCALAR     ${rel}: \`${kv[1]}\` contains ": " unquoted  (a real YAML parser reads this as a nested mapping)`
        );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------
// The library: the ported core, plus the catalog hook check
// ---------------------------------------------------------------------------------------

/**
 * Every catalog entry in `index.md`: the page it points at, and the hook it
 * states.
 *
 * Lifted from agent-cli-conformance's `docs/wiki/lint.ts`. An entry is a list
 * item whose first token links a `.md` page; a Prettier-wrapped continuation
 * line belongs to the entry above it, and is folded BEFORE the link is matched
 * — a matcher reading one physical line at a time silently skips exactly the
 * entries whose text is longest.
 */
export function catalogEntries(
  indexBody: string
): Array<{ target: string; hook: string }> {
  const items: string[] = [];
  let inItem = false;
  for (const raw of indexBody.split("\n")) {
    if (/^-\s+\[/.test(raw)) {
      items.push(raw.trim());
      inItem = true;
    } else if (inItem && /^\s+\S/.test(raw))
      items[items.length - 1] += ` ${raw.trim()}`;
    else inItem = false;
  }

  const out: Array<{ target: string; hook: string }> = [];
  for (const item of items) {
    const m = /^-\s+\[[^\]]*\]\(([^)#]+\.md)\)(.*)$/.exec(item);
    if (m)
      out.push({
        target: (m[1] ?? "").replace(/^\.\//, ""),
        // Prettier escapes markdown-active characters in body text and not in
        // YAML, so a description containing `_archive/` reaches the catalog as
        // `\_archive/`. Comparing the two verbatim would fail on the escape
        // rather than on the drift the check exists to find.
        hook: (m[2] ?? "")
          .replace(/\s+/g, " ")
          .replace(/^\s*—\s*/, "")
          .replace(/\\([_*`[\]<>#~])/g, "$1")
          .trim(),
      });
  }
  return out;
}

/**
 * A catalog hook must be its target page's `description`, verbatim.
 *
 * SCHEMA.md says the description doubles as the hook. Nothing enforcing that is
 * how a catalog ends up describing a page that has since been rewritten — and
 * nobody re-reads the catalog, so it survives every review of the page itself.
 */
export function hookChecks(pages: LintPage[]): string[] {
  const index = pages.find((p) => p.rel === "index.md");
  if (!index) return [];
  const byRel = new Map(pages.map((p) => [p.rel, p]));
  const problems: string[] = [];
  for (const { target, hook } of catalogEntries(index.body)) {
    const page = byRel.get(target);
    if (!page) continue; // a link out of the library is the core lint's problem
    const description = (page.fields.get("description") ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!description) continue; // already reported as missing frontmatter
    if (hook !== description)
      problems.push(
        `STALE HOOK     index.md → ${target}:\n         hook: ${JSON.stringify(hook)}\n  description: ${JSON.stringify(description)}`
      );
  }
  return problems;
}

/**
 * The library tier, as data: the ported core's problems and the graph it walked.
 *
 * It returned a count and printed as a side effect for as long as the only
 * caller was a `main()` that printed too. `collect` needs the findings, and
 * `pdocs graph` needs the graph, so the printing wrapper (`runDocsLint`) is no
 * longer in the path — the report goes back to whoever asked and they decide
 * what to render.
 */
export function graphTier(ctx: Ctx): DocsLintReport {
  // `skipFiles` is handed a path relative to the docs root; `exclude` globs are
  // written relative to the repository root, which is the only root a person
  // editing `.project-docs.json` can see.
  const excluded = excluder(ctx);
  const isTpl = templateTest(ctx);
  return collectDocsLint({
    root: ctx.docsRoot,
    // A type this project declared is a known type. Passing only the built-in
    // list here made a declared durable folder report `BAD type` even though
    // the registry and both position resolvers had accepted it — the third
    // closed set, and the one that only a test found.
    types: [...DURABLE_TYPES, ...Object.values(ctx.config.lint.types)],
    nonPageDirs: [
      ...ctx.config.lint.workbench,
      ...ctx.config.lint.skip,
      "TEMPLATES",
    ],
    dateField: "generated",
    allowDateOnly: true,
    skipFiles: (rel) =>
      isTpl(join(ctx.docsRoot, rel)) || excluded(join(ctx.config.docsRoot, rel)),
    isContractPage: (rel) => CONTRACT_BASENAMES.has(basename(rel)),
    extraChecks: hookChecks,
  });
}

// ---------------------------------------------------------------------------------------
// The contract and the code must agree
// ---------------------------------------------------------------------------------------

/**
 * SCHEMA.md's "Lifecycle by type" table, parsed.
 *
 * The table is what a writer reads and `SPEC` is what the gate enforces. State
 * a contract twice and the copies drift; the one that drifts is always the
 * prose, because nothing checks it. So this reads the prose and compares.
 *
 * Cells are trimmed, so Prettier's column padding is irrelevant.
 */
export function schemaLifecycles(schema: string): Map<string, string[] | null> {
  const out = new Map<string, string[] | null>();
  const section = /\n## Lifecycle by type\n([\s\S]*?)\n## /.exec(schema);
  if (!section) return out;
  // Rows only after the alignment row, so the header — whose first cell is the
  // literal `type` — is not read as a type named "type".
  let inBody = false;
  for (const line of (section[1] as string).split("\n")) {
    if (/^\|\s*:?-+:?\s*\|/.test(line)) {
      inBody = true;
      continue;
    }
    if (!inBody) continue;
    const m = /^\|\s*`([a-z-]+)`\s*\|([^|]*)\|/.exec(line);
    if (!m) continue;
    const cell = (m[2] as string).trim();
    out.set(
      m[1] as string,
      cell === "—"
        ? null
        : cell
            .split("·")
            .map((v) => v.trim().replace(/^`|`$/g, ""))
            .filter(Boolean)
    );
  }
  return out;
}

export function schemaTableChecks(schema: string): string[] {
  const stated = schemaLifecycles(schema);
  if (stated.size === 0)
    return [
      'NO SCHEMA TABLE  SCHEMA.md: no parsable "## Lifecycle by type" section',
    ];

  // One source, not three unioned inline. That union was the assembly the
  // registry replaces, and it is the reason this check reads the registry
  // rather than the tables: if `buildRegistry` drops a row, SCHEMA.md's table
  // says so here instead of the row quietly ceasing to be enforced.
  const enforced = new Map<string, string[] | null>();
  for (const row of defaultRegistryIndex().values())
    enforced.set(row.type, row.lifecycle);

  const problems: string[] = [];
  const show = (v: string[] | null) => (v === null ? "—" : v.join(" · "));

  for (const [type, values] of enforced) {
    if (!stated.has(type)) {
      problems.push(
        `SCHEMA MISSING TYPE  SCHEMA.md: the lint enforces \`${type}\`, the table omits it`
      );
      continue;
    }
    const want = stated.get(type) ?? null;
    if (show(want) !== show(values))
      problems.push(
        `SCHEMA DISAGREES  \`${type}\`: SCHEMA.md says "${show(want)}", the lint enforces "${show(values)}"`
      );
  }
  for (const type of stated.keys())
    if (!enforced.has(type))
      problems.push(
        `SCHEMA EXTRA TYPE  SCHEMA.md documents \`${type}\`, which the lint knows nothing about`
      );

  return problems;
}

/**
 * Every template the registry declares is where it says it is.
 *
 * This checks the TOOLING'S OWN CONFIGURATION, not documents — which is why it
 * sits here beside the SCHEMA.md check rather than in either tier. Declaring
 * template paths created a way to be wrong that did not exist before: a
 * renamed template used to break nothing until somebody tried to copy it, and
 * `pdocs new` will now fail at the moment of writing instead. This is that
 * guard, and it runs on every `pdocs check`.
 *
 * `null` (artifact and the three root pages) and arrays (specification's two
 * variants) are both tolerated. `kickoff` is skipped: its template ships with
 * the `dev-kickoff` plugin skill, outside the docs tree and outside the
 * cookiecutter payload, so a generated project — which has no `plugins/`
 * directory at all — would fail its own gate on the first run.
 */
export function templateProblems(ctx: Ctx): string[] {
  const problems: string[] = [];
  for (const row of buildRegistry(ctx.config)) {
    if (row.template === null || row.externalTemplate) continue;
    for (const template of [row.template].flat())
      if (!existsSync(join(ctx.repoRoot, template)))
        problems.push(
          `TEMPLATE MISSING  ${template}  (the \`${row.type}\` registry row declares it; nothing is there)`
        );
  }
  return problems;
}

// ---------------------------------------------------------------------------------------
// --report: the backfill worklist
// ---------------------------------------------------------------------------------------

/**
 * Keys a slide renderer reads — Slidev and Marp between them. A file whose
 * frontmatter has no `type` but carries one of these is a program that happens
 * to be written in Markdown, which SCHEMA.md § "Files that are not
 * documentation" describes and answers with `lint.exclude`. Exported because
 * the v2.6-to-v2.7 codemod carries a copy, and its test holds the two equal.
 */
export const RENDERER_KEYS = [
  "marp",
  "theme",
  "paginate",
  "layout",
  "colorSchema",
  "highlighter",
];

/** A frontmatter block that is plainly a renderer's, not this schema's. */
export function looksLikeSlideDeck(
  fields: ReadonlyMap<string, string>
): boolean {
  return !fields.get("type") && RENDERER_KEYS.some((k) => fields.has(k));
}

/**
 * What is missing, grouped by field and then by folder — and never a failure.
 *
 * A gate answers "may this land"; this answers "what is left", which is a
 * different question asked at a different moment. Merging them gives a list
 * ordered by directory walk, which is the least useful order for working
 * through it.
 */
export function reportLines(ctx: Ctx): string[] {
  const missing = new Map<string, string[]>();
  const note = (field: string, rel: string) =>
    missing.set(field, [...(missing.get(field) ?? []), rel]);

  for (const problem of [...thinTier(ctx), ...libraryFieldChecks(ctx)]) {
    // `MISSING FILE` and `MISSING ANCHOR` share the prefix and are not fields: a
    // broken link is a defect to fix, not a blank to fill, and listing it here
    // would put it in the one report that never fails.
    const m = /^(?:MISSING|NO) (?!FILE|ANCHOR)(\S+)\s+(\S+)/.exec(problem);
    if (m)
      note(
        m[1] === "FRONTMATTER" ? "frontmatter" : (m[1] as string),
        m[2] as string
      );
  }

  // A slide deck reached this list as a bare `type` row, indistinguishable from
  // a document that wants a `type` written — and an agent working the list
  // mechanically would write `type: artifact` into a deck, which breaks the
  // deck and describes the file wrongly to make a gate quiet. SCHEMA.md gives
  // the answer; this is where the question appears, so the pointer goes here.
  // Pulled out of every group: a deck is not a document with blanks in it.
  const decks: string[] = [];
  for (const rel of missing.get("type") ?? []) {
    const m = /^---\n([\s\S]*?)\n---/.exec(
      readFileSync(join(ctx.repoRoot, rel), "utf8")
    );
    if (m && looksLikeSlideDeck(parseFrontmatter(m[1] as string))) decks.push(rel);
  }
  for (const [field, rels] of [...missing]) {
    const kept = rels.filter((r) => !decks.includes(r));
    if (kept.length) missing.set(field, kept);
    else missing.delete(field);
  }

  const lines: string[] = [];
  const total = [...missing.values()].reduce((n, v) => n + v.length, 0);
  // Templates are excluded from the denominator because they are excluded from
  // every check that could put something in the numerator: a form has no
  // frontmatter to backfill, and counting nineteen of them as documents with
  // nothing missing makes the ratio say less than it appears to.
  const isTpl = templateTest(ctx);
  const scanned = [...workbenchFiles(ctx), ...libraryFiles(ctx)].filter(
    (f) => !isTpl(f.path)
  ).length;
  lines.push(
    `${total} missing field(s) across ${new Set([...missing.values()].flat()).size} of ${scanned} document(s)\n`
  );

  // Grouped by field, then by folder, then NAMED. The folder rollup is the
  // right shape at scale — a hundred sessions missing `description` is one
  // fact, not a hundred — but it used to be the whole output, and "one file
  // somewhere under docs/memories/ is missing `status`" is not a worklist. You
  // had to re-implement the check to find the file. Ten per folder is enough to
  // start; the count still tells you how much is behind them.
  const SHOWN = 10;
  for (const [field, rels] of [...missing].sort(
    (a, b) => b[1].length - a[1].length
  )) {
    lines.push(`${field}  (${rels.length})`);
    const byFolder = new Map<string, string[]>();
    for (const rel of rels.sort()) {
      const folder = dirname(rel);
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), rel]);
    }
    for (const [folder, paths] of [...byFolder].sort(
      (a, b) => b[1].length - a[1].length
    )) {
      lines.push(`    ${String(paths.length).padStart(4)}  ${folder}/`);
      for (const rel of paths.slice(0, SHOWN))
        lines.push(`          ${basename(rel)}`);
      if (paths.length > SHOWN)
        lines.push(`          … and ${paths.length - SHOWN} more`);
    }
    lines.push("");
  }

  if (decks.length) {
    lines.push(
      `${decks.length} file(s) look like slide decks rather than documents — consider \`lint.exclude\`:`
    );
    for (const rel of decks.sort()) lines.push(`    ${rel}`);
    lines.push(
      `  See ${ctx.config.docsRoot}/SCHEMA.md § "Files that are not documentation".`
    );
    lines.push("");
  }
  return lines;
}
