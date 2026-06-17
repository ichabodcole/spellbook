#!/usr/bin/env bun

// bounty — agent-driven task board the user can interact with.
//
// The house agent-interface pattern (shared with grapevine + imago): a
// persistent daemon holds the canonical state; the agent drives it through a
// thin `cli.ts` over HTTP, and the browser is wired over WebSocket.
//
//   - Agent → daemon:  POST /cmd          (an AgentCommand; write path)
//   - Agent ← daemon:  GET  /state[?lean=1]  ({ state, cursor } read-back)
//                      GET  /events?since=<id>  (SSE event tail, resumable)
//   - Browser ↔ daemon: WebSocket /ws     (same task.* events both ways)
//   - The daemon holds canonical state; late-joining browsers receive a
//     synthetic init on connect.
//
// AgentCommand — POST /cmd body (one of). All carry an optional `as` (caller
// identity → event `by`); /cmd returns {ok, applied?, error?}:
//   {"type":"init",        "title": "...", "tasks": Task[]}
//   {"type":"task.add",    "task": Task}              // append
//   {"type":"task.update", "id": "...", "patch": Partial<Task>, "claim"?: bool}
//   {"type":"task.remove", "id": "..."}
//   {"type":"task.block",  "id": "...", "on": string[]}   // add blocker edges (cycle-guarded)
//   {"type":"task.unblock","id": "...", "on": string[]}   // remove blocker edges
//   {"type":"message",     "text": "..."}             // toast
//   {"type":"close"}                                  // end session
//
// Event log — GET /events frames (server → agent), each with a monotonic `id`
// (the resume cursor), an actor `by` (the caller's --as | "user" | "system"),
// and (task.* + unblocked) the affected task's `owner` for client-side scoping:
//   {id, type:"ready",        url, port, session_id, by:"system"}
//   {id, type:"connected" | "disconnected", by:"user"}
//   {id, type:"task.toggle",  taskId, status, by, owner}  // ⚠ taskId, NOT id —
//   {id, type:"task.move",    taskId, status, index, by, owner}  //  envelope id
//   {id, type:"task.edit",    taskId, title?, notes?, by, owner}  // is the cursor;
//   {id, type:"task.add",     task, by, owner}            //   task id is nested
//   {id, type:"task.update",  taskId, patch, by, owner}   //   / `taskId` so the
//   {id, type:"task.remove",  taskId, by, owner}          //   spread can't clobber.
//   {id, type:"unblocked",    taskId, owner, by:"system"} // last blocker cleared
//   {id, type:"heartbeat",    taskId, owner, overdueByMs, expectedMinutes, by:"system"}
//                                                     //   owner-scoped overrun poke
//   {id, type:"closed",       reason, by:"system"}    //   reason: user|timeout|close
//
// task.toggle vs task.move: toggle is the click-a-pill UX — status changes,
// task is appended to the destination column. move is the drag UX — status
// AND explicit position in the destination column. Agents that only care
// about column membership can ignore .move and rely on the canonical order
// the daemon keeps.
//
// Exit codes: 0 on any clean dismiss (the human's "Close board" → reason "user",
// or an agent cli.ts close → reason "close"), 2 bad args, 124 idle timeout. The
// board is a conjuration — there's no "cancel"/130 discard path.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ServerWebSocket } from "bun";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// Persistence root: debounced snapshots land in $BOUNTY_HOME/snapshots/<id>.json
// so a board survives a restart via `cli.ts open --restore <id>`. cli.ts derives
// the same path, so override BOUNTY_HOME to relocate both.
const BOUNTY_HOME = process.env.BOUNTY_HOME ?? join(homedir(), ".bounty");
const SNAPSHOTS_DIR = join(BOUNTY_HOME, "snapshots");

type TaskStatus = "todo" | "doing" | "review" | "done";
type StatusVisit = { status: TaskStatus; at: number }; // a single transition (unix ms)
type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  notes?: string;
  owner?: string; // assignee — lead sets via add/update --owner; worker self-claims
  blockedBy?: string[]; // ids this task is blocked on (mutated only via block/unblock)
  tags?: string[]; // free-form labels; clean string[] (a future filter groups on them)
  enteredStatusAt?: number; // unix ms the task entered its CURRENT status
  statusHistory?: StatusVisit[]; // capped transition log (heartbeat/aging/metrics substrate)
  size?: TaskSize; // heartbeat sizing — opt-in; maps to a default expected time
  expect?: number; // explicit expected minutes (overrides size); for the rare exception
};
type BoardState = { title: string; tasks: Task[] };

// Cap the per-task transition log so long-lived tasks don't bloat snapshots.
const MAX_STATUS_HISTORY = 20;

// Heartbeat sizing (#29). Three sizes only — agents are fast (a code change
// rarely runs past ~20 min) and the absence of an XL is deliberate: a days-long
// task is a signal to BREAK IT DOWN, not size it bigger. Minutes are tunable.
type TaskSize = "S" | "M" | "L";
const SIZE_MINUTES: Record<TaskSize, number> = { S: 5, M: 10, L: 20 };

// A task's expected time in minutes, or undefined when it isn't watched.
// Heartbeat is opt-in per task: an explicit `expect` wins, else the size's
// default, else undefined (no size/expect → never poked).
function expectedMinutes(task: Task): number | undefined {
  if (typeof task.expect === "number" && task.expect > 0) return task.expect;
  if (task.size && task.size in SIZE_MINUTES) return SIZE_MINUTES[task.size];
  return undefined;
}

type Poke = { taskId: string; owner?: string; overdueByMs: number; expectedMinutes: number };
type PokeState = Map<string, number>; // taskId -> lastPokeAt (unix ms)

