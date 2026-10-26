/**
 * The workspace's wire vocabulary: the types the daemon, the CLI and the
 * surface all speak. Type-only: it imports nothing but types, so a surface can `import type`
 * it without pulling any of the daemon into its bundle, and the CLI can read
 * the same shapes without pulling in the server.
 *
 * Naming rules, settled once for every workspace:
 *
 * - `from` names a speaker (on a message); `by` names an author (on a version,
 *   a note and a task). Two words, each meaning one thing.
 * - WebSocket frames, and the commands posted to `/cmd`, use `op` as their
 *   discriminant, so the `type` on a message never collides with the wire.
 *   Event-log frames keep `type`, like the `tail.*` control lines.
 * - Every timestamp is an ISO 8601 string.
 *
 * The context model: one type for "a single document" and "a folder". A
 * `ContextEntry` is a root directory plus a tree of `doc` and `group` nodes,
 * and a group is a real directory under the root. A folder entry is rooted at
 * the folder and its nodes mirror the directory; a single-file entry is rooted
 * at the file's parent and holds exactly that one doc node, not its siblings.
 * `membership` answers the one question the watcher must ask, "a new file
 * appeared under this root: is it mine?": `mirrored` is everything under the
 * root that is a document, `listed` is exactly the nodes written down.
 *
 * Node order carries no meaning. A scan happens to return name-sorted arrays;
 * nothing may rely on that, and nothing may write an order into the manifest.
 */

import type { BundleWarning } from "../lib/bundles.ts";
import type { KindPairUse, KindUse } from "../lib/relationUse.ts";
import type { ImageDescription, ImageSource } from "../lib/sidecar.ts";
import type { ClosedBy } from "./events";
import type { LinkKind, LinkOrigin, RelationUse, Resolution } from "./links";

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

// ── comparing and merging ─────────────────────────────────────────────────
//
// The engine lives in `diff.ts`; the shapes live here because the surface
// renders exactly what the daemon computed. There is no second diff
// implementation to disagree with the first, so a hunk the human accepts is the
// hunk the merge applies.

/** What happened to one line between the two sides. */
export type DiffOp = "same" | "add" | "del";

/** A run within a refined line: `changed` marks what differs from its pair. */
export type DiffSpan = { text: string; changed: boolean };

export type DiffLine = {
  op: DiffOp;
  /** 0-based index in the LEFT text, when the line is present there. */
  a?: number;
  /** 0-based index in the RIGHT text, when the line is present there. */
  b?: number;
  text: string;
  /** Word-level refinement, only on lines the engine could pair. */
  spans?: DiffSpan[];
};

/**
 * One contiguous difference: the left's `[aFrom, aTo)` lines become the
 * right's `[bFrom, bTo)`. A pure insertion has `aFrom === aTo`; a pure
 * deletion has `bFrom === bTo`.
 */
export type DiffHunk = {
  id: number;
  aFrom: number;
  aTo: number;
  bFrom: number;
  bTo: number;
  del: string[];
  add: string[];
};

export type Diff = {
  lines: DiffLine[];
  hunks: DiffHunk[];
  /** The two texts are identical. */
  same: boolean;
  /** The line diff gave up; the whole difference is ONE hunk, and it says so. */
  coarse: boolean;
};

/** What a comparison can be against: another version, or the file of record. */
export type DiffSide = number | "original";

/**
 * The left side is always the active version. That is a rule, not a default:
 * the active version is the only one the human writes, so making it the left
 * side of every comparison means a merge always has exactly one legal
 * destination. Comparing two versions neither of which is active would be
 * readable and un-mergeable, so the shape does not offer it.
 */
export type DiffPayload = {
  doc: string;
  active: number;
  against: DiffSide;
  diff: Diff;
};

/**
 * Where the agent pointed the human's view (`show`): a change in the comparison
 * of the active version against `against`, by its hunk id, or a passage of the
 * active version, by its offsets. The daemon has already checked it is there.
 */
export type ShowTarget =
  | { doc: string; version: number; hunk: number; against: DiffSide }
  | { doc: string; version: number; from: number; to: number; quote: string };

// ── authors and speakers ──────────────────────────────────────────────────

/** Who wrote a version or a note. */
export type Author = "human" | "agent";

/** Who created a task. The daemon creates the tasks it runs itself. */
export type TaskAuthor = "human" | "agent" | "daemon";

/** Who is speaking in the chat. */
export type Speaker = "human" | "agent" | "system";

// ── versions, notes, documents ────────────────────────────────────────────

export type Version = {
  n: number;
  label?: string;
  by: Author;
  /** The version it was copied from (absent for v1, which comes from the original). */
  fromVersion?: number;
  createdAt: string;
  /**
   * Set once it has been the active version (activated, or the active one
   * when another was activated). Absent for a version never active since the
   * kit began recording it: what makes an agent's version a PROPOSAL the link
   * check reads (`LinkCheck.proposed`).
   */
  activated?: true;
  /**
   * Kept from an outside write to the active version (a write the kit did not
   * make), filed as the agent's: not a proposal the link check reads.
   */
  outside?: true;
};

/** How a note found its place in the current text; see `anchors.ts`. */
export type NoteHow = "context" | "unique" | "nearest" | "orphaned";

/** A note as it is stored: the text it was made on, never an offset. */
export type Note = {
  id: string;
  /** The version it was made on: provenance. It is not what anchors it. */
  version: number;
  quote: string;
  /** The text just before and after the quote when it was made. */
  before: string;
  after: string;
  /** Where it was then: a hint for choosing between identical quotes. */
  at: number;
  body: string;
  by: Author;
  createdAt: string;
  /** When the body was last rewritten; absent if it never was. */
  editedAt?: string;
  /**
   * Who rewrote it then: what tells a human's rewrite, which is owed an answer
   * again, from the agent's, which is one (`notesWaiting`).
   */
  editedBy?: Author;
  /**
   * What the note said before the agent rewrote it, kept so the human can see it
   * and put it back. Absent when the agent never rewrote it, or the human has
   * rewritten it since.
   */
  replacedBody?: string;
  /** When it was last put back after being resolved; absent if it never was. */
  reopenedAt?: string;
  /** Who put it back: the human reopening asks again; the agent reopening is an act on it. */
  reopenedBy?: Author;
  resolved: boolean;
  resolvedAt?: string;
};

/**
 * A note placed in the active version's text as it stands right now. The
 * offsets and the lines are derived on every read and never stored.
 */
export type PlacedNote = Note & {
  from: number | null;
  to: number | null;
  how: NoteHow;
  fromLine: number | null;
  toLine: number | null;
};

/** A document as the manifest stores it. */
export type Doc = {
  /** Unique within the session; also the folder name under `docs/`. */
  slug: string;
  name: string;
  /** Absolute path of the file of record. Written only by Save. */
  original: string;
  entryId: string | null;
  rel: string | null;
  ext: string;
  versions: Version[];
  active: number;
  /** The next version number to hand out. Monotonic, never derived from what is present. */
  nextVersion: number;
  notes: Note[];
  /** Hash of the original as we last read or wrote it, so a restore can tell it changed. */
  originalHash: string;
  /** Set only when a document-type file inside a context entry was opened; Save writes no other original. */
  admitted: boolean;
  outsideChanged: boolean;
  /**
   * The original is gone from disk: deleted or moved away outside the app, or
   * moved to the Trash from the sidebar. The record and its versions stay, so
   * the text is not lost; Save recreates the file only when asked to.
   */
  missing?: boolean;
};

export type VersionView = Version & {
  /** Absolute path of this version's file in the session folder. */
  path: string;
};

export type DocView = {
  slug: string;
  /**
   * A second slug this document answers to (`--doc`), when it has one: a
   * bundle's main file, opened under one name and its bundle renamed since,
   * answers to the slug of the bundle's name now as well as to `slug`, which
   * never changes while the session holds it (its versions are filed under
   * it). Absent when the two are the same, or another document holds it.
   */
  alias?: string;
  name: string;
  original: string;
  entryId: string | null;
  rel: string | null;
  ext: string;
  versions: VersionView[];
  active: number;
  /** Derived: the hash of the active version's current text. */
  hash: string;
  /** The active version differs from the original on disk. False while the original is missing. */
  dirty: boolean;
  /** The original changed on disk while the buffer was dirty (or while no daemon watched). */
  outsideChanged: boolean;
  /**
   * Absent while the original is on disk. `file`: the file is gone and its folder
   * is still there. `folder`: the folder went too. Save recreates the file only
   * with `recreate`, and the folder only with `recreate: "folder"`.
   */
  missing?: "file" | "folder";
  /** Notes, placed against the active version's text on every snapshot. */
  notes: PlacedNote[];
};

// ── chat ──────────────────────────────────────────────────────────────────

/**
 * Something a message draws on beside its one subject: a document or an image
 * selected in the file tree with it, or added as a reference. What it is for is
 * its `role` (`KIT_REF_ROLES` and the app's own; absent, `"reference"`).
 */
export type MessageRef = {
  /** Absolute: what the agent reads. */
  path: string;
  doc?: string;
  version?: number;
  role?: string;
  /** Its name as the human saw it. */
  label?: string;
  /** A passage of it, when the gesture carried one. */
  text?: string;
};

/**
 * What a message concerns: ONE subject (a text selection, else the active
 * document or image, or an app's own part such as a selected canvas card), and
 * the `refs` it draws on besides.
 */
