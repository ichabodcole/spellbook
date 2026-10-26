/**
 * Links between documents: what a written link target names, and where that
 * lands in the session. Ported from the link layer of the editor the kit came
 * from (see layers.test.ts), the resolution and following half only. Admitted
 * for Atlas (the kit-follow-links item): a world is held together by its links,
 * and the Dreamwood export writes them as relative paths, many typed with
 * `?rel=`.
 *
 * The writing half (the kit-link-insert item) adds `relativeHref`, the target a
 * new link is written with, and `parseRel` with `collectRelations`, the `?rel=`
 * values a world already uses, which the link picker offers.
 *
 * The reading half (the kit-link-relations-backlinks item) adds `extractLinks`,
 * every link a document writes with its line and the target exactly as written,
 * and `backlinksTo`, the links in a set of documents that land on one of them.
 * Both build on `splitTarget` and `resolveTarget`: `splitTarget` keeps the query
 * for whoever reads `rel`, and `resolveTarget` returns a state rather than
 * throwing, so the dangling-link check can count what does not resolve from the
 * same extraction.
 *
 * The check (the kit-link-check item) adds `danglingLinks`, the links nothing
 * answers, with links whose scheme nothing opens (`op:doc/…`) kept apart, and
 * `duplicateNames`, documents whose file names collide, each with a suggested
 * rename. `extractLinks` keeps scheme targets for it on request.
 *
 * The graph (the kit-link-graph item) adds `linkGraph`, the session's documents
 * and the typed links between them as data, filtered by focus, hops, relation
 * and kind, and cut by degree. Drawing it is the app's: the map and move plans
 * stay out (see layers.test.ts).
 *
 * ── WHAT THE ROOT AND "IN THE SESSION" MEAN IN THE KIT ───────────────────────
 *
 * The editor this came from resolves against a SET, whose entry root is the
 * bundle. The kit has context entries instead, so:
 *
 * - **The root** (what a leading `/` means) is the root of the context entry
 *   that holds the document the link is in: the folder that was added, or, for
 *   a single file added on its own, the folder the file sits in. Never the
 *   filesystem root first.
 * - **In the session** means a document some context entry lists, or one the
 *   session already holds: exactly what `openPath` admits. A link may land in a
 *   different entry from the one it was written in; both are the user's context.
 *
 * ⛔ FOLLOWING A LINK NEVER ADDS ANYTHING TO THE CONTEXT. A target outside it
 * is reported, with the folder to add, and the user decides; `context.add` stays
 * the one way in.
 */
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { docExtensions, isImageName, isSvgName } from "../lib/docFormat.ts";
import { splitFrontmatter } from "../lib/frontmatter.ts";
import {
  decodePath,
  encodeLinkSegment,
  linkScheme,
  parseRel,
  splitTarget,
} from "../lib/linkTarget.ts";
import { maskCode } from "../lib/markdownCode.ts";
import { APP_RESOLVE_CAP, type AppEdge, BODY_LINKS, edgeKeeps } from "./linkEdges";
import { isDocName } from "./tree";

// Reading a written target (its decoded path, its query, its relations) is pure
// string work, shared with the rendered view through `lib`; it is re-exported
// here so the daemon's link layer is one module to read.
export { decodePath, encodeLinkSegment, parseRel, splitTarget };

/**
 * Where a target landed.
 *
 * - `in-context`: a document the session may open, or an image it shows
 *   (kit-image-embeds); following opens it, an image in the viewer. `path` is
 *   the context's own form of it (its realpath case, not the link's).
 * - `outside`: a document on disk that no context entry lists.
 * - `not-a-doc`: a file on disk, but not a type the workspace opens.
 * - `folder`: a folder on disk; a link to one names no document.
 * - `missing`: nothing answers; `tried` is every place looked, in order.
 */
export type Resolution =
  | { state: "in-context"; path: string }
  | { state: "outside"; path: string }
  | { state: "not-a-doc"; path: string }
  | { state: "folder"; path: string }
  | { state: "missing"; tried: string[] };

export type LinkState = Resolution["state"];

/** What a target is resolved against. Injected, so the resolver stays pure. */
export type LinkIndex = {
  /** What a leading `/` means: the root of the entry holding the document. */
  root: string;
  /**
   * A document the session may open, or an image it shows, in the context's
   * own form (the same file named by realpath, case and all), or null when it
   * is neither.
   */
  inContext: (path: string) => string | null;
  /** Does this path exist on disk as a file? */
  exists: (path: string) => boolean;
  /** Does this path exist on disk as a folder? */
  isDir: (path: string) => boolean;
  /**
   * The app's own forms (kit-link-edges-slot): more places `target` (its path,
   * decoded) may name, absolute, asked only when the kit's own lookup found no
   * file. Each is tried as a candidate is, files first, and any folder among
   * them answers after the kit's. See `LinkSlot.resolve`.
   */
  app?: (target: string, kind: LinkKind) => readonly string[] | undefined;
};

/** Where the link was written, which decides how far an anchored path may look. */
export type LinkOrigin = "document" | "chat";

/**
 * Resolve one written target, from the document at `from` (an absolute path),
 * or, when no document is open (a link in the chat), from the root itself.
 *
 * Three forms, in order of how they are anchored:
 *
 * - `/x/y.md`: the ROOT, then the filesystem. The second is the kit's own
 *   addition: an agent writing in the chat names files by absolute path, and a
 *   filesystem path joined under the root is next to impossible to exist.
 * - `./y.md`, `../x/y.md`: in a document, the document's folder and only that.
 *   In the chat, the open document's folder and then the root.
 * - `x/y.md`, `y.md` (unanchored): the document's folder first, then the root.
 *
 * ⚠ A CHAT LINK WAS NOT WRITTEN BESIDE THE OPEN DOCUMENT. The agent writes
 * `./locations/the-glade.md` meaning the context, and the human may have any
 * document open when they click it; read against that document's folder alone,
 * the same message opened from one document and was missing from another
 * (`locations/locations/the-glade.md`). So the chat falls back to the root.
 *
 * A target with no extension is read as a markdown file. The source's other
 * forms, a `type/slug` key and a wiki link's bare name, are left for the item
 * that reads frontmatter and wiki links; here they resolve as paths.
 */
