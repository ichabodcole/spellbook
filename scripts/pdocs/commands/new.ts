// `pdocs new <type> <name>` — create a document the way its type says to.
//
// ONE CODE PATH, DRIVEN BY THE ROW. Nothing below branches on a type name, and
// that is the property the design resolution exists to protect: the eighteen
// creatable types differ along four declared axes — where the file goes, what
// it is called, which template seeds it, and what has to be true before it may
// be written — and every one of those is a field on `RegistryRow`. A type this
// file cannot express is a type the registry has failed to declare, and the fix
// is a new member there rather than an `if` here.
//
// THE ONE THING it does that a "copy a template" command would not is ADD THE
// CATALOG LINE for a library page. A library page must be reachable from
// `index.md` (`ORPHAN`) and its catalog hook must repeat its own `description`
// verbatim (`hookChecks`), so writing only the document leaves an
// immediately-dirty tree. `new` writes both, and reports both.
//
// It does NOT own content. It fills frontmatter and, below it, only the H1 —
// the heading that states the title; the body's instructional comments are
// copied intact. The frontmatter's inline guidance comments (`status: draft #
// OKF §5.4…`) are not: they described the template's blanks, and a document
// is not a template (retired at triage, 2026-09-26).
//
// That boundary cost something to hold. The templates used to carry 26 example
// links to filenames that never existed — `[Related playbook 1](./other-playbook.md)`,
// `[External documentation](URL)` — so a verbatim copy was up to five
// `MISSING FILE`s the moment it was written. The first version of this file
// rewrote them at runtime. That was reversed in favour of fixing the templates
// once, as inline code, in a diff a reader can see: it fixes the same defect
// for someone copying a template BY HAND, which is still the majority path,
// and it keeps this command out of the business of editing prose. The links
// that a real workflow makes resolve — the owner link `--owner` writes — are left as
// live links, and `new` neither adds nor removes one.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Command, Invocation } from "../cli.ts";
import {
  parseFrontmatter,
  stripInlineComment,
  yamlList,
} from "../docs-lint/index.ts";
import {
  CliError,
  ConflictError,
  ErrorKind,
  ExitCode,
  NotFoundError,
  UsageError,
  printEnvelope,
} from "../envelope.ts";
import { OKF_STATUS, type Ctx, firstHeading } from "../lint/rules.ts";
import {
  ENTITY_FILE,
  type ExistingDocument,
  FEATURES_FOLDER,
  FIELD_VALUES,
  ITEMS_FOLDER,
  KINDS,
  type RegistryRow,
  defaultRegistryIndex,
  registryIndex,
  retiredWordReason,
} from "../lint/registry.ts";
import { collectPages, pageKeys } from "../pages.ts";
import { uuidv7 } from "../uuid.ts";
import {
  type WorkEntity,
  type WorkModel,
  collectWork,
  CYCLE_FLAG_NOTE,
  cyclesNamed,
  entitiesBySlug,
  refFor,
  resolveRef,
  modelIds,
  shortId,
  entityOf,
} from "../work.ts";
import { type Advisory, adviseReview, advisoryLines } from "../advisories.ts";
import { reviewGuard } from "../review-guard.ts";
import { promoteItem } from "./promote.ts";
import { movedTo } from "../links-rewrite.ts";

/** `data` in the envelope. */
export interface NewData {
  /** Repo-relative path of the document that was written. */
  path: string;
  /** The registry type it was written as — the alias resolved, not as typed. */
  type: string;
  /** Every file written or modified, document first. */
  created: string[];
  /** The item's new entry file, when `--owner` promoted a single-file item
   *  to a folder to write into it; `null` otherwise. */
  promoted: string | null;
  /** A new work item's full id; `null` for every other type (D25: JSON
   *  always carries the full id, text prints its shortest unique prefix, 12+ characters — D25). */
  id: string | null;
  /**
   * The `work-item-review` advisory when a new item is filed into started work
   * or into the active cycle without `--status stable`; `bad-config` when
   * `checks.workItemReview` is invalid. Empty otherwise.
   */
  advisories: Advisory[];
}

// ---------------------------------------------------------------------------------------
// Small shared shapes
// ---------------------------------------------------------------------------------------

const PRINT_WIDTH = 80;

/** Today, in the machine's own timezone. `toISOString` is UTC and is wrong by a
 *  day for most of the planet for part of every day. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * A caller's `<name>` as a filename slug. Forgiving on input, strict on output:
 * a slug reaches the tree as a FILENAME and as half of every address written
 * against it.
 *
 * `.` survives the character filter because real names carry it —
 * `OAuth 2.0 / upgrade` is `oauth-2.0-upgrade` — and that is exactly what made
 * the pre-9.0.0 `pdocs new project ".."` write `docs/proposal.md`, outside any
 * owner folder, and report `ok: true`. A dot is legal INSIDE a slug and never at either end,
 * so `..` and `...` have nothing left once the ends are trimmed, and the
 * emptiness check that was already here refuses them.
 *
 * The final test is for a letter or a digit rather than for non-emptiness,
 * because `.-.` trims to `-.-`… and because the documented rule — `references/pdocs.md`
 * says "a name with no letters or digits in it is a usage error" — was true of
 * `"!!!"` and false of `"..."`. Now it is true of both.
 *
 * This is the first of two guards. Escaping a slug is not the only way to leave
 * the tree — an `--owner` reference is resolved, not slugged — so `assertInside`
 * checks the RESOLVED path as well. A sanitizer and a containment check are
 * different claims and the writer/checker contract needs both.
 */
export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!/[a-z0-9]/.test(slug))
    throw new UsageError(
      `\`${name}\` has no slug in it — a name becomes a filename, so it needs letters or digits.`
    );
  return slug;
}

