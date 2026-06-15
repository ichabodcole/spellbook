#!/usr/bin/env bun

// bounty — agent-driven task board the user can interact with.
//
// Built on the agent-surface-bun recipe's duplex pattern:
//   - Agent ↔ server via JSON-lines on stdio
//   - Server ↔ browser via WebSocket
//   - Server holds the canonical state; late-joining browsers receive
//     a synthetic init on connect.
//
// Protocol — agent → server (one JSON object per line on stdin):
//   {"type":"init",        "title": "...", "tasks": Task[]}
//   {"type":"task.add",    "task": Task}              // append
//   {"type":"task.update", "id": "...", "patch": Partial<Task>}
//   {"type":"task.remove", "id": "..."}
//   {"type":"message",     "text": "..."}             // toast
//   {"type":"close"}                                  // end session
//
// Protocol — server → agent (one JSON object per line on stdout):
//   {"type":"ready",          "url":"...", "port":..., "session_id":"..."}
//   {"type":"connected"}                              // browser opened WS
//   {"type":"disconnected"}                           // browser closed WS
//   {"type":"task.toggle",    "id":"...", "status":"todo|doing|review|done"}
//   {"type":"task.move",      "id":"...", "status":"...", "index": N}
//   {"type":"task.edit",      "id":"...", "title":"..."}
//   {"type":"task.add",       "task": Task}           // user added
//   {"type":"task.remove",    "id":"..."}             // user deleted
//   {"type":"submit",         "tasks": Task[]}        // final state on submit
//   {"type":"closed",         "reason":"submit|cancel|timeout|stdin_eof|close"}
//
// task.toggle vs task.move: toggle is the click-a-pill UX — status changes,
// task is appended to the destination column. move is the drag UX — status
// AND explicit position in the destination column. Agents that only care
// about column membership can ignore .move and rely on the canonical order
// in the final submit.
//
// Protocol — server ↔ browser (WebSocket): same task.* events flow
// in both directions; the server is a proxy that mutates the state
// snapshot when either side speaks.
//
// Exit codes mirror digestify's review.ts: 0 submit, 2 bad args,
// 124 idle timeout, 130 cancel.

import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ServerWebSocket } from "bun";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

type TaskStatus = "todo" | "doing" | "review" | "done";
type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  notes?: string;
};
type BoardState = { title: string; tasks: Task[] };

type CloseReason = "submit" | "cancel" | "timeout" | "stdin_eof" | "close";
type DoneResult = { code: number; reason: CloseReason };

type AgentMsg =
  | { type: "init"; title?: string; tasks?: Task[] }
  | { type: "task.add"; task: Task }
  | { type: "task.update"; id: string; patch: Partial<Task> }
  | { type: "task.remove"; id: string }
  | { type: "message"; text: string }
  | { type: "close" };

type ServerToAgentMsg =
  | { type: "ready"; url: string; port: number; session_id: string }
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "task.toggle"; id: string; status: TaskStatus }
  | { type: "task.move"; id: string; status: TaskStatus; index: number }
  | { type: "task.edit"; id: string; title: string }
  | { type: "task.add"; task: Task }
  | { type: "task.remove"; id: string }
  | { type: "submit"; tasks: Task[] }
  | { type: "closed"; reason: CloseReason };

type BrowserMsg =
  | { type: "task.toggle"; id: string; status: TaskStatus }
  | { type: "task.move"; id: string; status: TaskStatus; index: number }
  | { type: "task.edit"; id: string; title: string }
  | { type: "task.add"; task: Task }
  | { type: "task.remove"; id: string }
  | { type: "submit" }
  | { type: "cancel" };

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

function emitToAgent(msg: ServerToAgentMsg): void {
  try {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  } catch (e) {
    if (!(e && typeof e === "object" && "code" in e && e.code === "EPIPE")) throw e;
  }
}

