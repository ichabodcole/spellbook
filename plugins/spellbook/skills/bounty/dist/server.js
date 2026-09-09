#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// src/bounty/backend/server.ts
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";

// plugins/spellbook/skills/bounty/shared/types.ts
var SIZE_MINUTES = { S: 5, M: 10, L: 20 };

// plugins/spellbook/skills/bounty/shared/predicates.ts
function expectedMinutes(task) {
  if (typeof task.expect === "number" && task.expect > 0)
    return task.expect;
  if (task.size && task.size in SIZE_MINUTES)
    return SIZE_MINUTES[task.size];
  return;
}
function liveBlockerCount(task, tasks) {
  return (task.blockedBy ?? []).filter((bid) => {
    const b = tasks.find((t) => t.id === bid);
    return b !== undefined && b.status !== "done";
  }).length;
}
function isBlocked(task, tasks) {
  return liveBlockerCount(task, tasks) > 0;
}

// src/bounty/backend/server.ts
var SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
var SKILL_ROOT = join(SCRIPT_DIR, "..");
var DIST_DIR = join(SKILL_ROOT, "dist");
function resolveMode() {
  const override = process.env.SPELLBOOK_SURFACE_MODE;
  if (override === "dev" || override === "release")
    return override;
  return existsSync(join(DIST_DIR, "index.html")) ? "release" : "dev";
}
var STATIC_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};
function serveDist(path) {
  const rel = path === "/" ? "index.html" : path.slice(1);
  if (!rel || rel.includes("..") || rel.includes("/"))
    return null;
  const file = join(DIST_DIR, rel);
  if (!existsSync(file))
    return null;
  const ext = rel.slice(rel.lastIndexOf("."));
  return new Response(Bun.file(file), {
    headers: { "Content-Type": STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream" }
  });
}
var BOUNTY_HOME = process.env.BOUNTY_HOME ?? join(homedir(), ".bounty");
var SNAPSHOTS_DIR = join(BOUNTY_HOME, "snapshots");
var SHUTDOWN_WATCHDOG_MS = Number(process.env.BOUNTY_SHUTDOWN_WATCHDOG_MS ?? 5000);
var DAEMON_LOG = join(BOUNTY_HOME, "daemon.log");
var MAX_STATUS_HISTORY = 20;
function computeDuePokes(tasks, pokeState, now) {
  const next = new Map;
  const pokes = [];
  for (const task of tasks) {
    if (task.status !== "doing" || task.enteredStatusAt === undefined)
      continue;
    const exp = expectedMinutes(task);
    if (exp === undefined)
      continue;
    if (isBlocked(task, tasks))
      continue;
    const expMs = exp * 60000;
    const overdueByMs = now - (task.enteredStatusAt + expMs);
    if (overdueByMs < 0)
      continue;
    const last = pokeState.get(task.id);
    if (last === undefined || now - last >= expMs) {
      pokes.push({ taskId: task.id, owner: task.owner, overdueByMs, expectedMinutes: exp });
      next.set(task.id, now);
    } else {
      next.set(task.id, last);
    }
  }
  return { pokes, pokeState: next };
}
function shouldIdleClose(subscriberCount, idleMs, timeoutMs) {
  if (subscriberCount > 0)
    return false;
  return idleMs >= timeoutMs;
}
function snapshotTaskCount(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed.tasks) ? parsed.tasks.length : null;
  } catch {
    return null;
  }
}
function shouldRotateSnapshot(priorTaskCount, nextTaskCount, alreadyRotatedThisSession) {
  if (alreadyRotatedThisSession)
    return false;
  if (priorTaskCount === null)
    return false;
  return nextTaskCount < priorTaskCount;
}
function transitionStamp(prev, status, now) {
  const statusHistory = [...prev ?? [], { status, at: now }].slice(-MAX_STATUS_HISTORY);
  return { enteredStatusAt: now, statusHistory };
}
var PORT_SUFFIX_RE = /-p(\d{2,5})$/;
var VALID_STATUS = ["todo", "doing", "review", "done"];
function parsePortFromSessionId(sid) {
  const m = sid?.match(PORT_SUFFIX_RE);
  if (!m)
    return null;
  const port = parseInt(m[1], 10);
  return port >= 1 && port <= 65535 ? port : null;
}
function htmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}
function randHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" });
  } catch {}
}
var MIME_BY_EXT = {
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
  ".woff2": "font/woff2"
};
function guessMime(name) {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}
function cleanTags(value) {
  if (!Array.isArray(value))
    return [];
  const out = [];
  for (const x of value) {
    if (typeof x !== "string")
      continue;
    const t = x.trim();
    if (t && !out.includes(t))
      out.push(t);
  }
  return out;
}
function taskRejection(t) {
  if (!t || typeof t !== "object")
    return "not a JSON object";
  const cand = t;
  if (typeof cand.id !== "string")
    return "missing `id` (string, REQUIRED \u2014 init does not mint ids; `add` does)";
  if (typeof cand.title !== "string")
    return "missing `title` (string, required)";
  if (typeof cand.status !== "string" || !VALID_STATUS.includes(cand.status))
    return `invalid \`status\` (required, one of ${VALID_STATUS.join(" | ")})`;
  if (cand.notes !== undefined && typeof cand.notes !== "string")
    return "`notes` must be a string";
  if (cand.owner !== undefined && typeof cand.owner !== "string")
    return "`owner` must be a string";
  if (cand.blockedBy !== undefined && (!Array.isArray(cand.blockedBy) || cand.blockedBy.some((x) => typeof x !== "string")))
    return "`blockedBy` must be an array of strings";
  return null;
}
function validateTask(t) {
  if (taskRejection(t) !== null)
    return null;
  const cand = t;
  const tags = cleanTags(cand.tags);
  const enteredStatusAt = typeof cand.enteredStatusAt === "number" ? cand.enteredStatusAt : undefined;
  const statusHistory = Array.isArray(cand.statusHistory) ? cand.statusHistory.filter((h) => !!h && typeof h === "object" && VALID_STATUS.includes(h.status) && typeof h.at === "number") : undefined;
  const size = typeof cand.size === "string" && cand.size in SIZE_MINUTES ? cand.size : undefined;
  const expect = typeof cand.expect === "number" && cand.expect > 0 ? cand.expect : undefined;
  return {
    id: cand.id,
    title: cand.title,
    status: cand.status,
    ...cand.notes !== undefined ? { notes: cand.notes } : {},
    ...cand.owner !== undefined ? { owner: cand.owner } : {},
    ...cand.blockedBy !== undefined ? { blockedBy: cand.blockedBy } : {},
    ...tags.length ? { tags } : {},
    ...enteredStatusAt !== undefined ? { enteredStatusAt } : {},
    ...statusHistory?.length ? { statusHistory } : {},
    ...size !== undefined ? { size } : {},
    ...expect !== undefined ? { expect } : {}
  };
}
function applyTaskAdd(state, task, now = Date.now()) {
  if (state.tasks.some((t) => t.id === task.id))
    return false;
  const stamped = task.enteredStatusAt === undefined ? { ...task, ...transitionStamp(task.statusHistory, task.status, now) } : task;
  state.tasks.push(stamped);
  return true;
}
function applyTaskUpdate(state, id, patch, now = Date.now()) {
  const idx = state.tasks.findIndex((t) => t.id === id);
  if (idx === -1)
    return false;
  if (patch.status && !VALID_STATUS.includes(patch.status)) {
    const { status: _drop, ...rest } = patch;
    patch = rest;
  }
  const prev = state.tasks[idx];
  const merged = { ...prev, ...patch };
  if (patch.status !== undefined && patch.status !== prev.status) {
    Object.assign(merged, transitionStamp(prev.statusHistory, patch.status, now));
  }
  state.tasks[idx] = merged;
  return true;
}
function applyTaskRemove(state, id) {
  const idx = state.tasks.findIndex((t) => t.id === id);
  if (idx === -1)
    return false;
  state.tasks.splice(idx, 1);
  return true;
}
function applyTaskMove(state, id, status, index, now = Date.now()) {
  const fromIdx = state.tasks.findIndex((t) => t.id === id);
  if (fromIdx === -1)
    return -1;
  const [task] = state.tasks.splice(fromIdx, 1);
  if (task.status !== status) {
    Object.assign(task, { status }, transitionStamp(task.statusHistory, status, now));
  }
  const clamped = Math.max(0, Math.floor(index));
  let seen = 0;
  let insertAt = state.tasks.length;
  for (let i = 0;i < state.tasks.length; i++) {
    if (state.tasks[i].status !== status)
      continue;
    if (seen === clamped) {
      insertAt = i;
      break;
    }
    seen++;
  }
  state.tasks.splice(insertAt, 0, task);
  return insertAt;
}
function isNoOpUpdate(state, id, patch) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task)
    return false;
  let eff = patch;
  if (eff.status && !VALID_STATUS.includes(eff.status)) {
    const { status: _drop, ...rest } = eff;
    eff = rest;
  }
  return Object.keys(eff).every((k) => task[k] === eff[k]);
}
function isNoOpMove(state, id, status, index) {
  if (!state.tasks.some((t) => t.id === id))
    return false;
  const columnView = (s) => VALID_STATUS.map((st) => s.tasks.filter((t) => t.status === st).map((t) => t.id).join(",")).join("|");
  const before = columnView(state);
  const probe = { ...state, tasks: state.tasks.map((t) => ({ ...t })) };
  applyTaskMove(probe, id, status, index);
  return before === columnView(probe);
}
async function main(argv) {
  let parsed;
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
        restore: { type: "string" }
      },
      strict: true,
      allowPositionals: false
    });
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}
`);
    return 2;
  }
  const v = parsed.values;
  const timeout = parseFloat(v.timeout);
  let port = parseInt(v.port, 10);
  const host = v.host;
  let sessionId = v.id ?? "";
  if (port === 0 && sessionId) {
    const embedded = parsePortFromSessionId(sessionId);
    if (embedded !== null)
      port = embedded;
  }
  const logDaemon = (reason2, extra) => {
    try {
      mkdirSync(BOUNTY_HOME, { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        session_id: sessionId,
        pid: process.pid,
        reason: reason2,
        ...extra
      });
      appendFileSync(DAEMON_LOG, `${line}
`);
    } catch {}
  };
  let requestShutdown = null;
  const onFatal = (signal, code2) => () => {
    if (requestShutdown)
      requestShutdown(code2, "signal", signal);
    else {
      logDaemon("signal", { signal, phase: "pre-init" });
      process.exit(code2);
    }
  };
  process.on("uncaughtException", (e) => {
    logDaemon("uncaughtException", {
      error: String(e),
      stack: e instanceof Error ? e.stack : undefined
    });
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    logDaemon("unhandledRejection", { error: String(e) });
  });
  process.on("SIGTERM", onFatal("SIGTERM", 143));
  process.on("SIGINT", onFatal("SIGINT", 130));
  const mode = resolveMode();
  let devIndex;
  if (mode === "dev") {
    try {
      devIndex = (await import("../../../../../src/bounty/surface/index.html")).default;
    } catch (e) {
      process.stderr.write(`bounty: cannot start in dev mode \u2014 the surface source is missing.
` + `  needed: src/bounty/surface/index.html (relative to the repo root)
  reason: ${e instanceof Error ? e.message : String(e)}
  A published spell ships a built dist/ and resolves to release mode; dev mode
  needs the repo. Unset SPELLBOOK_SURFACE_MODE, or run from a checkout.
`);
      return 2;
    }
  }
  const routes = devIndex ? { "/": devIndex } : {};
  const assetsDir = join(SCRIPT_DIR, "..", "assets");
  const state = { title: v.title, tasks: [] };
  let restoreFailed = null;
  if (v.restore) {
    const restoreArg = v.restore;
    const restorePath = existsSync(restoreArg) ? restoreArg : join(SNAPSHOTS_DIR, `${restoreArg}.json`);
    try {
      const snap = JSON.parse(readFileSync(restorePath, "utf8"));
      const merged = { title: state.title, tasks: [], ...snap };
      if (typeof merged.title === "string")
        state.title = merged.title;
      state.tasks = Array.isArray(merged.tasks) ? merged.tasks.map(validateTask).filter((t) => t !== null) : [];
    } catch (e) {
      restoreFailed = {
        path: restorePath,
        reason: e instanceof Error ? e.message : String(e)
      };
      process.stderr.write(`bounty: restore failed (${restorePath}): ${restoreFailed.reason}
`);
    }
  }
  const sockets = new Set;
  const events = [];
  let eventSeq = 0;
  const enc = new TextEncoder;
  const sseClients = new Set;
  const sseTimers = new Set;
  let snapDirty = false;
  let rotatedThisSession = false;
  let snapshotBackedUp = null;
  const saveSnapshot = () => {
    try {
      mkdirSync(SNAPSHOTS_DIR, { recursive: true });
      const path = join(SNAPSHOTS_DIR, `${sessionId}.json`);
      const prior = snapshotTaskCount(path);
      if (prior !== null && shouldRotateSnapshot(prior, state.tasks.length, rotatedThisSession)) {
        const backup = join(SNAPSHOTS_DIR, `${sessionId}.pre-${Date.now()}.bak.json`);
        copyFileSync(path, backup);
        rotatedThisSession = true;
        snapshotBackedUp = {
          path: backup,
          taskCount: prior,
          reason: `about to write ${state.tasks.length} tasks over ${prior}`
        };
        logDaemon("snapshotBackedUp", {
          backup,
          priorTasks: prior,
          nextTasks: state.tasks.length
        });
        emitEvent({
          type: "snapshotBackedUp",
          backup,
          priorTasks: prior,
          nextTasks: state.tasks.length,
          by: "system"
        });
        process.stderr.write(`bounty: snapshot was about to shrink ${prior} \u2192 ${state.tasks.length} tasks; copied the old one to ${backup}
`);
      }
      writeFileSync(path, JSON.stringify(state));
    } catch {}
  };
  const DIRTYING = new Set([
    "init",
    "task.add",
    "task.update",
    "task.remove",
    "task.toggle",
    "task.move",
    "task.edit"
  ]);
  let resolveDone;
  let settled = false;
  const done = new Promise((res) => {
    resolveDone = (v2) => {
      if (settled)
        return;
      settled = true;
      res(v2);
    };
  });
  let shutdownWatchdog = null;
  requestShutdown = (code2, reason2, signal) => {
    logDaemon("signal", { signal, subscribers: sockets.size + sseClients.size });
    shutdownWatchdog = setTimeout(() => {
      logDaemon("shutdownWatchdog", { signal, note: "teardown did not finish; forcing exit" });
      process.exit(code2);
    }, SHUTDOWN_WATCHDOG_MS);
    resolveDone({ code: code2, reason: reason2 });
  };
  let lastActivity = performance.now();
  const touch = () => {
    lastActivity = performance.now();
  };
  function broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of sockets) {
      try {
        ws.send(s);
      } catch {}
    }
  }
  function emitEvent(msg) {
    const ev = { id: ++eventSeq, ...msg };
    events.push(ev);
    if (typeof msg.type === "string" && DIRTYING.has(msg.type))
      snapDirty = true;
    const frame = enc.encode(`data: ${JSON.stringify(ev)}

`);
    for (const c of sseClients) {
      try {
        c.enqueue(frame);
      } catch {}
    }
  }
  function sseResponse(url2) {
    touch();
    const since = parseInt(url2.searchParams.get("since") ?? "-1", 10);
    let ref = null;
    let hb = null;
    const stream = new ReadableStream({
      start(controller) {
        ref = controller;
        for (const ev of events) {
          if (ev.id > since) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}

`));
          }
        }
        sseClients.add(controller);
        hb = setInterval(() => {
          try {
            controller.enqueue(enc.encode(`: hb

`));
          } catch {}
        }, 15000);
        sseTimers.add(hb);
      },
      cancel() {
        if (hb) {
          clearInterval(hb);
          sseTimers.delete(hb);
        }
        if (ref)
          sseClients.delete(ref);
      }
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      }
    });
  }
  const ownerOf = (id) => state.tasks.find((t) => t.id === id)?.owner;
  function canReach(from, target, seen = new Set) {
    if (from === target)
      return true;
    if (seen.has(from))
      return false;
    seen.add(from);
    const task = state.tasks.find((t) => t.id === from);
    return (task?.blockedBy ?? []).some((bid) => canReach(bid, target, seen));
  }
  const prevBlocked = new Map;
  for (const t of state.tasks)
    prevBlocked.set(t.id, isBlocked(t, state.tasks));
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
  function projectState() {
    return {
      title: state.title,
      tasks: state.tasks.map((task) => {
        const liveBlockers = (task.blockedBy ?? []).map((bid) => state.tasks.find((t) => t.id === bid)).filter((b) => b !== undefined && b.status !== "done").map((b) => ({ id: b.id, title: b.title, status: b.status }));
        return { ...task, blocked: liveBlockers.length > 0, liveBlockers };
      })
    };
  }
  function handleAgentMsg(msg) {
    const by = typeof msg.as === "string" ? msg.as : "agent";
    if (msg.type === "init") {
      if (typeof msg.title === "string")
        state.title = msg.title;
      let dropped = [];
      if (Array.isArray(msg.tasks)) {
        state.tasks = [];
        dropped = msg.tasks.map((raw, index) => ({ index, reason: taskRejection(raw) })).filter((d) => d.reason !== null);
        for (const task of msg.tasks.map(validateTask))
          if (task)
            applyTaskAdd(state, task);
      }
      broadcast({ type: "init", title: state.title, tasks: state.tasks, restoreFailed, sessionId });
      emitEvent({ type: "init", title: state.title, by });
      return {
        ok: true,
        applied: true,
        tasksDropped: dropped.length ? { requested: Array.isArray(msg.tasks) ? msg.tasks.length : 0, dropped } : null
      };
    } else if (msg.type === "task.add") {
      const task = validateTask(msg.task);
      if (!task) {
        return {
          ok: true,
          applied: false,
          error: "task rejected: needs a string id, a string title, and a valid status"
        };
      }
      if (!applyTaskAdd(state, task)) {
        return {
          ok: true,
          applied: false,
          error: `task ${task.id} already exists \u2014 the board is unchanged and the existing task kept its id`
        };
      }
      broadcast({ type: "task.add", task });
      emitEvent({ type: "task.add", task, by, owner: task.owner });
      return { ok: true, applied: true };
    } else if (msg.type === "task.update") {
      if (msg.claim) {
        const existing = state.tasks.find((t) => t.id === msg.id);
        const claimant = typeof msg.as === "string" ? msg.as : undefined;
        if (existing?.owner && existing.owner !== claimant) {
          return {
            ok: true,
            applied: false,
            error: `task ${msg.id} is owned by ${existing.owner}`
          };
        }
      }
      const { blockedBy: _stripped, ...patch } = msg.patch;
      if ("tags" in patch)
        patch.tags = cleanTags(patch.tags);
      if ("size" in patch && !(typeof patch.size === "string" && (patch.size in SIZE_MINUTES))) {
        delete patch.size;
      }
      if ("expect" in patch && !(typeof patch.expect === "number" && patch.expect > 0)) {
        delete patch.expect;
      }
      if (!msg.claim && isNoOpUpdate(state, msg.id, patch)) {
        return { ok: true, applied: false };
      }
      if (applyTaskUpdate(state, msg.id, patch)) {
        broadcast({ type: "task.update", id: msg.id, patch });
        emitEvent({ type: "task.update", taskId: msg.id, patch, by, owner: ownerOf(msg.id) });
        return { ok: true, applied: true };
      }
      return { ok: true, applied: false, error: `no such task ${msg.id}` };
    } else if (msg.type === "task.remove") {
      const owner = ownerOf(msg.id);
      if (applyTaskRemove(state, msg.id)) {
        broadcast({ type: "task.remove", id: msg.id });
        emitEvent({ type: "task.remove", taskId: msg.id, by, owner });
        return { ok: true, applied: true };
      }
      return { ok: true, applied: false, error: `no such task ${msg.id}` };
    } else if (msg.type === "task.block") {
      const task = state.tasks.find((t) => t.id === msg.id);
      if (!task)
        return { ok: true, applied: false, error: `no such task ${msg.id}` };
      const unknown = msg.on.filter((b) => !state.tasks.some((t) => t.id === b));
      if (unknown.length)
        return {
          ok: true,
          applied: false,
          error: `no such task${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} \u2014 ` + `nothing was blocked (a blocker that does not exist would constrain nothing)`
        };
      for (const b of msg.on) {
        if (canReach(b, msg.id)) {
          return { ok: true, applied: false, error: `would create a cycle: ${msg.id} \u2192 ${b}` };
        }
      }
      const next = Array.from(new Set([...task.blockedBy ?? [], ...msg.on]));
      applyTaskUpdate(state, msg.id, { blockedBy: next });
      broadcast({ type: "task.update", id: msg.id, patch: { blockedBy: next } });
      emitEvent({
        type: "task.update",
        taskId: msg.id,
        patch: { blockedBy: next },
        by,
        owner: task.owner
      });
      return { ok: true, applied: true };
    } else if (msg.type === "task.unblock") {
      const task = state.tasks.find((t) => t.id === msg.id);
      if (!task)
        return { ok: true, applied: false, error: `no such task ${msg.id}` };
      const next = (task.blockedBy ?? []).filter((b) => !msg.on.includes(b));
      applyTaskUpdate(state, msg.id, { blockedBy: next });
      broadcast({ type: "task.update", id: msg.id, patch: { blockedBy: next } });
      emitEvent({
        type: "task.update",
        taskId: msg.id,
        patch: { blockedBy: next },
        by,
        owner: task.owner
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
  let server;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      routes,
      development: { hmr: mode === "dev" },
      idleTimeout: 255,
      fetch: (req, srv) => {
        const url2 = new URL(req.url);
        const path = url2.pathname;
        if (path === "/ws") {
          const upgraded = srv.upgrade(req);
          if (upgraded)
            return;
          return new Response("upgrade required", { status: 426 });
        }
        if (req.method === "GET" && path === "/state") {
          touch();
          return new Response(JSON.stringify({
            state: projectState(),
            cursor: eventSeq,
            snapshotBackedUp,
            restoreFailed
          }), { headers: { "Content-Type": "application/json" } });
        }
        if (req.method === "GET" && path === "/events") {
          return sseResponse(url2);
        }
        if (req.method === "POST" && path === "/cmd") {
          return req.json().then((body) => {
            touch();
            const result = handleAgentMsg(body);
            reconcileBlocked();
            return new Response(JSON.stringify(result), {
              headers: { "Content-Type": "application/json" }
            });
          }).catch(() => new Response('{"error":"bad json"}', {
            status: 400,
            headers: { "Content-Type": "application/json" }
          }));
        }
        if (req.method === "GET" && path.startsWith("/assets/")) {
          const assetName = decodeURIComponent(path.slice("/assets/".length));
          if (assetName.includes("..") || assetName.startsWith("/")) {
            return new Response('{"error":"not found"}', {
              status: 404,
              headers: { "Content-Type": "application/json" }
            });
          }
          const f = Bun.file(join(assetsDir, assetName));
          return f.exists().then((exists) => exists ? new Response(f, { headers: { "Content-Type": guessMime(assetName) } }) : new Response('{"error":"not found"}', {
            status: 404,
            headers: { "Content-Type": "application/json" }
          }));
        }
        if (mode === "release" && req.method === "GET") {
          const served = serveDist(path);
          if (served)
            return served;
        }
        return new Response('{"error":"not found"}', {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
          touch();
          emitEvent({ type: "connected", by: "user" });
          ws.send(JSON.stringify({
            type: "init",
            title: state.title,
            tasks: state.tasks,
            restoreFailed,
            sessionId
          }));
        },
        message(_ws, raw) {
          touch();
          let msg;
          try {
            msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
          } catch (e) {
            process.stderr.write(`bounty: bad json from browser: ${e instanceof Error ? e.message : String(e)}
`);
            return;
          }
          if (msg.type === "task.toggle") {
            if (!VALID_STATUS.includes(msg.status))
              return;
            if (isNoOpUpdate(state, msg.id, { status: msg.status }))
              return;
            if (applyTaskUpdate(state, msg.id, { status: msg.status })) {
              broadcast({ type: "task.update", id: msg.id, patch: { status: msg.status } });
              emitEvent({
                type: "task.toggle",
                taskId: msg.id,
                status: msg.status,
                by: "user",
                owner: ownerOf(msg.id)
              });
            }
          } else if (msg.type === "task.move") {
            if (!VALID_STATUS.includes(msg.status))
              return;
            if (isNoOpMove(state, msg.id, msg.status, msg.index))
              return;
            if (applyTaskMove(state, msg.id, msg.status, msg.index) !== -1) {
              broadcast({
                type: "init",
                title: state.title,
                tasks: state.tasks,
                restoreFailed,
                sessionId
              });
              emitEvent({
                type: "task.move",
                taskId: msg.id,
                status: msg.status,
                index: msg.index,
                by: "user",
                owner: ownerOf(msg.id)
              });
            }
          } else if (msg.type === "task.edit") {
            const patch = {};
            if (msg.title !== undefined) {
              if (typeof msg.title !== "string" || msg.title.trim() === "")
                return;
              patch.title = msg.title;
            }
            if (msg.notes !== undefined) {
              if (typeof msg.notes !== "string")
                return;
              patch.notes = msg.notes;
            }
            if (Object.keys(patch).length === 0)
              return;
            if (applyTaskUpdate(state, msg.id, patch)) {
              broadcast({ type: "task.update", id: msg.id, patch });
              emitEvent({
                type: "task.edit",
                taskId: msg.id,
                ...patch,
                by: "user",
                owner: ownerOf(msg.id)
              });
            }
          } else if (msg.type === "task.add") {
            const task = validateTask(msg.task);
            if (task && applyTaskAdd(state, task)) {
              broadcast({ type: "task.add", task });
              emitEvent({ type: "task.add", task, by: "user", owner: task.owner });
            }
          } else if (msg.type === "task.remove") {
            const owner = ownerOf(msg.id);
            if (applyTaskRemove(state, msg.id)) {
              broadcast({ type: "task.remove", id: msg.id });
              emitEvent({ type: "task.remove", taskId: msg.id, by: "user", owner });
            }
          } else if (msg.type === "close") {
            resolveDone({ code: 0, reason: "user" });
          }
          reconcileBlocked();
        },
        close(ws) {
          sockets.delete(ws);
          emitEvent({ type: "disconnected", by: "user" });
        }
      }
    });
  } catch (e) {
    process.stderr.write(`${JSON.stringify({
      event: "bind_error",
      host,
      port,
      error: e instanceof Error ? e.message : String(e)
    })}
`);
    return 2;
  }
  const boundPort = server.port;
  if (!sessionId)
    sessionId = `bounty-${randHex(4)}-p${boundPort}`;
  const url = `http://${host}:${boundPort}`;
  emitEvent({ type: "ready", url, port: boundPort, session_id: sessionId, mode, by: "system" });
  logDaemon("ready", { port: boundPort });
  const sessionFile = join(tmpdir(), `bounty-${sessionId}.json`);
  const latestFile = join(tmpdir(), `bounty-latest.json`);
  const sessionInfo = JSON.stringify({
    url,
    port: boundPort,
    session_id: sessionId,
    title: state.title,
    mode,
    restoreFailed
  });
  const writeAtomic = (target, text) => {
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, text);
      renameSync(tmp, target);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {}
      throw err;
    }
  };
  try {
    writeAtomic(sessionFile, sessionInfo);
    writeAtomic(latestFile, sessionInfo);
  } catch (e) {
    process.stderr.write(`bounty: could not write discovery file: ${e instanceof Error ? e.message : String(e)}
`);
  }
  const cleanupDiscovery = async () => {
    try {
      unlinkSync(sessionFile);
    } catch {}
    try {
      const cur = await Bun.file(latestFile).text();
      const parsed2 = JSON.parse(cur);
      if (parsed2.session_id === sessionId)
        unlinkSync(latestFile);
    } catch {}
  };
  if (!v["no-open"])
    openBrowser(url);
  const idleTimer = setInterval(() => {
    const subscriberCount = sockets.size + sseClients.size;
    if (subscriberCount > 0)
      touch();
    if (shouldIdleClose(subscriberCount, performance.now() - lastActivity, timeout * 1000)) {
      resolveDone({ code: 124, reason: "timeout" });
    }
  }, 250);
  const snapTimer = setInterval(() => {
    if (snapDirty) {
      snapDirty = false;
      saveSnapshot();
    }
  }, 1000);
  let pokeState = new Map;
  const heartbeatTimer = setInterval(() => {
    const swept = computeDuePokes(state.tasks, pokeState, Date.now());
    pokeState = swept.pokeState;
    for (const p of swept.pokes) {
      const label = state.tasks.find((t) => t.id === p.taskId)?.title ?? p.taskId;
      const overdueMin = Math.max(1, Math.round(p.overdueByMs / 60000));
      if (p.owner) {
        emitEvent({
          type: "heartbeat",
          taskId: p.taskId,
          owner: p.owner,
          overdueByMs: p.overdueByMs,
          expectedMinutes: p.expectedMinutes,
          by: "system"
        });
      }
      broadcast({
        type: "message",
        text: `\u23F0 "${label}" overdue \u2014 ~${overdueMin}m past its ${p.expectedMinutes}m estimate${p.owner ? ` (@${p.owner})` : ""}`
      });
    }
  }, 30000);
  const { code, reason } = await done;
  logDaemon("exit", {
    reason,
    subscribers: sockets.size + sseClients.size,
    idleMs: performance.now() - lastActivity
  });
  if (shutdownWatchdog)
    clearTimeout(shutdownWatchdog);
  clearInterval(idleTimer);
  clearInterval(snapTimer);
  clearInterval(heartbeatTimer);
  saveSnapshot();
  emitEvent({ type: "closed", reason, by: "system" });
  broadcast({ type: "message", text: `session ended: ${reason}` });
  await new Promise((r) => setTimeout(r, 150));
  for (const t of sseTimers)
    clearInterval(t);
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
async function run() {
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
  resolveMode,
  run,
  shouldIdleClose,
  shouldRotateSnapshot,
  snapshotTaskCount,
  validateTask
};