export type MessageAbout = {
  doc?: string;
  version?: number;
  /** Absolute path of the version's file (or of the image), so the agent knows what to read. */
  path?: string;
  fromLine?: number;
  toLine?: number;
  /** The selected text. */
  text?: string;
  /**
   * Whole documents pointed at (absolute paths), on a message from before
   * `refs`: no longer written. An old message that carries it reads as it did;
   * a new one has one subject, and what else it points at is in `refs`.
   */
  docs?: string[];
  noteId?: string;
  /** What the message draws on beside its subject: never the subject itself, each path once. */
  refs?: MessageRef[];
};

/**
 * A message's `about` as it is stored and as the agent's tail carries it: the
 * kit's parts, and any part the app adds from what the sending page shows
 * (`hooks.messageAbout`), such as Atlas's `map`. The chip names an app's part
 * only through the app's own labeller (`ChatSidebar`'s `aboutPart`).
 */
export type MessageAboutOnTail = MessageAbout & { [part: string]: unknown };

export type MessageType = "message" | "info" | "result";

export type Message = {
  id: string;
  from: Speaker;
  /** The display axis: a spoken message, a system line, or the outcome of work. */
  type: MessageType;
  text: string;
  about?: MessageAboutOnTail;
  /**
   * The gesture it came through (`KIT_VIA` and the app's own): the composer is
   * `"chat"`, an app's button its own value. Absent on a message from before
   * the field, which reads as `"chat"` (`messageVia`).
   */
  via?: string;
  ts: string;
};

/** What the human has selected. Rides a message as `about`. */
export type Selection = {
  doc: string;
  version: number;
  path: string;
  fromLine: number;
  toLine: number;
  text: string;
};

/**
 * The human is waiting on an answer, and how that should read. `working` is a
 * pulse; `stalled` is static and says so in words, because a pulse over a
 * wedged agent is false liveness.
 */
export type Waiting = {
  messageId: string;
  since: string;
  badge: "working" | "stalled";
  /** The agent said it is still working (`working`) and the snooze holds. */
  acknowledged?: true;
};

/**
 * A note the human wrote that the agent has not answered: `Waiting`, for a
 * note, with the same two badges and the same rule (`stalled` is static).
 * Derived by the daemon from the notes and the conversation (`notesWaiting` in
 * `waiting.ts`). Nothing stores it, so a reload or a restart derives it again.
 */
export type NoteWaiting = {
  doc: string;
  noteId: string;
  /** When the human last put the note in front of the agent: made, rewrote or reopened it. */
  since: string;
  badge: Waiting["badge"];
  /** The agent's "still working" snooze holds: it covers notes as it covers messages. */
  acknowledged?: true;
};

// ── tasks ─────────────────────────────────────────────────────────────────

export type TaskStatus = "open" | "running" | "done" | "failed" | "cancelled";

export type Task = {
  id: string;
  title: string;
  by: TaskAuthor;
  status: TaskStatus;
  /** What runs it, for the daemon's runner registry; apps name their own (`"render"`). */
  kind?: string;
  /** The chat message that created it, when it was made through chat. */
  messageId?: string;
  /** The task this one is delegated from. */
  parent?: string;
  /**
   * One of many children whose parent speaks for them (a batch's renders): it
   * settles with no chat line and no toast of its own. Its events still go on
   * the log.
   */
  quiet?: true;
  detail?: string;
  outcome?: string;
  createdAt: string;
  updatedAt: string;
};

/** A task as the snapshot shows it: `progress` (0 to 1) is runtime-only. */
export type TaskView = Task & { progress?: number };

// ── the manifest ──────────────────────────────────────────────────────────

/**
 * The persisted session. `app` is the app's namespaced slot (Sound Stage keeps
 * `app.renders` there) and carries its own `version` for the app's migration
 * hook; everything else is the kit's, and `format` is the kit's to migrate.
 */
export type Session = {
  format: 1;
  sessionId: string;
  /**
   * The app that wrote this session (`AppDeclaration.name`). A restore refuses
   * another app's. Absent in a kit manifest older than it, and stamped on restore.
   */
  appName?: string;
  createdAt: string;
  /** Where dropped files and new top-level documents land. Absent in a manifest older than it. */
  workspace?: string;
  /**
   * The workspace-and-set overlap last said at startup (a session from before
   * the overlap block), so it is said once, not at every restore. Absent: none said.
   */
  overlapSaid?: string;
  context: ContextEntry[];
  docs: Doc[];
  openDoc: string | null;
  /**
   * The image the human has open in the centre's viewer, by absolute path, or
   * absent. Opening an image puts the open document aside (`openDoc` null), and
   * opening a document puts the image away: the centre shows one thing.
   */
  openImage?: string | null;
  /** The document the open image was opened over (a slug): Close brings it back. */
  docAside?: string | null;
  /**
   * Images written under another name than they came in with (converted to
   * WebP, or from HEIC), by absolute path: the name each came in with, for the
   * `original-name` of the description `describe-image` starts. Absent: none.
   */
  importedAs?: Record<string, string>;
  chat: Message[];
  tasks: Task[];
  app: Record<string, unknown> & { version: number };
  /**
   * Who ended this session, and when: set as the daemon closes, cleared by a
   * restore. A tail re-armed after the end finds no daemon to ask, and must
   * still say "the human ended it" (ported from the source editor). Absent: a
   * live session, or one whose daemon died without closing.
   */
  ended?: { by: ClosedBy; at: string };
};

/** The open image, as the surface shows it and the agent reads it in the snapshot. */
export type ImageView = {
  /** Absolute. */
  path: string;
  name: string;
  /** The entry that shows it, and where. */
  entryId: string;
  rel: string;
  /** Bytes on disk. */
  size: number;
  /** What the bytes are (not what the name says), or null when they are no image the viewer shows. */
  type: string | null;
  /** Changes whenever the file does: the viewer's cache key. */
  stamp: string;
  /**
   * Its description, read from its sidecar (`<name>.<ext>.md`, a document of
   * `type: image`) as the session holds it, when the context shows one. Absent:
   * no description yet.
   */
  description?: ImageDescription;
};

/**
 * An embed (`![alt](target)`) in a document, as the rendered view draws it: the
 * image, when the target lands on one this session shows and its bytes are an
 * image, or why not, in words. `target` is exactly what was asked about.
 */
export type EmbedView =
  | {
      target: string;
      state: "shown";
      /** Absolute: what the file route serves. */
      path: string;
      /** Changes whenever the file does: the image's cache key. */
      stamp: string;
      /** What the bytes are. */
      type: string;
      /**
       * Its pixel size, from its header, when the header says: what the page
       * reserves before the bytes arrive, so a lazy image below the fold stays
       * there and nothing shifts as it loads.
       */
      width?: number;
      height?: number;
    }
  | { target: string; state: "not-shown"; reason: string };

// ── history ───────────────────────────────────────────────────────────────

/**
 * What the context's undo arrows show. A hand-written mirror of
 * `history.ts`'s `HistoryView`, because this file imports nothing but types; `history.test.ts`
 * holds the two equal.
 */
export type HistoryView = {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  /**
   * Present when the next undo would delete: the surface confirms first.
   * `also`: further paths the same undo removes (an app's act that made several).
   */
  undoDeletes?: { path: string; dir: boolean; also?: string[] };
};

// ── links that follow a rename or move ─────────────────────────────────────

/** One link a rename or move broke, as written (`from`) and as it would be written to land again (`to`). */
export type LinkFix = {
  /** The 1-based line of the text it was read from (the active version, for a document the session holds). */
  line: number;
  label?: string;
  /** An embed (`![alt](x.png)`). */
  embed?: true;
  /** A bundle's reference (a card on a board): what holds it, by its id in the file. */
  id?: string;
  from: string;
  to: string;
};

/**
 * The broken links in one document: `path` is where it is now, `was` where it
 * was before the act. `noun` is set for a bundle's main file whose references
 * these are ("board"): its fixes are references, not markdown links.
 */
export type DocLinkFixes = { path: string; was: string; fixes: LinkFix[]; noun?: string };

/** A wiki link a rename or move broke: it names a page, so it is counted and named, never rewritten. */
export type WikiBreak = { path: string; line: number; raw: string };

/**
 * The links the last rename, move or `set.make` broke, offered for updating in
 * one act (`relink`). It lasts until the next change to the context's shape (another
 * structure act, an undo or a redo), or until either party answers it.
 */
export type RelinkOffer = {
  /** What moved, as the chat names it. */
  what: string;
  by: "human" | "agent";
  count: number;
  /** `noun` marks a bundle's references ("board"); `shown` is then the bundle's name. */
  docs: { path: string; shown: string; fixes: LinkFix[]; noun?: string }[];
  /** Wiki links it broke too, which cannot be updated. */
  wiki: (WikiBreak & { shown: string })[];
};

// ── the snapshot ──────────────────────────────────────────────────────────