// Evaluate every task for an overdue-in-doing poke and return the pokes to fire
// plus the next poke bookkeeping. A doing task that overran its expected time
// pokes once, then re-pokes once per expected-period (interval scales with the
// expected time — proportionate, not constant). Rebuilding `pokeState` from
// scratch each sweep means a task that left doing auto-resets. Pure: `now` is
// injected so the sweep is deterministically testable.
function computeDuePokes(
  tasks: Task[],
  pokeState: PokeState,
  now: number,
): { pokes: Poke[]; pokeState: PokeState } {
  const next: PokeState = new Map();
  const pokes: Poke[] = [];
  for (const task of tasks) {
    if (task.status !== "doing" || task.enteredStatusAt === undefined) continue;
    const exp = expectedMinutes(task);
    if (exp === undefined) continue;
    const expMs = exp * 60_000;
    const overdueByMs = now - (task.enteredStatusAt + expMs);
    if (overdueByMs < 0) continue; // not overdue yet — no bookkeeping needed
    const last = pokeState.get(task.id);
    if (last === undefined || now - last >= expMs) {
      pokes.push({ taskId: task.id, owner: task.owner, overdueByMs, expectedMinutes: exp });
      next.set(task.id, now);
    } else {
      next.set(task.id, last); // carry the interval forward
    }
  }
  return { pokes, pokeState: next };
}

// Stamp a status transition: the fields to merge onto a task entering `status`
// at `now` — enteredStatusAt + an appended, capped statusHistory. Pure (now is
// passed in) so the substrate is deterministic and the downstream features
// (heartbeat, card-aging, metrics, leaderboard) all read one shape.
function transitionStamp(
  prev: StatusVisit[] | undefined,
  status: TaskStatus,
  now: number,
): { enteredStatusAt: number; statusHistory: StatusVisit[] } {
  const statusHistory = [...(prev ?? []), { status, at: now }].slice(-MAX_STATUS_HISTORY);
  return { enteredStatusAt: now, statusHistory };
}

type CloseReason = "user" | "timeout" | "close";
type DoneResult = { code: number; reason: CloseReason };

// `as` is the caller's --as identity (stamped onto the event `by`); cooperative
// attribution, never an auth boundary. `claim` marks a cooperative self-claim
// (task.update) that must not steal an already-owned task.
type AgentMsg =
  | { type: "init"; title?: string; tasks?: Task[]; as?: string }
  | { type: "task.add"; task: Task; as?: string }
  | { type: "task.update"; id: string; patch: Partial<Task>; as?: string; claim?: boolean }
  | { type: "task.remove"; id: string; as?: string }
  | { type: "task.block"; id: string; on: string[]; as?: string }
  | { type: "task.unblock"; id: string; on: string[]; as?: string }
  | { type: "message"; text: string; as?: string }
  | { type: "close"; as?: string };

// The /cmd response — `applied` lets the CLI confirm a write actually took (a
// rejected cooperative claim returns applied:false + a reason).
type ApplyResult = { ok: true; applied?: boolean; error?: string };

type BrowserMsg =
  | { type: "task.toggle"; id: string; status: TaskStatus }
  | { type: "task.move"; id: string; status: TaskStatus; index: number }
  | { type: "task.edit"; id: string; title?: string; notes?: string }
  | { type: "task.add"; task: Task }
  | { type: "task.remove"; id: string }
  | { type: "close" }; // the human dismisses the board ("Close board")

const PORT_SUFFIX_RE = /-p(\d{2,5})$/;
const VALID_STATUS: TaskStatus[] = ["todo", "doing", "review", "done"];

