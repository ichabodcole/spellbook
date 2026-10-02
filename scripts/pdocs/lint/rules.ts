// The rules the documentation gate enforces.
//
// Every check lives here as a function over a `Ctx`, returning problems as
// strings; `collect.ts` assembles them into a report and the CLI prints it.
// Nothing in this file writes to stdout — a rule that prints cannot be reused
// by a command that owns its own output envelope.
//
// Two tiers, keyed to folders rather than to location — see docs/SCHEMA.md.
// The LIBRARY (architecture, specifications, interaction-design, playbooks, any
// folder a project declares there, and the three root pages) is checked by the
// ported core, which additionally enforces catalog reachability, `related`
// resolution and the graph. The WORKBENCH (features, items, cycles) is checked
// by `thinTier` below: presence and vocabulary, and links, and nothing about
// reachability — work is found by its state and its fields, not by a catalog.
//
// Everything project-specific lives in this file and in `registry.ts`, which
// holds the type system as data and which every check below reads rather than
// carrying its own copy. `scripts/pdocs/docs-lint/` is a copy of a portable
// core and stays that way.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { type ProjectDocsConfig, loadConfig } from "../docs-lint/config.ts";
import {
  type DocsLintReport,
  type LintPage,
  OUTSIDE_REPOSITORY,
  checkLinks,
  collectDocsLint,
  parseFrontmatter,
  stripInlineComment,
  walkMarkdown,
  yamlList,
} from "../docs-lint/index.ts";
import {
  DURABLE_TYPE,
  ENTITY_FILE,
  CYCLES_FOLDER,
  FEATURES_FOLDER,
  ITEMS_FOLDER,
  KINDS,
  OWNED_FILE_TYPE,
  PRIORITIES,
  OWNER_SUBFOLDER,
  type RegistryRow,
  ROOT_PAGE_TYPE,
  SPEC,
  STATE_GROUP,
  buildRegistry,
  defaultRegistryIndex,
  registryIndex,
} from "./registry.ts";
import { SEEDED_PAGES, isSeeded, loadManifest } from "../seed.ts";
import { UUID_RE } from "../uuid.ts";

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
  /**
   * The git ref "no silent deletion" compares the working tree against.
   * `HEAD` when unset; `pdocs check --against <ref>` sets it, which is how CI
   * (where the working tree IS `HEAD`) names the base.
   */
  against?: string;
}

export function context(repoRoot: string): Ctx {
  const config = loadConfig(repoRoot);
  return { repoRoot, docsRoot: join(repoRoot, config.docsRoot), config };
}

/**
 * `git rev-parse --local-env-vars`: the variables that tell git which ONE
 * repository it is in. Written out rather than asked for, because asking is a
 * spawn that would itself need this list.
 */
export const GIT_LOCAL_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const;

/**
 * The environment every git spawn in the lint is given: this process's, minus
 * `GIT_LOCAL_ENV`, so git finds the repository from the `cwd` it is handed.
 *
 * A commit hook inherits `GIT_DIR` — from a linked worktree, always — and a git
 * told its directory but not its work tree takes the working directory as the
 * top level. From `packages/app/` in a monorepo, `ls-files` then answers with
 * paths relative to the wrong root and the lint reads files that do not exist.
 * Passed explicitly because a Bun spawn with no `env` inherits the environment
 * the process STARTED with, whatever has since been deleted from `process.env`.
 */
export function gitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of GIT_LOCAL_ENV) delete env[name];
  return env;
}

const boundaries = new Map<string, string>();

/**
 * The directory a link may not leave: the GIT repository, not `ctx.repoRoot`.
 *
 * `ctx.repoRoot` is where `.project-docs.json` sits, and in a monorepo that is
 * `packages/app/` — a link from there to the monorepo's `CONTRIBUTING.md`
 * resolves in every checkout and is not the machine-specific link this rule
 * exists to catch. So: git's top level, when it contains `ctx.repoRoot`;
 * otherwise `ctx.repoRoot` itself (no git, or an environment naming some other
 * repository). Returned in `ctx.repoRoot`'s own spelling — git answers with the
 * real path, and `/tmp` is a symlink on macOS.
 */
export function linkBoundary(ctx: Ctx): string {
  const cached = boundaries.get(ctx.repoRoot);
  if (cached !== undefined) return cached;
  let boundary = ctx.repoRoot;
  const out = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    cwd: ctx.repoRoot,
    env: gitEnv(),
  });
  const top = out.success ? new TextDecoder().decode(out.stdout).trim() : "";
  if (top && existsSync(top)) {
    const rel = relative(realpathSync(top), realpathSync(ctx.repoRoot));
    const nested =
      rel !== "" &&
      rel !== ".." &&
      !rel.startsWith(`..${sep}`) &&
      !isAbsolute(rel);
    if (nested)
      boundary = resolve(ctx.repoRoot, ...rel.split(sep).map(() => ".."));
  }
  boundaries.set(ctx.repoRoot, boundary);
  return boundary;
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
 * meta-document names would drift from this one the first time another is
 * added. `STYLE.md` is here as the prose contract beside `SCHEMA.md`'s
 * structural one; it is also a seeded page (`SEEDED_PAGES` in `seed.ts`).
 */