/** The snapshot the surface renders (`GET /state`, and the WebSocket hello). */
export type PublicState = {
  app: string;
  /** The app's name as a human reads it, when it declared one; the surface falls back to `app`. */
  appTitle?: string;
  sessionId: string;
  dir: string;
  /**
   * The folder dropped files and new top-level documents land in. Absent for
   * an app with no home workspace (`AppDeclaration.homeWorkspace: false`):
   * there, a new file goes only where the caller points.
   */
  workspace?: string;
  mode: "dev" | "release";
  /**
   * Whether an agent is following the session: one of its tails is attached, or
   * one let go or it made a call recently (a re-arm, a turn after a `--once`
   * woke it). Derived by the daemon from the agent's CLI, never claimed. Optional
   * so an older snapshot still reads; absent means no news.
   */
  agentListening?: boolean;
  context: ContextEntry[];
  docs: DocView[];
  openDoc: string | null;
  /** The image open in the centre's viewer, or null. Optional so an older snapshot still reads. */
  openImage?: ImageView | null;
  selection: Selection | null;
  chat: Message[];
  /** Newest first, finished ones included; running ones carry `progress`. */
  tasks: TaskView[];
  /**
   * Whether the human is waiting on an answer, computed by the daemon because
   * that is where the clock is. Null when nobody is waiting.
   */
  waiting: Waiting | null;
  /**
   * Every note still owed an answer, across the session, oldest first: the same
   * derivation as `waiting`, for notes, computed in the same place. Optional so
   * an older snapshot still reads; absent means none.
   */
  notesWaiting?: NoteWaiting[];
  /** What the context's undo arrows should show. Not the editor's undo. */
  history: HistoryView;
  /** Links the last rename, move or `set.make` broke, offered for updating; absent when there are none. */
  relink?: RelinkOffer;
  /** Per-viewer conveniences kept beside the sessions, so a new port does not reset them. */
  prefs: Record<string, string>;
  /** The user's home directory, so the surface can show `~/notes` for a path. */
  userHome: string;
  /**
   * Whether this system has a native file picker the daemon can open (`pick`).
   * Where it has none (Windows, a Linux without zenity) the surface hides the
   * acts that open it. Optional so an older snapshot still reads; absent means none.
   */
  picker?: boolean;
  /**
   * How to run the app's CLI (`bun /abs/path/scripts/cli.ts`), when the app
   * declared one: what the surface prints in a command the human can copy.
   */
  launcher?: string;
  /** The app's own view, built by the app from its slot. Opaque to the kit. */
  appState: unknown;
};

/**
 * The state as a `state` frame carries it over the WebSocket. Either the app's
 * view is there in full (`appState`), or the frame says it is the same as the
 * last one this connection was sent (`appStateUnchanged: true`, and no
 * `appState` key). An app's view can be large (a frontmatter index of every
 * document), and most broadcasts do not change it.
 *
 * The marker is explicit, not a missing key, so "keep what you have" cannot be
 * read as "this app has no view" (`appState: null`) or as an older daemon's
 * frame. A connection's first frame always carries the view in full, so a new
 * socket (a reconnect) starts whole. A client folds frames with
 * `resolveAppState`; one that does not would lose the app's view on the first
 * marked frame, so the daemon and its client change together.
 *
 * `GET /state` (the agent's read) always carries the view in full.
 */
export type StateFrame = Omit<PublicState, "appState"> &
  ({ appState: unknown; appStateUnchanged?: never } | { appStateUnchanged: true });

/**
 * The whole state from a `state` frame and the state the client held before
 * it: a marked frame keeps the previous view. A marked frame with nothing to
 * keep (no previous state, or another session's) is a daemon that broke the
 * first-frame rule; it reads as no view (`null`) rather than another
 * session's.
 */
export function resolveAppState(prev: PublicState | null, next: StateFrame): PublicState {
  if (!("appStateUnchanged" in next) || next.appStateUnchanged !== true) return next as PublicState;
  const { appStateUnchanged: _, ...rest } = next;
  const kept = prev && prev.sessionId === next.sessionId ? prev.appState : null;
  return { ...rest, appState: kept } as PublicState;
}

