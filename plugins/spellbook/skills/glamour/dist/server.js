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
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readdirSync, readFileSync as readFileSync4, writeFileSync as writeFileSync3 } from "fs";
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
  for (const name of readdirSync(dir)) {
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

//# debugId=639740B6E599994D64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9zZXJ2ZXIudHMiLCAiLi4vc2hhcmVkL3R5cGVzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc3NlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9wZXJzaXN0LnNlcnZlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvZ2xhbW91ci9iYWNrZW5kL3JlZHVjZS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvZ2xhbW91ci9iYWNrZW5kL3N0eWxlcy5zZXJ2ZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHVubGlua1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgYXMgbm9kZVBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7XG4gIHR5cGUgQWdlbnRDb21tYW5kLFxuICB0eXBlIENsaWVudFRvU2VydmVyLFxuICBkZWZhdWx0U3RhdGUsXG4gIHR5cGUgR2xhbW91clN0YXRlLFxufSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dsYW1vdXIvc2hhcmVkL3R5cGVzXCI7XG5pbXBvcnQgeyB1bmxpbmtJZk1hdGNoZXMsIHdyaXRlRmlsZUF0b21pYyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9kaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB7IGNyZWF0ZUV2ZW50TG9nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2V2ZW50TG9nLnRzXCI7XG5pbXBvcnQgeyBkcmFpbkFuZFN0b3AsIHN0YXJ0SG91c2VrZWVwaW5nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hvdXNla2VlcGluZy50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZU1vZGUgYXMgcmVzb2x2ZU1vZGVJbiwgc2VydmVGcm9tRGlzdCB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9zZXJ2ZURpc3QudHNcIjtcbmltcG9ydCB7IHR5cGUgU3NlQ2xpZW50cywgc3NlUmVzcG9uc2UgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvc3NlLnRzXCI7XG5pbXBvcnQgeyBJRExFX1RJTUVPVVRfU0VDLCBTU0VfSEVBUlRCRUFUX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0XCI7XG5pbXBvcnQgeyBsb2FkU25hcHNob3QsIG1hdGVyaWFsaXplSXRlbSwgc2F2ZVNuYXBzaG90IH0gZnJvbSBcIi4vcGVyc2lzdC5zZXJ2ZXJcIjtcbmltcG9ydCB7XG4gIGFkZEl0ZW0sXG4gIGFkZE1lc3NhZ2UsXG4gIGFubm90YXRlLFxuICBhcHBseUFnZW50TXNnLFxuICBidWlsZFN0eWxlSXRlbSxcbiAgY2xlYXJGb2N1cyxcbiAgbGVhbkl0ZW0sXG4gIGxlYW5TdGF0ZSxcbiAgbWFrZUl0ZW0sXG4gIHNlbGVjdEl0ZW1zLFxuICBzZXRDYW5vbmljYWwsXG4gIHNldEZvY3VzLFxuICBzZXRJdGVtQXJjaGl2ZWQsXG4gIHNldExpa2UsXG4gIHNldFN0YXIsXG59IGZyb20gXCIuL3JlZHVjZVwiO1xuaW1wb3J0IHtcbiAgbG9hZFRyYXksXG4gIG1hdGVyaWFsaXplQ2Fub24sXG4gIHByb2plY3RLZXksXG4gIHNhdmVTdHlsZSxcbiAgc2V0U3R5bGVBcmNoaXZlZCxcbn0gZnJvbSBcIi4vc3R5bGVzLnNlcnZlclwiO1xuXG4vLyBUaGUgc3VyZmFjZSdzIEhUTUwgZW50cnkgdXNlZCB0byBiZSBhIHRvcC1sZXZlbCBzdGF0aWMgaW1wb3J0IGhlcmUuIEEgc3RhdGljXG4vLyBpbXBvcnQgZm9yY2VzIEJ1biB0byByZXNvbHZlIHRoZSB3aG9sZSAudHN4ICsgVGFpbHdpbmQgZ3JhcGggd2hlbiB0aGlzIG1vZHVsZVxuLy8gTE9BRFMsIHNvIGEgZGVzdGluYXRpb24gdGhhdCBzaGlwcyBkaXN0LyBhbmQgbm8gc3VyZmFjZSBzb3VyY2Ug4oCUIHRoZSBwdWJsaXNoZWRcbi8vIGFydGlmYWN0IOKAlCBkaWVzIGJlZm9yZSBpdCBjYW4gc2VydmUgdGhlIGRpc3QgaXQgZG9lcyBoYXZlLiBUaGUgZGV2IGltcG9ydCBpc1xuLy8gdGhlcmVmb3JlIGR5bmFtaWMgYW5kIHJlYWNoZWQgb25seSBvbiB0aGUgZGV2IGJyYW5jaCBiZWxvdyAoc2VhbXMgQ29udHJhY3QgMSksXG4vLyBhcyBhc3Ryb2xhYmUsIGltYWdvIGFuZCBtaW5kLW1hcHBlciBkbyBpdC5cbi8vXG4vLyBQYXRocyBhbmNob3IgYXQgdGhlIFNLSUxMIFJPT1QsIG5ldmVyIGF0IGN3ZDogY2xpLnRzIHBpbnMgdGhlIGRhZW1vbidzIGN3ZCBmb3Jcbi8vIGJ1bmZpZy50b21sJ3Mgc2FrZSBpbiBkZXYgKENvbnRyYWN0IDUpLCBzbyBjd2QgaXMgbm90IGEgc3RhYmxlIGJhc2UgZm9yIGRpc3QvLlxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuXG4vLyByZWxlYXNlIGlmZiBkaXN0L2luZGV4Lmh0bWwgZXhpc3RzIGF0IHRoZSBza2lsbCByb290IOKAlCB0aGUgRklMRSwgbmV2ZXIgdGhlXG4vLyBkaXJlY3RvcnkgKGEgYnVpbHQgYmFja2VuZCBjYW4gcHV0IGNsaS5qcyBpbiBkaXN0LyB3aXRoIG5vIHN1cmZhY2UgdGhlcmUpIOKAlFxuLy8gZWxzZSBkZXY7IHRoZSBlbnYgb3ZlcnJpZGUgd2lucyBlaXRoZXIgd2F5IChDb250cmFjdCAxKS4gUmVsZWFzZTogemVybyByZWFkc1xuLy8gb2Ygc3VyZmFjZSBzb3VyY2Ugb3IgYnVuZmlnLnRvbWwg4oCUIHN0YXRpYyBmaWxlcyBvbmx5LlxuLy9cbi8vIFRoZSBwcmVkaWNhdGUgYW5kIHRoZSBzY2FyIGl0IGNhcnJpZXMgYXJlIG5vdyBgc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50c2A7XG4vLyB3aGF0IHN0YXlzIGhlcmUgaXMgV0hJQ0ggZGlyZWN0b3J5IGdsYW1vdXIgcmVzb2x2ZXMgYWdhaW5zdC4gRXhwb3J0ZWQgYmVjYXVzZVxuLy8gdGhpcyBzcGVsbCdzIG93biBzdWl0ZXMgYXNrIGl0LlxuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKCk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIHJldHVybiByZXNvbHZlTW9kZUluKERJU1RfRElSKTtcbn1cblxuLy8gU2VydmVzIGRpc3QvIHZlcmJhdGltIOKAlCBlbnRyeSBpbmRleC5odG1sLCBoYXNoZWQgY2h1bmtzIGJ5IHBhdGggKENvbnRyYWN0IDInc1xuLy8gZmxhdCwgcmVsYXRpdmUtaHJlZiBsYXlvdXQpLiDim5QgVEhFIFVSTOKGkkZJTEVOQU1FIE1BUFBJTkcgU1RBWVMgSEVSRSBPTiBQVVJQT1NFOlxuLy8gdGhlIGtpdCBkZWNpZGVzIHdoZXRoZXIgYSBmaWxlIG1heSBiZSByZWFkIGFuZCB3aGF0IGNvbnRlbnQgdHlwZSBpdCBnZXRzLCBhbmRcbi8vIHRoZSBDQUxMRVIgZGVjaWRlcyB3aGljaCBmaWxlIOKAlCBiZWNhdXNlIHR3byBzcGVsbHMgcm91dGUgdGhpcyBkaWZmZXJlbnRseSBhbmQgYVxuLy8gc2lnbmF0dXJlIHdpZGUgZW5vdWdoIGZvciBib3RoIHN0b3BzIGJlaW5nIGEgZmlsZSBzZXJ2ZXIuIGdsYW1vdXIncyBvd25cbi8vIGBHRVQgL2Fzc2V0cy88bmFtZT5gIHNlc3Npb24tZmlsZXMgcm91dGUgc2l0cyBBQk9WRSB0aGlzIGluIHRoZSBmZXRjaCBjaGFpbixcbi8vIGFuZCBgc2VydmVGcm9tRGlzdGAgcmVmdXNpbmcgYW55dGhpbmcgd2l0aCBhIHNsYXNoIGluIGl0IGlzIHdoYXQga2VlcHMgdGhlIHR3b1xuLy8gZGlzam9pbnQgKGV2ZXJ5IC9hc3NldHMvIHBhdGggaXMgbmVzdGVkLCBzbyBpdCBpcyByZWZ1c2VkIGhlcmUgYW5kIGZhbGxzXG4vLyB0aHJvdWdoKS5cbmZ1bmN0aW9uIHNlcnZlRGlzdChwYXRoOiBzdHJpbmcpOiBSZXNwb25zZSB8IG51bGwge1xuICByZXR1cm4gc2VydmVGcm9tRGlzdChESVNUX0RJUiwgcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSkpO1xufVxuXG5jb25zdCByYW5kSGV4ID0gKG46IG51bWJlcikgPT5cbiAgQXJyYXkuZnJvbShjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKG5ldyBVaW50OEFycmF5KG4pKSlcbiAgICAubWFwKChiKSA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpXG4gICAgLmpvaW4oXCJcIik7XG5cbmV4cG9ydCB0eXBlIFN0YXJ0T3B0cyA9IHtcbiAgcG9ydD86IG51bWJlcjtcbiAgaG9zdD86IHN0cmluZztcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIGludGVudD86IHN0cmluZztcbiAgcmVzdG9yZT86IHN0cmluZztcbiAgdGltZW91dFM/OiBudW1iZXI7XG4gIHByb2plY3Q/OiBzdHJpbmc7XG59O1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnREYWVtb24ob3B0czogU3RhcnRPcHRzKSB7XG4gIGNvbnN0IEdMQU1PVVJfSE9NRSA9IHByb2Nlc3MuZW52LkdMQU1PVVJfSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuZ2xhbW91clwiKTtcbiAgY29uc3QgU05BUFNIT1RTX0RJUiA9IGpvaW4oR0xBTU9VUl9IT01FLCBcInNuYXBzaG90c1wiKTtcbiAgbGV0IHN0YXRlOiBHbGFtb3VyU3RhdGUgPSBkZWZhdWx0U3RhdGUob3B0cy50aXRsZSA/PyBcIlwiLCBvcHRzLmludGVudCA/PyBcIlwiKTtcbiAgbGV0IHJlc3RvcmVkID0gZmFsc2U7XG4gIGlmIChvcHRzLnJlc3RvcmUpIHtcbiAgICBjb25zdCBwYXRoID0gZXhpc3RzU3luYyhvcHRzLnJlc3RvcmUpXG4gICAgICA/IG9wdHMucmVzdG9yZVxuICAgICAgOiBqb2luKFNOQVBTSE9UU19ESVIsIGAke29wdHMucmVzdG9yZX0uanNvbmApO1xuICAgIHRyeSB7XG4gICAgICBzdGF0ZSA9IGxvYWRTbmFwc2hvdChwYXRoLCBvcHRzLnRpdGxlID8/IFwiXCIsIG9wdHMuaW50ZW50ID8/IFwiXCIpO1xuICAgICAgcmVzdG9yZWQgPSB0cnVlO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBnbGFtb3VyOiByZXN0b3JlIGZhaWxlZCAoJHtwYXRofSk6ICR7ZX1cXG5gKTtcbiAgICB9XG4gIH1cbiAgY29uc3QgUFJPSkVDVF9LRVkgPSBwcm9qZWN0S2V5KG9wdHMucHJvamVjdCA/PyBwcm9jZXNzLmN3ZCgpKTtcbiAgLy8gLS0tIG1vZGUsIHJlc29sdmVkIEJFRk9SRSBhbnkgZmlsZXN5c3RlbSB3cml0ZSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBBIGZvcmNlZC1kZXYgYm9vdCBhdCBhIHN1cmZhY2UtZnJlZSBkZXN0aW5hdGlvbiBtdXN0IGRpZSBIRVJFLCBhdCB0aGUgaW1wb3J0LFxuICAvLyBoYXZpbmcgd3JpdHRlbiBub3RoaW5nOiBubyBzZXNzaW9uLWZpbGVzIGRpciwgbm8gZGlzY292ZXJ5IHBvaW50ZXIuIE1lYXN1cmVkXG4gIC8vIGluIHRoZSBsb2NhbC1zaW06IHdpdGggdGhpcyBibG9jayBwbGFjZWQgYWZ0ZXIgdGhlIHNlc3Npb24tZmlsZXMgbWtkaXIsIGFcbiAgLy8gZHlpbmcgZGFlbW9uIGxlZnQgYCRUTVBESVIvZ2xhbW91ci08aWQ+LWZpbGVzL2AgYmVoaW5kIG9uIGV2ZXJ5IGZhaWxlZCBib290LlxuICBjb25zdCBtb2RlID0gcmVzb2x2ZU1vZGUoKTtcbiAgLy8gZGV2OiB0aGUgZHluYW1pYyBzdHJpbmctbGl0ZXJhbCBpbXBvcnQga2VlcHMgdGhlIHN1cmZhY2UgZ3JhcGggb2ZmIHRoZSBtb2R1bGVcbiAgLy8gbG9hZCBwYXRoIChDb250cmFjdCAxKSDigJQgQnVuIGJ1bmRsZXMgdGhlIC50c3ggZ3JhcGggKyBUYWlsd2luZCBhdCBzZXJ2ZSB0aW1lLFxuICAvLyByZWFkaW5nIGJ1bmZpZy50b21sIGZyb20gY3dkLCB3aGljaCBjbGkudHMgcGlucyB0byBzcmMvZ2xhbW91ci8gKENvbnRyYWN0IDUpLlxuICAvLyByZWxlYXNlOiBkaXN0LyBpcyBzdGF0aWMgYW5kIHByZS1idWlsdCAoQ29udHJhY3QgMikg4oCUIFwiL1wiIGlzIGFuc3dlcmVkIGJ5XG4gIC8vIHNlcnZlRGlzdCgpIGluIHRoZSBmZXRjaCBmYWxsLXRocm91Z2gsIHNvIHRoaXMgYnJhbmNoIG5ldmVyIHRvdWNoZXMgc3VyZmFjZVxuICAvLyBzb3VyY2Ugb3IgYnVuZmlnLnRvbWwgYW5kIG5ldmVyIG5lZWRzIGVpdGhlciB0byBleGlzdC4gQnVuJ3MgUm91dGVzIHR5cGUgdGllc1xuICAvLyB0aGUgXCIvXCIgdmFsdWUncyB0eXBlIHRvIHRoZSBsaXRlcmFsIG9iamVjdCBzaGFwZSwgc28gdGhlIG1vZGUtdGVybmFyeSB1bmlvblxuICAvLyBpcyBjYXN0OyB0aGUgcnVudGltZSBiZWhhdmlvdXIgKEhUTUxCdW5kbGUgaW4gZGV2LCBhYnNlbnQgaW4gcmVsZWFzZSkgaXNcbiAgLy8gY29ycmVjdCBlaXRoZXIgd2F5LiBUaGlzIGlzIHRoZSBPTkUgc3JjLy1uYW1pbmcgc3BlY2lmaWVyIGluIHRoZSBkZXBsb3llZFxuICAvLyBzcGVsbCAocGxhbiBTMiwgcmF0aWZpZWQgYXQgdGhlIHNwZWNpZmllciBncmFpbikuXG4gIGNvbnN0IGRldkluZGV4ID1cbiAgICBtb2RlID09PSBcImRldlwiXG4gICAgICA/IChhd2FpdCBpbXBvcnQoXCIuLi8uLi8uLi8uLi8uLi9zcmMvZ2xhbW91ci9zdXJmYWNlL2luZGV4Lmh0bWxcIikpLmRlZmF1bHRcbiAgICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCByb3V0ZXMgPSAoZGV2SW5kZXggPyB7IFwiL1wiOiBkZXZJbmRleCB9IDoge30pIGFzIFJlY29yZDxzdHJpbmcsIG5ldmVyPjtcbiAgLy8gTG9hZCB0aGUgcHJvamVjdCdzIHNhdmVkIHN0eWxlcyBpbnRvIHRoZSB0cmF5IChtZXRhZGF0YSBvbmx5IOKAlCBOT1QgdGhlXG4gIC8vIGxpYnJhcnkpLiBEbyB0aGlzIGFmdGVyIHJlc3RvcmUgc28gYSByZXN0b3JlZCBzbmFwc2hvdCdzIHN0YWxlIHRyYXkgaXNcbiAgLy8gcmVwbGFjZWQgYnkgdGhlIGF1dGhvcml0YXRpdmUgb24tZGlzayBzZXQuXG4gIHN0YXRlLnRyYXkgPSBsb2FkVHJheShHTEFNT1VSX0hPTUUsIFBST0pFQ1RfS0VZKTtcblxuICAvLyAtLS0gY2hhbm5lbHMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHNvY2tldHMgPSBuZXcgU2V0PGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4+KCk7XG4gIC8vIFRoZSByZXBsYXkgbG9nIGJlaGluZCBgR0VUIC9ldmVudHM/c2luY2U9PGlkPmAg4oCUIHNoYXJlZFxuICAvLyAoYGtpdC93aXJlL2V2ZW50TG9nLnRzYCksIHNvIGdsYW1vdXIgaW5oZXJpdHMgdGhlIGJvdW5kZWQgYnVmZmVyLCB0aGVcbiAgLy8gbW9ub3RvbmljIGlkIHRoYXQgYWN0dWFsbHkgV0lOUyBvdmVyIGEgcGF5bG9hZCBgaWRgLCBhbmQgdGhlIHN0YWxlLXdhdGVybWFya1xuICAvLyByZXBsYXkgdGhhdCBsZXRzIGEgdGFpbCByZXN1bWluZyBhZ2FpbnN0IGEgcmVzdGFydGVkIGRhZW1vbiByZWNlaXZlIGFueXRoaW5nXG4gIC8vIGF0IGFsbC4gZ2xhbW91ciBzdGFtcHMgTk8gRVBPQ0g6IGEgc2Vzc2lvbiBpcyBpZGVudGlmaWVkIGJ5IGBzZXNzaW9uX2lkYCwgYVxuICAvLyByZXN0YXJ0IGlzIGEgZGlmZmVyZW50IHNlc3Npb24sIGFuZCBhIHJlc3VtaW5nIHRhaWwgaXMgYWxyZWFkeSB0YWxraW5nIHRvIGFcbiAgLy8gZGlmZmVyZW50IGRhZW1vbiBieSBuYW1lIChEMTkncyByZWFzb25pbmcgZm9yIG1hZ3BpZSwgYW5kIGl0IGlzIGdsYW1vdXIncyB0b28pLlxuICBjb25zdCBsb2cgPSBjcmVhdGVFdmVudExvZzxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oKTtcbiAgY29uc3Qgc3NlQ2xpZW50czogU3NlQ2xpZW50cyA9IG5ldyBTZXQoKTtcbiAgbGV0IGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICBjb25zdCB0b3VjaCA9ICgpID0+IHtcbiAgICBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgfTtcblxuICBjb25zdCBicm9hZGNhc3QgPSAobXNnOiBvYmplY3QpID0+IHtcbiAgICBjb25zdCBzID0gSlNPTi5zdHJpbmdpZnkobXNnKTtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLnNlbmQocyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogc29ja2V0IGNsb3NlZCAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcbiAgbGV0IHNuYXBEaXJ0eSA9IGZhbHNlO1xuICBjb25zdCBicm9hZGNhc3RTdGF0ZSA9ICgpID0+IHtcbiAgICBzbmFwRGlydHkgPSB0cnVlO1xuICAgIGJyb2FkY2FzdCh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGUgfSk7XG4gIH07XG4gIGNvbnN0IGVtaXRFdmVudCA9IChtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBsb2cuZW1pdChtc2cpO1xuXG4gIC8vIFByZXNlbmNlIGlzIHRyYW5zaWVudDogc3RyZWFtIHRvIGxpdmUgU1NFIGNsaWVudHMgYnV0IERPIE5PVCBzdG9yZSBpdCBpblxuICAvLyB0aGUgcmVwbGF5IGxvZyAoYSByZWNvbm5lY3RpbmcgYWdlbnQgc2hvdWxkIG5vdCByZS1zZWUgZXZlcnkgcGFzdFxuICAvLyBjb25uZWN0L2Rpc2Nvbm5lY3QpLiBObyBpZCBpcyBhc3NpZ25lZCwgc28gaXQgbmV2ZXIgYWR2YW5jZXMgYSB0YWlsIGN1cnNvci5cbiAgLy9cbiAgLy8g4puUIFRISVMgSVMgVEhFIE9ORSBUSElORyBUSEUgU0hBUkVEIFNTRSBNT0RVTEUgQ09VTEQgTk9UIERPLCBBTkQgSVQgV0FTXG4gIC8vIFdJREVORUQgUkFUSEVSIFRIQU4gV09SS0VEIEFST1VORC4gYFNzZUNsaWVudHNgIGhlbGQgYmFyZSBjbG9zZXJzLCBiZWNhdXNlXG4gIC8vIGFzdHJvbGFiZSBhbmQgbWFncGllIGFubm91bmNlIHByZXNlbmNlIG92ZXIgdGhlaXIgYnJvd3NlciBXRUJTT0NLRVQgYW5kIG5ldmVyXG4gIC8vIG5lZWRlZCB0byBwdXNoIGFuIHVubG9nZ2VkIGZyYW1lIGF0IHRoZSBhZ2VudCdzIHRhaWwuIEtlZXBpbmcgYSBzZWNvbmQsXG4gIC8vIHBhcmFsbGVsIGBTZXQ8UmVhZGFibGVTdHJlYW1EZWZhdWx0Q29udHJvbGxlcj5gIGhlcmUgd291bGQgaGF2ZSByZS1jcmVhdGVkXG4gIC8vIGV4YWN0bHkgdGhlIGRyaWZ0IHRoZSByZWdpc3RyeSBleGlzdHMgdG8gcmVtb3ZlIOKAlCBhbmQgaXQgaXMgdGhlIGRyaWZ0IHRoYXRcbiAgLy8gbW9kdWxlJ3Mgb3duIGhlYWRlciB3YXJucyBhYm91dCwgd2hlcmUgYSBwZXItc3RyZWFtIHRpbWVyIHdhcyBzd2VwdCBmcm9tIGFcbiAgLy8gc2Vjb25kIHNldCBhbmQgY291bGQgZmFsbCBvdXQgb2Ygc3RlcC4gU28gdGhlIHJlZ2lzdHJ5IGVudHJ5IGdhaW5lZCBgc2VuZGAsXG4gIC8vIHdoaWNoIHJvdXRlcyB0aHJvdWdoIHRoZSBzYW1lIGNsb3NlZC1jaGVjayBhbmQgdGVhcmRvd24gZnVubmVsIGFzIGV2ZXJ5IG90aGVyXG4gIC8vIHdyaXRlLiBSZXBvcnRlZCBhcyBhIGZpbmRpbmcgYWJvdXQgdGhlIG1vZHVsZSwgcGVyIHRoZSBwaGFzZSBicmllZi5cbiAgY29uc3QgZW1pdFRyYW5zaWVudCA9IChtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgY29uc3QgZnJhbWUgPSBgZGF0YTogJHtKU09OLnN0cmluZ2lmeShtc2cpfVxcblxcbmA7XG4gICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIGMuc2VuZChmcmFtZSk7XG4gIH07XG5cbiAgLy8gLS0tIHNlc3Npb24gZmlsZXMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzZXNzaW9uSWQgPSBgZ2xhbW91ci0ke3JhbmRIZXgoNCl9YDtcbiAgY29uc3Qgc2Vzc2lvbkZpbGVzRGlyID0gam9pbih0bXBkaXIoKSwgYCR7c2Vzc2lvbklkfS1maWxlc2ApO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhzZXNzaW9uRmlsZXNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIGJhY2sgdG8gbm8gcGF0aHMgKi9cbiAgfVxuICBpZiAocmVzdG9yZWQpIHtcbiAgICBmb3IgKGNvbnN0IGl0IG9mIHN0YXRlLmxpYnJhcnkpIG1hdGVyaWFsaXplSXRlbShzZXNzaW9uRmlsZXNEaXIsIGl0KTtcbiAgfVxuXG4gIC8vIC0tLSBhZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBsZXQgcmVzb2x2ZURvbmUhOiAodjogeyBjb2RlOiBudW1iZXI7IHJlYXNvbjogc3RyaW5nIH0pID0+IHZvaWQ7XG4gIGNvbnN0IGRvbmUgPSBuZXcgUHJvbWlzZTx7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmcgfT4oKHIpID0+IHtcbiAgICByZXNvbHZlRG9uZSA9IHI7XG4gIH0pO1xuXG4gIC8vICM4NCDigJQgUkVUVVJOUyBBIFZFUkRJQ1QuIFByZXZpb3VzbHkgdm9pZCwgc28gdGhlIC9jbWQgcm91dGUgaGFkIG5vdGhpbmcgdG9cbiAgLy8gcmVwb3J0IGFuZCBhbnN3ZXJlZCBhIGxpdGVyYWwge29rOnRydWV9IHRvIGV2ZXJ5IGNvbW1hbmQgaW5jbHVkaW5nIG9uZXMgaXRcbiAgLy8gZHJvcHBlZC4gTm90ZSB0aGUgZGVmZWN0IGlzIE5PVCBhIG1pc3NpbmcgYGF3YWl0YDogdGhpcyBoYW5kbGVyIGlzXG4gIC8vIHN5bmNocm9ub3VzLCBhbmQgaW1hZ28ncyB0d2luIElTIGNvcnJlY3RseSBhd2FpdGVkIGFuZCB3YXMgYnJva2VuIGFueXdheS5cbiAgLy8gVGhlIGZpeCBpcyB0aGF0IGEgZGVjaXNpb24gZXhpc3RzIGF0IGFsbC5cbiAgLy8gQ29udHJhY3QgMTM6IHRoZSB2ZXJkaWN0IG9yaWdpbmF0ZXMgaW4gdGhlIGNvZGUgb3duaW5nIHRoZSByZWNvZ25pc2VkIHNldC5cbiAgLy8gYjEyIHdpZGVucyB0aGUgUkVUVVJOIHdpdGhvdXQgd2lkZW5pbmcgdGhlIENPTlRSQUNUIOKAlCBhIGNvbW1hbmQgbWF5IGFuc3dlclxuICAvLyB3aXRoIGEgcmVzdWx0IG9iamVjdCBjYXJyeWluZyBpdHMgb3duIHBheWxvYWQgaW5zdGVhZCBvZiB0aGUgYm9vbGVhbi4gRXZlcnlcbiAgLy8gb3RoZXIgY29tbWFuZCBzdGlsbCByZXR1cm5zIGEgYmFyZSBib29sZWFuIGFuZCBpdHMgcmVzcG9uc2UgaXNcbiAgLy8gYnl0ZS1pZGVudGljYWwuIFNhbWUgc2hhcGUgYXMgaW1hZ28ncyBjb250ZXh0LmFkZCAoNWU2YWFjZCkuXG4gIHR5cGUgQWdlbnRWZXJkaWN0ID0gYm9vbGVhbiB8IHsgcmVjb2duaXNlZDogdHJ1ZTsgb2s6IHRydWU7IGRldGFpbDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfTtcbiAgY29uc3QgaGFuZGxlQWdlbnRNc2cgPSAobXNnOiBBZ2VudENvbW1hbmQpOiBBZ2VudFZlcmRpY3QgPT4ge1xuICAgIGlmIChtc2cudHlwZSA9PT0gXCJzYXlcIikge1xuICAgICAgYWRkTWVzc2FnZShzdGF0ZSwge1xuICAgICAgICBpZDogYG0tJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgIHdobzogXCJhZ2VudFwiLFxuICAgICAgICBraW5kOiBtc2cua2luZCA/PyBcImluZm9cIixcbiAgICAgICAgdGV4dDogbXNnLnRleHQsXG4gICAgICAgIGdyb3VuZDogW10sXG4gICAgICAgIHRzOiBEYXRlLm5vdygpLFxuICAgICAgfSk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChtc2cudHlwZSA9PT0gXCJjbG9zZVwiKSB7XG4gICAgICByZXNvbHZlRG9uZSh7IGNvZGU6IDAsIHJlYXNvbjogXCJjbG9zZVwiIH0pO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChtc2cudHlwZSA9PT0gXCJnZW4uYWRkXCIpIHtcbiAgICAgIGNvbnN0IGl0ID0gbWFrZUl0ZW0oe1xuICAgICAgICBpZDogYGdlbi0ke3JhbmRIZXgoNCl9YCxcbiAgICAgICAga2luZDogXCJnZW5cIixcbiAgICAgICAgdGl0bGU6IG1zZy5sYWJlbCA/PyBgcm91bmQgJHttc2cucm91bmR9YCxcbiAgICAgICAgc3JjOiBtc2cuc3JjLFxuICAgICAgICBtaW1lOiBcImltYWdlL3dlYnBcIixcbiAgICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgICBnZW46IHtcbiAgICAgICAgICBtb2RlbDogbXNnLm1vZGVsLFxuICAgICAgICAgIHByb21wdDogbXNnLnByb21wdCxcbiAgICAgICAgICBzZWVkOiBtc2cuc2VlZCA/PyBudWxsLFxuICAgICAgICAgIGNvc3Q6IG1zZy5jb3N0ID8/IG51bGwsXG4gICAgICAgICAgY3VzdG9tOiBtc2cuY3VzdG9tID8/IHt9LFxuICAgICAgICAgIHJvdW5kOiBtc2cucm91bmQsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIG1hdGVyaWFsaXplSXRlbShzZXNzaW9uRmlsZXNEaXIsIGl0KTtcbiAgICAgIC8vIGIxMiArICM4NyAodGhpcmQgc3BlbGwpIOKAlCBgaWYgKGFkZEl0ZW0oc3RhdGUsIGl0KSkgYnJvYWRjYXN0U3RhdGUoKWBcbiAgICAgIC8vIGRyb3BwZWQgdGhlIG11dGF0b3IncyBvdXRjb21lIGludG8gY29udHJvbCBmbG93IGFuZCBhbnN3ZXJlZCBvazp0cnVlXG4gICAgICAvLyBlaXRoZXIgd2F5LiBUd28gdGhpbmdzIHdlcmUgd3JvbmcgYW5kIG9ubHkgb25lIGlzIHdoYXQgdGhlIGNhcmQgc2FpZDpcbiAgICAgIC8vXG4gICAgICAvLyAgIFJFQUNIQUJMRSwgZXZlcnkgY2FsbDogdGhlIG1pbnRlZCBpZCB3YXMgRElTQ0FSREVELCBzbyB0aGUgYWdlbnQgdGhhdFxuICAgICAgLy8gICBqdXN0IGNyZWF0ZWQgYW4gaXRlbSBjb3VsZCBub3QgcmVmZXJlbmNlIGl0LiBUaGF0IGlzICM4NydzIGRlZmVjdCBpbiBhXG4gICAgICAvLyAgIHRoaXJkIGNvZGViYXNlIChpbWFnbyBjb250ZXh0LmFkZCwgYW5kIHRoaXMpLlxuICAgICAgLy9cbiAgICAgIC8vICAgTk9UIFJFQUNIQUJMRSBpbiBwcmFjdGljZTogdGhlIFwic2lsZW50IGRlZHVwZVwiLiBgaWRgIGlzIG1pbnRlZCBIRVJFXG4gICAgICAvLyAgIChgZ2VuLSR7cmFuZEhleCg0KX1gKSBhbmQgdGhlIGNhbGxlciBjYW5ub3Qgc3VwcGx5IG9uZSDigJQgYGJ1aWxkR2VuQ21kYFxuICAgICAgLy8gICBoYXMgbm8gaWQgZmllbGQsIGFuZCB0aGlzIGxpbmUgaWdub3JlcyBhbnkgdGhhdCBhcnJpdmVkIOKAlCBzbyBhZGRJdGVtXG4gICAgICAvLyAgIHJldHVybnMgZmFsc2Ugb25seSBvbiBhIDJeMzIgY29sbGlzaW9uLiBUaGUgYnJhbmNoIHdhcyBkZWFkLCBub3RcbiAgICAgIC8vICAgZGFuZ2Vyb3VzLiBJdCBpcyByZXBvcnRlZCBob25lc3RseSBub3cgcmF0aGVyIHRoYW4gcmVtb3ZlZCwgYmVjYXVzZSBhXG4gICAgICAvLyAgIGNvbGxpc2lvbiB0aGF0IERJRCBoYXBwZW4gd291bGQgb3RoZXJ3aXNlIGJlIHRoZSBzaWxlbnQgY2FzZS5cbiAgICAgIGNvbnN0IGFkZGVkID0gYWRkSXRlbShzdGF0ZSwgaXQpO1xuICAgICAgaWYgKGFkZGVkKSBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcmVjb2duaXNlZDogdHJ1ZSxcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIGRldGFpbDogeyBpZDogaXQuaWQsIG91dGNvbWU6IGFkZGVkID8gXCJjcmVhdGVkXCIgOiBcImFscmVhZHktcmVjb3JkZWRcIiB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKG1zZy50eXBlID09PSBcInN0eWxlLnNhdmVcIikge1xuICAgICAgY29uc3QgY2Fub25pY2FsSXRlbXMgPSBzdGF0ZS5saWJyYXJ5LmZpbHRlcigoaSkgPT4gaS5jYW5vbmljYWwgJiYgIWkuYXJjaGl2ZWQpO1xuICAgICAgY29uc3QgYWdyZWVkID0gc3RhdGUuc3R5bGVHdWlkZS5maWx0ZXIoKHMpID0+IHMuc3RhdHVzICE9PSBcImVtcHR5XCIgJiYgcy5jb250ZW50KTtcbiAgICAgIGNvbnN0IHRleHQgPSBhZ3JlZWRcbiAgICAgICAgLm1hcCgocykgPT4gcy5jb250ZW50KVxuICAgICAgICAuam9pbihcIiDCtyBcIilcbiAgICAgICAgLnNsaWNlKDAsIDI4MCk7XG4gICAgICBjb25zdCBzdHlsZSA9IHNhdmVTdHlsZShHTEFNT1VSX0hPTUUsIFBST0pFQ1RfS0VZLCB7XG4gICAgICAgIGlkOiBgc3R5bGUtJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgIGxhYmVsOiBtc2cubGFiZWwsXG4gICAgICAgIHRleHQsXG4gICAgICAgIHNlY3Rpb25zOiBzdGF0ZS5zdHlsZUd1aWRlLFxuICAgICAgICBjYW5vbmljYWxJdGVtcyxcbiAgICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgfSk7XG4gICAgICBzdGF0ZS50cmF5LnB1c2goc3R5bGUpO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAobXNnLnR5cGUgPT09IFwic3R5bGUuYXJjaGl2ZVwiKSB7XG4gICAgICBzZXRTdHlsZUFyY2hpdmVkKEdMQU1PVVJfSE9NRSwgUFJPSkVDVF9LRVksIG1zZy5pZCwgbXNnLmFyY2hpdmVkKTtcbiAgICAgIGFwcGx5QWdlbnRNc2coc3RhdGUsIG1zZyk7IC8vIGZsaXBzIHRoZSBpbi1tZW1vcnkgdHJheSBlbnRyeVxuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICAvLyBUaGUgZmFsbHRocm91Z2ggaXMgdGhlIG9ubHkgcGF0aCB0aGF0IGNhbiBiZSBVTlJFQ09HTklTRUQsIGFuZCB0aGVcbiAgICAvLyByZWR1Y2VyIGlzIHdoYXQga25vd3M6IGl0IG93bnMgdGhlIGNhc2UgbGlzdCwgc28gdGhlIHZlcmRpY3QgY29tZXMgZnJvbVxuICAgIC8vIHRoZXJlIHJhdGhlciB0aGFuIGZyb20gYSBzZWNvbmQgZW51bWVyYXRpb24gaGVyZS5cbiAgICBjb25zdCByZWNvZ25pc2VkID0gYXBwbHlBZ2VudE1zZyhzdGF0ZSwgbXNnKTtcbiAgICBpZiAocmVjb2duaXNlZCkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4gcmVjb2duaXNlZDtcbiAgfTtcblxuICAvLyAtLS0gYnJvd3NlciBtZXNzYWdlcyAoV2ViU29ja2V0KSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgaGFuZGxlQ2xpZW50TXNnID0gKG1zZzogQ2xpZW50VG9TZXJ2ZXIpID0+IHtcbiAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XG4gICAgICBjYXNlIFwiaXRlbS5hZGRcIjoge1xuICAgICAgICBjb25zdCBpdCA9IG1ha2VJdGVtKHtcbiAgICAgICAgICBpZDogYCR7bXNnLml0ZW0ua2luZH0tJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgICAga2luZDogbXNnLml0ZW0ua2luZCxcbiAgICAgICAgICB0aXRsZTogbXNnLml0ZW0udGl0bGUsXG4gICAgICAgICAgc3JjOiBtc2cuaXRlbS5zcmMsXG4gICAgICAgICAgdGV4dDogbXNnLml0ZW0udGV4dCxcbiAgICAgICAgICBtaW1lOiBtc2cuaXRlbS5taW1lID8/IFwiXCIsXG4gICAgICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgICB9KTtcbiAgICAgICAgbWF0ZXJpYWxpemVJdGVtKHNlc3Npb25GaWxlc0RpciwgaXQpO1xuICAgICAgICBpZiAoYWRkSXRlbShzdGF0ZSwgaXQpKSB7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgICBlbWl0RXZlbnQoe1xuICAgICAgICAgICAgdHlwZTogXCJpdGVtLmFkZFwiLFxuICAgICAgICAgICAgaXRlbTogbGVhbkl0ZW0oaXQpLFxuICAgICAgICAgICAgc2VsZWN0ZWRJZHM6IHN0YXRlLnNlbGVjdGVkSWRzLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcIml0ZW0uc2VsZWN0XCI6XG4gICAgICAgIHNlbGVjdEl0ZW1zKHN0YXRlLCBtc2cuaWRzKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5zdGFyXCI6XG4gICAgICAgIGlmIChzZXRTdGFyKHN0YXRlLCBtc2cuaWQsIG1zZy5zdGFycmVkKSkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5saWtlXCI6XG4gICAgICAgIGlmIChzZXRMaWtlKHN0YXRlLCBtc2cuaWQsIG1zZy5saWtlZCkpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIml0ZW0uYW5ub3RhdGVcIjpcbiAgICAgICAgLy8gQW1iaWVudDogdGhlIGh1bWFuJ3MgcGVyLWl0ZW0gbm90ZSBpcyBzdG9yZWQgKyBVSS1zeW5jZWQgKyBwZXJzaXN0ZWQsXG4gICAgICAgIC8vIGFuZCB0aGUgYWdlbnQgcmVhZHMgaXQgb24gZGVtYW5kIGZyb20gc3RhdGUgd2hlbiBpdCBsb29rcyBhdCB0aGUgaW1hZ2UuXG4gICAgICAgIC8vIEl0IGlzIE5PVCBwdXNoZWQgYXMgYW4gYWdlbnQgZXZlbnQg4oCUIGEgc3RpY2t5IG5vdGUsIG5vdCBhIHJlYWwtdGltZVxuICAgICAgICAvLyBzaWduYWwgKHNlZSB0aGUgZXZlbnQtdm9sdW1lIGxlc3NvbjsgYXZvaWRzIGludGVycnVwdGluZyB0aGUgYWdlbnQgb25cbiAgICAgICAgLy8gZXZlcnkgYmx1cikuXG4gICAgICAgIGlmIChhbm5vdGF0ZShzdGF0ZSwgbXNnLmlkLCBcImh1bWFuXCIsIG1zZy5odW1hbikpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIm1lc3NhZ2Uuc2VuZFwiOiB7XG4gICAgICAgIGNvbnN0IGdyb3VuZCA9IFsuLi5zdGF0ZS5zZWxlY3RlZElkc107XG4gICAgICAgIGFkZE1lc3NhZ2Uoc3RhdGUsIHtcbiAgICAgICAgICBpZDogYG0tJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgICAgd2hvOiBcInVzZXJcIixcbiAgICAgICAgICBraW5kOiBcImluZm9cIixcbiAgICAgICAgICB0ZXh0OiBtc2cudGV4dCxcbiAgICAgICAgICBncm91bmQsXG4gICAgICAgICAgdHM6IERhdGUubm93KCksXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcIm1lc3NhZ2UudXNlclwiLCB0ZXh0OiBtc2cudGV4dCwgZ3JvdW5kIH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmb2N1cy5zZXRcIjpcbiAgICAgICAgc2V0Rm9jdXMoc3RhdGUsIG1zZy5pZHMsIFwieW91XCIpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJmb2N1cy5jbGVhclwiOlxuICAgICAgICBjbGVhckZvY3VzKHN0YXRlKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5jYW5vbmljYWxcIjpcbiAgICAgICAgaWYgKHNldENhbm9uaWNhbChzdGF0ZSwgbXNnLmlkLCBtc2cuY2Fub25pY2FsKSkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5hcmNoaXZlXCI6XG4gICAgICAgIGlmIChzZXRJdGVtQXJjaGl2ZWQoc3RhdGUsIG1zZy5pZCwgbXNnLmFyY2hpdmVkKSkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwic3R5bGUuYnJpbmdJblwiOiB7XG4gICAgICAgIGNvbnN0IHN0eWxlID0gc3RhdGUudHJheS5maW5kKChzKSA9PiBzLmlkID09PSBtc2cuaWQpO1xuICAgICAgICBpZiAoIXN0eWxlKSBicmVhaztcbiAgICAgICAgY29uc3QgaXRlbUlkID0gYHN0eWxlLSR7c3R5bGUuaWR9YDtcbiAgICAgICAgaWYgKHN0YXRlLmxpYnJhcnkuc29tZSgoaSkgPT4gaS5pZCA9PT0gaXRlbUlkKSkgYnJlYWs7IC8vIGlkZW1wb3RlbnRcbiAgICAgICAgY29uc3QgY2Fub24gPSBtYXRlcmlhbGl6ZUNhbm9uKEdMQU1PVVJfSE9NRSwgUFJPSkVDVF9LRVksIHN0eWxlKTtcbiAgICAgICAgY29uc3QgaXQgPSBidWlsZFN0eWxlSXRlbShzdHlsZSwgY2Fub24sIERhdGUubm93KCkpO1xuICAgICAgICBpZiAoYWRkSXRlbShzdGF0ZSwgaXQpKSB7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcIml0ZW0uYWRkXCIsIGl0ZW06IGxlYW5JdGVtKGl0KSwgc2VsZWN0ZWRJZHM6IHN0YXRlLnNlbGVjdGVkSWRzIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICAvLyBHRVQgL2V2ZW50cz9zaW5jZT08aWQ+IOKAlCByZXBsYXksIHRoZW4gc3RheSBvcGVuIGZvciBsaXZlIGZyYW1lcyBwbHVzIGFcbiAgLy8gaGVhcnRiZWF0IGNvbW1lbnQuIE9uZSBjYWxsIGludG8gYGtpdC93aXJlL3NzZS50c2AsIHdoaWNoIGlzIHdoZXJlIHRoZVxuICAvLyB0ZWFyZG93biBmdW5uZWwgbGl2ZXM6IGBjYW5jZWwoKWAsIGByZXEuc2lnbmFsYCBhbmQgYSBmYWlsZWQgZW5xdWV1ZSBhbGxcbiAgLy8gcmVhY2ggaXQsIGF0IG1vc3Qgb25jZSwgYW5kIHRoYXQgZnVubmVsIGlzIHdoYXQgYm91bmRzIHRoZSBzdWJzY3JpYmVyIGNvdW50XG4gIC8vIHRoZSBpZGxlIHN3ZWVwIHJlYWRzLiBUaGUgb2xkIGNvcHkgaGVyZSByZWxpZWQgb24gYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgdG9cbiAgLy8gbm90aWNlIGEgZGVwYXJ0ZWQgY2xpZW50LCB3aGljaCB3YXMgTUVBU1VSRUQgb24gQnVuIDEuMy4xNCBub3QgdG8gd29yayDigJRcbiAgLy8gZW5xdWV1ZSBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gYnVmZmVycyBzaWxlbnRseSBhbmQgbmV2ZXIgdGhyb3dzIOKAlCBhbmQgaXQgd2FzXG4gIC8vIG5vdCB3aXJlZCB0byBgcmVxLnNpZ25hbGAgYXQgYWxsLCBzbyBhIGNsaWVudCB0aGF0IHZhbmlzaGVkIHdpdGhvdXRcbiAgLy8gY2FuY2VsbGluZyB3YXMgY291bnRlZCBhcyBwcmVzZW50IGZvciB0aGUgbGlmZSBvZiB0aGUgZGFlbW9uLlxuICAvL1xuICAvLyDimqAgQU5EIFRIRSBIRUFSVEJFQVQgSVMgTk8gTE9OR0VSIEEgTElURVJBTC4gSXQgd2FzIGAxNTAwMGAsIGhhcmQtY29kZWQgaGVyZSxcbiAgLy8gYmVzaWRlIGEgYEJ1bi5zZXJ2ZWAgYGlkbGVUaW1lb3V0OiAyNTVgIGFuZCBhIGNvbW1lbnQgZXhwbGFpbmluZyB0aGF0IHRoZSB0d29cbiAgLy8gYXJlIGNoYWluZWQuIFRoZXkgbm93IGNvbWUgZnJvbSBgLi9oZWFydGJlYXQudHNgLCB3aGljaCBkZXJpdmVzIHRoZSBwYWlyIOKAlCBzb1xuICAvLyB0aGUgaW52YXJpYW50IGhvbGRzIGZvciBhbnkgdmFsdWUsIG5vdCBvbmx5IGZvciB0aGUgdHdvIHRoYXQgaGFwcGVuZWQgdG8gYmVcbiAgLy8gd3JpdHRlbi5cbiAgY29uc3QgZXZlbnRzUmVzcG9uc2UgPSAocmVxOiBSZXF1ZXN0LCB1cmw6IFVSTCk6IFJlc3BvbnNlID0+IHtcbiAgICB0b3VjaCgpO1xuICAgIHJldHVybiBzc2VSZXNwb25zZSh7XG4gICAgICBsb2csXG4gICAgICBzaW5jZTogTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic2luY2VcIikgPz8gXCItMVwiLCAxMCksXG4gICAgICBoZWFydGJlYXRNczogU1NFX0hFQVJUQkVBVF9NUyxcbiAgICAgIGNsaWVudHM6IHNzZUNsaWVudHMsXG4gICAgICBzaWduYWw6IHJlcS5zaWduYWwsXG4gICAgICBvbk9wZW46IHRvdWNoLFxuICAgICAgb25DbG9zZTogdG91Y2gsXG4gICAgfSk7XG4gIH07XG5cbiAgLy8gLS0tIHNlcnZlIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzZXJ2ZXIgPSBCdW4uc2VydmUoe1xuICAgIHBvcnQ6IG9wdHMucG9ydCA/PyAwLFxuICAgIGhvc3RuYW1lOiBvcHRzLmhvc3QgPz8gXCIxMjcuMC4wLjFcIixcbiAgICByb3V0ZXMsXG4gICAgLy8g4puUIEhFTEQgU1NFIENPTk5FQ1RJT05TIERJRSBXSVRIT1VUIFRISVMuIEJ1bidzIGRlZmF1bHQgcmVxdWVzdFxuICAgIC8vIGlkbGVUaW1lb3V0IGlzIDEwcyBhbmQgYSBzZXJ2ZXItc2VudCBoZWFydGJlYXQgZG9lcyBOT1QgcmVzZXQgaXQsIHNvIGFuXG4gICAgLy8gU1NFIGNsaWVudCBpcyBjbG9zZWQgYmVmb3JlIHRoZSAxNXMgYDogaGJgIGJlbG93IGV2ZXIgZmlyZXMg4oCUIHRoZVxuICAgIC8vIGtlZXBhbGl2ZSBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzIGtlZXBpbmcgYWxpdmUgaXNcbiAgICAvLyBnb25lLCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IHJhdGUgd291bGQgbm90IGhhdmUgaGVscGVkLlxuICAgIC8vIDI1NSBpcyBCdW4ncyBtYXhpbXVtICgwIGlzIG5vdCBcImRpc2FibGVkXCIpLCBtYXRjaGluZyBib3VudHksIGdyYXBldmluZVxuICAgIC8vIGFuZCBtaW5kLW1hcHBlcjsgYXN0cm9sYWJlIGVudi10dW5lcyBpdCBhbmQgY2xhbXBzIHRoZSBoZWFydGJlYXQgdG8gaGFsZi5cbiAgICAvLyBGb3VuZCAyMDI2LTA5LTA4IGJ5IHRoZSBiYWNrZW5kIGR1cGxpY2F0aW9uIHJlY29uOiBmb3VyIHNwZWxscyBoYWQgaGl0XG4gICAgLy8gdGhpcyBhbmQgZml4ZWQgaXQsIHRocmVlIGhhZCBub3QsIGJlY2F1c2UgdGhlIGRhZW1vbiBzcGluZSBpcyBvbmUgZGVzaWduXG4gICAgLy8gaW1wbGVtZW50ZWQgc2l4IHRpbWVzLlxuICAgIGlkbGVUaW1lb3V0OiBJRExFX1RJTUVPVVRfU0VDLFxuICAgIGRldmVsb3BtZW50OiB7IGhtcjogbW9kZSA9PT0gXCJkZXZcIiB9LFxuICAgIGZldGNoKHJlcSwgc3J2KSB7XG4gICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwpO1xuICAgICAgY29uc3QgcGF0aCA9IHVybC5wYXRobmFtZTtcbiAgICAgIGlmIChwYXRoID09PSBcIi93c1wiKVxuICAgICAgICByZXR1cm4gc3J2LnVwZ3JhZGUocmVxKSA/IHVuZGVmaW5lZCA6IG5ldyBSZXNwb25zZShcInVwZ3JhZGUgcmVxdWlyZWRcIiwgeyBzdGF0dXM6IDQyNiB9KTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL3N0YXRlXCIpIHtcbiAgICAgICAgdG91Y2goKTtcbiAgICAgICAgY29uc3QgbGVhbiA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwibGVhblwiKSA9PT0gXCIxXCI7XG4gICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHtcbiAgICAgICAgICBzdGF0ZTogbGVhbiA/IGxlYW5TdGF0ZShzdGF0ZSkgOiBzdGF0ZSxcbiAgICAgICAgICBjdXJzb3I6IGxvZy5jdXJzb3IoKSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9ldmVudHNcIikgcmV0dXJuIGV2ZW50c1Jlc3BvbnNlKHJlcSwgdXJsKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9jbWRcIilcbiAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAudGhlbigoYikgPT4ge1xuICAgICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICAgIC8vICM4NCDigJQgcHJvcGFnYXRlIHRoZSBoYW5kbGVyJ3MgdmVyZGljdCBpbnN0ZWFkIG9mIGEgbGl0ZXJhbFxuICAgICAgICAgICAgLy8ge29rOnRydWV9LiBgYXBwbGllZGAgaXMgdGhlIGZpZWxkIGJvdW50eSBhbHJlYWR5IHVzZXNcbiAgICAgICAgICAgIC8vIChzZXJ2ZXIudHMgQXBwbHlSZXN1bHQpOyBubyBuZXcgdm9jYWJ1bGFyeSBpcyBtaW50ZWQgaGVyZS5cbiAgICAgICAgICAgIGNvbnN0IHZlcmRpY3QgPSBoYW5kbGVBZ2VudE1zZyhiIGFzIEFnZW50Q29tbWFuZCk7XG4gICAgICAgICAgICAvLyBBIGNvbW1hbmQgdGhhdCBhbnN3ZXJlZCB3aXRoIGl0cyBvd24gcmVzdWx0IGNhcnJpZXMgaXRzIHBheWxvYWQ7XG4gICAgICAgICAgICAvLyB0aGUgYm9vbGVhbiBwYXRoIGJlbG93IGlzIHVuY2hhbmdlZC5cbiAgICAgICAgICAgIGlmICh0eXBlb2YgdmVyZGljdCA9PT0gXCJvYmplY3RcIilcbiAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgYXBwbGllZDogdHJ1ZSwgLi4udmVyZGljdC5kZXRhaWwgfSk7XG4gICAgICAgICAgICBjb25zdCBhcHBsaWVkID0gdmVyZGljdDtcbiAgICAgICAgICAgIGlmICghYXBwbGllZCkge1xuICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbihcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgICBhcHBsaWVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgIGVycm9yOiBgdW5yZWNvZ25pc2VkIGNvbW1hbmQgdHlwZSAke0pTT04uc3RyaW5naWZ5KFxuICAgICAgICAgICAgICAgICAgICAoYiBhcyB7IHR5cGU/OiB1bmtub3duIH0pPy50eXBlLFxuICAgICAgICAgICAgICAgICAgKX0g4oCUIG5vdGhpbmcgd2FzIGFwcGxpZWRgLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgeyBzdGF0dXM6IDQwMCB9LFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgYXBwbGllZDogdHJ1ZSB9KTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoKSA9PiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwiYmFkIGpzb25cIiB9LCB7IHN0YXR1czogNDAwIH0pKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGguc3RhcnRzV2l0aChcIi9hc3NldHMvXCIpKSB7XG4gICAgICAgIGNvbnN0IG5hbWUgPSBkZWNvZGVVUklDb21wb25lbnQocGF0aC5zbGljZShcIi9hc3NldHMvXCIubGVuZ3RoKSk7XG4gICAgICAgIGlmIChuYW1lLmluY2x1ZGVzKFwiLi5cIikgfHwgbmFtZS5zdGFydHNXaXRoKFwiL1wiKSlcbiAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IGVycm9yOiBcIm5vdCBmb3VuZFwiIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgICAgIGNvbnN0IGYgPSBCdW4uZmlsZShqb2luKHNlc3Npb25GaWxlc0RpciwgbmFtZSkpO1xuICAgICAgICByZXR1cm4gZlxuICAgICAgICAgIC5leGlzdHMoKVxuICAgICAgICAgIC50aGVuKChvaykgPT5cbiAgICAgICAgICAgIG9rID8gbmV3IFJlc3BvbnNlKGYpIDogUmVzcG9uc2UuanNvbih7IGVycm9yOiBcIm5vdCBmb3VuZFwiIH0sIHsgc3RhdHVzOiA0MDQgfSksXG4gICAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIC8vIHJlbGVhc2U6IFwiL1wiIGFuZCB0aGUgaGFzaGVkIGNodW5rLSouanMvY3NzIGFyZSBzdGF0aWMgZGlzdCByZWFkcy4gRGV2XG4gICAgICAvLyBuZXZlciByZWFjaGVzIGhlcmUgZm9yIFwiL1wiIOKAlCB0aGUgcm91dGVzIHRhYmxlIGFib3ZlIGFuc3dlcnMgaXQgZmlyc3QuXG4gICAgICAvLyBUaGlzIHNpdHMgQUZURVIgL2Fzc2V0cy8sIHdoaWNoIHNlcnZlcyBzZXNzaW9uIGZpbGVzLCBub3QgZGlzdCBvbmVzLlxuICAgICAgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgIGNvbnN0IGFzc2V0ID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICBpZiAoYXNzZXQpIHJldHVybiBhc3NldDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwibm90IGZvdW5kXCIgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICB9LFxuICAgIHdlYnNvY2tldDoge1xuICAgICAgb3Blbih3cykge1xuICAgICAgICBzb2NrZXRzLmFkZCh3cyk7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGVtaXRUcmFuc2llbnQoeyB0eXBlOiBcImNvbm5lY3RlZFwiIH0pO1xuICAgICAgICB3cy5zZW5kKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJzdGF0ZVwiLCBzdGF0ZSB9KSk7XG4gICAgICB9LFxuICAgICAgbWVzc2FnZShfd3MsIHJhdykge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGhhbmRsZUNsaWVudE1zZyhcbiAgICAgICAgICAgIEpTT04ucGFyc2UoXG4gICAgICAgICAgICAgIHR5cGVvZiByYXcgPT09IFwic3RyaW5nXCIgPyByYXcgOiBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUocmF3KSxcbiAgICAgICAgICAgICkgYXMgQ2xpZW50VG9TZXJ2ZXIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBnbGFtb3VyOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIGNsb3NlKHdzKSB7XG4gICAgICAgIHNvY2tldHMuZGVsZXRlKHdzKTtcbiAgICAgICAgZW1pdFRyYW5zaWVudCh7IHR5cGU6IFwiZGlzY29ubmVjdGVkXCIgfSk7XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGJvdW5kUG9ydCA9IHNlcnZlci5wb3J0O1xuICAvLyAtLS0gZGlzY292ZXJ5IGZpbGVzIChjbGkudHMgcmVhZHMgdGhlc2UpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc2Vzc2lvbkZpbGUgPSBqb2luKHRtcGRpcigpLCBgZ2xhbW91ci0ke3Nlc3Npb25JZH0uanNvbmApO1xuICBjb25zdCBsYXRlc3RGaWxlID0gam9pbih0bXBkaXIoKSwgYGdsYW1vdXItbGF0ZXN0Lmpzb25gKTtcbiAgY29uc3QgaW5mbyA9IEpTT04uc3RyaW5naWZ5KHtcbiAgICB1cmw6IGBodHRwOi8vJHtvcHRzLmhvc3QgPz8gXCIxMjcuMC4wLjFcIn06JHtib3VuZFBvcnR9YCxcbiAgICBwb3J0OiBib3VuZFBvcnQsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIHRpdGxlOiBzdGF0ZS50aXRsZSxcbiAgICBmaWxlc19kaXI6IHNlc3Npb25GaWxlc0RpcixcbiAgICBtb2RlLFxuICB9KTtcbiAgLy8g4pqgIEFUT01JQywgYmVjYXVzZSBjbGkudHMncyByZWFkU2Vzc2lvbiB0cmVhdHMgdW5wYXJzZWFibGUgY29udGVudCBhc1xuICAvLyBjb3JydXB0aW9uIHJhdGhlciB0aGFuIGFic2VuY2Ug4oCUIGFuZCB0aGlzIGltcGxlbWVudGF0aW9uIGlzIG5vd1xuICAvLyBga2l0L3dpcmUvZGlzY292ZXJ5LnRzYCwgc2hhcmVkIHdpdGggdGhlIHNpbmdsZXRvbiBjb252ZW50aW9uIEQzIGtlcHQgYWxpdmVcbiAgLy8gYmVzaWRlIHRoaXMgb25lLiBnbGFtb3VyIGlzIHdoZXJlIHRoZSBkZWZlY3QgKEwzKSB3YXMgZm91bmQgYW5kIGZpeGVkIG9uXG4gIC8vIDIwMjYtMDktMDc7IHdoYXQgc3RheWVkIGhlcmUgaXMgV0hJQ0ggZmlsZXMgZ2xhbW91ciB3cml0ZXMuXG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlQXRvbWljKHNlc3Npb25GaWxlLCBpbmZvKTtcbiAgICB3cml0ZUZpbGVBdG9taWMobGF0ZXN0RmlsZSwgaW5mbyk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGRpc2NvdmVyeSBpcyBiZXN0LWVmZm9ydCAqL1xuICB9XG5cbiAgLy8gQ29udHJhY3QgMTogdGhlIGRhZW1vbiBFTUlUUyBpdHMgcmVzb2x2ZWQgbW9kZSDigJQgYSBkZXYgZGFlbW9uIHdpdGggcm9vdCBkZXBzXG4gIC8vIHByZXNlbnQgcmVuZGVycyBhbiBpZGVudGljYWwtbG9va2luZyBib2FyZCwgc28gYG1vZGVgIGlzIHRoZSBvbmx5IHRoaW5nIHRoYXRcbiAgLy8gdGVsbHMgYSB2ZXJpZmllciB3aGljaCBwYXRoIHNlcnZlZCBpdC4gZ2xhbW91ciBoYXMgVEhSRUUgdHJhbnNwb3J0cyAoaW1hZ29cbiAgLy8gaGFzIHR3byk6IHRoaXMgZXZlbnQsIHRoZSBkaXNjb3ZlcnkgZmlsZSBhYm92ZSwgYW5kIHRoZSBzdGRvdXQgaGFuZHNoYWtlIGluXG4gIC8vIGltcG9ydC5tZXRhLm1haW4gYmVsb3cuIEFsbCB0aHJlZSBjYXJyeSBpdC5cbiAgZW1pdEV2ZW50KHsgdHlwZTogXCJyZWFkeVwiLCBtb2RlIH0pO1xuXG4gIC8vIC0tLSBzbmFwc2hvdCBkZWJvdW5jZSArIGlkbGUgc3dlZXAgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvL1xuICAvLyDim5QgVEhFIFNXRUVQIE5PVyBTRUVTIElUUyBTVUJTQ1JJQkVSUyDigJQgY2Vuc3VzIGRlZmVjdCBMMSwgY2xvc2VkIGJ5IHRoZSBzaGFyZWRcbiAgLy8gaG91c2VrZWVwZXIgUkVRVUlSSU5HIGEgYHN1YnNjcmliZXJDb3VudGAgcmF0aGVyIHRoYW4gYnkgYW55b25lIHJlbWVtYmVyaW5nLlxuICAvLyBUaGUgZXhwcmVzc2lvbiBoZXJlIHJlYWQgYChub3cgLSBsYXN0QWN0aXZpdHkpLzEwMDAgPj0gdGltZW91dGAgYW5kIG5vdGhpbmdcbiAgLy8gZWxzZSwgc28gYW4gYWdlbnQgaG9sZGluZyBhIGAvZXZlbnRzYCB0YWlsIG9uIGEgcXVpZXQgc2Vzc2lvbiB3YXMga2lsbGVkIFdJVEhcbiAgLy8gSVRTIENPTk5FQ1RJT04gT1BFTiBhdCB0aGUgMzAtbWludXRlIGZsb29yIOKAlCBnbGFtb3VyLCBpbWFnbyBhbmQgbWFncGllIGFsbFxuICAvLyBoYWQgaXQuIGB0aW1lb3V0YCBub3cgbWVhbnMgXCJsaW5nZXIgdGhpcyBsb25nIGFmdGVyIHRoZSBMQVNUIHN1YnNjcmliZXJcbiAgLy8gbGVhdmVzXCIsIG5vdCBcIm1heGltdW0gaWRsZSB3aGlsZSBjb25uZWN0ZWRcIi5cbiAgY29uc3Qgc2F2ZU5vdyA9ICgpID0+IHNhdmVTbmFwc2hvdChTTkFQU0hPVFNfRElSLCBzZXNzaW9uSWQsIHN0YXRlKTtcbiAgaWYgKHJlc3RvcmVkKSBzYXZlTm93KCk7XG4gIGNvbnN0IHRpbWVvdXRTID0gb3B0cy50aW1lb3V0UyA/PyAxODAwO1xuICBjb25zdCBzdG9wSG91c2VrZWVwaW5nID0gc3RhcnRIb3VzZWtlZXBpbmcoe1xuICAgIHN1YnNjcmliZXJDb3VudDogKCkgPT4gc29ja2V0cy5zaXplICsgc3NlQ2xpZW50cy5zaXplLFxuICAgIGlkbGVNczogKCkgPT4gcGVyZm9ybWFuY2Uubm93KCkgLSBsYXN0QWN0aXZpdHksXG4gICAgdG91Y2gsXG4gICAgdGltZW91dE1zOiB0aW1lb3V0UyAqIDEwMDAsXG4gICAgb25JZGxlQ2xvc2U6ICgpID0+IHJlc29sdmVEb25lKHsgY29kZTogMTI0LCByZWFzb246IFwidGltZW91dFwiIH0pLFxuICAgIHNuYXBzaG90OiB7XG4gICAgICBkaXJ0eTogKCkgPT4gc25hcERpcnR5LFxuICAgICAgY2xlYXI6ICgpID0+IHtcbiAgICAgICAgc25hcERpcnR5ID0gZmFsc2U7XG4gICAgICB9LFxuICAgICAgd3JpdGU6IHNhdmVOb3csXG4gICAgfSxcbiAgfSk7XG5cbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICAvLyBSZXNvbHZlcyBvbmNlIHRoZSBTU0UgZmx1c2ggKyBzZXJ2ZXIuc3RvcCBoYXZlIGJlZW4gc2NoZWR1bGVkOyBjYWxsZXJzXG4gIC8vIHRoYXQgbmVlZCB0byB3YWl0IChlLmcuIGltcG9ydC5tZXRhLm1haW4gYmVmb3JlIHByb2Nlc3MuZXhpdCkgY2FuIGF3YWl0IHRoaXMuXG4gIGxldCByZXNvbHZlU2h1dGRvd24hOiAoKSA9PiB2b2lkO1xuICBjb25zdCBzaHV0ZG93biA9IG5ldyBQcm9taXNlPHZvaWQ+KChyKSA9PiB7XG4gICAgcmVzb2x2ZVNodXRkb3duID0gcjtcbiAgfSk7XG5cbiAgLy8gVGhlIHNlc3Npb24gcG9pbnRlciBpcyB1bmNvbmRpdGlvbmFsbHkgb3VyczsgYGdsYW1vdXItbGF0ZXN0Lmpzb25gIGlzIE5PVCDigJRcbiAgLy8gYSBuZXdlciBzZXNzaW9uIG1heSBhbHJlYWR5IGhhdmUgY2xhaW1lZCBpdCwgYW5kIHVubGlua2luZyB0aGF0IHdvdWxkIG1ha2VcbiAgLy8gdGhlIGxpdmUgZGFlbW9uIGludmlzaWJsZSB0byB0aGUgbmV4dCB2ZXJiLiBgdW5saW5rSWZNYXRjaGVzYCdzIGBpZGVudGlmeWBcbiAgLy8gaG9vayBpcyB3aGF0IGxldHMgT05FIHNoYXJlZCBwcmVkaWNhdGUgc2VydmUgYm90aCB0aGlzIEpTT04gcG9pbnRlciBhbmRcbiAgLy8gYXN0cm9sYWJlJ3MgYmFyZSBwaWQgZmlsZSAoYGtpdC93aXJlL2Rpc2NvdmVyeS50c2ApLlxuICBjb25zdCBjbGVhbnVwRGlzY292ZXJ5ID0gKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICB1bmxpbmtTeW5jKHNlc3Npb25GaWxlKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGdvbmUg4oCUIGZpbmUgKi9cbiAgICB9XG4gICAgdW5saW5rSWZNYXRjaGVzKGxhdGVzdEZpbGUsIHNlc3Npb25JZCwgKHJhdykgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgaWQgPSAoSlNPTi5wYXJzZShyYXcpIGFzIHsgc2Vzc2lvbl9pZD86IHVua25vd24gfSkuc2Vzc2lvbl9pZDtcbiAgICAgICAgcmV0dXJuIHR5cGVvZiBpZCA9PT0gXCJzdHJpbmdcIiA/IGlkIDogbnVsbDtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICB9KTtcbiAgICB0cnkge1xuICAgICAgcm1TeW5jKHNlc3Npb25GaWxlc0RpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9O1xuXG4gIC8vIOKblCBTVEFZUyBTWU5DSFJPTk9VUyBBTkQgSURFTVBPVEVOVCwgYmVjYXVzZSBgZG9uZS50aGVuKCgpID0+IGNsb3NlKCkpYCBhbmRcbiAgLy8gdGhlIHN1aXRlcycgYGFmdGVyQWxsKCgpID0+IGQuY2xvc2UoKSlgIGJvdGggY2FsbCBpdCBhcyBhIHN0YXRlbWVudC4gVGhlXG4gIC8vIERSQUlOIGlzIHdoYXQgYmVjYW1lIGFzeW5jOiBgZHJhaW5BbmRTdG9wYCB3YWl0cyBpdHMgZ3JhY2UgcGVyaW9kLCBjbG9zZXNcbiAgLy8gZXZlcnkgcmVnaXN0ZXJlZCB0YWlsIHRocm91Z2ggdGhlIGZ1bm5lbCwgY2xvc2VzIHRoZSBzb2NrZXRzLCB0aGVuIFJBQ0VTXG4gIC8vIGBzZXJ2ZXIuc3RvcCh0cnVlKWAg4oCUIGJlY2F1c2UgdGhhdCBjYWxsIGF3YWl0cyBpdHMgY29ubmVjdGlvbnMgYW5kIG9uZSB3ZWRnZWRcbiAgLy8gcGVlciBpcyBlbm91Z2ggdG8gcGFyayB0ZWFyZG93biBmb3JldmVyIChhIDIzLW1pbnV0ZSBoYW5nIHNoaXBwZWQgb25jZSkuXG4gIC8vXG4gIC8vIOKaoCBUSEUgR1JBQ0UgUEVSSU9EIElTIDE1MCBtcywgTk9UIEdMQU1PVVInUyBPTEQgNTAsIGFuZCB0aGF0IGlzIGEgZGVsaWJlcmF0ZVxuICAvLyB3aXJlLW9ic2VydmFibGUgY2hhbmdlIHJhdGhlciB0aGFuIGFuIG92ZXJzaWdodDogMTUwIGlzIHRoZSBudW1iZXIgYWxsIGVpZ2h0XG4gIC8vIGRhZW1vbnMgY29udmVyZ2VkIG9uIGluZGVwZW5kZW50bHksIGFuZCBpdCBpcyB3aGF0IHR1cm5zIFwidGhlIGRhZW1vbiB0b2xkIHlvdVxuICAvLyB3aHkgaXQgZGllZFwiIGZyb20gYSBob3BlIGludG8gYW4gb2JzZXJ2YXRpb24uIGdsYW1vdXIncyBgY2xvc2VkYCBmcmFtZSBpcyB0aGVcbiAgLy8gb25lIHRoZSBDTEkncyB0YWlsIHdhdGNoZXMgZm9yLlxuICBjb25zdCBjbG9zZSA9ICgpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBzdG9wSG91c2VrZWVwaW5nKCk7XG4gICAgc2F2ZU5vdygpO1xuICAgIGNsZWFudXBEaXNjb3ZlcnkoKTtcbiAgICBlbWl0RXZlbnQoeyB0eXBlOiBcImNsb3NlZFwiIH0pO1xuICAgIHZvaWQgZHJhaW5BbmRTdG9wKHsgc2VydmVyLCBjbGllbnRzOiBzc2VDbGllbnRzLCBzb2NrZXRzIH0pLnRoZW4ocmVzb2x2ZVNodXRkb3duKTtcbiAgfTtcbiAgZG9uZS50aGVuKCgpID0+IGNsb3NlKCkpO1xuXG4gIHJldHVybiB7IHBvcnQ6IGJvdW5kUG9ydCwgc2Vzc2lvbklkLCBtb2RlLCBjbG9zZSwgZG9uZSwgc2h1dGRvd24gfTtcbn1cblxuLy8gIzgxIC8gRDQg4oCUIFRIRSBSRUNPR05JWkVEIFNFVCwgQVQgUEFSU0VSIEFMVElUVURFLiBUaGUgU0lYVEggZW50cnkgcG9pbnQuXG4vL1xuLy8g4pqgIFRISVMgT05FIEhBUyBaRVJPIGBmbGFncy5gIFJFQURTLCBzbyBhIGBmbGFncy5gLXBhdHRlcm4gYXVkaXQgcmV0dXJucyB6ZXJvXG4vLyBoZXJlIOKAlCBhbmQgYSB6ZXJvIHJlYWRzIGlkZW50aWNhbGx5IHRvIFwibm8gZHJpZnRcIi4gSXQgd2FzIGEgTE9PS1VQIHBhcnNlcjpcbi8vIGBjb25zdCBmbGFnID0gKG5hbWUpID0+IHsgY29uc3QgaSA9IGFyZ3MuaW5kZXhPZihgLS0ke25hbWV9YCk7IHJldHVybiBpID49IDBcbi8vID8gYXJnc1tpICsgMV0gOiB1bmRlZmluZWQ7IH1gLiBJdCBhbHNvIHJlYWQgYEJ1bi5hcmd2YCwgbm90IGBwcm9jZXNzLmFyZ3ZgLFxuLy8gd2hpY2ggaXMgdGhlIHN5bm9ueW0gdGhhdCBoYXMgbWFkZSB0aGlzIHJlcG8ncyBncmVwcyBsaWUgYmVmb3JlLlxuLy9cbi8vIEl0IGhhZCBhIExBVEVOVCwgUFJFLUVYSVNUSU5HIGJ1ZyB0aGUgY29udmVyc2lvbiBmaXhlcyBhcyBhIHNpZGUgZWZmZWN0LCBub3RlZFxuLy8gc28gdGhlIGNoYW5nZSBpcyBub3QgbWlzdGFrZW4gZm9yIGEgcmVncmVzc2lvbjogYGZsYWcoKWAgcmV0dXJuZWQgYGFyZ3NbaSsxXWBcbi8vIFVOQ09ORElUSU9OQUxMWSwgc28gYC0tcmVzdG9yZSAtLXRpdGxlIFhgIHlpZWxkZWQgYHJlc3RvcmUgPT09IFwiLS10aXRsZVwiYCDigJRcbi8vIHRoZSBuZXh0IEZMQUcgc2lsZW50bHkgY29uc3VtZWQgYXMgdGhlIHByZXZpb3VzIGZsYWcncyBWQUxVRS5cbi8vXG4vLyBBbGwgc2l4IGFyZSBzdHJpbmcgYnkgY29uc3RydWN0aW9uICh0aGUgb2xkIGhlbHBlciByZXR1cm5lZCB0aGUgbmV4dCBhcmd2XG4vLyBlbGVtZW50KS4gYHBvcnRgIGFuZCBgdGltZW91dGAgYXJlIE51bWJlcigpLWNvZXJjZWQgYXQgdGhlIGNhbGwgc2l0ZSwgd2hpY2ggaXNcbi8vIGEgdmFsdWUgcmVhZCwgbm90IGEgYm9vbGVhbiBvbmUuIFRoZSBkYWVtb24gdGFrZXMgbm8gcG9zaXRpb25hbHMsIHNvIHN0cmljdCdzXG4vLyBkZWZhdWx0IHJlamVjdGlvbiBvZiB0aGVtIGlzIGNvcnJlY3QuXG4vL1xuLy8gVmVyaWZpZWQgYmVmb3JlIGNvbnZlcnRpbmc6IGBjbGkudHNgIHNwYXducyB0aGlzIGRhZW1vbiB3aXRoIGV4YWN0bHkgLS10aXRsZSxcbi8vIC0taW50ZW50LCAtLXRpbWVvdXQsIC0tcmVzdG9yZSBhbmQgLS1wcm9qZWN0LCBhbGwgaW5zaWRlIHRoaXMgc2V0IOKAlCBzbyBzdHJpY3Rcbi8vIGNhbm5vdCByZWZ1c2UgdGhlIGRhZW1vbidzIG93biBsYXVuY2guXG5jb25zdCBEQUVNT05fT1BUSU9OUyA9IHtcbiAgaW50ZW50OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcG9ydDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHByb2plY3Q6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByZXN0b3JlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGltZW91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpdGxlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbn0gYXMgY29uc3Q7XG5cbi8qKiBQYXJzZSB0aGUgZGFlbW9uJ3MgYXJndiwgYm9vdCwgcHJpbnQgdGhlIGhhbmRzaGFrZSwgYW5kIHdhaXQgZm9yIHRoZSBlbmQuXG4gKiAgUmV0dXJucyB0aGUgcHJvY2VzcyBleGl0IGNvZGU7IGl0IGRvZXMgTk9UIGV4aXQg4oCUIHRoZSBsYXVuY2hlciBkb2VzLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD47XG4gIHRyeSB7XG4gICAgZmxhZ3MgPSBub2RlUGFyc2VBcmdzKHsgYXJnczogYXJndiwgb3B0aW9uczogREFFTU9OX09QVElPTlMsIHN0cmljdDogdHJ1ZSB9KS52YWx1ZXMgYXMgUmVjb3JkPFxuICAgICAgc3RyaW5nLFxuICAgICAgc3RyaW5nIHwgdW5kZWZpbmVkXG4gICAgPjtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYGdsYW1vdXI6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmAgK1xuICAgICAgICBgICByZWNvZ25pemVkIGZsYWdzOiAke09iamVjdC5rZXlzKERBRU1PTl9PUFRJT05TKVxuICAgICAgICAgIC5tYXAoKGspID0+IGAtLSR7a31gKVxuICAgICAgICAgIC5qb2luKFwiIFwiKX1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3QgZCA9IGF3YWl0IHN0YXJ0RGFlbW9uKHtcbiAgICBwb3J0OiBmbGFncy5wb3J0ID8gTnVtYmVyKGZsYWdzLnBvcnQpIDogMCxcbiAgICB0aXRsZTogZmxhZ3MudGl0bGUsXG4gICAgaW50ZW50OiBmbGFncy5pbnRlbnQsXG4gICAgcmVzdG9yZTogZmxhZ3MucmVzdG9yZSxcbiAgICB0aW1lb3V0UzogZmxhZ3MudGltZW91dCA/IE51bWJlcihmbGFncy50aW1lb3V0KSA6IHVuZGVmaW5lZCxcbiAgICBwcm9qZWN0OiBmbGFncy5wcm9qZWN0LFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7ZC5wb3J0fWAsIHBvcnQ6IGQucG9ydCwgc2Vzc2lvbl9pZDogZC5zZXNzaW9uSWQsIG1vZGU6IGQubW9kZSB9KX1cXG5gLFxuICApO1xuICBjb25zdCByZXMgPSBhd2FpdCBkLmRvbmU7XG4gIC8vIFdhaXQgZm9yIHRoZSBjbG9zZWQgU1NFIGV2ZW50IHRvIGZsdXNoIGJlZm9yZSBleGl0aW5nLlxuICBhd2FpdCBkLnNodXRkb3duO1xuICByZXR1cm4gcmVzLmNvZGU7XG59XG5cbi8qKlxuICogVGhlIGRhZW1vbidzIGVudHJ5LCBmb3IgdGhlIExBVU5DSEVSIGF0XG4gKiBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dsYW1vdXIvc2NyaXB0cy9zZXJ2ZXIudHNgLlxuICpcbiAqIOKblCBgaW1wb3J0Lm1ldGEubWFpbmAgSVMgRkFMU0UgSU4gVEhFIEJVTkRMRS4gYGRpc3Qvc2VydmVyLmpzYCBpcyBJTVBPUlRFRCBieVxuICogdGhlIGxhdW5jaGVyLCBuZXZlciBleGVjdXRlZCBhcyB0aGUgcHJvY2VzcyBlbnRyeSwgc28gdGhlIG9sZFxuICogYGlmIChpbXBvcnQubWV0YS5tYWluKWAgYmxvY2sgd291bGQgc2ltcGx5IG5ldmVyIHJ1biDigJQgdGhlIGRhZW1vbiB3b3VsZCBib290LFxuICogc2VydmUgbm90aGluZyBhbmQgZXhpdCAwLCBhbmQgZXZlcnkgdGVzdCB3b3VsZCBmYWlsIGFzIFwidGhlIGRhZW1vbiBuZXZlciBib3VuZFxuICogYSBwb3J0XCIsIHdoaWNoIHJlYWRzIGxpa2UgZmxha2UuIFRoYXQgaXMgdGhlIGZhaWx1cmUgdGhpcyBleHBvcnQgZXhpc3RzIHRvXG4gKiBwcmV2ZW50LCBhbmQgaXQgaXMgdGhlIGZpcnN0IHRoaW5nIHRoYXQgYnJlYWtzIG9uIGV2ZXJ5IGJhY2tlbmQgcmVsb2NhdGlvbi5cbiAqXG4gKiDim5QgQU5EIFRIRVJFIElTIE5PIGBpbXBvcnQubWV0YS5tYWluYCBCTE9DSyBMRUZULCBkZWxpYmVyYXRlbHkgKEQxMikuIFJ1biBmcm9tXG4gKiBgc3JjL2dsYW1vdXIvYmFja2VuZC9gLCBgU0tJTExfUk9PVGAgY29tcHV0ZXMgdG8gYHNyYy9nbGFtb3VyL2AsIHdoaWNoIGhvbGRzIG5vXG4gKiBgZGlzdC9pbmRleC5odG1sYCDigJQgc28gdGhlIGRhZW1vbiB3b3VsZCBzaWxlbnRseSBjaG9vc2UgREVWIG1vZGUgYW5kIHRoZW4gZmFpbFxuICogdGhlIGRldiBpbXBvcnQgZnJvbSB0aGUgd3JvbmcgYW5jaG9yLiBPZmZlcmluZyB0aGF0IGVudHJ5IHdvdWxkIGJlIG9mZmVyaW5nIGFcbiAqIHdyb25nIGRhZW1vbi5cbiAqXG4gKiDim5QgQU5EIElUIFRBS0VTIE5PIEFSR1VNRU5UUywgZm9yIHRoZSBzYW1lIHJlYXNvbiBgY2xpLnRzYCdzIGBydW4oKWAgZG9lcyBub3Q6XG4gKiB0aGUgY29tbWFuZCBsaW5lIGJlbG9uZ3MgdG8gdGhlIGZpbGUgdGhhdCBQQVJTRVMgaXQuIEEgbGF1bmNoZXIgdGhhdCB0b3VjaGVkXG4gKiBgcHJvY2Vzcy5hcmd2YCB3b3VsZCBtYXRjaCBgZ3JpbW9pcmUvbGliL2VudHJ5LXBvaW50cy50c2AncyBhcmctcGFyc2luZ1xuICogcHJlZGljYXRlIGFuZCB0aGUgd2FyZHMgd291bGQganVkZ2UgdGhpcyBkYWVtb24ncyBmbGFncyBhZ2FpbnN0IGEgZmlsZSB0aGF0XG4gKiByZWNvZ25pc2VzIG5vbmUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cbiIsCiAgICAiLy8gVGhlIHNpbmdsZSBzaGFyZWQgY29udHJhY3Qg4oCUIGltcG9ydGVkIGJ5IHNlcnZlci50cywgY2xpLnRzLCBhbmQgdGhlIHN1cmZhY2UuXG5cbmV4cG9ydCB0eXBlIEl0ZW1LaW5kID0gXCJyZWZcIiB8IFwiY29udGV4dFwiIHwgXCJnZW5cIiB8IFwic3R5bGVcIjtcbmV4cG9ydCBjb25zdCBWQUxJRF9LSU5EOiByZWFkb25seSBJdGVtS2luZFtdID0gW1wicmVmXCIsIFwiY29udGV4dFwiLCBcImdlblwiLCBcInN0eWxlXCJdIGFzIGNvbnN0O1xuXG4vLyBHZW5lcmF0aW9uIG1ldGFkYXRhIChHMSkuIEZ1bGx5IHBvcHVsYXRlZCBmb3Iga2luZCA9PT0gXCJnZW5cIiBpbiBTbGljZSAzO1xuLy8gdGhlIGZpZWxkIGV4aXN0cyBub3cgc28gdGhlIGNvbnRyYWN0IGFuZCB0aGUgZGV0YWlscyBmbHktb3V0IGFyZSBzdGFibGUuXG5leHBvcnQgdHlwZSBHZW5NZXRhID0ge1xuICBtb2RlbDogc3RyaW5nO1xuICBwcm9tcHQ6IHN0cmluZztcbiAgc2VlZDogbnVtYmVyIHwgbnVsbDtcbiAgY29zdDogbnVtYmVyIHwgbnVsbDtcbiAgY3VzdG9tOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICByb3VuZDogbnVtYmVyOyAvLyBiYXRjaCBpbmRleCB0aGUgYWdlbnQgc3RhbXBzOyBVSSBncm91cHMgZ2VuIGl0ZW1zIGJ5IGl0XG59O1xuXG4vLyBPbmUgY2F0YWxvZyBlbnRyeS4gU2hhcGUgZm9sbG93cyBpbWFnbydzIENvbnRleHRFbnRyeSBjb252ZW50aW9uczpcbi8vIGJsb2JzIChgc3JjYCwgYHRleHRgKSBhcmUgc3RyaXBwZWQgaW4gdGhlIGxlYW4gYWdlbnQgcHJvamVjdGlvbjsgdGhlIGFnZW50XG4vLyByZWFkcyBgcGF0aGAuIEFyY2hpdmFsIGlzIG5vbi1kZXN0cnVjdGl2ZSAodGhlIGBhcmNoaXZlZGAgZmxhZzsgdGhlIGl0ZW1cbi8vIHN1cnZpdmVzIGluIHRoZSBsaWJyYXJ5KS5cbmV4cG9ydCB0eXBlIExpYnJhcnlJdGVtID0ge1xuICBpZDogc3RyaW5nO1xuICBraW5kOiBJdGVtS2luZDtcbiAgdGl0bGU6IHN0cmluZztcbiAgc3JjOiBzdHJpbmc7IC8vIGltYWdlIGRhdGEtVVJMIChyZWYvZ2VuKTsgXCJcIiBvdGhlcndpc2Ug4oCUIHN0cmlwcGVkIGluIGxlYW5cbiAgcGF0aDogc3RyaW5nOyAvLyBvbi1kaXNrIG1hdGVyaWFsaXplZCBibG9iIHRoZSBhZ2VudCBjYW4gUmVhZDsgXCJcIiBpZiBub25lXG4gIHRleHQ6IHN0cmluZzsgLy8gY29udGV4dCBib2R5OyBcIlwiIG90aGVyd2lzZSDigJQgc3RyaXBwZWQgaW4gbGVhblxuICBtaW1lOiBzdHJpbmc7IC8vIGUuZy4gXCJpbWFnZS93ZWJwXCIsIFwidGV4dC9tYXJrZG93blwiXG4gIHRhZ3M6IHN0cmluZ1tdO1xuICBzdGFycmVkOiBib29sZWFuO1xuICBsaWtlZDogYm9vbGVhbjtcbiAgYW5ub3RhdGlvbnM6IHsgYWdlbnQ6IHN0cmluZzsgaHVtYW46IHN0cmluZyB9O1xuICBjYW5vbmljYWw6IGJvb2xlYW47IC8vIG1hcmtlZCBjYW5vbmljYWwgZm9yIHRoZSBzdHlsZSBiZWluZyBidWlsdCAobXVsdGksIG5vdCBzaW5nbGUtc2VsZWN0KVxuICBjYW5vbjogQ2Fub25JbWdbXTsgLy8gYSBraW5kOlwic3R5bGVcIiBpdGVtJ3MgY2Fub25pY2FsIHRodW1ibmFpbHM7IFtdIG90aGVyd2lzZSDigJQgc3RyaXBwZWQgaW4gbGVhblxuICBhcmNoaXZlZDogYm9vbGVhbjtcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIGdlbjogR2VuTWV0YSB8IG51bGw7XG59O1xuXG4vLyBDb252ZXJzYXRpb24uIEFnZW50IG1lc3NhZ2Uga2luZHMgY2FycnkgVjEncyBuYXJyYXRpb24gc2VtYW50aWNzXG4vLyAoaW5mbyB8IHdvcmtpbmcgfCByZXN1bHQgfCBlcnJvcik7IHVzZXIgbWVzc2FnZXMgYXJlIGFsd2F5cyBcImluZm9cIi5cbmV4cG9ydCB0eXBlIE1lc3NhZ2VLaW5kID0gXCJpbmZvXCIgfCBcIndvcmtpbmdcIiB8IFwicmVzdWx0XCIgfCBcImVycm9yXCI7XG5leHBvcnQgdHlwZSBNZXNzYWdlID0ge1xuICBpZDogc3RyaW5nO1xuICB3aG86IFwidXNlclwiIHwgXCJhZ2VudFwiO1xuICBraW5kOiBNZXNzYWdlS2luZDtcbiAgdGV4dDogc3RyaW5nO1xuICBncm91bmQ6IHN0cmluZ1tdOyAvLyBpdGVtIGlkcyBncm91bmRpbmcgdGhpcyBtZXNzYWdlIChzbmFwc2hvdCBvZiBzZWxlY3RlZElkcyk7IFtdIGlmIG5vbmVcbiAgdHM6IG51bWJlcjtcbn07XG5cbi8vIEEgYnJvdWdodC1pbiBzdHlsZSdzIGNhbm9uaWNhbCB0aHVtYm5haWwgKGRhdGEtVVJMIGBzcmNgIOKAlCBzdHJpcHBlZCBpbiBsZWFuKS5cbmV4cG9ydCB0eXBlIENhbm9uSW1nID0geyB0aXRsZTogc3RyaW5nOyBzcmM6IHN0cmluZyB9O1xuXG4vLyBBIGNhbm9uaWNhbCBpbWFnZSBpbnNpZGUgYSBTYXZlZFN0eWxlOiB0aGUgYmxvYiBpcyBjb3BpZWQgaW50byB0aGUgc3R5bGUnc1xuLy8gZGlyIG9uIHNhdmUgYW5kIHJlZmVyZW5jZWQgYnkgYGZpbGVgIChzbyB0aGUgc2F2ZWQgc3R5bGUgaXMgc2VsZi1jb250YWluZWQpLlxuZXhwb3J0IHR5cGUgQ2Fub25pY2FsUmVmID0ge1xuICBpZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBmaWxlOiBzdHJpbmc7XG4gIG1pbWU6IHN0cmluZztcbn07XG5cbi8vIEEgc3R5bGUgc2F2ZWQgdG8gdGhlIHByb2plY3QgdHJheSDigJQgYSBjb21wb3VuZCBcImNhbm9uaWNhbCBzaGFwZVwiOiB0aGUgY29kaWZpZWRcbi8vIHN0eWxlLWd1aWRlIHNlY3Rpb25zICh0ZXh0KSArIGNhbm9uaWNhbCBpbWFnZXMuIFByb2plY3Qtc2NvcGVkLCBub24tZGVzdHJ1Y3RpdmUuXG5leHBvcnQgdHlwZSBTYXZlZFN0eWxlID0ge1xuICBpZDogc3RyaW5nO1xuICBsYWJlbDogc3RyaW5nO1xuICB0ZXh0OiBzdHJpbmc7IC8vIHNob3J0IGh1bWFuIGRlc2NyaXB0aW9uIChlLmcuIHRoZSBVbmRlcnN0YW5kaW5nL0RpcmVjdGlvbiBnaXN0KVxuICBzZWN0aW9uczogU3R5bGVTZWN0aW9uW107IC8vIHRoZSBjb2RpZmllZCBzdHlsZSBndWlkZSBhdCBzYXZlIHRpbWVcbiAgY2Fub25pY2FsOiBDYW5vbmljYWxSZWZbXTtcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIGFyY2hpdmVkOiBib29sZWFuO1xufTtcblxuLy8gVGhlIGFnZW50LWFzc2VtYmxlZCBzdHlsZSBndWlkZS4gU2VjdGlvbiBzZXQgKyBsYWJlbHMgYXJlIHRoZSBtb2NrdXAnc1xuLy8gKHRoZSBjb252ZXJnZWQgc3VyZmFjZSkuIFNlY3Rpb25zIGZpbGwgaW46IGVtcHR5IOKGkiBmb3JtaW5nIOKGkiBhZ3JlZWQuXG5leHBvcnQgdHlwZSBTZWN0aW9uU3RhdHVzID0gXCJlbXB0eVwiIHwgXCJmb3JtaW5nXCIgfCBcImFncmVlZFwiO1xuZXhwb3J0IHR5cGUgU2VjdGlvbktleSA9XG4gIHwgXCJ1bmRlcnN0YW5kaW5nXCJcbiAgfCBcImRpcmVjdGlvblwiXG4gIHwgXCJwYWxldHRlXCJcbiAgfCBcImNvbnNpc3RlbmN5XCJcbiAgfCBcInByb21wdHNcIlxuICB8IFwiY2Fub25pY2FsXCI7XG4vLyBBIHBhbGV0dGUgc3dhdGNoIOKAlCBzdHJ1Y3R1cmVkIGNvbG9yIGZvciB0aGUgXCJwYWxldHRlXCIgc2VjdGlvbi5cbmV4cG9ydCB0eXBlIFN3YXRjaCA9IHsgaGV4OiBzdHJpbmc7IG5hbWU/OiBzdHJpbmcgfTtcbmV4cG9ydCB0eXBlIFN0eWxlU2VjdGlvbiA9IHtcbiAga2V5OiBTZWN0aW9uS2V5O1xuICBsYWJlbDogc3RyaW5nO1xuICBzdGF0dXM6IFNlY3Rpb25TdGF0dXM7XG4gIGNvbnRlbnQ6IHN0cmluZzsgLy8gcHJvc2VcbiAgcHJvbXB0czogc3RyaW5nW107IC8vIHBvcHVsYXRlZCBmb3IgdGhlIFwicHJvbXB0c1wiIHNlY3Rpb247IFtdIGVsc2V3aGVyZVxuICBjb2xvcnM6IFN3YXRjaFtdOyAvLyBwb3B1bGF0ZWQgZm9yIHRoZSBcInBhbGV0dGVcIiBzZWN0aW9uOyBbXSBlbHNld2hlcmVcbn07XG5cbi8vIFRoZSB6b29tL2ZvY3VzIGNvLXByZXNlbmNlIGxlbnMuIEVpdGhlciBwYXJ0eSBjYW4gc2NvcGUgdGhlIHNldC5cbmV4cG9ydCB0eXBlIEZvY3VzU2NvcGUgPSBcImFsbFwiIHwgXCJmb2N1c1wiO1xuZXhwb3J0IHR5cGUgRm9jdXNPd25lciA9IFwieW91XCIgfCBcImFnZW50XCIgfCBudWxsO1xuXG5leHBvcnQgdHlwZSBHbGFtb3VyU3RhdGUgPSB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGludGVudDogc3RyaW5nO1xuICBsaWJyYXJ5OiBMaWJyYXJ5SXRlbVtdO1xuICBzZWxlY3RlZElkczogc3RyaW5nW107IC8vIGxpbmtlZCBzZXQg4oCUIHRoZSBncm91bmRpbmcgc2V0ICh1bnNlbGVjdCDiiaAgZGVsZXRlKVxuICBtZXNzYWdlczogTWVzc2FnZVtdO1xuICBzdHlsZUd1aWRlOiBTdHlsZVNlY3Rpb25bXTtcbiAgdHJheTogU2F2ZWRTdHlsZVtdO1xuICBzY29wZTogRm9jdXNTY29wZTtcbiAgZm9jdXNTZXQ6IHN0cmluZ1tdOyAvLyBpdGVtIGlkcyBpbiB0aGUgZm9jdXNlZCBzZXQ7IGVtcHR5IHdoZW4gc2NvcGUgPT09IFwiYWxsXCJcbiAgZm9jdXNPd25lcjogRm9jdXNPd25lcjsgLy8gd2hvIHNjb3BlZCB0aGUgZm9jdXNcbiAgZm9jdXNOb3RlOiBzdHJpbmc7IC8vIGFnZW50J3MgY29udGV4dHVhbCBxdWVzdGlvbiBmb3IgdGhlIGZvY3VzIGRyYXdlcjsgXCJcIiBvdGhlcndpc2VcbiAgc3RhdHVzOiB7IGJ1c3k6IGJvb2xlYW47IHRleHQ6IHN0cmluZyB9O1xufTtcblxuLy8gTGVhbiBwcm9qZWN0aW9uIHNlbnQgdG8gdGhlIGFnZW50OiBibG9icyBzdHJpcHBlZCwgcGF0aHMga2VwdC5cbmV4cG9ydCB0eXBlIExlYW5JdGVtID0gT21pdDxMaWJyYXJ5SXRlbSwgXCJzcmNcIiB8IFwidGV4dFwiIHwgXCJjYW5vblwiPjtcbmV4cG9ydCB0eXBlIExlYW5TdGF0ZSA9IE9taXQ8R2xhbW91clN0YXRlLCBcImxpYnJhcnlcIj4gJiB7XG4gIGxpYnJhcnk6IExlYW5JdGVtW107XG59O1xuXG4vLyBTZXJ2ZXIg4oaSIGJyb3dzZXIgKFdlYlNvY2tldCkuIEZ1bGwtc3RhdGUgYnJvYWRjYXN0IGlzIHRoZSBvbmx5IGZyYW1lLlxuZXhwb3J0IHR5cGUgU2VydmVyVG9DbGllbnQgPSB7IHR5cGU6IFwic3RhdGVcIjsgc3RhdGU6IEdsYW1vdXJTdGF0ZSB9O1xuXG4vLyBCcm93c2VyIOKGkiBzZXJ2ZXIgKFdlYlNvY2tldCkuXG5leHBvcnQgdHlwZSBDbGllbnRUb1NlcnZlciA9XG4gIHwge1xuICAgICAgdHlwZTogXCJpdGVtLmFkZFwiO1xuICAgICAgaXRlbToge1xuICAgICAgICBraW5kOiBcInJlZlwiIHwgXCJjb250ZXh0XCI7XG4gICAgICAgIHRpdGxlOiBzdHJpbmc7XG4gICAgICAgIHNyYz86IHN0cmluZztcbiAgICAgICAgdGV4dD86IHN0cmluZztcbiAgICAgICAgbWltZT86IHN0cmluZztcbiAgICAgIH07XG4gICAgfVxuICB8IHsgdHlwZTogXCJpdGVtLnNlbGVjdFwiOyBpZHM6IHN0cmluZ1tdIH0gLy8gYW1iaWVudFxuICB8IHsgdHlwZTogXCJpdGVtLnN0YXJcIjsgaWQ6IHN0cmluZzsgc3RhcnJlZDogYm9vbGVhbiB9IC8vIGFtYmllbnRcbiAgfCB7IHR5cGU6IFwiaXRlbS5saWtlXCI7IGlkOiBzdHJpbmc7IGxpa2VkOiBib29sZWFuIH0gLy8gYW1iaWVudFxuICB8IHsgdHlwZTogXCJpdGVtLmFubm90YXRlXCI7IGlkOiBzdHJpbmc7IGh1bWFuOiBzdHJpbmcgfSAvLyBhbWJpZW50IOKAlCBzdG9yZWQgKyByZWFkIG9uIGRlbWFuZCwgbm90IHB1c2hlZCBhcyBhbiBldmVudFxuICB8IHsgdHlwZTogXCJtZXNzYWdlLnNlbmRcIjsgdGV4dDogc3RyaW5nIH0gLy8gaW1wZXJhdGl2ZVxuICB8IHsgdHlwZTogXCJmb2N1cy5zZXRcIjsgaWRzOiBzdHJpbmdbXSB9IC8vIGFtYmllbnQg4oCUIGh1bWFuIHNjb3BlcyBhIGZvY3VzIHNldFxuICB8IHsgdHlwZTogXCJmb2N1cy5jbGVhclwiIH0gLy8gYW1iaWVudCDigJQgaHVtYW4gem9vbXMgYmFjayBvdXRcbiAgfCB7IHR5cGU6IFwiaXRlbS5jYW5vbmljYWxcIjsgaWQ6IHN0cmluZzsgY2Fub25pY2FsOiBib29sZWFuIH0gLy8gYW1iaWVudFxuICB8IHsgdHlwZTogXCJpdGVtLmFyY2hpdmVcIjsgaWQ6IHN0cmluZzsgYXJjaGl2ZWQ6IGJvb2xlYW4gfSAvLyBhbWJpZW50XG4gIHwgeyB0eXBlOiBcInN0eWxlLmJyaW5nSW5cIjsgaWQ6IHN0cmluZyB9OyAvLyBpbXBlcmF0aXZlIOKAlCBhZGRzIGEga2luZDpcInN0eWxlXCIgaXRlbVxuXG4vLyBBZ2VudCDihpIgc2VydmVyIChIVFRQIFBPU1QgL2NtZCkuXG5leHBvcnQgdHlwZSBBZ2VudENvbW1hbmQgPVxuICB8IHsgdHlwZTogXCJpbml0XCI7IHRpdGxlPzogc3RyaW5nOyBpbnRlbnQ/OiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJpbnRlbnRcIjsgdGV4dDogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwiaXRlbS5hbm5vdGF0ZVwiOyBpZDogc3RyaW5nOyBhZ2VudDogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwic2F5XCI7IHRleHQ6IHN0cmluZzsga2luZD86IE1lc3NhZ2VLaW5kIH1cbiAgfCB7XG4gICAgICB0eXBlOiBcInNlY3Rpb25cIjtcbiAgICAgIGtleTogU2VjdGlvbktleTtcbiAgICAgIGNvbnRlbnQ/OiBzdHJpbmc7XG4gICAgICBzdGF0dXM/OiBTZWN0aW9uU3RhdHVzO1xuICAgICAgcHJvbXB0cz86IHN0cmluZ1tdO1xuICAgICAgY29sb3JzPzogU3dhdGNoW107XG4gICAgfVxuICB8IHtcbiAgICAgIHR5cGU6IFwiZ2VuLmFkZFwiO1xuICAgICAgc3JjOiBzdHJpbmc7IC8vIGFuIEFMUkVBRFktb3B0aW1pemVkIHdlYnAgZGF0YS1VUkwgKENMSSBkb2VzIHRoZSBvcHRpbWl6YXRpb24pXG4gICAgICBwcm9tcHQ6IHN0cmluZztcbiAgICAgIG1vZGVsOiBzdHJpbmc7XG4gICAgICByb3VuZDogbnVtYmVyO1xuICAgICAgc2VlZD86IG51bWJlcjtcbiAgICAgIGNvc3Q/OiBudW1iZXI7XG4gICAgICBsYWJlbD86IHN0cmluZztcbiAgICAgIGN1c3RvbT86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gICAgfVxuICB8IHsgdHlwZTogXCJnZW4uY29zdFwiOyBpZDogc3RyaW5nOyBjb3N0OiBudW1iZXIgfSAvLyBiYWNrZmlsbCBjb3N0IG9uY2UgbWVkaWEtZm9yZ2UgZmluYWxpemVzIGl0XG4gIHwgeyB0eXBlOiBcImdlbi5tZXRhXCI7IGlkOiBzdHJpbmc7IHByb21wdD86IHN0cmluZzsgY3VzdG9tPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB9IC8vIGJhY2tmaWxsIHRoZSByZWFsIHByb21wdCAvIHJlZnMgb250byBhIGdlblxuICB8IHsgdHlwZTogXCJmb2N1cy5wdXNoXCI7IGlkczogc3RyaW5nW107IG5vdGU/OiBzdHJpbmcgfSAvLyBhZ2VudCBzY29wZXMgYSBmb2N1cyBzZXQgKyBhc2tzXG4gIHwgeyB0eXBlOiBcInN0eWxlLnNhdmVcIjsgbGFiZWw6IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcInN0eWxlLmFyY2hpdmVcIjsgaWQ6IHN0cmluZzsgYXJjaGl2ZWQ6IGJvb2xlYW4gfVxuICB8IHsgdHlwZTogXCJzdGF0dXNcIjsgYnVzeTogYm9vbGVhbjsgdGV4dD86IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcImNsb3NlXCIgfTtcblxuLy8gVGhlIGNvbXBsZXRlIGFnZW50LWV2ZW50IHNldCAoc2VydmVyIOKGkiBhZ2VudCBTU0UpLiBPbmx5IHRoZXNlIGFyZSBlbWl0dGVkLlxuLy8gSW1wZXJhdGl2ZXMgb25seSDigJQgYm9hcmQgbW92ZXMgKHNlbGVjdC9zdGFyL2xpa2UpIGFyZSBhbWJpZW50LlxuZXhwb3J0IGNvbnN0IEFHRU5UX0VWRU5UX1RZUEVTID0gT2JqZWN0LmZyZWV6ZShbXG4gIFwicmVhZHlcIixcbiAgXCJjb25uZWN0ZWRcIixcbiAgXCJkaXNjb25uZWN0ZWRcIixcbiAgXCJpdGVtLmFkZFwiLFxuICBcIm1lc3NhZ2UudXNlclwiLFxuICBcImNsb3NlZFwiLFxuXSBhcyBjb25zdCk7XG5leHBvcnQgdHlwZSBBZ2VudEV2ZW50VHlwZSA9ICh0eXBlb2YgQUdFTlRfRVZFTlRfVFlQRVMpW251bWJlcl07XG5cbmV4cG9ydCBmdW5jdGlvbiBkZWZhdWx0U3R5bGVHdWlkZSgpOiBTdHlsZVNlY3Rpb25bXSB7XG4gIHJldHVybiBbXG4gICAge1xuICAgICAga2V5OiBcInVuZGVyc3RhbmRpbmdcIixcbiAgICAgIGxhYmVsOiBcIlVuZGVyc3RhbmRpbmdcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJkaXJlY3Rpb25cIixcbiAgICAgIGxhYmVsOiBcIkRpcmVjdGlvblwiLFxuICAgICAgc3RhdHVzOiBcImVtcHR5XCIsXG4gICAgICBjb250ZW50OiBcIlwiLFxuICAgICAgcHJvbXB0czogW10sXG4gICAgICBjb2xvcnM6IFtdLFxuICAgIH0sXG4gICAge1xuICAgICAga2V5OiBcInBhbGV0dGVcIixcbiAgICAgIGxhYmVsOiBcIlBhbGV0dGVcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJjb25zaXN0ZW5jeVwiLFxuICAgICAgbGFiZWw6IFwiQ29uc2lzdGVuY3lcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJwcm9tcHRzXCIsXG4gICAgICBsYWJlbDogXCJSZS1jYXN0IHByb21wdHNcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJjYW5vbmljYWxcIixcbiAgICAgIGxhYmVsOiBcIkNhbm9uaWNhbCBpbWFnZXNcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICBdO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGVmYXVsdFN0YXRlKHRpdGxlOiBzdHJpbmcsIGludGVudDogc3RyaW5nKTogR2xhbW91clN0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICB0aXRsZSxcbiAgICBpbnRlbnQsXG4gICAgbGlicmFyeTogW10sXG4gICAgc2VsZWN0ZWRJZHM6IFtdLFxuICAgIG1lc3NhZ2VzOiBbXSxcbiAgICBzdHlsZUd1aWRlOiBkZWZhdWx0U3R5bGVHdWlkZSgpLFxuICAgIHRyYXk6IFtdLFxuICAgIHNjb3BlOiBcImFsbFwiLFxuICAgIGZvY3VzU2V0OiBbXSxcbiAgICBmb2N1c093bmVyOiBudWxsLFxuICAgIGZvY3VzTm90ZTogXCJcIixcbiAgICBzdGF0dXM6IHsgYnVzeTogZmFsc2UsIHRleHQ6IFwiXCIgfSxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgdHdvIHByaW1pdGl2ZXMgdW5kZXIgQk9USCBvZiB0aGUgaG91c2UncyBkYWVtb24tZGlzY292ZXJ5IGNvbnZlbnRpb25zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogRDMgcnVsZWQgdGhhdCB0aGUgY29udmVudGlvbnMgdGhlbXNlbHZlcyDigJQgcGVyLXNlc3Npb24gdG1wZGlyIEpTT04gKGJvdW50eSxcbiAqIGdsYW1vdXIsIGltYWdvLCBtYWdwaWUpIGFuZCBzaW5nbGV0b24gYCRIT01FL2RhZW1vbi5wb3J0YCArIGBkYWVtb24ucGlkYFxuICogKGFzdHJvbGFiZSwgZ3JhcGV2aW5lLCBtaW5kLW1hcHBlcikg4oCUIGJvdGggc3Vydml2ZSwgYmVjYXVzZSB0aGV5IGVuY29kZVxuICogZ2VudWluZWx5IGRpZmZlcmVudCBtb2RlbHMgKGNvbmN1cnJlbnQgc2Vzc2lvbnMgdnMgYSBzdGFuZGluZyBzaW5nbGV0b24pIGFuZFxuICogcGlja2luZyBvbmUgaXMgYSBwcm9kdWN0IGRlY2lzaW9uLCBub3QgYSBmYWN0b3Jpbmcgb25lLiBXaGF0IElTIG9uZVxuICogaW1wbGVtZW50YXRpb24gaXMgdGhlIHBhaXIgYmVsb3csIHdoaWNoIGlzIGFsc28gZXhhY3RseSB3aGVyZSBjZW5zdXMgZGVmZWN0XG4gKiAqKkwzKiogbGl2ZXMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCByZW5hbWVTeW5jLCBybVN5bmMsIHVubGlua1N5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuXG4vKipcbiAqIFdyaXRlIGB0ZXh0YCB0byBgdGFyZ2V0YCBhdG9taWNhbGx5OiB3cml0ZSBiZXNpZGUgaXQsIHRoZW4gcmVuYW1lLlxuICpcbiAqIOKblCAqKkwzLCBDTE9TRUQgQlkgQ09OU1RSVUNUSU9OLioqIEEgYmFyZSBgd3JpdGVGaWxlU3luY2AgaXMgbm90IGF0b21pYywgc28gYVxuICogQ0xJIHJlYWRpbmcgd2hpbGUgdGhlIGRhZW1vbiB3cml0ZXMgY2FuIG9ic2VydmUgYSBIQUxGLVdSSVRURU4gcG9pbnRlci4gVW5kZXJcbiAqIGEgYmVzdC1lZmZvcnQgcmVhZGVyIHRoYXQgc3VyZmFjZWQgYXMgXCJubyBydW5uaW5nIHNlc3Npb25cIiDigJQgYWJzZW5jZSByZXBvcnRlZFxuICogZm9yIHdoYXQgd2FzIHJlYWxseSBhIHRvcm4gcmVhZCwgd2hpY2ggaXMgdGhlIGV4YWN0IGNvbmZsYXRpb24gdGhlIGhvdXNlJ3NcbiAqIGBudWxsYC1ub3QtYDBgIHJ1bGUgZXhpc3RzIHRvIHByZXZlbnQuIFJlbmFtZSB3aXRoaW4gb25lIGRpcmVjdG9yeSBpcyBhdG9taWMsXG4gKiBzbyBhIHJlYWRlciBzZWVzIGVpdGhlciB0aGUgcHJldmlvdXMgcG9pbnRlciBvciB0aGUgbmV3IG9uZSwgbmV2ZXIgYSBwYXJ0aWFsXG4gKiBmaWxlLlxuICpcbiAqIEZpeGVkIGluIGdsYW1vdXIgMjAyNi0wOS0wNywgZm91bmQgc3RhbmRpbmcgaW4gdGhyZWUgc2libGluZ3MgdGhlIG5leHQgZGF5IGJ5XG4gKiB0aGUgZHVwbGljYXRpb24gcmVjb24sIGFuZCByZXBhaXJlZCBpbiBhbGwgb2YgdGhlbSB0aGUgb25seSB3YXkgdGhhdCBkb2VzIG5vdFxuICogbmVlZCBmaW5kaW5nIGFnYWluOiB0aGVyZSBpcyBub3cgb25lIGltcGxlbWVudGF0aW9uLlxuICpcbiAqIOKaoCBUaGUgdGVtcCBuYW1lIGNhcnJpZXMgdGhlIHBpZCwgc28gdHdvIGRhZW1vbnMgcmFjaW5nIHRvIHB1Ymxpc2ggdGhlIHNhbWVcbiAqIHBvaW50ZXIgY2Fubm90IGNsb2JiZXIgZWFjaCBvdGhlcidzIGludGVybWVkaWF0ZSBmaWxlIOKAlCBhbmQgaXQgaXMgcmVtb3ZlZCBvblxuICogYSBmYWlsZWQgd3JpdGUgcmF0aGVyIHRoYW4gbGVmdCBhcyBsaXR0ZXIgYmVzaWRlIHRoZSByZWFsIG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlRmlsZUF0b21pYyh0YXJnZXQ6IHN0cmluZywgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHRtcCA9IGAke3RhcmdldH0uJHtwcm9jZXNzLnBpZH0udG1wYDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKHRtcCwgdGV4dCk7XG4gICAgcmVuYW1lU3luYyh0bXAsIHRhcmdldCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRyeSB7XG4gICAgICBybVN5bmModG1wLCB7IGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogdGhlIHRlbXAgZmlsZSBpcyBhbHJlYWR5IGdvbmUsIG9yIHdhcyBuZXZlciBjcmVhdGVkICovXG4gICAgfVxuICAgIHRocm93IGVycjtcbiAgfVxufVxuXG4vKipcbiAqIERlbGV0ZSBgcGF0aGAgaWZmIGl0IHN0aWxsIG5hbWVzIFVTLiBSZXR1cm5zIHdoZXRoZXIgaXQgd2FzIGRlbGV0ZWQuXG4gKlxuICog4puUICoqXCJTVElMTCBPVVJTXCIgSVMgVEhFIFdIT0xFIEZVTkNUSU9OLioqIEEgZGFlbW9uIHRoYXQgdW5saW5rcyBpdHMgZGlzY292ZXJ5XG4gKiBmaWxlIHVuY29uZGl0aW9uYWxseSBhdCBleGl0IGRlbGV0ZXMgdGhlIHBvaW50ZXIgYSBTVUNDRVNTT1IgaGFzIGFscmVhZHlcbiAqIHdyaXR0ZW4g4oCUIHRoZSBzdWNjZXNzb3IgY2FuIHRoZW4gbm8gbG9uZ2VyIGJlIGZvdW5kIGFuZCB0aGUgbmV4dCBDTEkgdmVyYiBzcGF3bnMgYVxuICogdGhpcmQgZGFlbW9uLiBCb3RoIGNvbnZlbnRpb25zIGhhdmUgdGhpcyBoYXphcmQgYW5kIGJvdGggZXhwcmVzcyBpdFxuICogZGlmZmVyZW50bHk6IGFzdHJvbGFiZSBjb21wYXJlcyB0aGUgcGlkIGZpbGUncyBieXRlcyB0byBpdHMgb3duIHBpZCxcbiAqIG1hZ3BpZSBwYXJzZXMgdGhlIEpTT04gcG9pbnRlciBhbmQgY29tcGFyZXMgYHNlc3Npb25faWRgLiBgaWRlbnRpZnlgIGlzIHdoYXRcbiAqIG1ha2VzIHRob3NlIG9uZSBmdW5jdGlvbiDigJQgaXQgdHVybnMgdGhlIGZpbGUncyBieXRlcyBpbnRvIHRoZSBpZGVudGl0eSB0b1xuICogY29tcGFyZSwgYW5kIGl0IGRlZmF1bHRzIHRvIHRoZSB0cmltbWVkIGJ5dGVzIHRoZW1zZWx2ZXMuXG4gKlxuICog4pqgIEV2ZXJ5IGZhaWx1cmUgaXMgc3dhbGxvd2VkIGFuZCByZXBvcnRlZCBhcyBgZmFsc2VgOiB0aGUgZmlsZSBiZWluZyBnb25lLFxuICogdW5yZWFkYWJsZSwgb3IgdW5wYXJzZWFibGUgYWxsIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZSDigJQgaXQgaXMgbm90IG91cnMgdG9cbiAqIHJlbW92ZS4gQW4gdW5wYXJzZWFibGUgcG9pbnRlciBpcyBkZWxpYmVyYXRlbHkgTk9UIHRyZWF0ZWQgYXMgb3Vycywgd2hpY2ggaXNcbiAqIHRoZSBjb25zZXJ2YXRpdmUgaGFsZiBvZiB0aGUgc2FtZSBgbnVsbGAtbm90LWAwYCBydWxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdW5saW5rSWZNYXRjaGVzKFxuICBwYXRoOiBzdHJpbmcsXG4gIGV4cGVjdGVkOiBzdHJpbmcsXG4gIGlkZW50aWZ5OiAocmF3OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGwgPSAocmF3KSA9PiByYXcudHJpbSgpLFxuKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGlkZW50aWZ5KHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpICE9PSBleHBlY3RlZCkgcmV0dXJuIGZhbHNlO1xuICAgIHVubGlua1N5bmMocGF0aCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBpbi1wcm9jZXNzIGV2ZW50IGxvZyDigJQgdGhlIGFwcGVuZC1vbmx5LCByZXBsYXlhYmxlIGJ1ZmZlclxuICogYmVoaW5kIGV2ZXJ5IHNwZWxsJ3MgYEdFVCAvZXZlbnRzYCBTU0UgdGFpbC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzXG4gKiBgc2NyaXB0cy9ldmVudHMudHNgIOKAlCB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMyLCBhbmQgdGhlIG9ubHkgb25lIG9mXG4gKiB0aGUgc2l4IGNvcGllZC1pbi1wbGFjZSBidXNlcyB0aGF0IGlzIGEgbW9kdWxlLCBpcyBib3VuZGVkLCBjYXJyaWVzIGFuIGVwb2NoLCBhbmQgaXNcbiAqIHVuaXQtdGVzdGVkLiBUaGUgZml2ZSBvdGhlcnMgYXJlIHRoZSBzYW1lIHR3ZW50eSBsaW5lcyB3cml0dGVuIGZpdmUgdGltZXMuXG4gKlxuICog4pSA4pSAIFRIRSBUSFJFRSBUSElOR1MgVEhJUyBGSVhFUyDigJQgVFdPIEJZIENPTlNUUlVDVElPTiwgT05FIEJZIE9QVC1JTiDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiDim5QgVEhFIEhFQURJTkcgVVNFRCBUTyBTQVkgXCJUSEUgVEhSRUUgVEhJTkdTIFRISVMgRklYRVMgQlkgQ09OU1RSVUNUSU9OXCIgQU5EXG4gKiBJVEVNIDIgSVMgTk9UIE9ORSBPRiBUSEVNLiBDb3JyZWN0ZWQgMjAyNi0wOS0wOSBpbiBtaW5kLW1hcHBlcidzIHByZS13b3JrXG4gKiAoRDc5KTogYGVwb2NoYCBpcyBPUFRJT05BTCBoZXJlLCBzbyBMNiBpcyBjbG9zZWQgb25seSBmb3IgYSBjYWxsZXIgdGhhdCBhc2tzLlxuICogVGhyZWUgYWRvcHRlcnMgaGF2ZSBzaW5jZSBkZWNsaW5lZCB0byDigJQgaW1hZ28gKEQzOSksIGJvdW50eSAoRDQ4KSBhbmRcbiAqIGdyYXBldmluZSAoRDcwKSDigJQgc28gdGhlIGRlZmVjdCB0aGUgaGVhZGluZyBjbGFpbWVkIHRvIG1ha2UgaW1wb3NzaWJsZSBpc1xuICogbGl2ZSBpbiB0aGUgdHJlZSwgYnkgb3B0LW91dCwgYW5kIHRoZSBvdmVyY2xhaW0gaXMgd2hhdCBoaWQgdGhhdC4gSXRlbXMgMSBhbmRcbiAqIDMgQVJFIGJ5IGNvbnN0cnVjdGlvbjogYSBjYWxsZXIgY2Fubm90IHN3aXRjaCB0aGUgY2FwIG9mZiBvciByZWFjaCB0aGUgYnVmZmVyLlxuICpcbiAqIOKaoCBBTkQgTUlORC1NQVBQRVInUyBPV04gQlVTLCBXSElDSCBUSElTIE1PRFVMRSBDT05WRVJHRUQgVE9XQVJELCBUWVBFUyBUSEVcbiAqIEVQT0NIIEFTIFJFUVVJUkVEIGFuZCBzdGFtcHMgaXQgdW5jb25kaXRpb25hbGx5IOKAlCBpdCBpcyB0aGUgc3BlbGwgY2Vuc3VzIEw2XG4gKiBuYW1lcyBhcyBDT1JSRUNULiBNYWtpbmcgaXQgcmVxdWlyZWQgSEVSRSBpcyBub3QgdGhlIHJlcGFpcjogaXQgd291bGQgcmV2ZXJzZVxuICogRDM5LCBENDggYW5kIEQ3MC4gVGhlIGhvbmVzdCBzdGF0ZW1lbnQgaXMgdGhpcyBoZWFkaW5nLlxuICpcbiAqIOKblCAqKlJFU09MVkVEIEFUIFRIQVQgU1BFTEwnUyBQT1JULCBBTkQgVEhFIERJU1BPU0lUSU9OIElTIFJFQ09SREVEIEhFUkVcbiAqIEJFQ0FVU0UgQSBMT1NTIFRIQVQgTElWRVMgT05MWSBJTiBBIEpPVVJOQUwgSVMgQSBMT1NTIE5PQk9EWSBDQU4gU0VFXG4gKiAoRDc5L0Q4NSkuKiogbWluZC1tYXBwZXIgYWRvcHRlZCB0aGlzIG1vZHVsZSBpbiBQaGFzZSA3IGFuZCBrZXB0IGl0c1xuICogZ3VhcmFudGVlIFdJVEhPVVQgQSBLSVQgQ0hBTkdFOiBpdCBwYXNzZXMgYHsgZXBvY2g6IGNyeXB0by5yYW5kb21VVUlEKCkgfWAgYXRcbiAqIGl0cyBPTkUgY29uc3RydWN0aW9uIHNpdGUgYW5kIHJlLXRpZ2h0ZW5zIGBlcG9jaGAgdG8gUkVRVUlSRUQgaW4gaXRzIG93blxuICogbG9jYWwgZnJhbWUgdHlwZSwgc28gbm90aGluZyBpdHMgYnVzIGVtaXRzIGNhbiBsYWNrIG9uZS4gS2l0IGJ5dGVzOiB6ZXJvLlxuICogKipTbyB0aGUgZXBvY2ggaXMgYSBMT1NTWS1DT1BZIHByb3BlcnR5IHdob3NlIGRpc3Bvc2l0aW9uIGlzIEtFRVAtTE9DQUwsIG5vdFxuICogUkVTVE9SRSoqIOKAlCB0aGUgb25seSBwcm9wZXJ0eSBvZiB0aGF0IHNwZWxsJ3Mgb3duIG1vZHVsZSB0aGlzIG1vZHVsZSBjb3VsZFxuICogbm90IGNhcnJ5IGFuZCBkaWQgbm90IG5lZWQgdG8uIEw2IGlzIENMT1NFRCBmb3IgdGhlIHR3byBzcGVsbHMgdGhhdCBhc2sgYW5kXG4gKiBPUEVOLCBieSBvcHQtb3V0LCBmb3IgdGhlIHRocmVlIHRoYXQgZGVjbGluZTsgdGhhdCBhc3ltbWV0cnkgaXMgdGhlIGhvbmVzdFxuICogc3RhdGUgYW5kIHRoaXMgaGVhZGluZyBpcyB3aGVyZSBpdCBpcyB3cml0dGVuLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgQURPUFRJT04gUkVOQU1FUyBBIEZJRUxEIE9OIEFOIEFET1BURVInUyBQVUJMSVNIRUQgV0lSRS4qKiBgaWRgXG4gKiBpcyBuYW1lZCBpbiBgRnJhbWU8VD5gIGFuZCBpbiB0aGUgZW1pdCBsaXRlcmFsIGJlbG93LCBzbyBhIHNwZWxsIHdob3NlIGJ1c1xuICogc3BlbGxlZCB0aGUgY3Vyc29yIGFueXRoaW5nIGVsc2UgcGF5cyBhIHJlbmFtZSBhdCBldmVyeSByZWFkZXIg4oCUIGZvclxuICogbWluZC1tYXBwZXIsIDE3MyBvY2N1cnJlbmNlcyBhY3Jvc3MgNSBzdXJmYWNlIGZpbGVzLCB+MjA5IGFjcm9zcyB+MzAgYmFja2VuZFxuICogZmlsZXMsIGV2ZXJ5IEpTT05MIGxpbmUgaXRzIGB0YWlsYCB3cml0ZXMgaW50byBhbiBhZ2VudCdzIHBpcGUsIGFuZCAodGhlIG9uZVxuICogbm9ib2R5IGNvdW50ZWQpIHRoZSBGSVhUVVJFIGluIGl0cyBvd24gYHRhaWwudGVzdC50c2AsIHdoaWNoIFdSSVRFUyB0aGVcbiAqIGVudmVsb3BlIHdoaWxlIHN0YW5kaW5nIGluIGZvciB0aGUgZGFlbW9uLiBUaGUgTkVTVElORyBpcyBub3QgZm9yY2VkIOKAlFxuICogYEZyYW1lPFQ+YCBpcyBnZW5lcmljLCBhbmQgbWluZC1tYXBwZXIga2VwdCBge2tpbmQsIHBheWxvYWR9YCBuZXN0ZWQgd2hlcmUgYWxsXG4gKiBmaXZlIGVhcmxpZXIgYWRvcHRlcnMgZmxhdHRlbiBieSBpZGlvbS4gKipBbiBpZGlvbSBmaXZlIHNpYmxpbmdzIHNoYXJlIGlzXG4gKiBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgY29udHJhY3QgdW50aWwgeW91IG9wZW4gdGhlIHR5cGUqKiAoRDgxLCBEODYpLlxuICpcbiAqICoqMSDCtyBMNSDigJQgdGhlIGJ1ZmZlciBpcyBib3VuZGVkLioqIEZpdmUgZGFlbW9ucyBhcHBlbmQgdG8gYW4gYXJyYXkgZm9yIHRoZVxuICogd2hvbGUgbGlmZSBvZiB0aGUgcHJvY2Vzcy4gVGhlIHdpbmRvdyBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogZGFlbW9uJ3MgbGlmZXRpbWUsIG5vdCBhIGR1cmFibGUgbG9nOyBhIGNhcCBpcyB0aGUgaG9uZXN0IHNoYXBlLlxuICpcbiAqICoqMiDCtyBMNiDigJQgYSBmcmFtZSBjYXJyaWVzIGFuIGVwb2NoLCBXSEVOIFRIRSBDQUxMRVIgQVNLUyBGT1IgT05FIChvcHQtaW4sXG4gKiBub3QgY29uc3RydWN0aW9uIOKAlCBzZWUgYWJvdmUpLioqIEFmdGVyIGEgcmVzdGFydCB0aGUgaWRzIHN0YXJ0IGFnYWluIGF0IDEsIHNvXG4gKiBhIHJlc3VtaW5nIGNsaWVudCBjYW5ub3QgdGVsbCBhIHN0YWxlIHdhdGVybWFyayBmcm9tIGEgZnJlc2ggb25lIGJ5IGlkIGFsb25lLlxuICpcbiAqICoqMyDCtyBBIFNUQUxFIFdBVEVSTUFSSyBSRVBMQVlTIEZST00gVEhFIEJFR0lOTklORywgYW5kIHRoaXMgaXMgdGhlIGhhbGYgdGhlXG4gKiBjbGllbnQgY2Fubm90IGRvLioqIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogYSB0YWlsIHRoYXQgcmVzdW1lcyBhdFxuICogYHNpbmNlPTxsYXN0IGlkIG9mIHRoZSBwcmV2aW91cyBkYWVtb24+YCBhZ2FpbnN0IGEgcmVzdGFydGVkIGRhZW1vbiByZWNlaXZlc1xuICogTk9USElORyDigJQgdGhlIG5ldyBkYWVtb24ncyBgcmVhZHlgIGlzIGlkIDEsIHdoaWNoIGlzIG5vdCBgPiBzaW5jZWAsIHNvIHRoZVxuICogZmlsdGVyIGRyb3BzIGl0LCBzbyBubyBmcmFtZSBhcnJpdmVzLCBzbyB0aGUgY2xpZW50J3MgZXBvY2ggY2hlY2sgbmV2ZXIgcnVuc1xuICogYW5kIHRoZSB0YWlsIHNpdHMgY29ubmVjdGVkIGFuZCBzaWxlbnQgdW50aWwgdGhlIG5ldyBkYWVtb24gaGFzIGVtaXR0ZWQgYXNcbiAqIG1hbnkgZXZlbnRzIGFzIHRoZSBvbGQgb25lIGRpZC4gU3RhbXBpbmcgYW4gZXBvY2ggYWxvbmUgZG9lcyBOT1QgY2xvc2UgdGhhdFxuICogZ2FwOiB0aGUgZXBvY2ggcmlkZXMgYSBmcmFtZSwgYW5kIHRoZSBidWcgaXMgdGhhdCBubyBmcmFtZSBpcyBzZW50LiBTb1xuICogYHN1YnNjcmliZWAgdHJlYXRzIGBzaW5jZSA+IGN1cnNvcmAgYXMgXCJ0aGlzIGN1cnNvciBpcyBmcm9tIGFub3RoZXIgcHJvY2Vzc1wiXG4gKiBhbmQgcmVwbGF5cyB3aG9sZS4gYG1pbmQtbWFwcGVyL3NjcmlwdHMvdGFpbC50ZXN0LnRzYCdzIGVwb2NoIGNlbGwgaXMgdGhlXG4gKiBleGVjdXRhYmxlIHNwZWMgb2YgdGhlIGNsaWVudCBoYWxmIGFuZCBzaG93cyB0aGUgcmVjb25uZWN0IHN0aWxsIGNhcnJ5aW5nIHRoZVxuICogc3RhbGUgY3Vyc29yIOKAlCBkZXRlY3Rpb24gaGFwcGVucyBvbiB3aGF0IGlzIFJFQ0VJVkVELlxuICpcbiAqIOKUgOKUgCDim5QgR1JBUEVWSU5FIERPRVMgTk9UIEFET1BUIFRISVMsIEFORCBUSEUgUkVGVVNBTCBJUyBQQVJUIE9GIFRIRSBSVUxJTkcg4pSA4pSAXG4gKlxuICogUkVKRUNULVNUUlVDVFVSQUwsIHJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCkuIE5vdFxuICogXCJubyBzdWJqZWN0XCIg4oCUIGdyYXBldmluZSBIQVMgYW4gZXZlbnQgYnVzIGFuZCBpdCBpcyB0aGUgYnVzaWVzdCB0aGluZyBpbiB0aGVcbiAqIHNwZWxsIOKAlCBidXQgdGhlIHR3byBzaGFwZXMgY2Fubm90IGJlIGNvbnN0cnVjdGVkIGZyb20gZWFjaCBvdGhlcjpcbiAqXG4gKiAgIHRoaXMgbW9kdWxlICBvbmUgcHJvY2Vzcy13aWRlIGFycmF5IGNhcHBlZCBhdCBSRVBMQVlfQlVGRkVSX1NJWkUsIHdpdGggb25lXG4gKiAgICAgICAgICAgICAgICBtb25vdG9uaWMgYHNlcWAsIGFuZCB0aGUgaGVhZGVyIHRocmVlIHBhcmFncmFwaHMgdXAgc2F5cyBpbiBhc1xuICogICAgICAgICAgICAgICAgbWFueSB3b3JkcyB0aGF0IGl0IGlzIGEgUkVQTEFZIHdpbmRvdyBmb3IgcmVjb25uZWN0cyB3aXRoaW4gb25lXG4gKiAgICAgICAgICAgICAgICBkYWVtb24ncyBsaWZldGltZSwgTk9UIGEgZHVyYWJsZSBsb2cuXG4gKiAgIGdyYXBldmluZSAgICBOIGR1cmFibGUgYXBwZW5kLW9ubHkgYC5qc29ubGAgZmlsZXMsIG9uZSBwZXIgbmFtZWQgY2hhbm5lbCxcbiAqICAgICAgICAgICAgICAgIGVhY2ggd2l0aCBpdHMgb3duIGBuZXh0X2lkYCwgcmVwbGF5ZWQgZnJvbSBkaXNrIGJ5XG4gKiAgICAgICAgICAgICAgICBgcmVhZEJhY2tsb2dgLCBzdXJ2aXZpbmcgcmVzdGFydCwgYHJvbGxgLCBhcmNoaXZlIGFuZCBjbGVhci5cbiAqXG4gKiAqKlRoZSByZWFkZXIgdGhhdCBtYWtlcyB0aGVtIGluY29tcGF0aWJsZSwgYXMgYSBtZWFzdXJlbWVudCByYXRoZXIgdGhhbiBhblxuICogYXNzZXJ0aW9uOioqIGdyYXBldmluZSdzIGBsb2FkQ2hhbm5lbCgpYCBkZXJpdmVzIGBuZXh0X2lkYCBhcyBhIEhJR0gtV0FURVJcbiAqIE1BUksgb3ZlciBldmVyeSBwYXJzZWFibGUgbGluZSBvZiB0aGUgY2hhbm5lbCdzIGZpbGUgb24gYm9vdC4gVGhlcmUgaXMgbm9cbiAqIGFycmF5IHRvIGJlIHRoYXQgbWFyayBvZiwgYW5kIG5vIGNhcCB0aGF0IHdvdWxkIG5vdCBzaWxlbnRseSBkaXNjYXJkIGhpc3RvcnlcbiAqIGEgY2FsbGVyIGNhbiBzdGlsbCBhc2sgZm9yIGJ5IGlkLiBJdCBpcyB0aGUgdGhpbmcgdGhpcyBtb2R1bGUncyBvd24gaGVhZGVyXG4gKiBzYXlzIGl0IGlzIGRlbGliZXJhdGVseSBub3QuXG4gKlxuICogKipUaGUgd2lkZW5pbmcgTk9UIGRvbmUsIHdpdGggaXRzIGNvc3Q6KiogYWRtaXR0aW5nIGEgcGVyLWNoYW5uZWwgZHVyYWJsZVxuICogc3RvcmUgd291bGQgY2hhbmdlIGBjcmVhdGVFdmVudExvZ2AncyBzdG9yYWdlIGFuZCBpdHMgYHN1YnNjcmliZWAgY29udHJhY3QgZm9yXG4gKiBmaXZlIG90aGVyIGRhZW1vbnMsIHJlLWVtaXR0aW5nIFNJWCBhcnRpZmFjdHMgYWNyb3NzIEZJVkUgc3BlbGxzLCBlYWNoIG93ZWQgYVxuICogZHJpdmUg4oCUIHBhaWQgYnkgcG9ydHMgdGhhdCBhcmUgYWxyZWFkeSBmaW5pc2hlZCBhbmQgYnkgYWdlbnRzIG5vdCBpbiB0aGUgcm9vbS5cbiAqIEEgd2lkZW5pbmcgcmVtYWlucyBhdmFpbGFibGUgYXMgaXRzIG93biBhcmd1ZWQgZGVjaXNpb24gd2l0aCBpdHMgb3duXG4gKiBibGFzdC1yYWRpdXMgY291bnQ7IGl0IGlzIG5ldmVyIGEgc3RlcCBpbnNpZGUgYSBwb3J0LlxuICpcbiAqIOKaoCBBTkQgVEhFIGBlcG9jaGAgQUJPVkUgSVMgVEhFIFNIQVJQRVNUIEhBTEYgT0YgV0hZIChENzApLiBHcmFwZXZpbmUncyBpZHMgYXJlXG4gKiBSRUNPVkVSRUQgYWNyb3NzIGEgcmVzdGFydCwgc28gdGhlIGNvbmRpdGlvbiBwYXJhZ3JhcGggMiBkZXNjcmliZXMg4oCUIGlkc1xuICogc3RhcnRpbmcgYWdhaW4gYXQgMSDigJQgY2Fubm90IG9jY3VyIHRoZXJlLCBhbmQgc3RhbXBpbmcgb25lIGFueXdheSBpcyBub3RcbiAqIGluZXJ0OiBgdGFpbEV2ZW50c2AncyBgb25FcG9jaENoYW5nZWAgc2V0cyB0aGUgY3Vyc29yIHRvIDAsIGFuZCBncmFwZXZpbmUnc1xuICogdGFpbCByb3V0ZSBhbnN3ZXJzIGBzaW5jZT0wYCB3aXRoIHRoZSBXSE9MRSBjaGFubmVsIGxvZyBvZmYgZGlzaywgaW50byBhblxuICogYWdlbnQncyBwaXBlLCBvbiBldmVyeSBgcm9sbGAuIFRoZSBlcG9jaCdzIGNsaWVudC1zaWRlIGFjdGlvbiBpcyBcInlvdXIgY3Vyc29yXG4gKiBpcyB3b3J0aGxlc3MsIHN0YXJ0IG92ZXJcIiwgYW5kIHRoYXQgaXMgc2FmZSBvbmx5IHdoZXJlIHN0YXJ0aW5nIG92ZXIgY29zdHMgYVxuICogYm91bmRlZCBpbi1tZW1vcnkgcmVwbGF5IHdpbmRvdy5cbiAqL1xuXG4vKiogVGhlIGRlZmF1bHQgcmVwbGF5IHdpbmRvdywgaW5oZXJpdGVkIGZyb20gbWluZC1tYXBwZXIncyBtZWFzdXJlZCBjYXAuICovXG5leHBvcnQgY29uc3QgUkVQTEFZX0JVRkZFUl9TSVpFID0gMTAwMDtcblxuLyoqIEEgZnJhbWUgYXMgaXQgZ29lcyBvbiB0aGUgd2lyZTogdGhlIGNhbGxlcidzIHBheWxvYWQgcGx1cyBhIG1vbm90b25pYyBgaWRgLFxuICogIHBsdXMgYW4gYGVwb2NoYCB3aGVuIHRoZSBsb2cgd2FzIGdpdmVuIG9uZS4gKi9cbmV4cG9ydCB0eXBlIEZyYW1lPFQ+ID0gVCAmIHsgaWQ6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfTtcblxuZXhwb3J0IGludGVyZmFjZSBFdmVudExvZzxUPiB7XG4gIC8qKiBBcHBlbmQgb25lIGZyYW1lLCBmYW4gaXQgb3V0IHRvIGxpdmUgc3Vic2NyaWJlcnMsIGFuZCByZXR1cm4gaXQuICovXG4gIGVtaXQobXNnOiBUKTogRnJhbWU8VD47XG4gIC8qKlxuICAgKiBSZXBsYXkgZXZlcnl0aGluZyBhZnRlciBgc2luY2VgLCB0aGVuIHN0YXkgc3Vic2NyaWJlZC4gUmV0dXJucyBhblxuICAgKiB1bnN1YnNjcmliZSBmdW5jdGlvbi5cbiAgICpcbiAgICog4puUIFJFUExBWSBBTkQgU1VCU0NSSUJFIEFSRSBPTkUgQ0FMTCBPTiBQVVJQT1NFLiBEb2luZyB0aGVtIGluIHR3byBzdGVwc1xuICAgKiBsZWF2ZXMgYSB3aW5kb3cgaW4gd2hpY2ggYW4gZW1pdCBsYW5kcyBiZXR3ZWVuIHRoZSByZXBsYXkgbG9vcCBhbmQgdGhlXG4gICAqIGBhZGRgLCBhbmQgdGhhdCBmcmFtZSBpcyBkZWxpdmVyZWQgdG8gbm9ib2R5IOKAlCB0aGUgc2hhcGUgZml2ZSBkYWVtb25zIGhhdmUsXG4gICAqIHN1cnZpdmVkIGJ5IG5vdGhpbmcgYnV0IHRoZSBzaW5nbGUtdGhyZWFkZWQgZXZlbnQgbG9vcCBoYXBwZW5pbmcgdG8gY2xvc2VcbiAgICogaXQuIERlcGVuZGluZyBvbiB0aGF0IGlzIGRlcGVuZGluZyBvbiBhbiBpbXBsZW1lbnRhdGlvbiBkZXRhaWwgb2YgdGhlXG4gICAqIHJ1bnRpbWUgcmF0aGVyIHRoYW4gb24gdGhlIGNvZGUuXG4gICAqL1xuICBzdWJzY3JpYmUoc2luY2U6IG51bWJlciwgbGlzdGVuZXI6IChmcmFtZTogRnJhbWU8VD4pID0+IHZvaWQpOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGhpZ2hlc3QgaWQgZW1pdHRlZCBzbyBmYXIg4oCUIHdoYXQgYEdFVCAvc3RhdGVgIHJldHVybnMgYXMgYGN1cnNvcmAuICovXG4gIGN1cnNvcigpOiBudW1iZXI7XG4gIC8qKiBUaGUgZXBvY2ggc3RhbXBlZCBvbiBldmVyeSBmcmFtZSwgb3IgYHVuZGVmaW5lZGAgaWYgbm9uZSB3YXMgY29uZmlndXJlZC4gKi9cbiAgcmVhZG9ubHkgZXBvY2g6IHN0cmluZyB8IHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUV2ZW50TG9nPFQgZXh0ZW5kcyBvYmplY3Q+KFxuICBvcHRzOiB7IGVwb2NoPzogc3RyaW5nOyBidWZmZXJTaXplPzogbnVtYmVyIH0gPSB7fSxcbik6IEV2ZW50TG9nPFQ+IHtcbiAgY29uc3QgYnVmZmVyU2l6ZSA9IG9wdHMuYnVmZmVyU2l6ZSA/PyBSRVBMQVlfQlVGRkVSX1NJWkU7XG4gIGNvbnN0IGVwb2NoID0gb3B0cy5lcG9jaDtcbiAgY29uc3QgYnVmZmVyOiBBcnJheTxGcmFtZTxUPj4gPSBbXTtcbiAgY29uc3QgbGlzdGVuZXJzID0gbmV3IFNldDwoZnJhbWU6IEZyYW1lPFQ+KSA9PiB2b2lkPigpO1xuICBsZXQgc2VxID0gMDtcblxuICByZXR1cm4ge1xuICAgIGVwb2NoLFxuXG4gICAgZW1pdChtc2cpIHtcbiAgICAgIHNlcSArPSAxO1xuICAgICAgLy8g4puUIFRIRSBNT05PVE9OSUMgSUQgV0lOUyBPVkVSIEFOWVRISU5HIElOIFRIRSBQQVlMT0FELCBBTkQgVU5USUwgTk9XIElUXG4gICAgICAvLyBPTkxZIENMQUlNRUQgVE8uIEJvdGggYWRvcHRpbmcgZGFlbW9ucyB3cm90ZSBgeyBpZDogKytzZXEsIC4uLm1zZyB9YFxuICAgICAgLy8gdW5kZXIgYSBjb21tZW50IHNheWluZyBcInRoZSBtb25vdG9uaWMgYGlkYCBNVVNUIHdpbiBvdmVyIGFueSBgaWRgIGluXG4gICAgICAvLyB0aGUgcGF5bG9hZCwgc28gY2FsbGVycyBjYXJyeSBhIHByb2plY3QgaWRlbnRpZmllciBhcyBgcHJvamVjdElkYCxcbiAgICAgIC8vIG5ldmVyIGBpZGBcIiDigJQgYnV0IHNwcmVhZCBvcmRlciBtZWFucyBhIHBheWxvYWQgYGlkYCBvdmVycm9kZSB0aGVcbiAgICAgIC8vIGN1cnNvciwgc2lsZW50bHksIGFuZCB0aGUgY29udmVudGlvbiBpbiB0aGUgY29tbWVudCB3YXMgdGhlIG9ubHkgdGhpbmdcbiAgICAgIC8vIGhvbGRpbmcgaXQuIFRoZSBsaXRlcmFsIGtlZXBzIGBpZGAgRklSU1Qgc28gdGhlIHdpcmUga2V5IG9yZGVyIGlzXG4gICAgICAvLyB1bmNoYW5nZWQ7IHRoZSBhc3NpZ25tZW50IGFmdGVyIHRoZSBzcHJlYWQgaXMgd2hhdCBtYWtlcyB0aGUgc2VudGVuY2VcbiAgICAgIC8vIHRydWUuIGBlcG9jaGAgaXMgc3RhbXBlZCB0aGUgc2FtZSB3YXkgYW5kIGZvciB0aGUgc2FtZSByZWFzb24uXG4gICAgICBjb25zdCBmcmFtZSA9IHsgaWQ6IHNlcSwgLi4ubXNnIH0gYXMgRnJhbWU8VD47XG4gICAgICBmcmFtZS5pZCA9IHNlcTtcbiAgICAgIGlmIChlcG9jaCAhPT0gdW5kZWZpbmVkKSBmcmFtZS5lcG9jaCA9IGVwb2NoO1xuXG4gICAgICBidWZmZXIucHVzaChmcmFtZSk7XG4gICAgICBpZiAoYnVmZmVyLmxlbmd0aCA+IGJ1ZmZlclNpemUpIGJ1ZmZlci5zaGlmdCgpO1xuICAgICAgZm9yIChjb25zdCBsaXN0ZW5lciBvZiBsaXN0ZW5lcnMpIGxpc3RlbmVyKGZyYW1lKTtcbiAgICAgIHJldHVybiBmcmFtZTtcbiAgICB9LFxuXG4gICAgc3Vic2NyaWJlKHNpbmNlLCBsaXN0ZW5lcikge1xuICAgICAgLy8gU2VlIHRoZSBoZWFkZXIsIHBvaW50IDM6IGEgY3Vyc29yIGJleW9uZCBvdXIgb3duIGlzIGEgY3Vyc29yIGZyb20gYVxuICAgICAgLy8gUFJJT1IgUFJPQ0VTUywgYW5kIHRoZSBvbmx5IHVzZWZ1bCByZWFkaW5nIG9mIGl0IGlzIFwicmVwbGF5IHdob2xlXCIuXG4gICAgICAvL1xuICAgICAgLy8g4pqgIEEgTk9OLUZJTklURSBDVVJTT1IgQUxTTyBNRUFOUyBcIkZST00gVEhFIFNUQVJUXCIsIHdoaWNoIHRoZSBjb3BpZXMgZ290XG4gICAgICAvLyB3cm9uZyBieSBhY2NpZGVudDogdGhleSB3cm90ZSBgcGFyc2VJbnQocGFyYW0gPz8gXCItMVwiKWAgYW5kIGNvbXBhcmVkXG4gICAgICAvLyBgaWQgPiBzaW5jZWAsIHNvIGEgdHlwbydkIGA/c2luY2U9eGAgcHJvZHVjZWQgYE5hTmAsIGV2ZXJ5IGNvbXBhcmlzb25cbiAgICAgIC8vIHdhcyBmYWxzZSwgYW5kIHRoZSB0YWlsIG9wZW5lZCBFTVBUWSBhbmQgc3RheWVkIGNvbm5lY3RlZCDigJQgdGhlIHNhbWVcbiAgICAgIC8vIHNpbGVudC1hbmQtY29ubmVjdGVkIHN5bXB0b20gYXMgdGhlIHN0YWxlIHdhdGVybWFyaywgZnJvbSBhIGRpZmZlcmVudFxuICAgICAgLy8gY2F1c2UuIEFic2VudCBhbmQgdW5wYXJzZWFibGUgYXJlIHRoZSBzYW1lIHJlcXVlc3QgaGVyZS5cbiAgICAgIGNvbnN0IGZyb20gPSAhTnVtYmVyLmlzRmluaXRlKHNpbmNlKSB8fCBzaW5jZSA+IHNlcSA/IC0xIDogc2luY2U7XG4gICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIGJ1ZmZlcikge1xuICAgICAgICBpZiAoZnJhbWUuaWQgPiBmcm9tKSBsaXN0ZW5lcihmcmFtZSk7XG4gICAgICB9XG4gICAgICBsaXN0ZW5lcnMuYWRkKGxpc3RlbmVyKTtcbiAgICAgIHJldHVybiAoKSA9PiB7XG4gICAgICAgIGxpc3RlbmVycy5kZWxldGUobGlzdGVuZXIpO1xuICAgICAgfTtcbiAgICB9LFxuXG4gICAgY3Vyc29yKCkge1xuICAgICAgcmV0dXJuIHNlcTtcbiAgICB9LFxuICB9O1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBkYWVtb24gbGlmZWN5Y2xlIHRhaWw6IHRoZSBpZGxlLWNsb3NlIGRlY2lzaW9uLCB0aGUgc3dlZXBcbiAqIHRoYXQgbWFrZXMgaXQsIGFuZCB0aGUgYm91bmRlZCB0ZWFyZG93bi5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBib3VudHkg4oCUIHRoZSBjZW5zdXMnc1xuICogY29udmVyZ2VuY2UgdGFyZ2V0ICMzIOKAlCB3aXRoIGFzdHJvbGFiZSdzIGB0aW1lb3V0TXMgPiAwYCBndWFyZCBmb2xkZWQgaW4sXG4gKiB3aGljaCBpcyB0aGUgb25lIHRoaW5nIGJvdW50eSdzIGNvcHkgZG9lcyBub3QgZXhwcmVzcy5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBBRE9QVFMgYGRyYWluQW5kU3RvcGAgQU5EIE5PVEhJTkcgRUxTRSBIRVJFIOKAlCBTUExJVCBQRVIgRVhQT1JUXG4gKlxuICogUnVsZWQgYXQgZ3JhcGV2aW5lJ3MgcG9ydCAoUGhhc2UgNiwgMjAyNi0wOS0wOTsgRDY4KSwgYW5kIGl0IGlzIHdyaXR0ZW4gZG93blxuICogYmVjYXVzZSBhIHJvdyBpcyBhIE1PRFVMRSBhbmQgXCJwYXJ0aWFsXCIgaXMgbm90IGFuIGFuc3dlciB1bnRpbCBpdCBzYXlzIHdoaWNoXG4gKiBleHBvcnRzLiBHcmFwZXZpbmUgaXMgbG9uZy1ydW5uaW5nLCBzbyBub3RoaW5nIGFib3V0IGl0cyBsaWZlY3ljbGUgbWFrZXMgdGhpc1xuICogbW9kdWxlIHJlYWQgYXMgaW5hcHBsaWNhYmxlIOKAlCBhbmQgdHdvIG9mIGl0cyB0aHJlZSBleHBvcnRzIHN0aWxsIGhhdmUgbm9cbiAqIHN1YmplY3QgdGhlcmU6XG4gKlxuICogICBgc2hvdWxkSWRsZUNsb3NlYCAgICAgIE5PIFNVQkpFQ1QuIEdyYXBldmluZSBydW5zIG5vIGlkbGUgc3dlZXAgYW5kIGhhcyBub1xuICogICBgc3RhcnRIb3VzZWtlZXBpbmdgICAgIGAtLXRpbWVvdXRgOyBpdCBpcyBhIGJyb2tlciB0aGF0IHN0YW5kcyB1bnRpbCBgc3RvcGBcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAoYERFTEVURSAvYCkgb3IgYSBzaWduYWwsIGFuZCBpdCB0YWtlcyBubyBzbmFwc2hvdC5cbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBBZG9wdGluZyB0aGUgcGFpci1tYW5hZ2VyIHdvdWxkIG1lYW4gd3JpdGluZyBhIG5vLW9wXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYHRvdWNoYCBhbmQgYSBgc3Vic2NyaWJlckNvdW50YCB0aGF0IGV4aXN0cyBvbmx5IHRvXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGEgbnVtYmVyIG5vYm9keSBhY3RzIG9uIOKAlCB0d28gbGllcyB0byBnYWluIGFcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgY2xlYXJJbnRlcnZhbGAuXG4gKiAgIGBkcmFpbkFuZFN0b3BgICAgICAgICAgQURPUFRFRCwgYW5kIGl0IGlzIGEgREUtRFVQTElDQVRJT04gcmF0aGVyIHRoYW4gYVxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGdhaW46IGdyYXBldmluZSdzIHRlYXJkb3duIGFscmVhZHkgV0FTXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYFByb21pc2UucmFjZShbc2VydmVyLnN0b3AodHJ1ZSksIDIwMCBtc10pYCwgd2hpY2ggaXNcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgc3RvcE1zYCBleGFjdGx5LlxuICpcbiAqIOKaoCAqKkFORCBJVCBJUyBDQUxMRUQgV0lUSCBOTyBgY2xpZW50c2AsIFdISUNIIElTIEEgTUVBU1VSRU1FTlQsIE5PVCBBTlxuICogT1ZFUlNJR0hULioqIFRoaXMgbW9kdWxlIGNsb3NlcyBhIGhlbGQgY29ubmVjdGlvbiBieSBjYWxsaW5nIGBjbGllbnQuY2xvc2UoKWA7XG4gKiBncmFwZXZpbmUncyBzdWJzY3JpYmVyIHJlY29yZHMgYXJlIGB7YWxpYXMsIGh1bWFuLCBsdXJrLCBzZW5kfWAgYW5kIGNhcnJ5IG5vXG4gKiBgY2xvc2VgIOKAlCBpdHMgcGVyLXN0cmVhbSB0ZWFyZG93biBpcyBhIGNsb3N1cmUgc3Rhc2hlZCBvbiB0aGUgUmVhZGFibGVTdHJlYW1cbiAqIGNvbnRyb2xsZXIsIHJlYWNoYWJsZSBvbmx5IGZyb20gYGNhbmNlbCgpYC4gVGhlcmUgaXMgbm90aGluZyB0byBoYW5kIHRoZVxuICogYXJndW1lbnQuIGBzc2UudHNgJ3MgaGVhZGVyIGNhcnJpZXMgdGhlIHJlc3Qgb2YgdGhhdCBydWxpbmcsIGluY2x1ZGluZyB0aGVcbiAqIHdpZGVuaW5nIG5vdCBkb25lIGFuZCBpdHMgY29zdCAoc2l4IGFydGlmYWN0cyBhY3Jvc3MgZml2ZSBzcGVsbHMpLlxuICpcbiAqIOKaoCBHcmFwZXZpbmUgYWxzbyBwYXNzZXMgYGdyYWNlTXM6IDBgLiBOb3QgYSBkaXNhZ3JlZW1lbnQgd2l0aCB0aGUgZ3JhY2VcbiAqIHBlcmlvZDogaXQgZW1pdHMgbm8gZmFyZXdlbGwgZnJhbWUgYXQgZGFlbW9uIHNodXRkb3duLCBhbmQgaXRzIGBERUxFVEUgL2BcbiAqIGFscmVhZHkgcmV0dXJucyB0aGUgcmVzcG9uc2UgYW5kIHNjaGVkdWxlcyB0aGUgdGVhcmRvd24gMTAgbXMgbGF0ZXIsIHNvIGl0c1xuICogZmx1c2ggd2luZG93IHNpdHMgYXQgdGhlIHJvdXRlIHJhdGhlciB0aGFuIGluIHRoZSBkcmFpbi5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFNzZUNsaWVudHMgfSBmcm9tIFwiLi9zc2UudHNcIjtcblxuLyoqXG4gKiBTaG91bGQgdGhlIGRhZW1vbiBpZGxlLWNsb3NlP1xuICpcbiAqIOKblCAqKmBzdWJzY3JpYmVyQ291bnRgIElTIEEgUkVRVUlSRUQgQVJHVU1FTlQsIEFORCBUSEFUIElTIFRIRSBXSE9MRSBQT0lOVC4qKlxuICogVGhpcyBjbG9zZXMgY2Vuc3VzIGRlZmVjdCAqKkwxKiogYnkgY29uc3RydWN0aW9uOiBnbGFtb3VyLCBpbWFnbyBhbmQgbWFncGllXG4gKiBjb3VudGVkIHRoZWlyIGlkbGUgZmxvb3IgZG93biB3aGlsZSBhbiBhZ2VudCBoZWxkIGEgdGFpbCBvcGVuLCBzbyBhbiBhZ2VudFxuICogd2F0Y2hpbmcgYSBxdWlldCBib2FyZCB3YXMga2lsbGVkIFdJVEggSVRTIENPTk5FQ1RJT04gT1BFTi4gVGhlcmUgaXMgbm9cbiAqIG92ZXJsb2FkIG9mIHRoaXMgZnVuY3Rpb24gdGhhdCBjYW5ub3Qgc2VlIGl0cyBzdWJzY3JpYmVycywgc28gdGhlIGRlZmVjdFxuICogY2Fubm90IGJlIHJlLWV4cHJlc3NlZCBieSBhIGNhbGxlciB3aG8gZm9yZ2V0cy5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNDQVIgSVQgQ0FNRSBXSVRILCByZS1ob21lZCBmcm9tIGJvdW50eSB2ZXJiYXRpbSBpbiBzdWJzdGFuY2U6KipcbiAqIGEgYm9hcmQgb25seSBjb3VudHMgaXRzIGlkbGUgZmxvb3IgZG93biB3aGlsZSBVTldBVENIRUQuIEEgbGl2ZSBzdWJzY3JpYmVyIOKAlFxuICogYSBicm93c2VyIFdlYlNvY2tldCwgb3IgYW4gYWdlbnQgU1NFIHRhaWwgb24gYC9ldmVudHNgIOKAlCBrZWVwcyBpdCBvcGVuXG4gKiBpbmRlZmluaXRlbHkuIFNvIGB0aW1lb3V0YCBtZWFucyBcImxpbmdlciB0aGlzIGxvbmcgYWZ0ZXIgdGhlIExBU1Qgc3Vic2NyaWJlclxuICogbGVhdmVzXCIsIE5PVCBcIm1heGltdW0gaWRsZSB3aGlsZSBjb25uZWN0ZWRcIi4gVGhlIHN3ZWVwIGJlbG93IGFsc28gdG91Y2hlcyB0aGVcbiAqIGFjdGl2aXR5IGNsb2NrIG9uIGV2ZXJ5IHRpY2sgd2hpbGUgd2F0Y2hlZCwgc28gb25jZSB1bndhdGNoZWQgdGhlIGZsb29yXG4gKiBjb3VudHMgZnJvbSB0aGF0IGxhc3QgZGlzY29ubmVjdCBhbmQgbm90IGZyb20gdGhlIGxhc3QgcmVxdWVzdC5cbiAqXG4gKiDimqAgYHRpbWVvdXRNcyA8PSAwYCBtZWFucyBORVZFUiwgd2hpY2ggaXMgYXN0cm9sYWJlJ3Mgc3RhbmRpbmctb2JzZXJ2YXRvcnlcbiAqIGRlZmF1bHQgYW5kIGlzIHdoeSB0aGUgZ3VhcmQgaXMgaGVyZSByYXRoZXIgdGhhbiBhdCBpdHMgb25lIGNhbGwgc2l0ZTogYVxuICogc2luZ2xldG9uIGRhZW1vbiBpcyBtZWFudCB0byBzdGFuZCB1bnRpbCBpdCBpcyBleHBsaWNpdGx5IGNsb3NlZCwgYW5kIGFcbiAqIGA+PSAwYCBjb21wYXJpc29uIHdvdWxkIGNsb3NlIGl0IG9uIHRoZSBmaXJzdCB0aWNrLlxuICpcbiAqIENsb2NrLWZyZWUgYW5kIGZzLWZyZWUsIHNvIGl0IGlzIHRlc3RhYmxlIHdpdGhvdXQgYSBkYWVtb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRJZGxlQ2xvc2UoXG4gIHN1YnNjcmliZXJDb3VudDogbnVtYmVyLFxuICBpZGxlTXM6IG51bWJlcixcbiAgdGltZW91dE1zOiBudW1iZXIsXG4pOiBib29sZWFuIHtcbiAgaWYgKHRpbWVvdXRNcyA8PSAwKSByZXR1cm4gZmFsc2U7XG4gIGlmIChzdWJzY3JpYmVyQ291bnQgPiAwKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBpZGxlTXMgPj0gdGltZW91dE1zO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEhvdXNla2VlcGluZ09wdGlvbnMge1xuICAvKiog4puUIFJFUVVJUkVELiBTZWUgYHNob3VsZElkbGVDbG9zZWAg4oCUIHRoaXMgaXMgd2hhdCBjbG9zZXMgTDEuICovXG4gIHN1YnNjcmliZXJDb3VudDogKCkgPT4gbnVtYmVyO1xuICAvKiogTWlsbGlzZWNvbmRzIHNpbmNlIHRoZSBsYXN0IGFjdGl2aXR5LiAqL1xuICBpZGxlTXM6ICgpID0+IG51bWJlcjtcbiAgLyoqIFJlc2V0IHRoZSBhY3Rpdml0eSBjbG9jay4gQ2FsbGVkIG9uIGV2ZXJ5IHRpY2sgdGhhdCBoYXMgYSBzdWJzY3JpYmVyLiAqL1xuICB0b3VjaDogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBjb25maWd1cmVkIGlkbGUgdGltZW91dCBpbiBtczsgYDBgIChvciBsZXNzKSBtZWFucyBuZXZlci4gKi9cbiAgdGltZW91dE1zOiBudW1iZXI7XG4gIC8qKiBGaXJlZCBvbmNlIHdoZW4gdGhlIGRhZW1vbiBzaG91bGQgY2xvc2UgaXRzZWxmLiAqL1xuICBvbklkbGVDbG9zZTogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBkZWJvdW5jZWQgc25hcHNob3QsIGlmIHRoZSBzcGVsbCBoYXMgb25lLiAqL1xuICBzbmFwc2hvdD86IHtcbiAgICBkaXJ0eTogKCkgPT4gYm9vbGVhbjtcbiAgICBjbGVhcjogKCkgPT4gdm9pZDtcbiAgICB3cml0ZTogKCkgPT4gdm9pZCB8IFByb21pc2U8dm9pZD47XG4gIH07XG4gIC8qKiBTd2VlcCBpbnRlcnZhbDsgYm90aCBhZG9wdGluZyBkYWVtb25zIHVzZWQgMjUwIG1zLiAqL1xuICB0aWNrTXM/OiBudW1iZXI7XG4gIC8qKiBTbmFwc2hvdCBpbnRlcnZhbDsgYm90aCBhZG9wdGluZyBkYWVtb25zIHVzZWQgMTAwMCBtcy4gKi9cbiAgc25hcHNob3RNcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBTdGFydCB0aGUgdHdvIHN0YW5kaW5nIHRpbWVycyBldmVyeSBzZXNzaW9uIGRhZW1vbiBydW5zIOKAlCB0aGUgaWRsZSBzd2VlcCBhbmRcbiAqIHRoZSBkZWJvdW5jZWQgc25hcHNob3Qg4oCUIGFuZCByZXR1cm4gdGhlIGZ1bmN0aW9uIHRoYXQgc3RvcHMgYm90aC5cbiAqXG4gKiBUaGV5IGFyZSBPTkUgY2FsbCBiZWNhdXNlIHRoZXkgaGF2ZSBhbHdheXMgYmVlbiBvbmUgbGlmZXRpbWU6IGV2ZXJ5IGNvcHlcbiAqIGNsZWFyZWQgYm90aCBpbiB0aGUgc2FtZSB0d28gbGluZXMgYWZ0ZXIgYGF3YWl0IGRvbmVgLCBhbmQgdGhlIHBhaXIgdGhhdCBnZXRzXG4gKiBmb3Jnb3R0ZW4gaXMgdGhlIHBhaXIgd2hvc2UgdGltZXJzIGtlZXAgYSBwcm9jZXNzIGFsaXZlIGFmdGVyIHRlYXJkb3duLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRIb3VzZWtlZXBpbmcob3B0czogSG91c2VrZWVwaW5nT3B0aW9ucyk6ICgpID0+IHZvaWQge1xuICBjb25zdCB0aWNrTXMgPSBvcHRzLnRpY2tNcyA/PyAyNTA7XG4gIGNvbnN0IHNuYXBzaG90TXMgPSBvcHRzLnNuYXBzaG90TXMgPz8gMTAwMDtcblxuICBjb25zdCBpZGxlVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgY29uc3Qgc3Vic2NyaWJlcnMgPSBvcHRzLnN1YnNjcmliZXJDb3VudCgpO1xuICAgIGlmIChzdWJzY3JpYmVycyA+IDApIG9wdHMudG91Y2goKTtcbiAgICBpZiAoc2hvdWxkSWRsZUNsb3NlKHN1YnNjcmliZXJzLCBvcHRzLmlkbGVNcygpLCBvcHRzLnRpbWVvdXRNcykpIG9wdHMub25JZGxlQ2xvc2UoKTtcbiAgfSwgdGlja01zKTtcblxuICBjb25zdCBzbmFwID0gb3B0cy5zbmFwc2hvdDtcbiAgY29uc3Qgc25hcFRpbWVyID0gc25hcFxuICAgID8gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgICBpZiAoIXNuYXAuZGlydHkoKSkgcmV0dXJuO1xuICAgICAgICBzbmFwLmNsZWFyKCk7XG4gICAgICAgIHZvaWQgc25hcC53cml0ZSgpO1xuICAgICAgfSwgc25hcHNob3RNcylcbiAgICA6IG51bGw7XG5cbiAgcmV0dXJuICgpID0+IHtcbiAgICBjbGVhckludGVydmFsKGlkbGVUaW1lcik7XG4gICAgaWYgKHNuYXBUaW1lciAhPT0gbnVsbCkgY2xlYXJJbnRlcnZhbChzbmFwVGltZXIpO1xuICB9O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIERyYWluT3B0aW9ucyB7XG4gIC8qKiBUaGUgYm91bmQgc2VydmVyLiBUeXBlZCBzdHJ1Y3R1cmFsbHkgc28gdGhlIGtpdCBzdGF5cyBmcmVlIG9mIGBidW5gLiAqL1xuICBzZXJ2ZXI6IHsgc3RvcChjbG9zZUFjdGl2ZUNvbm5lY3Rpb25zPzogYm9vbGVhbik6IHVua25vd24gfTtcbiAgLyoqIExpdmUgU1NFIHRhaWxzOyBldmVyeSByZWdpc3RlcmVkIGNsb3NlciBpcyBpbnZva2VkLiAqL1xuICBjbGllbnRzPzogU3NlQ2xpZW50cztcbiAgLyoqIExpdmUgV2ViU29ja2V0cy4gKi9cbiAgc29ja2V0cz86IEl0ZXJhYmxlPHsgY2xvc2UoKTogdm9pZCB9PjtcbiAgLyoqIEhvdyBsb25nIHF1ZXVlZCBmcmFtZXMgZ2V0IHRvIGZsdXNoIGJlZm9yZSBhbnl0aGluZyBpcyBjbG9zZWQuICovXG4gIGdyYWNlTXM/OiBudW1iZXI7XG4gIC8qKiBIb3cgbG9uZyB0aGUgZ3JhY2VmdWwgc3RvcCBnZXRzIGJlZm9yZSB0ZWFyZG93biBwcm9jZWVkcyByZWdhcmRsZXNzLiAqL1xuICBzdG9wTXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogQ2xvc2UgZXZlcnkgaGVsZCBjb25uZWN0aW9uIGFuZCBzdG9wIHRoZSBzZXJ2ZXIsIGluIGJvdW5kZWQgdGltZS5cbiAqXG4gKiDim5QgKipUSEUgR1JBQ0UgUEVSSU9EIElTIE5PVCBQT0xJVEVORVNTLioqIEEgYGNsb3NlZGAgZnJhbWUgZW1pdHRlZCBhbmQgdGhlblxuICogZm9sbG93ZWQgaW1tZWRpYXRlbHkgYnkgYW4gYWdncmVzc2l2ZSBgc2VydmVyLnN0b3AodHJ1ZSlgIGlzIGEgZnJhbWUgdGhlXG4gKiBjbGllbnQgbmV2ZXIgc2VlcyDigJQgdGhlIHF1ZXVlIGdvZXMgd2l0aCB0aGUgc29ja2V0LiBUaGUgMTUwIG1zIGlzIHdoYXQgdHVybnNcbiAqIFwidGhlIGRhZW1vbiB0b2xkIHlvdSB3aHkgaXQgZGllZFwiIGZyb20gYSBob3BlIGludG8gYW4gb2JzZXJ2YXRpb24sIGFuZCBldmVyeVxuICogb25lIG9mIHRoZSBlaWdodCBkYWVtb25zIGNvbnZlcmdlZCBvbiB0aGF0IG51bWJlciBpbmRlcGVuZGVudGx5LlxuICpcbiAqIOKblCAqKkFORCBUSEUgU1RPUCBJUyBSQUNFRCwgQkVDQVVTRSBBIFNMT1cgU09DS0VUIE1VU1QgTk9UIEJFIEFCTEUgVE8gSEFOR1xuICogVEVBUkRPV04uKiogYHNlcnZlci5zdG9wKHRydWUpYCBhd2FpdHMgaXRzIGNvbm5lY3Rpb25zOyBvbmUgd2VkZ2VkIHBlZXIgaXNcbiAqIGVub3VnaCB0byBwYXJrIGl0IGZvcmV2ZXIsIHdoaWNoIGlzIGhvdyBhIDIzLW1pbnV0ZSBoYW5nIHNoaXBwZWQgb25jZS5cbiAqXG4gKiDimqAgKipXSEFUIElTIERFTElCRVJBVEVMWSBOT1QgSEVSRTogYm91bnR5J3Mgc2h1dGRvd24gd2F0Y2hkb2cuKiogQm91bnR5IGFybXNcbiAqIGEgUkVGJ2QgYHNldFRpbWVvdXRgIHRoYXQgY2FsbHMgYHByb2Nlc3MuZXhpdGAgaWYgdGVhcmRvd24gZG9lcyBub3QgZmluaXNoLFxuICogYW5kIHRoZSBjZW5zdXMgaXMgcmlnaHQgdGhhdCBpdCBpcyB0aGUgY29ycHVzJ3Mgb25seSB1bmNvbmRpdGlvbmFsXG4gKiB0ZXJtaW5hdGlvbiBndWFyYW50ZWUuIEl0IGJlbG9uZ3MgdG8gYm91bnR5J3MgVEVBUkRPV04g4oCUIHRoZSBzdHJldGNoIHdoZXJlXG4gKiBub3RoaW5nIGJvdW5kcyB3aGF0IGlzIGJlaW5nIHdhaXRlZCBvbi4g4puUICoqVEhJUyBQQVJBR1JBUEggU0FJRCBcIlNJR05BTFxuICogUEFUSFwiIFVOVElMIEQ1MywgQU5EIFRIRSBDT0RFIEFHUkVFRCBXSVRIIElULCBXSElDSCBXQVMgVEhFIERFRkVDVC4qKiBCb3VudHlcbiAqIGhhcyBGT1VSIHdheXMgaW50byBvbmUgdGVhcmRvd24gKGEgc2lnbmFsLCBhIGBjbG9zZWAgdmVyYiwgdGhlIGJyb3dzZXInc1xuICogY2xvc2Ugb3ZlciB0aGUgV2ViU29ja2V0LCBhbiBpZGxlIHRpbWVvdXQpIGFuZCBvbmx5IHRoZSBzaWduYWwgb25lIGFybWVkIHRoZVxuICogdGltZXIsIHdoaWxlIHRoZSBjb21tZW50IGFib3ZlIGl0IGNsYWltZWQgdGhlIGVuZGluZyB3YXMgdW5jb25kaXRpb25hbC5cbiAqIERyaXZlbiB3aXRoIGEgcGxhbnRlZCBoYW5nOiB0aGUgb3RoZXIgdGhyZWUgcmFuIHBhc3QgMTAgcywgdGhlIGlkbGUgb25lXG4gKiBpbmNsdWRlZCDigJQgdGhlIG9ycGhhbi1kYWVtb24gY2xhc3MgdGhlIDIzLW1pbnV0ZSBoYW5nIGNhbWUgZnJvbS4gVGhlIGFybWluZ1xuICogbm93IGxpdmVzIGluIHRoZSBSRVNPTFZFIHRoYXQgYWxsIGZvdXIgZW50cmllcyBwYXNzIHRocm91Z2guICoqVGhlIGxlc3NvbiBmb3JcbiAqIGFuIGFkb3B0ZXIgaXMgdGhlIGNvdW50LCBub3QgdGhlIHBsYWNlbWVudDogZW51bWVyYXRlIGV2ZXJ5IGVudHJ5IGludG8gdGhlXG4gKiB0ZWFyZG93biBiZWZvcmUgeW91IGJlbGlldmUgYSBndWFyYW50ZWUgY292ZXJzIGl0LioqIFRoZSB0d29cbiAqIGRhZW1vbnMgYWRvcHRpbmcgdGhpcyBtb2R1bGUgcmVnaXN0ZXIgbm8gc2lnbmFsIGhhbmRsZXJzLCBhbmQgdGhlaXIgd2hvbGVcbiAqIHRlYXJkb3duIGlzIGJvdW5kZWQgYnkgdGhlIHR3byBudW1iZXJzIGFib3ZlOyBhZGRpbmcgYW4gZXhpdCBoZXJlIHdvdWxkIHB1dFxuICogdGhlIGhvdXNlJ3Mgb25seSB1bmNvbmRpdGlvbmFsIGBwcm9jZXNzLmV4aXRgIGluc2lkZSBhIG1vZHVsZSBldmVyeSBzcGVsbCBpc1xuICogYWJvdXQgdG8gYnVuZGxlLCBvbmUgcGhhc2UgYWZ0ZXIgRDggdG9vayBleGFjdGx5IHRoYXQgaGF6YXJkIE9VVCBvZiBgZGllYC5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFTlRFTkNFIFRIQVQgVVNFRCBUTyBFTkQgVEhBVCBQQVJBR1JBUEggV0FTIEEgUFJFRElDVElPTiwgV0hJQ0hcbiAqIEJPVU5UWSdTIE9XTiBQT1JUIEZBTFNJRklFRC4qKiBJdCByZWFkOiBcIndoZW4gYSBzcGVsbCB3aXRoIGEgc2lnbmFsIHBhdGhcbiAqIGFkb3B0cyB0aGlzLCB0aGUgd2F0Y2hkb2cgYXJyaXZlcyBhcyBhbiBvcHRpb24gb24gdGhlc2UgYXJndW1lbnRzIGFuZCB0aGVcbiAqIHJlYXNvbmluZyBpcyBhbHJlYWR5IHdyaXR0ZW4gZG93bi5cIiBib3VudHkgYWRvcHRlZCBgZHJhaW5BbmRTdG9wYCBvblxuICogMjAyNi0wOS0wOSAoUGhhc2UgNCkgYW5kIHRoZSBvcHRpb24gd2FzIE5PVCBhZGRlZCwgYmVjYXVzZSB0aGUgd2luZG93IGlzXG4gKiB3cm9uZy4gKipBIGB3YXRjaGRvZ01zYCBvbiB0aGVzZSBhcmd1bWVudHMgd291bGQgYXJtIGF0IERSQUlOIHRpbWU7IGJvdW50eSdzXG4gKiBhcm1zIGF0IFNJR05BTCB0aW1lKiosIGFuZCB0aGUgd2hvbGUgcmVhc29uIGl0IGV4aXN0cyBpcyB0aGUgc3RyZXRjaCBCRVRXRUVOXG4gKiB0aG9zZSB0d28gcG9pbnRzIOKAlCBgYXdhaXQgZG9uZWAsIGFuIGZzIGFwcGVuZCB0byB0aGUgZGFlbW9uIGxvZywgYSBmdWxsXG4gKiBzbmFwc2hvdCB3cml0ZSB0aGF0IGNhbiByb3RhdGUgYW5kIENPUFkgYSBiYWNrdXAgb2YgYSBsYXJnZSBib2FyZCwgYSBgY2xvc2VkYFxuICogZnJhbWUgYW5kIGEgYnJvYWRjYXN0LiBgZHJhaW5BbmRTdG9wYCdzIG93biBib2R5IGlzIGFscmVhZHkgYm91bmRlZCBieSB0aGUgdHdvXG4gKiBudW1iZXJzIGFib3ZlLCBzbyBhIHdhdGNoZG9nIHNjb3BlZCB0byBpdCB3b3VsZCBndWFyZCB0aGUgb25lIHN0cmV0Y2ggdGhhdFxuICogY2Fubm90IGhhbmcgYW5kIGFiYW5kb24gdGhlIHN0cmV0Y2ggdGhhdCBjYW46IGl0IHdvdWxkIFJFQUQgYXMgYWRvcHRpb24gYW5kXG4gKiBCRSBhIG5hcnJvd2luZyBvZiB0aGUgY29ycHVzJ3Mgb25seSB1bmNvbmRpdGlvbmFsIHRlcm1pbmF0aW9uIGd1YXJhbnRlZS4gVGhlXG4gKiAyMy1taW51dGUgaGFuZyB0aGlzIHByb2plY3Qga2VlcHMgY2l0aW5nIGhhcHBlbmVkIGluIHRoZSB1bmJvdW5kZWQgc3RyZXRjaC5cbiAqXG4gKiDimqAgKipTTyBUSEUgUlVMRSBGT1IgVEhFIE5FWFQgU1BFTEwsIFdISUNIIElTIFRIRSBUUkFOU0ZFUkFCTEUgSEFMRjoqKiB0aGVcbiAqIHF1ZXN0aW9uIGlzIG5ldmVyIFwiZG9lcyB0aGlzIG1vZHVsZSBoYXZlIGEgcGxhY2UgdG8gcHV0IGEgd2F0Y2hkb2dcIiBidXRcbiAqIFwiZG9lcyB0aGUgd2F0Y2hkb2cncyB3aW5kb3cgY29pbmNpZGUgd2l0aCB0aGlzIG1vZHVsZSdzXCIuIFdoZXJlIGEgc3BlbGwnc1xuICogdGVhcmRvd24gaGFzIHVuYm91bmRlZCB3b3JrIEJFRk9SRSB0aGUgZHJhaW4sIHRoZSB3YXRjaGRvZyBiZWxvbmdzIGF0IHRoZVxuICogc3BlbGwsIHdyYXBwZWQgYXJvdW5kIGFsbCBvZiBpdCDigJQgYW5kIGFyb3VuZCBFVkVSWSBXQVkgSU4sIHdoaWNoIGlzIHRoZSBoYWxmXG4gKiBENTMgaGFkIHRvIHJlcGFpciBhZnRlciB0aGlzIGhlYWRlciB3YXMgd3JpdHRlbi4gSWYgYSBzcGVsbCBldmVyIGFwcGVhcnMgd2hvc2Ugc2lnbmFsIHBhdGhcbiAqIGVudGVycyBgZHJhaW5BbmRTdG9wYCBpbW1lZGlhdGVseSwgYWRkIHRoZSBvcHRpb24gVEhFTiDigJQgYW5kIHRoZSBvcHRpb24gbXVzdFxuICogdGFrZSBhbiBgb25FeHBpcmVgIGNhbGxiYWNrIHJhdGhlciB0aGFuIGV4aXRpbmcsIHNvIHRoZSBgcHJvY2Vzcy5leGl0YCBzdGF5c1xuICogb3V0c2lkZSBhIG1vZHVsZSBldmVyeSBzcGVsbCBidW5kbGVzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZHJhaW5BbmRTdG9wKG9wdHM6IERyYWluT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBncmFjZU1zID0gb3B0cy5ncmFjZU1zID8/IDE1MDtcbiAgY29uc3Qgc3RvcE1zID0gb3B0cy5zdG9wTXMgPz8gMjAwO1xuXG4gIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIGdyYWNlTXMpKTtcblxuICBpZiAob3B0cy5jbGllbnRzKSB7XG4gICAgZm9yIChjb25zdCBjbGllbnQgb2YgWy4uLm9wdHMuY2xpZW50c10pIGNsaWVudC5jbG9zZSgpO1xuICB9XG4gIGlmIChvcHRzLnNvY2tldHMpIHtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIFsuLi5vcHRzLnNvY2tldHNdKSB7XG4gICAgICB0cnkge1xuICAgICAgICB3cy5jbG9zZSgpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIGFscmVhZHkgZ29uZSAqL1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgUHJvbWlzZS5yZXNvbHZlKG9wdHMuc2VydmVyLnN0b3AodHJ1ZSkpLFxuICAgIG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIHN0b3BNcykpLFxuICBdKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgYXNzZXQtc2VydmluZyB0cmlvIGZvciBhIHNwZWxsIGRhZW1vbjogd2hpY2ggc3VyZmFjZSBtb2RlIHdlXG4gKiBhcmUgaW4sIHdoYXQgY29udGVudCB0eXBlIGEgZmlsZSBnZXRzLCBhbmQgaG93IGEgZmlsZSB1bmRlciBgZGlzdC9gIGlzXG4gKiBhbnN3ZXJlZC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIEV4dHJhY3RlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIGZyb20gdGhlIGVpZ2h0IGBCdW4uc2VydmVgIGJhY2tlbmRzXG4gKiBjZW5zdXNlZCBpbiBgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LWRhZW1vbi1zcGluZS1jZW5zdXMubWRgLCB3aGljaFxuICogbWVhc3VyZWQgYHJlc29sdmVNb2RlYCBhcyBieXRlLWlkZW50aWNhbCBpbiBhbGwgZWlnaHQgKHRoZSBvbmx5IG1kNSBkaWZmZXJlbmNlXG4gKiBiZWluZyB0aGUgYGV4cG9ydGAga2V5d29yZCksIHRoZSBjb250ZW50LXR5cGUgbWFwIGFzIGRpZmZlcmluZyBpbiBleGFjdGx5XG4gKiBvbmUgY2VsbCwgYW5kIHRoZSBmaWxlIGhhbGYgb2YgYHNlcnZlRGlzdGAgYXMgaWRlbnRpY2FsIGluIGZpdmUuXG4gKlxuICog4pSA4pSAIFdIQVQgREVMSUJFUkFURUxZIERJRCBOT1QgQ09NRSBBTE9ORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKlRoZSBVUkwtdG8tZmlsZW5hbWUgbWFwcGluZyBzdGF5cyBpbiBlYWNoIHJvdXRlci4qKiBUaGUgY2Vuc3VzIG1hcmtlZCB0d29cbiAqIG9mIHRoZSBlaWdodCBgc2VydmVEaXN0YCBkaXZlcmdlbmNlcyBERUxJQkVSQVRFIGFuZCBib3RoIGxpdmUgaW4gdGhhdCBoYWxmOlxuICogZGlnZXN0aWZ5IHN1YnN0aXR1dGVzIGludG8gdGhlIGVudHJ5IEhUTUwgaW4gbWVtb3J5LCBhbmQgZ3JhcGV2aW5lIHNlcnZlcyBpdHNcbiAqIHN1cmZhY2UgYXQgYC93YXRjaGAgcmF0aGVyIHRoYW4gYXQgYC9gLiBBIHNpZ25hdHVyZSB3aWRlIGVub3VnaCB0byBhYnNvcmJcbiAqIHRob3NlIHN0b3BzIGJlaW5nIGEgZmlsZSBzZXJ2ZXIgYW5kIGJlY29tZXMgYSByb3V0ZXIuIFNvIHRoZSBjYWxsZXIgZGVjaWRlc1xuICogV0hJQ0ggZmlsZSAoYHBhdGggPT09IFwiL1wiID8gXCJpbmRleC5odG1sXCIgOiBwYXRoLnNsaWNlKDEpYCksIGFuZCB0aGlzIG1vZHVsZVxuICogZGVjaWRlcyB3aGV0aGVyIHRoYXQgZmlsZSBtYXkgYmUgcmVhZCBhbmQgd2hhdCBpdCBpcyBzZXJ2ZWQgYXMuXG4gKlxuICog4pSA4pSAIEFORCBcIldIRVRIRVIgSVQgTUFZIEJFIFJFQURcIiBJUyBOT1cgQSBXSElURUxJU1Qg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRXh0cmFjdGVkIHdpdGggdGhyZWUgZ3VhcmRzIChlbXB0eSAvIGAuLmAgLyBuZXN0ZWQpIGFuZCBgZXhpc3RzU3luY2AgZm9yIHRoZVxuICogcmVzdCwgd2hpY2ggd2FzIHRydWUgb2YgYSBgZGlzdC9gIHRoYXQgaGVsZCBvbmx5IGEgc3VyZmFjZS4gUGhhc2UgMWIgcHV0IGV2ZXJ5XG4gKiBkYWVtb24ncyBCVU5ETEUgaW4gdGhhdCBzYW1lIGRpcmVjdG9yeSwgYW5kIGFsbCBmaXZlIGFkb3B0ZXJzIHNlcnZlZCBpdDpcbiAqIGAvY2xpLmpzYCwgYC9zZXJ2ZXIuanNgLCBgL2pvaW4uanNgIGF0IDIwMCwgYnl0ZS1pZGVudGljYWwgdG8gdGhlIGNvbW1pdHRlZFxuICogYXJ0aWZhY3RzLCBlbWJlZGRlZCBzb3VyY2VtYXBzIGFuZCBhbGwuIGBzZXJ2ZUZyb21EaXN0YCBub3cgc2VydmVzIG9ubHkgd2hhdCB0aGVcbiAqIGJ1aWx0IGBpbmRleC5odG1sYCB0cmFuc2l0aXZlbHkgbGlua3Mg4oCUIHNlZSBgc3VyZmFjZVdoaXRlbGlzdGAgYmVsb3csIHdoaWNoIGlzXG4gKiB0aGUgc2hhcGUgZGlnZXN0aWZ5IHByb3ZlZCBsb2NhbGx5IGluIGBkOGNiYWZmYCBhbmQgdGhpcyBpcyBpdHMgb25lIGVkaXQgZm9yXG4gKiBmaXZlIHNwZWxscy5cbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuLyoqXG4gKiBSZWxlYXNlIGlmZiBgPGRpc3REaXI+L2luZGV4Lmh0bWxgIGV4aXN0czsgZWxzZSBkZXYuIFRoZSBlbnYgb3ZlcnJpZGVcbiAqIChgU1BFTExCT09LX1NVUkZBQ0VfTU9ERWApIHdpbnMgZWl0aGVyIHdheSDigJQgc2VhbXMgQ29udHJhY3QgMS5cbiAqXG4gKiDim5QgKipUSEUgRklMRSwgTkVWRVIgVEhFIERJUkVDVE9SWSwgQU5EIFRIQVQgSVMgQSBTQ0FSIE5PVCBBIFNUWUxFIENIT0lDRS4qKlxuICogUmUtaG9tZWQgZnJvbSBib3VudHkgYW5kIG1hZ3BpZSwgd2hpY2ggZWFybmVkIGl0IGluZGVwZW5kZW50bHk6XG4gKlxuICogLSBtYWdwaWUncyBgZGlzdC9gIEFMUkVBRFkgRVhJU1RFRCBob2xkaW5nIGBjbGkuanNgIGFuZCBubyBgaW5kZXguaHRtbGAsXG4gKiAgIHdoaWNoIGlzIHByZWNpc2VseSB3aHkgaXRzIGRhZW1vbiBzdGF5ZWQgY29ycmVjdGx5IGluIERFViBtb2RlIHRocm91Z2ggdGhlXG4gKiAgIHdob2xlIG9mIFNsaWNlIDIuIGBkaXN0L2AgZXhpc3RpbmcgaXMgbm90IHRoZSBkaXNjcmltaW5hdG9yLlxuICogLSBib3VudHkgc2F5cyB0aGUgc2FtZSB0aGluZyBmcm9tIHRoZSBvdGhlciBzaWRlOiBhIGJ1aWx0IEJBQ0tFTkQgcHV0c1xuICogICBgY2xpLmpzYCAoYW5kIG5vdyBgc2VydmVyLmpzYCkgaW4gYGRpc3QvYCB3aXRoIG5vIHN1cmZhY2UgYW55d2hlcmUgbmVhciBpdC5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBSRURJQ0FURSBJUyBBTiBVTkhBU0hFRCBGSUxFTkFNRSwgV0hJQ0ggSVMgQSBTVEFORElOR1xuICogQVNTVU1QVElPTiBBQk9VVCBUSEUgU1VSRkFDRSBCVUlMRC4qKiBSZWxlYXNlIG1vZGUgaXMgY2hvc2VuIGJ5IE9ORSBsaXRlcmFsXG4gKiBuYW1lLiBBIHN1cmZhY2UgYnVpbGQgdGhhdCBldmVyIGVtaXR0ZWQgYSBjb250ZW50LWhhc2hlZCBlbnRyeSBkb2N1bWVudCB3b3VsZFxuICogbGVhdmUgbm8gYGluZGV4Lmh0bWxgIGhlcmUsIGV2ZXJ5IGRhZW1vbiB3b3VsZCBzaWxlbnRseSByZXNvbHZlIERFViwgYW5kIHRoZVxuICogb25seSBzeW1wdG9tIGFueW9uZSBjYW4gc2VlIGlzIHRoZSBgbW9kZWAgZmllbGQgb24gYSBoYW5kc2hha2Ugbm9ib2R5IHJlYWRzIGluXG4gKiBhbmdlci4gYHNyYy9idWlsZC50c2AgZW1pdHMgdGhlIGVudHJ5IHVuaGFzaGVkIHRvZGF5IChvbmx5IHRoZSBKUyBhbmQgQ1NTXG4gKiBjaHVua3MgY2FycnkgaGFzaGVzKSBhbmQgQ29udHJhY3QgMiBwaW5zIHRoYXQgZmxhdCBsYXlvdXQ7IHRoaXMgY29tbWVudCBpc1xuICogdGhlIG5vdGUgdGhhdCBzYXlzIHdoYXQgdGhlIHBpbiBpcyBsb2FkLWJlYXJpbmcgRk9SLlxuICpcbiAqIOKaoCBOb3RoaW5nIGFubm91bmNlcyB0aGUgZmxpcCBmcm9tIGRldiB0byByZWxlYXNlIGVpdGhlcjogdGhlIGZpcnN0IHN1cmZhY2VcbiAqIGJ1aWxkIHRvIGxhbmQgYW4gYGluZGV4Lmh0bWxgIGJlc2lkZSBhIGRhZW1vbiBmbGlwcyBpdCwgc2lsZW50bHksIG9uIHRoZSBuZXh0XG4gKiBib290LiBUaGF0IGlzIHdoeSBgbW9kZWAgcmlkZXMgdGhlIHJlYWR5IGZyYW1lIOKAlCB3aXRoIHJvb3QgZGVwcyBwcmVzZW50IGEgZGV2XG4gKiBkYWVtb24gcmVuZGVycyBhbiBpZGVudGljYWwtbG9va2luZyBzdXJmYWNlLCBzbyBcIml0IGxvb2tzIHJpZ2h0XCIgY2Fubm90XG4gKiB2ZXJpZnkgQ29udHJhY3QgMS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKGRpc3REaXI6IHN0cmluZyk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIGNvbnN0IG92ZXJyaWRlID0gcHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERTtcbiAgaWYgKG92ZXJyaWRlID09PSBcImRldlwiIHx8IG92ZXJyaWRlID09PSBcInJlbGVhc2VcIikgcmV0dXJuIG92ZXJyaWRlO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKGRpc3REaXIsIFwiaW5kZXguaHRtbFwiKSkgPyBcInJlbGVhc2VcIiA6IFwiZGV2XCI7XG59XG5cbi8qKlxuICogVGhlIGNvbnRlbnQgdHlwZXMgYSBidWlsdCBzdXJmYWNlIGFjdHVhbGx5IHNoaXBzLiBFeHRlbnNpb25zIG91dHNpZGUgdGhlXG4gKiBtYXAgZ2V0IGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gIOKAlCBhIGRlbGliZXJhdGUgcmVmdXNhbCB0byBndWVzcywgc2luY2VcbiAqIGFueXRoaW5nIG5vdCBpbiB0aGlzIGxpc3QgaXMgbm90IHNvbWV0aGluZyBDb250cmFjdCAyJ3MgYnVpbGQgZW1pdHMuXG4gKlxuICog4pqgICoqYGNoYXJzZXQ9dXRmLThgIE9OIEhUTUwgSVMgVEhFIENFTlNVUydTIE9ORSBESVZFUkdFTkNFLCBSRVNPTFZFRCBUT1dBUkRcbiAqIFRIRSBDT1JSRUNUIENPUFkuKiogVGhyZWUgb2YgdGhlIGVpZ2h0IGRhZW1vbnMgY2FycmllZCBpdCBhbmQgZml2ZSBkaWQgbm90O1xuICogdGhlIGNlbnN1cyBncmFkZWQgdGhhdCBgc3RhbGVgIHdpdGggemVybyBkZXNpZ24gY29udGVudC4gSXQgaXMga2VwdCBiZWNhdXNlXG4gKiBpdCBpcyB0aGUgcmlnaHQgYW5zd2VyIOKAlCBhbiBIVE1MIGRvY3VtZW50IHNlcnZlZCB3aXRoIG5vIGNoYXJzZXQgaXMgZGVjb2RlZFxuICogYnkgdGhlIGJyb3dzZXIncyBndWVzcyDigJQgYW5kIGl0IGlzIHRoZSBvbmUgd2lyZS1vYnNlcnZhYmxlIGNoYW5nZSB0aGlzXG4gKiBjb252ZXJnZW5jZSBtYWtlcyB0byBhIHJlc3BvbnNlIGhlYWRlci4gUmVjb3JkZWQgYXMgRC1ub3RlIGluIHRoZSBwaGFzZSBsb2dcbiAqIHJhdGhlciB0aGFuIHNtdWdnbGVkLlxuICovXG5jb25zdCBTVEFUSUNfQ09OVEVOVF9UWVBFUzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIuaHRtbFwiOiBcInRleHQvaHRtbDsgY2hhcnNldD11dGYtOFwiLFxuICBcIi5qc1wiOiBcInRleHQvamF2YXNjcmlwdFwiLFxuICBcIi5jc3NcIjogXCJ0ZXh0L2Nzc1wiLFxuICBcIi5qc29uXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICBcIi5zdmdcIjogXCJpbWFnZS9zdmcreG1sXCIsXG4gIFwiLnBuZ1wiOiBcImltYWdlL3BuZ1wiLFxufTtcblxuLyoqIFRoZSBjb250ZW50IHR5cGUgZm9yIGEgZmlsZW5hbWUgb3IgYW4gZXh0ZW5zaW9uLiBVbmtub3duIGV4dGVuc2lvbnMsIGFuZFxuICogIG5hbWVzIHdpdGggbm8gZXh0ZW5zaW9uIGF0IGFsbCwgZ2V0IGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbnRlbnRUeXBlRm9yKG5hbWVPckV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZG90ID0gbmFtZU9yRXh0Lmxhc3RJbmRleE9mKFwiLlwiKTtcbiAgY29uc3QgZXh0ID0gZG90ID09PSAtMSA/IFwiXCIgOiBuYW1lT3JFeHQuc2xpY2UoZG90KTtcbiAgcmV0dXJuIFNUQVRJQ19DT05URU5UX1RZUEVTW2V4dF0gPz8gXCJhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1cIjtcbn1cblxuLyoqXG4gKiBBbnN3ZXIgT05FIGZpbGUgZnJvbSBgZGlzdERpcmAsIG9yIGBudWxsYCBpZiB0aGUgY2FsbGVyIHNob3VsZCBrZWVwIHJvdXRpbmcuXG4gKlxuICogYHJlbGAgaXMgYSBiYXJlIGZpbGVuYW1lIOKAlCB0aGUgZW50cnkgZG9jdW1lbnQgb3Igb25lIGhhc2hlZCBjaHVuay4gQ29udHJhY3RcbiAqIDIncyBidWlsdCBzdXJmYWNlIGlzIEZMQVQgYW5kIGxpbmtzIGl0cyBjaHVua3MgcmVsYXRpdmVseSwgc28gYSBsZWdpdGltYXRlXG4gKiBhc3NldCByZXF1ZXN0IGlzIG5ldmVyIG5lc3RlZCBhbmQgbmV2ZXIgY29udGFpbnMgYC4uYDsgYm90aCBhcmUgcmVmdXNlZFxuICogaGVyZSByYXRoZXIgdGhhbiBpbiB0aGUgcm91dGVyLCBiZWNhdXNlIHRoZSBndWFyZCBwcm90ZWN0cyB0aGUgcmVhZCBhbmQgdGhlXG4gKiByZWFkIGlzIHdoYXQgbGl2ZXMgaW4gdGhpcyBmaWxlLlxuICpcbiAqIOKblCBBTkQgYGV4aXN0c1N5bmNgIElTIE5PIExPTkdFUiBUSEUgUEVSTUlTU0lPTi4gQSBmaWxlIHVuZGVyIGBkaXN0RGlyYCBpc1xuICogc2VydmVkIG9ubHkgaWYgaXQgaXMgaW4gYHN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcilgIOKAlCB3aGF0IHRoZSBidWlsdFxuICogYGluZGV4Lmh0bWxgIHRyYW5zaXRpdmVseSBMSU5LUy4gYGRpc3QvYCBzdG9wcGVkIGJlaW5nIGEgc3VyZmFjZSBkaXJlY3RvcnlcbiAqIHdoZW4gdGhlIGJhY2tlbmQgY29udmVyZ2VuY2UgYnVpbHQgdGhlIGRhZW1vbnMgaW50byBpdCwgYW5kIHRoZSBndWFyZHMgYWJvdmVcbiAqIGRvIG5vdCBkaXN0aW5ndWlzaCBgaW5kZXgtPGhhc2g+LmpzYCBmcm9tIGBzZXJ2ZXIuanNgLiBSZWFkIHRoYXQgZnVuY3Rpb24nc1xuICogaGVhZGVyIGJlZm9yZSB0b3VjaGluZyB0aGlzIGxpbmU7IHRoZSB3aGl0ZWxpc3QgaXMgdGhlIGRlZmVuY2UuXG4gKlxuICog4pqgIFRoZSBuZXN0aW5nIHJlZnVzYWwgaXMgYWxzbyB3aGF0IGtlZXBzIGFuIGFzc2V0IHNlcnZlIGNsZWFyIG9mIGEgc3BlbGwnc1xuICogb3duIHJvdXRlczogbWFncGllLCBib3VudHksIGdsYW1vdXIgYW5kIGltYWdvIGVhY2ggaGF2ZSBhbiBgL2Fzc2V0cy88bmFtZT5gXG4gKiByb3V0ZSBvbmUgbGV2ZWwgZGVlcCwgYW5kIHRoaXMgcmV0dXJuaW5nIGBudWxsYCBvbiBhbnl0aGluZyB3aXRoIGEgc2xhc2ggaW5cbiAqIGl0IGlzIHdoYXQgc3RvcHMgdGhlIHR3byBmaWdodGluZy4gVGhlIHdoaXRlbGlzdCBnb3Zlcm5zIGBkaXN0L2AgcmVhZHMgT05MWVxuICog4oCUIGl0IG5ldmVyIHNlZXMgdGhvc2Ugcm91dGVzIGFuZCBtdXN0IG5ldmVyIGJlIHdpZGVuZWQgaW50byB0aGVtLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2VydmVGcm9tRGlzdChkaXN0RGlyOiBzdHJpbmcsIHJlbDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgaWYgKCFyZWwgfHwgcmVsLmluY2x1ZGVzKFwiLi5cIikgfHwgcmVsLmluY2x1ZGVzKFwiL1wiKSkgcmV0dXJuIG51bGw7XG4gIGlmICghc3VyZmFjZVdoaXRlbGlzdChkaXN0RGlyKS5oYXMocmVsKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGZpbGUgPSBqb2luKGRpc3REaXIsIHJlbCk7XG4gIGlmICghZXhpc3RzU3luYyhmaWxlKSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBuZXcgUmVzcG9uc2UoQnVuLmZpbGUoZmlsZSksIHsgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBjb250ZW50VHlwZUZvcihyZWwpIH0gfSk7XG59XG5cbi8qKiBgc3JjYC9gaHJlZmAgdmFsdWVzIGluIGEgYnVpbHQgZW50cnkgZG9jdW1lbnQsIGAuL2AtcHJlZml4ZWQgb3IgYmFyZS4gKi9cbmNvbnN0IEVOVFJZX1JFRl9SRSA9IC8oPzpzcmN8aHJlZilcXHMqPVxccypcIig/OlxcLlxcLyk/KFteXCJdKylcIi9nO1xuXG4vKiogQSBgLi9gLVBSRUZJWEVEIHNpYmxpbmcgc3BlY2lmaWVyIOKAlCBgXCIuL25hbWVcImAsIGAnLi9uYW1lJ2AsIGAoLi9uYW1lKWAg4oCUIHdoaWNoXG4gKiAgaXMgdGhlIG9ubHkgc2hhcGUgYSBidW5kbGVyIGVtaXRzIGZvciBhIHNpYmxpbmcgY2h1bmsuIFJlcXVpcmluZyB0aGUgYC4vYCBpc1xuICogIHdoYXQga2VlcHMgYSBzdHJpbmcgbGl0ZXJhbCB0aGF0IG1lcmVseSBTQVlTIGBjbGkuanNgIG91dCBvZiB0aGUgc2V0LiAqL1xuY29uc3QgUkVMQVRJVkVfUkVGX1JFID0gL1tcIicoXVxcLlxcLyhbXlwiJygpXFxzXSspW1wiJyldL2c7XG5cbi8qKiBPbmx5IHRleHQgdGhlIGJ1aWxkIGVtaXRzIGFzIHN1cmZhY2UgY29kZSBpcyBzY2FubmVkIGZvciBvbndhcmQgcmVmZXJlbmNlcy5cbiAqICBBIGAucG5nYCBpcyBhIGxlYWY7IG9wZW5pbmcgaXQgd291bGQgYmUgcmVhZGluZyBhIGJpbmFyeSBmb3IgZmlsZW5hbWVzLiAqL1xuY29uc3QgVFJBTlNJVElWRV9FWFRTID0gW1wiLmpzXCIsIFwiLmNzc1wiXTtcblxuLyoqIE9uZSBkZXJpdmF0aW9uIHBlciBgZGlzdC9gLCBmb3IgdGhlIGxpZmUgb2YgdGhlIHByb2Nlc3Mg4oCUIGBkaXN0L2AgaXMgYSBidWlsZFxuICogIGFydGlmYWN0IGFuZCBkb2VzIG5vdCBjaGFuZ2UgdW5kZXIgYSBydW5uaW5nIGRhZW1vbi4gS2V5ZWQgYnkgZGlyZWN0b3J5IHNvXG4gKiAgdHdvIGRhZW1vbnMgaW4gb25lIHByb2Nlc3MgKGFuZCBldmVyeSB0ZXN0IHdpdGggaXRzIG93biB0ZW1wIHRyZWUpIHN0YXlcbiAqICBpbmRlcGVuZGVudC4gKi9cbmNvbnN0IHdoaXRlbGlzdENhY2hlID0gbmV3IE1hcDxzdHJpbmcsIFJlYWRvbmx5U2V0PHN0cmluZz4+KCk7XG5cbmZ1bmN0aW9uIHJlZnNJbih0ZXh0OiBzdHJpbmcsIHJlOiBSZWdFeHApOiBzdHJpbmdbXSB7XG4gIHJldHVybiBbLi4udGV4dC5tYXRjaEFsbChyZSldXG4gICAgLm1hcCgoWywgcmVmXSkgPT4gcmVmKVxuICAgIC5maWx0ZXIoXG4gICAgICAocmVmKSA9PlxuICAgICAgICAhIXJlZiAmJlxuICAgICAgICAhcmVmLmluY2x1ZGVzKFwiL1wiKSAmJlxuICAgICAgICAhcmVmLmluY2x1ZGVzKFwiLi5cIikgJiZcbiAgICAgICAgIXJlZi5pbmNsdWRlcyhcIjpcIikgJiZcbiAgICAgICAgIXJlZi5zdGFydHNXaXRoKFwiI1wiKSAmJlxuICAgICAgICAhcmVmLnN0YXJ0c1dpdGgoXCI/XCIpLFxuICAgICk7XG59XG5cbi8qKlxuICogVGhlIG5hbWVzIHVuZGVyIGBkaXN0RGlyYCBhIGJyb3dzZXIgbWF5IGZldGNoOiB0aGUgZW50cnkgZG9jdW1lbnQsIHBsdXMgdGhlXG4gKiBUUkFOU0lUSVZFIGNsb3N1cmUgb2Ygd2hhdCBpdCBsaW5rcy5cbiAqXG4gKiDim5QgKipBIFdISVRFTElTVCwgQU5EIFRIRSBMRUFLIElUIFJFUExBQ0VEIElTIFdIWS4qKiBVbnRpbCB0aGlzIGZpeCB0aGUgZmlsZVxuICogaGFsZiBvZiB0aGlzIG1vZHVsZSBoYWQgZXhhY3RseSB0aHJlZSBndWFyZHMg4oCUIGVtcHR5LCBgLi5gLCBuZXN0ZWQg4oCUIGFuZFxuICogYGV4aXN0c1N5bmNgIGRlY2lkZWQgdGhlIHJlc3QuIFRoYXQgd2FzIGNvcnJlY3QgZm9yIGFzIGxvbmcgYXMgYGRpc3QvYCBoZWxkXG4gKiBvbmx5IGEgc3VyZmFjZS4gVGhlIGJhY2tlbmQgY29udmVyZ2VuY2UgbW92ZWQgZXZlcnkgc3BlbGwncyBJTVBMRU1FTlRBVElPTlxuICogaW50byB0aGUgc2FtZSBkaXJlY3RvcnksIGFuZCB0aGUgc2VydmUgZGlkIHdoYXQgaXQgd2FzIHdyaXR0ZW4gdG8gZG86XG4gKlxuICogICBHRVQgL2NsaS5qcyAgICAgMjAwICAyNDIsNDMxIEIgIHRleHQvamF2YXNjcmlwdCAgIOKGkCBib3VudHksIGJ5dGUtaWRlbnRpY2FsXG4gKiAgIEdFVCAvc2VydmVyLmpzICAyMDAgIDI3Niw0MTUgQiAgdGV4dC9qYXZhc2NyaXB0ICAgICAgdG8gdGhlIGNvbW1pdHRlZFxuICogICBHRVQgL2pvaW4uanMgICAgMjAwICAgNDcsMzQ4IEIgIHRleHQvamF2YXNjcmlwdCAgICAgIGFydGlmYWN0c1xuICpcbiAqIGFuZCB0aG9zZSBidW5kbGVzIGFyZSBidWlsdCB3aXRoIHRoZSBzb3VyY2VtYXAgRU1CRURERUQsIHNvIGVhY2ggb25lIGNhcnJpZXNcbiAqIHRoZSBjb21wbGV0ZSBvcmlnaW5hbCBUeXBlU2NyaXB0LiBGaXZlIHNwZWxscyDigJQgYXN0cm9sYWJlLCBib3VudHksIGdsYW1vdXIsIGltYWdvLCBtYWdwaWVcbiAqIOKAlCBlbGV2ZW4gYXJ0aWZhY3RzLCBhbGwgcmVhY2hhYmxlIGJ5IGFueSBicm93c2VyIHRoYXQgY2FuIHJlYWNoIHRoZSBkYWVtb24uXG4gKiBEaWdlc3RpZnkgaGl0IHRoZSBpZGVudGljYWwgZGVmZWN0IG9uZSBicmFuY2ggZWFybGllciBhbmQgYW5zd2VyZWQgaXQgbG9jYWxseTtcbiAqIHRoaXMgaXMgdGhhdCBhbnN3ZXIgcmUtaG9tZWQgdG8gdGhlIG9uZSBwbGFjZSBhbGwgZml2ZSBjYWxsZXJzIGFscmVhZHkgc2hhcmUuXG4gKlxuICog4puUICoqREVSSVZFRCwgTk9UIEVOVU1FUkFURUQsIEFORCBOT1QgTUFUQ0hFRCBCWSBTSEFQRS4qKiBBIGxpdGVyYWwgbmFtZSBsaXN0XG4gKiBpcyB3cm9uZyBhdCB0aGUgbmV4dCBidWlsZCAodGhlIGNodW5rcyBjYXJyeSBjb250ZW50IGhhc2hlcykuIEEgc2hhcGUgbWF0Y2hcbiAqIChgaW5kZXgtPGhhc2g+LmpzYCkgaXMgd3JvbmcgdGhlIGZpcnN0IHRpbWUgdGhlIGJ1bmRsZXIgc3BsaXRzIGEgY2h1bmsuIEFza2luZ1xuICogdGhlIGVudHJ5IGRvY3VtZW50IHdoYXQgaXQgbG9hZHMgaXMgdGhlIG9ubHkgZm9ybXVsYXRpb24gdGhhdCBpcyB0cnVlIG9mXG4gKiB3aGF0ZXZlciBgYnVuIHJ1biBidWlsZGAgYWN0dWFsbHkgZW1pdHRlZC5cbiAqXG4gKiDim5QgKipBTkQgVEhFIENMT1NVUkUgSVMgVFJBTlNJVElWRSBGT1IgVEhFIFNBTUUgUkVBU09OLioqIGBpbmRleC5odG1sYCBsaW5rc1xuICogb25lIGNodW5rIHRvZGF5OyBhIHNwbGl0IGJ1aWxkIGhhcyB0aGF0IGNodW5rIGBpbXBvcnQgXCIuL2NodW5rLTxoYXNoPi5qc1wiYCxcbiAqIHdoaWNoIHRoZSBlbnRyeSBkb2N1bWVudCBuZXZlciBuYW1lcy4gU28gZXZlcnkgYWRtaXR0ZWQgYC5qc2AvYC5jc3NgIGlzIGl0c2VsZlxuICogc2Nhbm5lZCBmb3IgYC4vYC1wcmVmaXhlZCBzaWJsaW5ncywgdW50aWwgdGhlIHNldCBzdG9wcyBncm93aW5nIOKAlCBhIHdoaXRlbGlzdFxuICogdGhhdCByZWFkIG9ubHkgdGhlIGVudHJ5IHdvdWxkIDQwNCBhIGxlZ2l0aW1hdGUgY2h1bmsgaW4gcmVsZWFzZSwgYW5kIG9ubHkgaW5cbiAqIHJlbGVhc2UuXG4gKlxuICog4puUICoqTUVNQkVSU0hJUCBJUyBBTiBFWEFDVCBNQVRDSCwgV0hJQ0ggTUFLRVMgVEhFIFJFRlVTQUwgQ0FTRS1JTlNFTlNJVElWRSBCWVxuICogQ09OU1RSVUNUSU9OLioqIEFQRlMgaXMgY2FzZS1pbnNlbnNpdGl2ZSwgc28gYC9JTkRFWC5IVE1MYCBhbmQgYC9pTmRFeC5IdE1sYFxuICogcmVzb2x2ZSB0byB0aGUgc2FtZSBpbm9kZSBhIGNhc2Utc2Vuc2l0aXZlIGJsYWNrbGlzdCB3b3VsZCBtaXNzIChtZWFzdXJlZCBvblxuICogYWxsIGZpdmUgc3BlbGxzIGJlZm9yZSB0aGlzIGZpeDogZm91ciB2YXJpYW50cywgZm91ciAyMDBzLCB0aHJlZSBvZiB0aGVtIGFzXG4gKiBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYCBiZWNhdXNlIHRoZSBjb250ZW50LXR5cGUgbG9va3VwIGlzIGNhc2Utc2Vuc2l0aXZlXG4gKiB0b28pLiBBIHNldCBvZiBleGFjdGx5IHRoZSBlbWl0dGVkIG5hbWVzIHJlZnVzZXMgZXZlcnkgdmFyaWFudCBvZiBldmVyeSBuYW1lXG4gKiDigJQgc2VydmFibGUgb3Igbm90IOKAlCB3aXRoIG5vIGxvd2VyLWNhc2UgcGFzcyBhbnl3aGVyZS5cbiAqXG4gKiDimqAgKipUSEUgVFJBREU6KiogYSBmaWxlIHRoZSBlbnRyeSBncmFwaCBkb2VzIG5vdCByZWZlcmVuY2Ug4oCUIGEgbGF6aWx5IGZldGNoZWRcbiAqIGNodW5rLCBhIGZvbnQgcHVsbGVkIGJ5IGEgQ1NTIGB1cmwoKWAgdGhpcyBzY2FuIGRvZXMgbm90IG1vZGVsLCBhbiBhc3NldCB0aGVcbiAqIGJ1aWxkIGVtaXRzIGJ1dCBub3RoaW5nIGxpbmtzIOKAlCA0MDRzIGluIHJlbGVhc2Ugd2l0aCBub3RoaW5nIHJlZC4gRWFjaFxuICogYWRvcHRlcidzIGByZWxlYXNlLXNlcnZlLnRlc3QudHNgIGhvbGRzIHRoZSBpbnN0cnVtZW50OiBhbiBJTlZFTlRPUlkgY2VsbCB0aGF0XG4gKiBhY2NvdW50cyBmb3IgZXZlcnkgZmlsZSBpbiBgZGlzdC9gIGFzIHNlcnZlZCBvciBkZWxpYmVyYXRlbHkgcmVmdXNlZCwgc28gYW5cbiAqIHVubGlua2VkIGVtaXNzaW9uIGdvZXMgcmVkIGF0IGJ1aWxkIHRpbWUgcmF0aGVyIHRoYW4gc2lsZW50IGF0IHJ1bnRpbWUuXG4gKlxuICog4pqgIFRoZSBlbnRyeSBkb2N1bWVudCBpcyBJTiB0aGUgc2V0LCBiZWNhdXNlIHRoZSBob3VzZSBjYWxsZXIgbWFwcyBgL2AgdG9cbiAqIGBpbmRleC5odG1sYCBhbmQgdGhhdCBpcyB0aGUgc3VyZmFjZS4gQSBzcGVsbCB0aGF0IG11c3QgbmV2ZXIgaGFuZCBvdmVyIGl0c1xuICogb24tZGlzayBlbnRyeSDigJQgZGlnZXN0aWZ5IHN1YnN0aXR1dGVzIGEgcGF5bG9hZCBpbnRvIGl0IGluIG1lbW9yeSDigJQgcmVmdXNlc1xuICogdGhhdCBPTkUgbmFtZSBpbiBpdHMgb3duIHJvdXRlciwgYWJvdmUgdGhpcyBjYWxsLiBUaGF0IHJlZnVzYWwgaXMgdGhlIHNwZWxsJ3M7XG4gKiBldmVyeXRoaW5nIGVsc2UgaGVyZSBpcyB0aGUga2l0J3MuXG4gKi9cbmZ1bmN0aW9uIHN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcjogc3RyaW5nKTogUmVhZG9ubHlTZXQ8c3RyaW5nPiB7XG4gIGNvbnN0IGNhY2hlZCA9IHdoaXRlbGlzdENhY2hlLmdldChkaXN0RGlyKTtcbiAgaWYgKGNhY2hlZCkgcmV0dXJuIGNhY2hlZDtcblxuICBjb25zdCBuYW1lcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBlbnRyeSA9IGpvaW4oZGlzdERpciwgXCJpbmRleC5odG1sXCIpO1xuICBpZiAoZXhpc3RzU3luYyhlbnRyeSkpIHtcbiAgICBuYW1lcy5hZGQoXCJpbmRleC5odG1sXCIpO1xuICAgIGNvbnN0IGh0bWwgPSByZWFkRmlsZVN5bmMoZW50cnksIFwidXRmOFwiKTtcbiAgICBjb25zdCBwZW5kaW5nID0gWy4uLnJlZnNJbihodG1sLCBFTlRSWV9SRUZfUkUpLCAuLi5yZWZzSW4oaHRtbCwgUkVMQVRJVkVfUkVGX1JFKV07XG4gICAgLy8gVW50aWwgdGhlIHNldCBzdG9wcyBncm93aW5nOiBlYWNoIGFkbWl0dGVkIGNodW5rIG1heSBuYW1lIHRoZSBuZXh0IG9uZS5cbiAgICB3aGlsZSAocGVuZGluZy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBuYW1lID0gcGVuZGluZy5wb3AoKSBhcyBzdHJpbmc7XG4gICAgICBpZiAobmFtZXMuaGFzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgIC8vIOKaoCBSRUZFUkVOQ0VEICoqQU5EKiogUFJFU0VOVC4gQSBtaW5pZmllZCBidW5kbGUgY2FuIGNvbnRhaW4gYSBzdHJpbmdcbiAgICAgIC8vIHRoYXQgbWVyZWx5IExPT0tTIGxpa2Ugb25lOyBhZG1pdHRpbmcgb25seSBuYW1lcyB0aGF0XG4gICAgICAvLyBhcmUgYWN0dWFsbHkgb24gZGlzayBrZWVwcyB0aGUgc2NhbiBmcm9tIHdpZGVuaW5nIHRoZSBzZXQgb24gYVxuICAgICAgLy8gY29pbmNpZGVuY2UsIGFuZCBhIG5hbWUgdGhhdCBpcyBhYnNlbnQgNDA0cyBpZGVudGljYWxseSBlaXRoZXIgd2F5LlxuICAgICAgY29uc3QgZmlsZSA9IGpvaW4oZGlzdERpciwgbmFtZSk7XG4gICAgICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIGNvbnRpbnVlO1xuICAgICAgbmFtZXMuYWRkKG5hbWUpO1xuICAgICAgaWYgKCFUUkFOU0lUSVZFX0VYVFMuc29tZSgoZXh0KSA9PiBuYW1lLmVuZHNXaXRoKGV4dCkpKSBjb250aW51ZTtcbiAgICAgIHBlbmRpbmcucHVzaCguLi5yZWZzSW4ocmVhZEZpbGVTeW5jKGZpbGUsIFwidXRmOFwiKSwgUkVMQVRJVkVfUkVGX1JFKSk7XG4gICAgfVxuICB9XG5cbiAgd2hpdGVsaXN0Q2FjaGUuc2V0KGRpc3REaXIsIG5hbWVzKTtcbiAgcmV0dXJuIG5hbWVzO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBzZXJ2ZXIgc2lkZSBvZiB0aGUgU1NFIHRhaWwg4oCUIHRoZSBkYWVtb24tc2lkZSB0d2luIG9mXG4gKiBgdGFpbEV2ZW50cy50c2AuIFRoYXQgbW9kdWxlIGRlY2lkZXMgd2hhdCBhIGNhbGxlciBvYnNlcnZlczsgdGhpcyBvbmUgZGVjaWRlc1xuICogd2hhdCBhIGNhbGxlciBpcyBzZW50LlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIGV4Y2VwdCBpdHNcbiAqIG93biBzaWJsaW5nIHR5cGVzLCB3aGljaCBpcyBzdGlsbCBpbnNpZGUgdGhlIGxlYWYuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIG1pbmQtbWFwcGVyJ3MgYHNzZVJlc3BvbnNlYCxcbiAqIHRoZSBjZW5zdXMncyBjb252ZXJnZW5jZSB0YXJnZXQgIzE6IHRoZSBvbmx5IG9uZSBvZiB0aGUgc2V2ZW4gd2l0aCBhXG4gKiBvbmNlLW9ubHkgdGVhcmRvd24gZnVubmVsLCB0aGUgb25seSBvbmUgd2lyZWQgdG8gYHJlcS5zaWduYWxgLCBhbmQgdGhlIG9ubHlcbiAqIG9uZSB3aG9zZSBjb21tZW50IHJlY29yZHMgYSBNRUFTVVJFRCByZXN1bHQgcmF0aGVyIHRoYW4gYSBiZWxpZWYuXG4gKlxuICog4pSA4pSAIOKblCBBTkQgV0hBVCBUSEUgQ09QWSBMRUZUIEJFSElORCwgU0FJRCBIRVJFIEJFQ0FVU0UgQSBMT1NTIFJFQ09SREVEIE9OTFkgSU5cbiAqICAgIEEgUE9SVCdTIEpPVVJOQUwgR0VUUyBSRS1MSVRJR0FURUQgQlkgRVZFUlkgU1BFTEwgQUZURVIgSVQgKEQ3OS9EODUpIOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSBzZW50ZW5jZSBhYm92ZSBuYW1lcyBhIFNPVVJDRSB0aGlzIG1vZHVsZSBoYWQgbmV2ZXIgYmVlbiBjaGVja2VkIGFnYWluc3Q6XG4gKiBEMSBydWxlZCB0aGUgc3BpbmUgYmUgcHJvdmVuIG9uIHRoZSB0d28gc3BlbGxzIHRoYXQgYWxyZWFkeSBidWlsdCwgYW5kIGJvdGggb2ZcbiAqIHRob3NlIGFyZSBkb3duc3RyZWFtIEZPUktTIG9mIHRoZSBtaW5kLW1hcHBlciBsaW5lLCBzbyB0aGUgYm91bmRhcmllcyB3ZXJlXG4gKiBzZXR0bGVkIGFnYWluc3QgdHdvIGNvcGllcyB3aGlsZSB0aGUgb3JpZ2luYWwgd2FzIG5vdCBpbiB0aGUgcm9vbS4gKipBXG4gKiBjb252ZXJnZW5jZSBjYW4gbmFtZSBpdHMgc291cmNlIGFuZCBzdGlsbCBuZXZlciBjb25zdWx0IGl0LioqXG4gKlxuICogV2hlbiBpdCB3YXMgZmluYWxseSBjb25zdWx0ZWQgKFBoYXNlIDcsIHRoZSBsYXN0IHBvcnQpLCBleGFjdGx5IE9ORSBwcm9wZXJ0eVxuICogb2YgdGhlIHNvdXJjZSB3YXMgbWlzc2luZyBoZXJlLCBhbmQgaXQgb2NjdXBpZWQgbm8gdHlwZTogKiptaW5kLW1hcHBlciB3cm90ZVxuICogaXRzIGB0YWlsIC0taW5ib3VuZGAgZ3JvdW5kaW5nIGZyYW1lIEJFRk9SRSB0aGUgcmVwbGF5Kiog4oCUIG9uZSBsaW5lIGFib3ZlXG4gKiBgYnVzLnN1YnNjcmliZWAg4oCUIHNvIGl0IHdhcyB0aGUgc3RyZWFtJ3MgZmlyc3QgZGF0YSBsaW5lLiBgb25PcGVuYCBmaXJlcyBhdFxuICogdGhlIEVORCBvZiBgc3RhcnRgLCBhZnRlciB0aGUgcHJlYW1ibGUsIGFmdGVyIGBsb2cuc3Vic2NyaWJlYCwgYWZ0ZXJcbiAqIGBjbGllbnRzLmFkZGAsIHNvIGEgY2FsbGVyIHRoYXQgc3VwcGxpZWQgaXRzIG93biBgY2xpZW50c2Agc2V0IGFuZCBzZW50IGZyb21cbiAqIHRoZXJlIHdvdWxkIGxhbmQgdGhlIGZyYW1lIEFGVEVSIHRoZSByZXBsYXllZCBiYWNrbG9nLiBUaGF0IGlzIEVYUFJFU1NJQkxFLFxuICogd2hpY2ggaXMgd2hhdCBtYWtlcyB0aGlzIGEgbWVhc3VyZW1lbnQgcmF0aGVyIHRoYW4gYW4gYXNzZXJ0aW9uOiB0aGVcbiAqIHBsYXlib29rJ3MgdHlwZS10by10eXBlIGNvbXBhdGliaWxpdHkgcHJvY2VkdXJlIGFuc3dlcnMgXCJyZXByZXNlbnRhYmxlXCIgaGVyZVxuICogKHRoZSBzdWJqZWN0IHR5cGUgaXMgYFNldDxTc2VDbGllbnQ+YCwgdGhlIHNwZWxsIGtlZXBzIG5vIHJlZ2lzdHJ5LCBzbyB5b3VcbiAqIHBhc3MgYW4gZW1wdHkgc2V0KSBhbmQgYSB0eXBlIGNoZWNrIGNhbm5vdCBzZWUgYSBQT1NJVElPTi5cbiAqXG4gKiAqKlRoZSBkaXNwb3NpdGlvbiB3YXMgUkVTVE9SRSwgbm90IEtFRVAtTE9DQUwgYW5kIG5vdCBGSUxFKiog4oCUIHNlZVxuICogYG9wZW5GcmFtZXNgIGJlbG93LCB3aGVyZSB0aGUgdHdvIG51bWJlcnMgdGhhdCBwZXJtaXQgaXQgYXJlIHJlY29yZGVkIGFuZFxuICogZHJpdmVuLiBUaGUgZ2VuZXJhbGlzYXRpb24sIHdoaWNoIGlzIHRoZSBwYXJ0IHdvcnRoIGNhcnJ5aW5nOiB3aGVyZSBhXG4gKiBtb2R1bGUncyBzdWJqZWN0IGlzIGEgU0VRVUVOQ0UgT0YgV1JJVEVTLCBjb21wYXJlIHRoZSBPUkRFUiBvZiBpdHMgaG9va3NcbiAqIGFnYWluc3QgdGhlIG9yZGVyIHRoZSBhZG9wdGluZyBzcGVsbCB3cml0ZXMgaW4uIFR3byBob29rcyB3aXRoIHRoZSByaWdodFxuICogc2lnbmF0dXJlcyBpbiB0aGUgd3Jvbmcgb3JkZXIgYXJlIGFzIGluY29tcGF0aWJsZSBhcyB0d28gdHlwZXMgdGhhdCB3aWxsIG5vdFxuICogdW5pZnksIGFuZCBvbmx5IG9uZSBvZiB0aGUgdHdvIGNhbiBiZSBTRUVOIGJ5IGEgY29tcGF0aWJpbGl0eSBjaGVjay5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSLCBSRS1IT01FRDogYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgRE9FUyBOT1QgREVURUNUIEEgREVBRFxuICogICAgQ0xJRU5ULiBNRUFTVVJFRCBPTiBCVU4gMS4zLjE0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFNpeCBkYWVtb25zIHdyaXRlIGEgaGVhcnRiZWF0IGFzIGB0cnkgeyBjb250cm9sbGVyLmVucXVldWUoLi4uKSB9IGNhdGNoIHt9YFxuICogd2l0aCBhIGNvbW1lbnQgc2F5aW5nIHRoZSBjYXRjaCBpcyBob3cgYSBkZXBhcnRlZCBjbGllbnQgaXMgbm90aWNlZC4gSXQgaXNcbiAqIG5vdDogZW5xdWV1ZSBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gQlVGRkVSUyBTSUxFTlRMWSBhbmQgbmV2ZXIgdGhyb3dzLCBzbyB0aGVcbiAqIGNhdGNoIG5ldmVyIGZpcmVzIGFuZCB0aG9zZSBkYWVtb25zJyBkZWFkLWNsaWVudCBkZXRlY3Rpb24gcmVzdHMgb24gYVxuICogbWVjaGFuaXNtIHRoZWlyIG93biBjb21tZW50cyBkZXNjcmliZSBpbmNvcnJlY3RseS4gV2hhdCBhY3R1YWxseSByZWNsYWltcyB0aGVcbiAqIGNvbm5lY3Rpb24gaXMgdGhlIHN0cmVhbSdzIGBjYW5jZWwoKWAg4oCUIGFuZCwgZm9yIGEgY2xpZW50IHRoYXQgbmV2ZXIgY2xvc2VzXG4gKiB0aGUgc29ja2V0LCBgcmVxLnNpZ25hbGAuXG4gKlxuICogU28gdGhlIGZ1bm5lbCBiZWxvdyBpcyB0aGUgbG9hZC1iZWFyaW5nIHBhcnQuIGB0ZWFyZG93bigpYCBydW5zIEFUIE1PU1QgT05DRVxuICogZnJvbSBldmVyeSBwYXRoIHRoZXJlIGlzIOKAlCBgY2FuY2VsKClgLCBhbiBhYm9ydCBvbiB0aGUgcmVxdWVzdCBzaWduYWwsIGFuZFxuICogdGhlIGJlbHQtYW5kLWJyYWNlcyBlbnF1ZXVlIGNhdGNoIOKAlCBhbmQgaXQgaXMgd2hlcmUgdGhlIHN1YnNjcmliZXIgY291bnQgYW5kXG4gKiBhbnkgcHJlc2VuY2UgZGVjcmVtZW50IHJpZGUuIEJvdW5kaW5nIHByZXNlbmNlIGFjY3VyYWN5IGlzIGJvdW5kaW5nIHRoYXRcbiAqIGZ1bm5lbC5cbiAqXG4gKiDimqAgS25vd24gaG9sZSwgYWNjZXB0ZWQgYW5kIGluaGVyaXRlZDogQnVuJ3Mgb3duIGBmZXRjaCgpYCByZWFkZXIgYC5jYW5jZWwoKWBcbiAqIGNsb3NlcyBub3RoaW5nIGNsaWVudC1zaWRlIGFuZCB0aGUgc2VydmVyIGNhbm5vdCBzZWUgaXQuIFJlYWwgY2xpZW50cyBjbG9zZVxuICogdGhlIHNvY2tldC5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBET0VTIE5PVCBBRE9QVCBUSElTLCBBTkQgVEhFIFJFRlVTQUwgSVMgUEFSVCBPRiBUSEUgUlVMSU5HIOKUgOKUgFxuICpcbiAqIFJFSkVDVC1TVFJVQ1RVUkFMLCBydWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLlxuICogR3JhcGV2aW5lIEhBUyBhbiBTU0UgcmVnaXN0cnkgYW5kIGl0IGlzIHRoZSBidXNpZXN0IHRoaW5nIGluIHRoZSBzcGVsbDsgdGhlXG4gKiB0d28gdHlwZXMgc2ltcGx5IGNhbm5vdCBiZSBjb25zdHJ1Y3RlZCBmcm9tIGVhY2ggb3RoZXI6XG4gKlxuICogICB0aGlzIG1vZHVsZSAgYFNzZUNsaWVudHMgPSBTZXQ8U3NlQ2xpZW50PmAgd2hlcmUgYFNzZUNsaWVudCA9IHtjbG9zZSwgc2VuZH1gXG4gKiAgICAgICAgICAgICAgICDigJQgYSByZWdpc3RyeSBvZiBBTk9OWU1PVVMgY2xvc2VycywgYW5kIGBzaXplYCBpcyB0aGUgb25seSB0aGluZ1xuICogICAgICAgICAgICAgICAgYW55IGFkb3B0aW5nIGRhZW1vbiByZWFkcyBvZmYgaXQuXG4gKiAgIGdyYXBldmluZSAgICBgTWFwPHN5bWJvbCwge2FsaWFzLCBodW1hbiwgbHVyaywgc2VuZH0+YCwgcGVyIGNoYW5uZWwuXG4gKlxuICogKipUaGUgcmVhZGVycyB0aGF0IG1ha2UgdGhlbSBpbmNvbXBhdGlibGUsIGNvdW50ZWQgcmF0aGVyIHRoYW4gYXNzZXJ0ZWQ6IFNJWFxuICogcm91dGVzIHJlYWQgYGFsaWFzYC9gaHVtYW5gL2BsdXJrYCoqIOKAlCBgR0VUIC9jaGFubmVsc2AgKHRocm91Z2hcbiAqIGBsaXN0Q2hhbm5lbHNgIOKGkiBgdmlzaWJsZVN1YnNgKSwgYEdFVCAvcHJlc2VuY2VgLCBgUE9TVCAvY2hhbm5lbHNgLFxuICogYFBPU1QgL2Fubm91bmNlYCwgYFBPU1QgL2NoYW5uZWxzLzpuYW1lL21lc3NhZ2VzYCwgYW5kXG4gKiBgR0VUIC9jaGFubmVscy86bmFtZS9zdWJzY3JpYmVyc2AuIGBhbGlhc2AgaXMgYSBuYW1lIGEgaHVtYW4gc2VlcyBpbiBhIHJvc3RlcixcbiAqIGBodW1hbmAgdGVsbHMgYW4gYWdlbnQgaXQgaXMgdGFsa2luZyB0byBhIHBlcnNvbiwgYW5kIGBsdXJrYCBleGNsdWRlcyBhXG4gKiBjb25uZWN0aW9uIGZyb20gZXZlcnkgcHJlc2VuY2UgY291bnQuIFRoZXJlIGlzIG5vIHdheSB0byBwdXQgYW55IG9mIHRoYXQgaW50b1xuICogYSBzZXQgb2YgY2xvc2Vycy4gQWRvcHRpbmcgdGhpcyBtb2R1bGUgd291bGQgbm90IGJlIGRlYWQgY29kZTsgaXQgd291bGQgYmUgYVxuICogcmV3cml0ZSBvZiB3aGF0IGdyYXBldmluZSBJUy5cbiAqXG4gKiDimqAgKipBTkQgVEhFIExJU1QgSVMgREVMSUJFUkFURUxZIE5PVCBUSEUgT0JWSU9VUyBPTkUuKiogVGhlIHBvcnQncyBmaXJzdFxuICogY291bnQgbmFtZWQgdGhlIGByb2xsYC9jbGVhciBicm9hZGNhc3QsIHRoZSBhcmNoaXZlIGxpdmUtZ3VhcmQgYW5kIHR3b1xuICogUkVHSVNUUkFUSU9OUyDigJQgYW5kIGV2ZXJ5IG9uZSBvZiB0aG9zZSBpcyBhIHNpdGUgdGhpcyBtb2R1bGUncyB0eXBlIHdvdWxkXG4gKiBzZXJ2ZSBwZXJmZWN0bHk6IHRoZSBicm9hZGNhc3QgcmVhZHMgb25seSBgcy5zZW5kYCwgdGhlIGxpdmUtZ3VhcmQgb25seVxuICogYHN1YnNjcmliZXJzLnNpemVgICh3aGljaCB0aGlzIGhlYWRlciBpdHNlbGYgc2F5cyBpcyBhbGwgYW55IGFkb3B0ZXIgcmVhZHMpLFxuICogYW5kIGEgcmVnaXN0cmF0aW9uIFdSSVRFUyB0aGUgcmVjb3JkIHJhdGhlciB0aGFuIHJlYWRpbmcgaXQuIFRoZSBzaXggYWJvdmUgYXJlXG4gKiB0aGUgb25lcyB0aGF0IHJlYWQgYSBmaWVsZCB0aGUga2l0J3MgYFNzZUNsaWVudGAgZG9lcyBub3QgaGF2ZTsgdGhlIHdyaXRlcnNcbiAqIChgL3dhaXRgJ3MgcHJlc2VuY2UgcmVnaXN0cmF0aW9uIGFuZCB0aGUgdGFpbCdzKSBhcmUgbmFtZWQgc2VwYXJhdGVseSBiZWNhdXNlXG4gKiBhIHdyaXRlciBpcyBub3QgZXZpZGVuY2Ugb2YgYW55dGhpbmcuIENvdW50ZWQgaW4gdGhlIHByZS1wb3J0IGRhZW1vbixcbiAqIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvZ3JhcGV2aW5lL3NjcmlwdHMvZGFlbW9uLnRzYCBvbiBgZGV2ZWxvcGA6XG4gKiBsLjQyMSwgNzM5LTc0NywgODI2LCA4ODYtODg3LCAxMDQ5LTEwNTQsIDExODItMTE4OCDigJQgd3JpdGVycyBhdCAxMTExLTExMTIgYW5kXG4gKiAxMzA3LiAoQ29ycmVjdGVkIDIwMjYtMDktMDkgaW4gdGhlIHJlcGFpciBjaGFwdGVyOyBENjgncyByZXF1aXJlbWVudCBpcyB0aGF0XG4gKiB0aGUgcmVmdXNhbCBiZSB3cml0dGVuIHdoZXJlIHRoZSBuZXh0IHJlYWRlciBtZWV0cyBpdCwgd2hpY2ggbWFrZXMgYVxuICogbWlzLW1lYXN1cmVkIGxpc3Qgd29yc2UgdGhhbiBub25lLilcbiAqXG4gKiDimqAgQW5kIGdyYXBldmluZSdzIHJlY29yZHMgY2Fycnkgbm8gYGNsb3NlYCBhdCBhbGwg4oCUIHRoZSBwZXItc3RyZWFtIHRlYXJkb3duIGlzXG4gKiBhIGNsb3N1cmUgc3Rhc2hlZCBvbiB0aGUgUmVhZGFibGVTdHJlYW0gY29udHJvbGxlciwgcmVhY2hhYmxlIG9ubHkgZnJvbVxuICogYGNhbmNlbCgpYCDigJQgd2hpY2ggaXMgYWxzbyB3aHkgYGhvdXNla2VlcGluZ2AncyBgZHJhaW5BbmRTdG9wYCBpcyBhZG9wdGVkXG4gKiB0aGVyZSB3aXRoIGl0cyBgY2xpZW50c2AgYXJndW1lbnQgZGVsaWJlcmF0ZWx5IGVtcHR5LlxuICpcbiAqICoqVGhlIHdpZGVuaW5nIE5PVCBkb25lLCB3aXRoIGl0cyBjb3N0OioqIGFkbWl0dGluZyBhbiBhbGlhcy1iZWFyaW5nIHJlY29yZFxuICogd291bGQgY2hhbmdlIHRoZSB0eXBlIGZpdmUgb3RoZXIgZGFlbW9ucyBjb21waWxlIGFnYWluc3QgYW5kIHJlLWVtaXQgU0lYXG4gKiBhcnRpZmFjdHMgYWNyb3NzIEZJVkUgc3BlbGxzLCBlYWNoIG93ZWQgYSBkcml2ZS4gSXQgd291bGQgYWxzbyByZS1jcmVhdGUgdGhlXG4gKiB0aGluZyB0aGlzIHJlZ2lzdHJ5IGV4aXN0cyB0byBzdG9wLCBhbmQgdGhpcyBmaWxlJ3Mgb3duIGJvdW5kYXJ5IHBhcmFncmFwaFxuICogc2F5cyBob3c6IGEgc2lnbmF0dXJlIHdpZGUgZW5vdWdoIHRvIGFic29yYiBldmVyeSBjYWxsZXIncyBzaGFwZSBzdG9wcyBiZWluZyBhXG4gKiByZWdpc3RyeSBhbmQgYmVjb21lcyBhIHVuaW9uLiBUaGUgY2Vuc3VzIGNvbnZlcmdlZCBjb3BpZXMgaW50byBvbmUgbW9kdWxlIGJ5XG4gKiBmaW5kaW5nIHdoYXQgdGhleSBTSEFSRUQ7IGEgbW9kdWxlIHdpZGVuZWQgdG8gZml0IHRoZSBvbmUgc3BlbGwgdGhhdCBzaGFyZXNcbiAqIG5vdGhpbmcgaXMgdGhvc2UgY29waWVzIGFnYWluIHdpdGggYSB1bmlvbiB0eXBlIG92ZXIgdGhlIHRvcC4gVGhlIHNwZWxsIGtlZXBzXG4gKiBpdHMgb3duLCBhbmQgYSB3aWRlbmluZyByZW1haW5zIGEgc2VwYXJhdGUsIGFyZ3VlZCBkZWNpc2lvbi5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEV2ZW50TG9nLCBGcmFtZSB9IGZyb20gXCIuL2V2ZW50TG9nLnRzXCI7XG5cbi8qKlxuICogT25lIG9wZW4gU1NFIHN0cmVhbSwgYXMgdGhlIGRhZW1vbiBjYW4gYWN0IG9uIGl0OiBlbmQgaXQsIG9yIHB1c2ggYSBmcmFtZSB0b1xuICogaXQgdGhhdCBkaWQgbm90IGNvbWUgb3V0IG9mIHRoZSBsb2cuXG4gKlxuICog4puUIElUIElTIE5PVCBBIENPTlRST0xMRVIuIFRoZSBjb3BpZXMgaGVsZFxuICogYFNldDxSZWFkYWJsZVN0cmVhbURlZmF1bHRDb250cm9sbGVyPmAgYW5kIGNsb3NlZCB0aGVtIGRpcmVjdGx5IGF0IHRlYXJkb3duLFxuICogd2hpY2ggYnlwYXNzZXMgdGhlIHRlYXJkb3duIGZ1bm5lbCBhYm92ZSDigJQgdGhlIGhlYXJ0YmVhdCBpbnRlcnZhbCBmb3IgdGhhdFxuICogc3RyZWFtIHdhcyBjbGVhcmVkIG9ubHkgYmVjYXVzZSBhIHNlY29uZCBgU2V0YCBvZiB0aW1lcnMgd2FzIGtlcHQgaW4gcGFyYWxsZWxcbiAqIGFuZCBzd2VwdCBzZXBhcmF0ZWx5LiBFdmVyeXRoaW5nIGhlcmUgZ29lcyB0aHJvdWdoIHRoZSBmdW5uZWwsIGFuZCBhIGBzZW5kYFxuICogYWZ0ZXIgdGVhcmRvd24gaXMgYSBuby1vcCByYXRoZXIgdGhhbiBhIHRocm93LlxuICpcbiAqIOKaoCAqKmBzZW5kYCBBUlJJVkVEIElOIFBIQVNFIDIsIEZST00gVEhFIEZJUlNUIENPTlNVTUVSIFRIQVQgV0FTIE5PVCBPTkUgT0YgVEhFXG4gKiBUV08gVEhJUyBNT0RVTEUgV0FTIERFU0lHTkVEIEFHQUlOU1QuKiogYXN0cm9sYWJlIGFuZCBtYWdwaWUgYW5ub3VuY2UgcHJlc2VuY2VcbiAqIG92ZXIgdGhlaXIgYnJvd3NlciBXRUJTT0NLRVQsIHNvIGEgcmVnaXN0cnkgb2YgYmFyZSBjbG9zZXJzIHdhcyBzdWZmaWNpZW50IGFuZFxuICogdGhlIGJvdW5kYXJ5IGxvb2tlZCByaWdodC4gZ2xhbW91ciBhbm5vdW5jZXMgaXQgb24gdGhlIEFHRU5UJ3MgU1NFIHRhaWwg4oCUXG4gKiBge3R5cGU6XCJjb25uZWN0ZWRcIn1gIC8gYHt0eXBlOlwiZGlzY29ubmVjdGVkXCJ9YCwgZGVsaWJlcmF0ZWx5IHVubG9nZ2VkLCBzbyBhXG4gKiByZWNvbm5lY3RpbmcgYWdlbnQgZG9lcyBub3QgcmUtc2VlIGV2ZXJ5IHBhc3QgY29ubmVjdCBhbmQgc28gdGhlIGZyYW1lIG5ldmVyXG4gKiBhZHZhbmNlcyBhIHRhaWwgY3Vyc29yLiBUaGF0IGlzIG5vdCBhIGdsYW1vdXIgcXVpcms7IGl0IGlzIHRoZSBnZW5lcmFsIHNoYXBlXG4gKiBvZiBcInRlbGwgdGhlIGxpdmUgc3Vic2NyaWJlcnMgc29tZXRoaW5nIHRoYXQgaXMgbm90IHBhcnQgb2YgdGhlIGhpc3RvcnlcIiwgYW5kXG4gKiBhIHJlZ2lzdHJ5IHRoYXQgY2FuIG9ubHkgRU5EIGEgc3RyZWFtIGNhbm5vdCBleHByZXNzIGl0LiBXaXRob3V0IHRoaXMgdGhlXG4gKiBzcGVsbCB3b3VsZCBoYXZlIGhhZCB0byBrZWVwIGl0cyBvd24gcGFyYWxsZWwgYFNldGAgb2YgY29udHJvbGxlcnMsIHdoaWNoIGlzXG4gKiBleGFjdGx5IHRoZSBkcmlmdCB0aGlzIHJlZ2lzdHJ5IGV4aXN0cyB0byByZW1vdmUuXG4gKi9cbmV4cG9ydCB0eXBlIFNzZUNsaWVudCA9IHtcbiAgLyoqIEVuZCB0aGlzIHN0cmVhbSwgdGhyb3VnaCB0aGUgdGVhcmRvd24gZnVubmVsLCBhdCBtb3N0IG9uY2UuICovXG4gIGNsb3NlKCk6IHZvaWQ7XG4gIC8qKiBXcml0ZSBvbmUgcmF3IFNTRSBjaHVuayB0byB0aGlzIHN0cmVhbS4gTm8tb3Agb25jZSB0b3JuIGRvd24uICovXG4gIHNlbmQoY2h1bms6IHN0cmluZyk6IHZvaWQ7XG59O1xuXG4vKipcbiAqIFRoZSBsaXZlLXRhaWwgcmVnaXN0cnkuIGBzaXplYCBpcyB0aGUgZGFlbW9uJ3MgU1NFIHN1YnNjcmliZXIgY291bnQg4oCUIHRoZVxuICogbnVtYmVyIGBzaG91bGRJZGxlQ2xvc2VgIG11c3Qgc2VlIOKAlCBhbmQgY2xvc2luZyBldmVyeSBlbnRyeSBpcyB3aGF0IGEgZHJhaW5cbiAqIGRvZXMuXG4gKi9cbmV4cG9ydCB0eXBlIFNzZUNsaWVudHMgPSBTZXQ8U3NlQ2xpZW50PjtcblxuZXhwb3J0IGludGVyZmFjZSBTc2VPcHRpb25zPFQgZXh0ZW5kcyBvYmplY3Q+IHtcbiAgLyoqIFRoZSBsb2cgdG8gcmVwbGF5IGZyb20gYW5kIHN1YnNjcmliZSB0by4gKi9cbiAgbG9nOiBFdmVudExvZzxUPjtcbiAgLyoqIFRoZSBjYWxsZXIncyByZXN1bWUgY3Vyc29yLiBBYnNlbnQgb3IgdW5wYXJzZWFibGUgcmVwbGF5cyBmcm9tIHRoZSBzdGFydC4gKi9cbiAgc2luY2U6IG51bWJlcjtcbiAgLyoqIEhlYXJ0YmVhdCBjb21tZW50IGludGVydmFsLiBNVVNUIHN0YXkgd2VsbCB1bmRlciB0aGUgc2VydmVyJ3NcbiAgICogIGBpZGxlVGltZW91dGAg4oCUIHNlZSBgaGVhcnRiZWF0LnRzYCwgd2hpY2ggaXMgd2hlcmUgdGhhdCBwYWlyIGxpdmVzLiAqL1xuICBoZWFydGJlYXRNczogbnVtYmVyO1xuICAvKiogTGl2ZW5lc3MgcmVnaXN0cnk7IHRoZSBzdHJlYW0gYWRkcyBpdHNlbGYgb24gb3BlbiBhbmQgcmVtb3ZlcyBpdHNlbGYgaW5cbiAgICogIHRoZSB0ZWFyZG93biBmdW5uZWwuICovXG4gIGNsaWVudHM/OiBTc2VDbGllbnRzO1xuICAvKiogYHJlcS5zaWduYWxgIOKAlCB0aGUgb25seSB0aGluZyB0aGF0IHJlY2xhaW1zIGEgY2xpZW50IHRoYXQgd2VudCBhd2F5XG4gICAqICB3aXRob3V0IGNhbmNlbGxpbmcgdGhlIHN0cmVhbS4gKi9cbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIC8qKiBTZXJ2ZXItc2lkZSBmaWx0ZXIuIEEgcmVqZWN0ZWQgZnJhbWUgaXMgbm90IHNlbnQ7IHRoZSBjbGllbnQgc3RpbGxcbiAgICogIGFkdmFuY2VzIGl0cyBjdXJzb3IgcGFzdCBpdCwgd2hpY2ggaXMgYHRhaWxFdmVudHNgJ3MgZG9jdW1lbnRlZCBydWxlLiAqL1xuICBmaWx0ZXI/OiAoZnJhbWU6IEZyYW1lPFQ+KSA9PiBib29sZWFuO1xuICAvKipcbiAgICogUmF3IFNTRSBjaHVua3Mgd3JpdHRlbiB0byBUSElTIHN0cmVhbSBCRUZPUkUgdGhlIHJlcGxheSDigJQgYWZ0ZXIgdGhlXG4gICAqIGBcIjogY29ubmVjdGVkXCJgIHByZWFtYmxlIGFuZCBiZWZvcmUgYGxvZy5zdWJzY3JpYmVgLCBzbyB3aGF0ZXZlciBpdCByZXR1cm5zXG4gICAqIGlzIHRoZSBzdHJlYW0ncyBmaXJzdCBEQVRBIGxpbmUgcmF0aGVyIHRoYW4gYSBmcmFtZSBidXJpZWQgYmVoaW5kIGFcbiAgICogcmVwbGF5ZWQgYmFja2xvZy5cbiAgICpcbiAgICog4puUIElUIElTIEEgUE9TSVRJT04sIFdISUNIIElTIFdIWSBgb25PcGVuYCBDT1VMRCBOT1QgU0VSVkUgKEQ4NSkuIGBvbk9wZW5gXG4gICAqIGZpcmVzIGF0IHRoZSBlbmQgb2YgYHN0YXJ0YCDigJQgYWZ0ZXIgdGhlIHByZWFtYmxlLCBhZnRlciBgbG9nLnN1YnNjcmliZWAsXG4gICAqIGFmdGVyIGBjbGllbnRzLmFkZGAg4oCUIHNvIGEgY2FsbGVyIHRoYXQgc3VwcGxpZXMgaXRzIG93biBgY2xpZW50c2Agc2V0IGFuZFxuICAgKiBzZW5kcyBmcm9tIHRoZXJlIGxhbmRzIGl0cyBmcmFtZSBBRlRFUiB0aGUgYmFja2xvZy4gVGhhdCBpcyBleHByZXNzaWJsZSBhbmRcbiAgICogaXQgaXMgdGhlIHdyb25nIG9yZGVyLCB3aGljaCBpcyB0aGUgbmVhci1taXNzIHRoYXQgbWFrZXMgdGhpcyBhIG1lYXN1cmVtZW50XG4gICAqIHJhdGhlciB0aGFuIGFuIGFzc2VydGlvbjogbm90aGluZyBhYm91dCB0aGUgVFlQRVMgcHJldmVudHMgaXQsIGFuZCBhXG4gICAqIHR5cGUtdG8tdHlwZSBjb21wYXRpYmlsaXR5IGNoZWNrIGNhbm5vdCBzZWUgYSBwb3NpdGlvbi5cbiAgICpcbiAgICog4puUIFJFU1RPUkVEIEZST00gVEhFIFNQRUxMIFRISVMgTU9EVUxFIFdBUyBDT05WRVJHRUQgVE9XQVJELCBBTkQgSVQgSVMgQVxuICAgKiBSRVNUT1JBVElPTiBSQVRIRVIgVEhBTiBBIFdJREVOSU5HIE9OIFRXTyBNRUFTVVJFRCBOVU1CRVJTIChENzkvRDg1KS5cbiAgICogbWluZC1tYXBwZXIncyBgc3NlUmVzcG9uc2VgIHdyb3RlIGl0cyBgdGFpbCAtLWluYm91bmRgIGdyb3VuZGluZyBmcmFtZSBvbmVcbiAgICogbGluZSBBQk9WRSBgYnVzLnN1YnNjcmliZWA7IHRoaXMgbW9kdWxlJ3MgY29udmVyZ2VuY2UgZHJvcHBlZCB0aGUgcG9zaXRpb24sXG4gICAqIHNvIHRoZSBvbmx5IHByb3BlcnR5IG1pbmQtbWFwcGVyIGNvdWxkIG5vdCBhZG9wdCB3YXMgdGhlIG9yZGVyaW5nLiBBcHBsaWVkLFxuICAgKiB3aXRoIGV2ZXJ5IGtpdC1idW5kbGluZyBzcGVsbCByZWJ1aWx0OiAqKihhKSBzb3VyY2UgZWRpdHMgbmVlZGVkIGF0IHRoZVxuICAgKiBvdGhlciBmaXZlIGFkb3B0ZXJzOiBaRVJPKiog4oCUIHRoZSBmaWVsZCBpcyBvcHRpb25hbCBhbmQgbm9ib2R5IHBhc3NlcyBpdDtcbiAgICogKiooYikgYnl0ZXMgb2YgYW55IG90aGVyIGFkb3B0ZXIncyBXSVJFIHRoYXQgZGlmZmVyOiBaRVJPKiog4oCUIGFzdHJvbGFiZSxcbiAgICogYm91bnR5LCBnbGFtb3VyLCBpbWFnbyBhbmQgbWFncGllIHdlcmUgZHJpdmVuIHVuZGVyIHRoZWlyIG93biBzdWl0ZXMgYW5kXG4gICAqIHRoZWlyIHJlbGVhc2UgZHJpdmVzLCBhbmQgbm9uZSBvZiB0aGVtIHdyaXRlcyBhdCBvcGVuLiBCb3RoIG51bWJlcnMgemVybyBpc1xuICAgKiB3aGF0IFwidGhlIGtpdCByZW1vdmVkIGl0IHdoZW4gaXQgY29waWVkXCIgbWVhbnMgb3BlcmF0aW9uYWxseS5cbiAgICpcbiAgICog4pqgIEFORCBUSEUgSE9PSyBXQVMgUkVKRUNURUQgT05DRSwgRk9SIEEgUkVBU09OIFRIQVQgRE9FUyBOT1QgUkVBQ0ggVEhJU1xuICAgKiBDQVNFLiBEMzIncyBub3QtdGFrZW4gYXJndWVkIGFnYWluc3QgXCJhIGBzc2VSZXNwb25zZWAgaG9vayB0aGF0IGhhbmRzIHRoZVxuICAgKiBjYWxsZXIgYSByYXcgYHNlbmRgIOKApiB0aGUgY2FsbGVyIHRoZW4gaGFzIHRvIGtlZXAgaXRzIG93biBjb2xsZWN0aW9uIG9mXG4gICAqIHRoZW1cIiDigJQgYWdhaW5zdCBnbGFtb3VyJ3MgcHJlc2VuY2UgQlJPQURDQVNULCB3aGljaCBwdXNoZXMgdG9cbiAgICogYWxyZWFkeS1vcGVuIHN0cmVhbXMgZnJvbSBvdXRzaWRlIGFuZCBkb2VzIG5lZWQgYSBjb2xsZWN0aW9uLiBUaGlzIGlzIG9uZVxuICAgKiBmcmFtZSwgb24gb25lIHN0cmVhbSwgYXQgb3BlbiwgYW5kIHRoZSBjYWxsZXIga2VlcHMgbm8gY29sbGVjdGlvbiBhdCBhbGwuXG4gICAqIEEgcmVqZWN0aW9uIGlzIHNjb3BlZCB0byB0aGUgY2FzZSB0aGF0IHByb2R1Y2VkIGl0LlxuICAgKi9cbiAgb3BlbkZyYW1lcz86ICgpID0+IHN0cmluZ1tdO1xuICAvKiogUnVuIGFmdGVyIHRoZSBzdHJlYW0gaXMgc3Vic2NyaWJlZCAocHJlc2VuY2UgdXAsIGFjdGl2aXR5IHRvdWNoKS4gKi9cbiAgb25PcGVuPzogKCkgPT4gdm9pZDtcbiAgLyoqIFJ1biBleGFjdGx5IG9uY2UsIGZyb20gd2hpY2hldmVyIHRlYXJkb3duIHBhdGggZmlyZXMgZmlyc3QuICovXG4gIG9uQ2xvc2U/OiAoKSA9PiB2b2lkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3NlUmVzcG9uc2U8VCBleHRlbmRzIG9iamVjdD4ob3B0czogU3NlT3B0aW9uczxUPik6IFJlc3BvbnNlIHtcbiAgY29uc3QgeyBsb2csIHNpbmNlLCBoZWFydGJlYXRNcywgY2xpZW50cywgc2lnbmFsLCBmaWx0ZXIsIG9wZW5GcmFtZXMsIG9uT3Blbiwgb25DbG9zZSB9ID0gb3B0cztcblxuICBsZXQgdW5zdWJzY3JpYmU6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBsZXQga2VlcGFsaXZlOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRJbnRlcnZhbD4gfCBudWxsID0gbnVsbDtcbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICAvLyBUaGUgcmVnaXN0cnkgZW50cnkgZm9yIFRISVMgc3RyZWFtLiBJdHMgbWV0aG9kcyBhcmUgZmlsbGVkIGluIGJ5IGBzdGFydGAsXG4gIC8vIHdoaWNoIGlzIHdoZXJlIHRoZSBjb250cm9sbGVyIGV4aXN0czsgdGhlIG9iamVjdCBpZGVudGl0eSBpcyBzdGFibGUgZnJvbVxuICAvLyBoZXJlIHNvIGB0ZWFyZG93bmAgY2FuIHJlbW92ZSBleGFjdGx5IHRoaXMgZW50cnkuXG4gIGNvbnN0IGNsaWVudDogU3NlQ2xpZW50ID0geyBjbG9zZTogKCkgPT4ge30sIHNlbmQ6ICgpID0+IHt9IH07XG5cbiAgY29uc3QgdGVhcmRvd24gPSAoKSA9PiB7XG4gICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgIGNsb3NlZCA9IHRydWU7XG4gICAgaWYgKGtlZXBhbGl2ZSAhPT0gbnVsbCkgY2xlYXJJbnRlcnZhbChrZWVwYWxpdmUpO1xuICAgIHVuc3Vic2NyaWJlPy4oKTtcbiAgICBjbGllbnRzPy5kZWxldGUoY2xpZW50KTtcbiAgICBvbkNsb3NlPy4oKTtcbiAgfTtcblxuICBjb25zdCBzdHJlYW0gPSBuZXcgUmVhZGFibGVTdHJlYW0oe1xuICAgIHN0YXJ0KGNvbnRyb2xsZXIpIHtcbiAgICAgIGNvbnN0IGVuY29kZXIgPSBuZXcgVGV4dEVuY29kZXIoKTtcbiAgICAgIGNvbnN0IHNhZmVFbnF1ZXVlID0gKGNodW5rOiBzdHJpbmcpID0+IHtcbiAgICAgICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnRyb2xsZXIuZW5xdWV1ZShlbmNvZGVyLmVuY29kZShjaHVuaykpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICB0ZWFyZG93bigpO1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgY2xpZW50LmNsb3NlID0gKCkgPT4ge1xuICAgICAgICB0ZWFyZG93bigpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnRyb2xsZXIuY2xvc2UoKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLyogYWxyZWFkeSBjbG9zZWQgYnkgdGhlIHJ1bnRpbWUgKi9cbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIC8vIOKblCBgc2VuZGAgR09FUyBUSFJPVUdIIGBzYWZlRW5xdWV1ZWAsIHNvIGFuIG91dC1vZi1iYW5kIGZyYW1lIG9iZXlzIHRoZVxuICAgICAgLy8gc2FtZSBjbG9zZWQtY2hlY2sgYW5kIHRoZSBzYW1lIHRlYXJkb3duLW9uLXRocm93IGFzIGEgbG9nZ2VkIG9uZS4gQVxuICAgICAgLy8gZGFlbW9uIG11c3Qgbm90IGJlIGFibGUgdG8gd3JpdGUgdG8gYSBzdHJlYW0gdGhpcyBtb2R1bGUgaGFzIHRvcm4gZG93bi5cbiAgICAgIGNsaWVudC5zZW5kID0gc2FmZUVucXVldWU7XG5cbiAgICAgIC8vIOKblCBBTiBPUEVOSU5HIENPTU1FTlQsIEJFRk9SRSBBTllUSElORyBFTFNFLiBJdCBmbHVzaGVzIHRoZSByZXNwb25zZVxuICAgICAgLy8gaGVhZGVycyBpbW1lZGlhdGVseTogc29tZSBIVFRQIGNsaWVudHMg4oCUIEJ1bidzIG93biBgZmV0Y2goKWAgaW5jbHVkZWQg4oCUXG4gICAgICAvLyBidWZmZXIgdW50aWwgdGhlIGZpcnN0IGJ5dGUgb2YgYm9keSBhcnJpdmVzLCBzbyBhIGdlbnVpbmVseSBxdWlldCBTU0VcbiAgICAgIC8vIHN0cmVhbSB3b3VsZCBvdGhlcndpc2UgbGVhdmUgdGhlIGNhbGxlcidzIGBmZXRjaCgpYCB1bnJlc29sdmVkLiBFdmVyeVxuICAgICAgLy8gaG91c2UgdGFpbCBjbGllbnQgcmVhZHMgYDpgIGxpbmVzIGFzIGNvbW1lbnRzIGFuZCBkcm9wcyB0aGVtLlxuICAgICAgc2FmZUVucXVldWUoXCI6IGNvbm5lY3RlZFxcblxcblwiKTtcblxuICAgICAgLy8g4puUIEJFRk9SRSBUSEUgUkVQTEFZLCBBTkQgVEhFIE9SREVSIElTIFRIRSBXSE9MRSBQT0lOVCDigJQgc2VlXG4gICAgICAvLyBgb3BlbkZyYW1lc2AgaW4gdGhlIG9wdGlvbnMgYWJvdmUuIEEgZ3JvdW5kaW5nIGZyYW1lIHdyaXR0ZW4gaGVyZSBpc1xuICAgICAgLy8gdGhlIHN0cmVhbSdzIGZpcnN0IGRhdGEgbGluZTsgd3JpdHRlbiBmcm9tIGBvbk9wZW5gIGl0IGFycml2ZXMgYWZ0ZXJcbiAgICAgIC8vIHRoZSByZXBsYXllZCBiYWNrbG9nLCB3aGljaCBpcyBhIGRpZmZlcmVudCBjb250cmFjdCB3ZWFyaW5nIHRoZSBzYW1lXG4gICAgICAvLyB0eXBlcy5cbiAgICAgIGlmIChvcGVuRnJhbWVzKSBmb3IgKGNvbnN0IGNodW5rIG9mIG9wZW5GcmFtZXMoKSkgc2FmZUVucXVldWUoY2h1bmspO1xuXG4gICAgICB1bnN1YnNjcmliZSA9IGxvZy5zdWJzY3JpYmUoc2luY2UsIChmcmFtZSkgPT4ge1xuICAgICAgICBpZiAoZmlsdGVyICYmICFmaWx0ZXIoZnJhbWUpKSByZXR1cm47XG4gICAgICAgIHNhZmVFbnF1ZXVlKGBkYXRhOiAke0pTT04uc3RyaW5naWZ5KGZyYW1lKX1cXG5cXG5gKTtcbiAgICAgIH0pO1xuXG4gICAgICBrZWVwYWxpdmUgPSBzZXRJbnRlcnZhbCgoKSA9PiBzYWZlRW5xdWV1ZShcIjogaGJcXG5cXG5cIiksIGhlYXJ0YmVhdE1zKTtcbiAgICAgIHNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIHRlYXJkb3duLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICBjbGllbnRzPy5hZGQoY2xpZW50KTtcbiAgICAgIG9uT3Blbj8uKCk7XG4gICAgfSxcbiAgICBjYW5jZWwoKSB7XG4gICAgICB0ZWFyZG93bigpO1xuICAgIH0sXG4gIH0pO1xuXG4gIHJldHVybiBuZXcgUmVzcG9uc2Uoc3RyZWFtLCB7XG4gICAgaGVhZGVyczoge1xuICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJ0ZXh0L2V2ZW50LXN0cmVhbVwiLFxuICAgICAgXCJDYWNoZS1Db250cm9sXCI6IFwibm8tY2FjaGVcIixcbiAgICAgIENvbm5lY3Rpb246IFwia2VlcC1hbGl2ZVwiLFxuICAgIH0sXG4gIH0pO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKlxuICogVGhlIHNtYWxsZXN0IGJlYXQgdGhpcyBtb2R1bGUgd2lsbCBoYW5kIGJhY2ssIGluIG1zIOKAlCB0aGUgRkxPT1IgaGFsZiBvZiB0aGVcbiAqIGNsYW1wIHdob3NlIGNlaWxpbmcgaXMgYGlkbGVUaW1lb3V0IC8gMmAuXG4gKlxuICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBpbnRPcmAgUEFSU0VTIFdJVEggYHBhcnNlSW50YCwgQU5EIGBwYXJzZUludGAgSVMgTEVOSUVOVFxuICogV0hFUkUgSVQgTUFUVEVSUyBNT1NULiBgaW50T3JgIGZhbGxzIGJhY2sgc2FmZWx5IG9uIGV2ZXJ5dGhpbmcgdGhhdCBMT09LU1xuICogaG9zdGlsZSDigJQgYFwiXCJgLCBgXCIwXCJgLCBgXCItMVwiYCwgYFwiYWJjXCJgLCBgXCJOYU5cImAsIGBcIkluZmluaXR5XCJgIGFsbCB0YWtlIHRoZVxuICogZmFsbGJhY2sg4oCUIGFuZCB0aGVuIHJlYWRzIGBcIjFlOVwiYCwgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdFxuICogaHVnZVwiLCBhcyAqKjEqKi4gTUVBU1VSRUQgYXQgZ3JhcGV2aW5lJ3MgUGhhc2UgNiByZXBhaXIsIGJlZm9yZSB0aGlzIGZsb29yOlxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRVxuICogY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIGdpdmVzIDMgbXMgYW5kIGBcIjVhYmNcImAgZ2l2ZXMgNSBtcyB0aGUgc2FtZSB3YXkuXG4gKiBBIGtub2Igd2hvc2UgZmFzdGVzdCBzZXR0aW5nIGlzIHNwZWxsZWQgbGlrZSBpdHMgc2xvd2VzdCBpcyBhIGZsb29kLlxuICpcbiAqIOKaoCAqKlRIRSBGTE9PUiBJUyBIRVJFIEFORCBOT1QgSU4gYGludE9yYCDigJQgdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW5cbiAqIGFjY2lkZW50IG9mIHdoZXJlIGl0IHdhcyBlYXN5IHRvIHdyaXRlKiogKEQ3NikuIGBpbnRPcmAgaXMgdGhlIGdlbmVyYWwgcGFyc2VyXG4gKiBiZWhpbmQgZXZlcnkgZW52IGtub2IgaW4gdGhlIGtpdDsgdGhlcmUgaXMgbm8gc2luZ2xlIHJvc3Rlci1jb3JyZWN0IG1pbmltdW1cbiAqIGZvciBcImEgcG9zaXRpdmUgaW50ZWdlclwiLCBhbmQgdGlnaHRlbmluZyBpdHMgUEFSU0UgKHJlamVjdGluZyBgMWU5YCBvdXRyaWdodClcbiAqIHdvdWxkIGNoYW5nZSB3aGF0IGV2ZXJ5IG90aGVyIGtub2IgYWNjZXB0cywgc2lsZW50bHksIGZvciB2YWx1ZXMgbm9ib2R5IGhhc1xuICogYXVkaXRlZC4gYGhlYXJ0YmVhdE1zYCBhbHJlYWR5IG93bnMgb25lIGVuZCBvZiB0aGlzIGludmFyaWFudCwgYW5kIDUwMCB3YXNcbiAqIGFscmVhZHkgd3JpdHRlbiBpbnRvIGl0IGFzIHRoZSBzbWFsbGVzdCBjZWlsaW5nIGl0IHdvdWxkIGNvbXB1dGUuIFRoZSBmbG9vclxuICogYmVsb25ncyBiZXNpZGUgdGhlIGNlaWxpbmcsIHdoZXJlIHRoZSBxdWFudGl0eSBpcyBrbm93bi5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JTl9IRUFSVEJFQVRfTVMgPSA1MDA7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiDimqAgYHBhcnNlSW50YCBzZW1hbnRpY3M6IGBcIjFlOVwiYFxuICogIGlzIDEgYW5kIGBcIjVhYmNcImAgaXMgNS4gQW55IGNhbGxlciB3aXRoIGEga25vd24gc2FmZSBtaW5pbXVtIG11c3QgY2xhbXAg4oCUXG4gKiAgc2VlIGBNSU5fSEVBUlRCRUFUX01TYC4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIEFUIEJPVEggRU5EUzogbmV2ZXIgYWJvdmUgaGFsZiB0aGUgaWRsZVxuICogdGltZW91dCwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIFRoZSBjZWlsaW5nIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6XG4gKiB0aGUgb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKlxuICog4pqgIFRoZSBmbG9vciBjYW5ub3QgZmlnaHQgdGhlIGNlaWxpbmc6IHRoZSBjZWlsaW5nIGV4cHJlc3Npb24gaXMgaXRzZWxmXG4gKiBgTWF0aC5tYXgoNTAwLCDigKYpYCwgc28gaXQgaXMgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgIGFuZCB0aGUgdHdvXG4gKiBjbGFtcHMgY2FuIG5ldmVyIGNyb3NzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICBjb25zdCBjZWlsaW5nID0gTWF0aC5tYXgoTUlOX0hFQVJUQkVBVF9NUywgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgoaW50T3IocmF3LCBmYWxsYmFjayksIE1JTl9IRUFSVEJFQVRfTVMpLCBjZWlsaW5nKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogR2xhbW91cidzIGNvbm5lY3Rpb24tdGltaW5nIGNvbnN0YW50cyDigJQgVEhFIE9ORSBDT1BZLCBpbXBvcnRlZCBieSBib3RoIGhhbHZlc1xuICogb2YgdGhlIHNwZWxsLlxuICpcbiAqIOKblCBUSElTIEZJTEUgSVMgVEhFIFNFQU0uIEJlZm9yZSBQaGFzZSAyIHRoZSBoZWFydGJlYXQgd2FzIGEgTElURVJBTCBgMTUwMDBgXG4gKiBpbnNpZGUgYHNlcnZlci50c2AncyBgc3NlUmVzcG9uc2VgLCBhbmQgYGNsaS50c2AgaGFkIE5PIGNvcnJlc3BvbmRpbmcgbnVtYmVyXG4gKiBhdCBhbGwg4oCUIGl0cyB0YWlsIGxvb3Agc2ltcGx5IGJsb2NrZWQgb24gYHJlYWRlci5yZWFkKClgIGZvcmV2ZXIsIHdoaWNoIGlzIHRoZVxuICogZmFpbHVyZSBgdGFpbEV2ZW50c2AncyB3YXRjaGRvZyBleGlzdHMgdG8gZW5kLiBOZWl0aGVyIGZpbGUgY291bGQgaW1wb3J0IHRoZVxuICogb3RoZXI6IHRoZSBDTEkgcmVhY2hpbmcgaW50byB0aGUgZGFlbW9uIHdvdWxkIGRyYWcgdGhlIHdob2xlIHNlcnZlciBncmFwaCBpbnRvXG4gKiBgZGlzdC9jbGkuanNgLiBBIG1vZHVsZSB3aXRoIG5vIGltcG9ydHMgYnV0IHRoZSBraXQncyBkZXJpdmF0aW9ucyBoYXMgbm8gc3VjaFxuICogZ3JhcGgsIHNvIGJvdGggaGFsdmVzIGltcG9ydCB0aGlzIG9uZS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFdBVENIRE9HIElTIERFUklWRUQgRlJPTSBHTEFNT1VSJ1MgT1dOIEhFQVJUQkVBVCwgTkVWRVIgQ09QSUVEXG4gKiBGUk9NIEEgU0lCTElORy4qKiBUaGlzIGlzIFBoYXNlIDFhJ3MgcnVsZSBhbmQgaXQgaXMgdGhlIHdob2xlIHJlYXNvbiB0aGUgZmlsZVxuICogZXhpc3RzIHJhdGhlciB0aGFuIGEgc2hhcmVkIGNvbnN0YW50IHNvbWV3aGVyZTogYXN0cm9sYWJlIGJlYXRzIGF0IDEwIHMgYW5kXG4gKiBtYWdwaWUgYXQgMTUgcywgc28gYSBoYXJkLWNvZGVkIHdhdGNoZG9nIGlzIGNvcnJlY3QgZm9yIGF0IG1vc3Qgb25lIG9mIHRoZW0uXG4gKiBBc3Ryb2xhYmUgbWVhc3VyZWQgd2hhdCBhIGNvcGllZCBudW1iZXIgZG9lcyDigJQgYSA0NSBzIHdhdGNoZG9nIGFnYWluc3QgYW5cbiAqIGVudi10dW5lZCBoZWFydGJlYXQgcHJvZHVjZWQgcmVjb25uZWN0cyBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3Ljkgc1xuICogYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbiwgaGFybWxlc3Mgb25seSBiZWNhdXNlIGFuIHVucmVsYXRlZCB0aGlyZFxuICogY29uc3RhbnQgYWJzb3JiZWQgdGhlIGNodXJuLiBgdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKWAgY2Fubm90IGRyaWZ0IGZyb21cbiAqIHRoZSBiZWF0IGl0IGlzIHdhdGNoaW5nLCB3aGF0ZXZlciB0aGUgYmVhdCBiZWNvbWVzLlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgdGhlIENMSSBpcyBiYWNrIHRvIGRyYWdnaW5nIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqL1xuXG5pbXBvcnQge1xuICBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4gIHRhaWxJZGxlTXMsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9oZWFydGJlYXQudHNcIjtcblxuLyoqXG4gKiBCdW4ncyBtYXhpbXVtLiBUaGlzIGlzIGdsYW1vdXIncyBvd24gbWVhc3VyZWQgdmFsdWUsIG5vdCBhbiBpbmhlcml0ZWQgb25lOlxuICogYHNlcnZlci50c2AgY2FycmllZCBgaWRsZVRpbWVvdXQ6IDI1NWAgd2l0aCBhIGNvbW1lbnQgcmVjb3JkaW5nIHRoYXQgQnVuJ3NcbiAqIGRlZmF1bHQgMTAgcyBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZSB0aGUgMTUgcyBrZWVwYWxpdmUgZXZlclxuICogZmlyZXMuIEdsYW1vdXIgZG9lcyBub3QgZW52LXR1bmUgaXQg4oCUIGEgc2Vzc2lvbiBkYWVtb24ncyBjb25uZWN0aW9uIGxpZmV0aW1lXG4gKiBpcyBub3Qgc29tZXRoaW5nIGEgY2FsbGVyIGhhcyBldmVyIG5lZWRlZCB0byBzaG9ydGVuLlxuICovXG5leHBvcnQgY29uc3QgSURMRV9USU1FT1VUX1NFQyA9IE1BWF9JRExFX1RJTUVPVVRfU0VDO1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQsIGFuZCBnbGFtb3VyJ3Mgb3duIGxpdGVyYWwgYmVmb3JlIHRoaXMgZmlsZSBleGlzdGVkLiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBERUZBVUxUX0hFQVJUQkVBVF9NUztcblxuLyoqXG4gKiBUaGUgdGFpbCB3YXRjaGRvZzogdGhyZWUgbWlzc2VkIGJlYXRzLCBERVJJVkVELlxuICpcbiAqIOKaoCA0NSwwMDAgbXMgdG9kYXksIHdoaWNoIGlzIHRoZSBzYW1lIG51bWJlciBgY21kT3BlbmAncyBgLS1zdGFydC10aW1lb3V0YFxuICogZGVmYXVsdCBoYXBwZW5zIHRvIGJlLiBUaGV5IGFyZSBVTlJFTEFURUQg4oCUIG9uZSBib3VuZHMgYSBmaXJzdCBidW5kbGUgYnVpbGQsXG4gKiB0aGUgb3RoZXIgYm91bmRzIGEgc2lsZW50IHNvY2tldCDigJQgYW5kIHRoZSBjb2luY2lkZW5jZSBpcyBuYW1lZCBoZXJlIHNvIG5vYm9keVxuICogbGF0ZXIgXCJkZS1kdXBsaWNhdGVzXCIgdGhlbSBpbnRvIG9uZSBjb25zdGFudC5cbiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUyk7XG4iLAogICAgImltcG9ydCB7IG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQge1xuICBkZWZhdWx0U3RhdGUsXG4gIHR5cGUgR2xhbW91clN0YXRlLFxuICB0eXBlIExpYnJhcnlJdGVtLFxufSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dsYW1vdXIvc2hhcmVkL3R5cGVzXCI7XG5cbmNvbnN0IEVYVF9CWV9NSU1FOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcImltYWdlL3dlYnBcIjogXCJ3ZWJwXCIsXG4gIFwiaW1hZ2UvcG5nXCI6IFwicG5nXCIsXG4gIFwiaW1hZ2UvanBlZ1wiOiBcImpwZ1wiLFxuICBcImltYWdlL2dpZlwiOiBcImdpZlwiLFxufTtcblxuZXhwb3J0IGZ1bmN0aW9uIHNhdmVEYXRhVXJsKGRpcjogc3RyaW5nLCBpZDogc3RyaW5nLCBkYXRhVXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBtID0gL15kYXRhOihbXjssXSspPyg7YmFzZTY0KT8sKC4qKSQvcy5leGVjKGRhdGFVcmwpO1xuICBpZiAoIW0gfHwgIWRpcikgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IG1pbWUgPSAobVsxXSA/PyBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiKS50b0xvd2VyQ2FzZSgpO1xuICBjb25zdCBib2R5ID0gbVszXTtcbiAgY29uc3QgYnVmID0gbVsyXSA/IEJ1ZmZlci5mcm9tKGJvZHksIFwiYmFzZTY0XCIpIDogQnVmZmVyLmZyb20oZGVjb2RlVVJJQ29tcG9uZW50KGJvZHkpLCBcInV0ZjhcIik7XG4gIGNvbnN0IGV4dCA9IEVYVF9CWV9NSU1FW21pbWVdID8/IFwiYmluXCI7XG4gIGNvbnN0IHNhZmVJZCA9IGlkLnJlcGxhY2UoL1teYS16QS1aMC05Xy1dL2csIFwiX1wiKTtcbiAgY29uc3QgcGF0aCA9IGpvaW4oZGlyLCBgJHtzYWZlSWR9LiR7ZXh0fWApO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMocGF0aCwgYnVmKTtcbiAgICByZXR1cm4gcGF0aDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFwiXCI7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNhdmVUZXh0KGRpcjogc3RyaW5nLCBpZDogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHNhZmUgPSBuYW1lLnJlcGxhY2UoL1teYS16QS1aMC05Ll8tXS9nLCBcIl9cIikgfHwgYCR7aWR9Lm1kYDtcbiAgY29uc3QgcGF0aCA9IGpvaW4oZGlyLCBgJHtpZH0tJHtzYWZlfWApO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMocGF0aCwgdGV4dCwgXCJ1dGY4XCIpO1xuICAgIHJldHVybiBwYXRoO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gXCJcIjtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF0ZXJpYWxpemVJdGVtKGZpbGVzRGlyOiBzdHJpbmcsIGl0ZW06IExpYnJhcnlJdGVtKTogdm9pZCB7XG4gIGlmIChpdGVtLnNyYykge1xuICAgIGNvbnN0IHAgPSBzYXZlRGF0YVVybChmaWxlc0RpciwgaXRlbS5pZCwgaXRlbS5zcmMpO1xuICAgIGlmIChwKSBpdGVtLnBhdGggPSBwO1xuICB9IGVsc2UgaWYgKGl0ZW0udGV4dCkge1xuICAgIGNvbnN0IHAgPSBzYXZlVGV4dChmaWxlc0RpciwgaXRlbS5pZCwgaXRlbS50aXRsZSwgaXRlbS50ZXh0KTtcbiAgICBpZiAocCkgaXRlbS5wYXRoID0gcDtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gc2F2ZVNuYXBzaG90KHNuYXBzaG90c0Rpcjogc3RyaW5nLCBzZXNzaW9uSWQ6IHN0cmluZywgc3RhdGU6IEdsYW1vdXJTdGF0ZSk6IHZvaWQge1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhzbmFwc2hvdHNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihzbmFwc2hvdHNEaXIsIGAke3Nlc3Npb25JZH0uanNvbmApLCBKU09OLnN0cmluZ2lmeShzdGF0ZSkpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBwZXJzaXN0ZW5jZSBpcyBiZXN0LWVmZm9ydCAqL1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsb2FkU25hcHNob3QocGF0aDogc3RyaW5nLCB0aXRsZTogc3RyaW5nLCBpbnRlbnQ6IHN0cmluZyk6IEdsYW1vdXJTdGF0ZSB7XG4gIGNvbnN0IHNuYXAgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpIGFzIFBhcnRpYWw8R2xhbW91clN0YXRlPjtcbiAgLy8gTWVyZ2Ugb3ZlciBkZWZhdWx0cyBzbyBvbGRlciBzbmFwc2hvdHMgZ2FpbiBuZXcgdG9wLWxldmVsIGZpZWxkcy5cbiAgY29uc3QgbWVyZ2VkID0geyAuLi5kZWZhdWx0U3RhdGUodGl0bGUsIGludGVudCksIC4uLnNuYXAgfSBhcyBHbGFtb3VyU3RhdGU7XG4gIC8vIE5vcm1hbGl6ZSBzdHlsZS1ndWlkZSBzZWN0aW9ucyBzbyBzbmFwc2hvdHMgcHJlZGF0aW5nIG5ld2VyIHBlci1zZWN0aW9uXG4gIC8vIGZpZWxkcyAocHJvbXB0cywgY29sb3JzKSBzdGlsbCBzYXRpc2Z5IHRoZSBjdXJyZW50IHNoYXBlLlxuICBtZXJnZWQuc3R5bGVHdWlkZSA9IG1lcmdlZC5zdHlsZUd1aWRlLm1hcCgocykgPT4gKHtcbiAgICAuLi5zLFxuICAgIHByb21wdHM6IHMucHJvbXB0cyA/PyBbXSxcbiAgICBjb2xvcnM6IHMuY29sb3JzID8/IFtdLFxuICB9KSk7XG4gIHJldHVybiBtZXJnZWQ7XG59XG4iLAogICAgImltcG9ydCB0eXBlIHtcbiAgQWdlbnRDb21tYW5kLFxuICBDYW5vbkltZyxcbiAgR2VuTWV0YSxcbiAgR2xhbW91clN0YXRlLFxuICBJdGVtS2luZCxcbiAgTGVhbkl0ZW0sXG4gIExlYW5TdGF0ZSxcbiAgTGlicmFyeUl0ZW0sXG4gIE1lc3NhZ2UsXG4gIFNhdmVkU3R5bGUsXG4gIFNlY3Rpb25LZXksXG4gIFNlY3Rpb25TdGF0dXMsXG4gIFN3YXRjaCxcbn0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9nbGFtb3VyL3NoYXJlZC90eXBlc1wiO1xuXG5leHBvcnQgZnVuY3Rpb24gbWFrZUl0ZW0ocDoge1xuICBpZDogc3RyaW5nO1xuICBraW5kOiBJdGVtS2luZDtcbiAgdGl0bGU6IHN0cmluZztcbiAgc3JjPzogc3RyaW5nO1xuICBwYXRoPzogc3RyaW5nO1xuICB0ZXh0Pzogc3RyaW5nO1xuICBtaW1lPzogc3RyaW5nO1xuICB0YWdzPzogc3RyaW5nW107XG4gIGNyZWF0ZWRBdDogbnVtYmVyO1xuICBnZW4/OiBHZW5NZXRhIHwgbnVsbDtcbn0pOiBMaWJyYXJ5SXRlbSB7XG4gIHJldHVybiB7XG4gICAgaWQ6IHAuaWQsXG4gICAga2luZDogcC5raW5kLFxuICAgIHRpdGxlOiBwLnRpdGxlLFxuICAgIHNyYzogcC5zcmMgPz8gXCJcIixcbiAgICBwYXRoOiBwLnBhdGggPz8gXCJcIixcbiAgICB0ZXh0OiBwLnRleHQgPz8gXCJcIixcbiAgICBtaW1lOiBwLm1pbWUgPz8gXCJcIixcbiAgICB0YWdzOiBwLnRhZ3MgPz8gW10sXG4gICAgc3RhcnJlZDogZmFsc2UsXG4gICAgbGlrZWQ6IGZhbHNlLFxuICAgIGFubm90YXRpb25zOiB7IGFnZW50OiBcIlwiLCBodW1hbjogXCJcIiB9LFxuICAgIGNhbm9uaWNhbDogZmFsc2UsXG4gICAgY2Fub246IFtdLFxuICAgIGFyY2hpdmVkOiBmYWxzZSxcbiAgICBjcmVhdGVkQXQ6IHAuY3JlYXRlZEF0LFxuICAgIGdlbjogcC5nZW4gPz8gbnVsbCxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZEl0ZW0oc3RhdGU6IEdsYW1vdXJTdGF0ZSwgaXRlbTogTGlicmFyeUl0ZW0pOiBib29sZWFuIHtcbiAgaWYgKHN0YXRlLmxpYnJhcnkuc29tZSgoaSkgPT4gaS5pZCA9PT0gaXRlbS5pZCkpIHJldHVybiBmYWxzZTtcbiAgc3RhdGUubGlicmFyeS5wdXNoKGl0ZW0pO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNlbGVjdEl0ZW1zKHN0YXRlOiBHbGFtb3VyU3RhdGUsIGlkczogc3RyaW5nW10pOiB2b2lkIHtcbiAgc3RhdGUuc2VsZWN0ZWRJZHMgPSBbLi4uaWRzXTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldFN0YXIoc3RhdGU6IEdsYW1vdXJTdGF0ZSwgaWQ6IHN0cmluZywgc3RhcnJlZDogYm9vbGVhbik6IGJvb2xlYW4ge1xuICBjb25zdCBpdCA9IHN0YXRlLmxpYnJhcnkuZmluZCgoaSkgPT4gaS5pZCA9PT0gaWQpO1xuICBpZiAoIWl0KSByZXR1cm4gZmFsc2U7XG4gIGl0LnN0YXJyZWQgPSBzdGFycmVkO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldExpa2Uoc3RhdGU6IEdsYW1vdXJTdGF0ZSwgaWQ6IHN0cmluZywgbGlrZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3QgaXQgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKGkpID0+IGkuaWQgPT09IGlkKTtcbiAgaWYgKCFpdCkgcmV0dXJuIGZhbHNlO1xuICBpdC5saWtlZCA9IGxpa2VkO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFubm90YXRlKFxuICBzdGF0ZTogR2xhbW91clN0YXRlLFxuICBpZDogc3RyaW5nLFxuICB3aG86IFwiYWdlbnRcIiB8IFwiaHVtYW5cIixcbiAgdGV4dDogc3RyaW5nLFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGl0ID0gc3RhdGUubGlicmFyeS5maW5kKChpKSA9PiBpLmlkID09PSBpZCk7XG4gIGlmICghaXQpIHJldHVybiBmYWxzZTtcbiAgaXQuYW5ub3RhdGlvbnNbd2hvXSA9IHRleHQ7XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkTWVzc2FnZShzdGF0ZTogR2xhbW91clN0YXRlLCBtOiBNZXNzYWdlKTogdm9pZCB7XG4gIHN0YXRlLm1lc3NhZ2VzLnB1c2gobSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVTZWN0aW9uKFxuICBzdGF0ZTogR2xhbW91clN0YXRlLFxuICBrZXk6IFNlY3Rpb25LZXksXG4gIHBhdGNoOiB7IGNvbnRlbnQ/OiBzdHJpbmc7IHN0YXR1cz86IFNlY3Rpb25TdGF0dXM7IHByb21wdHM/OiBzdHJpbmdbXTsgY29sb3JzPzogU3dhdGNoW10gfSxcbik6IGJvb2xlYW4ge1xuICBjb25zdCBzZWMgPSBzdGF0ZS5zdHlsZUd1aWRlLmZpbmQoKHMpID0+IHMua2V5ID09PSBrZXkpO1xuICBpZiAoIXNlYykgcmV0dXJuIGZhbHNlO1xuICBpZiAocGF0Y2guY29udGVudCAhPT0gdW5kZWZpbmVkKSBzZWMuY29udGVudCA9IHBhdGNoLmNvbnRlbnQ7XG4gIGlmIChwYXRjaC5zdGF0dXMgIT09IHVuZGVmaW5lZCkgc2VjLnN0YXR1cyA9IHBhdGNoLnN0YXR1cztcbiAgaWYgKHBhdGNoLnByb21wdHMgIT09IHVuZGVmaW5lZCkgc2VjLnByb21wdHMgPSBwYXRjaC5wcm9tcHRzO1xuICBpZiAocGF0Y2guY29sb3JzICE9PSB1bmRlZmluZWQpIHNlYy5jb2xvcnMgPSBwYXRjaC5jb2xvcnM7XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0Rm9jdXMoXG4gIHN0YXRlOiBHbGFtb3VyU3RhdGUsXG4gIGlkczogc3RyaW5nW10sXG4gIG93bmVyOiBcInlvdVwiIHwgXCJhZ2VudFwiLFxuICBub3RlID0gXCJcIixcbik6IHZvaWQge1xuICBzdGF0ZS5zY29wZSA9IFwiZm9jdXNcIjtcbiAgc3RhdGUuZm9jdXNTZXQgPSBbLi4uaWRzXTtcbiAgc3RhdGUuZm9jdXNPd25lciA9IG93bmVyO1xuICBzdGF0ZS5mb2N1c05vdGUgPSBub3RlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2xlYXJGb2N1cyhzdGF0ZTogR2xhbW91clN0YXRlKTogdm9pZCB7XG4gIHN0YXRlLnNjb3BlID0gXCJhbGxcIjtcbiAgc3RhdGUuZm9jdXNTZXQgPSBbXTtcbiAgc3RhdGUuZm9jdXNPd25lciA9IG51bGw7XG4gIHN0YXRlLmZvY3VzTm90ZSA9IFwiXCI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRDYW5vbmljYWwoc3RhdGU6IEdsYW1vdXJTdGF0ZSwgaWQ6IHN0cmluZywgY2Fub25pY2FsOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGl0ID0gc3RhdGUubGlicmFyeS5maW5kKChpKSA9PiBpLmlkID09PSBpZCk7XG4gIGlmICghaXQpIHJldHVybiBmYWxzZTtcbiAgaXQuY2Fub25pY2FsID0gY2Fub25pY2FsO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFyY2hpdmVUcmF5U3R5bGUoc3RhdGU6IEdsYW1vdXJTdGF0ZSwgaWQ6IHN0cmluZywgYXJjaGl2ZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3Qgc3QgPSBzdGF0ZS50cmF5LmZpbmQoKHMpID0+IHMuaWQgPT09IGlkKTtcbiAgaWYgKCFzdCkgcmV0dXJuIGZhbHNlO1xuICBzdC5hcmNoaXZlZCA9IGFyY2hpdmVkO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkU3R5bGVJdGVtKFxuICBzdHlsZTogU2F2ZWRTdHlsZSxcbiAgY2Fub246IENhbm9uSW1nW10sXG4gIGNyZWF0ZWRBdDogbnVtYmVyLFxuKTogTGlicmFyeUl0ZW0ge1xuICByZXR1cm4ge1xuICAgIGlkOiBgc3R5bGUtJHtzdHlsZS5pZH1gLFxuICAgIGtpbmQ6IFwic3R5bGVcIixcbiAgICB0aXRsZTogc3R5bGUubGFiZWwsXG4gICAgc3JjOiBcIlwiLFxuICAgIHBhdGg6IFwiXCIsXG4gICAgdGV4dDogc3R5bGUudGV4dCxcbiAgICBtaW1lOiBcIlwiLFxuICAgIHRhZ3M6IFtdLFxuICAgIHN0YXJyZWQ6IGZhbHNlLFxuICAgIGxpa2VkOiBmYWxzZSxcbiAgICBhbm5vdGF0aW9uczogeyBhZ2VudDogXCJcIiwgaHVtYW46IFwiXCIgfSxcbiAgICBjYW5vbmljYWw6IGZhbHNlLFxuICAgIGNhbm9uLFxuICAgIGFyY2hpdmVkOiBmYWxzZSxcbiAgICBjcmVhdGVkQXQsXG4gICAgZ2VuOiBudWxsLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0SXRlbUFyY2hpdmVkKHN0YXRlOiBHbGFtb3VyU3RhdGUsIGlkOiBzdHJpbmcsIGFyY2hpdmVkOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGl0ID0gc3RhdGUubGlicmFyeS5maW5kKChpKSA9PiBpLmlkID09PSBpZCk7XG4gIGlmICghaXQpIHJldHVybiBmYWxzZTtcbiAgaXQuYXJjaGl2ZWQgPSBhcmNoaXZlZDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRHZW5Db3N0KHN0YXRlOiBHbGFtb3VyU3RhdGUsIGlkOiBzdHJpbmcsIGNvc3Q6IG51bWJlcik6IGJvb2xlYW4ge1xuICBjb25zdCBpdCA9IHN0YXRlLmxpYnJhcnkuZmluZCgoaSkgPT4gaS5pZCA9PT0gaWQpO1xuICBpZiAoIWl0Py5nZW4pIHJldHVybiBmYWxzZTtcbiAgaXQuZ2VuLmNvc3QgPSBjb3N0O1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8gQmFja2ZpbGwgdGhlIHJlYWwgcHJvbXB0IGFuZC9vciByZWZzIG9udG8gYSBnZW4gYWZ0ZXIgdGhlIGZhY3QsIHNvIGl0cyBzdG9yZWRcbi8vIG1ldGFkYXRhIGlzIHRoZSByZXByb2R1Y2libGUgcHJvbXB0IChub3QgYSBsYWJlbCkg4oCUIG5vIHNlc3Npb24gYm91bmNlIG5lZWRlZC5cbmV4cG9ydCBmdW5jdGlvbiBzZXRHZW5NZXRhKFxuICBzdGF0ZTogR2xhbW91clN0YXRlLFxuICBpZDogc3RyaW5nLFxuICBwYXRjaDogeyBwcm9tcHQ/OiBzdHJpbmc7IGN1c3RvbT86IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfSxcbik6IGJvb2xlYW4ge1xuICBjb25zdCBpdCA9IHN0YXRlLmxpYnJhcnkuZmluZCgoaSkgPT4gaS5pZCA9PT0gaWQpO1xuICBpZiAoIWl0Py5nZW4pIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiBwYXRjaC5wcm9tcHQgPT09IFwic3RyaW5nXCIpIGl0Lmdlbi5wcm9tcHQgPSBwYXRjaC5wcm9tcHQ7XG4gIGlmIChwYXRjaC5jdXN0b20pIGl0Lmdlbi5jdXN0b20gPSB7IC4uLihpdC5nZW4uY3VzdG9tID8/IHt9KSwgLi4ucGF0Y2guY3VzdG9tIH07XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbGVhbkl0ZW0oaXQ6IExpYnJhcnlJdGVtKTogTGVhbkl0ZW0ge1xuICBjb25zdCB7IHNyYzogX3MsIHRleHQ6IF90LCBjYW5vbjogX2MsIC4uLnJlc3QgfSA9IGl0O1xuICByZXR1cm4gcmVzdDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxlYW5TdGF0ZShzOiBHbGFtb3VyU3RhdGUpOiBMZWFuU3RhdGUge1xuICByZXR1cm4geyAuLi5zLCBsaWJyYXJ5OiBzLmxpYnJhcnkubWFwKGxlYW5JdGVtKSB9O1xufVxuXG4vLyBCb2FyZCBtb3ZlcyB0aGF0IG11dGF0ZSBzdGF0ZSArIGJyb2FkY2FzdCBidXQgZW1pdCBOTyBhZ2VudCBldmVudC5cbmV4cG9ydCBjb25zdCBBTUJJRU5UX0NMSUVOVCA9IG5ldyBTZXQ8c3RyaW5nPihbXG4gIFwiaXRlbS5zZWxlY3RcIixcbiAgXCJpdGVtLnN0YXJcIixcbiAgXCJpdGVtLmxpa2VcIixcbiAgXCJmb2N1cy5zZXRcIixcbiAgXCJmb2N1cy5jbGVhclwiLFxuICBcIml0ZW0uY2Fub25pY2FsXCIsXG4gIFwiaXRlbS5hcmNoaXZlXCIsXG4gIFwiaXRlbS5hbm5vdGF0ZVwiLCAvLyBhIHBlci1pdGVtIG5vdGU6IHN0b3JlZCArIHJlYWQgb24gZGVtYW5kLCBub3QgcHVzaGVkIGFzIGFuIGV2ZW50XG5dKTtcbmV4cG9ydCBmdW5jdGlvbiBpc0ltcGVyYXRpdmUodHlwZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiAhQU1CSUVOVF9DTElFTlQuaGFzKHR5cGUpO1xufVxuXG4vLyBSZXR1cm5zIHdoZXRoZXIgdGhlIGNvbW1hbmQgdHlwZSB3YXMgUkVDT0dOSVNFRCDigJQgdGhlIHZlcmRpY3QgdGhlIC9jbWQgcm91dGVcbi8vIHByb3BhZ2F0ZXMgKCM4NCkuIFJlY29nbmlzZWQtYW5kLWFwcGxpZWQgaXMgYHRydWVgOyBhbiB1bmtub3duIHR5cGUgaXNcbi8vIGBmYWxzZWAuIFRoaXMgaXMgZGVsaWJlcmF0ZWx5IG5vdCBcImRpZCBzdGF0ZSBjaGFuZ2VcIjogYSByZWNvZ25pc2VkIGNvbW1hbmRcbi8vIHRoYXQgaXMgYSBsZWdpdGltYXRlIG5vLW9wIHN0aWxsIGFwcGxpZWQuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlBZ2VudE1zZyhzdGF0ZTogR2xhbW91clN0YXRlLCBtc2c6IEFnZW50Q29tbWFuZCk6IGJvb2xlYW4ge1xuICBzd2l0Y2ggKG1zZy50eXBlKSB7XG4gICAgY2FzZSBcImluaXRcIjpcbiAgICAgIGlmICh0eXBlb2YgbXNnLnRpdGxlID09PSBcInN0cmluZ1wiKSBzdGF0ZS50aXRsZSA9IG1zZy50aXRsZTtcbiAgICAgIGlmICh0eXBlb2YgbXNnLmludGVudCA9PT0gXCJzdHJpbmdcIikgc3RhdGUuaW50ZW50ID0gbXNnLmludGVudDtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJpbnRlbnRcIjpcbiAgICAgIHN0YXRlLmludGVudCA9IG1zZy50ZXh0O1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcIml0ZW0uYW5ub3RhdGVcIjoge1xuICAgICAgY29uc3QgaXQgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKGkpID0+IGkuaWQgPT09IG1zZy5pZCk7XG4gICAgICBpZiAoaXQpIGl0LmFubm90YXRpb25zLmFnZW50ID0gbXNnLmFnZW50O1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJzZWN0aW9uXCI6XG4gICAgICB1cGRhdGVTZWN0aW9uKHN0YXRlLCBtc2cua2V5LCB7XG4gICAgICAgIGNvbnRlbnQ6IG1zZy5jb250ZW50LFxuICAgICAgICBzdGF0dXM6IG1zZy5zdGF0dXMsXG4gICAgICAgIHByb21wdHM6IG1zZy5wcm9tcHRzLFxuICAgICAgICBjb2xvcnM6IG1zZy5jb2xvcnMsXG4gICAgICB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJmb2N1cy5wdXNoXCI6XG4gICAgICBzZXRGb2N1cyhzdGF0ZSwgbXNnLmlkcywgXCJhZ2VudFwiLCBtc2cubm90ZSA/PyBcIlwiKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJnZW4uY29zdFwiOlxuICAgICAgc2V0R2VuQ29zdChzdGF0ZSwgbXNnLmlkLCBtc2cuY29zdCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZ2VuLm1ldGFcIjpcbiAgICAgIHNldEdlbk1ldGEoc3RhdGUsIG1zZy5pZCwgeyBwcm9tcHQ6IG1zZy5wcm9tcHQsIGN1c3RvbTogbXNnLmN1c3RvbSB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJzdGF0dXNcIjpcbiAgICAgIHN0YXRlLnN0YXR1cyA9IHsgYnVzeTogbXNnLmJ1c3ksIHRleHQ6IG1zZy50ZXh0ID8/IFwiXCIgfTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJzdHlsZS5hcmNoaXZlXCI6XG4gICAgICBhcmNoaXZlVHJheVN0eWxlKHN0YXRlLCBtc2cuaWQsIG1zZy5hcmNoaXZlZCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwic2F5XCI6XG4gICAgY2FzZSBcImNsb3NlXCI6XG4gICAgICBicmVhazsgLy8gaGFuZGxlZCBieSB0aGUgc2VydmVyIChhcHBlbmRlZCB0byBjb252ZXJzYXRpb24gLyBzaHV0ZG93bilcbiAgICBkZWZhdWx0OlxuICAgICAgLy8gIzg0IOKAlCB0aGUgc3dpdGNoIGhhZCBOTyBkZWZhdWx0LCBzbyBhbiB1bnJlY29nbmlzZWQgY29tbWFuZCB0eXBlIGRpZFxuICAgICAgLy8gbm90aGluZyBhbmQgdGhlIC9jbWQgcm91dGUgc3RpbGwgYW5zd2VyZWQge29rOnRydWV9OiBhIGJvZ3VzIHR5cGUgd2FzXG4gICAgICAvLyBieXRlLWlkZW50aWNhbCB0byBhbiBleGVjdXRlZCBvbmUuIFRoZSB2ZXJkaWN0IGhhcyB0byBiZSBwcm9kdWNlZCBIRVJFLFxuICAgICAgLy8gYnkgdGhlIGNvZGUgdGhhdCBhY3R1YWxseSBrbm93cyB0aGUgcmVjb2duaXNlZCBzZXQsIGFuZCBub3QgbWlycm9yZWRcbiAgICAgIC8vIGludG8gYSBsaXN0IGJlc2lkZSB0aGUgc3dpdGNoIOKAlCBhIGhhbmQtbWFpbnRhaW5lZCBtaXJyb3Igb2YgYSBjYXNlIGxpc3RcbiAgICAgIC8vIGRyaWZ0cyBzaWxlbnRseSB0aGUgbW9tZW50IGEgY2FzZSBpcyBhZGRlZCwgd2hpY2ggaXMgYSBkZWZlY3QgdGhpcyByZXBvXG4gICAgICAvLyBoYXMgYWxyZWFkeSBzaGlwcGVkIHR3aWNlLlxuICAgICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuIiwKICAgICIvLyBTZXJ2ZXIvQ0xJLW9ubHk6IHRoZSBwcm9qZWN0LXNjb3BlZCBzdHlsZSBzdG9yZS4gRG8gTk9UIGltcG9ydCBmcm9tIGJyb3dzZXJcbi8vIGNvZGUgKGZpbGVzeXN0ZW0gYWNjZXNzKS4gU3R5bGVzIGxpdmUgdW5kZXIgJHtob21lfS9zdHlsZXMvJHtwcm9qZWN0S2V5fS8sXG4vLyBrZXllZCB0byB0aGUgY2hlY2tvdXQgd2hlcmUgdGhlIHNwZWxsIHdhcyBjYXN0LlxuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCByZWFkZGlyU3luYywgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUge1xuICBDYW5vbkltZyxcbiAgQ2Fub25pY2FsUmVmLFxuICBMaWJyYXJ5SXRlbSxcbiAgU2F2ZWRTdHlsZSxcbiAgU3R5bGVTZWN0aW9uLFxufSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dsYW1vdXIvc2hhcmVkL3R5cGVzXCI7XG5cbmNvbnN0IEVYVF9CWV9NSU1FOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcImltYWdlL3dlYnBcIjogXCJ3ZWJwXCIsXG4gIFwiaW1hZ2UvcG5nXCI6IFwicG5nXCIsXG4gIFwiaW1hZ2UvanBlZ1wiOiBcImpwZ1wiLFxuICBcImltYWdlL2dpZlwiOiBcImdpZlwiLFxufTtcblxuLy8gQSBzdGFibGUsIGZpbGVzeXN0ZW0tc2FmZSBrZXk6IHNhbml0aXplZCBiYXNlIG5hbWUgKyBhIHNob3J0IGhhc2ggb2YgdGhlIGZ1bGxcbi8vIGFic29sdXRlIHBhdGggKHNvIHR3byBjaGVja291dHMgd2l0aCB0aGUgc2FtZSBmb2xkZXIgbmFtZSBkb24ndCBjb2xsaWRlKS5cbmV4cG9ydCBmdW5jdGlvbiBwcm9qZWN0S2V5KHByb2plY3REaXI6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBiYXNlbmFtZShwcm9qZWN0RGlyKS5yZXBsYWNlKC9bXmEtekEtWjAtOV8tXS9nLCBcIl9cIikgfHwgXCJyb290XCI7XG4gIGxldCBoID0gNTM4MTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBwcm9qZWN0RGlyLmxlbmd0aDsgaSsrKSBoID0gKChoIDw8IDUpICsgaCArIHByb2plY3REaXIuY2hhckNvZGVBdChpKSkgPj4+IDA7XG4gIHJldHVybiBgJHtiYXNlfS0ke2gudG9TdHJpbmcoMzYpfWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzdHlsZXNEaXIoaG9tZTogc3RyaW5nLCBrZXk6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKGhvbWUsIFwic3R5bGVzXCIsIGtleSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzYXZlU3R5bGUoXG4gIGhvbWU6IHN0cmluZyxcbiAga2V5OiBzdHJpbmcsXG4gIGFyZ3M6IHtcbiAgICBpZDogc3RyaW5nO1xuICAgIGxhYmVsOiBzdHJpbmc7XG4gICAgdGV4dDogc3RyaW5nO1xuICAgIHNlY3Rpb25zOiBTdHlsZVNlY3Rpb25bXTtcbiAgICBjYW5vbmljYWxJdGVtczogTGlicmFyeUl0ZW1bXTtcbiAgICBjcmVhdGVkQXQ6IG51bWJlcjtcbiAgfSxcbik6IFNhdmVkU3R5bGUge1xuICBjb25zdCBkaXIgPSBzdHlsZXNEaXIoaG9tZSwga2V5KTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IGNhbm9uaWNhbDogQ2Fub25pY2FsUmVmW10gPSBbXTtcbiAgZm9yIChjb25zdCBpdCBvZiBhcmdzLmNhbm9uaWNhbEl0ZW1zKSB7XG4gICAgaWYgKCFpdC5wYXRoIHx8ICFleGlzdHNTeW5jKGl0LnBhdGgpKSBjb250aW51ZTtcbiAgICBjb25zdCBleHQgPSBFWFRfQllfTUlNRVtpdC5taW1lXSA/PyBcImJpblwiO1xuICAgIGNvbnN0IGZpbGUgPSBgJHthcmdzLmlkfS0ke2l0LmlkfS4ke2V4dH1gO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBmaWxlKSwgcmVhZEZpbGVTeW5jKGl0LnBhdGgpKTtcbiAgICAgIGNhbm9uaWNhbC5wdXNoKHsgaWQ6IGl0LmlkLCB0aXRsZTogaXQudGl0bGUsIGZpbGUsIG1pbWU6IGl0Lm1pbWUgfSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBza2lwIGFuIHVucmVhZGFibGUgYmxvYiAqL1xuICAgIH1cbiAgfVxuICBjb25zdCBzdHlsZTogU2F2ZWRTdHlsZSA9IHtcbiAgICBpZDogYXJncy5pZCxcbiAgICBsYWJlbDogYXJncy5sYWJlbCxcbiAgICB0ZXh0OiBhcmdzLnRleHQsXG4gICAgc2VjdGlvbnM6IGFyZ3Muc2VjdGlvbnMsXG4gICAgY2Fub25pY2FsLFxuICAgIGNyZWF0ZWRBdDogYXJncy5jcmVhdGVkQXQsXG4gICAgYXJjaGl2ZWQ6IGZhbHNlLFxuICB9O1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHthcmdzLmlkfS5qc29uYCksIEpTT04uc3RyaW5naWZ5KHN0eWxlKSk7XG4gIHJldHVybiBzdHlsZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxvYWRUcmF5KGhvbWU6IHN0cmluZywga2V5OiBzdHJpbmcpOiBTYXZlZFN0eWxlW10ge1xuICBjb25zdCBkaXIgPSBzdHlsZXNEaXIoaG9tZSwga2V5KTtcbiAgaWYgKCFleGlzdHNTeW5jKGRpcikpIHJldHVybiBbXTtcbiAgY29uc3Qgb3V0OiBTYXZlZFN0eWxlW10gPSBbXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIHJlYWRkaXJTeW5jKGRpcikpIHtcbiAgICBpZiAoIW5hbWUuZW5kc1dpdGgoXCIuanNvblwiKSkgY29udGludWU7XG4gICAgdHJ5IHtcbiAgICAgIG91dC5wdXNoKEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oZGlyLCBuYW1lKSwgXCJ1dGY4XCIpKSBhcyBTYXZlZFN0eWxlKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHNraXAgYSBjb3JydXB0IHJlY29yZCAqL1xuICAgIH1cbiAgfVxuICByZXR1cm4gb3V0LnNvcnQoKGEsIGIpID0+IGEuY3JlYXRlZEF0IC0gYi5jcmVhdGVkQXQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0U3R5bGVBcmNoaXZlZChcbiAgaG9tZTogc3RyaW5nLFxuICBrZXk6IHN0cmluZyxcbiAgaWQ6IHN0cmluZyxcbiAgYXJjaGl2ZWQ6IGJvb2xlYW4sXG4pOiBib29sZWFuIHtcbiAgY29uc3QgcGF0aCA9IGpvaW4oc3R5bGVzRGlyKGhvbWUsIGtleSksIGAke2lkfS5qc29uYCk7XG4gIGlmICghZXhpc3RzU3luYyhwYXRoKSkgcmV0dXJuIGZhbHNlO1xuICB0cnkge1xuICAgIGNvbnN0IHN0eWxlID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSBhcyBTYXZlZFN0eWxlO1xuICAgIHN0eWxlLmFyY2hpdmVkID0gYXJjaGl2ZWQ7XG4gICAgd3JpdGVGaWxlU3luYyhwYXRoLCBKU09OLnN0cmluZ2lmeShzdHlsZSkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hdGVyaWFsaXplQ2Fub24oaG9tZTogc3RyaW5nLCBrZXk6IHN0cmluZywgc3R5bGU6IFNhdmVkU3R5bGUpOiBDYW5vbkltZ1tdIHtcbiAgY29uc3QgZGlyID0gc3R5bGVzRGlyKGhvbWUsIGtleSk7XG4gIGNvbnN0IG91dDogQ2Fub25JbWdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHJlZiBvZiBzdHlsZS5jYW5vbmljYWwpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgYnl0ZXMgPSByZWFkRmlsZVN5bmMoam9pbihkaXIsIHJlZi5maWxlKSk7XG4gICAgICBvdXQucHVzaCh7XG4gICAgICAgIHRpdGxlOiByZWYudGl0bGUsXG4gICAgICAgIHNyYzogYGRhdGE6JHtyZWYubWltZX07YmFzZTY0LCR7Ynl0ZXMudG9TdHJpbmcoXCJiYXNlNjRcIil9YCxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogc2tpcCBhIG1pc3NpbmcgYmxvYiAqL1xuICAgIH1cbiAgfVxuICByZXR1cm4gb3V0O1xufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQUFBLHVCQUFTLDBCQUFZLHNCQUFXLHVCQUFRO0FBQ3hDO0FBQ0EsMEJBQWtCO0FBQ2xCO0FBQ0Esc0JBQVM7OztBQ2tMRixJQUFNLG9CQUFvQixPQUFPLE9BQU87QUFBQSxFQUM3QztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0YsQ0FBVTtBQUdILFNBQVMsaUJBQWlCLEdBQW1CO0FBQUEsRUFDbEQsT0FBTztBQUFBLElBQ0w7QUFBQSxNQUNFLEtBQUs7QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxNQUNULFNBQVMsQ0FBQztBQUFBLE1BQ1YsUUFBUSxDQUFDO0FBQUEsSUFDWDtBQUFBLElBQ0E7QUFBQSxNQUNFLEtBQUs7QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxNQUNULFNBQVMsQ0FBQztBQUFBLE1BQ1YsUUFBUSxDQUFDO0FBQUEsSUFDWDtBQUFBLElBQ0E7QUFBQSxNQUNFLEtBQUs7QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxNQUNULFNBQVMsQ0FBQztBQUFBLE1BQ1YsUUFBUSxDQUFDO0FBQUEsSUFDWDtBQUFBLElBQ0E7QUFBQSxNQUNFLEtBQUs7QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxNQUNULFNBQVMsQ0FBQztBQUFBLE1BQ1YsUUFBUSxDQUFDO0FBQUEsSUFDWDtBQUFBLElBQ0E7QUFBQSxNQUNFLEtBQUs7QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxNQUNULFNBQVMsQ0FBQztBQUFBLE1BQ1YsUUFBUSxDQUFDO0FBQUEsSUFDWDtBQUFBLElBQ0E7QUFBQSxNQUNFLEtBQUs7QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxNQUNULFNBQVMsQ0FBQztBQUFBLE1BQ1YsUUFBUSxDQUFDO0FBQUEsSUFDWDtBQUFBLEVBQ0Y7QUFBQTtBQUdLLFNBQVMsWUFBWSxDQUFDLE9BQWUsUUFBOEI7QUFBQSxFQUN4RSxPQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0E7QUFBQSxJQUNBLFNBQVMsQ0FBQztBQUFBLElBQ1YsYUFBYSxDQUFDO0FBQUEsSUFDZCxVQUFVLENBQUM7QUFBQSxJQUNYLFlBQVksa0JBQWtCO0FBQUEsSUFDOUIsTUFBTSxDQUFDO0FBQUEsSUFDUCxPQUFPO0FBQUEsSUFDUCxVQUFVLENBQUM7QUFBQSxJQUNYLFlBQVk7QUFBQSxJQUNaLFdBQVc7QUFBQSxJQUNYLFFBQVEsRUFBRSxNQUFNLE9BQU8sTUFBTSxHQUFHO0FBQUEsRUFDbEM7QUFBQTs7O0FDclBGO0FBcUJPLFNBQVMsZUFBZSxDQUFDLFFBQWdCLE1BQW9CO0FBQUEsRUFDbEUsTUFBTSxNQUFNLEdBQUcsVUFBVSxRQUFR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
