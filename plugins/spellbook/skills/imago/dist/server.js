#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// src/imago/backend/server.ts
import { existsSync as existsSync3, mkdirSync, readFileSync as readFileSync3, rmSync as rmSync2, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join as join2 } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";

// plugins/spellbook/skills/imago/shared/types.ts
var MARK_TOOLS = [
  "pin",
  "arrow",
  "line",
  "rect",
  "ellipse",
  "draw",
  "image"
];
var AGENT_EVENT_TYPES = Object.freeze([
  "ready",
  "connected",
  "disconnected",
  "say",
  "proposal.send",
  "proposal.dismiss",
  "context.capture",
  "marks.commit",
  "submit",
  "closed"
]);
var DEFAULT_STYLE_NAMES = ["anime", "painterly", "photoreal", "3d", "watercolor", "line art"];
var styleId = (name) => `style-${name.trim().toLowerCase().replace(/\s+/g, "-")}`;
var DEFAULT_PROMPTS = [
  {
    id: "describe",
    kind: "prompt",
    name: "describe",
    content: "Describe this image in detail \u2014 literally what is in it."
  },
  {
    id: "palette",
    kind: "prompt",
    name: "palette",
    content: "Break down the color palette \u2014 the key colors and how they work together."
  },
  {
    id: "lighting",
    kind: "prompt",
    name: "lighting",
    content: "Describe the lighting \u2014 direction, quality, mood \u2014 so I can reuse it."
  }
];
function defaultState(title) {
  return {
    title,
    batches: [],
    focus: null,
    conversation: [],
    library: [
      ...DEFAULT_PROMPTS.map((p) => ({ ...p })),
      ...DEFAULT_STYLE_NAMES.map((name) => ({
        id: styleId(name),
        kind: "style",
        name,
        content: ""
      }))
    ],
    activeContextIds: [],
    quickPromptIds: DEFAULT_PROMPTS.map((p) => p.id),
    pins: [],
    marksByVariant: {},
    layersByVariant: {},
    analysisCache: {},
    aspect: "1:1",
    size: "1K",
    status: { busy: false, text: "" },
    cost: "",
    handoff: "",
    history: { canUndo: false, canRedo: false },
    marksUnseen: false
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
var EXIT_CANCELLED = 130;

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

// src/imago/backend/heartbeat.ts
var IDLE_TIMEOUT_SEC = idleTimeoutSec(process.env.IMAGO_IDLE_TIMEOUT_SEC, MAX_IDLE_TIMEOUT_SEC);
var SSE_HEARTBEAT_MS = heartbeatMs(process.env.IMAGO_HEARTBEAT_MS, IDLE_TIMEOUT_SEC, DEFAULT_HEARTBEAT_MS);
var TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

// plugins/spellbook/skills/imago/shared/imageOptimize.ts
var OPTIMIZE = { maxDim: 1200, quality: 0.85 };

// src/imago/backend/imageOptimize.server.ts
async function optimizeImageBuffer(input) {
  const data = await new Bun.Image(input).resize(OPTIMIZE.maxDim, OPTIMIZE.maxDim, {
    fit: "inside",
    withoutEnlargement: true
  }).webp({ quality: Math.round(OPTIMIZE.quality * 100) }).bytes();
  return { data: new Uint8Array(data), mime: "image/webp" };
}

// src/imago/backend/server.ts
var SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
var SKILL_ROOT = join2(SCRIPT_DIR, "..");
var DIST_DIR = join2(SKILL_ROOT, "dist");
function resolveMode2() {
  return resolveMode(DIST_DIR);
}
function serveDist(path) {
  return serveFromDist(DIST_DIR, path === "/" ? "index.html" : path.slice(1));
}
var IMAGO_HOME = process.env.IMAGO_HOME ?? join2(homedir(), ".imago");
var SNAPSHOTS_DIR = join2(IMAGO_HOME, "snapshots");
var PORT_SUFFIX_RE = /-p(\d{2,5})$/;
function parsePortFromSessionId(sid) {
  const m = sid?.match(PORT_SUFFIX_RE);
  if (!m)
    return null;
  const digits = m[1];
  if (digits === undefined)
    return null;
  const port = parseInt(digits, 10);
  return port >= 1 && port <= 65535 ? port : null;
}
function randHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
function newId(prefix) {
  return `${prefix}-${randHex(4)}`;
}
function contentHash(s) {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 16);
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
var EXT_BY_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg"
};
function saveDataUrl(dir, id, dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  const mime = m?.[1];
  const payload = m?.[2];
  if (mime === undefined || payload === undefined || !dir)
    return "";
  const ext = EXT_BY_MIME[mime.toLowerCase()] ?? ".bin";
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const path = join2(dir, `${safeId}${ext}`);
  try {
    writeFileSync2(path, Buffer.from(payload, "base64"));
    return path;
  } catch {
    return "";
  }
}
function variantForAgent(v) {
  const { src: _drop, ...rest } = v;
  return rest;
}
function batchForAgent(b) {
  return { ...b, variants: b.variants.map(variantForAgent) };
}
function contextForAgent(e) {
  const { image: _drop, ...rest } = e;
  return rest;
}
function markForAgent(m) {
  if (m.tool === "image") {
    const { src: _drop, ...rest } = m;
    return rest;
  }
  return m;
}
function leanState(s) {
  return {
    ...s,
    batches: s.batches.map(batchForAgent),
    library: s.library.map(contextForAgent),
    marksByVariant: Object.fromEntries(Object.entries(s.marksByVariant).map(([vid, marks]) => [vid, marks.map(markForAgent)]))
  };
}
var IMAGE_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/is;
async function optimizeSrc(src) {
  const payload = IMAGE_DATA_URL_RE.exec(src)?.[1];
  if (payload === undefined)
    return src;
  try {
    const input = new Uint8Array(Buffer.from(payload, "base64"));
    const { data } = await optimizeImageBuffer(input);
    return `data:image/webp;base64,${Buffer.from(data).toString("base64")}`;
  } catch {
    return src;
  }
}
function normStyle(name) {
  return name.trim().toLowerCase();
}
async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        title: { type: "string", default: "imago" },
        timeout: { type: "string", default: "1800" },
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
  const assetsDir = join2(SCRIPT_DIR, "..", "assets");
  let state = defaultState(v.title);
  let restored = false;
  const HISTORY_CAP = 100;
  const markHistory = {};
  const histFor = (vid) => markHistory[vid] ??= { undo: [], redo: [] };
  const markUnseen = {};
  const snapFor = (vid) => ({
    marks: structuredClone(state.marksByVariant[vid] ?? []),
    layers: structuredClone(state.layersByVariant[vid] ?? [])
  });
  const pushHistory = (vid) => {
    if (!vid)
      return;
    markUnseen[vid] = true;
    const h = histFor(vid);
    h.undo.push(snapFor(vid));
    if (h.undo.length > HISTORY_CAP)
      h.undo.shift();
    h.redo = [];
  };
  const ensureDrawLayer = (vid) => {
    if (!state.layersByVariant[vid])
      state.layersByVariant[vid] = [];
    const layers = state.layersByVariant[vid];
    const top = layers.findLast((l) => l.kind !== "image");
    if (top)
      return top.id;
    const layer = { id: newId("layer"), name: "Annotations", kind: "annotation" };
    layers.push(layer);
    return layer.id;
  };
  function linkContext(id, set) {
    if (!state.library.some((e) => e.id === id))
      return;
    const arr = set === "active" ? state.activeContextIds : state.quickPromptIds;
    if (!arr.includes(id))
      arr.push(id);
  }
  function unlinkContext(id, set) {
    if (set === "active")
      state.activeContextIds = state.activeContextIds.filter((x) => x !== id);
    else
      state.quickPromptIds = state.quickPromptIds.filter((x) => x !== id);
  }
  function addContextEntry(msg) {
    if (typeof msg.name !== "string" || !msg.name.trim())
      return { ok: false, error: "context.add requires a non-empty name" };
    const content = typeof msg.content === "string" ? msg.content : "";
    const tags = Array.isArray(msg.tags) ? msg.tags : undefined;
    const imageSrc = typeof msg.image === "string" && msg.image.startsWith("data:") ? msg.image : undefined;
    const imagePath = imageSrc ? saveDataUrl(sessionFilesDir, newId("ctx"), imageSrc) || undefined : undefined;
    if (msg.kind === "style") {
      const name = normStyle(msg.name);
      const existing = state.library.find((e) => e.kind === "style" && normStyle(e.name) === name);
      if (existing) {
        const changed = [];
        const previous = {};
        if (content && content !== existing.content) {
          changed.push("content");
          previous.content = existing.content;
          existing.content = content;
        }
        if (tags && JSON.stringify(tags) !== JSON.stringify(existing.tags)) {
          changed.push("tags");
          previous.tags = existing.tags;
          existing.tags = tags;
        }
        if (imageSrc && imageSrc !== existing.image) {
          changed.push("image");
          previous.image = existing.imagePath ?? null;
          existing.image = imageSrc;
          existing.imagePath = imagePath;
          existing.captured = true;
        }
        if (!changed.length)
          return { ok: true, id: existing.id, outcome: "already-recorded" };
        return { ok: true, id: existing.id, outcome: "updated", changed, previous };
      }
      const id2 = newId("ctx");
      state.library.push({
        id: id2,
        kind: "style",
        name,
        content,
        tags,
        image: imageSrc,
        imagePath,
        captured: imageSrc ? true : undefined
      });
      return { ok: true, id: id2, outcome: "created" };
    }
    const id = newId("ctx");
    state.library.push({
      id,
      kind: msg.kind,
      name: msg.name.trim(),
      content,
      tags,
      image: imageSrc,
      imagePath
    });
    return { ok: true, id, outcome: "created" };
  }
  const kindForTool = (tool) => tool === "image" ? "image" : tool === "draw" ? "sketch" : "annotation";
  const TOOL_LABEL = {
    pin: "Pin",
    arrow: "Arrow",
    line: "Line",
    rect: "Rectangle",
    ellipse: "Ellipse",
    draw: "Sketch",
    image: "Image"
  };
  if (v.restore) {
    const restorePath = existsSync3(v.restore) ? v.restore : join2(SNAPSHOTS_DIR, `${v.restore}.json`);
    try {
      const snap = JSON.parse(readFileSync3(restorePath, "utf8"));
      state = { ...defaultState(v.title), ...snap };
      restored = true;
    } catch (e) {
      process.stderr.write(`imago: restore failed (${restorePath}): ${e instanceof Error ? e.message : String(e)}
`);
    }
  }
  const sockets = new Set;
  const log = createEventLog();
  const sseClients = new Set;
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
  const emitEvent = (msg) => log.emit(msg);
  const emitTransient = (msg) => {
    const frame = `data: ${JSON.stringify(msg)}

`;
    for (const c of sseClients)
      c.send(frame);
  };
  function broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of sockets) {
      try {
        ws.send(s);
      } catch {}
    }
  }
  let snapDirty = false;
  const broadcastState = () => {
    snapDirty = true;
    const h = state.focus ? markHistory[state.focus.variantId] : undefined;
    state.history = { canUndo: (h?.undo.length ?? 0) > 0, canRedo: (h?.redo.length ?? 0) > 0 };
    state.marksUnseen = state.focus ? markUnseen[state.focus.variantId] ?? false : false;
    broadcast({ type: "state", state });
  };
  let sessionFilesDir = "";
  const saveSnapshot = () => {
    try {
      mkdirSync(SNAPSHOTS_DIR, { recursive: true });
      writeFileSync2(join2(SNAPSHOTS_DIR, `${sessionId}.json`), JSON.stringify(state));
    } catch {}
  };
  const findBatch = (id) => state.batches.find((b) => b.id === id);
  function findVariant(id) {
    for (const b of state.batches) {
      for (const [index, variant] of b.variants.entries()) {
        if (variant.id === id)
          return { batch: b, variant, index };
      }
    }
    return null;
  }
  const labelOf = (i) => String.fromCharCode(97 + i);
  const selectedRefIds = () => state.batches.flatMap((b) => b.variants).filter((v2) => v2.refSelected).map((v2) => v2.id);
  function importImageVariant(src, name) {
    const hash = contentHash(src);
    for (const b of state.batches) {
      const ex = b.variants.find((v2) => v2.hash === hash);
      if (ex) {
        if (name && !ex.name)
          ex.name = name;
        return { batchId: b.id, variant: ex };
      }
    }
    const vid = newId("v");
    const batchId = newId("b");
    const variant = {
      id: vid,
      src,
      path: saveDataUrl(sessionFilesDir, vid, src),
      liked: false,
      analysis: state.analysisCache[hash] ?? "",
      name,
      hash
    };
    state.batches.push({ id: batchId, kind: "import", prompt: "", tag: name, variants: [variant] });
    return { batchId, variant };
  }
  function pushMessage(m) {
    const msg = { id: m.id ?? newId("m"), ts: Date.now(), ...m };
    state.conversation.push(msg);
    return msg;
  }
  async function handleAgentMsg(msg) {
    const t = msg.type;
    if (t === "init") {
      if (typeof msg.title === "string")
        state.title = msg.title;
      broadcastState();
    } else if (t === "say") {
      if (typeof msg.text === "string" && msg.text) {
        pushMessage({ role: "agent", kind: "text", text: msg.text });
        broadcastState();
      }
    } else if (t === "propose") {
      if (typeof msg.prompt === "string" && msg.prompt) {
        const n = typeof msg.n === "number" && msg.n > 0 ? Math.min(4, Math.floor(msg.n)) : 4;
        pushMessage({
          role: "agent",
          kind: "prompt",
          text: "",
          proposal: { prompt: msg.prompt, n, status: "pending" }
        });
        broadcastState();
      }
    } else if (t === "ask") {
      if (typeof msg.text === "string" && msg.text) {
        pushMessage({
          role: "agent",
          kind: "question",
          text: msg.text,
          options: Array.isArray(msg.options) ? msg.options : undefined
        });
        broadcastState();
      }
    } else if (t === "batch.add") {
      const variantsIn = Array.isArray(msg.variants) ? msg.variants : [];
      if (variantsIn.length === 0)
        return true;
      const batchId = newId("b");
      const variants = [];
      for (const raw of variantsIn) {
        if (typeof raw.src !== "string")
          continue;
        const vid = typeof raw.id === "string" ? raw.id : newId("v");
        const src = await optimizeSrc(raw.src);
        variants.push({
          id: vid,
          src,
          path: saveDataUrl(sessionFilesDir, vid, src),
          seed: typeof raw.seed === "number" ? raw.seed : undefined,
          model: typeof raw.model === "string" ? raw.model : undefined,
          liked: false,
          analysis: ""
        });
      }
      if (variants.length === 0)
        return true;
      const batch = {
        id: batchId,
        kind: msg.kind === "edit" ? "edit" : "generate",
        prompt: typeof msg.prompt === "string" ? msg.prompt : "",
        tag: typeof msg.tag === "string" ? msg.tag : undefined,
        editedFromVariantId: typeof msg.editedFromVariantId === "string" ? msg.editedFromVariantId : undefined,
        variants
      };
      state.batches.push(batch);
      pushMessage({
        role: "agent",
        kind: "result",
        text: typeof msg.summary === "string" ? msg.summary : `Generated ${variants.length} variant${variants.length > 1 ? "s" : ""} \u2014 they're on the left.`,
        batchId
      });
      const first = variants[0];
      if (!state.focus && first)
        state.focus = { batchId, variantId: first.id };
      broadcastState();
    } else if (t === "focus") {
      const b = findBatch(msg.batchId);
      const has = b?.variants.some((x) => x.id === msg.variantId);
      if (b && has) {
        state.focus = { batchId: b.id, variantId: msg.variantId };
        broadcastState();
      }
    } else if (t === "ref.select") {
      const hit = findVariant(msg.id);
      if (!hit)
        return true;
      hit.variant.refSelected = msg.selected === true;
      broadcastState();
    } else if (t === "variant.analyze") {
      const hit = findVariant(msg.id);
      if (!hit || typeof msg.text !== "string")
        return true;
      hit.variant.analysis = msg.text;
      if (hit.variant.hash)
        state.analysisCache[hit.variant.hash] = msg.text;
      broadcastState();
    } else if (t === "context.add") {
      const res = addContextEntry(msg);
      if (!res.ok)
        return {
          recognised: true,
          ok: false,
          status: 409,
          error: res.error,
          detail: res.id ? { id: res.id } : {}
        };
      if (msg.link)
        linkContext(res.id, msg.link);
      if (res.outcome !== "already-recorded" || msg.link)
        broadcastState();
      return {
        recognised: true,
        ok: true,
        detail: {
          id: res.id,
          outcome: res.outcome,
          ...res.outcome === "updated" ? { changed: res.changed, previous: res.previous } : {}
        }
      };
    } else if (t === "status") {
      state.status = {
        busy: msg.busy === true,
        text: typeof msg.text === "string" ? msg.text : ""
      };
      broadcastState();
    } else if (t === "cost") {
      if (typeof msg.text === "string") {
        state.cost = msg.text;
        broadcastState();
      }
    } else if (t === "handoff") {
      state.handoff = typeof msg.text === "string" ? msg.text : "";
      broadcastState();
    } else if (t === "close") {
      resolveDone({ code: 0, reason: "close" });
    } else {
      return false;
    }
    return true;
  }
  const eventsResponse = (req, url2) => {
    touch();
    return sseResponse({
      log,
      since: Number.parseInt(url2.searchParams.get("since") ?? "-1", 10),
      heartbeatMs: SSE_HEARTBEAT_MS,
      clients: sseClients,
      signal: req.signal,
      onOpen: touch,
      onClose: touch
    });
  };
  async function handleBrowserMsg(msg) {
    const t = msg.type;
    if (t === "say") {
      if (typeof msg.text !== "string" || !msg.text)
        return;
      pushMessage({ role: "user", kind: "text", text: msg.text });
      let flattenedImagePath;
      let attachedMarks;
      const fvid = state.focus?.variantId;
      if (fvid && typeof msg.flattenedSrc === "string" && msg.flattenedSrc.startsWith("data:")) {
        flattenedImagePath = saveDataUrl(sessionFilesDir, newId("flat"), msg.flattenedSrc) || undefined;
        attachedMarks = state.marksByVariant[fvid] ?? [];
        markUnseen[fvid] = false;
      }
      broadcastState();
      emitEvent({
        type: "say",
        text: msg.text,
        focus: state.focus,
        selectedRefIds: selectedRefIds(),
        flattenedImagePath,
        marks: attachedMarks
      });
    } else if (t === "proposal.send") {
      const m = state.conversation.find((x) => x.id === msg.id);
      if (m?.proposal) {
        m.proposal.status = "sent";
        broadcastState();
      }
      emitEvent({ type: "proposal.send", proposalId: msg.id });
    } else if (t === "proposal.dismiss") {
      const m = state.conversation.find((x) => x.id === msg.id);
      if (m?.proposal) {
        m.proposal.status = "dismissed";
        broadcastState();
      }
      emitEvent({ type: "proposal.dismiss", proposalId: msg.id });
    } else if (t === "focus.set") {
      const b = findBatch(msg.batchId);
      if (!b)
        return;
      if (!b.variants.some((x) => x.id === msg.variantId))
        return;
      state.focus = { batchId: b.id, variantId: msg.variantId };
      broadcastState();
    } else if (t === "focus.clear") {
      state.focus = null;
      broadcastState();
    } else if (t === "variant.like") {
      const hit = findVariant(msg.id);
      if (!hit)
        return;
      hit.variant.liked = msg.liked === true;
      if (hit.variant.liked) {
        pushMessage({
          role: "user",
          kind: "gesture",
          text: `\uD83D\uDC4D you liked variant ${labelOf(hit.index)} \u2014 imago can see which one`,
          gesture: { kind: "liked", targetId: hit.variant.id }
        });
      }
      broadcastState();
    } else if (t === "variant.remove") {
      const batchId = msg.batchId;
      const variantId = msg.variantId;
      if (typeof batchId !== "string" || typeof variantId !== "string")
        return;
      const batch = state.batches.find((b) => b.id === batchId);
      if (!batch?.variants.some((v2) => v2.id === variantId))
        return;
      batch.variants = batch.variants.filter((v2) => v2.id !== variantId);
      if (batch.variants.length === 0) {
        state.batches = state.batches.filter((b) => b.id !== batchId);
      }
      delete state.marksByVariant[variantId];
      delete state.layersByVariant[variantId];
      delete markHistory[variantId];
      delete markUnseen[variantId];
      if (state.focus?.variantId === variantId)
        state.focus = null;
      broadcastState();
    } else if (t === "context.add") {
      const res = addContextEntry(msg);
      if (res.ok && msg.link)
        linkContext(res.id, msg.link);
      if (res.ok)
        broadcastState();
    } else if (t === "context.update") {
      const e = state.library.find((x) => x.id === msg.id);
      if (e) {
        if (typeof msg.name === "string")
          e.name = msg.name.trim() || e.name;
        if (typeof msg.content === "string")
          e.content = msg.content;
        if (Array.isArray(msg.tags))
          e.tags = msg.tags;
        broadcastState();
      }
    } else if (t === "context.delete") {
      if (typeof msg.id === "string") {
        const toDelete = state.library.find((x) => x.id === msg.id);
        state.library = state.library.filter((x) => x.id !== msg.id);
        state.activeContextIds = state.activeContextIds.filter((x) => x !== msg.id);
        state.quickPromptIds = state.quickPromptIds.filter((x) => x !== msg.id);
        if (toDelete?.imagePath) {
          try {
            unlinkSync2(toDelete.imagePath);
          } catch {}
        }
        broadcastState();
      }
    } else if (t === "context.link") {
      if (typeof msg.id === "string") {
        linkContext(msg.id, msg.set);
        broadcastState();
      }
    } else if (t === "context.unlink") {
      if (typeof msg.id === "string") {
        unlinkContext(msg.id, msg.set);
        broadcastState();
      }
    } else if (t === "context.capture") {
      emitEvent({ type: "context.capture", focus: state.focus });
    } else if (t === "pin.add") {
      if (typeof msg.key !== "string" || typeof msg.value !== "string")
        return;
      const ex = state.pins.find((p) => p.key === msg.key);
      if (ex)
        ex.value = msg.value;
      else
        state.pins.push({ key: msg.key, value: msg.value });
      broadcastState();
    } else if (t === "pin.remove") {
      state.pins = state.pins.filter((p) => p.key !== msg.key);
      broadcastState();
    } else if (t === "ref.add") {
      const raw = msg.image;
      if (!raw || typeof raw.src !== "string")
        return;
      const name = typeof raw.name === "string" ? raw.name : undefined;
      const { variant } = importImageVariant(raw.src, name);
      variant.refSelected = true;
      pushMessage({
        role: "user",
        kind: "gesture",
        text: `\uD83D\uDCCE you pointed at a reference (${variant.name ?? "image"})`,
        gesture: { kind: "ref-added", targetId: variant.id }
      });
      broadcastState();
    } else if (t === "ref.remove") {
      const hit = findVariant(msg.id);
      if (!hit)
        return;
      hit.variant.refSelected = false;
      broadcastState();
    } else if (t === "ref.select") {
      const hit = findVariant(msg.id);
      if (!hit)
        return;
      hit.variant.refSelected = msg.selected === true;
      broadcastState();
    } else if (t === "image.import") {
      const raw = msg.image;
      if (!raw || typeof raw.src !== "string")
        return;
      const name = typeof raw.name === "string" ? raw.name : "imported image";
      const { batchId, variant } = importImageVariant(raw.src, name);
      state.focus = { batchId, variantId: variant.id };
      pushMessage({
        role: "user",
        kind: "gesture",
        text: `\uD83D\uDDBC you brought in an image to work on (${variant.name ?? name})`,
        gesture: { kind: "imported", targetId: variant.id }
      });
      broadcastState();
    } else if (t === "layer.addImage") {
      const vid = state.focus?.variantId;
      const raw = msg;
      if (!vid || typeof raw.src !== "string")
        return;
      const num = (v2, d) => typeof v2 === "number" && Number.isFinite(v2) ? v2 : d;
      const w = num(raw.w, 0.4);
      const h = num(raw.h, 0.4);
      const x = num(raw.x, (1 - w) / 2);
      const y = num(raw.y, (1 - h) / 2);
      const optimized = await optimizeSrc(raw.src);
      pushHistory(vid);
      if (!state.layersByVariant[vid])
        state.layersByVariant[vid] = [];
      const layer = {
        id: newId("layer"),
        name: typeof raw.name === "string" && raw.name ? raw.name : "Image",
        kind: "image"
      };
      state.layersByVariant[vid].push(layer);
      if (!state.marksByVariant[vid])
        state.marksByVariant[vid] = [];
      const arr = state.marksByVariant[vid];
      arr.push({
        id: newId("img"),
        tool: "image",
        src: optimized,
        x,
        y,
        w,
        h,
        layerId: layer.id,
        zOrder: arr.length
      });
      broadcastState();
    } else if (t === "layer.add") {
      const vid = state.focus?.variantId;
      if (!vid)
        return;
      if (!state.layersByVariant[vid])
        state.layersByVariant[vid] = [];
      pushHistory(vid);
      const kind = msg.kind === "sketch" || msg.kind === "image" ? msg.kind : "annotation";
      state.layersByVariant[vid].push({
        id: newId("layer"),
        name: typeof msg.name === "string" && msg.name ? msg.name : "Layer",
        kind
      });
      broadcastState();
    } else if (t === "layer.rename") {
      const vid = state.focus?.variantId;
      const layer = vid ? state.layersByVariant[vid]?.find((l) => l.id === msg.id) : undefined;
      if (!layer || typeof msg.name !== "string" || !msg.name || layer.name === msg.name)
        return;
      pushHistory(vid);
      layer.name = msg.name;
      broadcastState();
    } else if (t === "layer.setHidden" || t === "layer.setLocked") {
      const vid = state.focus?.variantId;
      const layer = vid ? state.layersByVariant[vid]?.find((l) => l.id === msg.id) : undefined;
      const key = t === "layer.setHidden" ? "hidden" : "locked";
      const next = t === "layer.setHidden" ? msg.hidden : msg.locked;
      if (!layer || typeof next !== "boolean" || Boolean(layer[key]) === next)
        return;
      pushHistory(vid);
      layer[key] = next;
      broadcastState();
    } else if (t === "layer.reorder") {
      const vid = state.focus?.variantId;
      const layers = vid ? state.layersByVariant[vid] : undefined;
      const idx = layers?.findIndex((l2) => l2.id === msg.id) ?? -1;
      if (!vid || !layers || idx < 0 || typeof msg.toIndex !== "number")
        return;
      const to = Math.max(0, Math.min(layers.length - 1, Math.trunc(msg.toIndex)));
      if (to === idx)
        return;
      pushHistory(vid);
      const [l] = layers.splice(idx, 1);
      if (l === undefined)
        return;
      layers.splice(to, 0, l);
      broadcastState();
    } else if (t === "layer.remove") {
      const vid = state.focus?.variantId;
      if (!vid || !state.layersByVariant[vid]?.some((l) => l.id === msg.id))
        return;
      pushHistory(vid);
      state.layersByVariant[vid] = state.layersByVariant[vid].filter((l) => l.id !== msg.id);
      if (state.marksByVariant[vid]) {
        state.marksByVariant[vid] = state.marksByVariant[vid].filter((m) => m.layerId !== msg.id);
      }
      broadcastState();
    } else if (t === "group") {
      const vid = state.focus?.variantId;
      const ids = msg.markIds;
      if (!vid || !Array.isArray(ids) || !ids.length)
        return;
      const marks = state.marksByVariant[vid] ?? [];
      const idSet = new Set(ids.filter((x) => typeof x === "string"));
      const picked = marks.filter((m) => idSet.has(m.id));
      if (!picked.length)
        return;
      pushHistory(vid);
      if (!state.layersByVariant[vid])
        state.layersByVariant[vid] = [];
      const layers = state.layersByVariant[vid];
      const sourceIds = new Set(picked.map((m) => m.layerId).filter(Boolean));
      const group = {
        id: newId("layer"),
        name: typeof msg.name === "string" && msg.name ? msg.name : "Group",
        kind: picked.every((m) => m.tool === "draw") ? "sketch" : picked.every((m) => m.tool === "image") ? "image" : "annotation"
      };
      layers.push(group);
      picked.forEach((m, i) => {
        m.layerId = group.id;
        m.zOrder = i;
      });
      state.layersByVariant[vid] = layers.filter((l) => l.id === group.id || !sourceIds.has(l.id) || marks.some((m) => m.layerId === l.id));
      broadcastState();
    } else if (t === "ungroup") {
      const vid = state.focus?.variantId;
      const layers = vid ? state.layersByVariant[vid] : undefined;
      const at = layers?.findIndex((l) => l.id === msg.id) ?? -1;
      if (!vid || !layers || at < 0)
        return;
      const members = (state.marksByVariant[vid] ?? []).filter((m) => m.layerId === msg.id).sort((a, b) => (a.zOrder ?? 0) - (b.zOrder ?? 0));
      if (members.length < 2)
        return;
      pushHistory(vid);
      const fresh = members.map((m) => {
        const id = newId("layer");
        m.layerId = id;
        m.zOrder = 0;
        return { id, name: TOOL_LABEL[m.tool], kind: kindForTool(m.tool) };
      });
      layers.splice(at, 1, ...fresh);
      broadcastState();
    } else if (t === "mark.add") {
      const mk = msg.mark;
      const vid = state.focus?.variantId;
      if (!vid || !mk?.id || !MARK_TOOLS.includes(mk.tool))
        return;
      pushHistory(vid);
      if (!state.marksByVariant[vid])
        state.marksByVariant[vid] = [];
      const arr = state.marksByVariant[vid];
      const wanted = typeof mk.layerId === "string" ? mk.layerId : undefined;
      const onLayer = wanted && state.layersByVariant[vid]?.some((l) => l.id === wanted);
      mk.layerId = onLayer ? wanted : ensureDrawLayer(vid);
      mk.zOrder = arr.length;
      arr.push(mk);
      broadcastState();
    } else if (t === "mark.remove") {
      const vid = state.focus?.variantId;
      if (!vid || !state.marksByVariant[vid])
        return;
      if (!state.marksByVariant[vid].some((m) => m.id === msg.id))
        return;
      pushHistory(vid);
      state.marksByVariant[vid] = state.marksByVariant[vid].filter((m) => m.id !== msg.id);
      broadcastState();
    } else if (t === "mark.update") {
      const vid = state.focus?.variantId;
      const m = vid ? state.marksByVariant[vid]?.find((x) => x.id === msg.id) : undefined;
      const patch = msg.patch;
      if (!m || !patch || typeof patch !== "object")
        return;
      pushHistory(vid);
      for (const [k, val] of Object.entries(patch)) {
        if (k === "id" || k === "tool" || k === "zOrder")
          continue;
        if (typeof val === "number" || typeof val === "string") {
          m[k] = val;
        } else if (k === "points" && Array.isArray(val) && val.every((p) => p && typeof p === "object" && typeof p.x === "number" && typeof p.y === "number")) {
          m[k] = val;
        }
      }
      broadcastState();
    } else if (t === "mark.reorder") {
      const vid = state.focus?.variantId;
      if (!vid || !state.marksByVariant[vid])
        return;
      const sorted = [...state.marksByVariant[vid]].sort((a, b) => (a.zOrder ?? 0) - (b.zOrder ?? 0));
      const idx = sorted.findIndex((m2) => m2.id === msg.id);
      if (idx < 0)
        return;
      pushHistory(vid);
      const [m] = sorted.splice(idx, 1);
      if (m === undefined)
        return;
      const target = msg.direction === "front" ? sorted.length : msg.direction === "back-most" ? 0 : msg.direction === "forward" ? Math.min(sorted.length, idx + 1) : Math.max(0, idx - 1);
      sorted.splice(target, 0, m);
      sorted.forEach((mm, i) => {
        mm.zOrder = i;
      });
      state.marksByVariant[vid] = sorted;
      broadcastState();
    } else if (t === "marks.clear") {
      const vid = state.focus?.variantId;
      if (vid && state.marksByVariant[vid]?.length) {
        pushHistory(vid);
        state.marksByVariant[vid] = [];
        broadcastState();
      }
    } else if (t === "marks.replace") {
      const vid = state.focus?.variantId;
      const incoming = msg.marks;
      if (!vid || !Array.isArray(incoming))
        return;
      const valid = incoming.filter((m) => m?.id && MARK_TOOLS.includes(m.tool));
      pushHistory(vid);
      valid.forEach((m, i) => {
        m.zOrder = i;
      });
      state.marksByVariant[vid] = valid;
      broadcastState();
    } else if (t === "undo" || t === "redo") {
      const vid = state.focus?.variantId;
      if (!vid)
        return;
      const h = histFor(vid);
      const from = t === "undo" ? h.undo : h.redo;
      const to = t === "undo" ? h.redo : h.undo;
      if (!from.length)
        return;
      to.push(snapFor(vid));
      const prev = from.pop();
      state.marksByVariant[vid] = prev.marks;
      state.layersByVariant[vid] = prev.layers;
      markUnseen[vid] = true;
      broadcastState();
    } else if (t === "marks.commit") {
      if (typeof msg.text !== "string" || typeof msg.batchId !== "string" || typeof msg.variantId !== "string")
        return;
      const marks = state.marksByVariant[msg.variantId] ?? [];
      let flattenedImagePath;
      if (typeof msg.flattenedSrc === "string" && msg.flattenedSrc.startsWith("data:")) {
        flattenedImagePath = saveDataUrl(sessionFilesDir, newId("flat"), msg.flattenedSrc) || undefined;
      }
      pushMessage({
        role: "user",
        kind: "gesture",
        text: `\u270D\uFE0F ${msg.text}`,
        gesture: { kind: "marked", targetId: msg.variantId }
      });
      markUnseen[msg.variantId] = false;
      broadcastState();
      emitEvent({
        type: "marks.commit",
        text: msg.text,
        batchId: msg.batchId,
        variantId: msg.variantId,
        marks,
        selectedRefIds: selectedRefIds(),
        flattenedImagePath
      });
    } else if (t === "aspect.set") {
      if (typeof msg.aspect !== "string")
        return;
      state.aspect = msg.aspect;
      broadcastState();
    } else if (t === "size.set") {
      if (msg.size !== "1K" && msg.size !== "2K")
        return;
      state.size = msg.size;
      broadcastState();
    } else if (t === "submit") {
      broadcast({ type: "submit" });
      emitEvent({ type: "submit" });
      resolveDone({ code: 0, reason: "submit" });
    } else if (t === "cancel") {
      broadcast({ type: "cancel" });
      resolveDone({ code: EXIT_CANCELLED, reason: "cancel" });
    }
  }
  const mode = resolveMode2();
  const devIndex = mode === "dev" ? (await import("../../../../../src/imago/surface/index.html")).default : undefined;
  const routes = devIndex ? { "/": devIndex } : {};
  let server;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      routes,
      idleTimeout: IDLE_TIMEOUT_SEC,
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
          const lean = url2.searchParams.get("lean") === "1";
          const payload = lean ? leanState(state) : state;
          return new Response(JSON.stringify({ state: payload, cursor: log.cursor() }), {
            headers: { "Content-Type": "application/json" }
          });
        }
        if (req.method === "GET" && path === "/events") {
          return eventsResponse(req, url2);
        }
        if (req.method === "POST" && path === "/cmd") {
          return req.json().then(async (body) => {
            touch();
            const verdict = await handleAgentMsg(body);
            if (typeof verdict === "object") {
              if (!verdict.ok) {
                return Response.json({ ok: false, applied: false, error: verdict.error, ...verdict.detail }, { status: verdict.status });
              }
              return Response.json({ ok: true, applied: true, ...verdict.detail });
            }
            const applied = verdict;
            if (!applied) {
              return Response.json({
                ok: false,
                applied: false,
                error: `unrecognised command type ${JSON.stringify(body?.type)} \u2014 nothing was applied`
              }, { status: 400 });
            }
            return new Response('{"ok":true,"applied":true}', {
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
          const f = Bun.file(join2(assetsDir, assetName));
          return f.exists().then((exists) => exists ? new Response(f, { headers: { "Content-Type": guessMime(assetName) } }) : new Response('{"error":"not found"}', {
            status: 404,
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
          emitTransient({ type: "connected" });
          ws.send(JSON.stringify({ type: "state", state }));
        },
        message(_ws, raw) {
          touch();
          let msg;
          try {
            msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
          } catch (e) {
            process.stderr.write(`imago: bad json from browser: ${e instanceof Error ? e.message : String(e)}
`);
            return;
          }
          handleBrowserMsg(msg);
        },
        close(ws) {
          sockets.delete(ws);
          touch();
          emitTransient({ type: "disconnected" });
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
    sessionId = `imago-${randHex(4)}-p${boundPort}`;
  sessionFilesDir = join2(tmpdir(), `${sessionId}-files`);
  try {
    mkdirSync(sessionFilesDir, { recursive: true });
  } catch {}
  if (restored) {
    const legacyRefs = state.refs;
    if (Array.isArray(legacyRefs) && legacyRefs.length) {
      state.batches.push({
        id: newId("b"),
        kind: "import",
        prompt: "",
        tag: "references",
        variants: legacyRefs.map((r) => {
          const hash = r.hash ?? (r.src ? contentHash(r.src) : undefined);
          if (hash && r.analysis)
            state.analysisCache[hash] = r.analysis;
          return {
            id: r.id,
            src: r.src,
            path: r.path ?? "",
            liked: false,
            analysis: r.analysis ?? "",
            name: r.name,
            refSelected: r.selected === true,
            hash
          };
        })
      });
    }
    delete state.refs;
    const isLegacyContext = Array.isArray(state.styles) || Array.isArray(state.prompts);
    if (isLegacyContext) {
      state.library = [];
      state.activeContextIds = [];
      state.quickPromptIds = [];
    } else {
      state.library ??= [];
      state.activeContextIds ??= [];
      state.quickPromptIds ??= [];
    }
    const legacyStyles = state.styles;
    if (Array.isArray(legacyStyles)) {
      for (const st of legacyStyles) {
        const name = normStyle(st.name);
        const id = styleId(name);
        state.library.push({
          id,
          kind: "style",
          name,
          content: st.description ?? "",
          image: st.image,
          imagePath: st.imagePath,
          captured: st.captured
        });
        if (st.active)
          state.activeContextIds.push(id);
      }
    }
    const legacyPrompts = state.prompts;
    if (Array.isArray(legacyPrompts)) {
      for (const p of legacyPrompts) {
        state.library.push({
          id: p.id,
          kind: "prompt",
          name: p.label,
          content: p.text
        });
        state.quickPromptIds.push(p.id);
      }
    }
    delete state.styles;
    delete state.prompts;
    for (const b of state.batches) {
      for (const v2 of b.variants) {
        if (v2.src)
          v2.path = saveDataUrl(sessionFilesDir, v2.id, v2.src) || v2.path;
        if (v2.analysis === undefined)
          v2.analysis = "";
      }
    }
    for (const e of state.library) {
      if (e.image)
        e.imagePath = saveDataUrl(sessionFilesDir, e.id, e.image) || e.imagePath;
    }
    const legacy = state.marks;
    if (Array.isArray(legacy)) {
      if (legacy.length && state.focus)
        state.marksByVariant[state.focus.variantId] = legacy;
      delete state.marks;
    }
    state.marksByVariant ??= {};
    state.layersByVariant ??= {};
    for (const [vid, marks] of Object.entries(state.marksByVariant)) {
      let layers = state.layersByVariant[vid];
      if (!layers?.length && marks.length) {
        layers = [{ id: newId("layer"), name: "Annotations", kind: "annotation" }];
        state.layersByVariant[vid] = layers;
      }
      const defaultLayerId = layers?.[layers.length - 1]?.id;
      state.marksByVariant[vid] = marks.map((m, i) => ({
        ...m,
        zOrder: m.zOrder === undefined ? i : m.zOrder,
        layerId: m.layerId ?? defaultLayerId
      }));
    }
    saveSnapshot();
  }
  const url = `http://${host}:${boundPort}`;
  emitEvent({ type: "ready", url, port: boundPort, session_id: sessionId, mode });
  const sessionFile = join2(tmpdir(), `imago-${sessionId}.json`);
  const latestFile = join2(tmpdir(), `imago-latest.json`);
  const sessionInfo = JSON.stringify({
    url,
    port: boundPort,
    session_id: sessionId,
    title: state.title,
    files_dir: sessionFilesDir,
    mode
  });
  try {
    writeFileAtomic(sessionFile, sessionInfo);
    writeFileAtomic(latestFile, sessionInfo);
  } catch (e) {
    process.stderr.write(`imago: could not write discovery file: ${e instanceof Error ? e.message : String(e)}
`);
  }
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
      if (sessionFilesDir)
        rmSync2(sessionFilesDir, { recursive: true, force: true });
    } catch {}
  };
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
      write: saveSnapshot
    }
  });
  const { code, reason } = await done;
  stopHousekeeping();
  saveSnapshot();
  emitEvent({ type: "closed", reason });
  broadcast({ type: "message", text: `session ended: ${reason}` });
  await drainAndStop({ server, clients: sseClients, sockets });
  cleanupDiscovery();
  return code;
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  defaultState,
  leanState,
  main,
  optimizeSrc,
  parsePortFromSessionId,
  run
};
