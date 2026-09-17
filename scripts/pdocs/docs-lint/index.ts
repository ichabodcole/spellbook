// PORTED VERBATIM from agent-cli-conformance @ 1255a5d1c1010414bfbdb3c82bf01cdc44d0d2eb
// (github.com/ichabodcole/agent-cli-conformance, MIT, same author) — file:
// `scripts/docs-lint/index.ts`.
//
// Copied, not shared. There is no package behind this yet and three repos is
// too few to abstract across; the copy is the honest state until a fourth one
// wants it. Keep this file byte-identical to its source so a future extraction
// is a move, not a merge: project-specific behaviour goes in the consuming
// repo's rules layer — `scripts/pdocs/lint/rules.ts` here — through the
// `extraChecks` seam, never in here.
//
// DIVERGENCES, every one of them a generalization rather than an adaptation,
// and every one belonging back in agent-cli-conformance:
//
// 1. `stripFences` pairs fences of three OR MORE backticks. The source pairs
//    exactly three, which mis-pairs every fence after a ````-fence — see the
//    comment on the function.
// 2. `skipFiles` and `isContractPage` are configurable. The source hardcodes
//    `CONTRACT_PAGES = ["SCHEMA.md", "STYLE.md"]` in a file whose own header
//    says root, type vocabulary and date field are per-library PARAMETERS. A
//    library where every folder carries a README and a TEMPLATE — which is what
//    this scaffold generates — cannot express itself through two filenames.
//    Both default to the source's behaviour.
// 3. `runDocsLint` is split: `collectDocsLint` computes the report and prints
//    nothing, `runDocsLint` is the printing wrapper over it. The source can
//    only print, so a CLI that owns its own output envelope has to re-implement
//    the walk to get at the data. Anthill made the same split independently.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// The shared documentation-lint + knowledge-graph core.
//
// Lifted from dream-flute's `scripts/docs-lint`, which arrived at this shape after two
// near-identical copies were diffed and found to differ only in DATA (the `type` enum and a
// directory exclusion), never behaviour. Root, `type` vocabulary, and date field are
// per-library PARAMETERS; the answer is `runDocsLint(config)`, never "copy the file and edit
// the enum".
//
// This file is deliberately ZERO-DEPENDENCY and free of any coupling to this project, so it
// can be dropped into another repo unchanged. Anything project-specific belongs in
// `extraChecks`, not in here.
//
// Entry point:  docs/wiki/lint.ts   (accepts --json)

/** One page, as handed to `extraChecks`. */
export interface LintPage {
  /** Absolute path. */
  path: string;
  /** Path relative to the library root — what you want in an error message. */
  rel: string;
  /** Frontmatter key -> raw value, comments stripped and continuations joined. */
  fields: Map<string, string>;
  /** Full file contents, frontmatter included. */
  body: string;
}

export interface DocsLintConfig {
  /** Library root — pass `dirname(fileURLToPath(import.meta.url))` from the shim. */
  root: string;
  /** Allowed OKF `type` values. Per-library: vocabularies are disjoint by design. */
  types: string[];
  /** Directory names to skip entirely (skeletons/assets, not pages). */
  nonPageDirs?: string[];
  /**
   * Frontmatter field carrying the content date. OKF's convention is `timestamp`;
   * this project uses `updated` because it states the MEANING (when content changed)
   * rather than the format. Default: "timestamp".
   */
  dateField?: string;
  /**
   * Accept a date-only `YYYY-MM-DD` value in addition to full ISO-8601. Wiki pages are
   * edited by hand and nobody types a timezone offset correctly. Default: false.
   */
  allowDateOnly?: boolean;
  /**
   * Project-specific checks. Runs after the universal ones, receives every page, returns
   * problem strings. This is the seam that keeps the core above portable — put
   * cross-artifact checks (docs <-> code) here, never in the core.
   */
  extraChecks?: (pages: LintPage[]) => string[];
  /**
   * Files excluded from the walk entirely, by path relative to `root`.
   *
   * A TEMPLATE is the one page whose links are SUPPOSED not to resolve —
   * `../projects/project-name/proposal.md` is what a template is for — so it
   * cannot be exempted by the contract-page rule below, which still checks
   * links. Default: nothing is skipped.
   */
  skipFiles?: (rel: string) => boolean;
  /**
   * Maintainer meta-documents about the library rather than entries in its type
   * system: exempt from the frontmatter rules and from the orphan rule, but
   * their links ARE checked, because a folder contract with a dead pointer
   * misroutes the next document written.
   *
   * Default: any file whose name ends in SCHEMA.md or STYLE.md — the two the
   * source repo has. A repo whose every folder carries a README passes its own
   * predicate.
   */
  isContractPage?: (rel: string) => boolean;
  /** Emit the graph as JSON instead of human lint output. */
  json?: boolean;
}

