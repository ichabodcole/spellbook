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
// It does NOT own content. It fills frontmatter and it changes nothing below
// it; instructional comments are copied intact.
//
// That boundary cost something to hold. The templates used to carry 26 example
// links to filenames that never existed — `[Related playbook 1](./other-playbook.md)`,
// `[External documentation](URL)` — so a verbatim copy was up to five
// `MISSING FILE`s the moment it was written. The first version of this file
// rewrote them at runtime. That was reversed in favour of fixing the templates
// once, as inline code, in a diff a reader can see: it fixes the same defect
// for someone copying a template BY HAND, which is still the majority path,
// and it keeps this command out of the business of editing prose. The links
// that a real workflow makes resolve — a plan's `./proposal.md` — are left as
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
import { OKF_STATUS, type Ctx } from "../lint/rules.ts";
import {
  type ExistingDocument,
  PROJECTS_FOLDER,
  type RegistryRow,
  TYPE_ALIAS,
  defaultRegistryIndex,
  registryIndex,
} from "../lint/registry.ts";
import { collectPages, pageKeys } from "../pages.ts";

/** `data` in the envelope. */
export interface NewData {
  /** Repo-relative path of the document that was written. */
  path: string;
  /** The registry type it was written as — the alias resolved, not as typed. */
  type: string;
  /** Every file written or modified, document first. */
  created: string[];
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
 * `pdocs new project ".."` write `docs/proposal.md`, outside the project tree,
 * and report `ok: true`. A dot is legal INSIDE a slug and never at either end,
 * so `..` and `...` have nothing left once the ends are trimmed, and the
 * emptiness check that was already here refuses them.
 *
 * The final test is for a letter or a digit rather than for non-emptiness,
 * because `.-.` trims to `-.-`… and because the documented rule — `references/pdocs.md`
 * says "a name with no letters or digits in it is a usage error" — was true of
 * `"!!!"` and false of `"..."`. Now it is true of both.
 *
 * This is the first of two guards. Escaping a slug is not the only way to leave
 * the tree — `--project ../../etc` never goes through here — so `assertInside`
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
 * `existsSync(projectDir)` is not this check and never was: it asks whether a
 * directory is there, and `docs/..` is very much there. `pdocs new project ".."`
 * resolved to the repository root, wrote `docs/proposal.md` — the docs root's
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
 * The type argument, through the alias table and then to a row.
 *
 * A row that is not creatable is refused with the reason the REGISTRY gives,
 * quoted verbatim. That is deliberate rather than a null-template accident:
 * `kickoff` and `artifact` both have a reason worth reading, and a command that
 * said "no template" would be telling the caller about the implementation
 * instead of about the decision.
 */
export function resolveType(ctx: Ctx, typeArg: string): ResolvedType {
  const alias = TYPE_ALIAS[typeArg];
  const wanted = alias?.type ?? typeArg;
  const registry = registryIndex(ctx.config);
  const row = registry.get(wanted);
  // The closed set, read off the registry rather than written beside it — the
  // same list `check` enforces and `new` writes from. It is enumerated in prose
  // AND as `choices`, and both refusals below hand it over: a caller who named
  // a type pdocs will not create needs the set exactly as much as one who named
  // a type that does not exist.
  const creatable = (): string[] =>
    [
      ...[...registry.values()].filter((r) => r.creatable).map((r) => r.type),
      ...Object.keys(TYPE_ALIAS),
    ].sort();

  if (!row) {
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

  return { row, namesScope: alias?.namesScope === true };
}

// ---------------------------------------------------------------------------------------
// Resolving the path
// ---------------------------------------------------------------------------------------

/** The directory a row's documents live in, and the project it belongs to. */
export function resolveDirectory(
  ctx: Ctx,
  row: RegistryRow,
  project: string | undefined
): { dir: string; projectDir: string | null } {
  if (row.scope !== "project")
    return {
      dir: row.folder ? join(ctx.docsRoot, row.folder) : ctx.docsRoot,
      projectDir: null,
    };

  if (project === undefined)
    throw new UsageError(
      `a \`${row.type}\` lives inside a project — pass \`--project <slug>\`.`
    );

  const projectDir = assertInside(
    ctx.docsRoot,
    join(ctx.docsRoot, PROJECTS_FOLDER, project)
  );
  return {
    dir: row.folder ? join(projectDir, row.folder) : projectDir,
    projectDir,
  };
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
 * The template's frontmatter with the resolved values substituted in.
 *
 * Line-oriented rather than parse-and-re-emit: every key the caller did not
 * touch keeps its template text exactly, inline instructional comment
 * included. A key that is filled loses its comment, because the comment
 * described the blank.
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

/** A catalog entry, wrapped the way Prettier wraps one: the link is a single
 *  unbreakable token, the description flows after it. */
export function catalogEntry(
  title: string,
  target: string,
  description: string
): string[] {
  const lines: string[] = [];
  let line = `- [${title}](${target}) —`;
  for (const word of description.split(/\s+/).filter(Boolean)) {
    if (line.length + 1 + word.length <= PRINT_WIDTH) line += ` ${word}`;
    else {
      lines.push(line);
      line = `  ${word}`;
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
].sort();

function flagValue(
  flags: Record<string, string | true>,
  flag: string
): string | undefined {
  const v = flags[flag];
  if (v === true) throw new UsageError(`${flag} needs a value.`);
  return v;
}

/**
 * The alias that OPENS a scope — the one whose positional names the folder the
 * other project-scoped types then need.
 *
 * Looked up rather than written into the diagnostic, so the hint a caller is
 * given stays true if the alias is ever renamed, and so the one place this file
 * would otherwise have to say the word is the registry instead.
 */
function scopeOpener(): string | null {
  const found = Object.entries(TYPE_ALIAS).find(([, a]) => a.namesScope);
  return found ? found[0] : null;
}

/** The addresses, `type` and `lifecycle` of everything already written. */
function existingDocuments(ctx: Ctx): ExistingDocument[] {
  return collectPages(ctx).map((page) => ({
    path: page.path,
    keys: pageKeys(page),
    type: page.type,
    lifecycle: page.lifecycle,
  }));
}

/** `--from`, as a path that resolves, tried repo-relative and then
 *  docs-relative — an agent holding a `find` result has the first, and a person
 *  reading a folder README has the second. */
function resolveFrom(ctx: Ctx, from: string): string {
  const cleaned = from.replace(/^\.\//, "");
  for (const base of [ctx.repoRoot, ctx.docsRoot]) {
    const abs = resolve(base, cleaned);
    if (existsSync(abs) && statSync(abs).isFile()) return abs;
  }
  throw new NotFoundError(
    `--from: no file at \`${from}\` (tried it against the repository root and the docs root).`
  );
}

export const newCommand: Command = {
  name: "new",
  summary: "Create a document: the type decides folder, filename and template.",
  usage:
    "pdocs new <type> <name> [--title <t>] [--description <d>] [--project <slug>] " +
    "[--variant <v>] [--from <path>]",
  // `name` is NOT required and the two are not the same kind of optional: a
  // type whose filename the registry fixes — `proposal.md`, `plan.md` — takes
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
      flag: "--project",
      metavar: "<slug>",
      summary: "The project folder, for a type that lives inside one.",
    },
    {
      flag: "--variant",
      metavar: "<v>",
      summary: "Which template, for a type that has more than one.",
    },
    {
      flag: "--from",
      metavar: "<path>",
      summary: "The document this one came out of; linked from its Related section.",
    },
    ...EXTRA_FLAGS.map((key) => ({
      flag: `--${key}`,
      metavar: "<value>",
      summary: `\`${key}:\` — only on a type that declares it.`,
    })),
  ],

  run({ ctx, format, flags, positionals }: Invocation): number {
    const [typeArg, nameArg] = positionals;
    if (typeArg === undefined)
      throw new UsageError(
        "new needs a type — `pdocs new playbook rollback` or `pdocs new plan --project oauth-upgrade`."
      );

    const { row, namesScope } = resolveType(ctx, typeArg);

    // The alias case: the positional names the project folder, and the document
    // inside it is the row's fixed one.
    if (namesScope && nameArg === undefined)
      throw new UsageError(
        `\`${typeArg}\` needs a name — the folder to open, e.g. \`pdocs new ${typeArg} oauth-upgrade\`.`
      );
    // BOTH paths slugify. They used not to: `pdocs new project "My Big Project"`
    // created `my-big-project/`, and `pdocs new plan --project "My Big Project"`
    // then exited 5 saying no such project — and offered, as the fix, the
    // command that had just worked. One flag was being read as a folder name
    // and the other as a name to make a folder name out of. `--project` names
    // the same thing `new project` was given, so it is read the same way.
    const project = namesScope
      ? slugify(nameArg as string)
      : (() => {
          const value = flagValue(flags, "--project");
          return value === undefined ? undefined : slugify(value);
        })();
    const slug = namesScope ? undefined : nameArg;

    const { dir, projectDir } = resolveDirectory(ctx, row, project);
    if (projectDir !== null && !namesScope && !existsSync(projectDir))
      throw new NotFoundError(
        `no \`${project}\` at ${relative(ctx.repoRoot, projectDir)}` +
          (scopeOpener() ? ` — \`pdocs new ${scopeOpener()} ${project}\` opens one.` : ".")
      );

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

    // ---- the template, and the frontmatter it gets -------------------------------------
    const templatePath = join(ctx.repoRoot, resolveTemplate(row, flagValue(flags, "--variant")));
    if (!existsSync(templatePath))
      throw new NotFoundError(
        `the \`${row.type}\` template is declared at ${relative(ctx.repoRoot, templatePath)} and is not there.`
      );
    const { block, body } = splitDocument(readFileSync(templatePath, "utf8"));
    const shapes = frontmatterShapes(block);
    const asWritten = (key: string, value: string): string =>
      shapes.get(key) === "list"
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

    for (const key of EXTRA_FLAGS) {
      const value = flagValue(flags, `--${key}`);
      if (value === undefined) continue;
      if (!row.extra.includes(key))
        throw new UsageError(
          `--${key} is not a field of \`${row.type}\`${
            row.extra.length ? ` — it takes ${row.extra.map((e) => `--${e}`).join(", ")}` : ""
          }.`,
          { token: `--${key}`, choices: row.extra.map((e) => `--${e}`) }
        );
      fills.set(key, asWritten(key, value));
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
        scalar(titleFromSlug(row, slug ? slugify(slug) : (project as string)))
      );
    fills.set("generated", `{ by: ${flagValue(flags, "--by") ?? "pdocs"}, at: ${date} }`);

    // ---- validate, before anything is written ------------------------------------------
    const frontmatter = rewriteFrontmatter(block, fills);
    const resolved = parseFrontmatter(frontmatter);
    for (const problem of row.validate?.({
      type: row.type,
      fields: resolved,
      documents: existingDocuments(ctx),
    }) ?? [])
      throw problem.kind === "conflict"
        ? new ConflictError(problem.message)
        : new UsageError(problem.message);

    // ---- the body ----------------------------------------------------------------------
    let out = body;
    const from = flagValue(flags, "--from");
    if (from !== undefined) {
      const abs = resolveFrom(ctx, from);
      const href = relative(dir, abs).replace(/^(?!\.)/, "./");
      const fields = parseFrontmatter(
        /^---\n([\s\S]*?)\n---/.exec(readFileSync(abs, "utf8"))?.[1] ?? ""
      );
      out = appendRelated(out, `- [${fields.get("title") ?? basename(abs, ".md")}](${href})`);
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
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `---\n${frontmatter}\n---\n${out}`);
    const created = [rel];
    if (catalog !== null) {
      writeFileSync(indexPath, catalog);
      created.push(relative(ctx.repoRoot, indexPath));
    }

    const data: NewData = { path: rel, type: row.type, created };
    if (format === "json") printEnvelope("new", data);
    else {
      console.log(rel);
      for (const other of created.slice(1)) console.log(`  + catalog line in ${other}`);
    }
    return ExitCode.Success;
  },
};