export const CONTRACT_BASENAMES = new Set([
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "SCHEMA.md",
  "STYLE.md",
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
    // A seeded PAGE is recorded like a template and read like a document: its
    // links are checked. Skipping it here would switch that off.
    if (SEEDED_PAGES.has(rel.split(sep).join("/"))) return false;
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
  for (const path of walkMarkdown(
    ctx.docsRoot,
    new Set(ctx.config.lint.skip)
  )) {
    const rel = relative(ctx.repoRoot, path);
    if (isTpl(path) && !excluded(rel)) out.push(rel);
  }
  return out.sort();
}

/** The fixed opening line of every template's header comment. */
export const TEMPLATE_HEADER_LINE = "OWNERSHIP (of this template file";

/**
 * A template's header comment: an HTML comment whose first text is
 * `TEMPLATE_HEADER_LINE`. Anchored to the comment's opening so that a document
 * QUOTING the line in prose — this check's own work item does — is not one,
 * and matched only outside code (see `blankCode`) so that a document quoting
 * the whole opening in a code block or span is not one either.
 */
const TEMPLATE_HEADER = /<!--\s*OWNERSHIP \(of this template file/;

/** Whether `text` still holds a template's header comment, outside code. */
export function hasTemplateHeader(text: string): boolean {
  return TEMPLATE_HEADER.test(blankCode(text));
}

/**
 * `md` with its code blanked to spaces, line breaks kept: fenced blocks (```
 * or `~~~`, three or more, closed by a run of the same character at least as
 * long, or running to the end of the file when never closed), indented code
 * blocks (four spaces or a tab, after a blank line or more indented code), and
 * inline code spans of any backtick run length, which may wrap lines but never
 * cross a blank one.
 *
 * Not `stripCode` from the portable core: that one knows backtick fences and
 * single-backtick spans only, and its link checker's behaviour is pinned by its
 * own tests, so widening it there would change what the link check reads.
 */
export function blankCode(md: string): string {
  const blank = (s: string) => s.replace(/[^\r\n]/g, " ");
  const out: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  let afterBlank = true;
  let inIndented = false;
  for (const raw of md.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1]![0] === fence.ch && close[1]!.length >= fence.len) fence = null;
      out.push(blank(raw));
      afterBlank = inIndented = false;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    // A backtick fence's info string may not hold a backtick: "```x```" is a span.
    if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      fence = { ch: open[1]![0]!, len: open[1]!.length };
      out.push(blank(raw));
      afterBlank = inIndented = false;
      continue;
    }
    if (line.trim() === "") {
      out.push(raw);
      afterBlank = true;
      continue;
    }
    if (/^( {4}|\t)/.test(line) && (afterBlank || inIndented)) {
      out.push(blank(raw));
      inIndented = true;
      afterBlank = false;
      continue;
    }
    out.push(raw);
    afterBlank = inIndented = false;
  }
  return blankSpans(out.join("\n"));
}

/** Inline code spans blanked: a run of N backticks to the next run of exactly N. */
function blankSpans(md: string): string {
  const chars = md.split("");
  const runAt = (i: number) => {
    let j = i;
    while (md[j] === "`") j++;
    return j - i;
  };
  let i = 0;
  while (i < md.length) {
    if (md[i] !== "`") {
      i++;
      continue;
    }
    const n = runAt(i);
    let j = i + n;
    let end = -1;
    while (j < md.length) {
      if (md[j] === "`") {
        const m = runAt(j);
        if (m === n) {
          end = j + m;
          break;
        }
        j += m;
        continue;
      }
      // A span never crosses a blank line: that ends the paragraph.
      if (md[j] === "\n" && /^\n[ \t]*\r?\n/.test(md.slice(j, j + 64))) break;
      j++;
    }
    if (end === -1) {
      i += n;
      continue;
    }
    for (let k = i; k < end; k++) if (chars[k] !== "\n" && chars[k] !== "\r") chars[k] = " ";
    i = end;
  }
  return chars.join("");
}

/**
 * Every document under the docs root that is not a template and still holds a
 * template's header comment, repo-relative and sorted. `pdocs new` copies the
 * header in as guidance for filling the document; once it is filled the header
 * is noise, and `pdocs check` says so as an advisory, never a problem.
 */