/** Collect `.md` files under `dir`, skipping any directory named in `skipDirs`. */
export function walkMarkdown(
  dir: string,
  skipDirs: Set<string> = new Set()
): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir).sort()) {
    if (skipDirs.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walkMarkdown(p, skipDirs));
    else if (p.endsWith(".md")) out.push(p);
  }
  return out;
}

// GitHub heading -> anchor slug: lowercase, drop punctuation (keeping spaces/hyphens),
// spaces -> hyphens. "Beating / detune" -> "beating--detune".
export function slug(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s/g, "-");
}

/**
 * GitHub-slugged headings in a file, for anchor verification.
 *
 * Code is stripped FIRST. A `# comment` inside a fenced block is not a heading and GitHub
 * renders no anchor for it, so counting it lets a link to a nonexistent anchor pass — a
 * FALSE NEGATIVE, which is the one direction a gate must never fail in. `stripCode` is
 * length-preserving and only collapses newlines *inside* a fence, so headings before and
 * after one still begin a line.
 */
export function headingSlugsOf(text: string): Set<string> {
  const s = new Set<string>();
  for (const line of stripFences(text).split("\n")) {
    const heading = /^#+\s+(.*)$/.exec(line)?.[1];
    if (heading !== undefined) s.add(slug(heading));
  }
  return s;
}

/**
 * Blank out FENCED blocks only, preserving length.
 *
 * Separate from `stripCode` because heading detection must strip fences but must NOT strip
 * inline spans: a heading like "### `choices` is discovery" derives its anchor from text that
 * includes the span, so blanking it silently changes the slug. An inline span cannot fake a
 * heading anyway — a heading needs `#` at the start of a line, and a span starts with a
 * backtick — so fences are the whole risk.
 */