export function resolveTarget(
  rawTarget: string,
  from: string | null,
  index: LinkIndex,
  origin: LinkOrigin = "document",
  kind: LinkKind = "markdown",
): Resolution {
  // ⛔ SPLIT FIRST. The click path hands over the href exactly as written, so an
  // Operator typed link (`Maren's%20Bakery.md?rel=located-in`) arrives with its
  // query and its encoding. Unsplit, `extname` read `.md?rel=located-in` and the
  // lookup went hunting for a file named after the whole string; it was found
  // by clicking one.
  const target = splitTarget(rawTarget).path;
  // A scheme (`op:doc/…`, `https:`) names no file here. The renderer refuses or
  // sends these outward before a click gets this far; this holds the line anyway.
  // Read by `schemeOf`, so a file name with a colon in it (`Chapter2:intro.md`)
  // still resolves, and never for a wiki link, whose target is always a name.
  if (target === "" || (kind === "markdown" && schemeOf(target) !== undefined))
    return { state: "missing", tried: [] };
  const here = from === null ? index.root : dirname(from);
  const fromRoot = normalize(join(index.root, target));
  const anchored = target.startsWith("./") || target.startsWith("../");
  // ⛔ A TRAILING SLASH NAMES A FOLDER, and only a folder (found by the source
  // editor's verifier). With `.md` appended, `./rules/` opened `rules.md`
  // beside a `rules/` folder.
  const folderish = target.length > 1 && target.endsWith("/");
  const bare = [
    ...new Set(
      (target.startsWith("/")
        ? [fromRoot, normalize(target)]
        : anchored && origin === "document"
          ? [resolve(here, target)]
          : [resolve(here, target), fromRoot]
      ).map((c) => (c.length > 1 && c.endsWith("/") ? c.slice(0, -1) : c)),
    ),
  ];
  const tried = [...new Set(bare.flatMap(fileLookups))];
  if (!folderish) {
    for (const c of tried) {
      const own = index.inContext(c);
      if (own !== null) return { state: "in-context", path: own };
    }
    for (const c of tried)
      if (index.exists(c))
        return isDocName(c) ? { state: "outside", path: c } : { state: "not-a-doc", path: c };
    // The app's forms, after the kit's (kit-link-edges-slot): asked only on a
    // miss, so a link the kit answers never reaches the app.
    const more = index.app ? appCandidates(index.app(target, kind), bare) : [];
    if (more.length > 0) {
      const seen = new Set(tried);
      const files = [...new Set(more.flatMap(fileLookups))].filter((c) => !seen.has(c));
      for (const c of files) {
        const own = index.inContext(c);
        if (own !== null) return { state: "in-context", path: own };
      }
      for (const c of files)
        if (index.exists(c))
          return isDocName(c) ? { state: "outside", path: c } : { state: "not-a-doc", path: c };
      tried.push(...files);
      bare.push(...more);
    }
  }
  for (const c of bare) if (index.isDir(c)) return { state: "folder", path: c };
  return { state: "missing", tried: folderish ? bare : tried };
}

/**
 * What the app's resolver offers, absolute and normalized, less what the kit
 * already tried: the first `APP_RESOLVE_CAP` of them, so a resolver that
 * answers with every document costs one target a bounded look, not a
 * quadratic one.
 */
function appCandidates(given: readonly string[] | undefined, bare: readonly string[]): string[] {
  if (!Array.isArray(given)) return [];
  const skip = new Set(bare);
  const out = new Set<string>();
  for (const g of given) {
    if (out.size >= APP_RESOLVE_CAP) break;
    if (typeof g !== "string" || !isAbsolute(g)) continue;
    const n = normalize(g);
    const c = n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
    if (!skip.has(c)) out.add(c);
  }
  return [...out];
}

/**
 * The files a bare candidate path may name, in the order they are looked for:
 * with no extension, the markdown file; with a document's or an image's own
 * extension, the file as written; with any other dot, both.
 *
 * ⛔ A DOT IS NOT AN EXTENSION UNTIL A FILE SAYS SO (found by the source
 * editor's verifier). `extname` reads `.2` in `./v1.2` and `.v2` in `./notes.v2`, and looking only
 * for the name as written sent `./v1.2` to a `v1.2/` folder beside `v1.2.md`,
 * and left `./notes.v2` missing beside `notes.v2.md`.
 */
function fileLookups(c: string): string[] {
  if (extname(c) === "") return [`${c}.md`];
  return isDocName(c) || isImageName(c) || isSvgName(c) ? [c] : [c, `${c}.md`];
}

// ── writing a link ──────────────────────────────────────────────────────────

/**
 * The target a link from the document at `from` to the document at `to` (both
 * absolute) is written with: relative to `from`'s folder, `/`-separated, each
 * segment encoded. A target in the same folder or below it starts `./`, the way
 * the Dreamwood export writes them; one above starts `../`. Both are anchored, so
 * `resolveTarget` reads them against the document's folder and nowhere else,
 * which is exactly where this computed them from.
 */
export function relativeHref(from: string, to: string): string {
  const rel = relative(dirname(from), to).split(sep).map(encodeLinkSegment).join("/");
  return rel.startsWith("../") ? rel : `./${rel}`;
}

// ── rewriting a link after a rename or move ─────────────────────────────────

/**
 * A link's target, written again for a document at `from` pointing at `to`
 * (both absolute), keeping everything the old target carried after its path:
 * the `?rel=` query and the `#anchor`, exactly as written. The path is written
 * as the link picker writes it (`relativeHref`): relative to `from`'s folder,
 * each segment encoded. A target written from the root (`/places/glade.md`)
 * stays written from the root when `root` (the root of the context entry that
 * holds `from`) still holds `to`.
 */
export function retarget(raw: string, from: string, to: string, root: string | null): string {
  const hash = raw.indexOf("#");
  const head = hash === -1 ? raw : raw.slice(0, hash);
  const anchor = hash === -1 ? "" : raw.slice(hash);
  const q = head.indexOf("?");
  const query = q === -1 ? "" : head.slice(q);
  const path = (q === -1 ? head : head.slice(0, q)).trim();
  const rooted = path.startsWith("/") && root !== null && to.startsWith(root + sep);
  const href = rooted
    ? `/${relative(root, to).split(sep).map(encodeLinkSegment).join("/")}`
    : relativeHref(from, to);
  return `${href}${query}${anchor}`;
}

/**
 * `text` with the target of every markdown link and embed whose target, as
 * written, `swap` maps to a new one replaced in place: label, `!`, title and
 * everything around the target kept byte for byte. Wiki links are left alone
 * (their target is a name, not a path). Returns how many links changed.
 */
export function swapLinkTargets(
  text: string,
  swap: (raw: string) => string | undefined,
): { text: string; count: number } {
  const edits: { at: number; len: number; to: string }[] = [];
  for (const l of readLinks(text, {})) {
    if (l.kind !== "markdown" || l.targetAt === undefined) continue;
    const to = swap(l.raw);
    if (to === undefined || to === l.raw) continue;
    // ⛔ THE TARGET'S OWN SPAN, as extraction matched it. Searching the text
    // for `](` and the target found a title holding that pattern
    // (`[a](./x.md "see ](./x.md")`), and a label may hold an image's `](`.
    const at = l.targetAt;
    if (!text.startsWith(l.raw, at)) continue;
    edits.push({ at, len: l.raw.length, to });
  }
  let out = text;
  for (const e of edits.sort((a, b) => b.at - a.at))
    out = out.slice(0, e.at) + e.to + out.slice(e.at + e.len);
  return { text: out, count: edits.length };
}

/** Where a copied document's links are resolved from, and what was copied with it. */
export type CopyPlace = {
  /** The root of the context entry that holds the original: what a leading `/` means. */
  root: string | null;
  /** Whether an absolute path is a file on disk. */
  exists: (path: string) => boolean;
  /** Whether an absolute path is a folder on disk. */
  isDir: (path: string) => boolean;
  /**
   * Originals copied in the same act, each to its copy (the document itself
   * among them, or not: it is always mapped to `dest`). A link to one of them
   * is written to its copy, so a set copied together still links within itself.
   */
  copies?: ReadonlyMap<string, string>;
};

/** A reference definition, `[ref]: target`, at the start of a line (up to three spaces in). */
const REF_DEFINITION = /^ {0,3}\[[^\]\n]+\]:[ \t]*(?:<([^>\n]*)>|(\S+))/gm;

/**
 * `text`, a document at `src`, with its links written to resolve from `dest`
 * (both absolute): for a COPY of the document made elsewhere (Sound Stage's
 * stage). Every markdown link, embed and reference definition is resolved
 * from `src` exactly as `resolveTarget` resolves one (a leading `/` from the
 * entry's root; a bare name from the document's folder, then from the root;
 * no extension read as markdown), to a file, or else to a folder; what it
 * found is written relative to the copy, its query and anchor kept
 * (`retarget`). A link to `src` itself, or to another original in `copies`,
 * is written to the copy: editing a copy must never be a way back into the
 * original. A target that found nothing, a scheme and a wiki link are left as
 * written. Pure: the disk is asked only through `at`.
 */
