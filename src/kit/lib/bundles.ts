/**
 * Bundles: a folder that acts as one item. A bundle is a folder named with a
 * registered extension (`The well.canvasbundle/`) holding a main file (the one
 * that opens and is versioned), an `info.json` (its title and description) and
 * whatever else its type keeps beside them (`assets/`).
 *
 * The kit knows no bundle type of its own. An app registers each one it uses
 * (`registerBundleType`), in its daemon and in its surface alike, before
 * either reads a tree: Atlas registers its canvas. Nothing in the kit names a
 * type except through this registry, so a story draft with its images can be
 * the next type without the kit changing.
 *
 * What the kit does with a registered type:
 *
 * - **The tree** shows the folder as one row (a `bundle` node), named by
 *   `info.json`'s `title` or else the folder's name without its extension,
 *   with the type's icon. Its insides show only for a type that declares
 *   `expand`, under the row's chevron.
 * - **Rename, Move to, Trash and Duplicate** act on the whole folder.
 * - **Opening** the row opens the main file, read as `format` says. Versions
 *   are taken of the main file only, as of any document.
 * - **The watcher** reports a change anywhere inside as a change to the bundle.
 * - **Search** reads the main file, though the tree hides it.
 *
 * Pure: no `node:` imports, so a surface can bundle it. The registry is one
 * per process, as `docFormat`'s list is: the daemon and the surface each hold
 * their own copy, filled by the same app module.
 */

import type { ReactNode } from "react";
import type { DocFormat } from "./docFormat.ts";

/** One kind of bundle, as an app registers it. */
export type BundleType = {
  /** The folder's extension, with its dot: `.canvasbundle`. Matched without regard to case. */
  extension: string;
  /** What `info.json` says it is (`"canvas"`), and the key a surface looks a type's view up by. */
  type: string;
  /** The file inside that opens and is versioned: `board.canvas`. */
  main: string;
  /** How the main file is read and edited until the app gives it a view of its own. */
  format: DocFormat;
  /** What the human calls one, lower case: "canvas", for "New canvas" and "Delete this canvas". */
  label: string;
  /** The main file's text in a new, empty bundle. It must be valid for `format`. */
  mainTemplate: string;
  /** The row's icon. Given by the surface's registration only; the daemon has no use for one. */
  icon?: ReactNode;
  /**
   * The references the main file makes to other files (a board's cards), for
   * the link layer: read as links from the bundle, checked, listed in a
   * document's backlinks, drawn on the graph, and rewritten when what they
   * point at is renamed or moved. Absent: the main file makes none the kit
   * reads.
   */
  references?: BundleReferences;
  /**
   * The bundle can be expanded in the tree to show its real files, and the
   * files in its member folders are ordinary documents: opened, versioned,
   * written into, renamed and moved like any other. Everything else inside
   * stays the type's own: shown, never written by a structure act. Absent: the
   * bundle is one row with nothing under it (Atlas's canvas).
   */
  expand?: BundleExpand;
};

/** What an expandable bundle type declares (`BundleType.expand`). */
export type BundleExpand = {
  /**
   * Folders at the bundle's top level whose files are ordinary documents:
   * `["docs"]`. Each is one plain folder name.
   */
  members: readonly string[];
  /**
   * Structure warnings, from a listing of the bundle. Pure: the kit runs it
   * whenever it reads the bundle, and shows the count on the bundle's row.
   */
  validate?: (listing: BundleListing) => BundleWarning[];
};

/**
 * Every file and folder inside one bundle, as `/`-separated paths from the
 * bundle's folder (`docs/01-arrival.md`), sorted. Dotfiles are left out.
 */
export type BundleListing = {
  files: string[];
  folders: string[];
  /**
   * The read stopped at a cap: more files are there than listed. The type's
   * own files are read last, so its main file, `info.json` and its member
   * folders' files are cut only when a whole set is past its cap.
   */
  truncated?: true;
};

/** One thing wrong with a bundle's structure, as its type's `validate` says it. */
export type BundleWarning = {
  /** What is wrong, in a sentence the human reads. */
  message: string;
  /** The file or folder it is about, from the bundle's folder, when there is one. */
  path?: string;
};

/**
 * One reference a bundle's main file makes to another file, as written: a
 * card on a board pointing at a document.
 */
export type BundleReference = {
  /** The path EXACTLY as written: what a rewrite swaps, and what a report quotes. */
  raw: string;
  /** The 1-based line of the main file it is written on. */
  line: number;
  /** Where its holder sits in the text, as offsets. */
  from: number;
  to: number;
  /** What holds it, by its id in the file (a card's id). */
  id: string;
  /** What it is called where it is, when it has a name of its own (the title a card last showed). */
  label?: string;
  /** A place inside the target (a heading), as written; a rewrite never touches it. */
  subpath?: string;
};

