// @bun
var __require = import.meta.require;

// src/glamour/backend/server.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync3, rmSync as rmSync2, unlinkSync as unlinkSync2 } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join as join4 } from "path";
import { fileURLToPath } from "url";
import { parseArgs as nodeParseArgs } from "util";

// plugins/spellbook/skills/glamour/shared/types.ts
var AGENT_EVENT_TYPES = Object.freeze([
  "ready",
  "connected",
  "disconnected",
  "item.add",
  "message.user",
  "closed"
]);
function defaultStyleGuide() {
  return [
    {
      key: "understanding",
      label: "Understanding",
      status: "empty",
      content: "",
      prompts: [],
      colors: []
    },
    {
      key: "direction",
      label: "Direction",
      status: "empty",
      content: "",
      prompts: [],
      colors: []
    },
    {
      key: "palette",
      label: "Palette",
      status: "empty",
      content: "",
      prompts: [],
      colors: []
    },
    {
      key: "consistency",
      label: "Consistency",
      status: "empty",
      content: "",
      prompts: [],
      colors: []
    },
    {
      key: "prompts",
      label: "Re-cast prompts",
      status: "empty",
      content: "",
      prompts: [],
      colors: []
    },
    {
      key: "canonical",
      label: "Canonical images",
      status: "empty",
      content: "",
      prompts: [],
      colors: []
    }
  ];
}
function defaultState(title, intent) {
  return {
    title,
    intent,
    library: [],
    selectedIds: [],
    messages: [],
    styleGuide: defaultStyleGuide(),
    tray: [],
    scope: "all",
    focusSet: [],
    focusOwner: null,
    focusNote: "",
    status: { busy: false, text: "" }
  };
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
function tailIdleMs(beatMs) {
  return beatMs * MISSED_BEATS;
}

// src/glamour/backend/heartbeat.ts
var IDLE_TIMEOUT_SEC = MAX_IDLE_TIMEOUT_SEC;
var SSE_HEARTBEAT_MS = DEFAULT_HEARTBEAT_MS;
var TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

// src/glamour/backend/persist.server.ts
import { mkdirSync, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "fs";
import { join as join2 } from "path";
var EXT_BY_MIME = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif"
};
function saveDataUrl(dir, id, dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  const body = m?.[3];
  if (!m || body === undefined || !dir)
    return "";
  const mime = (m[1] ?? "application/octet-stream").toLowerCase();
  const buf = m[2] ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8");
  const ext = EXT_BY_MIME[mime] ?? "bin";
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const path = join2(dir, `${safeId}.${ext}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync2(path, buf);
    return path;
  } catch {
    return "";
  }
}
function saveText(dir, id, name, text) {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_") || `${id}.md`;
  const path = join2(dir, `${id}-${safe}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync2(path, text, "utf8");
    return path;
  } catch {
    return "";
  }
}
function materializeItem(filesDir, item) {
  if (item.src) {
    const p = saveDataUrl(filesDir, item.id, item.src);
    if (p)
      item.path = p;
  } else if (item.text) {
    const p = saveText(filesDir, item.id, item.title, item.text);
    if (p)
      item.path = p;
  }
}
function saveSnapshot(snapshotsDir, sessionId, state) {
  try {
    mkdirSync(snapshotsDir, { recursive: true });
    writeFileSync2(join2(snapshotsDir, `${sessionId}.json`), JSON.stringify(state));
  } catch {}
}
function loadSnapshot(path, title, intent) {
  const snap = JSON.parse(readFileSync3(path, "utf8"));
  const merged = { ...defaultState(title, intent), ...snap };
  merged.styleGuide = merged.styleGuide.map((s) => ({
    ...s,
    prompts: s.prompts ?? [],
    colors: s.colors ?? []
  }));
  return merged;
}

// src/glamour/backend/reduce.ts
function makeItem(p) {
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    src: p.src ?? "",
    path: p.path ?? "",
    text: p.text ?? "",
    mime: p.mime ?? "",
    tags: p.tags ?? [],
    starred: false,
    liked: false,
    annotations: { agent: "", human: "" },
    canonical: false,
    canon: [],
    archived: false,
    createdAt: p.createdAt,
    gen: p.gen ?? null
  };
}
function addItem(state, item) {
  if (state.library.some((i) => i.id === item.id))
    return false;
  state.library.push(item);
  return true;
}
function selectItems(state, ids) {
  state.selectedIds = [...ids];
}
function setStar(state, id, starred) {
  const it = state.library.find((i) => i.id === id);
  if (!it)
    return false;
  it.starred = starred;
  return true;
}
function setLike(state, id, liked) {
  const it = state.library.find((i) => i.id === id);
  if (!it)
    return false;
  it.liked = liked;
  return true;
}
function annotate(state, id, who, text) {
  const it = state.library.find((i) => i.id === id);
  if (!it)
    return false;
  it.annotations[who] = text;
  return true;
}
function addMessage(state, m) {
  state.messages.push(m);
}
function updateSection(state, key, patch) {
  const sec = state.styleGuide.find((s) => s.key === key);
  if (!sec)
    return false;
  if (patch.content !== undefined)
    sec.content = patch.content;
  if (patch.status !== undefined)
    sec.status = patch.status;
  if (patch.prompts !== undefined)
    sec.prompts = patch.prompts;
  if (patch.colors !== undefined)
    sec.colors = patch.colors;
  return true;
}
function setFocus(state, ids, owner, note = "") {
  state.scope = "focus";
  state.focusSet = [...ids];
  state.focusOwner = owner;
  state.focusNote = note;
}
function clearFocus(state) {
  state.scope = "all";
  state.focusSet = [];
  state.focusOwner = null;
  state.focusNote = "";
}
function setCanonical(state, id, canonical) {
  const it = state.library.find((i) => i.id === id);
  if (!it)
    return false;
  it.canonical = canonical;
  return true;
}
function archiveTrayStyle(state, id, archived) {
  const st = state.tray.find((s) => s.id === id);
  if (!st)
    return false;
  st.archived = archived;
  return true;
}
function buildStyleItem(style, canon, createdAt) {
  return {
    id: `style-${style.id}`,
    kind: "style",
    title: style.label,
    src: "",
    path: "",
    text: style.text,
    mime: "",
    tags: [],
    starred: false,
    liked: false,
    annotations: { agent: "", human: "" },
    canonical: false,
    canon,
    archived: false,
    createdAt,
    gen: null
  };
}
function setItemArchived(state, id, archived) {
  const it = state.library.find((i) => i.id === id);
  if (!it)
    return false;
  it.archived = archived;
  return true;
}
function setGenCost(state, id, cost) {
  const it = state.library.find((i) => i.id === id);
  if (!it?.gen)
    return false;
  it.gen.cost = cost;
  return true;
}
function setGenMeta(state, id, patch) {
  const it = state.library.find((i) => i.id === id);
  if (!it?.gen)
    return false;
  if (typeof patch.prompt === "string")
    it.gen.prompt = patch.prompt;
  if (patch.custom)
    it.gen.custom = { ...it.gen.custom ?? {}, ...patch.custom };
  return true;
}
function leanItem(it) {
  const { src: _s, text: _t, canon: _c, ...rest } = it;
  return rest;
}
function leanState(s) {
  return { ...s, library: s.library.map(leanItem) };
}
var AMBIENT_CLIENT = new Set([
  "item.select",
  "item.star",
  "item.like",
  "focus.set",
  "focus.clear",
  "item.canonical",
  "item.archive",
  "item.annotate"
]);
function applyAgentMsg(state, msg) {
  switch (msg.type) {
    case "init":
      if (typeof msg.title === "string")
        state.title = msg.title;
      if (typeof msg.intent === "string")
        state.intent = msg.intent;
      break;
    case "intent":
      state.intent = msg.text;
      break;
    case "item.annotate": {
      const it = state.library.find((i) => i.id === msg.id);
      if (it)
        it.annotations.agent = msg.agent;
      break;
    }
    case "section":
      updateSection(state, msg.key, {
        content: msg.content,
        status: msg.status,
        prompts: msg.prompts,
        colors: msg.colors
      });
      break;
    case "focus.push":
      setFocus(state, msg.ids, "agent", msg.note ?? "");
      break;
    case "gen.cost":
      setGenCost(state, msg.id, msg.cost);
      break;
    case "gen.meta":
      setGenMeta(state, msg.id, { prompt: msg.prompt, custom: msg.custom });
      break;
    case "status":
      state.status = { busy: msg.busy, text: msg.text ?? "" };
      break;
    case "style.archive":
      archiveTrayStyle(state, msg.id, msg.archived);
      break;
    case "say":
    case "close":
      break;
    default:
      return false;
  }
  return true;
}

