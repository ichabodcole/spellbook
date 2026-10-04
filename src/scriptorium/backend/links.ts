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
import { parse, postprocess, preprocess } from "micromark";
import { gfm } from "micromark-extension-gfm";
import type { DocMeta } from "./protocol";
import { DOC_EXTENSIONS, toPosix } from "./tree";

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
  /**
   * The target's scheme, lower-cased and without its colon (`op`, `https`), on a
   * link read with `{ schemes: true }` only (#128). Absent on every link that
   * names a path.
   */
  scheme?: string;
};

/** A reference found in frontmatter, with the key that carried it. */
export type FieldRef = { key: string; value: string };

// ── where markdown is code ──────────────────────────────────────────────────
//
// ⛔ ASKED OF THE RENDERER'S OWN PARSER, NOT GUESSED LINE BY LINE. #126 ported
// Story Studio's line-based scanner (`packages/kit/src/lib/markdownCode.ts`,
// story-studio@a57d65a), and the verifier found three places it disagreed with
// what the rendered view shows: indented code inside a list item, indented code
// inside a blockquote, and a code span that runs onto the next line. Each needs
// CommonMark's container rules (where an item's content starts, what a `>`
// carries), which is a parser's job. The rendered view is micromark + GFM
// (`surface/state/markdown.ts`), so the same parser, with the same extension,
// says where code is here: whatever it calls code, the reader sees as code.

/** micromark's names for code: a fenced block, an indented block, an inline span. */
const CODE_TOKENS: ReadonlySet<string> = new Set(["codeFenced", "codeIndented", "codeText"]);
/**
 * micromark's names for raw HTML: a block, and a tag or comment inside a line.
 * Only the ones that open with `<!--` are masked (see `maskCode`).
 */
const HTML_TOKENS: ReadonlySet<string> = new Set(["htmlFlow", "htmlText"]);
/** `<!--` at the sticky position, after any indentation. */
const OPENS_COMMENT = /[ \t]*<!--/y;
/** Built once: the same extension the rendered view parses with. */
const GFM = [gfm()];

/**
 * The `[from, to)` offsets of every piece of code in `text`, as the rendered
 * view parses it, and with `comments`, of every HTML comment too.
 */
function codeRanges(text: string, comments: boolean): Array<[number, number]> {
  const events = postprocess(
    parse({ extensions: GFM })
      .document()
      .write(preprocess()(text, undefined, true)),
  );
  const out: Array<[number, number]> = [];
  for (const [kind, token] of events) {
    if (kind !== "enter") continue;
    const from = token.start.offset;
    if (CODE_TOKENS.has(token.type)) out.push([from, token.end.offset]);
    else if (comments && HTML_TOKENS.has(token.type)) {
      // A block's token starts at its indentation, so `  <!--` opens a comment too.
      OPENS_COMMENT.lastIndex = from;
      if (OPENS_COMMENT.test(text)) out.push([from, token.end.offset]);
    }
  }
  return out;
}

