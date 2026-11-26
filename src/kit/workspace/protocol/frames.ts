/**
 * The frames: surface to daemon over the WebSocket, and agent to daemon over
 * `POST /cmd`. Part of the wire vocabulary (`../protocol.ts`): types, and
 * `PICK_WANTS`, the `want`s a `pick` takes.
 */

import type { ImageSource } from "../../lib/sidecar.ts";
import type { ClosedBy } from "../events";
import type { LinkOrigin } from "../links";
import type { MessageAbout, Selection } from "./chat";
import type { FsListEntry, StructureOp, StructureOpName, TrashPreview } from "./context";
import type { DiffPayload, DiffSide, ShowTarget } from "./documents";
import type { EmbedView, StateFrame } from "./project";
import type {
  Backlinks,
  DocumentProfile,
  DroppedLink,
  GraphOptions,
  HeadingLanding,
  LinkCheck,
  LinkGraph,
  LinkHeadings,
  LinkResolution,
  LinkTargets,
  SearchReport,
} from "./reading";

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
  /**
   * `pick`: the daemon chooses the side, one whose text differs from the
   * active version's (`WorkspaceSession.compare`), and says so (`picked`).
   * `against` is then the side to use if none differs.
   */
  | { op: "diff"; doc?: string; against: DiffSide; pick?: boolean }
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