/**
 * Refuse to write outside the tree, whatever produced the path.
 *
 * `existsSync(ownerDir)` is not this check and never was: it asks whether a
 * directory is there, and `docs/..` is very much there. The pre-9.0.0
 * `pdocs new project ".."` resolved to the repository root, wrote `docs/proposal.md` — the docs root's
 * own parent, where no type is declared — and reported success with exit 0.
 * The document it wrote was `BAD type` and `ORPHAN` on the very next
 * `pdocs check`: the writer and the checker, which read one registry precisely
 * so they cannot disagree, disagreeing.
 *
 * Compared on the RESOLVED paths, with a trailing separator, so `docs-old/` is
 * not accepted as a child of `docs/`. `resolve` also flattens the `..` that is
 * the whole point.
 */
export function assertInside(docsRoot: string, target: string): string {
  const root = resolve(docsRoot);
  const abs = resolve(target);
  if (abs !== root && !abs.startsWith(root + sep))
    throw new UsageError(
      `refusing to write outside the docs root: ${abs} is not under ${root}.`
    );
  return abs;
}

/**
 * `oauth-upgrade` -> `Oauth Upgrade`. Only a default: `--title` overrides it,
 * and any caller that cares should pass one.
 *
 * The date prefix and the suffix the ROW enforces are stripped first, because
 * they are the grammar rather than the name — `2026-10-auth` is the auth cycle,
 * not a document called "2026 10 Auth". Which parts to strip comes off the row,
 * so this stays one rule for eighteen types.
 */