// src/glamour/backend/styles.server.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readdirSync as readdirSync2, readFileSync as readFileSync4, writeFileSync as writeFileSync3 } from "fs";
import { basename, join as join3 } from "path";
var EXT_BY_MIME2 = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif"
};
function projectKey(projectDir) {
  const base = basename(projectDir).replace(/[^a-zA-Z0-9_-]/g, "_") || "root";
  let h = 5381;
  for (let i = 0;i < projectDir.length; i++)
    h = (h << 5) + h + projectDir.charCodeAt(i) >>> 0;
  return `${base}-${h.toString(36)}`;
}
function stylesDir(home, key) {
  return join3(home, "styles", key);
}
function saveStyle(home, key, args) {
  const dir = stylesDir(home, key);
  mkdirSync2(dir, { recursive: true });
  const canonical = [];
  for (const it of args.canonicalItems) {
    if (!it.path || !existsSync3(it.path))
      continue;
    const ext = EXT_BY_MIME2[it.mime] ?? "bin";
    const file = `${args.id}-${it.id}.${ext}`;
    try {
      writeFileSync3(join3(dir, file), readFileSync4(it.path));
      canonical.push({ id: it.id, title: it.title, file, mime: it.mime });
    } catch {}
  }
  const style = {
    id: args.id,
    label: args.label,
    text: args.text,
    sections: args.sections,
    canonical,
    createdAt: args.createdAt,
    archived: false
  };
  writeFileSync3(join3(dir, `${args.id}.json`), JSON.stringify(style));
  return style;
}
function loadTray(home, key) {
  const dir = stylesDir(home, key);
  if (!existsSync3(dir))
    return [];
  const out = [];
  for (const name of readdirSync2(dir)) {
    if (!name.endsWith(".json"))
      continue;
    try {
      out.push(JSON.parse(readFileSync4(join3(dir, name), "utf8")));
    } catch {}
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
function setStyleArchived(home, key, id, archived) {
  const path = join3(stylesDir(home, key), `${id}.json`);
  if (!existsSync3(path))
    return false;
  try {
    const style = JSON.parse(readFileSync4(path, "utf8"));
    style.archived = archived;
    writeFileSync3(path, JSON.stringify(style));
    return true;
  } catch {
    return false;
  }
}
function materializeCanon(home, key, style) {
  const dir = stylesDir(home, key);
  const out = [];
  for (const ref of style.canonical) {
    try {
      const bytes = readFileSync4(join3(dir, ref.file));
      out.push({
        title: ref.title,
        src: `data:${ref.mime};base64,${bytes.toString("base64")}`
      });
    } catch {}
  }
  return out;
}

// src/glamour/backend/server.ts
var SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
var SKILL_ROOT = join4(SCRIPT_DIR, "..");
var DIST_DIR = join4(SKILL_ROOT, "dist");
function resolveMode2() {
  return resolveMode(DIST_DIR);
}
function serveDist(path) {
  return serveFromDist(DIST_DIR, path === "/" ? "index.html" : path.slice(1));
}
var randHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map((b) => b.toString(16).padStart(2, "0")).join("");
async function startDaemon(opts) {
  const GLAMOUR_HOME = process.env.GLAMOUR_HOME ?? join4(homedir(), ".glamour");
  const SNAPSHOTS_DIR = join4(GLAMOUR_HOME, "snapshots");
  let state = defaultState(opts.title ?? "", opts.intent ?? "");
  let restored = false;
  if (opts.restore) {
    const path = existsSync4(opts.restore) ? opts.restore : join4(SNAPSHOTS_DIR, `${opts.restore}.json`);
    try {
      state = loadSnapshot(path, opts.title ?? "", opts.intent ?? "");
      restored = true;
    } catch (e) {
      process.stderr.write(`glamour: restore failed (${path}): ${e}
`);
    }
  }
  const PROJECT_KEY = projectKey(opts.project ?? process.cwd());
  const mode = resolveMode2();
  const devIndex = mode === "dev" ? (await import("../../../../../src/glamour/surface/index.html")).default : undefined;
  const routes = devIndex ? { "/": devIndex } : {};
  state.tray = loadTray(GLAMOUR_HOME, PROJECT_KEY);
  const sockets = new Set;
  const log = createEventLog();
  const sseClients = new Set;
  let lastActivity = performance.now();
  const touch = () => {
    lastActivity = performance.now();
  };
  const broadcast = (msg) => {
    const s = JSON.stringify(msg);
    for (const ws of sockets) {
      try {
        ws.send(s);
      } catch {}
    }
  };
  let snapDirty = false;
  const broadcastState = () => {
    snapDirty = true;
    broadcast({ type: "state", state });
  };
  const emitEvent = (msg) => log.emit(msg);
  const emitTransient = (msg) => {
    const frame = `data: ${JSON.stringify(msg)}

`;
    for (const c of sseClients)
      c.send(frame);
  };
  const sessionId = `glamour-${randHex(4)}`;
  const sessionFilesDir = join4(tmpdir(), `${sessionId}-files`);
  try {
    mkdirSync3(sessionFilesDir, { recursive: true });
  } catch {}
  if (restored) {
    for (const it of state.library)
      materializeItem(sessionFilesDir, it);
  }
  let resolveDone;
  const done = new Promise((r) => {
    resolveDone = r;
  });
  const handleAgentMsg = (msg) => {
    if (msg.type === "say") {
      addMessage(state, {
        id: `m-${randHex(4)}`,
        who: "agent",
        kind: msg.kind ?? "info",
        text: msg.text,
        ground: [],
        ts: Date.now()
      });
      broadcastState();
      return true;
    }
    if (msg.type === "close") {
      resolveDone({ code: 0, reason: "close" });
      return true;
    }
    if (msg.type === "gen.add") {
      const it = makeItem({
        id: `gen-${randHex(4)}`,
        kind: "gen",
        title: msg.label ?? `round ${msg.round}`,
        src: msg.src,
        mime: "image/webp",
        createdAt: Date.now(),
        gen: {
          model: msg.model,
          prompt: msg.prompt,
          seed: msg.seed ?? null,
          cost: msg.cost ?? null,
          custom: msg.custom ?? {},
          round: msg.round
        }
      });
      materializeItem(sessionFilesDir, it);
      const added = addItem(state, it);
      if (added)
        broadcastState();
      return {
        recognised: true,
        ok: true,
        detail: { id: it.id, outcome: added ? "created" : "already-recorded" }
      };
    }
    if (msg.type === "style.save") {
      const canonicalItems = state.library.filter((i) => i.canonical && !i.archived);
      const agreed = state.styleGuide.filter((s) => s.status !== "empty" && s.content);
      const text = agreed.map((s) => s.content).join(" \xB7 ").slice(0, 280);
      const style = saveStyle(GLAMOUR_HOME, PROJECT_KEY, {
        id: `style-${randHex(4)}`,
        label: msg.label,
        text,
        sections: state.styleGuide,
        canonicalItems,
        createdAt: Date.now()
      });
      state.tray.push(style);
      broadcastState();
      return true;
    }
    if (msg.type === "style.archive") {
      setStyleArchived(GLAMOUR_HOME, PROJECT_KEY, msg.id, msg.archived);
      applyAgentMsg(state, msg);
      broadcastState();
      return true;
    }
    const recognised = applyAgentMsg(state, msg);
    if (recognised)
      broadcastState();
    return recognised;
  };
  const handleClientMsg = (msg) => {
    switch (msg.type) {
      case "item.add": {
        const it = makeItem({
          id: `${msg.item.kind}-${randHex(4)}`,
          kind: msg.item.kind,
          title: msg.item.title,
          src: msg.item.src,
          text: msg.item.text,
          mime: msg.item.mime ?? "",
          createdAt: Date.now()
        });
        materializeItem(sessionFilesDir, it);
        if (addItem(state, it)) {
          broadcastState();
          emitEvent({
            type: "item.add",
            item: leanItem(it),
            selectedIds: state.selectedIds
          });
        }
        break;
      }
      case "item.select":
        selectItems(state, msg.ids);
        broadcastState();
        break;
      case "item.star":
        if (setStar(state, msg.id, msg.starred))
          broadcastState();
        break;
      case "item.like":
        if (setLike(state, msg.id, msg.liked))
          broadcastState();
        break;
      case "item.annotate":
        if (annotate(state, msg.id, "human", msg.human))
          broadcastState();
        break;
      case "message.send": {
        const ground = [...state.selectedIds];
        addMessage(state, {
          id: `m-${randHex(4)}`,
          who: "user",
          kind: "info",
          text: msg.text,
          ground,
          ts: Date.now()
        });
        broadcastState();
        emitEvent({ type: "message.user", text: msg.text, ground });
        break;
      }
      case "focus.set":
        setFocus(state, msg.ids, "you");
        broadcastState();
        break;
      case "focus.clear":
        clearFocus(state);
        broadcastState();
        break;
      case "item.canonical":
        if (setCanonical(state, msg.id, msg.canonical))
          broadcastState();
        break;
      case "item.archive":
        if (setItemArchived(state, msg.id, msg.archived))
          broadcastState();
        break;
      case "style.bringIn": {
        const style = state.tray.find((s) => s.id === msg.id);
        if (!style)
          break;
        const itemId = `style-${style.id}`;
        if (state.library.some((i) => i.id === itemId))
          break;
        const canon = materializeCanon(GLAMOUR_HOME, PROJECT_KEY, style);
        const it = buildStyleItem(style, canon, Date.now());
        if (addItem(state, it)) {
          broadcastState();
          emitEvent({ type: "item.add", item: leanItem(it), selectedIds: state.selectedIds });
        }
        break;
      }
    }
  };
  const eventsResponse = (req, url) => {
    touch();
    return sseResponse({
      log,
      since: Number.parseInt(url.searchParams.get("since") ?? "-1", 10),
      heartbeatMs: SSE_HEARTBEAT_MS,
      clients: sseClients,
      signal: req.signal,
      onOpen: touch,
      onClose: touch
    });
  };
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: opts.host ?? "127.0.0.1",
    routes,
    idleTimeout: IDLE_TIMEOUT_SEC,
    development: { hmr: mode === "dev" },
    fetch(req, srv) {
      {
        const refused = refuseForeignOrigin(req, srv.port, srv.hostname);
        if (refused)
          return refused;
      }
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/ws")
        return srv.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 });
      if (req.method === "GET" && path === "/state") {
        touch();
        const lean = url.searchParams.get("lean") === "1";
        return Response.json({
          state: lean ? leanState(state) : state,
          cursor: log.cursor()
        });
      }
      if (req.method === "GET" && path === "/events")
        return eventsResponse(req, url);
      if (req.method === "POST" && path === "/cmd")
        return req.json().then((b) => {
          touch();
          const verdict = handleAgentMsg(b);
          if (typeof verdict === "object")
            return Response.json({ ok: true, applied: true, ...verdict.detail });
          const applied = verdict;
          if (!applied) {
            return Response.json({
              ok: false,
              applied: false,
              error: `unrecognised command type ${JSON.stringify(b?.type)} \u2014 nothing was applied`
            }, { status: 400 });
          }
          return Response.json({ ok: true, applied: true });
        }).catch(() => Response.json({ error: "bad json" }, { status: 400 }));
      if (req.method === "GET" && path.startsWith("/assets/")) {
        const name = decodeURIComponent(path.slice("/assets/".length));
        if (name.includes("..") || name.startsWith("/"))
          return Response.json({ error: "not found" }, { status: 404 });
        const f = Bun.file(join4(sessionFilesDir, name));
        return f.exists().then((ok) => ok ? new Response(f) : Response.json({ error: "not found" }, { status: 404 }));
      }
      if (mode === "release") {
        const asset = serveDist(path);
        if (asset)
          return asset;
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        touch();
        emitTransient({ type: "connected" });
        ws.send(JSON.stringify({ type: "state", state }));
      },
      message(_ws, raw) {
        touch();
        try {
          handleClientMsg(JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)));
        } catch (e) {
          process.stderr.write(`glamour: bad json from browser: ${e}
`);
        }
      },
      close(ws) {
        sockets.delete(ws);
        emitTransient({ type: "disconnected" });
      }
    }
  });
  const boundPort = server.port;
  const sessionFile = join4(tmpdir(), `glamour-${sessionId}.json`);
  const latestFile = join4(tmpdir(), `glamour-latest.json`);
  const info = JSON.stringify({
    url: `http://${opts.host ?? "127.0.0.1"}:${boundPort}`,
    port: boundPort,
    session_id: sessionId,
    title: state.title,
    files_dir: sessionFilesDir,
    mode
  });
  try {
    writeFileAtomic(sessionFile, info);
    writeFileAtomic(latestFile, info);
  } catch {}
  emitEvent({ type: "ready", mode });
  const saveNow = () => saveSnapshot(SNAPSHOTS_DIR, sessionId, state);
  if (restored)
    saveNow();
  const timeoutS = opts.timeoutS ?? 1800;
  const stopHousekeeping = startHousekeeping({
    subscriberCount: () => sockets.size + sseClients.size,
    idleMs: () => performance.now() - lastActivity,
    touch,
    timeoutMs: timeoutS * 1000,
    onIdleClose: () => resolveDone({ code: EXIT_IDLE_TIMEOUT, reason: "timeout" }),
    snapshot: {
      dirty: () => snapDirty,
      clear: () => {
        snapDirty = false;
      },
      write: saveNow
    }
  });
  let closed = false;
  let resolveShutdown;
  const shutdown = new Promise((r) => {
    resolveShutdown = r;
  });
  const cleanupDiscovery = () => {
    try {
      unlinkSync2(sessionFile);
    } catch {}
    unlinkIfMatches(latestFile, sessionId, (raw) => {
      try {
        const id = JSON.parse(raw).session_id;
        return typeof id === "string" ? id : null;
      } catch {
        return null;
      }
    });
    try {
      rmSync2(sessionFilesDir, { recursive: true, force: true });
    } catch {}
  };
  const close = () => {
    if (closed)
      return;
    closed = true;
    stopHousekeeping();
    saveNow();
    cleanupDiscovery();
    emitEvent({ type: "closed" });
    drainAndStop({ server, clients: sseClients, sockets }).then(resolveShutdown);
  };
  done.then(() => close());
  return { port: boundPort, sessionId, mode, close, done, shutdown };
}
var DAEMON_OPTIONS = {
  intent: { type: "string" },
  port: { type: "string" },
  project: { type: "string" },
  restore: { type: "string" },
  timeout: { type: "string" },
  title: { type: "string" }
};
async function main(argv) {
  let flags;
  try {
    flags = nodeParseArgs({ args: argv, options: DAEMON_OPTIONS, strict: true }).values;
  } catch (e) {
    process.stderr.write(`glamour: ${e instanceof Error ? e.message : String(e)}
  recognized flags: ${Object.keys(DAEMON_OPTIONS).map((k) => `--${k}`).join(" ")}
`);
    return 2;
  }
  const d = await startDaemon({
    port: flags.port ? Number(flags.port) : 0,
    title: flags.title,
    intent: flags.intent,
    restore: flags.restore,
    timeoutS: flags.timeout ? Number(flags.timeout) : undefined,
    project: flags.project
  });
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${d.port}`, port: d.port, session_id: d.sessionId, mode: d.mode })}
`);
  const res = await d.done;
  await d.shutdown;
  return res.code;
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  main,
  resolveMode2 as resolveMode,
  run,
  startDaemon
};