export function templateHeaderPaths(ctx: Ctx): string[] {
  const isTpl = templateTest(ctx);
  const excluded = excluder(ctx);
  const out: string[] = [];
  for (const path of walkMarkdown(ctx.docsRoot, new Set(ctx.config.lint.skip))) {
    const rel = relative(ctx.repoRoot, path);
    if (isTpl(path) || excluded(rel)) continue;
    if (hasTemplateHeader(readFileSync(path, "utf8"))) out.push(rel);
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
 * `registry.ts`; re-exported here for the readers that reach them through the
 * lint. See `registry.ts` for why the dependency runs that way.
 */
export { DURABLE_TYPE, ROOT_PAGE_TYPE, SPEC };

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
/** A UUID, lowercase — the one form `pdocs` writes and compares. Declared
 *  beside the generator in `uuid.ts`, so the writer and the lint share it. */
export { UUID_RE };
const TAG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The first H1 of a body, outside HTML comments and code fences: its index
 *  in `body.split("\n")`, or -1. */
export function firstHeading(body: string): number {
  const lines = body.split("\n");
  let comment = false;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!comment && /^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    if (comment) {
      if (line.includes("-->")) comment = false;
      continue;
    }
    if (/^\s*<!--/.test(line) && !line.includes("-->")) {
      comment = true;
      continue;
    }
    if (/^#\s/.test(line)) return i;
  }
  return -1;
}

/**
 * What a type's template leaves for the writer to replace, read off the
 * template the registry names — the project's own copy, so a project that
 * rewrote its template is held to its own placeholders.
 *
 * DELIBERATELY NARROW. Only the exact strings the template itself holds are
 * placeholders: a string field whose template value carries a bracketed prompt
 * (`description: "[One sentence: …]"`, a cycle's `appetite`; never `id`, which
 * `pdocs new` mints and BAD ID covers), any field left as `YYYY-MM-DD`, and
 * the first H1. A pattern such as "any bracketed text" would fire on real
 * documents — a `[WIP]` heading, a `- [ ]` checklist, a link — and a gate that
 * reports prose it cannot judge gets bypassed. The cost is that a document
 * written from an OLDER copy of a template is not caught once that template
 * changes; `pdocs new` writes from the current one.
 *
 * `tags` is judged by word, not against the template: see `PLACEHOLDER_TAGS`.
 */
export interface TemplatePlaceholders {
  /** Frontmatter key -> the template's placeholder value, unquoted. */
  fields: Map<string, string>;
  /** The template's first H1, whole line. */
  h1: string | null;
}

export function templatePlaceholders(
  ctx: Ctx,
  registry: ReadonlyMap<string, RegistryRow>
): Map<string, TemplatePlaceholders[]> {
  const out = new Map<string, TemplatePlaceholders[]>();
  for (const row of new Set(registry.values())) {
    if (row.template === null || row.externalTemplate) continue;
    const found: TemplatePlaceholders[] = [];
    for (const rel of [row.template].flat()) {
      const abs = join(ctx.repoRoot, rel);
      if (!existsSync(abs)) continue;
      const raw = readFileSync(abs, "utf8");
      const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
      if (!m) continue;
      const tpl = parseFrontmatter(m[1] as string);
      const fields = new Map<string, string>();
      for (const line of (m[1] as string).split("\n")) {
        const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
        if (!kv) continue;
        const key = kv[1] as string;
        const value = tpl.get(key) ?? "";
        // Read off the RAW text: unquoted, `"[One sentence…]"` and the list
        // `[area, area]` look alike.
        const rawValue = stripInlineComment(kv[2] as string).trim();
        if (value === "YYYY-MM-DD") fields.set(key, value);
        else if (
          key !== "id" &&
          rawValue !== "" &&
          !rawValue.startsWith("[") &&
          /\[[^\]]+\]/.test(value)
        )
          fields.set(key, value);
      }
      const body = raw.slice(m[0].length);
      const at = firstHeading(body);
      found.push({
        fields,
        h1: at === -1 ? null : ((body.split("\n")[at] as string).trim()),
      });
    }
    if (found.length) out.set(row.type, found);
  }
  return out;
}

/**
 * The words the templates use as tag PROMPTS — `[area, area]`,
 * `[area, feature]`. A template's other example tags (`[overview, product]`,
 * `[surface, flow]`) are real words a document may choose on purpose, so
 * `tags` is reported only when every tag is one of these.
 */
const PLACEHOLDER_TAGS = new Set(["area", "feature"]);

/** The PLACEHOLDER rows for one document. */
function placeholderProblems(
  rel: string,
  fields: ReadonlyMap<string, string>,
  body: string,
  placeholders: readonly TemplatePlaceholders[]
): string[] {
  const out = new Set<string>();
  const at = firstHeading(body);
  const h1 = at === -1 ? null : (body.split("\n")[at] as string).trim();
  const tags = yamlList(fields.get("tags"));
  if (placeholders.length && tags.length && tags.every((t) => PLACEHOLDER_TAGS.has(t)))
    out.add(`PLACEHOLDER    ${rel}: \`tags\` holds only placeholder words [${tags.join(", ")}]`);
  for (const p of placeholders) {
    for (const [key, value] of p.fields)
      if (fields.get(key) === value)
        out.add(`PLACEHOLDER    ${rel}: \`${key}\` is still the template's "${value}"`);
    if (h1 !== null && h1 === p.h1)
      out.add(`PLACEHOLDER    ${rel}: the H1 is still the template's "${h1}"`);
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------
// The workbench: presence and vocabulary
// ---------------------------------------------------------------------------------------

/** A workbench file: where it is, and the `type` its position says it must carry. */
export interface WorkbenchFile {
  path: string;
  rel: string;
  type: string;
  /** Set when an entity file (`feature.md`, `item.md`) sits where its entity
   *  cannot: the reason, for the `MISPLACED ENTITY` row. */
  misplaced?: string;
  /** Set when the file sits where no document can (loose in `features/`): the
   *  reason, for the `NOT AN ENTITY POSITION` row. No other field rule runs. */
  notEntity?: string;
}

/** The folders whose documents are typed by `ownedType` rather than by folder. */
const OWNER_FOLDERS = new Set([FEATURES_FOLDER, ITEMS_FOLDER]);

/** Every workbench file, paired with the `type` its position says it must carry. */
export function workbenchFiles(ctx: Ctx): WorkbenchFile[] {
  const skip = new Set([...ctx.config.lint.skip, "TEMPLATES"]);
  const excluded = excluder(ctx);
  const out: WorkbenchFile[] = [];

  // `features/_archive/`, `items/_archive/` and `cycles/_archive/` are read
  // whatever `lint.skip` says: the work rules are ABOUT the archive (only
  // finished work may sit there, an archived item still holds its id against
  // the deletion check, and an archived cycle still answers an item's
  // `cycle:`), so skipping it would switch those rules off rather than quiet
  // them.
  const ownerSkip = new Set([...skip].filter((name) => name !== "_archive"));

  for (const folder of ctx.config.lint.workbench) {
    const dir = join(ctx.docsRoot, folder);
    if (!existsSync(dir)) continue;
    const walkSkip =
      folder === FEATURES_FOLDER || folder === ITEMS_FOLDER || folder === CYCLES_FOLDER
        ? ownerSkip
        : skip;
    for (const path of walkMarkdown(dir, walkSkip)) {
      const rel = relative(ctx.repoRoot, path);
      if (excluded(rel)) continue;
      if (OWNER_FOLDERS.has(folder)) {
        const within = relative(dir, path).split(sep).join("/");
        const { type, misplaced, notEntity } = ownedPosition(folder, within);
        out.push({
          path,
          rel,
          type,
          ...(misplaced ? { misplaced } : {}),
          ...(notEntity ? { notEntity } : {}),
        });
        continue;
      }
      out.push({
        path,
        rel,
        type: SPEC[folder]?.type ?? ctx.config.lint.types[folder] ?? "",
      });
    }
  }
  return out;
}

/** `sessions` → `session`, and so on: `OWNER_SUBFOLDER` read backwards. */
const SUBFOLDER_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(OWNER_SUBFOLDER).map(([type, folder]) => [folder, type])
);

/** `feature.md` → `feature`, `item.md` → `item`: the owners' entity files. */
const ENTITY_FILE_TYPE: Record<string, string> = {
  [ENTITY_FILE[FEATURES_FOLDER]!.name]: ENTITY_FILE[FEATURES_FOLDER]!.type,
  [ENTITY_FILE[ITEMS_FOLDER]!.name]: ENTITY_FILE[ITEMS_FOLDER]!.type,
};

/**
 * The type a document's position inside an owner folder gives it.
 *
 * `owner` is the owner folder's name (`features` or `items`); `within` is the
 * path relative to it, `/`-separated. A leading `_archive/` is stripped first, so an
 * archived entity is typed exactly like a live one; an `_archive/` anywhere
 * deeper is just a folder of artifacts.
 */
export function ownedType(owner: string, within: string): string {
  return ownedPosition(owner, within).type;
}

function ownedPosition(
  owner: string,
  within: string
): { type: string; misplaced: string | null; notEntity?: string } {
  let segs = within.split("/");
  if (segs[0] === "_archive" && segs.length > 1)
    segs = segs.slice(1);

  const expected = ENTITY_FILE[owner];
  const misplace = (type: string) =>
    `a ${type} belongs at ${type === "item" ? `${ITEMS_FOLDER}/<slug>.md or ` : ""}` +
    `${type === "feature" ? FEATURES_FOLDER : ITEMS_FOLDER}/<slug>/${
      ENTITY_FILE[type === "feature" ? FEATURES_FOLDER : ITEMS_FOLDER]!.name
    }`;

  // Loose in the owner folder itself.
  if (segs.length === 1) {
    const name = segs[0] as string;
    // Under `items/` a loose file IS an item — `items/<slug>.md` — unless it
    // is a feature's entry file, which is in the wrong owner.
    if (owner === ITEMS_FOLDER)
      return name === ENTITY_FILE[FEATURES_FOLDER]!.name
        ? { type: "feature", misplaced: misplace("feature") }
        : { type: "item", misplaced: null };
    const entity = ENTITY_FILE_TYPE[name];
    if (entity) return { type: entity, misplaced: misplace(entity) };
    // A file loose in `features/` has no type a position can give it: every
    // feature is a folder. One finding says so; typing it `""` produced a
    // WRONG TYPE and a frozen-record row that named no type.
    return {
      type: "",
      misplaced: null,
      notEntity: `a file directly in ${FEATURES_FOLDER}/ must be a feature folder — move it to ${FEATURES_FOLDER}/<slug>/feature.md, or into a feature's artifacts/`,
    };
  }

  const rest = segs.slice(1);
  const name = rest[rest.length - 1] as string;
  const entity = ENTITY_FILE_TYPE[name];

  if (rest.length === 1) {
    if (entity)
      return {
        type: entity,
        misplaced: expected?.type === entity ? null : misplace(entity),
      };
    return { type: OWNED_FILE_TYPE[name] ?? "artifact", misplaced: null };
  }

  if (entity) return { type: entity, misplaced: misplace(entity) };
  return { type: SUBFOLDER_TYPE[rest[0] as string] ?? "artifact", misplaced: null };
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
 * The keys a document of `type` may carry: the universal required and optional
 * ones, `lifecycle` when the type has one, and the type's registry extras.
 * Every other key is an UNKNOWN FIELD. Exported so a migration that retypes a
 * document can pin the fields it keeps to this set rather than to a copy.
 */
export function allowedFields(
  type: string,
  registry: ReadonlyMap<string, RegistryRow> = defaultRegistryIndex()
): Set<string> {
  const row = registry.get(type);
  return new Set([
    ...REQUIRED,
    ...OPTIONAL,
    ...(row?.lifecycle ? ["lifecycle"] : []),
    ...(row?.extra ?? []),
  ]);
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
 * They used to come from two tables that could not answer for the same set, so
 * an extra field was structurally unavailable to the owned types, and nothing in
 * the code said so. The registry is passed
 * in rather than rebuilt per document; the default is exact, because neither
 * field depends on configuration.
 */
export function documentProblems(
  file: { path: string; rel: string; type: string },
  raw: string,
  docsRoot: string,
  requireTags: boolean,
  registry: ReadonlyMap<string, RegistryRow> = defaultRegistryIndex(),
  placeholders: readonly TemplatePlaceholders[] = []
): { problems: string[]; activeCycle: boolean; missing: string[] } {
  const { rel, type } = file;
  const problems: string[] = [];
  // The fields `pdocs report` lists, as data. The rows say the same thing for a
  // person; a record recovered from a row by pattern is only as whole as the
  // pattern, and a file name can look like any part of a row.
  const missing: string[] = [];

  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!m) {
    problems.push(`NO FRONTMATTER ${rel}  (see ${docsRoot}/SCHEMA.md)`);
    return { problems, activeCycle: false, missing: ["frontmatter"] };
  }

  const fields = parseFrontmatter(m[1] as string);
  const row = registry.get(type);
  const lifecycle = row?.lifecycle ?? null;
  const required = [
    ...REQUIRED,
    ...(requireTags ? ["tags"] : []),
    ...(row?.required ?? []),
  ];
  const allowed = allowedFields(type, registry);

  for (const key of required) if (!fields.get(key)) missing.push(key);
  if (lifecycle && !fields.get("lifecycle")) missing.push("lifecycle");
  for (const key of missing) problems.push(`MISSING ${key}   ${rel}`);
  // The key set is closed, so a file that is somebody else's format — a draft
  // of a Claude Code `SKILL.md`, with `name:` — cannot be made to pass by
  // adding fields: the key that makes it what it is stays unknown. The way out
  // is `lint.exclude`, and the row says so. ONLY when `type` is absent too: on
  // a document that declares a type, a stray key is a key to remove, and a gate
  // that offers exclusion beside every finding is teaching its own bypass.
  const foreign = fields.get("type")
    ? ""
    : "  (not a project-docs document? add it to `lint.exclude` in .project-docs.json)";
  for (const key of fields.keys())
    if (!allowed.has(key))
      problems.push(`UNKNOWN FIELD  ${rel}: "${key}"${foreign}`);

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

  // The work-item fields with a closed shape, checked only where the row
  // declares them: on any other type the key is already an UNKNOWN FIELD.
  const declares = (key: string) => row?.extra.includes(key) === true;
  const id = fields.get("id");
  if (id && declares("id")) {
    if (UUID_RE.test(id.toLowerCase()) && id !== id.toLowerCase())
      problems.push(`BAD ID         ${rel}: "${id}"  (lowercase)`);
    else if (!UUID_RE.test(id))
      problems.push(`BAD ID         ${rel}: "${id}"  (expected a UUID)`);
  }
  const kind = fields.get("kind");
  if (kind && declares("kind") && !KINDS.includes(kind))
    problems.push(`BAD KIND       ${rel}: "${kind}"  (${KINDS.join(" | ")})`);
  const priority = fields.get("priority");
  if (priority && declares("priority") && !PRIORITIES.includes(priority))
    problems.push(
      `BAD PRIORITY   ${rel}: "${priority}"  (${PRIORITIES.join(" | ")})`
    );

  // Superseded by `generated.at` in OKF 0.2, and rejected rather than ignored
  // so a document cannot carry two disagreeing dates.
  for (const legacy of ["date", "timestamp", "updated"])
    if (fields.has(legacy))
      problems.push(
        `LEGACY FIELD   ${rel}: \`${legacy}\` is superseded by \`generated.at\` (OKF 0.2 §13.1)`
      );

  // A list, flow or block. `tags: a,b` is a string to every YAML reader, and
  // `yamlList` would have split it and passed it.
  const rawTags = fields.get("tags");
  // Read quoted-ness off the raw line: the parser unquotes, so `"[a, b]"` — a
  // string — comes back looking like the list `[a, b]`.
  const quotedTags = /^tags:\s*["']/m.test(m[1] as string);
  if (rawTags && (quotedTags || (!/^\[/.test(rawTags) && !/^-\s/.test(rawTags))))
    problems.push(
      `BAD TAGS       ${rel}: "${rawTags}"  (a list: [${yamlList(rawTags).join(", ")}])`
    );
  for (const tag of yamlList(rawTags))
    if (!TAG_RE.test(tag))
      problems.push(`BAD TAG        ${rel}: "${tag}"  (kebab-case)`);

  problems.push(
    ...placeholderProblems(rel, fields, raw.slice(m[0].length), placeholders)
  );

  return { problems, activeCycle, missing };
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
  return libraryFindings(ctx).problems;
}

/** A document's missing fields, as `documentProblems` found them. */
type MissingRecord = { rel: string; missing: string[] };

function libraryFindings(ctx: Ctx): {
  problems: string[];
  missing: MissingRecord[];
} {
  const registry = registryIndex(ctx.config);
  const placeholders = templatePlaceholders(ctx, registry);
  const isTpl = templateTest(ctx);
  const problems: string[] = [];
  const missing: MissingRecord[] = [];
  for (const file of libraryFiles(ctx)) {
    if (CONTRACT_BASENAMES.has(basename(file.path)) || isTpl(file.path))
      continue;
    const r = documentProblems(
      file,
      readFileSync(file.path, "utf8"),
      ctx.config.docsRoot,
      true,
      registry,
      placeholders.get(file.type)
    );
    problems.push(...r.problems);
    missing.push({ rel: file.rel, missing: r.missing });
  }
  return { problems, missing };
}

export function thinTier(ctx: Ctx): string[] {
  return thinFindings(ctx).problems;
}

/**
 * A workbench document as the thin pass read it: its position, its type, and
 * its frontmatter. The corpus rules (`work.ts`) take these rather than walking
 * the tree a second time.
 */
export interface WorkbenchDocument {
  /** Repo-relative. */
  rel: string;
  type: string;
  /** Parsed frontmatter; empty when the document has none. */
  fields: ReadonlyMap<string, string>;
  /** True when its position is wrong for its entity (`MISPLACED ENTITY`). */
  misplaced: boolean;
}

/** Every non-template, non-contract workbench document, read once. */
export function workbenchDocuments(ctx: Ctx): WorkbenchDocument[] {
  return thinFindings(ctx).documents;
}

/** The thin tier's problems and the documents it read, from one walk. */
export function thinReport(ctx: Ctx): {
  problems: string[];
  documents: WorkbenchDocument[];
} {
  const { problems, documents } = thinFindings(ctx);
  return { problems, documents };
}

function thinFindings(ctx: Ctx): {
  problems: string[];
  missing: MissingRecord[];
  documents: WorkbenchDocument[];
} {
  const registry = registryIndex(ctx.config);
  const placeholders = templatePlaceholders(ctx, registry);
  const isTpl = templateTest(ctx);
  const problems: string[] = [];
  const missing: MissingRecord[] = [];
  const documents: WorkbenchDocument[] = [];
  const activeCycles: string[] = [];

  for (const file of workbenchFiles(ctx)) {
    const { path, rel } = file;
    const raw = readFileSync(path, "utf8");
    const name = basename(path);

    // Links are checked on every file including the folder READMEs, which are
    // the contracts and cross-link each other constantly. Templates are the one
    // exception: their links are placeholders.
    if (!isTpl(path)) {
      for (const bad of checkLinks(path, raw, { repoRoot: linkBoundary(ctx) })
        .problems) {
        problems.push(
          bad.kind === "MISSING FILE"
            ? `MISSING FILE   ${rel}: ${bad.target}${bad.outside ? OUTSIDE_REPOSITORY : ""}`
            : `MISSING ANCHOR ${rel}: ${bad.target}  (#${bad.anchor} not a heading)`
        );
      }
    }

    if (CONTRACT_BASENAMES.has(name) || isTpl(path)) continue;

    if (file.notEntity) {
      problems.push(`NOT AN ENTITY POSITION  ${rel}: ${file.notEntity}`);
      continue;
    }
    if (file.misplaced)
      problems.push(`MISPLACED ENTITY  ${rel}  (${file.misplaced})`);

    const r = documentProblems(
      file,
      raw,
      ctx.config.docsRoot,
      false,
      registry,
      placeholders.get(file.type)
    );
    problems.push(...r.problems);
    missing.push({ rel, missing: r.missing });
    const m = /^---\n([\s\S]*?)\n---/.exec(raw);
    documents.push({
      rel,
      type: file.type,
      fields: m ? parseFrontmatter(m[1] as string) : new Map(),
      misplaced: file.misplaced !== undefined,
    });
    if (r.activeCycle) activeCycles.push(rel);
  }

  // The rule a cycle exists for: two answers to "what are we doing" is the
  // state it prevents.
  if (activeCycles.length > 1)
    problems.push(
      `TWO ACTIVE CYCLES  ${activeCycles.join(", ")}  (at most one cycle is \`lifecycle: active\`)`
    );

  return { problems, missing, documents };
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
    // A library page may link out of the docs root, not out of the repository.
    repoRoot: linkBoundary(ctx),
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
      isTpl(join(ctx.docsRoot, rel)) ||
      excluded(join(ctx.config.docsRoot, rel)),
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

/**
 * SCHEMA.md's "State groups" table, parsed: state → group.
 *
 * Columns are Group · State · Means, one row per state. Same parsing rules as
 * `schemaLifecycles`: rows only after the alignment row, cells trimmed, and a
 * backticked name in each of the first two cells.
 */
export function schemaStateGroups(schema: string): Map<string, string> {
  const out = new Map<string, string>();
  const section = /\n## State groups\n([\s\S]*?)(?:\n## |$)/.exec(schema);
  if (!section) return out;
  let inBody = false;
  for (const line of (section[1] as string).split("\n")) {
    if (/^\|\s*:?-+:?\s*\|/.test(line)) {
      inBody = true;
      continue;
    }
    if (!inBody) continue;
    const m = /^\|\s*`([a-z-]+)`\s*\|\s*`([a-z-]+)`\s*\|/.exec(line);
    if (m) out.set(m[2] as string, m[1] as string);
  }
  return out;
}

/** The state-groups table against `STATE_GROUP`, the way the lifecycle table
 *  is checked against the registry. */
function stateGroupChecks(schema: string): string[] {
  const stated = schemaStateGroups(schema);
  if (stated.size === 0)
    return [
      'NO STATE GROUPS TABLE  SCHEMA.md: no parsable "## State groups" section',
    ];
  const problems: string[] = [];
  for (const [state, group] of Object.entries(STATE_GROUP)) {
    const want = stated.get(state);
    if (want === undefined)
      problems.push(
        `SCHEMA MISSING STATE  SCHEMA.md: the lint groups \`${state}\` as \`${group}\`, the State groups table omits it`
      );
    else if (want !== group)
      problems.push(
        `SCHEMA DISAGREES  state \`${state}\`: SCHEMA.md groups it "${want}", the lint enforces "${group}"`
      );
  }
  for (const state of stated.keys())
    if (!(state in STATE_GROUP))
      problems.push(
        `SCHEMA EXTRA STATE  SCHEMA.md groups \`${state}\`, which the lint knows nothing about`
      );
  return problems;
}

export function schemaTableChecks(schema: string): string[] {
  const groups = stateGroupChecks(schema);
  const stated = schemaLifecycles(schema);
  if (stated.size === 0)
    return [
      'NO SCHEMA TABLE  SCHEMA.md: no parsable "## Lifecycle by type" section',
      ...groups,
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

  return [...problems, ...groups];
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

/** Which pass found a document: the same two words `pdocs check` uses. */
export type ReportTier = "library" | "workbench";

/**
 * One document with something to backfill, as data: `path` is repo-relative,
 * `missing` is the required fields it lacks — or the single word `frontmatter`
 * when it has no block at all, exactly as the text report groups it.
 */
export interface ReportDocument {
  path: string;
  tier: ReportTier;
  missing: string[];
}

/** Every missing field, by field, with the slide decks already taken out. */
function missingFields(ctx: Ctx): {
  missing: Map<string, string[]>;
  tiers: Map<string, ReportTier>;
  decks: string[];
} {
  const missing = new Map<string, string[]>();
  const tiers = new Map<string, ReportTier>();
  const note = (field: string, rel: string, tier: ReportTier) => {
    missing.set(field, [...(missing.get(field) ?? []), rel]);
    tiers.set(rel, tier);
  };

  // From the findings, never from the rows: a row is for a person, and a path
  // recovered from one by pattern is truncated by any name that looks like the
  // row's own punctuation. A broken link is not here at all — it is a defect
  // to fix, not a blank to fill, and this is the one report that never fails.
  const found: Array<[ReportTier, MissingRecord[]]> = [
    ["workbench", thinFindings(ctx).missing],
    ["library", libraryFindings(ctx).missing],
  ];
  for (const [tier, records] of found)
    for (const { rel, missing: fields } of records)
      for (const field of fields) note(field, rel, tier);

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
    if (m && looksLikeSlideDeck(parseFrontmatter(m[1] as string)))
      decks.push(rel);
  }
  for (const [field, rels] of [...missing]) {
    const kept = rels.filter((r) => !decks.includes(r));
    if (kept.length) missing.set(field, kept);
    else missing.delete(field);
  }
  return { missing, tiers, decks };
}

/**
 * The worklist's one order: fields by how many documents lack them, then
 * folders by the same, then paths by name. `reportLines` prints it and
 * `reportDocuments` walks it, so the records arrive in the order the text
 * names them and neither can be re-sorted without the other.
 */
function worklistOrder(
  missing: ReadonlyMap<string, string[]>
): Array<{ field: string; count: number; folders: Array<[string, string[]]> }> {
  return [...missing]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([field, rels]) => {
      const byFolder = new Map<string, string[]>();
      for (const rel of [...rels].sort()) {
        const folder = dirname(rel);
        byFolder.set(folder, [...(byFolder.get(folder) ?? []), rel]);
      }
      return {
        field,
        count: rels.length,
        folders: [...byFolder].sort((a, b) => b[1].length - a[1].length),
      };
    });
}

/**
 * The report as records: one per document with anything missing, none for a
 * document that is complete or a file that looks like a slide deck.
 *
 * The text report rolls a folder up and names ten of its files, which is the
 * right shape for a person and the wrong one for a backfill split across
 * workers — that needs every path, with its fields, without parsing a line.
 * Same findings, same order (a document sits where the text first names it,
 * its fields in the order the text groups them); nothing here is re-derived.
 */
function documentsOf(
  missing: ReadonlyMap<string, string[]>,
  tiers: ReadonlyMap<string, ReportTier>
): ReportDocument[] {
  const byPath = new Map<string, ReportDocument>();
  for (const { field, folders } of worklistOrder(missing))
    for (const [, paths] of folders)
      for (const path of paths) {
        const doc = byPath.get(path) ?? {
          path,
          tier: tiers.get(path) ?? "workbench",
          missing: [],
        };
        doc.missing.push(field);
        byPath.set(path, doc);
      }
  return [...byPath.values()];
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
  return reportWorklist(ctx).lines;
}

/** The records alone — see `documentsOf`. */
export function reportDocuments(ctx: Ctx): ReportDocument[] {
  return reportWorklist(ctx).documents;
}

/** Both renderings of one walk: the text `pdocs report` prints, and the records. */
export function reportWorklist(ctx: Ctx): {
  lines: string[];
  documents: ReportDocument[];
} {
  const { missing, tiers, decks } = missingFields(ctx);

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
  for (const { field, count, folders } of worklistOrder(missing)) {
    lines.push(`${field}  (${count})`);
    for (const [folder, paths] of folders) {
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
  return { lines, documents: documentsOf(missing, tiers) };
}
