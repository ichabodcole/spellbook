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
 * ⚠ `membership` IS NOT A FILE/FOLDER DISCRIMINANT, and the difference is the
 * whole point of E15. It answers one question the watcher must ask — "a new
 * file appeared under this root: is it mine?" — and it does not change when a
 * single document is later promoted into a structured set: promotion adds
 * nodes (and creates their real folders and files) to a `listed` entry, and
 * nothing already written has to be rewritten. `mirrored` = everything under
 * the root that is a document; `listed` = exactly the nodes written down.
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
};

export type FsListEntry = { name: string; path: string; dir: boolean };

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
  | { type: "fs.list"; path: string };

/** Daemon → surface, over the WebSocket. */
export type ServerMsg =
  | { type: "state"; state: PublicState }
  | { type: "version.text"; doc: string; version: number; text: string; origin: "load" | "remote" }
  | { type: "fs.list"; path: string; entries: FsListEntry[]; error?: string }
  | { type: "error"; message: string };

/** Agent → daemon, over `POST /cmd` (the CLI's verbs). */
export type AgentCmd =
  | { type: "context.add"; paths: string[] }
  | { type: "version.new"; doc?: string; from?: number; label?: string }
  | { type: "say"; text: string }
  | { type: "activate"; doc?: string; version: number }
  | { type: "close" };