/** Where a bundle is, for resolving and writing its references. */
export type ReferencePlace = {
  /** The bundle's main file, absolute. */
  main: string;
  /** The bundle's folder, absolute. */
  bundle: string;
  /** The root of the context entry that holds the bundle, absolute. */
  entryRoot: string;
  /** Whether an absolute path is a folder on disk: the kit asks the disk, so the type stays pure. */
  isDir: (path: string) => boolean;
};

/**
 * What a bundle type tells the link layer about its references. Pure, like
 * the rest of this module: the disk is asked only through `ReferencePlace`.
 * The kit resolves each candidate itself, by the same test a markdown link's
 * target meets, so a reference lands where a link to the same file would.
 */
export type BundleReferences = {
  /** What a person calls one bundle of the type, lower case: "board" ("On the board The well"). */
  noun: string;
  /** What holds one reference, lower case: "card" ("card 'The Glade'"). */
  part: string;
  /** Every reference the main file's text makes, in the order written; none for a text that does not read. */
  read(text: string): BundleReference[];
  /** Where a reference written `raw` could land, as absolute paths in the order tried: the first that exists is it. */
  candidates(raw: string, at: ReferencePlace): string[];
  /** How the bundle at `at` writes a reference to `to` (absolute), or null when it cannot reach it. */
  write(to: string, at: ReferencePlace): string | null;
  /**
   * `text` with every reference whose `raw` `swap` maps written as the new
   * path, and how many changed. Everything else in it is kept.
   */
  swap(text: string, swap: (raw: string) => string | undefined): { text: string; count: number };
};

const registry = new Map<string, BundleType>();

/**
 * Register a bundle type, or replace the one registered for its extension. An
 * app calls this once at load, in its daemon's module and in its surface's.
 */
export function registerBundleType(type: BundleType): void {
  const ext = type.extension.toLowerCase();
  if (!/^\.[a-z0-9]+$/.test(ext))
    throw new Error(`a bundle extension is a dot and letters or digits: ${type.extension}`);
  if (type.main.includes("/") || type.main === "" || type.main.startsWith("."))
    throw new Error(`a bundle's main file is one plain name: ${type.main}`);
  for (const m of type.expand?.members ?? [])
    if (m === "" || m.includes("/") || m.startsWith(".") || m === type.main || m === BUNDLE_INFO)
      throw new Error(`a bundle's member is one plain folder name: ${m}`);
  registry.set(ext, { ...type, extension: ext });
}

/** Forget a registered type: for tests that register one of their own. */
export function unregisterBundleType(extension: string): void {
  registry.delete(extension.toLowerCase());
}

/** Every registered type, in the order they were registered. */
export function bundleTypes(): BundleType[] {
  return [...registry.values()];
}

/** The last segment of a `/`-separated path. */
const lastSegment = (p: string): string => {
  const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? trimmed : trimmed.slice(i + 1);
};

/** The type a folder's name says it is (`x.canvasbundle`), or null for any other name. */
export function bundleTypeOf(name: string): BundleType | null {
  const base = lastSegment(name).toLowerCase();
  for (const t of registry.values())
    if (base.endsWith(t.extension) && base.length > t.extension.length) return t;
  return null;
}

/** Whether a folder's name makes it a bundle. */
export function isBundleName(name: string): boolean {
  return bundleTypeOf(name) !== null;
}

/**
 * The outermost bundle a path is in or is (`/w/The well.canvasbundle` for
 * `/w/The well.canvasbundle/assets/fox.png`, and for the bundle itself), with
 * its type and the path's place inside it (`""` for the bundle itself). Null
 * for a path in no bundle. By name alone: the disk is not asked.
 */
export function bundleOf(path: string): { root: string; type: BundleType; inner: string } | null {
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    const type = bundleTypeOf(parts[i] as string);
    if (!type) continue;
    return {
      root: parts.slice(0, i + 1).join("/"),
      type,
      inner: parts.slice(i + 1).join("/"),
    };
  }
  return null;
}

/**
 * Where a path inside a bundle sits, for an expandable type: `member` for
 * anything under a member folder (`docs/01-arrival.md`, `docs/drafts/`),
 * `member-folder` for a member folder itself (`docs`), `own` for anything else
 * inside (the main file, `info.json`, `audio/…`): the type's own files. Null
 * for a path in no bundle, for the bundle's folder itself, and for any path
 * in a bundle whose type does not expand. By name alone.
 */