async function* readJsonLines(): AsyncGenerator<AgentMsg | null> {
  if (process.stdin.isTTY) {
    yield null;
    return;
  }
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      // Re-scan for the next newline each pass so the `continue` below
      // doesn't skip advancing past a consumed line.
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line) as AgentMsg;
        } catch (e) {
          process.stderr.write(
            `bounty: bad json on stdin: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      }
      if (done) {
        buffer = buffer.trim();
        if (buffer) {
          try {
            yield JSON.parse(buffer) as AgentMsg;
          } catch (e) {
            process.stderr.write(
              `bounty: bad json on stdin (final): ${e instanceof Error ? e.message : String(e)}\n`,
            );
          }
        }
        yield null;
        return;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

// State mutation helpers. All keep `state.tasks` in place (replace by id)
// so the agent and browser see consistent ordering.
function applyTaskAdd(state: BoardState, task: Task): boolean {
  if (state.tasks.some((t) => t.id === task.id)) return false;
  state.tasks.push(task);
  return true;
}

function applyTaskUpdate(state: BoardState, id: string, patch: Partial<Task>): boolean {
  const idx = state.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  // Status guard: drop invalid status values quietly so a malformed agent
  // message can't corrupt the board.
  if (patch.status && !VALID_STATUS.includes(patch.status)) {
    const { status: _drop, ...rest } = patch;
    patch = rest;
  }
  state.tasks[idx] = { ...state.tasks[idx], ...patch };
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
function applyTaskMove(state: BoardState, id: string, status: TaskStatus, index: number): number {
  const fromIdx = state.tasks.findIndex((t) => t.id === id);
  if (fromIdx === -1) return -1;
  const [task] = state.tasks.splice(fromIdx, 1);
  task.status = status;
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

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        title: { type: "string", default: "Bounty Board" },
        timeout: { type: "string", default: "43200" },
        "no-open": { type: "boolean", default: false },
        port: { type: "string", default: "0" },
        host: { type: "string", default: "127.0.0.1" },
        id: { type: "string" },
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

  const state: BoardState = { title: v.title as string, tasks: [] };
  const sockets = new Set<ServerWebSocket<unknown>>();

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
          emitToAgent({ type: "connected" });
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
            if (applyTaskUpdate(state, msg.id, { status: msg.status })) {
              broadcast({ type: "task.update", id: msg.id, patch: { status: msg.status } });
              emitToAgent({ type: "task.toggle", id: msg.id, status: msg.status });
            }
          } else if (msg.type === "task.move") {
            if (!VALID_STATUS.includes(msg.status)) return;
            if (applyTaskMove(state, msg.id, msg.status, msg.index) !== -1) {
              // Broadcast the full ordered list — simpler than diffing for
              // browsers, and it covers the source-column shift correctly.
              broadcast({ type: "init", title: state.title, tasks: state.tasks });
              emitToAgent({ type: "task.move", id: msg.id, status: msg.status, index: msg.index });
            }
          } else if (msg.type === "task.edit") {
            // Validate: title must be a non-empty string after trim. A
            // malformed edit (title:null, title:"") would otherwise corrupt
            // the canonical task shape that gets re-broadcast and stored —
            // empty titles in particular surface to the agent on submit as
            // tasks with no readable label.
            if (typeof msg.title !== "string" || msg.title.trim() === "") return;
            if (applyTaskUpdate(state, msg.id, { title: msg.title })) {
              broadcast({ type: "task.update", id: msg.id, patch: { title: msg.title } });
              emitToAgent({ type: "task.edit", id: msg.id, title: msg.title });
            }
          } else if (msg.type === "task.add") {
            // Shape-validate the task before applying. The browser is
            // untrusted, so treat the incoming task as unknown and narrow:
            // required string id + title, valid status; notes optional string.
            const t: unknown = msg.task;
            if (!t || typeof t !== "object") return;
            const cand = t as Record<string, unknown>;
            if (typeof cand.id !== "string" || typeof cand.title !== "string") return;
            if (
              typeof cand.status !== "string" ||
              !VALID_STATUS.includes(cand.status as TaskStatus)
            )
              return;
            if (cand.notes !== undefined && typeof cand.notes !== "string") return;
            const task: Task = {
              id: cand.id,
              title: cand.title,
              status: cand.status as TaskStatus,
              ...(cand.notes !== undefined ? { notes: cand.notes as string } : {}),
            };
            if (applyTaskAdd(state, task)) {
              broadcast({ type: "task.add", task });
              emitToAgent({ type: "task.add", task });
            }
          } else if (msg.type === "task.remove") {
            if (applyTaskRemove(state, msg.id)) {
              broadcast({ type: "task.remove", id: msg.id });
              emitToAgent({ type: "task.remove", id: msg.id });
            }
          } else if (msg.type === "submit") {
            // Broadcast to all WS clients (browsers + joiners) so every
            // connected party gets the same authoritative final state.
            // Joiners receive it wrapped as {type:"event", payload:{...}}
            // by their join.ts; the spawning browser ignores it because
            // it's already navigated to its sent-screen.
            broadcast({ type: "submit", tasks: state.tasks });
            emitToAgent({ type: "submit", tasks: state.tasks });
            resolveDone({ code: 0, reason: "submit" });
          } else if (msg.type === "cancel") {
            // Broadcast cancel to all WS clients so joiners get the same
            // structured session-ending signal that submit provides. Without
            // this, joiners only see the trailing "session ended" toast
            // and a disconnect — no way to distinguish cancel from any
            // other server teardown reason.
            broadcast({ type: "cancel" });
            resolveDone({ code: 130, reason: "cancel" });
          }
        },
        close(ws) {
          sockets.delete(ws);
          emitToAgent({ type: "disconnected" });
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
  emitToAgent({ type: "ready", url, port: boundPort, session_id: sessionId });

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

  (async () => {
    for await (const msg of readJsonLines()) {
      if (msg === null) break; // stdin EOF — leave the surface up
      touch();
      if (msg.type === "init") {
        if (typeof msg.title === "string") state.title = msg.title;
        if (Array.isArray(msg.tasks))
          state.tasks = msg.tasks.filter((t) => VALID_STATUS.includes(t.status));
        broadcast({ type: "init", title: state.title, tasks: state.tasks });
      } else if (msg.type === "task.add") {
        if (applyTaskAdd(state, msg.task)) broadcast({ type: "task.add", task: msg.task });
      } else if (msg.type === "task.update") {
        if (applyTaskUpdate(state, msg.id, msg.patch)) {
          broadcast({ type: "task.update", id: msg.id, patch: msg.patch });
        }
      } else if (msg.type === "task.remove") {
        if (applyTaskRemove(state, msg.id)) broadcast({ type: "task.remove", id: msg.id });
      } else if (msg.type === "message") {
        broadcast({ type: "message", text: msg.text });
      } else if (msg.type === "close") {
        resolveDone({ code: 0, reason: "close" });
        return;
      }
    }
  })();

  const idleTimer = setInterval(() => {
    if (sockets.size > 0) touch();
    if (timeout > 0 && (performance.now() - lastActivity) / 1000 >= timeout) {
      resolveDone({ code: 124, reason: "timeout" });
    }
  }, 250);

  const { code, reason } = await done;
  clearInterval(idleTimer);
  emitToAgent({ type: "closed", reason });
  broadcast({ type: "message", text: `session ended: ${reason}` });
  // Grace period: server.stop(true) aggressively aborts in-flight
  // connections, which can drop a broadcast that was queued microseconds
  // earlier (the submit/cancel broadcasts in the WS message handlers
  // immediately precede this teardown). Pause briefly so the OS-level
  // socket buffers flush before we tear down. 150ms is enough on a
  // local connection; small enough that "session ended" feels responsive.
  await new Promise((r) => setTimeout(r, 150));
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
  htmlEscape,
  main,
  parsePortFromSessionId,
};