/** Could anything in `text` open code? */
const MAY_OPEN_CODE = /[`~]|( {4}|\t)/;

/**
 * `text` with its code blanked IN PLACE: every character of a code block
 * (fenced or indented, at any depth of list or quote) or an inline span (on one
 * line or several), its ticks included, becomes a space, and line breaks stay.
 * The result is exactly as long as `text`, so an offset found in it is an
 * offset in `text`.
 *
 * With `{ comments: true }`, HTML comments are blanked the same way, and only
 * what the rendered view treats as one:
 *
 * ⛔ AN UNCLOSED `<!--` INSIDE A LINE IS TEXT (round three of this cycle). A
 * regex that ran a comment "to its end, or to the end of the text" hid every
 * link below `Use <!-- to open a comment.`, while the renderer shows those four
 * characters as text and every later link as a link. So the renderer's parser
 * says where a comment is: one inside a line must close in its paragraph, and
 * one that opens a line is an HTML block, which runs to the line holding `-->`
 * or to the end of its container (a quote, a list item, the document). The
 * view shows that whole block as text, so a link after `-->` on the same line
 * is text too. Other HTML blocks are left as they were: their links still
 * count, which is filed apart.
 *
 * ⛔ A DOCUMENT ABOUT LINKS QUOTES LINK SYNTAX, and it does so in code: the wiki
 * this was built against has SCHEMA.md's fenced examples, and CONTRIBUTING-style
 * prose lists example links in backticks. Fenced code alone was blanked once
 * (`withoutFences`); inline and indented code were edges until #126.
 */
export function maskCode(text: string, opts: { comments?: boolean } = {}): string {
  const comments = opts.comments === true && text.includes("<!--");
  if (!comments && !MAY_OPEN_CODE.test(text)) return text; // nothing here can open code
  let out = "";
  let at = 0;
  for (const [from, to] of codeRanges(text, comments)) {
    if (from < at) continue; // nested inside a range already blanked
    out += text.slice(at, from) + text.slice(from, to).replace(/[^\r\n]/g, " ");
    at = to;
  }
  return out + text.slice(at);
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
/**
 * `//cdn.example.com/x`: a URL that borrows the page's scheme, so a host and
 * not a path. A browser opens it on the web (http or https), so it is neither
 * an edge nor a scheme to report.
 */
const PROTOCOL_RELATIVE = /^\/\/[^/]/;
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
/** An image inside a link's label (whose brackets nest one level only), target and title included. */
const IMAGE_IN_LABEL =
  /!\[[^[\]]*\]\(\s*(?:<[^>\n]*>|(?:[^\s()]|\([^\s()]*\))*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const WIKI_LINK = /\[\[([^[\]\n]+)\]\]/dg;
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
/** Web schemes: the surface opens these outward, so a link with one works. */
export const OPENS_OUTWARD: ReadonlySet<string> = new Set(["http", "https", "mailto"]);

/** What `extractLinks` keeps beyond document links. */
export type ExtractOptions = {
  /**
   * Keep markdown targets with a scheme (`op:doc/…`, `https:`), each marked with
   * its `scheme` (#128). The map needs them to report the ones nothing here
   * opens; nothing that RESOLVES a link wants them.
   */
  schemes?: boolean;
};

function linkable(text: string): string {
  return maskCode(text, { comments: true }).replace(ESCAPE, "\u0001\u0001");
}

/**
 * Every link a document's BODY points at, in order: markdown links and wiki
 * links, with images, external targets (`https:`, `mailto:`, `op:`, and a
 * protocol-relative `//host/x`) and in-page anchors (`#x`) left out (a link
 * wrapped around an image is kept, by its outer target; the image is not), unless `opts.schemes` keeps the scheme
 * targets (each marked with its `scheme`), and nothing inside code (fenced, indented or
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
export function extractLinks(body: string, opts: ExtractOptions = {}): LinkRef[] {
  // ⚠ NO `](` AND NO `[[`, NO LINK, and the parse is skipped. Exact, not a
  // guess: masking only turns characters into spaces, so it cannot make a `](`
  // or a `[[` that the text does not already hold, and every markdown link
  // needs the one and every wiki link the other. On this repo's docs/ it keeps
  // 266 of 550 documents (35% of the text) away from micromark (round three).
  if (!body.includes("](") && !body.includes("[[")) return [];
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
    // ⚠ AN IMAGE IN A LABEL IS NOT A LINK IN A LABEL: `[![badge](./b.png)](./real.md)`
    // renders as one link around a picture, so the outer target is the edge.
    // Rejecting it as a nested link left only the image, which is never one.
    const holdsLink = label.replace(IMAGE_IN_LABEL, "").includes("](");
    if (holdsLink || crossesHeading) {
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
    if (raw === "" || raw.startsWith("#") || PROTOCOL_RELATIVE.test(raw)) continue;
    // ⚠ ANY SCHEME-SHAPED PREFIX IS A SCHEME, which is the surface's rule too
    // (`state/markdown.ts`): it strikes every one but http, https and mailto
    // through, so the map must not call such a link a path.
    const scheme = EXTERNAL.exec(raw)?.[0].slice(0, -1).toLowerCase();
    if (scheme !== undefined && !opts.schemes) continue;
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
      ...(scheme !== undefined ? { scheme } : {}),
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

/** The longest file or folder name a disk holds (macOS, Linux, Windows: 255). */
const NAME_MAX = 255;
/** A name's extension, as a value ending in one has it: `.md`, `.png`. */
const ENDS_IN_EXTENSION = /\.[a-z0-9]{1,8}$/i;
/** Where prose breaks: a clause mark followed by a space, or a spaced dash. */
const SENTENCE_BREAK = /[.,;:!?][ \t]|[ \t][—–][ \t]/;

/**
 * Does this frontmatter value LOOK like a document reference?
 *
 * ⛔ A SLASH IN PROSE IS NOT A PATH (round three of this cycle). `graph` and
 * `dangling` threw ENAMETOOLONG on this repo's own docs/ while `doctor` called
 * it clean: a session's `description` read "… the CLI/server pair … finalize.",
 * the slash made it a reference, and the disk refused to look it up. 53 titles
 * and descriptions there were references by that rule, each a dangling link
 * nobody wrote. Story Studio's kit reads no frontmatter references at all, so
 * the rule is this one's own: a value is a reference when it could name a
 * file. Not when it has a line break or a name longer than any disk holds;
 * and when it has a space (`places/Maren's Bakery.md` does), only when it ends
 * in an extension and has no break that prose has (`, ` or ` — `).
 */
export function looksLikeRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v === "" || EXTERNAL.test(v) || PROTOCOL_RELATIVE.test(v)) return false;
  if (!(v.includes("/") || v.toLowerCase().endsWith(".md"))) return false;
  if (/[\r\n]/.test(v)) return false;
  if (v.split("/").some((name) => Buffer.byteLength(name) > NAME_MAX)) return false;
  if (/\s/.test(v)) return ENDS_IN_EXTENSION.test(v) && !SENTENCE_BREAK.test(v);
  return true;
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

/** A name that already names a document (tree.ts's DOC_EXTENSIONS), so `.md` is not appended. */
const DOC_EXT = new RegExp(
  `(?:${DOC_EXTENSIONS.map((e) => e.replace(".", "\\.")).join("|")})$`,
  "i",
);

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
    // ⛔ A DOT IS NOT AN EXTENSION UNTIL A FILE SAYS SO. `extname` reads `.2`
    // in `./v1.2` and `.v2` in `./notes.v2`, and skipping the `.md` candidate
    // on that sent `./v1.2` to the `v1.2/` folder beside `v1.2.md` (round one
    // of this cycle) and left `./notes.v2` missing beside `notes.v2.md`. So a
    // name is tried as written AND with `.md`, unless it already names a
    // document; only a name with no dot at all skips the as-written form.
    const lookups = candidates.map((c) =>
      extname(c) === "" ? [`${c}.md`] : DOC_EXT.test(c) ? [c] : [c, `${c}.md`],
    );
    const tried = lookups.flat();
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

/**
 * A body link whose scheme nothing here opens (#128): Operator's `op:doc/<id>`,
 * left behind by an export that could not rewrite it. It names no file, so it
 * is not an edge and not `missing`; it is kept apart so it can be reported.
 */
export type UnsupportedLink = {
  from: string;
  /** The target exactly as written. */
  raw: string;
  /** The body line it is on. */
  line: number;
  /** Lower-cased, without its colon: `op`. */
  scheme: string;
  rel: string[];
};

export type Graph = {
  root: string;
  nodes: GraphNode[];
  edges: Edge[];
  /** Targets nothing in the bundle answers — said, never an error (OKF §11). */
  dangling: number;
  /**
   * Body links with a scheme the surface strikes through (anything but http,
   * https and mailto). They were dropped unseen before #128, while the reader
   * could see they were dead.
   */
  unsupported: UnsupportedLink[];
  /**
   * Present only when the map read PART of its set: `read` documents of `of`
   * (`null` when the set's own listing stopped short, so the whole is not
   * known). Everything built on the map (dangling, backlinks, the doctor)
   * covers only those, and says so; `hint` says what to do about it.
   */
  truncated?: { read: number; of: number | null };
  hint?: string;
};

/**
 * The index with its two disk questions made total: a lookup the disk refuses
 * (ENAMETOOLONG, ELOOP, EACCES) answers "no such file", and the target is
 * missing. ⛔ ONE VALUE MUST NOT TAKE THE MAP DOWN: one throw here used to
 * abort the whole graph, and `dangling` with it.
 */
function diskSafe(index: BundleIndex): BundleIndex {
  const total =
    (ask: (p: string) => boolean) =>
    (p: string): boolean => {
      try {
        return ask(p);
      } catch {
        return false;
      }
    };
  const { isDir } = index;
  return { ...index, exists: total(index.exists), ...(isDir ? { isDir: total(isDir) } : {}) };
}

export type GraphOptions = {
  /** The most documents read. */
  cap?: number;
  /**
   * A document's body links, read with `{ schemes: true }`. Given, it replaces
   * `bodyOf` + `extractLinks`, which is how the daemon reads through its
   * `LinkCache`.
   */
  linksOf?: (path: string) => LinkRef[];
};

/**
 * Each file's body links, kept until the file changes (round three of this
 * cycle; issue #127 asks for the fuller one).
 *
 * ⚠ WHY: extraction parses each document with micromark, and on a 550-file
 * set that was most of every `graph`, `dangling`, `backlinks` and `doctor`
 * (1.3 s of a 1.7 s verb), paid again by each one though nothing had changed.
 * The stamp is the caller's (the daemon's is mtime and size), so this stays
 * free of the disk; a path with no stamp (gone, unreadable) is read every time
 * and never kept. Nothing is ever evicted but a changed or vanished file: the
 * cache holds at most the documents the context lists, a few link records each.
 */
export class LinkCache {
  private readonly kept = new Map<string, { stamp: string; links: LinkRef[] }>();

  constructor(
    private readonly stampOf: (path: string) => string | null,
    private readonly bodyOf: (path: string) => string,
  ) {}

  linksOf(path: string): LinkRef[] {
    const stamp = this.stampOf(path);
    const hit = this.kept.get(path);
    if (stamp !== null && hit?.stamp === stamp) return hit.links;
    const links = extractLinks(this.bodyOf(path), { schemes: true });
    if (stamp === null) this.kept.delete(path);
    else this.kept.set(path, { stamp, links });
    return links;
  }
}

/** Build a set's map: nodes are its documents, edges are the four sources. */
export function buildGraph(
  given: BundleIndex,
  bodyOf: (path: string) => string,
  opts: GraphOptions = {},
): Graph {
  const index = diskSafe(given);
  // ⛔ NO CAP BY DEFAULT (round three of this cycle). A fixed `cap = 400`, with
  // no comment saying what it protected, stopped the map at 400 documents and
  // said nothing: on this repo's 550-file docs/, graph, dangling, backlinks and
  // the doctor all answered for 400 as if for the set. It bought speed, and
  // the link cache buys that now. A set's size is bounded where it is listed
  // (the mirror's MIRROR_NODE_CAP, which marks the entry `truncated`). A
  // caller that still passes a cap is told what it cut.
  const paths = opts.cap === undefined ? index.paths : index.paths.slice(0, opts.cap);
  const linksOf = opts.linksOf ?? ((p: string) => extractLinks(bodyOf(p), { schemes: true }));
  const edges: Edge[] = [];
  const unsupported: UnsupportedLink[] = [];
  for (const from of paths) {
    const meta = index.metaOf(from);
    for (const link of linksOf(from)) {
      if (link.scheme !== undefined) {
        if (!OPENS_OUTWARD.has(link.scheme))
          unsupported.push({
            from,
            raw: link.raw,
            line: link.line,
            scheme: link.scheme,
            rel: link.rel,
          });
        continue;
      }
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
    unsupported,
    ...(paths.length < index.paths.length
      ? {
          truncated: { read: paths.length, of: index.paths.length },
          hint: `This map read ${paths.length} of the set's ${index.paths.length} documents, so its links, dangling links and backlinks cover only those.`,
        }
      : {}),
  };
}
