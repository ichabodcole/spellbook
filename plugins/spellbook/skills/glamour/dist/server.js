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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9zZXJ2ZXIudHMiLCAiLi4vc2hhcmVkL3R5cGVzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc3NlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9wZXJzaXN0LnNlcnZlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvZ2xhbW91ci9iYWNrZW5kL3JlZHVjZS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvZ2xhbW91ci9iYWNrZW5kL3N0eWxlcy5zZXJ2ZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHVubGlua1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgYXMgbm9kZVBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7XG4gIHR5cGUgQWdlbnRDb21tYW5kLFxuICB0eXBlIENsaWVudFRvU2VydmVyLFxuICBkZWZhdWx0U3RhdGUsXG4gIHR5cGUgR2xhbW91clN0YXRlLFxufSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dsYW1vdXIvc2hhcmVkL3R5cGVzXCI7XG5pbXBvcnQgeyB1bmxpbmtJZk1hdGNoZXMsIHdyaXRlRmlsZUF0b21pYyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9kaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB7IGNyZWF0ZUV2ZW50TG9nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2V2ZW50TG9nLnRzXCI7XG5pbXBvcnQgeyBkcmFpbkFuZFN0b3AsIHN0YXJ0SG91c2VrZWVwaW5nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hvdXNla2VlcGluZy50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZU1vZGUgYXMgcmVzb2x2ZU1vZGVJbiwgc2VydmVGcm9tRGlzdCB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9zZXJ2ZURpc3QudHNcIjtcbmltcG9ydCB7IHR5cGUgU3NlQ2xpZW50cywgc3NlUmVzcG9uc2UgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvc3NlLnRzXCI7XG5pbXBvcnQgeyBJRExFX1RJTUVPVVRfU0VDLCBTU0VfSEVBUlRCRUFUX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0XCI7XG5pbXBvcnQgeyBsb2FkU25hcHNob3QsIG1hdGVyaWFsaXplSXRlbSwgc2F2ZVNuYXBzaG90IH0gZnJvbSBcIi4vcGVyc2lzdC5zZXJ2ZXJcIjtcbmltcG9ydCB7XG4gIGFkZEl0ZW0sXG4gIGFkZE1lc3NhZ2UsXG4gIGFubm90YXRlLFxuICBhcHBseUFnZW50TXNnLFxuICBidWlsZFN0eWxlSXRlbSxcbiAgY2xlYXJGb2N1cyxcbiAgbGVhbkl0ZW0sXG4gIGxlYW5TdGF0ZSxcbiAgbWFrZUl0ZW0sXG4gIHNlbGVjdEl0ZW1zLFxuICBzZXRDYW5vbmljYWwsXG4gIHNldEZvY3VzLFxuICBzZXRJdGVtQXJjaGl2ZWQsXG4gIHNldExpa2UsXG4gIHNldFN0YXIsXG59IGZyb20gXCIuL3JlZHVjZVwiO1xuaW1wb3J0IHtcbiAgbG9hZFRyYXksXG4gIG1hdGVyaWFsaXplQ2Fub24sXG4gIHByb2plY3RLZXksXG4gIHNhdmVTdHlsZSxcbiAgc2V0U3R5bGVBcmNoaXZlZCxcbn0gZnJvbSBcIi4vc3R5bGVzLnNlcnZlclwiO1xuXG4vLyBUaGUgc3VyZmFjZSdzIEhUTUwgZW50cnkgdXNlZCB0byBiZSBhIHRvcC1sZXZlbCBzdGF0aWMgaW1wb3J0IGhlcmUuIEEgc3RhdGljXG4vLyBpbXBvcnQgZm9yY2VzIEJ1biB0byByZXNvbHZlIHRoZSB3aG9sZSAudHN4ICsgVGFpbHdpbmQgZ3JhcGggd2hlbiB0aGlzIG1vZHVsZVxuLy8gTE9BRFMsIHNvIGEgZGVzdGluYXRpb24gdGhhdCBzaGlwcyBkaXN0LyBhbmQgbm8gc3VyZmFjZSBzb3VyY2Ug4oCUIHRoZSBwdWJsaXNoZWRcbi8vIGFydGlmYWN0IOKAlCBkaWVzIGJlZm9yZSBpdCBjYW4gc2VydmUgdGhlIGRpc3QgaXQgZG9lcyBoYXZlLiBUaGUgZGV2IGltcG9ydCBpc1xuLy8gdGhlcmVmb3JlIGR5bmFtaWMgYW5kIHJlYWNoZWQgb25seSBvbiB0aGUgZGV2IGJyYW5jaCBiZWxvdyAoc2VhbXMgQ29udHJhY3QgMSksXG4vLyBhcyBhc3Ryb2xhYmUsIGltYWdvIGFuZCBtaW5kLW1hcHBlciBkbyBpdC5cbi8vXG4vLyBQYXRocyBhbmNob3IgYXQgdGhlIFNLSUxMIFJPT1QsIG5ldmVyIGF0IGN3ZDogY2xpLnRzIHBpbnMgdGhlIGRhZW1vbidzIGN3ZCBmb3Jcbi8vIGJ1bmZpZy50b21sJ3Mgc2FrZSBpbiBkZXYgKENvbnRyYWN0IDUpLCBzbyBjd2QgaXMgbm90IGEgc3RhYmxlIGJhc2UgZm9yIGRpc3QvLlxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuXG4vLyByZWxlYXNlIGlmZiBkaXN0L2luZGV4Lmh0bWwgZXhpc3RzIGF0IHRoZSBza2lsbCByb290IOKAlCB0aGUgRklMRSwgbmV2ZXIgdGhlXG4vLyBkaXJlY3RvcnkgKGEgYnVpbHQgYmFja2VuZCBjYW4gcHV0IGNsaS5qcyBpbiBkaXN0LyB3aXRoIG5vIHN1cmZhY2UgdGhlcmUpIOKAlFxuLy8gZWxzZSBkZXY7IHRoZSBlbnYgb3ZlcnJpZGUgd2lucyBlaXRoZXIgd2F5IChDb250cmFjdCAxKS4gUmVsZWFzZTogemVybyByZWFkc1xuLy8gb2Ygc3VyZmFjZSBzb3VyY2Ugb3IgYnVuZmlnLnRvbWwg4oCUIHN0YXRpYyBmaWxlcyBvbmx5LlxuLy9cbi8vIFRoZSBwcmVkaWNhdGUgYW5kIHRoZSBzY2FyIGl0IGNhcnJpZXMgYXJlIG5vdyBgc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50c2A7XG4vLyB3aGF0IHN0YXlzIGhlcmUgaXMgV0hJQ0ggZGlyZWN0b3J5IGdsYW1vdXIgcmVzb2x2ZXMgYWdhaW5zdC4gRXhwb3J0ZWQgYmVjYXVzZVxuLy8gdGhpcyBzcGVsbCdzIG93biBzdWl0ZXMgYXNrIGl0LlxuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKCk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIHJldHVybiByZXNvbHZlTW9kZUluKERJU1RfRElSKTtcbn1cblxuLy8gU2VydmVzIGRpc3QvIHZlcmJhdGltIOKAlCBlbnRyeSBpbmRleC5odG1sLCBoYXNoZWQgY2h1bmtzIGJ5IHBhdGggKENvbnRyYWN0IDInc1xuLy8gZmxhdCwgcmVsYXRpdmUtaHJlZiBsYXlvdXQpLiDim5QgVEhFIFVSTOKGkkZJTEVOQU1FIE1BUFBJTkcgU1RBWVMgSEVSRSBPTiBQVVJQT1NFOlxuLy8gdGhlIGtpdCBkZWNpZGVzIHdoZXRoZXIgYSBmaWxlIG1heSBiZSByZWFkIGFuZCB3aGF0IGNvbnRlbnQgdHlwZSBpdCBnZXRzLCBhbmRcbi8vIHRoZSBDQUxMRVIgZGVjaWRlcyB3aGljaCBmaWxlIOKAlCBiZWNhdXNlIHR3byBzcGVsbHMgcm91dGUgdGhpcyBkaWZmZXJlbnRseSBhbmQgYVxuLy8gc2lnbmF0dXJlIHdpZGUgZW5vdWdoIGZvciBib3RoIHN0b3BzIGJlaW5nIGEgZmlsZSBzZXJ2ZXIuIGdsYW1vdXIncyBvd25cbi8vIGBHRVQgL2Fzc2V0cy88bmFtZT5gIHNlc3Npb24tZmlsZXMgcm91dGUgc2l0cyBBQk9WRSB0aGlzIGluIHRoZSBmZXRjaCBjaGFpbixcbi8vIGFuZCBgc2VydmVGcm9tRGlzdGAgcmVmdXNpbmcgYW55dGhpbmcgd2l0aCBhIHNsYXNoIGluIGl0IGlzIHdoYXQga2VlcHMgdGhlIHR3b1xuLy8gZGlzam9pbnQgKGV2ZXJ5IC9hc3NldHMvIHBhdGggaXMgbmVzdGVkLCBzbyBpdCBpcyByZWZ1c2VkIGhlcmUgYW5kIGZhbGxzXG4vLyB0aHJvdWdoKS5cbmZ1bmN0aW9uIHNlcnZlRGlzdChwYXRoOiBzdHJpbmcpOiBSZXNwb25zZSB8IG51bGwge1xuICByZXR1cm4gc2VydmVGcm9tRGlzdChESVNUX0RJUiwgcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSkpO1xufVxuXG5jb25zdCByYW5kSGV4ID0gKG46IG51bWJlcikgPT5cbiAgQXJyYXkuZnJvbShjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKG5ldyBVaW50OEFycmF5KG4pKSlcbiAgICAubWFwKChiKSA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpXG4gICAgLmpvaW4oXCJcIik7XG5cbmV4cG9ydCB0eXBlIFN0YXJ0T3B0cyA9IHtcbiAgcG9ydD86IG51bWJlcjtcbiAgaG9zdD86IHN0cmluZztcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIGludGVudD86IHN0cmluZztcbiAgcmVzdG9yZT86IHN0cmluZztcbiAgdGltZW91dFM/OiBudW1iZXI7XG4gIHByb2plY3Q/OiBzdHJpbmc7XG59O1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnREYWVtb24ob3B0czogU3RhcnRPcHRzKSB7XG4gIGNvbnN0IEdMQU1PVVJfSE9NRSA9IHByb2Nlc3MuZW52LkdMQU1PVVJfSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuZ2xhbW91clwiKTtcbiAgY29uc3QgU05BUFNIT1RTX0RJUiA9IGpvaW4oR0xBTU9VUl9IT01FLCBcInNuYXBzaG90c1wiKTtcbiAgbGV0IHN0YXRlOiBHbGFtb3VyU3RhdGUgPSBkZWZhdWx0U3RhdGUob3B0cy50aXRsZSA/PyBcIlwiLCBvcHRzLmludGVudCA/PyBcIlwiKTtcbiAgbGV0IHJlc3RvcmVkID0gZmFsc2U7XG4gIGlmIChvcHRzLnJlc3RvcmUpIHtcbiAgICBjb25zdCBwYXRoID0gZXhpc3RzU3luYyhvcHRzLnJlc3RvcmUpXG4gICAgICA/IG9wdHMucmVzdG9yZVxuICAgICAgOiBqb2luKFNOQVBTSE9UU19ESVIsIGAke29wdHMucmVzdG9yZX0uanNvbmApO1xuICAgIHRyeSB7XG4gICAgICBzdGF0ZSA9IGxvYWRTbmFwc2hvdChwYXRoLCBvcHRzLnRpdGxlID8/IFwiXCIsIG9wdHMuaW50ZW50ID8/IFwiXCIpO1xuICAgICAgcmVzdG9yZWQgPSB0cnVlO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBnbGFtb3VyOiByZXN0b3JlIGZhaWxlZCAoJHtwYXRofSk6ICR7ZX1cXG5gKTtcbiAgICB9XG4gIH1cbiAgY29uc3QgUFJPSkVDVF9LRVkgPSBwcm9qZWN0S2V5KG9wdHMucHJvamVjdCA/PyBwcm9jZXNzLmN3ZCgpKTtcbiAgLy8gLS0tIG1vZGUsIHJlc29sdmVkIEJFRk9SRSBhbnkgZmlsZXN5c3RlbSB3cml0ZSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBBIGZvcmNlZC1kZXYgYm9vdCBhdCBhIHN1cmZhY2UtZnJlZSBkZXN0aW5hdGlvbiBtdXN0IGRpZSBIRVJFLCBhdCB0aGUgaW1wb3J0LFxuICAvLyBoYXZpbmcgd3JpdHRlbiBub3RoaW5nOiBubyBzZXNzaW9uLWZpbGVzIGRpciwgbm8gZGlzY292ZXJ5IHBvaW50ZXIuIE1lYXN1cmVkXG4gIC8vIGluIHRoZSBsb2NhbC1zaW06IHdpdGggdGhpcyBibG9jayBwbGFjZWQgYWZ0ZXIgdGhlIHNlc3Npb24tZmlsZXMgbWtkaXIsIGFcbiAgLy8gZHlpbmcgZGFlbW9uIGxlZnQgYCRUTVBESVIvZ2xhbW91ci08aWQ+LWZpbGVzL2AgYmVoaW5kIG9uIGV2ZXJ5IGZhaWxlZCBib290LlxuICBjb25zdCBtb2RlID0gcmVzb2x2ZU1vZGUoKTtcbiAgLy8gZGV2OiB0aGUgZHluYW1pYyBzdHJpbmctbGl0ZXJhbCBpbXBvcnQga2VlcHMgdGhlIHN1cmZhY2UgZ3JhcGggb2ZmIHRoZSBtb2R1bGVcbiAgLy8gbG9hZCBwYXRoIChDb250cmFjdCAxKSDigJQgQnVuIGJ1bmRsZXMgdGhlIC50c3ggZ3JhcGggKyBUYWlsd2luZCBhdCBzZXJ2ZSB0aW1lLFxuICAvLyByZWFkaW5nIGJ1bmZpZy50b21sIGZyb20gY3dkLCB3aGljaCBjbGkudHMgcGlucyB0byBzcmMvZ2xhbW91ci8gKENvbnRyYWN0IDUpLlxuICAvLyByZWxlYXNlOiBkaXN0LyBpcyBzdGF0aWMgYW5kIHByZS1idWlsdCAoQ29udHJhY3QgMikg4oCUIFwiL1wiIGlzIGFuc3dlcmVkIGJ5XG4gIC8vIHNlcnZlRGlzdCgpIGluIHRoZSBmZXRjaCBmYWxsLXRocm91Z2gsIHNvIHRoaXMgYnJhbmNoIG5ldmVyIHRvdWNoZXMgc3VyZmFjZVxuICAvLyBzb3VyY2Ugb3IgYnVuZmlnLnRvbWwgYW5kIG5ldmVyIG5lZWRzIGVpdGhlciB0byBleGlzdC4gQnVuJ3MgUm91dGVzIHR5cGUgdGllc1xuICAvLyB0aGUgXCIvXCIgdmFsdWUncyB0eXBlIHRvIHRoZSBsaXRlcmFsIG9iamVjdCBzaGFwZSwgc28gdGhlIG1vZGUtdGVybmFyeSB1bmlvblxuICAvLyBpcyBjYXN0OyB0aGUgcnVudGltZSBiZWhhdmlvdXIgKEhUTUxCdW5kbGUgaW4gZGV2LCBhYnNlbnQgaW4gcmVsZWFzZSkgaXNcbiAgLy8gY29ycmVjdCBlaXRoZXIgd2F5LiBUaGlzIGlzIHRoZSBPTkUgc3JjLy1uYW1pbmcgc3BlY2lmaWVyIGluIHRoZSBkZXBsb3llZFxuICAvLyBzcGVsbCAocGxhbiBTMiwgcmF0aWZpZWQgYXQgdGhlIHNwZWNpZmllciBncmFpbikuXG4gIGNvbnN0IGRldkluZGV4ID1cbiAgICBtb2RlID09PSBcImRldlwiXG4gICAgICA/IChhd2FpdCBpbXBvcnQoXCIuLi8uLi8uLi8uLi8uLi9zcmMvZ2xhbW91ci9zdXJmYWNlL2luZGV4Lmh0bWxcIikpLmRlZmF1bHRcbiAgICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCByb3V0ZXMgPSAoZGV2SW5kZXggPyB7IFwiL1wiOiBkZXZJbmRleCB9IDoge30pIGFzIFJlY29yZDxzdHJpbmcsIG5ldmVyPjtcbiAgLy8gTG9hZCB0aGUgcHJvamVjdCdzIHNhdmVkIHN0eWxlcyBpbnRvIHRoZSB0cmF5IChtZXRhZGF0YSBvbmx5IOKAlCBOT1QgdGhlXG4gIC8vIGxpYnJhcnkpLiBEbyB0aGlzIGFmdGVyIHJlc3RvcmUgc28gYSByZXN0b3JlZCBzbmFwc2hvdCdzIHN0YWxlIHRyYXkgaXNcbiAgLy8gcmVwbGFjZWQgYnkgdGhlIGF1dGhvcml0YXRpdmUgb24tZGlzayBzZXQuXG4gIHN0YXRlLnRyYXkgPSBsb2FkVHJheShHTEFNT1VSX0hPTUUsIFBST0pFQ1RfS0VZKTtcblxuICAvLyAtLS0gY2hhbm5lbHMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHNvY2tldHMgPSBuZXcgU2V0PGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4+KCk7XG4gIC8vIFRoZSByZXBsYXkgbG9nIGJlaGluZCBgR0VUIC9ldmVudHM/c2luY2U9PGlkPmAg4oCUIHNoYXJlZFxuICAvLyAoYGtpdC93aXJlL2V2ZW50TG9nLnRzYCksIHNvIGdsYW1vdXIgaW5oZXJpdHMgdGhlIGJvdW5kZWQgYnVmZmVyLCB0aGVcbiAgLy8gbW9ub3RvbmljIGlkIHRoYXQgYWN0dWFsbHkgV0lOUyBvdmVyIGEgcGF5bG9hZCBgaWRgLCBhbmQgdGhlIHN0YWxlLXdhdGVybWFya1xuICAvLyByZXBsYXkgdGhhdCBsZXRzIGEgdGFpbCByZXN1bWluZyBhZ2FpbnN0IGEgcmVzdGFydGVkIGRhZW1vbiByZWNlaXZlIGFueXRoaW5nXG4gIC8vIGF0IGFsbC4gZ2xhbW91ciBzdGFtcHMgTk8gRVBPQ0g6IGEgc2Vzc2lvbiBpcyBpZGVudGlmaWVkIGJ5IGBzZXNzaW9uX2lkYCwgYVxuICAvLyByZXN0YXJ0IGlzIGEgZGlmZmVyZW50IHNlc3Npb24sIGFuZCBhIHJlc3VtaW5nIHRhaWwgaXMgYWxyZWFkeSB0YWxraW5nIHRvIGFcbiAgLy8gZGlmZmVyZW50IGRhZW1vbiBieSBuYW1lIChEMTkncyByZWFzb25pbmcgZm9yIG1hZ3BpZSwgYW5kIGl0IGlzIGdsYW1vdXIncyB0b28pLlxuICBjb25zdCBsb2cgPSBjcmVhdGVFdmVudExvZzxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oKTtcbiAgY29uc3Qgc3NlQ2xpZW50czogU3NlQ2xpZW50cyA9IG5ldyBTZXQoKTtcbiAgbGV0IGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICBjb25zdCB0b3VjaCA9ICgpID0+IHtcbiAgICBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgfTtcblxuICBjb25zdCBicm9hZGNhc3QgPSAobXNnOiBvYmplY3QpID0+IHtcbiAgICBjb25zdCBzID0gSlNPTi5zdHJpbmdpZnkobXNnKTtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLnNlbmQocyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogc29ja2V0IGNsb3NlZCAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcbiAgbGV0IHNuYXBEaXJ0eSA9IGZhbHNlO1xuICBjb25zdCBicm9hZGNhc3RTdGF0ZSA9ICgpID0+IHtcbiAgICBzbmFwRGlydHkgPSB0cnVlO1xuICAgIGJyb2FkY2FzdCh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGUgfSk7XG4gIH07XG4gIGNvbnN0IGVtaXRFdmVudCA9IChtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBsb2cuZW1pdChtc2cpO1xuXG4gIC8vIFByZXNlbmNlIGlzIHRyYW5zaWVudDogc3RyZWFtIHRvIGxpdmUgU1NFIGNsaWVudHMgYnV0IERPIE5PVCBzdG9yZSBpdCBpblxuICAvLyB0aGUgcmVwbGF5IGxvZyAoYSByZWNvbm5lY3RpbmcgYWdlbnQgc2hvdWxkIG5vdCByZS1zZWUgZXZlcnkgcGFzdFxuICAvLyBjb25uZWN0L2Rpc2Nvbm5lY3QpLiBObyBpZCBpcyBhc3NpZ25lZCwgc28gaXQgbmV2ZXIgYWR2YW5jZXMgYSB0YWlsIGN1cnNvci5cbiAgLy9cbiAgLy8g4puUIFRISVMgSVMgVEhFIE9ORSBUSElORyBUSEUgU0hBUkVEIFNTRSBNT0RVTEUgQ09VTEQgTk9UIERPLCBBTkQgSVQgV0FTXG4gIC8vIFdJREVORUQgUkFUSEVSIFRIQU4gV09SS0VEIEFST1VORC4gYFNzZUNsaWVudHNgIGhlbGQgYmFyZSBjbG9zZXJzLCBiZWNhdXNlXG4gIC8vIGFzdHJvbGFiZSBhbmQgbWFncGllIGFubm91bmNlIHByZXNlbmNlIG92ZXIgdGhlaXIgYnJvd3NlciBXRUJTT0NLRVQgYW5kIG5ldmVyXG4gIC8vIG5lZWRlZCB0byBwdXNoIGFuIHVubG9nZ2VkIGZyYW1lIGF0IHRoZSBhZ2VudCdzIHRhaWwuIEtlZXBpbmcgYSBzZWNvbmQsXG4gIC8vIHBhcmFsbGVsIGBTZXQ8UmVhZGFibGVTdHJlYW1EZWZhdWx0Q29udHJvbGxlcj5gIGhlcmUgd291bGQgaGF2ZSByZS1jcmVhdGVkXG4gIC8vIGV4YWN0bHkgdGhlIGRyaWZ0IHRoZSByZWdpc3RyeSBleGlzdHMgdG8gcmVtb3ZlIOKAlCBhbmQgaXQgaXMgdGhlIGRyaWZ0IHRoYXRcbiAgLy8gbW9kdWxlJ3Mgb3duIGhlYWRlciB3YXJucyBhYm91dCwgd2hlcmUgYSBwZXItc3RyZWFtIHRpbWVyIHdhcyBzd2VwdCBmcm9tIGFcbiAgLy8gc2Vjb25kIHNldCBhbmQgY291bGQgZmFsbCBvdXQgb2Ygc3RlcC4gU28gdGhlIHJlZ2lzdHJ5IGVudHJ5IGdhaW5lZCBgc2VuZGAsXG4gIC8vIHdoaWNoIHJvdXRlcyB0aHJvdWdoIHRoZSBzYW1lIGNsb3NlZC1jaGVjayBhbmQgdGVhcmRvd24gZnVubmVsIGFzIGV2ZXJ5IG90aGVyXG4gIC8vIHdyaXRlLiBSZXBvcnRlZCBhcyBhIGZpbmRpbmcgYWJvdXQgdGhlIG1vZHVsZSwgcGVyIHRoZSBwaGFzZSBicmllZi5cbiAgY29uc3QgZW1pdFRyYW5zaWVudCA9IChtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgY29uc3QgZnJhbWUgPSBgZGF0YTogJHtKU09OLnN0cmluZ2lmeShtc2cpfVxcblxcbmA7XG4gICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIGMuc2VuZChmcmFtZSk7XG4gIH07XG5cbiAgLy8gLS0tIHNlc3Npb24gZmlsZXMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzZXNzaW9uSWQgPSBgZ2xhbW91ci0ke3JhbmRIZXgoNCl9YDtcbiAgY29uc3Qgc2Vzc2lvbkZpbGVzRGlyID0gam9pbih0bXBkaXIoKSwgYCR7c2Vzc2lvbklkfS1maWxlc2ApO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhzZXNzaW9uRmlsZXNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIGJhY2sgdG8gbm8gcGF0aHMgKi9cbiAgfVxuICBpZiAocmVzdG9yZWQpIHtcbiAgICBmb3IgKGNvbnN0IGl0IG9mIHN0YXRlLmxpYnJhcnkpIG1hdGVyaWFsaXplSXRlbShzZXNzaW9uRmlsZXNEaXIsIGl0KTtcbiAgfVxuXG4gIC8vIC0tLSBhZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBsZXQgcmVzb2x2ZURvbmUhOiAodjogeyBjb2RlOiBudW1iZXI7IHJlYXNvbjogc3RyaW5nIH0pID0+IHZvaWQ7XG4gIGNvbnN0IGRvbmUgPSBuZXcgUHJvbWlzZTx7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmcgfT4oKHIpID0+IHtcbiAgICByZXNvbHZlRG9uZSA9IHI7XG4gIH0pO1xuXG4gIC8vICM4NCDigJQgUkVUVVJOUyBBIFZFUkRJQ1QuIFByZXZpb3VzbHkgdm9pZCwgc28gdGhlIC9jbWQgcm91dGUgaGFkIG5vdGhpbmcgdG9cbiAgLy8gcmVwb3J0IGFuZCBhbnN3ZXJlZCBhIGxpdGVyYWwge29rOnRydWV9IHRvIGV2ZXJ5IGNvbW1hbmQgaW5jbHVkaW5nIG9uZXMgaXRcbiAgLy8gZHJvcHBlZC4gTm90ZSB0aGUgZGVmZWN0IGlzIE5PVCBhIG1pc3NpbmcgYGF3YWl0YDogdGhpcyBoYW5kbGVyIGlzXG4gIC8vIHN5bmNocm9ub3VzLCBhbmQgaW1hZ28ncyB0d2luIElTIGNvcnJlY3RseSBhd2FpdGVkIGFuZCB3YXMgYnJva2VuIGFueXdheS5cbiAgLy8gVGhlIGZpeCBpcyB0aGF0IGEgZGVjaXNpb24gZXhpc3RzIGF0IGFsbC5cbiAgLy8gQ29udHJhY3QgMTM6IHRoZSB2ZXJkaWN0IG9yaWdpbmF0ZXMgaW4gdGhlIGNvZGUgb3duaW5nIHRoZSByZWNvZ25pc2VkIHNldC5cbiAgLy8gYjEyIHdpZGVucyB0aGUgUkVUVVJOIHdpdGhvdXQgd2lkZW5pbmcgdGhlIENPTlRSQUNUIOKAlCBhIGNvbW1hbmQgbWF5IGFuc3dlclxuICAvLyB3aXRoIGEgcmVzdWx0IG9iamVjdCBjYXJyeWluZyBpdHMgb3duIHBheWxvYWQgaW5zdGVhZCBvZiB0aGUgYm9vbGVhbi4gRXZlcnlcbiAgLy8gb3RoZXIgY29tbWFuZCBzdGlsbCByZXR1cm5zIGEgYmFyZSBib29sZWFuIGFuZCBpdHMgcmVzcG9uc2UgaXNcbiAgLy8gYnl0ZS1pZGVudGljYWwuIFNhbWUgc2hhcGUgYXMgaW1hZ28ncyBjb250ZXh0LmFkZCAoNWU2YWFjZCkuXG4gIHR5cGUgQWdlbnRWZXJkaWN0ID0gYm9vbGVhbiB8IHsgcmVjb2duaXNlZDogdHJ1ZTsgb2s6IHRydWU7IGRldGFpbDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfTtcbiAgY29uc3QgaGFuZGxlQWdlbnRNc2cgPSAobXNnOiBBZ2VudENvbW1hbmQpOiBBZ2VudFZlcmRpY3QgPT4ge1xuICAgIGlmIChtc2cudHlwZSA9PT0gXCJzYXlcIikge1xuICAgICAgYWRkTWVzc2FnZShzdGF0ZSwge1xuICAgICAgICBpZDogYG0tJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgIHdobzogXCJhZ2VudFwiLFxuICAgICAgICBraW5kOiBtc2cua2luZCA/PyBcImluZm9cIixcbiAgICAgICAgdGV4dDogbXNnLnRleHQsXG4gICAgICAgIGdyb3VuZDogW10sXG4gICAgICAgIHRzOiBEYXRlLm5vdygpLFxuICAgICAgfSk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChtc2cudHlwZSA9PT0gXCJjbG9zZVwiKSB7XG4gICAgICByZXNvbHZlRG9uZSh7IGNvZGU6IDAsIHJlYXNvbjogXCJjbG9zZVwiIH0pO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChtc2cudHlwZSA9PT0gXCJnZW4uYWRkXCIpIHtcbiAgICAgIGNvbnN0IGl0ID0gbWFrZUl0ZW0oe1xuICAgICAgICBpZDogYGdlbi0ke3JhbmRIZXgoNCl9YCxcbiAgICAgICAga2luZDogXCJnZW5cIixcbiAgICAgICAgdGl0bGU6IG1zZy5sYWJlbCA/PyBgcm91bmQgJHttc2cucm91bmR9YCxcbiAgICAgICAgc3JjOiBtc2cuc3JjLFxuICAgICAgICBtaW1lOiBcImltYWdlL3dlYnBcIixcbiAgICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgICBnZW46IHtcbiAgICAgICAgICBtb2RlbDogbXNnLm1vZGVsLFxuICAgICAgICAgIHByb21wdDogbXNnLnByb21wdCxcbiAgICAgICAgICBzZWVkOiBtc2cuc2VlZCA/PyBudWxsLFxuICAgICAgICAgIGNvc3Q6IG1zZy5jb3N0ID8/IG51bGwsXG4gICAgICAgICAgY3VzdG9tOiBtc2cuY3VzdG9tID8/IHt9LFxuICAgICAgICAgIHJvdW5kOiBtc2cucm91bmQsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIG1hdGVyaWFsaXplSXRlbShzZXNzaW9uRmlsZXNEaXIsIGl0KTtcbiAgICAgIC8vIGIxMiArICM4NyAodGhpcmQgc3BlbGwpIOKAlCBgaWYgKGFkZEl0ZW0oc3RhdGUsIGl0KSkgYnJvYWRjYXN0U3RhdGUoKWBcbiAgICAgIC8vIGRyb3BwZWQgdGhlIG11dGF0b3IncyBvdXRjb21lIGludG8gY29udHJvbCBmbG93IGFuZCBhbnN3ZXJlZCBvazp0cnVlXG4gICAgICAvLyBlaXRoZXIgd2F5LiBUd28gdGhpbmdzIHdlcmUgd3JvbmcgYW5kIG9ubHkgb25lIGlzIHdoYXQgdGhlIGNhcmQgc2FpZDpcbiAgICAgIC8vXG4gICAgICAvLyAgIFJFQUNIQUJMRSwgZXZlcnkgY2FsbDogdGhlIG1pbnRlZCBpZCB3YXMgRElTQ0FSREVELCBzbyB0aGUgYWdlbnQgdGhhdFxuICAgICAgLy8gICBqdXN0IGNyZWF0ZWQgYW4gaXRlbSBjb3VsZCBub3QgcmVmZXJlbmNlIGl0LiBUaGF0IGlzICM4NydzIGRlZmVjdCBpbiBhXG4gICAgICAvLyAgIHRoaXJkIGNvZGViYXNlIChpbWFnbyBjb250ZXh0LmFkZCwgYW5kIHRoaXMpLlxuICAgICAgLy9cbiAgICAgIC8vICAgTk9UIFJFQUNIQUJMRSBpbiBwcmFjdGljZTogdGhlIFwic2lsZW50IGRlZHVwZVwiLiBgaWRgIGlzIG1pbnRlZCBIRVJFXG4gICAgICAvLyAgIChgZ2VuLSR7cmFuZEhleCg0KX1gKSBhbmQgdGhlIGNhbGxlciBjYW5ub3Qgc3VwcGx5IG9uZSDigJQgYGJ1aWxkR2VuQ21kYFxuICAgICAgLy8gICBoYXMgbm8gaWQgZmllbGQsIGFuZCB0aGlzIGxpbmUgaWdub3JlcyBhbnkgdGhhdCBhcnJpdmVkIOKAlCBzbyBhZGRJdGVtXG4gICAgICAvLyAgIHJldHVybnMgZmFsc2Ugb25seSBvbiBhIDJeMzIgY29sbGlzaW9uLiBUaGUgYnJhbmNoIHdhcyBkZWFkLCBub3RcbiAgICAgIC8vICAgZGFuZ2Vyb3VzLiBJdCBpcyByZXBvcnRlZCBob25lc3RseSBub3cgcmF0aGVyIHRoYW4gcmVtb3ZlZCwgYmVjYXVzZSBhXG4gICAgICAvLyAgIGNvbGxpc2lvbiB0aGF0IERJRCBoYXBwZW4gd291bGQgb3RoZXJ3aXNlIGJlIHRoZSBzaWxlbnQgY2FzZS5cbiAgICAgIGNvbnN0IGFkZGVkID0gYWRkSXRlbShzdGF0ZSwgaXQpO1xuICAgICAgaWYgKGFkZGVkKSBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcmVjb2duaXNlZDogdHJ1ZSxcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIGRldGFpbDogeyBpZDogaXQuaWQsIG91dGNvbWU6IGFkZGVkID8gXCJjcmVhdGVkXCIgOiBcImFscmVhZHktcmVjb3JkZWRcIiB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKG1zZy50eXBlID09PSBcInN0eWxlLnNhdmVcIikge1xuICAgICAgY29uc3QgY2Fub25pY2FsSXRlbXMgPSBzdGF0ZS5saWJyYXJ5LmZpbHRlcigoaSkgPT4gaS5jYW5vbmljYWwgJiYgIWkuYXJjaGl2ZWQpO1xuICAgICAgY29uc3QgYWdyZWVkID0gc3RhdGUuc3R5bGVHdWlkZS5maWx0ZXIoKHMpID0+IHMuc3RhdHVzICE9PSBcImVtcHR5XCIgJiYgcy5jb250ZW50KTtcbiAgICAgIGNvbnN0IHRleHQgPSBhZ3JlZWRcbiAgICAgICAgLm1hcCgocykgPT4gcy5jb250ZW50KVxuICAgICAgICAuam9pbihcIiDCtyBcIilcbiAgICAgICAgLnNsaWNlKDAsIDI4MCk7XG4gICAgICBjb25zdCBzdHlsZSA9IHNhdmVTdHlsZShHTEFNT1VSX0hPTUUsIFBST0pFQ1RfS0VZLCB7XG4gICAgICAgIGlkOiBgc3R5bGUtJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgIGxhYmVsOiBtc2cubGFiZWwsXG4gICAgICAgIHRleHQsXG4gICAgICAgIHNlY3Rpb25zOiBzdGF0ZS5zdHlsZUd1aWRlLFxuICAgICAgICBjYW5vbmljYWxJdGVtcyxcbiAgICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgfSk7XG4gICAgICBzdGF0ZS50cmF5LnB1c2goc3R5bGUpO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAobXNnLnR5cGUgPT09IFwic3R5bGUuYXJjaGl2ZVwiKSB7XG4gICAgICBzZXRTdHlsZUFyY2hpdmVkKEdMQU1PVVJfSE9NRSwgUFJPSkVDVF9LRVksIG1zZy5pZCwgbXNnLmFyY2hpdmVkKTtcbiAgICAgIGFwcGx5QWdlbnRNc2coc3RhdGUsIG1zZyk7IC8vIGZsaXBzIHRoZSBpbi1tZW1vcnkgdHJheSBlbnRyeVxuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICAvLyBUaGUgZmFsbHRocm91Z2ggaXMgdGhlIG9ubHkgcGF0aCB0aGF0IGNhbiBiZSBVTlJFQ09HTklTRUQsIGFuZCB0aGVcbiAgICAvLyByZWR1Y2VyIGlzIHdoYXQga25vd3M6IGl0IG93bnMgdGhlIGNhc2UgbGlzdCwgc28gdGhlIHZlcmRpY3QgY29tZXMgZnJvbVxuICAgIC8vIHRoZXJlIHJhdGhlciB0aGFuIGZyb20gYSBzZWNvbmQgZW51bWVyYXRpb24gaGVyZS5cbiAgICBjb25zdCByZWNvZ25pc2VkID0gYXBwbHlBZ2VudE1zZyhzdGF0ZSwgbXNnKTtcbiAgICBpZiAocmVjb2duaXNlZCkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4gcmVjb2duaXNlZDtcbiAgfTtcblxuICAvLyAtLS0gYnJvd3NlciBtZXNzYWdlcyAoV2ViU29ja2V0KSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgaGFuZGxlQ2xpZW50TXNnID0gKG1zZzogQ2xpZW50VG9TZXJ2ZXIpID0+IHtcbiAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XG4gICAgICBjYXNlIFwiaXRlbS5hZGRcIjoge1xuICAgICAgICBjb25zdCBpdCA9IG1ha2VJdGVtKHtcbiAgICAgICAgICBpZDogYCR7bXNnLml0ZW0ua2luZH0tJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgICAga2luZDogbXNnLml0ZW0ua2luZCxcbiAgICAgICAgICB0aXRsZTogbXNnLml0ZW0udGl0bGUsXG4gICAgICAgICAgc3JjOiBtc2cuaXRlbS5zcmMsXG4gICAgICAgICAgdGV4dDogbXNnLml0ZW0udGV4dCxcbiAgICAgICAgICBtaW1lOiBtc2cuaXRlbS5taW1lID8/IFwiXCIsXG4gICAgICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgICB9KTtcbiAgICAgICAgbWF0ZXJpYWxpemVJdGVtKHNlc3Npb25GaWxlc0RpciwgaXQpO1xuICAgICAgICBpZiAoYWRkSXRlbShzdGF0ZSwgaXQpKSB7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgICBlbWl0RXZlbnQoe1xuICAgICAgICAgICAgdHlwZTogXCJpdGVtLmFkZFwiLFxuICAgICAgICAgICAgaXRlbTogbGVhbkl0ZW0oaXQpLFxuICAgICAgICAgICAgc2VsZWN0ZWRJZHM6IHN0YXRlLnNlbGVjdGVkSWRzLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcIml0ZW0uc2VsZWN0XCI6XG4gICAgICAgIHNlbGVjdEl0ZW1zKHN0YXRlLCBtc2cuaWRzKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5zdGFyXCI6XG4gICAgICAgIGlmIChzZXRTdGFyKHN0YXRlLCBtc2cuaWQsIG1zZy5zdGFycmVkKSkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5saWtlXCI6XG4gICAgICAgIGlmIChzZXRMaWtlKHN0YXRlLCBtc2cuaWQsIG1zZy5saWtlZCkpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIml0ZW0uYW5ub3RhdGVcIjpcbiAgICAgICAgLy8gQW1iaWVudDogdGhlIGh1bWFuJ3MgcGVyLWl0ZW0gbm90ZSBpcyBzdG9yZWQgKyBVSS1zeW5jZWQgKyBwZXJzaXN0ZWQsXG4gICAgICAgIC8vIGFuZCB0aGUgYWdlbnQgcmVhZHMgaXQgb24gZGVtYW5kIGZyb20gc3RhdGUgd2hlbiBpdCBsb29rcyBhdCB0aGUgaW1hZ2UuXG4gICAgICAgIC8vIEl0IGlzIE5PVCBwdXNoZWQgYXMgYW4gYWdlbnQgZXZlbnQg4oCUIGEgc3RpY2t5IG5vdGUsIG5vdCBhIHJlYWwtdGltZVxuICAgICAgICAvLyBzaWduYWwgKHNlZSB0aGUgZXZlbnQtdm9sdW1lIGxlc3NvbjsgYXZvaWRzIGludGVycnVwdGluZyB0aGUgYWdlbnQgb25cbiAgICAgICAgLy8gZXZlcnkgYmx1cikuXG4gICAgICAgIGlmIChhbm5vdGF0ZShzdGF0ZSwgbXNnLmlkLCBcImh1bWFuXCIsIG1zZy5odW1hbikpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIm1lc3NhZ2Uuc2VuZFwiOiB7XG4gICAgICAgIGNvbnN0IGdyb3VuZCA9IFsuLi5zdGF0ZS5zZWxlY3RlZElkc107XG4gICAgICAgIGFkZE1lc3NhZ2Uoc3RhdGUsIHtcbiAgICAgICAgICBpZDogYG0tJHtyYW5kSGV4KDQpfWAsXG4gICAgICAgICAgd2hvOiBcInVzZXJcIixcbiAgICAgICAgICBraW5kOiBcImluZm9cIixcbiAgICAgICAgICB0ZXh0OiBtc2cudGV4dCxcbiAgICAgICAgICBncm91bmQsXG4gICAgICAgICAgdHM6IERhdGUubm93KCksXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcIm1lc3NhZ2UudXNlclwiLCB0ZXh0OiBtc2cudGV4dCwgZ3JvdW5kIH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmb2N1cy5zZXRcIjpcbiAgICAgICAgc2V0Rm9jdXMoc3RhdGUsIG1zZy5pZHMsIFwieW91XCIpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJmb2N1cy5jbGVhclwiOlxuICAgICAgICBjbGVhckZvY3VzKHN0YXRlKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5jYW5vbmljYWxcIjpcbiAgICAgICAgaWYgKHNldENhbm9uaWNhbChzdGF0ZSwgbXNnLmlkLCBtc2cuY2Fub25pY2FsKSkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5hcmNoaXZlXCI6XG4gICAgICAgIGlmIChzZXRJdGVtQXJjaGl2ZWQoc3RhdGUsIG1zZy5pZCwgbXNnLmFyY2hpdmVkKSkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwic3R5bGUuYnJpbmdJblwiOiB7XG4gICAgICAgIGNvbnN0IHN0eWxlID0gc3RhdGUudHJheS5maW5kKChzKSA9PiBzLmlkID09PSBtc2cuaWQpO1xuICAgICAgICBpZiAoIXN0eWxlKSBicmVhaztcbiAgICAgICAgY29uc3QgaXRlbUlkID0gYHN0eWxlLSR7c3R5bGUuaWR9YDtcbiAgICAgICAgaWYgKHN0YXRlLmxpYnJhcnkuc29tZSgoaSkgPT4gaS5pZCA9PT0gaXRlbUlkKSkgYnJlYWs7IC8vIGlkZW1wb3RlbnRcbiAgICAgICAgY29uc3QgY2Fub24gPSBtYXRlcmlhbGl6ZUNhbm9uKEdMQU1PVVJfSE9NRSwgUFJPSkVDVF9LRVksIHN0eWxlKTtcbiAgICAgICAgY29uc3QgaXQgPSBidWlsZFN0eWxlSXRlbShzdHlsZSwgY2Fub24sIERhdGUubm93KCkpO1xuICAgICAgICBpZiAoYWRkSXRlbShzdGF0ZSwgaXQpKSB7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcIml0ZW0uYWRkXCIsIGl0ZW06IGxlYW5JdGVtKGl0KSwgc2VsZWN0ZWRJZHM6IHN0YXRlLnNlbGVjdGVkSWRzIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICAvLyBHRVQgL2V2ZW50cz9zaW5jZT08aWQ+IOKAlCByZXBsYXksIHRoZW4gc3RheSBvcGVuIGZvciBsaXZlIGZyYW1lcyBwbHVzIGFcbiAgLy8gaGVhcnRiZWF0IGNvbW1lbnQuIE9uZSBjYWxsIGludG8gYGtpdC93aXJlL3NzZS50c2AsIHdoaWNoIGlzIHdoZXJlIHRoZVxuICAvLyB0ZWFyZG93biBmdW5uZWwgbGl2ZXM6IGBjYW5jZWwoKWAsIGByZXEuc2lnbmFsYCBhbmQgYSBmYWlsZWQgZW5xdWV1ZSBhbGxcbiAgLy8gcmVhY2ggaXQsIGF0IG1vc3Qgb25jZSwgYW5kIHRoYXQgZnVubmVsIGlzIHdoYXQgYm91bmRzIHRoZSBzdWJzY3JpYmVyIGNvdW50XG4gIC8vIHRoZSBpZGxlIHN3ZWVwIHJlYWRzLiBUaGUgb2xkIGNvcHkgaGVyZSByZWxpZWQgb24gYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgdG9cbiAgLy8gbm90aWNlIGEgZGVwYXJ0ZWQgY2xpZW50LCB3aGljaCB3YXMgTUVBU1VSRUQgb24gQnVuIDEuMy4xNCBub3QgdG8gd29yayDigJRcbiAgLy8gZW5xdWV1ZSBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gYnVmZmVycyBzaWxlbnRseSBhbmQgbmV2ZXIgdGhyb3dzIOKAlCBhbmQgaXQgd2FzXG4gIC8vIG5vdCB3aXJlZCB0byBgcmVxLnNpZ25hbGAgYXQgYWxsLCBzbyBhIGNsaWVudCB0aGF0IHZhbmlzaGVkIHdpdGhvdXRcbiAgLy8gY2FuY2VsbGluZyB3YXMgY291bnRlZCBhcyBwcmVzZW50IGZvciB0aGUgbGlmZSBvZiB0aGUgZGFlbW9uLlxuICAvL1xuICAvLyDimqAgQU5EIFRIRSBIRUFSVEJFQVQgSVMgTk8gTE9OR0VSIEEgTElURVJBTC4gSXQgd2FzIGAxNTAwMGAsIGhhcmQtY29kZWQgaGVyZSxcbiAgLy8gYmVzaWRlIGEgYEJ1bi5zZXJ2ZWAgYGlkbGVUaW1lb3V0OiAyNTVgIGFuZCBhIGNvbW1lbnQgZXhwbGFpbmluZyB0aGF0IHRoZSB0d29cbiAgLy8gYXJlIGNoYWluZWQuIFRoZXkgbm93IGNvbWUgZnJvbSBgLi9oZWFydGJlYXQudHNgLCB3aGljaCBkZXJpdmVzIHRoZSBwYWlyIOKAlCBzb1xuICAvLyB0aGUgaW52YXJpYW50IGhvbGRzIGZvciBhbnkgdmFsdWUsIG5vdCBvbmx5IGZvciB0aGUgdHdvIHRoYXQgaGFwcGVuZWQgdG8gYmVcbiAgLy8gd3JpdHRlbi5cbiAgY29uc3QgZXZlbnRzUmVzcG9uc2UgPSAocmVxOiBSZXF1ZXN0LCB1cmw6IFVSTCk6IFJlc3BvbnNlID0+IHtcbiAgICB0b3VjaCgpO1xuICAgIHJldHVybiBzc2VSZXNwb25zZSh7XG4gICAgICBsb2csXG4gICAgICBzaW5jZTogTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic2luY2VcIikgPz8gXCItMVwiLCAxMCksXG4gICAgICBoZWFydGJlYXRNczogU1NFX0hFQVJUQkVBVF9NUyxcbiAgICAgIGNsaWVudHM6IHNzZUNsaWVudHMsXG4gICAgICBzaWduYWw6IHJlcS5zaWduYWwsXG4gICAgICBvbk9wZW46IHRvdWNoLFxuICAgICAgb25DbG9zZTogdG91Y2gsXG4gICAgfSk7XG4gIH07XG5cbiAgLy8gLS0tIHNlcnZlIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzZXJ2ZXIgPSBCdW4uc2VydmUoe1xuICAgIHBvcnQ6IG9wdHMucG9ydCA/PyAwLFxuICAgIGhvc3RuYW1lOiBvcHRzLmhvc3QgPz8gXCIxMjcuMC4wLjFcIixcbiAgICByb3V0ZXMsXG4gICAgLy8g4puUIEhFTEQgU1NFIENPTk5FQ1RJT05TIERJRSBXSVRIT1VUIFRISVMuIEJ1bidzIGRlZmF1bHQgcmVxdWVzdFxuICAgIC8vIGlkbGVUaW1lb3V0IGlzIDEwcyBhbmQgYSBzZXJ2ZXItc2VudCBoZWFydGJlYXQgZG9lcyBOT1QgcmVzZXQgaXQsIHNvIGFuXG4gICAgLy8gU1NFIGNsaWVudCBpcyBjbG9zZWQgYmVmb3JlIHRoZSAxNXMgYDogaGJgIGJlbG93IGV2ZXIgZmlyZXMg4oCUIHRoZVxuICAgIC8vIGtlZXBhbGl2ZSBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzIGtlZXBpbmcgYWxpdmUgaXNcbiAgICAvLyBnb25lLCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IHJhdGUgd291bGQgbm90IGhhdmUgaGVscGVkLlxuICAgIC8vIDI1NSBpcyBCdW4ncyBtYXhpbXVtICgwIGlzIG5vdCBcImRpc2FibGVkXCIpLCBtYXRjaGluZyBib3VudHksIGdyYXBldmluZVxuICAgIC8vIGFuZCBtaW5kLW1hcHBlcjsgYXN0cm9sYWJlIGVudi10dW5lcyBpdCBhbmQgY2xhbXBzIHRoZSBoZWFydGJlYXQgdG8gaGFsZi5cbiAgICAvLyBGb3VuZCAyMDI2LTA5LTA4IGJ5IHRoZSBiYWNrZW5kIGR1cGxpY2F0aW9uIHJlY29uOiBmb3VyIHNwZWxscyBoYWQgaGl0XG4gICAgLy8gdGhpcyBhbmQgZml4ZWQgaXQsIHRocmVlIGhhZCBub3QsIGJlY2F1c2UgdGhlIGRhZW1vbiBzcGluZSBpcyBvbmUgZGVzaWduXG4gICAgLy8gaW1wbGVtZW50ZWQgc2l4IHRpbWVzLlxuICAgIGlkbGVUaW1lb3V0OiBJRExFX1RJTUVPVVRfU0VDLFxuICAgIGRldmVsb3BtZW50OiB7IGhtcjogbW9kZSA9PT0gXCJkZXZcIiB9LFxuICAgIGZldGNoKHJlcSwgc3J2KSB7XG4gICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwpO1xuICAgICAgY29uc3QgcGF0aCA9IHVybC5wYXRobmFtZTtcbiAgICAgIGlmIChwYXRoID09PSBcIi93c1wiKVxuICAgICAgICByZXR1cm4gc3J2LnVwZ3JhZGUocmVxKSA/IHVuZGVmaW5lZCA6IG5ldyBSZXNwb25zZShcInVwZ3JhZGUgcmVxdWlyZWRcIiwgeyBzdGF0dXM6IDQyNiB9KTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL3N0YXRlXCIpIHtcbiAgICAgICAgdG91Y2goKTtcbiAgICAgICAgY29uc3QgbGVhbiA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwibGVhblwiKSA9PT0gXCIxXCI7XG4gICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHtcbiAgICAgICAgICBzdGF0ZTogbGVhbiA/IGxlYW5TdGF0ZShzdGF0ZSkgOiBzdGF0ZSxcbiAgICAgICAgICBjdXJzb3I6IGxvZy5jdXJzb3IoKSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9ldmVudHNcIikgcmV0dXJuIGV2ZW50c1Jlc3BvbnNlKHJlcSwgdXJsKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9jbWRcIilcbiAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAudGhlbigoYikgPT4ge1xuICAgICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICAgIC8vICM4NCDigJQgcHJvcGFnYXRlIHRoZSBoYW5kbGVyJ3MgdmVyZGljdCBpbnN0ZWFkIG9mIGEgbGl0ZXJhbFxuICAgICAgICAgICAgLy8ge29rOnRydWV9LiBgYXBwbGllZGAgaXMgdGhlIGZpZWxkIGJvdW50eSBhbHJlYWR5IHVzZXNcbiAgICAgICAgICAgIC8vIChzZXJ2ZXIudHMgQXBwbHlSZXN1bHQpOyBubyBuZXcgdm9jYWJ1bGFyeSBpcyBtaW50ZWQgaGVyZS5cbiAgICAgICAgICAgIGNvbnN0IHZlcmRpY3QgPSBoYW5kbGVBZ2VudE1zZyhiIGFzIEFnZW50Q29tbWFuZCk7XG4gICAgICAgICAgICAvLyBBIGNvbW1hbmQgdGhhdCBhbnN3ZXJlZCB3aXRoIGl0cyBvd24gcmVzdWx0IGNhcnJpZXMgaXRzIHBheWxvYWQ7XG4gICAgICAgICAgICAvLyB0aGUgYm9vbGVhbiBwYXRoIGJlbG93IGlzIHVuY2hhbmdlZC5cbiAgICAgICAgICAgIGlmICh0eXBlb2YgdmVyZGljdCA9PT0gXCJvYmplY3RcIilcbiAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgYXBwbGllZDogdHJ1ZSwgLi4udmVyZGljdC5kZXRhaWwgfSk7XG4gICAgICAgICAgICBjb25zdCBhcHBsaWVkID0gdmVyZGljdDtcbiAgICAgICAgICAgIGlmICghYXBwbGllZCkge1xuICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbihcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgICBhcHBsaWVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgIGVycm9yOiBgdW5yZWNvZ25pc2VkIGNvbW1hbmQgdHlwZSAke0pTT04uc3RyaW5naWZ5KFxuICAgICAgICAgICAgICAgICAgICAoYiBhcyB7IHR5cGU/OiB1bmtub3duIH0pPy50eXBlLFxuICAgICAgICAgICAgICAgICAgKX0g4oCUIG5vdGhpbmcgd2FzIGFwcGxpZWRgLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgeyBzdGF0dXM6IDQwMCB9LFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgYXBwbGllZDogdHJ1ZSB9KTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoKSA9PiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwiYmFkIGpzb25cIiB9LCB7IHN0YXR1czogNDAwIH0pKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGguc3RhcnRzV2l0aChcIi9hc3NldHMvXCIpKSB7XG4gICAgICAgIGNvbnN0IG5hbWUgPSBkZWNvZGVVUklDb21wb25lbnQocGF0aC5zbGljZShcIi9hc3NldHMvXCIubGVuZ3RoKSk7XG4gICAgICAgIGlmIChuYW1lLmluY2x1ZGVzKFwiLi5cIikgfHwgbmFtZS5zdGFydHNXaXRoKFwiL1wiKSlcbiAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IGVycm9yOiBcIm5vdCBmb3VuZFwiIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgICAgIGNvbnN0IGYgPSBCdW4uZmlsZShqb2luKHNlc3Npb25GaWxlc0RpciwgbmFtZSkpO1xuICAgICAgICByZXR1cm4gZlxuICAgICAgICAgIC5leGlzdHMoKVxuICAgICAgICAgIC50aGVuKChvaykgPT5cbiAgICAgICAgICAgIG9rID8gbmV3IFJlc3BvbnNlKGYpIDogUmVzcG9uc2UuanNvbih7IGVycm9yOiBcIm5vdCBmb3VuZFwiIH0sIHsgc3RhdHVzOiA0MDQgfSksXG4gICAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIC8vIHJlbGVhc2U6IFwiL1wiIGFuZCB0aGUgaGFzaGVkIGNodW5rLSouanMvY3NzIGFyZSBzdGF0aWMgZGlzdCByZWFkcy4gRGV2XG4gICAgICAvLyBuZXZlciByZWFjaGVzIGhlcmUgZm9yIFwiL1wiIOKAlCB0aGUgcm91dGVzIHRhYmxlIGFib3ZlIGFuc3dlcnMgaXQgZmlyc3QuXG4gICAgICAvLyBUaGlzIHNpdHMgQUZURVIgL2Fzc2V0cy8sIHdoaWNoIHNlcnZlcyBzZXNzaW9uIGZpbGVzLCBub3QgZGlzdCBvbmVzLlxuICAgICAgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgIGNvbnN0IGFzc2V0ID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICBpZiAoYXNzZXQpIHJldHVybiBhc3NldDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwibm90IGZvdW5kXCIgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICB9LFxuICAgIHdlYnNvY2tldDoge1xuICAgICAgb3Blbih3cykge1xuICAgICAgICBzb2NrZXRzLmFkZCh3cyk7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGVtaXRUcmFuc2llbnQoeyB0eXBlOiBcImNvbm5lY3RlZFwiIH0pO1xuICAgICAgICB3cy5zZW5kKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJzdGF0ZVwiLCBzdGF0ZSB9KSk7XG4gICAgICB9LFxuICAgICAgbWVzc2FnZShfd3MsIHJhdykge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGhhbmRsZUNsaWVudE1zZyhcbiAgICAgICAgICAgIEpTT04ucGFyc2UoXG4gICAgICAgICAgICAgIHR5cGVvZiByYXcgPT09IFwic3RyaW5nXCIgPyByYXcgOiBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUocmF3KSxcbiAgICAgICAgICAgICkgYXMgQ2xpZW50VG9TZXJ2ZXIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBnbGFtb3VyOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIGNsb3NlKHdzKSB7XG4gICAgICAgIHNvY2tldHMuZGVsZXRlKHdzKTtcbiAgICAgICAgZW1pdFRyYW5zaWVudCh7IHR5cGU6IFwiZGlzY29ubmVjdGVkXCIgfSk7XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGJvdW5kUG9ydCA9IHNlcnZlci5wb3J0O1xuICAvLyAtLS0gZGlzY292ZXJ5IGZpbGVzIChjbGkudHMgcmVhZHMgdGhlc2UpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc2Vzc2lvbkZpbGUgPSBqb2luKHRtcGRpcigpLCBgZ2xhbW91ci0ke3Nlc3Npb25JZH0uanNvbmApO1xuICBjb25zdCBsYXRlc3RGaWxlID0gam9pbih0bXBkaXIoKSwgYGdsYW1vdXItbGF0ZXN0Lmpzb25gKTtcbiAgY29uc3QgaW5mbyA9IEpTT04uc3RyaW5naWZ5KHtcbiAgICB1cmw6IGBodHRwOi8vJHtvcHRzLmhvc3QgPz8gXCIxMjcuMC4wLjFcIn06JHtib3VuZFBvcnR9YCxcbiAgICBwb3J0OiBib3VuZFBvcnQsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIHRpdGxlOiBzdGF0ZS50aXRsZSxcbiAgICBmaWxlc19kaXI6IHNlc3Npb25GaWxlc0RpcixcbiAgICBtb2RlLFxuICB9KTtcbiAgLy8g4pqgIEFUT01JQywgYmVjYXVzZSBjbGkudHMncyByZWFkU2Vzc2lvbiB0cmVhdHMgdW5wYXJzZWFibGUgY29udGVudCBhc1xuICAvLyBjb3JydXB0aW9uIHJhdGhlciB0aGFuIGFic2VuY2Ug4oCUIGFuZCB0aGlzIGltcGxlbWVudGF0aW9uIGlzIG5vd1xuICAvLyBga2l0L3dpcmUvZGlzY292ZXJ5LnRzYCwgc2hhcmVkIHdpdGggdGhlIHNpbmdsZXRvbiBjb252ZW50aW9uIEQzIGtlcHQgYWxpdmVcbiAgLy8gYmVzaWRlIHRoaXMgb25lLiBnbGFtb3VyIGlzIHdoZXJlIHRoZSBkZWZlY3QgKEwzKSB3YXMgZm91bmQgYW5kIGZpeGVkIG9uXG4gIC8vIDIwMjYtMDktMDc7IHdoYXQgc3RheWVkIGhlcmUgaXMgV0hJQ0ggZmlsZXMgZ2xhbW91ciB3cml0ZXMuXG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlQXRvbWljKHNlc3Npb25GaWxlLCBpbmZvKTtcbiAgICB3cml0ZUZpbGVBdG9taWMobGF0ZXN0RmlsZSwgaW5mbyk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGRpc2NvdmVyeSBpcyBiZXN0LWVmZm9ydCAqL1xuICB9XG5cbiAgLy8gQ29udHJhY3QgMTogdGhlIGRhZW1vbiBFTUlUUyBpdHMgcmVzb2x2ZWQgbW9kZSDigJQgYSBkZXYgZGFlbW9uIHdpdGggcm9vdCBkZXBzXG4gIC8vIHByZXNlbnQgcmVuZGVycyBhbiBpZGVudGljYWwtbG9va2luZyBib2FyZCwgc28gYG1vZGVgIGlzIHRoZSBvbmx5IHRoaW5nIHRoYXRcbiAgLy8gdGVsbHMgYSB2ZXJpZmllciB3aGljaCBwYXRoIHNlcnZlZCBpdC4gZ2xhbW91ciBoYXMgVEhSRUUgdHJhbnNwb3J0cyAoaW1hZ29cbiAgLy8gaGFzIHR3byk6IHRoaXMgZXZlbnQsIHRoZSBkaXNjb3ZlcnkgZmlsZSBhYm92ZSwgYW5kIHRoZSBzdGRvdXQgaGFuZHNoYWtlIGluXG4gIC8vIGltcG9ydC5tZXRhLm1haW4gYmVsb3cuIEFsbCB0aHJlZSBjYXJyeSBpdC5cbiAgZW1pdEV2ZW50KHsgdHlwZTogXCJyZWFkeVwiLCBtb2RlIH0pO1xuXG4gIC8vIC0tLSBzbmFwc2hvdCBkZWJvdW5jZSArIGlkbGUgc3dlZXAgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvL1xuICAvLyDim5QgVEhFIFNXRUVQIE5PVyBTRUVTIElUUyBTVUJTQ1JJQkVSUyDigJQgY2Vuc3VzIGRlZmVjdCBMMSwgY2xvc2VkIGJ5IHRoZSBzaGFyZWRcbiAgLy8gaG91c2VrZWVwZXIgUkVRVUlSSU5HIGEgYHN1YnNjcmliZXJDb3VudGAgcmF0aGVyIHRoYW4gYnkgYW55b25lIHJlbWVtYmVyaW5nLlxuICAvLyBUaGUgZXhwcmVzc2lvbiBoZXJlIHJlYWQgYChub3cgLSBsYXN0QWN0aXZpdHkpLzEwMDAgPj0gdGltZW91dGAgYW5kIG5vdGhpbmdcbiAgLy8gZWxzZSwgc28gYW4gYWdlbnQgaG9sZGluZyBhIGAvZXZlbnRzYCB0YWlsIG9uIGEgcXVpZXQgc2Vzc2lvbiB3YXMga2lsbGVkIFdJVEhcbiAgLy8gSVRTIENPTk5FQ1RJT04gT1BFTiBhdCB0aGUgMzAtbWludXRlIGZsb29yIOKAlCBnbGFtb3VyLCBpbWFnbyBhbmQgbWFncGllIGFsbFxuICAvLyBoYWQgaXQuIGB0aW1lb3V0YCBub3cgbWVhbnMgXCJsaW5nZXIgdGhpcyBsb25nIGFmdGVyIHRoZSBMQVNUIHN1YnNjcmliZXJcbiAgLy8gbGVhdmVzXCIsIG5vdCBcIm1heGltdW0gaWRsZSB3aGlsZSBjb25uZWN0ZWRcIi5cbiAgY29uc3Qgc2F2ZU5vdyA9ICgpID0+IHNhdmVTbmFwc2hvdChTTkFQU0hPVFNfRElSLCBzZXNzaW9uSWQsIHN0YXRlKTtcbiAgaWYgKHJlc3RvcmVkKSBzYXZlTm93KCk7XG4gIGNvbnN0IHRpbWVvdXRTID0gb3B0cy50aW1lb3V0UyA/PyAxODAwO1xuICBjb25zdCBzdG9wSG91c2VrZWVwaW5nID0gc3RhcnRIb3VzZWtlZXBpbmcoe1xuICAgIHN1YnNjcmliZXJDb3VudDogKCkgPT4gc29ja2V0cy5zaXplICsgc3NlQ2xpZW50cy5zaXplLFxuICAgIGlkbGVNczogKCkgPT4gcGVyZm9ybWFuY2Uubm93KCkgLSBsYXN0QWN0aXZpdHksXG4gICAgdG91Y2gsXG4gICAgdGltZW91dE1zOiB0aW1lb3V0UyAqIDEwMDAsXG4gICAgb25JZGxlQ2xvc2U6ICgpID0+IHJlc29sdmVEb25lKHsgY29kZTogMTI0LCByZWFzb246IFwidGltZW91dFwiIH0pLFxuICAgIHNuYXBzaG90OiB7XG4gICAgICBkaXJ0eTogKCkgPT4gc25hcERpcnR5LFxuICAgICAgY2xlYXI6ICgpID0+IHtcbiAgICAgICAgc25hcERpcnR5ID0gZmFsc2U7XG4gICAgICB9LFxuICAgICAgd3JpdGU6IHNhdmVOb3csXG4gICAgfSxcbiAgfSk7XG5cbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICAvLyBSZXNvbHZlcyBvbmNlIHRoZSBTU0UgZmx1c2ggKyBzZXJ2ZXIuc3RvcCBoYXZlIGJlZW4gc2NoZWR1bGVkOyBjYWxsZXJzXG4gIC8vIHRoYXQgbmVlZCB0byB3YWl0IChlLmcuIGltcG9ydC5tZXRhLm1haW4gYmVmb3JlIHByb2Nlc3MuZXhpdCkgY2FuIGF3YWl0IHRoaXMuXG4gIGxldCByZXNvbHZlU2h1dGRvd24hOiAoKSA9PiB2b2lkO1xuICBjb25zdCBzaHV0ZG93biA9IG5ldyBQcm9taXNlPHZvaWQ+KChyKSA9PiB7XG4gICAgcmVzb2x2ZVNodXRkb3duID0gcjtcbiAgfSk7XG5cbiAgLy8gVGhlIHNlc3Npb24gcG9pbnRlciBpcyB1bmNvbmRpdGlvbmFsbHkgb3VyczsgYGdsYW1vdXItbGF0ZXN0Lmpzb25gIGlzIE5PVCDigJRcbiAgLy8gYSBuZXdlciBzZXNzaW9uIG1heSBhbHJlYWR5IGhhdmUgY2xhaW1lZCBpdCwgYW5kIHVubGlua2luZyB0aGF0IHdvdWxkIG1ha2VcbiAgLy8gdGhlIGxpdmUgZGFlbW9uIGludmlzaWJsZSB0byB0aGUgbmV4dCB2ZXJiLiBgdW5saW5rSWZNYXRjaGVzYCdzIGBpZGVudGlmeWBcbiAgLy8gaG9vayBpcyB3aGF0IGxldHMgT05FIHNoYXJlZCBwcmVkaWNhdGUgc2VydmUgYm90aCB0aGlzIEpTT04gcG9pbnRlciBhbmRcbiAgLy8gYXN0cm9sYWJlJ3MgYmFyZSBwaWQgZmlsZSAoYGtpdC93aXJlL2Rpc2NvdmVyeS50c2ApLlxuICBjb25zdCBjbGVhbnVwRGlzY292ZXJ5ID0gKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICB1bmxpbmtTeW5jKHNlc3Npb25GaWxlKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGdvbmUg4oCUIGZpbmUgKi9cbiAgICB9XG4gICAgdW5saW5rSWZNYXRjaGVzKGxhdGVzdEZpbGUsIHNlc3Npb25JZCwgKHJhdykgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgaWQgPSAoSlNPTi5wYXJzZShyYXcpIGFzIHsgc2Vzc2lvbl9pZD86IHVua25vd24gfSkuc2Vzc2lvbl9pZDtcbiAgICAgICAgcmV0dXJuIHR5cGVvZiBpZCA9PT0gXCJzdHJpbmdcIiA/IGlkIDogbnVsbDtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICB9KTtcbiAgICB0cnkge1xuICAgICAgcm1TeW5jKHNlc3Npb25GaWxlc0RpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9O1xuXG4gIC8vIOKblCBTVEFZUyBTWU5DSFJPTk9VUyBBTkQgSURFTVBPVEVOVCwgYmVjYXVzZSBgZG9uZS50aGVuKCgpID0+IGNsb3NlKCkpYCBhbmRcbiAgLy8gdGhlIHN1aXRlcycgYGFmdGVyQWxsKCgpID0+IGQuY2xvc2UoKSlgIGJvdGggY2FsbCBpdCBhcyBhIHN0YXRlbWVudC4gVGhlXG4gIC8vIERSQUlOIGlzIHdoYXQgYmVjYW1lIGFzeW5jOiBgZHJhaW5BbmRTdG9wYCB3YWl0cyBpdHMgZ3JhY2UgcGVyaW9kLCBjbG9zZXNcbiAgLy8gZXZlcnkgcmVnaXN0ZXJlZCB0YWlsIHRocm91Z2ggdGhlIGZ1bm5lbCwgY2xvc2VzIHRoZSBzb2NrZXRzLCB0aGVuIFJBQ0VTXG4gIC8vIGBzZXJ2ZXIuc3RvcCh0cnVlKWAg4oCUIGJlY2F1c2UgdGhhdCBjYWxsIGF3YWl0cyBpdHMgY29ubmVjdGlvbnMgYW5kIG9uZSB3ZWRnZWRcbiAgLy8gcGVlciBpcyBlbm91Z2ggdG8gcGFyayB0ZWFyZG93biBmb3JldmVyIChhIDIzLW1pbnV0ZSBoYW5nIHNoaXBwZWQgb25jZSkuXG4gIC8vXG4gIC8vIOKaoCBUSEUgR1JBQ0UgUEVSSU9EIElTIDE1MCBtcywgTk9UIEdMQU1PVVInUyBPTEQgNTAsIGFuZCB0aGF0IGlzIGEgZGVsaWJlcmF0ZVxuICAvLyB3aXJlLW9ic2VydmFibGUgY2hhbmdlIHJhdGhlciB0aGFuIGFuIG92ZXJzaWdodDogMTUwIGlzIHRoZSBudW1iZXIgYWxsIGVpZ2h0XG4gIC8vIGRhZW1vbnMgY29udmVyZ2VkIG9uIGluZGVwZW5kZW50bHksIGFuZCBpdCBpcyB3aGF0IHR1cm5zIFwidGhlIGRhZW1vbiB0b2xkIHlvdVxuICAvLyB3aHkgaXQgZGllZFwiIGZyb20gYSBob3BlIGludG8gYW4gb2JzZXJ2YXRpb24uIGdsYW1vdXIncyBgY2xvc2VkYCBmcmFtZSBpcyB0aGVcbiAgLy8gb25lIHRoZSBDTEkncyB0YWlsIHdhdGNoZXMgZm9yLlxuICBjb25zdCBjbG9zZSA9ICgpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBzdG9wSG91c2VrZWVwaW5nKCk7XG4gICAgc2F2ZU5vdygpO1xuICAgIGNsZWFudXBEaXNjb3ZlcnkoKTtcbiAgICBlbWl0RXZlbnQoeyB0eXBlOiBcImNsb3NlZFwiIH0pO1xuICAgIHZvaWQgZHJhaW5BbmRTdG9wKHsgc2VydmVyLCBjbGllbnRzOiBzc2VDbGllbnRzLCBzb2NrZXRzIH0pLnRoZW4ocmVzb2x2ZVNodXRkb3duKTtcbiAgfTtcbiAgZG9uZS50aGVuKCgpID0+IGNsb3NlKCkpO1xuXG4gIHJldHVybiB7IHBvcnQ6IGJvdW5kUG9ydCwgc2Vzc2lvbklkLCBtb2RlLCBjbG9zZSwgZG9uZSwgc2h1dGRvd24gfTtcbn1cblxuLy8gIzgxIC8gRDQg4oCUIFRIRSBSRUNPR05JWkVEIFNFVCwgQVQgUEFSU0VSIEFMVElUVURFLiBUaGUgU0lYVEggZW50cnkgcG9pbnQuXG4vL1xuLy8g4pqgIFRISVMgT05FIEhBUyBaRVJPIGBmbGFncy5gIFJFQURTLCBzbyBhIGBmbGFncy5gLXBhdHRlcm4gYXVkaXQgcmV0dXJucyB6ZXJvXG4vLyBoZXJlIOKAlCBhbmQgYSB6ZXJvIHJlYWRzIGlkZW50aWNhbGx5IHRvIFwibm8gZHJpZnRcIi4gSXQgd2FzIGEgTE9PS1VQIHBhcnNlcjpcbi8vIGBjb25zdCBmbGFnID0gKG5hbWUpID0+IHsgY29uc3QgaSA9IGFyZ3MuaW5kZXhPZihgLS0ke25hbWV9YCk7IHJldHVybiBpID49IDBcbi8vID8gYXJnc1tpICsgMV0gOiB1bmRlZmluZWQ7IH1gLiBJdCBhbHNvIHJlYWQgYEJ1bi5hcmd2YCwgbm90IGBwcm9jZXNzLmFyZ3ZgLFxuLy8gd2hpY2ggaXMgdGhlIHN5bm9ueW0gdGhhdCBoYXMgbWFkZSB0aGlzIHJlcG8ncyBncmVwcyBsaWUgYmVmb3JlLlxuLy9cbi8vIEl0IGhhZCBhIExBVEVOVCwgUFJFLUVYSVNUSU5HIGJ1ZyB0aGUgY29udmVyc2lvbiBmaXhlcyBhcyBhIHNpZGUgZWZmZWN0LCBub3RlZFxuLy8gc28gdGhlIGNoYW5nZSBpcyBub3QgbWlzdGFrZW4gZm9yIGEgcmVncmVzc2lvbjogYGZsYWcoKWAgcmV0dXJuZWQgYGFyZ3NbaSsxXWBcbi8vIFVOQ09ORElUSU9OQUxMWSwgc28gYC0tcmVzdG9yZSAtLXRpdGxlIFhgIHlpZWxkZWQgYHJlc3RvcmUgPT09IFwiLS10aXRsZVwiYCDigJRcbi8vIHRoZSBuZXh0IEZMQUcgc2lsZW50bHkgY29uc3VtZWQgYXMgdGhlIHByZXZpb3VzIGZsYWcncyBWQUxVRS5cbi8vXG4vLyBBbGwgc2l4IGFyZSBzdHJpbmcgYnkgY29uc3RydWN0aW9uICh0aGUgb2xkIGhlbHBlciByZXR1cm5lZCB0aGUgbmV4dCBhcmd2XG4vLyBlbGVtZW50KS4gYHBvcnRgIGFuZCBgdGltZW91dGAgYXJlIE51bWJlcigpLWNvZXJjZWQgYXQgdGhlIGNhbGwgc2l0ZSwgd2hpY2ggaXNcbi8vIGEgdmFsdWUgcmVhZCwgbm90IGEgYm9vbGVhbiBvbmUuIFRoZSBkYWVtb24gdGFrZXMgbm8gcG9zaXRpb25hbHMsIHNvIHN0cmljdCdzXG4vLyBkZWZhdWx0IHJlamVjdGlvbiBvZiB0aGVtIGlzIGNvcnJlY3QuXG4vL1xuLy8gVmVyaWZpZWQgYmVmb3JlIGNvbnZlcnRpbmc6IGBjbGkudHNgIHNwYXducyB0aGlzIGRhZW1vbiB3aXRoIGV4YWN0bHkgLS10aXRsZSxcbi8vIC0taW50ZW50LCAtLXRpbWVvdXQsIC0tcmVzdG9yZSBhbmQgLS1wcm9qZWN0LCBhbGwgaW5zaWRlIHRoaXMgc2V0IOKAlCBzbyBzdHJpY3Rcbi8vIGNhbm5vdCByZWZ1c2UgdGhlIGRhZW1vbidzIG93biBsYXVuY2guXG5jb25zdCBEQUVNT05fT1BUSU9OUyA9IHtcbiAgaW50ZW50OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcG9ydDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHByb2plY3Q6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByZXN0b3JlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGltZW91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpdGxlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbn0gYXMgY29uc3Q7XG5cbi8qKiBQYXJzZSB0aGUgZGFlbW9uJ3MgYXJndiwgYm9vdCwgcHJpbnQgdGhlIGhhbmRzaGFrZSwgYW5kIHdhaXQgZm9yIHRoZSBlbmQuXG4gKiAgUmV0dXJucyB0aGUgcHJvY2VzcyBleGl0IGNvZGU7IGl0IGRvZXMgTk9UIGV4aXQg4oCUIHRoZSBsYXVuY2hlciBkb2VzLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD47XG4gIHRyeSB7XG4gICAgZmxhZ3MgPSBub2RlUGFyc2VBcmdzKHsgYXJnczogYXJndiwgb3B0aW9uczogREFFTU9OX09QVElPTlMsIHN0cmljdDogdHJ1ZSB9KS52YWx1ZXMgYXMgUmVjb3JkPFxuICAgICAgc3RyaW5nLFxuICAgICAgc3RyaW5nIHwgdW5kZWZpbmVkXG4gICAgPjtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYGdsYW1vdXI6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmAgK1xuICAgICAgICBgICByZWNvZ25pemVkIGZsYWdzOiAke09iamVjdC5rZXlzKERBRU1PTl9PUFRJT05TKVxuICAgICAgICAgIC5tYXAoKGspID0+IGAtLSR7a31gKVxuICAgICAgICAgIC5qb2luKFwiIFwiKX1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3QgZCA9IGF3YWl0IHN0YXJ0RGFlbW9uKHtcbiAgICBwb3J0OiBmbGFncy5wb3J0ID8gTnVtYmVyKGZsYWdzLnBvcnQpIDogMCxcbiAgICB0aXRsZTogZmxhZ3MudGl0bGUsXG4gICAgaW50ZW50OiBmbGFncy5pbnRlbnQsXG4gICAgcmVzdG9yZTogZmxhZ3MucmVzdG9yZSxcbiAgICB0aW1lb3V0UzogZmxhZ3MudGltZW91dCA/IE51bWJlcihmbGFncy50aW1lb3V0KSA6IHVuZGVmaW5lZCxcbiAgICBwcm9qZWN0OiBmbGFncy5wcm9qZWN0LFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7ZC5wb3J0fWAsIHBvcnQ6IGQucG9ydCwgc2Vzc2lvbl9pZDogZC5zZXNzaW9uSWQsIG1vZGU6IGQubW9kZSB9KX1cXG5gLFxuICApO1xuICBjb25zdCByZXMgPSBhd2FpdCBkLmRvbmU7XG4gIC8vIFdhaXQgZm9yIHRoZSBjbG9zZWQgU1NFIGV2ZW50IHRvIGZsdXNoIGJlZm9yZSBleGl0aW5nLlxuICBhd2FpdCBkLnNodXRkb3duO1xuICByZXR1cm4gcmVzLmNvZGU7XG59XG5cbi8qKlxuICogVGhlIGRhZW1vbidzIGVudHJ5LCBmb3IgdGhlIExBVU5DSEVSIGF0XG4gKiBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dsYW1vdXIvc2NyaXB0cy9zZXJ2ZXIudHNgLlxuICpcbiAqIOKblCBgaW1wb3J0Lm1ldGEubWFpbmAgSVMgRkFMU0UgSU4gVEhFIEJVTkRMRS4gYGRpc3Qvc2VydmVyLmpzYCBpcyBJTVBPUlRFRCBieVxuICogdGhlIGxhdW5jaGVyLCBuZXZlciBleGVjdXRlZCBhcyB0aGUgcHJvY2VzcyBlbnRyeSwgc28gdGhlIG9sZFxuICogYGlmIChpbXBvcnQubWV0YS5tYWluKWAgYmxvY2sgd291bGQgc2ltcGx5IG5ldmVyIHJ1biDigJQgdGhlIGRhZW1vbiB3b3VsZCBib290LFxuICogc2VydmUgbm90aGluZyBhbmQgZXhpdCAwLCBhbmQgZXZlcnkgdGVzdCB3b3VsZCBmYWlsIGFzIFwidGhlIGRhZW1vbiBuZXZlciBib3VuZFxuICogYSBwb3J0XCIsIHdoaWNoIHJlYWRzIGxpa2UgZmxha2UuIFRoYXQgaXMgdGhlIGZhaWx1cmUgdGhpcyBleHBvcnQgZXhpc3RzIHRvXG4gKiBwcmV2ZW50LCBhbmQgaXQgaXMgdGhlIGZpcnN0IHRoaW5nIHRoYXQgYnJlYWtzIG9uIGV2ZXJ5IGJhY2tlbmQgcmVsb2NhdGlvbi5cbiAqXG4gKiDim5QgQU5EIFRIRVJFIElTIE5PIGBpbXBvcnQubWV0YS5tYWluYCBCTE9DSyBMRUZULCBkZWxpYmVyYXRlbHkgKEQxMikuIFJ1biBmcm9tXG4gKiBgc3JjL2dsYW1vdXIvYmFja2VuZC9gLCBgU0tJTExfUk9PVGAgY29tcHV0ZXMgdG8gYHNyYy9nbGFtb3VyL2AsIHdoaWNoIGhvbGRzIG5vXG4gKiBgZGlzdC9pbmRleC5odG1sYCDigJQgc28gdGhlIGRhZW1vbiB3b3VsZCBzaWxlbnRseSBjaG9vc2UgREVWIG1vZGUgYW5kIHRoZW4gZmFpbFxuICogdGhlIGRldiBpbXBvcnQgZnJvbSB0aGUgd3JvbmcgYW5jaG9yLiBPZmZlcmluZyB0aGF0IGVudHJ5IHdvdWxkIGJlIG9mZmVyaW5nIGFcbiAqIHdyb25nIGRhZW1vbi5cbiAqXG4gKiDim5QgQU5EIElUIFRBS0VTIE5PIEFSR1VNRU5UUywgZm9yIHRoZSBzYW1lIHJlYXNvbiBgY2xpLnRzYCdzIGBydW4oKWAgZG9lcyBub3Q6XG4gKiB0aGUgY29tbWFuZCBsaW5lIGJlbG9uZ3MgdG8gdGhlIGZpbGUgdGhhdCBQQVJTRVMgaXQuIEEgbGF1bmNoZXIgdGhhdCB0b3VjaGVkXG4gKiBgcHJvY2Vzcy5hcmd2YCB3b3VsZCBtYXRjaCBgZ3JpbW9pcmUvbGliL2VudHJ5LXBvaW50cy50c2AncyBhcmctcGFyc2luZ1xuICogcHJlZGljYXRlIGFuZCB0aGUgd2FyZHMgd291bGQganVkZ2UgdGhpcyBkYWVtb24ncyBmbGFncyBhZ2FpbnN0IGEgZmlsZSB0aGF0XG4gKiByZWNvZ25pc2VzIG5vbmUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cbiIsCiAgICAiLy8gVGhlIHNpbmdsZSBzaGFyZWQgY29udHJhY3Qg4oCUIGltcG9ydGVkIGJ5IHNlcnZlci50cywgY2xpLnRzLCBhbmQgdGhlIHN1cmZhY2UuXG5cbmV4cG9ydCB0eXBlIEl0ZW1LaW5kID0gXCJyZWZcIiB8IFwiY29udGV4dFwiIHwgXCJnZW5cIiB8IFwic3R5bGVcIjtcbmV4cG9ydCBjb25zdCBWQUxJRF9LSU5EOiByZWFkb25seSBJdGVtS2luZFtdID0gW1wicmVmXCIsIFwiY29udGV4dFwiLCBcImdlblwiLCBcInN0eWxlXCJdIGFzIGNvbnN0O1xuXG4vLyBHZW5lcmF0aW9uIG1ldGFkYXRhIChHMSkuIEZ1bGx5IHBvcHVsYXRlZCBmb3Iga2luZCA9PT0gXCJnZW5cIiBpbiBTbGljZSAzO1xuLy8gdGhlIGZpZWxkIGV4aXN0cyBub3cgc28gdGhlIGNvbnRyYWN0IGFuZCB0aGUgZGV0YWlscyBmbHktb3V0IGFyZSBzdGFibGUuXG5leHBvcnQgdHlwZSBHZW5NZXRhID0ge1xuICBtb2RlbDogc3RyaW5nO1xuICBwcm9tcHQ6IHN0cmluZztcbiAgc2VlZDogbnVtYmVyIHwgbnVsbDtcbiAgY29zdDogbnVtYmVyIHwgbnVsbDtcbiAgY3VzdG9tOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICByb3VuZDogbnVtYmVyOyAvLyBiYXRjaCBpbmRleCB0aGUgYWdlbnQgc3RhbXBzOyBVSSBncm91cHMgZ2VuIGl0ZW1zIGJ5IGl0XG59O1xuXG4vLyBPbmUgY2F0YWxvZyBlbnRyeS4gU2hhcGUgZm9sbG93cyBpbWFnbydzIENvbnRleHRFbnRyeSBjb252ZW50aW9uczpcbi8vIGJsb2JzIChgc3JjYCwgYHRleHRgKSBhcmUgc3RyaXBwZWQgaW4gdGhlIGxlYW4gYWdlbnQgcHJvamVjdGlvbjsgdGhlIGFnZW50XG4vLyByZWFkcyBgcGF0aGAuIEFyY2hpdmFsIGlzIG5vbi1kZXN0cnVjdGl2ZSAodGhlIGBhcmNoaXZlZGAgZmxhZzsgdGhlIGl0ZW1cbi8vIHN1cnZpdmVzIGluIHRoZSBsaWJyYXJ5KS5cbmV4cG9ydCB0eXBlIExpYnJhcnlJdGVtID0ge1xuICBpZDogc3RyaW5nO1xuICBraW5kOiBJdGVtS2luZDtcbiAgdGl0bGU6IHN0cmluZztcbiAgc3JjOiBzdHJpbmc7IC8vIGltYWdlIGRhdGEtVVJMIChyZWYvZ2VuKTsgXCJcIiBvdGhlcndpc2Ug4oCUIHN0cmlwcGVkIGluIGxlYW5cbiAgcGF0aDogc3RyaW5nOyAvLyBvbi1kaXNrIG1hdGVyaWFsaXplZCBibG9iIHRoZSBhZ2VudCBjYW4gUmVhZDsgXCJcIiBpZiBub25lXG4gIHRleHQ6IHN0cmluZzsgLy8gY29udGV4dCBib2R5OyBcIlwiIG90aGVyd2lzZSDigJQgc3RyaXBwZWQgaW4gbGVhblxuICBtaW1lOiBzdHJpbmc7IC8vIGUuZy4gXCJpbWFnZS93ZWJwXCIsIFwidGV4dC9tYXJrZG93blwiXG4gIHRhZ3M6IHN0cmluZ1tdO1xuICBzdGFycmVkOiBib29sZWFuO1xuICBsaWtlZDogYm9vbGVhbjtcbiAgYW5ub3RhdGlvbnM6IHsgYWdlbnQ6IHN0cmluZzsgaHVtYW46IHN0cmluZyB9O1xuICBjYW5vbmljYWw6IGJvb2xlYW47IC8vIG1hcmtlZCBjYW5vbmljYWwgZm9yIHRoZSBzdHlsZSBiZWluZyBidWlsdCAobXVsdGksIG5vdCBzaW5nbGUtc2VsZWN0KVxuICBjYW5vbjogQ2Fub25JbWdbXTsgLy8gYSBraW5kOlwic3R5bGVcIiBpdGVtJ3MgY2Fub25pY2FsIHRodW1ibmFpbHM7IFtdIG90aGVyd2lzZSDigJQgc3RyaXBwZWQgaW4gbGVhblxuICBhcmNoaXZlZDogYm9vbGVhbjtcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIGdlbjogR2VuTWV0YSB8IG51bGw7XG59O1xuXG4vLyBDb252ZXJzYXRpb24uIEFnZW50IG1lc3NhZ2Uga2luZHMgY2FycnkgVjEncyBuYXJyYXRpb24gc2VtYW50aWNzXG4vLyAoaW5mbyB8IHdvcmtpbmcgfCByZXN1bHQgfCBlcnJvcik7IHVzZXIgbWVzc2FnZXMgYXJlIGFsd2F5cyBcImluZm9cIi5cbmV4cG9ydCB0eXBlIE1lc3NhZ2VLaW5kID0gXCJpbmZvXCIgfCBcIndvcmtpbmdcIiB8IFwicmVzdWx0XCIgfCBcImVycm9yXCI7XG5leHBvcnQgdHlwZSBNZXNzYWdlID0ge1xuICBpZDogc3RyaW5nO1xuICB3aG86IFwidXNlclwiIHwgXCJhZ2VudFwiO1xuICBraW5kOiBNZXNzYWdlS2luZDtcbiAgdGV4dDogc3RyaW5nO1xuICBncm91bmQ6IHN0cmluZ1tdOyAvLyBpdGVtIGlkcyBncm91bmRpbmcgdGhpcyBtZXNzYWdlIChzbmFwc2hvdCBvZiBzZWxlY3RlZElkcyk7IFtdIGlmIG5vbmVcbiAgdHM6IG51bWJlcjtcbn07XG5cbi8vIEEgYnJvdWdodC1pbiBzdHlsZSdzIGNhbm9uaWNhbCB0aHVtYm5haWwgKGRhdGEtVVJMIGBzcmNgIOKAlCBzdHJpcHBlZCBpbiBsZWFuKS5cbmV4cG9ydCB0eXBlIENhbm9uSW1nID0geyB0aXRsZTogc3RyaW5nOyBzcmM6IHN0cmluZyB9O1xuXG4vLyBBIGNhbm9uaWNhbCBpbWFnZSBpbnNpZGUgYSBTYXZlZFN0eWxlOiB0aGUgYmxvYiBpcyBjb3BpZWQgaW50byB0aGUgc3R5bGUnc1xuLy8gZGlyIG9uIHNhdmUgYW5kIHJlZmVyZW5jZWQgYnkgYGZpbGVgIChzbyB0aGUgc2F2ZWQgc3R5bGUgaXMgc2VsZi1jb250YWluZWQpLlxuZXhwb3J0IHR5cGUgQ2Fub25pY2FsUmVmID0ge1xuICBpZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBmaWxlOiBzdHJpbmc7XG4gIG1pbWU6IHN0cmluZztcbn07XG5cbi8vIEEgc3R5bGUgc2F2ZWQgdG8gdGhlIHByb2plY3QgdHJheSDigJQgYSBjb21wb3VuZCBcImNhbm9uaWNhbCBzaGFwZVwiOiB0aGUgY29kaWZpZWRcbi8vIHN0eWxlLWd1aWRlIHNlY3Rpb25zICh0ZXh0KSArIGNhbm9uaWNhbCBpbWFnZXMuIFByb2plY3Qtc2NvcGVkLCBub24tZGVzdHJ1Y3RpdmUuXG5leHBvcnQgdHlwZSBTYXZlZFN0eWxlID0ge1xuICBpZDogc3RyaW5nO1xuICBsYWJlbDogc3RyaW5nO1xuICB0ZXh0OiBzdHJpbmc7IC8vIHNob3J0IGh1bWFuIGRlc2NyaXB0aW9uIChlLmcuIHRoZSBVbmRlcnN0YW5kaW5nL0RpcmVjdGlvbiBnaXN0KVxuICBzZWN0aW9uczogU3R5bGVTZWN0aW9uW107IC8vIHRoZSBjb2RpZmllZCBzdHlsZSBndWlkZSBhdCBzYXZlIHRpbWVcbiAgY2Fub25pY2FsOiBDYW5vbmljYWxSZWZbXTtcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIGFyY2hpdmVkOiBib29sZWFuO1xufTtcblxuLy8gVGhlIGFnZW50LWFzc2VtYmxlZCBzdHlsZSBndWlkZS4gU2VjdGlvbiBzZXQgKyBsYWJlbHMgYXJlIHRoZSBtb2NrdXAnc1xuLy8gKHRoZSBjb252ZXJnZWQgc3VyZmFjZSkuIFNlY3Rpb25zIGZpbGwgaW46IGVtcHR5IOKGkiBmb3JtaW5nIOKGkiBhZ3JlZWQuXG5leHBvcnQgdHlwZSBTZWN0aW9uU3RhdHVzID0gXCJlbXB0eVwiIHwgXCJmb3JtaW5nXCIgfCBcImFncmVlZFwiO1xuZXhwb3J0IHR5cGUgU2VjdGlvbktleSA9XG4gIHwgXCJ1bmRlcnN0YW5kaW5nXCJcbiAgfCBcImRpcmVjdGlvblwiXG4gIHwgXCJwYWxldHRlXCJcbiAgfCBcImNvbnNpc3RlbmN5XCJcbiAgfCBcInByb21wdHNcIlxuICB8IFwiY2Fub25pY2FsXCI7XG4vLyBBIHBhbGV0dGUgc3dhdGNoIOKAlCBzdHJ1Y3R1cmVkIGNvbG9yIGZvciB0aGUgXCJwYWxldHRlXCIgc2VjdGlvbi5cbmV4cG9ydCB0eXBlIFN3YXRjaCA9IHsgaGV4OiBzdHJpbmc7IG5hbWU/OiBzdHJpbmcgfTtcbmV4cG9ydCB0eXBlIFN0eWxlU2VjdGlvbiA9IHtcbiAga2V5OiBTZWN0aW9uS2V5O1xuICBsYWJlbDogc3RyaW5nO1xuICBzdGF0dXM6IFNlY3Rpb25TdGF0dXM7XG4gIGNvbnRlbnQ6IHN0cmluZzsgLy8gcHJvc2VcbiAgcHJvbXB0czogc3RyaW5nW107IC8vIHBvcHVsYXRlZCBmb3IgdGhlIFwicHJvbXB0c1wiIHNlY3Rpb247IFtdIGVsc2V3aGVyZVxuICBjb2xvcnM6IFN3YXRjaFtdOyAvLyBwb3B1bGF0ZWQgZm9yIHRoZSBcInBhbGV0dGVcIiBzZWN0aW9uOyBbXSBlbHNld2hlcmVcbn07XG5cbi8vIFRoZSB6b29tL2ZvY3VzIGNvLXByZXNlbmNlIGxlbnMuIEVpdGhlciBwYXJ0eSBjYW4gc2NvcGUgdGhlIHNldC5cbmV4cG9ydCB0eXBlIEZvY3VzU2NvcGUgPSBcImFsbFwiIHwgXCJmb2N1c1wiO1xuZXhwb3J0IHR5cGUgRm9jdXNPd25lciA9IFwieW91XCIgfCBcImFnZW50XCIgfCBudWxsO1xuXG5leHBvcnQgdHlwZSBHbGFtb3VyU3RhdGUgPSB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGludGVudDogc3RyaW5nO1xuICBsaWJyYXJ5OiBMaWJyYXJ5SXRlbVtdO1xuICBzZWxlY3RlZElkczogc3RyaW5nW107IC8vIGxpbmtlZCBzZXQg4oCUIHRoZSBncm91bmRpbmcgc2V0ICh1bnNlbGVjdCDiiaAgZGVsZXRlKVxuICBtZXNzYWdlczogTWVzc2FnZVtdO1xuICBzdHlsZUd1aWRlOiBTdHlsZVNlY3Rpb25bXTtcbiAgdHJheTogU2F2ZWRTdHlsZVtdO1xuICBzY29wZTogRm9jdXNTY29wZTtcbiAgZm9jdXNTZXQ6IHN0cmluZ1tdOyAvLyBpdGVtIGlkcyBpbiB0aGUgZm9jdXNlZCBzZXQ7IGVtcHR5IHdoZW4gc2NvcGUgPT09IFwiYWxsXCJcbiAgZm9jdXNPd25lcjogRm9jdXNPd25lcjsgLy8gd2hvIHNjb3BlZCB0aGUgZm9jdXNcbiAgZm9jdXNOb3RlOiBzdHJpbmc7IC8vIGFnZW50J3MgY29udGV4dHVhbCBxdWVzdGlvbiBmb3IgdGhlIGZvY3VzIGRyYXdlcjsgXCJcIiBvdGhlcndpc2VcbiAgc3RhdHVzOiB7IGJ1c3k6IGJvb2xlYW47IHRleHQ6IHN0cmluZyB9O1xufTtcblxuLy8gTGVhbiBwcm9qZWN0aW9uIHNlbnQgdG8gdGhlIGFnZW50OiBibG9icyBzdHJpcHBlZCwgcGF0aHMga2VwdC5cbmV4cG9ydCB0eXBlIExlYW5JdGVtID0gT21pdDxMaWJyYXJ5SXRlbSwgXCJzcmNcIiB8IFwidGV4dFwiIHwgXCJjYW5vblwiPjtcbmV4cG9ydCB0eXBlIExlYW5TdGF0ZSA9IE9taXQ8R2xhbW91clN0YXRlLCBcImxpYnJhcnlcIj4gJiB7XG4gIGxpYnJhcnk6IExlYW5JdGVtW107XG59O1xuXG4vLyBTZXJ2ZXIg4oaSIGJyb3dzZXIgKFdlYlNvY2tldCkuIEZ1bGwtc3RhdGUgYnJvYWRjYXN0IGlzIHRoZSBvbmx5IGZyYW1lLlxuZXhwb3J0IHR5cGUgU2VydmVyVG9DbGllbnQgPSB7IHR5cGU6IFwic3RhdGVcIjsgc3RhdGU6IEdsYW1vdXJTdGF0ZSB9O1xuXG4vLyBCcm93c2VyIOKGkiBzZXJ2ZXIgKFdlYlNvY2tldCkuXG5leHBvcnQgdHlwZSBDbGllbnRUb1NlcnZlciA9XG4gIHwge1xuICAgICAgdHlwZTogXCJpdGVtLmFkZFwiO1xuICAgICAgaXRlbToge1xuICAgICAgICBraW5kOiBcInJlZlwiIHwgXCJjb250ZXh0XCI7XG4gICAgICAgIHRpdGxlOiBzdHJpbmc7XG4gICAgICAgIHNyYz86IHN0cmluZztcbiAgICAgICAgdGV4dD86IHN0cmluZztcbiAgICAgICAgbWltZT86IHN0cmluZztcbiAgICAgIH07XG4gICAgfVxuICB8IHsgdHlwZTogXCJpdGVtLnNlbGVjdFwiOyBpZHM6IHN0cmluZ1tdIH0gLy8gYW1iaWVudFxuICB8IHsgdHlwZTogXCJpdGVtLnN0YXJcIjsgaWQ6IHN0cmluZzsgc3RhcnJlZDogYm9vbGVhbiB9IC8vIGFtYmllbnRcbiAgfCB7IHR5cGU6IFwiaXRlbS5saWtlXCI7IGlkOiBzdHJpbmc7IGxpa2VkOiBib29sZWFuIH0gLy8gYW1iaWVudFxuICB8IHsgdHlwZTogXCJpdGVtLmFubm90YXRlXCI7IGlkOiBzdHJpbmc7IGh1bWFuOiBzdHJpbmcgfSAvLyBhbWJpZW50IOKAlCBzdG9yZWQgKyByZWFkIG9uIGRlbWFuZCwgbm90IHB1c2hlZCBhcyBhbiBldmVudFxuICB8IHsgdHlwZTogXCJtZXNzYWdlLnNlbmRcIjsgdGV4dDogc3RyaW5nIH0gLy8gaW1wZXJhdGl2ZVxuICB8IHsgdHlwZTogXCJmb2N1cy5zZXRcIjsgaWRzOiBzdHJpbmdbXSB9IC8vIGFtYmllbnQg4oCUIGh1bWFuIHNjb3BlcyBhIGZvY3VzIHNldFxuICB8IHsgdHlwZTogXCJmb2N1cy5jbGVhclwiIH0gLy8gYW1iaWVudCDigJQgaHVtYW4gem9vbXMgYmFjayBvdXRcbiAgfCB7IHR5cGU6IFwiaXRlbS5jYW5vbmljYWxcIjsgaWQ6IHN0cmluZzsgY2Fub25pY2FsOiBib29sZWFuIH0gLy8gYW1iaWVudFxuICB8IHsgdHlwZTogXCJpdGVtLmFyY2hpdmVcIjsgaWQ6IHN0cmluZzsgYXJjaGl2ZWQ6IGJvb2xlYW4gfSAvLyBhbWJpZW50XG4gIHwgeyB0eXBlOiBcInN0eWxlLmJyaW5nSW5cIjsgaWQ6IHN0cmluZyB9OyAvLyBpbXBlcmF0aXZlIOKAlCBhZGRzIGEga2luZDpcInN0eWxlXCIgaXRlbVxuXG4vLyBBZ2VudCDihpIgc2VydmVyIChIVFRQIFBPU1QgL2NtZCkuXG5leHBvcnQgdHlwZSBBZ2VudENvbW1hbmQgPVxuICB8IHsgdHlwZTogXCJpbml0XCI7IHRpdGxlPzogc3RyaW5nOyBpbnRlbnQ/OiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJpbnRlbnRcIjsgdGV4dDogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwiaXRlbS5hbm5vdGF0ZVwiOyBpZDogc3RyaW5nOyBhZ2VudDogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwic2F5XCI7IHRleHQ6IHN0cmluZzsga2luZD86IE1lc3NhZ2VLaW5kIH1cbiAgfCB7XG4gICAgICB0eXBlOiBcInNlY3Rpb25cIjtcbiAgICAgIGtleTogU2VjdGlvbktleTtcbiAgICAgIGNvbnRlbnQ/OiBzdHJpbmc7XG4gICAgICBzdGF0dXM/OiBTZWN0aW9uU3RhdHVzO1xuICAgICAgcHJvbXB0cz86IHN0cmluZ1tdO1xuICAgICAgY29sb3JzPzogU3dhdGNoW107XG4gICAgfVxuICB8IHtcbiAgICAgIHR5cGU6IFwiZ2VuLmFkZFwiO1xuICAgICAgc3JjOiBzdHJpbmc7IC8vIGFuIEFMUkVBRFktb3B0aW1pemVkIHdlYnAgZGF0YS1VUkwgKENMSSBkb2VzIHRoZSBvcHRpbWl6YXRpb24pXG4gICAgICBwcm9tcHQ6IHN0cmluZztcbiAgICAgIG1vZGVsOiBzdHJpbmc7XG4gICAgICByb3VuZDogbnVtYmVyO1xuICAgICAgc2VlZD86IG51bWJlcjtcbiAgICAgIGNvc3Q/OiBudW1iZXI7XG4gICAgICBsYWJlbD86IHN0cmluZztcbiAgICAgIGN1c3RvbT86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gICAgfVxuICB8IHsgdHlwZTogXCJnZW4uY29zdFwiOyBpZDogc3RyaW5nOyBjb3N0OiBudW1iZXIgfSAvLyBiYWNrZmlsbCBjb3N0IG9uY2UgbWVkaWEtZm9yZ2UgZmluYWxpemVzIGl0XG4gIHwgeyB0eXBlOiBcImdlbi5tZXRhXCI7IGlkOiBzdHJpbmc7IHByb21wdD86IHN0cmluZzsgY3VzdG9tPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB9IC8vIGJhY2tmaWxsIHRoZSByZWFsIHByb21wdCAvIHJlZnMgb250byBhIGdlblxuICB8IHsgdHlwZTogXCJmb2N1cy5wdXNoXCI7IGlkczogc3RyaW5nW107IG5vdGU/OiBzdHJpbmcgfSAvLyBhZ2VudCBzY29wZXMgYSBmb2N1cyBzZXQgKyBhc2tzXG4gIHwgeyB0eXBlOiBcInN0eWxlLnNhdmVcIjsgbGFiZWw6IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcInN0eWxlLmFyY2hpdmVcIjsgaWQ6IHN0cmluZzsgYXJjaGl2ZWQ6IGJvb2xlYW4gfVxuICB8IHsgdHlwZTogXCJzdGF0dXNcIjsgYnVzeTogYm9vbGVhbjsgdGV4dD86IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcImNsb3NlXCIgfTtcblxuLy8gVGhlIGNvbXBsZXRlIGFnZW50LWV2ZW50IHNldCAoc2VydmVyIOKGkiBhZ2VudCBTU0UpLiBPbmx5IHRoZXNlIGFyZSBlbWl0dGVkLlxuLy8gSW1wZXJhdGl2ZXMgb25seSDigJQgYm9hcmQgbW92ZXMgKHNlbGVjdC9zdGFyL2xpa2UpIGFyZSBhbWJpZW50LlxuZXhwb3J0IGNvbnN0IEFHRU5UX0VWRU5UX1RZUEVTID0gT2JqZWN0LmZyZWV6ZShbXG4gIFwicmVhZHlcIixcbiAgXCJjb25uZWN0ZWRcIixcbiAgXCJkaXNjb25uZWN0ZWRcIixcbiAgXCJpdGVtLmFkZFwiLFxuICBcIm1lc3NhZ2UudXNlclwiLFxuICBcImNsb3NlZFwiLFxuXSBhcyBjb25zdCk7XG5leHBvcnQgdHlwZSBBZ2VudEV2ZW50VHlwZSA9ICh0eXBlb2YgQUdFTlRfRVZFTlRfVFlQRVMpW251bWJlcl07XG5cbmV4cG9ydCBmdW5jdGlvbiBkZWZhdWx0U3R5bGVHdWlkZSgpOiBTdHlsZVNlY3Rpb25bXSB7XG4gIHJldHVybiBbXG4gICAge1xuICAgICAga2V5OiBcInVuZGVyc3RhbmRpbmdcIixcbiAgICAgIGxhYmVsOiBcIlVuZGVyc3RhbmRpbmdcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJkaXJlY3Rpb25cIixcbiAgICAgIGxhYmVsOiBcIkRpcmVjdGlvblwiLFxuICAgICAgc3RhdHVzOiBcImVtcHR5XCIsXG4gICAgICBjb250ZW50OiBcIlwiLFxuICAgICAgcHJvbXB0czogW10sXG4gICAgICBjb2xvcnM6IFtdLFxuICAgIH0sXG4gICAge1xuICAgICAga2V5OiBcInBhbGV0dGVcIixcbiAgICAgIGxhYmVsOiBcIlBhbGV0dGVcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJjb25zaXN0ZW5jeVwiLFxuICAgICAgbGFiZWw6IFwiQ29uc2lzdGVuY3lcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJwcm9tcHRzXCIsXG4gICAgICBsYWJlbDogXCJSZS1jYXN0IHByb21wdHNcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJjYW5vbmljYWxcIixcbiAgICAgIGxhYmVsOiBcIkNhbm9uaWNhbCBpbWFnZXNcIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICBdO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGVmYXVsdFN0YXRlKHRpdGxlOiBzdHJpbmcsIGludGVudDogc3RyaW5nKTogR2xhbW91clN0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICB0aXRsZSxcbiAgICBpbnRlbnQsXG4gICAgbGlicmFyeTogW10sXG4gICAgc2VsZWN0ZWRJZHM6IFtdLFxuICAgIG1lc3NhZ2VzOiBbXSxcbiAgICBzdHlsZUd1aWRlOiBkZWZhdWx0U3R5bGVHdWlkZSgpLFxuICAgIHRyYXk6IFtdLFxuICAgIHNjb3BlOiBcImFsbFwiLFxuICAgIGZvY3VzU2V0OiBbXSxcbiAgICBmb2N1c093bmVyOiBudWxsLFxuICAgIGZvY3VzTm90ZTogXCJcIixcbiAgICBzdGF0dXM6IHsgYnVzeTogZmFsc2UsIHRleHQ6IFwiXCIgfSxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgdHdvIHByaW1pdGl2ZXMgdW5kZXIgQk9USCBvZiB0aGUgaG91c2UncyBkYWVtb24tZGlzY292ZXJ5IGNvbnZlbnRpb25zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogRDMgcnVsZWQgdGhhdCB0aGUgY29udmVudGlvbnMgdGhlbXNlbHZlcyDigJQgcGVyLXNlc3Npb24gdG1wZGlyIEpTT04gKGJvdW50eSxcbiAqIGdsYW1vdXIsIGltYWdvLCBtYWdwaWUpIGFuZCBzaW5nbGV0b24gYCRIT01FL2RhZW1vbi5wb3J0YCArIGBkYWVtb24ucGlkYFxuICogKGFzdHJvbGFiZSwgZ3JhcGV2aW5lLCBtaW5kLW1hcHBlcikg4oCUIGJvdGggc3Vydml2ZSwgYmVjYXVzZSB0aGV5IGVuY29kZVxuICogZ2VudWluZWx5IGRpZmZlcmVudCBtb2RlbHMgKGNvbmN1cnJlbnQgc2Vzc2lvbnMgdnMgYSBzdGFuZGluZyBzaW5nbGV0b24pIGFuZFxuICogcGlja2luZyBvbmUgaXMgYSBwcm9kdWN0IGRlY2lzaW9uLCBub3QgYSBmYWN0b3Jpbmcgb25lLiBXaGF0IElTIG9uZVxuICogaW1wbGVtZW50YXRpb24gaXMgdGhlIHBhaXIgYmVsb3csIHdoaWNoIGlzIGFsc28gZXhhY3RseSB3aGVyZSBjZW5zdXMgZGVmZWN0XG4gKiAqKkwzKiogbGl2ZXMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCByZW5hbWVTeW5jLCBybVN5bmMsIHVubGlua1N5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuXG4vKipcbiAqIFdyaXRlIGB0ZXh0YCB0byBgdGFyZ2V0YCBhdG9taWNhbGx5OiB3cml0ZSBiZXNpZGUgaXQsIHRoZW4gcmVuYW1lLlxuICpcbiAqIOKblCAqKkwzLCBDTE9TRUQgQlkgQ09OU1RSVUNUSU9OLioqIEEgYmFyZSBgd3JpdGVGaWxlU3luY2AgaXMgbm90IGF0b21pYywgc28gYVxuICogQ0xJIHJlYWRpbmcgd2hpbGUgdGhlIGRhZW1vbiB3cml0ZXMgY2FuIG9ic2VydmUgYSBIQUxGLVdSSVRURU4gcG9pbnRlci4gVW5kZXJcbiAqIGEgYmVzdC1lZmZvcnQgcmVhZGVyIHRoYXQgc3VyZmFjZWQgYXMgXCJubyBydW5uaW5nIHNlc3Npb25cIiDigJQgYWJzZW5jZSByZXBvcnRlZFxuICogZm9yIHdoYXQgd2FzIHJlYWxseSBhIHRvcm4gcmVhZCwgd2hpY2ggaXMgdGhlIGV4YWN0IGNvbmZsYXRpb24gdGhlIGhvdXNlJ3NcbiAqIGBudWxsYC1ub3QtYDBgIHJ1bGUgZXhpc3RzIHRvIHByZXZlbnQuIFJlbmFtZSB3aXRoaW4gb25lIGRpcmVjdG9yeSBpcyBhdG9taWMsXG4gKiBzbyBhIHJlYWRlciBzZWVzIGVpdGhlciB0aGUgcHJldmlvdXMgcG9pbnRlciBvciB0aGUgbmV3IG9uZSwgbmV2ZXIgYSBwYXJ0aWFsXG4gKiBmaWxlLlxuICpcbiAqIEZpeGVkIGluIGdsYW1vdXIgMjAyNi0wOS0wNywgZm91bmQgc3RhbmRpbmcgaW4gdGhyZWUgc2libGluZ3MgdGhlIG5leHQgZGF5IGJ5XG4gKiB0aGUgZHVwbGljYXRpb24gcmVjb24sIGFuZCByZXBhaXJlZCBpbiBhbGwgb2YgdGhlbSB0aGUgb25seSB3YXkgdGhhdCBkb2VzIG5vdFxuICogbmVlZCBmaW5kaW5nIGFnYWluOiB0aGVyZSBpcyBub3cgb25lIGltcGxlbWVudGF0aW9uLlxuICpcbiAqIOKaoCBUaGUgdGVtcCBuYW1lIGNhcnJpZXMgdGhlIHBpZCwgc28gdHdvIGRhZW1vbnMgcmFjaW5nIHRvIHB1Ymxpc2ggdGhlIHNhbWVcbiAqIHBvaW50ZXIgY2Fubm90IGNsb2JiZXIgZWFjaCBvdGhlcidzIGludGVybWVkaWF0ZSBmaWxlIOKAlCBhbmQgaXQgaXMgcmVtb3ZlZCBvblxuICogYSBmYWlsZWQgd3JpdGUgcmF0aGVyIHRoYW4gbGVmdCBhcyBsaXR0ZXIgYmVzaWRlIHRoZSByZWFsIG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlRmlsZUF0b21pYyh0YXJnZXQ6IHN0cmluZywgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHRtcCA9IGAke3RhcmdldH0uJHtwcm9jZXNzLnBpZH0udG1wYDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKHRtcCwgdGV4dCk7XG4gICAgcmVuYW1lU3luYyh0bXAsIHRhcmdldCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRyeSB7XG4gICAgICBybVN5bmModG1wLCB7IGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogdGhlIHRlbXAgZmlsZSBpcyBhbHJlYWR5IGdvbmUsIG9yIHdhcyBuZXZlciBjcmVhdGVkICovXG4gICAgfVxuICAgIHRocm93IGVycjtcbiAgfVxufVxuXG4vKipcbiAqIERlbGV0ZSBgcGF0aGAgaWZmIGl0IHN0aWxsIG5hbWVzIFVTLiBSZXR1cm5zIHdoZXRoZXIgaXQgd2FzIGRlbGV0ZWQuXG4gKlxuICog4puUICoqXCJTVElMTCBPVVJTXCIgSVMgVEhFIFdIT0xFIEZVTkNUSU9OLioqIEEgZGFlbW9uIHRoYXQgdW5saW5rcyBpdHMgZGlzY292ZXJ5XG4gKiBmaWxlIHVuY29uZGl0aW9uYWxseSBhdCBleGl0IGRlbGV0ZXMgdGhlIHBvaW50ZXIgYSBTVUNDRVNTT1IgaGFzIGFscmVhZHlcbiAqIHdyaXR0ZW4g4oCUIHRoZSBzdWNjZXNzb3IgY2FuIHRoZW4gbm8gbG9uZ2VyIGJlIGZvdW5kIGFuZCB0aGUgbmV4dCBDTEkgdmVyYiBzcGF3bnMgYVxuICogdGhpcmQgZGFlbW9uLiBCb3RoIGNvbnZlbnRpb25zIGhhdmUgdGhpcyBoYXphcmQgYW5kIGJvdGggZXhwcmVzcyBpdFxuICogZGlmZmVyZW50bHk6IGFzdHJvbGFiZSBjb21wYXJlcyB0aGUgcGlkIGZpbGUncyBieXRlcyB0byBpdHMgb3duIHBpZCxcbiAqIG1hZ3BpZSBwYXJzZXMgdGhlIEpTT04gcG9pbnRlciBhbmQgY29tcGFyZXMgYHNlc3Npb25faWRgLiBgaWRlbnRpZnlgIGlzIHdoYXRcbiAqIG1ha2VzIHRob3NlIG9uZSBmdW5jdGlvbiDigJQgaXQgdHVybnMgdGhlIGZpbGUncyBieXRlcyBpbnRvIHRoZSBpZGVudGl0eSB0b1xuICogY29tcGFyZSwgYW5kIGl0IGRlZmF1bHRzIHRvIHRoZSB0cmltbWVkIGJ5dGVzIHRoZW1zZWx2ZXMuXG4gKlxuICog4pqgIEV2ZXJ5IGZhaWx1cmUgaXMgc3dhbGxvd2VkIGFuZCByZXBvcnRlZCBhcyBgZmFsc2VgOiB0aGUgZmlsZSBiZWluZyBnb25lLFxuICogdW5yZWFkYWJsZSwgb3IgdW5wYXJzZWFibGUgYWxsIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZSDigJQgaXQgaXMgbm90IG91cnMgdG9cbiAqIHJlbW92ZS4gQW4gdW5wYXJzZWFibGUgcG9pbnRlciBpcyBkZWxpYmVyYXRlbHkgTk9UIHRyZWF0ZWQgYXMgb3Vycywgd2hpY2ggaXNcbiAqIHRoZSBjb25zZXJ2YXRpdmUgaGFsZiBvZiB0aGUgc2FtZSBgbnVsbGAtbm90LWAwYCBydWxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdW5saW5rSWZNYXRjaGVzKFxuICBwYXRoOiBzdHJpbmcsXG4gIGV4cGVjdGVkOiBzdHJpbmcsXG4gIGlkZW50aWZ5OiAocmF3OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGwgPSAocmF3KSA9PiByYXcudHJpbSgpLFxuKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGlkZW50aWZ5KHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpICE9PSBleHBlY3RlZCkgcmV0dXJuIGZhbHNlO1xuICAgIHVubGlua1N5bmMocGF0aCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBpbi1wcm9jZXNzIGV2ZW50IGxvZyDigJQgdGhlIGFwcGVuZC1vbmx5LCByZXBsYXlhYmxlIGJ1ZmZlclxuICogYmVoaW5kIGV2ZXJ5IHNwZWxsJ3MgYEdFVCAvZXZlbnRzYCBTU0UgdGFpbC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzXG4gKiBgc2NyaXB0cy9ldmVudHMudHNgIOKAlCB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMyLCBhbmQgdGhlIG9ubHkgb25lIG9mXG4gKiB0aGUgc2l4IGNvcGllZC1pbi1wbGFjZSBidXNlcyB0aGF0IGlzIGEgbW9kdWxlLCBpcyBib3VuZGVkLCBjYXJyaWVzIGFuIGVwb2NoLCBhbmQgaXNcbiAqIHVuaXQtdGVzdGVkLiBUaGUgZml2ZSBvdGhlcnMgYXJlIHRoZSBzYW1lIHR3ZW50eSBsaW5lcyB3cml0dGVuIGZpdmUgdGltZXMuXG4gKlxuICog4pSA4pSAIFRIRSBUSFJFRSBUSElOR1MgVEhJUyBGSVhFUyDigJQgVFdPIEJZIENPTlNUUlVDVElPTiwgT05FIEJZIE9QVC1JTiDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiDim5QgVEhFIEhFQURJTkcgVVNFRCBUTyBTQVkgXCJUSEUgVEhSRUUgVEhJTkdTIFRISVMgRklYRVMgQlkgQ09OU1RSVUNUSU9OXCIgQU5EXG4gKiBJVEVNIDIgSVMgTk9UIE9ORSBPRiBUSEVNLiBDb3JyZWN0ZWQgMjAyNi0wOS0wOSBpbiBtaW5kLW1hcHBlcidzIHByZS13b3JrXG4gKiAoRDc5KTogYGVwb2NoYCBpcyBPUFRJT05BTCBoZXJlLCBzbyBMNiBpcyBjbG9zZWQgb25seSBmb3IgYSBjYWxsZXIgdGhhdCBhc2tzLlxuICogVGhyZWUgYWRvcHRlcnMgaGF2ZSBzaW5jZSBkZWNsaW5lZCB0byDigJQgaW1hZ28gKEQzOSksIGJvdW50eSAoRDQ4KSBhbmRcbiAqIGdyYXBldmluZSAoRDcwKSDigJQgc28gdGhlIGRlZmVjdCB0aGUgaGVhZGluZyBjbGFpbWVkIHRvIG1ha2UgaW1wb3NzaWJsZSBpc1xuICogbGl2ZSBpbiB0aGUgdHJlZSwgYnkgb3B0LW91dCwgYW5kIHRoZSBvdmVyY2xhaW0gaXMgd2hhdCBoaWQgdGhhdC4gSXRlbXMgMSBhbmRcbiAqIDMgQVJFIGJ5IGNvbnN0cnVjdGlvbjogYSBjYWxsZXIgY2Fubm90IHN3aXRjaCB0aGUgY2FwIG9mZiBvciByZWFjaCB0aGUgYnVmZmVyLlxuICpcbiAqIOKaoCBBTkQgTUlORC1NQVBQRVInUyBPV04gQlVTLCBXSElDSCBUSElTIE1PRFVMRSBDT05WRVJHRUQgVE9XQVJELCBUWVBFUyBUSEVcbiAqIEVQT0NIIEFTIFJFUVVJUkVEIGFuZCBzdGFtcHMgaXQgdW5jb25kaXRpb25hbGx5IOKAlCBpdCBpcyB0aGUgc3BlbGwgY2Vuc3VzIEw2XG4gKiBuYW1lcyBhcyBDT1JSRUNULiBNYWtpbmcgaXQgcmVxdWlyZWQgSEVSRSBpcyBub3QgdGhlIHJlcGFpcjogaXQgd291bGQgcmV2ZXJzZVxuICogRDM5LCBENDggYW5kIEQ3MC4gVGhlIGhvbmVzdCBzdGF0ZW1lbnQgaXMgdGhpcyBoZWFkaW5nLlxuICpcbiAqIOKblCAqKlJFU09MVkVEIEFUIFRIQVQgU1BFTEwnUyBQT1JULCBBTkQgVEhFIERJU1BPU0lUSU9OIElTIFJFQ09SREVEIEhFUkVcbiAqIEJFQ0FVU0UgQSBMT1NTIFRIQVQgTElWRVMgT05MWSBJTiBBIEpPVVJOQUwgSVMgQSBMT1NTIE5PQk9EWSBDQU4gU0VFXG4gKiAoRDc5L0Q4NSkuKiogbWluZC1tYXBwZXIgYWRvcHRlZCB0aGlzIG1vZHVsZSBpbiBQaGFzZSA3IGFuZCBrZXB0IGl0c1xuICogZ3VhcmFudGVlIFdJVEhPVVQgQSBLSVQgQ0hBTkdFOiBpdCBwYXNzZXMgYHsgZXBvY2g6IGNyeXB0by5yYW5kb21VVUlEKCkgfWAgYXRcbiAqIGl0cyBPTkUgY29uc3RydWN0aW9uIHNpdGUgYW5kIHJlLXRpZ2h0ZW5zIGBlcG9jaGAgdG8gUkVRVUlSRUQgaW4gaXRzIG93blxuICogbG9jYWwgZnJhbWUgdHlwZSwgc28gbm90aGluZyBpdHMgYnVzIGVtaXRzIGNhbiBsYWNrIG9uZS4gS2l0IGJ5dGVzOiB6ZXJvLlxuICogKipTbyB0aGUgZXBvY2ggaXMgYSBMT1NTWS1DT1BZIHByb3BlcnR5IHdob3NlIGRpc3Bvc2l0aW9uIGlzIEtFRVAtTE9DQUwsIG5vdFxuICogUkVTVE9SRSoqIOKAlCB0aGUgb25seSBwcm9wZXJ0eSBvZiB0aGF0IHNwZWxsJ3Mgb3duIG1vZHVsZSB0aGlzIG1vZHVsZSBjb3VsZFxuICogbm90IGNhcnJ5IGFuZCBkaWQgbm90IG5lZWQgdG8uIEw2IGlzIENMT1NFRCBmb3IgdGhlIHR3byBzcGVsbHMgdGhhdCBhc2sgYW5kXG4gKiBPUEVOLCBieSBvcHQtb3V0LCBmb3IgdGhlIHRocmVlIHRoYXQgZGVjbGluZTsgdGhhdCBhc3ltbWV0cnkgaXMgdGhlIGhvbmVzdFxuICogc3RhdGUgYW5kIHRoaXMgaGVhZGluZyBpcyB3aGVyZSBpdCBpcyB3cml0dGVuLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgQURPUFRJT04gUkVOQU1FUyBBIEZJRUxEIE9OIEFOIEFET1BURVInUyBQVUJMSVNIRUQgV0lSRS4qKiBgaWRgXG4gKiBpcyBuYW1lZCBpbiBgRnJhbWU8VD5gIGFuZCBpbiB0aGUgZW1pdCBsaXRlcmFsIGJlbG93LCBzbyBhIHNwZWxsIHdob3NlIGJ1c1xuICogc3BlbGxlZCB0aGUgY3Vyc29yIGFueXRoaW5nIGVsc2UgcGF5cyBhIHJlbmFtZSBhdCBldmVyeSByZWFkZXIg4oCUIGZvclxuICogbWluZC1tYXBwZXIsIDE3MyBvY2N1cnJlbmNlcyBhY3Jvc3MgNSBzdXJmYWNlIGZpbGVzLCB+MjA5IGFjcm9zcyB+MzAgYmFja2VuZFxuICogZmlsZXMsIGV2ZXJ5IEpTT05MIGxpbmUgaXRzIGB0YWlsYCB3cml0ZXMgaW50byBhbiBhZ2VudCdzIHBpcGUsIGFuZCAodGhlIG9uZVxuICogbm9ib2R5IGNvdW50ZWQpIHRoZSBGSVhUVVJFIGluIGl0cyBvd24gYHRhaWwudGVzdC50c2AsIHdoaWNoIFdSSVRFUyB0aGVcbiAqIGVudmVsb3BlIHdoaWxlIHN0YW5kaW5nIGluIGZvciB0aGUgZGFlbW9uLiBUaGUgTkVTVElORyBpcyBub3QgZm9yY2VkIOKAlFxuICogYEZyYW1lPFQ+YCBpcyBnZW5lcmljLCBhbmQgbWluZC1tYXBwZXIga2VwdCBge2tpbmQsIHBheWxvYWR9YCBuZXN0ZWQgd2hlcmUgYWxsXG4gKiBmaXZlIGVhcmxpZXIgYWRvcHRlcnMgZmxhdHRlbiBieSBpZGlvbS4gKipBbiBpZGlvbSBmaXZlIHNpYmxpbmdzIHNoYXJlIGlzXG4gKiBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgY29udHJhY3QgdW50aWwgeW91IG9wZW4gdGhlIHR5cGUqKiAoRDgxLCBEODYpLlxuICpcbiAqICoqMSDCtyBMNSDigJQgdGhlIGJ1ZmZlciBpcyBib3VuZGVkLioqIEZpdmUgZGFlbW9ucyBhcHBlbmQgdG8gYW4gYXJyYXkgZm9yIHRoZVxuICogd2hvbGUgbGlmZSBvZiB0aGUgcHJvY2Vzcy4gVGhlIHdpbmRvdyBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogZGFlbW9uJ3MgbGlmZXRpbWUsIG5vdCBhIGR1cmFibGUgbG9nOyBhIGNhcCBpcyB0aGUgaG9uZXN0IHNoYXBlLlxuICpcbiAqICoqMiDCtyBMNiDigJQgYSBmcmFtZSBjYXJyaWVzIGFuIGVwb2NoLCBXSEVOIFRIRSBDQUxMRVIgQVNLUyBGT1IgT05FIChvcHQtaW4sXG4gKiBub3QgY29uc3RydWN0aW9uIOKAlCBzZWUgYWJvdmUpLioqIEFmdGVyIGEgcmVzdGFydCB0aGUgaWRzIHN0YXJ0IGFnYWluIGF0IDEsIHNvXG4gKiBhIHJlc3VtaW5nIGNsaWVudCBjYW5ub3QgdGVsbCBhIHN0YWxlIHdhdGVybWFyayBmcm9tIGEgZnJlc2ggb25lIGJ5IGlkIGFsb25lLlxuICpcbiAqICoqMyDCtyBBIFNUQUxFIFdBVEVSTUFSSyBSRVBMQVlTIEZST00gVEhFIEJFR0lOTklORywgYW5kIHRoaXMgaXMgdGhlIGhhbGYgdGhlXG4gKiBjbGllbnQgY2Fubm90IGRvLioqIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogYSB0YWlsIHRoYXQgcmVzdW1lcyBhdFxuICogYHNpbmNlPTxsYXN0IGlkIG9mIHRoZSBwcmV2aW91cyBkYWVtb24+YCBhZ2FpbnN0IGEgcmVzdGFydGVkIGRhZW1vbiByZWNlaXZlc1xuICogTk9USElORyDigJQgdGhlIG5ldyBkYWVtb24ncyBgcmVhZHlgIGlzIGlkIDEsIHdoaWNoIGlzIG5vdCBgPiBzaW5jZWAsIHNvIHRoZVxuICogZmlsdGVyIGRyb3BzIGl0LCBzbyBubyBmcmFtZSBhcnJpdmVzLCBzbyB0aGUgY2xpZW50J3MgZXBvY2ggY2hlY2sgbmV2ZXIgcnVuc1xuICogYW5kIHRoZSB0YWlsIHNpdHMgY29ubmVjdGVkIGFuZCBzaWxlbnQgdW50aWwgdGhlIG5ldyBkYWVtb24gaGFzIGVtaXR0ZWQgYXNcbiAqIG1hbnkgZXZlbnRzIGFzIHRoZSBvbGQgb25lIGRpZC4gU3RhbXBpbmcgYW4gZXBvY2ggYWxvbmUgZG9lcyBOT1QgY2xvc2UgdGhhdFxuICogZ2FwOiB0aGUgZXBvY2ggcmlkZXMgYSBmcmFtZSwgYW5kIHRoZSBidWcgaXMgdGhhdCBubyBmcmFtZSBpcyBzZW50LiBTb1xuICogYHN1YnNjcmliZWAgdHJlYXRzIGBzaW5jZSA+IGN1cnNvcmAgYXMgXCJ0aGlzIGN1cnNvciBpcyBmcm9tIGFub3RoZXIgcHJvY2Vzc1wiXG4gKiBhbmQgcmVwbGF5cyB3aG9sZS4gYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3RhaWwudGVzdC50c2AncyBlcG9jaCBjZWxsIGlzIHRoZVxuICogZXhlY3V0YWJsZSBzcGVjIG9mIHRoZSBjbGllbnQgaGFsZiBhbmQgc2hvd3MgdGhlIHJlY29ubmVjdCBzdGlsbCBjYXJyeWluZyB0aGVcbiAqIHN0YWxlIGN1cnNvciDigJQgZGV0ZWN0aW9uIGhhcHBlbnMgb24gd2hhdCBpcyBSRUNFSVZFRC5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBET0VTIE5PVCBBRE9QVCBUSElTLCBBTkQgVEhFIFJFRlVTQUwgSVMgUEFSVCBPRiBUSEUgUlVMSU5HIOKUgOKUgFxuICpcbiAqIFJFSkVDVC1TVFJVQ1RVUkFMLCBydWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLiBOb3RcbiAqIFwibm8gc3ViamVjdFwiIOKAlCBncmFwZXZpbmUgSEFTIGFuIGV2ZW50IGJ1cyBhbmQgaXQgaXMgdGhlIGJ1c2llc3QgdGhpbmcgaW4gdGhlXG4gKiBzcGVsbCDigJQgYnV0IHRoZSB0d28gc2hhcGVzIGNhbm5vdCBiZSBjb25zdHJ1Y3RlZCBmcm9tIGVhY2ggb3RoZXI6XG4gKlxuICogICB0aGlzIG1vZHVsZSAgb25lIHByb2Nlc3Mtd2lkZSBhcnJheSBjYXBwZWQgYXQgUkVQTEFZX0JVRkZFUl9TSVpFLCB3aXRoIG9uZVxuICogICAgICAgICAgICAgICAgbW9ub3RvbmljIGBzZXFgLCBhbmQgdGhlIGhlYWRlciB0aHJlZSBwYXJhZ3JhcGhzIHVwIHNheXMgaW4gYXNcbiAqICAgICAgICAgICAgICAgIG1hbnkgd29yZHMgdGhhdCBpdCBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogICAgICAgICAgICAgICAgZGFlbW9uJ3MgbGlmZXRpbWUsIE5PVCBhIGR1cmFibGUgbG9nLlxuICogICBncmFwZXZpbmUgICAgTiBkdXJhYmxlIGFwcGVuZC1vbmx5IGAuanNvbmxgIGZpbGVzLCBvbmUgcGVyIG5hbWVkIGNoYW5uZWwsXG4gKiAgICAgICAgICAgICAgICBlYWNoIHdpdGggaXRzIG93biBgbmV4dF9pZGAsIHJlcGxheWVkIGZyb20gZGlzayBieVxuICogICAgICAgICAgICAgICAgYHJlYWRCYWNrbG9nYCwgc3Vydml2aW5nIHJlc3RhcnQsIGByb2xsYCwgYXJjaGl2ZSBhbmQgY2xlYXIuXG4gKlxuICogKipUaGUgcmVhZGVyIHRoYXQgbWFrZXMgdGhlbSBpbmNvbXBhdGlibGUsIGFzIGEgbWVhc3VyZW1lbnQgcmF0aGVyIHRoYW4gYW5cbiAqIGFzc2VydGlvbjoqKiBncmFwZXZpbmUncyBgbG9hZENoYW5uZWwoKWAgZGVyaXZlcyBgbmV4dF9pZGAgYXMgYSBISUdILVdBVEVSXG4gKiBNQVJLIG92ZXIgZXZlcnkgcGFyc2VhYmxlIGxpbmUgb2YgdGhlIGNoYW5uZWwncyBmaWxlIG9uIGJvb3QuIFRoZXJlIGlzIG5vXG4gKiBhcnJheSB0byBiZSB0aGF0IG1hcmsgb2YsIGFuZCBubyBjYXAgdGhhdCB3b3VsZCBub3Qgc2lsZW50bHkgZGlzY2FyZCBoaXN0b3J5XG4gKiBhIGNhbGxlciBjYW4gc3RpbGwgYXNrIGZvciBieSBpZC4gSXQgaXMgdGhlIHRoaW5nIHRoaXMgbW9kdWxlJ3Mgb3duIGhlYWRlclxuICogc2F5cyBpdCBpcyBkZWxpYmVyYXRlbHkgbm90LlxuICpcbiAqICoqVGhlIHdpZGVuaW5nIE5PVCBkb25lLCB3aXRoIGl0cyBjb3N0OioqIGFkbWl0dGluZyBhIHBlci1jaGFubmVsIGR1cmFibGVcbiAqIHN0b3JlIHdvdWxkIGNoYW5nZSBgY3JlYXRlRXZlbnRMb2dgJ3Mgc3RvcmFnZSBhbmQgaXRzIGBzdWJzY3JpYmVgIGNvbnRyYWN0IGZvclxuICogZml2ZSBvdGhlciBkYWVtb25zLCByZS1lbWl0dGluZyBTSVggYXJ0aWZhY3RzIGFjcm9zcyBGSVZFIHNwZWxscywgZWFjaCBvd2VkIGFcbiAqIGRyaXZlIOKAlCBwYWlkIGJ5IHBvcnRzIHRoYXQgYXJlIGFscmVhZHkgZmluaXNoZWQgYW5kIGJ5IGFnZW50cyBub3QgaW4gdGhlIHJvb20uXG4gKiBBIHdpZGVuaW5nIHJlbWFpbnMgYXZhaWxhYmxlIGFzIGl0cyBvd24gYXJndWVkIGRlY2lzaW9uIHdpdGggaXRzIG93blxuICogYmxhc3QtcmFkaXVzIGNvdW50OyBpdCBpcyBuZXZlciBhIHN0ZXAgaW5zaWRlIGEgcG9ydC5cbiAqXG4gKiDimqAgQU5EIFRIRSBgZXBvY2hgIEFCT1ZFIElTIFRIRSBTSEFSUEVTVCBIQUxGIE9GIFdIWSAoRDcwKS4gR3JhcGV2aW5lJ3MgaWRzIGFyZVxuICogUkVDT1ZFUkVEIGFjcm9zcyBhIHJlc3RhcnQsIHNvIHRoZSBjb25kaXRpb24gcGFyYWdyYXBoIDIgZGVzY3JpYmVzIOKAlCBpZHNcbiAqIHN0YXJ0aW5nIGFnYWluIGF0IDEg4oCUIGNhbm5vdCBvY2N1ciB0aGVyZSwgYW5kIHN0YW1waW5nIG9uZSBhbnl3YXkgaXMgbm90XG4gKiBpbmVydDogYHRhaWxFdmVudHNgJ3MgYG9uRXBvY2hDaGFuZ2VgIHNldHMgdGhlIGN1cnNvciB0byAwLCBhbmQgZ3JhcGV2aW5lJ3NcbiAqIHRhaWwgcm91dGUgYW5zd2VycyBgc2luY2U9MGAgd2l0aCB0aGUgV0hPTEUgY2hhbm5lbCBsb2cgb2ZmIGRpc2ssIGludG8gYW5cbiAqIGFnZW50J3MgcGlwZSwgb24gZXZlcnkgYHJvbGxgLiBUaGUgZXBvY2gncyBjbGllbnQtc2lkZSBhY3Rpb24gaXMgXCJ5b3VyIGN1cnNvclxuICogaXMgd29ydGhsZXNzLCBzdGFydCBvdmVyXCIsIGFuZCB0aGF0IGlzIHNhZmUgb25seSB3aGVyZSBzdGFydGluZyBvdmVyIGNvc3RzIGFcbiAqIGJvdW5kZWQgaW4tbWVtb3J5IHJlcGxheSB3aW5kb3cuXG4gKi9cblxuLyoqIFRoZSBkZWZhdWx0IHJlcGxheSB3aW5kb3csIGluaGVyaXRlZCBmcm9tIG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgY2FwLiAqL1xuZXhwb3J0IGNvbnN0IFJFUExBWV9CVUZGRVJfU0laRSA9IDEwMDA7XG5cbi8qKiBBIGZyYW1lIGFzIGl0IGdvZXMgb24gdGhlIHdpcmU6IHRoZSBjYWxsZXIncyBwYXlsb2FkIHBsdXMgYSBtb25vdG9uaWMgYGlkYCxcbiAqICBwbHVzIGFuIGBlcG9jaGAgd2hlbiB0aGUgbG9nIHdhcyBnaXZlbiBvbmUuICovXG5leHBvcnQgdHlwZSBGcmFtZTxUPiA9IFQgJiB7IGlkOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH07XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRMb2c8VD4ge1xuICAvKiogQXBwZW5kIG9uZSBmcmFtZSwgZmFuIGl0IG91dCB0byBsaXZlIHN1YnNjcmliZXJzLCBhbmQgcmV0dXJuIGl0LiAqL1xuICBlbWl0KG1zZzogVCk6IEZyYW1lPFQ+O1xuICAvKipcbiAgICogUmVwbGF5IGV2ZXJ5dGhpbmcgYWZ0ZXIgYHNpbmNlYCwgdGhlbiBzdGF5IHN1YnNjcmliZWQuIFJldHVybnMgYW5cbiAgICogdW5zdWJzY3JpYmUgZnVuY3Rpb24uXG4gICAqXG4gICAqIOKblCBSRVBMQVkgQU5EIFNVQlNDUklCRSBBUkUgT05FIENBTEwgT04gUFVSUE9TRS4gRG9pbmcgdGhlbSBpbiB0d28gc3RlcHNcbiAgICogbGVhdmVzIGEgd2luZG93IGluIHdoaWNoIGFuIGVtaXQgbGFuZHMgYmV0d2VlbiB0aGUgcmVwbGF5IGxvb3AgYW5kIHRoZVxuICAgKiBgYWRkYCwgYW5kIHRoYXQgZnJhbWUgaXMgZGVsaXZlcmVkIHRvIG5vYm9keSDigJQgdGhlIHNoYXBlIGZpdmUgZGFlbW9ucyBoYXZlLFxuICAgKiBzdXJ2aXZlZCBieSBub3RoaW5nIGJ1dCB0aGUgc2luZ2xlLXRocmVhZGVkIGV2ZW50IGxvb3AgaGFwcGVuaW5nIHRvIGNsb3NlXG4gICAqIGl0LiBEZXBlbmRpbmcgb24gdGhhdCBpcyBkZXBlbmRpbmcgb24gYW4gaW1wbGVtZW50YXRpb24gZGV0YWlsIG9mIHRoZVxuICAgKiBydW50aW1lIHJhdGhlciB0aGFuIG9uIHRoZSBjb2RlLlxuICAgKi9cbiAgc3Vic2NyaWJlKHNpbmNlOiBudW1iZXIsIGxpc3RlbmVyOiAoZnJhbWU6IEZyYW1lPFQ+KSA9PiB2b2lkKTogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBoaWdoZXN0IGlkIGVtaXR0ZWQgc28gZmFyIOKAlCB3aGF0IGBHRVQgL3N0YXRlYCByZXR1cm5zIGFzIGBjdXJzb3JgLiAqL1xuICBjdXJzb3IoKTogbnVtYmVyO1xuICAvKiogVGhlIGVwb2NoIHN0YW1wZWQgb24gZXZlcnkgZnJhbWUsIG9yIGB1bmRlZmluZWRgIGlmIG5vbmUgd2FzIGNvbmZpZ3VyZWQuICovXG4gIHJlYWRvbmx5IGVwb2NoOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVFdmVudExvZzxUIGV4dGVuZHMgb2JqZWN0PihcbiAgb3B0czogeyBlcG9jaD86IHN0cmluZzsgYnVmZmVyU2l6ZT86IG51bWJlciB9ID0ge30sXG4pOiBFdmVudExvZzxUPiB7XG4gIGNvbnN0IGJ1ZmZlclNpemUgPSBvcHRzLmJ1ZmZlclNpemUgPz8gUkVQTEFZX0JVRkZFUl9TSVpFO1xuICBjb25zdCBlcG9jaCA9IG9wdHMuZXBvY2g7XG4gIGNvbnN0IGJ1ZmZlcjogQXJyYXk8RnJhbWU8VD4+ID0gW107XG4gIGNvbnN0IGxpc3RlbmVycyA9IG5ldyBTZXQ8KGZyYW1lOiBGcmFtZTxUPikgPT4gdm9pZD4oKTtcbiAgbGV0IHNlcSA9IDA7XG5cbiAgcmV0dXJuIHtcbiAgICBlcG9jaCxcblxuICAgIGVtaXQobXNnKSB7XG4gICAgICBzZXEgKz0gMTtcbiAgICAgIC8vIOKblCBUSEUgTU9OT1RPTklDIElEIFdJTlMgT1ZFUiBBTllUSElORyBJTiBUSEUgUEFZTE9BRCwgQU5EIFVOVElMIE5PVyBJVFxuICAgICAgLy8gT05MWSBDTEFJTUVEIFRPLiBCb3RoIGFkb3B0aW5nIGRhZW1vbnMgd3JvdGUgYHsgaWQ6ICsrc2VxLCAuLi5tc2cgfWBcbiAgICAgIC8vIHVuZGVyIGEgY29tbWVudCBzYXlpbmcgXCJ0aGUgbW9ub3RvbmljIGBpZGAgTVVTVCB3aW4gb3ZlciBhbnkgYGlkYCBpblxuICAgICAgLy8gdGhlIHBheWxvYWQsIHNvIGNhbGxlcnMgY2FycnkgYSBwcm9qZWN0IGlkZW50aWZpZXIgYXMgYHByb2plY3RJZGAsXG4gICAgICAvLyBuZXZlciBgaWRgXCIg4oCUIGJ1dCBzcHJlYWQgb3JkZXIgbWVhbnMgYSBwYXlsb2FkIGBpZGAgb3ZlcnJvZGUgdGhlXG4gICAgICAvLyBjdXJzb3IsIHNpbGVudGx5LCBhbmQgdGhlIGNvbnZlbnRpb24gaW4gdGhlIGNvbW1lbnQgd2FzIHRoZSBvbmx5IHRoaW5nXG4gICAgICAvLyBob2xkaW5nIGl0LiBUaGUgbGl0ZXJhbCBrZWVwcyBgaWRgIEZJUlNUIHNvIHRoZSB3aXJlIGtleSBvcmRlciBpc1xuICAgICAgLy8gdW5jaGFuZ2VkOyB0aGUgYXNzaWdubWVudCBhZnRlciB0aGUgc3ByZWFkIGlzIHdoYXQgbWFrZXMgdGhlIHNlbnRlbmNlXG4gICAgICAvLyB0cnVlLiBgZXBvY2hgIGlzIHN0YW1wZWQgdGhlIHNhbWUgd2F5IGFuZCBmb3IgdGhlIHNhbWUgcmVhc29uLlxuICAgICAgY29uc3QgZnJhbWUgPSB7IGlkOiBzZXEsIC4uLm1zZyB9IGFzIEZyYW1lPFQ+O1xuICAgICAgZnJhbWUuaWQgPSBzZXE7XG4gICAgICBpZiAoZXBvY2ggIT09IHVuZGVmaW5lZCkgZnJhbWUuZXBvY2ggPSBlcG9jaDtcblxuICAgICAgYnVmZmVyLnB1c2goZnJhbWUpO1xuICAgICAgaWYgKGJ1ZmZlci5sZW5ndGggPiBidWZmZXJTaXplKSBidWZmZXIuc2hpZnQoKTtcbiAgICAgIGZvciAoY29uc3QgbGlzdGVuZXIgb2YgbGlzdGVuZXJzKSBsaXN0ZW5lcihmcmFtZSk7XG4gICAgICByZXR1cm4gZnJhbWU7XG4gICAgfSxcblxuICAgIHN1YnNjcmliZShzaW5jZSwgbGlzdGVuZXIpIHtcbiAgICAgIC8vIFNlZSB0aGUgaGVhZGVyLCBwb2ludCAzOiBhIGN1cnNvciBiZXlvbmQgb3VyIG93biBpcyBhIGN1cnNvciBmcm9tIGFcbiAgICAgIC8vIFBSSU9SIFBST0NFU1MsIGFuZCB0aGUgb25seSB1c2VmdWwgcmVhZGluZyBvZiBpdCBpcyBcInJlcGxheSB3aG9sZVwiLlxuICAgICAgLy9cbiAgICAgIC8vIOKaoCBBIE5PTi1GSU5JVEUgQ1VSU09SIEFMU08gTUVBTlMgXCJGUk9NIFRIRSBTVEFSVFwiLCB3aGljaCB0aGUgY29waWVzIGdvdFxuICAgICAgLy8gd3JvbmcgYnkgYWNjaWRlbnQ6IHRoZXkgd3JvdGUgYHBhcnNlSW50KHBhcmFtID8/IFwiLTFcIilgIGFuZCBjb21wYXJlZFxuICAgICAgLy8gYGlkID4gc2luY2VgLCBzbyBhIHR5cG8nZCBgP3NpbmNlPXhgIHByb2R1Y2VkIGBOYU5gLCBldmVyeSBjb21wYXJpc29uXG4gICAgICAvLyB3YXMgZmFsc2UsIGFuZCB0aGUgdGFpbCBvcGVuZWQgRU1QVFkgYW5kIHN0YXllZCBjb25uZWN0ZWQg4oCUIHRoZSBzYW1lXG4gICAgICAvLyBzaWxlbnQtYW5kLWNvbm5lY3RlZCBzeW1wdG9tIGFzIHRoZSBzdGFsZSB3YXRlcm1hcmssIGZyb20gYSBkaWZmZXJlbnRcbiAgICAgIC8vIGNhdXNlLiBBYnNlbnQgYW5kIHVucGFyc2VhYmxlIGFyZSB0aGUgc2FtZSByZXF1ZXN0IGhlcmUuXG4gICAgICBjb25zdCBmcm9tID0gIU51bWJlci5pc0Zpbml0ZShzaW5jZSkgfHwgc2luY2UgPiBzZXEgPyAtMSA6IHNpbmNlO1xuICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBidWZmZXIpIHtcbiAgICAgICAgaWYgKGZyYW1lLmlkID4gZnJvbSkgbGlzdGVuZXIoZnJhbWUpO1xuICAgICAgfVxuICAgICAgbGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG4gICAgICByZXR1cm4gKCkgPT4ge1xuICAgICAgICBsaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcbiAgICAgIH07XG4gICAgfSxcblxuICAgIGN1cnNvcigpIHtcbiAgICAgIHJldHVybiBzZXE7XG4gICAgfSxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgZGFlbW9uIGxpZmVjeWNsZSB0YWlsOiB0aGUgaWRsZS1jbG9zZSBkZWNpc2lvbiwgdGhlIHN3ZWVwXG4gKiB0aGF0IG1ha2VzIGl0LCBhbmQgdGhlIGJvdW5kZWQgdGVhcmRvd24uXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgYm91bnR5IOKAlCB0aGUgY2Vuc3VzJ3NcbiAqIGNvbnZlcmdlbmNlIHRhcmdldCAjMyDigJQgd2l0aCBhc3Ryb2xhYmUncyBgdGltZW91dE1zID4gMGAgZ3VhcmQgZm9sZGVkIGluLFxuICogd2hpY2ggaXMgdGhlIG9uZSB0aGluZyBib3VudHkncyBjb3B5IGRvZXMgbm90IGV4cHJlc3MuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgQURPUFRTIGBkcmFpbkFuZFN0b3BgIEFORCBOT1RISU5HIEVMU0UgSEVSRSDigJQgU1BMSVQgUEVSIEVYUE9SVFxuICpcbiAqIFJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCksIGFuZCBpdCBpcyB3cml0dGVuIGRvd25cbiAqIGJlY2F1c2UgYSByb3cgaXMgYSBNT0RVTEUgYW5kIFwicGFydGlhbFwiIGlzIG5vdCBhbiBhbnN3ZXIgdW50aWwgaXQgc2F5cyB3aGljaFxuICogZXhwb3J0cy4gR3JhcGV2aW5lIGlzIGxvbmctcnVubmluZywgc28gbm90aGluZyBhYm91dCBpdHMgbGlmZWN5Y2xlIG1ha2VzIHRoaXNcbiAqIG1vZHVsZSByZWFkIGFzIGluYXBwbGljYWJsZSDigJQgYW5kIHR3byBvZiBpdHMgdGhyZWUgZXhwb3J0cyBzdGlsbCBoYXZlIG5vXG4gKiBzdWJqZWN0IHRoZXJlOlxuICpcbiAqICAgYHNob3VsZElkbGVDbG9zZWAgICAgICBOTyBTVUJKRUNULiBHcmFwZXZpbmUgcnVucyBubyBpZGxlIHN3ZWVwIGFuZCBoYXMgbm9cbiAqICAgYHN0YXJ0SG91c2VrZWVwaW5nYCAgICBgLS10aW1lb3V0YDsgaXQgaXMgYSBicm9rZXIgdGhhdCBzdGFuZHMgdW50aWwgYHN0b3BgXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgKGBERUxFVEUgL2ApIG9yIGEgc2lnbmFsLCBhbmQgaXQgdGFrZXMgbm8gc25hcHNob3QuXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgQWRvcHRpbmcgdGhlIHBhaXItbWFuYWdlciB3b3VsZCBtZWFuIHdyaXRpbmcgYSBuby1vcFxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGB0b3VjaGAgYW5kIGEgYHN1YnNjcmliZXJDb3VudGAgdGhhdCBleGlzdHMgb25seSB0b1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBhIG51bWJlciBub2JvZHkgYWN0cyBvbiDigJQgdHdvIGxpZXMgdG8gZ2FpbiBhXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYGNsZWFySW50ZXJ2YWxgLlxuICogICBgZHJhaW5BbmRTdG9wYCAgICAgICAgIEFET1BURUQsIGFuZCBpdCBpcyBhIERFLURVUExJQ0FUSU9OIHJhdGhlciB0aGFuIGFcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBnYWluOiBncmFwZXZpbmUncyB0ZWFyZG93biBhbHJlYWR5IFdBU1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBQcm9taXNlLnJhY2UoW3NlcnZlci5zdG9wKHRydWUpLCAyMDAgbXNdKWAsIHdoaWNoIGlzXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYHN0b3BNc2AgZXhhY3RseS5cbiAqXG4gKiDimqAgKipBTkQgSVQgSVMgQ0FMTEVEIFdJVEggTk8gYGNsaWVudHNgLCBXSElDSCBJUyBBIE1FQVNVUkVNRU5ULCBOT1QgQU5cbiAqIE9WRVJTSUdIVC4qKiBUaGlzIG1vZHVsZSBjbG9zZXMgYSBoZWxkIGNvbm5lY3Rpb24gYnkgY2FsbGluZyBgY2xpZW50LmNsb3NlKClgO1xuICogZ3JhcGV2aW5lJ3Mgc3Vic2NyaWJlciByZWNvcmRzIGFyZSBge2FsaWFzLCBodW1hbiwgbHVyaywgc2VuZH1gIGFuZCBjYXJyeSBub1xuICogYGNsb3NlYCDigJQgaXRzIHBlci1zdHJlYW0gdGVhcmRvd24gaXMgYSBjbG9zdXJlIHN0YXNoZWQgb24gdGhlIFJlYWRhYmxlU3RyZWFtXG4gKiBjb250cm9sbGVyLCByZWFjaGFibGUgb25seSBmcm9tIGBjYW5jZWwoKWAuIFRoZXJlIGlzIG5vdGhpbmcgdG8gaGFuZCB0aGVcbiAqIGFyZ3VtZW50LiBgc3NlLnRzYCdzIGhlYWRlciBjYXJyaWVzIHRoZSByZXN0IG9mIHRoYXQgcnVsaW5nLCBpbmNsdWRpbmcgdGhlXG4gKiB3aWRlbmluZyBub3QgZG9uZSBhbmQgaXRzIGNvc3QgKHNpeCBhcnRpZmFjdHMgYWNyb3NzIGZpdmUgc3BlbGxzKS5cbiAqXG4gKiDimqAgR3JhcGV2aW5lIGFsc28gcGFzc2VzIGBncmFjZU1zOiAwYC4gTm90IGEgZGlzYWdyZWVtZW50IHdpdGggdGhlIGdyYWNlXG4gKiBwZXJpb2Q6IGl0IGVtaXRzIG5vIGZhcmV3ZWxsIGZyYW1lIGF0IGRhZW1vbiBzaHV0ZG93biwgYW5kIGl0cyBgREVMRVRFIC9gXG4gKiBhbHJlYWR5IHJldHVybnMgdGhlIHJlc3BvbnNlIGFuZCBzY2hlZHVsZXMgdGhlIHRlYXJkb3duIDEwIG1zIGxhdGVyLCBzbyBpdHNcbiAqIGZsdXNoIHdpbmRvdyBzaXRzIGF0IHRoZSByb3V0ZSByYXRoZXIgdGhhbiBpbiB0aGUgZHJhaW4uXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTc2VDbGllbnRzIH0gZnJvbSBcIi4vc3NlLnRzXCI7XG5cbi8qKlxuICogU2hvdWxkIHRoZSBkYWVtb24gaWRsZS1jbG9zZT9cbiAqXG4gKiDim5QgKipgc3Vic2NyaWJlckNvdW50YCBJUyBBIFJFUVVJUkVEIEFSR1VNRU5ULCBBTkQgVEhBVCBJUyBUSEUgV0hPTEUgUE9JTlQuKipcbiAqIFRoaXMgY2xvc2VzIGNlbnN1cyBkZWZlY3QgKipMMSoqIGJ5IGNvbnN0cnVjdGlvbjogZ2xhbW91ciwgaW1hZ28gYW5kIG1hZ3BpZVxuICogY291bnRlZCB0aGVpciBpZGxlIGZsb29yIGRvd24gd2hpbGUgYW4gYWdlbnQgaGVsZCBhIHRhaWwgb3Blbiwgc28gYW4gYWdlbnRcbiAqIHdhdGNoaW5nIGEgcXVpZXQgYm9hcmQgd2FzIGtpbGxlZCBXSVRIIElUUyBDT05ORUNUSU9OIE9QRU4uIFRoZXJlIGlzIG5vXG4gKiBvdmVybG9hZCBvZiB0aGlzIGZ1bmN0aW9uIHRoYXQgY2Fubm90IHNlZSBpdHMgc3Vic2NyaWJlcnMsIHNvIHRoZSBkZWZlY3RcbiAqIGNhbm5vdCBiZSByZS1leHByZXNzZWQgYnkgYSBjYWxsZXIgd2hvIGZvcmdldHMuXG4gKlxuICog4puUICoqQU5EIFRIRSBTQ0FSIElUIENBTUUgV0lUSCwgcmUtaG9tZWQgZnJvbSBib3VudHkgdmVyYmF0aW0gaW4gc3Vic3RhbmNlOioqXG4gKiBhIGJvYXJkIG9ubHkgY291bnRzIGl0cyBpZGxlIGZsb29yIGRvd24gd2hpbGUgVU5XQVRDSEVELiBBIGxpdmUgc3Vic2NyaWJlciDigJRcbiAqIGEgYnJvd3NlciBXZWJTb2NrZXQsIG9yIGFuIGFnZW50IFNTRSB0YWlsIG9uIGAvZXZlbnRzYCDigJQga2VlcHMgaXQgb3BlblxuICogaW5kZWZpbml0ZWx5LiBTbyBgdGltZW91dGAgbWVhbnMgXCJsaW5nZXIgdGhpcyBsb25nIGFmdGVyIHRoZSBMQVNUIHN1YnNjcmliZXJcbiAqIGxlYXZlc1wiLCBOT1QgXCJtYXhpbXVtIGlkbGUgd2hpbGUgY29ubmVjdGVkXCIuIFRoZSBzd2VlcCBiZWxvdyBhbHNvIHRvdWNoZXMgdGhlXG4gKiBhY3Rpdml0eSBjbG9jayBvbiBldmVyeSB0aWNrIHdoaWxlIHdhdGNoZWQsIHNvIG9uY2UgdW53YXRjaGVkIHRoZSBmbG9vclxuICogY291bnRzIGZyb20gdGhhdCBsYXN0IGRpc2Nvbm5lY3QgYW5kIG5vdCBmcm9tIHRoZSBsYXN0IHJlcXVlc3QuXG4gKlxuICog4pqgIGB0aW1lb3V0TXMgPD0gMGAgbWVhbnMgTkVWRVIsIHdoaWNoIGlzIGFzdHJvbGFiZSdzIHN0YW5kaW5nLW9ic2VydmF0b3J5XG4gKiBkZWZhdWx0IGFuZCBpcyB3aHkgdGhlIGd1YXJkIGlzIGhlcmUgcmF0aGVyIHRoYW4gYXQgaXRzIG9uZSBjYWxsIHNpdGU6IGFcbiAqIHNpbmdsZXRvbiBkYWVtb24gaXMgbWVhbnQgdG8gc3RhbmQgdW50aWwgaXQgaXMgZXhwbGljaXRseSBjbG9zZWQsIGFuZCBhXG4gKiBgPj0gMGAgY29tcGFyaXNvbiB3b3VsZCBjbG9zZSBpdCBvbiB0aGUgZmlyc3QgdGljay5cbiAqXG4gKiBDbG9jay1mcmVlIGFuZCBmcy1mcmVlLCBzbyBpdCBpcyB0ZXN0YWJsZSB3aXRob3V0IGEgZGFlbW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkSWRsZUNsb3NlKFxuICBzdWJzY3JpYmVyQ291bnQ6IG51bWJlcixcbiAgaWRsZU1zOiBudW1iZXIsXG4gIHRpbWVvdXRNczogbnVtYmVyLFxuKTogYm9vbGVhbiB7XG4gIGlmICh0aW1lb3V0TXMgPD0gMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoc3Vic2NyaWJlckNvdW50ID4gMCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaWRsZU1zID49IHRpbWVvdXRNcztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBIb3VzZWtlZXBpbmdPcHRpb25zIHtcbiAgLyoqIOKblCBSRVFVSVJFRC4gU2VlIGBzaG91bGRJZGxlQ2xvc2VgIOKAlCB0aGlzIGlzIHdoYXQgY2xvc2VzIEwxLiAqL1xuICBzdWJzY3JpYmVyQ291bnQ6ICgpID0+IG51bWJlcjtcbiAgLyoqIE1pbGxpc2Vjb25kcyBzaW5jZSB0aGUgbGFzdCBhY3Rpdml0eS4gKi9cbiAgaWRsZU1zOiAoKSA9PiBudW1iZXI7XG4gIC8qKiBSZXNldCB0aGUgYWN0aXZpdHkgY2xvY2suIENhbGxlZCBvbiBldmVyeSB0aWNrIHRoYXQgaGFzIGEgc3Vic2NyaWJlci4gKi9cbiAgdG91Y2g6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgY29uZmlndXJlZCBpZGxlIHRpbWVvdXQgaW4gbXM7IGAwYCAob3IgbGVzcykgbWVhbnMgbmV2ZXIuICovXG4gIHRpbWVvdXRNczogbnVtYmVyO1xuICAvKiogRmlyZWQgb25jZSB3aGVuIHRoZSBkYWVtb24gc2hvdWxkIGNsb3NlIGl0c2VsZi4gKi9cbiAgb25JZGxlQ2xvc2U6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgZGVib3VuY2VkIHNuYXBzaG90LCBpZiB0aGUgc3BlbGwgaGFzIG9uZS4gKi9cbiAgc25hcHNob3Q/OiB7XG4gICAgZGlydHk6ICgpID0+IGJvb2xlYW47XG4gICAgY2xlYXI6ICgpID0+IHZvaWQ7XG4gICAgd3JpdGU6ICgpID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+O1xuICB9O1xuICAvKiogU3dlZXAgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDI1MCBtcy4gKi9cbiAgdGlja01zPzogbnVtYmVyO1xuICAvKiogU25hcHNob3QgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDEwMDAgbXMuICovXG4gIHNuYXBzaG90TXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogU3RhcnQgdGhlIHR3byBzdGFuZGluZyB0aW1lcnMgZXZlcnkgc2Vzc2lvbiBkYWVtb24gcnVucyDigJQgdGhlIGlkbGUgc3dlZXAgYW5kXG4gKiB0aGUgZGVib3VuY2VkIHNuYXBzaG90IOKAlCBhbmQgcmV0dXJuIHRoZSBmdW5jdGlvbiB0aGF0IHN0b3BzIGJvdGguXG4gKlxuICogVGhleSBhcmUgT05FIGNhbGwgYmVjYXVzZSB0aGV5IGhhdmUgYWx3YXlzIGJlZW4gb25lIGxpZmV0aW1lOiBldmVyeSBjb3B5XG4gKiBjbGVhcmVkIGJvdGggaW4gdGhlIHNhbWUgdHdvIGxpbmVzIGFmdGVyIGBhd2FpdCBkb25lYCwgYW5kIHRoZSBwYWlyIHRoYXQgZ2V0c1xuICogZm9yZ290dGVuIGlzIHRoZSBwYWlyIHdob3NlIHRpbWVycyBrZWVwIGEgcHJvY2VzcyBhbGl2ZSBhZnRlciB0ZWFyZG93bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0SG91c2VrZWVwaW5nKG9wdHM6IEhvdXNla2VlcGluZ09wdGlvbnMpOiAoKSA9PiB2b2lkIHtcbiAgY29uc3QgdGlja01zID0gb3B0cy50aWNrTXMgPz8gMjUwO1xuICBjb25zdCBzbmFwc2hvdE1zID0gb3B0cy5zbmFwc2hvdE1zID8/IDEwMDA7XG5cbiAgY29uc3QgaWRsZVRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIGNvbnN0IHN1YnNjcmliZXJzID0gb3B0cy5zdWJzY3JpYmVyQ291bnQoKTtcbiAgICBpZiAoc3Vic2NyaWJlcnMgPiAwKSBvcHRzLnRvdWNoKCk7XG4gICAgaWYgKHNob3VsZElkbGVDbG9zZShzdWJzY3JpYmVycywgb3B0cy5pZGxlTXMoKSwgb3B0cy50aW1lb3V0TXMpKSBvcHRzLm9uSWRsZUNsb3NlKCk7XG4gIH0sIHRpY2tNcyk7XG5cbiAgY29uc3Qgc25hcCA9IG9wdHMuc25hcHNob3Q7XG4gIGNvbnN0IHNuYXBUaW1lciA9IHNuYXBcbiAgICA/IHNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgaWYgKCFzbmFwLmRpcnR5KCkpIHJldHVybjtcbiAgICAgICAgc25hcC5jbGVhcigpO1xuICAgICAgICB2b2lkIHNuYXAud3JpdGUoKTtcbiAgICAgIH0sIHNuYXBzaG90TXMpXG4gICAgOiBudWxsO1xuXG4gIHJldHVybiAoKSA9PiB7XG4gICAgY2xlYXJJbnRlcnZhbChpZGxlVGltZXIpO1xuICAgIGlmIChzbmFwVGltZXIgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoc25hcFRpbWVyKTtcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEcmFpbk9wdGlvbnMge1xuICAvKiogVGhlIGJvdW5kIHNlcnZlci4gVHlwZWQgc3RydWN0dXJhbGx5IHNvIHRoZSBraXQgc3RheXMgZnJlZSBvZiBgYnVuYC4gKi9cbiAgc2VydmVyOiB7IHN0b3AoY2xvc2VBY3RpdmVDb25uZWN0aW9ucz86IGJvb2xlYW4pOiB1bmtub3duIH07XG4gIC8qKiBMaXZlIFNTRSB0YWlsczsgZXZlcnkgcmVnaXN0ZXJlZCBjbG9zZXIgaXMgaW52b2tlZC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBMaXZlIFdlYlNvY2tldHMuICovXG4gIHNvY2tldHM/OiBJdGVyYWJsZTx7IGNsb3NlKCk6IHZvaWQgfT47XG4gIC8qKiBIb3cgbG9uZyBxdWV1ZWQgZnJhbWVzIGdldCB0byBmbHVzaCBiZWZvcmUgYW55dGhpbmcgaXMgY2xvc2VkLiAqL1xuICBncmFjZU1zPzogbnVtYmVyO1xuICAvKiogSG93IGxvbmcgdGhlIGdyYWNlZnVsIHN0b3AgZ2V0cyBiZWZvcmUgdGVhcmRvd24gcHJvY2VlZHMgcmVnYXJkbGVzcy4gKi9cbiAgc3RvcE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIENsb3NlIGV2ZXJ5IGhlbGQgY29ubmVjdGlvbiBhbmQgc3RvcCB0aGUgc2VydmVyLCBpbiBib3VuZGVkIHRpbWUuXG4gKlxuICog4puUICoqVEhFIEdSQUNFIFBFUklPRCBJUyBOT1QgUE9MSVRFTkVTUy4qKiBBIGBjbG9zZWRgIGZyYW1lIGVtaXR0ZWQgYW5kIHRoZW5cbiAqIGZvbGxvd2VkIGltbWVkaWF0ZWx5IGJ5IGFuIGFnZ3Jlc3NpdmUgYHNlcnZlci5zdG9wKHRydWUpYCBpcyBhIGZyYW1lIHRoZVxuICogY2xpZW50IG5ldmVyIHNlZXMg4oCUIHRoZSBxdWV1ZSBnb2VzIHdpdGggdGhlIHNvY2tldC4gVGhlIDE1MCBtcyBpcyB3aGF0IHR1cm5zXG4gKiBcInRoZSBkYWVtb24gdG9sZCB5b3Ugd2h5IGl0IGRpZWRcIiBmcm9tIGEgaG9wZSBpbnRvIGFuIG9ic2VydmF0aW9uLCBhbmQgZXZlcnlcbiAqIG9uZSBvZiB0aGUgZWlnaHQgZGFlbW9ucyBjb252ZXJnZWQgb24gdGhhdCBudW1iZXIgaW5kZXBlbmRlbnRseS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNUT1AgSVMgUkFDRUQsIEJFQ0FVU0UgQSBTTE9XIFNPQ0tFVCBNVVNUIE5PVCBCRSBBQkxFIFRPIEhBTkdcbiAqIFRFQVJET1dOLioqIGBzZXJ2ZXIuc3RvcCh0cnVlKWAgYXdhaXRzIGl0cyBjb25uZWN0aW9uczsgb25lIHdlZGdlZCBwZWVyIGlzXG4gKiBlbm91Z2ggdG8gcGFyayBpdCBmb3JldmVyLCB3aGljaCBpcyBob3cgYSAyMy1taW51dGUgaGFuZyBzaGlwcGVkIG9uY2UuXG4gKlxuICog4pqgICoqV0hBVCBJUyBERUxJQkVSQVRFTFkgTk9UIEhFUkU6IGJvdW50eSdzIHNodXRkb3duIHdhdGNoZG9nLioqIEJvdW50eSBhcm1zXG4gKiBhIFJFRidkIGBzZXRUaW1lb3V0YCB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGlmIHRlYXJkb3duIGRvZXMgbm90IGZpbmlzaCxcbiAqIGFuZCB0aGUgY2Vuc3VzIGlzIHJpZ2h0IHRoYXQgaXQgaXMgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbFxuICogdGVybWluYXRpb24gZ3VhcmFudGVlLiBJdCBiZWxvbmdzIHRvIGJvdW50eSdzIFRFQVJET1dOIOKAlCB0aGUgc3RyZXRjaCB3aGVyZVxuICogbm90aGluZyBib3VuZHMgd2hhdCBpcyBiZWluZyB3YWl0ZWQgb24uIOKblCAqKlRISVMgUEFSQUdSQVBIIFNBSUQgXCJTSUdOQUxcbiAqIFBBVEhcIiBVTlRJTCBENTMsIEFORCBUSEUgQ09ERSBBR1JFRUQgV0lUSCBJVCwgV0hJQ0ggV0FTIFRIRSBERUZFQ1QuKiogQm91bnR5XG4gKiBoYXMgRk9VUiB3YXlzIGludG8gb25lIHRlYXJkb3duIChhIHNpZ25hbCwgYSBgY2xvc2VgIHZlcmIsIHRoZSBicm93c2VyJ3NcbiAqIGNsb3NlIG92ZXIgdGhlIFdlYlNvY2tldCwgYW4gaWRsZSB0aW1lb3V0KSBhbmQgb25seSB0aGUgc2lnbmFsIG9uZSBhcm1lZCB0aGVcbiAqIHRpbWVyLCB3aGlsZSB0aGUgY29tbWVudCBhYm92ZSBpdCBjbGFpbWVkIHRoZSBlbmRpbmcgd2FzIHVuY29uZGl0aW9uYWwuXG4gKiBEcml2ZW4gd2l0aCBhIHBsYW50ZWQgaGFuZzogdGhlIG90aGVyIHRocmVlIHJhbiBwYXN0IDEwIHMsIHRoZSBpZGxlIG9uZVxuICogaW5jbHVkZWQg4oCUIHRoZSBvcnBoYW4tZGFlbW9uIGNsYXNzIHRoZSAyMy1taW51dGUgaGFuZyBjYW1lIGZyb20uIFRoZSBhcm1pbmdcbiAqIG5vdyBsaXZlcyBpbiB0aGUgUkVTT0xWRSB0aGF0IGFsbCBmb3VyIGVudHJpZXMgcGFzcyB0aHJvdWdoLiAqKlRoZSBsZXNzb24gZm9yXG4gKiBhbiBhZG9wdGVyIGlzIHRoZSBjb3VudCwgbm90IHRoZSBwbGFjZW1lbnQ6IGVudW1lcmF0ZSBldmVyeSBlbnRyeSBpbnRvIHRoZVxuICogdGVhcmRvd24gYmVmb3JlIHlvdSBiZWxpZXZlIGEgZ3VhcmFudGVlIGNvdmVycyBpdC4qKiBUaGUgdHdvXG4gKiBkYWVtb25zIGFkb3B0aW5nIHRoaXMgbW9kdWxlIHJlZ2lzdGVyIG5vIHNpZ25hbCBoYW5kbGVycywgYW5kIHRoZWlyIHdob2xlXG4gKiB0ZWFyZG93biBpcyBib3VuZGVkIGJ5IHRoZSB0d28gbnVtYmVycyBhYm92ZTsgYWRkaW5nIGFuIGV4aXQgaGVyZSB3b3VsZCBwdXRcbiAqIHRoZSBob3VzZSdzIG9ubHkgdW5jb25kaXRpb25hbCBgcHJvY2Vzcy5leGl0YCBpbnNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgaXNcbiAqIGFib3V0IHRvIGJ1bmRsZSwgb25lIHBoYXNlIGFmdGVyIEQ4IHRvb2sgZXhhY3RseSB0aGF0IGhhemFyZCBPVVQgb2YgYGRpZWAuXG4gKlxuICog4puUICoqQU5EIFRIRSBTRU5URU5DRSBUSEFUIFVTRUQgVE8gRU5EIFRIQVQgUEFSQUdSQVBIIFdBUyBBIFBSRURJQ1RJT04sIFdISUNIXG4gKiBCT1VOVFknUyBPV04gUE9SVCBGQUxTSUZJRUQuKiogSXQgcmVhZDogXCJ3aGVuIGEgc3BlbGwgd2l0aCBhIHNpZ25hbCBwYXRoXG4gKiBhZG9wdHMgdGhpcywgdGhlIHdhdGNoZG9nIGFycml2ZXMgYXMgYW4gb3B0aW9uIG9uIHRoZXNlIGFyZ3VtZW50cyBhbmQgdGhlXG4gKiByZWFzb25pbmcgaXMgYWxyZWFkeSB3cml0dGVuIGRvd24uXCIgYm91bnR5IGFkb3B0ZWQgYGRyYWluQW5kU3RvcGAgb25cbiAqIDIwMjYtMDktMDkgKFBoYXNlIDQpIGFuZCB0aGUgb3B0aW9uIHdhcyBOT1QgYWRkZWQsIGJlY2F1c2UgdGhlIHdpbmRvdyBpc1xuICogd3JvbmcuICoqQSBgd2F0Y2hkb2dNc2Agb24gdGhlc2UgYXJndW1lbnRzIHdvdWxkIGFybSBhdCBEUkFJTiB0aW1lOyBib3VudHknc1xuICogYXJtcyBhdCBTSUdOQUwgdGltZSoqLCBhbmQgdGhlIHdob2xlIHJlYXNvbiBpdCBleGlzdHMgaXMgdGhlIHN0cmV0Y2ggQkVUV0VFTlxuICogdGhvc2UgdHdvIHBvaW50cyDigJQgYGF3YWl0IGRvbmVgLCBhbiBmcyBhcHBlbmQgdG8gdGhlIGRhZW1vbiBsb2csIGEgZnVsbFxuICogc25hcHNob3Qgd3JpdGUgdGhhdCBjYW4gcm90YXRlIGFuZCBDT1BZIGEgYmFja3VwIG9mIGEgbGFyZ2UgYm9hcmQsIGEgYGNsb3NlZGBcbiAqIGZyYW1lIGFuZCBhIGJyb2FkY2FzdC4gYGRyYWluQW5kU3RvcGAncyBvd24gYm9keSBpcyBhbHJlYWR5IGJvdW5kZWQgYnkgdGhlIHR3b1xuICogbnVtYmVycyBhYm92ZSwgc28gYSB3YXRjaGRvZyBzY29wZWQgdG8gaXQgd291bGQgZ3VhcmQgdGhlIG9uZSBzdHJldGNoIHRoYXRcbiAqIGNhbm5vdCBoYW5nIGFuZCBhYmFuZG9uIHRoZSBzdHJldGNoIHRoYXQgY2FuOiBpdCB3b3VsZCBSRUFEIGFzIGFkb3B0aW9uIGFuZFxuICogQkUgYSBuYXJyb3dpbmcgb2YgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbCB0ZXJtaW5hdGlvbiBndWFyYW50ZWUuIFRoZVxuICogMjMtbWludXRlIGhhbmcgdGhpcyBwcm9qZWN0IGtlZXBzIGNpdGluZyBoYXBwZW5lZCBpbiB0aGUgdW5ib3VuZGVkIHN0cmV0Y2guXG4gKlxuICog4pqgICoqU08gVEhFIFJVTEUgRk9SIFRIRSBORVhUIFNQRUxMLCBXSElDSCBJUyBUSEUgVFJBTlNGRVJBQkxFIEhBTEY6KiogdGhlXG4gKiBxdWVzdGlvbiBpcyBuZXZlciBcImRvZXMgdGhpcyBtb2R1bGUgaGF2ZSBhIHBsYWNlIHRvIHB1dCBhIHdhdGNoZG9nXCIgYnV0XG4gKiBcImRvZXMgdGhlIHdhdGNoZG9nJ3Mgd2luZG93IGNvaW5jaWRlIHdpdGggdGhpcyBtb2R1bGUnc1wiLiBXaGVyZSBhIHNwZWxsJ3NcbiAqIHRlYXJkb3duIGhhcyB1bmJvdW5kZWQgd29yayBCRUZPUkUgdGhlIGRyYWluLCB0aGUgd2F0Y2hkb2cgYmVsb25ncyBhdCB0aGVcbiAqIHNwZWxsLCB3cmFwcGVkIGFyb3VuZCBhbGwgb2YgaXQg4oCUIGFuZCBhcm91bmQgRVZFUlkgV0FZIElOLCB3aGljaCBpcyB0aGUgaGFsZlxuICogRDUzIGhhZCB0byByZXBhaXIgYWZ0ZXIgdGhpcyBoZWFkZXIgd2FzIHdyaXR0ZW4uIElmIGEgc3BlbGwgZXZlciBhcHBlYXJzIHdob3NlIHNpZ25hbCBwYXRoXG4gKiBlbnRlcnMgYGRyYWluQW5kU3RvcGAgaW1tZWRpYXRlbHksIGFkZCB0aGUgb3B0aW9uIFRIRU4g4oCUIGFuZCB0aGUgb3B0aW9uIG11c3RcbiAqIHRha2UgYW4gYG9uRXhwaXJlYCBjYWxsYmFjayByYXRoZXIgdGhhbiBleGl0aW5nLCBzbyB0aGUgYHByb2Nlc3MuZXhpdGAgc3RheXNcbiAqIG91dHNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgYnVuZGxlcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRyYWluQW5kU3RvcChvcHRzOiBEcmFpbk9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZ3JhY2VNcyA9IG9wdHMuZ3JhY2VNcyA/PyAxNTA7XG4gIGNvbnN0IHN0b3BNcyA9IG9wdHMuc3RvcE1zID8/IDIwMDtcblxuICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBncmFjZU1zKSk7XG5cbiAgaWYgKG9wdHMuY2xpZW50cykge1xuICAgIGZvciAoY29uc3QgY2xpZW50IG9mIFsuLi5vcHRzLmNsaWVudHNdKSBjbGllbnQuY2xvc2UoKTtcbiAgfVxuICBpZiAob3B0cy5zb2NrZXRzKSB7XG4gICAgZm9yIChjb25zdCB3cyBvZiBbLi4ub3B0cy5zb2NrZXRzXSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgd3MuY2xvc2UoKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBhbHJlYWR5IGdvbmUgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgIFByb21pc2UucmVzb2x2ZShvcHRzLnNlcnZlci5zdG9wKHRydWUpKSxcbiAgICBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBzdG9wTXMpKSxcbiAgXSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGFzc2V0LXNlcnZpbmcgdHJpbyBmb3IgYSBzcGVsbCBkYWVtb246IHdoaWNoIHN1cmZhY2UgbW9kZSB3ZVxuICogYXJlIGluLCB3aGF0IGNvbnRlbnQgdHlwZSBhIGZpbGUgZ2V0cywgYW5kIGhvdyBhIGZpbGUgdW5kZXIgYGRpc3QvYCBpc1xuICogYW5zd2VyZWQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwncyBhcnRpZmFjdC5cbiAqXG4gKiBFeHRyYWN0ZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBmcm9tIHRoZSBlaWdodCBgQnVuLnNlcnZlYCBiYWNrZW5kc1xuICogY2Vuc3VzZWQgaW4gYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC1kYWVtb24tc3BpbmUtY2Vuc3VzLm1kYCwgd2hpY2hcbiAqIG1lYXN1cmVkIGByZXNvbHZlTW9kZWAgYXMgYnl0ZS1pZGVudGljYWwgaW4gYWxsIGVpZ2h0ICh0aGUgb25seSBtZDUgZGlmZmVyZW5jZVxuICogYmVpbmcgdGhlIGBleHBvcnRgIGtleXdvcmQpLCB0aGUgY29udGVudC10eXBlIG1hcCBhcyBkaWZmZXJpbmcgaW4gZXhhY3RseVxuICogb25lIGNlbGwsIGFuZCB0aGUgZmlsZSBoYWxmIG9mIGBzZXJ2ZURpc3RgIGFzIGlkZW50aWNhbCBpbiBmaXZlLlxuICpcbiAqIOKUgOKUgCBXSEFUIERFTElCRVJBVEVMWSBESUQgTk9UIENPTUUgQUxPTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKipUaGUgVVJMLXRvLWZpbGVuYW1lIG1hcHBpbmcgc3RheXMgaW4gZWFjaCByb3V0ZXIuKiogVGhlIGNlbnN1cyBtYXJrZWQgdHdvXG4gKiBvZiB0aGUgZWlnaHQgYHNlcnZlRGlzdGAgZGl2ZXJnZW5jZXMgREVMSUJFUkFURSBhbmQgYm90aCBsaXZlIGluIHRoYXQgaGFsZjpcbiAqIGRpZ2VzdGlmeSBzdWJzdGl0dXRlcyBpbnRvIHRoZSBlbnRyeSBIVE1MIGluIG1lbW9yeSwgYW5kIGdyYXBldmluZSBzZXJ2ZXMgaXRzXG4gKiBzdXJmYWNlIGF0IGAvd2F0Y2hgIHJhdGhlciB0aGFuIGF0IGAvYC4gQSBzaWduYXR1cmUgd2lkZSBlbm91Z2ggdG8gYWJzb3JiXG4gKiB0aG9zZSBzdG9wcyBiZWluZyBhIGZpbGUgc2VydmVyIGFuZCBiZWNvbWVzIGEgcm91dGVyLiBTbyB0aGUgY2FsbGVyIGRlY2lkZXNcbiAqIFdISUNIIGZpbGUgKGBwYXRoID09PSBcIi9cIiA/IFwiaW5kZXguaHRtbFwiIDogcGF0aC5zbGljZSgxKWApLCBhbmQgdGhpcyBtb2R1bGVcbiAqIGRlY2lkZXMgd2hldGhlciB0aGF0IGZpbGUgbWF5IGJlIHJlYWQgYW5kIHdoYXQgaXQgaXMgc2VydmVkIGFzLlxuICpcbiAqIOKUgOKUgCBBTkQgXCJXSEVUSEVSIElUIE1BWSBCRSBSRUFEXCIgSVMgTk9XIEEgV0hJVEVMSVNUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEV4dHJhY3RlZCB3aXRoIHRocmVlIGd1YXJkcyAoZW1wdHkgLyBgLi5gIC8gbmVzdGVkKSBhbmQgYGV4aXN0c1N5bmNgIGZvciB0aGVcbiAqIHJlc3QsIHdoaWNoIHdhcyB0cnVlIG9mIGEgYGRpc3QvYCB0aGF0IGhlbGQgb25seSBhIHN1cmZhY2UuIFBoYXNlIDFiIHB1dCBldmVyeVxuICogZGFlbW9uJ3MgQlVORExFIGluIHRoYXQgc2FtZSBkaXJlY3RvcnksIGFuZCBhbGwgZml2ZSBhZG9wdGVycyBzZXJ2ZWQgaXQ6XG4gKiBgL2NsaS5qc2AsIGAvc2VydmVyLmpzYCwgYC9qb2luLmpzYCBhdCAyMDAsIGJ5dGUtaWRlbnRpY2FsIHRvIHRoZSBjb21taXR0ZWRcbiAqIGFydGlmYWN0cywgZW1iZWRkZWQgc291cmNlbWFwcyBhbmQgYWxsLiBgc2VydmVGcm9tRGlzdGAgbm93IHNlcnZlcyBvbmx5IHdoYXQgdGhlXG4gKiBidWlsdCBgaW5kZXguaHRtbGAgdHJhbnNpdGl2ZWx5IGxpbmtzIOKAlCBzZWUgYHN1cmZhY2VXaGl0ZWxpc3RgIGJlbG93LCB3aGljaCBpc1xuICogdGhlIHNoYXBlIGRpZ2VzdGlmeSBwcm92ZWQgbG9jYWxseSBpbiBgZDhjYmFmZmAgYW5kIHRoaXMgaXMgaXRzIG9uZSBlZGl0IGZvclxuICogZml2ZSBzcGVsbHMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbi8qKlxuICogUmVsZWFzZSBpZmYgYDxkaXN0RGlyPi9pbmRleC5odG1sYCBleGlzdHM7IGVsc2UgZGV2LiBUaGUgZW52IG92ZXJyaWRlXG4gKiAoYFNQRUxMQk9PS19TVVJGQUNFX01PREVgKSB3aW5zIGVpdGhlciB3YXkg4oCUIHNlYW1zIENvbnRyYWN0IDEuXG4gKlxuICog4puUICoqVEhFIEZJTEUsIE5FVkVSIFRIRSBESVJFQ1RPUlksIEFORCBUSEFUIElTIEEgU0NBUiBOT1QgQSBTVFlMRSBDSE9JQ0UuKipcbiAqIFJlLWhvbWVkIGZyb20gYm91bnR5IGFuZCBtYWdwaWUsIHdoaWNoIGVhcm5lZCBpdCBpbmRlcGVuZGVudGx5OlxuICpcbiAqIC0gbWFncGllJ3MgYGRpc3QvYCBBTFJFQURZIEVYSVNURUQgaG9sZGluZyBgY2xpLmpzYCBhbmQgbm8gYGluZGV4Lmh0bWxgLFxuICogICB3aGljaCBpcyBwcmVjaXNlbHkgd2h5IGl0cyBkYWVtb24gc3RheWVkIGNvcnJlY3RseSBpbiBERVYgbW9kZSB0aHJvdWdoIHRoZVxuICogICB3aG9sZSBvZiBTbGljZSAyLiBgZGlzdC9gIGV4aXN0aW5nIGlzIG5vdCB0aGUgZGlzY3JpbWluYXRvci5cbiAqIC0gYm91bnR5IHNheXMgdGhlIHNhbWUgdGhpbmcgZnJvbSB0aGUgb3RoZXIgc2lkZTogYSBidWlsdCBCQUNLRU5EIHB1dHNcbiAqICAgYGNsaS5qc2AgKGFuZCBub3cgYHNlcnZlci5qc2ApIGluIGBkaXN0L2Agd2l0aCBubyBzdXJmYWNlIGFueXdoZXJlIG5lYXIgaXQuXG4gKlxuICog4pqgICoqQU5EIFRIRSBQUkVESUNBVEUgSVMgQU4gVU5IQVNIRUQgRklMRU5BTUUsIFdISUNIIElTIEEgU1RBTkRJTkdcbiAqIEFTU1VNUFRJT04gQUJPVVQgVEhFIFNVUkZBQ0UgQlVJTEQuKiogUmVsZWFzZSBtb2RlIGlzIGNob3NlbiBieSBPTkUgbGl0ZXJhbFxuICogbmFtZS4gQSBzdXJmYWNlIGJ1aWxkIHRoYXQgZXZlciBlbWl0dGVkIGEgY29udGVudC1oYXNoZWQgZW50cnkgZG9jdW1lbnQgd291bGRcbiAqIGxlYXZlIG5vIGBpbmRleC5odG1sYCBoZXJlLCBldmVyeSBkYWVtb24gd291bGQgc2lsZW50bHkgcmVzb2x2ZSBERVYsIGFuZCB0aGVcbiAqIG9ubHkgc3ltcHRvbSBhbnlvbmUgY2FuIHNlZSBpcyB0aGUgYG1vZGVgIGZpZWxkIG9uIGEgaGFuZHNoYWtlIG5vYm9keSByZWFkcyBpblxuICogYW5nZXIuIGBzcmMvYnVpbGQudHNgIGVtaXRzIHRoZSBlbnRyeSB1bmhhc2hlZCB0b2RheSAob25seSB0aGUgSlMgYW5kIENTU1xuICogY2h1bmtzIGNhcnJ5IGhhc2hlcykgYW5kIENvbnRyYWN0IDIgcGlucyB0aGF0IGZsYXQgbGF5b3V0OyB0aGlzIGNvbW1lbnQgaXNcbiAqIHRoZSBub3RlIHRoYXQgc2F5cyB3aGF0IHRoZSBwaW4gaXMgbG9hZC1iZWFyaW5nIEZPUi5cbiAqXG4gKiDimqAgTm90aGluZyBhbm5vdW5jZXMgdGhlIGZsaXAgZnJvbSBkZXYgdG8gcmVsZWFzZSBlaXRoZXI6IHRoZSBmaXJzdCBzdXJmYWNlXG4gKiBidWlsZCB0byBsYW5kIGFuIGBpbmRleC5odG1sYCBiZXNpZGUgYSBkYWVtb24gZmxpcHMgaXQsIHNpbGVudGx5LCBvbiB0aGUgbmV4dFxuICogYm9vdC4gVGhhdCBpcyB3aHkgYG1vZGVgIHJpZGVzIHRoZSByZWFkeSBmcmFtZSDigJQgd2l0aCByb290IGRlcHMgcHJlc2VudCBhIGRldlxuICogZGFlbW9uIHJlbmRlcnMgYW4gaWRlbnRpY2FsLWxvb2tpbmcgc3VyZmFjZSwgc28gXCJpdCBsb29rcyByaWdodFwiIGNhbm5vdFxuICogdmVyaWZ5IENvbnRyYWN0IDEuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9kZShkaXN0RGlyOiBzdHJpbmcpOiBcImRldlwiIHwgXCJyZWxlYXNlXCIge1xuICBjb25zdCBvdmVycmlkZSA9IHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREU7XG4gIGlmIChvdmVycmlkZSA9PT0gXCJkZXZcIiB8fCBvdmVycmlkZSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBvdmVycmlkZTtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihkaXN0RGlyLCBcImluZGV4Lmh0bWxcIikpID8gXCJyZWxlYXNlXCIgOiBcImRldlwiO1xufVxuXG4vKipcbiAqIFRoZSBjb250ZW50IHR5cGVzIGEgYnVpbHQgc3VyZmFjZSBhY3R1YWxseSBzaGlwcy4gRXh0ZW5zaW9ucyBvdXRzaWRlIHRoZVxuICogbWFwIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYCDigJQgYSBkZWxpYmVyYXRlIHJlZnVzYWwgdG8gZ3Vlc3MsIHNpbmNlXG4gKiBhbnl0aGluZyBub3QgaW4gdGhpcyBsaXN0IGlzIG5vdCBzb21ldGhpbmcgQ29udHJhY3QgMidzIGJ1aWxkIGVtaXRzLlxuICpcbiAqIOKaoCAqKmBjaGFyc2V0PXV0Zi04YCBPTiBIVE1MIElTIFRIRSBDRU5TVVMnUyBPTkUgRElWRVJHRU5DRSwgUkVTT0xWRUQgVE9XQVJEXG4gKiBUSEUgQ09SUkVDVCBDT1BZLioqIFRocmVlIG9mIHRoZSBlaWdodCBkYWVtb25zIGNhcnJpZWQgaXQgYW5kIGZpdmUgZGlkIG5vdDtcbiAqIHRoZSBjZW5zdXMgZ3JhZGVkIHRoYXQgYHN0YWxlYCB3aXRoIHplcm8gZGVzaWduIGNvbnRlbnQuIEl0IGlzIGtlcHQgYmVjYXVzZVxuICogaXQgaXMgdGhlIHJpZ2h0IGFuc3dlciDigJQgYW4gSFRNTCBkb2N1bWVudCBzZXJ2ZWQgd2l0aCBubyBjaGFyc2V0IGlzIGRlY29kZWRcbiAqIGJ5IHRoZSBicm93c2VyJ3MgZ3Vlc3Mg4oCUIGFuZCBpdCBpcyB0aGUgb25lIHdpcmUtb2JzZXJ2YWJsZSBjaGFuZ2UgdGhpc1xuICogY29udmVyZ2VuY2UgbWFrZXMgdG8gYSByZXNwb25zZSBoZWFkZXIuIFJlY29yZGVkIGFzIEQtbm90ZSBpbiB0aGUgcGhhc2UgbG9nXG4gKiByYXRoZXIgdGhhbiBzbXVnZ2xlZC5cbiAqL1xuY29uc3QgU1RBVElDX0NPTlRFTlRfVFlQRVM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiLmh0bWxcIjogXCJ0ZXh0L2h0bWw7IGNoYXJzZXQ9dXRmLThcIixcbiAgXCIuanNcIjogXCJ0ZXh0L2phdmFzY3JpcHRcIixcbiAgXCIuY3NzXCI6IFwidGV4dC9jc3NcIixcbiAgXCIuanNvblwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbn07XG5cbi8qKiBUaGUgY29udGVudCB0eXBlIGZvciBhIGZpbGVuYW1lIG9yIGFuIGV4dGVuc2lvbi4gVW5rbm93biBleHRlbnNpb25zLCBhbmRcbiAqICBuYW1lcyB3aXRoIG5vIGV4dGVuc2lvbiBhdCBhbGwsIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb250ZW50VHlwZUZvcihuYW1lT3JFeHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGRvdCA9IG5hbWVPckV4dC5sYXN0SW5kZXhPZihcIi5cIik7XG4gIGNvbnN0IGV4dCA9IGRvdCA9PT0gLTEgPyBcIlwiIDogbmFtZU9yRXh0LnNsaWNlKGRvdCk7XG4gIHJldHVybiBTVEFUSUNfQ09OVEVOVF9UWVBFU1tleHRdID8/IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCI7XG59XG5cbi8qKlxuICogQW5zd2VyIE9ORSBmaWxlIGZyb20gYGRpc3REaXJgLCBvciBgbnVsbGAgaWYgdGhlIGNhbGxlciBzaG91bGQga2VlcCByb3V0aW5nLlxuICpcbiAqIGByZWxgIGlzIGEgYmFyZSBmaWxlbmFtZSDigJQgdGhlIGVudHJ5IGRvY3VtZW50IG9yIG9uZSBoYXNoZWQgY2h1bmsuIENvbnRyYWN0XG4gKiAyJ3MgYnVpbHQgc3VyZmFjZSBpcyBGTEFUIGFuZCBsaW5rcyBpdHMgY2h1bmtzIHJlbGF0aXZlbHksIHNvIGEgbGVnaXRpbWF0ZVxuICogYXNzZXQgcmVxdWVzdCBpcyBuZXZlciBuZXN0ZWQgYW5kIG5ldmVyIGNvbnRhaW5zIGAuLmA7IGJvdGggYXJlIHJlZnVzZWRcbiAqIGhlcmUgcmF0aGVyIHRoYW4gaW4gdGhlIHJvdXRlciwgYmVjYXVzZSB0aGUgZ3VhcmQgcHJvdGVjdHMgdGhlIHJlYWQgYW5kIHRoZVxuICogcmVhZCBpcyB3aGF0IGxpdmVzIGluIHRoaXMgZmlsZS5cbiAqXG4gKiDim5QgQU5EIGBleGlzdHNTeW5jYCBJUyBOTyBMT05HRVIgVEhFIFBFUk1JU1NJT04uIEEgZmlsZSB1bmRlciBgZGlzdERpcmAgaXNcbiAqIHNlcnZlZCBvbmx5IGlmIGl0IGlzIGluIGBzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXIpYCDigJQgd2hhdCB0aGUgYnVpbHRcbiAqIGBpbmRleC5odG1sYCB0cmFuc2l0aXZlbHkgTElOS1MuIGBkaXN0L2Agc3RvcHBlZCBiZWluZyBhIHN1cmZhY2UgZGlyZWN0b3J5XG4gKiB3aGVuIHRoZSBiYWNrZW5kIGNvbnZlcmdlbmNlIGJ1aWx0IHRoZSBkYWVtb25zIGludG8gaXQsIGFuZCB0aGUgZ3VhcmRzIGFib3ZlXG4gKiBkbyBub3QgZGlzdGluZ3Vpc2ggYGluZGV4LTxoYXNoPi5qc2AgZnJvbSBgc2VydmVyLmpzYC4gUmVhZCB0aGF0IGZ1bmN0aW9uJ3NcbiAqIGhlYWRlciBiZWZvcmUgdG91Y2hpbmcgdGhpcyBsaW5lOyB0aGUgd2hpdGVsaXN0IGlzIHRoZSBkZWZlbmNlLlxuICpcbiAqIOKaoCBUaGUgbmVzdGluZyByZWZ1c2FsIGlzIGFsc28gd2hhdCBrZWVwcyBhbiBhc3NldCBzZXJ2ZSBjbGVhciBvZiBhIHNwZWxsJ3NcbiAqIG93biByb3V0ZXM6IG1hZ3BpZSwgYm91bnR5LCBnbGFtb3VyIGFuZCBpbWFnbyBlYWNoIGhhdmUgYW4gYC9hc3NldHMvPG5hbWU+YFxuICogcm91dGUgb25lIGxldmVsIGRlZXAsIGFuZCB0aGlzIHJldHVybmluZyBgbnVsbGAgb24gYW55dGhpbmcgd2l0aCBhIHNsYXNoIGluXG4gKiBpdCBpcyB3aGF0IHN0b3BzIHRoZSB0d28gZmlnaHRpbmcuIFRoZSB3aGl0ZWxpc3QgZ292ZXJucyBgZGlzdC9gIHJlYWRzIE9OTFlcbiAqIOKAlCBpdCBuZXZlciBzZWVzIHRob3NlIHJvdXRlcyBhbmQgbXVzdCBuZXZlciBiZSB3aWRlbmVkIGludG8gdGhlbS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlcnZlRnJvbURpc3QoZGlzdERpcjogc3RyaW5nLCByZWw6IHN0cmluZyk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIGlmICghcmVsIHx8IHJlbC5pbmNsdWRlcyhcIi4uXCIpIHx8IHJlbC5pbmNsdWRlcyhcIi9cIikpIHJldHVybiBudWxsO1xuICBpZiAoIXN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcikuaGFzKHJlbCkpIHJldHVybiBudWxsO1xuICBjb25zdCBmaWxlID0gam9pbihkaXN0RGlyLCByZWwpO1xuICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIHJldHVybiBudWxsO1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKEJ1bi5maWxlKGZpbGUpLCB7IGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogY29udGVudFR5cGVGb3IocmVsKSB9IH0pO1xufVxuXG4vKiogYHNyY2AvYGhyZWZgIHZhbHVlcyBpbiBhIGJ1aWx0IGVudHJ5IGRvY3VtZW50LCBgLi9gLXByZWZpeGVkIG9yIGJhcmUuICovXG5jb25zdCBFTlRSWV9SRUZfUkUgPSAvKD86c3JjfGhyZWYpXFxzKj1cXHMqXCIoPzpcXC5cXC8pPyhbXlwiXSspXCIvZztcblxuLyoqIEEgYC4vYC1QUkVGSVhFRCBzaWJsaW5nIHNwZWNpZmllciDigJQgYFwiLi9uYW1lXCJgLCBgJy4vbmFtZSdgLCBgKC4vbmFtZSlgIOKAlCB3aGljaFxuICogIGlzIHRoZSBvbmx5IHNoYXBlIGEgYnVuZGxlciBlbWl0cyBmb3IgYSBzaWJsaW5nIGNodW5rLiBSZXF1aXJpbmcgdGhlIGAuL2AgaXNcbiAqICB3aGF0IGtlZXBzIGEgc3RyaW5nIGxpdGVyYWwgdGhhdCBtZXJlbHkgU0FZUyBgY2xpLmpzYCBvdXQgb2YgdGhlIHNldC4gKi9cbmNvbnN0IFJFTEFUSVZFX1JFRl9SRSA9IC9bXCInKF1cXC5cXC8oW15cIicoKVxcc10rKVtcIicpXS9nO1xuXG4vKiogT25seSB0ZXh0IHRoZSBidWlsZCBlbWl0cyBhcyBzdXJmYWNlIGNvZGUgaXMgc2Nhbm5lZCBmb3Igb253YXJkIHJlZmVyZW5jZXMuXG4gKiAgQSBgLnBuZ2AgaXMgYSBsZWFmOyBvcGVuaW5nIGl0IHdvdWxkIGJlIHJlYWRpbmcgYSBiaW5hcnkgZm9yIGZpbGVuYW1lcy4gKi9cbmNvbnN0IFRSQU5TSVRJVkVfRVhUUyA9IFtcIi5qc1wiLCBcIi5jc3NcIl07XG5cbi8qKiBPbmUgZGVyaXZhdGlvbiBwZXIgYGRpc3QvYCwgZm9yIHRoZSBsaWZlIG9mIHRoZSBwcm9jZXNzIOKAlCBgZGlzdC9gIGlzIGEgYnVpbGRcbiAqICBhcnRpZmFjdCBhbmQgZG9lcyBub3QgY2hhbmdlIHVuZGVyIGEgcnVubmluZyBkYWVtb24uIEtleWVkIGJ5IGRpcmVjdG9yeSBzb1xuICogIHR3byBkYWVtb25zIGluIG9uZSBwcm9jZXNzIChhbmQgZXZlcnkgdGVzdCB3aXRoIGl0cyBvd24gdGVtcCB0cmVlKSBzdGF5XG4gKiAgaW5kZXBlbmRlbnQuICovXG5jb25zdCB3aGl0ZWxpc3RDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBSZWFkb25seVNldDxzdHJpbmc+PigpO1xuXG5mdW5jdGlvbiByZWZzSW4odGV4dDogc3RyaW5nLCByZTogUmVnRXhwKTogc3RyaW5nW10ge1xuICByZXR1cm4gWy4uLnRleHQubWF0Y2hBbGwocmUpXVxuICAgIC5tYXAoKFssIHJlZl0pID0+IHJlZilcbiAgICAuZmlsdGVyKFxuICAgICAgKHJlZikgPT5cbiAgICAgICAgISFyZWYgJiZcbiAgICAgICAgIXJlZi5pbmNsdWRlcyhcIi9cIikgJiZcbiAgICAgICAgIXJlZi5pbmNsdWRlcyhcIi4uXCIpICYmXG4gICAgICAgICFyZWYuaW5jbHVkZXMoXCI6XCIpICYmXG4gICAgICAgICFyZWYuc3RhcnRzV2l0aChcIiNcIikgJiZcbiAgICAgICAgIXJlZi5zdGFydHNXaXRoKFwiP1wiKSxcbiAgICApO1xufVxuXG4vKipcbiAqIFRoZSBuYW1lcyB1bmRlciBgZGlzdERpcmAgYSBicm93c2VyIG1heSBmZXRjaDogdGhlIGVudHJ5IGRvY3VtZW50LCBwbHVzIHRoZVxuICogVFJBTlNJVElWRSBjbG9zdXJlIG9mIHdoYXQgaXQgbGlua3MuXG4gKlxuICog4puUICoqQSBXSElURUxJU1QsIEFORCBUSEUgTEVBSyBJVCBSRVBMQUNFRCBJUyBXSFkuKiogVW50aWwgdGhpcyBmaXggdGhlIGZpbGVcbiAqIGhhbGYgb2YgdGhpcyBtb2R1bGUgaGFkIGV4YWN0bHkgdGhyZWUgZ3VhcmRzIOKAlCBlbXB0eSwgYC4uYCwgbmVzdGVkIOKAlCBhbmRcbiAqIGBleGlzdHNTeW5jYCBkZWNpZGVkIHRoZSByZXN0LiBUaGF0IHdhcyBjb3JyZWN0IGZvciBhcyBsb25nIGFzIGBkaXN0L2AgaGVsZFxuICogb25seSBhIHN1cmZhY2UuIFRoZSBiYWNrZW5kIGNvbnZlcmdlbmNlIG1vdmVkIGV2ZXJ5IHNwZWxsJ3MgSU1QTEVNRU5UQVRJT05cbiAqIGludG8gdGhlIHNhbWUgZGlyZWN0b3J5LCBhbmQgdGhlIHNlcnZlIGRpZCB3aGF0IGl0IHdhcyB3cml0dGVuIHRvIGRvOlxuICpcbiAqICAgR0VUIC9jbGkuanMgICAgIDIwMCAgMjQyLDQzMSBCICB0ZXh0L2phdmFzY3JpcHQgICDihpAgYm91bnR5LCBieXRlLWlkZW50aWNhbFxuICogICBHRVQgL3NlcnZlci5qcyAgMjAwICAyNzYsNDE1IEIgIHRleHQvamF2YXNjcmlwdCAgICAgIHRvIHRoZSBjb21taXR0ZWRcbiAqICAgR0VUIC9qb2luLmpzICAgIDIwMCAgIDQ3LDM0OCBCICB0ZXh0L2phdmFzY3JpcHQgICAgICBhcnRpZmFjdHNcbiAqXG4gKiBhbmQgdGhvc2UgYnVuZGxlcyBhcmUgYnVpbHQgd2l0aCB0aGUgc291cmNlbWFwIEVNQkVEREVELCBzbyBlYWNoIG9uZSBjYXJyaWVzXG4gKiB0aGUgY29tcGxldGUgb3JpZ2luYWwgVHlwZVNjcmlwdC4gRml2ZSBzcGVsbHMg4oCUIGFzdHJvbGFiZSwgYm91bnR5LCBnbGFtb3VyLCBpbWFnbywgbWFncGllXG4gKiDigJQgZWxldmVuIGFydGlmYWN0cywgYWxsIHJlYWNoYWJsZSBieSBhbnkgYnJvd3NlciB0aGF0IGNhbiByZWFjaCB0aGUgZGFlbW9uLlxuICogRGlnZXN0aWZ5IGhpdCB0aGUgaWRlbnRpY2FsIGRlZmVjdCBvbmUgYnJhbmNoIGVhcmxpZXIgYW5kIGFuc3dlcmVkIGl0IGxvY2FsbHk7XG4gKiB0aGlzIGlzIHRoYXQgYW5zd2VyIHJlLWhvbWVkIHRvIHRoZSBvbmUgcGxhY2UgYWxsIGZpdmUgY2FsbGVycyBhbHJlYWR5IHNoYXJlLlxuICpcbiAqIOKblCAqKkRFUklWRUQsIE5PVCBFTlVNRVJBVEVELCBBTkQgTk9UIE1BVENIRUQgQlkgU0hBUEUuKiogQSBsaXRlcmFsIG5hbWUgbGlzdFxuICogaXMgd3JvbmcgYXQgdGhlIG5leHQgYnVpbGQgKHRoZSBjaHVua3MgY2FycnkgY29udGVudCBoYXNoZXMpLiBBIHNoYXBlIG1hdGNoXG4gKiAoYGluZGV4LTxoYXNoPi5qc2ApIGlzIHdyb25nIHRoZSBmaXJzdCB0aW1lIHRoZSBidW5kbGVyIHNwbGl0cyBhIGNodW5rLiBBc2tpbmdcbiAqIHRoZSBlbnRyeSBkb2N1bWVudCB3aGF0IGl0IGxvYWRzIGlzIHRoZSBvbmx5IGZvcm11bGF0aW9uIHRoYXQgaXMgdHJ1ZSBvZlxuICogd2hhdGV2ZXIgYGJ1biBydW4gYnVpbGRgIGFjdHVhbGx5IGVtaXR0ZWQuXG4gKlxuICog4puUICoqQU5EIFRIRSBDTE9TVVJFIElTIFRSQU5TSVRJVkUgRk9SIFRIRSBTQU1FIFJFQVNPTi4qKiBgaW5kZXguaHRtbGAgbGlua3NcbiAqIG9uZSBjaHVuayB0b2RheTsgYSBzcGxpdCBidWlsZCBoYXMgdGhhdCBjaHVuayBgaW1wb3J0IFwiLi9jaHVuay08aGFzaD4uanNcImAsXG4gKiB3aGljaCB0aGUgZW50cnkgZG9jdW1lbnQgbmV2ZXIgbmFtZXMuIFNvIGV2ZXJ5IGFkbWl0dGVkIGAuanNgL2AuY3NzYCBpcyBpdHNlbGZcbiAqIHNjYW5uZWQgZm9yIGAuL2AtcHJlZml4ZWQgc2libGluZ3MsIHVudGlsIHRoZSBzZXQgc3RvcHMgZ3Jvd2luZyDigJQgYSB3aGl0ZWxpc3RcbiAqIHRoYXQgcmVhZCBvbmx5IHRoZSBlbnRyeSB3b3VsZCA0MDQgYSBsZWdpdGltYXRlIGNodW5rIGluIHJlbGVhc2UsIGFuZCBvbmx5IGluXG4gKiByZWxlYXNlLlxuICpcbiAqIOKblCAqKk1FTUJFUlNISVAgSVMgQU4gRVhBQ1QgTUFUQ0gsIFdISUNIIE1BS0VTIFRIRSBSRUZVU0FMIENBU0UtSU5TRU5TSVRJVkUgQllcbiAqIENPTlNUUlVDVElPTi4qKiBBUEZTIGlzIGNhc2UtaW5zZW5zaXRpdmUsIHNvIGAvSU5ERVguSFRNTGAgYW5kIGAvaU5kRXguSHRNbGBcbiAqIHJlc29sdmUgdG8gdGhlIHNhbWUgaW5vZGUgYSBjYXNlLXNlbnNpdGl2ZSBibGFja2xpc3Qgd291bGQgbWlzcyAobWVhc3VyZWQgb25cbiAqIGFsbCBmaXZlIHNwZWxscyBiZWZvcmUgdGhpcyBmaXg6IGZvdXIgdmFyaWFudHMsIGZvdXIgMjAwcywgdGhyZWUgb2YgdGhlbSBhc1xuICogYGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbWAgYmVjYXVzZSB0aGUgY29udGVudC10eXBlIGxvb2t1cCBpcyBjYXNlLXNlbnNpdGl2ZVxuICogdG9vKS4gQSBzZXQgb2YgZXhhY3RseSB0aGUgZW1pdHRlZCBuYW1lcyByZWZ1c2VzIGV2ZXJ5IHZhcmlhbnQgb2YgZXZlcnkgbmFtZVxuICog4oCUIHNlcnZhYmxlIG9yIG5vdCDigJQgd2l0aCBubyBsb3dlci1jYXNlIHBhc3MgYW55d2hlcmUuXG4gKlxuICog4pqgICoqVEhFIFRSQURFOioqIGEgZmlsZSB0aGUgZW50cnkgZ3JhcGggZG9lcyBub3QgcmVmZXJlbmNlIOKAlCBhIGxhemlseSBmZXRjaGVkXG4gKiBjaHVuaywgYSBmb250IHB1bGxlZCBieSBhIENTUyBgdXJsKClgIHRoaXMgc2NhbiBkb2VzIG5vdCBtb2RlbCwgYW4gYXNzZXQgdGhlXG4gKiBidWlsZCBlbWl0cyBidXQgbm90aGluZyBsaW5rcyDigJQgNDA0cyBpbiByZWxlYXNlIHdpdGggbm90aGluZyByZWQuIEVhY2hcbiAqIGFkb3B0ZXIncyBgcmVsZWFzZS1zZXJ2ZS50ZXN0LnRzYCBob2xkcyB0aGUgaW5zdHJ1bWVudDogYW4gSU5WRU5UT1JZIGNlbGwgdGhhdFxuICogYWNjb3VudHMgZm9yIGV2ZXJ5IGZpbGUgaW4gYGRpc3QvYCBhcyBzZXJ2ZWQgb3IgZGVsaWJlcmF0ZWx5IHJlZnVzZWQsIHNvIGFuXG4gKiB1bmxpbmtlZCBlbWlzc2lvbiBnb2VzIHJlZCBhdCBidWlsZCB0aW1lIHJhdGhlciB0aGFuIHNpbGVudCBhdCBydW50aW1lLlxuICpcbiAqIOKaoCBUaGUgZW50cnkgZG9jdW1lbnQgaXMgSU4gdGhlIHNldCwgYmVjYXVzZSB0aGUgaG91c2UgY2FsbGVyIG1hcHMgYC9gIHRvXG4gKiBgaW5kZXguaHRtbGAgYW5kIHRoYXQgaXMgdGhlIHN1cmZhY2UuIEEgc3BlbGwgdGhhdCBtdXN0IG5ldmVyIGhhbmQgb3ZlciBpdHNcbiAqIG9uLWRpc2sgZW50cnkg4oCUIGRpZ2VzdGlmeSBzdWJzdGl0dXRlcyBhIHBheWxvYWQgaW50byBpdCBpbiBtZW1vcnkg4oCUIHJlZnVzZXNcbiAqIHRoYXQgT05FIG5hbWUgaW4gaXRzIG93biByb3V0ZXIsIGFib3ZlIHRoaXMgY2FsbC4gVGhhdCByZWZ1c2FsIGlzIHRoZSBzcGVsbCdzO1xuICogZXZlcnl0aGluZyBlbHNlIGhlcmUgaXMgdGhlIGtpdCdzLlxuICovXG5mdW5jdGlvbiBzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXI6IHN0cmluZyk6IFJlYWRvbmx5U2V0PHN0cmluZz4ge1xuICBjb25zdCBjYWNoZWQgPSB3aGl0ZWxpc3RDYWNoZS5nZXQoZGlzdERpcik7XG4gIGlmIChjYWNoZWQpIHJldHVybiBjYWNoZWQ7XG5cbiAgY29uc3QgbmFtZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgZW50cnkgPSBqb2luKGRpc3REaXIsIFwiaW5kZXguaHRtbFwiKTtcbiAgaWYgKGV4aXN0c1N5bmMoZW50cnkpKSB7XG4gICAgbmFtZXMuYWRkKFwiaW5kZXguaHRtbFwiKTtcbiAgICBjb25zdCBodG1sID0gcmVhZEZpbGVTeW5jKGVudHJ5LCBcInV0ZjhcIik7XG4gICAgY29uc3QgcGVuZGluZyA9IFsuLi5yZWZzSW4oaHRtbCwgRU5UUllfUkVGX1JFKSwgLi4ucmVmc0luKGh0bWwsIFJFTEFUSVZFX1JFRl9SRSldO1xuICAgIC8vIFVudGlsIHRoZSBzZXQgc3RvcHMgZ3Jvd2luZzogZWFjaCBhZG1pdHRlZCBjaHVuayBtYXkgbmFtZSB0aGUgbmV4dCBvbmUuXG4gICAgd2hpbGUgKHBlbmRpbmcubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgbmFtZSA9IHBlbmRpbmcucG9wKCkgYXMgc3RyaW5nO1xuICAgICAgaWYgKG5hbWVzLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgICAvLyDimqAgUkVGRVJFTkNFRCAqKkFORCoqIFBSRVNFTlQuIEEgbWluaWZpZWQgYnVuZGxlIGNhbiBjb250YWluIGEgc3RyaW5nXG4gICAgICAvLyB0aGF0IG1lcmVseSBMT09LUyBsaWtlIG9uZTsgYWRtaXR0aW5nIG9ubHkgbmFtZXMgdGhhdFxuICAgICAgLy8gYXJlIGFjdHVhbGx5IG9uIGRpc2sga2VlcHMgdGhlIHNjYW4gZnJvbSB3aWRlbmluZyB0aGUgc2V0IG9uIGFcbiAgICAgIC8vIGNvaW5jaWRlbmNlLCBhbmQgYSBuYW1lIHRoYXQgaXMgYWJzZW50IDQwNHMgaWRlbnRpY2FsbHkgZWl0aGVyIHdheS5cbiAgICAgIGNvbnN0IGZpbGUgPSBqb2luKGRpc3REaXIsIG5hbWUpO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKGZpbGUpKSBjb250aW51ZTtcbiAgICAgIG5hbWVzLmFkZChuYW1lKTtcbiAgICAgIGlmICghVFJBTlNJVElWRV9FWFRTLnNvbWUoKGV4dCkgPT4gbmFtZS5lbmRzV2l0aChleHQpKSkgY29udGludWU7XG4gICAgICBwZW5kaW5nLnB1c2goLi4ucmVmc0luKHJlYWRGaWxlU3luYyhmaWxlLCBcInV0ZjhcIiksIFJFTEFUSVZFX1JFRl9SRSkpO1xuICAgIH1cbiAgfVxuXG4gIHdoaXRlbGlzdENhY2hlLnNldChkaXN0RGlyLCBuYW1lcyk7XG4gIHJldHVybiBuYW1lcztcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgc2VydmVyIHNpZGUgb2YgdGhlIFNTRSB0YWlsIOKAlCB0aGUgZGFlbW9uLXNpZGUgdHdpbiBvZlxuICogYHRhaWxFdmVudHMudHNgLiBUaGF0IG1vZHVsZSBkZWNpZGVzIHdoYXQgYSBjYWxsZXIgb2JzZXJ2ZXM7IHRoaXMgb25lIGRlY2lkZXNcbiAqIHdoYXQgYSBjYWxsZXIgaXMgc2VudC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBleGNlcHQgaXRzXG4gKiBvd24gc2libGluZyB0eXBlcywgd2hpY2ggaXMgc3RpbGwgaW5zaWRlIHRoZSBsZWFmLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzIGBzc2VSZXNwb25zZWAsXG4gKiB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMxOiB0aGUgb25seSBvbmUgb2YgdGhlIHNldmVuIHdpdGggYVxuICogb25jZS1vbmx5IHRlYXJkb3duIGZ1bm5lbCwgdGhlIG9ubHkgb25lIHdpcmVkIHRvIGByZXEuc2lnbmFsYCwgYW5kIHRoZSBvbmx5XG4gKiBvbmUgd2hvc2UgY29tbWVudCByZWNvcmRzIGEgTUVBU1VSRUQgcmVzdWx0IHJhdGhlciB0aGFuIGEgYmVsaWVmLlxuICpcbiAqIOKUgOKUgCDim5QgQU5EIFdIQVQgVEhFIENPUFkgTEVGVCBCRUhJTkQsIFNBSUQgSEVSRSBCRUNBVVNFIEEgTE9TUyBSRUNPUkRFRCBPTkxZIElOXG4gKiAgICBBIFBPUlQnUyBKT1VSTkFMIEdFVFMgUkUtTElUSUdBVEVEIEJZIEVWRVJZIFNQRUxMIEFGVEVSIElUIChENzkvRDg1KSDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgc2VudGVuY2UgYWJvdmUgbmFtZXMgYSBTT1VSQ0UgdGhpcyBtb2R1bGUgaGFkIG5ldmVyIGJlZW4gY2hlY2tlZCBhZ2FpbnN0OlxuICogRDEgcnVsZWQgdGhlIHNwaW5lIGJlIHByb3ZlbiBvbiB0aGUgdHdvIHNwZWxscyB0aGF0IGFscmVhZHkgYnVpbHQsIGFuZCBib3RoIG9mXG4gKiB0aG9zZSBhcmUgZG93bnN0cmVhbSBGT1JLUyBvZiB0aGUgbWluZC1tYXBwZXIgbGluZSwgc28gdGhlIGJvdW5kYXJpZXMgd2VyZVxuICogc2V0dGxlZCBhZ2FpbnN0IHR3byBjb3BpZXMgd2hpbGUgdGhlIG9yaWdpbmFsIHdhcyBub3QgaW4gdGhlIHJvb20uICoqQVxuICogY29udmVyZ2VuY2UgY2FuIG5hbWUgaXRzIHNvdXJjZSBhbmQgc3RpbGwgbmV2ZXIgY29uc3VsdCBpdC4qKlxuICpcbiAqIFdoZW4gaXQgd2FzIGZpbmFsbHkgY29uc3VsdGVkIChQaGFzZSA3LCB0aGUgbGFzdCBwb3J0KSwgZXhhY3RseSBPTkUgcHJvcGVydHlcbiAqIG9mIHRoZSBzb3VyY2Ugd2FzIG1pc3NpbmcgaGVyZSwgYW5kIGl0IG9jY3VwaWVkIG5vIHR5cGU6ICoqbWluZC1tYXBwZXIgd3JvdGVcbiAqIGl0cyBgdGFpbCAtLWluYm91bmRgIGdyb3VuZGluZyBmcmFtZSBCRUZPUkUgdGhlIHJlcGxheSoqIOKAlCBvbmUgbGluZSBhYm92ZVxuICogYGJ1cy5zdWJzY3JpYmVgIOKAlCBzbyBpdCB3YXMgdGhlIHN0cmVhbSdzIGZpcnN0IGRhdGEgbGluZS4gYG9uT3BlbmAgZmlyZXMgYXRcbiAqIHRoZSBFTkQgb2YgYHN0YXJ0YCwgYWZ0ZXIgdGhlIHByZWFtYmxlLCBhZnRlciBgbG9nLnN1YnNjcmliZWAsIGFmdGVyXG4gKiBgY2xpZW50cy5hZGRgLCBzbyBhIGNhbGxlciB0aGF0IHN1cHBsaWVkIGl0cyBvd24gYGNsaWVudHNgIHNldCBhbmQgc2VudCBmcm9tXG4gKiB0aGVyZSB3b3VsZCBsYW5kIHRoZSBmcmFtZSBBRlRFUiB0aGUgcmVwbGF5ZWQgYmFja2xvZy4gVGhhdCBpcyBFWFBSRVNTSUJMRSxcbiAqIHdoaWNoIGlzIHdoYXQgbWFrZXMgdGhpcyBhIG1lYXN1cmVtZW50IHJhdGhlciB0aGFuIGFuIGFzc2VydGlvbjogdGhlXG4gKiBwbGF5Ym9vaydzIHR5cGUtdG8tdHlwZSBjb21wYXRpYmlsaXR5IHByb2NlZHVyZSBhbnN3ZXJzIFwicmVwcmVzZW50YWJsZVwiIGhlcmVcbiAqICh0aGUgc3ViamVjdCB0eXBlIGlzIGBTZXQ8U3NlQ2xpZW50PmAsIHRoZSBzcGVsbCBrZWVwcyBubyByZWdpc3RyeSwgc28geW91XG4gKiBwYXNzIGFuIGVtcHR5IHNldCkgYW5kIGEgdHlwZSBjaGVjayBjYW5ub3Qgc2VlIGEgUE9TSVRJT04uXG4gKlxuICogKipUaGUgZGlzcG9zaXRpb24gd2FzIFJFU1RPUkUsIG5vdCBLRUVQLUxPQ0FMIGFuZCBub3QgRklMRSoqIOKAlCBzZWVcbiAqIGBvcGVuRnJhbWVzYCBiZWxvdywgd2hlcmUgdGhlIHR3byBudW1iZXJzIHRoYXQgcGVybWl0IGl0IGFyZSByZWNvcmRlZCBhbmRcbiAqIGRyaXZlbi4gVGhlIGdlbmVyYWxpc2F0aW9uLCB3aGljaCBpcyB0aGUgcGFydCB3b3J0aCBjYXJyeWluZzogd2hlcmUgYVxuICogbW9kdWxlJ3Mgc3ViamVjdCBpcyBhIFNFUVVFTkNFIE9GIFdSSVRFUywgY29tcGFyZSB0aGUgT1JERVIgb2YgaXRzIGhvb2tzXG4gKiBhZ2FpbnN0IHRoZSBvcmRlciB0aGUgYWRvcHRpbmcgc3BlbGwgd3JpdGVzIGluLiBUd28gaG9va3Mgd2l0aCB0aGUgcmlnaHRcbiAqIHNpZ25hdHVyZXMgaW4gdGhlIHdyb25nIG9yZGVyIGFyZSBhcyBpbmNvbXBhdGlibGUgYXMgdHdvIHR5cGVzIHRoYXQgd2lsbCBub3RcbiAqIHVuaWZ5LCBhbmQgb25seSBvbmUgb2YgdGhlIHR3byBjYW4gYmUgU0VFTiBieSBhIGNvbXBhdGliaWxpdHkgY2hlY2suXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqICAgIENMSUVOVC4gTUVBU1VSRUQgT04gQlVOIDEuMy4xNCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBTaXggZGFlbW9ucyB3cml0ZSBhIGhlYXJ0YmVhdCBhcyBgdHJ5IHsgY29udHJvbGxlci5lbnF1ZXVlKC4uLikgfSBjYXRjaCB7fWBcbiAqIHdpdGggYSBjb21tZW50IHNheWluZyB0aGUgY2F0Y2ggaXMgaG93IGEgZGVwYXJ0ZWQgY2xpZW50IGlzIG5vdGljZWQuIEl0IGlzXG4gKiBub3Q6IGVucXVldWUgb24gYW4gb3JwaGFuZWQgc3RyZWFtIEJVRkZFUlMgU0lMRU5UTFkgYW5kIG5ldmVyIHRocm93cywgc28gdGhlXG4gKiBjYXRjaCBuZXZlciBmaXJlcyBhbmQgdGhvc2UgZGFlbW9ucycgZGVhZC1jbGllbnQgZGV0ZWN0aW9uIHJlc3RzIG9uIGFcbiAqIG1lY2hhbmlzbSB0aGVpciBvd24gY29tbWVudHMgZGVzY3JpYmUgaW5jb3JyZWN0bHkuIFdoYXQgYWN0dWFsbHkgcmVjbGFpbXMgdGhlXG4gKiBjb25uZWN0aW9uIGlzIHRoZSBzdHJlYW0ncyBgY2FuY2VsKClgIOKAlCBhbmQsIGZvciBhIGNsaWVudCB0aGF0IG5ldmVyIGNsb3Nlc1xuICogdGhlIHNvY2tldCwgYHJlcS5zaWduYWxgLlxuICpcbiAqIFNvIHRoZSBmdW5uZWwgYmVsb3cgaXMgdGhlIGxvYWQtYmVhcmluZyBwYXJ0LiBgdGVhcmRvd24oKWAgcnVucyBBVCBNT1NUIE9OQ0VcbiAqIGZyb20gZXZlcnkgcGF0aCB0aGVyZSBpcyDigJQgYGNhbmNlbCgpYCwgYW4gYWJvcnQgb24gdGhlIHJlcXVlc3Qgc2lnbmFsLCBhbmRcbiAqIHRoZSBiZWx0LWFuZC1icmFjZXMgZW5xdWV1ZSBjYXRjaCDigJQgYW5kIGl0IGlzIHdoZXJlIHRoZSBzdWJzY3JpYmVyIGNvdW50IGFuZFxuICogYW55IHByZXNlbmNlIGRlY3JlbWVudCByaWRlLiBCb3VuZGluZyBwcmVzZW5jZSBhY2N1cmFjeSBpcyBib3VuZGluZyB0aGF0XG4gKiBmdW5uZWwuXG4gKlxuICog4pqgIEtub3duIGhvbGUsIGFjY2VwdGVkIGFuZCBpbmhlcml0ZWQ6IEJ1bidzIG93biBgZmV0Y2goKWAgcmVhZGVyIGAuY2FuY2VsKClgXG4gKiBjbG9zZXMgbm90aGluZyBjbGllbnQtc2lkZSBhbmQgdGhlIHNlcnZlciBjYW5ub3Qgc2VlIGl0LiBSZWFsIGNsaWVudHMgY2xvc2VcbiAqIHRoZSBzb2NrZXQuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgRE9FUyBOT1QgQURPUFQgVEhJUywgQU5EIFRIRSBSRUZVU0FMIElTIFBBUlQgT0YgVEhFIFJVTElORyDilIDilIBcbiAqXG4gKiBSRUpFQ1QtU1RSVUNUVVJBTCwgcnVsZWQgYXQgZ3JhcGV2aW5lJ3MgcG9ydCAoUGhhc2UgNiwgMjAyNi0wOS0wOTsgRDY4KS5cbiAqIEdyYXBldmluZSBIQVMgYW4gU1NFIHJlZ2lzdHJ5IGFuZCBpdCBpcyB0aGUgYnVzaWVzdCB0aGluZyBpbiB0aGUgc3BlbGw7IHRoZVxuICogdHdvIHR5cGVzIHNpbXBseSBjYW5ub3QgYmUgY29uc3RydWN0ZWQgZnJvbSBlYWNoIG90aGVyOlxuICpcbiAqICAgdGhpcyBtb2R1bGUgIGBTc2VDbGllbnRzID0gU2V0PFNzZUNsaWVudD5gIHdoZXJlIGBTc2VDbGllbnQgPSB7Y2xvc2UsIHNlbmR9YFxuICogICAgICAgICAgICAgICAg4oCUIGEgcmVnaXN0cnkgb2YgQU5PTllNT1VTIGNsb3NlcnMsIGFuZCBgc2l6ZWAgaXMgdGhlIG9ubHkgdGhpbmdcbiAqICAgICAgICAgICAgICAgIGFueSBhZG9wdGluZyBkYWVtb24gcmVhZHMgb2ZmIGl0LlxuICogICBncmFwZXZpbmUgICAgYE1hcDxzeW1ib2wsIHthbGlhcywgaHVtYW4sIGx1cmssIHNlbmR9PmAsIHBlciBjaGFubmVsLlxuICpcbiAqICoqVGhlIHJlYWRlcnMgdGhhdCBtYWtlIHRoZW0gaW5jb21wYXRpYmxlLCBjb3VudGVkIHJhdGhlciB0aGFuIGFzc2VydGVkOiBTSVhcbiAqIHJvdXRlcyByZWFkIGBhbGlhc2AvYGh1bWFuYC9gbHVya2AqKiDigJQgYEdFVCAvY2hhbm5lbHNgICh0aHJvdWdoXG4gKiBgbGlzdENoYW5uZWxzYCDihpIgYHZpc2libGVTdWJzYCksIGBHRVQgL3ByZXNlbmNlYCwgYFBPU1QgL2NoYW5uZWxzYCxcbiAqIGBQT1NUIC9hbm5vdW5jZWAsIGBQT1NUIC9jaGFubmVscy86bmFtZS9tZXNzYWdlc2AsIGFuZFxuICogYEdFVCAvY2hhbm5lbHMvOm5hbWUvc3Vic2NyaWJlcnNgLiBgYWxpYXNgIGlzIGEgbmFtZSBhIGh1bWFuIHNlZXMgaW4gYSByb3N0ZXIsXG4gKiBgaHVtYW5gIHRlbGxzIGFuIGFnZW50IGl0IGlzIHRhbGtpbmcgdG8gYSBwZXJzb24sIGFuZCBgbHVya2AgZXhjbHVkZXMgYVxuICogY29ubmVjdGlvbiBmcm9tIGV2ZXJ5IHByZXNlbmNlIGNvdW50LiBUaGVyZSBpcyBubyB3YXkgdG8gcHV0IGFueSBvZiB0aGF0IGludG9cbiAqIGEgc2V0IG9mIGNsb3NlcnMuIEFkb3B0aW5nIHRoaXMgbW9kdWxlIHdvdWxkIG5vdCBiZSBkZWFkIGNvZGU7IGl0IHdvdWxkIGJlIGFcbiAqIHJld3JpdGUgb2Ygd2hhdCBncmFwZXZpbmUgSVMuXG4gKlxuICog4pqgICoqQU5EIFRIRSBMSVNUIElTIERFTElCRVJBVEVMWSBOT1QgVEhFIE9CVklPVVMgT05FLioqIFRoZSBwb3J0J3MgZmlyc3RcbiAqIGNvdW50IG5hbWVkIHRoZSBgcm9sbGAvY2xlYXIgYnJvYWRjYXN0LCB0aGUgYXJjaGl2ZSBsaXZlLWd1YXJkIGFuZCB0d29cbiAqIFJFR0lTVFJBVElPTlMg4oCUIGFuZCBldmVyeSBvbmUgb2YgdGhvc2UgaXMgYSBzaXRlIHRoaXMgbW9kdWxlJ3MgdHlwZSB3b3VsZFxuICogc2VydmUgcGVyZmVjdGx5OiB0aGUgYnJvYWRjYXN0IHJlYWRzIG9ubHkgYHMuc2VuZGAsIHRoZSBsaXZlLWd1YXJkIG9ubHlcbiAqIGBzdWJzY3JpYmVycy5zaXplYCAod2hpY2ggdGhpcyBoZWFkZXIgaXRzZWxmIHNheXMgaXMgYWxsIGFueSBhZG9wdGVyIHJlYWRzKSxcbiAqIGFuZCBhIHJlZ2lzdHJhdGlvbiBXUklURVMgdGhlIHJlY29yZCByYXRoZXIgdGhhbiByZWFkaW5nIGl0LiBUaGUgc2l4IGFib3ZlIGFyZVxuICogdGhlIG9uZXMgdGhhdCByZWFkIGEgZmllbGQgdGhlIGtpdCdzIGBTc2VDbGllbnRgIGRvZXMgbm90IGhhdmU7IHRoZSB3cml0ZXJzXG4gKiAoYC93YWl0YCdzIHByZXNlbmNlIHJlZ2lzdHJhdGlvbiBhbmQgdGhlIHRhaWwncykgYXJlIG5hbWVkIHNlcGFyYXRlbHkgYmVjYXVzZVxuICogYSB3cml0ZXIgaXMgbm90IGV2aWRlbmNlIG9mIGFueXRoaW5nLiBDb3VudGVkIGluIHRoZSBwcmUtcG9ydCBkYWVtb24sXG4gKiBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dyYXBldmluZS9zY3JpcHRzL2RhZW1vbi50c2Agb24gYGRldmVsb3BgOlxuICogbC40MjEsIDczOS03NDcsIDgyNiwgODg2LTg4NywgMTA0OS0xMDU0LCAxMTgyLTExODgg4oCUIHdyaXRlcnMgYXQgMTExMS0xMTEyIGFuZFxuICogMTMwNy4gKENvcnJlY3RlZCAyMDI2LTA5LTA5IGluIHRoZSByZXBhaXIgY2hhcHRlcjsgRDY4J3MgcmVxdWlyZW1lbnQgaXMgdGhhdFxuICogdGhlIHJlZnVzYWwgYmUgd3JpdHRlbiB3aGVyZSB0aGUgbmV4dCByZWFkZXIgbWVldHMgaXQsIHdoaWNoIG1ha2VzIGFcbiAqIG1pcy1tZWFzdXJlZCBsaXN0IHdvcnNlIHRoYW4gbm9uZS4pXG4gKlxuICog4pqgIEFuZCBncmFwZXZpbmUncyByZWNvcmRzIGNhcnJ5IG5vIGBjbG9zZWAgYXQgYWxsIOKAlCB0aGUgcGVyLXN0cmVhbSB0ZWFyZG93biBpc1xuICogYSBjbG9zdXJlIHN0YXNoZWQgb24gdGhlIFJlYWRhYmxlU3RyZWFtIGNvbnRyb2xsZXIsIHJlYWNoYWJsZSBvbmx5IGZyb21cbiAqIGBjYW5jZWwoKWAg4oCUIHdoaWNoIGlzIGFsc28gd2h5IGBob3VzZWtlZXBpbmdgJ3MgYGRyYWluQW5kU3RvcGAgaXMgYWRvcHRlZFxuICogdGhlcmUgd2l0aCBpdHMgYGNsaWVudHNgIGFyZ3VtZW50IGRlbGliZXJhdGVseSBlbXB0eS5cbiAqXG4gKiAqKlRoZSB3aWRlbmluZyBOT1QgZG9uZSwgd2l0aCBpdHMgY29zdDoqKiBhZG1pdHRpbmcgYW4gYWxpYXMtYmVhcmluZyByZWNvcmRcbiAqIHdvdWxkIGNoYW5nZSB0aGUgdHlwZSBmaXZlIG90aGVyIGRhZW1vbnMgY29tcGlsZSBhZ2FpbnN0IGFuZCByZS1lbWl0IFNJWFxuICogYXJ0aWZhY3RzIGFjcm9zcyBGSVZFIHNwZWxscywgZWFjaCBvd2VkIGEgZHJpdmUuIEl0IHdvdWxkIGFsc28gcmUtY3JlYXRlIHRoZVxuICogdGhpbmcgdGhpcyByZWdpc3RyeSBleGlzdHMgdG8gc3RvcCwgYW5kIHRoaXMgZmlsZSdzIG93biBib3VuZGFyeSBwYXJhZ3JhcGhcbiAqIHNheXMgaG93OiBhIHNpZ25hdHVyZSB3aWRlIGVub3VnaCB0byBhYnNvcmIgZXZlcnkgY2FsbGVyJ3Mgc2hhcGUgc3RvcHMgYmVpbmcgYVxuICogcmVnaXN0cnkgYW5kIGJlY29tZXMgYSB1bmlvbi4gVGhlIGNlbnN1cyBjb252ZXJnZWQgY29waWVzIGludG8gb25lIG1vZHVsZSBieVxuICogZmluZGluZyB3aGF0IHRoZXkgU0hBUkVEOyBhIG1vZHVsZSB3aWRlbmVkIHRvIGZpdCB0aGUgb25lIHNwZWxsIHRoYXQgc2hhcmVzXG4gKiBub3RoaW5nIGlzIHRob3NlIGNvcGllcyBhZ2FpbiB3aXRoIGEgdW5pb24gdHlwZSBvdmVyIHRoZSB0b3AuIFRoZSBzcGVsbCBrZWVwc1xuICogaXRzIG93biwgYW5kIGEgd2lkZW5pbmcgcmVtYWlucyBhIHNlcGFyYXRlLCBhcmd1ZWQgZGVjaXNpb24uXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFdmVudExvZywgRnJhbWUgfSBmcm9tIFwiLi9ldmVudExvZy50c1wiO1xuXG4vKipcbiAqIE9uZSBvcGVuIFNTRSBzdHJlYW0sIGFzIHRoZSBkYWVtb24gY2FuIGFjdCBvbiBpdDogZW5kIGl0LCBvciBwdXNoIGEgZnJhbWUgdG9cbiAqIGl0IHRoYXQgZGlkIG5vdCBjb21lIG91dCBvZiB0aGUgbG9nLlxuICpcbiAqIOKblCBJVCBJUyBOT1QgQSBDT05UUk9MTEVSLiBUaGUgY29waWVzIGhlbGRcbiAqIGBTZXQ8UmVhZGFibGVTdHJlYW1EZWZhdWx0Q29udHJvbGxlcj5gIGFuZCBjbG9zZWQgdGhlbSBkaXJlY3RseSBhdCB0ZWFyZG93bixcbiAqIHdoaWNoIGJ5cGFzc2VzIHRoZSB0ZWFyZG93biBmdW5uZWwgYWJvdmUg4oCUIHRoZSBoZWFydGJlYXQgaW50ZXJ2YWwgZm9yIHRoYXRcbiAqIHN0cmVhbSB3YXMgY2xlYXJlZCBvbmx5IGJlY2F1c2UgYSBzZWNvbmQgYFNldGAgb2YgdGltZXJzIHdhcyBrZXB0IGluIHBhcmFsbGVsXG4gKiBhbmQgc3dlcHQgc2VwYXJhdGVseS4gRXZlcnl0aGluZyBoZXJlIGdvZXMgdGhyb3VnaCB0aGUgZnVubmVsLCBhbmQgYSBgc2VuZGBcbiAqIGFmdGVyIHRlYXJkb3duIGlzIGEgbm8tb3AgcmF0aGVyIHRoYW4gYSB0aHJvdy5cbiAqXG4gKiDimqAgKipgc2VuZGAgQVJSSVZFRCBJTiBQSEFTRSAyLCBGUk9NIFRIRSBGSVJTVCBDT05TVU1FUiBUSEFUIFdBUyBOT1QgT05FIE9GIFRIRVxuICogVFdPIFRISVMgTU9EVUxFIFdBUyBERVNJR05FRCBBR0FJTlNULioqIGFzdHJvbGFiZSBhbmQgbWFncGllIGFubm91bmNlIHByZXNlbmNlXG4gKiBvdmVyIHRoZWlyIGJyb3dzZXIgV0VCU09DS0VULCBzbyBhIHJlZ2lzdHJ5IG9mIGJhcmUgY2xvc2VycyB3YXMgc3VmZmljaWVudCBhbmRcbiAqIHRoZSBib3VuZGFyeSBsb29rZWQgcmlnaHQuIGdsYW1vdXIgYW5ub3VuY2VzIGl0IG9uIHRoZSBBR0VOVCdzIFNTRSB0YWlsIOKAlFxuICogYHt0eXBlOlwiY29ubmVjdGVkXCJ9YCAvIGB7dHlwZTpcImRpc2Nvbm5lY3RlZFwifWAsIGRlbGliZXJhdGVseSB1bmxvZ2dlZCwgc28gYVxuICogcmVjb25uZWN0aW5nIGFnZW50IGRvZXMgbm90IHJlLXNlZSBldmVyeSBwYXN0IGNvbm5lY3QgYW5kIHNvIHRoZSBmcmFtZSBuZXZlclxuICogYWR2YW5jZXMgYSB0YWlsIGN1cnNvci4gVGhhdCBpcyBub3QgYSBnbGFtb3VyIHF1aXJrOyBpdCBpcyB0aGUgZ2VuZXJhbCBzaGFwZVxuICogb2YgXCJ0ZWxsIHRoZSBsaXZlIHN1YnNjcmliZXJzIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBwYXJ0IG9mIHRoZSBoaXN0b3J5XCIsIGFuZFxuICogYSByZWdpc3RyeSB0aGF0IGNhbiBvbmx5IEVORCBhIHN0cmVhbSBjYW5ub3QgZXhwcmVzcyBpdC4gV2l0aG91dCB0aGlzIHRoZVxuICogc3BlbGwgd291bGQgaGF2ZSBoYWQgdG8ga2VlcCBpdHMgb3duIHBhcmFsbGVsIGBTZXRgIG9mIGNvbnRyb2xsZXJzLCB3aGljaCBpc1xuICogZXhhY3RseSB0aGUgZHJpZnQgdGhpcyByZWdpc3RyeSBleGlzdHMgdG8gcmVtb3ZlLlxuICovXG5leHBvcnQgdHlwZSBTc2VDbGllbnQgPSB7XG4gIC8qKiBFbmQgdGhpcyBzdHJlYW0sIHRocm91Z2ggdGhlIHRlYXJkb3duIGZ1bm5lbCwgYXQgbW9zdCBvbmNlLiAqL1xuICBjbG9zZSgpOiB2b2lkO1xuICAvKiogV3JpdGUgb25lIHJhdyBTU0UgY2h1bmsgdG8gdGhpcyBzdHJlYW0uIE5vLW9wIG9uY2UgdG9ybiBkb3duLiAqL1xuICBzZW5kKGNodW5rOiBzdHJpbmcpOiB2b2lkO1xufTtcblxuLyoqXG4gKiBUaGUgbGl2ZS10YWlsIHJlZ2lzdHJ5LiBgc2l6ZWAgaXMgdGhlIGRhZW1vbidzIFNTRSBzdWJzY3JpYmVyIGNvdW50IOKAlCB0aGVcbiAqIG51bWJlciBgc2hvdWxkSWRsZUNsb3NlYCBtdXN0IHNlZSDigJQgYW5kIGNsb3NpbmcgZXZlcnkgZW50cnkgaXMgd2hhdCBhIGRyYWluXG4gKiBkb2VzLlxuICovXG5leHBvcnQgdHlwZSBTc2VDbGllbnRzID0gU2V0PFNzZUNsaWVudD47XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3NlT3B0aW9uczxUIGV4dGVuZHMgb2JqZWN0PiB7XG4gIC8qKiBUaGUgbG9nIHRvIHJlcGxheSBmcm9tIGFuZCBzdWJzY3JpYmUgdG8uICovXG4gIGxvZzogRXZlbnRMb2c8VD47XG4gIC8qKiBUaGUgY2FsbGVyJ3MgcmVzdW1lIGN1cnNvci4gQWJzZW50IG9yIHVucGFyc2VhYmxlIHJlcGxheXMgZnJvbSB0aGUgc3RhcnQuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBIZWFydGJlYXQgY29tbWVudCBpbnRlcnZhbC4gTVVTVCBzdGF5IHdlbGwgdW5kZXIgdGhlIHNlcnZlcidzXG4gICAqICBgaWRsZVRpbWVvdXRgIOKAlCBzZWUgYGhlYXJ0YmVhdC50c2AsIHdoaWNoIGlzIHdoZXJlIHRoYXQgcGFpciBsaXZlcy4gKi9cbiAgaGVhcnRiZWF0TXM6IG51bWJlcjtcbiAgLyoqIExpdmVuZXNzIHJlZ2lzdHJ5OyB0aGUgc3RyZWFtIGFkZHMgaXRzZWxmIG9uIG9wZW4gYW5kIHJlbW92ZXMgaXRzZWxmIGluXG4gICAqICB0aGUgdGVhcmRvd24gZnVubmVsLiAqL1xuICBjbGllbnRzPzogU3NlQ2xpZW50cztcbiAgLyoqIGByZXEuc2lnbmFsYCDigJQgdGhlIG9ubHkgdGhpbmcgdGhhdCByZWNsYWltcyBhIGNsaWVudCB0aGF0IHdlbnQgYXdheVxuICAgKiAgd2l0aG91dCBjYW5jZWxsaW5nIHRoZSBzdHJlYW0uICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKiogU2VydmVyLXNpZGUgZmlsdGVyLiBBIHJlamVjdGVkIGZyYW1lIGlzIG5vdCBzZW50OyB0aGUgY2xpZW50IHN0aWxsXG4gICAqICBhZHZhbmNlcyBpdHMgY3Vyc29yIHBhc3QgaXQsIHdoaWNoIGlzIGB0YWlsRXZlbnRzYCdzIGRvY3VtZW50ZWQgcnVsZS4gKi9cbiAgZmlsdGVyPzogKGZyYW1lOiBGcmFtZTxUPikgPT4gYm9vbGVhbjtcbiAgLyoqXG4gICAqIFJhdyBTU0UgY2h1bmtzIHdyaXR0ZW4gdG8gVEhJUyBzdHJlYW0gQkVGT1JFIHRoZSByZXBsYXkg4oCUIGFmdGVyIHRoZVxuICAgKiBgXCI6IGNvbm5lY3RlZFwiYCBwcmVhbWJsZSBhbmQgYmVmb3JlIGBsb2cuc3Vic2NyaWJlYCwgc28gd2hhdGV2ZXIgaXQgcmV0dXJuc1xuICAgKiBpcyB0aGUgc3RyZWFtJ3MgZmlyc3QgREFUQSBsaW5lIHJhdGhlciB0aGFuIGEgZnJhbWUgYnVyaWVkIGJlaGluZCBhXG4gICAqIHJlcGxheWVkIGJhY2tsb2cuXG4gICAqXG4gICAqIOKblCBJVCBJUyBBIFBPU0lUSU9OLCBXSElDSCBJUyBXSFkgYG9uT3BlbmAgQ09VTEQgTk9UIFNFUlZFIChEODUpLiBgb25PcGVuYFxuICAgKiBmaXJlcyBhdCB0aGUgZW5kIG9mIGBzdGFydGAg4oCUIGFmdGVyIHRoZSBwcmVhbWJsZSwgYWZ0ZXIgYGxvZy5zdWJzY3JpYmVgLFxuICAgKiBhZnRlciBgY2xpZW50cy5hZGRgIOKAlCBzbyBhIGNhbGxlciB0aGF0IHN1cHBsaWVzIGl0cyBvd24gYGNsaWVudHNgIHNldCBhbmRcbiAgICogc2VuZHMgZnJvbSB0aGVyZSBsYW5kcyBpdHMgZnJhbWUgQUZURVIgdGhlIGJhY2tsb2cuIFRoYXQgaXMgZXhwcmVzc2libGUgYW5kXG4gICAqIGl0IGlzIHRoZSB3cm9uZyBvcmRlciwgd2hpY2ggaXMgdGhlIG5lYXItbWlzcyB0aGF0IG1ha2VzIHRoaXMgYSBtZWFzdXJlbWVudFxuICAgKiByYXRoZXIgdGhhbiBhbiBhc3NlcnRpb246IG5vdGhpbmcgYWJvdXQgdGhlIFRZUEVTIHByZXZlbnRzIGl0LCBhbmQgYVxuICAgKiB0eXBlLXRvLXR5cGUgY29tcGF0aWJpbGl0eSBjaGVjayBjYW5ub3Qgc2VlIGEgcG9zaXRpb24uXG4gICAqXG4gICAqIOKblCBSRVNUT1JFRCBGUk9NIFRIRSBTUEVMTCBUSElTIE1PRFVMRSBXQVMgQ09OVkVSR0VEIFRPV0FSRCwgQU5EIElUIElTIEFcbiAgICogUkVTVE9SQVRJT04gUkFUSEVSIFRIQU4gQSBXSURFTklORyBPTiBUV08gTUVBU1VSRUQgTlVNQkVSUyAoRDc5L0Q4NSkuXG4gICAqIG1pbmQtbWFwcGVyJ3MgYHNzZVJlc3BvbnNlYCB3cm90ZSBpdHMgYHRhaWwgLS1pbmJvdW5kYCBncm91bmRpbmcgZnJhbWUgb25lXG4gICAqIGxpbmUgQUJPVkUgYGJ1cy5zdWJzY3JpYmVgOyB0aGlzIG1vZHVsZSdzIGNvbnZlcmdlbmNlIGRyb3BwZWQgdGhlIHBvc2l0aW9uLFxuICAgKiBzbyB0aGUgb25seSBwcm9wZXJ0eSBtaW5kLW1hcHBlciBjb3VsZCBub3QgYWRvcHQgd2FzIHRoZSBvcmRlcmluZy4gQXBwbGllZCxcbiAgICogd2l0aCBldmVyeSBraXQtYnVuZGxpbmcgc3BlbGwgcmVidWlsdDogKiooYSkgc291cmNlIGVkaXRzIG5lZWRlZCBhdCB0aGVcbiAgICogb3RoZXIgZml2ZSBhZG9wdGVyczogWkVSTyoqIOKAlCB0aGUgZmllbGQgaXMgb3B0aW9uYWwgYW5kIG5vYm9keSBwYXNzZXMgaXQ7XG4gICAqICoqKGIpIGJ5dGVzIG9mIGFueSBvdGhlciBhZG9wdGVyJ3MgV0lSRSB0aGF0IGRpZmZlcjogWkVSTyoqIOKAlCBhc3Ryb2xhYmUsXG4gICAqIGJvdW50eSwgZ2xhbW91ciwgaW1hZ28gYW5kIG1hZ3BpZSB3ZXJlIGRyaXZlbiB1bmRlciB0aGVpciBvd24gc3VpdGVzIGFuZFxuICAgKiB0aGVpciByZWxlYXNlIGRyaXZlcywgYW5kIG5vbmUgb2YgdGhlbSB3cml0ZXMgYXQgb3Blbi4gQm90aCBudW1iZXJzIHplcm8gaXNcbiAgICogd2hhdCBcInRoZSBraXQgcmVtb3ZlZCBpdCB3aGVuIGl0IGNvcGllZFwiIG1lYW5zIG9wZXJhdGlvbmFsbHkuXG4gICAqXG4gICAqIOKaoCBBTkQgVEhFIEhPT0sgV0FTIFJFSkVDVEVEIE9OQ0UsIEZPUiBBIFJFQVNPTiBUSEFUIERPRVMgTk9UIFJFQUNIIFRISVNcbiAgICogQ0FTRS4gRDMyJ3Mgbm90LXRha2VuIGFyZ3VlZCBhZ2FpbnN0IFwiYSBgc3NlUmVzcG9uc2VgIGhvb2sgdGhhdCBoYW5kcyB0aGVcbiAgICogY2FsbGVyIGEgcmF3IGBzZW5kYCDigKYgdGhlIGNhbGxlciB0aGVuIGhhcyB0byBrZWVwIGl0cyBvd24gY29sbGVjdGlvbiBvZlxuICAgKiB0aGVtXCIg4oCUIGFnYWluc3QgZ2xhbW91cidzIHByZXNlbmNlIEJST0FEQ0FTVCwgd2hpY2ggcHVzaGVzIHRvXG4gICAqIGFscmVhZHktb3BlbiBzdHJlYW1zIGZyb20gb3V0c2lkZSBhbmQgZG9lcyBuZWVkIGEgY29sbGVjdGlvbi4gVGhpcyBpcyBvbmVcbiAgICogZnJhbWUsIG9uIG9uZSBzdHJlYW0sIGF0IG9wZW4sIGFuZCB0aGUgY2FsbGVyIGtlZXBzIG5vIGNvbGxlY3Rpb24gYXQgYWxsLlxuICAgKiBBIHJlamVjdGlvbiBpcyBzY29wZWQgdG8gdGhlIGNhc2UgdGhhdCBwcm9kdWNlZCBpdC5cbiAgICovXG4gIG9wZW5GcmFtZXM/OiAoKSA9PiBzdHJpbmdbXTtcbiAgLyoqIFJ1biBhZnRlciB0aGUgc3RyZWFtIGlzIHN1YnNjcmliZWQgKHByZXNlbmNlIHVwLCBhY3Rpdml0eSB0b3VjaCkuICovXG4gIG9uT3Blbj86ICgpID0+IHZvaWQ7XG4gIC8qKiBSdW4gZXhhY3RseSBvbmNlLCBmcm9tIHdoaWNoZXZlciB0ZWFyZG93biBwYXRoIGZpcmVzIGZpcnN0LiAqL1xuICBvbkNsb3NlPzogKCkgPT4gdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNzZVJlc3BvbnNlPFQgZXh0ZW5kcyBvYmplY3Q+KG9wdHM6IFNzZU9wdGlvbnM8VD4pOiBSZXNwb25zZSB7XG4gIGNvbnN0IHsgbG9nLCBzaW5jZSwgaGVhcnRiZWF0TXMsIGNsaWVudHMsIHNpZ25hbCwgZmlsdGVyLCBvcGVuRnJhbWVzLCBvbk9wZW4sIG9uQ2xvc2UgfSA9IG9wdHM7XG5cbiAgbGV0IHVuc3Vic2NyaWJlOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgbGV0IGtlZXBhbGl2ZTogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgbnVsbCA9IG51bGw7XG4gIGxldCBjbG9zZWQgPSBmYWxzZTtcbiAgLy8gVGhlIHJlZ2lzdHJ5IGVudHJ5IGZvciBUSElTIHN0cmVhbS4gSXRzIG1ldGhvZHMgYXJlIGZpbGxlZCBpbiBieSBgc3RhcnRgLFxuICAvLyB3aGljaCBpcyB3aGVyZSB0aGUgY29udHJvbGxlciBleGlzdHM7IHRoZSBvYmplY3QgaWRlbnRpdHkgaXMgc3RhYmxlIGZyb21cbiAgLy8gaGVyZSBzbyBgdGVhcmRvd25gIGNhbiByZW1vdmUgZXhhY3RseSB0aGlzIGVudHJ5LlxuICBjb25zdCBjbGllbnQ6IFNzZUNsaWVudCA9IHsgY2xvc2U6ICgpID0+IHt9LCBzZW5kOiAoKSA9PiB7fSB9O1xuXG4gIGNvbnN0IHRlYXJkb3duID0gKCkgPT4ge1xuICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICBjbG9zZWQgPSB0cnVlO1xuICAgIGlmIChrZWVwYWxpdmUgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoa2VlcGFsaXZlKTtcbiAgICB1bnN1YnNjcmliZT8uKCk7XG4gICAgY2xpZW50cz8uZGVsZXRlKGNsaWVudCk7XG4gICAgb25DbG9zZT8uKCk7XG4gIH07XG5cbiAgY29uc3Qgc3RyZWFtID0gbmV3IFJlYWRhYmxlU3RyZWFtKHtcbiAgICBzdGFydChjb250cm9sbGVyKSB7XG4gICAgICBjb25zdCBlbmNvZGVyID0gbmV3IFRleHRFbmNvZGVyKCk7XG4gICAgICBjb25zdCBzYWZlRW5xdWV1ZSA9IChjaHVuazogc3RyaW5nKSA9PiB7XG4gICAgICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb250cm9sbGVyLmVucXVldWUoZW5jb2Rlci5lbmNvZGUoY2h1bmspKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgdGVhcmRvd24oKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIGNsaWVudC5jbG9zZSA9ICgpID0+IHtcbiAgICAgICAgdGVhcmRvd24oKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb250cm9sbGVyLmNsb3NlKCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8qIGFscmVhZHkgY2xvc2VkIGJ5IHRoZSBydW50aW1lICovXG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICAvLyDim5QgYHNlbmRgIEdPRVMgVEhST1VHSCBgc2FmZUVucXVldWVgLCBzbyBhbiBvdXQtb2YtYmFuZCBmcmFtZSBvYmV5cyB0aGVcbiAgICAgIC8vIHNhbWUgY2xvc2VkLWNoZWNrIGFuZCB0aGUgc2FtZSB0ZWFyZG93bi1vbi10aHJvdyBhcyBhIGxvZ2dlZCBvbmUuIEFcbiAgICAgIC8vIGRhZW1vbiBtdXN0IG5vdCBiZSBhYmxlIHRvIHdyaXRlIHRvIGEgc3RyZWFtIHRoaXMgbW9kdWxlIGhhcyB0b3JuIGRvd24uXG4gICAgICBjbGllbnQuc2VuZCA9IHNhZmVFbnF1ZXVlO1xuXG4gICAgICAvLyDim5QgQU4gT1BFTklORyBDT01NRU5ULCBCRUZPUkUgQU5ZVEhJTkcgRUxTRS4gSXQgZmx1c2hlcyB0aGUgcmVzcG9uc2VcbiAgICAgIC8vIGhlYWRlcnMgaW1tZWRpYXRlbHk6IHNvbWUgSFRUUCBjbGllbnRzIOKAlCBCdW4ncyBvd24gYGZldGNoKClgIGluY2x1ZGVkIOKAlFxuICAgICAgLy8gYnVmZmVyIHVudGlsIHRoZSBmaXJzdCBieXRlIG9mIGJvZHkgYXJyaXZlcywgc28gYSBnZW51aW5lbHkgcXVpZXQgU1NFXG4gICAgICAvLyBzdHJlYW0gd291bGQgb3RoZXJ3aXNlIGxlYXZlIHRoZSBjYWxsZXIncyBgZmV0Y2goKWAgdW5yZXNvbHZlZC4gRXZlcnlcbiAgICAgIC8vIGhvdXNlIHRhaWwgY2xpZW50IHJlYWRzIGA6YCBsaW5lcyBhcyBjb21tZW50cyBhbmQgZHJvcHMgdGhlbS5cbiAgICAgIHNhZmVFbnF1ZXVlKFwiOiBjb25uZWN0ZWRcXG5cXG5cIik7XG5cbiAgICAgIC8vIOKblCBCRUZPUkUgVEhFIFJFUExBWSwgQU5EIFRIRSBPUkRFUiBJUyBUSEUgV0hPTEUgUE9JTlQg4oCUIHNlZVxuICAgICAgLy8gYG9wZW5GcmFtZXNgIGluIHRoZSBvcHRpb25zIGFib3ZlLiBBIGdyb3VuZGluZyBmcmFtZSB3cml0dGVuIGhlcmUgaXNcbiAgICAgIC8vIHRoZSBzdHJlYW0ncyBmaXJzdCBkYXRhIGxpbmU7IHdyaXR0ZW4gZnJvbSBgb25PcGVuYCBpdCBhcnJpdmVzIGFmdGVyXG4gICAgICAvLyB0aGUgcmVwbGF5ZWQgYmFja2xvZywgd2hpY2ggaXMgYSBkaWZmZXJlbnQgY29udHJhY3Qgd2VhcmluZyB0aGUgc2FtZVxuICAgICAgLy8gdHlwZXMuXG4gICAgICBpZiAob3BlbkZyYW1lcykgZm9yIChjb25zdCBjaHVuayBvZiBvcGVuRnJhbWVzKCkpIHNhZmVFbnF1ZXVlKGNodW5rKTtcblxuICAgICAgdW5zdWJzY3JpYmUgPSBsb2cuc3Vic2NyaWJlKHNpbmNlLCAoZnJhbWUpID0+IHtcbiAgICAgICAgaWYgKGZpbHRlciAmJiAhZmlsdGVyKGZyYW1lKSkgcmV0dXJuO1xuICAgICAgICBzYWZlRW5xdWV1ZShgZGF0YTogJHtKU09OLnN0cmluZ2lmeShmcmFtZSl9XFxuXFxuYCk7XG4gICAgICB9KTtcblxuICAgICAga2VlcGFsaXZlID0gc2V0SW50ZXJ2YWwoKCkgPT4gc2FmZUVucXVldWUoXCI6IGhiXFxuXFxuXCIpLCBoZWFydGJlYXRNcyk7XG4gICAgICBzaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCB0ZWFyZG93biwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgY2xpZW50cz8uYWRkKGNsaWVudCk7XG4gICAgICBvbk9wZW4/LigpO1xuICAgIH0sXG4gICAgY2FuY2VsKCkge1xuICAgICAgdGVhcmRvd24oKTtcbiAgICB9LFxuICB9KTtcblxuICByZXR1cm4gbmV3IFJlc3BvbnNlKHN0cmVhbSwge1xuICAgIGhlYWRlcnM6IHtcbiAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwidGV4dC9ldmVudC1zdHJlYW1cIixcbiAgICAgIFwiQ2FjaGUtQ29udHJvbFwiOiBcIm5vLWNhY2hlXCIsXG4gICAgICBDb25uZWN0aW9uOiBcImtlZXAtYWxpdmVcIixcbiAgICB9LFxuICB9KTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKipcbiAqIFRoZSBzbWFsbGVzdCBiZWF0IHRoaXMgbW9kdWxlIHdpbGwgaGFuZCBiYWNrLCBpbiBtcyDigJQgdGhlIEZMT09SIGhhbGYgb2YgdGhlXG4gKiBjbGFtcCB3aG9zZSBjZWlsaW5nIGlzIGBpZGxlVGltZW91dCAvIDJgLlxuICpcbiAqIOKblCBJVCBFWElTVFMgQkVDQVVTRSBgaW50T3JgIFBBUlNFUyBXSVRIIGBwYXJzZUludGAsIEFORCBgcGFyc2VJbnRgIElTIExFTklFTlRcbiAqIFdIRVJFIElUIE1BVFRFUlMgTU9TVC4gYGludE9yYCBmYWxscyBiYWNrIHNhZmVseSBvbiBldmVyeXRoaW5nIHRoYXQgTE9PS1NcbiAqIGhvc3RpbGUg4oCUIGBcIlwiYCwgYFwiMFwiYCwgYFwiLTFcImAsIGBcImFiY1wiYCwgYFwiTmFOXCJgLCBgXCJJbmZpbml0eVwiYCBhbGwgdGFrZSB0aGVcbiAqIGZhbGxiYWNrIOKAlCBhbmQgdGhlbiByZWFkcyBgXCIxZTlcImAsIHRoZSBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXRcbiAqIGh1Z2VcIiwgYXMgKioxKiouIE1FQVNVUkVEIGF0IGdyYXBldmluZSdzIFBoYXNlIDYgcmVwYWlyLCBiZWZvcmUgdGhpcyBmbG9vcjpcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTFlOWAgcHV0IH41Mjgga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0VcbiAqIGNsaWVudCBpbiA1MjggbXMuIGBcIjMuOVwiYCBnaXZlcyAzIG1zIGFuZCBgXCI1YWJjXCJgIGdpdmVzIDUgbXMgdGhlIHNhbWUgd2F5LlxuICogQSBrbm9iIHdob3NlIGZhc3Rlc3Qgc2V0dGluZyBpcyBzcGVsbGVkIGxpa2UgaXRzIHNsb3dlc3QgaXMgYSBmbG9vZC5cbiAqXG4gKiDimqAgKipUSEUgRkxPT1IgSVMgSEVSRSBBTkQgTk9UIElOIGBpbnRPcmAg4oCUIHRoYXQgaXMgdGhlIHJ1bGluZywgbm90IGFuXG4gKiBhY2NpZGVudCBvZiB3aGVyZSBpdCB3YXMgZWFzeSB0byB3cml0ZSoqIChENzYpLiBgaW50T3JgIGlzIHRoZSBnZW5lcmFsIHBhcnNlclxuICogYmVoaW5kIGV2ZXJ5IGVudiBrbm9iIGluIHRoZSBraXQ7IHRoZXJlIGlzIG5vIHNpbmdsZSByb3N0ZXItY29ycmVjdCBtaW5pbXVtXG4gKiBmb3IgXCJhIHBvc2l0aXZlIGludGVnZXJcIiwgYW5kIHRpZ2h0ZW5pbmcgaXRzIFBBUlNFIChyZWplY3RpbmcgYDFlOWAgb3V0cmlnaHQpXG4gKiB3b3VsZCBjaGFuZ2Ugd2hhdCBldmVyeSBvdGhlciBrbm9iIGFjY2VwdHMsIHNpbGVudGx5LCBmb3IgdmFsdWVzIG5vYm9keSBoYXNcbiAqIGF1ZGl0ZWQuIGBoZWFydGJlYXRNc2AgYWxyZWFkeSBvd25zIG9uZSBlbmQgb2YgdGhpcyBpbnZhcmlhbnQsIGFuZCA1MDAgd2FzXG4gKiBhbHJlYWR5IHdyaXR0ZW4gaW50byBpdCBhcyB0aGUgc21hbGxlc3QgY2VpbGluZyBpdCB3b3VsZCBjb21wdXRlLiBUaGUgZmxvb3JcbiAqIGJlbG9uZ3MgYmVzaWRlIHRoZSBjZWlsaW5nLCB3aGVyZSB0aGUgcXVhbnRpdHkgaXMga25vd24uXG4gKi9cbmV4cG9ydCBjb25zdCBNSU5fSEVBUlRCRUFUX01TID0gNTAwO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4g4pqgIGBwYXJzZUludGAgc2VtYW50aWNzOiBgXCIxZTlcImBcbiAqICBpcyAxIGFuZCBgXCI1YWJjXCJgIGlzIDUuIEFueSBjYWxsZXIgd2l0aCBhIGtub3duIHNhZmUgbWluaW11bSBtdXN0IGNsYW1wIOKAlFxuICogIHNlZSBgTUlOX0hFQVJUQkVBVF9NU2AuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqIFRoZSBzZXJ2ZXIncyBgaWRsZVRpbWVvdXRgLCBpbiBTRUNPTkRTLCBjbGFtcGVkIHRvIHdoYXQgQnVuIGFjY2VwdHMuICovXG5leHBvcnQgZnVuY3Rpb24gaWRsZVRpbWVvdXRTZWMocmF3Pzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjayA9IE1BWF9JRExFX1RJTUVPVVRfU0VDKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKE1BWF9JRExFX1RJTUVPVVRfU0VDLCBpbnRPcihyYXcsIGZhbGxiYWNrKSkpO1xufVxuXG4vKipcbiAqIFRoZSBTU0UgaGVhcnRiZWF0LCBpbiBtcywgQ0xBTVBFRCBBVCBCT1RIIEVORFM6IG5ldmVyIGFib3ZlIGhhbGYgdGhlIGlkbGVcbiAqIHRpbWVvdXQsIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiBUaGUgY2VpbGluZyBpcyBhc3Ryb2xhYmUncywgYW5kIHRoZSBjZW5zdXMgbmFtZWQgaXQgY29udmVyZ2VuY2UgdGFyZ2V0ICM0OlxuICogdGhlIG90aGVyIGRhZW1vbnMgaGFyZC1jb2RlIDE1IHMgYWdhaW5zdCAyNTUgcyBhbmQgd3JpdGUgdGhlIHJlbGF0aW9uc2hpcFxuICogb25seSBpbiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBFbmZvcmNpbmdcbiAqIGBoZWFydGJlYXQgPD0gaWRsZVRpbWVvdXQgLyAyYCBtYWtlcyB0aGUgaW52YXJpYW50IHRydWUgZm9yIEFOWSBjb25maWd1cmVkXG4gKiBwYWlyLCB3aGljaCBpcyBleGFjdGx5IHRoZSBpbnZhcmlhbnQgd2hvc2UgdmlvbGF0aW9uIGNhdXNlZCB0aGUgYnVnIGFib3ZlLlxuICpcbiAqIOKaoCBUaGUgZmxvb3IgY2Fubm90IGZpZ2h0IHRoZSBjZWlsaW5nOiB0aGUgY2VpbGluZyBleHByZXNzaW9uIGlzIGl0c2VsZlxuICogYE1hdGgubWF4KDUwMCwg4oCmKWAsIHNvIGl0IGlzIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYCBhbmQgdGhlIHR3b1xuICogY2xhbXBzIGNhbiBuZXZlciBjcm9zcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgY29uc3QgY2VpbGluZyA9IE1hdGgubWF4KE1JTl9IRUFSVEJFQVRfTVMsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKTtcbiAgcmV0dXJuIE1hdGgubWluKE1hdGgubWF4KGludE9yKHJhdywgZmFsbGJhY2spLCBNSU5fSEVBUlRCRUFUX01TKSwgY2VpbGluZyk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIEdsYW1vdXIncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aCBoYWx2ZXNcbiAqIG9mIHRoZSBzcGVsbC5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIFRIRSBTRUFNLiBCZWZvcmUgUGhhc2UgMiB0aGUgaGVhcnRiZWF0IHdhcyBhIExJVEVSQUwgYDE1MDAwYFxuICogaW5zaWRlIGBzZXJ2ZXIudHNgJ3MgYHNzZVJlc3BvbnNlYCwgYW5kIGBjbGkudHNgIGhhZCBOTyBjb3JyZXNwb25kaW5nIG51bWJlclxuICogYXQgYWxsIOKAlCBpdHMgdGFpbCBsb29wIHNpbXBseSBibG9ja2VkIG9uIGByZWFkZXIucmVhZCgpYCBmb3JldmVyLCB3aGljaCBpcyB0aGVcbiAqIGZhaWx1cmUgYHRhaWxFdmVudHNgJ3Mgd2F0Y2hkb2cgZXhpc3RzIHRvIGVuZC4gTmVpdGhlciBmaWxlIGNvdWxkIGltcG9ydCB0aGVcbiAqIG90aGVyOiB0aGUgQ0xJIHJlYWNoaW5nIGludG8gdGhlIGRhZW1vbiB3b3VsZCBkcmFnIHRoZSB3aG9sZSBzZXJ2ZXIgZ3JhcGggaW50b1xuICogYGRpc3QvY2xpLmpzYC4gQSBtb2R1bGUgd2l0aCBubyBpbXBvcnRzIGJ1dCB0aGUga2l0J3MgZGVyaXZhdGlvbnMgaGFzIG5vIHN1Y2hcbiAqIGdyYXBoLCBzbyBib3RoIGhhbHZlcyBpbXBvcnQgdGhpcyBvbmUuXG4gKlxuICog4puUICoqQU5EIFRIRSBXQVRDSERPRyBJUyBERVJJVkVEIEZST00gR0xBTU9VUidTIE9XTiBIRUFSVEJFQVQsIE5FVkVSIENPUElFRFxuICogRlJPTSBBIFNJQkxJTkcuKiogVGhpcyBpcyBQaGFzZSAxYSdzIHJ1bGUgYW5kIGl0IGlzIHRoZSB3aG9sZSByZWFzb24gdGhlIGZpbGVcbiAqIGV4aXN0cyByYXRoZXIgdGhhbiBhIHNoYXJlZCBjb25zdGFudCBzb21ld2hlcmU6IGFzdHJvbGFiZSBiZWF0cyBhdCAxMCBzIGFuZFxuICogbWFncGllIGF0IDE1IHMsIHNvIGEgaGFyZC1jb2RlZCB3YXRjaGRvZyBpcyBjb3JyZWN0IGZvciBhdCBtb3N0IG9uZSBvZiB0aGVtLlxuICogQXN0cm9sYWJlIG1lYXN1cmVkIHdoYXQgYSBjb3BpZWQgbnVtYmVyIGRvZXMg4oCUIGEgNDUgcyB3YXRjaGRvZyBhZ2FpbnN0IGFuXG4gKiBlbnYtdHVuZWQgaGVhcnRiZWF0IHByb2R1Y2VkIHJlY29ubmVjdHMgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24sIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhbiB1bnJlbGF0ZWQgdGhpcmRcbiAqIGNvbnN0YW50IGFic29yYmVkIHRoZSBjaHVybi4gYHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUylgIGNhbm5vdCBkcmlmdCBmcm9tXG4gKiB0aGUgYmVhdCBpdCBpcyB3YXRjaGluZywgd2hhdGV2ZXIgdGhlIGJlYXQgYmVjb21lcy5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUuIFRoZSBtb21lbnQgdGhpcyBpbXBvcnRzIGFueXRoaW5nIG9mIHRoZVxuICogZGFlbW9uJ3MsIHRoZSBDTEkgaXMgYmFjayB0byBkcmFnZ2luZyB0aGUgc2VydmVyIGdyYXBoIGFuZCB0aGUgc2VhbSBjbG9zZXMuXG4gKi9cblxuaW1wb3J0IHtcbiAgREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKlxuICogQnVuJ3MgbWF4aW11bS4gVGhpcyBpcyBnbGFtb3VyJ3Mgb3duIG1lYXN1cmVkIHZhbHVlLCBub3QgYW4gaW5oZXJpdGVkIG9uZTpcbiAqIGBzZXJ2ZXIudHNgIGNhcnJpZWQgYGlkbGVUaW1lb3V0OiAyNTVgIHdpdGggYSBjb21tZW50IHJlY29yZGluZyB0aGF0IEJ1bidzXG4gKiBkZWZhdWx0IDEwIHMgY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmUgdGhlIDE1IHMga2VlcGFsaXZlIGV2ZXJcbiAqIGZpcmVzLiBHbGFtb3VyIGRvZXMgbm90IGVudi10dW5lIGl0IOKAlCBhIHNlc3Npb24gZGFlbW9uJ3MgY29ubmVjdGlvbiBsaWZldGltZVxuICogaXMgbm90IHNvbWV0aGluZyBhIGNhbGxlciBoYXMgZXZlciBuZWVkZWQgdG8gc2hvcnRlbi5cbiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBNQVhfSURMRV9USU1FT1VUX1NFQztcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0LCBhbmQgZ2xhbW91cidzIG93biBsaXRlcmFsIGJlZm9yZSB0aGlzIGZpbGUgZXhpc3RlZC4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gREVGQVVMVF9IRUFSVEJFQVRfTVM7XG5cbi8qKlxuICogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cywgREVSSVZFRC5cbiAqXG4gKiDimqAgNDUsMDAwIG1zIHRvZGF5LCB3aGljaCBpcyB0aGUgc2FtZSBudW1iZXIgYGNtZE9wZW5gJ3MgYC0tc3RhcnQtdGltZW91dGBcbiAqIGRlZmF1bHQgaGFwcGVucyB0byBiZS4gVGhleSBhcmUgVU5SRUxBVEVEIOKAlCBvbmUgYm91bmRzIGEgZmlyc3QgYnVuZGxlIGJ1aWxkLFxuICogdGhlIG90aGVyIGJvdW5kcyBhIHNpbGVudCBzb2NrZXQg4oCUIGFuZCB0aGUgY29pbmNpZGVuY2UgaXMgbmFtZWQgaGVyZSBzbyBub2JvZHlcbiAqIGxhdGVyIFwiZGUtZHVwbGljYXRlc1wiIHRoZW0gaW50byBvbmUgY29uc3RhbnQuXG4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpO1xuIiwKICAgICJpbXBvcnQgeyBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHtcbiAgZGVmYXVsdFN0YXRlLFxuICB0eXBlIEdsYW1vdXJTdGF0ZSxcbiAgdHlwZSBMaWJyYXJ5SXRlbSxcbn0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9nbGFtb3VyL3NoYXJlZC90eXBlc1wiO1xuXG5jb25zdCBFWFRfQllfTUlNRTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCJpbWFnZS93ZWJwXCI6IFwid2VicFwiLFxuICBcImltYWdlL3BuZ1wiOiBcInBuZ1wiLFxuICBcImltYWdlL2pwZWdcIjogXCJqcGdcIixcbiAgXCJpbWFnZS9naWZcIjogXCJnaWZcIixcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBzYXZlRGF0YVVybChkaXI6IHN0cmluZywgaWQ6IHN0cmluZywgZGF0YVVybDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgbSA9IC9eZGF0YTooW147LF0rKT8oO2Jhc2U2NCk/LCguKikkL3MuZXhlYyhkYXRhVXJsKTtcbiAgLy8gYCguKilgIGlzIG1hbmRhdG9yeSwgc28gYSBtYXRjaCBhbHdheXMgc2V0cyBgYm9keWA7IGBcIlwiYCBpcyB0aGlzXG4gIC8vIGZ1bmN0aW9uJ3Mgb3duIGFuc3dlciBmb3IgXCJub3Qgc2F2ZWRcIiwgc28gYW4gaW1wb3NzaWJsZSBhYnNlbmNlIHRha2VzIGl0LlxuICBjb25zdCBib2R5ID0gbT8uWzNdO1xuICBpZiAoIW0gfHwgYm9keSA9PT0gdW5kZWZpbmVkIHx8ICFkaXIpIHJldHVybiBcIlwiO1xuICBjb25zdCBtaW1lID0gKG1bMV0gPz8gXCJhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1cIikudG9Mb3dlckNhc2UoKTtcbiAgY29uc3QgYnVmID0gbVsyXSA/IEJ1ZmZlci5mcm9tKGJvZHksIFwiYmFzZTY0XCIpIDogQnVmZmVyLmZyb20oZGVjb2RlVVJJQ29tcG9uZW50KGJvZHkpLCBcInV0ZjhcIik7XG4gIGNvbnN0IGV4dCA9IEVYVF9CWV9NSU1FW21pbWVdID8/IFwiYmluXCI7XG4gIGNvbnN0IHNhZmVJZCA9IGlkLnJlcGxhY2UoL1teYS16QS1aMC05Xy1dL2csIFwiX1wiKTtcbiAgY29uc3QgcGF0aCA9IGpvaW4oZGlyLCBgJHtzYWZlSWR9LiR7ZXh0fWApO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMocGF0aCwgYnVmKTtcbiAgICByZXR1cm4gcGF0aDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFwiXCI7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNhdmVUZXh0KGRpcjogc3RyaW5nLCBpZDogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHNhZmUgPSBuYW1lLnJlcGxhY2UoL1teYS16QS1aMC05Ll8tXS9nLCBcIl9cIikgfHwgYCR7aWR9Lm1kYDtcbiAgY29uc3QgcGF0aCA9IGpvaW4oZGlyLCBgJHtpZH0tJHtzYWZlfWApO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMocGF0aCwgdGV4dCwgXCJ1dGY4XCIpO1xuICAgIHJldHVybiBwYXRoO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gXCJcIjtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF0ZXJpYWxpemVJdGVtKGZpbGVzRGlyOiBzdHJpbmcsIGl0ZW06IExpYnJhcnlJdGVtKTogdm9pZCB7XG4gIGlmIChpdGVtLnNyYykge1xuICAgIGNvbnN0IHAgPSBzYXZlRGF0YVVybChmaWxlc0RpciwgaXRlbS5pZCwgaXRlbS5zcmMpO1xuICAgIGlmIChwKSBpdGVtLnBhdGggPSBwO1xuICB9IGVsc2UgaWYgKGl0ZW0udGV4dCkge1xuICAgIGNvbnN0IHAgPSBzYXZlVGV4dChmaWxlc0RpciwgaXRlbS5pZCwgaXRlbS50aXRsZSwgaXRlbS50ZXh0KTtcbiAgICBpZiAocCkgaXRlbS5wYXRoID0gcDtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gc2F2ZVNuYXBzaG90KHNuYXBzaG90c0Rpcjogc3RyaW5nLCBzZXNzaW9uSWQ6IHN0cmluZywgc3RhdGU6IEdsYW1vdXJTdGF0ZSk6IHZvaWQge1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhzbmFwc2hvdHNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihzbmFwc2hvdHNEaXIsIGAke3Nlc3Npb25JZH0uanNvbmApLCBKU09OLnN0cmluZ2lmeShzdGF0ZSkpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBwZXJzaXN0ZW5jZSBpcyBiZXN0LWVmZm9ydCAqL1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsb2FkU25hcHNob3QocGF0aDogc3RyaW5nLCB0aXRsZTogc3RyaW5nLCBpbnRlbnQ6IHN0cmluZyk6IEdsYW1vdXJTdGF0ZSB7XG4gIGNvbnN0IHNuYXAgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpIGFzIFBhcnRpYWw8R2xhbW91clN0YXRlPjtcbiAgLy8gTWVyZ2Ugb3ZlciBkZWZhdWx0cyBzbyBvbGRlciBzbmFwc2hvdHMgZ2FpbiBuZXcgdG9wLWxldmVsIGZpZWxkcy5cbiAgY29uc3QgbWVyZ2VkID0geyAuLi5kZWZhdWx0U3RhdGUodGl0bGUsIGludGVudCksIC4uLnNuYXAgfSBhcyBHbGFtb3VyU3RhdGU7XG4gIC8vIE5vcm1hbGl6ZSBzdHlsZS1ndWlkZSBzZWN0aW9ucyBzbyBzbmFwc2hvdHMgcHJlZGF0aW5nIG5ld2VyIHBlci1zZWN0aW9uXG4gIC8vIGZpZWxkcyAocHJvbXB0cywgY29sb3JzKSBzdGlsbCBzYXRpc2Z5IHRoZSBjdXJyZW50IHNoYXBlLlxuICBtZXJnZWQuc3R5bGVHdWlkZSA9IG1lcmdlZC5zdHlsZUd1aWRlLm1hcCgocykgPT4gKHtcbiAgICAuLi5zLFxuICAgIHByb21wdHM6IHMucHJvbXB0cyA/PyBbXSxcbiAgICBjb2xvcnM6IHMuY29sb3JzID8/IFtdLFxuICB9KSk7XG4gIHJldHVybiBtZXJnZWQ7XG59XG4iLAogICAgImltcG9ydCB0eXBlIHtcbiAgQWdlbnRDb21tYW5kLFxuICBDYW5vbkltZyxcbiAgR2VuTWV0YSxcbiAgR2xhbW91clN0YXRlLFxuICBJdGVtS2luZCxcbiAgTGVhbkl0ZW0sXG4gIExlYW5TdGF0ZSxcbiAgTGlicmFyeUl0ZW0sXG4gIE1lc3NhZ2UsXG4gIFNhdmVkU3R5bGUsXG4gIFNlY3Rpb25LZXksXG4gIFNlY3Rpb25TdGF0dXMsXG4gIFN3YXRjaCxcbn0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9nbGFtb3VyL3NoYXJlZC90eXBlc1wiO1xuXG5leHBvcnQgZnVuY3Rpb24gbWFrZUl0ZW0ocDoge1xuICBpZDogc3RyaW5nO1xuICBraW5kOiBJdGVtS2luZDtcbiAgdGl0bGU6IHN0cmluZztcbiAgc3JjPzogc3RyaW5nO1xuICBwYXRoPzogc3RyaW5nO1xuICB0ZXh0Pzogc3RyaW5nO1xuICBtaW1lPzogc3RyaW5nO1xuICB0YWdzPzogc3RyaW5nW107XG4gIGNyZWF0ZWRBdDogbnVtYmVyO1xuICBnZW4/OiBHZW5NZXRhIHwgbnVsbDtcbn0pOiBMaWJyYXJ5SXRlbSB7XG4gIHJldHVybiB7XG4gICAgaWQ6IHAuaWQsXG4gICAga2luZDogcC5raW5kLFxuICAgIHRpdGxlOiBwLnRpdGxlLFxuICAgIHNyYzogcC5zcmMgPz8gXCJcIixcbiAgICBwYXRoOiBwLnBhdGggPz8gXCJcIixcbiAgICB0ZXh0OiBwLnRleHQgPz8gXCJcIixcbiAgICBtaW1lOiBwLm1pbWUgPz8gXCJcIixcbiAgICB0YWdzOiBwLnRhZ3MgPz8gW10sXG4gICAgc3RhcnJlZDogZmFsc2UsXG4gICAgbGlrZWQ6IGZhbHNlLFxuICAgIGFubm90YXRpb25zOiB7IGFnZW50OiBcIlwiLCBodW1hbjogXCJcIiB9LFxuICAgIGNhbm9uaWNhbDogZmFsc2UsXG4gICAgY2Fub246IFtdLFxuICAgIGFyY2hpdmVkOiBmYWxzZSxcbiAgICBjcmVhdGVkQXQ6IHAuY3JlYXRlZEF0LFxuICAgIGdlbjogcC5nZW4gPz8gbnVsbCxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZEl0ZW0oc3RhdGU6IEdsYW1vdXJTdGF0ZSwgaXRlbTogTGlicmFyeUl0ZW0pOiBib29sZWFuIHtcbiAgaWYgKHN0YXRlLmxpYnJhcnkuc29tZSgoaSkgPT4gaS5pZCA9PT0gaXRlbS5pZCkpIHJldHVybiBmYWxzZTtcbiAgc3RhdGUubGlicmFyeS5wdXNoKGl0ZW0pO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNlbGVjdEl0ZW1zKHN0YXRlOiBHbGFtb3VyU3RhdGUsIGlkczogc3RyaW5nW10pOiB2b2lkIHtcbiAgc3RhdGUuc2VsZWN0ZWRJZHMgPSBbLi4uaWRzXTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldFN0YXIoc3RhdGU6IEdsYW1vdXJTdGF0ZSwgaWQ6IHN0cmluZywgc3RhcnJlZDogYm9vbGVhbik6IGJvb2xlYW4ge1xuICBjb25zdCBpdCA9IHN0YXRlLmxpYnJhcnkuZmluZCgoaSkgPT4gaS5pZCA9PT0gaWQpO1xuICBpZiAoIWl0KSByZXR1cm4gZmFsc2U7XG4gIGl0LnN0YXJyZWQgPSBzdGFycmVkO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldExpa2Uoc3RhdGU6IEdsYW1vdXJTdGF0ZSwgaWQ6IHN0cmluZywgbGlrZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3QgaXQgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKGkpID0+IGkuaWQgPT09IGlkKTtcbiAgaWYgKCFpdCkgcmV0dXJuIGZhbHNlO1xuICBpdC5saWtlZCA9IGxpa2VkO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFubm90YXRlKFxuICBzdGF0ZTogR2xhbW91clN0YXRlLFxuICBpZDogc3RyaW5nLFxuICB3aG86IFwiYWdlbnRcIiB8IFwiaHVtYW5cIixcbiAgdGV4dDogc3RyaW5nLFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGl0ID0gc3RhdGUubGlicmFyeS5maW5kKChpKSA9PiBpLmlkID09PSBpZCk7XG4gIGlmICghaXQpIHJldHVybiBmYWxzZTtcbiAgaXQuYW5ub3RhdGlvbnNbd2hvXSA9IHRleHQ7XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkTWVzc2FnZShzdGF0ZTogR2xhbW91clN0YXRlLCBtOiBNZXNzYWdlKTogdm9pZCB7XG4gIHN0YXRlLm1lc3NhZ2VzLnB1c2gobSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVTZWN0aW9uKFxuICBzdGF0ZTogR2xhbW91clN0YXRlLFxuICBrZXk6IFNlY3Rpb25LZXksXG4gIHBhdGNoOiB7IGNvbnRlbnQ/OiBzdHJpbmc7IHN0YXR1cz86IFNlY3Rpb25TdGF0dXM7IHByb21wdHM/OiBzdHJpbmdbXTsgY29sb3JzPzogU3dhdGNoW10gfSxcbik6IGJvb2xlYW4ge1xuICBjb25zdCBzZWMgPSBzdGF0ZS5zdHlsZUd1aWRlLmZpbmQoKHMpID0+IHMua2V5ID09PSBrZXkpO1xuICBpZiAoIXNlYykgcmV0dXJuIGZhbHNlO1xuICBpZiAocGF0Y2guY29udGVudCAhPT0gdW5kZWZpbmVkKSBzZWMuY29udGVudCA9IHBhdGNoLmNvbnRlbnQ7XG4gIGlmIChwYXRjaC5zdGF0dXMgIT09IHVuZGVmaW5lZCkgc2VjLnN0YXR1cyA9IHBhdGNoLnN0YXR1cztcbiAgaWYgKHBhdGNoLnByb21wdHMgIT09IHVuZGVmaW5lZCkgc2VjLnByb21wdHMgPSBwYXRjaC5wcm9tcHRzO1xuICBpZiAocGF0Y2guY29sb3JzICE9PSB1bmRlZmluZWQpIHNlYy5jb2xvcnMgPSBwYXRjaC5jb2xvcnM7XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0Rm9jdXMoXG4gIHN0YXRlOiBHbGFtb3VyU3RhdGUsXG4gIGlkczogc3RyaW5nW10sXG4gIG93bmVyOiBcInlvdVwiIHwgXCJhZ2VudFwiLFxuICBub3RlID0gXCJcIixcbik6IHZvaWQge1xuICBzdGF0ZS5zY29wZSA9IFwiZm9jdXNcIjtcbiAgc3RhdGUuZm9jdXNTZXQgPSBbLi4uaWRzXTtcbiAgc3RhdGUuZm9jdXNPd25lciA9IG93bmVyO1xuICBzdGF0ZS5mb2N1c05vdGUgPSBub3RlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2xlYXJGb2N1cyhzdGF0ZTogR2xhbW91clN0YXRlKTogdm9pZCB7XG4gIHN0YXRlLnNjb3BlID0gXCJhbGxcIjtcbiAgc3RhdGUuZm9jdXNTZXQgPSBbXTtcbiAgc3RhdGUuZm9jdXNPd25lciA9IG51bGw7XG4gIHN0YXRlLmZvY3VzTm90ZSA9IFwiXCI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRDYW5vbmljYWwoc3RhdGU6IEdsYW1vdXJTdGF0ZSwgaWQ6IHN0cmluZywgY2Fub25pY2FsOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGl0ID0gc3RhdGUubGlicmFyeS5maW5kKChpKSA9PiBpLmlkID09PSBpZCk7XG4gIGlmICghaXQpIHJldHVybiBmYWxzZTtcbiAgaXQuY2Fub25pY2FsID0gY2Fub25pY2FsO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFyY2hpdmVUcmF5U3R5bGUoc3RhdGU6IEdsYW1vdXJTdGF0ZSwgaWQ6IHN0cmluZywgYXJjaGl2ZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3Qgc3QgPSBzdGF0ZS50cmF5LmZpbmQoKHMpID0+IHMuaWQgPT09IGlkKTtcbiAgaWYgKCFzdCkgcmV0dXJuIGZhbHNlO1xuICBzdC5hcmNoaXZlZCA9IGFyY2hpdmVkO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkU3R5bGVJdGVtKFxuICBzdHlsZTogU2F2ZWRTdHlsZSxcbiAgY2Fub246IENhbm9uSW1nW10sXG4gIGNyZWF0ZWRBdDogbnVtYmVyLFxuKTogTGlicmFyeUl0ZW0ge1xuICByZXR1cm4ge1xuICAgIGlkOiBgc3R5bGUtJHtzdHlsZS5pZH1gLFxuICAgIGtpbmQ6IFwic3R5bGVcIixcbiAgICB0aXRsZTogc3R5bGUubGFiZWwsXG4gICAgc3JjOiBcIlwiLFxuICAgIHBhdGg6IFwiXCIsXG4gICAgdGV4dDogc3R5bGUudGV4dCxcbiAgICBtaW1lOiBcIlwiLFxuICAgIHRhZ3M6IFtdLFxuICAgIHN0YXJyZWQ6IGZhbHNlLFxuICAgIGxpa2VkOiBmYWxzZSxcbiAgICBhbm5vdGF0aW9uczogeyBhZ2VudDogXCJcIiwgaHVtYW46IFwiXCIgfSxcbiAgICBjYW5vbmljYWw6IGZhbHNlLFxuICAgIGNhbm9uLFxuICAgIGFyY2hpdmVkOiBmYWxzZSxcbiAgICBjcmVhdGVkQXQsXG4gICAgZ2VuOiBudWxsLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0SXRlbUFyY2hpdmVkKHN0YXRlOiBHbGFtb3VyU3RhdGUsIGlkOiBzdHJpbmcsIGFyY2hpdmVkOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGl0ID0gc3RhdGUubGlicmFyeS5maW5kKChpKSA9PiBpLmlkID09PSBpZCk7XG4gIGlmICghaXQpIHJldHVybiBmYWxzZTtcbiAgaXQuYXJjaGl2ZWQgPSBhcmNoaXZlZDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRHZW5Db3N0KHN0YXRlOiBHbGFtb3VyU3RhdGUsIGlkOiBzdHJpbmcsIGNvc3Q6IG51bWJlcik6IGJvb2xlYW4ge1xuICBjb25zdCBpdCA9IHN0YXRlLmxpYnJhcnkuZmluZCgoaSkgPT4gaS5pZCA9PT0gaWQpO1xuICBpZiAoIWl0Py5nZW4pIHJldHVybiBmYWxzZTtcbiAgaXQuZ2VuLmNvc3QgPSBjb3N0O1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8gQmFja2ZpbGwgdGhlIHJlYWwgcHJvbXB0IGFuZC9vciByZWZzIG9udG8gYSBnZW4gYWZ0ZXIgdGhlIGZhY3QsIHNvIGl0cyBzdG9yZWRcbi8vIG1ldGFkYXRhIGlzIHRoZSByZXByb2R1Y2libGUgcHJvbXB0IChub3QgYSBsYWJlbCkg4oCUIG5vIHNlc3Npb24gYm91bmNlIG5lZWRlZC5cbmV4cG9ydCBmdW5jdGlvbiBzZXRHZW5NZXRhKFxuICBzdGF0ZTogR2xhbW91clN0YXRlLFxuICBpZDogc3RyaW5nLFxuICBwYXRjaDogeyBwcm9tcHQ/OiBzdHJpbmc7IGN1c3RvbT86IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfSxcbik6IGJvb2xlYW4ge1xuICBjb25zdCBpdCA9IHN0YXRlLmxpYnJhcnkuZmluZCgoaSkgPT4gaS5pZCA9PT0gaWQpO1xuICBpZiAoIWl0Py5nZW4pIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiBwYXRjaC5wcm9tcHQgPT09IFwic3RyaW5nXCIpIGl0Lmdlbi5wcm9tcHQgPSBwYXRjaC5wcm9tcHQ7XG4gIGlmIChwYXRjaC5jdXN0b20pIGl0Lmdlbi5jdXN0b20gPSB7IC4uLihpdC5nZW4uY3VzdG9tID8/IHt9KSwgLi4ucGF0Y2guY3VzdG9tIH07XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbGVhbkl0ZW0oaXQ6IExpYnJhcnlJdGVtKTogTGVhbkl0ZW0ge1xuICBjb25zdCB7IHNyYzogX3MsIHRleHQ6IF90LCBjYW5vbjogX2MsIC4uLnJlc3QgfSA9IGl0O1xuICByZXR1cm4gcmVzdDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxlYW5TdGF0ZShzOiBHbGFtb3VyU3RhdGUpOiBMZWFuU3RhdGUge1xuICByZXR1cm4geyAuLi5zLCBsaWJyYXJ5OiBzLmxpYnJhcnkubWFwKGxlYW5JdGVtKSB9O1xufVxuXG4vLyBCb2FyZCBtb3ZlcyB0aGF0IG11dGF0ZSBzdGF0ZSArIGJyb2FkY2FzdCBidXQgZW1pdCBOTyBhZ2VudCBldmVudC5cbmV4cG9ydCBjb25zdCBBTUJJRU5UX0NMSUVOVCA9IG5ldyBTZXQ8c3RyaW5nPihbXG4gIFwiaXRlbS5zZWxlY3RcIixcbiAgXCJpdGVtLnN0YXJcIixcbiAgXCJpdGVtLmxpa2VcIixcbiAgXCJmb2N1cy5zZXRcIixcbiAgXCJmb2N1cy5jbGVhclwiLFxuICBcIml0ZW0uY2Fub25pY2FsXCIsXG4gIFwiaXRlbS5hcmNoaXZlXCIsXG4gIFwiaXRlbS5hbm5vdGF0ZVwiLCAvLyBhIHBlci1pdGVtIG5vdGU6IHN0b3JlZCArIHJlYWQgb24gZGVtYW5kLCBub3QgcHVzaGVkIGFzIGFuIGV2ZW50XG5dKTtcbmV4cG9ydCBmdW5jdGlvbiBpc0ltcGVyYXRpdmUodHlwZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiAhQU1CSUVOVF9DTElFTlQuaGFzKHR5cGUpO1xufVxuXG4vLyBSZXR1cm5zIHdoZXRoZXIgdGhlIGNvbW1hbmQgdHlwZSB3YXMgUkVDT0dOSVNFRCDigJQgdGhlIHZlcmRpY3QgdGhlIC9jbWQgcm91dGVcbi8vIHByb3BhZ2F0ZXMgKCM4NCkuIFJlY29nbmlzZWQtYW5kLWFwcGxpZWQgaXMgYHRydWVgOyBhbiB1bmtub3duIHR5cGUgaXNcbi8vIGBmYWxzZWAuIFRoaXMgaXMgZGVsaWJlcmF0ZWx5IG5vdCBcImRpZCBzdGF0ZSBjaGFuZ2VcIjogYSByZWNvZ25pc2VkIGNvbW1hbmRcbi8vIHRoYXQgaXMgYSBsZWdpdGltYXRlIG5vLW9wIHN0aWxsIGFwcGxpZWQuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlBZ2VudE1zZyhzdGF0ZTogR2xhbW91clN0YXRlLCBtc2c6IEFnZW50Q29tbWFuZCk6IGJvb2xlYW4ge1xuICBzd2l0Y2ggKG1zZy50eXBlKSB7XG4gICAgY2FzZSBcImluaXRcIjpcbiAgICAgIGlmICh0eXBlb2YgbXNnLnRpdGxlID09PSBcInN0cmluZ1wiKSBzdGF0ZS50aXRsZSA9IG1zZy50aXRsZTtcbiAgICAgIGlmICh0eXBlb2YgbXNnLmludGVudCA9PT0gXCJzdHJpbmdcIikgc3RhdGUuaW50ZW50ID0gbXNnLmludGVudDtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJpbnRlbnRcIjpcbiAgICAgIHN0YXRlLmludGVudCA9IG1zZy50ZXh0O1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcIml0ZW0uYW5ub3RhdGVcIjoge1xuICAgICAgY29uc3QgaXQgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKGkpID0+IGkuaWQgPT09IG1zZy5pZCk7XG4gICAgICBpZiAoaXQpIGl0LmFubm90YXRpb25zLmFnZW50ID0gbXNnLmFnZW50O1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJzZWN0aW9uXCI6XG4gICAgICB1cGRhdGVTZWN0aW9uKHN0YXRlLCBtc2cua2V5LCB7XG4gICAgICAgIGNvbnRlbnQ6IG1zZy5jb250ZW50LFxuICAgICAgICBzdGF0dXM6IG1zZy5zdGF0dXMsXG4gICAgICAgIHByb21wdHM6IG1zZy5wcm9tcHRzLFxuICAgICAgICBjb2xvcnM6IG1zZy5jb2xvcnMsXG4gICAgICB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJmb2N1cy5wdXNoXCI6XG4gICAgICBzZXRGb2N1cyhzdGF0ZSwgbXNnLmlkcywgXCJhZ2VudFwiLCBtc2cubm90ZSA/PyBcIlwiKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJnZW4uY29zdFwiOlxuICAgICAgc2V0R2VuQ29zdChzdGF0ZSwgbXNnLmlkLCBtc2cuY29zdCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZ2VuLm1ldGFcIjpcbiAgICAgIHNldEdlbk1ldGEoc3RhdGUsIG1zZy5pZCwgeyBwcm9tcHQ6IG1zZy5wcm9tcHQsIGN1c3RvbTogbXNnLmN1c3RvbSB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJzdGF0dXNcIjpcbiAgICAgIHN0YXRlLnN0YXR1cyA9IHsgYnVzeTogbXNnLmJ1c3ksIHRleHQ6IG1zZy50ZXh0ID8/IFwiXCIgfTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJzdHlsZS5hcmNoaXZlXCI6XG4gICAgICBhcmNoaXZlVHJheVN0eWxlKHN0YXRlLCBtc2cuaWQsIG1zZy5hcmNoaXZlZCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwic2F5XCI6XG4gICAgY2FzZSBcImNsb3NlXCI6XG4gICAgICBicmVhazsgLy8gaGFuZGxlZCBieSB0aGUgc2VydmVyIChhcHBlbmRlZCB0byBjb252ZXJzYXRpb24gLyBzaHV0ZG93bilcbiAgICBkZWZhdWx0OlxuICAgICAgLy8gIzg0IOKAlCB0aGUgc3dpdGNoIGhhZCBOTyBkZWZhdWx0LCBzbyBhbiB1bnJlY29nbmlzZWQgY29tbWFuZCB0eXBlIGRpZFxuICAgICAgLy8gbm90aGluZyBhbmQgdGhlIC9jbWQgcm91dGUgc3RpbGwgYW5zd2VyZWQge29rOnRydWV9OiBhIGJvZ3VzIHR5cGUgd2FzXG4gICAgICAvLyBieXRlLWlkZW50aWNhbCB0byBhbiBleGVjdXRlZCBvbmUuIFRoZSB2ZXJkaWN0IGhhcyB0byBiZSBwcm9kdWNlZCBIRVJFLFxuICAgICAgLy8gYnkgdGhlIGNvZGUgdGhhdCBhY3R1YWxseSBrbm93cyB0aGUgcmVjb2duaXNlZCBzZXQsIGFuZCBub3QgbWlycm9yZWRcbiAgICAgIC8vIGludG8gYSBsaXN0IGJlc2lkZSB0aGUgc3dpdGNoIOKAlCBhIGhhbmQtbWFpbnRhaW5lZCBtaXJyb3Igb2YgYSBjYXNlIGxpc3RcbiAgICAgIC8vIGRyaWZ0cyBzaWxlbnRseSB0aGUgbW9tZW50IGEgY2FzZSBpcyBhZGRlZCwgd2hpY2ggaXMgYSBkZWZlY3QgdGhpcyByZXBvXG4gICAgICAvLyBoYXMgYWxyZWFkeSBzaGlwcGVkIHR3aWNlLlxuICAgICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuIiwKICAgICIvLyBTZXJ2ZXIvQ0xJLW9ubHk6IHRoZSBwcm9qZWN0LXNjb3BlZCBzdHlsZSBzdG9yZS4gRG8gTk9UIGltcG9ydCBmcm9tIGJyb3dzZXJcbi8vIGNvZGUgKGZpbGVzeXN0ZW0gYWNjZXNzKS4gU3R5bGVzIGxpdmUgdW5kZXIgJHtob21lfS9zdHlsZXMvJHtwcm9qZWN0S2V5fS8sXG4vLyBrZXllZCB0byB0aGUgY2hlY2tvdXQgd2hlcmUgdGhlIHNwZWxsIHdhcyBjYXN0LlxuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCByZWFkZGlyU3luYywgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUge1xuICBDYW5vbkltZyxcbiAgQ2Fub25pY2FsUmVmLFxuICBMaWJyYXJ5SXRlbSxcbiAgU2F2ZWRTdHlsZSxcbiAgU3R5bGVTZWN0aW9uLFxufSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dsYW1vdXIvc2hhcmVkL3R5cGVzXCI7XG5cbmNvbnN0IEVYVF9CWV9NSU1FOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcImltYWdlL3dlYnBcIjogXCJ3ZWJwXCIsXG4gIFwiaW1hZ2UvcG5nXCI6IFwicG5nXCIsXG4gIFwiaW1hZ2UvanBlZ1wiOiBcImpwZ1wiLFxuICBcImltYWdlL2dpZlwiOiBcImdpZlwiLFxufTtcblxuLy8gQSBzdGFibGUsIGZpbGVzeXN0ZW0tc2FmZSBrZXk6IHNhbml0aXplZCBiYXNlIG5hbWUgKyBhIHNob3J0IGhhc2ggb2YgdGhlIGZ1bGxcbi8vIGFic29sdXRlIHBhdGggKHNvIHR3byBjaGVja291dHMgd2l0aCB0aGUgc2FtZSBmb2xkZXIgbmFtZSBkb24ndCBjb2xsaWRlKS5cbmV4cG9ydCBmdW5jdGlvbiBwcm9qZWN0S2V5KHByb2plY3REaXI6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBiYXNlbmFtZShwcm9qZWN0RGlyKS5yZXBsYWNlKC9bXmEtekEtWjAtOV8tXS9nLCBcIl9cIikgfHwgXCJyb290XCI7XG4gIGxldCBoID0gNTM4MTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBwcm9qZWN0RGlyLmxlbmd0aDsgaSsrKSBoID0gKChoIDw8IDUpICsgaCArIHByb2plY3REaXIuY2hhckNvZGVBdChpKSkgPj4+IDA7XG4gIHJldHVybiBgJHtiYXNlfS0ke2gudG9TdHJpbmcoMzYpfWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzdHlsZXNEaXIoaG9tZTogc3RyaW5nLCBrZXk6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKGhvbWUsIFwic3R5bGVzXCIsIGtleSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzYXZlU3R5bGUoXG4gIGhvbWU6IHN0cmluZyxcbiAga2V5OiBzdHJpbmcsXG4gIGFyZ3M6IHtcbiAgICBpZDogc3RyaW5nO1xuICAgIGxhYmVsOiBzdHJpbmc7XG4gICAgdGV4dDogc3RyaW5nO1xuICAgIHNlY3Rpb25zOiBTdHlsZVNlY3Rpb25bXTtcbiAgICBjYW5vbmljYWxJdGVtczogTGlicmFyeUl0ZW1bXTtcbiAgICBjcmVhdGVkQXQ6IG51bWJlcjtcbiAgfSxcbik6IFNhdmVkU3R5bGUge1xuICBjb25zdCBkaXIgPSBzdHlsZXNEaXIoaG9tZSwga2V5KTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IGNhbm9uaWNhbDogQ2Fub25pY2FsUmVmW10gPSBbXTtcbiAgZm9yIChjb25zdCBpdCBvZiBhcmdzLmNhbm9uaWNhbEl0ZW1zKSB7XG4gICAgaWYgKCFpdC5wYXRoIHx8ICFleGlzdHNTeW5jKGl0LnBhdGgpKSBjb250aW51ZTtcbiAgICBjb25zdCBleHQgPSBFWFRfQllfTUlNRVtpdC5taW1lXSA/PyBcImJpblwiO1xuICAgIGNvbnN0IGZpbGUgPSBgJHthcmdzLmlkfS0ke2l0LmlkfS4ke2V4dH1gO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBmaWxlKSwgcmVhZEZpbGVTeW5jKGl0LnBhdGgpKTtcbiAgICAgIGNhbm9uaWNhbC5wdXNoKHsgaWQ6IGl0LmlkLCB0aXRsZTogaXQudGl0bGUsIGZpbGUsIG1pbWU6IGl0Lm1pbWUgfSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBza2lwIGFuIHVucmVhZGFibGUgYmxvYiAqL1xuICAgIH1cbiAgfVxuICBjb25zdCBzdHlsZTogU2F2ZWRTdHlsZSA9IHtcbiAgICBpZDogYXJncy5pZCxcbiAgICBsYWJlbDogYXJncy5sYWJlbCxcbiAgICB0ZXh0OiBhcmdzLnRleHQsXG4gICAgc2VjdGlvbnM6IGFyZ3Muc2VjdGlvbnMsXG4gICAgY2Fub25pY2FsLFxuICAgIGNyZWF0ZWRBdDogYXJncy5jcmVhdGVkQXQsXG4gICAgYXJjaGl2ZWQ6IGZhbHNlLFxuICB9O1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHthcmdzLmlkfS5qc29uYCksIEpTT04uc3RyaW5naWZ5KHN0eWxlKSk7XG4gIHJldHVybiBzdHlsZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxvYWRUcmF5KGhvbWU6IHN0cmluZywga2V5OiBzdHJpbmcpOiBTYXZlZFN0eWxlW10ge1xuICBjb25zdCBkaXIgPSBzdHlsZXNEaXIoaG9tZSwga2V5KTtcbiAgaWYgKCFleGlzdHNTeW5jKGRpcikpIHJldHVybiBbXTtcbiAgY29uc3Qgb3V0OiBTYXZlZFN0eWxlW10gPSBbXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIHJlYWRkaXJTeW5jKGRpcikpIHtcbiAgICBpZiAoIW5hbWUuZW5kc1dpdGgoXCIuanNvblwiKSkgY29udGludWU7XG4gICAgdHJ5IHtcbiAgICAgIG91dC5wdXNoKEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oZGlyLCBuYW1lKSwgXCJ1dGY4XCIpKSBhcyBTYXZlZFN0eWxlKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHNraXAgYSBjb3JydXB0IHJlY29yZCAqL1xuICAgIH1cbiAgfVxuICByZXR1cm4gb3V0LnNvcnQoKGEsIGIpID0+IGEuY3JlYXRlZEF0IC0gYi5jcmVhdGVkQXQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0U3R5bGVBcmNoaXZlZChcbiAgaG9tZTogc3RyaW5nLFxuICBrZXk6IHN0cmluZyxcbiAgaWQ6IHN0cmluZyxcbiAgYXJjaGl2ZWQ6IGJvb2xlYW4sXG4pOiBib29sZWFuIHtcbiAgY29uc3QgcGF0aCA9IGpvaW4oc3R5bGVzRGlyKGhvbWUsIGtleSksIGAke2lkfS5qc29uYCk7XG4gIGlmICghZXhpc3RzU3luYyhwYXRoKSkgcmV0dXJuIGZhbHNlO1xuICB0cnkge1xuICAgIGNvbnN0IHN0eWxlID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSBhcyBTYXZlZFN0eWxlO1xuICAgIHN0eWxlLmFyY2hpdmVkID0gYXJjaGl2ZWQ7XG4gICAgd3JpdGVGaWxlU3luYyhwYXRoLCBKU09OLnN0cmluZ2lmeShzdHlsZSkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hdGVyaWFsaXplQ2Fub24oaG9tZTogc3RyaW5nLCBrZXk6IHN0cmluZywgc3R5bGU6IFNhdmVkU3R5bGUpOiBDYW5vbkltZ1tdIHtcbiAgY29uc3QgZGlyID0gc3R5bGVzRGlyKGhvbWUsIGtleSk7XG4gIGNvbnN0IG91dDogQ2Fub25JbWdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHJlZiBvZiBzdHlsZS5jYW5vbmljYWwpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgYnl0ZXMgPSByZWFkRmlsZVN5bmMoam9pbihkaXIsIHJlZi5maWxlKSk7XG4gICAgICBvdXQucHVzaCh7XG4gICAgICAgIHRpdGxlOiByZWYudGl0bGUsXG4gICAgICAgIHNyYzogYGRhdGE6JHtyZWYubWltZX07YmFzZTY0LCR7Ynl0ZXMudG9TdHJpbmcoXCJiYXNlNjRcIil9YCxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogc2tpcCBhIG1pc3NpbmcgYmxvYiAqL1xuICAgIH1cbiAgfVxuICByZXR1cm4gb3V0O1xufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQUFBLHVCQUFTLDBCQUFZLHNCQUFXLHVCQUFRO0FBQ3hDO0FBQ0EsMEJBQWtCO0FBQ2xCO0FBQ0Esc0JBQVM7OztBQ2tMRixJQUFNLG9CQUFvQixPQUFPLE9BQU87QUFBQSxFQUM3QztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0YsQ0FBVTtBQUdILFNBQVMsaUJBQWlCLEdBQW1CO0FBQUEsRUFDbEQsT0FBTztBQUFBLElBQ0w7QUFBQSxNQUNFLEtBQUs7QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxNQUNULFNBQVMsQ0FBQztBQUFBLE1BQ1YsUUFBUSxDQUFDO0FBQUEsSUFDWDtBQUFBLElBQ0E7QUFBQSxNQUNFLEtBQUs7QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxNQUNULFNBQVMsQ0FBQztBQUFBLE1BQ1YsUUFBUSxDQUFDO0FBQUEsSUFDWDtBQUFBLElBQ0E7QUFBQSxNQUNFLEtBQUs7QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxNQUNULFNBQVMsQ0FBQztBQUFBLE1BQ1YsUUFBUSxDQUFDO0FBQUEsSUFDWDtBQUFBLElBQ0E7QUFBQSxNQUNFLEtBQUs7QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxNQUNULFNBQVMsQ0FBQztBQUFBLE1BQ1YsUUFBUSxDQUFDO0FBQUEsSUFDWDtBQUFBLElBQ0E7QUFBQSxNQUNFLEtBQUs7QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxNQUNULFNBQVMsQ0FBQztBQUFBLE1BQ1YsUUFBUSxDQUFDO0FBQUEsSUFDWDtBQUFBLElBQ0E7QUFBQSxNQUNFLEtBQUs7QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxNQUNULFNBQVMsQ0FBQztBQUFBLE1BQ1YsUUFBUSxDQUFDO0FBQUEsSUFDWDtBQUFBLEVBQ0Y7QUFBQTtBQUdLLFNBQVMsWUFBWSxDQUFDLE9BQWUsUUFBOEI7QUFBQSxFQUN4RSxPQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0E7QUFBQSxJQUNBLFNBQVMsQ0FBQztBQUFBLElBQ1YsYUFBYSxDQUFDO0FBQUEsSUFDZCxVQUFVLENBQUM7QUFBQSxJQUNYLFlBQVksa0JBQWtCO0FBQUEsSUFDOUIsTUFBTSxDQUFDO0FBQUEsSUFDUCxPQUFP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
