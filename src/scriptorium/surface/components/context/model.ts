// The context sidebar's PURE helpers — no React, no daemon — so the rules the
// sidebar renders by are unit-tested rather than eyeballed (bounty's
// `state/drag.ts` precedent). The sidebar component imports these; nothing here
// imports the component.
import type { ContextEntry, ContextNode, DocSummary } from "../../../backend/protocol";

/** A POSIX path's last segment. */
export function baseName(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? rel : rel.slice(i + 1);
}

/** Join an entry's absolute root and a node's POSIX-relative path. */
export function joinPath(root: string, rel: string): string {
  return root.endsWith("/") ? `${root}${rel}` : `${root}/${rel}`;
}

/** Abbreviate a home-relative path for display: `/Users/x/notes` → `~/notes`. */
export function tildify(path: string, home: string | null): string {
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * A path short enough for a sidebar row: home-abbreviated, then cut from the
 * FRONT so the part that tells two paths apart — the end — survives
 * (`…/drafts/notes`). The full path belongs in the row's tooltip.
 */
export function shortPath(path: string, home: string | null, keep = 2): string {
  const t = tildify(path, home);
  const parts = t.split("/");
  const lead = t.startsWith("~") ? 1 : t.startsWith("/") ? 1 : 0; // "~" or "" before the first slash
  if (parts.length - lead <= keep + 1) return t;
  return `…/${parts.slice(-keep).join("/")}`;
}

/**
 * Display order (E17: sort-based, no manual order anywhere). Groups first, then
 * documents — the convention of Zed and most file trees — each by name,
 * case-insensitively with natural numbers ("ch2" before "ch10"). Never mutates.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export function sortNodes(nodes: readonly ContextNode[]): ContextNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "group" ? -1 : 1;
    return collator.compare(baseName(a.rel), baseName(b.rel));
  });
}

/** Every document node under `nodes`, depth-first. */
export function docsIn(nodes: readonly ContextNode[]): ContextNode[] {
  const out: ContextNode[] = [];
  for (const n of nodes) {
    if (n.kind === "doc") out.push(n);
    else out.push(...docsIn(n.children));
  }
  return out;
}

/**
 * E15: ONE entry type, rendered two ways. A `listed` entry holding exactly one
 * document renders as that document; anything else renders as a tree you drill
 * into — ANY `mirrored` folder, even one holding a single file, because the
 * human added a FOLDER and a folder should stay one (verify pass: a one-file
 * folder shown as its file lost the folder's name, and "Remove" on that row
 * silently removed the whole folder). Turning a document into a set (E22) makes
 * the entry a mirrored folder, so this answer follows with no special case.
 */
export function singleDoc(entry: ContextEntry): ContextNode | null {
  if (entry.membership !== "listed") return null;
  const [only, ...rest] = entry.nodes;
  return only && rest.length === 0 && only.kind === "doc" ? only : null;
}

/** A flat, id-keyed index of an entry's tree, for the tree library's data loader. */
export type TreeIndex = {
  /** node id → node; ids are the node's `rel` (unique within an entry). */
  byId: Map<string, ContextNode>;
  /** parent id (ROOT_ID for the top level) → sorted child ids. */
  children: Map<string, string[]>;
};

/**
 * The synthetic root every entry's tree hangs from. "/" because a node's `rel`
 * is POSIX-relative and so can never be "/" — no file or folder can collide.
 */
export const ROOT_ID = "/";

export function indexTree(nodes: readonly ContextNode[]): TreeIndex {
  const byId = new Map<string, ContextNode>();
  const children = new Map<string, string[]>();
  const walk = (parent: string, list: readonly ContextNode[]) => {
    const sorted = sortNodes(list);
    children.set(
      parent,
      sorted.map((n) => n.rel),
    );
    for (const n of sorted) {
      byId.set(n.rel, n);
      if (n.kind === "group") walk(n.rel, n.children);
    }
  };
  walk(ROOT_ID, nodes);
  return { byId, children };
}

/** The group ids that contain `rel` — what to expand so an open document shows. */
export function ancestorsOf(rel: string): string[] {
  const parts = rel.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/**
 * What scriptorium opens as a document — the daemon's `DOC_EXTENSIONS`
 * (`backend/tree.ts`, which imports `node:fs` and so cannot be bundled here).
 * A test holds the two lists equal.
 */
export const DOC_EXTENSIONS = [".md", ".markdown", ".mdx", ".txt"] as const;

export function isDocName(name: string): boolean {
  const lower = name.toLowerCase();
  return DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** The parent of a POSIX-relative path: "" for the top level. */
export function parentRel(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

/** An absolute path's parent directory. */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/**
 * A place a document or folder can be moved to, for the "Move to" menu: the
 * workspace and every set's own folder, less where the item already is and —
 * for a folder — itself and anything under it.
 */
export type MoveTarget = { label: string; path: string };

export function moveTargets(
  entries: readonly ContextEntry[],
  workspace: string,
  item: string,
  home: string | null,
): MoveTarget[] {
  const here = dirOf(item);
  const out: MoveTarget[] = [];
  const push = (label: string, path: string) => {
    if (path === here || path === item || path.startsWith(`${item}/`)) return;
    if (!out.some((t) => t.path === path)) out.push({ label, path });
  };
  push(`Workspace · ${shortPath(workspace, home)}`, workspace);
  for (const e of entries) if (e.membership === "mirrored") push(e.label, e.root);
  return out;
}

/** The files a drop carries, split into documents to import and names to refuse. */
export function splitDropped(files: readonly { name: string }[]): {
  docs: number[];
  skipped: string[];
} {
  const docs: number[] = [];
  const skipped: string[] = [];
  files.forEach((f, i) => {
    if (isDocName(f.name)) docs.push(i);
    else skipped.push(f.name);
  });
  return { docs, skipped };
}

/**
 * A document's status mark for the sidebar (E32) — the smallest thing that can
 * carry meaning at row scale. `draft` and `deprecated` are worth a mark;
 * `stable` is the default and marking it would mark almost everything.
 */
export type StatusMark = { tone: "draft" | "deprecated" | "stale" | "unreadable"; title: string };

export function statusMark(summary: DocSummary | undefined): StatusMark | null {
  if (!summary) return null;
  if (summary.error)
    return { tone: "unreadable", title: `Frontmatter unreadable: ${summary.error}` };
  if (summary.stale) return { tone: "stale", title: "Past its stale_after date" };
  if (summary.status === "draft") return { tone: "draft", title: "status: draft" };
  if (summary.status === "deprecated") return { tone: "deprecated", title: "status: deprecated" };
  return null;
}
