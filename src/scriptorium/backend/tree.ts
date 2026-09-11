/**
 * Context entries on disk — building an entry from a path (E15's one model),
 * mirroring a folder into a node tree, and listing a directory for the
 * surface's path completion (`fs.list`).
 *
 * Pure over the filesystem: no daemon state, so the unit cells drive it with a
 * temp directory and nothing else.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { ContextEntry, ContextNode, FsListEntry } from "./protocol";

/** What scriptorium opens as a document. Everything else is not shown. */
export const DOC_EXTENSIONS = [".md", ".markdown", ".mdx", ".txt"] as const;

export function isDocName(name: string): boolean {
  const lower = name.toLowerCase();
  return DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Directories a mirror never descends into — noise, not documents. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "coverage"]);

/**
 * The most nodes one mirrored scan will hold. A folder entry pointed at a huge
 * tree must not stall the daemon or flood every state broadcast; hitting the
 * cap sets `truncated` on the entry so the surface can SAY the list is short
 * rather than render a short list as a complete one.
 */
export const MIRROR_NODE_CAP = 2000;

export const toPosix = (p: string) => p.split(sep).join("/");

/**
 * Mirror `root` into a sorted node tree: groups first, then docs, by name.
 * `hidden` rels (E24's "Remove from Scriptorium") are skipped, a folder with
 * everything under it.
 */
export function scanTree(
  root: string,
  cap = MIRROR_NODE_CAP,
  hidden: readonly string[] = [],
): { nodes: ContextNode[]; truncated: boolean } {
  let count = 0;
  let truncated = false;
  const skip = new Set(hidden);
  const walk = (dir: string): ContextNode[] => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const groups: ContextNode[] = [];
    const docs: ContextNode[] = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (name.startsWith(".")) continue;
      if (count >= cap) {
        truncated = true;
        break;
      }
      const abs = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const rel = toPosix(relative(root, abs));
      if (skip.has(rel)) continue;
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        count++;
        const children = walk(abs);
        // A folder holding only non-documents (images, assets) is noise in a
        // docs mirror and is left out. A TRULY EMPTY folder is kept: it is one
        // somebody just made to put documents in ("New folder", E24), and
        // leaving it out made it vanish the moment it was created.
        if (children.length > 0 || isEmptyDir(abs)) groups.push({ kind: "group", rel, children });
      } else if (st.isFile() && isDocName(name)) {
        count++;
        docs.push({ kind: "doc", rel });
      }
    }
    return [...groups, ...docs];
  };
  const nodes = walk(root);
  return { nodes, truncated };
}

/** Nothing in it but dotfiles (a `.DS_Store` does not make a folder full). */
function isEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).every((n) => n.startsWith("."));
  } catch {
    return false;
  }
}

/** The node at `rel` in a tree, or undefined. */
export function findNode(nodes: readonly ContextNode[], rel: string): ContextNode | undefined {
  for (const n of nodes) {
    if (n.rel === rel) return n;
    if (n.kind === "group" && rel.startsWith(`${n.rel}/`)) return findNode(n.children, rel);
  }
  return undefined;
}

export class PathError extends Error {
  constructor(
    message: string,
    readonly code: "missing" | "not-a-doc",
  ) {
    super(message);
  }
}

/**
 * An entry for an absolute path. A directory is `mirrored`; a document file is
 * `listed`, rooted at its parent, holding only itself (E15).
 */
export function entryForPath(abs: string, id: string): ContextEntry {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    throw new PathError(`no such file or folder: ${abs}`, "missing");
  }
  if (st.isDirectory()) {
    const { nodes, truncated } = scanTree(abs);
    return {
      id,
      label: basename(abs) || abs,
      root: abs,
      membership: "mirrored",
      nodes,
      ...(truncated ? { truncated } : {}),
    };
  }
  if (!isDocName(abs)) {
    throw new PathError(
      `not a document scriptorium opens (${DOC_EXTENSIONS.join(" ")}): ${abs}`,
      "not-a-doc",
    );
  }
  return {
    id,
    label: basename(abs),
    root: dirname(abs),
    membership: "listed",
    nodes: [{ kind: "doc", rel: basename(abs) }],
  };
}

/** Every doc node's absolute path, depth-first. */
export function docPaths(entry: ContextEntry): string[] {
  const out: string[] = [];
  const walk = (nodes: ContextNode[]) => {
    for (const n of nodes) {
      if (n.kind === "doc") out.push(join(entry.root, n.rel));
      else walk(n.children);
    }
  };
  walk(entry.nodes);
  return out;
}

/** Which entry (if any) holds `abs`, and at what `rel`. */
export function locate(
  entries: ContextEntry[],
  abs: string,
): { entryId: string; rel: string } | null {
  for (const e of entries) {
    if (docPaths(e).includes(abs)) return { entryId: e.id, rel: toPosix(relative(e.root, abs)) };
  }
  return null;
}

/**
 * One directory, for the surface's add-by-path completion: subdirectories and
 * documents only, directories first. `~` is expanded by the caller.
 */
export function listDir(dir: string): FsListEntry[] {
  const names = readdirSync(dir);
  const out: FsListEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const abs = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir || isDocName(name)) out.push({ name, path: abs, dir: isDir });
  }
  return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}