export function stripFences(md: string): string {
  // A fence opens with THREE OR MORE backticks and closes on a run at least as long, both at
  // the start of a line. Matching bare "```...```" instead pairs the first three backticks of a
  // ````-fence with the first three of the NEXT fence, and every fence after it is off by one:
  // real code reads as prose and real prose reads as code. Four-backtick fences are how a
  // document quotes a document that itself contains a fence, which is exactly what skill and
  // template pages do.
  //
  // Newlines survive so line-oriented callers (`headingSlugsOf`) still see line starts.
  return md.replace(/^[ \t]*(`{3,})[^\n]*$[\s\S]*?^[ \t]*\1`*[ \t]*$/gm, (m) =>
    m.replace(/[^\n]/g, " ")
  );
}

/**
 * Blank out fenced code blocks AND inline code spans before link scanning, preserving
 * length so nothing else shifts. A doc that DOCUMENTS a link — `[a](../b.md)` inside
 * backticks — is not a doc that HAS one, and a lint that cannot tell them apart fires a
 * false positive on exactly the pages that explain link conventions (i.e. SCHEMA.md).
 */
export function stripCode(md: string): string {
  return stripFences(md).replace(/(?<!`)`[^`\n]+`(?!`)/g, (m) =>
    " ".repeat(m.length)
  );
}

/**
 * Strip a trailing `# comment`, respecting quotes.
 *
 * YAML only begins a comment at an UNQUOTED `#` preceded by whitespace. The regex this
 * replaced could not see quoting, so `title: "Exit code #2"` parsed as `"Exit code` — a
 * truncated value and an orphaned quote.
 *
 * A backslash inside a DOUBLE-quoted scalar escapes the next character, so `\"` must not be
 * read as closing the scalar. Without that, `title: "a \"b\" c # d"` closes early and the
 * value is truncated at the `#`.
 */
export function stripInlineComment(v: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === "\\" && inDouble) i++;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (
      c === "#" &&
      !inSingle &&
      !inDouble &&
      i > 0 &&
      /\s/.test(v.charAt(i - 1))
    ) {
      return v.slice(0, i);
    }
  }
  return v;
}

/**
 * The escapes a double-quoted frontmatter scalar may use.
 *
 * DELIBERATELY smaller than YAML's set. This parser is a few dozen lines, and an escape it
 * decodes WRONG is worse than one it refuses — `acc show C2` renders these values straight to
 * a user, so they are CLI output now, not lint metadata. `unsupportedEscapes` below closes the
 * syntax: anything outside this table is a lint failure rather than a silent mis-decode.
 */
const DOUBLE_QUOTED_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  n: "\n",
  t: "\t",
  r: "\r",
};

/**
 * Every escape sequence in `fm` that `unquoteScalar` cannot decode.
 *
 * Scans the whole block rather than only the quoted regions: a bare backslash in unquoted
 * frontmatter is a mistake too, and needing `\\` for a literal one is the price of a closed
 * syntax. Returned as a de-duplicated list so the lint message names each offender once.
 */
export function unsupportedEscapes(fm: string): string[] {
  return [
    ...new Set(
      [...fm.matchAll(/\\(.|$)/gs)]
        .map((m) => m[1] ?? "")
        .filter((c) => !(c in DOUBLE_QUOTED_ESCAPES))
        .map((c) => `\\${c}`)
    ),
  ];
}

/**
 * `"concept"` -> `concept`. Quoted scalars are legal YAML and authors reach for them when a
 * value contains a colon or a `#`; every check downstream compares bare values, so leaving
 * the quotes on rejects valid frontmatter.
 *
 * The ESCAPES inside a double-quoted scalar are decoded too. Stripping only the outer pair
 * left `title: "\"You invoked me wrong\""` rendering as `\"You invoked me wrong\"` in `acc
 * show C2` — YAML syntax leaking into user-facing output. A single-quoted scalar has exactly
 * one escape, `''` for a literal apostrophe; it has no backslash escapes at all.
 */
export function unquoteScalar(v: string): string {
  const t = v.trim();
  if (t.length < 2) return t;
  const first = t[0];
  const last = t[t.length - 1];
  if (first === '"' && last === '"') {
    // Replacing pairwise left-to-right is what makes `\\n` decode to a backslash followed by
    // `n`, rather than to a newline: the match consumes both characters of the pair.
    return t
      .slice(1, -1)
      .replace(
        /\\(.|$)/gs,
        (whole, c: string) => DOUBLE_QUOTED_ESCAPES[c] ?? whole
      );
  }
  if (first === "'" && last === "'") return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/**
 * Collapse a frontmatter block into key -> value, joining YAML continuation lines onto
 * their key and dropping trailing `# comments`. This is what makes the checks
 * formatting-agnostic: Prettier rewrites a long flow sequence into an indented multi-line
 * block, which a line-anchored regex cannot see.
 */
export function parseFrontmatter(fm: string): Map<string, string> {
  const out = new Map<string, string>();
  let key: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (key)
      out.set(
        key,
        unquoteScalar(stripInlineComment(buf.join(" ").trim()).trim())
      );
  };
  for (const line of fm.split("\n")) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    const k = m?.[1];
    const v = m?.[2];
    if (k !== undefined && v !== undefined) {
      flush();
      key = k;
      buf = [v];
    } else if (key && /^\s+\S/.test(line)) {
      buf.push(line.trim());
    }
  }
  flush();
  return out;
}

/**
 * `[a, b]` (flow, possibly Prettier-wrapped) or `- a` (block) -> ["a", "b"].
 *
 * The final `replace` strips the block sequence's leading dash from the FIRST item only — the
 * split already consumed it for every later one — and the whitespace after that dash is
 * REQUIRED. It used to be optional, and an optional space made the pattern eat one character off
 * any item that merely BEGINS with a hyphen: a `coverage_established` bullet opening with the
 * word `--version` came back opening with `-version`, which the wiki lint then reported as a
 * page/checker mismatch whose two sides looked identical to a reader. A flag name is exactly the
 * kind of value these lists carry, so this is a defect and not a documented limitation like the
 * spaced-hyphen split below it.
 */
/**
 * OKF 0.2 §5.2 `generated: { by: <actor>, at: <ISO 8601> }`, which supersedes v0.1's
 * `timestamp` (§13.1). Returned as a pair so a caller can check the actor and the instant
 * separately; `null` means the value is not a well-formed flow mapping.
 *
 * A deliberately small parser, like `parseFrontmatter` beside it: the flow mapping is the form
 * the spec documents, and supporting block mappings too would mean carrying a YAML engine into
 * a linter whose whole point is having no dependencies.
 */
export function parseGenerated(
  raw: string | undefined
): { by: string; at: string } | null {
  if (!raw) return null;
  const m = /^\{\s*by:\s*([^,}]+?)\s*,\s*at:\s*([^,}]+?)\s*\}$/.exec(
    raw.trim()
  );
  return m
    ? { by: (m[1] as string).trim(), at: (m[2] as string).trim() }
    : null;
}

