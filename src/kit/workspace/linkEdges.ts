/**
 * The app's part of the link layer (kit-link-edges-slot): edges an app adds
 * beside a document's body links, each with a kind, and a resolver for the
 * app's own ways of naming a document.
 *
 * Scriptorium is the first user: its frontmatter references (`related:`,
 * `supersedes:`, …) are edges of kind `frontmatter`, and its wiki forms (a
 * `type/slug` key, a bare name, a path from the repo root) are its resolver.
 * Story Studio asked for the slot to be generic (kit-parity message 42): an
 * Atlas concept graph is edges of its own kind, read from wherever the app
 * keeps them.
 *
 * ── WHAT THE KIT DOES WITH THEM ──────────────────────────────────────────────
 *
 * - **Read with the links, cached with the links.** `edges` is called with a
 *   document's text when the kit reads its links (`readOf`), and its answer is
 *   kept under the same stamp. A save writes a new active version and an edit
 *   on disk changes the file, so either one re-reads both: edges follow the
 *   frontmatter without the app doing anything.
 * - **Resolved as a link written in the document is.** An edge's `target` goes
 *   through the kit's resolver from the document (no chat fallback), and then
 *   through the app's `resolve` when the kit's own lookup finds no file.
 * - **Kept apart by kind.** `graph`, `backlinks` and `link-check` carry an
 *   edge's `kind`, and each takes an `edge` filter naming the kinds to keep,
 *   where `link` (`BODY_LINKS`) names the body links themselves. Body links
 *   are read, resolved and reported exactly as without the slot.
 *
 * Nothing here touches the body-link extractor: the hot path (`readLinks`,
 * `place()`) is not called once more per edge, or at all for an edge.
 */
import type { LinkKind } from "./links";

/** The kind that names a document's body links in an `edge` filter. An app edge may not take it. */
export const BODY_LINKS = "link";

/** An edge kind: lowercase, digits and dashes, starting with a letter (`frontmatter`, `concept`). */
const EDGE_KIND = /^[a-z][a-z0-9-]*$/;

/**
 * One edge an app adds from a document. `target` is resolved from the document
 * as a link's target is; `key` says what in the document carries it (the
 * frontmatter key, `related` or `sources.resource`); `line` is the 1-based
 * line of the file, when the app knows it.
 */
export type AppEdge = {
  kind: string;
  /** The target exactly as written: what a report shows, and what is resolved. */
  target: string;
  key?: string;
  line?: number;
  /** Relations it asserts, lower-case; empty or absent asserts none. */
  rel?: readonly string[];
  label?: string;
};

/** A document as the app's `edges` reads it: the text read for its links, and its parsed frontmatter. */
export type EdgeDocument = {
  /** Absolute, in the context's own form. */
  path: string;
  /** Its ACTIVE version's text when the session holds it, else the file's. */
  text: string;
  /** Its frontmatter as a mapping, or null when it has none or it does not parse. */
  frontmatter: Record<string, unknown> | null;
};

/** A document the app's resolver may land on: every markdown document in the session's context. */
export type ResolvableDocument = {
  path: string;
  /** Its frontmatter `type`, when it is a single value. */
  type: string | null;
  frontmatter: Record<string, unknown> | null;
};

/** What the app's resolver is asked: a target the kit's own lookup found no file for. */
export type AppResolveInput = {
  /** The target's path: decoded, its query and anchor stripped. */
  target: string;
  /** The document it is written in, or null for a link in the chat. */
  from: string | null;
  /** The root of the context entry the document is in: what a leading `/` means. */
  root: string;
  /** A markdown link (or an app edge) or a wiki link. */
  kind: LinkKind;
  /**
   * Every markdown document in the context, with its frontmatter. Built once per
   * answer and handed out as the SAME array for every target in it, so a
   * resolver may index it once (a `WeakMap` keyed by the array) rather than
   * walk it per target.
   */
  documents: () => readonly ResolvableDocument[];
};

/**
 * The app's slot, on `WorkspaceDaemonOptions.links`.
 *
 * ⚠ A RESOLVER SHOULD LAND ON A DOCUMENT WHOSE STEM THE TARGET ENDS IN.
 * Backlinks and the graph pass over a link whose last segment names no
 * document before resolving anything (the name sift that keeps a
 * 2,500-document world cheap). The sift is on the stem, a document's extension
 * dropped on both sides, so `concept/thing` reaches `thing.md`,
 * `thing.markdown` and `thing.txt` alike. What it still misses: a form that
 * names a document by something other than its stem (an alias, an id) is
 * followed and checked by `link-check`, but not counted as a backlink or drawn
 * as an edge. Scriptorium's forms all end in the stem.
 */
