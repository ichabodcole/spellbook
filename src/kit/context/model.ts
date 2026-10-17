// The context sidebar's pure helpers: no React, no daemon, so the rules the
// sidebar renders by are unit tests rather than something to eyeball. The
// components import these; nothing here imports a component.

import { bundleDisplayName, bundleOf, bundlePlace } from "../lib/bundles.ts";
import { isDocName, isHeicName, isImageName, isSvgName } from "../lib/docFormat.ts";
import { imageOfSidecar } from "../lib/sidecar.ts";
import type { ContextEntry, ContextNode } from "../workspace/protocol";

/** A POSIX path's last segment. */
export function baseName(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? rel : rel.slice(i + 1);
}

/**
 * A node's name as its row shows it: a bundle by its title, else its folder's
 * name without the extension; anything else by its file or folder name.
 */
export function nodeLabel(node: ContextNode): string {
  return node.kind === "bundle"
    ? bundleDisplayName(baseName(node.rel), node.title)
    : baseName(node.rel);
}

/**
 * The name a bundle's row shows (its title), for a path at or inside the
 * bundle, from the context's tree; null for a path in no bundle the context
 * shows, and for a document in a bundle's member folder, which is named as
 * itself.
 */
export function bundleLabelAt(entries: readonly ContextEntry[], path: string): string | null {
  const b = bundleOf(path);
  if (!b || bundlePlace(path) === "member") return null;
  for (const e of entries) {
    const walk = (nodes: readonly ContextNode[]): string | null => {
      for (const n of nodes) {
        if (n.kind === "bundle" && joinPath(e.root, n.rel) === b.root) return nodeLabel(n);
        if (n.kind === "group" && isUnder(b.root, joinPath(e.root, n.rel))) {
          const hit = walk(n.children);
          if (hit) return hit;
        }
      }
      return null;
    };
    const hit = walk(e.nodes);
    if (hit) return hit;
  }
  return null;
}

/** The document a row opens, by absolute path: a bundle's main file, else the row's own. */
export function docPathOf(root: string, node: ContextNode): string {
  return joinPath(root, node.kind === "bundle" ? `${node.rel}/${node.main}` : node.rel);
}

/** Join an entry's absolute root and a node's POSIX-relative path. */
export function joinPath(root: string, rel: string): string {
  return root.endsWith("/") ? `${root}${rel}` : `${root}/${rel}`;
}