export function rebaseCopy(
  text: string,
  src: string,
  dest: string,
  at: CopyPlace,
): { text: string; count: number } {
  const here = dirname(src);
  const swap = (raw: string): string | undefined => {
    if (linkScheme(raw) !== undefined) return undefined;
    const { path } = splitTarget(raw);
    if (path === "") return undefined;
    const fromRoot = at.root === null ? null : normalize(join(at.root, path));
    const anchored = path.startsWith("./") || path.startsWith("../");
    const folderish = path.length > 1 && path.endsWith("/");
    const bare = [
      ...new Set(
        path.startsWith("/")
          ? [...(fromRoot ? [fromRoot] : []), normalize(path)]
          : anchored
            ? [resolve(here, path)]
            : [resolve(here, path), ...(fromRoot ? [fromRoot] : [])],
      ),
    ].map((c) => (c.length > 1 && c.endsWith("/") ? c.slice(0, -1) : c));
    // As `resolveTarget` tries them: no extension is markdown, a dot may not be
    // an extension, and a trailing slash names only a folder.
    const tried = folderish ? [] : bare.flatMap(fileLookups);
    const hit = tried.find((c) => at.exists(c)) ?? bare.find((c) => at.isDir(c)) ?? null;
    if (hit === null) return undefined;
    const to = hit === src ? dest : (at.copies?.get(hit) ?? hit);
    return retarget(raw, dest, to, null);
  };
  const links = swapLinkTargets(text, swap);
  // Reference definitions, which `extractLinks` does not read: found in the
  // text with code, comments and the frontmatter blanked, so offsets hold.
  const edits: { at: number; len: number; to: string }[] = [];
  for (const m of linkable(links.text).matchAll(REF_DEFINITION)) {
    const raw = m[1] ?? m[2] ?? "";
    const start = (m.index ?? 0) + m[0].length - raw.length - (m[1] !== undefined ? 1 : 0);
    const to = swap(links.text.slice(start, start + raw.length));
    if (to !== undefined && to !== raw) edits.push({ at: start, len: raw.length, to });
  }
  let out = links.text;
  for (const e of edits.sort((a, b) => b.at - a.at))
    out = out.slice(0, e.at) + e.to + out.slice(e.at + e.len);
  return { text: out, count: links.count + edits.length };
}

/** A relation in use, and how many links use it. */
export type RelationUse = { rel: string; count: number };

/** An edge kind in use (`link`, or an app's), and how many links are of it. */
export type EdgeKindUse = { kind: string; count: number };