export type LinkSlot = {
  /**
   * The edges a document carries beyond its body links. Called once per change
   * of the document; a throw, or an edge that is not well formed (a kind that
   * is not a name, or is `link`; an empty target), is that edge left out, never
   * the answer refused.
   */
  edges?: (doc: EdgeDocument) => readonly AppEdge[];
  /**
   * More places a target may name, absolute, in the order to try them, asked
   * only when the kit's own lookup found no file. Each is tried as a target's
   * path is (no extension: the markdown file), in the context first, then on
   * disk; the first found answers, and a folder among them answers last.
   * Return nothing for a target the app has no form for.
   *
   * Capped: only the first `APP_RESOLVE_CAP` (16) usable places are tried
   * (absolute, and not already tried by the kit); the rest are dropped, so a
   * resolver that answers with every document costs a bounded look per
   * target. Put the likeliest first. A relative place is dropped too.
   */
  resolve?: (input: AppResolveInput) => readonly string[] | undefined;
};

/** The most places an app's resolver may offer for one target; the rest are not tried. */
export const APP_RESOLVE_CAP = 16;

/** Validate an app's slot where the mistake is cheap to read. */
export function checkLinkSlot(slot: LinkSlot | undefined): LinkSlot {
  if (slot === undefined) return {};
  if (slot.edges !== undefined && typeof slot.edges !== "function")
    throw new Error("links.edges must be a function");
  if (slot.resolve !== undefined && typeof slot.resolve !== "function")
    throw new Error("links.resolve must be a function");
  return slot;
}

/** The edges `slot` reads from `doc`, well formed and in order; none when it throws. */
export function readEdges(slot: LinkSlot, doc: EdgeDocument): AppEdge[] {
  if (!slot.edges) return [];
  let got: readonly AppEdge[];
  try {
    got = slot.edges(doc);
  } catch {
    // ⛔ ONE DOCUMENT MUST NOT TAKE THE GRAPH DOWN: its edges are left out.
    return [];
  }
  if (!Array.isArray(got)) return [];
  const out: AppEdge[] = [];
  for (const e of got) {
    if (!e || typeof e !== "object") continue;
    if (typeof e.kind !== "string" || !EDGE_KIND.test(e.kind) || e.kind === BODY_LINKS) continue;
    if (typeof e.target !== "string" || e.target.trim() === "") continue;
    out.push({
      kind: e.kind,
      target: e.target.trim(),
      ...(typeof e.key === "string" ? { key: e.key } : {}),
      ...(Number.isInteger(e.line) && (e.line as number) > 0 ? { line: e.line } : {}),
      rel: Array.isArray(e.rel)
        ? [
            ...new Set(
              (e.rel as readonly unknown[])
                .filter((r): r is string => typeof r === "string" && r !== "")
                .map((r) => r.toLowerCase()),
            ),
          ]
        : [],
      ...(typeof e.label === "string" ? { label: e.label } : {}),
    });
  }
  return out;
}

/**
 * Which kinds an `edge` filter keeps: every kind when there is none; else the
 * named ones, `link` naming the body links.
 */
export function edgeKeeps(filter: readonly string[] | undefined): (kind: string) => boolean {
  if (filter === undefined) return () => true;
  const set = new Set(filter);
  return (kind) => set.has(kind);
}

/**
 * Is an edge's target written as a path (scriptorium-broken-links-sign-noise)?
 * One anchored (`/`, `./`, `../`) or with an extension is: when nothing
 * answers it, it is broken. Anything else (`feature/some-slug`, a bare name)
 * is a reference in some convention the kit does not know, and one nothing
 * answers is UNRESOLVED, not broken: the link check lists it apart and keeps
 * it out of `count`. The kit learns no convention from it, and guesses none.
 */
