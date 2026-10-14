/**
 * The event log's vocabulary: which events the kit puts on the log, which
 * `fact` a `system` event can carry, and the payload of each event. A surface
 * or an agent that reads the log types its frames with `KitLogEvent` and never
 * guesses a field. An app adds its own events, named `<app>.<event>`.
 *
 * Import-free at run time (types only from `protocol`), so both halves can use it.
 */

import type { MessageAbout, TaskAuthor } from "./protocol";

/** The event types the kit itself puts on the log. */
export const KIT_EVENTS = [
  "ready",
  "message",
  "waiting",
  "doc.opened",
  "version.created",
  "version.deleted",
  "activated",
  "saved",
  "reverted",
  "merged",
  "note.added",
  "note.resolved",
  "task.created",
  "task.started",
  "task.progress",
  "task.done",
  "task.failed",
  "task.cancelled",
  "system",
  "doctor",
  "closed",
] as const;

/**
 * Whether an event wakes the agent. Every event type, the kit's and each app's,
 * names one when it is registered.
 *
 * - `wake`: on the agent's tail. It can change what the agent should do next.
 * - `quiet`: on the log, and sent to any reader of `/events` but the agent's
 *   tail (`tail --all` asks for it too). The human only looked at something, or
 *   the agent's own act is confirmed: what it says is readable in `state`, or
 *   rides the human's next message as `about`.
 *
 * An emit may override its type's rule for one frame (`emit(type, fields,
 * { wake })`), for an event that wakes only in some cases (`saved`).
 */
export type TailRule = "wake" | "quiet";

/**
 * The rule for each kit event, and why. The test: an event belongs on the
 * agent's tail only if it can change what the agent should do next.
 * Decided 2026-10-06 (kit-quiet-tail-events); the agent's own confirmations
 * other than `doc.opened` are left as they were, for a later look.
 */
export const KIT_EVENT_TAIL: Readonly<Record<KitEvent, TailRule>> = {
  // Once per daemon run: the session the tail is on.
  ready: "wake",
  // The human said something: always.
  message: "wake",
  // The human has waited on an answer: always.
  waiting: "wake",
  // Quiet, both ways. The human's open names a document they are looking at:
  // `state.active` and `openDoc` say which, and their next message carries it
  // as `about.doc`, `about.path` and `about.version`. The agent's own open
  // (`open`, `show`, a version it made) confirms the act its own call already
  // answered.
  "doc.opened": "quiet",
  // A version written, the human's or the agent's: what is on offer changed.
  "version.created": "wake",
  "version.deleted": "wake",
  // Which version is being edited changed: the rule "never write the active
  // version" now points somewhere else.
  activated: "wake",
  // The human's save is their own work and asks nothing, so quiet unless the
  // emit says it wakes: when it may overtake the agent's work in flight (a
  // version it proposed and they have not taken, once per proposal; a task
  // the agent is running; an open note of the human's it is answering), or
  // when it is a save of a profile or relations file that changed the
  // profile or relation findings. A save that changed nothing on disk never
  // wakes. A save the agent is waiting for has no rule of its own: the agent
  // keeps a task running, or asks the human to say so in chat. See
  // `saveWakes` in the daemon.
  saved: "quiet",
  // The human threw away their edits: text the agent may be reading changed.
  reverted: "wake",
  merged: "wake",
  // A note asks the agent to act; a resolved one closes a thread it may hold.
  "note.added": "wake",
  "note.resolved": "wake",
  // Tasks: a request to pick up, or work in flight that moved.
  "task.created": "wake",
  "task.started": "wake",
  "task.progress": "wake",
  "task.done": "wake",
  "task.failed": "wake",
  "task.cancelled": "wake",
  // Facts about files and the session the agent must know (a file gone, an
  // outside write, a move, a rename). Not split by `fact` yet.
  system: "wake",
  // Findings, each saying what to do.
  doctor: "wake",
  // The session ended.
  closed: "wake",
};

/**
 * Why a human's save woke the agent: it may overtake a version the agent
 * proposed (said once per proposal), a task the agent is running, or an open
 * note of the human's on that document; or it saved a profile or relations
 * file and changed the profile or relation findings.
 */
export type SaveWake = "version" | "task" | "note" | "findings";

/** Who ended the session: the human (the surface), the agent (the CLI), or the idle timeout. */
export type ClosedBy = "human" | "agent" | "timeout";

export type KitEvent = (typeof KIT_EVENTS)[number];

