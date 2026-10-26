#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// src/astrolabe/backend/server.ts
import { mkdirSync, unlinkSync as unlinkSync2 } from "fs";
import { homedir } from "os";
import { dirname, join as join2 } from "path";
import { parseArgs } from "util";

// plugins/spellbook/skills/astrolabe/scripts/state.ts
function unknownProject(state, id) {
  return {
    state,
    applied: false,
    error: `unknown project '${id}'`,
    reason: "unknown-project",
    project: id
  };
}
function emptyState(title = "Observatory") {
  return { title, projects: [], presence: {}, status: {} };
}
var AVATAR_GLYPHS = ["\uD83D\uDD2D", "\uD83E\uDE84", "\uD83C\uDF3F", "\uD83D\uDD2E", "\u26A1", "\uD83D\uDEF0\uFE0F", "\u2728", "\uD83E\uDDED", "\uD83D\uDCE1", "\uD83D\uDDFA\uFE0F", "\u2B50", "\uD83C\uDF19"];
function hashString(s) {
  let h = 0;
  for (const ch of s)
    h = h * 31 + (ch.codePointAt(0) ?? 0) >>> 0;
  return h;
}
function fallbackAvatar(name) {
  const glyph = AVATAR_GLYPHS[hashString(name.trim().toLowerCase()) % AVATAR_GLYPHS.length];
  if (glyph === undefined)
    return "\uD83D\uDD2D";
  return glyph;
}
function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}
var normName = (s) => s.trim().toLowerCase();
var normPath = (s) => s.trim().replace(/\/+$/, "");
function findDuplicate(state, name, path, exceptId) {
  const n = normName(name);
  const p = normPath(path);
  return state.projects.find((pr) => pr.id !== exceptId && (normName(pr.name) === n || normPath(pr.path) === p));
}
var hasProject = (state, id) => state.projects.some((p) => p.id === id);
function validateProject(p) {
  if (!p || typeof p !== "object")
    return null;
  const o = p;
  if (typeof o.name !== "string" || o.name.trim() === "")
    return null;
  if (typeof o.path !== "string" || o.path.trim() === "")
    return null;
  const out = { id: typeof o.id === "string" ? o.id : "", name: o.name, path: o.path };
  if (typeof o.description === "string")
    out.description = o.description;
  if (typeof o.avatar === "string")
    out.avatar = o.avatar;
  return out;
}
function registryShapeError(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    return "not a JSON object";
  if (!Array.isArray(snapshot.projects))
    return "`projects` is not an array";
  return null;
}
function restoreRegistry(snapshot, title = "Observatory") {
  let state = emptyState(title);
  if (!snapshot || typeof snapshot !== "object")
    return state;
  const snap = snapshot;
  if (typeof snap.title === "string")
    state = { ...state, title: snap.title };
  if (Array.isArray(snap.projects)) {
    for (const raw of snap.projects) {
      const p = validateProject(raw);
      if (p)
        state = applyProjectAdd(state, p).state;
    }
  }
  return state;
}
function applyProjectAdd(state, project) {
  const name = project.name?.trim();
  const path = project.path?.trim();
  if (!name || !path) {
    return { state, applied: false, error: "project requires a name and path" };
  }
  const id = project.id?.trim() || slugify(name);
  if (hasProject(state, id)) {
    return { state, applied: false, error: `id '${id}' already registered` };
  }
  const dup = findDuplicate(state, name, path);
  if (dup) {
    return { state, applied: false, error: `duplicate of '${dup.id}' (same name or path)` };
  }
  const registered = {
    ...project,
    id,
    name,
    path,
    avatar: project.avatar?.trim() || fallbackAvatar(name)
  };
  return {
    state: {
      ...state,
      projects: [...state.projects, registered],
      presence: { ...state.presence, [id]: { connected: false } }
    },
    applied: true,
    id
  };
}
function applyProjectRemove(state, id) {
  if (!hasProject(state, id)) {
    return unknownProject(state, id);
  }
  const { [id]: _p, ...presence } = state.presence;
  const { [id]: _s, ...status } = state.status;
  return {
    state: { ...state, projects: state.projects.filter((p) => p.id !== id), presence, status },
    applied: true
  };
}
function applySetPresence(state, id, connected) {
  if (!hasProject(state, id)) {
    return unknownProject(state, id);
  }
  if ((state.presence[id]?.connected ?? false) === connected) {
    return {
      state,
      applied: false,
      outcome: connected ? "already-connected" : "already-disconnected"
    };
  }
  return {
    state: { ...state, presence: { ...state.presence, [id]: { connected } } },
    applied: true
  };
}
function applyStatus(state, id, update, now) {
  if (!hasProject(state, id)) {
    return unknownProject(state, id);
  }
  const prev = state.status[id];
  const next = {
    summary: update.summary,
    phase: update.phase,
    needsAttention: prev?.needsAttention ?? false,
    question: prev?.question,
    lastUpdated: now
  };
  return { state: { ...state, status: { ...state.status, [id]: next } }, applied: true };
}
function applyAttention(state, id, raised, question, now) {
  if (!hasProject(state, id)) {
    return unknownProject(state, id);
  }
  const prev = state.status[id];
  const nextQuestion = raised ? question : undefined;
  if ((prev?.needsAttention ?? false) === raised && (prev?.question ?? undefined) === nextQuestion) {
    return { state, applied: false, outcome: raised ? "already-raised" : "already-cleared" };
  }
  const next = {
    summary: prev?.summary ?? "",
    phase: prev?.phase,
    needsAttention: raised,
    question: nextQuestion,
    lastUpdated: now
  };
  return { state: { ...state, status: { ...state.status, [id]: next } }, applied: true };
}

