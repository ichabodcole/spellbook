/**
 * Links between documents (E33): what a document points at, and what that
 * resolves to inside a set.
 *
 * ── FOUR SOURCES OF EDGES, AND THEY ARE NOT ONE KIND ─────────────────────────
 *
 *   1. markdown links      `[label](./other.md)`      — body
 *   2. wiki links          `[[other-doc|label]]`      — body
 *   3. frontmatter values  `related: [concept/x]`     — authored intent
 *   4. `sources[].resource`                           — authored intent
 *
 * pdocs keeps the frontmatter edge and the body-link edge APART (`related[]`
 * and `links[]` in its `backlinks` output), and the distinction is real: a
 * `related` key is a claim the author made about the document as a whole, a
 * body link is a citation at a place in the prose. They stay apart here too.
 *
 * ── TYPED LINKS (Operator's shape, Cole 2026-09-11) ─────────────────────────
 *
 * A relation rides the link as a query: `[label](./other.md?rel=extends)`,
 * `[[other?rel=supersedes|label]]`. Copied exactly from Operator's parser
 * (`packages/shared/src/links/`): one link carries ALL of its rels, they are
 * normalised (lowercased, trimmed, deduped, first-authored order kept) but
 * their SPELLING is not canonicalised, and **a bare link is `[]` — the ABSENCE
 * of an assertion, not an implicit `references`**. A graph must not draw a
 * claim nobody made.
 *
 * ── WHAT A BUNDLE IS ────────────────────────────────────────────────────────
 *
 * OKF's bundle-relative form (`/concepts/x.md`) means the BUNDLE root, not the
 * filesystem root, so a resolver needs a bundle before it can resolve anything:
 * **a set's entry root is the bundle** (E33). A target that escapes it is not an
 * error — the spec requires tolerating broken links — it is an edge marked
 * `outside` or `missing`, which the surface offers to add rather than follow.
 */
import {
  basename,
  dirname,
  extname,
  join,
  normalize,
  relative,
  resolve as resolvePath,
} from "node:path";
import type { DocMeta } from "./protocol";
import { toPosix } from "./tree";

export type LinkKind = "markdown" | "wiki";

/** One link as written, before anything is resolved. */
export type LinkRef = {
  kind: LinkKind;
  /** The target as authored, with its query and anchor stripped. */
  target: string;
  /**
   * The target EXACTLY as written — query, anchor, percent-encoding and all.
   *
   * ⛔ THIS IS WHAT MAKES A DANGLING LINK FIXABLE. `target` is the resolved
   * shape, so a report built from it tells you to look for `deep.md` when the
   * document actually says `./missing/deep.md?rel=x` — a string that is not in
   * the file. Whoever (or whatever) goes to repair the link needs the string
   * that is there.
   */
  raw: string;
  /** 1-based line in the body the link was written on, for the same reason. */
  line: number;
  /** Relations from `?rel=`; EMPTY means no assertion, never `references`. */
  rel: string[];
  label?: string;
};

/** A reference found in frontmatter, with the key that carried it. */
export type FieldRef = { key: string; value: string };

