/**
 * scriptorium's wire vocabulary — the types the daemon, the CLI and the surface
 * all speak. TYPE-ONLY and import-free, so the surface can `import type` it
 * without dragging a byte of the daemon into its bundle, and the CLI can read
 * the same shapes without dragging the server graph into `dist/cli.js`.
 *
 * ── THE CONTEXT MODEL (E15) ─────────────────────────────────────────────────
 *
 * ONE type for "a single document" and "a folder": a `ContextEntry` is a root
 * directory plus a tree of `doc` / `group` nodes, and a group is a real
 * directory under the root. A folder entry is rooted at the folder and its
 * nodes mirror the directory; a single-file entry is rooted at the file's
 * parent and holds exactly that one doc node — not its siblings. The surface
 * renders an entry holding one doc as a document and anything else as a tree;
 * that is a rendering choice, not a second type.
 *
 * `membership` answers the one question the watcher must ask — "a new file
 * appeared under this root: is it mine?" `mirrored` = everything under the root
 * that is a document (less what the human hid); `listed` = exactly the nodes
 * written down, which in practice is ONE document. E22 settled what promotion
 * is: a set is a real folder, so "turn into a set" makes the folder, moves the
 * document into it, and the entry becomes a `mirrored` entry rooted there —
 * same id, so nothing that named the entry breaks.
 *
 * ⚠ NODE ORDER CARRIES NO MEANING (E17). There is no manual order anywhere:
 * the surface sorts children for display (by name, or by last-updated). The
 * arrays below happen to come out name-sorted from a scan; nothing may rely
 * on that, and nothing may write an order into the manifest.
 */

/** A node in an entry's tree. `rel` is POSIX-relative to the entry's root. */
export type ContextNode =
  | { kind: "doc"; rel: string }
  | { kind: "group"; rel: string; children: ContextNode[] };

export type Membership = "mirrored" | "listed";

export type ContextEntry = {
  id: string;
  label: string;
  /** An absolute directory on disk. */
  root: string;
  membership: Membership;
  nodes: ContextNode[];
  /** Set when a mirrored scan stopped at its node cap — said, not silent. */
  truncated?: boolean;
  /**
   * Mirrored only: rels the human took out of Scriptorium ("Remove from
   * Scriptorium", E24). The files stay on disk; the mirror skips them, and a
   * hidden folder hides everything under it.
   */
  hidden?: string[];
};

export type VersionAuthor = "human" | "agent";

export type Version = {
  n: number;
  label?: string;
  author: VersionAuthor;
  /** The version it was copied from (absent for v1, which comes from the original). */
  from?: number;
  createdAt: number;
  /** Absolute path of this version's file in the session folder. */
  path: string;
};

export type DocView = {
  /** The doc's id within the session — also its folder name under `docs/`. */
  slug: string;
  name: string;
  /** Absolute path of the file of record (E1). Written ONLY by Save (E7). */
  original: string;
  entryId: string | null;
  rel: string | null;
  versions: Version[];
  active: number;
  /** The active version differs from the original on disk. */
  dirty: boolean;
  /** The original changed on disk while the buffer was dirty — asked, not merged. */
  outsideChanged: boolean;
};

/** What the human has selected — rides every message they send (E5/E11). */
export type Selection = {
  doc: string;
  version: number;
  path: string;
  fromLine: number;
  toLine: number;
  text: string;
};

export type ChatWho = "human" | "agent" | "system";

export type ChatMessage = {
  id: string;
  who: ChatWho;
  text: string;
  ts: number;
  selection?: Selection | null;
  /** The active version's path at send time — so the agent knows what to read. */
  activePath?: string | null;
};

/** The snapshot the surface renders and `state --full` prints. */
export type PublicState = {
  sessionId: string;
  home: string;
  mode: "dev" | "release";
  context: ContextEntry[];
  docs: DocView[];
  openDoc: string | null;
  selection: Selection | null;
  chat: ChatMessage[];
  /**
   * Per-viewer conveniences (pane sizes, …), kept in `$SCRIPTORIUM_HOME/prefs.json`
   * rather than the browser's storage: every session is a new port, and browser
   * storage is keyed by origin — port included — so sizes kept there reset at
   * every `open` (slice-A journal finding). String values only; the surface owns
   * their meaning.
   */
  prefs: Record<string, string>;
  /** The user's home directory, so the surface can show `~/notes` for a path. */
  userHome: string;
  /**
   * The session's WORKSPACE (E23): where a dropped file is copied and a new
   * top-level document or set is made. Defaults to the directory `open` ran
   * in; either party can change it.
   */
  workspace: string;
};

