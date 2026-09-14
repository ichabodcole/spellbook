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
  /** Relations from `?rel=`; EMPTY means no assertion, never `references`. */
  rel: string[];
  label?: string;
};

/** A reference found in frontmatter, with the key that carried it. */
export type FieldRef = { key: string; value: string };

const FENCE_LINE = /^(?:```|~~~)/;

/**
 * Strip fenced code blocks. A document about links quotes link syntax, and the
 * wiki this was built against does exactly that — without this, SCHEMA.md's
 * examples become edges.
 */
export function withoutFences(body: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const m = FENCE_LINE.exec(line);
    if (fence === null && m) {
      fence = m[0];
      out.push("");
      continue;
    }
    if (fence !== null) {
      if (m && line.startsWith(fence)) fence = null;
      out.push("");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
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
const MD_LINK = /(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const WIKI_LINK = /\[\[([^\]\n]+)\]\]/g;

/** Every link a document's BODY points at — external targets and images left out. */
export function extractLinks(body: string): LinkRef[] {
  const text = withoutFences(body);
  const out: LinkRef[] = [];
  for (const m of text.matchAll(MD_LINK)) {
    if (m[1] === "!") continue; // an image is not a document link
    const raw = m[3] ?? "";
    if (EXTERNAL.test(raw) || raw.startsWith("#")) continue;
    const { path, query } = splitTarget(raw);
    if (path === "") continue;
    out.push({
      kind: "markdown",
      target: path,
      rel: parseRel(query),
      ...(m[2] ? { label: m[2] } : {}),
    });
  }
  for (const m of text.matchAll(WIKI_LINK)) {
    const inner = m[1] ?? "";
    const pipe = inner.indexOf("|");
    const targetPart = pipe === -1 ? inner : inner.slice(0, pipe);
    const label = pipe === -1 ? undefined : inner.slice(pipe + 1).trim();
    const { path, query } = splitTarget(targetPart);
    if (path === "") continue;
    out.push({ kind: "wiki", target: path, rel: parseRel(query), ...(label ? { label } : {}) });
  }
  return out;
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

/** Where a target landed. `outside` exists on disk but not in this bundle. */
export type Resolution =
  | { state: "in-bundle"; path: string }
  | { state: "outside"; path: string }
  | { state: "missing"; tried: string };

export type BundleIndex = {
  /** The set's root — OKF's bundle, and what a `/`-target is relative to. */
  root: string;
  /** Absolute paths of every document in the bundle. */
  paths: readonly string[];
  /** A document's parsed frontmatter, for `type/slug` resolution. */
  metaOf: (path: string) => DocMeta | null;
  /** Does this path exist on disk? (Injected, so the resolver stays pure.) */
  exists: (path: string) => boolean;
  /**
   * The git working tree the bundle sits in, when there is one. A third place
   * an unanchored path is tried: pdocs writes repo-relative paths
   * (`docs/playbooks/foo.md`) and the wiki's rule pages carry repo-relative
   * `checker:` values, and neither resolves from the document or the bundle.
   */
  repoRoot?: string | null;
};

const stem = (p: string) => basename(p, extname(p));

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
  const looksPath =
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
    const candidates = target.startsWith("/")
      ? [normalize(join(index.root, target))]
      : anchored
        ? [normalize(resolvePath(dirname(from), target))]
        : [
            normalize(resolvePath(dirname(from), target)),
            normalize(join(index.root, target)),
            ...(index.repoRoot ? [normalize(join(index.repoRoot, target))] : []),
          ];
    const tried = candidates.map((c) => (extname(c) === "" ? `${c}.md` : c));
    for (const c of tried) if (index.paths.includes(c)) return { state: "in-bundle", path: c };
    for (const c of tried) if (index.exists(c)) return { state: "outside", path: c };
    return { state: "missing", tried: tried[0] as string };
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