/** Every `fact` a `system` event can carry. */
export const SYSTEM_FACTS = [
  "active.outside",
  "json.invalid",
  "original.reloaded",
  "original.conflict",
  "original.missing",
  "original.back",
  "trash",
  "doc.create",
  "folder.create",
  "bundle.create",
  "duplicate",
  "bundle.changed",
  "move",
  "rename",
  "import",
  "image.import",
  "image.replace",
  "image.pasted",
  "image.describe",
  "workspace.set",
  "workspace.defaulted",
  "workspace.overlap",
  "history.undo",
  "history.redo",
  "relink",
  "relink.left",
  "relink.kept",
  "note.edited",
  "note.removed",
  "reveal",
  "slot.migrated",
  "doctor",
] as const;

export type SystemFact = (typeof SYSTEM_FACTS)[number];

type Who = "human" | "agent";

/** What the log stamps on every frame. */
export type LogStamp = { id: number; epoch?: string };

/** The note facts `note.added` (and a reopened or human-rewritten note) carries when short enough. */
export type NoteFactsPayload = {
  lines?: { from: number; to: number };
  quote?: string;
  body?: string;
  passage?: "gone";
  hint?: string;
};

export type KitLogEventBody =
  | {
      type: "ready";
      app: string;
      mode: "dev" | "release";
      session_id: string;
      restored: boolean;
      idle_timeout_s: number;
    }
  | {
      type: "message";
      message_id: string;
      text: string;
      /** The kit's parts, and any part the app adds (Atlas: `map`, while the map is showing). */
      about?: MessageAbout & { [part: string]: unknown };
      ts: string;
      hint?: string;
    }
  | { type: "waiting"; message_id: string; seconds: number; text?: string; hint: string }
  | { type: "doc.opened"; doc: string; path: string | null; by: Who }
  | {
      type: "version.created";
      doc: string;
      version: number;
      fromVersion?: number;
      label?: string;
      by: Who;
      path?: string;
      activated?: boolean;
      /** The text of an outside write to the active version, kept as this version. */
      preserved?: boolean;
      /** A version file the agent wrote by hand and the daemon adopted. */
      adopted?: boolean;
      /** The number the hand-written file carried, when it was renumbered. */
      renamedFrom?: number;
      ts?: string;
    }
  | { type: "version.deleted"; doc: string; version: number; by: Who; ts?: string }
  | {
      type: "activated";
      by: Who;
      doc: string;
      version: number;
      previous: number;
      path: string | null;
      ts: string;
    }
  | {
      type: "saved";
      doc: string;
      version: number;
      original: string;
      by: "human";
      ts: string;
      /** The original was gone from disk and the human chose to recreate it (and its folder). */
      recreated?: "file" | "folder";
      /** The file already held these bytes: the save changed nothing. Never wakes the agent. */
      unchanged?: true;
      /** Why this save woke the agent; absent on a save that did not. */
      because?: SaveWake[];
      /** With `because: ["findings", ...]`, a save of a profile or relations file: the profile and relation findings as they now are. */
      findings?: { kind: string; subject: string; message: string; fix: string; count?: number }[];
    }
  | { type: "reverted"; doc: string; version: number; by: "human"; ts: string }
  | {
      type: "merged";
      doc: string;
      version: number;
      against: number | "original";
      hunks: number[];
      by: Who;
      ts?: string;
    }
  | ({ type: "note.added"; doc: string; note: string; by: Who } & NoteFactsPayload)
  | ({
      type: "note.resolved";
      doc: string;
      note: string;
      by: Who;
      resolved: boolean;
    } & NoteFactsPayload)
  | {
      type: "task.created";
      task: string;
      title: string;
      by: TaskAuthor;
      status: "open" | "running";
      kind?: string;
      parent?: string;
      detail?: string;
      message_id?: string;
    }
  | {
      type: "task.started";
      task: string;
      title: string;
      by: TaskAuthor;
      kind?: string;
      parent?: string;
    }
  | { type: "task.progress"; task: string; title: string; progress?: number; detail?: string }
  | { type: "task.done"; task: string; title: string; by: TaskAuthor; outcome?: string }
  | {
      type: "task.failed";
      task: string;
      title: string;
      by: TaskAuthor;
      message: string;
      was?: string;
      restored?: boolean;
    }
  | {
      type: "task.cancelled";
      task: string;
      title: string;
      by: TaskAuthor;
      was: string;
      restored?: boolean;
    }
  | ({ type: "system"; text?: string; ts?: string; by?: Who } & SystemFactPayload)
  | {
      type: "doctor";
      count: number;
      findings: { kind: string; subject: string; message: string; fix: string; count?: number }[];
    }
  | { type: "closed"; by: ClosedBy };

