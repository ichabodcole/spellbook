/**
 * Context entries on disk — building an entry from a path (one model for a file and a folder),
 * mirroring a folder into a node tree, and listing a directory for the
 * surface's path completion (`fs.list`).
 *
 * Pure over the filesystem: no daemon state, so the unit cells drive it with a
 * temp directory and nothing else.
 */

import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { parseDocument } from "yaml";
import {
  BUNDLE_INFO,
  type BundleInfo,
  type BundleListing,
  type BundleType,
  type BundleWarning,
  bundleOf,
  bundleTypeOf,
  parseBundleInfo,
} from "../lib/bundles.ts";
import {
  DOC_EXTENSIONS,
  IMAGE_EXTENSIONS,
  isDocName,
  isHeicName,
  isImageName,
  isSvgName,
  SVG_REFUSED,
} from "../lib/docFormat.ts";
import { splitFrontmatter } from "../lib/frontmatter.ts";
import { imageOfSidecar } from "../lib/sidecar.ts";
import type { ContextEntry, ContextNode, FsListEntry } from "./protocol";

// What the workspace admits as a document, and how it reads each: one list,
// in `lib/docFormat.ts`, shared with the surface. Everything else is not shown.
export { DOC_EXTENSIONS, isDocName } from "../lib/docFormat.ts";

/** How much of a possible sidecar is read to find its `type`: a frontmatter block, not a document. */
const SIDECAR_HEAD_BYTES = 8 * 1024;

/**
 * Whether a document's saved frontmatter says `type: image`, from its first
 * bytes. Only asked of a file named like a sidecar, so a scan reads no other
 * document.
 */