// src/kit/wire/discovery.ts
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "fs";
function writeFileAtomic(target, text) {
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
}
function unlinkIfMatches(path, expected, identify = (raw) => raw.trim()) {
  try {
    if (!existsSync(path))
      return false;
    if (identify(readFileSync(path, "utf8")) !== expected)
      return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

// src/kit/wire/errors.ts
var EXIT_IDLE_TIMEOUT = 124;

// src/kit/wire/eventLog.ts
var REPLAY_BUFFER_SIZE = 1000;
function createEventLog(opts = {}) {
  const bufferSize = opts.bufferSize ?? REPLAY_BUFFER_SIZE;
  const epoch = opts.epoch;
  const buffer = [];
  const listeners = new Set;
  let seq = 0;
  return {
    epoch,
    emit(msg) {
      seq += 1;
      const frame = { id: seq, ...msg };
      frame.id = seq;
      if (epoch !== undefined)
        frame.epoch = epoch;
      buffer.push(frame);
      if (buffer.length > bufferSize)
        buffer.shift();
      for (const listener of listeners)
        listener(frame);
      return frame;
    },
    subscribe(since, listener) {
      const from = !Number.isFinite(since) || since > seq ? -1 : since;
      for (const frame of buffer) {
        if (frame.id > from)
          listener(frame);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cursor() {
      return seq;
    }
  };
}

// src/kit/wire/housekeeping.ts
function shouldIdleClose(subscriberCount, idleMs, timeoutMs) {
  if (timeoutMs <= 0)
    return false;
  if (subscriberCount > 0)
    return false;
  return idleMs >= timeoutMs;
}
var TIMER_MAX_S = Math.floor((2 ** 31 - 1) / 1000);
function startHousekeeping(opts) {
  const tickMs = opts.tickMs ?? 250;
  const snapshotMs = opts.snapshotMs ?? 1000;
  const idleTimer = setInterval(() => {
    const subscribers = opts.subscriberCount();
    if (subscribers > 0)
      opts.touch();
    if (shouldIdleClose(subscribers, opts.idleMs(), opts.timeoutMs))
      opts.onIdleClose();
  }, tickMs);
  const snap = opts.snapshot;
  const snapTimer = snap ? setInterval(() => {
    if (!snap.dirty())
      return;
    snap.clear();
    snap.write();
  }, snapshotMs) : null;
  return () => {
    clearInterval(idleTimer);
    if (snapTimer !== null)
      clearInterval(snapTimer);
  };
}
async function drainAndStop(opts) {
  const graceMs = opts.graceMs ?? 150;
  const stopMs = opts.stopMs ?? 200;
  const listeners = (opts.clients?.size ?? 0) + [...opts.sockets ?? []].length + (opts.server.pendingRequests ?? 0);
  if (listeners > 0)
    await new Promise((r) => setTimeout(r, graceMs));
  if (opts.clients) {
    for (const client of [...opts.clients])
      client.close();
  }
  if (opts.sockets) {
    for (const ws of [...opts.sockets]) {
      try {
        ws.close();
      } catch {}
    }
  }
  let raceTimer;
  try {
    await Promise.race([
      Promise.resolve(opts.server.stop(true)),
      new Promise((r) => {
        raceTimer = setTimeout(r, stopMs);
      })
    ]);
  } finally {
    clearTimeout(raceTimer);
  }
}

// src/kit/wire/origin.ts
function ours(port) {
  if (typeof port !== "number" || !Number.isFinite(port))
    return [];
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}
function sameOrigin(req, port) {
  const origin = req.headers.get("origin");
  if (origin === null)
    return true;
  return ours(port).includes(origin);
}
function refuseForeignOrigin(req, port, boundHost) {
  if (!ownHost(req, port, boundHost))
    return Response.json({ ok: false, error: "foreign host refused" }, { status: 403 });
  if (sameOrigin(req, port))
    return null;
  return Response.json({ ok: false, error: "foreign origin refused" }, { status: 403 });
}
function ownHost(req, port, boundHost) {
  const host = req.headers.get("host");
  if (host === null)
    return true;
  if (typeof port !== "number" || !Number.isFinite(port))
    return false;
  const names = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (boundHost) {
    const bound = boundHost.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    names.push(bound.includes(":") ? `[${bound}]:${port}` : `${bound}:${port}`);
  }
  return names.includes(host.toLowerCase());
}

// src/kit/wire/serveDist.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { join } from "path";
function resolveMode(distDir) {
  const override = process.env.SPELLBOOK_SURFACE_MODE;
  if (override === "dev" || override === "release")
    return override;
  return existsSync2(join(distDir, "index.html")) ? "release" : "dev";
}
var STATIC_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};
function contentTypeFor(nameOrExt) {
  const dot = nameOrExt.lastIndexOf(".");
  const ext = dot === -1 ? "" : nameOrExt.slice(dot);
  return STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream";
}
function serveFromDist(distDir, rel) {
  if (!rel || rel.includes("..") || rel.includes("/"))
    return null;
  if (!surfaceWhitelist(distDir).has(rel))
    return null;
  const file = join(distDir, rel);
  if (!existsSync2(file))
    return null;
  return new Response(Bun.file(file), { headers: { "Content-Type": contentTypeFor(rel) } });
}
var ENTRY_REF_RE = /(?:src|href)\s*=\s*"(?:\.\/)?([^"]+)"/g;
var RELATIVE_REF_RE = /["'(]\.\/([^"'()\s]+)["')]/g;
var TRANSITIVE_EXTS = [".js", ".css"];
var whitelistCache = new Map;
function refsIn(text, re) {
  return [...text.matchAll(re)].map(([, ref]) => ref).filter((ref) => !!ref && !ref.includes("/") && !ref.includes("..") && !ref.includes(":") && !ref.startsWith("#") && !ref.startsWith("?"));
}
function surfaceWhitelist(distDir) {
  const cached = whitelistCache.get(distDir);
  if (cached)
    return cached;
  const names = new Set;
  const entry = join(distDir, "index.html");
  if (existsSync2(entry)) {
    names.add("index.html");
    const html = readFileSync2(entry, "utf8");
    const pending = [...refsIn(html, ENTRY_REF_RE), ...refsIn(html, RELATIVE_REF_RE)];
    while (pending.length > 0) {
      const name = pending.pop();
      if (names.has(name))
        continue;
      const file = join(distDir, name);
      if (!existsSync2(file))
        continue;
      names.add(name);
      if (!TRANSITIVE_EXTS.some((ext) => name.endsWith(ext)))
        continue;
      pending.push(...refsIn(readFileSync2(file, "utf8"), RELATIVE_REF_RE));
    }
  }
  whitelistCache.set(distDir, names);
  return names;
}

