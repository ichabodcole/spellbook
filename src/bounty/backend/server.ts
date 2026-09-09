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
//     synthetic init on connect. That init carries `restoreFailed` (b16) so the
//     human channel can report a broken restore — the agent already had it on
//     the `open` payload and GET /state, and the browser is the only channel
//     where an unexplained empty board is what a person actually SEES.
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

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ServerWebSocket } from "bun";
import {
  expectedMinutes,
  isBlocked,
} from "../../../plugins/spellbook/skills/bounty/shared/predicates";
// The seam (2026-09-06). Types and the four board predicates live one level up,
// in the tracked skill subtree, so the React surface at src/bounty/ imports the
// SAME code the daemon runs instead of hand-mirroring it in the page. `shared/`
// is inside what the marketplace copies, so this resolves at the destination
// with nothing installed (seams Contract 3, row 1).
import type {
  BoardState,
  StatusVisit,
  Task,
  TaskSize,
  TaskStatus,
} from "../../../plugins/spellbook/skills/bounty/shared/types";
import { SIZE_MINUTES } from "../../../plugins/spellbook/skills/bounty/shared/types";
import { unlinkIfMatches, writeFileAtomic } from "../../kit/wire/discovery.ts";
import { createEventLog } from "../../kit/wire/eventLog.ts";
import { drainAndStop, shouldIdleClose, startHousekeeping } from "../../kit/wire/housekeeping.ts";
import { resolveMode as resolveModeIn, serveFromDist } from "../../kit/wire/serveDist.ts";
import { sseResponse as kitSseResponse, type SseClients } from "../../kit/wire/sse.ts";
import { IDLE_TIMEOUT_SEC, SSE_HEARTBEAT_MS } from "./heartbeat.ts";

// The board's HTML used to be `scripts/template.html`, read at boot and string
// substituted before every response. It is now a React surface at
// src/bounty/surface/, built into dist/ (seams Contract 2). The dev entry is a
// DYNAMIC import reached only on the dev branch: a static one would force Bun
// to resolve the whole .tsx + Tailwind graph when this module LOADS, so the
// published artifact — which ships dist/ and no surface source — would die
// before it could serve the dist it does have (Contract 1).
//
// Paths anchor at the SKILL ROOT, never at cwd: cli.ts pins the daemon's cwd to
// src/bounty/ in dev for bunfig.toml's sake (Contract 5), so cwd is not a
// stable base for dist/.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(SCRIPT_DIR, "..");
const DIST_DIR = join(SKILL_ROOT, "dist");

// release iff dist/index.html exists at the skill root — the FILE, never the
// directory (a built backend can put cli.js in dist/ with no surface there) —
// else dev; the env override wins either way (Contract 1). Release: zero reads
// of surface source or bunfig.toml, static files only.
//
// ⛔ THE DECISION IS `src/kit/wire/serveDist.ts`'s NOW, not a local copy. This
// function is the thin wrapper that supplies the one thing the kit cannot know
// — WHICH `dist/` — and exists only because `server.test.ts` and the surface
// mode probe both call `resolveMode()` with no argument.
export function resolveMode(): "dev" | "release" {
  return resolveModeIn(DIST_DIR);
}

// Serves dist/ verbatim — the unhashed entry index.html at "/", and the hashed
// index-*.js / index-*.css it links RELATIVELY, which from "/" arrive as bare
// filenames (Contract 2's flat layout).
//
// ⛔ THE ONE-LEVEL GUARD IS LOAD-BEARING FOR BOUNTY IN A WAY IT IS NOT FOR ANY
// OTHER ADOPTER, AND `release-serve.test.ts` HAS A CELL FOR IT. bounty is the
// only ported spell whose daemon serves BOTH a flat `dist/` at the root AND its
// own `GET /assets/<name>` route out of the skill folder (the wordmark, the two
// mascots, the favicon — not build inputs). Every `/assets/` path is NESTED, so
// `serveFromDist` refuses it and it falls through to the asset handler. A
// widened guard in the kit would shadow that route with a 404 and nothing else
// would notice — which is why the disjointness is asserted rather than assumed.
//
// The local `STATIC_CONTENT_TYPES` map went with the file half; `contentTypeFor`
// is the kit's, and it is a superset of what bounty listed.
function serveDist(path: string): Response | null {
  return serveFromDist(DIST_DIR, path === "/" ? "index.html" : path.slice(1));
}

// Persistence root: debounced snapshots land in $BOUNTY_HOME/snapshots/<id>.json
// so a board survives a restart via `cli.ts open --restore <id>`. cli.ts derives
// the same path, so override BOUNTY_HOME to relocate both.
const BOUNTY_HOME = process.env.BOUNTY_HOME ?? join(homedir(), ".bounty");
const SNAPSHOTS_DIR = join(BOUNTY_HOME, "snapshots");
// P1f — how long the teardown gets after a signal before the watchdog forces
// the exit. Generous on purpose: it is a HANG backstop, not a deadline, and
// the teardown's own bounded waits (150ms + a 200ms race) total well under it.
// Env-overridable for tests only.
const SHUTDOWN_WATCHDOG_MS = Number(process.env.BOUNTY_SHUTDOWN_WATCHDOG_MS ?? 5000);

// Durable, append-only diagnostics log (#64). The daemon runs headless — cli.ts
// `open` spawns it with stdout/stderr discarded — so a death (idle-close, crash,
// signal) currently leaves no trace. Every lifecycle transition appends ONE JSON
// line here; cli.ts additionally points the child's native stderr at this same
// file so Bun's own hard-abort output (which JS handlers can't catch) lands too.
// Diagnostics only — no board behavior reads this.
const DAEMON_LOG = join(BOUNTY_HOME, "daemon.log");

// Cap the per-task transition log so long-lived tasks don't bloat snapshots.
const MAX_STATUS_HISTORY = 20;

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
    if (isBlocked(task, tasks)) continue; // legitimately waiting on a peer — not stuck
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

