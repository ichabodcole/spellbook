/**
 * Chat and tasks: messages, the selection, what is waiting, and tasks.
 * Part of the wire vocabulary (`../protocol.ts`); types only.
 */

import type { Speaker, TaskAuthor } from "./documents";

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
  /**
   * What the wait is timed from: when the human last put the note in front of
   * the agent (made, rewrote or reopened it), or, once an ask about it was
   * answered by any agent message, that answer.
   */
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