// src/kit/wire/sse.ts
function sseResponse(opts) {
  const { log, since, heartbeatMs, clients, signal, filter, openFrames, onOpen, onClose } = opts;
  let unsubscribe = null;
  let keepalive = null;
  let closed = false;
  const client = { close: () => {}, send: () => {} };
  const teardown = () => {
    if (closed)
      return;
    closed = true;
    if (keepalive !== null)
      clearInterval(keepalive);
    unsubscribe?.();
    clients?.delete(client);
    onClose?.();
  };
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder;
      const safeEnqueue = (chunk) => {
        if (closed)
          return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          teardown();
        }
      };
      client.close = () => {
        teardown();
        try {
          controller.close();
        } catch {}
      };
      client.send = safeEnqueue;
      safeEnqueue(`: connected

`);
      if (openFrames)
        for (const chunk of openFrames())
          safeEnqueue(chunk);
      unsubscribe = log.subscribe(since, (frame) => {
        if (filter && !filter(frame))
          return;
        safeEnqueue(`data: ${JSON.stringify(frame)}

`);
      });
      keepalive = setInterval(() => safeEnqueue(`: hb

`), heartbeatMs);
      signal?.addEventListener("abort", teardown, { once: true });
      clients?.add(client);
      onOpen?.();
    },
    cancel() {
      teardown();
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

// src/kit/wire/heartbeat.ts
var MAX_IDLE_TIMEOUT_SEC = 255;
var DEFAULT_HEARTBEAT_MS = 15000;
var MISSED_BEATS = 3;
var MIN_HEARTBEAT_MS = 500;
function intOr(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function idleTimeoutSec(raw, fallback = MAX_IDLE_TIMEOUT_SEC) {
  return Math.max(1, Math.min(MAX_IDLE_TIMEOUT_SEC, intOr(raw, fallback)));
}
function heartbeatMs(raw, idleSec, fallback = DEFAULT_HEARTBEAT_MS) {
  const ceiling = Math.max(MIN_HEARTBEAT_MS, Math.floor(idleSec * 1000 / 2));
  return Math.min(Math.max(intOr(raw, fallback), MIN_HEARTBEAT_MS), ceiling);
}
function tailIdleMs(beatMs) {
  return beatMs * MISSED_BEATS;
}

// src/astrolabe/backend/heartbeat.ts
var IDLE_TIMEOUT_SEC = idleTimeoutSec(process.env.ASTROLABE_IDLE_TIMEOUT);
var SSE_HEARTBEAT_MS = heartbeatMs(process.env.ASTROLABE_HEARTBEAT_MS, IDLE_TIMEOUT_SEC, 1e4);
var TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

// src/astrolabe/backend/registryFile.ts
import { existsSync as existsSync3, readdirSync as readdirSync2, readFileSync as readFileSync3, renameSync as renameSync2 } from "fs";
var errMessage = (e) => e instanceof Error ? e.message : String(e);
function causeOfReadError(e) {
  const code = e.code;
  if (code === "EISDIR")
    return "directory";
  if (code === "EACCES" || code === "EPERM")
    return "permissions";
  return "json";
}
function readRegistry(file, title) {
  let text;
  try {
    text = readFileSync3(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT")
      return { ok: true, state: emptyState(title) };
    return { ok: false, reason: errMessage(e), cause: causeOfReadError(e) };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `invalid JSON: ${errMessage(e)}`, cause: "json" };
  }
  const shape = registryShapeError(parsed);
  if (shape)
    return { ok: false, reason: shape, cause: "json" };
  return { ok: true, state: restoreRegistry(parsed, title) };
}
var MARK = ".unreadable-";
function setAside(file, now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  let dest = `${file}${MARK}${stamp}`;
  for (let n = 1;existsSync3(dest); n++)
    dest = `${file}${MARK}${stamp}-${n}`;
  renameSync2(file, dest);
  return dest;
}

// src/astrolabe/backend/server.ts
var SCRIPT_DIR = import.meta.dir;
var SKILL_ROOT = join2(SCRIPT_DIR, "..");
var DIST_DIR = join2(SKILL_ROOT, "dist");
function serveDist(path) {
  return serveFromDist(DIST_DIR, path === "/" ? "index.html" : path.slice(1));
}
var ASTROLABE_HOME = process.env.ASTROLABE_HOME ?? join2(homedir(), ".astrolabe");
var REGISTRY_FILE = join2(ASTROLABE_HOME, "registry.json");
var PORT_FILE = join2(ASTROLABE_HOME, "daemon.port");
var PID_FILE = join2(ASTROLABE_HOME, "daemon.pid");
var PRESENCE_DEBOUNCE_MS = Number.parseInt(process.env.ASTROLABE_PRESENCE_DEBOUNCE_MS ?? "2500", 10) || 2500;
function notApplied(r) {
  return {
    ok: true,
    applied: false,
    error: r.error,
    outcome: r.outcome,
    reason: r.reason,
    project: r.project
  };
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}
async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        title: { type: "string", default: "Observatory" },
        timeout: { type: "string", default: "0" },
        "no-open": { type: "boolean", default: false },
        port: { type: "string", default: "0" },
        host: { type: "string", default: "127.0.0.1" }
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
  const timeout = Number.parseFloat(v.timeout);
  const port = Number.parseInt(v.port, 10);
  const host = v.host;
  let state = emptyState(v.title);
  const read = readRegistry(REGISTRY_FILE, v.title);
  if (read.ok)
    state = read.state;
  else {
    try {
      const aside = setAside(REGISTRY_FILE);
      process.stderr.write(`astrolabe: registry.json could not be read (${read.reason}); set aside at ${aside}
`);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      process.stderr.write(`${JSON.stringify({
        event: "registry_unreadable",
        path: REGISTRY_FILE,
        reason: read.reason,
        error: `could not set it aside: ${why}`,
        message: `astrolabe did not start: ${REGISTRY_FILE} could not be read (${read.reason}) and could not be set aside (${why}), so its bytes were left in place, untouched \u2014 an empty board would have saved over them`,
        hint: `make the rename possible (the directory ${dirname(REGISTRY_FILE)} must be writable, and the file must not be locked or immutable) and run \`cli.ts open\` again; or repair the file in place and retry`
      })}
`);
      return 1;
    }
  }
  const sockets = new Set;
  const log = createEventLog({ epoch: crypto.randomUUID() });
  const sseClients = new Set;
  const projectConns = new Map;
  const idleTimers = new Map;
  let snapDirty = false;
  const saveRegistry = async () => {
    try {
      mkdirSync(ASTROLABE_HOME, { recursive: true });
      await Bun.write(REGISTRY_FILE, JSON.stringify({ title: state.title, projects: state.projects }));
    } catch {}
  };
  const DIRTYING = new Set(["project.add", "project.remove"]);
  let resolveDone;
  let settled = false;
  const done = new Promise((res) => {
    resolveDone = (val) => {
      if (settled)
        return;
      settled = true;
      res(val);
    };
  });
  let lastActivity = performance.now();
  const touch = () => {
    lastActivity = performance.now();
  };
  function projectCards() {
    return state.projects.map((p) => {
      const connected = state.presence[p.id]?.connected ?? false;
      const st = state.status[p.id];
      const needsAttention = st?.needsAttention ?? false;
      return {
        ...p,
        connected,
        needsAttention,
        question: needsAttention ? st?.question : undefined,
        status: st ? { summary: st.summary, phase: st.phase, lastUpdated: st.lastUpdated } : null,
        zone: needsAttention ? "attention" : connected ? "active" : "quiet"
      };
    });
  }
  const projectState = () => ({ title: state.title, projects: projectCards() });
  function broadcastState() {
    const s = JSON.stringify({ type: "state", ...projectState() });
    for (const ws of sockets) {
      try {
        ws.send(s);
      } catch {}
    }
  }
  function emitEvent(msg) {
    if (typeof msg.type === "string" && DIRTYING.has(msg.type))
      snapDirty = true;
    log.emit(msg);
  }
  function presenceConnect(projectId) {
    const pending = idleTimers.get(projectId);
    if (pending) {
      clearTimeout(pending);
      idleTimers.delete(projectId);
    }
    const n = (projectConns.get(projectId) ?? 0) + 1;
    projectConns.set(projectId, n);
    if (n === 1) {
      const r = applySetPresence(state, projectId, true);
      if (r.applied) {
        state = r.state;
        emitEvent({ type: "presence", projectId, connected: true, by: "system" });
        broadcastState();
      }
    }
  }
  function presenceDisconnect(projectId) {
    const n = Math.max(0, (projectConns.get(projectId) ?? 0) - 1);
    if (n === 0)
      projectConns.delete(projectId);
    else
      projectConns.set(projectId, n);
    if (n !== 0)
      return;
    if (idleTimers.has(projectId))
      return;
    const timer = setTimeout(() => {
      idleTimers.delete(projectId);
      if ((projectConns.get(projectId) ?? 0) !== 0)
        return;
      const r = applySetPresence(state, projectId, false);
      if (r.applied) {
        state = r.state;
        emitEvent({ type: "presence", projectId, connected: false, by: "system" });
        broadcastState();
      }
    }, PRESENCE_DEBOUNCE_MS);
    idleTimers.set(projectId, timer);
  }
  function eventsResponse(req, url2) {
    touch();
    const projectId = url2.searchParams.get("project") ?? undefined;
    const bind = projectId && state.projects.some((p) => p.id === projectId) ? projectId : undefined;
    return sseResponse({
      log,
      since: Number.parseInt(url2.searchParams.get("since") ?? "-1", 10),
      heartbeatMs: SSE_HEARTBEAT_MS,
      clients: sseClients,
      signal: req.signal,
      onOpen: bind ? () => presenceConnect(bind) : undefined,
      onClose: bind ? () => presenceDisconnect(bind) : undefined
    });
  }
  function handleAgentMsg(msg) {
    const by = typeof msg.as === "string" ? msg.as : "agent";
    const type = msg.type;
    if (type === "project.add") {
      const project = validateProject(msg.project);
      if (!project)
        return { ok: true, applied: false, error: "invalid project" };
      const r = applyProjectAdd(state, project);
      if (!r.applied)
        return notApplied(r);
      state = r.state;
      const registered = state.projects.find((p) => p.id === r.id);
      emitEvent({ type: "project.add", project: registered, by });
      broadcastState();
      return { ok: true, applied: true, id: r.id };
    }
    if (type === "project.remove") {
      const id = String(msg.id ?? "");
      const r = applyProjectRemove(state, id);
      if (!r.applied)
        return notApplied(r);
      state = r.state;
      projectConns.delete(id);
      const pendingIdle = idleTimers.get(id);
      if (pendingIdle) {
        clearTimeout(pendingIdle);
        idleTimers.delete(id);
      }
      emitEvent({ type: "project.remove", projectId: id, by });
      broadcastState();
      return { ok: true, applied: true };
    }
    if (type === "status") {
      const id = String(msg.id ?? "");
      const summary = typeof msg.summary === "string" ? msg.summary : "";
      const phase = typeof msg.phase === "string" ? msg.phase : undefined;
      const r = applyStatus(state, id, { summary, phase }, Date.now());
      if (!r.applied)
        return notApplied(r);
      state = r.state;
      emitEvent({ type: "status", projectId: id, summary, phase, by });
      broadcastState();
      return { ok: true, applied: true };
    }
    if (type === "attention") {
      const id = String(msg.id ?? "");
      const raised = msg.raised !== false;
      const question = typeof msg.question === "string" ? msg.question : undefined;
      const r = applyAttention(state, id, raised, question, Date.now());
      if (!r.applied)
        return notApplied(r);
      state = r.state;
      emitEvent({ type: "attention", projectId: id, raised, question, by });
      broadcastState();
      return { ok: true, applied: true };
    }
    if (type === "poke") {
      const id = String(msg.id ?? "");
      if (!state.projects.some((p) => p.id === id)) {
        return notApplied(unknownProject(state, id));
      }
      emitEvent({ type: "poke", projectId: id, by });
      return { ok: true, applied: true };
    }
    if (type === "close") {
      resolveDone({ code: 0, reason: "close" });
      return { ok: true, applied: true };
    }
    return { ok: true, applied: false, error: `unknown command '${String(type)}'` };
  }
  const mode = resolveMode(DIST_DIR);
  const devIndex = mode === "dev" ? (await import("../../../../../src/astrolabe/surface/index.html")).default : undefined;
  const routes = devIndex ? { "/": devIndex } : {};
  let server;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      idleTimeout: IDLE_TIMEOUT_SEC,
      routes,
      development: { hmr: mode === "dev" },
      fetch: (req, srv) => {
        {
          const refused = refuseForeignOrigin(req, srv.port, srv.hostname);
          if (refused)
            return refused;
        }
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
          return new Response(JSON.stringify({ state: projectState(), cursor: log.cursor() }), {
            headers: { "Content-Type": "application/json" }
          });
        }
        if (req.method === "GET" && path === "/events") {
          return eventsResponse(req, url2);
        }
        if (req.method === "POST" && path === "/cmd") {
          return req.json().then((body) => {
            touch();
            const result = handleAgentMsg(body);
            return new Response(JSON.stringify(result), {
              headers: { "Content-Type": "application/json" }
            });
          }).catch(() => new Response('{"error":"bad json"}', {
            status: 400,
            headers: { "Content-Type": "application/json" }
          }));
        }
        if (mode === "release") {
          const asset = serveDist(path);
          if (asset)
            return asset;
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
          ws.send(JSON.stringify({ type: "state", ...projectState() }));
        },
        message(_ws, raw) {
          touch();
          let msg;
          try {
            msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
          } catch (e) {
            process.stderr.write(`astrolabe: bad json from browser: ${e instanceof Error ? e.message : String(e)}
`);
            return;
          }
          if (msg.type === "poke" || msg.type === "close") {
            handleAgentMsg({ ...msg, as: "user" });
          }
        },
        close(ws) {
          sockets.delete(ws);
          emitEvent({ type: "disconnected", by: "user" });
        }
      }
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${JSON.stringify({
      event: "bind_error",
      host,
      port,
      error,
      message: `astrolabe did not start: it could not listen on ${host}:${port} (${error})`
    })}
`);
    return 2;
  }
  const boundPort = server.port;
  const url = `http://${host}:${boundPort}`;
  emitEvent({
    type: "ready",
    url,
    port: boundPort,
    session_id: "astrolabe",
    mode,
    by: "system"
  });
  try {
    mkdirSync(ASTROLABE_HOME, { recursive: true });
    writeFileAtomic(PORT_FILE, String(boundPort));
    writeFileAtomic(PID_FILE, String(process.pid));
  } catch (e) {
    process.stderr.write(`astrolabe: could not write discovery files: ${e instanceof Error ? e.message : String(e)}
`);
  }
  const cleanupDiscovery = () => {
    if (!unlinkIfMatches(PID_FILE, String(process.pid)))
      return;
    try {
      unlinkSync2(PORT_FILE);
    } catch {}
  };
  process.stdout.write(`${JSON.stringify({ url, port: boundPort, session_id: "astrolabe", mode })}
`);
  if (!v["no-open"])
    openBrowser(url);
  const stopHousekeeping = startHousekeeping({
    subscriberCount: () => sockets.size + sseClients.size,
    idleMs: () => performance.now() - lastActivity,
    touch,
    timeoutMs: timeout * 1000,
    onIdleClose: () => resolveDone({ code: EXIT_IDLE_TIMEOUT, reason: "timeout" }),
    snapshot: {
      dirty: () => snapDirty,
      clear: () => {
        snapDirty = false;
      },
      write: saveRegistry
    }
  });
  const { code, reason } = await done;
  stopHousekeeping();
  await saveRegistry();
  emitEvent({ type: "closed", reason, by: "system" });
  broadcastState();
  await drainAndStop({ server, clients: sseClients, sockets });
  for (const t of idleTimers.values())
    clearTimeout(t);
  cleanupDiscovery();
  return code;
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  main,
  run,
  validateProject
};