export function bundlePlace(path: string): "member" | "member-folder" | "own" | null {
  const b = bundleOf(path.endsWith("/") ? path.slice(0, -1) : path);
  if (!b || b.inner === "" || !b.type.expand) return null;
  for (const m of b.type.expand.members) {
    if (b.inner === m) return "member-folder";
    if (b.inner.startsWith(`${m}/`)) return "member";
  }
  return "own";
}

/** Whether `path` is inside one of its bundle's member folders: a file there is an ordinary document. */
export function isBundleMember(path: string): boolean {
  return bundlePlace(path) === "member";
}

/**
 * Whether `dir` is a folder things may be written into although it is in a
 * bundle: a member folder, or a folder under one. By name alone.
 */
export function isMemberDir(dir: string): boolean {
  const place = bundlePlace(dir);
  return place === "member" || place === "member-folder";
}

/** Whether `path` is a bundle's main file (`x.canvasbundle/board.canvas`), by name. */
export function isBundleMain(path: string): boolean {
  const b = bundleOf(path);
  return b !== null && b.inner === b.type.main;
}

/**
 * The bundle whose main file `path` is, when its type reads references: its
 * folder, its type and the type's `references`. Null for any other path. By
 * name alone: the disk is not asked.
 */
export function referencingBundle(
  path: string,
): { root: string; type: BundleType; references: BundleReferences } | null {
  const b = bundleOf(path);
  if (!b || b.inner !== b.type.main || !b.type.references) return null;
  return { root: b.root, type: b.type, references: b.type.references };
}

/** The main file of a registered type, by its name alone (`board.canvas`), or null. */
export function bundleTypeOfMain(name: string): BundleType | null {
  const base = lastSegment(name);
  for (const t of registry.values()) if (t.main === base) return t;
  return null;
}

/** A bundle folder's name without its extension: `The well` for `The well.canvasbundle`. */
export function bundleStem(name: string): string {
  const base = lastSegment(name);
  const type = bundleTypeOf(base);
  return type ? base.slice(0, base.length - type.extension.length) : base;
}

// ── info.json ──────────────────────────────────────────────────────────────

/** The file beside the main one that names a bundle. */
export const BUNDLE_INFO = "info.json";

/** The version of `info.json` the kit writes. */
export const BUNDLE_INFO_VERSION = 1;

/**
 * `info.json`, as the kit reads it. Every key the kit does not know is kept as
 * it was when the file is written again (`writeBundleInfo`).
 */
export type BundleInfo = {
  version?: number;
  type?: string;
  title?: string;
  description?: string;
  [key: string]: unknown;
};

/** `info.json`'s text read, or null when it is not a JSON object. */
export function parseBundleInfo(text: string): BundleInfo | null {
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as BundleInfo) : null;
  } catch {
    return null;
  }
}

/** A new bundle's `info.json` text. */
export function newBundleInfo(type: BundleType, title: string): string {
  return `${JSON.stringify({ version: BUNDLE_INFO_VERSION, type: type.type, title }, null, 2)}\n`;
}

/**
 * `info.json` written again with `changes` applied: every other key kept as it
 * was, in its place, and `version` and `type` filled in when they were
 * missing. A key set to `undefined` is removed.
 */
export function writeBundleInfo(
  prev: BundleInfo | null,
  type: BundleType,
  changes: Partial<BundleInfo>,
): string {
  const next: BundleInfo = { ...(prev ?? {}) };
  if (next.version === undefined) next.version = BUNDLE_INFO_VERSION;
  if (next.type === undefined) next.type = type.type;
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** A bundle's name as a row shows it: its title, or its folder's name without the extension. */
export function bundleDisplayName(folderName: string, title: string | undefined): string {
  const t = title?.trim();
  return t ? t : bundleStem(folderName);
}

/**
 * Where links are, as a sentence says it: "2 documents", or, with a bundle's
 * references among them (a board's cards), "1 document and 1 board", each
 * bundle by its type's noun.
 */
export function linkPlacesText(places: readonly { noun?: string }[]): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const docs = places.filter((p) => !p.noun).length;
  const nouns = new Map<string, number>();
  for (const p of places) if (p.noun) nouns.set(p.noun, (nouns.get(p.noun) ?? 0) + 1);
  const parts = [
    ...(docs > 0 || nouns.size === 0 ? [plural(docs, "document")] : []),
    ...[...nouns].map(([noun, n]) => plural(n, noun)),
  ];
  return parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
    : (parts[0] as string);
}
