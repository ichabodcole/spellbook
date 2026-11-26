/**
 * The context: its nodes and entries, the structure changes made to it, and the
 * folder listing. Part of the wire vocabulary (`../protocol.ts`); types only.
 */

import type { BundleWarning } from "../../lib/bundles.ts";

// ── context ───────────────────────────────────────────────────────────────

/** A node in an entry's tree. `rel` is POSIX-relative to the entry's root. */
export type ContextNode =
  /**
   * `sidecar`: an image's description (`fox.png.md` beside `fox.png`, its name
   * cased exactly, whose frontmatter says `type: image`). The surface folds it
   * into the image's row, and rename, move and Trash of the image carry it. A
   * document only NAMED like one (`type: location`) is never marked.
   */
  | { kind: "doc"; rel: string; sidecar?: true }
  /**
   * An image file (`IMAGE_EXTENSIONS`). Not a document: it is never opened as
   * text, versioned, searched or linked. A mirrored entry shows the images in
   * its folder; a listed entry may hold a single image (a loose image) and
   * shows only that file, never its siblings.
   */
  | { kind: "image"; rel: string }
  /**
   * A bundle (`lib/bundles.ts`): a folder of a registered type, shown as one
   * item and never as a folder. `rel` is the folder's; `main` is the name of
   * the file inside that opens (`board.canvas`), and `type` the registered
   * type's (`"canvas"`). `title` and `description` are `info.json`'s, when it
   * has them. Its main file is a document to everything that walks documents
   * (`docPaths`): it opens, is versioned and is searched.
   *
   * A bundle of a type that declares `expand` also carries `contents`: its
   * real files, as nodes under its row (rels from the entry's root, like any
   * node's). A member folder's files are `doc` and `image` nodes like a set's,
   * walked by everything that walks documents; everything else inside is a
   * `group` or a `file`, which nothing walks. `warnings` are what the type's
   * `validate` said of the listing. A bundle of any other type has neither.
   */
  | {
      kind: "bundle";
      rel: string;
      type: string;
      main: string;
      title?: string;
      description?: string;
      contents?: ContextNode[];
      /** The read of `contents` stopped at its cap: there are more files than shown. */
      truncated?: true;
      warnings?: BundleWarning[];
    }
  /**
   * A folder. `link`: it is a symbolic link to a folder, shown and never
   * entered (its `children` are always empty): nothing is made in, moved into
   * or dropped on it, and the way to its files is to add it as a set of its
   * own. `linkTo` is where it leads (its realpath, absolute). A surface that
   * ignores both still works: it shows an empty folder the daemon refuses
   * writes into.
   */
  | { kind: "group"; rel: string; children: ContextNode[]; link?: true; linkTo?: string }
  /**
   * A file inside an expandable bundle that is not a document of its own: the
   * type's main file and `info.json` (`convention`, drawn dimmed), and
   * anything outside its member folders (`audio/…`). Only ever inside a
   * bundle's `contents`. Shown, never opened as a document by the walkers,
   * and never written by a structure act. `size` is in bytes.
   */
  | { kind: "file"; rel: string; size?: number; convention?: true };

export type Membership = "mirrored" | "listed";

export type ContextEntry = {
  id: string;
  label: string;
  /** An absolute directory on disk. */
  root: string;
  membership: Membership;
  nodes: ContextNode[];
  /**
   * The root's realpath as it was when the entry was added (or moved here by
   * the session). The image routes compare against this, never a fresh
   * resolve, so a symlinked folder retargeted later leads nowhere new. Absent
   * only in a manifest written before it existed, which restore fills in.
   */
  realRoot?: string;
  /** Set when a mirrored scan stopped at its node cap: said, not silent. */
  truncated?: boolean;
};

// ── structure ─────────────────────────────────────────────────────────────

