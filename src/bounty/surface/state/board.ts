// The four incoming frames, as pure reducers over the task list.
//
// Every one of them has a SILENT branch, and each silence is a behaviour the
// inventory has a row for: an `add` for an id already present is dropped (W7),
// an `update` or `remove` for an unknown id is ignored (W8/W9). They return the
// SAME array reference when nothing changed, so a caller can skip a render.

import type { RestoreFailed, ServerFrame, Task } from "./types";

export type BoardSnapshot = {
  title: string;
  tasks: Task[];
  restoreFailed: RestoreFailed | null;
  sessionId: string;
};

/**
 * `init` — the daemon's whole-board frame. Sent on every connect, and again
 * after every accepted `task.move` (the daemon rebroadcasts the ordered list
 * rather than diffing it).
 *
 * `restoreFailed` is read DEFENSIVELY: only a truthy object counts. An older
 * daemon serving a newer surface omits the field, and `undefined` must read as
 * "not reported", never as "the restore succeeded".
 *
 * `sessionId` is likewise optional — an older daemon does not send it, and the
 * header then shows nothing rather than the string "undefined".
 */
export function applyInit(
  prev: BoardSnapshot,
  msg: Extract<ServerFrame, { type: "init" }>,
): BoardSnapshot {
  return {
    title: msg.title || "",
    tasks: Array.isArray(msg.tasks) ? msg.tasks.slice() : [],
    restoreFailed:
      msg.restoreFailed && typeof msg.restoreFailed === "object" ? msg.restoreFailed : null,
    sessionId: typeof msg.sessionId === "string" ? msg.sessionId : prev.sessionId,
  };
}

/** `task.add` — append, deduped by id. */
export function applyAdd(tasks: Task[], task: Task): Task[] {
  if (tasks.some((t) => t.id === task.id)) return tasks;
  return [...tasks, task];
}

/** `task.update` — merge the patch over the task. Unknown id: no change. */
export function applyUpdate(tasks: Task[], id: string, patch: Partial<Task>): Task[] {
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return tasks;
  const next = tasks.slice();
  next[idx] = { ...(next[idx] as Task), ...patch };
  return next;
}

/** `task.remove` — drop by id. Unknown id: no change. */
export function applyRemove(tasks: Task[], id: string): Task[] {
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return tasks;
  return [...tasks.slice(0, idx), ...tasks.slice(idx + 1)];
}

/**
 * The session-end signal. The daemon precedes every socket close with a
 * `message` frame; only one starting with this prefix ends the session (dims
 * the board, makes it inert, and stops the reconnect loop).
 */
export const SESSION_ENDED_PREFIX = "session ended:";

export function isSessionEnd(text: string | undefined): boolean {
  return typeof text === "string" && text.startsWith(SESSION_ENDED_PREFIX);
}

/**
 * A client-minted task id: `u-` plus 12 lowercase hex. The daemon accepts any
 * non-empty string id; this shape is what the old page produced and what an
 * agent reading the event log has learned to recognise as "the human added it".
 */
export function randId(
  random: (buf: Uint8Array) => void = (b) => crypto.getRandomValues(b),
): string {
  const buf = new Uint8Array(6);
  random(buf);
  return `u-${Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