function parsePortFromSessionId(sid: string): number | null {
  const m = sid?.match(PORT_SUFFIX_RE);
  if (!m) return null;
  const port = parseInt(m[1], 10);
  return port >= 1 && port <= 65535 ? port : null;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function randHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" });
  } catch {
    /* best-effort */
  }
}

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
function guessMime(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

// Narrow an untrusted value into a valid Task, or null if it doesn't qualify:
// required string id + title, a valid status, optional string notes. This is
// the single task-shape trust boundary — the browser WS path, the agent /cmd
// path (init + task.add), and snapshot restore all run candidates through it so
// a malformed task can't enter canonical state. Per-task (callers filter-and-
// keep-valid or reject a single task), never all-or-nothing.
// Sanitize an untrusted tags value into a clean string[]: strings only, each
// trimmed, empties dropped, deduped exactly (case preserved for display — a
// later filter compares case-insensitively, same as owner-case). A non-array
// yields []. Callers decide whether to omit an empty result.
function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const x of value) {
    if (typeof x !== "string") continue;
    const t = x.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function validateTask(t: unknown): Task | null {
  if (!t || typeof t !== "object") return null;
  const cand = t as Record<string, unknown>;
  if (typeof cand.id !== "string" || typeof cand.title !== "string") return null;
  if (typeof cand.status !== "string" || !VALID_STATUS.includes(cand.status as TaskStatus)) {
    return null;
  }
  if (cand.notes !== undefined && typeof cand.notes !== "string") return null;
  if (cand.owner !== undefined && typeof cand.owner !== "string") return null;
  if (
    cand.blockedBy !== undefined &&
    (!Array.isArray(cand.blockedBy) || cand.blockedBy.some((x) => typeof x !== "string"))
  ) {
    return null;
  }
  const tags = cleanTags(cand.tags);
  // Transition substrate is server-generated; on restore we preserve it
  // leniently — drop a malformed value rather than reject the whole task, so a
  // legacy snapshot still loads.
  const enteredStatusAt =
    typeof cand.enteredStatusAt === "number" ? cand.enteredStatusAt : undefined;
  const statusHistory = Array.isArray(cand.statusHistory)
    ? (cand.statusHistory.filter(
        (h): h is StatusVisit =>
          !!h &&
          typeof h === "object" &&
          VALID_STATUS.includes((h as StatusVisit).status) &&
          typeof (h as StatusVisit).at === "number",
      ) as StatusVisit[])
    : undefined;
  // Heartbeat sizing — lenient: drop a bad size/expect, keep the task.
  const size =
    typeof cand.size === "string" && cand.size in SIZE_MINUTES
      ? (cand.size as TaskSize)
      : undefined;
  const expect = typeof cand.expect === "number" && cand.expect > 0 ? cand.expect : undefined;
  return {
    id: cand.id,
    title: cand.title,
    status: cand.status as TaskStatus,
    ...(cand.notes !== undefined ? { notes: cand.notes as string } : {}),
    ...(cand.owner !== undefined ? { owner: cand.owner as string } : {}),
    ...(cand.blockedBy !== undefined ? { blockedBy: cand.blockedBy as string[] } : {}),
    ...(tags.length ? { tags } : {}),
    ...(enteredStatusAt !== undefined ? { enteredStatusAt } : {}),
    ...(statusHistory?.length ? { statusHistory } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(expect !== undefined ? { expect } : {}),
  };
}

// State mutation helpers. All keep `state.tasks` in place (replace by id)
// so the agent and browser see consistent ordering.
function applyTaskAdd(state: BoardState, task: Task, now: number = Date.now()): boolean {
  if (state.tasks.some((t) => t.id === task.id)) return false;
  // Stamp the initial status entry — unless the task already carries its own
  // (a restore/init that preserved the transition log).
  const stamped =
    task.enteredStatusAt === undefined
      ? { ...task, ...transitionStamp(task.statusHistory, task.status, now) }
      : task;
  state.tasks.push(stamped);
  return true;
}

function applyTaskUpdate(
  state: BoardState,
  id: string,
  patch: Partial<Task>,
  now: number = Date.now(),
): boolean {
  const idx = state.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  // Status guard: drop invalid status values quietly so a malformed agent
  // message can't corrupt the board.
  if (patch.status && !VALID_STATUS.includes(patch.status)) {
    const { status: _drop, ...rest } = patch;
    patch = rest;
  }
  const prev = state.tasks[idx];
  const merged: Task = { ...prev, ...patch };
  // Stamp only on an actual status CHANGE (a transition) — not a notes/title
  // patch, and not a same-status patch (a guarded doing->doing never reaches
  // here, but a direct call must not reset the clock either).
  if (patch.status !== undefined && patch.status !== prev.status) {
    Object.assign(merged, transitionStamp(prev.statusHistory, patch.status, now));
  }
  state.tasks[idx] = merged;
  return true;
}

function applyTaskRemove(state: BoardState, id: string): boolean {
  const idx = state.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  state.tasks.splice(idx, 1);
  return true;
}

// Move a task to (status, index) — where `index` is its position among the
// tasks of that status. Returns the canonical absolute index in state.tasks
// after the move, or -1 if the task wasn't found. Status validation is the
// caller's job (we already screen in the WS handler).
function applyTaskMove(
  state: BoardState,
  id: string,
  status: TaskStatus,
  index: number,
  now: number = Date.now(),
): number {
  const fromIdx = state.tasks.findIndex((t) => t.id === id);
  if (fromIdx === -1) return -1;
  const [task] = state.tasks.splice(fromIdx, 1);
  // A cross-column move is a transition; an intra-column reorder is not.
  if (task.status !== status) {
    Object.assign(task, { status }, transitionStamp(task.statusHistory, status, now));
  }
  // Translate the column-local index into an absolute index in state.tasks:
  // walk through state.tasks and count tasks of the target status until we
  // hit `index` slots. If `index` exceeds the column count, append.
  const clamped = Math.max(0, Math.floor(index));
  let seen = 0;
  let insertAt = state.tasks.length;
  for (let i = 0; i < state.tasks.length; i++) {
    if (state.tasks[i].status !== status) continue;
    if (seen === clamped) {
      insertAt = i;
      break;
    }
    seen++;
  }
  state.tasks.splice(insertAt, 0, task);
  return insertAt;
}

// No-op guards (#23). A redundant patch (doing->doing) or a drag dropped back on
// the card's own slot still ran the apply + broadcast + emitEvent, spuriously
// waking every scoped tail. These predicates let the caller skip the broadcast
// + event when "the resulting state equals current" — checked against the SAME
// logic the apply helpers use, so the two can't drift.

// True when applying `patch` to task `id` would change nothing. Mirrors
// applyTaskUpdate's invalid-status strip so a bogus status-only patch (which the
// apply path drops) reads as the no-op it effectively is. Missing id is NOT a
// no-op — it's "not found", which the apply path reports as applied:false.
function isNoOpUpdate(state: BoardState, id: string, patch: Partial<Task>): boolean {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return false;
  let eff = patch;
  if (eff.status && !VALID_STATUS.includes(eff.status)) {
    const { status: _drop, ...rest } = eff;
    eff = rest;
  }
  return (Object.keys(eff) as (keyof Task)[]).every((k) => task[k] === eff[k]);
}

// True when moving task `id` to (status, index) would leave the board's
// VISIBLE state unchanged — every column's ordered membership identical.
// Simulates the move on a clone via the real applyTaskMove (index-translation
// stays single-sourced), then compares COLUMN views, not raw array order.
// Missing id is NOT a no-op — that's "not found", per the apply path.
function isNoOpMove(state: BoardState, id: string, status: TaskStatus, index: number): boolean {
  if (!state.tasks.some((t) => t.id === id)) return false;
  // Compare COLUMN views, not raw array order: re-dropping the LAST card in a
  // column on its own slot rewrites the absolute array but not the columns —
  // still a no-op to the user.
  const columnView = (s: BoardState) =>
    VALID_STATUS.map((st) =>
      s.tasks
        .filter((t) => t.status === st)
        .map((t) => t.id)
        .join(","),
    ).join("|");
  const before = columnView(state);
  const probe: BoardState = { ...state, tasks: state.tasks.map((t) => ({ ...t })) };
  applyTaskMove(probe, id, status, index);
  return before === columnView(probe);
}

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        title: { type: "string", default: "Bounty Board" },
        timeout: { type: "string", default: "1800" },
        "no-open": { type: "boolean", default: false },
        port: { type: "string", default: "0" },
        host: { type: "string", default: "127.0.0.1" },
        id: { type: "string" },
        restore: { type: "string" }, // snapshot id or path to resume from
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const v = parsed.values;
  const timeout = parseFloat(v.timeout as string);
  let port = parseInt(v.port as string, 10);
  const host = v.host as string;
  let sessionId = (v.id as string | undefined) ?? "";
  if (port === 0 && sessionId) {
    const embedded = parsePortFromSessionId(sessionId);
    if (embedded !== null) port = embedded;
  }

  const template = await Bun.file(join(SCRIPT_DIR, "template.html")).text();
  const assetsDir = join(SCRIPT_DIR, "..", "assets");

  // Initial state — restored from a snapshot (merge-over-defaults) or fresh.
  // Restore loads the snapshot and merges it over the default shape so a snapshot
  // from an older build gains any new top-level fields without crashing; restored
  // tasks run through validateTask (filter-and-keep-valid) so a malformed or
  // legacy entry is dropped, not fatal.
  const state: BoardState = { title: v.title as string, tasks: [] };
  if (v.restore) {
    const restoreArg = v.restore as string;
    const restorePath = existsSync(restoreArg)
      ? restoreArg
      : join(SNAPSHOTS_DIR, `${restoreArg}.json`);
    try {
      const snap = JSON.parse(readFileSync(restorePath, "utf8")) as Partial<BoardState>;
      const merged: BoardState = { title: state.title, tasks: [], ...snap };
      if (typeof merged.title === "string") state.title = merged.title;
      state.tasks = Array.isArray(merged.tasks)
        ? merged.tasks.map(validateTask).filter((t): t is Task => t !== null)
        : [];
    } catch (e) {
      process.stderr.write(
        `bounty: restore failed (${restorePath}): ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
  const sockets = new Set<ServerWebSocket<unknown>>();

  // Append-only event log for the agent's SSE tail (GET /events). Each event
  // gets a monotonic `id` so a (re)connecting tail resumes via ?since=<id>.
  // `cursor` in GET /state is the current `eventSeq` — the resume point.
  const events: Array<Record<string, unknown>> = [];
  let eventSeq = 0;
  const enc = new TextEncoder();
  const sseClients = new Set<ReadableStreamDefaultController>();
  const sseTimers = new Set<ReturnType<typeof setInterval>>();

  // Debounced persistence: a board mutation marks the snapshot dirty; a ~1s
  // timer flushes it, and a final write lands on close. The snapshot is keyed by
  // session id and KEPT on close (it's the resume point for --restore).
  let snapDirty = false;
  const saveSnapshot = () => {
    try {
      mkdirSync(SNAPSHOTS_DIR, { recursive: true });
      writeFileSync(join(SNAPSHOTS_DIR, `${sessionId}.json`), JSON.stringify(state));
    } catch {
      /* persistence is best-effort */
    }
  };
  // Event types that mutate board state — used to set snapDirty centrally (every
  // mutation already emits one of these). Lifecycle frames don't dirty the snap.
  const DIRTYING = new Set([
    "init",
    "task.add",
    "task.update",
    "task.remove",
    "task.toggle",
    "task.move",
    "task.edit",
  ]);

  let resolveDone!: (val: DoneResult) => void;
  let settled = false;
  const done = new Promise<DoneResult>((res) => {
    resolveDone = (v) => {
      if (settled) return;
      settled = true;
      res(v);
    };
  });

  let lastActivity = performance.now();
  const touch = () => {
    lastActivity = performance.now();
  };

  function broadcast(msg: object) {
    const s = JSON.stringify(msg);
    for (const ws of sockets) {
      try {
        ws.send(s);
      } catch {
        /* socket closed */
      }
    }
  }

  // Append a frame to the agent-facing event log and push it to live SSE tails.
  // The monotonic `id` is the resume cursor — it MUST win over any `id` in the
  // payload, so callers that carry a task identifier pass it as `taskId`, never
  // `id` (a bare `id` in `msg` would clobber the cursor under the spread).
  function emitEvent(msg: Record<string, unknown>) {
    const ev = { id: ++eventSeq, ...msg };
    events.push(ev);
    // Every board mutation flows through here — mark the snapshot dirty centrally.
    if (typeof msg.type === "string" && DIRTYING.has(msg.type)) snapDirty = true;
    const frame = enc.encode(`data: ${JSON.stringify(ev)}\n\n`);
    for (const c of sseClients) {
      try {
        c.enqueue(frame);
      } catch {
        /* client gone */
      }
    }
  }

  // GET /events?since=<id> — replay buffered events with id > since, then keep
  // the stream open for live frames + a 15s heartbeat comment. Mirror imago's
  // sseResponse. touch() so an active tail counts as agent activity.
  function sseResponse(url: URL): Response {
    touch();
    const since = parseInt(url.searchParams.get("since") ?? "-1", 10);
    let ref: ReadableStreamDefaultController | null = null;
    let hb: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream({
      start(controller) {
        ref = controller;
        for (const ev of events) {
          if ((ev.id as number) > since) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
          }
        }
        sseClients.add(controller);
        hb = setInterval(() => {
          try {
            controller.enqueue(enc.encode(`: hb\n\n`));
          } catch {
            /* gone */
          }
        }, 15000);
        sseTimers.add(hb);
      },
      cancel() {
        if (hb) {
          clearInterval(hb);
          sseTimers.delete(hb);
        }
        if (ref) sseClients.delete(ref);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // Owner of a task by id (or undefined). Stamped onto task.* event frames so a
  // scoped `cli.ts tail --owner`/`--mine` can filter client-side, and looked up
  // for the cooperative-claim guard.
  const ownerOf = (id: string) => state.tasks.find((t) => t.id === id)?.owner;

  // ── dependencies (Phase D) ──
  // A task is blocked iff it has a blockedBy id pointing at an EXISTING task
  // that isn't done yet. A missing (deleted) or done blocker doesn't block.
  const isBlocked = (task: Task): boolean =>
    (task.blockedBy ?? []).some((bid) => {
      const b = state.tasks.find((t) => t.id === bid);
      return b !== undefined && b.status !== "done";
    });

  // Can `from` reach `target` by following blockedBy edges? Used by the cycle
  // guard: adding edge id→b would close a loop iff b already reaches id. A
  // visited set guards against any pre-existing cycle (there shouldn't be one).
  function canReach(from: string, target: string, seen = new Set<string>()): boolean {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    const task = state.tasks.find((t) => t.id === from);
    return (task?.blockedBy ?? []).some((bid) => canReach(bid, target, seen));
  }

  // Per-task blocked state, so reconcileBlocked can fire `unblocked` exactly on
  // the blocked→unblocked falling edge (never double-fire). Seeded from the
  // initial/restored board so already-blocked tasks don't spuriously fire.
  const prevBlocked = new Map<string, boolean>();
  for (const t of state.tasks) prevBlocked.set(t.id, isBlocked(t));

  // Run after every mutation: for each task, if it just went blocked→unblocked
  // (the last live blocker cleared, or its last live edge was removed) AND it
  // isn't itself done, fire a targeted `unblocked` event to its owner. Broad
  // O(n) walk — one mutation can unblock many tasks; board scale makes it free.
  function reconcileBlocked() {
    for (const task of state.tasks) {
      const now = isBlocked(task);
      const was = prevBlocked.get(task.id) ?? false;
      if (was && !now && task.status !== "done") {
        emitEvent({ type: "unblocked", taskId: task.id, owner: task.owner, by: "system" });
      }
      prevBlocked.set(task.id, now);
    }
  }

  // The /state projection — adds DERIVED, agent-facing fields per task, computed
  // at serialize time (NOT stored, NOT snapshotted; canonical state keeps raw
  // `blockedBy`). This is the readback-parity layer: an agent reading `state`
  // sees the same blocked-ness the surface renders as ⛔ — `blocked` plus the
  // LIVE blockers (exist && not done) with their title+status, so a task that's
  // been filtered down by `state --mine` is still actionable (the blocker may be
  // owned by someone else and thus absent from the filtered view).
  function projectState() {
    return {
      title: state.title,
      tasks: state.tasks.map((task) => {
        const liveBlockers = (task.blockedBy ?? [])
          .map((bid) => state.tasks.find((t) => t.id === bid))
          .filter((b): b is Task => b !== undefined && b.status !== "done")
          .map((b) => ({ id: b.id, title: b.title, status: b.status }));
        return { ...task, blocked: liveBlockers.length > 0, liveBlockers };
      }),
    };
  }

  // Single dispatch point for an agent command (POST /cmd body). Mutates the
  // canonical state via the apply* helpers, broadcasts to the WS clients, and
  // appends an event frame. Returns an apply-result so the CLI can confirm a
  // write took (a rejected cooperative claim returns applied:false + a reason).
  // `by` carries the caller's --as identity (cooperative attribution, never an
  // auth boundary); task.* frames carry the affected task's owner.
  function handleAgentMsg(msg: AgentMsg): ApplyResult {
    const by = typeof msg.as === "string" ? msg.as : "agent";
    if (msg.type === "init") {
      if (typeof msg.title === "string") state.title = msg.title;
      // Filter-and-keep-valid: drop malformed tasks, keep the well-formed ones
      // (the /cmd body is untrusted — `body as AgentMsg` is a cast, not a check).
      // Route through applyTaskAdd so a freshly-seeded task gets a baseline
      // transition stamp (and a restored one keeps its preserved history).
      if (Array.isArray(msg.tasks)) {
        state.tasks = [];
        for (const task of msg.tasks.map(validateTask)) if (task) applyTaskAdd(state, task);
      }
      broadcast({ type: "init", title: state.title, tasks: state.tasks });
      emitEvent({ type: "init", title: state.title, by });
      return { ok: true, applied: true };
    } else if (msg.type === "task.add") {
      const task = validateTask(msg.task);
      if (task && applyTaskAdd(state, task)) {
        broadcast({ type: "task.add", task });
        emitEvent({ type: "task.add", task, by, owner: task.owner });
        return { ok: true, applied: true };
      }
      return { ok: true, applied: false };
    } else if (msg.type === "task.update") {
      // Cooperative-claim guard: a claim can't steal an already-owned task. The
      // lead's `update --owner` (no claim flag) always wins — that's the
      // reassignment path. Claiming a task you already own is a no-op success.
      if (msg.claim) {
        const existing = state.tasks.find((t) => t.id === msg.id);
        const claimant = typeof msg.as === "string" ? msg.as : undefined;
        if (existing?.owner && existing.owner !== claimant) {
          return {
            ok: true,
            applied: false,
            error: `task ${msg.id} is owned by ${existing.owner}`,
          };
        }
      }
      // `blockedBy` is mutated ONLY via task.block/task.unblock (which run the
      // cycle guard). Strip it from a raw update patch so /cmd can't sidestep
      // the guard — keep the guard load-bearing.
      const { blockedBy: _stripped, ...patch } = msg.patch;
      // Sanitize tags on the way in (#18) so a raw /cmd can't store a dirty
      // list. Keep an empty array (it's an explicit clear via `--tag ""`) — a
      // later snapshot/restore normalizes [] away through validateTask.
      if ("tags" in patch) patch.tags = cleanTags(patch.tags);
      // Drop a malformed size/expect from a raw /cmd patch (#29) — keep the
      // sizing fields canonical, mirroring validateTask's leniency.
      if ("size" in patch && !(typeof patch.size === "string" && patch.size in SIZE_MINUTES)) {
        delete patch.size;
      }
      if ("expect" in patch && !(typeof patch.expect === "number" && patch.expect > 0)) {
        delete patch.expect;
      }
      // No-op guard (#23): a redundant patch (e.g. a maestro re-issuing
      // doing->doing) must not broadcast or wake scoped tails. Exempt a `claim`
      // — re-claiming a task you already own is a no-op state-wise but still
      // wants its applied:true confirmation, which cli.ts `claim` reads.
      if (!msg.claim && isNoOpUpdate(state, msg.id, patch)) {
        return { ok: true, applied: false };
      }
      if (applyTaskUpdate(state, msg.id, patch)) {
        broadcast({ type: "task.update", id: msg.id, patch });
        // Post-change owner = "who owned it when this happened" (owner-at-emit).
        emitEvent({ type: "task.update", taskId: msg.id, patch, by, owner: ownerOf(msg.id) });
        return { ok: true, applied: true };
      }
      return { ok: true, applied: false };
    } else if (msg.type === "task.remove") {
      const owner = ownerOf(msg.id); // before removal
      if (applyTaskRemove(state, msg.id)) {
        broadcast({ type: "task.remove", id: msg.id });
        emitEvent({ type: "task.remove", taskId: msg.id, by, owner });
        return { ok: true, applied: true };
      }
      return { ok: true, applied: false };
    } else if (msg.type === "task.block") {
      const task = state.tasks.find((t) => t.id === msg.id);
      if (!task) return { ok: true, applied: false, error: `no such task ${msg.id}` };
      // Cycle/self-ref guard: reject the WHOLE command if any proposed edge
      // would close a loop. New edges all originate at `id` (out-edges), so a
      // back-path can only run through existing edges — a per-edge canReach
      // against the current graph is sufficient.
      for (const b of msg.on) {
        if (canReach(b, msg.id)) {
          return { ok: true, applied: false, error: `would create a cycle: ${msg.id} → ${b}` };
        }
      }
      const next = Array.from(new Set([...(task.blockedBy ?? []), ...msg.on]));
      applyTaskUpdate(state, msg.id, { blockedBy: next });
      broadcast({ type: "task.update", id: msg.id, patch: { blockedBy: next } });
      emitEvent({
        type: "task.update",
        taskId: msg.id,
        patch: { blockedBy: next },
        by,
        owner: task.owner,
      });
      return { ok: true, applied: true };
    } else if (msg.type === "task.unblock") {
      const task = state.tasks.find((t) => t.id === msg.id);
      if (!task) return { ok: true, applied: false, error: `no such task ${msg.id}` };
      const next = (task.blockedBy ?? []).filter((b) => !msg.on.includes(b));
      applyTaskUpdate(state, msg.id, { blockedBy: next });
      broadcast({ type: "task.update", id: msg.id, patch: { blockedBy: next } });
      emitEvent({
        type: "task.update",
        taskId: msg.id,
        patch: { blockedBy: next },
        by,
        owner: task.owner,
      });
      return { ok: true, applied: true };
    } else if (msg.type === "message") {
      broadcast({ type: "message", text: msg.text });
      return { ok: true, applied: true };
    } else if (msg.type === "close") {
      resolveDone({ code: 0, reason: "close" });
      return { ok: true, applied: true };
    }
    return { ok: true, applied: false };
  }

  let pageHtml = "";
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      fetch: (req, srv) => {
        const url = new URL(req.url);
        const path = url.pathname;
        if (req.method === "GET" && path === "/") {
          return new Response(pageHtml, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        if (path === "/ws") {
          const upgraded = srv.upgrade(req);
          if (upgraded) return undefined;
          return new Response("upgrade required", { status: 426 });
        }
        // Agent read-back: current board state + the resume cursor. `?lean=1`
        // is the default the CLI uses; Bounty has no large blobs so lean ≈ full
        // today — the shape is kept for house consistency + forward-compat.
        // touch() so agent reads count as activity (idle-touch, #6).
        if (req.method === "GET" && path === "/state") {
          touch();
          return new Response(JSON.stringify({ state: projectState(), cursor: eventSeq }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        // Agent live tail: SSE stream of the event log, resumable via ?since=.
        if (req.method === "GET" && path === "/events") {
          return sseResponse(url);
        }
        // Agent write path: dispatch a single AgentCommand into the canonical
        // state. Replaces the stdin JSON-lines reader (retired at the parity
        // gate). touch() so writes count as activity (idle-touch, #6).
        if (req.method === "POST" && path === "/cmd") {
          return req
            .json()
            .then((body) => {
              touch();
              const result = handleAgentMsg(body as AgentMsg);
              reconcileBlocked(); // fire `unblocked` for any blocked→unblocked transition
              return new Response(JSON.stringify(result), {
                headers: { "Content-Type": "application/json" },
              });
            })
            .catch(
              () =>
                new Response('{"error":"bad json"}', {
                  status: 400,
                  headers: { "Content-Type": "application/json" },
                }),
            );
        }
        if (req.method === "GET" && path.startsWith("/assets/")) {
          const assetName = decodeURIComponent(path.slice("/assets/".length));
          // Path-traversal guard: reject any ".." segment or absolute path.
          if (assetName.includes("..") || assetName.startsWith("/")) {
            return new Response('{"error":"not found"}', {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }
          const f = Bun.file(join(assetsDir, assetName));
          return f.exists().then((exists) =>
            exists
              ? new Response(f, { headers: { "Content-Type": guessMime(assetName) } })
              : new Response('{"error":"not found"}', {
                  status: 404,
                  headers: { "Content-Type": "application/json" },
                }),
          );
        }
        return new Response('{"error":"not found"}', {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
          touch();
          emitEvent({ type: "connected", by: "user" });
          ws.send(JSON.stringify({ type: "init", title: state.title, tasks: state.tasks }));
        },
        message(_ws, raw) {
          touch();
          let msg: BrowserMsg;
          try {
            msg = JSON.parse(
              typeof raw === "string" ? raw : new TextDecoder().decode(raw),
            ) as BrowserMsg;
          } catch (e) {
            process.stderr.write(
              `bounty: bad json from browser: ${e instanceof Error ? e.message : String(e)}\n`,
            );
            return;
          }
          if (msg.type === "task.toggle") {
            if (!VALID_STATUS.includes(msg.status)) return;
            // No-op guard (#23): a redundant pill click (doing->doing) skips.
            if (isNoOpUpdate(state, msg.id, { status: msg.status })) return;
            if (applyTaskUpdate(state, msg.id, { status: msg.status })) {
              broadcast({ type: "task.update", id: msg.id, patch: { status: msg.status } });
              emitEvent({
                type: "task.toggle",
                taskId: msg.id,
                status: msg.status,
                by: "user",
                owner: ownerOf(msg.id),
              });
            }
          } else if (msg.type === "task.move") {
            if (!VALID_STATUS.includes(msg.status)) return;
            // No-op guard (#23): a drag dropped back on the card's own slot
            // (same column membership + order) skips the broadcast + event.
            if (isNoOpMove(state, msg.id, msg.status, msg.index)) return;
            if (applyTaskMove(state, msg.id, msg.status, msg.index) !== -1) {
              // Broadcast the full ordered list — simpler than diffing for
              // browsers, and it covers the source-column shift correctly.
              broadcast({ type: "init", title: state.title, tasks: state.tasks });
              emitEvent({
                type: "task.move",
                taskId: msg.id,
                status: msg.status,
                index: msg.index,
                by: "user",
                owner: ownerOf(msg.id),
              });
            }
          } else if (msg.type === "task.edit") {
            // One verb covers both the inline title edit and the detail modal's
            // description edit (#19): {id, title?, notes?}. Re-sanitize each
            // field — a malformed edit must not corrupt canonical state:
            //   title — if present, a non-empty trimmed string (empty titles
            //     surface to the agent as unreadable labels);
            //   notes — if present, a string (empty IS allowed — it clears the
            //     description). Both render via x-text, never x-html.
            const patch: Partial<Task> = {};
            if (msg.title !== undefined) {
              if (typeof msg.title !== "string" || msg.title.trim() === "") return;
              patch.title = msg.title;
            }
            if (msg.notes !== undefined) {
              if (typeof msg.notes !== "string") return;
              patch.notes = msg.notes;
            }
            if (Object.keys(patch).length === 0) return; // nothing to edit
            if (applyTaskUpdate(state, msg.id, patch)) {
              broadcast({ type: "task.update", id: msg.id, patch });
              emitEvent({
                type: "task.edit",
                taskId: msg.id,
                ...patch,
                by: "user",
                owner: ownerOf(msg.id),
              });
            }
          } else if (msg.type === "task.add") {
            // Shape-validate the untrusted browser task via the shared boundary.
            const task = validateTask(msg.task);
            if (task && applyTaskAdd(state, task)) {
              broadcast({ type: "task.add", task });
              emitEvent({ type: "task.add", task, by: "user", owner: task.owner });
            }
          } else if (msg.type === "task.remove") {
            const owner = ownerOf(msg.id); // before removal
            if (applyTaskRemove(state, msg.id)) {
              broadcast({ type: "task.remove", id: msg.id });
              emitEvent({ type: "task.remove", taskId: msg.id, by: "user", owner });
            }
          } else if (msg.type === "close") {
            // The human dismisses the board ("Close board"). A clean dismiss —
            // exit 0, never the old "cancel" 130. There's no submit-as-flush:
            // the daemon already holds (and snapshots) canonical state and every
            // change was live to all consumers, so dismissing loses nothing. The
            // teardown's "session ended" broadcast + socket close is the uniform
            // end signal every client (browser + joiners) receives.
            resolveDone({ code: 0, reason: "user" });
          }
          // A browser action (e.g. dragging a blocker to Done) can unblock
          // dependents — fire `unblocked` for any transition.
          reconcileBlocked();
        },
        close(ws) {
          sockets.delete(ws);
          emitEvent({ type: "disconnected", by: "user" });
        },
      },
    });
  } catch (e) {
    process.stderr.write(
      `${JSON.stringify({
        event: "bind_error",
        host,
        port,
        error: e instanceof Error ? e.message : String(e),
      })}\n`,
    );
    return 2;
  }

  const boundPort = server.port;
  if (!sessionId) sessionId = `bounty-${randHex(4)}-p${boundPort}`;
  const wsUrl = `ws://${host}:${boundPort}/ws`;
  // Two contexts for substitutions:
  //   - HTML/text contexts (the visible <h1>, <title>, <code>): use htmlEscape.
  //   - JS string context (the wsUrl literal inside <script>): use
  //     JSON.stringify, which produces a properly-quoted JS string literal.
  //     The template uses bare placeholders (no surrounding quotes) for the
  //     JS-context substitutions so JSON.stringify provides them.
  pageHtml = template
    .replace(/__TITLE__/g, htmlEscape(state.title))
    .replace(/__SESSION_ID__/g, htmlEscape(sessionId))
    .replace(/__WS_URL__/g, JSON.stringify(wsUrl));

  const url = `http://${host}:${boundPort}`;
  // First frame on the event log (id 1) — bookends the stream with `closed`.
  emitEvent({ type: "ready", url, port: boundPort, session_id: sessionId, by: "system" });

  // Discovery: write session info to predictable temp files so joining
  // agents can find this board without copy-paste. Two files:
  //   - bounty-<session_id>.json  (specific lookup by --id)
  //   - bounty-latest.json        (always overwritten by most recent
  //                                   host; default target for joiners)
  const sessionFile = join(tmpdir(), `bounty-${sessionId}.json`);
  const latestFile = join(tmpdir(), `bounty-latest.json`);
  const sessionInfo = JSON.stringify({
    url,
    port: boundPort,
    session_id: sessionId,
    title: state.title,
  });
  try {
    writeFileSync(sessionFile, sessionInfo);
    writeFileSync(latestFile, sessionInfo);
  } catch (e) {
    // Discovery files are nice-to-have, not load-bearing. Log to stderr
    // and continue — the session id printed to stdout still lets the
    // user paste a URL into a joining agent manually.
    process.stderr.write(
      `bounty: could not write discovery file: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
  // Best-effort cleanup on exit. Won't fire on SIGKILL, but stale files
  // produce a clean "session not running" error when a joiner connects.
  // The `latest` pointer is only removed if it still names us — otherwise
  // a newer host has taken over the slot and we leave its pointer alone.
  const cleanupDiscovery = async () => {
    try {
      unlinkSync(sessionFile);
    } catch {}
    try {
      const cur = await Bun.file(latestFile).text();
      const parsed = JSON.parse(cur);
      if (parsed.session_id === sessionId) unlinkSync(latestFile);
    } catch {
      /* file gone or unreadable — fine */
    }
  };

  if (!v["no-open"]) openBrowser(url);

  const idleTimer = setInterval(() => {
    if ((performance.now() - lastActivity) / 1000 >= timeout) {
      resolveDone({ code: 124, reason: "timeout" });
    }
  }, 250);

  // Debounced snapshot — flush ~1s after any board mutation so a crash mid-
  // session is recoverable via --restore.
  const snapTimer = setInterval(() => {
    if (snapDirty) {
      snapDirty = false;
      saveSnapshot();
    }
  }, 1000);

  // Heartbeat (#29): sweep doing tasks for overruns and poke. computeDuePokes is
  // the pure decision; here we just fire what it returns — an owner-scoped
  // `heartbeat` event (only the owner's scoped tail wakes, like `unblocked`) plus
  // a board toast so the human sees staleness too. An unowned overdue task gets
  // the toast only (no owner to wake). A poke never dirties the snapshot.
  let pokeState: PokeState = new Map();
  const heartbeatTimer = setInterval(() => {
    const swept = computeDuePokes(state.tasks, pokeState, Date.now());
    pokeState = swept.pokeState;
    for (const p of swept.pokes) {
      const label = state.tasks.find((t) => t.id === p.taskId)?.title ?? p.taskId;
      const overdueMin = Math.max(1, Math.round(p.overdueByMs / 60_000));
      if (p.owner) {
        emitEvent({
          type: "heartbeat",
          taskId: p.taskId,
          owner: p.owner,
          overdueByMs: p.overdueByMs,
          expectedMinutes: p.expectedMinutes,
          by: "system",
        });
      }
      broadcast({
        type: "message",
        text: `⏰ "${label}" overdue — ~${overdueMin}m past its ${p.expectedMinutes}m estimate${p.owner ? ` (@${p.owner})` : ""}`,
      });
    }
  }, 30_000);

  const { code, reason } = await done;
  clearInterval(idleTimer);
  clearInterval(snapTimer);
  clearInterval(heartbeatTimer);
  saveSnapshot(); // final write — KEEP it (the resume point, not deleted on close)
  // Closing frame on the event log — ends a `cli.ts tail` (exit 0) and bookends
  // the `ready` that opened it.
  emitEvent({ type: "closed", reason, by: "system" });
  broadcast({ type: "message", text: `session ended: ${reason}` });
  // Grace period: server.stop(true) aggressively aborts in-flight
  // connections, which can drop a broadcast that was queued microseconds
  // earlier (the submit/cancel broadcasts in the WS message handlers
  // immediately precede this teardown). Pause briefly so the OS-level
  // socket buffers flush before we tear down. 150ms is enough on a
  // local connection; small enough that "session ended" feels responsive.
  await new Promise((r) => setTimeout(r, 150));
  for (const t of sseTimers) clearInterval(t);
  for (const c of sseClients) {
    try {
      c.close();
    } catch {}
  }
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {}
  }
  await Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 200))]);
  await cleanupDiscovery();
  return code;
}

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exit(exitCode);
}

export type { BoardState, Task, TaskStatus };
export {
  applyTaskAdd,
  applyTaskMove,
  applyTaskRemove,
  applyTaskUpdate,
  cleanTags,
  computeDuePokes,
  expectedMinutes,
  htmlEscape,
  isNoOpMove,
  isNoOpUpdate,
  main,
  parsePortFromSessionId,
  validateTask,
};