/**
 * Structure changes: one vocabulary for both parties. The surface sends these
 * over the WebSocket (menus, drag and drop), the agent posts them through the
 * CLI's verbs, and the daemon makes the same real change on disk either way.
 * Every path is absolute. A destination folder must be a mirrored entry's root,
 * a folder under one, or the workspace.
 *
 * Nothing here deletes a file, and the agent has no verb that does. Moving a
 * document or folder to the Trash is the human's act alone (`trash`, a client
 * op, behind a dialog that names what goes), like Save and Revert: a deletion
 * is the one structure change an undo cannot take back, and the Trash, which is
 * the way back, belongs to the human's desktop rather than to the session. The
 * agent can ask the human to delete something. "Human-only" is a convention of
 * the surface, as it is for `save`: the agent's CLI has no command for it, but
 * the WebSocket does not authenticate who sends a frame.
 */
export type StructureOp =
  /**
   * A new document in `dir`; `name` defaults to a free "Untitled.md". `text`
   * is what it starts with (empty without one). `free`: when `name` is taken,
   * the next free one (`Name 2.md`) rather than a refusal. `stay`: the maker
   * stays where it is (a board promoting a note card), so the new document is
   * neither opened nor put in rename mode; `structure.done` says so.
   */
  | {
      op: "doc.create";
      dir: string;
      name?: string;
      text?: string;
      free?: boolean;
      stay?: boolean;
    }
  | { op: "folder.create"; dir: string; name?: string }
  /**
   * A new, empty bundle of the registered type `extension` names (the first
   * registered type when absent) in `dir`; `name` defaults to a free
   * "Untitled". Never inside another bundle. `stay: "rename"`: the maker
   * stays where it is (a board making a board inside it), so the new bundle
   * is not opened, but its row is put in rename mode for the human to name.
   */
  | {
      op: "bundle.create";
      dir: string;
      extension?: string;
      name?: string;
      stay?: "rename";
    }
  /**
   * A copy of a document or a bundle beside it, named as Finder names one
   * (`The well copy.canvasbundle`, then `… copy 2`): a bundle is copied whole.
   */
  | { op: "duplicate"; path: string }
  /**
   * `updateLinks`: rewrite the links the move breaks in the same act, rather
   * than offering it afterwards (`relink`).
   */
  | { op: "move"; path: string; into: string; updateLinks?: boolean }
  | { op: "rename"; path: string; name: string; updateLinks?: boolean }
  /** A copy of a dropped file's text, written into `dir` (a set, or a folder in one) or, without one, the workspace folder. */
  | { op: "import"; name: string; text: string; dir?: string }
  /** Point the workspace at an existing folder. */
  | { op: "workspace.set"; path: string }
  /**
   * A document listed on its own becomes a set: a folder named for it beside
   * it, the document moved in, the same entry (by id) now mirroring the folder.
   * Links the move breaks are reported (`broken`) and offered, as a move's are
   * (`relink`).
   */
  | { op: "set.make"; path: string }
  /**
   * A new, empty folder at `path`, a full path: a folder where a set shows
   * one, else, anywhere on disk whose parent exists, a new set in the context.
   */
  | { op: "folder.add"; path: string };

export type StructureOpName = StructureOp["op"];

export type FsListEntry = { name: string; path: string; dir: boolean };

/** What a move to the Trash would take: asked before the dialog, so it can name it. */
export type TrashPreview = {
  path: string;
  /** How it reads in the chat (`set/rel`). */
  shown: string;
  dir: boolean;
  /** It is a symbolic link: the link goes to the Trash, not what it points at. */
  link?: true;
  /** Files under it, every kind, itself included for a document. */
  files: number;
  /** Folders under it, not counting itself. */
  folders: number;
  /** The count stopped at the cap: there are at least this many. */
  truncated?: true;
  /**
   * Documents the session holds under it. Their records and versions stay in the
   * session (the files go to the Trash), so the dialog warns about what exists
   * only here: unsaved edits, and versions the file on disk never had.
   */
  docs: { slug: string; name: string; unsaved: boolean; versions: number; open: boolean }[];
  /** An image's description goes to the Trash with it: the sidecar's absolute path. */
  sidecar?: string;
  /** A bundle goes whole: its type's label ("canvas") and the name its row shows. */
  bundle?: { label: string; name: string };
};
