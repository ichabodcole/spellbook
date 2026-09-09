#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// src/astrolabe/backend/server.ts
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parseArgs } from "util";

// plugins/spellbook/skills/astrolabe/scripts/state.ts
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
  return AVATAR_GLYPHS[hashString(name.trim().toLowerCase()) % AVATAR_GLYPHS.length];
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
    return { state, applied: false, error: `unknown project '${id}'` };
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
    return { state, applied: false, error: `unknown project '${id}'` };
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
    return { state, applied: false, error: `unknown project '${id}'` };
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
    return { state, applied: false, error: `unknown project '${id}'` };
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

// src/astrolabe/backend/server.ts
var SCRIPT_DIR = import.meta.dir;
var SKILL_ROOT = join(SCRIPT_DIR, "..");
var DIST_DIR = join(SKILL_ROOT, "dist");
function resolveMode() {
  const override = process.env.SPELLBOOK_SURFACE_MODE;
  if (override === "dev" || override === "release")
    return override;
  return existsSync(join(DIST_DIR, "index.html")) ? "release" : "dev";
}
var STATIC_CONTENT_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};
function serveDist(path) {
  const rel = path === "/" ? "index.html" : path.slice(1);
  if (rel.includes("..") || rel.includes("/"))
    return null;
  const file = join(DIST_DIR, rel);
  if (!existsSync(file))
    return null;
  const ext = rel.slice(rel.lastIndexOf("."));
  return new Response(Bun.file(file), {
    headers: { "Content-Type": STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream" }
  });
}
var ASTROLABE_HOME = process.env.ASTROLABE_HOME ?? join(homedir(), ".astrolabe");
var REGISTRY_FILE = join(ASTROLABE_HOME, "registry.json");
var PORT_FILE = join(ASTROLABE_HOME, "daemon.port");
var PID_FILE = join(ASTROLABE_HOME, "daemon.pid");
var IDLE_TIMEOUT_SEC = Math.max(1, Math.min(255, Number.parseInt(process.env.ASTROLABE_IDLE_TIMEOUT ?? "255", 10) || 255));
var SSE_HEARTBEAT_MS = Math.min(Number.parseInt(process.env.ASTROLABE_HEARTBEAT_MS ?? "10000", 10) || 1e4, Math.max(500, Math.floor(IDLE_TIMEOUT_SEC * 1000 / 2)));
var PRESENCE_DEBOUNCE_MS = Number.parseInt(process.env.ASTROLABE_PRESENCE_DEBOUNCE_MS ?? "2500", 10) || 2500;
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
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}
function shouldIdleClose(subscriberCount, idleMs, timeoutMs) {
  return timeoutMs > 0 && subscriberCount === 0 && idleMs >= timeoutMs;
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
  if (existsSync(REGISTRY_FILE)) {
    try {
      const snap = JSON.parse(await Bun.file(REGISTRY_FILE).text());
      if (typeof snap.title === "string")
        state.title = snap.title;
      if (Array.isArray(snap.projects)) {
        for (const raw of snap.projects) {
          const p = validateProject(raw);
          if (p)
            state = applyProjectAdd(state, p).state;
        }
      }
    } catch (e) {
      process.stderr.write(`astrolabe: registry restore failed: ${e instanceof Error ? e.message : String(e)}
`);
    }
  }
  const sockets = new Set;
  const events = [];
  let eventSeq = 0;
  const enc = new TextEncoder;
  const sseClients = new Set;
  const sseTimers = new Set;
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
  function sseResponse(url2) {
    touch();
    const since = Number.parseInt(url2.searchParams.get("since") ?? "-1", 10);
    const projectId = url2.searchParams.get("project") ?? undefined;
    const bind = projectId && state.projects.some((p) => p.id === projectId) ? projectId : undefined;
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
        if (bind)
          presenceConnect(bind);
        hb = setInterval(() => {
          try {
            controller.enqueue(enc.encode(`: hb

`));
          } catch {}
        }, SSE_HEARTBEAT_MS);
        sseTimers.add(hb);
      },
      cancel() {
        if (hb) {
          clearInterval(hb);
          sseTimers.delete(hb);
        }
        if (ref)
          sseClients.delete(ref);
        if (bind)
          presenceDisconnect(bind);
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
  function handleAgentMsg(msg) {
    const by = typeof msg.as === "string" ? msg.as : "agent";
    const type = msg.type;
    if (type === "project.add") {
      const project = validateProject(msg.project);
      if (!project)
        return { ok: true, applied: false, error: "invalid project" };
      const r = applyProjectAdd(state, project);
      if (!r.applied)
        return { ok: true, applied: false, error: r.error, outcome: r.outcome };
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
        return { ok: true, applied: false, error: r.error, outcome: r.outcome };
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
        return { ok: true, applied: false, error: r.error, outcome: r.outcome };
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
        return { ok: true, applied: false, error: r.error, outcome: r.outcome };
      state = r.state;
      emitEvent({ type: "attention", projectId: id, raised, question, by });
      broadcastState();
      return { ok: true, applied: true };
    }
    if (type === "poke") {
      const id = String(msg.id ?? "");
      if (!state.projects.some((p) => p.id === id)) {
        return { ok: true, applied: false, error: `unknown project '${id}'` };
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
  const mode = resolveMode();
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
          return new Response(JSON.stringify({ state: projectState(), cursor: eventSeq }), {
            headers: { "Content-Type": "application/json" }
          });
        }
        if (req.method === "GET" && path === "/events") {
          return sseResponse(url2);
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
    writeFileSync(PORT_FILE, String(boundPort));
    writeFileSync(PID_FILE, String(process.pid));
  } catch (e) {
    process.stderr.write(`astrolabe: could not write discovery files: ${e instanceof Error ? e.message : String(e)}
`);
  }
  const cleanupDiscovery = () => {
    try {
      if (existsSync(PID_FILE) && readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) {
        unlinkSync(PID_FILE);
        unlinkSync(PORT_FILE);
      }
    } catch {}
  };
  process.stdout.write(`${JSON.stringify({ url, port: boundPort, session_id: "astrolabe", mode })}
`);
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
  const snapTimer = setInterval(async () => {
    if (snapDirty) {
      snapDirty = false;
      await saveRegistry();
    }
  }, 1000);
  const { code, reason } = await done;
  clearInterval(idleTimer);
  clearInterval(snapTimer);
  await saveRegistry();
  emitEvent({ type: "closed", reason, by: "system" });
  broadcastState();
  await new Promise((r) => setTimeout(r, 150));
  for (const t of sseTimers)
    clearInterval(t);
  for (const t of idleTimers.values())
    clearTimeout(t);
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
  cleanupDiscovery();
  return code;
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  validateProject,
  shouldIdleClose,
  run,
  main
};

//# debugId=6F4E6D913F86069B64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2FzdHJvbGFiZS9iYWNrZW5kL3NlcnZlci50cyIsICIuLi9zY3JpcHRzL3N0YXRlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIiMhL3Vzci9iaW4vZW52IGJ1blxuXG4vLyBhc3Ryb2xhYmUg4oCUIGEgc3RhbmRpbmcgb2JzZXJ2YXRvcnkgZGFlbW9uOiBvbmUgYm9hcmQgc2hvd2luZyB0aGUgbGl2ZSBzdGF0ZVxuLy8gb2YgZXZlcnkgcHJvamVjdCBpbiBmbGlnaHQgKGNvbmp1cmF0aW9uKS4gQSBsZXZlbCBBQk9WRSBncmFwZXZpbmUvYm91bnR5IOKAlFxuLy8gd2hlcmUgZ3JhcGV2aW5lIGlzIG9uZSB0ZWFtJ3MgY2hhbm5lbCBhbmQgYm91bnR5IGlzIG9uZSB0ZWFtJ3MgdGFzayBib2FyZCxcbi8vIHRoZSBvYnNlcnZhdG9yeSBpcyB0aGUgdmlldyBBQ1JPU1MgYWxsIG9mIHRoZW0uXG4vL1xuLy8gU0lOR0xFVE9OIHBlciAkQVNUUk9MQUJFX0hPTUUgKGNmLiBncmFwZXZpbmUpOiBvbmUgZGFlbW9uLCBvbmUgYm9hcmQuIGNsaS50c1xuLy8gYXV0by1zcGF3bnMgaXQgb24gdGhlIGZpcnN0IHZlcmIgYW5kIGRpc2NvdmVycyBpdCB2aWEgJEFTVFJPTEFCRV9IT01FL2RhZW1vbi4qLlxuLy9cbi8vIFRoZSBob3VzZSBhZ2VudC1pbnRlcmZhY2UgcGF0dGVybiAoc2hhcmVkIHdpdGggZ3JhcGV2aW5lICsgYm91bnR5KTogdGhlXG4vLyBkYWVtb24gaG9sZHMgY2Fub25pY2FsIHN0YXRlOyB0aGUgYWdlbnQgZHJpdmVzIGl0IHRocm91Z2ggYSB0aGluIGBjbGkudHNgXG4vLyBvdmVyIEhUVFAsIGFuZCB0aGUgYnJvd3NlciBpcyB3aXJlZCBvdmVyIFdlYlNvY2tldC5cbi8vICAgLSBBZ2VudCDihpIgZGFlbW9uOiAgUE9TVCAvY21kICAgICAgICAgICAgICAgICAgICAgICAgIChhbiBBZ2VudENvbW1hbmQ7IHdyaXRlIHBhdGgpXG4vLyAgIC0gQWdlbnQg4oaQIGRhZW1vbjogIEdFVCAgL3N0YXRlICAgICAgICAgICAgICAgICAgICAgICAoeyBzdGF0ZSwgY3Vyc29yIH0gcmVhZC1iYWNrKVxuLy8gICAgICAgICAgICAgICAgICAgICAgR0VUICAvZXZlbnRzP3NpbmNlPTxpZD4mcHJvamVjdD08aWQ+ICAoU1NFIHRhaWwsIHJlc3VtYWJsZSlcbi8vICAgLSBCcm93c2VyIOKGlCBkYWVtb246IFdlYlNvY2tldCAvd3MgICAgICAgICAgICAgICAgICAgIChmdWxsLXN0YXRlIHB1c2ggKyBsaXZlIGV2ZW50cylcbi8vXG4vLyBQRVJTSVNURU5DRSDigJQgdGhlIERVUkFCTEUgUkVHSVNUUlkgT05MWSAocHJvamVjdHMpIGlzIHNuYXBzaG90dGVkIHRvXG4vLyAkQVNUUk9MQUJFX0hPTUUvcmVnaXN0cnkuanNvbiBhbmQgcmVzdG9yZWQgb24gc3RhcnQuIFByZXNlbmNlIEFORCBzdGF0dXMgYXJlXG4vLyBMSVZFOiBhIHJlc3RvcmVkIGRhZW1vbiBzdGFydHMgd2l0aCBldmVyeSBwcm9qZWN0IGRpc2Nvbm5lY3RlZCBhbmQgbm8gc3RhdHVzXG4vLyB1bnRpbCBhZ2VudHMgcmVqb2luIGFuZCByZS1wb3N0IChzdGFsZSBwb3N0LXJlc3RhcnQgc3RhdHVzIHdvdWxkIG1pc2xlYWQpLlxuLy9cbi8vIFBSRVNFTkNFID0gdGhlIGxpdmUgY29ubmVjdGlvbiwgbm90IGEgY29tbWFuZC4gQSBwcm9qZWN0J3MgY2FyZCBpcyBcImFjdGl2ZVwiXG4vLyB3aGlsZSBhbiBhZ2VudCBob2xkcyBhIGBHRVQgL2V2ZW50cz9wcm9qZWN0PTxpZD5gIHRhaWwgb3BlbiAocmVmLWNvdW50ZWQsIHNvXG4vLyBpdCBzdGF5cyBhY3RpdmUgdW50aWwgdGhlIExBU1QgdGFpbCBjbG9zZXMpOyB0aGUgY29ubmVjdGlvbiBkcm9wcGluZyAoY2xlYW5cbi8vIGV4aXQgT1IgY3Jhc2gpIGZsaXBzIGl0IGlkbGUuIFNvIHRoZXJlIGlzIG5vIGBwcm9qZWN0LmpvaW5gIC9jbWQg4oCUIHByZXNlbmNlXG4vLyBjYW4ndCBiZSBhc3NlcnRlZCB3aXRob3V0IGhvbGRpbmcgdGhlIHdhdGNoLlxuLy9cbi8vIEFnZW50Q29tbWFuZCDigJQgUE9TVCAvY21kIGJvZHkgKG9uZSBvZikuIEFsbCBjYXJyeSBhbiBvcHRpb25hbCBgYXNgIChjYWxsZXJcbi8vIGlkZW50aXR5IOKGkiBldmVudCBgYnlgKTsgL2NtZCByZXR1cm5zIHtvaywgYXBwbGllZCwgZXJyb3I/fTpcbi8vICAge1widHlwZVwiOlwicHJvamVjdC5hZGRcIiwgICAgXCJwcm9qZWN0XCI6IFByb2plY3R9ICAgICAgICAgICAgICAgICAgICAgIC8vIHJlZ2lzdGVyIChkdXJhYmxlKTsgZGVkdXBlLWd1YXJkZWRcbi8vICAge1widHlwZVwiOlwicHJvamVjdC5yZW1vdmVcIiwgXCJpZFwiOiBcIi4uLlwifVxuLy8gICB7XCJ0eXBlXCI6XCJzdGF0dXNcIiwgICAgICAgICBcImlkXCI6IFwiLi4uXCIsIFwic3VtbWFyeVwiOiBcIi4uLlwiLCBcInBoYXNlXCI/OiBcIi4uLlwifSAgLy8gUkVQTEFDRVMgY3VycmVudCBzdGF0dXMgKG5vIGhpc3RvcnkpXG4vLyAgIHtcInR5cGVcIjpcImF0dGVudGlvblwiLCAgICAgIFwiaWRcIjogXCIuLi5cIiwgXCJyYWlzZWRcIjogYm9vbCwgXCJxdWVzdGlvblwiPzogXCIuLi5cIn0gLy8gYWdlbnQg4oaSIGh1bWFuIGdhdGVcbi8vICAge1widHlwZVwiOlwicG9rZVwiLCAgICAgICAgICAgXCJpZFwiOiBcIi4uLlwifSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gaHVtYW4g4oaSIGFnZW50OiByZXF1ZXN0IGEgZnJlc2ggc3RhdHVzIChldmVudCBvbmx5KVxuLy8gICB7XCJ0eXBlXCI6XCJjbG9zZVwifSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIGRpc21pc3MgdGhlIG9ic2VydmF0b3J5XG4vL1xuLy8gRXZlbnQgbG9nIOKAlCBHRVQgL2V2ZW50cyBmcmFtZXMgKHNlcnZlciDihpIgYWdlbnQpLCBlYWNoIHdpdGggYSBtb25vdG9uaWMgYGlkYFxuLy8gKHRoZSByZXN1bWUgY3Vyc29yKSBhbmQgYW4gYWN0b3IgYGJ5YDpcbi8vICAge2lkLCB0eXBlOlwicmVhZHlcIiwgICAgICAgIHVybCwgcG9ydCwgc2Vzc2lvbl9pZCwgbW9kZSwgYnk6XCJzeXN0ZW1cIn0gICAvLyBtb2RlOiBkZXZ8cmVsZWFzZVxuLy8gICB7aWQsIHR5cGU6XCJjb25uZWN0ZWRcIiB8IFwiZGlzY29ubmVjdGVkXCIsIGJ5OlwidXNlclwifSAgICAgICAgICAgICAgICAvLyBicm93c2VyIHdhdGNoIHByZXNlbmNlXG4vLyAgIHtpZCwgdHlwZTpcInByb2plY3QuYWRkXCIsICBwcm9qZWN0LCBieX1cbi8vICAge2lkLCB0eXBlOlwicHJvamVjdC5yZW1vdmVcIiwgcHJvamVjdElkLCBieX1cbi8vICAge2lkLCB0eXBlOlwicHJlc2VuY2VcIiwgICAgIHByb2plY3RJZCwgY29ubmVjdGVkLCBieTpcInN5c3RlbVwifSAgICAgIC8vIFNTRSB0YWlsIG9wZW4vY2xvc2Vcbi8vICAge2lkLCB0eXBlOlwic3RhdHVzXCIsICAgICAgIHByb2plY3RJZCwgc3VtbWFyeSwgcGhhc2U/LCBieX1cbi8vICAge2lkLCB0eXBlOlwiYXR0ZW50aW9uXCIsICAgIHByb2plY3RJZCwgcmFpc2VkLCBxdWVzdGlvbj8sIGJ5fVxuLy8gICB7aWQsIHR5cGU6XCJwb2tlXCIsICAgICAgICAgcHJvamVjdElkLCBieX0gICAgICAgICAgICAgICAgICAgICAgICAgIC8vIHRoZSBwcm9qZWN0J3MgbGlzdGVuaW5nIGFnZW50IHJlYWN0c1xuLy8gICB7aWQsIHR5cGU6XCJjbG9zZWRcIiwgICAgICAgcmVhc29uLCBieTpcInN5c3RlbVwifSAgICAgICAgICAgICAgICAgICAgLy8gcmVhc29uOiB1c2VyfHRpbWVvdXR8Y2xvc2Vcbi8vXG4vLyBFeGl0IGNvZGVzOiAwIG9uIGFueSBjbGVhbiBkaXNtaXNzLCAyIGJhZCBhcmdzLCAxMjQgaWRsZSB0aW1lb3V0LiBUaGVcbi8vIG9ic2VydmF0b3J5IGlzIGEgY29uanVyYXRpb24g4oCUIHRoZXJlJ3Mgbm8gXCJjYW5jZWxcIi8xMzAgZGlzY2FyZCBwYXRoLlxuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgdW5saW5rU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5pbXBvcnQgdHlwZSB7IFNlcnZlcldlYlNvY2tldCB9IGZyb20gXCJidW5cIjtcbmltcG9ydCB7XG4gIGFwcGx5QXR0ZW50aW9uLFxuICBhcHBseVByb2plY3RBZGQsXG4gIGFwcGx5UHJvamVjdFJlbW92ZSxcbiAgYXBwbHlTZXRQcmVzZW5jZSxcbiAgYXBwbHlTdGF0dXMsXG4gIGVtcHR5U3RhdGUsXG4gIHR5cGUgT2JzZXJ2YXRvcnlTdGF0ZSxcbiAgdHlwZSBQcm9qZWN0LFxufSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2FzdHJvbGFiZS9zY3JpcHRzL3N0YXRlLnRzXCI7XG5cbmV4cG9ydCB0eXBlIHtcbiAgT2JzZXJ2YXRvcnlTdGF0ZSxcbiAgUHJvamVjdCxcbn0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9hc3Ryb2xhYmUvc2NyaXB0cy9zdGF0ZS50c1wiO1xuXG4vLyDilIDilIAgc3VyZmFjZSBtb2RlIChzZWFtcyBDb250cmFjdCAxKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyBUaGUgc3VyZmFjZSByZWFjaGVzIHRoZSBkYWVtb24gdHdvIHdheXMgYW5kIE9OTFkgT05FIG9mIHRoZW0gbWF5IHNpdCBvbiB0aGVcbi8vIG1vZHVsZSBsb2FkIHBhdGguIGBpbXBvcnQgaW5kZXggZnJvbSBcIi4uL3N1cmZhY2UvaW5kZXguaHRtbFwiYCB1c2VkIHRvIGJlIGFcbi8vIHRvcC1sZXZlbCBTVEFUSUMgaW1wb3J0IGhlcmU6IHRoYXQgZm9yY2VzIEJ1biB0byByZXNvbHZlIHRoZSB3aG9sZSAudHN4ICtcbi8vIFRhaWx3aW5kIGJ1aWxkIGdyYXBoIHdoZW4gdGhlIG1vZHVsZSBMT0FEUywgc28gYSBkZXN0aW5hdGlvbiB0aGF0IHNoaXBzXG4vLyBgZGlzdC9gIGFuZCBubyBgc3VyZmFjZS9gIOKAlCB0aGUgcHVibGlzaGVkIGFydGlmYWN0IOKAlCBkaWVzIGJlZm9yZSBpdCBjYW4gc2VydmVcbi8vIHRoZSBkaXN0IGl0IGRvZXMgaGF2ZS4gVGhlIGRldiBpbXBvcnQgYmVsb3cgaXMgdGhlcmVmb3JlIGR5bmFtaWMgYW5kIGluc2lkZVxuLy8gdGhlIHJlbGVhc2UgYnJhbmNoJ3MgYGVsc2VgLCBleGFjdGx5IGFzIG1pbmQtbWFwcGVyL3NjcmlwdHMvc2VydmVyLnRzIGRvZXMgaXQuXG4vL1xuLy8gUGF0aHMgYXJlIGFuY2hvcmVkIGF0IHRoZSBTS0lMTCBST09ULCBuZXZlciBhdCBjd2Q6IGNsaS50cyBwaW5zIHRoZSBkYWVtb24nc1xuLy8gY3dkIGZvciBidW5maWcudG9tbCdzIHNha2UgKENvbnRyYWN0IDUpLCBzbyBjd2QgaXMgbm90IGEgc3RhYmxlIGJhc2UgZm9yXG4vLyBkaXN0Ly5cbi8vXG4vLyDim5QgYGltcG9ydC5tZXRhLmRpcmAgSEVSRSBJUyBUSEUgRElSRUNUT1JZIE9GIFRIRSBFTUlUVEVEIEJVTkRMRSwgTk9UIE9GIFRISVNcbi8vIEZJTEUuIFRoaXMgbW9kdWxlIGlzIEFVVEhPUkVEIGF0IGBzcmMvYXN0cm9sYWJlL2JhY2tlbmQvc2VydmVyLnRzYCBhbmRcbi8vIEVYRUNVVEVTIGFzIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvYXN0cm9sYWJlL2Rpc3Qvc2VydmVyLmpzYCAoUGhhc2UgMWIpLlxuLy8gYGRpc3QvYCBzaXRzIGF0IHRoZSBTQU1FIERFUFRIIGFzIGBzY3JpcHRzL2AsIHNvIGV2ZXJ5IEFOQ0VTVE9SLXJlbGF0aXZlIHBhdGhcbi8vIGJlbG93IGlzIHVuY2hhbmdlZCBieSB0aGUgbW92ZSDigJQgdGhlIHNhbWUgXCJ1cCBhbmQgYmFjayBkb3duIGlzIGNvcnJlY3QgZnJvbVxuLy8gQk9USCBsb2NhdGlvbnNcIiB0cmljayBgY2xpLnRzYCByZWNvcmRzLiBBIFNJQkxJTkctcmVsYXRpdmUgcGF0aCB3b3VsZCBOT1QgYmU7XG4vLyBzZWUgYG1hZ3BpZS9iYWNrZW5kL2JhY2tlbmQudHNgJ3MgcmVtb3ZlLnB5LCB3aGljaCBpcyB3aGVyZSB0aGF0IHdlbnQgd3Jvbmdcbi8vIGZvciByZWFsLiBBc3NlcnRlZCBpbiBgc2VydmVyLnRlc3QudHNgLCBub3QgcmVhc29uZWQgYWJvdXQuXG5jb25zdCBTQ1JJUFRfRElSID0gaW1wb3J0Lm1ldGEuZGlyO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG5cbi8vIHJlbGVhc2UgaWZmIGRpc3QvaW5kZXguaHRtbCBleGlzdHMgYXQgdGhlIHNraWxsIHJvb3QsIGVsc2UgZGV2OyB0aGUgZW52XG4vLyBvdmVycmlkZSB3aW5zIGVpdGhlciB3YXkgKHNlYW1zIENvbnRyYWN0IDEpLiBSZWxlYXNlOiB6ZXJvIHJlYWRzIG9mIHN1cmZhY2UvXG4vLyBvciBidW5maWcudG9tbCDigJQgc3RhdGljIGZpbGVzIG9ubHkuXG5mdW5jdGlvbiByZXNvbHZlTW9kZSgpOiBcImRldlwiIHwgXCJyZWxlYXNlXCIge1xuICBjb25zdCBvdmVycmlkZSA9IHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREU7XG4gIGlmIChvdmVycmlkZSA9PT0gXCJkZXZcIiB8fCBvdmVycmlkZSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBvdmVycmlkZTtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFwicmVsZWFzZVwiIDogXCJkZXZcIjtcbn1cblxuY29uc3QgU1RBVElDX0NPTlRFTlRfVFlQRVM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiLmh0bWxcIjogXCJ0ZXh0L2h0bWxcIixcbiAgXCIuanNcIjogXCJ0ZXh0L2phdmFzY3JpcHRcIixcbiAgXCIuY3NzXCI6IFwidGV4dC9jc3NcIixcbiAgXCIuanNvblwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbn07XG5cbi8vIFNlcnZlcyBkaXN0LyB2ZXJiYXRpbSDigJQgZW50cnkgaW5kZXguaHRtbCwgaGFzaGVkIGNodW5rLSouanMvY3NzIGJ5IHBhdGhcbi8vIChDb250cmFjdCAyJ3MgZmxhdCwgcmVsYXRpdmUtaHJlZiBsYXlvdXQpLiBQYXRoIHRyYXZlcnNhbCBndWFyZGVkIChhIHN0YXRpY1xuLy8gYXNzZXQgcmVxdWVzdCBpcyBhbHdheXMgYSBiYXJlIGZpbGVuYW1lLCBuZXZlciBuZXN0ZWQpLlxuZnVuY3Rpb24gc2VydmVEaXN0KHBhdGg6IHN0cmluZyk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIGNvbnN0IHJlbCA9IHBhdGggPT09IFwiL1wiID8gXCJpbmRleC5odG1sXCIgOiBwYXRoLnNsaWNlKDEpO1xuICBpZiAocmVsLmluY2x1ZGVzKFwiLi5cIikgfHwgcmVsLmluY2x1ZGVzKFwiL1wiKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGZpbGUgPSBqb2luKERJU1RfRElSLCByZWwpO1xuICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIHJldHVybiBudWxsO1xuICBjb25zdCBleHQgPSByZWwuc2xpY2UocmVsLmxhc3RJbmRleE9mKFwiLlwiKSk7XG4gIHJldHVybiBuZXcgUmVzcG9uc2UoQnVuLmZpbGUoZmlsZSksIHtcbiAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFNUQVRJQ19DT05URU5UX1RZUEVTW2V4dF0gPz8gXCJhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1cIiB9LFxuICB9KTtcbn1cblxuLy8gUGVyc2lzdGVuY2UgKyBkaXNjb3Zlcnkgcm9vdC4gY2xpLnRzIGRlcml2ZXMgdGhlIHNhbWUgcGF0aCwgc28gb3ZlcnJpZGluZ1xuLy8gQVNUUk9MQUJFX0hPTUUgcmVsb2NhdGVzIGJvdGggdGhlIHJlZ2lzdHJ5IHNuYXBzaG90IGFuZCB0aGUgZGFlbW9uLiogZmlsZXMuXG5jb25zdCBBU1RST0xBQkVfSE9NRSA9IHByb2Nlc3MuZW52LkFTVFJPTEFCRV9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5hc3Ryb2xhYmVcIik7XG5jb25zdCBSRUdJU1RSWV9GSUxFID0gam9pbihBU1RST0xBQkVfSE9NRSwgXCJyZWdpc3RyeS5qc29uXCIpO1xuY29uc3QgUE9SVF9GSUxFID0gam9pbihBU1RST0xBQkVfSE9NRSwgXCJkYWVtb24ucG9ydFwiKTtcbmNvbnN0IFBJRF9GSUxFID0gam9pbihBU1RST0xBQkVfSE9NRSwgXCJkYWVtb24ucGlkXCIpO1xuXG4vLyBDb25uZWN0aW9uIGtlZXBhbGl2ZSAocHJlc2VuY2UtZmxhcCBmaXgpLiBCdW4uc2VydmUgY2xvc2VzIGEgY29ubmVjdGlvbiBpZGxlXG4vLyBmb3IgYGlkbGVUaW1lb3V0YCBzZWNvbmRzOyBhIGhlbGQgYGpvaW5gIFNTRSB0aGF0IG9ubHkgaGVhcnRiZWF0cyBTTE9XRVIgdGhhblxuLy8gdGhhdCBnZXRzIGNsb3NlZCBhdCB0aGUgdGltZW91dCwgdGhlIGNsaSByZWNvbm5lY3RzLCBhbmQgdGhlIHJlY29ubmVjdCBmbGlwc1xuLy8gcHJlc2VuY2UgZGlzY29ubmVjdOKGkmNvbm5lY3Qg4oCUIGZsaWNrZXJpbmcgdGhlIGNhcmQgZXZlcnkgaWRsZSB3aW5kb3cgYW5kXG4vLyBmbG9vZGluZyB0aGUgZXZlbnQgbG9nLiBTbyB0aGUgaGVhcnRiZWF0IE1VU1Qgc3RheSB3ZWxsIHVuZGVyIGlkbGVUaW1lb3V0LlxuLy8gQm90aCBhcmUgZW52LXR1bmFibGUgKHRlc3RzIGRyaXZlIGEgc2hvcnQgd2luZG93KTsgdGhlIGhlYXJ0YmVhdCBpcyBjbGFtcGVkXG4vLyB0byDiiaQgaGFsZiB0aGUgaWRsZSB0aW1lb3V0IHNvIHRoZSBpbnZhcmlhbnQgaG9sZHMgZm9yIGFueSBjb25maWd1cmVkIHZhbHVlLlxuY29uc3QgSURMRV9USU1FT1VUX1NFQyA9IE1hdGgubWF4KFxuICAxLFxuICBNYXRoLm1pbigyNTUsIE51bWJlci5wYXJzZUludChwcm9jZXNzLmVudi5BU1RST0xBQkVfSURMRV9USU1FT1VUID8/IFwiMjU1XCIsIDEwKSB8fCAyNTUpLFxuKTtcbmNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBNYXRoLm1pbihcbiAgTnVtYmVyLnBhcnNlSW50KHByb2Nlc3MuZW52LkFTVFJPTEFCRV9IRUFSVEJFQVRfTVMgPz8gXCIxMDAwMFwiLCAxMCkgfHwgMTAwMDAsXG4gIE1hdGgubWF4KDUwMCwgTWF0aC5mbG9vcigoSURMRV9USU1FT1VUX1NFQyAqIDEwMDApIC8gMikpLFxuKTtcbi8vIEhvdyBsb25nIHRvIGRlZmVyIGEgcHJlc2VuY2UgaWRsZS1mbGlwOyBhIHJlY29ubmVjdCB3aXRoaW4gdGhpcyB3aW5kb3cgY2FuY2Vsc1xuLy8gaXQgKHNlZSBpZGxlVGltZXJzKS4gVHVuYWJsZSBmb3IgdGVzdHMuXG5jb25zdCBQUkVTRU5DRV9ERUJPVU5DRV9NUyA9XG4gIE51bWJlci5wYXJzZUludChwcm9jZXNzLmVudi5BU1RST0xBQkVfUFJFU0VOQ0VfREVCT1VOQ0VfTVMgPz8gXCIyNTAwXCIsIDEwKSB8fCAyNTAwO1xuXG50eXBlIERvbmVSZXN1bHQgPSB7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmcgfTtcbi8vIGIyLyM4NSDigJQgYG91dGNvbWVgIGNhcnJpZXMgYSBiZW5pZ24gbm8tb3AncyBOT1VOIChhbHJlYWR5LWNvbm5lY3RlZCxcbi8vIGFscmVhZHktcmFpc2VkLCDigKYpLiBBIG5vLW9wIGhhcyBubyBgZXJyb3JgOyB0aGUgdHdvIHRvZ2V0aGVyIGFyZSB3aGF0IGxldCBhXG4vLyBjYWxsZXIgdGVsbCBcInRoZSBzdGF0ZSB3YXMgYWxyZWFkeSB3aGF0IEkgYXNrZWQgZm9yXCIgZnJvbSBcIkkgd2FzIHJlamVjdGVkXCIuXG50eXBlIEFwcGx5UmVzdWx0ID0ge1xuICBvazogYm9vbGVhbjtcbiAgYXBwbGllZDogYm9vbGVhbjtcbiAgZXJyb3I/OiBzdHJpbmc7XG4gIGlkPzogc3RyaW5nO1xuICBvdXRjb21lPzogc3RyaW5nO1xufTtcblxuLy8g4pSA4pSAIHB1cmUgaGVscGVycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuLy8gVGhlIHNpbmdsZSBwcm9qZWN0LXNoYXBlIHRydXN0IGJvdW5kYXJ5IOKAlCB0aGUgYWdlbnQgL2NtZCBwYXRoIGFuZCBhIHJlc3RvcmVkXG4vLyByZWdpc3RyeSBib3RoIHBhc3MgdW50cnVzdGVkIG9iamVjdHMgdGhyb3VnaCBoZXJlIChmaWx0ZXItYW5kLWtlZXAtdmFsaWQpLlxuZnVuY3Rpb24gdmFsaWRhdGVQcm9qZWN0KHA6IHVua25vd24pOiBQcm9qZWN0IHwgbnVsbCB7XG4gIGlmICghcCB8fCB0eXBlb2YgcCAhPT0gXCJvYmplY3RcIikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IG8gPSBwIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBpZiAodHlwZW9mIG8ubmFtZSAhPT0gXCJzdHJpbmdcIiB8fCBvLm5hbWUudHJpbSgpID09PSBcIlwiKSByZXR1cm4gbnVsbDtcbiAgaWYgKHR5cGVvZiBvLnBhdGggIT09IFwic3RyaW5nXCIgfHwgby5wYXRoLnRyaW0oKSA9PT0gXCJcIikgcmV0dXJuIG51bGw7XG4gIC8vIGlkIGlzIG9wdGlvbmFsIG9uIHRoZSB3YXkgaW4g4oCUIGFwcGx5UHJvamVjdEFkZCBkZXJpdmVzIGl0IGZyb20gdGhlIG5hbWUgd2hlblxuICAvLyBhYnNlbnQgKGEgcmVzdG9yZWQgcmVnaXN0cnkgZW50cnkgYWxyZWFkeSBjYXJyaWVzIG9uZSkuXG4gIGNvbnN0IG91dDogUHJvamVjdCA9IHsgaWQ6IHR5cGVvZiBvLmlkID09PSBcInN0cmluZ1wiID8gby5pZCA6IFwiXCIsIG5hbWU6IG8ubmFtZSwgcGF0aDogby5wYXRoIH07XG4gIGlmICh0eXBlb2Ygby5kZXNjcmlwdGlvbiA9PT0gXCJzdHJpbmdcIikgb3V0LmRlc2NyaXB0aW9uID0gby5kZXNjcmlwdGlvbjtcbiAgaWYgKHR5cGVvZiBvLmF2YXRhciA9PT0gXCJzdHJpbmdcIikgb3V0LmF2YXRhciA9IG8uYXZhdGFyO1xuICByZXR1cm4gb3V0O1xufVxuXG5mdW5jdGlvbiBvcGVuQnJvd3Nlcih1cmw6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBjbWQgPVxuICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCIgPyBcIm9wZW5cIiA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiA/IFwic3RhcnRcIiA6IFwieGRnLW9wZW5cIjtcbiAgdHJ5IHtcbiAgICBCdW4uc3Bhd24oW2NtZCwgdXJsXSwgeyBzdGRvdXQ6IFwiaWdub3JlXCIsIHN0ZGVycjogXCJpZ25vcmVcIiB9KTtcbiAgfSBjYXRjaCB7XG4gICAgLyogYmVzdC1lZmZvcnQgKi9cbiAgfVxufVxuXG4vLyBTaG91bGQgdGhlIHN0YW5kaW5nIGRhZW1vbiBpZGxlLWNsb3NlPyBPbmx5IG9uY2UgdGhlIExBU1Qgc3Vic2NyaWJlciBoYXMgbGVmdFxuLy8gQU5EIGEgcG9zaXRpdmUgdGltZW91dCBpcyBjb25maWd1cmVkIChkZWZhdWx0IDAgPSBuZXZlcjsgYSBzaW5nbGV0b25cbi8vIG9ic2VydmF0b3J5IGlzIG1lYW50IHRvIHN0YW5kIHVudGlsIGV4cGxpY2l0bHkgY2xvc2VkKS5cbmZ1bmN0aW9uIHNob3VsZElkbGVDbG9zZShzdWJzY3JpYmVyQ291bnQ6IG51bWJlciwgaWRsZU1zOiBudW1iZXIsIHRpbWVvdXRNczogbnVtYmVyKTogYm9vbGVhbiB7XG4gIHJldHVybiB0aW1lb3V0TXMgPiAwICYmIHN1YnNjcmliZXJDb3VudCA9PT0gMCAmJiBpZGxlTXMgPj0gdGltZW91dE1zO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgbGV0IHBhcnNlZDogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VBcmdzPjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBwYXJzZUFyZ3Moe1xuICAgICAgYXJnczogYXJndixcbiAgICAgIG9wdGlvbnM6IHtcbiAgICAgICAgdGl0bGU6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVmYXVsdDogXCJPYnNlcnZhdG9yeVwiIH0sXG4gICAgICAgIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVmYXVsdDogXCIwXCIgfSwgLy8gMCA9IHN0YW5kaW5nIChuZXZlciBpZGxlLWNsb3NlKVxuICAgICAgICBcIm5vLW9wZW5cIjogeyB0eXBlOiBcImJvb2xlYW5cIiwgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgICAgcG9ydDogeyB0eXBlOiBcInN0cmluZ1wiLCBkZWZhdWx0OiBcIjBcIiB9LFxuICAgICAgICBob3N0OiB7IHR5cGU6IFwic3RyaW5nXCIsIGRlZmF1bHQ6IFwiMTI3LjAuMC4xXCIgfSxcbiAgICAgIH0sXG4gICAgICBzdHJpY3Q6IHRydWUsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiBmYWxzZSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBlcnJvcjogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuYCk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3QgdiA9IHBhcnNlZC52YWx1ZXM7XG4gIGNvbnN0IHRpbWVvdXQgPSBOdW1iZXIucGFyc2VGbG9hdCh2LnRpbWVvdXQgYXMgc3RyaW5nKTtcbiAgY29uc3QgcG9ydCA9IE51bWJlci5wYXJzZUludCh2LnBvcnQgYXMgc3RyaW5nLCAxMCk7XG4gIGNvbnN0IGhvc3QgPSB2Lmhvc3QgYXMgc3RyaW5nO1xuXG4gIC8vIEluaXRpYWwgc3RhdGUg4oCUIHRoZSBkdXJhYmxlIHJlZ2lzdHJ5IHJlc3RvcmVkIChtZXJnZS1vdmVyLWRlZmF1bHRzIHNvIGFuXG4gIC8vIG9sZGVyIHNuYXBzaG90IGdhaW5zIG5ldyBmaWVsZHMgd2l0aG91dCBjcmFzaGluZzsgZWFjaCBwcm9qZWN0IHJ1bnMgdGhyb3VnaFxuICAvLyB2YWxpZGF0ZVByb2plY3Qgc28gYSBtYWxmb3JtZWQgZW50cnkgaXMgZHJvcHBlZCwgbm90IGZhdGFsKS4gUHJlc2VuY2UgYW5kXG4gIC8vIHN0YXR1cyBzdGFydCBFTVBUWSAobGl2ZSBsYXllcnMg4oCUIG5ldmVyIHBlcnNpc3RlZCkuXG4gIGxldCBzdGF0ZTogT2JzZXJ2YXRvcnlTdGF0ZSA9IGVtcHR5U3RhdGUodi50aXRsZSBhcyBzdHJpbmcpO1xuICBpZiAoZXhpc3RzU3luYyhSRUdJU1RSWV9GSUxFKSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzbmFwID0gSlNPTi5wYXJzZShhd2FpdCBCdW4uZmlsZShSRUdJU1RSWV9GSUxFKS50ZXh0KCkpIGFzIFBhcnRpYWw8T2JzZXJ2YXRvcnlTdGF0ZT47XG4gICAgICBpZiAodHlwZW9mIHNuYXAudGl0bGUgPT09IFwic3RyaW5nXCIpIHN0YXRlLnRpdGxlID0gc25hcC50aXRsZTtcbiAgICAgIGlmIChBcnJheS5pc0FycmF5KHNuYXAucHJvamVjdHMpKSB7XG4gICAgICAgIGZvciAoY29uc3QgcmF3IG9mIHNuYXAucHJvamVjdHMpIHtcbiAgICAgICAgICBjb25zdCBwID0gdmFsaWRhdGVQcm9qZWN0KHJhdyk7XG4gICAgICAgICAgaWYgKHApIHN0YXRlID0gYXBwbHlQcm9qZWN0QWRkKHN0YXRlLCBwKS5zdGF0ZTsgLy8gZGVkdXBlLWd1YXJkZWQgb24gdGhlIHdheSBpblxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGBhc3Ryb2xhYmU6IHJlZ2lzdHJ5IHJlc3RvcmUgZmFpbGVkOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG5gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBzb2NrZXRzID0gbmV3IFNldDxTZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4+KCk7XG5cbiAgLy8gQXBwZW5kLW9ubHkgZXZlbnQgbG9nIGZvciB0aGUgYWdlbnQgU1NFIHRhaWwgKEdFVCAvZXZlbnRzKS4gTW9ub3RvbmljIGBpZGBcbiAgLy8gaXMgdGhlIHJlc3VtZSBjdXJzb3IgKD9zaW5jZT08aWQ+KTsgYGN1cnNvcmAgaW4gR0VUIC9zdGF0ZSBpcyB0aGUgY3VycmVudFxuICAvLyBldmVudFNlcS5cbiAgY29uc3QgZXZlbnRzOiBBcnJheTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4gPSBbXTtcbiAgbGV0IGV2ZW50U2VxID0gMDtcbiAgY29uc3QgZW5jID0gbmV3IFRleHRFbmNvZGVyKCk7XG4gIGNvbnN0IHNzZUNsaWVudHMgPSBuZXcgU2V0PFJlYWRhYmxlU3RyZWFtRGVmYXVsdENvbnRyb2xsZXI+KCk7XG4gIGNvbnN0IHNzZVRpbWVycyA9IG5ldyBTZXQ8UmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+PigpO1xuXG4gIC8vIFBlci1wcm9qZWN0IFNTRSBjb25uZWN0aW9uIGNvdW50cyDihpIgcHJlc2VuY2UgaXMgY29ubmVjdGVkIHdoaWxlIOKJpTEgdGFpbCBpc1xuICAvLyBvcGVuLCBpZGxlIG9uY2UgdGhlIGxhc3QgY2xvc2VzIChyZWYtY291bnRlZCBzbyB0d28gd2F0Y2hlcnMgZG9uJ3QgZmlnaHQpLlxuICBjb25zdCBwcm9qZWN0Q29ubnMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICAvLyBQZW5kaW5nIGlkbGUtZmxpcCB0aW1lcnMgKHByZXNlbmNlLWRpc2Nvbm5lY3QgZGVib3VuY2UpLiBBIGxvbmctbGl2ZWQgam9pbidzXG4gIC8vIFNTRSBpcyByZWNvbm5lY3RlZCBwZXJpb2RpY2FsbHkgKEJ1biBjbG9zZXMgYSBjb25uZWN0aW9uIGlkbGUgcGFzdFxuICAvLyBpZGxlVGltZW91dCwgYW5kIHNlcnZlciBoZWFydGJlYXRzIGRvbid0IHJlc2V0IHRoYXQpLCBzbyB0aGUgaWRsZSBmbGlwIGlzXG4gIC8vIERFRkVSUkVEIOKAlCBhIHJlY29ubmVjdCB3aXRoaW4gdGhlIHdpbmRvdyBjYW5jZWxzIGl0IGFuZCB0aGUgY2FyZCBuZXZlclxuICAvLyBmbGlja2VycyBhY3RpdmXihpRpZGxlLiBBbHNvIGFic29yYnMgdHJhbnNpZW50IG5ldHdvcmsgZHJvcHMuXG4gIGNvbnN0IGlkbGVUaW1lcnMgPSBuZXcgTWFwPHN0cmluZywgUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4+KCk7XG5cbiAgLy8gRGVib3VuY2VkIHBlcnNpc3RlbmNlIG9mIHRoZSBEVVJBQkxFIFJFR0lTVFJZIE9OTFkuIE9ubHkgcHJvamVjdC5hZGQgL1xuICAvLyBwcm9qZWN0LnJlbW92ZSBkaXJ0eSBpdDsgc3RhdHVzL2F0dGVudGlvbi9wcmVzZW5jZSBhcmUgbGl2ZSwgbmV2ZXIgc2F2ZWQuXG4gIGxldCBzbmFwRGlydHkgPSBmYWxzZTtcbiAgY29uc3Qgc2F2ZVJlZ2lzdHJ5ID0gYXN5bmMgKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmMoQVNUUk9MQUJFX0hPTUUsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgYXdhaXQgQnVuLndyaXRlKFxuICAgICAgICBSRUdJU1RSWV9GSUxFLFxuICAgICAgICBKU09OLnN0cmluZ2lmeSh7IHRpdGxlOiBzdGF0ZS50aXRsZSwgcHJvamVjdHM6IHN0YXRlLnByb2plY3RzIH0pLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHBlcnNpc3RlbmNlIGlzIGJlc3QtZWZmb3J0ICovXG4gICAgfVxuICB9O1xuICBjb25zdCBESVJUWUlORyA9IG5ldyBTZXQoW1wicHJvamVjdC5hZGRcIiwgXCJwcm9qZWN0LnJlbW92ZVwiXSk7XG5cbiAgbGV0IHJlc29sdmVEb25lITogKHZhbDogRG9uZVJlc3VsdCkgPT4gdm9pZDtcbiAgbGV0IHNldHRsZWQgPSBmYWxzZTtcbiAgY29uc3QgZG9uZSA9IG5ldyBQcm9taXNlPERvbmVSZXN1bHQ+KChyZXMpID0+IHtcbiAgICByZXNvbHZlRG9uZSA9ICh2YWwpID0+IHtcbiAgICAgIGlmIChzZXR0bGVkKSByZXR1cm47XG4gICAgICBzZXR0bGVkID0gdHJ1ZTtcbiAgICAgIHJlcyh2YWwpO1xuICAgIH07XG4gIH0pO1xuXG4gIGxldCBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgY29uc3QgdG91Y2ggPSAoKSA9PiB7XG4gICAgbGFzdEFjdGl2aXR5ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gIH07XG5cbiAgLy8gVGhlIC9zdGF0ZSBwcm9qZWN0aW9uIOKAlCBtZXJnZXMgdGhlIHRocmVlIGxheWVycyBpbnRvIGFnZW50LWZhY2luZyBjYXJkc1xuICAvLyAocmVhZGJhY2stcGFyaXR5OiBhbiBhZ2VudCByZWFkaW5nIGBzdGF0ZWAgc2VlcyB3aGF0IHRoZSBzdXJmYWNlIHJlbmRlcnMpLlxuICAvLyBgem9uZWAgaXMgdGhlIGNvYXJzZSBmbG9vciAoYXR0ZW50aW9uID4gYWN0aXZlID4gcXVpZXQpOyB0NSdzIHN1cmZhY2VcbiAgLy8gcmVmaW5lcyBpZGxlL3N0YWxlL2RvbmUgZnJvbSBgY29ubmVjdGVkYCArIGBsYXN0VXBkYXRlZGAuXG4gIGZ1bmN0aW9uIHByb2plY3RDYXJkcygpIHtcbiAgICByZXR1cm4gc3RhdGUucHJvamVjdHMubWFwKChwKSA9PiB7XG4gICAgICBjb25zdCBjb25uZWN0ZWQgPSBzdGF0ZS5wcmVzZW5jZVtwLmlkXT8uY29ubmVjdGVkID8/IGZhbHNlO1xuICAgICAgY29uc3Qgc3QgPSBzdGF0ZS5zdGF0dXNbcC5pZF07XG4gICAgICBjb25zdCBuZWVkc0F0dGVudGlvbiA9IHN0Py5uZWVkc0F0dGVudGlvbiA/PyBmYWxzZTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIC4uLnAsXG4gICAgICAgIGNvbm5lY3RlZCxcbiAgICAgICAgbmVlZHNBdHRlbnRpb24sXG4gICAgICAgIHF1ZXN0aW9uOiBuZWVkc0F0dGVudGlvbiA/IHN0Py5xdWVzdGlvbiA6IHVuZGVmaW5lZCxcbiAgICAgICAgc3RhdHVzOiBzdCA/IHsgc3VtbWFyeTogc3Quc3VtbWFyeSwgcGhhc2U6IHN0LnBoYXNlLCBsYXN0VXBkYXRlZDogc3QubGFzdFVwZGF0ZWQgfSA6IG51bGwsXG4gICAgICAgIHpvbmU6IG5lZWRzQXR0ZW50aW9uID8gXCJhdHRlbnRpb25cIiA6IGNvbm5lY3RlZCA/IFwiYWN0aXZlXCIgOiBcInF1aWV0XCIsXG4gICAgICB9O1xuICAgIH0pO1xuICB9XG4gIGNvbnN0IHByb2plY3RTdGF0ZSA9ICgpID0+ICh7IHRpdGxlOiBzdGF0ZS50aXRsZSwgcHJvamVjdHM6IHByb2plY3RDYXJkcygpIH0pO1xuXG4gIGZ1bmN0aW9uIGJyb2FkY2FzdFN0YXRlKCkge1xuICAgIGNvbnN0IHMgPSBKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwic3RhdGVcIiwgLi4ucHJvamVjdFN0YXRlKCkgfSk7XG4gICAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzKSB7XG4gICAgICB0cnkge1xuICAgICAgICB3cy5zZW5kKHMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHNvY2tldCBjbG9zZWQgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBBcHBlbmQgYSBmcmFtZSB0byB0aGUgYWdlbnQgZXZlbnQgbG9nICsgcHVzaCB0byBsaXZlIFNTRSB0YWlscy4gVGhlXG4gIC8vIG1vbm90b25pYyBgaWRgIE1VU1Qgd2luIG92ZXIgYW55IGBpZGAgaW4gdGhlIHBheWxvYWQsIHNvIGNhbGxlcnMgY2FycnkgYVxuICAvLyBwcm9qZWN0IGlkZW50aWZpZXIgYXMgYHByb2plY3RJZGAsIG5ldmVyIGBpZGAuXG4gIGZ1bmN0aW9uIGVtaXRFdmVudChtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gICAgY29uc3QgZXYgPSB7IGlkOiArK2V2ZW50U2VxLCAuLi5tc2cgfTtcbiAgICBldmVudHMucHVzaChldik7XG4gICAgaWYgKHR5cGVvZiBtc2cudHlwZSA9PT0gXCJzdHJpbmdcIiAmJiBESVJUWUlORy5oYXMobXNnLnR5cGUpKSBzbmFwRGlydHkgPSB0cnVlO1xuICAgIGNvbnN0IGZyYW1lID0gZW5jLmVuY29kZShgZGF0YTogJHtKU09OLnN0cmluZ2lmeShldil9XFxuXFxuYCk7XG4gICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGMuZW5xdWV1ZShmcmFtZSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogY2xpZW50IGdvbmUgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBBIHNjb3BlZCB0YWlsIG9wZW5pbmcvY2xvc2luZyBkcml2ZXMgcHJlc2VuY2UgKHJlZi1jb3VudGVkKS4gT24gdGhlIDDihpIxXG4gIC8vIGVkZ2UgdGhlIHByb2plY3QgZ29lcyBjb25uZWN0ZWQ7IG9uIDHihpIwIHRoZSBpZGxlIGZsaXAgaXMgREVCT1VOQ0VELlxuICBmdW5jdGlvbiBwcmVzZW5jZUNvbm5lY3QocHJvamVjdElkOiBzdHJpbmcpIHtcbiAgICAvLyBBIChyZSljb25uZWN0IGNhbmNlbHMgYW55IHBlbmRpbmcgaWRsZSBmbGlwIOKAlCBzbyBhIHJlY29ubmVjdCBpbnNpZGUgdGhlXG4gICAgLy8gZGVib3VuY2Ugd2luZG93IGxlYXZlcyB0aGUgY2FyZCBjb25uZWN0ZWQgKG5vIGZsaWNrZXIpLlxuICAgIGNvbnN0IHBlbmRpbmcgPSBpZGxlVGltZXJzLmdldChwcm9qZWN0SWQpO1xuICAgIGlmIChwZW5kaW5nKSB7XG4gICAgICBjbGVhclRpbWVvdXQocGVuZGluZyk7XG4gICAgICBpZGxlVGltZXJzLmRlbGV0ZShwcm9qZWN0SWQpO1xuICAgIH1cbiAgICBjb25zdCBuID0gKHByb2plY3RDb25ucy5nZXQocHJvamVjdElkKSA/PyAwKSArIDE7XG4gICAgcHJvamVjdENvbm5zLnNldChwcm9qZWN0SWQsIG4pO1xuICAgIGlmIChuID09PSAxKSB7XG4gICAgICBjb25zdCByID0gYXBwbHlTZXRQcmVzZW5jZShzdGF0ZSwgcHJvamVjdElkLCB0cnVlKTtcbiAgICAgIGlmIChyLmFwcGxpZWQpIHtcbiAgICAgICAgc3RhdGUgPSByLnN0YXRlO1xuICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcInByZXNlbmNlXCIsIHByb2plY3RJZCwgY29ubmVjdGVkOiB0cnVlLCBieTogXCJzeXN0ZW1cIiB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgZnVuY3Rpb24gcHJlc2VuY2VEaXNjb25uZWN0KHByb2plY3RJZDogc3RyaW5nKSB7XG4gICAgY29uc3QgbiA9IE1hdGgubWF4KDAsIChwcm9qZWN0Q29ubnMuZ2V0KHByb2plY3RJZCkgPz8gMCkgLSAxKTtcbiAgICBpZiAobiA9PT0gMCkgcHJvamVjdENvbm5zLmRlbGV0ZShwcm9qZWN0SWQpO1xuICAgIGVsc2UgcHJvamVjdENvbm5zLnNldChwcm9qZWN0SWQsIG4pO1xuICAgIGlmIChuICE9PSAwKSByZXR1cm47XG4gICAgLy8gRGVmZXIgdGhlIGlkbGUgZmxpcCDigJQgYSByZWNvbm5lY3Qgd2l0aGluIFBSRVNFTkNFX0RFQk9VTkNFX01TIGNhbmNlbHMgaXQuXG4gICAgaWYgKGlkbGVUaW1lcnMuaGFzKHByb2plY3RJZCkpIHJldHVybjtcbiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgaWRsZVRpbWVycy5kZWxldGUocHJvamVjdElkKTtcbiAgICAgIGlmICgocHJvamVjdENvbm5zLmdldChwcm9qZWN0SWQpID8/IDApICE9PSAwKSByZXR1cm47IC8vIHJlY29ubmVjdGVkIG1lYW53aGlsZVxuICAgICAgY29uc3QgciA9IGFwcGx5U2V0UHJlc2VuY2Uoc3RhdGUsIHByb2plY3RJZCwgZmFsc2UpO1xuICAgICAgaWYgKHIuYXBwbGllZCkge1xuICAgICAgICBzdGF0ZSA9IHIuc3RhdGU7XG4gICAgICAgIGVtaXRFdmVudCh7IHR5cGU6IFwicHJlc2VuY2VcIiwgcHJvamVjdElkLCBjb25uZWN0ZWQ6IGZhbHNlLCBieTogXCJzeXN0ZW1cIiB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIH1cbiAgICB9LCBQUkVTRU5DRV9ERUJPVU5DRV9NUyk7XG4gICAgaWRsZVRpbWVycy5zZXQocHJvamVjdElkLCB0aW1lcik7XG4gIH1cblxuICAvLyBHRVQgL2V2ZW50cz9zaW5jZT08aWQ+JnByb2plY3Q9PGlkPiDigJQgcmVwbGF5IGJ1ZmZlcmVkIGZyYW1lcyB3aXRoIGlkID4gc2luY2UsXG4gIC8vIHRoZW4gc3RheSBvcGVuIGZvciBsaXZlIGZyYW1lcyArIGEgMTVzIGhlYXJ0YmVhdCBjb21tZW50LiBBIGBwcm9qZWN0YCBwYXJhbVxuICAvLyBiaW5kcyBwcmVzZW5jZSB0byB0aGlzIGNvbm5lY3Rpb24ncyBsaWZldGltZS5cbiAgZnVuY3Rpb24gc3NlUmVzcG9uc2UodXJsOiBVUkwpOiBSZXNwb25zZSB7XG4gICAgdG91Y2goKTtcbiAgICBjb25zdCBzaW5jZSA9IE51bWJlci5wYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInNpbmNlXCIpID8/IFwiLTFcIiwgMTApO1xuICAgIGNvbnN0IHByb2plY3RJZCA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwicHJvamVjdFwiKSA/PyB1bmRlZmluZWQ7XG4gICAgY29uc3QgYmluZCA9XG4gICAgICBwcm9qZWN0SWQgJiYgc3RhdGUucHJvamVjdHMuc29tZSgocCkgPT4gcC5pZCA9PT0gcHJvamVjdElkKSA/IHByb2plY3RJZCA6IHVuZGVmaW5lZDtcbiAgICBsZXQgcmVmOiBSZWFkYWJsZVN0cmVhbURlZmF1bHRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gICAgbGV0IGhiOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRJbnRlcnZhbD4gfCBudWxsID0gbnVsbDtcbiAgICBjb25zdCBzdHJlYW0gPSBuZXcgUmVhZGFibGVTdHJlYW0oe1xuICAgICAgc3RhcnQoY29udHJvbGxlcikge1xuICAgICAgICByZWYgPSBjb250cm9sbGVyO1xuICAgICAgICBmb3IgKGNvbnN0IGV2IG9mIGV2ZW50cykge1xuICAgICAgICAgIGlmICgoZXYuaWQgYXMgbnVtYmVyKSA+IHNpbmNlKSB7XG4gICAgICAgICAgICBjb250cm9sbGVyLmVucXVldWUoZW5jLmVuY29kZShgZGF0YTogJHtKU09OLnN0cmluZ2lmeShldil9XFxuXFxuYCkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBzc2VDbGllbnRzLmFkZChjb250cm9sbGVyKTtcbiAgICAgICAgaWYgKGJpbmQpIHByZXNlbmNlQ29ubmVjdChiaW5kKTtcbiAgICAgICAgaGIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnRyb2xsZXIuZW5xdWV1ZShlbmMuZW5jb2RlKGA6IGhiXFxuXFxuYCkpO1xuICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyogZ29uZSAqL1xuICAgICAgICAgIH1cbiAgICAgICAgfSwgU1NFX0hFQVJUQkVBVF9NUyk7XG4gICAgICAgIHNzZVRpbWVycy5hZGQoaGIpO1xuICAgICAgfSxcbiAgICAgIGNhbmNlbCgpIHtcbiAgICAgICAgaWYgKGhiKSB7XG4gICAgICAgICAgY2xlYXJJbnRlcnZhbChoYik7XG4gICAgICAgICAgc3NlVGltZXJzLmRlbGV0ZShoYik7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlZikgc3NlQ2xpZW50cy5kZWxldGUocmVmKTtcbiAgICAgICAgaWYgKGJpbmQpIHByZXNlbmNlRGlzY29ubmVjdChiaW5kKTtcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgcmV0dXJuIG5ldyBSZXNwb25zZShzdHJlYW0sIHtcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJ0ZXh0L2V2ZW50LXN0cmVhbVwiLFxuICAgICAgICBcIkNhY2hlLUNvbnRyb2xcIjogXCJuby1jYWNoZVwiLFxuICAgICAgICBDb25uZWN0aW9uOiBcImtlZXAtYWxpdmVcIixcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cblxuICAvLyBTaW5nbGUgZGlzcGF0Y2ggcG9pbnQgZm9yIGFuIEFnZW50Q29tbWFuZC4gVGhyZWFkcyBjYW5vbmljYWwgc3RhdGUgdGhyb3VnaCBhXG4gIC8vIHB1cmUgdDIgcmVkdWNlcjsgb24gYXBwbGllZDp0cnVlIGNvbW1pdHMgdGhlIG5ldyBzdGF0ZSwgYnJvYWRjYXN0cyB0byB0aGVcbiAgLy8gYnJvd3NlciwgYW5kIGFwcGVuZHMgYW4gZXZlbnQgZnJhbWUuIE9uIGFwcGxpZWQ6ZmFsc2UgcmV0dXJucyB0aGUgcmVkdWNlcidzXG4gIC8vIGVycm9yIHNvIHRoZSBDTEkgY2FuIHN1cmZhY2UgYSBkZWR1cGUgcmVqZWN0aW9uIC8gdW5rbm93biBpZC5cbiAgZnVuY3Rpb24gaGFuZGxlQWdlbnRNc2cobXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IEFwcGx5UmVzdWx0IHtcbiAgICBjb25zdCBieSA9IHR5cGVvZiBtc2cuYXMgPT09IFwic3RyaW5nXCIgPyBtc2cuYXMgOiBcImFnZW50XCI7XG4gICAgY29uc3QgdHlwZSA9IG1zZy50eXBlO1xuXG4gICAgaWYgKHR5cGUgPT09IFwicHJvamVjdC5hZGRcIikge1xuICAgICAgY29uc3QgcHJvamVjdCA9IHZhbGlkYXRlUHJvamVjdChtc2cucHJvamVjdCk7XG4gICAgICBpZiAoIXByb2plY3QpIHJldHVybiB7IG9rOiB0cnVlLCBhcHBsaWVkOiBmYWxzZSwgZXJyb3I6IFwiaW52YWxpZCBwcm9qZWN0XCIgfTtcbiAgICAgIGNvbnN0IHIgPSBhcHBseVByb2plY3RBZGQoc3RhdGUsIHByb2plY3QpO1xuICAgICAgaWYgKCFyLmFwcGxpZWQpIHJldHVybiB7IG9rOiB0cnVlLCBhcHBsaWVkOiBmYWxzZSwgZXJyb3I6IHIuZXJyb3IsIG91dGNvbWU6IHIub3V0Y29tZSB9O1xuICAgICAgc3RhdGUgPSByLnN0YXRlO1xuICAgICAgLy8gZW1pdCB0aGUgUkVHSVNURVJFRCBwcm9qZWN0ICh3aXRoIHRoZSBkZXJpdmVkIGlkICsgYXZhdGFyKSwgbm90IHRoZSByYXcgaW5wdXRcbiAgICAgIGNvbnN0IHJlZ2lzdGVyZWQgPSBzdGF0ZS5wcm9qZWN0cy5maW5kKChwKSA9PiBwLmlkID09PSByLmlkKTtcbiAgICAgIGVtaXRFdmVudCh7IHR5cGU6IFwicHJvamVjdC5hZGRcIiwgcHJvamVjdDogcmVnaXN0ZXJlZCwgYnkgfSk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFwcGxpZWQ6IHRydWUsIGlkOiByLmlkIH07XG4gICAgfVxuXG4gICAgaWYgKHR5cGUgPT09IFwicHJvamVjdC5yZW1vdmVcIikge1xuICAgICAgY29uc3QgaWQgPSBTdHJpbmcobXNnLmlkID8/IFwiXCIpO1xuICAgICAgY29uc3QgciA9IGFwcGx5UHJvamVjdFJlbW92ZShzdGF0ZSwgaWQpO1xuICAgICAgaWYgKCFyLmFwcGxpZWQpIHJldHVybiB7IG9rOiB0cnVlLCBhcHBsaWVkOiBmYWxzZSwgZXJyb3I6IHIuZXJyb3IsIG91dGNvbWU6IHIub3V0Y29tZSB9O1xuICAgICAgc3RhdGUgPSByLnN0YXRlO1xuICAgICAgcHJvamVjdENvbm5zLmRlbGV0ZShpZCk7XG4gICAgICBjb25zdCBwZW5kaW5nSWRsZSA9IGlkbGVUaW1lcnMuZ2V0KGlkKTtcbiAgICAgIGlmIChwZW5kaW5nSWRsZSkge1xuICAgICAgICBjbGVhclRpbWVvdXQocGVuZGluZ0lkbGUpO1xuICAgICAgICBpZGxlVGltZXJzLmRlbGV0ZShpZCk7XG4gICAgICB9XG4gICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcInByb2plY3QucmVtb3ZlXCIsIHByb2plY3RJZDogaWQsIGJ5IH0pO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhcHBsaWVkOiB0cnVlIH07XG4gICAgfVxuXG4gICAgaWYgKHR5cGUgPT09IFwic3RhdHVzXCIpIHtcbiAgICAgIGNvbnN0IGlkID0gU3RyaW5nKG1zZy5pZCA/PyBcIlwiKTtcbiAgICAgIGNvbnN0IHN1bW1hcnkgPSB0eXBlb2YgbXNnLnN1bW1hcnkgPT09IFwic3RyaW5nXCIgPyBtc2cuc3VtbWFyeSA6IFwiXCI7XG4gICAgICBjb25zdCBwaGFzZSA9IHR5cGVvZiBtc2cucGhhc2UgPT09IFwic3RyaW5nXCIgPyBtc2cucGhhc2UgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCByID0gYXBwbHlTdGF0dXMoc3RhdGUsIGlkLCB7IHN1bW1hcnksIHBoYXNlIH0sIERhdGUubm93KCkpO1xuICAgICAgaWYgKCFyLmFwcGxpZWQpIHJldHVybiB7IG9rOiB0cnVlLCBhcHBsaWVkOiBmYWxzZSwgZXJyb3I6IHIuZXJyb3IsIG91dGNvbWU6IHIub3V0Y29tZSB9O1xuICAgICAgc3RhdGUgPSByLnN0YXRlO1xuICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJzdGF0dXNcIiwgcHJvamVjdElkOiBpZCwgc3VtbWFyeSwgcGhhc2UsIGJ5IH0pO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhcHBsaWVkOiB0cnVlIH07XG4gICAgfVxuXG4gICAgaWYgKHR5cGUgPT09IFwiYXR0ZW50aW9uXCIpIHtcbiAgICAgIGNvbnN0IGlkID0gU3RyaW5nKG1zZy5pZCA/PyBcIlwiKTtcbiAgICAgIGNvbnN0IHJhaXNlZCA9IG1zZy5yYWlzZWQgIT09IGZhbHNlOyAvLyBkZWZhdWx0IHRvIHJhaXNpbmdcbiAgICAgIGNvbnN0IHF1ZXN0aW9uID0gdHlwZW9mIG1zZy5xdWVzdGlvbiA9PT0gXCJzdHJpbmdcIiA/IG1zZy5xdWVzdGlvbiA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IHIgPSBhcHBseUF0dGVudGlvbihzdGF0ZSwgaWQsIHJhaXNlZCwgcXVlc3Rpb24sIERhdGUubm93KCkpO1xuICAgICAgaWYgKCFyLmFwcGxpZWQpIHJldHVybiB7IG9rOiB0cnVlLCBhcHBsaWVkOiBmYWxzZSwgZXJyb3I6IHIuZXJyb3IsIG91dGNvbWU6IHIub3V0Y29tZSB9O1xuICAgICAgc3RhdGUgPSByLnN0YXRlO1xuICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJhdHRlbnRpb25cIiwgcHJvamVjdElkOiBpZCwgcmFpc2VkLCBxdWVzdGlvbiwgYnkgfSk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFwcGxpZWQ6IHRydWUgfTtcbiAgICB9XG5cbiAgICBpZiAodHlwZSA9PT0gXCJwb2tlXCIpIHtcbiAgICAgIGNvbnN0IGlkID0gU3RyaW5nKG1zZy5pZCA/PyBcIlwiKTtcbiAgICAgIGlmICghc3RhdGUucHJvamVjdHMuc29tZSgocCkgPT4gcC5pZCA9PT0gaWQpKSB7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhcHBsaWVkOiBmYWxzZSwgZXJyb3I6IGB1bmtub3duIHByb2plY3QgJyR7aWR9J2AgfTtcbiAgICAgIH1cbiAgICAgIC8vIEEgcG9rZSBtdXRhdGVzIG5vIHN0YXRlIOKAlCBpdCdzIGEgc2lnbmFsIHRvIHRoZSBwcm9qZWN0J3MgbGlzdGVuaW5nIGFnZW50XG4gICAgICAvLyB0byBwb3N0IGEgZnJlc2ggc3RhdHVzLiBFbWl0IHRoZSBldmVudCBvbmx5IChubyBicm9hZGNhc3QsIG5vIHNuYXBzaG90KS5cbiAgICAgIGVtaXRFdmVudCh7IHR5cGU6IFwicG9rZVwiLCBwcm9qZWN0SWQ6IGlkLCBieSB9KTtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhcHBsaWVkOiB0cnVlIH07XG4gICAgfVxuXG4gICAgaWYgKHR5cGUgPT09IFwiY2xvc2VcIikge1xuICAgICAgcmVzb2x2ZURvbmUoeyBjb2RlOiAwLCByZWFzb246IFwiY2xvc2VcIiB9KTtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhcHBsaWVkOiB0cnVlIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIGFwcGxpZWQ6IGZhbHNlLCBlcnJvcjogYHVua25vd24gY29tbWFuZCAnJHtTdHJpbmcodHlwZSl9J2AgfTtcbiAgfVxuXG4gIGNvbnN0IG1vZGUgPSByZXNvbHZlTW9kZSgpO1xuXG4gIC8vIGRldjogdGhlIGR5bmFtaWMgc3RyaW5nLWxpdGVyYWwgaW1wb3J0IGtlZXBzIHRoZSBzdXJmYWNlIGdyYXBoIG9mZiB0aGVcbiAgLy8gbW9kdWxlIGxvYWQgcGF0aCAoQ29udHJhY3QgMSkg4oCUIEJ1biBidW5kbGVzIHRoZSAudHN4IGdyYXBoICsgVGFpbHdpbmQgYXRcbiAgLy8gc2VydmUgdGltZSBvbiB0aGUgZmlyc3QgR0VUIFwiL1wiIChsYXp5OyBhIGNvbGQgYnVpbGQgY2FuIHRha2Ugc2Vjb25kcyksIGFuZFxuICAvLyByZWFkcyBidW5maWcudG9tbCBmcm9tIGN3ZCwgd2hpY2ggY2xpLnRzIHBpbnMgdG8gc3JjL2FzdHJvbGFiZS8gKENvbnRyYWN0XG4gIC8vIDUpLiBobXIgb24gZm9yIGNpcmNlJ3MgaXRlcmF0aW9uIGxvb3AuXG4gIC8vIHJlbGVhc2U6IGRpc3QvIGlzIHN0YXRpYyBhbmQgcHJlLWJ1aWx0IChDb250cmFjdCAyKSDigJQgXCIvXCIgaXMgYW5zd2VyZWQgYnlcbiAgLy8gc2VydmVEaXN0KCkgaW4gdGhlIGZldGNoIGZhbGwtdGhyb3VnaCBiZWxvdywgc28gdGhpcyBicmFuY2ggbmV2ZXIgdG91Y2hlc1xuICAvLyBzdXJmYWNlLyBvciBidW5maWcudG9tbCBhbmQgbmV2ZXIgbmVlZHMgZWl0aGVyIHRvIGV4aXN0LlxuICAvLyBCdW4ncyBSb3V0ZXMgdHlwZSB0aWVzIHRoZSBcIi9cIiB2YWx1ZSdzIHR5cGUgdG8gdGhlIGxpdGVyYWwgb2JqZWN0IHNoYXBlLCBzb1xuICAvLyBhIG1vZGUtdGVybmFyeSB1bmlvbiBjb25mdXNlcyBpdHMgb3ZlcmxvYWQgcmVzb2x1dGlvbiDigJQgdGhlIHJ1bnRpbWVcbiAgLy8gYmVoYXZpb3IgKEhUTUxCdW5kbGUgaW4gZGV2LCBhYnNlbnQgaW4gcmVsZWFzZSkgaXMgY29ycmVjdCBlaXRoZXIgd2F5LlxuICAvLyDim5QgVEhJUyBTUEVDSUZJRVIgSVMgUkVTT0xWRUQgRlJPTSBgZGlzdC9gLCBOT1QgRlJPTSBUSElTIEZJTEUuIGBzcmMvYnVpbGQudHNgXG4gIC8vIHBhc3NlcyBgZXh0ZXJuYWw6IFtcIiovc3VyZmFjZS9pbmRleC5odG1sXCJdYCwgc28gdGhlIGJ1bmRsZXIgZG9lcyBub3QgZm9sbG93XG4gIC8vIHRoaXMgaW1wb3J0IGFuZCBsZWF2ZXMgdGhlIHN0cmluZyBpbiBgZGlzdC9zZXJ2ZXIuanNgIEJZVEUtRk9SLUJZVEUuIFRoZVxuICAvLyBmaXZlIGAuLmAgdGhlcmVmb3JlIGNvdW50IHVwIGZyb21cbiAgLy8gYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9hc3Ryb2xhYmUvZGlzdC9gIOKAlCBkaXN0IOKGkiBhc3Ryb2xhYmUg4oaSIHNraWxscyDihpJcbiAgLy8gc3BlbGxib29rIOKGkiBwbHVnaW5zIOKGkiByZXBvIHJvb3Qg4oCUIGFuZCBOT1QgZnJvbSBgc3JjL2FzdHJvbGFiZS9iYWNrZW5kL2AsXG4gIC8vIHdoZXJlIHRoZSBzYW1lIHN0cmluZyB3b3VsZCBjbGltYiBvdXQgb2YgdGhlIHJlcG8uIFJlYWRpbmcgaXQgYXMgYSBub3JtYWxcbiAgLy8gcmVsYXRpdmUgaW1wb3J0IG9mIHRoaXMgZmlsZSBpcyB0aGUgbWlzdGFrZSB0byBtYWtlIGhlcmUsIGFuZCByZWxlYXNlIG1vZGVcbiAgLy8gbmV2ZXIgZXhlY3V0ZXMgdGhlIGxpbmUsIHNvIG5vdGhpbmcgYnV0IGJvb3RpbmcgYSBERVYgZGFlbW9uIGNhbiBjYXRjaCBpdC5cbiAgLy8gYGdyaW1vaXJlL2ltcG9ydC1ib3VuZGFyeS13YXJkcy50ZXN0LnRzYCBwaW5zIGl0IGF0IHRoZSBlbWl0dGVkIGFkZHJlc3MgZm9yXG4gIC8vIGV4YWN0bHkgdGhhdCByZWFzb24uXG4gIGNvbnN0IGRldkluZGV4ID1cbiAgICBtb2RlID09PSBcImRldlwiXG4gICAgICA/IChhd2FpdCBpbXBvcnQoXCIuLi8uLi8uLi8uLi8uLi9zcmMvYXN0cm9sYWJlL3N1cmZhY2UvaW5kZXguaHRtbFwiKSkuZGVmYXVsdFxuICAgICAgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHJvdXRlcyA9IChkZXZJbmRleCA/IHsgXCIvXCI6IGRldkluZGV4IH0gOiB7fSkgYXMgUmVjb3JkPHN0cmluZywgbmV2ZXI+O1xuXG4gIGxldCBzZXJ2ZXI6IFJldHVyblR5cGU8dHlwZW9mIEJ1bi5zZXJ2ZT47XG4gIHRyeSB7XG4gICAgc2VydmVyID0gQnVuLnNlcnZlKHtcbiAgICAgIHBvcnQsXG4gICAgICBob3N0bmFtZTogaG9zdCxcbiAgICAgIGlkbGVUaW1lb3V0OiBJRExFX1RJTUVPVVRfU0VDLCAvLyBrZWVwIGhlbGQgU1NFL1dTIGNvbm5lY3Rpb25zIGFsaXZlIChzZWUgU1NFX0hFQVJUQkVBVF9NUylcbiAgICAgIHJvdXRlcyxcbiAgICAgIGRldmVsb3BtZW50OiB7IGhtcjogbW9kZSA9PT0gXCJkZXZcIiB9LFxuICAgICAgZmV0Y2g6IChyZXEsIHNydikgPT4ge1xuICAgICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwpO1xuICAgICAgICBjb25zdCBwYXRoID0gdXJsLnBhdGhuYW1lO1xuICAgICAgICBpZiAocGF0aCA9PT0gXCIvd3NcIikge1xuICAgICAgICAgIGNvbnN0IHVwZ3JhZGVkID0gc3J2LnVwZ3JhZGUocmVxKTtcbiAgICAgICAgICBpZiAodXBncmFkZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShcInVwZ3JhZGUgcmVxdWlyZWRcIiwgeyBzdGF0dXM6IDQyNiB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9zdGF0ZVwiKSB7XG4gICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKEpTT04uc3RyaW5naWZ5KHsgc3RhdGU6IHByb2plY3RTdGF0ZSgpLCBjdXJzb3I6IGV2ZW50U2VxIH0pLCB7XG4gICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZXZlbnRzXCIpIHtcbiAgICAgICAgICByZXR1cm4gc3NlUmVzcG9uc2UodXJsKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJQT1NUXCIgJiYgcGF0aCA9PT0gXCIvY21kXCIpIHtcbiAgICAgICAgICByZXR1cm4gcmVxXG4gICAgICAgICAgICAuanNvbigpXG4gICAgICAgICAgICAudGhlbigoYm9keSkgPT4ge1xuICAgICAgICAgICAgICB0b3VjaCgpO1xuICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBoYW5kbGVBZ2VudE1zZyhib2R5IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcbiAgICAgICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShKU09OLnN0cmluZ2lmeShyZXN1bHQpLCB7XG4gICAgICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAuY2F0Y2goXG4gICAgICAgICAgICAgICgpID0+XG4gICAgICAgICAgICAgICAgbmV3IFJlc3BvbnNlKCd7XCJlcnJvclwiOlwiYmFkIGpzb25cIn0nLCB7XG4gICAgICAgICAgICAgICAgICBzdGF0dXM6IDQwMCxcbiAgICAgICAgICAgICAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gcmVsZWFzZTogXCIvXCIgYW5kIHRoZSBoYXNoZWQgY2h1bmstKi5qcy9jc3MgYXJlIHN0YXRpYyBkaXN0IHJlYWRzLiBEZXZcbiAgICAgICAgLy8gbmV2ZXIgcmVhY2hlcyBoZXJlIGZvciBcIi9cIiDigJQgdGhlIHJvdXRlcyB0YWJsZSBhYm92ZSBhbnN3ZXJzIGl0IGZpcnN0LlxuICAgICAgICBpZiAobW9kZSA9PT0gXCJyZWxlYXNlXCIpIHtcbiAgICAgICAgICBjb25zdCBhc3NldCA9IHNlcnZlRGlzdChwYXRoKTtcbiAgICAgICAgICBpZiAoYXNzZXQpIHJldHVybiBhc3NldDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCd7XCJlcnJvclwiOlwibm90IGZvdW5kXCJ9Jywge1xuICAgICAgICAgIHN0YXR1czogNDA0LFxuICAgICAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgICAgfSk7XG4gICAgICB9LFxuICAgICAgd2Vic29ja2V0OiB7XG4gICAgICAgIG9wZW4od3MpIHtcbiAgICAgICAgICBzb2NrZXRzLmFkZCh3cyk7XG4gICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcImNvbm5lY3RlZFwiLCBieTogXCJ1c2VyXCIgfSk7XG4gICAgICAgICAgd3Muc2VuZChKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwic3RhdGVcIiwgLi4ucHJvamVjdFN0YXRlKCkgfSkpO1xuICAgICAgICB9LFxuICAgICAgICBtZXNzYWdlKF93cywgcmF3KSB7XG4gICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICBsZXQgbXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgbXNnID0gSlNPTi5wYXJzZSh0eXBlb2YgcmF3ID09PSBcInN0cmluZ1wiID8gcmF3IDogbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHJhdykpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgICBgYXN0cm9sYWJlOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmAsXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBUaGUgaHVtYW4ncyBib2FyZCBhZmZvcmRhbmNlcyBvdmVyIFdTOiBudWRnZSAocG9rZSkgYSBwcm9qZWN0LCBvclxuICAgICAgICAgIC8vIGRpc21pc3MgdGhlIG9ic2VydmF0b3J5LiAoQWRkLXByb2plY3QgZnJvbSB0aGUgc3VyZmFjZSBpcyBhIHNlcGFyYXRlXG4gICAgICAgICAgLy8gUE9TVCAvY21kIOKAlCBzZWUgQWRkUHJvamVjdE1vZGFsIOKAlCBub3QgYSBXUyBtZXNzYWdlLilcbiAgICAgICAgICBpZiAobXNnLnR5cGUgPT09IFwicG9rZVwiIHx8IG1zZy50eXBlID09PSBcImNsb3NlXCIpIHtcbiAgICAgICAgICAgIGhhbmRsZUFnZW50TXNnKHsgLi4ubXNnLCBhczogXCJ1c2VyXCIgfSk7XG4gICAgICAgICAgfVxuICAgICAgICB9LFxuICAgICAgICBjbG9zZSh3cykge1xuICAgICAgICAgIHNvY2tldHMuZGVsZXRlKHdzKTtcbiAgICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcImRpc2Nvbm5lY3RlZFwiLCBieTogXCJ1c2VyXCIgfSk7XG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGV2ZW50OiBcImJpbmRfZXJyb3JcIixcbiAgICAgICAgaG9zdCxcbiAgICAgICAgcG9ydCxcbiAgICAgICAgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSxcbiAgICAgIH0pfVxcbmAsXG4gICAgKTtcbiAgICByZXR1cm4gMjtcbiAgfVxuXG4gIGNvbnN0IGJvdW5kUG9ydCA9IHNlcnZlci5wb3J0O1xuICBjb25zdCB1cmwgPSBgaHR0cDovLyR7aG9zdH06JHtib3VuZFBvcnR9YDtcbiAgLy8gYG1vZGVgIG9uIHRoZSByZWFkeSBmcmFtZSBpcyB0aGUgT05MWSB0aGluZyB0aGF0IGRpc2NyaW1pbmF0ZXMgYSByZWxlYXNlXG4gIC8vIGRhZW1vbiBmcm9tIGEgZGV2IG9uZTogd2l0aCByb290IGRlcHMgcHJlc2VudCBhIGRldiBkYWVtb24gcmVuZGVycyBhblxuICAvLyBpZGVudGljYWwtbG9va2luZyBib2FyZCwgc28gXCJpdCBsb29rcyByaWdodFwiIGNhbm5vdCB2ZXJpZnkgQ29udHJhY3QgMS5cbiAgZW1pdEV2ZW50KHtcbiAgICB0eXBlOiBcInJlYWR5XCIsXG4gICAgdXJsLFxuICAgIHBvcnQ6IGJvdW5kUG9ydCxcbiAgICBzZXNzaW9uX2lkOiBcImFzdHJvbGFiZVwiLFxuICAgIG1vZGUsXG4gICAgYnk6IFwic3lzdGVtXCIsXG4gIH0pO1xuXG4gIC8vIERpc2NvdmVyeTogYSBzaW5nbGV0b24gZGFlbW9uIHdyaXRlcyBpdHMgcG9ydCArIHBpZCBzbyBjbGkudHMgY2FuIGZpbmQgKG9yXG4gIC8vIHNraXAgYXV0by1zcGF3bmluZykgaXQuIENsZWFuZWQgdXAgb24gY2xvc2Ugb25seSBpZiB0aGV5IHN0aWxsIG5hbWUgdXMuXG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKEFTVFJPTEFCRV9IT01FLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKFBPUlRfRklMRSwgU3RyaW5nKGJvdW5kUG9ydCkpO1xuICAgIHdyaXRlRmlsZVN5bmMoUElEX0ZJTEUsIFN0cmluZyhwcm9jZXNzLnBpZCkpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgYXN0cm9sYWJlOiBjb3VsZCBub3Qgd3JpdGUgZGlzY292ZXJ5IGZpbGVzOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG5gLFxuICAgICk7XG4gIH1cbiAgY29uc3QgY2xlYW51cERpc2NvdmVyeSA9ICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgaWYgKGV4aXN0c1N5bmMoUElEX0ZJTEUpICYmIHJlYWRGaWxlU3luYyhQSURfRklMRSwgXCJ1dGY4XCIpLnRyaW0oKSA9PT0gU3RyaW5nKHByb2Nlc3MucGlkKSkge1xuICAgICAgICB1bmxpbmtTeW5jKFBJRF9GSUxFKTtcbiAgICAgICAgdW5saW5rU3luYyhQT1JUX0ZJTEUpO1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLyogZmlsZXMgZ29uZSBvciB1bnJlYWRhYmxlIOKAlCBmaW5lICovXG4gICAgfVxuICB9O1xuXG4gIC8vIFByaW50IHRoZSBib3VuZCBVUkwgb24gc3Rkb3V0IHNvIGEgZm9yZWdyb3VuZCBsYXVuY2ggaXMgZGlzY292ZXJhYmxlLlxuICAvLyBgbW9kZWAgcmlkZXMgdGhpcyBsaW5lIGFzIHdlbGwgYXMgdGhlIHJlYWR5IEVWRU5UIGFib3ZlOiBtaW5kLW1hcHBlcidzXG4gIC8vIHJlbGVhc2Utc2VydmUgZ2F0ZSByZWFkcyB0aGUgaGFuZHNoYWtlIGxpbmUsIGFuZCBhIGZvcmVncm91bmQgbGF1bmNoIHRoYXRcbiAgLy8gbmV2ZXIgb3BlbnMgYSB0YWlsIHN0aWxsIG5lZWRzIHRvIGJlIGFibGUgdG8gc2F5IHdoaWNoIG1vZGUgaXQgZ290LlxuICBwcm9jZXNzLnN0ZG91dC53cml0ZShcbiAgICBgJHtKU09OLnN0cmluZ2lmeSh7IHVybCwgcG9ydDogYm91bmRQb3J0LCBzZXNzaW9uX2lkOiBcImFzdHJvbGFiZVwiLCBtb2RlIH0pfVxcbmAsXG4gICk7XG5cbiAgaWYgKCF2W1wibm8tb3BlblwiXSkgb3BlbkJyb3dzZXIodXJsKTtcblxuICBjb25zdCBpZGxlVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgY29uc3Qgc3Vic2NyaWJlckNvdW50ID0gc29ja2V0cy5zaXplICsgc3NlQ2xpZW50cy5zaXplO1xuICAgIGlmIChzdWJzY3JpYmVyQ291bnQgPiAwKSB0b3VjaCgpO1xuICAgIGlmIChzaG91bGRJZGxlQ2xvc2Uoc3Vic2NyaWJlckNvdW50LCBwZXJmb3JtYW5jZS5ub3coKSAtIGxhc3RBY3Rpdml0eSwgdGltZW91dCAqIDEwMDApKSB7XG4gICAgICByZXNvbHZlRG9uZSh7IGNvZGU6IDEyNCwgcmVhc29uOiBcInRpbWVvdXRcIiB9KTtcbiAgICB9XG4gIH0sIDI1MCk7XG5cbiAgY29uc3Qgc25hcFRpbWVyID0gc2V0SW50ZXJ2YWwoYXN5bmMgKCkgPT4ge1xuICAgIGlmIChzbmFwRGlydHkpIHtcbiAgICAgIHNuYXBEaXJ0eSA9IGZhbHNlO1xuICAgICAgYXdhaXQgc2F2ZVJlZ2lzdHJ5KCk7XG4gICAgfVxuICB9LCAxMDAwKTtcblxuICBjb25zdCB7IGNvZGUsIHJlYXNvbiB9ID0gYXdhaXQgZG9uZTtcbiAgY2xlYXJJbnRlcnZhbChpZGxlVGltZXIpO1xuICBjbGVhckludGVydmFsKHNuYXBUaW1lcik7XG4gIGF3YWl0IHNhdmVSZWdpc3RyeSgpOyAvLyBmaW5hbCByZWdpc3RyeSB3cml0ZVxuICBlbWl0RXZlbnQoeyB0eXBlOiBcImNsb3NlZFwiLCByZWFzb24sIGJ5OiBcInN5c3RlbVwiIH0pO1xuICBicm9hZGNhc3RTdGF0ZSgpO1xuICAvLyBHcmFjZSBwZXJpb2Qgc28gcXVldWVkIGZyYW1lcyBmbHVzaCBiZWZvcmUgdGhlIGFnZ3Jlc3NpdmUgc3RvcCAoQnVuIGdvdGNoYSkuXG4gIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDE1MCkpO1xuICBmb3IgKGNvbnN0IHQgb2Ygc3NlVGltZXJzKSBjbGVhckludGVydmFsKHQpO1xuICBmb3IgKGNvbnN0IHQgb2YgaWRsZVRpbWVycy52YWx1ZXMoKSkgY2xlYXJUaW1lb3V0KHQpO1xuICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xuICAgIHRyeSB7XG4gICAgICBjLmNsb3NlKCk7XG4gICAgfSBjYXRjaCB7fVxuICB9XG4gIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cykge1xuICAgIHRyeSB7XG4gICAgICB3cy5jbG9zZSgpO1xuICAgIH0gY2F0Y2gge31cbiAgfVxuICBhd2FpdCBQcm9taXNlLnJhY2UoW3NlcnZlci5zdG9wKHRydWUpLCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAyMDApKV0pO1xuICBjbGVhbnVwRGlzY292ZXJ5KCk7XG4gIHJldHVybiBjb2RlO1xufVxuXG4vKipcbiAqIFRoZSBkYWVtb24ncyBlbnRyeSwgZm9yIHRoZSBMQVVOQ0hFUiBhdFxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9hc3Ryb2xhYmUvc2NyaXB0cy9zZXJ2ZXIudHNgLlxuICpcbiAqIOKblCBgaW1wb3J0Lm1ldGEubWFpbmAgSVMgRkFMU0UgSU4gVEhFIEJVTkRMRS4gYGRpc3Qvc2VydmVyLmpzYCBpcyBJTVBPUlRFRCBieVxuICogdGhlIGxhdW5jaGVyLCBuZXZlciBleGVjdXRlZCBhcyB0aGUgcHJvY2VzcyBlbnRyeSwgc28gdGhlIG9sZFxuICogYGlmIChpbXBvcnQubWV0YS5tYWluKWAgYmxvY2sgd291bGQgc2ltcGx5IG5ldmVyIHJ1biDigJQgdGhlIGRhZW1vbiB3b3VsZCBib290LFxuICogc2VydmUgbm90aGluZyBhbmQgZXhpdCAwLiBUaGF0IGlzIHRoZSBmYWlsdXJlIHRoaXMgZXhwb3J0IGV4aXN0cyB0byBwcmV2ZW50LlxuICpcbiAqIOKblCBBTkQgSVQgVEFLRVMgTk8gQVJHVU1FTlRTLCBmb3IgdGhlIHNhbWUgcmVhc29uIGBjbGkudHNgJ3MgYHJ1bigpYCBkb2VzIG5vdDpcbiAqIHRoZSBjb21tYW5kIGxpbmUgYmVsb25ncyB0byB0aGUgZmlsZSB0aGF0IFBBUlNFUyBpdC4gQSBsYXVuY2hlciB0aGF0IHRvdWNoZWRcbiAqIGBwcm9jZXNzLmFyZ3ZgIHdvdWxkIG1hdGNoIGBncmltb2lyZS9saWIvZW50cnktcG9pbnRzLnRzYCdzIGFyZy1wYXJzaW5nXG4gKiBwcmVkaWNhdGUgYW5kIHRoZSB3YXJkcyB3b3VsZCBqdWRnZSB0aGlzIGRhZW1vbidzIGZsYWdzIGFnYWluc3QgYSBmaWxlIHRoYXRcbiAqIHJlY29nbmlzZXMgbm9uZS5cbiAqXG4gKiBUaGUgdGVybWluYWwgYHByb2Nlc3MuZXhpdChleGl0Q29kZSlgIHN0YXlzIHdoZXJlIGl0IGFsd2F5cyB3YXMg4oCUIGF0IHRoZSBzaXRlXG4gKiB0aGF0IGlzIHRoZSBwcm9jZXNzIGVudHJ5LCB3aGljaCBpcyBub3cgdGhlIGxhdW5jaGVyLiBJdCBpcyBmYW1pbHkgRS10ZXJtaW5hbFxuICogaW4gYGdyaW1vaXJlL2V4aXQtc2l0ZS1pbnZlbnRvcnkudGVzdC50c2AgKHRlYXJkb3duIGhhcyBhbHJlYWR5IHJ1biBpbnNpZGVcbiAqIGBtYWluYCksIGl0IGlzIGEgREFFTU9OJ3MgZXhpdCBhbmQgbm90IGEgQ0xJJ3MsIGFuZCBEOCdzIGBkaWVgLXRocm93cyBydWxpbmdcbiAqIGRlbGliZXJhdGVseSBkb2VzIG5vdCByZWFjaCBpdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG5leHBvcnQgeyBtYWluLCBzaG91bGRJZGxlQ2xvc2UsIHZhbGlkYXRlUHJvamVjdCB9O1xuIiwKICAgICIvLyBhc3Ryb2xhYmUgc3RhdGUg4oCUIHRoZSBkYXRhIG1vZGVsICsgcHVyZSByZWR1Y2VycyAodDIpLlxuLy9cbi8vIFRocmVlIGxheWVycyBrZXB0IGRlbGliZXJhdGVseSBzZXBhcmF0ZSAocHJvcG9zYWwgwqdcIkRhdGEgbW9kZWxcIik6XG4vLyAgIDEuIFByb2plY3QgIOKAlCBEVVJBQkxFIHJlZ2lzdHJ5IChwZXJzaXN0ZWQgdG8gZGlzaywgcmVzdG9yZWQgb24gZGFlbW9uIHN0YXJ0KVxuLy8gICAyLiBQcmVzZW5jZSDigJQgTElWRSAoYW4gYWdlbnQgam9pbmVkICsgd2F0Y2hpbmcg4oaSIHRoZSBjYXJkIGlzIFwiYWN0aXZlXCIpOyBuZXZlciBwZXJzaXN0ZWRcbi8vICAgMy4gU3RhdHVzICAg4oCUIENVUlJFTlQgb25seSwgbm8gaGlzdG9yeSAoZWFjaCBwb3N0IFJFUExBQ0VTIHRoZSBwcmlvcjsgdGhlIGNhcmRcbi8vICAgICAgICAgICAgICAgICBhbHdheXMgcmVmbGVjdHMgdGhlIHByZXNlbnQgc3RhdGUpXG4vL1xuLy8gUmVkdWNlcnMgYXJlIFBVUkU6IGAoc3RhdGUsIOKApiwgbm93KSA9PiBSZWR1Y2VyUmVzdWx0YC4gVGhleSBuZXZlciBtdXRhdGUgdGhlXG4vLyBpbnB1dCBhbmQgbmV2ZXIgcmVhZCB0aGUgY2xvY2sg4oCUIHRoZSBjYWxsZXIgcGFzc2VzIGBub3dgICh1bml4IG1zKSBzbyB0aGVcbi8vIGRhZW1vbiBhbmQgdGhlIHRlc3RzIHNoYXJlIG9uZSBkZXRlcm1pbmlzdGljIHBhdGguIGBhcHBsaWVkOmZhbHNlYCAoKyBgZXJyb3JgKVxuLy8gZmxhZ3MgYSByZWplY3RlZC9uby1vcCBjb21tYW5kIHNvIGNsaSByZWFkLWJhY2sgY2FuIHRlbGwgYSB3cml0ZSB0b29rLlxuXG5leHBvcnQgdHlwZSBQcm9qZWN0ID0ge1xuICBpZDogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuICBwYXRoOiBzdHJpbmc7XG4gIGF2YXRhcj86IHN0cmluZzsgLy8gcHJvamVjdCBpZGVudGl0eTsgYSBzZWVkZWQvcmFuZG9tIGZhbGxiYWNrIGlzIGFzc2lnbmVkIHVwc3RyZWFtICh0Nilcbn07XG5cbi8vIExJVkUg4oCUIHByZXNlbmNlIGlzIHdoYXQgZmxpcHMgYSBjYXJkIHRvIFwiYWN0aXZlXCI6IGFuIGFnZW50IGlzIGpvaW5lZCBhbmRcbi8vIHdhdGNoaW5nLiBOb3QgcGVyc2lzdGVkIChhIHJlc3RvcmVkIGRhZW1vbiBzdGFydHMgd2l0aCBldmVyeW9uZSBkaXNjb25uZWN0ZWQpLlxuZXhwb3J0IHR5cGUgUHJlc2VuY2UgPSB7IGNvbm5lY3RlZDogYm9vbGVhbiB9O1xuXG4vLyBDVVJSRU5UIOKAlCByZXBsYWNlZCB3aG9sZXNhbGUgYnkgZWFjaCBzdGF0dXMgcG9zdDsgbm8gaGlzdG9yeSBrZXB0IChNVlAgZ3VhcmRyYWlsKS5cbmV4cG9ydCB0eXBlIFN0YXR1cyA9IHtcbiAgc3VtbWFyeTogc3RyaW5nO1xuICBwaGFzZT86IHN0cmluZztcbiAgbmVlZHNBdHRlbnRpb246IGJvb2xlYW47IC8vIHRoZSBodW1hbiBnYXRlIChhZ2VudCDihpIgaHVtYW4pXG4gIHF1ZXN0aW9uPzogc3RyaW5nOyAvLyB0aGUgcHJvbXB0IHNob3duIHdoZW4gbmVlZHNBdHRlbnRpb24gaXMgcmFpc2VkXG4gIGxhc3RVcGRhdGVkOiBudW1iZXI7IC8vIHVuaXggbXNcbn07XG5cbmV4cG9ydCB0eXBlIE9ic2VydmF0b3J5U3RhdGUgPSB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIHByb2plY3RzOiBQcm9qZWN0W107IC8vIGR1cmFibGUgcmVnaXN0cnlcbiAgcHJlc2VuY2U6IFJlY29yZDxzdHJpbmcsIFByZXNlbmNlPjsgLy8gYnkgcHJvamVjdCBpZCDigJQgbGl2ZVxuICBzdGF0dXM6IFJlY29yZDxzdHJpbmcsIFN0YXR1cz47IC8vIGJ5IHByb2plY3QgaWQg4oCUIGN1cnJlbnQgb25seVxufTtcblxuLy8gYXBwbGllZDpmYWxzZSBtZWFucyB0aGUgY29tbWFuZCB3YXMgYSBuby1vcCBvciByZWplY3RlZDsgYGVycm9yYCBleHBsYWlucyBhXG4vLyByZWplY3Rpb24uIGBpZGAgaXMgc2V0IGJ5IGFwcGx5UHJvamVjdEFkZCB0byB0aGUgaWQgaXQgZGVyaXZlZC91c2VkLCBzbyBjYWxsZXJzXG4vLyBkb24ndCByZS1kZXJpdmUgdGhlIHNsdWcuXG4vL1xuLy8gYjIvIzg1IOKAlCBBIEJFTklHTiBOTy1PUCBOT1cgQ0FSUklFUyBBTiBgb3V0Y29tZWAgTk9VTi4gSXQgdXNlZCB0byBjYXJyeVxuLy8gbm90aGluZyBhdCBhbGwsIHNvIGBhcHBsaWVkOmZhbHNlYCB3aXRoIG5vIGVycm9yIHdhcyB0aGUgb25seSBzaWduYWwsIGFuZFxuLy8gY2xpLnRzIGNvdWxkIG5vdCBkaXN0aW5ndWlzaCBcInRoZSBzdGF0ZSBpcyBhbHJlYWR5IHdoYXQgeW91IGFza2VkIGZvclwiIGZyb21cbi8vIFwieW91ciBjb21tYW5kIHdhcyByZWplY3RlZFwiIOKAlCBpdCBkaWVkIG9uIGJvdGgsIGV4aXQgMi4gUmUtaXNzdWluZyBhIGNvbW1hbmRcbi8vIHdob3NlIGVmZmVjdCB3YXMgYWxyZWFkeSBpbiBwbGFjZSB3YXMgYSBoYXJkIGZhaWx1cmUsIHdoaWxlIGJvdW50eSB0cmVhdHMgdGhlXG4vLyBpZGVudGljYWwgcGF5bG9hZCBhcyBvcmRpbmFyeSBzdWNjZXNzLlxuLy9cbi8vIFRoZSBOT1VOIHJhdGhlciB0aGFuIGEgYm9vbGVhbiBpcyBkZWxpYmVyYXRlIGFuZCBpdCBpcyBhIGRlcGFydHVyZSBmcm9tXG4vLyBib3VudHkncyBgbm9vcDogdHJ1ZWAsIHdoaWNoIGlzIHRoZSBzaGFwZSBJIHdhcyBwb2ludGVkIGF0LiBQZXJcbi8vIGdyaW1vaXJlL291dGNvbWUtY29udHJhY3QubWQgYSBjb21wbGV0ZWQtYnktYW4tdW5leHBlY3RlZC1wYXRoIHJlc3VsdCBpc1xuLy8gYG91dGNvbWU6IFwiPG5vdW4+XCJgLCBcImVudW1lcmF0ZWQsIG5ldmVyIGEgYm9vbGVhblwiLCBhbmQgdGhlIG5vdW4gbXVzdCBuYW1lIHRoZVxuLy8gU1RBVEUgdGhhdCBtYWRlIHRoZSB3b3JrIHVubmVjZXNzYXJ5IHJhdGhlciB0aGFuIHRoZSB0b29sJ3MgYWN0aW9uLiBBIGJvb2xlYW5cbi8vIHNheXMgb25seSBcIm5vdGhpbmcgaGFwcGVuZWRcIjsgYGFscmVhZHktY29ubmVjdGVkYCB0ZWxscyBhIGNhbGxlciBXSElDSCBzdGF0ZVxuLy8gaXQgZm91bmQsIHdoaWNoIGlzIHdoYXQgaXQgbmVlZHMgdG8gZGVjaWRlIGl0cyBuZXh0IGFjdC5cbmV4cG9ydCB0eXBlIFJlZHVjZXJSZXN1bHQgPSB7XG4gIHN0YXRlOiBPYnNlcnZhdG9yeVN0YXRlO1xuICBhcHBsaWVkOiBib29sZWFuO1xuICBlcnJvcj86IHN0cmluZztcbiAgaWQ/OiBzdHJpbmc7XG4gIG91dGNvbWU/OiBzdHJpbmc7XG59O1xuXG4vLyDilIDilIAgU3VyZmFjZSBwcm9qZWN0aW9uIC8gd2lyZSBjb250cmFjdCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIFRoZSBkYWVtb24gcHJvamVjdHMgdGhlIHRocmVlIGludGVybmFsIGxheWVycyBpbnRvIHBlci1wcm9qZWN0IENBUkRTIGZvciB0aGVcbi8vIHN1cmZhY2UgKHJlYWRiYWNrLXBhcml0eSDigJQgYW4gYWdlbnQgcmVhZGluZyAvc3RhdGUgc2VlcyB3aGF0IHRoZSBib2FyZFxuLy8gcmVuZGVycykuIGB6b25lYCBpcyB0aGUgY29hcnNlIGZsb29yIChhdHRlbnRpb24gPiBhY3RpdmUgPiBxdWlldCk7IHRoZSBzdXJmYWNlXG4vLyByZWZpbmVzIHF1aWV0IOKGkiBpZGxlL3N0YWxlIGZyb20gYGNvbm5lY3RlZGAgKyBgbGFzdFVwZGF0ZWRgLiBUaGlzIGlzIHRoZSBleGFjdFxuLy8gc2hhcGUgdGhlIFdTIHt0eXBlOlwic3RhdGVcIn0gZnJhbWUgYW5kIEdFVCAvc3RhdGUgY2FycnksIHNvIHNlcnZlci50cyBhbmQgdGhlXG4vLyBSZWFjdCBzdXJmYWNlIHNoYXJlIE9ORSBjb250cmFjdCBhbmQgbmVpdGhlciByZS1kZXJpdmVzIGl0LlxuZXhwb3J0IHR5cGUgUHJvamVjdFN0YXR1c1ZpZXcgPSB7IHN1bW1hcnk6IHN0cmluZzsgcGhhc2U/OiBzdHJpbmc7IGxhc3RVcGRhdGVkOiBudW1iZXIgfTtcbmV4cG9ydCB0eXBlIFByb2plY3RDYXJkID0gUHJvamVjdCAmIHtcbiAgY29ubmVjdGVkOiBib29sZWFuO1xuICBuZWVkc0F0dGVudGlvbjogYm9vbGVhbjtcbiAgcXVlc3Rpb24/OiBzdHJpbmc7XG4gIHN0YXR1czogUHJvamVjdFN0YXR1c1ZpZXcgfCBudWxsO1xuICB6b25lOiBcImF0dGVudGlvblwiIHwgXCJhY3RpdmVcIiB8IFwicXVpZXRcIjtcbn07XG5leHBvcnQgdHlwZSBPYnNlcnZhdG9yeVZpZXcgPSB7IHRpdGxlOiBzdHJpbmc7IHByb2plY3RzOiBQcm9qZWN0Q2FyZFtdIH07XG5cbi8vIFdlYlNvY2tldCBwcm90b2NvbCAoYnJvd3NlciDihpQgZGFlbW9uKS4gVGhlIGRhZW1vbiBwdXNoZXMgdGhlIGZ1bGwgcHJvamVjdGVkXG4vLyBib2FyZDsgdGhlIGJyb3dzZXIgc2VuZHMgcG9rZXMgLyBkaXNtaXNzIChwcm9qZWN0IHJlZ2lzdHJhdGlvbiBpcyBQT1NUIC9jbWQpLlxuZXhwb3J0IHR5cGUgU2VydmVyVG9DbGllbnQgPSB7IHR5cGU6IFwic3RhdGVcIiB9ICYgT2JzZXJ2YXRvcnlWaWV3O1xuZXhwb3J0IHR5cGUgQ2xpZW50VG9TZXJ2ZXIgPSB7IHR5cGU6IFwicG9rZVwiOyBpZDogc3RyaW5nIH0gfCB7IHR5cGU6IFwiY2xvc2VcIiB9O1xuXG5leHBvcnQgZnVuY3Rpb24gZW1wdHlTdGF0ZSh0aXRsZSA9IFwiT2JzZXJ2YXRvcnlcIik6IE9ic2VydmF0b3J5U3RhdGUge1xuICByZXR1cm4geyB0aXRsZSwgcHJvamVjdHM6IFtdLCBwcmVzZW5jZToge30sIHN0YXR1czoge30gfTtcbn1cblxuLy8gQSBwcm9qZWN0LWlkZW50aXR5IGdseXBoIHNlZWRlZCBkZXRlcm1pbmlzdGljYWxseSBmcm9tIHRoZSBuYW1lLCBzbyBhIGNhcmQgaXNcbi8vIG5ldmVyIGF2YXRhci1sZXNzIGFuZCB0aGUgU0FNRSBuYW1lIGFsd2F5cyB5aWVsZHMgdGhlIFNBTUUgZmFjZS4gTGl2ZXMgaGVyZVxuLy8gKHRoZSBwdXJlIGxheWVyKSBhbmQgaXMgYXBwbGllZCBieSBhcHBseVByb2plY3RBZGQsIHNvIEVWRVJZIHJlZ2lzdHJhdGlvbiBwYXRoXG4vLyDigJQgY2xpIGBhZGRgIGFuZCB0aGUgc3VyZmFjZSdzIGFkZC1mb3JtIOKAlCBpbmhlcml0cyBvbmUgc291cmNlIG9mIHRydXRoLlxuY29uc3QgQVZBVEFSX0dMWVBIUyA9IFtcIvCflK1cIiwgXCLwn6qEXCIsIFwi8J+Mv1wiLCBcIvCflK5cIiwgXCLimqFcIiwgXCLwn5uw77iPXCIsIFwi4pyoXCIsIFwi8J+nrVwiLCBcIvCfk6FcIiwgXCLwn5e677iPXCIsIFwi4q2QXCIsIFwi8J+MmVwiXTtcbmZ1bmN0aW9uIGhhc2hTdHJpbmcoczogc3RyaW5nKTogbnVtYmVyIHtcbiAgbGV0IGggPSAwO1xuICBmb3IgKGNvbnN0IGNoIG9mIHMpIGggPSAoaCAqIDMxICsgKGNoLmNvZGVQb2ludEF0KDApID8/IDApKSA+Pj4gMDtcbiAgcmV0dXJuIGg7XG59XG5leHBvcnQgZnVuY3Rpb24gZmFsbGJhY2tBdmF0YXIobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIEFWQVRBUl9HTFlQSFNbaGFzaFN0cmluZyhuYW1lLnRyaW0oKS50b0xvd2VyQ2FzZSgpKSAlIEFWQVRBUl9HTFlQSFMubGVuZ3RoXTtcbn1cblxuLy8gQSByZWdpc3RyeSBpZCBkZXJpdmVkIGZyb20gYSBkaXNwbGF5IG5hbWUuIExpdmVzIGhlcmUgKHRoZSBwdXJlIGxheWVyKSBhbmQgaXNcbi8vIGFwcGxpZWQgYnkgYXBwbHlQcm9qZWN0QWRkIHdoZW4gbm8gZXhwbGljaXQgaWQgaXMgZ2l2ZW4sIHNvIGV2ZXJ5IHBhdGgg4oCUIGNsaVxuLy8gYGFkZGAgYW5kIHRoZSBzdXJmYWNlJ3MgYWRkLWZvcm0g4oCUIHNoYXJlcyBvbmUgc291cmNlIChubyBzbHVnIG1pcnJvciB0byBkcmlmdCkuXG5leHBvcnQgZnVuY3Rpb24gc2x1Z2lmeShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gKFxuICAgIG5hbWVcbiAgICAgIC50cmltKClcbiAgICAgIC50b0xvd2VyQ2FzZSgpXG4gICAgICAucmVwbGFjZSgvW15hLXowLTldKy9nLCBcIi1cIilcbiAgICAgIC5yZXBsYWNlKC9eLSt8LSskL2csIFwiXCIpIHx8IFwicHJvamVjdFwiXG4gICk7XG59XG5cbmNvbnN0IG5vcm1OYW1lID0gKHM6IHN0cmluZyk6IHN0cmluZyA9PiBzLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuY29uc3Qgbm9ybVBhdGggPSAoczogc3RyaW5nKTogc3RyaW5nID0+IHMudHJpbSgpLnJlcGxhY2UoL1xcLyskLywgXCJcIik7IC8vIGlnbm9yZSBhIHRyYWlsaW5nIHNsYXNoXG5cbi8vIERlZHVwZSBpcyBvbiBuYW1lIE9SIHBhdGggKGVpdGhlciBjb2xsaWRpbmcgaXMgYSBkdXBsaWNhdGUpOiB0d28gY2FyZHMgbXVzdFxuLy8gbmV2ZXIgcG9pbnQgYXQgdGhlIHNhbWUgcGF0aCwgbm9yIHNoYXJlIGEgbmFtZSB0aGUgaHVtYW4gY2FuJ3QgdGVsbCBhcGFydC5cbmV4cG9ydCBmdW5jdGlvbiBmaW5kRHVwbGljYXRlKFxuICBzdGF0ZTogT2JzZXJ2YXRvcnlTdGF0ZSxcbiAgbmFtZTogc3RyaW5nLFxuICBwYXRoOiBzdHJpbmcsXG4gIGV4Y2VwdElkPzogc3RyaW5nLFxuKTogUHJvamVjdCB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IG4gPSBub3JtTmFtZShuYW1lKTtcbiAgY29uc3QgcCA9IG5vcm1QYXRoKHBhdGgpO1xuICByZXR1cm4gc3RhdGUucHJvamVjdHMuZmluZChcbiAgICAocHIpID0+IHByLmlkICE9PSBleGNlcHRJZCAmJiAobm9ybU5hbWUocHIubmFtZSkgPT09IG4gfHwgbm9ybVBhdGgocHIucGF0aCkgPT09IHApLFxuICApO1xufVxuXG5jb25zdCBoYXNQcm9qZWN0ID0gKHN0YXRlOiBPYnNlcnZhdG9yeVN0YXRlLCBpZDogc3RyaW5nKTogYm9vbGVhbiA9PlxuICBzdGF0ZS5wcm9qZWN0cy5zb21lKChwKSA9PiBwLmlkID09PSBpZCk7XG5cbi8vIOKUgOKUgCBSZWdpc3RyeSAoZHVyYWJsZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseVByb2plY3RBZGQoc3RhdGU6IE9ic2VydmF0b3J5U3RhdGUsIHByb2plY3Q6IFByb2plY3QpOiBSZWR1Y2VyUmVzdWx0IHtcbiAgY29uc3QgbmFtZSA9IHByb2plY3QubmFtZT8udHJpbSgpO1xuICBjb25zdCBwYXRoID0gcHJvamVjdC5wYXRoPy50cmltKCk7XG4gIGlmICghbmFtZSB8fCAhcGF0aCkge1xuICAgIHJldHVybiB7IHN0YXRlLCBhcHBsaWVkOiBmYWxzZSwgZXJyb3I6IFwicHJvamVjdCByZXF1aXJlcyBhIG5hbWUgYW5kIHBhdGhcIiB9O1xuICB9XG4gIC8vIGlkICsgYXZhdGFyIGFyZSBERVJJVkVEIGZyb20gdGhlIG5hbWUgd2hlbiBub3QgZXhwbGljaXRseSBnaXZlbiwgc28gdGhlXG4gIC8vIGRhZW1vbiBpcyB0aGUgc2luZ2xlIHNvdXJjZSBmb3IgYm90aCAoY2xpLWFkZCBhbmQgdGhlIGFkZC1mb3JtIGluaGVyaXQgaXQpLlxuICBjb25zdCBpZCA9IHByb2plY3QuaWQ/LnRyaW0oKSB8fCBzbHVnaWZ5KG5hbWUpO1xuICBpZiAoaGFzUHJvamVjdChzdGF0ZSwgaWQpKSB7XG4gICAgcmV0dXJuIHsgc3RhdGUsIGFwcGxpZWQ6IGZhbHNlLCBlcnJvcjogYGlkICcke2lkfScgYWxyZWFkeSByZWdpc3RlcmVkYCB9O1xuICB9XG4gIGNvbnN0IGR1cCA9IGZpbmREdXBsaWNhdGUoc3RhdGUsIG5hbWUsIHBhdGgpO1xuICBpZiAoZHVwKSB7XG4gICAgcmV0dXJuIHsgc3RhdGUsIGFwcGxpZWQ6IGZhbHNlLCBlcnJvcjogYGR1cGxpY2F0ZSBvZiAnJHtkdXAuaWR9JyAoc2FtZSBuYW1lIG9yIHBhdGgpYCB9O1xuICB9XG4gIGNvbnN0IHJlZ2lzdGVyZWQ6IFByb2plY3QgPSB7XG4gICAgLi4ucHJvamVjdCxcbiAgICBpZCxcbiAgICBuYW1lLFxuICAgIHBhdGgsXG4gICAgYXZhdGFyOiBwcm9qZWN0LmF2YXRhcj8udHJpbSgpIHx8IGZhbGxiYWNrQXZhdGFyKG5hbWUpLFxuICB9O1xuICByZXR1cm4ge1xuICAgIHN0YXRlOiB7XG4gICAgICAuLi5zdGF0ZSxcbiAgICAgIHByb2plY3RzOiBbLi4uc3RhdGUucHJvamVjdHMsIHJlZ2lzdGVyZWRdLFxuICAgICAgcHJlc2VuY2U6IHsgLi4uc3RhdGUucHJlc2VuY2UsIFtpZF06IHsgY29ubmVjdGVkOiBmYWxzZSB9IH0sXG4gICAgfSxcbiAgICBhcHBsaWVkOiB0cnVlLFxuICAgIGlkLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlQcm9qZWN0UmVtb3ZlKHN0YXRlOiBPYnNlcnZhdG9yeVN0YXRlLCBpZDogc3RyaW5nKTogUmVkdWNlclJlc3VsdCB7XG4gIGlmICghaGFzUHJvamVjdChzdGF0ZSwgaWQpKSB7XG4gICAgcmV0dXJuIHsgc3RhdGUsIGFwcGxpZWQ6IGZhbHNlLCBlcnJvcjogYHVua25vd24gcHJvamVjdCAnJHtpZH0nYCB9O1xuICB9XG4gIGNvbnN0IHsgW2lkXTogX3AsIC4uLnByZXNlbmNlIH0gPSBzdGF0ZS5wcmVzZW5jZTtcbiAgY29uc3QgeyBbaWRdOiBfcywgLi4uc3RhdHVzIH0gPSBzdGF0ZS5zdGF0dXM7XG4gIHJldHVybiB7XG4gICAgc3RhdGU6IHsgLi4uc3RhdGUsIHByb2plY3RzOiBzdGF0ZS5wcm9qZWN0cy5maWx0ZXIoKHApID0+IHAuaWQgIT09IGlkKSwgcHJlc2VuY2UsIHN0YXR1cyB9LFxuICAgIGFwcGxpZWQ6IHRydWUsXG4gIH07XG59XG5cbi8vIOKUgOKUgCBQcmVzZW5jZSAobGl2ZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseVNldFByZXNlbmNlKFxuICBzdGF0ZTogT2JzZXJ2YXRvcnlTdGF0ZSxcbiAgaWQ6IHN0cmluZyxcbiAgY29ubmVjdGVkOiBib29sZWFuLFxuKTogUmVkdWNlclJlc3VsdCB7XG4gIGlmICghaGFzUHJvamVjdChzdGF0ZSwgaWQpKSB7XG4gICAgcmV0dXJuIHsgc3RhdGUsIGFwcGxpZWQ6IGZhbHNlLCBlcnJvcjogYHVua25vd24gcHJvamVjdCAnJHtpZH0nYCB9O1xuICB9XG4gIGlmICgoc3RhdGUucHJlc2VuY2VbaWRdPy5jb25uZWN0ZWQgPz8gZmFsc2UpID09PSBjb25uZWN0ZWQpIHtcbiAgICAvLyBCZW5pZ24gbm8tb3A6IHByZXNlbmNlIGlzIGFscmVhZHkgd2hhdCB3YXMgYXNrZWQgZm9yLiBOYW1lcyB0aGUgc3RhdGUsIG5vdFxuICAgIC8vIHRoZSBhY3Rpb24gKG91dGNvbWUtY29udHJhY3QgbWVtYmVyc2hpcCBydWxlIDIpLlxuICAgIHJldHVybiB7XG4gICAgICBzdGF0ZSxcbiAgICAgIGFwcGxpZWQ6IGZhbHNlLFxuICAgICAgb3V0Y29tZTogY29ubmVjdGVkID8gXCJhbHJlYWR5LWNvbm5lY3RlZFwiIDogXCJhbHJlYWR5LWRpc2Nvbm5lY3RlZFwiLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBzdGF0ZTogeyAuLi5zdGF0ZSwgcHJlc2VuY2U6IHsgLi4uc3RhdGUucHJlc2VuY2UsIFtpZF06IHsgY29ubmVjdGVkIH0gfSB9LFxuICAgIGFwcGxpZWQ6IHRydWUsXG4gIH07XG59XG5cbi8vIOKUgOKUgCBTdGF0dXMgKGN1cnJlbnQgb25seSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8vIEEgc3RhdHVzIHBvc3QgUkVQTEFDRVMgc3VtbWFyeS9waGFzZSBhbmQgYnVtcHMgbGFzdFVwZGF0ZWQ7IHRoZSBhdHRlbnRpb25cbi8vIGZsYWcgaXMgb3duZWQgYnkgYXBwbHlBdHRlbnRpb24sIHNvIGl0J3MgcHJlc2VydmVkIGFjcm9zcyBhIHN0YXR1cyBwb3N0LlxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5U3RhdHVzKFxuICBzdGF0ZTogT2JzZXJ2YXRvcnlTdGF0ZSxcbiAgaWQ6IHN0cmluZyxcbiAgdXBkYXRlOiB7IHN1bW1hcnk6IHN0cmluZzsgcGhhc2U/OiBzdHJpbmcgfSxcbiAgbm93OiBudW1iZXIsXG4pOiBSZWR1Y2VyUmVzdWx0IHtcbiAgaWYgKCFoYXNQcm9qZWN0KHN0YXRlLCBpZCkpIHtcbiAgICByZXR1cm4geyBzdGF0ZSwgYXBwbGllZDogZmFsc2UsIGVycm9yOiBgdW5rbm93biBwcm9qZWN0ICcke2lkfSdgIH07XG4gIH1cbiAgY29uc3QgcHJldiA9IHN0YXRlLnN0YXR1c1tpZF07XG4gIGNvbnN0IG5leHQ6IFN0YXR1cyA9IHtcbiAgICBzdW1tYXJ5OiB1cGRhdGUuc3VtbWFyeSxcbiAgICBwaGFzZTogdXBkYXRlLnBoYXNlLFxuICAgIG5lZWRzQXR0ZW50aW9uOiBwcmV2Py5uZWVkc0F0dGVudGlvbiA/PyBmYWxzZSxcbiAgICBxdWVzdGlvbjogcHJldj8ucXVlc3Rpb24sXG4gICAgbGFzdFVwZGF0ZWQ6IG5vdyxcbiAgfTtcbiAgcmV0dXJuIHsgc3RhdGU6IHsgLi4uc3RhdGUsIHN0YXR1czogeyAuLi5zdGF0ZS5zdGF0dXMsIFtpZF06IG5leHQgfSB9LCBhcHBsaWVkOiB0cnVlIH07XG59XG5cbi8vIFJhaXNlIG9yIGNsZWFyIHRoZSBodW1hbiBnYXRlLiBQcmVzZXJ2ZXMgdGhlIGN1cnJlbnQgc3VtbWFyeS9waGFzZTsgY2xlYXJpbmdcbi8vIGRyb3BzIHRoZSBxdWVzdGlvbi5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseUF0dGVudGlvbihcbiAgc3RhdGU6IE9ic2VydmF0b3J5U3RhdGUsXG4gIGlkOiBzdHJpbmcsXG4gIHJhaXNlZDogYm9vbGVhbixcbiAgcXVlc3Rpb246IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgbm93OiBudW1iZXIsXG4pOiBSZWR1Y2VyUmVzdWx0IHtcbiAgaWYgKCFoYXNQcm9qZWN0KHN0YXRlLCBpZCkpIHtcbiAgICByZXR1cm4geyBzdGF0ZSwgYXBwbGllZDogZmFsc2UsIGVycm9yOiBgdW5rbm93biBwcm9qZWN0ICcke2lkfSdgIH07XG4gIH1cbiAgY29uc3QgcHJldiA9IHN0YXRlLnN0YXR1c1tpZF07XG4gIGNvbnN0IG5leHRRdWVzdGlvbiA9IHJhaXNlZCA/IHF1ZXN0aW9uIDogdW5kZWZpbmVkO1xuICBpZiAoXG4gICAgKHByZXY/Lm5lZWRzQXR0ZW50aW9uID8/IGZhbHNlKSA9PT0gcmFpc2VkICYmXG4gICAgKHByZXY/LnF1ZXN0aW9uID8/IHVuZGVmaW5lZCkgPT09IG5leHRRdWVzdGlvblxuICApIHtcbiAgICAvLyBCZW5pZ24gbm8tb3A6IHRoZSBhdHRlbnRpb24gZmxhZyBBTkQgaXRzIHF1ZXN0aW9uIGFscmVhZHkgbWF0Y2guXG4gICAgcmV0dXJuIHsgc3RhdGUsIGFwcGxpZWQ6IGZhbHNlLCBvdXRjb21lOiByYWlzZWQgPyBcImFscmVhZHktcmFpc2VkXCIgOiBcImFscmVhZHktY2xlYXJlZFwiIH07XG4gIH1cbiAgY29uc3QgbmV4dDogU3RhdHVzID0ge1xuICAgIHN1bW1hcnk6IHByZXY/LnN1bW1hcnkgPz8gXCJcIixcbiAgICBwaGFzZTogcHJldj8ucGhhc2UsXG4gICAgbmVlZHNBdHRlbnRpb246IHJhaXNlZCxcbiAgICBxdWVzdGlvbjogbmV4dFF1ZXN0aW9uLFxuICAgIGxhc3RVcGRhdGVkOiBub3csXG4gIH07XG4gIHJldHVybiB7IHN0YXRlOiB7IC4uLnN0YXRlLCBzdGF0dXM6IHsgLi4uc3RhdGUuc3RhdHVzLCBbaWRdOiBuZXh0IH0gfSwgYXBwbGllZDogdHJ1ZSB9O1xufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7Ozs7QUFxREE7QUFDQTtBQUNBO0FBQ0E7OztBQ2lDTyxTQUFTLFVBQVUsQ0FBQyxRQUFRLGVBQWlDO0FBQUEsRUFDbEUsT0FBTyxFQUFFLE9BQU8sVUFBVSxDQUFDLEdBQUcsVUFBVSxDQUFDLEdBQUcsUUFBUSxDQUFDLEVBQUU7QUFBQTtBQU96RCxJQUFNLGdCQUFnQixDQUFDLGdCQUFLLGdCQUFNLGdCQUFNLGdCQUFNLFVBQUssc0JBQU8sVUFBSyxnQkFBTSxnQkFBTSxzQkFBTyxVQUFLLGNBQUk7QUFDM0YsU0FBUyxVQUFVLENBQUMsR0FBbUI7QUFBQSxFQUNyQyxJQUFJLElBQUk7QUFBQSxFQUNSLFdBQVcsTUFBTTtBQUFBLElBQUcsSUFBSyxJQUFJLE1BQU0sR0FBRyxZQUFZLENBQUMsS0FBSyxPQUFRO0FBQUEsRUFDaEUsT0FBTztB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QUFNLFdBQVcsWUFBWSxhQUFhLEtBQUssQ0FBQztBQUFBLENBQzNFO0FBQUEsRUFFQSxJQUFJLENBQUMsRUFBRTtBQUFBLElBQVksWUFBWSxHQUFHO0FBQUEsRUFFbEMsTUFBTSxZQUFZLFlBQVksTUFBTTtBQUFBLElBQ2xDLE1BQU0sa0JBQWtCLFFBQVEsT0FBTyxXQUFXO0FBQUEsSUFDbEQsSUFBSSxrQkFBa0I7QUFBQSxNQUFHLE1BQU07QUFBQSxJQUMvQixJQUFJLGdCQUFnQixpQkFBaUIsWUFBWSxJQUFJLElBQUksY0FBYyxVQUFVLElBQUksR0FBRztBQUFBLE1BQ3RGLFlBQVksRUFBRSxNQUFNLEtBQUssUUFBUSxVQUFVLENBQUM7QUFBQSxJQUM5QztBQUFBLEtBQ0MsR0FBRztBQUFBLEVBRU4sTUFBTSxZQUFZLFlBQVksWUFBWTtBQUFBLElBQ3hDLElBQUksV0FBVztBQUFBLE1BQ2IsWUFBWTtBQUFBLE1BQ1osTUFBTSxhQUFhO0FBQUEsSUFDckI7QUFBQSxLQUNDLElBQUk7QUFBQSxFQUVQLFFBQVEsTUFBTSxXQUFXLE1BQU07QUFBQSxFQUMvQixjQUFjLFNBQVM7QUFBQSxFQUN2QixjQUFjLFNBQVM7QUFBQSxFQUN2QixNQUFNLGFBQWE7QUFBQSxFQUNuQixVQUFVLEVBQUUsTUFBTSxVQUFVLFFBQVEsSUFBSSxTQUFTLENBQUM7QUFBQSxFQUNsRCxlQUFlO0FBQUEsRUFFZixNQUFNLElBQUksUUFBUSxDQUFDLE1BQU0sV0FBVyxHQUFHLEdBQUcsQ0FBQztBQUFBLEVBQzNDLFdBQVcsS0FBSztBQUFBLElBQVcsY0FBYyxDQUFDO0FBQUEsRUFDMUMsV0FBVyxLQUFLLFdBQVcsT0FBTztBQUFBLElBQUcsYUFBYSxDQUFDO0FBQUEsRUFDbkQsV0FBVyxLQUFLLFlBQVk7QUFBQSxJQUMxQixJQUFJO0FBQUEsTUFDRixFQUFFLE1BQU07QUFBQSxNQUNSLE1BQU07QUFBQSxFQUNWO0FBQUEsRUFDQSxXQUFXLE1BQU0sU0FBUztBQUFBLElBQ3hCLElBQUk7QUFBQSxNQUNGLEdBQUcsTUFBTTtBQUFBLE1BQ1QsTUFBTTtBQUFBLEVBQ1Y7QUFBQSxFQUNBLE1BQU0sUUFBUSxLQUFLLENBQUMsT0FBTyxLQUFLLElBQUksR0FBRyxJQUFJLFFBQVEsQ0FBQyxNQUFNLFdBQVcsR0FBRyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQUEsRUFDOUUsaUJBQWlCO0FBQUEsRUFDakIsT0FBTztBQUFBO0FBd0JULGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIjZGNEU2RDkxM0Y4NjA2OUI2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
