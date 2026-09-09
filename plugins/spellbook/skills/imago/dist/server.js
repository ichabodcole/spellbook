#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// src/imago/backend/server.ts
import { existsSync as existsSync3, mkdirSync, readFileSync as readFileSync2, rmSync as rmSync2, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "fs";
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
function intOr(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function idleTimeoutSec(raw, fallback = MAX_IDLE_TIMEOUT_SEC) {
  return Math.max(1, Math.min(MAX_IDLE_TIMEOUT_SEC, intOr(raw, fallback)));
}
function heartbeatMs(raw, idleSec, fallback = DEFAULT_HEARTBEAT_MS) {
  return Math.min(intOr(raw, fallback), Math.max(500, Math.floor(idleSec * 1000 / 2)));
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
  const port = parseInt(m[1], 10);
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
  if (!m || !dir)
    return "";
  const ext = EXT_BY_MIME[m[1].toLowerCase()] ?? ".bin";
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const path = join2(dir, `${safeId}${ext}`);
  try {
    writeFileSync2(path, Buffer.from(m[2], "base64"));
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
  const m = IMAGE_DATA_URL_RE.exec(src);
  if (!m)
    return src;
  try {
    const input = new Uint8Array(Buffer.from(m[1], "base64"));
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
    for (let i = layers.length - 1;i >= 0; i--) {
      if (layers[i].kind !== "image")
        return layers[i].id;
    }
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
      const snap = JSON.parse(readFileSync2(restorePath, "utf8"));
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
      const index = b.variants.findIndex((x) => x.id === id);
      if (index >= 0)
        return { batch: b, variant: b.variants[index], index };
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
      if (!state.focus)
        state.focus = { batchId, variantId: variants[0].id };
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
          detail: {
            ...res.id ? { id: res.id } : {},
            ...res.conflicts ? { conflicts: res.conflicts } : {}
          }
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
      resolveDone({ code: 130, reason: "cancel" });
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
    for (const vid of Object.keys(state.marksByVariant)) {
      const marks = state.marksByVariant[vid];
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
    onIdleClose: () => resolveDone({ code: 124, reason: "timeout" }),
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

//# debugId=4715E92825248A5E64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2ltYWdvL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uL3NoYXJlZC90eXBlcy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZGlzY292ZXJ5LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ldmVudExvZy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaG91c2VrZWVwaW5nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9zZXJ2ZURpc3QudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3NzZS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9pbWFnby9iYWNrZW5kL2hlYXJ0YmVhdC50cyIsICIuLi9zaGFyZWQvaW1hZ2VPcHRpbWl6ZS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvaW1hZ28vYmFja2VuZC9pbWFnZU9wdGltaXplLnNlcnZlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIjIS91c3IvYmluL2VudiBidW5cblxuLy8gaW1hZ28g4oCUIGFuIGFnZW50LWRyaXZlbiBpbWFnZSBjYW52YXMgdGhlIHVzZXIgd29ya3MgaW5zaWRlLlxuLy9cbi8vIGltYWdvIGlzIGEgR1JPVU5ERUQgQ09OVkVSU0FUSU9OIGFib3V0IGFuIGltYWdlOiB0aGUgdXNlciBhbmQgdGhlIGFnZW50IHRhbGtcbi8vICh0aGUgY29udmVyc2F0aW9uKSwgdGhlIHN1cmZhY2UgaG9sZHMgdGhlIGFydGlmYWN0cyAoYmF0Y2hlcyBvZiBrZXB0XG4vLyBnZW5lcmF0aW9ucywgdGhlIGZvY3VzZWQgb25lIG9uIHRoZSBjYW52YXMpLCBhbmQgc3VyZmFjZSBnZXN0dXJlcyAobGlraW5nLFxuLy8gbWFya2luZywgYXR0YWNoaW5nIGEgcmVmKSBhcmUgbWVzc2FnZXMgdGhlIGFnZW50IGhlYXJzLiBJdCdzIGEgbG9vcCwgbm90IGFcbi8vIGZ1bm5lbCDigJQgbm8gcGhhc2UgcGlwZWxpbmUuXG4vL1xuLy8gQXJjaGl0ZWN0dXJlIChjbGkudHMgd3JhcHMgdGhpcyk6XG4vLyAgIC0gQWdlbnQg4oaUIHNlcnZlcjogSFRUUCBvbiB0aGUgc2FtZSBCdW4uc2VydmUuXG4vLyAgICAgICBQT1NUIC9jbWQgICAgICAgICAgICDigJQgYWdlbnQgY29tbWFuZCAoSlNPTjsgQWdlbnRDb21tYW5kIHVuaW9uKVxuLy8gICAgICAgR0VUICAvc3RhdGVbP2xlYW49MV0g4oCUIGZ1bGwgc25hcHNob3QgeyBzdGF0ZSwgY3Vyc29yIH07IGxlYW4gc3RyaXBzIGJsb2JzXG4vLyAgICAgICBHRVQgIC9ldmVudHM/c2luY2U9TiDigJQgU1NFIHN0cmVhbSBvZiB1c2VyIGV2ZW50cyAoTW9uaXRvci13cmFwcGFibGUpXG4vLyAgIC0gU2VydmVyIOKGlCBicm93c2VyOiBXZWJTb2NrZXQgYXQgL3dzIChDbGllbnRUb1NlcnZlciAvIFNlcnZlclRvQ2xpZW50KS5cbi8vICAgLSBTZXJ2ZXIgaG9sZHMgY2Fub25pY2FsIHN0YXRlOyBmdWxsLXN0YXRlIGJyb2FkY2FzdCB0byBicm93c2VycyBvbiBjaGFuZ2UuXG4vL1xuLy8gSU1QT1JUQU5UIChob3VzZS1zdHlsZToga2VlcCB0aGUgY2xpZW50IHRoaW4sIHRoZSBhZ2VudCBpcyB0aGUgcnVudGltZSk6IHRoZVxuLy8gc2VydmVyIGRvZXMgTk9UIGdlbmVyYXRlIGltYWdlcy4gR2VuZXJhdGlvbiBoYXBwZW5zIGFnZW50LXNpZGUgKG1lZGlhLWZvcmdlLFxuLy8gb3V0IG9mIGJhbmQpOyB0aGUgYWdlbnQgcG9zdHMgcmVzdWx0cyB2aWEgYmF0Y2guYWRkLiBUaGUgc3VyZmFjZSBkaXNwbGF5cyArXG4vLyBjb2xsZWN0cyB0aGUgY29udmVyc2F0aW9uIGFuZCBnZXN0dXJlcy5cbi8vXG4vLyBBZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKSBhbmQgdXNlciBldmVudHMgKEdFVCAvZXZlbnRzKSBhcmUgdGhlIEFnZW50Q29tbWFuZFxuLy8gdW5pb24gYW5kIEFHRU5UX0VWRU5UX1RZUEVTIGluIHNoYXJlZC90eXBlcy50cyDigJQgdGhlIHNpbmdsZSBjb250cmFjdC5cbi8vXG4vLyBFeGl0IGNvZGVzOiAwIHN1Ym1pdC9jbG9zZSwgMiBiYWQgYXJncywgMTI0IGlkbGUgdGltZW91dCwgMTMwIGNhbmNlbC5cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYywgdW5saW5rU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyLCB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB0eXBlIHsgU2VydmVyV2ViU29ja2V0IH0gZnJvbSBcImJ1blwiO1xuaW1wb3J0IHtcbiAgdHlwZSBCYXRjaCxcbiAgdHlwZSBDb250ZXh0RW50cnksXG4gIHR5cGUgQ29udGV4dEtpbmQsXG4gIHR5cGUgQ29udGV4dFNldCxcbiAgZGVmYXVsdFN0YXRlLFxuICB0eXBlIEltYWdvU3RhdGUsXG4gIHR5cGUgTGF5ZXIsXG4gIE1BUktfVE9PTFMsXG4gIHR5cGUgTWFyayxcbiAgdHlwZSBNZXNzYWdlLFxuICBzdHlsZUlkLFxuICB0eXBlIFZhcmlhbnQsXG59IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvaW1hZ28vc2hhcmVkL3R5cGVzXCI7XG5pbXBvcnQgeyB1bmxpbmtJZk1hdGNoZXMsIHdyaXRlRmlsZUF0b21pYyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9kaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB7IGNyZWF0ZUV2ZW50TG9nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2V2ZW50TG9nLnRzXCI7XG5pbXBvcnQgeyBkcmFpbkFuZFN0b3AsIHN0YXJ0SG91c2VrZWVwaW5nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hvdXNla2VlcGluZy50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZU1vZGUgYXMgcmVzb2x2ZU1vZGVJbiwgc2VydmVGcm9tRGlzdCB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9zZXJ2ZURpc3QudHNcIjtcbmltcG9ydCB7IHNzZVJlc3BvbnNlIGFzIGtpdFNzZVJlc3BvbnNlLCB0eXBlIFNzZUNsaWVudHMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvc3NlLnRzXCI7XG5pbXBvcnQgeyBJRExFX1RJTUVPVVRfU0VDLCBTU0VfSEVBUlRCRUFUX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0LnRzXCI7XG5pbXBvcnQgeyBvcHRpbWl6ZUltYWdlQnVmZmVyIH0gZnJvbSBcIi4vaW1hZ2VPcHRpbWl6ZS5zZXJ2ZXJcIjtcblxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcblxuLy8g4pSA4pSAIHN1cmZhY2UgbW9kZSAoc2VhbXMgQ29udHJhY3QgMSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vL1xuLy8gYGltcG9ydCBpbmRleCBmcm9tIFwiLi4vc3VyZmFjZS9pbmRleC5odG1sXCJgIHVzZWQgdG8gc2l0IGF0IHRoZSB0b3Agb2YgdGhpc1xuLy8gZmlsZS4gQSB0b3AtbGV2ZWwgU1RBVElDIGltcG9ydCBmb3JjZXMgQnVuIHRvIHJlc29sdmUgdGhlIHdob2xlIC50c3ggK1xuLy8gVGFpbHdpbmQgYnVpbGQgZ3JhcGggd2hlbiB0aGUgbW9kdWxlIExPQURTLCBzbyBhIGRlc3RpbmF0aW9uIHRoYXQgc2hpcHNcbi8vIGRpc3QvIGFuZCBubyBzdXJmYWNlLyDigJQgdGhlIHB1Ymxpc2hlZCBhcnRpZmFjdCDigJQgZGllcyBiZWZvcmUgaXQgY2FuIHNlcnZlXG4vLyB0aGUgZGlzdCBpdCBkb2VzIGhhdmUuIFRoZSBkZXYgaW1wb3J0IGlzIHRoZXJlZm9yZSBkeW5hbWljIGFuZCBpbnNpZGUgdGhlXG4vLyByZWxlYXNlIGJyYW5jaCdzIGBlbHNlYCwgYXMgbWluZC1tYXBwZXIgYW5kIGFzdHJvbGFiZSBib3RoIGRvIGl0LlxuLy9cbi8vIFBhdGhzIGFuY2hvciBhdCB0aGUgU0tJTEwgUk9PVCwgbmV2ZXIgYXQgY3dkOiBjbGkudHMgcGlucyB0aGUgZGFlbW9uJ3MgY3dkXG4vLyBmb3IgYnVuZmlnLnRvbWwncyBzYWtlIChDb250cmFjdCA1KSwgc28gY3dkIGlzIG5vdCBhIHN0YWJsZSBiYXNlIGZvciBkaXN0Ly5cbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuXG4vLyByZWxlYXNlIGlmZiBkaXN0L2luZGV4Lmh0bWwgZXhpc3RzIGF0IHRoZSBza2lsbCByb290LCBlbHNlIGRldjsgdGhlIGVudlxuLy8gb3ZlcnJpZGUgd2lucyBlaXRoZXIgd2F5IChzZWFtcyBDb250cmFjdCAxKS4gUmVsZWFzZTogemVybyByZWFkcyBvZiBzdXJmYWNlL1xuLy8gb3IgYnVuZmlnLnRvbWwg4oCUIHN0YXRpYyBmaWxlcyBvbmx5LlxuLy9cbi8vIOKblCBUSEUgUFJFRElDQVRFIEFORCBUSEUgU0NBUiBJVCBDQVJSSUVTIEFSRSBOT1cgYHNyYy9raXQvd2lyZS9zZXJ2ZURpc3QudHNgOlxuLy8gaXQgaXMgdGhlIEZJTEUgdGhhdCBkaXNjcmltaW5hdGVzLCBuZXZlciB0aGUgRElSRUNUT1JZLCBiZWNhdXNlIGEgYnVpbHRcbi8vIEJBQ0tFTkQgcHV0cyBjbGkuanMgYW5kIHNlcnZlci5qcyBpbiBhIGRpc3QvIHRoYXQgaGFzIG5vIHN1cmZhY2UgYW55d2hlcmVcbi8vIG5lYXIgaXQg4oCUIG1hZ3BpZSBzdGF5ZWQgY29ycmVjdGx5IGluIGRldiBmb3IgYSB3aG9sZSBzbGljZSB3aXRoIGEgZGlzdC8gdGhhdFxuLy8gZXhpc3RlZC4gVGhhdCBpcyBpbWFnbydzIHNpdHVhdGlvbiBmcm9tIHRoaXMgcGhhc2Ugb253YXJkLCBzbyB0aGUgc2NhciBpc1xuLy8gbm93IGxvYWQtYmVhcmluZyBoZXJlIGFuZCBub3Qgb25seSBpbiB0aGUgbW9kdWxlJ3MgaGVhZGVyLlxuZnVuY3Rpb24gcmVzb2x2ZU1vZGUoKTogXCJkZXZcIiB8IFwicmVsZWFzZVwiIHtcbiAgcmV0dXJuIHJlc29sdmVNb2RlSW4oRElTVF9ESVIpO1xufVxuXG4vLyBTZXJ2ZXMgZGlzdC8gdmVyYmF0aW0g4oCUIGVudHJ5IGluZGV4Lmh0bWwsIGhhc2hlZCBjaHVuay0qLmpzL2NzcyBieSBwYXRoXG4vLyAoQ29udHJhY3QgMidzIGZsYXQsIHJlbGF0aXZlLWhyZWYgbGF5b3V0KS4gVGhlIFVSTOKGkmZpbGVuYW1lIGRlY2lzaW9uIHN0YXlzXG4vLyBIRVJFLCBiZWNhdXNlIHRoYXQgaGFsZiBpcyBlYWNoIHJvdXRlcidzIG93biAoZGlnZXN0aWZ5IHN1YnN0aXR1dGVzIGludG8gdGhlXG4vLyBlbnRyeSBIVE1MLCBncmFwZXZpbmUgc2VydmVzIGF0IC93YXRjaCk7IHRoZSBraXQgZGVjaWRlcyB3aGV0aGVyIHRoZSBmaWxlIG1heVxuLy8gYmUgcmVhZCBhbmQgd2hhdCBpdCBpcyBzZXJ2ZWQgYXMuXG4vL1xuLy8g4pqgIEFORCBUSEUgTkVTVElORyBSRUZVU0FMIElTIFdIQVQgS0VFUFMgVEhJUyBDTEVBUiBPRiBJTUFHTydTIE9XTlxuLy8gL2Fzc2V0cy88bmFtZT4gUk9VVEUsIG5vdCB0aGUgcm91dGUgb3JkZXJpbmcg4oCUIG1lYXN1cmVkLCBhbmQgYXNzZXJ0ZWQgaW5cbi8vIGByZWxlYXNlLXNlcnZlLnRlc3QudHNgLiBgc2VydmVGcm9tRGlzdGAgcmVmdXNpbmcgYW55dGhpbmcgd2l0aCBhIHNsYXNoIGluIGl0XG4vLyBpcyB0aGF0IHJlZnVzYWwsIG5vdyBzaGFyZWQuXG5mdW5jdGlvbiBzZXJ2ZURpc3QocGF0aDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgcmV0dXJuIHNlcnZlRnJvbURpc3QoRElTVF9ESVIsIHBhdGggPT09IFwiL1wiID8gXCJpbmRleC5odG1sXCIgOiBwYXRoLnNsaWNlKDEpKTtcbn1cblxuLy8gUGVyc2lzdGVudCBob21lIGZvciBzZXNzaW9uIHNuYXBzaG90cyAoc3Vydml2ZXMgcmVzdGFydHMsIHVubGlrZSB0bXBkaXIpLlxuY29uc3QgSU1BR09fSE9NRSA9IHByb2Nlc3MuZW52LklNQUdPX0hPTUUgPz8gam9pbihob21lZGlyKCksIFwiLmltYWdvXCIpO1xuY29uc3QgU05BUFNIT1RTX0RJUiA9IGpvaW4oSU1BR09fSE9NRSwgXCJzbmFwc2hvdHNcIik7XG5cbnR5cGUgQ2xvc2VSZWFzb24gPSBcInN1Ym1pdFwiIHwgXCJjYW5jZWxcIiB8IFwidGltZW91dFwiIHwgXCJjbG9zZVwiO1xudHlwZSBEb25lUmVzdWx0ID0geyBjb2RlOiBudW1iZXI7IHJlYXNvbjogQ2xvc2VSZWFzb24gfTtcblxuY29uc3QgUE9SVF9TVUZGSVhfUkUgPSAvLXAoXFxkezIsNX0pJC87XG5cbmZ1bmN0aW9uIHBhcnNlUG9ydEZyb21TZXNzaW9uSWQoc2lkOiBzdHJpbmcpOiBudW1iZXIgfCBudWxsIHtcbiAgY29uc3QgbSA9IHNpZD8ubWF0Y2goUE9SVF9TVUZGSVhfUkUpO1xuICBpZiAoIW0pIHJldHVybiBudWxsO1xuICBjb25zdCBwb3J0ID0gcGFyc2VJbnQobVsxXSwgMTApO1xuICByZXR1cm4gcG9ydCA+PSAxICYmIHBvcnQgPD0gNjU1MzUgPyBwb3J0IDogbnVsbDtcbn1cblxuZnVuY3Rpb24gcmFuZEhleChieXRlczogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgYnVmID0gbmV3IFVpbnQ4QXJyYXkoYnl0ZXMpO1xuICBjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKGJ1Zik7XG4gIHJldHVybiBBcnJheS5mcm9tKGJ1ZiwgKGIpID0+IGIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsIFwiMFwiKSkuam9pbihcIlwiKTtcbn1cblxuZnVuY3Rpb24gbmV3SWQocHJlZml4OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7cHJlZml4fS0ke3JhbmRIZXgoNCl9YDtcbn1cblxuLy8gU3RhYmxlIGNvbnRlbnQgaGFzaCBvZiBhIHJlZmVyZW5jZSdzIGJ5dGVzIOKAlCBkZWR1cGVzIGlkZW50aWNhbCBhZGRzIGFuZCBrZXlzXG4vLyB0aGUgYW5hbHlzaXMgY2FjaGUgKHNvIGEgZGVsZXRl4oaScmUtYWRkIG9mIHRoZSBzYW1lIGltYWdlIHJldXNlcyBpdHMgcmVhZCkuXG5mdW5jdGlvbiBjb250ZW50SGFzaChzOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gbmV3IEJ1bi5DcnlwdG9IYXNoZXIoXCJzaGEyNTZcIikudXBkYXRlKHMpLmRpZ2VzdChcImhleFwiKS5zbGljZSgwLCAxNik7XG59XG5cbmZ1bmN0aW9uIG9wZW5Ccm93c2VyKHVybDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGNtZCA9XG4gICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIlxuICAgICAgPyBbXCJvcGVuXCIsIHVybF1cbiAgICAgIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiXG4gICAgICAgID8gW1wiY21kXCIsIFwiL2NcIiwgXCJzdGFydFwiLCBcIlwiLCB1cmxdXG4gICAgICAgIDogW1wieGRnLW9wZW5cIiwgdXJsXTtcbiAgdHJ5IHtcbiAgICBCdW4uc3Bhd24oeyBjbWQsIHN0ZG91dDogXCJpZ25vcmVcIiwgc3RkZXJyOiBcImlnbm9yZVwiIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvKiBiZXN0LWVmZm9ydCAqL1xuICB9XG59XG5cbmNvbnN0IE1JTUVfQllfRVhUOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcIi5odG1sXCI6IFwidGV4dC9odG1sOyBjaGFyc2V0PXV0Zi04XCIsXG4gIFwiLmNzc1wiOiBcInRleHQvY3NzOyBjaGFyc2V0PXV0Zi04XCIsXG4gIFwiLmpzXCI6IFwiYXBwbGljYXRpb24vamF2YXNjcmlwdDsgY2hhcnNldD11dGYtOFwiLFxuICBcIi5qc29uXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbiAgXCIuanBnXCI6IFwiaW1hZ2UvanBlZ1wiLFxuICBcIi5qcGVnXCI6IFwiaW1hZ2UvanBlZ1wiLFxuICBcIi5naWZcIjogXCJpbWFnZS9naWZcIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxuICBcIi53ZWJwXCI6IFwiaW1hZ2Uvd2VicFwiLFxuICBcIi5pY29cIjogXCJpbWFnZS94LWljb25cIixcbiAgXCIud29mZlwiOiBcImZvbnQvd29mZlwiLFxuICBcIi53b2ZmMlwiOiBcImZvbnQvd29mZjJcIixcbn07XG5mdW5jdGlvbiBndWVzc01pbWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZG90ID0gbmFtZS5sYXN0SW5kZXhPZihcIi5cIik7XG4gIGNvbnN0IGV4dCA9IGRvdCA+PSAwID8gbmFtZS5zbGljZShkb3QpLnRvTG93ZXJDYXNlKCkgOiBcIlwiO1xuICByZXR1cm4gTUlNRV9CWV9FWFRbZXh0XSB8fCBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiO1xufVxuXG5jb25zdCBFWFRfQllfTUlNRTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCJpbWFnZS9wbmdcIjogXCIucG5nXCIsXG4gIFwiaW1hZ2UvanBlZ1wiOiBcIi5qcGdcIixcbiAgXCJpbWFnZS9qcGdcIjogXCIuanBnXCIsXG4gIFwiaW1hZ2Uvd2VicFwiOiBcIi53ZWJwXCIsXG4gIFwiaW1hZ2UvZ2lmXCI6IFwiLmdpZlwiLFxuICBcImltYWdlL3N2Zyt4bWxcIjogXCIuc3ZnXCIsXG59O1xuXG4vLyBEZWNvZGUgYSBgZGF0YTo8bWltZT47YmFzZTY0LDxwYXlsb2FkPmAgVVJMIHRvIGEgZmlsZSB0aGUgYWdlbnQgY2FuIFJlYWQgKGl0c1xuLy8gdmlzaW9uIG5lZWRzIHJlYWwgcGl4ZWxzKS4gUmV0dXJucyB0aGUgcGF0aCwgb3IgXCJcIiBvbiBhbnkgZmFpbHVyZS5cbmZ1bmN0aW9uIHNhdmVEYXRhVXJsKGRpcjogc3RyaW5nLCBpZDogc3RyaW5nLCBkYXRhVXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBtID0gL15kYXRhOihbXjtdKyk7YmFzZTY0LCguKikkL3MuZXhlYyhkYXRhVXJsKTtcbiAgaWYgKCFtIHx8ICFkaXIpIHJldHVybiBcIlwiO1xuICBjb25zdCBleHQgPSBFWFRfQllfTUlNRVttWzFdLnRvTG93ZXJDYXNlKCldID8/IFwiLmJpblwiO1xuICAvLyBgaWRgIGNhbiBiZSBhZ2VudC1zdXBwbGllZCAoYmF0Y2gvcmVmIGlkcykg4oCUIHNhbml0aXplIHNvIGl0IGNhbid0IHRyYXZlcnNlXG4gIC8vIG91dCBvZiB0aGUgc2Vzc2lvbiBmaWxlcyBkaXIgdmlhIGAuLmAgb3IgYWJzb2x1dGUtcGF0aCBzZWdtZW50cy5cbiAgY29uc3Qgc2FmZUlkID0gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfLV0vZywgXCJfXCIpO1xuICBjb25zdCBwYXRoID0gam9pbihkaXIsIGAke3NhZmVJZH0ke2V4dH1gKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKHBhdGgsIEJ1ZmZlci5mcm9tKG1bMl0sIFwiYmFzZTY0XCIpKTtcbiAgICByZXR1cm4gcGF0aDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFwiXCI7XG4gIH1cbn1cblxuLy8g4pSA4pSAIGFnZW50LWZhY2luZyBwcm9qZWN0aW9uczogc3RyaXAgdGhlIChodWdlKSBpbmxpbmVkIGRhdGEtVVJMIGJsb2JzLiBUaGVcbi8vIGFnZW50IHJlYWRzIG9uLWRpc2sgYHBhdGhgcyBpbnN0ZWFkLCBrZWVwaW5nIC9zdGF0ZSBzbWFsbCByZWdhcmRsZXNzIG9mIHNpemUuXG5mdW5jdGlvbiB2YXJpYW50Rm9yQWdlbnQodjogVmFyaWFudCk6IE9taXQ8VmFyaWFudCwgXCJzcmNcIj4ge1xuICBjb25zdCB7IHNyYzogX2Ryb3AsIC4uLnJlc3QgfSA9IHY7XG4gIHJldHVybiByZXN0O1xufVxuZnVuY3Rpb24gYmF0Y2hGb3JBZ2VudChiOiBCYXRjaCk6IE9taXQ8QmF0Y2gsIFwidmFyaWFudHNcIj4gJiB7IHZhcmlhbnRzOiBPbWl0PFZhcmlhbnQsIFwic3JjXCI+W10gfSB7XG4gIHJldHVybiB7IC4uLmIsIHZhcmlhbnRzOiBiLnZhcmlhbnRzLm1hcCh2YXJpYW50Rm9yQWdlbnQpIH07XG59XG5mdW5jdGlvbiBjb250ZXh0Rm9yQWdlbnQoZTogQ29udGV4dEVudHJ5KTogT21pdDxDb250ZXh0RW50cnksIFwiaW1hZ2VcIj4ge1xuICBjb25zdCB7IGltYWdlOiBfZHJvcCwgLi4ucmVzdCB9ID0gZTtcbiAgcmV0dXJuIHJlc3Q7IC8vIGFnZW50IHJlYWRzIGltYWdlUGF0aCwgbm90IHRoZSBpbmxpbmVkIGJsb2Jcbn1cblxuLy8gU3RyaXAgdGhlIChsYXJnZSkgaW5saW5lZCBiaXRtYXAgZnJvbSBhbiBpbWFnZS1sYXllciBtYXJrIGluIHRoZSBhZ2VudFxuLy8gcHJvamVjdGlvbiDigJQgdGhlIGFnZW50IHJlYWRzIHRoZSBmbGF0dGVuZWQgY29tcG9zaXRlLCBuZXZlciBwZXItbGF5ZXIgYml0bWFwcy5cbi8vIFZlY3Rvci9waW4gbWFya3MgcGFzcyB0aHJvdWdoIHVuY2hhbmdlZC5cbmZ1bmN0aW9uIG1hcmtGb3JBZ2VudChtOiBNYXJrKTogTWFyayB8IE9taXQ8RXh0cmFjdDxNYXJrLCB7IHRvb2w6IFwiaW1hZ2VcIiB9PiwgXCJzcmNcIj4ge1xuICBpZiAobS50b29sID09PSBcImltYWdlXCIpIHtcbiAgICBjb25zdCB7IHNyYzogX2Ryb3AsIC4uLnJlc3QgfSA9IG07XG4gICAgcmV0dXJuIHJlc3Q7XG4gIH1cbiAgcmV0dXJuIG07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsZWFuU3RhdGUoczogSW1hZ29TdGF0ZSkge1xuICByZXR1cm4ge1xuICAgIC4uLnMsXG4gICAgYmF0Y2hlczogcy5iYXRjaGVzLm1hcChiYXRjaEZvckFnZW50KSxcbiAgICBsaWJyYXJ5OiBzLmxpYnJhcnkubWFwKGNvbnRleHRGb3JBZ2VudCksXG4gICAgbWFya3NCeVZhcmlhbnQ6IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgIE9iamVjdC5lbnRyaWVzKHMubWFya3NCeVZhcmlhbnQpLm1hcCgoW3ZpZCwgbWFya3NdKSA9PiBbdmlkLCBtYXJrcy5tYXAobWFya0ZvckFnZW50KV0pLFxuICAgICksXG4gIH07XG59XG5cbmNvbnN0IElNQUdFX0RBVEFfVVJMX1JFID0gL15kYXRhOmltYWdlXFwvW2EtejAtOS4rLV0rO2Jhc2U2NCwoLiopJC9pcztcblxuLy8gRG93bnNjYWxlK3dlYnAgYW4gaW5saW5lZCBpbWFnZSBkYXRhLXVybCBiZWZvcmUgaXQgZW50ZXJzIHN0YXRlIChyYXcgbW9kZWxcbi8vIFBOR3MgYXJlIHRoZSBkb21pbmFudCBzdGF0ZS1ibG9hdCBzb3VyY2UpLiBOb24tZGF0YS11cmwgc3JjcyAoaHR0cCwgZXRjLikgYW5kXG4vLyBhbnkgZmFpbHVyZSBwYXNzIHRocm91Z2ggdW5jaGFuZ2VkIOKAlCBvcHRpbWl6YXRpb24gaXMgYmVzdC1lZmZvcnQuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gb3B0aW1pemVTcmMoc3JjOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBtID0gSU1BR0VfREFUQV9VUkxfUkUuZXhlYyhzcmMpO1xuICBpZiAoIW0pIHJldHVybiBzcmM7XG4gIHRyeSB7XG4gICAgY29uc3QgaW5wdXQgPSBuZXcgVWludDhBcnJheShCdWZmZXIuZnJvbShtWzFdLCBcImJhc2U2NFwiKSk7XG4gICAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBvcHRpbWl6ZUltYWdlQnVmZmVyKGlucHV0KTtcbiAgICByZXR1cm4gYGRhdGE6aW1hZ2Uvd2VicDtiYXNlNjQsJHtCdWZmZXIuZnJvbShkYXRhKS50b1N0cmluZyhcImJhc2U2NFwiKX1gO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gc3JjO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1TdHlsZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gbmFtZS50cmltKCkudG9Mb3dlckNhc2UoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBwYXJzZWQ6IFJldHVyblR5cGU8dHlwZW9mIHBhcnNlQXJncz47XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gcGFyc2VBcmdzKHtcbiAgICAgIGFyZ3M6IGFyZ3YsXG4gICAgICBvcHRpb25zOiB7XG4gICAgICAgIHRpdGxlOiB7IHR5cGU6IFwic3RyaW5nXCIsIGRlZmF1bHQ6IFwiaW1hZ29cIiB9LFxuICAgICAgICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIsIGRlZmF1bHQ6IFwiMTgwMFwiIH0sXG4gICAgICAgIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiLCBkZWZhdWx0OiBmYWxzZSB9LFxuICAgICAgICBwb3J0OiB7IHR5cGU6IFwic3RyaW5nXCIsIGRlZmF1bHQ6IFwiMFwiIH0sXG4gICAgICAgIGhvc3Q6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVmYXVsdDogXCIxMjcuMC4wLjFcIiB9LFxuICAgICAgICBpZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LCAvLyBzbmFwc2hvdCBwYXRoIG9yIHNlc3Npb24gaWQgdG8gcmVzdW1lXG4gICAgICB9LFxuICAgICAgc3RyaWN0OiB0cnVlLFxuICAgICAgYWxsb3dQb3NpdGlvbmFsczogZmFsc2UsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgZXJyb3I6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIGNvbnN0IHYgPSBwYXJzZWQudmFsdWVzO1xuICBjb25zdCB0aW1lb3V0ID0gcGFyc2VGbG9hdCh2LnRpbWVvdXQgYXMgc3RyaW5nKTtcbiAgbGV0IHBvcnQgPSBwYXJzZUludCh2LnBvcnQgYXMgc3RyaW5nLCAxMCk7XG4gIGNvbnN0IGhvc3QgPSB2Lmhvc3QgYXMgc3RyaW5nO1xuICBsZXQgc2Vzc2lvbklkID0gKHYuaWQgYXMgc3RyaW5nIHwgdW5kZWZpbmVkKSA/PyBcIlwiO1xuICBpZiAocG9ydCA9PT0gMCAmJiBzZXNzaW9uSWQpIHtcbiAgICBjb25zdCBlbWJlZGRlZCA9IHBhcnNlUG9ydEZyb21TZXNzaW9uSWQoc2Vzc2lvbklkKTtcbiAgICBpZiAoZW1iZWRkZWQgIT09IG51bGwpIHBvcnQgPSBlbWJlZGRlZDtcbiAgfVxuXG4gIGNvbnN0IGFzc2V0c0RpciA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcImFzc2V0c1wiKTtcblxuICBsZXQgc3RhdGUgPSBkZWZhdWx0U3RhdGUodi50aXRsZSBhcyBzdHJpbmcpO1xuICBsZXQgcmVzdG9yZWQgPSBmYWxzZTtcblxuICAvLyBJbi1tZW1vcnksIHBlci12YXJpYW50IG1hcmstZWRpdCBoaXN0b3J5ICh1bmRvL3JlZG8pLiBTaXR1YXRpb25hbCDigJQgTk9UXG4gIC8vIHNuYXBzaG90dGVkLCBzbyBpdCByZXNldHMgb24gcmVkZXBsb3k7IHRoYXQncyBpbnRlbmRlZC4gRWFjaCBtdXRhdGluZyBtYXJrIG9wXG4gIC8vIHNuYXBzaG90cyB0aGUgcHJlLW11dGF0aW9uIG1hcmtzIGZvciB0aGF0IHZhcmlhbnQgb250byBgdW5kb2AgYW5kIGNsZWFyc1xuICAvLyBgcmVkb2AuIENhcHBlZCBzbyBpdCBjYW4ndCBncm93IHdpdGhvdXQgYm91bmQuXG4gIGNvbnN0IEhJU1RPUllfQ0FQID0gMTAwO1xuICAvLyBBIGhpc3RvcnkgZW50cnkgc25hcHNob3RzIEJPVEggdGhlIG1hcmtzIEFORCB0aGUgbGF5ZXIgY29udGFpbmVycyBmb3IgYVxuICAvLyB2YXJpYW50LCBzbyBhIGxheWVyIHJlbmFtZS9yZW9yZGVyL3Zpc2liaWxpdHkvZ3JvdXAgb3AgaXMgYXRvbWljYWxseSB1bmRvYWJsZVxuICAvLyBhbG9uZ3NpZGUgZWxlbWVudCBlZGl0cyAoY29udGFpbmVyIG1vZGVsIOKAlCBzZWUgdHlwZSBMYXllcikuXG4gIHR5cGUgTWFya1NuYXAgPSB7IG1hcmtzOiBNYXJrW107IGxheWVyczogTGF5ZXJbXSB9O1xuICBjb25zdCBtYXJrSGlzdG9yeTogUmVjb3JkPHN0cmluZywgeyB1bmRvOiBNYXJrU25hcFtdOyByZWRvOiBNYXJrU25hcFtdIH0+ID0ge307XG4gIGNvbnN0IGhpc3RGb3IgPSAodmlkOiBzdHJpbmcpID0+IChtYXJrSGlzdG9yeVt2aWRdID8/PSB7IHVuZG86IFtdLCByZWRvOiBbXSB9KTtcbiAgLy8gT05FIGZyZXNobmVzcyBmbGFnIHBlciB2YXJpYW50OiB0aGUgYWdlbnQgaGFzbid0IHNlZW4gdGhlc2UgbWFya3MgeWV0LiBTZXQgb25cbiAgLy8gZXZlcnkgbWFyayBjaGFuZ2U7IGNsZWFyZWQgd2hlbiB0aGUgYWdlbnQgcmVjZWl2ZXMgdGhlIG1hcmtlZCBpbWFnZSAoY29tbWl0XG4gIC8vIGJ1dHRvbiBPUiBhIHNheSB0aGF0IGNhcnJpZXMgaXQpLiBTZWUgSW1hZ29TdGF0ZS5tYXJrc1Vuc2Vlbi5cbiAgY29uc3QgbWFya1Vuc2VlbjogUmVjb3JkPHN0cmluZywgYm9vbGVhbj4gPSB7fTtcbiAgY29uc3Qgc25hcEZvciA9ICh2aWQ6IHN0cmluZyk6IE1hcmtTbmFwID0+ICh7XG4gICAgbWFya3M6IHN0cnVjdHVyZWRDbG9uZShzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdID8/IFtdKSxcbiAgICBsYXllcnM6IHN0cnVjdHVyZWRDbG9uZShzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXSA/PyBbXSksXG4gIH0pO1xuICBjb25zdCBwdXNoSGlzdG9yeSA9ICh2aWQ6IHN0cmluZyB8IHVuZGVmaW5lZCkgPT4ge1xuICAgIGlmICghdmlkKSByZXR1cm47XG4gICAgbWFya1Vuc2Vlblt2aWRdID0gdHJ1ZTsgLy8gYSBtYXJrL2xheWVyIGlzIGFib3V0IHRvIGNoYW5nZSDihpIgYWdlbnQncyB2aWV3IGlzIHN0YWxlXG4gICAgY29uc3QgaCA9IGhpc3RGb3IodmlkKTtcbiAgICBoLnVuZG8ucHVzaChzbmFwRm9yKHZpZCkpO1xuICAgIGlmIChoLnVuZG8ubGVuZ3RoID4gSElTVE9SWV9DQVApIGgudW5kby5zaGlmdCgpO1xuICAgIGgucmVkbyA9IFtdOyAvLyBhIGZyZXNoIGVkaXQgZm9ya3MgdGhlIHRpbWVsaW5lIOKAlCByZWRvIGlzIG5vIGxvbmdlciB2YWxpZFxuICB9O1xuICAvLyBDb250YWluZXIgbW9kZWw6IGV2ZXJ5IGVsZW1lbnQgYmVsb25ncyB0byBhIExheWVyLiBBIG5ldyB2ZWN0b3IgbWFyayBkcm9wc1xuICAvLyBpbnRvIHRoZSBhY3RpdmUgZHJhdyBsYXllciDigJQgdGhlIHRvcG1vc3QgTk9OLWltYWdlIGxheWVyIChkcmF3aW5nIFwiaW50b1wiIGFuXG4gIC8vIGltYWdlIGxheWVyIHJlYWRzIG9kZGx5KSwgY3JlYXRpbmcgYSBkZWZhdWx0IFwiQW5ub3RhdGlvbnNcIiBsYXllciBpZiB0aGVyZSdzXG4gIC8vIG5vIG5vbi1pbWFnZSBsYXllciB5ZXQgKGl0cyBwdXNoIGxhbmRzIGFib3ZlIGFueSBpbWFnZSBsYXllcnMsIHNvIGFubm90YXRpb25zXG4gIC8vIHBhaW50IG92ZXIgdGhlIGNvbGxhZ2UpLiBUaGUgYWN0aXZlIGxheWVyIGlzIG90aGVyd2lzZSBzdXJmYWNlLW93bmVkOiBtYXJrLmFkZFxuICAvLyBob25vcnMgYSB2YWxpZCBjbGllbnQgYG1hcmsubGF5ZXJJZGAgYW5kIG9ubHkgZmFsbHMgYmFjayB0byB0aGlzLiBDYWxsIEFGVEVSXG4gIC8vIHB1c2hIaXN0b3J5IHNvIHRoZSBhdXRvLWNyZWF0ZWQgbGF5ZXIgaXMgcGFydCBvZiB0aGUgc2FtZSB1bmRvYWJsZSBzdGVwLlxuICBjb25zdCBlbnN1cmVEcmF3TGF5ZXIgPSAodmlkOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuICAgIGlmICghc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0pIHN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdID0gW107XG4gICAgY29uc3QgbGF5ZXJzID0gc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF07XG4gICAgZm9yIChsZXQgaSA9IGxheWVycy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgICAgaWYgKGxheWVyc1tpXS5raW5kICE9PSBcImltYWdlXCIpIHJldHVybiBsYXllcnNbaV0uaWQ7XG4gICAgfVxuICAgIGNvbnN0IGxheWVyOiBMYXllciA9IHsgaWQ6IG5ld0lkKFwibGF5ZXJcIiksIG5hbWU6IFwiQW5ub3RhdGlvbnNcIiwga2luZDogXCJhbm5vdGF0aW9uXCIgfTtcbiAgICBsYXllcnMucHVzaChsYXllcik7XG4gICAgcmV0dXJuIGxheWVyLmlkO1xuICB9O1xuICAvLyDilIDilIAgY29udGV4dCBsaWJyYXJ5IGhlbHBlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIGZ1bmN0aW9uIGxpbmtDb250ZXh0KGlkOiBzdHJpbmcsIHNldDogQ29udGV4dFNldCkge1xuICAgIGlmICghc3RhdGUubGlicmFyeS5zb21lKChlKSA9PiBlLmlkID09PSBpZCkpIHJldHVybjtcbiAgICBjb25zdCBhcnIgPSBzZXQgPT09IFwiYWN0aXZlXCIgPyBzdGF0ZS5hY3RpdmVDb250ZXh0SWRzIDogc3RhdGUucXVpY2tQcm9tcHRJZHM7XG4gICAgaWYgKCFhcnIuaW5jbHVkZXMoaWQpKSBhcnIucHVzaChpZCk7XG4gIH1cbiAgZnVuY3Rpb24gdW5saW5rQ29udGV4dChpZDogc3RyaW5nLCBzZXQ6IENvbnRleHRTZXQpIHtcbiAgICBpZiAoc2V0ID09PSBcImFjdGl2ZVwiKSBzdGF0ZS5hY3RpdmVDb250ZXh0SWRzID0gc3RhdGUuYWN0aXZlQ29udGV4dElkcy5maWx0ZXIoKHgpID0+IHggIT09IGlkKTtcbiAgICBlbHNlIHN0YXRlLnF1aWNrUHJvbXB0SWRzID0gc3RhdGUucXVpY2tQcm9tcHRJZHMuZmlsdGVyKCh4KSA9PiB4ICE9PSBpZCk7XG4gIH1cbiAgLy8gQ3JlYXRlIGEgbGlicmFyeSBlbnRyeSwgb3IgcmVwb3J0IHdoeSBpdCBkaWQgbm90IGNyZWF0ZSBvbmUuXG4gIC8vXG4gIC8vIGI5IOKAlCB0aGlzIHVzZWQgdG8gYmUgYW4gVVBTRVJUIG9uIHRoZSBzdHlsZSBwYXRoOiBhbiBhZGQgd2hvc2UgbmFtZVxuICAvLyBub3JtYWxpemVkIG9udG8gYW4gZXhpc3Rpbmcgc3R5bGUgT1ZFUldST1RFIHRoYXQgZW50cnkncyBjb250ZW50LCB0YWdzIGFuZFxuICAvLyBpbWFnZSwgcmV0dXJuZWQgdGhlIGV4aXN0aW5nIGlkLCBhbmQgYW5zd2VyZWQgYXBwbGllZDp0cnVlLiBTaWxlbnQgZGF0YVxuICAvLyBsb3NzIG9uIGEgdmVyYiBjYWxsZWQgYGFkZGAsIGluIGEgaHVtYW4tcHJpbWFyeSBzcGVsbC4gSXQgYWxzbyBtYWRlIHRoZVxuICAvLyBkb2N1bWVudGVkIHJlY292ZXJ5IGZvciAjODcgKGRpZmYgdGhlIGJvYXJkIHRvIGZpbmQgdGhlIG5ldyBlbnRyeSlcbiAgLy8gQ09ORklERU5UTFkgV1JPTkcgaW4gZXhhY3RseSB0aGUgZGVzdHJ1Y3RpdmUgY2FzZTogdGhlIGxpYnJhcnkgY291bnQgaXNcbiAgLy8gdW5jaGFuZ2VkLCBzbyBhIGRpZmYgcmVwb3J0cyBcIm5vdGhpbmcgd2FzIGNyZWF0ZWRcIiDigJQgdHJ1ZSBmb3IgYSByZWplY3RlZFxuICAvLyBhZGQsIGZhbHNlIGZvciBvbmUgdGhhdCBoYWQganVzdCBkZXN0cm95ZWQgYSBodW1hbidzIHN0eWxlLlxuICAvL1xuICAvLyBUaHJlZSBvdXRjb21lcyBub3csIGFuZCB0aGUgY2FsbGVyIGNhbiB0ZWxsIHRoZW0gYXBhcnQgKGdyaW1vaXJlL1xuICAvLyBvdXRjb21lLWNvbnRyYWN0Lm1kKTpcbiAgLy8gICBjcmVhdGVkICAgICAgICAgIGEgbmV3IGVudHJ5IGV4aXN0czsgYGlkYCBpcyBuZXdcbiAgLy8gICBhbHJlYWR5LXJlY29yZGVkIHRoZSBuYW1lIGlzIHRha2VuIGFuZCBob25vcmluZyB0aGlzIGFkZCB3b3VsZCBjaGFuZ2VcbiAgLy8gICAgICAgICAgICAgICAgICAgIE5PVEhJTkcg4oCUIG5vIHdyaXRlIGhhcHBlbmVkLCBgaWRgIGlzIHRoZSBleGlzdGluZyBlbnRyeVxuICAvLyAgIHJlZnVzZWQgICAgICAgICAgdGhlIG5hbWUgaXMgdGFrZW4gYW5kIGhvbm9yaW5nIGl0IFdPVUxEIGNoYW5nZSB0aGUgZW50cnlcbiAgLy9cbiAgLy8g4puUIFRoZSByZWZ1c2FsIGlzIGRlbGliZXJhdGUgYW5kIGl0IGlzIHRoZSBjYXJkJ3MgaW5zdHJ1Y3Rpb246IHdoZXJlIHRoZVxuICAvLyBzYWZlIGJlaGF2aW91ciBpcyBhbWJpZ3VvdXMsIFJFRlVTRSBBTkQgUkVQT1JUIHJhdGhlciB0aGFuIGd1ZXNzLCBiZWNhdXNlIGFcbiAgLy8gcmVmdXNhbCBpcyByZWNvdmVyYWJsZSBhbmQgYW4gb3ZlcndyaXRlIGlzIG5vdC4gYGNvbnRleHQudXBkYXRlYCBhbHJlYWR5XG4gIC8vIGV4aXN0cyBmb3IgY2FsbGVycyB0aGF0IGdlbnVpbmVseSBtZWFuIHRvIGNoYW5nZSBhbiBlbnRyeS5cbiAgLy9cbiAgLy8gTk9UIERFU0lHTkVEIEhFUkUsIG9uIHB1cnBvc2U6IHdoZXRoZXIgYW4gYWdlbnQgc2hvdWxkIGJlIGFibGUgdG8gdXBkYXRlIGFcbiAgLy8gc3R5bGUgdGhyb3VnaCBgYWRkYCBhdCBhbGwg4oCUIGEgZmxhZywgYSBzZXBhcmF0ZSB2ZXJiLCBhIHByb21wdC4gVGhhdFxuICAvLyBjaGFuZ2VzIHdoYXQgYSBodW1hbiBzZWVzIGFuZCBpcyBDb2xlJ3MgY2FsbCwgbm90IHRoZSB3aXJlJ3MuXG4gIHR5cGUgQWdlbnRWZXJkaWN0ID1cbiAgICB8IGJvb2xlYW5cbiAgICB8IHsgcmVjb2duaXNlZDogdHJ1ZTsgb2s6IHRydWU7IGRldGFpbDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfVxuICAgIHwge1xuICAgICAgICByZWNvZ25pc2VkOiB0cnVlO1xuICAgICAgICBvazogZmFsc2U7XG4gICAgICAgIHN0YXR1czogbnVtYmVyO1xuICAgICAgICBlcnJvcjogc3RyaW5nO1xuICAgICAgICBkZXRhaWw/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIH07XG5cbiAgdHlwZSBBZGRDb250ZXh0UmVzdWx0ID1cbiAgICB8IHsgb2s6IHRydWU7IGlkOiBzdHJpbmc7IG91dGNvbWU6IFwiY3JlYXRlZFwiIHwgXCJhbHJlYWR5LXJlY29yZGVkXCIgfVxuICAgIHwge1xuICAgICAgICBvazogdHJ1ZTtcbiAgICAgICAgaWQ6IHN0cmluZztcbiAgICAgICAgb3V0Y29tZTogXCJ1cGRhdGVkXCI7XG4gICAgICAgIGNoYW5nZWQ6IHN0cmluZ1tdO1xuICAgICAgICBwcmV2aW91czogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICB9XG4gICAgfCB7IG9rOiBmYWxzZTsgZXJyb3I6IHN0cmluZzsgaWQ/OiBzdHJpbmcgfTtcblxuICBmdW5jdGlvbiBhZGRDb250ZXh0RW50cnkobXNnOiB7XG4gICAga2luZDogQ29udGV4dEtpbmQ7XG4gICAgbmFtZTogc3RyaW5nO1xuICAgIGNvbnRlbnQ/OiBzdHJpbmc7XG4gICAgdGFncz86IHN0cmluZ1tdO1xuICAgIGltYWdlPzogc3RyaW5nO1xuICB9KTogQWRkQ29udGV4dFJlc3VsdCB7XG4gICAgaWYgKHR5cGVvZiBtc2cubmFtZSAhPT0gXCJzdHJpbmdcIiB8fCAhbXNnLm5hbWUudHJpbSgpKVxuICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogXCJjb250ZXh0LmFkZCByZXF1aXJlcyBhIG5vbi1lbXB0eSBuYW1lXCIgfTtcbiAgICBjb25zdCBjb250ZW50ID0gdHlwZW9mIG1zZy5jb250ZW50ID09PSBcInN0cmluZ1wiID8gbXNnLmNvbnRlbnQgOiBcIlwiO1xuICAgIGNvbnN0IHRhZ3MgPSBBcnJheS5pc0FycmF5KG1zZy50YWdzKSA/IG1zZy50YWdzIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IGltYWdlU3JjID1cbiAgICAgIHR5cGVvZiBtc2cuaW1hZ2UgPT09IFwic3RyaW5nXCIgJiYgbXNnLmltYWdlLnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSA/IG1zZy5pbWFnZSA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCBpbWFnZVBhdGggPSBpbWFnZVNyY1xuICAgICAgPyBzYXZlRGF0YVVybChzZXNzaW9uRmlsZXNEaXIsIG5ld0lkKFwiY3R4XCIpLCBpbWFnZVNyYykgfHwgdW5kZWZpbmVkXG4gICAgICA6IHVuZGVmaW5lZDtcbiAgICBpZiAobXNnLmtpbmQgPT09IFwic3R5bGVcIikge1xuICAgICAgY29uc3QgbmFtZSA9IG5vcm1TdHlsZShtc2cubmFtZSk7XG4gICAgICBjb25zdCBleGlzdGluZyA9IHN0YXRlLmxpYnJhcnkuZmluZCgoZSkgPT4gZS5raW5kID09PSBcInN0eWxlXCIgJiYgbm9ybVN0eWxlKGUubmFtZSkgPT09IG5hbWUpO1xuICAgICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICAgIC8vIFRoZSB1cHNlcnQgU1RBWVMg4oCUIGl0IGlzIGEgZGVzaWduZWQsIHRlc3RlZCBjYXBhYmlsaXR5LCBhbmQgcmVmdXNpbmdcbiAgICAgICAgLy8gaXQgd291bGQgYW5zd2VyIGEgcXVlc3Rpb24gcmVzZXJ2ZWQgZm9yIENvbGUgKFwic2hvdWxkIGFuIGFnZW50IGJlIGFibGVcbiAgICAgICAgLy8gdG8gdXBkYXRlIGEgc3R5bGUgdGhyb3VnaCBhZGQ/XCIpIHdoaWxlIGNhbGxpbmcgdGhhdCBuZXV0cmFsaXR5LlxuICAgICAgICAvL1xuICAgICAgICAvLyBXaGF0IGNoYW5nZXMgaXMgdGhhdCBpdCBpcyBubyBsb25nZXIgU0lMRU5ULCBhbmQgbm8gbG9uZ2VyXG4gICAgICAgIC8vIHVucmVjb3ZlcmFibGU6IHRoZSByZXN1bHQgbmFtZXMgZWFjaCBmaWVsZCBpdCBvdmVyd3JvdGUgYW5kIGNhcnJpZXNcbiAgICAgICAgLy8gdGhhdCBmaWVsZCdzIFBSSU9SIFZBTFVFLCBzbyB0aGUgY2FsbGVyIGNhbiBwdXQgaXQgYmFjay4gVGhhdCBjb252ZXJ0c1xuICAgICAgICAvLyBhbiB1bnJlY292ZXJhYmxlIHdyaXRlIGludG8gYSByZWNvdmVyYWJsZSBvbmUgYXQgdGhlIHdpcmUgbGV2ZWwg4oCUXG4gICAgICAgIC8vIHdoaWNoIGlzIG91cnMg4oCUIHdpdGhvdXQgdG91Y2hpbmcgdGhlIGNhcGFiaWxpdHksIHdoaWNoIGlzIG5vdC5cbiAgICAgICAgY29uc3QgY2hhbmdlZDogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgY29uc3QgcHJldmlvdXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgICAgIGlmIChjb250ZW50ICYmIGNvbnRlbnQgIT09IGV4aXN0aW5nLmNvbnRlbnQpIHtcbiAgICAgICAgICBjaGFuZ2VkLnB1c2goXCJjb250ZW50XCIpO1xuICAgICAgICAgIHByZXZpb3VzLmNvbnRlbnQgPSBleGlzdGluZy5jb250ZW50O1xuICAgICAgICAgIGV4aXN0aW5nLmNvbnRlbnQgPSBjb250ZW50O1xuICAgICAgICB9XG4gICAgICAgIGlmICh0YWdzICYmIEpTT04uc3RyaW5naWZ5KHRhZ3MpICE9PSBKU09OLnN0cmluZ2lmeShleGlzdGluZy50YWdzKSkge1xuICAgICAgICAgIGNoYW5nZWQucHVzaChcInRhZ3NcIik7XG4gICAgICAgICAgcHJldmlvdXMudGFncyA9IGV4aXN0aW5nLnRhZ3M7XG4gICAgICAgICAgZXhpc3RpbmcudGFncyA9IHRhZ3M7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGltYWdlU3JjICYmIGltYWdlU3JjICE9PSBleGlzdGluZy5pbWFnZSkge1xuICAgICAgICAgIGNoYW5nZWQucHVzaChcImltYWdlXCIpO1xuICAgICAgICAgIC8vIFRoZSBQQVRILCBub3QgdGhlIGJsb2IuIHNhdmVEYXRhVXJsIGFscmVhZHkgcGVyc2lzdGVkIHRoZSBwcmlvclxuICAgICAgICAgIC8vIGltYWdlIHRvIGRpc2ssIHNvIHRoZSBwYXRoIGlzIGEgY29tcGxldGUgcmVjb3ZlcnkgaGFuZGxlIGFuZCBlY2hvaW5nXG4gICAgICAgICAgLy8gYSBiYXNlNjQgZGF0YSBVUkwgYmFjayB0aHJvdWdoIHRoZSBlbnZlbG9wZSBjb3VsZCBiZSBtZWdhYnl0ZXMuIEFcbiAgICAgICAgICAvLyByZWNvdmVyeSBhZmZvcmRhbmNlIHRoYXQgaXMgdG9vIGhlYXZ5IHRvIHNlbmQgaXMgbm90IG9uZS5cbiAgICAgICAgICBwcmV2aW91cy5pbWFnZSA9IGV4aXN0aW5nLmltYWdlUGF0aCA/PyBudWxsO1xuICAgICAgICAgIGV4aXN0aW5nLmltYWdlID0gaW1hZ2VTcmM7XG4gICAgICAgICAgZXhpc3RpbmcuaW1hZ2VQYXRoID0gaW1hZ2VQYXRoO1xuICAgICAgICAgIGV4aXN0aW5nLmNhcHR1cmVkID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICAvLyBOYW1lIHRha2VuIGFuZCBub3RoaW5nIHdvdWxkIGNoYW5nZTogdGhlIHdvcmsgd2FzIHVubmVjZXNzYXJ5IGFuZCBOT1xuICAgICAgICAvLyBXUklURSBoYXBwZW5lZC4gRGlzdGluY3QgZnJvbSBgdXBkYXRlZGAsIHdoZXJlIGEgd3JpdGUgZGlkLlxuICAgICAgICBpZiAoIWNoYW5nZWQubGVuZ3RoKSByZXR1cm4geyBvazogdHJ1ZSwgaWQ6IGV4aXN0aW5nLmlkLCBvdXRjb21lOiBcImFscmVhZHktcmVjb3JkZWRcIiB9O1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgaWQ6IGV4aXN0aW5nLmlkLCBvdXRjb21lOiBcInVwZGF0ZWRcIiwgY2hhbmdlZCwgcHJldmlvdXMgfTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGlkID0gbmV3SWQoXCJjdHhcIik7XG4gICAgICBzdGF0ZS5saWJyYXJ5LnB1c2goe1xuICAgICAgICBpZCxcbiAgICAgICAga2luZDogXCJzdHlsZVwiLFxuICAgICAgICBuYW1lLFxuICAgICAgICBjb250ZW50LFxuICAgICAgICB0YWdzLFxuICAgICAgICBpbWFnZTogaW1hZ2VTcmMsXG4gICAgICAgIGltYWdlUGF0aCxcbiAgICAgICAgY2FwdHVyZWQ6IGltYWdlU3JjID8gdHJ1ZSA6IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGlkLCBvdXRjb21lOiBcImNyZWF0ZWRcIiB9O1xuICAgIH1cbiAgICBjb25zdCBpZCA9IG5ld0lkKFwiY3R4XCIpO1xuICAgIHN0YXRlLmxpYnJhcnkucHVzaCh7XG4gICAgICBpZCxcbiAgICAgIGtpbmQ6IG1zZy5raW5kLFxuICAgICAgbmFtZTogbXNnLm5hbWUudHJpbSgpLFxuICAgICAgY29udGVudCxcbiAgICAgIHRhZ3MsXG4gICAgICBpbWFnZTogaW1hZ2VTcmMsXG4gICAgICBpbWFnZVBhdGgsXG4gICAgfSk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIGlkLCBvdXRjb21lOiBcImNyZWF0ZWRcIiB9O1xuICB9XG5cbiAgLy8gQSBzaW5nbGUgZWxlbWVudCdzIG5hdHVyYWwgY29udGFpbmVyIGtpbmQgKyBsYWJlbCAodXNlZCBieSBncm91cC91bmdyb3VwKS5cbiAgY29uc3Qga2luZEZvclRvb2wgPSAodG9vbDogTWFya1tcInRvb2xcIl0pOiBMYXllcltcImtpbmRcIl0gPT5cbiAgICB0b29sID09PSBcImltYWdlXCIgPyBcImltYWdlXCIgOiB0b29sID09PSBcImRyYXdcIiA/IFwic2tldGNoXCIgOiBcImFubm90YXRpb25cIjtcbiAgY29uc3QgVE9PTF9MQUJFTDogUmVjb3JkPE1hcmtbXCJ0b29sXCJdLCBzdHJpbmc+ID0ge1xuICAgIHBpbjogXCJQaW5cIixcbiAgICBhcnJvdzogXCJBcnJvd1wiLFxuICAgIGxpbmU6IFwiTGluZVwiLFxuICAgIHJlY3Q6IFwiUmVjdGFuZ2xlXCIsXG4gICAgZWxsaXBzZTogXCJFbGxpcHNlXCIsXG4gICAgZHJhdzogXCJTa2V0Y2hcIixcbiAgICBpbWFnZTogXCJJbWFnZVwiLFxuICB9O1xuICBpZiAodi5yZXN0b3JlKSB7XG4gICAgY29uc3QgcmVzdG9yZVBhdGggPSBleGlzdHNTeW5jKHYucmVzdG9yZSBhcyBzdHJpbmcpXG4gICAgICA/ICh2LnJlc3RvcmUgYXMgc3RyaW5nKVxuICAgICAgOiBqb2luKFNOQVBTSE9UU19ESVIsIGAke3YucmVzdG9yZX0uanNvbmApO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzbmFwID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocmVzdG9yZVBhdGgsIFwidXRmOFwiKSkgYXMgUGFydGlhbDxJbWFnb1N0YXRlPjtcbiAgICAgIC8vIE1lcmdlIG92ZXIgZGVmYXVsdHMgc28gc25hcHNob3RzIGZyb20gb2xkZXIgYnVpbGRzIGdhaW4gbmV3IGZpZWxkcy5cbiAgICAgIHN0YXRlID0geyAuLi5kZWZhdWx0U3RhdGUodi50aXRsZSBhcyBzdHJpbmcpLCAuLi5zbmFwIH0gYXMgSW1hZ29TdGF0ZTtcbiAgICAgIHJlc3RvcmVkID0gdHJ1ZTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgYGltYWdvOiByZXN0b3JlIGZhaWxlZCAoJHtyZXN0b3JlUGF0aH0pOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG5gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgY29uc3Qgc29ja2V0cyA9IG5ldyBTZXQ8U2VydmVyV2ViU29ja2V0PHVua25vd24+PigpO1xuXG4gIC8vIFRoZSByZXBsYXkgbG9nIGJlaGluZCBgR0VUIC9ldmVudHM/c2luY2U9PGlkPmAg4oCUIHNoYXJlZFxuICAvLyAoYGtpdC93aXJlL2V2ZW50TG9nLnRzYCkuIOKblCBUSFJFRSBDRU5TVVMgREVGRUNUUyBESUUgSEVSRSBBTkQgTk9ORSBPRiBUSEVNXG4gIC8vIEJZIEFOWU9ORSBSRU1FTUJFUklORzpcbiAgLy8gICDCtyBMNSDigJQgdGhlIGJ1ZmZlciB3YXMgYGNvbnN0IGV2ZW50czogQXJyYXk84oCmPiA9IFtdYCwgcHVzaGVkIGZvciB0aGVcbiAgLy8gICAgIGRhZW1vbidzIHdob2xlIGxpZmUuIEl0IGlzIG5vdyBib3VuZGVkIGF0IDEsMDAwIGZyYW1lcy5cbiAgLy8gICDCtyB0aGUgbW9ub3RvbmljIGlkIG5vdyBhY3R1YWxseSBXSU5TIG92ZXIgYSBwYXlsb2FkIGBpZGAuIFRoZSBvbGRcbiAgLy8gICAgIGB7IGlkOiArK2V2ZW50U2VxLCAuLi5tc2cgfWAgc3ByZWFkIEFGVEVSIHRoZSBpZCwgc28gYW55IGNhbGxlciBwYXNzaW5nXG4gIC8vICAgICBhbiBgaWRgIHNpbGVudGx5IG92ZXJyb2RlIHRoZSBjdXJzb3Ig4oCUIGFuZCBpbWFnbydzIGZyYW1lcyBkbyBjYXJyeSBpZHNcbiAgLy8gICAgIChgeyB0eXBlOiBcInByb3Bvc2FsLnNlbmRcIiwgaWQ6IG1zZy5pZCB9YCksIHdoaWNoIG1hZGUgdGhpcyBsaXZlIHJhdGhlclxuICAvLyAgICAgdGhhbiB0aGVvcmV0aWNhbDogdGhvc2UgdHdvIGZyYW1lcyB3ZW50IG91dCB3aXRoIHRoZSBQUk9QT1NBTCdzIGlkIGFzXG4gIC8vICAgICB0aGVpciBjdXJzb3IgdmFsdWUsIGFuZCBzaW5jZSBhIHN0cmluZyBpcyBuZXZlciBgPiBzaW5jZWAsIE5FSVRIRVIgV0FTXG4gIC8vICAgICBFVkVSIFJFUExBWUVELiBGaXhlZCBieSBjb25zdHJ1Y3Rpb24g4oCUIGFuZCB0aGUgY29sbGlzaW9uIGlzIGdvbmUgb24gdGhlXG4gIC8vICAgICBvdGhlciBzaWRlIHRvbzogdGhlIHByb3Bvc2FsJ3MgaWRlbnRpdHkgbm93IHJpZGVzIGFzIGBwcm9wb3NhbElkYCwgc29cbiAgLy8gICAgIHRoZSBmcmFtZSBjYXJyaWVzIHRoZSBjdXJzb3IgQU5EIHRoZSBwcm9wb3NhbC4gUmVzb2x2aW5nIGEgY29sbGlzaW9uIGluXG4gIC8vICAgICBvbmUgZmllbGQncyBmYXZvdXIgaXMgYSBmaWVsZCBzaWxlbnRseSBkZWxldGVkOyByZW5hbWUsIGRvbid0IHBpY2suXG4gIC8vICAgwrcgYSBgP3NpbmNlPWAgdGhhdCB3aWxsIG5vdCBwYXJzZSB1c2VkIHRvIHlpZWxkIE5hTiwgZmFpbCBldmVyeSBgPmBcbiAgLy8gICAgIGNvbXBhcmlzb24sIGFuZCBvcGVuIHRoZSB0YWlsIEVNUFRZIGFuZCBjb25uZWN0ZWQuIEFic2VudCBhbmRcbiAgLy8gICAgIHVucGFyc2VhYmxlIG5vdyBtZWFuIHRoZSBzYW1lIHRoaW5nOiBmcm9tIHRoZSBzdGFydC5cbiAgLy9cbiAgLy8g4pqgIElNQUdPIFNUQU1QUyBOTyBFUE9DSCwgYW5kIHRoYXQgaXMgZ2xhbW91cidzIHJ1bGluZyBmb3IgZ2xhbW91cidzIHJlYXNvbixcbiAgLy8gd2hpY2ggaXMgaW1hZ28ncyB0b286IGEgc2Vzc2lvbiBpcyBpZGVudGlmaWVkIGJ5IGBzZXNzaW9uX2lkYCwgYSByZXN0YXJ0IGlzXG4gIC8vIGEgRElGRkVSRU5UIHNlc3Npb24sIGFuZCBhIHJlc3VtaW5nIHRhaWwgaXMgYWxyZWFkeSB0YWxraW5nIHRvIGEgZGlmZmVyZW50XG4gIC8vIGRhZW1vbiBieSBuYW1lLiBDZW5zdXMgZGVmZWN0IEw2IGlzIHRoZXJlZm9yZSBOQVJST1dFRCBoZXJlIHJhdGhlciB0aGFuXG4gIC8vIGNsb3NlZCDigJQgYHN1YnNjcmliZWAgdHJlYXRpbmcgYHNpbmNlID4gY3Vyc29yYCBhcyBcInRoYXQgY3Vyc29yIGlzIGZyb21cbiAgLy8gYW5vdGhlciBwcm9jZXNzXCIgaXMgd2hhdCBhIHJlc3VtaW5nIHRhaWwgYWN0dWFsbHkgZ2V0cyDigJQgYW5kIHRoZSBlcG9jaCBxdWVyeVxuICAvLyBwYXJhbWV0ZXIgdGhhdCB3b3VsZCBjbG9zZSBpdCBpcyBkZWxpYmVyYXRlbHkgb3V0IG9mIHNjb3BlIChEMjMpLlxuICBjb25zdCBsb2cgPSBjcmVhdGVFdmVudExvZzxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oKTtcbiAgY29uc3Qgc3NlQ2xpZW50czogU3NlQ2xpZW50cyA9IG5ldyBTZXQoKTtcblxuICBsZXQgcmVzb2x2ZURvbmUhOiAodmFsOiBEb25lUmVzdWx0KSA9PiB2b2lkO1xuICBsZXQgc2V0dGxlZCA9IGZhbHNlO1xuICBjb25zdCBkb25lID0gbmV3IFByb21pc2U8RG9uZVJlc3VsdD4oKHJlcykgPT4ge1xuICAgIHJlc29sdmVEb25lID0gKHZhbCkgPT4ge1xuICAgICAgaWYgKHNldHRsZWQpIHJldHVybjtcbiAgICAgIHNldHRsZWQgPSB0cnVlO1xuICAgICAgcmVzKHZhbCk7XG4gICAgfTtcbiAgfSk7XG5cbiAgbGV0IGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICBjb25zdCB0b3VjaCA9ICgpID0+IHtcbiAgICBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgfTtcblxuICBjb25zdCBlbWl0RXZlbnQgPSAobXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gbG9nLmVtaXQobXNnKTtcblxuICAvLyBQcmVzZW5jZSBpcyBUUkFOU0lFTlQ6IGl0IGdvZXMgdG8gdGhlIGxpdmUgU1NFIGNsaWVudHMgYW5kIGlzIE5FVkVSIHN0b3JlZFxuICAvLyBpbiB0aGUgcmVwbGF5IGxvZyDigJQgY2Vuc3VzIGRlZmVjdCBMNywgd2hpY2ggaW1hZ28gaGFkLiBBIHJlY29ubmVjdGluZyBhZ2VudFxuICAvLyBzaG91bGQgbm90IHJlLXNlZSBldmVyeSBwYXN0IGNvbm5lY3QvZGlzY29ubmVjdCwgYW5kIHRoZXNlIGZyYW1lcyBjYXJyeSBub1xuICAvLyBpZCwgc28gdGhleSBuZXZlciBhZHZhbmNlIGEgdGFpbCBjdXJzb3IgZWl0aGVyLiBTS0lMTC5tZCdzIGRvY3VtZW50ZWQgd2FrZVxuICAvLyBncmVwIHN0aWxsIHJlY2VpdmVzIHRoZW0gbGl2ZSwgd2hpY2ggaXMgYWxsIGl0IGV2ZXIgd2FudGVkIHRoZW0gZm9yLlxuICAvL1xuICAvLyDim5QgYGNsaWVudC5zZW5kYCBJUyBUSEUgTUVNQkVSIFRIQVQgTUFLRVMgVEhJUyBQT1NTSUJMRSBXSVRIT1VUIEEgU0VDT05EXG4gIC8vIFJFR0lTVFJZLiBQaGFzZSAyIHdpZGVuZWQgYFNzZUNsaWVudHNgIGZvciBleGFjdGx5IHRoaXMg4oCUIGtlZXBpbmcgYSBwYXJhbGxlbFxuICAvLyBgU2V0PFJlYWRhYmxlU3RyZWFtRGVmYXVsdENvbnRyb2xsZXI+YCBoZXJlIHdvdWxkIHJlLWNyZWF0ZSB0aGUgZHJpZnQgdGhlXG4gIC8vIHJlZ2lzdHJ5IGV4aXN0cyB0byByZW1vdmUsIGFuZCBpdCBpcyB0aGUgZHJpZnQgaW1hZ28ncyBPTEQgY29kZSBoYWQ6IHR3b1xuICAvLyBzZXRzIChgc3NlQ2xpZW50c2AsIGBzc2VUaW1lcnNgKSBzd2VwdCBpbiB0d28gcGxhY2VzIGF0IHRlYXJkb3duLlxuICBjb25zdCBlbWl0VHJhbnNpZW50ID0gKG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICBjb25zdCBmcmFtZSA9IGBkYXRhOiAke0pTT04uc3RyaW5naWZ5KG1zZyl9XFxuXFxuYDtcbiAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykgYy5zZW5kKGZyYW1lKTtcbiAgfTtcblxuICBmdW5jdGlvbiBicm9hZGNhc3QobXNnOiBvYmplY3QpIHtcbiAgICBjb25zdCBzID0gSlNPTi5zdHJpbmdpZnkobXNnKTtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLnNlbmQocyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogc29ja2V0IGNsb3NlZCAqL1xuICAgICAgfVxuICAgIH1cbiAgfVxuICBsZXQgc25hcERpcnR5ID0gZmFsc2U7XG4gIGNvbnN0IGJyb2FkY2FzdFN0YXRlID0gKCkgPT4ge1xuICAgIHNuYXBEaXJ0eSA9IHRydWU7IC8vIG1hcmsgZm9yIHRoZSBwZXJzaXN0ZW5jZSBzbmFwc2hvdFxuICAgIC8vIGRlcml2ZSB1bmRvL3JlZG8gYXZhaWxhYmlsaXR5IGZvciB0aGUgZm9jdXNlZCB2YXJpYW50IChrZXB0IGZyZXNoIGhlcmUgc29cbiAgICAvLyB0aGUgdG9vbGJhciBidXR0b25zIHJlZmxlY3QgdGhlIGxpdmUgaGlzdG9yeSB3aXRob3V0IGEgc2VwYXJhdGUgY2hhbm5lbClcbiAgICBjb25zdCBoID0gc3RhdGUuZm9jdXMgPyBtYXJrSGlzdG9yeVtzdGF0ZS5mb2N1cy52YXJpYW50SWRdIDogdW5kZWZpbmVkO1xuICAgIHN0YXRlLmhpc3RvcnkgPSB7IGNhblVuZG86IChoPy51bmRvLmxlbmd0aCA/PyAwKSA+IDAsIGNhblJlZG86IChoPy5yZWRvLmxlbmd0aCA/PyAwKSA+IDAgfTtcbiAgICBzdGF0ZS5tYXJrc1Vuc2VlbiA9IHN0YXRlLmZvY3VzID8gKG1hcmtVbnNlZW5bc3RhdGUuZm9jdXMudmFyaWFudElkXSA/PyBmYWxzZSkgOiBmYWxzZTtcbiAgICBicm9hZGNhc3QoeyB0eXBlOiBcInN0YXRlXCIsIHN0YXRlIH0pO1xuICB9O1xuXG4gIGxldCBzZXNzaW9uRmlsZXNEaXIgPSBcIlwiOyAvLyBzZXQgb25jZSBzZXNzaW9uSWQgaXMga25vd24gKGFmdGVyIGJpbmQpXG4gIGNvbnN0IHNhdmVTbmFwc2hvdCA9ICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgbWtkaXJTeW5jKFNOQVBTSE9UU19ESVIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKFNOQVBTSE9UU19ESVIsIGAke3Nlc3Npb25JZH0uanNvbmApLCBKU09OLnN0cmluZ2lmeShzdGF0ZSkpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogcGVyc2lzdGVuY2UgaXMgYmVzdC1lZmZvcnQgKi9cbiAgICB9XG4gIH07XG5cbiAgLy8g4pSA4pSAIGhlbHBlcnMgb3ZlciB0aGUgY2Fub25pY2FsIHN0YXRlIOKUgOKUgFxuICBjb25zdCBmaW5kQmF0Y2ggPSAoaWQ6IHN0cmluZykgPT4gc3RhdGUuYmF0Y2hlcy5maW5kKChiKSA9PiBiLmlkID09PSBpZCk7XG4gIGZ1bmN0aW9uIGZpbmRWYXJpYW50KGlkOiBzdHJpbmcpOiB7IGJhdGNoOiBCYXRjaDsgdmFyaWFudDogVmFyaWFudDsgaW5kZXg6IG51bWJlciB9IHwgbnVsbCB7XG4gICAgZm9yIChjb25zdCBiIG9mIHN0YXRlLmJhdGNoZXMpIHtcbiAgICAgIGNvbnN0IGluZGV4ID0gYi52YXJpYW50cy5maW5kSW5kZXgoKHgpID0+IHguaWQgPT09IGlkKTtcbiAgICAgIGlmIChpbmRleCA+PSAwKSByZXR1cm4geyBiYXRjaDogYiwgdmFyaWFudDogYi52YXJpYW50c1tpbmRleF0sIGluZGV4IH07XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGNvbnN0IGxhYmVsT2YgPSAoaTogbnVtYmVyKSA9PiBTdHJpbmcuZnJvbUNoYXJDb2RlKDk3ICsgaSk7XG4gIC8vIFRoZSByZWZlcmVuY2VzIFwic2V0XCIgaXMganVzdCB0aGUgdmFyaWFudHMgZmxhZ2dlZCByZWZTZWxlY3RlZCAob25lIHNvdXJjZSBvZlxuICAvLyB0cnV0aDsgdXNlZCBieSBib3RoIHRoZSBzYXkgKyBtYXJrcy5jb21taXQgaGFuZG9mZnMpLiBTZWUgcmVmcy1hcy1hc3NldHMgcGxhbi5cbiAgY29uc3Qgc2VsZWN0ZWRSZWZJZHMgPSAoKTogc3RyaW5nW10gPT5cbiAgICBzdGF0ZS5iYXRjaGVzXG4gICAgICAuZmxhdE1hcCgoYikgPT4gYi52YXJpYW50cylcbiAgICAgIC5maWx0ZXIoKHYpID0+IHYucmVmU2VsZWN0ZWQpXG4gICAgICAubWFwKCh2KSA9PiB2LmlkKTtcbiAgLy8gSW1wb3J0IGFuIGV4dGVybmFsIGltYWdlIGFzIGEgb25lLXZhcmlhbnQgaW1wb3J0LWtpbmQgYmF0Y2gg4oCUIHRoZSB1bmlmaWVkIHBhdGhcbiAgLy8gZm9yIFwiYnJpbmcgaW4gYSB3b3JraW5nIGltYWdlXCIgQU5EIFwiYWRkIGEgcmVmZXJlbmNlXCIuIEhhc2hlcyBmb3IgZGVkdXAgK1xuICAvLyBhbmFseXNpc0NhY2hlOyBpZiB0aGUgc2FtZSBwaXhlbHMgYXJlIGFscmVhZHkgaW1wb3J0ZWQsIHJldHVybnMgdGhlIGV4aXN0aW5nXG4gIC8vIHZhcmlhbnQgKG5vIGR1cGxpY2F0ZSkuIENhbGxlciBkZWNpZGVzIGZvY3VzL3JlZlNlbGVjdGVkLlxuICBmdW5jdGlvbiBpbXBvcnRJbWFnZVZhcmlhbnQoc3JjOiBzdHJpbmcsIG5hbWU/OiBzdHJpbmcpOiB7IGJhdGNoSWQ6IHN0cmluZzsgdmFyaWFudDogVmFyaWFudCB9IHtcbiAgICBjb25zdCBoYXNoID0gY29udGVudEhhc2goc3JjKTtcbiAgICBmb3IgKGNvbnN0IGIgb2Ygc3RhdGUuYmF0Y2hlcykge1xuICAgICAgY29uc3QgZXggPSBiLnZhcmlhbnRzLmZpbmQoKHYpID0+IHYuaGFzaCA9PT0gaGFzaCk7XG4gICAgICBpZiAoZXgpIHtcbiAgICAgICAgaWYgKG5hbWUgJiYgIWV4Lm5hbWUpIGV4Lm5hbWUgPSBuYW1lOyAvLyBmaWxsIGEgbWlzc2luZyBuYW1lIG9uIGEgZGVkdXAgaGl0XG4gICAgICAgIHJldHVybiB7IGJhdGNoSWQ6IGIuaWQsIHZhcmlhbnQ6IGV4IH07XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHZpZCA9IG5ld0lkKFwidlwiKTtcbiAgICBjb25zdCBiYXRjaElkID0gbmV3SWQoXCJiXCIpO1xuICAgIGNvbnN0IHZhcmlhbnQ6IFZhcmlhbnQgPSB7XG4gICAgICBpZDogdmlkLFxuICAgICAgc3JjLFxuICAgICAgcGF0aDogc2F2ZURhdGFVcmwoc2Vzc2lvbkZpbGVzRGlyLCB2aWQsIHNyYyksXG4gICAgICBsaWtlZDogZmFsc2UsXG4gICAgICBhbmFseXNpczogc3RhdGUuYW5hbHlzaXNDYWNoZVtoYXNoXSA/PyBcIlwiLCAvLyByZXVzZSBhIHByaW9yIHJlYWQgb2YgdGhlIHNhbWUgcGl4ZWxzXG4gICAgICBuYW1lLFxuICAgICAgaGFzaCxcbiAgICB9O1xuICAgIHN0YXRlLmJhdGNoZXMucHVzaCh7IGlkOiBiYXRjaElkLCBraW5kOiBcImltcG9ydFwiLCBwcm9tcHQ6IFwiXCIsIHRhZzogbmFtZSwgdmFyaWFudHM6IFt2YXJpYW50XSB9KTtcbiAgICByZXR1cm4geyBiYXRjaElkLCB2YXJpYW50IH07XG4gIH1cbiAgZnVuY3Rpb24gcHVzaE1lc3NhZ2UobTogT21pdDxNZXNzYWdlLCBcImlkXCIgfCBcInRzXCI+ICYgeyBpZD86IHN0cmluZyB9KSB7XG4gICAgY29uc3QgbXNnOiBNZXNzYWdlID0geyBpZDogbS5pZCA/PyBuZXdJZChcIm1cIiksIHRzOiBEYXRlLm5vdygpLCAuLi5tIH0gYXMgTWVzc2FnZTtcbiAgICBzdGF0ZS5jb252ZXJzYXRpb24ucHVzaChtc2cpO1xuICAgIHJldHVybiBtc2c7XG4gIH1cblxuICAvLyDilIDilIAgYWdlbnQgY29tbWFuZHMgKFBPU1QgL2NtZCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8vICM4NCDigJQgUkVUVVJOUyBBIFZFUkRJQ1Q6IGB0cnVlYCBpZiB0aGUgY29tbWFuZCB0eXBlIHdhcyBSRUNPR05JU0VELlxuICAvL1xuICAvLyDimqAgaW1hZ28gaXMgdGhlIERJU1BST09GIHRoYXQgdGhpcyBpcyBhbiBgYXdhaXRgIGJ1Zy4gVGhpcyBoYW5kbGVyIGlzIGFzeW5jXG4gIC8vIEFORCBpdHMgL2NtZCByb3V0ZSBhbHJlYWR5IGF3YWl0cyBpdCBjb3JyZWN0bHkg4oCUIGFuZCB0aGUgZGVmZWN0IHdhcyBwcmVzZW50XG4gIC8vIGFueXdheSwgYmVjYXVzZSB0aGUgcm91dGUgYW5zd2VyZWQgYSBsaXRlcmFsIHtvazp0cnVlfSB3aGlsZSB0aGUgaGFuZGxlclxuICAvLyBnYXZlIGl0IG5vdGhpbmcgdG8gcmVwb3J0LiBBZGRpbmcgYGF3YWl0YCB0byBnbGFtb3VyIHdvdWxkIG9ubHkgaGF2ZSBtYWRlXG4gIC8vIGdsYW1vdXIgcmVzZW1ibGUgaW1hZ28sIHdoaWNoIHdhcyBhbHNvIGJyb2tlbi5cbiAgLy9cbiAgLy8gXCJSZWNvZ25pc2VkXCIsIE5PVCBcImNoYW5nZWQgc3RhdGVcIjogdGhlIGZvdXIgZWFybHkgcmV0dXJucyBiZWxvdyBhcmUgZ3VhcmRzXG4gIC8vIGluc2lkZSByZWNvZ25pc2VkIGJyYW5jaGVzIChhbiBlbXB0eSB2YXJpYW50IGxpc3QsIGEgbWlzc2luZyBpZCksIGFuZCBlYWNoXG4gIC8vIHJldHVybnMgYHRydWVgLiBSZXBvcnRpbmcgYSByZWNvZ25pc2VkLWJ1dC1pbmVydCBjb21tYW5kIGFzIGEgZmFpbHVyZSB3b3VsZFxuICAvLyBicmVhayB3b3JraW5nIGNhbGxlcnMg4oCUIHRoZSBvdmVyLWluY2x1c2l2ZSBlcnJvciBQMGIgaGFkIHRvIGF2b2lkIGluIHRoaXNcbiAgLy8gc2FtZSBzcHJpbnQuIFRoZSBuYXJyb3dlciBjb250cmFjdCAoZGlkIGl0IGFjdHVhbGx5IHRha2UgZWZmZWN0PykgaXMgYSByZWFsXG4gIC8vIGdhcCwgZGVsaWJlcmF0ZWx5IFVOQ0xBSU1FRCBhbmQgcmFpc2VkIHJhdGhlciB0aGFuIHNpbGVudGx5IGFzc3VtZWQuXG4gIC8vXG4gIC8vIOKaoCBoYW5kbGVCcm93c2VyTXNnIGJlbG93IGlzIGEgU0VQQVJBVEUgZnVuY3Rpb24gd2l0aCBpdHMgb3duIGlmLWNoYWluIGFuZCBhXG4gIC8vIG5lYXItaWRlbnRpY2FsIHNoYXBlLiBJdCBpcyBOT1QgcGFydCBvZiB0aGlzIHZlcmRpY3QgYW5kIG11c3Qgbm90IGJlIGZvbGRlZFxuICAvLyBpbjogaXQgc2VydmVzIHRoZSBXZWJTb2NrZXQsIHdob3NlIGNhbGxlcnMgaGF2ZSBubyByZXNwb25zZSB0byBjYXJyeSBvbmUuXG4gIC8vIENvbnRyYWN0IDEzIChzZWFtcy5tZCk6IHRoZSB2ZXJkaWN0IG9yaWdpbmF0ZXMgaW4gdGhlIGNvZGUgdGhhdCBvd25zIHRoZVxuICAvLyByZWNvZ25pc2VkIHNldC4gYGZhbHNlYCA9IHRoZSB0eXBlIHdhcyBub3QgcmVjb2duaXNlZDsgYHRydWVgID0gaXQgd2FzLlxuICAvL1xuICAvLyBiOSB3aWRlbnMgdGhlIFJFVFVSTiB3aXRob3V0IHdpZGVuaW5nIHRoZSBDT05UUkFDVDogYSBjb21tYW5kIG1heSBpbnN0ZWFkXG4gIC8vIHJldHVybiBhIHJlc3VsdCBvYmplY3QgY2FycnlpbmcgaXRzIG93biBzdGF0dXMgYW5kIHBheWxvYWQuIEV2ZXJ5IGNvbW1hbmRcbiAgLy8gdGhhdCByZXR1cm5zIGEgYmFyZSBib29sZWFuIGlzIHVuYWZmZWN0ZWQgYW5kIGl0cyByZXNwb25zZSBpcyBieXRlLWlkZW50aWNhbFxuICAvLyDigJQgb25seSBgY29udGV4dC5hZGRgIHVzZXMgdGhlIHJpY2hlciBmb3JtIHRvZGF5LlxuICBhc3luYyBmdW5jdGlvbiBoYW5kbGVBZ2VudE1zZyhtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTxBZ2VudFZlcmRpY3Q+IHtcbiAgICBjb25zdCB0ID0gbXNnLnR5cGUgYXMgc3RyaW5nO1xuICAgIGlmICh0ID09PSBcImluaXRcIikge1xuICAgICAgaWYgKHR5cGVvZiBtc2cudGl0bGUgPT09IFwic3RyaW5nXCIpIHN0YXRlLnRpdGxlID0gbXNnLnRpdGxlO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwic2F5XCIpIHtcbiAgICAgIGlmICh0eXBlb2YgbXNnLnRleHQgPT09IFwic3RyaW5nXCIgJiYgbXNnLnRleHQpIHtcbiAgICAgICAgcHVzaE1lc3NhZ2UoeyByb2xlOiBcImFnZW50XCIsIGtpbmQ6IFwidGV4dFwiLCB0ZXh0OiBtc2cudGV4dCB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHQgPT09IFwicHJvcG9zZVwiKSB7XG4gICAgICBpZiAodHlwZW9mIG1zZy5wcm9tcHQgPT09IFwic3RyaW5nXCIgJiYgbXNnLnByb21wdCkge1xuICAgICAgICBjb25zdCBuID0gdHlwZW9mIG1zZy5uID09PSBcIm51bWJlclwiICYmIG1zZy5uID4gMCA/IE1hdGgubWluKDQsIE1hdGguZmxvb3IobXNnLm4pKSA6IDQ7XG4gICAgICAgIC8vIE5vIGZyYW1pbmcgdGV4dCBvbiB0aGUgcHJvcG9zYWwgaXRzZWxmIOKAlCB0aGUgYWdlbnQgYHNheWBzIGl0c1xuICAgICAgICAvLyByZWFzb25pbmcgYXMgYSBwcmVjZWRpbmcgYnViYmxlLCB0aGVuIGBwcm9wb3NlYHMgdGhlIGNhcmQuXG4gICAgICAgIHB1c2hNZXNzYWdlKHtcbiAgICAgICAgICByb2xlOiBcImFnZW50XCIsXG4gICAgICAgICAga2luZDogXCJwcm9tcHRcIixcbiAgICAgICAgICB0ZXh0OiBcIlwiLFxuICAgICAgICAgIHByb3Bvc2FsOiB7IHByb21wdDogbXNnLnByb21wdCwgbiwgc3RhdHVzOiBcInBlbmRpbmdcIiB9LFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHQgPT09IFwiYXNrXCIpIHtcbiAgICAgIGlmICh0eXBlb2YgbXNnLnRleHQgPT09IFwic3RyaW5nXCIgJiYgbXNnLnRleHQpIHtcbiAgICAgICAgcHVzaE1lc3NhZ2Uoe1xuICAgICAgICAgIHJvbGU6IFwiYWdlbnRcIixcbiAgICAgICAgICBraW5kOiBcInF1ZXN0aW9uXCIsXG4gICAgICAgICAgdGV4dDogbXNnLnRleHQsXG4gICAgICAgICAgb3B0aW9uczogQXJyYXkuaXNBcnJheShtc2cub3B0aW9ucykgPyAobXNnLm9wdGlvbnMgYXMgc3RyaW5nW10pIDogdW5kZWZpbmVkLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHQgPT09IFwiYmF0Y2guYWRkXCIpIHtcbiAgICAgIGNvbnN0IHZhcmlhbnRzSW4gPSBBcnJheS5pc0FycmF5KG1zZy52YXJpYW50cylcbiAgICAgICAgPyAobXNnLnZhcmlhbnRzIGFzIEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PilcbiAgICAgICAgOiBbXTtcbiAgICAgIGlmICh2YXJpYW50c0luLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHRydWU7XG4gICAgICBjb25zdCBiYXRjaElkID0gbmV3SWQoXCJiXCIpO1xuICAgICAgY29uc3QgdmFyaWFudHM6IFZhcmlhbnRbXSA9IFtdO1xuICAgICAgZm9yIChjb25zdCByYXcgb2YgdmFyaWFudHNJbikge1xuICAgICAgICBpZiAodHlwZW9mIHJhdy5zcmMgIT09IFwic3RyaW5nXCIpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCB2aWQgPSB0eXBlb2YgcmF3LmlkID09PSBcInN0cmluZ1wiID8gcmF3LmlkIDogbmV3SWQoXCJ2XCIpO1xuICAgICAgICBjb25zdCBzcmMgPSBhd2FpdCBvcHRpbWl6ZVNyYyhyYXcuc3JjKTtcbiAgICAgICAgdmFyaWFudHMucHVzaCh7XG4gICAgICAgICAgaWQ6IHZpZCxcbiAgICAgICAgICBzcmMsXG4gICAgICAgICAgcGF0aDogc2F2ZURhdGFVcmwoc2Vzc2lvbkZpbGVzRGlyLCB2aWQsIHNyYyksXG4gICAgICAgICAgc2VlZDogdHlwZW9mIHJhdy5zZWVkID09PSBcIm51bWJlclwiID8gcmF3LnNlZWQgOiB1bmRlZmluZWQsXG4gICAgICAgICAgbW9kZWw6IHR5cGVvZiByYXcubW9kZWwgPT09IFwic3RyaW5nXCIgPyByYXcubW9kZWwgOiB1bmRlZmluZWQsXG4gICAgICAgICAgbGlrZWQ6IGZhbHNlLFxuICAgICAgICAgIGFuYWx5c2lzOiBcIlwiLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIGlmICh2YXJpYW50cy5sZW5ndGggPT09IDApIHJldHVybiB0cnVlO1xuICAgICAgY29uc3QgYmF0Y2g6IEJhdGNoID0ge1xuICAgICAgICBpZDogYmF0Y2hJZCxcbiAgICAgICAga2luZDogbXNnLmtpbmQgPT09IFwiZWRpdFwiID8gXCJlZGl0XCIgOiBcImdlbmVyYXRlXCIsXG4gICAgICAgIHByb21wdDogdHlwZW9mIG1zZy5wcm9tcHQgPT09IFwic3RyaW5nXCIgPyBtc2cucHJvbXB0IDogXCJcIixcbiAgICAgICAgdGFnOiB0eXBlb2YgbXNnLnRhZyA9PT0gXCJzdHJpbmdcIiA/IG1zZy50YWcgOiB1bmRlZmluZWQsXG4gICAgICAgIGVkaXRlZEZyb21WYXJpYW50SWQ6XG4gICAgICAgICAgdHlwZW9mIG1zZy5lZGl0ZWRGcm9tVmFyaWFudElkID09PSBcInN0cmluZ1wiID8gbXNnLmVkaXRlZEZyb21WYXJpYW50SWQgOiB1bmRlZmluZWQsXG4gICAgICAgIHZhcmlhbnRzLFxuICAgICAgfTtcbiAgICAgIHN0YXRlLmJhdGNoZXMucHVzaChiYXRjaCk7XG4gICAgICBwdXNoTWVzc2FnZSh7XG4gICAgICAgIHJvbGU6IFwiYWdlbnRcIixcbiAgICAgICAga2luZDogXCJyZXN1bHRcIixcbiAgICAgICAgdGV4dDpcbiAgICAgICAgICB0eXBlb2YgbXNnLnN1bW1hcnkgPT09IFwic3RyaW5nXCJcbiAgICAgICAgICAgID8gbXNnLnN1bW1hcnlcbiAgICAgICAgICAgIDogYEdlbmVyYXRlZCAke3ZhcmlhbnRzLmxlbmd0aH0gdmFyaWFudCR7dmFyaWFudHMubGVuZ3RoID4gMSA/IFwic1wiIDogXCJcIn0g4oCUIHRoZXkncmUgb24gdGhlIGxlZnQuYCxcbiAgICAgICAgYmF0Y2hJZCxcbiAgICAgIH0pO1xuICAgICAgLy8gU2hvdyB0aGUgZmlyc3QgcmVzdWx0IG9uIHRoZSBjYW52YXMgaWYgbm90aGluZyBpcyBmb2N1c2VkIHlldC5cbiAgICAgIGlmICghc3RhdGUuZm9jdXMpIHN0YXRlLmZvY3VzID0geyBiYXRjaElkLCB2YXJpYW50SWQ6IHZhcmlhbnRzWzBdLmlkIH07XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJmb2N1c1wiKSB7XG4gICAgICBjb25zdCBiID0gZmluZEJhdGNoKG1zZy5iYXRjaElkIGFzIHN0cmluZyk7XG4gICAgICBjb25zdCBoYXMgPSBiPy52YXJpYW50cy5zb21lKCh4KSA9PiB4LmlkID09PSBtc2cudmFyaWFudElkKTtcbiAgICAgIGlmIChiICYmIGhhcykge1xuICAgICAgICBzdGF0ZS5mb2N1cyA9IHsgYmF0Y2hJZDogYi5pZCwgdmFyaWFudElkOiBtc2cudmFyaWFudElkIGFzIHN0cmluZyB9O1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpOyAvLyBtYXJrcyBhcmUgZHVyYWJsZSBwZXIgdmFyaWFudCDigJQgc3dpdGNoaW5nIG5ldmVyIGNsZWFycyB0aGVtXG4gICAgICB9XG4gICAgfSBlbHNlIGlmICh0ID09PSBcInJlZi5zZWxlY3RcIikge1xuICAgICAgLy8gdGhlIGFnZW50IHBvaW50cyBhIHZhcmlhbnQgYXQgdGhlIG5leHQgZ2VuIOKAlCB0aGUgdXNlciBzZWVzIGl0IGhpZ2hsaWdodFxuICAgICAgY29uc3QgaGl0ID0gZmluZFZhcmlhbnQobXNnLmlkIGFzIHN0cmluZyk7XG4gICAgICBpZiAoIWhpdCkgcmV0dXJuIHRydWU7XG4gICAgICBoaXQudmFyaWFudC5yZWZTZWxlY3RlZCA9IG1zZy5zZWxlY3RlZCA9PT0gdHJ1ZTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcInZhcmlhbnQuYW5hbHl6ZVwiKSB7XG4gICAgICAvLyB0aGUgYWdlbnQgd3JpdGVzIGl0cyByZWFkIG9udG8gYSBnZW5lcmF0ZWQvaW1wb3J0ZWQgaW1hZ2Ug4oCUIGR1cmFibGVcbiAgICAgIC8vIG1ldGFkYXRhIHN0b3JlZCBvbiB0aGUgdmFyaWFudCAocGVyc2lzdHMgaW4gdGhlIHNuYXBzaG90KS5cbiAgICAgIGNvbnN0IGhpdCA9IGZpbmRWYXJpYW50KG1zZy5pZCBhcyBzdHJpbmcpO1xuICAgICAgaWYgKCFoaXQgfHwgdHlwZW9mIG1zZy50ZXh0ICE9PSBcInN0cmluZ1wiKSByZXR1cm4gdHJ1ZTtcbiAgICAgIGhpdC52YXJpYW50LmFuYWx5c2lzID0gbXNnLnRleHQ7XG4gICAgICAvLyBpbXBvcnRlZCBpbWFnZXMgY2FycnkgYSBoYXNoIOKGkiBjYWNoZSBieSBpdCBzbyByZS1pbXBvcnRpbmcgdGhlIHNhbWUgcGl4ZWxzXG4gICAgICAvLyByZXVzZXMgdGhlIHJlYWQgKHByZXNlcnZlcyB0aGUgb2xkIHJlZi5hbmFseXplIGJlaGF2aW9yIGFjcm9zcyB0aGUgbWVyZ2UpXG4gICAgICBpZiAoaGl0LnZhcmlhbnQuaGFzaCkgc3RhdGUuYW5hbHlzaXNDYWNoZVtoaXQudmFyaWFudC5oYXNoXSA9IG1zZy50ZXh0O1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwiY29udGV4dC5hZGRcIikge1xuICAgICAgLy8gYjkvIzg3IOKAlCB0aGUgY2FsbGVyIGxlYXJucyB0aGUgaWQgaXQganVzdCBjcmVhdGVkLCBhbmQgV0hJQ0ggb2YgdGhlXG4gICAgICAvLyB0aHJlZSBwYXRocyByYW4uIFJldHVybmluZyBhIHJlc3VsdCBvYmplY3QgaGVyZSByYXRoZXIgdGhhbiBgdHJ1ZWAgaXNcbiAgICAgIC8vIHRoZSBvbmx5IHBsYWNlIGluIHRoaXMgaGFuZGxlciB0aGF0IGRvZXMgc287IGV2ZXJ5IG90aGVyIGNvbW1hbmQga2VlcHNcbiAgICAgIC8vIHRoZSBwbGFpbiBib29sZWFuLCBzbyB0aGVpciByZXNwb25zZXMgc3RheSBieXRlLWlkZW50aWNhbC5cbiAgICAgIGNvbnN0IHJlcyA9IGFkZENvbnRleHRFbnRyeShtc2cgYXMgUGFyYW1ldGVyczx0eXBlb2YgYWRkQ29udGV4dEVudHJ5PlswXSk7XG4gICAgICBpZiAoIXJlcy5vaylcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICByZWNvZ25pc2VkOiB0cnVlLFxuICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICBzdGF0dXM6IDQwOSxcbiAgICAgICAgICBlcnJvcjogcmVzLmVycm9yLFxuICAgICAgICAgIGRldGFpbDoge1xuICAgICAgICAgICAgLi4uKHJlcy5pZCA/IHsgaWQ6IHJlcy5pZCB9IDoge30pLFxuICAgICAgICAgICAgLi4uKHJlcy5jb25mbGljdHMgPyB7IGNvbmZsaWN0czogcmVzLmNvbmZsaWN0cyB9IDoge30pLFxuICAgICAgICAgIH0sXG4gICAgICAgIH07XG4gICAgICBpZiAobXNnLmxpbmspIGxpbmtDb250ZXh0KHJlcy5pZCwgbXNnLmxpbmsgYXMgQ29udGV4dFNldCk7XG4gICAgICAvLyBgYWxyZWFkeS1yZWNvcmRlZGAgd3JvdGUgbm90aGluZywgc28gdGhlcmUgaXMgbm90aGluZyB0byBicm9hZGNhc3Qg4oCUXG4gICAgICAvLyBidXQgYSBsaW5rIG1heSBzdGlsbCBoYXZlIGJlZW4gbWFkZSBhYm92ZSwgYW5kIHRoYXQgaXMgYSByZWFsIGNoYW5nZS5cbiAgICAgIGlmIChyZXMub3V0Y29tZSAhPT0gXCJhbHJlYWR5LXJlY29yZGVkXCIgfHwgbXNnLmxpbmspIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICByZWNvZ25pc2VkOiB0cnVlLFxuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgZGV0YWlsOiB7XG4gICAgICAgICAgaWQ6IHJlcy5pZCxcbiAgICAgICAgICBvdXRjb21lOiByZXMub3V0Y29tZSxcbiAgICAgICAgICAuLi4ocmVzLm91dGNvbWUgPT09IFwidXBkYXRlZFwiID8geyBjaGFuZ2VkOiByZXMuY2hhbmdlZCwgcHJldmlvdXM6IHJlcy5wcmV2aW91cyB9IDoge30pLFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwic3RhdHVzXCIpIHtcbiAgICAgIHN0YXRlLnN0YXR1cyA9IHtcbiAgICAgICAgYnVzeTogbXNnLmJ1c3kgPT09IHRydWUsXG4gICAgICAgIHRleHQ6IHR5cGVvZiBtc2cudGV4dCA9PT0gXCJzdHJpbmdcIiA/IG1zZy50ZXh0IDogXCJcIixcbiAgICAgIH07XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJjb3N0XCIpIHtcbiAgICAgIGlmICh0eXBlb2YgbXNnLnRleHQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgc3RhdGUuY29zdCA9IG1zZy50ZXh0O1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJoYW5kb2ZmXCIpIHtcbiAgICAgIHN0YXRlLmhhbmRvZmYgPSB0eXBlb2YgbXNnLnRleHQgPT09IFwic3RyaW5nXCIgPyBtc2cudGV4dCA6IFwiXCI7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJjbG9zZVwiKSB7XG4gICAgICByZXNvbHZlRG9uZSh7IGNvZGU6IDAsIHJlYXNvbjogXCJjbG9zZVwiIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gZmFsc2U7IC8vIHVucmVjb2duaXNlZCB0eXBlIOKAlCB0aGlzIGNoYWluIGhhZCBubyB0ZXJtaW5hbCBlbHNlIGF0IGFsbFxuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIC8vIEdFVCAvZXZlbnRzP3NpbmNlPTxpZD4g4oCUIHJlcGxheSwgdGhlbiBzdGF5IG9wZW4gZm9yIGxpdmUgZnJhbWVzIHBsdXMgYVxuICAvLyBoZWFydGJlYXQgY29tbWVudC4gT05FIGNhbGwgaW50byBga2l0L3dpcmUvc3NlLnRzYCwgd2hpY2ggaXMgd2hlcmUgdGhlXG4gIC8vIHRlYXJkb3duIGZ1bm5lbCBsaXZlczogYGNhbmNlbCgpYCwgYHJlcS5zaWduYWxgIGFuZCBhIGZhaWxlZCBlbnF1ZXVlIGFsbFxuICAvLyByZWFjaCBpdCwgYXQgbW9zdCBvbmNlLCBhbmQgdGhhdCBmdW5uZWwgaXMgd2hhdCBib3VuZHMgdGhlIHN1YnNjcmliZXIgY291bnRcbiAgLy8gdGhlIGlkbGUgc3dlZXAgbm93IHJlYWRzLlxuICAvL1xuICAvLyDim5QgV0hBVCBUSEUgT0xEIENPUFkgQ09VTEQgTk9UIERPLCBBTkQgSVQgSVMgV0hZIFRIRSBTVUJTQ1JJQkVSIENPVU5UIFdBU1xuICAvLyBORVZFUiBUUlVTVFdPUlRIWS4gSXQgcmVsaWVkIG9uIGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIHRvIG5vdGljZSBhIGRlcGFydGVkXG4gIC8vIGNsaWVudCDigJQgbWVhc3VyZWQgb24gQnVuIDEuMy4xNCBOT1QgdG8gd29yaywgYW4gZW5xdWV1ZSBvbiBhbiBvcnBoYW5lZFxuICAvLyBzdHJlYW0gYnVmZmVycyBzaWxlbnRseSBhbmQgbmV2ZXIgdGhyb3dzIOKAlCBhbmQgaXQgd2FzIG5vdCB3aXJlZCB0b1xuICAvLyBgcmVxLnNpZ25hbGAgYXQgYWxsLCBzbyBhIGNsaWVudCB0aGF0IHZhbmlzaGVkIHdpdGhvdXQgY2FuY2VsbGluZyB3YXNcbiAgLy8gY291bnRlZCBhcyBwcmVzZW50IGZvciB0aGUgbGlmZSBvZiB0aGUgZGFlbW9uLiBJdCBhbHNvIGtlcHQgYSBTRUNPTkQgc2V0XG4gIC8vIChgc3NlVGltZXJzYCkgb2YgcGVyLXN0cmVhbSBoZWFydGJlYXRzLCBzd2VwdCBzZXBhcmF0ZWx5IGF0IHRlYXJkb3duLCB3aGljaFxuICAvLyBpcyB0aGUgdHdvLXJlZ2lzdHJpZXMtZHJpZnRpbmcgc2hhcGUgdGhlIG1vZHVsZSdzIGhlYWRlciB3YXJucyBhYm91dC5cbiAgLy9cbiAgLy8g4pqgIEFORCBUSEUgSEVBUlRCRUFUIElTIE5PIExPTkdFUiBBIExJVEVSQUwuIEl0IHdhcyBgMTUwMDBgLCBoYXJkLWNvZGVkIGluXG4gIC8vIHRoaXMgZnVuY3Rpb24sIDEsMzAwIGxpbmVzIGZyb20gdGhlIGBpZGxlVGltZW91dDogMjU1YCBpdCBpcyBjaGFpbmVkIHRvLCB3aXRoXG4gIC8vIHRoZSByZWxhdGlvbnNoaXAgd3JpdHRlbiBvbmx5IGluIHRoZSBwcm9zZSBiZXR3ZWVuIHRoZW0uIEJvdGggbm93IGNvbWUgZnJvbVxuICAvLyBgLi9oZWFydGJlYXQudHNgLCB3aGljaCBERVJJVkVTIHRoZSBwYWlyIOKAlCBzbyBgYmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIGhvbGRzXG4gIC8vIGZvciBhbnkgY29uZmlndXJlZCB2YWx1ZSwgbm90IG9ubHkgZm9yIHRoZSB0d28gdGhhdCBoYXBwZW5lZCB0byBiZSB3cml0dGVuLlxuICBjb25zdCBldmVudHNSZXNwb25zZSA9IChyZXE6IFJlcXVlc3QsIHVybDogVVJMKTogUmVzcG9uc2UgPT4ge1xuICAgIHRvdWNoKCk7XG4gICAgcmV0dXJuIGtpdFNzZVJlc3BvbnNlKHtcbiAgICAgIGxvZyxcbiAgICAgIHNpbmNlOiBOdW1iZXIucGFyc2VJbnQodXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJzaW5jZVwiKSA/PyBcIi0xXCIsIDEwKSxcbiAgICAgIGhlYXJ0YmVhdE1zOiBTU0VfSEVBUlRCRUFUX01TLFxuICAgICAgY2xpZW50czogc3NlQ2xpZW50cyxcbiAgICAgIHNpZ25hbDogcmVxLnNpZ25hbCxcbiAgICAgIG9uT3BlbjogdG91Y2gsXG4gICAgICBvbkNsb3NlOiB0b3VjaCxcbiAgICB9KTtcbiAgfTtcblxuICAvLyDilIDilIAgYnJvd3NlciBtZXNzYWdlcyAoV2ViU29ja2V0KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgYXN5bmMgZnVuY3Rpb24gaGFuZGxlQnJvd3Nlck1zZyhtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gICAgY29uc3QgdCA9IG1zZy50eXBlIGFzIHN0cmluZztcbiAgICBpZiAodCA9PT0gXCJzYXlcIikge1xuICAgICAgaWYgKHR5cGVvZiBtc2cudGV4dCAhPT0gXCJzdHJpbmdcIiB8fCAhbXNnLnRleHQpIHJldHVybjtcbiAgICAgIHB1c2hNZXNzYWdlKHsgcm9sZTogXCJ1c2VyXCIsIGtpbmQ6IFwidGV4dFwiLCB0ZXh0OiBtc2cudGV4dCB9KTtcbiAgICAgIC8vIEEgbWVzc2FnZSBhYm91dCBhIGZyZXNobHktbWFya2VkIGltYWdlIHJpZGVzIHRoZSBtYXJrZWQgaW1hZ2UgKyBnZW9tZXRyeVxuICAgICAgLy8gYWxvbmcgKG9uZSBmcmVzaG5lc3Mgc2lnbmFsKS4gVGhlIHN1cmZhY2UgYXR0YWNoZXMgZmxhdHRlbmVkU3JjIG9ubHkgd2hlblxuICAgICAgLy8gdGhlIGZvY3VzZWQgaW1hZ2UgaGFzIHVuc2VlbiBtYXJrczsgcmVjZWl2aW5nIGl0IGNsZWFycyB0aGF0IGZsYWcuXG4gICAgICBsZXQgZmxhdHRlbmVkSW1hZ2VQYXRoOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgICBsZXQgYXR0YWNoZWRNYXJrczogTWFya1tdIHwgdW5kZWZpbmVkO1xuICAgICAgY29uc3QgZnZpZCA9IHN0YXRlLmZvY3VzPy52YXJpYW50SWQ7XG4gICAgICBpZiAoZnZpZCAmJiB0eXBlb2YgbXNnLmZsYXR0ZW5lZFNyYyA9PT0gXCJzdHJpbmdcIiAmJiBtc2cuZmxhdHRlbmVkU3JjLnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSkge1xuICAgICAgICBmbGF0dGVuZWRJbWFnZVBhdGggPVxuICAgICAgICAgIHNhdmVEYXRhVXJsKHNlc3Npb25GaWxlc0RpciwgbmV3SWQoXCJmbGF0XCIpLCBtc2cuZmxhdHRlbmVkU3JjKSB8fCB1bmRlZmluZWQ7XG4gICAgICAgIGF0dGFjaGVkTWFya3MgPSBzdGF0ZS5tYXJrc0J5VmFyaWFudFtmdmlkXSA/PyBbXTtcbiAgICAgICAgbWFya1Vuc2VlbltmdmlkXSA9IGZhbHNlOyAvLyB0aGUgYWdlbnQgbm93IGhhcyB0aGUgbGF0ZXN0IG1hcmtzXG4gICAgICB9XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgLy8gYW1iaWVudCBib2FyZCBzdGF0ZSAoZm9jdXMgKyBzZWxlY3RlZCByZWZzKSByaWRlcyB0aGUgbWVzc2FnZSwgc28gdGhlXG4gICAgICAvLyBhZ2VudCBoYXMgXCJ3aGljaCBpbWFnZSwgd2l0aCB3aGljaCByZWZzXCIgd2l0aG91dCBzdWJzY3JpYmluZyB0byB0aGVcbiAgICAgIC8vIGFtYmllbnQgZm9jdXMuc2V0L3JlZi5zZWxlY3QgZXZlbnRzICh3aGljaCBubyBsb25nZXIgbm90aWZ5KS5cbiAgICAgIGVtaXRFdmVudCh7XG4gICAgICAgIHR5cGU6IFwic2F5XCIsXG4gICAgICAgIHRleHQ6IG1zZy50ZXh0LFxuICAgICAgICBmb2N1czogc3RhdGUuZm9jdXMsXG4gICAgICAgIHNlbGVjdGVkUmVmSWRzOiBzZWxlY3RlZFJlZklkcygpLFxuICAgICAgICBmbGF0dGVuZWRJbWFnZVBhdGgsXG4gICAgICAgIG1hcmtzOiBhdHRhY2hlZE1hcmtzLFxuICAgICAgfSk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcInByb3Bvc2FsLnNlbmRcIikge1xuICAgICAgY29uc3QgbSA9IHN0YXRlLmNvbnZlcnNhdGlvbi5maW5kKCh4KSA9PiB4LmlkID09PSBtc2cuaWQpO1xuICAgICAgaWYgKG0/LnByb3Bvc2FsKSB7XG4gICAgICAgIG0ucHJvcG9zYWwuc3RhdHVzID0gXCJzZW50XCI7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICB9XG4gICAgICAvLyDim5QgVEhFIFBST1BPU0FMJ1MgSURFTlRJVFkgUklERVMgQVMgYHByb3Bvc2FsSWRgLCBOT1QgYGlkYC4gYGlkYCBvbiBhXG4gICAgICAvLyBmcmFtZSBiZWxvbmdzIHRvIHRoZSBldmVudCBsb2cncyBtb25vdG9uaWMgY3Vyc29yIGFuZCBub3RoaW5nIGVsc2UuXG4gICAgICAvLyBUaGVzZSB0d28gZnJhbWVzIHVzZWQgdG8gcGFzcyBgaWQ6IG1zZy5pZGA7IHRoZSBvbGQgYnVzIHNwcmVhZCB0aGVcbiAgICAgIC8vIHBheWxvYWQgYWZ0ZXIgdGhlIGN1cnNvciwgc28gdGhlIHByb3Bvc2FsJ3MgaWQgQkVDQU1FIHRoZSBjdXJzb3IgYW5kXG4gICAgICAvLyBgZXYuaWQgPiBzaW5jZWAgKGEgc3RyaW5nKSB3YXMgZmFsc2UgZm9yZXZlciDigJQgdGhlIGZyYW1lcyB3ZXJlIG5ldmVyXG4gICAgICAvLyByZXBsYXllZCBhdCBhbGwuIEFkb3B0aW5nIGBraXQvd2lyZS9ldmVudExvZy50c2AgZml4ZWQgdGhlIGN1cnNvciBieVxuICAgICAgLy8gbWFraW5nIGl0IHdpbiwgd2hpY2ggcmVzb2x2ZWQgdGhlIGNvbGxpc2lvbiBieSBERUxFVElORyB0aGUgcGF5bG9hZFxuICAgICAgLy8gZmllbGQuIFR3byBuYW1lcywgbm8gY29sbGlzaW9uLCBib3RoIHN1cnZpdmUuXG4gICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcInByb3Bvc2FsLnNlbmRcIiwgcHJvcG9zYWxJZDogbXNnLmlkIH0pO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJwcm9wb3NhbC5kaXNtaXNzXCIpIHtcbiAgICAgIGNvbnN0IG0gPSBzdGF0ZS5jb252ZXJzYXRpb24uZmluZCgoeCkgPT4geC5pZCA9PT0gbXNnLmlkKTtcbiAgICAgIGlmIChtPy5wcm9wb3NhbCkge1xuICAgICAgICBtLnByb3Bvc2FsLnN0YXR1cyA9IFwiZGlzbWlzc2VkXCI7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICB9XG4gICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcInByb3Bvc2FsLmRpc21pc3NcIiwgcHJvcG9zYWxJZDogbXNnLmlkIH0pO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJmb2N1cy5zZXRcIikge1xuICAgICAgY29uc3QgYiA9IGZpbmRCYXRjaChtc2cuYmF0Y2hJZCBhcyBzdHJpbmcpO1xuICAgICAgaWYgKCFiKSByZXR1cm47XG4gICAgICBpZiAoIWIudmFyaWFudHMuc29tZSgoeCkgPT4geC5pZCA9PT0gbXNnLnZhcmlhbnRJZCkpIHJldHVybjtcbiAgICAgIHN0YXRlLmZvY3VzID0geyBiYXRjaElkOiBiLmlkLCB2YXJpYW50SWQ6IG1zZy52YXJpYW50SWQgYXMgc3RyaW5nIH07XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpOyAvLyBtYXJrcyBhcmUgZHVyYWJsZSBwZXIgdmFyaWFudCDigJQgc3dpdGNoaW5nIG5ldmVyIGNsZWFycyB0aGVtXG4gICAgfSBlbHNlIGlmICh0ID09PSBcImZvY3VzLmNsZWFyXCIpIHtcbiAgICAgIHN0YXRlLmZvY3VzID0gbnVsbDtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcInZhcmlhbnQubGlrZVwiKSB7XG4gICAgICBjb25zdCBoaXQgPSBmaW5kVmFyaWFudChtc2cuaWQgYXMgc3RyaW5nKTtcbiAgICAgIGlmICghaGl0KSByZXR1cm47XG4gICAgICBoaXQudmFyaWFudC5saWtlZCA9IG1zZy5saWtlZCA9PT0gdHJ1ZTtcbiAgICAgIGlmIChoaXQudmFyaWFudC5saWtlZCkge1xuICAgICAgICBwdXNoTWVzc2FnZSh7XG4gICAgICAgICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgICAgICAga2luZDogXCJnZXN0dXJlXCIsXG4gICAgICAgICAgdGV4dDogYPCfkY0geW91IGxpa2VkIHZhcmlhbnQgJHtsYWJlbE9mKGhpdC5pbmRleCl9IOKAlCBpbWFnbyBjYW4gc2VlIHdoaWNoIG9uZWAsXG4gICAgICAgICAgZ2VzdHVyZTogeyBraW5kOiBcImxpa2VkXCIsIHRhcmdldElkOiBoaXQudmFyaWFudC5pZCB9LFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcInZhcmlhbnQucmVtb3ZlXCIpIHtcbiAgICAgIC8vIGRlbGV0ZSBhIHZhcmlhbnQgZnJvbSB0aGUgbGlicmFyeTogZHJvcCBpdCBmcm9tIGl0cyBiYXRjaCAoYW5kIGRyb3AgdGhlXG4gICAgICAvLyBiYXRjaCB3aGVuIGl0IGVtcHRpZXMpLCBjbGVhbiBpdHMgYW5ub3RhdGlvbnMvbGF5ZXJzL2hpc3RvcnksIGFuZCBjbGVhclxuICAgICAgLy8gZm9jdXMgaWYgaXQgd2FzIHRoZSBmb2N1c2VkIG9uZS4gQW1iaWVudCAobGlicmFyeSBjdXJhdGlvbikg4oCUIG5vIGFnZW50XG4gICAgICAvLyBldmVudDsgdGhlIGFnZW50IHJlYWRzIHRoZSBuZXcgc3RhdGUuXG4gICAgICBjb25zdCBiYXRjaElkID0gbXNnLmJhdGNoSWQ7XG4gICAgICBjb25zdCB2YXJpYW50SWQgPSBtc2cudmFyaWFudElkO1xuICAgICAgaWYgKHR5cGVvZiBiYXRjaElkICE9PSBcInN0cmluZ1wiIHx8IHR5cGVvZiB2YXJpYW50SWQgIT09IFwic3RyaW5nXCIpIHJldHVybjtcbiAgICAgIGNvbnN0IGJhdGNoID0gc3RhdGUuYmF0Y2hlcy5maW5kKChiKSA9PiBiLmlkID09PSBiYXRjaElkKTtcbiAgICAgIGlmICghYmF0Y2g/LnZhcmlhbnRzLnNvbWUoKHYpID0+IHYuaWQgPT09IHZhcmlhbnRJZCkpIHJldHVybjtcbiAgICAgIGJhdGNoLnZhcmlhbnRzID0gYmF0Y2gudmFyaWFudHMuZmlsdGVyKCh2KSA9PiB2LmlkICE9PSB2YXJpYW50SWQpO1xuICAgICAgaWYgKGJhdGNoLnZhcmlhbnRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBzdGF0ZS5iYXRjaGVzID0gc3RhdGUuYmF0Y2hlcy5maWx0ZXIoKGIpID0+IGIuaWQgIT09IGJhdGNoSWQpO1xuICAgICAgfVxuICAgICAgZGVsZXRlIHN0YXRlLm1hcmtzQnlWYXJpYW50W3ZhcmlhbnRJZF07XG4gICAgICBkZWxldGUgc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZhcmlhbnRJZF07XG4gICAgICBkZWxldGUgbWFya0hpc3RvcnlbdmFyaWFudElkXTtcbiAgICAgIGRlbGV0ZSBtYXJrVW5zZWVuW3ZhcmlhbnRJZF07XG4gICAgICBpZiAoc3RhdGUuZm9jdXM/LnZhcmlhbnRJZCA9PT0gdmFyaWFudElkKSBzdGF0ZS5mb2N1cyA9IG51bGw7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJjb250ZXh0LmFkZFwiKSB7XG4gICAgICAvLyBTYW1lIG5vbi1kZXN0cnVjdGl2ZSBiZWhhdmlvdXIgYXMgdGhlIGFnZW50IHBhdGgg4oCUIHRoZSBndWFyZCBsaXZlcyBpblxuICAgICAgLy8gYWRkQ29udGV4dEVudHJ5LCBzbyBib3RoIGNhbGxlcnMgZ2V0IGl0LiBCdXQgYSBXZWJTb2NrZXQgbWVzc2FnZSBoYXMgbm9cbiAgICAgIC8vIHJlc3BvbnNlIHRvIGNhcnJ5IGEgdmVyZGljdCAoc2VhbXMubWQgQ29udHJhY3QgMTMncyBzdGF0ZWQgZ3JhaW4pLCBzbyBhXG4gICAgICAvLyByZWZ1c2FsIGlzIGN1cnJlbnRseSBJTlZJU0lCTEUgdG8gdGhlIGh1bWFuLiBUaGF0IGlzIGEgcGFyaXR5LWZhY3RzIGdhcFxuICAgICAgLy8gYW5kIGl0IGlzIGNpcmNlJ3Mgc3VyZmFjZSBjYWxsLCBub3Qgc29tZXRoaW5nIHRvIHBhcGVyIG92ZXIgaGVyZS5cbiAgICAgIGNvbnN0IHJlcyA9IGFkZENvbnRleHRFbnRyeShtc2cgYXMgUGFyYW1ldGVyczx0eXBlb2YgYWRkQ29udGV4dEVudHJ5PlswXSk7XG4gICAgICBpZiAocmVzLm9rICYmIG1zZy5saW5rKSBsaW5rQ29udGV4dChyZXMuaWQsIG1zZy5saW5rIGFzIENvbnRleHRTZXQpO1xuICAgICAgaWYgKHJlcy5vaykgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwiY29udGV4dC51cGRhdGVcIikge1xuICAgICAgY29uc3QgZSA9IHN0YXRlLmxpYnJhcnkuZmluZCgoeCkgPT4geC5pZCA9PT0gbXNnLmlkKTtcbiAgICAgIGlmIChlKSB7XG4gICAgICAgIGlmICh0eXBlb2YgbXNnLm5hbWUgPT09IFwic3RyaW5nXCIpIGUubmFtZSA9IG1zZy5uYW1lLnRyaW0oKSB8fCBlLm5hbWU7XG4gICAgICAgIGlmICh0eXBlb2YgbXNnLmNvbnRlbnQgPT09IFwic3RyaW5nXCIpIGUuY29udGVudCA9IG1zZy5jb250ZW50O1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShtc2cudGFncykpIGUudGFncyA9IG1zZy50YWdzIGFzIHN0cmluZ1tdO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJjb250ZXh0LmRlbGV0ZVwiKSB7XG4gICAgICBpZiAodHlwZW9mIG1zZy5pZCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICBjb25zdCB0b0RlbGV0ZSA9IHN0YXRlLmxpYnJhcnkuZmluZCgoeCkgPT4geC5pZCA9PT0gbXNnLmlkKTtcbiAgICAgICAgc3RhdGUubGlicmFyeSA9IHN0YXRlLmxpYnJhcnkuZmlsdGVyKCh4KSA9PiB4LmlkICE9PSBtc2cuaWQpO1xuICAgICAgICBzdGF0ZS5hY3RpdmVDb250ZXh0SWRzID0gc3RhdGUuYWN0aXZlQ29udGV4dElkcy5maWx0ZXIoKHgpID0+IHggIT09IG1zZy5pZCk7XG4gICAgICAgIHN0YXRlLnF1aWNrUHJvbXB0SWRzID0gc3RhdGUucXVpY2tQcm9tcHRJZHMuZmlsdGVyKCh4KSA9PiB4ICE9PSBtc2cuaWQpO1xuICAgICAgICBpZiAodG9EZWxldGU/LmltYWdlUGF0aCkge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICB1bmxpbmtTeW5jKHRvRGVsZXRlLmltYWdlUGF0aCk7XG4gICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiBiZXN0LWVmZm9ydCDigJQgZmlsZSBtYXkgYWxyZWFkeSBiZSBnb25lICovXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmICh0ID09PSBcImNvbnRleHQubGlua1wiKSB7XG4gICAgICBpZiAodHlwZW9mIG1zZy5pZCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICBsaW5rQ29udGV4dChtc2cuaWQsIG1zZy5zZXQgYXMgQ29udGV4dFNldCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmICh0ID09PSBcImNvbnRleHQudW5saW5rXCIpIHtcbiAgICAgIGlmICh0eXBlb2YgbXNnLmlkID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIHVubGlua0NvbnRleHQobXNnLmlkLCBtc2cuc2V0IGFzIENvbnRleHRTZXQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJjb250ZXh0LmNhcHR1cmVcIikge1xuICAgICAgLy8gY2FycnkgdGhlIGZvY3VzZWQgdmFyaWFudCBzbyB0aGUgYWdlbnQga25vd3Mgd2hpY2ggaW1hZ2UgdG8gcmVhZCB0aGUgbG9vayBmcm9tXG4gICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcImNvbnRleHQuY2FwdHVyZVwiLCBmb2N1czogc3RhdGUuZm9jdXMgfSk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcInBpbi5hZGRcIikge1xuICAgICAgaWYgKHR5cGVvZiBtc2cua2V5ICE9PSBcInN0cmluZ1wiIHx8IHR5cGVvZiBtc2cudmFsdWUgIT09IFwic3RyaW5nXCIpIHJldHVybjtcbiAgICAgIGNvbnN0IGV4ID0gc3RhdGUucGlucy5maW5kKChwKSA9PiBwLmtleSA9PT0gbXNnLmtleSk7XG4gICAgICBpZiAoZXgpIGV4LnZhbHVlID0gbXNnLnZhbHVlO1xuICAgICAgZWxzZSBzdGF0ZS5waW5zLnB1c2goeyBrZXk6IG1zZy5rZXksIHZhbHVlOiBtc2cudmFsdWUgfSk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJwaW4ucmVtb3ZlXCIpIHtcbiAgICAgIHN0YXRlLnBpbnMgPSBzdGF0ZS5waW5zLmZpbHRlcigocCkgPT4gcC5rZXkgIT09IG1zZy5rZXkpO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwicmVmLmFkZFwiKSB7XG4gICAgICAvLyBhZGQgYW4gZXh0ZXJuYWwgaW1hZ2UgYXMgYSByZWZlcmVuY2UgPSBpbXBvcnQgaXQgYXMgYSBsaWJyYXJ5IHZhcmlhbnQgK1xuICAgICAgLy8gZmxhZyBpdCByZWZTZWxlY3RlZCAoZGVkdXAg4oaSIHNlbGVjdHMgdGhlIGV4aXN0aW5nIG9uZSwgbm8gZHVwbGljYXRlKS4gRG9lc1xuICAgICAgLy8gTk9UIHN0ZWFsIGZvY3VzIChhIHJlZiBpc24ndCB0aGUgd29ya2luZyBpbWFnZTsgaW1hZ2UuaW1wb3J0IGlzKS5cbiAgICAgIGNvbnN0IHJhdyA9IG1zZy5pbWFnZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgICAgIGlmICghcmF3IHx8IHR5cGVvZiByYXcuc3JjICE9PSBcInN0cmluZ1wiKSByZXR1cm47XG4gICAgICAvLyBsZWF2ZSBuYW1lIHVuZGVmaW5lZCB3aGVuIG5vdCBzdXBwbGllZCAoZG9uJ3Qgc3RvcmUgYSBcInJlZmVyZW5jZVwiXG4gICAgICAvLyBwbGFjZWhvbGRlciDigJQgYSBsYXRlciBpbWFnZS5pbXBvcnQgb2YgdGhlIHNhbWUgcGl4ZWxzIGNhbiBmaWxsIHRoZSBuYW1lKVxuICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiByYXcubmFtZSA9PT0gXCJzdHJpbmdcIiA/IHJhdy5uYW1lIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgeyB2YXJpYW50IH0gPSBpbXBvcnRJbWFnZVZhcmlhbnQocmF3LnNyYywgbmFtZSk7XG4gICAgICB2YXJpYW50LnJlZlNlbGVjdGVkID0gdHJ1ZTtcbiAgICAgIHB1c2hNZXNzYWdlKHtcbiAgICAgICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgICAgIGtpbmQ6IFwiZ2VzdHVyZVwiLFxuICAgICAgICB0ZXh0OiBg8J+TjiB5b3UgcG9pbnRlZCBhdCBhIHJlZmVyZW5jZSAoJHt2YXJpYW50Lm5hbWUgPz8gXCJpbWFnZVwifSlgLFxuICAgICAgICBnZXN0dXJlOiB7IGtpbmQ6IFwicmVmLWFkZGVkXCIsIHRhcmdldElkOiB2YXJpYW50LmlkIH0sXG4gICAgICB9KTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcInJlZi5yZW1vdmVcIikge1xuICAgICAgLy8gREVTRUxFQ1QgYSB2YXJpYW50IGFzIGEgcmVmIOKAlCBpdCBzdGF5cyBpbiB0aGUgbGlicmFyeSAoZGVsZXRlID0gdmFyaWFudC5yZW1vdmUpXG4gICAgICBjb25zdCBoaXQgPSBmaW5kVmFyaWFudChtc2cuaWQgYXMgc3RyaW5nKTtcbiAgICAgIGlmICghaGl0KSByZXR1cm47XG4gICAgICBoaXQudmFyaWFudC5yZWZTZWxlY3RlZCA9IGZhbHNlO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwicmVmLnNlbGVjdFwiKSB7XG4gICAgICBjb25zdCBoaXQgPSBmaW5kVmFyaWFudChtc2cuaWQgYXMgc3RyaW5nKTtcbiAgICAgIGlmICghaGl0KSByZXR1cm47XG4gICAgICBoaXQudmFyaWFudC5yZWZTZWxlY3RlZCA9IG1zZy5zZWxlY3RlZCA9PT0gdHJ1ZTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcImltYWdlLmltcG9ydFwiKSB7XG4gICAgICAvLyB0aGUgdXNlciBkcm9wcGVkIHRoZWlyIG93biBpbWFnZSBvbnRvIHRoZSBjYW52YXMg4oCUIGEgd29ya2luZyBpbWFnZVxuICAgICAgLy8gKGEgb25lLXZhcmlhbnQgXCJpbXBvcnRcIiBiYXRjaCksIGZvY3VzZWQgc28gdGhleSBjYW4gYW5ub3RhdGUvZWRpdCBpdFxuICAgICAgY29uc3QgcmF3ID0gbXNnLmltYWdlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICAgICAgaWYgKCFyYXcgfHwgdHlwZW9mIHJhdy5zcmMgIT09IFwic3RyaW5nXCIpIHJldHVybjtcbiAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgcmF3Lm5hbWUgPT09IFwic3RyaW5nXCIgPyByYXcubmFtZSA6IFwiaW1wb3J0ZWQgaW1hZ2VcIjtcbiAgICAgIGNvbnN0IHsgYmF0Y2hJZCwgdmFyaWFudCB9ID0gaW1wb3J0SW1hZ2VWYXJpYW50KHJhdy5zcmMsIG5hbWUpO1xuICAgICAgc3RhdGUuZm9jdXMgPSB7IGJhdGNoSWQsIHZhcmlhbnRJZDogdmFyaWFudC5pZCB9O1xuICAgICAgcHVzaE1lc3NhZ2Uoe1xuICAgICAgICByb2xlOiBcInVzZXJcIixcbiAgICAgICAga2luZDogXCJnZXN0dXJlXCIsXG4gICAgICAgIHRleHQ6IGDwn5a8IHlvdSBicm91Z2h0IGluIGFuIGltYWdlIHRvIHdvcmsgb24gKCR7dmFyaWFudC5uYW1lID8/IG5hbWV9KWAsXG4gICAgICAgIGdlc3R1cmU6IHsga2luZDogXCJpbXBvcnRlZFwiLCB0YXJnZXRJZDogdmFyaWFudC5pZCB9LFxuICAgICAgfSk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJsYXllci5hZGRJbWFnZVwiKSB7XG4gICAgICAvLyBkcm9wIGFuIGltYWdlIGFzIGEgTEFZRVIgb24gdGhlIGZvY3VzZWQgaW1hZ2UgKGNvbGxhZ2UpLiBUaGUgY2xpZW50XG4gICAgICAvLyBzdXBwbGllcyB0aGUgZnJhY3Rpb24tc3BhY2UgYm94IChpdCBrbm93cyB0aGUgYmFzZSBpbWFnZSBib3ggKyB0aGUgZHJvcHBlZFxuICAgICAgLy8gYml0bWFwJ3MgYXNwZWN0KTsgZGVmYXVsdCB0byBhIGNlbnRlcmVkIDQwJSBib3guIE5vIGFnZW50IGV2ZW50IHVudGlsXG4gICAgICAvLyBjb21taXQgKHNhbWUgcnVsZSBhcyBtYXJrLmFkZCkg4oCUIHRoZSBmbGF0dGVuZWQgY29tcG9zaXRlIGNhcnJpZXMgaXQuXG4gICAgICBjb25zdCB2aWQgPSBzdGF0ZS5mb2N1cz8udmFyaWFudElkO1xuICAgICAgY29uc3QgcmF3ID0gbXNnIGFzIHtcbiAgICAgICAgc3JjPzogdW5rbm93bjtcbiAgICAgICAgbmFtZT86IHVua25vd247XG4gICAgICAgIHg/OiB1bmtub3duO1xuICAgICAgICB5PzogdW5rbm93bjtcbiAgICAgICAgdz86IHVua25vd247XG4gICAgICAgIGg/OiB1bmtub3duO1xuICAgICAgfTtcbiAgICAgIGlmICghdmlkIHx8IHR5cGVvZiByYXcuc3JjICE9PSBcInN0cmluZ1wiKSByZXR1cm47XG4gICAgICBjb25zdCBudW0gPSAodjogdW5rbm93biwgZDogbnVtYmVyKSA9PiAodHlwZW9mIHYgPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKHYpID8gdiA6IGQpO1xuICAgICAgY29uc3QgdyA9IG51bShyYXcudywgMC40KTtcbiAgICAgIGNvbnN0IGggPSBudW0ocmF3LmgsIDAuNCk7XG4gICAgICBjb25zdCB4ID0gbnVtKHJhdy54LCAoMSAtIHcpIC8gMik7XG4gICAgICBjb25zdCB5ID0gbnVtKHJhdy55LCAoMSAtIGgpIC8gMik7XG4gICAgICBjb25zdCBvcHRpbWl6ZWQgPSBhd2FpdCBvcHRpbWl6ZVNyYyhyYXcuc3JjKTtcbiAgICAgIHB1c2hIaXN0b3J5KHZpZCk7IC8vIGFmdGVyIHRoZSBhd2FpdCwgc28gYW55IGludGVybGVhdmVkIGVkaXQgaXMgaW4gdGhlIHNuYXBzaG90XG4gICAgICBpZiAoIXN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdKSBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXSA9IFtdO1xuICAgICAgY29uc3QgbGF5ZXI6IExheWVyID0ge1xuICAgICAgICBpZDogbmV3SWQoXCJsYXllclwiKSxcbiAgICAgICAgbmFtZTogdHlwZW9mIHJhdy5uYW1lID09PSBcInN0cmluZ1wiICYmIHJhdy5uYW1lID8gcmF3Lm5hbWUgOiBcIkltYWdlXCIsXG4gICAgICAgIGtpbmQ6IFwiaW1hZ2VcIixcbiAgICAgIH07XG4gICAgICBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXS5wdXNoKGxheWVyKTsgLy8gYSBuZXcgaW1hZ2UgbGF5ZXIgb24gdG9wXG4gICAgICBpZiAoIXN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF0pIHN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF0gPSBbXTtcbiAgICAgIGNvbnN0IGFyciA9IHN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF07XG4gICAgICBhcnIucHVzaCh7XG4gICAgICAgIGlkOiBuZXdJZChcImltZ1wiKSxcbiAgICAgICAgdG9vbDogXCJpbWFnZVwiLFxuICAgICAgICBzcmM6IG9wdGltaXplZCxcbiAgICAgICAgeCxcbiAgICAgICAgeSxcbiAgICAgICAgdyxcbiAgICAgICAgaCxcbiAgICAgICAgbGF5ZXJJZDogbGF5ZXIuaWQsXG4gICAgICAgIHpPcmRlcjogYXJyLmxlbmd0aCxcbiAgICAgIH0pO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwibGF5ZXIuYWRkXCIpIHtcbiAgICAgIC8vIGEgYmxhbmsgbGF5ZXIgb24gdG9wIOKAlCBiZWNvbWVzIHRoZSBzdXJmYWNlJ3MgYWN0aXZlIGRyYXcgdGFyZ2V0XG4gICAgICBjb25zdCB2aWQgPSBzdGF0ZS5mb2N1cz8udmFyaWFudElkO1xuICAgICAgaWYgKCF2aWQpIHJldHVybjtcbiAgICAgIGlmICghc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0pIHN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdID0gW107XG4gICAgICBwdXNoSGlzdG9yeSh2aWQpO1xuICAgICAgY29uc3Qga2luZDogTGF5ZXJbXCJraW5kXCJdID1cbiAgICAgICAgbXNnLmtpbmQgPT09IFwic2tldGNoXCIgfHwgbXNnLmtpbmQgPT09IFwiaW1hZ2VcIiA/IG1zZy5raW5kIDogXCJhbm5vdGF0aW9uXCI7XG4gICAgICBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXS5wdXNoKHtcbiAgICAgICAgaWQ6IG5ld0lkKFwibGF5ZXJcIiksXG4gICAgICAgIG5hbWU6IHR5cGVvZiBtc2cubmFtZSA9PT0gXCJzdHJpbmdcIiAmJiBtc2cubmFtZSA/IG1zZy5uYW1lIDogXCJMYXllclwiLFxuICAgICAgICBraW5kLFxuICAgICAgfSk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJsYXllci5yZW5hbWVcIikge1xuICAgICAgY29uc3QgdmlkID0gc3RhdGUuZm9jdXM/LnZhcmlhbnRJZDtcbiAgICAgIGNvbnN0IGxheWVyID0gdmlkID8gc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0/LmZpbmQoKGwpID0+IGwuaWQgPT09IG1zZy5pZCkgOiB1bmRlZmluZWQ7XG4gICAgICBpZiAoIWxheWVyIHx8IHR5cGVvZiBtc2cubmFtZSAhPT0gXCJzdHJpbmdcIiB8fCAhbXNnLm5hbWUgfHwgbGF5ZXIubmFtZSA9PT0gbXNnLm5hbWUpIHJldHVybjtcbiAgICAgIHB1c2hIaXN0b3J5KHZpZCk7XG4gICAgICBsYXllci5uYW1lID0gbXNnLm5hbWU7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJsYXllci5zZXRIaWRkZW5cIiB8fCB0ID09PSBcImxheWVyLnNldExvY2tlZFwiKSB7XG4gICAgICBjb25zdCB2aWQgPSBzdGF0ZS5mb2N1cz8udmFyaWFudElkO1xuICAgICAgY29uc3QgbGF5ZXIgPSB2aWQgPyBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXT8uZmluZCgobCkgPT4gbC5pZCA9PT0gbXNnLmlkKSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IGtleSA9IHQgPT09IFwibGF5ZXIuc2V0SGlkZGVuXCIgPyBcImhpZGRlblwiIDogXCJsb2NrZWRcIjtcbiAgICAgIGNvbnN0IG5leHQgPSB0ID09PSBcImxheWVyLnNldEhpZGRlblwiID8gbXNnLmhpZGRlbiA6IG1zZy5sb2NrZWQ7XG4gICAgICBpZiAoIWxheWVyIHx8IHR5cGVvZiBuZXh0ICE9PSBcImJvb2xlYW5cIiB8fCBCb29sZWFuKGxheWVyW2tleV0pID09PSBuZXh0KSByZXR1cm47XG4gICAgICBwdXNoSGlzdG9yeSh2aWQpO1xuICAgICAgbGF5ZXJba2V5XSA9IG5leHQ7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJsYXllci5yZW9yZGVyXCIpIHtcbiAgICAgIC8vIGFic29sdXRlIHBsYWNlbWVudCAoZHJhZy1kcm9wKTogbW92ZSBsYXllciBgaWRgIHRvIGB0b0luZGV4YCAoYmFja+KGkmZyb250KVxuICAgICAgY29uc3QgdmlkID0gc3RhdGUuZm9jdXM/LnZhcmlhbnRJZDtcbiAgICAgIGNvbnN0IGxheWVycyA9IHZpZCA/IHN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgaWR4ID0gbGF5ZXJzPy5maW5kSW5kZXgoKGwpID0+IGwuaWQgPT09IG1zZy5pZCkgPz8gLTE7XG4gICAgICBpZiAoIXZpZCB8fCAhbGF5ZXJzIHx8IGlkeCA8IDAgfHwgdHlwZW9mIG1zZy50b0luZGV4ICE9PSBcIm51bWJlclwiKSByZXR1cm47XG4gICAgICBjb25zdCB0byA9IE1hdGgubWF4KDAsIE1hdGgubWluKGxheWVycy5sZW5ndGggLSAxLCBNYXRoLnRydW5jKG1zZy50b0luZGV4KSkpO1xuICAgICAgaWYgKHRvID09PSBpZHgpIHJldHVybjtcbiAgICAgIHB1c2hIaXN0b3J5KHZpZCk7XG4gICAgICBjb25zdCBbbF0gPSBsYXllcnMuc3BsaWNlKGlkeCwgMSk7XG4gICAgICBsYXllcnMuc3BsaWNlKHRvLCAwLCBsKTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcImxheWVyLnJlbW92ZVwiKSB7XG4gICAgICAvLyBkZWxldGUgYSBsYXllciBBTkQgdGhlIGVsZW1lbnRzIGl0IGNvbnRhaW5lZFxuICAgICAgY29uc3QgdmlkID0gc3RhdGUuZm9jdXM/LnZhcmlhbnRJZDtcbiAgICAgIGlmICghdmlkIHx8ICFzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXT8uc29tZSgobCkgPT4gbC5pZCA9PT0gbXNnLmlkKSkgcmV0dXJuO1xuICAgICAgcHVzaEhpc3RvcnkodmlkKTtcbiAgICAgIHN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdID0gc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0uZmlsdGVyKChsKSA9PiBsLmlkICE9PSBtc2cuaWQpO1xuICAgICAgaWYgKHN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF0pIHtcbiAgICAgICAgc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXSA9IHN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF0uZmlsdGVyKChtKSA9PiBtLmxheWVySWQgIT09IG1zZy5pZCk7XG4gICAgICB9XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJncm91cFwiKSB7XG4gICAgICAvLyB3cmFwIHRoZSBzZWxlY3RlZCBtYXJrcyBpbiBhIG5ldyBsYXllciBvbiB0b3A7IHJlYXNzaWduIGxheWVySWQvek9yZGVyLlxuICAgICAgY29uc3QgdmlkID0gc3RhdGUuZm9jdXM/LnZhcmlhbnRJZDtcbiAgICAgIGNvbnN0IGlkcyA9IG1zZy5tYXJrSWRzO1xuICAgICAgaWYgKCF2aWQgfHwgIUFycmF5LmlzQXJyYXkoaWRzKSB8fCAhaWRzLmxlbmd0aCkgcmV0dXJuO1xuICAgICAgY29uc3QgbWFya3MgPSBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdID8/IFtdO1xuICAgICAgY29uc3QgaWRTZXQgPSBuZXcgU2V0KGlkcy5maWx0ZXIoKHgpOiB4IGlzIHN0cmluZyA9PiB0eXBlb2YgeCA9PT0gXCJzdHJpbmdcIikpO1xuICAgICAgY29uc3QgcGlja2VkID0gbWFya3MuZmlsdGVyKChtKSA9PiBpZFNldC5oYXMobS5pZCkpO1xuICAgICAgaWYgKCFwaWNrZWQubGVuZ3RoKSByZXR1cm47XG4gICAgICBwdXNoSGlzdG9yeSh2aWQpO1xuICAgICAgaWYgKCFzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXSkgc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0gPSBbXTtcbiAgICAgIGNvbnN0IGxheWVycyA9IHN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdO1xuICAgICAgY29uc3Qgc291cmNlSWRzID0gbmV3IFNldChwaWNrZWQubWFwKChtKSA9PiBtLmxheWVySWQpLmZpbHRlcihCb29sZWFuKSBhcyBzdHJpbmdbXSk7XG4gICAgICAvLyBob21vZ2VuZW91cyBzZWxlY3Rpb25zIGtlZXAgdGhlaXIga2luZCAoYSBwdXJlLWltYWdlIGdyb3VwIG11c3Qgc3RheSBhblxuICAgICAgLy8gaW1hZ2UgbGF5ZXIg4oCUIGVsc2UgZW5zdXJlRHJhd0xheWVyIHdvdWxkIHRyZWF0IGl0IGFzIGEgZHJhdyB0YXJnZXQgYW5kIHRoZVxuICAgICAgLy8gcGFuZWwgd291bGQgc2hvdyBhIHNoYXBlcyBpY29uIGluc3RlYWQgb2YgdGhlIGJpdG1hcCB0aHVtYm5haWwpOyBhIG1peGVkXG4gICAgICAvLyBzZWxlY3Rpb24gaXMgYSBnZW5lcmljIGFubm90YXRpb24gZ3JvdXAuXG4gICAgICBjb25zdCBncm91cDogTGF5ZXIgPSB7XG4gICAgICAgIGlkOiBuZXdJZChcImxheWVyXCIpLFxuICAgICAgICBuYW1lOiB0eXBlb2YgbXNnLm5hbWUgPT09IFwic3RyaW5nXCIgJiYgbXNnLm5hbWUgPyBtc2cubmFtZSA6IFwiR3JvdXBcIixcbiAgICAgICAga2luZDogcGlja2VkLmV2ZXJ5KChtKSA9PiBtLnRvb2wgPT09IFwiZHJhd1wiKVxuICAgICAgICAgID8gXCJza2V0Y2hcIlxuICAgICAgICAgIDogcGlja2VkLmV2ZXJ5KChtKSA9PiBtLnRvb2wgPT09IFwiaW1hZ2VcIilcbiAgICAgICAgICAgID8gXCJpbWFnZVwiXG4gICAgICAgICAgICA6IFwiYW5ub3RhdGlvblwiLFxuICAgICAgfTtcbiAgICAgIGxheWVycy5wdXNoKGdyb3VwKTtcbiAgICAgIHBpY2tlZC5mb3JFYWNoKChtLCBpKSA9PiB7XG4gICAgICAgIG0ubGF5ZXJJZCA9IGdyb3VwLmlkO1xuICAgICAgICBtLnpPcmRlciA9IGk7XG4gICAgICB9KTtcbiAgICAgIC8vIHBydW5lIHNvdXJjZSBsYXllcnMgdGhlIG1vdmUgZW1wdGllZCAobmV2ZXIgdGhlIG5ldyBvbmUgb3IgYSBzdGlsbC1vY2N1cGllZCBvbmUpXG4gICAgICBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXSA9IGxheWVycy5maWx0ZXIoXG4gICAgICAgIChsKSA9PiBsLmlkID09PSBncm91cC5pZCB8fCAhc291cmNlSWRzLmhhcyhsLmlkKSB8fCBtYXJrcy5zb21lKChtKSA9PiBtLmxheWVySWQgPT09IGwuaWQpLFxuICAgICAgKTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcInVuZ3JvdXBcIikge1xuICAgICAgLy8gZGlzc29sdmUgYSBsYXllciDihpIgZWFjaCBlbGVtZW50IGJlY29tZXMgaXRzIG93biBncm91cC1vZi1vbmUgbGF5ZXIgaW4gcGxhY2VcbiAgICAgIGNvbnN0IHZpZCA9IHN0YXRlLmZvY3VzPy52YXJpYW50SWQ7XG4gICAgICBjb25zdCBsYXllcnMgPSB2aWQgPyBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IGF0ID0gbGF5ZXJzPy5maW5kSW5kZXgoKGwpID0+IGwuaWQgPT09IG1zZy5pZCkgPz8gLTE7XG4gICAgICBpZiAoIXZpZCB8fCAhbGF5ZXJzIHx8IGF0IDwgMCkgcmV0dXJuO1xuICAgICAgY29uc3QgbWVtYmVycyA9IChzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdID8/IFtdKVxuICAgICAgICAuZmlsdGVyKChtKSA9PiBtLmxheWVySWQgPT09IG1zZy5pZClcbiAgICAgICAgLnNvcnQoKGEsIGIpID0+IChhLnpPcmRlciA/PyAwKSAtIChiLnpPcmRlciA/PyAwKSk7XG4gICAgICBpZiAobWVtYmVycy5sZW5ndGggPCAyKSByZXR1cm47IC8vIDAvMSBlbGVtZW50IGlzIGFscmVhZHkgYSBncm91cC1vZi1vbmVcbiAgICAgIHB1c2hIaXN0b3J5KHZpZCk7XG4gICAgICBjb25zdCBmcmVzaDogTGF5ZXJbXSA9IG1lbWJlcnMubWFwKChtKSA9PiB7XG4gICAgICAgIGNvbnN0IGlkID0gbmV3SWQoXCJsYXllclwiKTtcbiAgICAgICAgbS5sYXllcklkID0gaWQ7XG4gICAgICAgIG0uek9yZGVyID0gMDtcbiAgICAgICAgcmV0dXJuIHsgaWQsIG5hbWU6IFRPT0xfTEFCRUxbbS50b29sXSwga2luZDoga2luZEZvclRvb2wobS50b29sKSB9O1xuICAgICAgfSk7XG4gICAgICBsYXllcnMuc3BsaWNlKGF0LCAxLCAuLi5mcmVzaCk7IC8vIHJlcGxhY2UgdGhlIGRpc3NvbHZlZCBsYXllciwgcHJlc2VydmluZyB6LWJhbmRcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcIm1hcmsuYWRkXCIpIHtcbiAgICAgIGNvbnN0IG1rID0gbXNnLm1hcmsgYXMgTWFyayB8IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IHZpZCA9IHN0YXRlLmZvY3VzPy52YXJpYW50SWQ7XG4gICAgICBpZiAoIXZpZCB8fCAhbWs/LmlkIHx8ICFNQVJLX1RPT0xTLmluY2x1ZGVzKG1rLnRvb2wpKSByZXR1cm47XG4gICAgICBwdXNoSGlzdG9yeSh2aWQpO1xuICAgICAgaWYgKCFzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdKSBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdID0gW107XG4gICAgICBjb25zdCBhcnIgPSBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdO1xuICAgICAgLy8gY29udGFpbmVyIG1vZGVsOiBob25vciBhIHZhbGlkIGNsaWVudC1jaG9zZW4gYWN0aXZlIGxheWVyLCBlbHNlIGRlZmF1bHRcbiAgICAgIGNvbnN0IHdhbnRlZCA9IHR5cGVvZiBtay5sYXllcklkID09PSBcInN0cmluZ1wiID8gbWsubGF5ZXJJZCA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IG9uTGF5ZXIgPSB3YW50ZWQgJiYgc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0/LnNvbWUoKGwpID0+IGwuaWQgPT09IHdhbnRlZCk7XG4gICAgICBtay5sYXllcklkID0gb25MYXllciA/ICh3YW50ZWQgYXMgc3RyaW5nKSA6IGVuc3VyZURyYXdMYXllcih2aWQpO1xuICAgICAgbWsuek9yZGVyID0gYXJyLmxlbmd0aDsgLy8gc2VydmVyIGlzIGF1dGhvcml0YXRpdmUgZm9yIHotb3JkZXJcbiAgICAgIGFyci5wdXNoKG1rKTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7IC8vIGluY3JlbWVudGFsIOKAlCBubyBhZ2VudCBldmVudCB1bnRpbCBjb21taXRcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwibWFyay5yZW1vdmVcIikge1xuICAgICAgY29uc3QgdmlkID0gc3RhdGUuZm9jdXM/LnZhcmlhbnRJZDtcbiAgICAgIGlmICghdmlkIHx8ICFzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdKSByZXR1cm47XG4gICAgICBpZiAoIXN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF0uc29tZSgobSkgPT4gbS5pZCA9PT0gbXNnLmlkKSkgcmV0dXJuOyAvLyBuby1vcCDihpIgbm8gaGlzdG9yeVxuICAgICAgcHVzaEhpc3RvcnkodmlkKTtcbiAgICAgIHN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF0gPSBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdLmZpbHRlcigobSkgPT4gbS5pZCAhPT0gbXNnLmlkKTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcIm1hcmsudXBkYXRlXCIpIHtcbiAgICAgIC8vIG1vdmUvcmVzaXplL3JlbGFiZWwgYSBjb21taXR0ZWQgbWFyayBvbiB0aGUgZm9jdXNlZCBpbWFnZTsgbWVyZ2VcbiAgICAgIC8vIGdlb21ldHJ5L2xhYmVsL3N0eWxlIGtleXMgb25seSwgbmV2ZXIgaWQvdG9vbC96T3JkZXIgKHNlcnZlci1vd25lZCkuXG4gICAgICBjb25zdCB2aWQgPSBzdGF0ZS5mb2N1cz8udmFyaWFudElkO1xuICAgICAgY29uc3QgbSA9IHZpZFxuICAgICAgICA/IChzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdPy5maW5kKCh4KSA9PiB4LmlkID09PSBtc2cuaWQpIGFzXG4gICAgICAgICAgICB8IFJlY29yZDxzdHJpbmcsIHVua25vd24+XG4gICAgICAgICAgICB8IHVuZGVmaW5lZClcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBwYXRjaCA9IG1zZy5wYXRjaCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgICAgIGlmICghbSB8fCAhcGF0Y2ggfHwgdHlwZW9mIHBhdGNoICE9PSBcIm9iamVjdFwiKSByZXR1cm47XG4gICAgICBwdXNoSGlzdG9yeSh2aWQpO1xuICAgICAgZm9yIChjb25zdCBbaywgdmFsXSBvZiBPYmplY3QuZW50cmllcyhwYXRjaCkpIHtcbiAgICAgICAgaWYgKGsgPT09IFwiaWRcIiB8fCBrID09PSBcInRvb2xcIiB8fCBrID09PSBcInpPcmRlclwiKSBjb250aW51ZTtcbiAgICAgICAgaWYgKHR5cGVvZiB2YWwgPT09IFwibnVtYmVyXCIgfHwgdHlwZW9mIHZhbCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgIG1ba10gPSB2YWw7XG4gICAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgICAgLy8gYSBkcmF3IG1hcmsncyBgcG9pbnRzYCBtb3ZlL3Jlc2l6ZSBhcyBhIHdob2xlIGFycmF5IG9mIHt4LHl9XG4gICAgICAgICAgayA9PT0gXCJwb2ludHNcIiAmJlxuICAgICAgICAgIEFycmF5LmlzQXJyYXkodmFsKSAmJlxuICAgICAgICAgIHZhbC5ldmVyeShcbiAgICAgICAgICAgIChwKSA9PlxuICAgICAgICAgICAgICBwICYmXG4gICAgICAgICAgICAgIHR5cGVvZiBwID09PSBcIm9iamVjdFwiICYmXG4gICAgICAgICAgICAgIHR5cGVvZiAocCBhcyB7IHg6IHVua25vd24gfSkueCA9PT0gXCJudW1iZXJcIiAmJlxuICAgICAgICAgICAgICB0eXBlb2YgKHAgYXMgeyB5OiB1bmtub3duIH0pLnkgPT09IFwibnVtYmVyXCIsXG4gICAgICAgICAgKVxuICAgICAgICApIHtcbiAgICAgICAgICBtW2tdID0gdmFsO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJtYXJrLnJlb3JkZXJcIikge1xuICAgICAgY29uc3QgdmlkID0gc3RhdGUuZm9jdXM/LnZhcmlhbnRJZDtcbiAgICAgIGlmICghdmlkIHx8ICFzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdKSByZXR1cm47XG4gICAgICBjb25zdCBzb3J0ZWQgPSBbLi4uc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXV0uc29ydChcbiAgICAgICAgKGEsIGIpID0+IChhLnpPcmRlciA/PyAwKSAtIChiLnpPcmRlciA/PyAwKSxcbiAgICAgICk7XG4gICAgICBjb25zdCBpZHggPSBzb3J0ZWQuZmluZEluZGV4KChtKSA9PiBtLmlkID09PSBtc2cuaWQpO1xuICAgICAgaWYgKGlkeCA8IDApIHJldHVybjtcbiAgICAgIHB1c2hIaXN0b3J5KHZpZCk7IC8vIHN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF0gaXMgc3RpbGwgdGhlIHByZS1yZW9yZGVyIGFycmF5XG4gICAgICBjb25zdCBbbV0gPSBzb3J0ZWQuc3BsaWNlKGlkeCwgMSk7XG4gICAgICBjb25zdCB0YXJnZXQgPVxuICAgICAgICBtc2cuZGlyZWN0aW9uID09PSBcImZyb250XCJcbiAgICAgICAgICA/IHNvcnRlZC5sZW5ndGhcbiAgICAgICAgICA6IG1zZy5kaXJlY3Rpb24gPT09IFwiYmFjay1tb3N0XCJcbiAgICAgICAgICAgID8gMFxuICAgICAgICAgICAgOiBtc2cuZGlyZWN0aW9uID09PSBcImZvcndhcmRcIlxuICAgICAgICAgICAgICA/IE1hdGgubWluKHNvcnRlZC5sZW5ndGgsIGlkeCArIDEpXG4gICAgICAgICAgICAgIDogTWF0aC5tYXgoMCwgaWR4IC0gMSk7IC8vIFwiYmFja1wiXG4gICAgICBzb3J0ZWQuc3BsaWNlKHRhcmdldCwgMCwgbSk7XG4gICAgICBzb3J0ZWQuZm9yRWFjaCgobW0sIGkpID0+IHtcbiAgICAgICAgbW0uek9yZGVyID0gaTtcbiAgICAgIH0pO1xuICAgICAgc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXSA9IHNvcnRlZDtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcIm1hcmtzLmNsZWFyXCIpIHtcbiAgICAgIGNvbnN0IHZpZCA9IHN0YXRlLmZvY3VzPy52YXJpYW50SWQ7XG4gICAgICBpZiAodmlkICYmIHN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF0/Lmxlbmd0aCkge1xuICAgICAgICBwdXNoSGlzdG9yeSh2aWQpO1xuICAgICAgICBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdID0gW107XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmICh0ID09PSBcIm1hcmtzLnJlcGxhY2VcIikge1xuICAgICAgLy8gd2hvbGVzYWxlIHN3YXAgb2YgdGhlIGZvY3VzZWQgaW1hZ2UncyBtYXJrcyAodGhlIGVyYXNlciB0cmltcy9zcGxpdHNcbiAgICAgIC8vIHNldmVyYWwgc3Ryb2tlcyBhdCBvbmNlIOKGkiBvbmUgbWVzc2FnZSwgb25lIGhpc3Rvcnkgc3RlcCkuIFZhbGlkYXRlICtcbiAgICAgIC8vIHJlLWFzc2lnbiB6T3JkZXIgYnkgcG9zaXRpb24gKHNlcnZlci1hdXRob3JpdGF0aXZlKSwgbGlrZSBtYXJrLmFkZC5cbiAgICAgIGNvbnN0IHZpZCA9IHN0YXRlLmZvY3VzPy52YXJpYW50SWQ7XG4gICAgICBjb25zdCBpbmNvbWluZyA9IG1zZy5tYXJrcyBhcyBNYXJrW10gfCB1bmRlZmluZWQ7XG4gICAgICBpZiAoIXZpZCB8fCAhQXJyYXkuaXNBcnJheShpbmNvbWluZykpIHJldHVybjtcbiAgICAgIGNvbnN0IHZhbGlkID0gaW5jb21pbmcuZmlsdGVyKChtKSA9PiBtPy5pZCAmJiBNQVJLX1RPT0xTLmluY2x1ZGVzKG0udG9vbCkpO1xuICAgICAgcHVzaEhpc3RvcnkodmlkKTtcbiAgICAgIHZhbGlkLmZvckVhY2goKG0sIGkpID0+IHtcbiAgICAgICAgbS56T3JkZXIgPSBpO1xuICAgICAgfSk7XG4gICAgICBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdID0gdmFsaWQ7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJ1bmRvXCIgfHwgdCA9PT0gXCJyZWRvXCIpIHtcbiAgICAgIGNvbnN0IHZpZCA9IHN0YXRlLmZvY3VzPy52YXJpYW50SWQ7XG4gICAgICBpZiAoIXZpZCkgcmV0dXJuO1xuICAgICAgY29uc3QgaCA9IGhpc3RGb3IodmlkKTtcbiAgICAgIGNvbnN0IGZyb20gPSB0ID09PSBcInVuZG9cIiA/IGgudW5kbyA6IGgucmVkbztcbiAgICAgIGNvbnN0IHRvID0gdCA9PT0gXCJ1bmRvXCIgPyBoLnJlZG8gOiBoLnVuZG87XG4gICAgICBpZiAoIWZyb20ubGVuZ3RoKSByZXR1cm47XG4gICAgICB0by5wdXNoKHNuYXBGb3IodmlkKSk7XG4gICAgICBjb25zdCBwcmV2ID0gZnJvbS5wb3AoKSBhcyBNYXJrU25hcDtcbiAgICAgIHN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF0gPSBwcmV2Lm1hcmtzO1xuICAgICAgc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0gPSBwcmV2LmxheWVycztcbiAgICAgIG1hcmtVbnNlZW5bdmlkXSA9IHRydWU7IC8vIHRoZSBtYXJrcy9sYXllcnMgY2hhbmdlZCDihpIgYWdlbnQncyB2aWV3IGlzIHN0YWxlIGFnYWluXG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJtYXJrcy5jb21taXRcIikge1xuICAgICAgaWYgKFxuICAgICAgICB0eXBlb2YgbXNnLnRleHQgIT09IFwic3RyaW5nXCIgfHxcbiAgICAgICAgdHlwZW9mIG1zZy5iYXRjaElkICE9PSBcInN0cmluZ1wiIHx8XG4gICAgICAgIHR5cGVvZiBtc2cudmFyaWFudElkICE9PSBcInN0cmluZ1wiXG4gICAgICApXG4gICAgICAgIHJldHVybjtcbiAgICAgIGNvbnN0IG1hcmtzID0gc3RhdGUubWFya3NCeVZhcmlhbnRbbXNnLnZhcmlhbnRJZF0gPz8gW107XG4gICAgICAvLyBUaGUgdmlzdWFsIGhhbmRvZmY6IHRoZSBzdXJmYWNlIHNlbmRzIHRoZSBpbWFnZSB3aXRoIG1hcmtzIGJ1cm5lZCBpbiBhcyBhXG4gICAgICAvLyBkYXRhLXVybDsgbWF0ZXJpYWxpemUgaXQgdG8gZGlzayBzbyB0aGUgYWdlbnQgY2FuIC0tcmVmIGl0IGRpcmVjdGx5LiBUaGVcbiAgICAgIC8vIGJsb2Igc3RheXMgYnJvd3NlcuKGknNlcnZlciBvbmx5IOKAlCBqdXN0IHRoZSBwYXRoIHJpZGVzIHRoZSBTU0UgZXZlbnQuXG4gICAgICBsZXQgZmxhdHRlbmVkSW1hZ2VQYXRoOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgICBpZiAodHlwZW9mIG1zZy5mbGF0dGVuZWRTcmMgPT09IFwic3RyaW5nXCIgJiYgbXNnLmZsYXR0ZW5lZFNyYy5zdGFydHNXaXRoKFwiZGF0YTpcIikpIHtcbiAgICAgICAgZmxhdHRlbmVkSW1hZ2VQYXRoID1cbiAgICAgICAgICBzYXZlRGF0YVVybChzZXNzaW9uRmlsZXNEaXIsIG5ld0lkKFwiZmxhdFwiKSwgbXNnLmZsYXR0ZW5lZFNyYykgfHwgdW5kZWZpbmVkO1xuICAgICAgfVxuICAgICAgcHVzaE1lc3NhZ2Uoe1xuICAgICAgICByb2xlOiBcInVzZXJcIixcbiAgICAgICAga2luZDogXCJnZXN0dXJlXCIsXG4gICAgICAgIHRleHQ6IGDinI3vuI8gJHttc2cudGV4dH1gLFxuICAgICAgICBnZXN0dXJlOiB7IGtpbmQ6IFwibWFya2VkXCIsIHRhcmdldElkOiBtc2cudmFyaWFudElkIH0sXG4gICAgICB9KTtcbiAgICAgIC8vIGNvbW1pdHRpbmcgaGFuZHMgYSBTTkFQU0hPVCB0byB0aGUgYWdlbnQgYnV0IGxlYXZlcyB0aGUgbWFya3MgaW4gcGxhY2Ug4oCUXG4gICAgICAvLyB0aGV5J3JlIGR1cmFibGUgYW5ub3RhdGlvbnMgb24gdGhlIGltYWdlLCBub3QgY29uc3VtZWQgYnkgdGhlIHNlbmQuIFRoZVxuICAgICAgLy8gdXNlciBjbGVhcnMgdGhlbSBleHBsaWNpdGx5IChtYXJrcy5jbGVhcikgd2hlbiB0aGV5J3JlIGRvbmUgd2l0aCB0aGVtLlxuICAgICAgbWFya1Vuc2Vlblttc2cudmFyaWFudElkXSA9IGZhbHNlOyAvLyB0aGUgYWdlbnQgbm93IGhhcyB0aGUgbGF0ZXN0IG1hcmtzXG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgZW1pdEV2ZW50KHtcbiAgICAgICAgdHlwZTogXCJtYXJrcy5jb21taXRcIixcbiAgICAgICAgdGV4dDogbXNnLnRleHQsXG4gICAgICAgIGJhdGNoSWQ6IG1zZy5iYXRjaElkLFxuICAgICAgICB2YXJpYW50SWQ6IG1zZy52YXJpYW50SWQsXG4gICAgICAgIG1hcmtzLFxuICAgICAgICBzZWxlY3RlZFJlZklkczogc2VsZWN0ZWRSZWZJZHMoKSxcbiAgICAgICAgZmxhdHRlbmVkSW1hZ2VQYXRoLFxuICAgICAgfSk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcImFzcGVjdC5zZXRcIikge1xuICAgICAgaWYgKHR5cGVvZiBtc2cuYXNwZWN0ICE9PSBcInN0cmluZ1wiKSByZXR1cm47XG4gICAgICBzdGF0ZS5hc3BlY3QgPSBtc2cuYXNwZWN0O1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwic2l6ZS5zZXRcIikge1xuICAgICAgaWYgKG1zZy5zaXplICE9PSBcIjFLXCIgJiYgbXNnLnNpemUgIT09IFwiMktcIikgcmV0dXJuO1xuICAgICAgc3RhdGUuc2l6ZSA9IG1zZy5zaXplO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwic3VibWl0XCIpIHtcbiAgICAgIGJyb2FkY2FzdCh7IHR5cGU6IFwic3VibWl0XCIgfSk7XG4gICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcInN1Ym1pdFwiIH0pO1xuICAgICAgcmVzb2x2ZURvbmUoeyBjb2RlOiAwLCByZWFzb246IFwic3VibWl0XCIgfSk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcImNhbmNlbFwiKSB7XG4gICAgICBicm9hZGNhc3QoeyB0eXBlOiBcImNhbmNlbFwiIH0pO1xuICAgICAgcmVzb2x2ZURvbmUoeyBjb2RlOiAxMzAsIHJlYXNvbjogXCJjYW5jZWxcIiB9KTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBtb2RlID0gcmVzb2x2ZU1vZGUoKTtcblxuICAvLyBkZXY6IHRoZSBkeW5hbWljIHN0cmluZy1saXRlcmFsIGltcG9ydCBrZWVwcyB0aGUgc3VyZmFjZSBncmFwaCBvZmYgdGhlXG4gIC8vIG1vZHVsZSBsb2FkIHBhdGggKENvbnRyYWN0IDEpIOKAlCBCdW4gYnVuZGxlcyB0aGUgLnRzeCBncmFwaCArIFRhaWx3aW5kIGF0XG4gIC8vIHNlcnZlIHRpbWUsIHJlYWRpbmcgYnVuZmlnLnRvbWwgZnJvbSBjd2QsIHdoaWNoIGNsaS50cyBwaW5zIHRvIHNyYy9pbWFnby9cbiAgLy8gKENvbnRyYWN0IDUpLiBobXIgb24gZm9yIHRoZSBzdXJmYWNlIGl0ZXJhdGlvbiBsb29wLlxuICAvLyByZWxlYXNlOiBkaXN0LyBpcyBzdGF0aWMgYW5kIHByZS1idWlsdCAoQ29udHJhY3QgMikg4oCUIFwiL1wiIGlzIGFuc3dlcmVkIGJ5XG4gIC8vIHNlcnZlRGlzdCgpIGluIHRoZSBmZXRjaCBmYWxsLXRocm91Z2ggYmVsb3csIHNvIHRoaXMgYnJhbmNoIG5ldmVyIHRvdWNoZXNcbiAgLy8gc3VyZmFjZS8gb3IgYnVuZmlnLnRvbWwgYW5kIG5ldmVyIG5lZWRzIGVpdGhlciB0byBleGlzdC5cbiAgLy8gQnVuJ3MgUm91dGVzIHR5cGUgdGllcyB0aGUgXCIvXCIgdmFsdWUncyB0eXBlIHRvIHRoZSBsaXRlcmFsIG9iamVjdCBzaGFwZSwgc29cbiAgLy8gYSBtb2RlLXRlcm5hcnkgdW5pb24gY29uZnVzZXMgaXRzIG92ZXJsb2FkIHJlc29sdXRpb24g4oCUIHRoZSBydW50aW1lXG4gIC8vIGJlaGF2aW9yIChIVE1MQnVuZGxlIGluIGRldiwgYWJzZW50IGluIHJlbGVhc2UpIGlzIGNvcnJlY3QgZWl0aGVyIHdheS5cbiAgY29uc3QgZGV2SW5kZXggPVxuICAgIG1vZGUgPT09IFwiZGV2XCJcbiAgICAgID8gKGF3YWl0IGltcG9ydChcIi4uLy4uLy4uLy4uLy4uL3NyYy9pbWFnby9zdXJmYWNlL2luZGV4Lmh0bWxcIikpLmRlZmF1bHRcbiAgICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCByb3V0ZXMgPSAoZGV2SW5kZXggPyB7IFwiL1wiOiBkZXZJbmRleCB9IDoge30pIGFzIFJlY29yZDxzdHJpbmcsIG5ldmVyPjtcblxuICBsZXQgc2VydmVyOiBSZXR1cm5UeXBlPHR5cGVvZiBCdW4uc2VydmU+O1xuICB0cnkge1xuICAgIHNlcnZlciA9IEJ1bi5zZXJ2ZSh7XG4gICAgICBwb3J0LFxuICAgICAgaG9zdG5hbWU6IGhvc3QsXG4gICAgICByb3V0ZXMsXG4gICAgICAvLyDim5QgSEVMRCBTU0UgQ09OTkVDVElPTlMgRElFIFdJVEhPVVQgVEhJUy4gQnVuJ3MgZGVmYXVsdCByZXF1ZXN0XG4gICAgICAvLyBpZGxlVGltZW91dCBpcyAxMHMgYW5kIGEgc2VydmVyLXNlbnQgaGVhcnRiZWF0IGRvZXMgTk9UIHJlc2V0IGl0LCBzbyBhblxuICAgICAgLy8gU1NFIGNsaWVudCBpcyBjbG9zZWQgYmVmb3JlIHRoZSAxNXMgYDogaGJgIGJlbG93IGV2ZXIgZmlyZXMg4oCUIHRoZVxuICAgICAgLy8ga2VlcGFsaXZlIGFycml2ZXMgZml2ZSBzZWNvbmRzIGFmdGVyIHRoZSB0aGluZyBpdCB3YXMga2VlcGluZyBhbGl2ZSBpc1xuICAgICAgLy8gZ29uZSwgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCByYXRlIHdvdWxkIG5vdCBoYXZlIGhlbHBlZC5cbiAgICAgIC8vIDI1NSBpcyBCdW4ncyBtYXhpbXVtICgwIGlzIG5vdCBcImRpc2FibGVkXCIpLCBtYXRjaGluZyBib3VudHksIGdyYXBldmluZVxuICAgICAgLy8gYW5kIG1pbmQtbWFwcGVyOyBhc3Ryb2xhYmUgZW52LXR1bmVzIGl0IGFuZCBjbGFtcHMgdGhlIGhlYXJ0YmVhdCB0byBoYWxmLlxuICAgICAgLy8gRm91bmQgMjAyNi0wOS0wOCBieSB0aGUgYmFja2VuZCBkdXBsaWNhdGlvbiByZWNvbjogZm91ciBzcGVsbHMgaGFkIGhpdFxuICAgICAgLy8gdGhpcyBhbmQgZml4ZWQgaXQsIHRocmVlIGhhZCBub3QsIGJlY2F1c2UgdGhlIGRhZW1vbiBzcGluZSBpcyBvbmUgZGVzaWduXG4gICAgICAvLyBpbXBsZW1lbnRlZCBzaXggdGltZXMuXG4gICAgICAvL1xuICAgICAgLy8g4pqgIE5PIExPTkdFUiBBIExJVEVSQUwg4oCUIGFuZCBpdCBpcyB0aGUgT1RIRVIgSEFMRiBvZiB0aGUgcGFpciwgd2hpY2ggaXNcbiAgICAgIC8vIHRoZSB3aG9sZSByZWFzb24gYC4vaGVhcnRiZWF0LnRzYCBleGlzdHMuIFRoZSAyNTUgYW5kIHRoZSAxNSwwMDAgd2VyZVxuICAgICAgLy8gd3JpdHRlbiAxLDMwMCBsaW5lcyBhcGFydCBhbmQgY2hhaW5lZCBvbmx5IGJ5IHRoZSBwcm9zZSBhYm92ZTsgdGhleSBhcmVcbiAgICAgIC8vIG5vdyBkZXJpdmVkIHRvZ2V0aGVyIGFuZCB0aGUgY2xhbXAgaXMgZW5mb3JjZWQuXG4gICAgICBpZGxlVGltZW91dDogSURMRV9USU1FT1VUX1NFQyxcbiAgICAgIGRldmVsb3BtZW50OiB7IGhtcjogbW9kZSA9PT0gXCJkZXZcIiB9LFxuICAgICAgZmV0Y2g6IChyZXEsIHNydikgPT4ge1xuICAgICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwpO1xuICAgICAgICBjb25zdCBwYXRoID0gdXJsLnBhdGhuYW1lO1xuICAgICAgICBpZiAocGF0aCA9PT0gXCIvd3NcIikge1xuICAgICAgICAgIGNvbnN0IHVwZ3JhZGVkID0gc3J2LnVwZ3JhZGUocmVxKTtcbiAgICAgICAgICBpZiAodXBncmFkZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShcInVwZ3JhZGUgcmVxdWlyZWRcIiwgeyBzdGF0dXM6IDQyNiB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9zdGF0ZVwiKSB7XG4gICAgICAgICAgLy8g4puUIGB0b3VjaCgpYCDigJQgQ0VOU1VTIERFRkVDVCBMMiwgQU5EIElUIElTIEEgT05FLVdPUkQgRklYIEZPUiBBIFJFQUxcbiAgICAgICAgICAvLyBLSUxMLiBFdmVyeSBvdGhlciByb3V0ZSB0b3VjaGVkIHRoZSBhY3Rpdml0eSBjbG9jayBhbmQgdGhpcyBvbmUgZGlkXG4gICAgICAgICAgLy8gbm90LCBzbyBhbiBhZ2VudCBwb2xsaW5nIGAvc3RhdGVgIGluIGEgbG9vcCDigJQgdGhlIGV4YWN0IHNoYXBlXG4gICAgICAgICAgLy8gU0tJTEwubWQgdGVsbHMgaXQgdG8gdXNlIGZvciBhbWJpZW50IGJvYXJkIHN0YXRlIOKAlCB3YXMgaWRsZS1jbG9zZWRcbiAgICAgICAgICAvLyBVTkRFUiBJVFNFTEYgYXQgdGhlIDMwLW1pbnV0ZSBmbG9vciB3aGlsZSBpdCB3YXMgYWN0aXZlbHkgcmVhZGluZy5cbiAgICAgICAgICAvLyBOb3QgY2xvc2VkIGJ5IGEgbW9kdWxlOiBjbG9zZWQgYnkgYWRvcHRpbmcgdGhlIGhvdXNla2VlcGVyLCB3aGljaFxuICAgICAgICAgIC8vIG1hZGUgXCJ3aGF0IGNvdW50cyBhcyBhY3Rpdml0eVwiIGEgcXVlc3Rpb24gd2l0aCBvbmUgYW5zd2VyIGluc3RlYWQgb2ZcbiAgICAgICAgICAvLyBhIHByb3BlcnR5IG9mIHdoaWNoZXZlciByb3V0ZSB0aGUgYXV0aG9yIHJlbWVtYmVyZWQuXG4gICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICBjb25zdCBsZWFuID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJsZWFuXCIpID09PSBcIjFcIjtcbiAgICAgICAgICBjb25zdCBwYXlsb2FkID0gbGVhbiA/IGxlYW5TdGF0ZShzdGF0ZSkgOiBzdGF0ZTtcbiAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKEpTT04uc3RyaW5naWZ5KHsgc3RhdGU6IHBheWxvYWQsIGN1cnNvcjogbG9nLmN1cnNvcigpIH0pLCB7XG4gICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZXZlbnRzXCIpIHtcbiAgICAgICAgICByZXR1cm4gZXZlbnRzUmVzcG9uc2UocmVxLCB1cmwpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9jbWRcIikge1xuICAgICAgICAgIHJldHVybiByZXFcbiAgICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAgIC50aGVuKGFzeW5jIChib2R5KSA9PiB7XG4gICAgICAgICAgICAgIHRvdWNoKCk7XG4gICAgICAgICAgICAgIC8vICM4NCDigJQgdGhlIGBhd2FpdGAgaGVyZSB3YXMgQUxSRUFEWSBjb3JyZWN0LiBXaGF0IHdhcyBtaXNzaW5nIGlzXG4gICAgICAgICAgICAgIC8vIGEgdmVyZGljdCB0byBwcm9wYWdhdGUsIHNvIHRoaXMgYW5zd2VyZWQgYSBsaXRlcmFsIG9rOnRydWUgZXZlblxuICAgICAgICAgICAgICAvLyB0byBjb21tYW5kcyBpdCBkcm9wcGVkLlxuICAgICAgICAgICAgICBjb25zdCB2ZXJkaWN0ID0gYXdhaXQgaGFuZGxlQWdlbnRNc2coYm9keSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik7XG4gICAgICAgICAgICAgIC8vIEEgY29tbWFuZCB0aGF0IGFuc3dlcmVkIHdpdGggaXRzIG93biByZXN1bHQgY2FycmllcyBpdHMgb3duXG4gICAgICAgICAgICAgIC8vIHN0YXR1cyBhbmQgcGF5bG9hZDsgdGhlIGJvb2xlYW4gcGF0aCBiZWxvdyBpcyB1bmNoYW5nZWQuXG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgdmVyZGljdCA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgICAgIGlmICghdmVyZGljdC5vaykge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oXG4gICAgICAgICAgICAgICAgICAgIHsgb2s6IGZhbHNlLCBhcHBsaWVkOiBmYWxzZSwgZXJyb3I6IHZlcmRpY3QuZXJyb3IsIC4uLnZlcmRpY3QuZGV0YWlsIH0sXG4gICAgICAgICAgICAgICAgICAgIHsgc3RhdHVzOiB2ZXJkaWN0LnN0YXR1cyB9LFxuICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgYXBwbGllZDogdHJ1ZSwgLi4udmVyZGljdC5kZXRhaWwgfSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgY29uc3QgYXBwbGllZCA9IHZlcmRpY3Q7XG4gICAgICAgICAgICAgIGlmICghYXBwbGllZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKFxuICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIGFwcGxpZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICBlcnJvcjogYHVucmVjb2duaXNlZCBjb21tYW5kIHR5cGUgJHtKU09OLnN0cmluZ2lmeShcbiAgICAgICAgICAgICAgICAgICAgICAoYm9keSBhcyB7IHR5cGU/OiB1bmtub3duIH0pPy50eXBlLFxuICAgICAgICAgICAgICAgICAgICApfSDigJQgbm90aGluZyB3YXMgYXBwbGllZGAsXG4gICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgeyBzdGF0dXM6IDQwMCB9LFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZSgne1wib2tcIjp0cnVlLFwiYXBwbGllZFwiOnRydWV9Jywge1xuICAgICAgICAgICAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgLmNhdGNoKFxuICAgICAgICAgICAgICAoKSA9PlxuICAgICAgICAgICAgICAgIG5ldyBSZXNwb25zZSgne1wiZXJyb3JcIjpcImJhZCBqc29uXCJ9Jywge1xuICAgICAgICAgICAgICAgICAgc3RhdHVzOiA0MDAsXG4gICAgICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGguc3RhcnRzV2l0aChcIi9hc3NldHMvXCIpKSB7XG4gICAgICAgICAgY29uc3QgYXNzZXROYW1lID0gZGVjb2RlVVJJQ29tcG9uZW50KHBhdGguc2xpY2UoXCIvYXNzZXRzL1wiLmxlbmd0aCkpO1xuICAgICAgICAgIGlmIChhc3NldE5hbWUuaW5jbHVkZXMoXCIuLlwiKSB8fCBhc3NldE5hbWUuc3RhcnRzV2l0aChcIi9cIikpIHtcbiAgICAgICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoJ3tcImVycm9yXCI6XCJub3QgZm91bmRcIn0nLCB7XG4gICAgICAgICAgICAgIHN0YXR1czogNDA0LFxuICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgZiA9IEJ1bi5maWxlKGpvaW4oYXNzZXRzRGlyLCBhc3NldE5hbWUpKTtcbiAgICAgICAgICByZXR1cm4gZi5leGlzdHMoKS50aGVuKChleGlzdHMpID0+XG4gICAgICAgICAgICBleGlzdHNcbiAgICAgICAgICAgICAgPyBuZXcgUmVzcG9uc2UoZiwgeyBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IGd1ZXNzTWltZShhc3NldE5hbWUpIH0gfSlcbiAgICAgICAgICAgICAgOiBuZXcgUmVzcG9uc2UoJ3tcImVycm9yXCI6XCJub3QgZm91bmRcIn0nLCB7XG4gICAgICAgICAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgICAgICAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIC8vIHJlbGVhc2U6IFwiL1wiIGFuZCB0aGUgaGFzaGVkIGNodW5rLSouanMvY3NzIGFyZSBzdGF0aWMgZGlzdCByZWFkcy4gRGV2XG4gICAgICAgIC8vIG5ldmVyIHJlYWNoZXMgaGVyZSBmb3IgXCIvXCIg4oCUIHRoZSByb3V0ZXMgdGFibGUgYWJvdmUgYW5zd2VycyBpdCBmaXJzdC5cbiAgICAgICAgLy8gVGhpcyBzaXRzIEFGVEVSIC9hc3NldHMvLCB3aGljaCBzZXJ2ZXMgc2Vzc2lvbiBmaWxlcywgbm90IGRpc3Qgb25lcy5cbiAgICAgICAgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgICAgY29uc3QgYXNzZXQgPSBzZXJ2ZURpc3QocGF0aCk7XG4gICAgICAgICAgaWYgKGFzc2V0KSByZXR1cm4gYXNzZXQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZSgne1wiZXJyb3JcIjpcIm5vdCBmb3VuZFwifScsIHtcbiAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgIH0pO1xuICAgICAgfSxcbiAgICAgIHdlYnNvY2tldDoge1xuICAgICAgICBvcGVuKHdzKSB7XG4gICAgICAgICAgc29ja2V0cy5hZGQod3MpO1xuICAgICAgICAgIHRvdWNoKCk7XG4gICAgICAgICAgZW1pdFRyYW5zaWVudCh7IHR5cGU6IFwiY29ubmVjdGVkXCIgfSk7XG4gICAgICAgICAgd3Muc2VuZChKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGUgfSkpO1xuICAgICAgICB9LFxuICAgICAgICBtZXNzYWdlKF93cywgcmF3KSB7XG4gICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICBsZXQgbXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgbXNnID0gSlNPTi5wYXJzZSh0eXBlb2YgcmF3ID09PSBcInN0cmluZ1wiID8gcmF3IDogbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHJhdykpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgICBgaW1hZ286IGJhZCBqc29uIGZyb20gYnJvd3NlcjogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuYCxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIHZvaWQgaGFuZGxlQnJvd3Nlck1zZyhtc2cpO1xuICAgICAgICB9LFxuICAgICAgICBjbG9zZSh3cykge1xuICAgICAgICAgIHNvY2tldHMuZGVsZXRlKHdzKTtcbiAgICAgICAgICB0b3VjaCgpO1xuICAgICAgICAgIGVtaXRUcmFuc2llbnQoeyB0eXBlOiBcImRpc2Nvbm5lY3RlZFwiIH0pO1xuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBldmVudDogXCJiaW5kX2Vycm9yXCIsXG4gICAgICAgIGhvc3QsXG4gICAgICAgIHBvcnQsXG4gICAgICAgIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSksXG4gICAgICB9KX1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIDI7XG4gIH1cblxuICBjb25zdCBib3VuZFBvcnQgPSBzZXJ2ZXIucG9ydDtcbiAgaWYgKCFzZXNzaW9uSWQpIHNlc3Npb25JZCA9IGBpbWFnby0ke3JhbmRIZXgoNCl9LXAke2JvdW5kUG9ydH1gO1xuICBzZXNzaW9uRmlsZXNEaXIgPSBqb2luKHRtcGRpcigpLCBgJHtzZXNzaW9uSWR9LWZpbGVzYCk7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKHNlc3Npb25GaWxlc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGZhbGwgYmFjayB0byBuby1maWxlLXBhdGhzIChwYXRoIHN0YXlzIFwiXCIpICovXG4gIH1cbiAgLy8gT24gcmVzdG9yZSwgdGhlIHNuYXBzaG90J3Mgc3JjIGJsb2JzIGFyZSBzZWxmLWNvbnRhaW5lZCBidXQgaXRzIGZpbGUgcGF0aHNcbiAgLy8gYXJlIHN0YWxlIChvbGQgdG1wZGlyLCBjbGVhbmVkKS4gUmUtbWF0ZXJpYWxpemUgZmlsZXMgc28gdGhlIGFnZW50J3MgdmlzaW9uXG4gIC8vIChSZWFkIGJ5IHBhdGgpIHdvcmtzIGFnYWluLlxuICBpZiAocmVzdG9yZWQpIHtcbiAgICAvLyByZWZzLWFzLWFzc2V0cyBtaWdyYXRpb246IGEgbGVnYWN5IGByZWZzW11gIGFycmF5IOKGkiBhbiBpbXBvcnQta2luZCBiYXRjaCBvZlxuICAgIC8vIHZhcmlhbnRzLCBSRVVTSU5HIGVhY2ggcmVmIGlkIGFzIHRoZSB2YXJpYW50IGlkIChzbyByZS1yZXN0b3JlIGlzIGlkZW1wb3RlbnRcbiAgICAvLyBhbmQgYW55IGhpc3RvcmljYWwgc2VsZWN0ZWRSZWZJZHMgc3RpbGwgcmVzb2x2ZSkuIFJ1bnMgQkVGT1JFIG1hdGVyaWFsaXphdGlvblxuICAgIC8vIHNvIHRoZSBuZXcgdmFyaWFudHMgZ2V0IHRoZWlyIG9uLWRpc2sgcGF0aHMuXG4gICAgdHlwZSBMZWdhY3lSZWYgPSB7XG4gICAgICBpZDogc3RyaW5nO1xuICAgICAgc3JjOiBzdHJpbmc7XG4gICAgICBwYXRoPzogc3RyaW5nO1xuICAgICAgbmFtZT86IHN0cmluZztcbiAgICAgIHNlbGVjdGVkPzogYm9vbGVhbjtcbiAgICAgIGhhc2g/OiBzdHJpbmc7XG4gICAgICBhbmFseXNpcz86IHN0cmluZztcbiAgICB9O1xuICAgIGNvbnN0IGxlZ2FjeVJlZnMgPSAoc3RhdGUgYXMgeyByZWZzPzogTGVnYWN5UmVmW10gfSkucmVmcztcbiAgICBpZiAoQXJyYXkuaXNBcnJheShsZWdhY3lSZWZzKSAmJiBsZWdhY3lSZWZzLmxlbmd0aCkge1xuICAgICAgc3RhdGUuYmF0Y2hlcy5wdXNoKHtcbiAgICAgICAgaWQ6IG5ld0lkKFwiYlwiKSxcbiAgICAgICAga2luZDogXCJpbXBvcnRcIixcbiAgICAgICAgcHJvbXB0OiBcIlwiLFxuICAgICAgICB0YWc6IFwicmVmZXJlbmNlc1wiLFxuICAgICAgICB2YXJpYW50czogbGVnYWN5UmVmcy5tYXAoKHIpID0+IHtcbiAgICAgICAgICBjb25zdCBoYXNoID0gci5oYXNoID8/IChyLnNyYyA/IGNvbnRlbnRIYXNoKHIuc3JjKSA6IHVuZGVmaW5lZCk7XG4gICAgICAgICAgLy8gc2VlZCB0aGUgaGFzaOKGkmFuYWx5c2lzIGNhY2hlIHNvIGRlbGV0aW5nICsgcmUtaW1wb3J0aW5nIHRoZSBzYW1lIHBpeGVsc1xuICAgICAgICAgIC8vIHN0aWxsIHJldXNlcyB0aGUgYWdlbnQncyBwcmlvciByZWFkICh0aGUgb2xkIGRlbGV0ZS9yZS1hZGQgaW52YXJpYW50KVxuICAgICAgICAgIGlmIChoYXNoICYmIHIuYW5hbHlzaXMpIHN0YXRlLmFuYWx5c2lzQ2FjaGVbaGFzaF0gPSByLmFuYWx5c2lzO1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBpZDogci5pZCwgLy8gcmV1c2UgdGhlIHJlZiBpZCBhcyB0aGUgdmFyaWFudCBpZFxuICAgICAgICAgICAgc3JjOiByLnNyYyxcbiAgICAgICAgICAgIHBhdGg6IHIucGF0aCA/PyBcIlwiLFxuICAgICAgICAgICAgbGlrZWQ6IGZhbHNlLFxuICAgICAgICAgICAgYW5hbHlzaXM6IHIuYW5hbHlzaXMgPz8gXCJcIixcbiAgICAgICAgICAgIG5hbWU6IHIubmFtZSxcbiAgICAgICAgICAgIHJlZlNlbGVjdGVkOiByLnNlbGVjdGVkID09PSB0cnVlLFxuICAgICAgICAgICAgaGFzaCxcbiAgICAgICAgICB9O1xuICAgICAgICB9KSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBkZWxldGUgKHN0YXRlIGFzIHsgcmVmcz86IHVua25vd24gfSkucmVmcztcblxuICAgIC8vIGNvbnRleHQtbGlicmFyeSBtaWdyYXRpb246IGxlZ2FjeSBzdHlsZXNbXS9wcm9tcHRzW10g4oaSIHVuaWZpZWQgbGlicmFyeSArIHNldHMuXG4gICAgdHlwZSBMZWdhY3lTdHlsZSA9IHtcbiAgICAgIG5hbWU6IHN0cmluZztcbiAgICAgIGFjdGl2ZT86IGJvb2xlYW47XG4gICAgICBjYXB0dXJlZD86IGJvb2xlYW47XG4gICAgICBkZXNjcmlwdGlvbj86IHN0cmluZztcbiAgICAgIGltYWdlPzogc3RyaW5nO1xuICAgICAgaW1hZ2VQYXRoPzogc3RyaW5nO1xuICAgIH07XG4gICAgdHlwZSBMZWdhY3lQcm9tcHQgPSB7IGlkOiBzdHJpbmc7IGxhYmVsOiBzdHJpbmc7IHRleHQ6IHN0cmluZyB9O1xuICAgIGNvbnN0IGlzTGVnYWN5Q29udGV4dCA9XG4gICAgICBBcnJheS5pc0FycmF5KChzdGF0ZSBhcyB7IHN0eWxlcz86IHVua25vd24gfSkuc3R5bGVzKSB8fFxuICAgICAgQXJyYXkuaXNBcnJheSgoc3RhdGUgYXMgeyBwcm9tcHRzPzogdW5rbm93biB9KS5wcm9tcHRzKTtcbiAgICBpZiAoaXNMZWdhY3lDb250ZXh0KSB7XG4gICAgICBzdGF0ZS5saWJyYXJ5ID0gW107XG4gICAgICBzdGF0ZS5hY3RpdmVDb250ZXh0SWRzID0gW107XG4gICAgICBzdGF0ZS5xdWlja1Byb21wdElkcyA9IFtdO1xuICAgIH0gZWxzZSB7XG4gICAgICBzdGF0ZS5saWJyYXJ5ID8/PSBbXTtcbiAgICAgIHN0YXRlLmFjdGl2ZUNvbnRleHRJZHMgPz89IFtdO1xuICAgICAgc3RhdGUucXVpY2tQcm9tcHRJZHMgPz89IFtdO1xuICAgIH1cbiAgICBjb25zdCBsZWdhY3lTdHlsZXMgPSAoc3RhdGUgYXMgeyBzdHlsZXM/OiBMZWdhY3lTdHlsZVtdIH0pLnN0eWxlcztcbiAgICBpZiAoQXJyYXkuaXNBcnJheShsZWdhY3lTdHlsZXMpKSB7XG4gICAgICBmb3IgKGNvbnN0IHN0IG9mIGxlZ2FjeVN0eWxlcykge1xuICAgICAgICBjb25zdCBuYW1lID0gbm9ybVN0eWxlKHN0Lm5hbWUpO1xuICAgICAgICBjb25zdCBpZCA9IHN0eWxlSWQobmFtZSk7XG4gICAgICAgIHN0YXRlLmxpYnJhcnkucHVzaCh7XG4gICAgICAgICAgaWQsXG4gICAgICAgICAga2luZDogXCJzdHlsZVwiLFxuICAgICAgICAgIG5hbWUsXG4gICAgICAgICAgY29udGVudDogc3QuZGVzY3JpcHRpb24gPz8gXCJcIixcbiAgICAgICAgICBpbWFnZTogc3QuaW1hZ2UsXG4gICAgICAgICAgaW1hZ2VQYXRoOiBzdC5pbWFnZVBhdGgsXG4gICAgICAgICAgY2FwdHVyZWQ6IHN0LmNhcHR1cmVkLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKHN0LmFjdGl2ZSkgc3RhdGUuYWN0aXZlQ29udGV4dElkcy5wdXNoKGlkKTtcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgbGVnYWN5UHJvbXB0cyA9IChzdGF0ZSBhcyB7IHByb21wdHM/OiBMZWdhY3lQcm9tcHRbXSB9KS5wcm9tcHRzO1xuICAgIGlmIChBcnJheS5pc0FycmF5KGxlZ2FjeVByb21wdHMpKSB7XG4gICAgICBmb3IgKGNvbnN0IHAgb2YgbGVnYWN5UHJvbXB0cykge1xuICAgICAgICBzdGF0ZS5saWJyYXJ5LnB1c2goe1xuICAgICAgICAgIGlkOiBwLmlkLFxuICAgICAgICAgIGtpbmQ6IFwicHJvbXB0XCIsXG4gICAgICAgICAgbmFtZTogcC5sYWJlbCxcbiAgICAgICAgICBjb250ZW50OiBwLnRleHQsXG4gICAgICAgIH0pO1xuICAgICAgICBzdGF0ZS5xdWlja1Byb21wdElkcy5wdXNoKHAuaWQpO1xuICAgICAgfVxuICAgIH1cbiAgICBkZWxldGUgKHN0YXRlIGFzIHsgc3R5bGVzPzogdW5rbm93biB9KS5zdHlsZXM7XG4gICAgZGVsZXRlIChzdGF0ZSBhcyB7IHByb21wdHM/OiB1bmtub3duIH0pLnByb21wdHM7XG5cbiAgICBmb3IgKGNvbnN0IGIgb2Ygc3RhdGUuYmF0Y2hlcykge1xuICAgICAgZm9yIChjb25zdCB2MiBvZiBiLnZhcmlhbnRzKSB7XG4gICAgICAgIGlmICh2Mi5zcmMpIHYyLnBhdGggPSBzYXZlRGF0YVVybChzZXNzaW9uRmlsZXNEaXIsIHYyLmlkLCB2Mi5zcmMpIHx8IHYyLnBhdGg7XG4gICAgICAgIGlmICh2Mi5hbmFseXNpcyA9PT0gdW5kZWZpbmVkKSB2Mi5hbmFseXNpcyA9IFwiXCI7IC8vIGJhY2tmaWxsIHByZS1hbmFseXNpcyBzbmFwc2hvdHNcbiAgICAgIH1cbiAgICB9XG4gICAgZm9yIChjb25zdCBlIG9mIHN0YXRlLmxpYnJhcnkpIHtcbiAgICAgIGlmIChlLmltYWdlKSBlLmltYWdlUGF0aCA9IHNhdmVEYXRhVXJsKHNlc3Npb25GaWxlc0RpciwgZS5pZCwgZS5pbWFnZSkgfHwgZS5pbWFnZVBhdGg7XG4gICAgfVxuICAgIC8vIE1pZ3JhdGUgcHJlLWR1cmFiaWxpdHkgc25hcHNob3RzOiBhIGxlZ2FjeSBnbG9iYWwgYG1hcmtzYCBhcnJheSDihpIgdGhlXG4gICAgLy8gZm9jdXNlZCB2YXJpYW50J3MgYnVja2V0LiBUaGVuIG5vcm1hbGl6ZSB6T3JkZXIgd2l0aGluIGVhY2ggYnVja2V0LlxuICAgIGNvbnN0IGxlZ2FjeSA9IChzdGF0ZSBhcyB7IG1hcmtzPzogTWFya1tdIH0pLm1hcmtzO1xuICAgIGlmIChBcnJheS5pc0FycmF5KGxlZ2FjeSkpIHtcbiAgICAgIGlmIChsZWdhY3kubGVuZ3RoICYmIHN0YXRlLmZvY3VzKSBzdGF0ZS5tYXJrc0J5VmFyaWFudFtzdGF0ZS5mb2N1cy52YXJpYW50SWRdID0gbGVnYWN5O1xuICAgICAgZGVsZXRlIChzdGF0ZSBhcyB7IG1hcmtzPzogTWFya1tdIH0pLm1hcmtzO1xuICAgIH1cbiAgICBzdGF0ZS5tYXJrc0J5VmFyaWFudCA/Pz0ge307XG4gICAgc3RhdGUubGF5ZXJzQnlWYXJpYW50ID8/PSB7fTtcbiAgICBmb3IgKGNvbnN0IHZpZCBvZiBPYmplY3Qua2V5cyhzdGF0ZS5tYXJrc0J5VmFyaWFudCkpIHtcbiAgICAgIGNvbnN0IG1hcmtzID0gc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXTtcbiAgICAgIC8vIEJhY2tmaWxsIHRoZSBjb250YWluZXIgbW9kZWw6IHdyYXAgcHJlLWxheWVyIG1hcmtzIGludG8gb25lIGRlZmF1bHRcbiAgICAgIC8vIFwiQW5ub3RhdGlvbnNcIiBsYXllciwgdGhlbiBzdGFtcCBsYXllcklkICsgbm9ybWFsaXplIHpPcmRlciBieSBwb3NpdGlvbi5cbiAgICAgIGxldCBsYXllcnMgPSBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXTtcbiAgICAgIGlmICghbGF5ZXJzPy5sZW5ndGggJiYgbWFya3MubGVuZ3RoKSB7XG4gICAgICAgIGxheWVycyA9IFt7IGlkOiBuZXdJZChcImxheWVyXCIpLCBuYW1lOiBcIkFubm90YXRpb25zXCIsIGtpbmQ6IFwiYW5ub3RhdGlvblwiIH1dO1xuICAgICAgICBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXSA9IGxheWVycztcbiAgICAgIH1cbiAgICAgIGNvbnN0IGRlZmF1bHRMYXllcklkID0gbGF5ZXJzPy5bbGF5ZXJzLmxlbmd0aCAtIDFdPy5pZDtcbiAgICAgIHN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF0gPSBtYXJrcy5tYXAoKG0sIGkpID0+ICh7XG4gICAgICAgIC4uLm0sXG4gICAgICAgIHpPcmRlcjogbS56T3JkZXIgPT09IHVuZGVmaW5lZCA/IGkgOiBtLnpPcmRlcixcbiAgICAgICAgbGF5ZXJJZDogbS5sYXllcklkID8/IGRlZmF1bHRMYXllcklkLFxuICAgICAgfSkpO1xuICAgIH1cbiAgICBzYXZlU25hcHNob3QoKTtcbiAgfVxuXG4gIGNvbnN0IHVybCA9IGBodHRwOi8vJHtob3N0fToke2JvdW5kUG9ydH1gO1xuICAvLyBgbW9kZWAgaXMgdGhlIE9OTFkgdGhpbmcgdGhhdCBkaXNjcmltaW5hdGVzIGEgcmVsZWFzZSBkYWVtb24gZnJvbSBhIGRldlxuICAvLyBvbmU6IHdpdGggcm9vdCBkZXBzIHByZXNlbnQgYSBkZXYgZGFlbW9uIHJlbmRlcnMgYW4gaWRlbnRpY2FsLWxvb2tpbmdcbiAgLy8gc3VyZmFjZSwgc28gXCJpdCBsb29rcyByaWdodFwiIGNhbm5vdCB2ZXJpZnkgQ29udHJhY3QgMS4gaW1hZ28gd3JpdGVzIE5PXG4gIC8vIHN0ZG91dCBoYW5kc2hha2UgKG1pbmQtbWFwcGVyIGFuZCBhc3Ryb2xhYmUgZG8pIOKAlCBpdHMgaGFuZHNoYWtlIGlzIHRoZVxuICAvLyBkaXNjb3ZlcnkgZmlsZSBiZWxvdywgc28gYG1vZGVgIHJpZGVzIEJPVEgsIHNhbWUgcm9sZSwgZGlmZmVyZW50IHRyYW5zcG9ydC5cbiAgZW1pdEV2ZW50KHsgdHlwZTogXCJyZWFkeVwiLCB1cmwsIHBvcnQ6IGJvdW5kUG9ydCwgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLCBtb2RlIH0pO1xuXG4gIC8vIERpc2NvdmVyeSBmaWxlcyDigJQgY2xpLnRzIHJlYWRzIHRoZSBwb3J0IGZyb20gaGVyZS5cbiAgY29uc3Qgc2Vzc2lvbkZpbGUgPSBqb2luKHRtcGRpcigpLCBgaW1hZ28tJHtzZXNzaW9uSWR9Lmpzb25gKTtcbiAgY29uc3QgbGF0ZXN0RmlsZSA9IGpvaW4odG1wZGlyKCksIGBpbWFnby1sYXRlc3QuanNvbmApO1xuICBjb25zdCBzZXNzaW9uSW5mbyA9IEpTT04uc3RyaW5naWZ5KHtcbiAgICB1cmwsXG4gICAgcG9ydDogYm91bmRQb3J0LFxuICAgIHNlc3Npb25faWQ6IHNlc3Npb25JZCxcbiAgICB0aXRsZTogc3RhdGUudGl0bGUsXG4gICAgZmlsZXNfZGlyOiBzZXNzaW9uRmlsZXNEaXIsXG4gICAgbW9kZSxcbiAgfSk7XG4gIC8vIOKaoCBBVE9NSUMsIGJlY2F1c2UgcmVhZFNlc3Npb24gdHJlYXRzIHVucGFyc2VhYmxlIGNvbnRlbnQgYXMgY29ycnVwdGlvblxuICAvLyByYXRoZXIgdGhhbiBhYnNlbmNlIOKAlCBhbmQgdGhpcyBpbXBsZW1lbnRhdGlvbiBpcyBub3dcbiAgLy8gYGtpdC93aXJlL2Rpc2NvdmVyeS50c2AsIHNoYXJlZCB3aXRoIHRoZSBzaW5nbGV0b24gY29udmVudGlvbiBEMyBrZXB0IGFsaXZlXG4gIC8vIGJlc2lkZSB0aGlzIG9uZS4gQSBiYXJlIGB3cml0ZUZpbGVTeW5jYCBpcyBub3QgYXRvbWljOiBhIENMSSByZWFkaW5nIHdoaWxlXG4gIC8vIHRoZSBkYWVtb24gd3JpdGVzIG9ic2VydmVzIGEgaGFsZi13cml0dGVuIHBvaW50ZXIsIHdoaWNoIHRoZSBvbGRcbiAgLy8gYmVzdC1lZmZvcnQgcmVhZCByZXBvcnRlZCBhcyBcIm5vIHJ1bm5pbmcgc2Vzc2lvblwiLiBDZW5zdXMgZGVmZWN0IEwzIOKAlFxuICAvLyBpbWFnbyB3YXMgYWxyZWFkeSBDT1JSRUNUIGhlcmUgKGl0IHdhcyBmaXhlZCAyMDI2LTA5LTA4IGZyb20gZ2xhbW91cidzXG4gIC8vIGZpbmQpLCBzbyB3aGF0IGFkb3B0aW9uIGJ1eXMgaXMgbm90IGEgZml4IGJ1dCB0aGUgcmVtb3ZhbCBvZiB0aGUgZm91cnRoXG4gIC8vIGNvcHk6IHRoZSB0ZW1wLW5hbWUtY2Fycmllcy10aGUtcGlkIGRldGFpbCBhbmQgdGhlIGZhaWxlZC13cml0ZSBjbGVhbnVwIGFyZVxuICAvLyBubyBsb25nZXIgZm91ciB0aGluZ3MgdGhhdCBtdXN0IHN0YXkgZXF1YWwuXG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlQXRvbWljKHNlc3Npb25GaWxlLCBzZXNzaW9uSW5mbyk7XG4gICAgd3JpdGVGaWxlQXRvbWljKGxhdGVzdEZpbGUsIHNlc3Npb25JbmZvKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYGltYWdvOiBjb3VsZCBub3Qgd3JpdGUgZGlzY292ZXJ5IGZpbGU6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmAsXG4gICAgKTtcbiAgfVxuICAvLyBUaGUgc2Vzc2lvbiBwb2ludGVyIGlzIHVuY29uZGl0aW9uYWxseSBvdXJzOyBgaW1hZ28tbGF0ZXN0Lmpzb25gIGlzIE5PVCDigJQgYVxuICAvLyBuZXdlciBzZXNzaW9uIG1heSBhbHJlYWR5IGhhdmUgY2xhaW1lZCBpdCwgYW5kIHVubGlua2luZyB0aGF0IHdvdWxkIG1ha2UgdGhlXG4gIC8vIGxpdmUgZGFlbW9uIGludmlzaWJsZSB0byB0aGUgbmV4dCB2ZXJiLCBzbyB0aGUgbmV4dCBDTEkgdmVyYiBzcGF3bnMgYSB0aGlyZC5cbiAgLy8gYHVubGlua0lmTWF0Y2hlc2AncyBgaWRlbnRpZnlgIGhvb2sgaXMgd2hhdCBsZXRzIE9ORSBzaGFyZWQgcHJlZGljYXRlIHNlcnZlXG4gIC8vIGJvdGggdGhpcyBKU09OIHBvaW50ZXIgYW5kIGFzdHJvbGFiZSdzIGJhcmUgcGlkIGZpbGUuXG4gIC8vXG4gIC8vIOKaoCBJVCBBTFNPIFNUT1BQRUQgQkVJTkcgQVNZTkMsIHdoaWNoIGlzIGEgcmVhbCBzaW1wbGlmaWNhdGlvbiBhbmQgbm90IGFcbiAgLy8gc3R5bGUgZWRpdDogdGhlIG9sZCB2ZXJzaW9uIHJlYWQgYGxhdGVzdEZpbGVgIHRocm91Z2ggYGF3YWl0IEJ1bi5maWxlKCkudGV4dCgpYFxuICAvLyBwdXJlbHkgdG8gY29tcGFyZSBvbmUgZmllbGQsIHdoaWNoIG1hZGUgdGhlIHdob2xlIHRlYXJkb3duIHBhdGggYXN5bmMgZm9yIGFcbiAgLy8gc3luY2hyb25vdXMgZGVjaXNpb24uXG4gIGNvbnN0IGNsZWFudXBEaXNjb3ZlcnkgPSAoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMoc2Vzc2lvbkZpbGUpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogZ29uZSDigJQgZmluZSAqL1xuICAgIH1cbiAgICB1bmxpbmtJZk1hdGNoZXMobGF0ZXN0RmlsZSwgc2Vzc2lvbklkLCAocmF3KSA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBpZCA9IChKU09OLnBhcnNlKHJhdykgYXMgeyBzZXNzaW9uX2lkPzogdW5rbm93biB9KS5zZXNzaW9uX2lkO1xuICAgICAgICByZXR1cm4gdHlwZW9mIGlkID09PSBcInN0cmluZ1wiID8gaWQgOiBudWxsO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHRyeSB7XG4gICAgICBpZiAoc2Vzc2lvbkZpbGVzRGlyKSBybVN5bmMoc2Vzc2lvbkZpbGVzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBhbHJlYWR5IGdvbmUgKi9cbiAgICB9XG4gIH07XG5cbiAgaWYgKCF2W1wibm8tb3BlblwiXSkgb3BlbkJyb3dzZXIodXJsKTtcblxuICAvLyBUaGUgdHdvIHN0YW5kaW5nIHRpbWVycyDigJQgdGhlIGlkbGUgc3dlZXAgYW5kIHRoZSBkZWJvdW5jZWQgc25hcHNob3Qg4oCUIGFyZVxuICAvLyBPTkUgY2FsbCwgYmVjYXVzZSB0aGV5IGhhdmUgYWx3YXlzIGJlZW4gb25lIGxpZmV0aW1lOiBldmVyeSBjb3B5IGNsZWFyZWRcbiAgLy8gYm90aCBpbiB0aGUgc2FtZSB0d28gbGluZXMgYWZ0ZXIgYGF3YWl0IGRvbmVgLCBhbmQgdGhlIHBhaXIgdGhhdCBnZXRzXG4gIC8vIGZvcmdvdHRlbiBpcyB0aGUgcGFpciB3aG9zZSB0aW1lcnMga2VlcCBhIHByb2Nlc3MgYWxpdmUgYWZ0ZXIgdGVhcmRvd24uXG4gIC8vXG4gIC8vIOKblCBUSEUgU1dFRVAgTk9XIFNFRVMgSVRTIFNVQlNDUklCRVJTIOKAlCBDRU5TVVMgREVGRUNUIEwxLCBjbG9zZWQgYnkgdGhlXG4gIC8vIHNoYXJlZCBob3VzZWtlZXBlciBSRVFVSVJJTkcgYSBgc3Vic2NyaWJlckNvdW50YCByYXRoZXIgdGhhbiBieSBhbnlvbmVcbiAgLy8gcmVtZW1iZXJpbmcgdG8gcGFzcyBvbmUuIGltYWdvJ3MgZXhwcmVzc2lvbiByZWFkXG4gIC8vIGAobm93IC0gbGFzdEFjdGl2aXR5KSAvIDEwMDAgPj0gdGltZW91dGAgYW5kIG5vdGhpbmcgZWxzZSwgc28gYW4gYWdlbnRcbiAgLy8gaG9sZGluZyBhIGAvZXZlbnRzYCB0YWlsIG9uIGEgcXVpZXQgYm9hcmQgd2FzIGtpbGxlZCBXSVRIIElUUyBDT05ORUNUSU9OXG4gIC8vIE9QRU4gYXQgdGhlIDMwLW1pbnV0ZSBkZWZhdWx0LiBgdGltZW91dGAgbm93IG1lYW5zIFwibGluZ2VyIHRoaXMgbG9uZyBhZnRlclxuICAvLyB0aGUgTEFTVCBzdWJzY3JpYmVyIGxlYXZlc1wiLCBub3QgXCJtYXhpbXVtIGlkbGUgd2hpbGUgY29ubmVjdGVkXCIg4oCUIGFcbiAgLy8gZGVsaWJlcmF0ZSBjaGFuZ2Ugb2YgbWVhbmluZywgYW5kIHRoZSBvbmUgdGhlIGNlbnN1cyBhc2tlZCBmb3IuXG4gIGNvbnN0IHN0b3BIb3VzZWtlZXBpbmcgPSBzdGFydEhvdXNla2VlcGluZyh7XG4gICAgc3Vic2NyaWJlckNvdW50OiAoKSA9PiBzb2NrZXRzLnNpemUgKyBzc2VDbGllbnRzLnNpemUsXG4gICAgaWRsZU1zOiAoKSA9PiBwZXJmb3JtYW5jZS5ub3coKSAtIGxhc3RBY3Rpdml0eSxcbiAgICB0b3VjaCxcbiAgICB0aW1lb3V0TXM6IHRpbWVvdXQgKiAxMDAwLFxuICAgIG9uSWRsZUNsb3NlOiAoKSA9PiByZXNvbHZlRG9uZSh7IGNvZGU6IDEyNCwgcmVhc29uOiBcInRpbWVvdXRcIiB9KSxcbiAgICBzbmFwc2hvdDoge1xuICAgICAgZGlydHk6ICgpID0+IHNuYXBEaXJ0eSxcbiAgICAgIGNsZWFyOiAoKSA9PiB7XG4gICAgICAgIHNuYXBEaXJ0eSA9IGZhbHNlO1xuICAgICAgfSxcbiAgICAgIC8vIERlYm91bmNlZCBwZXJzaXN0ZW5jZSwgc28gYSByZXN0YXJ0IChgY2xpLnRzIG9wZW4gLS1yZXN0b3JlIDxpZD5gKVxuICAgICAgLy8gcmVzdW1lcyBleGFjdGx5IHdoZXJlIHdlIGxlZnQgb2ZmLlxuICAgICAgd3JpdGU6IHNhdmVTbmFwc2hvdCxcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCB7IGNvZGUsIHJlYXNvbiB9ID0gYXdhaXQgZG9uZTtcbiAgc3RvcEhvdXNla2VlcGluZygpO1xuICBzYXZlU25hcHNob3QoKTsgLy8gZmluYWwgd3JpdGUg4oCUIGtlZXAgaXQgKHRoZSByZXN1bWUgcG9pbnQsIE5PVCBkZWxldGVkIG9uIGNsb3NlKVxuICBlbWl0RXZlbnQoeyB0eXBlOiBcImNsb3NlZFwiLCByZWFzb24gfSk7XG4gIGJyb2FkY2FzdCh7IHR5cGU6IFwibWVzc2FnZVwiLCB0ZXh0OiBgc2Vzc2lvbiBlbmRlZDogJHtyZWFzb259YCB9KTtcbiAgLy8g4puUIFRIRSBHUkFDRSBQRVJJT0QgSVMgTk9UIFBPTElURU5FU1M6IGEgYGNsb3NlZGAgZnJhbWUgZm9sbG93ZWQgaW1tZWRpYXRlbHlcbiAgLy8gYnkgYW4gYWdncmVzc2l2ZSBgc2VydmVyLnN0b3AodHJ1ZSlgIGlzIGEgZnJhbWUgdGhlIGNsaWVudCBuZXZlciBzZWVzLCBhbmRcbiAgLy8gdGhlIENMSSdzIHRhaWwgd2F0Y2hlcyBmb3IgZXhhY3RseSB0aGF0IGZyYW1lIHRvIGVuZCB0aGUgd2F0Y2guIEFORCBUSEUgU1RPUFxuICAvLyBJUyBSQUNFRCwgYmVjYXVzZSBgc3RvcCh0cnVlKWAgYXdhaXRzIGl0cyBjb25uZWN0aW9ucyBhbmQgb25lIHdlZGdlZCBwZWVyIGlzXG4gIC8vIGVub3VnaCB0byBwYXJrIHRlYXJkb3duIGZvcmV2ZXIuIEJvdGggYXJlIG5vdyBga2l0L3dpcmUvaG91c2VrZWVwaW5nLnRzYC5cbiAgLy9cbiAgLy8g4pqgIEFORCBUSEUgU0VDT05EIFJFR0lTVFJZIElTIEdPTkUuIFRoaXMgc3dlcHQgYHNzZVRpbWVyc2AgYW5kIGBzc2VDbGllbnRzYFxuICAvLyBzZXBhcmF0ZWx5OyB0aGUgcGVyLXN0cmVhbSBoZWFydGJlYXQgbm93IGxpdmVzIGluc2lkZSB0aGUgc3RyZWFtJ3Mgb3duXG4gIC8vIHRlYXJkb3duIGZ1bm5lbCwgc28gdGhlcmUgaXMgbm90aGluZyBsZWZ0IHRvIGZhbGwgb3V0IG9mIHN0ZXAgd2l0aC5cbiAgYXdhaXQgZHJhaW5BbmRTdG9wKHsgc2VydmVyLCBjbGllbnRzOiBzc2VDbGllbnRzLCBzb2NrZXRzIH0pO1xuICBjbGVhbnVwRGlzY292ZXJ5KCk7XG4gIHJldHVybiBjb2RlO1xufVxuXG4vKipcbiAqIFRoZSBkYWVtb24ncyBPTkUgZW50cnksIGFuZCBpdCBpcyB0aGUgTEFVTkNIRVIncyB0byBjYWxsIChEMTIsIHBsYXlib29rIEIzKS5cbiAqXG4gKiDim5QgTk8gYGltcG9ydC5tZXRhLm1haW5gIEJMT0NLLCBGT1IgVFdPIFJFQVNPTlMgQU5EIEVJVEhFUiBPTkUgSVMgRkFUQUwuXG4gKiBGaXJzdCwgYGRpc3Qvc2VydmVyLmpzYCBpcyBJTVBPUlRFRCBieSBgPHNraWxsPi9zY3JpcHRzL3NlcnZlci50c2AsIHNvXG4gKiBgaW1wb3J0Lm1ldGEubWFpbmAgaXMgRkFMU0UgYW5kIHRoZSBibG9jayB3b3VsZCBuZXZlciBydW46IHRoZSBkYWVtb24gd291bGRcbiAqIGJvb3QsIGJpbmQgbm90aGluZywgZXhpdCAwLCBhbmQgZXZlcnkgaW50ZWdyYXRpb24gdGVzdCB3b3VsZCBmYWlsIGFzIFwibmV2ZXJcbiAqIGFuc3dlcmVkXCIsIHdoaWNoIHJlYWRzIGxpa2UgZmxha2UuIFNlY29uZCDigJQgYW5kIHRoaXMgaXMgd2h5IHRoZSBkYWVtb24ga2VlcHNcbiAqIG5vIFNFQ09ORCBlbnRyeSBldmVuIGZvciBjb252ZW5pZW5jZSDigJQgYFNLSUxMX1JPT1RgIGlzIGBpbXBvcnQubWV0YS5kaXIvLi5gLFxuICogd2hpY2ggaXMgdGhlIHNraWxsIHJvb3QgT05MWSBmcm9tIGBkaXN0L2AuIFJ1biBmcm9tIGBzcmMvaW1hZ28vYmFja2VuZC9gIGl0XG4gKiBjb21wdXRlcyBgc3JjL2ltYWdvL2AsIGZpbmRzIG5vIGBkaXN0L2luZGV4Lmh0bWxgLCBzaWxlbnRseSBjaG9vc2VzIERFViwgYW5kXG4gKiB0aGVuIGZhaWxzIHRoZSBkZXYgaW1wb3J0IGZyb20gdGhlIHdyb25nIGFuY2hvci4gT2ZmZXJpbmcgdGhhdCBlbnRyeSB3b3VsZCBiZVxuICogb2ZmZXJpbmcgYSB3cm9uZyBkYWVtb24uXG4gKlxuICog4pqgIFRIRSBURVJNSU5BTCBgcHJvY2Vzcy5leGl0KGV4aXRDb2RlKWAgTU9WRUQgVE8gVEhFIExBVU5DSEVSIFZFUkJBVElNIGFuZFxuICogbXVzdCBzdGF5IHRoZXJlOiBpdCBpcyBmYW1pbHkgRS10ZXJtaW5hbCBpbiBgZ3JpbW9pcmUvZXhpdC1zaXRlLWludmVudG9yeWAsXG4gKiBwaW5uZWQgYXQgYDxza2lsbD4vc2NyaXB0cy9zZXJ2ZXIudHNgLiBBIGRhZW1vbiBpcyBub3QgYSBDTEkg4oCUIGl0cyB0ZWFyZG93blxuICogaGFzIGFscmVhZHkgcnVuIGluc2lkZSBgbWFpbmAsIHdoaWNoIGF3YWl0cyBpdHMgb3duIGRyYWluIOKAlCBzbyB0aGUgQ0xJJ3NcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYC1hbmQtcmV0dXJuIHJ1bGUgZG9lcyBOT1QgYXBwbHkgaGVyZSwgYW5kIHRoZSB0d28gbGF1bmNoZXJzXG4gKiBkaWZmZXJpbmcgb24gdGhpcyBvbmUgbGluZSBpcyBkZWxpYmVyYXRlLiBEbyBub3QgdGlkeSB0aGVtIGludG8gYSBtYXRjaC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG5leHBvcnQgdHlwZSB7XG4gIEJhdGNoLFxuICBJbWFnb1N0YXRlLFxuICBWYXJpYW50LFxufSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2ltYWdvL3NoYXJlZC90eXBlc1wiO1xuZXhwb3J0IHsgZGVmYXVsdFN0YXRlIH0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9pbWFnby9zaGFyZWQvdHlwZXNcIjtcbmV4cG9ydCB7IG1haW4sIHBhcnNlUG9ydEZyb21TZXNzaW9uSWQgfTtcbiIsCiAgICAiLy8gc2hhcmVkL3R5cGVzLnRzXG4vLyBUaGUgc2luZ2xlIHNoYXJlZCBjb250cmFjdCwgYW5kIHRoZSByZWFzb24gc2hhcmVkLyBleGlzdHM6IGl0IGlzIGEgUEVFUiBvZlxuLy8gYm90aCBzaWRlcywgbm90IGJhY2tlbmQtb3duZWQgKFIxKS4gSW1wb3J0ZWQgYnkgc2NyaXB0cy9zZXJ2ZXIudHMgQU5EIHRoZVxuLy8gUmVhY3QgY2xpZW50LiBJdCBtdXN0IGxpdmUgaW4gdGhlIFNISVBQRUQgdHJlZSDigJQgdGhlIGRhZW1vbiBydW5zIGZyb20gc291cmNlXG4vLyBhdCBhIGRlc3RpbmF0aW9uIHRoYXQgbmV2ZXIgcmFuIGBpbnN0YWxsYCwgc28gYW55dGhpbmcgaXQgaW1wb3J0cyBoYXMgdG8gYmVcbi8vIHBoeXNpY2FsbHkgaGVyZS5cbi8vXG4vLyBpbWFnbyBpcyBhIEdST1VOREVEIENPTlZFUlNBVElPTiBhYm91dCBhbiBpbWFnZTogdGhlIHVzZXIgYW5kIHRoZSBhZ2VudCB0YWxrXG4vLyAodGhlIGBjb252ZXJzYXRpb25gKSwgdGhlIHN1cmZhY2UgaG9sZHMgdGhlIGFydGlmYWN0cyB0aGV5J3JlIHRhbGtpbmcgYWJvdXRcbi8vIChgYmF0Y2hlc2Agb2Yga2VwdCBnZW5lcmF0aW9ucywgdGhlIGBmb2N1c2BlZCBvbmUgb24gdGhlIGNhbnZhcyksIGFuZCBzdXJmYWNlXG4vLyBnZXN0dXJlcyAobGlraW5nLCBtYXJraW5nLCBhdHRhY2hpbmcgYSByZWYpIGFyZSB0aGVtc2VsdmVzIG1lc3NhZ2VzIHRoZSBhZ2VudFxuLy8gaGVhcnMuIFRoZXJlIGlzIG5vIFwicGhhc2VcIiBwaXBlbGluZSDigJQgaXQncyBhIGxvb3AsIG5vdCBhIGZ1bm5lbC5cblxuLy8g4pSA4pSAIHRoZSBhcnRpZmFjdHMgKHBpZWNlcyBvbiB0aGUgYm9hcmQpIOKUgOKUgFxuXG4vLyBBIFZhcmlhbnQgaXMgVEhFIHVuaXZlcnNhbCBpbWFnZSBhc3NldCDigJQgZ2VuZXJhdGVkLCBpbXBvcnRlZCwgb3IgYnJvdWdodCBpbiBhc1xuLy8gYSByZWZlcmVuY2UuIFwiQmVpbmcgYSByZWZlcmVuY2VcIiBpcyBhIGZsYWcgKGByZWZTZWxlY3RlZGApLCBub3QgYSBzZXBhcmF0ZSB0eXBlOlxuLy8gYW55IHZhcmlhbnQgY2FuIGJlIGZvY3VzZWQsIGFubm90YXRlZCwgQU5EIHBvaW50ZWQgYXQgZm9yIHRoZSBuZXh0IGdlbmVyYXRpb24uXG5leHBvcnQgdHlwZSBWYXJpYW50ID0ge1xuICBpZDogc3RyaW5nO1xuICBzcmM6IHN0cmluZzsgLy8gYmFzZTY0IHdlYnA7IHN0cmlwcGVkIGluIGxlYW4gcHJvamVjdGlvbiAoYWdlbnQgcmVhZHMgYHBhdGhgKVxuICBwYXRoOiBzdHJpbmc7IC8vIG9uLWRpc2sgbWF0ZXJpYWxpemVkIGZpbGUgZm9yIHRoZSBhZ2VudCB0byBSZWFkXG4gIHNlZWQ/OiBudW1iZXI7XG4gIG1vZGVsPzogc3RyaW5nO1xuICBsaWtlZDogYm9vbGVhbjtcbiAgYW5hbHlzaXM6IHN0cmluZzsgLy8gdGhlIGFnZW50J3MgcmVhZCBvZiBUSElTIGltYWdlIOKAlCBkdXJhYmxlLCB1cGRhdGFibGUgbWV0YWRhdGFcbiAgLy8gKGRpc3RpbmN0IGZyb20gdGhlIEJhdGNoIHByb21wdCwgd2hpY2ggaXMgZml4ZWQgcHJvdmVuYW5jZSkuIFNob3duIGluIGRldGFpbHMuXG4gIC8vIE5vIHBlci12YXJpYW50IHByb21wdDogdGhlIHNldHRsZWQgcHJvbXB0IGxpdmVzIG9uIHRoZSBCYXRjaCAob25lIHByb21wdCxcbiAgLy8gbWFueSBzZWVkcykuIFRoZSBkaXNwbGF5IGxhYmVsIChcImFcIi9cImJcIi/igKYpIGlzIGRlcml2ZWQgZnJvbSBhcnJheSBpbmRleC5cbiAgbmFtZT86IHN0cmluZzsgLy8gZWRpdGFibGUgbGFiZWw7IGJsYW5rIGZvciBnZW5lcmF0ZWQgKHVzZSB0aGUgZGVyaXZlZCBsYWJlbCksIGZpbGVuYW1lIGZvciBpbXBvcnRzXG4gIHJlZlNlbGVjdGVkPzogYm9vbGVhbjsgLy8gcG9pbnRlZCBhdCBhcyBhIHJlZmVyZW5jZSBmb3IgdGhlIG5leHQgZ2VuZXJhdGlvblxuICBoYXNoPzogc3RyaW5nOyAvLyBjb250ZW50IGhhc2ggKGltcG9ydHMgb25seSkg4oCUIGltcG9ydCBkZWR1cCArIGFuYWx5c2lzQ2FjaGUga2V5XG59O1xuXG4vLyBBIGJhdGNoIGlzIG9uZSByb3VuZCBvZiBnZW5lcmF0aW9uIGtlcHQgdG9nZXRoZXIgKGFsbCB2YXJpYW50cyBrZXB0IGJ5XG4vLyBkZWZhdWx0IOKAlCBubyBzZWxlY3Qtb25lLWRpc2NhcmQpLiBraW5kIGRpc3Rpbmd1aXNoZXMgYSBmcmVzaCBnZW5lcmF0ZSBmcm9tIGFuXG4vLyBlZGl0IG9mIGFuIGV4aXN0aW5nIHZhcmlhbnQuIFRoZSBCYXRjaC5wcm9tcHQgaXMgVEhFIHNldHRsZWQgcHJvbXB0IHNhdmVkXG4vLyB3aXRoIHRoZXNlIGltYWdlcyAodGhlIGJyaWVmJ3MgXCJwcm9tcHQgc2F2ZWQgd2l0aCB0aGUgaW1hZ2VcIikuIERpc3BsYXkgb3JkZXIgL1xuLy8gXCJCYXRjaCBOXCIgbGFiZWwgaXMgZGVyaXZlZCBmcm9tIGFycmF5IGluZGV4LlxuZXhwb3J0IHR5cGUgQmF0Y2ggPSB7XG4gIGlkOiBzdHJpbmc7XG4gIGtpbmQ6IFwiZ2VuZXJhdGVcIiB8IFwiZWRpdFwiIHwgXCJpbXBvcnRcIjsgLy8gaW1wb3J0ID0gYSB3b3JraW5nIGltYWdlIHRoZSB1c2VyIGJyb3VnaHQgaW5cbiAgcHJvbXB0OiBzdHJpbmc7IC8vIHRoZSBzZXR0bGVkIHByb21wdCBmb3IgdGhpcyBiYXRjaCAoXCJcIiBmb3IgaW1wb3J0cylcbiAgdGFnPzogc3RyaW5nOyAvLyBzaG9ydCBodW1hbiBzdW1tYXJ5IChcImEgZm94IHJlYWRpbmcgdW5kZXIgYW4gb2FrXCIpXG4gIGVkaXRlZEZyb21WYXJpYW50SWQ/OiBzdHJpbmc7IC8vIHNldCB3aGVuIGtpbmQgPT09IFwiZWRpdFwiXG4gIHZhcmlhbnRzOiBWYXJpYW50W107XG59O1xuXG5leHBvcnQgdHlwZSBGb2N1cyA9IHsgYmF0Y2hJZDogc3RyaW5nOyB2YXJpYW50SWQ6IHN0cmluZyB9O1xuXG4vLyDilIDilIAgdGhlIGNvbnZlcnNhdGlvbiAodGhlIHNwaW5lKSDilIDilIBcblxuLy8gRXZlcnkgdHVybiBhdCB0aGUgdGFibGUgaXMgYSBNZXNzYWdlLiBNb3N0IGFyZSBwbGFpbiBgdGV4dGA7IGEgZmV3IGNhcnJ5XG4vLyBzdHJ1Y3R1cmVkIHBpZWNlcyB0aGUgc3VyZmFjZSByZW5kZXJzIHNwZWNpYWxseS5cbmV4cG9ydCB0eXBlIE1lc3NhZ2VLaW5kID1cbiAgfCBcInRleHRcIiAvLyBwbGFpbiBkaWFsb2d1ZSAoZWl0aGVyIHJvbGUpXG4gIHwgXCJwcm9tcHRcIiAvLyBhZ2VudCBwcm9wb3NlcyBhIHByb21wdCB0byBzZW5kIChhIHBpZWNlIG9uIHRoZSBib2FyZClcbiAgfCBcInJlc3VsdFwiIC8vIGFnZW50IHJlcG9ydHMgYSBwcm9kdWNlZCBiYXRjaCAobGlua3MgYGJhdGNoSWRgKVxuICB8IFwiZ2VzdHVyZVwiIC8vIGEgc3VyZmFjZSBhY3Rpb24gc3VyZmFjZWQgYXMgYSBtZXNzYWdlICh1c2VyIGxpa2VkL21hcmtlZC/igKYpXG4gIHwgXCJxdWVzdGlvblwiOyAvLyBhZ2VudCBuZWVkcyB0aGUgdXNlciAoYW4gdW5hbnN3ZXJlZCBvbmUg4oaSIFwiYXNraW5nXCIgcHJlc2VuY2UpXG5cbmV4cG9ydCB0eXBlIE1lc3NhZ2UgPSB7XG4gIGlkOiBzdHJpbmc7XG4gIHJvbGU6IFwidXNlclwiIHwgXCJhZ2VudFwiO1xuICBraW5kOiBNZXNzYWdlS2luZDtcbiAgdGV4dDogc3RyaW5nO1xuICB0czogbnVtYmVyO1xuICAvLyBraW5kOiBcInByb21wdFwiIOKAlCB0aGUgcHJvcG9zYWwgdGhlIHVzZXIgY29uZmlybXMgKFNlbmQpIG9yIGRpc21pc3Nlcy4gVGhlXG4gIC8vIHNlcnZlciBmbGlwcyBgc3RhdHVzYCBvbiBwcm9wb3NhbC5zZW5kIC8gcHJvcG9zYWwuZGlzbWlzcyAobm8gYWdlbnQgY29tbWFuZFxuICAvLyBuZWVkZWQg4oCUIGl0IG93bnMgdGhlIGNvbnZlcnNhdGlvbiBhcnJheSkuXG4gIHByb3Bvc2FsPzoge1xuICAgIHByb21wdDogc3RyaW5nO1xuICAgIG46IG51bWJlcjtcbiAgICBzdGF0dXM6IFwicGVuZGluZ1wiIHwgXCJzZW50XCIgfCBcImRpc21pc3NlZFwiO1xuICB9O1xuICAvLyBraW5kOiBcInJlc3VsdFwiIOKAlCB0aGUgYmF0Y2ggdGhpcyBtZXNzYWdlIGFubm91bmNlZFxuICBiYXRjaElkPzogc3RyaW5nO1xuICAvLyBraW5kOiBcImdlc3R1cmVcIiDigJQgd2hhdCB0aGUgdXNlciBkaWQsIGFuZCB0byB3aGF0XG4gIGdlc3R1cmU/OiB7XG4gICAga2luZDogXCJsaWtlZFwiIHwgXCJtYXJrZWRcIiB8IFwicmVmLWFkZGVkXCIgfCBcImZvY3VzXCIgfCBcImltcG9ydGVkXCI7XG4gICAgdGFyZ2V0SWQ/OiBzdHJpbmc7XG4gIH07XG4gIC8vIGtpbmQ6IFwicXVlc3Rpb25cIiDigJQgb3B0aW9uYWwgcXVpY2sgcmVwbGllcyAodGhlIGZ1bGwgYW5zd2VyIGNhbiBiZSBmcmVlIHRleHQpXG4gIG9wdGlvbnM/OiBzdHJpbmdbXTtcbn07XG5cbi8vIOKUgOKUgCBzdGVlcmluZyBwaWVjZXMgKGdyb3VuZGVkIHNob3J0Y3V0cykg4pSA4pSAXG5cbi8vIEEgcmV1c2FibGUgc3R5bGU6IGNsaWNraW5nIHRlbGxzIHRoZSBhZ2VudCB0byBhcHBseSBpdHMgdGVjaG5pcXVlIGZvciB0aGF0XG4vLyBsb29rLiBgY2FwdHVyZWRgIG1hcmtzIG9uZXMgZXh0cmFjdGVkIGZyb20gYW4gaW1hZ2UgKHRoZSBjYXRhbG9nIGxvb3AtY2xvc2VyKS5cbi8vIGBuYW1lYCBpcyB0aGUga2V5IOKAlCBub3JtYWxpemVkICh0cmltbWVkLCBsb3dlcmNhc2VkKSBvbiB3cml0ZSBzbyBjYXNpbmcgL1xuLy8gd2hpdGVzcGFjZSBjYW4ndCBjcmVhdGUgZHVwbGljYXRlcy5cbi8vIEEgdW5pZmllZCwgcmV1c2FibGUgcGllY2Ugb2YgdGV4dHVhbCBhZ2VudC1jb250ZXh0LiBga2luZGAgZHJpdmVzIGJlaGF2aW9yICtcbi8vIGRlZmF1bHQgZmlsdGVyIChhIHN0eWxlIG1hdGVyaWFsaXplcyBhbiBpbWFnZSArIGFjdHMgYXMgYW1iaWVudCBjb250ZXh0OyBhXG4vLyBwcm9tcHQgZmlsbHMgdGhlIGNvbXBvc2VyKSBidXQgaXMgTk9UIGEgaGFyZCByb3V0ZXIg4oCUIG1lbWJlcnNoaXAgaW4gYSBsaW5rZWRcbi8vIHNldCAoc2VlIEltYWdvU3RhdGUuYWN0aXZlQ29udGV4dElkcyAvIHF1aWNrUHJvbXB0SWRzKSBpcyB3aGF0IHN1cmZhY2VzIGl0LlxuLy8gYHRhZ3NgIGNhcnJ5IGNyb3NzLWtpbmQgZmluZGFiaWxpdHkuIE5vIGBhcmNoaXZlZGA6IHJlbW92YWwgZnJvbSBhIHNpdGUgaXMgYW5cbi8vIHVubGluazsgdGhlIG9ubHkgZGVzdHJveSBpcyBjb250ZXh0LmRlbGV0ZSBvbiB0aGUgbGlicmFyeS5cbmV4cG9ydCB0eXBlIENvbnRleHRLaW5kID0gXCJwcm9tcHRcIiB8IFwic3R5bGVcIiB8IFwic2tpbGxcIiB8IFwiY29udGV4dFwiO1xuZXhwb3J0IHR5cGUgQ29udGV4dEVudHJ5ID0ge1xuICBpZDogc3RyaW5nO1xuICBraW5kOiBDb250ZXh0S2luZDtcbiAgbmFtZTogc3RyaW5nO1xuICBjb250ZW50OiBzdHJpbmc7XG4gIHRhZ3M/OiBzdHJpbmdbXTtcbiAgaW1hZ2U/OiBzdHJpbmc7IC8vIGJhc2U2NCBpZGVudGl0eSBpbWFnZSAoc3RyaXBwZWQgaW4gdGhlIGxlYW4gYWdlbnQgcHJvamVjdGlvbilcbiAgaW1hZ2VQYXRoPzogc3RyaW5nOyAvLyBvbi1kaXNrIG1hdGVyaWFsaXplZCBpbWFnZSB0aGUgYWdlbnQgY2FuIC0tcmVmXG4gIGNhcHR1cmVkPzogYm9vbGVhbjsgLy8gc3R5bGUtb25seTogZXh0cmFjdGVkIGZyb20gYW4gaW1hZ2Vcbn07XG4vLyBUaGUgbmFtZWQgbGlua2VkIHNldHMgb3ZlciBgbGlicmFyeWAgKHRoZSBjb25zdW1wdGlvbiBzaXRlcykuXG5leHBvcnQgdHlwZSBDb250ZXh0U2V0ID0gXCJhY3RpdmVcIiB8IFwicXVpY2tQcm9tcHRzXCI7XG5cbi8vIEEgdmFsdWUgdGhlIHVzZXIgcGlucyB0byBsb2NrIGZvciB0aGUgbmV4dCBnZW5lcmF0ZSAoYWdlbnQgcGlja3MgdGhlIHJlc3QpLlxuZXhwb3J0IHR5cGUgUGluID0geyBrZXk6IHN0cmluZzsgdmFsdWU6IHN0cmluZyB9O1xuXG4vLyAoUmVmZXJlbmNlcyBhcmUgbm8gbG9uZ2VyIGEgc2VwYXJhdGUgdHlwZSDigJQgdGhleSdyZSBWYXJpYW50cyB3aXRoIGByZWZTZWxlY3RlZGAuXG4vLyBcIlVzZSB0aGVzZSBmb3IgdGhpcyBnZW5lcmF0aW9uXCIgPSB0aGUgc2V0IG9mIHZhcmlhbnRzIHdoZXJlIHJlZlNlbGVjdGVkOyBhdFxuLy8gZ2VuZXJhdGUgdGltZSB0aGUgYWdlbnQgdXNlcyB0aGF0IHNldCwgb3IgYWxsIGlmIG5vbmUgYXJlIHNlbGVjdGVkLilcblxuLy8gQW4gYW5ub3RhdGlvbiBtYXJrIG9uIGEgdmFyaWFudC4gQ29vcmRzIGFyZSBmcmFjdGlvbnMgKDDigJMxKSBvZiB0aGUgaW1hZ2UgYm94LFxuLy8gc28gbWFya3MgdHJhbnNmb3JtIHdpdGggcGFuL3pvb207IHN0cm9rZSB3aWR0aCArIHRleHQgc2l6ZSBhcmUgYXV0aG9yZWQgYXRcbi8vIDEwMCUgem9vbSBhbmQgdGhlIHN1cmZhY2Ugc2NhbGVzIHRoZW0gd2l0aCB0aGUgem9vbSBzbyB0aGV5IHN0YXkgd2VsZGVkIHRvIHRoZVxuLy8gaW1hZ2UuIE1hcmtzIGFyZSBEVVJBQkxFIHBlciBpbWFnZSDigJQga2VwdCBpbiBgbWFya3NCeVZhcmlhbnRgIGtleWVkIGJ5IHZhcmlhbnRcbi8vIGlkLCBzbyBzd2l0Y2hpbmcgYXdheSBhbmQgYmFjayBwcmVzZXJ2ZXMgdGhlbTsgY2xlYXJlZCBleHBsaWNpdGx5IChtYXJrcy5jbGVhcilcbi8vIG9yIHdoZW4gY29tbWl0dGVkIHRvIHRoZSBjb252ZXJzYXRpb24uIFRvb2xzOiBwaW4gKGxhYmVsZWQgcG9pbnQpLCBhcnJvdyAoXCJtb3ZlXG4vLyB0aGlzIOKGkiB0aGVyZVwiKSwgbGluZSwgcmVjdCwgZWxsaXBzZS4gVGhlIG1hc2sgdG9vbCBkcm9wcyBvbnRvIHRoZSBzYW1lIHVuaW9uIGxhdGVyLlxuLy8gYHpPcmRlcmAgaXMgc2VydmVyLWFzc2lnbmVkIG9uIG1hcmsuYWRkIChoaWdoZXIgPSBvbiB0b3ApOyB0aGUgc3VyZmFjZSBvbWl0c1xuLy8gaXQuIFNlZSBkb2NzL3Byb2plY3RzL2ltYWdvL2Fubm90YXRpb24tYXJjaGl0ZWN0dXJlLm1kLlxuLy8gY29sb3IgPSBzdHJva2UvYWNjZW50IGNvbG9yIChhIHRoZW1lIHRva2VuIG5hbWUgb3IgQ1NTIGNvbG9yKTsgd2lkdGggPSBzdHJva2Vcbi8vIHdpZHRoIGluIHB4OyBmb250U2l6ZSA9IGxhYmVsIHRleHQgc2l6ZSBpbiBweCAocGlucyB1c2UgaXQ7IG90aGVyIG1hcmtzIGlnbm9yZVxuLy8gaXQpLiBBbGwgb3B0aW9uYWwg4oCUIHRoZSBzdXJmYWNlIHBpY2tzIHNlbnNpYmxlIGRlZmF1bHRzLlxuZXhwb3J0IHR5cGUgTWFya0Jhc2UgPSB7XG4gIGlkOiBzdHJpbmc7XG4gIHpPcmRlcj86IG51bWJlcjsgLy8gb3JkZXIgV0lUSElOIHRoZSBlbGVtZW50J3MgbGF5ZXIgKHNlcnZlci1hdXRob3JpdGF0aXZlKVxuICBsYXllcklkPzogc3RyaW5nOyAvLyB3aGljaCBMYXllciAoY29udGFpbmVyKSB0aGlzIGVsZW1lbnQgYmVsb25ncyB0bzsgYmFja2ZpbGxlZCBvbiBtaWdyYXRpb25cbiAgcm90YXRpb24/OiBudW1iZXI7IC8vIGRlZ3JlZXMgY2xvY2t3aXNlIGFib3V0IHRoZSBlbGVtZW50J3MgYmJveCBjZW50ZXI7IGltYWdlLWZpcnN0IChhYnNlbnQgPSAwID0gdG9kYXkpXG4gIGxhYmVsPzogc3RyaW5nO1xuICBjb2xvcj86IHN0cmluZztcbiAgd2lkdGg/OiBudW1iZXI7XG4gIGZvbnRTaXplPzogbnVtYmVyO1xufTtcbmV4cG9ydCB0eXBlIE1hcmsgPVxuICB8IChNYXJrQmFzZSAmIHsgdG9vbDogXCJwaW5cIjsgeDogbnVtYmVyOyB5OiBudW1iZXIgfSlcbiAgfCAoTWFya0Jhc2UgJiB7XG4gICAgICB0b29sOiBcImFycm93XCI7XG4gICAgICB4MTogbnVtYmVyO1xuICAgICAgeTE6IG51bWJlcjtcbiAgICAgIHgyOiBudW1iZXI7XG4gICAgICB5MjogbnVtYmVyO1xuICAgIH0pXG4gIHwgKE1hcmtCYXNlICYge1xuICAgICAgdG9vbDogXCJsaW5lXCI7XG4gICAgICB4MTogbnVtYmVyO1xuICAgICAgeTE6IG51bWJlcjtcbiAgICAgIHgyOiBudW1iZXI7XG4gICAgICB5MjogbnVtYmVyO1xuICAgIH0pXG4gIHwgKE1hcmtCYXNlICYgeyB0b29sOiBcInJlY3RcIjsgeDogbnVtYmVyOyB5OiBudW1iZXI7IHc6IG51bWJlcjsgaDogbnVtYmVyIH0pXG4gIHwgKE1hcmtCYXNlICYge1xuICAgICAgdG9vbDogXCJlbGxpcHNlXCI7XG4gICAgICBjeDogbnVtYmVyO1xuICAgICAgY3k6IG51bWJlcjtcbiAgICAgIHJ4OiBudW1iZXI7XG4gICAgICByeTogbnVtYmVyO1xuICAgIH0pXG4gIC8vIGZyZWVmb3JtIHNrZXRjaCDigJQgYW4gb3JkZXJlZCBsaXN0IG9mIGZyYWN0aW9uLXNwYWNlIHBvaW50cyAoYSBwb2x5bGluZSkuIFRoZVxuICAvLyB2aXN1YWwgaGFuZG9mZiAoZmxhdHRlbmVkIGltYWdlKSBpcyB3aGF0IHRoZSBtb2RlbCByZWFkczsgZG91YmxlcyBhcyBhIGZ1dHVyZVxuICAvLyBpbnBhaW50LW1hc2sgcmVnaW9uLlxuICB8IChNYXJrQmFzZSAmIHsgdG9vbDogXCJkcmF3XCI7IHBvaW50czogeyB4OiBudW1iZXI7IHk6IG51bWJlciB9W10gfSlcbiAgLy8gYW4gaW1hZ2UgTEFZRVIgZWxlbWVudCDigJQgYSBkcm9wcGVkIGNsaXBwaW5nL3JlZmVyZW5jZSBjb21wb3NpdGVkIG9udG8gdGhlXG4gIC8vIGltYWdlLiBSZXVzZXMgcmVjdCBnZW9tZXRyeSAoeCx5LHcsaCBmcmFjdGlvbnMpIHNvIGl0IGluaGVyaXRzXG4gIC8vIGJvdW5kcy9oaXQvcmVzaXplL3RyYW5zbGF0ZTsgYHNyY2AgaXMgYSBiYXNlNjQgd2VicCAoc3RyaXBwZWQgaW4gdGhlIGxlYW5cbiAgLy8gYWdlbnQgcHJvamVjdGlvbiDigJQgdGhlIGFnZW50IHJlYWRzIHRoZSBmbGF0dGVuZWQgY29tcG9zaXRlLCBub3QgbGF5ZXIgYml0bWFwcykuXG4gIHwgKE1hcmtCYXNlICYge1xuICAgICAgdG9vbDogXCJpbWFnZVwiO1xuICAgICAgc3JjOiBzdHJpbmc7XG4gICAgICB4OiBudW1iZXI7XG4gICAgICB5OiBudW1iZXI7XG4gICAgICB3OiBudW1iZXI7XG4gICAgICBoOiBudW1iZXI7XG4gICAgfSk7XG5leHBvcnQgY29uc3QgTUFSS19UT09MUzogcmVhZG9ubHkgTWFya1tcInRvb2xcIl1bXSA9IFtcbiAgXCJwaW5cIixcbiAgXCJhcnJvd1wiLFxuICBcImxpbmVcIixcbiAgXCJyZWN0XCIsXG4gIFwiZWxsaXBzZVwiLFxuICBcImRyYXdcIixcbiAgXCJpbWFnZVwiLFxuXSBhcyBjb25zdDtcblxuLy8gQSBMQVlFUiBpcyBhIENPTlRBSU5FUiBvZiBtYXJrcyAoZWxlbWVudHMpIG9uIGEgdmFyaWFudCDigJQgdGhlIGdyb3VwaW5nIHVuaXQgZm9yXG4vLyB6LW9yZGVyLCB2aXNpYmlsaXR5LCBhbmQgbG9jay4gRWxlbWVudHMgcmVmZXJlbmNlIGl0IHZpYSBNYXJrLmxheWVySWQuIEVmZmVjdGl2ZVxuLy8geiA9IGxheWVyIG9yZGVyIChhcnJheSBpbmRleCBpbiBgbGF5ZXJzQnlWYXJpYW50YCwgYmFja+KGkmZyb250KSB0aGVuIHRoZSBlbGVtZW50J3Ncbi8vIGB6T3JkZXJgIFdJVEhJTiB0aGUgbGF5ZXIuIEEgXCJncm91cC1vZi1vbmVcIiAoYSBzdGFuZGFsb25lIGFycm93KSBpcyBqdXN0IGEgbGF5ZXJcbi8vIHdpdGggYSBzaW5nbGUgZWxlbWVudDsgYSBza2V0Y2ggbGF5ZXIgYWNjcmV0ZXMgbWFueSBwZW4gc3Ryb2tlcy4gVGhlIGJhc2UgaW1hZ2Vcbi8vICh0aGUgZm9jdXNlZCBWYXJpYW50KSBpcyBzaG93biBhcyBhIHN5bnRoZXRpYyBsb2NrZWQgXCJCYWNrZ3JvdW5kXCIgcm93IGFuZCBpcyBOT1Rcbi8vIHN0b3JlZCBoZXJlLiBgaGlkZGVuYCBkb3VibGVzIGFzIHRoZSBhZ2VudC1oYW5kb2ZmIGZpbHRlcjogaGlkZGVuIGxheWVycyBkb24ndFxuLy8gcmVuZGVyLCBzbyB0aGV5IGRvbid0IGZsYXR0ZW4sIHNvIHRoZSBhZ2VudCBuZXZlciByZWNlaXZlcyB0aGVtLlxuZXhwb3J0IHR5cGUgTGF5ZXIgPSB7XG4gIGlkOiBzdHJpbmc7XG4gIG5hbWU6IHN0cmluZzsgLy8gZWRpdGFibGU7IHRoZSBwYW5lbCBsYWJlbFxuICBraW5kOiBcImFubm90YXRpb25cIiB8IFwic2tldGNoXCIgfCBcImltYWdlXCI7IC8vIGF1dG8tbmFtZSArIGljb247IFwic2tldGNoXCIgYWNjcmV0ZXMgcGVuIHN0cm9rZXNcbiAgaGlkZGVuPzogYm9vbGVhbjtcbiAgbG9ja2VkPzogYm9vbGVhbjtcbn07XG5cbi8vIOKUgOKUgCB0aGUgd2hvbGUgc3RhdGUg4pSA4pSAXG5cbmV4cG9ydCB0eXBlIEltYWdvU3RhdGUgPSB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGJhdGNoZXM6IEJhdGNoW107XG4gIGZvY3VzOiBGb2N1cyB8IG51bGw7IC8vIHRoZSBpbWFnZSBvbiB0aGUgY2FudmFzIChudWxsID0gYmxhbmsgXCJuZXdcIiBmcmFtZSlcbiAgY29udmVyc2F0aW9uOiBNZXNzYWdlW107XG4gIGxpYnJhcnk6IENvbnRleHRFbnRyeVtdOyAvLyB0aGUgdW5pZmllZCwgcGFzc2l2ZSBjb250ZXh0IGNhdGFsb2cgKHN0eWxlcyArIHF1aWNrLXByb21wdHM7IHNraWxsL2NvbnRleHQgcmVzZXJ2ZWQpXG4gIGFjdGl2ZUNvbnRleHRJZHM6IHN0cmluZ1tdOyAvLyBzdHlsZXMgYXR0YWNoZWQgdG8gdGhlIE5FWFQgZ2VuZXJhdGlvbiAodGhlIGFjdGl2ZS1jb250ZXh0IHRyYXkpXG4gIHF1aWNrUHJvbXB0SWRzOiBzdHJpbmdbXTsgLy8gcHJvbXB0cyBzdXJmYWNlZCBpbiB0aGUgY29tcG9zZXIgcXVpY2stcHJvbXB0cyBsaXN0IChhIGN1cmF0ZWQgc3Vic2V0KVxuICBwaW5zOiBQaW5bXTtcbiAgbWFya3NCeVZhcmlhbnQ6IFJlY29yZDxzdHJpbmcsIE1hcmtbXT47IC8vIGR1cmFibGUgYW5ub3RhdGlvbiBtYXJrcyBwZXIgdmFyaWFudCBpZFxuICAvLyBDT05UQUlORVIgbWV0YWRhdGEgcGVyIHZhcmlhbnQ6IGFuIG9yZGVyZWQgbGlzdCBvZiBMYXllcnMgKGJhY2vihpJmcm9udCkgdGhhdFxuICAvLyBncm91cCB0aGUgbWFya3MgYWJvdmUuIEVhY2ggTWFyayBjYXJyaWVzIGEgYGxheWVySWRgIGludG8gdGhpcyBsaXN0OyBlZmZlY3RpdmVcbiAgLy8geiA9IGxheWVyIG9yZGVyLCB0aGVuIE1hcmsuek9yZGVyIHdpdGhpbiB0aGUgbGF5ZXIuIFNlZSB0eXBlIExheWVyLlxuICBsYXllcnNCeVZhcmlhbnQ6IFJlY29yZDxzdHJpbmcsIExheWVyW10+O1xuICBhbmFseXNpc0NhY2hlOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+OyAvLyBoYXNoIOKGkiBhZ2VudCBhbmFseXNpczsgc3Vydml2ZXMgYSByZWYgZGVsZXRlL3JlLWFkZCAoZGFlbW9uLW1haW50YWluZWQpXG4gIGFzcGVjdDogc3RyaW5nOyAvLyBhc3BlY3QgcmF0aW8gZm9yIGEgTkVXIChmcmVzaCkgZ2VuZXJhdGlvblxuICBzaXplOiBJbWFnZVNpemU7IC8vIG91dHB1dCByZXNvbHV0aW9uIGZvciBhIE5FVyBnZW5lcmF0aW9uXG4gIHN0YXR1czogeyBidXN5OiBib29sZWFuOyB0ZXh0OiBzdHJpbmcgfTtcbiAgY29zdDogc3RyaW5nOyAvLyBwcmUtZm9ybWF0dGVkIGZvciBkaXNwbGF5LCBlLmcuIFwiJDAuMThcIlxuICBoYW5kb2ZmOiBzdHJpbmc7IC8vIGFnZW50IGVzY2FsYXRlZCB0byBhIHRlcm1pbmFsIEFza1VzZXJRdWVzdGlvbiAocHJlc2VuY2U6IGFza2luZylcbiAgLy8gdW5kby9yZWRvIGF2YWlsYWJpbGl0eSBmb3IgdGhlIEZPQ1VTRUQgdmFyaWFudCdzIG1hcmsgZWRpdHMgKHNlcnZlci1kZXJpdmVkXG4gIC8vIGZyb20gYW4gaW4tbWVtb3J5LCBwZXItdmFyaWFudCBoaXN0b3J5OyBzaXR1YXRpb25hbCwgbm90IHBlcnNpc3RlZCkuIExldHMgdGhlXG4gIC8vIHRvb2xiYXIgZW5hYmxlL2Rpc2FibGUgdGhlIGJ1dHRvbnMuXG4gIGhpc3Rvcnk6IHsgY2FuVW5kbzogYm9vbGVhbjsgY2FuUmVkbzogYm9vbGVhbiB9O1xuICAvLyBPTkUgZnJlc2huZXNzIHNpZ25hbCBzaGFyZWQgYnkgYm90aCBjaGFubmVsczogdHJ1ZSB3aGVuIHRoZSBGT0NVU0VEIGltYWdlIGhhc1xuICAvLyBhbm5vdGF0aW9uIGNoYW5nZXMgdGhlIGFnZW50IGhhc24ndCByZWNlaXZlZCB5ZXQuIFNldCBvbiBhbnkgbWFyayBlZGl0O1xuICAvLyBjbGVhcmVkIHdoZW4gdGhlIGFnZW50IGdldHMgdGhlIG1hcmtlZCBpbWFnZSDigJQgdmlhIHRoZSBjb21taXQgYnV0dG9uIE9SIGEgY2hhdFxuICAvLyBtZXNzYWdlIHRoYXQgY2FycmllcyBpdC4gRHJpdmVzIHRoZSBjb21taXQgYnV0dG9uIChcIlRha2UgbWFya3NcIiB2cyBcIlNoYXJlZFwiKVxuICAvLyBhbmQgdGhlIGNoYXQtc2VuZCBhdXRvLWF0dGFjaC4gU2VydmVyLWRlcml2ZWQgZm9yIHRoZSBmb2N1c2VkIHZhcmlhbnQuXG4gIG1hcmtzVW5zZWVuOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgSW1hZ2VTaXplID0gXCIxS1wiIHwgXCIyS1wiO1xuZXhwb3J0IGNvbnN0IEFTUEVDVFM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW1wiMToxXCIsIFwiMzoyXCIsIFwiMjozXCIsIFwiMTY6OVwiLCBcIjk6MTZcIl0gYXMgY29uc3Q7XG5leHBvcnQgY29uc3QgU0laRVM6IHJlYWRvbmx5IEltYWdlU2l6ZVtdID0gW1wiMUtcIiwgXCIyS1wiXSBhcyBjb25zdDtcblxuLy8gUHJlc2VuY2UgKFwiYXNraW5nXCIpIGlzIERFUklWRUQsIG5vdCBhIHN0b3JlZCBmbGFnIOKAlCBzbyBpdCBjYW4ndCBkcmlmdCBmcm9tIHRoZVxuLy8gdGhyZWFkOiB0aGUgYWdlbnQgaXMgXCJhc2tpbmdcIiB3aGVuIGBoYW5kb2ZmYCBpcyBzZXQgT1IgdGhlIGxhc3QgbWVzc2FnZSBpcyBhblxuLy8gdW5hbnN3ZXJlZCBxdWVzdGlvbi4gKEhlbHBlciBsaXZlcyBpbiB0aGUgc3VyZmFjZS4pXG5cbi8vIOKUgOKUgCBTZXJ2ZXIg4oaSIGJyb3dzZXIgKFdlYlNvY2tldCkuIFRoZSBicm93c2VyIGhhbmRsZXMgZXhhY3RseSB0aGVzZS4g4pSA4pSAXG5leHBvcnQgdHlwZSBTZXJ2ZXJUb0NsaWVudCA9XG4gIHwgeyB0eXBlOiBcInN0YXRlXCI7IHN0YXRlOiBJbWFnb1N0YXRlIH1cbiAgfCB7IHR5cGU6IFwibWVzc2FnZVwiOyB0ZXh0OiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJzdWJtaXRcIiB9XG4gIHwgeyB0eXBlOiBcImNhbmNlbFwiIH07XG5cbi8vIOKUgOKUgCBCcm93c2VyIOKGkiBzZXJ2ZXIgKFdlYlNvY2tldCkuIFRoZSBjbGllbnQgc2VuZHMgZXhhY3RseSB0aGVzZS4g4pSA4pSAXG4vLyBFYWNoIGVpdGhlciBtdXRhdGVzIHN0YXRlIChyZS1icm9hZGNhc3QpIGFuZC9vciBlbWl0cyBhbiBTU0UgZXZlbnQgdGhlIGFnZW50XG4vLyByZWFjdHMgdG8uIFRoZSBjb252ZXJzYXRpb24gaXMgdGhlIHByaW1hcnkgY2hhbm5lbDsgZ2VzdHVyZXMgYXJlIGZpcnN0LWNsYXNzLlxuZXhwb3J0IHR5cGUgQ2xpZW50VG9TZXJ2ZXIgPVxuICB8IHtcbiAgICAgIHR5cGU6IFwic2F5XCI7IC8vIHVzZXIgcG9zdHMgYSBtZXNzYWdlIC8gaW5zdHJ1Y3Rpb25cbiAgICAgIHRleHQ6IHN0cmluZztcbiAgICAgIC8vIHdoZW4gdGhlIGZvY3VzZWQgaW1hZ2UgaGFzIHVuc2VlbiBtYXJrcywgdGhlIHN1cmZhY2UgZmxhdHRlbnMgaXQgYW5kXG4gICAgICAvLyByaWRlcyB0aGUgbWFya2VkIGltYWdlIGFsb25nIHdpdGggdGhlIG1lc3NhZ2UgKG9uZSBmcmVzaG5lc3Mgc2lnbmFsKS5cbiAgICAgIGZsYXR0ZW5lZFNyYz86IHN0cmluZztcbiAgICB9XG4gIHwgeyB0eXBlOiBcInByb3Bvc2FsLnNlbmRcIjsgaWQ6IHN0cmluZyB9IC8vIGNvbmZpcm0gYSBwcm9tcHQgcHJvcG9zYWwg4oaSIGdlbmVyYXRlXG4gIHwgeyB0eXBlOiBcInByb3Bvc2FsLmRpc21pc3NcIjsgaWQ6IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcImZvY3VzLnNldFwiOyBiYXRjaElkOiBzdHJpbmc7IHZhcmlhbnRJZDogc3RyaW5nIH0gLy8gZm9jdXMgYW4gaW1hZ2VcbiAgfCB7IHR5cGU6IFwiZm9jdXMuY2xlYXJcIiB9IC8vIGJhY2sgdG8gYSBibGFuayBcIm5ld1wiIGZyYW1lXG4gIHwgeyB0eXBlOiBcInZhcmlhbnQubGlrZVwiOyBpZDogc3RyaW5nOyBsaWtlZDogYm9vbGVhbiB9XG4gIHwgeyB0eXBlOiBcInZhcmlhbnQucmVtb3ZlXCI7IGJhdGNoSWQ6IHN0cmluZzsgdmFyaWFudElkOiBzdHJpbmcgfSAvLyBkZWxldGUgYSB2YXJpYW50IGZyb20gdGhlIGxpYnJhcnkgKCsgaXRzIG1hcmtzL2xheWVyczsgZHJvcHMgdGhlIGJhdGNoIHdoZW4gZW1wdHkpOyBhbWJpZW50IChubyBhZ2VudCBldmVudClcbiAgfCB7XG4gICAgICB0eXBlOiBcImNvbnRleHQuYWRkXCI7XG4gICAgICBraW5kOiBDb250ZXh0S2luZDtcbiAgICAgIG5hbWU6IHN0cmluZztcbiAgICAgIGNvbnRlbnQ6IHN0cmluZztcbiAgICAgIHRhZ3M/OiBzdHJpbmdbXTtcbiAgICAgIGltYWdlPzogc3RyaW5nO1xuICAgICAgbGluaz86IENvbnRleHRTZXQ7XG4gICAgfVxuICB8IHsgdHlwZTogXCJjb250ZXh0LnVwZGF0ZVwiOyBpZDogc3RyaW5nOyBuYW1lPzogc3RyaW5nOyBjb250ZW50Pzogc3RyaW5nOyB0YWdzPzogc3RyaW5nW10gfVxuICB8IHsgdHlwZTogXCJjb250ZXh0LmRlbGV0ZVwiOyBpZDogc3RyaW5nIH0gLy8gdGhlIE9OTFkgZGVzdHJveSAoZ3VhcmRlZCBieSBhIFVJIGNvbmZpcm0pXG4gIHwgeyB0eXBlOiBcImNvbnRleHQubGlua1wiOyBpZDogc3RyaW5nOyBzZXQ6IENvbnRleHRTZXQgfSAvLyBhZGQgdG8gYSBsaW5rZWQgc2V0XG4gIHwgeyB0eXBlOiBcImNvbnRleHQudW5saW5rXCI7IGlkOiBzdHJpbmc7IHNldDogQ29udGV4dFNldCB9IC8vIHJlbW92ZSBmcm9tIGEgbGlua2VkIHNldCAodGhlIGV2ZXJ5ZGF5IOKclSlcbiAgfCB7IHR5cGU6IFwiY29udGV4dC5jYXB0dXJlXCIgfSAvLyBjYXB0dXJlIGEgc3R5bGUgZnJvbSB0aGUgZm9jdXNlZCBpbWFnZVxuICB8IHsgdHlwZTogXCJwaW4uYWRkXCI7IGtleTogc3RyaW5nOyB2YWx1ZTogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwicGluLnJlbW92ZVwiOyBrZXk6IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcInJlZi5hZGRcIjsgaW1hZ2U6IHsgc3JjOiBzdHJpbmc7IG5hbWU/OiBzdHJpbmcgfSB9IC8vIGltcG9ydCBhbiBleHRlcm5hbCBpbWFnZSBhcyBhIHZhcmlhbnQgKyBzZWxlY3QgaXQgYXMgYSByZWYgKGRlZHVwIGJ5IGhhc2gg4oaSIHNlbGVjdHMgdGhlIGV4aXN0aW5nIG9uZSlcbiAgfCB7IHR5cGU6IFwicmVmLnJlbW92ZVwiOyBpZDogc3RyaW5nIH0gLy8gREVTRUxFQ1QgYSB2YXJpYW50IGFzIGEgcmVmIChpdCBzdGF5cyBpbiB0aGUgbGlicmFyeTsgdG8gZGVsZXRlIHRoZSBpbWFnZSB1c2UgdmFyaWFudC5yZW1vdmUpXG4gIHwgeyB0eXBlOiBcImltYWdlLmltcG9ydFwiOyBpbWFnZTogeyBzcmM6IHN0cmluZzsgbmFtZT86IHN0cmluZyB9IH0gLy8gZHJvcCBvbiBjYW52YXMg4oaSIHdvcmtpbmcgaW1hZ2VcbiAgfCB7XG4gICAgICAvLyBkcm9wIGFuIGltYWdlIGFzIGEgTEFZRVIgb250byB0aGUgZm9jdXNlZCBpbWFnZSAoY29sbGFnZSkg4oCUIGRpc3RpbmN0IGZyb21cbiAgICAgIC8vIGltYWdlLmltcG9ydCwgd2hpY2ggUkVQTEFDRVMuIFRoZSBjbGllbnQgc3VwcGxpZXMgdGhlIGZyYWN0aW9uLXNwYWNlIGJveFxuICAgICAgLy8gKGl0IGtub3dzIHRoZSBiYXNlIGltYWdlIGJveCArIHRoZSBkcm9wcGVkIGJpdG1hcCdzIGFzcGVjdCk7IHRoZSBzZXJ2ZXJcbiAgICAgIC8vIG9wdGltaXplcyB0aGUgc3JjICsgc3RvcmVzIGl0LiBHZW9tZXRyeSBvcHRpb25hbCDihpIgc2VydmVyIGNlbnRlcnMgYSA0MCUgYm94LlxuICAgICAgdHlwZTogXCJsYXllci5hZGRJbWFnZVwiO1xuICAgICAgc3JjOiBzdHJpbmc7XG4gICAgICBuYW1lPzogc3RyaW5nO1xuICAgICAgeD86IG51bWJlcjtcbiAgICAgIHk/OiBudW1iZXI7XG4gICAgICB3PzogbnVtYmVyO1xuICAgICAgaD86IG51bWJlcjtcbiAgICB9XG4gIC8vIOKUgOKUgCBsYXllciAoY29udGFpbmVyKSBvcHMg4oCUIFBoYXNlIDIgaW5zcGVjdG9yIHBhbmVsLiBBbGwgc2VydmVyLWF1dGhvcml0YXRpdmVcbiAgLy8gYW5kIHVuZG9hYmxlIHZpYSB0aGUgd2lkZW5lZCB7bWFya3MsbGF5ZXJzfSBoaXN0b3J5OyBsb2NhbCB1bnRpbCBjb21taXQgKHRoZVxuICAvLyBmbGF0dGVuIHJlc3BlY3RzIGBoaWRkZW5gKSwgc28gbm8gYWdlbnQgZXZlbnQg4oCUIHNhbWUgcnVsZSBhcyBtYXJrLiogb3BzLlxuICB8IHsgdHlwZTogXCJsYXllci5hZGRcIjsgbmFtZT86IHN0cmluZzsga2luZD86IExheWVyW1wia2luZFwiXSB9IC8vIGJsYW5rIGxheWVyIG9uIHRvcFxuICB8IHsgdHlwZTogXCJsYXllci5yZW5hbWVcIjsgaWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwibGF5ZXIuc2V0SGlkZGVuXCI7IGlkOiBzdHJpbmc7IGhpZGRlbjogYm9vbGVhbiB9IC8vIHZpc2liaWxpdHkgKyBoYW5kb2ZmIGZpbHRlclxuICB8IHsgdHlwZTogXCJsYXllci5zZXRMb2NrZWRcIjsgaWQ6IHN0cmluZzsgbG9ja2VkOiBib29sZWFuIH0gLy8gbm90IGhpdC10ZXN0YWJsZSAvIHNlbGVjdGFibGVcbiAgfCB7IHR5cGU6IFwibGF5ZXIucmVvcmRlclwiOyBpZDogc3RyaW5nOyB0b0luZGV4OiBudW1iZXIgfSAvLyBhYnNvbHV0ZSBwbGFjZW1lbnQgKGRyYWctZHJvcClcbiAgfCB7IHR5cGU6IFwibGF5ZXIucmVtb3ZlXCI7IGlkOiBzdHJpbmcgfSAvLyBkZWxldGVzIHRoZSBsYXllciBBTkQgaXRzIGVsZW1lbnRzXG4gIHwgeyB0eXBlOiBcImdyb3VwXCI7IG1hcmtJZHM6IHN0cmluZ1tdOyBuYW1lPzogc3RyaW5nIH0gLy8gd3JhcCBzZWxlY3RlZCBtYXJrcyBpbiBhIG5ldyBsYXllclxuICB8IHsgdHlwZTogXCJ1bmdyb3VwXCI7IGlkOiBzdHJpbmcgfSAvLyBkaXNzb2x2ZSDihpIgZWFjaCBlbGVtZW50IGJlY29tZXMgaXRzIG93biBncm91cC1vZi1vbmUgbGF5ZXJcbiAgLy8gTk9URTogdGhlcmUgaXMgbm8gYGxheWVyLnNldEFjdGl2ZWAg4oCUIHRoZSBhY3RpdmUgbGF5ZXIgKHdoZXJlIG5ldyBtYXJrcyBkcm9wKVxuICAvLyBpcyBzdXJmYWNlLW93bmVkLiBUaGUgY2xpZW50IHN0YW1wcyBgbWFyay5sYXllcklkYCBvbiBtYXJrLmFkZDsgdGhlIHNlcnZlclxuICAvLyBob25vcnMgYSB2YWxpZCBvbmUsIGVsc2UgZHJvcHMgaW50byB0aGUgdG9wbW9zdCBub24taW1hZ2UgbGF5ZXIuXG4gIHwgeyB0eXBlOiBcInJlZi5zZWxlY3RcIjsgaWQ6IHN0cmluZzsgc2VsZWN0ZWQ6IGJvb2xlYW4gfSAvLyBwb2ludCBhIFZBUklBTlQgYXQgdGhlIG5leHQgZ2VuIChpZCA9IHZhcmlhbnRJZDsgdG9nZ2xlcyByZWZTZWxlY3RlZClcbiAgfCB7IHR5cGU6IFwibWFyay5hZGRcIjsgbWFyazogTWFyayB9IC8vIGxvY2FsLWlzaDsgbm8gYWdlbnQgZXZlbnQgdW50aWwgY29tbWl0IChzZXJ2ZXIgYXNzaWducyB6T3JkZXI7IGhvbm9ycyBhIHZhbGlkIG1hcmsubGF5ZXJJZCBhcyB0aGUgYWN0aXZlIGxheWVyLCBlbHNlIHRvcG1vc3Qgbm9uLWltYWdlIGxheWVyKVxuICB8IHsgdHlwZTogXCJtYXJrLnJlbW92ZVwiOyBpZDogc3RyaW5nIH0gLy8gZGVsZXRlIG9uZSBtYXJrIChjb21wbGVtZW50cyBtYXJrcy5jbGVhcilcbiAgfCB7XG4gICAgICAvLyBtb3ZlL3Jlc2l6ZS9sYWJlbCAoc2VydmVyIG1lcmdlczsgbmV2ZXIgaWQvdG9vbC96T3JkZXIpLiBWYWx1ZXMgYXJlXG4gICAgICAvLyBzY2FsYXJzIChnZW9tZXRyeS9sYWJlbC9zdHlsZSkgb3IgYSBkcmF3IG1hcmsncyB3aG9sZSBgcG9pbnRzYCBhcnJheS5cbiAgICAgIHR5cGU6IFwibWFyay51cGRhdGVcIjtcbiAgICAgIGlkOiBzdHJpbmc7XG4gICAgICBwYXRjaDogUmVjb3JkPHN0cmluZywgbnVtYmVyIHwgc3RyaW5nIHwgeyB4OiBudW1iZXI7IHk6IG51bWJlciB9W10+O1xuICAgIH1cbiAgfCB7XG4gICAgICB0eXBlOiBcIm1hcmsucmVvcmRlclwiO1xuICAgICAgaWQ6IHN0cmluZztcbiAgICAgIGRpcmVjdGlvbjogXCJmb3J3YXJkXCIgfCBcImJhY2tcIiB8IFwiZnJvbnRcIiB8IFwiYmFjay1tb3N0XCI7XG4gICAgfSAvLyB6LW9yZGVyXG4gIHwgeyB0eXBlOiBcIm1hcmtzLmNsZWFyXCIgfVxuICB8IHsgdHlwZTogXCJtYXJrcy5yZXBsYWNlXCI7IG1hcmtzOiBNYXJrW10gfSAvLyBzd2FwIHRoZSBmb2N1c2VkIGltYWdlJ3MgbWFya3Mgd2hvbGVzYWxlIChvbmUgaGlzdG9yeSBzdGVwKSDigJQgdXNlZCBieSB0aGUgcGVuIGVyYXNlciwgd2hpY2ggdHJpbXMvc3BsaXRzIHN0cm9rZXNcbiAgfCB7IHR5cGU6IFwidW5kb1wiIH0gLy8gc3RlcCB0aGUgZm9jdXNlZCBpbWFnZSdzIG1hcmsgaGlzdG9yeSBiYWNrXG4gIHwgeyB0eXBlOiBcInJlZG9cIiB9IC8vIHN0ZXAgaXQgZm9yd2FyZFxuICB8IHtcbiAgICAgIHR5cGU6IFwibWFya3MuY29tbWl0XCI7IC8vIFwidGFrZSBtYXJrcyB0byB0aGUgY29udmVyc2F0aW9uIOKGklwiXG4gICAgICB0ZXh0OiBzdHJpbmc7XG4gICAgICBiYXRjaElkOiBzdHJpbmc7XG4gICAgICB2YXJpYW50SWQ6IHN0cmluZztcbiAgICAgIGZsYXR0ZW5lZFNyYz86IHN0cmluZzsgLy8gZGF0YS11cmwgUE5HOiB0aGUgaW1hZ2Ugd2l0aCBtYXJrcyBidXJuZWQgaW4gKHRoZSB2aXN1YWwgaGFuZG9mZikuIE9wdGlvbmFsIOKAlCBjYXB0dXJlIGlzIGJlc3QtZWZmb3J0LlxuICAgIH1cbiAgfCB7IHR5cGU6IFwiYXNwZWN0LnNldFwiOyBhc3BlY3Q6IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcInNpemUuc2V0XCI7IHNpemU6IEltYWdlU2l6ZSB9XG4gIHwgeyB0eXBlOiBcInN1Ym1pdFwiIH1cbiAgfCB7IHR5cGU6IFwiY2FuY2VsXCIgfTtcblxuLy8g4pSA4pSAIEFnZW50IOKGkiBzZXJ2ZXIgKFBPU1QgL2NtZCkuIFRoZSBhZ2VudCBkcml2ZXMgdGhlIGRhZW1vbiB3aXRoIGV4YWN0bHkgdGhlc2UuIOKUgOKUgFxuZXhwb3J0IHR5cGUgQWdlbnRDb21tYW5kID1cbiAgfCB7IHR5cGU6IFwiaW5pdFwiOyB0aXRsZT86IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcInNheVwiOyB0ZXh0OiBzdHJpbmcgfSAvLyBwb3N0IGFnZW50IGRpYWxvZ3VlIChraW5kOlwidGV4dFwiKVxuICB8IHsgdHlwZTogXCJwcm9wb3NlXCI7IHByb21wdDogc3RyaW5nOyBuPzogbnVtYmVyIH0gLy8gcG9zdCBhIHByb21wdCBwcm9wb3NhbFxuICB8IHsgdHlwZTogXCJhc2tcIjsgdGV4dDogc3RyaW5nOyBvcHRpb25zPzogc3RyaW5nW10gfSAvLyBwb3N0IGFuIGluLXRocmVhZCBxdWVzdGlvblxuICB8IHtcbiAgICAgIC8vIGFkZCBhIHByb2R1Y2VkIGJhdGNoICsgKGF1dG8pIGEgXCJyZXN1bHRcIiBtZXNzYWdlIGFubm91bmNpbmcgaXRcbiAgICAgIHR5cGU6IFwiYmF0Y2guYWRkXCI7XG4gICAgICBraW5kOiBcImdlbmVyYXRlXCIgfCBcImVkaXRcIjtcbiAgICAgIHByb21wdDogc3RyaW5nO1xuICAgICAgdGFnPzogc3RyaW5nO1xuICAgICAgZWRpdGVkRnJvbVZhcmlhbnRJZD86IHN0cmluZztcbiAgICAgIHN1bW1hcnk/OiBzdHJpbmc7IC8vIHRoZSByZXN1bHQgbWVzc2FnZSB0ZXh0XG4gICAgICB2YXJpYW50czogeyBzcmM6IHN0cmluZzsgc2VlZD86IG51bWJlcjsgbW9kZWw/OiBzdHJpbmc7IGlkPzogc3RyaW5nIH1bXTtcbiAgICB9XG4gIHwgeyB0eXBlOiBcImZvY3VzXCI7IGJhdGNoSWQ6IHN0cmluZzsgdmFyaWFudElkOiBzdHJpbmcgfSAvLyBhZ2VudCBmb2N1c2VzIGFuIGltYWdlXG4gIHwgeyB0eXBlOiBcInJlZi5zZWxlY3RcIjsgaWQ6IHN0cmluZzsgc2VsZWN0ZWQ6IGJvb2xlYW4gfSAvLyBhZ2VudCBwb2ludHMgYSB2YXJpYW50IGF0IHRoZSBuZXh0IGdlbiAoaWQgPSB2YXJpYW50SWQ7IHRoZSB1c2VyIHNlZXMgaXQgaGlnaGxpZ2h0KVxuICAvLyAocmVmLmFuYWx5emUgcmVtb3ZlZCDigJQgd3JpdGUgYSByZWFkIG9udG8gYW55IGltYWdlIHZpYSB2YXJpYW50LmFuYWx5emU7IHJlZnMgYXJlIHZhcmlhbnRzIG5vdylcbiAgfCB7IHR5cGU6IFwidmFyaWFudC5hbmFseXplXCI7IGlkOiBzdHJpbmc7IHRleHQ6IHN0cmluZyB9IC8vIHdyaXRlIHlvdXIgcmVhZCBvbnRvIGEgZ2VuZXJhdGVkL2ltcG9ydGVkIGltYWdlXG4gIHwge1xuICAgICAgdHlwZTogXCJjb250ZXh0LmFkZFwiO1xuICAgICAga2luZDogQ29udGV4dEtpbmQ7XG4gICAgICBuYW1lOiBzdHJpbmc7XG4gICAgICBjb250ZW50OiBzdHJpbmc7XG4gICAgICB0YWdzPzogc3RyaW5nW107XG4gICAgICBpbWFnZT86IHN0cmluZztcbiAgICAgIGxpbms/OiBDb250ZXh0U2V0O1xuICAgIH1cbiAgfCB7IHR5cGU6IFwic3RhdHVzXCI7IGJ1c3k6IGJvb2xlYW47IHRleHQ/OiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJjb3N0XCI7IHRleHQ6IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcImhhbmRvZmZcIjsgdGV4dDogc3RyaW5nIH0gLy8gXCJcIiBjbGVhcnMgKHRlcm1pbmFsLWFzayBlc2NhcGUpXG4gIHwgeyB0eXBlOiBcImNsb3NlXCIgfTtcblxuLy8gVGhlIGFnZW50IGV2ZW50IHNldCAoc2VydmVyIOKGkiBhZ2VudCBTU0UpIOKAlCBJTVBFUkFUSVZFUyBPTkxZOiB0aGUgbW92ZXMgd2hlcmVcbi8vIHRoZSB1c2VyIGlzIGFza2luZyB0aGUgYWdlbnQgZm9yIHNvbWV0aGluZyBvciBoYW5kaW5nIHdvcmsgb2ZmLCBwbHVzIGxpZmVjeWNsZS5cbi8vIFRoZSBhZ2VudCByZWFjdHMgdG8gdGhlc2UuXG4vL1xuLy8gQU1CSUVOVCBCT0FSRCBTVEFURSBpcyBkZWxpYmVyYXRlbHkgTk9UIGhlcmUg4oCUIGZvY3VzLCByZWYgc2VsZWN0aW9uLCBsaWtlcyxcbi8vIHN0eWxlIHRvZ2dsZXMsIGFzcGVjdC9zaXplLCBwaW5zLCByZWYtbGlicmFyeSBhZGRzLCBpbWFnZSBpbXBvcnRzLiBUaG9zZSBhcmVcbi8vIHBpZWNlcyBtb3Zpbmcgb24gdGhlIGJvYXJkOyB0aGUgYWdlbnQgUkVBRFMgdGhlbSBmcm9tIC9zdGF0ZSB3aGVuIGl0J3MgaXRzIG1vdmUsXG4vLyBpdCBkb2VzIG5vdCBnZXQgcGluZ2VkIG9uIGV2ZXJ5IHRvZ2dsZSAodGhhdCB3YXMganVzdCBub2lzZSkuIFRvIG1ha2UgdGhhdCBzYWZlLFxuLy8gdGhlIGltcGVyYXRpdmVzIHRoYXQgYXJlIFwiYWJvdXQgYW4gaW1hZ2VcIiBjYXJyeSB0aGVpciBib2FyZCBjb250ZXh0OiBgc2F5YCBhbmRcbi8vIGBtYXJrcy5jb21taXRgIHJpZGUgdGhlIGZvY3VzZWQgdmFyaWFudCArIHNlbGVjdGVkIHJlZiBpZHM7IGBjb250ZXh0LmNhcHR1cmVgXG4vLyByaWRlcyB0aGUgZm9jdXMuIEluY3JlbWVudGFsIGFubm90YXRpb24gKG1hcmsuYWRkL21hcmtzLmNsZWFyKSBpcyBsaWtld2lzZSBOT1Rcbi8vIGhlcmUg4oCUIHRoZSBhZ2VudCByZWFjdHMgd2hlbiB0aGUgdXNlciBDT01NSVRTIG1hcmtzLCBub3Qgb24gZXZlcnkgc3Ryb2tlLlxuZXhwb3J0IGNvbnN0IEFHRU5UX0VWRU5UX1RZUEVTID0gT2JqZWN0LmZyZWV6ZShbXG4gIFwicmVhZHlcIixcbiAgXCJjb25uZWN0ZWRcIixcbiAgXCJkaXNjb25uZWN0ZWRcIixcbiAgXCJzYXlcIixcbiAgXCJwcm9wb3NhbC5zZW5kXCIsXG4gIFwicHJvcG9zYWwuZGlzbWlzc1wiLFxuICBcImNvbnRleHQuY2FwdHVyZVwiLFxuICBcIm1hcmtzLmNvbW1pdFwiLFxuICBcInN1Ym1pdFwiLFxuICBcImNsb3NlZFwiLFxuXSBhcyBjb25zdCk7XG5leHBvcnQgdHlwZSBBZ2VudEV2ZW50VHlwZSA9ICh0eXBlb2YgQUdFTlRfRVZFTlRfVFlQRVMpW251bWJlcl07XG5cbi8vIFR5cGVkIHBheWxvYWRzIGZvciB0aGUgZXZlbnRzIHRoYXQgY2FycnkgZGF0YSDigJQgc28gdGhlIGFnZW50IGlzbid0IGd1ZXNzaW5nXG4vLyBzaGFwZXMgYW5kIHRoZSBzZXJ2ZXIncyBlbWl0IGNhbGxzIGFyZSBjaGVja2VkLiBFdmVudHMgbm90IGxpc3RlZCBjYXJyeSBub1xuLy8gcGF5bG9hZC5cbmV4cG9ydCB0eXBlIEFnZW50RXZlbnRQYXlsb2FkID0ge1xuICAvLyBhIGNoYXQgbWVzc2FnZS4gSXQgY2FycmllcyB0aGUgQU1CSUVOVCBCT0FSRCBDT05URVhUIHNvIHRoZSBhZ2VudCBkb2Vzbid0IG5lZWRcbiAgLy8gdGhlIChub3ctcmVtb3ZlZCkgZm9jdXMuc2V0L3JlZi5zZWxlY3QgcGluZ3M6IGBmb2N1c2AgaXMgdGhlIGltYWdlIG9uIHRoZVxuICAvLyBjYW52YXMgd2hlbiB0aGUgdXNlciBzZW50IChudWxsID0gYmxhbmsgZnJhbWUpLCBgc2VsZWN0ZWRSZWZJZHNgIHRoZSByZWZzIHRoZVxuICAvLyB1c2VyIHBvaW50ZWQgYXQgZm9yIHRoaXMgdHVybi4gSWYgdGhlIGZvY3VzZWQgaW1hZ2UgaGFkIHVuc2VlbiBtYXJrcywgdGhlXG4gIC8vIG1hcmtlZCBpbWFnZSAoZmxhdHRlbmVkSW1hZ2VQYXRoLCAtLXJlZiBpdCkgKyB0aGUgbWFyayBnZW9tZXRyeSByaWRlIGFsb25nIHRvby5cbiAgc2F5OiB7XG4gICAgdGV4dDogc3RyaW5nO1xuICAgIGZvY3VzOiBGb2N1cyB8IG51bGw7XG4gICAgc2VsZWN0ZWRSZWZJZHM6IHN0cmluZ1tdO1xuICAgIGZsYXR0ZW5lZEltYWdlUGF0aD86IHN0cmluZztcbiAgICBtYXJrcz86IE1hcmtbXTtcbiAgfTtcbiAgLy8g4pqgIGBwcm9wb3NhbElkYCwgTk9UIGBpZGA6IGV2ZXJ5IGZyYW1lIG9uIHRoZSB0YWlsIGNhcnJpZXMgdGhlIGV2ZW50IGxvZydzXG4gIC8vIG1vbm90b25pYyBgaWRgIGFzIGl0cyBjdXJzb3IsIHNvIGEgcGF5bG9hZCBmaWVsZCBuYW1lZCBgaWRgIGNvbGxpZGVzIHdpdGhcbiAgLy8gaXQuIEl0IHVzZWQgdG8sIGFuZCB0aGUgY3Vyc29yIGxvc3Qg4oCUIHRoZXNlIGZyYW1lcyB3ZW50IG91dCB3aXRoIGFcbiAgLy8gcHJvcG9zYWwncyBpZCB3aGVyZSBhIG51bWJlciBiZWxvbmdzLCB3aGljaCBtYWRlIGBldi5pZCA+IHNpbmNlYCBmYWxzZSBhbmRcbiAgLy8gbWVhbnQgbmVpdGhlciB3YXMgZXZlciByZXBsYXllZC4gVGhlIG5hbWVzIGFyZSBub3cgZGlzam9pbnQgYnlcbiAgLy8gY29uc3RydWN0aW9uLCBhbmQgdGhlIGZyYW1lIGNhcnJpZXMgYm90aC5cbiAgXCJwcm9wb3NhbC5zZW5kXCI6IHsgcHJvcG9zYWxJZDogc3RyaW5nIH07XG4gIFwicHJvcG9zYWwuZGlzbWlzc1wiOiB7IHByb3Bvc2FsSWQ6IHN0cmluZyB9O1xuICAvLyBcImV4dHJhY3QgdGhpcyBpbWFnZSdzIGxvb2tcIiDigJQgY2FycmllcyB0aGUgZm9jdXNlZCB2YXJpYW50IHNvIHRoZSBhZ2VudCBrbm93c1xuICAvLyB3aGljaCBpbWFnZSB0byByZWFkIChmb2N1cy5zZXQgbm8gbG9uZ2VyIG5vdGlmaWVzKS5cbiAgXCJjb250ZXh0LmNhcHR1cmVcIjogeyBmb2N1czogRm9jdXMgfCBudWxsIH07XG4gIFwibWFya3MuY29tbWl0XCI6IHtcbiAgICB0ZXh0OiBzdHJpbmc7XG4gICAgYmF0Y2hJZDogc3RyaW5nO1xuICAgIHZhcmlhbnRJZDogc3RyaW5nO1xuICAgIG1hcmtzOiBNYXJrW107XG4gICAgc2VsZWN0ZWRSZWZJZHM6IHN0cmluZ1tdOyAvLyByZWZzIHRoZSB1c2VyIHBvaW50ZWQgYXQgKGFtYmllbnQgYm9hcmQgY29udGV4dClcbiAgICAvLyBvbi1kaXNrIFBORyBwYXRoIG9mIHRoZSBpbWFnZSB3aXRoIG1hcmtzIGJ1cm5lZCBpbiAodGhlIHZpc3VhbCBoYW5kb2ZmIOKAlFxuICAgIC8vIHBhc3MgYXMgLS1yZWYpLiBBYnNlbnQgaWYgY2FwdHVyZSBmYWlsZWQ7IGZhbGwgYmFjayB0byB0aGUgdmFyaWFudCBwYXRoLlxuICAgIGZsYXR0ZW5lZEltYWdlUGF0aD86IHN0cmluZztcbiAgfTtcbn07XG5cbmNvbnN0IERFRkFVTFRfU1RZTEVfTkFNRVMgPSBbXCJhbmltZVwiLCBcInBhaW50ZXJseVwiLCBcInBob3RvcmVhbFwiLCBcIjNkXCIsIFwid2F0ZXJjb2xvclwiLCBcImxpbmUgYXJ0XCJdO1xuLy8gZGV0ZXJtaW5pc3RpYywgcmVwcm9kdWNpYmxlIGlkIHNvIHNlZWRpbmcvcmVzdG9yZSBkb24ndCBjaHVybiBpZHNcbmV4cG9ydCBjb25zdCBzdHlsZUlkID0gKG5hbWU6IHN0cmluZykgPT4gYHN0eWxlLSR7bmFtZS50cmltKCkudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9cXHMrL2csIFwiLVwiKX1gO1xuXG5jb25zdCBERUZBVUxUX1BST01QVFM6IENvbnRleHRFbnRyeVtdID0gW1xuICB7XG4gICAgaWQ6IFwiZGVzY3JpYmVcIixcbiAgICBraW5kOiBcInByb21wdFwiLFxuICAgIG5hbWU6IFwiZGVzY3JpYmVcIixcbiAgICBjb250ZW50OiBcIkRlc2NyaWJlIHRoaXMgaW1hZ2UgaW4gZGV0YWlsIOKAlCBsaXRlcmFsbHkgd2hhdCBpcyBpbiBpdC5cIixcbiAgfSxcbiAge1xuICAgIGlkOiBcInBhbGV0dGVcIixcbiAgICBraW5kOiBcInByb21wdFwiLFxuICAgIG5hbWU6IFwicGFsZXR0ZVwiLFxuICAgIGNvbnRlbnQ6IFwiQnJlYWsgZG93biB0aGUgY29sb3IgcGFsZXR0ZSDigJQgdGhlIGtleSBjb2xvcnMgYW5kIGhvdyB0aGV5IHdvcmsgdG9nZXRoZXIuXCIsXG4gIH0sXG4gIHtcbiAgICBpZDogXCJsaWdodGluZ1wiLFxuICAgIGtpbmQ6IFwicHJvbXB0XCIsXG4gICAgbmFtZTogXCJsaWdodGluZ1wiLFxuICAgIGNvbnRlbnQ6IFwiRGVzY3JpYmUgdGhlIGxpZ2h0aW5nIOKAlCBkaXJlY3Rpb24sIHF1YWxpdHksIG1vb2Qg4oCUIHNvIEkgY2FuIHJldXNlIGl0LlwiLFxuICB9LFxuXTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRlZmF1bHRTdGF0ZSh0aXRsZTogc3RyaW5nKTogSW1hZ29TdGF0ZSB7XG4gIHJldHVybiB7XG4gICAgdGl0bGUsXG4gICAgYmF0Y2hlczogW10sXG4gICAgZm9jdXM6IG51bGwsXG4gICAgY29udmVyc2F0aW9uOiBbXSxcbiAgICBsaWJyYXJ5OiBbXG4gICAgICAuLi5ERUZBVUxUX1BST01QVFMubWFwKChwKSA9PiAoeyAuLi5wIH0pKSxcbiAgICAgIC4uLkRFRkFVTFRfU1RZTEVfTkFNRVMubWFwKChuYW1lKSA9PiAoe1xuICAgICAgICBpZDogc3R5bGVJZChuYW1lKSxcbiAgICAgICAga2luZDogXCJzdHlsZVwiIGFzIGNvbnN0LFxuICAgICAgICBuYW1lLFxuICAgICAgICBjb250ZW50OiBcIlwiLFxuICAgICAgfSkpLFxuICAgIF0sXG4gICAgYWN0aXZlQ29udGV4dElkczogW10sXG4gICAgcXVpY2tQcm9tcHRJZHM6IERFRkFVTFRfUFJPTVBUUy5tYXAoKHApID0+IHAuaWQpLFxuICAgIHBpbnM6IFtdLFxuICAgIG1hcmtzQnlWYXJpYW50OiB7fSxcbiAgICBsYXllcnNCeVZhcmlhbnQ6IHt9LFxuICAgIGFuYWx5c2lzQ2FjaGU6IHt9LFxuICAgIGFzcGVjdDogXCIxOjFcIixcbiAgICBzaXplOiBcIjFLXCIsXG4gICAgc3RhdHVzOiB7IGJ1c3k6IGZhbHNlLCB0ZXh0OiBcIlwiIH0sXG4gICAgY29zdDogXCJcIixcbiAgICBoYW5kb2ZmOiBcIlwiLFxuICAgIGhpc3Rvcnk6IHsgY2FuVW5kbzogZmFsc2UsIGNhblJlZG86IGZhbHNlIH0sXG4gICAgbWFya3NVbnNlZW46IGZhbHNlLFxuICB9O1xufVxuIiwKICAgICIvKipcbiAqIFRoZSB0d28gcHJpbWl0aXZlcyB1bmRlciBCT1RIIG9mIHRoZSBob3VzZSdzIGRhZW1vbi1kaXNjb3ZlcnkgY29udmVudGlvbnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBEMyBydWxlZCB0aGF0IHRoZSBjb252ZW50aW9ucyB0aGVtc2VsdmVzIOKAlCBwZXItc2Vzc2lvbiB0bXBkaXIgSlNPTiAoYm91bnR5LFxuICogZ2xhbW91ciwgaW1hZ28sIG1hZ3BpZSkgYW5kIHNpbmdsZXRvbiBgJEhPTUUvZGFlbW9uLnBvcnRgICsgYGRhZW1vbi5waWRgXG4gKiAoYXN0cm9sYWJlLCBncmFwZXZpbmUsIG1pbmQtbWFwcGVyKSDigJQgYm90aCBzdXJ2aXZlLCBiZWNhdXNlIHRoZXkgZW5jb2RlXG4gKiBnZW51aW5lbHkgZGlmZmVyZW50IG1vZGVscyAoY29uY3VycmVudCBzZXNzaW9ucyB2cyBhIHN0YW5kaW5nIHNpbmdsZXRvbikgYW5kXG4gKiBwaWNraW5nIG9uZSBpcyBhIHByb2R1Y3QgZGVjaXNpb24sIG5vdCBhIGZhY3RvcmluZyBvbmUuIFdoYXQgSVMgb25lXG4gKiBpbXBsZW1lbnRhdGlvbiBpcyB0aGUgcGFpciBiZWxvdywgd2hpY2ggaXMgYWxzbyBleGFjdGx5IHdoZXJlIGNlbnN1cyBkZWZlY3RcbiAqICoqTDMqKiBsaXZlcy5cbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMsIHJlbmFtZVN5bmMsIHJtU3luYywgdW5saW5rU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5cbi8qKlxuICogV3JpdGUgYHRleHRgIHRvIGB0YXJnZXRgIGF0b21pY2FsbHk6IHdyaXRlIGJlc2lkZSBpdCwgdGhlbiByZW5hbWUuXG4gKlxuICog4puUICoqTDMsIENMT1NFRCBCWSBDT05TVFJVQ1RJT04uKiogQSBiYXJlIGB3cml0ZUZpbGVTeW5jYCBpcyBub3QgYXRvbWljLCBzbyBhXG4gKiBDTEkgcmVhZGluZyB3aGlsZSB0aGUgZGFlbW9uIHdyaXRlcyBjYW4gb2JzZXJ2ZSBhIEhBTEYtV1JJVFRFTiBwb2ludGVyLiBVbmRlclxuICogYSBiZXN0LWVmZm9ydCByZWFkZXIgdGhhdCBzdXJmYWNlZCBhcyBcIm5vIHJ1bm5pbmcgc2Vzc2lvblwiIOKAlCBhYnNlbmNlIHJlcG9ydGVkXG4gKiBmb3Igd2hhdCB3YXMgcmVhbGx5IGEgdG9ybiByZWFkLCB3aGljaCBpcyB0aGUgZXhhY3QgY29uZmxhdGlvbiB0aGUgaG91c2Unc1xuICogYG51bGxgLW5vdC1gMGAgcnVsZSBleGlzdHMgdG8gcHJldmVudC4gUmVuYW1lIHdpdGhpbiBvbmUgZGlyZWN0b3J5IGlzIGF0b21pYyxcbiAqIHNvIGEgcmVhZGVyIHNlZXMgZWl0aGVyIHRoZSBwcmV2aW91cyBwb2ludGVyIG9yIHRoZSBuZXcgb25lLCBuZXZlciBhIHBhcnRpYWxcbiAqIGZpbGUuXG4gKlxuICogRml4ZWQgaW4gZ2xhbW91ciAyMDI2LTA5LTA3LCBmb3VuZCBzdGFuZGluZyBpbiB0aHJlZSBzaWJsaW5ncyB0aGUgbmV4dCBkYXkgYnlcbiAqIHRoZSBkdXBsaWNhdGlvbiByZWNvbiwgYW5kIHJlcGFpcmVkIGluIGFsbCBvZiB0aGVtIHRoZSBvbmx5IHdheSB0aGF0IGRvZXMgbm90XG4gKiBuZWVkIGZpbmRpbmcgYWdhaW46IHRoZXJlIGlzIG5vdyBvbmUgaW1wbGVtZW50YXRpb24uXG4gKlxuICog4pqgIFRoZSB0ZW1wIG5hbWUgY2FycmllcyB0aGUgcGlkLCBzbyB0d28gZGFlbW9ucyByYWNpbmcgdG8gcHVibGlzaCB0aGUgc2FtZVxuICogcG9pbnRlciBjYW5ub3QgY2xvYmJlciBlYWNoIG90aGVyJ3MgaW50ZXJtZWRpYXRlIGZpbGUg4oCUIGFuZCBpdCBpcyByZW1vdmVkIG9uXG4gKiBhIGZhaWxlZCB3cml0ZSByYXRoZXIgdGhhbiBsZWZ0IGFzIGxpdHRlciBiZXNpZGUgdGhlIHJlYWwgb25lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd3JpdGVGaWxlQXRvbWljKHRhcmdldDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgdG1wID0gYCR7dGFyZ2V0fS4ke3Byb2Nlc3MucGlkfS50bXBgO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmModG1wLCB0ZXh0KTtcbiAgICByZW5hbWVTeW5jKHRtcCwgdGFyZ2V0KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgdHJ5IHtcbiAgICAgIHJtU3luYyh0bXAsIHsgZm9yY2U6IHRydWUgfSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiB0aGUgdGVtcCBmaWxlIGlzIGFscmVhZHkgZ29uZSwgb3Igd2FzIG5ldmVyIGNyZWF0ZWQgKi9cbiAgICB9XG4gICAgdGhyb3cgZXJyO1xuICB9XG59XG5cbi8qKlxuICogRGVsZXRlIGBwYXRoYCBpZmYgaXQgc3RpbGwgbmFtZXMgVVMuIFJldHVybnMgd2hldGhlciBpdCB3YXMgZGVsZXRlZC5cbiAqXG4gKiDim5QgKipcIlNUSUxMIE9VUlNcIiBJUyBUSEUgV0hPTEUgRlVOQ1RJT04uKiogQSBkYWVtb24gdGhhdCB1bmxpbmtzIGl0cyBkaXNjb3ZlcnlcbiAqIGZpbGUgdW5jb25kaXRpb25hbGx5IGF0IGV4aXQgZGVsZXRlcyB0aGUgcG9pbnRlciBhIFNVQ0NFU1NPUiBoYXMgYWxyZWFkeVxuICogd3JpdHRlbiDigJQgdGhlIHN1Y2Nlc3NvciBjYW4gdGhlbiBubyBsb25nZXIgYmUgZm91bmQgYW5kIHRoZSBuZXh0IENMSSB2ZXJiIHNwYXducyBhXG4gKiB0aGlyZCBkYWVtb24uIEJvdGggY29udmVudGlvbnMgaGF2ZSB0aGlzIGhhemFyZCBhbmQgYm90aCBleHByZXNzIGl0XG4gKiBkaWZmZXJlbnRseTogYXN0cm9sYWJlIGNvbXBhcmVzIHRoZSBwaWQgZmlsZSdzIGJ5dGVzIHRvIGl0cyBvd24gcGlkLFxuICogbWFncGllIHBhcnNlcyB0aGUgSlNPTiBwb2ludGVyIGFuZCBjb21wYXJlcyBgc2Vzc2lvbl9pZGAuIGBpZGVudGlmeWAgaXMgd2hhdFxuICogbWFrZXMgdGhvc2Ugb25lIGZ1bmN0aW9uIOKAlCBpdCB0dXJucyB0aGUgZmlsZSdzIGJ5dGVzIGludG8gdGhlIGlkZW50aXR5IHRvXG4gKiBjb21wYXJlLCBhbmQgaXQgZGVmYXVsdHMgdG8gdGhlIHRyaW1tZWQgYnl0ZXMgdGhlbXNlbHZlcy5cbiAqXG4gKiDimqAgRXZlcnkgZmFpbHVyZSBpcyBzd2FsbG93ZWQgYW5kIHJlcG9ydGVkIGFzIGBmYWxzZWA6IHRoZSBmaWxlIGJlaW5nIGdvbmUsXG4gKiB1bnJlYWRhYmxlLCBvciB1bnBhcnNlYWJsZSBhbGwgbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlIOKAlCBpdCBpcyBub3Qgb3VycyB0b1xuICogcmVtb3ZlLiBBbiB1bnBhcnNlYWJsZSBwb2ludGVyIGlzIGRlbGliZXJhdGVseSBOT1QgdHJlYXRlZCBhcyBvdXJzLCB3aGljaCBpc1xuICogdGhlIGNvbnNlcnZhdGl2ZSBoYWxmIG9mIHRoZSBzYW1lIGBudWxsYC1ub3QtYDBgIHJ1bGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1bmxpbmtJZk1hdGNoZXMoXG4gIHBhdGg6IHN0cmluZyxcbiAgZXhwZWN0ZWQ6IHN0cmluZyxcbiAgaWRlbnRpZnk6IChyYXc6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbCA9IChyYXcpID0+IHJhdy50cmltKCksXG4pOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoaWRlbnRpZnkocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSkgIT09IGV4cGVjdGVkKSByZXR1cm4gZmFsc2U7XG4gICAgdW5saW5rU3luYyhwYXRoKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGluLXByb2Nlc3MgZXZlbnQgbG9nIOKAlCB0aGUgYXBwZW5kLW9ubHksIHJlcGxheWFibGUgYnVmZmVyXG4gKiBiZWhpbmQgZXZlcnkgc3BlbGwncyBgR0VUIC9ldmVudHNgIFNTRSB0YWlsLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIG1pbmQtbWFwcGVyJ3NcbiAqIGBzY3JpcHRzL2V2ZW50cy50c2Ag4oCUIHRoZSBjZW5zdXMncyBjb252ZXJnZW5jZSB0YXJnZXQgIzIsIGFuZCB0aGUgb25seSBvbmUgb2ZcbiAqIHRoZSBzaXggY29waWVkLWluLXBsYWNlIGJ1c2VzIHRoYXQgaXMgYSBtb2R1bGUsIGlzIGJvdW5kZWQsIGNhcnJpZXMgYW4gZXBvY2gsIGFuZCBpc1xuICogdW5pdC10ZXN0ZWQuIFRoZSBmaXZlIG90aGVycyBhcmUgdGhlIHNhbWUgdHdlbnR5IGxpbmVzIHdyaXR0ZW4gZml2ZSB0aW1lcy5cbiAqXG4gKiDilIDilIAgVEhFIFRIUkVFIFRISU5HUyBUSElTIEZJWEVTIEJZIENPTlNUUlVDVElPTiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKjEgwrcgTDUg4oCUIHRoZSBidWZmZXIgaXMgYm91bmRlZC4qKiBGaXZlIGRhZW1vbnMgYXBwZW5kIHRvIGFuIGFycmF5IGZvciB0aGVcbiAqIHdob2xlIGxpZmUgb2YgdGhlIHByb2Nlc3MuIFRoZSB3aW5kb3cgaXMgYSBSRVBMQVkgd2luZG93IGZvciByZWNvbm5lY3RzIHdpdGhpbiBvbmVcbiAqIGRhZW1vbidzIGxpZmV0aW1lLCBub3QgYSBkdXJhYmxlIGxvZzsgYSBjYXAgaXMgdGhlIGhvbmVzdCBzaGFwZS5cbiAqXG4gKiAqKjIgwrcgTDYg4oCUIGEgZnJhbWUgY2FycmllcyBhbiBlcG9jaCwgd2hlbiB0aGUgY2FsbGVyIGFza3MgZm9yIG9uZS4qKiBBZnRlciBhXG4gKiByZXN0YXJ0IHRoZSBpZHMgc3RhcnQgYWdhaW4gYXQgMSwgc28gYSByZXN1bWluZyBjbGllbnQgY2Fubm90IHRlbGwgYSBzdGFsZVxuICogd2F0ZXJtYXJrIGZyb20gYSBmcmVzaCBvbmUgYnkgaWQgYWxvbmUuXG4gKlxuICogKiozIMK3IEEgU1RBTEUgV0FURVJNQVJLIFJFUExBWVMgRlJPTSBUSEUgQkVHSU5OSU5HLCBhbmQgdGhpcyBpcyB0aGUgaGFsZiB0aGVcbiAqIGNsaWVudCBjYW5ub3QgZG8uKiogTUVBU1VSRUQgb24gYXN0cm9sYWJlOiBhIHRhaWwgdGhhdCByZXN1bWVzIGF0XG4gKiBgc2luY2U9PGxhc3QgaWQgb2YgdGhlIHByZXZpb3VzIGRhZW1vbj5gIGFnYWluc3QgYSByZXN0YXJ0ZWQgZGFlbW9uIHJlY2VpdmVzXG4gKiBOT1RISU5HIOKAlCB0aGUgbmV3IGRhZW1vbidzIGByZWFkeWAgaXMgaWQgMSwgd2hpY2ggaXMgbm90IGA+IHNpbmNlYCwgc28gdGhlXG4gKiBmaWx0ZXIgZHJvcHMgaXQsIHNvIG5vIGZyYW1lIGFycml2ZXMsIHNvIHRoZSBjbGllbnQncyBlcG9jaCBjaGVjayBuZXZlciBydW5zXG4gKiBhbmQgdGhlIHRhaWwgc2l0cyBjb25uZWN0ZWQgYW5kIHNpbGVudCB1bnRpbCB0aGUgbmV3IGRhZW1vbiBoYXMgZW1pdHRlZCBhc1xuICogbWFueSBldmVudHMgYXMgdGhlIG9sZCBvbmUgZGlkLiBTdGFtcGluZyBhbiBlcG9jaCBhbG9uZSBkb2VzIE5PVCBjbG9zZSB0aGF0XG4gKiBnYXA6IHRoZSBlcG9jaCByaWRlcyBhIGZyYW1lLCBhbmQgdGhlIGJ1ZyBpcyB0aGF0IG5vIGZyYW1lIGlzIHNlbnQuIFNvXG4gKiBgc3Vic2NyaWJlYCB0cmVhdHMgYHNpbmNlID4gY3Vyc29yYCBhcyBcInRoaXMgY3Vyc29yIGlzIGZyb20gYW5vdGhlciBwcm9jZXNzXCJcbiAqIGFuZCByZXBsYXlzIHdob2xlLiBgbWluZC1tYXBwZXIvc2NyaXB0cy90YWlsLnRlc3QudHNgJ3MgZXBvY2ggY2VsbCBpcyB0aGVcbiAqIGV4ZWN1dGFibGUgc3BlYyBvZiB0aGUgY2xpZW50IGhhbGYgYW5kIHNob3dzIHRoZSByZWNvbm5lY3Qgc3RpbGwgY2FycnlpbmcgdGhlXG4gKiBzdGFsZSBjdXJzb3Ig4oCUIGRldGVjdGlvbiBoYXBwZW5zIG9uIHdoYXQgaXMgUkVDRUlWRUQuXG4gKi9cblxuLyoqIFRoZSBkZWZhdWx0IHJlcGxheSB3aW5kb3csIGluaGVyaXRlZCBmcm9tIG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgY2FwLiAqL1xuZXhwb3J0IGNvbnN0IFJFUExBWV9CVUZGRVJfU0laRSA9IDEwMDA7XG5cbi8qKiBBIGZyYW1lIGFzIGl0IGdvZXMgb24gdGhlIHdpcmU6IHRoZSBjYWxsZXIncyBwYXlsb2FkIHBsdXMgYSBtb25vdG9uaWMgYGlkYCxcbiAqICBwbHVzIGFuIGBlcG9jaGAgd2hlbiB0aGUgbG9nIHdhcyBnaXZlbiBvbmUuICovXG5leHBvcnQgdHlwZSBGcmFtZTxUPiA9IFQgJiB7IGlkOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH07XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRMb2c8VD4ge1xuICAvKiogQXBwZW5kIG9uZSBmcmFtZSwgZmFuIGl0IG91dCB0byBsaXZlIHN1YnNjcmliZXJzLCBhbmQgcmV0dXJuIGl0LiAqL1xuICBlbWl0KG1zZzogVCk6IEZyYW1lPFQ+O1xuICAvKipcbiAgICogUmVwbGF5IGV2ZXJ5dGhpbmcgYWZ0ZXIgYHNpbmNlYCwgdGhlbiBzdGF5IHN1YnNjcmliZWQuIFJldHVybnMgYW5cbiAgICogdW5zdWJzY3JpYmUgZnVuY3Rpb24uXG4gICAqXG4gICAqIOKblCBSRVBMQVkgQU5EIFNVQlNDUklCRSBBUkUgT05FIENBTEwgT04gUFVSUE9TRS4gRG9pbmcgdGhlbSBpbiB0d28gc3RlcHNcbiAgICogbGVhdmVzIGEgd2luZG93IGluIHdoaWNoIGFuIGVtaXQgbGFuZHMgYmV0d2VlbiB0aGUgcmVwbGF5IGxvb3AgYW5kIHRoZVxuICAgKiBgYWRkYCwgYW5kIHRoYXQgZnJhbWUgaXMgZGVsaXZlcmVkIHRvIG5vYm9keSDigJQgdGhlIHNoYXBlIGZpdmUgZGFlbW9ucyBoYXZlLFxuICAgKiBzdXJ2aXZlZCBieSBub3RoaW5nIGJ1dCB0aGUgc2luZ2xlLXRocmVhZGVkIGV2ZW50IGxvb3AgaGFwcGVuaW5nIHRvIGNsb3NlXG4gICAqIGl0LiBEZXBlbmRpbmcgb24gdGhhdCBpcyBkZXBlbmRpbmcgb24gYW4gaW1wbGVtZW50YXRpb24gZGV0YWlsIG9mIHRoZVxuICAgKiBydW50aW1lIHJhdGhlciB0aGFuIG9uIHRoZSBjb2RlLlxuICAgKi9cbiAgc3Vic2NyaWJlKHNpbmNlOiBudW1iZXIsIGxpc3RlbmVyOiAoZnJhbWU6IEZyYW1lPFQ+KSA9PiB2b2lkKTogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBoaWdoZXN0IGlkIGVtaXR0ZWQgc28gZmFyIOKAlCB3aGF0IGBHRVQgL3N0YXRlYCByZXR1cm5zIGFzIGBjdXJzb3JgLiAqL1xuICBjdXJzb3IoKTogbnVtYmVyO1xuICAvKiogVGhlIGVwb2NoIHN0YW1wZWQgb24gZXZlcnkgZnJhbWUsIG9yIGB1bmRlZmluZWRgIGlmIG5vbmUgd2FzIGNvbmZpZ3VyZWQuICovXG4gIHJlYWRvbmx5IGVwb2NoOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVFdmVudExvZzxUIGV4dGVuZHMgb2JqZWN0PihcbiAgb3B0czogeyBlcG9jaD86IHN0cmluZzsgYnVmZmVyU2l6ZT86IG51bWJlciB9ID0ge30sXG4pOiBFdmVudExvZzxUPiB7XG4gIGNvbnN0IGJ1ZmZlclNpemUgPSBvcHRzLmJ1ZmZlclNpemUgPz8gUkVQTEFZX0JVRkZFUl9TSVpFO1xuICBjb25zdCBlcG9jaCA9IG9wdHMuZXBvY2g7XG4gIGNvbnN0IGJ1ZmZlcjogQXJyYXk8RnJhbWU8VD4+ID0gW107XG4gIGNvbnN0IGxpc3RlbmVycyA9IG5ldyBTZXQ8KGZyYW1lOiBGcmFtZTxUPikgPT4gdm9pZD4oKTtcbiAgbGV0IHNlcSA9IDA7XG5cbiAgcmV0dXJuIHtcbiAgICBlcG9jaCxcblxuICAgIGVtaXQobXNnKSB7XG4gICAgICBzZXEgKz0gMTtcbiAgICAgIC8vIOKblCBUSEUgTU9OT1RPTklDIElEIFdJTlMgT1ZFUiBBTllUSElORyBJTiBUSEUgUEFZTE9BRCwgQU5EIFVOVElMIE5PVyBJVFxuICAgICAgLy8gT05MWSBDTEFJTUVEIFRPLiBCb3RoIGFkb3B0aW5nIGRhZW1vbnMgd3JvdGUgYHsgaWQ6ICsrc2VxLCAuLi5tc2cgfWBcbiAgICAgIC8vIHVuZGVyIGEgY29tbWVudCBzYXlpbmcgXCJ0aGUgbW9ub3RvbmljIGBpZGAgTVVTVCB3aW4gb3ZlciBhbnkgYGlkYCBpblxuICAgICAgLy8gdGhlIHBheWxvYWQsIHNvIGNhbGxlcnMgY2FycnkgYSBwcm9qZWN0IGlkZW50aWZpZXIgYXMgYHByb2plY3RJZGAsXG4gICAgICAvLyBuZXZlciBgaWRgXCIg4oCUIGJ1dCBzcHJlYWQgb3JkZXIgbWVhbnMgYSBwYXlsb2FkIGBpZGAgb3ZlcnJvZGUgdGhlXG4gICAgICAvLyBjdXJzb3IsIHNpbGVudGx5LCBhbmQgdGhlIGNvbnZlbnRpb24gaW4gdGhlIGNvbW1lbnQgd2FzIHRoZSBvbmx5IHRoaW5nXG4gICAgICAvLyBob2xkaW5nIGl0LiBUaGUgbGl0ZXJhbCBrZWVwcyBgaWRgIEZJUlNUIHNvIHRoZSB3aXJlIGtleSBvcmRlciBpc1xuICAgICAgLy8gdW5jaGFuZ2VkOyB0aGUgYXNzaWdubWVudCBhZnRlciB0aGUgc3ByZWFkIGlzIHdoYXQgbWFrZXMgdGhlIHNlbnRlbmNlXG4gICAgICAvLyB0cnVlLiBgZXBvY2hgIGlzIHN0YW1wZWQgdGhlIHNhbWUgd2F5IGFuZCBmb3IgdGhlIHNhbWUgcmVhc29uLlxuICAgICAgY29uc3QgZnJhbWUgPSB7IGlkOiBzZXEsIC4uLm1zZyB9IGFzIEZyYW1lPFQ+O1xuICAgICAgZnJhbWUuaWQgPSBzZXE7XG4gICAgICBpZiAoZXBvY2ggIT09IHVuZGVmaW5lZCkgZnJhbWUuZXBvY2ggPSBlcG9jaDtcblxuICAgICAgYnVmZmVyLnB1c2goZnJhbWUpO1xuICAgICAgaWYgKGJ1ZmZlci5sZW5ndGggPiBidWZmZXJTaXplKSBidWZmZXIuc2hpZnQoKTtcbiAgICAgIGZvciAoY29uc3QgbGlzdGVuZXIgb2YgbGlzdGVuZXJzKSBsaXN0ZW5lcihmcmFtZSk7XG4gICAgICByZXR1cm4gZnJhbWU7XG4gICAgfSxcblxuICAgIHN1YnNjcmliZShzaW5jZSwgbGlzdGVuZXIpIHtcbiAgICAgIC8vIFNlZSB0aGUgaGVhZGVyLCBwb2ludCAzOiBhIGN1cnNvciBiZXlvbmQgb3VyIG93biBpcyBhIGN1cnNvciBmcm9tIGFcbiAgICAgIC8vIFBSSU9SIFBST0NFU1MsIGFuZCB0aGUgb25seSB1c2VmdWwgcmVhZGluZyBvZiBpdCBpcyBcInJlcGxheSB3aG9sZVwiLlxuICAgICAgLy9cbiAgICAgIC8vIOKaoCBBIE5PTi1GSU5JVEUgQ1VSU09SIEFMU08gTUVBTlMgXCJGUk9NIFRIRSBTVEFSVFwiLCB3aGljaCB0aGUgY29waWVzIGdvdFxuICAgICAgLy8gd3JvbmcgYnkgYWNjaWRlbnQ6IHRoZXkgd3JvdGUgYHBhcnNlSW50KHBhcmFtID8/IFwiLTFcIilgIGFuZCBjb21wYXJlZFxuICAgICAgLy8gYGlkID4gc2luY2VgLCBzbyBhIHR5cG8nZCBgP3NpbmNlPXhgIHByb2R1Y2VkIGBOYU5gLCBldmVyeSBjb21wYXJpc29uXG4gICAgICAvLyB3YXMgZmFsc2UsIGFuZCB0aGUgdGFpbCBvcGVuZWQgRU1QVFkgYW5kIHN0YXllZCBjb25uZWN0ZWQg4oCUIHRoZSBzYW1lXG4gICAgICAvLyBzaWxlbnQtYW5kLWNvbm5lY3RlZCBzeW1wdG9tIGFzIHRoZSBzdGFsZSB3YXRlcm1hcmssIGZyb20gYSBkaWZmZXJlbnRcbiAgICAgIC8vIGNhdXNlLiBBYnNlbnQgYW5kIHVucGFyc2VhYmxlIGFyZSB0aGUgc2FtZSByZXF1ZXN0IGhlcmUuXG4gICAgICBjb25zdCBmcm9tID0gIU51bWJlci5pc0Zpbml0ZShzaW5jZSkgfHwgc2luY2UgPiBzZXEgPyAtMSA6IHNpbmNlO1xuICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBidWZmZXIpIHtcbiAgICAgICAgaWYgKGZyYW1lLmlkID4gZnJvbSkgbGlzdGVuZXIoZnJhbWUpO1xuICAgICAgfVxuICAgICAgbGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG4gICAgICByZXR1cm4gKCkgPT4ge1xuICAgICAgICBsaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcbiAgICAgIH07XG4gICAgfSxcblxuICAgIGN1cnNvcigpIHtcbiAgICAgIHJldHVybiBzZXE7XG4gICAgfSxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgZGFlbW9uIGxpZmVjeWNsZSB0YWlsOiB0aGUgaWRsZS1jbG9zZSBkZWNpc2lvbiwgdGhlIHN3ZWVwXG4gKiB0aGF0IG1ha2VzIGl0LCBhbmQgdGhlIGJvdW5kZWQgdGVhcmRvd24uXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgYm91bnR5IOKAlCB0aGUgY2Vuc3VzJ3NcbiAqIGNvbnZlcmdlbmNlIHRhcmdldCAjMyDigJQgd2l0aCBhc3Ryb2xhYmUncyBgdGltZW91dE1zID4gMGAgZ3VhcmQgZm9sZGVkIGluLFxuICogd2hpY2ggaXMgdGhlIG9uZSB0aGluZyBib3VudHkncyBjb3B5IGRvZXMgbm90IGV4cHJlc3MuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTc2VDbGllbnRzIH0gZnJvbSBcIi4vc3NlLnRzXCI7XG5cbi8qKlxuICogU2hvdWxkIHRoZSBkYWVtb24gaWRsZS1jbG9zZT9cbiAqXG4gKiDim5QgKipgc3Vic2NyaWJlckNvdW50YCBJUyBBIFJFUVVJUkVEIEFSR1VNRU5ULCBBTkQgVEhBVCBJUyBUSEUgV0hPTEUgUE9JTlQuKipcbiAqIFRoaXMgY2xvc2VzIGNlbnN1cyBkZWZlY3QgKipMMSoqIGJ5IGNvbnN0cnVjdGlvbjogZ2xhbW91ciwgaW1hZ28gYW5kIG1hZ3BpZVxuICogY291bnRlZCB0aGVpciBpZGxlIGZsb29yIGRvd24gd2hpbGUgYW4gYWdlbnQgaGVsZCBhIHRhaWwgb3Blbiwgc28gYW4gYWdlbnRcbiAqIHdhdGNoaW5nIGEgcXVpZXQgYm9hcmQgd2FzIGtpbGxlZCBXSVRIIElUUyBDT05ORUNUSU9OIE9QRU4uIFRoZXJlIGlzIG5vXG4gKiBvdmVybG9hZCBvZiB0aGlzIGZ1bmN0aW9uIHRoYXQgY2Fubm90IHNlZSBpdHMgc3Vic2NyaWJlcnMsIHNvIHRoZSBkZWZlY3RcbiAqIGNhbm5vdCBiZSByZS1leHByZXNzZWQgYnkgYSBjYWxsZXIgd2hvIGZvcmdldHMuXG4gKlxuICog4puUICoqQU5EIFRIRSBTQ0FSIElUIENBTUUgV0lUSCwgcmUtaG9tZWQgZnJvbSBib3VudHkgdmVyYmF0aW0gaW4gc3Vic3RhbmNlOioqXG4gKiBhIGJvYXJkIG9ubHkgY291bnRzIGl0cyBpZGxlIGZsb29yIGRvd24gd2hpbGUgVU5XQVRDSEVELiBBIGxpdmUgc3Vic2NyaWJlciDigJRcbiAqIGEgYnJvd3NlciBXZWJTb2NrZXQsIG9yIGFuIGFnZW50IFNTRSB0YWlsIG9uIGAvZXZlbnRzYCDigJQga2VlcHMgaXQgb3BlblxuICogaW5kZWZpbml0ZWx5LiBTbyBgdGltZW91dGAgbWVhbnMgXCJsaW5nZXIgdGhpcyBsb25nIGFmdGVyIHRoZSBMQVNUIHN1YnNjcmliZXJcbiAqIGxlYXZlc1wiLCBOT1QgXCJtYXhpbXVtIGlkbGUgd2hpbGUgY29ubmVjdGVkXCIuIFRoZSBzd2VlcCBiZWxvdyBhbHNvIHRvdWNoZXMgdGhlXG4gKiBhY3Rpdml0eSBjbG9jayBvbiBldmVyeSB0aWNrIHdoaWxlIHdhdGNoZWQsIHNvIG9uY2UgdW53YXRjaGVkIHRoZSBmbG9vclxuICogY291bnRzIGZyb20gdGhhdCBsYXN0IGRpc2Nvbm5lY3QgYW5kIG5vdCBmcm9tIHRoZSBsYXN0IHJlcXVlc3QuXG4gKlxuICog4pqgIGB0aW1lb3V0TXMgPD0gMGAgbWVhbnMgTkVWRVIsIHdoaWNoIGlzIGFzdHJvbGFiZSdzIHN0YW5kaW5nLW9ic2VydmF0b3J5XG4gKiBkZWZhdWx0IGFuZCBpcyB3aHkgdGhlIGd1YXJkIGlzIGhlcmUgcmF0aGVyIHRoYW4gYXQgaXRzIG9uZSBjYWxsIHNpdGU6IGFcbiAqIHNpbmdsZXRvbiBkYWVtb24gaXMgbWVhbnQgdG8gc3RhbmQgdW50aWwgaXQgaXMgZXhwbGljaXRseSBjbG9zZWQsIGFuZCBhXG4gKiBgPj0gMGAgY29tcGFyaXNvbiB3b3VsZCBjbG9zZSBpdCBvbiB0aGUgZmlyc3QgdGljay5cbiAqXG4gKiBDbG9jay1mcmVlIGFuZCBmcy1mcmVlLCBzbyBpdCBpcyB0ZXN0YWJsZSB3aXRob3V0IGEgZGFlbW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkSWRsZUNsb3NlKFxuICBzdWJzY3JpYmVyQ291bnQ6IG51bWJlcixcbiAgaWRsZU1zOiBudW1iZXIsXG4gIHRpbWVvdXRNczogbnVtYmVyLFxuKTogYm9vbGVhbiB7XG4gIGlmICh0aW1lb3V0TXMgPD0gMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoc3Vic2NyaWJlckNvdW50ID4gMCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaWRsZU1zID49IHRpbWVvdXRNcztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBIb3VzZWtlZXBpbmdPcHRpb25zIHtcbiAgLyoqIOKblCBSRVFVSVJFRC4gU2VlIGBzaG91bGRJZGxlQ2xvc2VgIOKAlCB0aGlzIGlzIHdoYXQgY2xvc2VzIEwxLiAqL1xuICBzdWJzY3JpYmVyQ291bnQ6ICgpID0+IG51bWJlcjtcbiAgLyoqIE1pbGxpc2Vjb25kcyBzaW5jZSB0aGUgbGFzdCBhY3Rpdml0eS4gKi9cbiAgaWRsZU1zOiAoKSA9PiBudW1iZXI7XG4gIC8qKiBSZXNldCB0aGUgYWN0aXZpdHkgY2xvY2suIENhbGxlZCBvbiBldmVyeSB0aWNrIHRoYXQgaGFzIGEgc3Vic2NyaWJlci4gKi9cbiAgdG91Y2g6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgY29uZmlndXJlZCBpZGxlIHRpbWVvdXQgaW4gbXM7IGAwYCAob3IgbGVzcykgbWVhbnMgbmV2ZXIuICovXG4gIHRpbWVvdXRNczogbnVtYmVyO1xuICAvKiogRmlyZWQgb25jZSB3aGVuIHRoZSBkYWVtb24gc2hvdWxkIGNsb3NlIGl0c2VsZi4gKi9cbiAgb25JZGxlQ2xvc2U6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgZGVib3VuY2VkIHNuYXBzaG90LCBpZiB0aGUgc3BlbGwgaGFzIG9uZS4gKi9cbiAgc25hcHNob3Q/OiB7XG4gICAgZGlydHk6ICgpID0+IGJvb2xlYW47XG4gICAgY2xlYXI6ICgpID0+IHZvaWQ7XG4gICAgd3JpdGU6ICgpID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+O1xuICB9O1xuICAvKiogU3dlZXAgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDI1MCBtcy4gKi9cbiAgdGlja01zPzogbnVtYmVyO1xuICAvKiogU25hcHNob3QgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDEwMDAgbXMuICovXG4gIHNuYXBzaG90TXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogU3RhcnQgdGhlIHR3byBzdGFuZGluZyB0aW1lcnMgZXZlcnkgc2Vzc2lvbiBkYWVtb24gcnVucyDigJQgdGhlIGlkbGUgc3dlZXAgYW5kXG4gKiB0aGUgZGVib3VuY2VkIHNuYXBzaG90IOKAlCBhbmQgcmV0dXJuIHRoZSBmdW5jdGlvbiB0aGF0IHN0b3BzIGJvdGguXG4gKlxuICogVGhleSBhcmUgT05FIGNhbGwgYmVjYXVzZSB0aGV5IGhhdmUgYWx3YXlzIGJlZW4gb25lIGxpZmV0aW1lOiBldmVyeSBjb3B5XG4gKiBjbGVhcmVkIGJvdGggaW4gdGhlIHNhbWUgdHdvIGxpbmVzIGFmdGVyIGBhd2FpdCBkb25lYCwgYW5kIHRoZSBwYWlyIHRoYXQgZ2V0c1xuICogZm9yZ290dGVuIGlzIHRoZSBwYWlyIHdob3NlIHRpbWVycyBrZWVwIGEgcHJvY2VzcyBhbGl2ZSBhZnRlciB0ZWFyZG93bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0SG91c2VrZWVwaW5nKG9wdHM6IEhvdXNla2VlcGluZ09wdGlvbnMpOiAoKSA9PiB2b2lkIHtcbiAgY29uc3QgdGlja01zID0gb3B0cy50aWNrTXMgPz8gMjUwO1xuICBjb25zdCBzbmFwc2hvdE1zID0gb3B0cy5zbmFwc2hvdE1zID8/IDEwMDA7XG5cbiAgY29uc3QgaWRsZVRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIGNvbnN0IHN1YnNjcmliZXJzID0gb3B0cy5zdWJzY3JpYmVyQ291bnQoKTtcbiAgICBpZiAoc3Vic2NyaWJlcnMgPiAwKSBvcHRzLnRvdWNoKCk7XG4gICAgaWYgKHNob3VsZElkbGVDbG9zZShzdWJzY3JpYmVycywgb3B0cy5pZGxlTXMoKSwgb3B0cy50aW1lb3V0TXMpKSBvcHRzLm9uSWRsZUNsb3NlKCk7XG4gIH0sIHRpY2tNcyk7XG5cbiAgY29uc3Qgc25hcCA9IG9wdHMuc25hcHNob3Q7XG4gIGNvbnN0IHNuYXBUaW1lciA9IHNuYXBcbiAgICA/IHNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgaWYgKCFzbmFwLmRpcnR5KCkpIHJldHVybjtcbiAgICAgICAgc25hcC5jbGVhcigpO1xuICAgICAgICB2b2lkIHNuYXAud3JpdGUoKTtcbiAgICAgIH0sIHNuYXBzaG90TXMpXG4gICAgOiBudWxsO1xuXG4gIHJldHVybiAoKSA9PiB7XG4gICAgY2xlYXJJbnRlcnZhbChpZGxlVGltZXIpO1xuICAgIGlmIChzbmFwVGltZXIgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoc25hcFRpbWVyKTtcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEcmFpbk9wdGlvbnMge1xuICAvKiogVGhlIGJvdW5kIHNlcnZlci4gVHlwZWQgc3RydWN0dXJhbGx5IHNvIHRoZSBraXQgc3RheXMgZnJlZSBvZiBgYnVuYC4gKi9cbiAgc2VydmVyOiB7IHN0b3AoY2xvc2VBY3RpdmVDb25uZWN0aW9ucz86IGJvb2xlYW4pOiB1bmtub3duIH07XG4gIC8qKiBMaXZlIFNTRSB0YWlsczsgZXZlcnkgcmVnaXN0ZXJlZCBjbG9zZXIgaXMgaW52b2tlZC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBMaXZlIFdlYlNvY2tldHMuICovXG4gIHNvY2tldHM/OiBJdGVyYWJsZTx7IGNsb3NlKCk6IHZvaWQgfT47XG4gIC8qKiBIb3cgbG9uZyBxdWV1ZWQgZnJhbWVzIGdldCB0byBmbHVzaCBiZWZvcmUgYW55dGhpbmcgaXMgY2xvc2VkLiAqL1xuICBncmFjZU1zPzogbnVtYmVyO1xuICAvKiogSG93IGxvbmcgdGhlIGdyYWNlZnVsIHN0b3AgZ2V0cyBiZWZvcmUgdGVhcmRvd24gcHJvY2VlZHMgcmVnYXJkbGVzcy4gKi9cbiAgc3RvcE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIENsb3NlIGV2ZXJ5IGhlbGQgY29ubmVjdGlvbiBhbmQgc3RvcCB0aGUgc2VydmVyLCBpbiBib3VuZGVkIHRpbWUuXG4gKlxuICog4puUICoqVEhFIEdSQUNFIFBFUklPRCBJUyBOT1QgUE9MSVRFTkVTUy4qKiBBIGBjbG9zZWRgIGZyYW1lIGVtaXR0ZWQgYW5kIHRoZW5cbiAqIGZvbGxvd2VkIGltbWVkaWF0ZWx5IGJ5IGFuIGFnZ3Jlc3NpdmUgYHNlcnZlci5zdG9wKHRydWUpYCBpcyBhIGZyYW1lIHRoZVxuICogY2xpZW50IG5ldmVyIHNlZXMg4oCUIHRoZSBxdWV1ZSBnb2VzIHdpdGggdGhlIHNvY2tldC4gVGhlIDE1MCBtcyBpcyB3aGF0IHR1cm5zXG4gKiBcInRoZSBkYWVtb24gdG9sZCB5b3Ugd2h5IGl0IGRpZWRcIiBmcm9tIGEgaG9wZSBpbnRvIGFuIG9ic2VydmF0aW9uLCBhbmQgZXZlcnlcbiAqIG9uZSBvZiB0aGUgZWlnaHQgZGFlbW9ucyBjb252ZXJnZWQgb24gdGhhdCBudW1iZXIgaW5kZXBlbmRlbnRseS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNUT1AgSVMgUkFDRUQsIEJFQ0FVU0UgQSBTTE9XIFNPQ0tFVCBNVVNUIE5PVCBCRSBBQkxFIFRPIEhBTkdcbiAqIFRFQVJET1dOLioqIGBzZXJ2ZXIuc3RvcCh0cnVlKWAgYXdhaXRzIGl0cyBjb25uZWN0aW9uczsgb25lIHdlZGdlZCBwZWVyIGlzXG4gKiBlbm91Z2ggdG8gcGFyayBpdCBmb3JldmVyLCB3aGljaCBpcyBob3cgYSAyMy1taW51dGUgaGFuZyBzaGlwcGVkIG9uY2UuXG4gKlxuICog4pqgICoqV0hBVCBJUyBERUxJQkVSQVRFTFkgTk9UIEhFUkU6IGJvdW50eSdzIHNodXRkb3duIHdhdGNoZG9nLioqIEJvdW50eSBhcm1zXG4gKiBhIFJFRidkIGBzZXRUaW1lb3V0YCB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGlmIHRlYXJkb3duIGRvZXMgbm90IGZpbmlzaCxcbiAqIGFuZCB0aGUgY2Vuc3VzIGlzIHJpZ2h0IHRoYXQgaXQgaXMgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbFxuICogdGVybWluYXRpb24gZ3VhcmFudGVlLiBJdCBiZWxvbmdzIHRvIGJvdW50eSdzIFRFQVJET1dOIOKAlCB0aGUgc3RyZXRjaCB3aGVyZVxuICogbm90aGluZyBib3VuZHMgd2hhdCBpcyBiZWluZyB3YWl0ZWQgb24uIOKblCAqKlRISVMgUEFSQUdSQVBIIFNBSUQgXCJTSUdOQUxcbiAqIFBBVEhcIiBVTlRJTCBENTMsIEFORCBUSEUgQ09ERSBBR1JFRUQgV0lUSCBJVCwgV0hJQ0ggV0FTIFRIRSBERUZFQ1QuKiogQm91bnR5XG4gKiBoYXMgRk9VUiB3YXlzIGludG8gb25lIHRlYXJkb3duIChhIHNpZ25hbCwgYSBgY2xvc2VgIHZlcmIsIHRoZSBicm93c2VyJ3NcbiAqIGNsb3NlIG92ZXIgdGhlIFdlYlNvY2tldCwgYW4gaWRsZSB0aW1lb3V0KSBhbmQgb25seSB0aGUgc2lnbmFsIG9uZSBhcm1lZCB0aGVcbiAqIHRpbWVyLCB3aGlsZSB0aGUgY29tbWVudCBhYm92ZSBpdCBjbGFpbWVkIHRoZSBlbmRpbmcgd2FzIHVuY29uZGl0aW9uYWwuXG4gKiBEcml2ZW4gd2l0aCBhIHBsYW50ZWQgaGFuZzogdGhlIG90aGVyIHRocmVlIHJhbiBwYXN0IDEwIHMsIHRoZSBpZGxlIG9uZVxuICogaW5jbHVkZWQg4oCUIHRoZSBvcnBoYW4tZGFlbW9uIGNsYXNzIHRoZSAyMy1taW51dGUgaGFuZyBjYW1lIGZyb20uIFRoZSBhcm1pbmdcbiAqIG5vdyBsaXZlcyBpbiB0aGUgUkVTT0xWRSB0aGF0IGFsbCBmb3VyIGVudHJpZXMgcGFzcyB0aHJvdWdoLiAqKlRoZSBsZXNzb24gZm9yXG4gKiBhbiBhZG9wdGVyIGlzIHRoZSBjb3VudCwgbm90IHRoZSBwbGFjZW1lbnQ6IGVudW1lcmF0ZSBldmVyeSBlbnRyeSBpbnRvIHRoZVxuICogdGVhcmRvd24gYmVmb3JlIHlvdSBiZWxpZXZlIGEgZ3VhcmFudGVlIGNvdmVycyBpdC4qKiBUaGUgdHdvXG4gKiBkYWVtb25zIGFkb3B0aW5nIHRoaXMgbW9kdWxlIHJlZ2lzdGVyIG5vIHNpZ25hbCBoYW5kbGVycywgYW5kIHRoZWlyIHdob2xlXG4gKiB0ZWFyZG93biBpcyBib3VuZGVkIGJ5IHRoZSB0d28gbnVtYmVycyBhYm92ZTsgYWRkaW5nIGFuIGV4aXQgaGVyZSB3b3VsZCBwdXRcbiAqIHRoZSBob3VzZSdzIG9ubHkgdW5jb25kaXRpb25hbCBgcHJvY2Vzcy5leGl0YCBpbnNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgaXNcbiAqIGFib3V0IHRvIGJ1bmRsZSwgb25lIHBoYXNlIGFmdGVyIEQ4IHRvb2sgZXhhY3RseSB0aGF0IGhhemFyZCBPVVQgb2YgYGRpZWAuXG4gKlxuICog4puUICoqQU5EIFRIRSBTRU5URU5DRSBUSEFUIFVTRUQgVE8gRU5EIFRIQVQgUEFSQUdSQVBIIFdBUyBBIFBSRURJQ1RJT04sIFdISUNIXG4gKiBCT1VOVFknUyBPV04gUE9SVCBGQUxTSUZJRUQuKiogSXQgcmVhZDogXCJ3aGVuIGEgc3BlbGwgd2l0aCBhIHNpZ25hbCBwYXRoXG4gKiBhZG9wdHMgdGhpcywgdGhlIHdhdGNoZG9nIGFycml2ZXMgYXMgYW4gb3B0aW9uIG9uIHRoZXNlIGFyZ3VtZW50cyBhbmQgdGhlXG4gKiByZWFzb25pbmcgaXMgYWxyZWFkeSB3cml0dGVuIGRvd24uXCIgYm91bnR5IGFkb3B0ZWQgYGRyYWluQW5kU3RvcGAgb25cbiAqIDIwMjYtMDktMDkgKFBoYXNlIDQpIGFuZCB0aGUgb3B0aW9uIHdhcyBOT1QgYWRkZWQsIGJlY2F1c2UgdGhlIHdpbmRvdyBpc1xuICogd3JvbmcuICoqQSBgd2F0Y2hkb2dNc2Agb24gdGhlc2UgYXJndW1lbnRzIHdvdWxkIGFybSBhdCBEUkFJTiB0aW1lOyBib3VudHknc1xuICogYXJtcyBhdCBTSUdOQUwgdGltZSoqLCBhbmQgdGhlIHdob2xlIHJlYXNvbiBpdCBleGlzdHMgaXMgdGhlIHN0cmV0Y2ggQkVUV0VFTlxuICogdGhvc2UgdHdvIHBvaW50cyDigJQgYGF3YWl0IGRvbmVgLCBhbiBmcyBhcHBlbmQgdG8gdGhlIGRhZW1vbiBsb2csIGEgZnVsbFxuICogc25hcHNob3Qgd3JpdGUgdGhhdCBjYW4gcm90YXRlIGFuZCBDT1BZIGEgYmFja3VwIG9mIGEgbGFyZ2UgYm9hcmQsIGEgYGNsb3NlZGBcbiAqIGZyYW1lIGFuZCBhIGJyb2FkY2FzdC4gYGRyYWluQW5kU3RvcGAncyBvd24gYm9keSBpcyBhbHJlYWR5IGJvdW5kZWQgYnkgdGhlIHR3b1xuICogbnVtYmVycyBhYm92ZSwgc28gYSB3YXRjaGRvZyBzY29wZWQgdG8gaXQgd291bGQgZ3VhcmQgdGhlIG9uZSBzdHJldGNoIHRoYXRcbiAqIGNhbm5vdCBoYW5nIGFuZCBhYmFuZG9uIHRoZSBzdHJldGNoIHRoYXQgY2FuOiBpdCB3b3VsZCBSRUFEIGFzIGFkb3B0aW9uIGFuZFxuICogQkUgYSBuYXJyb3dpbmcgb2YgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbCB0ZXJtaW5hdGlvbiBndWFyYW50ZWUuIFRoZVxuICogMjMtbWludXRlIGhhbmcgdGhpcyBwcm9qZWN0IGtlZXBzIGNpdGluZyBoYXBwZW5lZCBpbiB0aGUgdW5ib3VuZGVkIHN0cmV0Y2guXG4gKlxuICog4pqgICoqU08gVEhFIFJVTEUgRk9SIFRIRSBORVhUIFNQRUxMLCBXSElDSCBJUyBUSEUgVFJBTlNGRVJBQkxFIEhBTEY6KiogdGhlXG4gKiBxdWVzdGlvbiBpcyBuZXZlciBcImRvZXMgdGhpcyBtb2R1bGUgaGF2ZSBhIHBsYWNlIHRvIHB1dCBhIHdhdGNoZG9nXCIgYnV0XG4gKiBcImRvZXMgdGhlIHdhdGNoZG9nJ3Mgd2luZG93IGNvaW5jaWRlIHdpdGggdGhpcyBtb2R1bGUnc1wiLiBXaGVyZSBhIHNwZWxsJ3NcbiAqIHRlYXJkb3duIGhhcyB1bmJvdW5kZWQgd29yayBCRUZPUkUgdGhlIGRyYWluLCB0aGUgd2F0Y2hkb2cgYmVsb25ncyBhdCB0aGVcbiAqIHNwZWxsLCB3cmFwcGVkIGFyb3VuZCBhbGwgb2YgaXQg4oCUIGFuZCBhcm91bmQgRVZFUlkgV0FZIElOLCB3aGljaCBpcyB0aGUgaGFsZlxuICogRDUzIGhhZCB0byByZXBhaXIgYWZ0ZXIgdGhpcyBoZWFkZXIgd2FzIHdyaXR0ZW4uIElmIGEgc3BlbGwgZXZlciBhcHBlYXJzIHdob3NlIHNpZ25hbCBwYXRoXG4gKiBlbnRlcnMgYGRyYWluQW5kU3RvcGAgaW1tZWRpYXRlbHksIGFkZCB0aGUgb3B0aW9uIFRIRU4g4oCUIGFuZCB0aGUgb3B0aW9uIG11c3RcbiAqIHRha2UgYW4gYG9uRXhwaXJlYCBjYWxsYmFjayByYXRoZXIgdGhhbiBleGl0aW5nLCBzbyB0aGUgYHByb2Nlc3MuZXhpdGAgc3RheXNcbiAqIG91dHNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgYnVuZGxlcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRyYWluQW5kU3RvcChvcHRzOiBEcmFpbk9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZ3JhY2VNcyA9IG9wdHMuZ3JhY2VNcyA/PyAxNTA7XG4gIGNvbnN0IHN0b3BNcyA9IG9wdHMuc3RvcE1zID8/IDIwMDtcblxuICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBncmFjZU1zKSk7XG5cbiAgaWYgKG9wdHMuY2xpZW50cykge1xuICAgIGZvciAoY29uc3QgY2xpZW50IG9mIFsuLi5vcHRzLmNsaWVudHNdKSBjbGllbnQuY2xvc2UoKTtcbiAgfVxuICBpZiAob3B0cy5zb2NrZXRzKSB7XG4gICAgZm9yIChjb25zdCB3cyBvZiBbLi4ub3B0cy5zb2NrZXRzXSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgd3MuY2xvc2UoKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBhbHJlYWR5IGdvbmUgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgIFByb21pc2UucmVzb2x2ZShvcHRzLnNlcnZlci5zdG9wKHRydWUpKSxcbiAgICBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBzdG9wTXMpKSxcbiAgXSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGFzc2V0LXNlcnZpbmcgdHJpbyBmb3IgYSBzcGVsbCBkYWVtb246IHdoaWNoIHN1cmZhY2UgbW9kZSB3ZVxuICogYXJlIGluLCB3aGF0IGNvbnRlbnQgdHlwZSBhIGZpbGUgZ2V0cywgYW5kIGhvdyBhIGZpbGUgdW5kZXIgYGRpc3QvYCBpc1xuICogYW5zd2VyZWQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwncyBhcnRpZmFjdC5cbiAqXG4gKiBFeHRyYWN0ZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBmcm9tIHRoZSBlaWdodCBgQnVuLnNlcnZlYCBiYWNrZW5kc1xuICogY2Vuc3VzZWQgaW4gYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC1kYWVtb24tc3BpbmUtY2Vuc3VzLm1kYCwgd2hpY2hcbiAqIG1lYXN1cmVkIGByZXNvbHZlTW9kZWAgYXMgYnl0ZS1pZGVudGljYWwgaW4gYWxsIGVpZ2h0ICh0aGUgb25seSBtZDUgZGlmZmVyZW5jZVxuICogYmVpbmcgdGhlIGBleHBvcnRgIGtleXdvcmQpLCB0aGUgY29udGVudC10eXBlIG1hcCBhcyBkaWZmZXJpbmcgaW4gZXhhY3RseVxuICogb25lIGNlbGwsIGFuZCB0aGUgZmlsZSBoYWxmIG9mIGBzZXJ2ZURpc3RgIGFzIGlkZW50aWNhbCBpbiBmaXZlLlxuICpcbiAqIOKUgOKUgCBXSEFUIERFTElCRVJBVEVMWSBESUQgTk9UIENPTUUgQUxPTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKipUaGUgVVJMLXRvLWZpbGVuYW1lIG1hcHBpbmcgc3RheXMgaW4gZWFjaCByb3V0ZXIuKiogVGhlIGNlbnN1cyBtYXJrZWQgdHdvXG4gKiBvZiB0aGUgZWlnaHQgYHNlcnZlRGlzdGAgZGl2ZXJnZW5jZXMgREVMSUJFUkFURSBhbmQgYm90aCBsaXZlIGluIHRoYXQgaGFsZjpcbiAqIGRpZ2VzdGlmeSBzdWJzdGl0dXRlcyBpbnRvIHRoZSBlbnRyeSBIVE1MIGluIG1lbW9yeSwgYW5kIGdyYXBldmluZSBzZXJ2ZXMgaXRzXG4gKiBzdXJmYWNlIGF0IGAvd2F0Y2hgIHJhdGhlciB0aGFuIGF0IGAvYC4gQSBzaWduYXR1cmUgd2lkZSBlbm91Z2ggdG8gYWJzb3JiXG4gKiB0aG9zZSBzdG9wcyBiZWluZyBhIGZpbGUgc2VydmVyIGFuZCBiZWNvbWVzIGEgcm91dGVyLiBTbyB0aGUgY2FsbGVyIGRlY2lkZXNcbiAqIFdISUNIIGZpbGUgKGBwYXRoID09PSBcIi9cIiA/IFwiaW5kZXguaHRtbFwiIDogcGF0aC5zbGljZSgxKWApLCBhbmQgdGhpcyBtb2R1bGVcbiAqIGRlY2lkZXMgd2hldGhlciB0aGF0IGZpbGUgbWF5IGJlIHJlYWQgYW5kIHdoYXQgaXQgaXMgc2VydmVkIGFzLlxuICovXG5cbmltcG9ydCB7IGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuLyoqXG4gKiBSZWxlYXNlIGlmZiBgPGRpc3REaXI+L2luZGV4Lmh0bWxgIGV4aXN0czsgZWxzZSBkZXYuIFRoZSBlbnYgb3ZlcnJpZGVcbiAqIChgU1BFTExCT09LX1NVUkZBQ0VfTU9ERWApIHdpbnMgZWl0aGVyIHdheSDigJQgc2VhbXMgQ29udHJhY3QgMS5cbiAqXG4gKiDim5QgKipUSEUgRklMRSwgTkVWRVIgVEhFIERJUkVDVE9SWSwgQU5EIFRIQVQgSVMgQSBTQ0FSIE5PVCBBIFNUWUxFIENIT0lDRS4qKlxuICogUmUtaG9tZWQgZnJvbSBib3VudHkgYW5kIG1hZ3BpZSwgd2hpY2ggZWFybmVkIGl0IGluZGVwZW5kZW50bHk6XG4gKlxuICogLSBtYWdwaWUncyBgZGlzdC9gIEFMUkVBRFkgRVhJU1RFRCBob2xkaW5nIGBjbGkuanNgIGFuZCBubyBgaW5kZXguaHRtbGAsXG4gKiAgIHdoaWNoIGlzIHByZWNpc2VseSB3aHkgaXRzIGRhZW1vbiBzdGF5ZWQgY29ycmVjdGx5IGluIERFViBtb2RlIHRocm91Z2ggdGhlXG4gKiAgIHdob2xlIG9mIFNsaWNlIDIuIGBkaXN0L2AgZXhpc3RpbmcgaXMgbm90IHRoZSBkaXNjcmltaW5hdG9yLlxuICogLSBib3VudHkgc2F5cyB0aGUgc2FtZSB0aGluZyBmcm9tIHRoZSBvdGhlciBzaWRlOiBhIGJ1aWx0IEJBQ0tFTkQgcHV0c1xuICogICBgY2xpLmpzYCAoYW5kIG5vdyBgc2VydmVyLmpzYCkgaW4gYGRpc3QvYCB3aXRoIG5vIHN1cmZhY2UgYW55d2hlcmUgbmVhciBpdC5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBSRURJQ0FURSBJUyBBTiBVTkhBU0hFRCBGSUxFTkFNRSwgV0hJQ0ggSVMgQSBTVEFORElOR1xuICogQVNTVU1QVElPTiBBQk9VVCBUSEUgU1VSRkFDRSBCVUlMRC4qKiBSZWxlYXNlIG1vZGUgaXMgY2hvc2VuIGJ5IE9ORSBsaXRlcmFsXG4gKiBuYW1lLiBBIHN1cmZhY2UgYnVpbGQgdGhhdCBldmVyIGVtaXR0ZWQgYSBjb250ZW50LWhhc2hlZCBlbnRyeSBkb2N1bWVudCB3b3VsZFxuICogbGVhdmUgbm8gYGluZGV4Lmh0bWxgIGhlcmUsIGV2ZXJ5IGRhZW1vbiB3b3VsZCBzaWxlbnRseSByZXNvbHZlIERFViwgYW5kIHRoZVxuICogb25seSBzeW1wdG9tIGFueW9uZSBjYW4gc2VlIGlzIHRoZSBgbW9kZWAgZmllbGQgb24gYSBoYW5kc2hha2Ugbm9ib2R5IHJlYWRzIGluXG4gKiBhbmdlci4gYHNyYy9idWlsZC50c2AgZW1pdHMgdGhlIGVudHJ5IHVuaGFzaGVkIHRvZGF5IChvbmx5IHRoZSBKUyBhbmQgQ1NTXG4gKiBjaHVua3MgY2FycnkgaGFzaGVzKSBhbmQgQ29udHJhY3QgMiBwaW5zIHRoYXQgZmxhdCBsYXlvdXQ7IHRoaXMgY29tbWVudCBpc1xuICogdGhlIG5vdGUgdGhhdCBzYXlzIHdoYXQgdGhlIHBpbiBpcyBsb2FkLWJlYXJpbmcgRk9SLlxuICpcbiAqIOKaoCBOb3RoaW5nIGFubm91bmNlcyB0aGUgZmxpcCBmcm9tIGRldiB0byByZWxlYXNlIGVpdGhlcjogdGhlIGZpcnN0IHN1cmZhY2VcbiAqIGJ1aWxkIHRvIGxhbmQgYW4gYGluZGV4Lmh0bWxgIGJlc2lkZSBhIGRhZW1vbiBmbGlwcyBpdCwgc2lsZW50bHksIG9uIHRoZSBuZXh0XG4gKiBib290LiBUaGF0IGlzIHdoeSBgbW9kZWAgcmlkZXMgdGhlIHJlYWR5IGZyYW1lIOKAlCB3aXRoIHJvb3QgZGVwcyBwcmVzZW50IGEgZGV2XG4gKiBkYWVtb24gcmVuZGVycyBhbiBpZGVudGljYWwtbG9va2luZyBzdXJmYWNlLCBzbyBcIml0IGxvb2tzIHJpZ2h0XCIgY2Fubm90XG4gKiB2ZXJpZnkgQ29udHJhY3QgMS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKGRpc3REaXI6IHN0cmluZyk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIGNvbnN0IG92ZXJyaWRlID0gcHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERTtcbiAgaWYgKG92ZXJyaWRlID09PSBcImRldlwiIHx8IG92ZXJyaWRlID09PSBcInJlbGVhc2VcIikgcmV0dXJuIG92ZXJyaWRlO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKGRpc3REaXIsIFwiaW5kZXguaHRtbFwiKSkgPyBcInJlbGVhc2VcIiA6IFwiZGV2XCI7XG59XG5cbi8qKlxuICogVGhlIGNvbnRlbnQgdHlwZXMgYSBidWlsdCBzdXJmYWNlIGFjdHVhbGx5IHNoaXBzLiBFeHRlbnNpb25zIG91dHNpZGUgdGhlXG4gKiBtYXAgZ2V0IGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gIOKAlCBhIGRlbGliZXJhdGUgcmVmdXNhbCB0byBndWVzcywgc2luY2VcbiAqIGFueXRoaW5nIG5vdCBpbiB0aGlzIGxpc3QgaXMgbm90IHNvbWV0aGluZyBDb250cmFjdCAyJ3MgYnVpbGQgZW1pdHMuXG4gKlxuICog4pqgICoqYGNoYXJzZXQ9dXRmLThgIE9OIEhUTUwgSVMgVEhFIENFTlNVUydTIE9ORSBESVZFUkdFTkNFLCBSRVNPTFZFRCBUT1dBUkRcbiAqIFRIRSBDT1JSRUNUIENPUFkuKiogVGhyZWUgb2YgdGhlIGVpZ2h0IGRhZW1vbnMgY2FycmllZCBpdCBhbmQgZml2ZSBkaWQgbm90O1xuICogdGhlIGNlbnN1cyBncmFkZWQgdGhhdCBgc3RhbGVgIHdpdGggemVybyBkZXNpZ24gY29udGVudC4gSXQgaXMga2VwdCBiZWNhdXNlXG4gKiBpdCBpcyB0aGUgcmlnaHQgYW5zd2VyIOKAlCBhbiBIVE1MIGRvY3VtZW50IHNlcnZlZCB3aXRoIG5vIGNoYXJzZXQgaXMgZGVjb2RlZFxuICogYnkgdGhlIGJyb3dzZXIncyBndWVzcyDigJQgYW5kIGl0IGlzIHRoZSBvbmUgd2lyZS1vYnNlcnZhYmxlIGNoYW5nZSB0aGlzXG4gKiBjb252ZXJnZW5jZSBtYWtlcyB0byBhIHJlc3BvbnNlIGhlYWRlci4gUmVjb3JkZWQgYXMgRC1ub3RlIGluIHRoZSBwaGFzZSBsb2dcbiAqIHJhdGhlciB0aGFuIHNtdWdnbGVkLlxuICovXG5jb25zdCBTVEFUSUNfQ09OVEVOVF9UWVBFUzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIuaHRtbFwiOiBcInRleHQvaHRtbDsgY2hhcnNldD11dGYtOFwiLFxuICBcIi5qc1wiOiBcInRleHQvamF2YXNjcmlwdFwiLFxuICBcIi5jc3NcIjogXCJ0ZXh0L2Nzc1wiLFxuICBcIi5qc29uXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICBcIi5zdmdcIjogXCJpbWFnZS9zdmcreG1sXCIsXG4gIFwiLnBuZ1wiOiBcImltYWdlL3BuZ1wiLFxufTtcblxuLyoqIFRoZSBjb250ZW50IHR5cGUgZm9yIGEgZmlsZW5hbWUgb3IgYW4gZXh0ZW5zaW9uLiBVbmtub3duIGV4dGVuc2lvbnMsIGFuZFxuICogIG5hbWVzIHdpdGggbm8gZXh0ZW5zaW9uIGF0IGFsbCwgZ2V0IGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbnRlbnRUeXBlRm9yKG5hbWVPckV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZG90ID0gbmFtZU9yRXh0Lmxhc3RJbmRleE9mKFwiLlwiKTtcbiAgY29uc3QgZXh0ID0gZG90ID09PSAtMSA/IFwiXCIgOiBuYW1lT3JFeHQuc2xpY2UoZG90KTtcbiAgcmV0dXJuIFNUQVRJQ19DT05URU5UX1RZUEVTW2V4dF0gPz8gXCJhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1cIjtcbn1cblxuLyoqXG4gKiBBbnN3ZXIgT05FIGZpbGUgZnJvbSBgZGlzdERpcmAsIG9yIGBudWxsYCBpZiB0aGUgY2FsbGVyIHNob3VsZCBrZWVwIHJvdXRpbmcuXG4gKlxuICogYHJlbGAgaXMgYSBiYXJlIGZpbGVuYW1lIOKAlCB0aGUgZW50cnkgZG9jdW1lbnQgb3Igb25lIGhhc2hlZCBjaHVuay4gQ29udHJhY3RcbiAqIDIncyBidWlsdCBzdXJmYWNlIGlzIEZMQVQgYW5kIGxpbmtzIGl0cyBjaHVua3MgcmVsYXRpdmVseSwgc28gYSBsZWdpdGltYXRlXG4gKiBhc3NldCByZXF1ZXN0IGlzIG5ldmVyIG5lc3RlZCBhbmQgbmV2ZXIgY29udGFpbnMgYC4uYDsgYm90aCBhcmUgcmVmdXNlZFxuICogaGVyZSByYXRoZXIgdGhhbiBpbiB0aGUgcm91dGVyLCBiZWNhdXNlIHRoZSBndWFyZCBwcm90ZWN0cyB0aGUgcmVhZCBhbmQgdGhlXG4gKiByZWFkIGlzIHdoYXQgbGl2ZXMgaW4gdGhpcyBmaWxlLlxuICpcbiAqIOKaoCBUaGUgcmVmdXNhbCBpcyBhbHNvIHdoYXQga2VlcHMgYW4gYXNzZXQgc2VydmUgY2xlYXIgb2YgYSBzcGVsbCdzIG93blxuICogcm91dGVzOiBtYWdwaWUgaGFzIGFuIGAvYXNzZXRzLzxuYW1lPmAgcm91dGUgb25lIGxldmVsIGRlZXAsIGFuZCB0aGlzXG4gKiByZXR1cm5pbmcgYG51bGxgIG9uIGFueXRoaW5nIHdpdGggYSBzbGFzaCBpbiBpdCBpcyB3aGF0IHN0b3BzIHRoZSB0d29cbiAqIGZpZ2h0aW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2VydmVGcm9tRGlzdChkaXN0RGlyOiBzdHJpbmcsIHJlbDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgaWYgKCFyZWwgfHwgcmVsLmluY2x1ZGVzKFwiLi5cIikgfHwgcmVsLmluY2x1ZGVzKFwiL1wiKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGZpbGUgPSBqb2luKGRpc3REaXIsIHJlbCk7XG4gIGlmICghZXhpc3RzU3luYyhmaWxlKSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBuZXcgUmVzcG9uc2UoQnVuLmZpbGUoZmlsZSksIHsgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBjb250ZW50VHlwZUZvcihyZWwpIH0gfSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIHNlcnZlciBzaWRlIG9mIHRoZSBTU0UgdGFpbCDigJQgdGhlIGRhZW1vbi1zaWRlIHR3aW4gb2ZcbiAqIGB0YWlsRXZlbnRzLnRzYC4gVGhhdCBtb2R1bGUgZGVjaWRlcyB3aGF0IGEgY2FsbGVyIG9ic2VydmVzOyB0aGlzIG9uZSBkZWNpZGVzXG4gKiB3aGF0IGEgY2FsbGVyIGlzIHNlbnQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgZXhjZXB0IGl0c1xuICogb3duIHNpYmxpbmcgdHlwZXMsIHdoaWNoIGlzIHN0aWxsIGluc2lkZSB0aGUgbGVhZi5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgbWluZC1tYXBwZXIncyBgc3NlUmVzcG9uc2VgLFxuICogdGhlIGNlbnN1cydzIGNvbnZlcmdlbmNlIHRhcmdldCAjMTogdGhlIG9ubHkgb25lIG9mIHRoZSBzZXZlbiB3aXRoIGFcbiAqIG9uY2Utb25seSB0ZWFyZG93biBmdW5uZWwsIHRoZSBvbmx5IG9uZSB3aXJlZCB0byBgcmVxLnNpZ25hbGAsIGFuZCB0aGUgb25seVxuICogb25lIHdob3NlIGNvbW1lbnQgcmVjb3JkcyBhIE1FQVNVUkVEIHJlc3VsdCByYXRoZXIgdGhhbiBhIGJlbGllZi5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSLCBSRS1IT01FRDogYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgRE9FUyBOT1QgREVURUNUIEEgREVBRFxuICogICAgQ0xJRU5ULiBNRUFTVVJFRCBPTiBCVU4gMS4zLjE0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFNpeCBkYWVtb25zIHdyaXRlIGEgaGVhcnRiZWF0IGFzIGB0cnkgeyBjb250cm9sbGVyLmVucXVldWUoLi4uKSB9IGNhdGNoIHt9YFxuICogd2l0aCBhIGNvbW1lbnQgc2F5aW5nIHRoZSBjYXRjaCBpcyBob3cgYSBkZXBhcnRlZCBjbGllbnQgaXMgbm90aWNlZC4gSXQgaXNcbiAqIG5vdDogZW5xdWV1ZSBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gQlVGRkVSUyBTSUxFTlRMWSBhbmQgbmV2ZXIgdGhyb3dzLCBzbyB0aGVcbiAqIGNhdGNoIG5ldmVyIGZpcmVzIGFuZCB0aG9zZSBkYWVtb25zJyBkZWFkLWNsaWVudCBkZXRlY3Rpb24gcmVzdHMgb24gYVxuICogbWVjaGFuaXNtIHRoZWlyIG93biBjb21tZW50cyBkZXNjcmliZSBpbmNvcnJlY3RseS4gV2hhdCBhY3R1YWxseSByZWNsYWltcyB0aGVcbiAqIGNvbm5lY3Rpb24gaXMgdGhlIHN0cmVhbSdzIGBjYW5jZWwoKWAg4oCUIGFuZCwgZm9yIGEgY2xpZW50IHRoYXQgbmV2ZXIgY2xvc2VzXG4gKiB0aGUgc29ja2V0LCBgcmVxLnNpZ25hbGAuXG4gKlxuICogU28gdGhlIGZ1bm5lbCBiZWxvdyBpcyB0aGUgbG9hZC1iZWFyaW5nIHBhcnQuIGB0ZWFyZG93bigpYCBydW5zIEFUIE1PU1QgT05DRVxuICogZnJvbSBldmVyeSBwYXRoIHRoZXJlIGlzIOKAlCBgY2FuY2VsKClgLCBhbiBhYm9ydCBvbiB0aGUgcmVxdWVzdCBzaWduYWwsIGFuZFxuICogdGhlIGJlbHQtYW5kLWJyYWNlcyBlbnF1ZXVlIGNhdGNoIOKAlCBhbmQgaXQgaXMgd2hlcmUgdGhlIHN1YnNjcmliZXIgY291bnQgYW5kXG4gKiBhbnkgcHJlc2VuY2UgZGVjcmVtZW50IHJpZGUuIEJvdW5kaW5nIHByZXNlbmNlIGFjY3VyYWN5IGlzIGJvdW5kaW5nIHRoYXRcbiAqIGZ1bm5lbC5cbiAqXG4gKiDimqAgS25vd24gaG9sZSwgYWNjZXB0ZWQgYW5kIGluaGVyaXRlZDogQnVuJ3Mgb3duIGBmZXRjaCgpYCByZWFkZXIgYC5jYW5jZWwoKWBcbiAqIGNsb3NlcyBub3RoaW5nIGNsaWVudC1zaWRlIGFuZCB0aGUgc2VydmVyIGNhbm5vdCBzZWUgaXQuIFJlYWwgY2xpZW50cyBjbG9zZVxuICogdGhlIHNvY2tldC5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEV2ZW50TG9nLCBGcmFtZSB9IGZyb20gXCIuL2V2ZW50TG9nLnRzXCI7XG5cbi8qKlxuICogT25lIG9wZW4gU1NFIHN0cmVhbSwgYXMgdGhlIGRhZW1vbiBjYW4gYWN0IG9uIGl0OiBlbmQgaXQsIG9yIHB1c2ggYSBmcmFtZSB0b1xuICogaXQgdGhhdCBkaWQgbm90IGNvbWUgb3V0IG9mIHRoZSBsb2cuXG4gKlxuICog4puUIElUIElTIE5PVCBBIENPTlRST0xMRVIuIFRoZSBjb3BpZXMgaGVsZFxuICogYFNldDxSZWFkYWJsZVN0cmVhbURlZmF1bHRDb250cm9sbGVyPmAgYW5kIGNsb3NlZCB0aGVtIGRpcmVjdGx5IGF0IHRlYXJkb3duLFxuICogd2hpY2ggYnlwYXNzZXMgdGhlIHRlYXJkb3duIGZ1bm5lbCBhYm92ZSDigJQgdGhlIGhlYXJ0YmVhdCBpbnRlcnZhbCBmb3IgdGhhdFxuICogc3RyZWFtIHdhcyBjbGVhcmVkIG9ubHkgYmVjYXVzZSBhIHNlY29uZCBgU2V0YCBvZiB0aW1lcnMgd2FzIGtlcHQgaW4gcGFyYWxsZWxcbiAqIGFuZCBzd2VwdCBzZXBhcmF0ZWx5LiBFdmVyeXRoaW5nIGhlcmUgZ29lcyB0aHJvdWdoIHRoZSBmdW5uZWwsIGFuZCBhIGBzZW5kYFxuICogYWZ0ZXIgdGVhcmRvd24gaXMgYSBuby1vcCByYXRoZXIgdGhhbiBhIHRocm93LlxuICpcbiAqIOKaoCAqKmBzZW5kYCBBUlJJVkVEIElOIFBIQVNFIDIsIEZST00gVEhFIEZJUlNUIENPTlNVTUVSIFRIQVQgV0FTIE5PVCBPTkUgT0YgVEhFXG4gKiBUV08gVEhJUyBNT0RVTEUgV0FTIERFU0lHTkVEIEFHQUlOU1QuKiogYXN0cm9sYWJlIGFuZCBtYWdwaWUgYW5ub3VuY2UgcHJlc2VuY2VcbiAqIG92ZXIgdGhlaXIgYnJvd3NlciBXRUJTT0NLRVQsIHNvIGEgcmVnaXN0cnkgb2YgYmFyZSBjbG9zZXJzIHdhcyBzdWZmaWNpZW50IGFuZFxuICogdGhlIGJvdW5kYXJ5IGxvb2tlZCByaWdodC4gZ2xhbW91ciBhbm5vdW5jZXMgaXQgb24gdGhlIEFHRU5UJ3MgU1NFIHRhaWwg4oCUXG4gKiBge3R5cGU6XCJjb25uZWN0ZWRcIn1gIC8gYHt0eXBlOlwiZGlzY29ubmVjdGVkXCJ9YCwgZGVsaWJlcmF0ZWx5IHVubG9nZ2VkLCBzbyBhXG4gKiByZWNvbm5lY3RpbmcgYWdlbnQgZG9lcyBub3QgcmUtc2VlIGV2ZXJ5IHBhc3QgY29ubmVjdCBhbmQgc28gdGhlIGZyYW1lIG5ldmVyXG4gKiBhZHZhbmNlcyBhIHRhaWwgY3Vyc29yLiBUaGF0IGlzIG5vdCBhIGdsYW1vdXIgcXVpcms7IGl0IGlzIHRoZSBnZW5lcmFsIHNoYXBlXG4gKiBvZiBcInRlbGwgdGhlIGxpdmUgc3Vic2NyaWJlcnMgc29tZXRoaW5nIHRoYXQgaXMgbm90IHBhcnQgb2YgdGhlIGhpc3RvcnlcIiwgYW5kXG4gKiBhIHJlZ2lzdHJ5IHRoYXQgY2FuIG9ubHkgRU5EIGEgc3RyZWFtIGNhbm5vdCBleHByZXNzIGl0LiBXaXRob3V0IHRoaXMgdGhlXG4gKiBzcGVsbCB3b3VsZCBoYXZlIGhhZCB0byBrZWVwIGl0cyBvd24gcGFyYWxsZWwgYFNldGAgb2YgY29udHJvbGxlcnMsIHdoaWNoIGlzXG4gKiBleGFjdGx5IHRoZSBkcmlmdCB0aGlzIHJlZ2lzdHJ5IGV4aXN0cyB0byByZW1vdmUuXG4gKi9cbmV4cG9ydCB0eXBlIFNzZUNsaWVudCA9IHtcbiAgLyoqIEVuZCB0aGlzIHN0cmVhbSwgdGhyb3VnaCB0aGUgdGVhcmRvd24gZnVubmVsLCBhdCBtb3N0IG9uY2UuICovXG4gIGNsb3NlKCk6IHZvaWQ7XG4gIC8qKiBXcml0ZSBvbmUgcmF3IFNTRSBjaHVuayB0byB0aGlzIHN0cmVhbS4gTm8tb3Agb25jZSB0b3JuIGRvd24uICovXG4gIHNlbmQoY2h1bms6IHN0cmluZyk6IHZvaWQ7XG59O1xuXG4vKipcbiAqIFRoZSBsaXZlLXRhaWwgcmVnaXN0cnkuIGBzaXplYCBpcyB0aGUgZGFlbW9uJ3MgU1NFIHN1YnNjcmliZXIgY291bnQg4oCUIHRoZVxuICogbnVtYmVyIGBzaG91bGRJZGxlQ2xvc2VgIG11c3Qgc2VlIOKAlCBhbmQgY2xvc2luZyBldmVyeSBlbnRyeSBpcyB3aGF0IGEgZHJhaW5cbiAqIGRvZXMuXG4gKi9cbmV4cG9ydCB0eXBlIFNzZUNsaWVudHMgPSBTZXQ8U3NlQ2xpZW50PjtcblxuZXhwb3J0IGludGVyZmFjZSBTc2VPcHRpb25zPFQgZXh0ZW5kcyBvYmplY3Q+IHtcbiAgLyoqIFRoZSBsb2cgdG8gcmVwbGF5IGZyb20gYW5kIHN1YnNjcmliZSB0by4gKi9cbiAgbG9nOiBFdmVudExvZzxUPjtcbiAgLyoqIFRoZSBjYWxsZXIncyByZXN1bWUgY3Vyc29yLiBBYnNlbnQgb3IgdW5wYXJzZWFibGUgcmVwbGF5cyBmcm9tIHRoZSBzdGFydC4gKi9cbiAgc2luY2U6IG51bWJlcjtcbiAgLyoqIEhlYXJ0YmVhdCBjb21tZW50IGludGVydmFsLiBNVVNUIHN0YXkgd2VsbCB1bmRlciB0aGUgc2VydmVyJ3NcbiAgICogIGBpZGxlVGltZW91dGAg4oCUIHNlZSBgaGVhcnRiZWF0LnRzYCwgd2hpY2ggaXMgd2hlcmUgdGhhdCBwYWlyIGxpdmVzLiAqL1xuICBoZWFydGJlYXRNczogbnVtYmVyO1xuICAvKiogTGl2ZW5lc3MgcmVnaXN0cnk7IHRoZSBzdHJlYW0gYWRkcyBpdHNlbGYgb24gb3BlbiBhbmQgcmVtb3ZlcyBpdHNlbGYgaW5cbiAgICogIHRoZSB0ZWFyZG93biBmdW5uZWwuICovXG4gIGNsaWVudHM/OiBTc2VDbGllbnRzO1xuICAvKiogYHJlcS5zaWduYWxgIOKAlCB0aGUgb25seSB0aGluZyB0aGF0IHJlY2xhaW1zIGEgY2xpZW50IHRoYXQgd2VudCBhd2F5XG4gICAqICB3aXRob3V0IGNhbmNlbGxpbmcgdGhlIHN0cmVhbS4gKi9cbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIC8qKiBTZXJ2ZXItc2lkZSBmaWx0ZXIuIEEgcmVqZWN0ZWQgZnJhbWUgaXMgbm90IHNlbnQ7IHRoZSBjbGllbnQgc3RpbGxcbiAgICogIGFkdmFuY2VzIGl0cyBjdXJzb3IgcGFzdCBpdCwgd2hpY2ggaXMgYHRhaWxFdmVudHNgJ3MgZG9jdW1lbnRlZCBydWxlLiAqL1xuICBmaWx0ZXI/OiAoZnJhbWU6IEZyYW1lPFQ+KSA9PiBib29sZWFuO1xuICAvKiogUnVuIGFmdGVyIHRoZSBzdHJlYW0gaXMgc3Vic2NyaWJlZCAocHJlc2VuY2UgdXAsIGFjdGl2aXR5IHRvdWNoKS4gKi9cbiAgb25PcGVuPzogKCkgPT4gdm9pZDtcbiAgLyoqIFJ1biBleGFjdGx5IG9uY2UsIGZyb20gd2hpY2hldmVyIHRlYXJkb3duIHBhdGggZmlyZXMgZmlyc3QuICovXG4gIG9uQ2xvc2U/OiAoKSA9PiB2b2lkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3NlUmVzcG9uc2U8VCBleHRlbmRzIG9iamVjdD4ob3B0czogU3NlT3B0aW9uczxUPik6IFJlc3BvbnNlIHtcbiAgY29uc3QgeyBsb2csIHNpbmNlLCBoZWFydGJlYXRNcywgY2xpZW50cywgc2lnbmFsLCBmaWx0ZXIsIG9uT3Blbiwgb25DbG9zZSB9ID0gb3B0cztcblxuICBsZXQgdW5zdWJzY3JpYmU6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBsZXQga2VlcGFsaXZlOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRJbnRlcnZhbD4gfCBudWxsID0gbnVsbDtcbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICAvLyBUaGUgcmVnaXN0cnkgZW50cnkgZm9yIFRISVMgc3RyZWFtLiBJdHMgbWV0aG9kcyBhcmUgZmlsbGVkIGluIGJ5IGBzdGFydGAsXG4gIC8vIHdoaWNoIGlzIHdoZXJlIHRoZSBjb250cm9sbGVyIGV4aXN0czsgdGhlIG9iamVjdCBpZGVudGl0eSBpcyBzdGFibGUgZnJvbVxuICAvLyBoZXJlIHNvIGB0ZWFyZG93bmAgY2FuIHJlbW92ZSBleGFjdGx5IHRoaXMgZW50cnkuXG4gIGNvbnN0IGNsaWVudDogU3NlQ2xpZW50ID0geyBjbG9zZTogKCkgPT4ge30sIHNlbmQ6ICgpID0+IHt9IH07XG5cbiAgY29uc3QgdGVhcmRvd24gPSAoKSA9PiB7XG4gICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgIGNsb3NlZCA9IHRydWU7XG4gICAgaWYgKGtlZXBhbGl2ZSAhPT0gbnVsbCkgY2xlYXJJbnRlcnZhbChrZWVwYWxpdmUpO1xuICAgIHVuc3Vic2NyaWJlPy4oKTtcbiAgICBjbGllbnRzPy5kZWxldGUoY2xpZW50KTtcbiAgICBvbkNsb3NlPy4oKTtcbiAgfTtcblxuICBjb25zdCBzdHJlYW0gPSBuZXcgUmVhZGFibGVTdHJlYW0oe1xuICAgIHN0YXJ0KGNvbnRyb2xsZXIpIHtcbiAgICAgIGNvbnN0IGVuY29kZXIgPSBuZXcgVGV4dEVuY29kZXIoKTtcbiAgICAgIGNvbnN0IHNhZmVFbnF1ZXVlID0gKGNodW5rOiBzdHJpbmcpID0+IHtcbiAgICAgICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnRyb2xsZXIuZW5xdWV1ZShlbmNvZGVyLmVuY29kZShjaHVuaykpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICB0ZWFyZG93bigpO1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgY2xpZW50LmNsb3NlID0gKCkgPT4ge1xuICAgICAgICB0ZWFyZG93bigpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnRyb2xsZXIuY2xvc2UoKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLyogYWxyZWFkeSBjbG9zZWQgYnkgdGhlIHJ1bnRpbWUgKi9cbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIC8vIOKblCBgc2VuZGAgR09FUyBUSFJPVUdIIGBzYWZlRW5xdWV1ZWAsIHNvIGFuIG91dC1vZi1iYW5kIGZyYW1lIG9iZXlzIHRoZVxuICAgICAgLy8gc2FtZSBjbG9zZWQtY2hlY2sgYW5kIHRoZSBzYW1lIHRlYXJkb3duLW9uLXRocm93IGFzIGEgbG9nZ2VkIG9uZS4gQVxuICAgICAgLy8gZGFlbW9uIG11c3Qgbm90IGJlIGFibGUgdG8gd3JpdGUgdG8gYSBzdHJlYW0gdGhpcyBtb2R1bGUgaGFzIHRvcm4gZG93bi5cbiAgICAgIGNsaWVudC5zZW5kID0gc2FmZUVucXVldWU7XG5cbiAgICAgIC8vIOKblCBBTiBPUEVOSU5HIENPTU1FTlQsIEJFRk9SRSBBTllUSElORyBFTFNFLiBJdCBmbHVzaGVzIHRoZSByZXNwb25zZVxuICAgICAgLy8gaGVhZGVycyBpbW1lZGlhdGVseTogc29tZSBIVFRQIGNsaWVudHMg4oCUIEJ1bidzIG93biBgZmV0Y2goKWAgaW5jbHVkZWQg4oCUXG4gICAgICAvLyBidWZmZXIgdW50aWwgdGhlIGZpcnN0IGJ5dGUgb2YgYm9keSBhcnJpdmVzLCBzbyBhIGdlbnVpbmVseSBxdWlldCBTU0VcbiAgICAgIC8vIHN0cmVhbSB3b3VsZCBvdGhlcndpc2UgbGVhdmUgdGhlIGNhbGxlcidzIGBmZXRjaCgpYCB1bnJlc29sdmVkLiBFdmVyeVxuICAgICAgLy8gaG91c2UgdGFpbCBjbGllbnQgcmVhZHMgYDpgIGxpbmVzIGFzIGNvbW1lbnRzIGFuZCBkcm9wcyB0aGVtLlxuICAgICAgc2FmZUVucXVldWUoXCI6IGNvbm5lY3RlZFxcblxcblwiKTtcblxuICAgICAgdW5zdWJzY3JpYmUgPSBsb2cuc3Vic2NyaWJlKHNpbmNlLCAoZnJhbWUpID0+IHtcbiAgICAgICAgaWYgKGZpbHRlciAmJiAhZmlsdGVyKGZyYW1lKSkgcmV0dXJuO1xuICAgICAgICBzYWZlRW5xdWV1ZShgZGF0YTogJHtKU09OLnN0cmluZ2lmeShmcmFtZSl9XFxuXFxuYCk7XG4gICAgICB9KTtcblxuICAgICAga2VlcGFsaXZlID0gc2V0SW50ZXJ2YWwoKCkgPT4gc2FmZUVucXVldWUoXCI6IGhiXFxuXFxuXCIpLCBoZWFydGJlYXRNcyk7XG4gICAgICBzaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCB0ZWFyZG93biwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgY2xpZW50cz8uYWRkKGNsaWVudCk7XG4gICAgICBvbk9wZW4/LigpO1xuICAgIH0sXG4gICAgY2FuY2VsKCkge1xuICAgICAgdGVhcmRvd24oKTtcbiAgICB9LFxuICB9KTtcblxuICByZXR1cm4gbmV3IFJlc3BvbnNlKHN0cmVhbSwge1xuICAgIGhlYWRlcnM6IHtcbiAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwidGV4dC9ldmVudC1zdHJlYW1cIixcbiAgICAgIFwiQ2FjaGUtQ29udHJvbFwiOiBcIm5vLWNhY2hlXCIsXG4gICAgICBDb25uZWN0aW9uOiBcImtlZXAtYWxpdmVcIixcbiAgICB9LFxuICB9KTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIFRPIEhBTEYgdGhlIGlkbGUgdGltZW91dC5cbiAqXG4gKiBUaGUgY2xhbXAgaXMgYXN0cm9sYWJlJ3MsIGFuZCB0aGUgY2Vuc3VzIG5hbWVkIGl0IGNvbnZlcmdlbmNlIHRhcmdldCAjNDogdGhlXG4gKiBvdGhlciBkYWVtb25zIGhhcmQtY29kZSAxNSBzIGFnYWluc3QgMjU1IHMgYW5kIHdyaXRlIHRoZSByZWxhdGlvbnNoaXAgb25seSBpblxuICogcHJvc2UsIHdoaWNoIGhvbGRzIGF0IHRoZSBkZWZhdWx0IGFuZCBhdCBubyBvdGhlciB2YWx1ZS4gRW5mb3JjaW5nXG4gKiBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgbWFrZXMgdGhlIGludmFyaWFudCB0cnVlIGZvciBBTlkgY29uZmlndXJlZFxuICogcGFpciwgd2hpY2ggaXMgZXhhY3RseSB0aGUgaW52YXJpYW50IHdob3NlIHZpb2xhdGlvbiBjYXVzZWQgdGhlIGJ1ZyBhYm92ZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWluKGludE9yKHJhdywgZmFsbGJhY2spLCBNYXRoLm1heCg1MDAsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKSk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIEltYWdvJ3MgY29ubmVjdGlvbi10aW1pbmcgY29uc3RhbnRzIOKAlCBUSEUgT05FIENPUFksIGltcG9ydGVkIGJ5IGJvdGggaGFsdmVzXG4gKiBvZiB0aGUgc3BlbGwuXG4gKlxuICog4puUIFRISVMgRklMRSBJUyBUSEUgU0VBTSwgQU5EIElUIElTIFRIRSBDTEVBTkVTVCBQUk9PRiBUSEUgUE9SVCBXT1JLRUQuXG4gKiBCZWZvcmUgUGhhc2UgMyB0aGUgaGVhcnRiZWF0IHdhcyBhIExJVEVSQUwgYDE1MDAwYCBpbnNpZGUgYHNlcnZlci50c2Anc1xuICogYHNzZVJlc3BvbnNlYCwgc2l0dGluZyB1bmRlciBhIGNvbW1lbnQgYWJvdXQgYGlkbGVUaW1lb3V0OiAyNTVgIHdyaXR0ZW4gMSwzMDBcbiAqIGxpbmVzIGF3YXkgaW4gYSBkaWZmZXJlbnQgZnVuY3Rpb24g4oCUIGFuZCBgY2xpLnRzYCBoYWQgTk8gY29ycmVzcG9uZGluZyBudW1iZXJcbiAqIGF0IGFsbDogaXRzIHRhaWwgbG9vcCBibG9ja2VkIG9uIGByZWFkZXIucmVhZCgpYCB3aXRoIG5vIHdhdGNoZG9nLCB3aGljaCBpc1xuICogdGhlIGZhaWx1cmUgYHRhaWxFdmVudHNgIGV4aXN0cyB0byBlbmQuIE5laXRoZXIgZmlsZSBjb3VsZCBpbXBvcnQgdGhlIG90aGVyLFxuICogYmVjYXVzZSB0aGUgQ0xJIHJlYWNoaW5nIGludG8gdGhlIGRhZW1vbiB3b3VsZCBkcmFnIHRoZSB3aG9sZSBzZXJ2ZXIgZ3JhcGhcbiAqIGludG8gYGRpc3QvY2xpLmpzYC4gQSBtb2R1bGUgd2hvc2Ugb25seSBpbXBvcnRzIGFyZSB0aGUga2l0J3MgZGVyaXZhdGlvbnMgaGFzXG4gKiBubyBzdWNoIGdyYXBoLCBzbyBib3RoIGhhbHZlcyBpbXBvcnQgdGhpcyBvbmUuIEEgdmFsdWUgdGhhdCBjb3VsZCBub3RcbiAqIHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKlxuICog4puUICoqQU5EIFRIRSBXQVRDSERPRyBJUyBERVJJVkVEIEZST00gSU1BR08nUyBPV04gSEVBUlRCRUFULCBORVZFUiBDT1BJRURcbiAqIEZST00gQSBTSUJMSU5HLioqIEFzdHJvbGFiZSBiZWF0cyBhdCAxMCBzIGFuZCBpbWFnbyBhdCAxNSBzLCBzbyBhIGhhcmQtY29kZWRcbiAqIHdhdGNoZG9nIGlzIGNvcnJlY3QgZm9yIGF0IG1vc3Qgb25lIG9mIHRoZW0uIEFzdHJvbGFiZSBtZWFzdXJlZCB3aGF0IGEgY29waWVkXG4gKiBudW1iZXIgZG9lczogYSA0NSBzIHdhdGNoZG9nIGFnYWluc3QgYW4gZW52LXR1bmVkIGhlYXJ0YmVhdCBwcm9kdWNlZFxuICogcmVjb25uZWN0cyBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3LjkgcyBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHlcbiAqIGRhZW1vbiwgaGFybWxlc3Mgb25seSBiZWNhdXNlIGFuIHVucmVsYXRlZCB0aGlyZCBjb25zdGFudCBhYnNvcmJlZCB0aGUgY2h1cm4uXG4gKiBgdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKWAgY2Fubm90IGRyaWZ0IGZyb20gdGhlIGJlYXQgaXQgaXMgd2F0Y2hpbmcsXG4gKiB3aGF0ZXZlciB0aGUgYmVhdCBiZWNvbWVzLlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgdGhlIENMSSBpcyBiYWNrIHRvIGRyYWdnaW5nIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqL1xuXG5pbXBvcnQge1xuICBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbiAgaGVhcnRiZWF0TXMsXG4gIGlkbGVUaW1lb3V0U2VjLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbiAgdGFpbElkbGVNcyxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hlYXJ0YmVhdC50c1wiO1xuXG4vKipcbiAqIEJ1bidzIG1heGltdW0sIGFuZCBpdCBpcyBpbWFnbydzIG93biBtZWFzdXJlZCB2YWx1ZSByYXRoZXIgdGhhbiBhbiBpbmhlcml0ZWRcbiAqIG9uZTogYHNlcnZlci50c2AgY2FycmllZCBgaWRsZVRpbWVvdXQ6IDI1NWAgdW5kZXIgYSBjb21tZW50IHJlY29yZGluZyB0aGF0XG4gKiBCdW4ncyBkZWZhdWx0IDEwIHMgY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmUgdGhlIDE1IHMga2VlcGFsaXZlXG4gKiBldmVyIGZpcmVzIOKAlCBcInRoZSBrZWVwYWxpdmUgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICoga2VlcGluZyBhbGl2ZSBpcyBnb25lXCIsIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBiZWF0IHJhdGUgd291bGQgbm90IGhhdmVcbiAqIGhlbHBlZC4gYElNQUdPX0lETEVfVElNRU9VVF9TRUNgIGlzIGFjY2VwdGVkIHNvIHRoZSBwYWlyIGNhbiBiZSB0dW5lZFxuICogVE9HRVRIRVI7IHRoZSBjbGFtcCBiZWxvdyBpcyB3aGF0IGtlZXBzIHRoZW0gYSBwYWlyLlxuICovXG5leHBvcnQgY29uc3QgSURMRV9USU1FT1VUX1NFQyA9IGlkbGVUaW1lb3V0U2VjKFxuICBwcm9jZXNzLmVudi5JTUFHT19JRExFX1RJTUVPVVRfU0VDLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbik7XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQg4oCUIGltYWdvJ3Mgb3duIGxpdGVyYWwgMTUgcyBiZWZvcmUgdGhpcyBmaWxlIGV4aXN0ZWQsIG5vd1xuICogQ0xBTVBFRCB0byBoYWxmIHRoZSBpZGxlIHRpbWVvdXQuXG4gKlxuICog4puUIFRIRSBDTEFNUCBJUyBUSEUgRklYIEZPUiBUSEUgQlVHIFRISVMgU1BFTEwgQUxSRUFEWSBQQUlEIEZPUi4gVGhlIG9sZCBjb2RlXG4gKiB3cm90ZSAxNSBzIGFuZCAyNTUgcyBpbiB0d28gZGlmZmVyZW50IGZ1bmN0aW9ucyBhbmQgcmVjb3JkZWQgdGhlIHJlbGF0aW9uc2hpcFxuICogb25seSBpbiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBEZXJpdmluZyBpdFxuICogbWFrZXMgYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIHRydWUgZm9yIEFOWSBjb25maWd1cmVkIHBhaXIuXG4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gaGVhcnRiZWF0TXMoXG4gIHByb2Nlc3MuZW52LklNQUdPX0hFQVJUQkVBVF9NUyxcbiAgSURMRV9USU1FT1VUX1NFQyxcbiAgREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pO1xuXG4vKipcbiAqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMsIERFUklWRUQuXG4gKlxuICog4pqgIDQ1LDAwMCBtcyBhdCB0aGUgZGVmYXVsdHMuIGltYWdvJ3MgQ0xJIGhhcyBubyBgLS1zdGFydC10aW1lb3V0YDsgdGhlIG51bWJlclxuICogaXQgbWlnaHQgYmUgY29uZnVzZWQgd2l0aCBpcyBgY21kT3BlbmAncyA1LDAwMCBtcyBzdGFydCBkZWFkbGluZSwgd2hpY2ggaXMgYVxuICogZGlmZmVyZW50IHF1YW50aXR5IGVudGlyZWx5IOKAlCBvbmUgYm91bmRzIGEgZmlyc3QgYnVuZGxlIGJ1aWxkLCB0aGUgb3RoZXJcbiAqIGJvdW5kcyBhIHNpbGVudCBzb2NrZXQuIE5hbWVkIGhlcmUgc28gbm9ib2R5IGxhdGVyIFwiZGUtZHVwbGljYXRlc1wiIHRoZW0uXG4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpO1xuIiwKICAgICIvLyBzaGFyZWQvaW1hZ2VPcHRpbWl6ZS50c1xuLy8gQnJvd3Nlci1zYWZlIGltYWdlLW9wdGltaXphdGlvbiBQT0xJQ1ksIHVzZWQgYnkgQk9USCBzaWRlcyDigJQgdGhlIGJyb3dzZXIgZHJvcFxuLy8gcGF0aCAoc3VyZmFjZS9zdGF0ZS9maWxlSW50YWtlLnRzKSBhbmQgdGhlIGRhZW1vbiB2YXJpYW50IHBhdGhcbi8vIChzY3JpcHRzL2ltYWdlT3B0aW1pemUuc2VydmVyLnRzKS4gVHdvLXNpZGVkIGJ5IFIxJ3MgdGVzdCwgc28gaXQgbGl2ZXMgaW5cbi8vIHNoYXJlZC8gcmF0aGVyIHRoYW4gd2l0aCBlaXRoZXIgY29uc3VtZXIuIE5vIG5hdGl2ZSBkZXBzIGhlcmUg4oCUIHNhZmUgdG9cbi8vIGltcG9ydCBpbnRvIHRoZSBSZWFjdCBidW5kbGUuIFRoZSBCdW4uSW1hZ2UgaW1wbGVtZW50YXRpb24gdGhhdCBhcHBsaWVzIHRoaXNcbi8vIHBvbGljeSBsaXZlcyBpbiBzY3JpcHRzL2ltYWdlT3B0aW1pemUuc2VydmVyLnRzLlxuZXhwb3J0IGNvbnN0IE9QVElNSVpFID0geyBtYXhEaW06IDEyMDAsIHF1YWxpdHk6IDAuODUgfSBhcyBjb25zdDtcbiIsCiAgICAiLy8gc2NyaXB0cy9pbWFnZU9wdGltaXplLnNlcnZlci50c1xuLy8gRGFlbW9uLW9ubHk6IG5hdGl2ZSBCdW4uSW1hZ2UgZG93bnNjYWxlK3dlYnAuIEl0IGxpdmVzIGluIHNjcmlwdHMvIGJlY2F1c2Vcbi8vIG9ubHkgdGhlIGRhZW1vbiBleGVjdXRlcyBpdCAoUjEncyB0aHJlZS13YXkgc29ydCDigJQgdGhlIGAuc2VydmVyLnRzYCBzdWZmaXhcbi8vIGFscmVhZHkgc2FpZCBzbyk7IHRoZSBQT0xJQ1kgaXQgYXBwbGllcyBpcyB0d28tc2lkZWQgYW5kIGxpdmVzIGluIHNoYXJlZC8uXG4vLyBEbyBOT1QgaW1wb3J0IHRoaXMgZnJvbSBicm93c2VyIGNvZGUgKEJ1bi5JbWFnZSBpcyBhIEJ1biBydW50aW1lIGJ1aWx0LWluLFxuLy8gYWJzZW50IGluIHRoZSBicm93c2VyKS4gQnJvd3NlciBjb2RlIGltcG9ydHMgT1BUSU1JWkUgZnJvbSBzaGFyZWQvaW1hZ2VPcHRpbWl6ZS5cbmltcG9ydCB7IE9QVElNSVpFIH0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9pbWFnby9zaGFyZWQvaW1hZ2VPcHRpbWl6ZVwiO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gb3B0aW1pemVJbWFnZUJ1ZmZlcihcbiAgaW5wdXQ6IFVpbnQ4QXJyYXksXG4pOiBQcm9taXNlPHsgZGF0YTogVWludDhBcnJheTsgbWltZTogXCJpbWFnZS93ZWJwXCIgfT4ge1xuICBjb25zdCBkYXRhID0gYXdhaXQgbmV3IEJ1bi5JbWFnZShpbnB1dClcbiAgICAucmVzaXplKE9QVElNSVpFLm1heERpbSwgT1BUSU1JWkUubWF4RGltLCB7XG4gICAgICBmaXQ6IFwiaW5zaWRlXCIsXG4gICAgICB3aXRob3V0RW5sYXJnZW1lbnQ6IHRydWUsXG4gICAgfSlcbiAgICAud2VicCh7IHF1YWxpdHk6IE1hdGgucm91bmQoT1BUSU1JWkUucXVhbGl0eSAqIDEwMCkgfSlcbiAgICAuYnl0ZXMoKTtcbiAgcmV0dXJuIHsgZGF0YTogbmV3IFVpbnQ4QXJyYXkoZGF0YSksIG1pbWU6IFwiaW1hZ2Uvd2VicFwiIH07XG59XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7OztBQTRCQSx1QkFBUyx3Q0FBdUIseUJBQWMsdUJBQVEsOEJBQVk7QUFDbEU7QUFDQSwwQkFBa0I7QUFDbEI7QUFDQTs7O0FDcUpPLElBQU0sYUFBc0M7QUFBQSxFQUNqRDtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNGO0FBK01PLElBQU0sb0JBQW9CLE9BQU8sT0FBTztBQUFBLEVBQzdDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0YsQ0FBVTtBQTBDVixJQUFNLHNCQUFzQixDQUFDLFNBQVMsYUFBYSxhQUFhLE1BQU0sY0FBYyxVQUFVO0FBRXZGLElBQU0sVUFBVSxDQUFDLFNBQWlCLFNBQVMsS0FBSyxLQUFLLEVBQUUsWUFBWSxFQUFFLFFBQVEsUUFBUSxHQUFHO0FBRS9GLElBQU0sa0JBQWtDO0FBQUEsRUFDdEM7QUFBQSxJQUNFLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOLFNBQVM7QUFBQSxFQUNYO0FBQUEsRUFDQTtBQUFBLElBQ0UsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sU0FBUztBQUFBLEVBQ1g7QUFBQSxFQUNBO0FBQUEsSUFDRSxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixNQUFNO0FBQUEsSUFDTixTQUFTO0FBQUEsRUFDWDtBQUNGO0FBRU8sU0FBUyxZQUFZLENBQUMsT0FBMkI7QUFBQSxFQUN0RCxPQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0EsU0FBUyxDQUFDO0FBQUEsSUFDVixPQUFPO0FBQUEsSUFDUCxjQUFjLENBQUM7QUFBQSxJQUNmLFNBQVM7QUFBQSxNQUNQLEdBQUcsZ0JBQWdCLElBQUksQ0FBQyxPQUFPLEtBQUssRUFBRSxFQUFFO0FBQUEsTUFDeEMsR0FBRyxvQkFBb0IsSUFBSSxDQUFDLFVBQVU7QUFBQSxRQUNwQyxJQUFJLFFBQVEsSUFBSTtBQUFBLFFBQ2hCLE1BQU07QUFBQSxRQUNOO0FBQUEsUUFDQSxTQUFTO0FBQUEsTUFDWCxFQUFFO0FBQUEsSUFDSjtBQUFBLElBQ0Esa0JBQWtCLENBQUM7QUFBQSxJQUNuQixnQkFBZ0IsZ0JBQWdCLElBQUksQ0FBQyxNQUFNLEVBQUUsRUFBRTtBQUFBLElBQy9DLE1BQU0sQ0FBQztBQUFBLElBQ1AsZ0JBQWdCLENBQUM7QUFBQSxJQUNqQixpQkFBaUIsQ0FBQztBQUFBLElBQ2xCLGVBQWUsQ0FBQztBQUFBLElBQ2hCLFFBQVE7QUFBQSxJQUNSLE1BQU07QUFBQSxJQUNOLFFBQVEsRUFBRSxNQUFNLE9BQU8sTUFBTSxHQUFHO0FBQUEsSUFDaEMsTUFBTTtBQUFBLElBQ04sU0FBUztBQUFBLElBQ1QsU0FBUyxFQUFFLFNBQVMsT0FBTyxTQUFTLE1BQU07QUFBQSxJQUMxQyxhQUFhO0FBQUEsRUFDZjtBQUFBOzs7QUN4ZUY7QUFxQk8sU0FBUyxlQUFlLENBQUMsUUFBZ0IsTUFBb0I7QUFBQSxFQUNsRSxNQUFNLE1BQU0sR0FBRyxVQUFVLFFBQVE7QUFBQSxFQUNqQyxJQUFJO0FBQUEsSUFDRixjQUFjLEtBQUssSUFBSTtBQUFBLElBQ3ZCLFdBQVcsS0FBSyxNQUFNO0FBQUEsSUFDdEIsT0FBTyxLQUFLO0FBQUEsSUFDWixJQUFJO0FBQUEsTUFDRixPQUFPLEtBQUssRUFBRSxPQUFPLEtBQUssQ0FBQztBQUFBLE1BQzNCLE1BQU07QUFBQSxJQUdSLE1BQU07QUFBQTtBQUFBO0FBcUJILFNBQVMsZUFBZSxDQUM3QixNQUNBLFVBQ0EsV0FBMkMsQ0FBQyxRQUFRLElBQUksS0FBSyxHQUNwRDtBQUFBLEVBQ1QsSUFBSTtBQUFBLElBQ0YsSUFBSSxDQUFDLFdBQVcsSUFBSTtBQUFBLE1BQUcsT0FBTztBQUFBLElBQzlCLElBQUksU0FBUyxhQUFhLE1BQU0sTUFBTSxDQUFDLE1BQU07QUFBQSxNQUFVLE9BQU87QUFBQSxJQUM5RCxXQUFXLElBQUk7QUFBQSxJQUNmLE9BQU87QUFBQSxJQUNQLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQTtBQUFBOzs7QUMxQ0osSUFBTSxxQkFBcUI7QUEyQjNCLFNBQVMsY0FBZ0MsQ0FDOUMsT0FBZ0QsQ0FBQyxHQUNwQztBQUFBLEVBQ2IsTUFBTSxhQUFhLEtBQUssY0FBYztBQUFBLEVBQ3RDLE1BQU0sUUFBUSxLQUFLO0FBQUEsRUFDbkIsTUFBTSxTQUEwQixDQUFDO0FBQUEsRUFDakMsTUFBTSxZQUFZLElBQUk7QUFBQSxFQUN0QixJQUFJLE1BQU07QUFBQSxFQUVWLE9BQU87QUFBQSxJQUNMO0FBQUEsSUFFQSxJQUFJLENBQUMsS0FBSztBQUFBLE1BQ1IsT0FBTztBQUFBLE1BVVAsTUFBTSxRQUFRLEVBQUUsSUFBSSxRQUFRLElBQUk7QUFBQSxNQUNoQyxNQUFNLEtBQUs7QUFBQSxNQUNYLElBQUksVUFBVTtBQUFBLFFBQVcsTUFBTSxRQUFRO0FBQUEsTUFFdkMsT0FBTyxLQUFLLEtBQUs7QUFBQSxNQUNqQixJQUFJLE9BQU8sU0FBUztBQUFBLFFBQVksT0FBTyxNQUFNO0FBQUEsTUFDN0MsV0FBVyxZQUFZO0FBQUEsUUFBVyxTQUFTLEtBQUs7QUFBQSxNQUNoRCxPQUFPO0FBQUE7QUFBQSxJQUdULFNBQVMsQ0FBQyxPQUFPLFVBQVU7QUFBQSxNQVV6QixNQUFNLE9BQU8sQ0FBQyxPQUFPLFNBQVMsS0FBSyxLQUFLLFFBQVEsTUFBTSxLQUFLO0FBQUEsTUFDM0QsV0FBVyxTQUFTLFFBQVE7QUFBQSxRQUMxQixJQUFJLE1BQU0sS0FBSztBQUFBLFVBQU0sU0FBUyxLQUFLO0FBQUEsTUFDckM7QUFBQSxNQUNBLFVBQVUsSUFBSSxRQUFRO0FBQUEsTUFDdEIsT0FBTyxNQUFNO0FBQUEsUUFDWCxVQUFVLE9BQU8sUUFBUTtBQUFBO0FBQUE7QUFBQSxJQUk3QixNQUFNLEdBQUc7QUFBQSxNQUNQLE9BQU87QUFBQTtBQUFBLEVBRVg7QUFBQTs7O0FDakZLLFNBQVMsZUFBZSxDQUM3QixpQkFDQSxRQUNBLFdBQ1M7QUFBQSxFQUNULElBQUksYUFBYTtBQUFBLElBQUcsT0FBTztBQUFBLEVBQzNCLElBQUksa0JBQWtCO0FBQUEsSUFBRyxPQUFPO0FBQUEsRUFDaEMsT0FBTyxVQUFVO0FBQUE7QUFrQ1osU0FBUyxpQkFBaUIsQ0FBQyxNQUF1QztBQUFBLEVBQ3ZFLE1BQU0sU0FBUyxLQUFLLFVBQVU7QUFBQSxFQUM5QixNQUFNLGFBQWEsS0FBSyxjQUFjO0FBQUEsRUFFdEMsTUFBTSxZQUFZLFlBQVksTUFBTTtBQUFBLElBQ2xDLE1BQU0sY0FBYyxLQUFLLGdCQUFnQjtBQUFBLElBQ3pDLElBQUksY0FBYztBQUFBLE1BQUcsS0FBSyxNQUFNO0FBQUEsSUFDaEMsSUFBSSxnQkFBZ0IsYUFBYSxLQUFLLE9BQU8sR0FBRyxLQUFLLFNBQVM7QUFBQSxNQUFHLEtBQUssWUFBWTtBQUFBLEtBQ2pGLE1BQU07QUFBQSxFQUVULE1BQU0sT0FBTyxLQUFLO0FBQUEsRUFDbEIsTUFBTSxZQUFZLE9BQ2QsWUFBWSxNQUFNO0FBQUEsSUFDaEIsSUFBSSxDQUFDLEtBQUssTUFBTTtBQUFBLE1BQUc7QUFBQSxJQUNuQixLQUFLLE1BQU07QUFBQSxJQUNOLEtBQUssTUFBTTtBQUFBLEtBQ2YsVUFBVSxJQUNiO0FBQUEsRUFFSixPQUFPLE1BQU07QUFBQSxJQUNYLGNBQWMsU0FBUztBQUFBLElBQ3ZCLElBQUksY0FBYztBQUFBLE1BQU0sY0FBYyxTQUFTO0FBQUE7QUFBQTtBQTBFbkQsZUFBc0IsWUFBWSxDQUFDLE1BQW1DO0FBQUEsRUFDcEUsTUFBTSxVQUFVLEtBQUssV0FBVztBQUFBLEVBQ2hDLE1BQU0sU0FBUyxLQUFLLFVBQVU7QUFBQSxFQUU5QixNQUFNLElBQUksUUFBUSxDQUFDLE1BQU0sV0FBVyxHQUFHLE9BQU8sQ0FBQztBQUFBLEVBRS9DLElBQUksS0FBSyxTQUFTO0FBQUEsSUFDaEIsV0FBVyxVQUFVLENBQUMsR0FBRyxLQUFLLE9BQU87QUFBQSxNQUFHLE9BQU8sTUFBTTtBQUFBLEVBQ3ZEO0FBQUEsRUFDQSxJQUFJLEtBQUssU0FBUztBQUFBLElBQ2hCLFdBQVcsTUFBTSxDQUFDLEdBQUcsS0FBSyxPQUFPLEdBQUc7QUFBQSxNQUNsQyxJQUFJO0FBQUEsUUFDRixHQUFHLE1BQU07QUFBQSxRQUNULE1BQU07QUFBQSxJQUdWO0FBQUEsRUFDRjtBQUFBLEVBRUEsTUFBTSxRQUFRLEtBQUs7QUFBQSxJQUNqQixRQUFRLFFBQVEsS0FBSyxPQUFPLEtBQUssSUFBSSxDQUFDO0FBQUEsSUFDdEMsSUFBSSxRQUFRLENBQUMsTUFBTSxXQUFXLEdBQUcsTUFBTSxDQUFDO0FBQUEsRUFDMUMsQ0FBQztBQUFBOzs7QUMzS0gsdUJBQVM7QUFDVDtBQThCTyxTQUFTLFdBQVcsQ0FBQyxTQUFvQztBQUFBLEVBQzlELE1BQU0sV0FBVyxRQUFRLElBQUk7QUFBQSxFQUM3QixJQUFJLGFBQWEsU0FBUyxhQUFhO0FBQUEsSUFBVyxPQUFPO0FBQUEsRUFDekQsT0FBTyxZQUFXLEtBQUssU0FBUyxZQUFZLENBQUMsSUFBSSxZQUFZO0FBQUE7QUFnQi9ELElBQU0sdUJBQStDO0FBQUEsRUFDbkQsU0FBUztBQUFBLEVBQ1QsT0FBTztBQUFBLEVBQ1AsUUFBUTtBQUFBLEVBQ1IsU0FBUztBQUFBLEVBQ1QsUUFBUTtBQUFBLEVBQ1IsUUFBUTtBQUNWO0FBSU8sU0FBUyxjQUFjLENBQUMsV0FBMkI7QUFBQSxFQUN4RCxNQUFNLE1BQU0sVUFBVSxZQUFZLEdBQUc7QUFBQSxFQUNyQyxNQUFNLE1BQU0sUUFBUSxLQUFLLEtBQUssVUFBVSxNQUFNLEdBQUc7QUFBQSxFQUNqRCxPQUFPLHFCQUFxQixRQUFRO0FBQUE7QUFpQi9CLFNBQVMsYUFBYSxDQUFDLFNBQWlCLEtBQThCO0FBQUEsRUFDM0UsSUFBSSxDQUFDLE9BQU8sSUFBSSxTQUFTLElBQUksS0FBSyxJQUFJLFNBQVMsR0FBRztBQUFBLElBQUcsT0FBTztBQUFBLEVBQzVELE1BQU0sT0FBTyxLQUFLLFNBQVMsR0FBRztBQUFBLEVBQzlCLElBQUksQ0FBQyxZQUFXLElBQUk7QUFBQSxJQUFHLE9BQU87QUFBQSxFQUM5QixPQUFPLElBQUksU0FBUyxJQUFJLEtBQUssSUFBSSxHQUFHLEVBQUUsU0FBUyxFQUFFLGdCQUFnQixlQUFlLEdBQUcsRUFBRSxFQUFFLENBQUM7QUFBQTs7O0FDYm5GLFNBQVMsV0FBNkIsQ0FBQyxNQUErQjtBQUFBLEVBQzNFLFFBQVEsS0FBSyxPQUFPLGFBQWEsU0FBUyxRQUFRLFFBQVEsUUFBUSxZQUFZO0FBQUEsRUFFOUUsSUFBSSxjQUFtQztBQUFBLEVBQ3ZDLElBQUksWUFBbUQ7QUFBQSxFQUN2RCxJQUFJLFNBQVM7QUFBQSxFQUliLE1BQU0sU0FBb0IsRUFBRSxPQUFPLE1BQU0sSUFBSSxNQUFNLE1BQU0sR0FBRztBQUFBLEVBRTVELE1BQU0sV0FBVyxNQUFNO0FBQUEsSUFDckIsSUFBSTtBQUFBLE1BQVE7QUFBQSxJQUNaLFNBQVM7QUFBQSxJQUNULElBQUksY0FBYztBQUFBLE1BQU0sY0FBYyxTQUFTO0FBQUEsSUFDL0MsY0FBYztBQUFBLElBQ2QsU0FBUyxPQUFPLE1BQU07QUFBQSxJQUN0QixVQUFVO0FBQUE7QUFBQSxFQUdaLE1BQU0sU0FBUyxJQUFJLGVBQWU7QUFBQSxJQUNoQyxLQUFLLENBQUMsWUFBWTtBQUFBLE1BQ2hCLE1BQU0sVUFBVSxJQUFJO0FBQUEsTUFDcEIsTUFBTSxjQUFjLENBQUMsVUFBa0I7QUFBQSxRQUNyQyxJQUFJO0FBQUEsVUFBUTtBQUFBLFFBQ1osSUFBSTtBQUFBLFVBQ0YsV0FBVyxRQUFRLFFBQVEsT0FBTyxLQUFLLENBQUM7QUFBQSxVQUN4QyxNQUFNO0FBQUEsVUFDTixTQUFTO0FBQUE7QUFBQTtBQUFBLE1BR2IsT0FBTyxRQUFRLE1BQU07QUFBQSxRQUNuQixTQUFTO0FBQUEsUUFDVCxJQUFJO0FBQUEsVUFDRixXQUFXLE1BQU07QUFBQSxVQUNqQixNQUFNO0FBQUE7QUFBQSxNQU9WLE9BQU8sT0FBTztBQUFBLE1BT2QsWUFBWTtBQUFBO0FBQUEsQ0FBaUI7QUFBQSxNQUU3QixjQUFjLElBQUksVUFBVSxPQUFPLENBQUMsVUFBVTtBQUFBLFFBQzVDLElBQUksVUFBVSxDQUFDLE9BQU8sS0FBSztBQUFBLFVBQUc7QUFBQSxRQUM5QixZQUFZLFNBQVMsS0FBSyxVQUFVLEtBQUs7QUFBQTtBQUFBLENBQU87QUFBQSxPQUNqRDtBQUFBLE1BRUQsWUFBWSxZQUFZLE1BQU0sWUFBWTtBQUFBO0FBQUEsQ0FBVSxHQUFHLFdBQVc7QUFBQSxNQUNsRSxRQUFRLGlCQUFpQixTQUFTLFVBQVUsRUFBRSxNQUFNLEtBQUssQ0FBQztBQUFBLE1BQzFELFNBQVMsSUFBSSxNQUFNO0FBQUEsTUFDbkIsU0FBUztBQUFBO0FBQUEsSUFFWCxNQUFNLEdBQUc7QUFBQSxNQUNQLFNBQVM7QUFBQTtBQUFBLEVBRWIsQ0FBQztBQUFBLEVBRUQsT0FBTyxJQUFJLFNBQVMsUUFBUTtBQUFBLElBQzFCLFNBQVM7QUFBQSxNQUNQLGdCQUFnQjtBQUFBLE1BQ2hCLGlCQUFpQjtBQUFBLE1BQ2pCLFlBQVk7QUFBQSxJQUNkO0FBQUEsRUFDRixDQUFDO0FBQUE7OztBQ3BJSSxJQUFNLHVCQUF1QjtBQUc3QixJQUFNLHVCQUF1QjtBQU83QixJQUFNLGVBQWU7QUFJNUIsU0FBUyxLQUFLLENBQUMsS0FBeUIsVUFBMEI7QUFBQSxFQUNoRSxNQUFNLElBQUksT0FBTyxTQUFTLE9BQU8sSUFBSSxFQUFFO0FBQUEsRUFDdkMsT0FBTyxPQUFPLFNBQVMsQ0FBQyxLQUFLLElBQUksSUFBSSxJQUFJO0FBQUE7QUFJcEMsU0FBUyxjQUFjLENBQUMsS0FBMEIsV0FBVyxzQkFBOEI7QUFBQSxFQUNoRyxPQUFPLEtBQUssSUFBSSxHQUFHLEtBQUssSUFBSSxzQkFBc0IsTUFBTSxLQUFLLFFBQVEsQ0FBQyxDQUFDO0FBQUE7QUFZbEUsU0FBUyxXQUFXLENBQ3pCLEtBQ0EsU0FDQSxXQUFXLHNCQUNIO0FBQUEsRUFDUixPQUFPLEtBQUssSUFBSSxNQUFNLEtBQUssUUFBUSxHQUFHLEtBQUssSUFBSSxLQUFLLEtBQUssTUFBTyxVQUFVLE9BQVEsQ0FBQyxDQUFDLENBQUM7QUFBQTtBQUloRixTQUFTLFVBQVUsQ0FBQyxRQUF3QjtBQUFBLEVBQ2pELE9BQU8sU0FBUztBQUFBOzs7QUNuQ1gsSUFBTSxtQkFBbUIsZUFDOUIsUUFBUSxJQUFJLHdCQUNaLG9CQUNGO0FBV08sSUFBTSxtQkFBbUIsWUFDOUIsUUFBUSxJQUFJLG9CQUNaLGtCQUNBLG9CQUNGO0FBVU8sSUFBTSxlQUFlLFdBQVcsZ0JBQWdCOzs7QUNsRWhELElBQU0sV0FBVyxFQUFFLFFBQVEsTUFBTSxTQUFTLEtBQUs7OztBQ0N0RCxlQUFzQixtQkFBbUIsQ0FDdkMsT0FDbUQ7QUFBQSxFQUNuRCxNQUFNLE9BQU8sTUFBTSxJQUFJLElBQUksTUFBTSxLQUFLLEVBQ25DLE9BQU8sU0FBUyxRQUFRLFNBQVMsUUFBUTtBQUFBLElBQ3hDLEtBQUs7QUFBQSxJQUNMLG9CQUFvQjtBQUFBLEVBQ3RCLENBQUMsRUFDQSxLQUFLLEVBQUUsU0FBUyxLQUFLLE1BQU0sU0FBUyxVQUFVLEdBQUcsRUFBRSxDQUFDLEVBQ3BELE1BQU07QUFBQSxFQUNULE9BQU8sRUFBRSxNQUFNLElBQUksV0FBVyxJQUFJLEdBQUcsTUFBTSxhQUFhO0FBQUE7OztBVnNDMUQsSUFBTSxhQUFhLFFBQVEsY0FBYyxZQUFZLEdBQUcsQ0FBQztBQWF6RCxJQUFNLGFBQWEsTUFBSyxZQUFZLElBQUk7QUFDeEMsSUFBTSxXQUFXLE1BQUssWUFBWSxNQUFNO0FBWXhDLFNBQVMsWUFBVyxHQUFzQjtBQUFBLEVBQ3hDLE9BQU8sWUFBYyxRQUFRO0FBQUE7QUFhL0IsU0FBUyxTQUFTLENBQUMsTUFBK0I7QUFBQSxFQUNoRCxPQUFPLGNBQWMsVUFBVSxTQUFTLE1BQU0sZUFBZSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7QUFJNUUsSUFBTSxhQUFhLFFBQVEsSUFBSSxjQUFjLE1BQUssUUFBUSxHQUFHLFFBQVE7QUFDckUsSUFBTSxnQkFBZ0IsTUFBSyxZQUFZLFdBQVc7QUFLbEQsSUFBTSxpQkFBaUI7QUFFdkIsU0FBUyxzQkFBc0IsQ0FBQyxLQUE0QjtBQUFBLEVBQzFELE1BQU0sSUFBSSxLQUFLLE1BQU0sY0FBYztBQUFBLEVBQ25DLElBQUksQ0FBQztBQUFBLElBQUcsT0FBTztBQUFBLEVBQ2YsTUFBTSxPQUFPLFNBQVMsRUFBRSxJQUFJLEVBQUU7QUFBQSxFQUM5QixPQUFPLFFBQVEsS0FBSyxRQUFRLFFBQVEsT0FBTztBQUFBO0FBRzdDLFNBQVMsT0FBTyxDQUFDLE9BQXVCO0FBQUEsRUFDdEMsTUFBTSxNQUFNLElBQUksV0FBVyxLQUFLO0FBQUEsRUFDaEMsT0FBTyxnQkFBZ0IsR0FBRztBQUFBLEVBQzFCLE9BQU8sTUFBTSxLQUFLLEtBQUssQ0FBQyxNQUFNLEVBQUUsU0FBUyxFQUFFLEVBQUUsU0FBUyxHQUFHLEdBQUcsQ0FBQyxFQUFFLEtBQUssRUFBRTtBQUFBO0FBR3hFLFNBQVMsS0FBSyxDQUFDLFFBQXdCO0FBQUEsRUFDckMsT0FBTyxHQUFHLFVBQVUsUUFBUSxDQUFDO0FBQUE7QUFLL0IsU0FBUyxXQUFXLENBQUMsR0FBbUI7QUFBQSxFQUN0QyxPQUFPLElBQUksSUFBSSxhQUFhLFFBQVEsRUFBRSxPQUFPLENBQUMsRUFBRSxPQUFPLEtBQUssRUFBRSxNQUFNLEdBQUcsRUFBRTtBQUFBO0FBRzNFLFNBQVMsV0FBVyxDQUFDLEtBQW1CO0FBQUEsRUFDdEMsTUFBTSxNQUNKLFFBQVEsYUFBYSxXQUNqQixDQUFDLFFBQVEsR0FBRyxJQUNaLFFBQVEsYUFBYSxVQUNuQixDQUFDLE9BQU8sTUFBTSxTQUFTLElBQUksR0FBRyxJQUM5QixDQUFDLFlBQVksR0FBRztBQUFBLEVBQ3hCLElBQUk7QUFBQSxJQUNGLElBQUksTUFBTSxFQUFFLEtBQUssUUFBUSxVQUFVLFFBQVEsU0FBUyxDQUFDO0FBQUEsSUFDckQsTUFBTTtBQUFBO0FBS1YsSUFBTSxjQUFzQztBQUFBLEVBQzFDLFNBQVM7QUFBQSxFQUNULFFBQVE7QUFBQSxFQUNSLE9BQU87QUFBQSxFQUNQLFNBQVM7QUFBQSxFQUNULFFBQVE7QUFBQSxFQUNSLFFBQVE7QUFBQSxFQUNSLFNBQVM7QUFBQSxFQUNULFFBQVE7QUFBQSxFQUNSLFFBQVE7QUFBQSxFQUNSLFNBQVM7QUFBQSxFQUNULFFBQVE7QUFBQSxFQUNSLFNBQVM7QUFBQSxFQUNULFVBQVU7QUFDWjtBQUNBLFNBQVMsU0FBUyxDQUFDLE1BQXNCO0FBQUEsRUFDdkMsTUFBTSxNQUFNLEtBQUssWUFBWSxHQUFHO0FBQUEsRUFDaEMsTUFBTSxNQUFNLE9BQU8sSUFBSSxLQUFLLE1BQU0sR0FBRyxFQUFFLFlBQVksSUFBSTtBQUFBLEVBQ3ZELE9BQU8sWUFBWSxRQUFRO0FBQUE7QUFHN0IsSUFBTSxjQUFzQztBQUFBLEVBQzFDLGFBQWE7QUFBQSxFQUNiLGNBQWM7QUFBQSxFQUNkLGFBQWE7QUFBQSxFQUNiLGNBQWM7QUFBQSxFQUNkLGFBQWE7QUFBQSxFQUNiLGlCQUFpQjtBQUNuQjtBQUlBLFNBQVMsV0FBVyxDQUFDLEtBQWEsSUFBWSxTQUF5QjtBQUFBLEVBQ3JFLE1BQU0sSUFBSSw4QkFBOEIsS0FBSyxPQUFPO0FBQUEsRUFDcEQsSUFBSSxDQUFDLEtBQUssQ0FBQztBQUFBLElBQUssT0FBTztBQUFBLEVBQ3ZCLE1BQU0sTUFBTSxZQUFZLEVBQUUsR0FBRyxZQUFZLE1BQU07QUFBQSxFQUcvQyxNQUFNLFNBQVMsR0FBRyxRQUFRLG1CQUFtQixHQUFHO0FBQUEsRUFDaEQsTUFBTSxPQUFPLE1BQUssS0FBSyxHQUFHLFNBQVMsS0FBSztBQUFBLEVBQ3hDLElBQUk7QUFBQSxJQUNGLGVBQWMsTUFBTSxPQUFPLEtBQUssRUFBRSxJQUFJLFFBQVEsQ0FBQztBQUFBLElBQy9DLE9BQU87QUFBQSxJQUNQLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQTtBQUFBO0FBTVgsU0FBUyxlQUFlLENBQUMsR0FBa0M7QUFBQSxFQUN6RCxRQUFRLEtBQUssVUFBVSxTQUFTO0FBQUEsRUFDaEMsT0FBTztBQUFBO0FBRVQsU0FBUyxhQUFhLENBQUMsR0FBMEU7QUFBQSxFQUMvRixPQUFPLEtBQUssR0FBRyxVQUFVLEVBQUUsU0FBUyxJQUFJLGVBQWUsRUFBRTtBQUFBO0FBRTNELFNBQVMsZUFBZSxDQUFDLEdBQThDO0FBQUEsRUFDckUsUUFBUSxPQUFPLFVBQVUsU0FBUztBQUFBLEVBQ2xDLE9BQU87QUFBQTtBQU1ULFNBQVMsWUFBWSxDQUFDLEdBQStEO0FBQUEsRUFDbkYsSUFBSSxFQUFFLFNBQVMsU0FBUztBQUFBLElBQ3RCLFFBQVEsS0FBSyxVQUFVLFNBQVM7QUFBQSxJQUNoQyxPQUFPO0FBQUEsRUFDVDtBQUFBLEVBQ0EsT0FBTztBQUFBO0FBR0YsU0FBUyxTQUFTLENBQUMsR0FBZTtBQUFBLEVBQ3ZDLE9BQU87QUFBQSxPQUNGO0FBQUEsSUFDSCxTQUFTLEVBQUUsUUFBUSxJQUFJLGFBQWE7QUFBQSxJQUNwQyxTQUFTLEVBQUUsUUFBUSxJQUFJLGVBQWU7QUFBQSxJQUN0QyxnQkFBZ0IsT0FBTyxZQUNyQixPQUFPLFFBQVEsRUFBRSxjQUFjLEVBQUUsSUFBSSxFQUFFLEtBQUssV0FBVyxDQUFDLEtBQUssTUFBTSxJQUFJLFlBQVksQ0FBQyxDQUFDLENBQ3ZGO0FBQUEsRUFDRjtBQUFBO0FBR0YsSUFBTSxvQkFBb0I7QUFLMUIsZUFBc0IsV0FBVyxDQUFDLEtBQThCO0FBQUEsRUFDOUQsTUFBTSxJQUFJLGtCQUFrQixLQUFLLEdBQUc7QUFBQSxFQUNwQyxJQUFJLENBQUM7QUFBQSxJQUFHLE9BQU87QUFBQSxFQUNmLElBQUk7QUFBQSxJQUNGLE1BQU0sUUFBUSxJQUFJLFdBQVcsT0FBTyxLQUFLLEVBQUUsSUFBSSxRQUFRLENBQUM7QUFBQSxJQUN4RCxRQUFRLFNBQVMsTUFBTSxvQkFBb0IsS0FBSztBQUFBLElBQ2hELE9BQU8sMEJBQTBCLE9BQU8sS0FBSyxJQUFJLEVBQUUsU0FBUyxRQUFRO0FBQUEsSUFDcEUsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBO0FBQUE7QUFJWCxTQUFTLFNBQVMsQ0FBQyxNQUFzQjtBQUFBLEVBQ3ZDLE9BQU8sS0FBSyxLQUFLLEVBQUUsWUFBWTtBQUFBO0FBR2pDLGVBQWUsSUFBSSxDQUFDLE1BQWlDO0FBQUEsRUFDbkQsSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLElBQ0YsU0FBUyxVQUFVO0FBQUEsTUFDakIsTUFBTTtBQUFBLE1BQ04sU0FBUztBQUFBLFFBQ1AsT0FBTyxFQUFFLE1BQU0sVUFBVSxTQUFTLFFBQVE7QUFBQSxRQUMxQyxTQUFTLEVBQUUsTUFBTSxVQUFVLFNBQVMsT0FBTztBQUFBLFFBQzNDLFdBQVcsRUFBRSxNQUFNLFdBQVcsU0FBUyxNQUFNO0FBQUEsUUFDN0MsTUFBTSxFQUFFLE1BQU0sVUFBVSxTQUFTLElBQUk7QUFBQSxRQUNyQyxNQUFNLEVBQUUsTUFBTSxVQUFVLFNBQVMsWUFBWTtBQUFBLFFBQzdDLElBQUksRUFBRSxNQUFNLFNBQVM7QUFBQSxRQUNyQixTQUFTLEVBQUUsTUFBTSxTQUFTO0FBQUEsTUFDNUI7QUFBQSxNQUNBLFFBQVE7QUFBQSxNQUNSLGtCQUFrQjtBQUFBLElBQ3BCLENBQUM7QUFBQSxJQUNELE9BQU8sR0FBRztBQUFBLElBQ1YsUUFBUSxPQUFPLE1BQU0sVUFBVSxhQUFhLFFBQVEsRUFBRSxVQUFVLE9BQU8sQ0FBQztBQUFBLENBQUs7QUFBQSxJQUM3RSxPQUFPO0FBQUE7QUFBQSxFQUVULE1BQU0sSUFBSSxPQUFPO0FBQUEsRUFDakIsTUFBTSxVQUFVLFdBQVcsRUFBRSxPQUFpQjtBQUFBLEVBQzlDLElBQUksT0FBTyxTQUFTLEVBQUUsTUFBZ0IsRUFBRTtBQUFBLEVBQ3hDLE1BQU0sT0FBTyxFQUFFO0FBQUEsRUFDZixJQUFJLFlBQWEsRUFBRSxNQUE2QjtBQUFBLEVBQ2hELElBQUksU0FBUyxLQUFLLFdBQVc7QUFBQSxJQUMzQixNQUFNLFdBQVcsdUJBQXVCLFNBQVM7QUFBQSxJQUNqRCxJQUFJLGFBQWE7QUFBQSxNQUFNLE9BQU87QUFBQSxFQUNoQztBQUFBLEVBRUEsTUFBTSxZQUFZLE1BQUssWUFBWSxNQUFNLFFBQVE7QUFBQSxFQUVqRCxJQUFJLFFBQVEsYUFBYSxFQUFFLEtBQWU7QUFBQSxFQUMxQyxJQUFJLFdBQVc7QUFBQSxFQU1mLE1BQU0sY0FBYztBQUFBLEVBS3BCLE1BQU0sY0FBc0UsQ0FBQztBQUFBLEVBQzdFLE1BQU0sVUFBVSxDQUFDLFFBQWlCLFlBQVksU0FBUyxFQUFFLE1BQU0sQ0FBQyxHQUFHLE1BQU0sQ0FBQyxFQUFFO0FBQUEsRUFJNUUsTUFBTSxhQUFzQyxDQUFDO0FBQUEsRUFDN0MsTUFBTSxVQUFVLENBQUMsU0FBMkI7QUFBQSxJQUMxQyxPQUFPLGdCQUFnQixNQUFNLGVBQWUsUUFBUSxDQUFDLENBQUM7QUFBQSxJQUN0RCxRQUFRLGdCQUFnQixNQUFNLGdCQUFnQixRQUFRLENBQUMsQ0FBQztBQUFBLEVBQzFEO0FBQUEsRUFDQSxNQUFNLGNBQWMsQ0FBQyxRQUE0QjtBQUFBLElBQy9DLElBQUksQ0FBQztBQUFBLE1BQUs7QUFBQSxJQUNWLFdBQVcsT0FBTztBQUFBLElBQ2xCLE1BQU0sSUFBSSxRQUFRLEdBQUc7QUFBQSxJQUNyQixFQUFFLEtBQUssS0FBSyxRQUFRLEdBQUcsQ0FBQztBQUFBLElBQ3hCLElBQUksRUFBRSxLQUFLLFNBQVM7QUFBQSxNQUFhLEVBQUUsS0FBSyxNQUFNO0FBQUEsSUFDOUMsRUFBRSxPQUFPLENBQUM7QUFBQTtBQUFBLEVBU1osTUFBTSxrQkFBa0IsQ0FBQyxRQUF3QjtBQUFBLElBQy9DLElBQUksQ0FBQyxNQUFNLGdCQUFnQjtBQUFBLE1BQU0sTUFBTSxnQkFBZ0IsT0FBTyxDQUFDO0FBQUEsSUFDL0QsTUFBTSxTQUFTLE1BQU0sZ0JBQWdCO0FBQUEsSUFDckMsU0FBUyxJQUFJLE9BQU8sU0FBUyxFQUFHLEtBQUssR0FBRyxLQUFLO0FBQUEsTUFDM0MsSUFBSSxPQUFPLEdBQUcsU0FBUztBQUFBLFFBQVMsT0FBTyxPQUFPLEdBQUc7QUFBQSxJQUNuRDtBQUFBLElBQ0EsTUFBTSxRQUFlLEVBQUUsSUFBSSxNQUFNLE9BQU8sR0FBRyxNQUFNLGVBQWUsTUFBTSxhQUFhO0FBQUEsSUFDbkYsT0FBTyxLQUFLLEtBQUs7QUFBQSxJQUNqQixPQUFPLE1BQU07QUFBQTtBQUFBLEVBR2YsU0FBUyxXQUFXLENBQUMsSUFBWSxLQUFpQjtBQUFBLElBQ2hELElBQUksQ0FBQyxNQUFNLFFBQVEsS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLEVBQUU7QUFBQSxNQUFHO0FBQUEsSUFDN0MsTUFBTSxNQUFNLFFBQVEsV0FBVyxNQUFNLG1CQUFtQixNQUFNO0FBQUEsSUFDOUQsSUFBSSxDQUFDLElBQUksU0FBUyxFQUFFO0FBQUEsTUFBRyxJQUFJLEtBQUssRUFBRTtBQUFBO0FBQUEsRUFFcEMsU0FBUyxhQUFhLENBQUMsSUFBWSxLQUFpQjtBQUFBLElBQ2xELElBQUksUUFBUTtBQUFBLE1BQVUsTUFBTSxtQkFBbUIsTUFBTSxpQkFBaUIsT0FBTyxDQUFDLE1BQU0sTUFBTSxFQUFFO0FBQUEsSUFDdkY7QUFBQSxZQUFNLGlCQUFpQixNQUFNLGVBQWUsT0FBTyxDQUFDLE1BQU0sTUFBTSxFQUFFO0FBQUE7QUFBQSxFQWtEekUsU0FBUyxlQUFlLENBQUMsS0FNSjtBQUFBLElBQ25CLElBQUksT0FBTyxJQUFJLFNBQVMsWUFBWSxDQUFDLElBQUksS0FBSyxLQUFLO0FBQUEsTUFDakQsT0FBTyxFQUFFLElBQUksT0FBTyxPQUFPLHdDQUF3QztBQUFBLElBQ3JFLE1BQU0sVUFBVSxPQUFPLElBQUksWUFBWSxXQUFXLElBQUksVUFBVTtBQUFBLElBQ2hFLE1BQU0sT0FBTyxNQUFNLFFBQVEsSUFBSSxJQUFJLElBQUksSUFBSSxPQUFPO0FBQUEsSUFDbEQsTUFBTSxXQUNKLE9BQU8sSUFBSSxVQUFVLFlBQVksSUFBSSxNQUFNLFdBQVcsT0FBTyxJQUFJLElBQUksUUFBUTtBQUFBLElBQy9FLE1BQU0sWUFBWSxXQUNkLFlBQVksaUJBQWlCLE1BQU0sS0FBSyxHQUFHLFFBQVEsS0FBSyxZQUN4RDtBQUFBLElBQ0osSUFBSSxJQUFJLFNBQVMsU0FBUztBQUFBLE1BQ3hCLE1BQU0sT0FBTyxVQUFVLElBQUksSUFBSTtBQUFBLE1BQy9CLE1BQU0sV0FBVyxNQUFNLFFBQVEsS0FBSyxDQUFDLE1BQU0sRUFBRSxTQUFTLFdBQVcsVUFBVSxFQUFFLElBQUksTUFBTSxJQUFJO0FBQUEsTUFDM0YsSUFBSSxVQUFVO0FBQUEsUUFVWixNQUFNLFVBQW9CLENBQUM7QUFBQSxRQUMzQixNQUFNLFdBQW9DLENBQUM7QUFBQSxRQUMzQyxJQUFJLFdBQVcsWUFBWSxTQUFTLFNBQVM7QUFBQSxVQUMzQyxRQUFRLEtBQUssU0FBUztBQUFBLFVBQ3RCLFNBQVMsVUFBVSxTQUFTO0FBQUEsVUFDNUIsU0FBUyxVQUFVO0FBQUEsUUFDckI7QUFBQSxRQUNBLElBQUksUUFBUSxLQUFLLFVBQVUsSUFBSSxNQUFNLEtBQUssVUFBVSxTQUFTLElBQUksR0FBRztBQUFBLFVBQ2xFLFFBQVEsS0FBSyxNQUFNO0FBQUEsVUFDbkIsU0FBUyxPQUFPLFNBQVM7QUFBQSxVQUN6QixTQUFTLE9BQU87QUFBQSxRQUNsQjtBQUFBLFFBQ0EsSUFBSSxZQUFZLGFBQWEsU0FBUyxPQUFPO0FBQUEsVUFDM0MsUUFBUSxLQUFLLE9BQU87QUFBQSxVQUtwQixTQUFTLFFBQVEsU0FBUyxhQUFhO0FBQUEsVUFDdkMsU0FBUyxRQUFRO0FBQUEsVUFDakIsU0FBUyxZQUFZO0FBQUEsVUFDckIsU0FBUyxXQUFXO0FBQUEsUUFDdEI7QUFBQSxRQUdBLElBQUksQ0FBQyxRQUFRO0FBQUEsVUFBUSxPQUFPLEVBQUUsSUFBSSxNQUFNLElBQUksU0FBUyxJQUFJLFNBQVMsbUJBQW1CO0FBQUEsUUFDckYsT0FBTyxFQUFFLElBQUksTUFBTSxJQUFJLFNBQVMsSUFBSSxTQUFTLFdBQVcsU0FBUyxTQUFTO0FBQUEsTUFDNUU7QUFBQSxNQUNBLE1BQU0sTUFBSyxNQUFNLEtBQUs7QUFBQSxNQUN0QixNQUFNLFFBQVEsS0FBSztBQUFBLFFBQ2pCO0FBQUEsUUFDQSxNQUFNO0FBQUEsUUFDTjtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQSxPQUFPO0FBQUEsUUFDUDtBQUFBLFFBQ0EsVUFBVSxXQUFXLE9BQU87QUFBQSxNQUM5QixDQUFDO0FBQUEsTUFDRCxPQUFPLEVBQUUsSUFBSSxNQUFNLFNBQUksU0FBUyxVQUFVO0FBQUEsSUFDNUM7QUFBQSxJQUNBLE1BQU0sS0FBSyxNQUFNLEtBQUs7QUFBQSxJQUN0QixNQUFNLFFBQVEsS0FBSztBQUFBLE1BQ2pCO0FBQUEsTUFDQSxNQUFNLElBQUk7QUFBQSxNQUNWLE1BQU0sSUFBSSxLQUFLLEtBQUs7QUFBQSxNQUNwQjtBQUFBLE1BQ0E7QUFBQSxNQUNBLE9BQU87QUFBQSxNQUNQO0FBQUEsSUFDRixDQUFDO0FBQUEsSUFDRCxPQUFPLEVBQUUsSUFBSSxNQUFNLElBQUksU0FBUyxVQUFVO0FBQUE7QUFBQSxFQUk1QyxNQUFNLGNBQWMsQ0FBQyxTQUNuQixTQUFTLFVBQVUsVUFBVSxTQUFTLFNBQVMsV0FBVztBQUFBLEVBQzVELE1BQU0sYUFBMkM7QUFBQSxJQUMvQyxLQUFLO0FBQUEsSUFDTCxPQUFPO0FBQUEsSUFDUCxNQUFNO0FBQUEsSUFDTixNQUFNO0FBQUEsSUFDTixTQUFTO0FBQUEsSUFDVCxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsRUFDVDtBQUFBLEVBQ0EsSUFBSSxFQUFFLFNBQVM7QUFBQSxJQUNiLE1BQU0sY0FBYyxZQUFXLEVBQUUsT0FBaUIsSUFDN0MsRUFBRSxVQUNILE1BQUssZUFBZSxHQUFHLEVBQUUsY0FBYztBQUFBLElBQzNDLElBQUk7QUFBQSxNQUNGLE1BQU0sT0FBTyxLQUFLLE1BQU0sY0FBYSxhQUFhLE1BQU0sQ0FBQztBQUFBLE1BRXpELFFBQVEsS0FBSyxhQUFhLEVBQUUsS0FBZSxNQUFNLEtBQUs7QUFBQSxNQUN0RCxXQUFXO0FBQUEsTUFDWCxPQUFPLEdBQUc7QUFBQSxNQUNWLFFBQVEsT0FBTyxNQUNiLDBCQUEwQixpQkFBaUIsYUFBYSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUM7QUFBQSxDQUN0RjtBQUFBO0FBQUEsRUFFSjtBQUFBLEVBQ0EsTUFBTSxVQUFVLElBQUk7QUFBQSxFQTRCcEIsTUFBTSxNQUFNLGVBQXdDO0FBQUEsRUFDcEQsTUFBTSxhQUF5QixJQUFJO0FBQUEsRUFFbkMsSUFBSTtBQUFBLEVBQ0osSUFBSSxVQUFVO0FBQUEsRUFDZCxNQUFNLE9BQU8sSUFBSSxRQUFvQixDQUFDLFFBQVE7QUFBQSxJQUM1QyxjQUFjLENBQUMsUUFBUTtBQUFBLE1BQ3JCLElBQUk7QUFBQSxRQUFTO0FBQUEsTUFDYixVQUFVO0FBQUEsTUFDVixJQUFJLEdBQUc7QUFBQTtBQUFBLEdBRVY7QUFBQSxFQUVELElBQUksZUFBZSxZQUFZLElBQUk7QUFBQSxFQUNuQyxNQUFNLFFBQVEsTUFBTTtBQUFBLElBQ2xCLGVBQWUsWUFBWSxJQUFJO0FBQUE7QUFBQSxFQUdqQyxNQUFNLFlBQVksQ0FBQyxRQUFpQyxJQUFJLEtBQUssR0FBRztBQUFBLEVBYWhFLE1BQU0sZ0JBQWdCLENBQUMsUUFBaUM7QUFBQSxJQUN0RCxNQUFNLFFBQVEsU0FBUyxLQUFLLFVBQVUsR0FBRztBQUFBO0FBQUE7QUFBQSxJQUN6QyxXQUFXLEtBQUs7QUFBQSxNQUFZLEVBQUUsS0FBSyxLQUFLO0FBQUE7QUFBQSxFQUcxQyxTQUFTLFNBQVMsQ0FBQyxLQUFhO0FBQUEsSUFDOUIsTUFBTSxJQUFJLEtBQUssVUFBVSxHQUFHO0FBQUEsSUFDNUIsV0FBVyxNQUFNLFNBQVM7QUFBQSxNQUN4QixJQUFJO0FBQUEsUUFDRixHQUFHLEtBQUssQ0FBQztBQUFBLFFBQ1QsTUFBTTtBQUFBLElBR1Y7QUFBQTtBQUFBLEVBRUYsSUFBSSxZQUFZO0FBQUEsRUFDaEIsTUFBTSxpQkFBaUIsTUFBTTtBQUFBLElBQzNCLFlBQVk7QUFBQSxJQUdaLE1BQU0sSUFBSSxNQUFNLFFBQVEsWUFBWSxNQUFNLE1BQU0sYUFBYTtBQUFBLElBQzdELE1BQU0sVUFBVSxFQUFFLFVBQVUsR0FBRyxLQUFLLFVBQVUsS0FBSyxHQUFHLFVBQVUsR0FBRyxLQUFLLFVBQVUsS0FBSyxFQUFFO0FBQUEsSUFDekYsTUFBTSxjQUFjLE1BQU0sUUFBUyxXQUFXLE1BQU0sTUFBTSxjQUFjLFFBQVM7QUFBQSxJQUNqRixVQUFVLEVBQUUsTUFBTSxTQUFTLE1BQU0sQ0FBQztBQUFBO0FBQUEsRUFHcEMsSUFBSSxrQkFBa0I7QUFBQSxFQUN0QixNQUFNLGVBQWUsTUFBTTtBQUFBLElBQ3pCLElBQUk7QUFBQSxNQUNGLFVBQVUsZUFBZSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQUEsTUFDNUMsZUFBYyxNQUFLLGVBQWUsR0FBRyxnQkFBZ0IsR0FBRyxLQUFLLFVBQVUsS0FBSyxDQUFDO0FBQUEsTUFDN0UsTUFBTTtBQUFBO0FBQUEsRUFNVixNQUFNLFlBQVksQ0FBQyxPQUFlLE1BQU0sUUFBUSxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sRUFBRTtBQUFBLEVBQ3ZFLFNBQVMsV0FBVyxDQUFDLElBQXNFO0FBQUEsSUFDekYsV0FBVyxLQUFLLE1BQU0sU0FBUztBQUFBLE1BQzdCLE1BQU0sUUFBUSxFQUFFLFNBQVMsVUFBVSxDQUFDLE1BQU0sRUFBRSxPQUFPLEVBQUU7QUFBQSxNQUNyRCxJQUFJLFNBQVM7QUFBQSxRQUFHLE9BQU8sRUFBRSxPQUFPLEdBQUcsU0FBUyxFQUFFLFNBQVMsUUFBUSxNQUFNO0FBQUEsSUFDdkU7QUFBQSxJQUNBLE9BQU87QUFBQTtBQUFBLEVBRVQsTUFBTSxVQUFVLENBQUMsTUFBYyxPQUFPLGFBQWEsS0FBSyxDQUFDO0FBQUEsRUFHekQsTUFBTSxpQkFBaUIsTUFDckIsTUFBTSxRQUNILFFBQVEsQ0FBQyxNQUFNLEVBQUUsUUFBUSxFQUN6QixPQUFPLENBQUMsT0FBTSxHQUFFLFdBQVcsRUFDM0IsSUFBSSxDQUFDLE9BQU0sR0FBRSxFQUFFO0FBQUEsRUFLcEIsU0FBUyxrQkFBa0IsQ0FBQyxLQUFhLE1BQXNEO0FBQUEsSUFDN0YsTUFBTSxPQUFPLFlBQVksR0FBRztBQUFBLElBQzVCLFdBQVcsS0FBSyxNQUFNLFNBQVM7QUFBQSxNQUM3QixNQUFNLEtBQUssRUFBRSxTQUFTLEtBQUssQ0FBQyxPQUFNLEdBQUUsU0FBUyxJQUFJO0FBQUEsTUFDakQsSUFBSSxJQUFJO0FBQUEsUUFDTixJQUFJLFFBQVEsQ0FBQyxHQUFHO0FBQUEsVUFBTSxHQUFHLE9BQU87QUFBQSxRQUNoQyxPQUFPLEVBQUUsU0FBUyxFQUFFLElBQUksU0FBUyxHQUFHO0FBQUEsTUFDdEM7QUFBQSxJQUNGO0FBQUEsSUFDQSxNQUFNLE1BQU0sTUFBTSxHQUFHO0FBQUEsSUFDckIsTUFBTSxVQUFVLE1BQU0sR0FBRztBQUFBLElBQ3pCLE1BQU0sVUFBbUI7QUFBQSxNQUN2QixJQUFJO0FBQUEsTUFDSjtBQUFBLE1BQ0EsTUFBTSxZQUFZLGlCQUFpQixLQUFLLEdBQUc7QUFBQSxNQUMzQyxPQUFPO0FBQUEsTUFDUCxVQUFVLE1BQU0sY0FBYyxTQUFTO0FBQUEsTUFDdkM7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUFBLElBQ0EsTUFBTSxRQUFRLEtBQUssRUFBRSxJQUFJLFNBQVMsTUFBTSxVQUFVLFFBQVEsSUFBSSxLQUFLLE1BQU0sVUFBVSxDQUFDLE9BQU8sRUFBRSxDQUFDO0FBQUEsSUFDOUYsT0FBTyxFQUFFLFNBQVMsUUFBUTtBQUFBO0FBQUEsRUFFNUIsU0FBUyxXQUFXLENBQUMsR0FBaUQ7QUFBQSxJQUNwRSxNQUFNLE1BQWUsRUFBRSxJQUFJLEVBQUUsTUFBTSxNQUFNLEdBQUcsR0FBRyxJQUFJLEtBQUssSUFBSSxNQUFNLEVBQUU7QUFBQSxJQUNwRSxNQUFNLGFBQWEsS0FBSyxHQUFHO0FBQUEsSUFDM0IsT0FBTztBQUFBO0FBQUEsRUE2QlQsZUFBZSxjQUFjLENBQUMsS0FBcUQ7QUFBQSxJQUNqRixNQUFNLElBQUksSUFBSTtBQUFBLElBQ2QsSUFBSSxNQUFNLFFBQVE7QUFBQSxNQUNoQixJQUFJLE9BQU8sSUFBSSxVQUFVO0FBQUEsUUFBVSxNQUFNLFFBQVEsSUFBSTtBQUFBLE1BQ3JELGVBQWU7QUFBQSxJQUNqQixFQUFPLFNBQUksTUFBTSxPQUFPO0FBQUEsTUFDdEIsSUFBSSxPQUFPLElBQUksU0FBUyxZQUFZLElBQUksTUFBTTtBQUFBLFFBQzVDLFlBQVksRUFBRSxNQUFNLFNBQVMsTUFBTSxRQUFRLE1BQU0sSUFBSSxLQUFLLENBQUM7QUFBQSxRQUMzRCxlQUFlO0FBQUEsTUFDakI7QUFBQSxJQUNGLEVBQU8sU0FBSSxNQUFNLFdBQVc7QUFBQSxNQUMxQixJQUFJLE9BQU8sSUFBSSxXQUFXLFlBQVksSUFBSSxRQUFRO0FBQUEsUUFDaEQsTUFBTSxJQUFJLE9BQU8sSUFBSSxNQUFNLFlBQVksSUFBSSxJQUFJLElBQUksS0FBSyxJQUFJLEdBQUcsS0FBSyxNQUFNLElBQUksQ0FBQyxDQUFDLElBQUk7QUFBQSxRQUdwRixZQUFZO0FBQUEsVUFDVixNQUFNO0FBQUEsVUFDTixNQUFNO0FBQUEsVUFDTixNQUFNO0FBQUEsVUFDTixVQUFVLEVBQUUsUUFBUSxJQUFJLFFBQVEsR0FBRyxRQUFRLFVBQVU7QUFBQSxRQUN2RCxDQUFDO0FBQUEsUUFDRCxlQUFlO0FBQUEsTUFDakI7QUFBQSxJQUNGLEVBQU8sU0FBSSxNQUFNLE9BQU87QUFBQSxNQUN0QixJQUFJLE9BQU8sSUFBSSxTQUFTLFlBQVksSUFBSSxNQUFNO0FBQUEsUUFDNUMsWUFBWTtBQUFBLFVBQ1YsTUFBTTtBQUFBLFVBQ04sTUFBTTtBQUFBLFVBQ04sTUFBTSxJQUFJO0FBQUEsVUFDVixTQUFTLE1BQU0sUUFBUSxJQUFJLE9BQU8sSUFBSyxJQUFJLFVBQXVCO0FBQUEsUUFDcEUsQ0FBQztBQUFBLFFBQ0QsZUFBZTtBQUFBLE1BQ2pCO0FBQUEsSUFDRixFQUFPLFNBQUksTUFBTSxhQUFhO0FBQUEsTUFDNUIsTUFBTSxhQUFhLE1BQU0sUUFBUSxJQUFJLFFBQVEsSUFDeEMsSUFBSSxXQUNMLENBQUM7QUFBQSxNQUNMLElBQUksV0FBVyxXQUFXO0FBQUEsUUFBRyxPQUFPO0FBQUEsTUFDcEMsTUFBTSxVQUFVLE1BQU0sR0FBRztBQUFBLE1BQ3pCLE1BQU0sV0FBc0IsQ0FBQztBQUFBLE1BQzdCLFdBQVcsT0FBTyxZQUFZO0FBQUEsUUFDNUIsSUFBSSxPQUFPLElBQUksUUFBUTtBQUFBLFVBQVU7QUFBQSxRQUNqQyxNQUFNLE1BQU0sT0FBTyxJQUFJLE9BQU8sV0FBVyxJQUFJLEtBQUssTUFBTSxHQUFHO0FBQUEsUUFDM0QsTUFBTSxNQUFNLE1BQU0sWUFBWSxJQUFJLEdBQUc7QUFBQSxRQUNyQyxTQUFTLEtBQUs7QUFBQSxVQUNaLElBQUk7QUFBQSxVQUNKO0FBQUEsVUFDQSxNQUFNLFlBQVksaUJBQWlCLEtBQUssR0FBRztBQUFBLFVBQzNDLE1BQU0sT0FBTyxJQUFJLFNBQVMsV0FBVyxJQUFJLE9BQU87QUFBQSxVQUNoRCxPQUFPLE9BQU8sSUFBSSxVQUFVLFdBQVcsSUFBSSxRQUFRO0FBQUEsVUFDbkQsT0FBTztBQUFBLFVBQ1AsVUFBVTtBQUFBLFFBQ1osQ0FBQztBQUFBLE1BQ0g7QUFBQSxNQUNBLElBQUksU0FBUyxXQUFXO0FBQUEsUUFBRyxPQUFPO0FBQUEsTUFDbEMsTUFBTSxRQUFlO0FBQUEsUUFDbkIsSUFBSTtBQUFBLFFBQ0osTUFBTSxJQUFJLFNBQVMsU0FBUyxTQUFTO0FBQUEsUUFDckMsUUFBUSxPQUFPLElBQUksV0FBVyxXQUFXLElBQUksU0FBUztBQUFBLFFBQ3RELEtBQUssT0FBTyxJQUFJLFFBQVEsV0FBVyxJQUFJLE1BQU07QUFBQSxRQUM3QyxxQkFDRSxPQUFPLElBQUksd0JBQXdCLFdBQVcsSUFBSSxzQkFBc0I7QUFBQSxRQUMxRTtBQUFBLE1BQ0Y7QUFBQSxNQUNBLE1BQU0sUUFBUSxLQUFLLEtBQUs7QUFBQSxNQUN4QixZQUFZO0FBQUEsUUFDVixNQUFNO0FBQUEsUUFDTixNQUFNO0FBQUEsUUFDTixNQUNFLE9BQU8sSUFBSSxZQUFZLFdBQ25CLElBQUksVUFDSixhQUFhLFNBQVMsaUJBQWlCLFNBQVMsU0FBUyxJQUFJLE1BQU07QUFBQSxRQUN6RTtBQUFBLE1BQ0YsQ0FBQztBQUFBLE1BRUQsSUFBSSxDQUFDLE1BQU07QUFBQSxRQUFPLE1BQU0sUUFBUSxFQUFFLFNBQVMsV0FBVyxTQUFTLEdBQUcsR0FBRztBQUFBLE1BQ3JFLGVBQWU7QUFBQSxJQUNqQixFQUFPLFNBQUksTUFBTSxTQUFTO0FBQUEsTUFDeEIsTUFBTSxJQUFJLFVBQVUsSUFBSSxPQUFpQjtBQUFBLE1BQ3pDLE1BQU0sTUFBTSxHQUFHLFNBQVMsS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLElBQUksU0FBUztBQUFBLE1BQzFELElBQUksS0FBSyxLQUFLO0FBQUEsUUFDWixNQUFNLFFBQVEsRUFBRSxTQUFTLEVBQUUsSUFBSSxXQUFXLElBQUksVUFBb0I7QUFBQSxRQUNsRSxlQUFlO0FBQUEsTUFDakI7QUFBQSxJQUNGLEVBQU8sU0FBSSxNQUFNLGNBQWM7QUFBQSxNQUU3QixNQUFNLE1BQU0sWUFBWSxJQUFJLEVBQVk7QUFBQSxNQUN4QyxJQUFJLENBQUM7QUFBQSxRQUFLLE9BQU87QUFBQSxNQUNqQixJQUFJLFFBQVEsY0FBYyxJQUFJLGFBQWE7QUFBQSxNQUMzQyxlQUFlO0FBQUEsSUFDakIsRUFBTyxTQUFJLE1BQU0sbUJBQW1CO0FBQUEsTUFHbEMsTUFBTSxNQUFNLFlBQVksSUFBSSxFQUFZO0FBQUEsTUFDeEMsSUFBSSxDQUFDLE9BQU8sT0FBTyxJQUFJLFNBQVM7QUFBQSxRQUFVLE9BQU87QUFBQSxNQUNqRCxJQUFJLFFBQVEsV0FBVyxJQUFJO0FBQUEsTUFHM0IsSUFBSSxJQUFJLFFBQVE7QUFBQSxRQUFNLE1BQU0sY0FBYyxJQUFJLFFBQVEsUUFBUSxJQUFJO0FBQUEsTUFDbEUsZUFBZTtBQUFBLElBQ2pCLEVBQU8sU0FBSSxNQUFNLGVBQWU7QUFBQSxNQUs5QixNQUFNLE1BQU0sZ0JBQWdCLEdBQTRDO0FBQUEsTUFDeEUsSUFBSSxDQUFDLElBQUk7QUFBQSxRQUNQLE9BQU87QUFBQSxVQUNMLFlBQVk7QUFBQSxVQUNaLElBQUk7QUFBQSxVQUNKLFFBQVE7QUFBQSxVQUNSLE9BQU8sSUFBSTtBQUFBLFVBQ1gsUUFBUTtBQUFBLGVBQ0YsSUFBSSxLQUFLLEVBQUUsSUFBSSxJQUFJLEdBQUcsSUFBSSxDQUFDO0FBQUEsZUFDM0IsSUFBSSxZQUFZLEVBQUUsV0FBVyxJQUFJLFVBQVUsSUFBSSxDQUFDO0FBQUEsVUFDdEQ7QUFBQSxRQUNGO0FBQUEsTUFDRixJQUFJLElBQUk7QUFBQSxRQUFNLFlBQVksSUFBSSxJQUFJLElBQUksSUFBa0I7QUFBQSxNQUd4RCxJQUFJLElBQUksWUFBWSxzQkFBc0IsSUFBSTtBQUFBLFFBQU0sZUFBZTtBQUFBLE1BQ25FLE9BQU87QUFBQSxRQUNMLFlBQVk7QUFBQSxRQUNaLElBQUk7QUFBQSxRQUNKLFFBQVE7QUFBQSxVQUNOLElBQUksSUFBSTtBQUFBLFVBQ1IsU0FBUyxJQUFJO0FBQUEsYUFDVCxJQUFJLFlBQVksWUFBWSxFQUFFLFNBQVMsSUFBSSxTQUFTLFVBQVUsSUFBSSxTQUFTLElBQUksQ0FBQztBQUFBLFFBQ3RGO0FBQUEsTUFDRjtBQUFBLElBQ0YsRUFBTyxTQUFJLE1BQU0sVUFBVTtBQUFBLE1BQ3pCLE1BQU0sU0FBUztBQUFBLFFBQ2IsTUFBTSxJQUFJLFNBQVM7QUFBQSxRQUNuQixNQUFNLE9BQU8sSUFBSSxTQUFTLFdBQVcsSUFBSSxPQUFPO0FBQUEsTUFDbEQ7QUFBQSxNQUNBLGVBQWU7QUFBQSxJQUNqQixFQUFPLFNBQUksTUFBTSxRQUFRO0FBQUEsTUFDdkIsSUFBSSxPQUFPLElBQUksU0FBUyxVQUFVO0FBQUEsUUFDaEMsTUFBTSxPQUFPLElBQUk7QUFBQSxRQUNqQixlQUFlO0FBQUEsTUFDakI7QUFBQSxJQUNGLEVBQU8sU0FBSSxNQUFNLFdBQVc7QUFBQSxNQUMxQixNQUFNLFVBQVUsT0FBTyxJQUFJLFNBQVMsV0FBVyxJQUFJLE9BQU87QUFBQSxNQUMxRCxlQUFlO0FBQUEsSUFDakIsRUFBTyxTQUFJLE1BQU0sU0FBUztBQUFBLE1BQ3hCLFlBQVksRUFBRSxNQUFNLEdBQUcsUUFBUSxRQUFRLENBQUM7QUFBQSxJQUMxQyxFQUFPO0FBQUEsTUFDTCxPQUFPO0FBQUE7QUFBQSxJQUVULE9BQU87QUFBQTtBQUFBLEVBdUJULE1BQU0saUJBQWlCLENBQUMsS0FBYyxTQUF1QjtBQUFBLElBQzNELE1BQU07QUFBQSxJQUNOLE9BQU8sWUFBZTtBQUFBLE1BQ3BCO0FBQUEsTUFDQSxPQUFPLE9BQU8sU0FBUyxLQUFJLGFBQWEsSUFBSSxPQUFPLEtBQUssTUFBTSxFQUFFO0FBQUEsTUFDaEUsYUFBYTtBQUFBLE1BQ2IsU0FBUztBQUFBLE1BQ1QsUUFBUSxJQUFJO0FBQUEsTUFDWixRQUFRO0FBQUEsTUFDUixTQUFTO0FBQUEsSUFDWCxDQUFDO0FBQUE7QUFBQSxFQUlILGVBQWUsZ0JBQWdCLENBQUMsS0FBOEI7QUFBQSxJQUM1RCxNQUFNLElBQUksSUFBSTtBQUFBLElBQ2QsSUFBSSxNQUFNLE9BQU87QUFBQSxNQUNmLElBQUksT0FBTyxJQUFJLFNBQVMsWUFBWSxDQUFDLElBQUk7QUFBQSxRQUFNO0FBQUEsTUFDL0MsWUFBWSxFQUFFLE1BQU0sUUFBUSxNQUFNLFFBQVEsTUFBTSxJQUFJLEtBQUssQ0FBQztBQUFBLE1BSTFELElBQUk7QUFBQSxNQUNKLElBQUk7QUFBQSxNQUNKLE1BQU0sT0FBTyxNQUFNLE9BQU87QUFBQSxNQUMxQixJQUFJLFFBQVEsT0FBTyxJQUFJLGlCQUFpQixZQUFZLElBQUksYUFBYSxXQUFXLE9BQU8sR0FBRztBQUFBLFFBQ3hGLHFCQUNFLFlBQVksaUJBQWlCLE1BQU0sTUFBTSxHQUFHLElBQUksWUFBWSxLQUFLO0FBQUEsUUFDbkUsZ0JBQWdCLE1BQU0sZUFBZSxTQUFTLENBQUM7QUFBQSxRQUMvQyxXQUFXLFFBQVE7QUFBQSxNQUNyQjtBQUFBLE1BQ0EsZUFBZTtBQUFBLE1BSWYsVUFBVTtBQUFBLFFBQ1IsTUFBTTtBQUFBLFFBQ04sTUFBTSxJQUFJO0FBQUEsUUFDVixPQUFPLE1BQU07QUFBQSxRQUNiLGdCQUFnQixlQUFlO0FBQUEsUUFDL0I7QUFBQSxRQUNBLE9BQU87QUFBQSxNQUNULENBQUM7QUFBQSxJQUNILEVBQU8sU0FBSSxNQUFNLGlCQUFpQjtBQUFBLE1BQ2hDLE1BQU0sSUFBSSxNQUFNLGFBQWEsS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLElBQUksRUFBRTtBQUFBLE1BQ3hELElBQUksR0FBRyxVQUFVO0FBQUEsUUFDZixFQUFFLFNBQVMsU0FBUztBQUFBLFFBQ3BCLGVBQWU7QUFBQSxNQUNqQjtBQUFBLE1BU0EsVUFBVSxFQUFFLE1BQU0saUJBQWlCLFlBQVksSUFBSSxHQUFHLENBQUM7QUFBQSxJQUN6RCxFQUFPLFNBQUksTUFBTSxvQkFBb0I7QUFBQSxNQUNuQyxNQUFNLElBQUksTUFBTSxhQUFhLEtBQUssQ0FBQyxNQUFNLEVBQUUsT0FBTyxJQUFJLEVBQUU7QUFBQSxNQUN4RCxJQUFJLEdBQUcsVUFBVTtBQUFBLFFBQ2YsRUFBRSxTQUFTLFNBQVM7QUFBQSxRQUNwQixlQUFlO0FBQUEsTUFDakI7QUFBQSxNQUNBLFVBQVUsRUFBRSxNQUFNLG9CQUFvQixZQUFZLElBQUksR0FBRyxDQUFDO0FBQUEsSUFDNUQsRUFBTyxTQUFJLE1BQU0sYUFBYTtBQUFBLE1BQzVCLE1BQU0sSUFBSSxVQUFVLElBQUksT0FBaUI7QUFBQSxNQUN6QyxJQUFJLENBQUM7QUFBQSxRQUFHO0FBQUEsTUFDUixJQUFJLENBQUMsRUFBRSxTQUFTLEtBQUssQ0FBQyxNQUFNLEVBQUUsT0FBTyxJQUFJLFNBQVM7QUFBQSxRQUFHO0FBQUEsTUFDckQsTUFBTSxRQUFRLEVBQUUsU0FBUyxFQUFFLElBQUksV0FBVyxJQUFJLFVBQW9CO0FBQUEsTUFDbEUsZUFBZTtBQUFBLElBQ2pCLEVBQU8sU0FBSSxNQUFNLGVBQWU7QUFBQSxNQUM5QixNQUFNLFFBQVE7QUFBQSxNQUNkLGVBQWU7QUFBQSxJQUNqQixFQUFPLFNBQUksTUFBTSxnQkFBZ0I7QUFBQSxNQUMvQixNQUFNLE1BQU0sWUFBWSxJQUFJLEVBQVk7QUFBQSxNQUN4QyxJQUFJLENBQUM7QUFBQSxRQUFLO0FBQUEsTUFDVixJQUFJLFFBQVEsUUFBUSxJQUFJLFVBQVU7QUFBQSxNQUNsQyxJQUFJLElBQUksUUFBUSxPQUFPO0FBQUEsUUFDckIsWUFBWTtBQUFBLFVBQ1YsTUFBTTtBQUFBLFVBQ04sTUFBTTtBQUFBLFVBQ04sTUFBTSxrQ0FBd0IsUUFBUSxJQUFJLEtBQUs7QUFBQSxVQUMvQyxTQUFTLEVBQUUsTUFBTSxTQUFTLFVBQVUsSUFBSSxRQUFRLEdBQUc7QUFBQSxRQUNyRCxDQUFDO0FBQUEsTUFDSDtBQUFBLE1BQ0EsZUFBZTtBQUFBLElBQ2pCLEVBQU8sU0FBSSxNQUFNLGtCQUFrQjtBQUFBLE1BS2pDLE1BQU0sVUFBVSxJQUFJO0FBQUEsTUFDcEIsTUFBTSxZQUFZLElBQUk7QUFBQSxNQUN0QixJQUFJLE9BQU8sWUFBWSxZQUFZLE9BQU8sY0FBYztBQUFBLFFBQVU7QUFBQSxNQUNsRSxNQUFNLFFBQVEsTUFBTSxRQUFRLEtBQUssQ0FBQyxNQUFNLEVBQUUsT0FBTyxPQUFPO0FBQUEsTUFDeEQsSUFBSSxDQUFDLE9BQU8sU0FBUyxLQUFLLENBQUMsT0FBTSxHQUFFLE9BQU8sU0FBUztBQUFBLFFBQUc7QUFBQSxNQUN0RCxNQUFNLFdBQVcsTUFBTSxTQUFTLE9BQU8sQ0FBQyxPQUFNLEdBQUUsT0FBTyxTQUFTO0FBQUEsTUFDaEUsSUFBSSxNQUFNLFNBQVMsV0FBVyxHQUFHO0FBQUEsUUFDL0IsTUFBTSxVQUFVLE1BQU0sUUFBUSxPQUFPLENBQUMsTUFBTSxFQUFFLE9BQU8sT0FBTztBQUFBLE1BQzlEO0FBQUEsTUFDQSxPQUFPLE1BQU0sZUFBZTtBQUFBLE1BQzVCLE9BQU8sTUFBTSxnQkFBZ0I7QUFBQSxNQUM3QixPQUFPLFlBQVk7QUFBQSxNQUNuQixPQUFPLFdBQVc7QUFBQSxNQUNsQixJQUFJLE1BQU0sT0FBTyxjQUFjO0FBQUEsUUFBVyxNQUFNLFFBQVE7QUFBQSxNQUN4RCxlQUFlO0FBQUEsSUFDakIsRUFBTyxTQUFJLE1BQU0sZUFBZTtBQUFBLE1BTTlCLE1BQU0sTUFBTSxnQkFBZ0IsR0FBNEM7QUFBQSxNQUN4RSxJQUFJLElBQUksTUFBTSxJQUFJO0FBQUEsUUFBTSxZQUFZLElBQUksSUFBSSxJQUFJLElBQWtCO0FBQUEsTUFDbEUsSUFBSSxJQUFJO0FBQUEsUUFBSSxlQUFlO0FBQUEsSUFDN0IsRUFBTyxTQUFJLE1BQU0sa0JBQWtCO0FBQUEsTUFDakMsTUFBTSxJQUFJLE1BQU0sUUFBUSxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sSUFBSSxFQUFFO0FBQUEsTUFDbkQsSUFBSSxHQUFHO0FBQUEsUUFDTCxJQUFJLE9BQU8sSUFBSSxTQUFTO0FBQUEsVUFBVSxFQUFFLE9BQU8sSUFBSSxLQUFLLEtBQUssS0FBSyxFQUFFO0FBQUEsUUFDaEUsSUFBSSxPQUFPLElBQUksWUFBWTtBQUFBLFVBQVUsRUFBRSxVQUFVLElBQUk7QUFBQSxRQUNyRCxJQUFJLE1BQU0sUUFBUSxJQUFJLElBQUk7QUFBQSxVQUFHLEVBQUUsT0FBTyxJQUFJO0FBQUEsUUFDMUMsZUFBZTtBQUFBLE1BQ2pCO0FBQUEsSUFDRixFQUFPLFNBQUksTUFBTSxrQkFBa0I7QUFBQSxNQUNqQyxJQUFJLE9BQU8sSUFBSSxPQUFPLFVBQVU7QUFBQSxRQUM5QixNQUFNLFdBQVcsTUFBTSxRQUFRLEtBQUssQ0FBQyxNQUFNLEVBQUUsT0FBTyxJQUFJLEVBQUU7QUFBQSxRQUMxRCxNQUFNLFVBQVUsTUFBTSxRQUFRLE9BQU8sQ0FBQyxNQUFNLEVBQUUsT0FBTyxJQUFJLEVBQUU7QUFBQSxRQUMzRCxNQUFNLG1CQUFtQixNQUFNLGlCQUFpQixPQUFPLENBQUMsTUFBTSxNQUFNLElBQUksRUFBRTtBQUFBLFFBQzFFLE1BQU0saUJBQWlCLE1BQU0sZUFBZSxPQUFPLENBQUMsTUFBTSxNQUFNLElBQUksRUFBRTtBQUFBLFFBQ3RFLElBQUksVUFBVSxXQUFXO0FBQUEsVUFDdkIsSUFBSTtBQUFBLFlBQ0YsWUFBVyxTQUFTLFNBQVM7QUFBQSxZQUM3QixNQUFNO0FBQUEsUUFHVjtBQUFBLFFBQ0EsZUFBZTtBQUFBLE1BQ2pCO0FBQUEsSUFDRixFQUFPLFNBQUksTUFBTSxnQkFBZ0I7QUFBQSxNQUMvQixJQUFJLE9BQU8sSUFBSSxPQUFPLFVBQVU7QUFBQSxRQUM5QixZQUFZLElBQUksSUFBSSxJQUFJLEdBQWlCO0FBQUEsUUFDekMsZUFBZTtBQUFBLE1BQ2pCO0FBQUEsSUFDRixFQUFPLFNBQUksTUFBTSxrQkFBa0I7QUFBQSxNQUNqQyxJQUFJLE9BQU8sSUFBSSxPQUFPLFVBQVU7QUFBQSxRQUM5QixjQUFjLElBQUksSUFBSSxJQUFJLEdBQWlCO0FBQUEsUUFDM0MsZUFBZTtBQUFBLE1BQ2pCO0FBQUEsSUFDRixFQUFPLFNBQUksTUFBTSxtQkFBbUI7QUFBQSxNQUVsQyxVQUFVLEVBQUUsTUFBTSxtQkFBbUIsT0FBTyxNQUFNLE1BQU0sQ0FBQztBQUFBLElBQzNELEVBQU8sU0FBSSxNQUFNLFdBQVc7QUFBQSxNQUMxQixJQUFJLE9BQU8sSUFBSSxRQUFRLFlBQVksT0FBTyxJQUFJLFVBQVU7QUFBQSxRQUFVO0FBQUEsTUFDbEUsTUFBTSxLQUFLLE1BQU0sS0FBSyxLQUFLLENBQUMsTUFBTSxFQUFFLFFBQVEsSUFBSSxHQUFHO0FBQUEsTUFDbkQsSUFBSTtBQUFBLFFBQUksR0FBRyxRQUFRLElBQUk7QUFBQSxNQUNsQjtBQUFBLGNBQU0sS0FBSyxLQUFLLEVBQUUsS0FBSyxJQUFJLEtBQUssT0FBTyxJQUFJLE1BQU0sQ0FBQztBQUFBLE1BQ3ZELGVBQWU7QUFBQSxJQUNqQixFQUFPLFNBQUksTUFBTSxjQUFjO0FBQUEsTUFDN0IsTUFBTSxPQUFPLE1BQU0sS0FBSyxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQVEsSUFBSSxHQUFHO0FBQUEsTUFDdkQsZUFBZTtBQUFBLElBQ2pCLEVBQU8sU0FBSSxNQUFNLFdBQVc7QUFBQSxNQUkxQixNQUFNLE1BQU0sSUFBSTtBQUFBLE1BQ2hCLElBQUksQ0FBQyxPQUFPLE9BQU8sSUFBSSxRQUFRO0FBQUEsUUFBVTtBQUFBLE1BR3pDLE1BQU0sT0FBTyxPQUFPLElBQUksU0FBUyxXQUFXLElBQUksT0FBTztBQUFBLE1BQ3ZELFFBQVEsWUFBWSxtQkFBbUIsSUFBSSxLQUFLLElBQUk7QUFBQSxNQUNwRCxRQUFRLGNBQWM7QUFBQSxNQUN0QixZQUFZO0FBQUEsUUFDVixNQUFNO0FBQUEsUUFDTixNQUFNO0FBQUEsUUFDTixNQUFNLDRDQUFrQyxRQUFRLFFBQVE7QUFBQSxRQUN4RCxTQUFTLEVBQUUsTUFBTSxhQUFhLFVBQVUsUUFBUSxHQUFHO0FBQUEsTUFDckQsQ0FBQztBQUFBLE1BQ0QsZUFBZTtBQUFBLElBQ2pCLEVBQU8sU0FBSSxNQUFNLGNBQWM7QUFBQSxNQUU3QixNQUFNLE1BQU0sWUFBWSxJQUFJLEVBQVk7QUFBQSxNQUN4QyxJQUFJLENBQUM7QUFBQSxRQUFLO0FBQUEsTUFDVixJQUFJLFFBQVEsY0FBYztBQUFBLE1BQzFCLGVBQWU7QUFBQSxJQUNqQixFQUFPLFNBQUksTUFBTSxjQUFjO0FBQUEsTUFDN0IsTUFBTSxNQUFNLFlBQVksSUFBSSxFQUFZO0FBQUEsTUFDeEMsSUFBSSxDQUFDO0FBQUEsUUFBSztBQUFBLE1BQ1YsSUFBSSxRQUFRLGNBQWMsSUFBSSxhQUFhO0FBQUEsTUFDM0MsZUFBZTtBQUFBLElBQ2pCLEVBQU8sU0FBSSxNQUFNLGdCQUFnQjtBQUFBLE1BRy9CLE1BQU0sTUFBTSxJQUFJO0FBQUEsTUFDaEIsSUFBSSxDQUFDLE9BQU8sT0FBTyxJQUFJLFFBQVE7QUFBQSxRQUFVO0FBQUEsTUFDekMsTUFBTSxPQUFPLE9BQU8sSUFBSSxTQUFTLFdBQVcsSUFBSSxPQUFPO0FBQUEsTUFDdkQsUUFBUSxTQUFTLFlBQVksbUJBQW1CLElBQUksS0FBSyxJQUFJO0FBQUEsTUFDN0QsTUFBTSxRQUFRLEVBQUUsU0FBUyxXQUFXLFFBQVEsR0FBRztBQUFBLE1BQy9DLFlBQVk7QUFBQSxRQUNWLE1BQU07QUFBQSxRQUNOLE1BQU07QUFBQSxRQUNOLE1BQU0sb0RBQTBDLFFBQVEsUUFBUTtBQUFBLFFBQ2hFLFNBQVMsRUFBRSxNQUFNLFlBQVksVUFBVSxRQUFRLEdBQUc7QUFBQSxNQUNwRCxDQUFDO0FBQUEsTUFDRCxlQUFlO0FBQUEsSUFDakIsRUFBTyxTQUFJLE1BQU0sa0JBQWtCO0FBQUEsTUFLakMsTUFBTSxNQUFNLE1BQU0sT0FBTztBQUFBLE1BQ3pCLE1BQU0sTUFBTTtBQUFBLE1BUVosSUFBSSxDQUFDLE9BQU8sT0FBTyxJQUFJLFFBQVE7QUFBQSxRQUFVO0FBQUEsTUFDekMsTUFBTSxNQUFNLENBQUMsSUFBWSxNQUFlLE9BQU8sT0FBTSxZQUFZLE9BQU8sU0FBUyxFQUFDLElBQUksS0FBSTtBQUFBLE1BQzFGLE1BQU0sSUFBSSxJQUFJLElBQUksR0FBRyxHQUFHO0FBQUEsTUFDeEIsTUFBTSxJQUFJLElBQUksSUFBSSxHQUFHLEdBQUc7QUFBQSxNQUN4QixNQUFNLElBQUksSUFBSSxJQUFJLElBQUksSUFBSSxLQUFLLENBQUM7QUFBQSxNQUNoQyxNQUFNLElBQUksSUFBSSxJQUFJLElBQUksSUFBSSxLQUFLLENBQUM7QUFBQSxNQUNoQyxNQUFNLFlBQVksTUFBTSxZQUFZLElBQUksR0FBRztBQUFBLE1BQzNDLFlBQVksR0FBRztBQUFBLE1BQ2YsSUFBSSxDQUFDLE1BQU0sZ0JBQWdCO0FBQUEsUUFBTSxNQUFNLGdCQUFnQixPQUFPLENBQUM7QUFBQSxNQUMvRCxNQUFNLFFBQWU7QUFBQSxRQUNuQixJQUFJLE1BQU0sT0FBTztBQUFBLFFBQ2pCLE1BQU0sT0FBTyxJQUFJLFNBQVMsWUFBWSxJQUFJLE9BQU8sSUFBSSxPQUFPO0FBQUEsUUFDNUQsTUFBTTtBQUFBLE1BQ1I7QUFBQSxNQUNBLE1BQU0sZ0JBQWdCLEtBQUssS0FBSyxLQUFLO0FBQUEsTUFDckMsSUFBSSxDQUFDLE1BQU0sZUFBZTtBQUFBLFFBQU0sTUFBTSxlQUFlLE9BQU8sQ0FBQztBQUFBLE1BQzdELE1BQU0sTUFBTSxNQUFNLGVBQWU7QUFBQSxNQUNqQyxJQUFJLEtBQUs7QUFBQSxRQUNQLElBQUksTUFBTSxLQUFLO0FBQUEsUUFDZixNQUFNO0FBQUEsUUFDTixLQUFLO0FBQUEsUUFDTDtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0EsU0FBUyxNQUFNO0FBQUEsUUFDZixRQUFRLElBQUk7QUFBQSxNQUNkLENBQUM7QUFBQSxNQUNELGVBQWU7QUFBQSxJQUNqQixFQUFPLFNBQUksTUFBTSxhQUFhO0FBQUEsTUFFNUIsTUFBTSxNQUFNLE1BQU0sT0FBTztBQUFBLE1BQ3pCLElBQUksQ0FBQztBQUFBLFFBQUs7QUFBQSxNQUNWLElBQUksQ0FBQyxNQUFNLGdCQUFnQjtBQUFBLFFBQU0sTUFBTSxnQkFBZ0IsT0FBTyxDQUFDO0FBQUEsTUFDL0QsWUFBWSxHQUFHO0FBQUEsTUFDZixNQUFNLE9BQ0osSUFBSSxTQUFTLFlBQVksSUFBSSxTQUFTLFVBQVUsSUFBSSxPQUFPO0FBQUEsTUFDN0QsTUFBTSxnQkFBZ0IsS0FBSyxLQUFLO0FBQUEsUUFDOUIsSUFBSSxNQUFNLE9BQU87QUFBQSxRQUNqQixNQUFNLE9BQU8sSUFBSSxTQUFTLFlBQVksSUFBSSxPQUFPLElBQUksT0FBTztBQUFBLFFBQzVEO0FBQUEsTUFDRixDQUFDO0FBQUEsTUFDRCxlQUFlO0FBQUEsSUFDakIsRUFBTyxTQUFJLE1BQU0sZ0JBQWdCO0FBQUEsTUFDL0IsTUFBTSxNQUFNLE1BQU0sT0FBTztBQUFBLE1BQ3pCLE1BQU0sUUFBUSxNQUFNLE1BQU0sZ0JBQWdCLE1BQU0sS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLElBQUksRUFBRSxJQUFJO0FBQUEsTUFDL0UsSUFBSSxDQUFDLFNBQVMsT0FBTyxJQUFJLFNBQVMsWUFBWSxDQUFDLElBQUksUUFBUSxNQUFNLFNBQVMsSUFBSTtBQUFBLFFBQU07QUFBQSxNQUNwRixZQUFZLEdBQUc7QUFBQSxNQUNmLE1BQU0sT0FBTyxJQUFJO0FBQUEsTUFDakIsZUFBZTtBQUFBLElBQ2pCLEVBQU8sU0FBSSxNQUFNLHFCQUFxQixNQUFNLG1CQUFtQjtBQUFBLE1BQzdELE1BQU0sTUFBTSxNQUFNLE9BQU87QUFBQSxNQUN6QixNQUFNLFFBQVEsTUFBTSxNQUFNLGdCQUFnQixNQUFNLEtBQUssQ0FBQyxNQUFNLEVBQUUsT0FBTyxJQUFJLEVBQUUsSUFBSTtBQUFBLE1BQy9FLE1BQU0sTUFBTSxNQUFNLG9CQUFvQixXQUFXO0FBQUEsTUFDakQsTUFBTSxPQUFPLE1BQU0sb0JBQW9CLElBQUksU0FBUyxJQUFJO0FBQUEsTUFDeEQsSUFBSSxDQUFDLFNBQVMsT0FBTyxTQUFTLGFBQWEsUUFBUSxNQUFNLElBQUksTUFBTTtBQUFBLFFBQU07QUFBQSxNQUN6RSxZQUFZLEdBQUc7QUFBQSxNQUNmLE1BQU0sT0FBTztBQUFBLE1BQ2IsZUFBZTtBQUFBLElBQ2pCLEVBQU8sU0FBSSxNQUFNLGlCQUFpQjtBQUFBLE1BRWhDLE1BQU0sTUFBTSxNQUFNLE9BQU87QUFBQSxNQUN6QixNQUFNLFNBQVMsTUFBTSxNQUFNLGdCQUFnQixPQUFPO0FBQUEsTUFDbEQsTUFBTSxNQUFNLFFBQVEsVUFBVSxDQUFDLE9BQU0sR0FBRSxPQUFPLElBQUksRUFBRSxLQUFLO0FBQUEsTUFDekQsSUFBSSxDQUFDLE9BQU8sQ0FBQyxVQUFVLE1BQU0sS0FBSyxPQUFPLElBQUksWUFBWTtBQUFBLFFBQVU7QUFBQSxNQUNuRSxNQUFNLEtBQUssS0FBSyxJQUFJLEdBQUcsS0FBSyxJQUFJLE9BQU8sU0FBUyxHQUFHLEtBQUssTUFBTSxJQUFJLE9BQU8sQ0FBQyxDQUFDO0FBQUEsTUFDM0UsSUFBSSxPQUFPO0FBQUEsUUFBSztBQUFBLE1BQ2hCLFlBQVksR0FBRztBQUFBLE1BQ2YsT0FBTyxLQUFLLE9BQU8sT0FBTyxLQUFLLENBQUM7QUFBQSxNQUNoQyxPQUFPLE9BQU8sSUFBSSxHQUFHLENBQUM7QUFBQSxNQUN0QixlQUFlO0FBQUEsSUFDakIsRUFBTyxTQUFJLE1BQU0sZ0JBQWdCO0FBQUEsTUFFL0IsTUFBTSxNQUFNLE1BQU0sT0FBTztBQUFBLE1BQ3pCLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTSxnQkFBZ0IsTUFBTSxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sSUFBSSxFQUFFO0FBQUEsUUFBRztBQUFBLE1BQ3ZFLFlBQVksR0FBRztBQUFBLE1BQ2YsTUFBTSxnQkFBZ0IsT0FBTyxNQUFNLGdCQUFnQixLQUFLLE9BQU8sQ0FBQyxNQUFNLEVBQUUsT0FBTyxJQUFJLEVBQUU7QUFBQSxNQUNyRixJQUFJLE1BQU0sZUFBZSxNQUFNO0FBQUEsUUFDN0IsTUFBTSxlQUFlLE9BQU8sTUFBTSxlQUFlLEtBQUssT0FBTyxDQUFDLE1BQU0sRUFBRSxZQUFZLElBQUksRUFBRTtBQUFBLE1BQzFGO0FBQUEsTUFDQSxlQUFlO0FBQUEsSUFDakIsRUFBTyxTQUFJLE1BQU0sU0FBUztBQUFBLE1BRXhCLE1BQU0sTUFBTSxNQUFNLE9BQU87QUFBQSxNQUN6QixNQUFNLE1BQU0sSUFBSTtBQUFBLE1BQ2hCLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTSxRQUFRLEdBQUcsS0FBSyxDQUFDLElBQUk7QUFBQSxRQUFRO0FBQUEsTUFDaEQsTUFBTSxRQUFRLE1BQU0sZUFBZSxRQUFRLENBQUM7QUFBQSxNQUM1QyxNQUFNLFFBQVEsSUFBSSxJQUFJLElBQUksT0FBTyxDQUFDLE1BQW1CLE9BQU8sTUFBTSxRQUFRLENBQUM7QUFBQSxNQUMzRSxNQUFNLFNBQVMsTUFBTSxPQUFPLENBQUMsTUFBTSxNQUFNLElBQUksRUFBRSxFQUFFLENBQUM7QUFBQSxNQUNsRCxJQUFJLENBQUMsT0FBTztBQUFBLFFBQVE7QUFBQSxNQUNwQixZQUFZLEdBQUc7QUFBQSxNQUNmLElBQUksQ0FBQyxNQUFNLGdCQUFnQjtBQUFBLFFBQU0sTUFBTSxnQkFBZ0IsT0FBTyxDQUFDO0FBQUEsTUFDL0QsTUFBTSxTQUFTLE1BQU0sZ0JBQWdCO0FBQUEsTUFDckMsTUFBTSxZQUFZLElBQUksSUFBSSxPQUFPLElBQUksQ0FBQyxNQUFNLEVBQUUsT0FBTyxFQUFFLE9BQU8sT0FBTyxDQUFhO0FBQUEsTUFLbEYsTUFBTSxRQUFlO0FBQUEsUUFDbkIsSUFBSSxNQUFNLE9BQU87QUFBQSxRQUNqQixNQUFNLE9BQU8sSUFBSSxTQUFTLFlBQVksSUFBSSxPQUFPLElBQUksT0FBTztBQUFBLFFBQzVELE1BQU0sT0FBTyxNQUFNLENBQUMsTUFBTSxFQUFFLFNBQVMsTUFBTSxJQUN2QyxXQUNBLE9BQU8sTUFBTSxDQUFDLE1BQU0sRUFBRSxTQUFTLE9BQU8sSUFDcEMsVUFDQTtBQUFBLE1BQ1I7QUFBQSxNQUNBLE9BQU8sS0FBSyxLQUFLO0FBQUEsTUFDakIsT0FBTyxRQUFRLENBQUMsR0FBRyxNQUFNO0FBQUEsUUFDdkIsRUFBRSxVQUFVLE1BQU07QUFBQSxRQUNsQixFQUFFLFNBQVM7QUFBQSxPQUNaO0FBQUEsTUFFRCxNQUFNLGdCQUFnQixPQUFPLE9BQU8sT0FDbEMsQ0FBQyxNQUFNLEVBQUUsT0FBTyxNQUFNLE1BQU0sQ0FBQyxVQUFVLElBQUksRUFBRSxFQUFFLEtBQUssTUFBTSxLQUFLLENBQUMsTUFBTSxFQUFFLFlBQVksRUFBRSxFQUFFLENBQzFGO0FBQUEsTUFDQSxlQUFlO0FBQUEsSUFDakIsRUFBTyxTQUFJLE1BQU0sV0FBVztBQUFBLE1BRTFCLE1BQU0sTUFBTSxNQUFNLE9BQU87QUFBQSxNQUN6QixNQUFNLFNBQVMsTUFBTSxNQUFNLGdCQUFnQixPQUFPO0FBQUEsTUFDbEQsTUFBTSxLQUFLLFFBQVEsVUFBVSxDQUFDLE1BQU0sRUFBRSxPQUFPLElBQUksRUFBRSxLQUFLO0FBQUEsTUFDeEQsSUFBSSxDQUFDLE9BQU8sQ0FBQyxVQUFVLEtBQUs7QUFBQSxRQUFHO0FBQUEsTUFDL0IsTUFBTSxXQUFXLE1BQU0sZUFBZSxRQUFRLENBQUMsR0FDNUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxZQUFZLElBQUksRUFBRSxFQUNsQyxLQUFLLENBQUMsR0FBRyxPQUFPLEVBQUUsVUFBVSxNQUFNLEVBQUUsVUFBVSxFQUFFO0FBQUEsTUFDbkQsSUFBSSxRQUFRLFNBQVM7QUFBQSxRQUFHO0FBQUEsTUFDeEIsWUFBWSxHQUFHO0FBQUEsTUFDZixNQUFNLFFBQWlCLFFBQVEsSUFBSSxDQUFDLE1BQU07QUFBQSxRQUN4QyxNQUFNLEtBQUssTUFBTSxPQUFPO0FBQUEsUUFDeEIsRUFBRSxVQUFVO0FBQUEsUUFDWixFQUFFLFNBQVM7QUFBQSxRQUNYLE9BQU8sRUFBRSxJQUFJLE1BQU0sV0FBVyxFQUFFLE9BQU8sTUFBTSxZQUFZLEVBQUUsSUFBSSxFQUFFO0FBQUEsT0FDbEU7QUFBQSxNQUNELE9BQU8sT0FBTyxJQUFJLEdBQUcsR0FBRyxLQUFLO0FBQUEsTUFDN0IsZUFBZTtBQUFBLElBQ2pCLEVBQU8sU0FBSSxNQUFNLFlBQVk7QUFBQSxNQUMzQixNQUFNLEtBQUssSUFBSTtBQUFBLE1BQ2YsTUFBTSxNQUFNLE1BQU0sT0FBTztBQUFBLE1BQ3pCLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxNQUFNLENBQUMsV0FBVyxTQUFTLEdBQUcsSUFBSTtBQUFBLFFBQUc7QUFBQSxNQUN0RCxZQUFZLEdBQUc7QUFBQSxNQUNmLElBQUksQ0FBQyxNQUFNLGVBQWU7QUFBQSxRQUFNLE1BQU0sZUFBZSxPQUFPLENBQUM7QUFBQSxNQUM3RCxNQUFNLE1BQU0sTUFBTSxlQUFlO0FBQUEsTUFFakMsTUFBTSxTQUFTLE9BQU8sR0FBRyxZQUFZLFdBQVcsR0FBRyxVQUFVO0FBQUEsTUFDN0QsTUFBTSxVQUFVLFVBQVUsTUFBTSxnQkFBZ0IsTUFBTSxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sTUFBTTtBQUFBLE1BQ2pGLEdBQUcsVUFBVSxVQUFXLFNBQW9CLGdCQUFnQixHQUFHO0FBQUEsTUFDL0QsR0FBRyxTQUFTLElBQUk7QUFBQSxNQUNoQixJQUFJLEtBQUssRUFBRTtBQUFBLE1BQ1gsZUFBZTtBQUFBLElBQ2pCLEVBQU8sU0FBSSxNQUFNLGVBQWU7QUFBQSxNQUM5QixNQUFNLE1BQU0sTUFBTSxPQUFPO0FBQUEsTUFDekIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLGVBQWU7QUFBQSxRQUFNO0FBQUEsTUFDeEMsSUFBSSxDQUFDLE1BQU0sZUFBZSxLQUFLLEtBQUssQ0FBQyxNQUFNLEVBQUUsT0FBTyxJQUFJLEVBQUU7QUFBQSxRQUFHO0FBQUEsTUFDN0QsWUFBWSxHQUFHO0FBQUEsTUFDZixNQUFNLGVBQWUsT0FBTyxNQUFNLGVBQWUsS0FBSyxPQUFPLENBQUMsTUFBTSxFQUFFLE9BQU8sSUFBSSxFQUFFO0FBQUEsTUFDbkYsZUFBZTtBQUFBLElBQ2pCLEVBQU8sU0FBSSxNQUFNLGVBQWU7QUFBQSxNQUc5QixNQUFNLE1BQU0sTUFBTSxPQUFPO0FBQUEsTUFDekIsTUFBTSxJQUFJLE1BQ0wsTUFBTSxlQUFlLE1BQU0sS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLElBQUksRUFBRSxJQUd2RDtBQUFBLE1BQ0osTUFBTSxRQUFRLElBQUk7QUFBQSxNQUNsQixJQUFJLENBQUMsS0FBSyxDQUFDLFNBQVMsT0FBTyxVQUFVO0FBQUEsUUFBVTtBQUFBLE1BQy9DLFlBQVksR0FBRztBQUFBLE1BQ2YsWUFBWSxHQUFHLFFBQVEsT0FBTyxRQUFRLEtBQUssR0FBRztBQUFBLFFBQzVDLElBQUksTUFBTSxRQUFRLE1BQU0sVUFBVSxNQUFNO0FBQUEsVUFBVTtBQUFBLFFBQ2xELElBQUksT0FBTyxRQUFRLFlBQVksT0FBTyxRQUFRLFVBQVU7QUFBQSxVQUN0RCxFQUFFLEtBQUs7QUFBQSxRQUNULEVBQU8sU0FFTCxNQUFNLFlBQ04sTUFBTSxRQUFRLEdBQUcsS0FDakIsSUFBSSxNQUNGLENBQUMsTUFDQyxLQUNBLE9BQU8sTUFBTSxZQUNiLE9BQVEsRUFBcUIsTUFBTSxZQUNuQyxPQUFRLEVBQXFCLE1BQU0sUUFDdkMsR0FDQTtBQUFBLFVBQ0EsRUFBRSxLQUFLO0FBQUEsUUFDVDtBQUFBLE1BQ0Y7QUFBQSxNQUNBLGVBQWU7QUFBQSxJQUNqQixFQUFPLFNBQUksTUFBTSxnQkFBZ0I7QUFBQSxNQUMvQixNQUFNLE1BQU0sTUFBTSxPQUFPO0FBQUEsTUFDekIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLGVBQWU7QUFBQSxRQUFNO0FBQUEsTUFDeEMsTUFBTSxTQUFTLENBQUMsR0FBRyxNQUFNLGVBQWUsSUFBSSxFQUFFLEtBQzVDLENBQUMsR0FBRyxPQUFPLEVBQUUsVUFBVSxNQUFNLEVBQUUsVUFBVSxFQUMzQztBQUFBLE1BQ0EsTUFBTSxNQUFNLE9BQU8sVUFBVSxDQUFDLE9BQU0sR0FBRSxPQUFPLElBQUksRUFBRTtBQUFBLE1BQ25ELElBQUksTUFBTTtBQUFBLFFBQUc7QUFBQSxNQUNiLFlBQVksR0FBRztBQUFBLE1BQ2YsT0FBTyxLQUFLLE9BQU8sT0FBTyxLQUFLLENBQUM7QUFBQSxNQUNoQyxNQUFNLFNBQ0osSUFBSSxjQUFjLFVBQ2QsT0FBTyxTQUNQLElBQUksY0FBYyxjQUNoQixJQUNBLElBQUksY0FBYyxZQUNoQixLQUFLLElBQUksT0FBTyxRQUFRLE1BQU0sQ0FBQyxJQUMvQixLQUFLLElBQUksR0FBRyxNQUFNLENBQUM7QUFBQSxNQUM3QixPQUFPLE9BQU8sUUFBUSxHQUFHLENBQUM7QUFBQSxNQUMxQixPQUFPLFFBQVEsQ0FBQyxJQUFJLE1BQU07QUFBQSxRQUN4QixHQUFHLFNBQVM7QUFBQSxPQUNiO0FBQUEsTUFDRCxNQUFNLGVBQWUsT0FBTztBQUFBLE1BQzVCLGVBQWU7QUFBQSxJQUNqQixFQUFPLFNBQUksTUFBTSxlQUFlO0FBQUEsTUFDOUIsTUFBTSxNQUFNLE1BQU0sT0FBTztBQUFBLE1BQ3pCLElBQUksT0FBTyxNQUFNLGVBQWUsTUFBTSxRQUFRO0FBQUEsUUFDNUMsWUFBWSxHQUFHO0FBQUEsUUFDZixNQUFNLGVBQWUsT0FBTyxDQUFDO0FBQUEsUUFDN0IsZUFBZTtBQUFBLE1BQ2pCO0FBQUEsSUFDRixFQUFPLFNBQUksTUFBTSxpQkFBaUI7QUFBQSxNQUloQyxNQUFNLE1BQU0sTUFBTSxPQUFPO0FBQUEsTUFDekIsTUFBTSxXQUFXLElBQUk7QUFBQSxNQUNyQixJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sUUFBUSxRQUFRO0FBQUEsUUFBRztBQUFBLE1BQ3RDLE1BQU0sUUFBUSxTQUFTLE9BQU8sQ0FBQyxNQUFNLEdBQUcsTUFBTSxXQUFXLFNBQVMsRUFBRSxJQUFJLENBQUM7QUFBQSxNQUN6RSxZQUFZLEdBQUc7QUFBQSxNQUNmLE1BQU0sUUFBUSxDQUFDLEdBQUcsTUFBTTtBQUFBLFFBQ3RCLEVBQUUsU0FBUztBQUFBLE9BQ1o7QUFBQSxNQUNELE1BQU0sZUFBZSxPQUFPO0FBQUEsTUFDNUIsZUFBZTtBQUFBLElBQ2pCLEVBQU8sU0FBSSxNQUFNLFVBQVUsTUFBTSxRQUFRO0FBQUEsTUFDdkMsTUFBTSxNQUFNLE1BQU0sT0FBTztBQUFBLE1BQ3pCLElBQUksQ0FBQztBQUFBLFFBQUs7QUFBQSxNQUNWLE1BQU0sSUFBSSxRQUFRLEdBQUc7QUFBQSxNQUNyQixNQUFNLE9BQU8sTUFBTSxTQUFTLEVBQUUsT0FBTyxFQUFFO0FBQUEsTUFDdkMsTUFBTSxLQUFLLE1BQU0sU0FBUyxFQUFFLE9BQU8sRUFBRTtBQUFBLE1BQ3JDLElBQUksQ0FBQyxLQUFLO0FBQUEsUUFBUTtBQUFBLE1BQ2xCLEdBQUcsS0FBSyxRQUFRLEdBQUcsQ0FBQztBQUFBLE1BQ3BCLE1BQU0sT0FBTyxLQUFLLElBQUk7QUFBQSxNQUN0QixNQUFNLGVBQWUsT0FBTyxLQUFLO0FBQUEsTUFDakMsTUFBTSxnQkFBZ0IsT0FBTyxLQUFLO0FBQUEsTUFDbEMsV0FBVyxPQUFPO0FBQUEsTUFDbEIsZUFBZTtBQUFBLElBQ2pCLEVBQU8sU0FBSSxNQUFNLGdCQUFnQjtBQUFBLE1BQy9CLElBQ0UsT0FBTyxJQUFJLFNBQVMsWUFDcEIsT0FBTyxJQUFJLFlBQVksWUFDdkIsT0FBTyxJQUFJLGNBQWM7QUFBQSxRQUV6QjtBQUFBLE1BQ0YsTUFBTSxRQUFRLE1BQU0sZUFBZSxJQUFJLGNBQWMsQ0FBQztBQUFBLE1BSXRELElBQUk7QUFBQSxNQUNKLElBQUksT0FBTyxJQUFJLGlCQUFpQixZQUFZLElBQUksYUFBYSxXQUFXLE9BQU8sR0FBRztBQUFBLFFBQ2hGLHFCQUNFLFlBQVksaUJBQWlCLE1BQU0sTUFBTSxHQUFHLElBQUksWUFBWSxLQUFLO0FBQUEsTUFDckU7QUFBQSxNQUNBLFlBQVk7QUFBQSxRQUNWLE1BQU07QUFBQSxRQUNOLE1BQU07QUFBQSxRQUNOLE1BQU0sZ0JBQU0sSUFBSTtBQUFBLFFBQ2hCLFNBQVMsRUFBRSxNQUFNLFVBQVUsVUFBVSxJQUFJLFVBQVU7QUFBQSxNQUNyRCxDQUFDO0FBQUEsTUFJRCxXQUFXLElBQUksYUFBYTtBQUFBLE1BQzVCLGVBQWU7QUFBQSxNQUNmLFVBQVU7QUFBQSxRQUNSLE1BQU07QUFBQSxRQUNOLE1BQU0sSUFBSTtBQUFBLFFBQ1YsU0FBUyxJQUFJO0FBQUEsUUFDYixXQUFXLElBQUk7QUFBQSxRQUNmO0FBQUEsUUFDQSxnQkFBZ0IsZUFBZTtBQUFBLFFBQy9CO0FBQUEsTUFDRixDQUFDO0FBQUEsSUFDSCxFQUFPLFNBQUksTUFBTSxjQUFjO0FBQUEsTUFDN0IsSUFBSSxPQUFPLElBQUksV0FBVztBQUFBLFFBQVU7QUFBQSxNQUNwQyxNQUFNLFNBQVMsSUFBSTtBQUFBLE1BQ25CLGVBQWU7QUFBQSxJQUNqQixFQUFPLFNBQUksTUFBTSxZQUFZO0FBQUEsTUFDM0IsSUFBSSxJQUFJLFNBQVMsUUFBUSxJQUFJLFNBQVM7QUFBQSxRQUFNO0FBQUEsTUFDNUMsTUFBTSxPQUFPLElBQUk7QUFBQSxNQUNqQixlQUFlO0FBQUEsSUFDakIsRUFBTyxTQUFJLE1BQU0sVUFBVTtBQUFBLE1BQ3pCLFVBQVUsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUFBLE1BQzVCLFVBQVUsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUFBLE1BQzVCLFlBQVksRUFBRSxNQUFNLEdBQUcsUUFBUSxTQUFTLENBQUM7QUFBQSxJQUMzQyxFQUFPLFNBQUksTUFBTSxVQUFVO0FBQUEsTUFDekIsVUFBVSxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQUEsTUFDNUIsWUFBWSxFQUFFLE1BQU0sS0FBSyxRQUFRLFNBQVMsQ0FBQztBQUFBLElBQzdDO0FBQUE7QUFBQSxFQUdGLE1BQU0sT0FBTyxhQUFZO0FBQUEsRUFZekIsTUFBTSxXQUNKLFNBQVMsU0FDSixNQUFhLHVEQUFnRCxVQUM5RDtBQUFBLEVBQ04sTUFBTSxTQUFVLFdBQVcsRUFBRSxLQUFLLFNBQVMsSUFBSSxDQUFDO0FBQUEsRUFFaEQsSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLElBQ0YsU0FBUyxJQUFJLE1BQU07QUFBQSxNQUNqQjtBQUFBLE1BQ0EsVUFBVTtBQUFBLE1BQ1Y7QUFBQSxNQWdCQSxhQUFhO0FBQUEsTUFDYixhQUFhLEVBQUUsS0FBSyxTQUFTLE1BQU07QUFBQSxNQUNuQyxPQUFPLENBQUMsS0FBSyxRQUFRO0FBQUEsUUFDbkIsTUFBTSxPQUFNLElBQUksSUFBSSxJQUFJLEdBQUc7QUFBQSxRQUMzQixNQUFNLE9BQU8sS0FBSTtBQUFBLFFBQ2pCLElBQUksU0FBUyxPQUFPO0FBQUEsVUFDbEIsTUFBTSxXQUFXLElBQUksUUFBUSxHQUFHO0FBQUEsVUFDaEMsSUFBSTtBQUFBLFlBQVU7QUFBQSxVQUNkLE9BQU8sSUFBSSxTQUFTLG9CQUFvQixFQUFFLFFBQVEsSUFBSSxDQUFDO0FBQUEsUUFDekQ7QUFBQSxRQUNBLElBQUksSUFBSSxXQUFXLFNBQVMsU0FBUyxVQUFVO0FBQUEsVUFTN0MsTUFBTTtBQUFBLFVBQ04sTUFBTSxPQUFPLEtBQUksYUFBYSxJQUFJLE1BQU0sTUFBTTtBQUFBLFVBQzlDLE1BQU0sVUFBVSxPQUFPLFVBQVUsS0FBSyxJQUFJO0FBQUEsVUFDMUMsT0FBTyxJQUFJLFNBQVMsS0FBSyxVQUFVLEVBQUUsT0FBTyxTQUFTLFFBQVEsSUFBSSxPQUFPLEVBQUUsQ0FBQyxHQUFHO0FBQUEsWUFDNUUsU0FBUyxFQUFFLGdCQUFnQixtQkFBbUI7QUFBQSxVQUNoRCxDQUFDO0FBQUEsUUFDSDtBQUFBLFFBQ0EsSUFBSSxJQUFJLFdBQVcsU0FBUyxTQUFTLFdBQVc7QUFBQSxVQUM5QyxPQUFPLGVBQWUsS0FBSyxJQUFHO0FBQUEsUUFDaEM7QUFBQSxRQUNBLElBQUksSUFBSSxXQUFXLFVBQVUsU0FBUyxRQUFRO0FBQUEsVUFDNUMsT0FBTyxJQUNKLEtBQUssRUFDTCxLQUFLLE9BQU8sU0FBUztBQUFBLFlBQ3BCLE1BQU07QUFBQSxZQUlOLE1BQU0sVUFBVSxNQUFNLGVBQWUsSUFBK0I7QUFBQSxZQUdwRSxJQUFJLE9BQU8sWUFBWSxVQUFVO0FBQUEsY0FDL0IsSUFBSSxDQUFDLFFBQVEsSUFBSTtBQUFBLGdCQUNmLE9BQU8sU0FBUyxLQUNkLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxPQUFPLFFBQVEsVUFBVSxRQUFRLE9BQU8sR0FDckUsRUFBRSxRQUFRLFFBQVEsT0FBTyxDQUMzQjtBQUFBLGNBQ0Y7QUFBQSxjQUNBLE9BQU8sU0FBUyxLQUFLLEVBQUUsSUFBSSxNQUFNLFNBQVMsU0FBUyxRQUFRLE9BQU8sQ0FBQztBQUFBLFlBQ3JFO0FBQUEsWUFDQSxNQUFNLFVBQVU7QUFBQSxZQUNoQixJQUFJLENBQUMsU0FBUztBQUFBLGNBQ1osT0FBTyxTQUFTLEtBQ2Q7QUFBQSxnQkFDRSxJQUFJO0FBQUEsZ0JBQ0osU0FBUztBQUFBLGdCQUNULE9BQU8sNkJBQTZCLEtBQUssVUFDdEMsTUFBNkIsSUFDaEM7QUFBQSxjQUNGLEdBQ0EsRUFBRSxRQUFRLElBQUksQ0FDaEI7QUFBQSxZQUNGO0FBQUEsWUFDQSxPQUFPLElBQUksU0FBUyw4QkFBOEI7QUFBQSxjQUNoRCxTQUFTLEVBQUUsZ0JBQWdCLG1CQUFtQjtBQUFBLFlBQ2hELENBQUM7QUFBQSxXQUNGLEVBQ0EsTUFDQyxNQUNFLElBQUksU0FBUyx3QkFBd0I7QUFBQSxZQUNuQyxRQUFRO0FBQUEsWUFDUixTQUFTLEVBQUUsZ0JBQWdCLG1CQUFtQjtBQUFBLFVBQ2hELENBQUMsQ0FDTDtBQUFBLFFBQ0o7QUFBQSxRQUNBLElBQUksSUFBSSxXQUFXLFNBQVMsS0FBSyxXQUFXLFVBQVUsR0FBRztBQUFBLFVBQ3ZELE1BQU0sWUFBWSxtQkFBbUIsS0FBSyxNQUFNLFdBQVcsTUFBTSxDQUFDO0FBQUEsVUFDbEUsSUFBSSxVQUFVLFNBQVMsSUFBSSxLQUFLLFVBQVUsV0FBVyxHQUFHLEdBQUc7QUFBQSxZQUN6RCxPQUFPLElBQUksU0FBUyx5QkFBeUI7QUFBQSxjQUMzQyxRQUFRO0FBQUEsY0FDUixTQUFTLEVBQUUsZ0JBQWdCLG1CQUFtQjtBQUFBLFlBQ2hELENBQUM7QUFBQSxVQUNIO0FBQUEsVUFDQSxNQUFNLElBQUksSUFBSSxLQUFLLE1BQUssV0FBVyxTQUFTLENBQUM7QUFBQSxVQUM3QyxPQUFPLEVBQUUsT0FBTyxFQUFFLEtBQUssQ0FBQyxXQUN0QixTQUNJLElBQUksU0FBUyxHQUFHLEVBQUUsU0FBUyxFQUFFLGdCQUFnQixVQUFVLFNBQVMsRUFBRSxFQUFFLENBQUMsSUFDckUsSUFBSSxTQUFTLHlCQUF5QjtBQUFBLFlBQ3BDLFFBQVE7QUFBQSxZQUNSLFNBQVMsRUFBRSxnQkFBZ0IsbUJBQW1CO0FBQUEsVUFDaEQsQ0FBQyxDQUNQO0FBQUEsUUFDRjtBQUFBLFFBSUEsSUFBSSxTQUFTLFdBQVc7QUFBQSxVQUN0QixNQUFNLFFBQVEsVUFBVSxJQUFJO0FBQUEsVUFDNUIsSUFBSTtBQUFBLFlBQU8sT0FBTztBQUFBLFFBQ3BCO0FBQUEsUUFDQSxPQUFPLElBQUksU0FBUyx5QkFBeUI7QUFBQSxVQUMzQyxRQUFRO0FBQUEsVUFDUixTQUFTLEVBQUUsZ0JBQWdCLG1CQUFtQjtBQUFBLFFBQ2hELENBQUM7QUFBQTtBQUFBLE1BRUgsV0FBVztBQUFBLFFBQ1QsSUFBSSxDQUFDLElBQUk7QUFBQSxVQUNQLFFBQVEsSUFBSSxFQUFFO0FBQUEsVUFDZCxNQUFNO0FBQUEsVUFDTixjQUFjLEVBQUUsTUFBTSxZQUFZLENBQUM7QUFBQSxVQUNuQyxHQUFHLEtBQUssS0FBSyxVQUFVLEVBQUUsTUFBTSxTQUFTLE1BQU0sQ0FBQyxDQUFDO0FBQUE7QUFBQSxRQUVsRCxPQUFPLENBQUMsS0FBSyxLQUFLO0FBQUEsVUFDaEIsTUFBTTtBQUFBLFVBQ04sSUFBSTtBQUFBLFVBQ0osSUFBSTtBQUFBLFlBQ0YsTUFBTSxLQUFLLE1BQU0sT0FBTyxRQUFRLFdBQVcsTUFBTSxJQUFJLFlBQVksRUFBRSxPQUFPLEdBQUcsQ0FBQztBQUFBLFlBQzlFLE9BQU8sR0FBRztBQUFBLFlBQ1YsUUFBUSxPQUFPLE1BQ2IsaUNBQWlDLGFBQWEsUUFBUSxFQUFFLFVBQVUsT0FBTyxDQUFDO0FBQUEsQ0FDNUU7QUFBQSxZQUNBO0FBQUE7QUFBQSxVQUVHLGlCQUFpQixHQUFHO0FBQUE7QUFBQSxRQUUzQixLQUFLLENBQUMsSUFBSTtBQUFBLFVBQ1IsUUFBUSxPQUFPLEVBQUU7QUFBQSxVQUNqQixNQUFNO0FBQUEsVUFDTixjQUFjLEVBQUUsTUFBTSxlQUFlLENBQUM7QUFBQTtBQUFBLE1BRTFDO0FBQUEsSUFDRixDQUFDO0FBQUEsSUFDRCxPQUFPLEdBQUc7QUFBQSxJQUNWLFFBQVEsT0FBTyxNQUNiLEdBQUcsS0FBSyxVQUFVO0FBQUEsTUFDaEIsT0FBTztBQUFBLE1BQ1A7QUFBQSxNQUNBO0FBQUEsTUFDQSxPQUFPLGFBQWEsUUFBUSxFQUFFLFVBQVUsT0FBTyxDQUFDO0FBQUEsSUFDbEQsQ0FBQztBQUFBLENBQ0g7QUFBQSxJQUNBLE9BQU87QUFBQTtBQUFBLEVBR1QsTUFBTSxZQUFZLE9BQU87QUFBQSxFQUN6QixJQUFJLENBQUM7QUFBQSxJQUFXLFlBQVksU0FBUyxRQUFRLENBQUMsTUFBTTtBQUFBLEVBQ3BELGtCQUFrQixNQUFLLE9BQU8sR0FBRyxHQUFHLGlCQUFpQjtBQUFBLEVBQ3JELElBQUk7QUFBQSxJQUNGLFVBQVUsaUJBQWlCLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFBQSxJQUM5QyxNQUFNO0FBQUEsRUFNUixJQUFJLFVBQVU7QUFBQSxJQWNaLE1BQU0sYUFBYyxNQUFpQztBQUFBLElBQ3JELElBQUksTUFBTSxRQUFRLFVBQVUsS0FBSyxXQUFXLFFBQVE7QUFBQSxNQUNsRCxNQUFNLFFBQVEsS0FBSztBQUFBLFFBQ2pCLElBQUksTUFBTSxHQUFHO0FBQUEsUUFDYixNQUFNO0FBQUEsUUFDTixRQUFRO0FBQUEsUUFDUixLQUFLO0FBQUEsUUFDTCxVQUFVLFdBQVcsSUFBSSxDQUFDLE1BQU07QUFBQSxVQUM5QixNQUFNLE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSxZQUFZLEVBQUUsR0FBRyxJQUFJO0FBQUEsVUFHckQsSUFBSSxRQUFRLEVBQUU7QUFBQSxZQUFVLE1BQU0sY0FBYyxRQUFRLEVBQUU7QUFBQSxVQUN0RCxPQUFPO0FBQUEsWUFDTCxJQUFJLEVBQUU7QUFBQSxZQUNOLEtBQUssRUFBRTtBQUFBLFlBQ1AsTUFBTSxFQUFFLFFBQVE7QUFBQSxZQUNoQixPQUFPO0FBQUEsWUFDUCxVQUFVLEVBQUUsWUFBWTtBQUFBLFlBQ3hCLE1BQU0sRUFBRTtBQUFBLFlBQ1IsYUFBYSxFQUFFLGFBQWE7QUFBQSxZQUM1QjtBQUFBLFVBQ0Y7QUFBQSxTQUNEO0FBQUEsTUFDSCxDQUFDO0FBQUEsSUFDSDtBQUFBLElBQ0EsT0FBUSxNQUE2QjtBQUFBLElBWXJDLE1BQU0sa0JBQ0osTUFBTSxRQUFTLE1BQStCLE1BQU0sS0FDcEQsTUFBTSxRQUFTLE1BQWdDLE9BQU87QUFBQSxJQUN4RCxJQUFJLGlCQUFpQjtBQUFBLE1BQ25CLE1BQU0sVUFBVSxDQUFDO0FBQUEsTUFDakIsTUFBTSxtQkFBbUIsQ0FBQztBQUFBLE1BQzFCLE1BQU0saUJBQWlCLENBQUM7QUFBQSxJQUMxQixFQUFPO0FBQUEsTUFDTCxNQUFNLFlBQVksQ0FBQztBQUFBLE1BQ25CLE1BQU0scUJBQXFCLENBQUM7QUFBQSxNQUM1QixNQUFNLG1CQUFtQixDQUFDO0FBQUE7QUFBQSxJQUU1QixNQUFNLGVBQWdCLE1BQXFDO0FBQUEsSUFDM0QsSUFBSSxNQUFNLFFBQVEsWUFBWSxHQUFHO0FBQUEsTUFDL0IsV0FBVyxNQUFNLGNBQWM7QUFBQSxRQUM3QixNQUFNLE9BQU8sVUFBVSxHQUFHLElBQUk7QUFBQSxRQUM5QixNQUFNLEtBQUssUUFBUSxJQUFJO0FBQUEsUUFDdkIsTUFBTSxRQUFRLEtBQUs7QUFBQSxVQUNqQjtBQUFBLFVBQ0EsTUFBTTtBQUFBLFVBQ047QUFBQSxVQUNBLFNBQVMsR0FBRyxlQUFlO0FBQUEsVUFDM0IsT0FBTyxHQUFHO0FBQUEsVUFDVixXQUFXLEdBQUc7QUFBQSxVQUNkLFVBQVUsR0FBRztBQUFBLFFBQ2YsQ0FBQztBQUFBLFFBQ0QsSUFBSSxHQUFHO0FBQUEsVUFBUSxNQUFNLGlCQUFpQixLQUFLLEVBQUU7QUFBQSxNQUMvQztBQUFBLElBQ0Y7QUFBQSxJQUNBLE1BQU0sZ0JBQWlCLE1BQXVDO0FBQUEsSUFDOUQsSUFBSSxNQUFNLFFBQVEsYUFBYSxHQUFHO0FBQUEsTUFDaEMsV0FBVyxLQUFLLGVBQWU7QUFBQSxRQUM3QixNQUFNLFFBQVEsS0FBSztBQUFBLFVBQ2pCLElBQUksRUFBRTtBQUFBLFVBQ04sTUFBTTtBQUFBLFVBQ04sTUFBTSxFQUFFO0FBQUEsVUFDUixTQUFTLEVBQUU7QUFBQSxRQUNiLENBQUM7QUFBQSxRQUNELE1BQU0sZUFBZSxLQUFLLEVBQUUsRUFBRTtBQUFBLE1BQ2hDO0FBQUEsSUFDRjtBQUFBLElBQ0EsT0FBUSxNQUErQjtBQUFBLElBQ3ZDLE9BQVEsTUFBZ0M7QUFBQSxJQUV4QyxXQUFXLEtBQUssTUFBTSxTQUFTO0FBQUEsTUFDN0IsV0FBVyxNQUFNLEVBQUUsVUFBVTtBQUFBLFFBQzNCLElBQUksR0FBRztBQUFBLFVBQUssR0FBRyxPQUFPLFlBQVksaUJBQWlCLEdBQUcsSUFBSSxHQUFHLEdBQUcsS0FBSyxHQUFHO0FBQUEsUUFDeEUsSUFBSSxHQUFHLGFBQWE7QUFBQSxVQUFXLEdBQUcsV0FBVztBQUFBLE1BQy9DO0FBQUEsSUFDRjtBQUFBLElBQ0EsV0FBVyxLQUFLLE1BQU0sU0FBUztBQUFBLE1BQzdCLElBQUksRUFBRTtBQUFBLFFBQU8sRUFBRSxZQUFZLFlBQVksaUJBQWlCLEVBQUUsSUFBSSxFQUFFLEtBQUssS0FBSyxFQUFFO0FBQUEsSUFDOUU7QUFBQSxJQUdBLE1BQU0sU0FBVSxNQUE2QjtBQUFBLElBQzdDLElBQUksTUFBTSxRQUFRLE1BQU0sR0FBRztBQUFBLE1BQ3pCLElBQUksT0FBTyxVQUFVLE1BQU07QUFBQSxRQUFPLE1BQU0sZUFBZSxNQUFNLE1BQU0sYUFBYTtBQUFBLE1BQ2hGLE9BQVEsTUFBNkI7QUFBQSxJQUN2QztBQUFBLElBQ0EsTUFBTSxtQkFBbUIsQ0FBQztBQUFBLElBQzFCLE1BQU0sb0JBQW9CLENBQUM7QUFBQSxJQUMzQixXQUFXLE9BQU8sT0FBTyxLQUFLLE1BQU0sY0FBYyxHQUFHO0FBQUEsTUFDbkQsTUFBTSxRQUFRLE1BQU0sZUFBZTtBQUFBLE1BR25DLElBQUksU0FBUyxNQUFNLGdCQUFnQjtBQUFBLE1BQ25DLElBQUksQ0FBQyxRQUFRLFVBQVUsTUFBTSxRQUFRO0FBQUEsUUFDbkMsU0FBUyxDQUFDLEVBQUUsSUFBSSxNQUFNLE9BQU8sR0FBRyxNQUFNLGVBQWUsTUFBTSxhQUFhLENBQUM7QUFBQSxRQUN6RSxNQUFNLGdCQUFnQixPQUFPO0FBQUEsTUFDL0I7QUFBQSxNQUNBLE1BQU0saUJBQWlCLFNBQVMsT0FBTyxTQUFTLElBQUk7QUFBQSxNQUNwRCxNQUFNLGVBQWUsT0FBTyxNQUFNLElBQUksQ0FBQyxHQUFHLE9BQU87QUFBQSxXQUM1QztBQUFBLFFBQ0gsUUFBUSxFQUFFLFdBQVcsWUFBWSxJQUFJLEVBQUU7QUFBQSxRQUN2QyxTQUFTLEVBQUUsV0FBVztBQUFBLE1BQ3hCLEVBQUU7QUFBQSxJQUNKO0FBQUEsSUFDQSxhQUFhO0FBQUEsRUFDZjtBQUFBLEVBRUEsTUFBTSxNQUFNLFVBQVUsUUFBUTtBQUFBLEVBTTlCLFVBQVUsRUFBRSxNQUFNLFNBQVMsS0FBSyxNQUFNLFdBQVcsWUFBWSxXQUFXLEtBQUssQ0FBQztBQUFBLEVBRzlFLE1BQU0sY0FBYyxNQUFLLE9BQU8sR0FBRyxTQUFTLGdCQUFnQjtBQUFBLEVBQzVELE1BQU0sYUFBYSxNQUFLLE9BQU8sR0FBRyxtQkFBbUI7QUFBQSxFQUNyRCxNQUFNLGNBQWMsS0FBSyxVQUFVO0FBQUEsSUFDakM7QUFBQSxJQUNBLE1BQU07QUFBQSxJQUNOLFlBQVk7QUFBQSxJQUNaLE9BQU8sTUFBTTtBQUFBLElBQ2IsV0FBVztBQUFBLElBQ1g7QUFBQSxFQUNGLENBQUM7QUFBQSxFQVdELElBQUk7QUFBQSxJQUNGLGdCQUFnQixhQUFhLFdBQVc7QUFBQSxJQUN4QyxnQkFBZ0IsWUFBWSxXQUFXO0FBQUEsSUFDdkMsT0FBTyxHQUFHO0FBQUEsSUFDVixRQUFRLE9BQU8sTUFDYiwwQ0FBMEMsYUFBYSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUM7QUFBQSxDQUNyRjtBQUFBO0FBQUEsRUFZRixNQUFNLG1CQUFtQixNQUFNO0FBQUEsSUFDN0IsSUFBSTtBQUFBLE1BQ0YsWUFBVyxXQUFXO0FBQUEsTUFDdEIsTUFBTTtBQUFBLElBR1IsZ0JBQWdCLFlBQVksV0FBVyxDQUFDLFFBQVE7QUFBQSxNQUM5QyxJQUFJO0FBQUEsUUFDRixNQUFNLEtBQU0sS0FBSyxNQUFNLEdBQUcsRUFBK0I7QUFBQSxRQUN6RCxPQUFPLE9BQU8sT0FBTyxXQUFXLEtBQUs7QUFBQSxRQUNyQyxNQUFNO0FBQUEsUUFDTixPQUFPO0FBQUE7QUFBQSxLQUVWO0FBQUEsSUFDRCxJQUFJO0FBQUEsTUFDRixJQUFJO0FBQUEsUUFBaUIsUUFBTyxpQkFBaUIsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxNQUM3RSxNQUFNO0FBQUE7QUFBQSxFQUtWLElBQUksQ0FBQyxFQUFFO0FBQUEsSUFBWSxZQUFZLEdBQUc7QUFBQSxFQWVsQyxNQUFNLG1CQUFtQixrQkFBa0I7QUFBQSxJQUN6QyxpQkFBaUIsTUFBTSxRQUFRLE9BQU8sV0FBVztBQUFBLElBQ2pELFFBQVEsTUFBTSxZQUFZLElBQUksSUFBSTtBQUFBLElBQ2xDO0FBQUEsSUFDQSxXQUFXLFVBQVU7QUFBQSxJQUNyQixhQUFhLE1BQU0sWUFBWSxFQUFFLE1BQU0sS0FBSyxRQUFRLFVBQVUsQ0FBQztBQUFBLElBQy9ELFVBQVU7QUFBQSxNQUNSLE9BQU8sTUFBTTtBQUFBLE1BQ2IsT0FBTyxNQUFNO0FBQUEsUUFDWCxZQUFZO0FBQUE7QUFBQSxNQUlkLE9BQU87QUFBQSxJQUNUO0FBQUEsRUFDRixDQUFDO0FBQUEsRUFFRCxRQUFRLE1BQU0sV0FBVyxNQUFNO0FBQUEsRUFDL0IsaUJBQWlCO0FBQUEsRUFDakIsYUFBYTtBQUFBLEVBQ2IsVUFBVSxFQUFFLE1BQU0sVUFBVSxPQUFPLENBQUM7QUFBQSxFQUNwQyxVQUFVLEVBQUUsTUFBTSxXQUFXLE1BQU0sa0JBQWtCLFNBQVMsQ0FBQztBQUFBLEVBVS9ELE1BQU0sYUFBYSxFQUFFLFFBQVEsU0FBUyxZQUFZLFFBQVEsQ0FBQztBQUFBLEVBQzNELGlCQUFpQjtBQUFBLEVBQ2pCLE9BQU87QUFBQTtBQXdCVCxlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICI0NzE1RTkyODI1MjQ4QTVFNjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