//# debugId=72070E843FBE136364756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2JvdW50eS9iYWNrZW5kL3NlcnZlci50cyIsICIuLi9zaGFyZWQvdHlwZXMudHMiLCAiLi4vc2hhcmVkL3ByZWRpY2F0ZXMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIGJvdW50eSDigJQgYWdlbnQtZHJpdmVuIHRhc2sgYm9hcmQgdGhlIHVzZXIgY2FuIGludGVyYWN0IHdpdGguXG4vL1xuLy8gVGhlIGhvdXNlIGFnZW50LWludGVyZmFjZSBwYXR0ZXJuIChzaGFyZWQgd2l0aCBncmFwZXZpbmUgKyBpbWFnbyk6IGFcbi8vIHBlcnNpc3RlbnQgZGFlbW9uIGhvbGRzIHRoZSBjYW5vbmljYWwgc3RhdGU7IHRoZSBhZ2VudCBkcml2ZXMgaXQgdGhyb3VnaCBhXG4vLyB0aGluIGBjbGkudHNgIG92ZXIgSFRUUCwgYW5kIHRoZSBicm93c2VyIGlzIHdpcmVkIG92ZXIgV2ViU29ja2V0LlxuLy9cbi8vICAgLSBBZ2VudCDihpIgZGFlbW9uOiAgUE9TVCAvY21kICAgICAgICAgIChhbiBBZ2VudENvbW1hbmQ7IHdyaXRlIHBhdGgpXG4vLyAgIC0gQWdlbnQg4oaQIGRhZW1vbjogIEdFVCAgL3N0YXRlWz9sZWFuPTFdICAoeyBzdGF0ZSwgY3Vyc29yIH0gcmVhZC1iYWNrKVxuLy8gICAgICAgICAgICAgICAgICAgICAgR0VUICAvZXZlbnRzP3NpbmNlPTxpZD4gIChTU0UgZXZlbnQgdGFpbCwgcmVzdW1hYmxlKVxuLy8gICAtIEJyb3dzZXIg4oaUIGRhZW1vbjogV2ViU29ja2V0IC93cyAgICAgKHNhbWUgdGFzay4qIGV2ZW50cyBib3RoIHdheXMpXG4vLyAgIC0gVGhlIGRhZW1vbiBob2xkcyBjYW5vbmljYWwgc3RhdGU7IGxhdGUtam9pbmluZyBicm93c2VycyByZWNlaXZlIGFcbi8vICAgICBzeW50aGV0aWMgaW5pdCBvbiBjb25uZWN0LiBUaGF0IGluaXQgY2FycmllcyBgcmVzdG9yZUZhaWxlZGAgKGIxNikgc28gdGhlXG4vLyAgICAgaHVtYW4gY2hhbm5lbCBjYW4gcmVwb3J0IGEgYnJva2VuIHJlc3RvcmUg4oCUIHRoZSBhZ2VudCBhbHJlYWR5IGhhZCBpdCBvblxuLy8gICAgIHRoZSBgb3BlbmAgcGF5bG9hZCBhbmQgR0VUIC9zdGF0ZSwgYW5kIHRoZSBicm93c2VyIGlzIHRoZSBvbmx5IGNoYW5uZWxcbi8vICAgICB3aGVyZSBhbiB1bmV4cGxhaW5lZCBlbXB0eSBib2FyZCBpcyB3aGF0IGEgcGVyc29uIGFjdHVhbGx5IFNFRVMuXG4vL1xuLy8gQWdlbnRDb21tYW5kIOKAlCBQT1NUIC9jbWQgYm9keSAob25lIG9mKS4gQWxsIGNhcnJ5IGFuIG9wdGlvbmFsIGBhc2AgKGNhbGxlclxuLy8gaWRlbnRpdHkg4oaSIGV2ZW50IGBieWApOyAvY21kIHJldHVybnMge29rLCBhcHBsaWVkPywgZXJyb3I/fTpcbi8vICAge1widHlwZVwiOlwiaW5pdFwiLCAgICAgICAgXCJ0aXRsZVwiOiBcIi4uLlwiLCBcInRhc2tzXCI6IFRhc2tbXX1cbi8vICAge1widHlwZVwiOlwidGFzay5hZGRcIiwgICAgXCJ0YXNrXCI6IFRhc2t9ICAgICAgICAgICAgICAvLyBhcHBlbmRcbi8vICAge1widHlwZVwiOlwidGFzay51cGRhdGVcIiwgXCJpZFwiOiBcIi4uLlwiLCBcInBhdGNoXCI6IFBhcnRpYWw8VGFzaz4sIFwiY2xhaW1cIj86IGJvb2x9XG4vLyAgIHtcInR5cGVcIjpcInRhc2sucmVtb3ZlXCIsIFwiaWRcIjogXCIuLi5cIn1cbi8vICAge1widHlwZVwiOlwidGFzay5ibG9ja1wiLCAgXCJpZFwiOiBcIi4uLlwiLCBcIm9uXCI6IHN0cmluZ1tdfSAgIC8vIGFkZCBibG9ja2VyIGVkZ2VzIChjeWNsZS1ndWFyZGVkKVxuLy8gICB7XCJ0eXBlXCI6XCJ0YXNrLnVuYmxvY2tcIixcImlkXCI6IFwiLi4uXCIsIFwib25cIjogc3RyaW5nW119ICAgLy8gcmVtb3ZlIGJsb2NrZXIgZWRnZXNcbi8vICAge1widHlwZVwiOlwibWVzc2FnZVwiLCAgICAgXCJ0ZXh0XCI6IFwiLi4uXCJ9ICAgICAgICAgICAgIC8vIHRvYXN0XG4vLyAgIHtcInR5cGVcIjpcImNsb3NlXCJ9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIGVuZCBzZXNzaW9uXG4vL1xuLy8gRXZlbnQgbG9nIOKAlCBHRVQgL2V2ZW50cyBmcmFtZXMgKHNlcnZlciDihpIgYWdlbnQpLCBlYWNoIHdpdGggYSBtb25vdG9uaWMgYGlkYFxuLy8gKHRoZSByZXN1bWUgY3Vyc29yKSwgYW4gYWN0b3IgYGJ5YCAodGhlIGNhbGxlcidzIC0tYXMgfCBcInVzZXJcIiB8IFwic3lzdGVtXCIpLFxuLy8gYW5kICh0YXNrLiogKyB1bmJsb2NrZWQpIHRoZSBhZmZlY3RlZCB0YXNrJ3MgYG93bmVyYCBmb3IgY2xpZW50LXNpZGUgc2NvcGluZzpcbi8vICAge2lkLCB0eXBlOlwicmVhZHlcIiwgICAgICAgIHVybCwgcG9ydCwgc2Vzc2lvbl9pZCwgYnk6XCJzeXN0ZW1cIn1cbi8vICAge2lkLCB0eXBlOlwiY29ubmVjdGVkXCIgfCBcImRpc2Nvbm5lY3RlZFwiLCBieTpcInVzZXJcIn1cbi8vICAge2lkLCB0eXBlOlwidGFzay50b2dnbGVcIiwgIHRhc2tJZCwgc3RhdHVzLCBieSwgb3duZXJ9ICAvLyDimqAgdGFza0lkLCBOT1QgaWQg4oCUXG4vLyAgIHtpZCwgdHlwZTpcInRhc2subW92ZVwiLCAgICB0YXNrSWQsIHN0YXR1cywgaW5kZXgsIGJ5LCBvd25lcn0gIC8vICBlbnZlbG9wZSBpZFxuLy8gICB7aWQsIHR5cGU6XCJ0YXNrLmVkaXRcIiwgICAgdGFza0lkLCB0aXRsZT8sIG5vdGVzPywgYnksIG93bmVyfSAgLy8gaXMgdGhlIGN1cnNvcjtcbi8vICAge2lkLCB0eXBlOlwidGFzay5hZGRcIiwgICAgIHRhc2ssIGJ5LCBvd25lcn0gICAgICAgICAgICAvLyAgIHRhc2sgaWQgaXMgbmVzdGVkXG4vLyAgIHtpZCwgdHlwZTpcInRhc2sudXBkYXRlXCIsICB0YXNrSWQsIHBhdGNoLCBieSwgb3duZXJ9ICAgLy8gICAvIGB0YXNrSWRgIHNvIHRoZVxuLy8gICB7aWQsIHR5cGU6XCJ0YXNrLnJlbW92ZVwiLCAgdGFza0lkLCBieSwgb3duZXJ9ICAgICAgICAgIC8vICAgc3ByZWFkIGNhbid0IGNsb2JiZXIuXG4vLyAgIHtpZCwgdHlwZTpcInVuYmxvY2tlZFwiLCAgICB0YXNrSWQsIG93bmVyLCBieTpcInN5c3RlbVwifSAvLyBsYXN0IGJsb2NrZXIgY2xlYXJlZFxuLy8gICB7aWQsIHR5cGU6XCJoZWFydGJlYXRcIiwgICAgdGFza0lkLCBvd25lciwgb3ZlcmR1ZUJ5TXMsIGV4cGVjdGVkTWludXRlcywgYnk6XCJzeXN0ZW1cIn1cbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyAgIG93bmVyLXNjb3BlZCBvdmVycnVuIHBva2Vcbi8vICAge2lkLCB0eXBlOlwiY2xvc2VkXCIsICAgICAgIHJlYXNvbiwgYnk6XCJzeXN0ZW1cIn0gICAgLy8gICByZWFzb246IHVzZXJ8dGltZW91dHxjbG9zZVxuLy9cbi8vIHRhc2sudG9nZ2xlIHZzIHRhc2subW92ZTogdG9nZ2xlIGlzIHRoZSBjbGljay1hLXBpbGwgVVgg4oCUIHN0YXR1cyBjaGFuZ2VzLFxuLy8gdGFzayBpcyBhcHBlbmRlZCB0byB0aGUgZGVzdGluYXRpb24gY29sdW1uLiBtb3ZlIGlzIHRoZSBkcmFnIFVYIOKAlCBzdGF0dXNcbi8vIEFORCBleHBsaWNpdCBwb3NpdGlvbiBpbiB0aGUgZGVzdGluYXRpb24gY29sdW1uLiBBZ2VudHMgdGhhdCBvbmx5IGNhcmVcbi8vIGFib3V0IGNvbHVtbiBtZW1iZXJzaGlwIGNhbiBpZ25vcmUgLm1vdmUgYW5kIHJlbHkgb24gdGhlIGNhbm9uaWNhbCBvcmRlclxuLy8gdGhlIGRhZW1vbiBrZWVwcy5cbi8vXG4vLyBFeGl0IGNvZGVzOiAwIG9uIGFueSBjbGVhbiBkaXNtaXNzICh0aGUgaHVtYW4ncyBcIkNsb3NlIGJvYXJkXCIg4oaSIHJlYXNvbiBcInVzZXJcIixcbi8vIG9yIGFuIGFnZW50IGNsaS50cyBjbG9zZSDihpIgcmVhc29uIFwiY2xvc2VcIiksIDIgYmFkIGFyZ3MsIDEyNCBpZGxlIHRpbWVvdXQuIFRoZVxuLy8gYm9hcmQgaXMgYSBjb25qdXJhdGlvbiDigJQgdGhlcmUncyBubyBcImNhbmNlbFwiLzEzMCBkaXNjYXJkIHBhdGguXG5cbmltcG9ydCB7XG4gIGFwcGVuZEZpbGVTeW5jLFxuICBjb3B5RmlsZVN5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICByZW5hbWVTeW5jLFxuICBybVN5bmMsXG4gIHVubGlua1N5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyLCB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB0eXBlIHsgU2VydmVyV2ViU29ja2V0IH0gZnJvbSBcImJ1blwiO1xuaW1wb3J0IHtcbiAgZXhwZWN0ZWRNaW51dGVzLFxuICBpc0Jsb2NrZWQsXG59IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvYm91bnR5L3NoYXJlZC9wcmVkaWNhdGVzXCI7XG4vLyBUaGUgc2VhbSAoMjAyNi0wOS0wNikuIFR5cGVzIGFuZCB0aGUgZm91ciBib2FyZCBwcmVkaWNhdGVzIGxpdmUgb25lIGxldmVsIHVwLFxuLy8gaW4gdGhlIHRyYWNrZWQgc2tpbGwgc3VidHJlZSwgc28gdGhlIFJlYWN0IHN1cmZhY2UgYXQgc3JjL2JvdW50eS8gaW1wb3J0cyB0aGVcbi8vIFNBTUUgY29kZSB0aGUgZGFlbW9uIHJ1bnMgaW5zdGVhZCBvZiBoYW5kLW1pcnJvcmluZyBpdCBpbiB0aGUgcGFnZS4gYHNoYXJlZC9gXG4vLyBpcyBpbnNpZGUgd2hhdCB0aGUgbWFya2V0cGxhY2UgY29waWVzLCBzbyB0aGlzIHJlc29sdmVzIGF0IHRoZSBkZXN0aW5hdGlvblxuLy8gd2l0aCBub3RoaW5nIGluc3RhbGxlZCAoc2VhbXMgQ29udHJhY3QgMywgcm93IDEpLlxuaW1wb3J0IHR5cGUge1xuICBCb2FyZFN0YXRlLFxuICBTdGF0dXNWaXNpdCxcbiAgVGFzayxcbiAgVGFza1NpemUsXG4gIFRhc2tTdGF0dXMsXG59IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvYm91bnR5L3NoYXJlZC90eXBlc1wiO1xuaW1wb3J0IHsgU0laRV9NSU5VVEVTIH0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9ib3VudHkvc2hhcmVkL3R5cGVzXCI7XG5cbi8vIFRoZSBib2FyZCdzIEhUTUwgdXNlZCB0byBiZSBgc2NyaXB0cy90ZW1wbGF0ZS5odG1sYCwgcmVhZCBhdCBib290IGFuZCBzdHJpbmdcbi8vIHN1YnN0aXR1dGVkIGJlZm9yZSBldmVyeSByZXNwb25zZS4gSXQgaXMgbm93IGEgUmVhY3Qgc3VyZmFjZSBhdFxuLy8gc3JjL2JvdW50eS9zdXJmYWNlLywgYnVpbHQgaW50byBkaXN0LyAoc2VhbXMgQ29udHJhY3QgMikuIFRoZSBkZXYgZW50cnkgaXMgYVxuLy8gRFlOQU1JQyBpbXBvcnQgcmVhY2hlZCBvbmx5IG9uIHRoZSBkZXYgYnJhbmNoOiBhIHN0YXRpYyBvbmUgd291bGQgZm9yY2UgQnVuXG4vLyB0byByZXNvbHZlIHRoZSB3aG9sZSAudHN4ICsgVGFpbHdpbmQgZ3JhcGggd2hlbiB0aGlzIG1vZHVsZSBMT0FEUywgc28gdGhlXG4vLyBwdWJsaXNoZWQgYXJ0aWZhY3Qg4oCUIHdoaWNoIHNoaXBzIGRpc3QvIGFuZCBubyBzdXJmYWNlIHNvdXJjZSDigJQgd291bGQgZGllXG4vLyBiZWZvcmUgaXQgY291bGQgc2VydmUgdGhlIGRpc3QgaXQgZG9lcyBoYXZlIChDb250cmFjdCAxKS5cbi8vXG4vLyBQYXRocyBhbmNob3IgYXQgdGhlIFNLSUxMIFJPT1QsIG5ldmVyIGF0IGN3ZDogY2xpLnRzIHBpbnMgdGhlIGRhZW1vbidzIGN3ZCB0b1xuLy8gc3JjL2JvdW50eS8gaW4gZGV2IGZvciBidW5maWcudG9tbCdzIHNha2UgKENvbnRyYWN0IDUpLCBzbyBjd2QgaXMgbm90IGFcbi8vIHN0YWJsZSBiYXNlIGZvciBkaXN0Ly5cbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSk7XG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcblxuLy8gcmVsZWFzZSBpZmYgZGlzdC9pbmRleC5odG1sIGV4aXN0cyBhdCB0aGUgc2tpbGwgcm9vdCDigJQgdGhlIEZJTEUsIG5ldmVyIHRoZVxuLy8gZGlyZWN0b3J5IChhIGJ1aWx0IGJhY2tlbmQgY2FuIHB1dCBjbGkuanMgaW4gZGlzdC8gd2l0aCBubyBzdXJmYWNlIHRoZXJlKSDigJRcbi8vIGVsc2UgZGV2OyB0aGUgZW52IG92ZXJyaWRlIHdpbnMgZWl0aGVyIHdheSAoQ29udHJhY3QgMSkuIFJlbGVhc2U6IHplcm8gcmVhZHNcbi8vIG9mIHN1cmZhY2Ugc291cmNlIG9yIGJ1bmZpZy50b21sLCBzdGF0aWMgZmlsZXMgb25seS5cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9kZSgpOiBcImRldlwiIHwgXCJyZWxlYXNlXCIge1xuICBjb25zdCBvdmVycmlkZSA9IHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREU7XG4gIGlmIChvdmVycmlkZSA9PT0gXCJkZXZcIiB8fCBvdmVycmlkZSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBvdmVycmlkZTtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFwicmVsZWFzZVwiIDogXCJkZXZcIjtcbn1cblxuY29uc3QgU1RBVElDX0NPTlRFTlRfVFlQRVM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiLmh0bWxcIjogXCJ0ZXh0L2h0bWw7IGNoYXJzZXQ9dXRmLThcIixcbiAgXCIuanNcIjogXCJ0ZXh0L2phdmFzY3JpcHRcIixcbiAgXCIuY3NzXCI6IFwidGV4dC9jc3NcIixcbiAgXCIuanNvblwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbn07XG5cbi8vIFNlcnZlcyBkaXN0LyB2ZXJiYXRpbSDigJQgdGhlIHVuaGFzaGVkIGVudHJ5IGluZGV4Lmh0bWwgYXQgXCIvXCIsIGFuZCB0aGUgaGFzaGVkXG4vLyBpbmRleC0qLmpzIC8gaW5kZXgtKi5jc3MgaXQgbGlua3MgUkVMQVRJVkVMWSwgd2hpY2ggZnJvbSBcIi9cIiBhcnJpdmUgYXMgYmFyZVxuLy8gZmlsZW5hbWVzIChDb250cmFjdCAyJ3MgZmxhdCBsYXlvdXQpLiBUaGUgZ3VhcmQga2VlcHMgdGhpcyBPTkUgbGV2ZWwgZGVlcDogYVxuLy8gbmVzdGVkIG9yIGAuLmAgcGF0aCBpcyByZWZ1c2VkLCB3aGljaCBhbHNvIGtlZXBzIGl0IGRpc2pvaW50IGZyb20gdGhlIGJvYXJkJ3Ncbi8vIG93biBHRVQgL2Fzc2V0cy88bmFtZT4gcm91dGUgKGV2ZXJ5IC9hc3NldHMvIHBhdGggaXMgbmVzdGVkLCBzbyBpdCBpcyByZWZ1c2VkXG4vLyBoZXJlIGFuZCBmYWxscyB0aHJvdWdoIHRvIHRoYXQgaGFuZGxlcikuXG5mdW5jdGlvbiBzZXJ2ZURpc3QocGF0aDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgY29uc3QgcmVsID0gcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSk7XG4gIGlmICghcmVsIHx8IHJlbC5pbmNsdWRlcyhcIi4uXCIpIHx8IHJlbC5pbmNsdWRlcyhcIi9cIikpIHJldHVybiBudWxsO1xuICBjb25zdCBmaWxlID0gam9pbihESVNUX0RJUiwgcmVsKTtcbiAgaWYgKCFleGlzdHNTeW5jKGZpbGUpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZXh0ID0gcmVsLnNsaWNlKHJlbC5sYXN0SW5kZXhPZihcIi5cIikpO1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKEJ1bi5maWxlKGZpbGUpLCB7XG4gICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBTVEFUSUNfQ09OVEVOVF9UWVBFU1tleHRdID8/IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCIgfSxcbiAgfSk7XG59XG5cbi8vIFBlcnNpc3RlbmNlIHJvb3Q6IGRlYm91bmNlZCBzbmFwc2hvdHMgbGFuZCBpbiAkQk9VTlRZX0hPTUUvc25hcHNob3RzLzxpZD4uanNvblxuLy8gc28gYSBib2FyZCBzdXJ2aXZlcyBhIHJlc3RhcnQgdmlhIGBjbGkudHMgb3BlbiAtLXJlc3RvcmUgPGlkPmAuIGNsaS50cyBkZXJpdmVzXG4vLyB0aGUgc2FtZSBwYXRoLCBzbyBvdmVycmlkZSBCT1VOVFlfSE9NRSB0byByZWxvY2F0ZSBib3RoLlxuY29uc3QgQk9VTlRZX0hPTUUgPSBwcm9jZXNzLmVudi5CT1VOVFlfSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuYm91bnR5XCIpO1xuY29uc3QgU05BUFNIT1RTX0RJUiA9IGpvaW4oQk9VTlRZX0hPTUUsIFwic25hcHNob3RzXCIpO1xuLy8gUDFmIOKAlCBob3cgbG9uZyB0aGUgdGVhcmRvd24gZ2V0cyBhZnRlciBhIHNpZ25hbCBiZWZvcmUgdGhlIHdhdGNoZG9nIGZvcmNlc1xuLy8gdGhlIGV4aXQuIEdlbmVyb3VzIG9uIHB1cnBvc2U6IGl0IGlzIGEgSEFORyBiYWNrc3RvcCwgbm90IGEgZGVhZGxpbmUsIGFuZFxuLy8gdGhlIHRlYXJkb3duJ3Mgb3duIGJvdW5kZWQgd2FpdHMgKDE1MG1zICsgYSAyMDBtcyByYWNlKSB0b3RhbCB3ZWxsIHVuZGVyIGl0LlxuLy8gRW52LW92ZXJyaWRhYmxlIGZvciB0ZXN0cyBvbmx5LlxuY29uc3QgU0hVVERPV05fV0FUQ0hET0dfTVMgPSBOdW1iZXIocHJvY2Vzcy5lbnYuQk9VTlRZX1NIVVRET1dOX1dBVENIRE9HX01TID8/IDUwMDApO1xuXG4vLyBEdXJhYmxlLCBhcHBlbmQtb25seSBkaWFnbm9zdGljcyBsb2cgKCM2NCkuIFRoZSBkYWVtb24gcnVucyBoZWFkbGVzcyDigJQgY2xpLnRzXG4vLyBgb3BlbmAgc3Bhd25zIGl0IHdpdGggc3Rkb3V0L3N0ZGVyciBkaXNjYXJkZWQg4oCUIHNvIGEgZGVhdGggKGlkbGUtY2xvc2UsIGNyYXNoLFxuLy8gc2lnbmFsKSBjdXJyZW50bHkgbGVhdmVzIG5vIHRyYWNlLiBFdmVyeSBsaWZlY3ljbGUgdHJhbnNpdGlvbiBhcHBlbmRzIE9ORSBKU09OXG4vLyBsaW5lIGhlcmU7IGNsaS50cyBhZGRpdGlvbmFsbHkgcG9pbnRzIHRoZSBjaGlsZCdzIG5hdGl2ZSBzdGRlcnIgYXQgdGhpcyBzYW1lXG4vLyBmaWxlIHNvIEJ1bidzIG93biBoYXJkLWFib3J0IG91dHB1dCAod2hpY2ggSlMgaGFuZGxlcnMgY2FuJ3QgY2F0Y2gpIGxhbmRzIHRvby5cbi8vIERpYWdub3N0aWNzIG9ubHkg4oCUIG5vIGJvYXJkIGJlaGF2aW9yIHJlYWRzIHRoaXMuXG5jb25zdCBEQUVNT05fTE9HID0gam9pbihCT1VOVFlfSE9NRSwgXCJkYWVtb24ubG9nXCIpO1xuXG4vLyBDYXAgdGhlIHBlci10YXNrIHRyYW5zaXRpb24gbG9nIHNvIGxvbmctbGl2ZWQgdGFza3MgZG9uJ3QgYmxvYXQgc25hcHNob3RzLlxuY29uc3QgTUFYX1NUQVRVU19ISVNUT1JZID0gMjA7XG5cbnR5cGUgUG9rZSA9IHsgdGFza0lkOiBzdHJpbmc7IG93bmVyPzogc3RyaW5nOyBvdmVyZHVlQnlNczogbnVtYmVyOyBleHBlY3RlZE1pbnV0ZXM6IG51bWJlciB9O1xudHlwZSBQb2tlU3RhdGUgPSBNYXA8c3RyaW5nLCBudW1iZXI+OyAvLyB0YXNrSWQgLT4gbGFzdFBva2VBdCAodW5peCBtcylcblxuLy8gRXZhbHVhdGUgZXZlcnkgdGFzayBmb3IgYW4gb3ZlcmR1ZS1pbi1kb2luZyBwb2tlIGFuZCByZXR1cm4gdGhlIHBva2VzIHRvIGZpcmVcbi8vIHBsdXMgdGhlIG5leHQgcG9rZSBib29ra2VlcGluZy4gQSBkb2luZyB0YXNrIHRoYXQgb3ZlcnJhbiBpdHMgZXhwZWN0ZWQgdGltZVxuLy8gcG9rZXMgb25jZSwgdGhlbiByZS1wb2tlcyBvbmNlIHBlciBleHBlY3RlZC1wZXJpb2QgKGludGVydmFsIHNjYWxlcyB3aXRoIHRoZVxuLy8gZXhwZWN0ZWQgdGltZSDigJQgcHJvcG9ydGlvbmF0ZSwgbm90IGNvbnN0YW50KS4gUmVidWlsZGluZyBgcG9rZVN0YXRlYCBmcm9tXG4vLyBzY3JhdGNoIGVhY2ggc3dlZXAgbWVhbnMgYSB0YXNrIHRoYXQgbGVmdCBkb2luZyBhdXRvLXJlc2V0cy4gUHVyZTogYG5vd2AgaXNcbi8vIGluamVjdGVkIHNvIHRoZSBzd2VlcCBpcyBkZXRlcm1pbmlzdGljYWxseSB0ZXN0YWJsZS5cbmZ1bmN0aW9uIGNvbXB1dGVEdWVQb2tlcyhcbiAgdGFza3M6IFRhc2tbXSxcbiAgcG9rZVN0YXRlOiBQb2tlU3RhdGUsXG4gIG5vdzogbnVtYmVyLFxuKTogeyBwb2tlczogUG9rZVtdOyBwb2tlU3RhdGU6IFBva2VTdGF0ZSB9IHtcbiAgY29uc3QgbmV4dDogUG9rZVN0YXRlID0gbmV3IE1hcCgpO1xuICBjb25zdCBwb2tlczogUG9rZVtdID0gW107XG4gIGZvciAoY29uc3QgdGFzayBvZiB0YXNrcykge1xuICAgIGlmICh0YXNrLnN0YXR1cyAhPT0gXCJkb2luZ1wiIHx8IHRhc2suZW50ZXJlZFN0YXR1c0F0ID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGV4cCA9IGV4cGVjdGVkTWludXRlcyh0YXNrKTtcbiAgICBpZiAoZXhwID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgIGlmIChpc0Jsb2NrZWQodGFzaywgdGFza3MpKSBjb250aW51ZTsgLy8gbGVnaXRpbWF0ZWx5IHdhaXRpbmcgb24gYSBwZWVyIOKAlCBub3Qgc3R1Y2tcbiAgICBjb25zdCBleHBNcyA9IGV4cCAqIDYwXzAwMDtcbiAgICBjb25zdCBvdmVyZHVlQnlNcyA9IG5vdyAtICh0YXNrLmVudGVyZWRTdGF0dXNBdCArIGV4cE1zKTtcbiAgICBpZiAob3ZlcmR1ZUJ5TXMgPCAwKSBjb250aW51ZTsgLy8gbm90IG92ZXJkdWUgeWV0IOKAlCBubyBib29ra2VlcGluZyBuZWVkZWRcbiAgICBjb25zdCBsYXN0ID0gcG9rZVN0YXRlLmdldCh0YXNrLmlkKTtcbiAgICBpZiAobGFzdCA9PT0gdW5kZWZpbmVkIHx8IG5vdyAtIGxhc3QgPj0gZXhwTXMpIHtcbiAgICAgIHBva2VzLnB1c2goeyB0YXNrSWQ6IHRhc2suaWQsIG93bmVyOiB0YXNrLm93bmVyLCBvdmVyZHVlQnlNcywgZXhwZWN0ZWRNaW51dGVzOiBleHAgfSk7XG4gICAgICBuZXh0LnNldCh0YXNrLmlkLCBub3cpO1xuICAgIH0gZWxzZSB7XG4gICAgICBuZXh0LnNldCh0YXNrLmlkLCBsYXN0KTsgLy8gY2FycnkgdGhlIGludGVydmFsIGZvcndhcmRcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHsgcG9rZXMsIHBva2VTdGF0ZTogbmV4dCB9O1xufVxuXG4vLyBvcGVuLXRpbWVvdXQ6IHRoZSBpZGxlLWNsb3NlIGRlY2lzaW9uLCBmYWN0b3JlZCBvdXQgc28gaXQncyBjbG9jay1mcmVlIHRlc3RhYmxlXG4vLyAobGlrZSBjb21wdXRlRHVlUG9rZXMpLiBBIGJvYXJkIG9ubHkgY291bnRzIGl0cyBpZGxlIGZsb29yIGRvd24gd2hpbGUgVU5XQVRDSEVEXG4vLyDigJQgYSBsaXZlIHN1YnNjcmliZXIgKGEgV1MgYnJvd3NlciBpbiBgc29ja2V0c2AgT1IgYW4gYWdlbnQgU1NFIHRhaWwgb24gL2V2ZW50cylcbi8vIGtlZXBzIGl0IG9wZW4gaW5kZWZpbml0ZWx5LiBTbyBgdGltZW91dGAgbWVhbnMgXCJsaW5nZXIgdGhpcyBsb25nIGFmdGVyIHRoZSBMQVNUXG4vLyBzdWJzY3JpYmVyIGxlYXZlcyxcIiBub3QgXCJtYXggaWRsZSB3aGlsZSBjb25uZWN0ZWQuXCIgVGhlIHN3ZWVwIGFsc28gdG91Y2goKWVzXG4vLyBlYWNoIHRpY2sgd2hpbGUgd2F0Y2hlZCwgc28gb25jZSB1bndhdGNoZWQgdGhlIGZsb29yIGNvdW50cyBmcm9tIHRoYXQgbGFzdFxuLy8gZGlzY29ubmVjdC5cbmZ1bmN0aW9uIHNob3VsZElkbGVDbG9zZShzdWJzY3JpYmVyQ291bnQ6IG51bWJlciwgaWRsZU1zOiBudW1iZXIsIHRpbWVvdXRNczogbnVtYmVyKTogYm9vbGVhbiB7XG4gIGlmIChzdWJzY3JpYmVyQ291bnQgPiAwKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBpZGxlTXMgPj0gdGltZW91dE1zO1xufVxuXG4vLyAjNzMvIzc0IOKAlCBob3cgbWFueSB0YXNrcyB0aGUgT04tRElTSyBzbmFwc2hvdCBob2xkcywgb3IgbnVsbCB3aGVuIHdlIGNhbm5vdFxuLy8gaG9uZXN0bHkgc2F5LiBBYnNlbnQsIHVucGFyc2VhYmxlLCBvciBhIG5vbi1hcnJheSBgdGFza3NgIGFsbCByZXR1cm4gbnVsbCBhbmRcbi8vIE5PVCB6ZXJvOiB6ZXJvIHdvdWxkIG1lYW4gXCJhIHNuYXBzaG90IGV4aXN0cyBhbmQgaG9sZHMgbm90aGluZ1wiLCB3aGljaCBtYWtlcyBhXG4vLyBmaXJzdC1ldmVyIHdyaXRlIGxvb2sgbGlrZSBhIHNocmluayBmcm9tIGFuIGVtcHR5IGJvYXJkLCBhbmQgbWFrZXMgYVxuLy8gaGFsZi13cml0dGVuIGZpbGUgcmVwb3J0IGV2ZXJ5IGxhdGVyIHdyaXRlIGFzIGRhdGEgbG9zcy4gbnVsbCBkZWNsaW5lcyB0b1xuLy8gYW5zd2VyLCBhbmQgdGhlIHByZWRpY2F0ZSBiZWxvdyB0cmVhdHMgZGVjbGluaW5nIGFzIFwiZG8gbm90IHJvdGF0ZVwiLlxuZnVuY3Rpb24gc25hcHNob3RUYXNrQ291bnQocGF0aDogc3RyaW5nKTogbnVtYmVyIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSBhcyB7IHRhc2tzPzogdW5rbm93biB9O1xuICAgIHJldHVybiBBcnJheS5pc0FycmF5KHBhcnNlZC50YXNrcykgPyBwYXJzZWQudGFza3MubGVuZ3RoIDogbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gIzczLyM3NCDigJQgc2hvdWxkIHRoaXMgc25hcHNob3Qgd3JpdGUgY29weSB0aGUgZXhpc3RpbmcgZmlsZSBhc2lkZSBmaXJzdD9cbi8vIENsb2NrLWZyZWUgYW5kIGZzLWZyZWUgc28gaXQgaXMgdGVzdGFibGUgd2l0aG91dCBhIGRhZW1vbiAodGhlIHNob3VsZElkbGVDbG9zZVxuLy8gc2hhcGUpLlxuLy9cbi8vIOKblCBUSEUgUFJFRElDQVRFIElTIFNIUklOS0FHRSwgTk9UIEVNUFRJTkVTUy4gQm90aCBpc3N1ZXMgYXNrIGZvciBhIGd1YXJkXG4vLyBhZ2FpbnN0IHdyaXRpbmcgYW4gRU1QVFkgYm9hcmQgb3ZlciBhIHBvcHVsYXRlZCBzbmFwc2hvdC4gVGhhdCBkb2VzIG5vdCBjb3ZlclxuLy8gd2hhdCB3YXMgbWVhc3VyZWQ6IGEga2V5ZWQgcmVzcGF3biBvdmVyIGEgZGVhZCBib2FyZCBzdGFydHMgZW1wdHksIGFuZCB0aGVuXG4vLyBPTkUgYGFkZGAg4oCUIG5vIGBjbG9zZWAgYW55d2hlcmUg4oCUIGZsdXNoZWQgMyB0YXNrcyBkb3duIHRvIDEgdGhyb3VnaCB0aGVcbi8vIGRlYm91bmNlZCBwYXRoLiBBbiBlbXB0aW5lc3MgZ3VhcmQgcGVybWl0cyB0aGF0IHdyaXRlLCBiZWNhdXNlIDEgaXMgbm90IDAuXG4vLyBFbXB0aW5lc3MgaXMgdGhlIFdPUlNUIENBU0Ugb2YgdGhpcyBwcmVkaWNhdGUsIG5ldmVyIGEgc2VwYXJhdGUgYnJhbmNoLlxuLy9cbi8vIOKblCBBTkQgSVQgSVMgT05DRSBQRVIgREFFTU9OIFNFU1NJT04uIFdyaXRlcyBoYXBwZW4gcGVyIE1VVEFUSU9OLCBzbyBhIGh1bWFuXG4vLyBkcmFpbmluZyBhIGJvYXJkIGNhcmQtYnktY2FyZCBwcm9kdWNlcyBvbmUgc2hyaW5raW5nIHdyaXRlIGVhY2guIFJvdGF0aW5nXG4vLyBwZXItd3JpdGUgd2l0aCBhbnkgcmV0ZW50aW9uIGJvdW5kIE4gbWVhbnMgcm90YXRpb24gTisxIGV2aWN0cyB0aGUgcHJlLWRyYWluXG4vLyBzbmFwc2hvdCDigJQgdGhlIGd1YXJkIGVhdHMgd2hhdCBpdCBwcm90ZWN0cy4gUm90YXRpbmcgb24gdGhlIEZJUlNUIHNocmluayBzaW5jZVxuLy8gYm9vdCBjYXB0dXJlcyB0aGUgc3RhdGUgdGhhdCBleGlzdGVkIGJlZm9yZSB0aGlzIGRhZW1vbiB0b3VjaGVkIGFueXRoaW5nLFxuLy8gd2hpY2ggaXMgcHJlY2lzZWx5IHdoYXQgIzczIGFuZCAjNzQgd2FudGVkIGJhY2ssIGFuZCBpdCBuZWVkcyBubyByZXRlbnRpb25cbi8vIHBvbGljeSBhdCBhbGwuXG5mdW5jdGlvbiBzaG91bGRSb3RhdGVTbmFwc2hvdChcbiAgcHJpb3JUYXNrQ291bnQ6IG51bWJlciB8IG51bGwsXG4gIG5leHRUYXNrQ291bnQ6IG51bWJlcixcbiAgYWxyZWFkeVJvdGF0ZWRUaGlzU2Vzc2lvbjogYm9vbGVhbixcbik6IGJvb2xlYW4ge1xuICBpZiAoYWxyZWFkeVJvdGF0ZWRUaGlzU2Vzc2lvbikgcmV0dXJuIGZhbHNlO1xuICBpZiAocHJpb3JUYXNrQ291bnQgPT09IG51bGwpIHJldHVybiBmYWxzZTsgLy8gbm90aGluZyByZWFkYWJsZSB0byBwcm90ZWN0XG4gIHJldHVybiBuZXh0VGFza0NvdW50IDwgcHJpb3JUYXNrQ291bnQ7XG59XG5cbi8vIFN0YW1wIGEgc3RhdHVzIHRyYW5zaXRpb246IHRoZSBmaWVsZHMgdG8gbWVyZ2Ugb250byBhIHRhc2sgZW50ZXJpbmcgYHN0YXR1c2Bcbi8vIGF0IGBub3dgIOKAlCBlbnRlcmVkU3RhdHVzQXQgKyBhbiBhcHBlbmRlZCwgY2FwcGVkIHN0YXR1c0hpc3RvcnkuIFB1cmUgKG5vdyBpc1xuLy8gcGFzc2VkIGluKSBzbyB0aGUgc3Vic3RyYXRlIGlzIGRldGVybWluaXN0aWMgYW5kIHRoZSBkb3duc3RyZWFtIGZlYXR1cmVzXG4vLyAoaGVhcnRiZWF0LCBjYXJkLWFnaW5nLCBtZXRyaWNzLCBsZWFkZXJib2FyZCkgYWxsIHJlYWQgb25lIHNoYXBlLlxuZnVuY3Rpb24gdHJhbnNpdGlvblN0YW1wKFxuICBwcmV2OiBTdGF0dXNWaXNpdFtdIHwgdW5kZWZpbmVkLFxuICBzdGF0dXM6IFRhc2tTdGF0dXMsXG4gIG5vdzogbnVtYmVyLFxuKTogeyBlbnRlcmVkU3RhdHVzQXQ6IG51bWJlcjsgc3RhdHVzSGlzdG9yeTogU3RhdHVzVmlzaXRbXSB9IHtcbiAgY29uc3Qgc3RhdHVzSGlzdG9yeSA9IFsuLi4ocHJldiA/PyBbXSksIHsgc3RhdHVzLCBhdDogbm93IH1dLnNsaWNlKC1NQVhfU1RBVFVTX0hJU1RPUlkpO1xuICByZXR1cm4geyBlbnRlcmVkU3RhdHVzQXQ6IG5vdywgc3RhdHVzSGlzdG9yeSB9O1xufVxuXG4vLyBQMWYgYWRkcyBcInNpZ25hbFwiOiBhIGRhZW1vbiBraWxsZWQgYnkgU0lHVEVSTS9TSUdJTlQgbm93IHJ1bnMgdGhlIHRlYXJkb3duXG4vLyBhbmQgaXRzIGBjbG9zZWRgIGZyYW1lIHNheXMgc28uIEJvcnJvd2luZyBcImNsb3NlXCIgd291bGQgaGF2ZSBiZWVuIGFcbi8vIHN1Y2Nlc3Mtc2hhcGVkIGxpZSDigJQgYSBjb25zdW1lciBjYW5ub3QgdGVsbCBhbiBvcmRlcmx5IHNodXRkb3duIGZyb20gYSBraWxsLlxudHlwZSBDbG9zZVJlYXNvbiA9IFwidXNlclwiIHwgXCJ0aW1lb3V0XCIgfCBcImNsb3NlXCIgfCBcInNpZ25hbFwiO1xudHlwZSBEb25lUmVzdWx0ID0geyBjb2RlOiBudW1iZXI7IHJlYXNvbjogQ2xvc2VSZWFzb24gfTtcblxuLy8gYGFzYCBpcyB0aGUgY2FsbGVyJ3MgLS1hcyBpZGVudGl0eSAoc3RhbXBlZCBvbnRvIHRoZSBldmVudCBgYnlgKTsgY29vcGVyYXRpdmVcbi8vIGF0dHJpYnV0aW9uLCBuZXZlciBhbiBhdXRoIGJvdW5kYXJ5LiBgY2xhaW1gIG1hcmtzIGEgY29vcGVyYXRpdmUgc2VsZi1jbGFpbVxuLy8gKHRhc2sudXBkYXRlKSB0aGF0IG11c3Qgbm90IHN0ZWFsIGFuIGFscmVhZHktb3duZWQgdGFzay5cbnR5cGUgQWdlbnRNc2cgPVxuICB8IHsgdHlwZTogXCJpbml0XCI7IHRpdGxlPzogc3RyaW5nOyB0YXNrcz86IFRhc2tbXTsgYXM/OiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJ0YXNrLmFkZFwiOyB0YXNrOiBUYXNrOyBhcz86IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcInRhc2sudXBkYXRlXCI7IGlkOiBzdHJpbmc7IHBhdGNoOiBQYXJ0aWFsPFRhc2s+OyBhcz86IHN0cmluZzsgY2xhaW0/OiBib29sZWFuIH1cbiAgfCB7IHR5cGU6IFwidGFzay5yZW1vdmVcIjsgaWQ6IHN0cmluZzsgYXM/OiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJ0YXNrLmJsb2NrXCI7IGlkOiBzdHJpbmc7IG9uOiBzdHJpbmdbXTsgYXM/OiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJ0YXNrLnVuYmxvY2tcIjsgaWQ6IHN0cmluZzsgb246IHN0cmluZ1tdOyBhcz86IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcIm1lc3NhZ2VcIjsgdGV4dDogc3RyaW5nOyBhcz86IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcImNsb3NlXCI7IGFzPzogc3RyaW5nIH07XG5cbi8vIFRoZSAvY21kIHJlc3BvbnNlIOKAlCBgYXBwbGllZGAgbGV0cyB0aGUgQ0xJIGNvbmZpcm0gYSB3cml0ZSBhY3R1YWxseSB0b29rIChhXG4vLyByZWplY3RlZCBjb29wZXJhdGl2ZSBjbGFpbSByZXR1cm5zIGFwcGxpZWQ6ZmFsc2UgKyBhIHJlYXNvbikuXG50eXBlIEFwcGx5UmVzdWx0ID0geyBvazogdHJ1ZTsgYXBwbGllZD86IGJvb2xlYW47IGVycm9yPzogc3RyaW5nIH07XG5cbnR5cGUgQnJvd3Nlck1zZyA9XG4gIHwgeyB0eXBlOiBcInRhc2sudG9nZ2xlXCI7IGlkOiBzdHJpbmc7IHN0YXR1czogVGFza1N0YXR1cyB9XG4gIHwgeyB0eXBlOiBcInRhc2subW92ZVwiOyBpZDogc3RyaW5nOyBzdGF0dXM6IFRhc2tTdGF0dXM7IGluZGV4OiBudW1iZXIgfVxuICB8IHsgdHlwZTogXCJ0YXNrLmVkaXRcIjsgaWQ6IHN0cmluZzsgdGl0bGU/OiBzdHJpbmc7IG5vdGVzPzogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwidGFzay5hZGRcIjsgdGFzazogVGFzayB9XG4gIHwgeyB0eXBlOiBcInRhc2sucmVtb3ZlXCI7IGlkOiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJjbG9zZVwiIH07IC8vIHRoZSBodW1hbiBkaXNtaXNzZXMgdGhlIGJvYXJkIChcIkNsb3NlIGJvYXJkXCIpXG5cbmNvbnN0IFBPUlRfU1VGRklYX1JFID0gLy1wKFxcZHsyLDV9KSQvO1xuY29uc3QgVkFMSURfU1RBVFVTOiBUYXNrU3RhdHVzW10gPSBbXCJ0b2RvXCIsIFwiZG9pbmdcIiwgXCJyZXZpZXdcIiwgXCJkb25lXCJdO1xuXG5mdW5jdGlvbiBwYXJzZVBvcnRGcm9tU2Vzc2lvbklkKHNpZDogc3RyaW5nKTogbnVtYmVyIHwgbnVsbCB7XG4gIGNvbnN0IG0gPSBzaWQ/Lm1hdGNoKFBPUlRfU1VGRklYX1JFKTtcbiAgaWYgKCFtKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcG9ydCA9IHBhcnNlSW50KG1bMV0sIDEwKTtcbiAgcmV0dXJuIHBvcnQgPj0gMSAmJiBwb3J0IDw9IDY1NTM1ID8gcG9ydCA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIGh0bWxFc2NhcGUoczogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHNcbiAgICAucmVwbGFjZSgvJi9nLCBcIiZhbXA7XCIpXG4gICAgLnJlcGxhY2UoLzwvZywgXCImbHQ7XCIpXG4gICAgLnJlcGxhY2UoLz4vZywgXCImZ3Q7XCIpXG4gICAgLnJlcGxhY2UoL1wiL2csIFwiJnF1b3Q7XCIpXG4gICAgLnJlcGxhY2UoLycvZywgXCImI3gyNztcIik7XG59XG5cbmZ1bmN0aW9uIHJhbmRIZXgoYnl0ZXM6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IGJ1ZiA9IG5ldyBVaW50OEFycmF5KGJ5dGVzKTtcbiAgY3J5cHRvLmdldFJhbmRvbVZhbHVlcyhidWYpO1xuICByZXR1cm4gQXJyYXkuZnJvbShidWYsIChiKSA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpLmpvaW4oXCJcIik7XG59XG5cbmZ1bmN0aW9uIG9wZW5Ccm93c2VyKHVybDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGNtZCA9XG4gICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIlxuICAgICAgPyBbXCJvcGVuXCIsIHVybF1cbiAgICAgIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiXG4gICAgICAgID8gW1wiY21kXCIsIFwiL2NcIiwgXCJzdGFydFwiLCBcIlwiLCB1cmxdXG4gICAgICAgIDogW1wieGRnLW9wZW5cIiwgdXJsXTtcbiAgdHJ5IHtcbiAgICBCdW4uc3Bhd24oeyBjbWQsIHN0ZG91dDogXCJpZ25vcmVcIiwgc3RkZXJyOiBcImlnbm9yZVwiIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvKiBiZXN0LWVmZm9ydCAqL1xuICB9XG59XG5cbmNvbnN0IE1JTUVfQllfRVhUOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcIi5odG1sXCI6IFwidGV4dC9odG1sOyBjaGFyc2V0PXV0Zi04XCIsXG4gIFwiLmNzc1wiOiBcInRleHQvY3NzOyBjaGFyc2V0PXV0Zi04XCIsXG4gIFwiLmpzXCI6IFwiYXBwbGljYXRpb24vamF2YXNjcmlwdDsgY2hhcnNldD11dGYtOFwiLFxuICBcIi5qc29uXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbiAgXCIuanBnXCI6IFwiaW1hZ2UvanBlZ1wiLFxuICBcIi5qcGVnXCI6IFwiaW1hZ2UvanBlZ1wiLFxuICBcIi5naWZcIjogXCJpbWFnZS9naWZcIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxuICBcIi53ZWJwXCI6IFwiaW1hZ2Uvd2VicFwiLFxuICBcIi5pY29cIjogXCJpbWFnZS94LWljb25cIixcbiAgXCIud29mZlwiOiBcImZvbnQvd29mZlwiLFxuICBcIi53b2ZmMlwiOiBcImZvbnQvd29mZjJcIixcbn07XG5mdW5jdGlvbiBndWVzc01pbWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZG90ID0gbmFtZS5sYXN0SW5kZXhPZihcIi5cIik7XG4gIGNvbnN0IGV4dCA9IGRvdCA+PSAwID8gbmFtZS5zbGljZShkb3QpLnRvTG93ZXJDYXNlKCkgOiBcIlwiO1xuICByZXR1cm4gTUlNRV9CWV9FWFRbZXh0XSB8fCBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiO1xufVxuXG4vLyBOYXJyb3cgYW4gdW50cnVzdGVkIHZhbHVlIGludG8gYSB2YWxpZCBUYXNrLCBvciBudWxsIGlmIGl0IGRvZXNuJ3QgcXVhbGlmeTpcbi8vIHJlcXVpcmVkIHN0cmluZyBpZCArIHRpdGxlLCBhIHZhbGlkIHN0YXR1cywgb3B0aW9uYWwgc3RyaW5nIG5vdGVzLiBUaGlzIGlzXG4vLyB0aGUgc2luZ2xlIHRhc2stc2hhcGUgdHJ1c3QgYm91bmRhcnkg4oCUIHRoZSBicm93c2VyIFdTIHBhdGgsIHRoZSBhZ2VudCAvY21kXG4vLyBwYXRoIChpbml0ICsgdGFzay5hZGQpLCBhbmQgc25hcHNob3QgcmVzdG9yZSBhbGwgcnVuIGNhbmRpZGF0ZXMgdGhyb3VnaCBpdCBzb1xuLy8gYSBtYWxmb3JtZWQgdGFzayBjYW4ndCBlbnRlciBjYW5vbmljYWwgc3RhdGUuIFBlci10YXNrIChjYWxsZXJzIGZpbHRlci1hbmQtXG4vLyBrZWVwLXZhbGlkIG9yIHJlamVjdCBhIHNpbmdsZSB0YXNrKSwgbmV2ZXIgYWxsLW9yLW5vdGhpbmcuXG4vLyBTYW5pdGl6ZSBhbiB1bnRydXN0ZWQgdGFncyB2YWx1ZSBpbnRvIGEgY2xlYW4gc3RyaW5nW106IHN0cmluZ3Mgb25seSwgZWFjaFxuLy8gdHJpbW1lZCwgZW1wdGllcyBkcm9wcGVkLCBkZWR1cGVkIGV4YWN0bHkgKGNhc2UgcHJlc2VydmVkIGZvciBkaXNwbGF5IOKAlCBhXG4vLyBsYXRlciBmaWx0ZXIgY29tcGFyZXMgY2FzZS1pbnNlbnNpdGl2ZWx5LCBzYW1lIGFzIG93bmVyLWNhc2UpLiBBIG5vbi1hcnJheVxuLy8geWllbGRzIFtdLiBDYWxsZXJzIGRlY2lkZSB3aGV0aGVyIHRvIG9taXQgYW4gZW1wdHkgcmVzdWx0LlxuZnVuY3Rpb24gY2xlYW5UYWdzKHZhbHVlOiB1bmtub3duKTogc3RyaW5nW10ge1xuICBpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm4gW107XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCB4IG9mIHZhbHVlKSB7XG4gICAgaWYgKHR5cGVvZiB4ICE9PSBcInN0cmluZ1wiKSBjb250aW51ZTtcbiAgICBjb25zdCB0ID0geC50cmltKCk7XG4gICAgaWYgKHQgJiYgIW91dC5pbmNsdWRlcyh0KSkgb3V0LnB1c2godCk7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLy8gYjgg4oCUIFdIWSBhIHRhc2sgaXMgcmVqZWN0ZWQsIGFzIHRoZSBTSU5HTEUgc291cmNlIG9mIHRoZSBydWxlcy5cbi8vXG4vLyBgaW5pdCAtLXN0ZGluLXRhc2tzYCBmaWx0ZXJzLWFuZC1rZWVwcy12YWxpZCBhbmQgcmVwb3J0ZWQgbm90aGluZzogMThcbi8vIHdlbGwtZm9ybWVkLUxPT0tJTkcgdGFza3Mgd2VyZSBwb3N0ZWQgYXQgY29udmVuZSwgZXZlcnkgb25lIHdhcyBkcm9wcGVkIGZvciBhXG4vLyBtaXNzaW5nIGNhbGxlci1zdXBwbGllZCBgaWRgLCBhbmQgdGhlIGVudmVsb3BlIGFuc3dlcmVkIHtvazp0cnVlLFxuLy8gYXBwbGllZDp0cnVlfSB3aXRoIGEgYm9hcmQgb2YgemVyby4gVGhlIGFzeW1tZXRyeSBpcyBpbnZpc2libGUgZnJvbSB0aGVcbi8vIG91dHNpZGUgYmVjYXVzZSBgYWRkYCBNSU5UUyBhbiBpZCBmb3IgeW91IGFuZCBgaW5pdGAgZG9lcyBub3QsIHdoaWxlIHRoZSBoZWxwXG4vLyBzYWlkIG9ubHkgXCJ0YXNrcyA9IEpTT04gYXJyYXkgb24gc3RkaW5cIi5cbi8vXG4vLyBUaGUgcmVhc29uIGxpdmVzIEhFUkUgcmF0aGVyIHRoYW4gYmVpbmcgcmUtZGVyaXZlZCBhdCB0aGUgY2FsbCBzaXRlOiBhIHNlY29uZFxuLy8gY29weSBvZiB0aGVzZSBjb25kaXRpb25zIGlzIHRoZSBtaXJyb3ItZHJpZnQgdHJhcCB0aGlzIHJlcG8gaGFzIHNoaXBwZWQgdHdpY2Vcbi8vICh0aGUgYm91bnR5IHN1cmZhY2UgbWlycm9yLCBhbmQgYHByb3Bvc2Utbm9kZSAtLXN0ZGluYCBkcm9wcGluZyB0YWdzKS4gT25lXG4vLyBsaXN0LCB0d28gcmVhZGVycy5cbmZ1bmN0aW9uIHRhc2tSZWplY3Rpb24odDogdW5rbm93bik6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIXQgfHwgdHlwZW9mIHQgIT09IFwib2JqZWN0XCIpIHJldHVybiBcIm5vdCBhIEpTT04gb2JqZWN0XCI7XG4gIGNvbnN0IGNhbmQgPSB0IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBpZiAodHlwZW9mIGNhbmQuaWQgIT09IFwic3RyaW5nXCIpXG4gICAgcmV0dXJuIFwibWlzc2luZyBgaWRgIChzdHJpbmcsIFJFUVVJUkVEIOKAlCBpbml0IGRvZXMgbm90IG1pbnQgaWRzOyBgYWRkYCBkb2VzKVwiO1xuICBpZiAodHlwZW9mIGNhbmQudGl0bGUgIT09IFwic3RyaW5nXCIpIHJldHVybiBcIm1pc3NpbmcgYHRpdGxlYCAoc3RyaW5nLCByZXF1aXJlZClcIjtcbiAgaWYgKHR5cGVvZiBjYW5kLnN0YXR1cyAhPT0gXCJzdHJpbmdcIiB8fCAhVkFMSURfU1RBVFVTLmluY2x1ZGVzKGNhbmQuc3RhdHVzIGFzIFRhc2tTdGF0dXMpKVxuICAgIHJldHVybiBgaW52YWxpZCBcXGBzdGF0dXNcXGAgKHJlcXVpcmVkLCBvbmUgb2YgJHtWQUxJRF9TVEFUVVMuam9pbihcIiB8IFwiKX0pYDtcbiAgaWYgKGNhbmQubm90ZXMgIT09IHVuZGVmaW5lZCAmJiB0eXBlb2YgY2FuZC5ub3RlcyAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIFwiYG5vdGVzYCBtdXN0IGJlIGEgc3RyaW5nXCI7XG4gIGlmIChjYW5kLm93bmVyICE9PSB1bmRlZmluZWQgJiYgdHlwZW9mIGNhbmQub3duZXIgIT09IFwic3RyaW5nXCIpIHJldHVybiBcImBvd25lcmAgbXVzdCBiZSBhIHN0cmluZ1wiO1xuICBpZiAoXG4gICAgY2FuZC5ibG9ja2VkQnkgIT09IHVuZGVmaW5lZCAmJlxuICAgICghQXJyYXkuaXNBcnJheShjYW5kLmJsb2NrZWRCeSkgfHwgY2FuZC5ibG9ja2VkQnkuc29tZSgoeCkgPT4gdHlwZW9mIHggIT09IFwic3RyaW5nXCIpKVxuICApXG4gICAgcmV0dXJuIFwiYGJsb2NrZWRCeWAgbXVzdCBiZSBhbiBhcnJheSBvZiBzdHJpbmdzXCI7XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVRhc2sodDogdW5rbm93bik6IFRhc2sgfCBudWxsIHtcbiAgaWYgKHRhc2tSZWplY3Rpb24odCkgIT09IG51bGwpIHJldHVybiBudWxsO1xuICBjb25zdCBjYW5kID0gdCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgY29uc3QgdGFncyA9IGNsZWFuVGFncyhjYW5kLnRhZ3MpO1xuICAvLyBUcmFuc2l0aW9uIHN1YnN0cmF0ZSBpcyBzZXJ2ZXItZ2VuZXJhdGVkOyBvbiByZXN0b3JlIHdlIHByZXNlcnZlIGl0XG4gIC8vIGxlbmllbnRseSDigJQgZHJvcCBhIG1hbGZvcm1lZCB2YWx1ZSByYXRoZXIgdGhhbiByZWplY3QgdGhlIHdob2xlIHRhc2ssIHNvIGFcbiAgLy8gbGVnYWN5IHNuYXBzaG90IHN0aWxsIGxvYWRzLlxuICBjb25zdCBlbnRlcmVkU3RhdHVzQXQgPVxuICAgIHR5cGVvZiBjYW5kLmVudGVyZWRTdGF0dXNBdCA9PT0gXCJudW1iZXJcIiA/IGNhbmQuZW50ZXJlZFN0YXR1c0F0IDogdW5kZWZpbmVkO1xuICBjb25zdCBzdGF0dXNIaXN0b3J5ID0gQXJyYXkuaXNBcnJheShjYW5kLnN0YXR1c0hpc3RvcnkpXG4gICAgPyAoY2FuZC5zdGF0dXNIaXN0b3J5LmZpbHRlcihcbiAgICAgICAgKGgpOiBoIGlzIFN0YXR1c1Zpc2l0ID0+XG4gICAgICAgICAgISFoICYmXG4gICAgICAgICAgdHlwZW9mIGggPT09IFwib2JqZWN0XCIgJiZcbiAgICAgICAgICBWQUxJRF9TVEFUVVMuaW5jbHVkZXMoKGggYXMgU3RhdHVzVmlzaXQpLnN0YXR1cykgJiZcbiAgICAgICAgICB0eXBlb2YgKGggYXMgU3RhdHVzVmlzaXQpLmF0ID09PSBcIm51bWJlclwiLFxuICAgICAgKSBhcyBTdGF0dXNWaXNpdFtdKVxuICAgIDogdW5kZWZpbmVkO1xuICAvLyBIZWFydGJlYXQgc2l6aW5nIOKAlCBsZW5pZW50OiBkcm9wIGEgYmFkIHNpemUvZXhwZWN0LCBrZWVwIHRoZSB0YXNrLlxuICBjb25zdCBzaXplID1cbiAgICB0eXBlb2YgY2FuZC5zaXplID09PSBcInN0cmluZ1wiICYmIGNhbmQuc2l6ZSBpbiBTSVpFX01JTlVURVNcbiAgICAgID8gKGNhbmQuc2l6ZSBhcyBUYXNrU2l6ZSlcbiAgICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCBleHBlY3QgPSB0eXBlb2YgY2FuZC5leHBlY3QgPT09IFwibnVtYmVyXCIgJiYgY2FuZC5leHBlY3QgPiAwID8gY2FuZC5leHBlY3QgOiB1bmRlZmluZWQ7XG4gIHJldHVybiB7XG4gICAgaWQ6IGNhbmQuaWQsXG4gICAgdGl0bGU6IGNhbmQudGl0bGUsXG4gICAgc3RhdHVzOiBjYW5kLnN0YXR1cyBhcyBUYXNrU3RhdHVzLFxuICAgIC4uLihjYW5kLm5vdGVzICE9PSB1bmRlZmluZWQgPyB7IG5vdGVzOiBjYW5kLm5vdGVzIGFzIHN0cmluZyB9IDoge30pLFxuICAgIC4uLihjYW5kLm93bmVyICE9PSB1bmRlZmluZWQgPyB7IG93bmVyOiBjYW5kLm93bmVyIGFzIHN0cmluZyB9IDoge30pLFxuICAgIC4uLihjYW5kLmJsb2NrZWRCeSAhPT0gdW5kZWZpbmVkID8geyBibG9ja2VkQnk6IGNhbmQuYmxvY2tlZEJ5IGFzIHN0cmluZ1tdIH0gOiB7fSksXG4gICAgLi4uKHRhZ3MubGVuZ3RoID8geyB0YWdzIH0gOiB7fSksXG4gICAgLi4uKGVudGVyZWRTdGF0dXNBdCAhPT0gdW5kZWZpbmVkID8geyBlbnRlcmVkU3RhdHVzQXQgfSA6IHt9KSxcbiAgICAuLi4oc3RhdHVzSGlzdG9yeT8ubGVuZ3RoID8geyBzdGF0dXNIaXN0b3J5IH0gOiB7fSksXG4gICAgLi4uKHNpemUgIT09IHVuZGVmaW5lZCA/IHsgc2l6ZSB9IDoge30pLFxuICAgIC4uLihleHBlY3QgIT09IHVuZGVmaW5lZCA/IHsgZXhwZWN0IH0gOiB7fSksXG4gIH07XG59XG5cbi8vIFN0YXRlIG11dGF0aW9uIGhlbHBlcnMuIEFsbCBrZWVwIGBzdGF0ZS50YXNrc2AgaW4gcGxhY2UgKHJlcGxhY2UgYnkgaWQpXG4vLyBzbyB0aGUgYWdlbnQgYW5kIGJyb3dzZXIgc2VlIGNvbnNpc3RlbnQgb3JkZXJpbmcuXG5mdW5jdGlvbiBhcHBseVRhc2tBZGQoc3RhdGU6IEJvYXJkU3RhdGUsIHRhc2s6IFRhc2ssIG5vdzogbnVtYmVyID0gRGF0ZS5ub3coKSk6IGJvb2xlYW4ge1xuICBpZiAoc3RhdGUudGFza3Muc29tZSgodCkgPT4gdC5pZCA9PT0gdGFzay5pZCkpIHJldHVybiBmYWxzZTtcbiAgLy8gU3RhbXAgdGhlIGluaXRpYWwgc3RhdHVzIGVudHJ5IOKAlCB1bmxlc3MgdGhlIHRhc2sgYWxyZWFkeSBjYXJyaWVzIGl0cyBvd25cbiAgLy8gKGEgcmVzdG9yZS9pbml0IHRoYXQgcHJlc2VydmVkIHRoZSB0cmFuc2l0aW9uIGxvZykuXG4gIGNvbnN0IHN0YW1wZWQgPVxuICAgIHRhc2suZW50ZXJlZFN0YXR1c0F0ID09PSB1bmRlZmluZWRcbiAgICAgID8geyAuLi50YXNrLCAuLi50cmFuc2l0aW9uU3RhbXAodGFzay5zdGF0dXNIaXN0b3J5LCB0YXNrLnN0YXR1cywgbm93KSB9XG4gICAgICA6IHRhc2s7XG4gIHN0YXRlLnRhc2tzLnB1c2goc3RhbXBlZCk7XG4gIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiBhcHBseVRhc2tVcGRhdGUoXG4gIHN0YXRlOiBCb2FyZFN0YXRlLFxuICBpZDogc3RyaW5nLFxuICBwYXRjaDogUGFydGlhbDxUYXNrPixcbiAgbm93OiBudW1iZXIgPSBEYXRlLm5vdygpLFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGlkeCA9IHN0YXRlLnRhc2tzLmZpbmRJbmRleCgodCkgPT4gdC5pZCA9PT0gaWQpO1xuICBpZiAoaWR4ID09PSAtMSkgcmV0dXJuIGZhbHNlO1xuICAvLyBTdGF0dXMgZ3VhcmQ6IGRyb3AgaW52YWxpZCBzdGF0dXMgdmFsdWVzIHF1aWV0bHkgc28gYSBtYWxmb3JtZWQgYWdlbnRcbiAgLy8gbWVzc2FnZSBjYW4ndCBjb3JydXB0IHRoZSBib2FyZC5cbiAgaWYgKHBhdGNoLnN0YXR1cyAmJiAhVkFMSURfU1RBVFVTLmluY2x1ZGVzKHBhdGNoLnN0YXR1cykpIHtcbiAgICBjb25zdCB7IHN0YXR1czogX2Ryb3AsIC4uLnJlc3QgfSA9IHBhdGNoO1xuICAgIHBhdGNoID0gcmVzdDtcbiAgfVxuICBjb25zdCBwcmV2ID0gc3RhdGUudGFza3NbaWR4XTtcbiAgY29uc3QgbWVyZ2VkOiBUYXNrID0geyAuLi5wcmV2LCAuLi5wYXRjaCB9O1xuICAvLyBTdGFtcCBvbmx5IG9uIGFuIGFjdHVhbCBzdGF0dXMgQ0hBTkdFIChhIHRyYW5zaXRpb24pIOKAlCBub3QgYSBub3Rlcy90aXRsZVxuICAvLyBwYXRjaCwgYW5kIG5vdCBhIHNhbWUtc3RhdHVzIHBhdGNoIChhIGd1YXJkZWQgZG9pbmctPmRvaW5nIG5ldmVyIHJlYWNoZXNcbiAgLy8gaGVyZSwgYnV0IGEgZGlyZWN0IGNhbGwgbXVzdCBub3QgcmVzZXQgdGhlIGNsb2NrIGVpdGhlcikuXG4gIGlmIChwYXRjaC5zdGF0dXMgIT09IHVuZGVmaW5lZCAmJiBwYXRjaC5zdGF0dXMgIT09IHByZXYuc3RhdHVzKSB7XG4gICAgT2JqZWN0LmFzc2lnbihtZXJnZWQsIHRyYW5zaXRpb25TdGFtcChwcmV2LnN0YXR1c0hpc3RvcnksIHBhdGNoLnN0YXR1cywgbm93KSk7XG4gIH1cbiAgc3RhdGUudGFza3NbaWR4XSA9IG1lcmdlZDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIGFwcGx5VGFza1JlbW92ZShzdGF0ZTogQm9hcmRTdGF0ZSwgaWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBpZHggPSBzdGF0ZS50YXNrcy5maW5kSW5kZXgoKHQpID0+IHQuaWQgPT09IGlkKTtcbiAgaWYgKGlkeCA9PT0gLTEpIHJldHVybiBmYWxzZTtcbiAgc3RhdGUudGFza3Muc3BsaWNlKGlkeCwgMSk7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyBNb3ZlIGEgdGFzayB0byAoc3RhdHVzLCBpbmRleCkg4oCUIHdoZXJlIGBpbmRleGAgaXMgaXRzIHBvc2l0aW9uIGFtb25nIHRoZVxuLy8gdGFza3Mgb2YgdGhhdCBzdGF0dXMuIFJldHVybnMgdGhlIGNhbm9uaWNhbCBhYnNvbHV0ZSBpbmRleCBpbiBzdGF0ZS50YXNrc1xuLy8gYWZ0ZXIgdGhlIG1vdmUsIG9yIC0xIGlmIHRoZSB0YXNrIHdhc24ndCBmb3VuZC4gU3RhdHVzIHZhbGlkYXRpb24gaXMgdGhlXG4vLyBjYWxsZXIncyBqb2IgKHdlIGFscmVhZHkgc2NyZWVuIGluIHRoZSBXUyBoYW5kbGVyKS5cbmZ1bmN0aW9uIGFwcGx5VGFza01vdmUoXG4gIHN0YXRlOiBCb2FyZFN0YXRlLFxuICBpZDogc3RyaW5nLFxuICBzdGF0dXM6IFRhc2tTdGF0dXMsXG4gIGluZGV4OiBudW1iZXIsXG4gIG5vdzogbnVtYmVyID0gRGF0ZS5ub3coKSxcbik6IG51bWJlciB7XG4gIGNvbnN0IGZyb21JZHggPSBzdGF0ZS50YXNrcy5maW5kSW5kZXgoKHQpID0+IHQuaWQgPT09IGlkKTtcbiAgaWYgKGZyb21JZHggPT09IC0xKSByZXR1cm4gLTE7XG4gIGNvbnN0IFt0YXNrXSA9IHN0YXRlLnRhc2tzLnNwbGljZShmcm9tSWR4LCAxKTtcbiAgLy8gQSBjcm9zcy1jb2x1bW4gbW92ZSBpcyBhIHRyYW5zaXRpb247IGFuIGludHJhLWNvbHVtbiByZW9yZGVyIGlzIG5vdC5cbiAgaWYgKHRhc2suc3RhdHVzICE9PSBzdGF0dXMpIHtcbiAgICBPYmplY3QuYXNzaWduKHRhc2ssIHsgc3RhdHVzIH0sIHRyYW5zaXRpb25TdGFtcCh0YXNrLnN0YXR1c0hpc3RvcnksIHN0YXR1cywgbm93KSk7XG4gIH1cbiAgLy8gVHJhbnNsYXRlIHRoZSBjb2x1bW4tbG9jYWwgaW5kZXggaW50byBhbiBhYnNvbHV0ZSBpbmRleCBpbiBzdGF0ZS50YXNrczpcbiAgLy8gd2FsayB0aHJvdWdoIHN0YXRlLnRhc2tzIGFuZCBjb3VudCB0YXNrcyBvZiB0aGUgdGFyZ2V0IHN0YXR1cyB1bnRpbCB3ZVxuICAvLyBoaXQgYGluZGV4YCBzbG90cy4gSWYgYGluZGV4YCBleGNlZWRzIHRoZSBjb2x1bW4gY291bnQsIGFwcGVuZC5cbiAgY29uc3QgY2xhbXBlZCA9IE1hdGgubWF4KDAsIE1hdGguZmxvb3IoaW5kZXgpKTtcbiAgbGV0IHNlZW4gPSAwO1xuICBsZXQgaW5zZXJ0QXQgPSBzdGF0ZS50YXNrcy5sZW5ndGg7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgc3RhdGUudGFza3MubGVuZ3RoOyBpKyspIHtcbiAgICBpZiAoc3RhdGUudGFza3NbaV0uc3RhdHVzICE9PSBzdGF0dXMpIGNvbnRpbnVlO1xuICAgIGlmIChzZWVuID09PSBjbGFtcGVkKSB7XG4gICAgICBpbnNlcnRBdCA9IGk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgc2VlbisrO1xuICB9XG4gIHN0YXRlLnRhc2tzLnNwbGljZShpbnNlcnRBdCwgMCwgdGFzayk7XG4gIHJldHVybiBpbnNlcnRBdDtcbn1cblxuLy8gTm8tb3AgZ3VhcmRzICgjMjMpLiBBIHJlZHVuZGFudCBwYXRjaCAoZG9pbmctPmRvaW5nKSBvciBhIGRyYWcgZHJvcHBlZCBiYWNrIG9uXG4vLyB0aGUgY2FyZCdzIG93biBzbG90IHN0aWxsIHJhbiB0aGUgYXBwbHkgKyBicm9hZGNhc3QgKyBlbWl0RXZlbnQsIHNwdXJpb3VzbHlcbi8vIHdha2luZyBldmVyeSBzY29wZWQgdGFpbC4gVGhlc2UgcHJlZGljYXRlcyBsZXQgdGhlIGNhbGxlciBza2lwIHRoZSBicm9hZGNhc3Rcbi8vICsgZXZlbnQgd2hlbiBcInRoZSByZXN1bHRpbmcgc3RhdGUgZXF1YWxzIGN1cnJlbnRcIiDigJQgY2hlY2tlZCBhZ2FpbnN0IHRoZSBTQU1FXG4vLyBsb2dpYyB0aGUgYXBwbHkgaGVscGVycyB1c2UsIHNvIHRoZSB0d28gY2FuJ3QgZHJpZnQuXG5cbi8vIFRydWUgd2hlbiBhcHBseWluZyBgcGF0Y2hgIHRvIHRhc2sgYGlkYCB3b3VsZCBjaGFuZ2Ugbm90aGluZy4gTWlycm9yc1xuLy8gYXBwbHlUYXNrVXBkYXRlJ3MgaW52YWxpZC1zdGF0dXMgc3RyaXAgc28gYSBib2d1cyBzdGF0dXMtb25seSBwYXRjaCAod2hpY2ggdGhlXG4vLyBhcHBseSBwYXRoIGRyb3BzKSByZWFkcyBhcyB0aGUgbm8tb3AgaXQgZWZmZWN0aXZlbHkgaXMuIE1pc3NpbmcgaWQgaXMgTk9UIGFcbi8vIG5vLW9wIOKAlCBpdCdzIFwibm90IGZvdW5kXCIsIHdoaWNoIHRoZSBhcHBseSBwYXRoIHJlcG9ydHMgYXMgYXBwbGllZDpmYWxzZS5cbmZ1bmN0aW9uIGlzTm9PcFVwZGF0ZShzdGF0ZTogQm9hcmRTdGF0ZSwgaWQ6IHN0cmluZywgcGF0Y2g6IFBhcnRpYWw8VGFzaz4pOiBib29sZWFuIHtcbiAgY29uc3QgdGFzayA9IHN0YXRlLnRhc2tzLmZpbmQoKHQpID0+IHQuaWQgPT09IGlkKTtcbiAgaWYgKCF0YXNrKSByZXR1cm4gZmFsc2U7XG4gIGxldCBlZmYgPSBwYXRjaDtcbiAgaWYgKGVmZi5zdGF0dXMgJiYgIVZBTElEX1NUQVRVUy5pbmNsdWRlcyhlZmYuc3RhdHVzKSkge1xuICAgIGNvbnN0IHsgc3RhdHVzOiBfZHJvcCwgLi4ucmVzdCB9ID0gZWZmO1xuICAgIGVmZiA9IHJlc3Q7XG4gIH1cbiAgcmV0dXJuIChPYmplY3Qua2V5cyhlZmYpIGFzIChrZXlvZiBUYXNrKVtdKS5ldmVyeSgoaykgPT4gdGFza1trXSA9PT0gZWZmW2tdKTtcbn1cblxuLy8gVHJ1ZSB3aGVuIG1vdmluZyB0YXNrIGBpZGAgdG8gKHN0YXR1cywgaW5kZXgpIHdvdWxkIGxlYXZlIHRoZSBib2FyZCdzXG4vLyBWSVNJQkxFIHN0YXRlIHVuY2hhbmdlZCDigJQgZXZlcnkgY29sdW1uJ3Mgb3JkZXJlZCBtZW1iZXJzaGlwIGlkZW50aWNhbC5cbi8vIFNpbXVsYXRlcyB0aGUgbW92ZSBvbiBhIGNsb25lIHZpYSB0aGUgcmVhbCBhcHBseVRhc2tNb3ZlIChpbmRleC10cmFuc2xhdGlvblxuLy8gc3RheXMgc2luZ2xlLXNvdXJjZWQpLCB0aGVuIGNvbXBhcmVzIENPTFVNTiB2aWV3cywgbm90IHJhdyBhcnJheSBvcmRlci5cbi8vIE1pc3NpbmcgaWQgaXMgTk9UIGEgbm8tb3Ag4oCUIHRoYXQncyBcIm5vdCBmb3VuZFwiLCBwZXIgdGhlIGFwcGx5IHBhdGguXG5mdW5jdGlvbiBpc05vT3BNb3ZlKHN0YXRlOiBCb2FyZFN0YXRlLCBpZDogc3RyaW5nLCBzdGF0dXM6IFRhc2tTdGF0dXMsIGluZGV4OiBudW1iZXIpOiBib29sZWFuIHtcbiAgaWYgKCFzdGF0ZS50YXNrcy5zb21lKCh0KSA9PiB0LmlkID09PSBpZCkpIHJldHVybiBmYWxzZTtcbiAgLy8gQ29tcGFyZSBDT0xVTU4gdmlld3MsIG5vdCByYXcgYXJyYXkgb3JkZXI6IHJlLWRyb3BwaW5nIHRoZSBMQVNUIGNhcmQgaW4gYVxuICAvLyBjb2x1bW4gb24gaXRzIG93biBzbG90IHJld3JpdGVzIHRoZSBhYnNvbHV0ZSBhcnJheSBidXQgbm90IHRoZSBjb2x1bW5zIOKAlFxuICAvLyBzdGlsbCBhIG5vLW9wIHRvIHRoZSB1c2VyLlxuICBjb25zdCBjb2x1bW5WaWV3ID0gKHM6IEJvYXJkU3RhdGUpID0+XG4gICAgVkFMSURfU1RBVFVTLm1hcCgoc3QpID0+XG4gICAgICBzLnRhc2tzXG4gICAgICAgIC5maWx0ZXIoKHQpID0+IHQuc3RhdHVzID09PSBzdClcbiAgICAgICAgLm1hcCgodCkgPT4gdC5pZClcbiAgICAgICAgLmpvaW4oXCIsXCIpLFxuICAgICkuam9pbihcInxcIik7XG4gIGNvbnN0IGJlZm9yZSA9IGNvbHVtblZpZXcoc3RhdGUpO1xuICBjb25zdCBwcm9iZTogQm9hcmRTdGF0ZSA9IHsgLi4uc3RhdGUsIHRhc2tzOiBzdGF0ZS50YXNrcy5tYXAoKHQpID0+ICh7IC4uLnQgfSkpIH07XG4gIGFwcGx5VGFza01vdmUocHJvYmUsIGlkLCBzdGF0dXMsIGluZGV4KTtcbiAgcmV0dXJuIGJlZm9yZSA9PT0gY29sdW1uVmlldyhwcm9iZSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgcGFyc2VkOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+O1xuICB0cnkge1xuICAgIHBhcnNlZCA9IHBhcnNlQXJncyh7XG4gICAgICBhcmdzOiBhcmd2LFxuICAgICAgb3B0aW9uczoge1xuICAgICAgICB0aXRsZTogeyB0eXBlOiBcInN0cmluZ1wiLCBkZWZhdWx0OiBcIkJvdW50eSBCb2FyZFwiIH0sXG4gICAgICAgIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVmYXVsdDogXCI3MjAwXCIgfSxcbiAgICAgICAgXCJuby1vcGVuXCI6IHsgdHlwZTogXCJib29sZWFuXCIsIGRlZmF1bHQ6IGZhbHNlIH0sXG4gICAgICAgIHBvcnQ6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVmYXVsdDogXCIwXCIgfSxcbiAgICAgICAgaG9zdDogeyB0eXBlOiBcInN0cmluZ1wiLCBkZWZhdWx0OiBcIjEyNy4wLjAuMVwiIH0sXG4gICAgICAgIGlkOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgcmVzdG9yZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sIC8vIHNuYXBzaG90IGlkIG9yIHBhdGggdG8gcmVzdW1lIGZyb21cbiAgICAgIH0sXG4gICAgICBzdHJpY3Q6IHRydWUsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiBmYWxzZSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBlcnJvcjogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuYCk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3QgdiA9IHBhcnNlZC52YWx1ZXM7XG4gIGNvbnN0IHRpbWVvdXQgPSBwYXJzZUZsb2F0KHYudGltZW91dCBhcyBzdHJpbmcpO1xuICBsZXQgcG9ydCA9IHBhcnNlSW50KHYucG9ydCBhcyBzdHJpbmcsIDEwKTtcbiAgY29uc3QgaG9zdCA9IHYuaG9zdCBhcyBzdHJpbmc7XG4gIGxldCBzZXNzaW9uSWQgPSAodi5pZCBhcyBzdHJpbmcgfCB1bmRlZmluZWQpID8/IFwiXCI7XG4gIGlmIChwb3J0ID09PSAwICYmIHNlc3Npb25JZCkge1xuICAgIGNvbnN0IGVtYmVkZGVkID0gcGFyc2VQb3J0RnJvbVNlc3Npb25JZChzZXNzaW9uSWQpO1xuICAgIGlmIChlbWJlZGRlZCAhPT0gbnVsbCkgcG9ydCA9IGVtYmVkZGVkO1xuICB9XG5cbiAgLy8gRGlhZ25vc3RpY3MgKCM2NCk6IGFwcGVuZCBPTkUgc3RydWN0dXJlZCBKU09OIGxpbmUgcGVyIGxpZmVjeWNsZSBldmVudCB0b1xuICAvLyAkQk9VTlRZX0hPTUUvZGFlbW9uLmxvZy4gQ2xvc2VzIG92ZXIgYHNlc3Npb25JZGAgKHJlYWQgYXQgY2FsbCB0aW1lLCBzbyBhXG4gIC8vIHByZS1iaW5kIGNyYXNoIGxvZ3MgXCJcIiBhbmQgYSBwb3N0LWJpbmQgb25lIGxvZ3MgdGhlIHJlYWwgaWQpLiBUaGUgd2hvbGVcbiAgLy8gd3JpdGUgaXMgd3JhcHBlZCBzbyBsb2dnaW5nIGNhbiBORVZFUiB0aHJvdyBpbnNpZGUgdGhlIGRhZW1vbi4gRGF0ZS9uZXcgRGF0ZVxuICAvLyBpcyBmaW5lIGhlcmUg4oCUIHRoaXMgaXMgdGhlIGRhZW1vbiBwcm9jZXNzLCBub3QgYSB3b3JrZmxvdyBzY3JpcHQuXG4gIGNvbnN0IGxvZ0RhZW1vbiA9IChyZWFzb246IHN0cmluZywgZXh0cmE/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmMoQk9VTlRZX0hPTUUsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgY29uc3QgbGluZSA9IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgdHM6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgICAgICBwaWQ6IHByb2Nlc3MucGlkLFxuICAgICAgICByZWFzb24sXG4gICAgICAgIC4uLmV4dHJhLFxuICAgICAgfSk7XG4gICAgICBhcHBlbmRGaWxlU3luYyhEQUVNT05fTE9HLCBgJHtsaW5lfVxcbmApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogZGlhZ25vc3RpY3MgbXVzdCBuZXZlciBjcmFzaCBvciB0aHJvdyBpbiB0aGUgZGFlbW9uICovXG4gICAgfVxuICB9O1xuXG4gIC8vIFAxZiDigJQgc2lnbmFsIGRlYXRocyBub3cgcnVuIHRoZSBURUFSRE9XTiBpbnN0ZWFkIG9mIHByZS1lbXB0aW5nIGl0LlxuICAvL1xuICAvLyBUaGUgZGVmZWN0IHRoZXNlIGhhbmRsZXJzIHVzZWQgdG8gYmU6IGBwcm9jZXNzLmV4aXRgIGhlcmUgZmlyZXMgaW1tZWRpYXRlbHksXG4gIC8vIHNvIGBhd2FpdCBkb25lYCBiZWxvdyBORVZFUiByZXNvbHZlcyBhbmQgdGhlIGVudGlyZSB0ZWFyZG93biBibG9jayBpc1xuICAvLyB1bnJlYWNoYWJsZSDigJQgbm8gZmluYWwgc25hcHNob3QsIG5vIGBjbG9zZWRgIGZyYW1lLCBubyBkaXNjb3ZlcnkgY2xlYW51cC5cbiAgLy8gVGhhdCBPTkUgZmFjdCBpcyBQMWYncyBkZWZlY3QgKDE1NiBvZiAyMjYgcmVjb3JkZWQgZGVhdGhzIGVtaXR0ZWQgbm8gYGNsb3NlZGBcbiAgLy8gZnJhbWUpIGFuZCBhIHBhaXIgb2YgUDBmIGV4aXQgc2l0ZXMgYXQgb25jZS5cbiAgLy9cbiAgLy8g4puUIFRIRSBIQVpBUkQsIEFORCBXSFkgVEhJUyBJUyBOT1QgVEhFIGBqb2luLnRzYCBTQ0FSLiBgcHJvY2Vzcy5leGl0YCBpbiBhXG4gIC8vIHNpZ25hbCBoYW5kbGVyIGRvZXMgRE9VQkxFIERVVFk6IGl0IHJ1bnMgdGhlIHRlYXJkb3duJ3Mgam9iIChlbmRpbmcpIEFORFxuICAvLyBza2lwcyB0aGUgdGVhcmRvd24uIFJlbW92aW5nIGl0IHRvIGdhaW4gdGhlIHRlYXJkb3duIGNhbiBMT1NFIFRIRSBFTkRJTkcg4oCUXG4gIC8vIHdoaWNoIHNoaXBwZWQgYSAyMy1taW51dGUgaGFuZyBpbiBhIHJlbGVhc2VkIHNwZWxsIG9uY2UgYWxyZWFkeS5cbiAgLy9cbiAgLy8gVHdvIHRoaW5ncyBtYWtlIHRoZSBlbmRpbmcgc2FmZSBoZXJlLCBhbmQgbmVpdGhlciBpcyBcInRoZSB0ZWFyZG93biBpc1xuICAvLyB3ZWxsLWJlaGF2ZWRcIjpcbiAgLy8gICAxLiBUaGUgdGVybWluYWwgYHByb2Nlc3MuZXhpdChleGl0Q29kZSlgIGF0IGBpbXBvcnQubWV0YS5tYWluYCBTVEFZUy4gVGhpc1xuICAvLyAgICAgIGNoYW5nZSBkb2VzIG5vdCBzd2FwIGFuIGV4aXQgZm9yIGEgbmF0dXJhbCByZXR1cm47IGl0IG9ubHkgcmVkaXJlY3RzXG4gIC8vICAgICAgdGhlIHNpZ25hbCBwYXRoIElOVE8gdGhlIGJvdW5kZWQgdGVhcmRvd24gdGhhdCBhbHJlYWR5IHByZWNlZGVzIHRoYXRcbiAgLy8gICAgICBleGl0LiBFdmVyeSBhd2FpdCBpbiB0aGF0IGJsb2NrIGlzIGJvdW5kZWQgKGEgMTUwbXMgc2xlZXAsIGFcbiAgLy8gICAgICBQcm9taXNlLnJhY2Ugd2l0aCBhIDIwMG1zIGNhcCwgZnMgd29yaykuXG4gIC8vICAgMi4gQSBXQVRDSERPRywgYmVsb3csIGZvcmNlLWV4aXRzIGlmIHRoZSB0ZWFyZG93biBkb2VzIG5vdCBmaW5pc2guIFNvXG4gIC8vICAgICAgdGVybWluYXRpb24gaXMgZ3VhcmFudGVlZCBieSBjb25zdHJ1Y3Rpb24gcmF0aGVyIHRoYW4gYnkgdGhlIHRlYXJkb3duXG4gIC8vICAgICAgYmVpbmcgY29ycmVjdCDigJQgdGhlIHByb3BlcnR5IGEgZ2F0ZSBjYW4gYWN0dWFsbHkgYXNzZXJ0LlxuICAvL1xuICAvLyBgcmVxdWVzdFNodXRkb3duYCBpcyBhIG11dGFibGUgaG9vayBiZWNhdXNlIHRoZXNlIGhhbmRsZXJzIG11c3QgYmUgaW5zdGFsbGVkXG4gIC8vIEJFRk9SRSB0aGUgd29yayB0aGV5IGd1YXJkLCB3aGlsZSBgZG9uZWAvYHNvY2tldHNgL2Bzc2VDbGllbnRzYCBkbyBub3QgZXhpc3RcbiAgLy8gdW50aWwgbGF0ZXIuIFVudGlsIGl0IGlzIGFzc2lnbmVkLCBhIHNpZ25hbCBmYWxscyBiYWNrIHRvIHRoZSBvbGQgaW1tZWRpYXRlXG4gIC8vIGV4aXQg4oCUIGEgc2lnbmFsIGR1cmluZyBzdGFydHVwIE1VU1Qgc3RpbGwga2lsbCB0aGUgcHJvY2VzcywgYW5kIHByZXRlbmRpbmdcbiAgLy8gb3RoZXJ3aXNlIHdvdWxkIGludHJvZHVjZSBhIGhhbmcgaW4gZXhhY3RseSB0aGUgd2luZG93IHdpdGggbm90aGluZyB0byBzYXZlLlxuICBsZXQgcmVxdWVzdFNodXRkb3duOiAoKGNvZGU6IG51bWJlciwgcmVhc29uOiBzdHJpbmcsIHNpZ25hbDogc3RyaW5nKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBjb25zdCBvbkZhdGFsID0gKHNpZ25hbDogc3RyaW5nLCBjb2RlOiBudW1iZXIpID0+ICgpID0+IHtcbiAgICBpZiAocmVxdWVzdFNodXRkb3duKSByZXF1ZXN0U2h1dGRvd24oY29kZSwgXCJzaWduYWxcIiwgc2lnbmFsKTtcbiAgICBlbHNlIHtcbiAgICAgIGxvZ0RhZW1vbihcInNpZ25hbFwiLCB7IHNpZ25hbCwgcGhhc2U6IFwicHJlLWluaXRcIiB9KTtcbiAgICAgIHByb2Nlc3MuZXhpdChjb2RlKTtcbiAgICB9XG4gIH07XG4gIHByb2Nlc3Mub24oXCJ1bmNhdWdodEV4Y2VwdGlvblwiLCAoZSkgPT4ge1xuICAgIGxvZ0RhZW1vbihcInVuY2F1Z2h0RXhjZXB0aW9uXCIsIHtcbiAgICAgIGVycm9yOiBTdHJpbmcoZSksXG4gICAgICBzdGFjazogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5zdGFjayA6IHVuZGVmaW5lZCxcbiAgICB9KTtcbiAgICAvLyBOT1Qgcm91dGVkIHRocm91Z2ggdGhlIHRlYXJkb3duLiBBbiB1bmNhdWdodCBleGNlcHRpb24gbWVhbnMgaW52YXJpYW50c1xuICAgIC8vIGFyZSBhbHJlYWR5IHVua25vd24sIGFuZCB0aGUgdGVhcmRvd24gV1JJVEVTIFRIRSBTTkFQU0hPVCDigJQgZmx1c2hpbmdcbiAgICAvLyBwb3NzaWJseS1jb3JydXB0IHN0YXRlIG92ZXIgYSBnb29kIG9uZSBpcyB0aGUgIzczIGZhaWx1cmUgd2l0aCBleHRyYVxuICAgIC8vIHN0ZXBzLiBEeWluZyBsb3VkbHkgYW5kIGxlYXZpbmcgdGhlIGxhc3QgZ29vZCBzbmFwc2hvdCBpcyBjb3JyZWN0IGhlcmUuXG4gICAgcHJvY2Vzcy5leGl0KDEpO1xuICB9KTtcbiAgcHJvY2Vzcy5vbihcInVuaGFuZGxlZFJlamVjdGlvblwiLCAoZSkgPT4ge1xuICAgIGxvZ0RhZW1vbihcInVuaGFuZGxlZFJlamVjdGlvblwiLCB7IGVycm9yOiBTdHJpbmcoZSkgfSk7XG4gIH0pO1xuICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBvbkZhdGFsKFwiU0lHVEVSTVwiLCAxNDMpKTtcbiAgcHJvY2Vzcy5vbihcIlNJR0lOVFwiLCBvbkZhdGFsKFwiU0lHSU5UXCIsIDEzMCkpO1xuXG4gIC8vIFJlc29sdmVkIEJFRk9SRSBhbnkgZmlsZXN5c3RlbSB3cml0ZS4gQSBmb3JjZWQtZGV2IGJvb3QgYXQgYSBzdXJmYWNlLWZyZWVcbiAgLy8gZGVzdGluYXRpb24gbXVzdCBkaWUgSEVSRSwgYXQgdGhlIGltcG9ydCwgaGF2aW5nIHdyaXR0ZW4gbm90aGluZzogbm9cbiAgLy8gc25hcHNob3QsIG5vIGRpc2NvdmVyeSBmaWxlIOKAlCBzbyBhIENMSSBwb2xsaW5nIGZvciB0aGUgc2Vzc2lvbiBmaWxlIHNlZXMgYVxuICAvLyBjbGVhbiBmYWlsdXJlIHJhdGhlciB0aGFuIGEgaGFsZi1ib3JuIGRhZW1vbi5cbiAgY29uc3QgbW9kZSA9IHJlc29sdmVNb2RlKCk7XG4gIC8vIGRldjogQnVuIGJ1bmRsZXMgdGhlIC50c3ggZ3JhcGggKyBUYWlsd2luZCBhdCBzZXJ2ZSB0aW1lLCByZWFkaW5nXG4gIC8vIGJ1bmZpZy50b21sIGZyb20gY3dkLCB3aGljaCBjbGkudHMgcGlucyB0byBzcmMvYm91bnR5LyAoQ29udHJhY3QgNSkuXG4gIC8vIHJlbGVhc2U6IGRpc3QvIGlzIHN0YXRpYyBhbmQgcHJlLWJ1aWx0IOKAlCBcIi9cIiBpcyBhbnN3ZXJlZCBieSBzZXJ2ZURpc3QoKSBpblxuICAvLyB0aGUgZmV0Y2ggaGFuZGxlciwgc28gdGhpcyBicmFuY2ggbmV2ZXIgdG91Y2hlcyBzdXJmYWNlIHNvdXJjZSBvclxuICAvLyBidW5maWcudG9tbCBhbmQgbmV2ZXIgbmVlZHMgZWl0aGVyIHRvIGV4aXN0LiBUaGlzIGlzIHRoZSBPTkUgc3JjLy1uYW1pbmdcbiAgLy8gc3BlY2lmaWVyIGluIHRoZSBkZXBsb3llZCBzcGVsbCAoZ3JpbW9pcmUvaW1wb3J0LWJvdW5kYXJ5LXdhcmRzLnRlc3QudHNcbiAgLy8gcGlucyBpdCkuXG4gIC8vXG4gIC8vIOKblCBUSEUgRkFJTFVSRSBNVVNUIE5BTUUgVEhFIFNVUkZBQ0UuIFRoaXMgZGFlbW9uIGluc3RhbGxzIGFuXG4gIC8vIGB1bmNhdWdodEV4Y2VwdGlvbmAgaGFuZGxlciB0aGF0IGxvZ3MgdG8gJEJPVU5UWV9IT01FL2RhZW1vbi5sb2cgYW5kIGV4aXRzXG4gIC8vIDEgV0lUSE9VVCB0b3VjaGluZyBzdGRlcnIg4oCUIGNvcnJlY3QgZm9yIGEgbWlkLWZsaWdodCBpbnZhcmlhbnQgYnJlYWssIGFuZFxuICAvLyBleGFjdGx5IHdyb25nIGhlcmU6IGEgZm9yY2VkLWRldiBib290IGF0IGEgc3VyZmFjZS1mcmVlIGRlc3RpbmF0aW9uIHRoZW5cbiAgLy8gZGllcyB3aXRoIG5vIG91dHB1dCBhdCBhbGwsIGFuZCB0aGUgb3BlcmF0b3IgaGFzIG5vIHdheSB0byB0ZWxsIGl0IGZyb20gYVxuICAvLyBtaXNzaW5nIGBidW5gLiBNZWFzdXJlZCBvbiB0aGUgbG9jYWwtc2ltIGJlZm9yZSB0aGlzIGNhdGNoIGV4aXN0ZWQ6IGV4aXQgMSxcbiAgLy8gc3Rkb3V0IGVtcHR5LCBzdGRlcnIgZW1wdHkuXG4gIGxldCBkZXZJbmRleDogdW5rbm93bjtcbiAgaWYgKG1vZGUgPT09IFwiZGV2XCIpIHtcbiAgICB0cnkge1xuICAgICAgZGV2SW5kZXggPSAoYXdhaXQgaW1wb3J0KFwiLi4vLi4vLi4vLi4vLi4vc3JjL2JvdW50eS9zdXJmYWNlL2luZGV4Lmh0bWxcIikpLmRlZmF1bHQ7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIFwiYm91bnR5OiBjYW5ub3Qgc3RhcnQgaW4gZGV2IG1vZGUg4oCUIHRoZSBzdXJmYWNlIHNvdXJjZSBpcyBtaXNzaW5nLlxcblwiICtcbiAgICAgICAgICBcIiAgbmVlZGVkOiBzcmMvYm91bnR5L3N1cmZhY2UvaW5kZXguaHRtbCAocmVsYXRpdmUgdG8gdGhlIHJlcG8gcm9vdClcXG5cIiArXG4gICAgICAgICAgYCAgcmVhc29uOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG5gICtcbiAgICAgICAgICBcIiAgQSBwdWJsaXNoZWQgc3BlbGwgc2hpcHMgYSBidWlsdCBkaXN0LyBhbmQgcmVzb2x2ZXMgdG8gcmVsZWFzZSBtb2RlOyBkZXYgbW9kZVxcblwiICtcbiAgICAgICAgICBcIiAgbmVlZHMgdGhlIHJlcG8uIFVuc2V0IFNQRUxMQk9PS19TVVJGQUNFX01PREUsIG9yIHJ1biBmcm9tIGEgY2hlY2tvdXQuXFxuXCIsXG4gICAgICApO1xuICAgICAgcmV0dXJuIDI7XG4gICAgfVxuICB9XG4gIGNvbnN0IHJvdXRlcyA9IChkZXZJbmRleCA/IHsgXCIvXCI6IGRldkluZGV4IH0gOiB7fSkgYXMgUmVjb3JkPHN0cmluZywgbmV2ZXI+O1xuICBjb25zdCBhc3NldHNEaXIgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCJhc3NldHNcIik7XG5cbiAgLy8gSW5pdGlhbCBzdGF0ZSDigJQgcmVzdG9yZWQgZnJvbSBhIHNuYXBzaG90IChtZXJnZS1vdmVyLWRlZmF1bHRzKSBvciBmcmVzaC5cbiAgLy8gUmVzdG9yZSBsb2FkcyB0aGUgc25hcHNob3QgYW5kIG1lcmdlcyBpdCBvdmVyIHRoZSBkZWZhdWx0IHNoYXBlIHNvIGEgc25hcHNob3RcbiAgLy8gZnJvbSBhbiBvbGRlciBidWlsZCBnYWlucyBhbnkgbmV3IHRvcC1sZXZlbCBmaWVsZHMgd2l0aG91dCBjcmFzaGluZzsgcmVzdG9yZWRcbiAgLy8gdGFza3MgcnVuIHRocm91Z2ggdmFsaWRhdGVUYXNrIChmaWx0ZXItYW5kLWtlZXAtdmFsaWQpIHNvIGEgbWFsZm9ybWVkIG9yXG4gIC8vIGxlZ2FjeSBlbnRyeSBpcyBkcm9wcGVkLCBub3QgZmF0YWwuXG4gIGNvbnN0IHN0YXRlOiBCb2FyZFN0YXRlID0geyB0aXRsZTogdi50aXRsZSBhcyBzdHJpbmcsIHRhc2tzOiBbXSB9O1xuICAvLyBiMTUg4oCUIHByZXNlbnQtYW5kLW51bGwgb24gZXZlcnkgYm9vdDogbnVsbCBtZWFucyBcIm5vIHJlc3RvcmUgZmFpbGVkXCIsIG5ldmVyXG4gIC8vIFwidGhpcyBkYWVtb24gZG9lcyBub3QgcmVwb3J0IHJlc3RvcmUgZmFpbHVyZXNcIi5cbiAgbGV0IHJlc3RvcmVGYWlsZWQ6IHsgcGF0aDogc3RyaW5nOyByZWFzb246IHN0cmluZyB9IHwgbnVsbCA9IG51bGw7XG4gIGlmICh2LnJlc3RvcmUpIHtcbiAgICBjb25zdCByZXN0b3JlQXJnID0gdi5yZXN0b3JlIGFzIHN0cmluZztcbiAgICBjb25zdCByZXN0b3JlUGF0aCA9IGV4aXN0c1N5bmMocmVzdG9yZUFyZylcbiAgICAgID8gcmVzdG9yZUFyZ1xuICAgICAgOiBqb2luKFNOQVBTSE9UU19ESVIsIGAke3Jlc3RvcmVBcmd9Lmpzb25gKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc25hcCA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHJlc3RvcmVQYXRoLCBcInV0ZjhcIikpIGFzIFBhcnRpYWw8Qm9hcmRTdGF0ZT47XG4gICAgICBjb25zdCBtZXJnZWQ6IEJvYXJkU3RhdGUgPSB7IHRpdGxlOiBzdGF0ZS50aXRsZSwgdGFza3M6IFtdLCAuLi5zbmFwIH07XG4gICAgICBpZiAodHlwZW9mIG1lcmdlZC50aXRsZSA9PT0gXCJzdHJpbmdcIikgc3RhdGUudGl0bGUgPSBtZXJnZWQudGl0bGU7XG4gICAgICBzdGF0ZS50YXNrcyA9IEFycmF5LmlzQXJyYXkobWVyZ2VkLnRhc2tzKVxuICAgICAgICA/IG1lcmdlZC50YXNrcy5tYXAodmFsaWRhdGVUYXNrKS5maWx0ZXIoKHQpOiB0IGlzIFRhc2sgPT4gdCAhPT0gbnVsbClcbiAgICAgICAgOiBbXTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAvLyBiMTUg4oCUIEEgUkVTVE9SRSBUSEFUIFdBUyBBVFRFTVBURUQgQU5EIEZBSUxFRCBVU0VEIFRPIEJFIElOVklTSUJMRS5cbiAgICAgIC8vIFRoaXMgYnJhbmNoIHdyb3RlIHRvIHRoZSBEQUVNT04nUyBzdGRlcnIsIGFuZCBjbGkudHMgc3Bhd25zIHRoZSBkYWVtb25cbiAgICAgIC8vIHdpdGggc3RkZXJyIHBvaW50ZWQgYXQgYSBsb2cgZmlsZSB0aGUgY2FsbGVyIG5ldmVyIHJlYWRzIOKAlCB0aGVuIGl0XG4gICAgICAvLyBDT05USU5VRUQgd2l0aCB0aGUgZW1wdHkgZGVmYXVsdCBib2FyZC4gQW4gZW1wdHkgYm9hcmQsIGV4aXQgMCwgYW5kXG4gICAgICAvLyBub3RoaW5nIGluIGFueSBlbnZlbG9wZSBzYXlpbmcgYSByZXN0b3JlIGhhZCBldmVuIGJlZW4gdHJpZWQuXG4gICAgICAvL1xuICAgICAgLy8g4pqgIE1ZIE9XTiBmYjIwOWYxIFdJREVORUQgVEhJUy4gQmVmb3JlIGl0LCBvbmx5IGFuIGV4cGxpY2l0IGAtLXJlc3RvcmVgXG4gICAgICAvLyByZWFjaGVkIGhlcmU7IG5vdyBFVkVSWSBrZXllZCByZXNwYXduIHBhc3NlcyAtLXJlc3RvcmUsIHNvIGEgY29ycnVwdFxuICAgICAgLy8gc25hcHNob3Qgc2lsZW50bHkgeWllbGRzIGFuIGVtcHR5IGJvYXJkIG9uIHRoZSBjb21tb24gcGF0aC4gYjcncyBkZWZlY3QsXG4gICAgICAvLyByZWNyZWF0ZWQgYnkgYjcncyBmaXgsIG9uIHRoZSBlcnJvciBicmFuY2guXG4gICAgICAvL1xuICAgICAgLy8gRGlzdGluY3QgZnJvbSBgcmVzdG9yZVNraXBwZWRgLCBydWxlZCB0byBtZWFuIFwieW91ciBFWFBMSUNJVCAtLXJlc3RvcmVcbiAgICAgIC8vIHdhcyB2YWxpZCBhbmQgdGhlIHNpdHVhdGlvbiBjb3VsZCBub3QgaG9ub3VyIGl0XCIg4oCUIG5ldmVyIGF0dGVtcHRlZC5cbiAgICAgIC8vIFRoaXMgb25lIFdBUyBhdHRlbXB0ZWQgYW5kIGJyb2tlLiBTYW1lIGVudmVsb3BlIHNoYXBlLCBvcHBvc2l0ZSByZW1lZHk6XG4gICAgICAvLyBza2lwcGVkIG1lYW5zIGZpeCB5b3VyIHNpdHVhdGlvbiwgZmFpbGVkIG1lYW5zIHlvdXIgc25hcHNob3QgaXMgZGFtYWdlZFxuICAgICAgLy8gYW5kIGhlcmUgaXMgdGhlIHBhdGguXG4gICAgICByZXN0b3JlRmFpbGVkID0ge1xuICAgICAgICBwYXRoOiByZXN0b3JlUGF0aCxcbiAgICAgICAgcmVhc29uOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSksXG4gICAgICB9O1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYGJvdW50eTogcmVzdG9yZSBmYWlsZWQgKCR7cmVzdG9yZVBhdGh9KTogJHtyZXN0b3JlRmFpbGVkLnJlYXNvbn1cXG5gKTtcbiAgICB9XG4gIH1cbiAgY29uc3Qgc29ja2V0cyA9IG5ldyBTZXQ8U2VydmVyV2ViU29ja2V0PHVua25vd24+PigpO1xuXG4gIC8vIEFwcGVuZC1vbmx5IGV2ZW50IGxvZyBmb3IgdGhlIGFnZW50J3MgU1NFIHRhaWwgKEdFVCAvZXZlbnRzKS4gRWFjaCBldmVudFxuICAvLyBnZXRzIGEgbW9ub3RvbmljIGBpZGAgc28gYSAocmUpY29ubmVjdGluZyB0YWlsIHJlc3VtZXMgdmlhID9zaW5jZT08aWQ+LlxuICAvLyBgY3Vyc29yYCBpbiBHRVQgL3N0YXRlIGlzIHRoZSBjdXJyZW50IGBldmVudFNlcWAg4oCUIHRoZSByZXN1bWUgcG9pbnQuXG4gIGNvbnN0IGV2ZW50czogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+ID0gW107XG4gIGxldCBldmVudFNlcSA9IDA7XG4gIGNvbnN0IGVuYyA9IG5ldyBUZXh0RW5jb2RlcigpO1xuICBjb25zdCBzc2VDbGllbnRzID0gbmV3IFNldDxSZWFkYWJsZVN0cmVhbURlZmF1bHRDb250cm9sbGVyPigpO1xuICBjb25zdCBzc2VUaW1lcnMgPSBuZXcgU2V0PFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPj4oKTtcblxuICAvLyBEZWJvdW5jZWQgcGVyc2lzdGVuY2U6IGEgYm9hcmQgbXV0YXRpb24gbWFya3MgdGhlIHNuYXBzaG90IGRpcnR5OyBhIH4xc1xuICAvLyB0aW1lciBmbHVzaGVzIGl0LCBhbmQgYSBmaW5hbCB3cml0ZSBsYW5kcyBvbiBjbG9zZS4gVGhlIHNuYXBzaG90IGlzIGtleWVkIGJ5XG4gIC8vIHNlc3Npb24gaWQgYW5kIEtFUFQgb24gY2xvc2UgKGl0J3MgdGhlIHJlc3VtZSBwb2ludCBmb3IgLS1yZXN0b3JlKS5cbiAgbGV0IHNuYXBEaXJ0eSA9IGZhbHNlO1xuICAvLyAjNzMvIzc0IOKAlCBPTkNFIFBFUiBEQUVNT04gU0VTU0lPTi4gTGl2ZXMgaGVyZSwgaW4gdGhlIGRhZW1vbidzIGNsb3N1cmUsIHNvXG4gIC8vIFwic2Vzc2lvblwiIG1lYW5zIGV4YWN0bHkgXCJ0aGlzIHByb2Nlc3NcIjogYSByZXN0YXJ0IHJlLWFybXMgaXQsIHdoaWNoIGlzIHRoZVxuICAvLyBwb2ludCAodGhlIHN0YXRlIHdvcnRoIGtlZXBpbmcgaXMgd2hhdGV2ZXIgZXhpc3RlZCBiZWZvcmUgVEhJUyBkYWVtb25cbiAgLy8gc3RhcnRlZCB3cml0aW5nKS5cbiAgbGV0IHJvdGF0ZWRUaGlzU2Vzc2lvbiA9IGZhbHNlO1xuICAvLyBEMS4yJ3MgcmVhZGFibGUgYmxhbmsuIFRoZSBydWxpbmcgc2F5cyBgc25hcHNob3RCYWNrZWRVcDogey4uLn0gfCBudWxsYCxcbiAgLy8gXCJudWxsIHdoZW4gbm90aGluZyBoYXBwZW5lZCwgTkVWRVIgQUJTRU5UIOKAlCBhIHJlYWRhYmxlIGJsYW5rIGRpc3Rpbmd1aXNoZXNcbiAgLy8gJ25vdCBuZWVkZWQnIGZyb20gJ25vdCByZXBvcnRlZCdcIiwgYW5kIHRoYXQgc3RkZXJyIHByb3NlIGRvZXMgbm90IGNvdW50XG4gIC8vIGJlY2F1c2UgdGhlIGNvbnN1bWVyIGlzIGFuIGFnZW50IHBhcnNpbmcgSlNPTi5cbiAgLy9cbiAgLy8g4puUIFRIRSBFVkVOVCBBTE9ORSBDQU5OT1QgU0FUSVNGWSBUSEFULCBBTkQgVEhFIFJFQVNPTiBJUyBTVFJVQ1RVUkFMOiBhblxuICAvLyBldmVudCBpcyBBQlNFTlQgd2hlbiBub3RoaW5nIGhhcHBlbmVkLCBzbyBcIm5vIHJvdGF0aW9uXCIgYW5kIFwiYSBkYWVtb24gdGhhdFxuICAvLyBuZXZlciBlbWl0cyB0aGlzXCIgYXJlIGJ5dGUtaWRlbnRpY2FsIHRvIGEgY29uc3VtZXIuIFRoZSBydWxpbmcgd2FzIHdyaXR0ZW5cbiAgLy8gZm9yIGEgY29tbWFuZC1yZXNwb25zZSB0cmlnZ2VyIChjbG9zZS9yZXN0b3JlKSB3aGljaCBoYXMgYW4gZW52ZWxvcGU7IHRoZVxuICAvLyB0cmlnZ2VyIHRoYXQgc2hpcHBlZCBpcyBhIEJBQ0tHUk9VTkQgRkxVU0gsIHdoaWNoIGhhcyBubyByZXNwb25zZSB0byBjYXJyeSBhXG4gIC8vIGZpZWxkLiBgL3N0YXRlYCBpcyB0aGUgaG9tZSB0aGF0IHN1cnZpdmVzIHRoYXQgY2hhbmdlIOKAlCBpdCBpcyB0aGUgYWdlbnQnc1xuICAvLyBKU09OIHN1cmZhY2UgYW5kIGl0IGlzIHJlYWRhYmxlIGF0IGFueSB0aW1lLCBpbmNsdWRpbmcgYWZ0ZXIgdGhlIG9uZSBwYWdlXG4gIC8vIHJlZnJlc2ggdGhhdCBsb3NlcyBhbiBldmVudC5cbiAgLy9cbiAgLy8gVGhpcyBpcyBteSBvd24gcmVjb3JkZWQgbGVzc29uIGFycml2aW5nIGF0IGEgc2Vjb25kIHNwZWxsOiBhIHNpZ25hbCB3aG9zZVxuICAvLyBBQlNFTkNFIGlzIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gXCJub3RoaW5nIGlzIGhhcHBlbmluZ1wiIG5lZWRzIGEgcmVhZFxuICAvLyBhbG9uZ3NpZGUgaXRzIGV2ZW50OyBldmVudC1vbmx5IGlzIGZpbmUgb25seSBmb3Igc2lnbmFscyB0aGF0IGFyZVxuICAvLyBzZWxmLWV2aWRlbnRseSB0cmFuc2llbnQuXG4gIGxldCBzbmFwc2hvdEJhY2tlZFVwOiB7IHBhdGg6IHN0cmluZzsgdGFza0NvdW50OiBudW1iZXI7IHJlYXNvbjogc3RyaW5nIH0gfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc2F2ZVNuYXBzaG90ID0gKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmMoU05BUFNIT1RTX0RJUiwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBjb25zdCBwYXRoID0gam9pbihTTkFQU0hPVFNfRElSLCBgJHtzZXNzaW9uSWR9Lmpzb25gKTtcbiAgICAgIC8vIENvcHkgdGhlIGV4aXN0aW5nIHNuYXBzaG90IGFzaWRlIEJFRk9SRSB0aGUgZmlyc3Qgc2hyaW5raW5nIHdyaXRlIG9mXG4gICAgICAvLyB0aGlzIGRhZW1vbidzIGxpZmUuIFNlZSBzaG91bGRSb3RhdGVTbmFwc2hvdCBmb3Igd2h5IHRoZSBwcmVkaWNhdGUgaXNcbiAgICAgIC8vIHNocmlua2FnZSByYXRoZXIgdGhhbiBlbXB0aW5lc3MsIGFuZCB3aHkgaXQgZmlyZXMgb25jZSBwZXIgYm9vdC5cbiAgICAgIGNvbnN0IHByaW9yID0gc25hcHNob3RUYXNrQ291bnQocGF0aCk7XG4gICAgICAvLyBgcHJpb3IgIT09IG51bGxgIGlzIHJlZHVuZGFudCBhdCBSVU5USU1FIOKAlCBzaG91bGRSb3RhdGVTbmFwc2hvdCByZXR1cm5zXG4gICAgICAvLyBmYWxzZSBmb3IgbnVsbCwgYW5kIGEgdW5pdCBjZWxsIHBpbnMgdGhhdC4gSXQgaXMgaGVyZSBzbyB0aGUgY29tcGlsZXJcbiAgICAgIC8vIG5hcnJvd3MgYHByaW9yYCB0byBudW1iZXIgZm9yIHRoZSBgdGFza0NvdW50YCBmaWVsZCBiZWxvdzsgd2l0aG91dCBpdCxcbiAgICAgIC8vIHRzYyByZXBvcnRzIFRTMjMyMiBhbmQgYGJ1biB0ZXN0YCBzdGF5cyBncmVlbiwgd2hpY2ggaXMgdGhlIHN0YW5kaW5nXG4gICAgICAvLyBidW4tZ3JlZW4taXMtbm90LXRzYy1jbGVhbiB0cmFwLiBLZWVwaW5nIHRoZSBwcmVkaWNhdGUgdG90YWwgYW55d2F5IGlzXG4gICAgICAvLyBkZWxpYmVyYXRlOiBpdCBzdGF5cyBjb3JyZWN0IGZvciBhbnkgY2FsbGVyLCBub3QganVzdCB0aGlzIG9uZS5cbiAgICAgIGlmIChwcmlvciAhPT0gbnVsbCAmJiBzaG91bGRSb3RhdGVTbmFwc2hvdChwcmlvciwgc3RhdGUudGFza3MubGVuZ3RoLCByb3RhdGVkVGhpc1Nlc3Npb24pKSB7XG4gICAgICAgIC8vIGAuYmFrLmpzb25gIGFuZCBub3QgYC5iYWtgOiB0aGUgc3VmZml4IGlzIHdoYXQgbWFrZXMgdGhpcyByZWNvdmVyYWJsZVxuICAgICAgICAvLyB0aHJvdWdoIHRoZSB2ZXJicyB0aGF0IGFscmVhZHkgZXhpc3QuIGBzZXNzaW9uc2AgbGlzdHMgKi5qc29uIGFuZFxuICAgICAgICAvLyBzdHJpcHMgdGhlIGV4dGVuc2lvbiwgc28gdGhlIGJhY2t1cCBhcHBlYXJzIHRoZXJlIGJ5IG5hbWU7IGFuZFxuICAgICAgICAvLyBgb3BlbiAtLXJlc3RvcmUgPGlkPi5wcmUtPHRzPi5iYWtgIHJlc29sdmVzIGl0LCBiZWNhdXNlIHJlc3RvcmUgam9pbnNcbiAgICAgICAgLy8gU05BUFNIT1RTX0RJUiB3aXRoIHRoZSBhcmcgcGx1cyBcIi5qc29uXCIuIFplcm8gbmV3IHJlY292ZXJ5IHN1cmZhY2UuXG4gICAgICAgIGNvbnN0IGJhY2t1cCA9IGpvaW4oU05BUFNIT1RTX0RJUiwgYCR7c2Vzc2lvbklkfS5wcmUtJHtEYXRlLm5vdygpfS5iYWsuanNvbmApO1xuICAgICAgICBjb3B5RmlsZVN5bmMocGF0aCwgYmFja3VwKTtcbiAgICAgICAgcm90YXRlZFRoaXNTZXNzaW9uID0gdHJ1ZTtcbiAgICAgICAgc25hcHNob3RCYWNrZWRVcCA9IHtcbiAgICAgICAgICBwYXRoOiBiYWNrdXAsXG4gICAgICAgICAgdGFza0NvdW50OiBwcmlvcixcbiAgICAgICAgICByZWFzb246IGBhYm91dCB0byB3cml0ZSAke3N0YXRlLnRhc2tzLmxlbmd0aH0gdGFza3Mgb3ZlciAke3ByaW9yfWAsXG4gICAgICAgIH07XG4gICAgICAgIC8vIOKblCBBTkQgSVQgU0FZUyBTTy4gQSBzaWxlbnQgcm90YXRpb24gaXMgYSBzdWNjZXNzLXNoYXBlZCBsaWUsIHdoaWNoIGlzXG4gICAgICAgIC8vIHRoZSBkZWZlY3QgZmFtaWx5IHRoaXMgd2hvbGUgcHJvamVjdCBpcyBuYW1lZCBhZnRlciDigJQgdGhlIHVzZXIgd291bGRcbiAgICAgICAgLy8gYmUgcHJvdGVjdGVkIGFuZCBuZXZlciBrbm93IHRoZXkgaGFkIG5lZWRlZCBwcm90ZWN0aW5nLiBUaHJlZVxuICAgICAgICAvLyBzdXJmYWNlcywgYmVjYXVzZSB0aGV5IGZhaWwgZGlmZmVyZW50bHk6IHRoZSBkdXJhYmxlIGxvZyBzdXJ2aXZlcyB0aGVcbiAgICAgICAgLy8gZGFlbW9uLCB0aGUgZXZlbnQgcmVhY2hlcyBhIGxpdmUgdGFpbCwgYW5kIHN0ZGVyciByZWFjaGVzIHdob2V2ZXIgaXNcbiAgICAgICAgLy8gd2F0Y2hpbmcgdGhlIHByb2Nlc3MuXG4gICAgICAgIGxvZ0RhZW1vbihcInNuYXBzaG90QmFja2VkVXBcIiwge1xuICAgICAgICAgIGJhY2t1cCxcbiAgICAgICAgICBwcmlvclRhc2tzOiBwcmlvcixcbiAgICAgICAgICBuZXh0VGFza3M6IHN0YXRlLnRhc2tzLmxlbmd0aCxcbiAgICAgICAgfSk7XG4gICAgICAgIGVtaXRFdmVudCh7XG4gICAgICAgICAgdHlwZTogXCJzbmFwc2hvdEJhY2tlZFVwXCIsXG4gICAgICAgICAgYmFja3VwLFxuICAgICAgICAgIHByaW9yVGFza3M6IHByaW9yLFxuICAgICAgICAgIG5leHRUYXNrczogc3RhdGUudGFza3MubGVuZ3RoLFxuICAgICAgICAgIGJ5OiBcInN5c3RlbVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgYGJvdW50eTogc25hcHNob3Qgd2FzIGFib3V0IHRvIHNocmluayAke3ByaW9yfSDihpIgJHtzdGF0ZS50YXNrcy5sZW5ndGh9IHRhc2tzOyBjb3BpZWQgdGhlIG9sZCBvbmUgdG8gJHtiYWNrdXB9XFxuYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHdyaXRlRmlsZVN5bmMocGF0aCwgSlNPTi5zdHJpbmdpZnkoc3RhdGUpKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHBlcnNpc3RlbmNlIGlzIGJlc3QtZWZmb3J0ICovXG4gICAgfVxuICB9O1xuICAvLyBFdmVudCB0eXBlcyB0aGF0IG11dGF0ZSBib2FyZCBzdGF0ZSDigJQgdXNlZCB0byBzZXQgc25hcERpcnR5IGNlbnRyYWxseSAoZXZlcnlcbiAgLy8gbXV0YXRpb24gYWxyZWFkeSBlbWl0cyBvbmUgb2YgdGhlc2UpLiBMaWZlY3ljbGUgZnJhbWVzIGRvbid0IGRpcnR5IHRoZSBzbmFwLlxuICBjb25zdCBESVJUWUlORyA9IG5ldyBTZXQoW1xuICAgIFwiaW5pdFwiLFxuICAgIFwidGFzay5hZGRcIixcbiAgICBcInRhc2sudXBkYXRlXCIsXG4gICAgXCJ0YXNrLnJlbW92ZVwiLFxuICAgIFwidGFzay50b2dnbGVcIixcbiAgICBcInRhc2subW92ZVwiLFxuICAgIFwidGFzay5lZGl0XCIsXG4gIF0pO1xuXG4gIGxldCByZXNvbHZlRG9uZSE6ICh2YWw6IERvbmVSZXN1bHQpID0+IHZvaWQ7XG4gIGxldCBzZXR0bGVkID0gZmFsc2U7XG4gIGNvbnN0IGRvbmUgPSBuZXcgUHJvbWlzZTxEb25lUmVzdWx0PigocmVzKSA9PiB7XG4gICAgcmVzb2x2ZURvbmUgPSAodikgPT4ge1xuICAgICAgaWYgKHNldHRsZWQpIHJldHVybjtcbiAgICAgIHNldHRsZWQgPSB0cnVlO1xuICAgICAgcmVzKHYpO1xuICAgIH07XG4gIH0pO1xuXG4gIC8vIFAxZiDigJQgYXJtIHRoZSBzaWduYWwgcGF0aCBub3cgdGhhdCBgZG9uZWAgZXhpc3RzLiBFdmVyeXRoaW5nIGJlbG93IGlzIHdoYXRcbiAgLy8gdGhlIGhhbmRsZXJzIGFib3ZlIGNvdWxkIG5vdCByZWFjaCBhdCByZWdpc3RyYXRpb24gdGltZS5cbiAgLy9cbiAgLy8g4puUIFRIRSBXQVRDSERPRyBJUyBUSEUgTE9BRC1CRUFSSU5HIFBBUlQsIG5vdCB0aGUgcmVzb2x2ZS4gYHJlc29sdmVEb25lYFxuICAvLyBhbG9uZSB3b3VsZCBtYWtlIHRlcm1pbmF0aW9uIGRlcGVuZCBvbiB0aGUgdGVhcmRvd24gY29tcGxldGluZywgYW5kIFwidGhlXG4gIC8vIHRlYXJkb3duIGFsd2F5cyBjb21wbGV0ZXNcIiBpcyBleGFjdGx5IHRoZSBraW5kIG9mIGNsYWltIHRoYXQgc2hpcHBlZCBhXG4gIC8vIDIzLW1pbnV0ZSBoYW5nLiBUaGlzIG1ha2VzIHRoZSBlbmRpbmcgdW5jb25kaXRpb25hbDogdGVhcmRvd24gZmluaXNoZXMgYW5kXG4gIC8vIGNsZWFycyBpdCAodGhlIG5vcm1hbCBwYXRoLCBhbmQgdGhlIHRpbWVyIG5ldmVyIGZpcmVzKSwgb3IgaXQgZG9lcyBub3QgYW5kXG4gIC8vIHRoZSBwcm9jZXNzIHN0aWxsIGRpZXMgd2l0aCB0aGUgcmlnaHQgY29kZS5cbiAgLy9cbiAgLy8gUkVGJ2QgZGVsaWJlcmF0ZWx5IOKAlCBhbiB1bnJlZidkIHRpbWVyIGNhbm5vdCByZXNjdWUgYSBoYW5nLCBiZWNhdXNlIGEgaGFuZ1xuICAvLyBtZWFucyBzb21ldGhpbmcgZWxzZSBpcyBhbHJlYWR5IGhvbGRpbmcgdGhlIGxvb3Agb3Blbi4gVGhlIGNvc3QgaXMgdGhhdCB0aGVcbiAgLy8gdGltZXIga2VlcHMgdGhlIGxvb3AgYWxpdmUgdW50aWwgdGVhcmRvd24gY2xlYXJzIGl0LCB3aGljaCBpcyB3aHlcbiAgLy8gYGNsZWFyVGltZW91dGAgc2l0cyBhdCB0aGUgZW5kIG9mIHRoZSB0ZWFyZG93biByYXRoZXIgdGhhbiBiZWluZyBvcHRpb25hbC5cbiAgbGV0IHNodXRkb3duV2F0Y2hkb2c6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gIHJlcXVlc3RTaHV0ZG93biA9IChjb2RlLCByZWFzb24sIHNpZ25hbCkgPT4ge1xuICAgIC8vIGBzdWJzY3JpYmVyc2Agb24gdGhlIHNpZ25hbCBwYXRoIOKAlCB0aGUgZmllbGQgdGhpcyBjbGFzcyBvZiBkZWF0aCBoYXMgbmV2ZXJcbiAgICAvLyBjYXJyaWVkLiBUb2RheSBgc2lnbmFsYCBpcyB0aGUgb25seSBleGl0IGNsYXNzIHRoYXQgb21pdHMgaXQsIHNvIG5vdGhpbmdcbiAgICAvLyBpbiBkYWVtb24ubG9nIHdvdWxkIGNoYW5nZSB3aGVuIHRoaXMgZml4IGxhbmRzOyBtZWFzdXJpbmcgdGhlIGZpeCBsYXRlclxuICAgIC8vIHJlcXVpcmVzIHRoZSBpbnN0cnVtZW50IHRvIGV4aXN0IG5vdy4gQ2FwdHVyZWQgQkVGT1JFIHRlYXJkb3duIGNsb3Nlc1xuICAgIC8vIGFueXRoaW5nLCBtYXRjaGluZyB0aGUgYGV4aXRgIGxpbmUncyBvd24gZGlzY2lwbGluZS5cbiAgICBsb2dEYWVtb24oXCJzaWduYWxcIiwgeyBzaWduYWwsIHN1YnNjcmliZXJzOiBzb2NrZXRzLnNpemUgKyBzc2VDbGllbnRzLnNpemUgfSk7XG4gICAgc2h1dGRvd25XYXRjaGRvZyA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgbG9nRGFlbW9uKFwic2h1dGRvd25XYXRjaGRvZ1wiLCB7IHNpZ25hbCwgbm90ZTogXCJ0ZWFyZG93biBkaWQgbm90IGZpbmlzaDsgZm9yY2luZyBleGl0XCIgfSk7XG4gICAgICBwcm9jZXNzLmV4aXQoY29kZSk7XG4gICAgfSwgU0hVVERPV05fV0FUQ0hET0dfTVMpO1xuICAgIHJlc29sdmVEb25lKHsgY29kZSwgcmVhc29uOiByZWFzb24gYXMgQ2xvc2VSZWFzb24gfSk7XG4gIH07XG5cbiAgbGV0IGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICBjb25zdCB0b3VjaCA9ICgpID0+IHtcbiAgICBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgfTtcblxuICBmdW5jdGlvbiBicm9hZGNhc3QobXNnOiBvYmplY3QpIHtcbiAgICBjb25zdCBzID0gSlNPTi5zdHJpbmdpZnkobXNnKTtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLnNlbmQocyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogc29ja2V0IGNsb3NlZCAqL1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIEFwcGVuZCBhIGZyYW1lIHRvIHRoZSBhZ2VudC1mYWNpbmcgZXZlbnQgbG9nIGFuZCBwdXNoIGl0IHRvIGxpdmUgU1NFIHRhaWxzLlxuICAvLyBUaGUgbW9ub3RvbmljIGBpZGAgaXMgdGhlIHJlc3VtZSBjdXJzb3Ig4oCUIGl0IE1VU1Qgd2luIG92ZXIgYW55IGBpZGAgaW4gdGhlXG4gIC8vIHBheWxvYWQsIHNvIGNhbGxlcnMgdGhhdCBjYXJyeSBhIHRhc2sgaWRlbnRpZmllciBwYXNzIGl0IGFzIGB0YXNrSWRgLCBuZXZlclxuICAvLyBgaWRgIChhIGJhcmUgYGlkYCBpbiBgbXNnYCB3b3VsZCBjbG9iYmVyIHRoZSBjdXJzb3IgdW5kZXIgdGhlIHNwcmVhZCkuXG4gIGZ1bmN0aW9uIGVtaXRFdmVudChtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gICAgY29uc3QgZXYgPSB7IGlkOiArK2V2ZW50U2VxLCAuLi5tc2cgfTtcbiAgICBldmVudHMucHVzaChldik7XG4gICAgLy8gRXZlcnkgYm9hcmQgbXV0YXRpb24gZmxvd3MgdGhyb3VnaCBoZXJlIOKAlCBtYXJrIHRoZSBzbmFwc2hvdCBkaXJ0eSBjZW50cmFsbHkuXG4gICAgaWYgKHR5cGVvZiBtc2cudHlwZSA9PT0gXCJzdHJpbmdcIiAmJiBESVJUWUlORy5oYXMobXNnLnR5cGUpKSBzbmFwRGlydHkgPSB0cnVlO1xuICAgIGNvbnN0IGZyYW1lID0gZW5jLmVuY29kZShgZGF0YTogJHtKU09OLnN0cmluZ2lmeShldil9XFxuXFxuYCk7XG4gICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGMuZW5xdWV1ZShmcmFtZSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogY2xpZW50IGdvbmUgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBHRVQgL2V2ZW50cz9zaW5jZT08aWQ+IOKAlCByZXBsYXkgYnVmZmVyZWQgZXZlbnRzIHdpdGggaWQgPiBzaW5jZSwgdGhlbiBrZWVwXG4gIC8vIHRoZSBzdHJlYW0gb3BlbiBmb3IgbGl2ZSBmcmFtZXMgKyBhIDE1cyBoZWFydGJlYXQgY29tbWVudC4gTWlycm9yIGltYWdvJ3NcbiAgLy8gc3NlUmVzcG9uc2UuIHRvdWNoKCkgc28gYW4gYWN0aXZlIHRhaWwgY291bnRzIGFzIGFnZW50IGFjdGl2aXR5LlxuICBmdW5jdGlvbiBzc2VSZXNwb25zZSh1cmw6IFVSTCk6IFJlc3BvbnNlIHtcbiAgICB0b3VjaCgpO1xuICAgIGNvbnN0IHNpbmNlID0gcGFyc2VJbnQodXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJzaW5jZVwiKSA/PyBcIi0xXCIsIDEwKTtcbiAgICBsZXQgcmVmOiBSZWFkYWJsZVN0cmVhbURlZmF1bHRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gICAgbGV0IGhiOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRJbnRlcnZhbD4gfCBudWxsID0gbnVsbDtcbiAgICBjb25zdCBzdHJlYW0gPSBuZXcgUmVhZGFibGVTdHJlYW0oe1xuICAgICAgc3RhcnQoY29udHJvbGxlcikge1xuICAgICAgICByZWYgPSBjb250cm9sbGVyO1xuICAgICAgICBmb3IgKGNvbnN0IGV2IG9mIGV2ZW50cykge1xuICAgICAgICAgIGlmICgoZXYuaWQgYXMgbnVtYmVyKSA+IHNpbmNlKSB7XG4gICAgICAgICAgICBjb250cm9sbGVyLmVucXVldWUoZW5jLmVuY29kZShgZGF0YTogJHtKU09OLnN0cmluZ2lmeShldil9XFxuXFxuYCkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBzc2VDbGllbnRzLmFkZChjb250cm9sbGVyKTtcbiAgICAgICAgaGIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnRyb2xsZXIuZW5xdWV1ZShlbmMuZW5jb2RlKGA6IGhiXFxuXFxuYCkpO1xuICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyogZ29uZSAqL1xuICAgICAgICAgIH1cbiAgICAgICAgfSwgMTUwMDApO1xuICAgICAgICBzc2VUaW1lcnMuYWRkKGhiKTtcbiAgICAgIH0sXG4gICAgICBjYW5jZWwoKSB7XG4gICAgICAgIGlmIChoYikge1xuICAgICAgICAgIGNsZWFySW50ZXJ2YWwoaGIpO1xuICAgICAgICAgIHNzZVRpbWVycy5kZWxldGUoaGIpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZWYpIHNzZUNsaWVudHMuZGVsZXRlKHJlZik7XG4gICAgICB9LFxuICAgIH0pO1xuICAgIHJldHVybiBuZXcgUmVzcG9uc2Uoc3RyZWFtLCB7XG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwidGV4dC9ldmVudC1zdHJlYW1cIixcbiAgICAgICAgXCJDYWNoZS1Db250cm9sXCI6IFwibm8tY2FjaGVcIixcbiAgICAgICAgQ29ubmVjdGlvbjogXCJrZWVwLWFsaXZlXCIsXG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgLy8gT3duZXIgb2YgYSB0YXNrIGJ5IGlkIChvciB1bmRlZmluZWQpLiBTdGFtcGVkIG9udG8gdGFzay4qIGV2ZW50IGZyYW1lcyBzbyBhXG4gIC8vIHNjb3BlZCBgY2xpLnRzIHRhaWwgLS1vd25lcmAvYC0tbWluZWAgY2FuIGZpbHRlciBjbGllbnQtc2lkZSwgYW5kIGxvb2tlZCB1cFxuICAvLyBmb3IgdGhlIGNvb3BlcmF0aXZlLWNsYWltIGd1YXJkLlxuICBjb25zdCBvd25lck9mID0gKGlkOiBzdHJpbmcpID0+IHN0YXRlLnRhc2tzLmZpbmQoKHQpID0+IHQuaWQgPT09IGlkKT8ub3duZXI7XG5cbiAgLy8g4pSA4pSAIGRlcGVuZGVuY2llcyAoUGhhc2UgRCkg4pSA4pSAXG4gIC8vICh0aGUgY2Fub25pY2FsIGBpc0Jsb2NrZWQodGFzaywgdGFza3MpYCBwcmVkaWNhdGUgaXMgbW9kdWxlLWxldmVsLCBzaGFyZWRcbiAgLy8gd2l0aCB0aGUgaGVhcnRiZWF0ICsgY2FyZC1hZ2luZyBzd2VlcHMuKVxuXG4gIC8vIENhbiBgZnJvbWAgcmVhY2ggYHRhcmdldGAgYnkgZm9sbG93aW5nIGJsb2NrZWRCeSBlZGdlcz8gVXNlZCBieSB0aGUgY3ljbGVcbiAgLy8gZ3VhcmQ6IGFkZGluZyBlZGdlIGlk4oaSYiB3b3VsZCBjbG9zZSBhIGxvb3AgaWZmIGIgYWxyZWFkeSByZWFjaGVzIGlkLiBBXG4gIC8vIHZpc2l0ZWQgc2V0IGd1YXJkcyBhZ2FpbnN0IGFueSBwcmUtZXhpc3RpbmcgY3ljbGUgKHRoZXJlIHNob3VsZG4ndCBiZSBvbmUpLlxuICBmdW5jdGlvbiBjYW5SZWFjaChmcm9tOiBzdHJpbmcsIHRhcmdldDogc3RyaW5nLCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCkpOiBib29sZWFuIHtcbiAgICBpZiAoZnJvbSA9PT0gdGFyZ2V0KSByZXR1cm4gdHJ1ZTtcbiAgICBpZiAoc2Vlbi5oYXMoZnJvbSkpIHJldHVybiBmYWxzZTtcbiAgICBzZWVuLmFkZChmcm9tKTtcbiAgICBjb25zdCB0YXNrID0gc3RhdGUudGFza3MuZmluZCgodCkgPT4gdC5pZCA9PT0gZnJvbSk7XG4gICAgcmV0dXJuICh0YXNrPy5ibG9ja2VkQnkgPz8gW10pLnNvbWUoKGJpZCkgPT4gY2FuUmVhY2goYmlkLCB0YXJnZXQsIHNlZW4pKTtcbiAgfVxuXG4gIC8vIFBlci10YXNrIGJsb2NrZWQgc3RhdGUsIHNvIHJlY29uY2lsZUJsb2NrZWQgY2FuIGZpcmUgYHVuYmxvY2tlZGAgZXhhY3RseSBvblxuICAvLyB0aGUgYmxvY2tlZOKGknVuYmxvY2tlZCBmYWxsaW5nIGVkZ2UgKG5ldmVyIGRvdWJsZS1maXJlKS4gU2VlZGVkIGZyb20gdGhlXG4gIC8vIGluaXRpYWwvcmVzdG9yZWQgYm9hcmQgc28gYWxyZWFkeS1ibG9ja2VkIHRhc2tzIGRvbid0IHNwdXJpb3VzbHkgZmlyZS5cbiAgY29uc3QgcHJldkJsb2NrZWQgPSBuZXcgTWFwPHN0cmluZywgYm9vbGVhbj4oKTtcbiAgZm9yIChjb25zdCB0IG9mIHN0YXRlLnRhc2tzKSBwcmV2QmxvY2tlZC5zZXQodC5pZCwgaXNCbG9ja2VkKHQsIHN0YXRlLnRhc2tzKSk7XG5cbiAgLy8gUnVuIGFmdGVyIGV2ZXJ5IG11dGF0aW9uOiBmb3IgZWFjaCB0YXNrLCBpZiBpdCBqdXN0IHdlbnQgYmxvY2tlZOKGknVuYmxvY2tlZFxuICAvLyAodGhlIGxhc3QgbGl2ZSBibG9ja2VyIGNsZWFyZWQsIG9yIGl0cyBsYXN0IGxpdmUgZWRnZSB3YXMgcmVtb3ZlZCkgQU5EIGl0XG4gIC8vIGlzbid0IGl0c2VsZiBkb25lLCBmaXJlIGEgdGFyZ2V0ZWQgYHVuYmxvY2tlZGAgZXZlbnQgdG8gaXRzIG93bmVyLiBCcm9hZFxuICAvLyBPKG4pIHdhbGsg4oCUIG9uZSBtdXRhdGlvbiBjYW4gdW5ibG9jayBtYW55IHRhc2tzOyBib2FyZCBzY2FsZSBtYWtlcyBpdCBmcmVlLlxuICBmdW5jdGlvbiByZWNvbmNpbGVCbG9ja2VkKCkge1xuICAgIGZvciAoY29uc3QgdGFzayBvZiBzdGF0ZS50YXNrcykge1xuICAgICAgY29uc3Qgbm93ID0gaXNCbG9ja2VkKHRhc2ssIHN0YXRlLnRhc2tzKTtcbiAgICAgIGNvbnN0IHdhcyA9IHByZXZCbG9ja2VkLmdldCh0YXNrLmlkKSA/PyBmYWxzZTtcbiAgICAgIGlmICh3YXMgJiYgIW5vdyAmJiB0YXNrLnN0YXR1cyAhPT0gXCJkb25lXCIpIHtcbiAgICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJ1bmJsb2NrZWRcIiwgdGFza0lkOiB0YXNrLmlkLCBvd25lcjogdGFzay5vd25lciwgYnk6IFwic3lzdGVtXCIgfSk7XG4gICAgICB9XG4gICAgICBwcmV2QmxvY2tlZC5zZXQodGFzay5pZCwgbm93KTtcbiAgICB9XG4gIH1cblxuICAvLyBUaGUgL3N0YXRlIHByb2plY3Rpb24g4oCUIGFkZHMgREVSSVZFRCwgYWdlbnQtZmFjaW5nIGZpZWxkcyBwZXIgdGFzaywgY29tcHV0ZWRcbiAgLy8gYXQgc2VyaWFsaXplIHRpbWUgKE5PVCBzdG9yZWQsIE5PVCBzbmFwc2hvdHRlZDsgY2Fub25pY2FsIHN0YXRlIGtlZXBzIHJhd1xuICAvLyBgYmxvY2tlZEJ5YCkuIFRoaXMgaXMgdGhlIHJlYWRiYWNrLXBhcml0eSBsYXllcjogYW4gYWdlbnQgcmVhZGluZyBgc3RhdGVgXG4gIC8vIHNlZXMgdGhlIHNhbWUgYmxvY2tlZC1uZXNzIHRoZSBzdXJmYWNlIHJlbmRlcnMgYXMg4puUIOKAlCBgYmxvY2tlZGAgcGx1cyB0aGVcbiAgLy8gTElWRSBibG9ja2VycyAoZXhpc3QgJiYgbm90IGRvbmUpIHdpdGggdGhlaXIgdGl0bGUrc3RhdHVzLCBzbyBhIHRhc2sgdGhhdCdzXG4gIC8vIGJlZW4gZmlsdGVyZWQgZG93biBieSBgc3RhdGUgLS1taW5lYCBpcyBzdGlsbCBhY3Rpb25hYmxlICh0aGUgYmxvY2tlciBtYXkgYmVcbiAgLy8gb3duZWQgYnkgc29tZW9uZSBlbHNlIGFuZCB0aHVzIGFic2VudCBmcm9tIHRoZSBmaWx0ZXJlZCB2aWV3KS5cbiAgZnVuY3Rpb24gcHJvamVjdFN0YXRlKCkge1xuICAgIHJldHVybiB7XG4gICAgICB0aXRsZTogc3RhdGUudGl0bGUsXG4gICAgICB0YXNrczogc3RhdGUudGFza3MubWFwKCh0YXNrKSA9PiB7XG4gICAgICAgIGNvbnN0IGxpdmVCbG9ja2VycyA9ICh0YXNrLmJsb2NrZWRCeSA/PyBbXSlcbiAgICAgICAgICAubWFwKChiaWQpID0+IHN0YXRlLnRhc2tzLmZpbmQoKHQpID0+IHQuaWQgPT09IGJpZCkpXG4gICAgICAgICAgLmZpbHRlcigoYik6IGIgaXMgVGFzayA9PiBiICE9PSB1bmRlZmluZWQgJiYgYi5zdGF0dXMgIT09IFwiZG9uZVwiKVxuICAgICAgICAgIC5tYXAoKGIpID0+ICh7IGlkOiBiLmlkLCB0aXRsZTogYi50aXRsZSwgc3RhdHVzOiBiLnN0YXR1cyB9KSk7XG4gICAgICAgIHJldHVybiB7IC4uLnRhc2ssIGJsb2NrZWQ6IGxpdmVCbG9ja2Vycy5sZW5ndGggPiAwLCBsaXZlQmxvY2tlcnMgfTtcbiAgICAgIH0pLFxuICAgIH07XG4gIH1cblxuICAvLyBTaW5nbGUgZGlzcGF0Y2ggcG9pbnQgZm9yIGFuIGFnZW50IGNvbW1hbmQgKFBPU1QgL2NtZCBib2R5KS4gTXV0YXRlcyB0aGVcbiAgLy8gY2Fub25pY2FsIHN0YXRlIHZpYSB0aGUgYXBwbHkqIGhlbHBlcnMsIGJyb2FkY2FzdHMgdG8gdGhlIFdTIGNsaWVudHMsIGFuZFxuICAvLyBhcHBlbmRzIGFuIGV2ZW50IGZyYW1lLiBSZXR1cm5zIGFuIGFwcGx5LXJlc3VsdCBzbyB0aGUgQ0xJIGNhbiBjb25maXJtIGFcbiAgLy8gd3JpdGUgdG9vayAoYSByZWplY3RlZCBjb29wZXJhdGl2ZSBjbGFpbSByZXR1cm5zIGFwcGxpZWQ6ZmFsc2UgKyBhIHJlYXNvbikuXG4gIC8vIGBieWAgY2FycmllcyB0aGUgY2FsbGVyJ3MgLS1hcyBpZGVudGl0eSAoY29vcGVyYXRpdmUgYXR0cmlidXRpb24sIG5ldmVyIGFuXG4gIC8vIGF1dGggYm91bmRhcnkpOyB0YXNrLiogZnJhbWVzIGNhcnJ5IHRoZSBhZmZlY3RlZCB0YXNrJ3Mgb3duZXIuXG4gIGZ1bmN0aW9uIGhhbmRsZUFnZW50TXNnKG1zZzogQWdlbnRNc2cpOiBBcHBseVJlc3VsdCB7XG4gICAgY29uc3QgYnkgPSB0eXBlb2YgbXNnLmFzID09PSBcInN0cmluZ1wiID8gbXNnLmFzIDogXCJhZ2VudFwiO1xuICAgIGlmIChtc2cudHlwZSA9PT0gXCJpbml0XCIpIHtcbiAgICAgIGlmICh0eXBlb2YgbXNnLnRpdGxlID09PSBcInN0cmluZ1wiKSBzdGF0ZS50aXRsZSA9IG1zZy50aXRsZTtcbiAgICAgIC8vIEZpbHRlci1hbmQta2VlcC12YWxpZDogZHJvcCBtYWxmb3JtZWQgdGFza3MsIGtlZXAgdGhlIHdlbGwtZm9ybWVkIG9uZXNcbiAgICAgIC8vICh0aGUgL2NtZCBib2R5IGlzIHVudHJ1c3RlZCDigJQgYGJvZHkgYXMgQWdlbnRNc2dgIGlzIGEgY2FzdCwgbm90IGEgY2hlY2spLlxuICAgICAgLy8gUm91dGUgdGhyb3VnaCBhcHBseVRhc2tBZGQgc28gYSBmcmVzaGx5LXNlZWRlZCB0YXNrIGdldHMgYSBiYXNlbGluZVxuICAgICAgLy8gdHJhbnNpdGlvbiBzdGFtcCAoYW5kIGEgcmVzdG9yZWQgb25lIGtlZXBzIGl0cyBwcmVzZXJ2ZWQgaGlzdG9yeSkuXG4gICAgICAvLyBiOCDigJQgQ09VTlQgQU5EIE5BTUUgVEhFIERST1BTLiBGaWx0ZXJpbmcgaXMgY29ycmVjdCAodGhlIC9jbWQgYm9keSBpc1xuICAgICAgLy8gdW50cnVzdGVkKSwgYnV0IHJlcG9ydGluZyBub3RoaW5nIG1lYW50IGEgY2FsbGVyIGNvdWxkIG5vdCBkaXN0aW5ndWlzaCBhXG4gICAgICAvLyBHT09EIFNFRUQgZnJvbSBhIFRPVEFMIFJFSkVDVElPTjogMTggdGFza3MgaW4sIDAgc2VlZGVkLCBhcHBsaWVkOnRydWUuXG4gICAgICBsZXQgZHJvcHBlZDogeyBpbmRleDogbnVtYmVyOyByZWFzb246IHN0cmluZyB9W10gPSBbXTtcbiAgICAgIGlmIChBcnJheS5pc0FycmF5KG1zZy50YXNrcykpIHtcbiAgICAgICAgc3RhdGUudGFza3MgPSBbXTtcbiAgICAgICAgZHJvcHBlZCA9IG1zZy50YXNrc1xuICAgICAgICAgIC5tYXAoKHJhdywgaW5kZXgpID0+ICh7IGluZGV4LCByZWFzb246IHRhc2tSZWplY3Rpb24ocmF3KSB9KSlcbiAgICAgICAgICAuZmlsdGVyKChkKTogZCBpcyB7IGluZGV4OiBudW1iZXI7IHJlYXNvbjogc3RyaW5nIH0gPT4gZC5yZWFzb24gIT09IG51bGwpO1xuICAgICAgICBmb3IgKGNvbnN0IHRhc2sgb2YgbXNnLnRhc2tzLm1hcCh2YWxpZGF0ZVRhc2spKSBpZiAodGFzaykgYXBwbHlUYXNrQWRkKHN0YXRlLCB0YXNrKTtcbiAgICAgIH1cbiAgICAgIGJyb2FkY2FzdCh7IHR5cGU6IFwiaW5pdFwiLCB0aXRsZTogc3RhdGUudGl0bGUsIHRhc2tzOiBzdGF0ZS50YXNrcywgcmVzdG9yZUZhaWxlZCwgc2Vzc2lvbklkIH0pO1xuICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJpbml0XCIsIHRpdGxlOiBzdGF0ZS50aXRsZSwgYnkgfSk7XG4gICAgICAvLyBQcmVzZW50LWFuZC1udWxsLCBuZXZlciBhYnNlbnQ6IGFuIGFic2VudCBmaWVsZCBjYW5ub3QgZGlzdGluZ3Vpc2ggXCJhbGxcbiAgICAgIC8vIHlvdXIgdGFza3Mgd2VyZSBzZWVkZWRcIiBmcm9tIFwidGhpcyBkYWVtb24gZG9lcyBub3QgcmVwb3J0IGRyb3BzXCIuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgYXBwbGllZDogdHJ1ZSxcbiAgICAgICAgdGFza3NEcm9wcGVkOiBkcm9wcGVkLmxlbmd0aFxuICAgICAgICAgID8geyByZXF1ZXN0ZWQ6IEFycmF5LmlzQXJyYXkobXNnLnRhc2tzKSA/IG1zZy50YXNrcy5sZW5ndGggOiAwLCBkcm9wcGVkIH1cbiAgICAgICAgICA6IG51bGwsXG4gICAgICB9O1xuICAgIH0gZWxzZSBpZiAobXNnLnR5cGUgPT09IFwidGFzay5hZGRcIikge1xuICAgICAgLy8gIzgzIOKAlCBgYXBwbGllZDpmYWxzZWAgYWxvbmUgY29uZmxhdGVkIFRXTyBjYXVzZXMgYW5kIG5hbWVkIG5laXRoZXIsIHNvXG4gICAgICAvLyB0aGUgQ0xJIGNvdWxkIG5vdCB0ZWxsIHRoZSBjYWxsZXIgd2hhdCB3ZW50IHdyb25nIGV2ZW4gb25jZSBpdCBzdGFydGVkXG4gICAgICAvLyByZWFkaW5nIHRoZSB2ZXJkaWN0LiBCb3RoIGNhdXNlcyBub3cgY2FycnkgYW4gYGVycm9yYCAoYW4gZXhpc3RpbmcgZmllbGRcbiAgICAgIC8vIG9mIEFwcGx5UmVzdWx0IOKAlCBubyBuZXcgdm9jYWJ1bGFyeSksIGJlY2F1c2UgXCJ0aGUgcmVhc29uXCIgaXMgd2hhdCBtYWtlc1xuICAgICAgLy8gdGhlIHJlZnVzYWwgYWN0aW9uYWJsZSByYXRoZXIgdGhhbiBtZXJlbHkgbG91ZC5cbiAgICAgIGNvbnN0IHRhc2sgPSB2YWxpZGF0ZVRhc2sobXNnLnRhc2spO1xuICAgICAgaWYgKCF0YXNrKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgYXBwbGllZDogZmFsc2UsXG4gICAgICAgICAgZXJyb3I6IFwidGFzayByZWplY3RlZDogbmVlZHMgYSBzdHJpbmcgaWQsIGEgc3RyaW5nIHRpdGxlLCBhbmQgYSB2YWxpZCBzdGF0dXNcIixcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGlmICghYXBwbHlUYXNrQWRkKHN0YXRlLCB0YXNrKSkge1xuICAgICAgICAvLyBhcHBseVRhc2tBZGQgcmVmdXNlcyBhIGR1cGxpY2F0ZSBpZCBXSVRIT1VUIHRvdWNoaW5nIHN0YXRlIOKAlCBpdCBuZWl0aGVyXG4gICAgICAgIC8vIG92ZXJ3cml0ZXMgbm9yIGFwcGVuZHMg4oCUIHNvIHRoZSBleGlzdGluZyB0YXNrIGtlZXBzIHRoYXQgaWQgYW5kIGV2ZXJ5XG4gICAgICAgIC8vIGZpZWxkIG9mIGl0LiBUaGUgbWVzc2FnZSBzYXlzIHNvLCBiZWNhdXNlIHRoZSBjYWxsZXIncyBuZXh0IHF1ZXN0aW9uIGlzXG4gICAgICAgIC8vIFwiZGlkIEkganVzdCBjbG9iYmVyIHRoZSBvcmlnaW5hbD9cIiBhbmQgdGhlIGFuc3dlciBpcyBuby5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICBhcHBsaWVkOiBmYWxzZSxcbiAgICAgICAgICBlcnJvcjogYHRhc2sgJHt0YXNrLmlkfSBhbHJlYWR5IGV4aXN0cyDigJQgdGhlIGJvYXJkIGlzIHVuY2hhbmdlZCBhbmQgdGhlIGV4aXN0aW5nIHRhc2sga2VwdCBpdHMgaWRgLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgYnJvYWRjYXN0KHsgdHlwZTogXCJ0YXNrLmFkZFwiLCB0YXNrIH0pO1xuICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJ0YXNrLmFkZFwiLCB0YXNrLCBieSwgb3duZXI6IHRhc2sub3duZXIgfSk7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgYXBwbGllZDogdHJ1ZSB9O1xuICAgIH0gZWxzZSBpZiAobXNnLnR5cGUgPT09IFwidGFzay51cGRhdGVcIikge1xuICAgICAgLy8gQ29vcGVyYXRpdmUtY2xhaW0gZ3VhcmQ6IGEgY2xhaW0gY2FuJ3Qgc3RlYWwgYW4gYWxyZWFkeS1vd25lZCB0YXNrLiBUaGVcbiAgICAgIC8vIGxlYWQncyBgdXBkYXRlIC0tb3duZXJgIChubyBjbGFpbSBmbGFnKSBhbHdheXMgd2lucyDigJQgdGhhdCdzIHRoZVxuICAgICAgLy8gcmVhc3NpZ25tZW50IHBhdGguIENsYWltaW5nIGEgdGFzayB5b3UgYWxyZWFkeSBvd24gaXMgYSBuby1vcCBzdWNjZXNzLlxuICAgICAgaWYgKG1zZy5jbGFpbSkge1xuICAgICAgICBjb25zdCBleGlzdGluZyA9IHN0YXRlLnRhc2tzLmZpbmQoKHQpID0+IHQuaWQgPT09IG1zZy5pZCk7XG4gICAgICAgIGNvbnN0IGNsYWltYW50ID0gdHlwZW9mIG1zZy5hcyA9PT0gXCJzdHJpbmdcIiA/IG1zZy5hcyA6IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKGV4aXN0aW5nPy5vd25lciAmJiBleGlzdGluZy5vd25lciAhPT0gY2xhaW1hbnQpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgICBhcHBsaWVkOiBmYWxzZSxcbiAgICAgICAgICAgIGVycm9yOiBgdGFzayAke21zZy5pZH0gaXMgb3duZWQgYnkgJHtleGlzdGluZy5vd25lcn1gLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIC8vIGBibG9ja2VkQnlgIGlzIG11dGF0ZWQgT05MWSB2aWEgdGFzay5ibG9jay90YXNrLnVuYmxvY2sgKHdoaWNoIHJ1biB0aGVcbiAgICAgIC8vIGN5Y2xlIGd1YXJkKS4gU3RyaXAgaXQgZnJvbSBhIHJhdyB1cGRhdGUgcGF0Y2ggc28gL2NtZCBjYW4ndCBzaWRlc3RlcFxuICAgICAgLy8gdGhlIGd1YXJkIOKAlCBrZWVwIHRoZSBndWFyZCBsb2FkLWJlYXJpbmcuXG4gICAgICBjb25zdCB7IGJsb2NrZWRCeTogX3N0cmlwcGVkLCAuLi5wYXRjaCB9ID0gbXNnLnBhdGNoO1xuICAgICAgLy8gU2FuaXRpemUgdGFncyBvbiB0aGUgd2F5IGluICgjMTgpIHNvIGEgcmF3IC9jbWQgY2FuJ3Qgc3RvcmUgYSBkaXJ0eVxuICAgICAgLy8gbGlzdC4gS2VlcCBhbiBlbXB0eSBhcnJheSAoaXQncyBhbiBleHBsaWNpdCBjbGVhciB2aWEgYC0tdGFnIFwiXCJgKSDigJQgYVxuICAgICAgLy8gbGF0ZXIgc25hcHNob3QvcmVzdG9yZSBub3JtYWxpemVzIFtdIGF3YXkgdGhyb3VnaCB2YWxpZGF0ZVRhc2suXG4gICAgICBpZiAoXCJ0YWdzXCIgaW4gcGF0Y2gpIHBhdGNoLnRhZ3MgPSBjbGVhblRhZ3MocGF0Y2gudGFncyk7XG4gICAgICAvLyBEcm9wIGEgbWFsZm9ybWVkIHNpemUvZXhwZWN0IGZyb20gYSByYXcgL2NtZCBwYXRjaCAoIzI5KSDigJQga2VlcCB0aGVcbiAgICAgIC8vIHNpemluZyBmaWVsZHMgY2Fub25pY2FsLCBtaXJyb3JpbmcgdmFsaWRhdGVUYXNrJ3MgbGVuaWVuY3kuXG4gICAgICBpZiAoXCJzaXplXCIgaW4gcGF0Y2ggJiYgISh0eXBlb2YgcGF0Y2guc2l6ZSA9PT0gXCJzdHJpbmdcIiAmJiBwYXRjaC5zaXplIGluIFNJWkVfTUlOVVRFUykpIHtcbiAgICAgICAgZGVsZXRlIHBhdGNoLnNpemU7XG4gICAgICB9XG4gICAgICBpZiAoXCJleHBlY3RcIiBpbiBwYXRjaCAmJiAhKHR5cGVvZiBwYXRjaC5leHBlY3QgPT09IFwibnVtYmVyXCIgJiYgcGF0Y2guZXhwZWN0ID4gMCkpIHtcbiAgICAgICAgZGVsZXRlIHBhdGNoLmV4cGVjdDtcbiAgICAgIH1cbiAgICAgIC8vIE5vLW9wIGd1YXJkICgjMjMpOiBhIHJlZHVuZGFudCBwYXRjaCAoZS5nLiBhIG1hZXN0cm8gcmUtaXNzdWluZ1xuICAgICAgLy8gZG9pbmctPmRvaW5nKSBtdXN0IG5vdCBicm9hZGNhc3Qgb3Igd2FrZSBzY29wZWQgdGFpbHMuIEV4ZW1wdCBhIGBjbGFpbWBcbiAgICAgIC8vIOKAlCByZS1jbGFpbWluZyBhIHRhc2sgeW91IGFscmVhZHkgb3duIGlzIGEgbm8tb3Agc3RhdGUtd2lzZSBidXQgc3RpbGxcbiAgICAgIC8vIHdhbnRzIGl0cyBhcHBsaWVkOnRydWUgY29uZmlybWF0aW9uLCB3aGljaCBjbGkudHMgYGNsYWltYCByZWFkcy5cbiAgICAgIGlmICghbXNnLmNsYWltICYmIGlzTm9PcFVwZGF0ZShzdGF0ZSwgbXNnLmlkLCBwYXRjaCkpIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFwcGxpZWQ6IGZhbHNlIH07XG4gICAgICB9XG4gICAgICBpZiAoYXBwbHlUYXNrVXBkYXRlKHN0YXRlLCBtc2cuaWQsIHBhdGNoKSkge1xuICAgICAgICBicm9hZGNhc3QoeyB0eXBlOiBcInRhc2sudXBkYXRlXCIsIGlkOiBtc2cuaWQsIHBhdGNoIH0pO1xuICAgICAgICAvLyBQb3N0LWNoYW5nZSBvd25lciA9IFwid2hvIG93bmVkIGl0IHdoZW4gdGhpcyBoYXBwZW5lZFwiIChvd25lci1hdC1lbWl0KS5cbiAgICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJ0YXNrLnVwZGF0ZVwiLCB0YXNrSWQ6IG1zZy5pZCwgcGF0Y2gsIGJ5LCBvd25lcjogb3duZXJPZihtc2cuaWQpIH0pO1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgYXBwbGllZDogdHJ1ZSB9O1xuICAgICAgfVxuICAgICAgLy8gYXBwbHlUYXNrVXBkYXRlIHJldHVybmVkIGZhbHNlIGhlcmUgPSB0aGUgdGFzayBkb2Vzbid0IGV4aXN0IChuby1vcHMgb25cbiAgICAgIC8vIGFuIGV4aXN0aW5nIHRhc2sgd2VyZSBhbHJlYWR5IGNhdWdodCBhYm92ZSB3aXRoIE5PIGVycm9yKS4gQ2FycnkgYW4gZXJyb3JcbiAgICAgIC8vIHNvIHRoZSBDTEkgY2FuIHRlbGwgYSBub3QtZm91bmQgLyBtaXMtcm91dGVkIHVwZGF0ZSAoYSB2aXNpYmxlIGZhaWx1cmUsXG4gICAgICAvLyAjNjIpIGFwYXJ0IGZyb20gYSBiZW5pZ24gbm8tb3AgKGJvdGggYXJlIGFwcGxpZWQ6ZmFsc2UsIGJ1dCBvbmx5IHRoaXMgb25lXG4gICAgICAvLyBpcyBhIHJlYWwgZmFpbHVyZSkuXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgYXBwbGllZDogZmFsc2UsIGVycm9yOiBgbm8gc3VjaCB0YXNrICR7bXNnLmlkfWAgfTtcbiAgICB9IGVsc2UgaWYgKG1zZy50eXBlID09PSBcInRhc2sucmVtb3ZlXCIpIHtcbiAgICAgIGNvbnN0IG93bmVyID0gb3duZXJPZihtc2cuaWQpOyAvLyBiZWZvcmUgcmVtb3ZhbFxuICAgICAgaWYgKGFwcGx5VGFza1JlbW92ZShzdGF0ZSwgbXNnLmlkKSkge1xuICAgICAgICBicm9hZGNhc3QoeyB0eXBlOiBcInRhc2sucmVtb3ZlXCIsIGlkOiBtc2cuaWQgfSk7XG4gICAgICAgIGVtaXRFdmVudCh7IHR5cGU6IFwidGFzay5yZW1vdmVcIiwgdGFza0lkOiBtc2cuaWQsIGJ5LCBvd25lciB9KTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFwcGxpZWQ6IHRydWUgfTtcbiAgICAgIH1cbiAgICAgIC8vIE5vdCBmb3VuZCAocmVtb3ZlIGhhcyBubyBuby1vcCBwYXRoKSDigJQgY2FycnkgYW4gZXJyb3Igc28gYSBtaXMtcm91dGVkXG4gICAgICAvLyByZW1vdmUgc3VyZmFjZXMgYXMgYSB2aXNpYmxlIGZhaWx1cmUgKCM2MiksIGxpa2UgdXBkYXRlIGFib3ZlLlxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFwcGxpZWQ6IGZhbHNlLCBlcnJvcjogYG5vIHN1Y2ggdGFzayAke21zZy5pZH1gIH07XG4gICAgfSBlbHNlIGlmIChtc2cudHlwZSA9PT0gXCJ0YXNrLmJsb2NrXCIpIHtcbiAgICAgIGNvbnN0IHRhc2sgPSBzdGF0ZS50YXNrcy5maW5kKCh0KSA9PiB0LmlkID09PSBtc2cuaWQpO1xuICAgICAgaWYgKCF0YXNrKSByZXR1cm4geyBvazogdHJ1ZSwgYXBwbGllZDogZmFsc2UsIGVycm9yOiBgbm8gc3VjaCB0YXNrICR7bXNnLmlkfWAgfTtcbiAgICAgIC8vIGIxMCDigJQgdGhlIFNVQkpFQ1QncyBleGlzdGVuY2Ugd2FzIGNoZWNrZWQgb25lIGxpbmUgdXA7IHRoZSBCTE9DS0VSUydcbiAgICAgIC8vIHdhcyBub3QuIFNvIGBibG9jayA8cmVhbD4gLS1vbiA8dHlwbz5gIHdhcyBhY2NlcHRlZCBhdCBvazp0cnVlIGFuZFxuICAgICAgLy8gY3JlYXRlZCBhbiBlZGdlIHRoYXQgY29uc3RyYWlucyBOT1RISU5HOiBpc0Jsb2NrZWQgYW5kIHRoZSAvc3RhdGVcbiAgICAgIC8vIGxpdmVCbG9ja2VycyBwcm9qZWN0aW9uIGJvdGggcmVxdWlyZSBhIGJsb2NrZXIgdG8gRVhJU1QsIHNvIGEgZGFuZ2xpbmdcbiAgICAgIC8vIGlkIGlzIGluZXJ0IGJ5IGRlc2lnbi4gVGhlIGVudmVsb3BlIGFuc3dlcmVkIHtcImJsb2NrZWRcIjpcIjxpZD5cIn0gd2hpbGVcbiAgICAgIC8vIC9zdGF0ZSBhbnN3ZXJlZCBibG9ja2VkOmZhbHNlIOKAlCBvbmUgY29tbWFuZCBzYXlpbmcgdHdvIHRoaW5ncy5cbiAgICAgIC8vXG4gICAgICAvLyDimqAgTm90ZSB0aGlzIGlzIHRoZSBJTlZFUlNFIG9mIGhvdyBpdCB3YXMgZmlyc3QgcmVwb3J0ZWQ6IHRoZSByaXNrIGlzXG4gICAgICAvLyBub3QgYSBibG9jayB0aGF0IG5ldmVyIHJlc29sdmVzLCBpdCBpcyBhIGd1YXJkIHRoZSBjYWxsZXIgYmVsaWV2ZXMgaXNcbiAgICAgIC8vIGluIHBsYWNlIGFuZCBpcyBub3QuIE1lYXN1cmVkIGJlZm9yZSBmaXhpbmcuXG4gICAgICAvL1xuICAgICAgLy8gUmVmdXNhbCByYXRoZXIgdGhhbiBhIHJlcG9ydCwgZm9yIHRoZSByZWFzb24gdGhlIGNhcmQgbmFtZXM6IGBhZGRgXG4gICAgICAvLyBSRUZVU0VTIGEgbWlzc2luZyB0aXRsZSB3aGlsZSB0aGlzIEFDQ0VQVEVEIGEgbWlzc2luZyByZWZlcmVudCDigJQgc2FtZVxuICAgICAgLy8gdG9vbCwgc2FtZSBtaW51dGUuIFRoaXMgcmVzdG9yZXMgdGhlIHVuaWZvcm1pdHksIGFuZCB0aGUgdHJhdmVyc2FsIHRoYXRcbiAgICAgIC8vIGZpbmRzIHRoZSByZWZlcmVudCB3YXMgYWxyZWFkeSBiZWluZyBkb25lIGJ5IGNhblJlYWNoIGJlbG93LlxuICAgICAgY29uc3QgdW5rbm93biA9IG1zZy5vbi5maWx0ZXIoKGIpID0+ICFzdGF0ZS50YXNrcy5zb21lKCh0KSA9PiB0LmlkID09PSBiKSk7XG4gICAgICBpZiAodW5rbm93bi5sZW5ndGgpXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgYXBwbGllZDogZmFsc2UsXG4gICAgICAgICAgZXJyb3I6XG4gICAgICAgICAgICBgbm8gc3VjaCB0YXNrJHt1bmtub3duLmxlbmd0aCA+IDEgPyBcInNcIiA6IFwiXCJ9ICR7dW5rbm93bi5qb2luKFwiLCBcIil9IOKAlCBgICtcbiAgICAgICAgICAgIGBub3RoaW5nIHdhcyBibG9ja2VkIChhIGJsb2NrZXIgdGhhdCBkb2VzIG5vdCBleGlzdCB3b3VsZCBjb25zdHJhaW4gbm90aGluZylgLFxuICAgICAgICB9O1xuICAgICAgLy8gQ3ljbGUvc2VsZi1yZWYgZ3VhcmQ6IHJlamVjdCB0aGUgV0hPTEUgY29tbWFuZCBpZiBhbnkgcHJvcG9zZWQgZWRnZVxuICAgICAgLy8gd291bGQgY2xvc2UgYSBsb29wLiBOZXcgZWRnZXMgYWxsIG9yaWdpbmF0ZSBhdCBgaWRgIChvdXQtZWRnZXMpLCBzbyBhXG4gICAgICAvLyBiYWNrLXBhdGggY2FuIG9ubHkgcnVuIHRocm91Z2ggZXhpc3RpbmcgZWRnZXMg4oCUIGEgcGVyLWVkZ2UgY2FuUmVhY2hcbiAgICAgIC8vIGFnYWluc3QgdGhlIGN1cnJlbnQgZ3JhcGggaXMgc3VmZmljaWVudC5cbiAgICAgIGZvciAoY29uc3QgYiBvZiBtc2cub24pIHtcbiAgICAgICAgaWYgKGNhblJlYWNoKGIsIG1zZy5pZCkpIHtcbiAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgYXBwbGllZDogZmFsc2UsIGVycm9yOiBgd291bGQgY3JlYXRlIGEgY3ljbGU6ICR7bXNnLmlkfSDihpIgJHtifWAgfTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgY29uc3QgbmV4dCA9IEFycmF5LmZyb20obmV3IFNldChbLi4uKHRhc2suYmxvY2tlZEJ5ID8/IFtdKSwgLi4ubXNnLm9uXSkpO1xuICAgICAgYXBwbHlUYXNrVXBkYXRlKHN0YXRlLCBtc2cuaWQsIHsgYmxvY2tlZEJ5OiBuZXh0IH0pO1xuICAgICAgYnJvYWRjYXN0KHsgdHlwZTogXCJ0YXNrLnVwZGF0ZVwiLCBpZDogbXNnLmlkLCBwYXRjaDogeyBibG9ja2VkQnk6IG5leHQgfSB9KTtcbiAgICAgIGVtaXRFdmVudCh7XG4gICAgICAgIHR5cGU6IFwidGFzay51cGRhdGVcIixcbiAgICAgICAgdGFza0lkOiBtc2cuaWQsXG4gICAgICAgIHBhdGNoOiB7IGJsb2NrZWRCeTogbmV4dCB9LFxuICAgICAgICBieSxcbiAgICAgICAgb3duZXI6IHRhc2sub3duZXIsXG4gICAgICB9KTtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhcHBsaWVkOiB0cnVlIH07XG4gICAgfSBlbHNlIGlmIChtc2cudHlwZSA9PT0gXCJ0YXNrLnVuYmxvY2tcIikge1xuICAgICAgY29uc3QgdGFzayA9IHN0YXRlLnRhc2tzLmZpbmQoKHQpID0+IHQuaWQgPT09IG1zZy5pZCk7XG4gICAgICBpZiAoIXRhc2spIHJldHVybiB7IG9rOiB0cnVlLCBhcHBsaWVkOiBmYWxzZSwgZXJyb3I6IGBubyBzdWNoIHRhc2sgJHttc2cuaWR9YCB9O1xuICAgICAgY29uc3QgbmV4dCA9ICh0YXNrLmJsb2NrZWRCeSA/PyBbXSkuZmlsdGVyKChiKSA9PiAhbXNnLm9uLmluY2x1ZGVzKGIpKTtcbiAgICAgIGFwcGx5VGFza1VwZGF0ZShzdGF0ZSwgbXNnLmlkLCB7IGJsb2NrZWRCeTogbmV4dCB9KTtcbiAgICAgIGJyb2FkY2FzdCh7IHR5cGU6IFwidGFzay51cGRhdGVcIiwgaWQ6IG1zZy5pZCwgcGF0Y2g6IHsgYmxvY2tlZEJ5OiBuZXh0IH0gfSk7XG4gICAgICBlbWl0RXZlbnQoe1xuICAgICAgICB0eXBlOiBcInRhc2sudXBkYXRlXCIsXG4gICAgICAgIHRhc2tJZDogbXNnLmlkLFxuICAgICAgICBwYXRjaDogeyBibG9ja2VkQnk6IG5leHQgfSxcbiAgICAgICAgYnksXG4gICAgICAgIG93bmVyOiB0YXNrLm93bmVyLFxuICAgICAgfSk7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgYXBwbGllZDogdHJ1ZSB9O1xuICAgIH0gZWxzZSBpZiAobXNnLnR5cGUgPT09IFwibWVzc2FnZVwiKSB7XG4gICAgICBicm9hZGNhc3QoeyB0eXBlOiBcIm1lc3NhZ2VcIiwgdGV4dDogbXNnLnRleHQgfSk7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgYXBwbGllZDogdHJ1ZSB9O1xuICAgIH0gZWxzZSBpZiAobXNnLnR5cGUgPT09IFwiY2xvc2VcIikge1xuICAgICAgcmVzb2x2ZURvbmUoeyBjb2RlOiAwLCByZWFzb246IFwiY2xvc2VcIiB9KTtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhcHBsaWVkOiB0cnVlIH07XG4gICAgfVxuICAgIHJldHVybiB7IG9rOiB0cnVlLCBhcHBsaWVkOiBmYWxzZSB9O1xuICB9XG5cbiAgbGV0IHNlcnZlcjogUmV0dXJuVHlwZTx0eXBlb2YgQnVuLnNlcnZlPjtcbiAgdHJ5IHtcbiAgICBzZXJ2ZXIgPSBCdW4uc2VydmUoe1xuICAgICAgcG9ydCxcbiAgICAgIGhvc3RuYW1lOiBob3N0LFxuICAgICAgLy8gZGV2OiB0aGUgSFRNTEJ1bmRsZSBhdCBcIi9cIiAoQnVuIHNlcnZlcyBpdHMgYXNzZXRzIGl0c2VsZikuXG4gICAgICAvLyByZWxlYXNlOiBubyByb3V0ZXMg4oCUIHRoZSBmZXRjaCBoYW5kbGVyIHNlcnZlcyBkaXN0Ly4gQnVuJ3MgUm91dGVzIHR5cGVcbiAgICAgIC8vIHRpZXMgdGhlIHZhbHVlJ3MgdHlwZSB0byB0aGUgbGl0ZXJhbCBvYmplY3Qgc2hhcGUsIHNvIHRoZSBtb2RlLXRlcm5hcnlcbiAgICAgIC8vIHVuaW9uIGlzIGNhc3Q7IHRoZSBydW50aW1lIGJlaGF2aW91ciBpcyBjb3JyZWN0IGVpdGhlciB3YXkuXG4gICAgICByb3V0ZXMsXG4gICAgICBkZXZlbG9wbWVudDogeyBobXI6IG1vZGUgPT09IFwiZGV2XCIgfSxcbiAgICAgIC8vIFAxZSAocmUtc2NvcGVkIGZyb20gIzY0KS4gQnVuJ3MgZGVmYXVsdCByZXF1ZXN0IGlkbGVUaW1lb3V0IGlzIDEwcywgYW5kXG4gICAgICAvLyB0aGUgU1NFIGhlYXJ0YmVhdCBiZWxvdyBmaXJlcyBldmVyeSAxNXMg4oCUIHNvIG9uIGFuIE9USEVSV0lTRS1JRExFXG4gICAgICAvLyBjb25uZWN0aW9uIHRoZSBoZWFydGJlYXQgY2Fubm90IGZpcmUsIGJlY2F1c2UgdGhlIGNvbm5lY3Rpb24gaXMgc2V2ZXJlZFxuICAgICAgLy8gZml2ZSBzZWNvbmRzIGJlZm9yZSBpdCBpcyBkdWUuIEFuIGFnZW50IGB0YWlsYCBvbiBhIHF1aWV0IGJvYXJkIGlzXG4gICAgICAvLyBleGFjdGx5IHRoYXQgY29ubmVjdGlvbi5cbiAgICAgIC8vXG4gICAgICAvLyAyNTUgaXMgQnVuJ3MgY2xhbXBlZCBtYXhpbXVtLiBEbyBOT1QgdXNlIDAgdG8gbWVhbiBcImRpc2FibGVkXCI6IG1lYXN1cmVkXG4gICAgICAvLyBpbiBtaW5kLW1hcHBlciwgMCBzdGFsbHMgdGhlIGluaXRpYWwgcmVzcG9uc2UgcmF0aGVyIHRoYW4gZGlzYWJsaW5nIHRoZVxuICAgICAgLy8gdGltZW91dC5cbiAgICAgIC8vXG4gICAgICAvLyDimqAgVEhFIENMQUlNIFNISVBTIEJPVU5ERUQuIFRoaXMgaXMgQ09OU0lTVEVOVCBXSVRIICM2NCdzIHJlcG9ydGVyIGNsdWVcbiAgICAgIC8vIChyZWFkLWhlYXZ5IGRpZXMgLyB3cml0ZS1oZWF2eSBzdXJ2aXZlcyDigJQgdHJhZmZpYyByZXNldHMgdGhlIGlkbGUgdGltZXIsXG4gICAgICAvLyBzbyB0aGUgMTBzIGN1dCBpcyBub3QgdW5jb25kaXRpb25hbCkgYW5kIGl0IGlzIFVOVEVTVEVEIEFHQUlOU1QgaXQuIEl0XG4gICAgICAvLyBkb2VzIG5vdCBcImV4cGxhaW5cIiB0aG9zZSBkZWF0aHM6IHRoZSByZXBvcnRlciB3YXMgYW4gYWdlbnQgYW5kIGNhbm5vdCBiZVxuICAgICAgLy8gYXNrZWQsIHRoZSBpbnN0cnVtZW50IHBvc3QtZGF0ZXMgdGhlIHJlcG9ydCwgYW5kIG9wZW4gcXVlc3Rpb24gNiBpc1xuICAgICAgLy8gcGVybWFuZW50bHkgdW5hbnN3ZXJhYmxlLiBBIGhlYXJ0YmVhdCB0aGF0IGNhbiBub3cgZmlyZSBpcyB0aGUgZml4OyB0aGVcbiAgICAgIC8vIHJlcG9ydGVkIGRlYXRocyByZW1haW4gdW5kaWFnbm9zZWQuXG4gICAgICBpZGxlVGltZW91dDogMjU1LFxuICAgICAgZmV0Y2g6IChyZXEsIHNydikgPT4ge1xuICAgICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwpO1xuICAgICAgICBjb25zdCBwYXRoID0gdXJsLnBhdGhuYW1lO1xuICAgICAgICBpZiAocGF0aCA9PT0gXCIvd3NcIikge1xuICAgICAgICAgIGNvbnN0IHVwZ3JhZGVkID0gc3J2LnVwZ3JhZGUocmVxKTtcbiAgICAgICAgICBpZiAodXBncmFkZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShcInVwZ3JhZGUgcmVxdWlyZWRcIiwgeyBzdGF0dXM6IDQyNiB9KTtcbiAgICAgICAgfVxuICAgICAgICAvLyBBZ2VudCByZWFkLWJhY2s6IGN1cnJlbnQgYm9hcmQgc3RhdGUgKyB0aGUgcmVzdW1lIGN1cnNvci4gYD9sZWFuPTFgXG4gICAgICAgIC8vIGlzIHRoZSBkZWZhdWx0IHRoZSBDTEkgdXNlczsgQm91bnR5IGhhcyBubyBsYXJnZSBibG9icyBzbyBsZWFuIOKJiCBmdWxsXG4gICAgICAgIC8vIHRvZGF5IOKAlCB0aGUgc2hhcGUgaXMga2VwdCBmb3IgaG91c2UgY29uc2lzdGVuY3kgKyBmb3J3YXJkLWNvbXBhdC5cbiAgICAgICAgLy8gdG91Y2goKSBzbyBhZ2VudCByZWFkcyBjb3VudCBhcyBhY3Rpdml0eSAoaWRsZS10b3VjaCwgIzYpLlxuICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9zdGF0ZVwiKSB7XG4gICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICAvLyBgc25hcHNob3RCYWNrZWRVcGAgaXMgc3ByZWFkIEFUIFRIRSBIQU5ETEVSLCBiZXNpZGUgY3Vyc29yIOKAlCBpdCBpcyBhXG4gICAgICAgICAgLy8gZGFlbW9uLWxldmVsIGZhY3QgYWJvdXQgdGhpcyBwcm9jZXNzLCBub3QgYm9hcmQgc3RhdGUsIHNvIGl0IGRvZXNcbiAgICAgICAgICAvLyBub3QgYmVsb25nIGluc2lkZSBwcm9qZWN0U3RhdGUoKS4gQWx3YXlzIHByZXNlbnQ7IG51bGwgbWVhbnMgXCJub1xuICAgICAgICAgIC8vIHJvdGF0aW9uIGhhcyBoYXBwZW5lZCBpbiB0aGlzIGRhZW1vbidzIGxpZmVcIiwgd2hpY2ggaXMgYSByZWFkYWJsZVxuICAgICAgICAgIC8vIGJsYW5rIHJhdGhlciB0aGFuIGFuIGFic2VuY2UgKEQxLjIpLlxuICAgICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoXG4gICAgICAgICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgIHN0YXRlOiBwcm9qZWN0U3RhdGUoKSxcbiAgICAgICAgICAgICAgY3Vyc29yOiBldmVudFNlcSxcbiAgICAgICAgICAgICAgc25hcHNob3RCYWNrZWRVcCxcbiAgICAgICAgICAgICAgLy8gYjE1IOKAlCBhbHNvIHJlYWRhYmxlIGhlcmU6IGEgYm9vdCBsaW5lIGlzIG1pc3NhYmxlIGFuZCB0aGlzIGZhY3RcbiAgICAgICAgICAgICAgLy8gb3V0bGl2ZXMgaXQuXG4gICAgICAgICAgICAgIHJlc3RvcmVGYWlsZWQsXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICAgIHsgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9IH0sXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBBZ2VudCBsaXZlIHRhaWw6IFNTRSBzdHJlYW0gb2YgdGhlIGV2ZW50IGxvZywgcmVzdW1hYmxlIHZpYSA/c2luY2U9LlxuICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9ldmVudHNcIikge1xuICAgICAgICAgIHJldHVybiBzc2VSZXNwb25zZSh1cmwpO1xuICAgICAgICB9XG4gICAgICAgIC8vIEFnZW50IHdyaXRlIHBhdGg6IGRpc3BhdGNoIGEgc2luZ2xlIEFnZW50Q29tbWFuZCBpbnRvIHRoZSBjYW5vbmljYWxcbiAgICAgICAgLy8gc3RhdGUuIFJlcGxhY2VzIHRoZSBzdGRpbiBKU09OLWxpbmVzIHJlYWRlciAocmV0aXJlZCBhdCB0aGUgcGFyaXR5XG4gICAgICAgIC8vIGdhdGUpLiB0b3VjaCgpIHNvIHdyaXRlcyBjb3VudCBhcyBhY3Rpdml0eSAoaWRsZS10b3VjaCwgIzYpLlxuICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJQT1NUXCIgJiYgcGF0aCA9PT0gXCIvY21kXCIpIHtcbiAgICAgICAgICByZXR1cm4gcmVxXG4gICAgICAgICAgICAuanNvbigpXG4gICAgICAgICAgICAudGhlbigoYm9keSkgPT4ge1xuICAgICAgICAgICAgICB0b3VjaCgpO1xuICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBoYW5kbGVBZ2VudE1zZyhib2R5IGFzIEFnZW50TXNnKTtcbiAgICAgICAgICAgICAgcmVjb25jaWxlQmxvY2tlZCgpOyAvLyBmaXJlIGB1bmJsb2NrZWRgIGZvciBhbnkgYmxvY2tlZOKGknVuYmxvY2tlZCB0cmFuc2l0aW9uXG4gICAgICAgICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoSlNPTi5zdHJpbmdpZnkocmVzdWx0KSwge1xuICAgICAgICAgICAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgLmNhdGNoKFxuICAgICAgICAgICAgICAoKSA9PlxuICAgICAgICAgICAgICAgIG5ldyBSZXNwb25zZSgne1wiZXJyb3JcIjpcImJhZCBqc29uXCJ9Jywge1xuICAgICAgICAgICAgICAgICAgc3RhdHVzOiA0MDAsXG4gICAgICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGguc3RhcnRzV2l0aChcIi9hc3NldHMvXCIpKSB7XG4gICAgICAgICAgY29uc3QgYXNzZXROYW1lID0gZGVjb2RlVVJJQ29tcG9uZW50KHBhdGguc2xpY2UoXCIvYXNzZXRzL1wiLmxlbmd0aCkpO1xuICAgICAgICAgIC8vIFBhdGgtdHJhdmVyc2FsIGd1YXJkOiByZWplY3QgYW55IFwiLi5cIiBzZWdtZW50IG9yIGFic29sdXRlIHBhdGguXG4gICAgICAgICAgaWYgKGFzc2V0TmFtZS5pbmNsdWRlcyhcIi4uXCIpIHx8IGFzc2V0TmFtZS5zdGFydHNXaXRoKFwiL1wiKSkge1xuICAgICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZSgne1wiZXJyb3JcIjpcIm5vdCBmb3VuZFwifScsIHtcbiAgICAgICAgICAgICAgc3RhdHVzOiA0MDQsXG4gICAgICAgICAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCBmID0gQnVuLmZpbGUoam9pbihhc3NldHNEaXIsIGFzc2V0TmFtZSkpO1xuICAgICAgICAgIHJldHVybiBmLmV4aXN0cygpLnRoZW4oKGV4aXN0cykgPT5cbiAgICAgICAgICAgIGV4aXN0c1xuICAgICAgICAgICAgICA/IG5ldyBSZXNwb25zZShmLCB7IGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogZ3Vlc3NNaW1lKGFzc2V0TmFtZSkgfSB9KVxuICAgICAgICAgICAgICA6IG5ldyBSZXNwb25zZSgne1wiZXJyb3JcIjpcIm5vdCBmb3VuZFwifScsIHtcbiAgICAgICAgICAgICAgICAgIHN0YXR1czogNDA0LFxuICAgICAgICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gUmVsZWFzZSBvbmx5OiBcIi9cIiBhbmQgdGhlIHN1cmZhY2UncyBoYXNoZWQgY2h1bmtzLCB3aGljaCB0aGUgYnVpbHRcbiAgICAgICAgLy8gaW5kZXguaHRtbCBsaW5rcyByZWxhdGl2ZWx5IGFuZCB3aGljaCB0aGVyZWZvcmUgYXJyaXZlIGFzIGJhcmVcbiAgICAgICAgLy8gZmlsZW5hbWVzIGF0IHRoZSByb290LiBEZXYgbmV2ZXIgc2VydmVzIGZyb20gZGlzdC8g4oCUIGEgY2hlY2tvdXQgY2FuXG4gICAgICAgIC8vIGNhcnJ5IGEgY29tbWl0dGVkIGRpc3QvIHRoYXQgaXMgc3RhbGUgYWdhaW5zdCBpdHMgc291cmNlLCBhbmQgaW4gZGV2XG4gICAgICAgIC8vIEJ1bidzIHJvdXRlciBvd25zIHRoZSBidW5kbGUncyBhc3NldHMuXG4gICAgICAgIGlmIChtb2RlID09PSBcInJlbGVhc2VcIiAmJiByZXEubWV0aG9kID09PSBcIkdFVFwiKSB7XG4gICAgICAgICAgY29uc3Qgc2VydmVkID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICAgIGlmIChzZXJ2ZWQpIHJldHVybiBzZXJ2ZWQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZSgne1wiZXJyb3JcIjpcIm5vdCBmb3VuZFwifScsIHtcbiAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgIH0pO1xuICAgICAgfSxcbiAgICAgIHdlYnNvY2tldDoge1xuICAgICAgICBvcGVuKHdzKSB7XG4gICAgICAgICAgc29ja2V0cy5hZGQod3MpO1xuICAgICAgICAgIHRvdWNoKCk7XG4gICAgICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJjb25uZWN0ZWRcIiwgYnk6IFwidXNlclwiIH0pO1xuICAgICAgICAgIC8vIGIxNiDigJQgQ0hBTk5FTCBQQVJJVFkuIGByZXN0b3JlRmFpbGVkYCByZWFjaGVkIHRoZSBhZ2VudCAodGhlIGBvcGVuYFxuICAgICAgICAgIC8vIGRpc2NvdmVyeSBwYXlsb2FkIGFuZCBHRVQgL3N0YXRlKSBhbmQgTk9UIHRoZSBodW1hbiwgd2hvc2Ugb25seVxuICAgICAgICAgIC8vIGNoYW5uZWwgaXMgdGhpcyBzb2NrZXQuIFNvIHRoZSBib2FyZCBjYW1lIHVwIGVtcHR5IGFuZCB0aGUgcGVyc29uXG4gICAgICAgICAgLy8gbG9va2luZyBhdCBpdCBoYWQgbm8gd2F5IHRvIHRlbGwgXCJ0aGUgcmVzdG9yZSBicm9rZVwiIGZyb20gXCJ0aGVyZSBpc1xuICAgICAgICAgIC8vIG5vdGhpbmcgaGVyZVwiIOKAlCB0aGUgZXhhY3QgZGlzdGluY3Rpb24gYjE1IHdhcyBidWlsdCB0byBtYWtlLCBtaXNzaW5nXG4gICAgICAgICAgLy8gb24gdGhlIG9uZSBjaGFubmVsIHRoYXQgcmVuZGVycyBpdCB0byBhIGh1bWFuLlxuICAgICAgICAgIC8vXG4gICAgICAgICAgLy8gUmlkZXMgYGluaXRgIHJhdGhlciB0aGFuIGEgbmV3IG1lc3NhZ2UgdHlwZSBiZWNhdXNlIGl0IGlzIGEgYm9vdFxuICAgICAgICAgIC8vIGZhY3QsIGFuZCBgaW5pdGAgaXMgdGhlIG9ubHkgZnJhbWUgdGhhdCBjYXJyaWVzIGJvb3QgZmFjdHMuIFNlbnQgb25cbiAgICAgICAgICAvLyBFVkVSWSBjb25uZWN0LCBub3QganVzdCB0aGUgZmlyc3Q6IGEgcmVsb2FkIG9yIHJlY29ubmVjdCBtdXN0IG5vdCBiZVxuICAgICAgICAgIC8vIHRoZSB0aGluZyB0aGF0IGxvc2VzIHRoZSB3YXJuaW5nLlxuICAgICAgICAgIHdzLnNlbmQoXG4gICAgICAgICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgIHR5cGU6IFwiaW5pdFwiLFxuICAgICAgICAgICAgICB0aXRsZTogc3RhdGUudGl0bGUsXG4gICAgICAgICAgICAgIHRhc2tzOiBzdGF0ZS50YXNrcyxcbiAgICAgICAgICAgICAgcmVzdG9yZUZhaWxlZCxcbiAgICAgICAgICAgICAgc2Vzc2lvbklkLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgKTtcbiAgICAgICAgfSxcbiAgICAgICAgbWVzc2FnZShfd3MsIHJhdykge1xuICAgICAgICAgIHRvdWNoKCk7XG4gICAgICAgICAgbGV0IG1zZzogQnJvd3Nlck1zZztcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgbXNnID0gSlNPTi5wYXJzZShcbiAgICAgICAgICAgICAgdHlwZW9mIHJhdyA9PT0gXCJzdHJpbmdcIiA/IHJhdyA6IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyYXcpLFxuICAgICAgICAgICAgKSBhcyBCcm93c2VyTXNnO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgICBgYm91bnR5OiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmAsXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAobXNnLnR5cGUgPT09IFwidGFzay50b2dnbGVcIikge1xuICAgICAgICAgICAgaWYgKCFWQUxJRF9TVEFUVVMuaW5jbHVkZXMobXNnLnN0YXR1cykpIHJldHVybjtcbiAgICAgICAgICAgIC8vIE5vLW9wIGd1YXJkICgjMjMpOiBhIHJlZHVuZGFudCBwaWxsIGNsaWNrIChkb2luZy0+ZG9pbmcpIHNraXBzLlxuICAgICAgICAgICAgaWYgKGlzTm9PcFVwZGF0ZShzdGF0ZSwgbXNnLmlkLCB7IHN0YXR1czogbXNnLnN0YXR1cyB9KSkgcmV0dXJuO1xuICAgICAgICAgICAgaWYgKGFwcGx5VGFza1VwZGF0ZShzdGF0ZSwgbXNnLmlkLCB7IHN0YXR1czogbXNnLnN0YXR1cyB9KSkge1xuICAgICAgICAgICAgICBicm9hZGNhc3QoeyB0eXBlOiBcInRhc2sudXBkYXRlXCIsIGlkOiBtc2cuaWQsIHBhdGNoOiB7IHN0YXR1czogbXNnLnN0YXR1cyB9IH0pO1xuICAgICAgICAgICAgICBlbWl0RXZlbnQoe1xuICAgICAgICAgICAgICAgIHR5cGU6IFwidGFzay50b2dnbGVcIixcbiAgICAgICAgICAgICAgICB0YXNrSWQ6IG1zZy5pZCxcbiAgICAgICAgICAgICAgICBzdGF0dXM6IG1zZy5zdGF0dXMsXG4gICAgICAgICAgICAgICAgYnk6IFwidXNlclwiLFxuICAgICAgICAgICAgICAgIG93bmVyOiBvd25lck9mKG1zZy5pZCksXG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSBpZiAobXNnLnR5cGUgPT09IFwidGFzay5tb3ZlXCIpIHtcbiAgICAgICAgICAgIGlmICghVkFMSURfU1RBVFVTLmluY2x1ZGVzKG1zZy5zdGF0dXMpKSByZXR1cm47XG4gICAgICAgICAgICAvLyBOby1vcCBndWFyZCAoIzIzKTogYSBkcmFnIGRyb3BwZWQgYmFjayBvbiB0aGUgY2FyZCdzIG93biBzbG90XG4gICAgICAgICAgICAvLyAoc2FtZSBjb2x1bW4gbWVtYmVyc2hpcCArIG9yZGVyKSBza2lwcyB0aGUgYnJvYWRjYXN0ICsgZXZlbnQuXG4gICAgICAgICAgICBpZiAoaXNOb09wTW92ZShzdGF0ZSwgbXNnLmlkLCBtc2cuc3RhdHVzLCBtc2cuaW5kZXgpKSByZXR1cm47XG4gICAgICAgICAgICBpZiAoYXBwbHlUYXNrTW92ZShzdGF0ZSwgbXNnLmlkLCBtc2cuc3RhdHVzLCBtc2cuaW5kZXgpICE9PSAtMSkge1xuICAgICAgICAgICAgICAvLyBCcm9hZGNhc3QgdGhlIGZ1bGwgb3JkZXJlZCBsaXN0IOKAlCBzaW1wbGVyIHRoYW4gZGlmZmluZyBmb3JcbiAgICAgICAgICAgICAgLy8gYnJvd3NlcnMsIGFuZCBpdCBjb3ZlcnMgdGhlIHNvdXJjZS1jb2x1bW4gc2hpZnQgY29ycmVjdGx5LlxuICAgICAgICAgICAgICBicm9hZGNhc3Qoe1xuICAgICAgICAgICAgICAgIHR5cGU6IFwiaW5pdFwiLFxuICAgICAgICAgICAgICAgIHRpdGxlOiBzdGF0ZS50aXRsZSxcbiAgICAgICAgICAgICAgICB0YXNrczogc3RhdGUudGFza3MsXG4gICAgICAgICAgICAgICAgcmVzdG9yZUZhaWxlZCxcbiAgICAgICAgICAgICAgICBzZXNzaW9uSWQsXG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICBlbWl0RXZlbnQoe1xuICAgICAgICAgICAgICAgIHR5cGU6IFwidGFzay5tb3ZlXCIsXG4gICAgICAgICAgICAgICAgdGFza0lkOiBtc2cuaWQsXG4gICAgICAgICAgICAgICAgc3RhdHVzOiBtc2cuc3RhdHVzLFxuICAgICAgICAgICAgICAgIGluZGV4OiBtc2cuaW5kZXgsXG4gICAgICAgICAgICAgICAgYnk6IFwidXNlclwiLFxuICAgICAgICAgICAgICAgIG93bmVyOiBvd25lck9mKG1zZy5pZCksXG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSBpZiAobXNnLnR5cGUgPT09IFwidGFzay5lZGl0XCIpIHtcbiAgICAgICAgICAgIC8vIE9uZSB2ZXJiIGNvdmVycyBib3RoIHRoZSBpbmxpbmUgdGl0bGUgZWRpdCBhbmQgdGhlIGRldGFpbCBtb2RhbCdzXG4gICAgICAgICAgICAvLyBkZXNjcmlwdGlvbiBlZGl0ICgjMTkpOiB7aWQsIHRpdGxlPywgbm90ZXM/fS4gUmUtc2FuaXRpemUgZWFjaFxuICAgICAgICAgICAgLy8gZmllbGQg4oCUIGEgbWFsZm9ybWVkIGVkaXQgbXVzdCBub3QgY29ycnVwdCBjYW5vbmljYWwgc3RhdGU6XG4gICAgICAgICAgICAvLyAgIHRpdGxlIOKAlCBpZiBwcmVzZW50LCBhIG5vbi1lbXB0eSB0cmltbWVkIHN0cmluZyAoZW1wdHkgdGl0bGVzXG4gICAgICAgICAgICAvLyAgICAgc3VyZmFjZSB0byB0aGUgYWdlbnQgYXMgdW5yZWFkYWJsZSBsYWJlbHMpO1xuICAgICAgICAgICAgLy8gICBub3RlcyDigJQgaWYgcHJlc2VudCwgYSBzdHJpbmcgKGVtcHR5IElTIGFsbG93ZWQg4oCUIGl0IGNsZWFycyB0aGVcbiAgICAgICAgICAgIC8vICAgICBkZXNjcmlwdGlvbikuIEJvdGggcmVuZGVyIHZpYSB4LXRleHQsIG5ldmVyIHgtaHRtbC5cbiAgICAgICAgICAgIGNvbnN0IHBhdGNoOiBQYXJ0aWFsPFRhc2s+ID0ge307XG4gICAgICAgICAgICBpZiAobXNnLnRpdGxlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiBtc2cudGl0bGUgIT09IFwic3RyaW5nXCIgfHwgbXNnLnRpdGxlLnRyaW0oKSA9PT0gXCJcIikgcmV0dXJuO1xuICAgICAgICAgICAgICBwYXRjaC50aXRsZSA9IG1zZy50aXRsZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChtc2cubm90ZXMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICBpZiAodHlwZW9mIG1zZy5ub3RlcyAhPT0gXCJzdHJpbmdcIikgcmV0dXJuO1xuICAgICAgICAgICAgICBwYXRjaC5ub3RlcyA9IG1zZy5ub3RlcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChPYmplY3Qua2V5cyhwYXRjaCkubGVuZ3RoID09PSAwKSByZXR1cm47IC8vIG5vdGhpbmcgdG8gZWRpdFxuICAgICAgICAgICAgaWYgKGFwcGx5VGFza1VwZGF0ZShzdGF0ZSwgbXNnLmlkLCBwYXRjaCkpIHtcbiAgICAgICAgICAgICAgYnJvYWRjYXN0KHsgdHlwZTogXCJ0YXNrLnVwZGF0ZVwiLCBpZDogbXNnLmlkLCBwYXRjaCB9KTtcbiAgICAgICAgICAgICAgZW1pdEV2ZW50KHtcbiAgICAgICAgICAgICAgICB0eXBlOiBcInRhc2suZWRpdFwiLFxuICAgICAgICAgICAgICAgIHRhc2tJZDogbXNnLmlkLFxuICAgICAgICAgICAgICAgIC4uLnBhdGNoLFxuICAgICAgICAgICAgICAgIGJ5OiBcInVzZXJcIixcbiAgICAgICAgICAgICAgICBvd25lcjogb3duZXJPZihtc2cuaWQpLFxuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2UgaWYgKG1zZy50eXBlID09PSBcInRhc2suYWRkXCIpIHtcbiAgICAgICAgICAgIC8vIFNoYXBlLXZhbGlkYXRlIHRoZSB1bnRydXN0ZWQgYnJvd3NlciB0YXNrIHZpYSB0aGUgc2hhcmVkIGJvdW5kYXJ5LlxuICAgICAgICAgICAgY29uc3QgdGFzayA9IHZhbGlkYXRlVGFzayhtc2cudGFzayk7XG4gICAgICAgICAgICBpZiAodGFzayAmJiBhcHBseVRhc2tBZGQoc3RhdGUsIHRhc2spKSB7XG4gICAgICAgICAgICAgIGJyb2FkY2FzdCh7IHR5cGU6IFwidGFzay5hZGRcIiwgdGFzayB9KTtcbiAgICAgICAgICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJ0YXNrLmFkZFwiLCB0YXNrLCBieTogXCJ1c2VyXCIsIG93bmVyOiB0YXNrLm93bmVyIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSBpZiAobXNnLnR5cGUgPT09IFwidGFzay5yZW1vdmVcIikge1xuICAgICAgICAgICAgY29uc3Qgb3duZXIgPSBvd25lck9mKG1zZy5pZCk7IC8vIGJlZm9yZSByZW1vdmFsXG4gICAgICAgICAgICBpZiAoYXBwbHlUYXNrUmVtb3ZlKHN0YXRlLCBtc2cuaWQpKSB7XG4gICAgICAgICAgICAgIGJyb2FkY2FzdCh7IHR5cGU6IFwidGFzay5yZW1vdmVcIiwgaWQ6IG1zZy5pZCB9KTtcbiAgICAgICAgICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJ0YXNrLnJlbW92ZVwiLCB0YXNrSWQ6IG1zZy5pZCwgYnk6IFwidXNlclwiLCBvd25lciB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2UgaWYgKG1zZy50eXBlID09PSBcImNsb3NlXCIpIHtcbiAgICAgICAgICAgIC8vIFRoZSBodW1hbiBkaXNtaXNzZXMgdGhlIGJvYXJkIChcIkNsb3NlIGJvYXJkXCIpLiBBIGNsZWFuIGRpc21pc3Mg4oCUXG4gICAgICAgICAgICAvLyBleGl0IDAsIG5ldmVyIHRoZSBvbGQgXCJjYW5jZWxcIiAxMzAuIFRoZXJlJ3Mgbm8gc3VibWl0LWFzLWZsdXNoOlxuICAgICAgICAgICAgLy8gdGhlIGRhZW1vbiBhbHJlYWR5IGhvbGRzIChhbmQgc25hcHNob3RzKSBjYW5vbmljYWwgc3RhdGUgYW5kIGV2ZXJ5XG4gICAgICAgICAgICAvLyBjaGFuZ2Ugd2FzIGxpdmUgdG8gYWxsIGNvbnN1bWVycywgc28gZGlzbWlzc2luZyBsb3NlcyBub3RoaW5nLiBUaGVcbiAgICAgICAgICAgIC8vIHRlYXJkb3duJ3MgXCJzZXNzaW9uIGVuZGVkXCIgYnJvYWRjYXN0ICsgc29ja2V0IGNsb3NlIGlzIHRoZSB1bmlmb3JtXG4gICAgICAgICAgICAvLyBlbmQgc2lnbmFsIGV2ZXJ5IGNsaWVudCAoYnJvd3NlciArIGpvaW5lcnMpIHJlY2VpdmVzLlxuICAgICAgICAgICAgcmVzb2x2ZURvbmUoeyBjb2RlOiAwLCByZWFzb246IFwidXNlclwiIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBBIGJyb3dzZXIgYWN0aW9uIChlLmcuIGRyYWdnaW5nIGEgYmxvY2tlciB0byBEb25lKSBjYW4gdW5ibG9ja1xuICAgICAgICAgIC8vIGRlcGVuZGVudHMg4oCUIGZpcmUgYHVuYmxvY2tlZGAgZm9yIGFueSB0cmFuc2l0aW9uLlxuICAgICAgICAgIHJlY29uY2lsZUJsb2NrZWQoKTtcbiAgICAgICAgfSxcbiAgICAgICAgY2xvc2Uod3MpIHtcbiAgICAgICAgICBzb2NrZXRzLmRlbGV0ZSh3cyk7XG4gICAgICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJkaXNjb25uZWN0ZWRcIiwgYnk6IFwidXNlclwiIH0pO1xuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBldmVudDogXCJiaW5kX2Vycm9yXCIsXG4gICAgICAgIGhvc3QsXG4gICAgICAgIHBvcnQsXG4gICAgICAgIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSksXG4gICAgICB9KX1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIDI7XG4gIH1cblxuICBjb25zdCBib3VuZFBvcnQgPSBzZXJ2ZXIucG9ydDtcbiAgaWYgKCFzZXNzaW9uSWQpIHNlc3Npb25JZCA9IGBib3VudHktJHtyYW5kSGV4KDQpfS1wJHtib3VuZFBvcnR9YDtcbiAgLy8gVGhlIHRocmVlIHZhbHVlcyB0aGUgb2xkIHRlbXBsYXRlLmh0bWwgaGFkIHN1YnN0aXR1dGVkIGludG8gaXQgbm93IHJlYWNoXG4gIC8vIHRoZSBib2FyZCBhbm90aGVyIHdheSwgYmVjYXVzZSBhIEJVSUxUIGluZGV4Lmh0bWwgaXMgYSBzdGF0aWMgYXJ0aWZhY3QgdGhlXG4gIC8vIGRhZW1vbiBzZXJ2ZXMgdmVyYmF0aW0gYW5kIGRldiBtb2RlIGlzIHNlcnZlZCBieSBCdW4ncyBvd24gYnVuZGxlciDigJQgdGhlcmVcbiAgLy8gaXMgbm8gcG9pbnQgYXQgd2hpY2ggdGhlIGRhZW1vbiBjb3VsZCBzdWJzdGl0dXRlIGluIGJvdGggbW9kZXM6XG4gIC8vICAgLSB0aGUgV2ViU29ja2V0IFVSTCBpcyBkZXJpdmVkIGluIHRoZSBicm93c2VyIGZyb20gbG9jYXRpb24uaG9zdCAodGhlXG4gIC8vICAgICBwYWdlIGlzIHNlcnZlZCBmcm9tIHRoaXMgc2FtZSBvcmlnaW4pO1xuICAvLyAgIC0gdGhlIHRpdGxlIGFscmVhZHkgcm9kZSB0aGUgYGluaXRgIGZyYW1lIGFuZCBhbHdheXMgb3ZlcnJvZGUgdGhlXG4gIC8vICAgICBzdWJzdGl0dXRlZCBvbmUgd2l0aGluIGEgZmV3IG1zIG9mIGNvbm5lY3Q7XG4gIC8vICAgLSB0aGUgc2Vzc2lvbiBpZCBub3cgcmlkZXMgYGluaXRgIHRvby4gSXQgaXMgYSBCT09UIEZBQ1QsIGFuZCBgaW5pdGAgaXNcbiAgLy8gICAgIHRoZSBmcmFtZSB0aGF0IGNhcnJpZXMgYm9vdCBmYWN0cyDigJQgdGhlIHNhbWUgYXJndW1lbnQgYjE2IG1hZGUgZm9yXG4gIC8vICAgICBwdXR0aW5nIHJlc3RvcmVGYWlsZWQgdGhlcmUuXG4gIGNvbnN0IHVybCA9IGBodHRwOi8vJHtob3N0fToke2JvdW5kUG9ydH1gO1xuICAvLyBGaXJzdCBmcmFtZSBvbiB0aGUgZXZlbnQgbG9nIChpZCAxKSDigJQgYm9va2VuZHMgdGhlIHN0cmVhbSB3aXRoIGBjbG9zZWRgLlxuICAvLyBgbW9kZWAgcmlkZXMgQk9USCB0cmFuc3BvcnRzIGJvdW50eSBoYXMuIEl0IHByaW50cyBubyBzdGRvdXQgaGFuZHNoYWtlIGFuZFxuICAvLyBubyBzdGRlcnIgYm9vdCBsaW5lLCBzbyB0aGUgcmVhZHkgZXZlbnQgYW5kIHRoZSBkaXNjb3ZlcnkgSlNPTiBhcmUgdGhlXG4gIC8vIHdob2xlIHNldCDigJQgYSBjZWxsIHRoYXQgcmVhZHMgb25lIGNlcnRpZmllcyBoYWxmIHRoZSBjb250cmFjdC5cbiAgZW1pdEV2ZW50KHsgdHlwZTogXCJyZWFkeVwiLCB1cmwsIHBvcnQ6IGJvdW5kUG9ydCwgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLCBtb2RlLCBieTogXCJzeXN0ZW1cIiB9KTtcbiAgbG9nRGFlbW9uKFwicmVhZHlcIiwgeyBwb3J0OiBib3VuZFBvcnQgfSk7XG5cbiAgLy8gRGlzY292ZXJ5OiB3cml0ZSBzZXNzaW9uIGluZm8gdG8gcHJlZGljdGFibGUgdGVtcCBmaWxlcyBzbyBqb2luaW5nXG4gIC8vIGFnZW50cyBjYW4gZmluZCB0aGlzIGJvYXJkIHdpdGhvdXQgY29weS1wYXN0ZS4gVHdvIGZpbGVzOlxuICAvLyAgIC0gYm91bnR5LTxzZXNzaW9uX2lkPi5qc29uICAoc3BlY2lmaWMgbG9va3VwIGJ5IC0taWQpXG4gIC8vICAgLSBib3VudHktbGF0ZXN0Lmpzb24gICAgICAgIChhbHdheXMgb3ZlcndyaXR0ZW4gYnkgbW9zdCByZWNlbnRcbiAgLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGhvc3Q7IGRlZmF1bHQgdGFyZ2V0IGZvciBqb2luZXJzKVxuICBjb25zdCBzZXNzaW9uRmlsZSA9IGpvaW4odG1wZGlyKCksIGBib3VudHktJHtzZXNzaW9uSWR9Lmpzb25gKTtcbiAgY29uc3QgbGF0ZXN0RmlsZSA9IGpvaW4odG1wZGlyKCksIGBib3VudHktbGF0ZXN0Lmpzb25gKTtcbiAgY29uc3Qgc2Vzc2lvbkluZm8gPSBKU09OLnN0cmluZ2lmeSh7XG4gICAgdXJsLFxuICAgIHBvcnQ6IGJvdW5kUG9ydCxcbiAgICBzZXNzaW9uX2lkOiBzZXNzaW9uSWQsXG4gICAgdGl0bGU6IHN0YXRlLnRpdGxlLFxuICAgIC8vIFdoaWNoIHN1cmZhY2UgYW5zd2VyZWQ6IFwicmVsZWFzZVwiIHNlcnZlcyB0aGUgY29tbWl0dGVkIGRpc3QvLCBcImRldlwiIGFza3NcbiAgICAvLyBCdW4gdG8gYnVuZGxlIHNyYy9ib3VudHkvc3VyZmFjZS8gYXQgc2VydmUgdGltZS4gQSBkZXYgZGFlbW9uIHdpdGggdGhlXG4gICAgLy8gcmVwbydzIGRlcHMgcHJlc2VudCByZW5kZXJzIGFuIGlkZW50aWNhbC1sb29raW5nIGJvYXJkLCBzbyB0aGlzIGlzIHRoZVxuICAgIC8vIG9ubHkgd2F5IGEgY2FsbGVyIGNhbiB0ZWxsIHRoZW0gYXBhcnQuXG4gICAgbW9kZSxcbiAgICAvLyBiMTUg4oCUIHJpZGVzIHRoZSBESVNDT1ZFUlkgcGF5bG9hZCBiZWNhdXNlIHRoYXQgaXMgd2hhdCBgb3BlbmAgcHJpbnRzLCBhbmRcbiAgICAvLyBgb3BlbmAgaXMgdGhlIGNvbW1hbmQgd2hvc2UgcmVzdG9yZSBqdXN0IGZhaWxlZC4gUmVwb3J0aW5nIGl0IG9ubHkgb24gYVxuICAgIC8vIGxhdGVyIC9zdGF0ZSB3b3VsZCBtZWFuIHRoZSBjYWxsZXIgbGVhcm5zIG9mIGl0LCBpZiBhdCBhbGwsIG9uIGEgZGlmZmVyZW50XG4gICAgLy8gY29tbWFuZCB0aGFuIHRoZSBvbmUgdGhhdCBicm9rZS5cbiAgICByZXN0b3JlRmFpbGVkLFxuICB9KTtcbiAgLy8g4pqgIEFUT01JQywgYmVjYXVzZSByZWFkU2Vzc2lvbiBub3cgdHJlYXRzIHVucGFyc2VhYmxlIGNvbnRlbnQgYXMgY29ycnVwdGlvblxuICAvLyByYXRoZXIgdGhhbiBhYnNlbmNlLiBBIGJhcmUgd3JpdGVGaWxlU3luYyBpcyBub3QgYXRvbWljOiBhIENMSSByZWFkaW5nXG4gIC8vIHdoaWxlIHRoZSBkYWVtb24gd3JpdGVzIGNhbiBvYnNlcnZlIGEgaGFsZi13cml0dGVuIHBvaW50ZXIsIGFuZCB1bmRlciB0aGVcbiAgLy8gb2xkIGJlc3QtZWZmb3J0IHJlYWQgdGhhdCBzdXJmYWNlZCBhcyBcIm5vIHJ1bm5pbmcgc2Vzc2lvblwiLiBXcml0ZSBiZXNpZGVcbiAgLy8gdGhlIHRhcmdldCBhbmQgcmVuYW1lIOKAlCByZW5hbWUgd2l0aGluIG9uZSBkaXJlY3RvcnkgaXMgYXRvbWljLCBzbyBhIHJlYWRlclxuICAvLyBzZWVzIGVpdGhlciB0aGUgcHJldmlvdXMgcG9pbnRlciBvciB0aGUgbmV3IG9uZSwgbmV2ZXIgYSBwYXJ0aWFsIGZpbGUuXG4gIC8vIEZpeGVkIGluIGdsYW1vdXIgMjAyNi0wOS0wNzsgZm91bmQgc3RhbmRpbmcgaW4gdGhyZWUgc2libGluZ3MgMjAyNi0wOS0wOFxuICAvLyAoZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LWJhY2tlbmQtZHVwbGljYXRpb24tcmVjb24ubWQpLlxuICBjb25zdCB3cml0ZUF0b21pYyA9ICh0YXJnZXQ6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB7XG4gICAgY29uc3QgdG1wID0gYCR7dGFyZ2V0fS4ke3Byb2Nlc3MucGlkfS50bXBgO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGVTeW5jKHRtcCwgdGV4dCk7XG4gICAgICByZW5hbWVTeW5jKHRtcCwgdGFyZ2V0KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJtU3luYyh0bXAsIHsgZm9yY2U6IHRydWUgfSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogdGhlIHRlbXAgZmlsZSBpcyBhbHJlYWR5IGdvbmUsIG9yIHdhcyBuZXZlciBjcmVhdGVkICovXG4gICAgICB9XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfVxuICB9O1xuICB0cnkge1xuICAgIHdyaXRlQXRvbWljKHNlc3Npb25GaWxlLCBzZXNzaW9uSW5mbyk7XG4gICAgd3JpdGVBdG9taWMobGF0ZXN0RmlsZSwgc2Vzc2lvbkluZm8pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgLy8gRGlzY292ZXJ5IGZpbGVzIGFyZSBuaWNlLXRvLWhhdmUsIG5vdCBsb2FkLWJlYXJpbmcuIExvZyB0byBzdGRlcnJcbiAgICAvLyBhbmQgY29udGludWUg4oCUIHRoZSBzZXNzaW9uIGlkIHByaW50ZWQgdG8gc3Rkb3V0IHN0aWxsIGxldHMgdGhlXG4gICAgLy8gdXNlciBwYXN0ZSBhIFVSTCBpbnRvIGEgam9pbmluZyBhZ2VudCBtYW51YWxseS5cbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGBib3VudHk6IGNvdWxkIG5vdCB3cml0ZSBkaXNjb3ZlcnkgZmlsZTogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuYCxcbiAgICApO1xuICB9XG4gIC8vIEJlc3QtZWZmb3J0IGNsZWFudXAgb24gZXhpdC4gV29uJ3QgZmlyZSBvbiBTSUdLSUxMLCBidXQgc3RhbGUgZmlsZXNcbiAgLy8gcHJvZHVjZSBhIGNsZWFuIFwic2Vzc2lvbiBub3QgcnVubmluZ1wiIGVycm9yIHdoZW4gYSBqb2luZXIgY29ubmVjdHMuXG4gIC8vIFRoZSBgbGF0ZXN0YCBwb2ludGVyIGlzIG9ubHkgcmVtb3ZlZCBpZiBpdCBzdGlsbCBuYW1lcyB1cyDigJQgb3RoZXJ3aXNlXG4gIC8vIGEgbmV3ZXIgaG9zdCBoYXMgdGFrZW4gb3ZlciB0aGUgc2xvdCBhbmQgd2UgbGVhdmUgaXRzIHBvaW50ZXIgYWxvbmUuXG4gIGNvbnN0IGNsZWFudXBEaXNjb3ZlcnkgPSBhc3luYyAoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMoc2Vzc2lvbkZpbGUpO1xuICAgIH0gY2F0Y2gge31cbiAgICB0cnkge1xuICAgICAgY29uc3QgY3VyID0gYXdhaXQgQnVuLmZpbGUobGF0ZXN0RmlsZSkudGV4dCgpO1xuICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShjdXIpO1xuICAgICAgaWYgKHBhcnNlZC5zZXNzaW9uX2lkID09PSBzZXNzaW9uSWQpIHVubGlua1N5bmMobGF0ZXN0RmlsZSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBmaWxlIGdvbmUgb3IgdW5yZWFkYWJsZSDigJQgZmluZSAqL1xuICAgIH1cbiAgfTtcblxuICBpZiAoIXZbXCJuby1vcGVuXCJdKSBvcGVuQnJvd3Nlcih1cmwpO1xuXG4gIGNvbnN0IGlkbGVUaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICAvLyBvcGVuLXRpbWVvdXQ6IGEgV1MgYnJvd3NlciBPUiBhbiBhZ2VudCBTU0UgdGFpbCBjb3VudHMgYXMgXCJ3YXRjaGVkXCIuXG4gICAgY29uc3Qgc3Vic2NyaWJlckNvdW50ID0gc29ja2V0cy5zaXplICsgc3NlQ2xpZW50cy5zaXplO1xuICAgIC8vIFdoaWxlIHdhdGNoZWQsIGNvdW50IHRoZSBib2FyZCdzIHByZXNlbmNlIGFzIGFjdGl2aXR5IHNvIHRoZSBpZGxlIGZsb29yXG4gICAgLy8gb25seSBiZWdpbnMgdG8gY291bnQgZG93biBvbmNlIHRoZSBMQVNUIHN1YnNjcmliZXIgaGFzIGxlZnQuXG4gICAgaWYgKHN1YnNjcmliZXJDb3VudCA+IDApIHRvdWNoKCk7XG4gICAgaWYgKHNob3VsZElkbGVDbG9zZShzdWJzY3JpYmVyQ291bnQsIHBlcmZvcm1hbmNlLm5vdygpIC0gbGFzdEFjdGl2aXR5LCB0aW1lb3V0ICogMTAwMCkpIHtcbiAgICAgIHJlc29sdmVEb25lKHsgY29kZTogMTI0LCByZWFzb246IFwidGltZW91dFwiIH0pO1xuICAgIH1cbiAgfSwgMjUwKTtcblxuICAvLyBEZWJvdW5jZWQgc25hcHNob3Qg4oCUIGZsdXNoIH4xcyBhZnRlciBhbnkgYm9hcmQgbXV0YXRpb24gc28gYSBjcmFzaCBtaWQtXG4gIC8vIHNlc3Npb24gaXMgcmVjb3ZlcmFibGUgdmlhIC0tcmVzdG9yZS5cbiAgY29uc3Qgc25hcFRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIGlmIChzbmFwRGlydHkpIHtcbiAgICAgIHNuYXBEaXJ0eSA9IGZhbHNlO1xuICAgICAgc2F2ZVNuYXBzaG90KCk7XG4gICAgfVxuICB9LCAxMDAwKTtcblxuICAvLyBIZWFydGJlYXQgKCMyOSk6IHN3ZWVwIGRvaW5nIHRhc2tzIGZvciBvdmVycnVucyBhbmQgcG9rZS4gY29tcHV0ZUR1ZVBva2VzIGlzXG4gIC8vIHRoZSBwdXJlIGRlY2lzaW9uOyBoZXJlIHdlIGp1c3QgZmlyZSB3aGF0IGl0IHJldHVybnMg4oCUIGFuIG93bmVyLXNjb3BlZFxuICAvLyBgaGVhcnRiZWF0YCBldmVudCAob25seSB0aGUgb3duZXIncyBzY29wZWQgdGFpbCB3YWtlcywgbGlrZSBgdW5ibG9ja2VkYCkgcGx1c1xuICAvLyBhIGJvYXJkIHRvYXN0IHNvIHRoZSBodW1hbiBzZWVzIHN0YWxlbmVzcyB0b28uIEFuIHVub3duZWQgb3ZlcmR1ZSB0YXNrIGdldHNcbiAgLy8gdGhlIHRvYXN0IG9ubHkgKG5vIG93bmVyIHRvIHdha2UpLiBBIHBva2UgbmV2ZXIgZGlydGllcyB0aGUgc25hcHNob3QuXG4gIGxldCBwb2tlU3RhdGU6IFBva2VTdGF0ZSA9IG5ldyBNYXAoKTtcbiAgY29uc3QgaGVhcnRiZWF0VGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgY29uc3Qgc3dlcHQgPSBjb21wdXRlRHVlUG9rZXMoc3RhdGUudGFza3MsIHBva2VTdGF0ZSwgRGF0ZS5ub3coKSk7XG4gICAgcG9rZVN0YXRlID0gc3dlcHQucG9rZVN0YXRlO1xuICAgIGZvciAoY29uc3QgcCBvZiBzd2VwdC5wb2tlcykge1xuICAgICAgY29uc3QgbGFiZWwgPSBzdGF0ZS50YXNrcy5maW5kKCh0KSA9PiB0LmlkID09PSBwLnRhc2tJZCk/LnRpdGxlID8/IHAudGFza0lkO1xuICAgICAgY29uc3Qgb3ZlcmR1ZU1pbiA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQocC5vdmVyZHVlQnlNcyAvIDYwXzAwMCkpO1xuICAgICAgaWYgKHAub3duZXIpIHtcbiAgICAgICAgZW1pdEV2ZW50KHtcbiAgICAgICAgICB0eXBlOiBcImhlYXJ0YmVhdFwiLFxuICAgICAgICAgIHRhc2tJZDogcC50YXNrSWQsXG4gICAgICAgICAgb3duZXI6IHAub3duZXIsXG4gICAgICAgICAgb3ZlcmR1ZUJ5TXM6IHAub3ZlcmR1ZUJ5TXMsXG4gICAgICAgICAgZXhwZWN0ZWRNaW51dGVzOiBwLmV4cGVjdGVkTWludXRlcyxcbiAgICAgICAgICBieTogXCJzeXN0ZW1cIixcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBicm9hZGNhc3Qoe1xuICAgICAgICB0eXBlOiBcIm1lc3NhZ2VcIixcbiAgICAgICAgdGV4dDogYOKPsCBcIiR7bGFiZWx9XCIgb3ZlcmR1ZSDigJQgfiR7b3ZlcmR1ZU1pbn1tIHBhc3QgaXRzICR7cC5leHBlY3RlZE1pbnV0ZXN9bSBlc3RpbWF0ZSR7cC5vd25lciA/IGAgKEAke3Aub3duZXJ9KWAgOiBcIlwifWAsXG4gICAgICB9KTtcbiAgICB9XG4gIH0sIDMwXzAwMCk7XG5cbiAgY29uc3QgeyBjb2RlLCByZWFzb24gfSA9IGF3YWl0IGRvbmU7XG4gIC8vIEtub3duLWV4aXQgZGlhZ25vc3RpY3MgKCM2NCkuIGBzdWJzY3JpYmVyc2AgYXQgYW4gaWRsZS10aW1lb3V0IGV4aXQgaXMgdGhlXG4gIC8vIGtleSBzaWduYWw6IGlmIGl0IGlkbGUtY2xvc2VzIHdpdGggc3Vic2NyaWJlcnMgPiAwIHRoZSBpZGxlIGxvZ2ljIGlzIHRoZVxuICAvLyBjdWxwcml0OyBpZiAwLCBubyB0YWlsIHdhcyBhY3R1YWxseSBjb25uZWN0ZWQuIENhcHR1cmVkIEJFRk9SRSB0ZWFyZG93blxuICAvLyBjbG9zZXMgdGhlIHNvY2tldHMvU1NFIGNsaWVudHMgc28gdGhlIGNvdW50IGlzIHRoZSBsaXZlIG9uZSBhdCBleGl0LlxuICBsb2dEYWVtb24oXCJleGl0XCIsIHtcbiAgICByZWFzb24sXG4gICAgc3Vic2NyaWJlcnM6IHNvY2tldHMuc2l6ZSArIHNzZUNsaWVudHMuc2l6ZSxcbiAgICBpZGxlTXM6IHBlcmZvcm1hbmNlLm5vdygpIC0gbGFzdEFjdGl2aXR5LFxuICB9KTtcbiAgLy8gQ2xlYXIgdGhlIHNodXRkb3duIHdhdGNoZG9nOiB0aGUgdGVhcmRvd24gcmVhY2hlZCB0aGlzIHBvaW50LCBzbyB0aGVcbiAgLy8gZm9yY2UtZXhpdCBpcyBubyBsb25nZXIgbmVlZGVkIEFORCB0aGUgcmVmJ2QgdGltZXIgbXVzdCBzdG9wIGhvbGRpbmcgdGhlXG4gIC8vIGV2ZW50IGxvb3Agb3IgdGhlIG5hdHVyYWwgZHJhaW4gbmV2ZXIgaGFwcGVucy5cbiAgaWYgKHNodXRkb3duV2F0Y2hkb2cpIGNsZWFyVGltZW91dChzaHV0ZG93bldhdGNoZG9nKTtcbiAgY2xlYXJJbnRlcnZhbChpZGxlVGltZXIpO1xuICBjbGVhckludGVydmFsKHNuYXBUaW1lcik7XG4gIGNsZWFySW50ZXJ2YWwoaGVhcnRiZWF0VGltZXIpO1xuICBzYXZlU25hcHNob3QoKTsgLy8gZmluYWwgd3JpdGUg4oCUIEtFRVAgaXQgKHRoZSByZXN1bWUgcG9pbnQsIG5vdCBkZWxldGVkIG9uIGNsb3NlKVxuICAvLyBDbG9zaW5nIGZyYW1lIG9uIHRoZSBldmVudCBsb2cg4oCUIGVuZHMgYSBgY2xpLnRzIHRhaWxgIChleGl0IDApIGFuZCBib29rZW5kc1xuICAvLyB0aGUgYHJlYWR5YCB0aGF0IG9wZW5lZCBpdC5cbiAgZW1pdEV2ZW50KHsgdHlwZTogXCJjbG9zZWRcIiwgcmVhc29uLCBieTogXCJzeXN0ZW1cIiB9KTtcbiAgYnJvYWRjYXN0KHsgdHlwZTogXCJtZXNzYWdlXCIsIHRleHQ6IGBzZXNzaW9uIGVuZGVkOiAke3JlYXNvbn1gIH0pO1xuICAvLyBHcmFjZSBwZXJpb2Q6IHNlcnZlci5zdG9wKHRydWUpIGFnZ3Jlc3NpdmVseSBhYm9ydHMgaW4tZmxpZ2h0XG4gIC8vIGNvbm5lY3Rpb25zLCB3aGljaCBjYW4gZHJvcCBhIGJyb2FkY2FzdCB0aGF0IHdhcyBxdWV1ZWQgbWljcm9zZWNvbmRzXG4gIC8vIGVhcmxpZXIgKHRoZSBzdWJtaXQvY2FuY2VsIGJyb2FkY2FzdHMgaW4gdGhlIFdTIG1lc3NhZ2UgaGFuZGxlcnNcbiAgLy8gaW1tZWRpYXRlbHkgcHJlY2VkZSB0aGlzIHRlYXJkb3duKS4gUGF1c2UgYnJpZWZseSBzbyB0aGUgT1MtbGV2ZWxcbiAgLy8gc29ja2V0IGJ1ZmZlcnMgZmx1c2ggYmVmb3JlIHdlIHRlYXIgZG93bi4gMTUwbXMgaXMgZW5vdWdoIG9uIGFcbiAgLy8gbG9jYWwgY29ubmVjdGlvbjsgc21hbGwgZW5vdWdoIHRoYXQgXCJzZXNzaW9uIGVuZGVkXCIgZmVlbHMgcmVzcG9uc2l2ZS5cbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMTUwKSk7XG4gIGZvciAoY29uc3QgdCBvZiBzc2VUaW1lcnMpIGNsZWFySW50ZXJ2YWwodCk7XG4gIGZvciAoY29uc3QgYyBvZiBzc2VDbGllbnRzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGMuY2xvc2UoKTtcbiAgICB9IGNhdGNoIHt9XG4gIH1cbiAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzKSB7XG4gICAgdHJ5IHtcbiAgICAgIHdzLmNsb3NlKCk7XG4gICAgfSBjYXRjaCB7fVxuICB9XG4gIGF3YWl0IFByb21pc2UucmFjZShbc2VydmVyLnN0b3AodHJ1ZSksIG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDIwMCkpXSk7XG4gIGF3YWl0IGNsZWFudXBEaXNjb3ZlcnkoKTtcbiAgcmV0dXJuIGNvZGU7XG59XG5cbi8qKlxuICogVGhlIHByb2Nlc3MgZW50cnksIGNhbGxlZCBieSB0aGUgTEFVTkNIRVIgYXRcbiAqIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvYm91bnR5L3NjcmlwdHMvc2VydmVyLnRzYC5cbiAqXG4gKiDim5QgVEhFUkUgSVMgTk8gYGlmIChpbXBvcnQubWV0YS5tYWluKWAgQkxPQ0sgSEVSRSwgQU5EIFRIRSBEQUVNT04gS0VFUFMgTk9cbiAqIFNFQ09ORCBFTlRSWSBERUxJQkVSQVRFTFkuIFRoaXMgbW9kdWxlIHNoaXBzIEJVTkRMRUQgYXQgYC4uL2Rpc3Qvc2VydmVyLmpzYFxuICogYW5kIGlzIElNUE9SVEVEIGJ5IHRoZSBsYXVuY2hlciwgc28gYGltcG9ydC5tZXRhLm1haW5gIGlzIEZBTFNFIGluIHRoZVxuICogYXJ0aWZhY3Q6IGEgZ3VhcmRlZCBibG9jayB3b3VsZCBuZXZlciBydW4sIHRoZSBkYWVtb24gd291bGQgYmluZCBubyBwb3J0LFxuICogZXhpdCAwLCBhbmQgZXZlcnkgaW50ZWdyYXRpb24gY2VsbCB3b3VsZCBmYWlsIGFzIFwidGhlIGRhZW1vbiBuZXZlciBhbnN3ZXJlZFwiXG4gKiDigJQgd2hpY2ggcmVhZHMgbGlrZSBmbGFrZSAocGxheWJvb2sgUGhhc2UgQiwgQjMpLlxuICpcbiAqIOKblCBBTkQgT0ZGRVJJTkcgQSBTRUNPTkQgRU5UUlkgSEVSRSBXT1VMRCBCRSBPRkZFUklORyBBIFdST05HIERBRU1PTi4gRXZlcnlcbiAqIHBpbiBpbiB0aGlzIGZpbGUgaXMgYW5jaG9yZWQgb24gYFNDUklQVF9ESVJgLCB3aGljaCBpcyB0aGUgc2tpbGwncyBgZGlzdC9gXG4gKiB3aGVuIHRoZSBhcnRpZmFjdCBydW5zIGFuZCBgc3JjL2JvdW50eS9iYWNrZW5kL2Agd2hlbiB0aGUgc291cmNlIGRvZXMuIEZyb21cbiAqIHRoZSBzb3VyY2UgYWRkcmVzcyBgU0tJTExfUk9PVGAgY29tcHV0ZXMgYHNyYy9ib3VudHkvYCwgd2hpY2ggaGFzIG5vXG4gKiBgZGlzdC9pbmRleC5odG1sYCwgbm8gYGFzc2V0cy9gIGFuZCBubyBgU0tJTEwubWRgIOKAlCBzbyB0aGUgbW9kZSBwcm9iZVxuICogc2lsZW50bHkgY2hvb3NlcyBERVYgYW5kIHRoZSBhc3NldHMgcm91dGUgc2VydmVzIG5vdGhpbmcuXG4gKlxuICog4pqgIFRIRSBURVJNSU5BTCBgcHJvY2Vzcy5leGl0KGV4aXRDb2RlKWAgU1RBWVMsIEFUIFRIRSBMQVVOQ0hFUi4gSXQgaXMgZmFtaWx5XG4gKiBFLXRlcm1pbmFsIGluIGBncmltb2lyZS9leGl0LXNpdGUtaW52ZW50b3J5LnRlc3QudHNgIGFuZCBpdCBpcyBsb2FkLWJlYXJpbmdcbiAqIHR3aWNlIG92ZXI6IHRoZSBzaWduYWwgcGF0aCBpcyByZWRpcmVjdGVkIElOVE8gdGhlIGJvdW5kZWQgdGVhcmRvd24gdGhhdFxuICogcHJlY2VkZXMgaXQgKFAxZiksIGFuZCB0aGUgc2h1dGRvd24gd2F0Y2hkb2cgZm9yY2UtZXhpdHMgaWYgdGhhdCB0ZWFyZG93blxuICogZG9lcyBub3QgZmluaXNoLiBBIG5hdHVyYWwgcmV0dXJuIGhlcmUgd291bGQgYmUgdGhlIDIzLW1pbnV0ZSBoYW5nIHRoaXNcbiAqIHNwZWxsIGhhcyBhbHJlYWR5IHNoaXBwZWQgb25jZS4gSXQgaXMgTk9UIHRoZSBDTEkncyBkcmFpbmVkLWV4aXQgY2FzZTogdGhlXG4gKiBkYWVtb24ncyBzdGRvdXQgaXMgcmVsZWFzZWQgYnkgdGhlIENMSSBhZnRlciB0aGUgaGFuZHNoYWtlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG5cbmV4cG9ydCB7XG4gIGFwcGx5VGFza0FkZCxcbiAgYXBwbHlUYXNrTW92ZSxcbiAgYXBwbHlUYXNrUmVtb3ZlLFxuICBhcHBseVRhc2tVcGRhdGUsXG4gIGNsZWFuVGFncyxcbiAgY29tcHV0ZUR1ZVBva2VzLFxuICBodG1sRXNjYXBlLFxuICBpc05vT3BNb3ZlLFxuICBpc05vT3BVcGRhdGUsXG4gIG1haW4sXG4gIHBhcnNlUG9ydEZyb21TZXNzaW9uSWQsXG4gIHNob3VsZElkbGVDbG9zZSxcbiAgc2hvdWxkUm90YXRlU25hcHNob3QsXG4gIHNuYXBzaG90VGFza0NvdW50LFxuICB2YWxpZGF0ZVRhc2ssXG59O1xuIiwKICAgICIvLyBUaGUgYm9hcmQncyB3aXJlIHNoYXBlIOKAlCB0aGUgT05FIGRlZmluaXRpb24sIHJlYWQgYnkgYm90aCBzaWRlcyBvZiB0aGUgc2VhbS5cbi8vXG4vLyBUd28tc2lkZWQgYnkgY29uc3VtZXIgc2V0OiBgc2NyaXB0cy9zZXJ2ZXIudHNgIGhvbGRzIHRoZSBjYW5vbmljYWwgc3RhdGUgaW5cbi8vIGl0LCBhbmQgYHNyYy9ib3VudHkvc3VyZmFjZS9gIHJlbmRlcnMgaXQuIEl0IGxpdmVzIGhlcmUsIElOU0lERSB0aGUgdHJhY2tlZFxuLy8gc2tpbGwgc3VidHJlZSwgc28gYSBzb3VyY2Utc2hpcHBlZCBkYWVtb24gY2FuIHJlYWNoIGAuLi9zaGFyZWQvdHlwZXNgIGF0IHRoZVxuLy8gZGVzdGluYXRpb24gd2l0aCBub3RoaW5nIGluc3RhbGxlZCAoc2VhbXMgQ29udHJhY3QgMywgcm93IDEpIHdoaWxlIHRoZVxuLy8gc3VyZmFjZSByZWFjaGVzIGl0IGFjcm9zcyB0aGUgYXJ0aWZhY3QgYm91bmRhcnkgdGhlIGltcG9ydC1ib3VuZGFyeSB3YXJkc1xuLy8gcGVybWl0LlxuLy9cbi8vIOKblCBOT1RISU5HIElNUEVSQVRJVkUgQkVMT05HUyBIRVJFLiBUeXBlcyBhbmQgdGhlIHNpemUgdGFibGUgb25seTsgdGhlXG4vLyBwcmVkaWNhdGVzIHRoYXQgcmVhZCB0aGVtIGFyZSBpbiAuL3ByZWRpY2F0ZXMudHMsIGFuZCB0aGUgZGFlbW9uJ3MgbXV0YXRvcnNcbi8vIHN0YXkgaW4gc2NyaXB0cy9zZXJ2ZXIudHMuIEEgbW9kdWxlIGNhbiBiZSB0d28tc2lkZWQgYnkgZmlsZSBhbmQgZGlzam9pbnQgYnlcbi8vIHN5bWJvbCDigJQgc2hpcHBpbmcgdGhlIGRhZW1vbidzIG11dGF0b3JzIHRvIHRoZSBib2FyZCBpcyB0aGUgZmFpbHVyZSB0aGlzXG4vLyBzcGxpdCBleGlzdHMgdG8gYXZvaWQuXG5cbmV4cG9ydCB0eXBlIFRhc2tTdGF0dXMgPSBcInRvZG9cIiB8IFwiZG9pbmdcIiB8IFwicmV2aWV3XCIgfCBcImRvbmVcIjtcblxuLyoqIEEgc2luZ2xlIHN0YXR1cyB0cmFuc2l0aW9uICh1bml4IG1zKS4gKi9cbmV4cG9ydCB0eXBlIFN0YXR1c1Zpc2l0ID0geyBzdGF0dXM6IFRhc2tTdGF0dXM7IGF0OiBudW1iZXIgfTtcblxuLyoqXG4gKiBIZWFydGJlYXQgc2l6aW5nLiBUaHJlZSBzaXplcyBvbmx5IOKAlCBhZ2VudHMgYXJlIGZhc3QsIGFuZCB0aGUgYWJzZW5jZSBvZiBhblxuICogWEwgaXMgZGVsaWJlcmF0ZTogYSBkYXlzLWxvbmcgdGFzayBpcyBhIHNpZ25hbCB0byBCUkVBSyBJVCBET1dOLCBub3QgdG8gc2l6ZVxuICogaXQgYmlnZ2VyLlxuICovXG5leHBvcnQgdHlwZSBUYXNrU2l6ZSA9IFwiU1wiIHwgXCJNXCIgfCBcIkxcIjtcblxuZXhwb3J0IGNvbnN0IFNJWkVfTUlOVVRFUzogUmVjb3JkPFRhc2tTaXplLCBudW1iZXI+ID0geyBTOiA1LCBNOiAxMCwgTDogMjAgfTtcblxuZXhwb3J0IHR5cGUgVGFzayA9IHtcbiAgaWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgc3RhdHVzOiBUYXNrU3RhdHVzO1xuICBub3Rlcz86IHN0cmluZztcbiAgb3duZXI/OiBzdHJpbmc7IC8vIGFzc2lnbmVlIOKAlCBsZWFkIHNldHMgdmlhIGFkZC91cGRhdGUgLS1vd25lcjsgd29ya2VyIHNlbGYtY2xhaW1zXG4gIGJsb2NrZWRCeT86IHN0cmluZ1tdOyAvLyBpZHMgdGhpcyB0YXNrIGlzIGJsb2NrZWQgb24gKG11dGF0ZWQgb25seSB2aWEgYmxvY2svdW5ibG9jaylcbiAgdGFncz86IHN0cmluZ1tdOyAvLyBmcmVlLWZvcm0gbGFiZWxzOyBjbGVhbiBzdHJpbmdbXVxuICBlbnRlcmVkU3RhdHVzQXQ/OiBudW1iZXI7IC8vIHVuaXggbXMgdGhlIHRhc2sgZW50ZXJlZCBpdHMgQ1VSUkVOVCBzdGF0dXNcbiAgc3RhdHVzSGlzdG9yeT86IFN0YXR1c1Zpc2l0W107IC8vIGNhcHBlZCB0cmFuc2l0aW9uIGxvZyAoaGVhcnRiZWF0L2FnaW5nL21ldHJpY3Mgc3Vic3RyYXRlKVxuICBzaXplPzogVGFza1NpemU7IC8vIGhlYXJ0YmVhdCBzaXppbmcg4oCUIG9wdC1pbjsgbWFwcyB0byBhIGRlZmF1bHQgZXhwZWN0ZWQgdGltZVxuICBleHBlY3Q/OiBudW1iZXI7IC8vIGV4cGxpY2l0IGV4cGVjdGVkIG1pbnV0ZXMgKG92ZXJyaWRlcyBzaXplKTsgZm9yIHRoZSByYXJlIGV4Y2VwdGlvblxufTtcblxuZXhwb3J0IHR5cGUgQm9hcmRTdGF0ZSA9IHsgdGl0bGU6IHN0cmluZzsgdGFza3M6IFRhc2tbXSB9O1xuIiwKICAgICIvLyBUaGUgZm91ciBib2FyZCBwcmVkaWNhdGVzIEJPVEggc2lkZXMgbmVlZCwgYW5kIHRoZSBibG9ja2VyIGNvdW50IHVuZGVyIHRoZW0uXG4vL1xuLy8g4puUIFRISVMgRklMRSBFWElTVFMgVE8gREVMRVRFIEEgTUlSUk9SLiBVbnRpbCAyMDI2LTA5LTA2IHRoZSBib2FyZCB3YXMgb25lXG4vLyBpbmxpbmUtQWxwaW5lIEhUTUwgZmlsZSwgc28gaXQgY291bGQgbm90IGltcG9ydDsgYHNjcmlwdHMvdGVtcGxhdGUuaHRtbGBcbi8vIGhhbmQtcmUtaW1wbGVtZW50ZWQgYGNhcmRQYXNzZXNGaWx0ZXJgLCBgY2FyZE92ZXJkdWVgLCBgb3duZXJzT3ZlcldpcGAgYW5kXG4vLyBgZXhwZWN0ZWRNaW51dGVzYCBpbiBKYXZhU2NyaXB0IGJlc2lkZSB0aGVpciBjYW5vbmljYWwgVHlwZVNjcmlwdCwgd2l0aFxuLy8gbm90aGluZyB0ZXN0aW5nIHRoZSBjb3B5LiBGb3VyIGNvbW1lbnRzIGluIGBzZXJ2ZXIudHNgIHNhaWQgXCJ0aGUgaW5saW5lXG4vLyBBbHBpbmUgc3VyZmFjZSBtaXJyb3JzIGl0IChpdCBjYW4ndCBpbXBvcnQpLiBLZWVwIGluIGxvY2tzdGVwLlwiIOKAlCBhIGhvdXNlXG4vLyBoYXphcmQgd2l0aCBubyBpbnN0cnVtZW50IGJlaGluZCBpdC4gVGhlIHN1cmZhY2UgY2FuIGltcG9ydCBub3cuICoqSWYgeW91XG4vLyBmaW5kIHlvdXJzZWxmIHdyaXRpbmcgYSBzZWNvbmQgY29weSBvZiBhbnl0aGluZyBiZWxvdywgdGhlIHNlYW0gaGFzIGJyb2tlblxuLy8gYW5kIHRoZSByaWdodCBmaXggaXMgYW5vdGhlciBleHBvcnQgaGVyZSwgbmV2ZXIgYSByZS1pbXBsZW1lbnRhdGlvbi4qKlxuLy9cbi8vIEV2ZXJ5IGZ1bmN0aW9uIGhlcmUgaXMgUFVSRSBhbmQgY2xvY2staW5qZWN0ZWQ6IGBub3dgIGlzIGEgcGFyYW1ldGVyLCBuZXZlclxuLy8gYERhdGUubm93KClgLCBzbyB0aGUgZGFlbW9uJ3Mgc3dlZXAgYW5kIHRoZSBicm93c2VyJ3MgMzAgcyB0aWNrIGNhbiByZWFkIHRoZVxuLy8gc2FtZSBjb2RlIHdpdGggZGlmZmVyZW50IGNsb2Nrcy4gYHNjcmlwdHMvc2VydmVyLnRlc3QudHNgIGlzIHRoZSBndWFyZC5cblxuaW1wb3J0IHR5cGUgeyBUYXNrIH0gZnJvbSBcIi4vdHlwZXNcIjtcbmltcG9ydCB7IFNJWkVfTUlOVVRFUyB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbi8qKlxuICogQSB0YXNrJ3MgZXhwZWN0ZWQgdGltZSBpbiBtaW51dGVzLCBvciB1bmRlZmluZWQgd2hlbiBpdCBpc24ndCB3YXRjaGVkLlxuICogSGVhcnRiZWF0IGlzIG9wdC1pbiBwZXIgdGFzazogYW4gZXhwbGljaXQgYGV4cGVjdGAgd2lucywgZWxzZSB0aGUgc2l6ZSdzXG4gKiBkZWZhdWx0LCBlbHNlIHVuZGVmaW5lZCAobm8gc2l6ZS9leHBlY3Qg4oaSIG5ldmVyIHBva2VkLCBuZXZlciBhZ2VkKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4cGVjdGVkTWludXRlcyh0YXNrOiBUYXNrKTogbnVtYmVyIHwgdW5kZWZpbmVkIHtcbiAgaWYgKHR5cGVvZiB0YXNrLmV4cGVjdCA9PT0gXCJudW1iZXJcIiAmJiB0YXNrLmV4cGVjdCA+IDApIHJldHVybiB0YXNrLmV4cGVjdDtcbiAgaWYgKHRhc2suc2l6ZSAmJiB0YXNrLnNpemUgaW4gU0laRV9NSU5VVEVTKSByZXR1cm4gU0laRV9NSU5VVEVTW3Rhc2suc2l6ZV07XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogSG93IG1hbnkgb2YgYSB0YXNrJ3MgYmxvY2tlcnMgYXJlIHN0aWxsIExJVkUg4oCUIGEgYGJsb2NrZWRCeWAgaWQgcG9pbnRpbmcgYXRcbiAqIGFuIEVYSVNUSU5HIHRhc2sgdGhhdCBpc24ndCBkb25lIHlldC4gQSBtaXNzaW5nIG9yIGRvbmUgYmxvY2tlciBkb2Vzbid0XG4gKiBibG9jay5cbiAqXG4gKiBUaGUgY291bnQsIG5vdCB0aGUgYm9vbGVhbiwgaXMgdGhlIHByaW1pdGl2ZTogdGhlIGRhZW1vbiBvbmx5IGFza3MgXCJpcyBpdFxuICogYmxvY2tlZD9cIiwgdGhlIGNhcmQgcmVuZGVycyBcIuKblCBibG9ja2VkIGJ5IE5cIiwgYW5kIG9uZSBvZiB0aGUgdHdvIHVzZWQgdG8gYmVcbiAqIGEgaGFuZC13cml0dGVuIGNvcHkgb2YgdGhlIG90aGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbGl2ZUJsb2NrZXJDb3VudCh0YXNrOiBUYXNrLCB0YXNrczogVGFza1tdKTogbnVtYmVyIHtcbiAgcmV0dXJuICh0YXNrLmJsb2NrZWRCeSA/PyBbXSkuZmlsdGVyKChiaWQpID0+IHtcbiAgICBjb25zdCBiID0gdGFza3MuZmluZCgodCkgPT4gdC5pZCA9PT0gYmlkKTtcbiAgICByZXR1cm4gYiAhPT0gdW5kZWZpbmVkICYmIGIuc3RhdHVzICE9PSBcImRvbmVcIjtcbiAgfSkubGVuZ3RoO1xufVxuXG4vKipcbiAqIEEgdGFzayBpcyBibG9ja2VkIGlmZiBpdCBoYXMgYXQgbGVhc3Qgb25lIGxpdmUgYmxvY2tlciDigJQgdGhlIHNhbWUgcHJlZGljYXRlXG4gKiB0aGUgL3N0YXRlIHByb2plY3Rpb24gdXNlcyBmb3IgYGJsb2NrZWRgL2BsaXZlQmxvY2tlcnNgLiBBIGJsb2NrZWQgZG9pbmcgY2FyZFxuICogaXMgbGVnaXRpbWF0ZWx5IHdhaXRpbmcgb24gYSBwZWVyLCBub3Qgc3R1Y2ssIHNvIG5laXRoZXIgdGhlIGhlYXJ0YmVhdCBwb2tlXG4gKiBub3IgdGhlIGNhcmQtYWdpbmcgc3dlZXAgZmlyZXMgb24gaXQgKCM0MCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0Jsb2NrZWQodGFzazogVGFzaywgdGFza3M6IFRhc2tbXSk6IGJvb2xlYW4ge1xuICByZXR1cm4gbGl2ZUJsb2NrZXJDb3VudCh0YXNrLCB0YXNrcykgPiAwO1xufVxuXG4vKipcbiAqIENhcmQtYWdpbmcgKCMyKTogdGhlIHN1cmZhY2UgY29tcGFuaW9uIHRvIGhlYXJ0YmVhdC4gQSBkb2luZyBjYXJkIHRoYXQgaGFzIGFuXG4gKiBleHBlY3RlZCB0aW1lIChzaXplL2V4cGVjdCkgYW5kIGhhcyBvdmVycnVuIGl0IHJlYWRzIGFzIFwic3RhbGVcIi4gUmV0dXJucyBudWxsXG4gKiB3aGVuIHRoZSBjYXJkIHNob3VsZG4ndCBiZSBjdWVkIChub3QgZG9pbmcsIHVuc2l6ZWQsIHVuc3RhbXBlZCwgYmxvY2tlZCwgb3JcbiAqIG5vdCB5ZXQgb3ZlcmR1ZSkg4oCUIG9wdC1pbiwgbWlycm9yaW5nIGhlYXJ0YmVhdC4gUmV0dXJucyBib3RoIGBvdmVyZHVlQnlNc2BcbiAqIChhbiBcIk5tIG92ZXJcIiBiYWRnZSkgYW5kIGBhZ2VNc2AgKGEgXCJEb2luZyBObVwiIGJhZGdlKSBzbyB0aGUgc3VyZmFjZSBwaWNrc1xuICogdGhlIHdvcmRpbmcuXG4gKlxuICogVGhlIERBRU1PTiBkb2VzIG5vdCBjYWxsIHRoaXMg4oCUIGBjb21wdXRlRHVlUG9rZXNgIGlzIGl0cyBvd24gcGF0aC4gVGhlIGJvYXJkXG4gKiBkb2VzLCBvbiBhIGNsaWVudC1zaWRlIGBub3dgIHRoYXQgdGlja3MgZXZlcnkgMzAgcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNhcmRPdmVyZHVlKFxuICB0YXNrOiBUYXNrLFxuICB0YXNrczogVGFza1tdLFxuICBub3c6IG51bWJlcixcbik6IHsgb3ZlcmR1ZUJ5TXM6IG51bWJlcjsgYWdlTXM6IG51bWJlciB9IHwgbnVsbCB7XG4gIGlmICh0YXNrLnN0YXR1cyAhPT0gXCJkb2luZ1wiIHx8IHRhc2suZW50ZXJlZFN0YXR1c0F0ID09PSB1bmRlZmluZWQpIHJldHVybiBudWxsO1xuICBjb25zdCBleHAgPSBleHBlY3RlZE1pbnV0ZXModGFzayk7XG4gIGlmIChleHAgPT09IHVuZGVmaW5lZCkgcmV0dXJuIG51bGw7XG4gIGlmIChpc0Jsb2NrZWQodGFzaywgdGFza3MpKSByZXR1cm4gbnVsbDsgLy8gbGVnaXRpbWF0ZWx5IHdhaXRpbmcgb24gYSBwZWVyIOKAlCBub3Qgc3RhbGVcbiAgY29uc3QgYWdlTXMgPSBub3cgLSB0YXNrLmVudGVyZWRTdGF0dXNBdDtcbiAgY29uc3Qgb3ZlcmR1ZUJ5TXMgPSBhZ2VNcyAtIGV4cCAqIDYwXzAwMDtcbiAgcmV0dXJuIG92ZXJkdWVCeU1zID49IDAgPyB7IG92ZXJkdWVCeU1zLCBhZ2VNcyB9IDogbnVsbDtcbn1cblxuLyoqXG4gKiBzdXJmYWNlLWZpbHRlcjogd2hldGhlciBhIGNhcmQgc3Vydml2ZXMgdGhlIGh1bWFuJ3MgdmlldyBmaWx0ZXIuIEZhY2V0ZWQg4oCUIE9SXG4gKiB3aXRoaW4gYSBmYWNldCAoYW55IHNlbGVjdGVkIHRhZyBtYXRjaGVzKSwgQU5EIGFjcm9zcyBmYWNldHMgKHRoZSB0YWctc2V0IEFORFxuICogdGhlIG93bmVyLXNldCkuIEFuIGVtcHR5IGZhY2V0IG1lYW5zIFwibm8gZmlsdGVyIG9uIHRoaXMgZmFjZXRcIiDihpIgaXQgcGFzc2VzLFxuICogc28gbm8gYWN0aXZlIGZpbHRlcnMgYXQgYWxsIOKGkiBldmVyeSBjYXJkIHBhc3Nlcy5cbiAqXG4gKiBWaWV3LW9ubHk6IHRoZSBkYWVtb24gbmV2ZXIgY2FsbHMgaXQsIG5vdGhpbmcgaXMgc2VudCwgbm8gZXZlbnQgaXMgZW1pdHRlZC5cbiAqIENhcmRzIHRoYXQgZmFpbCBpdCBhcmUgSElEREVOLCBub3QgZGltbWVkLCBzbyBjb2x1bW4gY291bnRzIHRyYWNrIHRoZSB2aXNpYmxlXG4gKiBzZXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjYXJkUGFzc2VzRmlsdGVyKFxuICB0YXNrOiBUYXNrLFxuICBhY3RpdmVUYWdzOiBzdHJpbmdbXSxcbiAgYWN0aXZlT3duZXJzOiBzdHJpbmdbXSxcbik6IGJvb2xlYW4ge1xuICBjb25zdCB0YWdQYXNzID0gYWN0aXZlVGFncy5sZW5ndGggPT09IDAgfHwgKHRhc2sudGFncyA/PyBbXSkuc29tZSgodCkgPT4gYWN0aXZlVGFncy5pbmNsdWRlcyh0KSk7XG4gIGNvbnN0IG93bmVyUGFzcyA9XG4gICAgYWN0aXZlT3duZXJzLmxlbmd0aCA9PT0gMCB8fCAodGFzay5vd25lciAhPT0gdW5kZWZpbmVkICYmIGFjdGl2ZU93bmVycy5pbmNsdWRlcyh0YXNrLm93bmVyKSk7XG4gIHJldHVybiB0YWdQYXNzICYmIG93bmVyUGFzcztcbn1cblxuLyoqXG4gKiB3aXAtY3VlOiB0aGUgb3duZXJzIHdobyBoYXZlID49IGB0aHJlc2hvbGRgIGNhcmRzIGluIERPSU5HIOKAlCBhIHNvZnQsXG4gKiBwZXItb3duZXIgV0lQIHNpZ25hbCAoXCJ5b3UndmUgZ290IGEgcGlsZXVwOyB3cmFwIG9uZSBiZWZvcmUgcHVsbGluZyBtb3JlXCIpLlxuICogUGVyLW93bmVyLCBzbyBsZWdpdGltYXRlIHBhcmFsbGVsIG93bmVycyBlYWNoIHVuZGVyIHRoZSBsaW1pdCBuZXZlciB0cmlwIGl0LlxuICogVU5PV05FRCBkb2luZyBjYXJkcyBoYXZlIG5vIHdvcmtlciwgc28gdGhleSdyZSBleGNsdWRlZCBhbmQgY291bnQgdG93YXJkXG4gKiBub2JvZHkncyB0YWxseS5cbiAqXG4gKiBUaGUgZGFlbW9uIGRvZXMgbm90IGNhbGwgaXQ6IGEgcHVyZWx5IHZpc3VhbCwgbm9uLWJsb2NraW5nIG51ZGdlIHRoYXQgY2FuXG4gKiBuZXZlciBibG9jayBhIG1vdmUuIEEgY2FyZCBzaG93cyB0aGUgY3VlIGlmZiBpdCBpcyBkb2luZyBBTkQgaXRzIG93bmVyIGlzIGluXG4gKiB0aGlzIHNldC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG93bmVyc092ZXJXaXAodGFza3M6IFRhc2tbXSwgdGhyZXNob2xkOiBudW1iZXIpOiBTZXQ8c3RyaW5nPiB7XG4gIGNvbnN0IGNvdW50cyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGZvciAoY29uc3QgdCBvZiB0YXNrcykge1xuICAgIGlmICh0LnN0YXR1cyA9PT0gXCJkb2luZ1wiICYmIHQub3duZXIgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY291bnRzLnNldCh0Lm93bmVyLCAoY291bnRzLmdldCh0Lm93bmVyKSA/PyAwKSArIDEpO1xuICAgIH1cbiAgfVxuICBjb25zdCBvdmVyID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgW293bmVyLCBuXSBvZiBjb3VudHMpIGlmIChuID49IHRocmVzaG9sZCkgb3Zlci5hZGQob3duZXIpO1xuICByZXR1cm4gb3Zlcjtcbn1cbiIKICBdLAogICJtYXBwaW5ncyI6ICI7Ozs7O0FBdURBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFXQTtBQUNBO0FBQ0E7QUFDQTs7O0FDMUNPLElBQU0sZUFBeUMsRUFBRSxHQUFHLEdBQUcsR0FBRyxJQUFJLEdBQUcsR0FBRzs7O0FDSHBFLFNBQVMsZUFBZSxDQUFDLE1BQWdDO0FBQUEsRUFDOUQsSUFBSSxPQUFPLEtBQUssV0FBVyxZQUFZLEtBQUssU0FBUztBQUFBLElBQUcsT0FBTyxLQUFLO0FBQUEsRUFDcEUsSUFBSSxLQUFLLFFBQVEsS0FBSyxRQUFRO0FBQUEsSUFBYyxPQUFPLGFBQWEsS0FBSztBQUFBLEVBQ3JFO0FBQUE7QUFZSyxTQUFTLGdCQUFnQixDQUFDLE1BQVks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