/** One document's links in a link fact: each as it was written (`from`) and is now (`to`). */
export type LinkFactDoc = { path: string; links: { line: number; from: string; to: string }[] };

/** Links rewritten after a rename or move; `skipped` names documents left alone, and why. */
export type LinksFact = {
  count: number;
  docs: LinkFactDoc[];
  skipped?: { path: string; reason: string }[];
};

/** The part of a `system` event that depends on its `fact`. */
export type SystemFactPayload =
  | {
      fact: "active.outside";
      doc: string;
      version: number;
      path: string;
      preservedAs: number;
      preservedPath: string;
    }
  /**
   * A version of a JSON document, written from outside, does not parse: Save
   * and the agent's activate and merge refuse it until it does.
   */
  | {
      fact: "json.invalid";
      doc: string;
      version: number;
      path: string;
      line: number;
      column: number;
      problem: string;
    }
  | { fact: "original.reloaded"; doc: string }
  | { fact: "original.conflict"; doc: string; whileClosed?: boolean }
  /** The open document's file is gone from disk; `folder` when its folder went too. */
  | { fact: "original.missing"; doc: string; original: string; folder: boolean }
  | { fact: "original.back"; doc: string; original: string }
  /** The human moved a path to the Trash. The agent has no way to. */
  | {
      fact: "trash";
      path: string;
      dir: boolean;
      files: number;
      docs: string[];
      closed?: string;
      /** An image's description went to the Trash with it. */
      sidecar?: string;
    }
  | { fact: "doc.create" | "folder.create" | "import" | "bundle.create"; path: string }
  /** A copy of a document or a whole bundle, beside it; `dir` for a bundle's. */
  | { fact: "duplicate"; path: string; from: string; dir?: true }
  /**
   * A file inside a bundle changed on disk (`file`), reported as a change to
   * the bundle (`path`). Quiet: it never wakes the agent's tail.
   */
  | { fact: "bundle.changed"; path: string; file: string }
  /** A dropped image written as a file, or put in place of one whose old file went to the Trash. */
  | { fact: "image.import"; path: string }
  /** `sidecar` and `sidecarKept`: the image's description was kept, and may no longer fit. */
  | { fact: "image.replace"; path: string; sidecar?: string; sidecarKept?: true }
  /**
   * Images pasted or dropped into a document in the editor, each written to
   * the `images/` folder beside it and embedded at the caret: one fact per
   * burst. The agent may offer, once, to describe and name them. `how` is
   * `both` when one burst held a paste and a drop. `notes`, by image: what the
   * image import settings did to it, or why they left it as it came.
   */
  | {
      fact: "image.pasted";
      doc: string;
      images: string[];
      how: "paste" | "drop" | "both";
      notes?: Record<string, string>;
    }
  /** The agent started an image's description: its sidecar, beside the image. */
  | { fact: "image.describe"; path: string; image: string }
  /**
   * `broken`: links the act broke, offered for updating (`relink`). `links`:
   * the links it updated in the same act (`--update-links`).
   */
  | {
      fact: "move" | "rename";
      path: string;
      from: string;
      sidecar?: string;
      broken?: { count: number; docs: LinkFactDoc[]; hint: string };
      links?: LinksFact;
    }
  /** The links the last rename or move broke, updated as part of it. */
  | ({ fact: "relink" } & LinksFact)
  /** The human left them; the link check lists them. */
  | { fact: "relink.left"; count: number }
  /**
   * An editor's late edit, typed over the text from before a link update, was
   * rebased onto it but kept these old targets (a line it changed held more
   * of them than the update rewrote): they still point at the old place.
   */
  | { fact: "relink.kept"; doc: string; path: string; links: { line: number; raw: string }[] }
  | { fact: "workspace.set"; path: string; from: string }
  | { fact: "workspace.defaulted"; path: string }
  /** A session from before the overlap block: the workspace is, or is inside, the set at `set`. */
  | { fact: "workspace.overlap"; path: string; set: string }
  | { fact: "history.undo" | "history.redo" }
  /** A human's rewrite carries what the note now says, as `note.added` does. */
  | ({ fact: "note.edited"; doc: string; note: string } & NoteFactsPayload)
  | { fact: "note.removed"; doc: string; note: string }
  | { fact: "reveal"; path: string }
  | { fact: "slot.migrated"; from: number }
  | { fact: "doctor"; findings: number };

/** A kit event as a reader receives it, with the log's stamp. */
export type KitLogEvent = KitLogEventBody & LogStamp;