export function pathShaped(target: string): boolean {
  const t = target.trim();
  if (t.startsWith("/") || t.startsWith("./") || t.startsWith("../")) return true;
  const path = t.split(/[?#]/, 1)[0] ?? "";
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  // An extension is a letter and up to nine more letters or digits (`md`,
  // `mp4`, `markdown`): `kit-v1.2` names a version, not a file type.
  return dot > 0 && /^[A-Za-z][A-Za-z0-9]{0,9}$/.test(name.slice(dot + 1));
}

/** An app edge as a report shows it, from document `source`. */
export type SourcedEdge = AppEdge & { source: string };

/**
 * The app edges in `sources` that land on `target`, in the order they come.
 * As `backlinksTo` reads links: resolved as written in a DOCUMENT, a document's
 * edges to itself left out, and sifted by name first (`sift`).
 */
export function edgeBacklinksTo(
  target: string,
  sources: Iterable<{ path: string; edges: readonly AppEdge[] }>,
  sift: (raw: string) => boolean,
  lands: (raw: string, from: string) => string | null,
): SourcedEdge[] {
  const out: SourcedEdge[] = [];
  for (const s of sources) {
    if (s.path === target) continue;
    for (const e of s.edges)
      if (sift(e.target) && lands(e.target, s.path) === target) out.push({ ...e, source: s.path });
  }
  return out;
}

/** Where an edge is written in its document's text: a 1-based line and offsets. */
export type EdgeSpot = { line: number; from: number; to: number };

/** The frontmatter block's end in `text` (after its closing fence), or 0 when it has none. */
function frontmatterEnd(text: string): number {
  const open = /^---\r?\n/.exec(text);
  if (!open) return 0;
  const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m;
  const rest = text.slice(open[0].length);
  const m = close.exec(rest);
  return m ? open[0].length + m.index + m[0].length : 0;
}

/** A character that continues a name or a path: the target must not sit inside a longer one. */
const NAME_CHAR = /[\p{L}\p{N}_./-]/u;

/** The first place `target` is written whole in `text`, from `at` up to `end`, or -1. */
function findWhole(text: string, target: string, at: number, end: number): number {
  for (let i = text.indexOf(target, at); i >= 0 && i < end; i = text.indexOf(target, i + 1)) {
    const before = text[i - 1] ?? "";
    const after = text[i + target.length] ?? "";
    if (!NAME_CHAR.test(before) && !NAME_CHAR.test(after)) return i;
  }
  return -1;
}

/**
 * Where the line of frontmatter key `key` starts in `text` before `end`, by its
 * first name (`sources` for `sources.resource`, `concepts` for `concepts[1]`);
 * 0 when there is no key or no such line.
 */
function keyStart(text: string, key: string | undefined, end: number): number {
  const name = key?.split(/[.[]/)[0];
  if (!name) return 0;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^[ \\t]*["']?${esc}["']?[ \\t]*:`, "m").exec(text.slice(0, end));
  return m ? m.index : 0;
}

/**
 * Where each of `edges` is written in `text`, so a report can open it at its
 * place (kit-broken-links-visible): on the app's `line` when it gives one,
 * else the first place its target is written in the frontmatter (or anywhere,
 * for a document with none) from the line of its key (`e.key`), each edge with
 * the same key and target taking the next place. Undefined for an edge whose target is not found as written (an app
 * that reads a key into a path, say); the report then opens the document.
 */
export function locateEdges(text: string, edges: readonly AppEdge[]): (EdgeSpot | undefined)[] {
  const end = frontmatterEnd(text) || text.length;
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const lineAt = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const cursor = new Map<string, number>();
  return edges.map((e) => {
    if (e.line !== undefined) {
      const ls = starts[e.line - 1];
      if (ls === undefined) return undefined;
      const le = starts[e.line] ?? text.length;
      const i = text.slice(ls, le).indexOf(e.target);
      return i < 0
        ? { line: e.line, from: ls, to: ls }
        : { line: e.line, from: ls + i, to: ls + i + e.target.length };
    }
    // From the line of its own key, when the app names one: a target also
    // written in an earlier field (`summary: Moved from notes/ghost.md`) is not
    // the edge's place.
    const slot = `${e.key ?? ""}\0${e.target}`;
    const from = findWhole(text, e.target, cursor.get(slot) ?? keyStart(text, e.key, end), end);
    if (from < 0) return undefined;
    cursor.set(slot, from + e.target.length);
    return { line: lineAt(from), from, to: from + e.target.length };
  });
}