// open-timeout: the idle-close decision, now `src/kit/wire/housekeeping.ts`'s.
//
// ⛔ THIS ADOPTION IS BOUNTY MEETING ITS OWN CODE. The census made bounty's
// `shouldIdleClose` convergence target #3 and the kit's copy IS this function —
// clock-free, subscriber-aware, with the "linger this long after the LAST
// subscriber leaves" scar re-homed verbatim in substance. `subscriberCount` is
// a REQUIRED argument there, which is what closes L1 for the three spells that
// had it wrong; bounty was one of the two that already had it right.
//
// ⚠ AND EXACTLY ONE THING CAME BACK THE OTHER WAY — astrolabe's
// `timeoutMs <= 0` guard, which bounty's copy does not express. It is a
// BEHAVIOUR CHANGE at one input and it is named rather than smuggled:
// `--timeout 0` used to mean "close on the first idle tick" and now means
// NEVER. Nothing documents 0 as a value and nothing in the suite drives it; the
// old reading is the accidental one (a `>= 0` comparison closing a board the
// moment nobody is looking), the new one is the standing-observatory default
// the guard was written for. Driven both ways — see the session doc.
// (re-exported at the foot of this file with the rest of the test surface)

// #73/#74 — how many tasks the ON-DISK snapshot holds, or null when we cannot
// honestly say. Absent, unparseable, or a non-array `tasks` all return null and
// NOT zero: zero would mean "a snapshot exists and holds nothing", which makes a
// first-ever write look like a shrink from an empty board, and makes a
// half-written file report every later write as data loss. null declines to
// answer, and the predicate below treats declining as "do not rotate".
function snapshotTaskCount(path: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { tasks?: unknown };
    return Array.isArray(parsed.tasks) ? parsed.tasks.length : null;
  } catch {
    return null;
  }
}

