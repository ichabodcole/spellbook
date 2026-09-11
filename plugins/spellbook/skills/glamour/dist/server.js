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

//# debugId=23DB9FBC062D65CB64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9zZXJ2ZXIudHMiLCAiLi4vc2hhcmVkL3R5cGVzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc3NlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9wZXJzaXN0LnNlcnZlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvZ2xhbW91ci9iYWNrZW5kL3JlZHVjZS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvZ2xhbW91ci9iYWNrZW5kL3N0eWxlcy5zZXJ2ZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHVubGlua1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgYXMgbm9kZVBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7XG4gIHR5cGUgQWdlbnRDb21tYW5kLFxuICB0eXBlIENsaWVudFRvU2VydmVyLFxuICBkZWZhdWx0U3RhdGUsXG4gIHR5cGUgR2xhbW91clN0YXRlLFxufSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dsYW1vdXIvc2hhcmVkL3R5cGVzXCI7XG5pbXBvcnQgeyB1bmxpbmtJZk1hdGNoZXMsIHdyaXRlRmlsZUF0b21pYyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9kaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB7IGNyZWF0ZUV2ZW50TG9nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2V2ZW50TG9nLnRzXCI7XG5pbXBvcnQgeyBkcmFpbkFuZFN0b3AsIHN0YXJ0SG91c2VrZWVwaW5nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hvdXNla2VlcGluZy50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZU1vZGUgYXMgcmVzb2x2ZU1vZGVJbiwgc2VydmVGcm9tRGlzdCB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9zZXJ2ZURpc3QudHNcIjtcbmltcG9ydCB7IHR5cGUgU3NlQ2xpZW50cywgc3NlUmVzcG9uc2UgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvc3NlLnRzXCI7XG5pbXBvcnQgeyBJRExFX1RJTUVPVVRfU0VDLCBTU0VfSEVBUlRCRUFUX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0XCI7XG5pbXBvcnQgeyBsb2FkU25hcHNob3QsIG1hdGVyaWFsaXplSXRlbSwgc2F2ZVNuYXBzaG90IH0gZnJvbSBcIi4vcGVyc2lzdC5zZXJ2ZXJcIjtcbmltcG9ydCB7XG4gIGFkZEl0ZW0sXG4gIGFkZE1lc3NhZ2UsXG4gIGFubm90YXRlLFxuICBhcHBseUFnZW50TXNnLFxuICBidWlsZFN0eWxlSXRlbSxcbiAgY2xlYXJGb2N1cyxcbiAgbGVhbkl0ZW0sXG4gIGxlYW5TdGF0ZSxcbiAgbWFrZUl0ZW0sXG4gIHNlbGVjdEl0ZW1zLFxuICBzZXRDYW5vbmljYWwsXG4gIHNldEZvY3VzLFxuICBzZXRJdGVtQXJjaGl2ZWQsXG4gIHNldExpa2UsXG4gIHNldFN0YXIsXG59IGZyb20gXCIuL3JlZHVjZVwiO1xuaW1wb3J0IHtcbiAgbG9hZFRyYXksXG4gIG1hdGVyaWFsaXplQ2Fub24sXG4gIHByb2plY3RLZXksXG4gIHNhdmVTdHlsZSxcbiAgc2V0U3R5bGVBcmNoaXZlZCxcbn0gZnJvbSBcIi4vc3R5bGVzLnNlcnZlclwiO1xuXG4vLyBUaGUgc3VyZmFjZSdzIEhUTUwgZW50cnkgdXNlZCB0byBiZSBhIHRvcC1sZXZlbCBzdGF0aWMgaW1wb3J0IGhlcmUuIEEgc3RhdGljXG4vLyBpbXBvcnQgZm9yY2VzIEJ1biB0byByZXNvbHZlIHRoZSB3aG9sZSAudHN4ICsgVGFpbHdpbmQgZ3JhcGggd2hlbiB0aGlzIG1vZHVsZVxuLy8gTE9BRFMsIHNvIGEgZGVzdGluYXRpb24gdGhhdCBzaGlwcyBkaXN0LyBhbmQgbm8gc3VyZmFjZSBzb3VyY2Ug4oCUIHRoZSBwdWJsaXNoZWRcbi8vIGFydGlmYWN0IOKAlCBkaWVzIGJlZm9yZSBpdCBjYW4gc2VydmUgdGhlIGRpc3QgaXQgZG9lcyBoYXZlLiBUaGUgZGV2IGltcG9ydCBpc1xuLy8gdGhlcmVmb3JlIGR5bmFtaWMgYW5kIHJlYWNoZWQgb25seSBvbiB0aGUgZGV2IGJyYW5jaCBiZWxvdyAoc2VhbXMgQ29udHJhY3QgMSksXG4vLyBhcyBhc3Ryb2xhYmUsIGltYWdvIGFuZCBtaW5kLW1hcHBlciBkbyBpdC5cbi8vXG4vLyBQYXRocyBhbmNob3IgYXQgdGhlIFNLSUxMIFJPT1QsIG5ldmVyIGF0IGN3ZDogY2xpLnRzIHBpbnMgdGhlIGRhZW1vbidzIGN3ZCBmb3Jcbi8vIGJ1bmZpZy50b21sJ3Mgc2FrZSBpbiBkZXYgKENvbnRyYWN0IDUpLCBzbyBjd2QgaXMgbm90IGEgc3RhYmxlIGJhc2UgZm9yIGRpc3QvLlxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuXG4vLyByZWxlYXNlIGlmZiBkaXN0L2luZGV4Lmh0bWwgZXhpc3RzIGF0IHRoZSBza2lsbCByb290IOKAlCB0aGUgRklMRSwgbmV2ZXIgdGhlXG4vLyBkaXJlY3RvcnkgKGEgYnVpbHQgYmFja2VuZCBjYW4gcHV0IGNsaS5qcyBpbiBkaXN0LyB3aXRoIG5vIHN1cmZhY2UgdGhlcmUpIOKAlFxuLy8gZWxzZSBkZXY7IHRoZSBlbnYgb3ZlcnJpZGUgd2lucyBlaXRoZXIgd2F5IChDb250cmFjdCAxKS4gUmVsZWFzZTogemVybyByZWFkc1xuLy8gb2Ygc3VyZmFjZSBzb3VyY2Ugb3IgYnVuZmlnLnRvbWwg4oCUIHN0YXRpYyBmaWxlcyBvbmx5LlxuLy9cbi8vIFRoZSBwcmVkaWNhdGUgYW5kIHRoZSBzY2FyIGl0IGNhcnJpZXMgYXJlIG5vdyBgc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50c2A7XG4vLyB3aGF0IHN0YXlzIGhlcmUgaXMgV0hJQ0ggZGlyZWN0b3J5IGdsYW1vdXIgcmVzb2x2ZXMgYWdhaW5zdC4gRXhwb3J0ZWQgYmVjYXVzZVxuLy8gdGhpcyBzcGVsbCdzIG93biBzdWl0ZXMgYXNrIGl0LlxuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKCk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIHJldHVybiByZXNvbHZlTW9kZUluKERJU1RfRElSKTtcbn1cblxuLy8gU2VydmVzIGRpc3QvIHZlcmJhdGltIOKAlCBlbnRyeSBpbmRleC5odG1sLCBoYXNoZWQgY2h1bmtzIGJ5IHBhdGggKENvbnRyYWN0IDInc1xuLy8gZmxhdCwgcmVsYXRpdmUtaHJlZiBsYXlvdXQpLiDim5QgVEhFIFVSTOKGkkZJTEVOQU1FIE1BUFBJTkcgU1RBWVMgSEVSRSBPTiBQVVJQT1NFOlxuLy8gdGhlIGtpdCBkZWNpZGVzIHdoZXRoZXIgYSBmaWxlIG1heSBiZSByZWFkIGFuZCB3aGF0IGNvbnRlbnQgdHlwZSBpdCBnZXRzLCBhbmRcbi8vIHRoZSBDQUxMRVIgZGVjaWRlcyB3aGljaCBmaWxlIOKAlCBiZWNhdXNlIHR3byBzcGVsbHMgcm91dGUgdGhpcyBkaWZmZXJlbnRseSBhbmQgYVxuLy8gc2lnbmF0dXJlIHdpZGUgZW5vdWdoIGZvciBib3RoIHN0b3BzIGJlaW5nIGEgZmlsZSBzZXJ2ZXIuIGdsYW1vdXIncyBvd25cbi8vIGBHRVQgL2Fzc2V0cy88bmFtZT5gIHNlc3Npb24tZmlsZXMgcm91dGUgc2l0cyBBQk9WRSB0aGlzIGluIHRoZSBmZXRjaCBjaGFpbixcbi8vIGFuZCBgc2VydmVGcm9tRGlzdGAgcmVmdXNpbmcgYW55dGhpbmcgd2l0aCBhIHNsYXNoIGluIGl0IGlzIHdoYXQga2VlcHMgdGhlIHR3b1xuLy8gZGlzam9pbnQgKGV2ZXJ5IC9hc3NldHMvIHBhdGggaXMgbmVzdGVkLCBzbyBpdCBpcyByZWZ1c2VkIGhlcmUgYW5kIGZhbGxzXG4vLyB0aHJvdWdoKS5cbmZ1bmN0aW9uIHNlcnZlRGlzdChwYXRoOiBzdHJpbmcpOiBSZXNwb25zZSB8IG51bGwge1xuICByZXR1cm4gc2VydmVGcm9tRGlzdChESVNUX0RJUiwgcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSkpO1xufVxuXG5jb25zdCByYW5kSGV4ID0gKG46IG51bWJlcikgPT5cbiAgQXJyYXkuZnJvbShjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKG5ldyBVaW50OEFycmF5KG4pKSlcbiAgICAubWFwKChiKSA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpXG4gICAgLmpvaW4oXCJcIik7XG5cbmV4cG9ydCB0eXBlIFN0YXJ0T3B0cyA9IHtcbiAgcG9ydD86IG51bWJlcjtcbiAgaG9zdD86IHN0cmluZztcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIGludGVudD86IHN0cmluZztcbiAgcmVzdG9yZT86IHN0cmluZztcbiAgdGltZW91dFM/OiBudW1iZXI7XG4gIHByb2plY3Q/OiBzdHJpbmc7XG59O1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnREYWVtb24ob3B0czogU3RhcnRPcHRzKSB7XG4gIGNvbnN0IEdMQU1PVVJfSE9NRSA9IHByb2Nlc3MuZW52LkdMQU1PVVJfSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuZ2xhbW91clwiKTtcbiAgY29uc3QgU05BUFNIT1RTX0RJUiA9IGpvaW4oR0xBTU9VUl9IT01FLCBcInNuYXBzaG90c1wiKTtcbiAgbGV0IHN0YXRlOiBHbGFtb3VyU3RhdGUgPSBkZWZhdWx0U3RhdGUob3B0cy50aXRsZSA/PyBcIlwiLCBvcHRzLmludGVudCA/PyBcIlwiKTtcbiAgbGV0IHJlc3RvcmVkID0gZmFsc2U7XG4gIGlmIChvcHRzLnJlc3RvcmUpIHtcbiAgICBjb25zdCBwYXRoID0gZXhpc3RzU3luYyhvcHRzLnJlc3RvcmUpXG4gICAgICA/IG9wdHMucmVzdG9yZVxuICAgICAgOiBqb2luKFNOQVBTSE9UU19ESVIsIGAke29wdHMucmVzdG9yZX0uanNvbmApO1xuICAgIHRyeSB7XG4gICAgICBzdGF0ZSA9IGxvYWRTbmFwc2hvdChwYXRoLCBvcHRzLnRpdGxlID8/IFwiXCIsIG9wdHMuaW50ZW50ID8/IFwiXCIpO1xuICAgICAgcmVzdG9yZWQgPSB0cnVlO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBnbGFtb3VyOiByZXN0b3JlIGZhaWxlZCAoJHtwYXRofSk6ICR7ZX1cXG5gKTtcbiAgICB9XG4gIH1cbiAgY29uc3QgUFJPSkVDVF9LRVkgPSBwcm9qZWN0S2V5KG9wdHMucHJvamVjdCA/PyBwcm9jZXNzLmN3ZCgpKTtcbiAgLy8gLS0tIG1vZGUsIHJlc29sdmVkIEJFRk9SRSBhbnkgZmlsZXN5c3RlbSB3cml0ZSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBBIGZvcmNlZC1kZXYgYm9vdCBhdCBhIHN1cmZhY2UtZnJlZSBkZXN0aW5hdGlvbiBtdXN0IGRpZSBIRVJFLCBhdCB0aGUgaW1wb3J0LFxuICAvLyBoYXZpbmcgd3JpdHRlbiBub3RoaW5nOiBubyBzZXNzaW9uLWZpbGVzIGRpciwgbm8gZGlzY292ZXJ5IHBvaW50ZXIuIE1lYXN1cmVkXG4gIC8vIGluIHRoZSBsb2NhbC1zaW06IHdpdGggdGhpcyBibG9jayBwbGFjZWQgYWZ0ZXIgdGhlIHNlc3Npb24tZmlsZXMgbWtkaXIsIGFcbiAgLy8gZHlpbmcgZGFlbW9uIGxlZnQgYCRUTVBESVIvZ2xhbW91ci08aWQ+LWZpbGVzL2AgYmVoaW5kIG9uIGV2ZXJ5IGZhaWxlZCBib290LlxuICBjb25zdCBtb2RlID0gcmVzb2x2ZU1vZGUoKTtcbiAgLy8gZGV2OiB0aGUgZHluYW1pYyBzdHJpbmctbGl0ZXJhbCBpbXBvcnQga2VlcHMgdGhlIHN1cmZhY2UgZ3JhcGggb2ZmIHRoZSBtb2R1bGVcbiAgLy8gbG9hZCBwYXRoIChDb250cmFjdCAxKSDigJQgQnVuIGJ1bmRsZXMgdGhlIC50c3ggZ3JhcGggKyBUYWlsd2luZCBhdCBzZXJ2ZSB0aW1lLFxuICAvLyByZWFkaW5nIGJ1bmZpZy50b21sIGZyb20gY3dkLCB3aGljaCBjbGkudHMgcGlucyB0byBzcmMvZ2xhbW91ci8gKENvbnRyYWN0IDUpLlxuICAvLyByZWxlYXNlOiBkaXN0LyBpcyBzdGF0aWMgYW5kIHByZS1idWlsdCAoQ29udHJhY3QgMikg4oCUIFwiL1wiIGlzIGFuc3dlcmVkIGJ5XG4gIC8vIHNlcnZlRGlzdCgpIGluIHRoZSBmZXRjaCBmYWxsLXRocm91Z2gsIHNvIHRoaXMgYnJhbmNoIG5ldmVyIHRvdWNoZXMgc3VyZmFjZVxuICAvLyBzb3VyY2Ugb3IgYnVuZmlnLnRvbWwgYW5kIG5ldmVyIG5lZWRzIGVpdGhlciB0byBleGlzdC4gQnVuJ3MgUm91dGVzIHR5cGUgdGllc1xuICAvLyB0aGUgXCIvXCIgdmFsdWUncyB0eXBlIHRvIHRoZSBsaXRlcmFsIG9iamVjdCBzaGFwZSwgc28gdGhlIG1vZGUtdGVybmFyeSB1bmlvblxuICAvLyBpcyBjYXN0OyB0aGUgcnVudGltZSBiZWhhdmlvdXIgKEhUTUxCdW5kbGUgaW4gZGV2LCBhYnNlbnQgaW4gcmVsZWFzZSkgaXNcbiAgLy8gY29ycmVjdCBlaXRoZXIgd2F5LiBUaGlzIGlzIHRoZSBPTkUgc3JjLy1uYW1pbmcgc3BlY2lmaWVyIGluIHRoZSBkZXBsb3llZFxuICAvLyBzcGVsbCAocGxhbiBTMiwgcmF0aWZpZWQgYXQgdGhlIHNwZWNpZmllciBncmFpbikuXG4gIGNvbnN0IGRldkluZGV4ID1cbiAgICBtb2RlID09PSBcImRldlwiXG4gICAgICA/IChhd2FpdCBpbXBvcnQoXCIuLi8uLi8uLi8uLi8uLi9zcmMvZ2xhbW91ci9zdXJmYWNlL2luZGV4Lmh0bWxcIikpLmRlZmF1bHRcbiAgICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCByb3V0ZXMgPSAoZGV2SW5kZXggPyB7IFwiL1wiOiBkZXZJbmRleCB9IDoge30pIGFzIFJlY29yZDxzdHJpbmcsIG5ldmVyPjtcbiAgLy8gTG9hZCB0aGUgcHJvamVjdCdzIHNhdmVkIHN0eWxlcyBpbnRvIHRoZSB0cmF5IChtZXRhZGF0YSBvbmx5IOKAlCBOT1QgdGhlXG4gIC8vIGxpYnJhcnkpLiBEbyB0aGlzIGFmdGVyIHJlc3RvcmUgc28gYSByZXN0b3JlZCBzbmFwc2hvdCdzIHN0YWxlIHRyYXkgaXNcbiAgLy8gcmVwbGFjZWQgYnkgdGhlIGF1dGhvcml0YXRpdmUgb24tZGlzayBzZXQuXG4gIHN0YXRlLnRyYXkgPSBsb2FkVHJheShHTEFNT1VSX0hPTUUsIFBST0pFQ1RfS0VZKTtcblxuICAvLyAtLS0gY2hhbm5lbHMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHNvY2tldHMgPSBuZXcgU2V0PGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4+KCk7XG4gIC8vIFRoZSByZXBsYXkgbG9nIGJlaGluZCBgR0VUIC9ldmVudHM/c2luY2U9PGlkPmAg4oCUIHNoYXJlZFxuICAvLyAoYGtpdC93aXJlL2V2ZW50TG9nLnRzYCksIHNvIGdsYW1vdXIgaW5oZXJpdHMgdGhlIGJvdW5kZWQgYnVmZmVyLCB0aGVcbiAgLy8gbW9ub3RvbmljIGlkIHRoYXQgYWN0dWFsbHkgV0lOUyBvdmVyIGEgcGF5bG9hZCBgaWRgLCBhbmQgdGhlIHN0YWxlLXdhdGVybWFya1xuICAvLyByZXBsYXkgdGhhdCBsZXRzIGEgdGFpbCByZXN1bWluZyBhZ2FpbnN0IGEgcmVzdGFydGVkIGRhZW1vbiByZWNlaXZlIGFueXRoaW5nXG4gIC8vIGF0IGFsbC4gZ2xhbW91ciBzdGFtcHMgTk8gRVBPQ0g6IGEgc2Vzc2lvbiBpcyBpZGVudGlmaWVkIGJ5IGBzZXNzaW9uX2lkYCwgYVxuICAvLyByZXN0YXJ0IGlzIGEgZGlmZmVyZW50IHNlc3Npb24sIGFuZCBhIHJlc3VtaW5nIHRhaWwgaXMgYWxyZWFkeSB0YWxraW5nIHRvIGFcbiAgLy8gZGlmZmVyZW50IGRhZW1vbiBieSBuYW1lIChEMTkncyByZWFzb25pbmcgZm9yIG1hZ3BpZSwgYW5kIGl0IGlzIGdsYW1vdXIncyB0b28pLlxuICBjb25zdCBsb2cgPSBjcmVhdGVFdmVudExvZzxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oKTtcbiAgY29uc3Qgc3NlQ2xpZW50czogU3NlQ2xpZW50cyA9IG5ldyBTZXQoKTtcbiAgbGV0IGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICBjb25zdCB0b3VjaCA9ICgpID0+IHtcbiAgICBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgfTtcblxuICBjb25zdCBicm9hZGNhc3QgPSAobXNnOiBvYmplY3QpID0+IHtcbiAgICBjb25zdCBzID0gSlNPTi5zdHJpbmdpZnkobXNnKTtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLnNlbmQocyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogc29ja2V0IGNsb3NlZCAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcbiAgbGV0IHNuYXBEaXJ0eSA9IGZhbHNlO1xuICBjb25zdCBicm9hZGNhc3RTdGF0ZSA9ICgpID0+IHtcbiAgICBzbmFwRGlydHkgPSB0cnVlO1xuICAgIGJyb2FkY2FzdCh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGUgfSk7XG4gIH07XG4gIGNvbnN0IGVtaXRFdmVudCA9IChtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBsb2cuZW1pdChtc2cpO1xuXG4gIC8vIFByZXNlbmNlIGlzIHRyYW5zaWVudDogc3RyZWFtIHRvIGxpdmUgU1NFIGNsaWVudHMgYnV0IERPIE5PVCBzdG9yZSBpdCBpblxuICAvLyB0aGUgcmVwbGF5IGxvZyAoYSByZWNvbm5lY3RpbmcgYWdlbnQgc2hvdWxkIG5vdCByZS1zZWUgZXZlcnkgcGFzdFxuICAvLyBjb25uZWN0L2Rpc2Nvbm5lY3QpLiBObyBpZCBpcyBhc3NpZ25lZCwgc28gaXQgbmV2ZXIgYWR2YW5jZXMgYSB0YWlsIGN1cnNvci5cbiAgLy9cbiAgLy8g4puUIFRISVMgSVMgVEhFIE9ORSBUSElORyBUSEUgU0hBUkVEIFNTRSBNT0RVTEUgQ09VTEQgTk9UIERPLCBBTkQgSVQgV0FTXG4gIC8vIFdJREVORUQgUkFUSEVSIFRIQU4gV09SS0VEIEFST1VORC4gYFNzZUNsaWVudHNgIGhlbGQgYmFyZSBjbG9zZXJzLCBiZWNhdXNlXG4gIC8vIGFzdHJvbGFiZSBhbmQgbWFncGllIGFubm91bmNlIHByZXNlbmNlIG92ZXIgdGhlaXIgYnJvd3NlciBXRUJTT0NLRVQgYW5kIG5ldmVyXG4gIC8vIG5lZWRlZCB0byBwdXNoIGFuIHVubG9nZ2VkIGZyYW1lIGF0IHRoZSBhZ2VudCdzIHRhaWwuIEtlZXBpbmcgYSBzZWNvbmQsXG4gIC8vIHBhcmFsbGVsIGBTZXQ8UmVhZGFibGVTdHJlYW1EZWZhdWx0Q29udHJvbGxlcj5gIGhlcmUgd291bGQgaGF2ZSByZS1jcmVhdGVkXG4gIC8vIGV4YWN0bHkgdGhlIGRyaWZ0IHRoZSByZWdpc3RyeSBleGlzdHMgdG8gcmVtb3ZlIOKAlCBhbmQgaXQgaXMgdGhlIGRyaWZ0IHRoYXRcbiAgLy8gbW9kdWxlJ3Mgb3duIGhlYWRlciB3YXJucyBhYm91dCwgd2hlcmUgYSBwZXItc3RyZWFtIHRpbWVyIHdhcyBzd2VwdCBmcm9tIGFcbiAgLy8gc2Vjb25kIHNldCBhbmQgY291bGQgZmFsbCBvdXQgb2Ygc3RlcC4gU28gdGhlIHJlZ2lzdHJ5IGVudHJ5IGdhaW5lZCBgc2VuZGAsXG4gIC8vIHdoaWNoIHJvdXRlcyB0aHJvdWdoIHRoZSBzYW1lIGNsb3NlZC1jaGVjayBhbmQgdGVhcmRvd24gZnVubmVsIGFzIGV2ZXJ5IG90aGVyXG4gIC8vIHdyaXRlLiBSZXBvcnRlZCBhcyBhIGZpbmRpbmcgYWJvdXQgdGhlIG1vZHVsZSwgcGVyIHRoZSBwaGFzZSBicmllZi5cbiAgY29uc3QgZW1pdFRyYW5zaWVudCA9IChtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgY29uc3QgZnJhbWUgPSBgZGF0YTogJHtKU09OLnN0cmluZ2lmeShtc2cpfVxcblxcbmA7XG4gICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIGMuc2VuZChmcmFtZSk7XG4gIH07XG5cbiAgLy8gLS0tIHNlc3Npb24gZmlsZXMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzZXNzaW9uSWQgPSBgZ2xhbW91ci0ke3JhbmRIZXgoNCl9YDtcbiAgY29uc3Qgc2Vzc2lvbkZpbGVzRGlyID0gam9pbih0bXBkaXIoKSwgYCR7c2Vzc2lvbklkfS1maWxlc2ApO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhzZXNzaW9uRmlsZXNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIGJhY2sgdG8gbm8gcGF0aHMgKi9cbiAgfVxuICBpZiAocmVzdG9yZWQpIHtcbiAgICBmb3IgKGNvbnN0IGl0IG9mIHN0YXRlLmxpYnJhcnkpIG1hdGVyaWFsaXplSXRlbShzZXNzaW9uRmlsZXNEaXIsIGl0KTtcbiAgfVxuXG4gIC8vIC0tLSBhZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBsZXQgcmVzb2x2ZURvbmUhOiAodjogeyBjb2RlOiBudW1iZXI7IHJlYXNvbjogc3RyaW5nIH0pID0+IHZvaWQ7XG4gIGNvbnN0IGRvbmUgPSBuZXcgUHJvbWlzZTx7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmcgfT4oKHIpID0+IHtcbiAgICByZXNvbHZlRG9uZSA9IHI7XG4gIH0pO1xuXG4gIC8vICM4NCDigJQgUkVUVVJOUyBBIFZFUkRJQ1QuIFByZXZpb3VzbHkgdm9pZCwgc28gdGhlIC9jbWQgcm91dGUgaGFkIG5vdGhpbmcgdG9cbiAgLy8gcmVwb3J0IGFuZCBhbnN3ZXJlZCBhIGxpdGVyYWwge29rOnRydWV9IHRvIGV2ZXJ5IGNvbW1hbmQgaW5jbHVkaW5nIG9uZXMgaXRcbiAgLy8gZHJvcHBlZC4gTm90ZSB0aGUgZGVmZWN0IGlzIE5PVCBhIG1pc3NpbmcgYGF3YWl0YDogdGhpcyBoYW5kbGVyIGlzXG4gIC8vIHN5bmNocm9ub3VzLCBhbmQgaW1hZ28ncyB0d2luIElTIGNvcnJlY3RseSBhd2FpdGVkIGFuZCB3YXMgYnJva2VuIGFueXdheS5cbiAgLy8gVGhlIGZpeCBpcyB0aGF0IGEgZGVjaXNpb24gZXhpc3RzIGF0IGFsbC5cbiAgLy8gQ29udHJhY3QgMTM6IHRoZSB2ZXJkaWN0IG9yaWdpbmF0ZXMgaW4gdGhlIGNvZGUgb3duaW5nIHRoZSByZWNvZ25pc2VkIHNldC5cbiAgLy8gYjEyIHdpZGVucyB0aGUgUkVUVVJOIHdpdGhvdXQgd2lkZW5pbmcgdGhlIENPTlRSQUNUIOKAlCBhIGNvbW1hbmQgbWF5IGFuc3dlclxuICAvLyB3aXRoIGEgcmVzdWx0IG9iamVjdCBjYXJyeWluZyBpdHMgb3duIHBheWxvYWQgaW5zdGVhZCBvZiB0aGUgYm9vbGVhbi4gRXZlcnlcbiAgLy8gb3RoZXIgY29tbWFuZCBzdGlsbCByZXR1cm5zIGEgYmFyZSBib29sZWFuIGFuZCBpdHMgcmVzcG9uc2UgaXNcbiAgLy8gYnl0ZS1pZGVudGljYWwuIFNhbWUgc2hhcGUgYXMgaW1hZ28ncyBjb250ZXh0LmFkZCAoNWU2YWFjZCkuXG4gIHR5cGUgQWdlbnRWZXJkaWN0ID0gYm9vbGVhbiB8IHsgcmVjb2duaXNlZDogdHJ1ZTsgb2s6IHRydWU7IGRldGFpbDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfTtcbiAgY29uc3QgaGFuZGxlQWdlbnRNc2cgPSAobXNnOiBBZ2VudENvbW1hbmQpOiBBZ2VudFZlcmRpY3QgPT4ge1xuICAgIGlmIChtc2cudHlwZSA9PT0gXCJzYXlcIikge1xuICAgICAgYWRkTWVzc2FnZShzdGF0ZSwge1xuICAgICAgICBpZDogYG0tJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgIHdobzogXCJhZ2VudFwiLFxuICAgICAgICBraW5kOiBtc2cua2luZCA/PyBcImluZm9cIixcbiAgICAgICAgdGV4dDogbXNnLnRleHQsXG4gICAgICAgIGdyb3VuZDogW10sXG4gICAgICAgIHRzOiBEYXRlLm5vdygpLFxuICAgICAgfSk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChtc2cudHlwZSA9PT0gXCJjbG9zZVwiKSB7XG4gICAgICByZXNvbHZlRG9uZSh7IGNvZGU6IDAsIHJlYXNvbjogXCJjbG9zZVwiIH0pO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChtc2cudHlwZSA9PT0gXCJnZW4uYWRkXCIpIHtcbiAgICAgIGNvbnN0IGl0ID0gbWFrZUl0ZW0oe1xuICAgICAgICBpZDogYGdlbi0ke3JhbmRIZXgoNCl9YCxcbiAgICAgICAga2luZDogXCJnZW5cIixcbiAgICAgICAgdGl0bGU6IG1zZy5sYWJlbCA/PyBgcm91bmQgJHttc2cucm91bmR9YCxcbiAgICAgICAgc3JjOiBtc2cuc3JjLFxuICAgICAgICBtaW1lOiBcImltYWdlL3dlYnBcIixcbiAgICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgICBnZW46IHtcbiAgICAgICAgICBtb2RlbDogbXNnLm1vZGVsLFxuICAgICAgICAgIHByb21wdDogbXNnLnByb21wdCxcbiAgICAgICAgICBzZWVkOiBtc2cuc2VlZCA/PyBudWxsLFxuICAgICAgICAgIGNvc3Q6IG1zZy5jb3N0ID8/IG51bGwsXG4gICAgICAgICAgY3VzdG9tOiBtc2cuY3VzdG9tID8/IHt9LFxuICAgICAgICAgIHJvdW5kOiBtc2cucm91bmQsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIG1hdGVyaWFsaXplSXRlbShzZXNzaW9uRmlsZXNEaXIsIGl0KTtcbiAgICAgIC8vIGIxMiArICM4NyAodGhpcmQgc3BlbGwpIOKAlCBgaWYgKGFkZEl0ZW0oc3RhdGUsIGl0KSkgYnJvYWRjYXN0U3RhdGUoKWBcbiAgICAgIC8vIGRyb3BwZWQgdGhlIG11dGF0b3IncyBvdXRjb21lIGludG8gY29udHJvbCBmbG93IGFuZCBhbnN3ZXJlZCBvazp0cnVlXG4gICAgICAvLyBlaXRoZXIgd2F5LiBUd28gdGhpbmdzIHdlcmUgd3JvbmcgYW5kIG9ubHkgb25lIGlzIHdoYXQgdGhlIGNhcmQgc2FpZDpcbiAgICAgIC8vXG4gICAgICAvLyAgIFJFQUNIQUJMRSwgZXZlcnkgY2FsbDogdGhlIG1pbnRlZCBpZCB3YXMgRElTQ0FSREVELCBzbyB0aGUgYWdlbnQgdGhhdFxuICAgICAgLy8gICBqdXN0IGNyZWF0ZWQgYW4gaXRlbSBjb3VsZCBub3QgcmVmZXJlbmNlIGl0LiBUaGF0IGlzICM4NydzIGRlZmVjdCBpbiBhXG4gICAgICAvLyAgIHRoaXJkIGNvZGViYXNlIChpbWFnbyBjb250ZXh0LmFkZCwgYW5kIHRoaXMpLlxuICAgICAgLy9cbiAgICAgIC8vICAgTk9UIFJFQUNIQUJMRSBpbiBwcmFjdGljZTogdGhlIFwic2lsZW50IGRlZHVwZVwiLiBgaWRgIGlzIG1pbnRlZCBIRVJFXG4gICAgICAvLyAgIChgZ2VuLSR7cmFuZEhleCg0KX1gKSBhbmQgdGhlIGNhbGxlciBjYW5ub3Qgc3VwcGx5IG9uZSDigJQgYGJ1aWxkR2VuQ21kYFxuICAgICAgLy8gICBoYXMgbm8gaWQgZmllbGQsIGFuZCB0aGlzIGxpbmUgaWdub3JlcyBhbnkgdGhhdCBhcnJpdmVkIOKAlCBzbyBhZGRJdGVtXG4gICAgICAvLyAgIHJldHVybnMgZmFsc2Ugb25seSBvbiBhIDJeMzIgY29sbGlzaW9uLiBUaGUgYnJhbmNoIHdhcyBkZWFkLCBub3RcbiAgICAgIC8vICAgZGFuZ2Vyb3VzLiBJdCBpcyByZXBvcnRlZCBob25lc3RseSBub3cgcmF0aGVyIHRoYW4gcmVtb3ZlZCwgYmVjYXVzZSBhXG4gICAgICAvLyAgIGNvbGxpc2lvbiB0aGF0IERJRCBoYXBwZW4gd291bGQgb3RoZXJ3aXNlIGJlIHRoZSBzaWxlbnQgY2FzZS5cbiAgICAgIGNvbnN0IGFkZGVkID0gYWRkSXRlbShzdGF0ZSwgaXQpO1xuICAgICAgaWYgKGFkZGVkKSBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcmVjb2duaXNlZDogdHJ1ZSxcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIGRldGFpbDogeyBpZDogaXQuaWQsIG91dGNvbWU6IGFkZGVkID8gXCJjcmVhdGVkXCIgOiBcImFscmVhZHktcmVjb3JkZWRcIiB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKG1zZy50eXBlID09PSBcInN0eWxlLnNhdmVcIikge1xuICAgICAgY29uc3QgY2Fub25pY2FsSXRlbXMgPSBzdGF0ZS5saWJyYXJ5LmZpbHRlcigoaSkgPT4gaS5jYW5vbmljYWwgJiYgIWkuYXJjaGl2ZWQpO1xuICAgICAgY29uc3QgYWdyZWVkID0gc3RhdGUuc3R5bGVHdWlkZS5maWx0ZXIoKHMpID0+IHMuc3RhdHVzICE9PSBcImVtcHR5XCIgJiYgcy5jb250ZW50KTtcbiAgICAgIGNvbnN0IHRleHQgPSBhZ3JlZWRcbiAgICAgICAgLm1hcCgocykgPT4gcy5jb250ZW50KVxuICAgICAgICAuam9pbihcIiDCtyBcIilcbiAgICAgICAgLnNsaWNlKDAsIDI4MCk7XG4gICAgICBjb25zdCBzdHlsZSA9IHNhdmVTdHlsZShHTEFNT1VSX0hPTUUsIFBST0pFQ1RfS0VZLCB7XG4gICAgICAgIGlkOiBgc3R5bGUtJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgIGxhYmVsOiBtc2cubGFiZWwsXG4gICAgICAgIHRleHQsXG4gICAgICAgIHNlY3Rpb25zOiBzdGF0ZS5zdHlsZUd1aWRlLFxuICAgICAgICBjYW5vbmljYWxJdGVtcyxcbiAgICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgfSk7XG4gICAgICBzdGF0ZS50cmF5LnB1c2goc3R5bGUpO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAobXNnLnR5cGUgPT09IFwic3R5bGUuYXJjaGl2ZVwiKSB7XG4gICAgICBzZXRTdHlsZUFyY2hpdmVkKEdMQU1PVVJfSE9NRSwgUFJPSkVDVF9LRVksIG1zZy5pZCwgbXNnLmFyY2hpdmVkKTtcbiAgICAgIGFwcGx5QWdlbnRNc2coc3RhdGUsIG1zZyk7IC8vIGZsaXBzIHRoZSBpbi1tZW1vcnkgdHJheSBlbnRyeVxuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICAvLyBUaGUgZmFsbHRocm91Z2ggaXMgdGhlIG9ubHkgcGF0aCB0aGF0IGNhbiBiZSBVTlJFQ09HTklTRUQsIGFuZCB0aGVcbiAgICAvLyByZWR1Y2VyIGlzIHdoYXQga25vd3M6IGl0IG93bnMgdGhlIGNhc2UgbGlzdCwgc28gdGhlIHZlcmRpY3QgY29tZXMgZnJvbVxuICAgIC8vIHRoZXJlIHJhdGhlciB0aGFuIGZyb20gYSBzZWNvbmQgZW51bWVyYXRpb24gaGVyZS5cbiAgICBjb25zdCByZWNvZ25pc2VkID0gYXBwbHlBZ2VudE1zZyhzdGF0ZSwgbXNnKTtcbiAgICBpZiAocmVjb2duaXNlZCkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4gcmVjb2duaXNlZDtcbiAgfTtcblxuICAvLyAtLS0gYnJvd3NlciBtZXNzYWdlcyAoV2ViU29ja2V0KSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgaGFuZGxlQ2xpZW50TXNnID0gKG1zZzogQ2xpZW50VG9TZXJ2ZXIpID0+IHtcbiAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XG4gICAgICBjYXNlIFwiaXRlbS5hZGRcIjoge1xuICAgICAgICBjb25zdCBpdCA9IG1ha2VJdGVtKHtcbiAgICAgICAgICBpZDogYCR7bXNnLml0ZW0ua2luZH0tJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgICAga2luZDogbXNnLml0ZW0ua2luZCxcbiAgICAgICAgICB0aXRsZTogbXNnLml0ZW0udGl0bGUsXG4gICAgICAgICAgc3JjOiBtc2cuaXRlbS5zcmMsXG4gICAgICAgICAgdGV4dDogbXNnLml0ZW0udGV4dCxcbiAgICAgICAgICBtaW1lOiBtc2cuaXRlbS5taW1lID8/IFwiXCIsXG4gICAgICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgICB9KTtcbiAgICAgICAgbWF0ZXJpYWxpemVJdGVtKHNlc3Npb25GaWxlc0RpciwgaXQpO1xuICAgICAgICBpZiAoYWRkSXRlbShzdGF0ZSwgaXQpKSB7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgICBlbWl0RXZlbnQoe1xuICAgICAgICAgICAgdHlwZTogXCJpdGVtLmFkZFwiLFxuICAgICAgICAgICAgaXRlbTogbGVhbkl0ZW0oaXQpLFxuICAgICAgICAgICAgc2VsZWN0ZWRJZHM6IHN0YXRlLnNlbGVjdGVkSWRzLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcIml0ZW0uc2VsZWN0XCI6XG4gICAgICAgIHNlbGVjdEl0ZW1zKHN0YXRlLCBtc2cuaWRzKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5zdGFyXCI6XG4gICAgICAgIGlmIChzZXRTdGFyKHN0YXRlLCBtc2cuaWQsIG1zZy5zdGFycmVkKSkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5saWtlXCI6XG4gICAgICAgIGlmIChzZXRMaWtlKHN0YXRlLCBtc2cuaWQsIG1zZy5saWtlZCkpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIml0ZW0uYW5ub3RhdGVcIjpcbiAgICAgICAgLy8gQW1iaWVudDogdGhlIGh1bWFuJ3MgcGVyLWl0ZW0gbm90ZSBpcyBzdG9yZWQgKyBVSS1zeW5jZWQgKyBwZXJzaXN0ZWQsXG4gICAgICAgIC8vIGFuZCB0aGUgYWdlbnQgcmVhZHMgaXQgb24gZGVtYW5kIGZyb20gc3RhdGUgd2hlbiBpdCBsb29rcyBhdCB0aGUgaW1hZ2UuXG4gICAgICAgIC8vIEl0IGlzIE5PVCBwdXNoZWQgYXMgYW4gYWdlbnQgZXZlbnQg4oCUIGEgc3RpY2t5IG5vdGUsIG5vdCBhIHJlYWwtdGltZVxuICAgICAgICAvLyBzaWduYWwgKHNlZSB0aGUgZXZlbnQtdm9sdW1lIGxlc3NvbjsgYXZvaWRzIGludGVycnVwdGluZyB0aGUgYWdlbnQgb25cbiAgICAgICAgLy8gZXZlcnkgYmx1cikuXG4gICAgICAgIGlmIChhbm5vdGF0ZShzdGF0ZSwgbXNnLmlkLCBcImh1bWFuXCIsIG1zZy5odW1hbikpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIm1lc3NhZ2Uuc2VuZFwiOiB7XG4gICAgICAgIGNvbnN0IGdyb3VuZCA9IFsuLi5zdGF0ZS5zZWxlY3RlZElkc107XG4gICAgICAgIGFkZE1lc3NhZ2Uoc3RhdGUsIHtcbiAgICAgICAgICBpZDogYG0tJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgICAgd2hvOiBcInVzZXJcIixcbiAgICAgICAgICBraW5kOiBcImluZm9cIixcbiAgICAgICAgICB0ZXh0OiBtc2cudGV4dCxcbiAgICAgICAgICBncm91bmQsXG4gICAgICAgICAgdHM6IERhdGUubm93KCksXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcIm1lc3NhZ2UudXNlclwiLCB0ZXh0OiBtc2cudGV4dCwgZ3JvdW5kIH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmb2N1cy5zZXRcIjpcbiAgICAgICAgc2V0Rm9jdXMoc3RhdGUsIG1zZy5pZHMsIFwieW91XCIpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJmb2N1cy5jbGVhclwiOlxuICAgICAgICBjbGVhckZvY3VzKHN0YXRlKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5jYW5vbmljYWxcIjpcbiAgICAgICAgaWYgKHNldENhbm9uaWNhbChzdGF0ZSwgbXNnLmlkLCBtc2cuY2Fub25pY2FsKSkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5hcmNoaXZlXCI6XG4gICAgICAgIGlmIChzZXRJdGVtQXJjaGl2ZWQoc3RhdGUsIG1zZy5pZCwgbXNnLmFyY2hpdmVkKSkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwic3R5bGUuYnJpbmdJblwiOiB7XG4gICAgICAgIGNvbnN0IHN0eWxlID0gc3RhdGUudHJheS5maW5kKChzKSA9PiBzLmlkID09PSBtc2cuaWQpO1xuICAgICAgICBpZiAoIXN0eWxlKSBicmVhaztcbiAgICAgICAgY29uc3QgaXRlbUlkID0gYHN0eWxlLSR7c3R5bGUuaWR9YDtcbiAgICAgICAgaWYgKHN0YXRlLmxpYnJhcnkuc29tZSgoaSkgPT4gaS5pZCA9PT0gaXRlbUlkKSkgYnJlYWs7IC8vIGlkZW1wb3RlbnRcbiAgICAgICAgY29uc3QgY2Fub24gPSBtYXRlcmlhbGl6ZUNhbm9uKEdMQU1PVVJfSE9NRSwgUFJPSkVDVF9LRVksIHN0eWxlKTtcbiAgICAgICAgY29uc3QgaXQgPSBidWlsZFN0eWxlSXRlbShzdHlsZSwgY2Fub24sIERhdGUubm93KCkpO1xuICAgICAgICBpZiAoYWRkSXRlbShzdGF0ZSwgaXQpKSB7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcIml0ZW0uYWRkXCIsIGl0ZW06IGxlYW5JdGVtKGl0KSwgc2VsZWN0ZWRJZHM6IHN0YXRlLnNlbGVjdGVkSWRzIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICAvLyBHRVQgL2V2ZW50cz9zaW5jZT08aWQ+IOKAlCByZXBsYXksIHRoZW4gc3RheSBvcGVuIGZvciBsaXZlIGZyYW1lcyBwbHVzIGFcbiAgLy8gaGVhcnRiZWF0IGNvbW1lbnQuIE9uZSBjYWxsIGludG8gYGtpdC93aXJlL3NzZS50c2AsIHdoaWNoIGlzIHdoZXJlIHRoZVxuICAvLyB0ZWFyZG93biBmdW5uZWwgbGl2ZXM6IGBjYW5jZWwoKWAsIGByZXEuc2lnbmFsYCBhbmQgYSBmYWlsZWQgZW5xdWV1ZSBhbGxcbiAgLy8gcmVhY2ggaXQsIGF0IG1vc3Qgb25jZSwgYW5kIHRoYXQgZnVubmVsIGlzIHdoYXQgYm91bmRzIHRoZSBzdWJzY3JpYmVyIGNvdW50XG4gIC8vIHRoZSBpZGxlIHN3ZWVwIHJlYWRzLiBUaGUgb2xkIGNvcHkgaGVyZSByZWxpZWQgb24gYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgdG9cbiAgLy8gbm90aWNlIGEgZGVwYXJ0ZWQgY2xpZW50LCB3aGljaCB3YXMgTUVBU1VSRUQgb24gQnVuIDEuMy4xNCBub3QgdG8gd29yayDigJRcbiAgLy8gZW5xdWV1ZSBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gYnVmZmVycyBzaWxlbnRseSBhbmQgbmV2ZXIgdGhyb3dzIOKAlCBhbmQgaXQgd2FzXG4gIC8vIG5vdCB3aXJlZCB0byBgcmVxLnNpZ25hbGAgYXQgYWxsLCBzbyBhIGNsaWVudCB0aGF0IHZhbmlzaGVkIHdpdGhvdXRcbiAgLy8gY2FuY2VsbGluZyB3YXMgY291bnRlZCBhcyBwcmVzZW50IGZvciB0aGUgbGlmZSBvZiB0aGUgZGFlbW9uLlxuICAvL1xuICAvLyDimqAgQU5EIFRIRSBIRUFSVEJFQVQgSVMgTk8gTE9OR0VSIEEgTElURVJBTC4gSXQgd2FzIGAxNTAwMGAsIGhhcmQtY29kZWQgaGVyZSxcbiAgLy8gYmVzaWRlIGEgYEJ1bi5zZXJ2ZWAgYGlkbGVUaW1lb3V0OiAyNTVgIGFuZCBhIGNvbW1lbnQgZXhwbGFpbmluZyB0aGF0IHRoZSB0d29cbiAgLy8gYXJlIGNoYWluZWQuIFRoZXkgbm93IGNvbWUgZnJvbSBgLi9oZWFydGJlYXQudHNgLCB3aGljaCBkZXJpdmVzIHRoZSBwYWlyIOKAlCBzb1xuICAvLyB0aGUgaW52YXJpYW50IGhvbGRzIGZvciBhbnkgdmFsdWUsIG5vdCBvbmx5IGZvciB0aGUgdHdvIHRoYXQgaGFwcGVuZWQgdG8gYmVcbiAgLy8gd3JpdHRlbi5cbiAgY29uc3QgZXZlbnRzUmVzcG9uc2UgPSAocmVxOiBSZXF1ZXN0LCB1cmw6IFVSTCk6IFJlc3BvbnNlID0+IHtcbiAgICB0b3VjaCgpO1xuICAgIHJldHVybiBzc2VSZXNwb25zZSh7XG4gICAgICBsb2csXG4gICAgICBzaW5jZTogTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic2luY2VcIikgPz8gXCItMVwiLCAxMCksXG4gICAgICBoZWFydGJlYXRNczogU1NFX0hFQVJUQkVBVF9NUyxcbiAgICAgIGNsaWVudHM6IHNzZUNsaWVudHMsXG4gICAgICBzaWduYWw6IHJlcS5zaWduYWwsXG4gICAgICBvbk9wZW46IHRvdWNoLFxuICAgICAgb25DbG9zZTogdG91Y2gsXG4gICAgfSk7XG4gIH07XG5cbiAgLy8gLS0tIHNlcnZlIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzZXJ2ZXIgPSBCdW4uc2VydmUoe1xuICAgIHBvcnQ6IG9wdHMucG9ydCA/PyAwLFxuICAgIGhvc3RuYW1lOiBvcHRzLmhvc3QgPz8gXCIxMjcuMC4wLjFcIixcbiAgICByb3V0ZXMsXG4gICAgLy8g4puUIEhFTEQgU1NFIENPTk5FQ1RJT05TIERJRSBXSVRIT1VUIFRISVMuIEJ1bidzIGRlZmF1bHQgcmVxdWVzdFxuICAgIC8vIGlkbGVUaW1lb3V0IGlzIDEwcyBhbmQgYSBzZXJ2ZXItc2VudCBoZWFydGJlYXQgZG9lcyBOT1QgcmVzZXQgaXQsIHNvIGFuXG4gICAgLy8gU1NFIGNsaWVudCBpcyBjbG9zZWQgYmVmb3JlIHRoZSAxNXMgYDogaGJgIGJlbG93IGV2ZXIgZmlyZXMg4oCUIHRoZVxuICAgIC8vIGtlZXBhbGl2ZSBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzIGtlZXBpbmcgYWxpdmUgaXNcbiAgICAvLyBnb25lLCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IHJhdGUgd291bGQgbm90IGhhdmUgaGVscGVkLlxuICAgIC8vIDI1NSBpcyBCdW4ncyBtYXhpbXVtICgwIGlzIG5vdCBcImRpc2FibGVkXCIpLCBtYXRjaGluZyBib3VudHksIGdyYXBldmluZVxuICAgIC8vIGFuZCBtaW5kLW1hcHBlcjsgYXN0cm9sYWJlIGVudi10dW5lcyBpdCBhbmQgY2xhbXBzIHRoZSBoZWFydGJlYXQgdG8gaGFsZi5cbiAgICAvLyBGb3VuZCAyMDI2LTA5LTA4IGJ5IHRoZSBiYWNrZW5kIGR1cGxpY2F0aW9uIHJlY29uOiBmb3VyIHNwZWxscyBoYWQgaGl0XG4gICAgLy8gdGhpcyBhbmQgZml4ZWQgaXQsIHRocmVlIGhhZCBub3QsIGJlY2F1c2UgdGhlIGRhZW1vbiBzcGluZSBpcyBvbmUgZGVzaWduXG4gICAgLy8gaW1wbGVtZW50ZWQgc2l4IHRpbWVzLlxuICAgIGlkbGVUaW1lb3V0OiBJRExFX1RJTUVPVVRfU0VDLFxuICAgIGRldmVsb3BtZW50OiB7IGhtcjogbW9kZSA9PT0gXCJkZXZcIiB9LFxuICAgIGZldGNoKHJlcSwgc3J2KSB7XG4gICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwpO1xuICAgICAgY29uc3QgcGF0aCA9IHVybC5wYXRobmFtZTtcbiAgICAgIGlmIChwYXRoID09PSBcIi93c1wiKVxuICAgICAgICByZXR1cm4gc3J2LnVwZ3JhZGUocmVxKSA/IHVuZGVmaW5lZCA6IG5ldyBSZXNwb25zZShcInVwZ3JhZGUgcmVxdWlyZWRcIiwgeyBzdGF0dXM6IDQyNiB9KTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL3N0YXRlXCIpIHtcbiAgICAgICAgdG91Y2goKTtcbiAgICAgICAgY29uc3QgbGVhbiA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwibGVhblwiKSA9PT0gXCIxXCI7XG4gICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHtcbiAgICAgICAgICBzdGF0ZTogbGVhbiA/IGxlYW5TdGF0ZShzdGF0ZSkgOiBzdGF0ZSxcbiAgICAgICAgICBjdXJzb3I6IGxvZy5jdXJzb3IoKSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9ldmVudHNcIikgcmV0dXJuIGV2ZW50c1Jlc3BvbnNlKHJlcSwgdXJsKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9jbWRcIilcbiAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAudGhlbigoYikgPT4ge1xuICAgICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICAgIC8vICM4NCDigJQgcHJvcGFnYXRlIHRoZSBoYW5kbGVyJ3MgdmVyZGljdCBpbnN0ZWFkIG9mIGEgbGl0ZXJhbFxuICAgICAgICAgICAgLy8ge29rOnRydWV9LiBgYXBwbGllZGAgaXMgdGhlIGZpZWxkIGJvdW50eSBhbHJlYWR5IHVzZXNcbiAgICAgICAgICAgIC8vIChzZXJ2ZXIudHMgQXBwbHlSZXN1bHQpOyBubyBuZXcgdm9jYWJ1bGFyeSBpcyBtaW50ZWQgaGVyZS5cbiAgICAgICAgICAgIGNvbnN0IHZlcmRpY3QgPSBoYW5kbGVBZ2VudE1zZyhiIGFzIEFnZW50Q29tbWFuZCk7XG4gICAgICAgICAgICAvLyBBIGNvbW1hbmQgdGhhdCBhbnN3ZXJlZCB3aXRoIGl0cyBvd24gcmVzdWx0IGNhcnJpZXMgaXRzIHBheWxvYWQ7XG4gICAgICAgICAgICAvLyB0aGUgYm9vbGVhbiBwYXRoIGJlbG93IGlzIHVuY2hhbmdlZC5cbiAgICAgICAgICAgIGlmICh0eXBlb2YgdmVyZGljdCA9PT0gXCJvYmplY3RcIilcbiAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgYXBwbGllZDogdHJ1ZSwgLi4udmVyZGljdC5kZXRhaWwgfSk7XG4gICAgICAgICAgICBjb25zdCBhcHBsaWVkID0gdmVyZGljdDtcbiAgICAgICAgICAgIGlmICghYXBwbGllZCkge1xuICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbihcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgICBhcHBsaWVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgIGVycm9yOiBgdW5yZWNvZ25pc2VkIGNvbW1hbmQgdHlwZSAke0pTT04uc3RyaW5naWZ5KFxuICAgICAgICAgICAgICAgICAgICAoYiBhcyB7IHR5cGU/OiB1bmtub3duIH0pPy50eXBlLFxuICAgICAgICAgICAgICAgICAgKX0g4oCUIG5vdGhpbmcgd2FzIGFwcGxpZWRgLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgeyBzdGF0dXM6IDQwMCB9LFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgYXBwbGllZDogdHJ1ZSB9KTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoKSA9PiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwiYmFkIGpzb25cIiB9LCB7IHN0YXR1czogNDAwIH0pKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGguc3RhcnRzV2l0aChcIi9hc3NldHMvXCIpKSB7XG4gICAgICAgIGNvbnN0IG5hbWUgPSBkZWNvZGVVUklDb21wb25lbnQocGF0aC5zbGljZShcIi9hc3NldHMvXCIubGVuZ3RoKSk7XG4gICAgICAgIGlmIChuYW1lLmluY2x1ZGVzKFwiLi5cIikgfHwgbmFtZS5zdGFydHNXaXRoKFwiL1wiKSlcbiAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IGVycm9yOiBcIm5vdCBmb3VuZFwiIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgICAgIGNvbnN0IGYgPSBCdW4uZmlsZShqb2luKHNlc3Npb25GaWxlc0RpciwgbmFtZSkpO1xuICAgICAgICByZXR1cm4gZlxuICAgICAgICAgIC5leGlzdHMoKVxuICAgICAgICAgIC50aGVuKChvaykgPT5cbiAgICAgICAgICAgIG9rID8gbmV3IFJlc3BvbnNlKGYpIDogUmVzcG9uc2UuanNvbih7IGVycm9yOiBcIm5vdCBmb3VuZFwiIH0sIHsgc3RhdHVzOiA0MDQgfSksXG4gICAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIC8vIHJlbGVhc2U6IFwiL1wiIGFuZCB0aGUgaGFzaGVkIGNodW5rLSouanMvY3NzIGFyZSBzdGF0aWMgZGlzdCByZWFkcy4gRGV2XG4gICAgICAvLyBuZXZlciByZWFjaGVzIGhlcmUgZm9yIFwiL1wiIOKAlCB0aGUgcm91dGVzIHRhYmxlIGFib3ZlIGFuc3dlcnMgaXQgZmlyc3QuXG4gICAgICAvLyBUaGlzIHNpdHMgQUZURVIgL2Fzc2V0cy8sIHdoaWNoIHNlcnZlcyBzZXNzaW9uIGZpbGVzLCBub3QgZGlzdCBvbmVzLlxuICAgICAgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgIGNvbnN0IGFzc2V0ID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICBpZiAoYXNzZXQpIHJldHVybiBhc3NldDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwibm90IGZvdW5kXCIgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICB9LFxuICAgIHdlYnNvY2tldDoge1xuICAgICAgb3Blbih3cykge1xuICAgICAgICBzb2NrZXRzLmFkZCh3cyk7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGVtaXRUcmFuc2llbnQoeyB0eXBlOiBcImNvbm5lY3RlZFwiIH0pO1xuICAgICAgICB3cy5zZW5kKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJzdGF0ZVwiLCBzdGF0ZSB9KSk7XG4gICAgICB9LFxuICAgICAgbWVzc2FnZShfd3MsIHJhdykge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGhhbmRsZUNsaWVudE1zZyhcbiAgICAgICAgICAgIEpTT04ucGFyc2UoXG4gICAgICAgICAgICAgIHR5cGVvZiByYXcgPT09IFwic3RyaW5nXCIgPyByYXcgOiBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUocmF3KSxcbiAgICAgICAgICAgICkgYXMgQ2xpZW50VG9TZXJ2ZXIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBnbGFtb3VyOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIGNsb3NlKHdzKSB7XG4gICAgICAgIHNvY2tldHMuZGVsZXRlKHdzKTtcbiAgICAgICAgZW1pdFRyYW5zaWVudCh7IHR5cGU6IFwiZGlzY29ubmVjdGVkXCIgfSk7XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGJvdW5kUG9ydCA9IHNlcnZlci5wb3J0O1xuICAvLyAtLS0gZGlzY292ZXJ5IGZpbGVzIChjbGkudHMgcmVhZHMgdGhlc2UpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc2Vzc2lvbkZpbGUgPSBqb2luKHRtcGRpcigpLCBgZ2xhbW91ci0ke3Nlc3Npb25JZH0uanNvbmApO1xuICBjb25zdCBsYXRlc3RGaWxlID0gam9pbih0bXBkaXIoKSwgYGdsYW1vdXItbGF0ZXN0Lmpzb25gKTtcbiAgY29uc3QgaW5mbyA9IEpTT04uc3RyaW5naWZ5KHtcbiAgICB1cmw6IGBodHRwOi8vJHtvcHRzLmhvc3QgPz8gXCIxMjcuMC4wLjFcIn06JHtib3VuZFBvcnR9YCxcbiAgICBwb3J0OiBib3VuZFBvcnQsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIHRpdGxlOiBzdGF0ZS50aXRsZSxcbiAgICBmaWxlc19kaXI6IHNlc3Npb25GaWxlc0RpcixcbiAgICBtb2RlLFxuICB9KTtcbiAgLy8g4pqgIEFUT01JQywgYmVjYXVzZSBjbGkudHMncyByZWFkU2Vzc2lvbiB0cmVhdHMgdW5wYXJzZWFibGUgY29udGVudCBhc1xuICAvLyBjb3JydXB0aW9uIHJhdGhlciB0aGFuIGFic2VuY2Ug4oCUIGFuZCB0aGlzIGltcGxlbWVudGF0aW9uIGlzIG5vd1xuICAvLyBga2l0L3dpcmUvZGlzY292ZXJ5LnRzYCwgc2hhcmVkIHdpdGggdGhlIHNpbmdsZXRvbiBjb252ZW50aW9uIEQzIGtlcHQgYWxpdmVcbiAgLy8gYmVzaWRlIHRoaXMgb25lLiBnbGFtb3VyIGlzIHdoZXJlIHRoZSBkZWZlY3QgKEwzKSB3YXMgZm91bmQgYW5kIGZpeGVkIG9uXG4gIC8vIDIwMjYtMDktMDc7IHdoYXQgc3RheWVkIGhlcmUgaXMgV0hJQ0ggZmlsZXMgZ2xhbW91ciB3cml0ZXMuXG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlQXRvbWljKHNlc3Npb25GaWxlLCBpbmZvKTtcbiAgICB3cml0ZUZpbGVBdG9taWMobGF0ZXN0RmlsZSwgaW5mbyk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGRpc2NvdmVyeSBpcyBiZXN0LWVmZm9ydCAqL1xuICB9XG5cbiAgLy8gQ29udHJhY3QgMTogdGhlIGRhZW1vbiBFTUlUUyBpdHMgcmVzb2x2ZWQgbW9kZSDigJQgYSBkZXYgZGFlbW9uIHdpdGggcm9vdCBkZXBzXG4gIC8vIHByZXNlbnQgcmVuZGVycyBhbiBpZGVudGljYWwtbG9va2luZyBib2FyZCwgc28gYG1vZGVgIGlzIHRoZSBvbmx5IHRoaW5nIHRoYXRcbiAgLy8gdGVsbHMgYSB2ZXJpZmllciB3aGljaCBwYXRoIHNlcnZlZCBpdC4gZ2xhbW91ciBoYXMgVEhSRUUgdHJhbnNwb3J0cyAoaW1hZ29cbiAgLy8gaGFzIHR3byk6IHRoaXMgZXZlbnQsIHRoZSBkaXNjb3ZlcnkgZmlsZSBhYm92ZSwgYW5kIHRoZSBzdGRvdXQgaGFuZHNoYWtlIGluXG4gIC8vIGltcG9ydC5tZXRhLm1haW4gYmVsb3cuIEFsbCB0aHJlZSBjYXJyeSBpdC5cbiAgZW1pdEV2ZW50KHsgdHlwZTogXCJyZWFkeVwiLCBtb2RlIH0pO1xuXG4gIC8vIC0tLSBzbmFwc2hvdCBkZWJvdW5jZSArIGlkbGUgc3dlZXAgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvL1xuICAvLyDim5QgVEhFIFNXRUVQIE5PVyBTRUVTIElUUyBTVUJTQ1JJQkVSUyDigJQgY2Vuc3VzIGRlZmVjdCBMMSwgY2xvc2VkIGJ5IHRoZSBzaGFyZWRcbiAgLy8gaG91c2VrZWVwZXIgUkVRVUlSSU5HIGEgYHN1YnNjcmliZXJDb3VudGAgcmF0aGVyIHRoYW4gYnkgYW55b25lIHJlbWVtYmVyaW5nLlxuICAvLyBUaGUgZXhwcmVzc2lvbiBoZXJlIHJlYWQgYChub3cgLSBsYXN0QWN0aXZpdHkpLzEwMDAgPj0gdGltZW91dGAgYW5kIG5vdGhpbmdcbiAgLy8gZWxzZSwgc28gYW4gYWdlbnQgaG9sZGluZyBhIGAvZXZlbnRzYCB0YWlsIG9uIGEgcXVpZXQgc2Vzc2lvbiB3YXMga2lsbGVkIFdJVEhcbiAgLy8gSVRTIENPTk5FQ1RJT04gT1BFTiBhdCB0aGUgMzAtbWludXRlIGZsb29yIOKAlCBnbGFtb3VyLCBpbWFnbyBhbmQgbWFncGllIGFsbFxuICAvLyBoYWQgaXQuIGB0aW1lb3V0YCBub3cgbWVhbnMgXCJsaW5nZXIgdGhpcyBsb25nIGFmdGVyIHRoZSBMQVNUIHN1YnNjcmliZXJcbiAgLy8gbGVhdmVzXCIsIG5vdCBcIm1heGltdW0gaWRsZSB3aGlsZSBjb25uZWN0ZWRcIi5cbiAgY29uc3Qgc2F2ZU5vdyA9ICgpID0+IHNhdmVTbmFwc2hvdChTTkFQU0hPVFNfRElSLCBzZXNzaW9uSWQsIHN0YXRlKTtcbiAgaWYgKHJlc3RvcmVkKSBzYXZlTm93KCk7XG4gIGNvbnN0IHRpbWVvdXRTID0gb3B0cy50aW1lb3V0UyA/PyAxODAwO1xuICBjb25zdCBzdG9wSG91c2VrZWVwaW5nID0gc3RhcnRIb3VzZWtlZXBpbmcoe1xuICAgIHN1YnNjcmliZXJDb3VudDogKCkgPT4gc29ja2V0cy5zaXplICsgc3NlQ2xpZW50cy5zaXplLFxuICAgIGlkbGVNczogKCkgPT4gcGVyZm9ybWFuY2Uubm93KCkgLSBsYXN0QWN0aXZpdHksXG4gICAgdG91Y2gsXG4gICAgdGltZW91dE1zOiB0aW1lb3V0UyAqIDEwMDAsXG4gICAgb25JZGxlQ2xvc2U6ICgpID0+IHJlc29sdmVEb25lKHsgY29kZTogMTI0LCByZWFzb246IFwidGltZW91dFwiIH0pLFxuICAgIHNuYXBzaG90OiB7XG4gICAgICBkaXJ0eTogKCkgPT4gc25hcERpcnR5LFxuICAgICAgY2xlYXI6ICgpID0+IHtcbiAgICAgICAgc25hcERpcnR5ID0gZmFsc2U7XG4gICAgICB9LFxuICAgICAgd3JpdGU6IHNhdmVOb3csXG4gICAgfSxcbiAgfSk7XG5cbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICAvLyBSZXNvbHZlcyBvbmNlIHRoZSBTU0UgZmx1c2ggKyBzZXJ2ZXIuc3RvcCBoYXZlIGJlZW4gc2NoZWR1bGVkOyBjYWxsZXJzXG4gIC8vIHRoYXQgbmVlZCB0byB3YWl0IChlLmcuIGltcG9ydC5tZXRhLm1haW4gYmVmb3JlIHByb2Nlc3MuZXhpdCkgY2FuIGF3YWl0IHRoaXMuXG4gIGxldCByZXNvbHZlU2h1dGRvd24hOiAoKSA9PiB2b2lkO1xuICBjb25zdCBzaHV0ZG93biA9IG5ldyBQcm9taXNlPHZvaWQ+KChyKSA9PiB7XG4gICAgcmVzb2x2ZVNodXRkb3duID0gcjtcbiAgfSk7XG5cbiAgLy8gVGhlIHNlc3Npb24gcG9pbnRlciBpcyB1bmNvbmRpdGlvbmFsbHkgb3VyczsgYGdsYW1vdXItbGF0ZXN0Lmpzb25gIGlzIE5PVCDigJRcbiAgLy8gYSBuZXdlciBzZXNzaW9uIG1heSBhbHJlYWR5IGhhdmUgY2xhaW1lZCBpdCwgYW5kIHVubGlua2luZyB0aGF0IHdvdWxkIG1ha2VcbiAgLy8gdGhlIGxpdmUgZGFlbW9uIGludmlzaWJsZSB0byB0aGUgbmV4dCB2ZXJiLiBgdW5saW5rSWZNYXRjaGVzYCdzIGBpZGVudGlmeWBcbiAgLy8gaG9vayBpcyB3aGF0IGxldHMgT05FIHNoYXJlZCBwcmVkaWNhdGUgc2VydmUgYm90aCB0aGlzIEpTT04gcG9pbnRlciBhbmRcbiAgLy8gYXN0cm9sYWJlJ3MgYmFyZSBwaWQgZmlsZSAoYGtpdC93aXJlL2Rpc2NvdmVyeS50c2ApLlxuICBjb25zdCBjbGVhbnVwRGlzY292ZXJ5ID0gKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICB1bmxpbmtTeW5jKHNlc3Npb25GaWxlKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGdvbmUg4oCUIGZpbmUgKi9cbiAgICB9XG4gICAgdW5saW5rSWZNYXRjaGVzKGxhdGVzdEZpbGUsIHNlc3Npb25JZCwgKHJhdykgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgaWQgPSAoSlNPTi5wYXJzZShyYXcpIGFzIHsgc2Vzc2lvbl9pZD86IHVua25vd24gfSkuc2Vzc2lvbl9pZDtcbiAgICAgICAgcmV0dXJuIHR5cGVvZiBpZCA9PT0gXCJzdHJpbmdcIiA/IGlkIDogbnVsbDtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICB9KTtcbiAgICB0cnkge1xuICAgICAgcm1TeW5jKHNlc3Npb25GaWxlc0RpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9O1xuXG4gIC8vIOKblCBTVEFZUyBTWU5DSFJPTk9VUyBBTkQgSURFTVBPVEVOVCwgYmVjYXVzZSBgZG9uZS50aGVuKCgpID0+IGNsb3NlKCkpYCBhbmRcbiAgLy8gdGhlIHN1aXRlcycgYGFmdGVyQWxsKCgpID0+IGQuY2xvc2UoKSlgIGJvdGggY2FsbCBpdCBhcyBhIHN0YXRlbWVudC4gVGhlXG4gIC8vIERSQUlOIGlzIHdoYXQgYmVjYW1lIGFzeW5jOiBgZHJhaW5BbmRTdG9wYCB3YWl0cyBpdHMgZ3JhY2UgcGVyaW9kLCBjbG9zZXNcbiAgLy8gZXZlcnkgcmVnaXN0ZXJlZCB0YWlsIHRocm91Z2ggdGhlIGZ1bm5lbCwgY2xvc2VzIHRoZSBzb2NrZXRzLCB0aGVuIFJBQ0VTXG4gIC8vIGBzZXJ2ZXIuc3RvcCh0cnVlKWAg4oCUIGJlY2F1c2UgdGhhdCBjYWxsIGF3YWl0cyBpdHMgY29ubmVjdGlvbnMgYW5kIG9uZSB3ZWRnZWRcbiAgLy8gcGVlciBpcyBlbm91Z2ggdG8gcGFyayB0ZWFyZG93biBmb3JldmVyIChhIDIzLW1pbnV0ZSBoYW5nIHNoaXBwZWQgb25jZSkuXG4gIC8vXG4gIC8vIOKaoCBUSEUgR1JBQ0UgUEVSSU9EIElTIDE1MCBtcywgTk9UIEdMQU1PVVInUyBPTEQgNTAsIGFuZCB0aGF0IGlzIGEgZGVsaWJlcmF0ZVxuICAvLyB3aXJlLW9ic2VydmFibGUgY2hhbmdlIHJhdGhlciB0aGFuIGFuIG92ZXJzaWdodDogMTUwIGlzIHRoZSBudW1iZXIgYWxsIGVpZ2h0XG4gIC8vIGRhZW1vbnMgY29udmVyZ2VkIG9uIGluZGVwZW5kZW50bHksIGFuZCBpdCBpcyB3aGF0IHR1cm5zIFwidGhlIGRhZW1vbiB0b2xkIHlvdVxuICAvLyB3aHkgaXQgZGllZFwiIGZyb20gYSBob3BlIGludG8gYW4gb2JzZXJ2YXRpb24uIGdsYW1vdXIncyBgY2xvc2VkYCBmcmFtZSBpcyB0aGVcbiAgLy8gb25lIHRoZSBDTEkncyB0YWlsIHdhdGNoZXMgZm9yLlxuICBjb25zdCBjbG9zZSA9ICgpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBzdG9wSG91c2VrZWVwaW5nKCk7XG4gICAgc2F2ZU5vdygpO1xuICAgIGNsZWFudXBEaXNjb3ZlcnkoKTtcbiAgICBlbWl0RXZlbnQoeyB0eXBlOiBcImNsb3NlZFwiIH0pO1xuICAgIHZvaWQgZHJhaW5BbmRTdG9wKHsgc2VydmVyLCBjbGllbnRzOiBzc2VDbGllbnRzLCBzb2NrZXRzIH0pLnRoZW4ocmVzb2x2ZVNodXRkb3duKTtcbiAgfTtcbiAgZG9uZS50aGVuKCgpID0+IGNsb3NlKCkpO1xuXG4gIHJldHVybiB7IHBvcnQ6IGJvdW5kUG9ydCwgc2Vzc2lvbklkLCBtb2RlLCBjbG9zZSwgZG9uZSwgc2h1dGRvd24gfTtcbn1cblxuLy8gIzgxIC8gRDQg4oCUIFRIRSBSRUNPR05JWkVEIFNFVCwgQVQgUEFSU0VSIEFMVElUVURFLiBUaGUgU0lYVEggZW50cnkgcG9pbnQuXG4vL1xuLy8g4pqgIFRISVMgT05FIEhBUyBaRVJPIGBmbGFncy5gIFJFQURTLCBzbyBhIGBmbGFncy5gLXBhdHRlcm4gYXVkaXQgcmV0dXJucyB6ZXJvXG4vLyBoZXJlIOKAlCBhbmQgYSB6ZXJvIHJlYWRzIGlkZW50aWNhbGx5IHRvIFwibm8gZHJpZnRcIi4gSXQgd2FzIGEgTE9PS1VQIHBhcnNlcjpcbi8vIGBjb25zdCBmbGFnID0gKG5hbWUpID0+IHsgY29uc3QgaSA9IGFyZ3MuaW5kZXhPZihgLS0ke25hbWV9YCk7IHJldHVybiBpID49IDBcbi8vID8gYXJnc1tpICsgMV0gOiB1bmRlZmluZWQ7IH1gLiBJdCBhbHNvIHJlYWQgYEJ1bi5hcmd2YCwgbm90IGBwcm9jZXNzLmFyZ3ZgLFxuLy8gd2hpY2ggaXMgdGhlIHN5bm9ueW0gdGhhdCBoYXMgbWFkZSB0aGlzIHJlcG8ncyBncmVwcyBsaWUgYmVmb3JlLlxuLy9cbi8vIEl0IGhhZCBhIExBVEVOVCwgUFJFLUVYSVNUSU5HIGJ1ZyB0aGUgY29udmVyc2lvbiBmaXhlcyBhcyBhIHNpZGUgZWZmZWN0LCBub3RlZFxuLy8gc28gdGhlIGNoYW5nZSBpcyBub3QgbWlzdGFrZW4gZm9yIGEgcmVncmVzc2lvbjogYGZsYWcoKWAgcmV0dXJuZWQgYGFyZ3NbaSsxXWBcbi8vIFVOQ09ORElUSU9OQUxMWSwgc28gYC0tcmVzdG9yZSAtLXRpdGxlIFhgIHlpZWxkZWQgYHJlc3RvcmUgPT09IFwiLS10aXRsZVwiYCDigJRcbi8vIHRoZSBuZXh0IEZMQUcgc2lsZW50bHkgY29uc3VtZWQgYXMgdGhlIHByZXZpb3VzIGZsYWcncyBWQUxVRS5cbi8vXG4vLyBBbGwgc2l4IGFyZSBzdHJpbmcgYnkgY29uc3RydWN0aW9uICh0aGUgb2xkIGhlbHBlciByZXR1cm5lZCB0aGUgbmV4dCBhcmd2XG4vLyBlbGVtZW50KS4gYHBvcnRgIGFuZCBgdGltZW91dGAgYXJlIE51bWJlcigpLWNvZXJjZWQgYXQgdGhlIGNhbGwgc2l0ZSwgd2hpY2ggaXNcbi8vIGEgdmFsdWUgcmVhZCwgbm90IGEgYm9vbGVhbiBvbmUuIFRoZSBkYWVtb24gdGFrZXMgbm8gcG9zaXRpb25hbHMsIHNvIHN0cmljdCdzXG4vLyBkZWZhdWx0IHJlamVjdGlvbiBvZiB0aGVtIGlzIGNvcnJlY3QuXG4vL1xuLy8gVmVyaWZpZWQgYmVmb3JlIGNvbnZlcnRpbmc6IGBjbGkudHNgIHNwYXducyB0aGlzIGRhZW1vbiB3aXRoIGV4YWN0bHkgLS10aXRsZSxcbi8vIC0taW50ZW50LCAtLXRpbWVvdXQsIC0tcmVzdG9yZSBhbmQgLS1wcm9qZWN0LCBhbGwgaW5zaWRlIHRoaXMgc2V0IOKAlCBzbyBzdHJpY3Rcbi8vIGNhbm5vdCByZWZ1c2UgdGhlIGRhZW1vbidzIG93biBsYXVuY2guXG5jb25zdCBEQUVNT05fT1BUSU9OUyA9IHtcbiAgaW50ZW50OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcG9ydDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHByb2plY3Q6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByZXN0b3JlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGltZW91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpdGxlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbn0gYXMgY29uc3Q7XG5cbi8qKiBQYXJzZSB0aGUgZGFlbW9uJ3MgYXJndiwgYm9vdCwgcHJpbnQgdGhlIGhhbmRzaGFrZSwgYW5kIHdhaXQgZm9yIHRoZSBlbmQuXG4gKiAgUmV0dXJucyB0aGUgcHJvY2VzcyBleGl0IGNvZGU7IGl0IGRvZXMgTk9UIGV4aXQg4oCUIHRoZSBsYXVuY2hlciBkb2VzLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD47XG4gIHRyeSB7XG4gICAgZmxhZ3MgPSBub2RlUGFyc2VBcmdzKHsgYXJnczogYXJndiwgb3B0aW9uczogREFFTU9OX09QVElPTlMsIHN0cmljdDogdHJ1ZSB9KS52YWx1ZXMgYXMgUmVjb3JkPFxuICAgICAgc3RyaW5nLFxuICAgICAgc3RyaW5nIHwgdW5kZWZpbmVkXG4gICAgPjtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYGdsYW1vdXI6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmAgK1xuICAgICAgICBgICByZWNvZ25pemVkIGZsYWdzOiAke09iamVjdC5rZXlzKERBRU1PTl9PUFRJT05TKVxuICAgICAgICAgIC5tYXAoKGspID0+IGAtLSR7a31gKVxuICAgICAgICAgIC5qb2luKFwiIFwiKX1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3QgZCA9IGF3YWl0IHN0YXJ0RGFlbW9uKHtcbiAgICBwb3J0OiBmbGFncy5wb3J0ID8gTnVtYmVyKGZsYWdzLnBvcnQpIDogMCxcbiAgICB0aXRsZTogZmxhZ3MudGl0bGUsXG4gICAgaW50ZW50OiBmbGFncy5pbnRlbnQsXG4gICAgcmVzdG9yZTogZmxhZ3MucmVzdG9yZSxcbiAgICB0aW1lb3V0UzogZmxhZ3MudGltZW91dCA/IE51bWJlcihmbGFncy50aW1lb3V0KSA6IHVuZGVmaW5lZCxcbiAgICBwcm9qZWN0OiBmbGFncy5wcm9qZWN0LFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7ZC5wb3J0fWAsIHBvcnQ6IGQucG9ydCwgc2Vzc2lvbl9pZDogZC5zZXNzaW9uSWQsIG1vZGU6IGQubW9kZSB9KX1cXG5gLFxuICApO1xuICBjb25zdCByZXMgPSBhd2FpdCBkLmRvbmU7XG4gIC8vIFdhaXQgZm9yIHRoZSBjbG9zZWQgU1NFIGV2ZW50IHRvIGZsdXNoIGJlZm9yZSBleGl0aW5nLlxuICBhd2FpdCBkLnNodXRkb3duO1xuICByZXR1cm4gcmVzLmNvZGU7XG59XG5cbi8qKlxuICogVGhlIGRhZW1vbidzIGVudHJ5LCBmb3IgdGhlIExBVU5DSEVSIGF0XG4gKiBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dsYW1vdXIvc2NyaXB0cy9zZXJ2ZXIudHNgLlxuICpcbiAqIOKblCBgaW1wb3J0Lm1ldGEubWFpbmAgSVMgRkFMU0UgSU4gVEhFIEJVTkRMRS4gYGRpc3Qvc2VydmVyLmpzYCBpcyBJTVBPUlRFRCBieVxuICogdGhlIGxhdW5jaGVyLCBuZXZlciBleGVjdXRlZCBhcyB0aGUgcHJvY2VzcyBlbnRyeSwgc28gdGhlIG9sZFxuICogYGlmIChpbXBvcnQubWV0YS5tYWluKWAgYmxvY2sgd291bGQgc2ltcGx5IG5ldmVyIHJ1biDigJQgdGhlIGRhZW1vbiB3b3VsZCBib290LFxuICogc2VydmUgbm90aGluZyBhbmQgZXhpdCAwLCBhbmQgZXZlcnkgdGVzdCB3b3VsZCBmYWlsIGFzIFwidGhlIGRhZW1vbiBuZXZlciBib3VuZFxuICogYSBwb3J0XCIsIHdoaWNoIHJlYWRzIGxpa2UgZmxha2UuIFRoYXQgaXMgdGhlIGZhaWx1cmUgdGhpcyBleHBvcnQgZXhpc3RzIHRvXG4gKiBwcmV2ZW50LCBhbmQgaXQgaXMgdGhlIGZpcnN0IHRoaW5nIHRoYXQgYnJlYWtzIG9uIGV2ZXJ5IGJhY2tlbmQgcmVsb2NhdGlvbi5cbiAqXG4gKiDim5QgQU5EIFRIRVJFIElTIE5PIGBpbXBvcnQubWV0YS5tYWluYCBCTE9DSyBMRUZULCBkZWxpYmVyYXRlbHkgKEQxMikuIFJ1biBmcm9tXG4gKiBgc3JjL2dsYW1vdXIvYmFja2VuZC9gLCBgU0tJTExfUk9PVGAgY29tcHV0ZXMgdG8gYHNyYy9nbGFtb3VyL2AsIHdoaWNoIGhvbGRzIG5vXG4gKiBgZGlzdC9pbmRleC5odG1sYCDigJQgc28gdGhlIGRhZW1vbiB3b3VsZCBzaWxlbnRseSBjaG9vc2UgREVWIG1vZGUgYW5kIHRoZW4gZmFpbFxuICogdGhlIGRldiBpbXBvcnQgZnJvbSB0aGUgd3JvbmcgYW5jaG9yLiBPZmZlcmluZyB0aGF0IGVudHJ5IHdvdWxkIGJlIG9mZmVyaW5nIGFcbiAqIHdyb25nIGRhZW1vbi5cbiAqXG4gKiDim5QgQU5EIElUIFRBS0VTIE5PIEFSR1VNRU5UUywgZm9yIHRoZSBzYW1lIHJlYXNvbiBgY2xpLnRzYCdzIGBydW4oKWAgZG9lcyBub3Q6XG4gKiB0aGUgY29tbWFuZCBsaW5lIGJlbG9uZ3MgdG8gdGhlIGZpbGUgdGhhdCBQQVJTRVMgaXQuIEEgbGF1bmNoZXIgdGhhdCB0b3VjaGVkXG4gKiBgcHJvY2Vzcy5hcmd2YCB3b3VsZCBtYXRjaCBgZ3JpbW9pcmUvbGliL2VudHJ5LXBvaW50cy50c2AncyBhcmctcGFyc2luZ1xuICogcHJlZGljYXRlIGFuZCB0aGUgd2FyZHMgd291bGQganVkZ2UgdGhpcyBkYWVtb24ncyBmbGFncyBhZ2FpbnN0IGEgZmlsZSB0aGF0XG4gKiByZWNvZ25pc2VzIG5vbmUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cbiIsCiAgICAiLy8gVGhlIHNpbmdsZSBzaGFyZWQgY29udHJhY3Qg4oCUIGltcG9ydGVkIGJ5IHNlcnZlci50cywgY2xpLnRzLCBhbmQgdGhlIHN1cmZhY2UuXG5cbmV4cG9ydCB0eXBlIEl0ZW1LaW5kID0gXCJyZWZcIiB8IFwiY29udGV4dFwiIHwgXCJnZW5cIiB8IFwic3R5bGVcIjtcbmV4cG9ydCBjb25zdCBWQUxJRF9LSU5EOiByZWFkb25seSBJdGVtS2luZFtdID0gW1wicmVmXCIsIFwiY29udGV4dFwiLCBcImdlblwiLCBcInN0eWxlXCJdIGFzIGNvbnN0O1xuXG4vLyBHZW5lcmF0aW9uIG1ldGFkYXRhIChHMSkuIEZ1bGx5IHBvcHVsYXRlZCBmb3Iga2luZCA9PT0gXCJnZW5cIiBpbiBTbGljZSAzO1xuLy8gdGhlIGZpZWxkIGV4aXN0cyBub3cgc28gdGhlIGNvbnRyYWN0IGFuZCB0aGUgZGV0YWlscyBmbHktb3V0IGFyZSBzdGFibGUuXG5leHBvcnQgdHlwZSBHZW5NZXRhID0ge1xuICBtb2RlbDogc3RyaW5nO1xuICBwcm9tcHQ6IHN0cmluZztcbiAgc2VlZDogbnVtYmVyIHwgbnVsbDtcbiAgY29zdDogbnVtYmVyIHwgbnVsbDtcbiAgY3VzdG9tOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICByb3VuZDogbnVtYmVyOyAvLyBiYXRjaCBpbmRleCB0aGUgYWdlbnQgc3RhbXBzOyBVSSBncm91cHMgZ2VuIGl0ZW1zIGJ5IGl0XG59O1xuXG4vLyBPbmUgY2F0YWxvZyBlbnRyeS4gU2hhcGUgZm9sbG93cyBpbWFnbydzIENvbnRleHRFbnRyeSBjb252ZW50aW9uczpcbi8vIGJsb2JzIChgc3JjYCwgYHRleHRgKSBhcmUgc3RyaXBwZWQgaW4gdGhlIGxlYW4gYWdlbnQgcHJvamVjdGlvbjsgdGhlIGFnZW50XG4vLyByZWFkcyBgcGF0aGAuIEFyY2hpdmFsIGlzIG5vbi1kZXN0cnVjdGl2ZSAodGhlIGBhcmNoaXZlZGAgZmxhZzsgdGhlIGl0ZW1cbi8vIHN1cnZpdmVzIGluIHRoZSBsaWJyYXJ5KS5cbmV4cG9ydCB0eXBlIExpYnJhcnlJdGVtID0ge1xuICBpZDogc3RyaW5nO1xuICBraW5kOiBJdGVtS2luZDtcbiAgdGl0bGU6IHN0cmluZztcbiAgc3JjOiBzdHJpbmc7IC8vIGltYWdlIGRhdGEtVVJMIChyZWYvZ2VuKTsgXCJcIiBvdGhlcndpc2Ug4oCUIHN0cmlwcGVkIGluIGxlYW5cbiAgcGF0aDogc3RyaW5nOyAvLyBvbi1kaXNrIG1hdGVyaWFsaXplZCBibG9iIHRoZSBhZ2VudCBjYW4gUmVhZDsgXCJcIiBpZiBub25lXG4gIHRleHQ6IHN0cmluZzsgLy8gY29udGV4dCBib2R5OyBcIlwiIG90aGVyd2lzZSDigJQgc3RyaXBwZWQgaW4gbGVhblxuICBtaW1lOiBzdHJpbmc7IC8vIGUuZy4gXCJpbWFnZS93ZWJwXCIsIFwidGV4dC9tYXJrZG93blwiXG4gIHRhZ3M6IHN0cmluZ1tdO1xuICBzdGFycmVkOiBib29sZWFuO1xuICBsaWtlZDogYm9vbGVhbjtcbiAgYW5ub3RhdGlvbnM6IHsgYWdlbnQ6IHN0cmluZzsgaHVtYW46IHN0cmluZyB9O1xuICBjYW5vbmljYWw6IGJvb2xlYW47IC8vIG1hcmtlZCBjYW5vbmljYWwgZm9yIHRoZSBzdHlsZSBiZWluZyBidWlsdCAobXVsdGksIG5vdCBzaW5nbGUtc2VsZWN0KVxuICBjYW5vbjogQ2Fub25JbWdbXTsgLy8gYSBraW5kOlwic3R5bGVcIiBpdGVtJ3MgY2Fub25pY2FsIHRodW1ibmFpbHM7IFtdIG90aGVyd2lzZSDigJQgc3RyaXBwZWQgaW4gbGVhblxuICBhcmNoaXZlZDogYm9vbGVhbjtcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIGdlbjogR2VuTWV0YSB8IG51bGw7XG59O1xuXG4vLyBDb252ZXJzYXRpb24uIEFnZW50IG1lc3NhZ2Uga2luZHMgY2FycnkgVjEncyBuYXJyYXRpb24gc2VtYW50aWNzXG4vLyAoaW5mbyB8IHdvcmtpbmcgfCByZXN1bHQgfCBlcnJvcik7IHVzZXIgbWVzc2FnZXMgYXJlIGFsd2F5cyBcImluZm9cIi5cbmV4cG9ydCB0eXBlIE1lc3NhZ2VLaW5kID0gXCJpbmZvXCIgfCBcIndvcmtpbmdcIiB8IFwicmVzdWx0XCIgfCBcImVycm9yXCI7XG5leHBvcnQgdHlwZSBNZXNzYWdlID0ge1xuICBpZDogc3RyaW5nO1xuICB3aG86IFwidXNlclwiIHwgXCJhZ2VudFwiO1xuICBraW5kOiBNZXNzYWdlS2luZDtcbiAgdGV4dDogc3RyaW5nO1xuICBncm91bmQ6IHN0cmluZ1tdOyAvLyBpdGVtIGlkcyBncm91bmRpbmcgdGhpcyBtZXNzYWdlIChzbmFwc2hvdCBvZiBzZWxlY3RlZElkcyk7IFtdIGlmIG5vbmVcbiAgdHM6IG51bWJlcjtcbn07XG5cbi8vIEEgYnJvdWdodC1pbiBzdHlsZSdzIGNhbm9uaWNhbCB0aHVtYm5haWwgKGRhdGEtVVJMIGBzcmNgIOKAlCBzdHJpcHBlZCBpbiBsZWFuKS5cbmV4cG9ydCB0eXBlIENhbm9uSW1nID0geyB0aXRsZTogc3RyaW5nOyBzcmM6IHN0cmluZyB9O1xuXG4vLyBBIGNhbm9uaWNhbCBpbWFnZSBpbnNpZGUgYSBTYXZlZFN0eWxlOiB0aGUgYmxvYiBpcyBjb3BpZWQgaW50byB0aGUgc3R5bGUnc1xuLy8gZGlyIG9uIHNhdmUgYW5kIHJlZmVyZW5jZWQgYnkgYGZpbGVgIChzbyB0aGUgc2F2ZWQgc3R5bGUgaXMgc2VsZi1jb250YWluZWQpLlxuZXhwb3J0IHR5cGUgQ2Fub25pY2FsUmVmID0ge1xuICBpZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBmaWxlOiBzdHJpbmc7XG4gIG1pbWU6IHN0cmluZztcbn07XG5cbi8vIEEgc3R5bGUgc2F2ZWQgdG8gdGhlIHByb2plY3QgdHJheSDigJQgYSBjb21wb3VuZCBcImNhbm9uaWNhbCBzaGFwZVwiOiB0aGUgY29kaWZpZWRcbi8vIHN0eWxlLWd1aWRlIHNlY3Rpb25zICh0ZXh0KSArIGNhbm9uaWNhbCBpbWFnZXMuIFByb2plY3Qtc2NvcGVkLCBub24tZGVzdHJ1Y3RpdmUuXG5leHBvcnQgdHlwZSBTYXZlZFN0eWxlID0ge1xuICBpZDogc3RyaW5nO1xuICBsYWJlbDogc3RyaW5nO1xuICB0ZXh0OiBzdHJpbmc7IC8vIHNob3J0IGh1bWFuIGRlc2NyaXB0aW9uIChlLmcuIHRoZSBVbmRlcnN0YW5kaW5nL0RpcmVjdGlvbiBnaXN0KVxuICBzZWN0aW9uczogU3R5bGVTZWN0aW9uW107IC8vIHRoZSBjb2RpZmllZCBzdHlsZSBndWlkZSBhdCBzYXZlIHRpbWVcbiAgY2Fub25pY2FsOiBDYW5vbmljYWxSZWZbXTtcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIGFyY2hpdmVkOiBib29sZWFuO1xufTtcblxuLy8gVGhlIGFnZW50LWFzc2VtYmxlZCBzdHlsZSBndWlkZS4gU2VjdGlvbiBzZXQgKyBsYWJlbHMgYXJlIHRoZSBtb2NrdXAnc1xuLy8gKHRoZSBjb252ZXJnZWQgc3VyZmFjZSkuIFNlY3Rpb25zIGZpbGwgaW46IGVtcHR5IOKGkiBmb3JtaW5nIOKGkiBhZ3JlZWQuXG5leHBvcnQgdHlwZSBTZWN0aW9uU3RhdHVzID0gXCJlbXB0eVwiIHwgXCJmb3JtaW5nXCIgfCBcImFncmVlZFwiO1xuZXhwb3J0IHR5cGUgU2VjdGlvbktleSA9XG4gIHwgXCJ1bmRlcnN0YW5kaW5nXCJcbiAgfCBcImRpcmVjdGlvblwiXG4gIHwgXCJwYWxldHRlXCJcbiAgfCBcImNvbnNpc3RlbmN5XCJcbiAgfCBcInByb21wdHNcIlxuICB8IFwiY2Fub25pY2FsXCI7XG4vLyBBIHBhbGV0dGUgc3dhdGNoIOKAlCBzdHJ1Y3R1cmVkIGNvbG9yIGZvciB0aGUgXCJwYWxldHRlXCIgc2VjdGlvbi5cbmV4cG9ydCB0eXBlIFN3YXRjaCA9IHsgaGV4OiBzdHJpbmc7IG5hbWU/OiBzdHJpbmcgfTtcbmV4cG9ydCB0eXBlIFN0eWxlU2VjdGlvbiA9IHtcbiAga2V5OiBTZWN0aW9uS2V5O1xuICBsYWJlbDogc3RyaW5nO1xuICBzdGF0dXM6IFNlY3Rpb25TdGF0dXM7XG4gIGNvbnRlbnQ6IHN0cmluZzsgLy8gcHJvc2VcbiAgcHJvbXB0czogc3RyaW5nW107IC8vIHBvcHVsYXRlZCBmb3IgdGhlIFwicHJvbXB0c1wiIHNlY3Rpb247IFtdIGVsc2V3aGVyZVxuICBjb2xvcnM6IFN3YXRjaFtdOyAvLyBwb3B1bGF0ZWQgZm9yIHRoZSBcInBhbGV0dGVcIiBzZWN0aW9uOyBbXSBlbHNld2hlcmVcbn07XG5cbi8vIFRoZSB6b29tL2ZvY3VzIGNvLXByZXNlbmNlIGxlbnMuIEVpdGhlciBwYXJ0eSBjYW4gc2NvcGUgdGhlIHNldC5cbmV4cG9ydCB0eXBlIEZvY3VzU2NvcGUgPSBcImFsbFwiIHwgXCJmb2N1c1wiO1xuZXhwb3J0IHR5cGUgRm9jdXNPd25lciA9IFwieW91XCIgfCBcImFnZW50XCIgfCBudWxsO1xuXG5leHBvcnQgdHlwZSBHbGFtb3VyU3RhdGUgPSB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGludGVudDogc3RyaW5nO1xuICBsaWJyYXJ5OiBMaWJyYXJ5SXRlbVtdO1xuICBzZWxlY3RlZElkczogc3RyaW5nW107IC8vIGxpbmtlZCBzZXQg4oCUIHRoZSBncm91bmRpbmcgc2V0ICh1bnNlbGVjdCDiiaAgZGVsZXRlKVxuICBtZXNzYWdlczogTWVzc2FnZVtdO1xuICBzdHlsZUd1aWRlOiBTdHlsZVNlY3Rpb25bXTtcbiAgdHJheTogU2F2ZWRTdHlsZVtdO1xuICBzY29wZTogRm9jdXNTY29wZTtcbiAgZm9jdXNTZXQ6IHN0cmluZ1tdOyAvLyBpdGVtIGlkcyBpbiB0aGUgZm9jdXNlZCBzZXQ7IGVtcHR5IHdoZW4gc2NvcGUgPT09IFwiYWxsXCJcbiAgZm9jdXNPd25lcjogRm9jdXNPd25lcjsgLy8gd2hvIHNjb3BlZCB0aGUgZm9jdXNcbiAgZm9jdXNOb3RlOiBzdHJpbmc7IC8vIGFnZW50J3MgY29udGV4dHVhbCBxdWVzdGlvbiBmb3IgdGhlIGZvY3VzIGRyYXdlcjsgXCJcIiBvdGhlcndpc2VcbiAgc3RhdHVzOiB7IGJ1c3k6IGJvb2xlYW47IHRleHQ6IHN0cmluZyB9O1xufTtcblxuLy8gTGVhbiBwcm9qZWN0aW9uIHNlbnQgdG8gdGhlIGFnZW50OiBibG9icyBzdHJpcHBlZCwgcGF0aHMga2VwdC5cbmV4cG9ydCB0eXBlIExlYW5JdGVtID0gT21pdDxMaWJyYXJ5SXRlbSwgXCJzcmNcIiB8IFwidGV4dFwiIHwgXCJjYW5vblwiPjtcbmV4cG9ydCB0eXBlIExlYW5TdGF0ZSA9IE9taXQ8R2xhbW91clN0YXRlLCBcImxpYnJhcnlcIj4gJiB7XG4gIGxpYnJhcnk6IExlYW5JdGVtW107XG59O1xuXG4vLyBTZXJ2ZXIg4oaSIGJyb3dzZXIgKFdlYlNvY2tldCkuIEZ1bGwtc3RhdGUgYnJvYWRjYXN0IGlzIHRoZSBvbmx5IGZyYW1lLlxuZXhwb3J0IHR5cGUgU2VydmVyVG9DbGllbnQgPSB7IHR5cGU6IFwic3RhdGVcIjsgc3RhdGU6IEdsYW1vdXJTdGF0ZSB9O1xuXG4vLyBCcm93c2VyIOKGkiBzZXJ2ZXIgKFdlYlNvY2tldCkuXG5leHBvcnQgdHlwZSBDbGllbnRUb1NlcnZlciA9XG4gIHwge1xuICAgICAgdHlwZTogXCJpdGVtLmFkZFwiO1xuICAgICAgaXRlbToge1xuICAgICAgICBraW5kOiBcInJlZlwiIHwgXCJjb250ZXh0XCI7XG4gICAgICAgIHRpdGxlOiBzdHJpbmc7XG4gICAgICAgIHNyYz86IHN0cmluZztcbiAgICAgICAgdGV4dD86IHN0cmluZztcbiAgICAgICAgbWltZT86IHN0cmluZztcbiAgICAgIH07XG4gICAgfVxuICB8IHsgdHlwZTogXCJpdGVtLnNlbGVjdFwiOyBpZHM6IHN0cmluZ1tdIH0gLy8gYW1iaWVudFxuICB8IHsgdHlwZTogXCJpdGVtLnN0YXJcIjsgaWQ6IHN0cmluZzsgc3RhcnJlZDogYm9vbGVhbiB9IC8vIGFtYmllbnRcbiAgfCB7IHR5cGU6IFwiaXRlbS5saWtlXCI7IGlkOiBzdHJpbmc7IGxpa2VkOiBib29sZWFuIH0gLy8gYW1iaWVudFxuICB8IHsgdHlwZTogXCJpdGVtLmFubm90YXRlXCI7IGlkOiBzdHJpbmc7IGh1bWFuOiBzdHJpbmcgfSAvLyBhbWJpZW50IOKAlCBzdG9yZWQgKyByZWFkIG9uIGRlbWFuZCwgbm90IHB1c2hlZCBhcyBhbiBldmVudFxuICB8IHsgdHlwZTogXCJtZXNzYWdlLnNlbmRcIjsgdGV4dDogc3RyaW5nIH0gLy8gaW1wZXJhdGl2ZVxuICB8IHsgdHlwZTogXCJmb2N1cy5zZXRcIjsgaWRzOiBzdHJpbmdbXSB9IC8vIGFtYmllbnQg4oCUIGh1bWFuIHNjb3BlcyBhIGZvY3VzIHNldFxuICB8IHsgdHlwZTogXCJmb2N1cy5jbGVhclwiIH0gLy8gYW1iaWVudCDigJQgaHVtYW4gem9vbXMgYmFjayBvdXRcbiAgfCB7IHR5cGU6IFwiaXRlbS5jYW5vbmljYWxcIjsgaWQ6IHN0cmluZzsgY2Fub25pY2FsOiBib29sZWFuIH0gLy8gYW1iaWVudFxuICB8IHsgdHlwZTogXCJpdGVtLmFyY2hpdmVcIjsgaWQ6IHN0cmluZzsgYXJjaGl2ZWQ6IGJvb2xlYW4gfSAvLyBhbWJpZW50XG4gIHwgeyB0eXBlOiBcInN0eWxlLmJyaW5nSW5cIjsgaWQ6IHN0cmluZyB9OyAvLyBpbXBlcmF0aXZlIOKAlCBhZGRzIGEga2luZDpcInN0eWxlXCIgaXRlbVxuXG4vLyBBZ2VudCDihpIgc2VydmVyIChIVFRQIFBPU1QgL2NtZCkuXG5leHBvcnQgdHlwZSBBZ2VudENvbW1hbmQgPVxuICB8IHsgdHlwZTogXCJpbml0XCI7IHRpdGxlPzogc3RyaW5nOyBpbnRlbnQ/OiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJpbnRlbnRcIjsgdGV4dDogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwiaXRlbS5hbm5vdGF0ZVwiOyBpZDogc3RyaW5nOyBhZ2VudDogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwic2F5XCI7IHRleHQ6IHN0cmluZzsga2luZD86IE1lc3NhZ2VLaW5kIH1cbiAgfCB7XG4gICAgICB0eXBlOiBcInNlY3Rpb25cIjtcbiAgICAgIGtleTogU2VjdGlvbktleTtcbiAgICAgIGNvbnRlbnQ/OiBzdHJpbmc7XG4gICAgICBzdGF0dXM/OiBTZWN0aW9uU3RhdHVzO1xuICAgICAgcHJvbXB0cz86IHN0cmluZ1tdO1xuICAgICAgY29sb3JzPzogU3dhdGNoW107XG4gICAgfVxuICB8IHtcbiAgICAgIHR5cGU6IFwiZ2VuLmFkZFwiO1xuICAgICAgc3JjOiBzdHJpbmc7IC8vIGFuIEFMUkVBRFktb3B0aW1pemVkIHdlYnAgZGF0YS1VUkwgKENMSSBkb2VzIHRoZSBvcHRpbWl6YXRpb24pXG4gICAgICBwcm9tcHQ6IHN0cmluZztcbiAgICAgIG1vZGVsOiBzdHJpbmc7XG4gICAgICByb3VuZDogbnVtYmVyO1xuICAgICAgc2VlZD86IG51bWJlcjtcbiAgICAgIGNvc3Q/OiBudW1iZXI7XG4gICAgICBsYWJlbD86IHN0cmluZztcbiAgICAgIGN1c3RvbT86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gICAgfVxuICB8IHsgdHlwZTogXCJnZW4uY29zdFwiOyBpZDogc3RyaW5nOyBjb3N0OiBudW1iZXIgfSAvLyBiYWNrZmlsbCBjb3N0IG9uY2UgbWVkaWEtZm9yZ2UgZmluYWxpemVzIGl0XG4gIHwgeyB0eXBlOiBcImdlbi5tZXRhXCI7IGlkOiBzdHJpbmc7IHByb21wdD86IHN0cmluZzsgY3VzdG9tPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB9IC8vIGJhY2tmaWxsIHRoZSByZWFsIHByb21wdCAvIHJlZnMgb250byBhIGdlblxuICB8IHsgdHlwZTogXCJmb2N1cy5wdXNoXCI7IGlkczogc3RyaW5nW107IG5vdGU/OiBzdHJpbmcgfSAvLyBhZ2VudCBzY29wZXMgYSBmb2N1cyBzZXQgKyBhc2tzXG4gIHwgeyB0eXBlOiBcInN0eWxlLnNhdmVcIjsgbGFiZWw6IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcInN0eWxlLmFyY2hpdmVcIjsgaWQ6IHN0cmluZzsgYXJjaGl2ZWQ6IGJvb2xlYW4gfVxuICB8IHsgdHlwZTogXCJzdGF0dXNcIjsgYnVzeTogYm9vbGVhbjsgdGV4dD86IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcImNsb3NlXCIgfTtcblxuLy8gVGhlIGNvbXBsZXRlIGFnZW50LWV2ZW50IHNldCAoc2VydmVyIOKGkiBhZ2VudCBTU0UpLiBPbmx5IHRoZXNlIGFyZSBlbWl0dGVkLlxuLy8gSW1wZXJhdGl2ZXMgb25seSDigJQgYm9hcmQgbW92ZXMgKHNlbGVjdC9zdGFyL2xpa2UpIGFyZSBhbWJpZW50LlxuZXhwb3J0IGNvbnN0IEFHRU5UX0VWRU5UX1RZUEVTID0gT2JqZWN0LmZyZWV6ZShbXG4gIFwicmVhZHlcIixcbiAgXCJjb25uZWN0ZWRcIixcbiAgXCJkaXNjb25uZWN0ZWRcIixcbiAgXCJpdGVtLmFkZFwiLFxuICBcIm1lc3NhZ2UudXNlclwiLFxuICBcImNsb3NlZFwiLFxuXSBhcyBjb25zdCk7XG5leHBvcnQgdHlwZSBBZ2VudEV2ZW50VHlwZSA9ICh0eXBlb2YgQUdFTlRfRVZFTlRfVFlQRVMpW251bWJlcl07XG5cbmV4cG9ydCBmdW5jdGlvbiBkZWZhdWx0U3R5bGVHdWlkZSgpOiBTdHlsZVNlY3Rpb25bXSB7XG4gIHJldHVybiBbXG4gICAge1xuICAgICAga2V5OiBcInVuZGVyc3RhbmRpbmdcIixcbiAgICAgIGxhYmVsOiBcIlVuZGVyc3RhbmRpbmdcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJkaXJlY3Rpb25cIixcbiAgICAgIGxhYmVsOiBcIkRpcmVjdGlvblwiLFxuICAgICAgc3RhdHVzOiBcImVtcHR5XCIsXG4gICAgICBjb250ZW50OiBcIlwiLFxuICAgICAgcHJvbXB0czogW10sXG4gICAgICBjb2xvcnM6IFtdLFxuICAgIH0sXG4gICAge1xuICAgICAga2V5OiBcInBhbGV0dGVcIixcbiAgICAgIGxhYmVsOiBcIlBhbGV0dGVcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJjb25zaXN0ZW5jeVwiLFxuICAgICAgbGFiZWw6IFwiQ29uc2lzdGVuY3lcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJwcm9tcHRzXCIsXG4gICAgICBsYWJlbDogXCJSZS1jYXN0IHByb21wdHNcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJjYW5vbmljYWxcIixcbiAgICAgIGxhYmVsOiBcIkNhbm9uaWNhbCBpbWFnZXNcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICBdO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGVmYXVsdFN0YXRlKHRpdGxlOiBzdHJpbmcsIGludGVudDogc3RyaW5nKTogR2xhbW91clN0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICB0aXRsZSxcbiAgICBpbnRlbnQsXG4gICAgbGlicmFyeTogW10sXG4gICAgc2VsZWN0ZWRJZHM6IFtdLFxuICAgIG1lc3NhZ2VzOiBbXSxcbiAgICBzdHlsZUd1aWRlOiBkZWZhdWx0U3R5bGVHdWlkZSgpLFxuICAgIHRyYXk6IFtdLFxuICAgIHNjb3BlOiBcImFsbFwiLFxuICAgIGZvY3VzU2V0OiBbXSxcbiAgICBmb2N1c093bmVyOiBudWxsLFxuICAgIGZvY3VzTm90ZTogXCJcIixcbiAgICBzdGF0dXM6IHsgYnVzeTogZmFsc2UsIHRleHQ6IFwiXCIgfSxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgdHdvIHByaW1pdGl2ZXMgdW5kZXIgQk9USCBvZiB0aGUgaG91c2UncyBkYWVtb24tZGlzY292ZXJ5IGNvbnZlbnRpb25zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogRDMgcnVsZWQgdGhhdCB0aGUgY29udmVudGlvbnMgdGhlbXNlbHZlcyDigJQgcGVyLXNlc3Npb24gdG1wZGlyIEpTT04gKGJvdW50eSxcbiAqIGdsYW1vdXIsIGltYWdvLCBtYWdwaWUpIGFuZCBzaW5nbGV0b24gYCRIT01FL2RhZW1vbi5wb3J0YCArIGBkYWVtb24ucGlkYFxuICogKGFzdHJvbGFiZSwgZ3JhcGV2aW5lLCBtaW5kLW1hcHBlcikg4oCUIGJvdGggc3Vydml2ZSwgYmVjYXVzZSB0aGV5IGVuY29kZVxuICogZ2VudWluZWx5IGRpZmZlcmVudCBtb2RlbHMgKGNvbmN1cnJlbnQgc2Vzc2lvbnMgdnMgYSBzdGFuZGluZyBzaW5nbGV0b24pIGFuZFxuICogcGlja2luZyBvbmUgaXMgYSBwcm9kdWN0IGRlY2lzaW9uLCBub3QgYSBmYWN0b3Jpbmcgb25lLiBXaGF0IElTIG9uZVxuICogaW1wbGVtZW50YXRpb24gaXMgdGhlIHBhaXIgYmVsb3csIHdoaWNoIGlzIGFsc28gZXhhY3RseSB3aGVyZSBjZW5zdXMgZGVmZWN0XG4gKiAqKkwzKiogbGl2ZXMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCByZW5hbWVTeW5jLCBybVN5bmMsIHVubGlua1N5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuXG4vKipcbiAqIFdyaXRlIGB0ZXh0YCB0byBgdGFyZ2V0YCBhdG9taWNhbGx5OiB3cml0ZSBiZXNpZGUgaXQsIHRoZW4gcmVuYW1lLlxuICpcbiAqIOKblCAqKkwzLCBDTE9TRUQgQlkgQ09OU1RSVUNUSU9OLioqIEEgYmFyZSBgd3JpdGVGaWxlU3luY2AgaXMgbm90IGF0b21pYywgc28gYVxuICogQ0xJIHJlYWRpbmcgd2hpbGUgdGhlIGRhZW1vbiB3cml0ZXMgY2FuIG9ic2VydmUgYSBIQUxGLVdSSVRURU4gcG9pbnRlci4gVW5kZXJcbiAqIGEgYmVzdC1lZmZvcnQgcmVhZGVyIHRoYXQgc3VyZmFjZWQgYXMgXCJubyBydW5uaW5nIHNlc3Npb25cIiDigJQgYWJzZW5jZSByZXBvcnRlZFxuICogZm9yIHdoYXQgd2FzIHJlYWxseSBhIHRvcm4gcmVhZCwgd2hpY2ggaXMgdGhlIGV4YWN0IGNvbmZsYXRpb24gdGhlIGhvdXNlJ3NcbiAqIGBudWxsYC1ub3QtYDBgIHJ1bGUgZXhpc3RzIHRvIHByZXZlbnQuIFJlbmFtZSB3aXRoaW4gb25lIGRpcmVjdG9yeSBpcyBhdG9taWMsXG4gKiBzbyBhIHJlYWRlciBzZWVzIGVpdGhlciB0aGUgcHJldmlvdXMgcG9pbnRlciBvciB0aGUgbmV3IG9uZSwgbmV2ZXIgYSBwYXJ0aWFsXG4gKiBmaWxlLlxuICpcbiAqIEZpeGVkIGluIGdsYW1vdXIgMjAyNi0wOS0wNywgZm91bmQgc3RhbmRpbmcgaW4gdGhyZWUgc2libGluZ3MgdGhlIG5leHQgZGF5IGJ5XG4gKiB0aGUgZHVwbGljYXRpb24gcmVjb24sIGFuZCByZXBhaXJlZCBpbiBhbGwgb2YgdGhlbSB0aGUgb25seSB3YXkgdGhhdCBkb2VzIG5vdFxuICogbmVlZCBmaW5kaW5nIGFnYWluOiB0aGVyZSBpcyBub3cgb25lIGltcGxlbWVudGF0aW9uLlxuICpcbiAqIOKaoCBUaGUgdGVtcCBuYW1lIGNhcnJpZXMgdGhlIHBpZCwgc28gdHdvIGRhZW1vbnMgcmFjaW5nIHRvIHB1Ymxpc2ggdGhlIHNhbWVcbiAqIHBvaW50ZXIgY2Fubm90IGNsb2JiZXIgZWFjaCBvdGhlcidzIGludGVybWVkaWF0ZSBmaWxlIOKAlCBhbmQgaXQgaXMgcmVtb3ZlZCBvblxuICogYSBmYWlsZWQgd3JpdGUgcmF0aGVyIHRoYW4gbGVmdCBhcyBsaXR0ZXIgYmVzaWRlIHRoZSByZWFsIG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlRmlsZUF0b21pYyh0YXJnZXQ6IHN0cmluZywgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHRtcCA9IGAke3RhcmdldH0uJHtwcm9jZXNzLnBpZH0udG1wYDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKHRtcCwgdGV4dCk7XG4gICAgcmVuYW1lU3luYyh0bXAsIHRhcmdldCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRyeSB7XG4gICAgICBybVN5bmModG1wLCB7IGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogdGhlIHRlbXAgZmlsZSBpcyBhbHJlYWR5IGdvbmUsIG9yIHdhcyBuZXZlciBjcmVhdGVkICovXG4gICAgfVxuICAgIHRocm93IGVycjtcbiAgfVxufVxuXG4vKipcbiAqIERlbGV0ZSBgcGF0aGAgaWZmIGl0IHN0aWxsIG5hbWVzIFVTLiBSZXR1cm5zIHdoZXRoZXIgaXQgd2FzIGRlbGV0ZWQuXG4gKlxuICog4puUICoqXCJTVElMTCBPVVJTXCIgSVMgVEhFIFdIT0xFIEZVTkNUSU9OLioqIEEgZGFlbW9uIHRoYXQgdW5saW5rcyBpdHMgZGlzY292ZXJ5XG4gKiBmaWxlIHVuY29uZGl0aW9uYWxseSBhdCBleGl0IGRlbGV0ZXMgdGhlIHBvaW50ZXIgYSBTVUNDRVNTT1IgaGFzIGFscmVhZHlcbiAqIHdyaXR0ZW4g4oCUIHRoZSBzdWNjZXNzb3IgY2FuIHRoZW4gbm8gbG9uZ2VyIGJlIGZvdW5kIGFuZCB0aGUgbmV4dCBDTEkgdmVyYiBzcGF3bnMgYVxuICogdGhpcmQgZGFlbW9uLiBCb3RoIGNvbnZlbnRpb25zIGhhdmUgdGhpcyBoYXphcmQgYW5kIGJvdGggZXhwcmVzcyBpdFxuICogZGlmZmVyZW50bHk6IGFzdHJvbGFiZSBjb21wYXJlcyB0aGUgcGlkIGZpbGUncyBieXRlcyB0byBpdHMgb3duIHBpZCxcbiAqIG1hZ3BpZSBwYXJzZXMgdGhlIEpTT04gcG9pbnRlciBhbmQgY29tcGFyZXMgYHNlc3Npb25faWRgLiBgaWRlbnRpZnlgIGlzIHdoYXRcbiAqIG1ha2VzIHRob3NlIG9uZSBmdW5jdGlvbiDigJQgaXQgdHVybnMgdGhlIGZpbGUncyBieXRlcyBpbnRvIHRoZSBpZGVudGl0eSB0b1xuICogY29tcGFyZSwgYW5kIGl0IGRlZmF1bHRzIHRvIHRoZSB0cmltbWVkIGJ5dGVzIHRoZW1zZWx2ZXMuXG4gKlxuICog4pqgIEV2ZXJ5IGZhaWx1cmUgaXMgc3dhbGxvd2VkIGFuZCByZXBvcnRlZCBhcyBgZmFsc2VgOiB0aGUgZmlsZSBiZWluZyBnb25lLFxuICogdW5yZWFkYWJsZSwgb3IgdW5wYXJzZWFibGUgYWxsIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZSDigJQgaXQgaXMgbm90IG91cnMgdG9cbiAqIHJlbW92ZS4gQW4gdW5wYXJzZWFibGUgcG9pbnRlciBpcyBkZWxpYmVyYXRlbHkgTk9UIHRyZWF0ZWQgYXMgb3Vycywgd2hpY2ggaXNcbiAqIHRoZSBjb25zZXJ2YXRpdmUgaGFsZiBvZiB0aGUgc2FtZSBgbnVsbGAtbm90LWAwYCBydWxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdW5saW5rSWZNYXRjaGVzKFxuICBwYXRoOiBzdHJpbmcsXG4gIGV4cGVjdGVkOiBzdHJpbmcsXG4gIGlkZW50aWZ5OiAocmF3OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGwgPSAocmF3KSA9PiByYXcudHJpbSgpLFxuKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGlkZW50aWZ5KHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpICE9PSBleHBlY3RlZCkgcmV0dXJuIGZhbHNlO1xuICAgIHVubGlua1N5bmMocGF0aCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBpbi1wcm9jZXNzIGV2ZW50IGxvZyDigJQgdGhlIGFwcGVuZC1vbmx5LCByZXBsYXlhYmxlIGJ1ZmZlclxuICogYmVoaW5kIGV2ZXJ5IHNwZWxsJ3MgYEdFVCAvZXZlbnRzYCBTU0UgdGFpbC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzXG4gKiBgc2NyaXB0cy9ldmVudHMudHNgIOKAlCB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMyLCBhbmQgdGhlIG9ubHkgb25lIG9mXG4gKiB0aGUgc2l4IGNvcGllZC1pbi1wbGFjZSBidXNlcyB0aGF0IGlzIGEgbW9kdWxlLCBpcyBib3VuZGVkLCBjYXJyaWVzIGFuIGVwb2NoLCBhbmQgaXNcbiAqIHVuaXQtdGVzdGVkLiBUaGUgZml2ZSBvdGhlcnMgYXJlIHRoZSBzYW1lIHR3ZW50eSBsaW5lcyB3cml0dGVuIGZpdmUgdGltZXMuXG4gKlxuICog4pSA4pSAIFRIRSBUSFJFRSBUSElOR1MgVEhJUyBGSVhFUyDigJQgVFdPIEJZIENPTlNUUlVDVElPTiwgT05FIEJZIE9QVC1JTiDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiDim5QgVEhFIEhFQURJTkcgVVNFRCBUTyBTQVkgXCJUSEUgVEhSRUUgVEhJTkdTIFRISVMgRklYRVMgQlkgQ09OU1RSVUNUSU9OXCIgQU5EXG4gKiBJVEVNIDIgSVMgTk9UIE9ORSBPRiBUSEVNLiBDb3JyZWN0ZWQgMjAyNi0wOS0wOSBpbiBtaW5kLW1hcHBlcidzIHByZS13b3JrXG4gKiAoRDc5KTogYGVwb2NoYCBpcyBPUFRJT05BTCBoZXJlLCBzbyBMNiBpcyBjbG9zZWQgb25seSBmb3IgYSBjYWxsZXIgdGhhdCBhc2tzLlxuICogVGhyZWUgYWRvcHRlcnMgaGF2ZSBzaW5jZSBkZWNsaW5lZCB0byDigJQgaW1hZ28gKEQzOSksIGJvdW50eSAoRDQ4KSBhbmRcbiAqIGdyYXBldmluZSAoRDcwKSDigJQgc28gdGhlIGRlZmVjdCB0aGUgaGVhZGluZyBjbGFpbWVkIHRvIG1ha2UgaW1wb3NzaWJsZSBpc1xuICogbGl2ZSBpbiB0aGUgdHJlZSwgYnkgb3B0LW91dCwgYW5kIHRoZSBvdmVyY2xhaW0gaXMgd2hhdCBoaWQgdGhhdC4gSXRlbXMgMSBhbmRcbiAqIDMgQVJFIGJ5IGNvbnN0cnVjdGlvbjogYSBjYWxsZXIgY2Fubm90IHN3aXRjaCB0aGUgY2FwIG9mZiBvciByZWFjaCB0aGUgYnVmZmVyLlxuICpcbiAqIOKaoCBBTkQgTUlORC1NQVBQRVInUyBPV04gQlVTLCBXSElDSCBUSElTIE1PRFVMRSBDT05WRVJHRUQgVE9XQVJELCBUWVBFUyBUSEVcbiAqIEVQT0NIIEFTIFJFUVVJUkVEIGFuZCBzdGFtcHMgaXQgdW5jb25kaXRpb25hbGx5IOKAlCBpdCBpcyB0aGUgc3BlbGwgY2Vuc3VzIEw2XG4gKiBuYW1lcyBhcyBDT1JSRUNULiBNYWtpbmcgaXQgcmVxdWlyZWQgSEVSRSBpcyBub3QgdGhlIHJlcGFpcjogaXQgd291bGQgcmV2ZXJzZVxuICogRDM5LCBENDggYW5kIEQ3MC4gVGhlIGhvbmVzdCBzdGF0ZW1lbnQgaXMgdGhpcyBoZWFkaW5nLlxuICpcbiAqIOKblCAqKlJFU09MVkVEIEFUIFRIQVQgU1BFTEwnUyBQT1JULCBBTkQgVEhFIERJU1BPU0lUSU9OIElTIFJFQ09SREVEIEhFUkVcbiAqIEJFQ0FVU0UgQSBMT1NTIFRIQVQgTElWRVMgT05MWSBJTiBBIEpPVVJOQUwgSVMgQSBMT1NTIE5PQk9EWSBDQU4gU0VFXG4gKiAoRDc5L0Q4NSkuKiogbWluZC1tYXBwZXIgYWRvcHRlZCB0aGlzIG1vZHVsZSBpbiBQaGFzZSA3IGFuZCBrZXB0IGl0c1xuICogZ3VhcmFudGVlIFdJVEhPVVQgQSBLSVQgQ0hBTkdFOiBpdCBwYXNzZXMgYHsgZXBvY2g6IGNyeXB0by5yYW5kb21VVUlEKCkgfWAgYXRcbiAqIGl0cyBPTkUgY29uc3RydWN0aW9uIHNpdGUgYW5kIHJlLXRpZ2h0ZW5zIGBlcG9jaGAgdG8gUkVRVUlSRUQgaW4gaXRzIG93blxuICogbG9jYWwgZnJhbWUgdHlwZSwgc28gbm90aGluZyBpdHMgYnVzIGVtaXRzIGNhbiBsYWNrIG9uZS4gS2l0IGJ5dGVzOiB6ZXJvLlxuICogKipTbyB0aGUgZXBvY2ggaXMgYSBMT1NTWS1DT1BZIHByb3BlcnR5IHdob3NlIGRpc3Bvc2l0aW9uIGlzIEtFRVAtTE9DQUwsIG5vdFxuICogUkVTVE9SRSoqIOKAlCB0aGUgb25seSBwcm9wZXJ0eSBvZiB0aGF0IHNwZWxsJ3Mgb3duIG1vZHVsZSB0aGlzIG1vZHVsZSBjb3VsZFxuICogbm90IGNhcnJ5IGFuZCBkaWQgbm90IG5lZWQgdG8uIEw2IGlzIENMT1NFRCBmb3IgdGhlIHR3byBzcGVsbHMgdGhhdCBhc2sgYW5kXG4gKiBPUEVOLCBieSBvcHQtb3V0LCBmb3IgdGhlIHRocmVlIHRoYXQgZGVjbGluZTsgdGhhdCBhc3ltbWV0cnkgaXMgdGhlIGhvbmVzdFxuICogc3RhdGUgYW5kIHRoaXMgaGVhZGluZyBpcyB3aGVyZSBpdCBpcyB3cml0dGVuLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgQURPUFRJT04gUkVOQU1FUyBBIEZJRUxEIE9OIEFOIEFET1BURVInUyBQVUJMSVNIRUQgV0lSRS4qKiBgaWRgXG4gKiBpcyBuYW1lZCBpbiBgRnJhbWU8VD5gIGFuZCBpbiB0aGUgZW1pdCBsaXRlcmFsIGJlbG93LCBzbyBhIHNwZWxsIHdob3NlIGJ1c1xuICogc3BlbGxlZCB0aGUgY3Vyc29yIGFueXRoaW5nIGVsc2UgcGF5cyBhIHJlbmFtZSBhdCBldmVyeSByZWFkZXIg4oCUIGZvclxuICogbWluZC1tYXBwZXIsIDE3MyBvY2N1cnJlbmNlcyBhY3Jvc3MgNSBzdXJmYWNlIGZpbGVzLCB+MjA5IGFjcm9zcyB+MzAgYmFja2VuZFxuICogZmlsZXMsIGV2ZXJ5IEpTT05MIGxpbmUgaXRzIGB0YWlsYCB3cml0ZXMgaW50byBhbiBhZ2VudCdzIHBpcGUsIGFuZCAodGhlIG9uZVxuICogbm9ib2R5IGNvdW50ZWQpIHRoZSBGSVhUVVJFIGluIGl0cyBvd24gYHRhaWwudGVzdC50c2AsIHdoaWNoIFdSSVRFUyB0aGVcbiAqIGVudmVsb3BlIHdoaWxlIHN0YW5kaW5nIGluIGZvciB0aGUgZGFlbW9uLiBUaGUgTkVTVElORyBpcyBub3QgZm9yY2VkIOKAlFxuICogYEZyYW1lPFQ+YCBpcyBnZW5lcmljLCBhbmQgbWluZC1tYXBwZXIga2VwdCBge2tpbmQsIHBheWxvYWR9YCBuZXN0ZWQgd2hlcmUgYWxsXG4gKiBmaXZlIGVhcmxpZXIgYWRvcHRlcnMgZmxhdHRlbiBieSBpZGlvbS4gKipBbiBpZGlvbSBmaXZlIHNpYmxpbmdzIHNoYXJlIGlzXG4gKiBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgY29udHJhY3QgdW50aWwgeW91IG9wZW4gdGhlIHR5cGUqKiAoRDgxLCBEODYpLlxuICpcbiAqICoqMSDCtyBMNSDigJQgdGhlIGJ1ZmZlciBpcyBib3VuZGVkLioqIEZpdmUgZGFlbW9ucyBhcHBlbmQgdG8gYW4gYXJyYXkgZm9yIHRoZVxuICogd2hvbGUgbGlmZSBvZiB0aGUgcHJvY2Vzcy4gVGhlIHdpbmRvdyBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogZGFlbW9uJ3MgbGlmZXRpbWUsIG5vdCBhIGR1cmFibGUgbG9nOyBhIGNhcCBpcyB0aGUgaG9uZXN0IHNoYXBlLlxuICpcbiAqICoqMiDCtyBMNiDigJQgYSBmcmFtZSBjYXJyaWVzIGFuIGVwb2NoLCBXSEVOIFRIRSBDQUxMRVIgQVNLUyBGT1IgT05FIChvcHQtaW4sXG4gKiBub3QgY29uc3RydWN0aW9uIOKAlCBzZWUgYWJvdmUpLioqIEFmdGVyIGEgcmVzdGFydCB0aGUgaWRzIHN0YXJ0IGFnYWluIGF0IDEsIHNvXG4gKiBhIHJlc3VtaW5nIGNsaWVudCBjYW5ub3QgdGVsbCBhIHN0YWxlIHdhdGVybWFyayBmcm9tIGEgZnJlc2ggb25lIGJ5IGlkIGFsb25lLlxuICpcbiAqICoqMyDCtyBBIFNUQUxFIFdBVEVSTUFSSyBSRVBMQVlTIEZST00gVEhFIEJFR0lOTklORywgYW5kIHRoaXMgaXMgdGhlIGhhbGYgdGhlXG4gKiBjbGllbnQgY2Fubm90IGRvLioqIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogYSB0YWlsIHRoYXQgcmVzdW1lcyBhdFxuICogYHNpbmNlPTxsYXN0IGlkIG9mIHRoZSBwcmV2aW91cyBkYWVtb24+YCBhZ2FpbnN0IGEgcmVzdGFydGVkIGRhZW1vbiByZWNlaXZlc1xuICogTk9USElORyDigJQgdGhlIG5ldyBkYWVtb24ncyBgcmVhZHlgIGlzIGlkIDEsIHdoaWNoIGlzIG5vdCBgPiBzaW5jZWAsIHNvIHRoZVxuICogZmlsdGVyIGRyb3BzIGl0LCBzbyBubyBmcmFtZSBhcnJpdmVzLCBzbyB0aGUgY2xpZW50J3MgZXBvY2ggY2hlY2sgbmV2ZXIgcnVuc1xuICogYW5kIHRoZSB0YWlsIHNpdHMgY29ubmVjdGVkIGFuZCBzaWxlbnQgdW50aWwgdGhlIG5ldyBkYWVtb24gaGFzIGVtaXR0ZWQgYXNcbiAqIG1hbnkgZXZlbnRzIGFzIHRoZSBvbGQgb25lIGRpZC4gU3RhbXBpbmcgYW4gZXBvY2ggYWxvbmUgZG9lcyBOT1QgY2xvc2UgdGhhdFxuICogZ2FwOiB0aGUgZXBvY2ggcmlkZXMgYSBmcmFtZSwgYW5kIHRoZSBidWcgaXMgdGhhdCBubyBmcmFtZSBpcyBzZW50LiBTb1xuICogYHN1YnNjcmliZWAgdHJlYXRzIGBzaW5jZSA+IGN1cnNvcmAgYXMgXCJ0aGlzIGN1cnNvciBpcyBmcm9tIGFub3RoZXIgcHJvY2Vzc1wiXG4gKiBhbmQgcmVwbGF5cyB3aG9sZS4gYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3RhaWwudGVzdC50c2AncyBlcG9jaCBjZWxsIGlzIHRoZVxuICogZXhlY3V0YWJsZSBzcGVjIG9mIHRoZSBjbGllbnQgaGFsZiBhbmQgc2hvd3MgdGhlIHJlY29ubmVjdCBzdGlsbCBjYXJyeWluZyB0aGVcbiAqIHN0YWxlIGN1cnNvciDigJQgZGV0ZWN0aW9uIGhhcHBlbnMgb24gd2hhdCBpcyBSRUNFSVZFRC5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBET0VTIE5PVCBBRE9QVCBUSElTLCBBTkQgVEhFIFJFRlVTQUwgSVMgUEFSVCBPRiBUSEUgUlVMSU5HIOKUgOKUgFxuICpcbiAqIFJFSkVDVC1TVFJVQ1RVUkFMLCBydWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLiBOb3RcbiAqIFwibm8gc3ViamVjdFwiIOKAlCBncmFwZXZpbmUgSEFTIGFuIGV2ZW50IGJ1cyBhbmQgaXQgaXMgdGhlIGJ1c2llc3QgdGhpbmcgaW4gdGhlXG4gKiBzcGVsbCDigJQgYnV0IHRoZSB0d28gc2hhcGVzIGNhbm5vdCBiZSBjb25zdHJ1Y3RlZCBmcm9tIGVhY2ggb3RoZXI6XG4gKlxuICogICB0aGlzIG1vZHVsZSAgb25lIHByb2Nlc3Mtd2lkZSBhcnJheSBjYXBwZWQgYXQgUkVQTEFZX0JVRkZFUl9TSVpFLCB3aXRoIG9uZVxuICogICAgICAgICAgICAgICAgbW9ub3RvbmljIGBzZXFgLCBhbmQgdGhlIGhlYWRlciB0aHJlZSBwYXJhZ3JhcGhzIHVwIHNheXMgaW4gYXNcbiAqICAgICAgICAgICAgICAgIG1hbnkgd29yZHMgdGhhdCBpdCBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogICAgICAgICAgICAgICAgZGFlbW9uJ3MgbGlmZXRpbWUsIE5PVCBhIGR1cmFibGUgbG9nLlxuICogICBncmFwZXZpbmUgICAgTiBkdXJhYmxlIGFwcGVuZC1vbmx5IGAuanNvbmxgIGZpbGVzLCBvbmUgcGVyIG5hbWVkIGNoYW5uZWwsXG4gKiAgICAgICAgICAgICAgICBlYWNoIHdpdGggaXRzIG93biBgbmV4dF9pZGAsIHJlcGxheWVkIGZyb20gZGlzayBieVxuICogICAgICAgICAgICAgICAgYHJlYWRCYWNrbG9nYCwgc3Vydml2aW5nIHJlc3RhcnQsIGByb2xsYCwgYXJjaGl2ZSBhbmQgY2xlYXIuXG4gKlxuICogKipUaGUgcmVhZGVyIHRoYXQgbWFrZXMgdGhlbSBpbmNvbXBhdGlibGUsIGFzIGEgbWVhc3VyZW1lbnQgcmF0aGVyIHRoYW4gYW5cbiAqIGFzc2VydGlvbjoqKiBncmFwZXZpbmUncyBgbG9hZENoYW5uZWwoKWAgZGVyaXZlcyBgbmV4dF9pZGAgYXMgYSBISUdILVdBVEVSXG4gKiBNQVJLIG92ZXIgZXZlcnkgcGFyc2VhYmxlIGxpbmUgb2YgdGhlIGNoYW5uZWwncyBmaWxlIG9uIGJvb3QuIFRoZXJlIGlzIG5vXG4gKiBhcnJheSB0byBiZSB0aGF0IG1hcmsgb2YsIGFuZCBubyBjYXAgdGhhdCB3b3VsZCBub3Qgc2lsZW50bHkgZGlzY2FyZCBoaXN0b3J5XG4gKiBhIGNhbGxlciBjYW4gc3RpbGwgYXNrIGZvciBieSBpZC4gSXQgaXMgdGhlIHRoaW5nIHRoaXMgbW9kdWxlJ3Mgb3duIGhlYWRlclxuICogc2F5cyBpdCBpcyBkZWxpYmVyYXRlbHkgbm90LlxuICpcbiAqICoqVGhlIHdpZGVuaW5nIE5PVCBkb25lLCB3aXRoIGl0cyBjb3N0OioqIGFkbWl0dGluZyBhIHBlci1jaGFubmVsIGR1cmFibGVcbiAqIHN0b3JlIHdvdWxkIGNoYW5nZSBgY3JlYXRlRXZlbnRMb2dgJ3Mgc3RvcmFnZSBhbmQgaXRzIGBzdWJzY3JpYmVgIGNvbnRyYWN0IGZvclxuICogZml2ZSBvdGhlciBkYWVtb25zLCByZS1lbWl0dGluZyBTSVggYXJ0aWZhY3RzIGFjcm9zcyBGSVZFIHNwZWxscywgZWFjaCBvd2VkIGFcbiAqIGRyaXZlIOKAlCBwYWlkIGJ5IHBvcnRzIHRoYXQgYXJlIGFscmVhZHkgZmluaXNoZWQgYW5kIGJ5IGFnZW50cyBub3QgaW4gdGhlIHJvb20uXG4gKiBBIHdpZGVuaW5nIHJlbWFpbnMgYXZhaWxhYmxlIGFzIGl0cyBvd24gYXJndWVkIGRlY2lzaW9uIHdpdGggaXRzIG93blxuICogYmxhc3QtcmFkaXVzIGNvdW50OyBpdCBpcyBuZXZlciBhIHN0ZXAgaW5zaWRlIGEgcG9ydC5cbiAqXG4gKiDimqAgQU5EIFRIRSBgZXBvY2hgIEFCT1ZFIElTIFRIRSBTSEFSUEVTVCBIQUxGIE9GIFdIWSAoRDcwKS4gR3JhcGV2aW5lJ3MgaWRzIGFyZVxuICogUkVDT1ZFUkVEIGFjcm9zcyBhIHJlc3RhcnQsIHNvIHRoZSBjb25kaXRpb24gcGFyYWdyYXBoIDIgZGVzY3JpYmVzIOKAlCBpZHNcbiAqIHN0YXJ0aW5nIGFnYWluIGF0IDEg4oCUIGNhbm5vdCBvY2N1ciB0aGVyZSwgYW5kIHN0YW1waW5nIG9uZSBhbnl3YXkgaXMgbm90XG4gKiBpbmVydDogYHRhaWxFdmVudHNgJ3MgYG9uRXBvY2hDaGFuZ2VgIHNldHMgdGhlIGN1cnNvciB0byAwLCBhbmQgZ3JhcGV2aW5lJ3NcbiAqIHRhaWwgcm91dGUgYW5zd2VycyBgc2luY2U9MGAgd2l0aCB0aGUgV0hPTEUgY2hhbm5lbCBsb2cgb2ZmIGRpc2ssIGludG8gYW5cbiAqIGFnZW50J3MgcGlwZSwgb24gZXZlcnkgYHJvbGxgLiBUaGUgZXBvY2gncyBjbGllbnQtc2lkZSBhY3Rpb24gaXMgXCJ5b3VyIGN1cnNvclxuICogaXMgd29ydGhsZXNzLCBzdGFydCBvdmVyXCIsIGFuZCB0aGF0IGlzIHNhZmUgb25seSB3aGVyZSBzdGFydGluZyBvdmVyIGNvc3RzIGFcbiAqIGJvdW5kZWQgaW4tbWVtb3J5IHJlcGxheSB3aW5kb3cuXG4gKi9cblxuLyoqIFRoZSBkZWZhdWx0IHJlcGxheSB3aW5kb3csIGluaGVyaXRlZCBmcm9tIG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgY2FwLiAqL1xuZXhwb3J0IGNvbnN0IFJFUExBWV9CVUZGRVJfU0laRSA9IDEwMDA7XG5cbi8qKiBBIGZyYW1lIGFzIGl0IGdvZXMgb24gdGhlIHdpcmU6IHRoZSBjYWxsZXIncyBwYXlsb2FkIHBsdXMgYSBtb25vdG9uaWMgYGlkYCxcbiAqICBwbHVzIGFuIGBlcG9jaGAgd2hlbiB0aGUgbG9nIHdhcyBnaXZlbiBvbmUuICovXG5leHBvcnQgdHlwZSBGcmFtZTxUPiA9IFQgJiB7IGlkOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH07XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRMb2c8VD4ge1xuICAvKiogQXBwZW5kIG9uZSBmcmFtZSwgZmFuIGl0IG91dCB0byBsaXZlIHN1YnNjcmliZXJzLCBhbmQgcmV0dXJuIGl0LiAqL1xuICBlbWl0KG1zZzogVCk6IEZyYW1lPFQ+O1xuICAvKipcbiAgICogUmVwbGF5IGV2ZXJ5dGhpbmcgYWZ0ZXIgYHNpbmNlYCwgdGhlbiBzdGF5IHN1YnNjcmliZWQuIFJldHVybnMgYW5cbiAgICogdW5zdWJzY3JpYmUgZnVuY3Rpb24uXG4gICAqXG4gICAqIOKblCBSRVBMQVkgQU5EIFNVQlNDUklCRSBBUkUgT05FIENBTEwgT04gUFVSUE9TRS4gRG9pbmcgdGhlbSBpbiB0d28gc3RlcHNcbiAgICogbGVhdmVzIGEgd2luZG93IGluIHdoaWNoIGFuIGVtaXQgbGFuZHMgYmV0d2VlbiB0aGUgcmVwbGF5IGxvb3AgYW5kIHRoZVxuICAgKiBgYWRkYCwgYW5kIHRoYXQgZnJhbWUgaXMgZGVsaXZlcmVkIHRvIG5vYm9keSDigJQgdGhlIHNoYXBlIGZpdmUgZGFlbW9ucyBoYXZlLFxuICAgKiBzdXJ2aXZlZCBieSBub3RoaW5nIGJ1dCB0aGUgc2luZ2xlLXRocmVhZGVkIGV2ZW50IGxvb3AgaGFwcGVuaW5nIHRvIGNsb3NlXG4gICAqIGl0LiBEZXBlbmRpbmcgb24gdGhhdCBpcyBkZXBlbmRpbmcgb24gYW4gaW1wbGVtZW50YXRpb24gZGV0YWlsIG9mIHRoZVxuICAgKiBydW50aW1lIHJhdGhlciB0aGFuIG9uIHRoZSBjb2RlLlxuICAgKi9cbiAgc3Vic2NyaWJlKHNpbmNlOiBudW1iZXIsIGxpc3RlbmVyOiAoZnJhbWU6IEZyYW1lPFQ+KSA9PiB2b2lkKTogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBoaWdoZXN0IGlkIGVtaXR0ZWQgc28gZmFyIOKAlCB3aGF0IGBHRVQgL3N0YXRlYCByZXR1cm5zIGFzIGBjdXJzb3JgLiAqL1xuICBjdXJzb3IoKTogbnVtYmVyO1xuICAvKiogVGhlIGVwb2NoIHN0YW1wZWQgb24gZXZlcnkgZnJhbWUsIG9yIGB1bmRlZmluZWRgIGlmIG5vbmUgd2FzIGNvbmZpZ3VyZWQuICovXG4gIHJlYWRvbmx5IGVwb2NoOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVFdmVudExvZzxUIGV4dGVuZHMgb2JqZWN0PihcbiAgb3B0czogeyBlcG9jaD86IHN0cmluZzsgYnVmZmVyU2l6ZT86IG51bWJlciB9ID0ge30sXG4pOiBFdmVudExvZzxUPiB7XG4gIGNvbnN0IGJ1ZmZlclNpemUgPSBvcHRzLmJ1ZmZlclNpemUgPz8gUkVQTEFZX0JVRkZFUl9TSVpFO1xuICBjb25zdCBlcG9jaCA9IG9wdHMuZXBvY2g7XG4gIGNvbnN0IGJ1ZmZlcjogQXJyYXk8RnJhbWU8VD4+ID0gW107XG4gIGNvbnN0IGxpc3RlbmVycyA9IG5ldyBTZXQ8KGZyYW1lOiBGcmFtZTxUPikgPT4gdm9pZD4oKTtcbiAgbGV0IHNlcSA9IDA7XG5cbiAgcmV0dXJuIHtcbiAgICBlcG9jaCxcblxuICAgIGVtaXQobXNnKSB7XG4gICAgICBzZXEgKz0gMTtcbiAgICAgIC8vIOKblCBUSEUgTU9OT1RPTklDIElEIFdJTlMgT1ZFUiBBTllUSElORyBJTiBUSEUgUEFZTE9BRCwgQU5EIFVOVElMIE5PVyBJVFxuICAgICAgLy8gT05MWSBDTEFJTUVEIFRPLiBCb3RoIGFkb3B0aW5nIGRhZW1vbnMgd3JvdGUgYHsgaWQ6ICsrc2VxLCAuLi5tc2cgfWBcbiAgICAgIC8vIHVuZGVyIGEgY29tbWVudCBzYXlpbmcgXCJ0aGUgbW9ub3RvbmljIGBpZGAgTVVTVCB3aW4gb3ZlciBhbnkgYGlkYCBpblxuICAgICAgLy8gdGhlIHBheWxvYWQsIHNvIGNhbGxlcnMgY2FycnkgYSBwcm9qZWN0IGlkZW50aWZpZXIgYXMgYHByb2plY3RJZGAsXG4gICAgICAvLyBuZXZlciBgaWRgXCIg4oCUIGJ1dCBzcHJlYWQgb3JkZXIgbWVhbnMgYSBwYXlsb2FkIGBpZGAgb3ZlcnJvZGUgdGhlXG4gICAgICAvLyBjdXJzb3IsIHNpbGVudGx5LCBhbmQgdGhlIGNvbnZlbnRpb24gaW4gdGhlIGNvbW1lbnQgd2FzIHRoZSBvbmx5IHRoaW5nXG4gICAgICAvLyBob2xkaW5nIGl0LiBUaGUgbGl0ZXJhbCBrZWVwcyBgaWRgIEZJUlNUIHNvIHRoZSB3aXJlIGtleSBvcmRlciBpc1xuICAgICAgLy8gdW5jaGFuZ2VkOyB0aGUgYXNzaWdubWVudCBhZnRlciB0aGUgc3ByZWFkIGlzIHdoYXQgbWFrZXMgdGhlIHNlbnRlbmNlXG4gICAgICAvLyB0cnVlLiBgZXBvY2hgIGlzIHN0YW1wZWQgdGhlIHNhbWUgd2F5IGFuZCBmb3IgdGhlIHNhbWUgcmVhc29uLlxuICAgICAgY29uc3QgZnJhbWUgPSB7IGlkOiBzZXEsIC4uLm1zZyB9IGFzIEZyYW1lPFQ+O1xuICAgICAgZnJhbWUuaWQgPSBzZXE7XG4gICAgICBpZiAoZXBvY2ggIT09IHVuZGVmaW5lZCkgZnJhbWUuZXBvY2ggPSBlcG9jaDtcblxuICAgICAgYnVmZmVyLnB1c2goZnJhbWUpO1xuICAgICAgaWYgKGJ1ZmZlci5sZW5ndGggPiBidWZmZXJTaXplKSBidWZmZXIuc2hpZnQoKTtcbiAgICAgIGZvciAoY29uc3QgbGlzdGVuZXIgb2YgbGlzdGVuZXJzKSBsaXN0ZW5lcihmcmFtZSk7XG4gICAgICByZXR1cm4gZnJhbWU7XG4gICAgfSxcblxuICAgIHN1YnNjcmliZShzaW5jZSwgbGlzdGVuZXIpIHtcbiAgICAgIC8vIFNlZSB0aGUgaGVhZGVyLCBwb2ludCAzOiBhIGN1cnNvciBiZXlvbmQgb3VyIG93biBpcyBhIGN1cnNvciBmcm9tIGFcbiAgICAgIC8vIFBSSU9SIFBST0NFU1MsIGFuZCB0aGUgb25seSB1c2VmdWwgcmVhZGluZyBvZiBpdCBpcyBcInJlcGxheSB3aG9sZVwiLlxuICAgICAgLy9cbiAgICAgIC8vIOKaoCBBIE5PTi1GSU5JVEUgQ1VSU09SIEFMU08gTUVBTlMgXCJGUk9NIFRIRSBTVEFSVFwiLCB3aGljaCB0aGUgY29waWVzIGdvdFxuICAgICAgLy8gd3JvbmcgYnkgYWNjaWRlbnQ6IHRoZXkgd3JvdGUgYHBhcnNlSW50KHBhcmFtID8/IFwiLTFcIilgIGFuZCBjb21wYXJlZFxuICAgICAgLy8gYGlkID4gc2luY2VgLCBzbyBhIHR5cG8nZCBgP3NpbmNlPXhgIHByb2R1Y2VkIGBOYU5gLCBldmVyeSBjb21wYXJpc29uXG4gICAgICAvLyB3YXMgZmFsc2UsIGFuZCB0aGUgdGFpbCBvcGVuZWQgRU1QVFkgYW5kIHN0YXllZCBjb25uZWN0ZWQg4oCUIHRoZSBzYW1lXG4gICAgICAvLyBzaWxlbnQtYW5kLWNvbm5lY3RlZCBzeW1wdG9tIGFzIHRoZSBzdGFsZSB3YXRlcm1hcmssIGZyb20gYSBkaWZmZXJlbnRcbiAgICAgIC8vIGNhdXNlLiBBYnNlbnQgYW5kIHVucGFyc2VhYmxlIGFyZSB0aGUgc2FtZSByZXF1ZXN0IGhlcmUuXG4gICAgICBjb25zdCBmcm9tID0gIU51bWJlci5pc0Zpbml0ZShzaW5jZSkgfHwgc2luY2UgPiBzZXEgPyAtMSA6IHNpbmNlO1xuICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBidWZmZXIpIHtcbiAgICAgICAgaWYgKGZyYW1lLmlkID4gZnJvbSkgbGlzdGVuZXIoZnJhbWUpO1xuICAgICAgfVxuICAgICAgbGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG4gICAgICByZXR1cm4gKCkgPT4ge1xuICAgICAgICBsaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcbiAgICAgIH07XG4gICAgfSxcblxuICAgIGN1cnNvcigpIHtcbiAgICAgIHJldHVybiBzZXE7XG4gICAgfSxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgZGFlbW9uIGxpZmVjeWNsZSB0YWlsOiB0aGUgaWRsZS1jbG9zZSBkZWNpc2lvbiwgdGhlIHN3ZWVwXG4gKiB0aGF0IG1ha2VzIGl0LCBhbmQgdGhlIGJvdW5kZWQgdGVhcmRvd24uXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgYm91bnR5IOKAlCB0aGUgY2Vuc3VzJ3NcbiAqIGNvbnZlcmdlbmNlIHRhcmdldCAjMyDigJQgd2l0aCBhc3Ryb2xhYmUncyBgdGltZW91dE1zID4gMGAgZ3VhcmQgZm9sZGVkIGluLFxuICogd2hpY2ggaXMgdGhlIG9uZSB0aGluZyBib3VudHkncyBjb3B5IGRvZXMgbm90IGV4cHJlc3MuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgQURPUFRTIGBkcmFpbkFuZFN0b3BgIEFORCBOT1RISU5HIEVMU0UgSEVSRSDigJQgU1BMSVQgUEVSIEVYUE9SVFxuICpcbiAqIFJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCksIGFuZCBpdCBpcyB3cml0dGVuIGRvd25cbiAqIGJlY2F1c2UgYSByb3cgaXMgYSBNT0RVTEUgYW5kIFwicGFydGlhbFwiIGlzIG5vdCBhbiBhbnN3ZXIgdW50aWwgaXQgc2F5cyB3aGljaFxuICogZXhwb3J0cy4gR3JhcGV2aW5lIGlzIGxvbmctcnVubmluZywgc28gbm90aGluZyBhYm91dCBpdHMgbGlmZWN5Y2xlIG1ha2VzIHRoaXNcbiAqIG1vZHVsZSByZWFkIGFzIGluYXBwbGljYWJsZSDigJQgYW5kIHR3byBvZiBpdHMgdGhyZWUgZXhwb3J0cyBzdGlsbCBoYXZlIG5vXG4gKiBzdWJqZWN0IHRoZXJlOlxuICpcbiAqICAgYHNob3VsZElkbGVDbG9zZWAgICAgICBOTyBTVUJKRUNULiBHcmFwZXZpbmUgcnVucyBubyBpZGxlIHN3ZWVwIGFuZCBoYXMgbm9cbiAqICAgYHN0YXJ0SG91c2VrZWVwaW5nYCAgICBgLS10aW1lb3V0YDsgaXQgaXMgYSBicm9rZXIgdGhhdCBzdGFuZHMgdW50aWwgYHN0b3BgXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgKGBERUxFVEUgL2ApIG9yIGEgc2lnbmFsLCBhbmQgaXQgdGFrZXMgbm8gc25hcHNob3QuXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgQWRvcHRpbmcgdGhlIHBhaXItbWFuYWdlciB3b3VsZCBtZWFuIHdyaXRpbmcgYSBuby1vcFxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGB0b3VjaGAgYW5kIGEgYHN1YnNjcmliZXJDb3VudGAgdGhhdCBleGlzdHMgb25seSB0b1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBhIG51bWJlciBub2JvZHkgYWN0cyBvbiDigJQgdHdvIGxpZXMgdG8gZ2FpbiBhXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYGNsZWFySW50ZXJ2YWxgLlxuICogICBgZHJhaW5BbmRTdG9wYCAgICAgICAgIEFET1BURUQsIGFuZCBpdCBpcyBhIERFLURVUExJQ0FUSU9OIHJhdGhlciB0aGFuIGFcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBnYWluOiBncmFwZXZpbmUncyB0ZWFyZG93biBhbHJlYWR5IFdBU1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBQcm9taXNlLnJhY2UoW3NlcnZlci5zdG9wKHRydWUpLCAyMDAgbXNdKWAsIHdoaWNoIGlzXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYHN0b3BNc2AgZXhhY3RseS5cbiAqXG4gKiDimqAgKipBTkQgSVQgSVMgQ0FMTEVEIFdJVEggTk8gYGNsaWVudHNgLCBXSElDSCBJUyBBIE1FQVNVUkVNRU5ULCBOT1QgQU5cbiAqIE9WRVJTSUdIVC4qKiBUaGlzIG1vZHVsZSBjbG9zZXMgYSBoZWxkIGNvbm5lY3Rpb24gYnkgY2FsbGluZyBgY2xpZW50LmNsb3NlKClgO1xuICogZ3JhcGV2aW5lJ3Mgc3Vic2NyaWJlciByZWNvcmRzIGFyZSBge2FsaWFzLCBodW1hbiwgbHVyaywgc2VuZH1gIGFuZCBjYXJyeSBub1xuICogYGNsb3NlYCDigJQgaXRzIHBlci1zdHJlYW0gdGVhcmRvd24gaXMgYSBjbG9zdXJlIHN0YXNoZWQgb24gdGhlIFJlYWRhYmxlU3RyZWFtXG4gKiBjb250cm9sbGVyLCByZWFjaGFibGUgb25seSBmcm9tIGBjYW5jZWwoKWAuIFRoZXJlIGlzIG5vdGhpbmcgdG8gaGFuZCB0aGVcbiAqIGFyZ3VtZW50LiBgc3NlLnRzYCdzIGhlYWRlciBjYXJyaWVzIHRoZSByZXN0IG9mIHRoYXQgcnVsaW5nLCBpbmNsdWRpbmcgdGhlXG4gKiB3aWRlbmluZyBub3QgZG9uZSBhbmQgaXRzIGNvc3QgKHNpeCBhcnRpZmFjdHMgYWNyb3NzIGZpdmUgc3BlbGxzKS5cbiAqXG4gKiDimqAgR3JhcGV2aW5lIGFsc28gcGFzc2VzIGBncmFjZU1zOiAwYC4gTm90IGEgZGlzYWdyZWVtZW50IHdpdGggdGhlIGdyYWNlXG4gKiBwZXJpb2Q6IGl0IGVtaXRzIG5vIGZhcmV3ZWxsIGZyYW1lIGF0IGRhZW1vbiBzaHV0ZG93biwgYW5kIGl0cyBgREVMRVRFIC9gXG4gKiBhbHJlYWR5IHJldHVybnMgdGhlIHJlc3BvbnNlIGFuZCBzY2hlZHVsZXMgdGhlIHRlYXJkb3duIDEwIG1zIGxhdGVyLCBzbyBpdHNcbiAqIGZsdXNoIHdpbmRvdyBzaXRzIGF0IHRoZSByb3V0ZSByYXRoZXIgdGhhbiBpbiB0aGUgZHJhaW4uXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTc2VDbGllbnRzIH0gZnJvbSBcIi4vc3NlLnRzXCI7XG5cbi8qKlxuICogU2hvdWxkIHRoZSBkYWVtb24gaWRsZS1jbG9zZT9cbiAqXG4gKiDim5QgKipgc3Vic2NyaWJlckNvdW50YCBJUyBBIFJFUVVJUkVEIEFSR1VNRU5ULCBBTkQgVEhBVCBJUyBUSEUgV0hPTEUgUE9JTlQuKipcbiAqIFRoaXMgY2xvc2VzIGNlbnN1cyBkZWZlY3QgKipMMSoqIGJ5IGNvbnN0cnVjdGlvbjogZ2xhbW91ciwgaW1hZ28gYW5kIG1hZ3BpZVxuICogY291bnRlZCB0aGVpciBpZGxlIGZsb29yIGRvd24gd2hpbGUgYW4gYWdlbnQgaGVsZCBhIHRhaWwgb3Blbiwgc28gYW4gYWdlbnRcbiAqIHdhdGNoaW5nIGEgcXVpZXQgYm9hcmQgd2FzIGtpbGxlZCBXSVRIIElUUyBDT05ORUNUSU9OIE9QRU4uIFRoZXJlIGlzIG5vXG4gKiBvdmVybG9hZCBvZiB0aGlzIGZ1bmN0aW9uIHRoYXQgY2Fubm90IHNlZSBpdHMgc3Vic2NyaWJlcnMsIHNvIHRoZSBkZWZlY3RcbiAqIGNhbm5vdCBiZSByZS1leHByZXNzZWQgYnkgYSBjYWxsZXIgd2hvIGZvcmdldHMuXG4gKlxuICog4puUICoqQU5EIFRIRSBTQ0FSIElUIENBTUUgV0lUSCwgcmUtaG9tZWQgZnJvbSBib3VudHkgdmVyYmF0aW0gaW4gc3Vic3RhbmNlOioqXG4gKiBhIGJvYXJkIG9ubHkgY291bnRzIGl0cyBpZGxlIGZsb29yIGRvd24gd2hpbGUgVU5XQVRDSEVELiBBIGxpdmUgc3Vic2NyaWJlciDigJRcbiAqIGEgYnJvd3NlciBXZWJTb2NrZXQsIG9yIGFuIGFnZW50IFNTRSB0YWlsIG9uIGAvZXZlbnRzYCDigJQga2VlcHMgaXQgb3BlblxuICogaW5kZWZpbml0ZWx5LiBTbyBgdGltZW91dGAgbWVhbnMgXCJsaW5nZXIgdGhpcyBsb25nIGFmdGVyIHRoZSBMQVNUIHN1YnNjcmliZXJcbiAqIGxlYXZlc1wiLCBOT1QgXCJtYXhpbXVtIGlkbGUgd2hpbGUgY29ubmVjdGVkXCIuIFRoZSBzd2VlcCBiZWxvdyBhbHNvIHRvdWNoZXMgdGhlXG4gKiBhY3Rpdml0eSBjbG9jayBvbiBldmVyeSB0aWNrIHdoaWxlIHdhdGNoZWQsIHNvIG9uY2UgdW53YXRjaGVkIHRoZSBmbG9vclxuICogY291bnRzIGZyb20gdGhhdCBsYXN0IGRpc2Nvbm5lY3QgYW5kIG5vdCBmcm9tIHRoZSBsYXN0IHJlcXVlc3QuXG4gKlxuICog4pqgIGB0aW1lb3V0TXMgPD0gMGAgbWVhbnMgTkVWRVIsIHdoaWNoIGlzIGFzdHJvbGFiZSdzIHN0YW5kaW5nLW9ic2VydmF0b3J5XG4gKiBkZWZhdWx0IGFuZCBpcyB3aHkgdGhlIGd1YXJkIGlzIGhlcmUgcmF0aGVyIHRoYW4gYXQgaXRzIG9uZSBjYWxsIHNpdGU6IGFcbiAqIHNpbmdsZXRvbiBkYWVtb24gaXMgbWVhbnQgdG8gc3RhbmQgdW50aWwgaXQgaXMgZXhwbGljaXRseSBjbG9zZWQsIGFuZCBhXG4gKiBgPj0gMGAgY29tcGFyaXNvbiB3b3VsZCBjbG9zZSBpdCBvbiB0aGUgZmlyc3QgdGljay5cbiAqXG4gKiBDbG9jay1mcmVlIGFuZCBmcy1mcmVlLCBzbyBpdCBpcyB0ZXN0YWJsZSB3aXRob3V0IGEgZGFlbW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkSWRsZUNsb3NlKFxuICBzdWJzY3JpYmVyQ291bnQ6IG51bWJlcixcbiAgaWRsZU1zOiBudW1iZXIsXG4gIHRpbWVvdXRNczogbnVtYmVyLFxuKTogYm9vbGVhbiB7XG4gIGlmICh0aW1lb3V0TXMgPD0gMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoc3Vic2NyaWJlckNvdW50ID4gMCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaWRsZU1zID49IHRpbWVvdXRNcztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBIb3VzZWtlZXBpbmdPcHRpb25zIHtcbiAgLyoqIOKblCBSRVFVSVJFRC4gU2VlIGBzaG91bGRJZGxlQ2xvc2VgIOKAlCB0aGlzIGlzIHdoYXQgY2xvc2VzIEwxLiAqL1xuICBzdWJzY3JpYmVyQ291bnQ6ICgpID0+IG51bWJlcjtcbiAgLyoqIE1pbGxpc2Vjb25kcyBzaW5jZSB0aGUgbGFzdCBhY3Rpdml0eS4gKi9cbiAgaWRsZU1zOiAoKSA9PiBudW1iZXI7XG4gIC8qKiBSZXNldCB0aGUgYWN0aXZpdHkgY2xvY2suIENhbGxlZCBvbiBldmVyeSB0aWNrIHRoYXQgaGFzIGEgc3Vic2NyaWJlci4gKi9cbiAgdG91Y2g6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgY29uZmlndXJlZCBpZGxlIHRpbWVvdXQgaW4gbXM7IGAwYCAob3IgbGVzcykgbWVhbnMgbmV2ZXIuICovXG4gIHRpbWVvdXRNczogbnVtYmVyO1xuICAvKiogRmlyZWQgb25jZSB3aGVuIHRoZSBkYWVtb24gc2hvdWxkIGNsb3NlIGl0c2VsZi4gKi9cbiAgb25JZGxlQ2xvc2U6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgZGVib3VuY2VkIHNuYXBzaG90LCBpZiB0aGUgc3BlbGwgaGFzIG9uZS4gKi9cbiAgc25hcHNob3Q/OiB7XG4gICAgZGlydHk6ICgpID0+IGJvb2xlYW47XG4gICAgY2xlYXI6ICgpID0+IHZvaWQ7XG4gICAgd3JpdGU6ICgpID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+O1xuICB9O1xuICAvKiogU3dlZXAgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDI1MCBtcy4gKi9cbiAgdGlja01zPzogbnVtYmVyO1xuICAvKiogU25hcHNob3QgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDEwMDAgbXMuICovXG4gIHNuYXBzaG90TXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogU3RhcnQgdGhlIHR3byBzdGFuZGluZyB0aW1lcnMgZXZlcnkgc2Vzc2lvbiBkYWVtb24gcnVucyDigJQgdGhlIGlkbGUgc3dlZXAgYW5kXG4gKiB0aGUgZGVib3VuY2VkIHNuYXBzaG90IOKAlCBhbmQgcmV0dXJuIHRoZSBmdW5jdGlvbiB0aGF0IHN0b3BzIGJvdGguXG4gKlxuICogVGhleSBhcmUgT05FIGNhbGwgYmVjYXVzZSB0aGV5IGhhdmUgYWx3YXlzIGJlZW4gb25lIGxpZmV0aW1lOiBldmVyeSBjb3B5XG4gKiBjbGVhcmVkIGJvdGggaW4gdGhlIHNhbWUgdHdvIGxpbmVzIGFmdGVyIGBhd2FpdCBkb25lYCwgYW5kIHRoZSBwYWlyIHRoYXQgZ2V0c1xuICogZm9yZ290dGVuIGlzIHRoZSBwYWlyIHdob3NlIHRpbWVycyBrZWVwIGEgcHJvY2VzcyBhbGl2ZSBhZnRlciB0ZWFyZG93bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0SG91c2VrZWVwaW5nKG9wdHM6IEhvdXNla2VlcGluZ09wdGlvbnMpOiAoKSA9PiB2b2lkIHtcbiAgY29uc3QgdGlja01zID0gb3B0cy50aWNrTXMgPz8gMjUwO1xuICBjb25zdCBzbmFwc2hvdE1zID0gb3B0cy5zbmFwc2hvdE1zID8/IDEwMDA7XG5cbiAgY29uc3QgaWRsZVRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIGNvbnN0IHN1YnNjcmliZXJzID0gb3B0cy5zdWJzY3JpYmVyQ291bnQoKTtcbiAgICBpZiAoc3Vic2NyaWJlcnMgPiAwKSBvcHRzLnRvdWNoKCk7XG4gICAgaWYgKHNob3VsZElkbGVDbG9zZShzdWJzY3JpYmVycywgb3B0cy5pZGxlTXMoKSwgb3B0cy50aW1lb3V0TXMpKSBvcHRzLm9uSWRsZUNsb3NlKCk7XG4gIH0sIHRpY2tNcyk7XG5cbiAgY29uc3Qgc25hcCA9IG9wdHMuc25hcHNob3Q7XG4gIGNvbnN0IHNuYXBUaW1lciA9IHNuYXBcbiAgICA/IHNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgaWYgKCFzbmFwLmRpcnR5KCkpIHJldHVybjtcbiAgICAgICAgc25hcC5jbGVhcigpO1xuICAgICAgICB2b2lkIHNuYXAud3JpdGUoKTtcbiAgICAgIH0sIHNuYXBzaG90TXMpXG4gICAgOiBudWxsO1xuXG4gIHJldHVybiAoKSA9PiB7XG4gICAgY2xlYXJJbnRlcnZhbChpZGxlVGltZXIpO1xuICAgIGlmIChzbmFwVGltZXIgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoc25hcFRpbWVyKTtcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEcmFpbk9wdGlvbnMge1xuICAvKiogVGhlIGJvdW5kIHNlcnZlci4gVHlwZWQgc3RydWN0dXJhbGx5IHNvIHRoZSBraXQgc3RheXMgZnJlZSBvZiBgYnVuYC4gKi9cbiAgc2VydmVyOiB7IHN0b3AoY2xvc2VBY3RpdmVDb25uZWN0aW9ucz86IGJvb2xlYW4pOiB1bmtub3duIH07XG4gIC8qKiBMaXZlIFNTRSB0YWlsczsgZXZlcnkgcmVnaXN0ZXJlZCBjbG9zZXIgaXMgaW52b2tlZC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBMaXZlIFdlYlNvY2tldHMuICovXG4gIHNvY2tldHM/OiBJdGVyYWJsZTx7IGNsb3NlKCk6IHZvaWQgfT47XG4gIC8qKiBIb3cgbG9uZyBxdWV1ZWQgZnJhbWVzIGdldCB0byBmbHVzaCBiZWZvcmUgYW55dGhpbmcgaXMgY2xvc2VkLiAqL1xuICBncmFjZU1zPzogbnVtYmVyO1xuICAvKiogSG93IGxvbmcgdGhlIGdyYWNlZnVsIHN0b3AgZ2V0cyBiZWZvcmUgdGVhcmRvd24gcHJvY2VlZHMgcmVnYXJkbGVzcy4gKi9cbiAgc3RvcE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIENsb3NlIGV2ZXJ5IGhlbGQgY29ubmVjdGlvbiBhbmQgc3RvcCB0aGUgc2VydmVyLCBpbiBib3VuZGVkIHRpbWUuXG4gKlxuICog4puUICoqVEhFIEdSQUNFIFBFUklPRCBJUyBOT1QgUE9MSVRFTkVTUy4qKiBBIGBjbG9zZWRgIGZyYW1lIGVtaXR0ZWQgYW5kIHRoZW5cbiAqIGZvbGxvd2VkIGltbWVkaWF0ZWx5IGJ5IGFuIGFnZ3Jlc3NpdmUgYHNlcnZlci5zdG9wKHRydWUpYCBpcyBhIGZyYW1lIHRoZVxuICogY2xpZW50IG5ldmVyIHNlZXMg4oCUIHRoZSBxdWV1ZSBnb2VzIHdpdGggdGhlIHNvY2tldC4gVGhlIDE1MCBtcyBpcyB3aGF0IHR1cm5zXG4gKiBcInRoZSBkYWVtb24gdG9sZCB5b3Ugd2h5IGl0IGRpZWRcIiBmcm9tIGEgaG9wZSBpbnRvIGFuIG9ic2VydmF0aW9uLCBhbmQgZXZlcnlcbiAqIG9uZSBvZiB0aGUgZWlnaHQgZGFlbW9ucyBjb252ZXJnZWQgb24gdGhhdCBudW1iZXIgaW5kZXBlbmRlbnRseS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNUT1AgSVMgUkFDRUQsIEJFQ0FVU0UgQSBTTE9XIFNPQ0tFVCBNVVNUIE5PVCBCRSBBQkxFIFRPIEhBTkdcbiAqIFRFQVJET1dOLioqIGBzZXJ2ZXIuc3RvcCh0cnVlKWAgYXdhaXRzIGl0cyBjb25uZWN0aW9uczsgb25lIHdlZGdlZCBwZWVyIGlzXG4gKiBlbm91Z2ggdG8gcGFyayBpdCBmb3JldmVyLCB3aGljaCBpcyBob3cgYSAyMy1taW51dGUgaGFuZyBzaGlwcGVkIG9uY2UuXG4gKlxuICog4pqgICoqV0hBVCBJUyBERUxJQkVSQVRFTFkgTk9UIEhFUkU6IGJvdW50eSdzIHNodXRkb3duIHdhdGNoZG9nLioqIEJvdW50eSBhcm1zXG4gKiBhIFJFRidkIGBzZXRUaW1lb3V0YCB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGlmIHRlYXJkb3duIGRvZXMgbm90IGZpbmlzaCxcbiAqIGFuZCB0aGUgY2Vuc3VzIGlzIHJpZ2h0IHRoYXQgaXQgaXMgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbFxuICogdGVybWluYXRpb24gZ3VhcmFudGVlLiBJdCBiZWxvbmdzIHRvIGJvdW50eSdzIFRFQVJET1dOIOKAlCB0aGUgc3RyZXRjaCB3aGVyZVxuICogbm90aGluZyBib3VuZHMgd2hhdCBpcyBiZWluZyB3YWl0ZWQgb24uIOKblCAqKlRISVMgUEFSQUdSQVBIIFNBSUQgXCJTSUdOQUxcbiAqIFBBVEhcIiBVTlRJTCBENTMsIEFORCBUSEUgQ09ERSBBR1JFRUQgV0lUSCBJVCwgV0hJQ0ggV0FTIFRIRSBERUZFQ1QuKiogQm91bnR5XG4gKiBoYXMgRk9VUiB3YXlzIGludG8gb25lIHRlYXJkb3duIChhIHNpZ25hbCwgYSBgY2xvc2VgIHZlcmIsIHRoZSBicm93c2VyJ3NcbiAqIGNsb3NlIG92ZXIgdGhlIFdlYlNvY2tldCwgYW4gaWRsZSB0aW1lb3V0KSBhbmQgb25seSB0aGUgc2lnbmFsIG9uZSBhcm1lZCB0aGVcbiAqIHRpbWVyLCB3aGlsZSB0aGUgY29tbWVudCBhYm92ZSBpdCBjbGFpbWVkIHRoZSBlbmRpbmcgd2FzIHVuY29uZGl0aW9uYWwuXG4gKiBEcml2ZW4gd2l0aCBhIHBsYW50ZWQgaGFuZzogdGhlIG90aGVyIHRocmVlIHJhbiBwYXN0IDEwIHMsIHRoZSBpZGxlIG9uZVxuICogaW5jbHVkZWQg4oCUIHRoZSBvcnBoYW4tZGFlbW9uIGNsYXNzIHRoZSAyMy1taW51dGUgaGFuZyBjYW1lIGZyb20uIFRoZSBhcm1pbmdcbiAqIG5vdyBsaXZlcyBpbiB0aGUgUkVTT0xWRSB0aGF0IGFsbCBmb3VyIGVudHJpZXMgcGFzcyB0aHJvdWdoLiAqKlRoZSBsZXNzb24gZm9yXG4gKiBhbiBhZG9wdGVyIGlzIHRoZSBjb3VudCwgbm90IHRoZSBwbGFjZW1lbnQ6IGVudW1lcmF0ZSBldmVyeSBlbnRyeSBpbnRvIHRoZVxuICogdGVhcmRvd24gYmVmb3JlIHlvdSBiZWxpZXZlIGEgZ3VhcmFudGVlIGNvdmVycyBpdC4qKiBUaGUgdHdvXG4gKiBkYWVtb25zIGFkb3B0aW5nIHRoaXMgbW9kdWxlIHJlZ2lzdGVyIG5vIHNpZ25hbCBoYW5kbGVycywgYW5kIHRoZWlyIHdob2xlXG4gKiB0ZWFyZG93biBpcyBib3VuZGVkIGJ5IHRoZSB0d28gbnVtYmVycyBhYm92ZTsgYWRkaW5nIGFuIGV4aXQgaGVyZSB3b3VsZCBwdXRcbiAqIHRoZSBob3VzZSdzIG9ubHkgdW5jb25kaXRpb25hbCBgcHJvY2Vzcy5leGl0YCBpbnNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgaXNcbiAqIGFib3V0IHRvIGJ1bmRsZSwgb25lIHBoYXNlIGFmdGVyIEQ4IHRvb2sgZXhhY3RseSB0aGF0IGhhemFyZCBPVVQgb2YgYGRpZWAuXG4gKlxuICog4puUICoqQU5EIFRIRSBTRU5URU5DRSBUSEFUIFVTRUQgVE8gRU5EIFRIQVQgUEFSQUdSQVBIIFdBUyBBIFBSRURJQ1RJT04sIFdISUNIXG4gKiBCT1VOVFknUyBPV04gUE9SVCBGQUxTSUZJRUQuKiogSXQgcmVhZDogXCJ3aGVuIGEgc3BlbGwgd2l0aCBhIHNpZ25hbCBwYXRoXG4gKiBhZG9wdHMgdGhpcywgdGhlIHdhdGNoZG9nIGFycml2ZXMgYXMgYW4gb3B0aW9uIG9uIHRoZXNlIGFyZ3VtZW50cyBhbmQgdGhlXG4gKiByZWFzb25pbmcgaXMgYWxyZWFkeSB3cml0dGVuIGRvd24uXCIgYm91bnR5IGFkb3B0ZWQgYGRyYWluQW5kU3RvcGAgb25cbiAqIDIwMjYtMDktMDkgKFBoYXNlIDQpIGFuZCB0aGUgb3B0aW9uIHdhcyBOT1QgYWRkZWQsIGJlY2F1c2UgdGhlIHdpbmRvdyBpc1xuICogd3JvbmcuICoqQSBgd2F0Y2hkb2dNc2Agb24gdGhlc2UgYXJndW1lbnRzIHdvdWxkIGFybSBhdCBEUkFJTiB0aW1lOyBib3VudHknc1xuICogYXJtcyBhdCBTSUdOQUwgdGltZSoqLCBhbmQgdGhlIHdob2xlIHJlYXNvbiBpdCBleGlzdHMgaXMgdGhlIHN0cmV0Y2ggQkVUV0VFTlxuICogdGhvc2UgdHdvIHBvaW50cyDigJQgYGF3YWl0IGRvbmVgLCBhbiBmcyBhcHBlbmQgdG8gdGhlIGRhZW1vbiBsb2csIGEgZnVsbFxuICogc25hcHNob3Qgd3JpdGUgdGhhdCBjYW4gcm90YXRlIGFuZCBDT1BZIGEgYmFja3VwIG9mIGEgbGFyZ2UgYm9hcmQsIGEgYGNsb3NlZGBcbiAqIGZyYW1lIGFuZCBhIGJyb2FkY2FzdC4gYGRyYWluQW5kU3RvcGAncyBvd24gYm9keSBpcyBhbHJlYWR5IGJvdW5kZWQgYnkgdGhlIHR3b1xuICogbnVtYmVycyBhYm92ZSwgc28gYSB3YXRjaGRvZyBzY29wZWQgdG8gaXQgd291bGQgZ3VhcmQgdGhlIG9uZSBzdHJldGNoIHRoYXRcbiAqIGNhbm5vdCBoYW5nIGFuZCBhYmFuZG9uIHRoZSBzdHJldGNoIHRoYXQgY2FuOiBpdCB3b3VsZCBSRUFEIGFzIGFkb3B0aW9uIGFuZFxuICogQkUgYSBuYXJyb3dpbmcgb2YgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbCB0ZXJtaW5hdGlvbiBndWFyYW50ZWUuIFRoZVxuICogMjMtbWludXRlIGhhbmcgdGhpcyBwcm9qZWN0IGtlZXBzIGNpdGluZyBoYXBwZW5lZCBpbiB0aGUgdW5ib3VuZGVkIHN0cmV0Y2guXG4gKlxuICog4pqgICoqU08gVEhFIFJVTEUgRk9SIFRIRSBORVhUIFNQRUxMLCBXSElDSCBJUyBUSEUgVFJBTlNGRVJBQkxFIEhBTEY6KiogdGhlXG4gKiBxdWVzdGlvbiBpcyBuZXZlciBcImRvZXMgdGhpcyBtb2R1bGUgaGF2ZSBhIHBsYWNlIHRvIHB1dCBhIHdhdGNoZG9nXCIgYnV0XG4gKiBcImRvZXMgdGhlIHdhdGNoZG9nJ3Mgd2luZG93IGNvaW5jaWRlIHdpdGggdGhpcyBtb2R1bGUnc1wiLiBXaGVyZSBhIHNwZWxsJ3NcbiAqIHRlYXJkb3duIGhhcyB1bmJvdW5kZWQgd29yayBCRUZPUkUgdGhlIGRyYWluLCB0aGUgd2F0Y2hkb2cgYmVsb25ncyBhdCB0aGVcbiAqIHNwZWxsLCB3cmFwcGVkIGFyb3VuZCBhbGwgb2YgaXQg4oCUIGFuZCBhcm91bmQgRVZFUlkgV0FZIElOLCB3aGljaCBpcyB0aGUgaGFsZlxuICogRDUzIGhhZCB0byByZXBhaXIgYWZ0ZXIgdGhpcyBoZWFkZXIgd2FzIHdyaXR0ZW4uIElmIGEgc3BlbGwgZXZlciBhcHBlYXJzIHdob3NlIHNpZ25hbCBwYXRoXG4gKiBlbnRlcnMgYGRyYWluQW5kU3RvcGAgaW1tZWRpYXRlbHksIGFkZCB0aGUgb3B0aW9uIFRIRU4g4oCUIGFuZCB0aGUgb3B0aW9uIG11c3RcbiAqIHRha2UgYW4gYG9uRXhwaXJlYCBjYWxsYmFjayByYXRoZXIgdGhhbiBleGl0aW5nLCBzbyB0aGUgYHByb2Nlc3MuZXhpdGAgc3RheXNcbiAqIG91dHNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgYnVuZGxlcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRyYWluQW5kU3RvcChvcHRzOiBEcmFpbk9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZ3JhY2VNcyA9IG9wdHMuZ3JhY2VNcyA/PyAxNTA7XG4gIGNvbnN0IHN0b3BNcyA9IG9wdHMuc3RvcE1zID8/IDIwMDtcblxuICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBncmFjZU1zKSk7XG5cbiAgaWYgKG9wdHMuY2xpZW50cykge1xuICAgIGZvciAoY29uc3QgY2xpZW50IG9mIFsuLi5vcHRzLmNsaWVudHNdKSBjbGllbnQuY2xvc2UoKTtcbiAgfVxuICBpZiAob3B0cy5zb2NrZXRzKSB7XG4gICAgZm9yIChjb25zdCB3cyBvZiBbLi4ub3B0cy5zb2NrZXRzXSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgd3MuY2xvc2UoKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBhbHJlYWR5IGdvbmUgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgIFByb21pc2UucmVzb2x2ZShvcHRzLnNlcnZlci5zdG9wKHRydWUpKSxcbiAgICBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBzdG9wTXMpKSxcbiAgXSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGFzc2V0LXNlcnZpbmcgdHJpbyBmb3IgYSBzcGVsbCBkYWVtb246IHdoaWNoIHN1cmZhY2UgbW9kZSB3ZVxuICogYXJlIGluLCB3aGF0IGNvbnRlbnQgdHlwZSBhIGZpbGUgZ2V0cywgYW5kIGhvdyBhIGZpbGUgdW5kZXIgYGRpc3QvYCBpc1xuICogYW5zd2VyZWQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwncyBhcnRpZmFjdC5cbiAqXG4gKiBFeHRyYWN0ZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBmcm9tIHRoZSBlaWdodCBgQnVuLnNlcnZlYCBiYWNrZW5kc1xuICogY2Vuc3VzZWQgaW4gYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC1kYWVtb24tc3BpbmUtY2Vuc3VzLm1kYCwgd2hpY2hcbiAqIG1lYXN1cmVkIGByZXNvbHZlTW9kZWAgYXMgYnl0ZS1pZGVudGljYWwgaW4gYWxsIGVpZ2h0ICh0aGUgb25seSBtZDUgZGlmZmVyZW5jZVxuICogYmVpbmcgdGhlIGBleHBvcnRgIGtleXdvcmQpLCB0aGUgY29udGVudC10eXBlIG1hcCBhcyBkaWZmZXJpbmcgaW4gZXhhY3RseVxuICogb25lIGNlbGwsIGFuZCB0aGUgZmlsZSBoYWxmIG9mIGBzZXJ2ZURpc3RgIGFzIGlkZW50aWNhbCBpbiBmaXZlLlxuICpcbiAqIOKUgOKUgCBXSEFUIERFTElCRVJBVEVMWSBESUQgTk9UIENPTUUgQUxPTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKipUaGUgVVJMLXRvLWZpbGVuYW1lIG1hcHBpbmcgc3RheXMgaW4gZWFjaCByb3V0ZXIuKiogVGhlIGNlbnN1cyBtYXJrZWQgdHdvXG4gKiBvZiB0aGUgZWlnaHQgYHNlcnZlRGlzdGAgZGl2ZXJnZW5jZXMgREVMSUJFUkFURSBhbmQgYm90aCBsaXZlIGluIHRoYXQgaGFsZjpcbiAqIGRpZ2VzdGlmeSBzdWJzdGl0dXRlcyBpbnRvIHRoZSBlbnRyeSBIVE1MIGluIG1lbW9yeSwgYW5kIGdyYXBldmluZSBzZXJ2ZXMgaXRzXG4gKiBzdXJmYWNlIGF0IGAvd2F0Y2hgIHJhdGhlciB0aGFuIGF0IGAvYC4gQSBzaWduYXR1cmUgd2lkZSBlbm91Z2ggdG8gYWJzb3JiXG4gKiB0aG9zZSBzdG9wcyBiZWluZyBhIGZpbGUgc2VydmVyIGFuZCBiZWNvbWVzIGEgcm91dGVyLiBTbyB0aGUgY2FsbGVyIGRlY2lkZXNcbiAqIFdISUNIIGZpbGUgKGBwYXRoID09PSBcIi9cIiA/IFwiaW5kZXguaHRtbFwiIDogcGF0aC5zbGljZSgxKWApLCBhbmQgdGhpcyBtb2R1bGVcbiAqIGRlY2lkZXMgd2hldGhlciB0aGF0IGZpbGUgbWF5IGJlIHJlYWQgYW5kIHdoYXQgaXQgaXMgc2VydmVkIGFzLlxuICpcbiAqIOKUgOKUgCBBTkQgXCJXSEVUSEVSIElUIE1BWSBCRSBSRUFEXCIgSVMgTk9XIEEgV0hJVEVMSVNUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEV4dHJhY3RlZCB3aXRoIHRocmVlIGd1YXJkcyAoZW1wdHkgLyBgLi5gIC8gbmVzdGVkKSBhbmQgYGV4aXN0c1N5bmNgIGZvciB0aGVcbiAqIHJlc3QsIHdoaWNoIHdhcyB0cnVlIG9mIGEgYGRpc3QvYCB0aGF0IGhlbGQgb25seSBhIHN1cmZhY2UuIFBoYXNlIDFiIHB1dCBldmVyeVxuICogZGFlbW9uJ3MgQlVORExFIGluIHRoYXQgc2FtZSBkaXJlY3RvcnksIGFuZCBhbGwgZml2ZSBhZG9wdGVycyBzZXJ2ZWQgaXQ6XG4gKiBgL2NsaS5qc2AsIGAvc2VydmVyLmpzYCwgYC9qb2luLmpzYCBhdCAyMDAsIGJ5dGUtaWRlbnRpY2FsIHRvIHRoZSBjb21taXR0ZWRcbiAqIGFydGlmYWN0cywgZW1iZWRkZWQgc291cmNlbWFwcyBhbmQgYWxsLiBgc2VydmVGcm9tRGlzdGAgbm93IHNlcnZlcyBvbmx5IHdoYXQgdGhlXG4gKiBidWlsdCBgaW5kZXguaHRtbGAgdHJhbnNpdGl2ZWx5IGxpbmtzIOKAlCBzZWUgYHN1cmZhY2VXaGl0ZWxpc3RgIGJlbG93LCB3aGljaCBpc1xuICogdGhlIHNoYXBlIGRpZ2VzdGlmeSBwcm92ZWQgbG9jYWxseSBpbiBgZDhjYmFmZmAgYW5kIHRoaXMgaXMgaXRzIG9uZSBlZGl0IGZvclxuICogZml2ZSBzcGVsbHMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbi8qKlxuICogUmVsZWFzZSBpZmYgYDxkaXN0RGlyPi9pbmRleC5odG1sYCBleGlzdHM7IGVsc2UgZGV2LiBUaGUgZW52IG92ZXJyaWRlXG4gKiAoYFNQRUxMQk9PS19TVVJGQUNFX01PREVgKSB3aW5zIGVpdGhlciB3YXkg4oCUIHNlYW1zIENvbnRyYWN0IDEuXG4gKlxuICog4puUICoqVEhFIEZJTEUsIE5FVkVSIFRIRSBESVJFQ1RPUlksIEFORCBUSEFUIElTIEEgU0NBUiBOT1QgQSBTVFlMRSBDSE9JQ0UuKipcbiAqIFJlLWhvbWVkIGZyb20gYm91bnR5IGFuZCBtYWdwaWUsIHdoaWNoIGVhcm5lZCBpdCBpbmRlcGVuZGVudGx5OlxuICpcbiAqIC0gbWFncGllJ3MgYGRpc3QvYCBBTFJFQURZIEVYSVNURUQgaG9sZGluZyBgY2xpLmpzYCBhbmQgbm8gYGluZGV4Lmh0bWxgLFxuICogICB3aGljaCBpcyBwcmVjaXNlbHkgd2h5IGl0cyBkYWVtb24gc3RheWVkIGNvcnJlY3RseSBpbiBERVYgbW9kZSB0aHJvdWdoIHRoZVxuICogICB3aG9sZSBvZiBTbGljZSAyLiBgZGlzdC9gIGV4aXN0aW5nIGlzIG5vdCB0aGUgZGlzY3JpbWluYXRvci5cbiAqIC0gYm91bnR5IHNheXMgdGhlIHNhbWUgdGhpbmcgZnJvbSB0aGUgb3RoZXIgc2lkZTogYSBidWlsdCBCQUNLRU5EIHB1dHNcbiAqICAgYGNsaS5qc2AgKGFuZCBub3cgYHNlcnZlci5qc2ApIGluIGBkaXN0L2Agd2l0aCBubyBzdXJmYWNlIGFueXdoZXJlIG5lYXIgaXQuXG4gKlxuICog4pqgICoqQU5EIFRIRSBQUkVESUNBVEUgSVMgQU4gVU5IQVNIRUQgRklMRU5BTUUsIFdISUNIIElTIEEgU1RBTkRJTkdcbiAqIEFTU1VNUFRJT04gQUJPVVQgVEhFIFNVUkZBQ0UgQlVJTEQuKiogUmVsZWFzZSBtb2RlIGlzIGNob3NlbiBieSBPTkUgbGl0ZXJhbFxuICogbmFtZS4gQSBzdXJmYWNlIGJ1aWxkIHRoYXQgZXZlciBlbWl0dGVkIGEgY29udGVudC1oYXNoZWQgZW50cnkgZG9jdW1lbnQgd291bGRcbiAqIGxlYXZlIG5vIGBpbmRleC5odG1sYCBoZXJlLCBldmVyeSBkYWVtb24gd291bGQgc2lsZW50bHkgcmVzb2x2ZSBERVYsIGFuZCB0aGVcbiAqIG9ubHkgc3ltcHRvbSBhbnlvbmUgY2FuIHNlZSBpcyB0aGUgYG1vZGVgIGZpZWxkIG9uIGEgaGFuZHNoYWtlIG5vYm9keSByZWFkcyBpblxuICogYW5nZXIuIGBzcmMvYnVpbGQudHNgIGVtaXRzIHRoZSBlbnRyeSB1bmhhc2hlZCB0b2RheSAob25seSB0aGUgSlMgYW5kIENTU1xuICogY2h1bmtzIGNhcnJ5IGhhc2hlcykgYW5kIENvbnRyYWN0IDIgcGlucyB0aGF0IGZsYXQgbGF5b3V0OyB0aGlzIGNvbW1lbnQgaXNcbiAqIHRoZSBub3RlIHRoYXQgc2F5cyB3aGF0IHRoZSBwaW4gaXMgbG9hZC1iZWFyaW5nIEZPUi5cbiAqXG4gKiDimqAgTm90aGluZyBhbm5vdW5jZXMgdGhlIGZsaXAgZnJvbSBkZXYgdG8gcmVsZWFzZSBlaXRoZXI6IHRoZSBmaXJzdCBzdXJmYWNlXG4gKiBidWlsZCB0byBsYW5kIGFuIGBpbmRleC5odG1sYCBiZXNpZGUgYSBkYWVtb24gZmxpcHMgaXQsIHNpbGVudGx5LCBvbiB0aGUgbmV4dFxuICogYm9vdC4gVGhhdCBpcyB3aHkgYG1vZGVgIHJpZGVzIHRoZSByZWFkeSBmcmFtZSDigJQgd2l0aCByb290IGRlcHMgcHJlc2VudCBhIGRldlxuICogZGFlbW9uIHJlbmRlcnMgYW4gaWRlbnRpY2FsLWxvb2tpbmcgc3VyZmFjZSwgc28gXCJpdCBsb29rcyByaWdodFwiIGNhbm5vdFxuICogdmVyaWZ5IENvbnRyYWN0IDEuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9kZShkaXN0RGlyOiBzdHJpbmcpOiBcImRldlwiIHwgXCJyZWxlYXNlXCIge1xuICBjb25zdCBvdmVycmlkZSA9IHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREU7XG4gIGlmIChvdmVycmlkZSA9PT0gXCJkZXZcIiB8fCBvdmVycmlkZSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBvdmVycmlkZTtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihkaXN0RGlyLCBcImluZGV4Lmh0bWxcIikpID8gXCJyZWxlYXNlXCIgOiBcImRldlwiO1xufVxuXG4vKipcbiAqIFRoZSBjb250ZW50IHR5cGVzIGEgYnVpbHQgc3VyZmFjZSBhY3R1YWxseSBzaGlwcy4gRXh0ZW5zaW9ucyBvdXRzaWRlIHRoZVxuICogbWFwIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYCDigJQgYSBkZWxpYmVyYXRlIHJlZnVzYWwgdG8gZ3Vlc3MsIHNpbmNlXG4gKiBhbnl0aGluZyBub3QgaW4gdGhpcyBsaXN0IGlzIG5vdCBzb21ldGhpbmcgQ29udHJhY3QgMidzIGJ1aWxkIGVtaXRzLlxuICpcbiAqIOKaoCAqKmBjaGFyc2V0PXV0Zi04YCBPTiBIVE1MIElTIFRIRSBDRU5TVVMnUyBPTkUgRElWRVJHRU5DRSwgUkVTT0xWRUQgVE9XQVJEXG4gKiBUSEUgQ09SUkVDVCBDT1BZLioqIFRocmVlIG9mIHRoZSBlaWdodCBkYWVtb25zIGNhcnJpZWQgaXQgYW5kIGZpdmUgZGlkIG5vdDtcbiAqIHRoZSBjZW5zdXMgZ3JhZGVkIHRoYXQgYHN0YWxlYCB3aXRoIHplcm8gZGVzaWduIGNvbnRlbnQuIEl0IGlzIGtlcHQgYmVjYXVzZVxuICogaXQgaXMgdGhlIHJpZ2h0IGFuc3dlciDigJQgYW4gSFRNTCBkb2N1bWVudCBzZXJ2ZWQgd2l0aCBubyBjaGFyc2V0IGlzIGRlY29kZWRcbiAqIGJ5IHRoZSBicm93c2VyJ3MgZ3Vlc3Mg4oCUIGFuZCBpdCBpcyB0aGUgb25lIHdpcmUtb2JzZXJ2YWJsZSBjaGFuZ2UgdGhpc1xuICogY29udmVyZ2VuY2UgbWFrZXMgdG8gYSByZXNwb25zZSBoZWFkZXIuIFJlY29yZGVkIGFzIEQtbm90ZSBpbiB0aGUgcGhhc2UgbG9nXG4gKiByYXRoZXIgdGhhbiBzbXVnZ2xlZC5cbiAqL1xuY29uc3QgU1RBVElDX0NPTlRFTlRfVFlQRVM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiLmh0bWxcIjogXCJ0ZXh0L2h0bWw7IGNoYXJzZXQ9dXRmLThcIixcbiAgXCIuanNcIjogXCJ0ZXh0L2phdmFzY3JpcHRcIixcbiAgXCIuY3NzXCI6IFwidGV4dC9jc3NcIixcbiAgXCIuanNvblwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbn07XG5cbi8qKiBUaGUgY29udGVudCB0eXBlIGZvciBhIGZpbGVuYW1lIG9yIGFuIGV4dGVuc2lvbi4gVW5rbm93biBleHRlbnNpb25zLCBhbmRcbiAqICBuYW1lcyB3aXRoIG5vIGV4dGVuc2lvbiBhdCBhbGwsIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb250ZW50VHlwZUZvcihuYW1lT3JFeHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGRvdCA9IG5hbWVPckV4dC5sYXN0SW5kZXhPZihcIi5cIik7XG4gIGNvbnN0IGV4dCA9IGRvdCA9PT0gLTEgPyBcIlwiIDogbmFtZU9yRXh0LnNsaWNlKGRvdCk7XG4gIHJldHVybiBTVEFUSUNfQ09OVEVOVF9UWVBFU1tleHRdID8/IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCI7XG59XG5cbi8qKlxuICogQW5zd2VyIE9ORSBmaWxlIGZyb20gYGRpc3REaXJgLCBvciBgbnVsbGAgaWYgdGhlIGNhbGxlciBzaG91bGQga2VlcCByb3V0aW5nLlxuICpcbiAqIGByZWxgIGlzIGEgYmFyZSBmaWxlbmFtZSDigJQgdGhlIGVudHJ5IGRvY3VtZW50IG9yIG9uZSBoYXNoZWQgY2h1bmsuIENvbnRyYWN0XG4gKiAyJ3MgYnVpbHQgc3VyZmFjZSBpcyBGTEFUIGFuZCBsaW5rcyBpdHMgY2h1bmtzIHJlbGF0aXZlbHksIHNvIGEgbGVnaXRpbWF0ZVxuICogYXNzZXQgcmVxdWVzdCBpcyBuZXZlciBuZXN0ZWQgYW5kIG5ldmVyIGNvbnRhaW5zIGAuLmA7IGJvdGggYXJlIHJlZnVzZWRcbiAqIGhlcmUgcmF0aGVyIHRoYW4gaW4gdGhlIHJvdXRlciwgYmVjYXVzZSB0aGUgZ3VhcmQgcHJvdGVjdHMgdGhlIHJlYWQgYW5kIHRoZVxuICogcmVhZCBpcyB3aGF0IGxpdmVzIGluIHRoaXMgZmlsZS5cbiAqXG4gKiDim5QgQU5EIGBleGlzdHNTeW5jYCBJUyBOTyBMT05HRVIgVEhFIFBFUk1JU1NJT04uIEEgZmlsZSB1bmRlciBgZGlzdERpcmAgaXNcbiAqIHNlcnZlZCBvbmx5IGlmIGl0IGlzIGluIGBzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXIpYCDigJQgd2hhdCB0aGUgYnVpbHRcbiAqIGBpbmRleC5odG1sYCB0cmFuc2l0aXZlbHkgTElOS1MuIGBkaXN0L2Agc3RvcHBlZCBiZWluZyBhIHN1cmZhY2UgZGlyZWN0b3J5XG4gKiB3aGVuIHRoZSBiYWNrZW5kIGNvbnZlcmdlbmNlIGJ1aWx0IHRoZSBkYWVtb25zIGludG8gaXQsIGFuZCB0aGUgZ3VhcmRzIGFib3ZlXG4gKiBkbyBub3QgZGlzdGluZ3Vpc2ggYGluZGV4LTxoYXNoPi5qc2AgZnJvbSBgc2VydmVyLmpzYC4gUmVhZCB0aGF0IGZ1bmN0aW9uJ3NcbiAqIGhlYWRlciBiZWZvcmUgdG91Y2hpbmcgdGhpcyBsaW5lOyB0aGUgd2hpdGVsaXN0IGlzIHRoZSBkZWZlbmNlLlxuICpcbiAqIOKaoCBUaGUgbmVzdGluZyByZWZ1c2FsIGlzIGFsc28gd2hhdCBrZWVwcyBhbiBhc3NldCBzZXJ2ZSBjbGVhciBvZiBhIHNwZWxsJ3NcbiAqIG93biByb3V0ZXM6IG1hZ3BpZSwgYm91bnR5LCBnbGFtb3VyIGFuZCBpbWFnbyBlYWNoIGhhdmUgYW4gYC9hc3NldHMvPG5hbWU+YFxuICogcm91dGUgb25lIGxldmVsIGRlZXAsIGFuZCB0aGlzIHJldHVybmluZyBgbnVsbGAgb24gYW55dGhpbmcgd2l0aCBhIHNsYXNoIGluXG4gKiBpdCBpcyB3aGF0IHN0b3BzIHRoZSB0d28gZmlnaHRpbmcuIFRoZSB3aGl0ZWxpc3QgZ292ZXJucyBgZGlzdC9gIHJlYWRzIE9OTFlcbiAqIOKAlCBpdCBuZXZlciBzZWVzIHRob3NlIHJvdXRlcyBhbmQgbXVzdCBuZXZlciBiZSB3aWRlbmVkIGludG8gdGhlbS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlcnZlRnJvbURpc3QoZGlzdERpcjogc3RyaW5nLCByZWw6IHN0cmluZyk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIGlmICghcmVsIHx8IHJlbC5pbmNsdWRlcyhcIi4uXCIpIHx8IHJlbC5pbmNsdWRlcyhcIi9cIikpIHJldHVybiBudWxsO1xuICBpZiAoIXN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcikuaGFzKHJlbCkpIHJldHVybiBudWxsO1xuICBjb25zdCBmaWxlID0gam9pbihkaXN0RGlyLCByZWwpO1xuICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIHJldHVybiBudWxsO1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKEJ1bi5maWxlKGZpbGUpLCB7IGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogY29udGVudFR5cGVGb3IocmVsKSB9IH0pO1xufVxuXG4vKiogYHNyY2AvYGhyZWZgIHZhbHVlcyBpbiBhIGJ1aWx0IGVudHJ5IGRvY3VtZW50LCBgLi9gLXByZWZpeGVkIG9yIGJhcmUuICovXG5jb25zdCBFTlRSWV9SRUZfUkUgPSAvKD86c3JjfGhyZWYpXFxzKj1cXHMqXCIoPzpcXC5cXC8pPyhbXlwiXSspXCIvZztcblxuLyoqIEEgYC4vYC1QUkVGSVhFRCBzaWJsaW5nIHNwZWNpZmllciDigJQgYFwiLi9uYW1lXCJgLCBgJy4vbmFtZSdgLCBgKC4vbmFtZSlgIOKAlCB3aGljaFxuICogIGlzIHRoZSBvbmx5IHNoYXBlIGEgYnVuZGxlciBlbWl0cyBmb3IgYSBzaWJsaW5nIGNodW5rLiBSZXF1aXJpbmcgdGhlIGAuL2AgaXNcbiAqICB3aGF0IGtlZXBzIGEgc3RyaW5nIGxpdGVyYWwgdGhhdCBtZXJlbHkgU0FZUyBgY2xpLmpzYCBvdXQgb2YgdGhlIHNldC4gKi9cbmNvbnN0IFJFTEFUSVZFX1JFRl9SRSA9IC9bXCInKF1cXC5cXC8oW15cIicoKVxcc10rKVtcIicpXS9nO1xuXG4vKiogT25seSB0ZXh0IHRoZSBidWlsZCBlbWl0cyBhcyBzdXJmYWNlIGNvZGUgaXMgc2Nhbm5lZCBmb3Igb253YXJkIHJlZmVyZW5jZXMuXG4gKiAgQSBgLnBuZ2AgaXMgYSBsZWFmOyBvcGVuaW5nIGl0IHdvdWxkIGJlIHJlYWRpbmcgYSBiaW5hcnkgZm9yIGZpbGVuYW1lcy4gKi9cbmNvbnN0IFRSQU5TSVRJVkVfRVhUUyA9IFtcIi5qc1wiLCBcIi5jc3NcIl07XG5cbi8qKiBPbmUgZGVyaXZhdGlvbiBwZXIgYGRpc3QvYCwgZm9yIHRoZSBsaWZlIG9mIHRoZSBwcm9jZXNzIOKAlCBgZGlzdC9gIGlzIGEgYnVpbGRcbiAqICBhcnRpZmFjdCBhbmQgZG9lcyBub3QgY2hhbmdlIHVuZGVyIGEgcnVubmluZyBkYWVtb24uIEtleWVkIGJ5IGRpcmVjdG9yeSBzb1xuICogIHR3byBkYWVtb25zIGluIG9uZSBwcm9jZXNzIChhbmQgZXZlcnkgdGVzdCB3aXRoIGl0cyBvd24gdGVtcCB0cmVlKSBzdGF5XG4gKiAgaW5kZXBlbmRlbnQuICovXG5jb25zdCB3aGl0ZWxpc3RDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBSZWFkb25seVNldDxzdHJpbmc+PigpO1xuXG5mdW5jdGlvbiByZWZzSW4odGV4dDogc3RyaW5nLCByZTogUmVnRXhwKTogc3RyaW5nW10ge1xuICByZXR1cm4gKFxuICAgIFsuLi50ZXh0Lm1hdGNoQWxsKHJlKV1cbiAgICAgIC5tYXAoKFssIHJlZl0pID0+IHJlZilcbiAgICAgIC8vIEEgVFlQRSBQUkVESUNBVEUsIGFuZCBob25lc3Qgb25seSBiZWNhdXNlIGl0cyBmaXJzdCBjbGF1c2Ugd2FzIGFscmVhZHlcbiAgICAgIC8vIGhlcmU6IGAhIXJlZmAgaXMgdGhlIHJ1bnRpbWUgY2hlY2sgdGhhdCBtYWtlcyBgcmVmIGlzIHN0cmluZ2AgdHJ1ZSAodGhlXG4gICAgICAvLyBGRUxMIHNlbnRlbmNlJ3MgcHJlZGljYXRlIHJvdXRlLCB0YWtlbiB3aXRoIGl0cyBjbGF1c2Ug4oCUIHR5cGUtZGVidCBUMzYpLlxuICAgICAgLmZpbHRlcihcbiAgICAgICAgKHJlZik6IHJlZiBpcyBzdHJpbmcgPT5cbiAgICAgICAgICAhIXJlZiAmJlxuICAgICAgICAgICFyZWYuaW5jbHVkZXMoXCIvXCIpICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIi4uXCIpICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIjpcIikgJiZcbiAgICAgICAgICAhcmVmLnN0YXJ0c1dpdGgoXCIjXCIpICYmXG4gICAgICAgICAgIXJlZi5zdGFydHNXaXRoKFwiP1wiKSxcbiAgICAgIClcbiAgKTtcbn1cblxuLyoqXG4gKiBUaGUgbmFtZXMgdW5kZXIgYGRpc3REaXJgIGEgYnJvd3NlciBtYXkgZmV0Y2g6IHRoZSBlbnRyeSBkb2N1bWVudCwgcGx1cyB0aGVcbiAqIFRSQU5TSVRJVkUgY2xvc3VyZSBvZiB3aGF0IGl0IGxpbmtzLlxuICpcbiAqIOKblCAqKkEgV0hJVEVMSVNULCBBTkQgVEhFIExFQUsgSVQgUkVQTEFDRUQgSVMgV0hZLioqIFVudGlsIHRoaXMgZml4IHRoZSBmaWxlXG4gKiBoYWxmIG9mIHRoaXMgbW9kdWxlIGhhZCBleGFjdGx5IHRocmVlIGd1YXJkcyDigJQgZW1wdHksIGAuLmAsIG5lc3RlZCDigJQgYW5kXG4gKiBgZXhpc3RzU3luY2AgZGVjaWRlZCB0aGUgcmVzdC4gVGhhdCB3YXMgY29ycmVjdCBmb3IgYXMgbG9uZyBhcyBgZGlzdC9gIGhlbGRcbiAqIG9ubHkgYSBzdXJmYWNlLiBUaGUgYmFja2VuZCBjb252ZXJnZW5jZSBtb3ZlZCBldmVyeSBzcGVsbCdzIElNUExFTUVOVEFUSU9OXG4gKiBpbnRvIHRoZSBzYW1lIGRpcmVjdG9yeSwgYW5kIHRoZSBzZXJ2ZSBkaWQgd2hhdCBpdCB3YXMgd3JpdHRlbiB0byBkbzpcbiAqXG4gKiAgIEdFVCAvY2xpLmpzICAgICAyMDAgIDI0Miw0MzEgQiAgdGV4dC9qYXZhc2NyaXB0ICAg4oaQIGJvdW50eSwgYnl0ZS1pZGVudGljYWxcbiAqICAgR0VUIC9zZXJ2ZXIuanMgIDIwMCAgMjc2LDQxNSBCICB0ZXh0L2phdmFzY3JpcHQgICAgICB0byB0aGUgY29tbWl0dGVkXG4gKiAgIEdFVCAvam9pbi5qcyAgICAyMDAgICA0NywzNDggQiAgdGV4dC9qYXZhc2NyaXB0ICAgICAgYXJ0aWZhY3RzXG4gKlxuICogYW5kIHRob3NlIGJ1bmRsZXMgYXJlIGJ1aWx0IHdpdGggdGhlIHNvdXJjZW1hcCBFTUJFRERFRCwgc28gZWFjaCBvbmUgY2Fycmllc1xuICogdGhlIGNvbXBsZXRlIG9yaWdpbmFsIFR5cGVTY3JpcHQuIEZpdmUgc3BlbGxzIOKAlCBhc3Ryb2xhYmUsIGJvdW50eSwgZ2xhbW91ciwgaW1hZ28sIG1hZ3BpZVxuICog4oCUIGVsZXZlbiBhcnRpZmFjdHMsIGFsbCByZWFjaGFibGUgYnkgYW55IGJyb3dzZXIgdGhhdCBjYW4gcmVhY2ggdGhlIGRhZW1vbi5cbiAqIERpZ2VzdGlmeSBoaXQgdGhlIGlkZW50aWNhbCBkZWZlY3Qgb25lIGJyYW5jaCBlYXJsaWVyIGFuZCBhbnN3ZXJlZCBpdCBsb2NhbGx5O1xuICogdGhpcyBpcyB0aGF0IGFuc3dlciByZS1ob21lZCB0byB0aGUgb25lIHBsYWNlIGFsbCBmaXZlIGNhbGxlcnMgYWxyZWFkeSBzaGFyZS5cbiAqXG4gKiDim5QgKipERVJJVkVELCBOT1QgRU5VTUVSQVRFRCwgQU5EIE5PVCBNQVRDSEVEIEJZIFNIQVBFLioqIEEgbGl0ZXJhbCBuYW1lIGxpc3RcbiAqIGlzIHdyb25nIGF0IHRoZSBuZXh0IGJ1aWxkICh0aGUgY2h1bmtzIGNhcnJ5IGNvbnRlbnQgaGFzaGVzKS4gQSBzaGFwZSBtYXRjaFxuICogKGBpbmRleC08aGFzaD4uanNgKSBpcyB3cm9uZyB0aGUgZmlyc3QgdGltZSB0aGUgYnVuZGxlciBzcGxpdHMgYSBjaHVuay4gQXNraW5nXG4gKiB0aGUgZW50cnkgZG9jdW1lbnQgd2hhdCBpdCBsb2FkcyBpcyB0aGUgb25seSBmb3JtdWxhdGlvbiB0aGF0IGlzIHRydWUgb2ZcbiAqIHdoYXRldmVyIGBidW4gcnVuIGJ1aWxkYCBhY3R1YWxseSBlbWl0dGVkLlxuICpcbiAqIOKblCAqKkFORCBUSEUgQ0xPU1VSRSBJUyBUUkFOU0lUSVZFIEZPUiBUSEUgU0FNRSBSRUFTT04uKiogYGluZGV4Lmh0bWxgIGxpbmtzXG4gKiBvbmUgY2h1bmsgdG9kYXk7IGEgc3BsaXQgYnVpbGQgaGFzIHRoYXQgY2h1bmsgYGltcG9ydCBcIi4vY2h1bmstPGhhc2g+LmpzXCJgLFxuICogd2hpY2ggdGhlIGVudHJ5IGRvY3VtZW50IG5ldmVyIG5hbWVzLiBTbyBldmVyeSBhZG1pdHRlZCBgLmpzYC9gLmNzc2AgaXMgaXRzZWxmXG4gKiBzY2FubmVkIGZvciBgLi9gLXByZWZpeGVkIHNpYmxpbmdzLCB1bnRpbCB0aGUgc2V0IHN0b3BzIGdyb3dpbmcg4oCUIGEgd2hpdGVsaXN0XG4gKiB0aGF0IHJlYWQgb25seSB0aGUgZW50cnkgd291bGQgNDA0IGEgbGVnaXRpbWF0ZSBjaHVuayBpbiByZWxlYXNlLCBhbmQgb25seSBpblxuICogcmVsZWFzZS5cbiAqXG4gKiDim5QgKipNRU1CRVJTSElQIElTIEFOIEVYQUNUIE1BVENILCBXSElDSCBNQUtFUyBUSEUgUkVGVVNBTCBDQVNFLUlOU0VOU0lUSVZFIEJZXG4gKiBDT05TVFJVQ1RJT04uKiogQVBGUyBpcyBjYXNlLWluc2Vuc2l0aXZlLCBzbyBgL0lOREVYLkhUTUxgIGFuZCBgL2lOZEV4Lkh0TWxgXG4gKiByZXNvbHZlIHRvIHRoZSBzYW1lIGlub2RlIGEgY2FzZS1zZW5zaXRpdmUgYmxhY2tsaXN0IHdvdWxkIG1pc3MgKG1lYXN1cmVkIG9uXG4gKiBhbGwgZml2ZSBzcGVsbHMgYmVmb3JlIHRoaXMgZml4OiBmb3VyIHZhcmlhbnRzLCBmb3VyIDIwMHMsIHRocmVlIG9mIHRoZW0gYXNcbiAqIGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gIGJlY2F1c2UgdGhlIGNvbnRlbnQtdHlwZSBsb29rdXAgaXMgY2FzZS1zZW5zaXRpdmVcbiAqIHRvbykuIEEgc2V0IG9mIGV4YWN0bHkgdGhlIGVtaXR0ZWQgbmFtZXMgcmVmdXNlcyBldmVyeSB2YXJpYW50IG9mIGV2ZXJ5IG5hbWVcbiAqIOKAlCBzZXJ2YWJsZSBvciBub3Qg4oCUIHdpdGggbm8gbG93ZXItY2FzZSBwYXNzIGFueXdoZXJlLlxuICpcbiAqIOKaoCAqKlRIRSBUUkFERToqKiBhIGZpbGUgdGhlIGVudHJ5IGdyYXBoIGRvZXMgbm90IHJlZmVyZW5jZSDigJQgYSBsYXppbHkgZmV0Y2hlZFxuICogY2h1bmssIGEgZm9udCBwdWxsZWQgYnkgYSBDU1MgYHVybCgpYCB0aGlzIHNjYW4gZG9lcyBub3QgbW9kZWwsIGFuIGFzc2V0IHRoZVxuICogYnVpbGQgZW1pdHMgYnV0IG5vdGhpbmcgbGlua3Mg4oCUIDQwNHMgaW4gcmVsZWFzZSB3aXRoIG5vdGhpbmcgcmVkLiBFYWNoXG4gKiBhZG9wdGVyJ3MgYHJlbGVhc2Utc2VydmUudGVzdC50c2AgaG9sZHMgdGhlIGluc3RydW1lbnQ6IGFuIElOVkVOVE9SWSBjZWxsIHRoYXRcbiAqIGFjY291bnRzIGZvciBldmVyeSBmaWxlIGluIGBkaXN0L2AgYXMgc2VydmVkIG9yIGRlbGliZXJhdGVseSByZWZ1c2VkLCBzbyBhblxuICogdW5saW5rZWQgZW1pc3Npb24gZ29lcyByZWQgYXQgYnVpbGQgdGltZSByYXRoZXIgdGhhbiBzaWxlbnQgYXQgcnVudGltZS5cbiAqXG4gKiDimqAgVGhlIGVudHJ5IGRvY3VtZW50IGlzIElOIHRoZSBzZXQsIGJlY2F1c2UgdGhlIGhvdXNlIGNhbGxlciBtYXBzIGAvYCB0b1xuICogYGluZGV4Lmh0bWxgIGFuZCB0aGF0IGlzIHRoZSBzdXJmYWNlLiBBIHNwZWxsIHRoYXQgbXVzdCBuZXZlciBoYW5kIG92ZXIgaXRzXG4gKiBvbi1kaXNrIGVudHJ5IOKAlCBkaWdlc3RpZnkgc3Vic3RpdHV0ZXMgYSBwYXlsb2FkIGludG8gaXQgaW4gbWVtb3J5IOKAlCByZWZ1c2VzXG4gKiB0aGF0IE9ORSBuYW1lIGluIGl0cyBvd24gcm91dGVyLCBhYm92ZSB0aGlzIGNhbGwuIFRoYXQgcmVmdXNhbCBpcyB0aGUgc3BlbGwncztcbiAqIGV2ZXJ5dGhpbmcgZWxzZSBoZXJlIGlzIHRoZSBraXQncy5cbiAqL1xuZnVuY3Rpb24gc3VyZmFjZVdoaXRlbGlzdChkaXN0RGlyOiBzdHJpbmcpOiBSZWFkb25seVNldDxzdHJpbmc+IHtcbiAgY29uc3QgY2FjaGVkID0gd2hpdGVsaXN0Q2FjaGUuZ2V0KGRpc3REaXIpO1xuICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkO1xuXG4gIGNvbnN0IG5hbWVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGVudHJ5ID0gam9pbihkaXN0RGlyLCBcImluZGV4Lmh0bWxcIik7XG4gIGlmIChleGlzdHNTeW5jKGVudHJ5KSkge1xuICAgIG5hbWVzLmFkZChcImluZGV4Lmh0bWxcIik7XG4gICAgY29uc3QgaHRtbCA9IHJlYWRGaWxlU3luYyhlbnRyeSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHBlbmRpbmcgPSBbLi4ucmVmc0luKGh0bWwsIEVOVFJZX1JFRl9SRSksIC4uLnJlZnNJbihodG1sLCBSRUxBVElWRV9SRUZfUkUpXTtcbiAgICAvLyBVbnRpbCB0aGUgc2V0IHN0b3BzIGdyb3dpbmc6IGVhY2ggYWRtaXR0ZWQgY2h1bmsgbWF5IG5hbWUgdGhlIG5leHQgb25lLlxuICAgIHdoaWxlIChwZW5kaW5nLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IG5hbWUgPSBwZW5kaW5nLnBvcCgpIGFzIHN0cmluZztcbiAgICAgIGlmIChuYW1lcy5oYXMobmFtZSkpIGNvbnRpbnVlO1xuICAgICAgLy8g4pqgIFJFRkVSRU5DRUQgKipBTkQqKiBQUkVTRU5ULiBBIG1pbmlmaWVkIGJ1bmRsZSBjYW4gY29udGFpbiBhIHN0cmluZ1xuICAgICAgLy8gdGhhdCBtZXJlbHkgTE9PS1MgbGlrZSBvbmU7IGFkbWl0dGluZyBvbmx5IG5hbWVzIHRoYXRcbiAgICAgIC8vIGFyZSBhY3R1YWxseSBvbiBkaXNrIGtlZXBzIHRoZSBzY2FuIGZyb20gd2lkZW5pbmcgdGhlIHNldCBvbiBhXG4gICAgICAvLyBjb2luY2lkZW5jZSwgYW5kIGEgbmFtZSB0aGF0IGlzIGFic2VudCA0MDRzIGlkZW50aWNhbGx5IGVpdGhlciB3YXkuXG4gICAgICBjb25zdCBmaWxlID0gam9pbihkaXN0RGlyLCBuYW1lKTtcbiAgICAgIGlmICghZXhpc3RzU3luYyhmaWxlKSkgY29udGludWU7XG4gICAgICBuYW1lcy5hZGQobmFtZSk7XG4gICAgICBpZiAoIVRSQU5TSVRJVkVfRVhUUy5zb21lKChleHQpID0+IG5hbWUuZW5kc1dpdGgoZXh0KSkpIGNvbnRpbnVlO1xuICAgICAgcGVuZGluZy5wdXNoKC4uLnJlZnNJbihyZWFkRmlsZVN5bmMoZmlsZSwgXCJ1dGY4XCIpLCBSRUxBVElWRV9SRUZfUkUpKTtcbiAgICB9XG4gIH1cblxuICB3aGl0ZWxpc3RDYWNoZS5zZXQoZGlzdERpciwgbmFtZXMpO1xuICByZXR1cm4gbmFtZXM7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIHNlcnZlciBzaWRlIG9mIHRoZSBTU0UgdGFpbCDigJQgdGhlIGRhZW1vbi1zaWRlIHR3aW4gb2ZcbiAqIGB0YWlsRXZlbnRzLnRzYC4gVGhhdCBtb2R1bGUgZGVjaWRlcyB3aGF0IGEgY2FsbGVyIG9ic2VydmVzOyB0aGlzIG9uZSBkZWNpZGVzXG4gKiB3aGF0IGEgY2FsbGVyIGlzIHNlbnQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgZXhjZXB0IGl0c1xuICogb3duIHNpYmxpbmcgdHlwZXMsIHdoaWNoIGlzIHN0aWxsIGluc2lkZSB0aGUgbGVhZi5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgbWluZC1tYXBwZXIncyBgc3NlUmVzcG9uc2VgLFxuICogdGhlIGNlbnN1cydzIGNvbnZlcmdlbmNlIHRhcmdldCAjMTogdGhlIG9ubHkgb25lIG9mIHRoZSBzZXZlbiB3aXRoIGFcbiAqIG9uY2Utb25seSB0ZWFyZG93biBmdW5uZWwsIHRoZSBvbmx5IG9uZSB3aXJlZCB0byBgcmVxLnNpZ25hbGAsIGFuZCB0aGUgb25seVxuICogb25lIHdob3NlIGNvbW1lbnQgcmVjb3JkcyBhIE1FQVNVUkVEIHJlc3VsdCByYXRoZXIgdGhhbiBhIGJlbGllZi5cbiAqXG4gKiDilIDilIAg4puUIEFORCBXSEFUIFRIRSBDT1BZIExFRlQgQkVISU5ELCBTQUlEIEhFUkUgQkVDQVVTRSBBIExPU1MgUkVDT1JERUQgT05MWSBJTlxuICogICAgQSBQT1JUJ1MgSk9VUk5BTCBHRVRTIFJFLUxJVElHQVRFRCBCWSBFVkVSWSBTUEVMTCBBRlRFUiBJVCAoRDc5L0Q4NSkg4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHNlbnRlbmNlIGFib3ZlIG5hbWVzIGEgU09VUkNFIHRoaXMgbW9kdWxlIGhhZCBuZXZlciBiZWVuIGNoZWNrZWQgYWdhaW5zdDpcbiAqIEQxIHJ1bGVkIHRoZSBzcGluZSBiZSBwcm92ZW4gb24gdGhlIHR3byBzcGVsbHMgdGhhdCBhbHJlYWR5IGJ1aWx0LCBhbmQgYm90aCBvZlxuICogdGhvc2UgYXJlIGRvd25zdHJlYW0gRk9SS1Mgb2YgdGhlIG1pbmQtbWFwcGVyIGxpbmUsIHNvIHRoZSBib3VuZGFyaWVzIHdlcmVcbiAqIHNldHRsZWQgYWdhaW5zdCB0d28gY29waWVzIHdoaWxlIHRoZSBvcmlnaW5hbCB3YXMgbm90IGluIHRoZSByb29tLiAqKkFcbiAqIGNvbnZlcmdlbmNlIGNhbiBuYW1lIGl0cyBzb3VyY2UgYW5kIHN0aWxsIG5ldmVyIGNvbnN1bHQgaXQuKipcbiAqXG4gKiBXaGVuIGl0IHdhcyBmaW5hbGx5IGNvbnN1bHRlZCAoUGhhc2UgNywgdGhlIGxhc3QgcG9ydCksIGV4YWN0bHkgT05FIHByb3BlcnR5XG4gKiBvZiB0aGUgc291cmNlIHdhcyBtaXNzaW5nIGhlcmUsIGFuZCBpdCBvY2N1cGllZCBubyB0eXBlOiAqKm1pbmQtbWFwcGVyIHdyb3RlXG4gKiBpdHMgYHRhaWwgLS1pbmJvdW5kYCBncm91bmRpbmcgZnJhbWUgQkVGT1JFIHRoZSByZXBsYXkqKiDigJQgb25lIGxpbmUgYWJvdmVcbiAqIGBidXMuc3Vic2NyaWJlYCDigJQgc28gaXQgd2FzIHRoZSBzdHJlYW0ncyBmaXJzdCBkYXRhIGxpbmUuIGBvbk9wZW5gIGZpcmVzIGF0XG4gKiB0aGUgRU5EIG9mIGBzdGFydGAsIGFmdGVyIHRoZSBwcmVhbWJsZSwgYWZ0ZXIgYGxvZy5zdWJzY3JpYmVgLCBhZnRlclxuICogYGNsaWVudHMuYWRkYCwgc28gYSBjYWxsZXIgdGhhdCBzdXBwbGllZCBpdHMgb3duIGBjbGllbnRzYCBzZXQgYW5kIHNlbnQgZnJvbVxuICogdGhlcmUgd291bGQgbGFuZCB0aGUgZnJhbWUgQUZURVIgdGhlIHJlcGxheWVkIGJhY2tsb2cuIFRoYXQgaXMgRVhQUkVTU0lCTEUsXG4gKiB3aGljaCBpcyB3aGF0IG1ha2VzIHRoaXMgYSBtZWFzdXJlbWVudCByYXRoZXIgdGhhbiBhbiBhc3NlcnRpb246IHRoZVxuICogcGxheWJvb2sncyB0eXBlLXRvLXR5cGUgY29tcGF0aWJpbGl0eSBwcm9jZWR1cmUgYW5zd2VycyBcInJlcHJlc2VudGFibGVcIiBoZXJlXG4gKiAodGhlIHN1YmplY3QgdHlwZSBpcyBgU2V0PFNzZUNsaWVudD5gLCB0aGUgc3BlbGwga2VlcHMgbm8gcmVnaXN0cnksIHNvIHlvdVxuICogcGFzcyBhbiBlbXB0eSBzZXQpIGFuZCBhIHR5cGUgY2hlY2sgY2Fubm90IHNlZSBhIFBPU0lUSU9OLlxuICpcbiAqICoqVGhlIGRpc3Bvc2l0aW9uIHdhcyBSRVNUT1JFLCBub3QgS0VFUC1MT0NBTCBhbmQgbm90IEZJTEUqKiDigJQgc2VlXG4gKiBgb3BlbkZyYW1lc2AgYmVsb3csIHdoZXJlIHRoZSB0d28gbnVtYmVycyB0aGF0IHBlcm1pdCBpdCBhcmUgcmVjb3JkZWQgYW5kXG4gKiBkcml2ZW4uIFRoZSBnZW5lcmFsaXNhdGlvbiwgd2hpY2ggaXMgdGhlIHBhcnQgd29ydGggY2Fycnlpbmc6IHdoZXJlIGFcbiAqIG1vZHVsZSdzIHN1YmplY3QgaXMgYSBTRVFVRU5DRSBPRiBXUklURVMsIGNvbXBhcmUgdGhlIE9SREVSIG9mIGl0cyBob29rc1xuICogYWdhaW5zdCB0aGUgb3JkZXIgdGhlIGFkb3B0aW5nIHNwZWxsIHdyaXRlcyBpbi4gVHdvIGhvb2tzIHdpdGggdGhlIHJpZ2h0XG4gKiBzaWduYXR1cmVzIGluIHRoZSB3cm9uZyBvcmRlciBhcmUgYXMgaW5jb21wYXRpYmxlIGFzIHR3byB0eXBlcyB0aGF0IHdpbGwgbm90XG4gKiB1bmlmeSwgYW5kIG9ubHkgb25lIG9mIHRoZSB0d28gY2FuIGJlIFNFRU4gYnkgYSBjb21wYXRpYmlsaXR5IGNoZWNrLlxuICpcbiAqIOKUgOKUgCDim5QgVEhFIFNDQVIsIFJFLUhPTUVEOiBgdHJ5IHsgZW5xdWV1ZSB9IGNhdGNoYCBET0VTIE5PVCBERVRFQ1QgQSBERUFEXG4gKiAgICBDTElFTlQuIE1FQVNVUkVEIE9OIEJVTiAxLjMuMTQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogU2l4IGRhZW1vbnMgd3JpdGUgYSBoZWFydGJlYXQgYXMgYHRyeSB7IGNvbnRyb2xsZXIuZW5xdWV1ZSguLi4pIH0gY2F0Y2gge31gXG4gKiB3aXRoIGEgY29tbWVudCBzYXlpbmcgdGhlIGNhdGNoIGlzIGhvdyBhIGRlcGFydGVkIGNsaWVudCBpcyBub3RpY2VkLiBJdCBpc1xuICogbm90OiBlbnF1ZXVlIG9uIGFuIG9ycGhhbmVkIHN0cmVhbSBCVUZGRVJTIFNJTEVOVExZIGFuZCBuZXZlciB0aHJvd3MsIHNvIHRoZVxuICogY2F0Y2ggbmV2ZXIgZmlyZXMgYW5kIHRob3NlIGRhZW1vbnMnIGRlYWQtY2xpZW50IGRldGVjdGlvbiByZXN0cyBvbiBhXG4gKiBtZWNoYW5pc20gdGhlaXIgb3duIGNvbW1lbnRzIGRlc2NyaWJlIGluY29ycmVjdGx5LiBXaGF0IGFjdHVhbGx5IHJlY2xhaW1zIHRoZVxuICogY29ubmVjdGlvbiBpcyB0aGUgc3RyZWFtJ3MgYGNhbmNlbCgpYCDigJQgYW5kLCBmb3IgYSBjbGllbnQgdGhhdCBuZXZlciBjbG9zZXNcbiAqIHRoZSBzb2NrZXQsIGByZXEuc2lnbmFsYC5cbiAqXG4gKiBTbyB0aGUgZnVubmVsIGJlbG93IGlzIHRoZSBsb2FkLWJlYXJpbmcgcGFydC4gYHRlYXJkb3duKClgIHJ1bnMgQVQgTU9TVCBPTkNFXG4gKiBmcm9tIGV2ZXJ5IHBhdGggdGhlcmUgaXMg4oCUIGBjYW5jZWwoKWAsIGFuIGFib3J0IG9uIHRoZSByZXF1ZXN0IHNpZ25hbCwgYW5kXG4gKiB0aGUgYmVsdC1hbmQtYnJhY2VzIGVucXVldWUgY2F0Y2gg4oCUIGFuZCBpdCBpcyB3aGVyZSB0aGUgc3Vic2NyaWJlciBjb3VudCBhbmRcbiAqIGFueSBwcmVzZW5jZSBkZWNyZW1lbnQgcmlkZS4gQm91bmRpbmcgcHJlc2VuY2UgYWNjdXJhY3kgaXMgYm91bmRpbmcgdGhhdFxuICogZnVubmVsLlxuICpcbiAqIOKaoCBLbm93biBob2xlLCBhY2NlcHRlZCBhbmQgaW5oZXJpdGVkOiBCdW4ncyBvd24gYGZldGNoKClgIHJlYWRlciBgLmNhbmNlbCgpYFxuICogY2xvc2VzIG5vdGhpbmcgY2xpZW50LXNpZGUgYW5kIHRoZSBzZXJ2ZXIgY2Fubm90IHNlZSBpdC4gUmVhbCBjbGllbnRzIGNsb3NlXG4gKiB0aGUgc29ja2V0LlxuICpcbiAqIOKUgOKUgCDim5QgR1JBUEVWSU5FIERPRVMgTk9UIEFET1BUIFRISVMsIEFORCBUSEUgUkVGVVNBTCBJUyBQQVJUIE9GIFRIRSBSVUxJTkcg4pSA4pSAXG4gKlxuICogUkVKRUNULVNUUlVDVFVSQUwsIHJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCkuXG4gKiBHcmFwZXZpbmUgSEFTIGFuIFNTRSByZWdpc3RyeSBhbmQgaXQgaXMgdGhlIGJ1c2llc3QgdGhpbmcgaW4gdGhlIHNwZWxsOyB0aGVcbiAqIHR3byB0eXBlcyBzaW1wbHkgY2Fubm90IGJlIGNvbnN0cnVjdGVkIGZyb20gZWFjaCBvdGhlcjpcbiAqXG4gKiAgIHRoaXMgbW9kdWxlICBgU3NlQ2xpZW50cyA9IFNldDxTc2VDbGllbnQ+YCB3aGVyZSBgU3NlQ2xpZW50ID0ge2Nsb3NlLCBzZW5kfWBcbiAqICAgICAgICAgICAgICAgIOKAlCBhIHJlZ2lzdHJ5IG9mIEFOT05ZTU9VUyBjbG9zZXJzLCBhbmQgYHNpemVgIGlzIHRoZSBvbmx5IHRoaW5nXG4gKiAgICAgICAgICAgICAgICBhbnkgYWRvcHRpbmcgZGFlbW9uIHJlYWRzIG9mZiBpdC5cbiAqICAgZ3JhcGV2aW5lICAgIGBNYXA8c3ltYm9sLCB7YWxpYXMsIGh1bWFuLCBsdXJrLCBzZW5kfT5gLCBwZXIgY2hhbm5lbC5cbiAqXG4gKiAqKlRoZSByZWFkZXJzIHRoYXQgbWFrZSB0aGVtIGluY29tcGF0aWJsZSwgY291bnRlZCByYXRoZXIgdGhhbiBhc3NlcnRlZDogU0lYXG4gKiByb3V0ZXMgcmVhZCBgYWxpYXNgL2BodW1hbmAvYGx1cmtgKiog4oCUIGBHRVQgL2NoYW5uZWxzYCAodGhyb3VnaFxuICogYGxpc3RDaGFubmVsc2Ag4oaSIGB2aXNpYmxlU3Vic2ApLCBgR0VUIC9wcmVzZW5jZWAsIGBQT1NUIC9jaGFubmVsc2AsXG4gKiBgUE9TVCAvYW5ub3VuY2VgLCBgUE9TVCAvY2hhbm5lbHMvOm5hbWUvbWVzc2FnZXNgLCBhbmRcbiAqIGBHRVQgL2NoYW5uZWxzLzpuYW1lL3N1YnNjcmliZXJzYC4gYGFsaWFzYCBpcyBhIG5hbWUgYSBodW1hbiBzZWVzIGluIGEgcm9zdGVyLFxuICogYGh1bWFuYCB0ZWxscyBhbiBhZ2VudCBpdCBpcyB0YWxraW5nIHRvIGEgcGVyc29uLCBhbmQgYGx1cmtgIGV4Y2x1ZGVzIGFcbiAqIGNvbm5lY3Rpb24gZnJvbSBldmVyeSBwcmVzZW5jZSBjb3VudC4gVGhlcmUgaXMgbm8gd2F5IHRvIHB1dCBhbnkgb2YgdGhhdCBpbnRvXG4gKiBhIHNldCBvZiBjbG9zZXJzLiBBZG9wdGluZyB0aGlzIG1vZHVsZSB3b3VsZCBub3QgYmUgZGVhZCBjb2RlOyBpdCB3b3VsZCBiZSBhXG4gKiByZXdyaXRlIG9mIHdoYXQgZ3JhcGV2aW5lIElTLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgTElTVCBJUyBERUxJQkVSQVRFTFkgTk9UIFRIRSBPQlZJT1VTIE9ORS4qKiBUaGUgcG9ydCdzIGZpcnN0XG4gKiBjb3VudCBuYW1lZCB0aGUgYHJvbGxgL2NsZWFyIGJyb2FkY2FzdCwgdGhlIGFyY2hpdmUgbGl2ZS1ndWFyZCBhbmQgdHdvXG4gKiBSRUdJU1RSQVRJT05TIOKAlCBhbmQgZXZlcnkgb25lIG9mIHRob3NlIGlzIGEgc2l0ZSB0aGlzIG1vZHVsZSdzIHR5cGUgd291bGRcbiAqIHNlcnZlIHBlcmZlY3RseTogdGhlIGJyb2FkY2FzdCByZWFkcyBvbmx5IGBzLnNlbmRgLCB0aGUgbGl2ZS1ndWFyZCBvbmx5XG4gKiBgc3Vic2NyaWJlcnMuc2l6ZWAgKHdoaWNoIHRoaXMgaGVhZGVyIGl0c2VsZiBzYXlzIGlzIGFsbCBhbnkgYWRvcHRlciByZWFkcyksXG4gKiBhbmQgYSByZWdpc3RyYXRpb24gV1JJVEVTIHRoZSByZWNvcmQgcmF0aGVyIHRoYW4gcmVhZGluZyBpdC4gVGhlIHNpeCBhYm92ZSBhcmVcbiAqIHRoZSBvbmVzIHRoYXQgcmVhZCBhIGZpZWxkIHRoZSBraXQncyBgU3NlQ2xpZW50YCBkb2VzIG5vdCBoYXZlOyB0aGUgd3JpdGVyc1xuICogKGAvd2FpdGAncyBwcmVzZW5jZSByZWdpc3RyYXRpb24gYW5kIHRoZSB0YWlsJ3MpIGFyZSBuYW1lZCBzZXBhcmF0ZWx5IGJlY2F1c2VcbiAqIGEgd3JpdGVyIGlzIG5vdCBldmlkZW5jZSBvZiBhbnl0aGluZy4gQ291bnRlZCBpbiB0aGUgcHJlLXBvcnQgZGFlbW9uLFxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9ncmFwZXZpbmUvc2NyaXB0cy9kYWVtb24udHNgIG9uIGBkZXZlbG9wYDpcbiAqIGwuNDIxLCA3MzktNzQ3LCA4MjYsIDg4Ni04ODcsIDEwNDktMTA1NCwgMTE4Mi0xMTg4IOKAlCB3cml0ZXJzIGF0IDExMTEtMTExMiBhbmRcbiAqIDEzMDcuIChDb3JyZWN0ZWQgMjAyNi0wOS0wOSBpbiB0aGUgcmVwYWlyIGNoYXB0ZXI7IEQ2OCdzIHJlcXVpcmVtZW50IGlzIHRoYXRcbiAqIHRoZSByZWZ1c2FsIGJlIHdyaXR0ZW4gd2hlcmUgdGhlIG5leHQgcmVhZGVyIG1lZXRzIGl0LCB3aGljaCBtYWtlcyBhXG4gKiBtaXMtbWVhc3VyZWQgbGlzdCB3b3JzZSB0aGFuIG5vbmUuKVxuICpcbiAqIOKaoCBBbmQgZ3JhcGV2aW5lJ3MgcmVjb3JkcyBjYXJyeSBubyBgY2xvc2VgIGF0IGFsbCDigJQgdGhlIHBlci1zdHJlYW0gdGVhcmRvd24gaXNcbiAqIGEgY2xvc3VyZSBzdGFzaGVkIG9uIHRoZSBSZWFkYWJsZVN0cmVhbSBjb250cm9sbGVyLCByZWFjaGFibGUgb25seSBmcm9tXG4gKiBgY2FuY2VsKClgIOKAlCB3aGljaCBpcyBhbHNvIHdoeSBgaG91c2VrZWVwaW5nYCdzIGBkcmFpbkFuZFN0b3BgIGlzIGFkb3B0ZWRcbiAqIHRoZXJlIHdpdGggaXRzIGBjbGllbnRzYCBhcmd1bWVudCBkZWxpYmVyYXRlbHkgZW1wdHkuXG4gKlxuICogKipUaGUgd2lkZW5pbmcgTk9UIGRvbmUsIHdpdGggaXRzIGNvc3Q6KiogYWRtaXR0aW5nIGFuIGFsaWFzLWJlYXJpbmcgcmVjb3JkXG4gKiB3b3VsZCBjaGFuZ2UgdGhlIHR5cGUgZml2ZSBvdGhlciBkYWVtb25zIGNvbXBpbGUgYWdhaW5zdCBhbmQgcmUtZW1pdCBTSVhcbiAqIGFydGlmYWN0cyBhY3Jvc3MgRklWRSBzcGVsbHMsIGVhY2ggb3dlZCBhIGRyaXZlLiBJdCB3b3VsZCBhbHNvIHJlLWNyZWF0ZSB0aGVcbiAqIHRoaW5nIHRoaXMgcmVnaXN0cnkgZXhpc3RzIHRvIHN0b3AsIGFuZCB0aGlzIGZpbGUncyBvd24gYm91bmRhcnkgcGFyYWdyYXBoXG4gKiBzYXlzIGhvdzogYSBzaWduYXR1cmUgd2lkZSBlbm91Z2ggdG8gYWJzb3JiIGV2ZXJ5IGNhbGxlcidzIHNoYXBlIHN0b3BzIGJlaW5nIGFcbiAqIHJlZ2lzdHJ5IGFuZCBiZWNvbWVzIGEgdW5pb24uIFRoZSBjZW5zdXMgY29udmVyZ2VkIGNvcGllcyBpbnRvIG9uZSBtb2R1bGUgYnlcbiAqIGZpbmRpbmcgd2hhdCB0aGV5IFNIQVJFRDsgYSBtb2R1bGUgd2lkZW5lZCB0byBmaXQgdGhlIG9uZSBzcGVsbCB0aGF0IHNoYXJlc1xuICogbm90aGluZyBpcyB0aG9zZSBjb3BpZXMgYWdhaW4gd2l0aCBhIHVuaW9uIHR5cGUgb3ZlciB0aGUgdG9wLiBUaGUgc3BlbGwga2VlcHNcbiAqIGl0cyBvd24sIGFuZCBhIHdpZGVuaW5nIHJlbWFpbnMgYSBzZXBhcmF0ZSwgYXJndWVkIGRlY2lzaW9uLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRXZlbnRMb2csIEZyYW1lIH0gZnJvbSBcIi4vZXZlbnRMb2cudHNcIjtcblxuLyoqXG4gKiBPbmUgb3BlbiBTU0Ugc3RyZWFtLCBhcyB0aGUgZGFlbW9uIGNhbiBhY3Qgb24gaXQ6IGVuZCBpdCwgb3IgcHVzaCBhIGZyYW1lIHRvXG4gKiBpdCB0aGF0IGRpZCBub3QgY29tZSBvdXQgb2YgdGhlIGxvZy5cbiAqXG4gKiDim5QgSVQgSVMgTk9UIEEgQ09OVFJPTExFUi4gVGhlIGNvcGllcyBoZWxkXG4gKiBgU2V0PFJlYWRhYmxlU3RyZWFtRGVmYXVsdENvbnRyb2xsZXI+YCBhbmQgY2xvc2VkIHRoZW0gZGlyZWN0bHkgYXQgdGVhcmRvd24sXG4gKiB3aGljaCBieXBhc3NlcyB0aGUgdGVhcmRvd24gZnVubmVsIGFib3ZlIOKAlCB0aGUgaGVhcnRiZWF0IGludGVydmFsIGZvciB0aGF0XG4gKiBzdHJlYW0gd2FzIGNsZWFyZWQgb25seSBiZWNhdXNlIGEgc2Vjb25kIGBTZXRgIG9mIHRpbWVycyB3YXMga2VwdCBpbiBwYXJhbGxlbFxuICogYW5kIHN3ZXB0IHNlcGFyYXRlbHkuIEV2ZXJ5dGhpbmcgaGVyZSBnb2VzIHRocm91Z2ggdGhlIGZ1bm5lbCwgYW5kIGEgYHNlbmRgXG4gKiBhZnRlciB0ZWFyZG93biBpcyBhIG5vLW9wIHJhdGhlciB0aGFuIGEgdGhyb3cuXG4gKlxuICog4pqgICoqYHNlbmRgIEFSUklWRUQgSU4gUEhBU0UgMiwgRlJPTSBUSEUgRklSU1QgQ09OU1VNRVIgVEhBVCBXQVMgTk9UIE9ORSBPRiBUSEVcbiAqIFRXTyBUSElTIE1PRFVMRSBXQVMgREVTSUdORUQgQUdBSU5TVC4qKiBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSBhbm5vdW5jZSBwcmVzZW5jZVxuICogb3ZlciB0aGVpciBicm93c2VyIFdFQlNPQ0tFVCwgc28gYSByZWdpc3RyeSBvZiBiYXJlIGNsb3NlcnMgd2FzIHN1ZmZpY2llbnQgYW5kXG4gKiB0aGUgYm91bmRhcnkgbG9va2VkIHJpZ2h0LiBnbGFtb3VyIGFubm91bmNlcyBpdCBvbiB0aGUgQUdFTlQncyBTU0UgdGFpbCDigJRcbiAqIGB7dHlwZTpcImNvbm5lY3RlZFwifWAgLyBge3R5cGU6XCJkaXNjb25uZWN0ZWRcIn1gLCBkZWxpYmVyYXRlbHkgdW5sb2dnZWQsIHNvIGFcbiAqIHJlY29ubmVjdGluZyBhZ2VudCBkb2VzIG5vdCByZS1zZWUgZXZlcnkgcGFzdCBjb25uZWN0IGFuZCBzbyB0aGUgZnJhbWUgbmV2ZXJcbiAqIGFkdmFuY2VzIGEgdGFpbCBjdXJzb3IuIFRoYXQgaXMgbm90IGEgZ2xhbW91ciBxdWlyazsgaXQgaXMgdGhlIGdlbmVyYWwgc2hhcGVcbiAqIG9mIFwidGVsbCB0aGUgbGl2ZSBzdWJzY3JpYmVycyBzb21ldGhpbmcgdGhhdCBpcyBub3QgcGFydCBvZiB0aGUgaGlzdG9yeVwiLCBhbmRcbiAqIGEgcmVnaXN0cnkgdGhhdCBjYW4gb25seSBFTkQgYSBzdHJlYW0gY2Fubm90IGV4cHJlc3MgaXQuIFdpdGhvdXQgdGhpcyB0aGVcbiAqIHNwZWxsIHdvdWxkIGhhdmUgaGFkIHRvIGtlZXAgaXRzIG93biBwYXJhbGxlbCBgU2V0YCBvZiBjb250cm9sbGVycywgd2hpY2ggaXNcbiAqIGV4YWN0bHkgdGhlIGRyaWZ0IHRoaXMgcmVnaXN0cnkgZXhpc3RzIHRvIHJlbW92ZS5cbiAqL1xuZXhwb3J0IHR5cGUgU3NlQ2xpZW50ID0ge1xuICAvKiogRW5kIHRoaXMgc3RyZWFtLCB0aHJvdWdoIHRoZSB0ZWFyZG93biBmdW5uZWwsIGF0IG1vc3Qgb25jZS4gKi9cbiAgY2xvc2UoKTogdm9pZDtcbiAgLyoqIFdyaXRlIG9uZSByYXcgU1NFIGNodW5rIHRvIHRoaXMgc3RyZWFtLiBOby1vcCBvbmNlIHRvcm4gZG93bi4gKi9cbiAgc2VuZChjaHVuazogc3RyaW5nKTogdm9pZDtcbn07XG5cbi8qKlxuICogVGhlIGxpdmUtdGFpbCByZWdpc3RyeS4gYHNpemVgIGlzIHRoZSBkYWVtb24ncyBTU0Ugc3Vic2NyaWJlciBjb3VudCDigJQgdGhlXG4gKiBudW1iZXIgYHNob3VsZElkbGVDbG9zZWAgbXVzdCBzZWUg4oCUIGFuZCBjbG9zaW5nIGV2ZXJ5IGVudHJ5IGlzIHdoYXQgYSBkcmFpblxuICogZG9lcy5cbiAqL1xuZXhwb3J0IHR5cGUgU3NlQ2xpZW50cyA9IFNldDxTc2VDbGllbnQ+O1xuXG5leHBvcnQgaW50ZXJmYWNlIFNzZU9wdGlvbnM8VCBleHRlbmRzIG9iamVjdD4ge1xuICAvKiogVGhlIGxvZyB0byByZXBsYXkgZnJvbSBhbmQgc3Vic2NyaWJlIHRvLiAqL1xuICBsb2c6IEV2ZW50TG9nPFQ+O1xuICAvKiogVGhlIGNhbGxlcidzIHJlc3VtZSBjdXJzb3IuIEFic2VudCBvciB1bnBhcnNlYWJsZSByZXBsYXlzIGZyb20gdGhlIHN0YXJ0LiAqL1xuICBzaW5jZTogbnVtYmVyO1xuICAvKiogSGVhcnRiZWF0IGNvbW1lbnQgaW50ZXJ2YWwuIE1VU1Qgc3RheSB3ZWxsIHVuZGVyIHRoZSBzZXJ2ZXInc1xuICAgKiAgYGlkbGVUaW1lb3V0YCDigJQgc2VlIGBoZWFydGJlYXQudHNgLCB3aGljaCBpcyB3aGVyZSB0aGF0IHBhaXIgbGl2ZXMuICovXG4gIGhlYXJ0YmVhdE1zOiBudW1iZXI7XG4gIC8qKiBMaXZlbmVzcyByZWdpc3RyeTsgdGhlIHN0cmVhbSBhZGRzIGl0c2VsZiBvbiBvcGVuIGFuZCByZW1vdmVzIGl0c2VsZiBpblxuICAgKiAgdGhlIHRlYXJkb3duIGZ1bm5lbC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBgcmVxLnNpZ25hbGAg4oCUIHRoZSBvbmx5IHRoaW5nIHRoYXQgcmVjbGFpbXMgYSBjbGllbnQgdGhhdCB3ZW50IGF3YXlcbiAgICogIHdpdGhvdXQgY2FuY2VsbGluZyB0aGUgc3RyZWFtLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqIFNlcnZlci1zaWRlIGZpbHRlci4gQSByZWplY3RlZCBmcmFtZSBpcyBub3Qgc2VudDsgdGhlIGNsaWVudCBzdGlsbFxuICAgKiAgYWR2YW5jZXMgaXRzIGN1cnNvciBwYXN0IGl0LCB3aGljaCBpcyBgdGFpbEV2ZW50c2AncyBkb2N1bWVudGVkIHJ1bGUuICovXG4gIGZpbHRlcj86IChmcmFtZTogRnJhbWU8VD4pID0+IGJvb2xlYW47XG4gIC8qKlxuICAgKiBSYXcgU1NFIGNodW5rcyB3cml0dGVuIHRvIFRISVMgc3RyZWFtIEJFRk9SRSB0aGUgcmVwbGF5IOKAlCBhZnRlciB0aGVcbiAgICogYFwiOiBjb25uZWN0ZWRcImAgcHJlYW1ibGUgYW5kIGJlZm9yZSBgbG9nLnN1YnNjcmliZWAsIHNvIHdoYXRldmVyIGl0IHJldHVybnNcbiAgICogaXMgdGhlIHN0cmVhbSdzIGZpcnN0IERBVEEgbGluZSByYXRoZXIgdGhhbiBhIGZyYW1lIGJ1cmllZCBiZWhpbmQgYVxuICAgKiByZXBsYXllZCBiYWNrbG9nLlxuICAgKlxuICAgKiDim5QgSVQgSVMgQSBQT1NJVElPTiwgV0hJQ0ggSVMgV0hZIGBvbk9wZW5gIENPVUxEIE5PVCBTRVJWRSAoRDg1KS4gYG9uT3BlbmBcbiAgICogZmlyZXMgYXQgdGhlIGVuZCBvZiBgc3RhcnRgIOKAlCBhZnRlciB0aGUgcHJlYW1ibGUsIGFmdGVyIGBsb2cuc3Vic2NyaWJlYCxcbiAgICogYWZ0ZXIgYGNsaWVudHMuYWRkYCDigJQgc28gYSBjYWxsZXIgdGhhdCBzdXBwbGllcyBpdHMgb3duIGBjbGllbnRzYCBzZXQgYW5kXG4gICAqIHNlbmRzIGZyb20gdGhlcmUgbGFuZHMgaXRzIGZyYW1lIEFGVEVSIHRoZSBiYWNrbG9nLiBUaGF0IGlzIGV4cHJlc3NpYmxlIGFuZFxuICAgKiBpdCBpcyB0aGUgd3Jvbmcgb3JkZXIsIHdoaWNoIGlzIHRoZSBuZWFyLW1pc3MgdGhhdCBtYWtlcyB0aGlzIGEgbWVhc3VyZW1lbnRcbiAgICogcmF0aGVyIHRoYW4gYW4gYXNzZXJ0aW9uOiBub3RoaW5nIGFib3V0IHRoZSBUWVBFUyBwcmV2ZW50cyBpdCwgYW5kIGFcbiAgICogdHlwZS10by10eXBlIGNvbXBhdGliaWxpdHkgY2hlY2sgY2Fubm90IHNlZSBhIHBvc2l0aW9uLlxuICAgKlxuICAgKiDim5QgUkVTVE9SRUQgRlJPTSBUSEUgU1BFTEwgVEhJUyBNT0RVTEUgV0FTIENPTlZFUkdFRCBUT1dBUkQsIEFORCBJVCBJUyBBXG4gICAqIFJFU1RPUkFUSU9OIFJBVEhFUiBUSEFOIEEgV0lERU5JTkcgT04gVFdPIE1FQVNVUkVEIE5VTUJFUlMgKEQ3OS9EODUpLlxuICAgKiBtaW5kLW1hcHBlcidzIGBzc2VSZXNwb25zZWAgd3JvdGUgaXRzIGB0YWlsIC0taW5ib3VuZGAgZ3JvdW5kaW5nIGZyYW1lIG9uZVxuICAgKiBsaW5lIEFCT1ZFIGBidXMuc3Vic2NyaWJlYDsgdGhpcyBtb2R1bGUncyBjb252ZXJnZW5jZSBkcm9wcGVkIHRoZSBwb3NpdGlvbixcbiAgICogc28gdGhlIG9ubHkgcHJvcGVydHkgbWluZC1tYXBwZXIgY291bGQgbm90IGFkb3B0IHdhcyB0aGUgb3JkZXJpbmcuIEFwcGxpZWQsXG4gICAqIHdpdGggZXZlcnkga2l0LWJ1bmRsaW5nIHNwZWxsIHJlYnVpbHQ6ICoqKGEpIHNvdXJjZSBlZGl0cyBuZWVkZWQgYXQgdGhlXG4gICAqIG90aGVyIGZpdmUgYWRvcHRlcnM6IFpFUk8qKiDigJQgdGhlIGZpZWxkIGlzIG9wdGlvbmFsIGFuZCBub2JvZHkgcGFzc2VzIGl0O1xuICAgKiAqKihiKSBieXRlcyBvZiBhbnkgb3RoZXIgYWRvcHRlcidzIFdJUkUgdGhhdCBkaWZmZXI6IFpFUk8qKiDigJQgYXN0cm9sYWJlLFxuICAgKiBib3VudHksIGdsYW1vdXIsIGltYWdvIGFuZCBtYWdwaWUgd2VyZSBkcml2ZW4gdW5kZXIgdGhlaXIgb3duIHN1aXRlcyBhbmRcbiAgICogdGhlaXIgcmVsZWFzZSBkcml2ZXMsIGFuZCBub25lIG9mIHRoZW0gd3JpdGVzIGF0IG9wZW4uIEJvdGggbnVtYmVycyB6ZXJvIGlzXG4gICAqIHdoYXQgXCJ0aGUga2l0IHJlbW92ZWQgaXQgd2hlbiBpdCBjb3BpZWRcIiBtZWFucyBvcGVyYXRpb25hbGx5LlxuICAgKlxuICAgKiDimqAgQU5EIFRIRSBIT09LIFdBUyBSRUpFQ1RFRCBPTkNFLCBGT1IgQSBSRUFTT04gVEhBVCBET0VTIE5PVCBSRUFDSCBUSElTXG4gICAqIENBU0UuIEQzMidzIG5vdC10YWtlbiBhcmd1ZWQgYWdhaW5zdCBcImEgYHNzZVJlc3BvbnNlYCBob29rIHRoYXQgaGFuZHMgdGhlXG4gICAqIGNhbGxlciBhIHJhdyBgc2VuZGAg4oCmIHRoZSBjYWxsZXIgdGhlbiBoYXMgdG8ga2VlcCBpdHMgb3duIGNvbGxlY3Rpb24gb2ZcbiAgICogdGhlbVwiIOKAlCBhZ2FpbnN0IGdsYW1vdXIncyBwcmVzZW5jZSBCUk9BRENBU1QsIHdoaWNoIHB1c2hlcyB0b1xuICAgKiBhbHJlYWR5LW9wZW4gc3RyZWFtcyBmcm9tIG91dHNpZGUgYW5kIGRvZXMgbmVlZCBhIGNvbGxlY3Rpb24uIFRoaXMgaXMgb25lXG4gICAqIGZyYW1lLCBvbiBvbmUgc3RyZWFtLCBhdCBvcGVuLCBhbmQgdGhlIGNhbGxlciBrZWVwcyBubyBjb2xsZWN0aW9uIGF0IGFsbC5cbiAgICogQSByZWplY3Rpb24gaXMgc2NvcGVkIHRvIHRoZSBjYXNlIHRoYXQgcHJvZHVjZWQgaXQuXG4gICAqL1xuICBvcGVuRnJhbWVzPzogKCkgPT4gc3RyaW5nW107XG4gIC8qKiBSdW4gYWZ0ZXIgdGhlIHN0cmVhbSBpcyBzdWJzY3JpYmVkIChwcmVzZW5jZSB1cCwgYWN0aXZpdHkgdG91Y2gpLiAqL1xuICBvbk9wZW4/OiAoKSA9PiB2b2lkO1xuICAvKiogUnVuIGV4YWN0bHkgb25jZSwgZnJvbSB3aGljaGV2ZXIgdGVhcmRvd24gcGF0aCBmaXJlcyBmaXJzdC4gKi9cbiAgb25DbG9zZT86ICgpID0+IHZvaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzc2VSZXNwb25zZTxUIGV4dGVuZHMgb2JqZWN0PihvcHRzOiBTc2VPcHRpb25zPFQ+KTogUmVzcG9uc2Uge1xuICBjb25zdCB7IGxvZywgc2luY2UsIGhlYXJ0YmVhdE1zLCBjbGllbnRzLCBzaWduYWwsIGZpbHRlciwgb3BlbkZyYW1lcywgb25PcGVuLCBvbkNsb3NlIH0gPSBvcHRzO1xuXG4gIGxldCB1bnN1YnNjcmliZTogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGxldCBrZWVwYWxpdmU6IFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPiB8IG51bGwgPSBudWxsO1xuICBsZXQgY2xvc2VkID0gZmFsc2U7XG4gIC8vIFRoZSByZWdpc3RyeSBlbnRyeSBmb3IgVEhJUyBzdHJlYW0uIEl0cyBtZXRob2RzIGFyZSBmaWxsZWQgaW4gYnkgYHN0YXJ0YCxcbiAgLy8gd2hpY2ggaXMgd2hlcmUgdGhlIGNvbnRyb2xsZXIgZXhpc3RzOyB0aGUgb2JqZWN0IGlkZW50aXR5IGlzIHN0YWJsZSBmcm9tXG4gIC8vIGhlcmUgc28gYHRlYXJkb3duYCBjYW4gcmVtb3ZlIGV4YWN0bHkgdGhpcyBlbnRyeS5cbiAgY29uc3QgY2xpZW50OiBTc2VDbGllbnQgPSB7IGNsb3NlOiAoKSA9PiB7fSwgc2VuZDogKCkgPT4ge30gfTtcblxuICBjb25zdCB0ZWFyZG93biA9ICgpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBpZiAoa2VlcGFsaXZlICE9PSBudWxsKSBjbGVhckludGVydmFsKGtlZXBhbGl2ZSk7XG4gICAgdW5zdWJzY3JpYmU/LigpO1xuICAgIGNsaWVudHM/LmRlbGV0ZShjbGllbnQpO1xuICAgIG9uQ2xvc2U/LigpO1xuICB9O1xuXG4gIGNvbnN0IHN0cmVhbSA9IG5ldyBSZWFkYWJsZVN0cmVhbSh7XG4gICAgc3RhcnQoY29udHJvbGxlcikge1xuICAgICAgY29uc3QgZW5jb2RlciA9IG5ldyBUZXh0RW5jb2RlcigpO1xuICAgICAgY29uc3Qgc2FmZUVucXVldWUgPSAoY2h1bms6IHN0cmluZykgPT4ge1xuICAgICAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29udHJvbGxlci5lbnF1ZXVlKGVuY29kZXIuZW5jb2RlKGNodW5rKSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHRlYXJkb3duKCk7XG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBjbGllbnQuY2xvc2UgPSAoKSA9PiB7XG4gICAgICAgIHRlYXJkb3duKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29udHJvbGxlci5jbG9zZSgpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAvKiBhbHJlYWR5IGNsb3NlZCBieSB0aGUgcnVudGltZSAqL1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgLy8g4puUIGBzZW5kYCBHT0VTIFRIUk9VR0ggYHNhZmVFbnF1ZXVlYCwgc28gYW4gb3V0LW9mLWJhbmQgZnJhbWUgb2JleXMgdGhlXG4gICAgICAvLyBzYW1lIGNsb3NlZC1jaGVjayBhbmQgdGhlIHNhbWUgdGVhcmRvd24tb24tdGhyb3cgYXMgYSBsb2dnZWQgb25lLiBBXG4gICAgICAvLyBkYWVtb24gbXVzdCBub3QgYmUgYWJsZSB0byB3cml0ZSB0byBhIHN0cmVhbSB0aGlzIG1vZHVsZSBoYXMgdG9ybiBkb3duLlxuICAgICAgY2xpZW50LnNlbmQgPSBzYWZlRW5xdWV1ZTtcblxuICAgICAgLy8g4puUIEFOIE9QRU5JTkcgQ09NTUVOVCwgQkVGT1JFIEFOWVRISU5HIEVMU0UuIEl0IGZsdXNoZXMgdGhlIHJlc3BvbnNlXG4gICAgICAvLyBoZWFkZXJzIGltbWVkaWF0ZWx5OiBzb21lIEhUVFAgY2xpZW50cyDigJQgQnVuJ3Mgb3duIGBmZXRjaCgpYCBpbmNsdWRlZCDigJRcbiAgICAgIC8vIGJ1ZmZlciB1bnRpbCB0aGUgZmlyc3QgYnl0ZSBvZiBib2R5IGFycml2ZXMsIHNvIGEgZ2VudWluZWx5IHF1aWV0IFNTRVxuICAgICAgLy8gc3RyZWFtIHdvdWxkIG90aGVyd2lzZSBsZWF2ZSB0aGUgY2FsbGVyJ3MgYGZldGNoKClgIHVucmVzb2x2ZWQuIEV2ZXJ5XG4gICAgICAvLyBob3VzZSB0YWlsIGNsaWVudCByZWFkcyBgOmAgbGluZXMgYXMgY29tbWVudHMgYW5kIGRyb3BzIHRoZW0uXG4gICAgICBzYWZlRW5xdWV1ZShcIjogY29ubmVjdGVkXFxuXFxuXCIpO1xuXG4gICAgICAvLyDim5QgQkVGT1JFIFRIRSBSRVBMQVksIEFORCBUSEUgT1JERVIgSVMgVEhFIFdIT0xFIFBPSU5UIOKAlCBzZWVcbiAgICAgIC8vIGBvcGVuRnJhbWVzYCBpbiB0aGUgb3B0aW9ucyBhYm92ZS4gQSBncm91bmRpbmcgZnJhbWUgd3JpdHRlbiBoZXJlIGlzXG4gICAgICAvLyB0aGUgc3RyZWFtJ3MgZmlyc3QgZGF0YSBsaW5lOyB3cml0dGVuIGZyb20gYG9uT3BlbmAgaXQgYXJyaXZlcyBhZnRlclxuICAgICAgLy8gdGhlIHJlcGxheWVkIGJhY2tsb2csIHdoaWNoIGlzIGEgZGlmZmVyZW50IGNvbnRyYWN0IHdlYXJpbmcgdGhlIHNhbWVcbiAgICAgIC8vIHR5cGVzLlxuICAgICAgaWYgKG9wZW5GcmFtZXMpIGZvciAoY29uc3QgY2h1bmsgb2Ygb3BlbkZyYW1lcygpKSBzYWZlRW5xdWV1ZShjaHVuayk7XG5cbiAgICAgIHVuc3Vic2NyaWJlID0gbG9nLnN1YnNjcmliZShzaW5jZSwgKGZyYW1lKSA9PiB7XG4gICAgICAgIGlmIChmaWx0ZXIgJiYgIWZpbHRlcihmcmFtZSkpIHJldHVybjtcbiAgICAgICAgc2FmZUVucXVldWUoYGRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZnJhbWUpfVxcblxcbmApO1xuICAgICAgfSk7XG5cbiAgICAgIGtlZXBhbGl2ZSA9IHNldEludGVydmFsKCgpID0+IHNhZmVFbnF1ZXVlKFwiOiBoYlxcblxcblwiKSwgaGVhcnRiZWF0TXMpO1xuICAgICAgc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgdGVhcmRvd24sIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgIGNsaWVudHM/LmFkZChjbGllbnQpO1xuICAgICAgb25PcGVuPy4oKTtcbiAgICB9LFxuICAgIGNhbmNlbCgpIHtcbiAgICAgIHRlYXJkb3duKCk7XG4gICAgfSxcbiAgfSk7XG5cbiAgcmV0dXJuIG5ldyBSZXNwb25zZShzdHJlYW0sIHtcbiAgICBoZWFkZXJzOiB7XG4gICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcInRleHQvZXZlbnQtc3RyZWFtXCIsXG4gICAgICBcIkNhY2hlLUNvbnRyb2xcIjogXCJuby1jYWNoZVwiLFxuICAgICAgQ29ubmVjdGlvbjogXCJrZWVwLWFsaXZlXCIsXG4gICAgfSxcbiAgfSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhlYXJ0YmVhdCAvIGlkbGUtdGltZW91dCAvIHRhaWwtd2F0Y2hkb2cgdHJpcGxlIOKAlCB0aHJlZSBudW1iZXJzIHRoYXQgYXJlXG4gKiBPTkUgaW52YXJpYW50LCB3cml0dGVuIG9uY2UuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgTU9EVUxFIEVYSVNUUyBBVCBBTEwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHRocmVlIG51bWJlcnMgYXJlIGNoYWluZWQsIGFuZCB0aGUgY2hhaW4gaXMgd2hhdCBub2JvZHkgY291bGQgc2VlOlxuICpcbiAqICAgICBzZXJ2ZXIgaWRsZVRpbWVvdXQgID4gIFNTRSBoZWFydGJlYXQgIMK3ICB0YWlsIHdhdGNoZG9nICA+ICBTU0UgaGVhcnRiZWF0XG4gKlxuICogLSAqKmBpZGxlVGltZW91dGAgPiBoZWFydGJlYXQqKiwgb3IgQnVuIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlXG4gKiAgIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXMgc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcy4gTUVBU1VSRUQ6IEJ1bidzXG4gKiAgIGRlZmF1bHQgcmVxdWVzdCBgaWRsZVRpbWVvdXRgIGlzIDEwIHMgYW5kIGEgU0VSVkVSLVNFTlQgaGVhcnRiZWF0IGRvZXMgbm90XG4gKiAgIHJlc2V0IGl0LCBzbyBhIDE1IHMgYDogaGJgIGFycml2ZXMgZml2ZSBzZWNvbmRzIGFmdGVyIHRoZSB0aGluZyBpdCB3YXNcbiAqICAga2VlcGluZyBhbGl2ZSBpcyBnb25lIOKAlCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IFJBVEUgd291bGQgbm90XG4gKiAgIGhhdmUgaGVscGVkLiBGb3VyIHNwZWxscyBoYWQgaGl0IHRoaXMgYW5kIHJlcGFpcmVkIGl0LCB0aHJlZSBoYWQgbm90LlxuICogLSAqKndhdGNoZG9nID4gaGVhcnRiZWF0KiosIG9yIGEgaGVhbHRoeS1idXQtcXVpZXQgdGFpbCBhYm9ydHMgYW5kIHJlY29ubmVjdHNcbiAqICAgZm9yZXZlci4gTUVBU1VSRUQgb24gYXN0cm9sYWJlOiB3aXRoIGEgaGFyZC1jb2RlZCA0NSBzIHdhdGNoZG9nIGFuZCBhblxuICogICBlbnYtdHVuZWQgaGVhcnRiZWF0LCByZWNvbm5lY3RzIGxhbmRlZCBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3Ljkgc1xuICogICBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLiBJdCB3YXMgaGFybWxlc3Mgb25seSBiZWNhdXNlIGEgVEhJUkRcbiAqICAgY29uc3RhbnQg4oCUIGEgcHJlc2VuY2UgZGVib3VuY2Ugd2l0aCBubyByZWxhdGlvbnNoaXAgdG8gZWl0aGVyIOKAlCBoYXBwZW5lZCB0b1xuICogICBhYnNvcmIgdGhlIGNodXJuLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VBTSBJUyBUSEUgUE9JTlQuKiogVW50aWwgUGhhc2UgMWIgdGhlIHdhdGNoZG9nIGxpdmVkIGluIGVhY2hcbiAqIHNwZWxsJ3MgQ0xJIGFuZCB0aGUgaGVhcnRiZWF0IGluIGVhY2ggc3BlbGwncyBkYWVtb24sIGFuZCBCT1RIIGZpbGVzIGNhcnJpZWQgYVxuICogY29tbWVudCBzYXlpbmcgdGhlIGV4cHJlc3Npb25zIHdlcmUgaGFuZC1taXJyb3JlZCBhY3Jvc3MgYSBib3VuZGFyeSB0aGUgQ0xJXG4gKiBjb3VsZCBub3QgY3Jvc3Mg4oCUIGltcG9ydGluZyB0aGUgZGFlbW9uIHdvdWxkIGhhdmUgZHJhZ2dlZCB0aGUgd2hvbGUgc2VydmVyXG4gKiBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIFRoaXMgbW9kdWxlIGlzIHRoZSBjcm9zc2luZzogaXQgaG9sZHMgbm8gc3BlbGwnc1xuICogbnVtYmVycywgb25seSB0aGUgZGVyaXZhdGlvbnMsIGFuZCBlYWNoIHNwZWxsJ3Mgb3duIHRpbnkgYGhlYXJ0YmVhdC50c2BcbiAqIGJlc2lkZSBpdHMgZGFlbW9uIGhvbGRzIHRoZSB2YWx1ZXMgdGhhdCBCT1RIIGhhbHZlcyB0aGVuIGltcG9ydC4gQSB2YWx1ZSB0aGF0XG4gKiBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqL1xuXG4vKiogQnVuJ3MgbWF4aW11bSBgaWRsZVRpbWVvdXRgLCBpbiBzZWNvbmRzLiBgMGAgaXMgbm90IFwiZGlzYWJsZWRcIiDigJQgaXQgaXMgdGhlXG4gKiAgZGVmYXVsdCDigJQgc28gdGhlIHdheSB0byBob2xkIGEgY29ubmVjdGlvbiBvcGVuIGlzIHRvIGFzayBmb3IgdGhlIG1heGltdW0uICovXG5leHBvcnQgY29uc3QgTUFYX0lETEVfVElNRU9VVF9TRUMgPSAyNTU7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCBoZWFydGJlYXQsIGluIG1zLiBTaXggb2YgdGhlIGVpZ2h0IGRhZW1vbnMgd3JpdGUgMTUgcy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0hFQVJUQkVBVF9NUyA9IDE1XzAwMDtcblxuLyoqIEhvdyBtYW55IG1pc3NlZCBiZWF0cyB0aGUgdGFpbCB3YXRjaGRvZyB0b2xlcmF0ZXMgYmVmb3JlIGl0IGFib3J0cyBhbmRcbiAqICByZWNvbm5lY3RzLiBUaHJlZSwgZXZlcnl3aGVyZSwgYW5kIGl0IGlzIGEgZmxvb3Igbm90IGEgdGFzdGU6IGhvbGRpbmcgdGhlXG4gKiAgY29ubmVjdGlvbiBvcGVuIElTIGEgYGpvaW5gJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGFcbiAqICBjYXJkIGluIGEgaHVtYW4ncyB2aWV3LiBJdCBzdGlsbCB3YW50cyBhIHdhdGNoZG9nIOKAlCBhIHdlZGdlZCBoYWxmLW9wZW4gc29ja2V0XG4gKiAgc2hvd3MgYSBjYXJkIGFzIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHRoZSB3b3JzZSBsaWUuICovXG5leHBvcnQgY29uc3QgTUlTU0VEX0JFQVRTID0gMztcblxuLyoqXG4gKiBUaGUgc21hbGxlc3QgYmVhdCB0aGlzIG1vZHVsZSB3aWxsIGhhbmQgYmFjaywgaW4gbXMg4oCUIHRoZSBGTE9PUiBoYWxmIG9mIHRoZVxuICogY2xhbXAgd2hvc2UgY2VpbGluZyBpcyBgaWRsZVRpbWVvdXQgLyAyYC5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgYGludE9yYCBQQVJTRVMgV0lUSCBgcGFyc2VJbnRgLCBBTkQgYHBhcnNlSW50YCBJUyBMRU5JRU5UXG4gKiBXSEVSRSBJVCBNQVRURVJTIE1PU1QuIGBpbnRPcmAgZmFsbHMgYmFjayBzYWZlbHkgb24gZXZlcnl0aGluZyB0aGF0IExPT0tTXG4gKiBob3N0aWxlIOKAlCBgXCJcImAsIGBcIjBcImAsIGBcIi0xXCJgLCBgXCJhYmNcImAsIGBcIk5hTlwiYCwgYFwiSW5maW5pdHlcImAgYWxsIHRha2UgdGhlXG4gKiBmYWxsYmFjayDigJQgYW5kIHRoZW4gcmVhZHMgYFwiMWU5XCJgLCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0XG4gKiBodWdlXCIsIGFzICoqMSoqLiBNRUFTVVJFRCBhdCBncmFwZXZpbmUncyBQaGFzZSA2IHJlcGFpciwgYmVmb3JlIHRoaXMgZmxvb3I6XG4gKiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4IGtlZXBhbGl2ZSBjb21tZW50cyBpbnRvIGV2ZXJ5IG9wZW4gU1NFXG4gKiBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAgZ2l2ZXMgMyBtcyBhbmQgYFwiNWFiY1wiYCBnaXZlcyA1IG1zIHRoZSBzYW1lIHdheS5cbiAqIEEga25vYiB3aG9zZSBmYXN0ZXN0IHNldHRpbmcgaXMgc3BlbGxlZCBsaWtlIGl0cyBzbG93ZXN0IGlzIGEgZmxvb2QuXG4gKlxuICog4pqgICoqVEhFIEZMT09SIElTIEhFUkUgQU5EIE5PVCBJTiBgaW50T3JgIOKAlCB0aGF0IGlzIHRoZSBydWxpbmcsIG5vdCBhblxuICogYWNjaWRlbnQgb2Ygd2hlcmUgaXQgd2FzIGVhc3kgdG8gd3JpdGUqKiAoRDc2KS4gYGludE9yYCBpcyB0aGUgZ2VuZXJhbCBwYXJzZXJcbiAqIGJlaGluZCBldmVyeSBlbnYga25vYiBpbiB0aGUga2l0OyB0aGVyZSBpcyBubyBzaW5nbGUgcm9zdGVyLWNvcnJlY3QgbWluaW11bVxuICogZm9yIFwiYSBwb3NpdGl2ZSBpbnRlZ2VyXCIsIGFuZCB0aWdodGVuaW5nIGl0cyBQQVJTRSAocmVqZWN0aW5nIGAxZTlgIG91dHJpZ2h0KVxuICogd291bGQgY2hhbmdlIHdoYXQgZXZlcnkgb3RoZXIga25vYiBhY2NlcHRzLCBzaWxlbnRseSwgZm9yIHZhbHVlcyBub2JvZHkgaGFzXG4gKiBhdWRpdGVkLiBgaGVhcnRiZWF0TXNgIGFscmVhZHkgb3ducyBvbmUgZW5kIG9mIHRoaXMgaW52YXJpYW50LCBhbmQgNTAwIHdhc1xuICogYWxyZWFkeSB3cml0dGVuIGludG8gaXQgYXMgdGhlIHNtYWxsZXN0IGNlaWxpbmcgaXQgd291bGQgY29tcHV0ZS4gVGhlIGZsb29yXG4gKiBiZWxvbmdzIGJlc2lkZSB0aGUgY2VpbGluZywgd2hlcmUgdGhlIHF1YW50aXR5IGlzIGtub3duLlxuICovXG5leHBvcnQgY29uc3QgTUlOX0hFQVJUQkVBVF9NUyA9IDUwMDtcblxuLyoqIFBhcnNlIGEgcG9zaXRpdmUgaW50ZWdlciBmcm9tIGFuIGVudiB2YWx1ZSwgZmFsbGluZyBiYWNrIG9uIGFueXRoaW5nIHRoYXQgaXNcbiAqICBhYnNlbnQsIGVtcHR5LCBub24tbnVtZXJpYyBvciBub24tcG9zaXRpdmUuIOKaoCBgcGFyc2VJbnRgIHNlbWFudGljczogYFwiMWU5XCJgXG4gKiAgaXMgMSBhbmQgYFwiNWFiY1wiYCBpcyA1LiBBbnkgY2FsbGVyIHdpdGggYSBrbm93biBzYWZlIG1pbmltdW0gbXVzdCBjbGFtcCDigJRcbiAqICBzZWUgYE1JTl9IRUFSVEJFQVRfTVNgLiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKiBUaGUgc2VydmVyJ3MgYGlkbGVUaW1lb3V0YCwgaW4gU0VDT05EUywgY2xhbXBlZCB0byB3aGF0IEJ1biBhY2NlcHRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlkbGVUaW1lb3V0U2VjKHJhdz86IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2sgPSBNQVhfSURMRV9USU1FT1VUX1NFQyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfSURMRV9USU1FT1VUX1NFQywgaW50T3IocmF3LCBmYWxsYmFjaykpKTtcbn1cblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCwgaW4gbXMsIENMQU1QRUQgQVQgQk9USCBFTkRTOiBuZXZlciBhYm92ZSBoYWxmIHRoZSBpZGxlXG4gKiB0aW1lb3V0LCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICogVGhlIGNlaWxpbmcgaXMgYXN0cm9sYWJlJ3MsIGFuZCB0aGUgY2Vuc3VzIG5hbWVkIGl0IGNvbnZlcmdlbmNlIHRhcmdldCAjNDpcbiAqIHRoZSBvdGhlciBkYWVtb25zIGhhcmQtY29kZSAxNSBzIGFnYWluc3QgMjU1IHMgYW5kIHdyaXRlIHRoZSByZWxhdGlvbnNoaXBcbiAqIG9ubHkgaW4gcHJvc2UsIHdoaWNoIGhvbGRzIGF0IHRoZSBkZWZhdWx0IGFuZCBhdCBubyBvdGhlciB2YWx1ZS4gRW5mb3JjaW5nXG4gKiBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgbWFrZXMgdGhlIGludmFyaWFudCB0cnVlIGZvciBBTlkgY29uZmlndXJlZFxuICogcGFpciwgd2hpY2ggaXMgZXhhY3RseSB0aGUgaW52YXJpYW50IHdob3NlIHZpb2xhdGlvbiBjYXVzZWQgdGhlIGJ1ZyBhYm92ZS5cbiAqXG4gKiDimqAgVGhlIGZsb29yIGNhbm5vdCBmaWdodCB0aGUgY2VpbGluZzogdGhlIGNlaWxpbmcgZXhwcmVzc2lvbiBpcyBpdHNlbGZcbiAqIGBNYXRoLm1heCg1MDAsIOKApilgLCBzbyBpdCBpcyBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AgYW5kIHRoZSB0d29cbiAqIGNsYW1wcyBjYW4gbmV2ZXIgY3Jvc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoZWFydGJlYXRNcyhcbiAgcmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGlkbGVTZWM6IG51bWJlcixcbiAgZmFsbGJhY2sgPSBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbik6IG51bWJlciB7XG4gIGNvbnN0IGNlaWxpbmcgPSBNYXRoLm1heChNSU5fSEVBUlRCRUFUX01TLCBNYXRoLmZsb29yKChpZGxlU2VjICogMTAwMCkgLyAyKSk7XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heChpbnRPcihyYXcsIGZhbGxiYWNrKSwgTUlOX0hFQVJUQkVBVF9NUyksIGNlaWxpbmcpO1xufVxuXG4vKiogVGhlIHRhaWwtc2lkZSB3YXRjaGRvZyBmb3IgYSBnaXZlbiBoZWFydGJlYXQ6IHRocmVlIG1pc3NlZCBiZWF0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsSWRsZU1zKGJlYXRNczogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIGJlYXRNcyAqIE1JU1NFRF9CRUFUUztcbn1cbiIsCiAgICAiLyoqXG4gKiBHbGFtb3VyJ3MgY29ubmVjdGlvbi10aW1pbmcgY29uc3RhbnRzIOKAlCBUSEUgT05FIENPUFksIGltcG9ydGVkIGJ5IGJvdGggaGFsdmVzXG4gKiBvZiB0aGUgc3BlbGwuXG4gKlxuICog4puUIFRISVMgRklMRSBJUyBUSEUgU0VBTS4gQmVmb3JlIFBoYXNlIDIgdGhlIGhlYXJ0YmVhdCB3YXMgYSBMSVRFUkFMIGAxNTAwMGBcbiAqIGluc2lkZSBgc2VydmVyLnRzYCdzIGBzc2VSZXNwb25zZWAsIGFuZCBgY2xpLnRzYCBoYWQgTk8gY29ycmVzcG9uZGluZyBudW1iZXJcbiAqIGF0IGFsbCDigJQgaXRzIHRhaWwgbG9vcCBzaW1wbHkgYmxvY2tlZCBvbiBgcmVhZGVyLnJlYWQoKWAgZm9yZXZlciwgd2hpY2ggaXMgdGhlXG4gKiBmYWlsdXJlIGB0YWlsRXZlbnRzYCdzIHdhdGNoZG9nIGV4aXN0cyB0byBlbmQuIE5laXRoZXIgZmlsZSBjb3VsZCBpbXBvcnQgdGhlXG4gKiBvdGhlcjogdGhlIENMSSByZWFjaGluZyBpbnRvIHRoZSBkYWVtb24gd291bGQgZHJhZyB0aGUgd2hvbGUgc2VydmVyIGdyYXBoIGludG9cbiAqIGBkaXN0L2NsaS5qc2AuIEEgbW9kdWxlIHdpdGggbm8gaW1wb3J0cyBidXQgdGhlIGtpdCdzIGRlcml2YXRpb25zIGhhcyBubyBzdWNoXG4gKiBncmFwaCwgc28gYm90aCBoYWx2ZXMgaW1wb3J0IHRoaXMgb25lLlxuICpcbiAqIOKblCAqKkFORCBUSEUgV0FUQ0hET0cgSVMgREVSSVZFRCBGUk9NIEdMQU1PVVInUyBPV04gSEVBUlRCRUFULCBORVZFUiBDT1BJRURcbiAqIEZST00gQSBTSUJMSU5HLioqIFRoaXMgaXMgUGhhc2UgMWEncyBydWxlIGFuZCBpdCBpcyB0aGUgd2hvbGUgcmVhc29uIHRoZSBmaWxlXG4gKiBleGlzdHMgcmF0aGVyIHRoYW4gYSBzaGFyZWQgY29uc3RhbnQgc29tZXdoZXJlOiBhc3Ryb2xhYmUgYmVhdHMgYXQgMTAgcyBhbmRcbiAqIG1hZ3BpZSBhdCAxNSBzLCBzbyBhIGhhcmQtY29kZWQgd2F0Y2hkb2cgaXMgY29ycmVjdCBmb3IgYXQgbW9zdCBvbmUgb2YgdGhlbS5cbiAqIEFzdHJvbGFiZSBtZWFzdXJlZCB3aGF0IGEgY29waWVkIG51bWJlciBkb2VzIOKAlCBhIDQ1IHMgd2F0Y2hkb2cgYWdhaW5zdCBhblxuICogZW52LXR1bmVkIGhlYXJ0YmVhdCBwcm9kdWNlZCByZWNvbm5lY3RzIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLCBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYW4gdW5yZWxhdGVkIHRoaXJkXG4gKiBjb25zdGFudCBhYnNvcmJlZCB0aGUgY2h1cm4uIGB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpYCBjYW5ub3QgZHJpZnQgZnJvbVxuICogdGhlIGJlYXQgaXQgaXMgd2F0Y2hpbmcsIHdoYXRldmVyIHRoZSBiZWF0IGJlY29tZXMuXG4gKlxuICog4pqgIEtFRVAgSVQgQSBMRUFGLVNIQVBFRCBGSUxFLiBUaGUgbW9tZW50IHRoaXMgaW1wb3J0cyBhbnl0aGluZyBvZiB0aGVcbiAqIGRhZW1vbidzLCB0aGUgQ0xJIGlzIGJhY2sgdG8gZHJhZ2dpbmcgdGhlIHNlcnZlciBncmFwaCBhbmQgdGhlIHNlYW0gY2xvc2VzLlxuICovXG5cbmltcG9ydCB7XG4gIERFRkFVTFRfSEVBUlRCRUFUX01TLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbiAgdGFpbElkbGVNcyxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hlYXJ0YmVhdC50c1wiO1xuXG4vKipcbiAqIEJ1bidzIG1heGltdW0uIFRoaXMgaXMgZ2xhbW91cidzIG93biBtZWFzdXJlZCB2YWx1ZSwgbm90IGFuIGluaGVyaXRlZCBvbmU6XG4gKiBgc2VydmVyLnRzYCBjYXJyaWVkIGBpZGxlVGltZW91dDogMjU1YCB3aXRoIGEgY29tbWVudCByZWNvcmRpbmcgdGhhdCBCdW4nc1xuICogZGVmYXVsdCAxMCBzIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlIHRoZSAxNSBzIGtlZXBhbGl2ZSBldmVyXG4gKiBmaXJlcy4gR2xhbW91ciBkb2VzIG5vdCBlbnYtdHVuZSBpdCDigJQgYSBzZXNzaW9uIGRhZW1vbidzIGNvbm5lY3Rpb24gbGlmZXRpbWVcbiAqIGlzIG5vdCBzb21ldGhpbmcgYSBjYWxsZXIgaGFzIGV2ZXIgbmVlZGVkIHRvIHNob3J0ZW4uXG4gKi9cbmV4cG9ydCBjb25zdCBJRExFX1RJTUVPVVRfU0VDID0gTUFYX0lETEVfVElNRU9VVF9TRUM7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCwgYW5kIGdsYW1vdXIncyBvd24gbGl0ZXJhbCBiZWZvcmUgdGhpcyBmaWxlIGV4aXN0ZWQuICovXG5leHBvcnQgY29uc3QgU1NFX0hFQVJUQkVBVF9NUyA9IERFRkFVTFRfSEVBUlRCRUFUX01TO1xuXG4vKipcbiAqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMsIERFUklWRUQuXG4gKlxuICog4pqgIDQ1LDAwMCBtcyB0b2RheSwgd2hpY2ggaXMgdGhlIHNhbWUgbnVtYmVyIGBjbWRPcGVuYCdzIGAtLXN0YXJ0LXRpbWVvdXRgXG4gKiBkZWZhdWx0IGhhcHBlbnMgdG8gYmUuIFRoZXkgYXJlIFVOUkVMQVRFRCDigJQgb25lIGJvdW5kcyBhIGZpcnN0IGJ1bmRsZSBidWlsZCxcbiAqIHRoZSBvdGhlciBib3VuZHMgYSBzaWxlbnQgc29ja2V0IOKAlCBhbmQgdGhlIGNvaW5jaWRlbmNlIGlzIG5hbWVkIGhlcmUgc28gbm9ib2R5XG4gKiBsYXRlciBcImRlLWR1cGxpY2F0ZXNcIiB0aGVtIGludG8gb25lIGNvbnN0YW50LlxuICovXG5leHBvcnQgY29uc3QgVEFJTF9JRExFX01TID0gdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKTtcbiIsCiAgICAiaW1wb3J0IHsgbWtkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7XG4gIGRlZmF1bHRTdGF0ZSxcbiAgdHlwZSBHbGFtb3VyU3RhdGUsXG4gIHR5cGUgTGlicmFyeUl0ZW0sXG59IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvZ2xhbW91ci9zaGFyZWQvdHlwZXNcIjtcblxuY29uc3QgRVhUX0JZX01JTUU6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiaW1hZ2Uvd2VicFwiOiBcIndlYnBcIixcbiAgXCJpbWFnZS9wbmdcIjogXCJwbmdcIixcbiAgXCJpbWFnZS9qcGVnXCI6IFwianBnXCIsXG4gIFwiaW1hZ2UvZ2lmXCI6IFwiZ2lmXCIsXG59O1xuXG5leHBvcnQgZnVuY3Rpb24gc2F2ZURhdGFVcmwoZGlyOiBzdHJpbmcsIGlkOiBzdHJpbmcsIGRhdGFVcmw6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG0gPSAvXmRhdGE6KFteOyxdKyk/KDtiYXNlNjQpPywoLiopJC9zLmV4ZWMoZGF0YVVybCk7XG4gIC8vIGAoLiopYCBpcyBtYW5kYXRvcnksIHNvIGEgbWF0Y2ggYWx3YXlzIHNldHMgYGJvZHlgOyBgXCJcImAgaXMgdGhpc1xuICAvLyBmdW5jdGlvbidzIG93biBhbnN3ZXIgZm9yIFwibm90IHNhdmVkXCIsIHNvIGFuIGltcG9zc2libGUgYWJzZW5jZSB0YWtlcyBpdC5cbiAgY29uc3QgYm9keSA9IG0/LlszXTtcbiAgaWYgKCFtIHx8IGJvZHkgPT09IHVuZGVmaW5lZCB8fCAhZGlyKSByZXR1cm4gXCJcIjtcbiAgY29uc3QgbWltZSA9IChtWzFdID8/IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCIpLnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IGJ1ZiA9IG1bMl0gPyBCdWZmZXIuZnJvbShib2R5LCBcImJhc2U2NFwiKSA6IEJ1ZmZlci5mcm9tKGRlY29kZVVSSUNvbXBvbmVudChib2R5KSwgXCJ1dGY4XCIpO1xuICBjb25zdCBleHQgPSBFWFRfQllfTUlNRVttaW1lXSA/PyBcImJpblwiO1xuICBjb25zdCBzYWZlSWQgPSBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV8tXS9nLCBcIl9cIik7XG4gIGNvbnN0IHBhdGggPSBqb2luKGRpciwgYCR7c2FmZUlkfS4ke2V4dH1gKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKHBhdGgsIGJ1Zik7XG4gICAgcmV0dXJuIHBhdGg7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBcIlwiO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzYXZlVGV4dChkaXI6IHN0cmluZywgaWQ6IHN0cmluZywgbmFtZTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBzYWZlID0gbmFtZS5yZXBsYWNlKC9bXmEtekEtWjAtOS5fLV0vZywgXCJfXCIpIHx8IGAke2lkfS5tZGA7XG4gIGNvbnN0IHBhdGggPSBqb2luKGRpciwgYCR7aWR9LSR7c2FmZX1gKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKHBhdGgsIHRleHQsIFwidXRmOFwiKTtcbiAgICByZXR1cm4gcGF0aDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFwiXCI7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hdGVyaWFsaXplSXRlbShmaWxlc0Rpcjogc3RyaW5nLCBpdGVtOiBMaWJyYXJ5SXRlbSk6IHZvaWQge1xuICBpZiAoaXRlbS5zcmMpIHtcbiAgICBjb25zdCBwID0gc2F2ZURhdGFVcmwoZmlsZXNEaXIsIGl0ZW0uaWQsIGl0ZW0uc3JjKTtcbiAgICBpZiAocCkgaXRlbS5wYXRoID0gcDtcbiAgfSBlbHNlIGlmIChpdGVtLnRleHQpIHtcbiAgICBjb25zdCBwID0gc2F2ZVRleHQoZmlsZXNEaXIsIGl0ZW0uaWQsIGl0ZW0udGl0bGUsIGl0ZW0udGV4dCk7XG4gICAgaWYgKHApIGl0ZW0ucGF0aCA9IHA7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNhdmVTbmFwc2hvdChzbmFwc2hvdHNEaXI6IHN0cmluZywgc2Vzc2lvbklkOiBzdHJpbmcsIHN0YXRlOiBHbGFtb3VyU3RhdGUpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoc25hcHNob3RzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oc25hcHNob3RzRGlyLCBgJHtzZXNzaW9uSWR9Lmpzb25gKSwgSlNPTi5zdHJpbmdpZnkoc3RhdGUpKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogcGVyc2lzdGVuY2UgaXMgYmVzdC1lZmZvcnQgKi9cbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gbG9hZFNuYXBzaG90KHBhdGg6IHN0cmluZywgdGl0bGU6IHN0cmluZywgaW50ZW50OiBzdHJpbmcpOiBHbGFtb3VyU3RhdGUge1xuICBjb25zdCBzbmFwID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSBhcyBQYXJ0aWFsPEdsYW1vdXJTdGF0ZT47XG4gIC8vIE1lcmdlIG92ZXIgZGVmYXVsdHMgc28gb2xkZXIgc25hcHNob3RzIGdhaW4gbmV3IHRvcC1sZXZlbCBmaWVsZHMuXG4gIGNvbnN0IG1lcmdlZCA9IHsgLi4uZGVmYXVsdFN0YXRlKHRpdGxlLCBpbnRlbnQpLCAuLi5zbmFwIH0gYXMgR2xhbW91clN0YXRlO1xuICAvLyBOb3JtYWxpemUgc3R5bGUtZ3VpZGUgc2VjdGlvbnMgc28gc25hcHNob3RzIHByZWRhdGluZyBuZXdlciBwZXItc2VjdGlvblxuICAvLyBmaWVsZHMgKHByb21wdHMsIGNvbG9ycykgc3RpbGwgc2F0aXNmeSB0aGUgY3VycmVudCBzaGFwZS5cbiAgbWVyZ2VkLnN0eWxlR3VpZGUgPSBtZXJnZWQuc3R5bGVHdWlkZS5tYXAoKHMpID0+ICh7XG4gICAgLi4ucyxcbiAgICBwcm9tcHRzOiBzLnByb21wdHMgPz8gW10sXG4gICAgY29sb3JzOiBzLmNvbG9ycyA/PyBbXSxcbiAgfSkpO1xuICByZXR1cm4gbWVyZ2VkO1xufVxuIiwKICAgICJpbXBvcnQgdHlwZSB7XG4gIEFnZW50Q29tbWFuZCxcbiAgQ2Fub25JbWcsXG4gIEdlbk1ldGEsXG4gIEdsYW1vdXJTdGF0ZSxcbiAgSXRlbUtpbmQsXG4gIExlYW5JdGVtLFxuICBMZWFuU3RhdGUsXG4gIExpYnJhcnlJdGVtLFxuICBNZXNzYWdlLFxuICBTYXZlZFN0eWxlLFxuICBTZWN0aW9uS2V5LFxuICBTZWN0aW9uU3RhdHVzLFxuICBTd2F0Y2gsXG59IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvZ2xhbW91ci9zaGFyZWQvdHlwZXNcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIG1ha2VJdGVtKHA6IHtcbiAgaWQ6IHN0cmluZztcbiAga2luZDogSXRlbUtpbmQ7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIHNyYz86IHN0cmluZztcbiAgcGF0aD86IHN0cmluZztcbiAgdGV4dD86IHN0cmluZztcbiAgbWltZT86IHN0cmluZztcbiAgdGFncz86IHN0cmluZ1tdO1xuICBjcmVhdGVkQXQ6IG51bWJlcjtcbiAgZ2VuPzogR2VuTWV0YSB8IG51bGw7XG59KTogTGlicmFyeUl0ZW0ge1xuICByZXR1cm4ge1xuICAgIGlkOiBwLmlkLFxuICAgIGtpbmQ6IHAua2luZCxcbiAgICB0aXRsZTogcC50aXRsZSxcbiAgICBzcmM6IHAuc3JjID8/IFwiXCIsXG4gICAgcGF0aDogcC5wYXRoID8/IFwiXCIsXG4gICAgdGV4dDogcC50ZXh0ID8/IFwiXCIsXG4gICAgbWltZTogcC5taW1lID8/IFwiXCIsXG4gICAgdGFnczogcC50YWdzID8/IFtdLFxuICAgIHN0YXJyZWQ6IGZhbHNlLFxuICAgIGxpa2VkOiBmYWxzZSxcbiAgICBhbm5vdGF0aW9uczogeyBhZ2VudDogXCJcIiwgaHVtYW46IFwiXCIgfSxcbiAgICBjYW5vbmljYWw6IGZhbHNlLFxuICAgIGNhbm9uOiBbXSxcbiAgICBhcmNoaXZlZDogZmFsc2UsXG4gICAgY3JlYXRlZEF0OiBwLmNyZWF0ZWRBdCxcbiAgICBnZW46IHAuZ2VuID8/IG51bGwsXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRJdGVtKHN0YXRlOiBHbGFtb3VyU3RhdGUsIGl0ZW06IExpYnJhcnlJdGVtKTogYm9vbGVhbiB7XG4gIGlmIChzdGF0ZS5saWJyYXJ5LnNvbWUoKGkpID0+IGkuaWQgPT09IGl0ZW0uaWQpKSByZXR1cm4gZmFsc2U7XG4gIHN0YXRlLmxpYnJhcnkucHVzaChpdGVtKTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZWxlY3RJdGVtcyhzdGF0ZTogR2xhbW91clN0YXRlLCBpZHM6IHN0cmluZ1tdKTogdm9pZCB7XG4gIHN0YXRlLnNlbGVjdGVkSWRzID0gWy4uLmlkc107XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRTdGFyKHN0YXRlOiBHbGFtb3VyU3RhdGUsIGlkOiBzdHJpbmcsIHN0YXJyZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3QgaXQgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKGkpID0+IGkuaWQgPT09IGlkKTtcbiAgaWYgKCFpdCkgcmV0dXJuIGZhbHNlO1xuICBpdC5zdGFycmVkID0gc3RhcnJlZDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRMaWtlKHN0YXRlOiBHbGFtb3VyU3RhdGUsIGlkOiBzdHJpbmcsIGxpa2VkOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGl0ID0gc3RhdGUubGlicmFyeS5maW5kKChpKSA9PiBpLmlkID09PSBpZCk7XG4gIGlmICghaXQpIHJldHVybiBmYWxzZTtcbiAgaXQubGlrZWQgPSBsaWtlZDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhbm5vdGF0ZShcbiAgc3RhdGU6IEdsYW1vdXJTdGF0ZSxcbiAgaWQ6IHN0cmluZyxcbiAgd2hvOiBcImFnZW50XCIgfCBcImh1bWFuXCIsXG4gIHRleHQ6IHN0cmluZyxcbik6IGJvb2xlYW4ge1xuICBjb25zdCBpdCA9IHN0YXRlLmxpYnJhcnkuZmluZCgoaSkgPT4gaS5pZCA9PT0gaWQpO1xuICBpZiAoIWl0KSByZXR1cm4gZmFsc2U7XG4gIGl0LmFubm90YXRpb25zW3dob10gPSB0ZXh0O1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZE1lc3NhZ2Uoc3RhdGU6IEdsYW1vdXJTdGF0ZSwgbTogTWVzc2FnZSk6IHZvaWQge1xuICBzdGF0ZS5tZXNzYWdlcy5wdXNoKG0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlU2VjdGlvbihcbiAgc3RhdGU6IEdsYW1vdXJTdGF0ZSxcbiAga2V5OiBTZWN0aW9uS2V5LFxuICBwYXRjaDogeyBjb250ZW50Pzogc3RyaW5nOyBzdGF0dXM/OiBTZWN0aW9uU3RhdHVzOyBwcm9tcHRzPzogc3RyaW5nW107IGNvbG9ycz86IFN3YXRjaFtdIH0sXG4pOiBib29sZWFuIHtcbiAgY29uc3Qgc2VjID0gc3RhdGUuc3R5bGVHdWlkZS5maW5kKChzKSA9PiBzLmtleSA9PT0ga2V5KTtcbiAgaWYgKCFzZWMpIHJldHVybiBmYWxzZTtcbiAgaWYgKHBhdGNoLmNvbnRlbnQgIT09IHVuZGVmaW5lZCkgc2VjLmNvbnRlbnQgPSBwYXRjaC5jb250ZW50O1xuICBpZiAocGF0Y2guc3RhdHVzICE9PSB1bmRlZmluZWQpIHNlYy5zdGF0dXMgPSBwYXRjaC5zdGF0dXM7XG4gIGlmIChwYXRjaC5wcm9tcHRzICE9PSB1bmRlZmluZWQpIHNlYy5wcm9tcHRzID0gcGF0Y2gucHJvbXB0cztcbiAgaWYgKHBhdGNoLmNvbG9ycyAhPT0gdW5kZWZpbmVkKSBzZWMuY29sb3JzID0gcGF0Y2guY29sb3JzO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldEZvY3VzKFxuICBzdGF0ZTogR2xhbW91clN0YXRlLFxuICBpZHM6IHN0cmluZ1tdLFxuICBvd25lcjogXCJ5b3VcIiB8IFwiYWdlbnRcIixcbiAgbm90ZSA9IFwiXCIsXG4pOiB2b2lkIHtcbiAgc3RhdGUuc2NvcGUgPSBcImZvY3VzXCI7XG4gIHN0YXRlLmZvY3VzU2V0ID0gWy4uLmlkc107XG4gIHN0YXRlLmZvY3VzT3duZXIgPSBvd25lcjtcbiAgc3RhdGUuZm9jdXNOb3RlID0gbm90ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyRm9jdXMoc3RhdGU6IEdsYW1vdXJTdGF0ZSk6IHZvaWQge1xuICBzdGF0ZS5zY29wZSA9IFwiYWxsXCI7XG4gIHN0YXRlLmZvY3VzU2V0ID0gW107XG4gIHN0YXRlLmZvY3VzT3duZXIgPSBudWxsO1xuICBzdGF0ZS5mb2N1c05vdGUgPSBcIlwiO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0Q2Fub25pY2FsKHN0YXRlOiBHbGFtb3VyU3RhdGUsIGlkOiBzdHJpbmcsIGNhbm9uaWNhbDogYm9vbGVhbik6IGJvb2xlYW4ge1xuICBjb25zdCBpdCA9IHN0YXRlLmxpYnJhcnkuZmluZCgoaSkgPT4gaS5pZCA9PT0gaWQpO1xuICBpZiAoIWl0KSByZXR1cm4gZmFsc2U7XG4gIGl0LmNhbm9uaWNhbCA9IGNhbm9uaWNhbDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhcmNoaXZlVHJheVN0eWxlKHN0YXRlOiBHbGFtb3VyU3RhdGUsIGlkOiBzdHJpbmcsIGFyY2hpdmVkOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIGNvbnN0IHN0ID0gc3RhdGUudHJheS5maW5kKChzKSA9PiBzLmlkID09PSBpZCk7XG4gIGlmICghc3QpIHJldHVybiBmYWxzZTtcbiAgc3QuYXJjaGl2ZWQgPSBhcmNoaXZlZDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFN0eWxlSXRlbShcbiAgc3R5bGU6IFNhdmVkU3R5bGUsXG4gIGNhbm9uOiBDYW5vbkltZ1tdLFxuICBjcmVhdGVkQXQ6IG51bWJlcixcbik6IExpYnJhcnlJdGVtIHtcbiAgcmV0dXJuIHtcbiAgICBpZDogYHN0eWxlLSR7c3R5bGUuaWR9YCxcbiAgICBraW5kOiBcInN0eWxlXCIsXG4gICAgdGl0bGU6IHN0eWxlLmxhYmVsLFxuICAgIHNyYzogXCJcIixcbiAgICBwYXRoOiBcIlwiLFxuICAgIHRleHQ6IHN0eWxlLnRleHQsXG4gICAgbWltZTogXCJcIixcbiAgICB0YWdzOiBbXSxcbiAgICBzdGFycmVkOiBmYWxzZSxcbiAgICBsaWtlZDogZmFsc2UsXG4gICAgYW5ub3RhdGlvbnM6IHsgYWdlbnQ6IFwiXCIsIGh1bWFuOiBcIlwiIH0sXG4gICAgY2Fub25pY2FsOiBmYWxzZSxcbiAgICBjYW5vbixcbiAgICBhcmNoaXZlZDogZmFsc2UsXG4gICAgY3JlYXRlZEF0LFxuICAgIGdlbjogbnVsbCxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldEl0ZW1BcmNoaXZlZChzdGF0ZTogR2xhbW91clN0YXRlLCBpZDogc3RyaW5nLCBhcmNoaXZlZDogYm9vbGVhbik6IGJvb2xlYW4ge1xuICBjb25zdCBpdCA9IHN0YXRlLmxpYnJhcnkuZmluZCgoaSkgPT4gaS5pZCA9PT0gaWQpO1xuICBpZiAoIWl0KSByZXR1cm4gZmFsc2U7XG4gIGl0LmFyY2hpdmVkID0gYXJjaGl2ZWQ7XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0R2VuQ29zdChzdGF0ZTogR2xhbW91clN0YXRlLCBpZDogc3RyaW5nLCBjb3N0OiBudW1iZXIpOiBib29sZWFuIHtcbiAgY29uc3QgaXQgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKGkpID0+IGkuaWQgPT09IGlkKTtcbiAgaWYgKCFpdD8uZ2VuKSByZXR1cm4gZmFsc2U7XG4gIGl0Lmdlbi5jb3N0ID0gY29zdDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIEJhY2tmaWxsIHRoZSByZWFsIHByb21wdCBhbmQvb3IgcmVmcyBvbnRvIGEgZ2VuIGFmdGVyIHRoZSBmYWN0LCBzbyBpdHMgc3RvcmVkXG4vLyBtZXRhZGF0YSBpcyB0aGUgcmVwcm9kdWNpYmxlIHByb21wdCAobm90IGEgbGFiZWwpIOKAlCBubyBzZXNzaW9uIGJvdW5jZSBuZWVkZWQuXG5leHBvcnQgZnVuY3Rpb24gc2V0R2VuTWV0YShcbiAgc3RhdGU6IEdsYW1vdXJTdGF0ZSxcbiAgaWQ6IHN0cmluZyxcbiAgcGF0Y2g6IHsgcHJvbXB0Pzogc3RyaW5nOyBjdXN0b20/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IH0sXG4pOiBib29sZWFuIHtcbiAgY29uc3QgaXQgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKGkpID0+IGkuaWQgPT09IGlkKTtcbiAgaWYgKCFpdD8uZ2VuKSByZXR1cm4gZmFsc2U7XG4gIGlmICh0eXBlb2YgcGF0Y2gucHJvbXB0ID09PSBcInN0cmluZ1wiKSBpdC5nZW4ucHJvbXB0ID0gcGF0Y2gucHJvbXB0O1xuICBpZiAocGF0Y2guY3VzdG9tKSBpdC5nZW4uY3VzdG9tID0geyAuLi4oaXQuZ2VuLmN1c3RvbSA/PyB7fSksIC4uLnBhdGNoLmN1c3RvbSB9O1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxlYW5JdGVtKGl0OiBMaWJyYXJ5SXRlbSk6IExlYW5JdGVtIHtcbiAgY29uc3QgeyBzcmM6IF9zLCB0ZXh0OiBfdCwgY2Fub246IF9jLCAuLi5yZXN0IH0gPSBpdDtcbiAgcmV0dXJuIHJlc3Q7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsZWFuU3RhdGUoczogR2xhbW91clN0YXRlKTogTGVhblN0YXRlIHtcbiAgcmV0dXJuIHsgLi4ucywgbGlicmFyeTogcy5saWJyYXJ5Lm1hcChsZWFuSXRlbSkgfTtcbn1cblxuLy8gQm9hcmQgbW92ZXMgdGhhdCBtdXRhdGUgc3RhdGUgKyBicm9hZGNhc3QgYnV0IGVtaXQgTk8gYWdlbnQgZXZlbnQuXG5leHBvcnQgY29uc3QgQU1CSUVOVF9DTElFTlQgPSBuZXcgU2V0PHN0cmluZz4oW1xuICBcIml0ZW0uc2VsZWN0XCIsXG4gIFwiaXRlbS5zdGFyXCIsXG4gIFwiaXRlbS5saWtlXCIsXG4gIFwiZm9jdXMuc2V0XCIsXG4gIFwiZm9jdXMuY2xlYXJcIixcbiAgXCJpdGVtLmNhbm9uaWNhbFwiLFxuICBcIml0ZW0uYXJjaGl2ZVwiLFxuICBcIml0ZW0uYW5ub3RhdGVcIiwgLy8gYSBwZXItaXRlbSBub3RlOiBzdG9yZWQgKyByZWFkIG9uIGRlbWFuZCwgbm90IHB1c2hlZCBhcyBhbiBldmVudFxuXSk7XG5leHBvcnQgZnVuY3Rpb24gaXNJbXBlcmF0aXZlKHR5cGU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gIUFNQklFTlRfQ0xJRU5ULmhhcyh0eXBlKTtcbn1cblxuLy8gUmV0dXJucyB3aGV0aGVyIHRoZSBjb21tYW5kIHR5cGUgd2FzIFJFQ09HTklTRUQg4oCUIHRoZSB2ZXJkaWN0IHRoZSAvY21kIHJvdXRlXG4vLyBwcm9wYWdhdGVzICgjODQpLiBSZWNvZ25pc2VkLWFuZC1hcHBsaWVkIGlzIGB0cnVlYDsgYW4gdW5rbm93biB0eXBlIGlzXG4vLyBgZmFsc2VgLiBUaGlzIGlzIGRlbGliZXJhdGVseSBub3QgXCJkaWQgc3RhdGUgY2hhbmdlXCI6IGEgcmVjb2duaXNlZCBjb21tYW5kXG4vLyB0aGF0IGlzIGEgbGVnaXRpbWF0ZSBuby1vcCBzdGlsbCBhcHBsaWVkLlxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5QWdlbnRNc2coc3RhdGU6IEdsYW1vdXJTdGF0ZSwgbXNnOiBBZ2VudENvbW1hbmQpOiBib29sZWFuIHtcbiAgc3dpdGNoIChtc2cudHlwZSkge1xuICAgIGNhc2UgXCJpbml0XCI6XG4gICAgICBpZiAodHlwZW9mIG1zZy50aXRsZSA9PT0gXCJzdHJpbmdcIikgc3RhdGUudGl0bGUgPSBtc2cudGl0bGU7XG4gICAgICBpZiAodHlwZW9mIG1zZy5pbnRlbnQgPT09IFwic3RyaW5nXCIpIHN0YXRlLmludGVudCA9IG1zZy5pbnRlbnQ7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiaW50ZW50XCI6XG4gICAgICBzdGF0ZS5pbnRlbnQgPSBtc2cudGV4dDtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJpdGVtLmFubm90YXRlXCI6IHtcbiAgICAgIGNvbnN0IGl0ID0gc3RhdGUubGlicmFyeS5maW5kKChpKSA9PiBpLmlkID09PSBtc2cuaWQpO1xuICAgICAgaWYgKGl0KSBpdC5hbm5vdGF0aW9ucy5hZ2VudCA9IG1zZy5hZ2VudDtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwic2VjdGlvblwiOlxuICAgICAgdXBkYXRlU2VjdGlvbihzdGF0ZSwgbXNnLmtleSwge1xuICAgICAgICBjb250ZW50OiBtc2cuY29udGVudCxcbiAgICAgICAgc3RhdHVzOiBtc2cuc3RhdHVzLFxuICAgICAgICBwcm9tcHRzOiBtc2cucHJvbXB0cyxcbiAgICAgICAgY29sb3JzOiBtc2cuY29sb3JzLFxuICAgICAgfSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZm9jdXMucHVzaFwiOlxuICAgICAgc2V0Rm9jdXMoc3RhdGUsIG1zZy5pZHMsIFwiYWdlbnRcIiwgbXNnLm5vdGUgPz8gXCJcIik7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZ2VuLmNvc3RcIjpcbiAgICAgIHNldEdlbkNvc3Qoc3RhdGUsIG1zZy5pZCwgbXNnLmNvc3QpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImdlbi5tZXRhXCI6XG4gICAgICBzZXRHZW5NZXRhKHN0YXRlLCBtc2cuaWQsIHsgcHJvbXB0OiBtc2cucHJvbXB0LCBjdXN0b206IG1zZy5jdXN0b20gfSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwic3RhdHVzXCI6XG4gICAgICBzdGF0ZS5zdGF0dXMgPSB7IGJ1c3k6IG1zZy5idXN5LCB0ZXh0OiBtc2cudGV4dCA/PyBcIlwiIH07XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwic3R5bGUuYXJjaGl2ZVwiOlxuICAgICAgYXJjaGl2ZVRyYXlTdHlsZShzdGF0ZSwgbXNnLmlkLCBtc2cuYXJjaGl2ZWQpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInNheVwiOlxuICAgIGNhc2UgXCJjbG9zZVwiOlxuICAgICAgYnJlYWs7IC8vIGhhbmRsZWQgYnkgdGhlIHNlcnZlciAoYXBwZW5kZWQgdG8gY29udmVyc2F0aW9uIC8gc2h1dGRvd24pXG4gICAgZGVmYXVsdDpcbiAgICAgIC8vICM4NCDigJQgdGhlIHN3aXRjaCBoYWQgTk8gZGVmYXVsdCwgc28gYW4gdW5yZWNvZ25pc2VkIGNvbW1hbmQgdHlwZSBkaWRcbiAgICAgIC8vIG5vdGhpbmcgYW5kIHRoZSAvY21kIHJvdXRlIHN0aWxsIGFuc3dlcmVkIHtvazp0cnVlfTogYSBib2d1cyB0eXBlIHdhc1xuICAgICAgLy8gYnl0ZS1pZGVudGljYWwgdG8gYW4gZXhlY3V0ZWQgb25lLiBUaGUgdmVyZGljdCBoYXMgdG8gYmUgcHJvZHVjZWQgSEVSRSxcbiAgICAgIC8vIGJ5IHRoZSBjb2RlIHRoYXQgYWN0dWFsbHkga25vd3MgdGhlIHJlY29nbmlzZWQgc2V0LCBhbmQgbm90IG1pcnJvcmVkXG4gICAgICAvLyBpbnRvIGEgbGlzdCBiZXNpZGUgdGhlIHN3aXRjaCDigJQgYSBoYW5kLW1haW50YWluZWQgbWlycm9yIG9mIGEgY2FzZSBsaXN0XG4gICAgICAvLyBkcmlmdHMgc2lsZW50bHkgdGhlIG1vbWVudCBhIGNhc2UgaXMgYWRkZWQsIHdoaWNoIGlzIGEgZGVmZWN0IHRoaXMgcmVwb1xuICAgICAgLy8gaGFzIGFscmVhZHkgc2hpcHBlZCB0d2ljZS5cbiAgICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cbiIsCiAgICAiLy8gU2VydmVyL0NMSS1vbmx5OiB0aGUgcHJvamVjdC1zY29wZWQgc3R5bGUgc3RvcmUuIERvIE5PVCBpbXBvcnQgZnJvbSBicm93c2VyXG4vLyBjb2RlIChmaWxlc3lzdGVtIGFjY2VzcykuIFN0eWxlcyBsaXZlIHVuZGVyICR7aG9tZX0vc3R5bGVzLyR7cHJvamVjdEtleX0vLFxuLy8ga2V5ZWQgdG8gdGhlIGNoZWNrb3V0IHdoZXJlIHRoZSBzcGVsbCB3YXMgY2FzdC5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgcmVhZGRpclN5bmMsIHJlYWRGaWxlU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHtcbiAgQ2Fub25JbWcsXG4gIENhbm9uaWNhbFJlZixcbiAgTGlicmFyeUl0ZW0sXG4gIFNhdmVkU3R5bGUsXG4gIFN0eWxlU2VjdGlvbixcbn0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9nbGFtb3VyL3NoYXJlZC90eXBlc1wiO1xuXG5jb25zdCBFWFRfQllfTUlNRTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCJpbWFnZS93ZWJwXCI6IFwid2VicFwiLFxuICBcImltYWdlL3BuZ1wiOiBcInBuZ1wiLFxuICBcImltYWdlL2pwZWdcIjogXCJqcGdcIixcbiAgXCJpbWFnZS9naWZcIjogXCJnaWZcIixcbn07XG5cbi8vIEEgc3RhYmxlLCBmaWxlc3lzdGVtLXNhZmUga2V5OiBzYW5pdGl6ZWQgYmFzZSBuYW1lICsgYSBzaG9ydCBoYXNoIG9mIHRoZSBmdWxsXG4vLyBhYnNvbHV0ZSBwYXRoIChzbyB0d28gY2hlY2tvdXRzIHdpdGggdGhlIHNhbWUgZm9sZGVyIG5hbWUgZG9uJ3QgY29sbGlkZSkuXG5leHBvcnQgZnVuY3Rpb24gcHJvamVjdEtleShwcm9qZWN0RGlyOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gYmFzZW5hbWUocHJvamVjdERpcikucmVwbGFjZSgvW15hLXpBLVowLTlfLV0vZywgXCJfXCIpIHx8IFwicm9vdFwiO1xuICBsZXQgaCA9IDUzODE7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgcHJvamVjdERpci5sZW5ndGg7IGkrKykgaCA9ICgoaCA8PCA1KSArIGggKyBwcm9qZWN0RGlyLmNoYXJDb2RlQXQoaSkpID4+PiAwO1xuICByZXR1cm4gYCR7YmFzZX0tJHtoLnRvU3RyaW5nKDM2KX1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3R5bGVzRGlyKGhvbWU6IHN0cmluZywga2V5OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihob21lLCBcInN0eWxlc1wiLCBrZXkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2F2ZVN0eWxlKFxuICBob21lOiBzdHJpbmcsXG4gIGtleTogc3RyaW5nLFxuICBhcmdzOiB7XG4gICAgaWQ6IHN0cmluZztcbiAgICBsYWJlbDogc3RyaW5nO1xuICAgIHRleHQ6IHN0cmluZztcbiAgICBzZWN0aW9uczogU3R5bGVTZWN0aW9uW107XG4gICAgY2Fub25pY2FsSXRlbXM6IExpYnJhcnlJdGVtW107XG4gICAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIH0sXG4pOiBTYXZlZFN0eWxlIHtcbiAgY29uc3QgZGlyID0gc3R5bGVzRGlyKGhvbWUsIGtleSk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBjb25zdCBjYW5vbmljYWw6IENhbm9uaWNhbFJlZltdID0gW107XG4gIGZvciAoY29uc3QgaXQgb2YgYXJncy5jYW5vbmljYWxJdGVtcykge1xuICAgIGlmICghaXQucGF0aCB8fCAhZXhpc3RzU3luYyhpdC5wYXRoKSkgY29udGludWU7XG4gICAgY29uc3QgZXh0ID0gRVhUX0JZX01JTUVbaXQubWltZV0gPz8gXCJiaW5cIjtcbiAgICBjb25zdCBmaWxlID0gYCR7YXJncy5pZH0tJHtpdC5pZH0uJHtleHR9YDtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgZmlsZSksIHJlYWRGaWxlU3luYyhpdC5wYXRoKSk7XG4gICAgICBjYW5vbmljYWwucHVzaCh7IGlkOiBpdC5pZCwgdGl0bGU6IGl0LnRpdGxlLCBmaWxlLCBtaW1lOiBpdC5taW1lIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogc2tpcCBhbiB1bnJlYWRhYmxlIGJsb2IgKi9cbiAgICB9XG4gIH1cbiAgY29uc3Qgc3R5bGU6IFNhdmVkU3R5bGUgPSB7XG4gICAgaWQ6IGFyZ3MuaWQsXG4gICAgbGFiZWw6IGFyZ3MubGFiZWwsXG4gICAgdGV4dDogYXJncy50ZXh0LFxuICAgIHNlY3Rpb25zOiBhcmdzLnNlY3Rpb25zLFxuICAgIGNhbm9uaWNhbCxcbiAgICBjcmVhdGVkQXQ6IGFyZ3MuY3JlYXRlZEF0LFxuICAgIGFyY2hpdmVkOiBmYWxzZSxcbiAgfTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgYCR7YXJncy5pZH0uanNvbmApLCBKU09OLnN0cmluZ2lmeShzdHlsZSkpO1xuICByZXR1cm4gc3R5bGU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsb2FkVHJheShob21lOiBzdHJpbmcsIGtleTogc3RyaW5nKTogU2F2ZWRTdHlsZVtdIHtcbiAgY29uc3QgZGlyID0gc3R5bGVzRGlyKGhvbWUsIGtleSk7XG4gIGlmICghZXhpc3RzU3luYyhkaXIpKSByZXR1cm4gW107XG4gIGNvbnN0IG91dDogU2F2ZWRTdHlsZVtdID0gW107XG4gIGZvciAoY29uc3QgbmFtZSBvZiByZWFkZGlyU3luYyhkaXIpKSB7XG4gICAgaWYgKCFuYW1lLmVuZHNXaXRoKFwiLmpzb25cIikpIGNvbnRpbnVlO1xuICAgIHRyeSB7XG4gICAgICBvdXQucHVzaChKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgbmFtZSksIFwidXRmOFwiKSkgYXMgU2F2ZWRTdHlsZSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBza2lwIGEgY29ycnVwdCByZWNvcmQgKi9cbiAgICB9XG4gIH1cbiAgcmV0dXJuIG91dC5zb3J0KChhLCBiKSA9PiBhLmNyZWF0ZWRBdCAtIGIuY3JlYXRlZEF0KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldFN0eWxlQXJjaGl2ZWQoXG4gIGhvbWU6IHN0cmluZyxcbiAga2V5OiBzdHJpbmcsXG4gIGlkOiBzdHJpbmcsXG4gIGFyY2hpdmVkOiBib29sZWFuLFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IHBhdGggPSBqb2luKHN0eWxlc0Rpcihob21lLCBrZXkpLCBgJHtpZH0uanNvbmApO1xuICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHJldHVybiBmYWxzZTtcbiAgdHJ5IHtcbiAgICBjb25zdCBzdHlsZSA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSkgYXMgU2F2ZWRTdHlsZTtcbiAgICBzdHlsZS5hcmNoaXZlZCA9IGFyY2hpdmVkO1xuICAgIHdyaXRlRmlsZVN5bmMocGF0aCwgSlNPTi5zdHJpbmdpZnkoc3R5bGUpKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXRlcmlhbGl6ZUNhbm9uKGhvbWU6IHN0cmluZywga2V5OiBzdHJpbmcsIHN0eWxlOiBTYXZlZFN0eWxlKTogQ2Fub25JbWdbXSB7XG4gIGNvbnN0IGRpciA9IHN0eWxlc0Rpcihob21lLCBrZXkpO1xuICBjb25zdCBvdXQ6IENhbm9uSW1nW10gPSBbXTtcbiAgZm9yIChjb25zdCByZWYgb2Ygc3R5bGUuY2Fub25pY2FsKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGJ5dGVzID0gcmVhZEZpbGVTeW5jKGpvaW4oZGlyLCByZWYuZmlsZSkpO1xuICAgICAgb3V0LnB1c2goe1xuICAgICAgICB0aXRsZTogcmVmLnRpdGxlLFxuICAgICAgICBzcmM6IGBkYXRhOiR7cmVmLm1pbWV9O2Jhc2U2NCwke2J5dGVzLnRvU3RyaW5nKFwiYmFzZTY0XCIpfWAsXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHNraXAgYSBt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aUJBQWlCO0FBQUEsSUFDakIsUUFBUTtBQUFBLElBQ1IsaUJBQWlCO0FBQUEsSUFDakIsVUFBVSxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQUEsSUFDdkIsYUFBYSxFQUFFLFFBQVEsU0FBUyxZQUFZLFFBQVEsQ0FBQyxFQUFFLEtBQUssZUFBZTtBQUFBO0FBQUEsRUFFbEYsS0FBSyxLQUFLLE1BQU0sTUFBTSxDQUFDO0FBQUEsRUFFdkIsT0FBTyxFQUFFLE1BQU0sV0FBVyxXQUFXLE1BQU0sT0FBTyxNQUFNLFNBQVM7QUFBQTtBQXdCbkUsSUFBTSxpQkFBaUI7QUFBQSxFQUNyQixRQUFRLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDekIsTUFBTSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3ZCLFNBQVMsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUMxQixTQUFTLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDMUIsU0FBUyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQzFCLE9BQU8sRUFBRSxNQUFNLFNBQVM7QUFDMUI7QUFJQSxlQUFzQixJQUFJLENBQUMsTUFBaUM7QUFBQSxFQUMxRCxJQUFJO0FBQUEsRUFDSixJQUFJO0FBQUEsSUFDRixRQUFRLGNBQWMsRUFBRSxNQUFNLE1BQU0sU0FBUyxnQkFBZ0IsUUFBUSxLQUFLLENBQUMsRUFBRTtBQUFBLElBSTdFLE9BQU8sR0FBRztBQUFBLElBQ1YsUUFBUSxPQUFPLE1BQ2IsWUFBWSxhQUFhLFFBQVEsRUFBRSxVQUFVLE9BQU8sQ0FBQztBQUFBLHNCQUM1QixPQUFPLEtBQUssY0FBYyxFQUM5QyxJQUFJLENBQUMsTUFBTSxLQUFLLEdBQUcsRUFDbkIsS0FBSyxHQUFHO0FBQUEsQ0FDZjtBQUFBLElBQ0EsT0FBTztBQUFBO0FBQUEsRUFFVCxNQUFNLElBQUksTUFBTSxZQUFZO0FBQUEsSUFDMUIsTUFBTSxNQUFNLE9BQU8sT0FBTyxNQUFNLElBQUksSUFBSTtBQUFBLElBQ3hDLE9BQU8sTUFBTTtBQUFBLElBQ2IsUUFBUSxNQUFNO0FBQUEsSUFDZCxTQUFTLE1BQU07QUFBQSxJQUNmLFVBQVUsTUFBTSxVQUFVLE9BQU8sTUFBTSxPQUFPLElBQUk7QUFBQSxJQUNsRCxTQUFTLE1BQU07QUFBQSxFQUNqQixDQUFDO0FBQUEsRUFDRCxRQUFRLE9BQU8sTUFDYixHQUFHLEtBQUssVUFBVSxFQUFFLEtBQUssb0JBQW9CLEVBQUUsUUFBUSxNQUFNLEVBQUUsTUFBTSxZQUFZLEVBQUUsV0FBVyxNQUFNLEVBQUUsS0FBSyxDQUFDO0FBQUEsQ0FDOUc7QUFBQSxFQUNBLE1BQU0sTUFBTSxNQUFNLEVBQUU7QUFBQSxFQUVwQixNQUFNLEVBQUU7QUFBQSxFQUNSLE9BQU8sSUFBSTtBQUFBO0FBMEJiLGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIjIzREI5RkJDMDYyRDY1Q0I2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