/** What `GET /state` answers: the snapshot, plus the log's position and the chat's length. */
export type StateSnapshot = PublicState & {
  /** `chat` is the last ten messages unless `?full=1`; this is how many there are. */
  chatTotal: number;
  /** The open document at its active version, or null. */
  active: { doc: string; version: number; path: string | null } | null;
  /** The log's highest id: pass it as `since` to read what comes after. */
  cursor: number;
  /** The daemon run the cursor belongs to. */
  epoch: string;
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

// ── search ────────────────────────────────────────────────────────────────

/** What a result matched on. */
export type SearchKind = "name" | "text";

/** One result. Name results carry no position; text results carry all of it. */
export type SearchResult = {
  kind: SearchKind;
  /** The session's slug for the document, or null when it has not been opened. */
  slug: string | null;
  name: string;
  path: string;
  /** The active version that was searched, or null when the file on disk was read. */
  version: number | null;
  /** 1-based; text results only. */
  line?: number;
  /** 1-based, in characters of the line; text results only. */
  column?: number;
  /** Source offsets of the match, so a surface can select it; text results only. */
  from?: number;
  to?: number;
  /** The line the match is on, trimmed; a long line is windowed around the match with "…" at a cut end; text results only. */
  snippet?: string;
  /** Where the match is inside `snippet` (character offsets, `from` inclusive, `to` exclusive); text results only. */
  snippetFrom?: number;
  snippetTo?: number;
  /**
   * The match is in an image's description (its sidecar): the image's absolute
   * path, which is what a surface opens. The result's own `path` is the sidecar.
   */
  image?: string;
  /**
   * The match is in a bundle's main file, which the tree does not show: the
   * bundle, as its row names it. `path` is the main file, which opens.
   */
  bundle?: { path: string; name: string; label: string };
};

export type SearchReport = {
  query: string;
  /** Names first, best first; then text matches in document order. */
  results: SearchResult[];
  /** How many results are returned. */
  count: number;
  /** More matches existed than the limit allowed, so "3" and "3 of more" differ. */
  truncated: boolean;
};

// ── links ─────────────────────────────────────────────────────────────────

/** Where a link landed: `links.ts` says what each state means. */
export type LinkResolution = Resolution;

export type { RelationUse };

/**
 * Where a followed link's `#anchor` landed in the document it opened
 * (kit-heading-links-build), read by `findHeading` from the version opened.
 * `found` is absent when no heading matched: the document opens at the top and
 * the surface says which heading was not there.
 */
export type HeadingLanding = {
  /** The anchor as the link names it, decoded. */
  anchor: string;
  /** The document opened, and the version the offsets are in. */
  doc: string;
  version: number;
  found?: {
    /** The heading's text without its markup. */
    text: string;
    /** Its 1-based line, and the line's extent as offsets. */
    line: number;
    from: number;
    to: number;
    /** The anchor names several headings; this is the first. */
    ambiguous?: true;
  };
};

/** A heading the link picker offers, with the anchor a link to it is written with. */
export type HeadingOffer = {
  level: number;
  /** The heading's text without its markup. */
  text: string;
  line: number;
  /** What follows `#` in the link, encoded (`How%20lenses%20work#Stacking%20lenses` for a repeat). */
  anchor: string;
};

/** The headings of one document, for the link picker's second step. */
export type LinkHeadings = { path: string; headings: HeadingOffer[] };

/** A document a new link can point at, from the document the link is written in. */
export type LinkTarget = {
  /** The absolute path. */
  path: string;
  /** The file's name, with its extension. */
  name: string;
  /** The target to write: relative to the writing document's folder, encoded. */
  href: string;
  /** The path shown under the name: from the root of its context entry. */
  shown: string;
  /** An image the tree shows (kit-image-embeds): chosen, it is embedded unless words are being linked. */
  image?: true;
  /** An image's description, from its sidecar (its title and one-line description): matched as a name is. */
  description?: string;
  /** The document's kind (`kindOf`: its matched profile's, else its frontmatter `type`); absent for none and for an image. */
  kind?: string;
};

/**
 * A relation the link picker offers: one the world's links use (`count` of
 * them), one its vocabulary declares, or both. A declared one carries the
 * words its `_meta/profiles/_relations.json` gives it.
 */
export type RelationOffer = RelationUse & {
  /** Declared in the vocabulary in force for the document being written in. */
  declared: boolean;
  /** How it reads ("grounded in"). */
  label?: string;
  /** What it means: the picker's second line. */
  means?: string;
  /** It reads the same from both ends. */
  symmetric?: true;
  /** How it reads from the other end ("grounds"). */
  inverse?: string;
  /** The colour an app draws it in: a JSON Canvas preset ("1" to "6") or a hex. */
  color?: string;
};

/**
 * How the links into documents of one kind use one relation: `links` of them
 * in all, `fromKind` of those written in a document of the picker's own kind.
 * What the picker ranks relations by for the target in view.
 */
export type KindRelationUse = KindUse;

export type { KindPairUse };

/**
 * The relations in force at a path in the context (`relationsAt`), for an app
 * that types something between two documents other than a link written in one
 * (Atlas's board connections): what the link picker offers, with the
 * world's use of each relation between every pair of kinds, so the app ranks
 * them for any two ends (`kindUseFrom`, then `rankRelations`).
 */
export type RelationsAt = {
  /** Whether a vocabulary file is in force there. */
  vocabulary: boolean;
  /** As the link picker offers them: the relations in use and those declared. */
  relations: RelationOffer[];
  /** How the world's typed links use each relation, by the kinds at their two ends. */
  pairs: KindPairUse[];
  /** The nearest vocabulary file, usable or broken: where a new relation is proposed. Null with none. */
  file: string | null;
  /** Why the nearest file cannot be read, when it is broken. */
  broken?: string;
};

/**
 * What the link picker offers for document `doc`: every other document in the
 * session, and the relations: the `?rel=` values its documents already use,
 * most used first, and those the vocabulary in force declares. Read from the
 * link cache, so an open costs a stat per document, not a read of each.
 */
export type LinkTargets = {
  doc: string;
  /** The kind of the document being written in, or null. */
  kind: string | null;
  targets: LinkTarget[];
  relations: RelationOffer[];
  /** Whether a vocabulary file is in force for `doc`: without one, nothing is "not declared". */
  vocabulary: boolean;
  /** Each relation's use on links into each kind: the picker's ranking for the target in view. */
  byKind: KindRelationUse[];
};

/**
 * What a sidebar row dropped onto document `doc` writes there
 * (kit-tree-drag-into-document), one per path that writes or is refused, in the
 * order asked. An image in reach is embedded and a document linked (`image`
 * says which): `href` relative to the document and encoded as the link picker
 * writes it, `text` one line, unescaped: an image's sidecar title, a
 * document's title or first heading, else the file name without the
 * extension. Anything no relative path inside the document's own context
 * entry reaches is refused, in words. A path that writes nothing (a folder, an
 * image's description, the document itself) is left out.
 */
export type DroppedLink =
  | { path: string; image: boolean; href: string; text: string }
  | { path: string; refused: string };

/**
 * A link that lands on the document asked about, from another document in the
 * session. Read from the source's ACTIVE VERSION when the session holds it, so
 * an unsaved edit counts.
 */
export type BacklinkView = {
  /** The source document's absolute path. */
  source: string;
  /** Its file name, with its extension. */
  name: string;
  /** Its path from the root of its context entry. */
  shown: string;
  /** The 1-based line of the source file the link is on. */
  line: number;
  /** The target exactly as written: query, anchor and encoding kept. */
  raw: string;
  /** The `?rel=` relations; empty for a bare link, which asserts none. */
  rel: string[];
  kind: LinkKind;
  /** The link's text, when it has one (an embed's alt text). */
  label?: string;
  /** An embed (`![alt](x.png)`), which draws the image where it is written. */
  embed?: true;
  /** The line it is on, trimmed, cut to a window around the link when long. */
  context: string;
  /** Where the link sits in the source's active text, as offsets. */
  from: number;
  to: number;
};

/**
 * What links to a document. `relations` counts each relation once per link
 * that carries it (a link with two counts under both), most used first; `bare`
 * counts the links that carry none. `truncated` says the list was cut at its cap.
 */
export type Backlinks = {
  /** The document's slug when the session holds it, else null. */
  doc: string | null;
  path: string;
  count: number;
  backlinks: BacklinkView[];
  /**
   * `as` is how the relation reads from this end, when the vocabulary in force
   * for this document says: its declared inverse ("grounds" for
   * `grounded-in`), or for a symmetric relation its label ("contrasts with").
   */
  relations: (RelationUse & { as?: string })[];
  bare: number;
  /**
   * The bundles that reference the document (boards it is a card on), one
   * entry each, apart from `backlinks`: a board is not canon, so it is listed
   * under its own heading, "On the board The well". Not in `count`.
   */
  bundles: ReferenceBacklinkView[];
  /**
   * The app's edges that land on the document (kit-link-edges-slot), apart from
   * `backlinks`: Scriptorium's frontmatter references. Present only when the
   * app adds edges; cut at the same cap, `edgeCount` the whole. Not in `count`.
   */
  edges?: EdgeBacklinkView[];
  edgeCount?: number;
  truncated?: true;
};

/** An app's edge (kit-link-edges-slot) as a report shows it: where it is written, and its target as written. */
export type EdgeBacklinkView = {
  /** The document the edge is written in, absolute. */
  source: string;
  /** Its file name, with its extension. */
  name: string;
  /** Its path from the root of its context entry. */
  shown: string;
  /** The edge's kind, the app's word for it: `frontmatter`. */
  edge: string;
  /** The target exactly as written. */
  raw: string;
  /** What in the document carries it, when the app says: a frontmatter key (`related`). */
  key?: string;
  /** The 1-based line of the source file, when the app knows it. */
  line?: number;
  /** Relations it asserts; empty for none. */
  rel: string[];
  label?: string;
};

/** An app's edge that nothing answers: `tried` is every place the resolver looked. */
export type CheckedEdgeView = Omit<EdgeBacklinkView, "rel"> & {
  tried: string[];
  /**
   * Where the edge is written in the source's active text, as offsets: the
   * app's line when it gives one, else the first place its target is written
   * in the frontmatter (`line` is filled from it). Absent when neither finds it.
   */
  from?: number;
  to?: number;
  /** The id of the set (context entry) the source is in. */
  set?: string;
};

/**
 * A link or an app edge that lands on a file the session does not hold: a
 * file beside a listed document, or outside a set's folder. A link to one of
 * the session's own documents never leaves, whichever set either is in. Not a
 * problem (a set may well point beyond itself), but it says the session is
 * not self-contained. Reported only for an app that asks
 * (`LinkCheckOptions.leaving`).
 */
export type LeavingLinkView = {
  /** The document it is written in, absolute. */
  source: string;
  name: string;
  /** Its path from the root of its set. */
  shown: string;
  /** The 1-based line of the source file, when known. */
  line?: number;
  /** The target exactly as written. */
  raw: string;
  label?: string;
  /** Where it is written, as offsets, when known: what opening it reveals. */
  from?: number;
  to?: number;
  /** The file it lands on, absolute. */
  target: string;
  /** The file as a person reads it: its path in its own set, else from the source's set root. */
  targetShown: string;
  /** The label of the set whose folder holds the target (a file there that is not a document); absent for a file in no set. */
  targetSet?: string;
  /** An app edge's kind (`frontmatter`); absent for a body link. */
  edge?: string;
  key?: string;
  /** The id of the set the source is in. */
  set?: string;
};

/** A bundle that references a document: the boards a document is on, each with the cards that point at it. */
export type ReferenceBacklinkView = {
  /** The bundle's main file, absolute: what opens it. */
  source: string;
  /** The bundle's folder, absolute. */
  bundle: string;
  /** Its name as its row shows it (its title). */
  name: string;
  /** Its folder's path from the root of its context entry. */
  shown: string;
  /** What a person calls one ("board") and what holds a reference ("card"). */
  noun: string;
  part: string;
  /** Each reference to the document, in the order written. */
  refs: ReferenceView[];
};

/** One reference in a bundle's main file, as written. */
export type ReferenceView = {
  /** What holds it, by its id in the file (a card's id). */
  id: string;
  line: number;
  /** The path exactly as written. */
  raw: string;
  /** What it is called where it is (the title a card last showed), when it has one. */
  label?: string;
  /** A place inside the target (a heading), as written. */
  subpath?: string;
  from: number;
  to: number;
};

/**
 * A bundle's reference the link check reports (a card on a board whose file
 * is gone): the bundle, the reference, where it looked, and a sentence that
 * says so ("card 'The Glade' points at `bible/the-glade.md`, which is missing").
 */
export type CheckedReferenceView = ReferenceView & {
  source: string;
  /** The id of the set (context entry) the source is in. */
  set?: string;
  bundle: string;
  name: string;
  shown: string;
  noun: string;
  part: string;
  /** Every place it looked, in order. */
  tried: string[];
  text: string;
};

/**
 * One document as a report names it: where it is, what it is called, and its
 * kind as the world's profiles say (the graph's node, without its links).
 */
export type DocSummary = {
  path: string;
  /** Its file name, with its extension. */
  name: string;
  /** Its path from the root of its context entry. */
  shown: string;
  /** Its frontmatter `title`, else its first heading, else its file name without the extension. */
  title: string;
  /** The matched profile's kind, else the frontmatter `type`; null when it has none. */
  kind: string | null;
  /** The kind's label: the matched profile's, else the kind as written; null with no kind. */
  label: string | null;
  /** False when its matched profile says `"canon": false`; true otherwise. */
  canon: boolean;
  /** Its frontmatter `status`, when it has one. */
  status?: string;
};

/**
 * A document as a card shows it (`cardSummaries`): its summary, its
 * frontmatter `description` when it has one, and how many links it writes
 * (to files, not to a scheme such as `https:`), read from the link cache.
 */
export type DocCardSummary = DocSummary & { description?: string; links: number };

/**
 * A link a document writes, and where it lands, followed from where it is
 * written as backlinks follow it. `state` is the resolver's (`in-context`,
 * `outside`, `not-a-doc`, `folder`, `missing`), or `scheme` for a target with
 * a scheme (`op:doc/…`, `https:`), which names no file here.
 */
export type OutlinkView = {
  /** The 1-based line of the FILE (frontmatter counted). */
  line: number;
  /** The target exactly as written. */
  raw: string;
  /** The `?rel=` relations; empty for a bare link. */
  rel: string[];
  kind: LinkKind;
  label?: string;
  embed?: true;
  /** The line it is on, trimmed, cut to a window around the link when long. */
  context: string;
  from: number;
  to: number;
  state: "in-context" | "outside" | "not-a-doc" | "folder" | "missing" | "scheme";
  /** Where it landed, for every state but `missing` and `scheme`. */
  path?: string;
  /** The scheme, lower-cased, with state `scheme`. */
  scheme?: string;
  /** With state `scheme`: `http`, `https` and `mailto` open outward, in a browser; any other opens nothing here. */
  outward?: boolean;
};

/** The links one document writes, in the order it writes them. */
export type Outlinks = {
  path: string;
  shown: string;
  /** The version read (the active one unless one was asked for), or null for a document the session does not hold. */
  version: number | null;
  count: number;
  links: OutlinkView[];
  truncated?: true;
};

/** One document's text as the session holds it. */
export type DocText = {
  path: string;
  shown: string;
  /** The version read (the active one unless one was asked for), or null for a file read from disk. */
  version: number | null;
  text: string;
};

/** A link the check reports: where it is written, and the link as written. */
export type CheckedLinkView = {
  /** The document the link is written in, absolute. */
  source: string;
  /** Its file name, with its extension. */
  name: string;
  /** Its path from the root of its context entry. */
  shown: string;
  /** The 1-based line of the source FILE (frontmatter counted). */
  line: number;
  /** The target exactly as written: the string to search the source for. */
  raw: string;
  kind: LinkKind;
  label?: string;
  /** An embed (`![alt](x.png)`) rather than a link. */
  embed?: true;
  /** The line it is on, trimmed, cut to a window around the link when long. */
  context: string;
  /** Where the link sits in the source's active text, as offsets. */
  from: number;
  to: number;
  /** The id of the set (context entry) the source is in: what the list groups by. */
  set?: string;
};

/**
 * A link broken in a version that is not active (kit-relink-misses-proposed-
 * versions): a move's relink rewrites only the active version, so a version
 * proposed before the move keeps the old target. `line`, `from`, `to` and
 * `context` are in THAT version's text, not the active one's. Reported, never
 * rewritten.
 */
export type ProposedLinkView = CheckedLinkView & {
  /** The document's slug (`--doc`). */
  doc: string;
  /** The version the link is written in. */
  version: number;
  /** Every place the resolver looked. */
  tried: string[];
  /**
   * Where the target went, written from the document as relink writes it:
   * only when a move or rename this daemon made explains the break (the
   * target moved, or the document did) and the rewritten link lands. Absent
   * otherwise, and after a restart: never a guess.
   */
  suggest?: string;
  /**
   * The act that fixes it, said to the agent: propose the version again with
   * the link fixed (`version-new --from vN`), then delete the old proposal
   * (`version-delete vN`), which was the agent's own and never active.
   */
  act: string;
};

/** A document sharing its file name with another, and the name it could take. */
export type SharedNameFile = {
  path: string;
  /** Its path from the root of its context entry. */
  shown: string;
  /** A suggested new name, free in its folder and in the session. Never applied. */
  suggest: string;
  /** The id of the set (context entry) the file is in. */
  set?: string;
};

/**
 * The link check, in three sections. Each section's `count` is the whole, and
 * its list is cut at a cap (`truncated` says one was). Read from each document's
 * ACTIVE VERSION, so an unsaved edit counts; `proposed` alone reads the other
 * versions. A dangling link is reported, never an error.
 */
export type LinkCheck = {
  /** The link problems found: dangling links, unsupported links and shared names (never `unusedImages`). */
  count: number;
  /** Links that resolve to nothing: `tried` is every place the resolver looked. */
  dangling: { count: number; links: (CheckedLinkView & { tried: string[] })[] };
  /**
   * Links broken in a version the agent proposed: written by the agent and
   * never active (`Version.activated`), so a version the human has had active
   * is not read (`ProposedLinkView`), each with the act that fixes it. A link the active
   * version has broken too, as written, is in `dangling` alone. Counted in
   * `count`: activated, it is a broken link. Always sent by this daemon; optional
   * for a list built by hand.
   */
  proposed?: { count: number; links: ProposedLinkView[] };
  /** Links with a scheme nothing here opens (`op:doc/…`): `scheme` is `op`. */
  unsupported: {
    count: number;
    /** Every scheme in use among them, sorted, from the whole list, not the capped one. */
    schemes: string[];
    links: (CheckedLinkView & { scheme: string })[];
  };
  /** File names more than one document has, each file with a suggested rename. */
  duplicates: { count: number; names: { name: string; files: SharedNameFile[] }[] };
  /**
   * Images in an `images/` folder (where a paste or a drop into a document
   * puts them) that no link or embed in any document reaches: left behind when
   * an embed was undone or deleted. Only those folders: an image kept anywhere
   * else (a mood board, references) needs no embed to belong. Not in `count`,
   * which counts problems with links: an unused image is not a broken link.
   */
  unusedImages: { count: number; images: { path: string; shown: string; set?: string }[] };
  /**
   * Links carrying a relation the vocabulary declares symmetric, written one
   * way only: the document linked to writes no link with that relation back.
   * One per pair and relation, the first such link standing for the rest. A
   * HINT, never a problem (the human may not want the reverse link): not in
   * `count`, and never a doctor finding. Empty in a world with no
   * `_relations.json`.
   */
  symmetry: { count: number; hints: SymmetryHint[] };
  /**
   * Links whose document resolves but whose `#anchor` names no heading in it
   * (kit-heading-links-build): usually a heading reworded since. `nearest` is
   * the heading most like it, when one is close. Counted in `count`, apart
   * from dangling links, since following one still opens the document.
   */
  headings: { count: number; links: HeadingProblem[] };
  /**
   * Links whose bare `#anchor` names more than one heading (a repeated
   * heading's text): following lands on the first. A HINT, not in `count`;
   * the path of headings (`#Parent#Child`) names one alone.
   */
  ambiguousHeadings: { count: number; hints: HeadingProblem[] };
  /**
   * References in bundles (cards on boards) whose file nothing answers,
   * beside the documents' dangling links. Counted in `count`.
   */
  references: { count: number; links: CheckedReferenceView[] };
  /**
   * The app's edges that nothing answers (kit-link-edges-slot): Scriptorium's
   * frontmatter references to a page not written. Present only when the app
   * adds edges; `kinds` is every edge kind among them. Counted in `count`.
   */
  edges?: { count: number; kinds: string[]; links: CheckedEdgeView[] };
  /**
   * The app's edges that nothing answers and that are NOT written as a path
   * (`pathShaped`: no extension, no leading `/`, `./` or `../`), such as
   * `feature/some-slug`: a reference in a convention the kit does not know.
   * Listed, never counted in `count`: the kit cannot tell a broken one from
   * one another tool resolves. Present when `edges` is.
   */
  unresolved?: { count: number; kinds: string[]; links: CheckedEdgeView[] };
  /**
   * Links and app edges that land outside the set they are written in
   * (`LeavingLinkView`). Not in `count`, nor in a set's `total`: leaving the
   * set is not broken, so it is listed, never counted. The `edge` filter
   * applies as it does to the other sections.
   */
  leaving?: { count: number; links: LeavingLinkView[] };
  /** The app's word for a set (`LinkCheckOptions.noun`), when it gives one: what a list calls them. */
  noun?: string;
  /**
   * The session's sets, in the context's order: each entry above names its
   * set by `set`, and a list grouped by set titles each group from here.
   */
  sets?: {
    id: string;
    label: string;
    /** What the sign counts of the set, before any list is cut (shared names, the session's, unresolved references and leaving links apart). */
    total: number;
  }[];
  truncated?: true;
};

/** What an app asks of the link check beyond the kit's own (`WorkspaceDaemonOptions.linkCheck`). */
export type LinkCheckOptions = {
  /** Report the links and app edges leaving their set (`LinkCheck.leaving`). Off by default. */
  leaving?: boolean;
  /** The app's word for a set (`set`), said in the answer as `noun`. */
  noun?: string;
};

/** A link to a heading the check reports. */
export type HeadingProblem = CheckedLinkView & {
  /** The anchor as the link names it, decoded. */
  heading: string;
  /** The document linked to, absolute and as shown. */
  target: string;
  targetShown: string;
  /** Missing: the closest remaining heading's text, when one is close. Ambiguous: the heading it lands on. */
  nearest?: string;
};

/** A symmetric relation written one way: the link that writes it, and the document that does not link back. */
export type SymmetryHint = CheckedLinkView & {
  rel: string;
  /** The document linked to, absolute and as shown. */
  target: string;
  targetShown: string;
  /** In words: "The Ruin contrasts-with The Glade; The Glade does not link back". */
  hint: string;
};

/**
 * The world's relation vocabulary (`_meta/profiles/_relations.json`, the
 * nearest file winning per relation) and how the links use it.
 */
export type RelationsReport = {
  /** Every vocabulary file in the context, usable or broken (with why, and the line and column when it does not parse). */
  files: {
    path: string;
    shown: string;
    relations: number;
    broken?: string;
    /** Keys a relation has that are not read (a typo such as `symetric`), each ignored; `$`-keys are notes and never listed. */
    warnings?: string[];
  }[];
  /** How many warnings, across every file. */
  warnings: number;
  /** How many files are broken: each defines nothing until it is fixed. */
  broken: number;
  /**
   * Each declared relation, once per file that declares it, with `uses`: the
   * links using it in documents for which this file's definition is the one in force.
   */
  declared: {
    rel: string;
    label: string;
    means?: string;
    symmetric: boolean;
    inverse?: string;
    color?: string;
    /** The file it is declared in, as shown. */
    file: string;
    uses: number;
  }[];
  /** Relations links use where a vocabulary is in force but does not declare them, with how many links. */
  undeclared: RelationUse[];
  /** Every relation in use in the world, with how many links, most used first: the same with or without a vocabulary. */
  used: RelationUse[];
};

/**
 * What the link graph keeps. Every part is optional: with none, every document
 * in the session and every link between them, up to the cap.
 */
export type GraphOptions = {
  /** Centre on this document (a slug, a held name, or an absolute path in the context). */
  focus?: string;
  /** How far from the focus, in links followed either way: 0 to 3, default 1. */
  hops?: number;
  /** Keep links carrying any of these relations; untyped links go unless `untyped`. */
  rel?: string[];
  /** Keep untyped links. Default: true with no `rel`, false with one. */
  untyped?: boolean;
  /** Keep documents of these kinds only (a kind is `kindOf`'s: the matched profile's, else the frontmatter `type`). */
  kind?: string[];
  /** Keep documents with no kind. Default: true with no `kind`, false with one. */
  kindless?: boolean;
  /** Keep documents under this folder only (absolute): a set, or a folder in one. */
  within?: string;
  /** The most documents to answer with, best connected first; at most GRAPH_CAP. */
  limit?: number;
  /**
   * Bundles whose type reads references (boards) as nodes too, of their
   * type's kind, not canon, with an edge to what each references (marked
   * `reference`). Default false.
   */
  bundles?: boolean;
  /**
   * Keep links of these edge kinds only (kit-link-edges-slot): `link` for the
   * body links, or an app's own kind (`frontmatter`). A bundle's references
   * stay. Default: every kind.
   */
  edge?: string[];
};

/** A document in the link graph. */
export type GraphNodeView = {
  path: string;
  /** Its file name, with its extension. */
  name: string;
  /** Its path from the root of its context entry. */
  shown: string;
  /** Its frontmatter `title`, else its first heading, else its file name without the extension. */
  title: string;
  /** Its kind: the matched profile's kind, else the frontmatter `type`; null when it has none. */
  kind: string | null;
  /** Its kind's label: the matched profile's (`Location`), else the kind as written; null with no kind. */
  label: string | null;
  /** False when its matched profile says `"canon": false`; true otherwise, and in a world with no profiles. */
  canon: boolean;
  /** Its frontmatter `status`, when it has one. */
  status?: string;
  /** Links in and out within the filtered graph, before the cut. */
  linksIn: number;
  linksOut: number;
  /** Links away from the focus (0: the focus), when there is one. */
  hop?: number;
  /** A bundle (a board) rather than a document: what a person calls one. */
  bundle?: { noun: string };
};

/**
 * Links from one document to another with the same relations, folded: `rel`
 * is empty for untyped. `reference`: a bundle's references (cards on a board),
 * which assert no relation.
 */
export type GraphEdgeView = {
  from: string;
  to: string;
  rel: string[];
  count: number;
  reference?: true;
  /** An app's edges of this kind (kit-link-edges-slot), not body links: `frontmatter`. */
  edge?: string;
};

/**
 * The session's documents and the typed links between them, filtered and cut
 * by degree (`GraphOptions`). Read from each document's ACTIVE VERSION, as
 * backlinks are. `relations`, `untyped` and `kinds` describe what the filters
 * chose from, so a legend can offer what is hidden; `total` is what passed the
 * filters before the cut, and `truncated` says the cut dropped some.
 */
export type LinkGraph = {
  /** The focus's absolute path, or null. */
  focus: string | null;
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  relations: RelationUse[];
  untyped: number;
  /**
   * Every kind among the documents before `kind` filters, most first, with its
   * label and whether it is canon (false only when every document of it is not).
   */
  kinds: { kind: string | null; label: string | null; canon: boolean; count: number }[];
  /**
   * Links of each edge kind before `edge` filters, most first (`link`: the
   * body links). Present only when an app's edge is among them.
   */
  edgeKinds?: { kind: string; count: number }[];
  /**
   * What passed the filters, before the cut: documents, edges (folded pairs)
   * and the links they fold. With bundles shown (`bundles: true`), `bundles`
   * and `references` say how many of the nodes and links are bundles (boards)
   * and their references, present only when there are some.
   */
  total: { nodes: number; edges: number; links: number; bundles?: number; references?: number };
  truncated?: true;
  /**
   * What in the filter matched nothing, said rather than silent: a kind no
   * document has, a relation no link in view carries, a folder with no document
   * in the session, or a filter that left no document at all. The answer is
   * still the graph the filter asked for.
   */
  warnings?: string[];
};

// ── document profiles ─────────────────────────────────────────────────────
//
// What a kind of document is expected to carry in its frontmatter, read from a
// world's `_meta/profiles/<kind>.json` files (see `profiles.ts`). Problems are
// warnings: nothing here blocks a save.

/** One way a document's frontmatter differs from its profile. */
export type ProfileWarningView = {
  field: string;
  /** `required`, `type`, `enum`, `const`, `minLength`, or `forbidden` (a property whose schema is `false`). */
  rule: "required" | "type" | "enum" | "const" | "minLength" | "forbidden";
  /** A sentence a human reads. */
  message: string;
  /** What the rule expects: the types, the allowed values, the constant or the length. */
  expected?: unknown;
  /** The profile's own `description` of the field: guidance for fixing it. */
  description?: string;
  /**
   * The file whose rule this is, absolute and as shown: the kind file, or a
   * shared file its `allOf` refers to. A fix to the rule goes there.
   */
  file?: string;
  fileShown?: string;
  /** What to do about it, in words: "add `region` to the frontmatter". */
  fix?: string;
};

/**
 * A profile file that does not parse or is not a usable schema: its kind
 * matches nothing beneath it. A shared file (`kind` null) broken in itself is
 * listed once; each kind broken only because of it is listed too, with
 * `through` naming the shared file to fix.
 */
export type BrokenProfileView = {
  path: string;
  /** Its path from the root of its context entry (led by the entry's folder when two would read the same). */
  shown: string;
  /** The kind its file name says; null for a shared file. */
  kind: string | null;
  reason: string;
  /** For a kind broken only through a shared file: that file, as shown. The fix goes there. */
  through?: string;
  /** How many documents it leaves unchecked. */
  documents?: number;
};

/** A word about a usable profile file that is not a problem (a shared file's `kind`, which is ignored). */
export type ProfileFileNote = { path: string; shown: string; note: string };

/**
 * How one document matched a profile. `kind` is `kindOf`'s answer, the kind
 * the graph and the map use: the profile's kind when one matched, else the
 * frontmatter `type` exactly as today.
 */
export type DocumentProfile = {
  /** The document's slug when the session holds it, else null. */
  doc: string | null;
  /** For a held document, the version the answer was read from (its active one then). */
  version?: number;
  path: string;
  shown: string;
  /** Its frontmatter `type`, or null. */
  type: string | null;
  kind: string | null;
  /** `matched`: a usable profile; `broken`: its nearest file is broken; `none`: no profile for its type. */
  match: "matched" | "broken" | "none";
  /** The profile's label (`Location`), when one matched. */
  label?: string;
  /**
   * Whether the world counts the document as canon: false only when a matched
   * profile says `"canon": false`. With no profile, or a broken one, it is true,
   * as before profiles.
   */
  canon: boolean;
  /** The profile file that won (the nearest), absolute and as shown, when one matched or is broken. */
  source?: string;
  sourceShown?: string;
  /**
   * Why a broken source is broken, or, for `none`, why nothing matched: its
   * frontmatter does not parse, it has no `type`, or no profile defines it.
   */
  reason?: string;
  /**
   * For `broken`, when the kind is broken only because a shared file it refers
   * to is: that file, absolute and as shown. The fix goes there, not in `source`.
   */
  through?: string;
  throughShown?: string;
  /** The profile's own description of the kind. */
  description?: string;
  warnings: ProfileWarningView[];
  /** What the profile expects, field by field, in its order: for writing a new document of the kind. */
  fields?: {
    field: string;
    required: boolean;
    type?: string[];
    enum?: unknown[];
    const?: unknown;
    minLength?: number;
    description?: string;
    /** The profile's schema for it is `false`: a document of the kind does not take it. */
    forbidden?: true;
    /** The file this rule is written in, absolute and as shown. */
    file?: string;
    fileShown?: string;
  }[];
  /** The shared files the kind's `allOf` refers to, as shown, depth first. */
  refs?: string[];
};

/** The world's profiles: each kind with the file it came from and how many documents match it. */
export type ProfilesReport = {
  /** Documents in the session. */
  documents: number;
  /**
   * Each usable profile file with the documents it is the nearest for. A kind
   * defined in a nested folder too is listed once per file.
   */
  kinds: {
    kind: string;
    label: string;
    /** The file's `canon`: false for a kind the world does not count as canon, true when absent. */
    canon: boolean;
    source: string;
    shown: string;
    documents: number;
    /** Documents of it with at least one warning. */
    withWarnings: number;
    /** The shared files its `allOf` refers to, as shown, depth first. */
    refs: string[];
  }[];
  /** `type` values no profile defines, with how many documents carry each. */
  unprofiled: { type: string; documents: number }[];
  /** Documents with no `type` at all (a frontmatter block that does not parse is counted under `unparsed`). */
  untyped: number;
  /** Documents whose frontmatter block is there but does not parse as fields, each with why; cut at 500. */
  unparsed: { count: number; documents: { path: string; shown: string; reason: string }[] };
  broken: (BrokenProfileView & { documents: number })[];
  /** How many files need a fix: a shared file broken in itself counts once, not once per kind using it. */
  brokenFiles: number;
  notes?: ProfileFileNote[];
};

/** Every profile warning in the session, shaped like the link check. */
export type ProfileCheck = {
  /** All warnings, and every broken file, together. */
  count: number;
  warnings: {
    count: number;
    /** Documents with at least one warning. */
    documents: number;
    list: (ProfileWarningView & {
      source: string;
      name: string;
      shown: string;
      kind: string;
      /** The profile file it was checked against, as shown. */
      profile: string;
      /** What to do about it, in words. */
      fix: string;
    })[];
    /** Documents with more warnings than one document lists (20): how many more each has. */
    more?: { source: string; shown: string; count: number }[];
  };
  /** `count` is the files that need a fix; `files` also lists each kind broken through one, with `through`. */
  broken: { count: number; files: (BrokenProfileView & { fix: string })[] };
  notes?: ProfileFileNote[];
  truncated?: true;
};

// ── surface to daemon ─────────────────────────────────────────────────────

/** What a `pick` asks for: to add to the context, or only to answer with the paths chosen. */
export type PickWant = "context-file" | "context-folder" | PickAnswerWant;
/** A `pick` that adds nothing: the asker is answered with what was chosen. */
export type PickAnswerWant = "choose-folder" | "choose-file";
/** Every `want` a `pick` takes; any other is refused before a dialog opens. */
export const PICK_WANTS = [
  "context-file",
  "context-folder",
  "choose-folder",
  "choose-file",
] as const satisfies readonly PickWant[];

/** Surface to daemon, over the WebSocket. An app adds `<app>.<name>` frames. */
export type ClientOp =
  /** Open a document, or an image in the viewer: the daemon tells them apart by name. */
  | { op: "open"; path: string }
  | { op: "open.doc"; doc: string }
  /** Put the open image away: the centre goes back to having nothing open. */
  | { op: "image.close" }
  /**
   * `base`: the newest `rev` of a daemon-rewritten text this surface took for
   * the document (`version.text`), so a late edit typed over an older text is
   * rebased onto the rewrite rather than undoing it.
   *
   * `version` is the one the text was typed in. An edit naming a version that
   * is no longer active (another was activated while it waited out the
   * client's pause) is saved there, or kept as a version of its own when that
   * one changed or went since, and the chat says which: never refused.
   */
  | { op: "edit"; doc: string; version: number; text: string; base?: number }
  | { op: "select"; selection: Selection | null }
  | { op: "history.undo"; confirmDelete?: boolean }
  | { op: "history.redo" }
  /** End the session, from the page's End session button once the human has confirmed. */
  | { op: "close" }
  /**
   * `about` carries what the human pointed at besides the selection
   * (`noteId`), the `refs` the message draws on, and, with no
   * selection, `path`: the whole document or image that is its subject in
   * place of the active document (an open image, a document a view points at).
   * `via` is the gesture it came through: the composer sends `"chat"`.
   * `via: "ask"` with `about.noteId` is the "Ask the agent" act for that note:
   * sent once while the note is owed an answer, and a second is refused with an
   * `error` that says it was not sent. Through any other gesture, a message
   * naming a note is a typed follow-up and is always delivered.
   */
  | {
      op: "say";
      text: string;
      withSelection: boolean;
      via?: string;
      about?: Pick<MessageAbout, "noteId" | "path" | "refs">;
    }
  | { op: "activate"; doc: string; version: number }
  /** `activate` separates branching (move into it) from snapshotting (stay). */
  | { op: "version.new"; doc: string; from?: number; label?: string; activate?: boolean }
  | { op: "version.delete"; doc: string; version: number }
  /**
   * `seen` is the text the human selected, as their view showed it: the daemon
   * refuses a range that does not hold it, rather than store a note over text
   * nobody chose. Optional, so an older page still adds its notes unchecked.
   */
  | { op: "note.add"; doc: string; from: number; to: number; body: string; seen?: string }
  | { op: "note.edit"; doc: string; id: string; body: string }
  | { op: "note.resolve"; doc: string; id: string; resolved: boolean }
  | { op: "note.remove"; doc: string; id: string }
  /** A human task: a request for the agent, visible on its stream. */
  /** `messageId` turns a chat message into a task: the two stay one thing. */
  | { op: "task.create"; title: string; detail?: string; parent?: string; messageId?: string }
  | { op: "task.cancel"; id: string }
  | { op: "task.remove"; id: string }
  | { op: "tasks.clear" }
  /**
   * Save the active version over the original. When the original is missing,
   * Save refuses unless `recreate` says so: `file` writes it back into its
   * folder, `folder` also makes the folder again. Never silently.
   */
  | { op: "save"; doc: string; recreate?: "file" | "folder" }
  /** Put a document away: the view closes it; its record and versions stay in the session. */
  | { op: "doc.close"; doc: string }
  /**
   * What moving `path` to the Trash would take, for the dialog that asks;
   * answered with `trash.preview`. Read-only. The surface's alone, like `trash`.
   */
  | { op: "trash.preview"; path: string }
  /**
   * Move a document or folder shown in a set (or a single listed document) to
   * the operating system's Trash, never unlinked. The human's act alone: there is
   * no agent command for it. Answered with `trash.done`.
   */
  | { op: "trash"; path: string }
  /** Update the links the last rename, move or `set.make` broke (the `relink` offer), as one act with its undo. */
  | { op: "relink" }
  /** Leave them: the offer goes, and the link check lists them as before. */
  | { op: "relink.leave" }
  | { op: "revert"; doc: string }
  | { op: "context.add"; path: string }
  | { op: "context.remove"; id: string }
  | { op: "fs.list"; path: string }
  /**
   * Is a file of these bytes (`size`, hex SHA-256) already named `name` in
   * `dir`? Answered with `fs.same`. What a copy into a folder asks before
   * writing; `dir` must be a folder the session shows (a set, a folder in one,
   * the workspace), and anything else is refused.
   */
  | { op: "fs.same"; dir: string; name: string; size: number; sha256: string }
  /** Load a version's text into the surface (answered with `version.text`, origin "load"). */
  | { op: "read"; doc: string; version: number }
  | { op: "diff"; doc?: string; against: DiffSide }
  | { op: "merge"; doc?: string; against: DiffSide; hunks: number[] }
  | { op: "prefs.set"; key: string; value: string }
  /** Show a path in the file manager. Only paths the session knows are accepted. */
  | { op: "reveal"; path: string }
  /** Show a version's file. The daemon resolves it, so the surface names no path. */
  | { op: "reveal.version"; doc: string; version: number }
  /**
   * Open the OS file picker. `context-file` and `context-folder` add what
   * comes back to the context; `choose-folder` and `choose-file` only answer
   * the asker with what was chosen (a `chosen` frame), adding nothing.
   */
  | { op: "pick"; want: PickWant }
  /** Search the context; answered with `search.results`. */
  | { op: "search"; query: string; limit?: number }
  /**
   * Follow a link exactly as written in document `doc` (or in the chat, with no
   * document open). The daemon resolves it; an `in-context` target opens as
   * `open` would (its `version.text` first), and `link.target` always answers.
   * `from: "chat"` marks a link from a chat message, which was not written
   * beside `doc`: its `./` and `../` fall back to the context's root.
   */
  | { op: "link.open"; target: string; doc?: string; from?: LinkOrigin }
  /**
   * What a link written in document `doc` can point at, and the relations in
   * use; answered with `link.targets`. Read-only: the link itself is typed into
   * the editor like any other text.
   */
  | { op: "link.targets"; doc: string }
  /**
   * The headings of the document at `path`, with the anchor a link writes for
   * each; answered with `link.headings`. Asked for one document when the
   * picker's second step opens, never sent with every target.
   */
  | { op: "link.headings"; doc: string; path: string }
  /**
   * What each embed written in document `doc` shows: answered with
   * `link.embeds`, one `EmbedView` per distinct target, at most EMBED_CAP.
   * Read-only, and no image's bytes leave the daemon here (the file route
   * serves them).
   */
  | { op: "link.embeds"; doc: string; targets: string[] }
  /**
   * What sidebar rows dropped onto document `doc` write there; answered with
   * `link.drop`, one `DroppedLink` per path that writes or is refused.
   * Read-only: the surface inserts the text into the editor as an edit.
   */
  | { op: "link.drop"; doc: string; paths: string[] }
  /**
   * What links to document `doc`, for the surface to group as it shows them;
   * answered with `link.backlinks`. Read-only.
   */
  | { op: "link.backlinks"; doc: string }
  /**
   * How document `doc` matched a profile, and its warnings, read from its
   * active version as the agent's `profile` verb reads it; answered with
   * `profile`. Read-only: the frontmatter header's kind and warning chips.
   */
  | { op: "profile"; doc: string }
  /** The session's link check (`LinkCheck`), answered with `link.check`. Read-only. */
  | { op: "link.check" }
  /** The link graph (`LinkGraph`), filtered; answered with `link.graph`. Read-only. */
  | ({ op: "link.graph" } & GraphOptions)
  | StructureOp;

/** Daemon to surface, over the WebSocket. An app adds `<app>.<name>` frames. */
export type ServerOp =
  | { op: "state"; state: StateFrame }
  /**
   * `rev`: on a text the daemon rewrote (a link update after a rename or
   * move), its revision. The surface sends the newest it took as an edit's
   * `base`, so a late edit typed over the older text is rebased, not taken.
   *
   * `editSeen`: on a text a surface's `edit` left, sent to every other surface
   * (and to the typing one too after a rewrite), the `rid` of the newest
   * `edit` the daemon had answered (taken or refused) from the receiving
   * surface when it sent this frame, or null for none. A surface whose own edit to that version is newer
   * passes over the frame: the daemon takes that edit next and sends it on.
   */
  | {
      op: "version.text";
      doc: string;
      version: number;
      text: string;
      origin: "load" | "remote";
      rev?: number;
      editSeen?: string | number | null;
    }
  | ({ op: "diff" } & DiffPayload)
  | ({ op: "search.results" } & SearchReport)
  /**
   * Where a followed link went; `target` is the href as written. `refused` is
   * why a target the session holds still did not open (an image that is a link
   * leading out of its set), in words for the human.
   */
  | ({
      op: "link.target";
      target: string;
      refused?: string;
      /** The heading its `#anchor` names, when it has one and opened a document. */
      heading?: HeadingLanding;
    } & LinkResolution)
  | ({ op: "link.targets" } & LinkTargets)
  | ({ op: "link.headings" } & LinkHeadings)
  | { op: "link.embeds"; doc: string; embeds: EmbedView[] }
  | { op: "link.drop"; doc: string; links: DroppedLink[] }
  | ({ op: "link.backlinks" } & Backlinks)
  | ({ op: "profile" } & DocumentProfile)
  | ({ op: "link.check" } & LinkCheck)
  | ({ op: "link.graph" } & LinkGraph)
  /**
   * To every surface: something on disk under the context changed, settled over
   * a burst. A cue to re-ask a view of the whole context (the link check); it
   * carries nothing, and a change to an unheld document sends no `state`.
   */
  | { op: "context.changed" }
  /**
   * To every surface: a file inside a bundle changed on disk (`file`,
   * absolute, settled as every watcher event is), reported as a change to the
   * bundle at `path`. A view of the bundle (a board showing an asset) reads
   * that file again. A change to a main file the session holds follows the
   * outside-change flow every document has instead.
   */
  | { op: "bundle.changed"; path: string; file: string }
  /**
   * To every surface: the agent is pointing at something (`show`). The document
   * is already the open one; the surface scrolls to the target and marks it. The
   * chat says so too, so the view never moves unexplained.
   */
  | ({ op: "show" } & ShowTarget)
  | { op: "fs.list"; path: string; entries: FsListEntry[]; error?: string }
  /**
   * To the asker only: the paths a `choose-folder` or `choose-file` pick chose
   * (never a folder for a file), each named as the context names it; none,
   * and `cancelled`, when the dialog was dismissed. Its own frame, not
   * Story Studio's `picked`, whose paths a shell brings into the context.
   */
  | { op: "chosen"; paths: string[]; cancelled?: boolean }
  /** To the asker only: a `context.add` it sent landed; a refusal is an `error` instead. */
  | { op: "context.added"; ids: string[] }
  /** To the asker only: whether anything is at `path`, and whether it is a file of the same bytes. */
  | { op: "fs.same"; dir: string; name: string; exists: boolean; same: boolean }
  /** To the sender only: what a move to the Trash would take. */
  | ({ op: "trash.preview" } & TrashPreview)
  /** To the sender only: `path` is in the Trash. */
  | { op: "trash.done"; path: string }
  /** To the sender only: a structure op landed, at `path`, so the surface can open or rename it. */
  | {
      op: "structure.done";
      of: StructureOpName;
      path: string;
      /**
       * `true`: neither open nor rename what was made (`doc.create`'s
       * `stay`); `"rename"`: rename it in place, without opening it
       * (`bundle.create`'s).
       */
      stay?: true | "rename";
      /** Where a rename or a move took it from. */
      from?: string;
    }
  /** The session is ending on purpose; sent once, just before the socket closes. */
  | { op: "closed"; by: ClosedBy }
  /**
   * A refusal. `requestId` echoes the `id` of the client frame that caused it,
   * when that frame carried one; `choices` lists what would have been accepted.
   */
  | {
      op: "error";
      message: string;
      requestId?: string | number;
      choices?: string[];
      /** What to do instead, when the refusal knows (a create with no folder: the app's location hint). */
      hint?: string;
    };

/**
 * A client frame may carry a `rid`, its request id. It is optional and should be
 * unique per socket; the daemon echoes it as `requestId` on every frame it sends
 * in reply to that request (`error`, `version.text`, `structure.done`, an app's
 * reply). Broadcasts such as `state` belong to no request and carry none.
 *
 * `rid` is a field of its own so it never collides with an op's `id`: ops that
 * name a task, note or entry (`task.cancel`, `note.edit`, `context.remove`) keep
 * `id` as their subject, and the daemon never reads it as a request id.
 */
export type ClientFrame = ClientOp & { rid?: string | number };

// ── agent to daemon ───────────────────────────────────────────────────────

/** Agent to daemon, over `POST /cmd` (the CLI's verbs). An app adds `<app>.<name>` commands. */
export type AgentCmd =
  | { op: "context.add"; paths: string[] }
  /** `body`, when given, is the new version's text, written in the same act; without it the version is a copy. */
  | { op: "version.new"; doc?: string; from?: number; label?: string; body?: string }
  | { op: "say"; text: string; via?: string; about?: Pick<MessageAbout, "noteId"> }
  | { op: "activate"; doc?: string; version: number }
  | { op: "version.delete"; doc?: string; version: number }
  /** The agent notes a quote: it has no offsets, and counting characters would be asking it to be wrong. */
  | { op: "note.add"; doc?: string; quote: string; body: string }
  | { op: "notes"; doc?: string; all?: boolean }
  /**
   * Rewrite what one of the agent's own notes says; its passage stays. A note
   * the human wrote, or rewrote last, is refused: the agent answers it with
   * `note.reply`, and never rewrites the human's words.
   */
  | { op: "note.edit"; doc?: string; id: string; body: string }
  /**
   * Answer a note: an agent message about it (`about.noteId`), shown with the
   * note. The note's words are untouched.
   */
  | { op: "note.reply"; doc?: string; id: string; body: string }
  | { op: "note.resolve"; doc?: string; id: string; resolved: boolean }
  /** "Still working": silences the waiting nudge for a while, and nothing else. */
  | { op: "working"; seconds?: number }
  | { op: "task.create"; title: string; detail?: string; parent?: string }
  | { op: "task.status"; id: string; detail: string }
  | { op: "task.done"; id: string; outcome?: string; failed?: boolean }
  | { op: "task.cancel"; id: string }
  | { op: "diff"; doc?: string; against: DiffSide; context?: number }
  | { op: "merge"; doc?: string; against: DiffSide; hunks: number[] }
  /**
   * Scroll the human's view to a change (`hunk`, against `against`, default the
   * saved file), to a passage of the active version (`quote`, exact text), or
   * to a heading (`heading`, named as a link's anchor names one).
   * Opens the document for them when it is not the one on screen.
   */
  | {
      op: "show";
      doc?: string;
      hunk?: number;
      against?: DiffSide;
      quote?: string;
      /** A heading, named as a link's anchor names one: its text, its slug, or `Parent#Child`. */
      heading?: string;
    }
  | { op: "reveal"; path: string }
  | { op: "doctor" }
  | { op: "search"; query: string; limit?: number }
  /**
   * What links to `doc` (a slug, a held name, or an absolute path in the
   * context). `edge` keeps those edge kinds only (`link`: the body links).
   */
  | { op: "backlinks"; doc?: string; edge?: string[] }
  /** Dangling links, unsupported links and shared file names, across the session; `edge` as for backlinks. */
  | { op: "link.check"; edge?: string[] }
  /** The link graph, filtered by focus, hops, relation, kind and folder. */
  | ({ op: "graph" } & GraphOptions)
  /** The world's profiles: kinds, where each came from, types with none, broken files. */
  | { op: "profiles" }
  /** How one document matched a profile, and its warnings. */
  | { op: "profile"; doc?: string }
  /** Every profile warning and broken profile file in the session. */
  | { op: "profile.check" }
  /** The relation vocabulary, how the links use it, and broken vocabulary files. */
  | { op: "relations" }
  /**
   * Start an image's description: write its sidecar's frontmatter (`type:
   * image`, `source` and that origin's fields) beside it, then make a version
   * of it for the agent to write the description into.
   */
  | { op: "image.describe"; image: string; source?: ImageSource; label?: string }
  /** Update the links the last rename, move or `set.make` broke (the `relink` offer), as one act with its undo. */
  | { op: "relink" }
  /**
   * The app's image import settings (`lib/imageImport.ts`): read them, or set
   * the ones given, as the prefs store them (`keep`/`webp`; 1 to 100; a number
   * of pixels or `none`). A bad value refuses the whole call.
   */
  | { op: "image.settings"; format?: string; quality?: string; maxSide?: string }
  | { op: "close" }
  | StructureOp;