// ── where markdown is code ──────────────────────────────────────────────────
//
// Ported from Story Studio's kit (`packages/kit/src/lib/markdownCode.ts`,
// story-studio@a57d65a), which took it from the same lineage as this file.
// Line-based and deliberately small: there is no parse tree here to ask.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED = /^( {4}|\t)/;
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;
const BLANK = /^\s*$/;
/** A blockquote's markers at the start of a line, nested or not. */
const QUOTE = /^ {0,3}(?:> ?)+/;
/** A fence at any indentation, for a list item's content or a quote's. */
const FENCE_ANY = /^\s*(`{3,}|~{3,})/;

/**
 * The fence a line opens or closes, if any, and what follows it. Inside a
 * quote the `>` markers are read past, and inside a list item (or a quote) the
 * fence may be indented to the item's content.
 */
function fenceOf(line: string, nested: boolean): { marker: string; rest: string } | null {
  const q = QUOTE.exec(line);
  const body = q ? line.slice(q[0].length) : line;
  const m = (q || nested ? FENCE_ANY : FENCE).exec(body);
  return m ? { marker: m[1] as string, rest: body.slice(m[0].length) } : null;
}

/**
 * The indices of the lines inside a code block: a fenced block with its fence
 * lines, or an indented block (four spaces or a tab, opened after a blank line
 * and not continuing a list). An unclosed fence runs to the end, as markdown
 * reads it.
 */
function codeBlockLines(lines: readonly string[]): Set<number> {
  const out = new Set<number>();
  let fence: string | null = null;
  let inList = false;
  let indented = false;
  let prevBlank = true;
  lines.forEach((line, i) => {
    if (fence !== null) {
      out.add(i);
      const m = fenceOf(line, true);
      if (m && m.marker[0] === fence[0] && m.marker.length >= fence.length && BLANK.test(m.rest))
        fence = null;
      return;
    }
    const blank = BLANK.test(line);
    if (indented && (blank || INDENTED.test(line))) {
      out.add(i);
      prevBlank = blank;
      return;
    }
    indented = false;
    const f = fenceOf(line, inList);
    if (f) {
      fence = f.marker;
      out.add(i);
      prevBlank = false;
      return;
    }
    if (!blank && INDENTED.test(line) && prevBlank && !inList) {
      indented = true;
      out.add(i);
      prevBlank = false;
      return;
    }
    if (!blank && !INDENTED.test(line)) inList = LIST_ITEM.test(line) || (inList && !prevBlank);
    prevBlank = blank;
  });
  return out;
}

/** Inline code spans in a line, as `[from, to)` ranges; an unclosed run is not a span. */
function inlineSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const runs = [...line.matchAll(/(?<!\\)`+/g)].map((m) => ({
    at: m.index as number,
    len: m[0].length,
  }));
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i] as { at: number; len: number };
    const close = runs.slice(i + 1).findIndex((r) => r.len === open.len);
    if (close === -1) continue;
    const end = runs[i + 1 + close] as { at: number; len: number };
    spans.push([open.at, end.at + end.len]);
    i += 1 + close;
  }
  return spans;
}

/**
 * `text` with its code blanked IN PLACE: every character of a code block
 * (fenced or indented) or an inline span, its ticks included, becomes a space,
 * and line breaks stay. The result is exactly as long as `text`, so an offset
 * found in it is an offset in `text`.
 *
 * ⛔ A DOCUMENT ABOUT LINKS QUOTES LINK SYNTAX, and it does so in code: the wiki
 * this was built against has SCHEMA.md's fenced examples, and CONTRIBUTING-style
 * prose lists example links in backticks. Fenced code alone was blanked once
 * (`withoutFences`); inline and indented code were edges until #126.
 */
export function maskCode(text: string): string {
  const lines = text.split("\n");
  const blocks = codeBlockLines(lines);
  return lines
    .map((line, i) => {
      if (blocks.has(i)) return " ".repeat(line.length);
      let out = "";
      let at = 0;
      for (const [from, to] of inlineSpans(line)) {
        out += line.slice(at, from) + " ".repeat(to - from);
        at = to;
      }
      return out + line.slice(at);
    })
    .join("\n");
}

