// The browser's half of the wire. `Task` and its friends are IMPORTED from the
// skill's shared/ folder — the same file `scripts/server.ts` reads — because
// the seam cut of 2026-09-06 put them inside the tracked subtree for exactly
// this. Do not copy a type in here; if a shape is missing, export it there.
//
// The frames below are the daemon's browser-facing protocol
// (`scripts/server.ts`, `broadcast()` and the websocket `message` handler).
// They are DECLARED here rather than imported because they are declared inline
// in the daemon's own handlers and a surface→scripts/ import is what the
// import-boundary wards forbid.

import type { Task, TaskStatus } from "../../../../plugins/spellbook/skills/bounty/shared/types";

export type { Task, TaskStatus };

/** b16 — a boot fact carried on every `init`. */
export type RestoreFailed = { path: string; reason: string };

/** Server → browser. */
export type ServerFrame =
  | {
      type: "init";
      title?: string;
      tasks?: Task[];
      restoreFailed?: RestoreFailed | null;
      /** Added 2026-09-06: the built page is static, so the session id can no
       *  longer be substituted into the HTML. `init` is the frame that already
       *  carries boot facts (b16's own argument), and this is one. */
      sessionId?: string;
    }
  | { type: "task.add"; task: Task }
  | { type: "task.update"; id: string; patch: Partial<Task> }
  | { type: "task.remove"; id: string }
  | { type: "message"; text: string };

/** Browser → server. The daemon accepts exactly these six. */
export type ClientFrame =
  | { type: "task.add"; task: Task }
  | { type: "task.toggle"; id: string; status: TaskStatus }
  | { type: "task.move"; id: string; status: TaskStatus; index: number }
  | { type: "task.edit"; id: string; title?: string; notes?: string }
  | { type: "task.remove"; id: string }
  | { type: "close" };

export type ConnState = "" | "connected" | "closed";

export type Toast = { id: number; text: string };

export const STATUSES: TaskStatus[] = ["todo", "doing", "review", "done"];

export const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "todo", label: "To do" },
  { status: "doing", label: "Doing" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

/** wip-cue: an owner with this many or more cards in Doing gets nudged. */
export const WIP_THRESHOLD = 2;

/** The card-aging tick. `now` advances on this interval so the stale cues
 *  update without a user action. */
export const AGE_TICK_MS = 30_000;

/** How long a toast lives. There is no manual dismiss. */
export const TOAST_MS = 5_000;

/** How long after a close before the socket retries. */
export const RECONNECT_MS = 1_000;