export function yamlList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .replace(/^\[|\]$/g, "")
    .split(/,|\s+-\s+/)
    .map((s) => s.trim().replace(/^-\s+/, ""))
    .filter(Boolean);
}

/** One broken link. Worded by the caller, so each linter keeps its own message column widths. */
export interface BrokenLink {
  kind: "MISSING FILE" | "MISSING ANCHOR";
  /** The link target exactly as written, including any `#anchor`. */
  target: string;
  /** The anchor that did not resolve; only set for `MISSING ANCHOR`. */
  anchor?: string;
}

/**
 * Resolve every relative markdown link in one file: does the target exist, and if it names an
 * anchor, is that anchor a heading there?
 *
 * Extracted from `runDocsLint` so a corpus that is NOT a wiki can borrow it. The wiki lint pairs
 * this with orphan and catalog checks that assume an `index.md`; a folder of frozen reports has
 * no catalog and no graph, and still owes its readers working links.
 *
 * Targets are resolved with no containment check, deliberately: a page linking out of its own
 * tree — a rule page citing a checker in `src/`, a report citing the wiki — is a link like any
 * other, and the failure that matters is that it does not resolve.
 */
export function checkLinks(
  file: string,
  body: string,
  opts: {
    anchorCache?: Map<string, Set<string>>;
    /** Prefer an already-read body; falls back to disk for a target outside the corpus. */
    bodyOf?: (path: string) => string;
  } = {}
): { outbound: string[]; problems: BrokenLink[] } {
  const anchorCache = opts.anchorCache ?? new Map<string, Set<string>>();
  const bodyOf = opts.bodyOf ?? ((p: string) => readFileSync(p, "utf8"));
  const outbound: string[] = [];
  const problems: BrokenLink[] = [];

  // matchAll rather than a hand-rolled exec loop: this body uses `continue`, and an exec
  // loop with a `continue` before the next exec is an easy infinite loop. matchAll also
  // owns its lastIndex, so the regex can't leak state between files.
  // The second alternative is CommonMark's pointy-bracket destination, which exists so a URL
  // may contain `)` — every DOI-bearing citation needs it. Matching only `[^)]+` truncated such
  // a link mid-URL and then reported the fragment as a missing FILE, since a truncated URL no
  // longer looks like one. `docs/wiki/site/markdown.ts` learned the same form; a linter that
  // disagrees with the renderer about what a link is will pass pages that render broken.
  for (const m of stripCode(body).matchAll(/\]\((<[^>]*>|[^)]+)\)/g)) {
    const link = m[1];
    if (link === undefined) continue;
    const target = link.trim().replace(/^<(.*)>$/, "$1");
    if (/^https?:\/\//.test(target) || target.startsWith("mailto:")) continue;
    const [pathPart = "", anchor] = target.split("#");
    let filePath: string;
    if (pathPart === "") {
      filePath = file; // same-file anchor
    } else {
      filePath = resolve(dirname(file), pathPart);
      if (!existsSync(filePath)) {
        problems.push({ kind: "MISSING FILE", target });
        continue;
      }
      if (filePath.endsWith(".md")) outbound.push(filePath);
    }
    if (anchor && filePath.endsWith(".md")) {
      let anchors = anchorCache.get(filePath);
      if (!anchors) {
        anchors = headingSlugsOf(bodyOf(filePath));
        anchorCache.set(filePath, anchors);
      }
      if (!anchors.has(anchor))
        problems.push({ kind: "MISSING ANCHOR", target, anchor });
    }
  }
  return { outbound, problems };
}

/** One page in the emitted knowledge graph. */
export interface DocsLintNode {
  path: string;
  type: string | null;
  title: string | null;
  description: string | null;
  tags: string[];
  status: string | null;
  /** Keyed by the configured `dateField` — `generated`, `timestamp`, `updated`… */
  [dateField: string]: unknown;
  linksOut: string[];
  linksIn: string[];
  related: string[];
  tagNeighbors: string[];
  reachable: boolean;
  contractExempt: boolean;
}