/**
 * Structure changes (E24) — ONE vocabulary for both parties: the surface sends
 * these over the WebSocket (menus, drag and drop), the agent posts them through
 * the CLI's verbs, and the daemon does the same real change on disk either way.
 * Every path is ABSOLUTE. A folder named as a destination must be a context
 * folder (a mirrored entry's root, or a folder under it) or the workspace.
 * Nothing here deletes a file: `hide` takes a node out of Scriptorium only.
 */
export type StructureOp =
  /** A new empty document in `dir`; `name` defaults to a free "Untitled.md". */
  | { type: "doc.create"; dir: string; name?: string }
  /** A new folder in `dir`; in the workspace it becomes a new set. */
  | { type: "folder.create"; dir: string; name?: string }
  | { type: "move"; path: string; into: string }
  | { type: "rename"; path: string; name: string }
  | { type: "hide"; path: string }
  /** Bring back everything hidden in a mirrored entry. */
  | { type: "unhide"; entry: string }
  /** A single document becomes a set: a folder named for it, the document moved in (E22). */
  | { type: "set.make"; path: string }
  /** A COPY of a file's text, written into `into` (default: the workspace) — E23's drop. */
  | { type: "import"; name: string; text: string; into?: string }
  | { type: "workspace.set"; path: string };

export type StructureOpType = StructureOp["type"];

export type FsListEntry = { name: string; path: string; dir: boolean };

/**
 * What a move WOULD do, asked before a folder is moved (E26). The surface
 * confirms a folder move in these terms; the git facts are the daemon's,
 * because only it can look at the disk.
 */
export type MovePlan = {
  from: string;
  into: string;
  /** The moved thing's own name. */
  name: string;
  folder: boolean;
  /** Documents that would move with it (1 for a document). */
  docs: number;
  /** The git working tree the source is in, by its folder name — null if none. */
  repo: string | null;
  /** The source is in a git working tree and the destination is not in the same one. */
  leavesRepo: boolean;
};

/** Surface → daemon, over the WebSocket. */
export type ClientMsg =
  | { type: "open"; path: string }
  | { type: "open.doc"; doc: string }
  | { type: "edit"; doc: string; version: number; text: string }
  | { type: "select"; selection: Selection | null }
  | { type: "say"; text: string; withSelection: boolean }
  | { type: "activate"; doc: string; version: number }
  | { type: "save"; doc: string }
  | { type: "revert"; doc: string }
  | { type: "context.add"; path: string }
  | { type: "context.remove"; id: string }
  | { type: "fs.list"; path: string }
  /** Load a version's text into the surface (answered with `version.text`, origin "load"). */
  | { type: "read"; doc: string; version: number }
  /** What would a move do? Answered with `move.plan`; changes nothing (E26). */
  | { type: "move.plan"; path: string; into: string }
  | { type: "prefs.set"; key: string; value: string }
  /** Show a context item in the OS file manager (Finder's "Reveal"). The human's affordance; changes nothing. */
  | { type: "reveal"; path: string }
  /**
   * Open the OS's own file picker and act on what comes back: add it to the
   * context, or make a folder the workspace. The daemon is a local process, so
   * it gets a real PATH — which a browser picker never gives (E23's note).
   */
  | { type: "pick"; want: "context-file" | "context-folder" | "workspace" }
  | StructureOp;

/** Daemon → surface, over the WebSocket. */
export type ServerMsg =
  | { type: "state"; state: PublicState }
  | { type: "version.text"; doc: string; version: number; text: string; origin: "load" | "remote" }
  | { type: "fs.list"; path: string; entries: FsListEntry[]; error?: string }
  | { type: "move.plan"; path: string; into: string; plan?: MovePlan; error?: string }
  /** To the sender only: a structure op landed, at `path` — so the surface can open or rename it. */
  | { type: "structure.done"; op: StructureOpType; path: string }
  | { type: "error"; message: string };

/** Agent → daemon, over `POST /cmd` (the CLI's verbs). */
export type AgentCmd =
  | { type: "context.add"; paths: string[] }
  | { type: "version.new"; doc?: string; from?: number; label?: string }
  | { type: "say"; text: string }
  | { type: "activate"; doc?: string; version: number }
  | { type: "close" }
  | StructureOp;