/** A markdown link's target: `](target)` or `](<target>)`, with an optional title after it. */
const LINK_TARGET = /\]\(\s*(?:<([^>\n]*)>|([^\s()]*))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/dg;

/**
 * The relation vocabulary a set of documents already uses: every `?rel=` value
 * on a markdown link in `texts`, most used first, then alphabetical. A world's
 * vocabulary comes from the world, so nothing here is a fixed list, and a value
 * only mentioned in prose or in code is not a use.
 */
export function collectRelations(texts: Iterable<string>): RelationUse[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    // Code (fenced, indented or inline) and comments hold examples, not uses:
    // found where `extractLinks` finds links, and read out of the original.
    if (!text.includes("](")) continue;
    for (const m of linkable(text).matchAll(LINK_TARGET)) {
      const [from, to] = m.indices?.[1] ?? m.indices?.[2] ?? [0, 0];
      const target = text.slice(from, to);
      for (const rel of parseRel(splitTarget(target).query))
        counts.set(rel, (counts.get(rel) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([rel, count]) => ({ rel, count }))
    .sort((a, b) => b.count - a.count || a.rel.localeCompare(b.rel));
}

// ── reading a document's links ──────────────────────────────────────────────

/** A markdown link, or a wiki link (`[[name]]`, `[[name|label]]`). */
export type LinkKind = "markdown" | "wiki";

/** One link as a document writes it, before anything is resolved. */
export type LinkRef = {
  kind: LinkKind;
  /** The path it names: decoded, with its query and anchor stripped. */
  target: string;
  /**
   * The target EXACTLY as written: query, anchor, percent-encoding and all.
   *
   * ⛔ THIS IS WHAT MAKES A LINK FINDABLE AGAIN. `target` is the resolved shape,
   * so a report built from it sends you looking for `deep.md` when the document
   * says `./missing/deep.md?rel=x`, a string that is not in the file. Whoever
   * repairs or reviews the link needs the string that is there.
   */
  raw: string;
  /** The 1-based line of the FILE it is on, frontmatter counted, for the same reason. */
  line: number;
  /** Where the whole link (`[label](target)`) sits in the text, as offsets. */
  from: number;
  to: number;
  /** Relations from `?rel=`; EMPTY means no assertion, never an implied one. */
  rel: string[];
  /** The label, or for an embed (`![alt](x.png)`) its alt text. */
  label?: string;
  /**
   * An embed, `![alt](target)`, which draws the image where it is written. It
   * counts as a link like any other (the image's backlinks show where it is
   * used, and one to a missing file is dangling); this says which it was.
   */
  embed?: true;
  /** The line it is on, trimmed, and cut to a window around the link when long. */
  context: string;
  /**
   * The target's scheme, lower-cased and without its colon (`op`, `https`), on a
   * link read with `{ schemes: true }` only. Absent on every link that names a
   * path, which is every link `extractLinks` returns by default.
   */
  scheme?: string;
  /**
   * A link to a place in the same document (`#heading`), on a link read with
   * `{ fragments: true }` only; its `target` is empty and it resolves nothing.
   */
  fragment?: true;
};

/** What `extractLinks` keeps beyond document links. */
export type ExtractOptions = {
  /**
   * Keep targets with a scheme (`op:doc/…`, `https:`), each marked with its
   * `scheme`. The link check needs them: a link Operator could not rewrite is
   * still a link the world writes. Backlinks never want them.
   */
  schemes?: boolean;
  /**
   * Keep the links that name a place in this same document (`#x`, `[[#x]]`)
   * too, each marked `fragment` with an empty `target`. The link check reads
   * them against the document's own headings (kit-heading-links-build); the
   * caller takes them out before anything that resolves paths sees the rest.
   */
  fragments?: boolean;
};

/** One label character: anything but a bracket, and a line break only when the next line is not blank. */
const LABEL_CHAR = String.raw`(?:[^\[\]\n]|\n(?![ \t]*\r?\n))`;
/** An ATX heading line: a heading ends at its line break, and so does any label in it. */
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
/**
 * `[label](target)` or `[label](<target>)`, with an optional title; `!` marks an
 * image. A label may hold one level of brackets (`[a [b] c](x.md)`) and run onto
 * the next line; a target may hold one level of balanced parentheses. Matched
 * with indices (`d`), so every part can be read back out of the ORIGINAL text.
 */
const MD_LINK = new RegExp(
  String.raw`(!?)\[((?:${LABEL_CHAR}|\[${LABEL_CHAR}*\])*)\]\(\s*(?:<([^>\n]*)>|((?:[^\s()]|\([^\s()]*\))*))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)`,
  "gd",
);
/**
 * An image inside a link's label (whose brackets nest one level only), target
 * and title included: `[![badge](./b.png)](./real.md)`.
 */
const IMAGE_IN_LABEL =
  /!\[[^[\]]*\]\(\s*(?:<[^>\n]*>|(?:[^\s()]|\([^\s()]*\))*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/dg;
const WIKI_LINK = /\[\[([^[\]\n]+)\]\]/dg;
/**
 * `//cdn.example.com/x`: a URL that borrows the page's scheme, so a host and
 * not a path. A browser opens it on the web, so it is
 * neither a document link nor a scheme to report.
 */
const PROTOCOL_RELATIVE = /^\/\/[^/]/;
/** A backslash escape: markdown's, of any ASCII punctuation. */
const ESCAPE = /\\[!-/:-@[-`{-~]/g;
/** How much of a long line the context keeps. */
const CONTEXT_WIDTH = 160;
/** A link the context window would cut is taken whole when it is at most this long, else left out. */
const WHOLE_LINK = 120;

const unescapeMd = (s: string) => s.replace(ESCAPE, (e) => e.slice(1));

/**
 * A target's scheme, or undefined when it names a path: `lib`'s `linkScheme`,
 * the rule the rendered view filters links by too (`Chapter2:intro.md` is a
 * path; `op:doc/<id>` is a scheme).
 */
const schemeOf = linkScheme;

/**
 * One line of a document, read once for every link on it: its text (`line`),
 * trimmed (`text`) with how much was trimmed from its start (`lead`), and
 * `near`, the line's links that could hold either of two places on it.
 *
 * ⛔ ONCE PER LINE, NOT ONCE PER LINK. Slicing and trimming the line, and
 * walking every link on it, for each of its links made reading a document
 * O(links²) on a dense line: `[a](b)` run together to 50 000 characters took
 * about 3 s, where Scriptorium's extractor, which keeps no context, took 2 ms.
 */
type LineCtx = {
  line: string;
  lead: number;
  text: string;
  /**
   * The line's links, as `[from, to)` offsets in `line`, in the order they were
   * found, that belong to a run of overlapping links strictly holding `p` or
   * `q`. Only those can hold a window's edge at any step of `contextOf`: an
   * edge moves only to an end of a link holding it, and any link strictly
   * holding that end overlaps the first, so it is in the same run.
   */
  near: (p: number, q: number) => [number, number][];
};

/** `LineCtx` for a line and its links (offsets in the line, in found order). */
function lineCtx(line: string, spans: [number, number][]): LineCtx {
  const lead = line.length - line.trimStart().length;
  const text = line.trim();
  let runs: { lo: number; hi: number; members: number[] }[] | null = null;
  const runOf = (p: number) => {
    if (runs === null) {
      runs = [];
      const order = spans
        .map((_, i) => i)
        .sort((x, y) => (spans[x]?.[0] ?? 0) - (spans[y]?.[0] ?? 0));
      for (const i of order) {
        const [a, b] = spans[i] as [number, number];
        const last = runs[runs.length - 1];
        if (last && a < last.hi) {
          last.hi = Math.max(last.hi, b);
          last.members.push(i);
        } else runs.push({ lo: a, hi: b, members: [i] });
      }
    }
    // The last run starting before `p`, if it reaches past it.
    let lo = 0;
    let hi = runs.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((runs[mid]?.lo ?? 0) < p) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const run = found === -1 ? undefined : runs[found];
    return run && p < run.hi ? run : undefined;
  };
  return {
    line,
    lead,
    text,
    near: (p, q) => {
      const a = runOf(p);
      const b = runOf(q);
      const members = a === b ? (a?.members ?? []) : [...(a?.members ?? []), ...(b?.members ?? [])];
      return members.sort((x, y) => x - y).map((i) => spans[i] as [number, number]);
    },
  };
}

/**
 * A line, trimmed, cut to a window around `[at, at + len)` with "…" at each cut
 * end. The line's links are never cut through, so a quoted line never ends in
 * half a link (`[the Cave](./locat…`). A link the cut would split is taken
 * whole when it is short, and left out when it is long.
 */
function contextOf(ctx: LineCtx, at: number, len: number): string {
  const { lead, text } = ctx;
  if (text.length <= CONTEXT_WIDTH) return text;
  let start = Math.max(0, Math.min(at - lead - 40, text.length - CONTEXT_WIDTH));
  let end = Math.min(text.length, Math.max(start + CONTEXT_WIDTH, at - lead + len));
  for (const [a0, b0] of ctx.near(start + lead, end + lead)) {
    const a = a0 - lead;
    const b = b0 - lead;
    if (start > a && start < b) start = b - a <= WHOLE_LINK ? a : b;
    if (end > a && end < b) end = b - a <= WHOLE_LINK ? b : a;
  }
  start = Math.max(0, start);
  end = Math.min(text.length, end);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * The text with everything that cannot hold a link blanked IN PLACE, so every
 * offset in it is an offset in the original: the frontmatter, code (fenced,
 * indented, inline) and raw HTML (comments, tags, blocks) become spaces, and a backslash escape
 * becomes two placeholder characters, so `\[` opens nothing and `\]` closes
 * nothing while the escaped text keeps its place. Line breaks always stay.
 */
function linkable(text: string): string {
  const { bodyStart } = splitFrontmatter(text);
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  // Code and raw HTML are what the rendered view's own parser calls them
  // (`maskCode`), so the link check and the view agree on what is a link.
  const body = blank(text.slice(0, bodyStart)) + text.slice(bodyStart);
  return maskCode(body, { html: true }).replace(ESCAPE, "\u0001\u0001");
}

/**
 * Every link a document writes, in order: markdown links, embeds
 * (`![alt](x.png)`, marked `embed`) and wiki links, with targets with a scheme
 * (`https:`, `mailto:`, `op:`, and a protocol-relative `//host/x`) and in-page
 * anchors (`#x`) left out, unless `opts.schemes` keeps the scheme targets (each
 * marked with its `scheme`), and nothing inside code (fenced, indented or
 * inline, at any depth of list or quote) or an HTML comment, which hold
 * examples and asides, not links: where code and comments are is asked of the
 * parser the view renders with (`maskCode`). A leading frontmatter block holds
 * no body links either, and a backslash-escaped bracket is text. A link wrapped
 * around an image is a link by its outer target, and the image an embed.
 *
 * Matched over the whole text with what cannot hold a link blanked in place
 * (`linkable`), so offsets need no mapping back: `from`, `to`, the target as
 * written and the label are read straight out of the original text, and `line`
 * is the line the link starts on, frontmatter counted. A label may run onto the
 * next line, as markdown allows.
 *
 * Reference-style links (`[x][ref]` with `[ref]: ./a.md`) are not read: the
 * Dreamwood export writes none, and kit-link-check records the gap.
 */
export function extractLinks(text: string, opts: ExtractOptions = {}): LinkRef[] {
  return readLinks(text, opts).map(({ targetAt: _at, ...link }) => link);
}

/**
 * A link as `readLinks` finds it: on a markdown link, with where its target as
 * written starts in the text. `swapLinkTargets` rewrites exactly that span. Kept
 * off `LinkRef`, so no report or wire shape carries it.
 */
type ReadLink = LinkRef & { targetAt?: number };

/** `extractLinks`, with each markdown link's target offset (`ReadLink`). */
function readLinks(text: string, opts: ExtractOptions): ReadLink[] {
  // ⚠ NO `](` AND NO `[[`, NO LINK, and the parse is skipped. Exact, not a
  // guess: masking only turns characters into spaces or placeholders, so it
  // cannot make a `](` or a `[[` the text does not already hold, and every
  // markdown link needs the one and every wiki link the other.
  if (!text.includes("](") && !text.includes("[[")) return [];
  const masked = linkable(text);
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
  // and retrying finds the inner `[x](./y.md)`, which is. A label that runs past
  // the end of a heading line is not one either: the heading ended there.
  const md: RegExpExecArray[] = [];
  MD_LINK.lastIndex = 0;
  for (let m = MD_LINK.exec(masked); m; m = MD_LINK.exec(masked)) {
    const label = m[2] ?? "";
    const crossesHeading = label.includes("\n") && ATX_HEADING.test(lineText(lineOf(m.index)));
    // ⚠ AN IMAGE IN A LABEL IS NOT A LINK IN A LABEL:
    // `[![badge](./b.png)](./real.md)` renders as one link around a picture,
    // so the outer target is a link. Rejected as a nested link, only the
    // image was left.
    const images = [...label.matchAll(IMAGE_IN_LABEL)];
    const holdsLink = (images.length > 0 ? label.replace(IMAGE_IN_LABEL, "") : label).includes(
      "](",
    );
    if (holdsLink || crossesHeading) {
      MD_LINK.lastIndex = m.index + 1;
      continue;
    }
    md.push(m);
    if (images.length === 0) continue;
    // The kit counts an embed as a link (kit-image-embeds), so the picture
    // inside is kept too, where the source editor, which counts no image,
    // drops it.
    const end = MD_LINK.lastIndex;
    const labelAt = m.indices?.[2]?.[0] ?? m.index;
    for (const img of images) {
      MD_LINK.lastIndex = labelAt + img.index;
      const inner = MD_LINK.exec(masked);
      if (inner && inner.index === labelAt + img.index) md.push(inner);
    }
    MD_LINK.lastIndex = end;
  }
  const mdSpans: [number, number][] = md.map((m) => [m.index, m.index + m[0].length]);
  // A wiki link inside a markdown link is not one. Asked of the markdown links
  // sorted by start, with the furthest end reached so far, so a run of both
  // kinds costs a search per wiki link rather than a walk of every markdown one.
  const bySt = [...mdSpans].sort((x, y) => x[0] - y[0]);
  const reach: number[] = [];
  for (const [, b] of bySt) reach.push(Math.max(b, reach[reach.length - 1] ?? b));
  const overlapsMd = (from: number, to: number) => {
    let lo = 0;
    let hi = bySt.length - 1;
    let last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((bySt[mid]?.[0] ?? 0) < to) {
        last = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return last !== -1 && (reach[last] as number) > from;
  };
  const wiki = [...masked.matchAll(WIKI_LINK)].filter(
    (m) => !overlapsMd(m.index, m.index + m[0].length),
  );
  const spans: [number, number][] = [
    ...mdSpans,
    ...wiki.map((m): [number, number] => [m.index, m.index + m[0].length]),
  ];
  const slice = (m: RegExpMatchArray, g: number) => {
    const at = m.indices?.[g];
    return at ? text.slice(at[0], at[1]) : undefined;
  };
  // Each link's spans, by the lines they touch (in found order), and each
  // line's context, built once when a link on it first asks.
  const spansByLine = new Map<number, [number, number][]>();
  for (const [a, b] of spans)
    for (let i = lineOf(a), last = lineOf(Math.max(a, b - 1)); i <= last; i++) {
      const at = starts[i] as number;
      const list = spansByLine.get(i);
      if (list) list.push([a - at, b - at]);
      else spansByLine.set(i, [[a - at, b - at]]);
    }
  const lines = new Map<number, LineCtx>();
  const place = (from: number, to: number) => {
    const i = lineOf(from);
    const start = starts[i] as number;
    let ctx = lines.get(i);
    if (!ctx) {
      ctx = lineCtx(lineText(i), spansByLine.get(i) ?? []);
      lines.set(i, ctx);
    }
    const len = Math.min(to, start + ctx.line.length) - from;
    return { line: i + 1, from, to, context: contextOf(ctx, from - start, len) };
  };

  const out: ReadLink[] = [];
  for (const m of md) {
    // An embed counts as a link (kit-image-embeds): the image's backlinks say
    // where it is used, and an embed of a missing file is dangling.
    const embed = m[1] === "!";
    const raw = slice(m, 3) ?? slice(m, 4) ?? "";
    if (raw === "" || PROTOCOL_RELATIVE.test(raw)) continue;
    if (raw.startsWith("#")) {
      if (!opts.fragments || embed || raw === "#") continue;
      const label = unescapeMd(slice(m, 2) ?? "")
        .replace(/\s*\n\s*/g, " ")
        .trim();
      out.push({
        kind: "markdown",
        target: "",
        raw,
        ...place(m.index, m.index + m[0].length),
        rel: [],
        ...(label ? { label } : {}),
        fragment: true,
      });
      continue;
    }
    const scheme = schemeOf(raw);
    if (scheme !== undefined && !opts.schemes) continue;
    const { path, query } = splitTarget(unescapeMd(raw));
    if (path === "") continue;
    const label = unescapeMd(slice(m, 2) ?? "")
      .replace(/\s*\n\s*/g, " ")
      .trim();
    out.push({
      kind: "markdown",
      target: path,
      raw,
      ...place(m.index, m.index + m[0].length),
      rel: parseRel(query),
      ...(label ? { label } : {}),
      ...(embed ? { embed: true as const } : {}),
      ...(scheme !== undefined ? { scheme } : {}),
      targetAt: (m.indices?.[3] ?? m.indices?.[4] ?? [m.index])[0],
    });
  }
  for (const m of wiki) {
    const inner = slice(m, 1) ?? "";
    const pipe = inner.indexOf("|");
    const raw = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    const label = pipe === -1 ? undefined : inner.slice(pipe + 1).trim();
    // A wiki link names a page, never a scheme: `[[Note:Thing]]` is a page whose
    // name has a colon in it.
    if (raw === "") continue;
    if (raw.startsWith("#")) {
      if (!opts.fragments || raw === "#") continue;
      out.push({
        kind: "wiki",
        target: "",
        raw,
        ...place(m.index, m.index + m[0].length),
        rel: [],
        ...(label ? { label } : {}),
        fragment: true,
      });
      continue;
    }
    const { path, query } = splitTarget(raw);
    if (path === "") continue;
    out.push({
      kind: "wiki",
      target: path,
      raw,
      ...place(m.index, m.index + m[0].length),
      rel: parseRel(query),
      ...(label ? { label } : {}),
    });
  }
  return out.sort((a, b) => a.from - b.from);
}

// ── backlinks ─────────────────────────────────────────────────────────────

/** A link, written in document `source`, that lands on the document asked about. */
export type Backlink = Omit<LinkRef, "target"> & { source: string };

/**
 * A document's links, already extracted: what `backlinksTo` reads. `edges` are
 * the app's (kit-link-edges-slot), which only the graph reads from here.
 */
export type LinkSource = { path: string; links: readonly LinkRef[]; edges?: readonly AppEdge[] };

/**
 * The name a written path can land on, NFC and lower-cased, a document's
 * extension dropped: what `backlinksTo` and the graph sift by. On the STEM, so
 * `thing` and `thing.md` sift with `thing.markdown` and `thing.txt`: an app's
 * resolver may land an extensionless form on any document kind
 * (kit-link-edges-slot), and the kit's own `v1.2` lands on `v1.2.md`. A wider
 * sift only resolves a few more links; the resolver still decides.
 */
export function landingName(path: string): string {
  // NFC on both sides: macOS hands back decomposed names (`é` as `e` + accent)
  // where an editor writes composed ones, and the two must sift as one name.
  const name = basename(path.endsWith("/") ? path.slice(0, -1) : path)
    .normalize("NFC")
    .toLowerCase();
  const ext = extname(name);
  return ext !== "" && docExtensions().includes(ext) ? name.slice(0, -ext.length) : name;
}

/**
 * The links in `sources` that land on `target` (an absolute path, in the
 * context's own form), in the order the sources and their links come.
 *
 * - **Resolved as written in a DOCUMENT.** `resolve` is called with the source's
 *   path and must use the document origin: a `./x.md` is read against the
 *   source's folder only. The chat's fallback to the root is for links the agent
 *   writes in the chat; a document's link that only resolves that way is broken
 *   where it stands, and a backlink would claim a connection the document does
 *   not make.
 * - **A document's links to itself are not backlinks.** "Linked from" listing the
 *   document you are reading tells you nothing, and editing it would otherwise
 *   change its own backlinks with every keystroke.
 * - **Sifted by name first.** A link only lands on `target` if its last segment
 *   names the same file (case aside: a case-insensitive disk resolves
 *   `The-Glade.md` to `the-glade.md`), so every other link is passed over
 *   without touching the disk. The one thing the sift would miss is a link to an
 *   unlisted symlink whose own name differs from the file it points at.
 */
export function backlinksTo(
  target: string,
  sources: Iterable<LinkSource>,
  resolve: (raw: string, from: string, kind: LinkKind) => Resolution,
): Backlink[] {
  const want = landingName(target);
  const out: Backlink[] = [];
  for (const s of sources) {
    if (s.path === target) continue;
    for (const { target: path, ...link } of s.links) {
      if (landingName(path) !== want) continue;
      const r = resolve(link.raw, s.path, link.kind);
      if (r.state === "in-context" && r.path === target) out.push({ source: s.path, ...link });
    }
  }
  return out;
}

// ── the link check: dangling links and shared names ─────────────────────────

/** Schemes the surface opens outward (a new tab, the mail app): links that work. */
const OPENS_OUTWARD = new Set(["http", "https", "mailto"]);

/** A link, written in document `source`, that nothing in the session answers. */
export type DanglingLink = Omit<LinkRef, "target" | "scheme"> & {
  source: string;
  /** Every place the resolver looked, in order: what a near miss is found by. */
  tried: string[];
};

/** A link, written in document `source`, whose scheme nothing here can open. */
export type SchemeLink = Omit<LinkRef, "target" | "scheme"> & {
  source: string;
  /** The scheme, lower-cased, without its colon: `op` for Operator's `op:doc/…`. */
  scheme: string;
};

/**
 * The links in `sources` that answer nothing, in two kinds kept apart:
 *
 * - `missing`: a path that resolves to nothing on disk, with where it looked.
 * - `unsupported`: a target with a scheme no part of the workspace opens, such as
 *   Operator's `op:doc/<id>`, a link the export could not rewrite. It names no
 *   file, so "where it looked" would be empty and "missing" would mislead.
 *   `http:`, `https:` and `mailto:` open outward and are not reported.
 *
 * ⚠ NOT AN ERROR. A dangling link is a fact about a world, not a failure: a world
 * bible points at things not written yet. The check reports; it never refuses.
 *
 * `sources` must be read with `{ schemes: true }` for `unsupported` to see
 * anything. `resolve` is called as `backlinksTo` calls it, as written in a
 * DOCUMENT (no chat fallback): a `./x.md` that only works from the chat is broken
 * where it stands. A link to a folder, to a file the workspace does not open, or
 * to a document outside the context is not dangling: something answers it, and
 * following it says what.
 */
export function danglingLinks(
  sources: Iterable<LinkSource>,
  resolve: (raw: string, from: string, kind: LinkKind) => Resolution,
): { missing: DanglingLink[]; unsupported: SchemeLink[] } {
  const missing: DanglingLink[] = [];
  const unsupported: SchemeLink[] = [];
  for (const s of sources)
    for (const { target: _target, scheme, ...link } of s.links) {
      if (scheme !== undefined) {
        if (!OPENS_OUTWARD.has(scheme)) unsupported.push({ source: s.path, ...link, scheme });
        continue;
      }
      const r = resolve(link.raw, s.path, link.kind);
      if (r.state === "missing") missing.push({ source: s.path, ...link, tried: r.tried });
    }
  return { missing, unsupported };
}

/** Documents that share a file name, and the name each could take instead. */
export type DuplicateName = {
  /** The shared name, as the first of the files (by path) writes it. */
  name: string;
  files: { path: string; suggest: string }[];
};

/** What `duplicateNames` asks of the disk. Injected, so the grouping stays pure. */
export type NameIndex = {
  /** Is the disk holding `path` case-insensitive, so `A.md` and `a.md` are one name? */
  caseInsensitive: (path: string) => boolean;
  /** Does anything exist at this path? A suggestion never names an existing file. */
  exists: (path: string) => boolean;
};

/** A leading ordinal (`00-`, `3_`, `12. `), which says where a file sorts, not what it is. */
const ORDINAL = /^\d+[-_. ]+/;

/** The comparison form of a name: NFC, and lower-cased when the disk ignores case. */
const nameKey = (name: string, fold: boolean) =>
  fold ? name.normalize("NFC").toLowerCase() : name.normalize("NFC");

/**
 * Documents in `paths` whose file names collide, each with a suggested rename.
 *
 * ⛔ AMBIGUOUS, NOT WRONG. Nothing stops two files sharing a name, and nothing
 * should. But a link written `./00-overview.md` in the chat opens whichever is
 * nearer the open document, so a world with two is a world where a link can
 * quietly mean the other one. This lists them; renaming is the human's call,
 * through `rename`, and nothing here renames.
 *
 * - **Case.** On a case-insensitive disk (macOS by default), `Overview.md` and
 *   `overview.md` are one name to a link, so they collide; on a case-sensitive
 *   one they are two names. Names compare in NFC either way.
 * - **The suggestion** puts the parent folder in front of the name, with a
 *   leading ordinal dropped: `locations/00-overview.md` becomes
 *   `locations-overview.md`. When that is taken (another document's name,
 *   another suggestion, or a file already in that folder), the grandparent goes
 *   in front as well, and then a number on the end.
 */
export function duplicateNames(paths: readonly string[], index: NameIndex): DuplicateName[] {
  const byFolded = new Map<string, string[]>();
  for (const p of paths) {
    const k = nameKey(basename(p), true);
    const list = byFolded.get(k);
    if (list) list.push(p);
    else byFolded.set(k, [p]);
  }
  const groups: string[][] = [];
  for (const list of byFolded.values()) {
    if (list.length < 2) continue;
    if (index.caseInsensitive(list[0] as string)) {
      groups.push(list);
      continue;
    }
    // A case-sensitive disk: only the same name, case and all, collides.
    const exact = new Map<string, string[]>();
    for (const p of list) {
      const k = nameKey(basename(p), false);
      exact.set(k, [...(exact.get(k) ?? []), p]);
    }
    for (const g of exact.values()) if (g.length > 1) groups.push(g);
  }
  // Every name in use, folded: a suggestion that differs from one only by case
  // would collide on the disks most worlds live on.
  const taken = new Set(paths.map((p) => nameKey(basename(p), true)));
  const free = (dir: string, name: string) =>
    !taken.has(nameKey(name, true)) && !index.exists(join(dir, name));
  return groups
    .map((g) => [...g].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })))
    .sort((a, b) =>
      basename(a[0] as string).localeCompare(basename(b[0] as string), undefined, {
        numeric: true,
      }),
    )
    .map((g) => ({
      name: basename(g[0] as string),
      files: g.map((path) => {
        const suggest = suggestName(path, free);
        taken.add(nameKey(suggest, true));
        return { path, suggest };
      }),
    }));
}

/** A name for `path` that `free` accepts: its folders in front, then a number on the end. */
function suggestName(path: string, free: (dir: string, name: string) => boolean): string {
  const dir = dirname(path);
  const ext = extname(path);
  const stem = basename(path, ext);
  const core = stem.replace(ORDINAL, "") || stem;
  const folders = dir.split(sep).filter((f) => f !== "");
  const tries: string[] = [];
  for (let k = 1; k <= Math.min(2, folders.length); k++) {
    const parts = [...folders.slice(-k), core];
    // A folder already leading the name is not repeated: `locations/locations-map.md`
    // never becomes `locations-locations-map.md`.
    const lead = (parts[parts.length - 2] ?? "").toLowerCase();
    if (lead !== "" && core.toLowerCase().startsWith(`${lead}-`)) parts.splice(parts.length - 2, 1);
    tries.push(`${parts.join("-")}${ext}`);
  }
  if (tries.length === 0) tries.push(`${core}${ext}`);
  for (const t of tries) if (free(dir, t)) return t;
  const base = basename(tries[0] as string, ext);
  for (let n = 2; ; n++) {
    const t = `${base}-${n}${ext}`;
    if (free(dir, t)) return t;
  }
}

// ── the graph ───────────────────────────────────────────────────────────────

/**
 * A document the graph may hold, with its kind (a world's `type`, or null), and
 * what the world says of the kind: its `label` (the kind itself when absent) and
 * whether it is `canon` (true when absent).
 */
export type GraphDoc = {
  path: string;
  kind: string | null;
  label?: string;
  canon?: boolean;
  /** How deep the profile file that gave `label` sits: the kind's label is the shallowest. */
  labelDepth?: number;
  /** A bundle whose references are its links (a board), not a document: what a person calls one. */
  bundle?: { noun: string };
};

/** One kind among the graph's documents: its label, whether it is canon, and how many. */
export type GraphKind = {
  kind: string | null;
  /** The kind's label (`Location`), else the kind as written; null for no kind. */
  label: string | null;
  /** False when the world marks the kind not canon (every document of it); else true. */
  canon: boolean;
  count: number;
};

/**
 * The links from one document to another that carry the same relations,
 * folded into one edge. `rel` is sorted and EMPTY for an untyped link, which
 * asserts nothing; `count` is how many links it folds.
 */
export type GraphLink = {
  from: string;
  to: string;
  rel: string[];
  count: number;
  /** A bundle's references (a board's cards), which assert no relation. */
  reference?: true;
  /** An app's edges of this kind (kit-link-edges-slot), not body links: `frontmatter`. */
  edge?: string;
};

/** A document in the answer, with its links in and out of the filtered graph. */
export type GraphNode = GraphDoc & {
  linksIn: number;
  linksOut: number;
  /** How many links away from the focus, when there is one (0: the focus). */
  hop?: number;
};

/** What `linkGraph` keeps. Every part is optional: with none, the whole graph. */
export type GraphFilter = {
  /** A document to centre on: only what is within `hops` links of it, either way. */
  focus?: string;
  /** How far from the focus, in links followed either way. Default 1. */
  hops?: number;
  /** Keep links carrying any of these relations (case-folded, as `parseRel` reads them). Untyped links go unless `untyped`. */
  rel?: readonly string[];
  /** Keep untyped links. Default: true with no `rel`, false with one. */
  untyped?: boolean;
  /** Keep documents of these kinds only (the focus always stays). */
  kind?: readonly string[];
  /** Keep documents with no kind. Default: true with no `kind`, false with one. */
  kindless?: boolean;
  /** The most documents to answer with, the best connected first. */
  limit?: number;
  /**
   * Keep edges of these kinds only: an app's edge kinds, `link` for the body
   * links (kit-link-edges-slot). A bundle's references stay.
   */
  edge?: readonly string[];
};

export type LinkGraphResult = {
  nodes: GraphNode[];
  edges: GraphLink[];
  /**
   * Every relation in use among the documents in view (with a focus, its
   * neighbourhood reached over every link), counted in links before `rel`
   * filters: a legend's list, which still names what the filter hides.
   */
  relations: RelationUse[];
  /** Untyped links among them, counted the same way. */
  untyped: number;
  /** Every kind among the documents, before `kind` filters, most first; null is no kind. */
  kinds: GraphKind[];
  /**
   * Links of each edge kind among the documents kept by `kind`, before `edge`
   * filters, most first, `link` counting the body links: present only when an
   * app edge is among them (kit-link-edges-slot).
   */
  edgeKinds?: EdgeKindUse[];
  /**
   * What passed the filters, before the cut: documents, edges (folded pairs)
   * and the links they fold. With bundles among them, `bundles` and
   * `references` say how many of the nodes and links those are.
   */
  total: { nodes: number; edges: number; links: number; bundles?: number; references?: number };
};

/** The furthest a focus reaches: past three links a world's graph is most of the world. */
const GRAPH_MAX_HOPS = 3;

/**
 * The documents in `docs` and the links between them, filtered and then cut:
 *
 * 1. **Edges.** Every link in `sources` that lands, resolved as written in a
 *    DOCUMENT (as `backlinksTo` resolves), on another document in `docs`. Links
 *    whose last segment names no document in `docs` are passed over without
 *    resolving, as backlinks sift; scheme links and links to itself are not
 *    edges. Links with the same ends and the same relations fold into one edge.
 * 2. **Kind**, then **relation**: documents of other kinds go (the focus stays),
 *    and with them their edges; then edges with none of the relations go.
 * 3. **Focus**: only what is within `hops` links of the focus, either way.
 * 4. **The cut**: at most `limit` documents, the focus first, then nearest the
 *    focus, then most links, then by path; edges between the kept ones.
 *
 * ⛔ FILTER FIRST, THEN CUT, AND CUT BY DEGREE. Cutting the first N in path order
 * (as the map this came from did) drops a hub and keeps a leaf, and cutting
 * before filtering lets path order decide what a filtered view shows.
 *
 * `references` are edges already resolved, from a bundle in `docs` (a board)
 * to what it references: each is untyped and marked `reference`, folded per
 * pair, and filtered and cut as any other edge.
 */
export function linkGraph(
  docs: readonly GraphDoc[],
  sources: Iterable<LinkSource>,
  resolve: (raw: string, from: string, kind: LinkKind) => Resolution,
  filter: GraphFilter = {},
  references: readonly { from: string; to: string }[] = [],
): LinkGraphResult {
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const names = new Set(docs.map((d) => landingName(d.path)));
  const folded = new Map<string, GraphLink>();
  for (const s of sources) {
    if (!byPath.has(s.path)) continue;
    for (const link of s.links) {
      if (link.scheme !== undefined || !names.has(landingName(link.target))) continue;
      const r = resolve(link.raw, s.path, link.kind);
      if (r.state !== "in-context" || r.path === s.path || !byPath.has(r.path)) continue;
      const rel = [...new Set(link.rel)].sort();
      const key = `${s.path}\0${r.path}\0${rel.join("\0")}`;
      const had = folded.get(key);
      if (had) had.count++;
      else folded.set(key, { from: s.path, to: r.path, rel, count: 1 });
    }
    // An app's edges (kit-link-edges-slot): resolved as a markdown link written
    // in the document is, sifted the same way, folded apart from the body links.
    for (const e of s.edges ?? []) {
      if (!names.has(landingName(splitTarget(e.target).path))) continue;
      const r = resolve(e.target, s.path, "markdown");
      if (r.state !== "in-context" || r.path === s.path || !byPath.has(r.path)) continue;
      const rel = [...new Set(e.rel ?? [])].sort();
      const key = `${s.path}\0${r.path}\0${rel.join("\0")}\0\0edge:${e.kind}`;
      const had = folded.get(key);
      if (had) had.count++;
      else folded.set(key, { from: s.path, to: r.path, rel, count: 1, edge: e.kind });
    }
  }
  for (const ref of references) {
    if (ref.from === ref.to || !byPath.has(ref.from) || !byPath.has(ref.to)) continue;
    const key = `${ref.from}\0${ref.to}\0\0reference`;
    const had = folded.get(key);
    if (had) had.count++;
    else folded.set(key, { from: ref.from, to: ref.to, rel: [], count: 1, reference: true });
  }

  // A kind's label is the root-most profile's (the least `labelDepth`; a nested
  // relabel such as "Wild place" stays on its own documents, not the legend), and
  // the kind itself when no document of it has one. It is not canon only when
  // every document of it says so (a nested profile may say otherwise).
  const kindsBy = new Map<string | null, GraphKind>();
  const labelAt = new Map<string | null, number>();
  for (const d of docs) {
    const k = kindsBy.get(d.kind);
    const canon = d.canon ?? true;
    const depth = d.label === undefined ? Infinity : (d.labelDepth ?? 0);
    if (k) {
      k.count++;
      k.canon ||= canon;
      if (d.kind !== null && depth < (labelAt.get(d.kind) ?? Infinity)) {
        k.label = d.label ?? d.kind;
        labelAt.set(d.kind, depth);
      }
    } else {
      kindsBy.set(d.kind, {
        kind: d.kind,
        label: d.kind === null ? null : (d.label ?? d.kind),
        canon,
        count: 1,
      });
      labelAt.set(d.kind, depth);
    }
  }
  const kinds = [...kindsBy.values()].sort(
    (a, b) => b.count - a.count || String(a.kind).localeCompare(String(b.kind)),
  );

  const focus = filter.focus;
  const kindSet = filter.kind ? new Set(filter.kind) : null;
  const keepKindless = filter.kindless ?? kindSet === null;
  const kept = new Set(
    docs
      .filter(
        (d) =>
          d.path === focus ||
          (d.kind === null ? keepKindless : kindSet === null || kindSet.has(d.kind)),
      )
      .map((d) => d.path),
  );
  const kindKept = [...folded.values()].filter((e) => kept.has(e.from) && kept.has(e.to));
  // Edge kinds (kit-link-edges-slot): counted before `edge` filters, so a legend
  // still names what the filter hides; said only where an app edge is.
  let edgeKinds: EdgeKindUse[] | undefined;
  if (kindKept.some((e) => e.edge !== undefined)) {
    const byKind = new Map<string, number>();
    for (const e of kindKept) {
      if (e.reference) continue;
      const k = e.edge ?? BODY_LINKS;
      byKind.set(k, (byKind.get(k) ?? 0) + e.count);
    }
    edgeKinds = [...byKind]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  }
  const keepEdge = edgeKeeps(filter.edge);
  const all = kindKept.filter((e) => e.reference || keepEdge(e.edge ?? BODY_LINKS));

  /** What is within the hops of the focus over `over`, with each document's distance. */
  const reach = (over: readonly GraphLink[]): Map<string, number> => {
    const hop = new Map<string, number>();
    if (focus === undefined) return hop;
    const hops = Math.max(0, Math.min(GRAPH_MAX_HOPS, filter.hops ?? 1));
    const near = new Map<string, Set<string>>();
    const touch = (a: string, b: string) => {
      const set = near.get(a);
      if (set) set.add(b);
      else near.set(a, new Set([b]));
    };
    for (const e of over) {
      touch(e.from, e.to);
      touch(e.to, e.from);
    }
    hop.set(focus, 0);
    let ring = [focus];
    for (let h = 1; h <= hops && ring.length > 0; h++) {
      const next: string[] = [];
      for (const p of ring)
        for (const q of near.get(p) ?? [])
          if (!hop.has(q)) {
            hop.set(q, h);
            next.push(q);
          }
      ring = next;
    }
    return hop;
  };

  // The legend's counts: links among the documents in view, reached over EVERY
  // link (so a relation the filter hides is still counted, and can be shown
  // again), before the relation filter. With a focus, that is the
  // neighbourhood's own links, not the world's.
  const legendView = focus === undefined ? kept : new Set(reach(all).keys());
  const relCounts = new Map<string, number>();
  let untyped = 0;
  for (const e of all) {
    // A reference asserts nothing, and is no untyped link either: the legend leaves it out.
    if (e.reference || !legendView.has(e.from) || !legendView.has(e.to)) continue;
    if (e.rel.length === 0) untyped += e.count;
    for (const r of e.rel) relCounts.set(r, (relCounts.get(r) ?? 0) + e.count);
  }
  const relations = [...relCounts]
    .map(([rel, count]) => ({ rel, count }))
    .sort((a, b) => b.count - a.count || a.rel.localeCompare(b.rel));

  const relSet = filter.rel ? new Set(filter.rel.map((r) => r.toLowerCase())) : null;
  const keepUntyped = filter.untyped ?? relSet === null;
  // References were asked for by asking for bundles: no relation filter drops them.
  let edges = all.filter((e) =>
    e.reference
      ? true
      : e.rel.length === 0
        ? keepUntyped
        : relSet === null || e.rel.some((r) => relSet.has(r)),
  );

  const hop = reach(edges);
  let inView: Set<string> = kept;
  if (focus !== undefined) {
    inView = new Set(hop.keys());
    edges = edges.filter((e) => inView.has(e.from) && inView.has(e.to));
  }

  const linksIn = new Map<string, number>();
  const linksOut = new Map<string, number>();
  for (const e of edges) {
    linksOut.set(e.from, (linksOut.get(e.from) ?? 0) + e.count);
    linksIn.set(e.to, (linksIn.get(e.to) ?? 0) + e.count);
  }
  const degree = (p: string) => (linksIn.get(p) ?? 0) + (linksOut.get(p) ?? 0);
  const ranked = docs
    .filter((d) => inView.has(d.path))
    .sort(
      (a, b) =>
        (hop.get(a.path) ?? 0) - (hop.get(b.path) ?? 0) ||
        degree(b.path) - degree(a.path) ||
        a.path.localeCompare(b.path),
    );
  // Bundles and their references are among the nodes and links, and also
  // counted on their own, so a header can say documents apart from boards.
  const bundles = ranked.filter((d) => d.bundle).length;
  const referenceLinks = edges.reduce((n, e) => n + (e.reference ? e.count : 0), 0);
  const total = {
    nodes: ranked.length,
    edges: edges.length,
    links: edges.reduce((n, e) => n + e.count, 0),
    ...(bundles > 0 || referenceLinks > 0 ? { bundles, references: referenceLinks } : {}),
  };
  const cut = filter.limit === undefined ? ranked : ranked.slice(0, Math.max(0, filter.limit));
  const drawn = new Set(cut.map((d) => d.path));
  return {
    nodes: cut.map((d) => ({
      ...d,
      linksIn: linksIn.get(d.path) ?? 0,
      linksOut: linksOut.get(d.path) ?? 0,
      ...(hop.has(d.path) ? { hop: hop.get(d.path) as number } : {}),
    })),
    edges: edges.filter((e) => drawn.has(e.from) && drawn.has(e.to)),
    relations,
    untyped,
    kinds,
    ...(edgeKinds ? { edgeKinds } : {}),
    total,
  };
}