// #73/#74 — should this snapshot write copy the existing file aside first?
// Clock-free and fs-free so it is testable without a daemon (the shouldIdleClose
// shape).
//
// ⛔ THE PREDICATE IS SHRINKAGE, NOT EMPTINESS. Both issues ask for a guard
// against writing an EMPTY board over a populated snapshot. That does not cover
// what was measured: a keyed respawn over a dead board starts empty, and then
// ONE `add` — no `close` anywhere — flushed 3 tasks down to 1 through the
// debounced path. An emptiness guard permits that write, because 1 is not 0.
// Emptiness is the WORST CASE of this predicate, never a separate branch.
//
// ⛔ AND IT IS ONCE PER DAEMON SESSION. Writes happen per MUTATION, so a human
// draining a board card-by-card produces one shrinking write each. Rotating
// per-write with any retention bound N means rotation N+1 evicts the pre-drain
// snapshot — the guard eats what it protects. Rotating on the FIRST shrink since
// boot captures the state that existed before this daemon touched anything,
// which is precisely what #73 and #74 wanted back, and it needs no retention
// policy at all.
function shouldRotateSnapshot(
  priorTaskCount: number | null,
  nextTaskCount: number,
  alreadyRotatedThisSession: boolean,
): boolean {
  if (alreadyRotatedThisSession) return false;
  if (priorTaskCount === null) return false; // nothing readable to protect
  return nextTaskCount < priorTaskCount;
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

// P1f adds "signal": a daemon killed by SIGTERM/SIGINT now runs the teardown
// and its `closed` frame says so. Borrowing "close" would have been a
// success-shaped lie — a consumer cannot tell an orderly shutdown from a kill.
type CloseReason = "user" | "timeout" | "close" | "signal";
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

// b8 — WHY a task is rejected, as the SINGLE source of the rules.
//
// `init --stdin-tasks` filters-and-keeps-valid and reported nothing: 18
// well-formed-LOOKING tasks were posted at convene, every one was dropped for a
// missing caller-supplied `id`, and the envelope answered {ok:true,
// applied:true} with a board of zero. The asymmetry is invisible from the
// outside because `add` MINTS an id for you and `init` does not, while the help
// said only "tasks = JSON array on stdin".
//
// The reason lives HERE rather than being re-derived at the call site: a second
// copy of these conditions is the mirror-drift trap this repo has shipped twice
// (the bounty surface mirror, and `propose-node --stdin` dropping tags). One
// list, two readers.
function taskRejection(t: unknown): string | null {
  if (!t || typeof t !== "object") return "not a JSON object";
  const cand = t as Record<string, unknown>;
  if (typeof cand.id !== "string")
    return "missing `id` (string, REQUIRED — init does not mint ids; `add` does)";
  if (typeof cand.title !== "string") return "missing `title` (string, required)";
  if (typeof cand.status !== "string" || !VALID_STATUS.includes(cand.status as TaskStatus))
    return `invalid \`status\` (required, one of ${VALID_STATUS.join(" | ")})`;
  if (cand.notes !== undefined && typeof cand.notes !== "string") return "`notes` must be a string";
  if (cand.owner !== undefined && typeof cand.owner !== "string") return "`owner` must be a string";
  if (
    cand.blockedBy !== undefined &&
    (!Array.isArray(cand.blockedBy) || cand.blockedBy.some((x) => typeof x !== "string"))
  )
    return "`blockedBy` must be an array of strings";
  return null;
}

function validateTask(t: unknown): Task | null {
  if (taskRejection(t) !== null) return null;
  const cand = t as Record<string, unknown>;
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
        timeout: { type: "string", default: "7200" },
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

  // Diagnostics (#64): append ONE structured JSON line per lifecycle event to
  // $BOUNTY_HOME/daemon.log. Closes over `sessionId` (read at call time, so a
  // pre-bind crash logs "" and a post-bind one logs the real id). The whole
  // write is wrapped so logging can NEVER throw inside the daemon. Date/new Date
  // is fine here — this is the daemon process, not a workflow script.
  const logDaemon = (reason: string, extra?: Record<string, unknown>) => {
    try {
      mkdirSync(BOUNTY_HOME, { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        session_id: sessionId,
        pid: process.pid,
        reason,
        ...extra,
      });
      appendFileSync(DAEMON_LOG, `${line}\n`);
    } catch {
      /* diagnostics must never crash or throw in the daemon */
    }
  };

  // P1f — signal deaths now run the TEARDOWN instead of pre-empting it.
  //
  // The defect these handlers used to be: `process.exit` here fires immediately,
  // so `await done` below NEVER resolves and the entire teardown block is
  // unreachable — no final snapshot, no `closed` frame, no discovery cleanup.
  // That ONE fact is P1f's defect (156 of 226 recorded deaths emitted no `closed`
  // frame) and a pair of P0f exit sites at once.
  //
  // ⛔ THE HAZARD, AND WHY THIS IS NOT THE `join.ts` SCAR. `process.exit` in a
  // signal handler does DOUBLE DUTY: it runs the teardown's job (ending) AND
  // skips the teardown. Removing it to gain the teardown can LOSE THE ENDING —
  // which shipped a 23-minute hang in a released spell once already.
  //
  // Two things make the ending safe here, and neither is "the teardown is
  // well-behaved":
  //   1. The terminal `process.exit(exitCode)` at `import.meta.main` STAYS. This
  //      change does not swap an exit for a natural return; it only redirects
  //      the signal path INTO the bounded teardown that already precedes that
  //      exit. Every await in that block is bounded (a 150ms sleep, a
  //      Promise.race with a 200ms cap, fs work).
  //   2. A WATCHDOG, below, force-exits if the teardown does not finish. So
  //      termination is guaranteed by construction rather than by the teardown
  //      being correct — the property a gate can actually assert.
  //
  // `requestShutdown` is a mutable hook because these handlers must be installed
  // BEFORE the work they guard, while `done`/`sockets`/`sseClients` do not exist
  // until later. Until it is assigned, a signal falls back to the old immediate
  // exit — a signal during startup MUST still kill the process, and pretending
  // otherwise would introduce a hang in exactly the window with nothing to save.
  let requestShutdown: ((code: number, reason: string, signal: string) => void) | null = null;
  const onFatal = (signal: string, code: number) => () => {
    if (requestShutdown) requestShutdown(code, "signal", signal);
    else {
      logDaemon("signal", { signal, phase: "pre-init" });
      process.exit(code);
    }
  };
  process.on("uncaughtException", (e) => {
    logDaemon("uncaughtException", {
      error: String(e),
      stack: e instanceof Error ? e.stack : undefined,
    });
    // NOT routed through the teardown. An uncaught exception means invariants
    // are already unknown, and the teardown WRITES THE SNAPSHOT — flushing
    // possibly-corrupt state over a good one is the #73 failure with extra
    // steps. Dying loudly and leaving the last good snapshot is correct here.
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    logDaemon("unhandledRejection", { error: String(e) });
  });
  process.on("SIGTERM", onFatal("SIGTERM", 143));
  process.on("SIGINT", onFatal("SIGINT", 130));

  // Resolved BEFORE any filesystem write. A forced-dev boot at a surface-free
  // destination must die HERE, at the import, having written nothing: no
  // snapshot, no discovery file — so a CLI polling for the session file sees a
  // clean failure rather than a half-born daemon.
  const mode = resolveMode();
  // dev: Bun bundles the .tsx graph + Tailwind at serve time, reading
  // bunfig.toml from cwd, which cli.ts pins to src/bounty/ (Contract 5).
  // release: dist/ is static and pre-built — "/" is answered by serveDist() in
  // the fetch handler, so this branch never touches surface source or
  // bunfig.toml and never needs either to exist. This is the ONE src/-naming
  // specifier in the deployed spell (grimoire/import-boundary-wards.test.ts
  // pins it).
  //
  // ⛔ THE FAILURE MUST NAME THE SURFACE. This daemon installs an
  // `uncaughtException` handler that logs to $BOUNTY_HOME/daemon.log and exits
  // 1 WITHOUT touching stderr — correct for a mid-flight invariant break, and
  // exactly wrong here: a forced-dev boot at a surface-free destination then
  // dies with no output at all, and the operator has no way to tell it from a
  // missing `bun`. Measured on the local-sim before this catch existed: exit 1,
  // stdout empty, stderr empty.
  let devIndex: unknown;
  if (mode === "dev") {
    try {
      devIndex = (await import("../../../../../src/bounty/surface/index.html")).default;
    } catch (e) {
      process.stderr.write(
        "bounty: cannot start in dev mode — the surface source is missing.\n" +
          "  needed: src/bounty/surface/index.html (relative to the repo root)\n" +
          `  reason: ${e instanceof Error ? e.message : String(e)}\n` +
          "  A published spell ships a built dist/ and resolves to release mode; dev mode\n" +
          "  needs the repo. Unset SPELLBOOK_SURFACE_MODE, or run from a checkout.\n",
      );
      return 2;
    }
  }
  const routes = (devIndex ? { "/": devIndex } : {}) as Record<string, never>;
  const assetsDir = join(SCRIPT_DIR, "..", "assets");

  // Initial state — restored from a snapshot (merge-over-defaults) or fresh.
  // Restore loads the snapshot and merges it over the default shape so a snapshot
  // from an older build gains any new top-level fields without crashing; restored
  // tasks run through validateTask (filter-and-keep-valid) so a malformed or
  // legacy entry is dropped, not fatal.
  const state: BoardState = { title: v.title as string, tasks: [] };
  // b15 — present-and-null on every boot: null means "no restore failed", never
  // "this daemon does not report restore failures".
  let restoreFailed: { path: string; reason: string } | null = null;
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
      // b15 — A RESTORE THAT WAS ATTEMPTED AND FAILED USED TO BE INVISIBLE.
      // This branch wrote to the DAEMON'S stderr, and cli.ts spawns the daemon
      // with stderr pointed at a log file the caller never reads — then it
      // CONTINUED with the empty default board. An empty board, exit 0, and
      // nothing in any envelope saying a restore had even been tried.
      //
      // ⚠ MY OWN fb209f1 WIDENED THIS. Before it, only an explicit `--restore`
      // reached here; now EVERY keyed respawn passes --restore, so a corrupt
      // snapshot silently yields an empty board on the common path. b7's defect,
      // recreated by b7's fix, on the error branch.
      //
      // Distinct from `restoreSkipped`, ruled to mean "your EXPLICIT --restore
      // was valid and the situation could not honour it" — never attempted.
      // This one WAS attempted and broke. Same envelope shape, opposite remedy:
      // skipped means fix your situation, failed means your snapshot is damaged
      // and here is the path.
      restoreFailed = {
        path: restorePath,
        reason: e instanceof Error ? e.message : String(e),
      };
      process.stderr.write(`bounty: restore failed (${restorePath}): ${restoreFailed.reason}\n`);
    }
  }
  const sockets = new Set<ServerWebSocket<unknown>>();

  // Append-only event log for the agent's SSE tail (GET /events). Each event
  // gets a monotonic `id` so a (re)connecting tail resumes via ?since=<id>.
  // `cursor` in GET /state is the current `eventSeq` — the resume point.
  // ⛔ ONE CALL INTO `src/kit/wire/eventLog.ts`, AND IT CLOSES CENSUS DEFECT L5
  // BY CONSTRUCTION. The array below used to be `const events = []` with `push`
  // and no cap — grown for the daemon's whole life, on a board an agent team
  // drives for hours. `createEventLog` keeps a bounded replay window
  // (`REPLAY_BUFFER_SIZE`, 1000, mind-mapper's measured cap) and nothing here
  // has to remember to trim it.
  //
  // ⛔ AND IT CLOSES A SECOND, UNCENSUSED HAZARD THIS FILE'S OWN COMMENT
  // DESCRIBED INCORRECTLY. The old `emitEvent` wrote `{ id: ++eventSeq, ...msg }`
  // under a comment saying "the monotonic `id` MUST win over any `id` in the
  // payload" — but SPREAD ORDER means a payload `id` silently overrode the
  // cursor, and the only thing holding the sentence true was the convention that
  // callers pass `taskId`. The kit assigns `id` AFTER the spread.
  //
  // ⛔ NO EPOCH, RULED — WHICH NARROWS CENSUS DEFECT L6 RATHER THAN CLOSING IT.
  // `createEventLog` takes `{ epoch }` and every adopter must decide. The
  // criterion (B8, from D39): **a SESSION-scoped daemon stamps NO epoch; a
  // SINGLETON is the case that needs one.** bounty is session-scoped — a board
  // is identified by `session_id`, a restart is a DIFFERENT session with a
  // different id, and a resuming tail is already talking to a different daemon
  // BY NAME rather than by watermark. So the ambiguity L6 describes (after a
  // restart `seq` restarts at 0 and a resuming client cannot tell a stale
  // watermark from a fresh one) cannot arise through bounty's own discovery.
  //
  // ⚠ IT IS NARROWED, NOT CLOSED, AND THE RESIDUE IS NAMED. A caller that
  // carries a cursor across a restart by hand — reusing `--since N` against a
  // board reopened with the SAME `--session-key`, which derives the same id on
  // purpose (#69) — still cannot distinguish the two logs. That is a real hole
  // and it is smaller than L6's: it needs a caller doing something deliberate,
  // not a daemon restarting underneath a tail.
  const log = createEventLog<Record<string, unknown>>();
  const sseClients: SseClients = new Set();

  // Debounced persistence: a board mutation marks the snapshot dirty; a ~1s
  // timer flushes it, and a final write lands on close. The snapshot is keyed by
  // session id and KEPT on close (it's the resume point for --restore).
  let snapDirty = false;
  // #73/#74 — ONCE PER DAEMON SESSION. Lives here, in the daemon's closure, so
  // "session" means exactly "this process": a restart re-arms it, which is the
  // point (the state worth keeping is whatever existed before THIS daemon
  // started writing).
  let rotatedThisSession = false;
  // D1.2's readable blank. The ruling says `snapshotBackedUp: {...} | null`,
  // "null when nothing happened, NEVER ABSENT — a readable blank distinguishes
  // 'not needed' from 'not reported'", and that stderr prose does not count
  // because the consumer is an agent parsing JSON.
  //
  // ⛔ THE EVENT ALONE CANNOT SATISFY THAT, AND THE REASON IS STRUCTURAL: an
  // event is ABSENT when nothing happened, so "no rotation" and "a daemon that
  // never emits this" are byte-identical to a consumer. The ruling was written
  // for a command-response trigger (close/restore) which has an envelope; the
  // trigger that shipped is a BACKGROUND FLUSH, which has no response to carry a
  // field. `/state` is the home that survives that change — it is the agent's
  // JSON surface and it is readable at any time, including after the one page
  // refresh that loses an event.
  //
  // This is my own recorded lesson arriving at a second spell: a signal whose
  // ABSENCE is indistinguishable from "nothing is happening" needs a read
  // alongside its event; event-only is fine only for signals that are
  // self-evidently transient.
  let snapshotBackedUp: { path: string; taskCount: number; reason: string } | null = null;
  const saveSnapshot = () => {
    try {
      mkdirSync(SNAPSHOTS_DIR, { recursive: true });
      const path = join(SNAPSHOTS_DIR, `${sessionId}.json`);
      // Copy the existing snapshot aside BEFORE the first shrinking write of
      // this daemon's life. See shouldRotateSnapshot for why the predicate is
      // shrinkage rather than emptiness, and why it fires once per boot.
      const prior = snapshotTaskCount(path);
      // `prior !== null` is redundant at RUNTIME — shouldRotateSnapshot returns
      // false for null, and a unit cell pins that. It is here so the compiler
      // narrows `prior` to number for the `taskCount` field below; without it,
      // tsc reports TS2322 and `bun test` stays green, which is the standing
      // bun-green-is-not-tsc-clean trap. Keeping the predicate total anyway is
      // deliberate: it stays correct for any caller, not just this one.
      if (prior !== null && shouldRotateSnapshot(prior, state.tasks.length, rotatedThisSession)) {
        // `.bak.json` and not `.bak`: the suffix is what makes this recoverable
        // through the verbs that already exist. `sessions` lists *.json and
        // strips the extension, so the backup appears there by name; and
        // `open --restore <id>.pre-<ts>.bak` resolves it, because restore joins
        // SNAPSHOTS_DIR with the arg plus ".json". Zero new recovery surface.
        const backup = join(SNAPSHOTS_DIR, `${sessionId}.pre-${Date.now()}.bak.json`);
        copyFileSync(path, backup);
        rotatedThisSession = true;
        snapshotBackedUp = {
          path: backup,
          taskCount: prior,
          reason: `about to write ${state.tasks.length} tasks over ${prior}`,
        };
        // ⛔ AND IT SAYS SO. A silent rotation is a success-shaped lie, which is
        // the defect family this whole project is named after — the user would
        // be protected and never know they had needed protecting. Three
        // surfaces, because they fail differently: the durable log survives the
        // daemon, the event reaches a live tail, and stderr reaches whoever is
        // watching the process.
        logDaemon("snapshotBackedUp", {
          backup,
          priorTasks: prior,
          nextTasks: state.tasks.length,
        });
        emitEvent({
          type: "snapshotBackedUp",
          backup,
          priorTasks: prior,
          nextTasks: state.tasks.length,
          by: "system",
        });
        process.stderr.write(
          `bounty: snapshot was about to shrink ${prior} → ${state.tasks.length} tasks; copied the old one to ${backup}\n`,
        );
      }
      writeFileSync(path, JSON.stringify(state));
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

  // P1f — arm the signal path now that `done` exists. Everything below is what
  // the handlers above could not reach at registration time.
  //
  // ⛔ THE WATCHDOG IS THE LOAD-BEARING PART, not the resolve. `resolveDone`
  // alone would make termination depend on the teardown completing, and "the
  // teardown always completes" is exactly the kind of claim that shipped a
  // 23-minute hang. This makes the ending unconditional: teardown finishes and
  // clears it (the normal path, and the timer never fires), or it does not and
  // the process still dies with the right code.
  //
  // REF'd deliberately — an unref'd timer cannot rescue a hang, because a hang
  // means something else is already holding the loop open. The cost is that the
  // timer keeps the loop alive until teardown clears it, which is why
  // `clearTimeout` sits at the end of the teardown rather than being optional.
  //
  // ── ⛔ RULED AT THE PORT (Phase 4, 2026-09-09): IT STAYS HERE, UNSHARED ────
  //
  // `kit/wire/housekeeping.ts` names this watchdog as a deliberate ABSENCE and
  // pre-committed to a resolution: "when a spell with a signal path adopts
  // this, the watchdog arrives as an OPTION ON THESE ARGUMENTS". bounty is that
  // spell, and **measuring the window falsified the pre-commitment.**
  //
  // A `watchdogMs` on `drainAndStop` would arm at DRAIN time. This one arms at
  // SIGNAL time, and everything between the two is what it exists to cover:
  // `await done`, `logDaemon` (an fs append), `clearTimeout`, `stopHousekeeping`,
  // a FULL `saveSnapshot` (which can rotate and COPY a backup of a large board),
  // `emitEvent` and `broadcast`. `drainAndStop`'s own body is already bounded by
  // its two numbers — 150 ms + a 200 ms race — so a watchdog scoped to it would
  // guard the one stretch that cannot hang and abandon the stretch that can. It
  // would read as adoption and BE a narrowing of the only unconditional
  // termination guarantee in the corpus.
  //
  // So the kit keeps no `process.exit` (D8's direction, one phase on), bounty
  // keeps the guarantee at full width, and the falsified prediction is recorded
  // in the kit's header where the next spell with a signal path will read it.
  let shutdownWatchdog: ReturnType<typeof setTimeout> | null = null;
  requestShutdown = (code, reason, signal) => {
    // `subscribers` on the signal path — the field this class of death has never
    // carried. Today `signal` is the only exit class that omits it, so nothing
    // in daemon.log would change when this fix lands; measuring the fix later
    // requires the instrument to exist now. Captured BEFORE teardown closes
    // anything, matching the `exit` line's own discipline.
    logDaemon("signal", { signal, subscribers: sockets.size + sseClients.size });
    shutdownWatchdog = setTimeout(() => {
      logDaemon("shutdownWatchdog", { signal, note: "teardown did not finish; forcing exit" });
      process.exit(code);
    }, SHUTDOWN_WATCHDOG_MS);
    resolveDone({ code, reason: reason as CloseReason });
  };

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
    // Append + fan-out are ONE call now. Doing them in two steps leaves a window
    // in which an emit lands between a replay loop and a subscriber `add`, and
    // that frame is delivered to nobody — the shape this daemon had, survived by
    // nothing but the single-threaded event loop happening to close it.
    const ev = log.emit(msg);
    // Every board mutation flows through here — mark the snapshot dirty centrally.
    if (typeof msg.type === "string" && DIRTYING.has(msg.type)) snapDirty = true;
    return ev;
  }

  /**
   * Presence, to the LIVE tails only — never into the replay log.
   *
   * ⛔ THIS CLOSES CENSUS DEFECT L7 AND IT IS A WIRE-OBSERVABLE CHANGE, NAMED
   * RATHER THAN SMUGGLED. `connected` / `disconnected` used to go through
   * `emitEvent`, so they were buffered with everything else and a tail
   * reconnecting at `--since 0` replayed the WHOLE browser-presence history of
   * the session — pages of it on a board a human has opened and closed a dozen
   * times — and each replayed frame ADVANCED the agent's cursor, so presence
   * churn pushed real events out of a bounded window.
   *
   * Presence is a fact about NOW; a replayed "someone connected" is false by the
   * time it is read. glamour reached this shape independently and `sse.ts`'s
   * `client.send` was widened in Phase 2 to express it; bounty is the second
   * consumer of that widening and needed no further change to the kit.
   *
   * ⚠ THE CALLER-VISIBLE DELTA: these two frames NO LONGER CARRY AN `id`,
   * because an unlogged frame has no cursor position — SKILL.md's event table is
   * updated to say so. Nothing in the surface or in `server.test.ts` read that
   * `id`; the browser learns presence over its own WebSocket.
   */
  function emitPresence(msg: Record<string, unknown>) {
    const chunk = `data: ${JSON.stringify(msg)}\n\n`;
    for (const c of [...sseClients]) c.send(chunk);
  }

  // GET /events?since=<id> — replay, then stay open for live frames plus a
  // heartbeat comment. ONE call into `kit/wire/sse.ts`, which is where the
  // teardown funnel lives: `cancel()`, `req.signal` and a failed enqueue all
  // reach it, AT MOST ONCE, and that funnel is what bounds the subscriber count
  // the idle sweep reads — which for bounty is the number that decides whether a
  // watching agent's board stays alive.
  //
  // ⛔ WHAT THE OLD COPY COULD NOT DO. It relied on `try { enqueue } catch` to
  // notice a departed client — measured on Bun 1.3.14 NOT to work, an enqueue on
  // an orphaned stream buffers silently and never throws — and it was not wired
  // to `req.signal` at all, so a tail that vanished without cancelling counted
  // as a live subscriber for the life of the daemon. For bounty that is not a
  // cosmetic count: `shouldIdleClose` reads it, so a phantom subscriber kept a
  // finished board standing until something else closed it.
  //
  // ⛔ AND THE SECOND REGISTRY IS GONE. `sseTimers` was a parallel `Set` of
  // per-stream heartbeat intervals, swept separately at teardown — two
  // registries for one lifetime, which is the drift `sse.ts`'s header warns
  // about. The interval now lives inside the stream's own funnel and is cleared
  // by it.
  //
  // ⚠ AND THE HEARTBEAT IS NO LONGER A LITERAL `15000` written 300 lines from
  // the `idleTimeout: 255` it is chained to. Both come from `./heartbeat.ts`.
  const eventsResponse = (req: Request, url: URL): Response =>
    kitSseResponse({
      log,
      since: Number.parseInt(url.searchParams.get("since") ?? "-1", 10),
      heartbeatMs: SSE_HEARTBEAT_MS,
      clients: sseClients,
      signal: req.signal,
      onOpen: touch,
      onClose: touch,
    });

  // Owner of a task by id (or undefined). Stamped onto task.* event frames so a
  // scoped `cli.ts tail --owner`/`--mine` can filter client-side, and looked up
  // for the cooperative-claim guard.
  const ownerOf = (id: string) => state.tasks.find((t) => t.id === id)?.owner;

  // ── dependencies (Phase D) ──
  // (the canonical `isBlocked(task, tasks)` predicate is module-level, shared
  // with the heartbeat + card-aging sweeps.)

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
  for (const t of state.tasks) prevBlocked.set(t.id, isBlocked(t, state.tasks));

  // Run after every mutation: for each task, if it just went blocked→unblocked
  // (the last live blocker cleared, or its last live edge was removed) AND it
  // isn't itself done, fire a targeted `unblocked` event to its owner. Broad
  // O(n) walk — one mutation can unblock many tasks; board scale makes it free.
  function reconcileBlocked() {
    for (const task of state.tasks) {
      const now = isBlocked(task, state.tasks);
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
      // b8 — COUNT AND NAME THE DROPS. Filtering is correct (the /cmd body is
      // untrusted), but reporting nothing meant a caller could not distinguish a
      // GOOD SEED from a TOTAL REJECTION: 18 tasks in, 0 seeded, applied:true.
      let dropped: { index: number; reason: string }[] = [];
      if (Array.isArray(msg.tasks)) {
        state.tasks = [];
        dropped = msg.tasks
          .map((raw, index) => ({ index, reason: taskRejection(raw) }))
          .filter((d): d is { index: number; reason: string } => d.reason !== null);
        for (const task of msg.tasks.map(validateTask)) if (task) applyTaskAdd(state, task);
      }
      broadcast({ type: "init", title: state.title, tasks: state.tasks, restoreFailed, sessionId });
      emitEvent({ type: "init", title: state.title, by });
      // Present-and-null, never absent: an absent field cannot distinguish "all
      // your tasks were seeded" from "this daemon does not report drops".
      return {
        ok: true,
        applied: true,
        tasksDropped: dropped.length
          ? { requested: Array.isArray(msg.tasks) ? msg.tasks.length : 0, dropped }
          : null,
      };
    } else if (msg.type === "task.add") {
      // #83 — `applied:false` alone conflated TWO causes and named neither, so
      // the CLI could not tell the caller what went wrong even once it started
      // reading the verdict. Both causes now carry an `error` (an existing field
      // of ApplyResult — no new vocabulary), because "the reason" is what makes
      // the refusal actionable rather than merely loud.
      const task = validateTask(msg.task);
      if (!task) {
        return {
          ok: true,
          applied: false,
          error: "task rejected: needs a string id, a string title, and a valid status",
        };
      }
      if (!applyTaskAdd(state, task)) {
        // applyTaskAdd refuses a duplicate id WITHOUT touching state — it neither
        // overwrites nor appends — so the existing task keeps that id and every
        // field of it. The message says so, because the caller's next question is
        // "did I just clobber the original?" and the answer is no.
        return {
          ok: true,
          applied: false,
          error: `task ${task.id} already exists — the board is unchanged and the existing task kept its id`,
        };
      }
      broadcast({ type: "task.add", task });
      emitEvent({ type: "task.add", task, by, owner: task.owner });
      return { ok: true, applied: true };
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
      // applyTaskUpdate returned false here = the task doesn't exist (no-ops on
      // an existing task were already caught above with NO error). Carry an error
      // so the CLI can tell a not-found / mis-routed update (a visible failure,
      // #62) apart from a benign no-op (both are applied:false, but only this one
      // is a real failure).
      return { ok: true, applied: false, error: `no such task ${msg.id}` };
    } else if (msg.type === "task.remove") {
      const owner = ownerOf(msg.id); // before removal
      if (applyTaskRemove(state, msg.id)) {
        broadcast({ type: "task.remove", id: msg.id });
        emitEvent({ type: "task.remove", taskId: msg.id, by, owner });
        return { ok: true, applied: true };
      }
      // Not found (remove has no no-op path) — carry an error so a mis-routed
      // remove surfaces as a visible failure (#62), like update above.
      return { ok: true, applied: false, error: `no such task ${msg.id}` };
    } else if (msg.type === "task.block") {
      const task = state.tasks.find((t) => t.id === msg.id);
      if (!task) return { ok: true, applied: false, error: `no such task ${msg.id}` };
      // b10 — the SUBJECT's existence was checked one line up; the BLOCKERS'
      // was not. So `block <real> --on <typo>` was accepted at ok:true and
      // created an edge that constrains NOTHING: isBlocked and the /state
      // liveBlockers projection both require a blocker to EXIST, so a dangling
      // id is inert by design. The envelope answered {"blocked":"<id>"} while
      // /state answered blocked:false — one command saying two things.
      //
      // ⚠ Note this is the INVERSE of how it was first reported: the risk is
      // not a block that never resolves, it is a guard the caller believes is
      // in place and is not. Measured before fixing.
      //
      // Refusal rather than a report, for the reason the card names: `add`
      // REFUSES a missing title while this ACCEPTED a missing referent — same
      // tool, same minute. This restores the uniformity, and the traversal that
      // finds the referent was already being done by canReach below.
      const unknown = msg.on.filter((b) => !state.tasks.some((t) => t.id === b));
      if (unknown.length)
        return {
          ok: true,
          applied: false,
          error:
            `no such task${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} — ` +
            `nothing was blocked (a blocker that does not exist would constrain nothing)`,
        };
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

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      // dev: the HTMLBundle at "/" (Bun serves its assets itself).
      // release: no routes — the fetch handler serves dist/. Bun's Routes type
      // ties the value's type to the literal object shape, so the mode-ternary
      // union is cast; the runtime behaviour is correct either way.
      routes,
      development: { hmr: mode === "dev" },
      // P1e (re-scoped from #64). Bun's default request idleTimeout is 10s, and
      // the SSE heartbeat below fires every 15s — so on an OTHERWISE-IDLE
      // connection the heartbeat cannot fire, because the connection is severed
      // five seconds before it is due. An agent `tail` on a quiet board is
      // exactly that connection.
      //
      // 255 is Bun's clamped maximum. Do NOT use 0 to mean "disabled": measured
      // in mind-mapper, 0 stalls the initial response rather than disabling the
      // timeout.
      //
      // ⛔ IT IS `IDLE_TIMEOUT_SEC` FROM `./heartbeat.ts` NOW, NOT A LITERAL.
      // The literal 255 and the literal 15,000 were written 300 lines apart with
      // the relationship between them recorded ONLY in this prose — which holds
      // at those two values and at no others, and which `server.test.ts`'s P1e
      // cell had to check by scanning this file with two regexes. The seam
      // module DERIVES the pair (`beat <= idleTimeout / 2`), so the ordering is
      // true for any configured value and the source scan can assert the
      // derivation instead of two numbers.
      //
      // ⚠ THE CLAIM SHIPS BOUNDED. This is CONSISTENT WITH #64's reporter clue
      // (read-heavy dies / write-heavy survives — traffic resets the idle timer,
      // so the 10s cut is not unconditional) and it is UNTESTED AGAINST it. It
      // does not "explain" those deaths: the reporter was an agent and cannot be
      // asked, the instrument post-dates the report, and open question 6 is
      // permanently unanswerable. A heartbeat that can now fire is the fix; the
      // reported deaths remain undiagnosed.
      idleTimeout: IDLE_TIMEOUT_SEC,
      fetch: (req, srv) => {
        const url = new URL(req.url);
        const path = url.pathname;
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
          // `snapshotBackedUp` is spread AT THE HANDLER, beside cursor — it is a
          // daemon-level fact about this process, not board state, so it does
          // not belong inside projectState(). Always present; null means "no
          // rotation has happened in this daemon's life", which is a readable
          // blank rather than an absence (D1.2).
          return new Response(
            JSON.stringify({
              state: projectState(),
              cursor: log.cursor(),
              snapshotBackedUp,
              // b15 — also readable here: a boot line is missable and this fact
              // outlives it.
              restoreFailed,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        // Agent live tail: SSE stream of the event log, resumable via ?since=.
        if (req.method === "GET" && path === "/events") {
          return eventsResponse(req, url);
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
        // Release only: "/" and the surface's hashed chunks, which the built
        // index.html links relatively and which therefore arrive as bare
        // filenames at the root. Dev never serves from dist/ — a checkout can
        // carry a committed dist/ that is stale against its source, and in dev
        // Bun's router owns the bundle's assets.
        if (mode === "release" && req.method === "GET") {
          const served = serveDist(path);
          if (served) return served;
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
          emitPresence({ type: "connected", by: "user" });
          // b16 — CHANNEL PARITY. `restoreFailed` reached the agent (the `open`
          // discovery payload and GET /state) and NOT the human, whose only
          // channel is this socket. So the board came up empty and the person
          // looking at it had no way to tell "the restore broke" from "there is
          // nothing here" — the exact distinction b15 was built to make, missing
          // on the one channel that renders it to a human.
          //
          // Rides `init` rather than a new message type because it is a boot
          // fact, and `init` is the only frame that carries boot facts. Sent on
          // EVERY connect, not just the first: a reload or reconnect must not be
          // the thing that loses the warning.
          ws.send(
            JSON.stringify({
              type: "init",
              title: state.title,
              tasks: state.tasks,
              restoreFailed,
              sessionId,
            }),
          );
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
              broadcast({
                type: "init",
                title: state.title,
                tasks: state.tasks,
                restoreFailed,
                sessionId,
              });
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
          emitPresence({ type: "disconnected", by: "user" });
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
  // The three values the old template.html had substituted into it now reach
  // the board another way, because a BUILT index.html is a static artifact the
  // daemon serves verbatim and dev mode is served by Bun's own bundler — there
  // is no point at which the daemon could substitute in both modes:
  //   - the WebSocket URL is derived in the browser from location.host (the
  //     page is served from this same origin);
  //   - the title already rode the `init` frame and always overrode the
  //     substituted one within a few ms of connect;
  //   - the session id now rides `init` too. It is a BOOT FACT, and `init` is
  //     the frame that carries boot facts — the same argument b16 made for
  //     putting restoreFailed there.
  const url = `http://${host}:${boundPort}`;
  // First frame on the event log (id 1) — bookends the stream with `closed`.
  // `mode` rides BOTH transports bounty has. It prints no stdout handshake and
  // no stderr boot line, so the ready event and the discovery JSON are the
  // whole set — a cell that reads one certifies half the contract.
  emitEvent({ type: "ready", url, port: boundPort, session_id: sessionId, mode, by: "system" });
  logDaemon("ready", { port: boundPort });

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
    // Which surface answered: "release" serves the committed dist/, "dev" asks
    // Bun to bundle src/bounty/surface/ at serve time. A dev daemon with the
    // repo's deps present renders an identical-looking board, so this is the
    // only way a caller can tell them apart.
    mode,
    // b15 — rides the DISCOVERY payload because that is what `open` prints, and
    // `open` is the command whose restore just failed. Reporting it only on a
    // later /state would mean the caller learns of it, if at all, on a different
    // command than the one that broke.
    restoreFailed,
  });
  // ⚠ ATOMIC, because readSession now treats unparseable content as corruption
  // rather than absence. A bare writeFileSync is not atomic: a CLI reading while
  // the daemon writes can observe a half-written pointer, and under the old
  // best-effort read that surfaced as "no running session". Write beside the
  // target and rename — rename within one directory is atomic, so a reader sees
  // either the previous pointer or the new one, never a partial file.
  //
  // ⛔ IT IS `src/kit/wire/discovery.ts`'s `writeFileAtomic` NOW. bounty's local
  // `writeAtomic` was one of the four hand-rolled copies the recon found on
  // 2026-09-08 (fixed in glamour, then found standing in three siblings), and
  // the kit's is the same tmp+rename with the same cleanup-on-throw. This is a
  // de-duplication and NOT a behaviour change: census defect L3 was already
  // CORRECT in the four session spells, bounty among them.
  try {
    writeFileAtomic(sessionFile, sessionInfo);
    writeFileAtomic(latestFile, sessionInfo);
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
  //
  // ⛔ THE `latest` POINTER IS ONLY REMOVED IF IT STILL NAMES US — otherwise a
  // newer host has taken over the slot and we would delete a LIVE board's
  // pointer on our way out. `unlinkIfMatches`'s `identify` hook is what lets one
  // shared predicate serve both discovery conventions; bounty's identity is
  // `session_id`, which is what the hand-rolled version compared.
  const cleanupDiscovery = () => {
    try {
      unlinkSync(sessionFile);
    } catch {}
    unlinkIfMatches(latestFile, sessionId, (raw) => {
      try {
        return (JSON.parse(raw) as { session_id?: string }).session_id ?? null;
      } catch {
        return null;
      }
    });
  };

  if (!v["no-open"]) openBrowser(url);

  // ⛔ THE TWO STANDING TIMERS ARE ONE CALL NOW — `src/kit/wire/housekeeping.ts`.
  // They have always been one LIFETIME: every copy in the corpus cleared both in
  // the same two lines after `await done`, and the pair that gets forgotten is
  // the pair whose timers keep a process alive after teardown. `subscriberCount`
  // is a REQUIRED argument, so the L1 defect (idle-closing a board with a
  // watching agent still connected) cannot be re-expressed by a caller who
  // forgets — and the sweep touches the activity clock on every watched tick, so
  // the floor still counts from the last DISCONNECT rather than the last
  // request, which is bounty's own scar and travelled with the code.
  //
  // ⚠ `GET /state` COUNTING AS ACTIVITY (L2) is unchanged and is not this
  // module's doing: bounty already `touch()`ed on that route. L2 was correct
  // here before the port.
  const stopHousekeeping = startHousekeeping({
    subscriberCount: () => sockets.size + sseClients.size,
    idleMs: () => performance.now() - lastActivity,
    touch,
    timeoutMs: timeout * 1000,
    onIdleClose: () => resolveDone({ code: 124, reason: "timeout" }),
    snapshot: {
      dirty: () => snapDirty,
      clear: () => {
        snapDirty = false;
      },
      write: saveSnapshot,
    },
  });

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
  // Known-exit diagnostics (#64). `subscribers` at an idle-timeout exit is the
  // key signal: if it idle-closes with subscribers > 0 the idle logic is the
  // culprit; if 0, no tail was actually connected. Captured BEFORE teardown
  // closes the sockets/SSE clients so the count is the live one at exit.
  logDaemon("exit", {
    reason,
    subscribers: sockets.size + sseClients.size,
    idleMs: performance.now() - lastActivity,
  });
  // ⛔ THE SHUTDOWN WATCHDOG IS CLEARED FIRST AND IT IS STILL BOUNTY'S OWN — see
  // the ruling at its arming site above and in `kit/wire/housekeeping.ts`'s
  // header. The teardown reached this point, so the force-exit is no longer
  // needed AND the REF'd timer must stop holding the event loop or the natural
  // drain never happens.
  if (shutdownWatchdog) clearTimeout(shutdownWatchdog);
  stopHousekeeping();
  clearInterval(heartbeatTimer);
  saveSnapshot(); // final write — KEEP it (the resume point, not deleted on close)
  // Closing frame on the event log — ends a `cli.ts tail` (exit 0) and bookends
  // the `ready` that opened it.
  emitEvent({ type: "closed", reason, by: "system" });
  broadcast({ type: "message", text: `session ended: ${reason}` });
  // ⛔ THE GRACE / CLOSE-CLIENTS / CLOSE-SOCKETS / RACE-STOP BLOCK IS
  // `drainAndStop` NOW, and every number in it is bounty's own: the 150 ms grace
  // (a `closed` frame followed immediately by an aggressive `server.stop(true)`
  // is a frame the client never sees — the queue goes with the socket) and the
  // 200 ms stop race (one wedged peer awaiting `stop(true)` is enough to park
  // teardown forever, which is how a 23-minute hang shipped once). All eight
  // daemons converged on those two numbers independently.
  //
  // ⚠ AND THE `sseTimers` SWEEP IS GONE, not forgotten: each stream's heartbeat
  // interval now lives inside its own teardown funnel in `kit/wire/sse.ts` and
  // is cleared by `client.close()` below. The parallel registry was the only
  // thing that made the old `c.close()` not leak a timer, and keeping it beside
  // a funnel that already does the job is how two registries drift apart.
  await drainAndStop({ server, clients: sseClients, sockets });
  cleanupDiscovery();
  return code;
}

/**
 * The process entry, called by the LAUNCHER at
 * `plugins/spellbook/skills/bounty/scripts/server.ts`.
 *
 * ⛔ THERE IS NO `if (import.meta.main)` BLOCK HERE, AND THE DAEMON KEEPS NO
 * SECOND ENTRY DELIBERATELY. This module ships BUNDLED at `../dist/server.js`
 * and is IMPORTED by the launcher, so `import.meta.main` is FALSE in the
 * artifact: a guarded block would never run, the daemon would bind no port,
 * exit 0, and every integration cell would fail as "the daemon never answered"
 * — which reads like flake (playbook Phase B, B3).
 *
 * ⛔ AND OFFERING A SECOND ENTRY HERE WOULD BE OFFERING A WRONG DAEMON. Every
 * pin in this file is anchored on `SCRIPT_DIR`, which is the skill's `dist/`
 * when the artifact runs and `src/bounty/backend/` when the source does. From
 * the source address `SKILL_ROOT` computes `src/bounty/`, which has no
 * `dist/index.html`, no `assets/` and no `SKILL.md` — so the mode probe
 * silently chooses DEV and the assets route serves nothing.
 *
 * ⚠ THE TERMINAL `process.exit(exitCode)` STAYS, AT THE LAUNCHER. It is family
 * E-terminal in `grimoire/exit-site-inventory.test.ts` and it is load-bearing
 * twice over: the signal path is redirected INTO the bounded teardown that
 * precedes it (P1f), and the shutdown watchdog force-exits if that teardown
 * does not finish. A natural return here would be the 23-minute hang this
 * spell has already shipped once. It is NOT the CLI's drained-exit case: the
 * daemon's stdout is released by the CLI after the handshake.
 */
export async function run(): Promise<number> {
  return await main(process.argv.slice(2));
}

export {
  applyTaskAdd,
  applyTaskMove,
  applyTaskRemove,
  applyTaskUpdate,
  cleanTags,
  computeDuePokes,
  htmlEscape,
  isNoOpMove,
  isNoOpUpdate,
  main,
  parsePortFromSessionId,
  shouldIdleClose,
  shouldRotateSnapshot,
  snapshotTaskCount,
  validateTask,
};