export function titleFromSlug(row: RegistryRow, slug: string): string {
  let base = slug;
  const shape = row.filename;
  if (shape.kind === "slug") {
    if (shape.date === "day") base = base.replace(/^\d{4}-\d{2}-\d{2}-/, "");
    else if (shape.date === "month") base = base.replace(/^\d{4}-\d{2}-/, "");
    if (shape.suffix !== undefined)
      base = base.replace(new RegExp(`-${shape.suffix}$`), "");
  }
  return (base || slug)
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Greedy fill to `width`, never breaking a token. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

// ---------------------------------------------------------------------------------------
// Resolving the type
// ---------------------------------------------------------------------------------------

export interface ResolvedType {
  row: RegistryRow;
  /** True when the positional names the project folder rather than the slug. */
  namesScope: boolean;
}

/**
 * The type argument, resolved to its registry row.
 *
 * A row that is not creatable is refused with the reason the REGISTRY gives,
 * quoted verbatim. That is deliberate rather than a null-template accident:
 * `kickoff` and `artifact` both have a reason worth reading, and a command that
 * said "no template" would be telling the caller about the implementation
 * instead of about the decision.
 */
export function resolveType(ctx: Ctx, typeArg: string): ResolvedType {
  const registry = registryIndex(ctx.config);
  const row = registry.get(typeArg);
  // The closed set, read off the registry rather than written beside it — the
  // same list `check` enforces and `new` writes from. It is enumerated in prose
  // AND as `choices`, and both refusals below hand it over: a caller who named
  // a type pdocs will not create needs the set exactly as much as one who named
  // a type that does not exist.
  const creatable = (): string[] =>
    [...registry.values()].filter((r) => r.creatable).map((r) => r.type).sort();

  if (!row) {
    const retired = retiredWordReason(typeArg, ctx.config);
    if (retired !== null)
      throw new UsageError(`${retired}.`, {
        token: typeArg,
        choices: creatable(),
        hint: `Creatable: ${creatable().join(", ")}.`,
      });
    const choices = creatable();
    throw new UsageError(
      `unknown type \`${typeArg}\`. Creatable: ${choices.join(", ")}.`,
      { token: typeArg, choices }
    );
  }

  if (!row.creatable)
    throw new UsageError(
      `\`${row.type}\` is not created by pdocs — ${row.uncreatableReason}.`,
      {
        token: typeArg,
        choices: creatable(),
        hint: `Creatable: ${creatable().join(", ")}.`,
      }
    );

  return { row, namesScope: row.namesScope === true };
}

// ---------------------------------------------------------------------------------------
// Resolving the path
// ---------------------------------------------------------------------------------------

/** Where a document goes, and — for an owned document — what owns it. */
export interface Placement {
  /** The directory the document is written into. */
  dir: string;
  /** The owner's folder, for an owned document or an entity that opens one. */
  ownerDir: string | null;
  /** The owner's entry file (`feature.md` or `item.md`) as it will be once written — after any promotion. `new`
   *  links it from the document (D17). `null` when there is nothing to link. */
  entry: string | null;
  ownerTitle: string | null;
  /** A single-file item to promote to a folder before writing into it. */
  promote: WorkEntity | null;
}

/** The owner folder whose entry file is this row's type: `features` for `feature`. */
function ownerFolderOf(row: RegistryRow): string {
  const found = Object.entries(ENTITY_FILE).find(([, e]) => e.type === row.type);
  if (!found)
    throw new CliError(
      `the \`${row.type}\` row names its scope but no owner folder has it as its entry file.`,
      ErrorKind.Internal,
      ExitCode.Internal
    );
  return found[0];
}

const OWNER_FORMS = "`--owner feature/<slug>` or `--owner item/<slug-or-id>`";

/**
 * The directory a row's documents live in.
 *
 * - A `docs` or `root` row: its folder under the docs root. `--owner` is refused.
 * - A row that names its scope (`feature`): the positional is the folder it
 *   opens, `features/<slug>/`.
 * - An owned row (plan, session, …): `--owner` names a feature or an item,
 *   resolved like every other reference (`resolveRef`). A single-file item is
 *   promoted to a folder first — by the caller, just before writing, so a
 *   refusal leaves the tree alone.
 */
export function resolveDirectory(
  ctx: Ctx,
  row: RegistryRow,
  name: string | undefined,
  owner: string | undefined,
  model: () => WorkModel
): Placement {
  const none = { entry: null, ownerTitle: null, promote: null };
  if (row.scope !== "owner") {
    if (owner !== undefined)
      throw new UsageError(
        `a \`${row.type}\` does not live inside a feature or an item — drop --owner.`
      );
    return {
      dir: row.folder ? join(ctx.docsRoot, row.folder) : ctx.docsRoot,
      ownerDir: null,
      ...none,
    };
  }

  if (row.namesScope) {
    if (owner !== undefined)
      throw new UsageError(
        `a \`${row.type}\` is not owned by anything — \`pdocs new ${row.type} <slug>\` opens its own folder; drop --owner.`
      );
    if (name === undefined)
      throw new UsageError(
        `\`${row.type}\` needs a name — the folder to open, e.g. \`pdocs new ${row.type} oauth-upgrade\`.`
      );
    const ownerDir = assertInside(
      ctx.docsRoot,
      join(ctx.docsRoot, ownerFolderOf(row), slugify(name))
    );
    return { dir: ownerDir, ownerDir, ...none };
  }

  if (owner === undefined)
    throw new UsageError(
      `a \`${row.type}\` lives inside a feature or an item — pass ${OWNER_FORMS}.`
    );

  const e = resolveRef(model(), owner, ["feature", "item"]);
  const entryNow = join(ctx.repoRoot, e.path);
  const promote = e.entity === "item" && e.folder === null ? e : null;
  const ownerDir = promote ? entryNow.slice(0, -".md".length) : dirname(entryNow);
  const entry = promote ? join(ownerDir, ENTITY_FILE[ITEMS_FOLDER]!.name) : entryNow;
  return {
    dir: row.folder ? join(ownerDir, row.folder) : ownerDir,
    ownerDir,
    entry,
    ownerTitle: e.title ?? e.slug,
    promote,
  };
}

/** A document's `title`, or its file name. */
function titleOf(abs: string): string {
  const fields = parseFrontmatter(
    /^---\n([\s\S]*?)\n---/.exec(readFileSync(abs, "utf8"))?.[1] ?? ""
  );
  return fields.get("title") ?? basename(abs, ".md");
}

/** The next `NN` for a numbered folder: the highest already there, plus one. */
export function nextNumber(dir: string): string {
  let max = 0;
  if (existsSync(dir))
    for (const name of readdirSync(dir)) {
      const m = /^(\d+)-/.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
  return String(max + 1).padStart(2, "0");
}

/**
 * The filename the row's grammar produces.
 *
 * THE CALLER GETS A NAME THEY DID NOT LITERALLY TYPE, and that is the approved
 * decision: `new` enforces the date prefix and the suffix where a type declares
 * one, so the convention stops being something a human has to remember. A name
 * that ALREADY carries the prefix or the suffix is honoured as written —
 * `pdocs new cycle 2026-10-tooling` names next month's cycle, not this month's.
 */
export function resolveFilename(
  row: RegistryRow,
  name: string | undefined,
  dir: string,
  date: string
): string {
  const shape = row.filename;

  if (shape.kind === "fixed") return shape.name;

  if (shape.kind === "freeform")
    // Unreachable: `freeform` is declared only on rows that are not creatable,
    // and `resolveType` has already refused those. Stated anyway, because the
    // registry could grow a creatable freeform row and silence is the wrong
    // failure.
    throw new UsageError(
      `\`${row.type}\` has no filename grammar — pdocs cannot name one for you.`
    );

  if (name === undefined)
    throw new UsageError(
      `a \`${row.type}\` needs a name — \`pdocs new ${row.type} <name>\`.`
    );
  const slug = slugify(name);

  if (shape.kind === "numbered") return `${nextNumber(dir)}-${slug}.md`;

  const prefix =
    shape.date === "day"
      ? /^\d{4}-\d{2}-\d{2}-/.test(slug)
        ? ""
        : `${date}-`
      : shape.date === "month"
        ? /^\d{4}-\d{2}-/.test(slug)
          ? ""
          : `${date.slice(0, 7)}-`
        : "";

  const suffix =
    shape.suffix !== undefined && !slug.endsWith(`-${shape.suffix}`)
      ? `-${shape.suffix}`
      : "";

  return `${prefix}${slug}${suffix}.md`;
}

// ---------------------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------------------

/** `specifications/TEMPLATE-domain.md` -> `domain`. Derived, so a third variant
 *  needs no second table naming it. */
export function variantName(template: string): string {
  return basename(template, ".md")
    .split(/[-_.]/)
    .filter((token) => !/^template$/i.test(token))
    .join("-")
    .toLowerCase();
}

/** Which template seeds this document. `--variant` chooses among a set. */
export function resolveTemplate(
  row: RegistryRow,
  variant: string | undefined
): string {
  if (row.template === null)
    throw new CliError(
      `the \`${row.type}\` registry row declares no template but is marked creatable.`,
      ErrorKind.Internal,
      ExitCode.Internal
    );

  if (!Array.isArray(row.template)) {
    if (variant !== undefined)
      throw new UsageError(
        `\`${row.type}\` has one template — \`--variant\` selects nothing.`
      );
    return row.template;
  }

  const choices = row.template.map((t) => [variantName(t), t] as const);
  const names = choices.map(([v]) => v);
  const list = names.join(", ");
  if (variant === undefined)
    throw new UsageError(
      `\`${row.type}\` has ${choices.length} templates — pass \`--variant <${list.replace(/, /g, "|")}>\`.`,
      { choices: names }
    );
  const chosen = choices.find(([v]) => v === variant);
  if (!chosen)
    throw new UsageError(
      `--variant: \`${variant}\` is not a ${row.type} template — expected one of ${list}.`,
      { token: variant, choices: names }
    );
  return chosen[1];
}

/** The frontmatter block and everything after it. */
export function splitDocument(raw: string): { block: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m)
    throw new CliError(
      "template has no frontmatter block.",
      ErrorKind.Internal,
      ExitCode.Internal
    );
  return { block: m[1] as string, body: raw.slice(m[0].length) };
}

// ---------------------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------------------

/**
 * The template's frontmatter without its inline guidance comments.
 *
 * `status: draft # OKF §5.4: draft | stable | deprecated` teaches whoever
 * copies the template by hand, and it is noise in every document written from
 * it — worse, a comment beside a value reads as part of the record. Stripped at
 * write time rather than deleted from the templates: a template is the
 * project's to edit (a migration only updates an untouched one), so the
 * comments stay where a person copying by hand reads them, and a project's own
 * edited template is stripped the same way. Whole-line `#` comments go too.
 */
export function stripFrontmatterComments(block: string): string {
  const out: string[] = [];
  // Inside a multi-line quoted scalar: which quote closes it.
  let quote: '"' | "'" | null = null;
  // Inside a `|` or `>` block scalar: every indented or blank line is content.
  let block_ = false;
  for (const line of block.split("\n")) {
    if (quote !== null) {
      const close = closingQuote(line, quote);
      if (close === -1) {
        out.push(line);
        continue;
      }
      quote = null;
      out.push(line.slice(0, close + 1) + stripInlineComment(line.slice(close + 1)).trimEnd());
      continue;
    }
    if (block_) {
      if (line.trim() === "" || /^\s/.test(line)) {
        out.push(line);
        continue;
      }
      block_ = false;
    }
    // A whole-line comment, at the top level only.
    if (/^#/.test(line)) continue;

    const kv = /^([A-Za-z_][\w-]*:)(\s*)(.*)$/.exec(line);
    const item = kv ? null : /^(\s*-\s+)(.*)$/.exec(line);
    const cont = kv || item ? null : /^(\s+)(.*)$/.exec(line);
    const [lead, value] = kv
      ? [`${kv[1]}${kv[2]}`, kv[3] as string]
      : item
        ? [item[1] as string, item[2] as string]
        : cont
          ? [cont[1] as string, cont[2] as string]
          : ["", line];
    const opener = value.charAt(0);
    if (opener === '"' || opener === "'") {
      const close = closingQuote(value.slice(1), opener);
      if (close === -1) {
        quote = opener;
        out.push(line);
        continue;
      }
    }
    // A continuation of a plain scalar is left as written: whether its `#`
    // is a comment is a question a real YAML parser answers differently.
    if (cont) {
      out.push(line);
      continue;
    }
    const stripped = stripInlineComment(value).trimEnd();
    if (/^[|>][-+0-9]*$/.test(stripped)) block_ = true;
    out.push(stripped ? `${lead}${stripped}` : lead.trimEnd());
  }
  return out.join("\n");
}

/** Where `quote` closes a scalar on this line, or -1: `\"` escapes a double
 *  quote, `''` a single one. */
function closingQuote(text: string, quote: '"' | "'"): number {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === '"' && c === "\\") i++;
    else if (quote === "'" && c === "'" && text[i + 1] === "'") i++;
    else if (c === quote) return i;
  }
  return -1;
}