/** `?rel=a,b` → `["a","b"]`, normalised the way Operator normalises them. */
export function parseRel(query: string | undefined): string[] {
  if (!query) return [];
  const m = /(?:^|[?&])rel=([^&]*)/.exec(query);
  if (!m) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of decodeURIComponent(m[1] ?? "").split(",")) {
    const rel = raw.trim().toLowerCase();
    if (rel === "" || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

/** Split a written target into its path, its query and its anchor. */
/**
 * Percent-decoding, which a markdown link target carries whenever the file it
 * names has a space in it — `Maren's%20Bakery.md` (E49).
 *
 * ⛔ IT MUST NOT THROW. `decodeURIComponent` rejects a lone `%`, and a file
 * called `100% done.md` is a perfectly ordinary thing to link to. An
 * undecodable target is returned as it stands: worst case it fails to resolve,
 * which is the behaviour before decoding existed, rather than taking the graph
 * down with it.
 */
function decodePath(raw: string): string {
  if (!raw.includes("%")) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function splitTarget(raw: string): { path: string; query?: string; anchor?: string } {
  const hash = raw.indexOf("#");
  const withoutAnchor = hash === -1 ? raw : raw.slice(0, hash);
  const anchor = hash === -1 ? undefined : raw.slice(hash + 1);
  const q = withoutAnchor.indexOf("?");
  return {
    path: decodePath((q === -1 ? withoutAnchor : withoutAnchor.slice(0, q)).trim()),
    ...(q === -1 ? {} : { query: withoutAnchor.slice(q + 1) }),
    ...(anchor ? { anchor } : {}),
  };
}

const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;
/** One label character: anything but a bracket, and a line break only when the next line is not blank. */
const LABEL_CHAR = String.raw`(?:[^\[\]\n]|\n(?![ \t]*\r?\n))`;
/** An ATX heading line: a heading ends at its line break, and so does any label in it. */
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
/**
 * `[label](target)` or `[label](<target>)`, with an optional title in double or
 * single quotes; `!` marks an image. A label may hold one level of brackets
 * (`[a [b] c](x.md)`) and run onto the next line; a target may hold one level
 * of balanced parentheses. Matched with indices (`d`), so every part can be
 * read back out of the ORIGINAL text. (Ported from story-studio@a57d65a.)
 */
const MD_LINK = new RegExp(
  String.raw`(!?)\[((?:${LABEL_CHAR}|\[${LABEL_CHAR}*\])*)\]\(\s*(?:<([^>\n]*)>|((?:[^\s()]|\([^\s()]*\))*))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)`,
  "gd",
);
const WIKI_LINK = /\[\[([^[\]\n]+)\]\]/dg;
/** An HTML comment, to its end or to the end of the text when it never closes. */
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
/** A backslash escape: markdown's, of any ASCII punctuation. */
const ESCAPE = /\\[!-/:-@[-`{-~]/g;

const unescapeMd = (s: string) => s.replace(ESCAPE, (e) => e.slice(1));

/**
 * The text with everything that cannot hold a link blanked IN PLACE, so every
 * offset in it is an offset in the original: code (fenced, indented, inline)
 * and HTML comments become spaces, and a backslash escape becomes two
 * placeholder characters, so `\[` opens nothing and `\]` closes nothing while
 * the escaped text keeps its place. Line breaks always stay.
 */
function linkable(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return maskCode(text).replace(COMMENT, blank).replace(ESCAPE, "\u0001\u0001");
}

/**
 * Every link a document's BODY points at, in order: markdown links and wiki
 * links, with images, external targets (`https:`, `mailto:`) and in-page
 * anchors (`#x`) left out, and nothing inside code (fenced, indented or
 * inline) or an HTML comment, which hold examples and asides, not links. A
 * backslash-escaped bracket is text.
 *
 * Matched over the whole body with what cannot hold a link blanked in place
 * (`linkable`), so offsets need no mapping back: the target as written and the
 * label are read straight out of the original text, and `line` is the body
 * line the link starts on. A label may run onto the next line, as markdown
 * allows, but a blank line or the end of an ATX heading line ends it.
 *
 * Reference-style links (`[x][ref]` with `[ref]: ./a.md`) are not read, here
 * or in the kit this was ported from.
 */
export function extractLinks(body: string): LinkRef[] {
  if (!body.includes("[")) return [];
  const text = body;
  const masked = linkable(text);
  // ⚠ LINES FROM A PRECOMPUTED TABLE. Walking from the start of the text for
  // every link made extraction O(links × length) on a long document (#126).
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  /** The 0-based line holding offset `at`. */
  const lineOf = (at: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const lineText = (i: number) =>
    text.slice(starts[i], (starts[i + 1] ?? text.length + 1) - 1).replace(/\r$/, "");

  // Matched one at a time, so a rejected match can be retried one character on:
  // a label holding a whole link (`[see [x](./y.md)](./z.md)`) is not one link,
  // and retrying finds the inner `[x](./y.md)`, which is the one markdown
  // renders. A label that runs past the end of a heading line is not one
  // either: the heading ended there.
  const md: RegExpExecArray[] = [];
  MD_LINK.lastIndex = 0;
  for (let m = MD_LINK.exec(masked); m; m = MD_LINK.exec(masked)) {
    const label = m[2] ?? "";
    const crossesHeading = label.includes("\n") && ATX_HEADING.test(lineText(lineOf(m.index)));
    if (label.includes("](") || crossesHeading) {
      MD_LINK.lastIndex = m.index + 1;
      continue;
    }
    md.push(m);
  }
  const mdSpans: [number, number][] = md.map((m) => [m.index, m.index + m[0].length]);
  const wiki = [...masked.matchAll(WIKI_LINK)].filter(
    (m) => !mdSpans.some(([a, b]) => m.index < b && m.index + m[0].length > a),
  );
  const slice = (m: RegExpMatchArray, g: number) => {
    const at = m.indices?.[g];
    return at ? text.slice(at[0], at[1]) : undefined;
  };

  const out: (LinkRef & { at: number })[] = [];
  for (const m of md) {
    if (m[1] === "!") continue; // an image is not a document link
    const raw = slice(m, 3) ?? slice(m, 4) ?? "";
    if (raw === "" || raw.startsWith("#") || EXTERNAL.test(raw)) continue;
    const { path, query } = splitTarget(unescapeMd(raw));
    if (path === "") continue;
    const label = unescapeMd(slice(m, 2) ?? "")
      .replace(/\s*\n\s*/g, " ")
      .trim();
    out.push({
      at: m.index,
      kind: "markdown",
      target: path,
      raw,
      line: lineOf(m.index) + 1,
      rel: parseRel(query),
      ...(label ? { label } : {}),
    });
  }
  for (const m of wiki) {
    const inner = slice(m, 1) ?? "";
    const pipe = inner.indexOf("|");
    const targetPart = pipe === -1 ? inner : inner.slice(0, pipe);
    const label = pipe === -1 ? undefined : inner.slice(pipe + 1).trim();
    const { path, query } = splitTarget(targetPart);
    if (path === "") continue;
    out.push({
      at: m.index,
      kind: "wiki",
      target: path,
      raw: targetPart,
      line: lineOf(m.index) + 1,
      rel: parseRel(query),
      ...(label ? { label } : {}),
    });
  }
  return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...link }) => link);
}

/** Does this frontmatter value LOOK like a document reference? */
export function looksLikeRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v === "" || EXTERNAL.test(v)) return false;
  return v.includes("/") || v.toLowerCase().endsWith(".md");
}