/** What `collectDocsLint` returns: the problems, and the graph the lint walked to find them. */
export interface DocsLintReport {
  root: string;
  contract: string;
  catalog: string;
  stats: {
    pages: number;
    linkEdges: number;
    relatedEdges: number;
    tags: number;
    orphans: number;
  };
  hubs: Array<{ path: string; linksIn: number; title: string | null }>;
  typeIndex: Record<string, string[]>;
  tagIndex: Record<string, string[]>;
  nodes: DocsLintNode[];
  problems: string[];
}

/**
 * The lint, as data. Walks the library, runs every universal check plus `extraChecks`, and
 * returns the problems alongside the knowledge graph. Prints nothing — `runDocsLint` is the
 * printing wrapper, and a CLI that owns its own output envelope calls this directly.
 */
export function collectDocsLint(
  config: Omit<DocsLintConfig, "json">
): DocsLintReport {
  const ROOT = config.root;
  const NON_PAGE_DIRS = new Set<string>(config.nonPageDirs ?? []);
  const OKF_TYPES = new Set<string>(config.types);
  const DATE_FIELD = config.dateField ?? "timestamp";
  const DATE_RE = config.allowDateOnly
    ? /^\d{4}-\d{2}-\d{2}(T|$)/
    : /^\d{4}-\d{2}-\d{2}T/;

  const SKIP_FILE = config.skipFiles ?? (() => false);
  const files = walkMarkdown(ROOT, NON_PAGE_DIRS).filter(
    (f) => !SKIP_FILE(relative(ROOT, f))
  );
  const INDEX = join(ROOT, "index.md");
  const problems: string[] = [];
  const say = (m: string) => {
    problems.push(m);
  };

  // --- read every file ONCE -------------------------------------------------------------
  const body = new Map<string, string>();
  const meta = new Map<string, Map<string, string>>();
  // The RAW block is kept alongside the parsed fields because the escape check below has to
  // see what the author wrote; by the time `parseFrontmatter` is done the escapes are decoded.
  const frontmatter = new Map<string, string>();
  for (const f of files) {
    const raw = readFileSync(f, "utf8");
    body.set(f, raw);
    const fm = /^---\n([\s\S]*?)\n---/.exec(raw)?.[1];
    if (fm !== undefined) frontmatter.set(f, fm);
    meta.set(f, fm !== undefined ? parseFrontmatter(fm) : new Map());
  }

  const fieldsOf = (f: string): Map<string, string> => meta.get(f) ?? new Map();
  const rel = (f: string) => relative(ROOT, f);
  // Contract pages are maintainer meta-documents about the wiki, not entries in its type system,
  // so the OKF frontmatter rules and the slug/catalog checks do not apply to them. Kept as a list
  // rather than one hardcoded filename: this module is meant to be lifted into other repos, and
  // the second such page (STYLE.md, prose to SCHEMA.md's structure) proved the single name wrong.
  // Matching stays a SUFFIX test, which a test pins deliberately — tightening it here would have
  // changed a documented behaviour as a side effect of adding a file.
  const CONTRACT_PAGES = ["SCHEMA.md", "STYLE.md"];
  const isContract =
    config.isContractPage !== undefined
      ? (f: string) =>
          (config.isContractPage as (rel: string) => boolean)(relative(ROOT, f))
      : (f: string) => CONTRACT_PAGES.some((c) => f.endsWith(c));

  // --- OKF frontmatter conformance ------------------------------------------------------
  for (const file of files) {
    if (isContract(file)) continue;
    if (!/^---\n[\s\S]*?\n---/.test(body.get(file) ?? "")) {
      say(`NO FRONTMATTER ${rel(file)}`);
      continue;
    }
    const fields = fieldsOf(file);
    const type = fields.get("type");
    if (!type)
      say(`MISSING type   ${rel(file)}  (OKF requires a \`type\` field)`);
    else if (!OKF_TYPES.has(type))
      say(
        `BAD type       ${rel(file)}: "${type}" not in {${[...OKF_TYPES].join(", ")}}`
      );

    // Accept flow style (`[a, b]`) and YAML block sequence (`- a`): Prettier rewraps long
    // flow lists, and lint-staged runs it on every staged .md.
    const tags = fields.get("tags");
    if (!tags || !(/^\[.*\S.*\]$/.test(tags) || /^- \S/.test(tags)))
      say(`MISSING tags   ${rel(file)}  (expected \`tags: [ ... ]\`)`);

    // `generated` is OKF 0.2's replacement for `timestamp`, and it is a mapping rather than a
    // scalar — so the instant to validate is inside it, and the actor beside it is checked too.
    // Any other `dateField` stays the plain scalar it always was.
    if (DATE_FIELD === "generated") {
      const g = parseGenerated(fields.get("generated"));
      if (!g)
        say(
          `MISSING generated  ${rel(file)}  (expected \`generated: { by: <actor>, at: YYYY-MM-DD }\`)`
        );
      else if (!DATE_RE.test(g.at))
        say(`BAD generated.at  ${rel(file)}: "${g.at}"  (expected YYYY-MM-DD)`);
      else if (!g.by)
        say(`MISSING generated.by  ${rel(file)}  (OKF requires an actor)`);
    } else if (!DATE_RE.test(fields.get(DATE_FIELD) ?? "")) {
      say(
        `MISSING ${DATE_FIELD}  ${rel(file)}  (expected \`${DATE_FIELD}: YYYY-MM-DD\`)`
      );
    }

    // Frontmatter values are user-facing output downstream (`acc show` prints title and
    // description verbatim), so an escape this parser cannot decode must fail the gate rather
    // than reach a reader as literal YAML syntax.
    const escapes = unsupportedEscapes(frontmatter.get(file) ?? "");
    if (escapes.length)
      say(
        `BAD ESCAPE     ${rel(file)}: ${escapes.join(", ")}  (frontmatter decodes only \\" \\\\ \\/ \\n \\t \\r)`
      );
  }

  // --- links + anchors, and the graph they form -----------------------------------------
  const anchorCache = new Map<string, Set<string>>();
  const bodyOf = (f: string): string => body.get(f) ?? readFileSync(f, "utf8");

  const outbound = new Map<string, Set<string>>();
  for (const file of files) {
    const res = checkLinks(file, body.get(file) ?? "", { anchorCache, bodyOf });
    outbound.set(file, new Set(res.outbound));
    for (const p of res.problems) {
      say(
        p.kind === "MISSING FILE"
          ? `MISSING FILE   ${rel(file)}: ${p.target}`
          : `MISSING ANCHOR ${rel(file)}: ${p.target}  (#${p.anchor} not a heading)`
      );
    }
  }

  // --- no page is an orphan --------------------------------------------------------------
  // Transitive: a page linked only from a cataloged sibling still counts as reachable.
  const reached = new Set<string>();
  if (!existsSync(INDEX)) {
    say(
      `NO CATALOG     ${rel(INDEX)} is missing — every page is an orphan without it.`
    );
  } else {
    reached.add(INDEX);
    const queue = [INDEX];
    while (queue.length) {
      const current = queue.pop();
      if (current === undefined) break;
      for (const next of outbound.get(current) ?? []) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    for (const file of files) {
      if (file === INDEX || isContract(file)) continue;
      if (!reached.has(file))
        say(
          `ORPHAN         ${rel(file)}  (unreachable from index.md — add its catalog line)`
        );
    }
  }

  // --- `related:` edges must resolve -----------------------------------------------------
  // Keys are `type/slug` where slug is the BASENAME, so a page's folder can move without
  // rewriting every `related:` that points at it.
  //
  // That indirection is what makes collisions possible, and a Map resolves one by keeping the
  // LAST page written — silently. Two pages sharing a `type/slug` make every `related:` edge
  // pointing at that key ambiguous, and nothing downstream can tell which one was meant, so the
  // duplicate is reported here rather than resolved by insertion order.
  const byTypeSlug = new Map<string, string>();
  for (const file of files) {
    const t = fieldsOf(file).get("type");
    if (!t) continue;
    const key = `${t}/${file.slice(file.lastIndexOf("/") + 1, -3)}`;
    const first = byTypeSlug.get(key);
    if (first)
      say(
        `DUPLICATE KEY  ${rel(file)}: "${key}" already used by ${rel(first)}`
      );
    else byTypeSlug.set(key, file);
  }
  for (const file of files) {
    for (const entry of yamlList(fieldsOf(file).get("related"))) {
      if (!byTypeSlug.has(entry))
        say(
          `BAD related    ${rel(file)}: "${entry}" matches no page (expected \`type/slug\`)`
        );
    }
  }

  // --- project-specific checks -----------------------------------------------------------
  if (config.extraChecks) {
    const pages: LintPage[] = files.map((f) => ({
      path: f,
      rel: rel(f),
      fields: fieldsOf(f),
      body: body.get(f) ?? "",
    }));
    for (const p of config.extraChecks(pages)) say(p);
  }

  // --- the graph -------------------------------------------------------------------------
  const linksIn = new Map<string, string[]>();
  for (const [from, tos] of outbound)
    for (const to of tos)
      linksIn.set(to, [...(linksIn.get(to) ?? []), rel(from)]);

  const tagIndex: Record<string, string[]> = {};
  const typeIndex: Record<string, string[]> = {};
  for (const file of files) {
    const f = fieldsOf(file);
    const t = f.get("type");
    if (t) {
      const list = typeIndex[t] ?? [];
      list.push(rel(file));
      typeIndex[t] = list;
    }
    for (const tag of yamlList(f.get("tags"))) {
      const list = tagIndex[tag] ?? [];
      list.push(rel(file));
      tagIndex[tag] = list;
    }
  }

  const nodes: DocsLintNode[] = files.map((file) => {
    const f = fieldsOf(file);
    const tags = yamlList(f.get("tags"));
    // Pages sharing >=1 tag. Without this the graph shows the atomic pages as
    // disconnected, which is a misread — tags ARE their adjacency.
    const tagNeighbors = [
      ...new Set(
        tags.flatMap((t) => tagIndex[t] ?? []).filter((p) => p !== rel(file))
      ),
    ];
    return {
      path: rel(file),
      type: f.get("type") ?? null,
      title: f.get("title") ?? null,
      description: f.get("description") ?? null,
      tags,
      status: f.get("status") ?? null,
      // `generated` is a mapping, so emit it as one. It used to go out as the
      // raw inline-flow YAML text — `"{ by: x, at: 2026-09-04 }"` — while
      // `tags` beside it was a proper array, so a consumer wanting to sort by
      // date had to re-parse YAML out of a JSON string. The gate already
      // parses it; only the serialization lagged.
      [DATE_FIELD]:
        DATE_FIELD === "generated"
          ? (parseGenerated(f.get("generated")) ?? null)
          : (f.get(DATE_FIELD) ?? null),
      linksOut: [...(outbound.get(file) ?? [])].map(rel),
      linksIn: linksIn.get(file) ?? [],
      related: yamlList(f.get("related")),
      tagNeighbors,
      reachable: reached.has(file) || file === INDEX,
      // the contract is exempt from the orphan rule — flag it so `reachable:false` isn't
      // read as a defect
      contractExempt: isContract(file),
    };
  });

  const hubs = [...nodes]
    .filter((n) => n.path !== "index.md")
    .sort((a, b) => b.linksIn.length - a.linksIn.length)
    .slice(0, 10)
    .map((n) => ({
      path: n.path,
      linksIn: n.linksIn.length,
      title: n.title,
    }));

  return {
    root: rel(ROOT) || ".",
    contract: "SCHEMA.md",
    catalog: "index.md",
    stats: {
      pages: nodes.length,
      linkEdges: [...outbound.values()].reduce((n, s) => n + s.size, 0),
      relatedEdges: nodes.reduce((n, x) => n + x.related.length, 0),
      tags: Object.keys(tagIndex).length,
      // Must mirror the lint's own exemption above: SCHEMA.md is the contract, not a
      // page, so it is never an orphan even when nothing links to it.
      orphans: nodes.filter((n) => !n.reachable && !n.contractExempt).length,
    },
    hubs,
    typeIndex,
    tagIndex,
    nodes,
    problems,
  };
}

/** The human summary line `runDocsLint` prints when the lint is clean or not. */
export function docsLintSummary(report: DocsLintReport): string {
  return report.problems.length === 0
    ? `OK — links, anchors, OKF frontmatter, catalog reachability and \`related\` edges all valid across ${report.stats.pages} files.`
    : `\n${report.problems.length} problem(s).`;
}

/** The printing entry point — lint lines then a summary, or the graph as JSON. */
export function runDocsLint(config: DocsLintConfig): number {
  const { json, ...rest } = config;
  const report = collectDocsLint(rest);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const p of report.problems) console.log(p);
    console.log(docsLintSummary(report));
  }
  return report.problems.length;
}