/** Keys whose value is a list whatever the template says — a type whose
 *  template carries no `tags:` still takes `--tags a,b` as `[a, b]`. */
export const LIST_FIELDS: ReadonlySet<string> = new Set(["tags", "related", "blocked_by", "after"]);

/** The template's own date placeholder, filled with today where it is left. */
const DATE_PLACEHOLDER = "YYYY-MM-DD";

/**
 * Which of the template's keys hold a SEQUENCE — flow (`[a, b]`) or block
 * (`- a`) — so a `--flag a,b` is written back in the shape the key already had.
 *
 * Read off the RAW block rather than off `parseFrontmatter`, and that is not a
 * detail: the parser unquotes, so the playbook template's
 * `description: "[One sentence: …]"` comes back as `[One sentence: …]` and
 * reads as a flow sequence. Every `--description` was being written as a list.
 */
export function frontmatterShapes(block: string): Map<string, "list" | "scalar"> {
  const out = new Map<string, "list" | "scalar">();
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i] as string);
    if (!m) continue;
    const raw = stripInlineComment((m[2] as string).trim()).trim();
    const list =
      /^\[.*\]$/.test(raw) ||
      (raw === "" && /^\s*-\s/.test(lines[i + 1] ?? ""));
    out.set(m[1] as string, list ? "list" : "scalar");
  }
  return out;
}

/** A plain scalar this repository's lenient parser AND a real YAML parser will
 *  read the same way. `frontmatterSyntaxProblems` fails an unquoted `": "`, and
 *  a description is exactly where one turns up. */
export function scalar(value: string): string {
  const risky =
    value === "" ||
    /:\s/.test(value) ||
    /\s#/.test(value) ||
    // A leading YAML indicator character changes what the value IS.
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /^\s|\s$/.test(value);
  return risky ? JSON.stringify(value) : value;
}

/** One frontmatter entry, wrapped the way Prettier wraps a long plain scalar so
 *  a document `new` wrote survives `npm run format:check` unedited. */
export function frontmatterLines(key: string, value: string): string[] {
  const one = `${key}: ${value}`;
  if (one.length <= PRINT_WIDTH || value.startsWith('"') || value.startsWith("["))
    return [one];
  return [`${key}:`, ...wrap(value, PRINT_WIDTH - 2).map((l) => `  ${l}`)];
}

/**
 * The frontmatter with the resolved values substituted in.
 *
 * Line-oriented rather than parse-and-re-emit: every key the caller did not
 * touch keeps its text exactly — `set` depends on that. A key that is filled
 * loses any comment it had. (`new` strips the template's comments before it
 * gets here: `stripFrontmatterComments`.)
 */
export function rewriteFrontmatter(
  block: string,
  fills: ReadonlyMap<string, string>
): string {
  const lines = block.split("\n");
  const out: string[] = [];
  const written = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m || !fills.has(m[1] as string)) {
      out.push(line);
      continue;
    }
    const key = m[1] as string;
    out.push(...frontmatterLines(key, fills.get(key) as string));
    written.add(key);
    // The key's continuation lines — a wrapped scalar, or a block sequence —
    // belong to the value that was just replaced.
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] as string)) i++;
  }

  for (const [key, value] of fills)
    if (!written.has(key)) out.push(...frontmatterLines(key, value));

  return out.join("\n");
}

// ---------------------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------------------