/** Abbreviate a home-relative path for display: `/Users/x/notes` becomes `~/notes`. */
export function tildify(path: string, home: string | null): string {
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The inverse, for a path the human typed: the daemon takes absolute paths or `~`. */
export function expandTilde(path: string, home: string | null): string {
  if (!home) return path;
  if (path === "~") return home;
  return path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

/**
 * A path short enough for a sidebar row: home-abbreviated, then cut from the
 * FRONT so the part that tells two paths apart, the end, survives
 * (`.../drafts/notes`). The full path belongs in the row's tooltip.
 */
export function shortPath(path: string, home: string | null, keep = 2): string {
  const t = tildify(path, home);
  const parts = t.split("/");
  const lead = t.startsWith("~") ? 1 : t.startsWith("/") ? 1 : 0; // "~" or "" before the first slash
  if (parts.length - lead <= keep + 1) return t;
  return `…/${parts.slice(-keep).join("/")}`;
}

/**
 * Display order: sort-based, never a manual order. Groups first, then
 * documents, each by name, case-insensitively with natural numbers ("ch2" before
 * "ch10"). Never mutates.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export function sortNodes(nodes: readonly ContextNode[]): ContextNode[] {
  return [...nodes].sort((a, b) => {
    // Groups first; documents and images together, by name, so `fox.png` sits
    // beside `fox.md`.
    // A bundle sits among them by the name its row shows.
    const ag = a.kind === "group";
    const bg = b.kind === "group";
    if (ag !== bg) return ag ? -1 : 1;
    return collator.compare(nodeLabel(a), nodeLabel(b));
  });
}

/**
 * Every document node under `nodes`, depth-first, with each bundle (one item,
 * opening as its main document). Images are not documents.
 */
export function docsIn(nodes: readonly ContextNode[]): ContextNode[] {
  const out: ContextNode[] = [];
  for (const n of nodes) {
    if (n.kind === "doc" || n.kind === "bundle") out.push(n);
    else if (n.kind === "group") out.push(...docsIn(n.children));
  }
  return out;
}

/** Every image node under `nodes`, depth-first. */
export function imagesIn(nodes: readonly ContextNode[]): ContextNode[] {
  const out: ContextNode[] = [];
  for (const n of nodes) {
    if (n.kind === "image") out.push(n);
    else if (n.kind === "group") out.push(...imagesIn(n.children));
  }
  return out;
}

/**
 * One level of a tree with each image's description folded into the image: a
 * document the daemon marks `sidecar` (named `<image>.md` beside that image,
 * and of `type: image`) is no row of its own. A document only named like one
 * keeps its row. `sidecars` maps each described image's rel to its sidecar's, across the
 * whole tree. A sidecar whose image is not beside it (an orphan) is left as the
 * ordinary document it is. Never mutates.
 */
export function foldSidecars(nodes: readonly ContextNode[]): {
  nodes: ContextNode[];
  sidecars: Map<string, string>;
} {
  const sidecars = new Map<string, string>();
  const walk = (list: readonly ContextNode[]): ContextNode[] => {
    const images = new Set(list.filter((n) => n.kind === "image").map((n) => n.rel));
    const out: ContextNode[] = [];
    for (const n of list) {
      if (n.kind === "group") {
        out.push({ ...n, children: walk(n.children) });
        continue;
      }
      if (n.kind === "bundle" && n.contents) {
        out.push({ ...n, contents: walk(n.contents) });
        continue;
      }
      const image = n.kind === "doc" && n.sidecar ? imageOfSidecar(n.rel) : null;
      if (image !== null && images.has(image)) {
        sidecars.set(image, n.rel);
        continue;
      }
      out.push(n);
    }
    return out;
  };
  return { nodes: walk(nodes), sidecars };
}

/**
 * What a set holds, as its row counts it: documents and images, with each
 * image's description counted as part of its image, not as a document of its
 * own. An orphan sidecar (its image gone) is a document, and counts as one.
 */
export function countEntry(nodes: readonly ContextNode[]): { docs: number; images: number } {
  const folded = foldSidecars(nodes).nodes;
  return { docs: docsIn(folded).length, images: imagesIn(folded).length };
}

/**
 * The entries a context list shows as rows: a loose image's sidecar, listed
 * beside it, folds into the image's row as a set's does. `described` maps each
 * described loose image's entry id to its sidecar's own entry.
 */
export function foldListedSidecars<E extends ContextEntry>(
  entries: readonly E[],
): { entries: E[]; described: Map<string, E> } {
  const imageEntry = new Map<string, string>();
  for (const e of entries) {
    const only = singleFile(e);
    if (only?.kind === "image") imageEntry.set(joinPath(e.root, only.rel), e.id);
  }
  const described = new Map<string, E>();
  const out: E[] = [];
  for (const e of entries) {
    const only = singleFile(e);
    if (only?.kind === "doc" && only.sidecar) {
      const path = joinPath(e.root, only.rel);
      const image = imageOfSidecar(path);
      const id = image === null ? undefined : imageEntry.get(image);
      if (id !== undefined) {
        described.set(id, e);
        continue;
      }
    }
    out.push(e);
  }
  return { entries: out, described };
}

/** A set's contents in words: "3 documents, 2 images"; images only when there are any. */
export function countsInWords(docs: number, images: number): string {
  const d = `${docs} ${docs === 1 ? "document" : "documents"}`;
  return images > 0 ? `${d}, ${images} ${images === 1 ? "image" : "images"}` : d;
}

/**
 * One entry type, rendered two ways. A `listed` entry holding exactly one
 * document renders as that document; anything else renders as a tree you drill
 * into: ANY `mirrored` folder, even one holding a single file, because the human
 * added a folder and a folder should stay one. (A one-file folder shown as its
 * file loses the folder's name, and "Remove" on that row would remove the whole
 * folder.)
 */
export function singleDoc(entry: ContextEntry): ContextNode | null {
  if (entry.membership !== "listed") return null;
  const [only, ...rest] = entry.nodes;
  return only && rest.length === 0 && only.kind === "doc" ? only : null;
}

/**
 * A `listed` entry holding exactly one file, a document or an image (a loose
 * image, dropped on the list or added by path), renders as that file: its row
 * opens it, renames it and offers Delete. Null for anything shown as a set.
 */
export function singleFile(entry: ContextEntry): ContextNode | null {
  if (entry.membership !== "listed") return null;
  const [only, ...rest] = entry.nodes;
  return only && rest.length === 0 && only.kind !== "group" ? only : null;
}

/** An entry's own path: a set's folder, or a single document's or image's file. */
export function entryPath(entry: ContextEntry): string {
  const only = singleFile(entry);
  return only ? joinPath(entry.root, only.rel) : entry.root;
}

/** A flat, id-keyed index of an entry's tree, for the tree library's data loader. */
export type TreeIndex = {
  /** node id to node; ids are the node's `rel` (unique within an entry). */
  byId: Map<string, ContextNode>;
  /** parent id (ROOT_ID for the top level) to sorted child ids. */
  children: Map<string, string[]>;
  /** A described image's id to its sidecar's rel: the sidecar has no row of its own. */
  sidecars: Map<string, string>;
  /** A folded sidecar's rel to its image's id: the row that stands for it. */
  imageOf: Map<string, string>;
  /** A bundle's main file's rel to the bundle's id: the row that stands for it when it is open. */
  bundleOf: Map<string, string>;
};

/**
 * The synthetic root every entry's tree hangs from. "/" because a node's `rel`
 * is POSIX-relative and so can never be "/": no file or folder can collide.
 */
export const ROOT_ID = "/";

export function indexTree(all: readonly ContextNode[]): TreeIndex {
  const { nodes, sidecars } = foldSidecars(all);
  const imageOf = new Map([...sidecars].map(([image, sidecar]) => [sidecar, image]));
  const byId = new Map<string, ContextNode>();
  const children = new Map<string, string[]>();
  const bundleOf = new Map<string, string>();
  const walk = (parent: string, list: readonly ContextNode[]) => {
    const sorted = sortNodes(list);
    children.set(
      parent,
      sorted.map((n) => n.rel),
    );
    for (const n of sorted) {
      byId.set(n.rel, n);
      if (n.kind === "group") walk(n.rel, n.children);
      else if (n.kind === "bundle") {
        bundleOf.set(`${n.rel}/${n.main}`, n.rel);
        // An expandable bundle's real files hang under its row.
        if (n.contents) walk(n.rel, n.contents);
      }
    }
  };
  walk(ROOT_ID, nodes);
  return { byId, children, sidecars, imageOf, bundleOf };
}

/**
 * Whether the open document (`activeRel`, within the row's entry) is this
 * row's: the row's own file, or a bundle row's main file.
 */
export function rowHolds(node: ContextNode, activeRel: string | null): boolean {
  if (activeRel === null) return false;
  return node.kind === "bundle"
    ? activeRel === node.rel || activeRel === `${node.rel}/${node.main}`
    : activeRel === node.rel;
}

/** The group ids that contain `rel`: what to expand so an open document shows. */
export function ancestorsOf(rel: string): string[] {
  const parts = rel.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

// What the workspace opens as a document: the one list in `lib/docFormat.ts`,
// which the daemon's `workspace/tree.ts` re-exports too.
export { DOC_EXTENSIONS, isDocName } from "../lib/docFormat.ts";

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
 * A place a document or folder can be moved to, for "Move to…": the workspace
 * folder, a set's own folder, or a folder inside a set (what the daemon's
 * `move` accepts). `label` is how it reads: "Workspace", the set's name, or
 * `set/folder/inner`.
 */
export type MoveTarget = { label: string; path: string; kind: "workspace" | "set" | "folder" };

/**
 * Every place `item` can be moved to, the same list wherever it is asked from:
 * the workspace first, then each set followed by its folders in tree order.
 * Left out: where the item already is, and for a folder itself and anything
 * under it. A listed entry is a document, not a place to put things.
 */
export function moveTargets(
  entries: readonly ContextEntry[],
  item: string,
  workspace: string | null = null,
): MoveTarget[] {
  const here = dirOf(item);
  const out: MoveTarget[] = [];
  const offer = (t: MoveTarget) => {
    if (t.path === here || t.path === item || t.path.startsWith(`${item}/`)) return;
    if (!out.some((o) => o.path === t.path)) out.push(t);
  };
  // A whole set is not offered the workspace: its folder would be carried from
  // wherever it lives on disk into the workspace. It can still go into another
  // set. A document listed on its own from outside the workspace is offered it
  // (bringing it into the world is a fair, explicit act), never pre-selected.
  const wholeSet = entries.some((e) => e.membership === "mirrored" && e.root === item);
  if (workspace && !wholeSet) offer({ label: "Workspace", path: workspace, kind: "workspace" });
  const folders = (e: ContextEntry, nodes: readonly ContextNode[], at = e.label) => {
    for (const n of nodes) {
      if (n.kind === "bundle" && n.contents) {
        // An expandable bundle's member folders take documents: offered by
        // the name its row shows (`set/The lighthouse/docs`).
        const name = nodeLabel(n);
        const inside = (rel: string) => rel.slice(n.rel.length + 1);
        const members = (list: readonly ContextNode[]) => {
          for (const m of list) {
            if (m.kind !== "group") continue;
            const path = joinPath(e.root, m.rel);
            const place = bundlePlace(path);
            if (place !== "member" && place !== "member-folder") continue;
            const label = `${name}/${inside(m.rel)}`;
            offer({ label: at ? `${at}/${label}` : label, path, kind: "folder" });
            members(m.children);
          }
        };
        members(n.contents);
      }
      if (n.kind !== "group") continue;
      offer({ label: `${at}/${n.rel}`, path: joinPath(e.root, n.rel), kind: "folder" });
      folders(e, n.children, at);
    }
  };
  for (const e of entries) {
    if (e.membership !== "mirrored") {
      // A bundle listed on its own offers its member folders.
      const only = singleFile(e);
      if (only?.kind === "bundle" && only.contents) folders(e, [only], "");
      continue;
    }
    offer({ label: e.label, path: e.root, kind: "set" });
    folders(e, e.nodes);
  }
  return out;
}

/**
 * The targets a search keeps: every word of `query` somewhere in the label
 * (case aside), in the order given. An empty query keeps them all.
 */
export function filterMoveTargets(targets: readonly MoveTarget[], query: string): MoveTarget[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...targets];
  return targets.filter((t) => {
    const label = t.label.toLowerCase();
    return words.every((w) => label.includes(w));
  });
}

/**
 * The files a drop carries, split: documents to copy in as text, images to
 * send as bytes (a HEIC photo among them, which the daemon converts), SVGs to
 * refuse with their own reason, and other names to refuse. An image is never
 * read as text, and a document is never sent as an image.
 */
export function splitDropped(files: readonly { name: string }[]): {
  docs: number[];
  images: number[];
  svg: string[];
  skipped: string[];
} {
  const docs: number[] = [];
  const images: number[] = [];
  const svg: string[] = [];
  const skipped: string[] = [];
  files.forEach((f, i) => {
    if (isDocName(f.name)) docs.push(i);
    else if (isImageName(f.name) || isHeicName(f.name)) images.push(i);
    else if (isSvgName(f.name)) svg.push(f.name);
    else skipped.push(f.name);
  });
  return { docs, images, svg, skipped };
}

/**
 * What a right-click landed on, for the menus and for an app's own actions. A
 * `file` is one of an expandable bundle's own files (its main file, its
 * `info.json`, a render): shown under its row, never a document of its own.
 */
export type MenuTargetKind = "doc" | "image" | "bundle" | "group" | "file" | "entry" | "background";

/** Whether `path` lies under `folder`, on a separator boundary (`/a/b` does not hold `/a/bc`). */
export function isUnder(path: string, folder: string): boolean {
  return path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
}

/**
 * What a folder holds: `total` is the number of distinct document paths under it
 * in the context tree (an entry listed twice counts a document once), and `docs`
 * the open documents among those paths, so `docs` can never outnumber `total`.
 */
export function folderDocs<D extends { original: string }>(
  entries: readonly ContextEntry[],
  docs: readonly D[],
  folder: string,
): { docs: D[]; total: number } {
  const paths = new Set<string>();
  for (const entry of entries) {
    for (const node of docsIn(entry.nodes)) {
      const path = docPathOf(entry.root, node);
      if (isUnder(path, folder)) paths.add(path);
    }
  }
  return { docs: docs.filter((d) => paths.has(d.original)), total: paths.size };
}

/**
 * The open document (as the daemon knows it) that lives at `path`, if any. A
 * node in the tree is a file; it becomes a document when the human opens it.
 */
export function docAt<D extends { original: string; slug: string }>(
  docs: readonly D[],
  path: string,
): D | undefined {
  return docs.find((d) => d.original === path);
}

/** A row selected in the file tree, as a ref: the row's path, what to read, and its name. */
export type RowRef = { row: string; path: string; name: string };

/**
 * A reader of rows (absolute paths) against the context's trees: the entry and
 * node a row is, or null when no tree shows it. Every entry under the row is
 * tried, so a loose file's entry, whose root is the workspace itself, does not
 * hide a set's rows beneath it. Each entry is indexed once per reader.
 */
function rowReader(entries: readonly ContextEntry[]) {
  const indexes = new Map<string, TreeIndex>();
  return (row: string): { entry: ContextEntry; node: ContextNode } | null => {
    for (const entry of entries) {
      if (!row.startsWith(`${entry.root}/`)) continue;
      let index = indexes.get(entry.id);
      if (!index) {
        index = indexTree(entry.nodes);
        indexes.set(entry.id, index);
      }
      const node = index.byId.get(row.slice(entry.root.length + 1));
      if (node) return { entry, node };
    }
    return null;
  };
}

/**
 * The documents and images among the tree's selected rows (absolute row
 * paths), as refs: a bundle is read by its main file; a folder, and a
 * bundle's own files, are not refs; a row the tree no longer shows (moved,
 * renamed, gone) is dropped. In the order selected.
 */
export function rowRefs(entries: readonly ContextEntry[], rows: readonly string[]): RowRef[] {
  const read = rowReader(entries);
  const out: RowRef[] = [];
  for (const row of rows) {
    const at = read(row);
    if (!at) continue;
    const { entry, node } = at;
    if (node.kind !== "doc" && node.kind !== "image" && node.kind !== "bundle") continue;
    out.push({ row, path: docPathOf(entry.root, node), name: nodeLabel(node) });
  }
  return out;
}

/** The rows the tree still shows, of those given (absolute paths), in order: a renamed, moved or deleted one is gone. */
export function rowsShown(entries: readonly ContextEntry[], rows: readonly string[]): string[] {
  const read = rowReader(entries);
  return rows.filter((row) => read(row) !== null);
}
