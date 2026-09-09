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
import { existsSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
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
  await Promise.race([
    Promise.resolve(opts.server.stop(true)),
    new Promise((r) => setTimeout(r, stopMs))
  ]);
}

// src/kit/wire/serveDist.ts
import { existsSync as existsSync2 } from "fs";
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
  const file = join(distDir, rel);
  if (!existsSync2(file))
    return null;
  return new Response(Bun.file(file), { headers: { "Content-Type": contentTypeFor(rel) } });
}

// src/kit/wire/sse.ts
function sseResponse(opts) {
  const { log, since, heartbeatMs, clients, signal, filter, onOpen, onClose } = opts;
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
import { mkdirSync, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";
import { join as join2 } from "path";
var EXT_BY_MIME = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif"
};
function saveDataUrl(dir, id, dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m || !dir)
    return "";
  const mime = (m[1] ?? "application/octet-stream").toLowerCase();
  const body = m[3];
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
  const snap = JSON.parse(readFileSync2(path, "utf8"));
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
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readdirSync, readFileSync as readFileSync3, writeFileSync as writeFileSync3 } from "fs";
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
      writeFileSync3(join3(dir, file), readFileSync3(it.path));
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
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json"))
      continue;
    try {
      out.push(JSON.parse(readFileSync3(join3(dir, name), "utf8")));
    } catch {}
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
function setStyleArchived(home, key, id, archived) {
  const path = join3(stylesDir(home, key), `${id}.json`);
  if (!existsSync3(path))
    return false;
  try {
    const style = JSON.parse(readFileSync3(path, "utf8"));
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
      const bytes = readFileSync3(join3(dir, ref.file));
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
    onIdleClose: () => resolveDone({ code: 124, reason: "timeout" }),
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

//# debugId=C2C20F40A1F553F564756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9zZXJ2ZXIudHMiLCAiLi4vc2hhcmVkL3R5cGVzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc3NlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9wZXJzaXN0LnNlcnZlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvZ2xhbW91ci9iYWNrZW5kL3JlZHVjZS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvZ2xhbW91ci9iYWNrZW5kL3N0eWxlcy5zZXJ2ZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHVubGlua1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgYXMgbm9kZVBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7XG4gIHR5cGUgQWdlbnRDb21tYW5kLFxuICB0eXBlIENsaWVudFRvU2VydmVyLFxuICBkZWZhdWx0U3RhdGUsXG4gIHR5cGUgR2xhbW91clN0YXRlLFxufSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dsYW1vdXIvc2hhcmVkL3R5cGVzXCI7XG5pbXBvcnQgeyB1bmxpbmtJZk1hdGNoZXMsIHdyaXRlRmlsZUF0b21pYyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9kaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB7IGNyZWF0ZUV2ZW50TG9nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2V2ZW50TG9nLnRzXCI7XG5pbXBvcnQgeyBkcmFpbkFuZFN0b3AsIHN0YXJ0SG91c2VrZWVwaW5nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hvdXNla2VlcGluZy50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZU1vZGUgYXMgcmVzb2x2ZU1vZGVJbiwgc2VydmVGcm9tRGlzdCB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9zZXJ2ZURpc3QudHNcIjtcbmltcG9ydCB7IHR5cGUgU3NlQ2xpZW50cywgc3NlUmVzcG9uc2UgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvc3NlLnRzXCI7XG5pbXBvcnQgeyBJRExFX1RJTUVPVVRfU0VDLCBTU0VfSEVBUlRCRUFUX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0XCI7XG5pbXBvcnQgeyBsb2FkU25hcHNob3QsIG1hdGVyaWFsaXplSXRlbSwgc2F2ZVNuYXBzaG90IH0gZnJvbSBcIi4vcGVyc2lzdC5zZXJ2ZXJcIjtcbmltcG9ydCB7XG4gIGFkZEl0ZW0sXG4gIGFkZE1lc3NhZ2UsXG4gIGFubm90YXRlLFxuICBhcHBseUFnZW50TXNnLFxuICBidWlsZFN0eWxlSXRlbSxcbiAgY2xlYXJGb2N1cyxcbiAgbGVhbkl0ZW0sXG4gIGxlYW5TdGF0ZSxcbiAgbWFrZUl0ZW0sXG4gIHNlbGVjdEl0ZW1zLFxuICBzZXRDYW5vbmljYWwsXG4gIHNldEZvY3VzLFxuICBzZXRJdGVtQXJjaGl2ZWQsXG4gIHNldExpa2UsXG4gIHNldFN0YXIsXG59IGZyb20gXCIuL3JlZHVjZVwiO1xuaW1wb3J0IHtcbiAgbG9hZFRyYXksXG4gIG1hdGVyaWFsaXplQ2Fub24sXG4gIHByb2plY3RLZXksXG4gIHNhdmVTdHlsZSxcbiAgc2V0U3R5bGVBcmNoaXZlZCxcbn0gZnJvbSBcIi4vc3R5bGVzLnNlcnZlclwiO1xuXG4vLyBUaGUgc3VyZmFjZSdzIEhUTUwgZW50cnkgdXNlZCB0byBiZSBhIHRvcC1sZXZlbCBzdGF0aWMgaW1wb3J0IGhlcmUuIEEgc3RhdGljXG4vLyBpbXBvcnQgZm9yY2VzIEJ1biB0byByZXNvbHZlIHRoZSB3aG9sZSAudHN4ICsgVGFpbHdpbmQgZ3JhcGggd2hlbiB0aGlzIG1vZHVsZVxuLy8gTE9BRFMsIHNvIGEgZGVzdGluYXRpb24gdGhhdCBzaGlwcyBkaXN0LyBhbmQgbm8gc3VyZmFjZSBzb3VyY2Ug4oCUIHRoZSBwdWJsaXNoZWRcbi8vIGFydGlmYWN0IOKAlCBkaWVzIGJlZm9yZSBpdCBjYW4gc2VydmUgdGhlIGRpc3QgaXQgZG9lcyBoYXZlLiBUaGUgZGV2IGltcG9ydCBpc1xuLy8gdGhlcmVmb3JlIGR5bmFtaWMgYW5kIHJlYWNoZWQgb25seSBvbiB0aGUgZGV2IGJyYW5jaCBiZWxvdyAoc2VhbXMgQ29udHJhY3QgMSksXG4vLyBhcyBhc3Ryb2xhYmUsIGltYWdvIGFuZCBtaW5kLW1hcHBlciBkbyBpdC5cbi8vXG4vLyBQYXRocyBhbmNob3IgYXQgdGhlIFNLSUxMIFJPT1QsIG5ldmVyIGF0IGN3ZDogY2xpLnRzIHBpbnMgdGhlIGRhZW1vbidzIGN3ZCBmb3Jcbi8vIGJ1bmZpZy50b21sJ3Mgc2FrZSBpbiBkZXYgKENvbnRyYWN0IDUpLCBzbyBjd2QgaXMgbm90IGEgc3RhYmxlIGJhc2UgZm9yIGRpc3QvLlxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuXG4vLyByZWxlYXNlIGlmZiBkaXN0L2luZGV4Lmh0bWwgZXhpc3RzIGF0IHRoZSBza2lsbCByb290IOKAlCB0aGUgRklMRSwgbmV2ZXIgdGhlXG4vLyBkaXJlY3RvcnkgKGEgYnVpbHQgYmFja2VuZCBjYW4gcHV0IGNsaS5qcyBpbiBkaXN0LyB3aXRoIG5vIHN1cmZhY2UgdGhlcmUpIOKAlFxuLy8gZWxzZSBkZXY7IHRoZSBlbnYgb3ZlcnJpZGUgd2lucyBlaXRoZXIgd2F5IChDb250cmFjdCAxKS4gUmVsZWFzZTogemVybyByZWFkc1xuLy8gb2Ygc3VyZmFjZSBzb3VyY2Ugb3IgYnVuZmlnLnRvbWwg4oCUIHN0YXRpYyBmaWxlcyBvbmx5LlxuLy9cbi8vIFRoZSBwcmVkaWNhdGUgYW5kIHRoZSBzY2FyIGl0IGNhcnJpZXMgYXJlIG5vdyBgc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50c2A7XG4vLyB3aGF0IHN0YXlzIGhlcmUgaXMgV0hJQ0ggZGlyZWN0b3J5IGdsYW1vdXIgcmVzb2x2ZXMgYWdhaW5zdC4gRXhwb3J0ZWQgYmVjYXVzZVxuLy8gdGhpcyBzcGVsbCdzIG93biBzdWl0ZXMgYXNrIGl0LlxuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKCk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIHJldHVybiByZXNvbHZlTW9kZUluKERJU1RfRElSKTtcbn1cblxuLy8gU2VydmVzIGRpc3QvIHZlcmJhdGltIOKAlCBlbnRyeSBpbmRleC5odG1sLCBoYXNoZWQgY2h1bmtzIGJ5IHBhdGggKENvbnRyYWN0IDInc1xuLy8gZmxhdCwgcmVsYXRpdmUtaHJlZiBsYXlvdXQpLiDim5QgVEhFIFVSTOKGkkZJTEVOQU1FIE1BUFBJTkcgU1RBWVMgSEVSRSBPTiBQVVJQT1NFOlxuLy8gdGhlIGtpdCBkZWNpZGVzIHdoZXRoZXIgYSBmaWxlIG1heSBiZSByZWFkIGFuZCB3aGF0IGNvbnRlbnQgdHlwZSBpdCBnZXRzLCBhbmRcbi8vIHRoZSBDQUxMRVIgZGVjaWRlcyB3aGljaCBmaWxlIOKAlCBiZWNhdXNlIHR3byBzcGVsbHMgcm91dGUgdGhpcyBkaWZmZXJlbnRseSBhbmQgYVxuLy8gc2lnbmF0dXJlIHdpZGUgZW5vdWdoIGZvciBib3RoIHN0b3BzIGJlaW5nIGEgZmlsZSBzZXJ2ZXIuIGdsYW1vdXIncyBvd25cbi8vIGBHRVQgL2Fzc2V0cy88bmFtZT5gIHNlc3Npb24tZmlsZXMgcm91dGUgc2l0cyBBQk9WRSB0aGlzIGluIHRoZSBmZXRjaCBjaGFpbixcbi8vIGFuZCBgc2VydmVGcm9tRGlzdGAgcmVmdXNpbmcgYW55dGhpbmcgd2l0aCBhIHNsYXNoIGluIGl0IGlzIHdoYXQga2VlcHMgdGhlIHR3b1xuLy8gZGlzam9pbnQgKGV2ZXJ5IC9hc3NldHMvIHBhdGggaXMgbmVzdGVkLCBzbyBpdCBpcyByZWZ1c2VkIGhlcmUgYW5kIGZhbGxzXG4vLyB0aHJvdWdoKS5cbmZ1bmN0aW9uIHNlcnZlRGlzdChwYXRoOiBzdHJpbmcpOiBSZXNwb25zZSB8IG51bGwge1xuICByZXR1cm4gc2VydmVGcm9tRGlzdChESVNUX0RJUiwgcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSkpO1xufVxuXG5jb25zdCByYW5kSGV4ID0gKG46IG51bWJlcikgPT5cbiAgQXJyYXkuZnJvbShjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKG5ldyBVaW50OEFycmF5KG4pKSlcbiAgICAubWFwKChiKSA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpXG4gICAgLmpvaW4oXCJcIik7XG5cbmV4cG9ydCB0eXBlIFN0YXJ0T3B0cyA9IHtcbiAgcG9ydD86IG51bWJlcjtcbiAgaG9zdD86IHN0cmluZztcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIGludGVudD86IHN0cmluZztcbiAgcmVzdG9yZT86IHN0cmluZztcbiAgdGltZW91dFM/OiBudW1iZXI7XG4gIHByb2plY3Q/OiBzdHJpbmc7XG59O1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnREYWVtb24ob3B0czogU3RhcnRPcHRzKSB7XG4gIGNvbnN0IEdMQU1PVVJfSE9NRSA9IHByb2Nlc3MuZW52LkdMQU1PVVJfSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuZ2xhbW91clwiKTtcbiAgY29uc3QgU05BUFNIT1RTX0RJUiA9IGpvaW4oR0xBTU9VUl9IT01FLCBcInNuYXBzaG90c1wiKTtcbiAgbGV0IHN0YXRlOiBHbGFtb3VyU3RhdGUgPSBkZWZhdWx0U3RhdGUob3B0cy50aXRsZSA/PyBcIlwiLCBvcHRzLmludGVudCA/PyBcIlwiKTtcbiAgbGV0IHJlc3RvcmVkID0gZmFsc2U7XG4gIGlmIChvcHRzLnJlc3RvcmUpIHtcbiAgICBjb25zdCBwYXRoID0gZXhpc3RzU3luYyhvcHRzLnJlc3RvcmUpXG4gICAgICA/IG9wdHMucmVzdG9yZVxuICAgICAgOiBqb2luKFNOQVBTSE9UU19ESVIsIGAke29wdHMucmVzdG9yZX0uanNvbmApO1xuICAgIHRyeSB7XG4gICAgICBzdGF0ZSA9IGxvYWRTbmFwc2hvdChwYXRoLCBvcHRzLnRpdGxlID8/IFwiXCIsIG9wdHMuaW50ZW50ID8/IFwiXCIpO1xuICAgICAgcmVzdG9yZWQgPSB0cnVlO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBnbGFtb3VyOiByZXN0b3JlIGZhaWxlZCAoJHtwYXRofSk6ICR7ZX1cXG5gKTtcbiAgICB9XG4gIH1cbiAgY29uc3QgUFJPSkVDVF9LRVkgPSBwcm9qZWN0S2V5KG9wdHMucHJvamVjdCA/PyBwcm9jZXNzLmN3ZCgpKTtcbiAgLy8gLS0tIG1vZGUsIHJlc29sdmVkIEJFRk9SRSBhbnkgZmlsZXN5c3RlbSB3cml0ZSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBBIGZvcmNlZC1kZXYgYm9vdCBhdCBhIHN1cmZhY2UtZnJlZSBkZXN0aW5hdGlvbiBtdXN0IGRpZSBIRVJFLCBhdCB0aGUgaW1wb3J0LFxuICAvLyBoYXZpbmcgd3JpdHRlbiBub3RoaW5nOiBubyBzZXNzaW9uLWZpbGVzIGRpciwgbm8gZGlzY292ZXJ5IHBvaW50ZXIuIE1lYXN1cmVkXG4gIC8vIGluIHRoZSBsb2NhbC1zaW06IHdpdGggdGhpcyBibG9jayBwbGFjZWQgYWZ0ZXIgdGhlIHNlc3Npb24tZmlsZXMgbWtkaXIsIGFcbiAgLy8gZHlpbmcgZGFlbW9uIGxlZnQgYCRUTVBESVIvZ2xhbW91ci08aWQ+LWZpbGVzL2AgYmVoaW5kIG9uIGV2ZXJ5IGZhaWxlZCBib290LlxuICBjb25zdCBtb2RlID0gcmVzb2x2ZU1vZGUoKTtcbiAgLy8gZGV2OiB0aGUgZHluYW1pYyBzdHJpbmctbGl0ZXJhbCBpbXBvcnQga2VlcHMgdGhlIHN1cmZhY2UgZ3JhcGggb2ZmIHRoZSBtb2R1bGVcbiAgLy8gbG9hZCBwYXRoIChDb250cmFjdCAxKSDigJQgQnVuIGJ1bmRsZXMgdGhlIC50c3ggZ3JhcGggKyBUYWlsd2luZCBhdCBzZXJ2ZSB0aW1lLFxuICAvLyByZWFkaW5nIGJ1bmZpZy50b21sIGZyb20gY3dkLCB3aGljaCBjbGkudHMgcGlucyB0byBzcmMvZ2xhbW91ci8gKENvbnRyYWN0IDUpLlxuICAvLyByZWxlYXNlOiBkaXN0LyBpcyBzdGF0aWMgYW5kIHByZS1idWlsdCAoQ29udHJhY3QgMikg4oCUIFwiL1wiIGlzIGFuc3dlcmVkIGJ5XG4gIC8vIHNlcnZlRGlzdCgpIGluIHRoZSBmZXRjaCBmYWxsLXRocm91Z2gsIHNvIHRoaXMgYnJhbmNoIG5ldmVyIHRvdWNoZXMgc3VyZmFjZVxuICAvLyBzb3VyY2Ugb3IgYnVuZmlnLnRvbWwgYW5kIG5ldmVyIG5lZWRzIGVpdGhlciB0byBleGlzdC4gQnVuJ3MgUm91dGVzIHR5cGUgdGllc1xuICAvLyB0aGUgXCIvXCIgdmFsdWUncyB0eXBlIHRvIHRoZSBsaXRlcmFsIG9iamVjdCBzaGFwZSwgc28gdGhlIG1vZGUtdGVybmFyeSB1bmlvblxuICAvLyBpcyBjYXN0OyB0aGUgcnVudGltZSBiZWhhdmlvdXIgKEhUTUxCdW5kbGUgaW4gZGV2LCBhYnNlbnQgaW4gcmVsZWFzZSkgaXNcbiAgLy8gY29ycmVjdCBlaXRoZXIgd2F5LiBUaGlzIGlzIHRoZSBPTkUgc3JjLy1uYW1pbmcgc3BlY2lmaWVyIGluIHRoZSBkZXBsb3llZFxuICAvLyBzcGVsbCAocGxhbiBTMiwgcmF0aWZpZWQgYXQgdGhlIHNwZWNpZmllciBncmFpbikuXG4gIGNvbnN0IGRldkluZGV4ID1cbiAgICBtb2RlID09PSBcImRldlwiXG4gICAgICA/IChhd2FpdCBpbXBvcnQoXCIuLi8uLi8uLi8uLi8uLi9zcmMvZ2xhbW91ci9zdXJmYWNlL2luZGV4Lmh0bWxcIikpLmRlZmF1bHRcbiAgICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCByb3V0ZXMgPSAoZGV2SW5kZXggPyB7IFwiL1wiOiBkZXZJbmRleCB9IDoge30pIGFzIFJlY29yZDxzdHJpbmcsIG5ldmVyPjtcbiAgLy8gTG9hZCB0aGUgcHJvamVjdCdzIHNhdmVkIHN0eWxlcyBpbnRvIHRoZSB0cmF5IChtZXRhZGF0YSBvbmx5IOKAlCBOT1QgdGhlXG4gIC8vIGxpYnJhcnkpLiBEbyB0aGlzIGFmdGVyIHJlc3RvcmUgc28gYSByZXN0b3JlZCBzbmFwc2hvdCdzIHN0YWxlIHRyYXkgaXNcbiAgLy8gcmVwbGFjZWQgYnkgdGhlIGF1dGhvcml0YXRpdmUgb24tZGlzayBzZXQuXG4gIHN0YXRlLnRyYXkgPSBsb2FkVHJheShHTEFNT1VSX0hPTUUsIFBST0pFQ1RfS0VZKTtcblxuICAvLyAtLS0gY2hhbm5lbHMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHNvY2tldHMgPSBuZXcgU2V0PGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4+KCk7XG4gIC8vIFRoZSByZXBsYXkgbG9nIGJlaGluZCBgR0VUIC9ldmVudHM/c2luY2U9PGlkPmAg4oCUIHNoYXJlZFxuICAvLyAoYGtpdC93aXJlL2V2ZW50TG9nLnRzYCksIHNvIGdsYW1vdXIgaW5oZXJpdHMgdGhlIGJvdW5kZWQgYnVmZmVyLCB0aGVcbiAgLy8gbW9ub3RvbmljIGlkIHRoYXQgYWN0dWFsbHkgV0lOUyBvdmVyIGEgcGF5bG9hZCBgaWRgLCBhbmQgdGhlIHN0YWxlLXdhdGVybWFya1xuICAvLyByZXBsYXkgdGhhdCBsZXRzIGEgdGFpbCByZXN1bWluZyBhZ2FpbnN0IGEgcmVzdGFydGVkIGRhZW1vbiByZWNlaXZlIGFueXRoaW5nXG4gIC8vIGF0IGFsbC4gZ2xhbW91ciBzdGFtcHMgTk8gRVBPQ0g6IGEgc2Vzc2lvbiBpcyBpZGVudGlmaWVkIGJ5IGBzZXNzaW9uX2lkYCwgYVxuICAvLyByZXN0YXJ0IGlzIGEgZGlmZmVyZW50IHNlc3Npb24sIGFuZCBhIHJlc3VtaW5nIHRhaWwgaXMgYWxyZWFkeSB0YWxraW5nIHRvIGFcbiAgLy8gZGlmZmVyZW50IGRhZW1vbiBieSBuYW1lIChEMTkncyByZWFzb25pbmcgZm9yIG1hZ3BpZSwgYW5kIGl0IGlzIGdsYW1vdXIncyB0b28pLlxuICBjb25zdCBsb2cgPSBjcmVhdGVFdmVudExvZzxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oKTtcbiAgY29uc3Qgc3NlQ2xpZW50czogU3NlQ2xpZW50cyA9IG5ldyBTZXQoKTtcbiAgbGV0IGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICBjb25zdCB0b3VjaCA9ICgpID0+IHtcbiAgICBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgfTtcblxuICBjb25zdCBicm9hZGNhc3QgPSAobXNnOiBvYmplY3QpID0+IHtcbiAgICBjb25zdCBzID0gSlNPTi5zdHJpbmdpZnkobXNnKTtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLnNlbmQocyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogc29ja2V0IGNsb3NlZCAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcbiAgbGV0IHNuYXBEaXJ0eSA9IGZhbHNlO1xuICBjb25zdCBicm9hZGNhc3RTdGF0ZSA9ICgpID0+IHtcbiAgICBzbmFwRGlydHkgPSB0cnVlO1xuICAgIGJyb2FkY2FzdCh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGUgfSk7XG4gIH07XG4gIGNvbnN0IGVtaXRFdmVudCA9IChtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBsb2cuZW1pdChtc2cpO1xuXG4gIC8vIFByZXNlbmNlIGlzIHRyYW5zaWVudDogc3RyZWFtIHRvIGxpdmUgU1NFIGNsaWVudHMgYnV0IERPIE5PVCBzdG9yZSBpdCBpblxuICAvLyB0aGUgcmVwbGF5IGxvZyAoYSByZWNvbm5lY3RpbmcgYWdlbnQgc2hvdWxkIG5vdCByZS1zZWUgZXZlcnkgcGFzdFxuICAvLyBjb25uZWN0L2Rpc2Nvbm5lY3QpLiBObyBpZCBpcyBhc3NpZ25lZCwgc28gaXQgbmV2ZXIgYWR2YW5jZXMgYSB0YWlsIGN1cnNvci5cbiAgLy9cbiAgLy8g4puUIFRISVMgSVMgVEhFIE9ORSBUSElORyBUSEUgU0hBUkVEIFNTRSBNT0RVTEUgQ09VTEQgTk9UIERPLCBBTkQgSVQgV0FTXG4gIC8vIFdJREVORUQgUkFUSEVSIFRIQU4gV09SS0VEIEFST1VORC4gYFNzZUNsaWVudHNgIGhlbGQgYmFyZSBjbG9zZXJzLCBiZWNhdXNlXG4gIC8vIGFzdHJvbGFiZSBhbmQgbWFncGllIGFubm91bmNlIHByZXNlbmNlIG92ZXIgdGhlaXIgYnJvd3NlciBXRUJTT0NLRVQgYW5kIG5ldmVyXG4gIC8vIG5lZWRlZCB0byBwdXNoIGFuIHVubG9nZ2VkIGZyYW1lIGF0IHRoZSBhZ2VudCdzIHRhaWwuIEtlZXBpbmcgYSBzZWNvbmQsXG4gIC8vIHBhcmFsbGVsIGBTZXQ8UmVhZGFibGVTdHJlYW1EZWZhdWx0Q29udHJvbGxlcj5gIGhlcmUgd291bGQgaGF2ZSByZS1jcmVhdGVkXG4gIC8vIGV4YWN0bHkgdGhlIGRyaWZ0IHRoZSByZWdpc3RyeSBleGlzdHMgdG8gcmVtb3ZlIOKAlCBhbmQgaXQgaXMgdGhlIGRyaWZ0IHRoYXRcbiAgLy8gbW9kdWxlJ3Mgb3duIGhlYWRlciB3YXJucyBhYm91dCwgd2hlcmUgYSBwZXItc3RyZWFtIHRpbWVyIHdhcyBzd2VwdCBmcm9tIGFcbiAgLy8gc2Vjb25kIHNldCBhbmQgY291bGQgZmFsbCBvdXQgb2Ygc3RlcC4gU28gdGhlIHJlZ2lzdHJ5IGVudHJ5IGdhaW5lZCBgc2VuZGAsXG4gIC8vIHdoaWNoIHJvdXRlcyB0aHJvdWdoIHRoZSBzYW1lIGNsb3NlZC1jaGVjayBhbmQgdGVhcmRvd24gZnVubmVsIGFzIGV2ZXJ5IG90aGVyXG4gIC8vIHdyaXRlLiBSZXBvcnRlZCBhcyBhIGZpbmRpbmcgYWJvdXQgdGhlIG1vZHVsZSwgcGVyIHRoZSBwaGFzZSBicmllZi5cbiAgY29uc3QgZW1pdFRyYW5zaWVudCA9IChtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgY29uc3QgZnJhbWUgPSBgZGF0YTogJHtKU09OLnN0cmluZ2lmeShtc2cpfVxcblxcbmA7XG4gICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIGMuc2VuZChmcmFtZSk7XG4gIH07XG5cbiAgLy8gLS0tIHNlc3Npb24gZmlsZXMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzZXNzaW9uSWQgPSBgZ2xhbW91ci0ke3JhbmRIZXgoNCl9YDtcbiAgY29uc3Qgc2Vzc2lvbkZpbGVzRGlyID0gam9pbih0bXBkaXIoKSwgYCR7c2Vzc2lvbklkfS1maWxlc2ApO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhzZXNzaW9uRmlsZXNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIGJhY2sgdG8gbm8gcGF0aHMgKi9cbiAgfVxuICBpZiAocmVzdG9yZWQpIHtcbiAgICBmb3IgKGNvbnN0IGl0IG9mIHN0YXRlLmxpYnJhcnkpIG1hdGVyaWFsaXplSXRlbShzZXNzaW9uRmlsZXNEaXIsIGl0KTtcbiAgfVxuXG4gIC8vIC0tLSBhZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBsZXQgcmVzb2x2ZURvbmUhOiAodjogeyBjb2RlOiBudW1iZXI7IHJlYXNvbjogc3RyaW5nIH0pID0+IHZvaWQ7XG4gIGNvbnN0IGRvbmUgPSBuZXcgUHJvbWlzZTx7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmcgfT4oKHIpID0+IHtcbiAgICByZXNvbHZlRG9uZSA9IHI7XG4gIH0pO1xuXG4gIC8vICM4NCDigJQgUkVUVVJOUyBBIFZFUkRJQ1QuIFByZXZpb3VzbHkgdm9pZCwgc28gdGhlIC9jbWQgcm91dGUgaGFkIG5vdGhpbmcgdG9cbiAgLy8gcmVwb3J0IGFuZCBhbnN3ZXJlZCBhIGxpdGVyYWwge29rOnRydWV9IHRvIGV2ZXJ5IGNvbW1hbmQgaW5jbHVkaW5nIG9uZXMgaXRcbiAgLy8gZHJvcHBlZC4gTm90ZSB0aGUgZGVmZWN0IGlzIE5PVCBhIG1pc3NpbmcgYGF3YWl0YDogdGhpcyBoYW5kbGVyIGlzXG4gIC8vIHN5bmNocm9ub3VzLCBhbmQgaW1hZ28ncyB0d2luIElTIGNvcnJlY3RseSBhd2FpdGVkIGFuZCB3YXMgYnJva2VuIGFueXdheS5cbiAgLy8gVGhlIGZpeCBpcyB0aGF0IGEgZGVjaXNpb24gZXhpc3RzIGF0IGFsbC5cbiAgLy8gQ29udHJhY3QgMTM6IHRoZSB2ZXJkaWN0IG9yaWdpbmF0ZXMgaW4gdGhlIGNvZGUgb3duaW5nIHRoZSByZWNvZ25pc2VkIHNldC5cbiAgLy8gYjEyIHdpZGVucyB0aGUgUkVUVVJOIHdpdGhvdXQgd2lkZW5pbmcgdGhlIENPTlRSQUNUIOKAlCBhIGNvbW1hbmQgbWF5IGFuc3dlclxuICAvLyB3aXRoIGEgcmVzdWx0IG9iamVjdCBjYXJyeWluZyBpdHMgb3duIHBheWxvYWQgaW5zdGVhZCBvZiB0aGUgYm9vbGVhbi4gRXZlcnlcbiAgLy8gb3RoZXIgY29tbWFuZCBzdGlsbCByZXR1cm5zIGEgYmFyZSBib29sZWFuIGFuZCBpdHMgcmVzcG9uc2UgaXNcbiAgLy8gYnl0ZS1pZGVudGljYWwuIFNhbWUgc2hhcGUgYXMgaW1hZ28ncyBjb250ZXh0LmFkZCAoNWU2YWFjZCkuXG4gIHR5cGUgQWdlbnRWZXJkaWN0ID0gYm9vbGVhbiB8IHsgcmVjb2duaXNlZDogdHJ1ZTsgb2s6IHRydWU7IGRldGFpbDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfTtcbiAgY29uc3QgaGFuZGxlQWdlbnRNc2cgPSAobXNnOiBBZ2VudENvbW1hbmQpOiBBZ2VudFZlcmRpY3QgPT4ge1xuICAgIGlmIChtc2cudHlwZSA9PT0gXCJzYXlcIikge1xuICAgICAgYWRkTWVzc2FnZShzdGF0ZSwge1xuICAgICAgICBpZDogYG0tJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgIHdobzogXCJhZ2VudFwiLFxuICAgICAgICBraW5kOiBtc2cua2luZCA/PyBcImluZm9cIixcbiAgICAgICAgdGV4dDogbXNnLnRleHQsXG4gICAgICAgIGdyb3VuZDogW10sXG4gICAgICAgIHRzOiBEYXRlLm5vdygpLFxuICAgICAgfSk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChtc2cudHlwZSA9PT0gXCJjbG9zZVwiKSB7XG4gICAgICByZXNvbHZlRG9uZSh7IGNvZGU6IDAsIHJlYXNvbjogXCJjbG9zZVwiIH0pO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChtc2cudHlwZSA9PT0gXCJnZW4uYWRkXCIpIHtcbiAgICAgIGNvbnN0IGl0ID0gbWFrZUl0ZW0oe1xuICAgICAgICBpZDogYGdlbi0ke3JhbmRIZXgoNCl9YCxcbiAgICAgICAga2luZDogXCJnZW5cIixcbiAgICAgICAgdGl0bGU6IG1zZy5sYWJlbCA/PyBgcm91bmQgJHttc2cucm91bmR9YCxcbiAgICAgICAgc3JjOiBtc2cuc3JjLFxuICAgICAgICBtaW1lOiBcImltYWdlL3dlYnBcIixcbiAgICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgICBnZW46IHtcbiAgICAgICAgICBtb2RlbDogbXNnLm1vZGVsLFxuICAgICAgICAgIHByb21wdDogbXNnLnByb21wdCxcbiAgICAgICAgICBzZWVkOiBtc2cuc2VlZCA/PyBudWxsLFxuICAgICAgICAgIGNvc3Q6IG1zZy5jb3N0ID8/IG51bGwsXG4gICAgICAgICAgY3VzdG9tOiBtc2cuY3VzdG9tID8/IHt9LFxuICAgICAgICAgIHJvdW5kOiBtc2cucm91bmQsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIG1hdGVyaWFsaXplSXRlbShzZXNzaW9uRmlsZXNEaXIsIGl0KTtcbiAgICAgIC8vIGIxMiArICM4NyAodGhpcmQgc3BlbGwpIOKAlCBgaWYgKGFkZEl0ZW0oc3RhdGUsIGl0KSkgYnJvYWRjYXN0U3RhdGUoKWBcbiAgICAgIC8vIGRyb3BwZWQgdGhlIG11dGF0b3IncyBvdXRjb21lIGludG8gY29udHJvbCBmbG93IGFuZCBhbnN3ZXJlZCBvazp0cnVlXG4gICAgICAvLyBlaXRoZXIgd2F5LiBUd28gdGhpbmdzIHdlcmUgd3JvbmcgYW5kIG9ubHkgb25lIGlzIHdoYXQgdGhlIGNhcmQgc2FpZDpcbiAgICAgIC8vXG4gICAgICAvLyAgIFJFQUNIQUJMRSwgZXZlcnkgY2FsbDogdGhlIG1pbnRlZCBpZCB3YXMgRElTQ0FSREVELCBzbyB0aGUgYWdlbnQgdGhhdFxuICAgICAgLy8gICBqdXN0IGNyZWF0ZWQgYW4gaXRlbSBjb3VsZCBub3QgcmVmZXJlbmNlIGl0LiBUaGF0IGlzICM4NydzIGRlZmVjdCBpbiBhXG4gICAgICAvLyAgIHRoaXJkIGNvZGViYXNlIChpbWFnbyBjb250ZXh0LmFkZCwgYW5kIHRoaXMpLlxuICAgICAgLy9cbiAgICAgIC8vICAgTk9UIFJFQUNIQUJMRSBpbiBwcmFjdGljZTogdGhlIFwic2lsZW50IGRlZHVwZVwiLiBgaWRgIGlzIG1pbnRlZCBIRVJFXG4gICAgICAvLyAgIChgZ2VuLSR7cmFuZEhleCg0KX1gKSBhbmQgdGhlIGNhbGxlciBjYW5ub3Qgc3VwcGx5IG9uZSDigJQgYGJ1aWxkR2VuQ21kYFxuICAgICAgLy8gICBoYXMgbm8gaWQgZmllbGQsIGFuZCB0aGlzIGxpbmUgaWdub3JlcyBhbnkgdGhhdCBhcnJpdmVkIOKAlCBzbyBhZGRJdGVtXG4gICAgICAvLyAgIHJldHVybnMgZmFsc2Ugb25seSBvbiBhIDJeMzIgY29sbGlzaW9uLiBUaGUgYnJhbmNoIHdhcyBkZWFkLCBub3RcbiAgICAgIC8vICAgZGFuZ2Vyb3VzLiBJdCBpcyByZXBvcnRlZCBob25lc3RseSBub3cgcmF0aGVyIHRoYW4gcmVtb3ZlZCwgYmVjYXVzZSBhXG4gICAgICAvLyAgIGNvbGxpc2lvbiB0aGF0IERJRCBoYXBwZW4gd291bGQgb3RoZXJ3aXNlIGJlIHRoZSBzaWxlbnQgY2FzZS5cbiAgICAgIGNvbnN0IGFkZGVkID0gYWRkSXRlbShzdGF0ZSwgaXQpO1xuICAgICAgaWYgKGFkZGVkKSBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcmVjb2duaXNlZDogdHJ1ZSxcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIGRldGFpbDogeyBpZDogaXQuaWQsIG91dGNvbWU6IGFkZGVkID8gXCJjcmVhdGVkXCIgOiBcImFscmVhZHktcmVjb3JkZWRcIiB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKG1zZy50eXBlID09PSBcInN0eWxlLnNhdmVcIikge1xuICAgICAgY29uc3QgY2Fub25pY2FsSXRlbXMgPSBzdGF0ZS5saWJyYXJ5LmZpbHRlcigoaSkgPT4gaS5jYW5vbmljYWwgJiYgIWkuYXJjaGl2ZWQpO1xuICAgICAgY29uc3QgYWdyZWVkID0gc3RhdGUuc3R5bGVHdWlkZS5maWx0ZXIoKHMpID0+IHMuc3RhdHVzICE9PSBcImVtcHR5XCIgJiYgcy5jb250ZW50KTtcbiAgICAgIGNvbnN0IHRleHQgPSBhZ3JlZWRcbiAgICAgICAgLm1hcCgocykgPT4gcy5jb250ZW50KVxuICAgICAgICAuam9pbihcIiDCtyBcIilcbiAgICAgICAgLnNsaWNlKDAsIDI4MCk7XG4gICAgICBjb25zdCBzdHlsZSA9IHNhdmVTdHlsZShHTEFNT1VSX0hPTUUsIFBST0pFQ1RfS0VZLCB7XG4gICAgICAgIGlkOiBgc3R5bGUtJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgIGxhYmVsOiBtc2cubGFiZWwsXG4gICAgICAgIHRleHQsXG4gICAgICAgIHNlY3Rpb25zOiBzdGF0ZS5zdHlsZUd1aWRlLFxuICAgICAgICBjYW5vbmljYWxJdGVtcyxcbiAgICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgfSk7XG4gICAgICBzdGF0ZS50cmF5LnB1c2goc3R5bGUpO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAobXNnLnR5cGUgPT09IFwic3R5bGUuYXJjaGl2ZVwiKSB7XG4gICAgICBzZXRTdHlsZUFyY2hpdmVkKEdMQU1PVVJfSE9NRSwgUFJPSkVDVF9LRVksIG1zZy5pZCwgbXNnLmFyY2hpdmVkKTtcbiAgICAgIGFwcGx5QWdlbnRNc2coc3RhdGUsIG1zZyk7IC8vIGZsaXBzIHRoZSBpbi1tZW1vcnkgdHJheSBlbnRyeVxuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICAvLyBUaGUgZmFsbHRocm91Z2ggaXMgdGhlIG9ubHkgcGF0aCB0aGF0IGNhbiBiZSBVTlJFQ09HTklTRUQsIGFuZCB0aGVcbiAgICAvLyByZWR1Y2VyIGlzIHdoYXQga25vd3M6IGl0IG93bnMgdGhlIGNhc2UgbGlzdCwgc28gdGhlIHZlcmRpY3QgY29tZXMgZnJvbVxuICAgIC8vIHRoZXJlIHJhdGhlciB0aGFuIGZyb20gYSBzZWNvbmQgZW51bWVyYXRpb24gaGVyZS5cbiAgICBjb25zdCByZWNvZ25pc2VkID0gYXBwbHlBZ2VudE1zZyhzdGF0ZSwgbXNnKTtcbiAgICBpZiAocmVjb2duaXNlZCkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4gcmVjb2duaXNlZDtcbiAgfTtcblxuICAvLyAtLS0gYnJvd3NlciBtZXNzYWdlcyAoV2ViU29ja2V0KSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgaGFuZGxlQ2xpZW50TXNnID0gKG1zZzogQ2xpZW50VG9TZXJ2ZXIpID0+IHtcbiAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XG4gICAgICBjYXNlIFwiaXRlbS5hZGRcIjoge1xuICAgICAgICBjb25zdCBpdCA9IG1ha2VJdGVtKHtcbiAgICAgICAgICBpZDogYCR7bXNnLml0ZW0ua2luZH0tJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgICAga2luZDogbXNnLml0ZW0ua2luZCxcbiAgICAgICAgICB0aXRsZTogbXNnLml0ZW0udGl0bGUsXG4gICAgICAgICAgc3JjOiBtc2cuaXRlbS5zcmMsXG4gICAgICAgICAgdGV4dDogbXNnLml0ZW0udGV4dCxcbiAgICAgICAgICBtaW1lOiBtc2cuaXRlbS5taW1lID8/IFwiXCIsXG4gICAgICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgICB9KTtcbiAgICAgICAgbWF0ZXJpYWxpemVJdGVtKHNlc3Npb25GaWxlc0RpciwgaXQpO1xuICAgICAgICBpZiAoYWRkSXRlbShzdGF0ZSwgaXQpKSB7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgICBlbWl0RXZlbnQoe1xuICAgICAgICAgICAgdHlwZTogXCJpdGVtLmFkZFwiLFxuICAgICAgICAgICAgaXRlbTogbGVhbkl0ZW0oaXQpLFxuICAgICAgICAgICAgc2VsZWN0ZWRJZHM6IHN0YXRlLnNlbGVjdGVkSWRzLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcIml0ZW0uc2VsZWN0XCI6XG4gICAgICAgIHNlbGVjdEl0ZW1zKHN0YXRlLCBtc2cuaWRzKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5zdGFyXCI6XG4gICAgICAgIGlmIChzZXRTdGFyKHN0YXRlLCBtc2cuaWQsIG1zZy5zdGFycmVkKSkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5saWtlXCI6XG4gICAgICAgIGlmIChzZXRMaWtlKHN0YXRlLCBtc2cuaWQsIG1zZy5saWtlZCkpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIml0ZW0uYW5ub3RhdGVcIjpcbiAgICAgICAgLy8gQW1iaWVudDogdGhlIGh1bWFuJ3MgcGVyLWl0ZW0gbm90ZSBpcyBzdG9yZWQgKyBVSS1zeW5jZWQgKyBwZXJzaXN0ZWQsXG4gICAgICAgIC8vIGFuZCB0aGUgYWdlbnQgcmVhZHMgaXQgb24gZGVtYW5kIGZyb20gc3RhdGUgd2hlbiBpdCBsb29rcyBhdCB0aGUgaW1hZ2UuXG4gICAgICAgIC8vIEl0IGlzIE5PVCBwdXNoZWQgYXMgYW4gYWdlbnQgZXZlbnQg4oCUIGEgc3RpY2t5IG5vdGUsIG5vdCBhIHJlYWwtdGltZVxuICAgICAgICAvLyBzaWduYWwgKHNlZSB0aGUgZXZlbnQtdm9sdW1lIGxlc3NvbjsgYXZvaWRzIGludGVycnVwdGluZyB0aGUgYWdlbnQgb25cbiAgICAgICAgLy8gZXZlcnkgYmx1cikuXG4gICAgICAgIGlmIChhbm5vdGF0ZShzdGF0ZSwgbXNnLmlkLCBcImh1bWFuXCIsIG1zZy5odW1hbikpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIm1lc3NhZ2Uuc2VuZFwiOiB7XG4gICAgICAgIGNvbnN0IGdyb3VuZCA9IFsuLi5zdGF0ZS5zZWxlY3RlZElkc107XG4gICAgICAgIGFkZE1lc3NhZ2Uoc3RhdGUsIHtcbiAgICAgICAgICBpZDogYG0tJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgICAgd2hvOiBcInVzZXJcIixcbiAgICAgICAgICBraW5kOiBcImluZm9cIixcbiAgICAgICAgICB0ZXh0OiBtc2cudGV4dCxcbiAgICAgICAgICBncm91bmQsXG4gICAgICAgICAgdHM6IERhdGUubm93KCksXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcIm1lc3NhZ2UudXNlclwiLCB0ZXh0OiBtc2cudGV4dCwgZ3JvdW5kIH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmb2N1cy5zZXRcIjpcbiAgICAgICAgc2V0Rm9jdXMoc3RhdGUsIG1zZy5pZHMsIFwieW91XCIpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJmb2N1cy5jbGVhclwiOlxuICAgICAgICBjbGVhckZvY3VzKHN0YXRlKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5jYW5vbmljYWxcIjpcbiAgICAgICAgaWYgKHNldENhbm9uaWNhbChzdGF0ZSwgbXNnLmlkLCBtc2cuY2Fub25pY2FsKSkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5hcmNoaXZlXCI6XG4gICAgICAgIGlmIChzZXRJdGVtQXJjaGl2ZWQoc3RhdGUsIG1zZy5pZCwgbXNnLmFyY2hpdmVkKSkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwic3R5bGUuYnJpbmdJblwiOiB7XG4gICAgICAgIGNvbnN0IHN0eWxlID0gc3RhdGUudHJheS5maW5kKChzKSA9PiBzLmlkID09PSBtc2cuaWQpO1xuICAgICAgICBpZiAoIXN0eWxlKSBicmVhaztcbiAgICAgICAgY29uc3QgaXRlbUlkID0gYHN0eWxlLSR7c3R5bGUuaWR9YDtcbiAgICAgICAgaWYgKHN0YXRlLmxpYnJhcnkuc29tZSgoaSkgPT4gaS5pZCA9PT0gaXRlbUlkKSkgYnJlYWs7IC8vIGlkZW1wb3RlbnRcbiAgICAgICAgY29uc3QgY2Fub24gPSBtYXRlcmlhbGl6ZUNhbm9uKEdMQU1PVVJfSE9NRSwgUFJPSkVDVF9LRVksIHN0eWxlKTtcbiAgICAgICAgY29uc3QgaXQgPSBidWlsZFN0eWxlSXRlbShzdHlsZSwgY2Fub24sIERhdGUubm93KCkpO1xuICAgICAgICBpZiAoYWRkSXRlbShzdGF0ZSwgaXQpKSB7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcIml0ZW0uYWRkXCIsIGl0ZW06IGxlYW5JdGVtKGl0KSwgc2VsZWN0ZWRJZHM6IHN0YXRlLnNlbGVjdGVkSWRzIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICAvLyBHRVQgL2V2ZW50cz9zaW5jZT08aWQ+IOKAlCByZXBsYXksIHRoZW4gc3RheSBvcGVuIGZvciBsaXZlIGZyYW1lcyBwbHVzIGFcbiAgLy8gaGVhcnRiZWF0IGNvbW1lbnQuIE9uZSBjYWxsIGludG8gYGtpdC93aXJlL3NzZS50c2AsIHdoaWNoIGlzIHdoZXJlIHRoZVxuICAvLyB0ZWFyZG93biBmdW5uZWwgbGl2ZXM6IGBjYW5jZWwoKWAsIGByZXEuc2lnbmFsYCBhbmQgYSBmYWlsZWQgZW5xdWV1ZSBhbGxcbiAgLy8gcmVhY2ggaXQsIGF0IG1vc3Qgb25jZSwgYW5kIHRoYXQgZnVubmVsIGlzIHdoYXQgYm91bmRzIHRoZSBzdWJzY3JpYmVyIGNvdW50XG4gIC8vIHRoZSBpZGxlIHN3ZWVwIHJlYWRzLiBUaGUgb2xkIGNvcHkgaGVyZSByZWxpZWQgb24gYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgdG9cbiAgLy8gbm90aWNlIGEgZGVwYXJ0ZWQgY2xpZW50LCB3aGljaCB3YXMgTUVBU1VSRUQgb24gQnVuIDEuMy4xNCBub3QgdG8gd29yayDigJRcbiAgLy8gZW5xdWV1ZSBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gYnVmZmVycyBzaWxlbnRseSBhbmQgbmV2ZXIgdGhyb3dzIOKAlCBhbmQgaXQgd2FzXG4gIC8vIG5vdCB3aXJlZCB0byBgcmVxLnNpZ25hbGAgYXQgYWxsLCBzbyBhIGNsaWVudCB0aGF0IHZhbmlzaGVkIHdpdGhvdXRcbiAgLy8gY2FuY2VsbGluZyB3YXMgY291bnRlZCBhcyBwcmVzZW50IGZvciB0aGUgbGlmZSBvZiB0aGUgZGFlbW9uLlxuICAvL1xuICAvLyDimqAgQU5EIFRIRSBIRUFSVEJFQVQgSVMgTk8gTE9OR0VSIEEgTElURVJBTC4gSXQgd2FzIGAxNTAwMGAsIGhhcmQtY29kZWQgaGVyZSxcbiAgLy8gYmVzaWRlIGEgYEJ1bi5zZXJ2ZWAgYGlkbGVUaW1lb3V0OiAyNTVgIGFuZCBhIGNvbW1lbnQgZXhwbGFpbmluZyB0aGF0IHRoZSB0d29cbiAgLy8gYXJlIGNoYWluZWQuIFRoZXkgbm93IGNvbWUgZnJvbSBgLi9oZWFydGJlYXQudHNgLCB3aGljaCBkZXJpdmVzIHRoZSBwYWlyIOKAlCBzb1xuICAvLyB0aGUgaW52YXJpYW50IGhvbGRzIGZvciBhbnkgdmFsdWUsIG5vdCBvbmx5IGZvciB0aGUgdHdvIHRoYXQgaGFwcGVuZWQgdG8gYmVcbiAgLy8gd3JpdHRlbi5cbiAgY29uc3QgZXZlbnRzUmVzcG9uc2UgPSAocmVxOiBSZXF1ZXN0LCB1cmw6IFVSTCk6IFJlc3BvbnNlID0+IHtcbiAgICB0b3VjaCgpO1xuICAgIHJldHVybiBzc2VSZXNwb25zZSh7XG4gICAgICBsb2csXG4gICAgICBzaW5jZTogTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic2luY2VcIikgPz8gXCItMVwiLCAxMCksXG4gICAgICBoZWFydGJlYXRNczogU1NFX0hFQVJUQkVBVF9NUyxcbiAgICAgIGNsaWVudHM6IHNzZUNsaWVudHMsXG4gICAgICBzaWduYWw6IHJlcS5zaWduYWwsXG4gICAgICBvbk9wZW46IHRvdWNoLFxuICAgICAgb25DbG9zZTogdG91Y2gsXG4gICAgfSk7XG4gIH07XG5cbiAgLy8gLS0tIHNlcnZlIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzZXJ2ZXIgPSBCdW4uc2VydmUoe1xuICAgIHBvcnQ6IG9wdHMucG9ydCA/PyAwLFxuICAgIGhvc3RuYW1lOiBvcHRzLmhvc3QgPz8gXCIxMjcuMC4wLjFcIixcbiAgICByb3V0ZXMsXG4gICAgLy8g4puUIEhFTEQgU1NFIENPTk5FQ1RJT05TIERJRSBXSVRIT1VUIFRISVMuIEJ1bidzIGRlZmF1bHQgcmVxdWVzdFxuICAgIC8vIGlkbGVUaW1lb3V0IGlzIDEwcyBhbmQgYSBzZXJ2ZXItc2VudCBoZWFydGJlYXQgZG9lcyBOT1QgcmVzZXQgaXQsIHNvIGFuXG4gICAgLy8gU1NFIGNsaWVudCBpcyBjbG9zZWQgYmVmb3JlIHRoZSAxNXMgYDogaGJgIGJlbG93IGV2ZXIgZmlyZXMg4oCUIHRoZVxuICAgIC8vIGtlZXBhbGl2ZSBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzIGtlZXBpbmcgYWxpdmUgaXNcbiAgICAvLyBnb25lLCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IHJhdGUgd291bGQgbm90IGhhdmUgaGVscGVkLlxuICAgIC8vIDI1NSBpcyBCdW4ncyBtYXhpbXVtICgwIGlzIG5vdCBcImRpc2FibGVkXCIpLCBtYXRjaGluZyBib3VudHksIGdyYXBldmluZVxuICAgIC8vIGFuZCBtaW5kLW1hcHBlcjsgYXN0cm9sYWJlIGVudi10dW5lcyBpdCBhbmQgY2xhbXBzIHRoZSBoZWFydGJlYXQgdG8gaGFsZi5cbiAgICAvLyBGb3VuZCAyMDI2LTA5LTA4IGJ5IHRoZSBiYWNrZW5kIGR1cGxpY2F0aW9uIHJlY29uOiBmb3VyIHNwZWxscyBoYWQgaGl0XG4gICAgLy8gdGhpcyBhbmQgZml4ZWQgaXQsIHRocmVlIGhhZCBub3QsIGJlY2F1c2UgdGhlIGRhZW1vbiBzcGluZSBpcyBvbmUgZGVzaWduXG4gICAgLy8gaW1wbGVtZW50ZWQgc2l4IHRpbWVzLlxuICAgIGlkbGVUaW1lb3V0OiBJRExFX1RJTUVPVVRfU0VDLFxuICAgIGRldmVsb3BtZW50OiB7IGhtcjogbW9kZSA9PT0gXCJkZXZcIiB9LFxuICAgIGZldGNoKHJlcSwgc3J2KSB7XG4gICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwpO1xuICAgICAgY29uc3QgcGF0aCA9IHVybC5wYXRobmFtZTtcbiAgICAgIGlmIChwYXRoID09PSBcIi93c1wiKVxuICAgICAgICByZXR1cm4gc3J2LnVwZ3JhZGUocmVxKSA/IHVuZGVmaW5lZCA6IG5ldyBSZXNwb25zZShcInVwZ3JhZGUgcmVxdWlyZWRcIiwgeyBzdGF0dXM6IDQyNiB9KTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL3N0YXRlXCIpIHtcbiAgICAgICAgdG91Y2goKTtcbiAgICAgICAgY29uc3QgbGVhbiA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwibGVhblwiKSA9PT0gXCIxXCI7XG4gICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHtcbiAgICAgICAgICBzdGF0ZTogbGVhbiA/IGxlYW5TdGF0ZShzdGF0ZSkgOiBzdGF0ZSxcbiAgICAgICAgICBjdXJzb3I6IGxvZy5jdXJzb3IoKSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9ldmVudHNcIikgcmV0dXJuIGV2ZW50c1Jlc3BvbnNlKHJlcSwgdXJsKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9jbWRcIilcbiAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAudGhlbigoYikgPT4ge1xuICAgICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICAgIC8vICM4NCDigJQgcHJvcGFnYXRlIHRoZSBoYW5kbGVyJ3MgdmVyZGljdCBpbnN0ZWFkIG9mIGEgbGl0ZXJhbFxuICAgICAgICAgICAgLy8ge29rOnRydWV9LiBgYXBwbGllZGAgaXMgdGhlIGZpZWxkIGJvdW50eSBhbHJlYWR5IHVzZXNcbiAgICAgICAgICAgIC8vIChzZXJ2ZXIudHMgQXBwbHlSZXN1bHQpOyBubyBuZXcgdm9jYWJ1bGFyeSBpcyBtaW50ZWQgaGVyZS5cbiAgICAgICAgICAgIGNvbnN0IHZlcmRpY3QgPSBoYW5kbGVBZ2VudE1zZyhiIGFzIEFnZW50Q29tbWFuZCk7XG4gICAgICAgICAgICAvLyBBIGNvbW1hbmQgdGhhdCBhbnN3ZXJlZCB3aXRoIGl0cyBvd24gcmVzdWx0IGNhcnJpZXMgaXRzIHBheWxvYWQ7XG4gICAgICAgICAgICAvLyB0aGUgYm9vbGVhbiBwYXRoIGJlbG93IGlzIHVuY2hhbmdlZC5cbiAgICAgICAgICAgIGlmICh0eXBlb2YgdmVyZGljdCA9PT0gXCJvYmplY3RcIilcbiAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgYXBwbGllZDogdHJ1ZSwgLi4udmVyZGljdC5kZXRhaWwgfSk7XG4gICAgICAgICAgICBjb25zdCBhcHBsaWVkID0gdmVyZGljdDtcbiAgICAgICAgICAgIGlmICghYXBwbGllZCkge1xuICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbihcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgICBhcHBsaWVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgIGVycm9yOiBgdW5yZWNvZ25pc2VkIGNvbW1hbmQgdHlwZSAke0pTT04uc3RyaW5naWZ5KFxuICAgICAgICAgICAgICAgICAgICAoYiBhcyB7IHR5cGU/OiB1bmtub3duIH0pPy50eXBlLFxuICAgICAgICAgICAgICAgICAgKX0g4oCUIG5vdGhpbmcgd2FzIGFwcGxpZWRgLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgeyBzdGF0dXM6IDQwMCB9LFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgYXBwbGllZDogdHJ1ZSB9KTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoKSA9PiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwiYmFkIGpzb25cIiB9LCB7IHN0YXR1czogNDAwIH0pKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGguc3RhcnRzV2l0aChcIi9hc3NldHMvXCIpKSB7XG4gICAgICAgIGNvbnN0IG5hbWUgPSBkZWNvZGVVUklDb21wb25lbnQocGF0aC5zbGljZShcIi9hc3NldHMvXCIubGVuZ3RoKSk7XG4gICAgICAgIGlmIChuYW1lLmluY2x1ZGVzKFwiLi5cIikgfHwgbmFtZS5zdGFydHNXaXRoKFwiL1wiKSlcbiAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IGVycm9yOiBcIm5vdCBmb3VuZFwiIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgICAgIGNvbnN0IGYgPSBCdW4uZmlsZShqb2luKHNlc3Npb25GaWxlc0RpciwgbmFtZSkpO1xuICAgICAgICByZXR1cm4gZlxuICAgICAgICAgIC5leGlzdHMoKVxuICAgICAgICAgIC50aGVuKChvaykgPT5cbiAgICAgICAgICAgIG9rID8gbmV3IFJlc3BvbnNlKGYpIDogUmVzcG9uc2UuanNvbih7IGVycm9yOiBcIm5vdCBmb3VuZFwiIH0sIHsgc3RhdHVzOiA0MDQgfSksXG4gICAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIC8vIHJlbGVhc2U6IFwiL1wiIGFuZCB0aGUgaGFzaGVkIGNodW5rLSouanMvY3NzIGFyZSBzdGF0aWMgZGlzdCByZWFkcy4gRGV2XG4gICAgICAvLyBuZXZlciByZWFjaGVzIGhlcmUgZm9yIFwiL1wiIOKAlCB0aGUgcm91dGVzIHRhYmxlIGFib3ZlIGFuc3dlcnMgaXQgZmlyc3QuXG4gICAgICAvLyBUaGlzIHNpdHMgQUZURVIgL2Fzc2V0cy8sIHdoaWNoIHNlcnZlcyBzZXNzaW9uIGZpbGVzLCBub3QgZGlzdCBvbmVzLlxuICAgICAgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgIGNvbnN0IGFzc2V0ID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICBpZiAoYXNzZXQpIHJldHVybiBhc3NldDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwibm90IGZvdW5kXCIgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICB9LFxuICAgIHdlYnNvY2tldDoge1xuICAgICAgb3Blbih3cykge1xuICAgICAgICBzb2NrZXRzLmFkZCh3cyk7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGVtaXRUcmFuc2llbnQoeyB0eXBlOiBcImNvbm5lY3RlZFwiIH0pO1xuICAgICAgICB3cy5zZW5kKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJzdGF0ZVwiLCBzdGF0ZSB9KSk7XG4gICAgICB9LFxuICAgICAgbWVzc2FnZShfd3MsIHJhdykge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGhhbmRsZUNsaWVudE1zZyhcbiAgICAgICAgICAgIEpTT04ucGFyc2UoXG4gICAgICAgICAgICAgIHR5cGVvZiByYXcgPT09IFwic3RyaW5nXCIgPyByYXcgOiBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUocmF3KSxcbiAgICAgICAgICAgICkgYXMgQ2xpZW50VG9TZXJ2ZXIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBnbGFtb3VyOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIGNsb3NlKHdzKSB7XG4gICAgICAgIHNvY2tldHMuZGVsZXRlKHdzKTtcbiAgICAgICAgZW1pdFRyYW5zaWVudCh7IHR5cGU6IFwiZGlzY29ubmVjdGVkXCIgfSk7XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGJvdW5kUG9ydCA9IHNlcnZlci5wb3J0O1xuICAvLyAtLS0gZGlzY292ZXJ5IGZpbGVzIChjbGkudHMgcmVhZHMgdGhlc2UpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc2Vzc2lvbkZpbGUgPSBqb2luKHRtcGRpcigpLCBgZ2xhbW91ci0ke3Nlc3Npb25JZH0uanNvbmApO1xuICBjb25zdCBsYXRlc3RGaWxlID0gam9pbih0bXBkaXIoKSwgYGdsYW1vdXItbGF0ZXN0Lmpzb25gKTtcbiAgY29uc3QgaW5mbyA9IEpTT04uc3RyaW5naWZ5KHtcbiAgICB1cmw6IGBodHRwOi8vJHtvcHRzLmhvc3QgPz8gXCIxMjcuMC4wLjFcIn06JHtib3VuZFBvcnR9YCxcbiAgICBwb3J0OiBib3VuZFBvcnQsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIHRpdGxlOiBzdGF0ZS50aXRsZSxcbiAgICBmaWxlc19kaXI6IHNlc3Npb25GaWxlc0RpcixcbiAgICBtb2RlLFxuICB9KTtcbiAgLy8g4pqgIEFUT01JQywgYmVjYXVzZSBjbGkudHMncyByZWFkU2Vzc2lvbiB0cmVhdHMgdW5wYXJzZWFibGUgY29udGVudCBhc1xuICAvLyBjb3JydXB0aW9uIHJhdGhlciB0aGFuIGFic2VuY2Ug4oCUIGFuZCB0aGlzIGltcGxlbWVudGF0aW9uIGlzIG5vd1xuICAvLyBga2l0L3dpcmUvZGlzY292ZXJ5LnRzYCwgc2hhcmVkIHdpdGggdGhlIHNpbmdsZXRvbiBjb252ZW50aW9uIEQzIGtlcHQgYWxpdmVcbiAgLy8gYmVzaWRlIHRoaXMgb25lLiBnbGFtb3VyIGlzIHdoZXJlIHRoZSBkZWZlY3QgKEwzKSB3YXMgZm91bmQgYW5kIGZpeGVkIG9uXG4gIC8vIDIwMjYtMDktMDc7IHdoYXQgc3RheWVkIGhlcmUgaXMgV0hJQ0ggZmlsZXMgZ2xhbW91ciB3cml0ZXMuXG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlQXRvbWljKHNlc3Npb25GaWxlLCBpbmZvKTtcbiAgICB3cml0ZUZpbGVBdG9taWMobGF0ZXN0RmlsZSwgaW5mbyk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGRpc2NvdmVyeSBpcyBiZXN0LWVmZm9ydCAqL1xuICB9XG5cbiAgLy8gQ29udHJhY3QgMTogdGhlIGRhZW1vbiBFTUlUUyBpdHMgcmVzb2x2ZWQgbW9kZSDigJQgYSBkZXYgZGFlbW9uIHdpdGggcm9vdCBkZXBzXG4gIC8vIHByZXNlbnQgcmVuZGVycyBhbiBpZGVudGljYWwtbG9va2luZyBib2FyZCwgc28gYG1vZGVgIGlzIHRoZSBvbmx5IHRoaW5nIHRoYXRcbiAgLy8gdGVsbHMgYSB2ZXJpZmllciB3aGljaCBwYXRoIHNlcnZlZCBpdC4gZ2xhbW91ciBoYXMgVEhSRUUgdHJhbnNwb3J0cyAoaW1hZ29cbiAgLy8gaGFzIHR3byk6IHRoaXMgZXZlbnQsIHRoZSBkaXNjb3ZlcnkgZmlsZSBhYm92ZSwgYW5kIHRoZSBzdGRvdXQgaGFuZHNoYWtlIGluXG4gIC8vIGltcG9ydC5tZXRhLm1haW4gYmVsb3cuIEFsbCB0aHJlZSBjYXJyeSBpdC5cbiAgZW1pdEV2ZW50KHsgdHlwZTogXCJyZWFkeVwiLCBtb2RlIH0pO1xuXG4gIC8vIC0tLSBzbmFwc2hvdCBkZWJvdW5jZSArIGlkbGUgc3dlZXAgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvL1xuICAvLyDim5QgVEhFIFNXRUVQIE5PVyBTRUVTIElUUyBTVUJTQ1JJQkVSUyDigJQgY2Vuc3VzIGRlZmVjdCBMMSwgY2xvc2VkIGJ5IHRoZSBzaGFyZWRcbiAgLy8gaG91c2VrZWVwZXIgUkVRVUlSSU5HIGEgYHN1YnNjcmliZXJDb3VudGAgcmF0aGVyIHRoYW4gYnkgYW55b25lIHJlbWVtYmVyaW5nLlxuICAvLyBUaGUgZXhwcmVzc2lvbiBoZXJlIHJlYWQgYChub3cgLSBsYXN0QWN0aXZpdHkpLzEwMDAgPj0gdGltZW91dGAgYW5kIG5vdGhpbmdcbiAgLy8gZWxzZSwgc28gYW4gYWdlbnQgaG9sZGluZyBhIGAvZXZlbnRzYCB0YWlsIG9uIGEgcXVpZXQgc2Vzc2lvbiB3YXMga2lsbGVkIFdJVEhcbiAgLy8gSVRTIENPTk5FQ1RJT04gT1BFTiBhdCB0aGUgMzAtbWludXRlIGZsb29yIOKAlCBnbGFtb3VyLCBpbWFnbyBhbmQgbWFncGllIGFsbFxuICAvLyBoYWQgaXQuIGB0aW1lb3V0YCBub3cgbWVhbnMgXCJsaW5nZXIgdGhpcyBsb25nIGFmdGVyIHRoZSBMQVNUIHN1YnNjcmliZXJcbiAgLy8gbGVhdmVzXCIsIG5vdCBcIm1heGltdW0gaWRsZSB3aGlsZSBjb25uZWN0ZWRcIi5cbiAgY29uc3Qgc2F2ZU5vdyA9ICgpID0+IHNhdmVTbmFwc2hvdChTTkFQU0hPVFNfRElSLCBzZXNzaW9uSWQsIHN0YXRlKTtcbiAgaWYgKHJlc3RvcmVkKSBzYXZlTm93KCk7XG4gIGNvbnN0IHRpbWVvdXRTID0gb3B0cy50aW1lb3V0UyA/PyAxODAwO1xuICBjb25zdCBzdG9wSG91c2VrZWVwaW5nID0gc3RhcnRIb3VzZWtlZXBpbmcoe1xuICAgIHN1YnNjcmliZXJDb3VudDogKCkgPT4gc29ja2V0cy5zaXplICsgc3NlQ2xpZW50cy5zaXplLFxuICAgIGlkbGVNczogKCkgPT4gcGVyZm9ybWFuY2Uubm93KCkgLSBsYXN0QWN0aXZpdHksXG4gICAgdG91Y2gsXG4gICAgdGltZW91dE1zOiB0aW1lb3V0UyAqIDEwMDAsXG4gICAgb25JZGxlQ2xvc2U6ICgpID0+IHJlc29sdmVEb25lKHsgY29kZTogMTI0LCByZWFzb246IFwidGltZW91dFwiIH0pLFxuICAgIHNuYXBzaG90OiB7XG4gICAgICBkaXJ0eTogKCkgPT4gc25hcERpcnR5LFxuICAgICAgY2xlYXI6ICgpID0+IHtcbiAgICAgICAgc25hcERpcnR5ID0gZmFsc2U7XG4gICAgICB9LFxuICAgICAgd3JpdGU6IHNhdmVOb3csXG4gICAgfSxcbiAgfSk7XG5cbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICAvLyBSZXNvbHZlcyBvbmNlIHRoZSBTU0UgZmx1c2ggKyBzZXJ2ZXIuc3RvcCBoYXZlIGJlZW4gc2NoZWR1bGVkOyBjYWxsZXJzXG4gIC8vIHRoYXQgbmVlZCB0byB3YWl0IChlLmcuIGltcG9ydC5tZXRhLm1haW4gYmVmb3JlIHByb2Nlc3MuZXhpdCkgY2FuIGF3YWl0IHRoaXMuXG4gIGxldCByZXNvbHZlU2h1dGRvd24hOiAoKSA9PiB2b2lkO1xuICBjb25zdCBzaHV0ZG93biA9IG5ldyBQcm9taXNlPHZvaWQ+KChyKSA9PiB7XG4gICAgcmVzb2x2ZVNodXRkb3duID0gcjtcbiAgfSk7XG5cbiAgLy8gVGhlIHNlc3Npb24gcG9pbnRlciBpcyB1bmNvbmRpdGlvbmFsbHkgb3VyczsgYGdsYW1vdXItbGF0ZXN0Lmpzb25gIGlzIE5PVCDigJRcbiAgLy8gYSBuZXdlciBzZXNzaW9uIG1heSBhbHJlYWR5IGhhdmUgY2xhaW1lZCBpdCwgYW5kIHVubGlua2luZyB0aGF0IHdvdWxkIG1ha2VcbiAgLy8gdGhlIGxpdmUgZGFlbW9uIGludmlzaWJsZSB0byB0aGUgbmV4dCB2ZXJiLiBgdW5saW5rSWZNYXRjaGVzYCdzIGBpZGVudGlmeWBcbiAgLy8gaG9vayBpcyB3aGF0IGxldHMgT05FIHNoYXJlZCBwcmVkaWNhdGUgc2VydmUgYm90aCB0aGlzIEpTT04gcG9pbnRlciBhbmRcbiAgLy8gYXN0cm9sYWJlJ3MgYmFyZSBwaWQgZmlsZSAoYGtpdC93aXJlL2Rpc2NvdmVyeS50c2ApLlxuICBjb25zdCBjbGVhbnVwRGlzY292ZXJ5ID0gKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICB1bmxpbmtTeW5jKHNlc3Npb25GaWxlKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGdvbmUg4oCUIGZpbmUgKi9cbiAgICB9XG4gICAgdW5saW5rSWZNYXRjaGVzKGxhdGVzdEZpbGUsIHNlc3Npb25JZCwgKHJhdykgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgaWQgPSAoSlNPTi5wYXJzZShyYXcpIGFzIHsgc2Vzc2lvbl9pZD86IHVua25vd24gfSkuc2Vzc2lvbl9pZDtcbiAgICAgICAgcmV0dXJuIHR5cGVvZiBpZCA9PT0gXCJzdHJpbmdcIiA/IGlkIDogbnVsbDtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICB9KTtcbiAgICB0cnkge1xuICAgICAgcm1TeW5jKHNlc3Npb25GaWxlc0RpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9O1xuXG4gIC8vIOKblCBTVEFZUyBTWU5DSFJPTk9VUyBBTkQgSURFTVBPVEVOVCwgYmVjYXVzZSBgZG9uZS50aGVuKCgpID0+IGNsb3NlKCkpYCBhbmRcbiAgLy8gdGhlIHN1aXRlcycgYGFmdGVyQWxsKCgpID0+IGQuY2xvc2UoKSlgIGJvdGggY2FsbCBpdCBhcyBhIHN0YXRlbWVudC4gVGhlXG4gIC8vIERSQUlOIGlzIHdoYXQgYmVjYW1lIGFzeW5jOiBgZHJhaW5BbmRTdG9wYCB3YWl0cyBpdHMgZ3JhY2UgcGVyaW9kLCBjbG9zZXNcbiAgLy8gZXZlcnkgcmVnaXN0ZXJlZCB0YWlsIHRocm91Z2ggdGhlIGZ1bm5lbCwgY2xvc2VzIHRoZSBzb2NrZXRzLCB0aGVuIFJBQ0VTXG4gIC8vIGBzZXJ2ZXIuc3RvcCh0cnVlKWAg4oCUIGJlY2F1c2UgdGhhdCBjYWxsIGF3YWl0cyBpdHMgY29ubmVjdGlvbnMgYW5kIG9uZSB3ZWRnZWRcbiAgLy8gcGVlciBpcyBlbm91Z2ggdG8gcGFyayB0ZWFyZG93biBmb3JldmVyIChhIDIzLW1pbnV0ZSBoYW5nIHNoaXBwZWQgb25jZSkuXG4gIC8vXG4gIC8vIOKaoCBUSEUgR1JBQ0UgUEVSSU9EIElTIDE1MCBtcywgTk9UIEdMQU1PVVInUyBPTEQgNTAsIGFuZCB0aGF0IGlzIGEgZGVsaWJlcmF0ZVxuICAvLyB3aXJlLW9ic2VydmFibGUgY2hhbmdlIHJhdGhlciB0aGFuIGFuIG92ZXJzaWdodDogMTUwIGlzIHRoZSBudW1iZXIgYWxsIGVpZ2h0XG4gIC8vIGRhZW1vbnMgY29udmVyZ2VkIG9uIGluZGVwZW5kZW50bHksIGFuZCBpdCBpcyB3aGF0IHR1cm5zIFwidGhlIGRhZW1vbiB0b2xkIHlvdVxuICAvLyB3aHkgaXQgZGllZFwiIGZyb20gYSBob3BlIGludG8gYW4gb2JzZXJ2YXRpb24uIGdsYW1vdXIncyBgY2xvc2VkYCBmcmFtZSBpcyB0aGVcbiAgLy8gb25lIHRoZSBDTEkncyB0YWlsIHdhdGNoZXMgZm9yLlxuICBjb25zdCBjbG9zZSA9ICgpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBzdG9wSG91c2VrZWVwaW5nKCk7XG4gICAgc2F2ZU5vdygpO1xuICAgIGNsZWFudXBEaXNjb3ZlcnkoKTtcbiAgICBlbWl0RXZlbnQoeyB0eXBlOiBcImNsb3NlZFwiIH0pO1xuICAgIHZvaWQgZHJhaW5BbmRTdG9wKHsgc2VydmVyLCBjbGllbnRzOiBzc2VDbGllbnRzLCBzb2NrZXRzIH0pLnRoZW4ocmVzb2x2ZVNodXRkb3duKTtcbiAgfTtcbiAgZG9uZS50aGVuKCgpID0+IGNsb3NlKCkpO1xuXG4gIHJldHVybiB7IHBvcnQ6IGJvdW5kUG9ydCwgc2Vzc2lvbklkLCBtb2RlLCBjbG9zZSwgZG9uZSwgc2h1dGRvd24gfTtcbn1cblxuLy8gIzgxIC8gRDQg4oCUIFRIRSBSRUNPR05JWkVEIFNFVCwgQVQgUEFSU0VSIEFMVElUVURFLiBUaGUgU0lYVEggZW50cnkgcG9pbnQuXG4vL1xuLy8g4pqgIFRISVMgT05FIEhBUyBaRVJPIGBmbGFncy5gIFJFQURTLCBzbyBhIGBmbGFncy5gLXBhdHRlcm4gYXVkaXQgcmV0dXJucyB6ZXJvXG4vLyBoZXJlIOKAlCBhbmQgYSB6ZXJvIHJlYWRzIGlkZW50aWNhbGx5IHRvIFwibm8gZHJpZnRcIi4gSXQgd2FzIGEgTE9PS1VQIHBhcnNlcjpcbi8vIGBjb25zdCBmbGFnID0gKG5hbWUpID0+IHsgY29uc3QgaSA9IGFyZ3MuaW5kZXhPZihgLS0ke25hbWV9YCk7IHJldHVybiBpID49IDBcbi8vID8gYXJnc1tpICsgMV0gOiB1bmRlZmluZWQ7IH1gLiBJdCBhbHNvIHJlYWQgYEJ1bi5hcmd2YCwgbm90IGBwcm9jZXNzLmFyZ3ZgLFxuLy8gd2hpY2ggaXMgdGhlIHN5bm9ueW0gdGhhdCBoYXMgbWFkZSB0aGlzIHJlcG8ncyBncmVwcyBsaWUgYmVmb3JlLlxuLy9cbi8vIEl0IGhhZCBhIExBVEVOVCwgUFJFLUVYSVNUSU5HIGJ1ZyB0aGUgY29udmVyc2lvbiBmaXhlcyBhcyBhIHNpZGUgZWZmZWN0LCBub3RlZFxuLy8gc28gdGhlIGNoYW5nZSBpcyBub3QgbWlzdGFrZW4gZm9yIGEgcmVncmVzc2lvbjogYGZsYWcoKWAgcmV0dXJuZWQgYGFyZ3NbaSsxXWBcbi8vIFVOQ09ORElUSU9OQUxMWSwgc28gYC0tcmVzdG9yZSAtLXRpdGxlIFhgIHlpZWxkZWQgYHJlc3RvcmUgPT09IFwiLS10aXRsZVwiYCDigJRcbi8vIHRoZSBuZXh0IEZMQUcgc2lsZW50bHkgY29uc3VtZWQgYXMgdGhlIHByZXZpb3VzIGZsYWcncyBWQUxVRS5cbi8vXG4vLyBBbGwgc2l4IGFyZSBzdHJpbmcgYnkgY29uc3RydWN0aW9uICh0aGUgb2xkIGhlbHBlciByZXR1cm5lZCB0aGUgbmV4dCBhcmd2XG4vLyBlbGVtZW50KS4gYHBvcnRgIGFuZCBgdGltZW91dGAgYXJlIE51bWJlcigpLWNvZXJjZWQgYXQgdGhlIGNhbGwgc2l0ZSwgd2hpY2ggaXNcbi8vIGEgdmFsdWUgcmVhZCwgbm90IGEgYm9vbGVhbiBvbmUuIFRoZSBkYWVtb24gdGFrZXMgbm8gcG9zaXRpb25hbHMsIHNvIHN0cmljdCdzXG4vLyBkZWZhdWx0IHJlamVjdGlvbiBvZiB0aGVtIGlzIGNvcnJlY3QuXG4vL1xuLy8gVmVyaWZpZWQgYmVmb3JlIGNvbnZlcnRpbmc6IGBjbGkudHNgIHNwYXducyB0aGlzIGRhZW1vbiB3aXRoIGV4YWN0bHkgLS10aXRsZSxcbi8vIC0taW50ZW50LCAtLXRpbWVvdXQsIC0tcmVzdG9yZSBhbmQgLS1wcm9qZWN0LCBhbGwgaW5zaWRlIHRoaXMgc2V0IOKAlCBzbyBzdHJpY3Rcbi8vIGNhbm5vdCByZWZ1c2UgdGhlIGRhZW1vbidzIG93biBsYXVuY2guXG5jb25zdCBEQUVNT05fT1BUSU9OUyA9IHtcbiAgaW50ZW50OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcG9ydDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHByb2plY3Q6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByZXN0b3JlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGltZW91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpdGxlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbn0gYXMgY29uc3Q7XG5cbi8qKiBQYXJzZSB0aGUgZGFlbW9uJ3MgYXJndiwgYm9vdCwgcHJpbnQgdGhlIGhhbmRzaGFrZSwgYW5kIHdhaXQgZm9yIHRoZSBlbmQuXG4gKiAgUmV0dXJucyB0aGUgcHJvY2VzcyBleGl0IGNvZGU7IGl0IGRvZXMgTk9UIGV4aXQg4oCUIHRoZSBsYXVuY2hlciBkb2VzLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD47XG4gIHRyeSB7XG4gICAgZmxhZ3MgPSBub2RlUGFyc2VBcmdzKHsgYXJnczogYXJndiwgb3B0aW9uczogREFFTU9OX09QVElPTlMsIHN0cmljdDogdHJ1ZSB9KS52YWx1ZXMgYXMgUmVjb3JkPFxuICAgICAgc3RyaW5nLFxuICAgICAgc3RyaW5nIHwgdW5kZWZpbmVkXG4gICAgPjtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYGdsYW1vdXI6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmAgK1xuICAgICAgICBgICByZWNvZ25pemVkIGZsYWdzOiAke09iamVjdC5rZXlzKERBRU1PTl9PUFRJT05TKVxuICAgICAgICAgIC5tYXAoKGspID0+IGAtLSR7a31gKVxuICAgICAgICAgIC5qb2luKFwiIFwiKX1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3QgZCA9IGF3YWl0IHN0YXJ0RGFlbW9uKHtcbiAgICBwb3J0OiBmbGFncy5wb3J0ID8gTnVtYmVyKGZsYWdzLnBvcnQpIDogMCxcbiAgICB0aXRsZTogZmxhZ3MudGl0bGUsXG4gICAgaW50ZW50OiBmbGFncy5pbnRlbnQsXG4gICAgcmVzdG9yZTogZmxhZ3MucmVzdG9yZSxcbiAgICB0aW1lb3V0UzogZmxhZ3MudGltZW91dCA/IE51bWJlcihmbGFncy50aW1lb3V0KSA6IHVuZGVmaW5lZCxcbiAgICBwcm9qZWN0OiBmbGFncy5wcm9qZWN0LFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7ZC5wb3J0fWAsIHBvcnQ6IGQucG9ydCwgc2Vzc2lvbl9pZDogZC5zZXNzaW9uSWQsIG1vZGU6IGQubW9kZSB9KX1cXG5gLFxuICApO1xuICBjb25zdCByZXMgPSBhd2FpdCBkLmRvbmU7XG4gIC8vIFdhaXQgZm9yIHRoZSBjbG9zZWQgU1NFIGV2ZW50IHRvIGZsdXNoIGJlZm9yZSBleGl0aW5nLlxuICBhd2FpdCBkLnNodXRkb3duO1xuICByZXR1cm4gcmVzLmNvZGU7XG59XG5cbi8qKlxuICogVGhlIGRhZW1vbidzIGVudHJ5LCBmb3IgdGhlIExBVU5DSEVSIGF0XG4gKiBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dsYW1vdXIvc2NyaXB0cy9zZXJ2ZXIudHNgLlxuICpcbiAqIOKblCBgaW1wb3J0Lm1ldGEubWFpbmAgSVMgRkFMU0UgSU4gVEhFIEJVTkRMRS4gYGRpc3Qvc2VydmVyLmpzYCBpcyBJTVBPUlRFRCBieVxuICogdGhlIGxhdW5jaGVyLCBuZXZlciBleGVjdXRlZCBhcyB0aGUgcHJvY2VzcyBlbnRyeSwgc28gdGhlIG9sZFxuICogYGlmIChpbXBvcnQubWV0YS5tYWluKWAgYmxvY2sgd291bGQgc2ltcGx5IG5ldmVyIHJ1biDigJQgdGhlIGRhZW1vbiB3b3VsZCBib290LFxuICogc2VydmUgbm90aGluZyBhbmQgZXhpdCAwLCBhbmQgZXZlcnkgdGVzdCB3b3VsZCBmYWlsIGFzIFwidGhlIGRhZW1vbiBuZXZlciBib3VuZFxuICogYSBwb3J0XCIsIHdoaWNoIHJlYWRzIGxpa2UgZmxha2UuIFRoYXQgaXMgdGhlIGZhaWx1cmUgdGhpcyBleHBvcnQgZXhpc3RzIHRvXG4gKiBwcmV2ZW50LCBhbmQgaXQgaXMgdGhlIGZpcnN0IHRoaW5nIHRoYXQgYnJlYWtzIG9uIGV2ZXJ5IGJhY2tlbmQgcmVsb2NhdGlvbi5cbiAqXG4gKiDim5QgQU5EIFRIRVJFIElTIE5PIGBpbXBvcnQubWV0YS5tYWluYCBCTE9DSyBMRUZULCBkZWxpYmVyYXRlbHkgKEQxMikuIFJ1biBmcm9tXG4gKiBgc3JjL2dsYW1vdXIvYmFja2VuZC9gLCBgU0tJTExfUk9PVGAgY29tcHV0ZXMgdG8gYHNyYy9nbGFtb3VyL2AsIHdoaWNoIGhvbGRzIG5vXG4gKiBgZGlzdC9pbmRleC5odG1sYCDigJQgc28gdGhlIGRhZW1vbiB3b3VsZCBzaWxlbnRseSBjaG9vc2UgREVWIG1vZGUgYW5kIHRoZW4gZmFpbFxuICogdGhlIGRldiBpbXBvcnQgZnJvbSB0aGUgd3JvbmcgYW5jaG9yLiBPZmZlcmluZyB0aGF0IGVudHJ5IHdvdWxkIGJlIG9mZmVyaW5nIGFcbiAqIHdyb25nIGRhZW1vbi5cbiAqXG4gKiDim5QgQU5EIElUIFRBS0VTIE5PIEFSR1VNRU5UUywgZm9yIHRoZSBzYW1lIHJlYXNvbiBgY2xpLnRzYCdzIGBydW4oKWAgZG9lcyBub3Q6XG4gKiB0aGUgY29tbWFuZCBsaW5lIGJlbG9uZ3MgdG8gdGhlIGZpbGUgdGhhdCBQQVJTRVMgaXQuIEEgbGF1bmNoZXIgdGhhdCB0b3VjaGVkXG4gKiBgcHJvY2Vzcy5hcmd2YCB3b3VsZCBtYXRjaCBgZ3JpbW9pcmUvbGliL2VudHJ5LXBvaW50cy50c2AncyBhcmctcGFyc2luZ1xuICogcHJlZGljYXRlIGFuZCB0aGUgd2FyZHMgd291bGQganVkZ2UgdGhpcyBkYWVtb24ncyBmbGFncyBhZ2FpbnN0IGEgZmlsZSB0aGF0XG4gKiByZWNvZ25pc2VzIG5vbmUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cbiIsCiAgICAiLy8gVGhlIHNpbmdsZSBzaGFyZWQgY29udHJhY3Qg4oCUIGltcG9ydGVkIGJ5IHNlcnZlci50cywgY2xpLnRzLCBhbmQgdGhlIHN1cmZhY2UuXG5cbmV4cG9ydCB0eXBlIEl0ZW1LaW5kID0gXCJyZWZcIiB8IFwiY29udGV4dFwiIHwgXCJnZW5cIiB8IFwic3R5bGVcIjtcbmV4cG9ydCBjb25zdCBWQUxJRF9LSU5EOiByZWFkb25seSBJdGVtS2luZFtdID0gW1wicmVmXCIsIFwiY29udGV4dFwiLCBcImdlblwiLCBcInN0eWxlXCJdIGFzIGNvbnN0O1xuXG4vLyBHZW5lcmF0aW9uIG1ldGFkYXRhIChHMSkuIEZ1bGx5IHBvcHVsYXRlZCBmb3Iga2luZCA9PT0gXCJnZW5cIiBpbiBTbGljZSAzO1xuLy8gdGhlIGZpZWxkIGV4aXN0cyBub3cgc28gdGhlIGNvbnRyYWN0IGFuZCB0aGUgZGV0YWlscyBmbHktb3V0IGFyZSBzdGFibGUuXG5leHBvcnQgdHlwZSBHZW5NZXRhID0ge1xuICBtb2RlbDogc3RyaW5nO1xuICBwcm9tcHQ6IHN0cmluZztcbiAgc2VlZDogbnVtYmVyIHwgbnVsbDtcbiAgY29zdDogbnVtYmVyIHwgbnVsbDtcbiAgY3VzdG9tOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICByb3VuZDogbnVtYmVyOyAvLyBiYXRjaCBpbmRleCB0aGUgYWdlbnQgc3RhbXBzOyBVSSBncm91cHMgZ2VuIGl0ZW1zIGJ5IGl0XG59O1xuXG4vLyBPbmUgY2F0YWxvZyBlbnRyeS4gU2hhcGUgZm9sbG93cyBpbWFnbydzIENvbnRleHRFbnRyeSBjb252ZW50aW9uczpcbi8vIGJsb2JzIChgc3JjYCwgYHRleHRgKSBhcmUgc3RyaXBwZWQgaW4gdGhlIGxlYW4gYWdlbnQgcHJvamVjdGlvbjsgdGhlIGFnZW50XG4vLyByZWFkcyBgcGF0aGAuIEFyY2hpdmFsIGlzIG5vbi1kZXN0cnVjdGl2ZSAodGhlIGBhcmNoaXZlZGAgZmxhZzsgdGhlIGl0ZW1cbi8vIHN1cnZpdmVzIGluIHRoZSBsaWJyYXJ5KS5cbmV4cG9ydCB0eXBlIExpYnJhcnlJdGVtID0ge1xuICBpZDogc3RyaW5nO1xuICBraW5kOiBJdGVtS2luZDtcbiAgdGl0bGU6IHN0cmluZztcbiAgc3JjOiBzdHJpbmc7IC8vIGltYWdlIGRhdGEtVVJMIChyZWYvZ2VuKTsgXCJcIiBvdGhlcndpc2Ug4oCUIHN0cmlwcGVkIGluIGxlYW5cbiAgcGF0aDogc3RyaW5nOyAvLyBvbi1kaXNrIG1hdGVyaWFsaXplZCBibG9iIHRoZSBhZ2VudCBjYW4gUmVhZDsgXCJcIiBpZiBub25lXG4gIHRleHQ6IHN0cmluZzsgLy8gY29udGV4dCBib2R5OyBcIlwiIG90aGVyd2lzZSDigJQgc3RyaXBwZWQgaW4gbGVhblxuICBtaW1lOiBzdHJpbmc7IC8vIGUuZy4gXCJpbWFnZS93ZWJwXCIsIFwidGV4dC9tYXJrZG93blwiXG4gIHRhZ3M6IHN0cmluZ1tdO1xuICBzdGFycmVkOiBib29sZWFuO1xuICBsaWtlZDogYm9vbGVhbjtcbiAgYW5ub3RhdGlvbnM6IHsgYWdlbnQ6IHN0cmluZzsgaHVtYW46IHN0cmluZyB9O1xuICBjYW5vbmljYWw6IGJvb2xlYW47IC8vIG1hcmtlZCBjYW5vbmljYWwgZm9yIHRoZSBzdHlsZSBiZWluZyBidWlsdCAobXVsdGksIG5vdCBzaW5nbGUtc2VsZWN0KVxuICBjYW5vbjogQ2Fub25JbWdbXTsgLy8gYSBraW5kOlwic3R5bGVcIiBpdGVtJ3MgY2Fub25pY2FsIHRodW1ibmFpbHM7IFtdIG90aGVyd2lzZSDigJQgc3RyaXBwZWQgaW4gbGVhblxuICBhcmNoaXZlZDogYm9vbGVhbjtcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIGdlbjogR2VuTWV0YSB8IG51bGw7XG59O1xuXG4vLyBDb252ZXJzYXRpb24uIEFnZW50IG1lc3NhZ2Uga2luZHMgY2FycnkgVjEncyBuYXJyYXRpb24gc2VtYW50aWNzXG4vLyAoaW5mbyB8IHdvcmtpbmcgfCByZXN1bHQgfCBlcnJvcik7IHVzZXIgbWVzc2FnZXMgYXJlIGFsd2F5cyBcImluZm9cIi5cbmV4cG9ydCB0eXBlIE1lc3NhZ2VLaW5kID0gXCJpbmZvXCIgfCBcIndvcmtpbmdcIiB8IFwicmVzdWx0XCIgfCBcImVycm9yXCI7XG5leHBvcnQgdHlwZSBNZXNzYWdlID0ge1xuICBpZDogc3RyaW5nO1xuICB3aG86IFwidXNlclwiIHwgXCJhZ2VudFwiO1xuICBraW5kOiBNZXNzYWdlS2luZDtcbiAgdGV4dDogc3RyaW5nO1xuICBncm91bmQ6IHN0cmluZ1tdOyAvLyBpdGVtIGlkcyBncm91bmRpbmcgdGhpcyBtZXNzYWdlIChzbmFwc2hvdCBvZiBzZWxlY3RlZElkcyk7IFtdIGlmIG5vbmVcbiAgdHM6IG51bWJlcjtcbn07XG5cbi8vIEEgYnJvdWdodC1pbiBzdHlsZSdzIGNhbm9uaWNhbCB0aHVtYm5haWwgKGRhdGEtVVJMIGBzcmNgIOKAlCBzdHJpcHBlZCBpbiBsZWFuKS5cbmV4cG9ydCB0eXBlIENhbm9uSW1nID0geyB0aXRsZTogc3RyaW5nOyBzcmM6IHN0cmluZyB9O1xuXG4vLyBBIGNhbm9uaWNhbCBpbWFnZSBpbnNpZGUgYSBTYXZlZFN0eWxlOiB0aGUgYmxvYiBpcyBjb3BpZWQgaW50byB0aGUgc3R5bGUnc1xuLy8gZGlyIG9uIHNhdmUgYW5kIHJlZmVyZW5jZWQgYnkgYGZpbGVgIChzbyB0aGUgc2F2ZWQgc3R5bGUgaXMgc2VsZi1jb250YWluZWQpLlxuZXhwb3J0IHR5cGUgQ2Fub25pY2FsUmVmID0ge1xuICBpZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBmaWxlOiBzdHJpbmc7XG4gIG1pbWU6IHN0cmluZztcbn07XG5cbi8vIEEgc3R5bGUgc2F2ZWQgdG8gdGhlIHByb2plY3QgdHJheSDigJQgYSBjb21wb3VuZCBcImNhbm9uaWNhbCBzaGFwZVwiOiB0aGUgY29kaWZpZWRcbi8vIHN0eWxlLWd1aWRlIHNlY3Rpb25zICh0ZXh0KSArIGNhbm9uaWNhbCBpbWFnZXMuIFByb2plY3Qtc2NvcGVkLCBub24tZGVzdHJ1Y3RpdmUuXG5leHBvcnQgdHlwZSBTYXZlZFN0eWxlID0ge1xuICBpZDogc3RyaW5nO1xuICBsYWJlbDogc3RyaW5nO1xuICB0ZXh0OiBzdHJpbmc7IC8vIHNob3J0IGh1bWFuIGRlc2NyaXB0aW9uIChlLmcuIHRoZSBVbmRlcnN0YW5kaW5nL0RpcmVjdGlvbiBnaXN0KVxuICBzZWN0aW9uczogU3R5bGVTZWN0aW9uW107IC8vIHRoZSBjb2RpZmllZCBzdHlsZSBndWlkZSBhdCBzYXZlIHRpbWVcbiAgY2Fub25pY2FsOiBDYW5vbmljYWxSZWZbXTtcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIGFyY2hpdmVkOiBib29sZWFuO1xufTtcblxuLy8gVGhlIGFnZW50LWFzc2VtYmxlZCBzdHlsZSBndWlkZS4gU2VjdGlvbiBzZXQgKyBsYWJlbHMgYXJlIHRoZSBtb2NrdXAnc1xuLy8gKHRoZSBjb252ZXJnZWQgc3VyZmFjZSkuIFNlY3Rpb25zIGZpbGwgaW46IGVtcHR5IOKGkiBmb3JtaW5nIOKGkiBhZ3JlZWQuXG5leHBvcnQgdHlwZSBTZWN0aW9uU3RhdHVzID0gXCJlbXB0eVwiIHwgXCJmb3JtaW5nXCIgfCBcImFncmVlZFwiO1xuZXhwb3J0IHR5cGUgU2VjdGlvbktleSA9XG4gIHwgXCJ1bmRlcnN0YW5kaW5nXCJcbiAgfCBcImRpcmVjdGlvblwiXG4gIHwgXCJwYWxldHRlXCJcbiAgfCBcImNvbnNpc3RlbmN5XCJcbiAgfCBcInByb21wdHNcIlxuICB8IFwiY2Fub25pY2FsXCI7XG4vLyBBIHBhbGV0dGUgc3dhdGNoIOKAlCBzdHJ1Y3R1cmVkIGNvbG9yIGZvciB0aGUgXCJwYWxldHRlXCIgc2VjdGlvbi5cbmV4cG9ydCB0eXBlIFN3YXRjaCA9IHsgaGV4OiBzdHJpbmc7IG5hbWU/OiBzdHJpbmcgfTtcbmV4cG9ydCB0eXBlIFN0eWxlU2VjdGlvbiA9IHtcbiAga2V5OiBTZWN0aW9uS2V5O1xuICBsYWJlbDogc3RyaW5nO1xuICBzdGF0dXM6IFNlY3Rpb25TdGF0dXM7XG4gIGNvbnRlbnQ6IHN0cmluZzsgLy8gcHJvc2VcbiAgcHJvbXB0czogc3RyaW5nW107IC8vIHBvcHVsYXRlZCBmb3IgdGhlIFwicHJvbXB0c1wiIHNlY3Rpb247IFtdIGVsc2V3aGVyZVxuICBjb2xvcnM6IFN3YXRjaFtdOyAvLyBwb3B1bGF0ZWQgZm9yIHRoZSBcInBhbGV0dGVcIiBzZWN0aW9uOyBbXSBlbHNld2hlcmVcbn07XG5cbi8vIFRoZSB6b29tL2ZvY3VzIGNvLXByZXNlbmNlIGxlbnMuIEVpdGhlciBwYXJ0eSBjYW4gc2NvcGUgdGhlIHNldC5cbmV4cG9ydCB0eXBlIEZvY3VzU2NvcGUgPSBcImFsbFwiIHwgXCJmb2N1c1wiO1xuZXhwb3J0IHR5cGUgRm9jdXNPd25lciA9IFwieW91XCIgfCBcImFnZW50XCIgfCBudWxsO1xuXG5leHBvcnQgdHlwZSBHbGFtb3VyU3RhdGUgPSB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGludGVudDogc3RyaW5nO1xuICBsaWJyYXJ5OiBMaWJyYXJ5SXRlbVtdO1xuICBzZWxlY3RlZElkczogc3RyaW5nW107IC8vIGxpbmtlZCBzZXQg4oCUIHRoZSBncm91bmRpbmcgc2V0ICh1bnNlbGVjdCDiiaAgZGVsZXRlKVxuICBtZXNzYWdlczogTWVzc2FnZVtdO1xuICBzdHlsZUd1aWRlOiBTdHlsZVNlY3Rpb25bXTtcbiAgdHJheTogU2F2ZWRTdHlsZVtdO1xuICBzY29wZTogRm9jdXNTY29wZTtcbiAgZm9jdXNTZXQ6IHN0cmluZ1tdOyAvLyBpdGVtIGlkcyBpbiB0aGUgZm9jdXNlZCBzZXQ7IGVtcHR5IHdoZW4gc2NvcGUgPT09IFwiYWxsXCJcbiAgZm9jdXNPd25lcjogRm9jdXNPd25lcjsgLy8gd2hvIHNjb3BlZCB0aGUgZm9jdXNcbiAgZm9jdXNOb3RlOiBzdHJpbmc7IC8vIGFnZW50J3MgY29udGV4dHVhbCBxdWVzdGlvbiBmb3IgdGhlIGZvY3VzIGRyYXdlcjsgXCJcIiBvdGhlcndpc2VcbiAgc3RhdHVzOiB7IGJ1c3k6IGJvb2xlYW47IHRleHQ6IHN0cmluZyB9O1xufTtcblxuLy8gTGVhbiBwcm9qZWN0aW9uIHNlbnQgdG8gdGhlIGFnZW50OiBibG9icyBzdHJpcHBlZCwgcGF0aHMga2VwdC5cbmV4cG9ydCB0eXBlIExlYW5JdGVtID0gT21pdDxMaWJyYXJ5SXRlbSwgXCJzcmNcIiB8IFwidGV4dFwiIHwgXCJjYW5vblwiPjtcbmV4cG9ydCB0eXBlIExlYW5TdGF0ZSA9IE9taXQ8R2xhbW91clN0YXRlLCBcImxpYnJhcnlcIj4gJiB7XG4gIGxpYnJhcnk6IExlYW5JdGVtW107XG59O1xuXG4vLyBTZXJ2ZXIg4oaSIGJyb3dzZXIgKFdlYlNvY2tldCkuIEZ1bGwtc3RhdGUgYnJvYWRjYXN0IGlzIHRoZSBvbmx5IGZyYW1lLlxuZXhwb3J0IHR5cGUgU2VydmVyVG9DbGllbnQgPSB7IHR5cGU6IFwic3RhdGVcIjsgc3RhdGU6IEdsYW1vdXJTdGF0ZSB9O1xuXG4vLyBCcm93c2VyIOKGkiBzZXJ2ZXIgKFdlYlNvY2tldCkuXG5leHBvcnQgdHlwZSBDbGllbnRUb1NlcnZlciA9XG4gIHwge1xuICAgICAgdHlwZTogXCJpdGVtLmFkZFwiO1xuICAgICAgaXRlbToge1xuICAgICAgICBraW5kOiBcInJlZlwiIHwgXCJjb250ZXh0XCI7XG4gICAgICAgIHRpdGxlOiBzdHJpbmc7XG4gICAgICAgIHNyYz86IHN0cmluZztcbiAgICAgICAgdGV4dD86IHN0cmluZztcbiAgICAgICAgbWltZT86IHN0cmluZztcbiAgICAgIH07XG4gICAgfVxuICB8IHsgdHlwZTogXCJpdGVtLnNlbGVjdFwiOyBpZHM6IHN0cmluZ1tdIH0gLy8gYW1iaWVudFxuICB8IHsgdHlwZTogXCJpdGVtLnN0YXJcIjsgaWQ6IHN0cmluZzsgc3RhcnJlZDogYm9vbGVhbiB9IC8vIGFtYmllbnRcbiAgfCB7IHR5cGU6IFwiaXRlbS5saWtlXCI7IGlkOiBzdHJpbmc7IGxpa2VkOiBib29sZWFuIH0gLy8gYW1iaWVudFxuICB8IHsgdHlwZTogXCJpdGVtLmFubm90YXRlXCI7IGlkOiBzdHJpbmc7IGh1bWFuOiBzdHJpbmcgfSAvLyBhbWJpZW50IOKAlCBzdG9yZWQgKyByZWFkIG9uIGRlbWFuZCwgbm90IHB1c2hlZCBhcyBhbiBldmVudFxuICB8IHsgdHlwZTogXCJtZXNzYWdlLnNlbmRcIjsgdGV4dDogc3RyaW5nIH0gLy8gaW1wZXJhdGl2ZVxuICB8IHsgdHlwZTogXCJmb2N1cy5zZXRcIjsgaWRzOiBzdHJpbmdbXSB9IC8vIGFtYmllbnQg4oCUIGh1bWFuIHNjb3BlcyBhIGZvY3VzIHNldFxuICB8IHsgdHlwZTogXCJmb2N1cy5jbGVhclwiIH0gLy8gYW1iaWVudCDigJQgaHVtYW4gem9vbXMgYmFjayBvdXRcbiAgfCB7IHR5cGU6IFwiaXRlbS5jYW5vbmljYWxcIjsgaWQ6IHN0cmluZzsgY2Fub25pY2FsOiBib29sZWFuIH0gLy8gYW1iaWVudFxuICB8IHsgdHlwZTogXCJpdGVtLmFyY2hpdmVcIjsgaWQ6IHN0cmluZzsgYXJjaGl2ZWQ6IGJvb2xlYW4gfSAvLyBhbWJpZW50XG4gIHwgeyB0eXBlOiBcInN0eWxlLmJyaW5nSW5cIjsgaWQ6IHN0cmluZyB9OyAvLyBpbXBlcmF0aXZlIOKAlCBhZGRzIGEga2luZDpcInN0eWxlXCIgaXRlbVxuXG4vLyBBZ2VudCDihpIgc2VydmVyIChIVFRQIFBPU1QgL2NtZCkuXG5leHBvcnQgdHlwZSBBZ2VudENvbW1hbmQgPVxuICB8IHsgdHlwZTogXCJpbml0XCI7IHRpdGxlPzogc3RyaW5nOyBpbnRlbnQ/OiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJpbnRlbnRcIjsgdGV4dDogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwiaXRlbS5hbm5vdGF0ZVwiOyBpZDogc3RyaW5nOyBhZ2VudDogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwic2F5XCI7IHRleHQ6IHN0cmluZzsga2luZD86IE1lc3NhZ2VLaW5kIH1cbiAgfCB7XG4gICAgICB0eXBlOiBcInNlY3Rpb25cIjtcbiAgICAgIGtleTogU2VjdGlvbktleTtcbiAgICAgIGNvbnRlbnQ/OiBzdHJpbmc7XG4gICAgICBzdGF0dXM/OiBTZWN0aW9uU3RhdHVzO1xuICAgICAgcHJvbXB0cz86IHN0cmluZ1tdO1xuICAgICAgY29sb3JzPzogU3dhdGNoW107XG4gICAgfVxuICB8IHtcbiAgICAgIHR5cGU6IFwiZ2VuLmFkZFwiO1xuICAgICAgc3JjOiBzdHJpbmc7IC8vIGFuIEFMUkVBRFktb3B0aW1pemVkIHdlYnAgZGF0YS1VUkwgKENMSSBkb2VzIHRoZSBvcHRpbWl6YXRpb24pXG4gICAgICBwcm9tcHQ6IHN0cmluZztcbiAgICAgIG1vZGVsOiBzdHJpbmc7XG4gICAgICByb3VuZDogbnVtYmVyO1xuICAgICAgc2VlZD86IG51bWJlcjtcbiAgICAgIGNvc3Q/OiBudW1iZXI7XG4gICAgICBsYWJlbD86IHN0cmluZztcbiAgICAgIGN1c3RvbT86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gICAgfVxuICB8IHsgdHlwZTogXCJnZW4uY29zdFwiOyBpZDogc3RyaW5nOyBjb3N0OiBudW1iZXIgfSAvLyBiYWNrZmlsbCBjb3N0IG9uY2UgbWVkaWEtZm9yZ2UgZmluYWxpemVzIGl0XG4gIHwgeyB0eXBlOiBcImdlbi5tZXRhXCI7IGlkOiBzdHJpbmc7IHByb21wdD86IHN0cmluZzsgY3VzdG9tPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB9IC8vIGJhY2tmaWxsIHRoZSByZWFsIHByb21wdCAvIHJlZnMgb250byBhIGdlblxuICB8IHsgdHlwZTogXCJmb2N1cy5wdXNoXCI7IGlkczogc3RyaW5nW107IG5vdGU/OiBzdHJpbmcgfSAvLyBhZ2VudCBzY29wZXMgYSBmb2N1cyBzZXQgKyBhc2tzXG4gIHwgeyB0eXBlOiBcInN0eWxlLnNhdmVcIjsgbGFiZWw6IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcInN0eWxlLmFyY2hpdmVcIjsgaWQ6IHN0cmluZzsgYXJjaGl2ZWQ6IGJvb2xlYW4gfVxuICB8IHsgdHlwZTogXCJzdGF0dXNcIjsgYnVzeTogYm9vbGVhbjsgdGV4dD86IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcImNsb3NlXCIgfTtcblxuLy8gVGhlIGNvbXBsZXRlIGFnZW50LWV2ZW50IHNldCAoc2VydmVyIOKGkiBhZ2VudCBTU0UpLiBPbmx5IHRoZXNlIGFyZSBlbWl0dGVkLlxuLy8gSW1wZXJhdGl2ZXMgb25seSDigJQgYm9hcmQgbW92ZXMgKHNlbGVjdC9zdGFyL2xpa2UpIGFyZSBhbWJpZW50LlxuZXhwb3J0IGNvbnN0IEFHRU5UX0VWRU5UX1RZUEVTID0gT2JqZWN0LmZyZWV6ZShbXG4gIFwicmVhZHlcIixcbiAgXCJjb25uZWN0ZWRcIixcbiAgXCJkaXNjb25uZWN0ZWRcIixcbiAgXCJpdGVtLmFkZFwiLFxuICBcIm1lc3NhZ2UudXNlclwiLFxuICBcImNsb3NlZFwiLFxuXSBhcyBjb25zdCk7XG5leHBvcnQgdHlwZSBBZ2VudEV2ZW50VHlwZSA9ICh0eXBlb2YgQUdFTlRfRVZFTlRfVFlQRVMpW251bWJlcl07XG5cbmV4cG9ydCBmdW5jdGlvbiBkZWZhdWx0U3R5bGVHdWlkZSgpOiBTdHlsZVNlY3Rpb25bXSB7XG4gIHJldHVybiBbXG4gICAge1xuICAgICAga2V5OiBcInVuZGVyc3RhbmRpbmdcIixcbiAgICAgIGxhYmVsOiBcIlVuZGVyc3RhbmRpbmdcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJkaXJlY3Rpb25cIixcbiAgICAgIGxhYmVsOiBcIkRpcmVjdGlvblwiLFxuICAgICAgc3RhdHVzOiBcImVtcHR5XCIsXG4gICAgICBjb250ZW50OiBcIlwiLFxuICAgICAgcHJvbXB0czogW10sXG4gICAgICBjb2xvcnM6IFtdLFxuICAgIH0sXG4gICAge1xuICAgICAga2V5OiBcInBhbGV0dGVcIixcbiAgICAgIGxhYmVsOiBcIlBhbGV0dGVcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJjb25zaXN0ZW5jeVwiLFxuICAgICAgbGFiZWw6IFwiQ29uc2lzdGVuY3lcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJwcm9tcHRzXCIsXG4gICAgICBsYWJlbDogXCJSZS1jYXN0IHByb21wdHNcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJjYW5vbmljYWxcIixcbiAgICAgIGxhYmVsOiBcIkNhbm9uaWNhbCBpbWFnZXNcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICBdO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGVmYXVsdFN0YXRlKHRpdGxlOiBzdHJpbmcsIGludGVudDogc3RyaW5nKTogR2xhbW91clN0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICB0aXRsZSxcbiAgICBpbnRlbnQsXG4gICAgbGlicmFyeTogW10sXG4gICAgc2VsZWN0ZWRJZHM6IFtdLFxuICAgIG1lc3NhZ2VzOiBbXSxcbiAgICBzdHlsZUd1aWRlOiBkZWZhdWx0U3R5bGVHdWlkZSgpLFxuICAgIHRyYXk6IFtdLFxuICAgIHNjb3BlOiBcImFsbFwiLFxuICAgIGZvY3VzU2V0OiBbXSxcbiAgICBmb2N1c093bmVyOiBudWxsLFxuICAgIGZvY3VzTm90ZTogXCJcIixcbiAgICBzdGF0dXM6IHsgYnVzeTogZmFsc2UsIHRleHQ6IFwiXCIgfSxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgdHdvIHByaW1pdGl2ZXMgdW5kZXIgQk9USCBvZiB0aGUgaG91c2UncyBkYWVtb24tZGlzY292ZXJ5IGNvbnZlbnRpb25zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogRDMgcnVsZWQgdGhhdCB0aGUgY29udmVudGlvbnMgdGhlbXNlbHZlcyDigJQgcGVyLXNlc3Npb24gdG1wZGlyIEpTT04gKGJvdW50eSxcbiAqIGdsYW1vdXIsIGltYWdvLCBtYWdwaWUpIGFuZCBzaW5nbGV0b24gYCRIT01FL2RhZW1vbi5wb3J0YCArIGBkYWVtb24ucGlkYFxuICogKGFzdHJvbGFiZSwgZ3JhcGV2aW5lLCBtaW5kLW1hcHBlcikg4oCUIGJvdGggc3Vydml2ZSwgYmVjYXVzZSB0aGV5IGVuY29kZVxuICogZ2VudWluZWx5IGRpZmZlcmVudCBtb2RlbHMgKGNvbmN1cnJlbnQgc2Vzc2lvbnMgdnMgYSBzdGFuZGluZyBzaW5nbGV0b24pIGFuZFxuICogcGlja2luZyBvbmUgaXMgYSBwcm9kdWN0IGRlY2lzaW9uLCBub3QgYSBmYWN0b3Jpbmcgb25lLiBXaGF0IElTIG9uZVxuICogaW1wbGVtZW50YXRpb24gaXMgdGhlIHBhaXIgYmVsb3csIHdoaWNoIGlzIGFsc28gZXhhY3RseSB3aGVyZSBjZW5zdXMgZGVmZWN0XG4gKiAqKkwzKiogbGl2ZXMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCByZW5hbWVTeW5jLCBybVN5bmMsIHVubGlua1N5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuXG4vKipcbiAqIFdyaXRlIGB0ZXh0YCB0byBgdGFyZ2V0YCBhdG9taWNhbGx5OiB3cml0ZSBiZXNpZGUgaXQsIHRoZW4gcmVuYW1lLlxuICpcbiAqIOKblCAqKkwzLCBDTE9TRUQgQlkgQ09OU1RSVUNUSU9OLioqIEEgYmFyZSBgd3JpdGVGaWxlU3luY2AgaXMgbm90IGF0b21pYywgc28gYVxuICogQ0xJIHJlYWRpbmcgd2hpbGUgdGhlIGRhZW1vbiB3cml0ZXMgY2FuIG9ic2VydmUgYSBIQUxGLVdSSVRURU4gcG9pbnRlci4gVW5kZXJcbiAqIGEgYmVzdC1lZmZvcnQgcmVhZGVyIHRoYXQgc3VyZmFjZWQgYXMgXCJubyBydW5uaW5nIHNlc3Npb25cIiDigJQgYWJzZW5jZSByZXBvcnRlZFxuICogZm9yIHdoYXQgd2FzIHJlYWxseSBhIHRvcm4gcmVhZCwgd2hpY2ggaXMgdGhlIGV4YWN0IGNvbmZsYXRpb24gdGhlIGhvdXNlJ3NcbiAqIGBudWxsYC1ub3QtYDBgIHJ1bGUgZXhpc3RzIHRvIHByZXZlbnQuIFJlbmFtZSB3aXRoaW4gb25lIGRpcmVjdG9yeSBpcyBhdG9taWMsXG4gKiBzbyBhIHJlYWRlciBzZWVzIGVpdGhlciB0aGUgcHJldmlvdXMgcG9pbnRlciBvciB0aGUgbmV3IG9uZSwgbmV2ZXIgYSBwYXJ0aWFsXG4gKiBmaWxlLlxuICpcbiAqIEZpeGVkIGluIGdsYW1vdXIgMjAyNi0wOS0wNywgZm91bmQgc3RhbmRpbmcgaW4gdGhyZWUgc2libGluZ3MgdGhlIG5leHQgZGF5IGJ5XG4gKiB0aGUgZHVwbGljYXRpb24gcmVjb24sIGFuZCByZXBhaXJlZCBpbiBhbGwgb2YgdGhlbSB0aGUgb25seSB3YXkgdGhhdCBkb2VzIG5vdFxuICogbmVlZCBmaW5kaW5nIGFnYWluOiB0aGVyZSBpcyBub3cgb25lIGltcGxlbWVudGF0aW9uLlxuICpcbiAqIOKaoCBUaGUgdGVtcCBuYW1lIGNhcnJpZXMgdGhlIHBpZCwgc28gdHdvIGRhZW1vbnMgcmFjaW5nIHRvIHB1Ymxpc2ggdGhlIHNhbWVcbiAqIHBvaW50ZXIgY2Fubm90IGNsb2JiZXIgZWFjaCBvdGhlcidzIGludGVybWVkaWF0ZSBmaWxlIOKAlCBhbmQgaXQgaXMgcmVtb3ZlZCBvblxuICogYSBmYWlsZWQgd3JpdGUgcmF0aGVyIHRoYW4gbGVmdCBhcyBsaXR0ZXIgYmVzaWRlIHRoZSByZWFsIG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlRmlsZUF0b21pYyh0YXJnZXQ6IHN0cmluZywgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHRtcCA9IGAke3RhcmdldH0uJHtwcm9jZXNzLnBpZH0udG1wYDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKHRtcCwgdGV4dCk7XG4gICAgcmVuYW1lU3luYyh0bXAsIHRhcmdldCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRyeSB7XG4gICAgICBybVN5bmModG1wLCB7IGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogdGhlIHRlbXAgZmlsZSBpcyBhbHJlYWR5IGdvbmUsIG9yIHdhcyBuZXZlciBjcmVhdGVkICovXG4gICAgfVxuICAgIHRocm93IGVycjtcbiAgfVxufVxuXG4vKipcbiAqIERlbGV0ZSBgcGF0aGAgaWZmIGl0IHN0aWxsIG5hbWVzIFVTLiBSZXR1cm5zIHdoZXRoZXIgaXQgd2FzIGRlbGV0ZWQuXG4gKlxuICog4puUICoqXCJTVElMTCBPVVJTXCIgSVMgVEhFIFdIT0xFIEZVTkNUSU9OLioqIEEgZGFlbW9uIHRoYXQgdW5saW5rcyBpdHMgZGlzY292ZXJ5XG4gKiBmaWxlIHVuY29uZGl0aW9uYWxseSBhdCBleGl0IGRlbGV0ZXMgdGhlIHBvaW50ZXIgYSBTVUNDRVNTT1IgaGFzIGFscmVhZHlcbiAqIHdyaXR0ZW4g4oCUIHRoZSBzdWNjZXNzb3IgY2FuIHRoZW4gbm8gbG9uZ2VyIGJlIGZvdW5kIGFuZCB0aGUgbmV4dCBDTEkgdmVyYiBzcGF3bnMgYVxuICogdGhpcmQgZGFlbW9uLiBCb3RoIGNvbnZlbnRpb25zIGhhdmUgdGhpcyBoYXphcmQgYW5kIGJvdGggZXhwcmVzcyBpdFxuICogZGlmZmVyZW50bHk6IGFzdHJvbGFiZSBjb21wYXJlcyB0aGUgcGlkIGZpbGUncyBieXRlcyB0byBpdHMgb3duIHBpZCxcbiAqIG1hZ3BpZSBwYXJzZXMgdGhlIEpTT04gcG9pbnRlciBhbmQgY29tcGFyZXMgYHNlc3Npb25faWRgLiBgaWRlbnRpZnlgIGlzIHdoYXRcbiAqIG1ha2VzIHRob3NlIG9uZSBmdW5jdGlvbiDigJQgaXQgdHVybnMgdGhlIGZpbGUncyBieXRlcyBpbnRvIHRoZSBpZGVudGl0eSB0b1xuICogY29tcGFyZSwgYW5kIGl0IGRlZmF1bHRzIHRvIHRoZSB0cmltbWVkIGJ5dGVzIHRoZW1zZWx2ZXMuXG4gKlxuICog4pqgIEV2ZXJ5IGZhaWx1cmUgaXMgc3dhbGxvd2VkIGFuZCByZXBvcnRlZCBhcyBgZmFsc2VgOiB0aGUgZmlsZSBiZWluZyBnb25lLFxuICogdW5yZWFkYWJsZSwgb3IgdW5wYXJzZWFibGUgYWxsIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZSDigJQgaXQgaXMgbm90IG91cnMgdG9cbiAqIHJlbW92ZS4gQW4gdW5wYXJzZWFibGUgcG9pbnRlciBpcyBkZWxpYmVyYXRlbHkgTk9UIHRyZWF0ZWQgYXMgb3Vycywgd2hpY2ggaXNcbiAqIHRoZSBjb25zZXJ2YXRpdmUgaGFsZiBvZiB0aGUgc2FtZSBgbnVsbGAtbm90LWAwYCBydWxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdW5saW5rSWZNYXRjaGVzKFxuICBwYXRoOiBzdHJpbmcsXG4gIGV4cGVjdGVkOiBzdHJpbmcsXG4gIGlkZW50aWZ5OiAocmF3OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGwgPSAocmF3KSA9PiByYXcudHJpbSgpLFxuKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGlkZW50aWZ5KHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpICE9PSBleHBlY3RlZCkgcmV0dXJuIGZhbHNlO1xuICAgIHVubGlua1N5bmMocGF0aCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBpbi1wcm9jZXNzIGV2ZW50IGxvZyDigJQgdGhlIGFwcGVuZC1vbmx5LCByZXBsYXlhYmxlIGJ1ZmZlclxuICogYmVoaW5kIGV2ZXJ5IHNwZWxsJ3MgYEdFVCAvZXZlbnRzYCBTU0UgdGFpbC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzXG4gKiBgc2NyaXB0cy9ldmVudHMudHNgIOKAlCB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMyLCBhbmQgdGhlIG9ubHkgb25lIG9mXG4gKiB0aGUgc2l4IGNvcGllZC1pbi1wbGFjZSBidXNlcyB0aGF0IGlzIGEgbW9kdWxlLCBpcyBib3VuZGVkLCBjYXJyaWVzIGFuIGVwb2NoLCBhbmQgaXNcbiAqIHVuaXQtdGVzdGVkLiBUaGUgZml2ZSBvdGhlcnMgYXJlIHRoZSBzYW1lIHR3ZW50eSBsaW5lcyB3cml0dGVuIGZpdmUgdGltZXMuXG4gKlxuICog4pSA4pSAIFRIRSBUSFJFRSBUSElOR1MgVEhJUyBGSVhFUyBCWSBDT05TVFJVQ1RJT04g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKioxIMK3IEw1IOKAlCB0aGUgYnVmZmVyIGlzIGJvdW5kZWQuKiogRml2ZSBkYWVtb25zIGFwcGVuZCB0byBhbiBhcnJheSBmb3IgdGhlXG4gKiB3aG9sZSBsaWZlIG9mIHRoZSBwcm9jZXNzLiBUaGUgd2luZG93IGlzIGEgUkVQTEFZIHdpbmRvdyBmb3IgcmVjb25uZWN0cyB3aXRoaW4gb25lXG4gKiBkYWVtb24ncyBsaWZldGltZSwgbm90IGEgZHVyYWJsZSBsb2c7IGEgY2FwIGlzIHRoZSBob25lc3Qgc2hhcGUuXG4gKlxuICogKioyIMK3IEw2IOKAlCBhIGZyYW1lIGNhcnJpZXMgYW4gZXBvY2gsIHdoZW4gdGhlIGNhbGxlciBhc2tzIGZvciBvbmUuKiogQWZ0ZXIgYVxuICogcmVzdGFydCB0aGUgaWRzIHN0YXJ0IGFnYWluIGF0IDEsIHNvIGEgcmVzdW1pbmcgY2xpZW50IGNhbm5vdCB0ZWxsIGEgc3RhbGVcbiAqIHdhdGVybWFyayBmcm9tIGEgZnJlc2ggb25lIGJ5IGlkIGFsb25lLlxuICpcbiAqICoqMyDCtyBBIFNUQUxFIFdBVEVSTUFSSyBSRVBMQVlTIEZST00gVEhFIEJFR0lOTklORywgYW5kIHRoaXMgaXMgdGhlIGhhbGYgdGhlXG4gKiBjbGllbnQgY2Fubm90IGRvLioqIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogYSB0YWlsIHRoYXQgcmVzdW1lcyBhdFxuICogYHNpbmNlPTxsYXN0IGlkIG9mIHRoZSBwcmV2aW91cyBkYWVtb24+YCBhZ2FpbnN0IGEgcmVzdGFydGVkIGRhZW1vbiByZWNlaXZlc1xuICogTk9USElORyDigJQgdGhlIG5ldyBkYWVtb24ncyBgcmVhZHlgIGlzIGlkIDEsIHdoaWNoIGlzIG5vdCBgPiBzaW5jZWAsIHNvIHRoZVxuICogZmlsdGVyIGRyb3BzIGl0LCBzbyBubyBmcmFtZSBhcnJpdmVzLCBzbyB0aGUgY2xpZW50J3MgZXBvY2ggY2hlY2sgbmV2ZXIgcnVuc1xuICogYW5kIHRoZSB0YWlsIHNpdHMgY29ubmVjdGVkIGFuZCBzaWxlbnQgdW50aWwgdGhlIG5ldyBkYWVtb24gaGFzIGVtaXR0ZWQgYXNcbiAqIG1hbnkgZXZlbnRzIGFzIHRoZSBvbGQgb25lIGRpZC4gU3RhbXBpbmcgYW4gZXBvY2ggYWxvbmUgZG9lcyBOT1QgY2xvc2UgdGhhdFxuICogZ2FwOiB0aGUgZXBvY2ggcmlkZXMgYSBmcmFtZSwgYW5kIHRoZSBidWcgaXMgdGhhdCBubyBmcmFtZSBpcyBzZW50LiBTb1xuICogYHN1YnNjcmliZWAgdHJlYXRzIGBzaW5jZSA+IGN1cnNvcmAgYXMgXCJ0aGlzIGN1cnNvciBpcyBmcm9tIGFub3RoZXIgcHJvY2Vzc1wiXG4gKiBhbmQgcmVwbGF5cyB3aG9sZS4gYG1pbmQtbWFwcGVyL3NjcmlwdHMvdGFpbC50ZXN0LnRzYCdzIGVwb2NoIGNlbGwgaXMgdGhlXG4gKiBleGVjdXRhYmxlIHNwZWMgb2YgdGhlIGNsaWVudCBoYWxmIGFuZCBzaG93cyB0aGUgcmVjb25uZWN0IHN0aWxsIGNhcnJ5aW5nIHRoZVxuICogc3RhbGUgY3Vyc29yIOKAlCBkZXRlY3Rpb24gaGFwcGVucyBvbiB3aGF0IGlzIFJFQ0VJVkVELlxuICovXG5cbi8qKiBUaGUgZGVmYXVsdCByZXBsYXkgd2luZG93LCBpbmhlcml0ZWQgZnJvbSBtaW5kLW1hcHBlcidzIG1lYXN1cmVkIGNhcC4gKi9cbmV4cG9ydCBjb25zdCBSRVBMQVlfQlVGRkVSX1NJWkUgPSAxMDAwO1xuXG4vKiogQSBmcmFtZSBhcyBpdCBnb2VzIG9uIHRoZSB3aXJlOiB0aGUgY2FsbGVyJ3MgcGF5bG9hZCBwbHVzIGEgbW9ub3RvbmljIGBpZGAsXG4gKiAgcGx1cyBhbiBgZXBvY2hgIHdoZW4gdGhlIGxvZyB3YXMgZ2l2ZW4gb25lLiAqL1xuZXhwb3J0IHR5cGUgRnJhbWU8VD4gPSBUICYgeyBpZDogbnVtYmVyOyBlcG9jaD86IHN0cmluZyB9O1xuXG5leHBvcnQgaW50ZXJmYWNlIEV2ZW50TG9nPFQ+IHtcbiAgLyoqIEFwcGVuZCBvbmUgZnJhbWUsIGZhbiBpdCBvdXQgdG8gbGl2ZSBzdWJzY3JpYmVycywgYW5kIHJldHVybiBpdC4gKi9cbiAgZW1pdChtc2c6IFQpOiBGcmFtZTxUPjtcbiAgLyoqXG4gICAqIFJlcGxheSBldmVyeXRoaW5nIGFmdGVyIGBzaW5jZWAsIHRoZW4gc3RheSBzdWJzY3JpYmVkLiBSZXR1cm5zIGFuXG4gICAqIHVuc3Vic2NyaWJlIGZ1bmN0aW9uLlxuICAgKlxuICAgKiDim5QgUkVQTEFZIEFORCBTVUJTQ1JJQkUgQVJFIE9ORSBDQUxMIE9OIFBVUlBPU0UuIERvaW5nIHRoZW0gaW4gdHdvIHN0ZXBzXG4gICAqIGxlYXZlcyBhIHdpbmRvdyBpbiB3aGljaCBhbiBlbWl0IGxhbmRzIGJldHdlZW4gdGhlIHJlcGxheSBsb29wIGFuZCB0aGVcbiAgICogYGFkZGAsIGFuZCB0aGF0IGZyYW1lIGlzIGRlbGl2ZXJlZCB0byBub2JvZHkg4oCUIHRoZSBzaGFwZSBmaXZlIGRhZW1vbnMgaGF2ZSxcbiAgICogc3Vydml2ZWQgYnkgbm90aGluZyBidXQgdGhlIHNpbmdsZS10aHJlYWRlZCBldmVudCBsb29wIGhhcHBlbmluZyB0byBjbG9zZVxuICAgKiBpdC4gRGVwZW5kaW5nIG9uIHRoYXQgaXMgZGVwZW5kaW5nIG9uIGFuIGltcGxlbWVudGF0aW9uIGRldGFpbCBvZiB0aGVcbiAgICogcnVudGltZSByYXRoZXIgdGhhbiBvbiB0aGUgY29kZS5cbiAgICovXG4gIHN1YnNjcmliZShzaW5jZTogbnVtYmVyLCBsaXN0ZW5lcjogKGZyYW1lOiBGcmFtZTxUPikgPT4gdm9pZCk6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgaGlnaGVzdCBpZCBlbWl0dGVkIHNvIGZhciDigJQgd2hhdCBgR0VUIC9zdGF0ZWAgcmV0dXJucyBhcyBgY3Vyc29yYC4gKi9cbiAgY3Vyc29yKCk6IG51bWJlcjtcbiAgLyoqIFRoZSBlcG9jaCBzdGFtcGVkIG9uIGV2ZXJ5IGZyYW1lLCBvciBgdW5kZWZpbmVkYCBpZiBub25lIHdhcyBjb25maWd1cmVkLiAqL1xuICByZWFkb25seSBlcG9jaDogc3RyaW5nIHwgdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRXZlbnRMb2c8VCBleHRlbmRzIG9iamVjdD4oXG4gIG9wdHM6IHsgZXBvY2g/OiBzdHJpbmc7IGJ1ZmZlclNpemU/OiBudW1iZXIgfSA9IHt9LFxuKTogRXZlbnRMb2c8VD4ge1xuICBjb25zdCBidWZmZXJTaXplID0gb3B0cy5idWZmZXJTaXplID8/IFJFUExBWV9CVUZGRVJfU0laRTtcbiAgY29uc3QgZXBvY2ggPSBvcHRzLmVwb2NoO1xuICBjb25zdCBidWZmZXI6IEFycmF5PEZyYW1lPFQ+PiA9IFtdO1xuICBjb25zdCBsaXN0ZW5lcnMgPSBuZXcgU2V0PChmcmFtZTogRnJhbWU8VD4pID0+IHZvaWQ+KCk7XG4gIGxldCBzZXEgPSAwO1xuXG4gIHJldHVybiB7XG4gICAgZXBvY2gsXG5cbiAgICBlbWl0KG1zZykge1xuICAgICAgc2VxICs9IDE7XG4gICAgICAvLyDim5QgVEhFIE1PTk9UT05JQyBJRCBXSU5TIE9WRVIgQU5ZVEhJTkcgSU4gVEhFIFBBWUxPQUQsIEFORCBVTlRJTCBOT1cgSVRcbiAgICAgIC8vIE9OTFkgQ0xBSU1FRCBUTy4gQm90aCBhZG9wdGluZyBkYWVtb25zIHdyb3RlIGB7IGlkOiArK3NlcSwgLi4ubXNnIH1gXG4gICAgICAvLyB1bmRlciBhIGNvbW1lbnQgc2F5aW5nIFwidGhlIG1vbm90b25pYyBgaWRgIE1VU1Qgd2luIG92ZXIgYW55IGBpZGAgaW5cbiAgICAgIC8vIHRoZSBwYXlsb2FkLCBzbyBjYWxsZXJzIGNhcnJ5IGEgcHJvamVjdCBpZGVudGlmaWVyIGFzIGBwcm9qZWN0SWRgLFxuICAgICAgLy8gbmV2ZXIgYGlkYFwiIOKAlCBidXQgc3ByZWFkIG9yZGVyIG1lYW5zIGEgcGF5bG9hZCBgaWRgIG92ZXJyb2RlIHRoZVxuICAgICAgLy8gY3Vyc29yLCBzaWxlbnRseSwgYW5kIHRoZSBjb252ZW50aW9uIGluIHRoZSBjb21tZW50IHdhcyB0aGUgb25seSB0aGluZ1xuICAgICAgLy8gaG9sZGluZyBpdC4gVGhlIGxpdGVyYWwga2VlcHMgYGlkYCBGSVJTVCBzbyB0aGUgd2lyZSBrZXkgb3JkZXIgaXNcbiAgICAgIC8vIHVuY2hhbmdlZDsgdGhlIGFzc2lnbm1lbnQgYWZ0ZXIgdGhlIHNwcmVhZCBpcyB3aGF0IG1ha2VzIHRoZSBzZW50ZW5jZVxuICAgICAgLy8gdHJ1ZS4gYGVwb2NoYCBpcyBzdGFtcGVkIHRoZSBzYW1lIHdheSBhbmQgZm9yIHRoZSBzYW1lIHJlYXNvbi5cbiAgICAgIGNvbnN0IGZyYW1lID0geyBpZDogc2VxLCAuLi5tc2cgfSBhcyBGcmFtZTxUPjtcbiAgICAgIGZyYW1lLmlkID0gc2VxO1xuICAgICAgaWYgKGVwb2NoICE9PSB1bmRlZmluZWQpIGZyYW1lLmVwb2NoID0gZXBvY2g7XG5cbiAgICAgIGJ1ZmZlci5wdXNoKGZyYW1lKTtcbiAgICAgIGlmIChidWZmZXIubGVuZ3RoID4gYnVmZmVyU2l6ZSkgYnVmZmVyLnNoaWZ0KCk7XG4gICAgICBmb3IgKGNvbnN0IGxpc3RlbmVyIG9mIGxpc3RlbmVycykgbGlzdGVuZXIoZnJhbWUpO1xuICAgICAgcmV0dXJuIGZyYW1lO1xuICAgIH0sXG5cbiAgICBzdWJzY3JpYmUoc2luY2UsIGxpc3RlbmVyKSB7XG4gICAgICAvLyBTZWUgdGhlIGhlYWRlciwgcG9pbnQgMzogYSBjdXJzb3IgYmV5b25kIG91ciBvd24gaXMgYSBjdXJzb3IgZnJvbSBhXG4gICAgICAvLyBQUklPUiBQUk9DRVNTLCBhbmQgdGhlIG9ubHkgdXNlZnVsIHJlYWRpbmcgb2YgaXQgaXMgXCJyZXBsYXkgd2hvbGVcIi5cbiAgICAgIC8vXG4gICAgICAvLyDimqAgQSBOT04tRklOSVRFIENVUlNPUiBBTFNPIE1FQU5TIFwiRlJPTSBUSEUgU1RBUlRcIiwgd2hpY2ggdGhlIGNvcGllcyBnb3RcbiAgICAgIC8vIHdyb25nIGJ5IGFjY2lkZW50OiB0aGV5IHdyb3RlIGBwYXJzZUludChwYXJhbSA/PyBcIi0xXCIpYCBhbmQgY29tcGFyZWRcbiAgICAgIC8vIGBpZCA+IHNpbmNlYCwgc28gYSB0eXBvJ2QgYD9zaW5jZT14YCBwcm9kdWNlZCBgTmFOYCwgZXZlcnkgY29tcGFyaXNvblxuICAgICAgLy8gd2FzIGZhbHNlLCBhbmQgdGhlIHRhaWwgb3BlbmVkIEVNUFRZIGFuZCBzdGF5ZWQgY29ubmVjdGVkIOKAlCB0aGUgc2FtZVxuICAgICAgLy8gc2lsZW50LWFuZC1jb25uZWN0ZWQgc3ltcHRvbSBhcyB0aGUgc3RhbGUgd2F0ZXJtYXJrLCBmcm9tIGEgZGlmZmVyZW50XG4gICAgICAvLyBjYXVzZS4gQWJzZW50IGFuZCB1bnBhcnNlYWJsZSBhcmUgdGhlIHNhbWUgcmVxdWVzdCBoZXJlLlxuICAgICAgY29uc3QgZnJvbSA9ICFOdW1iZXIuaXNGaW5pdGUoc2luY2UpIHx8IHNpbmNlID4gc2VxID8gLTEgOiBzaW5jZTtcbiAgICAgIGZvciAoY29uc3QgZnJhbWUgb2YgYnVmZmVyKSB7XG4gICAgICAgIGlmIChmcmFtZS5pZCA+IGZyb20pIGxpc3RlbmVyKGZyYW1lKTtcbiAgICAgIH1cbiAgICAgIGxpc3RlbmVycy5hZGQobGlzdGVuZXIpO1xuICAgICAgcmV0dXJuICgpID0+IHtcbiAgICAgICAgbGlzdGVuZXJzLmRlbGV0ZShsaXN0ZW5lcik7XG4gICAgICB9O1xuICAgIH0sXG5cbiAgICBjdXJzb3IoKSB7XG4gICAgICByZXR1cm4gc2VxO1xuICAgIH0sXG4gIH07XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGRhZW1vbiBsaWZlY3ljbGUgdGFpbDogdGhlIGlkbGUtY2xvc2UgZGVjaXNpb24sIHRoZSBzd2VlcFxuICogdGhhdCBtYWtlcyBpdCwgYW5kIHRoZSBib3VuZGVkIHRlYXJkb3duLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIGJvdW50eSDigJQgdGhlIGNlbnN1cydzXG4gKiBjb252ZXJnZW5jZSB0YXJnZXQgIzMg4oCUIHdpdGggYXN0cm9sYWJlJ3MgYHRpbWVvdXRNcyA+IDBgIGd1YXJkIGZvbGRlZCBpbixcbiAqIHdoaWNoIGlzIHRoZSBvbmUgdGhpbmcgYm91bnR5J3MgY29weSBkb2VzIG5vdCBleHByZXNzLlxuICovXG5cbmltcG9ydCB0eXBlIHsgU3NlQ2xpZW50cyB9IGZyb20gXCIuL3NzZS50c1wiO1xuXG4vKipcbiAqIFNob3VsZCB0aGUgZGFlbW9uIGlkbGUtY2xvc2U/XG4gKlxuICog4puUICoqYHN1YnNjcmliZXJDb3VudGAgSVMgQSBSRVFVSVJFRCBBUkdVTUVOVCwgQU5EIFRIQVQgSVMgVEhFIFdIT0xFIFBPSU5ULioqXG4gKiBUaGlzIGNsb3NlcyBjZW5zdXMgZGVmZWN0ICoqTDEqKiBieSBjb25zdHJ1Y3Rpb246IGdsYW1vdXIsIGltYWdvIGFuZCBtYWdwaWVcbiAqIGNvdW50ZWQgdGhlaXIgaWRsZSBmbG9vciBkb3duIHdoaWxlIGFuIGFnZW50IGhlbGQgYSB0YWlsIG9wZW4sIHNvIGFuIGFnZW50XG4gKiB3YXRjaGluZyBhIHF1aWV0IGJvYXJkIHdhcyBraWxsZWQgV0lUSCBJVFMgQ09OTkVDVElPTiBPUEVOLiBUaGVyZSBpcyBub1xuICogb3ZlcmxvYWQgb2YgdGhpcyBmdW5jdGlvbiB0aGF0IGNhbm5vdCBzZWUgaXRzIHN1YnNjcmliZXJzLCBzbyB0aGUgZGVmZWN0XG4gKiBjYW5ub3QgYmUgcmUtZXhwcmVzc2VkIGJ5IGEgY2FsbGVyIHdobyBmb3JnZXRzLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0NBUiBJVCBDQU1FIFdJVEgsIHJlLWhvbWVkIGZyb20gYm91bnR5IHZlcmJhdGltIGluIHN1YnN0YW5jZToqKlxuICogYSBib2FyZCBvbmx5IGNvdW50cyBpdHMgaWRsZSBmbG9vciBkb3duIHdoaWxlIFVOV0FUQ0hFRC4gQSBsaXZlIHN1YnNjcmliZXIg4oCUXG4gKiBhIGJyb3dzZXIgV2ViU29ja2V0LCBvciBhbiBhZ2VudCBTU0UgdGFpbCBvbiBgL2V2ZW50c2Ag4oCUIGtlZXBzIGl0IG9wZW5cbiAqIGluZGVmaW5pdGVseS4gU28gYHRpbWVvdXRgIG1lYW5zIFwibGluZ2VyIHRoaXMgbG9uZyBhZnRlciB0aGUgTEFTVCBzdWJzY3JpYmVyXG4gKiBsZWF2ZXNcIiwgTk9UIFwibWF4aW11bSBpZGxlIHdoaWxlIGNvbm5lY3RlZFwiLiBUaGUgc3dlZXAgYmVsb3cgYWxzbyB0b3VjaGVzIHRoZVxuICogYWN0aXZpdHkgY2xvY2sgb24gZXZlcnkgdGljayB3aGlsZSB3YXRjaGVkLCBzbyBvbmNlIHVud2F0Y2hlZCB0aGUgZmxvb3JcbiAqIGNvdW50cyBmcm9tIHRoYXQgbGFzdCBkaXNjb25uZWN0IGFuZCBub3QgZnJvbSB0aGUgbGFzdCByZXF1ZXN0LlxuICpcbiAqIOKaoCBgdGltZW91dE1zIDw9IDBgIG1lYW5zIE5FVkVSLCB3aGljaCBpcyBhc3Ryb2xhYmUncyBzdGFuZGluZy1vYnNlcnZhdG9yeVxuICogZGVmYXVsdCBhbmQgaXMgd2h5IHRoZSBndWFyZCBpcyBoZXJlIHJhdGhlciB0aGFuIGF0IGl0cyBvbmUgY2FsbCBzaXRlOiBhXG4gKiBzaW5nbGV0b24gZGFlbW9uIGlzIG1lYW50IHRvIHN0YW5kIHVudGlsIGl0IGlzIGV4cGxpY2l0bHkgY2xvc2VkLCBhbmQgYVxuICogYD49IDBgIGNvbXBhcmlzb24gd291bGQgY2xvc2UgaXQgb24gdGhlIGZpcnN0IHRpY2suXG4gKlxuICogQ2xvY2stZnJlZSBhbmQgZnMtZnJlZSwgc28gaXQgaXMgdGVzdGFibGUgd2l0aG91dCBhIGRhZW1vbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZElkbGVDbG9zZShcbiAgc3Vic2NyaWJlckNvdW50OiBudW1iZXIsXG4gIGlkbGVNczogbnVtYmVyLFxuICB0aW1lb3V0TXM6IG51bWJlcixcbik6IGJvb2xlYW4ge1xuICBpZiAodGltZW91dE1zIDw9IDApIHJldHVybiBmYWxzZTtcbiAgaWYgKHN1YnNjcmliZXJDb3VudCA+IDApIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGlkbGVNcyA+PSB0aW1lb3V0TXM7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSG91c2VrZWVwaW5nT3B0aW9ucyB7XG4gIC8qKiDim5QgUkVRVUlSRUQuIFNlZSBgc2hvdWxkSWRsZUNsb3NlYCDigJQgdGhpcyBpcyB3aGF0IGNsb3NlcyBMMS4gKi9cbiAgc3Vic2NyaWJlckNvdW50OiAoKSA9PiBudW1iZXI7XG4gIC8qKiBNaWxsaXNlY29uZHMgc2luY2UgdGhlIGxhc3QgYWN0aXZpdHkuICovXG4gIGlkbGVNczogKCkgPT4gbnVtYmVyO1xuICAvKiogUmVzZXQgdGhlIGFjdGl2aXR5IGNsb2NrLiBDYWxsZWQgb24gZXZlcnkgdGljayB0aGF0IGhhcyBhIHN1YnNjcmliZXIuICovXG4gIHRvdWNoOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGNvbmZpZ3VyZWQgaWRsZSB0aW1lb3V0IGluIG1zOyBgMGAgKG9yIGxlc3MpIG1lYW5zIG5ldmVyLiAqL1xuICB0aW1lb3V0TXM6IG51bWJlcjtcbiAgLyoqIEZpcmVkIG9uY2Ugd2hlbiB0aGUgZGFlbW9uIHNob3VsZCBjbG9zZSBpdHNlbGYuICovXG4gIG9uSWRsZUNsb3NlOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGRlYm91bmNlZCBzbmFwc2hvdCwgaWYgdGhlIHNwZWxsIGhhcyBvbmUuICovXG4gIHNuYXBzaG90Pzoge1xuICAgIGRpcnR5OiAoKSA9PiBib29sZWFuO1xuICAgIGNsZWFyOiAoKSA9PiB2b2lkO1xuICAgIHdyaXRlOiAoKSA9PiB2b2lkIHwgUHJvbWlzZTx2b2lkPjtcbiAgfTtcbiAgLyoqIFN3ZWVwIGludGVydmFsOyBib3RoIGFkb3B0aW5nIGRhZW1vbnMgdXNlZCAyNTAgbXMuICovXG4gIHRpY2tNcz86IG51bWJlcjtcbiAgLyoqIFNuYXBzaG90IGludGVydmFsOyBib3RoIGFkb3B0aW5nIGRhZW1vbnMgdXNlZCAxMDAwIG1zLiAqL1xuICBzbmFwc2hvdE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFN0YXJ0IHRoZSB0d28gc3RhbmRpbmcgdGltZXJzIGV2ZXJ5IHNlc3Npb24gZGFlbW9uIHJ1bnMg4oCUIHRoZSBpZGxlIHN3ZWVwIGFuZFxuICogdGhlIGRlYm91bmNlZCBzbmFwc2hvdCDigJQgYW5kIHJldHVybiB0aGUgZnVuY3Rpb24gdGhhdCBzdG9wcyBib3RoLlxuICpcbiAqIFRoZXkgYXJlIE9ORSBjYWxsIGJlY2F1c2UgdGhleSBoYXZlIGFsd2F5cyBiZWVuIG9uZSBsaWZldGltZTogZXZlcnkgY29weVxuICogY2xlYXJlZCBib3RoIGluIHRoZSBzYW1lIHR3byBsaW5lcyBhZnRlciBgYXdhaXQgZG9uZWAsIGFuZCB0aGUgcGFpciB0aGF0IGdldHNcbiAqIGZvcmdvdHRlbiBpcyB0aGUgcGFpciB3aG9zZSB0aW1lcnMga2VlcCBhIHByb2Nlc3MgYWxpdmUgYWZ0ZXIgdGVhcmRvd24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFydEhvdXNla2VlcGluZyhvcHRzOiBIb3VzZWtlZXBpbmdPcHRpb25zKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHRpY2tNcyA9IG9wdHMudGlja01zID8/IDI1MDtcbiAgY29uc3Qgc25hcHNob3RNcyA9IG9wdHMuc25hcHNob3RNcyA/PyAxMDAwO1xuXG4gIGNvbnN0IGlkbGVUaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICBjb25zdCBzdWJzY3JpYmVycyA9IG9wdHMuc3Vic2NyaWJlckNvdW50KCk7XG4gICAgaWYgKHN1YnNjcmliZXJzID4gMCkgb3B0cy50b3VjaCgpO1xuICAgIGlmIChzaG91bGRJZGxlQ2xvc2Uoc3Vic2NyaWJlcnMsIG9wdHMuaWRsZU1zKCksIG9wdHMudGltZW91dE1zKSkgb3B0cy5vbklkbGVDbG9zZSgpO1xuICB9LCB0aWNrTXMpO1xuXG4gIGNvbnN0IHNuYXAgPSBvcHRzLnNuYXBzaG90O1xuICBjb25zdCBzbmFwVGltZXIgPSBzbmFwXG4gICAgPyBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICAgIGlmICghc25hcC5kaXJ0eSgpKSByZXR1cm47XG4gICAgICAgIHNuYXAuY2xlYXIoKTtcbiAgICAgICAgdm9pZCBzbmFwLndyaXRlKCk7XG4gICAgICB9LCBzbmFwc2hvdE1zKVxuICAgIDogbnVsbDtcblxuICByZXR1cm4gKCkgPT4ge1xuICAgIGNsZWFySW50ZXJ2YWwoaWRsZVRpbWVyKTtcbiAgICBpZiAoc25hcFRpbWVyICE9PSBudWxsKSBjbGVhckludGVydmFsKHNuYXBUaW1lcik7XG4gIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRHJhaW5PcHRpb25zIHtcbiAgLyoqIFRoZSBib3VuZCBzZXJ2ZXIuIFR5cGVkIHN0cnVjdHVyYWxseSBzbyB0aGUga2l0IHN0YXlzIGZyZWUgb2YgYGJ1bmAuICovXG4gIHNlcnZlcjogeyBzdG9wKGNsb3NlQWN0aXZlQ29ubmVjdGlvbnM/OiBib29sZWFuKTogdW5rbm93biB9O1xuICAvKiogTGl2ZSBTU0UgdGFpbHM7IGV2ZXJ5IHJlZ2lzdGVyZWQgY2xvc2VyIGlzIGludm9rZWQuICovXG4gIGNsaWVudHM/OiBTc2VDbGllbnRzO1xuICAvKiogTGl2ZSBXZWJTb2NrZXRzLiAqL1xuICBzb2NrZXRzPzogSXRlcmFibGU8eyBjbG9zZSgpOiB2b2lkIH0+O1xuICAvKiogSG93IGxvbmcgcXVldWVkIGZyYW1lcyBnZXQgdG8gZmx1c2ggYmVmb3JlIGFueXRoaW5nIGlzIGNsb3NlZC4gKi9cbiAgZ3JhY2VNcz86IG51bWJlcjtcbiAgLyoqIEhvdyBsb25nIHRoZSBncmFjZWZ1bCBzdG9wIGdldHMgYmVmb3JlIHRlYXJkb3duIHByb2NlZWRzIHJlZ2FyZGxlc3MuICovXG4gIHN0b3BNcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBDbG9zZSBldmVyeSBoZWxkIGNvbm5lY3Rpb24gYW5kIHN0b3AgdGhlIHNlcnZlciwgaW4gYm91bmRlZCB0aW1lLlxuICpcbiAqIOKblCAqKlRIRSBHUkFDRSBQRVJJT0QgSVMgTk9UIFBPTElURU5FU1MuKiogQSBgY2xvc2VkYCBmcmFtZSBlbWl0dGVkIGFuZCB0aGVuXG4gKiBmb2xsb3dlZCBpbW1lZGlhdGVseSBieSBhbiBhZ2dyZXNzaXZlIGBzZXJ2ZXIuc3RvcCh0cnVlKWAgaXMgYSBmcmFtZSB0aGVcbiAqIGNsaWVudCBuZXZlciBzZWVzIOKAlCB0aGUgcXVldWUgZ29lcyB3aXRoIHRoZSBzb2NrZXQuIFRoZSAxNTAgbXMgaXMgd2hhdCB0dXJuc1xuICogXCJ0aGUgZGFlbW9uIHRvbGQgeW91IHdoeSBpdCBkaWVkXCIgZnJvbSBhIGhvcGUgaW50byBhbiBvYnNlcnZhdGlvbiwgYW5kIGV2ZXJ5XG4gKiBvbmUgb2YgdGhlIGVpZ2h0IGRhZW1vbnMgY29udmVyZ2VkIG9uIHRoYXQgbnVtYmVyIGluZGVwZW5kZW50bHkuXG4gKlxuICog4puUICoqQU5EIFRIRSBTVE9QIElTIFJBQ0VELCBCRUNBVVNFIEEgU0xPVyBTT0NLRVQgTVVTVCBOT1QgQkUgQUJMRSBUTyBIQU5HXG4gKiBURUFSRE9XTi4qKiBgc2VydmVyLnN0b3AodHJ1ZSlgIGF3YWl0cyBpdHMgY29ubmVjdGlvbnM7IG9uZSB3ZWRnZWQgcGVlciBpc1xuICogZW5vdWdoIHRvIHBhcmsgaXQgZm9yZXZlciwgd2hpY2ggaXMgaG93IGEgMjMtbWludXRlIGhhbmcgc2hpcHBlZCBvbmNlLlxuICpcbiAqIOKaoCAqKldIQVQgSVMgREVMSUJFUkFURUxZIE5PVCBIRVJFOiBib3VudHkncyBzaHV0ZG93biB3YXRjaGRvZy4qKiBCb3VudHkgYXJtc1xuICogYSBSRUYnZCBgc2V0VGltZW91dGAgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBpZiB0ZWFyZG93biBkb2VzIG5vdCBmaW5pc2gsXG4gKiBhbmQgdGhlIGNlbnN1cyBpcyByaWdodCB0aGF0IGl0IGlzIHRoZSBjb3JwdXMncyBvbmx5IHVuY29uZGl0aW9uYWxcbiAqIHRlcm1pbmF0aW9uIGd1YXJhbnRlZS4gSXQgYmVsb25ncyB0byBib3VudHkncyBURUFSRE9XTiDigJQgdGhlIHN0cmV0Y2ggd2hlcmVcbiAqIG5vdGhpbmcgYm91bmRzIHdoYXQgaXMgYmVpbmcgd2FpdGVkIG9uLiDim5QgKipUSElTIFBBUkFHUkFQSCBTQUlEIFwiU0lHTkFMXG4gKiBQQVRIXCIgVU5USUwgRDUzLCBBTkQgVEhFIENPREUgQUdSRUVEIFdJVEggSVQsIFdISUNIIFdBUyBUSEUgREVGRUNULioqIEJvdW50eVxuICogaGFzIEZPVVIgd2F5cyBpbnRvIG9uZSB0ZWFyZG93biAoYSBzaWduYWwsIGEgYGNsb3NlYCB2ZXJiLCB0aGUgYnJvd3NlcidzXG4gKiBjbG9zZSBvdmVyIHRoZSBXZWJTb2NrZXQsIGFuIGlkbGUgdGltZW91dCkgYW5kIG9ubHkgdGhlIHNpZ25hbCBvbmUgYXJtZWQgdGhlXG4gKiB0aW1lciwgd2hpbGUgdGhlIGNvbW1lbnQgYWJvdmUgaXQgY2xhaW1lZCB0aGUgZW5kaW5nIHdhcyB1bmNvbmRpdGlvbmFsLlxuICogRHJpdmVuIHdpdGggYSBwbGFudGVkIGhhbmc6IHRoZSBvdGhlciB0aHJlZSByYW4gcGFzdCAxMCBzLCB0aGUgaWRsZSBvbmVcbiAqIGluY2x1ZGVkIOKAlCB0aGUgb3JwaGFuLWRhZW1vbiBjbGFzcyB0aGUgMjMtbWludXRlIGhhbmcgY2FtZSBmcm9tLiBUaGUgYXJtaW5nXG4gKiBub3cgbGl2ZXMgaW4gdGhlIFJFU09MVkUgdGhhdCBhbGwgZm91ciBlbnRyaWVzIHBhc3MgdGhyb3VnaC4gKipUaGUgbGVzc29uIGZvclxuICogYW4gYWRvcHRlciBpcyB0aGUgY291bnQsIG5vdCB0aGUgcGxhY2VtZW50OiBlbnVtZXJhdGUgZXZlcnkgZW50cnkgaW50byB0aGVcbiAqIHRlYXJkb3duIGJlZm9yZSB5b3UgYmVsaWV2ZSBhIGd1YXJhbnRlZSBjb3ZlcnMgaXQuKiogVGhlIHR3b1xuICogZGFlbW9ucyBhZG9wdGluZyB0aGlzIG1vZHVsZSByZWdpc3RlciBubyBzaWduYWwgaGFuZGxlcnMsIGFuZCB0aGVpciB3aG9sZVxuICogdGVhcmRvd24gaXMgYm91bmRlZCBieSB0aGUgdHdvIG51bWJlcnMgYWJvdmU7IGFkZGluZyBhbiBleGl0IGhlcmUgd291bGQgcHV0XG4gKiB0aGUgaG91c2UncyBvbmx5IHVuY29uZGl0aW9uYWwgYHByb2Nlc3MuZXhpdGAgaW5zaWRlIGEgbW9kdWxlIGV2ZXJ5IHNwZWxsIGlzXG4gKiBhYm91dCB0byBidW5kbGUsIG9uZSBwaGFzZSBhZnRlciBEOCB0b29rIGV4YWN0bHkgdGhhdCBoYXphcmQgT1VUIG9mIGBkaWVgLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VOVEVOQ0UgVEhBVCBVU0VEIFRPIEVORCBUSEFUIFBBUkFHUkFQSCBXQVMgQSBQUkVESUNUSU9OLCBXSElDSFxuICogQk9VTlRZJ1MgT1dOIFBPUlQgRkFMU0lGSUVELioqIEl0IHJlYWQ6IFwid2hlbiBhIHNwZWxsIHdpdGggYSBzaWduYWwgcGF0aFxuICogYWRvcHRzIHRoaXMsIHRoZSB3YXRjaGRvZyBhcnJpdmVzIGFzIGFuIG9wdGlvbiBvbiB0aGVzZSBhcmd1bWVudHMgYW5kIHRoZVxuICogcmVhc29uaW5nIGlzIGFscmVhZHkgd3JpdHRlbiBkb3duLlwiIGJvdW50eSBhZG9wdGVkIGBkcmFpbkFuZFN0b3BgIG9uXG4gKiAyMDI2LTA5LTA5IChQaGFzZSA0KSBhbmQgdGhlIG9wdGlvbiB3YXMgTk9UIGFkZGVkLCBiZWNhdXNlIHRoZSB3aW5kb3cgaXNcbiAqIHdyb25nLiAqKkEgYHdhdGNoZG9nTXNgIG9uIHRoZXNlIGFyZ3VtZW50cyB3b3VsZCBhcm0gYXQgRFJBSU4gdGltZTsgYm91bnR5J3NcbiAqIGFybXMgYXQgU0lHTkFMIHRpbWUqKiwgYW5kIHRoZSB3aG9sZSByZWFzb24gaXQgZXhpc3RzIGlzIHRoZSBzdHJldGNoIEJFVFdFRU5cbiAqIHRob3NlIHR3byBwb2ludHMg4oCUIGBhd2FpdCBkb25lYCwgYW4gZnMgYXBwZW5kIHRvIHRoZSBkYWVtb24gbG9nLCBhIGZ1bGxcbiAqIHNuYXBzaG90IHdyaXRlIHRoYXQgY2FuIHJvdGF0ZSBhbmQgQ09QWSBhIGJhY2t1cCBvZiBhIGxhcmdlIGJvYXJkLCBhIGBjbG9zZWRgXG4gKiBmcmFtZSBhbmQgYSBicm9hZGNhc3QuIGBkcmFpbkFuZFN0b3BgJ3Mgb3duIGJvZHkgaXMgYWxyZWFkeSBib3VuZGVkIGJ5IHRoZSB0d29cbiAqIG51bWJlcnMgYWJvdmUsIHNvIGEgd2F0Y2hkb2cgc2NvcGVkIHRvIGl0IHdvdWxkIGd1YXJkIHRoZSBvbmUgc3RyZXRjaCB0aGF0XG4gKiBjYW5ub3QgaGFuZyBhbmQgYWJhbmRvbiB0aGUgc3RyZXRjaCB0aGF0IGNhbjogaXQgd291bGQgUkVBRCBhcyBhZG9wdGlvbiBhbmRcbiAqIEJFIGEgbmFycm93aW5nIG9mIHRoZSBjb3JwdXMncyBvbmx5IHVuY29uZGl0aW9uYWwgdGVybWluYXRpb24gZ3VhcmFudGVlLiBUaGVcbiAqIDIzLW1pbnV0ZSBoYW5nIHRoaXMgcHJvamVjdCBrZWVwcyBjaXRpbmcgaGFwcGVuZWQgaW4gdGhlIHVuYm91bmRlZCBzdHJldGNoLlxuICpcbiAqIOKaoCAqKlNPIFRIRSBSVUxFIEZPUiBUSEUgTkVYVCBTUEVMTCwgV0hJQ0ggSVMgVEhFIFRSQU5TRkVSQUJMRSBIQUxGOioqIHRoZVxuICogcXVlc3Rpb24gaXMgbmV2ZXIgXCJkb2VzIHRoaXMgbW9kdWxlIGhhdmUgYSBwbGFjZSB0byBwdXQgYSB3YXRjaGRvZ1wiIGJ1dFxuICogXCJkb2VzIHRoZSB3YXRjaGRvZydzIHdpbmRvdyBjb2luY2lkZSB3aXRoIHRoaXMgbW9kdWxlJ3NcIi4gV2hlcmUgYSBzcGVsbCdzXG4gKiB0ZWFyZG93biBoYXMgdW5ib3VuZGVkIHdvcmsgQkVGT1JFIHRoZSBkcmFpbiwgdGhlIHdhdGNoZG9nIGJlbG9uZ3MgYXQgdGhlXG4gKiBzcGVsbCwgd3JhcHBlZCBhcm91bmQgYWxsIG9mIGl0IOKAlCBhbmQgYXJvdW5kIEVWRVJZIFdBWSBJTiwgd2hpY2ggaXMgdGhlIGhhbGZcbiAqIEQ1MyBoYWQgdG8gcmVwYWlyIGFmdGVyIHRoaXMgaGVhZGVyIHdhcyB3cml0dGVuLiBJZiBhIHNwZWxsIGV2ZXIgYXBwZWFycyB3aG9zZSBzaWduYWwgcGF0aFxuICogZW50ZXJzIGBkcmFpbkFuZFN0b3BgIGltbWVkaWF0ZWx5LCBhZGQgdGhlIG9wdGlvbiBUSEVOIOKAlCBhbmQgdGhlIG9wdGlvbiBtdXN0XG4gKiB0YWtlIGFuIGBvbkV4cGlyZWAgY2FsbGJhY2sgcmF0aGVyIHRoYW4gZXhpdGluZywgc28gdGhlIGBwcm9jZXNzLmV4aXRgIHN0YXlzXG4gKiBvdXRzaWRlIGEgbW9kdWxlIGV2ZXJ5IHNwZWxsIGJ1bmRsZXMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkcmFpbkFuZFN0b3Aob3B0czogRHJhaW5PcHRpb25zKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGdyYWNlTXMgPSBvcHRzLmdyYWNlTXMgPz8gMTUwO1xuICBjb25zdCBzdG9wTXMgPSBvcHRzLnN0b3BNcyA/PyAyMDA7XG5cbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgZ3JhY2VNcykpO1xuXG4gIGlmIChvcHRzLmNsaWVudHMpIHtcbiAgICBmb3IgKGNvbnN0IGNsaWVudCBvZiBbLi4ub3B0cy5jbGllbnRzXSkgY2xpZW50LmNsb3NlKCk7XG4gIH1cbiAgaWYgKG9wdHMuc29ja2V0cykge1xuICAgIGZvciAoY29uc3Qgd3Mgb2YgWy4uLm9wdHMuc29ja2V0c10pIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLmNsb3NlKCk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICBQcm9taXNlLnJlc29sdmUob3B0cy5zZXJ2ZXIuc3RvcCh0cnVlKSksXG4gICAgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgc3RvcE1zKSksXG4gIF0pO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBhc3NldC1zZXJ2aW5nIHRyaW8gZm9yIGEgc3BlbGwgZGFlbW9uOiB3aGljaCBzdXJmYWNlIG1vZGUgd2VcbiAqIGFyZSBpbiwgd2hhdCBjb250ZW50IHR5cGUgYSBmaWxlIGdldHMsIGFuZCBob3cgYSBmaWxlIHVuZGVyIGBkaXN0L2AgaXNcbiAqIGFuc3dlcmVkLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIGFuZCB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3MgYXJ0aWZhY3QuXG4gKlxuICogRXh0cmFjdGVkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgZnJvbSB0aGUgZWlnaHQgYEJ1bi5zZXJ2ZWAgYmFja2VuZHNcbiAqIGNlbnN1c2VkIGluIGBkb2NzL2ludmVzdGlnYXRpb25zLzIwMjYtMDktMDgtZGFlbW9uLXNwaW5lLWNlbnN1cy5tZGAsIHdoaWNoXG4gKiBtZWFzdXJlZCBgcmVzb2x2ZU1vZGVgIGFzIGJ5dGUtaWRlbnRpY2FsIGluIGFsbCBlaWdodCAodGhlIG9ubHkgbWQ1IGRpZmZlcmVuY2VcbiAqIGJlaW5nIHRoZSBgZXhwb3J0YCBrZXl3b3JkKSwgdGhlIGNvbnRlbnQtdHlwZSBtYXAgYXMgZGlmZmVyaW5nIGluIGV4YWN0bHlcbiAqIG9uZSBjZWxsLCBhbmQgdGhlIGZpbGUgaGFsZiBvZiBgc2VydmVEaXN0YCBhcyBpZGVudGljYWwgaW4gZml2ZS5cbiAqXG4gKiDilIDilIAgV0hBVCBERUxJQkVSQVRFTFkgRElEIE5PVCBDT01FIEFMT05HIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICoqVGhlIFVSTC10by1maWxlbmFtZSBtYXBwaW5nIHN0YXlzIGluIGVhY2ggcm91dGVyLioqIFRoZSBjZW5zdXMgbWFya2VkIHR3b1xuICogb2YgdGhlIGVpZ2h0IGBzZXJ2ZURpc3RgIGRpdmVyZ2VuY2VzIERFTElCRVJBVEUgYW5kIGJvdGggbGl2ZSBpbiB0aGF0IGhhbGY6XG4gKiBkaWdlc3RpZnkgc3Vic3RpdHV0ZXMgaW50byB0aGUgZW50cnkgSFRNTCBpbiBtZW1vcnksIGFuZCBncmFwZXZpbmUgc2VydmVzIGl0c1xuICogc3VyZmFjZSBhdCBgL3dhdGNoYCByYXRoZXIgdGhhbiBhdCBgL2AuIEEgc2lnbmF0dXJlIHdpZGUgZW5vdWdoIHRvIGFic29yYlxuICogdGhvc2Ugc3RvcHMgYmVpbmcgYSBmaWxlIHNlcnZlciBhbmQgYmVjb21lcyBhIHJvdXRlci4gU28gdGhlIGNhbGxlciBkZWNpZGVzXG4gKiBXSElDSCBmaWxlIChgcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSlgKSwgYW5kIHRoaXMgbW9kdWxlXG4gKiBkZWNpZGVzIHdoZXRoZXIgdGhhdCBmaWxlIG1heSBiZSByZWFkIGFuZCB3aGF0IGl0IGlzIHNlcnZlZCBhcy5cbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbi8qKlxuICogUmVsZWFzZSBpZmYgYDxkaXN0RGlyPi9pbmRleC5odG1sYCBleGlzdHM7IGVsc2UgZGV2LiBUaGUgZW52IG92ZXJyaWRlXG4gKiAoYFNQRUxMQk9PS19TVVJGQUNFX01PREVgKSB3aW5zIGVpdGhlciB3YXkg4oCUIHNlYW1zIENvbnRyYWN0IDEuXG4gKlxuICog4puUICoqVEhFIEZJTEUsIE5FVkVSIFRIRSBESVJFQ1RPUlksIEFORCBUSEFUIElTIEEgU0NBUiBOT1QgQSBTVFlMRSBDSE9JQ0UuKipcbiAqIFJlLWhvbWVkIGZyb20gYm91bnR5IGFuZCBtYWdwaWUsIHdoaWNoIGVhcm5lZCBpdCBpbmRlcGVuZGVudGx5OlxuICpcbiAqIC0gbWFncGllJ3MgYGRpc3QvYCBBTFJFQURZIEVYSVNURUQgaG9sZGluZyBgY2xpLmpzYCBhbmQgbm8gYGluZGV4Lmh0bWxgLFxuICogICB3aGljaCBpcyBwcmVjaXNlbHkgd2h5IGl0cyBkYWVtb24gc3RheWVkIGNvcnJlY3RseSBpbiBERVYgbW9kZSB0aHJvdWdoIHRoZVxuICogICB3aG9sZSBvZiBTbGljZSAyLiBgZGlzdC9gIGV4aXN0aW5nIGlzIG5vdCB0aGUgZGlzY3JpbWluYXRvci5cbiAqIC0gYm91bnR5IHNheXMgdGhlIHNhbWUgdGhpbmcgZnJvbSB0aGUgb3RoZXIgc2lkZTogYSBidWlsdCBCQUNLRU5EIHB1dHNcbiAqICAgYGNsaS5qc2AgKGFuZCBub3cgYHNlcnZlci5qc2ApIGluIGBkaXN0L2Agd2l0aCBubyBzdXJmYWNlIGFueXdoZXJlIG5lYXIgaXQuXG4gKlxuICog4pqgICoqQU5EIFRIRSBQUkVESUNBVEUgSVMgQU4gVU5IQVNIRUQgRklMRU5BTUUsIFdISUNIIElTIEEgU1RBTkRJTkdcbiAqIEFTU1VNUFRJT04gQUJPVVQgVEhFIFNVUkZBQ0UgQlVJTEQuKiogUmVsZWFzZSBtb2RlIGlzIGNob3NlbiBieSBPTkUgbGl0ZXJhbFxuICogbmFtZS4gQSBzdXJmYWNlIGJ1aWxkIHRoYXQgZXZlciBlbWl0dGVkIGEgY29udGVudC1oYXNoZWQgZW50cnkgZG9jdW1lbnQgd291bGRcbiAqIGxlYXZlIG5vIGBpbmRleC5odG1sYCBoZXJlLCBldmVyeSBkYWVtb24gd291bGQgc2lsZW50bHkgcmVzb2x2ZSBERVYsIGFuZCB0aGVcbiAqIG9ubHkgc3ltcHRvbSBhbnlvbmUgY2FuIHNlZSBpcyB0aGUgYG1vZGVgIGZpZWxkIG9uIGEgaGFuZHNoYWtlIG5vYm9keSByZWFkcyBpblxuICogYW5nZXIuIGBzcmMvYnVpbGQudHNgIGVtaXRzIHRoZSBlbnRyeSB1bmhhc2hlZCB0b2RheSAob25seSB0aGUgSlMgYW5kIENTU1xuICogY2h1bmtzIGNhcnJ5IGhhc2hlcykgYW5kIENvbnRyYWN0IDIgcGlucyB0aGF0IGZsYXQgbGF5b3V0OyB0aGlzIGNvbW1lbnQgaXNcbiAqIHRoZSBub3RlIHRoYXQgc2F5cyB3aGF0IHRoZSBwaW4gaXMgbG9hZC1iZWFyaW5nIEZPUi5cbiAqXG4gKiDimqAgTm90aGluZyBhbm5vdW5jZXMgdGhlIGZsaXAgZnJvbSBkZXYgdG8gcmVsZWFzZSBlaXRoZXI6IHRoZSBmaXJzdCBzdXJmYWNlXG4gKiBidWlsZCB0byBsYW5kIGFuIGBpbmRleC5odG1sYCBiZXNpZGUgYSBkYWVtb24gZmxpcHMgaXQsIHNpbGVudGx5LCBvbiB0aGUgbmV4dFxuICogYm9vdC4gVGhhdCBpcyB3aHkgYG1vZGVgIHJpZGVzIHRoZSByZWFkeSBmcmFtZSDigJQgd2l0aCByb290IGRlcHMgcHJlc2VudCBhIGRldlxuICogZGFlbW9uIHJlbmRlcnMgYW4gaWRlbnRpY2FsLWxvb2tpbmcgc3VyZmFjZSwgc28gXCJpdCBsb29rcyByaWdodFwiIGNhbm5vdFxuICogdmVyaWZ5IENvbnRyYWN0IDEuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9kZShkaXN0RGlyOiBzdHJpbmcpOiBcImRldlwiIHwgXCJyZWxlYXNlXCIge1xuICBjb25zdCBvdmVycmlkZSA9IHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREU7XG4gIGlmIChvdmVycmlkZSA9PT0gXCJkZXZcIiB8fCBvdmVycmlkZSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBvdmVycmlkZTtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihkaXN0RGlyLCBcImluZGV4Lmh0bWxcIikpID8gXCJyZWxlYXNlXCIgOiBcImRldlwiO1xufVxuXG4vKipcbiAqIFRoZSBjb250ZW50IHR5cGVzIGEgYnVpbHQgc3VyZmFjZSBhY3R1YWxseSBzaGlwcy4gRXh0ZW5zaW9ucyBvdXRzaWRlIHRoZVxuICogbWFwIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYCDigJQgYSBkZWxpYmVyYXRlIHJlZnVzYWwgdG8gZ3Vlc3MsIHNpbmNlXG4gKiBhbnl0aGluZyBub3QgaW4gdGhpcyBsaXN0IGlzIG5vdCBzb21ldGhpbmcgQ29udHJhY3QgMidzIGJ1aWxkIGVtaXRzLlxuICpcbiAqIOKaoCAqKmBjaGFyc2V0PXV0Zi04YCBPTiBIVE1MIElTIFRIRSBDRU5TVVMnUyBPTkUgRElWRVJHRU5DRSwgUkVTT0xWRUQgVE9XQVJEXG4gKiBUSEUgQ09SUkVDVCBDT1BZLioqIFRocmVlIG9mIHRoZSBlaWdodCBkYWVtb25zIGNhcnJpZWQgaXQgYW5kIGZpdmUgZGlkIG5vdDtcbiAqIHRoZSBjZW5zdXMgZ3JhZGVkIHRoYXQgYHN0YWxlYCB3aXRoIHplcm8gZGVzaWduIGNvbnRlbnQuIEl0IGlzIGtlcHQgYmVjYXVzZVxuICogaXQgaXMgdGhlIHJpZ2h0IGFuc3dlciDigJQgYW4gSFRNTCBkb2N1bWVudCBzZXJ2ZWQgd2l0aCBubyBjaGFyc2V0IGlzIGRlY29kZWRcbiAqIGJ5IHRoZSBicm93c2VyJ3MgZ3Vlc3Mg4oCUIGFuZCBpdCBpcyB0aGUgb25lIHdpcmUtb2JzZXJ2YWJsZSBjaGFuZ2UgdGhpc1xuICogY29udmVyZ2VuY2UgbWFrZXMgdG8gYSByZXNwb25zZSBoZWFkZXIuIFJlY29yZGVkIGFzIEQtbm90ZSBpbiB0aGUgcGhhc2UgbG9nXG4gKiByYXRoZXIgdGhhbiBzbXVnZ2xlZC5cbiAqL1xuY29uc3QgU1RBVElDX0NPTlRFTlRfVFlQRVM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiLmh0bWxcIjogXCJ0ZXh0L2h0bWw7IGNoYXJzZXQ9dXRmLThcIixcbiAgXCIuanNcIjogXCJ0ZXh0L2phdmFzY3JpcHRcIixcbiAgXCIuY3NzXCI6IFwidGV4dC9jc3NcIixcbiAgXCIuanNvblwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbn07XG5cbi8qKiBUaGUgY29udGVudCB0eXBlIGZvciBhIGZpbGVuYW1lIG9yIGFuIGV4dGVuc2lvbi4gVW5rbm93biBleHRlbnNpb25zLCBhbmRcbiAqICBuYW1lcyB3aXRoIG5vIGV4dGVuc2lvbiBhdCBhbGwsIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb250ZW50VHlwZUZvcihuYW1lT3JFeHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGRvdCA9IG5hbWVPckV4dC5sYXN0SW5kZXhPZihcIi5cIik7XG4gIGNvbnN0IGV4dCA9IGRvdCA9PT0gLTEgPyBcIlwiIDogbmFtZU9yRXh0LnNsaWNlKGRvdCk7XG4gIHJldHVybiBTVEFUSUNfQ09OVEVOVF9UWVBFU1tleHRdID8/IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCI7XG59XG5cbi8qKlxuICogQW5zd2VyIE9ORSBmaWxlIGZyb20gYGRpc3REaXJgLCBvciBgbnVsbGAgaWYgdGhlIGNhbGxlciBzaG91bGQga2VlcCByb3V0aW5nLlxuICpcbiAqIGByZWxgIGlzIGEgYmFyZSBmaWxlbmFtZSDigJQgdGhlIGVudHJ5IGRvY3VtZW50IG9yIG9uZSBoYXNoZWQgY2h1bmsuIENvbnRyYWN0XG4gKiAyJ3MgYnVpbHQgc3VyZmFjZSBpcyBGTEFUIGFuZCBsaW5rcyBpdHMgY2h1bmtzIHJlbGF0aXZlbHksIHNvIGEgbGVnaXRpbWF0ZVxuICogYXNzZXQgcmVxdWVzdCBpcyBuZXZlciBuZXN0ZWQgYW5kIG5ldmVyIGNvbnRhaW5zIGAuLmA7IGJvdGggYXJlIHJlZnVzZWRcbiAqIGhlcmUgcmF0aGVyIHRoYW4gaW4gdGhlIHJvdXRlciwgYmVjYXVzZSB0aGUgZ3VhcmQgcHJvdGVjdHMgdGhlIHJlYWQgYW5kIHRoZVxuICogcmVhZCBpcyB3aGF0IGxpdmVzIGluIHRoaXMgZmlsZS5cbiAqXG4gKiDimqAgVGhlIHJlZnVzYWwgaXMgYWxzbyB3aGF0IGtlZXBzIGFuIGFzc2V0IHNlcnZlIGNsZWFyIG9mIGEgc3BlbGwncyBvd25cbiAqIHJvdXRlczogbWFncGllIGhhcyBhbiBgL2Fzc2V0cy88bmFtZT5gIHJvdXRlIG9uZSBsZXZlbCBkZWVwLCBhbmQgdGhpc1xuICogcmV0dXJuaW5nIGBudWxsYCBvbiBhbnl0aGluZyB3aXRoIGEgc2xhc2ggaW4gaXQgaXMgd2hhdCBzdG9wcyB0aGUgdHdvXG4gKiBmaWdodGluZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlcnZlRnJvbURpc3QoZGlzdERpcjogc3RyaW5nLCByZWw6IHN0cmluZyk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIGlmICghcmVsIHx8IHJlbC5pbmNsdWRlcyhcIi4uXCIpIHx8IHJlbC5pbmNsdWRlcyhcIi9cIikpIHJldHVybiBudWxsO1xuICBjb25zdCBmaWxlID0gam9pbihkaXN0RGlyLCByZWwpO1xuICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIHJldHVybiBudWxsO1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKEJ1bi5maWxlKGZpbGUpLCB7IGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogY29udGVudFR5cGVGb3IocmVsKSB9IH0pO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBzZXJ2ZXIgc2lkZSBvZiB0aGUgU1NFIHRhaWwg4oCUIHRoZSBkYWVtb24tc2lkZSB0d2luIG9mXG4gKiBgdGFpbEV2ZW50cy50c2AuIFRoYXQgbW9kdWxlIGRlY2lkZXMgd2hhdCBhIGNhbGxlciBvYnNlcnZlczsgdGhpcyBvbmUgZGVjaWRlc1xuICogd2hhdCBhIGNhbGxlciBpcyBzZW50LlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIGV4Y2VwdCBpdHNcbiAqIG93biBzaWJsaW5nIHR5cGVzLCB3aGljaCBpcyBzdGlsbCBpbnNpZGUgdGhlIGxlYWYuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIG1pbmQtbWFwcGVyJ3MgYHNzZVJlc3BvbnNlYCxcbiAqIHRoZSBjZW5zdXMncyBjb252ZXJnZW5jZSB0YXJnZXQgIzE6IHRoZSBvbmx5IG9uZSBvZiB0aGUgc2V2ZW4gd2l0aCBhXG4gKiBvbmNlLW9ubHkgdGVhcmRvd24gZnVubmVsLCB0aGUgb25seSBvbmUgd2lyZWQgdG8gYHJlcS5zaWduYWxgLCBhbmQgdGhlIG9ubHlcbiAqIG9uZSB3aG9zZSBjb21tZW50IHJlY29yZHMgYSBNRUFTVVJFRCByZXN1bHQgcmF0aGVyIHRoYW4gYSBiZWxpZWYuXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqICAgIENMSUVOVC4gTUVBU1VSRUQgT04gQlVOIDEuMy4xNCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBTaXggZGFlbW9ucyB3cml0ZSBhIGhlYXJ0YmVhdCBhcyBgdHJ5IHsgY29udHJvbGxlci5lbnF1ZXVlKC4uLikgfSBjYXRjaCB7fWBcbiAqIHdpdGggYSBjb21tZW50IHNheWluZyB0aGUgY2F0Y2ggaXMgaG93IGEgZGVwYXJ0ZWQgY2xpZW50IGlzIG5vdGljZWQuIEl0IGlzXG4gKiBub3Q6IGVucXVldWUgb24gYW4gb3JwaGFuZWQgc3RyZWFtIEJVRkZFUlMgU0lMRU5UTFkgYW5kIG5ldmVyIHRocm93cywgc28gdGhlXG4gKiBjYXRjaCBuZXZlciBmaXJlcyBhbmQgdGhvc2UgZGFlbW9ucycgZGVhZC1jbGllbnQgZGV0ZWN0aW9uIHJlc3RzIG9uIGFcbiAqIG1lY2hhbmlzbSB0aGVpciBvd24gY29tbWVudHMgZGVzY3JpYmUgaW5jb3JyZWN0bHkuIFdoYXQgYWN0dWFsbHkgcmVjbGFpbXMgdGhlXG4gKiBjb25uZWN0aW9uIGlzIHRoZSBzdHJlYW0ncyBgY2FuY2VsKClgIOKAlCBhbmQsIGZvciBhIGNsaWVudCB0aGF0IG5ldmVyIGNsb3Nlc1xuICogdGhlIHNvY2tldCwgYHJlcS5zaWduYWxgLlxuICpcbiAqIFNvIHRoZSBmdW5uZWwgYmVsb3cgaXMgdGhlIGxvYWQtYmVhcmluZyBwYXJ0LiBgdGVhcmRvd24oKWAgcnVucyBBVCBNT1NUIE9OQ0VcbiAqIGZyb20gZXZlcnkgcGF0aCB0aGVyZSBpcyDigJQgYGNhbmNlbCgpYCwgYW4gYWJvcnQgb24gdGhlIHJlcXVlc3Qgc2lnbmFsLCBhbmRcbiAqIHRoZSBiZWx0LWFuZC1icmFjZXMgZW5xdWV1ZSBjYXRjaCDigJQgYW5kIGl0IGlzIHdoZXJlIHRoZSBzdWJzY3JpYmVyIGNvdW50IGFuZFxuICogYW55IHByZXNlbmNlIGRlY3JlbWVudCByaWRlLiBCb3VuZGluZyBwcmVzZW5jZSBhY2N1cmFjeSBpcyBib3VuZGluZyB0aGF0XG4gKiBmdW5uZWwuXG4gKlxuICog4pqgIEtub3duIGhvbGUsIGFjY2VwdGVkIGFuZCBpbmhlcml0ZWQ6IEJ1bidzIG93biBgZmV0Y2goKWAgcmVhZGVyIGAuY2FuY2VsKClgXG4gKiBjbG9zZXMgbm90aGluZyBjbGllbnQtc2lkZSBhbmQgdGhlIHNlcnZlciBjYW5ub3Qgc2VlIGl0LiBSZWFsIGNsaWVudHMgY2xvc2VcbiAqIHRoZSBzb2NrZXQuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFdmVudExvZywgRnJhbWUgfSBmcm9tIFwiLi9ldmVudExvZy50c1wiO1xuXG4vKipcbiAqIE9uZSBvcGVuIFNTRSBzdHJlYW0sIGFzIHRoZSBkYWVtb24gY2FuIGFjdCBvbiBpdDogZW5kIGl0LCBvciBwdXNoIGEgZnJhbWUgdG9cbiAqIGl0IHRoYXQgZGlkIG5vdCBjb21lIG91dCBvZiB0aGUgbG9nLlxuICpcbiAqIOKblCBJVCBJUyBOT1QgQSBDT05UUk9MTEVSLiBUaGUgY29waWVzIGhlbGRcbiAqIGBTZXQ8UmVhZGFibGVTdHJlYW1EZWZhdWx0Q29udHJvbGxlcj5gIGFuZCBjbG9zZWQgdGhlbSBkaXJlY3RseSBhdCB0ZWFyZG93bixcbiAqIHdoaWNoIGJ5cGFzc2VzIHRoZSB0ZWFyZG93biBmdW5uZWwgYWJvdmUg4oCUIHRoZSBoZWFydGJlYXQgaW50ZXJ2YWwgZm9yIHRoYXRcbiAqIHN0cmVhbSB3YXMgY2xlYXJlZCBvbmx5IGJlY2F1c2UgYSBzZWNvbmQgYFNldGAgb2YgdGltZXJzIHdhcyBrZXB0IGluIHBhcmFsbGVsXG4gKiBhbmQgc3dlcHQgc2VwYXJhdGVseS4gRXZlcnl0aGluZyBoZXJlIGdvZXMgdGhyb3VnaCB0aGUgZnVubmVsLCBhbmQgYSBgc2VuZGBcbiAqIGFmdGVyIHRlYXJkb3duIGlzIGEgbm8tb3AgcmF0aGVyIHRoYW4gYSB0aHJvdy5cbiAqXG4gKiDimqAgKipgc2VuZGAgQVJSSVZFRCBJTiBQSEFTRSAyLCBGUk9NIFRIRSBGSVJTVCBDT05TVU1FUiBUSEFUIFdBUyBOT1QgT05FIE9GIFRIRVxuICogVFdPIFRISVMgTU9EVUxFIFdBUyBERVNJR05FRCBBR0FJTlNULioqIGFzdHJvbGFiZSBhbmQgbWFncGllIGFubm91bmNlIHByZXNlbmNlXG4gKiBvdmVyIHRoZWlyIGJyb3dzZXIgV0VCU09DS0VULCBzbyBhIHJlZ2lzdHJ5IG9mIGJhcmUgY2xvc2VycyB3YXMgc3VmZmljaWVudCBhbmRcbiAqIHRoZSBib3VuZGFyeSBsb29rZWQgcmlnaHQuIGdsYW1vdXIgYW5ub3VuY2VzIGl0IG9uIHRoZSBBR0VOVCdzIFNTRSB0YWlsIOKAlFxuICogYHt0eXBlOlwiY29ubmVjdGVkXCJ9YCAvIGB7dHlwZTpcImRpc2Nvbm5lY3RlZFwifWAsIGRlbGliZXJhdGVseSB1bmxvZ2dlZCwgc28gYVxuICogcmVjb25uZWN0aW5nIGFnZW50IGRvZXMgbm90IHJlLXNlZSBldmVyeSBwYXN0IGNvbm5lY3QgYW5kIHNvIHRoZSBmcmFtZSBuZXZlclxuICogYWR2YW5jZXMgYSB0YWlsIGN1cnNvci4gVGhhdCBpcyBub3QgYSBnbGFtb3VyIHF1aXJrOyBpdCBpcyB0aGUgZ2VuZXJhbCBzaGFwZVxuICogb2YgXCJ0ZWxsIHRoZSBsaXZlIHN1YnNjcmliZXJzIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBwYXJ0IG9mIHRoZSBoaXN0b3J5XCIsIGFuZFxuICogYSByZWdpc3RyeSB0aGF0IGNhbiBvbmx5IEVORCBhIHN0cmVhbSBjYW5ub3QgZXhwcmVzcyBpdC4gV2l0aG91dCB0aGlzIHRoZVxuICogc3BlbGwgd291bGQgaGF2ZSBoYWQgdG8ga2VlcCBpdHMgb3duIHBhcmFsbGVsIGBTZXRgIG9mIGNvbnRyb2xsZXJzLCB3aGljaCBpc1xuICogZXhhY3RseSB0aGUgZHJpZnQgdGhpcyByZWdpc3RyeSBleGlzdHMgdG8gcmVtb3ZlLlxuICovXG5leHBvcnQgdHlwZSBTc2VDbGllbnQgPSB7XG4gIC8qKiBFbmQgdGhpcyBzdHJlYW0sIHRocm91Z2ggdGhlIHRlYXJkb3duIGZ1bm5lbCwgYXQgbW9zdCBvbmNlLiAqL1xuICBjbG9zZSgpOiB2b2lkO1xuICAvKiogV3JpdGUgb25lIHJhdyBTU0UgY2h1bmsgdG8gdGhpcyBzdHJlYW0uIE5vLW9wIG9uY2UgdG9ybiBkb3duLiAqL1xuICBzZW5kKGNodW5rOiBzdHJpbmcpOiB2b2lkO1xufTtcblxuLyoqXG4gKiBUaGUgbGl2ZS10YWlsIHJlZ2lzdHJ5LiBgc2l6ZWAgaXMgdGhlIGRhZW1vbidzIFNTRSBzdWJzY3JpYmVyIGNvdW50IOKAlCB0aGVcbiAqIG51bWJlciBgc2hvdWxkSWRsZUNsb3NlYCBtdXN0IHNlZSDigJQgYW5kIGNsb3NpbmcgZXZlcnkgZW50cnkgaXMgd2hhdCBhIGRyYWluXG4gKiBkb2VzLlxuICovXG5leHBvcnQgdHlwZSBTc2VDbGllbnRzID0gU2V0PFNzZUNsaWVudD47XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3NlT3B0aW9uczxUIGV4dGVuZHMgb2JqZWN0PiB7XG4gIC8qKiBUaGUgbG9nIHRvIHJlcGxheSBmcm9tIGFuZCBzdWJzY3JpYmUgdG8uICovXG4gIGxvZzogRXZlbnRMb2c8VD47XG4gIC8qKiBUaGUgY2FsbGVyJ3MgcmVzdW1lIGN1cnNvci4gQWJzZW50IG9yIHVucGFyc2VhYmxlIHJlcGxheXMgZnJvbSB0aGUgc3RhcnQuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBIZWFydGJlYXQgY29tbWVudCBpbnRlcnZhbC4gTVVTVCBzdGF5IHdlbGwgdW5kZXIgdGhlIHNlcnZlcidzXG4gICAqICBgaWRsZVRpbWVvdXRgIOKAlCBzZWUgYGhlYXJ0YmVhdC50c2AsIHdoaWNoIGlzIHdoZXJlIHRoYXQgcGFpciBsaXZlcy4gKi9cbiAgaGVhcnRiZWF0TXM6IG51bWJlcjtcbiAgLyoqIExpdmVuZXNzIHJlZ2lzdHJ5OyB0aGUgc3RyZWFtIGFkZHMgaXRzZWxmIG9uIG9wZW4gYW5kIHJlbW92ZXMgaXRzZWxmIGluXG4gICAqICB0aGUgdGVhcmRvd24gZnVubmVsLiAqL1xuICBjbGllbnRzPzogU3NlQ2xpZW50cztcbiAgLyoqIGByZXEuc2lnbmFsYCDigJQgdGhlIG9ubHkgdGhpbmcgdGhhdCByZWNsYWltcyBhIGNsaWVudCB0aGF0IHdlbnQgYXdheVxuICAgKiAgd2l0aG91dCBjYW5jZWxsaW5nIHRoZSBzdHJlYW0uICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKiogU2VydmVyLXNpZGUgZmlsdGVyLiBBIHJlamVjdGVkIGZyYW1lIGlzIG5vdCBzZW50OyB0aGUgY2xpZW50IHN0aWxsXG4gICAqICBhZHZhbmNlcyBpdHMgY3Vyc29yIHBhc3QgaXQsIHdoaWNoIGlzIGB0YWlsRXZlbnRzYCdzIGRvY3VtZW50ZWQgcnVsZS4gKi9cbiAgZmlsdGVyPzogKGZyYW1lOiBGcmFtZTxUPikgPT4gYm9vbGVhbjtcbiAgLyoqIFJ1biBhZnRlciB0aGUgc3RyZWFtIGlzIHN1YnNjcmliZWQgKHByZXNlbmNlIHVwLCBhY3Rpdml0eSB0b3VjaCkuICovXG4gIG9uT3Blbj86ICgpID0+IHZvaWQ7XG4gIC8qKiBSdW4gZXhhY3RseSBvbmNlLCBmcm9tIHdoaWNoZXZlciB0ZWFyZG93biBwYXRoIGZpcmVzIGZpcnN0LiAqL1xuICBvbkNsb3NlPzogKCkgPT4gdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNzZVJlc3BvbnNlPFQgZXh0ZW5kcyBvYmplY3Q+KG9wdHM6IFNzZU9wdGlvbnM8VD4pOiBSZXNwb25zZSB7XG4gIGNvbnN0IHsgbG9nLCBzaW5jZSwgaGVhcnRiZWF0TXMsIGNsaWVudHMsIHNpZ25hbCwgZmlsdGVyLCBvbk9wZW4sIG9uQ2xvc2UgfSA9IG9wdHM7XG5cbiAgbGV0IHVuc3Vic2NyaWJlOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgbGV0IGtlZXBhbGl2ZTogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgbnVsbCA9IG51bGw7XG4gIGxldCBjbG9zZWQgPSBmYWxzZTtcbiAgLy8gVGhlIHJlZ2lzdHJ5IGVudHJ5IGZvciBUSElTIHN0cmVhbS4gSXRzIG1ldGhvZHMgYXJlIGZpbGxlZCBpbiBieSBgc3RhcnRgLFxuICAvLyB3aGljaCBpcyB3aGVyZSB0aGUgY29udHJvbGxlciBleGlzdHM7IHRoZSBvYmplY3QgaWRlbnRpdHkgaXMgc3RhYmxlIGZyb21cbiAgLy8gaGVyZSBzbyBgdGVhcmRvd25gIGNhbiByZW1vdmUgZXhhY3RseSB0aGlzIGVudHJ5LlxuICBjb25zdCBjbGllbnQ6IFNzZUNsaWVudCA9IHsgY2xvc2U6ICgpID0+IHt9LCBzZW5kOiAoKSA9PiB7fSB9O1xuXG4gIGNvbnN0IHRlYXJkb3duID0gKCkgPT4ge1xuICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICBjbG9zZWQgPSB0cnVlO1xuICAgIGlmIChrZWVwYWxpdmUgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoa2VlcGFsaXZlKTtcbiAgICB1bnN1YnNjcmliZT8uKCk7XG4gICAgY2xpZW50cz8uZGVsZXRlKGNsaWVudCk7XG4gICAgb25DbG9zZT8uKCk7XG4gIH07XG5cbiAgY29uc3Qgc3RyZWFtID0gbmV3IFJlYWRhYmxlU3RyZWFtKHtcbiAgICBzdGFydChjb250cm9sbGVyKSB7XG4gICAgICBjb25zdCBlbmNvZGVyID0gbmV3IFRleHRFbmNvZGVyKCk7XG4gICAgICBjb25zdCBzYWZlRW5xdWV1ZSA9IChjaHVuazogc3RyaW5nKSA9PiB7XG4gICAgICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb250cm9sbGVyLmVucXVldWUoZW5jb2Rlci5lbmNvZGUoY2h1bmspKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgdGVhcmRvd24oKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIGNsaWVudC5jbG9zZSA9ICgpID0+IHtcbiAgICAgICAgdGVhcmRvd24oKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb250cm9sbGVyLmNsb3NlKCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8qIGFscmVhZHkgY2xvc2VkIGJ5IHRoZSBydW50aW1lICovXG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICAvLyDim5QgYHNlbmRgIEdPRVMgVEhST1VHSCBgc2FmZUVucXVldWVgLCBzbyBhbiBvdXQtb2YtYmFuZCBmcmFtZSBvYmV5cyB0aGVcbiAgICAgIC8vIHNhbWUgY2xvc2VkLWNoZWNrIGFuZCB0aGUgc2FtZSB0ZWFyZG93bi1vbi10aHJvdyBhcyBhIGxvZ2dlZCBvbmUuIEFcbiAgICAgIC8vIGRhZW1vbiBtdXN0IG5vdCBiZSBhYmxlIHRvIHdyaXRlIHRvIGEgc3RyZWFtIHRoaXMgbW9kdWxlIGhhcyB0b3JuIGRvd24uXG4gICAgICBjbGllbnQuc2VuZCA9IHNhZmVFbnF1ZXVlO1xuXG4gICAgICAvLyDim5QgQU4gT1BFTklORyBDT01NRU5ULCBCRUZPUkUgQU5ZVEhJTkcgRUxTRS4gSXQgZmx1c2hlcyB0aGUgcmVzcG9uc2VcbiAgICAgIC8vIGhlYWRlcnMgaW1tZWRpYXRlbHk6IHNvbWUgSFRUUCBjbGllbnRzIOKAlCBCdW4ncyBvd24gYGZldGNoKClgIGluY2x1ZGVkIOKAlFxuICAgICAgLy8gYnVmZmVyIHVudGlsIHRoZSBmaXJzdCBieXRlIG9mIGJvZHkgYXJyaXZlcywgc28gYSBnZW51aW5lbHkgcXVpZXQgU1NFXG4gICAgICAvLyBzdHJlYW0gd291bGQgb3RoZXJ3aXNlIGxlYXZlIHRoZSBjYWxsZXIncyBgZmV0Y2goKWAgdW5yZXNvbHZlZC4gRXZlcnlcbiAgICAgIC8vIGhvdXNlIHRhaWwgY2xpZW50IHJlYWRzIGA6YCBsaW5lcyBhcyBjb21tZW50cyBhbmQgZHJvcHMgdGhlbS5cbiAgICAgIHNhZmVFbnF1ZXVlKFwiOiBjb25uZWN0ZWRcXG5cXG5cIik7XG5cbiAgICAgIHVuc3Vic2NyaWJlID0gbG9nLnN1YnNjcmliZShzaW5jZSwgKGZyYW1lKSA9PiB7XG4gICAgICAgIGlmIChmaWx0ZXIgJiYgIWZpbHRlcihmcmFtZSkpIHJldHVybjtcbiAgICAgICAgc2FmZUVucXVldWUoYGRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZnJhbWUpfVxcblxcbmApO1xuICAgICAgfSk7XG5cbiAgICAgIGtlZXBhbGl2ZSA9IHNldEludGVydmFsKCgpID0+IHNhZmVFbnF1ZXVlKFwiOiBoYlxcblxcblwiKSwgaGVhcnRiZWF0TXMpO1xuICAgICAgc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgdGVhcmRvd24sIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgIGNsaWVudHM/LmFkZChjbGllbnQpO1xuICAgICAgb25PcGVuPy4oKTtcbiAgICB9LFxuICAgIGNhbmNlbCgpIHtcbiAgICAgIHRlYXJkb3duKCk7XG4gICAgfSxcbiAgfSk7XG5cbiAgcmV0dXJuIG5ldyBSZXNwb25zZShzdHJlYW0sIHtcbiAgICBoZWFkZXJzOiB7XG4gICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcInRleHQvZXZlbnQtc3RyZWFtXCIsXG4gICAgICBcIkNhY2hlLUNvbnRyb2xcIjogXCJuby1jYWNoZVwiLFxuICAgICAgQ29ubmVjdGlvbjogXCJrZWVwLWFsaXZlXCIsXG4gICAgfSxcbiAgfSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhlYXJ0YmVhdCAvIGlkbGUtdGltZW91dCAvIHRhaWwtd2F0Y2hkb2cgdHJpcGxlIOKAlCB0aHJlZSBudW1iZXJzIHRoYXQgYXJlXG4gKiBPTkUgaW52YXJpYW50LCB3cml0dGVuIG9uY2UuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgTU9EVUxFIEVYSVNUUyBBVCBBTEwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHRocmVlIG51bWJlcnMgYXJlIGNoYWluZWQsIGFuZCB0aGUgY2hhaW4gaXMgd2hhdCBub2JvZHkgY291bGQgc2VlOlxuICpcbiAqICAgICBzZXJ2ZXIgaWRsZVRpbWVvdXQgID4gIFNTRSBoZWFydGJlYXQgIMK3ICB0YWlsIHdhdGNoZG9nICA+ICBTU0UgaGVhcnRiZWF0XG4gKlxuICogLSAqKmBpZGxlVGltZW91dGAgPiBoZWFydGJlYXQqKiwgb3IgQnVuIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlXG4gKiAgIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXMgc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcy4gTUVBU1VSRUQ6IEJ1bidzXG4gKiAgIGRlZmF1bHQgcmVxdWVzdCBgaWRsZVRpbWVvdXRgIGlzIDEwIHMgYW5kIGEgU0VSVkVSLVNFTlQgaGVhcnRiZWF0IGRvZXMgbm90XG4gKiAgIHJlc2V0IGl0LCBzbyBhIDE1IHMgYDogaGJgIGFycml2ZXMgZml2ZSBzZWNvbmRzIGFmdGVyIHRoZSB0aGluZyBpdCB3YXNcbiAqICAga2VlcGluZyBhbGl2ZSBpcyBnb25lIOKAlCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IFJBVEUgd291bGQgbm90XG4gKiAgIGhhdmUgaGVscGVkLiBGb3VyIHNwZWxscyBoYWQgaGl0IHRoaXMgYW5kIHJlcGFpcmVkIGl0LCB0aHJlZSBoYWQgbm90LlxuICogLSAqKndhdGNoZG9nID4gaGVhcnRiZWF0KiosIG9yIGEgaGVhbHRoeS1idXQtcXVpZXQgdGFpbCBhYm9ydHMgYW5kIHJlY29ubmVjdHNcbiAqICAgZm9yZXZlci4gTUVBU1VSRUQgb24gYXN0cm9sYWJlOiB3aXRoIGEgaGFyZC1jb2RlZCA0NSBzIHdhdGNoZG9nIGFuZCBhblxuICogICBlbnYtdHVuZWQgaGVhcnRiZWF0LCByZWNvbm5lY3RzIGxhbmRlZCBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3Ljkgc1xuICogICBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLiBJdCB3YXMgaGFybWxlc3Mgb25seSBiZWNhdXNlIGEgVEhJUkRcbiAqICAgY29uc3RhbnQg4oCUIGEgcHJlc2VuY2UgZGVib3VuY2Ugd2l0aCBubyByZWxhdGlvbnNoaXAgdG8gZWl0aGVyIOKAlCBoYXBwZW5lZCB0b1xuICogICBhYnNvcmIgdGhlIGNodXJuLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VBTSBJUyBUSEUgUE9JTlQuKiogVW50aWwgUGhhc2UgMWIgdGhlIHdhdGNoZG9nIGxpdmVkIGluIGVhY2hcbiAqIHNwZWxsJ3MgQ0xJIGFuZCB0aGUgaGVhcnRiZWF0IGluIGVhY2ggc3BlbGwncyBkYWVtb24sIGFuZCBCT1RIIGZpbGVzIGNhcnJpZWQgYVxuICogY29tbWVudCBzYXlpbmcgdGhlIGV4cHJlc3Npb25zIHdlcmUgaGFuZC1taXJyb3JlZCBhY3Jvc3MgYSBib3VuZGFyeSB0aGUgQ0xJXG4gKiBjb3VsZCBub3QgY3Jvc3Mg4oCUIGltcG9ydGluZyB0aGUgZGFlbW9uIHdvdWxkIGhhdmUgZHJhZ2dlZCB0aGUgd2hvbGUgc2VydmVyXG4gKiBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIFRoaXMgbW9kdWxlIGlzIHRoZSBjcm9zc2luZzogaXQgaG9sZHMgbm8gc3BlbGwnc1xuICogbnVtYmVycywgb25seSB0aGUgZGVyaXZhdGlvbnMsIGFuZCBlYWNoIHNwZWxsJ3Mgb3duIHRpbnkgYGhlYXJ0YmVhdC50c2BcbiAqIGJlc2lkZSBpdHMgZGFlbW9uIGhvbGRzIHRoZSB2YWx1ZXMgdGhhdCBCT1RIIGhhbHZlcyB0aGVuIGltcG9ydC4gQSB2YWx1ZSB0aGF0XG4gKiBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqL1xuXG4vKiogQnVuJ3MgbWF4aW11bSBgaWRsZVRpbWVvdXRgLCBpbiBzZWNvbmRzLiBgMGAgaXMgbm90IFwiZGlzYWJsZWRcIiDigJQgaXQgaXMgdGhlXG4gKiAgZGVmYXVsdCDigJQgc28gdGhlIHdheSB0byBob2xkIGEgY29ubmVjdGlvbiBvcGVuIGlzIHRvIGFzayBmb3IgdGhlIG1heGltdW0uICovXG5leHBvcnQgY29uc3QgTUFYX0lETEVfVElNRU9VVF9TRUMgPSAyNTU7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCBoZWFydGJlYXQsIGluIG1zLiBTaXggb2YgdGhlIGVpZ2h0IGRhZW1vbnMgd3JpdGUgMTUgcy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0hFQVJUQkVBVF9NUyA9IDE1XzAwMDtcblxuLyoqIEhvdyBtYW55IG1pc3NlZCBiZWF0cyB0aGUgdGFpbCB3YXRjaGRvZyB0b2xlcmF0ZXMgYmVmb3JlIGl0IGFib3J0cyBhbmRcbiAqICByZWNvbm5lY3RzLiBUaHJlZSwgZXZlcnl3aGVyZSwgYW5kIGl0IGlzIGEgZmxvb3Igbm90IGEgdGFzdGU6IGhvbGRpbmcgdGhlXG4gKiAgY29ubmVjdGlvbiBvcGVuIElTIGEgYGpvaW5gJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGFcbiAqICBjYXJkIGluIGEgaHVtYW4ncyB2aWV3LiBJdCBzdGlsbCB3YW50cyBhIHdhdGNoZG9nIOKAlCBhIHdlZGdlZCBoYWxmLW9wZW4gc29ja2V0XG4gKiAgc2hvd3MgYSBjYXJkIGFzIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHRoZSB3b3JzZSBsaWUuICovXG5leHBvcnQgY29uc3QgTUlTU0VEX0JFQVRTID0gMztcblxuLyoqIFBhcnNlIGEgcG9zaXRpdmUgaW50ZWdlciBmcm9tIGFuIGVudiB2YWx1ZSwgZmFsbGluZyBiYWNrIG9uIGFueXRoaW5nIHRoYXQgaXNcbiAqICBhYnNlbnQsIGVtcHR5LCBub24tbnVtZXJpYyBvciBub24tcG9zaXRpdmUuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqIFRoZSBzZXJ2ZXIncyBgaWRsZVRpbWVvdXRgLCBpbiBTRUNPTkRTLCBjbGFtcGVkIHRvIHdoYXQgQnVuIGFjY2VwdHMuICovXG5leHBvcnQgZnVuY3Rpb24gaWRsZVRpbWVvdXRTZWMocmF3Pzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjayA9IE1BWF9JRExFX1RJTUVPVVRfU0VDKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKE1BWF9JRExFX1RJTUVPVVRfU0VDLCBpbnRPcihyYXcsIGZhbGxiYWNrKSkpO1xufVxuXG4vKipcbiAqIFRoZSBTU0UgaGVhcnRiZWF0LCBpbiBtcywgQ0xBTVBFRCBUTyBIQUxGIHRoZSBpZGxlIHRpbWVvdXQuXG4gKlxuICogVGhlIGNsYW1wIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6IHRoZVxuICogb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwIG9ubHkgaW5cbiAqIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoZWFydGJlYXRNcyhcbiAgcmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGlkbGVTZWM6IG51bWJlcixcbiAgZmFsbGJhY2sgPSBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbik6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1pbihpbnRPcihyYXcsIGZhbGxiYWNrKSwgTWF0aC5tYXgoNTAwLCBNYXRoLmZsb29yKChpZGxlU2VjICogMTAwMCkgLyAyKSkpO1xufVxuXG4vKiogVGhlIHRhaWwtc2lkZSB3YXRjaGRvZyBmb3IgYSBnaXZlbiBoZWFydGJlYXQ6IHRocmVlIG1pc3NlZCBiZWF0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsSWRsZU1zKGJlYXRNczogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIGJlYXRNcyAqIE1JU1NFRF9CRUFUUztcbn1cbiIsCiAgICAiLyoqXG4gKiBHbGFtb3VyJ3MgY29ubmVjdGlvbi10aW1pbmcgY29uc3RhbnRzIOKAlCBUSEUgT05FIENPUFksIGltcG9ydGVkIGJ5IGJvdGggaGFsdmVzXG4gKiBvZiB0aGUgc3BlbGwuXG4gKlxuICog4puUIFRISVMgRklMRSBJUyBUSEUgU0VBTS4gQmVmb3JlIFBoYXNlIDIgdGhlIGhlYXJ0YmVhdCB3YXMgYSBMSVRFUkFMIGAxNTAwMGBcbiAqIGluc2lkZSBgc2VydmVyLnRzYCdzIGBzc2VSZXNwb25zZWAsIGFuZCBgY2xpLnRzYCBoYWQgTk8gY29ycmVzcG9uZGluZyBudW1iZXJcbiAqIGF0IGFsbCDigJQgaXRzIHRhaWwgbG9vcCBzaW1wbHkgYmxvY2tlZCBvbiBgcmVhZGVyLnJlYWQoKWAgZm9yZXZlciwgd2hpY2ggaXMgdGhlXG4gKiBmYWlsdXJlIGB0YWlsRXZlbnRzYCdzIHdhdGNoZG9nIGV4aXN0cyB0byBlbmQuIE5laXRoZXIgZmlsZSBjb3VsZCBpbXBvcnQgdGhlXG4gKiBvdGhlcjogdGhlIENMSSByZWFjaGluZyBpbnRvIHRoZSBkYWVtb24gd291bGQgZHJhZyB0aGUgd2hvbGUgc2VydmVyIGdyYXBoIGludG9cbiAqIGBkaXN0L2NsaS5qc2AuIEEgbW9kdWxlIHdpdGggbm8gaW1wb3J0cyBidXQgdGhlIGtpdCdzIGRlcml2YXRpb25zIGhhcyBubyBzdWNoXG4gKiBncmFwaCwgc28gYm90aCBoYWx2ZXMgaW1wb3J0IHRoaXMgb25lLlxuICpcbiAqIOKblCAqKkFORCBUSEUgV0FUQ0hET0cgSVMgREVSSVZFRCBGUk9NIEdMQU1PVVInUyBPV04gSEVBUlRCRUFULCBORVZFUiBDT1BJRURcbiAqIEZST00gQSBTSUJMSU5HLioqIFRoaXMgaXMgUGhhc2UgMWEncyBydWxlIGFuZCBpdCBpcyB0aGUgd2hvbGUgcmVhc29uIHRoZSBmaWxlXG4gKiBleGlzdHMgcmF0aGVyIHRoYW4gYSBzaGFyZWQgY29uc3RhbnQgc29tZXdoZXJlOiBhc3Ryb2xhYmUgYmVhdHMgYXQgMTAgcyBhbmRcbiAqIG1hZ3BpZSBhdCAxNSBzLCBzbyBhIGhhcmQtY29kZWQgd2F0Y2hkb2cgaXMgY29ycmVjdCBmb3IgYXQgbW9zdCBvbmUgb2YgdGhlbS5cbiAqIEFzdHJvbGFiZSBtZWFzdXJlZCB3aGF0IGEgY29waWVkIG51bWJlciBkb2VzIOKAlCBhIDQ1IHMgd2F0Y2hkb2cgYWdhaW5zdCBhblxuICogZW52LXR1bmVkIGhlYXJ0YmVhdCBwcm9kdWNlZCByZWNvbm5lY3RzIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLCBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYW4gdW5yZWxhdGVkIHRoaXJkXG4gKiBjb25zdGFudCBhYnNvcmJlZCB0aGUgY2h1cm4uIGB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpYCBjYW5ub3QgZHJpZnQgZnJvbVxuICogdGhlIGJlYXQgaXQgaXMgd2F0Y2hpbmcsIHdoYXRldmVyIHRoZSBiZWF0IGJlY29tZXMuXG4gKlxuICog4pqgIEtFRVAgSVQgQSBMRUFGLVNIQVBFRCBGSUxFLiBUaGUgbW9tZW50IHRoaXMgaW1wb3J0cyBhbnl0aGluZyBvZiB0aGVcbiAqIGRhZW1vbidzLCB0aGUgQ0xJIGlzIGJhY2sgdG8gZHJhZ2dpbmcgdGhlIHNlcnZlciBncmFwaCBhbmQgdGhlIHNlYW0gY2xvc2VzLlxuICovXG5cbmltcG9ydCB7XG4gIERFRkFVTFRfSEVBUlRCRUFUX01TLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbiAgdGFpbElkbGVNcyxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hlYXJ0YmVhdC50c1wiO1xuXG4vKipcbiAqIEJ1bidzIG1heGltdW0uIFRoaXMgaXMgZ2xhbW91cidzIG93biBtZWFzdXJlZCB2YWx1ZSwgbm90IGFuIGluaGVyaXRlZCBvbmU6XG4gKiBgc2VydmVyLnRzYCBjYXJyaWVkIGBpZGxlVGltZW91dDogMjU1YCB3aXRoIGEgY29tbWVudCByZWNvcmRpbmcgdGhhdCBCdW4nc1xuICogZGVmYXVsdCAxMCBzIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlIHRoZSAxNSBzIGtlZXBhbGl2ZSBldmVyXG4gKiBmaXJlcy4gR2xhbW91ciBkb2VzIG5vdCBlbnYtdHVuZSBpdCDigJQgYSBzZXNzaW9uIGRhZW1vbidzIGNvbm5lY3Rpb24gbGlmZXRpbWVcbiAqIGlzIG5vdCBzb21ldGhpbmcgYSBjYWxsZXIgaGFzIGV2ZXIgbmVlZGVkIHRvIHNob3J0ZW4uXG4gKi9cbmV4cG9ydCBjb25zdCBJRExFX1RJTUVPVVRfU0VDID0gTUFYX0lETEVfVElNRU9VVF9TRUM7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCwgYW5kIGdsYW1vdXIncyBvd24gbGl0ZXJhbCBiZWZvcmUgdGhpcyBmaWxlIGV4aXN0ZWQuICovXG5leHBvcnQgY29uc3QgU1NFX0hFQVJUQkVBVF9NUyA9IERFRkFVTFRfSEVBUlRCRUFUX01TO1xuXG4vKipcbiAqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMsIERFUklWRUQuXG4gKlxuICog4pqgIDQ1LDAwMCBtcyB0b2RheSwgd2hpY2ggaXMgdGhlIHNhbWUgbnVtYmVyIGBjbWRPcGVuYCdzIGAtLXN0YXJ0LXRpbWVvdXRgXG4gKiBkZWZhdWx0IGhhcHBlbnMgdG8gYmUuIFRoZXkgYXJlIFVOUkVMQVRFRCDigJQgb25lIGJvdW5kcyBhIGZpcnN0IGJ1bmRsZSBidWlsZCxcbiAqIHRoZSBvdGhlciBib3VuZHMgYSBzaWxlbnQgc29ja2V0IOKAlCBhbmQgdGhlIGNvaW5jaWRlbmNlIGlzIG5hbWVkIGhlcmUgc28gbm9ib2R5XG4gKiBsYXRlciBcImRlLWR1cGxpY2F0ZXNcIiB0aGVtIGludG8gb25lIGNvbnN0YW50LlxuICovXG5leHBvcnQgY29uc3QgVEFJTF9JRExFX01TID0gdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKTtcbiIsCiAgICAiaW1wb3J0IHsgbWtkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7XG4gIGRlZmF1bHRTdGF0ZSxcbiAgdHlwZSBHbGFtb3VyU3RhdGUsXG4gIHR5cGUgTGlicmFyeUl0ZW0sXG59IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvZ2xhbW91ci9zaGFyZWQvdHlwZXNcIjtcblxuY29uc3QgRVhUX0JZX01JTUU6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiaW1hZ2Uvd2VicFwiOiBcIndlYnBcIixcbiAgXCJpbWFnZS9wbmdcIjogXCJwbmdcIixcbiAgXCJpbWFnZS9qcGVnXCI6IFwianBnXCIsXG4gIFwiaW1hZ2UvZ2lmXCI6IFwiZ2lmXCIsXG59O1xuXG5leHBvcnQgZnVuY3Rpb24gc2F2ZURhdGFVcmwoZGlyOiBzdHJpbmcsIGlkOiBzdHJpbmcsIGRhdGFVcmw6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG0gPSAvXmRhdGE6KFteOyxdKyk/KDtiYXNlNjQpPywoLiopJC9zLmV4ZWMoZGF0YVVybCk7XG4gIGlmICghbSB8fCAhZGlyKSByZXR1cm4gXCJcIjtcbiAgY29uc3QgbWltZSA9IChtWzFdID8/IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCIpLnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IGJvZHkgPSBtWzNdO1xuICBjb25zdCBidWYgPSBtWzJdID8gQnVmZmVyLmZyb20oYm9keSwgXCJiYXNlNjRcIikgOiBCdWZmZXIuZnJvbShkZWNvZGVVUklDb21wb25lbnQoYm9keSksIFwidXRmOFwiKTtcbiAgY29uc3QgZXh0ID0gRVhUX0JZX01JTUVbbWltZV0gPz8gXCJiaW5cIjtcbiAgY29uc3Qgc2FmZUlkID0gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfLV0vZywgXCJfXCIpO1xuICBjb25zdCBwYXRoID0gam9pbihkaXIsIGAke3NhZmVJZH0uJHtleHR9YCk7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhwYXRoLCBidWYpO1xuICAgIHJldHVybiBwYXRoO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gXCJcIjtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gc2F2ZVRleHQoZGlyOiBzdHJpbmcsIGlkOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgdGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgc2FmZSA9IG5hbWUucmVwbGFjZSgvW15hLXpBLVowLTkuXy1dL2csIFwiX1wiKSB8fCBgJHtpZH0ubWRgO1xuICBjb25zdCBwYXRoID0gam9pbihkaXIsIGAke2lkfS0ke3NhZmV9YCk7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhwYXRoLCB0ZXh0LCBcInV0ZjhcIik7XG4gICAgcmV0dXJuIHBhdGg7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBcIlwiO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXRlcmlhbGl6ZUl0ZW0oZmlsZXNEaXI6IHN0cmluZywgaXRlbTogTGlicmFyeUl0ZW0pOiB2b2lkIHtcbiAgaWYgKGl0ZW0uc3JjKSB7XG4gICAgY29uc3QgcCA9IHNhdmVEYXRhVXJsKGZpbGVzRGlyLCBpdGVtLmlkLCBpdGVtLnNyYyk7XG4gICAgaWYgKHApIGl0ZW0ucGF0aCA9IHA7XG4gIH0gZWxzZSBpZiAoaXRlbS50ZXh0KSB7XG4gICAgY29uc3QgcCA9IHNhdmVUZXh0KGZpbGVzRGlyLCBpdGVtLmlkLCBpdGVtLnRpdGxlLCBpdGVtLnRleHQpO1xuICAgIGlmIChwKSBpdGVtLnBhdGggPSBwO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzYXZlU25hcHNob3Qoc25hcHNob3RzRGlyOiBzdHJpbmcsIHNlc3Npb25JZDogc3RyaW5nLCBzdGF0ZTogR2xhbW91clN0YXRlKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKHNuYXBzaG90c0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHNuYXBzaG90c0RpciwgYCR7c2Vzc2lvbklkfS5qc29uYCksIEpTT04uc3RyaW5naWZ5KHN0YXRlKSk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIHBlcnNpc3RlbmNlIGlzIGJlc3QtZWZmb3J0ICovXG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxvYWRTbmFwc2hvdChwYXRoOiBzdHJpbmcsIHRpdGxlOiBzdHJpbmcsIGludGVudDogc3RyaW5nKTogR2xhbW91clN0YXRlIHtcbiAgY29uc3Qgc25hcCA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSkgYXMgUGFydGlhbDxHbGFtb3VyU3RhdGU+O1xuICAvLyBNZXJnZSBvdmVyIGRlZmF1bHRzIHNvIG9sZGVyIHNuYXBzaG90cyBnYWluIG5ldyB0b3AtbGV2ZWwgZmllbGRzLlxuICBjb25zdCBtZXJnZWQgPSB7IC4uLmRlZmF1bHRTdGF0ZSh0aXRsZSwgaW50ZW50KSwgLi4uc25hcCB9IGFzIEdsYW1vdXJTdGF0ZTtcbiAgLy8gTm9ybWFsaXplIHN0eWxlLWd1aWRlIHNlY3Rpb25zIHNvIHNuYXBzaG90cyBwcmVkYXRpbmcgbmV3ZXIgcGVyLXNlY3Rpb25cbiAgLy8gZmllbGRzIChwcm9tcHRzLCBjb2xvcnMpIHN0aWxsIHNhdGlzZnkgdGhlIGN1cnJlbnQgc2hhcGUuXG4gIG1lcmdlZC5zdHlsZUd1aWRlID0gbWVyZ2VkLnN0eWxlR3VpZGUubWFwKChzKSA9PiAoe1xuICAgIC4uLnMsXG4gICAgcHJvbXB0czogcy5wcm9tcHRzID8/IFtdLFxuICAgIGNvbG9yczogcy5jb2xvcnMgPz8gW10sXG4gIH0pKTtcbiAgcmV0dXJuIG1lcmdlZDtcbn1cbiIsCiAgICAiaW1wb3J0IHR5cGUge1xuICBBZ2VudENvbW1hbmQsXG4gIENhbm9uSW1nLFxuICBHZW5NZXRhLFxuICBHbGFtb3VyU3RhdGUsXG4gIEl0ZW1LaW5kLFxuICBMZWFuSXRlbSxcbiAgTGVhblN0YXRlLFxuICBMaWJyYXJ5SXRlbSxcbiAgTWVzc2FnZSxcbiAgU2F2ZWRTdHlsZSxcbiAgU2VjdGlvbktleSxcbiAgU2VjdGlvblN0YXR1cyxcbiAgU3dhdGNoLFxufSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dsYW1vdXIvc2hhcmVkL3R5cGVzXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiBtYWtlSXRlbShwOiB7XG4gIGlkOiBzdHJpbmc7XG4gIGtpbmQ6IEl0ZW1LaW5kO1xuICB0aXRsZTogc3RyaW5nO1xuICBzcmM/OiBzdHJpbmc7XG4gIHBhdGg/OiBzdHJpbmc7XG4gIHRleHQ/OiBzdHJpbmc7XG4gIG1pbWU/OiBzdHJpbmc7XG4gIHRhZ3M/OiBzdHJpbmdbXTtcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIGdlbj86IEdlbk1ldGEgfCBudWxsO1xufSk6IExpYnJhcnlJdGVtIHtcbiAgcmV0dXJuIHtcbiAgICBpZDogcC5pZCxcbiAgICBraW5kOiBwLmtpbmQsXG4gICAgdGl0bGU6IHAudGl0bGUsXG4gICAgc3JjOiBwLnNyYyA/PyBcIlwiLFxuICAgIHBhdGg6IHAucGF0aCA/PyBcIlwiLFxuICAgIHRleHQ6IHAudGV4dCA/PyBcIlwiLFxuICAgIG1pbWU6IHAubWltZSA/PyBcIlwiLFxuICAgIHRhZ3M6IHAudGFncyA/PyBbXSxcbiAgICBzdGFycmVkOiBmYWxzZSxcbiAgICBsaWtlZDogZmFsc2UsXG4gICAgYW5ub3RhdGlvbnM6IHsgYWdlbnQ6IFwiXCIsIGh1bWFuOiBcIlwiIH0sXG4gICAgY2Fub25pY2FsOiBmYWxzZSxcbiAgICBjYW5vbjogW10sXG4gICAgYXJjaGl2ZWQ6IGZhbHNlLFxuICAgIGNyZWF0ZWRBdDogcC5jcmVhdGVkQXQsXG4gICAgZ2VuOiBwLmdlbiA/PyBudWxsLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkSXRlbShzdGF0ZTogR2xhbW91clN0YXRlLCBpdGVtOiBMaWJyYXJ5SXRlbSk6IGJvb2xlYW4ge1xuICBpZiAoc3RhdGUubGlicmFyeS5zb21lKChpKSA9PiBpLmlkID09PSBpdGVtLmlkKSkgcmV0dXJuIGZhbHNlO1xuICBzdGF0ZS5saWJyYXJ5LnB1c2goaXRlbSk7XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2VsZWN0SXRlbXMoc3RhdGU6IEdsYW1vdXJTdGF0ZSwgaWRzOiBzdHJpbmdbXSk6IHZvaWQge1xuICBzdGF0ZS5zZWxlY3RlZElkcyA9IFsuLi5pZHNdO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0U3RhcihzdGF0ZTogR2xhbW91clN0YXRlLCBpZDogc3RyaW5nLCBzdGFycmVkOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGl0ID0gc3RhdGUubGlicmFyeS5maW5kKChpKSA9PiBpLmlkID09PSBpZCk7XG4gIGlmICghaXQpIHJldHVybiBmYWxzZTtcbiAgaXQuc3RhcnJlZCA9IHN0YXJyZWQ7XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0TGlrZShzdGF0ZTogR2xhbW91clN0YXRlLCBpZDogc3RyaW5nLCBsaWtlZDogYm9vbGVhbik6IGJvb2xlYW4ge1xuICBjb25zdCBpdCA9IHN0YXRlLmxpYnJhcnkuZmluZCgoaSkgPT4gaS5pZCA9PT0gaWQpO1xuICBpZiAoIWl0KSByZXR1cm4gZmFsc2U7XG4gIGl0Lmxpa2VkID0gbGlrZWQ7XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYW5ub3RhdGUoXG4gIHN0YXRlOiBHbGFtb3VyU3RhdGUsXG4gIGlkOiBzdHJpbmcsXG4gIHdobzogXCJhZ2VudFwiIHwgXCJodW1hblwiLFxuICB0ZXh0OiBzdHJpbmcsXG4pOiBib29sZWFuIHtcbiAgY29uc3QgaXQgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKGkpID0+IGkuaWQgPT09IGlkKTtcbiAgaWYgKCFpdCkgcmV0dXJuIGZhbHNlO1xuICBpdC5hbm5vdGF0aW9uc1t3aG9dID0gdGV4dDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRNZXNzYWdlKHN0YXRlOiBHbGFtb3VyU3RhdGUsIG06IE1lc3NhZ2UpOiB2b2lkIHtcbiAgc3RhdGUubWVzc2FnZXMucHVzaChtKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVNlY3Rpb24oXG4gIHN0YXRlOiBHbGFtb3VyU3RhdGUsXG4gIGtleTogU2VjdGlvbktleSxcbiAgcGF0Y2g6IHsgY29udGVudD86IHN0cmluZzsgc3RhdHVzPzogU2VjdGlvblN0YXR1czsgcHJvbXB0cz86IHN0cmluZ1tdOyBjb2xvcnM/OiBTd2F0Y2hbXSB9LFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IHNlYyA9IHN0YXRlLnN0eWxlR3VpZGUuZmluZCgocykgPT4gcy5rZXkgPT09IGtleSk7XG4gIGlmICghc2VjKSByZXR1cm4gZmFsc2U7XG4gIGlmIChwYXRjaC5jb250ZW50ICE9PSB1bmRlZmluZWQpIHNlYy5jb250ZW50ID0gcGF0Y2guY29udGVudDtcbiAgaWYgKHBhdGNoLnN0YXR1cyAhPT0gdW5kZWZpbmVkKSBzZWMuc3RhdHVzID0gcGF0Y2guc3RhdHVzO1xuICBpZiAocGF0Y2gucHJvbXB0cyAhPT0gdW5kZWZpbmVkKSBzZWMucHJvbXB0cyA9IHBhdGNoLnByb21wdHM7XG4gIGlmIChwYXRjaC5jb2xvcnMgIT09IHVuZGVmaW5lZCkgc2VjLmNvbG9ycyA9IHBhdGNoLmNvbG9ycztcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRGb2N1cyhcbiAgc3RhdGU6IEdsYW1vdXJTdGF0ZSxcbiAgaWRzOiBzdHJpbmdbXSxcbiAgb3duZXI6IFwieW91XCIgfCBcImFnZW50XCIsXG4gIG5vdGUgPSBcIlwiLFxuKTogdm9pZCB7XG4gIHN0YXRlLnNjb3BlID0gXCJmb2N1c1wiO1xuICBzdGF0ZS5mb2N1c1NldCA9IFsuLi5pZHNdO1xuICBzdGF0ZS5mb2N1c093bmVyID0gb3duZXI7XG4gIHN0YXRlLmZvY3VzTm90ZSA9IG5vdGU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjbGVhckZvY3VzKHN0YXRlOiBHbGFtb3VyU3RhdGUpOiB2b2lkIHtcbiAgc3RhdGUuc2NvcGUgPSBcImFsbFwiO1xuICBzdGF0ZS5mb2N1c1NldCA9IFtdO1xuICBzdGF0ZS5mb2N1c093bmVyID0gbnVsbDtcbiAgc3RhdGUuZm9jdXNOb3RlID0gXCJcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldENhbm9uaWNhbChzdGF0ZTogR2xhbW91clN0YXRlLCBpZDogc3RyaW5nLCBjYW5vbmljYWw6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3QgaXQgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKGkpID0+IGkuaWQgPT09IGlkKTtcbiAgaWYgKCFpdCkgcmV0dXJuIGZhbHNlO1xuICBpdC5jYW5vbmljYWwgPSBjYW5vbmljYWw7XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYXJjaGl2ZVRyYXlTdHlsZShzdGF0ZTogR2xhbW91clN0YXRlLCBpZDogc3RyaW5nLCBhcmNoaXZlZDogYm9vbGVhbik6IGJvb2xlYW4ge1xuICBjb25zdCBzdCA9IHN0YXRlLnRyYXkuZmluZCgocykgPT4gcy5pZCA9PT0gaWQpO1xuICBpZiAoIXN0KSByZXR1cm4gZmFsc2U7XG4gIHN0LmFyY2hpdmVkID0gYXJjaGl2ZWQ7XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRTdHlsZUl0ZW0oXG4gIHN0eWxlOiBTYXZlZFN0eWxlLFxuICBjYW5vbjogQ2Fub25JbWdbXSxcbiAgY3JlYXRlZEF0OiBudW1iZXIsXG4pOiBMaWJyYXJ5SXRlbSB7XG4gIHJldHVybiB7XG4gICAgaWQ6IGBzdHlsZS0ke3N0eWxlLmlkfWAsXG4gICAga2luZDogXCJzdHlsZVwiLFxuICAgIHRpdGxlOiBzdHlsZS5sYWJlbCxcbiAgICBzcmM6IFwiXCIsXG4gICAgcGF0aDogXCJcIixcbiAgICB0ZXh0OiBzdHlsZS50ZXh0LFxuICAgIG1pbWU6IFwiXCIsXG4gICAgdGFnczogW10sXG4gICAgc3RhcnJlZDogZmFsc2UsXG4gICAgbGlrZWQ6IGZhbHNlLFxuICAgIGFubm90YXRpb25zOiB7IGFnZW50OiBcIlwiLCBodW1hbjogXCJcIiB9LFxuICAgIGNhbm9uaWNhbDogZmFsc2UsXG4gICAgY2Fub24sXG4gICAgYXJjaGl2ZWQ6IGZhbHNlLFxuICAgIGNyZWF0ZWRBdCxcbiAgICBnZW46IG51bGwsXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRJdGVtQXJjaGl2ZWQoc3RhdGU6IEdsYW1vdXJTdGF0ZSwgaWQ6IHN0cmluZywgYXJjaGl2ZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3QgaXQgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKGkpID0+IGkuaWQgPT09IGlkKTtcbiAgaWYgKCFpdCkgcmV0dXJuIGZhbHNlO1xuICBpdC5hcmNoaXZlZCA9IGFyY2hpdmVkO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldEdlbkNvc3Qoc3RhdGU6IEdsYW1vdXJTdGF0ZSwgaWQ6IHN0cmluZywgY29zdDogbnVtYmVyKTogYm9vbGVhbiB7XG4gIGNvbnN0IGl0ID0gc3RhdGUubGlicmFyeS5maW5kKChpKSA9PiBpLmlkID09PSBpZCk7XG4gIGlmICghaXQ/LmdlbikgcmV0dXJuIGZhbHNlO1xuICBpdC5nZW4uY29zdCA9IGNvc3Q7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyBCYWNrZmlsbCB0aGUgcmVhbCBwcm9tcHQgYW5kL29yIHJlZnMgb250byBhIGdlbiBhZnRlciB0aGUgZmFjdCwgc28gaXRzIHN0b3JlZFxuLy8gbWV0YWRhdGEgaXMgdGhlIHJlcHJvZHVjaWJsZSBwcm9tcHQgKG5vdCBhIGxhYmVsKSDigJQgbm8gc2Vzc2lvbiBib3VuY2UgbmVlZGVkLlxuZXhwb3J0IGZ1bmN0aW9uIHNldEdlbk1ldGEoXG4gIHN0YXRlOiBHbGFtb3VyU3RhdGUsXG4gIGlkOiBzdHJpbmcsXG4gIHBhdGNoOiB7IHByb21wdD86IHN0cmluZzsgY3VzdG9tPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB9LFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGl0ID0gc3RhdGUubGlicmFyeS5maW5kKChpKSA9PiBpLmlkID09PSBpZCk7XG4gIGlmICghaXQ/LmdlbikgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHBhdGNoLnByb21wdCA9PT0gXCJzdHJpbmdcIikgaXQuZ2VuLnByb21wdCA9IHBhdGNoLnByb21wdDtcbiAgaWYgKHBhdGNoLmN1c3RvbSkgaXQuZ2VuLmN1c3RvbSA9IHsgLi4uKGl0Lmdlbi5jdXN0b20gPz8ge30pLCAuLi5wYXRjaC5jdXN0b20gfTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsZWFuSXRlbShpdDogTGlicmFyeUl0ZW0pOiBMZWFuSXRlbSB7XG4gIGNvbnN0IHsgc3JjOiBfcywgdGV4dDogX3QsIGNhbm9uOiBfYywgLi4ucmVzdCB9ID0gaXQ7XG4gIHJldHVybiByZXN0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbGVhblN0YXRlKHM6IEdsYW1vdXJTdGF0ZSk6IExlYW5TdGF0ZSB7XG4gIHJldHVybiB7IC4uLnMsIGxpYnJhcnk6IHMubGlicmFyeS5tYXAobGVhbkl0ZW0pIH07XG59XG5cbi8vIEJvYXJkIG1vdmVzIHRoYXQgbXV0YXRlIHN0YXRlICsgYnJvYWRjYXN0IGJ1dCBlbWl0IE5PIGFnZW50IGV2ZW50LlxuZXhwb3J0IGNvbnN0IEFNQklFTlRfQ0xJRU5UID0gbmV3IFNldDxzdHJpbmc+KFtcbiAgXCJpdGVtLnNlbGVjdFwiLFxuICBcIml0ZW0uc3RhclwiLFxuICBcIml0ZW0ubGlrZVwiLFxuICBcImZvY3VzLnNldFwiLFxuICBcImZvY3VzLmNsZWFyXCIsXG4gIFwiaXRlbS5jYW5vbmljYWxcIixcbiAgXCJpdGVtLmFyY2hpdmVcIixcbiAgXCJpdGVtLmFubm90YXRlXCIsIC8vIGEgcGVyLWl0ZW0gbm90ZTogc3RvcmVkICsgcmVhZCBvbiBkZW1hbmQsIG5vdCBwdXNoZWQgYXMgYW4gZXZlbnRcbl0pO1xuZXhwb3J0IGZ1bmN0aW9uIGlzSW1wZXJhdGl2ZSh0eXBlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuICFBTUJJRU5UX0NMSUVOVC5oYXModHlwZSk7XG59XG5cbi8vIFJldHVybnMgd2hldGhlciB0aGUgY29tbWFuZCB0eXBlIHdhcyBSRUNPR05JU0VEIOKAlCB0aGUgdmVyZGljdCB0aGUgL2NtZCByb3V0ZVxuLy8gcHJvcGFnYXRlcyAoIzg0KS4gUmVjb2duaXNlZC1hbmQtYXBwbGllZCBpcyBgdHJ1ZWA7IGFuIHVua25vd24gdHlwZSBpc1xuLy8gYGZhbHNlYC4gVGhpcyBpcyBkZWxpYmVyYXRlbHkgbm90IFwiZGlkIHN0YXRlIGNoYW5nZVwiOiBhIHJlY29nbmlzZWQgY29tbWFuZFxuLy8gdGhhdCBpcyBhIGxlZ2l0aW1hdGUgbm8tb3Agc3RpbGwgYXBwbGllZC5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseUFnZW50TXNnKHN0YXRlOiBHbGFtb3VyU3RhdGUsIG1zZzogQWdlbnRDb21tYW5kKTogYm9vbGVhbiB7XG4gIHN3aXRjaCAobXNnLnR5cGUpIHtcbiAgICBjYXNlIFwiaW5pdFwiOlxuICAgICAgaWYgKHR5cGVvZiBtc2cudGl0bGUgPT09IFwic3RyaW5nXCIpIHN0YXRlLnRpdGxlID0gbXNnLnRpdGxlO1xuICAgICAgaWYgKHR5cGVvZiBtc2cuaW50ZW50ID09PSBcInN0cmluZ1wiKSBzdGF0ZS5pbnRlbnQgPSBtc2cuaW50ZW50O1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImludGVudFwiOlxuICAgICAgc3RhdGUuaW50ZW50ID0gbXNnLnRleHQ7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiaXRlbS5hbm5vdGF0ZVwiOiB7XG4gICAgICBjb25zdCBpdCA9IHN0YXRlLmxpYnJhcnkuZmluZCgoaSkgPT4gaS5pZCA9PT0gbXNnLmlkKTtcbiAgICAgIGlmIChpdCkgaXQuYW5ub3RhdGlvbnMuYWdlbnQgPSBtc2cuYWdlbnQ7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSBcInNlY3Rpb25cIjpcbiAgICAgIHVwZGF0ZVNlY3Rpb24oc3RhdGUsIG1zZy5rZXksIHtcbiAgICAgICAgY29udGVudDogbXNnLmNvbnRlbnQsXG4gICAgICAgIHN0YXR1czogbXNnLnN0YXR1cyxcbiAgICAgICAgcHJvbXB0czogbXNnLnByb21wdHMsXG4gICAgICAgIGNvbG9yczogbXNnLmNvbG9ycyxcbiAgICAgIH0pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImZvY3VzLnB1c2hcIjpcbiAgICAgIHNldEZvY3VzKHN0YXRlLCBtc2cuaWRzLCBcImFnZW50XCIsIG1zZy5ub3RlID8/IFwiXCIpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImdlbi5jb3N0XCI6XG4gICAgICBzZXRHZW5Db3N0KHN0YXRlLCBtc2cuaWQsIG1zZy5jb3N0KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJnZW4ubWV0YVwiOlxuICAgICAgc2V0R2VuTWV0YShzdGF0ZSwgbXNnLmlkLCB7IHByb21wdDogbXNnLnByb21wdCwgY3VzdG9tOiBtc2cuY3VzdG9tIH0pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInN0YXR1c1wiOlxuICAgICAgc3RhdGUuc3RhdHVzID0geyBidXN5OiBtc2cuYnVzeSwgdGV4dDogbXNnLnRleHQgPz8gXCJcIiB9O1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInN0eWxlLmFyY2hpdmVcIjpcbiAgICAgIGFyY2hpdmVUcmF5U3R5bGUoc3RhdGUsIG1zZy5pZCwgbXNnLmFyY2hpdmVkKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJzYXlcIjpcbiAgICBjYXNlIFwiY2xvc2VcIjpcbiAgICAgIGJyZWFrOyAvLyBoYW5kbGVkIGJ5IHRoZSBzZXJ2ZXIgKGFwcGVuZGVkIHRvIGNvbnZlcnNhdGlvbiAvIHNodXRkb3duKVxuICAgIGRlZmF1bHQ6XG4gICAgICAvLyAjODQg4oCUIHRoZSBzd2l0Y2ggaGFkIE5PIGRlZmF1bHQsIHNvIGFuIHVucmVjb2duaXNlZCBjb21tYW5kIHR5cGUgZGlkXG4gICAgICAvLyBub3RoaW5nIGFuZCB0aGUgL2NtZCByb3V0ZSBzdGlsbCBhbnN3ZXJlZCB7b2s6dHJ1ZX06IGEgYm9ndXMgdHlwZSB3YXNcbiAgICAgIC8vIGJ5dGUtaWRlbnRpY2FsIHRvIGFuIGV4ZWN1dGVkIG9uZS4gVGhlIHZlcmRpY3QgaGFzIHRvIGJlIHByb2R1Y2VkIEhFUkUsXG4gICAgICAvLyBieSB0aGUgY29kZSB0aGF0IGFjdHVhbGx5IGtub3dzIHRoZSByZWNvZ25pc2VkIHNldCwgYW5kIG5vdCBtaXJyb3JlZFxuICAgICAgLy8gaW50byBhIGxpc3QgYmVzaWRlIHRoZSBzd2l0Y2gg4oCUIGEgaGFuZC1tYWludGFpbmVkIG1pcnJvciBvZiBhIGNhc2UgbGlzdFxuICAgICAgLy8gZHJpZnRzIHNpbGVudGx5IHRoZSBtb21lbnQgYSBjYXNlIGlzIGFkZGVkLCB3aGljaCBpcyBhIGRlZmVjdCB0aGlzIHJlcG9cbiAgICAgIC8vIGhhcyBhbHJlYWR5IHNoaXBwZWQgdHdpY2UuXG4gICAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG4iLAogICAgIi8vIFNlcnZlci9DTEktb25seTogdGhlIHByb2plY3Qtc2NvcGVkIHN0eWxlIHN0b3JlLiBEbyBOT1QgaW1wb3J0IGZyb20gYnJvd3NlclxuLy8gY29kZSAoZmlsZXN5c3RlbSBhY2Nlc3MpLiBTdHlsZXMgbGl2ZSB1bmRlciAke2hvbWV9L3N0eWxlcy8ke3Byb2plY3RLZXl9Lyxcbi8vIGtleWVkIHRvIHRoZSBjaGVja291dCB3aGVyZSB0aGUgc3BlbGwgd2FzIGNhc3QuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2RpclN5bmMsIHJlYWRkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdHlwZSB7XG4gIENhbm9uSW1nLFxuICBDYW5vbmljYWxSZWYsXG4gIExpYnJhcnlJdGVtLFxuICBTYXZlZFN0eWxlLFxuICBTdHlsZVNlY3Rpb24sXG59IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvZ2xhbW91ci9zaGFyZWQvdHlwZXNcIjtcblxuY29uc3QgRVhUX0JZX01JTUU6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiaW1hZ2Uvd2VicFwiOiBcIndlYnBcIixcbiAgXCJpbWFnZS9wbmdcIjogXCJwbmdcIixcbiAgXCJpbWFnZS9qcGVnXCI6IFwianBnXCIsXG4gIFwiaW1hZ2UvZ2lmXCI6IFwiZ2lmXCIsXG59O1xuXG4vLyBBIHN0YWJsZSwgZmlsZXN5c3RlbS1zYWZlIGtleTogc2FuaXRpemVkIGJhc2UgbmFtZSArIGEgc2hvcnQgaGFzaCBvZiB0aGUgZnVsbFxuLy8gYWJzb2x1dGUgcGF0aCAoc28gdHdvIGNoZWNrb3V0cyB3aXRoIHRoZSBzYW1lIGZvbGRlciBuYW1lIGRvbid0IGNvbGxpZGUpLlxuZXhwb3J0IGZ1bmN0aW9uIHByb2plY3RLZXkocHJvamVjdERpcjogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IGJhc2VuYW1lKHByb2plY3REaXIpLnJlcGxhY2UoL1teYS16QS1aMC05Xy1dL2csIFwiX1wiKSB8fCBcInJvb3RcIjtcbiAgbGV0IGggPSA1MzgxO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHByb2plY3REaXIubGVuZ3RoOyBpKyspIGggPSAoKGggPDwgNSkgKyBoICsgcHJvamVjdERpci5jaGFyQ29kZUF0KGkpKSA+Pj4gMDtcbiAgcmV0dXJuIGAke2Jhc2V9LSR7aC50b1N0cmluZygzNil9YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN0eWxlc0Rpcihob21lOiBzdHJpbmcsIGtleTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4oaG9tZSwgXCJzdHlsZXNcIiwga2V5KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNhdmVTdHlsZShcbiAgaG9tZTogc3RyaW5nLFxuICBrZXk6IHN0cmluZyxcbiAgYXJnczoge1xuICAgIGlkOiBzdHJpbmc7XG4gICAgbGFiZWw6IHN0cmluZztcbiAgICB0ZXh0OiBzdHJpbmc7XG4gICAgc2VjdGlvbnM6IFN0eWxlU2VjdGlvbltdO1xuICAgIGNhbm9uaWNhbEl0ZW1zOiBMaWJyYXJ5SXRlbVtdO1xuICAgIGNyZWF0ZWRBdDogbnVtYmVyO1xuICB9LFxuKTogU2F2ZWRTdHlsZSB7XG4gIGNvbnN0IGRpciA9IHN0eWxlc0Rpcihob21lLCBrZXkpO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3QgY2Fub25pY2FsOiBDYW5vbmljYWxSZWZbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGl0IG9mIGFyZ3MuY2Fub25pY2FsSXRlbXMpIHtcbiAgICBpZiAoIWl0LnBhdGggfHwgIWV4aXN0c1N5bmMoaXQucGF0aCkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGV4dCA9IEVYVF9CWV9NSU1FW2l0Lm1pbWVdID8/IFwiYmluXCI7XG4gICAgY29uc3QgZmlsZSA9IGAke2FyZ3MuaWR9LSR7aXQuaWR9LiR7ZXh0fWA7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIGZpbGUpLCByZWFkRmlsZVN5bmMoaXQucGF0aCkpO1xuICAgICAgY2Fub25pY2FsLnB1c2goeyBpZDogaXQuaWQsIHRpdGxlOiBpdC50aXRsZSwgZmlsZSwgbWltZTogaXQubWltZSB9KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHNraXAgYW4gdW5yZWFkYWJsZSBibG9iICovXG4gICAgfVxuICB9XG4gIGNvbnN0IHN0eWxlOiBTYXZlZFN0eWxlID0ge1xuICAgIGlkOiBhcmdzLmlkLFxuICAgIGxhYmVsOiBhcmdzLmxhYmVsLFxuICAgIHRleHQ6IGFyZ3MudGV4dCxcbiAgICBzZWN0aW9uczogYXJncy5zZWN0aW9ucyxcbiAgICBjYW5vbmljYWwsXG4gICAgY3JlYXRlZEF0OiBhcmdzLmNyZWF0ZWRBdCxcbiAgICBhcmNoaXZlZDogZmFsc2UsXG4gIH07XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIGAke2FyZ3MuaWR9Lmpzb25gKSwgSlNPTi5zdHJpbmdpZnkoc3R5bGUpKTtcbiAgcmV0dXJuIHN0eWxlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbG9hZFRyYXkoaG9tZTogc3RyaW5nLCBrZXk6IHN0cmluZyk6IFNhdmVkU3R5bGVbXSB7XG4gIGNvbnN0IGRpciA9IHN0eWxlc0Rpcihob21lLCBrZXkpO1xuICBpZiAoIWV4aXN0c1N5bmMoZGlyKSkgcmV0dXJuIFtdO1xuICBjb25zdCBvdXQ6IFNhdmVkU3R5bGVbXSA9IFtdO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgcmVhZGRpclN5bmMoZGlyKSkge1xuICAgIGlmICghbmFtZS5lbmRzV2l0aChcIi5qc29uXCIpKSBjb250aW51ZTtcbiAgICB0cnkge1xuICAgICAgb3V0LnB1c2goSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihkaXIsIG5hbWUpLCBcInV0ZjhcIikpIGFzIFNhdmVkU3R5bGUpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogc2tpcCBhIGNvcnJ1cHQgcmVjb3JkICovXG4gICAgfVxuICB9XG4gIHJldHVybiBvdXQuc29ydCgoYSwgYikgPT4gYS5jcmVhdGVkQXQgLSBiLmNyZWF0ZWRBdCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRTdHlsZUFyY2hpdmVkKFxuICBob21lOiBzdHJpbmcsXG4gIGtleTogc3RyaW5nLFxuICBpZDogc3RyaW5nLFxuICBhcmNoaXZlZDogYm9vbGVhbixcbik6IGJvb2xlYW4ge1xuICBjb25zdCBwYXRoID0gam9pbihzdHlsZXNEaXIoaG9tZSwga2V5KSwgYCR7aWR9Lmpzb25gKTtcbiAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gZmFsc2U7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3R5bGUgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpIGFzIFNhdmVkU3R5bGU7XG4gICAgc3R5bGUuYXJjaGl2ZWQgPSBhcmNoaXZlZDtcbiAgICB3cml0ZUZpbGVTeW5jKHBhdGgsIEpTT04uc3RyaW5naWZ5KHN0eWxlKSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF0ZXJpYWxpemVDYW5vbihob21lOiBzdHJpbmcsIGtleTogc3RyaW5nLCBzdHlsZTogU2F2ZWRTdHlsZSk6IENhbm9uSW1nW10ge1xuICBjb25zdCBkaXIgPSBzdHlsZXNEaXIoaG9tZSwga2V5KTtcbiAgY29uc3Qgb3V0OiBDYW5vbkltZ1tdID0gW107XG4gIGZvciAoY29uc3QgcmVmIG9mIHN0eWxlLmNhbm9uaWNhbCkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBieXRlcyA9IHJlYWRGaWxlU3luYyhqb2luKGRpciwgcmVmLmZpbGUpKTtcbiAgICAgIG91dC5wdXNoKHtcbiAgICAgICAgdGl0bGU6IHJlZi50aXRsZSxcbiAgICAgICAgc3JjOiBgZGF0YToke3JlZi5taW1lfTtiYXNlNjQsJHtieXRlcy50b1N0cmluZyhcImJhc2U2NFwiKX1gLFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBza2lwIGEgbWlzc2luZyBibG9iICovXG4gICAgfVxuICB9XG4gIHJldHVybiBvdXQ7XG59XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7O0FBQUEsdUJBQVMsMEJBQVksc0JBQVcsdUJBQVE7QUFDeEM7QUFDQSwwQkFBa0I7QUFDbEI7QUFDQSxzQkFBUzs7O0FDa0xGLElBQU0sb0JBQW9CLE9BQU8sT0FBTztBQUFBLEVBQzdDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRixDQUFVO0FBR0gsU0FBUyxpQkFBaUIsR0FBbUI7QUFBQSxFQUNsRCxPQUFPO0FBQUEsSUFDTDtBQUFBLE1BQ0UsS0FBSztBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsU0FBUztBQUFBLE1BQ1QsU0FBUyxDQUFDO0FBQUEsTUFDVixRQUFRLENBQUM7QUFBQSxJQUNYO0FBQUEsSUFDQTtBQUFBLE1BQ0UsS0FBSztBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsU0FBUztBQUFBLE1BQ1QsU0FBUyxDQUFDO0FBQUEsTUFDVixRQUFRLENBQUM7QUFBQSxJQUNYO0FBQUEsSUFDQTtBQUFBLE1BQ0UsS0FBSztB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QUEsSUFDVCxpQkFBaUI7QUFBQSxJQUNqQixRQUFRO0FBQUEsSUFDUixpQkFBaUI7QUFBQSxJQUNqQixVQUFVLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFBQSxJQUN2QixhQUFhLEVBQUUsUUFBUSxTQUFTLFlBQVksUUFBUSxDQUFDLEVBQUUsS0FBSyxlQUFlO0FBQUE7QUFBQSxFQUVsRixLQUFLLEtBQUssTUFBTSxNQUFNLENBQUM7QUFBQSxFQUV2QixPQUFPLEVBQUUsTUFBTSxXQUFXLFdBQVcsTUFBTSxPQUFPLE1BQU0sU0FBUztBQUFBO0FBd0JuRSxJQUFNLGlCQUFpQjtBQUFBLEVBQ3JCLFFBQVEsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN6QixNQUFNLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDdkIsU0FBUyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQzFCLFNBQVMsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUMxQixTQUFTLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDMUIsT0FBTyxFQUFFLE1BQU0sU0FBUztBQUMxQjtBQUlBLGVBQXNCLElBQUksQ0FBQyxNQUFpQztBQUFBLEVBQzFELElBQUk7QUFBQSxFQUNKLElBQUk7QUFBQSxJQUNGLFFBQVEsY0FBYyxFQUFFLE1BQU0sTUFBTSxTQUFTLGdCQUFnQixRQUFRLEtBQUssQ0FBQyxFQUFFO0FBQUEsSUFJN0UsT0FBTyxHQUFHO0FBQUEsSUFDVixRQUFRLE9BQU8sTUFDYixZQUFZLGFBQWEsUUFBUSxFQUFFLFVBQVUsT0FBTyxDQUFDO0FBQUEsc0JBQzVCLE9BQU8sS0FBSyxjQUFjLEVBQzlDLElBQUksQ0FBQyxNQUFNLEtBQUssR0FBRyxFQUNuQixLQUFLLEdBQUc7QUFBQSxDQUNmO0FBQUEsSUFDQSxPQUFPO0FBQUE7QUFBQSxFQUVULE1BQU0sSUFBSSxNQUFNLFlBQVk7QUFBQSxJQUMxQixNQUFNLE1BQU0sT0FBTyxPQUFPLE1BQU0sSUFBSSxJQUFJO0FBQUEsSUFDeEMsT0FBTyxNQUFNO0FBQUEsSUFDYixRQUFRLE1BQU07QUFBQSxJQUNkLFNBQVMsTUFBTTtBQUFBLElBQ2YsVUFBVSxNQUFNLFVBQVUsT0FBTyxNQUFNLE9BQU8sSUFBSTtBQUFBLElBQ2xELFNBQVMsTUFBTTtBQUFBLEVBQ2pCLENBQUM7QUFBQSxFQUNELFFBQVEsT0FBTyxNQUNiLEdBQUcsS0FBSyxVQUFVLEVBQUUsS0FBSyxvQkFBb0IsRUFBRSxRQUFRLE1BQU0sRUFBRSxNQUFNLFlBQVksRUFBRSxXQUFXLE1BQU0sRUFBRSxLQUFLLENBQUM7QUFBQSxDQUM5RztBQUFBLEVBQ0EsTUFBTSxNQUFNLE1BQU0sRUFBRTtBQUFBLEVBRXBCLE1BQU0sRUFBRTtBQUFBLEVBQ1IsT0FBTyxJQUFJO0FBQUE7QUEwQmIsZUFBc0IsR0FBRyxHQUFvQjtBQUFBLEVBQzNDLE9BQU8sTUFBTSxLQUFLLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztBQUFBOyIsCiAgImRlYnVnSWQiOiAiQzJDMjBGNDBBMUY1NTNGNTY0NzU2RTIxNjQ3NTZFMjEiLAogICJuYW1lcyI6IFtdCn0=