/**
 * References inside frontmatter, whatever key carries them — `related`,
 * `supersedes`, `sources[].resource`, or a key invented tomorrow. The SHAPE
 * decides (a slash or a `.md`), which is why bare `tags` are not references.
 */
export function fieldRefs(fields: Record<string, unknown>, maxDepth = 4): FieldRef[] {
  const out: FieldRef[] = [];
  const walk = (key: string, value: unknown, depth: number) => {
    if (depth > maxDepth) return;
    if (looksLikeRef(value)) out.push({ key, value: value.trim() });
    else if (Array.isArray(value)) for (const v of value) walk(key, v, depth + 1);
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        walk(`${key}.${k}`, v, depth + 1);
  };
  for (const [k, v] of Object.entries(fields)) walk(k, v, 0);
  return out;
}

/**
 * Where a target landed. `outside` is a file on disk but not in this bundle;
 * `folder` is a folder on disk, which names no document (#123).
 */
export type Resolution =
  | { state: "in-bundle"; path: string }
  | { state: "outside"; path: string }
  | { state: "folder"; path: string }
  | { state: "missing"; tried: string };

export type BundleIndex = {
  /** The set's root — OKF's bundle, and what a `/`-target is relative to. */
  root: string;
  /** Absolute paths of every document in the bundle. */
  paths: readonly string[];
  /** A document's parsed frontmatter, for `type/slug` resolution. */
  metaOf: (path: string) => DocMeta | null;
  /** Does this path exist on disk as a file? (Injected, so the resolver stays pure.) */
  exists: (path: string) => boolean;
  /**
   * Does this path exist on disk as a folder? Absent means "never", which is
   * what a resolver without a disk (a test, a preview) should assume.
   */
  isDir?: (path: string) => boolean;
  /**
   * The git working tree the bundle sits in, when there is one. A third place
   * an unanchored path is tried: pdocs writes repo-relative paths
   * (`docs/playbooks/foo.md`) and the wiki's rule pages carry repo-relative
   * `checker:` values, and neither resolves from the document or the bundle.
   */
  repoRoot?: string | null;
};