const RELATED_ANCHOR = /^(#{1,6}\s+Related\b|\*\*Related\s+Documents?:?\*\*)/i;

/**
 * `--from`: the document this one came out of, wired in as a body link.
 *
 * Appended to whichever "Related …" section the template already has — the
 * templates spell it five different ways, so the anchor is a pattern rather
 * than a heading string — and given one of its own when the template has none.
 * The LAST match wins, because several templates open with a
 * `**Related Proposal:** …` line that is a label, not a list.
 */
export function appendRelated(body: string, bullet: string): string {
  const lines = body.split("\n");

  let anchor = -1;
  for (let i = 0; i < lines.length; i++)
    if (RELATED_ANCHOR.test(lines[i] as string)) anchor = i;

  if (anchor === -1)
    return `${body.replace(/\s*$/, "")}\n\n## Related Documents\n\n${bullet}\n`;

  // Past the blank line under the heading, then past the list already there.
  let at = anchor + 1;
  while (at < lines.length && (lines[at] as string).trim() === "") at++;
  let end = at;
  while (
    end < lines.length &&
    (/^\s*-\s/.test(lines[end] as string) ||
      (end > at && /^\s+\S/.test(lines[end] as string)))
  )
    end++;

  const insert = end > at ? [bullet] : ["", bullet];
  lines.splice(end, 0, ...insert);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------------------

/**
 * A word Prettier never puts at the start of a line, because there it would
 * open a block: a list marker (`-`, `+`, `*`, `1.`, `1)`), a heading (`#`) or
 * a blockquote (`>…`). Prettier's own test, from its Markdown printer.
 */
const NO_BREAK_BEFORE = /^>|^(?:[*+-]|#{1,6}|\d+[).])$/;

/** A catalog entry, wrapped the way Prettier (`proseWrap: always`, width 80)
 *  wraps one: the link is a single unbreakable token, and the dash and the
 *  description flow after it. */
export function catalogEntry(
  title: string,
  target: string,
  description: string
): string[] {
  // The dash is a word of its own, as it is to Prettier: when it does not fit
  // after the link it opens the next line rather than overrunning this one.
  // A word in NO_BREAK_BEFORE is bound to the word before it, and the two move
  // to the next line together — a continuation line opening `- ` would be read
  // as a nested list, and Prettier would rewrite the entry.
  const units: string[] = [];
  for (const word of ["—", ...description.split(/\s+/).filter(Boolean)]) {
    if (units.length && NO_BREAK_BEFORE.test(word)) units[units.length - 1] += ` ${word}`;
    else units.push(word);
  }
  const lines: string[] = [];
  let line = `- [${title}](${target})`;
  for (const unit of units) {
    if (line.length + 1 + unit.length <= PRINT_WIDTH) line += ` ${unit}`;
    else {
      lines.push(line);
      line = `  ${unit}`;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * The entry, placed under its folder's heading.
 *
 * The section is found by the README link the heading's blurb already carries —
 * `docs/index.md` writes one per library folder — rather than by a
 * folder-to-heading table, which would be a second place to declare something
 * the file already states. An empty section holds a `_No pages yet._` line that
 * the catalog's own instructions say to REPLACE, not to write beneath.
 */
export function insertCatalogEntry(
  index: string,
  folder: string,
  entry: string[]
): string {
  const lines = index.split("\n");
  const heads = lines
    .map((l, i) => (/^##\s/.test(l) ? i : -1))
    .filter((i) => i !== -1);

  const needle = `](./${folder}/README.md)`;
  let start = -1;
  let end = lines.length;
  for (let h = 0; h < heads.length; h++) {
    const from = heads[h] as number;
    const to = h + 1 < heads.length ? (heads[h + 1] as number) : lines.length;
    if (lines.slice(from, to).some((l) => l.includes(needle))) {
      start = from;
      end = to;
      break;
    }
  }
  if (start === -1)
    throw new NotFoundError(
      `index.md has no section for \`${folder}/\` — expected a heading whose blurb links ` +
        `./${folder}/README.md, so a new page has somewhere to be catalogued.`
    );

  const placeholder = lines.findIndex(
    (l, i) => i > start && i < end && l.trim() === "_No pages yet._"
  );
  if (placeholder !== -1) {
    lines.splice(placeholder, 1, ...entry);
    return lines.join("\n");
  }

  // After the last line of the last entry already in this section.
  let at = end;
  while (at > start && (lines[at - 1] as string).trim() === "") at--;
  lines.splice(at, 0, ...entry);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------------------

/** Frontmatter keys every type has, and the flag that fills each. `lifecycle`
 *  is offered only where the row declares a vocabulary. */
const COMMON_FLAGS: Array<[flag: string, key: string]> = [
  ["--title", "title"],
  ["--description", "description"],
  ["--tags", "tags"],
  ["--status", "status"],
  ["--lifecycle", "lifecycle"],
];

/** Every `extra` key any row declares, as a flag. Projected, not listed: a type
 *  that grows a field grows its flag with it. */
const EXTRA_FLAGS = [
  ...new Set([...defaultRegistryIndex().values()].flatMap((r) => r.extra)),
]
  // `from:` is an item field, and `--from` is already the flag that names the
  // source document; one flag serves both. `id:` is minted, never typed.
  .filter((key) => key !== "from" && key !== "id")
  .sort();

/** A field's flag: `blocked_by` is `--blocked-by`. */
export const flagFor = (key: string): string => `--${key.replace(/_/g, "-")}`;

function flagValue(
  flags: Record<string, string | true>,
  flag: string
): string | undefined {
  const v = flags[flag];
  if (v === true) throw new UsageError(`${flag} needs a value.`);
  return v;
}

/** The addresses, `type` and `lifecycle` of everything already written. */
export function existingDocuments(ctx: Ctx): ExistingDocument[] {
  return collectPages(ctx).map((page) => ({
    path: page.path,
    keys: pageKeys(page),
    type: page.type,
    lifecycle: page.lifecycle,
  }));
}

/**
 * `--from`, as a file that resolves, tried repo-relative and then docs-relative
 * — an agent holding a `find` result has the first, and a person reading a
 * folder README has the second.
 *
 * On a type that declares a `from:` field (`model` is passed), the field's
 * value comes back too, in the form D6 stores: a document's docs-root-relative
 * path, or — when `--from` is a reference rather than a path — the entity's
 * full form (an item's id, `feature/<slug>`, `cycle/<slug>`), linked through
 * its entity file.
 */
function resolveFrom(
  ctx: Ctx,
  from: string,
  model: (() => WorkModel) | null
): { abs: string; field?: string } {
  const cleaned = from.replace(/^\.\//, "");
  for (const base of [ctx.repoRoot, ctx.docsRoot]) {
    const abs = resolve(base, cleaned);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    if (model === null) return { abs };
    const within = relative(ctx.docsRoot, abs);
    if (within.startsWith("..") || within === "")
      throw new UsageError(
        `--from: \`${from}\` is outside the docs root — \`from:\` names a document under it.`
      );
    return { abs, field: within.split(sep).join("/") };
  }
  if (model !== null && /^(feature|item|cycle)\/|^[0-9a-f-]{8,}$/i.test(cleaned)) {
    const e = resolveRef(model(), cleaned);
    return { abs: join(ctx.repoRoot, e.path), field: refFor(e) };
  }
  throw new NotFoundError(
    `--from: no file at \`${from}\` (tried it against the repository root and the docs root).`
  );
}

export const newCommand: Command = {
  name: "new",
  summary: "Create a document: the type decides folder, filename and template.",
  usage:
    "pdocs new <type> <name> [--title <t>] [--description <d>] [--owner <feature/…|item/…>] " +
    "[--variant <v>] [--from <path-or-ref>]",
  // `--project` was the owner flag before 9.0.0; skills written against it still pass it.
  retiredFlags: {
    "--project": "`--project` was replaced by `--owner feature/<slug>` (or `item/<slug>`).",
  },
    // `name` is NOT required and the two are not the same kind of optional: a
  // type whose filename the registry fixes — `plan.md`, `write-up.md` — takes
  // none, and a type that names a scope demands one. The parser enforces the
  // maximum; which of the two applies is `resolveType`'s answer, so `required`
  // here is the honest floor rather than a guess at the common case.
  positionals: [
    { name: "type", required: true },
    { name: "name", required: false },
  ],
  options: [
    { flag: "--title", metavar: "<text>", summary: "Title. Defaults to the name, title-cased." },
    {
      flag: "--description",
      metavar: "<text>",
      summary:
        "One sentence. Doubles as the catalog hook for a library page. Defaults to the template's.",
    },
    { flag: "--tags", metavar: "<a,b>", summary: "Comma-separated kebab-case tags." },
    { flag: "--status", metavar: "<s>", summary: `OKF status: ${OKF_STATUS.join(" | ")}.` },
    {
      flag: "--lifecycle",
      metavar: "<l>",
      summary: "Where the work has got to. Only for a type that declares a vocabulary.",
    },
    { flag: "--by", metavar: "<actor>", summary: "`generated.by`. Defaults to `pdocs`." },
    {
      flag: "--owner",
      metavar: "<ref>",
      summary:
        "What an owned document (plan, session, …) belongs to: feature/<slug> or item/<slug-or-id>. " +
        "A single-file item is promoted to a folder first.",
    },
    {
      flag: "--variant",
      metavar: "<v>",
      summary: "Which template, for a type that has more than one.",
    },
    {
      flag: "--from",
      metavar: "<path-or-ref>",
      summary:
        "What this came out of, linked from its Related section: a document's path, or — on an " +
        "item — a reference (an item id, item/<slug>, feature/<slug>, cycle/<filename>), also written to `from:`.",
    },
    ...EXTRA_FLAGS.map((key) => ({
      flag: flagFor(key),
      metavar: key === "cycle" ? "<filename>" : "<value>",
      summary:
        `\`${key}:\` — only on a type that declares it.` +
        (key === "kind" ? ` Required for an \`item\`: ${KINDS.join(" | ")}.` : "") +
        (key === "cycle" ? ` ${CYCLE_FLAG_NOTE}` : ""),
    })),
  ],

  run({ ctx, format, flags, positionals }: Invocation): number {
    const [typeArg, nameArg] = positionals;
    if (typeArg === undefined)
      throw new UsageError(
        "new needs a type — `pdocs new playbook rollback` or `pdocs new plan --owner feature/oauth-upgrade`."
      );

    const { row, namesScope } = resolveType(ctx, typeArg);

    let work: WorkModel | null = null;
    const model = (): WorkModel => (work ??= collectWork(ctx));
    const placement = resolveDirectory(ctx, row, nameArg, flagValue(flags, "--owner"), model);
    const { dir } = placement;
    // A row that names its scope takes its name as the folder, not the slug.
    // A cycle is named by its filename, so `2026-10-x.md` means `2026-10-x`.
    const slug = namesScope
      ? undefined
      : row.type === "cycle" && nameArg !== undefined
        ? nameArg.replace(/\.md$/i, "")
        : nameArg;
    const scopeName = namesScope ? slugify(nameArg as string) : undefined;

    const date = today();
    // The second half of the containment guarantee: `resolveDirectory` proved
    // the FOLDER is under the docs root, and this proves the FILE is. A
    // filename grammar that ever produced a separator would otherwise walk out
    // of a directory that was itself fine.
    const target = assertInside(
      ctx.docsRoot,
      join(dir, resolveFilename(row, slug, dir, date))
    );
    const rel = relative(ctx.repoRoot, target);
    if (existsSync(target))
      throw new ConflictError(`${rel} already exists — pdocs will not overwrite it.`);

    // An entity's slug names it (`item/<slug>`, `feature/<slug>`,
    // `cycle/<slug>`), live or archived, file or folder — so a slug already
    // held anywhere is taken, even where the exact target path is free
    // (review 3).
    if (
      row.type === "cycle" ||
      [FEATURES_FOLDER, ITEMS_FOLDER].some((o) => ENTITY_FILE[o]!.type === row.type)
    ) {
      const wanted = scopeName ?? basename(target, ".md");
      // A cycle name is read with or without `.md`, so `x` is also taken when
      // `x.md.md` exists: `x.md` would then name both.
      const holders =
        row.type === "cycle"
          ? [...new Set([...cyclesNamed(model(), wanted), ...cyclesNamed(model(), `${wanted}.md`)])]
          : (entitiesBySlug(model(), row.type as "feature" | "item").get(wanted) ?? []);
      if (holders.length)
        throw new ConflictError(
          `\`${row.type}/${wanted}\` is taken by ${holders.map((h) => h.path).join(", ")} — ` +
            (row.type === "cycle"
              ? "a cycle's filename names one cycle, archived or not, with or without `.md`. Choose another name."
              : `a slug names one ${row.type}, archived or not. Choose another name.`)
        );
    }

    // ---- the template, and the frontmatter it gets -------------------------------------
    const templatePath = join(ctx.repoRoot, resolveTemplate(row, flagValue(flags, "--variant")));
    if (!existsSync(templatePath))
      throw new NotFoundError(
        `the \`${row.type}\` template is declared at ${relative(ctx.repoRoot, templatePath)} and is not there.`
      );
    const template = splitDocument(readFileSync(templatePath, "utf8"));
    const block = stripFrontmatterComments(template.block);
    const { body } = template;
    const shapes = frontmatterShapes(block);
    const asWritten = (key: string, value: string): string =>
      shapes.get(key) === "list" || LIST_FIELDS.has(key)
        ? `[${value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .join(", ")}]`
        : scalar(value);

    const fills = new Map<string, string>();
    fills.set("type", row.type);

    for (const [flag, key] of COMMON_FLAGS) {
      const value = flagValue(flags, flag);
      if (value === undefined) continue;
      if (key === "lifecycle" && row.lifecycle === null)
        throw new UsageError(
          `a \`${row.type}\` is a frozen record and carries no lifecycle — drop --lifecycle.`
        );
      if (key === "lifecycle" && row.lifecycle && !row.lifecycle.includes(value))
        throw new UsageError(
          `--lifecycle: \`${value}\` is not a ${row.type} lifecycle — ${row.lifecycle.join(" | ")}.`,
          { token: value, choices: [...row.lifecycle] }
        );
      if (key === "status" && !OKF_STATUS.includes(value))
        throw new UsageError(
          `--status: \`${value}\` is not an OKF status — ${OKF_STATUS.join(" | ")}.`,
          { token: value, choices: [...OKF_STATUS] }
        );
      fills.set(key, asWritten(key, value));
    }

    const rowFlags = row.extra.filter((e) => EXTRA_FLAGS.includes(e)).map(flagFor);
    for (const key of EXTRA_FLAGS) {
      const flag = flagFor(key);
      const value = flagValue(flags, flag);
      if (value === undefined) continue;
      if (!row.extra.includes(key))
        throw new UsageError(
          `${flag} is not a field of \`${row.type}\`${
            rowFlags.length ? ` — it takes ${rowFlags.join(", ")}` : ""
          }.`,
          { token: flag, choices: rowFlags }
        );
      const closed = FIELD_VALUES[key];
      if (closed && !closed.includes(value))
        throw new UsageError(
          `${flag}: \`${value}\` is not a ${key} — ${closed.join(" | ")}.`,
          { token: value, choices: [...closed] }
        );
      fills.set(key, asWritten(key, value));
    }

    // The keys this row REQUIRES beyond the universal ones. An `id` is minted
    // here and never typed (a UUIDv7, so ids sort by filing time). Any other
    // must be passed: the template's value is an example, and a default would
    // file every bug as a task.
    for (const key of row.required) {
      if (key === "id") {
        fills.set("id", uuidv7());
        continue;
      }
      if (fills.has(key)) continue;
      const closed = FIELD_VALUES[key];
      throw new UsageError(
        `a \`${row.type}\` needs ${flagFor(key)}${closed ? ` — ${closed.join(" | ")}` : ""}.`,
        closed ? { token: flagFor(key), choices: [...closed] } : { token: flagFor(key) }
      );
    }

    // A LIST THE CALLER DID NOT FILL keeps whatever the template put there, and
    // several templates put bracketed placeholders there — the cycle template's
    // `scope:` opens with `- project/[project-name]`. Those are not values; they
    // are the blank, spelled out, and a `validate` predicate reading the
    // frontmatter as data would refuse every cycle for naming a project that
    // does not exist. Dropping them is the list-valued half of what filling
    // `title` does for a scalar. Items with no brackets — the templates' real
    // example tags, `[process, area]` — are left exactly as written.
    const templateFields = parseFrontmatter(block);
    for (const [key, shape] of shapes) {
      if (shape !== "list" || fills.has(key)) continue;
      const items = yamlList(templateFields.get(key));
      const kept = items.filter((item) => !/[[\]]/.test(item));
      if (kept.length !== items.length) fills.set(key, `[${kept.join(", ")}]`);
    }

    // A title is mechanically derivable from the name and a description is not,
    // so one gets a default and the other keeps the template's placeholder for
    // the writer to replace.
    if (!fills.has("title"))
      fills.set(
        "title",
        // A fixed-name document (`plan.md`) is named for what it belongs to.
        scalar(
          titleFromSlug(
            row,
            slug
              ? slugify(slug)
              : (scopeName ?? basename(placement.ownerDir ?? ctx.docsRoot))
          )
        )
      );
    fills.set("generated", `{ by: ${flagValue(flags, "--by") ?? "pdocs"}, at: ${date} }`);
    // A date the template leaves as `YYYY-MM-DD` — a cycle's `started` — is
    // today unless its flag said otherwise: the placeholder is never a value.
    for (const [key, value] of templateFields)
      if (!fills.has(key) && value === DATE_PLACEHOLDER) fills.set(key, date);

    // ---- --from: the source document, and on a type that declares it, `from:` ----------
    const from = flagValue(flags, "--from");
    const source =
      from === undefined ? null : resolveFrom(ctx, from, row.extra.includes("from") ? model : null);
    if (source?.field !== undefined) fills.set("from", scalar(source.field));

    // ---- validate, before anything is written ------------------------------------------
    let frontmatter = rewriteFrontmatter(block, fills);
    let resolved = parseFrontmatter(frontmatter);
    const canonical = new Map<string, string>();
    for (const problem of row.validate?.({
      type: row.type,
      fields: resolved,
      documents: existingDocuments(ctx),
      resolve: (ref, kinds) => resolveRef(model(), ref, kinds),
      scopes: ctx.config.lint.scopes,
      set: (key, value) => canonical.set(key, value),
    }) ?? [])
      throw problem.kind === "conflict"
        ? new ConflictError(problem.message)
        : new UsageError(problem.message);
    if (canonical.size) {
      for (const [key, value] of canonical) fills.set(key, value);
      frontmatter = rewriteFrontmatter(block, fills);
      resolved = parseFrontmatter(frontmatter);
    }

    // ---- the review rule: an item filed into started work or the active cycle ----------
    // Evaluated on the item as it would be written, before the first write
    // (a promotion, below). Strict refuses one that is not `stable`.
    let advisories: Advisory[] = [];
    if (row.type === "item") {
      // The item as it would be written. A new item changes no cycle, so the
      // model already read answers which cycle is active; and it did not
      // exist before, so any finding on it is introduced.
      const proposed = entityOf(ctx, { rel, type: row.type, fields: resolved, misplaced: false });
      advisories = adviseReview(
        ctx,
        reviewGuard(ctx, model(), model(), proposed ? [proposed] : [], "new")
      );
    }

    // ---- the body ----------------------------------------------------------------------
    let out = body;
    // `--title` fills the H1 too: the template's is a placeholder (`# [Title]`)
    // like the `title:` it mirrors. Only an explicit title — a default derived
    // from the owner's slug would turn `# [Feature Name] Implementation Plan`
    // into `# Auth Refactor`. Left alone, the gate reports it (PLACEHOLDER).
    const h1 = flagValue(flags, "--title") === undefined ? -1 : firstHeading(out);
    if (h1 !== -1) {
      const lines = out.split("\n");
      lines[h1] = `# ${resolved.get("title") ?? ""}`;
      out = lines.join("\n");
    }
    // The owner's entry file, linked from the document it owns (D17). The
    // templates cannot carry it: a feature's is `feature.md` and an item's is
    // `item.md`, and one template serves both.
    if (placement.entry !== null) {
      const href = relative(dir, placement.entry).replace(/^(?!\.)/, "./");
      out = appendRelated(out, `- [${placement.ownerTitle}](${href})`);
    }
    if (source !== null) {
      // Where the source will be once any promotion has run: `--from` may be
      // the very item being promoted to hold this document (review 2).
      const abs =
        placement.promote === null || placement.entry === null
          ? source.abs
          : movedTo(
              source.abs,
              new Map([[join(ctx.repoRoot, placement.promote.path), placement.entry]])
            );
      // The owner's entry file is already linked above; once is enough.
      if (abs !== placement.entry) {
        const href = relative(dir, abs).replace(/^(?!\.)/, "./");
        const fields = parseFrontmatter(
          /^---\n([\s\S]*?)\n---/.exec(readFileSync(source.abs, "utf8"))?.[1] ?? ""
        );
        out = appendRelated(
          out,
          `- [${fields.get("title") ?? basename(source.abs, ".md")}](${href})`
        );
      }
    }
    // ---- the catalog line, computed before either file is touched -----------------------
    const description = (resolved.get("description") ?? "").replace(/\s+/g, " ").trim();
    const indexPath = join(ctx.docsRoot, "index.md");
    // A page in a library FOLDER needs a catalog line. The `root` singletons are
    // library-tier too and are not creatable, so the scope is part of the test
    // rather than a redundancy: it is what stops a future creatable root page
    // from being catalogued under a folder heading that does not exist.
    const catalogued = row.tier === "library" && row.scope === "docs";
    if (catalogued && !existsSync(indexPath))
      throw new NotFoundError(
        `no catalog at ${relative(ctx.repoRoot, indexPath)} — a library page must be ` +
          `reachable from it, and pdocs will not write one that is not.`
      );
    const catalog = catalogued
      ? insertCatalogEntry(
          readFileSync(indexPath, "utf8"),
          row.folder,
          catalogEntry(
            resolved.get("title") ?? "",
            `./${relative(ctx.docsRoot, target)}`,
            description
          )
        )
      : null;

    // ---- write -------------------------------------------------------------------------
    // Promotion is the first write, and the last thing that can refuse has
    // already run: an item is only turned into a folder that is then written to.
    const promotion = placement.promote === null ? null : promoteItem(ctx, placement.promote);
    const promoted = promotion?.to ?? null;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `---\n${frontmatter}\n---\n${out}`);
    const created = [rel];
    if (catalog !== null) {
      writeFileSync(indexPath, catalog);
      created.push(relative(ctx.repoRoot, indexPath));
    }
    // An automatic promotion moved the item and rewrote links to it; those
    // files were modified by this command too (review 11).
    if (promotion !== null)
      for (const p of [promotion.to, ...promotion.rewritten])
        if (!created.includes(p)) created.push(p);

    const id = fills.get("id") ?? null;
    const data: NewData = { path: rel, type: row.type, created, promoted, id, advisories };
    if (format === "json") printEnvelope("new", data);
    else {
      console.log(rel);
      if (id !== null) console.log(`  id ${shortId(id, [...modelIds(model()), id])}`);
      if (catalog !== null) console.log(`  + catalog line in ${relative(ctx.repoRoot, indexPath)}`);
      if (promotion !== null) {
        console.log(`  promoted its owner to ${promotion.to}`);
        for (const p of promotion.rewritten)
          if (p !== promotion.to) console.log(`  rewrote links in ${p}`);
      }
      // A consumer's `prettier --check` hook fails the commit on what this
      // wrote, a rewritten link line included; name every file it touched.
      console.log(
        `  next: fill its placeholders, then run the project's formatter before committing, e.g. npx prettier --write ${created.join(" ")}`
      );
      for (const l of advisoryLines(advisories)) console.log(l);
    }
    return ExitCode.Success;
  },
};