export function typedImage(abs: string): boolean {
  let fd: number;
  try {
    fd = openSync(abs, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(SIDECAR_HEAD_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const { raw } = splitFrontmatter(buf.subarray(0, n).toString("utf8"));
    if (raw === null) return false;
    const doc = parseDocument(raw, { prettyErrors: false });
    if (doc.errors.length > 0) return false;
    const fields = doc.toJS() as unknown;
    return (
      typeof fields === "object" &&
      fields !== null &&
      (fields as Record<string, unknown>).type === "image"
    );
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * The description of the image at `imageAbs`, when there is one on disk: a
 * plain file (not a link) named exactly `<image name>.md`, cased as the image
 * is (on a disk that ignores case, `case.png.md` is not `CASE.PNG`'s), whose
 * saved frontmatter says `type: image`. Its path, else null. What the tree
 * folds, and what a rename, move or Trash of the image carries.
 */
export function sidecarFile(imageAbs: string): string | null {
  if (!isImageName(imageAbs)) return null;
  const name = `${basename(imageAbs)}.md`;
  const abs = join(dirname(imageAbs), name);
  try {
    // Both by their exact names: the image there, and its description beside it.
    const names = readdirSync(dirname(imageAbs));
    if (!names.includes(basename(imageAbs)) || !names.includes(name)) return null;
    if (!lstatSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return typedImage(abs) ? abs : null;
}

/**
 * A document's node: marked a sidecar when it is one (its image beside it,
 * named exactly, and `type: image`).
 */
export function docNode(rel: string, abs: string): ContextNode {
  const image = imageOfSidecar(abs);
  return image !== null && sidecarFile(image) === abs
    ? { kind: "doc", rel, sidecar: true }
    : { kind: "doc", rel };
}

/** How much of a bundle's `info.json` is read: a title and a description, not a data dump. */
export const BUNDLE_INFO_MAX_BYTES = 64 * 1024;

/** A bundle's `info.json`, read from disk, or null when it is missing, too big or not a JSON object. */
export function readBundleInfo(bundleAbs: string): BundleInfo | null {
  const abs = join(bundleAbs, BUNDLE_INFO);
  let fd: number;
  try {
    if (!lstatSync(abs).isFile()) return null;
    fd = openSync(abs, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(BUNDLE_INFO_MAX_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > BUNDLE_INFO_MAX_BYTES) return null;
    return parseBundleInfo(buf.subarray(0, n).toString("utf8"));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * A bundle folder's node: one item, named by its `info.json`. Only the
 * strings the row shows are taken from it; any other key stays on disk. A
 * type that declares `expand` gets its real files as `contents`, and its
 * `validate` warnings, read now.
 *
 * In a scan (`later` given), only its convention's files and member folders
 * are read now; the rest of it (`audio/…`) is read once the whole set has
 * been, from what is left of the cap (`finishOwnContents`), so a bundle's own
 * files never push a document out of the tree.
 */
export function bundleNode(
  rel: string,
  abs: string,
  type: BundleType,
  budget?: NodeBudget,
  later?: PendingBundle[],
): ContextNode {
  const info = readBundleInfo(abs);
  const title = typeof info?.title === "string" && info.title.trim() !== "" ? info.title : null;
  const description =
    typeof info?.description === "string" && info.description.trim() !== ""
      ? info.description
      : null;
  const node: ContextNode = {
    kind: "bundle",
    rel,
    type: type.type,
    main: type.main,
    ...(title !== null ? { title } : {}),
    ...(description !== null ? { description } : {}),
  };
  if (!type.expand) return node;
  const room = budget?.left ?? Number.POSITIVE_INFINITY;
  const members = bundleMemberContents(rel, abs, type, room);
  if (budget) budget.left -= members.count;
  const expanded: BundleNode = { ...node, contents: members.nodes };
  if (later) {
    later.push({ node: expanded, abs, type, truncated: members.truncated });
    return expanded;
  }
  const own = bundleOwnContents(rel, abs, type, room - members.count);
  if (budget) budget.left -= own.count;
  settleBundle(expanded, type, own.nodes, members.truncated || own.truncated);
  return expanded;
}

type BundleNode = Extract<ContextNode, { kind: "bundle" }>;

/** A bundle whose own files are still to be read, at the end of a scan. */
export type PendingBundle = { node: BundleNode; abs: string; type: BundleType; truncated: boolean };

/**
 * Read the own files of the bundles a scan put off, from what is left of its
 * cap (`room`), in the order they were met, and settle each: its contents
 * sorted, `truncated` and its `validate` warnings. Returns what is left.
 */
export function finishOwnContents(later: readonly PendingBundle[], room: number): number {
  let left = room;
  for (const p of later) {
    const own = bundleOwnContents(p.node.rel, p.abs, p.type, left);
    left -= own.count;
    settleBundle(p.node, p.type, own.nodes, p.truncated || own.truncated);
  }
  return left;
}

/** A bundle's contents put in order, with its `truncated` mark and its warnings. */
function settleBundle(
  node: BundleNode,
  type: BundleType,
  own: readonly ContextNode[],
  truncated: boolean,
): void {
  // Folders first, then files, each by name: as every other folder reads.
  const all = [...(node.contents ?? []), ...own];
  const byName = (a: ContextNode, b: ContextNode) => a.rel.localeCompare(b.rel);
  node.contents = [
    ...all.filter((n) => n.kind === "group").sort(byName),
    ...all.filter((n) => n.kind !== "group").sort(byName),
  ];
  if (truncated) node.truncated = true;
  else delete node.truncated;
  const warnings = bundleWarnings(type, bundleListing(node.rel, node.contents, truncated));
  if (warnings.length > 0) node.warnings = warnings;
  else delete node.warnings;
}

/**
 * What is left of a scan's node cap, shared by every bundle it reads: a set
 * holding fifty stages is bounded as a whole, not fifty times over.
 */
export type NodeBudget = { left: number };

/** The most nodes a bundle's member folders hold, together: its documents. */
export const BUNDLE_MEMBER_CAP = 1000;

/** The most nodes the rest of a bundle holds (`audio/…`): read after its members, never before. */
export const BUNDLE_OWN_CAP = 200;

/**
 * An expandable bundle's real files, as nodes with rels from the entry's
 * root (`rel` is the bundle's), read whole: its member folders as a set's
 * folders are, documents and images as such; everything else a `group` or a
 * `file`, the type's main file and `info.json` marked `convention`.
 *
 * Read in this order, each part with a budget of its own, so a full
 * `audio/` never pushes out a document: the convention's files (always, never
 * cut), then the member folders (`BUNDLE_MEMBER_CAP`), then the rest
 * (`BUNDLE_OWN_CAP`). `room` is what is left of a scan's overall cap: no part
 * reads past it. `count` is how many nodes were read.
 */
export function bundleContents(
  rel: string,
  abs: string,
  type: BundleType,
  room = Number.POSITIVE_INFINITY,
): { contents: ContextNode[]; truncated: boolean; count: number } {
  const members = bundleMemberContents(rel, abs, type, room);
  const own = bundleOwnContents(rel, abs, type, room - members.count);
  const node: BundleNode = {
    kind: "bundle",
    rel,
    type: type.type,
    main: type.main,
    contents: members.nodes,
  };
  settleBundle(node, type, own.nodes, members.truncated || own.truncated);
  return {
    contents: node.contents ?? [],
    truncated: node.truncated === true,
    count: members.count + own.count,
  };
}

/** A bundle's convention files (never cut) and its member folders (`BUNDLE_MEMBER_CAP`). */
function bundleMemberContents(
  rel: string,
  abs: string,
  type: BundleType,
  room: number,
): { nodes: ContextNode[]; truncated: boolean; count: number } {
  const members = type.expand?.members ?? [];
  const nodes: ContextNode[] = [];
  for (const name of [BUNDLE_INFO, type.main]) {
    try {
      const st = statSync(join(abs, name));
      if (st.isFile())
        nodes.push({ kind: "file", rel: `${rel}/${name}`, size: st.size, convention: true });
    } catch {
      /* not there: the type's validate may say so */
    }
  }
  const conventions = nodes.length;
  const walker = folderWalker(Math.max(0, Math.min(BUNDLE_MEMBER_CAP, room - conventions)));
  nodes.push(
    ...walker.walk(abs, rel, "own", (name, isDir) =>
      isDir && members.includes(name) ? "member" : null,
    ),
  );
  return { nodes, truncated: walker.truncated(), count: conventions + walker.count() };
}

/** The rest of a bundle (`audio/…`), within `BUNDLE_OWN_CAP` and `room`. */
function bundleOwnContents(
  rel: string,
  abs: string,
  type: BundleType,
  room: number,
): { nodes: ContextNode[]; truncated: boolean; count: number } {
  const members = type.expand?.members ?? [];
  const conventions = [BUNDLE_INFO, type.main];
  const walker = folderWalker(Math.max(0, Math.min(BUNDLE_OWN_CAP, room)));
  const nodes = walker.walk(abs, rel, "own", (name, isDir) =>
    (isDir && members.includes(name)) || (!isDir && conventions.includes(name)) ? null : "own",
  );
  return { nodes, truncated: walker.truncated(), count: walker.count() };
}

/** A bundle's listing (`validate`'s input), from its `contents`. */
export function bundleListing(
  rel: string,
  contents: readonly ContextNode[],
  truncated = false,
): BundleListing {
  const files: string[] = [];
  const folders: string[] = [];
  const inner = (r: string) => r.slice(rel.length + 1);
  const walk = (nodes: readonly ContextNode[]) => {
    for (const n of nodes) {
      if (n.kind === "group") {
        folders.push(inner(n.rel));
        walk(n.children);
      } else files.push(inner(n.rel));
    }
  };
  walk(contents);
  return {
    files: files.sort(),
    folders: folders.sort(),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/** What a type's `validate` says of a listing; a `validate` that throws is said as one warning. */
function bundleWarnings(type: BundleType, listing: BundleListing): BundleWarning[] {
  if (!type.expand?.validate) return [];
  try {
    return type.expand.validate(listing).filter((w) => typeof w?.message === "string");
  } catch (e) {
    return [{ message: `this ${type.label} could not be checked: ${String(e)}` }];
  }
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
 * How a folder is read:
 *
 * - `set`: a set's folder. Documents, images and bundles show; other files do
 *   not, nor a folder holding only them.
 * - `member`: a bundle's member folder. As a set's, but every file shows (one
 *   that is no document or image as a `file`), every folder shows, and a
 *   folder named like a bundle is a plain folder.
 * - `own`: the rest of a bundle. Every file is a `file`, every folder a group.
 */
type FolderMode = "set" | "member" | "own";

/**
 * One read of folders, under one cap shared by every folder it reads. With
 * `later`, a bundle met in a set has its own files put off there, for the
 * scan to read once the set is read (`finishOwnContents`).
 */
function folderWalker(cap: number, later?: PendingBundle[], skip?: ScanSkip) {
  let count = 0;
  let truncated = false;
  const walk = (
    dir: string,
    relDir: string,
    mode: FolderMode,
    /** The mode of one entry of THIS folder; null leaves it out (not read, not counted). */
    modeOf?: (name: string, isDir: boolean) => FolderMode | null,
  ): ContextNode[] => {
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
      // Without `modeOf` every entry counts, so the cap is met before a stat.
      if (!modeOf && count >= cap) {
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
      const rel = relDir === "" ? name : `${relDir}/${name}`;
      const here = modeOf ? modeOf(name, st.isDirectory()) : mode;
      if (here === null) continue;
      // The app's filter (`ScanRule.skip`), on a set's own entries only: a
      // skipped folder is not read, so everything under it goes with it, and
      // nothing skipped counts toward the cap.
      if (skip && here === "set" && skip(rel, st.isDirectory())) continue;
      if (count >= cap) {
        truncated = true;
        break;
      }
      if (st.isDirectory()) {
        if (here === "set" && SKIP_DIRS.has(name)) continue;
        count++;
        // A bundle is one item: its node, never a group. Its insides are its
        // own `contents`, read only for a type that expands.
        const bundle = here === "set" ? bundleTypeOf(name) : null;
        if (bundle) {
          // Its contents count toward this scan's cap, as anything else does.
          const budget = { left: cap - count };
          docs.push(bundleNode(rel, abs, bundle, budget, later));
          count = cap - budget.left;
          continue;
        }
        const children = walk(abs, rel, here);
        // In a set, a folder holding nothing the tree shows (only other files)
        // is noise in the mirror and is left out. A TRULY EMPTY folder is kept:
        // it is one somebody just made to put documents in ("New folder"), and
        // leaving it out made it vanish the moment it was created. Inside a
        // bundle every folder is real, and shows.
        if (here !== "set" || children.length > 0 || isEmptyDir(abs))
          groups.push({ kind: "group", rel, children });
      } else if (st.isFile() && here !== "own" && isDocName(name)) {
        count++;
        // Named like a sidecar, with its image beside it cased the same: read
        // for `type: image`. No other document is read here.
        const image = imageOfSidecar(name);
        docs.push(
          image !== null && names.includes(image) && typedImage(abs)
            ? { kind: "doc", rel, sidecar: true }
            : { kind: "doc", rel },
        );
      } else if (st.isFile() && here !== "own" && isImageName(name)) {
        // Its own kind of node, never a `doc`: `docPaths` (and so search, links,
        // the map and profiles) never meets an image. Name only: no bytes read.
        count++;
        docs.push({ kind: "image", rel });
      } else if (st.isFile() && here !== "set") {
        count++;
        docs.push({ kind: "file", rel, size: st.size });
      }
    }
    return [...groups, ...docs];
  };
  return { walk, truncated: () => truncated, count: () => count };
}

/**
 * An app's say over one path a set's scan meets: `rel` is POSIX, from the
 * set's root; true leaves it out of the tree, and so out of everything read
 * from the tree (search, links, the graph). A folder left out takes everything
 * under it. Asked of a set's own files and folders, never of a bundle's insides.
 */
export type ScanSkip = (rel: string, isDir: boolean) => boolean;

/**
 * Mirror `root` into a sorted node tree: groups first, then docs, by name.
 * Noise directories and dotfiles are skipped, and so is whatever `skip` says.
 */
export function scanTree(
  root: string,
  cap = MIRROR_NODE_CAP,
  skip?: ScanSkip,
): { nodes: ContextNode[]; truncated: boolean } {
  // Two passes: the set's documents, bundles and their member folders first,
  // then the bundles' own files (`audio/…`) from what is left, so a stage's
  // renders never push a document out of the tree.
  const later: PendingBundle[] = [];
  const walker = folderWalker(cap, later, skip);
  const nodes = walker.walk(root, "", "set");
  finishOwnContents(later, cap - walker.count());
  return { nodes, truncated: walker.truncated() };
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
    // Inside an expandable bundle: its contents are nodes like any other.
    if (n.kind === "bundle" && n.contents && rel.startsWith(`${n.rel}/`))
      return findNode(n.contents, rel);
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
 * An entry for an absolute path. A directory is `mirrored`; a document or an
 * image file is `listed`, rooted at its parent, holding only itself (a `doc` or
 * an `image` node). An SVG is refused with its reason, and a HEIC photo with the
 * way in that converts it.
 */
export function entryForPath(rawAbs: string, id: string): ContextEntry {
  // Anything inside a bundle stands for the bundle: its insides are never an
  // entry of their own (a set of its `assets/`, a listed `info.json`), as named
  // or, through a link, as it really is.
  const inBundle = bundleOf(rawAbs) ?? bundleOf(realOf(rawAbs));
  const abs = inBundle ? inBundle.root : rawAbs;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    throw new PathError(`no such file or folder: ${abs}`, "missing");
  }
  // A bundle added by itself is one item, listed as a single document is,
  // rooted at its parent: never mirrored, which would show its insides.
  const bundle = st.isDirectory() ? bundleTypeOf(abs) : null;
  if (bundle)
    return {
      id,
      label: basename(abs),
      root: dirname(abs),
      membership: "listed",
      nodes: [bundleNode(basename(abs), abs, bundle)],
      realRoot: realOf(dirname(abs)),
    };
  if (st.isDirectory()) {
    const { nodes, truncated } = scanTree(abs);
    return {
      id,
      label: basename(abs) || abs,
      root: abs,
      membership: "mirrored",
      nodes,
      realRoot: realOf(abs),
      ...(truncated ? { truncated } : {}),
    };
  }
  if (isSvgName(abs)) throw new PathError(SVG_REFUSED, "not-a-doc");
  if (isHeicName(abs))
    throw new PathError(
      `a HEIC photo is not shown as it is: drop it on the context list, which converts it to JPEG, or export it as JPEG first: ${abs}`,
      "not-a-doc",
    );
  const image = st.isFile() && isImageName(abs);
  if (!isDocName(abs) && !image) {
    throw new PathError(
      `not a document or image the workspace opens (${[...DOC_EXTENSIONS, ...IMAGE_EXTENSIONS].join(" ")}): ${abs}`,
      "not-a-doc",
    );
  }
  return {
    id,
    label: basename(abs),
    root: dirname(abs),
    membership: "listed",
    nodes: [image ? { kind: "image", rel: basename(abs) } : docNode(basename(abs), abs)],
    realRoot: realOf(dirname(abs)),
  };
}

/** A path's realpath, or the path itself when it cannot be resolved. */
export function realOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * A listed entry's one item: the document, image or bundle it holds, with its
 * absolute path (a bundle's folder). Null for a set, or for a listed entry
 * that holds anything else.
 */
export function listedFile(
  entry: ContextEntry,
): { kind: "doc" | "image" | "bundle"; rel: string; abs: string } | null {
  if (entry.membership !== "listed" || entry.nodes.length !== 1) return null;
  const only = entry.nodes[0];
  if (!only || only.kind === "group" || only.kind === "file") return null;
  return { kind: only.kind, rel: only.rel, abs: join(entry.root, only.rel) };
}

/**
 * Every document's absolute path, depth-first: each doc node's, and each
 * bundle's main file, which is a document to everything that walks them
 * (opening, versions, search) though the tree shows only its bundle. An
 * expandable bundle's member documents are documents too: its `contents`
 * hold `doc` nodes only under a member folder.
 */
export function docPaths(entry: ContextEntry): string[] {
  const out: string[] = [];
  const walk = (nodes: ContextNode[]) => {
    for (const n of nodes) {
      if (n.kind === "doc") out.push(join(entry.root, n.rel));
      else if (n.kind === "bundle") {
        out.push(join(entry.root, n.rel, n.main));
        if (n.contents) walk(n.contents);
      } else if (n.kind === "group") walk(n.children);
    }
  };
  walk(entry.nodes);
  return out;
}

/** Every bundle node, with its folder's absolute path, depth-first. */
export function bundlesIn(
  entry: ContextEntry,
): { abs: string; node: Extract<ContextNode, { kind: "bundle" }> }[] {
  const out: { abs: string; node: Extract<ContextNode, { kind: "bundle" }> }[] = [];
  const walk = (nodes: ContextNode[]) => {
    for (const n of nodes) {
      if (n.kind === "bundle") out.push({ abs: join(entry.root, n.rel), node: n });
      else if (n.kind === "group") walk(n.children);
    }
  };
  walk(entry.nodes);
  return out;
}

/** Every document an entry marks as an image's description (`sidecar`), by absolute path. */
export function sidecarPaths(entry: ContextEntry): string[] {
  const out: string[] = [];
  const walk = (nodes: ContextNode[]) => {
    for (const n of nodes) {
      if (n.kind === "doc" && n.sidecar) out.push(join(entry.root, n.rel));
      else if (n.kind === "group") walk(n.children);
      else if (n.kind === "bundle" && n.contents) walk(n.contents);
    }
  };
  walk(entry.nodes);
  return out;
}

/** Every image node's absolute path, depth-first. Kept apart from `docPaths` on purpose. */
export function imagePaths(entry: ContextEntry): string[] {
  const out: string[] = [];
  const walk = (nodes: ContextNode[]) => {
    for (const n of nodes) {
      if (n.kind === "image") out.push(join(entry.root, n.rel));
      else if (n.kind === "group") walk(n.children);
      else if (n.kind === "bundle" && n.contents) walk(n.contents);
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
 * One directory, for the surface's add-by-path completion: subdirectories,
 * documents and images only, directories first. `~` is expanded by the caller.
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
    if (isDir || isDocName(name) || isImageName(name)) out.push({ name, path: abs, dir: isDir });
  }
  return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}