const stem = (p: string) => basename(p, extname(p));

/** A path without its trailing separator, unless it is only one. */
const trimSlash = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, "") || p : p);

/**
 * Resolve one written target against the bundle.
 *
 * Four forms, in order: a bundle-relative path (`/x/y.md`), a relative path
 * (`./y.md`, `../x/y.md`), a `type/slug` key — pdocs' and the wiki's own form,
 * which resolves by TYPE and BASENAME so a page can move folders without
 * breaking inbound references — and a bare name (a wiki link), by basename.
 */
export function resolveTarget(rawTarget: string, from: string, index: BundleIndex): Resolution {
  // ⛔ SPLIT FIRST, BECAUSE THE CALLERS DISAGREE ABOUT WHAT THEY HAND OVER.
  // `extractLinks` splits a target before it ever gets here (E49), but the
  // CLICK path does not: `link.open` carries the href exactly as the document
  // wrote it. So an Operator typed link — `Maren's%20Bakery.md?rel=located-in`
  // — arrived with its query and its encoding intact, `extname` read
  // `.md?rel=located-in`, and the lookup went hunting for a file named after
  // the whole string. The GRAPH drew that edge correctly the entire time, which
  // is what made it puzzling: the same link was fine in the map and dead under
  // the pointer. Splitting here fixes every caller at once and is idempotent
  // for the two that had already done it. (Cole found it by clicking one in
  // Hollowbrook, 2026-09-14.)
  const target = splitTarget(rawTarget).path;
  // ⛔ WHAT MAKES A TARGET A PATH RATHER THAN A KEY, and the case that taught
  // it: `[the linter](lint.ts)` in the real wiki has no `./` and is not a `.md`,
  // so a rule keyed on those two read it as a NAME and reported it missing
  // while the file sat right there. A target is a path when it is anchored
  // (`/`, `./`, `../`) or carries ANY extension; `concept/exit-codes` has
  // neither, which is what keeps a `type/slug` key a key.
  // ⛔ A TRAILING SLASH NAMES A FOLDER, and only a folder (#123). Read as a key,
  // `locations/` matched any `locations.md` by basename; read as a path, it had
  // `.md` appended and was reported as a missing file beside a folder that
  // plainly exists.
  const folderish = target.length > 1 && target.endsWith("/");
  const looksPath =
    folderish ||
    target.startsWith("/") ||
    target.startsWith("./") ||
    target.startsWith("../") ||
    extname(target) !== "";
  if (looksPath) {
    // An UNANCHORED path (`src/acc/kit/x.ts`, `reports/a.md` — no `./` and no
    // leading `/`) is ambiguous: relative to the document, or to the bundle?
    // Both are tried, document first. Measured on the real wiki, where a rule
    // page's `checker: src/acc/kit/checkers/…` was reported missing while
    // resolving from the bundle root would have found it.
    const anchored = target.startsWith("/") || target.startsWith("./") || target.startsWith("../");
    const candidates = (
      target.startsWith("/")
        ? [normalize(join(index.root, target))]
        : anchored
          ? [normalize(resolvePath(dirname(from), target))]
          : [
              normalize(resolvePath(dirname(from), target)),
              normalize(join(index.root, target)),
              ...(index.repoRoot ? [normalize(join(index.repoRoot, target))] : []),
            ]
    ).map(trimSlash);
    // ⛔ `.md` IS APPENDED ONLY TO LOOK FOR A FILE, never before asking whether
    // the bare candidate is a folder (#123). A document beats a folder of the
    // same name (`locations` with both `locations.md` and `locations/`), which
    // is how Story Studio's kit orders it too.
    const tried = candidates.map((c) => (extname(c) === "" ? `${c}.md` : c));
    if (!folderish) {
      for (const c of tried) if (index.paths.includes(c)) return { state: "in-bundle", path: c };
      for (const c of tried) if (index.exists(c)) return { state: "outside", path: c };
    }
    for (const c of candidates) if (index.isDir?.(c)) return { state: "folder", path: c };
    return { state: "missing", tried: (folderish ? candidates[0] : tried[0]) as string };
  }
  const slash = target.indexOf("/");
  if (slash > 0) {
    // `type/slug`: the type is a claim the target's own frontmatter must make.
    const type = target.slice(0, slash);
    const slug = target.slice(slash + 1);
    for (const p of index.paths)
      if (stem(p) === slug && index.metaOf(p)?.type === type)
        return { state: "in-bundle", path: p };
  }
  const hit = index.paths.find((p) => stem(p) === stem(target));
  if (hit) return { state: "in-bundle", path: hit };
  // A bare name no document answers may still be a folder beside the document,
  // or at the bundle root: `[the places](locations)`.
  for (const c of [resolvePath(dirname(from), target), normalize(join(index.root, target))])
    if (index.isDir?.(c)) return { state: "folder", path: c };
  return { state: "missing", tried: target };
}

