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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9zZXJ2ZXIudHMiLCAiLi4vc2hhcmVkL3R5cGVzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc3NlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9wZXJzaXN0LnNlcnZlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvZ2xhbW91ci9iYWNrZW5kL3JlZHVjZS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvZ2xhbW91ci9iYWNrZW5kL3N0eWxlcy5zZXJ2ZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHVubGlua1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgYXMgbm9kZVBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7XG4gIHR5cGUgQWdlbnRDb21tYW5kLFxuICB0eXBlIENsaWVudFRvU2VydmVyLFxuICBkZWZhdWx0U3RhdGUsXG4gIHR5cGUgR2xhbW91clN0YXRlLFxufSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dsYW1vdXIvc2hhcmVkL3R5cGVzXCI7XG5pbXBvcnQgeyB1bmxpbmtJZk1hdGNoZXMsIHdyaXRlRmlsZUF0b21pYyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9kaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB7IGNyZWF0ZUV2ZW50TG9nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2V2ZW50TG9nLnRzXCI7XG5pbXBvcnQgeyBkcmFpbkFuZFN0b3AsIHN0YXJ0SG91c2VrZWVwaW5nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hvdXNla2VlcGluZy50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZU1vZGUgYXMgcmVzb2x2ZU1vZGVJbiwgc2VydmVGcm9tRGlzdCB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9zZXJ2ZURpc3QudHNcIjtcbmltcG9ydCB7IHR5cGUgU3NlQ2xpZW50cywgc3NlUmVzcG9uc2UgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvc3NlLnRzXCI7XG5pbXBvcnQgeyBJRExFX1RJTUVPVVRfU0VDLCBTU0VfSEVBUlRCRUFUX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0XCI7XG5pbXBvcnQgeyBsb2FkU25hcHNob3QsIG1hdGVyaWFsaXplSXRlbSwgc2F2ZVNuYXBzaG90IH0gZnJvbSBcIi4vcGVyc2lzdC5zZXJ2ZXJcIjtcbmltcG9ydCB7XG4gIGFkZEl0ZW0sXG4gIGFkZE1lc3NhZ2UsXG4gIGFubm90YXRlLFxuICBhcHBseUFnZW50TXNnLFxuICBidWlsZFN0eWxlSXRlbSxcbiAgY2xlYXJGb2N1cyxcbiAgbGVhbkl0ZW0sXG4gIGxlYW5TdGF0ZSxcbiAgbWFrZUl0ZW0sXG4gIHNlbGVjdEl0ZW1zLFxuICBzZXRDYW5vbmljYWwsXG4gIHNldEZvY3VzLFxuICBzZXRJdGVtQXJjaGl2ZWQsXG4gIHNldExpa2UsXG4gIHNldFN0YXIsXG59IGZyb20gXCIuL3JlZHVjZVwiO1xuaW1wb3J0IHtcbiAgbG9hZFRyYXksXG4gIG1hdGVyaWFsaXplQ2Fub24sXG4gIHByb2plY3RLZXksXG4gIHNhdmVTdHlsZSxcbiAgc2V0U3R5bGVBcmNoaXZlZCxcbn0gZnJvbSBcIi4vc3R5bGVzLnNlcnZlclwiO1xuXG4vLyBUaGUgc3VyZmFjZSdzIEhUTUwgZW50cnkgdXNlZCB0byBiZSBhIHRvcC1sZXZlbCBzdGF0aWMgaW1wb3J0IGhlcmUuIEEgc3RhdGljXG4vLyBpbXBvcnQgZm9yY2VzIEJ1biB0byByZXNvbHZlIHRoZSB3aG9sZSAudHN4ICsgVGFpbHdpbmQgZ3JhcGggd2hlbiB0aGlzIG1vZHVsZVxuLy8gTE9BRFMsIHNvIGEgZGVzdGluYXRpb24gdGhhdCBzaGlwcyBkaXN0LyBhbmQgbm8gc3VyZmFjZSBzb3VyY2Ug4oCUIHRoZSBwdWJsaXNoZWRcbi8vIGFydGlmYWN0IOKAlCBkaWVzIGJlZm9yZSBpdCBjYW4gc2VydmUgdGhlIGRpc3QgaXQgZG9lcyBoYXZlLiBUaGUgZGV2IGltcG9ydCBpc1xuLy8gdGhlcmVmb3JlIGR5bmFtaWMgYW5kIHJlYWNoZWQgb25seSBvbiB0aGUgZGV2IGJyYW5jaCBiZWxvdyAoc2VhbXMgQ29udHJhY3QgMSksXG4vLyBhcyBhc3Ryb2xhYmUsIGltYWdvIGFuZCBtaW5kLW1hcHBlciBkbyBpdC5cbi8vXG4vLyBQYXRocyBhbmNob3IgYXQgdGhlIFNLSUxMIFJPT1QsIG5ldmVyIGF0IGN3ZDogY2xpLnRzIHBpbnMgdGhlIGRhZW1vbidzIGN3ZCBmb3Jcbi8vIGJ1bmZpZy50b21sJ3Mgc2FrZSBpbiBkZXYgKENvbnRyYWN0IDUpLCBzbyBjd2QgaXMgbm90IGEgc3RhYmxlIGJhc2UgZm9yIGRpc3QvLlxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuXG4vLyByZWxlYXNlIGlmZiBkaXN0L2luZGV4Lmh0bWwgZXhpc3RzIGF0IHRoZSBza2lsbCByb290IOKAlCB0aGUgRklMRSwgbmV2ZXIgdGhlXG4vLyBkaXJlY3RvcnkgKGEgYnVpbHQgYmFja2VuZCBjYW4gcHV0IGNsaS5qcyBpbiBkaXN0LyB3aXRoIG5vIHN1cmZhY2UgdGhlcmUpIOKAlFxuLy8gZWxzZSBkZXY7IHRoZSBlbnYgb3ZlcnJpZGUgd2lucyBlaXRoZXIgd2F5IChDb250cmFjdCAxKS4gUmVsZWFzZTogemVybyByZWFkc1xuLy8gb2Ygc3VyZmFjZSBzb3VyY2Ugb3IgYnVuZmlnLnRvbWwg4oCUIHN0YXRpYyBmaWxlcyBvbmx5LlxuLy9cbi8vIFRoZSBwcmVkaWNhdGUgYW5kIHRoZSBzY2FyIGl0IGNhcnJpZXMgYXJlIG5vdyBgc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50c2A7XG4vLyB3aGF0IHN0YXlzIGhlcmUgaXMgV0hJQ0ggZGlyZWN0b3J5IGdsYW1vdXIgcmVzb2x2ZXMgYWdhaW5zdC4gRXhwb3J0ZWQgYmVjYXVzZVxuLy8gdGhpcyBzcGVsbCdzIG93biBzdWl0ZXMgYXNrIGl0LlxuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKCk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIHJldHVybiByZXNvbHZlTW9kZUluKERJU1RfRElSKTtcbn1cblxuLy8gU2VydmVzIGRpc3QvIHZlcmJhdGltIOKAlCBlbnRyeSBpbmRleC5odG1sLCBoYXNoZWQgY2h1bmtzIGJ5IHBhdGggKENvbnRyYWN0IDInc1xuLy8gZmxhdCwgcmVsYXRpdmUtaHJlZiBsYXlvdXQpLiDim5QgVEhFIFVSTOKGkkZJTEVOQU1FIE1BUFBJTkcgU1RBWVMgSEVSRSBPTiBQVVJQT1NFOlxuLy8gdGhlIGtpdCBkZWNpZGVzIHdoZXRoZXIgYSBmaWxlIG1heSBiZSByZWFkIGFuZCB3aGF0IGNvbnRlbnQgdHlwZSBpdCBnZXRzLCBhbmRcbi8vIHRoZSBDQUxMRVIgZGVjaWRlcyB3aGljaCBmaWxlIOKAlCBiZWNhdXNlIHR3byBzcGVsbHMgcm91dGUgdGhpcyBkaWZmZXJlbnRseSBhbmQgYVxuLy8gc2lnbmF0dXJlIHdpZGUgZW5vdWdoIGZvciBib3RoIHN0b3BzIGJlaW5nIGEgZmlsZSBzZXJ2ZXIuIGdsYW1vdXIncyBvd25cbi8vIGBHRVQgL2Fzc2V0cy88bmFtZT5gIHNlc3Npb24tZmlsZXMgcm91dGUgc2l0cyBBQk9WRSB0aGlzIGluIHRoZSBmZXRjaCBjaGFpbixcbi8vIGFuZCBgc2VydmVGcm9tRGlzdGAgcmVmdXNpbmcgYW55dGhpbmcgd2l0aCBhIHNsYXNoIGluIGl0IGlzIHdoYXQga2VlcHMgdGhlIHR3b1xuLy8gZGlzam9pbnQgKGV2ZXJ5IC9hc3NldHMvIHBhdGggaXMgbmVzdGVkLCBzbyBpdCBpcyByZWZ1c2VkIGhlcmUgYW5kIGZhbGxzXG4vLyB0aHJvdWdoKS5cbmZ1bmN0aW9uIHNlcnZlRGlzdChwYXRoOiBzdHJpbmcpOiBSZXNwb25zZSB8IG51bGwge1xuICByZXR1cm4gc2VydmVGcm9tRGlzdChESVNUX0RJUiwgcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSkpO1xufVxuXG5jb25zdCByYW5kSGV4ID0gKG46IG51bWJlcikgPT5cbiAgQXJyYXkuZnJvbShjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKG5ldyBVaW50OEFycmF5KG4pKSlcbiAgICAubWFwKChiKSA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpXG4gICAgLmpvaW4oXCJcIik7XG5cbmV4cG9ydCB0eXBlIFN0YXJ0T3B0cyA9IHtcbiAgcG9ydD86IG51bWJlcjtcbiAgaG9zdD86IHN0cmluZztcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIGludGVudD86IHN0cmluZztcbiAgcmVzdG9yZT86IHN0cmluZztcbiAgdGltZW91dFM/OiBudW1iZXI7XG4gIHByb2plY3Q/OiBzdHJpbmc7XG59O1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnREYWVtb24ob3B0czogU3RhcnRPcHRzKSB7XG4gIGNvbnN0IEdMQU1PVVJfSE9NRSA9IHByb2Nlc3MuZW52LkdMQU1PVVJfSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuZ2xhbW91clwiKTtcbiAgY29uc3QgU05BUFNIT1RTX0RJUiA9IGpvaW4oR0xBTU9VUl9IT01FLCBcInNuYXBzaG90c1wiKTtcbiAgbGV0IHN0YXRlOiBHbGFtb3VyU3RhdGUgPSBkZWZhdWx0U3RhdGUob3B0cy50aXRsZSA/PyBcIlwiLCBvcHRzLmludGVudCA/PyBcIlwiKTtcbiAgbGV0IHJlc3RvcmVkID0gZmFsc2U7XG4gIGlmIChvcHRzLnJlc3RvcmUpIHtcbiAgICBjb25zdCBwYXRoID0gZXhpc3RzU3luYyhvcHRzLnJlc3RvcmUpXG4gICAgICA/IG9wdHMucmVzdG9yZVxuICAgICAgOiBqb2luKFNOQVBTSE9UU19ESVIsIGAke29wdHMucmVzdG9yZX0uanNvbmApO1xuICAgIHRyeSB7XG4gICAgICBzdGF0ZSA9IGxvYWRTbmFwc2hvdChwYXRoLCBvcHRzLnRpdGxlID8/IFwiXCIsIG9wdHMuaW50ZW50ID8/IFwiXCIpO1xuICAgICAgcmVzdG9yZWQgPSB0cnVlO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBnbGFtb3VyOiByZXN0b3JlIGZhaWxlZCAoJHtwYXRofSk6ICR7ZX1cXG5gKTtcbiAgICB9XG4gIH1cbiAgY29uc3QgUFJPSkVDVF9LRVkgPSBwcm9qZWN0S2V5KG9wdHMucHJvamVjdCA/PyBwcm9jZXNzLmN3ZCgpKTtcbiAgLy8gLS0tIG1vZGUsIHJlc29sdmVkIEJFRk9SRSBhbnkgZmlsZXN5c3RlbSB3cml0ZSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBBIGZvcmNlZC1kZXYgYm9vdCBhdCBhIHN1cmZhY2UtZnJlZSBkZXN0aW5hdGlvbiBtdXN0IGRpZSBIRVJFLCBhdCB0aGUgaW1wb3J0LFxuICAvLyBoYXZpbmcgd3JpdHRlbiBub3RoaW5nOiBubyBzZXNzaW9uLWZpbGVzIGRpciwgbm8gZGlzY292ZXJ5IHBvaW50ZXIuIE1lYXN1cmVkXG4gIC8vIGluIHRoZSBsb2NhbC1zaW06IHdpdGggdGhpcyBibG9jayBwbGFjZWQgYWZ0ZXIgdGhlIHNlc3Npb24tZmlsZXMgbWtkaXIsIGFcbiAgLy8gZHlpbmcgZGFlbW9uIGxlZnQgYCRUTVBESVIvZ2xhbW91ci08aWQ+LWZpbGVzL2AgYmVoaW5kIG9uIGV2ZXJ5IGZhaWxlZCBib290LlxuICBjb25zdCBtb2RlID0gcmVzb2x2ZU1vZGUoKTtcbiAgLy8gZGV2OiB0aGUgZHluYW1pYyBzdHJpbmctbGl0ZXJhbCBpbXBvcnQga2VlcHMgdGhlIHN1cmZhY2UgZ3JhcGggb2ZmIHRoZSBtb2R1bGVcbiAgLy8gbG9hZCBwYXRoIChDb250cmFjdCAxKSDigJQgQnVuIGJ1bmRsZXMgdGhlIC50c3ggZ3JhcGggKyBUYWlsd2luZCBhdCBzZXJ2ZSB0aW1lLFxuICAvLyByZWFkaW5nIGJ1bmZpZy50b21sIGZyb20gY3dkLCB3aGljaCBjbGkudHMgcGlucyB0byBzcmMvZ2xhbW91ci8gKENvbnRyYWN0IDUpLlxuICAvLyByZWxlYXNlOiBkaXN0LyBpcyBzdGF0aWMgYW5kIHByZS1idWlsdCAoQ29udHJhY3QgMikg4oCUIFwiL1wiIGlzIGFuc3dlcmVkIGJ5XG4gIC8vIHNlcnZlRGlzdCgpIGluIHRoZSBmZXRjaCBmYWxsLXRocm91Z2gsIHNvIHRoaXMgYnJhbmNoIG5ldmVyIHRvdWNoZXMgc3VyZmFjZVxuICAvLyBzb3VyY2Ugb3IgYnVuZmlnLnRvbWwgYW5kIG5ldmVyIG5lZWRzIGVpdGhlciB0byBleGlzdC4gQnVuJ3MgUm91dGVzIHR5cGUgdGllc1xuICAvLyB0aGUgXCIvXCIgdmFsdWUncyB0eXBlIHRvIHRoZSBsaXRlcmFsIG9iamVjdCBzaGFwZSwgc28gdGhlIG1vZGUtdGVybmFyeSB1bmlvblxuICAvLyBpcyBjYXN0OyB0aGUgcnVudGltZSBiZWhhdmlvdXIgKEhUTUxCdW5kbGUgaW4gZGV2LCBhYnNlbnQgaW4gcmVsZWFzZSkgaXNcbiAgLy8gY29ycmVjdCBlaXRoZXIgd2F5LiBUaGlzIGlzIHRoZSBPTkUgc3JjLy1uYW1pbmcgc3BlY2lmaWVyIGluIHRoZSBkZXBsb3llZFxuICAvLyBzcGVsbCAocGxhbiBTMiwgcmF0aWZpZWQgYXQgdGhlIHNwZWNpZmllciBncmFpbikuXG4gIGNvbnN0IGRldkluZGV4ID1cbiAgICBtb2RlID09PSBcImRldlwiXG4gICAgICA/IChhd2FpdCBpbXBvcnQoXCIuLi8uLi8uLi8uLi8uLi9zcmMvZ2xhbW91ci9zdXJmYWNlL2luZGV4Lmh0bWxcIikpLmRlZmF1bHRcbiAgICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCByb3V0ZXMgPSAoZGV2SW5kZXggPyB7IFwiL1wiOiBkZXZJbmRleCB9IDoge30pIGFzIFJlY29yZDxzdHJpbmcsIG5ldmVyPjtcbiAgLy8gTG9hZCB0aGUgcHJvamVjdCdzIHNhdmVkIHN0eWxlcyBpbnRvIHRoZSB0cmF5IChtZXRhZGF0YSBvbmx5IOKAlCBOT1QgdGhlXG4gIC8vIGxpYnJhcnkpLiBEbyB0aGlzIGFmdGVyIHJlc3RvcmUgc28gYSByZXN0b3JlZCBzbmFwc2hvdCdzIHN0YWxlIHRyYXkgaXNcbiAgLy8gcmVwbGFjZWQgYnkgdGhlIGF1dGhvcml0YXRpdmUgb24tZGlzayBzZXQuXG4gIHN0YXRlLnRyYXkgPSBsb2FkVHJheShHTEFNT1VSX0hPTUUsIFBST0pFQ1RfS0VZKTtcblxuICAvLyAtLS0gY2hhbm5lbHMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHNvY2tldHMgPSBuZXcgU2V0PGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4+KCk7XG4gIC8vIFRoZSByZXBsYXkgbG9nIGJlaGluZCBgR0VUIC9ldmVudHM/c2luY2U9PGlkPmAg4oCUIHNoYXJlZFxuICAvLyAoYGtpdC93aXJlL2V2ZW50TG9nLnRzYCksIHNvIGdsYW1vdXIgaW5oZXJpdHMgdGhlIGJvdW5kZWQgYnVmZmVyLCB0aGVcbiAgLy8gbW9ub3RvbmljIGlkIHRoYXQgYWN0dWFsbHkgV0lOUyBvdmVyIGEgcGF5bG9hZCBgaWRgLCBhbmQgdGhlIHN0YWxlLXdhdGVybWFya1xuICAvLyByZXBsYXkgdGhhdCBsZXRzIGEgdGFpbCByZXN1bWluZyBhZ2FpbnN0IGEgcmVzdGFydGVkIGRhZW1vbiByZWNlaXZlIGFueXRoaW5nXG4gIC8vIGF0IGFsbC4gZ2xhbW91ciBzdGFtcHMgTk8gRVBPQ0g6IGEgc2Vzc2lvbiBpcyBpZGVudGlmaWVkIGJ5IGBzZXNzaW9uX2lkYCwgYVxuICAvLyByZXN0YXJ0IGlzIGEgZGlmZmVyZW50IHNlc3Npb24sIGFuZCBhIHJlc3VtaW5nIHRhaWwgaXMgYWxyZWFkeSB0YWxraW5nIHRvIGFcbiAgLy8gZGlmZmVyZW50IGRhZW1vbiBieSBuYW1lIChEMTkncyByZWFzb25pbmcgZm9yIG1hZ3BpZSwgYW5kIGl0IGlzIGdsYW1vdXIncyB0b28pLlxuICBjb25zdCBsb2cgPSBjcmVhdGVFdmVudExvZzxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oKTtcbiAgY29uc3Qgc3NlQ2xpZW50czogU3NlQ2xpZW50cyA9IG5ldyBTZXQoKTtcbiAgbGV0IGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICBjb25zdCB0b3VjaCA9ICgpID0+IHtcbiAgICBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgfTtcblxuICBjb25zdCBicm9hZGNhc3QgPSAobXNnOiBvYmplY3QpID0+IHtcbiAgICBjb25zdCBzID0gSlNPTi5zdHJpbmdpZnkobXNnKTtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLnNlbmQocyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogc29ja2V0IGNsb3NlZCAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcbiAgbGV0IHNuYXBEaXJ0eSA9IGZhbHNlO1xuICBjb25zdCBicm9hZGNhc3RTdGF0ZSA9ICgpID0+IHtcbiAgICBzbmFwRGlydHkgPSB0cnVlO1xuICAgIGJyb2FkY2FzdCh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGUgfSk7XG4gIH07XG4gIGNvbnN0IGVtaXRFdmVudCA9IChtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBsb2cuZW1pdChtc2cpO1xuXG4gIC8vIFByZXNlbmNlIGlzIHRyYW5zaWVudDogc3RyZWFtIHRvIGxpdmUgU1NFIGNsaWVudHMgYnV0IERPIE5PVCBzdG9yZSBpdCBpblxuICAvLyB0aGUgcmVwbGF5IGxvZyAoYSByZWNvbm5lY3RpbmcgYWdlbnQgc2hvdWxkIG5vdCByZS1zZWUgZXZlcnkgcGFzdFxuICAvLyBjb25uZWN0L2Rpc2Nvbm5lY3QpLiBObyBpZCBpcyBhc3NpZ25lZCwgc28gaXQgbmV2ZXIgYWR2YW5jZXMgYSB0YWlsIGN1cnNvci5cbiAgLy9cbiAgLy8g4puUIFRISVMgSVMgVEhFIE9ORSBUSElORyBUSEUgU0hBUkVEIFNTRSBNT0RVTEUgQ09VTEQgTk9UIERPLCBBTkQgSVQgV0FTXG4gIC8vIFdJREVORUQgUkFUSEVSIFRIQU4gV09SS0VEIEFST1VORC4gYFNzZUNsaWVudHNgIGhlbGQgYmFyZSBjbG9zZXJzLCBiZWNhdXNlXG4gIC8vIGFzdHJvbGFiZSBhbmQgbWFncGllIGFubm91bmNlIHByZXNlbmNlIG92ZXIgdGhlaXIgYnJvd3NlciBXRUJTT0NLRVQgYW5kIG5ldmVyXG4gIC8vIG5lZWRlZCB0byBwdXNoIGFuIHVubG9nZ2VkIGZyYW1lIGF0IHRoZSBhZ2VudCdzIHRhaWwuIEtlZXBpbmcgYSBzZWNvbmQsXG4gIC8vIHBhcmFsbGVsIGBTZXQ8UmVhZGFibGVTdHJlYW1EZWZhdWx0Q29udHJvbGxlcj5gIGhlcmUgd291bGQgaGF2ZSByZS1jcmVhdGVkXG4gIC8vIGV4YWN0bHkgdGhlIGRyaWZ0IHRoZSByZWdpc3RyeSBleGlzdHMgdG8gcmVtb3ZlIOKAlCBhbmQgaXQgaXMgdGhlIGRyaWZ0IHRoYXRcbiAgLy8gbW9kdWxlJ3Mgb3duIGhlYWRlciB3YXJucyBhYm91dCwgd2hlcmUgYSBwZXItc3RyZWFtIHRpbWVyIHdhcyBzd2VwdCBmcm9tIGFcbiAgLy8gc2Vjb25kIHNldCBhbmQgY291bGQgZmFsbCBvdXQgb2Ygc3RlcC4gU28gdGhlIHJlZ2lzdHJ5IGVudHJ5IGdhaW5lZCBgc2VuZGAsXG4gIC8vIHdoaWNoIHJvdXRlcyB0aHJvdWdoIHRoZSBzYW1lIGNsb3NlZC1jaGVjayBhbmQgdGVhcmRvd24gZnVubmVsIGFzIGV2ZXJ5IG90aGVyXG4gIC8vIHdyaXRlLiBSZXBvcnRlZCBhcyBhIGZpbmRpbmcgYWJvdXQgdGhlIG1vZHVsZSwgcGVyIHRoZSBwaGFzZSBicmllZi5cbiAgY29uc3QgZW1pdFRyYW5zaWVudCA9IChtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgY29uc3QgZnJhbWUgPSBgZGF0YTogJHtKU09OLnN0cmluZ2lmeShtc2cpfVxcblxcbmA7XG4gICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIGMuc2VuZChmcmFtZSk7XG4gIH07XG5cbiAgLy8gLS0tIHNlc3Npb24gZmlsZXMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzZXNzaW9uSWQgPSBgZ2xhbW91ci0ke3JhbmRIZXgoNCl9YDtcbiAgY29uc3Qgc2Vzc2lvbkZpbGVzRGlyID0gam9pbih0bXBkaXIoKSwgYCR7c2Vzc2lvbklkfS1maWxlc2ApO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhzZXNzaW9uRmlsZXNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIGJhY2sgdG8gbm8gcGF0aHMgKi9cbiAgfVxuICBpZiAocmVzdG9yZWQpIHtcbiAgICBmb3IgKGNvbnN0IGl0IG9mIHN0YXRlLmxpYnJhcnkpIG1hdGVyaWFsaXplSXRlbShzZXNzaW9uRmlsZXNEaXIsIGl0KTtcbiAgfVxuXG4gIC8vIC0tLSBhZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBsZXQgcmVzb2x2ZURvbmUhOiAodjogeyBjb2RlOiBudW1iZXI7IHJlYXNvbjogc3RyaW5nIH0pID0+IHZvaWQ7XG4gIGNvbnN0IGRvbmUgPSBuZXcgUHJvbWlzZTx7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmcgfT4oKHIpID0+IHtcbiAgICByZXNvbHZlRG9uZSA9IHI7XG4gIH0pO1xuXG4gIC8vICM4NCDigJQgUkVUVVJOUyBBIFZFUkRJQ1QuIFByZXZpb3VzbHkgdm9pZCwgc28gdGhlIC9jbWQgcm91dGUgaGFkIG5vdGhpbmcgdG9cbiAgLy8gcmVwb3J0IGFuZCBhbnN3ZXJlZCBhIGxpdGVyYWwge29rOnRydWV9IHRvIGV2ZXJ5IGNvbW1hbmQgaW5jbHVkaW5nIG9uZXMgaXRcbiAgLy8gZHJvcHBlZC4gTm90ZSB0aGUgZGVmZWN0IGlzIE5PVCBhIG1pc3NpbmcgYGF3YWl0YDogdGhpcyBoYW5kbGVyIGlzXG4gIC8vIHN5bmNocm9ub3VzLCBhbmQgaW1hZ28ncyB0d2luIElTIGNvcnJlY3RseSBhd2FpdGVkIGFuZCB3YXMgYnJva2VuIGFueXdheS5cbiAgLy8gVGhlIGZpeCBpcyB0aGF0IGEgZGVjaXNpb24gZXhpc3RzIGF0IGFsbC5cbiAgLy8gQ29udHJhY3QgMTM6IHRoZSB2ZXJkaWN0IG9yaWdpbmF0ZXMgaW4gdGhlIGNvZGUgb3duaW5nIHRoZSByZWNvZ25pc2VkIHNldC5cbiAgLy8gYjEyIHdpZGVucyB0aGUgUkVUVVJOIHdpdGhvdXQgd2lkZW5pbmcgdGhlIENPTlRSQUNUIOKAlCBhIGNvbW1hbmQgbWF5IGFuc3dlclxuICAvLyB3aXRoIGEgcmVzdWx0IG9iamVjdCBjYXJyeWluZyBpdHMgb3duIHBheWxvYWQgaW5zdGVhZCBvZiB0aGUgYm9vbGVhbi4gRXZlcnlcbiAgLy8gb3RoZXIgY29tbWFuZCBzdGlsbCByZXR1cm5zIGEgYmFyZSBib29sZWFuIGFuZCBpdHMgcmVzcG9uc2UgaXNcbiAgLy8gYnl0ZS1pZGVudGljYWwuIFNhbWUgc2hhcGUgYXMgaW1hZ28ncyBjb250ZXh0LmFkZCAoNWU2YWFjZCkuXG4gIHR5cGUgQWdlbnRWZXJkaWN0ID0gYm9vbGVhbiB8IHsgcmVjb2duaXNlZDogdHJ1ZTsgb2s6IHRydWU7IGRldGFpbDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfTtcbiAgY29uc3QgaGFuZGxlQWdlbnRNc2cgPSAobXNnOiBBZ2VudENvbW1hbmQpOiBBZ2VudFZlcmRpY3QgPT4ge1xuICAgIGlmIChtc2cudHlwZSA9PT0gXCJzYXlcIikge1xuICAgICAgYWRkTWVzc2FnZShzdGF0ZSwge1xuICAgICAgICBpZDogYG0tJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgIHdobzogXCJhZ2VudFwiLFxuICAgICAgICBraW5kOiBtc2cua2luZCA/PyBcImluZm9cIixcbiAgICAgICAgdGV4dDogbXNnLnRleHQsXG4gICAgICAgIGdyb3VuZDogW10sXG4gICAgICAgIHRzOiBEYXRlLm5vdygpLFxuICAgICAgfSk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChtc2cudHlwZSA9PT0gXCJjbG9zZVwiKSB7XG4gICAgICByZXNvbHZlRG9uZSh7IGNvZGU6IDAsIHJlYXNvbjogXCJjbG9zZVwiIH0pO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChtc2cudHlwZSA9PT0gXCJnZW4uYWRkXCIpIHtcbiAgICAgIGNvbnN0IGl0ID0gbWFrZUl0ZW0oe1xuICAgICAgICBpZDogYGdlbi0ke3JhbmRIZXgoNCl9YCxcbiAgICAgICAga2luZDogXCJnZW5cIixcbiAgICAgICAgdGl0bGU6IG1zZy5sYWJlbCA/PyBgcm91bmQgJHttc2cucm91bmR9YCxcbiAgICAgICAgc3JjOiBtc2cuc3JjLFxuICAgICAgICBtaW1lOiBcImltYWdlL3dlYnBcIixcbiAgICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgICBnZW46IHtcbiAgICAgICAgICBtb2RlbDogbXNnLm1vZGVsLFxuICAgICAgICAgIHByb21wdDogbXNnLnByb21wdCxcbiAgICAgICAgICBzZWVkOiBtc2cuc2VlZCA/PyBudWxsLFxuICAgICAgICAgIGNvc3Q6IG1zZy5jb3N0ID8/IG51bGwsXG4gICAgICAgICAgY3VzdG9tOiBtc2cuY3VzdG9tID8/IHt9LFxuICAgICAgICAgIHJvdW5kOiBtc2cucm91bmQsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIG1hdGVyaWFsaXplSXRlbShzZXNzaW9uRmlsZXNEaXIsIGl0KTtcbiAgICAgIC8vIGIxMiArICM4NyAodGhpcmQgc3BlbGwpIOKAlCBgaWYgKGFkZEl0ZW0oc3RhdGUsIGl0KSkgYnJvYWRjYXN0U3RhdGUoKWBcbiAgICAgIC8vIGRyb3BwZWQgdGhlIG11dGF0b3IncyBvdXRjb21lIGludG8gY29udHJvbCBmbG93IGFuZCBhbnN3ZXJlZCBvazp0cnVlXG4gICAgICAvLyBlaXRoZXIgd2F5LiBUd28gdGhpbmdzIHdlcmUgd3JvbmcgYW5kIG9ubHkgb25lIGlzIHdoYXQgdGhlIGNhcmQgc2FpZDpcbiAgICAgIC8vXG4gICAgICAvLyAgIFJFQUNIQUJMRSwgZXZlcnkgY2FsbDogdGhlIG1pbnRlZCBpZCB3YXMgRElTQ0FSREVELCBzbyB0aGUgYWdlbnQgdGhhdFxuICAgICAgLy8gICBqdXN0IGNyZWF0ZWQgYW4gaXRlbSBjb3VsZCBub3QgcmVmZXJlbmNlIGl0LiBUaGF0IGlzICM4NydzIGRlZmVjdCBpbiBhXG4gICAgICAvLyAgIHRoaXJkIGNvZGViYXNlIChpbWFnbyBjb250ZXh0LmFkZCwgYW5kIHRoaXMpLlxuICAgICAgLy9cbiAgICAgIC8vICAgTk9UIFJFQUNIQUJMRSBpbiBwcmFjdGljZTogdGhlIFwic2lsZW50IGRlZHVwZVwiLiBgaWRgIGlzIG1pbnRlZCBIRVJFXG4gICAgICAvLyAgIChgZ2VuLSR7cmFuZEhleCg0KX1gKSBhbmQgdGhlIGNhbGxlciBjYW5ub3Qgc3VwcGx5IG9uZSDigJQgYGJ1aWxkR2VuQ21kYFxuICAgICAgLy8gICBoYXMgbm8gaWQgZmllbGQsIGFuZCB0aGlzIGxpbmUgaWdub3JlcyBhbnkgdGhhdCBhcnJpdmVkIOKAlCBzbyBhZGRJdGVtXG4gICAgICAvLyAgIHJldHVybnMgZmFsc2Ugb25seSBvbiBhIDJeMzIgY29sbGlzaW9uLiBUaGUgYnJhbmNoIHdhcyBkZWFkLCBub3RcbiAgICAgIC8vICAgZGFuZ2Vyb3VzLiBJdCBpcyByZXBvcnRlZCBob25lc3RseSBub3cgcmF0aGVyIHRoYW4gcmVtb3ZlZCwgYmVjYXVzZSBhXG4gICAgICAvLyAgIGNvbGxpc2lvbiB0aGF0IERJRCBoYXBwZW4gd291bGQgb3RoZXJ3aXNlIGJlIHRoZSBzaWxlbnQgY2FzZS5cbiAgICAgIGNvbnN0IGFkZGVkID0gYWRkSXRlbShzdGF0ZSwgaXQpO1xuICAgICAgaWYgKGFkZGVkKSBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcmVjb2duaXNlZDogdHJ1ZSxcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIGRldGFpbDogeyBpZDogaXQuaWQsIG91dGNvbWU6IGFkZGVkID8gXCJjcmVhdGVkXCIgOiBcImFscmVhZHktcmVjb3JkZWRcIiB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKG1zZy50eXBlID09PSBcInN0eWxlLnNhdmVcIikge1xuICAgICAgY29uc3QgY2Fub25pY2FsSXRlbXMgPSBzdGF0ZS5saWJyYXJ5LmZpbHRlcigoaSkgPT4gaS5jYW5vbmljYWwgJiYgIWkuYXJjaGl2ZWQpO1xuICAgICAgY29uc3QgYWdyZWVkID0gc3RhdGUuc3R5bGVHdWlkZS5maWx0ZXIoKHMpID0+IHMuc3RhdHVzICE9PSBcImVtcHR5XCIgJiYgcy5jb250ZW50KTtcbiAgICAgIGNvbnN0IHRleHQgPSBhZ3JlZWRcbiAgICAgICAgLm1hcCgocykgPT4gcy5jb250ZW50KVxuICAgICAgICAuam9pbihcIiDCtyBcIilcbiAgICAgICAgLnNsaWNlKDAsIDI4MCk7XG4gICAgICBjb25zdCBzdHlsZSA9IHNhdmVTdHlsZShHTEFNT1VSX0hPTUUsIFBST0pFQ1RfS0VZLCB7XG4gICAgICAgIGlkOiBgc3R5bGUtJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgIGxhYmVsOiBtc2cubGFiZWwsXG4gICAgICAgIHRleHQsXG4gICAgICAgIHNlY3Rpb25zOiBzdGF0ZS5zdHlsZUd1aWRlLFxuICAgICAgICBjYW5vbmljYWxJdGVtcyxcbiAgICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgfSk7XG4gICAgICBzdGF0ZS50cmF5LnB1c2goc3R5bGUpO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAobXNnLnR5cGUgPT09IFwic3R5bGUuYXJjaGl2ZVwiKSB7XG4gICAgICBzZXRTdHlsZUFyY2hpdmVkKEdMQU1PVVJfSE9NRSwgUFJPSkVDVF9LRVksIG1zZy5pZCwgbXNnLmFyY2hpdmVkKTtcbiAgICAgIGFwcGx5QWdlbnRNc2coc3RhdGUsIG1zZyk7IC8vIGZsaXBzIHRoZSBpbi1tZW1vcnkgdHJheSBlbnRyeVxuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICAvLyBUaGUgZmFsbHRocm91Z2ggaXMgdGhlIG9ubHkgcGF0aCB0aGF0IGNhbiBiZSBVTlJFQ09HTklTRUQsIGFuZCB0aGVcbiAgICAvLyByZWR1Y2VyIGlzIHdoYXQga25vd3M6IGl0IG93bnMgdGhlIGNhc2UgbGlzdCwgc28gdGhlIHZlcmRpY3QgY29tZXMgZnJvbVxuICAgIC8vIHRoZXJlIHJhdGhlciB0aGFuIGZyb20gYSBzZWNvbmQgZW51bWVyYXRpb24gaGVyZS5cbiAgICBjb25zdCByZWNvZ25pc2VkID0gYXBwbHlBZ2VudE1zZyhzdGF0ZSwgbXNnKTtcbiAgICBpZiAocmVjb2duaXNlZCkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4gcmVjb2duaXNlZDtcbiAgfTtcblxuICAvLyAtLS0gYnJvd3NlciBtZXNzYWdlcyAoV2ViU29ja2V0KSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgaGFuZGxlQ2xpZW50TXNnID0gKG1zZzogQ2xpZW50VG9TZXJ2ZXIpID0+IHtcbiAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XG4gICAgICBjYXNlIFwiaXRlbS5hZGRcIjoge1xuICAgICAgICBjb25zdCBpdCA9IG1ha2VJdGVtKHtcbiAgICAgICAgICBpZDogYCR7bXNnLml0ZW0ua2luZH0tJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgICAga2luZDogbXNnLml0ZW0ua2luZCxcbiAgICAgICAgICB0aXRsZTogbXNnLml0ZW0udGl0bGUsXG4gICAgICAgICAgc3JjOiBtc2cuaXRlbS5zcmMsXG4gICAgICAgICAgdGV4dDogbXNnLml0ZW0udGV4dCxcbiAgICAgICAgICBtaW1lOiBtc2cuaXRlbS5taW1lID8/IFwiXCIsXG4gICAgICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgICB9KTtcbiAgICAgICAgbWF0ZXJpYWxpemVJdGVtKHNlc3Npb25GaWxlc0RpciwgaXQpO1xuICAgICAgICBpZiAoYWRkSXRlbShzdGF0ZSwgaXQpKSB7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgICBlbWl0RXZlbnQoe1xuICAgICAgICAgICAgdHlwZTogXCJpdGVtLmFkZFwiLFxuICAgICAgICAgICAgaXRlbTogbGVhbkl0ZW0oaXQpLFxuICAgICAgICAgICAgc2VsZWN0ZWRJZHM6IHN0YXRlLnNlbGVjdGVkSWRzLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcIml0ZW0uc2VsZWN0XCI6XG4gICAgICAgIHNlbGVjdEl0ZW1zKHN0YXRlLCBtc2cuaWRzKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5zdGFyXCI6XG4gICAgICAgIGlmIChzZXRTdGFyKHN0YXRlLCBtc2cuaWQsIG1zZy5zdGFycmVkKSkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5saWtlXCI6XG4gICAgICAgIGlmIChzZXRMaWtlKHN0YXRlLCBtc2cuaWQsIG1zZy5saWtlZCkpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIml0ZW0uYW5ub3RhdGVcIjpcbiAgICAgICAgLy8gQW1iaWVudDogdGhlIGh1bWFuJ3MgcGVyLWl0ZW0gbm90ZSBpcyBzdG9yZWQgKyBVSS1zeW5jZWQgKyBwZXJzaXN0ZWQsXG4gICAgICAgIC8vIGFuZCB0aGUgYWdlbnQgcmVhZHMgaXQgb24gZGVtYW5kIGZyb20gc3RhdGUgd2hlbiBpdCBsb29rcyBhdCB0aGUgaW1hZ2UuXG4gICAgICAgIC8vIEl0IGlzIE5PVCBwdXNoZWQgYXMgYW4gYWdlbnQgZXZlbnQg4oCUIGEgc3RpY2t5IG5vdGUsIG5vdCBhIHJlYWwtdGltZVxuICAgICAgICAvLyBzaWduYWwgKHNlZSB0aGUgZXZlbnQtdm9sdW1lIGxlc3NvbjsgYXZvaWRzIGludGVycnVwdGluZyB0aGUgYWdlbnQgb25cbiAgICAgICAgLy8gZXZlcnkgYmx1cikuXG4gICAgICAgIGlmIChhbm5vdGF0ZShzdGF0ZSwgbXNnLmlkLCBcImh1bWFuXCIsIG1zZy5odW1hbikpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIm1lc3NhZ2Uuc2VuZFwiOiB7XG4gICAgICAgIGNvbnN0IGdyb3VuZCA9IFsuLi5zdGF0ZS5zZWxlY3RlZElkc107XG4gICAgICAgIGFkZE1lc3NhZ2Uoc3RhdGUsIHtcbiAgICAgICAgICBpZDogYG0tJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgICAgd2hvOiBcInVzZXJcIixcbiAgICAgICAgICBraW5kOiBcImluZm9cIixcbiAgICAgICAgICB0ZXh0OiBtc2cudGV4dCxcbiAgICAgICAgICBncm91bmQsXG4gICAgICAgICAgdHM6IERhdGUubm93KCksXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcIm1lc3NhZ2UudXNlclwiLCB0ZXh0OiBtc2cudGV4dCwgZ3JvdW5kIH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmb2N1cy5zZXRcIjpcbiAgICAgICAgc2V0Rm9jdXMoc3RhdGUsIG1zZy5pZHMsIFwieW91XCIpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJmb2N1cy5jbGVhclwiOlxuICAgICAgICBjbGVhckZvY3VzKHN0YXRlKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5jYW5vbmljYWxcIjpcbiAgICAgICAgaWYgKHNldENhbm9uaWNhbChzdGF0ZSwgbXNnLmlkLCBtc2cuY2Fub25pY2FsKSkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5hcmNoaXZlXCI6XG4gICAgICAgIGlmIChzZXRJdGVtQXJjaGl2ZWQoc3RhdGUsIG1zZy5pZCwgbXNnLmFyY2hpdmVkKSkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwic3R5bGUuYnJpbmdJblwiOiB7XG4gICAgICAgIGNvbnN0IHN0eWxlID0gc3RhdGUudHJheS5maW5kKChzKSA9PiBzLmlkID09PSBtc2cuaWQpO1xuICAgICAgICBpZiAoIXN0eWxlKSBicmVhaztcbiAgICAgICAgY29uc3QgaXRlbUlkID0gYHN0eWxlLSR7c3R5bGUuaWR9YDtcbiAgICAgICAgaWYgKHN0YXRlLmxpYnJhcnkuc29tZSgoaSkgPT4gaS5pZCA9PT0gaXRlbUlkKSkgYnJlYWs7IC8vIGlkZW1wb3RlbnRcbiAgICAgICAgY29uc3QgY2Fub24gPSBtYXRlcmlhbGl6ZUNhbm9uKEdMQU1PVVJfSE9NRSwgUFJPSkVDVF9LRVksIHN0eWxlKTtcbiAgICAgICAgY29uc3QgaXQgPSBidWlsZFN0eWxlSXRlbShzdHlsZSwgY2Fub24sIERhdGUubm93KCkpO1xuICAgICAgICBpZiAoYWRkSXRlbShzdGF0ZSwgaXQpKSB7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcIml0ZW0uYWRkXCIsIGl0ZW06IGxlYW5JdGVtKGl0KSwgc2VsZWN0ZWRJZHM6IHN0YXRlLnNlbGVjdGVkSWRzIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICAvLyBHRVQgL2V2ZW50cz9zaW5jZT08aWQ+IOKAlCByZXBsYXksIHRoZW4gc3RheSBvcGVuIGZvciBsaXZlIGZyYW1lcyBwbHVzIGFcbiAgLy8gaGVhcnRiZWF0IGNvbW1lbnQuIE9uZSBjYWxsIGludG8gYGtpdC93aXJlL3NzZS50c2AsIHdoaWNoIGlzIHdoZXJlIHRoZVxuICAvLyB0ZWFyZG93biBmdW5uZWwgbGl2ZXM6IGBjYW5jZWwoKWAsIGByZXEuc2lnbmFsYCBhbmQgYSBmYWlsZWQgZW5xdWV1ZSBhbGxcbiAgLy8gcmVhY2ggaXQsIGF0IG1vc3Qgb25jZSwgYW5kIHRoYXQgZnVubmVsIGlzIHdoYXQgYm91bmRzIHRoZSBzdWJzY3JpYmVyIGNvdW50XG4gIC8vIHRoZSBpZGxlIHN3ZWVwIHJlYWRzLiBUaGUgb2xkIGNvcHkgaGVyZSByZWxpZWQgb24gYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgdG9cbiAgLy8gbm90aWNlIGEgZGVwYXJ0ZWQgY2xpZW50LCB3aGljaCB3YXMgTUVBU1VSRUQgb24gQnVuIDEuMy4xNCBub3QgdG8gd29yayDigJRcbiAgLy8gZW5xdWV1ZSBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gYnVmZmVycyBzaWxlbnRseSBhbmQgbmV2ZXIgdGhyb3dzIOKAlCBhbmQgaXQgd2FzXG4gIC8vIG5vdCB3aXJlZCB0byBgcmVxLnNpZ25hbGAgYXQgYWxsLCBzbyBhIGNsaWVudCB0aGF0IHZhbmlzaGVkIHdpdGhvdXRcbiAgLy8gY2FuY2VsbGluZyB3YXMgY291bnRlZCBhcyBwcmVzZW50IGZvciB0aGUgbGlmZSBvZiB0aGUgZGFlbW9uLlxuICAvL1xuICAvLyDimqAgQU5EIFRIRSBIRUFSVEJFQVQgSVMgTk8gTE9OR0VSIEEgTElURVJBTC4gSXQgd2FzIGAxNTAwMGAsIGhhcmQtY29kZWQgaGVyZSxcbiAgLy8gYmVzaWRlIGEgYEJ1bi5zZXJ2ZWAgYGlkbGVUaW1lb3V0OiAyNTVgIGFuZCBhIGNvbW1lbnQgZXhwbGFpbmluZyB0aGF0IHRoZSB0d29cbiAgLy8gYXJlIGNoYWluZWQuIFRoZXkgbm93IGNvbWUgZnJvbSBgLi9oZWFydGJlYXQudHNgLCB3aGljaCBkZXJpdmVzIHRoZSBwYWlyIOKAlCBzb1xuICAvLyB0aGUgaW52YXJpYW50IGhvbGRzIGZvciBhbnkgdmFsdWUsIG5vdCBvbmx5IGZvciB0aGUgdHdvIHRoYXQgaGFwcGVuZWQgdG8gYmVcbiAgLy8gd3JpdHRlbi5cbiAgY29uc3QgZXZlbnRzUmVzcG9uc2UgPSAocmVxOiBSZXF1ZXN0LCB1cmw6IFVSTCk6IFJlc3BvbnNlID0+IHtcbiAgICB0b3VjaCgpO1xuICAgIHJldHVybiBzc2VSZXNwb25zZSh7XG4gICAgICBsb2csXG4gICAgICBzaW5jZTogTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic2luY2VcIikgPz8gXCItMVwiLCAxMCksXG4gICAgICBoZWFydGJlYXRNczogU1NFX0hFQVJUQkVBVF9NUyxcbiAgICAgIGNsaWVudHM6IHNzZUNsaWVudHMsXG4gICAgICBzaWduYWw6IHJlcS5zaWduYWwsXG4gICAgICBvbk9wZW46IHRvdWNoLFxuICAgICAgb25DbG9zZTogdG91Y2gsXG4gICAgfSk7XG4gIH07XG5cbiAgLy8gLS0tIHNlcnZlIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzZXJ2ZXIgPSBCdW4uc2VydmUoe1xuICAgIHBvcnQ6IG9wdHMucG9ydCA/PyAwLFxuICAgIGhvc3RuYW1lOiBvcHRzLmhvc3QgPz8gXCIxMjcuMC4wLjFcIixcbiAgICByb3V0ZXMsXG4gICAgLy8g4puUIEhFTEQgU1NFIENPTk5FQ1RJT05TIERJRSBXSVRIT1VUIFRISVMuIEJ1bidzIGRlZmF1bHQgcmVxdWVzdFxuICAgIC8vIGlkbGVUaW1lb3V0IGlzIDEwcyBhbmQgYSBzZXJ2ZXItc2VudCBoZWFydGJlYXQgZG9lcyBOT1QgcmVzZXQgaXQsIHNvIGFuXG4gICAgLy8gU1NFIGNsaWVudCBpcyBjbG9zZWQgYmVmb3JlIHRoZSAxNXMgYDogaGJgIGJlbG93IGV2ZXIgZmlyZXMg4oCUIHRoZVxuICAgIC8vIGtlZXBhbGl2ZSBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzIGtlZXBpbmcgYWxpdmUgaXNcbiAgICAvLyBnb25lLCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IHJhdGUgd291bGQgbm90IGhhdmUgaGVscGVkLlxuICAgIC8vIDI1NSBpcyBCdW4ncyBtYXhpbXVtICgwIGlzIG5vdCBcImRpc2FibGVkXCIpLCBtYXRjaGluZyBib3VudHksIGdyYXBldmluZVxuICAgIC8vIGFuZCBtaW5kLW1hcHBlcjsgYXN0cm9sYWJlIGVudi10dW5lcyBpdCBhbmQgY2xhbXBzIHRoZSBoZWFydGJlYXQgdG8gaGFsZi5cbiAgICAvLyBGb3VuZCAyMDI2LTA5LTA4IGJ5IHRoZSBiYWNrZW5kIGR1cGxpY2F0aW9uIHJlY29uOiBmb3VyIHNwZWxscyBoYWQgaGl0XG4gICAgLy8gdGhpcyBhbmQgZml4ZWQgaXQsIHRocmVlIGhhZCBub3QsIGJlY2F1c2UgdGhlIGRhZW1vbiBzcGluZSBpcyBvbmUgZGVzaWduXG4gICAgLy8gaW1wbGVtZW50ZWQgc2l4IHRpbWVzLlxuICAgIGlkbGVUaW1lb3V0OiBJRExFX1RJTUVPVVRfU0VDLFxuICAgIGRldmVsb3BtZW50OiB7IGhtcjogbW9kZSA9PT0gXCJkZXZcIiB9LFxuICAgIGZldGNoKHJlcSwgc3J2KSB7XG4gICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwpO1xuICAgICAgY29uc3QgcGF0aCA9IHVybC5wYXRobmFtZTtcbiAgICAgIGlmIChwYXRoID09PSBcIi93c1wiKVxuICAgICAgICByZXR1cm4gc3J2LnVwZ3JhZGUocmVxKSA/IHVuZGVmaW5lZCA6IG5ldyBSZXNwb25zZShcInVwZ3JhZGUgcmVxdWlyZWRcIiwgeyBzdGF0dXM6IDQyNiB9KTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL3N0YXRlXCIpIHtcbiAgICAgICAgdG91Y2goKTtcbiAgICAgICAgY29uc3QgbGVhbiA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwibGVhblwiKSA9PT0gXCIxXCI7XG4gICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHtcbiAgICAgICAgICBzdGF0ZTogbGVhbiA/IGxlYW5TdGF0ZShzdGF0ZSkgOiBzdGF0ZSxcbiAgICAgICAgICBjdXJzb3I6IGxvZy5jdXJzb3IoKSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9ldmVudHNcIikgcmV0dXJuIGV2ZW50c1Jlc3BvbnNlKHJlcSwgdXJsKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9jbWRcIilcbiAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAudGhlbigoYikgPT4ge1xuICAgICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICAgIC8vICM4NCDigJQgcHJvcGFnYXRlIHRoZSBoYW5kbGVyJ3MgdmVyZGljdCBpbnN0ZWFkIG9mIGEgbGl0ZXJhbFxuICAgICAgICAgICAgLy8ge29rOnRydWV9LiBgYXBwbGllZGAgaXMgdGhlIGZpZWxkIGJvdW50eSBhbHJlYWR5IHVzZXNcbiAgICAgICAgICAgIC8vIChzZXJ2ZXIudHMgQXBwbHlSZXN1bHQpOyBubyBuZXcgdm9jYWJ1bGFyeSBpcyBtaW50ZWQgaGVyZS5cbiAgICAgICAgICAgIGNvbnN0IHZlcmRpY3QgPSBoYW5kbGVBZ2VudE1zZyhiIGFzIEFnZW50Q29tbWFuZCk7XG4gICAgICAgICAgICAvLyBBIGNvbW1hbmQgdGhhdCBhbnN3ZXJlZCB3aXRoIGl0cyBvd24gcmVzdWx0IGNhcnJpZXMgaXRzIHBheWxvYWQ7XG4gICAgICAgICAgICAvLyB0aGUgYm9vbGVhbiBwYXRoIGJlbG93IGlzIHVuY2hhbmdlZC5cbiAgICAgICAgICAgIGlmICh0eXBlb2YgdmVyZGljdCA9PT0gXCJvYmplY3RcIilcbiAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgYXBwbGllZDogdHJ1ZSwgLi4udmVyZGljdC5kZXRhaWwgfSk7XG4gICAgICAgICAgICBjb25zdCBhcHBsaWVkID0gdmVyZGljdDtcbiAgICAgICAgICAgIGlmICghYXBwbGllZCkge1xuICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbihcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgICBhcHBsaWVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgIGVycm9yOiBgdW5yZWNvZ25pc2VkIGNvbW1hbmQgdHlwZSAke0pTT04uc3RyaW5naWZ5KFxuICAgICAgICAgICAgICAgICAgICAoYiBhcyB7IHR5cGU/OiB1bmtub3duIH0pPy50eXBlLFxuICAgICAgICAgICAgICAgICAgKX0g4oCUIG5vdGhpbmcgd2FzIGFwcGxpZWRgLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgeyBzdGF0dXM6IDQwMCB9LFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgYXBwbGllZDogdHJ1ZSB9KTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoKSA9PiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwiYmFkIGpzb25cIiB9LCB7IHN0YXR1czogNDAwIH0pKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGguc3RhcnRzV2l0aChcIi9hc3NldHMvXCIpKSB7XG4gICAgICAgIGNvbnN0IG5hbWUgPSBkZWNvZGVVUklDb21wb25lbnQocGF0aC5zbGljZShcIi9hc3NldHMvXCIubGVuZ3RoKSk7XG4gICAgICAgIGlmIChuYW1lLmluY2x1ZGVzKFwiLi5cIikgfHwgbmFtZS5zdGFydHNXaXRoKFwiL1wiKSlcbiAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IGVycm9yOiBcIm5vdCBmb3VuZFwiIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgICAgIGNvbnN0IGYgPSBCdW4uZmlsZShqb2luKHNlc3Npb25GaWxlc0RpciwgbmFtZSkpO1xuICAgICAgICByZXR1cm4gZlxuICAgICAgICAgIC5leGlzdHMoKVxuICAgICAgICAgIC50aGVuKChvaykgPT5cbiAgICAgICAgICAgIG9rID8gbmV3IFJlc3BvbnNlKGYpIDogUmVzcG9uc2UuanNvbih7IGVycm9yOiBcIm5vdCBmb3VuZFwiIH0sIHsgc3RhdHVzOiA0MDQgfSksXG4gICAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIC8vIHJlbGVhc2U6IFwiL1wiIGFuZCB0aGUgaGFzaGVkIGNodW5rLSouanMvY3NzIGFyZSBzdGF0aWMgZGlzdCByZWFkcy4gRGV2XG4gICAgICAvLyBuZXZlciByZWFjaGVzIGhlcmUgZm9yIFwiL1wiIOKAlCB0aGUgcm91dGVzIHRhYmxlIGFib3ZlIGFuc3dlcnMgaXQgZmlyc3QuXG4gICAgICAvLyBUaGlzIHNpdHMgQUZURVIgL2Fzc2V0cy8sIHdoaWNoIHNlcnZlcyBzZXNzaW9uIGZpbGVzLCBub3QgZGlzdCBvbmVzLlxuICAgICAgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgIGNvbnN0IGFzc2V0ID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICBpZiAoYXNzZXQpIHJldHVybiBhc3NldDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwibm90IGZvdW5kXCIgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICB9LFxuICAgIHdlYnNvY2tldDoge1xuICAgICAgb3Blbih3cykge1xuICAgICAgICBzb2NrZXRzLmFkZCh3cyk7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGVtaXRUcmFuc2llbnQoeyB0eXBlOiBcImNvbm5lY3RlZFwiIH0pO1xuICAgICAgICB3cy5zZW5kKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJzdGF0ZVwiLCBzdGF0ZSB9KSk7XG4gICAgICB9LFxuICAgICAgbWVzc2FnZShfd3MsIHJhdykge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGhhbmRsZUNsaWVudE1zZyhcbiAgICAgICAgICAgIEpTT04ucGFyc2UoXG4gICAgICAgICAgICAgIHR5cGVvZiByYXcgPT09IFwic3RyaW5nXCIgPyByYXcgOiBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUocmF3KSxcbiAgICAgICAgICAgICkgYXMgQ2xpZW50VG9TZXJ2ZXIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBnbGFtb3VyOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIGNsb3NlKHdzKSB7XG4gICAgICAgIHNvY2tldHMuZGVsZXRlKHdzKTtcbiAgICAgICAgZW1pdFRyYW5zaWVudCh7IHR5cGU6IFwiZGlzY29ubmVjdGVkXCIgfSk7XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGJvdW5kUG9ydCA9IHNlcnZlci5wb3J0O1xuICAvLyAtLS0gZGlzY292ZXJ5IGZpbGVzIChjbGkudHMgcmVhZHMgdGhlc2UpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc2Vzc2lvbkZpbGUgPSBqb2luKHRtcGRpcigpLCBgZ2xhbW91ci0ke3Nlc3Npb25JZH0uanNvbmApO1xuICBjb25zdCBsYXRlc3RGaWxlID0gam9pbih0bXBkaXIoKSwgYGdsYW1vdXItbGF0ZXN0Lmpzb25gKTtcbiAgY29uc3QgaW5mbyA9IEpTT04uc3RyaW5naWZ5KHtcbiAgICB1cmw6IGBodHRwOi8vJHtvcHRzLmhvc3QgPz8gXCIxMjcuMC4wLjFcIn06JHtib3VuZFBvcnR9YCxcbiAgICBwb3J0OiBib3VuZFBvcnQsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIHRpdGxlOiBzdGF0ZS50aXRsZSxcbiAgICBmaWxlc19kaXI6IHNlc3Npb25GaWxlc0RpcixcbiAgICBtb2RlLFxuICB9KTtcbiAgLy8g4pqgIEFUT01JQywgYmVjYXVzZSBjbGkudHMncyByZWFkU2Vzc2lvbiB0cmVhdHMgdW5wYXJzZWFibGUgY29udGVudCBhc1xuICAvLyBjb3JydXB0aW9uIHJhdGhlciB0aGFuIGFic2VuY2Ug4oCUIGFuZCB0aGlzIGltcGxlbWVudGF0aW9uIGlzIG5vd1xuICAvLyBga2l0L3dpcmUvZGlzY292ZXJ5LnRzYCwgc2hhcmVkIHdpdGggdGhlIHNpbmdsZXRvbiBjb252ZW50aW9uIEQzIGtlcHQgYWxpdmVcbiAgLy8gYmVzaWRlIHRoaXMgb25lLiBnbGFtb3VyIGlzIHdoZXJlIHRoZSBkZWZlY3QgKEwzKSB3YXMgZm91bmQgYW5kIGZpeGVkIG9uXG4gIC8vIDIwMjYtMDktMDc7IHdoYXQgc3RheWVkIGhlcmUgaXMgV0hJQ0ggZmlsZXMgZ2xhbW91ciB3cml0ZXMuXG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlQXRvbWljKHNlc3Npb25GaWxlLCBpbmZvKTtcbiAgICB3cml0ZUZpbGVBdG9taWMobGF0ZXN0RmlsZSwgaW5mbyk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGRpc2NvdmVyeSBpcyBiZXN0LWVmZm9ydCAqL1xuICB9XG5cbiAgLy8gQ29udHJhY3QgMTogdGhlIGRhZW1vbiBFTUlUUyBpdHMgcmVzb2x2ZWQgbW9kZSDigJQgYSBkZXYgZGFlbW9uIHdpdGggcm9vdCBkZXBzXG4gIC8vIHByZXNlbnQgcmVuZGVycyBhbiBpZGVudGljYWwtbG9va2luZyBib2FyZCwgc28gYG1vZGVgIGlzIHRoZSBvbmx5IHRoaW5nIHRoYXRcbiAgLy8gdGVsbHMgYSB2ZXJpZmllciB3aGljaCBwYXRoIHNlcnZlZCBpdC4gZ2xhbW91ciBoYXMgVEhSRUUgdHJhbnNwb3J0cyAoaW1hZ29cbiAgLy8gaGFzIHR3byk6IHRoaXMgZXZlbnQsIHRoZSBkaXNjb3ZlcnkgZmlsZSBhYm92ZSwgYW5kIHRoZSBzdGRvdXQgaGFuZHNoYWtlIGluXG4gIC8vIGltcG9ydC5tZXRhLm1haW4gYmVsb3cuIEFsbCB0aHJlZSBjYXJyeSBpdC5cbiAgZW1pdEV2ZW50KHsgdHlwZTogXCJyZWFkeVwiLCBtb2RlIH0pO1xuXG4gIC8vIC0tLSBzbmFwc2hvdCBkZWJvdW5jZSArIGlkbGUgc3dlZXAgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvL1xuICAvLyDim5QgVEhFIFNXRUVQIE5PVyBTRUVTIElUUyBTVUJTQ1JJQkVSUyDigJQgY2Vuc3VzIGRlZmVjdCBMMSwgY2xvc2VkIGJ5IHRoZSBzaGFyZWRcbiAgLy8gaG91c2VrZWVwZXIgUkVRVUlSSU5HIGEgYHN1YnNjcmliZXJDb3VudGAgcmF0aGVyIHRoYW4gYnkgYW55b25lIHJlbWVtYmVyaW5nLlxuICAvLyBUaGUgZXhwcmVzc2lvbiBoZXJlIHJlYWQgYChub3cgLSBsYXN0QWN0aXZpdHkpLzEwMDAgPj0gdGltZW91dGAgYW5kIG5vdGhpbmdcbiAgLy8gZWxzZSwgc28gYW4gYWdlbnQgaG9sZGluZyBhIGAvZXZlbnRzYCB0YWlsIG9uIGEgcXVpZXQgc2Vzc2lvbiB3YXMga2lsbGVkIFdJVEhcbiAgLy8gSVRTIENPTk5FQ1RJT04gT1BFTiBhdCB0aGUgMzAtbWludXRlIGZsb29yIOKAlCBnbGFtb3VyLCBpbWFnbyBhbmQgbWFncGllIGFsbFxuICAvLyBoYWQgaXQuIGB0aW1lb3V0YCBub3cgbWVhbnMgXCJsaW5nZXIgdGhpcyBsb25nIGFmdGVyIHRoZSBMQVNUIHN1YnNjcmliZXJcbiAgLy8gbGVhdmVzXCIsIG5vdCBcIm1heGltdW0gaWRsZSB3aGlsZSBjb25uZWN0ZWRcIi5cbiAgY29uc3Qgc2F2ZU5vdyA9ICgpID0+IHNhdmVTbmFwc2hvdChTTkFQU0hPVFNfRElSLCBzZXNzaW9uSWQsIHN0YXRlKTtcbiAgaWYgKHJlc3RvcmVkKSBzYXZlTm93KCk7XG4gIGNvbnN0IHRpbWVvdXRTID0gb3B0cy50aW1lb3V0UyA/PyAxODAwO1xuICBjb25zdCBzdG9wSG91c2VrZWVwaW5nID0gc3RhcnRIb3VzZWtlZXBpbmcoe1xuICAgIHN1YnNjcmliZXJDb3VudDogKCkgPT4gc29ja2V0cy5zaXplICsgc3NlQ2xpZW50cy5zaXplLFxuICAgIGlkbGVNczogKCkgPT4gcGVyZm9ybWFuY2Uubm93KCkgLSBsYXN0QWN0aXZpdHksXG4gICAgdG91Y2gsXG4gICAgdGltZW91dE1zOiB0aW1lb3V0UyAqIDEwMDAsXG4gICAgb25JZGxlQ2xvc2U6ICgpID0+IHJlc29sdmVEb25lKHsgY29kZTogMTI0LCByZWFzb246IFwidGltZW91dFwiIH0pLFxuICAgIHNuYXBzaG90OiB7XG4gICAgICBkaXJ0eTogKCkgPT4gc25hcERpcnR5LFxuICAgICAgY2xlYXI6ICgpID0+IHtcbiAgICAgICAgc25hcERpcnR5ID0gZmFsc2U7XG4gICAgICB9LFxuICAgICAgd3JpdGU6IHNhdmVOb3csXG4gICAgfSxcbiAgfSk7XG5cbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICAvLyBSZXNvbHZlcyBvbmNlIHRoZSBTU0UgZmx1c2ggKyBzZXJ2ZXIuc3RvcCBoYXZlIGJlZW4gc2NoZWR1bGVkOyBjYWxsZXJzXG4gIC8vIHRoYXQgbmVlZCB0byB3YWl0IChlLmcuIGltcG9ydC5tZXRhLm1haW4gYmVmb3JlIHByb2Nlc3MuZXhpdCkgY2FuIGF3YWl0IHRoaXMuXG4gIGxldCByZXNvbHZlU2h1dGRvd24hOiAoKSA9PiB2b2lkO1xuICBjb25zdCBzaHV0ZG93biA9IG5ldyBQcm9taXNlPHZvaWQ+KChyKSA9PiB7XG4gICAgcmVzb2x2ZVNodXRkb3duID0gcjtcbiAgfSk7XG5cbiAgLy8gVGhlIHNlc3Npb24gcG9pbnRlciBpcyB1bmNvbmRpdGlvbmFsbHkgb3VyczsgYGdsYW1vdXItbGF0ZXN0Lmpzb25gIGlzIE5PVCDigJRcbiAgLy8gYSBuZXdlciBzZXNzaW9uIG1heSBhbHJlYWR5IGhhdmUgY2xhaW1lZCBpdCwgYW5kIHVubGlua2luZyB0aGF0IHdvdWxkIG1ha2VcbiAgLy8gdGhlIGxpdmUgZGFlbW9uIGludmlzaWJsZSB0byB0aGUgbmV4dCB2ZXJiLiBgdW5saW5rSWZNYXRjaGVzYCdzIGBpZGVudGlmeWBcbiAgLy8gaG9vayBpcyB3aGF0IGxldHMgT05FIHNoYXJlZCBwcmVkaWNhdGUgc2VydmUgYm90aCB0aGlzIEpTT04gcG9pbnRlciBhbmRcbiAgLy8gYXN0cm9sYWJlJ3MgYmFyZSBwaWQgZmlsZSAoYGtpdC93aXJlL2Rpc2NvdmVyeS50c2ApLlxuICBjb25zdCBjbGVhbnVwRGlzY292ZXJ5ID0gKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICB1bmxpbmtTeW5jKHNlc3Npb25GaWxlKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGdvbmUg4oCUIGZpbmUgKi9cbiAgICB9XG4gICAgdW5saW5rSWZNYXRjaGVzKGxhdGVzdEZpbGUsIHNlc3Npb25JZCwgKHJhdykgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgaWQgPSAoSlNPTi5wYXJzZShyYXcpIGFzIHsgc2Vzc2lvbl9pZD86IHVua25vd24gfSkuc2Vzc2lvbl9pZDtcbiAgICAgICAgcmV0dXJuIHR5cGVvZiBpZCA9PT0gXCJzdHJpbmdcIiA/IGlkIDogbnVsbDtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICB9KTtcbiAgICB0cnkge1xuICAgICAgcm1TeW5jKHNlc3Npb25GaWxlc0RpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9O1xuXG4gIC8vIOKblCBTVEFZUyBTWU5DSFJPTk9VUyBBTkQgSURFTVBPVEVOVCwgYmVjYXVzZSBgZG9uZS50aGVuKCgpID0+IGNsb3NlKCkpYCBhbmRcbiAgLy8gdGhlIHN1aXRlcycgYGFmdGVyQWxsKCgpID0+IGQuY2xvc2UoKSlgIGJvdGggY2FsbCBpdCBhcyBhIHN0YXRlbWVudC4gVGhlXG4gIC8vIERSQUlOIGlzIHdoYXQgYmVjYW1lIGFzeW5jOiBgZHJhaW5BbmRTdG9wYCB3YWl0cyBpdHMgZ3JhY2UgcGVyaW9kLCBjbG9zZXNcbiAgLy8gZXZlcnkgcmVnaXN0ZXJlZCB0YWlsIHRocm91Z2ggdGhlIGZ1bm5lbCwgY2xvc2VzIHRoZSBzb2NrZXRzLCB0aGVuIFJBQ0VTXG4gIC8vIGBzZXJ2ZXIuc3RvcCh0cnVlKWAg4oCUIGJlY2F1c2UgdGhhdCBjYWxsIGF3YWl0cyBpdHMgY29ubmVjdGlvbnMgYW5kIG9uZSB3ZWRnZWRcbiAgLy8gcGVlciBpcyBlbm91Z2ggdG8gcGFyayB0ZWFyZG93biBmb3JldmVyIChhIDIzLW1pbnV0ZSBoYW5nIHNoaXBwZWQgb25jZSkuXG4gIC8vXG4gIC8vIOKaoCBUSEUgR1JBQ0UgUEVSSU9EIElTIDE1MCBtcywgTk9UIEdMQU1PVVInUyBPTEQgNTAsIGFuZCB0aGF0IGlzIGEgZGVsaWJlcmF0ZVxuICAvLyB3aXJlLW9ic2VydmFibGUgY2hhbmdlIHJhdGhlciB0aGFuIGFuIG92ZXJzaWdodDogMTUwIGlzIHRoZSBudW1iZXIgYWxsIGVpZ2h0XG4gIC8vIGRhZW1vbnMgY29udmVyZ2VkIG9uIGluZGVwZW5kZW50bHksIGFuZCBpdCBpcyB3aGF0IHR1cm5zIFwidGhlIGRhZW1vbiB0b2xkIHlvdVxuICAvLyB3aHkgaXQgZGllZFwiIGZyb20gYSBob3BlIGludG8gYW4gb2JzZXJ2YXRpb24uIGdsYW1vdXIncyBgY2xvc2VkYCBmcmFtZSBpcyB0aGVcbiAgLy8gb25lIHRoZSBDTEkncyB0YWlsIHdhdGNoZXMgZm9yLlxuICBjb25zdCBjbG9zZSA9ICgpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBzdG9wSG91c2VrZWVwaW5nKCk7XG4gICAgc2F2ZU5vdygpO1xuICAgIGNsZWFudXBEaXNjb3ZlcnkoKTtcbiAgICBlbWl0RXZlbnQoeyB0eXBlOiBcImNsb3NlZFwiIH0pO1xuICAgIHZvaWQgZHJhaW5BbmRTdG9wKHsgc2VydmVyLCBjbGllbnRzOiBzc2VDbGllbnRzLCBzb2NrZXRzIH0pLnRoZW4ocmVzb2x2ZVNodXRkb3duKTtcbiAgfTtcbiAgZG9uZS50aGVuKCgpID0+IGNsb3NlKCkpO1xuXG4gIHJldHVybiB7IHBvcnQ6IGJvdW5kUG9ydCwgc2Vzc2lvbklkLCBtb2RlLCBjbG9zZSwgZG9uZSwgc2h1dGRvd24gfTtcbn1cblxuLy8gIzgxIC8gRDQg4oCUIFRIRSBSRUNPR05JWkVEIFNFVCwgQVQgUEFSU0VSIEFMVElUVURFLiBUaGUgU0lYVEggZW50cnkgcG9pbnQuXG4vL1xuLy8g4pqgIFRISVMgT05FIEhBUyBaRVJPIGBmbGFncy5gIFJFQURTLCBzbyBhIGBmbGFncy5gLXBhdHRlcm4gYXVkaXQgcmV0dXJucyB6ZXJvXG4vLyBoZXJlIOKAlCBhbmQgYSB6ZXJvIHJlYWRzIGlkZW50aWNhbGx5IHRvIFwibm8gZHJpZnRcIi4gSXQgd2FzIGEgTE9PS1VQIHBhcnNlcjpcbi8vIGBjb25zdCBmbGFnID0gKG5hbWUpID0+IHsgY29uc3QgaSA9IGFyZ3MuaW5kZXhPZihgLS0ke25hbWV9YCk7IHJldHVybiBpID49IDBcbi8vID8gYXJnc1tpICsgMV0gOiB1bmRlZmluZWQ7IH1gLiBJdCBhbHNvIHJlYWQgYEJ1bi5hcmd2YCwgbm90IGBwcm9jZXNzLmFyZ3ZgLFxuLy8gd2hpY2ggaXMgdGhlIHN5bm9ueW0gdGhhdCBoYXMgbWFkZSB0aGlzIHJlcG8ncyBncmVwcyBsaWUgYmVmb3JlLlxuLy9cbi8vIEl0IGhhZCBhIExBVEVOVCwgUFJFLUVYSVNUSU5HIGJ1ZyB0aGUgY29udmVyc2lvbiBmaXhlcyBhcyBhIHNpZGUgZWZmZWN0LCBub3RlZFxuLy8gc28gdGhlIGNoYW5nZSBpcyBub3QgbWlzdGFrZW4gZm9yIGEgcmVncmVzc2lvbjogYGZsYWcoKWAgcmV0dXJuZWQgYGFyZ3NbaSsxXWBcbi8vIFVOQ09ORElUSU9OQUxMWSwgc28gYC0tcmVzdG9yZSAtLXRpdGxlIFhgIHlpZWxkZWQgYHJlc3RvcmUgPT09IFwiLS10aXRsZVwiYCDigJRcbi8vIHRoZSBuZXh0IEZMQUcgc2lsZW50bHkgY29uc3VtZWQgYXMgdGhlIHByZXZpb3VzIGZsYWcncyBWQUxVRS5cbi8vXG4vLyBBbGwgc2l4IGFyZSBzdHJpbmcgYnkgY29uc3RydWN0aW9uICh0aGUgb2xkIGhlbHBlciByZXR1cm5lZCB0aGUgbmV4dCBhcmd2XG4vLyBlbGVtZW50KS4gYHBvcnRgIGFuZCBgdGltZW91dGAgYXJlIE51bWJlcigpLWNvZXJjZWQgYXQgdGhlIGNhbGwgc2l0ZSwgd2hpY2ggaXNcbi8vIGEgdmFsdWUgcmVhZCwgbm90IGEgYm9vbGVhbiBvbmUuIFRoZSBkYWVtb24gdGFrZXMgbm8gcG9zaXRpb25hbHMsIHNvIHN0cmljdCdzXG4vLyBkZWZhdWx0IHJlamVjdGlvbiBvZiB0aGVtIGlzIGNvcnJlY3QuXG4vL1xuLy8gVmVyaWZpZWQgYmVmb3JlIGNvbnZlcnRpbmc6IGBjbGkudHNgIHNwYXducyB0aGlzIGRhZW1vbiB3aXRoIGV4YWN0bHkgLS10aXRsZSxcbi8vIC0taW50ZW50LCAtLXRpbWVvdXQsIC0tcmVzdG9yZSBhbmQgLS1wcm9qZWN0LCBhbGwgaW5zaWRlIHRoaXMgc2V0IOKAlCBzbyBzdHJpY3Rcbi8vIGNhbm5vdCByZWZ1c2UgdGhlIGRhZW1vbidzIG93biBsYXVuY2guXG5jb25zdCBEQUVNT05fT1BUSU9OUyA9IHtcbiAgaW50ZW50OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcG9ydDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHByb2plY3Q6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByZXN0b3JlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGltZW91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpdGxlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbn0gYXMgY29uc3Q7XG5cbi8qKiBQYXJzZSB0aGUgZGFlbW9uJ3MgYXJndiwgYm9vdCwgcHJpbnQgdGhlIGhhbmRzaGFrZSwgYW5kIHdhaXQgZm9yIHRoZSBlbmQuXG4gKiAgUmV0dXJucyB0aGUgcHJvY2VzcyBleGl0IGNvZGU7IGl0IGRvZXMgTk9UIGV4aXQg4oCUIHRoZSBsYXVuY2hlciBkb2VzLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD47XG4gIHRyeSB7XG4gICAgZmxhZ3MgPSBub2RlUGFyc2VBcmdzKHsgYXJnczogYXJndiwgb3B0aW9uczogREFFTU9OX09QVElPTlMsIHN0cmljdDogdHJ1ZSB9KS52YWx1ZXMgYXMgUmVjb3JkPFxuICAgICAgc3RyaW5nLFxuICAgICAgc3RyaW5nIHwgdW5kZWZpbmVkXG4gICAgPjtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYGdsYW1vdXI6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmAgK1xuICAgICAgICBgICByZWNvZ25pemVkIGZsYWdzOiAke09iamVjdC5rZXlzKERBRU1PTl9PUFRJT05TKVxuICAgICAgICAgIC5tYXAoKGspID0+IGAtLSR7a31gKVxuICAgICAgICAgIC5qb2luKFwiIFwiKX1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3QgZCA9IGF3YWl0IHN0YXJ0RGFlbW9uKHtcbiAgICBwb3J0OiBmbGFncy5wb3J0ID8gTnVtYmVyKGZsYWdzLnBvcnQpIDogMCxcbiAgICB0aXRsZTogZmxhZ3MudGl0bGUsXG4gICAgaW50ZW50OiBmbGFncy5pbnRlbnQsXG4gICAgcmVzdG9yZTogZmxhZ3MucmVzdG9yZSxcbiAgICB0aW1lb3V0UzogZmxhZ3MudGltZW91dCA/IE51bWJlcihmbGFncy50aW1lb3V0KSA6IHVuZGVmaW5lZCxcbiAgICBwcm9qZWN0OiBmbGFncy5wcm9qZWN0LFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7ZC5wb3J0fWAsIHBvcnQ6IGQucG9ydCwgc2Vzc2lvbl9pZDogZC5zZXNzaW9uSWQsIG1vZGU6IGQubW9kZSB9KX1cXG5gLFxuICApO1xuICBjb25zdCByZXMgPSBhd2FpdCBkLmRvbmU7XG4gIC8vIFdhaXQgZm9yIHRoZSBjbG9zZWQgU1NFIGV2ZW50IHRvIGZsdXNoIGJlZm9yZSBleGl0aW5nLlxuICBhd2FpdCBkLnNodXRkb3duO1xuICByZXR1cm4gcmVzLmNvZGU7XG59XG5cbi8qKlxuICogVGhlIGRhZW1vbidzIGVudHJ5LCBmb3IgdGhlIExBVU5DSEVSIGF0XG4gKiBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dsYW1vdXIvc2NyaXB0cy9zZXJ2ZXIudHNgLlxuICpcbiAqIOKblCBgaW1wb3J0Lm1ldGEubWFpbmAgSVMgRkFMU0UgSU4gVEhFIEJVTkRMRS4gYGRpc3Qvc2VydmVyLmpzYCBpcyBJTVBPUlRFRCBieVxuICogdGhlIGxhdW5jaGVyLCBuZXZlciBleGVjdXRlZCBhcyB0aGUgcHJvY2VzcyBlbnRyeSwgc28gdGhlIG9sZFxuICogYGlmIChpbXBvcnQubWV0YS5tYWluKWAgYmxvY2sgd291bGQgc2ltcGx5IG5ldmVyIHJ1biDigJQgdGhlIGRhZW1vbiB3b3VsZCBib290LFxuICogc2VydmUgbm90aGluZyBhbmQgZXhpdCAwLCBhbmQgZXZlcnkgdGVzdCB3b3VsZCBmYWlsIGFzIFwidGhlIGRhZW1vbiBuZXZlciBib3VuZFxuICogYSBwb3J0XCIsIHdoaWNoIHJlYWRzIGxpa2UgZmxha2UuIFRoYXQgaXMgdGhlIGZhaWx1cmUgdGhpcyBleHBvcnQgZXhpc3RzIHRvXG4gKiBwcmV2ZW50LCBhbmQgaXQgaXMgdGhlIGZpcnN0IHRoaW5nIHRoYXQgYnJlYWtzIG9uIGV2ZXJ5IGJhY2tlbmQgcmVsb2NhdGlvbi5cbiAqXG4gKiDim5QgQU5EIFRIRVJFIElTIE5PIGBpbXBvcnQubWV0YS5tYWluYCBCTE9DSyBMRUZULCBkZWxpYmVyYXRlbHkgKEQxMikuIFJ1biBmcm9tXG4gKiBgc3JjL2dsYW1vdXIvYmFja2VuZC9gLCBgU0tJTExfUk9PVGAgY29tcHV0ZXMgdG8gYHNyYy9nbGFtb3VyL2AsIHdoaWNoIGhvbGRzIG5vXG4gKiBgZGlzdC9pbmRleC5odG1sYCDigJQgc28gdGhlIGRhZW1vbiB3b3VsZCBzaWxlbnRseSBjaG9vc2UgREVWIG1vZGUgYW5kIHRoZW4gZmFpbFxuICogdGhlIGRldiBpbXBvcnQgZnJvbSB0aGUgd3JvbmcgYW5jaG9yLiBPZmZlcmluZyB0aGF0IGVudHJ5IHdvdWxkIGJlIG9mZmVyaW5nIGFcbiAqIHdyb25nIGRhZW1vbi5cbiAqXG4gKiDim5QgQU5EIElUIFRBS0VTIE5PIEFSR1VNRU5UUywgZm9yIHRoZSBzYW1lIHJlYXNvbiBgY2xpLnRzYCdzIGBydW4oKWAgZG9lcyBub3Q6XG4gKiB0aGUgY29tbWFuZCBsaW5lIGJlbG9uZ3MgdG8gdGhlIGZpbGUgdGhhdCBQQVJTRVMgaXQuIEEgbGF1bmNoZXIgdGhhdCB0b3VjaGVkXG4gKiBgcHJvY2Vzcy5hcmd2YCB3b3VsZCBtYXRjaCBgZ3JpbW9pcmUvbGliL2VudHJ5LXBvaW50cy50c2AncyBhcmctcGFyc2luZ1xuICogcHJlZGljYXRlIGFuZCB0aGUgd2FyZHMgd291bGQganVkZ2UgdGhpcyBkYWVtb24ncyBmbGFncyBhZ2FpbnN0IGEgZmlsZSB0aGF0XG4gKiByZWNvZ25pc2VzIG5vbmUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cbiIsCiAgICAiLy8gVGhlIHNpbmdsZSBzaGFyZWQgY29udHJhY3Qg4oCUIGltcG9ydGVkIGJ5IHNlcnZlci50cywgY2xpLnRzLCBhbmQgdGhlIHN1cmZhY2UuXG5cbmV4cG9ydCB0eXBlIEl0ZW1LaW5kID0gXCJyZWZcIiB8IFwiY29udGV4dFwiIHwgXCJnZW5cIiB8IFwic3R5bGVcIjtcbmV4cG9ydCBjb25zdCBWQUxJRF9LSU5EOiByZWFkb25seSBJdGVtS2luZFtdID0gW1wicmVmXCIsIFwiY29udGV4dFwiLCBcImdlblwiLCBcInN0eWxlXCJdIGFzIGNvbnN0O1xuXG4vLyBHZW5lcmF0aW9uIG1ldGFkYXRhIChHMSkuIEZ1bGx5IHBvcHVsYXRlZCBmb3Iga2luZCA9PT0gXCJnZW5cIiBpbiBTbGljZSAzO1xuLy8gdGhlIGZpZWxkIGV4aXN0cyBub3cgc28gdGhlIGNvbnRyYWN0IGFuZCB0aGUgZGV0YWlscyBmbHktb3V0IGFyZSBzdGFibGUuXG5leHBvcnQgdHlwZSBHZW5NZXRhID0ge1xuICBtb2RlbDogc3RyaW5nO1xuICBwcm9tcHQ6IHN0cmluZztcbiAgc2VlZDogbnVtYmVyIHwgbnVsbDtcbiAgY29zdDogbnVtYmVyIHwgbnVsbDtcbiAgY3VzdG9tOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICByb3VuZDogbnVtYmVyOyAvLyBiYXRjaCBpbmRleCB0aGUgYWdlbnQgc3RhbXBzOyBVSSBncm91cHMgZ2VuIGl0ZW1zIGJ5IGl0XG59O1xuXG4vLyBPbmUgY2F0YWxvZyBlbnRyeS4gU2hhcGUgZm9sbG93cyBpbWFnbydzIENvbnRleHRFbnRyeSBjb252ZW50aW9uczpcbi8vIGJsb2JzIChgc3JjYCwgYHRleHRgKSBhcmUgc3RyaXBwZWQgaW4gdGhlIGxlYW4gYWdlbnQgcHJvamVjdGlvbjsgdGhlIGFnZW50XG4vLyByZWFkcyBgcGF0aGAuIEFyY2hpdmFsIGlzIG5vbi1kZXN0cnVjdGl2ZSAodGhlIGBhcmNoaXZlZGAgZmxhZzsgdGhlIGl0ZW1cbi8vIHN1cnZpdmVzIGluIHRoZSBsaWJyYXJ5KS5cbmV4cG9ydCB0eXBlIExpYnJhcnlJdGVtID0ge1xuICBpZDogc3RyaW5nO1xuICBraW5kOiBJdGVtS2luZDtcbiAgdGl0bGU6IHN0cmluZztcbiAgc3JjOiBzdHJpbmc7IC8vIGltYWdlIGRhdGEtVVJMIChyZWYvZ2VuKTsgXCJcIiBvdGhlcndpc2Ug4oCUIHN0cmlwcGVkIGluIGxlYW5cbiAgcGF0aDogc3RyaW5nOyAvLyBvbi1kaXNrIG1hdGVyaWFsaXplZCBibG9iIHRoZSBhZ2VudCBjYW4gUmVhZDsgXCJcIiBpZiBub25lXG4gIHRleHQ6IHN0cmluZzsgLy8gY29udGV4dCBib2R5OyBcIlwiIG90aGVyd2lzZSDigJQgc3RyaXBwZWQgaW4gbGVhblxuICBtaW1lOiBzdHJpbmc7IC8vIGUuZy4gXCJpbWFnZS93ZWJwXCIsIFwidGV4dC9tYXJrZG93blwiXG4gIHRhZ3M6IHN0cmluZ1tdO1xuICBzdGFycmVkOiBib29sZWFuO1xuICBsaWtlZDogYm9vbGVhbjtcbiAgYW5ub3RhdGlvbnM6IHsgYWdlbnQ6IHN0cmluZzsgaHVtYW46IHN0cmluZyB9O1xuICBjYW5vbmljYWw6IGJvb2xlYW47IC8vIG1hcmtlZCBjYW5vbmljYWwgZm9yIHRoZSBzdHlsZSBiZWluZyBidWlsdCAobXVsdGksIG5vdCBzaW5nbGUtc2VsZWN0KVxuICBjYW5vbjogQ2Fub25JbWdbXTsgLy8gYSBraW5kOlwic3R5bGVcIiBpdGVtJ3MgY2Fub25pY2FsIHRodW1ibmFpbHM7IFtdIG90aGVyd2lzZSDigJQgc3RyaXBwZWQgaW4gbGVhblxuICBhcmNoaXZlZDogYm9vbGVhbjtcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIGdlbjogR2VuTWV0YSB8IG51bGw7XG59O1xuXG4vLyBDb252ZXJzYXRpb24uIEFnZW50IG1lc3NhZ2Uga2luZHMgY2FycnkgVjEncyBuYXJyYXRpb24gc2VtYW50aWNzXG4vLyAoaW5mbyB8IHdvcmtpbmcgfCByZXN1bHQgfCBlcnJvcik7IHVzZXIgbWVzc2FnZXMgYXJlIGFsd2F5cyBcImluZm9cIi5cbmV4cG9ydCB0eXBlIE1lc3NhZ2VLaW5kID0gXCJpbmZvXCIgfCBcIndvcmtpbmdcIiB8IFwicmVzdWx0XCIgfCBcImVycm9yXCI7XG5leHBvcnQgdHlwZSBNZXNzYWdlID0ge1xuICBpZDogc3RyaW5nO1xuICB3aG86IFwidXNlclwiIHwgXCJhZ2VudFwiO1xuICBraW5kOiBNZXNzYWdlS2luZDtcbiAgdGV4dDogc3RyaW5nO1xuICBncm91bmQ6IHN0cmluZ1tdOyAvLyBpdGVtIGlkcyBncm91bmRpbmcgdGhpcyBtZXNzYWdlIChzbmFwc2hvdCBvZiBzZWxlY3RlZElkcyk7IFtdIGlmIG5vbmVcbiAgdHM6IG51bWJlcjtcbn07XG5cbi8vIEEgYnJvdWdodC1pbiBzdHlsZSdzIGNhbm9uaWNhbCB0aHVtYm5haWwgKGRhdGEtVVJMIGBzcmNgIOKAlCBzdHJpcHBlZCBpbiBsZWFuKS5cbmV4cG9ydCB0eXBlIENhbm9uSW1nID0geyB0aXRsZTogc3RyaW5nOyBzcmM6IHN0cmluZyB9O1xuXG4vLyBBIGNhbm9uaWNhbCBpbWFnZSBpbnNpZGUgYSBTYXZlZFN0eWxlOiB0aGUgYmxvYiBpcyBjb3BpZWQgaW50byB0aGUgc3R5bGUnc1xuLy8gZGlyIG9uIHNhdmUgYW5kIHJlZmVyZW5jZWQgYnkgYGZpbGVgIChzbyB0aGUgc2F2ZWQgc3R5bGUgaXMgc2VsZi1jb250YWluZWQpLlxuZXhwb3J0IHR5cGUgQ2Fub25pY2FsUmVmID0ge1xuICBpZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBmaWxlOiBzdHJpbmc7XG4gIG1pbWU6IHN0cmluZztcbn07XG5cbi8vIEEgc3R5bGUgc2F2ZWQgdG8gdGhlIHByb2plY3QgdHJheSDigJQgYSBjb21wb3VuZCBcImNhbm9uaWNhbCBzaGFwZVwiOiB0aGUgY29kaWZpZWRcbi8vIHN0eWxlLWd1aWRlIHNlY3Rpb25zICh0ZXh0KSArIGNhbm9uaWNhbCBpbWFnZXMuIFByb2plY3Qtc2NvcGVkLCBub24tZGVzdHJ1Y3RpdmUuXG5leHBvcnQgdHlwZSBTYXZlZFN0eWxlID0ge1xuICBpZDogc3RyaW5nO1xuICBsYWJlbDogc3RyaW5nO1xuICB0ZXh0OiBzdHJpbmc7IC8vIHNob3J0IGh1bWFuIGRlc2NyaXB0aW9uIChlLmcuIHRoZSBVbmRlcnN0YW5kaW5nL0RpcmVjdGlvbiBnaXN0KVxuICBzZWN0aW9uczogU3R5bGVTZWN0aW9uW107IC8vIHRoZSBjb2RpZmllZCBzdHlsZSBndWlkZSBhdCBzYXZlIHRpbWVcbiAgY2Fub25pY2FsOiBDYW5vbmljYWxSZWZbXTtcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIGFyY2hpdmVkOiBib29sZWFuO1xufTtcblxuLy8gVGhlIGFnZW50LWFzc2VtYmxlZCBzdHlsZSBndWlkZS4gU2VjdGlvbiBzZXQgKyBsYWJlbHMgYXJlIHRoZSBtb2NrdXAnc1xuLy8gKHRoZSBjb252ZXJnZWQgc3VyZmFjZSkuIFNlY3Rpb25zIGZpbGwgaW46IGVtcHR5IOKGkiBmb3JtaW5nIOKGkiBhZ3JlZWQuXG5leHBvcnQgdHlwZSBTZWN0aW9uU3RhdHVzID0gXCJlbXB0eVwiIHwgXCJmb3JtaW5nXCIgfCBcImFncmVlZFwiO1xuZXhwb3J0IHR5cGUgU2VjdGlvbktleSA9XG4gIHwgXCJ1bmRlcnN0YW5kaW5nXCJcbiAgfCBcImRpcmVjdGlvblwiXG4gIHwgXCJwYWxldHRlXCJcbiAgfCBcImNvbnNpc3RlbmN5XCJcbiAgfCBcInByb21wdHNcIlxuICB8IFwiY2Fub25pY2FsXCI7XG4vLyBBIHBhbGV0dGUgc3dhdGNoIOKAlCBzdHJ1Y3R1cmVkIGNvbG9yIGZvciB0aGUgXCJwYWxldHRlXCIgc2VjdGlvbi5cbmV4cG9ydCB0eXBlIFN3YXRjaCA9IHsgaGV4OiBzdHJpbmc7IG5hbWU/OiBzdHJpbmcgfTtcbmV4cG9ydCB0eXBlIFN0eWxlU2VjdGlvbiA9IHtcbiAga2V5OiBTZWN0aW9uS2V5O1xuICBsYWJlbDogc3RyaW5nO1xuICBzdGF0dXM6IFNlY3Rpb25TdGF0dXM7XG4gIGNvbnRlbnQ6IHN0cmluZzsgLy8gcHJvc2VcbiAgcHJvbXB0czogc3RyaW5nW107IC8vIHBvcHVsYXRlZCBmb3IgdGhlIFwicHJvbXB0c1wiIHNlY3Rpb247IFtdIGVsc2V3aGVyZVxuICBjb2xvcnM6IFN3YXRjaFtdOyAvLyBwb3B1bGF0ZWQgZm9yIHRoZSBcInBhbGV0dGVcIiBzZWN0aW9uOyBbXSBlbHNld2hlcmVcbn07XG5cbi8vIFRoZSB6b29tL2ZvY3VzIGNvLXByZXNlbmNlIGxlbnMuIEVpdGhlciBwYXJ0eSBjYW4gc2NvcGUgdGhlIHNldC5cbmV4cG9ydCB0eXBlIEZvY3VzU2NvcGUgPSBcImFsbFwiIHwgXCJmb2N1c1wiO1xuZXhwb3J0IHR5cGUgRm9jdXNPd25lciA9IFwieW91XCIgfCBcImFnZW50XCIgfCBudWxsO1xuXG5leHBvcnQgdHlwZSBHbGFtb3VyU3RhdGUgPSB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGludGVudDogc3RyaW5nO1xuICBsaWJyYXJ5OiBMaWJyYXJ5SXRlbVtdO1xuICBzZWxlY3RlZElkczogc3RyaW5nW107IC8vIGxpbmtlZCBzZXQg4oCUIHRoZSBncm91bmRpbmcgc2V0ICh1bnNlbGVjdCDiiaAgZGVsZXRlKVxuICBtZXNzYWdlczogTWVzc2FnZVtdO1xuICBzdHlsZUd1aWRlOiBTdHlsZVNlY3Rpb25bXTtcbiAgdHJheTogU2F2ZWRTdHlsZVtdO1xuICBzY29wZTogRm9jdXNTY29wZTtcbiAgZm9jdXNTZXQ6IHN0cmluZ1tdOyAvLyBpdGVtIGlkcyBpbiB0aGUgZm9jdXNlZCBzZXQ7IGVtcHR5IHdoZW4gc2NvcGUgPT09IFwiYWxsXCJcbiAgZm9jdXNPd25lcjogRm9jdXNPd25lcjsgLy8gd2hvIHNjb3BlZCB0aGUgZm9jdXNcbiAgZm9jdXNOb3RlOiBzdHJpbmc7IC8vIGFnZW50J3MgY29udGV4dHVhbCBxdWVzdGlvbiBmb3IgdGhlIGZvY3VzIGRyYXdlcjsgXCJcIiBvdGhlcndpc2VcbiAgc3RhdHVzOiB7IGJ1c3k6IGJvb2xlYW47IHRleHQ6IHN0cmluZyB9O1xufTtcblxuLy8gTGVhbiBwcm9qZWN0aW9uIHNlbnQgdG8gdGhlIGFnZW50OiBibG9icyBzdHJpcHBlZCwgcGF0aHMga2VwdC5cbmV4cG9ydCB0eXBlIExlYW5JdGVtID0gT21pdDxMaWJyYXJ5SXRlbSwgXCJzcmNcIiB8IFwidGV4dFwiIHwgXCJjYW5vblwiPjtcbmV4cG9ydCB0eXBlIExlYW5TdGF0ZSA9IE9taXQ8R2xhbW91clN0YXRlLCBcImxpYnJhcnlcIj4gJiB7XG4gIGxpYnJhcnk6IExlYW5JdGVtW107XG59O1xuXG4vLyBTZXJ2ZXIg4oaSIGJyb3dzZXIgKFdlYlNvY2tldCkuIEZ1bGwtc3RhdGUgYnJvYWRjYXN0IGlzIHRoZSBvbmx5IGZyYW1lLlxuZXhwb3J0IHR5cGUgU2VydmVyVG9DbGllbnQgPSB7IHR5cGU6IFwic3RhdGVcIjsgc3RhdGU6IEdsYW1vdXJTdGF0ZSB9O1xuXG4vLyBCcm93c2VyIOKGkiBzZXJ2ZXIgKFdlYlNvY2tldCkuXG5leHBvcnQgdHlwZSBDbGllbnRUb1NlcnZlciA9XG4gIHwge1xuICAgICAgdHlwZTogXCJpdGVtLmFkZFwiO1xuICAgICAgaXRlbToge1xuICAgICAgICBraW5kOiBcInJlZlwiIHwgXCJjb250ZXh0XCI7XG4gICAgICAgIHRpdGxlOiBzdHJpbmc7XG4gICAgICAgIHNyYz86IHN0cmluZztcbiAgICAgICAgdGV4dD86IHN0cmluZztcbiAgICAgICAgbWltZT86IHN0cmluZztcbiAgICAgIH07XG4gICAgfVxuICB8IHsgdHlwZTogXCJpdGVtLnNlbGVjdFwiOyBpZHM6IHN0cmluZ1tdIH0gLy8gYW1iaWVudFxuICB8IHsgdHlwZTogXCJpdGVtLnN0YXJcIjsgaWQ6IHN0cmluZzsgc3RhcnJlZDogYm9vbGVhbiB9IC8vIGFtYmllbnRcbiAgfCB7IHR5cGU6IFwiaXRlbS5saWtlXCI7IGlkOiBzdHJpbmc7IGxpa2VkOiBib29sZWFuIH0gLy8gYW1iaWVudFxuICB8IHsgdHlwZTogXCJpdGVtLmFubm90YXRlXCI7IGlkOiBzdHJpbmc7IGh1bWFuOiBzdHJpbmcgfSAvLyBhbWJpZW50IOKAlCBzdG9yZWQgKyByZWFkIG9uIGRlbWFuZCwgbm90IHB1c2hlZCBhcyBhbiBldmVudFxuICB8IHsgdHlwZTogXCJtZXNzYWdlLnNlbmRcIjsgdGV4dDogc3RyaW5nIH0gLy8gaW1wZXJhdGl2ZVxuICB8IHsgdHlwZTogXCJmb2N1cy5zZXRcIjsgaWRzOiBzdHJpbmdbXSB9IC8vIGFtYmllbnQg4oCUIGh1bWFuIHNjb3BlcyBhIGZvY3VzIHNldFxuICB8IHsgdHlwZTogXCJmb2N1cy5jbGVhclwiIH0gLy8gYW1iaWVudCDigJQgaHVtYW4gem9vbXMgYmFjayBvdXRcbiAgfCB7IHR5cGU6IFwiaXRlbS5jYW5vbmljYWxcIjsgaWQ6IHN0cmluZzsgY2Fub25pY2FsOiBib29sZWFuIH0gLy8gYW1iaWVudFxuICB8IHsgdHlwZTogXCJpdGVtLmFyY2hpdmVcIjsgaWQ6IHN0cmluZzsgYXJjaGl2ZWQ6IGJvb2xlYW4gfSAvLyBhbWJpZW50XG4gIHwgeyB0eXBlOiBcInN0eWxlLmJyaW5nSW5cIjsgaWQ6IHN0cmluZyB9OyAvLyBpbXBlcmF0aXZlIOKAlCBhZGRzIGEga2luZDpcInN0eWxlXCIgaXRlbVxuXG4vLyBBZ2VudCDihpIgc2VydmVyIChIVFRQIFBPU1QgL2NtZCkuXG5leHBvcnQgdHlwZSBBZ2VudENvbW1hbmQgPVxuICB8IHsgdHlwZTogXCJpbml0XCI7IHRpdGxlPzogc3RyaW5nOyBpbnRlbnQ/OiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJpbnRlbnRcIjsgdGV4dDogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwiaXRlbS5hbm5vdGF0ZVwiOyBpZDogc3RyaW5nOyBhZ2VudDogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwic2F5XCI7IHRleHQ6IHN0cmluZzsga2luZD86IE1lc3NhZ2VLaW5kIH1cbiAgfCB7XG4gICAgICB0eXBlOiBcInNlY3Rpb25cIjtcbiAgICAgIGtleTogU2VjdGlvbktleTtcbiAgICAgIGNvbnRlbnQ/OiBzdHJpbmc7XG4gICAgICBzdGF0dXM/OiBTZWN0aW9uU3RhdHVzO1xuICAgICAgcHJvbXB0cz86IHN0cmluZ1tdO1xuICAgICAgY29sb3JzPzogU3dhdGNoW107XG4gICAgfVxuICB8IHtcbiAgICAgIHR5cGU6IFwiZ2VuLmFkZFwiO1xuICAgICAgc3JjOiBzdHJpbmc7IC8vIGFuIEFMUkVBRFktb3B0aW1pemVkIHdlYnAgZGF0YS1VUkwgKENMSSBkb2VzIHRoZSBvcHRpbWl6YXRpb24pXG4gICAgICBwcm9tcHQ6IHN0cmluZztcbiAgICAgIG1vZGVsOiBzdHJpbmc7XG4gICAgICByb3VuZDogbnVtYmVyO1xuICAgICAgc2VlZD86IG51bWJlcjtcbiAgICAgIGNvc3Q/OiBudW1iZXI7XG4gICAgICBsYWJlbD86IHN0cmluZztcbiAgICAgIGN1c3RvbT86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gICAgfVxuICB8IHsgdHlwZTogXCJnZW4uY29zdFwiOyBpZDogc3RyaW5nOyBjb3N0OiBudW1iZXIgfSAvLyBiYWNrZmlsbCBjb3N0IG9uY2UgbWVkaWEtZm9yZ2UgZmluYWxpemVzIGl0XG4gIHwgeyB0eXBlOiBcImdlbi5tZXRhXCI7IGlkOiBzdHJpbmc7IHByb21wdD86IHN0cmluZzsgY3VzdG9tPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB9IC8vIGJhY2tmaWxsIHRoZSByZWFsIHByb21wdCAvIHJlZnMgb250byBhIGdlblxuICB8IHsgdHlwZTogXCJmb2N1cy5wdXNoXCI7IGlkczogc3RyaW5nW107IG5vdGU/OiBzdHJpbmcgfSAvLyBhZ2VudCBzY29wZXMgYSBmb2N1cyBzZXQgKyBhc2tzXG4gIHwgeyB0eXBlOiBcInN0eWxlLnNhdmVcIjsgbGFiZWw6IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcInN0eWxlLmFyY2hpdmVcIjsgaWQ6IHN0cmluZzsgYXJjaGl2ZWQ6IGJvb2xlYW4gfVxuICB8IHsgdHlwZTogXCJzdGF0dXNcIjsgYnVzeTogYm9vbGVhbjsgdGV4dD86IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcImNsb3NlXCIgfTtcblxuLy8gVGhlIGNvbXBsZXRlIGFnZW50LWV2ZW50IHNldCAoc2VydmVyIOKGkiBhZ2VudCBTU0UpLiBPbmx5IHRoZXNlIGFyZSBlbWl0dGVkLlxuLy8gSW1wZXJhdGl2ZXMgb25seSDigJQgYm9hcmQgbW92ZXMgKHNlbGVjdC9zdGFyL2xpa2UpIGFyZSBhbWJpZW50LlxuZXhwb3J0IGNvbnN0IEFHRU5UX0VWRU5UX1RZUEVTID0gT2JqZWN0LmZyZWV6ZShbXG4gIFwicmVhZHlcIixcbiAgXCJjb25uZWN0ZWRcIixcbiAgXCJkaXNjb25uZWN0ZWRcIixcbiAgXCJpdGVtLmFkZFwiLFxuICBcIm1lc3NhZ2UudXNlclwiLFxuICBcImNsb3NlZFwiLFxuXSBhcyBjb25zdCk7XG5leHBvcnQgdHlwZSBBZ2VudEV2ZW50VHlwZSA9ICh0eXBlb2YgQUdFTlRfRVZFTlRfVFlQRVMpW251bWJlcl07XG5cbmV4cG9ydCBmdW5jdGlvbiBkZWZhdWx0U3R5bGVHdWlkZSgpOiBTdHlsZVNlY3Rpb25bXSB7XG4gIHJldHVybiBbXG4gICAge1xuICAgICAga2V5OiBcInVuZGVyc3RhbmRpbmdcIixcbiAgICAgIGxhYmVsOiBcIlVuZGVyc3RhbmRpbmdcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJkaXJlY3Rpb25cIixcbiAgICAgIGxhYmVsOiBcIkRpcmVjdGlvblwiLFxuICAgICAgc3RhdHVzOiBcImVtcHR5XCIsXG4gICAgICBjb250ZW50OiBcIlwiLFxuICAgICAgcHJvbXB0czogW10sXG4gICAgICBjb2xvcnM6IFtdLFxuICAgIH0sXG4gICAge1xuICAgICAga2V5OiBcInBhbGV0dGVcIixcbiAgICAgIGxhYmVsOiBcIlBhbGV0dGVcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJjb25zaXN0ZW5jeVwiLFxuICAgICAgbGFiZWw6IFwiQ29uc2lzdGVuY3lcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJwcm9tcHRzXCIsXG4gICAgICBsYWJlbDogXCJSZS1jYXN0IHByb21wdHNcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJjYW5vbmljYWxcIixcbiAgICAgIGxhYmVsOiBcIkNhbm9uaWNhbCBpbWFnZXNcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICBdO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGVmYXVsdFN0YXRlKHRpdGxlOiBzdHJpbmcsIGludGVudDogc3RyaW5nKTogR2xhbW91clN0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICB0aXRsZSxcbiAgICBpbnRlbnQsXG4gICAgbGlicmFyeTogW10sXG4gICAgc2VsZWN0ZWRJZHM6IFtdLFxuICAgIG1lc3NhZ2VzOiBbXSxcbiAgICBzdHlsZUd1aWRlOiBkZWZhdWx0U3R5bGVHdWlkZSgpLFxuICAgIHRyYXk6IFtdLFxuICAgIHNjb3BlOiBcImFsbFwiLFxuICAgIGZvY3VzU2V0OiBbXSxcbiAgICBmb2N1c093bmVyOiBudWxsLFxuICAgIGZvY3VzTm90ZTogXCJcIixcbiAgICBzdGF0dXM6IHsgYnVzeTogZmFsc2UsIHRleHQ6IFwiXCIgfSxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgdHdvIHByaW1pdGl2ZXMgdW5kZXIgQk9USCBvZiB0aGUgaG91c2UncyBkYWVtb24tZGlzY292ZXJ5IGNvbnZlbnRpb25zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogRDMgcnVsZWQgdGhhdCB0aGUgY29udmVudGlvbnMgdGhlbXNlbHZlcyDigJQgcGVyLXNlc3Npb24gdG1wZGlyIEpTT04gKGJvdW50eSxcbiAqIGdsYW1vdXIsIGltYWdvLCBtYWdwaWUpIGFuZCBzaW5nbGV0b24gYCRIT01FL2RhZW1vbi5wb3J0YCArIGBkYWVtb24ucGlkYFxuICogKGFzdHJvbGFiZSwgZ3JhcGV2aW5lLCBtaW5kLW1hcHBlcikg4oCUIGJvdGggc3Vydml2ZSwgYmVjYXVzZSB0aGV5IGVuY29kZVxuICogZ2VudWluZWx5IGRpZmZlcmVudCBtb2RlbHMgKGNvbmN1cnJlbnQgc2Vzc2lvbnMgdnMgYSBzdGFuZGluZyBzaW5nbGV0b24pIGFuZFxuICogcGlja2luZyBvbmUgaXMgYSBwcm9kdWN0IGRlY2lzaW9uLCBub3QgYSBmYWN0b3Jpbmcgb25lLiBXaGF0IElTIG9uZVxuICogaW1wbGVtZW50YXRpb24gaXMgdGhlIHBhaXIgYmVsb3csIHdoaWNoIGlzIGFsc28gZXhhY3RseSB3aGVyZSBjZW5zdXMgZGVmZWN0XG4gKiAqKkwzKiogbGl2ZXMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCByZW5hbWVTeW5jLCBybVN5bmMsIHVubGlua1N5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuXG4vKipcbiAqIFdyaXRlIGB0ZXh0YCB0byBgdGFyZ2V0YCBhdG9taWNhbGx5OiB3cml0ZSBiZXNpZGUgaXQsIHRoZW4gcmVuYW1lLlxuICpcbiAqIOKblCAqKkwzLCBDTE9TRUQgQlkgQ09OU1RSVUNUSU9OLioqIEEgYmFyZSBgd3JpdGVGaWxlU3luY2AgaXMgbm90IGF0b21pYywgc28gYVxuICogQ0xJIHJlYWRpbmcgd2hpbGUgdGhlIGRhZW1vbiB3cml0ZXMgY2FuIG9ic2VydmUgYSBIQUxGLVdSSVRURU4gcG9pbnRlci4gVW5kZXJcbiAqIGEgYmVzdC1lZmZvcnQgcmVhZGVyIHRoYXQgc3VyZmFjZWQgYXMgXCJubyBydW5uaW5nIHNlc3Npb25cIiDigJQgYWJzZW5jZSByZXBvcnRlZFxuICogZm9yIHdoYXQgd2FzIHJlYWxseSBhIHRvcm4gcmVhZCwgd2hpY2ggaXMgdGhlIGV4YWN0IGNvbmZsYXRpb24gdGhlIGhvdXNlJ3NcbiAqIGBudWxsYC1ub3QtYDBgIHJ1bGUgZXhpc3RzIHRvIHByZXZlbnQuIFJlbmFtZSB3aXRoaW4gb25lIGRpcmVjdG9yeSBpcyBhdG9taWMsXG4gKiBzbyBhIHJlYWRlciBzZWVzIGVpdGhlciB0aGUgcHJldmlvdXMgcG9pbnRlciBvciB0aGUgbmV3IG9uZSwgbmV2ZXIgYSBwYXJ0aWFsXG4gKiBmaWxlLlxuICpcbiAqIEZpeGVkIGluIGdsYW1vdXIgMjAyNi0wOS0wNywgZm91bmQgc3RhbmRpbmcgaW4gdGhyZWUgc2libGluZ3MgdGhlIG5leHQgZGF5IGJ5XG4gKiB0aGUgZHVwbGljYXRpb24gcmVjb24sIGFuZCByZXBhaXJlZCBpbiBhbGwgb2YgdGhlbSB0aGUgb25seSB3YXkgdGhhdCBkb2VzIG5vdFxuICogbmVlZCBmaW5kaW5nIGFnYWluOiB0aGVyZSBpcyBub3cgb25lIGltcGxlbWVudGF0aW9uLlxuICpcbiAqIOKaoCBUaGUgdGVtcCBuYW1lIGNhcnJpZXMgdGhlIHBpZCwgc28gdHdvIGRhZW1vbnMgcmFjaW5nIHRvIHB1Ymxpc2ggdGhlIHNhbWVcbiAqIHBvaW50ZXIgY2Fubm90IGNsb2JiZXIgZWFjaCBvdGhlcidzIGludGVybWVkaWF0ZSBmaWxlIOKAlCBhbmQgaXQgaXMgcmVtb3ZlZCBvblxuICogYSBmYWlsZWQgd3JpdGUgcmF0aGVyIHRoYW4gbGVmdCBhcyBsaXR0ZXIgYmVzaWRlIHRoZSByZWFsIG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlRmlsZUF0b21pYyh0YXJnZXQ6IHN0cmluZywgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHRtcCA9IGAke3RhcmdldH0uJHtwcm9jZXNzLnBpZH0udG1wYDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKHRtcCwgdGV4dCk7XG4gICAgcmVuYW1lU3luYyh0bXAsIHRhcmdldCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRyeSB7XG4gICAgICBybVN5bmModG1wLCB7IGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogdGhlIHRlbXAgZmlsZSBpcyBhbHJlYWR5IGdvbmUsIG9yIHdhcyBuZXZlciBjcmVhdGVkICovXG4gICAgfVxuICAgIHRocm93IGVycjtcbiAgfVxufVxuXG4vKipcbiAqIERlbGV0ZSBgcGF0aGAgaWZmIGl0IHN0aWxsIG5hbWVzIFVTLiBSZXR1cm5zIHdoZXRoZXIgaXQgd2FzIGRlbGV0ZWQuXG4gKlxuICog4puUICoqXCJTVElMTCBPVVJTXCIgSVMgVEhFIFdIT0xFIEZVTkNUSU9OLioqIEEgZGFlbW9uIHRoYXQgdW5saW5rcyBpdHMgZGlzY292ZXJ5XG4gKiBmaWxlIHVuY29uZGl0aW9uYWxseSBhdCBleGl0IGRlbGV0ZXMgdGhlIHBvaW50ZXIgYSBTVUNDRVNTT1IgaGFzIGFscmVhZHlcbiAqIHdyaXR0ZW4g4oCUIHRoZSBzdWNjZXNzb3IgY2FuIHRoZW4gbm8gbG9uZ2VyIGJlIGZvdW5kIGFuZCB0aGUgbmV4dCBDTEkgdmVyYiBzcGF3bnMgYVxuICogdGhpcmQgZGFlbW9uLiBCb3RoIGNvbnZlbnRpb25zIGhhdmUgdGhpcyBoYXphcmQgYW5kIGJvdGggZXhwcmVzcyBpdFxuICogZGlmZmVyZW50bHk6IGFzdHJvbGFiZSBjb21wYXJlcyB0aGUgcGlkIGZpbGUncyBieXRlcyB0byBpdHMgb3duIHBpZCxcbiAqIG1hZ3BpZSBwYXJzZXMgdGhlIEpTT04gcG9pbnRlciBhbmQgY29tcGFyZXMgYHNlc3Npb25faWRgLiBgaWRlbnRpZnlgIGlzIHdoYXRcbiAqIG1ha2VzIHRob3NlIG9uZSBmdW5jdGlvbiDigJQgaXQgdHVybnMgdGhlIGZpbGUncyBieXRlcyBpbnRvIHRoZSBpZGVudGl0eSB0b1xuICogY29tcGFyZSwgYW5kIGl0IGRlZmF1bHRzIHRvIHRoZSB0cmltbWVkIGJ5dGVzIHRoZW1zZWx2ZXMuXG4gKlxuICog4pqgIEV2ZXJ5IGZhaWx1cmUgaXMgc3dhbGxvd2VkIGFuZCByZXBvcnRlZCBhcyBgZmFsc2VgOiB0aGUgZmlsZSBiZWluZyBnb25lLFxuICogdW5yZWFkYWJsZSwgb3IgdW5wYXJzZWFibGUgYWxsIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZSDigJQgaXQgaXMgbm90IG91cnMgdG9cbiAqIHJlbW92ZS4gQW4gdW5wYXJzZWFibGUgcG9pbnRlciBpcyBkZWxpYmVyYXRlbHkgTk9UIHRyZWF0ZWQgYXMgb3Vycywgd2hpY2ggaXNcbiAqIHRoZSBjb25zZXJ2YXRpdmUgaGFsZiBvZiB0aGUgc2FtZSBgbnVsbGAtbm90LWAwYCBydWxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdW5saW5rSWZNYXRjaGVzKFxuICBwYXRoOiBzdHJpbmcsXG4gIGV4cGVjdGVkOiBzdHJpbmcsXG4gIGlkZW50aWZ5OiAocmF3OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGwgPSAocmF3KSA9PiByYXcudHJpbSgpLFxuKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGlkZW50aWZ5KHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpICE9PSBleHBlY3RlZCkgcmV0dXJuIGZhbHNlO1xuICAgIHVubGlua1N5bmMocGF0aCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBpbi1wcm9jZXNzIGV2ZW50IGxvZyDigJQgdGhlIGFwcGVuZC1vbmx5LCByZXBsYXlhYmxlIGJ1ZmZlclxuICogYmVoaW5kIGV2ZXJ5IHNwZWxsJ3MgYEdFVCAvZXZlbnRzYCBTU0UgdGFpbC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzXG4gKiBgc2NyaXB0cy9ldmVudHMudHNgIOKAlCB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMyLCBhbmQgdGhlIG9ubHkgb25lIG9mXG4gKiB0aGUgc2l4IGNvcGllZC1pbi1wbGFjZSBidXNlcyB0aGF0IGlzIGEgbW9kdWxlLCBpcyBib3VuZGVkLCBjYXJyaWVzIGFuIGVwb2NoLCBhbmQgaXNcbiAqIHVuaXQtdGVzdGVkLiBUaGUgZml2ZSBvdGhlcnMgYXJlIHRoZSBzYW1lIHR3ZW50eSBsaW5lcyB3cml0dGVuIGZpdmUgdGltZXMuXG4gKlxuICog4pSA4pSAIFRIRSBUSFJFRSBUSElOR1MgVEhJUyBGSVhFUyDigJQgVFdPIEJZIENPTlNUUlVDVElPTiwgT05FIEJZIE9QVC1JTiDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiDim5QgVEhFIEhFQURJTkcgVVNFRCBUTyBTQVkgXCJUSEUgVEhSRUUgVEhJTkdTIFRISVMgRklYRVMgQlkgQ09OU1RSVUNUSU9OXCIgQU5EXG4gKiBJVEVNIDIgSVMgTk9UIE9ORSBPRiBUSEVNLiBDb3JyZWN0ZWQgMjAyNi0wOS0wOSBpbiBtaW5kLW1hcHBlcidzIHByZS13b3JrXG4gKiAoRDc5KTogYGVwb2NoYCBpcyBPUFRJT05BTCBoZXJlLCBzbyBMNiBpcyBjbG9zZWQgb25seSBmb3IgYSBjYWxsZXIgdGhhdCBhc2tzLlxuICogVGhyZWUgYWRvcHRlcnMgaGF2ZSBzaW5jZSBkZWNsaW5lZCB0byDigJQgaW1hZ28gKEQzOSksIGJvdW50eSAoRDQ4KSBhbmRcbiAqIGdyYXBldmluZSAoRDcwKSDigJQgc28gdGhlIGRlZmVjdCB0aGUgaGVhZGluZyBjbGFpbWVkIHRvIG1ha2UgaW1wb3NzaWJsZSBpc1xuICogbGl2ZSBpbiB0aGUgdHJlZSwgYnkgb3B0LW91dCwgYW5kIHRoZSBvdmVyY2xhaW0gaXMgd2hhdCBoaWQgdGhhdC4gSXRlbXMgMSBhbmRcbiAqIDMgQVJFIGJ5IGNvbnN0cnVjdGlvbjogYSBjYWxsZXIgY2Fubm90IHN3aXRjaCB0aGUgY2FwIG9mZiBvciByZWFjaCB0aGUgYnVmZmVyLlxuICpcbiAqIOKaoCBBTkQgTUlORC1NQVBQRVInUyBPV04gQlVTLCBXSElDSCBUSElTIE1PRFVMRSBDT05WRVJHRUQgVE9XQVJELCBUWVBFUyBUSEVcbiAqIEVQT0NIIEFTIFJFUVVJUkVEIGFuZCBzdGFtcHMgaXQgdW5jb25kaXRpb25hbGx5IOKAlCBpdCBpcyB0aGUgc3BlbGwgY2Vuc3VzIEw2XG4gKiBuYW1lcyBhcyBDT1JSRUNULiBNYWtpbmcgaXQgcmVxdWlyZWQgSEVSRSBpcyBub3QgdGhlIHJlcGFpcjogaXQgd291bGQgcmV2ZXJzZVxuICogRDM5LCBENDggYW5kIEQ3MC4gVGhlIGhvbmVzdCBzdGF0ZW1lbnQgaXMgdGhpcyBoZWFkaW5nLlxuICpcbiAqIOKblCAqKlJFU09MVkVEIEFUIFRIQVQgU1BFTEwnUyBQT1JULCBBTkQgVEhFIERJU1BPU0lUSU9OIElTIFJFQ09SREVEIEhFUkVcbiAqIEJFQ0FVU0UgQSBMT1NTIFRIQVQgTElWRVMgT05MWSBJTiBBIEpPVVJOQUwgSVMgQSBMT1NTIE5PQk9EWSBDQU4gU0VFXG4gKiAoRDc5L0Q4NSkuKiogbWluZC1tYXBwZXIgYWRvcHRlZCB0aGlzIG1vZHVsZSBpbiBQaGFzZSA3IGFuZCBrZXB0IGl0c1xuICogZ3VhcmFudGVlIFdJVEhPVVQgQSBLSVQgQ0hBTkdFOiBpdCBwYXNzZXMgYHsgZXBvY2g6IGNyeXB0by5yYW5kb21VVUlEKCkgfWAgYXRcbiAqIGl0cyBPTkUgY29uc3RydWN0aW9uIHNpdGUgYW5kIHJlLXRpZ2h0ZW5zIGBlcG9jaGAgdG8gUkVRVUlSRUQgaW4gaXRzIG93blxuICogbG9jYWwgZnJhbWUgdHlwZSwgc28gbm90aGluZyBpdHMgYnVzIGVtaXRzIGNhbiBsYWNrIG9uZS4gS2l0IGJ5dGVzOiB6ZXJvLlxuICogKipTbyB0aGUgZXBvY2ggaXMgYSBMT1NTWS1DT1BZIHByb3BlcnR5IHdob3NlIGRpc3Bvc2l0aW9uIGlzIEtFRVAtTE9DQUwsIG5vdFxuICogUkVTVE9SRSoqIOKAlCB0aGUgb25seSBwcm9wZXJ0eSBvZiB0aGF0IHNwZWxsJ3Mgb3duIG1vZHVsZSB0aGlzIG1vZHVsZSBjb3VsZFxuICogbm90IGNhcnJ5IGFuZCBkaWQgbm90IG5lZWQgdG8uIEw2IGlzIENMT1NFRCBmb3IgdGhlIHR3byBzcGVsbHMgdGhhdCBhc2sgYW5kXG4gKiBPUEVOLCBieSBvcHQtb3V0LCBmb3IgdGhlIHRocmVlIHRoYXQgZGVjbGluZTsgdGhhdCBhc3ltbWV0cnkgaXMgdGhlIGhvbmVzdFxuICogc3RhdGUgYW5kIHRoaXMgaGVhZGluZyBpcyB3aGVyZSBpdCBpcyB3cml0dGVuLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgQURPUFRJT04gUkVOQU1FUyBBIEZJRUxEIE9OIEFOIEFET1BURVInUyBQVUJMSVNIRUQgV0lSRS4qKiBgaWRgXG4gKiBpcyBuYW1lZCBpbiBgRnJhbWU8VD5gIGFuZCBpbiB0aGUgZW1pdCBsaXRlcmFsIGJlbG93LCBzbyBhIHNwZWxsIHdob3NlIGJ1c1xuICogc3BlbGxlZCB0aGUgY3Vyc29yIGFueXRoaW5nIGVsc2UgcGF5cyBhIHJlbmFtZSBhdCBldmVyeSByZWFkZXIg4oCUIGZvclxuICogbWluZC1tYXBwZXIsIDE3MyBvY2N1cnJlbmNlcyBhY3Jvc3MgNSBzdXJmYWNlIGZpbGVzLCB+MjA5IGFjcm9zcyB+MzAgYmFja2VuZFxuICogZmlsZXMsIGV2ZXJ5IEpTT05MIGxpbmUgaXRzIGB0YWlsYCB3cml0ZXMgaW50byBhbiBhZ2VudCdzIHBpcGUsIGFuZCAodGhlIG9uZVxuICogbm9ib2R5IGNvdW50ZWQpIHRoZSBGSVhUVVJFIGluIGl0cyBvd24gYHRhaWwudGVzdC50c2AsIHdoaWNoIFdSSVRFUyB0aGVcbiAqIGVudmVsb3BlIHdoaWxlIHN0YW5kaW5nIGluIGZvciB0aGUgZGFlbW9uLiBUaGUgTkVTVElORyBpcyBub3QgZm9yY2VkIOKAlFxuICogYEZyYW1lPFQ+YCBpcyBnZW5lcmljLCBhbmQgbWluZC1tYXBwZXIga2VwdCBge2tpbmQsIHBheWxvYWR9YCBuZXN0ZWQgd2hlcmUgYWxsXG4gKiBmaXZlIGVhcmxpZXIgYWRvcHRlcnMgZmxhdHRlbiBieSBpZGlvbS4gKipBbiBpZGlvbSBmaXZlIHNpYmxpbmdzIHNoYXJlIGlzXG4gKiBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgY29udHJhY3QgdW50aWwgeW91IG9wZW4gdGhlIHR5cGUqKiAoRDgxLCBEODYpLlxuICpcbiAqICoqMSDCtyBMNSDigJQgdGhlIGJ1ZmZlciBpcyBib3VuZGVkLioqIEZpdmUgZGFlbW9ucyBhcHBlbmQgdG8gYW4gYXJyYXkgZm9yIHRoZVxuICogd2hvbGUgbGlmZSBvZiB0aGUgcHJvY2Vzcy4gVGhlIHdpbmRvdyBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogZGFlbW9uJ3MgbGlmZXRpbWUsIG5vdCBhIGR1cmFibGUgbG9nOyBhIGNhcCBpcyB0aGUgaG9uZXN0IHNoYXBlLlxuICpcbiAqICoqMiDCtyBMNiDigJQgYSBmcmFtZSBjYXJyaWVzIGFuIGVwb2NoLCBXSEVOIFRIRSBDQUxMRVIgQVNLUyBGT1IgT05FIChvcHQtaW4sXG4gKiBub3QgY29uc3RydWN0aW9uIOKAlCBzZWUgYWJvdmUpLioqIEFmdGVyIGEgcmVzdGFydCB0aGUgaWRzIHN0YXJ0IGFnYWluIGF0IDEsIHNvXG4gKiBhIHJlc3VtaW5nIGNsaWVudCBjYW5ub3QgdGVsbCBhIHN0YWxlIHdhdGVybWFyayBmcm9tIGEgZnJlc2ggb25lIGJ5IGlkIGFsb25lLlxuICpcbiAqICoqMyDCtyBBIFNUQUxFIFdBVEVSTUFSSyBSRVBMQVlTIEZST00gVEhFIEJFR0lOTklORywgYW5kIHRoaXMgaXMgdGhlIGhhbGYgdGhlXG4gKiBjbGllbnQgY2Fubm90IGRvLioqIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogYSB0YWlsIHRoYXQgcmVzdW1lcyBhdFxuICogYHNpbmNlPTxsYXN0IGlkIG9mIHRoZSBwcmV2aW91cyBkYWVtb24+YCBhZ2FpbnN0IGEgcmVzdGFydGVkIGRhZW1vbiByZWNlaXZlc1xuICogTk9USElORyDigJQgdGhlIG5ldyBkYWVtb24ncyBgcmVhZHlgIGlzIGlkIDEsIHdoaWNoIGlzIG5vdCBgPiBzaW5jZWAsIHNvIHRoZVxuICogZmlsdGVyIGRyb3BzIGl0LCBzbyBubyBmcmFtZSBhcnJpdmVzLCBzbyB0aGUgY2xpZW50J3MgZXBvY2ggY2hlY2sgbmV2ZXIgcnVuc1xuICogYW5kIHRoZSB0YWlsIHNpdHMgY29ubmVjdGVkIGFuZCBzaWxlbnQgdW50aWwgdGhlIG5ldyBkYWVtb24gaGFzIGVtaXR0ZWQgYXNcbiAqIG1hbnkgZXZlbnRzIGFzIHRoZSBvbGQgb25lIGRpZC4gU3RhbXBpbmcgYW4gZXBvY2ggYWxvbmUgZG9lcyBOT1QgY2xvc2UgdGhhdFxuICogZ2FwOiB0aGUgZXBvY2ggcmlkZXMgYSBmcmFtZSwgYW5kIHRoZSBidWcgaXMgdGhhdCBubyBmcmFtZSBpcyBzZW50LiBTb1xuICogYHN1YnNjcmliZWAgdHJlYXRzIGBzaW5jZSA+IGN1cnNvcmAgYXMgXCJ0aGlzIGN1cnNvciBpcyBmcm9tIGFub3RoZXIgcHJvY2Vzc1wiXG4gKiBhbmQgcmVwbGF5cyB3aG9sZS4gYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3RhaWwudGVzdC50c2AncyBlcG9jaCBjZWxsIGlzIHRoZVxuICogZXhlY3V0YWJsZSBzcGVjIG9mIHRoZSBjbGllbnQgaGFsZiBhbmQgc2hvd3MgdGhlIHJlY29ubmVjdCBzdGlsbCBjYXJyeWluZyB0aGVcbiAqIHN0YWxlIGN1cnNvciDigJQgZGV0ZWN0aW9uIGhhcHBlbnMgb24gd2hhdCBpcyBSRUNFSVZFRC5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBET0VTIE5PVCBBRE9QVCBUSElTLCBBTkQgVEhFIFJFRlVTQUwgSVMgUEFSVCBPRiBUSEUgUlVMSU5HIOKUgOKUgFxuICpcbiAqIFJFSkVDVC1TVFJVQ1RVUkFMLCBydWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLiBOb3RcbiAqIFwibm8gc3ViamVjdFwiIOKAlCBncmFwZXZpbmUgSEFTIGFuIGV2ZW50IGJ1cyBhbmQgaXQgaXMgdGhlIGJ1c2llc3QgdGhpbmcgaW4gdGhlXG4gKiBzcGVsbCDigJQgYnV0IHRoZSB0d28gc2hhcGVzIGNhbm5vdCBiZSBjb25zdHJ1Y3RlZCBmcm9tIGVhY2ggb3RoZXI6XG4gKlxuICogICB0aGlzIG1vZHVsZSAgb25lIHByb2Nlc3Mtd2lkZSBhcnJheSBjYXBwZWQgYXQgUkVQTEFZX0JVRkZFUl9TSVpFLCB3aXRoIG9uZVxuICogICAgICAgICAgICAgICAgbW9ub3RvbmljIGBzZXFgLCBhbmQgdGhlIGhlYWRlciB0aHJlZSBwYXJhZ3JhcGhzIHVwIHNheXMgaW4gYXNcbiAqICAgICAgICAgICAgICAgIG1hbnkgd29yZHMgdGhhdCBpdCBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogICAgICAgICAgICAgICAgZGFlbW9uJ3MgbGlmZXRpbWUsIE5PVCBhIGR1cmFibGUgbG9nLlxuICogICBncmFwZXZpbmUgICAgTiBkdXJhYmxlIGFwcGVuZC1vbmx5IGAuanNvbmxgIGZpbGVzLCBvbmUgcGVyIG5hbWVkIGNoYW5uZWwsXG4gKiAgICAgICAgICAgICAgICBlYWNoIHdpdGggaXRzIG93biBgbmV4dF9pZGAsIHJlcGxheWVkIGZyb20gZGlzayBieVxuICogICAgICAgICAgICAgICAgYHJlYWRCYWNrbG9nYCwgc3Vydml2aW5nIHJlc3RhcnQsIGByb2xsYCwgYXJjaGl2ZSBhbmQgY2xlYXIuXG4gKlxuICogKipUaGUgcmVhZGVyIHRoYXQgbWFrZXMgdGhlbSBpbmNvbXBhdGlibGUsIGFzIGEgbWVhc3VyZW1lbnQgcmF0aGVyIHRoYW4gYW5cbiAqIGFzc2VydGlvbjoqKiBncmFwZXZpbmUncyBgbG9hZENoYW5uZWwoKWAgZGVyaXZlcyBgbmV4dF9pZGAgYXMgYSBISUdILVdBVEVSXG4gKiBNQVJLIG92ZXIgZXZlcnkgcGFyc2VhYmxlIGxpbmUgb2YgdGhlIGNoYW5uZWwncyBmaWxlIG9uIGJvb3QuIFRoZXJlIGlzIG5vXG4gKiBhcnJheSB0byBiZSB0aGF0IG1hcmsgb2YsIGFuZCBubyBjYXAgdGhhdCB3b3VsZCBub3Qgc2lsZW50bHkgZGlzY2FyZCBoaXN0b3J5XG4gKiBhIGNhbGxlciBjYW4gc3RpbGwgYXNrIGZvciBieSBpZC4gSXQgaXMgdGhlIHRoaW5nIHRoaXMgbW9kdWxlJ3Mgb3duIGhlYWRlclxuICogc2F5cyBpdCBpcyBkZWxpYmVyYXRlbHkgbm90LlxuICpcbiAqICoqVGhlIHdpZGVuaW5nIE5PVCBkb25lLCB3aXRoIGl0cyBjb3N0OioqIGFkbWl0dGluZyBhIHBlci1jaGFubmVsIGR1cmFibGVcbiAqIHN0b3JlIHdvdWxkIGNoYW5nZSBgY3JlYXRlRXZlbnRMb2dgJ3Mgc3RvcmFnZSBhbmQgaXRzIGBzdWJzY3JpYmVgIGNvbnRyYWN0IGZvclxuICogZml2ZSBvdGhlciBkYWVtb25zLCByZS1lbWl0dGluZyBTSVggYXJ0aWZhY3RzIGFjcm9zcyBGSVZFIHNwZWxscywgZWFjaCBvd2VkIGFcbiAqIGRyaXZlIOKAlCBwYWlkIGJ5IHBvcnRzIHRoYXQgYXJlIGFscmVhZHkgZmluaXNoZWQgYW5kIGJ5IGFnZW50cyBub3QgaW4gdGhlIHJvb20uXG4gKiBBIHdpZGVuaW5nIHJlbWFpbnMgYXZhaWxhYmxlIGFzIGl0cyBvd24gYXJndWVkIGRlY2lzaW9uIHdpdGggaXRzIG93blxuICogYmxhc3QtcmFkaXVzIGNvdW50OyBpdCBpcyBuZXZlciBhIHN0ZXAgaW5zaWRlIGEgcG9ydC5cbiAqXG4gKiDimqAgQU5EIFRIRSBgZXBvY2hgIEFCT1ZFIElTIFRIRSBTSEFSUEVTVCBIQUxGIE9GIFdIWSAoRDcwKS4gR3JhcGV2aW5lJ3MgaWRzIGFyZVxuICogUkVDT1ZFUkVEIGFjcm9zcyBhIHJlc3RhcnQsIHNvIHRoZSBjb25kaXRpb24gcGFyYWdyYXBoIDIgZGVzY3JpYmVzIOKAlCBpZHNcbiAqIHN0YXJ0aW5nIGFnYWluIGF0IDEg4oCUIGNhbm5vdCBvY2N1ciB0aGVyZSwgYW5kIHN0YW1waW5nIG9uZSBhbnl3YXkgaXMgbm90XG4gKiBpbmVydDogYHRhaWxFdmVudHNgJ3MgYG9uRXBvY2hDaGFuZ2VgIHNldHMgdGhlIGN1cnNvciB0byAwLCBhbmQgZ3JhcGV2aW5lJ3NcbiAqIHRhaWwgcm91dGUgYW5zd2VycyBgc2luY2U9MGAgd2l0aCB0aGUgV0hPTEUgY2hhbm5lbCBsb2cgb2ZmIGRpc2ssIGludG8gYW5cbiAqIGFnZW50J3MgcGlwZSwgb24gZXZlcnkgYHJvbGxgLiBUaGUgZXBvY2gncyBjbGllbnQtc2lkZSBhY3Rpb24gaXMgXCJ5b3VyIGN1cnNvclxuICogaXMgd29ydGhsZXNzLCBzdGFydCBvdmVyXCIsIGFuZCB0aGF0IGlzIHNhZmUgb25seSB3aGVyZSBzdGFydGluZyBvdmVyIGNvc3RzIGFcbiAqIGJvdW5kZWQgaW4tbWVtb3J5IHJlcGxheSB3aW5kb3cuXG4gKi9cblxuLyoqIFRoZSBkZWZhdWx0IHJlcGxheSB3aW5kb3csIGluaGVyaXRlZCBmcm9tIG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgY2FwLiAqL1xuZXhwb3J0IGNvbnN0IFJFUExBWV9CVUZGRVJfU0laRSA9IDEwMDA7XG5cbi8qKiBBIGZyYW1lIGFzIGl0IGdvZXMgb24gdGhlIHdpcmU6IHRoZSBjYWxsZXIncyBwYXlsb2FkIHBsdXMgYSBtb25vdG9uaWMgYGlkYCxcbiAqICBwbHVzIGFuIGBlcG9jaGAgd2hlbiB0aGUgbG9nIHdhcyBnaXZlbiBvbmUuICovXG5leHBvcnQgdHlwZSBGcmFtZTxUPiA9IFQgJiB7IGlkOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH07XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRMb2c8VD4ge1xuICAvKiogQXBwZW5kIG9uZSBmcmFtZSwgZmFuIGl0IG91dCB0byBsaXZlIHN1YnNjcmliZXJzLCBhbmQgcmV0dXJuIGl0LiAqL1xuICBlbWl0KG1zZzogVCk6IEZyYW1lPFQ+O1xuICAvKipcbiAgICogUmVwbGF5IGV2ZXJ5dGhpbmcgYWZ0ZXIgYHNpbmNlYCwgdGhlbiBzdGF5IHN1YnNjcmliZWQuIFJldHVybnMgYW5cbiAgICogdW5zdWJzY3JpYmUgZnVuY3Rpb24uXG4gICAqXG4gICAqIOKblCBSRVBMQVkgQU5EIFNVQlNDUklCRSBBUkUgT05FIENBTEwgT04gUFVSUE9TRS4gRG9pbmcgdGhlbSBpbiB0d28gc3RlcHNcbiAgICogbGVhdmVzIGEgd2luZG93IGluIHdoaWNoIGFuIGVtaXQgbGFuZHMgYmV0d2VlbiB0aGUgcmVwbGF5IGxvb3AgYW5kIHRoZVxuICAgKiBgYWRkYCwgYW5kIHRoYXQgZnJhbWUgaXMgZGVsaXZlcmVkIHRvIG5vYm9keSDigJQgdGhlIHNoYXBlIGZpdmUgZGFlbW9ucyBoYXZlLFxuICAgKiBzdXJ2aXZlZCBieSBub3RoaW5nIGJ1dCB0aGUgc2luZ2xlLXRocmVhZGVkIGV2ZW50IGxvb3AgaGFwcGVuaW5nIHRvIGNsb3NlXG4gICAqIGl0LiBEZXBlbmRpbmcgb24gdGhhdCBpcyBkZXBlbmRpbmcgb24gYW4gaW1wbGVtZW50YXRpb24gZGV0YWlsIG9mIHRoZVxuICAgKiBydW50aW1lIHJhdGhlciB0aGFuIG9uIHRoZSBjb2RlLlxuICAgKi9cbiAgc3Vic2NyaWJlKHNpbmNlOiBudW1iZXIsIGxpc3RlbmVyOiAoZnJhbWU6IEZyYW1lPFQ+KSA9PiB2b2lkKTogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBoaWdoZXN0IGlkIGVtaXR0ZWQgc28gZmFyIOKAlCB3aGF0IGBHRVQgL3N0YXRlYCByZXR1cm5zIGFzIGBjdXJzb3JgLiAqL1xuICBjdXJzb3IoKTogbnVtYmVyO1xuICAvKiogVGhlIGVwb2NoIHN0YW1wZWQgb24gZXZlcnkgZnJhbWUsIG9yIGB1bmRlZmluZWRgIGlmIG5vbmUgd2FzIGNvbmZpZ3VyZWQuICovXG4gIHJlYWRvbmx5IGVwb2NoOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVFdmVudExvZzxUIGV4dGVuZHMgb2JqZWN0PihcbiAgb3B0czogeyBlcG9jaD86IHN0cmluZzsgYnVmZmVyU2l6ZT86IG51bWJlciB9ID0ge30sXG4pOiBFdmVudExvZzxUPiB7XG4gIGNvbnN0IGJ1ZmZlclNpemUgPSBvcHRzLmJ1ZmZlclNpemUgPz8gUkVQTEFZX0JVRkZFUl9TSVpFO1xuICBjb25zdCBlcG9jaCA9IG9wdHMuZXBvY2g7XG4gIGNvbnN0IGJ1ZmZlcjogQXJyYXk8RnJhbWU8VD4+ID0gW107XG4gIGNvbnN0IGxpc3RlbmVycyA9IG5ldyBTZXQ8KGZyYW1lOiBGcmFtZTxUPikgPT4gdm9pZD4oKTtcbiAgbGV0IHNlcSA9IDA7XG5cbiAgcmV0dXJuIHtcbiAgICBlcG9jaCxcblxuICAgIGVtaXQobXNnKSB7XG4gICAgICBzZXEgKz0gMTtcbiAgICAgIC8vIOKblCBUSEUgTU9OT1RPTklDIElEIFdJTlMgT1ZFUiBBTllUSElORyBJTiBUSEUgUEFZTE9BRCwgQU5EIFVOVElMIE5PVyBJVFxuICAgICAgLy8gT05MWSBDTEFJTUVEIFRPLiBCb3RoIGFkb3B0aW5nIGRhZW1vbnMgd3JvdGUgYHsgaWQ6ICsrc2VxLCAuLi5tc2cgfWBcbiAgICAgIC8vIHVuZGVyIGEgY29tbWVudCBzYXlpbmcgXCJ0aGUgbW9ub3RvbmljIGBpZGAgTVVTVCB3aW4gb3ZlciBhbnkgYGlkYCBpblxuICAgICAgLy8gdGhlIHBheWxvYWQsIHNvIGNhbGxlcnMgY2FycnkgYSBwcm9qZWN0IGlkZW50aWZpZXIgYXMgYHByb2plY3RJZGAsXG4gICAgICAvLyBuZXZlciBgaWRgXCIg4oCUIGJ1dCBzcHJlYWQgb3JkZXIgbWVhbnMgYSBwYXlsb2FkIGBpZGAgb3ZlcnJvZGUgdGhlXG4gICAgICAvLyBjdXJzb3IsIHNpbGVudGx5LCBhbmQgdGhlIGNvbnZlbnRpb24gaW4gdGhlIGNvbW1lbnQgd2FzIHRoZSBvbmx5IHRoaW5nXG4gICAgICAvLyBob2xkaW5nIGl0LiBUaGUgbGl0ZXJhbCBrZWVwcyBgaWRgIEZJUlNUIHNvIHRoZSB3aXJlIGtleSBvcmRlciBpc1xuICAgICAgLy8gdW5jaGFuZ2VkOyB0aGUgYXNzaWdubWVudCBhZnRlciB0aGUgc3ByZWFkIGlzIHdoYXQgbWFrZXMgdGhlIHNlbnRlbmNlXG4gICAgICAvLyB0cnVlLiBgZXBvY2hgIGlzIHN0YW1wZWQgdGhlIHNhbWUgd2F5IGFuZCBmb3IgdGhlIHNhbWUgcmVhc29uLlxuICAgICAgY29uc3QgZnJhbWUgPSB7IGlkOiBzZXEsIC4uLm1zZyB9IGFzIEZyYW1lPFQ+O1xuICAgICAgZnJhbWUuaWQgPSBzZXE7XG4gICAgICBpZiAoZXBvY2ggIT09IHVuZGVmaW5lZCkgZnJhbWUuZXBvY2ggPSBlcG9jaDtcblxuICAgICAgYnVmZmVyLnB1c2goZnJhbWUpO1xuICAgICAgaWYgKGJ1ZmZlci5sZW5ndGggPiBidWZmZXJTaXplKSBidWZmZXIuc2hpZnQoKTtcbiAgICAgIGZvciAoY29uc3QgbGlzdGVuZXIgb2YgbGlzdGVuZXJzKSBsaXN0ZW5lcihmcmFtZSk7XG4gICAgICByZXR1cm4gZnJhbWU7XG4gICAgfSxcblxuICAgIHN1YnNjcmliZShzaW5jZSwgbGlzdGVuZXIpIHtcbiAgICAgIC8vIFNlZSB0aGUgaGVhZGVyLCBwb2ludCAzOiBhIGN1cnNvciBiZXlvbmQgb3VyIG93biBpcyBhIGN1cnNvciBmcm9tIGFcbiAgICAgIC8vIFBSSU9SIFBST0NFU1MsIGFuZCB0aGUgb25seSB1c2VmdWwgcmVhZGluZyBvZiBpdCBpcyBcInJlcGxheSB3aG9sZVwiLlxuICAgICAgLy9cbiAgICAgIC8vIOKaoCBBIE5PTi1GSU5JVEUgQ1VSU09SIEFMU08gTUVBTlMgXCJGUk9NIFRIRSBTVEFSVFwiLCB3aGljaCB0aGUgY29waWVzIGdvdFxuICAgICAgLy8gd3JvbmcgYnkgYWNjaWRlbnQ6IHRoZXkgd3JvdGUgYHBhcnNlSW50KHBhcmFtID8/IFwiLTFcIilgIGFuZCBjb21wYXJlZFxuICAgICAgLy8gYGlkID4gc2luY2VgLCBzbyBhIHR5cG8nZCBgP3NpbmNlPXhgIHByb2R1Y2VkIGBOYU5gLCBldmVyeSBjb21wYXJpc29uXG4gICAgICAvLyB3YXMgZmFsc2UsIGFuZCB0aGUgdGFpbCBvcGVuZWQgRU1QVFkgYW5kIHN0YXllZCBjb25uZWN0ZWQg4oCUIHRoZSBzYW1lXG4gICAgICAvLyBzaWxlbnQtYW5kLWNvbm5lY3RlZCBzeW1wdG9tIGFzIHRoZSBzdGFsZSB3YXRlcm1hcmssIGZyb20gYSBkaWZmZXJlbnRcbiAgICAgIC8vIGNhdXNlLiBBYnNlbnQgYW5kIHVucGFyc2VhYmxlIGFyZSB0aGUgc2FtZSByZXF1ZXN0IGhlcmUuXG4gICAgICBjb25zdCBmcm9tID0gIU51bWJlci5pc0Zpbml0ZShzaW5jZSkgfHwgc2luY2UgPiBzZXEgPyAtMSA6IHNpbmNlO1xuICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBidWZmZXIpIHtcbiAgICAgICAgaWYgKGZyYW1lLmlkID4gZnJvbSkgbGlzdGVuZXIoZnJhbWUpO1xuICAgICAgfVxuICAgICAgbGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG4gICAgICByZXR1cm4gKCkgPT4ge1xuICAgICAgICBsaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcbiAgICAgIH07XG4gICAgfSxcblxuICAgIGN1cnNvcigpIHtcbiAgICAgIHJldHVybiBzZXE7XG4gICAgfSxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgZGFlbW9uIGxpZmVjeWNsZSB0YWlsOiB0aGUgaWRsZS1jbG9zZSBkZWNpc2lvbiwgdGhlIHN3ZWVwXG4gKiB0aGF0IG1ha2VzIGl0LCBhbmQgdGhlIGJvdW5kZWQgdGVhcmRvd24uXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgYm91bnR5IOKAlCB0aGUgY2Vuc3VzJ3NcbiAqIGNvbnZlcmdlbmNlIHRhcmdldCAjMyDigJQgd2l0aCBhc3Ryb2xhYmUncyBgdGltZW91dE1zID4gMGAgZ3VhcmQgZm9sZGVkIGluLFxuICogd2hpY2ggaXMgdGhlIG9uZSB0aGluZyBib3VudHkncyBjb3B5IGRvZXMgbm90IGV4cHJlc3MuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgQURPUFRTIGBkcmFpbkFuZFN0b3BgIEFORCBOT1RISU5HIEVMU0UgSEVSRSDigJQgU1BMSVQgUEVSIEVYUE9SVFxuICpcbiAqIFJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCksIGFuZCBpdCBpcyB3cml0dGVuIGRvd25cbiAqIGJlY2F1c2UgYSByb3cgaXMgYSBNT0RVTEUgYW5kIFwicGFydGlhbFwiIGlzIG5vdCBhbiBhbnN3ZXIgdW50aWwgaXQgc2F5cyB3aGljaFxuICogZXhwb3J0cy4gR3JhcGV2aW5lIGlzIGxvbmctcnVubmluZywgc28gbm90aGluZyBhYm91dCBpdHMgbGlmZWN5Y2xlIG1ha2VzIHRoaXNcbiAqIG1vZHVsZSByZWFkIGFzIGluYXBwbGljYWJsZSDigJQgYW5kIHR3byBvZiBpdHMgdGhyZWUgZXhwb3J0cyBzdGlsbCBoYXZlIG5vXG4gKiBzdWJqZWN0IHRoZXJlOlxuICpcbiAqICAgYHNob3VsZElkbGVDbG9zZWAgICAgICBOTyBTVUJKRUNULiBHcmFwZXZpbmUgcnVucyBubyBpZGxlIHN3ZWVwIGFuZCBoYXMgbm9cbiAqICAgYHN0YXJ0SG91c2VrZWVwaW5nYCAgICBgLS10aW1lb3V0YDsgaXQgaXMgYSBicm9rZXIgdGhhdCBzdGFuZHMgdW50aWwgYHN0b3BgXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgKGBERUxFVEUgL2ApIG9yIGEgc2lnbmFsLCBhbmQgaXQgdGFrZXMgbm8gc25hcHNob3QuXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgQWRvcHRpbmcgdGhlIHBhaXItbWFuYWdlciB3b3VsZCBtZWFuIHdyaXRpbmcgYSBuby1vcFxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGB0b3VjaGAgYW5kIGEgYHN1YnNjcmliZXJDb3VudGAgdGhhdCBleGlzdHMgb25seSB0b1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBhIG51bWJlciBub2JvZHkgYWN0cyBvbiDigJQgdHdvIGxpZXMgdG8gZ2FpbiBhXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYGNsZWFySW50ZXJ2YWxgLlxuICogICBgZHJhaW5BbmRTdG9wYCAgICAgICAgIEFET1BURUQsIGFuZCBpdCBpcyBhIERFLURVUExJQ0FUSU9OIHJhdGhlciB0aGFuIGFcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBnYWluOiBncmFwZXZpbmUncyB0ZWFyZG93biBhbHJlYWR5IFdBU1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBQcm9taXNlLnJhY2UoW3NlcnZlci5zdG9wKHRydWUpLCAyMDAgbXNdKWAsIHdoaWNoIGlzXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYHN0b3BNc2AgZXhhY3RseS5cbiAqXG4gKiDimqAgKipBTkQgSVQgSVMgQ0FMTEVEIFdJVEggTk8gYGNsaWVudHNgLCBXSElDSCBJUyBBIE1FQVNVUkVNRU5ULCBOT1QgQU5cbiAqIE9WRVJTSUdIVC4qKiBUaGlzIG1vZHVsZSBjbG9zZXMgYSBoZWxkIGNvbm5lY3Rpb24gYnkgY2FsbGluZyBgY2xpZW50LmNsb3NlKClgO1xuICogZ3JhcGV2aW5lJ3Mgc3Vic2NyaWJlciByZWNvcmRzIGFyZSBge2FsaWFzLCBodW1hbiwgbHVyaywgc2VuZH1gIGFuZCBjYXJyeSBub1xuICogYGNsb3NlYCDigJQgaXRzIHBlci1zdHJlYW0gdGVhcmRvd24gaXMgYSBjbG9zdXJlIHN0YXNoZWQgb24gdGhlIFJlYWRhYmxlU3RyZWFtXG4gKiBjb250cm9sbGVyLCByZWFjaGFibGUgb25seSBmcm9tIGBjYW5jZWwoKWAuIFRoZXJlIGlzIG5vdGhpbmcgdG8gaGFuZCB0aGVcbiAqIGFyZ3VtZW50LiBgc3NlLnRzYCdzIGhlYWRlciBjYXJyaWVzIHRoZSByZXN0IG9mIHRoYXQgcnVsaW5nLCBpbmNsdWRpbmcgdGhlXG4gKiB3aWRlbmluZyBub3QgZG9uZSBhbmQgaXRzIGNvc3QgKHNpeCBhcnRpZmFjdHMgYWNyb3NzIGZpdmUgc3BlbGxzKS5cbiAqXG4gKiDimqAgR3JhcGV2aW5lIGFsc28gcGFzc2VzIGBncmFjZU1zOiAwYC4gTm90IGEgZGlzYWdyZWVtZW50IHdpdGggdGhlIGdyYWNlXG4gKiBwZXJpb2Q6IGl0IGVtaXRzIG5vIGZhcmV3ZWxsIGZyYW1lIGF0IGRhZW1vbiBzaHV0ZG93biwgYW5kIGl0cyBgREVMRVRFIC9gXG4gKiBhbHJlYWR5IHJldHVybnMgdGhlIHJlc3BvbnNlIGFuZCBzY2hlZHVsZXMgdGhlIHRlYXJkb3duIDEwIG1zIGxhdGVyLCBzbyBpdHNcbiAqIGZsdXNoIHdpbmRvdyBzaXRzIGF0IHRoZSByb3V0ZSByYXRoZXIgdGhhbiBpbiB0aGUgZHJhaW4uXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTc2VDbGllbnRzIH0gZnJvbSBcIi4vc3NlLnRzXCI7XG5cbi8qKlxuICogU2hvdWxkIHRoZSBkYWVtb24gaWRsZS1jbG9zZT9cbiAqXG4gKiDim5QgKipgc3Vic2NyaWJlckNvdW50YCBJUyBBIFJFUVVJUkVEIEFSR1VNRU5ULCBBTkQgVEhBVCBJUyBUSEUgV0hPTEUgUE9JTlQuKipcbiAqIFRoaXMgY2xvc2VzIGNlbnN1cyBkZWZlY3QgKipMMSoqIGJ5IGNvbnN0cnVjdGlvbjogZ2xhbW91ciwgaW1hZ28gYW5kIG1hZ3BpZVxuICogY291bnRlZCB0aGVpciBpZGxlIGZsb29yIGRvd24gd2hpbGUgYW4gYWdlbnQgaGVsZCBhIHRhaWwgb3Blbiwgc28gYW4gYWdlbnRcbiAqIHdhdGNoaW5nIGEgcXVpZXQgYm9hcmQgd2FzIGtpbGxlZCBXSVRIIElUUyBDT05ORUNUSU9OIE9QRU4uIFRoZXJlIGlzIG5vXG4gKiBvdmVybG9hZCBvZiB0aGlzIGZ1bmN0aW9uIHRoYXQgY2Fubm90IHNlZSBpdHMgc3Vic2NyaWJlcnMsIHNvIHRoZSBkZWZlY3RcbiAqIGNhbm5vdCBiZSByZS1leHByZXNzZWQgYnkgYSBjYWxsZXIgd2hvIGZvcmdldHMuXG4gKlxuICog4puUICoqQU5EIFRIRSBTQ0FSIElUIENBTUUgV0lUSCwgcmUtaG9tZWQgZnJvbSBib3VudHkgdmVyYmF0aW0gaW4gc3Vic3RhbmNlOioqXG4gKiBhIGJvYXJkIG9ubHkgY291bnRzIGl0cyBpZGxlIGZsb29yIGRvd24gd2hpbGUgVU5XQVRDSEVELiBBIGxpdmUgc3Vic2NyaWJlciDigJRcbiAqIGEgYnJvd3NlciBXZWJTb2NrZXQsIG9yIGFuIGFnZW50IFNTRSB0YWlsIG9uIGAvZXZlbnRzYCDigJQga2VlcHMgaXQgb3BlblxuICogaW5kZWZpbml0ZWx5LiBTbyBgdGltZW91dGAgbWVhbnMgXCJsaW5nZXIgdGhpcyBsb25nIGFmdGVyIHRoZSBMQVNUIHN1YnNjcmliZXJcbiAqIGxlYXZlc1wiLCBOT1QgXCJtYXhpbXVtIGlkbGUgd2hpbGUgY29ubmVjdGVkXCIuIFRoZSBzd2VlcCBiZWxvdyBhbHNvIHRvdWNoZXMgdGhlXG4gKiBhY3Rpdml0eSBjbG9jayBvbiBldmVyeSB0aWNrIHdoaWxlIHdhdGNoZWQsIHNvIG9uY2UgdW53YXRjaGVkIHRoZSBmbG9vclxuICogY291bnRzIGZyb20gdGhhdCBsYXN0IGRpc2Nvbm5lY3QgYW5kIG5vdCBmcm9tIHRoZSBsYXN0IHJlcXVlc3QuXG4gKlxuICog4pqgIGB0aW1lb3V0TXMgPD0gMGAgbWVhbnMgTkVWRVIsIHdoaWNoIGlzIGFzdHJvbGFiZSdzIHN0YW5kaW5nLW9ic2VydmF0b3J5XG4gKiBkZWZhdWx0IGFuZCBpcyB3aHkgdGhlIGd1YXJkIGlzIGhlcmUgcmF0aGVyIHRoYW4gYXQgaXRzIG9uZSBjYWxsIHNpdGU6IGFcbiAqIHNpbmdsZXRvbiBkYWVtb24gaXMgbWVhbnQgdG8gc3RhbmQgdW50aWwgaXQgaXMgZXhwbGljaXRseSBjbG9zZWQsIGFuZCBhXG4gKiBgPj0gMGAgY29tcGFyaXNvbiB3b3VsZCBjbG9zZSBpdCBvbiB0aGUgZmlyc3QgdGljay5cbiAqXG4gKiBDbG9jay1mcmVlIGFuZCBmcy1mcmVlLCBzbyBpdCBpcyB0ZXN0YWJsZSB3aXRob3V0IGEgZGFlbW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkSWRsZUNsb3NlKFxuICBzdWJzY3JpYmVyQ291bnQ6IG51bWJlcixcbiAgaWRsZU1zOiBudW1iZXIsXG4gIHRpbWVvdXRNczogbnVtYmVyLFxuKTogYm9vbGVhbiB7XG4gIGlmICh0aW1lb3V0TXMgPD0gMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoc3Vic2NyaWJlckNvdW50ID4gMCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaWRsZU1zID49IHRpbWVvdXRNcztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBIb3VzZWtlZXBpbmdPcHRpb25zIHtcbiAgLyoqIOKblCBSRVFVSVJFRC4gU2VlIGBzaG91bGRJZGxlQ2xvc2VgIOKAlCB0aGlzIGlzIHdoYXQgY2xvc2VzIEwxLiAqL1xuICBzdWJzY3JpYmVyQ291bnQ6ICgpID0+IG51bWJlcjtcbiAgLyoqIE1pbGxpc2Vjb25kcyBzaW5jZSB0aGUgbGFzdCBhY3Rpdml0eS4gKi9cbiAgaWRsZU1zOiAoKSA9PiBudW1iZXI7XG4gIC8qKiBSZXNldCB0aGUgYWN0aXZpdHkgY2xvY2suIENhbGxlZCBvbiBldmVyeSB0aWNrIHRoYXQgaGFzIGEgc3Vic2NyaWJlci4gKi9cbiAgdG91Y2g6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgY29uZmlndXJlZCBpZGxlIHRpbWVvdXQgaW4gbXM7IGAwYCAob3IgbGVzcykgbWVhbnMgbmV2ZXIuICovXG4gIHRpbWVvdXRNczogbnVtYmVyO1xuICAvKiogRmlyZWQgb25jZSB3aGVuIHRoZSBkYWVtb24gc2hvdWxkIGNsb3NlIGl0c2VsZi4gKi9cbiAgb25JZGxlQ2xvc2U6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgZGVib3VuY2VkIHNuYXBzaG90LCBpZiB0aGUgc3BlbGwgaGFzIG9uZS4gKi9cbiAgc25hcHNob3Q/OiB7XG4gICAgZGlydHk6ICgpID0+IGJvb2xlYW47XG4gICAgY2xlYXI6ICgpID0+IHZvaWQ7XG4gICAgd3JpdGU6ICgpID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+O1xuICB9O1xuICAvKiogU3dlZXAgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDI1MCBtcy4gKi9cbiAgdGlja01zPzogbnVtYmVyO1xuICAvKiogU25hcHNob3QgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDEwMDAgbXMuICovXG4gIHNuYXBzaG90TXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogU3RhcnQgdGhlIHR3byBzdGFuZGluZyB0aW1lcnMgZXZlcnkgc2Vzc2lvbiBkYWVtb24gcnVucyDigJQgdGhlIGlkbGUgc3dlZXAgYW5kXG4gKiB0aGUgZGVib3VuY2VkIHNuYXBzaG90IOKAlCBhbmQgcmV0dXJuIHRoZSBmdW5jdGlvbiB0aGF0IHN0b3BzIGJvdGguXG4gKlxuICogVGhleSBhcmUgT05FIGNhbGwgYmVjYXVzZSB0aGV5IGhhdmUgYWx3YXlzIGJlZW4gb25lIGxpZmV0aW1lOiBldmVyeSBjb3B5XG4gKiBjbGVhcmVkIGJvdGggaW4gdGhlIHNhbWUgdHdvIGxpbmVzIGFmdGVyIGBhd2FpdCBkb25lYCwgYW5kIHRoZSBwYWlyIHRoYXQgZ2V0c1xuICogZm9yZ290dGVuIGlzIHRoZSBwYWlyIHdob3NlIHRpbWVycyBrZWVwIGEgcHJvY2VzcyBhbGl2ZSBhZnRlciB0ZWFyZG93bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0SG91c2VrZWVwaW5nKG9wdHM6IEhvdXNla2VlcGluZ09wdGlvbnMpOiAoKSA9PiB2b2lkIHtcbiAgY29uc3QgdGlja01zID0gb3B0cy50aWNrTXMgPz8gMjUwO1xuICBjb25zdCBzbmFwc2hvdE1zID0gb3B0cy5zbmFwc2hvdE1zID8/IDEwMDA7XG5cbiAgY29uc3QgaWRsZVRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIGNvbnN0IHN1YnNjcmliZXJzID0gb3B0cy5zdWJzY3JpYmVyQ291bnQoKTtcbiAgICBpZiAoc3Vic2NyaWJlcnMgPiAwKSBvcHRzLnRvdWNoKCk7XG4gICAgaWYgKHNob3VsZElkbGVDbG9zZShzdWJzY3JpYmVycywgb3B0cy5pZGxlTXMoKSwgb3B0cy50aW1lb3V0TXMpKSBvcHRzLm9uSWRsZUNsb3NlKCk7XG4gIH0sIHRpY2tNcyk7XG5cbiAgY29uc3Qgc25hcCA9IG9wdHMuc25hcHNob3Q7XG4gIGNvbnN0IHNuYXBUaW1lciA9IHNuYXBcbiAgICA/IHNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgaWYgKCFzbmFwLmRpcnR5KCkpIHJldHVybjtcbiAgICAgICAgc25hcC5jbGVhcigpO1xuICAgICAgICB2b2lkIHNuYXAud3JpdGUoKTtcbiAgICAgIH0sIHNuYXBzaG90TXMpXG4gICAgOiBudWxsO1xuXG4gIHJldHVybiAoKSA9PiB7XG4gICAgY2xlYXJJbnRlcnZhbChpZGxlVGltZXIpO1xuICAgIGlmIChzbmFwVGltZXIgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoc25hcFRpbWVyKTtcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEcmFpbk9wdGlvbnMge1xuICAvKiogVGhlIGJvdW5kIHNlcnZlci4gVHlwZWQgc3RydWN0dXJhbGx5IHNvIHRoZSBraXQgc3RheXMgZnJlZSBvZiBgYnVuYC4gKi9cbiAgc2VydmVyOiB7IHN0b3AoY2xvc2VBY3RpdmVDb25uZWN0aW9ucz86IGJvb2xlYW4pOiB1bmtub3duIH07XG4gIC8qKiBMaXZlIFNTRSB0YWlsczsgZXZlcnkgcmVnaXN0ZXJlZCBjbG9zZXIgaXMgaW52b2tlZC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBMaXZlIFdlYlNvY2tldHMuICovXG4gIHNvY2tldHM/OiBJdGVyYWJsZTx7IGNsb3NlKCk6IHZvaWQgfT47XG4gIC8qKiBIb3cgbG9uZyBxdWV1ZWQgZnJhbWVzIGdldCB0byBmbHVzaCBiZWZvcmUgYW55dGhpbmcgaXMgY2xvc2VkLiAqL1xuICBncmFjZU1zPzogbnVtYmVyO1xuICAvKiogSG93IGxvbmcgdGhlIGdyYWNlZnVsIHN0b3AgZ2V0cyBiZWZvcmUgdGVhcmRvd24gcHJvY2VlZHMgcmVnYXJkbGVzcy4gKi9cbiAgc3RvcE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIENsb3NlIGV2ZXJ5IGhlbGQgY29ubmVjdGlvbiBhbmQgc3RvcCB0aGUgc2VydmVyLCBpbiBib3VuZGVkIHRpbWUuXG4gKlxuICog4puUICoqVEhFIEdSQUNFIFBFUklPRCBJUyBOT1QgUE9MSVRFTkVTUy4qKiBBIGBjbG9zZWRgIGZyYW1lIGVtaXR0ZWQgYW5kIHRoZW5cbiAqIGZvbGxvd2VkIGltbWVkaWF0ZWx5IGJ5IGFuIGFnZ3Jlc3NpdmUgYHNlcnZlci5zdG9wKHRydWUpYCBpcyBhIGZyYW1lIHRoZVxuICogY2xpZW50IG5ldmVyIHNlZXMg4oCUIHRoZSBxdWV1ZSBnb2VzIHdpdGggdGhlIHNvY2tldC4gVGhlIDE1MCBtcyBpcyB3aGF0IHR1cm5zXG4gKiBcInRoZSBkYWVtb24gdG9sZCB5b3Ugd2h5IGl0IGRpZWRcIiBmcm9tIGEgaG9wZSBpbnRvIGFuIG9ic2VydmF0aW9uLCBhbmQgZXZlcnlcbiAqIG9uZSBvZiB0aGUgZWlnaHQgZGFlbW9ucyBjb252ZXJnZWQgb24gdGhhdCBudW1iZXIgaW5kZXBlbmRlbnRseS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNUT1AgSVMgUkFDRUQsIEJFQ0FVU0UgQSBTTE9XIFNPQ0tFVCBNVVNUIE5PVCBCRSBBQkxFIFRPIEhBTkdcbiAqIFRFQVJET1dOLioqIGBzZXJ2ZXIuc3RvcCh0cnVlKWAgYXdhaXRzIGl0cyBjb25uZWN0aW9uczsgb25lIHdlZGdlZCBwZWVyIGlzXG4gKiBlbm91Z2ggdG8gcGFyayBpdCBmb3JldmVyLCB3aGljaCBpcyBob3cgYSAyMy1taW51dGUgaGFuZyBzaGlwcGVkIG9uY2UuXG4gKlxuICog4pqgICoqV0hBVCBJUyBERUxJQkVSQVRFTFkgTk9UIEhFUkU6IGJvdW50eSdzIHNodXRkb3duIHdhdGNoZG9nLioqIEJvdW50eSBhcm1zXG4gKiBhIFJFRidkIGBzZXRUaW1lb3V0YCB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGlmIHRlYXJkb3duIGRvZXMgbm90IGZpbmlzaCxcbiAqIGFuZCB0aGUgY2Vuc3VzIGlzIHJpZ2h0IHRoYXQgaXQgaXMgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbFxuICogdGVybWluYXRpb24gZ3VhcmFudGVlLiBJdCBiZWxvbmdzIHRvIGJvdW50eSdzIFRFQVJET1dOIOKAlCB0aGUgc3RyZXRjaCB3aGVyZVxuICogbm90aGluZyBib3VuZHMgd2hhdCBpcyBiZWluZyB3YWl0ZWQgb24uIOKblCAqKlRISVMgUEFSQUdSQVBIIFNBSUQgXCJTSUdOQUxcbiAqIFBBVEhcIiBVTlRJTCBENTMsIEFORCBUSEUgQ09ERSBBR1JFRUQgV0lUSCBJVCwgV0hJQ0ggV0FTIFRIRSBERUZFQ1QuKiogQm91bnR5XG4gKiBoYXMgRk9VUiB3YXlzIGludG8gb25lIHRlYXJkb3duIChhIHNpZ25hbCwgYSBgY2xvc2VgIHZlcmIsIHRoZSBicm93c2VyJ3NcbiAqIGNsb3NlIG92ZXIgdGhlIFdlYlNvY2tldCwgYW4gaWRsZSB0aW1lb3V0KSBhbmQgb25seSB0aGUgc2lnbmFsIG9uZSBhcm1lZCB0aGVcbiAqIHRpbWVyLCB3aGlsZSB0aGUgY29tbWVudCBhYm92ZSBpdCBjbGFpbWVkIHRoZSBlbmRpbmcgd2FzIHVuY29uZGl0aW9uYWwuXG4gKiBEcml2ZW4gd2l0aCBhIHBsYW50ZWQgaGFuZzogdGhlIG90aGVyIHRocmVlIHJhbiBwYXN0IDEwIHMsIHRoZSBpZGxlIG9uZVxuICogaW5jbHVkZWQg4oCUIHRoZSBvcnBoYW4tZGFlbW9uIGNsYXNzIHRoZSAyMy1taW51dGUgaGFuZyBjYW1lIGZyb20uIFRoZSBhcm1pbmdcbiAqIG5vdyBsaXZlcyBpbiB0aGUgUkVTT0xWRSB0aGF0IGFsbCBmb3VyIGVudHJpZXMgcGFzcyB0aHJvdWdoLiAqKlRoZSBsZXNzb24gZm9yXG4gKiBhbiBhZG9wdGVyIGlzIHRoZSBjb3VudCwgbm90IHRoZSBwbGFjZW1lbnQ6IGVudW1lcmF0ZSBldmVyeSBlbnRyeSBpbnRvIHRoZVxuICogdGVhcmRvd24gYmVmb3JlIHlvdSBiZWxpZXZlIGEgZ3VhcmFudGVlIGNvdmVycyBpdC4qKiBUaGUgdHdvXG4gKiBkYWVtb25zIGFkb3B0aW5nIHRoaXMgbW9kdWxlIHJlZ2lzdGVyIG5vIHNpZ25hbCBoYW5kbGVycywgYW5kIHRoZWlyIHdob2xlXG4gKiB0ZWFyZG93biBpcyBib3VuZGVkIGJ5IHRoZSB0d28gbnVtYmVycyBhYm92ZTsgYWRkaW5nIGFuIGV4aXQgaGVyZSB3b3VsZCBwdXRcbiAqIHRoZSBob3VzZSdzIG9ubHkgdW5jb25kaXRpb25hbCBgcHJvY2Vzcy5leGl0YCBpbnNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgaXNcbiAqIGFib3V0IHRvIGJ1bmRsZSwgb25lIHBoYXNlIGFmdGVyIEQ4IHRvb2sgZXhhY3RseSB0aGF0IGhhemFyZCBPVVQgb2YgYGRpZWAuXG4gKlxuICog4puUICoqQU5EIFRIRSBTRU5URU5DRSBUSEFUIFVTRUQgVE8gRU5EIFRIQVQgUEFSQUdSQVBIIFdBUyBBIFBSRURJQ1RJT04sIFdISUNIXG4gKiBCT1VOVFknUyBPV04gUE9SVCBGQUxTSUZJRUQuKiogSXQgcmVhZDogXCJ3aGVuIGEgc3BlbGwgd2l0aCBhIHNpZ25hbCBwYXRoXG4gKiBhZG9wdHMgdGhpcywgdGhlIHdhdGNoZG9nIGFycml2ZXMgYXMgYW4gb3B0aW9uIG9uIHRoZXNlIGFyZ3VtZW50cyBhbmQgdGhlXG4gKiByZWFzb25pbmcgaXMgYWxyZWFkeSB3cml0dGVuIGRvd24uXCIgYm91bnR5IGFkb3B0ZWQgYGRyYWluQW5kU3RvcGAgb25cbiAqIDIwMjYtMDktMDkgKFBoYXNlIDQpIGFuZCB0aGUgb3B0aW9uIHdhcyBOT1QgYWRkZWQsIGJlY2F1c2UgdGhlIHdpbmRvdyBpc1xuICogd3JvbmcuICoqQSBgd2F0Y2hkb2dNc2Agb24gdGhlc2UgYXJndW1lbnRzIHdvdWxkIGFybSBhdCBEUkFJTiB0aW1lOyBib3VudHknc1xuICogYXJtcyBhdCBTSUdOQUwgdGltZSoqLCBhbmQgdGhlIHdob2xlIHJlYXNvbiBpdCBleGlzdHMgaXMgdGhlIHN0cmV0Y2ggQkVUV0VFTlxuICogdGhvc2UgdHdvIHBvaW50cyDigJQgYGF3YWl0IGRvbmVgLCBhbiBmcyBhcHBlbmQgdG8gdGhlIGRhZW1vbiBsb2csIGEgZnVsbFxuICogc25hcHNob3Qgd3JpdGUgdGhhdCBjYW4gcm90YXRlIGFuZCBDT1BZIGEgYmFja3VwIG9mIGEgbGFyZ2UgYm9hcmQsIGEgYGNsb3NlZGBcbiAqIGZyYW1lIGFuZCBhIGJyb2FkY2FzdC4gYGRyYWluQW5kU3RvcGAncyBvd24gYm9keSBpcyBhbHJlYWR5IGJvdW5kZWQgYnkgdGhlIHR3b1xuICogbnVtYmVycyBhYm92ZSwgc28gYSB3YXRjaGRvZyBzY29wZWQgdG8gaXQgd291bGQgZ3VhcmQgdGhlIG9uZSBzdHJldGNoIHRoYXRcbiAqIGNhbm5vdCBoYW5nIGFuZCBhYmFuZG9uIHRoZSBzdHJldGNoIHRoYXQgY2FuOiBpdCB3b3VsZCBSRUFEIGFzIGFkb3B0aW9uIGFuZFxuICogQkUgYSBuYXJyb3dpbmcgb2YgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbCB0ZXJtaW5hdGlvbiBndWFyYW50ZWUuIFRoZVxuICogMjMtbWludXRlIGhhbmcgdGhpcyBwcm9qZWN0IGtlZXBzIGNpdGluZyBoYXBwZW5lZCBpbiB0aGUgdW5ib3VuZGVkIHN0cmV0Y2guXG4gKlxuICog4pqgICoqU08gVEhFIFJVTEUgRk9SIFRIRSBORVhUIFNQRUxMLCBXSElDSCBJUyBUSEUgVFJBTlNGRVJBQkxFIEhBTEY6KiogdGhlXG4gKiBxdWVzdGlvbiBpcyBuZXZlciBcImRvZXMgdGhpcyBtb2R1bGUgaGF2ZSBhIHBsYWNlIHRvIHB1dCBhIHdhdGNoZG9nXCIgYnV0XG4gKiBcImRvZXMgdGhlIHdhdGNoZG9nJ3Mgd2luZG93IGNvaW5jaWRlIHdpdGggdGhpcyBtb2R1bGUnc1wiLiBXaGVyZSBhIHNwZWxsJ3NcbiAqIHRlYXJkb3duIGhhcyB1bmJvdW5kZWQgd29yayBCRUZPUkUgdGhlIGRyYWluLCB0aGUgd2F0Y2hkb2cgYmVsb25ncyBhdCB0aGVcbiAqIHNwZWxsLCB3cmFwcGVkIGFyb3VuZCBhbGwgb2YgaXQg4oCUIGFuZCBhcm91bmQgRVZFUlkgV0FZIElOLCB3aGljaCBpcyB0aGUgaGFsZlxuICogRDUzIGhhZCB0byByZXBhaXIgYWZ0ZXIgdGhpcyBoZWFkZXIgd2FzIHdyaXR0ZW4uIElmIGEgc3BlbGwgZXZlciBhcHBlYXJzIHdob3NlIHNpZ25hbCBwYXRoXG4gKiBlbnRlcnMgYGRyYWluQW5kU3RvcGAgaW1tZWRpYXRlbHksIGFkZCB0aGUgb3B0aW9uIFRIRU4g4oCUIGFuZCB0aGUgb3B0aW9uIG11c3RcbiAqIHRha2UgYW4gYG9uRXhwaXJlYCBjYWxsYmFjayByYXRoZXIgdGhhbiBleGl0aW5nLCBzbyB0aGUgYHByb2Nlc3MuZXhpdGAgc3RheXNcbiAqIG91dHNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgYnVuZGxlcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRyYWluQW5kU3RvcChvcHRzOiBEcmFpbk9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZ3JhY2VNcyA9IG9wdHMuZ3JhY2VNcyA/PyAxNTA7XG4gIGNvbnN0IHN0b3BNcyA9IG9wdHMuc3RvcE1zID8/IDIwMDtcblxuICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBncmFjZU1zKSk7XG5cbiAgaWYgKG9wdHMuY2xpZW50cykge1xuICAgIGZvciAoY29uc3QgY2xpZW50IG9mIFsuLi5vcHRzLmNsaWVudHNdKSBjbGllbnQuY2xvc2UoKTtcbiAgfVxuICBpZiAob3B0cy5zb2NrZXRzKSB7XG4gICAgZm9yIChjb25zdCB3cyBvZiBbLi4ub3B0cy5zb2NrZXRzXSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgd3MuY2xvc2UoKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBhbHJlYWR5IGdvbmUgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgIFByb21pc2UucmVzb2x2ZShvcHRzLnNlcnZlci5zdG9wKHRydWUpKSxcbiAgICBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBzdG9wTXMpKSxcbiAgXSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGFzc2V0LXNlcnZpbmcgdHJpbyBmb3IgYSBzcGVsbCBkYWVtb246IHdoaWNoIHN1cmZhY2UgbW9kZSB3ZVxuICogYXJlIGluLCB3aGF0IGNvbnRlbnQgdHlwZSBhIGZpbGUgZ2V0cywgYW5kIGhvdyBhIGZpbGUgdW5kZXIgYGRpc3QvYCBpc1xuICogYW5zd2VyZWQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwncyBhcnRpZmFjdC5cbiAqXG4gKiBFeHRyYWN0ZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBmcm9tIHRoZSBlaWdodCBgQnVuLnNlcnZlYCBiYWNrZW5kc1xuICogY2Vuc3VzZWQgaW4gYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC1kYWVtb24tc3BpbmUtY2Vuc3VzLm1kYCwgd2hpY2hcbiAqIG1lYXN1cmVkIGByZXNvbHZlTW9kZWAgYXMgYnl0ZS1pZGVudGljYWwgaW4gYWxsIGVpZ2h0ICh0aGUgb25seSBtZDUgZGlmZmVyZW5jZVxuICogYmVpbmcgdGhlIGBleHBvcnRgIGtleXdvcmQpLCB0aGUgY29udGVudC10eXBlIG1hcCBhcyBkaWZmZXJpbmcgaW4gZXhhY3RseVxuICogb25lIGNlbGwsIGFuZCB0aGUgZmlsZSBoYWxmIG9mIGBzZXJ2ZURpc3RgIGFzIGlkZW50aWNhbCBpbiBmaXZlLlxuICpcbiAqIOKUgOKUgCBXSEFUIERFTElCRVJBVEVMWSBESUQgTk9UIENPTUUgQUxPTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKipUaGUgVVJMLXRvLWZpbGVuYW1lIG1hcHBpbmcgc3RheXMgaW4gZWFjaCByb3V0ZXIuKiogVGhlIGNlbnN1cyBtYXJrZWQgdHdvXG4gKiBvZiB0aGUgZWlnaHQgYHNlcnZlRGlzdGAgZGl2ZXJnZW5jZXMgREVMSUJFUkFURSBhbmQgYm90aCBsaXZlIGluIHRoYXQgaGFsZjpcbiAqIGRpZ2VzdGlmeSBzdWJzdGl0dXRlcyBpbnRvIHRoZSBlbnRyeSBIVE1MIGluIG1lbW9yeSwgYW5kIGdyYXBldmluZSBzZXJ2ZXMgaXRzXG4gKiBzdXJmYWNlIGF0IGAvd2F0Y2hgIHJhdGhlciB0aGFuIGF0IGAvYC4gQSBzaWduYXR1cmUgd2lkZSBlbm91Z2ggdG8gYWJzb3JiXG4gKiB0aG9zZSBzdG9wcyBiZWluZyBhIGZpbGUgc2VydmVyIGFuZCBiZWNvbWVzIGEgcm91dGVyLiBTbyB0aGUgY2FsbGVyIGRlY2lkZXNcbiAqIFdISUNIIGZpbGUgKGBwYXRoID09PSBcIi9cIiA/IFwiaW5kZXguaHRtbFwiIDogcGF0aC5zbGljZSgxKWApLCBhbmQgdGhpcyBtb2R1bGVcbiAqIGRlY2lkZXMgd2hldGhlciB0aGF0IGZpbGUgbWF5IGJlIHJlYWQgYW5kIHdoYXQgaXQgaXMgc2VydmVkIGFzLlxuICpcbiAqIOKUgOKUgCBBTkQgXCJXSEVUSEVSIElUIE1BWSBCRSBSRUFEXCIgSVMgTk9XIEEgV0hJVEVMSVNUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEV4dHJhY3RlZCB3aXRoIHRocmVlIGd1YXJkcyAoZW1wdHkgLyBgLi5gIC8gbmVzdGVkKSBhbmQgYGV4aXN0c1N5bmNgIGZvciB0aGVcbiAqIHJlc3QsIHdoaWNoIHdhcyB0cnVlIG9mIGEgYGRpc3QvYCB0aGF0IGhlbGQgb25seSBhIHN1cmZhY2UuIFBoYXNlIDFiIHB1dCBldmVyeVxuICogZGFlbW9uJ3MgQlVORExFIGluIHRoYXQgc2FtZSBkaXJlY3RvcnksIGFuZCBhbGwgZml2ZSBhZG9wdGVycyBzZXJ2ZWQgaXQ6XG4gKiBgL2NsaS5qc2AsIGAvc2VydmVyLmpzYCwgYC9qb2luLmpzYCBhdCAyMDAsIGJ5dGUtaWRlbnRpY2FsIHRvIHRoZSBjb21taXR0ZWRcbiAqIGFydGlmYWN0cywgZW1iZWRkZWQgc291cmNlbWFwcyBhbmQgYWxsLiBgc2VydmVGcm9tRGlzdGAgbm93IHNlcnZlcyBvbmx5IHdoYXQgdGhlXG4gKiBidWlsdCBgaW5kZXguaHRtbGAgdHJhbnNpdGl2ZWx5IGxpbmtzIOKAlCBzZWUgYHN1cmZhY2VXaGl0ZWxpc3RgIGJlbG93LCB3aGljaCBpc1xuICogdGhlIHNoYXBlIGRpZ2VzdGlmeSBwcm92ZWQgbG9jYWxseSBpbiBgZDhjYmFmZmAgYW5kIHRoaXMgaXMgaXRzIG9uZSBlZGl0IGZvclxuICogZml2ZSBzcGVsbHMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbi8qKlxuICogUmVsZWFzZSBpZmYgYDxkaXN0RGlyPi9pbmRleC5odG1sYCBleGlzdHM7IGVsc2UgZGV2LiBUaGUgZW52IG92ZXJyaWRlXG4gKiAoYFNQRUxMQk9PS19TVVJGQUNFX01PREVgKSB3aW5zIGVpdGhlciB3YXkg4oCUIHNlYW1zIENvbnRyYWN0IDEuXG4gKlxuICog4puUICoqVEhFIEZJTEUsIE5FVkVSIFRIRSBESVJFQ1RPUlksIEFORCBUSEFUIElTIEEgU0NBUiBOT1QgQSBTVFlMRSBDSE9JQ0UuKipcbiAqIFJlLWhvbWVkIGZyb20gYm91bnR5IGFuZCBtYWdwaWUsIHdoaWNoIGVhcm5lZCBpdCBpbmRlcGVuZGVudGx5OlxuICpcbiAqIC0gbWFncGllJ3MgYGRpc3QvYCBBTFJFQURZIEVYSVNURUQgaG9sZGluZyBgY2xpLmpzYCBhbmQgbm8gYGluZGV4Lmh0bWxgLFxuICogICB3aGljaCBpcyBwcmVjaXNlbHkgd2h5IGl0cyBkYWVtb24gc3RheWVkIGNvcnJlY3RseSBpbiBERVYgbW9kZSB0aHJvdWdoIHRoZVxuICogICB3aG9sZSBvZiBTbGljZSAyLiBgZGlzdC9gIGV4aXN0aW5nIGlzIG5vdCB0aGUgZGlzY3JpbWluYXRvci5cbiAqIC0gYm91bnR5IHNheXMgdGhlIHNhbWUgdGhpbmcgZnJvbSB0aGUgb3RoZXIgc2lkZTogYSBidWlsdCBCQUNLRU5EIHB1dHNcbiAqICAgYGNsaS5qc2AgKGFuZCBub3cgYHNlcnZlci5qc2ApIGluIGBkaXN0L2Agd2l0aCBubyBzdXJmYWNlIGFueXdoZXJlIG5lYXIgaXQuXG4gKlxuICog4pqgICoqQU5EIFRIRSBQUkVESUNBVEUgSVMgQU4gVU5IQVNIRUQgRklMRU5BTUUsIFdISUNIIElTIEEgU1RBTkRJTkdcbiAqIEFTU1VNUFRJT04gQUJPVVQgVEhFIFNVUkZBQ0UgQlVJTEQuKiogUmVsZWFzZSBtb2RlIGlzIGNob3NlbiBieSBPTkUgbGl0ZXJhbFxuICogbmFtZS4gQSBzdXJmYWNlIGJ1aWxkIHRoYXQgZXZlciBlbWl0dGVkIGEgY29udGVudC1oYXNoZWQgZW50cnkgZG9jdW1lbnQgd291bGRcbiAqIGxlYXZlIG5vIGBpbmRleC5odG1sYCBoZXJlLCBldmVyeSBkYWVtb24gd291bGQgc2lsZW50bHkgcmVzb2x2ZSBERVYsIGFuZCB0aGVcbiAqIG9ubHkgc3ltcHRvbSBhbnlvbmUgY2FuIHNlZSBpcyB0aGUgYG1vZGVgIGZpZWxkIG9uIGEgaGFuZHNoYWtlIG5vYm9keSByZWFkcyBpblxuICogYW5nZXIuIGBzcmMvYnVpbGQudHNgIGVtaXRzIHRoZSBlbnRyeSB1bmhhc2hlZCB0b2RheSAob25seSB0aGUgSlMgYW5kIENTU1xuICogY2h1bmtzIGNhcnJ5IGhhc2hlcykgYW5kIENvbnRyYWN0IDIgcGlucyB0aGF0IGZsYXQgbGF5b3V0OyB0aGlzIGNvbW1lbnQgaXNcbiAqIHRoZSBub3RlIHRoYXQgc2F5cyB3aGF0IHRoZSBwaW4gaXMgbG9hZC1iZWFyaW5nIEZPUi5cbiAqXG4gKiDimqAgTm90aGluZyBhbm5vdW5jZXMgdGhlIGZsaXAgZnJvbSBkZXYgdG8gcmVsZWFzZSBlaXRoZXI6IHRoZSBmaXJzdCBzdXJmYWNlXG4gKiBidWlsZCB0byBsYW5kIGFuIGBpbmRleC5odG1sYCBiZXNpZGUgYSBkYWVtb24gZmxpcHMgaXQsIHNpbGVudGx5LCBvbiB0aGUgbmV4dFxuICogYm9vdC4gVGhhdCBpcyB3aHkgYG1vZGVgIHJpZGVzIHRoZSByZWFkeSBmcmFtZSDigJQgd2l0aCByb290IGRlcHMgcHJlc2VudCBhIGRldlxuICogZGFlbW9uIHJlbmRlcnMgYW4gaWRlbnRpY2FsLWxvb2tpbmcgc3VyZmFjZSwgc28gXCJpdCBsb29rcyByaWdodFwiIGNhbm5vdFxuICogdmVyaWZ5IENvbnRyYWN0IDEuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9kZShkaXN0RGlyOiBzdHJpbmcpOiBcImRldlwiIHwgXCJyZWxlYXNlXCIge1xuICBjb25zdCBvdmVycmlkZSA9IHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREU7XG4gIGlmIChvdmVycmlkZSA9PT0gXCJkZXZcIiB8fCBvdmVycmlkZSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBvdmVycmlkZTtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihkaXN0RGlyLCBcImluZGV4Lmh0bWxcIikpID8gXCJyZWxlYXNlXCIgOiBcImRldlwiO1xufVxuXG4vKipcbiAqIFRoZSBjb250ZW50IHR5cGVzIGEgYnVpbHQgc3VyZmFjZSBhY3R1YWxseSBzaGlwcy4gRXh0ZW5zaW9ucyBvdXRzaWRlIHRoZVxuICogbWFwIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYCDigJQgYSBkZWxpYmVyYXRlIHJlZnVzYWwgdG8gZ3Vlc3MsIHNpbmNlXG4gKiBhbnl0aGluZyBub3QgaW4gdGhpcyBsaXN0IGlzIG5vdCBzb21ldGhpbmcgQ29udHJhY3QgMidzIGJ1aWxkIGVtaXRzLlxuICpcbiAqIOKaoCAqKmBjaGFyc2V0PXV0Zi04YCBPTiBIVE1MIElTIFRIRSBDRU5TVVMnUyBPTkUgRElWRVJHRU5DRSwgUkVTT0xWRUQgVE9XQVJEXG4gKiBUSEUgQ09SUkVDVCBDT1BZLioqIFRocmVlIG9mIHRoZSBlaWdodCBkYWVtb25zIGNhcnJpZWQgaXQgYW5kIGZpdmUgZGlkIG5vdDtcbiAqIHRoZSBjZW5zdXMgZ3JhZGVkIHRoYXQgYHN0YWxlYCB3aXRoIHplcm8gZGVzaWduIGNvbnRlbnQuIEl0IGlzIGtlcHQgYmVjYXVzZVxuICogaXQgaXMgdGhlIHJpZ2h0IGFuc3dlciDigJQgYW4gSFRNTCBkb2N1bWVudCBzZXJ2ZWQgd2l0aCBubyBjaGFyc2V0IGlzIGRlY29kZWRcbiAqIGJ5IHRoZSBicm93c2VyJ3MgZ3Vlc3Mg4oCUIGFuZCBpdCBpcyB0aGUgb25lIHdpcmUtb2JzZXJ2YWJsZSBjaGFuZ2UgdGhpc1xuICogY29udmVyZ2VuY2UgbWFrZXMgdG8gYSByZXNwb25zZSBoZWFkZXIuIFJlY29yZGVkIGFzIEQtbm90ZSBpbiB0aGUgcGhhc2UgbG9nXG4gKiByYXRoZXIgdGhhbiBzbXVnZ2xlZC5cbiAqL1xuY29uc3QgU1RBVElDX0NPTlRFTlRfVFlQRVM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiLmh0bWxcIjogXCJ0ZXh0L2h0bWw7IGNoYXJzZXQ9dXRmLThcIixcbiAgXCIuanNcIjogXCJ0ZXh0L2phdmFzY3JpcHRcIixcbiAgXCIuY3NzXCI6IFwidGV4dC9jc3NcIixcbiAgXCIuanNvblwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbn07XG5cbi8qKiBUaGUgY29udGVudCB0eXBlIGZvciBhIGZpbGVuYW1lIG9yIGFuIGV4dGVuc2lvbi4gVW5rbm93biBleHRlbnNpb25zLCBhbmRcbiAqICBuYW1lcyB3aXRoIG5vIGV4dGVuc2lvbiBhdCBhbGwsIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb250ZW50VHlwZUZvcihuYW1lT3JFeHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGRvdCA9IG5hbWVPckV4dC5sYXN0SW5kZXhPZihcIi5cIik7XG4gIGNvbnN0IGV4dCA9IGRvdCA9PT0gLTEgPyBcIlwiIDogbmFtZU9yRXh0LnNsaWNlKGRvdCk7XG4gIHJldHVybiBTVEFUSUNfQ09OVEVOVF9UWVBFU1tleHRdID8/IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCI7XG59XG5cbi8qKlxuICogQW5zd2VyIE9ORSBmaWxlIGZyb20gYGRpc3REaXJgLCBvciBgbnVsbGAgaWYgdGhlIGNhbGxlciBzaG91bGQga2VlcCByb3V0aW5nLlxuICpcbiAqIGByZWxgIGlzIGEgYmFyZSBmaWxlbmFtZSDigJQgdGhlIGVudHJ5IGRvY3VtZW50IG9yIG9uZSBoYXNoZWQgY2h1bmsuIENvbnRyYWN0XG4gKiAyJ3MgYnVpbHQgc3VyZmFjZSBpcyBGTEFUIGFuZCBsaW5rcyBpdHMgY2h1bmtzIHJlbGF0aXZlbHksIHNvIGEgbGVnaXRpbWF0ZVxuICogYXNzZXQgcmVxdWVzdCBpcyBuZXZlciBuZXN0ZWQgYW5kIG5ldmVyIGNvbnRhaW5zIGAuLmA7IGJvdGggYXJlIHJlZnVzZWRcbiAqIGhlcmUgcmF0aGVyIHRoYW4gaW4gdGhlIHJvdXRlciwgYmVjYXVzZSB0aGUgZ3VhcmQgcHJvdGVjdHMgdGhlIHJlYWQgYW5kIHRoZVxuICogcmVhZCBpcyB3aGF0IGxpdmVzIGluIHRoaXMgZmlsZS5cbiAqXG4gKiDim5QgQU5EIGBleGlzdHNTeW5jYCBJUyBOTyBMT05HRVIgVEhFIFBFUk1JU1NJT04uIEEgZmlsZSB1bmRlciBgZGlzdERpcmAgaXNcbiAqIHNlcnZlZCBvbmx5IGlmIGl0IGlzIGluIGBzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXIpYCDigJQgd2hhdCB0aGUgYnVpbHRcbiAqIGBpbmRleC5odG1sYCB0cmFuc2l0aXZlbHkgTElOS1MuIGBkaXN0L2Agc3RvcHBlZCBiZWluZyBhIHN1cmZhY2UgZGlyZWN0b3J5XG4gKiB3aGVuIHRoZSBiYWNrZW5kIGNvbnZlcmdlbmNlIGJ1aWx0IHRoZSBkYWVtb25zIGludG8gaXQsIGFuZCB0aGUgZ3VhcmRzIGFib3ZlXG4gKiBkbyBub3QgZGlzdGluZ3Vpc2ggYGluZGV4LTxoYXNoPi5qc2AgZnJvbSBgc2VydmVyLmpzYC4gUmVhZCB0aGF0IGZ1bmN0aW9uJ3NcbiAqIGhlYWRlciBiZWZvcmUgdG91Y2hpbmcgdGhpcyBsaW5lOyB0aGUgd2hpdGVsaXN0IGlzIHRoZSBkZWZlbmNlLlxuICpcbiAqIOKaoCBUaGUgbmVzdGluZyByZWZ1c2FsIGlzIGFsc28gd2hhdCBrZWVwcyBhbiBhc3NldCBzZXJ2ZSBjbGVhciBvZiBhIHNwZWxsJ3NcbiAqIG93biByb3V0ZXM6IG1hZ3BpZSwgYm91bnR5LCBnbGFtb3VyIGFuZCBpbWFnbyBlYWNoIGhhdmUgYW4gYC9hc3NldHMvPG5hbWU+YFxuICogcm91dGUgb25lIGxldmVsIGRlZXAsIGFuZCB0aGlzIHJldHVybmluZyBgbnVsbGAgb24gYW55dGhpbmcgd2l0aCBhIHNsYXNoIGluXG4gKiBpdCBpcyB3aGF0IHN0b3BzIHRoZSB0d28gZmlnaHRpbmcuIFRoZSB3aGl0ZWxpc3QgZ292ZXJucyBgZGlzdC9gIHJlYWRzIE9OTFlcbiAqIOKAlCBpdCBuZXZlciBzZWVzIHRob3NlIHJvdXRlcyBhbmQgbXVzdCBuZXZlciBiZSB3aWRlbmVkIGludG8gdGhlbS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlcnZlRnJvbURpc3QoZGlzdERpcjogc3RyaW5nLCByZWw6IHN0cmluZyk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIGlmICghcmVsIHx8IHJlbC5pbmNsdWRlcyhcIi4uXCIpIHx8IHJlbC5pbmNsdWRlcyhcIi9cIikpIHJldHVybiBudWxsO1xuICBpZiAoIXN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcikuaGFzKHJlbCkpIHJldHVybiBudWxsO1xuICBjb25zdCBmaWxlID0gam9pbihkaXN0RGlyLCByZWwpO1xuICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIHJldHVybiBudWxsO1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKEJ1bi5maWxlKGZpbGUpLCB7IGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogY29udGVudFR5cGVGb3IocmVsKSB9IH0pO1xufVxuXG4vKiogYHNyY2AvYGhyZWZgIHZhbHVlcyBpbiBhIGJ1aWx0IGVudHJ5IGRvY3VtZW50LCBgLi9gLXByZWZpeGVkIG9yIGJhcmUuICovXG5jb25zdCBFTlRSWV9SRUZfUkUgPSAvKD86c3JjfGhyZWYpXFxzKj1cXHMqXCIoPzpcXC5cXC8pPyhbXlwiXSspXCIvZztcblxuLyoqIEEgYC4vYC1QUkVGSVhFRCBzaWJsaW5nIHNwZWNpZmllciDigJQgYFwiLi9uYW1lXCJgLCBgJy4vbmFtZSdgLCBgKC4vbmFtZSlgIOKAlCB3aGljaFxuICogIGlzIHRoZSBvbmx5IHNoYXBlIGEgYnVuZGxlciBlbWl0cyBmb3IgYSBzaWJsaW5nIGNodW5rLiBSZXF1aXJpbmcgdGhlIGAuL2AgaXNcbiAqICB3aGF0IGtlZXBzIGEgc3RyaW5nIGxpdGVyYWwgdGhhdCBtZXJlbHkgU0FZUyBgY2xpLmpzYCBvdXQgb2YgdGhlIHNldC4gKi9cbmNvbnN0IFJFTEFUSVZFX1JFRl9SRSA9IC9bXCInKF1cXC5cXC8oW15cIicoKVxcc10rKVtcIicpXS9nO1xuXG4vKiogT25seSB0ZXh0IHRoZSBidWlsZCBlbWl0cyBhcyBzdXJmYWNlIGNvZGUgaXMgc2Nhbm5lZCBmb3Igb253YXJkIHJlZmVyZW5jZXMuXG4gKiAgQSBgLnBuZ2AgaXMgYSBsZWFmOyBvcGVuaW5nIGl0IHdvdWxkIGJlIHJlYWRpbmcgYSBiaW5hcnkgZm9yIGZpbGVuYW1lcy4gKi9cbmNvbnN0IFRSQU5TSVRJVkVfRVhUUyA9IFtcIi5qc1wiLCBcIi5jc3NcIl07XG5cbi8qKiBPbmUgZGVyaXZhdGlvbiBwZXIgYGRpc3QvYCwgZm9yIHRoZSBsaWZlIG9mIHRoZSBwcm9jZXNzIOKAlCBgZGlzdC9gIGlzIGEgYnVpbGRcbiAqICBhcnRpZmFjdCBhbmQgZG9lcyBub3QgY2hhbmdlIHVuZGVyIGEgcnVubmluZyBkYWVtb24uIEtleWVkIGJ5IGRpcmVjdG9yeSBzb1xuICogIHR3byBkYWVtb25zIGluIG9uZSBwcm9jZXNzIChhbmQgZXZlcnkgdGVzdCB3aXRoIGl0cyBvd24gdGVtcCB0cmVlKSBzdGF5XG4gKiAgaW5kZXBlbmRlbnQuICovXG5jb25zdCB3aGl0ZWxpc3RDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBSZWFkb25seVNldDxzdHJpbmc+PigpO1xuXG5mdW5jdGlvbiByZWZzSW4odGV4dDogc3RyaW5nLCByZTogUmVnRXhwKTogc3RyaW5nW10ge1xuICByZXR1cm4gWy4uLnRleHQubWF0Y2hBbGwocmUpXVxuICAgIC5tYXAoKFssIHJlZl0pID0+IHJlZilcbiAgICAuZmlsdGVyKFxuICAgICAgKHJlZikgPT5cbiAgICAgICAgISFyZWYgJiZcbiAgICAgICAgIXJlZi5pbmNsdWRlcyhcIi9cIikgJiZcbiAgICAgICAgIXJlZi5pbmNsdWRlcyhcIi4uXCIpICYmXG4gICAgICAgICFyZWYuaW5jbHVkZXMoXCI6XCIpICYmXG4gICAgICAgICFyZWYuc3RhcnRzV2l0aChcIiNcIikgJiZcbiAgICAgICAgIXJlZi5zdGFydHNXaXRoKFwiP1wiKSxcbiAgICApO1xufVxuXG4vKipcbiAqIFRoZSBuYW1lcyB1bmRlciBgZGlzdERpcmAgYSBicm93c2VyIG1heSBmZXRjaDogdGhlIGVudHJ5IGRvY3VtZW50LCBwbHVzIHRoZVxuICogVFJBTlNJVElWRSBjbG9zdXJlIG9mIHdoYXQgaXQgbGlua3MuXG4gKlxuICog4puUICoqQSBXSElURUxJU1QsIEFORCBUSEUgTEVBSyBJVCBSRVBMQUNFRCBJUyBXSFkuKiogVW50aWwgdGhpcyBmaXggdGhlIGZpbGVcbiAqIGhhbGYgb2YgdGhpcyBtb2R1bGUgaGFkIGV4YWN0bHkgdGhyZWUgZ3VhcmRzIOKAlCBlbXB0eSwgYC4uYCwgbmVzdGVkIOKAlCBhbmRcbiAqIGBleGlzdHNTeW5jYCBkZWNpZGVkIHRoZSByZXN0LiBUaGF0IHdhcyBjb3JyZWN0IGZvciBhcyBsb25nIGFzIGBkaXN0L2AgaGVsZFxuICogb25seSBhIHN1cmZhY2UuIFRoZSBiYWNrZW5kIGNvbnZlcmdlbmNlIG1vdmVkIGV2ZXJ5IHNwZWxsJ3MgSU1QTEVNRU5UQVRJT05cbiAqIGludG8gdGhlIHNhbWUgZGlyZWN0b3J5LCBhbmQgdGhlIHNlcnZlIGRpZCB3aGF0IGl0IHdhcyB3cml0dGVuIHRvIGRvOlxuICpcbiAqICAgR0VUIC9jbGkuanMgICAgIDIwMCAgMjQyLDQzMSBCICB0ZXh0L2phdmFzY3JpcHQgICDihpAgYm91bnR5LCBieXRlLWlkZW50aWNhbFxuICogICBHRVQgL3NlcnZlci5qcyAgMjAwICAyNzYsNDE1IEIgIHRleHQvamF2YXNjcmlwdCAgICAgIHRvIHRoZSBjb21taXR0ZWRcbiAqICAgR0VUIC9qb2luLmpzICAgIDIwMCAgIDQ3LDM0OCBCICB0ZXh0L2phdmFzY3JpcHQgICAgICBhcnRpZmFjdHNcbiAqXG4gKiBhbmQgdGhvc2UgYnVuZGxlcyBhcmUgYnVpbHQgd2l0aCB0aGUgc291cmNlbWFwIEVNQkVEREVELCBzbyBlYWNoIG9uZSBjYXJyaWVzXG4gKiB0aGUgY29tcGxldGUgb3JpZ2luYWwgVHlwZVNjcmlwdC4gRml2ZSBzcGVsbHMg4oCUIGFzdHJvbGFiZSwgYm91bnR5LCBnbGFtb3VyLCBpbWFnbywgbWFncGllXG4gKiDigJQgZWxldmVuIGFydGlmYWN0cywgYWxsIHJlYWNoYWJsZSBieSBhbnkgYnJvd3NlciB0aGF0IGNhbiByZWFjaCB0aGUgZGFlbW9uLlxuICogRGlnZXN0aWZ5IGhpdCB0aGUgaWRlbnRpY2FsIGRlZmVjdCBvbmUgYnJhbmNoIGVhcmxpZXIgYW5kIGFuc3dlcmVkIGl0IGxvY2FsbHk7XG4gKiB0aGlzIGlzIHRoYXQgYW5zd2VyIHJlLWhvbWVkIHRvIHRoZSBvbmUgcGxhY2UgYWxsIGZpdmUgY2FsbGVycyBhbHJlYWR5IHNoYXJlLlxuICpcbiAqIOKblCAqKkRFUklWRUQsIE5PVCBFTlVNRVJBVEVELCBBTkQgTk9UIE1BVENIRUQgQlkgU0hBUEUuKiogQSBsaXRlcmFsIG5hbWUgbGlzdFxuICogaXMgd3JvbmcgYXQgdGhlIG5leHQgYnVpbGQgKHRoZSBjaHVua3MgY2FycnkgY29udGVudCBoYXNoZXMpLiBBIHNoYXBlIG1hdGNoXG4gKiAoYGluZGV4LTxoYXNoPi5qc2ApIGlzIHdyb25nIHRoZSBmaXJzdCB0aW1lIHRoZSBidW5kbGVyIHNwbGl0cyBhIGNodW5rLiBBc2tpbmdcbiAqIHRoZSBlbnRyeSBkb2N1bWVudCB3aGF0IGl0IGxvYWRzIGlzIHRoZSBvbmx5IGZvcm11bGF0aW9uIHRoYXQgaXMgdHJ1ZSBvZlxuICogd2hhdGV2ZXIgYGJ1biBydW4gYnVpbGRgIGFjdHVhbGx5IGVtaXR0ZWQuXG4gKlxuICog4puUICoqQU5EIFRIRSBDTE9TVVJFIElTIFRSQU5TSVRJVkUgRk9SIFRIRSBTQU1FIFJFQVNPTi4qKiBgaW5kZXguaHRtbGAgbGlua3NcbiAqIG9uZSBjaHVuayB0b2RheTsgYSBzcGxpdCBidWlsZCBoYXMgdGhhdCBjaHVuayBgaW1wb3J0IFwiLi9jaHVuay08aGFzaD4uanNcImAsXG4gKiB3aGljaCB0aGUgZW50cnkgZG9jdW1lbnQgbmV2ZXIgbmFtZXMuIFNvIGV2ZXJ5IGFkbWl0dGVkIGAuanNgL2AuY3NzYCBpcyBpdHNlbGZcbiAqIHNjYW5uZWQgZm9yIGAuL2AtcHJlZml4ZWQgc2libGluZ3MsIHVudGlsIHRoZSBzZXQgc3RvcHMgZ3Jvd2luZyDigJQgYSB3aGl0ZWxpc3RcbiAqIHRoYXQgcmVhZCBvbmx5IHRoZSBlbnRyeSB3b3VsZCA0MDQgYSBsZWdpdGltYXRlIGNodW5rIGluIHJlbGVhc2UsIGFuZCBvbmx5IGluXG4gKiByZWxlYXNlLlxuICpcbiAqIOKblCAqKk1FTUJFUlNISVAgSVMgQU4gRVhBQ1QgTUFUQ0gsIFdISUNIIE1BS0VTIFRIRSBSRUZVU0FMIENBU0UtSU5TRU5TSVRJVkUgQllcbiAqIENPTlNUUlVDVElPTi4qKiBBUEZTIGlzIGNhc2UtaW5zZW5zaXRpdmUsIHNvIGAvSU5ERVguSFRNTGAgYW5kIGAvaU5kRXguSHRNbGBcbiAqIHJlc29sdmUgdG8gdGhlIHNhbWUgaW5vZGUgYSBjYXNlLXNlbnNpdGl2ZSBibGFja2xpc3Qgd291bGQgbWlzcyAobWVhc3VyZWQgb25cbiAqIGFsbCBmaXZlIHNwZWxscyBiZWZvcmUgdGhpcyBmaXg6IGZvdXIgdmFyaWFudHMsIGZvdXIgMjAwcywgdGhyZWUgb2YgdGhlbSBhc1xuICogYGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbWAgYmVjYXVzZSB0aGUgY29udGVudC10eXBlIGxvb2t1cCBpcyBjYXNlLXNlbnNpdGl2ZVxuICogdG9vKS4gQSBzZXQgb2YgZXhhY3RseSB0aGUgZW1pdHRlZCBuYW1lcyByZWZ1c2VzIGV2ZXJ5IHZhcmlhbnQgb2YgZXZlcnkgbmFtZVxuICog4oCUIHNlcnZhYmxlIG9yIG5vdCDigJQgd2l0aCBubyBsb3dlci1jYXNlIHBhc3MgYW55d2hlcmUuXG4gKlxuICog4pqgICoqVEhFIFRSQURFOioqIGEgZmlsZSB0aGUgZW50cnkgZ3JhcGggZG9lcyBub3QgcmVmZXJlbmNlIOKAlCBhIGxhemlseSBmZXRjaGVkXG4gKiBjaHVuaywgYSBmb250IHB1bGxlZCBieSBhIENTUyBgdXJsKClgIHRoaXMgc2NhbiBkb2VzIG5vdCBtb2RlbCwgYW4gYXNzZXQgdGhlXG4gKiBidWlsZCBlbWl0cyBidXQgbm90aGluZyBsaW5rcyDigJQgNDA0cyBpbiByZWxlYXNlIHdpdGggbm90aGluZyByZWQuIEVhY2hcbiAqIGFkb3B0ZXIncyBgcmVsZWFzZS1zZXJ2ZS50ZXN0LnRzYCBob2xkcyB0aGUgaW5zdHJ1bWVudDogYW4gSU5WRU5UT1JZIGNlbGwgdGhhdFxuICogYWNjb3VudHMgZm9yIGV2ZXJ5IGZpbGUgaW4gYGRpc3QvYCBhcyBzZXJ2ZWQgb3IgZGVsaWJlcmF0ZWx5IHJlZnVzZWQsIHNvIGFuXG4gKiB1bmxpbmtlZCBlbWlzc2lvbiBnb2VzIHJlZCBhdCBidWlsZCB0aW1lIHJhdGhlciB0aGFuIHNpbGVudCBhdCBydW50aW1lLlxuICpcbiAqIOKaoCBUaGUgZW50cnkgZG9jdW1lbnQgaXMgSU4gdGhlIHNldCwgYmVjYXVzZSB0aGUgaG91c2UgY2FsbGVyIG1hcHMgYC9gIHRvXG4gKiBgaW5kZXguaHRtbGAgYW5kIHRoYXQgaXMgdGhlIHN1cmZhY2UuIEEgc3BlbGwgdGhhdCBtdXN0IG5ldmVyIGhhbmQgb3ZlciBpdHNcbiAqIG9uLWRpc2sgZW50cnkg4oCUIGRpZ2VzdGlmeSBzdWJzdGl0dXRlcyBhIHBheWxvYWQgaW50byBpdCBpbiBtZW1vcnkg4oCUIHJlZnVzZXNcbiAqIHRoYXQgT05FIG5hbWUgaW4gaXRzIG93biByb3V0ZXIsIGFib3ZlIHRoaXMgY2FsbC4gVGhhdCByZWZ1c2FsIGlzIHRoZSBzcGVsbCdzO1xuICogZXZlcnl0aGluZyBlbHNlIGhlcmUgaXMgdGhlIGtpdCdzLlxuICovXG5mdW5jdGlvbiBzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXI6IHN0cmluZyk6IFJlYWRvbmx5U2V0PHN0cmluZz4ge1xuICBjb25zdCBjYWNoZWQgPSB3aGl0ZWxpc3RDYWNoZS5nZXQoZGlzdERpcik7XG4gIGlmIChjYWNoZWQpIHJldHVybiBjYWNoZWQ7XG5cbiAgY29uc3QgbmFtZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgZW50cnkgPSBqb2luKGRpc3REaXIsIFwiaW5kZXguaHRtbFwiKTtcbiAgaWYgKGV4aXN0c1N5bmMoZW50cnkpKSB7XG4gICAgbmFtZXMuYWRkKFwiaW5kZXguaHRtbFwiKTtcbiAgICBjb25zdCBodG1sID0gcmVhZEZpbGVTeW5jKGVudHJ5LCBcInV0ZjhcIik7XG4gICAgY29uc3QgcGVuZGluZyA9IFsuLi5yZWZzSW4oaHRtbCwgRU5UUllfUkVGX1JFKSwgLi4ucmVmc0luKGh0bWwsIFJFTEFUSVZFX1JFRl9SRSldO1xuICAgIC8vIFVudGlsIHRoZSBzZXQgc3RvcHMgZ3Jvd2luZzogZWFjaCBhZG1pdHRlZCBjaHVuayBtYXkgbmFtZSB0aGUgbmV4dCBvbmUuXG4gICAgd2hpbGUgKHBlbmRpbmcubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgbmFtZSA9IHBlbmRpbmcucG9wKCkgYXMgc3RyaW5nO1xuICAgICAgaWYgKG5hbWVzLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgICAvLyDimqAgUkVGRVJFTkNFRCAqKkFORCoqIFBSRVNFTlQuIEEgbWluaWZpZWQgYnVuZGxlIGNhbiBjb250YWluIGEgc3RyaW5nXG4gICAgICAvLyB0aGF0IG1lcmVseSBMT09LUyBsaWtlIG9uZTsgYWRtaXR0aW5nIG9ubHkgbmFtZXMgdGhhdFxuICAgICAgLy8gYXJlIGFjdHVhbGx5IG9uIGRpc2sga2VlcHMgdGhlIHNjYW4gZnJvbSB3aWRlbmluZyB0aGUgc2V0IG9uIGFcbiAgICAgIC8vIGNvaW5jaWRlbmNlLCBhbmQgYSBuYW1lIHRoYXQgaXMgYWJzZW50IDQwNHMgaWRlbnRpY2FsbHkgZWl0aGVyIHdheS5cbiAgICAgIGNvbnN0IGZpbGUgPSBqb2luKGRpc3REaXIsIG5hbWUpO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKGZpbGUpKSBjb250aW51ZTtcbiAgICAgIG5hbWVzLmFkZChuYW1lKTtcbiAgICAgIGlmICghVFJBTlNJVElWRV9FWFRTLnNvbWUoKGV4dCkgPT4gbmFtZS5lbmRzV2l0aChleHQpKSkgY29udGludWU7XG4gICAgICBwZW5kaW5nLnB1c2goLi4ucmVmc0luKHJlYWRGaWxlU3luYyhmaWxlLCBcInV0ZjhcIiksIFJFTEFUSVZFX1JFRl9SRSkpO1xuICAgIH1cbiAgfVxuXG4gIHdoaXRlbGlzdENhY2hlLnNldChkaXN0RGlyLCBuYW1lcyk7XG4gIHJldHVybiBuYW1lcztcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgc2VydmVyIHNpZGUgb2YgdGhlIFNTRSB0YWlsIOKAlCB0aGUgZGFlbW9uLXNpZGUgdHdpbiBvZlxuICogYHRhaWxFdmVudHMudHNgLiBUaGF0IG1vZHVsZSBkZWNpZGVzIHdoYXQgYSBjYWxsZXIgb2JzZXJ2ZXM7IHRoaXMgb25lIGRlY2lkZXNcbiAqIHdoYXQgYSBjYWxsZXIgaXMgc2VudC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBleGNlcHQgaXRzXG4gKiBvd24gc2libGluZyB0eXBlcywgd2hpY2ggaXMgc3RpbGwgaW5zaWRlIHRoZSBsZWFmLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzIGBzc2VSZXNwb25zZWAsXG4gKiB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMxOiB0aGUgb25seSBvbmUgb2YgdGhlIHNldmVuIHdpdGggYVxuICogb25jZS1vbmx5IHRlYXJkb3duIGZ1bm5lbCwgdGhlIG9ubHkgb25lIHdpcmVkIHRvIGByZXEuc2lnbmFsYCwgYW5kIHRoZSBvbmx5XG4gKiBvbmUgd2hvc2UgY29tbWVudCByZWNvcmRzIGEgTUVBU1VSRUQgcmVzdWx0IHJhdGhlciB0aGFuIGEgYmVsaWVmLlxuICpcbiAqIOKUgOKUgCDim5QgQU5EIFdIQVQgVEhFIENPUFkgTEVGVCBCRUhJTkQsIFNBSUQgSEVSRSBCRUNBVVNFIEEgTE9TUyBSRUNPUkRFRCBPTkxZIElOXG4gKiAgICBBIFBPUlQnUyBKT1VSTkFMIEdFVFMgUkUtTElUSUdBVEVEIEJZIEVWRVJZIFNQRUxMIEFGVEVSIElUIChENzkvRDg1KSDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgc2VudGVuY2UgYWJvdmUgbmFtZXMgYSBTT1VSQ0UgdGhpcyBtb2R1bGUgaGFkIG5ldmVyIGJlZW4gY2hlY2tlZCBhZ2FpbnN0OlxuICogRDEgcnVsZWQgdGhlIHNwaW5lIGJlIHByb3ZlbiBvbiB0aGUgdHdvIHNwZWxscyB0aGF0IGFscmVhZHkgYnVpbHQsIGFuZCBib3RoIG9mXG4gKiB0aG9zZSBhcmUgZG93bnN0cmVhbSBGT1JLUyBvZiB0aGUgbWluZC1tYXBwZXIgbGluZSwgc28gdGhlIGJvdW5kYXJpZXMgd2VyZVxuICogc2V0dGxlZCBhZ2FpbnN0IHR3byBjb3BpZXMgd2hpbGUgdGhlIG9yaWdpbmFsIHdhcyBub3QgaW4gdGhlIHJvb20uICoqQVxuICogY29udmVyZ2VuY2UgY2FuIG5hbWUgaXRzIHNvdXJjZSBhbmQgc3RpbGwgbmV2ZXIgY29uc3VsdCBpdC4qKlxuICpcbiAqIFdoZW4gaXQgd2FzIGZpbmFsbHkgY29uc3VsdGVkIChQaGFzZSA3LCB0aGUgbGFzdCBwb3J0KSwgZXhhY3RseSBPTkUgcHJvcGVydHlcbiAqIG9mIHRoZSBzb3VyY2Ugd2FzIG1pc3NpbmcgaGVyZSwgYW5kIGl0IG9jY3VwaWVkIG5vIHR5cGU6ICoqbWluZC1tYXBwZXIgd3JvdGVcbiAqIGl0cyBgdGFpbCAtLWluYm91bmRgIGdyb3VuZGluZyBmcmFtZSBCRUZPUkUgdGhlIHJlcGxheSoqIOKAlCBvbmUgbGluZSBhYm92ZVxuICogYGJ1cy5zdWJzY3JpYmVgIOKAlCBzbyBpdCB3YXMgdGhlIHN0cmVhbSdzIGZpcnN0IGRhdGEgbGluZS4gYG9uT3BlbmAgZmlyZXMgYXRcbiAqIHRoZSBFTkQgb2YgYHN0YXJ0YCwgYWZ0ZXIgdGhlIHByZWFtYmxlLCBhZnRlciBgbG9nLnN1YnNjcmliZWAsIGFmdGVyXG4gKiBgY2xpZW50cy5hZGRgLCBzbyBhIGNhbGxlciB0aGF0IHN1cHBsaWVkIGl0cyBvd24gYGNsaWVudHNgIHNldCBhbmQgc2VudCBmcm9tXG4gKiB0aGVyZSB3b3VsZCBsYW5kIHRoZSBmcmFtZSBBRlRFUiB0aGUgcmVwbGF5ZWQgYmFja2xvZy4gVGhhdCBpcyBFWFBSRVNTSUJMRSxcbiAqIHdoaWNoIGlzIHdoYXQgbWFrZXMgdGhpcyBhIG1lYXN1cmVtZW50IHJhdGhlciB0aGFuIGFuIGFzc2VydGlvbjogdGhlXG4gKiBwbGF5Ym9vaydzIHR5cGUtdG8tdHlwZSBjb21wYXRpYmlsaXR5IHByb2NlZHVyZSBhbnN3ZXJzIFwicmVwcmVzZW50YWJsZVwiIGhlcmVcbiAqICh0aGUgc3ViamVjdCB0eXBlIGlzIGBTZXQ8U3NlQ2xpZW50PmAsIHRoZSBzcGVsbCBrZWVwcyBubyByZWdpc3RyeSwgc28geW91XG4gKiBwYXNzIGFuIGVtcHR5IHNldCkgYW5kIGEgdHlwZSBjaGVjayBjYW5ub3Qgc2VlIGEgUE9TSVRJT04uXG4gKlxuICogKipUaGUgZGlzcG9zaXRpb24gd2FzIFJFU1RPUkUsIG5vdCBLRUVQLUxPQ0FMIGFuZCBub3QgRklMRSoqIOKAlCBzZWVcbiAqIGBvcGVuRnJhbWVzYCBiZWxvdywgd2hlcmUgdGhlIHR3byBudW1iZXJzIHRoYXQgcGVybWl0IGl0IGFyZSByZWNvcmRlZCBhbmRcbiAqIGRyaXZlbi4gVGhlIGdlbmVyYWxpc2F0aW9uLCB3aGljaCBpcyB0aGUgcGFydCB3b3J0aCBjYXJyeWluZzogd2hlcmUgYVxuICogbW9kdWxlJ3Mgc3ViamVjdCBpcyBhIFNFUVVFTkNFIE9GIFdSSVRFUywgY29tcGFyZSB0aGUgT1JERVIgb2YgaXRzIGhvb2tzXG4gKiBhZ2FpbnN0IHRoZSBvcmRlciB0aGUgYWRvcHRpbmcgc3BlbGwgd3JpdGVzIGluLiBUd28gaG9va3Mgd2l0aCB0aGUgcmlnaHRcbiAqIHNpZ25hdHVyZXMgaW4gdGhlIHdyb25nIG9yZGVyIGFyZSBhcyBpbmNvbXBhdGlibGUgYXMgdHdvIHR5cGVzIHRoYXQgd2lsbCBub3RcbiAqIHVuaWZ5LCBhbmQgb25seSBvbmUgb2YgdGhlIHR3byBjYW4gYmUgU0VFTiBieSBhIGNvbXBhdGliaWxpdHkgY2hlY2suXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqICAgIENMSUVOVC4gTUVBU1VSRUQgT04gQlVOIDEuMy4xNCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBTaXggZGFlbW9ucyB3cml0ZSBhIGhlYXJ0YmVhdCBhcyBgdHJ5IHsgY29udHJvbGxlci5lbnF1ZXVlKC4uLikgfSBjYXRjaCB7fWBcbiAqIHdpdGggYSBjb21tZW50IHNheWluZyB0aGUgY2F0Y2ggaXMgaG93IGEgZGVwYXJ0ZWQgY2xpZW50IGlzIG5vdGljZWQuIEl0IGlzXG4gKiBub3Q6IGVucXVldWUgb24gYW4gb3JwaGFuZWQgc3RyZWFtIEJVRkZFUlMgU0lMRU5UTFkgYW5kIG5ldmVyIHRocm93cywgc28gdGhlXG4gKiBjYXRjaCBuZXZlciBmaXJlcyBhbmQgdGhvc2UgZGFlbW9ucycgZGVhZC1jbGllbnQgZGV0ZWN0aW9uIHJlc3RzIG9uIGFcbiAqIG1lY2hhbmlzbSB0aGVpciBvd24gY29tbWVudHMgZGVzY3JpYmUgaW5jb3JyZWN0bHkuIFdoYXQgYWN0dWFsbHkgcmVjbGFpbXMgdGhlXG4gKiBjb25uZWN0aW9uIGlzIHRoZSBzdHJlYW0ncyBgY2FuY2VsKClgIOKAlCBhbmQsIGZvciBhIGNsaWVudCB0aGF0IG5ldmVyIGNsb3Nlc1xuICogdGhlIHNvY2tldCwgYHJlcS5zaWduYWxgLlxuICpcbiAqIFNvIHRoZSBmdW5uZWwgYmVsb3cgaXMgdGhlIGxvYWQtYmVhcmluZyBwYXJ0LiBgdGVhcmRvd24oKWAgcnVucyBBVCBNT1NUIE9OQ0VcbiAqIGZyb20gZXZlcnkgcGF0aCB0aGVyZSBpcyDigJQgYGNhbmNlbCgpYCwgYW4gYWJvcnQgb24gdGhlIHJlcXVlc3Qgc2lnbmFsLCBhbmRcbiAqIHRoZSBiZWx0LWFuZC1icmFjZXMgZW5xdWV1ZSBjYXRjaCDigJQgYW5kIGl0IGlzIHdoZXJlIHRoZSBzdWJzY3JpYmVyIGNvdW50IGFuZFxuICogYW55IHByZXNlbmNlIGRlY3JlbWVudCByaWRlLiBCb3VuZGluZyBwcmVzZW5jZSBhY2N1cmFjeSBpcyBib3VuZGluZyB0aGF0XG4gKiBmdW5uZWwuXG4gKlxuICog4pqgIEtub3duIGhvbGUsIGFjY2VwdGVkIGFuZCBpbmhlcml0ZWQ6IEJ1bidzIG93biBgZmV0Y2goKWAgcmVhZGVyIGAuY2FuY2VsKClgXG4gKiBjbG9zZXMgbm90aGluZyBjbGllbnQtc2lkZSBhbmQgdGhlIHNlcnZlciBjYW5ub3Qgc2VlIGl0LiBSZWFsIGNsaWVudHMgY2xvc2VcbiAqIHRoZSBzb2NrZXQuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgRE9FUyBOT1QgQURPUFQgVEhJUywgQU5EIFRIRSBSRUZVU0FMIElTIFBBUlQgT0YgVEhFIFJVTElORyDilIDilIBcbiAqXG4gKiBSRUpFQ1QtU1RSVUNUVVJBTCwgcnVsZWQgYXQgZ3JhcGV2aW5lJ3MgcG9ydCAoUGhhc2UgNiwgMjAyNi0wOS0wOTsgRDY4KS5cbiAqIEdyYXBldmluZSBIQVMgYW4gU1NFIHJlZ2lzdHJ5IGFuZCBpdCBpcyB0aGUgYnVzaWVzdCB0aGluZyBpbiB0aGUgc3BlbGw7IHRoZVxuICogdHdvIHR5cGVzIHNpbXBseSBjYW5ub3QgYmUgY29uc3RydWN0ZWQgZnJvbSBlYWNoIG90aGVyOlxuICpcbiAqICAgdGhpcyBtb2R1bGUgIGBTc2VDbGllbnRzID0gU2V0PFNzZUNsaWVudD5gIHdoZXJlIGBTc2VDbGllbnQgPSB7Y2xvc2UsIHNlbmR9YFxuICogICAgICAgICAgICAgICAg4oCUIGEgcmVnaXN0cnkgb2YgQU5PTllNT1VTIGNsb3NlcnMsIGFuZCBgc2l6ZWAgaXMgdGhlIG9ubHkgdGhpbmdcbiAqICAgICAgICAgICAgICAgIGFueSBhZG9wdGluZyBkYWVtb24gcmVhZHMgb2ZmIGl0LlxuICogICBncmFwZXZpbmUgICAgYE1hcDxzeW1ib2wsIHthbGlhcywgaHVtYW4sIGx1cmssIHNlbmR9PmAsIHBlciBjaGFubmVsLlxuICpcbiAqICoqVGhlIHJlYWRlcnMgdGhhdCBtYWtlIHRoZW0gaW5jb21wYXRpYmxlLCBjb3VudGVkIHJhdGhlciB0aGFuIGFzc2VydGVkOiBTSVhcbiAqIHJvdXRlcyByZWFkIGBhbGlhc2AvYGh1bWFuYC9gbHVya2AqKiDigJQgYEdFVCAvY2hhbm5lbHNgICh0aHJvdWdoXG4gKiBgbGlzdENoYW5uZWxzYCDihpIgYHZpc2libGVTdWJzYCksIGBHRVQgL3ByZXNlbmNlYCwgYFBPU1QgL2NoYW5uZWxzYCxcbiAqIGBQT1NUIC9hbm5vdW5jZWAsIGBQT1NUIC9jaGFubmVscy86bmFtZS9tZXNzYWdlc2AsIGFuZFxuICogYEdFVCAvY2hhbm5lbHMvOm5hbWUvc3Vic2NyaWJlcnNgLiBgYWxpYXNgIGlzIGEgbmFtZSBhIGh1bWFuIHNlZXMgaW4gYSByb3N0ZXIsXG4gKiBgaHVtYW5gIHRlbGxzIGFuIGFnZW50IGl0IGlzIHRhbGtpbmcgdG8gYSBwZXJzb24sIGFuZCBgbHVya2AgZXhjbHVkZXMgYVxuICogY29ubmVjdGlvbiBmcm9tIGV2ZXJ5IHByZXNlbmNlIGNvdW50LiBUaGVyZSBpcyBubyB3YXkgdG8gcHV0IGFueSBvZiB0aGF0IGludG9cbiAqIGEgc2V0IG9mIGNsb3NlcnMuIEFkb3B0aW5nIHRoaXMgbW9kdWxlIHdvdWxkIG5vdCBiZSBkZWFkIGNvZGU7IGl0IHdvdWxkIGJlIGFcbiAqIHJld3JpdGUgb2Ygd2hhdCBncmFwZXZpbmUgSVMuXG4gKlxuICog4pqgICoqQU5EIFRIRSBMSVNUIElTIERFTElCRVJBVEVMWSBOT1QgVEhFIE9CVklPVVMgT05FLioqIFRoZSBwb3J0J3MgZmlyc3RcbiAqIGNvdW50IG5hbWVkIHRoZSBgcm9sbGAvY2xlYXIgYnJvYWRjYXN0LCB0aGUgYXJjaGl2ZSBsaXZlLWd1YXJkIGFuZCB0d29cbiAqIFJFR0lTVFJBVElPTlMg4oCUIGFuZCBldmVyeSBvbmUgb2YgdGhvc2UgaXMgYSBzaXRlIHRoaXMgbW9kdWxlJ3MgdHlwZSB3b3VsZFxuICogc2VydmUgcGVyZmVjdGx5OiB0aGUgYnJvYWRjYXN0IHJlYWRzIG9ubHkgYHMuc2VuZGAsIHRoZSBsaXZlLWd1YXJkIG9ubHlcbiAqIGBzdWJzY3JpYmVycy5zaXplYCAod2hpY2ggdGhpcyBoZWFkZXIgaXRzZWxmIHNheXMgaXMgYWxsIGFueSBhZG9wdGVyIHJlYWRzKSxcbiAqIGFuZCBhIHJlZ2lzdHJhdGlvbiBXUklURVMgdGhlIHJlY29yZCByYXRoZXIgdGhhbiByZWFkaW5nIGl0LiBUaGUgc2l4IGFib3ZlIGFyZVxuICogdGhlIG9uZXMgdGhhdCByZWFkIGEgZmllbGQgdGhlIGtpdCdzIGBTc2VDbGllbnRgIGRvZXMgbm90IGhhdmU7IHRoZSB3cml0ZXJzXG4gKiAoYC93YWl0YCdzIHByZXNlbmNlIHJlZ2lzdHJhdGlvbiBhbmQgdGhlIHRhaWwncykgYXJlIG5hbWVkIHNlcGFyYXRlbHkgYmVjYXVzZVxuICogYSB3cml0ZXIgaXMgbm90IGV2aWRlbmNlIG9mIGFueXRoaW5nLiBDb3VudGVkIGluIHRoZSBwcmUtcG9ydCBkYWVtb24sXG4gKiBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dyYXBldmluZS9zY3JpcHRzL2RhZW1vbi50c2Agb24gYGRldmVsb3BgOlxuICogbC40MjEsIDczOS03NDcsIDgyNiwgODg2LTg4NywgMTA0OS0xMDU0LCAxMTgyLTExODgg4oCUIHdyaXRlcnMgYXQgMTExMS0xMTEyIGFuZFxuICogMTMwNy4gKENvcnJlY3RlZCAyMDI2LTA5LTA5IGluIHRoZSByZXBhaXIgY2hhcHRlcjsgRDY4J3MgcmVxdWlyZW1lbnQgaXMgdGhhdFxuICogdGhlIHJlZnVzYWwgYmUgd3JpdHRlbiB3aGVyZSB0aGUgbmV4dCByZWFkZXIgbWVldHMgaXQsIHdoaWNoIG1ha2VzIGFcbiAqIG1pcy1tZWFzdXJlZCBsaXN0IHdvcnNlIHRoYW4gbm9uZS4pXG4gKlxuICog4pqgIEFuZCBncmFwZXZpbmUncyByZWNvcmRzIGNhcnJ5IG5vIGBjbG9zZWAgYXQgYWxsIOKAlCB0aGUgcGVyLXN0cmVhbSB0ZWFyZG93biBpc1xuICogYSBjbG9zdXJlIHN0YXNoZWQgb24gdGhlIFJlYWRhYmxlU3RyZWFtIGNvbnRyb2xsZXIsIHJlYWNoYWJsZSBvbmx5IGZyb21cbiAqIGBjYW5jZWwoKWAg4oCUIHdoaWNoIGlzIGFsc28gd2h5IGBob3VzZWtlZXBpbmdgJ3MgYGRyYWluQW5kU3RvcGAgaXMgYWRvcHRlZFxuICogdGhlcmUgd2l0aCBpdHMgYGNsaWVudHNgIGFyZ3VtZW50IGRlbGliZXJhdGVseSBlbXB0eS5cbiAqXG4gKiAqKlRoZSB3aWRlbmluZyBOT1QgZG9uZSwgd2l0aCBpdHMgY29zdDoqKiBhZG1pdHRpbmcgYW4gYWxpYXMtYmVhcmluZyByZWNvcmRcbiAqIHdvdWxkIGNoYW5nZSB0aGUgdHlwZSBmaXZlIG90aGVyIGRhZW1vbnMgY29tcGlsZSBhZ2FpbnN0IGFuZCByZS1lbWl0IFNJWFxuICogYXJ0aWZhY3RzIGFjcm9zcyBGSVZFIHNwZWxscywgZWFjaCBvd2VkIGEgZHJpdmUuIEl0IHdvdWxkIGFsc28gcmUtY3JlYXRlIHRoZVxuICogdGhpbmcgdGhpcyByZWdpc3RyeSBleGlzdHMgdG8gc3RvcCwgYW5kIHRoaXMgZmlsZSdzIG93biBib3VuZGFyeSBwYXJhZ3JhcGhcbiAqIHNheXMgaG93OiBhIHNpZ25hdHVyZSB3aWRlIGVub3VnaCB0byBhYnNvcmIgZXZlcnkgY2FsbGVyJ3Mgc2hhcGUgc3RvcHMgYmVpbmcgYVxuICogcmVnaXN0cnkgYW5kIGJlY29tZXMgYSB1bmlvbi4gVGhlIGNlbnN1cyBjb252ZXJnZWQgY29waWVzIGludG8gb25lIG1vZHVsZSBieVxuICogZmluZGluZyB3aGF0IHRoZXkgU0hBUkVEOyBhIG1vZHVsZSB3aWRlbmVkIHRvIGZpdCB0aGUgb25lIHNwZWxsIHRoYXQgc2hhcmVzXG4gKiBub3RoaW5nIGlzIHRob3NlIGNvcGllcyBhZ2FpbiB3aXRoIGEgdW5pb24gdHlwZSBvdmVyIHRoZSB0b3AuIFRoZSBzcGVsbCBrZWVwc1xuICogaXRzIG93biwgYW5kIGEgd2lkZW5pbmcgcmVtYWlucyBhIHNlcGFyYXRlLCBhcmd1ZWQgZGVjaXNpb24uXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFdmVudExvZywgRnJhbWUgfSBmcm9tIFwiLi9ldmVudExvZy50c1wiO1xuXG4vKipcbiAqIE9uZSBvcGVuIFNTRSBzdHJlYW0sIGFzIHRoZSBkYWVtb24gY2FuIGFjdCBvbiBpdDogZW5kIGl0LCBvciBwdXNoIGEgZnJhbWUgdG9cbiAqIGl0IHRoYXQgZGlkIG5vdCBjb21lIG91dCBvZiB0aGUgbG9nLlxuICpcbiAqIOKblCBJVCBJUyBOT1QgQSBDT05UUk9MTEVSLiBUaGUgY29waWVzIGhlbGRcbiAqIGBTZXQ8UmVhZGFibGVTdHJlYW1EZWZhdWx0Q29udHJvbGxlcj5gIGFuZCBjbG9zZWQgdGhlbSBkaXJlY3RseSBhdCB0ZWFyZG93bixcbiAqIHdoaWNoIGJ5cGFzc2VzIHRoZSB0ZWFyZG93biBmdW5uZWwgYWJvdmUg4oCUIHRoZSBoZWFydGJlYXQgaW50ZXJ2YWwgZm9yIHRoYXRcbiAqIHN0cmVhbSB3YXMgY2xlYXJlZCBvbmx5IGJlY2F1c2UgYSBzZWNvbmQgYFNldGAgb2YgdGltZXJzIHdhcyBrZXB0IGluIHBhcmFsbGVsXG4gKiBhbmQgc3dlcHQgc2VwYXJhdGVseS4gRXZlcnl0aGluZyBoZXJlIGdvZXMgdGhyb3VnaCB0aGUgZnVubmVsLCBhbmQgYSBgc2VuZGBcbiAqIGFmdGVyIHRlYXJkb3duIGlzIGEgbm8tb3AgcmF0aGVyIHRoYW4gYSB0aHJvdy5cbiAqXG4gKiDimqAgKipgc2VuZGAgQVJSSVZFRCBJTiBQSEFTRSAyLCBGUk9NIFRIRSBGSVJTVCBDT05TVU1FUiBUSEFUIFdBUyBOT1QgT05FIE9GIFRIRVxuICogVFdPIFRISVMgTU9EVUxFIFdBUyBERVNJR05FRCBBR0FJTlNULioqIGFzdHJvbGFiZSBhbmQgbWFncGllIGFubm91bmNlIHByZXNlbmNlXG4gKiBvdmVyIHRoZWlyIGJyb3dzZXIgV0VCU09DS0VULCBzbyBhIHJlZ2lzdHJ5IG9mIGJhcmUgY2xvc2VycyB3YXMgc3VmZmljaWVudCBhbmRcbiAqIHRoZSBib3VuZGFyeSBsb29rZWQgcmlnaHQuIGdsYW1vdXIgYW5ub3VuY2VzIGl0IG9uIHRoZSBBR0VOVCdzIFNTRSB0YWlsIOKAlFxuICogYHt0eXBlOlwiY29ubmVjdGVkXCJ9YCAvIGB7dHlwZTpcImRpc2Nvbm5lY3RlZFwifWAsIGRlbGliZXJhdGVseSB1bmxvZ2dlZCwgc28gYVxuICogcmVjb25uZWN0aW5nIGFnZW50IGRvZXMgbm90IHJlLXNlZSBldmVyeSBwYXN0IGNvbm5lY3QgYW5kIHNvIHRoZSBmcmFtZSBuZXZlclxuICogYWR2YW5jZXMgYSB0YWlsIGN1cnNvci4gVGhhdCBpcyBub3QgYSBnbGFtb3VyIHF1aXJrOyBpdCBpcyB0aGUgZ2VuZXJhbCBzaGFwZVxuICogb2YgXCJ0ZWxsIHRoZSBsaXZlIHN1YnNjcmliZXJzIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBwYXJ0IG9mIHRoZSBoaXN0b3J5XCIsIGFuZFxuICogYSByZWdpc3RyeSB0aGF0IGNhbiBvbmx5IEVORCBhIHN0cmVhbSBjYW5ub3QgZXhwcmVzcyBpdC4gV2l0aG91dCB0aGlzIHRoZVxuICogc3BlbGwgd291bGQgaGF2ZSBoYWQgdG8ga2VlcCBpdHMgb3duIHBhcmFsbGVsIGBTZXRgIG9mIGNvbnRyb2xsZXJzLCB3aGljaCBpc1xuICogZXhhY3RseSB0aGUgZHJpZnQgdGhpcyByZWdpc3RyeSBleGlzdHMgdG8gcmVtb3ZlLlxuICovXG5leHBvcnQgdHlwZSBTc2VDbGllbnQgPSB7XG4gIC8qKiBFbmQgdGhpcyBzdHJlYW0sIHRocm91Z2ggdGhlIHRlYXJkb3duIGZ1bm5lbCwgYXQgbW9zdCBvbmNlLiAqL1xuICBjbG9zZSgpOiB2b2lkO1xuICAvKiogV3JpdGUgb25lIHJhdyBTU0UgY2h1bmsgdG8gdGhpcyBzdHJlYW0uIE5vLW9wIG9uY2UgdG9ybiBkb3duLiAqL1xuICBzZW5kKGNodW5rOiBzdHJpbmcpOiB2b2lkO1xufTtcblxuLyoqXG4gKiBUaGUgbGl2ZS10YWlsIHJlZ2lzdHJ5LiBgc2l6ZWAgaXMgdGhlIGRhZW1vbidzIFNTRSBzdWJzY3JpYmVyIGNvdW50IOKAlCB0aGVcbiAqIG51bWJlciBgc2hvdWxkSWRsZUNsb3NlYCBtdXN0IHNlZSDigJQgYW5kIGNsb3NpbmcgZXZlcnkgZW50cnkgaXMgd2hhdCBhIGRyYWluXG4gKiBkb2VzLlxuICovXG5leHBvcnQgdHlwZSBTc2VDbGllbnRzID0gU2V0PFNzZUNsaWVudD47XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3NlT3B0aW9uczxUIGV4dGVuZHMgb2JqZWN0PiB7XG4gIC8qKiBUaGUgbG9nIHRvIHJlcGxheSBmcm9tIGFuZCBzdWJzY3JpYmUgdG8uICovXG4gIGxvZzogRXZlbnRMb2c8VD47XG4gIC8qKiBUaGUgY2FsbGVyJ3MgcmVzdW1lIGN1cnNvci4gQWJzZW50IG9yIHVucGFyc2VhYmxlIHJlcGxheXMgZnJvbSB0aGUgc3RhcnQuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBIZWFydGJlYXQgY29tbWVudCBpbnRlcnZhbC4gTVVTVCBzdGF5IHdlbGwgdW5kZXIgdGhlIHNlcnZlcidzXG4gICAqICBgaWRsZVRpbWVvdXRgIOKAlCBzZWUgYGhlYXJ0YmVhdC50c2AsIHdoaWNoIGlzIHdoZXJlIHRoYXQgcGFpciBsaXZlcy4gKi9cbiAgaGVhcnRiZWF0TXM6IG51bWJlcjtcbiAgLyoqIExpdmVuZXNzIHJlZ2lzdHJ5OyB0aGUgc3RyZWFtIGFkZHMgaXRzZWxmIG9uIG9wZW4gYW5kIHJlbW92ZXMgaXRzZWxmIGluXG4gICAqICB0aGUgdGVhcmRvd24gZnVubmVsLiAqL1xuICBjbGllbnRzPzogU3NlQ2xpZW50cztcbiAgLyoqIGByZXEuc2lnbmFsYCDigJQgdGhlIG9ubHkgdGhpbmcgdGhhdCByZWNsYWltcyBhIGNsaWVudCB0aGF0IHdlbnQgYXdheVxuICAgKiAgd2l0aG91dCBjYW5jZWxsaW5nIHRoZSBzdHJlYW0uICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKiogU2VydmVyLXNpZGUgZmlsdGVyLiBBIHJlamVjdGVkIGZyYW1lIGlzIG5vdCBzZW50OyB0aGUgY2xpZW50IHN0aWxsXG4gICAqICBhZHZhbmNlcyBpdHMgY3Vyc29yIHBhc3QgaXQsIHdoaWNoIGlzIGB0YWlsRXZlbnRzYCdzIGRvY3VtZW50ZWQgcnVsZS4gKi9cbiAgZmlsdGVyPzogKGZyYW1lOiBGcmFtZTxUPikgPT4gYm9vbGVhbjtcbiAgLyoqXG4gICAqIFJhdyBTU0UgY2h1bmtzIHdyaXR0ZW4gdG8gVEhJUyBzdHJlYW0gQkVGT1JFIHRoZSByZXBsYXkg4oCUIGFmdGVyIHRoZVxuICAgKiBgXCI6IGNvbm5lY3RlZFwiYCBwcmVhbWJsZSBhbmQgYmVmb3JlIGBsb2cuc3Vic2NyaWJlYCwgc28gd2hhdGV2ZXIgaXQgcmV0dXJuc1xuICAgKiBpcyB0aGUgc3RyZWFtJ3MgZmlyc3QgREFUQSBsaW5lIHJhdGhlciB0aGFuIGEgZnJhbWUgYnVyaWVkIGJlaGluZCBhXG4gICAqIHJlcGxheWVkIGJhY2tsb2cuXG4gICAqXG4gICAqIOKblCBJVCBJUyBBIFBPU0lUSU9OLCBXSElDSCBJUyBXSFkgYG9uT3BlbmAgQ09VTEQgTk9UIFNFUlZFIChEODUpLiBgb25PcGVuYFxuICAgKiBmaXJlcyBhdCB0aGUgZW5kIG9mIGBzdGFydGAg4oCUIGFmdGVyIHRoZSBwcmVhbWJsZSwgYWZ0ZXIgYGxvZy5zdWJzY3JpYmVgLFxuICAgKiBhZnRlciBgY2xpZW50cy5hZGRgIOKAlCBzbyBhIGNhbGxlciB0aGF0IHN1cHBsaWVzIGl0cyBvd24gYGNsaWVudHNgIHNldCBhbmRcbiAgICogc2VuZHMgZnJvbSB0aGVyZSBsYW5kcyBpdHMgZnJhbWUgQUZURVIgdGhlIGJhY2tsb2cuIFRoYXQgaXMgZXhwcmVzc2libGUgYW5kXG4gICAqIGl0IGlzIHRoZSB3cm9uZyBvcmRlciwgd2hpY2ggaXMgdGhlIG5lYXItbWlzcyB0aGF0IG1ha2VzIHRoaXMgYSBtZWFzdXJlbWVudFxuICAgKiByYXRoZXIgdGhhbiBhbiBhc3NlcnRpb246IG5vdGhpbmcgYWJvdXQgdGhlIFRZUEVTIHByZXZlbnRzIGl0LCBhbmQgYVxuICAgKiB0eXBlLXRvLXR5cGUgY29tcGF0aWJpbGl0eSBjaGVjayBjYW5ub3Qgc2VlIGEgcG9zaXRpb24uXG4gICAqXG4gICAqIOKblCBSRVNUT1JFRCBGUk9NIFRIRSBTUEVMTCBUSElTIE1PRFVMRSBXQVMgQ09OVkVSR0VEIFRPV0FSRCwgQU5EIElUIElTIEFcbiAgICogUkVTVE9SQVRJT04gUkFUSEVSIFRIQU4gQSBXSURFTklORyBPTiBUV08gTUVBU1VSRUQgTlVNQkVSUyAoRDc5L0Q4NSkuXG4gICAqIG1pbmQtbWFwcGVyJ3MgYHNzZVJlc3BvbnNlYCB3cm90ZSBpdHMgYHRhaWwgLS1pbmJvdW5kYCBncm91bmRpbmcgZnJhbWUgb25lXG4gICAqIGxpbmUgQUJPVkUgYGJ1cy5zdWJzY3JpYmVgOyB0aGlzIG1vZHVsZSdzIGNvbnZlcmdlbmNlIGRyb3BwZWQgdGhlIHBvc2l0aW9uLFxuICAgKiBzbyB0aGUgb25seSBwcm9wZXJ0eSBtaW5kLW1hcHBlciBjb3VsZCBub3QgYWRvcHQgd2FzIHRoZSBvcmRlcmluZy4gQXBwbGllZCxcbiAgICogd2l0aCBldmVyeSBraXQtYnVuZGxpbmcgc3BlbGwgcmVidWlsdDogKiooYSkgc291cmNlIGVkaXRzIG5lZWRlZCBhdCB0aGVcbiAgICogb3RoZXIgZml2ZSBhZG9wdGVyczogWkVSTyoqIOKAlCB0aGUgZmllbGQgaXMgb3B0aW9uYWwgYW5kIG5vYm9keSBwYXNzZXMgaXQ7XG4gICAqICoqKGIpIGJ5dGVzIG9mIGFueSBvdGhlciBhZG9wdGVyJ3MgV0lSRSB0aGF0IGRpZmZlcjogWkVSTyoqIOKAlCBhc3Ryb2xhYmUsXG4gICAqIGJvdW50eSwgZ2xhbW91ciwgaW1hZ28gYW5kIG1hZ3BpZSB3ZXJlIGRyaXZlbiB1bmRlciB0aGVpciBvd24gc3VpdGVzIGFuZFxuICAgKiB0aGVpciByZWxlYXNlIGRyaXZlcywgYW5kIG5vbmUgb2YgdGhlbSB3cml0ZXMgYXQgb3Blbi4gQm90aCBudW1iZXJzIHplcm8gaXNcbiAgICogd2hhdCBcInRoZSBraXQgcmVtb3ZlZCBpdCB3aGVuIGl0IGNvcGllZFwiIG1lYW5zIG9wZXJhdGlvbmFsbHkuXG4gICAqXG4gICAqIOKaoCBBTkQgVEhFIEhPT0sgV0FTIFJFSkVDVEVEIE9OQ0UsIEZPUiBBIFJFQVNPTiBUSEFUIERPRVMgTk9UIFJFQUNIIFRISVNcbiAgICogQ0FTRS4gRDMyJ3Mgbm90LXRha2VuIGFyZ3VlZCBhZ2FpbnN0IFwiYSBgc3NlUmVzcG9uc2VgIGhvb2sgdGhhdCBoYW5kcyB0aGVcbiAgICogY2FsbGVyIGEgcmF3IGBzZW5kYCDigKYgdGhlIGNhbGxlciB0aGVuIGhhcyB0byBrZWVwIGl0cyBvd24gY29sbGVjdGlvbiBvZlxuICAgKiB0aGVtXCIg4oCUIGFnYWluc3QgZ2xhbW91cidzIHByZXNlbmNlIEJST0FEQ0FTVCwgd2hpY2ggcHVzaGVzIHRvXG4gICAqIGFscmVhZHktb3BlbiBzdHJlYW1zIGZyb20gb3V0c2lkZSBhbmQgZG9lcyBuZWVkIGEgY29sbGVjdGlvbi4gVGhpcyBpcyBvbmVcbiAgICogZnJhbWUsIG9uIG9uZSBzdHJlYW0sIGF0IG9wZW4sIGFuZCB0aGUgY2FsbGVyIGtlZXBzIG5vIGNvbGxlY3Rpb24gYXQgYWxsLlxuICAgKiBBIHJlamVjdGlvbiBpcyBzY29wZWQgdG8gdGhlIGNhc2UgdGhhdCBwcm9kdWNlZCBpdC5cbiAgICovXG4gIG9wZW5GcmFtZXM/OiAoKSA9PiBzdHJpbmdbXTtcbiAgLyoqIFJ1biBhZnRlciB0aGUgc3RyZWFtIGlzIHN1YnNjcmliZWQgKHByZXNlbmNlIHVwLCBhY3Rpdml0eSB0b3VjaCkuICovXG4gIG9uT3Blbj86ICgpID0+IHZvaWQ7XG4gIC8qKiBSdW4gZXhhY3RseSBvbmNlLCBmcm9tIHdoaWNoZXZlciB0ZWFyZG93biBwYXRoIGZpcmVzIGZpcnN0LiAqL1xuICBvbkNsb3NlPzogKCkgPT4gdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNzZVJlc3BvbnNlPFQgZXh0ZW5kcyBvYmplY3Q+KG9wdHM6IFNzZU9wdGlvbnM8VD4pOiBSZXNwb25zZSB7XG4gIGNvbnN0IHsgbG9nLCBzaW5jZSwgaGVhcnRiZWF0TXMsIGNsaWVudHMsIHNpZ25hbCwgZmlsdGVyLCBvcGVuRnJhbWVzLCBvbk9wZW4sIG9uQ2xvc2UgfSA9IG9wdHM7XG5cbiAgbGV0IHVuc3Vic2NyaWJlOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgbGV0IGtlZXBhbGl2ZTogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgbnVsbCA9IG51bGw7XG4gIGxldCBjbG9zZWQgPSBmYWxzZTtcbiAgLy8gVGhlIHJlZ2lzdHJ5IGVudHJ5IGZvciBUSElTIHN0cmVhbS4gSXRzIG1ldGhvZHMgYXJlIGZpbGxlZCBpbiBieSBgc3RhcnRgLFxuICAvLyB3aGljaCBpcyB3aGVyZSB0aGUgY29udHJvbGxlciBleGlzdHM7IHRoZSBvYmplY3QgaWRlbnRpdHkgaXMgc3RhYmxlIGZyb21cbiAgLy8gaGVyZSBzbyBgdGVhcmRvd25gIGNhbiByZW1vdmUgZXhhY3RseSB0aGlzIGVudHJ5LlxuICBjb25zdCBjbGllbnQ6IFNzZUNsaWVudCA9IHsgY2xvc2U6ICgpID0+IHt9LCBzZW5kOiAoKSA9PiB7fSB9O1xuXG4gIGNvbnN0IHRlYXJkb3duID0gKCkgPT4ge1xuICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICBjbG9zZWQgPSB0cnVlO1xuICAgIGlmIChrZWVwYWxpdmUgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoa2VlcGFsaXZlKTtcbiAgICB1bnN1YnNjcmliZT8uKCk7XG4gICAgY2xpZW50cz8uZGVsZXRlKGNsaWVudCk7XG4gICAgb25DbG9zZT8uKCk7XG4gIH07XG5cbiAgY29uc3Qgc3RyZWFtID0gbmV3IFJlYWRhYmxlU3RyZWFtKHtcbiAgICBzdGFydChjb250cm9sbGVyKSB7XG4gICAgICBjb25zdCBlbmNvZGVyID0gbmV3IFRleHRFbmNvZGVyKCk7XG4gICAgICBjb25zdCBzYWZlRW5xdWV1ZSA9IChjaHVuazogc3RyaW5nKSA9PiB7XG4gICAgICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb250cm9sbGVyLmVucXVldWUoZW5jb2Rlci5lbmNvZGUoY2h1bmspKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgdGVhcmRvd24oKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIGNsaWVudC5jbG9zZSA9ICgpID0+IHtcbiAgICAgICAgdGVhcmRvd24oKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb250cm9sbGVyLmNsb3NlKCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8qIGFscmVhZHkgY2xvc2VkIGJ5IHRoZSBydW50aW1lICovXG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICAvLyDim5QgYHNlbmRgIEdPRVMgVEhST1VHSCBgc2FmZUVucXVldWVgLCBzbyBhbiBvdXQtb2YtYmFuZCBmcmFtZSBvYmV5cyB0aGVcbiAgICAgIC8vIHNhbWUgY2xvc2VkLWNoZWNrIGFuZCB0aGUgc2FtZSB0ZWFyZG93bi1vbi10aHJvdyBhcyBhIGxvZ2dlZCBvbmUuIEFcbiAgICAgIC8vIGRhZW1vbiBtdXN0IG5vdCBiZSBhYmxlIHRvIHdyaXRlIHRvIGEgc3RyZWFtIHRoaXMgbW9kdWxlIGhhcyB0b3JuIGRvd24uXG4gICAgICBjbGllbnQuc2VuZCA9IHNhZmVFbnF1ZXVlO1xuXG4gICAgICAvLyDim5QgQU4gT1BFTklORyBDT01NRU5ULCBCRUZPUkUgQU5ZVEhJTkcgRUxTRS4gSXQgZmx1c2hlcyB0aGUgcmVzcG9uc2VcbiAgICAgIC8vIGhlYWRlcnMgaW1tZWRpYXRlbHk6IHNvbWUgSFRUUCBjbGllbnRzIOKAlCBCdW4ncyBvd24gYGZldGNoKClgIGluY2x1ZGVkIOKAlFxuICAgICAgLy8gYnVmZmVyIHVudGlsIHRoZSBmaXJzdCBieXRlIG9mIGJvZHkgYXJyaXZlcywgc28gYSBnZW51aW5lbHkgcXVpZXQgU1NFXG4gICAgICAvLyBzdHJlYW0gd291bGQgb3RoZXJ3aXNlIGxlYXZlIHRoZSBjYWxsZXIncyBgZmV0Y2goKWAgdW5yZXNvbHZlZC4gRXZlcnlcbiAgICAgIC8vIGhvdXNlIHRhaWwgY2xpZW50IHJlYWRzIGA6YCBsaW5lcyBhcyBjb21tZW50cyBhbmQgZHJvcHMgdGhlbS5cbiAgICAgIHNhZmVFbnF1ZXVlKFwiOiBjb25uZWN0ZWRcXG5cXG5cIik7XG5cbiAgICAgIC8vIOKblCBCRUZPUkUgVEhFIFJFUExBWSwgQU5EIFRIRSBPUkRFUiBJUyBUSEUgV0hPTEUgUE9JTlQg4oCUIHNlZVxuICAgICAgLy8gYG9wZW5GcmFtZXNgIGluIHRoZSBvcHRpb25zIGFib3ZlLiBBIGdyb3VuZGluZyBmcmFtZSB3cml0dGVuIGhlcmUgaXNcbiAgICAgIC8vIHRoZSBzdHJlYW0ncyBmaXJzdCBkYXRhIGxpbmU7IHdyaXR0ZW4gZnJvbSBgb25PcGVuYCBpdCBhcnJpdmVzIGFmdGVyXG4gICAgICAvLyB0aGUgcmVwbGF5ZWQgYmFja2xvZywgd2hpY2ggaXMgYSBkaWZmZXJlbnQgY29udHJhY3Qgd2VhcmluZyB0aGUgc2FtZVxuICAgICAgLy8gdHlwZXMuXG4gICAgICBpZiAob3BlbkZyYW1lcykgZm9yIChjb25zdCBjaHVuayBvZiBvcGVuRnJhbWVzKCkpIHNhZmVFbnF1ZXVlKGNodW5rKTtcblxuICAgICAgdW5zdWJzY3JpYmUgPSBsb2cuc3Vic2NyaWJlKHNpbmNlLCAoZnJhbWUpID0+IHtcbiAgICAgICAgaWYgKGZpbHRlciAmJiAhZmlsdGVyKGZyYW1lKSkgcmV0dXJuO1xuICAgICAgICBzYWZlRW5xdWV1ZShgZGF0YTogJHtKU09OLnN0cmluZ2lmeShmcmFtZSl9XFxuXFxuYCk7XG4gICAgICB9KTtcblxuICAgICAga2VlcGFsaXZlID0gc2V0SW50ZXJ2YWwoKCkgPT4gc2FmZUVucXVldWUoXCI6IGhiXFxuXFxuXCIpLCBoZWFydGJlYXRNcyk7XG4gICAgICBzaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCB0ZWFyZG93biwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgY2xpZW50cz8uYWRkKGNsaWVudCk7XG4gICAgICBvbk9wZW4/LigpO1xuICAgIH0sXG4gICAgY2FuY2VsKCkge1xuICAgICAgdGVhcmRvd24oKTtcbiAgICB9LFxuICB9KTtcblxuICByZXR1cm4gbmV3IFJlc3BvbnNlKHN0cmVhbSwge1xuICAgIGhlYWRlcnM6IHtcbiAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwidGV4dC9ldmVudC1zdHJlYW1cIixcbiAgICAgIFwiQ2FjaGUtQ29udHJvbFwiOiBcIm5vLWNhY2hlXCIsXG4gICAgICBDb25uZWN0aW9uOiBcImtlZXAtYWxpdmVcIixcbiAgICB9LFxuICB9KTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKipcbiAqIFRoZSBzbWFsbGVzdCBiZWF0IHRoaXMgbW9kdWxlIHdpbGwgaGFuZCBiYWNrLCBpbiBtcyDigJQgdGhlIEZMT09SIGhhbGYgb2YgdGhlXG4gKiBjbGFtcCB3aG9zZSBjZWlsaW5nIGlzIGBpZGxlVGltZW91dCAvIDJgLlxuICpcbiAqIOKblCBJVCBFWElTVFMgQkVDQVVTRSBgaW50T3JgIFBBUlNFUyBXSVRIIGBwYXJzZUludGAsIEFORCBgcGFyc2VJbnRgIElTIExFTklFTlRcbiAqIFdIRVJFIElUIE1BVFRFUlMgTU9TVC4gYGludE9yYCBmYWxscyBiYWNrIHNhZmVseSBvbiBldmVyeXRoaW5nIHRoYXQgTE9PS1NcbiAqIGhvc3RpbGUg4oCUIGBcIlwiYCwgYFwiMFwiYCwgYFwiLTFcImAsIGBcImFiY1wiYCwgYFwiTmFOXCJgLCBgXCJJbmZpbml0eVwiYCBhbGwgdGFrZSB0aGVcbiAqIGZhbGxiYWNrIOKAlCBhbmQgdGhlbiByZWFkcyBgXCIxZTlcImAsIHRoZSBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXRcbiAqIGh1Z2VcIiwgYXMgKioxKiouIE1FQVNVUkVEIGF0IGdyYXBldmluZSdzIFBoYXNlIDYgcmVwYWlyLCBiZWZvcmUgdGhpcyBmbG9vcjpcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTFlOWAgcHV0IH41Mjgga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0VcbiAqIGNsaWVudCBpbiA1MjggbXMuIGBcIjMuOVwiYCBnaXZlcyAzIG1zIGFuZCBgXCI1YWJjXCJgIGdpdmVzIDUgbXMgdGhlIHNhbWUgd2F5LlxuICogQSBrbm9iIHdob3NlIGZhc3Rlc3Qgc2V0dGluZyBpcyBzcGVsbGVkIGxpa2UgaXRzIHNsb3dlc3QgaXMgYSBmbG9vZC5cbiAqXG4gKiDimqAgKipUSEUgRkxPT1IgSVMgSEVSRSBBTkQgTk9UIElOIGBpbnRPcmAg4oCUIHRoYXQgaXMgdGhlIHJ1bGluZywgbm90IGFuXG4gKiBhY2NpZGVudCBvZiB3aGVyZSBpdCB3YXMgZWFzeSB0byB3cml0ZSoqIChENzYpLiBgaW50T3JgIGlzIHRoZSBnZW5lcmFsIHBhcnNlclxuICogYmVoaW5kIGV2ZXJ5IGVudiBrbm9iIGluIHRoZSBraXQ7IHRoZXJlIGlzIG5vIHNpbmdsZSByb3N0ZXItY29ycmVjdCBtaW5pbXVtXG4gKiBmb3IgXCJhIHBvc2l0aXZlIGludGVnZXJcIiwgYW5kIHRpZ2h0ZW5pbmcgaXRzIFBBUlNFIChyZWplY3RpbmcgYDFlOWAgb3V0cmlnaHQpXG4gKiB3b3VsZCBjaGFuZ2Ugd2hhdCBldmVyeSBvdGhlciBrbm9iIGFjY2VwdHMsIHNpbGVudGx5LCBmb3IgdmFsdWVzIG5vYm9keSBoYXNcbiAqIGF1ZGl0ZWQuIGBoZWFydGJlYXRNc2AgYWxyZWFkeSBvd25zIG9uZSBlbmQgb2YgdGhpcyBpbnZhcmlhbnQsIGFuZCA1MDAgd2FzXG4gKiBhbHJlYWR5IHdyaXR0ZW4gaW50byBpdCBhcyB0aGUgc21hbGxlc3QgY2VpbGluZyBpdCB3b3VsZCBjb21wdXRlLiBUaGUgZmxvb3JcbiAqIGJlbG9uZ3MgYmVzaWRlIHRoZSBjZWlsaW5nLCB3aGVyZSB0aGUgcXVhbnRpdHkgaXMga25vd24uXG4gKi9cbmV4cG9ydCBjb25zdCBNSU5fSEVBUlRCRUFUX01TID0gNTAwO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4g4pqgIGBwYXJzZUludGAgc2VtYW50aWNzOiBgXCIxZTlcImBcbiAqICBpcyAxIGFuZCBgXCI1YWJjXCJgIGlzIDUuIEFueSBjYWxsZXIgd2l0aCBhIGtub3duIHNhZmUgbWluaW11bSBtdXN0IGNsYW1wIOKAlFxuICogIHNlZSBgTUlOX0hFQVJUQkVBVF9NU2AuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqIFRoZSBzZXJ2ZXIncyBgaWRsZVRpbWVvdXRgLCBpbiBTRUNPTkRTLCBjbGFtcGVkIHRvIHdoYXQgQnVuIGFjY2VwdHMuICovXG5leHBvcnQgZnVuY3Rpb24gaWRsZVRpbWVvdXRTZWMocmF3Pzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjayA9IE1BWF9JRExFX1RJTUVPVVRfU0VDKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKE1BWF9JRExFX1RJTUVPVVRfU0VDLCBpbnRPcihyYXcsIGZhbGxiYWNrKSkpO1xufVxuXG4vKipcbiAqIFRoZSBTU0UgaGVhcnRiZWF0LCBpbiBtcywgQ0xBTVBFRCBBVCBCT1RIIEVORFM6IG5ldmVyIGFib3ZlIGhhbGYgdGhlIGlkbGVcbiAqIHRpbWVvdXQsIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiBUaGUgY2VpbGluZyBpcyBhc3Ryb2xhYmUncywgYW5kIHRoZSBjZW5zdXMgbmFtZWQgaXQgY29udmVyZ2VuY2UgdGFyZ2V0ICM0OlxuICogdGhlIG90aGVyIGRhZW1vbnMgaGFyZC1jb2RlIDE1IHMgYWdhaW5zdCAyNTUgcyBhbmQgd3JpdGUgdGhlIHJlbGF0aW9uc2hpcFxuICogb25seSBpbiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBFbmZvcmNpbmdcbiAqIGBoZWFydGJlYXQgPD0gaWRsZVRpbWVvdXQgLyAyYCBtYWtlcyB0aGUgaW52YXJpYW50IHRydWUgZm9yIEFOWSBjb25maWd1cmVkXG4gKiBwYWlyLCB3aGljaCBpcyBleGFjdGx5IHRoZSBpbnZhcmlhbnQgd2hvc2UgdmlvbGF0aW9uIGNhdXNlZCB0aGUgYnVnIGFib3ZlLlxuICpcbiAqIOKaoCBUaGUgZmxvb3IgY2Fubm90IGZpZ2h0IHRoZSBjZWlsaW5nOiB0aGUgY2VpbGluZyBleHByZXNzaW9uIGlzIGl0c2VsZlxuICogYE1hdGgubWF4KDUwMCwg4oCmKWAsIHNvIGl0IGlzIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYCBhbmQgdGhlIHR3b1xuICogY2xhbXBzIGNhbiBuZXZlciBjcm9zcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgY29uc3QgY2VpbGluZyA9IE1hdGgubWF4KE1JTl9IRUFSVEJFQVRfTVMsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKTtcbiAgcmV0dXJuIE1hdGgubWluKE1hdGgubWF4KGludE9yKHJhdywgZmFsbGJhY2spLCBNSU5fSEVBUlRCRUFUX01TKSwgY2VpbGluZyk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIEdsYW1vdXIncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aCBoYWx2ZXNcbiAqIG9mIHRoZSBzcGVsbC5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIFRIRSBTRUFNLiBCZWZvcmUgUGhhc2UgMiB0aGUgaGVhcnRiZWF0IHdhcyBhIExJVEVSQUwgYDE1MDAwYFxuICogaW5zaWRlIGBzZXJ2ZXIudHNgJ3MgYHNzZVJlc3BvbnNlYCwgYW5kIGBjbGkudHNgIGhhZCBOTyBjb3JyZXNwb25kaW5nIG51bWJlclxuICogYXQgYWxsIOKAlCBpdHMgdGFpbCBsb29wIHNpbXBseSBibG9ja2VkIG9uIGByZWFkZXIucmVhZCgpYCBmb3JldmVyLCB3aGljaCBpcyB0aGVcbiAqIGZhaWx1cmUgYHRhaWxFdmVudHNgJ3Mgd2F0Y2hkb2cgZXhpc3RzIHRvIGVuZC4gTmVpdGhlciBmaWxlIGNvdWxkIGltcG9ydCB0aGVcbiAqIG90aGVyOiB0aGUgQ0xJIHJlYWNoaW5nIGludG8gdGhlIGRhZW1vbiB3b3VsZCBkcmFnIHRoZSB3aG9sZSBzZXJ2ZXIgZ3JhcGggaW50b1xuICogYGRpc3QvY2xpLmpzYC4gQSBtb2R1bGUgd2l0aCBubyBpbXBvcnRzIGJ1dCB0aGUga2l0J3MgZGVyaXZhdGlvbnMgaGFzIG5vIHN1Y2hcbiAqIGdyYXBoLCBzbyBib3RoIGhhbHZlcyBpbXBvcnQgdGhpcyBvbmUuXG4gKlxuICog4puUICoqQU5EIFRIRSBXQVRDSERPRyBJUyBERVJJVkVEIEZST00gR0xBTU9VUidTIE9XTiBIRUFSVEJFQVQsIE5FVkVSIENPUElFRFxuICogRlJPTSBBIFNJQkxJTkcuKiogVGhpcyBpcyBQaGFzZSAxYSdzIHJ1bGUgYW5kIGl0IGlzIHRoZSB3aG9sZSByZWFzb24gdGhlIGZpbGVcbiAqIGV4aXN0cyByYXRoZXIgdGhhbiBhIHNoYXJlZCBjb25zdGFudCBzb21ld2hlcmU6IGFzdHJvbGFiZSBiZWF0cyBhdCAxMCBzIGFuZFxuICogbWFncGllIGF0IDE1IHMsIHNvIGEgaGFyZC1jb2RlZCB3YXRjaGRvZyBpcyBjb3JyZWN0IGZvciBhdCBtb3N0IG9uZSBvZiB0aGVtLlxuICogQXN0cm9sYWJlIG1lYXN1cmVkIHdoYXQgYSBjb3BpZWQgbnVtYmVyIGRvZXMg4oCUIGEgNDUgcyB3YXRjaGRvZyBhZ2FpbnN0IGFuXG4gKiBlbnYtdHVuZWQgaGVhcnRiZWF0IHByb2R1Y2VkIHJlY29ubmVjdHMgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24sIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhbiB1bnJlbGF0ZWQgdGhpcmRcbiAqIGNvbnN0YW50IGFic29yYmVkIHRoZSBjaHVybi4gYHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUylgIGNhbm5vdCBkcmlmdCBmcm9tXG4gKiB0aGUgYmVhdCBpdCBpcyB3YXRjaGluZywgd2hhdGV2ZXIgdGhlIGJlYXQgYmVjb21lcy5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUuIFRoZSBtb21lbnQgdGhpcyBpbXBvcnRzIGFueXRoaW5nIG9mIHRoZVxuICogZGFlbW9uJ3MsIHRoZSBDTEkgaXMgYmFjayB0byBkcmFnZ2luZyB0aGUgc2VydmVyIGdyYXBoIGFuZCB0aGUgc2VhbSBjbG9zZXMuXG4gKi9cblxuaW1wb3J0IHtcbiAgREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKlxuICogQnVuJ3MgbWF4aW11bS4gVGhpcyBpcyBnbGFtb3VyJ3Mgb3duIG1lYXN1cmVkIHZhbHVlLCBub3QgYW4gaW5oZXJpdGVkIG9uZTpcbiAqIGBzZXJ2ZXIudHNgIGNhcnJpZWQgYGlkbGVUaW1lb3V0OiAyNTVgIHdpdGggYSBjb21tZW50IHJlY29yZGluZyB0aGF0IEJ1bidzXG4gKiBkZWZhdWx0IDEwIHMgY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmUgdGhlIDE1IHMga2VlcGFsaXZlIGV2ZXJcbiAqIGZpcmVzLiBHbGFtb3VyIGRvZXMgbm90IGVudi10dW5lIGl0IOKAlCBhIHNlc3Npb24gZGFlbW9uJ3MgY29ubmVjdGlvbiBsaWZldGltZVxuICogaXMgbm90IHNvbWV0aGluZyBhIGNhbGxlciBoYXMgZXZlciBuZWVkZWQgdG8gc2hvcnRlbi5cbiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBNQVhfSURMRV9USU1FT1VUX1NFQztcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0LCBhbmQgZ2xhbW91cidzIG93biBsaXRlcmFsIGJlZm9yZSB0aGlzIGZpbGUgZXhpc3RlZC4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gREVGQVVMVF9IRUFSVEJFQVRfTVM7XG5cbi8qKlxuICogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cywgREVSSVZFRC5cbiAqXG4gKiDimqAgNDUsMDAwIG1zIHRvZGF5LCB3aGljaCBpcyB0aGUgc2FtZSBudW1iZXIgYGNtZE9wZW5gJ3MgYC0tc3RhcnQtdGltZW91dGBcbiAqIGRlZmF1bHQgaGFwcGVucyB0byBiZS4gVGhleSBhcmUgVU5SRUxBVEVEIOKAlCBvbmUgYm91bmRzIGEgZmlyc3QgYnVuZGxlIGJ1aWxkLFxuICogdGhlIG90aGVyIGJvdW5kcyBhIHNpbGVudCBzb2NrZXQg4oCUIGFuZCB0aGUgY29pbmNpZGVuY2UgaXMgbmFtZWQgaGVyZSBzbyBub2JvZHlcbiAqIGxhdGVyIFwiZGUtZHVwbGljYXRlc1wiIHRoZW0gaW50byBvbmUgY29uc3RhbnQuXG4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpO1xuIiwKICAgICJpbXBvcnQgeyBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHtcbiAgZGVmYXVsdFN0YXRlLFxuICB0eXBlIEdsYW1vdXJTdGF0ZSxcbiAgdHlwZSBMaWJyYXJ5SXRlbSxcbn0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9nbGFtb3VyL3NoYXJlZC90eXBlc1wiO1xuXG5jb25zdCBFWFRfQllfTUlNRTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCJpbWFnZS93ZWJwXCI6IFwid2VicFwiLFxuICBcImltYWdlL3BuZ1wiOiBcInBuZ1wiLFxuICBcImltYWdlL2pwZWdcIjogXCJqcGdcIixcbiAgXCJpbWFnZS9naWZcIjogXCJnaWZcIixcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBzYXZlRGF0YVVybChkaXI6IHN0cmluZywgaWQ6IHN0cmluZywgZGF0YVVybDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgbSA9IC9eZGF0YTooW147LF0rKT8oO2Jhc2U2NCk/LCguKikkL3MuZXhlYyhkYXRhVXJsKTtcbiAgaWYgKCFtIHx8ICFkaXIpIHJldHVybiBcIlwiO1xuICBjb25zdCBtaW1lID0gKG1bMV0gPz8gXCJhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1cIikudG9Mb3dlckNhc2UoKTtcbiAgY29uc3QgYm9keSA9IG1bM107XG4gIGNvbnN0IGJ1ZiA9IG1bMl0gPyBCdWZmZXIuZnJvbShib2R5LCBcImJhc2U2NFwiKSA6IEJ1ZmZlci5mcm9tKGRlY29kZVVSSUNvbXBvbmVudChib2R5KSwgXCJ1dGY4XCIpO1xuICBjb25zdCBleHQgPSBFWFRfQllfTUlNRVttaW1lXSA/PyBcImJpblwiO1xuICBjb25zdCBzYWZlSWQgPSBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV8tXS9nLCBcIl9cIik7XG4gIGNvbnN0IHBhdGggPSBqb2luKGRpciwgYCR7c2FmZUlkfS4ke2V4dH1gKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKHBhdGgsIGJ1Zik7XG4gICAgcmV0dXJuIHBhdGg7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBcIlwiO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzYXZlVGV4dChkaXI6IHN0cmluZywgaWQ6IHN0cmluZywgbmFtZTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBzYWZlID0gbmFtZS5yZXBsYWNlKC9bXmEtekEtWjAtOS5fLV0vZywgXCJfXCIpIHx8IGAke2lkfS5tZGA7XG4gIGNvbnN0IHBhdGggPSBqb2luKGRpciwgYCR7aWR9LSR7c2FmZX1gKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKHBhdGgsIHRleHQsIFwidXRmOFwiKTtcbiAgICByZXR1cm4gcGF0aDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFwiXCI7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hdGVyaWFsaXplSXRlbShmaWxlc0Rpcjogc3RyaW5nLCBpdGVtOiBMaWJyYXJ5SXRlbSk6IHZvaWQge1xuICBpZiAoaXRlbS5zcmMpIHtcbiAgICBjb25zdCBwID0gc2F2ZURhdGFVcmwoZmlsZXNEaXIsIGl0ZW0uaWQsIGl0ZW0uc3JjKTtcbiAgICBpZiAocCkgaXRlbS5wYXRoID0gcDtcbiAgfSBlbHNlIGlmIChpdGVtLnRleHQpIHtcbiAgICBjb25zdCBwID0gc2F2ZVRleHQoZmlsZXNEaXIsIGl0ZW0uaWQsIGl0ZW0udGl0bGUsIGl0ZW0udGV4dCk7XG4gICAgaWYgKHApIGl0ZW0ucGF0aCA9IHA7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNhdmVTbmFwc2hvdChzbmFwc2hvdHNEaXI6IHN0cmluZywgc2Vzc2lvbklkOiBzdHJpbmcsIHN0YXRlOiBHbGFtb3VyU3RhdGUpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoc25hcHNob3RzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oc25hcHNob3RzRGlyLCBgJHtzZXNzaW9uSWR9Lmpzb25gKSwgSlNPTi5zdHJpbmdpZnkoc3RhdGUpKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogcGVyc2lzdGVuY2UgaXMgYmVzdC1lZmZvcnQgKi9cbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gbG9hZFNuYXBzaG90KHBhdGg6IHN0cmluZywgdGl0bGU6IHN0cmluZywgaW50ZW50OiBzdHJpbmcpOiBHbGFtb3VyU3RhdGUge1xuICBjb25zdCBzbmFwID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSBhcyBQYXJ0aWFsPEdsYW1vdXJTdGF0ZT47XG4gIC8vIE1lcmdlIG92ZXIgZGVmYXVsdHMgc28gb2xkZXIgc25hcHNob3RzIGdhaW4gbmV3IHRvcC1sZXZlbCBmaWVsZHMuXG4gIGNvbnN0IG1lcmdlZCA9IHsgLi4uZGVmYXVsdFN0YXRlKHRpdGxlLCBpbnRlbnQpLCAuLi5zbmFwIH0gYXMgR2xhbW91clN0YXRlO1xuICAvLyBOb3JtYWxpemUgc3R5bGUtZ3VpZGUgc2VjdGlvbnMgc28gc25hcHNob3RzIHByZWRhdGluZyBuZXdlciBwZXItc2VjdGlvblxuICAvLyBmaWVsZHMgKHByb21wdHMsIGNvbG9ycykgc3RpbGwgc2F0aXNmeSB0aGUgY3VycmVudCBzaGFwZS5cbiAgbWVyZ2VkLnN0eWxlR3VpZGUgPSBtZXJnZWQuc3R5bGVHdWlkZS5tYXAoKHMpID0+ICh7XG4gICAgLi4ucyxcbiAgICBwcm9tcHRzOiBzLnByb21wdHMgPz8gW10sXG4gICAgY29sb3JzOiBzLmNvbG9ycyA/PyBbXSxcbiAgfSkpO1xuICByZXR1cm4gbWVyZ2VkO1xufVxuIiwKICAgICJpbXBvcnQgdHlwZSB7XG4gIEFnZW50Q29tbWFuZCxcbiAgQ2Fub25JbWcsXG4gIEdlbk1ldGEsXG4gIEdsYW1vdXJTdGF0ZSxcbiAgSXRlbUtpbmQsXG4gIExlYW5JdGVtLFxuICBMZWFuU3RhdGUsXG4gIExpYnJhcnlJdGVtLFxuICBNZXNzYWdlLFxuICBTYXZlZFN0eWxlLFxuICBTZWN0aW9uS2V5LFxuICBTZWN0aW9uU3RhdHVzLFxuICBTd2F0Y2gsXG59IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvZ2xhbW91ci9zaGFyZWQvdHlwZXNcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIG1ha2VJdGVtKHA6IHtcbiAgaWQ6IHN0cmluZztcbiAga2luZDogSXRlbUtpbmQ7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIHNyYz86IHN0cmluZztcbiAgcGF0aD86IHN0cmluZztcbiAgdGV4dD86IHN0cmluZztcbiAgbWltZT86IHN0cmluZztcbiAgdGFncz86IHN0cmluZ1tdO1xuICBjcmVhdGVkQXQ6IG51bWJlcjtcbiAgZ2VuPzogR2VuTWV0YSB8IG51bGw7XG59KTogTGlicmFyeUl0ZW0ge1xuICByZXR1cm4ge1xuICAgIGlkOiBwLmlkLFxuICAgIGtpbmQ6IHAua2luZCxcbiAgICB0aXRsZTogcC50aXRsZSxcbiAgICBzcmM6IHAuc3JjID8/IFwiXCIsXG4gICAgcGF0aDogcC5wYXRoID8/IFwiXCIsXG4gICAgdGV4dDogcC50ZXh0ID8/IFwiXCIsXG4gICAgbWltZTogcC5taW1lID8/IFwiXCIsXG4gICAgdGFnczogcC50YWdzID8/IFtdLFxuICAgIHN0YXJyZWQ6IGZhbHNlLFxuICAgIGxpa2VkOiBmYWxzZSxcbiAgICBhbm5vdGF0aW9uczogeyBhZ2VudDogXCJcIiwgaHVtYW46IFwiXCIgfSxcbiAgICBjYW5vbmljYWw6IGZhbHNlLFxuICAgIGNhbm9uOiBbXSxcbiAgICBhcmNoaXZlZDogZmFsc2UsXG4gICAgY3JlYXRlZEF0OiBwLmNyZWF0ZWRBdCxcbiAgICBnZW46IHAuZ2VuID8/IG51bGwsXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRJdGVtKHN0YXRlOiBHbGFtb3VyU3RhdGUsIGl0ZW06IExpYnJhcnlJdGVtKTogYm9vbGVhbiB7XG4gIGlmIChzdGF0ZS5saWJyYXJ5LnNvbWUoKGkpID0+IGkuaWQgPT09IGl0ZW0uaWQpKSByZXR1cm4gZmFsc2U7XG4gIHN0YXRlLmxpYnJhcnkucHVzaChpdGVtKTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZWxlY3RJdGVtcyhzdGF0ZTogR2xhbW91clN0YXRlLCBpZHM6IHN0cmluZ1tdKTogdm9pZCB7XG4gIHN0YXRlLnNlbGVjdGVkSWRzID0gWy4uLmlkc107XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRTdGFyKHN0YXRlOiBHbGFtb3VyU3RhdGUsIGlkOiBzdHJpbmcsIHN0YXJyZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3QgaXQgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKGkpID0+IGkuaWQgPT09IGlkKTtcbiAgaWYgKCFpdCkgcmV0dXJuIGZhbHNlO1xuICBpdC5zdGFycmVkID0gc3RhcnJlZDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRMaWtlKHN0YXRlOiBHbGFtb3VyU3RhdGUsIGlkOiBzdHJpbmcsIGxpa2VkOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGl0ID0gc3RhdGUubGlicmFyeS5maW5kKChpKSA9PiBpLmlkID09PSBpZCk7XG4gIGlmICghaXQpIHJldHVybiBmYWxzZTtcbiAgaXQubGlrZWQgPSBsaWtlZDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhbm5vdGF0ZShcbiAgc3RhdGU6IEdsYW1vdXJTdGF0ZSxcbiAgaWQ6IHN0cmluZyxcbiAgd2hvOiBcImFnZW50XCIgfCBcImh1bWFuXCIsXG4gIHRleHQ6IHN0cmluZyxcbik6IGJvb2xlYW4ge1xuICBjb25zdCBpdCA9IHN0YXRlLmxpYnJhcnkuZmluZCgoaSkgPT4gaS5pZCA9PT0gaWQpO1xuICBpZiAoIWl0KSByZXR1cm4gZmFsc2U7XG4gIGl0LmFubm90YXRpb25zW3dob10gPSB0ZXh0O1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZE1lc3NhZ2Uoc3RhdGU6IEdsYW1vdXJTdGF0ZSwgbTogTWVzc2FnZSk6IHZvaWQge1xuICBzdGF0ZS5tZXNzYWdlcy5wdXNoKG0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlU2VjdGlvbihcbiAgc3RhdGU6IEdsYW1vdXJTdGF0ZSxcbiAga2V5OiBTZWN0aW9uS2V5LFxuICBwYXRjaDogeyBjb250ZW50Pzogc3RyaW5nOyBzdGF0dXM/OiBTZWN0aW9uU3RhdHVzOyBwcm9tcHRzPzogc3RyaW5nW107IGNvbG9ycz86IFN3YXRjaFtdIH0sXG4pOiBib29sZWFuIHtcbiAgY29uc3Qgc2VjID0gc3RhdGUuc3R5bGVHdWlkZS5maW5kKChzKSA9PiBzLmtleSA9PT0ga2V5KTtcbiAgaWYgKCFzZWMpIHJldHVybiBmYWxzZTtcbiAgaWYgKHBhdGNoLmNvbnRlbnQgIT09IHVuZGVmaW5lZCkgc2VjLmNvbnRlbnQgPSBwYXRjaC5jb250ZW50O1xuICBpZiAocGF0Y2guc3RhdHVzICE9PSB1bmRlZmluZWQpIHNlYy5zdGF0dXMgPSBwYXRjaC5zdGF0dXM7XG4gIGlmIChwYXRjaC5wcm9tcHRzICE9PSB1bmRlZmluZWQpIHNlYy5wcm9tcHRzID0gcGF0Y2gucHJvbXB0cztcbiAgaWYgKHBhdGNoLmNvbG9ycyAhPT0gdW5kZWZpbmVkKSBzZWMuY29sb3JzID0gcGF0Y2guY29sb3JzO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldEZvY3VzKFxuICBzdGF0ZTogR2xhbW91clN0YXRlLFxuICBpZHM6IHN0cmluZ1tdLFxuICBvd25lcjogXCJ5b3VcIiB8IFwiYWdlbnRcIixcbiAgbm90ZSA9IFwiXCIsXG4pOiB2b2lkIHtcbiAgc3RhdGUuc2NvcGUgPSBcImZvY3VzXCI7XG4gIHN0YXRlLmZvY3VzU2V0ID0gWy4uLmlkc107XG4gIHN0YXRlLmZvY3VzT3duZXIgPSBvd25lcjtcbiAgc3RhdGUuZm9jdXNOb3RlID0gbm90ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyRm9jdXMoc3RhdGU6IEdsYW1vdXJTdGF0ZSk6IHZvaWQge1xuICBzdGF0ZS5zY29wZSA9IFwiYWxsXCI7XG4gIHN0YXRlLmZvY3VzU2V0ID0gW107XG4gIHN0YXRlLmZvY3VzT3duZXIgPSBudWxsO1xuICBzdGF0ZS5mb2N1c05vdGUgPSBcIlwiO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0Q2Fub25pY2FsKHN0YXRlOiBHbGFtb3VyU3RhdGUsIGlkOiBzdHJpbmcsIGNhbm9uaWNhbDogYm9vbGVhbik6IGJvb2xlYW4ge1xuICBjb25zdCBpdCA9IHN0YXRlLmxpYnJhcnkuZmluZCgoaSkgPT4gaS5pZCA9PT0gaWQpO1xuICBpZiAoIWl0KSByZXR1cm4gZmFsc2U7XG4gIGl0LmNhbm9uaWNhbCA9IGNhbm9uaWNhbDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhcmNoaXZlVHJheVN0eWxlKHN0YXRlOiBHbGFtb3VyU3RhdGUsIGlkOiBzdHJpbmcsIGFyY2hpdmVkOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIGNvbnN0IHN0ID0gc3RhdGUudHJheS5maW5kKChzKSA9PiBzLmlkID09PSBpZCk7XG4gIGlmICghc3QpIHJldHVybiBmYWxzZTtcbiAgc3QuYXJjaGl2ZWQgPSBhcmNoaXZlZDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFN0eWxlSXRlbShcbiAgc3R5bGU6IFNhdmVkU3R5bGUsXG4gIGNhbm9uOiBDYW5vbkltZ1tdLFxuICBjcmVhdGVkQXQ6IG51bWJlcixcbik6IExpYnJhcnlJdGVtIHtcbiAgcmV0dXJuIHtcbiAgICBpZDogYHN0eWxlLSR7c3R5bGUuaWR9YCxcbiAgICBraW5kOiBcInN0eWxlXCIsXG4gICAgdGl0bGU6IHN0eWxlLmxhYmVsLFxuICAgIHNyYzogXCJcIixcbiAgICBwYXRoOiBcIlwiLFxuICAgIHRleHQ6IHN0eWxlLnRleHQsXG4gICAgbWltZTogXCJcIixcbiAgICB0YWdzOiBbXSxcbiAgICBzdGFycmVkOiBmYWxzZSxcbiAgICBsaWtlZDogZmFsc2UsXG4gICAgYW5ub3RhdGlvbnM6IHsgYWdlbnQ6IFwiXCIsIGh1bWFuOiBcIlwiIH0sXG4gICAgY2Fub25pY2FsOiBmYWxzZSxcbiAgICBjYW5vbixcbiAgICBhcmNoaXZlZDogZmFsc2UsXG4gICAgY3JlYXRlZEF0LFxuICAgIGdlbjogbnVsbCxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldEl0ZW1BcmNoaXZlZChzdGF0ZTogR2xhbW91clN0YXRlLCBpZDogc3RyaW5nLCBhcmNoaXZlZDogYm9vbGVhbik6IGJvb2xlYW4ge1xuICBjb25zdCBpdCA9IHN0YXRlLmxpYnJhcnkuZmluZCgoaSkgPT4gaS5pZCA9PT0gaWQpO1xuICBpZiAoIWl0KSByZXR1cm4gZmFsc2U7XG4gIGl0LmFyY2hpdmVkID0gYXJjaGl2ZWQ7XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0R2VuQ29zdChzdGF0ZTogR2xhbW91clN0YXRlLCBpZDogc3RyaW5nLCBjb3N0OiBudW1iZXIpOiBib29sZWFuIHtcbiAgY29uc3QgaXQgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKGkpID0+IGkuaWQgPT09IGlkKTtcbiAgaWYgKCFpdD8uZ2VuKSByZXR1cm4gZmFsc2U7XG4gIGl0Lmdlbi5jb3N0ID0gY29zdDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIEJhY2tmaWxsIHRoZSByZWFsIHByb21wdCBhbmQvb3IgcmVmcyBvbnRvIGEgZ2VuIGFmdGVyIHRoZSBmYWN0LCBzbyBpdHMgc3RvcmVkXG4vLyBtZXRhZGF0YSBpcyB0aGUgcmVwcm9kdWNpYmxlIHByb21wdCAobm90IGEgbGFiZWwpIOKAlCBubyBzZXNzaW9uIGJvdW5jZSBuZWVkZWQuXG5leHBvcnQgZnVuY3Rpb24gc2V0R2VuTWV0YShcbiAgc3RhdGU6IEdsYW1vdXJTdGF0ZSxcbiAgaWQ6IHN0cmluZyxcbiAgcGF0Y2g6IHsgcHJvbXB0Pzogc3RyaW5nOyBjdXN0b20/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IH0sXG4pOiBib29sZWFuIHtcbiAgY29uc3QgaXQgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKGkpID0+IGkuaWQgPT09IGlkKTtcbiAgaWYgKCFpdD8uZ2VuKSByZXR1cm4gZmFsc2U7XG4gIGlmICh0eXBlb2YgcGF0Y2gucHJvbXB0ID09PSBcInN0cmluZ1wiKSBpdC5nZW4ucHJvbXB0ID0gcGF0Y2gucHJvbXB0O1xuICBpZiAocGF0Y2guY3VzdG9tKSBpdC5nZW4uY3VzdG9tID0geyAuLi4oaXQuZ2VuLmN1c3RvbSA/PyB7fSksIC4uLnBhdGNoLmN1c3RvbSB9O1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxlYW5JdGVtKGl0OiBMaWJyYXJ5SXRlbSk6IExlYW5JdGVtIHtcbiAgY29uc3QgeyBzcmM6IF9zLCB0ZXh0OiBfdCwgY2Fub246IF9jLCAuLi5yZXN0IH0gPSBpdDtcbiAgcmV0dXJuIHJlc3Q7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsZWFuU3RhdGUoczogR2xhbW91clN0YXRlKTogTGVhblN0YXRlIHtcbiAgcmV0dXJuIHsgLi4ucywgbGlicmFyeTogcy5saWJyYXJ5Lm1hcChsZWFuSXRlbSkgfTtcbn1cblxuLy8gQm9hcmQgbW92ZXMgdGhhdCBtdXRhdGUgc3RhdGUgKyBicm9hZGNhc3QgYnV0IGVtaXQgTk8gYWdlbnQgZXZlbnQuXG5leHBvcnQgY29uc3QgQU1CSUVOVF9DTElFTlQgPSBuZXcgU2V0PHN0cmluZz4oW1xuICBcIml0ZW0uc2VsZWN0XCIsXG4gIFwiaXRlbS5zdGFyXCIsXG4gIFwiaXRlbS5saWtlXCIsXG4gIFwiZm9jdXMuc2V0XCIsXG4gIFwiZm9jdXMuY2xlYXJcIixcbiAgXCJpdGVtLmNhbm9uaWNhbFwiLFxuICBcIml0ZW0uYXJjaGl2ZVwiLFxuICBcIml0ZW0uYW5ub3RhdGVcIiwgLy8gYSBwZXItaXRlbSBub3RlOiBzdG9yZWQgKyByZWFkIG9uIGRlbWFuZCwgbm90IHB1c2hlZCBhcyBhbiBldmVudFxuXSk7XG5leHBvcnQgZnVuY3Rpb24gaXNJbXBlcmF0aXZlKHR5cGU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gIUFNQklFTlRfQ0xJRU5ULmhhcyh0eXBlKTtcbn1cblxuLy8gUmV0dXJucyB3aGV0aGVyIHRoZSBjb21tYW5kIHR5cGUgd2FzIFJFQ09HTklTRUQg4oCUIHRoZSB2ZXJkaWN0IHRoZSAvY21kIHJvdXRlXG4vLyBwcm9wYWdhdGVzICgjODQpLiBSZWNvZ25pc2VkLWFuZC1hcHBsaWVkIGlzIGB0cnVlYDsgYW4gdW5rbm93biB0eXBlIGlzXG4vLyBgZmFsc2VgLiBUaGlzIGlzIGRlbGliZXJhdGVseSBub3QgXCJkaWQgc3RhdGUgY2hhbmdlXCI6IGEgcmVjb2duaXNlZCBjb21tYW5kXG4vLyB0aGF0IGlzIGEgbGVnaXRpbWF0ZSBuby1vcCBzdGlsbCBhcHBsaWVkLlxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5QWdlbnRNc2coc3RhdGU6IEdsYW1vdXJTdGF0ZSwgbXNnOiBBZ2VudENvbW1hbmQpOiBib29sZWFuIHtcbiAgc3dpdGNoIChtc2cudHlwZSkge1xuICAgIGNhc2UgXCJpbml0XCI6XG4gICAgICBpZiAodHlwZW9mIG1zZy50aXRsZSA9PT0gXCJzdHJpbmdcIikgc3RhdGUudGl0bGUgPSBtc2cudGl0bGU7XG4gICAgICBpZiAodHlwZW9mIG1zZy5pbnRlbnQgPT09IFwic3RyaW5nXCIpIHN0YXRlLmludGVudCA9IG1zZy5pbnRlbnQ7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiaW50ZW50XCI6XG4gICAgICBzdGF0ZS5pbnRlbnQgPSBtc2cudGV4dDtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJpdGVtLmFubm90YXRlXCI6IHtcbiAgICAgIGNvbnN0IGl0ID0gc3RhdGUubGlicmFyeS5maW5kKChpKSA9PiBpLmlkID09PSBtc2cuaWQpO1xuICAgICAgaWYgKGl0KSBpdC5hbm5vdGF0aW9ucy5hZ2VudCA9IG1zZy5hZ2VudDtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwic2VjdGlvblwiOlxuICAgICAgdXBkYXRlU2VjdGlvbihzdGF0ZSwgbXNnLmtleSwge1xuICAgICAgICBjb250ZW50OiBtc2cuY29udGVudCxcbiAgICAgICAgc3RhdHVzOiBtc2cuc3RhdHVzLFxuICAgICAgICBwcm9tcHRzOiBtc2cucHJvbXB0cyxcbiAgICAgICAgY29sb3JzOiBtc2cuY29sb3JzLFxuICAgICAgfSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZm9jdXMucHVzaFwiOlxuICAgICAgc2V0Rm9jdXMoc3RhdGUsIG1zZy5pZHMsIFwiYWdlbnRcIiwgbXNnLm5vdGUgPz8gXCJcIik7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZ2VuLmNvc3RcIjpcbiAgICAgIHNldEdlbkNvc3Qoc3RhdGUsIG1zZy5pZCwgbXNnLmNvc3QpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImdlbi5tZXRhXCI6XG4gICAgICBzZXRHZW5NZXRhKHN0YXRlLCBtc2cuaWQsIHsgcHJvbXB0OiBtc2cucHJvbXB0LCBjdXN0b206IG1zZy5jdXN0b20gfSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwic3RhdHVzXCI6XG4gICAgICBzdGF0ZS5zdGF0dXMgPSB7IGJ1c3k6IG1zZy5idXN5LCB0ZXh0OiBtc2cudGV4dCA/PyBcIlwiIH07XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwic3R5bGUuYXJjaGl2ZVwiOlxuICAgICAgYXJjaGl2ZVRyYXlTdHlsZShzdGF0ZSwgbXNnLmlkLCBtc2cuYXJjaGl2ZWQpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInNheVwiOlxuICAgIGNhc2UgXCJjbG9zZVwiOlxuICAgICAgYnJlYWs7IC8vIGhhbmRsZWQgYnkgdGhlIHNlcnZlciAoYXBwZW5kZWQgdG8gY29udmVyc2F0aW9uIC8gc2h1dGRvd24pXG4gICAgZGVmYXVsdDpcbiAgICAgIC8vICM4NCDigJQgdGhlIHN3aXRjaCBoYWQgTk8gZGVmYXVsdCwgc28gYW4gdW5yZWNvZ25pc2VkIGNvbW1hbmQgdHlwZSBkaWRcbiAgICAgIC8vIG5vdGhpbmcgYW5kIHRoZSAvY21kIHJvdXRlIHN0aWxsIGFuc3dlcmVkIHtvazp0cnVlfTogYSBib2d1cyB0eXBlIHdhc1xuICAgICAgLy8gYnl0ZS1pZGVudGljYWwgdG8gYW4gZXhlY3V0ZWQgb25lLiBUaGUgdmVyZGljdCBoYXMgdG8gYmUgcHJvZHVjZWQgSEVSRSxcbiAgICAgIC8vIGJ5IHRoZSBjb2RlIHRoYXQgYWN0dWFsbHkga25vd3MgdGhlIHJlY29nbmlzZWQgc2V0LCBhbmQgbm90IG1pcnJvcmVkXG4gICAgICAvLyBpbnRvIGEgbGlzdCBiZXNpZGUgdGhlIHN3aXRjaCDigJQgYSBoYW5kLW1haW50YWluZWQgbWlycm9yIG9mIGEgY2FzZSBsaXN0XG4gICAgICAvLyBkcmlmdHMgc2lsZW50bHkgdGhlIG1vbWVudCBhIGNhc2UgaXMgYWRkZWQsIHdoaWNoIGlzIGEgZGVmZWN0IHRoaXMgcmVwb1xuICAgICAgLy8gaGFzIGFscmVhZHkgc2hpcHBlZCB0d2ljZS5cbiAgICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cbiIsCiAgICAiLy8gU2VydmVyL0NMSS1vbmx5OiB0aGUgcHJvamVjdC1zY29wZWQgc3R5bGUgc3RvcmUuIERvIE5PVCBpbXBvcnQgZnJvbSBicm93c2VyXG4vLyBjb2RlIChmaWxlc3lzdGVtIGFjY2VzcykuIFN0eWxlcyBsaXZlIHVuZGVyICR7aG9tZX0vc3R5bGVzLyR7cHJvamVjdEtleX0vLFxuLy8ga2V5ZWQgdG8gdGhlIGNoZWNrb3V0IHdoZXJlIHRoZSBzcGVsbCB3YXMgY2FzdC5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgcmVhZGRpclN5bmMsIHJlYWRGaWxlU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHtcbiAgQ2Fub25JbWcsXG4gIENhbm9uaWNhbFJlZixcbiAgTGlicmFyeUl0ZW0sXG4gIFNhdmVkU3R5bGUsXG4gIFN0eWxlU2VjdGlvbixcbn0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9nbGFtb3VyL3NoYXJlZC90eXBlc1wiO1xuXG5jb25zdCBFWFRfQllfTUlNRTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCJpbWFnZS93ZWJwXCI6IFwid2VicFwiLFxuICBcImltYWdlL3BuZ1wiOiBcInBuZ1wiLFxuICBcImltYWdlL2pwZWdcIjogXCJqcGdcIixcbiAgXCJpbWFnZS9naWZcIjogXCJnaWZcIixcbn07XG5cbi8vIEEgc3RhYmxlLCBmaWxlc3lzdGVtLXNhZmUga2V5OiBzYW5pdGl6ZWQgYmFzZSBuYW1lICsgYSBzaG9ydCBoYXNoIG9mIHRoZSBmdWxsXG4vLyBhYnNvbHV0ZSBwYXRoIChzbyB0d28gY2hlY2tvdXRzIHdpdGggdGhlIHNhbWUgZm9sZGVyIG5hbWUgZG9uJ3QgY29sbGlkZSkuXG5leHBvcnQgZnVuY3Rpb24gcHJvamVjdEtleShwcm9qZWN0RGlyOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gYmFzZW5hbWUocHJvamVjdERpcikucmVwbGFjZSgvW15hLXpBLVowLTlfLV0vZywgXCJfXCIpIHx8IFwicm9vdFwiO1xuICBsZXQgaCA9IDUzODE7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgcHJvamVjdERpci5sZW5ndGg7IGkrKykgaCA9ICgoaCA8PCA1KSArIGggKyBwcm9qZWN0RGlyLmNoYXJDb2RlQXQoaSkpID4+PiAwO1xuICByZXR1cm4gYCR7YmFzZX0tJHtoLnRvU3RyaW5nKDM2KX1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3R5bGVzRGlyKGhvbWU6IHN0cmluZywga2V5OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihob21lLCBcInN0eWxlc1wiLCBrZXkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2F2ZVN0eWxlKFxuICBob21lOiBzdHJpbmcsXG4gIGtleTogc3RyaW5nLFxuICBhcmdzOiB7XG4gICAgaWQ6IHN0cmluZztcbiAgICBsYWJlbDogc3RyaW5nO1xuICAgIHRleHQ6IHN0cmluZztcbiAgICBzZWN0aW9uczogU3R5bGVTZWN0aW9uW107XG4gICAgY2Fub25pY2FsSXRlbXM6IExpYnJhcnlJdGVtW107XG4gICAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIH0sXG4pOiBTYXZlZFN0eWxlIHtcbiAgY29uc3QgZGlyID0gc3R5bGVzRGlyKGhvbWUsIGtleSk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBjb25zdCBjYW5vbmljYWw6IENhbm9uaWNhbFJlZltdID0gW107XG4gIGZvciAoY29uc3QgaXQgb2YgYXJncy5jYW5vbmljYWxJdGVtcykge1xuICAgIGlmICghaXQucGF0aCB8fCAhZXhpc3RzU3luYyhpdC5wYXRoKSkgY29udGludWU7XG4gICAgY29uc3QgZXh0ID0gRVhUX0JZX01JTUVbaXQubWltZV0gPz8gXCJiaW5cIjtcbiAgICBjb25zdCBmaWxlID0gYCR7YXJncy5pZH0tJHtpdC5pZH0uJHtleHR9YDtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgZmlsZSksIHJlYWRGaWxlU3luYyhpdC5wYXRoKSk7XG4gICAgICBjYW5vbmljYWwucHVzaCh7IGlkOiBpdC5pZCwgdGl0bGU6IGl0LnRpdGxlLCBmaWxlLCBtaW1lOiBpdC5taW1lIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogc2tpcCBhbiB1bnJlYWRhYmxlIGJsb2IgKi9cbiAgICB9XG4gIH1cbiAgY29uc3Qgc3R5bGU6IFNhdmVkU3R5bGUgPSB7XG4gICAgaWQ6IGFyZ3MuaWQsXG4gICAgbGFiZWw6IGFyZ3MubGFiZWwsXG4gICAgdGV4dDogYXJncy50ZXh0LFxuICAgIHNlY3Rpb25zOiBhcmdzLnNlY3Rpb25zLFxuICAgIGNhbm9uaWNhbCxcbiAgICBjcmVhdGVkQXQ6IGFyZ3MuY3JlYXRlZEF0LFxuICAgIGFyY2hpdmVkOiBmYWxzZSxcbiAgfTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgYCR7YXJncy5pZH0uanNvbmApLCBKU09OLnN0cmluZ2lmeShzdHlsZSkpO1xuICByZXR1cm4gc3R5bGU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsb2FkVHJheShob21lOiBzdHJpbmcsIGtleTogc3RyaW5nKTogU2F2ZWRTdHlsZVtdIHtcbiAgY29uc3QgZGlyID0gc3R5bGVzRGlyKGhvbWUsIGtleSk7XG4gIGlmICghZXhpc3RzU3luYyhkaXIpKSByZXR1cm4gW107XG4gIGNvbnN0IG91dDogU2F2ZWRTdHlsZVtdID0gW107XG4gIGZvciAoY29uc3QgbmFtZSBvZiByZWFkZGlyU3luYyhkaXIpKSB7XG4gICAgaWYgKCFuYW1lLmVuZHNXaXRoKFwiLmpzb25cIikpIGNvbnRpbnVlO1xuICAgIHRyeSB7XG4gICAgICBvdXQucHVzaChKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgbmFtZSksIFwidXRmOFwiKSkgYXMgU2F2ZWRTdHlsZSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBza2lwIGEgY29ycnVwdCByZWNvcmQgKi9cbiAgICB9XG4gIH1cbiAgcmV0dXJuIG91dC5zb3J0KChhLCBiKSA9PiBhLmNyZWF0ZWRBdCAtIGIuY3JlYXRlZEF0KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldFN0eWxlQXJjaGl2ZWQoXG4gIGhvbWU6IHN0cmluZyxcbiAga2V5OiBzdHJpbmcsXG4gIGlkOiBzdHJpbmcsXG4gIGFyY2hpdmVkOiBib29sZWFuLFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IHBhdGggPSBqb2luKHN0eWxlc0Rpcihob21lLCBrZXkpLCBgJHtpZH0uanNvbmApO1xuICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHJldHVybiBmYWxzZTtcbiAgdHJ5IHtcbiAgICBjb25zdCBzdHlsZSA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSkgYXMgU2F2ZWRTdHlsZTtcbiAgICBzdHlsZS5hcmNoaXZlZCA9IGFyY2hpdmVkO1xuICAgIHdyaXRlRmlsZVN5bmMocGF0aCwgSlNPTi5zdHJpbmdpZnkoc3R5bGUpKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXRlcmlhbGl6ZUNhbm9uKGhvbWU6IHN0cmluZywga2V5OiBzdHJpbmcsIHN0eWxlOiBTYXZlZFN0eWxlKTogQ2Fub25JbWdbXSB7XG4gIGNvbnN0IGRpciA9IHN0eWxlc0Rpcihob21lLCBrZXkpO1xuICBjb25zdCBvdXQ6IENhbm9uSW1nW10gPSBbXTtcbiAgZm9yIChjb25zdCByZWYgb2Ygc3R5bGUuY2Fub25pY2FsKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGJ5dGVzID0gcmVhZEZpbGVTeW5jKGpvaW4oZGlyLCByZWYuZmlsZSkpO1xuICAgICAgb3V0LnB1c2goe1xuICAgICAgICB0aXRsZTogcmVmLnRpdGxlLFxuICAgICAgICBzcmM6IGBkYXRhOiR7cmVmLm1pbWV9O2Jhc2U2NCwke2J5dGVzLnRvU3RyaW5nKFwiYmFzZTY0XCIpfWAsXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHNraXAgYSBtaXNzaW5nIGJsb2IgKi9cbiAgICB9XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cbiIKICBdLAogICJtYXBwaW5ncyI6ICI7Ozs7QUFBQSx1QkFBUywwQkFBWSxzQkFBVyx1QkFBUTtBQUN4QztBQUNBLDBCQUFrQjtBQUNsQjtBQUNBLHNCQUFTOzs7QUNrTEYsSUFBTSxvQkFBb0IsT0FBTyxPQUFPO0FBQUEsRUFDN0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNGLENBQVU7QUFHSCxTQUFTLGlCQUFpQixHQUFtQjtBQUFBLEVBQ2xELE9BQU87QUFBQSxJQUNMO0FBQUEsTUFDRSxLQUFLO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixTQUFTO0FBQUEsTUFDVCxTQUFTLENBQUM7QUFBQSxNQUNWLFFBQVEsQ0FBQztBQUFBLElBQ1g7QUFBQSxJQUNBO0FBQUEsTUFDRSxLQUFLO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixTQUFTO0FBQUEsTUFD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
