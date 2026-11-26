/**
 * The project: its manifest and session, the views of images and embeds,
 * links that follow a rename, the context's undo history, and the snapshot.
 * Part of the wire vocabulary (`../protocol.ts`): types, and `resolveAppState`,
 * which reads a state frame.
 */

import type { ImageDescription } from "../../lib/sidecar.ts";
import type { ClosedBy } from "../events";
import type { Message, NoteWaiting, Selection, Task, TaskView, Waiting } from "./chat";
import type { ContextEntry } from "./context";
import type { Doc, DocView } from "./documents";

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