/** An edge in a set's map. `rel` empty means no assertion was made. */
export type Edge = {
  from: string;
  /** Absolute path when resolved; the written target when not. */
  to: string;
  /** A body link, or a frontmatter value — kept apart, as pdocs keeps them. */
  source: "link" | "frontmatter";
  /** The frontmatter key that carried it (`related`, `sources.resource`, …). */
  key?: string;
  /**
   * For a BODY link: the target as written, and the line it is on. Absent for a
   * frontmatter reference, where `key` is the address instead.
   */
  raw?: string;
  line?: number;
  rel: string[];
  state: Resolution["state"];
};

export type GraphNode = {
  path: string;
  rel: string;
  title: string;
  type?: string;
  status: string;
  stale: boolean;
  tags: string[];
  linksOut: number;
  linksIn: number;
};

export type Graph = {
  root: string;
  nodes: GraphNode[];
  edges: Edge[];
  /** Targets nothing in the bundle answers — said, never an error (OKF §11). */
  dangling: number;
};

/** Build a set's map: nodes are its documents, edges are the four sources. */
export function buildGraph(index: BundleIndex, bodyOf: (path: string) => string, cap = 400): Graph {
  const paths = index.paths.slice(0, cap);
  const edges: Edge[] = [];
  for (const from of paths) {
    const meta = index.metaOf(from);
    for (const link of extractLinks(bodyOf(from))) {
      const r = resolveTarget(link.target, from, index);
      edges.push({
        from,
        to: r.state === "missing" ? r.tried : r.path,
        source: "link",
        raw: link.raw,
        line: link.line,
        rel: link.rel,
        state: r.state,
      });
    }
    for (const ref of meta ? fieldRefs(meta.fields) : []) {
      const r = resolveTarget(ref.value, from, index);
      edges.push({
        from,
        to: r.state === "missing" ? r.tried : r.path,
        source: "frontmatter",
        key: ref.key,
        rel: [],
        state: r.state,
      });
    }
  }
  const outOf = new Map<string, number>();
  const intoOf = new Map<string, number>();
  for (const e of edges) {
    outOf.set(e.from, (outOf.get(e.from) ?? 0) + 1);
    if (e.state === "in-bundle") intoOf.set(e.to, (intoOf.get(e.to) ?? 0) + 1);
  }
  const nodes: GraphNode[] = paths.map((path) => {
    const meta = index.metaOf(path);
    return {
      path,
      rel: toPosix(relative(index.root, path)),
      title: meta?.title ?? stem(path),
      ...(meta?.type ? { type: meta.type } : {}),
      status: meta?.status ?? "stable",
      stale: meta?.stale ?? false,
      tags: meta?.tags ?? [],
      linksOut: outOf.get(path) ?? 0,
      linksIn: intoOf.get(path) ?? 0,
    };
  });
  return {
    root: index.root,
    nodes,
    edges,
    dangling: edges.filter((e) => e.state === "missing").length,
  };
}
