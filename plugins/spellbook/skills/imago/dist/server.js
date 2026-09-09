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
      emitEvent({ type: "proposal.send", id: msg.id });
    } else if (t === "proposal.dismiss") {
      const m = state.conversation.find((x) => x.id === msg.id);
      if (m?.proposal) {
        m.proposal.status = "dismissed";
        broadcastState();
      }
      emitEvent({ type: "proposal.dismiss", id: msg.id });
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
  run,
  parsePortFromSessionId,
  optimizeSrc,
  main,
  leanState,
  defaultState
};

//# debugId=F17261C4E316317B64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2ltYWdvL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uL3NoYXJlZC90eXBlcy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZGlzY292ZXJ5LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ldmVudExvZy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaG91c2VrZWVwaW5nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9zZXJ2ZURpc3QudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3NzZS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9pbWFnby9iYWNrZW5kL2hlYXJ0YmVhdC50cyIsICIuLi9zaGFyZWQvaW1hZ2VPcHRpbWl6ZS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvaW1hZ28vYmFja2VuZC9pbWFnZU9wdGltaXplLnNlcnZlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIjIS91c3IvYmluL2VudiBidW5cblxuLy8gaW1hZ28g4oCUIGFuIGFnZW50LWRyaXZlbiBpbWFnZSBjYW52YXMgdGhlIHVzZXIgd29ya3MgaW5zaWRlLlxuLy9cbi8vIGltYWdvIGlzIGEgR1JPVU5ERUQgQ09OVkVSU0FUSU9OIGFib3V0IGFuIGltYWdlOiB0aGUgdXNlciBhbmQgdGhlIGFnZW50IHRhbGtcbi8vICh0aGUgY29udmVyc2F0aW9uKSwgdGhlIHN1cmZhY2UgaG9sZHMgdGhlIGFydGlmYWN0cyAoYmF0Y2hlcyBvZiBrZXB0XG4vLyBnZW5lcmF0aW9ucywgdGhlIGZvY3VzZWQgb25lIG9uIHRoZSBjYW52YXMpLCBhbmQgc3VyZmFjZSBnZXN0dXJlcyAobGlraW5nLFxuLy8gbWFya2luZywgYXR0YWNoaW5nIGEgcmVmKSBhcmUgbWVzc2FnZXMgdGhlIGFnZW50IGhlYXJzLiBJdCdzIGEgbG9vcCwgbm90IGFcbi8vIGZ1bm5lbCDigJQgbm8gcGhhc2UgcGlwZWxpbmUuXG4vL1xuLy8gQXJjaGl0ZWN0dXJlIChjbGkudHMgd3JhcHMgdGhpcyk6XG4vLyAgIC0gQWdlbnQg4oaUIHNlcnZlcjogSFRUUCBvbiB0aGUgc2FtZSBCdW4uc2VydmUuXG4vLyAgICAgICBQT1NUIC9jbWQgICAgICAgICAgICDigJQgYWdlbnQgY29tbWFuZCAoSlNPTjsgQWdlbnRDb21tYW5kIHVuaW9uKVxuLy8gICAgICAgR0VUICAvc3RhdGVbP2xlYW49MV0g4oCUIGZ1bGwgc25hcHNob3QgeyBzdGF0ZSwgY3Vyc29yIH07IGxlYW4gc3RyaXBzIGJsb2JzXG4vLyAgICAgICBHRVQgIC9ldmVudHM/c2luY2U9TiDigJQgU1NFIHN0cmVhbSBvZiB1c2VyIGV2ZW50cyAoTW9uaXRvci13cmFwcGFibGUpXG4vLyAgIC0gU2VydmVyIOKGlCBicm93c2VyOiBXZWJTb2NrZXQgYXQgL3dzIChDbGllbnRUb1NlcnZlciAvIFNlcnZlclRvQ2xpZW50KS5cbi8vICAgLSBTZXJ2ZXIgaG9sZHMgY2Fub25pY2FsIHN0YXRlOyBmdWxsLXN0YXRlIGJyb2FkY2FzdCB0byBicm93c2VycyBvbiBjaGFuZ2UuXG4vL1xuLy8gSU1QT1JUQU5UIChob3VzZS1zdHlsZToga2VlcCB0aGUgY2xpZW50IHRoaW4sIHRoZSBhZ2VudCBpcyB0aGUgcnVudGltZSk6IHRoZVxuLy8gc2VydmVyIGRvZXMgTk9UIGdlbmVyYXRlIGltYWdlcy4gR2VuZXJhdGlvbiBoYXBwZW5zIGFnZW50LXNpZGUgKG1lZGlhLWZvcmdlLFxuLy8gb3V0IG9mIGJhbmQpOyB0aGUgYWdlbnQgcG9zdHMgcmVzdWx0cyB2aWEgYmF0Y2guYWRkLiBUaGUgc3VyZmFjZSBkaXNwbGF5cyArXG4vLyBjb2xsZWN0cyB0aGUgY29udmVyc2F0aW9uIGFuZCBnZXN0dXJlcy5cbi8vXG4vLyBBZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKSBhbmQgdXNlciBldmVudHMgKEdFVCAvZXZlbnRzKSBhcmUgdGhlIEFnZW50Q29tbWFuZFxuLy8gdW5pb24gYW5kIEFHRU5UX0VWRU5UX1RZUEVTIGluIHNoYXJlZC90eXBlcy50cyDigJQgdGhlIHNpbmdsZSBjb250cmFjdC5cbi8vXG4vLyBFeGl0IGNvZGVzOiAwIHN1Ym1pdC9jbG9zZSwgMiBiYWQgYXJncywgMTI0IGlkbGUgdGltZW91dCwgMTMwIGNhbmNlbC5cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYywgdW5saW5rU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyLCB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB0eXBlIHsgU2VydmVyV2ViU29ja2V0IH0gZnJvbSBcImJ1blwiO1xuaW1wb3J0IHtcbiAgdHlwZSBCYXRjaCxcbiAgdHlwZSBDb250ZXh0RW50cnksXG4gIHR5cGUgQ29udGV4dEtpbmQsXG4gIHR5cGUgQ29udGV4dFNldCxcbiAgZGVmYXVsdFN0YXRlLFxuICB0eXBlIEltYWdvU3RhdGUsXG4gIHR5cGUgTGF5ZXIsXG4gIE1BUktfVE9PTFMsXG4gIHR5cGUgTWFyayxcbiAgdHlwZSBNZXNzYWdlLFxuICBzdHlsZUlkLFxuICB0eXBlIFZhcmlhbnQsXG59IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvaW1hZ28vc2hhcmVkL3R5cGVzXCI7XG5pbXBvcnQgeyB1bmxpbmtJZk1hdGNoZXMsIHdyaXRlRmlsZUF0b21pYyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9kaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB7IGNyZWF0ZUV2ZW50TG9nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2V2ZW50TG9nLnRzXCI7XG5pbXBvcnQgeyBkcmFpbkFuZFN0b3AsIHN0YXJ0SG91c2VrZWVwaW5nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hvdXNla2VlcGluZy50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZU1vZGUgYXMgcmVzb2x2ZU1vZGVJbiwgc2VydmVGcm9tRGlzdCB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9zZXJ2ZURpc3QudHNcIjtcbmltcG9ydCB7IHNzZVJlc3BvbnNlIGFzIGtpdFNzZVJlc3BvbnNlLCB0eXBlIFNzZUNsaWVudHMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvc3NlLnRzXCI7XG5pbXBvcnQgeyBJRExFX1RJTUVPVVRfU0VDLCBTU0VfSEVBUlRCRUFUX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0LnRzXCI7XG5pbXBvcnQgeyBvcHRpbWl6ZUltYWdlQnVmZmVyIH0gZnJvbSBcIi4vaW1hZ2VPcHRpbWl6ZS5zZXJ2ZXJcIjtcblxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcblxuLy8g4pSA4pSAIHN1cmZhY2UgbW9kZSAoc2VhbXMgQ29udHJhY3QgMSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vL1xuLy8gYGltcG9ydCBpbmRleCBmcm9tIFwiLi4vc3VyZmFjZS9pbmRleC5odG1sXCJgIHVzZWQgdG8gc2l0IGF0IHRoZSB0b3Agb2YgdGhpc1xuLy8gZmlsZS4gQSB0b3AtbGV2ZWwgU1RBVElDIGltcG9ydCBmb3JjZXMgQnVuIHRvIHJlc29sdmUgdGhlIHdob2xlIC50c3ggK1xuLy8gVGFpbHdpbmQgYnVpbGQgZ3JhcGggd2hlbiB0aGUgbW9kdWxlIExPQURTLCBzbyBhIGRlc3RpbmF0aW9uIHRoYXQgc2hpcHNcbi8vIGRpc3QvIGFuZCBubyBzdXJmYWNlLyDigJQgdGhlIHB1Ymxpc2hlZCBhcnRpZmFjdCDigJQgZGllcyBiZWZvcmUgaXQgY2FuIHNlcnZlXG4vLyB0aGUgZGlzdCBpdCBkb2VzIGhhdmUuIFRoZSBkZXYgaW1wb3J0IGlzIHRoZXJlZm9yZSBkeW5hbWljIGFuZCBpbnNpZGUgdGhlXG4vLyByZWxlYXNlIGJyYW5jaCdzIGBlbHNlYCwgYXMgbWluZC1tYXBwZXIgYW5kIGFzdHJvbGFiZSBib3RoIGRvIGl0LlxuLy9cbi8vIFBhdGhzIGFuY2hvciBhdCB0aGUgU0tJTEwgUk9PVCwgbmV2ZXIgYXQgY3dkOiBjbGkudHMgcGlucyB0aGUgZGFlbW9uJ3MgY3dkXG4vLyBmb3IgYnVuZmlnLnRvbWwncyBzYWtlIChDb250cmFjdCA1KSwgc28gY3dkIGlzIG5vdCBhIHN0YWJsZSBiYXNlIGZvciBkaXN0Ly5cbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuXG4vLyByZWxlYXNlIGlmZiBkaXN0L2luZGV4Lmh0bWwgZXhpc3RzIGF0IHRoZSBza2lsbCByb290LCBlbHNlIGRldjsgdGhlIGVudlxuLy8gb3ZlcnJpZGUgd2lucyBlaXRoZXIgd2F5IChzZWFtcyBDb250cmFjdCAxKS4gUmVsZWFzZTogemVybyByZWFkcyBvZiBzdXJmYWNlL1xuLy8gb3IgYnVuZmlnLnRvbWwg4oCUIHN0YXRpYyBmaWxlcyBvbmx5LlxuLy9cbi8vIOKblCBUSEUgUFJFRElDQVRFIEFORCBUSEUgU0NBUiBJVCBDQVJSSUVTIEFSRSBOT1cgYHNyYy9raXQvd2lyZS9zZXJ2ZURpc3QudHNgOlxuLy8gaXQgaXMgdGhlIEZJTEUgdGhhdCBkaXNjcmltaW5hdGVzLCBuZXZlciB0aGUgRElSRUNUT1JZLCBiZWNhdXNlIGEgYnVpbHRcbi8vIEJBQ0tFTkQgcHV0cyBjbGkuanMgYW5kIHNlcnZlci5qcyBpbiBhIGRpc3QvIHRoYXQgaGFzIG5vIHN1cmZhY2UgYW55d2hlcmVcbi8vIG5lYXIgaXQg4oCUIG1hZ3BpZSBzdGF5ZWQgY29ycmVjdGx5IGluIGRldiBmb3IgYSB3aG9sZSBzbGljZSB3aXRoIGEgZGlzdC8gdGhhdFxuLy8gZXhpc3RlZC4gVGhhdCBpcyBpbWFnbydzIHNpdHVhdGlvbiBmcm9tIHRoaXMgcGhhc2Ugb253YXJkLCBzbyB0aGUgc2NhciBpc1xuLy8gbm93IGxvYWQtYmVhcmluZyBoZXJlIGFuZCBub3Qgb25seSBpbiB0aGUgbW9kdWxlJ3MgaGVhZGVyLlxuZnVuY3Rpb24gcmVzb2x2ZU1vZGUoKTogXCJkZXZcIiB8IFwicmVsZWFzZVwiIHtcbiAgcmV0dXJuIHJlc29sdmVNb2RlSW4oRElTVF9ESVIpO1xufVxuXG4vLyBTZXJ2ZXMgZGlzdC8gdmVyYmF0aW0g4oCUIGVudHJ5IGluZGV4Lmh0bWwsIGhhc2hlZCBjaHVuay0qLmpzL2NzcyBieSBwYXRoXG4vLyAoQ29udHJhY3QgMidzIGZsYXQsIHJlbGF0aXZlLWhyZWYgbGF5b3V0KS4gVGhlIFVSTOKGkmZpbGVuYW1lIGRlY2lzaW9uIHN0YXlzXG4vLyBIRVJFLCBiZWNhdXNlIHRoYXQgaGFsZiBpcyBlYWNoIHJvdXRlcidzIG93biAoZGlnZXN0aWZ5IHN1YnN0aXR1dGVzIGludG8gdGhlXG4vLyBlbnRyeSBIVE1MLCBncmFwZXZpbmUgc2VydmVzIGF0IC93YXRjaCk7IHRoZSBraXQgZGVjaWRlcyB3aGV0aGVyIHRoZSBmaWxlIG1heVxuLy8gYmUgcmVhZCBhbmQgd2hhdCBpdCBpcyBzZXJ2ZWQgYXMuXG4vL1xuLy8g4pqgIEFORCBUSEUgTkVTVElORyBSRUZVU0FMIElTIFdIQVQgS0VFUFMgVEhJUyBDTEVBUiBPRiBJTUFHTydTIE9XTlxuLy8gL2Fzc2V0cy88bmFtZT4gUk9VVEUsIG5vdCB0aGUgcm91dGUgb3JkZXJpbmcg4oCUIG1lYXN1cmVkLCBhbmQgYXNzZXJ0ZWQgaW5cbi8vIGByZWxlYXNlLXNlcnZlLnRlc3QudHNgLiBgc2VydmVGcm9tRGlzdGAgcmVmdXNpbmcgYW55dGhpbmcgd2l0aCBhIHNsYXNoIGluIGl0XG4vLyBpcyB0aGF0IHJlZnVzYWwsIG5vdyBzaGFyZWQuXG5mdW5jdGlvbiBzZXJ2ZURpc3QocGF0aDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgcmV0dXJuIHNlcnZlRnJvbURpc3QoRElTVF9ESVIsIHBhdGggPT09IFwiL1wiID8gXCJpbmRleC5odG1sXCIgOiBwYXRoLnNsaWNlKDEpKTtcbn1cblxuLy8gUGVyc2lzdGVudCBob21lIGZvciBzZXNzaW9uIHNuYXBzaG90cyAoc3Vydml2ZXMgcmVzdGFydHMsIHVubGlrZSB0bXBkaXIpLlxuY29uc3QgSU1BR09fSE9NRSA9IHByb2Nlc3MuZW52LklNQUdPX0hPTUUgPz8gam9pbihob21lZGlyKCksIFwiLmltYWdvXCIpO1xuY29uc3QgU05BUFNIT1RTX0RJUiA9IGpvaW4oSU1BR09fSE9NRSwgXCJzbmFwc2hvdHNcIik7XG5cbnR5cGUgQ2xvc2VSZWFzb24gPSBcInN1Ym1pdFwiIHwgXCJjYW5jZWxcIiB8IFwidGltZW91dFwiIHwgXCJjbG9zZVwiO1xudHlwZSBEb25lUmVzdWx0ID0geyBjb2RlOiBudW1iZXI7IHJlYXNvbjogQ2xvc2VSZWFzb24gfTtcblxuY29uc3QgUE9SVF9TVUZGSVhfUkUgPSAvLXAoXFxkezIsNX0pJC87XG5cbmZ1bmN0aW9uIHBhcnNlUG9ydEZyb21TZXNzaW9uSWQoc2lkOiBzdHJpbmcpOiBudW1iZXIgfCBudWxsIHtcbiAgY29uc3QgbSA9IHNpZD8ubWF0Y2goUE9SVF9TVUZGSVhfUkUpO1xuICBpZiAoIW0pIHJldHVybiBudWxsO1xuICBjb25zdCBwb3J0ID0gcGFyc2VJbnQobVsxXSwgMTApO1xuICByZXR1cm4gcG9ydCA+PSAxICYmIHBvcnQgPD0gNjU1MzUgPyBwb3J0IDogbnVsbDtcbn1cblxuZnVuY3Rpb24gcmFuZEhleChieXRlczogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgYnVmID0gbmV3IFVpbnQ4QXJyYXkoYnl0ZXMpO1xuICBjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKGJ1Zik7XG4gIHJldHVybiBBcnJheS5mcm9tKGJ1ZiwgKGIpID0+IGIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsIFwiMFwiKSkuam9pbihcIlwiKTtcbn1cblxuZnVuY3Rpb24gbmV3SWQocHJlZml4OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7cHJlZml4fS0ke3JhbmRIZXgoNCl9YDtcbn1cblxuLy8gU3RhYmxlIGNvbnRlbnQgaGFzaCBvZiBhIHJlZmVyZW5jZSdzIGJ5dGVzIOKAlCBkZWR1cGVzIGlkZW50aWNhbCBhZGRzIGFuZCBrZXlzXG4vLyB0aGUgYW5hbHlzaXMgY2FjaGUgKHNvIGEgZGVsZXRl4oaScmUtYWRkIG9mIHRoZSBzYW1lIGltYWdlIHJldXNlcyBpdHMgcmVhZCkuXG5mdW5jdGlvbiBjb250ZW50SGFzaChzOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gbmV3IEJ1bi5DcnlwdG9IYXNoZXIoXCJzaGEyNTZcIikudXBkYXRlKHMpLmRpZ2VzdChcImhleFwiKS5zbGljZSgwLCAxNik7XG59XG5cbmZ1bmN0aW9uIG9wZW5Ccm93c2VyKHVybDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGNtZCA9XG4gICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIlxuICAgICAgPyBbXCJvcGVuXCIsIHVybF1cbiAgICAgIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiXG4gICAgICAgID8gW1wiY21kXCIsIFwiL2NcIiwgXCJzdGFydFwiLCBcIlwiLCB1cmxdXG4gICAgICAgIDogW1wieGRnLW9wZW5cIiwgdXJsXTtcbiAgdHJ5IHtcbiAgICBCdW4uc3Bhd24oeyBjbWQsIHN0ZG91dDogXCJpZ25vcmVcIiwgc3RkZXJyOiBcImlnbm9yZVwiIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvKiBiZXN0LWVmZm9ydCAqL1xuICB9XG59XG5cbmNvbnN0IE1JTUVfQllfRVhUOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcIi5odG1sXCI6IFwidGV4dC9odG1sOyBjaGFyc2V0PXV0Zi04XCIsXG4gIFwiLmNzc1wiOiBcInRleHQvY3NzOyBjaGFyc2V0PXV0Zi04XCIsXG4gIFwiLmpzXCI6IFwiYXBwbGljYXRpb24vamF2YXNjcmlwdDsgY2hhcnNldD11dGYtOFwiLFxuICBcIi5qc29uXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbiAgXCIuanBnXCI6IFwiaW1hZ2UvanBlZ1wiLFxuICBcIi5qcGVnXCI6IFwiaW1hZ2UvanBlZ1wiLFxuICBcIi5naWZcIjogXCJpbWFnZS9naWZcIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxuICBcIi53ZWJwXCI6IFwiaW1hZ2Uvd2VicFwiLFxuICBcIi5pY29cIjogXCJpbWFnZS94LWljb25cIixcbiAgXCIud29mZlwiOiBcImZvbnQvd29mZlwiLFxuICBcIi53b2ZmMlwiOiBcImZvbnQvd29mZjJcIixcbn07XG5mdW5jdGlvbiBndWVzc01pbWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZG90ID0gbmFtZS5sYXN0SW5kZXhPZihcIi5cIik7XG4gIGNvbnN0IGV4dCA9IGRvdCA+PSAwID8gbmFtZS5zbGljZShkb3QpLnRvTG93ZXJDYXNlKCkgOiBcIlwiO1xuICByZXR1cm4gTUlNRV9CWV9FWFRbZXh0XSB8fCBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiO1xufVxuXG5jb25zdCBFWFRfQllfTUlNRTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCJpbWFnZS9wbmdcIjogXCIucG5nXCIsXG4gIFwiaW1hZ2UvanBlZ1wiOiBcIi5qcGdcIixcbiAgXCJpbWFnZS9qcGdcIjogXCIuanBnXCIsXG4gIFwiaW1hZ2Uvd2VicFwiOiBcIi53ZWJwXCIsXG4gIFwiaW1hZ2UvZ2lmXCI6IFwiLmdpZlwiLFxuICBcImltYWdlL3N2Zyt4bWxcIjogXCIuc3ZnXCIsXG59O1xuXG4vLyBEZWNvZGUgYSBgZGF0YTo8bWltZT47YmFzZTY0LDxwYXlsb2FkPmAgVVJMIHRvIGEgZmlsZSB0aGUgYWdlbnQgY2FuIFJlYWQgKGl0c1xuLy8gdmlzaW9uIG5lZWRzIHJlYWwgcGl4ZWxzKS4gUmV0dXJucyB0aGUgcGF0aCwgb3IgXCJcIiBvbiBhbnkgZmFpbHVyZS5cbmZ1bmN0aW9uIHNhdmVEYXRhVXJsKGRpcjogc3RyaW5nLCBpZDogc3RyaW5nLCBkYXRhVXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBtID0gL15kYXRhOihbXjtdKyk7YmFzZTY0LCguKikkL3MuZXhlYyhkYXRhVXJsKTtcbiAgaWYgKCFtIHx8ICFkaXIpIHJldHVybiBcIlwiO1xuICBjb25zdCBleHQgPSBFWFRfQllfTUlNRVttWzFdLnRvTG93ZXJDYXNlKCldID8/IFwiLmJpblwiO1xuICAvLyBgaWRgIGNhbiBiZSBhZ2VudC1zdXBwbGllZCAoYmF0Y2gvcmVmIGlkcykg4oCUIHNhbml0aXplIHNvIGl0IGNhbid0IHRyYXZlcnNlXG4gIC8vIG91dCBvZiB0aGUgc2Vzc2lvbiBmaWxlcyBkaXIgdmlhIGAuLmAgb3IgYWJzb2x1dGUtcGF0aCBzZWdtZW50cy5cbiAgY29uc3Qgc2FmZUlkID0gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfLV0vZywgXCJfXCIpO1xuICBjb25zdCBwYXRoID0gam9pbihkaXIsIGAke3NhZmVJZH0ke2V4dH1gKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKHBhdGgsIEJ1ZmZlci5mcm9tKG1bMl0sIFwiYmFzZTY0XCIpKTtcbiAgICByZXR1cm4gcGF0aDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFwiXCI7XG4gIH1cbn1cblxuLy8g4pSA4pSAIGFnZW50LWZhY2luZyBwcm9qZWN0aW9uczogc3RyaXAgdGhlIChodWdlKSBpbmxpbmVkIGRhdGEtVVJMIGJsb2JzLiBUaGVcbi8vIGFnZW50IHJlYWRzIG9uLWRpc2sgYHBhdGhgcyBpbnN0ZWFkLCBrZWVwaW5nIC9zdGF0ZSBzbWFsbCByZWdhcmRsZXNzIG9mIHNpemUuXG5mdW5jdGlvbiB2YXJpYW50Rm9yQWdlbnQodjogVmFyaWFudCk6IE9taXQ8VmFyaWFudCwgXCJzcmNcIj4ge1xuICBjb25zdCB7IHNyYzogX2Ryb3AsIC4uLnJlc3QgfSA9IHY7XG4gIHJldHVybiByZXN0O1xufVxuZnVuY3Rpb24gYmF0Y2hGb3JBZ2VudChiOiBCYXRjaCk6IE9taXQ8QmF0Y2gsIFwidmFyaWFudHNcIj4gJiB7IHZhcmlhbnRzOiBPbWl0PFZhcmlhbnQsIFwic3JjXCI+W10gfSB7XG4gIHJldHVybiB7IC4uLmIsIHZhcmlhbnRzOiBiLnZhcmlhbnRzLm1hcCh2YXJpYW50Rm9yQWdlbnQpIH07XG59XG5mdW5jdGlvbiBjb250ZXh0Rm9yQWdlbnQoZTogQ29udGV4dEVudHJ5KTogT21pdDxDb250ZXh0RW50cnksIFwiaW1hZ2VcIj4ge1xuICBjb25zdCB7IGltYWdlOiBfZHJvcCwgLi4ucmVzdCB9ID0gZTtcbiAgcmV0dXJuIHJlc3Q7IC8vIGFnZW50IHJlYWRzIGltYWdlUGF0aCwgbm90IHRoZSBpbmxpbmVkIGJsb2Jcbn1cblxuLy8gU3RyaXAgdGhlIChsYXJnZSkgaW5saW5lZCBiaXRtYXAgZnJvbSBhbiBpbWFnZS1sYXllciBtYXJrIGluIHRoZSBhZ2VudFxuLy8gcHJvamVjdGlvbiDigJQgdGhlIGFnZW50IHJlYWRzIHRoZSBmbGF0dGVuZWQgY29tcG9zaXRlLCBuZXZlciBwZXItbGF5ZXIgYml0bWFwcy5cbi8vIFZlY3Rvci9waW4gbWFya3MgcGFzcyB0aHJvdWdoIHVuY2hhbmdlZC5cbmZ1bmN0aW9uIG1hcmtGb3JBZ2VudChtOiBNYXJrKTogTWFyayB8IE9taXQ8RXh0cmFjdDxNYXJrLCB7IHRvb2w6IFwiaW1hZ2VcIiB9PiwgXCJzcmNcIj4ge1xuICBpZiAobS50b29sID09PSBcImltYWdlXCIpIHtcbiAgICBjb25zdCB7IHNyYzogX2Ryb3AsIC4uLnJlc3QgfSA9IG07XG4gICAgcmV0dXJuIHJlc3Q7XG4gIH1cbiAgcmV0dXJuIG07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsZWFuU3RhdGUoczogSW1hZ29TdGF0ZSkge1xuICByZXR1cm4ge1xuICAgIC4uLnMsXG4gICAgYmF0Y2hlczogcy5iYXRjaGVzLm1hcChiYXRjaEZvckFnZW50KSxcbiAgICBsaWJyYXJ5OiBzLmxpYnJhcnkubWFwKGNvbnRleHRGb3JBZ2VudCksXG4gICAgbWFya3NCeVZhcmlhbnQ6IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgIE9iamVjdC5lbnRyaWVzKHMubWFya3NCeVZhcmlhbnQpLm1hcCgoW3ZpZCwgbWFya3NdKSA9PiBbdmlkLCBtYXJrcy5tYXAobWFya0ZvckFnZW50KV0pLFxuICAgICksXG4gIH07XG59XG5cbmNvbnN0IElNQUdFX0RBVEFfVVJMX1JFID0gL15kYXRhOmltYWdlXFwvW2EtejAtOS4rLV0rO2Jhc2U2NCwoLiopJC9pcztcblxuLy8gRG93bnNjYWxlK3dlYnAgYW4gaW5saW5lZCBpbWFnZSBkYXRhLXVybCBiZWZvcmUgaXQgZW50ZXJzIHN0YXRlIChyYXcgbW9kZWxcbi8vIFBOR3MgYXJlIHRoZSBkb21pbmFudCBzdGF0ZS1ibG9hdCBzb3VyY2UpLiBOb24tZGF0YS11cmwgc3JjcyAoaHR0cCwgZXRjLikgYW5kXG4vLyBhbnkgZmFpbHVyZSBwYXNzIHRocm91Z2ggdW5jaGFuZ2VkIOKAlCBvcHRpbWl6YXRpb24gaXMgYmVzdC1lZmZvcnQuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gb3B0aW1pemVTcmMoc3JjOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBtID0gSU1BR0VfREFUQV9VUkxfUkUuZXhlYyhzcmMpO1xuICBpZiAoIW0pIHJldHVybiBzcmM7XG4gIHRyeSB7XG4gICAgY29uc3QgaW5wdXQgPSBuZXcgVWludDhBcnJheShCdWZmZXIuZnJvbShtWzFdLCBcImJhc2U2NFwiKSk7XG4gICAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBvcHRpbWl6ZUltYWdlQnVmZmVyKGlucHV0KTtcbiAgICByZXR1cm4gYGRhdGE6aW1hZ2Uvd2VicDtiYXNlNjQsJHtCdWZmZXIuZnJvbShkYXRhKS50b1N0cmluZyhcImJhc2U2NFwiKX1gO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gc3JjO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1TdHlsZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gbmFtZS50cmltKCkudG9Mb3dlckNhc2UoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBwYXJzZWQ6IFJldHVyblR5cGU8dHlwZW9mIHBhcnNlQXJncz47XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gcGFyc2VBcmdzKHtcbiAgICAgIGFyZ3M6IGFyZ3YsXG4gICAgICBvcHRpb25zOiB7XG4gICAgICAgIHRpdGxlOiB7IHR5cGU6IFwic3RyaW5nXCIsIGRlZmF1bHQ6IFwiaW1hZ29cIiB9LFxuICAgICAgICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIsIGRlZmF1bHQ6IFwiMTgwMFwiIH0sXG4gICAgICAgIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiLCBkZWZhdWx0OiBmYWxzZSB9LFxuICAgICAgICBwb3J0OiB7IHR5cGU6IFwic3RyaW5nXCIsIGRlZmF1bHQ6IFwiMFwiIH0sXG4gICAgICAgIGhvc3Q6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVmYXVsdDogXCIxMjcuMC4wLjFcIiB9LFxuICAgICAgICBpZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LCAvLyBzbmFwc2hvdCBwYXRoIG9yIHNlc3Npb24gaWQgdG8gcmVzdW1lXG4gICAgICB9LFxuICAgICAgc3RyaWN0OiB0cnVlLFxuICAgICAgYWxsb3dQb3NpdGlvbmFsczogZmFsc2UsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgZXJyb3I6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIGNvbnN0IHYgPSBwYXJzZWQudmFsdWVzO1xuICBjb25zdCB0aW1lb3V0ID0gcGFyc2VGbG9hdCh2LnRpbWVvdXQgYXMgc3RyaW5nKTtcbiAgbGV0IHBvcnQgPSBwYXJzZUludCh2LnBvcnQgYXMgc3RyaW5nLCAxMCk7XG4gIGNvbnN0IGhvc3QgPSB2Lmhvc3QgYXMgc3RyaW5nO1xuICBsZXQgc2Vzc2lvbklkID0gKHYuaWQgYXMgc3RyaW5nIHwgdW5kZWZpbmVkKSA/PyBcIlwiO1xuICBpZiAocG9ydCA9PT0gMCAmJiBzZXNzaW9uSWQpIHtcbiAgICBjb25zdCBlbWJlZGRlZCA9IHBhcnNlUG9ydEZyb21TZXNzaW9uSWQoc2Vzc2lvbklkKTtcbiAgICBpZiAoZW1iZWRkZWQgIT09IG51bGwpIHBvcnQgPSBlbWJlZGRlZDtcbiAgfVxuXG4gIGNvbnN0IGFzc2V0c0RpciA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcImFzc2V0c1wiKTtcblxuICBsZXQgc3RhdGUgPSBkZWZhdWx0U3RhdGUodi50aXRsZSBhcyBzdHJpbmcpO1xuICBsZXQgcmVzdG9yZWQgPSBmYWxzZTtcblxuICAvLyBJbi1tZW1vcnksIHBlci12YXJpYW50IG1hcmstZWRpdCBoaXN0b3J5ICh1bmRvL3JlZG8pLiBTaXR1YXRpb25hbCDigJQgTk9UXG4gIC8vIHNuYXBzaG90dGVkLCBzbyBpdCByZXNldHMgb24gcmVkZXBsb3k7IHRoYXQncyBpbnRlbmRlZC4gRWFjaCBtdXRhdGluZyBtYXJrIG9wXG4gIC8vIHNuYXBzaG90cyB0aGUgcHJlLW11dGF0aW9uIG1hcmtzIGZvciB0aGF0IHZhcmlhbnQgb250byBgdW5kb2AgYW5kIGNsZWFyc1xuICAvLyBgcmVkb2AuIENhcHBlZCBzbyBpdCBjYW4ndCBncm93IHdpdGhvdXQgYm91bmQuXG4gIGNvbnN0IEhJU1RPUllfQ0FQID0gMTAwO1xuICAvLyBBIGhpc3RvcnkgZW50cnkgc25hcHNob3RzIEJPVEggdGhlIG1hcmtzIEFORCB0aGUgbGF5ZXIgY29udGFpbmVycyBmb3IgYVxuICAvLyB2YXJpYW50LCBzbyBhIGxheWVyIHJlbmFtZS9yZW9yZGVyL3Zpc2liaWxpdHkvZ3JvdXAgb3AgaXMgYXRvbWljYWxseSB1bmRvYWJsZVxuICAvLyBhbG9uZ3NpZGUgZWxlbWVudCBlZGl0cyAoY29udGFpbmVyIG1vZGVsIOKAlCBzZWUgdHlwZSBMYXllcikuXG4gIHR5cGUgTWFya1NuYXAgPSB7IG1hcmtzOiBNYXJrW107IGxheWVyczogTGF5ZXJbXSB9O1xuICBjb25zdCBtYXJrSGlzdG9yeTogUmVjb3JkPHN0cmluZywgeyB1bmRvOiBNYXJrU25hcFtdOyByZWRvOiBNYXJrU25hcFtdIH0+ID0ge307XG4gIGNvbnN0IGhpc3RGb3IgPSAodmlkOiBzdHJpbmcpID0+IChtYXJrSGlzdG9yeVt2aWRdID8/PSB7IHVuZG86IFtdLCByZWRvOiBbXSB9KTtcbiAgLy8gT05FIGZyZXNobmVzcyBmbGFnIHBlciB2YXJpYW50OiB0aGUgYWdlbnQgaGFzbid0IHNlZW4gdGhlc2UgbWFya3MgeWV0LiBTZXQgb25cbiAgLy8gZXZlcnkgbWFyayBjaGFuZ2U7IGNsZWFyZWQgd2hlbiB0aGUgYWdlbnQgcmVjZWl2ZXMgdGhlIG1hcmtlZCBpbWFnZSAoY29tbWl0XG4gIC8vIGJ1dHRvbiBPUiBhIHNheSB0aGF0IGNhcnJpZXMgaXQpLiBTZWUgSW1hZ29TdGF0ZS5tYXJrc1Vuc2Vlbi5cbiAgY29uc3QgbWFya1Vuc2VlbjogUmVjb3JkPHN0cmluZywgYm9vbGVhbj4gPSB7fTtcbiAgY29uc3Qgc25hcEZvciA9ICh2aWQ6IHN0cmluZyk6IE1hcmtTbmFwID0+ICh7XG4gICAgbWFya3M6IHN0cnVjdHVyZWRDbG9uZShzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdID8/IFtdKSxcbiAgICBsYXllcnM6IHN0cnVjdHVyZWRDbG9uZShzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXSA/PyBbXSksXG4gIH0pO1xuICBjb25zdCBwdXNoSGlzdG9yeSA9ICh2aWQ6IHN0cmluZyB8IHVuZGVmaW5lZCkgPT4ge1xuICAgIGlmICghdmlkKSByZXR1cm47XG4gICAgbWFya1Vuc2Vlblt2aWRdID0gdHJ1ZTsgLy8gYSBtYXJrL2xheWVyIGlzIGFib3V0IHRvIGNoYW5nZSDihpIgYWdlbnQncyB2aWV3IGlzIHN0YWxlXG4gICAgY29uc3QgaCA9IGhpc3RGb3IodmlkKTtcbiAgICBoLnVuZG8ucHVzaChzbmFwRm9yKHZpZCkpO1xuICAgIGlmIChoLnVuZG8ubGVuZ3RoID4gSElTVE9SWV9DQVApIGgudW5kby5zaGlmdCgpO1xuICAgIGgucmVkbyA9IFtdOyAvLyBhIGZyZXNoIGVkaXQgZm9ya3MgdGhlIHRpbWVsaW5lIOKAlCByZWRvIGlzIG5vIGxvbmdlciB2YWxpZFxuICB9O1xuICAvLyBDb250YWluZXIgbW9kZWw6IGV2ZXJ5IGVsZW1lbnQgYmVsb25ncyB0byBhIExheWVyLiBBIG5ldyB2ZWN0b3IgbWFyayBkcm9wc1xuICAvLyBpbnRvIHRoZSBhY3RpdmUgZHJhdyBsYXllciDigJQgdGhlIHRvcG1vc3QgTk9OLWltYWdlIGxheWVyIChkcmF3aW5nIFwiaW50b1wiIGFuXG4gIC8vIGltYWdlIGxheWVyIHJlYWRzIG9kZGx5KSwgY3JlYXRpbmcgYSBkZWZhdWx0IFwiQW5ub3RhdGlvbnNcIiBsYXllciBpZiB0aGVyZSdzXG4gIC8vIG5vIG5vbi1pbWFnZSBsYXllciB5ZXQgKGl0cyBwdXNoIGxhbmRzIGFib3ZlIGFueSBpbWFnZSBsYXllcnMsIHNvIGFubm90YXRpb25zXG4gIC8vIHBhaW50IG92ZXIgdGhlIGNvbGxhZ2UpLiBUaGUgYWN0aXZlIGxheWVyIGlzIG90aGVyd2lzZSBzdXJmYWNlLW93bmVkOiBtYXJrLmFkZFxuICAvLyBob25vcnMgYSB2YWxpZCBjbGllbnQgYG1hcmsubGF5ZXJJZGAgYW5kIG9ubHkgZmFsbHMgYmFjayB0byB0aGlzLiBDYWxsIEFGVEVSXG4gIC8vIHB1c2hIaXN0b3J5IHNvIHRoZSBhdXRvLWNyZWF0ZWQgbGF5ZXIgaXMgcGFydCBvZiB0aGUgc2FtZSB1bmRvYWJsZSBzdGVwLlxuICBjb25zdCBlbnN1cmVEcmF3TGF5ZXIgPSAodmlkOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuICAgIGlmICghc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0pIHN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdID0gW107XG4gICAgY29uc3QgbGF5ZXJzID0gc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF07XG4gICAgZm9yIChsZXQgaSA9IGxheWVycy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgICAgaWYgKGxheWVyc1tpXS5raW5kICE9PSBcImltYWdlXCIpIHJldHVybiBsYXllcnNbaV0uaWQ7XG4gICAgfVxuICAgIGNvbnN0IGxheWVyOiBMYXllciA9IHsgaWQ6IG5ld0lkKFwibGF5ZXJcIiksIG5hbWU6IFwiQW5ub3RhdGlvbnNcIiwga2luZDogXCJhbm5vdGF0aW9uXCIgfTtcbiAgICBsYXllcnMucHVzaChsYXllcik7XG4gICAgcmV0dXJuIGxheWVyLmlkO1xuICB9O1xuICAvLyDilIDilIAgY29udGV4dCBsaWJyYXJ5IGhlbHBlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIGZ1bmN0aW9uIGxpbmtDb250ZXh0KGlkOiBzdHJpbmcsIHNldDogQ29udGV4dFNldCkge1xuICAgIGlmICghc3RhdGUubGlicmFyeS5zb21lKChlKSA9PiBlLmlkID09PSBpZCkpIHJldHVybjtcbiAgICBjb25zdCBhcnIgPSBzZXQgPT09IFwiYWN0aXZlXCIgPyBzdGF0ZS5hY3RpdmVDb250ZXh0SWRzIDogc3RhdGUucXVpY2tQcm9tcHRJZHM7XG4gICAgaWYgKCFhcnIuaW5jbHVkZXMoaWQpKSBhcnIucHVzaChpZCk7XG4gIH1cbiAgZnVuY3Rpb24gdW5saW5rQ29udGV4dChpZDogc3RyaW5nLCBzZXQ6IENvbnRleHRTZXQpIHtcbiAgICBpZiAoc2V0ID09PSBcImFjdGl2ZVwiKSBzdGF0ZS5hY3RpdmVDb250ZXh0SWRzID0gc3RhdGUuYWN0aXZlQ29udGV4dElkcy5maWx0ZXIoKHgpID0+IHggIT09IGlkKTtcbiAgICBlbHNlIHN0YXRlLnF1aWNrUHJvbXB0SWRzID0gc3RhdGUucXVpY2tQcm9tcHRJZHMuZmlsdGVyKCh4KSA9PiB4ICE9PSBpZCk7XG4gIH1cbiAgLy8gQ3JlYXRlIGEgbGlicmFyeSBlbnRyeSwgb3IgcmVwb3J0IHdoeSBpdCBkaWQgbm90IGNyZWF0ZSBvbmUuXG4gIC8vXG4gIC8vIGI5IOKAlCB0aGlzIHVzZWQgdG8gYmUgYW4gVVBTRVJUIG9uIHRoZSBzdHlsZSBwYXRoOiBhbiBhZGQgd2hvc2UgbmFtZVxuICAvLyBub3JtYWxpemVkIG9udG8gYW4gZXhpc3Rpbmcgc3R5bGUgT1ZFUldST1RFIHRoYXQgZW50cnkncyBjb250ZW50LCB0YWdzIGFuZFxuICAvLyBpbWFnZSwgcmV0dXJuZWQgdGhlIGV4aXN0aW5nIGlkLCBhbmQgYW5zd2VyZWQgYXBwbGllZDp0cnVlLiBTaWxlbnQgZGF0YVxuICAvLyBsb3NzIG9uIGEgdmVyYiBjYWxsZWQgYGFkZGAsIGluIGEgaHVtYW4tcHJpbWFyeSBzcGVsbC4gSXQgYWxzbyBtYWRlIHRoZVxuICAvLyBkb2N1bWVudGVkIHJlY292ZXJ5IGZvciAjODcgKGRpZmYgdGhlIGJvYXJkIHRvIGZpbmQgdGhlIG5ldyBlbnRyeSlcbiAgLy8gQ09ORklERU5UTFkgV1JPTkcgaW4gZXhhY3RseSB0aGUgZGVzdHJ1Y3RpdmUgY2FzZTogdGhlIGxpYnJhcnkgY291bnQgaXNcbiAgLy8gdW5jaGFuZ2VkLCBzbyBhIGRpZmYgcmVwb3J0cyBcIm5vdGhpbmcgd2FzIGNyZWF0ZWRcIiDigJQgdHJ1ZSBmb3IgYSByZWplY3RlZFxuICAvLyBhZGQsIGZhbHNlIGZvciBvbmUgdGhhdCBoYWQganVzdCBkZXN0cm95ZWQgYSBodW1hbidzIHN0eWxlLlxuICAvL1xuICAvLyBUaHJlZSBvdXRjb21lcyBub3csIGFuZCB0aGUgY2FsbGVyIGNhbiB0ZWxsIHRoZW0gYXBhcnQgKGdyaW1vaXJlL1xuICAvLyBvdXRjb21lLWNvbnRyYWN0Lm1kKTpcbiAgLy8gICBjcmVhdGVkICAgICAgICAgIGEgbmV3IGVudHJ5IGV4aXN0czsgYGlkYCBpcyBuZXdcbiAgLy8gICBhbHJlYWR5LXJlY29yZGVkIHRoZSBuYW1lIGlzIHRha2VuIGFuZCBob25vcmluZyB0aGlzIGFkZCB3b3VsZCBjaGFuZ2VcbiAgLy8gICAgICAgICAgICAgICAgICAgIE5PVEhJTkcg4oCUIG5vIHdyaXRlIGhhcHBlbmVkLCBgaWRgIGlzIHRoZSBleGlzdGluZyBlbnRyeVxuICAvLyAgIHJlZnVzZWQgICAgICAgICAgdGhlIG5hbWUgaXMgdGFrZW4gYW5kIGhvbm9yaW5nIGl0IFdPVUxEIGNoYW5nZSB0aGUgZW50cnlcbiAgLy9cbiAgLy8g4puUIFRoZSByZWZ1c2FsIGlzIGRlbGliZXJhdGUgYW5kIGl0IGlzIHRoZSBjYXJkJ3MgaW5zdHJ1Y3Rpb246IHdoZXJlIHRoZVxuICAvLyBzYWZlIGJlaGF2aW91ciBpcyBhbWJpZ3VvdXMsIFJFRlVTRSBBTkQgUkVQT1JUIHJhdGhlciB0aGFuIGd1ZXNzLCBiZWNhdXNlIGFcbiAgLy8gcmVmdXNhbCBpcyByZWNvdmVyYWJsZSBhbmQgYW4gb3ZlcndyaXRlIGlzIG5vdC4gYGNvbnRleHQudXBkYXRlYCBhbHJlYWR5XG4gIC8vIGV4aXN0cyBmb3IgY2FsbGVycyB0aGF0IGdlbnVpbmVseSBtZWFuIHRvIGNoYW5nZSBhbiBlbnRyeS5cbiAgLy9cbiAgLy8gTk9UIERFU0lHTkVEIEhFUkUsIG9uIHB1cnBvc2U6IHdoZXRoZXIgYW4gYWdlbnQgc2hvdWxkIGJlIGFibGUgdG8gdXBkYXRlIGFcbiAgLy8gc3R5bGUgdGhyb3VnaCBgYWRkYCBhdCBhbGwg4oCUIGEgZmxhZywgYSBzZXBhcmF0ZSB2ZXJiLCBhIHByb21wdC4gVGhhdFxuICAvLyBjaGFuZ2VzIHdoYXQgYSBodW1hbiBzZWVzIGFuZCBpcyBDb2xlJ3MgY2FsbCwgbm90IHRoZSB3aXJlJ3MuXG4gIHR5cGUgQWdlbnRWZXJkaWN0ID1cbiAgICB8IGJvb2xlYW5cbiAgICB8IHsgcmVjb2duaXNlZDogdHJ1ZTsgb2s6IHRydWU7IGRldGFpbDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfVxuICAgIHwge1xuICAgICAgICByZWNvZ25pc2VkOiB0cnVlO1xuICAgICAgICBvazogZmFsc2U7XG4gICAgICAgIHN0YXR1czogbnVtYmVyO1xuICAgICAgICBlcnJvcjogc3RyaW5nO1xuICAgICAgICBkZXRhaWw/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIH07XG5cbiAgdHlwZSBBZGRDb250ZXh0UmVzdWx0ID1cbiAgICB8IHsgb2s6IHRydWU7IGlkOiBzdHJpbmc7IG91dGNvbWU6IFwiY3JlYXRlZFwiIHwgXCJhbHJlYWR5LXJlY29yZGVkXCIgfVxuICAgIHwge1xuICAgICAgICBvazogdHJ1ZTtcbiAgICAgICAgaWQ6IHN0cmluZztcbiAgICAgICAgb3V0Y29tZTogXCJ1cGRhdGVkXCI7XG4gICAgICAgIGNoYW5nZWQ6IHN0cmluZ1tdO1xuICAgICAgICBwcmV2aW91czogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICB9XG4gICAgfCB7IG9rOiBmYWxzZTsgZXJyb3I6IHN0cmluZzsgaWQ/OiBzdHJpbmcgfTtcblxuICBmdW5jdGlvbiBhZGRDb250ZXh0RW50cnkobXNnOiB7XG4gICAga2luZDogQ29udGV4dEtpbmQ7XG4gICAgbmFtZTogc3RyaW5nO1xuICAgIGNvbnRlbnQ/OiBzdHJpbmc7XG4gICAgdGFncz86IHN0cmluZ1tdO1xuICAgIGltYWdlPzogc3RyaW5nO1xuICB9KTogQWRkQ29udGV4dFJlc3VsdCB7XG4gICAgaWYgKHR5cGVvZiBtc2cubmFtZSAhPT0gXCJzdHJpbmdcIiB8fCAhbXNnLm5hbWUudHJpbSgpKVxuICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogXCJjb250ZXh0LmFkZCByZXF1aXJlcyBhIG5vbi1lbXB0eSBuYW1lXCIgfTtcbiAgICBjb25zdCBjb250ZW50ID0gdHlwZW9mIG1zZy5jb250ZW50ID09PSBcInN0cmluZ1wiID8gbXNnLmNvbnRlbnQgOiBcIlwiO1xuICAgIGNvbnN0IHRhZ3MgPSBBcnJheS5pc0FycmF5KG1zZy50YWdzKSA/IG1zZy50YWdzIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IGltYWdlU3JjID1cbiAgICAgIHR5cGVvZiBtc2cuaW1hZ2UgPT09IFwic3RyaW5nXCIgJiYgbXNnLmltYWdlLnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSA/IG1zZy5pbWFnZSA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCBpbWFnZVBhdGggPSBpbWFnZVNyY1xuICAgICAgPyBzYXZlRGF0YVVybChzZXNzaW9uRmlsZXNEaXIsIG5ld0lkKFwiY3R4XCIpLCBpbWFnZVNyYykgfHwgdW5kZWZpbmVkXG4gICAgICA6IHVuZGVmaW5lZDtcbiAgICBpZiAobXNnLmtpbmQgPT09IFwic3R5bGVcIikge1xuICAgICAgY29uc3QgbmFtZSA9IG5vcm1TdHlsZShtc2cubmFtZSk7XG4gICAgICBjb25zdCBleGlzdGluZyA9IHN0YXRlLmxpYnJhcnkuZmluZCgoZSkgPT4gZS5raW5kID09PSBcInN0eWxlXCIgJiYgbm9ybVN0eWxlKGUubmFtZSkgPT09IG5hbWUpO1xuICAgICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICAgIC8vIFRoZSB1cHNlcnQgU1RBWVMg4oCUIGl0IGlzIGEgZGVzaWduZWQsIHRlc3RlZCBjYXBhYmlsaXR5LCBhbmQgcmVmdXNpbmdcbiAgICAgICAgLy8gaXQgd291bGQgYW5zd2VyIGEgcXVlc3Rpb24gcmVzZXJ2ZWQgZm9yIENvbGUgKFwic2hvdWxkIGFuIGFnZW50IGJlIGFibGVcbiAgICAgICAgLy8gdG8gdXBkYXRlIGEgc3R5bGUgdGhyb3VnaCBhZGQ/XCIpIHdoaWxlIGNhbGxpbmcgdGhhdCBuZXV0cmFsaXR5LlxuICAgICAgICAvL1xuICAgICAgICAvLyBXaGF0IGNoYW5nZXMgaXMgdGhhdCBpdCBpcyBubyBsb25nZXIgU0lMRU5ULCBhbmQgbm8gbG9uZ2VyXG4gICAgICAgIC8vIHVucmVjb3ZlcmFibGU6IHRoZSByZXN1bHQgbmFtZXMgZWFjaCBmaWVsZCBpdCBvdmVyd3JvdGUgYW5kIGNhcnJpZXNcbiAgICAgICAgLy8gdGhhdCBmaWVsZCdzIFBSSU9SIFZBTFVFLCBzbyB0aGUgY2FsbGVyIGNhbiBwdXQgaXQgYmFjay4gVGhhdCBjb252ZXJ0c1xuICAgICAgICAvLyBhbiB1bnJlY292ZXJhYmxlIHdyaXRlIGludG8gYSByZWNvdmVyYWJsZSBvbmUgYXQgdGhlIHdpcmUgbGV2ZWwg4oCUXG4gICAgICAgIC8vIHdoaWNoIGlzIG91cnMg4oCUIHdpdGhvdXQgdG91Y2hpbmcgdGhlIGNhcGFiaWxpdHksIHdoaWNoIGlzIG5vdC5cbiAgICAgICAgY29uc3QgY2hhbmdlZDogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgY29uc3QgcHJldmlvdXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgICAgIGlmIChjb250ZW50ICYmIGNvbnRlbnQgIT09IGV4aXN0aW5nLmNvbnRlbnQpIHtcbiAgICAgICAgICBjaGFuZ2VkLnB1c2goXCJjb250ZW50XCIpO1xuICAgICAgICAgIHByZXZpb3VzLmNvbnRlbnQgPSBleGlzdGluZy5jb250ZW50O1xuICAgICAgICAgIGV4aXN0aW5nLmNvbnRlbnQgPSBjb250ZW50O1xuICAgICAgICB9XG4gICAgICAgIGlmICh0YWdzICYmIEpTT04uc3RyaW5naWZ5KHRhZ3MpICE9PSBKU09OLnN0cmluZ2lmeShleGlzdGluZy50YWdzKSkge1xuICAgICAgICAgIGNoYW5nZWQucHVzaChcInRhZ3NcIik7XG4gICAgICAgICAgcHJldmlvdXMudGFncyA9IGV4aXN0aW5nLnRhZ3M7XG4gICAgICAgICAgZXhpc3RpbmcudGFncyA9IHRhZ3M7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGltYWdlU3JjICYmIGltYWdlU3JjICE9PSBleGlzdGluZy5pbWFnZSkge1xuICAgICAgICAgIGNoYW5nZWQucHVzaChcImltYWdlXCIpO1xuICAgICAgICAgIC8vIFRoZSBQQVRILCBub3QgdGhlIGJsb2IuIHNhdmVEYXRhVXJsIGFscmVhZHkgcGVyc2lzdGVkIHRoZSBwcmlvclxuICAgICAgICAgIC8vIGltYWdlIHRvIGRpc2ssIHNvIHRoZSBwYXRoIGlzIGEgY29tcGxldGUgcmVjb3ZlcnkgaGFuZGxlIGFuZCBlY2hvaW5nXG4gICAgICAgICAgLy8gYSBiYXNlNjQgZGF0YSBVUkwgYmFjayB0aHJvdWdoIHRoZSBlbnZlbG9wZSBjb3VsZCBiZSBtZWdhYnl0ZXMuIEFcbiAgICAgICAgICAvLyByZWNvdmVyeSBhZmZvcmRhbmNlIHRoYXQgaXMgdG9vIGhlYXZ5IHRvIHNlbmQgaXMgbm90IG9uZS5cbiAgICAgICAgICBwcmV2aW91cy5pbWFnZSA9IGV4aXN0aW5nLmltYWdlUGF0aCA/PyBudWxsO1xuICAgICAgICAgIGV4aXN0aW5nLmltYWdlID0gaW1hZ2VTcmM7XG4gICAgICAgICAgZXhpc3RpbmcuaW1hZ2VQYXRoID0gaW1hZ2VQYXRoO1xuICAgICAgICAgIGV4aXN0aW5nLmNhcHR1cmVkID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICAvLyBOYW1lIHRha2VuIGFuZCBub3RoaW5nIHdvdWxkIGNoYW5nZTogdGhlIHdvcmsgd2FzIHVubmVjZXNzYXJ5IGFuZCBOT1xuICAgICAgICAvLyBXUklURSBoYXBwZW5lZC4gRGlzdGluY3QgZnJvbSBgdXBkYXRlZGAsIHdoZXJlIGEgd3JpdGUgZGlkLlxuICAgICAgICBpZiAoIWNoYW5nZWQubGVuZ3RoKSByZXR1cm4geyBvazogdHJ1ZSwgaWQ6IGV4aXN0aW5nLmlkLCBvdXRjb21lOiBcImFscmVhZHktcmVjb3JkZWRcIiB9O1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgaWQ6IGV4aXN0aW5nLmlkLCBvdXRjb21lOiBcInVwZGF0ZWRcIiwgY2hhbmdlZCwgcHJldmlvdXMgfTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGlkID0gbmV3SWQoXCJjdHhcIik7XG4gICAgICBzdGF0ZS5saWJyYXJ5LnB1c2goe1xuICAgICAgICBpZCxcbiAgICAgICAga2luZDogXCJzdHlsZVwiLFxuICAgICAgICBuYW1lLFxuICAgICAgICBjb250ZW50LFxuICAgICAgICB0YWdzLFxuICAgICAgICBpbWFnZTogaW1hZ2VTcmMsXG4gICAgICAgIGltYWdlUGF0aCxcbiAgICAgICAgY2FwdHVyZWQ6IGltYWdlU3JjID8gdHJ1ZSA6IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGlkLCBvdXRjb21lOiBcImNyZWF0ZWRcIiB9O1xuICAgIH1cbiAgICBjb25zdCBpZCA9IG5ld0lkKFwiY3R4XCIpO1xuICAgIHN0YXRlLmxpYnJhcnkucHVzaCh7XG4gICAgICBpZCxcbiAgICAgIGtpbmQ6IG1zZy5raW5kLFxuICAgICAgbmFtZTogbXNnLm5hbWUudHJpbSgpLFxuICAgICAgY29udGVudCxcbiAgICAgIHRhZ3MsXG4gICAgICBpbWFnZTogaW1hZ2VTcmMsXG4gICAgICBpbWFnZVBhdGgsXG4gICAgfSk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIGlkLCBvdXRjb21lOiBcImNyZWF0ZWRcIiB9O1xuICB9XG5cbiAgLy8gQSBzaW5nbGUgZWxlbWVudCdzIG5hdHVyYWwgY29udGFpbmVyIGtpbmQgKyBsYWJlbCAodXNlZCBieSBncm91cC91bmdyb3VwKS5cbiAgY29uc3Qga2luZEZvclRvb2wgPSAodG9vbDogTWFya1tcInRvb2xcIl0pOiBMYXllcltcImtpbmRcIl0gPT5cbiAgICB0b29sID09PSBcImltYWdlXCIgPyBcImltYWdlXCIgOiB0b29sID09PSBcImRyYXdcIiA/IFwic2tldGNoXCIgOiBcImFubm90YXRpb25cIjtcbiAgY29uc3QgVE9PTF9MQUJFTDogUmVjb3JkPE1hcmtbXCJ0b29sXCJdLCBzdHJpbmc+ID0ge1xuICAgIHBpbjogXCJQaW5cIixcbiAgICBhcnJvdzogXCJBcnJvd1wiLFxuICAgIGxpbmU6IFwiTGluZVwiLFxuICAgIHJlY3Q6IFwiUmVjdGFuZ2xlXCIsXG4gICAgZWxsaXBzZTogXCJFbGxpcHNlXCIsXG4gICAgZHJhdzogXCJTa2V0Y2hcIixcbiAgICBpbWFnZTogXCJJbWFnZVwiLFxuICB9O1xuICBpZiAodi5yZXN0b3JlKSB7XG4gICAgY29uc3QgcmVzdG9yZVBhdGggPSBleGlzdHNTeW5jKHYucmVzdG9yZSBhcyBzdHJpbmcpXG4gICAgICA/ICh2LnJlc3RvcmUgYXMgc3RyaW5nKVxuICAgICAgOiBqb2luKFNOQVBTSE9UU19ESVIsIGAke3YucmVzdG9yZX0uanNvbmApO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzbmFwID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocmVzdG9yZVBhdGgsIFwidXRmOFwiKSkgYXMgUGFydGlhbDxJbWFnb1N0YXRlPjtcbiAgICAgIC8vIE1lcmdlIG92ZXIgZGVmYXVsdHMgc28gc25hcHNob3RzIGZyb20gb2xkZXIgYnVpbGRzIGdhaW4gbmV3IGZpZWxkcy5cbiAgICAgIHN0YXRlID0geyAuLi5kZWZhdWx0U3RhdGUodi50aXRsZSBhcyBzdHJpbmcpLCAuLi5zbmFwIH0gYXMgSW1hZ29TdGF0ZTtcbiAgICAgIHJlc3RvcmVkID0gdHJ1ZTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgYGltYWdvOiByZXN0b3JlIGZhaWxlZCAoJHtyZXN0b3JlUGF0aH0pOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG5gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgY29uc3Qgc29ja2V0cyA9IG5ldyBTZXQ8U2VydmVyV2ViU29ja2V0PHVua25vd24+PigpO1xuXG4gIC8vIFRoZSByZXBsYXkgbG9nIGJlaGluZCBgR0VUIC9ldmVudHM/c2luY2U9PGlkPmAg4oCUIHNoYXJlZFxuICAvLyAoYGtpdC93aXJlL2V2ZW50TG9nLnRzYCkuIOKblCBUSFJFRSBDRU5TVVMgREVGRUNUUyBESUUgSEVSRSBBTkQgTk9ORSBPRiBUSEVNXG4gIC8vIEJZIEFOWU9ORSBSRU1FTUJFUklORzpcbiAgLy8gICDCtyBMNSDigJQgdGhlIGJ1ZmZlciB3YXMgYGNvbnN0IGV2ZW50czogQXJyYXk84oCmPiA9IFtdYCwgcHVzaGVkIGZvciB0aGVcbiAgLy8gICAgIGRhZW1vbidzIHdob2xlIGxpZmUuIEl0IGlzIG5vdyBib3VuZGVkIGF0IDEsMDAwIGZyYW1lcy5cbiAgLy8gICDCtyB0aGUgbW9ub3RvbmljIGlkIG5vdyBhY3R1YWxseSBXSU5TIG92ZXIgYSBwYXlsb2FkIGBpZGAuIFRoZSBvbGRcbiAgLy8gICAgIGB7IGlkOiArK2V2ZW50U2VxLCAuLi5tc2cgfWAgc3ByZWFkIEFGVEVSIHRoZSBpZCwgc28gYW55IGNhbGxlciBwYXNzaW5nXG4gIC8vICAgICBhbiBgaWRgIHNpbGVudGx5IG92ZXJyb2RlIHRoZSBjdXJzb3Ig4oCUIGFuZCBpbWFnbydzIGZyYW1lcyBkbyBjYXJyeSBpZHNcbiAgLy8gICAgIChgeyB0eXBlOiBcInByb3Bvc2FsLnNlbmRcIiwgaWQ6IG1zZy5pZCB9YCksIHdoaWNoIG1hZGUgdGhpcyBsaXZlIHJhdGhlclxuICAvLyAgICAgdGhhbiB0aGVvcmV0aWNhbDogdGhvc2UgdHdvIGZyYW1lcyB3ZW50IG91dCB3aXRoIHRoZSBQUk9QT1NBTCdzIGlkIGFzXG4gIC8vICAgICB0aGVpciBjdXJzb3IgdmFsdWUuIEZpeGVkIGJ5IGNvbnN0cnVjdGlvbi5cbiAgLy8gICDCtyBhIGA/c2luY2U9YCB0aGF0IHdpbGwgbm90IHBhcnNlIHVzZWQgdG8geWllbGQgTmFOLCBmYWlsIGV2ZXJ5IGA+YFxuICAvLyAgICAgY29tcGFyaXNvbiwgYW5kIG9wZW4gdGhlIHRhaWwgRU1QVFkgYW5kIGNvbm5lY3RlZC4gQWJzZW50IGFuZFxuICAvLyAgICAgdW5wYXJzZWFibGUgbm93IG1lYW4gdGhlIHNhbWUgdGhpbmc6IGZyb20gdGhlIHN0YXJ0LlxuICAvL1xuICAvLyDimqAgSU1BR08gU1RBTVBTIE5PIEVQT0NILCBhbmQgdGhhdCBpcyBnbGFtb3VyJ3MgcnVsaW5nIGZvciBnbGFtb3VyJ3MgcmVhc29uLFxuICAvLyB3aGljaCBpcyBpbWFnbydzIHRvbzogYSBzZXNzaW9uIGlzIGlkZW50aWZpZWQgYnkgYHNlc3Npb25faWRgLCBhIHJlc3RhcnQgaXNcbiAgLy8gYSBESUZGRVJFTlQgc2Vzc2lvbiwgYW5kIGEgcmVzdW1pbmcgdGFpbCBpcyBhbHJlYWR5IHRhbGtpbmcgdG8gYSBkaWZmZXJlbnRcbiAgLy8gZGFlbW9uIGJ5IG5hbWUuIENlbnN1cyBkZWZlY3QgTDYgaXMgdGhlcmVmb3JlIE5BUlJPV0VEIGhlcmUgcmF0aGVyIHRoYW5cbiAgLy8gY2xvc2VkIOKAlCBgc3Vic2NyaWJlYCB0cmVhdGluZyBgc2luY2UgPiBjdXJzb3JgIGFzIFwidGhhdCBjdXJzb3IgaXMgZnJvbVxuICAvLyBhbm90aGVyIHByb2Nlc3NcIiBpcyB3aGF0IGEgcmVzdW1pbmcgdGFpbCBhY3R1YWxseSBnZXRzIOKAlCBhbmQgdGhlIGVwb2NoIHF1ZXJ5XG4gIC8vIHBhcmFtZXRlciB0aGF0IHdvdWxkIGNsb3NlIGl0IGlzIGRlbGliZXJhdGVseSBvdXQgb2Ygc2NvcGUgKEQyMykuXG4gIGNvbnN0IGxvZyA9IGNyZWF0ZUV2ZW50TG9nPFJlY29yZDxzdHJpbmcsIHVua25vd24+PigpO1xuICBjb25zdCBzc2VDbGllbnRzOiBTc2VDbGllbnRzID0gbmV3IFNldCgpO1xuXG4gIGxldCByZXNvbHZlRG9uZSE6ICh2YWw6IERvbmVSZXN1bHQpID0+IHZvaWQ7XG4gIGxldCBzZXR0bGVkID0gZmFsc2U7XG4gIGNvbnN0IGRvbmUgPSBuZXcgUHJvbWlzZTxEb25lUmVzdWx0PigocmVzKSA9PiB7XG4gICAgcmVzb2x2ZURvbmUgPSAodmFsKSA9PiB7XG4gICAgICBpZiAoc2V0dGxlZCkgcmV0dXJuO1xuICAgICAgc2V0dGxlZCA9IHRydWU7XG4gICAgICByZXModmFsKTtcbiAgICB9O1xuICB9KTtcblxuICBsZXQgbGFzdEFjdGl2aXR5ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gIGNvbnN0IHRvdWNoID0gKCkgPT4ge1xuICAgIGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICB9O1xuXG4gIGNvbnN0IGVtaXRFdmVudCA9IChtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBsb2cuZW1pdChtc2cpO1xuXG4gIC8vIFByZXNlbmNlIGlzIFRSQU5TSUVOVDogaXQgZ29lcyB0byB0aGUgbGl2ZSBTU0UgY2xpZW50cyBhbmQgaXMgTkVWRVIgc3RvcmVkXG4gIC8vIGluIHRoZSByZXBsYXkgbG9nIOKAlCBjZW5zdXMgZGVmZWN0IEw3LCB3aGljaCBpbWFnbyBoYWQuIEEgcmVjb25uZWN0aW5nIGFnZW50XG4gIC8vIHNob3VsZCBub3QgcmUtc2VlIGV2ZXJ5IHBhc3QgY29ubmVjdC9kaXNjb25uZWN0LCBhbmQgdGhlc2UgZnJhbWVzIGNhcnJ5IG5vXG4gIC8vIGlkLCBzbyB0aGV5IG5ldmVyIGFkdmFuY2UgYSB0YWlsIGN1cnNvciBlaXRoZXIuIFNLSUxMLm1kJ3MgZG9jdW1lbnRlZCB3YWtlXG4gIC8vIGdyZXAgc3RpbGwgcmVjZWl2ZXMgdGhlbSBsaXZlLCB3aGljaCBpcyBhbGwgaXQgZXZlciB3YW50ZWQgdGhlbSBmb3IuXG4gIC8vXG4gIC8vIOKblCBgY2xpZW50LnNlbmRgIElTIFRIRSBNRU1CRVIgVEhBVCBNQUtFUyBUSElTIFBPU1NJQkxFIFdJVEhPVVQgQSBTRUNPTkRcbiAgLy8gUkVHSVNUUlkuIFBoYXNlIDIgd2lkZW5lZCBgU3NlQ2xpZW50c2AgZm9yIGV4YWN0bHkgdGhpcyDigJQga2VlcGluZyBhIHBhcmFsbGVsXG4gIC8vIGBTZXQ8UmVhZGFibGVTdHJlYW1EZWZhdWx0Q29udHJvbGxlcj5gIGhlcmUgd291bGQgcmUtY3JlYXRlIHRoZSBkcmlmdCB0aGVcbiAgLy8gcmVnaXN0cnkgZXhpc3RzIHRvIHJlbW92ZSwgYW5kIGl0IGlzIHRoZSBkcmlmdCBpbWFnbydzIE9MRCBjb2RlIGhhZDogdHdvXG4gIC8vIHNldHMgKGBzc2VDbGllbnRzYCwgYHNzZVRpbWVyc2ApIHN3ZXB0IGluIHR3byBwbGFjZXMgYXQgdGVhcmRvd24uXG4gIGNvbnN0IGVtaXRUcmFuc2llbnQgPSAobXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgIGNvbnN0IGZyYW1lID0gYGRhdGE6ICR7SlNPTi5zdHJpbmdpZnkobXNnKX1cXG5cXG5gO1xuICAgIGZvciAoY29uc3QgYyBvZiBzc2VDbGllbnRzKSBjLnNlbmQoZnJhbWUpO1xuICB9O1xuXG4gIGZ1bmN0aW9uIGJyb2FkY2FzdChtc2c6IG9iamVjdCkge1xuICAgIGNvbnN0IHMgPSBKU09OLnN0cmluZ2lmeShtc2cpO1xuICAgIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgd3Muc2VuZChzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBzb2NrZXQgY2xvc2VkICovXG4gICAgICB9XG4gICAgfVxuICB9XG4gIGxldCBzbmFwRGlydHkgPSBmYWxzZTtcbiAgY29uc3QgYnJvYWRjYXN0U3RhdGUgPSAoKSA9PiB7XG4gICAgc25hcERpcnR5ID0gdHJ1ZTsgLy8gbWFyayBmb3IgdGhlIHBlcnNpc3RlbmNlIHNuYXBzaG90XG4gICAgLy8gZGVyaXZlIHVuZG8vcmVkbyBhdmFpbGFiaWxpdHkgZm9yIHRoZSBmb2N1c2VkIHZhcmlhbnQgKGtlcHQgZnJlc2ggaGVyZSBzb1xuICAgIC8vIHRoZSB0b29sYmFyIGJ1dHRvbnMgcmVmbGVjdCB0aGUgbGl2ZSBoaXN0b3J5IHdpdGhvdXQgYSBzZXBhcmF0ZSBjaGFubmVsKVxuICAgIGNvbnN0IGggPSBzdGF0ZS5mb2N1cyA/IG1hcmtIaXN0b3J5W3N0YXRlLmZvY3VzLnZhcmlhbnRJZF0gOiB1bmRlZmluZWQ7XG4gICAgc3RhdGUuaGlzdG9yeSA9IHsgY2FuVW5kbzogKGg/LnVuZG8ubGVuZ3RoID8/IDApID4gMCwgY2FuUmVkbzogKGg/LnJlZG8ubGVuZ3RoID8/IDApID4gMCB9O1xuICAgIHN0YXRlLm1hcmtzVW5zZWVuID0gc3RhdGUuZm9jdXMgPyAobWFya1Vuc2VlbltzdGF0ZS5mb2N1cy52YXJpYW50SWRdID8/IGZhbHNlKSA6IGZhbHNlO1xuICAgIGJyb2FkY2FzdCh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGUgfSk7XG4gIH07XG5cbiAgbGV0IHNlc3Npb25GaWxlc0RpciA9IFwiXCI7IC8vIHNldCBvbmNlIHNlc3Npb25JZCBpcyBrbm93biAoYWZ0ZXIgYmluZClcbiAgY29uc3Qgc2F2ZVNuYXBzaG90ID0gKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmMoU05BUFNIT1RTX0RJUiwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oU05BUFNIT1RTX0RJUiwgYCR7c2Vzc2lvbklkfS5qc29uYCksIEpTT04uc3RyaW5naWZ5KHN0YXRlKSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBwZXJzaXN0ZW5jZSBpcyBiZXN0LWVmZm9ydCAqL1xuICAgIH1cbiAgfTtcblxuICAvLyDilIDilIAgaGVscGVycyBvdmVyIHRoZSBjYW5vbmljYWwgc3RhdGUg4pSA4pSAXG4gIGNvbnN0IGZpbmRCYXRjaCA9IChpZDogc3RyaW5nKSA9PiBzdGF0ZS5iYXRjaGVzLmZpbmQoKGIpID0+IGIuaWQgPT09IGlkKTtcbiAgZnVuY3Rpb24gZmluZFZhcmlhbnQoaWQ6IHN0cmluZyk6IHsgYmF0Y2g6IEJhdGNoOyB2YXJpYW50OiBWYXJpYW50OyBpbmRleDogbnVtYmVyIH0gfCBudWxsIHtcbiAgICBmb3IgKGNvbnN0IGIgb2Ygc3RhdGUuYmF0Y2hlcykge1xuICAgICAgY29uc3QgaW5kZXggPSBiLnZhcmlhbnRzLmZpbmRJbmRleCgoeCkgPT4geC5pZCA9PT0gaWQpO1xuICAgICAgaWYgKGluZGV4ID49IDApIHJldHVybiB7IGJhdGNoOiBiLCB2YXJpYW50OiBiLnZhcmlhbnRzW2luZGV4XSwgaW5kZXggfTtcbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgY29uc3QgbGFiZWxPZiA9IChpOiBudW1iZXIpID0+IFN0cmluZy5mcm9tQ2hhckNvZGUoOTcgKyBpKTtcbiAgLy8gVGhlIHJlZmVyZW5jZXMgXCJzZXRcIiBpcyBqdXN0IHRoZSB2YXJpYW50cyBmbGFnZ2VkIHJlZlNlbGVjdGVkIChvbmUgc291cmNlIG9mXG4gIC8vIHRydXRoOyB1c2VkIGJ5IGJvdGggdGhlIHNheSArIG1hcmtzLmNvbW1pdCBoYW5kb2ZmcykuIFNlZSByZWZzLWFzLWFzc2V0cyBwbGFuLlxuICBjb25zdCBzZWxlY3RlZFJlZklkcyA9ICgpOiBzdHJpbmdbXSA9PlxuICAgIHN0YXRlLmJhdGNoZXNcbiAgICAgIC5mbGF0TWFwKChiKSA9PiBiLnZhcmlhbnRzKVxuICAgICAgLmZpbHRlcigodikgPT4gdi5yZWZTZWxlY3RlZClcbiAgICAgIC5tYXAoKHYpID0+IHYuaWQpO1xuICAvLyBJbXBvcnQgYW4gZXh0ZXJuYWwgaW1hZ2UgYXMgYSBvbmUtdmFyaWFudCBpbXBvcnQta2luZCBiYXRjaCDigJQgdGhlIHVuaWZpZWQgcGF0aFxuICAvLyBmb3IgXCJicmluZyBpbiBhIHdvcmtpbmcgaW1hZ2VcIiBBTkQgXCJhZGQgYSByZWZlcmVuY2VcIi4gSGFzaGVzIGZvciBkZWR1cCArXG4gIC8vIGFuYWx5c2lzQ2FjaGU7IGlmIHRoZSBzYW1lIHBpeGVscyBhcmUgYWxyZWFkeSBpbXBvcnRlZCwgcmV0dXJucyB0aGUgZXhpc3RpbmdcbiAgLy8gdmFyaWFudCAobm8gZHVwbGljYXRlKS4gQ2FsbGVyIGRlY2lkZXMgZm9jdXMvcmVmU2VsZWN0ZWQuXG4gIGZ1bmN0aW9uIGltcG9ydEltYWdlVmFyaWFudChzcmM6IHN0cmluZywgbmFtZT86IHN0cmluZyk6IHsgYmF0Y2hJZDogc3RyaW5nOyB2YXJpYW50OiBWYXJpYW50IH0ge1xuICAgIGNvbnN0IGhhc2ggPSBjb250ZW50SGFzaChzcmMpO1xuICAgIGZvciAoY29uc3QgYiBvZiBzdGF0ZS5iYXRjaGVzKSB7XG4gICAgICBjb25zdCBleCA9IGIudmFyaWFudHMuZmluZCgodikgPT4gdi5oYXNoID09PSBoYXNoKTtcbiAgICAgIGlmIChleCkge1xuICAgICAgICBpZiAobmFtZSAmJiAhZXgubmFtZSkgZXgubmFtZSA9IG5hbWU7IC8vIGZpbGwgYSBtaXNzaW5nIG5hbWUgb24gYSBkZWR1cCBoaXRcbiAgICAgICAgcmV0dXJuIHsgYmF0Y2hJZDogYi5pZCwgdmFyaWFudDogZXggfTtcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgdmlkID0gbmV3SWQoXCJ2XCIpO1xuICAgIGNvbnN0IGJhdGNoSWQgPSBuZXdJZChcImJcIik7XG4gICAgY29uc3QgdmFyaWFudDogVmFyaWFudCA9IHtcbiAgICAgIGlkOiB2aWQsXG4gICAgICBzcmMsXG4gICAgICBwYXRoOiBzYXZlRGF0YVVybChzZXNzaW9uRmlsZXNEaXIsIHZpZCwgc3JjKSxcbiAgICAgIGxpa2VkOiBmYWxzZSxcbiAgICAgIGFuYWx5c2lzOiBzdGF0ZS5hbmFseXNpc0NhY2hlW2hhc2hdID8/IFwiXCIsIC8vIHJldXNlIGEgcHJpb3IgcmVhZCBvZiB0aGUgc2FtZSBwaXhlbHNcbiAgICAgIG5hbWUsXG4gICAgICBoYXNoLFxuICAgIH07XG4gICAgc3RhdGUuYmF0Y2hlcy5wdXNoKHsgaWQ6IGJhdGNoSWQsIGtpbmQ6IFwiaW1wb3J0XCIsIHByb21wdDogXCJcIiwgdGFnOiBuYW1lLCB2YXJpYW50czogW3ZhcmlhbnRdIH0pO1xuICAgIHJldHVybiB7IGJhdGNoSWQsIHZhcmlhbnQgfTtcbiAgfVxuICBmdW5jdGlvbiBwdXNoTWVzc2FnZShtOiBPbWl0PE1lc3NhZ2UsIFwiaWRcIiB8IFwidHNcIj4gJiB7IGlkPzogc3RyaW5nIH0pIHtcbiAgICBjb25zdCBtc2c6IE1lc3NhZ2UgPSB7IGlkOiBtLmlkID8/IG5ld0lkKFwibVwiKSwgdHM6IERhdGUubm93KCksIC4uLm0gfSBhcyBNZXNzYWdlO1xuICAgIHN0YXRlLmNvbnZlcnNhdGlvbi5wdXNoKG1zZyk7XG4gICAgcmV0dXJuIG1zZztcbiAgfVxuXG4gIC8vIOKUgOKUgCBhZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLy8gIzg0IOKAlCBSRVRVUk5TIEEgVkVSRElDVDogYHRydWVgIGlmIHRoZSBjb21tYW5kIHR5cGUgd2FzIFJFQ09HTklTRUQuXG4gIC8vXG4gIC8vIOKaoCBpbWFnbyBpcyB0aGUgRElTUFJPT0YgdGhhdCB0aGlzIGlzIGFuIGBhd2FpdGAgYnVnLiBUaGlzIGhhbmRsZXIgaXMgYXN5bmNcbiAgLy8gQU5EIGl0cyAvY21kIHJvdXRlIGFscmVhZHkgYXdhaXRzIGl0IGNvcnJlY3RseSDigJQgYW5kIHRoZSBkZWZlY3Qgd2FzIHByZXNlbnRcbiAgLy8gYW55d2F5LCBiZWNhdXNlIHRoZSByb3V0ZSBhbnN3ZXJlZCBhIGxpdGVyYWwge29rOnRydWV9IHdoaWxlIHRoZSBoYW5kbGVyXG4gIC8vIGdhdmUgaXQgbm90aGluZyB0byByZXBvcnQuIEFkZGluZyBgYXdhaXRgIHRvIGdsYW1vdXIgd291bGQgb25seSBoYXZlIG1hZGVcbiAgLy8gZ2xhbW91ciByZXNlbWJsZSBpbWFnbywgd2hpY2ggd2FzIGFsc28gYnJva2VuLlxuICAvL1xuICAvLyBcIlJlY29nbmlzZWRcIiwgTk9UIFwiY2hhbmdlZCBzdGF0ZVwiOiB0aGUgZm91ciBlYXJseSByZXR1cm5zIGJlbG93IGFyZSBndWFyZHNcbiAgLy8gaW5zaWRlIHJlY29nbmlzZWQgYnJhbmNoZXMgKGFuIGVtcHR5IHZhcmlhbnQgbGlzdCwgYSBtaXNzaW5nIGlkKSwgYW5kIGVhY2hcbiAgLy8gcmV0dXJucyBgdHJ1ZWAuIFJlcG9ydGluZyBhIHJlY29nbmlzZWQtYnV0LWluZXJ0IGNvbW1hbmQgYXMgYSBmYWlsdXJlIHdvdWxkXG4gIC8vIGJyZWFrIHdvcmtpbmcgY2FsbGVycyDigJQgdGhlIG92ZXItaW5jbHVzaXZlIGVycm9yIFAwYiBoYWQgdG8gYXZvaWQgaW4gdGhpc1xuICAvLyBzYW1lIHNwcmludC4gVGhlIG5hcnJvd2VyIGNvbnRyYWN0IChkaWQgaXQgYWN0dWFsbHkgdGFrZSBlZmZlY3Q/KSBpcyBhIHJlYWxcbiAgLy8gZ2FwLCBkZWxpYmVyYXRlbHkgVU5DTEFJTUVEIGFuZCByYWlzZWQgcmF0aGVyIHRoYW4gc2lsZW50bHkgYXNzdW1lZC5cbiAgLy9cbiAgLy8g4pqgIGhhbmRsZUJyb3dzZXJNc2cgYmVsb3cgaXMgYSBTRVBBUkFURSBmdW5jdGlvbiB3aXRoIGl0cyBvd24gaWYtY2hhaW4gYW5kIGFcbiAgLy8gbmVhci1pZGVudGljYWwgc2hhcGUuIEl0IGlzIE5PVCBwYXJ0IG9mIHRoaXMgdmVyZGljdCBhbmQgbXVzdCBub3QgYmUgZm9sZGVkXG4gIC8vIGluOiBpdCBzZXJ2ZXMgdGhlIFdlYlNvY2tldCwgd2hvc2UgY2FsbGVycyBoYXZlIG5vIHJlc3BvbnNlIHRvIGNhcnJ5IG9uZS5cbiAgLy8gQ29udHJhY3QgMTMgKHNlYW1zLm1kKTogdGhlIHZlcmRpY3Qgb3JpZ2luYXRlcyBpbiB0aGUgY29kZSB0aGF0IG93bnMgdGhlXG4gIC8vIHJlY29nbmlzZWQgc2V0LiBgZmFsc2VgID0gdGhlIHR5cGUgd2FzIG5vdCByZWNvZ25pc2VkOyBgdHJ1ZWAgPSBpdCB3YXMuXG4gIC8vXG4gIC8vIGI5IHdpZGVucyB0aGUgUkVUVVJOIHdpdGhvdXQgd2lkZW5pbmcgdGhlIENPTlRSQUNUOiBhIGNvbW1hbmQgbWF5IGluc3RlYWRcbiAgLy8gcmV0dXJuIGEgcmVzdWx0IG9iamVjdCBjYXJyeWluZyBpdHMgb3duIHN0YXR1cyBhbmQgcGF5bG9hZC4gRXZlcnkgY29tbWFuZFxuICAvLyB0aGF0IHJldHVybnMgYSBiYXJlIGJvb2xlYW4gaXMgdW5hZmZlY3RlZCBhbmQgaXRzIHJlc3BvbnNlIGlzIGJ5dGUtaWRlbnRpY2FsXG4gIC8vIOKAlCBvbmx5IGBjb250ZXh0LmFkZGAgdXNlcyB0aGUgcmljaGVyIGZvcm0gdG9kYXkuXG4gIGFzeW5jIGZ1bmN0aW9uIGhhbmRsZUFnZW50TXNnKG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPEFnZW50VmVyZGljdD4ge1xuICAgIGNvbnN0IHQgPSBtc2cudHlwZSBhcyBzdHJpbmc7XG4gICAgaWYgKHQgPT09IFwiaW5pdFwiKSB7XG4gICAgICBpZiAodHlwZW9mIG1zZy50aXRsZSA9PT0gXCJzdHJpbmdcIikgc3RhdGUudGl0bGUgPSBtc2cudGl0bGU7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJzYXlcIikge1xuICAgICAgaWYgKHR5cGVvZiBtc2cudGV4dCA9PT0gXCJzdHJpbmdcIiAmJiBtc2cudGV4dCkge1xuICAgICAgICBwdXNoTWVzc2FnZSh7IHJvbGU6IFwiYWdlbnRcIiwga2luZDogXCJ0ZXh0XCIsIHRleHQ6IG1zZy50ZXh0IH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJwcm9wb3NlXCIpIHtcbiAgICAgIGlmICh0eXBlb2YgbXNnLnByb21wdCA9PT0gXCJzdHJpbmdcIiAmJiBtc2cucHJvbXB0KSB7XG4gICAgICAgIGNvbnN0IG4gPSB0eXBlb2YgbXNnLm4gPT09IFwibnVtYmVyXCIgJiYgbXNnLm4gPiAwID8gTWF0aC5taW4oNCwgTWF0aC5mbG9vcihtc2cubikpIDogNDtcbiAgICAgICAgLy8gTm8gZnJhbWluZyB0ZXh0IG9uIHRoZSBwcm9wb3NhbCBpdHNlbGYg4oCUIHRoZSBhZ2VudCBgc2F5YHMgaXRzXG4gICAgICAgIC8vIHJlYXNvbmluZyBhcyBhIHByZWNlZGluZyBidWJibGUsIHRoZW4gYHByb3Bvc2VgcyB0aGUgY2FyZC5cbiAgICAgICAgcHVzaE1lc3NhZ2Uoe1xuICAgICAgICAgIHJvbGU6IFwiYWdlbnRcIixcbiAgICAgICAgICBraW5kOiBcInByb21wdFwiLFxuICAgICAgICAgIHRleHQ6IFwiXCIsXG4gICAgICAgICAgcHJvcG9zYWw6IHsgcHJvbXB0OiBtc2cucHJvbXB0LCBuLCBzdGF0dXM6IFwicGVuZGluZ1wiIH0sXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJhc2tcIikge1xuICAgICAgaWYgKHR5cGVvZiBtc2cudGV4dCA9PT0gXCJzdHJpbmdcIiAmJiBtc2cudGV4dCkge1xuICAgICAgICBwdXNoTWVzc2FnZSh7XG4gICAgICAgICAgcm9sZTogXCJhZ2VudFwiLFxuICAgICAgICAgIGtpbmQ6IFwicXVlc3Rpb25cIixcbiAgICAgICAgICB0ZXh0OiBtc2cudGV4dCxcbiAgICAgICAgICBvcHRpb25zOiBBcnJheS5pc0FycmF5KG1zZy5vcHRpb25zKSA/IChtc2cub3B0aW9ucyBhcyBzdHJpbmdbXSkgOiB1bmRlZmluZWQsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJiYXRjaC5hZGRcIikge1xuICAgICAgY29uc3QgdmFyaWFudHNJbiA9IEFycmF5LmlzQXJyYXkobXNnLnZhcmlhbnRzKVxuICAgICAgICA/IChtc2cudmFyaWFudHMgYXMgQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KVxuICAgICAgICA6IFtdO1xuICAgICAgaWYgKHZhcmlhbnRzSW4ubGVuZ3RoID09PSAwKSByZXR1cm4gdHJ1ZTtcbiAgICAgIGNvbnN0IGJhdGNoSWQgPSBuZXdJZChcImJcIik7XG4gICAgICBjb25zdCB2YXJpYW50czogVmFyaWFudFtdID0gW107XG4gICAgICBmb3IgKGNvbnN0IHJhdyBvZiB2YXJpYW50c0luKSB7XG4gICAgICAgIGlmICh0eXBlb2YgcmF3LnNyYyAhPT0gXCJzdHJpbmdcIikgY29udGludWU7XG4gICAgICAgIGNvbnN0IHZpZCA9IHR5cGVvZiByYXcuaWQgPT09IFwic3RyaW5nXCIgPyByYXcuaWQgOiBuZXdJZChcInZcIik7XG4gICAgICAgIGNvbnN0IHNyYyA9IGF3YWl0IG9wdGltaXplU3JjKHJhdy5zcmMpO1xuICAgICAgICB2YXJpYW50cy5wdXNoKHtcbiAgICAgICAgICBpZDogdmlkLFxuICAgICAgICAgIHNyYyxcbiAgICAgICAgICBwYXRoOiBzYXZlRGF0YVVybChzZXNzaW9uRmlsZXNEaXIsIHZpZCwgc3JjKSxcbiAgICAgICAgICBzZWVkOiB0eXBlb2YgcmF3LnNlZWQgPT09IFwibnVtYmVyXCIgPyByYXcuc2VlZCA6IHVuZGVmaW5lZCxcbiAgICAgICAgICBtb2RlbDogdHlwZW9mIHJhdy5tb2RlbCA9PT0gXCJzdHJpbmdcIiA/IHJhdy5tb2RlbCA6IHVuZGVmaW5lZCxcbiAgICAgICAgICBsaWtlZDogZmFsc2UsXG4gICAgICAgICAgYW5hbHlzaXM6IFwiXCIsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgaWYgKHZhcmlhbnRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHRydWU7XG4gICAgICBjb25zdCBiYXRjaDogQmF0Y2ggPSB7XG4gICAgICAgIGlkOiBiYXRjaElkLFxuICAgICAgICBraW5kOiBtc2cua2luZCA9PT0gXCJlZGl0XCIgPyBcImVkaXRcIiA6IFwiZ2VuZXJhdGVcIixcbiAgICAgICAgcHJvbXB0OiB0eXBlb2YgbXNnLnByb21wdCA9PT0gXCJzdHJpbmdcIiA/IG1zZy5wcm9tcHQgOiBcIlwiLFxuICAgICAgICB0YWc6IHR5cGVvZiBtc2cudGFnID09PSBcInN0cmluZ1wiID8gbXNnLnRhZyA6IHVuZGVmaW5lZCxcbiAgICAgICAgZWRpdGVkRnJvbVZhcmlhbnRJZDpcbiAgICAgICAgICB0eXBlb2YgbXNnLmVkaXRlZEZyb21WYXJpYW50SWQgPT09IFwic3RyaW5nXCIgPyBtc2cuZWRpdGVkRnJvbVZhcmlhbnRJZCA6IHVuZGVmaW5lZCxcbiAgICAgICAgdmFyaWFudHMsXG4gICAgICB9O1xuICAgICAgc3RhdGUuYmF0Y2hlcy5wdXNoKGJhdGNoKTtcbiAgICAgIHB1c2hNZXNzYWdlKHtcbiAgICAgICAgcm9sZTogXCJhZ2VudFwiLFxuICAgICAgICBraW5kOiBcInJlc3VsdFwiLFxuICAgICAgICB0ZXh0OlxuICAgICAgICAgIHR5cGVvZiBtc2cuc3VtbWFyeSA9PT0gXCJzdHJpbmdcIlxuICAgICAgICAgICAgPyBtc2cuc3VtbWFyeVxuICAgICAgICAgICAgOiBgR2VuZXJhdGVkICR7dmFyaWFudHMubGVuZ3RofSB2YXJpYW50JHt2YXJpYW50cy5sZW5ndGggPiAxID8gXCJzXCIgOiBcIlwifSDigJQgdGhleSdyZSBvbiB0aGUgbGVmdC5gLFxuICAgICAgICBiYXRjaElkLFxuICAgICAgfSk7XG4gICAgICAvLyBTaG93IHRoZSBmaXJzdCByZXN1bHQgb24gdGhlIGNhbnZhcyBpZiBub3RoaW5nIGlzIGZvY3VzZWQgeWV0LlxuICAgICAgaWYgKCFzdGF0ZS5mb2N1cykgc3RhdGUuZm9jdXMgPSB7IGJhdGNoSWQsIHZhcmlhbnRJZDogdmFyaWFudHNbMF0uaWQgfTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcImZvY3VzXCIpIHtcbiAgICAgIGNvbnN0IGIgPSBmaW5kQmF0Y2gobXNnLmJhdGNoSWQgYXMgc3RyaW5nKTtcbiAgICAgIGNvbnN0IGhhcyA9IGI/LnZhcmlhbnRzLnNvbWUoKHgpID0+IHguaWQgPT09IG1zZy52YXJpYW50SWQpO1xuICAgICAgaWYgKGIgJiYgaGFzKSB7XG4gICAgICAgIHN0YXRlLmZvY3VzID0geyBiYXRjaElkOiBiLmlkLCB2YXJpYW50SWQ6IG1zZy52YXJpYW50SWQgYXMgc3RyaW5nIH07XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7IC8vIG1hcmtzIGFyZSBkdXJhYmxlIHBlciB2YXJpYW50IOKAlCBzd2l0Y2hpbmcgbmV2ZXIgY2xlYXJzIHRoZW1cbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHQgPT09IFwicmVmLnNlbGVjdFwiKSB7XG4gICAgICAvLyB0aGUgYWdlbnQgcG9pbnRzIGEgdmFyaWFudCBhdCB0aGUgbmV4dCBnZW4g4oCUIHRoZSB1c2VyIHNlZXMgaXQgaGlnaGxpZ2h0XG4gICAgICBjb25zdCBoaXQgPSBmaW5kVmFyaWFudChtc2cuaWQgYXMgc3RyaW5nKTtcbiAgICAgIGlmICghaGl0KSByZXR1cm4gdHJ1ZTtcbiAgICAgIGhpdC52YXJpYW50LnJlZlNlbGVjdGVkID0gbXNnLnNlbGVjdGVkID09PSB0cnVlO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwidmFyaWFudC5hbmFseXplXCIpIHtcbiAgICAgIC8vIHRoZSBhZ2VudCB3cml0ZXMgaXRzIHJlYWQgb250byBhIGdlbmVyYXRlZC9pbXBvcnRlZCBpbWFnZSDigJQgZHVyYWJsZVxuICAgICAgLy8gbWV0YWRhdGEgc3RvcmVkIG9uIHRoZSB2YXJpYW50IChwZXJzaXN0cyBpbiB0aGUgc25hcHNob3QpLlxuICAgICAgY29uc3QgaGl0ID0gZmluZFZhcmlhbnQobXNnLmlkIGFzIHN0cmluZyk7XG4gICAgICBpZiAoIWhpdCB8fCB0eXBlb2YgbXNnLnRleHQgIT09IFwic3RyaW5nXCIpIHJldHVybiB0cnVlO1xuICAgICAgaGl0LnZhcmlhbnQuYW5hbHlzaXMgPSBtc2cudGV4dDtcbiAgICAgIC8vIGltcG9ydGVkIGltYWdlcyBjYXJyeSBhIGhhc2gg4oaSIGNhY2hlIGJ5IGl0IHNvIHJlLWltcG9ydGluZyB0aGUgc2FtZSBwaXhlbHNcbiAgICAgIC8vIHJldXNlcyB0aGUgcmVhZCAocHJlc2VydmVzIHRoZSBvbGQgcmVmLmFuYWx5emUgYmVoYXZpb3IgYWNyb3NzIHRoZSBtZXJnZSlcbiAgICAgIGlmIChoaXQudmFyaWFudC5oYXNoKSBzdGF0ZS5hbmFseXNpc0NhY2hlW2hpdC52YXJpYW50Lmhhc2hdID0gbXNnLnRleHQ7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJjb250ZXh0LmFkZFwiKSB7XG4gICAgICAvLyBiOS8jODcg4oCUIHRoZSBjYWxsZXIgbGVhcm5zIHRoZSBpZCBpdCBqdXN0IGNyZWF0ZWQsIGFuZCBXSElDSCBvZiB0aGVcbiAgICAgIC8vIHRocmVlIHBhdGhzIHJhbi4gUmV0dXJuaW5nIGEgcmVzdWx0IG9iamVjdCBoZXJlIHJhdGhlciB0aGFuIGB0cnVlYCBpc1xuICAgICAgLy8gdGhlIG9ubHkgcGxhY2UgaW4gdGhpcyBoYW5kbGVyIHRoYXQgZG9lcyBzbzsgZXZlcnkgb3RoZXIgY29tbWFuZCBrZWVwc1xuICAgICAgLy8gdGhlIHBsYWluIGJvb2xlYW4sIHNvIHRoZWlyIHJlc3BvbnNlcyBzdGF5IGJ5dGUtaWRlbnRpY2FsLlxuICAgICAgY29uc3QgcmVzID0gYWRkQ29udGV4dEVudHJ5KG1zZyBhcyBQYXJhbWV0ZXJzPHR5cGVvZiBhZGRDb250ZXh0RW50cnk+WzBdKTtcbiAgICAgIGlmICghcmVzLm9rKVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHJlY29nbmlzZWQ6IHRydWUsXG4gICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgIHN0YXR1czogNDA5LFxuICAgICAgICAgIGVycm9yOiByZXMuZXJyb3IsXG4gICAgICAgICAgZGV0YWlsOiB7XG4gICAgICAgICAgICAuLi4ocmVzLmlkID8geyBpZDogcmVzLmlkIH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocmVzLmNvbmZsaWN0cyA/IHsgY29uZmxpY3RzOiByZXMuY29uZmxpY3RzIH0gOiB7fSksXG4gICAgICAgICAgfSxcbiAgICAgICAgfTtcbiAgICAgIGlmIChtc2cubGluaykgbGlua0NvbnRleHQocmVzLmlkLCBtc2cubGluayBhcyBDb250ZXh0U2V0KTtcbiAgICAgIC8vIGBhbHJlYWR5LXJlY29yZGVkYCB3cm90ZSBub3RoaW5nLCBzbyB0aGVyZSBpcyBub3RoaW5nIHRvIGJyb2FkY2FzdCDigJRcbiAgICAgIC8vIGJ1dCBhIGxpbmsgbWF5IHN0aWxsIGhhdmUgYmVlbiBtYWRlIGFib3ZlLCBhbmQgdGhhdCBpcyBhIHJlYWwgY2hhbmdlLlxuICAgICAgaWYgKHJlcy5vdXRjb21lICE9PSBcImFscmVhZHktcmVjb3JkZWRcIiB8fCBtc2cubGluaykgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHJlY29nbmlzZWQ6IHRydWUsXG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICBkZXRhaWw6IHtcbiAgICAgICAgICBpZDogcmVzLmlkLFxuICAgICAgICAgIG91dGNvbWU6IHJlcy5vdXRjb21lLFxuICAgICAgICAgIC4uLihyZXMub3V0Y29tZSA9PT0gXCJ1cGRhdGVkXCIgPyB7IGNoYW5nZWQ6IHJlcy5jaGFuZ2VkLCBwcmV2aW91czogcmVzLnByZXZpb3VzIH0gOiB7fSksXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJzdGF0dXNcIikge1xuICAgICAgc3RhdGUuc3RhdHVzID0ge1xuICAgICAgICBidXN5OiBtc2cuYnVzeSA9PT0gdHJ1ZSxcbiAgICAgICAgdGV4dDogdHlwZW9mIG1zZy50ZXh0ID09PSBcInN0cmluZ1wiID8gbXNnLnRleHQgOiBcIlwiLFxuICAgICAgfTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcImNvc3RcIikge1xuICAgICAgaWYgKHR5cGVvZiBtc2cudGV4dCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICBzdGF0ZS5jb3N0ID0gbXNnLnRleHQ7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmICh0ID09PSBcImhhbmRvZmZcIikge1xuICAgICAgc3RhdGUuaGFuZG9mZiA9IHR5cGVvZiBtc2cudGV4dCA9PT0gXCJzdHJpbmdcIiA/IG1zZy50ZXh0IDogXCJcIjtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcImNsb3NlXCIpIHtcbiAgICAgIHJlc29sdmVEb25lKHsgY29kZTogMCwgcmVhc29uOiBcImNsb3NlXCIgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBmYWxzZTsgLy8gdW5yZWNvZ25pc2VkIHR5cGUg4oCUIHRoaXMgY2hhaW4gaGFkIG5vIHRlcm1pbmFsIGVsc2UgYXQgYWxsXG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgLy8gR0VUIC9ldmVudHM/c2luY2U9PGlkPiDigJQgcmVwbGF5LCB0aGVuIHN0YXkgb3BlbiBmb3IgbGl2ZSBmcmFtZXMgcGx1cyBhXG4gIC8vIGhlYXJ0YmVhdCBjb21tZW50LiBPTkUgY2FsbCBpbnRvIGBraXQvd2lyZS9zc2UudHNgLCB3aGljaCBpcyB3aGVyZSB0aGVcbiAgLy8gdGVhcmRvd24gZnVubmVsIGxpdmVzOiBgY2FuY2VsKClgLCBgcmVxLnNpZ25hbGAgYW5kIGEgZmFpbGVkIGVucXVldWUgYWxsXG4gIC8vIHJlYWNoIGl0LCBhdCBtb3N0IG9uY2UsIGFuZCB0aGF0IGZ1bm5lbCBpcyB3aGF0IGJvdW5kcyB0aGUgc3Vic2NyaWJlciBjb3VudFxuICAvLyB0aGUgaWRsZSBzd2VlcCBub3cgcmVhZHMuXG4gIC8vXG4gIC8vIOKblCBXSEFUIFRIRSBPTEQgQ09QWSBDT1VMRCBOT1QgRE8sIEFORCBJVCBJUyBXSFkgVEhFIFNVQlNDUklCRVIgQ09VTlQgV0FTXG4gIC8vIE5FVkVSIFRSVVNUV09SVEhZLiBJdCByZWxpZWQgb24gYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgdG8gbm90aWNlIGEgZGVwYXJ0ZWRcbiAgLy8gY2xpZW50IOKAlCBtZWFzdXJlZCBvbiBCdW4gMS4zLjE0IE5PVCB0byB3b3JrLCBhbiBlbnF1ZXVlIG9uIGFuIG9ycGhhbmVkXG4gIC8vIHN0cmVhbSBidWZmZXJzIHNpbGVudGx5IGFuZCBuZXZlciB0aHJvd3Mg4oCUIGFuZCBpdCB3YXMgbm90IHdpcmVkIHRvXG4gIC8vIGByZXEuc2lnbmFsYCBhdCBhbGwsIHNvIGEgY2xpZW50IHRoYXQgdmFuaXNoZWQgd2l0aG91dCBjYW5jZWxsaW5nIHdhc1xuICAvLyBjb3VudGVkIGFzIHByZXNlbnQgZm9yIHRoZSBsaWZlIG9mIHRoZSBkYWVtb24uIEl0IGFsc28ga2VwdCBhIFNFQ09ORCBzZXRcbiAgLy8gKGBzc2VUaW1lcnNgKSBvZiBwZXItc3RyZWFtIGhlYXJ0YmVhdHMsIHN3ZXB0IHNlcGFyYXRlbHkgYXQgdGVhcmRvd24sIHdoaWNoXG4gIC8vIGlzIHRoZSB0d28tcmVnaXN0cmllcy1kcmlmdGluZyBzaGFwZSB0aGUgbW9kdWxlJ3MgaGVhZGVyIHdhcm5zIGFib3V0LlxuICAvL1xuICAvLyDimqAgQU5EIFRIRSBIRUFSVEJFQVQgSVMgTk8gTE9OR0VSIEEgTElURVJBTC4gSXQgd2FzIGAxNTAwMGAsIGhhcmQtY29kZWQgaW5cbiAgLy8gdGhpcyBmdW5jdGlvbiwgMSwzMDAgbGluZXMgZnJvbSB0aGUgYGlkbGVUaW1lb3V0OiAyNTVgIGl0IGlzIGNoYWluZWQgdG8sIHdpdGhcbiAgLy8gdGhlIHJlbGF0aW9uc2hpcCB3cml0dGVuIG9ubHkgaW4gdGhlIHByb3NlIGJldHdlZW4gdGhlbS4gQm90aCBub3cgY29tZSBmcm9tXG4gIC8vIGAuL2hlYXJ0YmVhdC50c2AsIHdoaWNoIERFUklWRVMgdGhlIHBhaXIg4oCUIHNvIGBiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgaG9sZHNcbiAgLy8gZm9yIGFueSBjb25maWd1cmVkIHZhbHVlLCBub3Qgb25seSBmb3IgdGhlIHR3byB0aGF0IGhhcHBlbmVkIHRvIGJlIHdyaXR0ZW4uXG4gIGNvbnN0IGV2ZW50c1Jlc3BvbnNlID0gKHJlcTogUmVxdWVzdCwgdXJsOiBVUkwpOiBSZXNwb25zZSA9PiB7XG4gICAgdG91Y2goKTtcbiAgICByZXR1cm4ga2l0U3NlUmVzcG9uc2Uoe1xuICAgICAgbG9nLFxuICAgICAgc2luY2U6IE51bWJlci5wYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInNpbmNlXCIpID8/IFwiLTFcIiwgMTApLFxuICAgICAgaGVhcnRiZWF0TXM6IFNTRV9IRUFSVEJFQVRfTVMsXG4gICAgICBjbGllbnRzOiBzc2VDbGllbnRzLFxuICAgICAgc2lnbmFsOiByZXEuc2lnbmFsLFxuICAgICAgb25PcGVuOiB0b3VjaCxcbiAgICAgIG9uQ2xvc2U6IHRvdWNoLFxuICAgIH0pO1xuICB9O1xuXG4gIC8vIOKUgOKUgCBicm93c2VyIG1lc3NhZ2VzIChXZWJTb2NrZXQpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICBhc3luYyBmdW5jdGlvbiBoYW5kbGVCcm93c2VyTXNnKG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgICBjb25zdCB0ID0gbXNnLnR5cGUgYXMgc3RyaW5nO1xuICAgIGlmICh0ID09PSBcInNheVwiKSB7XG4gICAgICBpZiAodHlwZW9mIG1zZy50ZXh0ICE9PSBcInN0cmluZ1wiIHx8ICFtc2cudGV4dCkgcmV0dXJuO1xuICAgICAgcHVzaE1lc3NhZ2UoeyByb2xlOiBcInVzZXJcIiwga2luZDogXCJ0ZXh0XCIsIHRleHQ6IG1zZy50ZXh0IH0pO1xuICAgICAgLy8gQSBtZXNzYWdlIGFib3V0IGEgZnJlc2hseS1tYXJrZWQgaW1hZ2UgcmlkZXMgdGhlIG1hcmtlZCBpbWFnZSArIGdlb21ldHJ5XG4gICAgICAvLyBhbG9uZyAob25lIGZyZXNobmVzcyBzaWduYWwpLiBUaGUgc3VyZmFjZSBhdHRhY2hlcyBmbGF0dGVuZWRTcmMgb25seSB3aGVuXG4gICAgICAvLyB0aGUgZm9jdXNlZCBpbWFnZSBoYXMgdW5zZWVuIG1hcmtzOyByZWNlaXZpbmcgaXQgY2xlYXJzIHRoYXQgZmxhZy5cbiAgICAgIGxldCBmbGF0dGVuZWRJbWFnZVBhdGg6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgIGxldCBhdHRhY2hlZE1hcmtzOiBNYXJrW10gfCB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBmdmlkID0gc3RhdGUuZm9jdXM/LnZhcmlhbnRJZDtcbiAgICAgIGlmIChmdmlkICYmIHR5cGVvZiBtc2cuZmxhdHRlbmVkU3JjID09PSBcInN0cmluZ1wiICYmIG1zZy5mbGF0dGVuZWRTcmMuc3RhcnRzV2l0aChcImRhdGE6XCIpKSB7XG4gICAgICAgIGZsYXR0ZW5lZEltYWdlUGF0aCA9XG4gICAgICAgICAgc2F2ZURhdGFVcmwoc2Vzc2lvbkZpbGVzRGlyLCBuZXdJZChcImZsYXRcIiksIG1zZy5mbGF0dGVuZWRTcmMpIHx8IHVuZGVmaW5lZDtcbiAgICAgICAgYXR0YWNoZWRNYXJrcyA9IHN0YXRlLm1hcmtzQnlWYXJpYW50W2Z2aWRdID8/IFtdO1xuICAgICAgICBtYXJrVW5zZWVuW2Z2aWRdID0gZmFsc2U7IC8vIHRoZSBhZ2VudCBub3cgaGFzIHRoZSBsYXRlc3QgbWFya3NcbiAgICAgIH1cbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAvLyBhbWJpZW50IGJvYXJkIHN0YXRlIChmb2N1cyArIHNlbGVjdGVkIHJlZnMpIHJpZGVzIHRoZSBtZXNzYWdlLCBzbyB0aGVcbiAgICAgIC8vIGFnZW50IGhhcyBcIndoaWNoIGltYWdlLCB3aXRoIHdoaWNoIHJlZnNcIiB3aXRob3V0IHN1YnNjcmliaW5nIHRvIHRoZVxuICAgICAgLy8gYW1iaWVudCBmb2N1cy5zZXQvcmVmLnNlbGVjdCBldmVudHMgKHdoaWNoIG5vIGxvbmdlciBub3RpZnkpLlxuICAgICAgZW1pdEV2ZW50KHtcbiAgICAgICAgdHlwZTogXCJzYXlcIixcbiAgICAgICAgdGV4dDogbXNnLnRleHQsXG4gICAgICAgIGZvY3VzOiBzdGF0ZS5mb2N1cyxcbiAgICAgICAgc2VsZWN0ZWRSZWZJZHM6IHNlbGVjdGVkUmVmSWRzKCksXG4gICAgICAgIGZsYXR0ZW5lZEltYWdlUGF0aCxcbiAgICAgICAgbWFya3M6IGF0dGFjaGVkTWFya3MsXG4gICAgICB9KTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwicHJvcG9zYWwuc2VuZFwiKSB7XG4gICAgICBjb25zdCBtID0gc3RhdGUuY29udmVyc2F0aW9uLmZpbmQoKHgpID0+IHguaWQgPT09IG1zZy5pZCk7XG4gICAgICBpZiAobT8ucHJvcG9zYWwpIHtcbiAgICAgICAgbS5wcm9wb3NhbC5zdGF0dXMgPSBcInNlbnRcIjtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIH1cbiAgICAgIGVtaXRFdmVudCh7IHR5cGU6IFwicHJvcG9zYWwuc2VuZFwiLCBpZDogbXNnLmlkIH0pO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJwcm9wb3NhbC5kaXNtaXNzXCIpIHtcbiAgICAgIGNvbnN0IG0gPSBzdGF0ZS5jb252ZXJzYXRpb24uZmluZCgoeCkgPT4geC5pZCA9PT0gbXNnLmlkKTtcbiAgICAgIGlmIChtPy5wcm9wb3NhbCkge1xuICAgICAgICBtLnByb3Bvc2FsLnN0YXR1cyA9IFwiZGlzbWlzc2VkXCI7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICB9XG4gICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcInByb3Bvc2FsLmRpc21pc3NcIiwgaWQ6IG1zZy5pZCB9KTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwiZm9jdXMuc2V0XCIpIHtcbiAgICAgIGNvbnN0IGIgPSBmaW5kQmF0Y2gobXNnLmJhdGNoSWQgYXMgc3RyaW5nKTtcbiAgICAgIGlmICghYikgcmV0dXJuO1xuICAgICAgaWYgKCFiLnZhcmlhbnRzLnNvbWUoKHgpID0+IHguaWQgPT09IG1zZy52YXJpYW50SWQpKSByZXR1cm47XG4gICAgICBzdGF0ZS5mb2N1cyA9IHsgYmF0Y2hJZDogYi5pZCwgdmFyaWFudElkOiBtc2cudmFyaWFudElkIGFzIHN0cmluZyB9O1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTsgLy8gbWFya3MgYXJlIGR1cmFibGUgcGVyIHZhcmlhbnQg4oCUIHN3aXRjaGluZyBuZXZlciBjbGVhcnMgdGhlbVxuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJmb2N1cy5jbGVhclwiKSB7XG4gICAgICBzdGF0ZS5mb2N1cyA9IG51bGw7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJ2YXJpYW50Lmxpa2VcIikge1xuICAgICAgY29uc3QgaGl0ID0gZmluZFZhcmlhbnQobXNnLmlkIGFzIHN0cmluZyk7XG4gICAgICBpZiAoIWhpdCkgcmV0dXJuO1xuICAgICAgaGl0LnZhcmlhbnQubGlrZWQgPSBtc2cubGlrZWQgPT09IHRydWU7XG4gICAgICBpZiAoaGl0LnZhcmlhbnQubGlrZWQpIHtcbiAgICAgICAgcHVzaE1lc3NhZ2Uoe1xuICAgICAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgICAgIGtpbmQ6IFwiZ2VzdHVyZVwiLFxuICAgICAgICAgIHRleHQ6IGDwn5GNIHlvdSBsaWtlZCB2YXJpYW50ICR7bGFiZWxPZihoaXQuaW5kZXgpfSDigJQgaW1hZ28gY2FuIHNlZSB3aGljaCBvbmVgLFxuICAgICAgICAgIGdlc3R1cmU6IHsga2luZDogXCJsaWtlZFwiLCB0YXJnZXRJZDogaGl0LnZhcmlhbnQuaWQgfSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJ2YXJpYW50LnJlbW92ZVwiKSB7XG4gICAgICAvLyBkZWxldGUgYSB2YXJpYW50IGZyb20gdGhlIGxpYnJhcnk6IGRyb3AgaXQgZnJvbSBpdHMgYmF0Y2ggKGFuZCBkcm9wIHRoZVxuICAgICAgLy8gYmF0Y2ggd2hlbiBpdCBlbXB0aWVzKSwgY2xlYW4gaXRzIGFubm90YXRpb25zL2xheWVycy9oaXN0b3J5LCBhbmQgY2xlYXJcbiAgICAgIC8vIGZvY3VzIGlmIGl0IHdhcyB0aGUgZm9jdXNlZCBvbmUuIEFtYmllbnQgKGxpYnJhcnkgY3VyYXRpb24pIOKAlCBubyBhZ2VudFxuICAgICAgLy8gZXZlbnQ7IHRoZSBhZ2VudCByZWFkcyB0aGUgbmV3IHN0YXRlLlxuICAgICAgY29uc3QgYmF0Y2hJZCA9IG1zZy5iYXRjaElkO1xuICAgICAgY29uc3QgdmFyaWFudElkID0gbXNnLnZhcmlhbnRJZDtcbiAgICAgIGlmICh0eXBlb2YgYmF0Y2hJZCAhPT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgdmFyaWFudElkICE9PSBcInN0cmluZ1wiKSByZXR1cm47XG4gICAgICBjb25zdCBiYXRjaCA9IHN0YXRlLmJhdGNoZXMuZmluZCgoYikgPT4gYi5pZCA9PT0gYmF0Y2hJZCk7XG4gICAgICBpZiAoIWJhdGNoPy52YXJpYW50cy5zb21lKCh2KSA9PiB2LmlkID09PSB2YXJpYW50SWQpKSByZXR1cm47XG4gICAgICBiYXRjaC52YXJpYW50cyA9IGJhdGNoLnZhcmlhbnRzLmZpbHRlcigodikgPT4gdi5pZCAhPT0gdmFyaWFudElkKTtcbiAgICAgIGlmIChiYXRjaC52YXJpYW50cy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgc3RhdGUuYmF0Y2hlcyA9IHN0YXRlLmJhdGNoZXMuZmlsdGVyKChiKSA9PiBiLmlkICE9PSBiYXRjaElkKTtcbiAgICAgIH1cbiAgICAgIGRlbGV0ZSBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2YXJpYW50SWRdO1xuICAgICAgZGVsZXRlIHN0YXRlLmxheWVyc0J5VmFyaWFudFt2YXJpYW50SWRdO1xuICAgICAgZGVsZXRlIG1hcmtIaXN0b3J5W3ZhcmlhbnRJZF07XG4gICAgICBkZWxldGUgbWFya1Vuc2Vlblt2YXJpYW50SWRdO1xuICAgICAgaWYgKHN0YXRlLmZvY3VzPy52YXJpYW50SWQgPT09IHZhcmlhbnRJZCkgc3RhdGUuZm9jdXMgPSBudWxsO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwiY29udGV4dC5hZGRcIikge1xuICAgICAgLy8gU2FtZSBub24tZGVzdHJ1Y3RpdmUgYmVoYXZpb3VyIGFzIHRoZSBhZ2VudCBwYXRoIOKAlCB0aGUgZ3VhcmQgbGl2ZXMgaW5cbiAgICAgIC8vIGFkZENvbnRleHRFbnRyeSwgc28gYm90aCBjYWxsZXJzIGdldCBpdC4gQnV0IGEgV2ViU29ja2V0IG1lc3NhZ2UgaGFzIG5vXG4gICAgICAvLyByZXNwb25zZSB0byBjYXJyeSBhIHZlcmRpY3QgKHNlYW1zLm1kIENvbnRyYWN0IDEzJ3Mgc3RhdGVkIGdyYWluKSwgc28gYVxuICAgICAgLy8gcmVmdXNhbCBpcyBjdXJyZW50bHkgSU5WSVNJQkxFIHRvIHRoZSBodW1hbi4gVGhhdCBpcyBhIHBhcml0eS1mYWN0cyBnYXBcbiAgICAgIC8vIGFuZCBpdCBpcyBjaXJjZSdzIHN1cmZhY2UgY2FsbCwgbm90IHNvbWV0aGluZyB0byBwYXBlciBvdmVyIGhlcmUuXG4gICAgICBjb25zdCByZXMgPSBhZGRDb250ZXh0RW50cnkobXNnIGFzIFBhcmFtZXRlcnM8dHlwZW9mIGFkZENvbnRleHRFbnRyeT5bMF0pO1xuICAgICAgaWYgKHJlcy5vayAmJiBtc2cubGluaykgbGlua0NvbnRleHQocmVzLmlkLCBtc2cubGluayBhcyBDb250ZXh0U2V0KTtcbiAgICAgIGlmIChyZXMub2spIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcImNvbnRleHQudXBkYXRlXCIpIHtcbiAgICAgIGNvbnN0IGUgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKHgpID0+IHguaWQgPT09IG1zZy5pZCk7XG4gICAgICBpZiAoZSkge1xuICAgICAgICBpZiAodHlwZW9mIG1zZy5uYW1lID09PSBcInN0cmluZ1wiKSBlLm5hbWUgPSBtc2cubmFtZS50cmltKCkgfHwgZS5uYW1lO1xuICAgICAgICBpZiAodHlwZW9mIG1zZy5jb250ZW50ID09PSBcInN0cmluZ1wiKSBlLmNvbnRlbnQgPSBtc2cuY29udGVudDtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobXNnLnRhZ3MpKSBlLnRhZ3MgPSBtc2cudGFncyBhcyBzdHJpbmdbXTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHQgPT09IFwiY29udGV4dC5kZWxldGVcIikge1xuICAgICAgaWYgKHR5cGVvZiBtc2cuaWQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgY29uc3QgdG9EZWxldGUgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKHgpID0+IHguaWQgPT09IG1zZy5pZCk7XG4gICAgICAgIHN0YXRlLmxpYnJhcnkgPSBzdGF0ZS5saWJyYXJ5LmZpbHRlcigoeCkgPT4geC5pZCAhPT0gbXNnLmlkKTtcbiAgICAgICAgc3RhdGUuYWN0aXZlQ29udGV4dElkcyA9IHN0YXRlLmFjdGl2ZUNvbnRleHRJZHMuZmlsdGVyKCh4KSA9PiB4ICE9PSBtc2cuaWQpO1xuICAgICAgICBzdGF0ZS5xdWlja1Byb21wdElkcyA9IHN0YXRlLnF1aWNrUHJvbXB0SWRzLmZpbHRlcigoeCkgPT4geCAhPT0gbXNnLmlkKTtcbiAgICAgICAgaWYgKHRvRGVsZXRlPy5pbWFnZVBhdGgpIHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgdW5saW5rU3luYyh0b0RlbGV0ZS5pbWFnZVBhdGgpO1xuICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyogYmVzdC1lZmZvcnQg4oCUIGZpbGUgbWF5IGFscmVhZHkgYmUgZ29uZSAqL1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJjb250ZXh0LmxpbmtcIikge1xuICAgICAgaWYgKHR5cGVvZiBtc2cuaWQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgbGlua0NvbnRleHQobXNnLmlkLCBtc2cuc2V0IGFzIENvbnRleHRTZXQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJjb250ZXh0LnVubGlua1wiKSB7XG4gICAgICBpZiAodHlwZW9mIG1zZy5pZCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICB1bmxpbmtDb250ZXh0KG1zZy5pZCwgbXNnLnNldCBhcyBDb250ZXh0U2V0KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHQgPT09IFwiY29udGV4dC5jYXB0dXJlXCIpIHtcbiAgICAgIC8vIGNhcnJ5IHRoZSBmb2N1c2VkIHZhcmlhbnQgc28gdGhlIGFnZW50IGtub3dzIHdoaWNoIGltYWdlIHRvIHJlYWQgdGhlIGxvb2sgZnJvbVxuICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJjb250ZXh0LmNhcHR1cmVcIiwgZm9jdXM6IHN0YXRlLmZvY3VzIH0pO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJwaW4uYWRkXCIpIHtcbiAgICAgIGlmICh0eXBlb2YgbXNnLmtleSAhPT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgbXNnLnZhbHVlICE9PSBcInN0cmluZ1wiKSByZXR1cm47XG4gICAgICBjb25zdCBleCA9IHN0YXRlLnBpbnMuZmluZCgocCkgPT4gcC5rZXkgPT09IG1zZy5rZXkpO1xuICAgICAgaWYgKGV4KSBleC52YWx1ZSA9IG1zZy52YWx1ZTtcbiAgICAgIGVsc2Ugc3RhdGUucGlucy5wdXNoKHsga2V5OiBtc2cua2V5LCB2YWx1ZTogbXNnLnZhbHVlIH0pO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwicGluLnJlbW92ZVwiKSB7XG4gICAgICBzdGF0ZS5waW5zID0gc3RhdGUucGlucy5maWx0ZXIoKHApID0+IHAua2V5ICE9PSBtc2cua2V5KTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcInJlZi5hZGRcIikge1xuICAgICAgLy8gYWRkIGFuIGV4dGVybmFsIGltYWdlIGFzIGEgcmVmZXJlbmNlID0gaW1wb3J0IGl0IGFzIGEgbGlicmFyeSB2YXJpYW50ICtcbiAgICAgIC8vIGZsYWcgaXQgcmVmU2VsZWN0ZWQgKGRlZHVwIOKGkiBzZWxlY3RzIHRoZSBleGlzdGluZyBvbmUsIG5vIGR1cGxpY2F0ZSkuIERvZXNcbiAgICAgIC8vIE5PVCBzdGVhbCBmb2N1cyAoYSByZWYgaXNuJ3QgdGhlIHdvcmtpbmcgaW1hZ2U7IGltYWdlLmltcG9ydCBpcykuXG4gICAgICBjb25zdCByYXcgPSBtc2cuaW1hZ2UgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gICAgICBpZiAoIXJhdyB8fCB0eXBlb2YgcmF3LnNyYyAhPT0gXCJzdHJpbmdcIikgcmV0dXJuO1xuICAgICAgLy8gbGVhdmUgbmFtZSB1bmRlZmluZWQgd2hlbiBub3Qgc3VwcGxpZWQgKGRvbid0IHN0b3JlIGEgXCJyZWZlcmVuY2VcIlxuICAgICAgLy8gcGxhY2Vob2xkZXIg4oCUIGEgbGF0ZXIgaW1hZ2UuaW1wb3J0IG9mIHRoZSBzYW1lIHBpeGVscyBjYW4gZmlsbCB0aGUgbmFtZSlcbiAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgcmF3Lm5hbWUgPT09IFwic3RyaW5nXCIgPyByYXcubmFtZSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IHsgdmFyaWFudCB9ID0gaW1wb3J0SW1hZ2VWYXJpYW50KHJhdy5zcmMsIG5hbWUpO1xuICAgICAgdmFyaWFudC5yZWZTZWxlY3RlZCA9IHRydWU7XG4gICAgICBwdXNoTWVzc2FnZSh7XG4gICAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgICBraW5kOiBcImdlc3R1cmVcIixcbiAgICAgICAgdGV4dDogYPCfk44geW91IHBvaW50ZWQgYXQgYSByZWZlcmVuY2UgKCR7dmFyaWFudC5uYW1lID8/IFwiaW1hZ2VcIn0pYCxcbiAgICAgICAgZ2VzdHVyZTogeyBraW5kOiBcInJlZi1hZGRlZFwiLCB0YXJnZXRJZDogdmFyaWFudC5pZCB9LFxuICAgICAgfSk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJyZWYucmVtb3ZlXCIpIHtcbiAgICAgIC8vIERFU0VMRUNUIGEgdmFyaWFudCBhcyBhIHJlZiDigJQgaXQgc3RheXMgaW4gdGhlIGxpYnJhcnkgKGRlbGV0ZSA9IHZhcmlhbnQucmVtb3ZlKVxuICAgICAgY29uc3QgaGl0ID0gZmluZFZhcmlhbnQobXNnLmlkIGFzIHN0cmluZyk7XG4gICAgICBpZiAoIWhpdCkgcmV0dXJuO1xuICAgICAgaGl0LnZhcmlhbnQucmVmU2VsZWN0ZWQgPSBmYWxzZTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcInJlZi5zZWxlY3RcIikge1xuICAgICAgY29uc3QgaGl0ID0gZmluZFZhcmlhbnQobXNnLmlkIGFzIHN0cmluZyk7XG4gICAgICBpZiAoIWhpdCkgcmV0dXJuO1xuICAgICAgaGl0LnZhcmlhbnQucmVmU2VsZWN0ZWQgPSBtc2cuc2VsZWN0ZWQgPT09IHRydWU7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJpbWFnZS5pbXBvcnRcIikge1xuICAgICAgLy8gdGhlIHVzZXIgZHJvcHBlZCB0aGVpciBvd24gaW1hZ2Ugb250byB0aGUgY2FudmFzIOKAlCBhIHdvcmtpbmcgaW1hZ2VcbiAgICAgIC8vIChhIG9uZS12YXJpYW50IFwiaW1wb3J0XCIgYmF0Y2gpLCBmb2N1c2VkIHNvIHRoZXkgY2FuIGFubm90YXRlL2VkaXQgaXRcbiAgICAgIGNvbnN0IHJhdyA9IG1zZy5pbWFnZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgICAgIGlmICghcmF3IHx8IHR5cGVvZiByYXcuc3JjICE9PSBcInN0cmluZ1wiKSByZXR1cm47XG4gICAgICBjb25zdCBuYW1lID0gdHlwZW9mIHJhdy5uYW1lID09PSBcInN0cmluZ1wiID8gcmF3Lm5hbWUgOiBcImltcG9ydGVkIGltYWdlXCI7XG4gICAgICBjb25zdCB7IGJhdGNoSWQsIHZhcmlhbnQgfSA9IGltcG9ydEltYWdlVmFyaWFudChyYXcuc3JjLCBuYW1lKTtcbiAgICAgIHN0YXRlLmZvY3VzID0geyBiYXRjaElkLCB2YXJpYW50SWQ6IHZhcmlhbnQuaWQgfTtcbiAgICAgIHB1c2hNZXNzYWdlKHtcbiAgICAgICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgICAgIGtpbmQ6IFwiZ2VzdHVyZVwiLFxuICAgICAgICB0ZXh0OiBg8J+WvCB5b3UgYnJvdWdodCBpbiBhbiBpbWFnZSB0byB3b3JrIG9uICgke3ZhcmlhbnQubmFtZSA/PyBuYW1lfSlgLFxuICAgICAgICBnZXN0dXJlOiB7IGtpbmQ6IFwiaW1wb3J0ZWRcIiwgdGFyZ2V0SWQ6IHZhcmlhbnQuaWQgfSxcbiAgICAgIH0pO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwibGF5ZXIuYWRkSW1hZ2VcIikge1xuICAgICAgLy8gZHJvcCBhbiBpbWFnZSBhcyBhIExBWUVSIG9uIHRoZSBmb2N1c2VkIGltYWdlIChjb2xsYWdlKS4gVGhlIGNsaWVudFxuICAgICAgLy8gc3VwcGxpZXMgdGhlIGZyYWN0aW9uLXNwYWNlIGJveCAoaXQga25vd3MgdGhlIGJhc2UgaW1hZ2UgYm94ICsgdGhlIGRyb3BwZWRcbiAgICAgIC8vIGJpdG1hcCdzIGFzcGVjdCk7IGRlZmF1bHQgdG8gYSBjZW50ZXJlZCA0MCUgYm94LiBObyBhZ2VudCBldmVudCB1bnRpbFxuICAgICAgLy8gY29tbWl0IChzYW1lIHJ1bGUgYXMgbWFyay5hZGQpIOKAlCB0aGUgZmxhdHRlbmVkIGNvbXBvc2l0ZSBjYXJyaWVzIGl0LlxuICAgICAgY29uc3QgdmlkID0gc3RhdGUuZm9jdXM/LnZhcmlhbnRJZDtcbiAgICAgIGNvbnN0IHJhdyA9IG1zZyBhcyB7XG4gICAgICAgIHNyYz86IHVua25vd247XG4gICAgICAgIG5hbWU/OiB1bmtub3duO1xuICAgICAgICB4PzogdW5rbm93bjtcbiAgICAgICAgeT86IHVua25vd247XG4gICAgICAgIHc/OiB1bmtub3duO1xuICAgICAgICBoPzogdW5rbm93bjtcbiAgICAgIH07XG4gICAgICBpZiAoIXZpZCB8fCB0eXBlb2YgcmF3LnNyYyAhPT0gXCJzdHJpbmdcIikgcmV0dXJuO1xuICAgICAgY29uc3QgbnVtID0gKHY6IHVua25vd24sIGQ6IG51bWJlcikgPT4gKHR5cGVvZiB2ID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZSh2KSA/IHYgOiBkKTtcbiAgICAgIGNvbnN0IHcgPSBudW0ocmF3LncsIDAuNCk7XG4gICAgICBjb25zdCBoID0gbnVtKHJhdy5oLCAwLjQpO1xuICAgICAgY29uc3QgeCA9IG51bShyYXcueCwgKDEgLSB3KSAvIDIpO1xuICAgICAgY29uc3QgeSA9IG51bShyYXcueSwgKDEgLSBoKSAvIDIpO1xuICAgICAgY29uc3Qgb3B0aW1pemVkID0gYXdhaXQgb3B0aW1pemVTcmMocmF3LnNyYyk7XG4gICAgICBwdXNoSGlzdG9yeSh2aWQpOyAvLyBhZnRlciB0aGUgYXdhaXQsIHNvIGFueSBpbnRlcmxlYXZlZCBlZGl0IGlzIGluIHRoZSBzbmFwc2hvdFxuICAgICAgaWYgKCFzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXSkgc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0gPSBbXTtcbiAgICAgIGNvbnN0IGxheWVyOiBMYXllciA9IHtcbiAgICAgICAgaWQ6IG5ld0lkKFwibGF5ZXJcIiksXG4gICAgICAgIG5hbWU6IHR5cGVvZiByYXcubmFtZSA9PT0gXCJzdHJpbmdcIiAmJiByYXcubmFtZSA/IHJhdy5uYW1lIDogXCJJbWFnZVwiLFxuICAgICAgICBraW5kOiBcImltYWdlXCIsXG4gICAgICB9O1xuICAgICAgc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0ucHVzaChsYXllcik7IC8vIGEgbmV3IGltYWdlIGxheWVyIG9uIHRvcFxuICAgICAgaWYgKCFzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdKSBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdID0gW107XG4gICAgICBjb25zdCBhcnIgPSBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdO1xuICAgICAgYXJyLnB1c2goe1xuICAgICAgICBpZDogbmV3SWQoXCJpbWdcIiksXG4gICAgICAgIHRvb2w6IFwiaW1hZ2VcIixcbiAgICAgICAgc3JjOiBvcHRpbWl6ZWQsXG4gICAgICAgIHgsXG4gICAgICAgIHksXG4gICAgICAgIHcsXG4gICAgICAgIGgsXG4gICAgICAgIGxheWVySWQ6IGxheWVyLmlkLFxuICAgICAgICB6T3JkZXI6IGFyci5sZW5ndGgsXG4gICAgICB9KTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcImxheWVyLmFkZFwiKSB7XG4gICAgICAvLyBhIGJsYW5rIGxheWVyIG9uIHRvcCDigJQgYmVjb21lcyB0aGUgc3VyZmFjZSdzIGFjdGl2ZSBkcmF3IHRhcmdldFxuICAgICAgY29uc3QgdmlkID0gc3RhdGUuZm9jdXM/LnZhcmlhbnRJZDtcbiAgICAgIGlmICghdmlkKSByZXR1cm47XG4gICAgICBpZiAoIXN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdKSBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXSA9IFtdO1xuICAgICAgcHVzaEhpc3RvcnkodmlkKTtcbiAgICAgIGNvbnN0IGtpbmQ6IExheWVyW1wia2luZFwiXSA9XG4gICAgICAgIG1zZy5raW5kID09PSBcInNrZXRjaFwiIHx8IG1zZy5raW5kID09PSBcImltYWdlXCIgPyBtc2cua2luZCA6IFwiYW5ub3RhdGlvblwiO1xuICAgICAgc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0ucHVzaCh7XG4gICAgICAgIGlkOiBuZXdJZChcImxheWVyXCIpLFxuICAgICAgICBuYW1lOiB0eXBlb2YgbXNnLm5hbWUgPT09IFwic3RyaW5nXCIgJiYgbXNnLm5hbWUgPyBtc2cubmFtZSA6IFwiTGF5ZXJcIixcbiAgICAgICAga2luZCxcbiAgICAgIH0pO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwibGF5ZXIucmVuYW1lXCIpIHtcbiAgICAgIGNvbnN0IHZpZCA9IHN0YXRlLmZvY3VzPy52YXJpYW50SWQ7XG4gICAgICBjb25zdCBsYXllciA9IHZpZCA/IHN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdPy5maW5kKChsKSA9PiBsLmlkID09PSBtc2cuaWQpIDogdW5kZWZpbmVkO1xuICAgICAgaWYgKCFsYXllciB8fCB0eXBlb2YgbXNnLm5hbWUgIT09IFwic3RyaW5nXCIgfHwgIW1zZy5uYW1lIHx8IGxheWVyLm5hbWUgPT09IG1zZy5uYW1lKSByZXR1cm47XG4gICAgICBwdXNoSGlzdG9yeSh2aWQpO1xuICAgICAgbGF5ZXIubmFtZSA9IG1zZy5uYW1lO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwibGF5ZXIuc2V0SGlkZGVuXCIgfHwgdCA9PT0gXCJsYXllci5zZXRMb2NrZWRcIikge1xuICAgICAgY29uc3QgdmlkID0gc3RhdGUuZm9jdXM/LnZhcmlhbnRJZDtcbiAgICAgIGNvbnN0IGxheWVyID0gdmlkID8gc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0/LmZpbmQoKGwpID0+IGwuaWQgPT09IG1zZy5pZCkgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBrZXkgPSB0ID09PSBcImxheWVyLnNldEhpZGRlblwiID8gXCJoaWRkZW5cIiA6IFwibG9ja2VkXCI7XG4gICAgICBjb25zdCBuZXh0ID0gdCA9PT0gXCJsYXllci5zZXRIaWRkZW5cIiA/IG1zZy5oaWRkZW4gOiBtc2cubG9ja2VkO1xuICAgICAgaWYgKCFsYXllciB8fCB0eXBlb2YgbmV4dCAhPT0gXCJib29sZWFuXCIgfHwgQm9vbGVhbihsYXllcltrZXldKSA9PT0gbmV4dCkgcmV0dXJuO1xuICAgICAgcHVzaEhpc3RvcnkodmlkKTtcbiAgICAgIGxheWVyW2tleV0gPSBuZXh0O1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwibGF5ZXIucmVvcmRlclwiKSB7XG4gICAgICAvLyBhYnNvbHV0ZSBwbGFjZW1lbnQgKGRyYWctZHJvcCk6IG1vdmUgbGF5ZXIgYGlkYCB0byBgdG9JbmRleGAgKGJhY2vihpJmcm9udClcbiAgICAgIGNvbnN0IHZpZCA9IHN0YXRlLmZvY3VzPy52YXJpYW50SWQ7XG4gICAgICBjb25zdCBsYXllcnMgPSB2aWQgPyBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IGlkeCA9IGxheWVycz8uZmluZEluZGV4KChsKSA9PiBsLmlkID09PSBtc2cuaWQpID8/IC0xO1xuICAgICAgaWYgKCF2aWQgfHwgIWxheWVycyB8fCBpZHggPCAwIHx8IHR5cGVvZiBtc2cudG9JbmRleCAhPT0gXCJudW1iZXJcIikgcmV0dXJuO1xuICAgICAgY29uc3QgdG8gPSBNYXRoLm1heCgwLCBNYXRoLm1pbihsYXllcnMubGVuZ3RoIC0gMSwgTWF0aC50cnVuYyhtc2cudG9JbmRleCkpKTtcbiAgICAgIGlmICh0byA9PT0gaWR4KSByZXR1cm47XG4gICAgICBwdXNoSGlzdG9yeSh2aWQpO1xuICAgICAgY29uc3QgW2xdID0gbGF5ZXJzLnNwbGljZShpZHgsIDEpO1xuICAgICAgbGF5ZXJzLnNwbGljZSh0bywgMCwgbCk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJsYXllci5yZW1vdmVcIikge1xuICAgICAgLy8gZGVsZXRlIGEgbGF5ZXIgQU5EIHRoZSBlbGVtZW50cyBpdCBjb250YWluZWRcbiAgICAgIGNvbnN0IHZpZCA9IHN0YXRlLmZvY3VzPy52YXJpYW50SWQ7XG4gICAgICBpZiAoIXZpZCB8fCAhc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0/LnNvbWUoKGwpID0+IGwuaWQgPT09IG1zZy5pZCkpIHJldHVybjtcbiAgICAgIHB1c2hIaXN0b3J5KHZpZCk7XG4gICAgICBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXSA9IHN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdLmZpbHRlcigobCkgPT4gbC5pZCAhPT0gbXNnLmlkKTtcbiAgICAgIGlmIChzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdKSB7XG4gICAgICAgIHN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF0gPSBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdLmZpbHRlcigobSkgPT4gbS5sYXllcklkICE9PSBtc2cuaWQpO1xuICAgICAgfVxuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwiZ3JvdXBcIikge1xuICAgICAgLy8gd3JhcCB0aGUgc2VsZWN0ZWQgbWFya3MgaW4gYSBuZXcgbGF5ZXIgb24gdG9wOyByZWFzc2lnbiBsYXllcklkL3pPcmRlci5cbiAgICAgIGNvbnN0IHZpZCA9IHN0YXRlLmZvY3VzPy52YXJpYW50SWQ7XG4gICAgICBjb25zdCBpZHMgPSBtc2cubWFya0lkcztcbiAgICAgIGlmICghdmlkIHx8ICFBcnJheS5pc0FycmF5KGlkcykgfHwgIWlkcy5sZW5ndGgpIHJldHVybjtcbiAgICAgIGNvbnN0IG1hcmtzID0gc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXSA/PyBbXTtcbiAgICAgIGNvbnN0IGlkU2V0ID0gbmV3IFNldChpZHMuZmlsdGVyKCh4KTogeCBpcyBzdHJpbmcgPT4gdHlwZW9mIHggPT09IFwic3RyaW5nXCIpKTtcbiAgICAgIGNvbnN0IHBpY2tlZCA9IG1hcmtzLmZpbHRlcigobSkgPT4gaWRTZXQuaGFzKG0uaWQpKTtcbiAgICAgIGlmICghcGlja2VkLmxlbmd0aCkgcmV0dXJuO1xuICAgICAgcHVzaEhpc3RvcnkodmlkKTtcbiAgICAgIGlmICghc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0pIHN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdID0gW107XG4gICAgICBjb25zdCBsYXllcnMgPSBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXTtcbiAgICAgIGNvbnN0IHNvdXJjZUlkcyA9IG5ldyBTZXQocGlja2VkLm1hcCgobSkgPT4gbS5sYXllcklkKS5maWx0ZXIoQm9vbGVhbikgYXMgc3RyaW5nW10pO1xuICAgICAgLy8gaG9tb2dlbmVvdXMgc2VsZWN0aW9ucyBrZWVwIHRoZWlyIGtpbmQgKGEgcHVyZS1pbWFnZSBncm91cCBtdXN0IHN0YXkgYW5cbiAgICAgIC8vIGltYWdlIGxheWVyIOKAlCBlbHNlIGVuc3VyZURyYXdMYXllciB3b3VsZCB0cmVhdCBpdCBhcyBhIGRyYXcgdGFyZ2V0IGFuZCB0aGVcbiAgICAgIC8vIHBhbmVsIHdvdWxkIHNob3cgYSBzaGFwZXMgaWNvbiBpbnN0ZWFkIG9mIHRoZSBiaXRtYXAgdGh1bWJuYWlsKTsgYSBtaXhlZFxuICAgICAgLy8gc2VsZWN0aW9uIGlzIGEgZ2VuZXJpYyBhbm5vdGF0aW9uIGdyb3VwLlxuICAgICAgY29uc3QgZ3JvdXA6IExheWVyID0ge1xuICAgICAgICBpZDogbmV3SWQoXCJsYXllclwiKSxcbiAgICAgICAgbmFtZTogdHlwZW9mIG1zZy5uYW1lID09PSBcInN0cmluZ1wiICYmIG1zZy5uYW1lID8gbXNnLm5hbWUgOiBcIkdyb3VwXCIsXG4gICAgICAgIGtpbmQ6IHBpY2tlZC5ldmVyeSgobSkgPT4gbS50b29sID09PSBcImRyYXdcIilcbiAgICAgICAgICA/IFwic2tldGNoXCJcbiAgICAgICAgICA6IHBpY2tlZC5ldmVyeSgobSkgPT4gbS50b29sID09PSBcImltYWdlXCIpXG4gICAgICAgICAgICA/IFwiaW1hZ2VcIlxuICAgICAgICAgICAgOiBcImFubm90YXRpb25cIixcbiAgICAgIH07XG4gICAgICBsYXllcnMucHVzaChncm91cCk7XG4gICAgICBwaWNrZWQuZm9yRWFjaCgobSwgaSkgPT4ge1xuICAgICAgICBtLmxheWVySWQgPSBncm91cC5pZDtcbiAgICAgICAgbS56T3JkZXIgPSBpO1xuICAgICAgfSk7XG4gICAgICAvLyBwcnVuZSBzb3VyY2UgbGF5ZXJzIHRoZSBtb3ZlIGVtcHRpZWQgKG5ldmVyIHRoZSBuZXcgb25lIG9yIGEgc3RpbGwtb2NjdXBpZWQgb25lKVxuICAgICAgc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0gPSBsYXllcnMuZmlsdGVyKFxuICAgICAgICAobCkgPT4gbC5pZCA9PT0gZ3JvdXAuaWQgfHwgIXNvdXJjZUlkcy5oYXMobC5pZCkgfHwgbWFya3Muc29tZSgobSkgPT4gbS5sYXllcklkID09PSBsLmlkKSxcbiAgICAgICk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJ1bmdyb3VwXCIpIHtcbiAgICAgIC8vIGRpc3NvbHZlIGEgbGF5ZXIg4oaSIGVhY2ggZWxlbWVudCBiZWNvbWVzIGl0cyBvd24gZ3JvdXAtb2Ytb25lIGxheWVyIGluIHBsYWNlXG4gICAgICBjb25zdCB2aWQgPSBzdGF0ZS5mb2N1cz8udmFyaWFudElkO1xuICAgICAgY29uc3QgbGF5ZXJzID0gdmlkID8gc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0gOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBhdCA9IGxheWVycz8uZmluZEluZGV4KChsKSA9PiBsLmlkID09PSBtc2cuaWQpID8/IC0xO1xuICAgICAgaWYgKCF2aWQgfHwgIWxheWVycyB8fCBhdCA8IDApIHJldHVybjtcbiAgICAgIGNvbnN0IG1lbWJlcnMgPSAoc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXSA/PyBbXSlcbiAgICAgICAgLmZpbHRlcigobSkgPT4gbS5sYXllcklkID09PSBtc2cuaWQpXG4gICAgICAgIC5zb3J0KChhLCBiKSA9PiAoYS56T3JkZXIgPz8gMCkgLSAoYi56T3JkZXIgPz8gMCkpO1xuICAgICAgaWYgKG1lbWJlcnMubGVuZ3RoIDwgMikgcmV0dXJuOyAvLyAwLzEgZWxlbWVudCBpcyBhbHJlYWR5IGEgZ3JvdXAtb2Ytb25lXG4gICAgICBwdXNoSGlzdG9yeSh2aWQpO1xuICAgICAgY29uc3QgZnJlc2g6IExheWVyW10gPSBtZW1iZXJzLm1hcCgobSkgPT4ge1xuICAgICAgICBjb25zdCBpZCA9IG5ld0lkKFwibGF5ZXJcIik7XG4gICAgICAgIG0ubGF5ZXJJZCA9IGlkO1xuICAgICAgICBtLnpPcmRlciA9IDA7XG4gICAgICAgIHJldHVybiB7IGlkLCBuYW1lOiBUT09MX0xBQkVMW20udG9vbF0sIGtpbmQ6IGtpbmRGb3JUb29sKG0udG9vbCkgfTtcbiAgICAgIH0pO1xuICAgICAgbGF5ZXJzLnNwbGljZShhdCwgMSwgLi4uZnJlc2gpOyAvLyByZXBsYWNlIHRoZSBkaXNzb2x2ZWQgbGF5ZXIsIHByZXNlcnZpbmcgei1iYW5kXG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJtYXJrLmFkZFwiKSB7XG4gICAgICBjb25zdCBtayA9IG1zZy5tYXJrIGFzIE1hcmsgfCB1bmRlZmluZWQ7XG4gICAgICBjb25zdCB2aWQgPSBzdGF0ZS5mb2N1cz8udmFyaWFudElkO1xuICAgICAgaWYgKCF2aWQgfHwgIW1rPy5pZCB8fCAhTUFSS19UT09MUy5pbmNsdWRlcyhtay50b29sKSkgcmV0dXJuO1xuICAgICAgcHVzaEhpc3RvcnkodmlkKTtcbiAgICAgIGlmICghc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXSkgc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXSA9IFtdO1xuICAgICAgY29uc3QgYXJyID0gc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXTtcbiAgICAgIC8vIGNvbnRhaW5lciBtb2RlbDogaG9ub3IgYSB2YWxpZCBjbGllbnQtY2hvc2VuIGFjdGl2ZSBsYXllciwgZWxzZSBkZWZhdWx0XG4gICAgICBjb25zdCB3YW50ZWQgPSB0eXBlb2YgbWsubGF5ZXJJZCA9PT0gXCJzdHJpbmdcIiA/IG1rLmxheWVySWQgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBvbkxheWVyID0gd2FudGVkICYmIHN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdPy5zb21lKChsKSA9PiBsLmlkID09PSB3YW50ZWQpO1xuICAgICAgbWsubGF5ZXJJZCA9IG9uTGF5ZXIgPyAod2FudGVkIGFzIHN0cmluZykgOiBlbnN1cmVEcmF3TGF5ZXIodmlkKTtcbiAgICAgIG1rLnpPcmRlciA9IGFyci5sZW5ndGg7IC8vIHNlcnZlciBpcyBhdXRob3JpdGF0aXZlIGZvciB6LW9yZGVyXG4gICAgICBhcnIucHVzaChtayk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpOyAvLyBpbmNyZW1lbnRhbCDigJQgbm8gYWdlbnQgZXZlbnQgdW50aWwgY29tbWl0XG4gICAgfSBlbHNlIGlmICh0ID09PSBcIm1hcmsucmVtb3ZlXCIpIHtcbiAgICAgIGNvbnN0IHZpZCA9IHN0YXRlLmZvY3VzPy52YXJpYW50SWQ7XG4gICAgICBpZiAoIXZpZCB8fCAhc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXSkgcmV0dXJuO1xuICAgICAgaWYgKCFzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdLnNvbWUoKG0pID0+IG0uaWQgPT09IG1zZy5pZCkpIHJldHVybjsgLy8gbm8tb3Ag4oaSIG5vIGhpc3RvcnlcbiAgICAgIHB1c2hIaXN0b3J5KHZpZCk7XG4gICAgICBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdID0gc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXS5maWx0ZXIoKG0pID0+IG0uaWQgIT09IG1zZy5pZCk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJtYXJrLnVwZGF0ZVwiKSB7XG4gICAgICAvLyBtb3ZlL3Jlc2l6ZS9yZWxhYmVsIGEgY29tbWl0dGVkIG1hcmsgb24gdGhlIGZvY3VzZWQgaW1hZ2U7IG1lcmdlXG4gICAgICAvLyBnZW9tZXRyeS9sYWJlbC9zdHlsZSBrZXlzIG9ubHksIG5ldmVyIGlkL3Rvb2wvek9yZGVyIChzZXJ2ZXItb3duZWQpLlxuICAgICAgY29uc3QgdmlkID0gc3RhdGUuZm9jdXM/LnZhcmlhbnRJZDtcbiAgICAgIGNvbnN0IG0gPSB2aWRcbiAgICAgICAgPyAoc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXT8uZmluZCgoeCkgPT4geC5pZCA9PT0gbXNnLmlkKSBhc1xuICAgICAgICAgICAgfCBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPlxuICAgICAgICAgICAgfCB1bmRlZmluZWQpXG4gICAgICAgIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgcGF0Y2ggPSBtc2cucGF0Y2ggYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gICAgICBpZiAoIW0gfHwgIXBhdGNoIHx8IHR5cGVvZiBwYXRjaCAhPT0gXCJvYmplY3RcIikgcmV0dXJuO1xuICAgICAgcHVzaEhpc3RvcnkodmlkKTtcbiAgICAgIGZvciAoY29uc3QgW2ssIHZhbF0gb2YgT2JqZWN0LmVudHJpZXMocGF0Y2gpKSB7XG4gICAgICAgIGlmIChrID09PSBcImlkXCIgfHwgayA9PT0gXCJ0b29sXCIgfHwgayA9PT0gXCJ6T3JkZXJcIikgY29udGludWU7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsID09PSBcIm51bWJlclwiIHx8IHR5cGVvZiB2YWwgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICBtW2tdID0gdmFsO1xuICAgICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAgIC8vIGEgZHJhdyBtYXJrJ3MgYHBvaW50c2AgbW92ZS9yZXNpemUgYXMgYSB3aG9sZSBhcnJheSBvZiB7eCx5fVxuICAgICAgICAgIGsgPT09IFwicG9pbnRzXCIgJiZcbiAgICAgICAgICBBcnJheS5pc0FycmF5KHZhbCkgJiZcbiAgICAgICAgICB2YWwuZXZlcnkoXG4gICAgICAgICAgICAocCkgPT5cbiAgICAgICAgICAgICAgcCAmJlxuICAgICAgICAgICAgICB0eXBlb2YgcCA9PT0gXCJvYmplY3RcIiAmJlxuICAgICAgICAgICAgICB0eXBlb2YgKHAgYXMgeyB4OiB1bmtub3duIH0pLnggPT09IFwibnVtYmVyXCIgJiZcbiAgICAgICAgICAgICAgdHlwZW9mIChwIGFzIHsgeTogdW5rbm93biB9KS55ID09PSBcIm51bWJlclwiLFxuICAgICAgICAgIClcbiAgICAgICAgKSB7XG4gICAgICAgICAgbVtrXSA9IHZhbDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwibWFyay5yZW9yZGVyXCIpIHtcbiAgICAgIGNvbnN0IHZpZCA9IHN0YXRlLmZvY3VzPy52YXJpYW50SWQ7XG4gICAgICBpZiAoIXZpZCB8fCAhc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXSkgcmV0dXJuO1xuICAgICAgY29uc3Qgc29ydGVkID0gWy4uLnN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF1dLnNvcnQoXG4gICAgICAgIChhLCBiKSA9PiAoYS56T3JkZXIgPz8gMCkgLSAoYi56T3JkZXIgPz8gMCksXG4gICAgICApO1xuICAgICAgY29uc3QgaWR4ID0gc29ydGVkLmZpbmRJbmRleCgobSkgPT4gbS5pZCA9PT0gbXNnLmlkKTtcbiAgICAgIGlmIChpZHggPCAwKSByZXR1cm47XG4gICAgICBwdXNoSGlzdG9yeSh2aWQpOyAvLyBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdIGlzIHN0aWxsIHRoZSBwcmUtcmVvcmRlciBhcnJheVxuICAgICAgY29uc3QgW21dID0gc29ydGVkLnNwbGljZShpZHgsIDEpO1xuICAgICAgY29uc3QgdGFyZ2V0ID1cbiAgICAgICAgbXNnLmRpcmVjdGlvbiA9PT0gXCJmcm9udFwiXG4gICAgICAgICAgPyBzb3J0ZWQubGVuZ3RoXG4gICAgICAgICAgOiBtc2cuZGlyZWN0aW9uID09PSBcImJhY2stbW9zdFwiXG4gICAgICAgICAgICA/IDBcbiAgICAgICAgICAgIDogbXNnLmRpcmVjdGlvbiA9PT0gXCJmb3J3YXJkXCJcbiAgICAgICAgICAgICAgPyBNYXRoLm1pbihzb3J0ZWQubGVuZ3RoLCBpZHggKyAxKVxuICAgICAgICAgICAgICA6IE1hdGgubWF4KDAsIGlkeCAtIDEpOyAvLyBcImJhY2tcIlxuICAgICAgc29ydGVkLnNwbGljZSh0YXJnZXQsIDAsIG0pO1xuICAgICAgc29ydGVkLmZvckVhY2goKG1tLCBpKSA9PiB7XG4gICAgICAgIG1tLnpPcmRlciA9IGk7XG4gICAgICB9KTtcbiAgICAgIHN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF0gPSBzb3J0ZWQ7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJtYXJrcy5jbGVhclwiKSB7XG4gICAgICBjb25zdCB2aWQgPSBzdGF0ZS5mb2N1cz8udmFyaWFudElkO1xuICAgICAgaWYgKHZpZCAmJiBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdPy5sZW5ndGgpIHtcbiAgICAgICAgcHVzaEhpc3RvcnkodmlkKTtcbiAgICAgICAgc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXSA9IFtdO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJtYXJrcy5yZXBsYWNlXCIpIHtcbiAgICAgIC8vIHdob2xlc2FsZSBzd2FwIG9mIHRoZSBmb2N1c2VkIGltYWdlJ3MgbWFya3MgKHRoZSBlcmFzZXIgdHJpbXMvc3BsaXRzXG4gICAgICAvLyBzZXZlcmFsIHN0cm9rZXMgYXQgb25jZSDihpIgb25lIG1lc3NhZ2UsIG9uZSBoaXN0b3J5IHN0ZXApLiBWYWxpZGF0ZSArXG4gICAgICAvLyByZS1hc3NpZ24gek9yZGVyIGJ5IHBvc2l0aW9uIChzZXJ2ZXItYXV0aG9yaXRhdGl2ZSksIGxpa2UgbWFyay5hZGQuXG4gICAgICBjb25zdCB2aWQgPSBzdGF0ZS5mb2N1cz8udmFyaWFudElkO1xuICAgICAgY29uc3QgaW5jb21pbmcgPSBtc2cubWFya3MgYXMgTWFya1tdIHwgdW5kZWZpbmVkO1xuICAgICAgaWYgKCF2aWQgfHwgIUFycmF5LmlzQXJyYXkoaW5jb21pbmcpKSByZXR1cm47XG4gICAgICBjb25zdCB2YWxpZCA9IGluY29taW5nLmZpbHRlcigobSkgPT4gbT8uaWQgJiYgTUFSS19UT09MUy5pbmNsdWRlcyhtLnRvb2wpKTtcbiAgICAgIHB1c2hIaXN0b3J5KHZpZCk7XG4gICAgICB2YWxpZC5mb3JFYWNoKChtLCBpKSA9PiB7XG4gICAgICAgIG0uek9yZGVyID0gaTtcbiAgICAgIH0pO1xuICAgICAgc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXSA9IHZhbGlkO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwidW5kb1wiIHx8IHQgPT09IFwicmVkb1wiKSB7XG4gICAgICBjb25zdCB2aWQgPSBzdGF0ZS5mb2N1cz8udmFyaWFudElkO1xuICAgICAgaWYgKCF2aWQpIHJldHVybjtcbiAgICAgIGNvbnN0IGggPSBoaXN0Rm9yKHZpZCk7XG4gICAgICBjb25zdCBmcm9tID0gdCA9PT0gXCJ1bmRvXCIgPyBoLnVuZG8gOiBoLnJlZG87XG4gICAgICBjb25zdCB0byA9IHQgPT09IFwidW5kb1wiID8gaC5yZWRvIDogaC51bmRvO1xuICAgICAgaWYgKCFmcm9tLmxlbmd0aCkgcmV0dXJuO1xuICAgICAgdG8ucHVzaChzbmFwRm9yKHZpZCkpO1xuICAgICAgY29uc3QgcHJldiA9IGZyb20ucG9wKCkgYXMgTWFya1NuYXA7XG4gICAgICBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdID0gcHJldi5tYXJrcztcbiAgICAgIHN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdID0gcHJldi5sYXllcnM7XG4gICAgICBtYXJrVW5zZWVuW3ZpZF0gPSB0cnVlOyAvLyB0aGUgbWFya3MvbGF5ZXJzIGNoYW5nZWQg4oaSIGFnZW50J3MgdmlldyBpcyBzdGFsZSBhZ2FpblxuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwibWFya3MuY29tbWl0XCIpIHtcbiAgICAgIGlmIChcbiAgICAgICAgdHlwZW9mIG1zZy50ZXh0ICE9PSBcInN0cmluZ1wiIHx8XG4gICAgICAgIHR5cGVvZiBtc2cuYmF0Y2hJZCAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICAgICB0eXBlb2YgbXNnLnZhcmlhbnRJZCAhPT0gXCJzdHJpbmdcIlxuICAgICAgKVxuICAgICAgICByZXR1cm47XG4gICAgICBjb25zdCBtYXJrcyA9IHN0YXRlLm1hcmtzQnlWYXJpYW50W21zZy52YXJpYW50SWRdID8/IFtdO1xuICAgICAgLy8gVGhlIHZpc3VhbCBoYW5kb2ZmOiB0aGUgc3VyZmFjZSBzZW5kcyB0aGUgaW1hZ2Ugd2l0aCBtYXJrcyBidXJuZWQgaW4gYXMgYVxuICAgICAgLy8gZGF0YS11cmw7IG1hdGVyaWFsaXplIGl0IHRvIGRpc2sgc28gdGhlIGFnZW50IGNhbiAtLXJlZiBpdCBkaXJlY3RseS4gVGhlXG4gICAgICAvLyBibG9iIHN0YXlzIGJyb3dzZXLihpJzZXJ2ZXIgb25seSDigJQganVzdCB0aGUgcGF0aCByaWRlcyB0aGUgU1NFIGV2ZW50LlxuICAgICAgbGV0IGZsYXR0ZW5lZEltYWdlUGF0aDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgICAgaWYgKHR5cGVvZiBtc2cuZmxhdHRlbmVkU3JjID09PSBcInN0cmluZ1wiICYmIG1zZy5mbGF0dGVuZWRTcmMuc3RhcnRzV2l0aChcImRhdGE6XCIpKSB7XG4gICAgICAgIGZsYXR0ZW5lZEltYWdlUGF0aCA9XG4gICAgICAgICAgc2F2ZURhdGFVcmwoc2Vzc2lvbkZpbGVzRGlyLCBuZXdJZChcImZsYXRcIiksIG1zZy5mbGF0dGVuZWRTcmMpIHx8IHVuZGVmaW5lZDtcbiAgICAgIH1cbiAgICAgIHB1c2hNZXNzYWdlKHtcbiAgICAgICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgICAgIGtpbmQ6IFwiZ2VzdHVyZVwiLFxuICAgICAgICB0ZXh0OiBg4pyN77iPICR7bXNnLnRleHR9YCxcbiAgICAgICAgZ2VzdHVyZTogeyBraW5kOiBcIm1hcmtlZFwiLCB0YXJnZXRJZDogbXNnLnZhcmlhbnRJZCB9LFxuICAgICAgfSk7XG4gICAgICAvLyBjb21taXR0aW5nIGhhbmRzIGEgU05BUFNIT1QgdG8gdGhlIGFnZW50IGJ1dCBsZWF2ZXMgdGhlIG1hcmtzIGluIHBsYWNlIOKAlFxuICAgICAgLy8gdGhleSdyZSBkdXJhYmxlIGFubm90YXRpb25zIG9uIHRoZSBpbWFnZSwgbm90IGNvbnN1bWVkIGJ5IHRoZSBzZW5kLiBUaGVcbiAgICAgIC8vIHVzZXIgY2xlYXJzIHRoZW0gZXhwbGljaXRseSAobWFya3MuY2xlYXIpIHdoZW4gdGhleSdyZSBkb25lIHdpdGggdGhlbS5cbiAgICAgIG1hcmtVbnNlZW5bbXNnLnZhcmlhbnRJZF0gPSBmYWxzZTsgLy8gdGhlIGFnZW50IG5vdyBoYXMgdGhlIGxhdGVzdCBtYXJrc1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIGVtaXRFdmVudCh7XG4gICAgICAgIHR5cGU6IFwibWFya3MuY29tbWl0XCIsXG4gICAgICAgIHRleHQ6IG1zZy50ZXh0LFxuICAgICAgICBiYXRjaElkOiBtc2cuYmF0Y2hJZCxcbiAgICAgICAgdmFyaWFudElkOiBtc2cudmFyaWFudElkLFxuICAgICAgICBtYXJrcyxcbiAgICAgICAgc2VsZWN0ZWRSZWZJZHM6IHNlbGVjdGVkUmVmSWRzKCksXG4gICAgICAgIGZsYXR0ZW5lZEltYWdlUGF0aCxcbiAgICAgIH0pO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJhc3BlY3Quc2V0XCIpIHtcbiAgICAgIGlmICh0eXBlb2YgbXNnLmFzcGVjdCAhPT0gXCJzdHJpbmdcIikgcmV0dXJuO1xuICAgICAgc3RhdGUuYXNwZWN0ID0gbXNnLmFzcGVjdDtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcInNpemUuc2V0XCIpIHtcbiAgICAgIGlmIChtc2cuc2l6ZSAhPT0gXCIxS1wiICYmIG1zZy5zaXplICE9PSBcIjJLXCIpIHJldHVybjtcbiAgICAgIHN0YXRlLnNpemUgPSBtc2cuc2l6ZTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcInN1Ym1pdFwiKSB7XG4gICAgICBicm9hZGNhc3QoeyB0eXBlOiBcInN1Ym1pdFwiIH0pO1xuICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJzdWJtaXRcIiB9KTtcbiAgICAgIHJlc29sdmVEb25lKHsgY29kZTogMCwgcmVhc29uOiBcInN1Ym1pdFwiIH0pO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJjYW5jZWxcIikge1xuICAgICAgYnJvYWRjYXN0KHsgdHlwZTogXCJjYW5jZWxcIiB9KTtcbiAgICAgIHJlc29sdmVEb25lKHsgY29kZTogMTMwLCByZWFzb246IFwiY2FuY2VsXCIgfSk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgbW9kZSA9IHJlc29sdmVNb2RlKCk7XG5cbiAgLy8gZGV2OiB0aGUgZHluYW1pYyBzdHJpbmctbGl0ZXJhbCBpbXBvcnQga2VlcHMgdGhlIHN1cmZhY2UgZ3JhcGggb2ZmIHRoZVxuICAvLyBtb2R1bGUgbG9hZCBwYXRoIChDb250cmFjdCAxKSDigJQgQnVuIGJ1bmRsZXMgdGhlIC50c3ggZ3JhcGggKyBUYWlsd2luZCBhdFxuICAvLyBzZXJ2ZSB0aW1lLCByZWFkaW5nIGJ1bmZpZy50b21sIGZyb20gY3dkLCB3aGljaCBjbGkudHMgcGlucyB0byBzcmMvaW1hZ28vXG4gIC8vIChDb250cmFjdCA1KS4gaG1yIG9uIGZvciB0aGUgc3VyZmFjZSBpdGVyYXRpb24gbG9vcC5cbiAgLy8gcmVsZWFzZTogZGlzdC8gaXMgc3RhdGljIGFuZCBwcmUtYnVpbHQgKENvbnRyYWN0IDIpIOKAlCBcIi9cIiBpcyBhbnN3ZXJlZCBieVxuICAvLyBzZXJ2ZURpc3QoKSBpbiB0aGUgZmV0Y2ggZmFsbC10aHJvdWdoIGJlbG93LCBzbyB0aGlzIGJyYW5jaCBuZXZlciB0b3VjaGVzXG4gIC8vIHN1cmZhY2UvIG9yIGJ1bmZpZy50b21sIGFuZCBuZXZlciBuZWVkcyBlaXRoZXIgdG8gZXhpc3QuXG4gIC8vIEJ1bidzIFJvdXRlcyB0eXBlIHRpZXMgdGhlIFwiL1wiIHZhbHVlJ3MgdHlwZSB0byB0aGUgbGl0ZXJhbCBvYmplY3Qgc2hhcGUsIHNvXG4gIC8vIGEgbW9kZS10ZXJuYXJ5IHVuaW9uIGNvbmZ1c2VzIGl0cyBvdmVybG9hZCByZXNvbHV0aW9uIOKAlCB0aGUgcnVudGltZVxuICAvLyBiZWhhdmlvciAoSFRNTEJ1bmRsZSBpbiBkZXYsIGFic2VudCBpbiByZWxlYXNlKSBpcyBjb3JyZWN0IGVpdGhlciB3YXkuXG4gIGNvbnN0IGRldkluZGV4ID1cbiAgICBtb2RlID09PSBcImRldlwiXG4gICAgICA/IChhd2FpdCBpbXBvcnQoXCIuLi8uLi8uLi8uLi8uLi9zcmMvaW1hZ28vc3VyZmFjZS9pbmRleC5odG1sXCIpKS5kZWZhdWx0XG4gICAgICA6IHVuZGVmaW5lZDtcbiAgY29uc3Qgcm91dGVzID0gKGRldkluZGV4ID8geyBcIi9cIjogZGV2SW5kZXggfSA6IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCBuZXZlcj47XG5cbiAgbGV0IHNlcnZlcjogUmV0dXJuVHlwZTx0eXBlb2YgQnVuLnNlcnZlPjtcbiAgdHJ5IHtcbiAgICBzZXJ2ZXIgPSBCdW4uc2VydmUoe1xuICAgICAgcG9ydCxcbiAgICAgIGhvc3RuYW1lOiBob3N0LFxuICAgICAgcm91dGVzLFxuICAgICAgLy8g4puUIEhFTEQgU1NFIENPTk5FQ1RJT05TIERJRSBXSVRIT1VUIFRISVMuIEJ1bidzIGRlZmF1bHQgcmVxdWVzdFxuICAgICAgLy8gaWRsZVRpbWVvdXQgaXMgMTBzIGFuZCBhIHNlcnZlci1zZW50IGhlYXJ0YmVhdCBkb2VzIE5PVCByZXNldCBpdCwgc28gYW5cbiAgICAgIC8vIFNTRSBjbGllbnQgaXMgY2xvc2VkIGJlZm9yZSB0aGUgMTVzIGA6IGhiYCBiZWxvdyBldmVyIGZpcmVzIOKAlCB0aGVcbiAgICAgIC8vIGtlZXBhbGl2ZSBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzIGtlZXBpbmcgYWxpdmUgaXNcbiAgICAgIC8vIGdvbmUsIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgcmF0ZSB3b3VsZCBub3QgaGF2ZSBoZWxwZWQuXG4gICAgICAvLyAyNTUgaXMgQnVuJ3MgbWF4aW11bSAoMCBpcyBub3QgXCJkaXNhYmxlZFwiKSwgbWF0Y2hpbmcgYm91bnR5LCBncmFwZXZpbmVcbiAgICAgIC8vIGFuZCBtaW5kLW1hcHBlcjsgYXN0cm9sYWJlIGVudi10dW5lcyBpdCBhbmQgY2xhbXBzIHRoZSBoZWFydGJlYXQgdG8gaGFsZi5cbiAgICAgIC8vIEZvdW5kIDIwMjYtMDktMDggYnkgdGhlIGJhY2tlbmQgZHVwbGljYXRpb24gcmVjb246IGZvdXIgc3BlbGxzIGhhZCBoaXRcbiAgICAgIC8vIHRoaXMgYW5kIGZpeGVkIGl0LCB0aHJlZSBoYWQgbm90LCBiZWNhdXNlIHRoZSBkYWVtb24gc3BpbmUgaXMgb25lIGRlc2lnblxuICAgICAgLy8gaW1wbGVtZW50ZWQgc2l4IHRpbWVzLlxuICAgICAgLy9cbiAgICAgIC8vIOKaoCBOTyBMT05HRVIgQSBMSVRFUkFMIOKAlCBhbmQgaXQgaXMgdGhlIE9USEVSIEhBTEYgb2YgdGhlIHBhaXIsIHdoaWNoIGlzXG4gICAgICAvLyB0aGUgd2hvbGUgcmVhc29uIGAuL2hlYXJ0YmVhdC50c2AgZXhpc3RzLiBUaGUgMjU1IGFuZCB0aGUgMTUsMDAwIHdlcmVcbiAgICAgIC8vIHdyaXR0ZW4gMSwzMDAgbGluZXMgYXBhcnQgYW5kIGNoYWluZWQgb25seSBieSB0aGUgcHJvc2UgYWJvdmU7IHRoZXkgYXJlXG4gICAgICAvLyBub3cgZGVyaXZlZCB0b2dldGhlciBhbmQgdGhlIGNsYW1wIGlzIGVuZm9yY2VkLlxuICAgICAgaWRsZVRpbWVvdXQ6IElETEVfVElNRU9VVF9TRUMsXG4gICAgICBkZXZlbG9wbWVudDogeyBobXI6IG1vZGUgPT09IFwiZGV2XCIgfSxcbiAgICAgIGZldGNoOiAocmVxLCBzcnYpID0+IHtcbiAgICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXEudXJsKTtcbiAgICAgICAgY29uc3QgcGF0aCA9IHVybC5wYXRobmFtZTtcbiAgICAgICAgaWYgKHBhdGggPT09IFwiL3dzXCIpIHtcbiAgICAgICAgICBjb25zdCB1cGdyYWRlZCA9IHNydi51cGdyYWRlKHJlcSk7XG4gICAgICAgICAgaWYgKHVwZ3JhZGVkKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoXCJ1cGdyYWRlIHJlcXVpcmVkXCIsIHsgc3RhdHVzOiA0MjYgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvc3RhdGVcIikge1xuICAgICAgICAgIC8vIOKblCBgdG91Y2goKWAg4oCUIENFTlNVUyBERUZFQ1QgTDIsIEFORCBJVCBJUyBBIE9ORS1XT1JEIEZJWCBGT1IgQSBSRUFMXG4gICAgICAgICAgLy8gS0lMTC4gRXZlcnkgb3RoZXIgcm91dGUgdG91Y2hlZCB0aGUgYWN0aXZpdHkgY2xvY2sgYW5kIHRoaXMgb25lIGRpZFxuICAgICAgICAgIC8vIG5vdCwgc28gYW4gYWdlbnQgcG9sbGluZyBgL3N0YXRlYCBpbiBhIGxvb3Ag4oCUIHRoZSBleGFjdCBzaGFwZVxuICAgICAgICAgIC8vIFNLSUxMLm1kIHRlbGxzIGl0IHRvIHVzZSBmb3IgYW1iaWVudCBib2FyZCBzdGF0ZSDigJQgd2FzIGlkbGUtY2xvc2VkXG4gICAgICAgICAgLy8gVU5ERVIgSVRTRUxGIGF0IHRoZSAzMC1taW51dGUgZmxvb3Igd2hpbGUgaXQgd2FzIGFjdGl2ZWx5IHJlYWRpbmcuXG4gICAgICAgICAgLy8gTm90IGNsb3NlZCBieSBhIG1vZHVsZTogY2xvc2VkIGJ5IGFkb3B0aW5nIHRoZSBob3VzZWtlZXBlciwgd2hpY2hcbiAgICAgICAgICAvLyBtYWRlIFwid2hhdCBjb3VudHMgYXMgYWN0aXZpdHlcIiBhIHF1ZXN0aW9uIHdpdGggb25lIGFuc3dlciBpbnN0ZWFkIG9mXG4gICAgICAgICAgLy8gYSBwcm9wZXJ0eSBvZiB3aGljaGV2ZXIgcm91dGUgdGhlIGF1dGhvciByZW1lbWJlcmVkLlxuICAgICAgICAgIHRvdWNoKCk7XG4gICAgICAgICAgY29uc3QgbGVhbiA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwibGVhblwiKSA9PT0gXCIxXCI7XG4gICAgICAgICAgY29uc3QgcGF5bG9hZCA9IGxlYW4gPyBsZWFuU3RhdGUoc3RhdGUpIDogc3RhdGU7XG4gICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShKU09OLnN0cmluZ2lmeSh7IHN0YXRlOiBwYXlsb2FkLCBjdXJzb3I6IGxvZy5jdXJzb3IoKSB9KSwge1xuICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL2V2ZW50c1wiKSB7XG4gICAgICAgICAgcmV0dXJuIGV2ZW50c1Jlc3BvbnNlKHJlcSwgdXJsKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJQT1NUXCIgJiYgcGF0aCA9PT0gXCIvY21kXCIpIHtcbiAgICAgICAgICByZXR1cm4gcmVxXG4gICAgICAgICAgICAuanNvbigpXG4gICAgICAgICAgICAudGhlbihhc3luYyAoYm9keSkgPT4ge1xuICAgICAgICAgICAgICB0b3VjaCgpO1xuICAgICAgICAgICAgICAvLyAjODQg4oCUIHRoZSBgYXdhaXRgIGhlcmUgd2FzIEFMUkVBRFkgY29ycmVjdC4gV2hhdCB3YXMgbWlzc2luZyBpc1xuICAgICAgICAgICAgICAvLyBhIHZlcmRpY3QgdG8gcHJvcGFnYXRlLCBzbyB0aGlzIGFuc3dlcmVkIGEgbGl0ZXJhbCBvazp0cnVlIGV2ZW5cbiAgICAgICAgICAgICAgLy8gdG8gY29tbWFuZHMgaXQgZHJvcHBlZC5cbiAgICAgICAgICAgICAgY29uc3QgdmVyZGljdCA9IGF3YWl0IGhhbmRsZUFnZW50TXNnKGJvZHkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pO1xuICAgICAgICAgICAgICAvLyBBIGNvbW1hbmQgdGhhdCBhbnN3ZXJlZCB3aXRoIGl0cyBvd24gcmVzdWx0IGNhcnJpZXMgaXRzIG93blxuICAgICAgICAgICAgICAvLyBzdGF0dXMgYW5kIHBheWxvYWQ7IHRoZSBib29sZWFuIHBhdGggYmVsb3cgaXMgdW5jaGFuZ2VkLlxuICAgICAgICAgICAgICBpZiAodHlwZW9mIHZlcmRpY3QgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXZlcmRpY3Qub2spIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKFxuICAgICAgICAgICAgICAgICAgICB7IG9rOiBmYWxzZSwgYXBwbGllZDogZmFsc2UsIGVycm9yOiB2ZXJkaWN0LmVycm9yLCAuLi52ZXJkaWN0LmRldGFpbCB9LFxuICAgICAgICAgICAgICAgICAgICB7IHN0YXR1czogdmVyZGljdC5zdGF0dXMgfSxcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IHRydWUsIGFwcGxpZWQ6IHRydWUsIC4uLnZlcmRpY3QuZGV0YWlsIH0pO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGNvbnN0IGFwcGxpZWQgPSB2ZXJkaWN0O1xuICAgICAgICAgICAgICBpZiAoIWFwcGxpZWQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbihcbiAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICBhcHBsaWVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgZXJyb3I6IGB1bnJlY29nbmlzZWQgY29tbWFuZCB0eXBlICR7SlNPTi5zdHJpbmdpZnkoXG4gICAgICAgICAgICAgICAgICAgICAgKGJvZHkgYXMgeyB0eXBlPzogdW5rbm93biB9KT8udHlwZSxcbiAgICAgICAgICAgICAgICAgICAgKX0g4oCUIG5vdGhpbmcgd2FzIGFwcGxpZWRgLFxuICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgIHsgc3RhdHVzOiA0MDAgfSxcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoJ3tcIm9rXCI6dHJ1ZSxcImFwcGxpZWRcIjp0cnVlfScsIHtcbiAgICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIC5jYXRjaChcbiAgICAgICAgICAgICAgKCkgPT5cbiAgICAgICAgICAgICAgICBuZXcgUmVzcG9uc2UoJ3tcImVycm9yXCI6XCJiYWQganNvblwifScsIHtcbiAgICAgICAgICAgICAgICAgIHN0YXR1czogNDAwLFxuICAgICAgICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoLnN0YXJ0c1dpdGgoXCIvYXNzZXRzL1wiKSkge1xuICAgICAgICAgIGNvbnN0IGFzc2V0TmFtZSA9IGRlY29kZVVSSUNvbXBvbmVudChwYXRoLnNsaWNlKFwiL2Fzc2V0cy9cIi5sZW5ndGgpKTtcbiAgICAgICAgICBpZiAoYXNzZXROYW1lLmluY2x1ZGVzKFwiLi5cIikgfHwgYXNzZXROYW1lLnN0YXJ0c1dpdGgoXCIvXCIpKSB7XG4gICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCd7XCJlcnJvclwiOlwibm90IGZvdW5kXCJ9Jywge1xuICAgICAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IGYgPSBCdW4uZmlsZShqb2luKGFzc2V0c0RpciwgYXNzZXROYW1lKSk7XG4gICAgICAgICAgcmV0dXJuIGYuZXhpc3RzKCkudGhlbigoZXhpc3RzKSA9PlxuICAgICAgICAgICAgZXhpc3RzXG4gICAgICAgICAgICAgID8gbmV3IFJlc3BvbnNlKGYsIHsgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBndWVzc01pbWUoYXNzZXROYW1lKSB9IH0pXG4gICAgICAgICAgICAgIDogbmV3IFJlc3BvbnNlKCd7XCJlcnJvclwiOlwibm90IGZvdW5kXCJ9Jywge1xuICAgICAgICAgICAgICAgICAgc3RhdHVzOiA0MDQsXG4gICAgICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICAvLyByZWxlYXNlOiBcIi9cIiBhbmQgdGhlIGhhc2hlZCBjaHVuay0qLmpzL2NzcyBhcmUgc3RhdGljIGRpc3QgcmVhZHMuIERldlxuICAgICAgICAvLyBuZXZlciByZWFjaGVzIGhlcmUgZm9yIFwiL1wiIOKAlCB0aGUgcm91dGVzIHRhYmxlIGFib3ZlIGFuc3dlcnMgaXQgZmlyc3QuXG4gICAgICAgIC8vIFRoaXMgc2l0cyBBRlRFUiAvYXNzZXRzLywgd2hpY2ggc2VydmVzIHNlc3Npb24gZmlsZXMsIG5vdCBkaXN0IG9uZXMuXG4gICAgICAgIGlmIChtb2RlID09PSBcInJlbGVhc2VcIikge1xuICAgICAgICAgIGNvbnN0IGFzc2V0ID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICAgIGlmIChhc3NldCkgcmV0dXJuIGFzc2V0O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoJ3tcImVycm9yXCI6XCJub3QgZm91bmRcIn0nLCB7XG4gICAgICAgICAgc3RhdHVzOiA0MDQsXG4gICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICB9KTtcbiAgICAgIH0sXG4gICAgICB3ZWJzb2NrZXQ6IHtcbiAgICAgICAgb3Blbih3cykge1xuICAgICAgICAgIHNvY2tldHMuYWRkKHdzKTtcbiAgICAgICAgICB0b3VjaCgpO1xuICAgICAgICAgIGVtaXRUcmFuc2llbnQoeyB0eXBlOiBcImNvbm5lY3RlZFwiIH0pO1xuICAgICAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcInN0YXRlXCIsIHN0YXRlIH0pKTtcbiAgICAgICAgfSxcbiAgICAgICAgbWVzc2FnZShfd3MsIHJhdykge1xuICAgICAgICAgIHRvdWNoKCk7XG4gICAgICAgICAgbGV0IG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIG1zZyA9IEpTT04ucGFyc2UodHlwZW9mIHJhdyA9PT0gXCJzdHJpbmdcIiA/IHJhdyA6IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyYXcpKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgICAgYGltYWdvOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmAsXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICB2b2lkIGhhbmRsZUJyb3dzZXJNc2cobXNnKTtcbiAgICAgICAgfSxcbiAgICAgICAgY2xvc2Uod3MpIHtcbiAgICAgICAgICBzb2NrZXRzLmRlbGV0ZSh3cyk7XG4gICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICBlbWl0VHJhbnNpZW50KHsgdHlwZTogXCJkaXNjb25uZWN0ZWRcIiB9KTtcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgZXZlbnQ6IFwiYmluZF9lcnJvclwiLFxuICAgICAgICBob3N0LFxuICAgICAgICBwb3J0LFxuICAgICAgICBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpLFxuICAgICAgfSl9XFxuYCxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG5cbiAgY29uc3QgYm91bmRQb3J0ID0gc2VydmVyLnBvcnQ7XG4gIGlmICghc2Vzc2lvbklkKSBzZXNzaW9uSWQgPSBgaW1hZ28tJHtyYW5kSGV4KDQpfS1wJHtib3VuZFBvcnR9YDtcbiAgc2Vzc2lvbkZpbGVzRGlyID0gam9pbih0bXBkaXIoKSwgYCR7c2Vzc2lvbklkfS1maWxlc2ApO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhzZXNzaW9uRmlsZXNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIGJhY2sgdG8gbm8tZmlsZS1wYXRocyAocGF0aCBzdGF5cyBcIlwiKSAqL1xuICB9XG4gIC8vIE9uIHJlc3RvcmUsIHRoZSBzbmFwc2hvdCdzIHNyYyBibG9icyBhcmUgc2VsZi1jb250YWluZWQgYnV0IGl0cyBmaWxlIHBhdGhzXG4gIC8vIGFyZSBzdGFsZSAob2xkIHRtcGRpciwgY2xlYW5lZCkuIFJlLW1hdGVyaWFsaXplIGZpbGVzIHNvIHRoZSBhZ2VudCdzIHZpc2lvblxuICAvLyAoUmVhZCBieSBwYXRoKSB3b3JrcyBhZ2Fpbi5cbiAgaWYgKHJlc3RvcmVkKSB7XG4gICAgLy8gcmVmcy1hcy1hc3NldHMgbWlncmF0aW9uOiBhIGxlZ2FjeSBgcmVmc1tdYCBhcnJheSDihpIgYW4gaW1wb3J0LWtpbmQgYmF0Y2ggb2ZcbiAgICAvLyB2YXJpYW50cywgUkVVU0lORyBlYWNoIHJlZiBpZCBhcyB0aGUgdmFyaWFudCBpZCAoc28gcmUtcmVzdG9yZSBpcyBpZGVtcG90ZW50XG4gICAgLy8gYW5kIGFueSBoaXN0b3JpY2FsIHNlbGVjdGVkUmVmSWRzIHN0aWxsIHJlc29sdmUpLiBSdW5zIEJFRk9SRSBtYXRlcmlhbGl6YXRpb25cbiAgICAvLyBzbyB0aGUgbmV3IHZhcmlhbnRzIGdldCB0aGVpciBvbi1kaXNrIHBhdGhzLlxuICAgIHR5cGUgTGVnYWN5UmVmID0ge1xuICAgICAgaWQ6IHN0cmluZztcbiAgICAgIHNyYzogc3RyaW5nO1xuICAgICAgcGF0aD86IHN0cmluZztcbiAgICAgIG5hbWU/OiBzdHJpbmc7XG4gICAgICBzZWxlY3RlZD86IGJvb2xlYW47XG4gICAgICBoYXNoPzogc3RyaW5nO1xuICAgICAgYW5hbHlzaXM/OiBzdHJpbmc7XG4gICAgfTtcbiAgICBjb25zdCBsZWdhY3lSZWZzID0gKHN0YXRlIGFzIHsgcmVmcz86IExlZ2FjeVJlZltdIH0pLnJlZnM7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkobGVnYWN5UmVmcykgJiYgbGVnYWN5UmVmcy5sZW5ndGgpIHtcbiAgICAgIHN0YXRlLmJhdGNoZXMucHVzaCh7XG4gICAgICAgIGlkOiBuZXdJZChcImJcIiksXG4gICAgICAgIGtpbmQ6IFwiaW1wb3J0XCIsXG4gICAgICAgIHByb21wdDogXCJcIixcbiAgICAgICAgdGFnOiBcInJlZmVyZW5jZXNcIixcbiAgICAgICAgdmFyaWFudHM6IGxlZ2FjeVJlZnMubWFwKChyKSA9PiB7XG4gICAgICAgICAgY29uc3QgaGFzaCA9IHIuaGFzaCA/PyAoci5zcmMgPyBjb250ZW50SGFzaChyLnNyYykgOiB1bmRlZmluZWQpO1xuICAgICAgICAgIC8vIHNlZWQgdGhlIGhhc2jihpJhbmFseXNpcyBjYWNoZSBzbyBkZWxldGluZyArIHJlLWltcG9ydGluZyB0aGUgc2FtZSBwaXhlbHNcbiAgICAgICAgICAvLyBzdGlsbCByZXVzZXMgdGhlIGFnZW50J3MgcHJpb3IgcmVhZCAodGhlIG9sZCBkZWxldGUvcmUtYWRkIGludmFyaWFudClcbiAgICAgICAgICBpZiAoaGFzaCAmJiByLmFuYWx5c2lzKSBzdGF0ZS5hbmFseXNpc0NhY2hlW2hhc2hdID0gci5hbmFseXNpcztcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgaWQ6IHIuaWQsIC8vIHJldXNlIHRoZSByZWYgaWQgYXMgdGhlIHZhcmlhbnQgaWRcbiAgICAgICAgICAgIHNyYzogci5zcmMsXG4gICAgICAgICAgICBwYXRoOiByLnBhdGggPz8gXCJcIixcbiAgICAgICAgICAgIGxpa2VkOiBmYWxzZSxcbiAgICAgICAgICAgIGFuYWx5c2lzOiByLmFuYWx5c2lzID8/IFwiXCIsXG4gICAgICAgICAgICBuYW1lOiByLm5hbWUsXG4gICAgICAgICAgICByZWZTZWxlY3RlZDogci5zZWxlY3RlZCA9PT0gdHJ1ZSxcbiAgICAgICAgICAgIGhhc2gsXG4gICAgICAgICAgfTtcbiAgICAgICAgfSksXG4gICAgICB9KTtcbiAgICB9XG4gICAgZGVsZXRlIChzdGF0ZSBhcyB7IHJlZnM/OiB1bmtub3duIH0pLnJlZnM7XG5cbiAgICAvLyBjb250ZXh0LWxpYnJhcnkgbWlncmF0aW9uOiBsZWdhY3kgc3R5bGVzW10vcHJvbXB0c1tdIOKGkiB1bmlmaWVkIGxpYnJhcnkgKyBzZXRzLlxuICAgIHR5cGUgTGVnYWN5U3R5bGUgPSB7XG4gICAgICBuYW1lOiBzdHJpbmc7XG4gICAgICBhY3RpdmU/OiBib29sZWFuO1xuICAgICAgY2FwdHVyZWQ/OiBib29sZWFuO1xuICAgICAgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gICAgICBpbWFnZT86IHN0cmluZztcbiAgICAgIGltYWdlUGF0aD86IHN0cmluZztcbiAgICB9O1xuICAgIHR5cGUgTGVnYWN5UHJvbXB0ID0geyBpZDogc3RyaW5nOyBsYWJlbDogc3RyaW5nOyB0ZXh0OiBzdHJpbmcgfTtcbiAgICBjb25zdCBpc0xlZ2FjeUNvbnRleHQgPVxuICAgICAgQXJyYXkuaXNBcnJheSgoc3RhdGUgYXMgeyBzdHlsZXM/OiB1bmtub3duIH0pLnN0eWxlcykgfHxcbiAgICAgIEFycmF5LmlzQXJyYXkoKHN0YXRlIGFzIHsgcHJvbXB0cz86IHVua25vd24gfSkucHJvbXB0cyk7XG4gICAgaWYgKGlzTGVnYWN5Q29udGV4dCkge1xuICAgICAgc3RhdGUubGlicmFyeSA9IFtdO1xuICAgICAgc3RhdGUuYWN0aXZlQ29udGV4dElkcyA9IFtdO1xuICAgICAgc3RhdGUucXVpY2tQcm9tcHRJZHMgPSBbXTtcbiAgICB9IGVsc2Uge1xuICAgICAgc3RhdGUubGlicmFyeSA/Pz0gW107XG4gICAgICBzdGF0ZS5hY3RpdmVDb250ZXh0SWRzID8/PSBbXTtcbiAgICAgIHN0YXRlLnF1aWNrUHJvbXB0SWRzID8/PSBbXTtcbiAgICB9XG4gICAgY29uc3QgbGVnYWN5U3R5bGVzID0gKHN0YXRlIGFzIHsgc3R5bGVzPzogTGVnYWN5U3R5bGVbXSB9KS5zdHlsZXM7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkobGVnYWN5U3R5bGVzKSkge1xuICAgICAgZm9yIChjb25zdCBzdCBvZiBsZWdhY3lTdHlsZXMpIHtcbiAgICAgICAgY29uc3QgbmFtZSA9IG5vcm1TdHlsZShzdC5uYW1lKTtcbiAgICAgICAgY29uc3QgaWQgPSBzdHlsZUlkKG5hbWUpO1xuICAgICAgICBzdGF0ZS5saWJyYXJ5LnB1c2goe1xuICAgICAgICAgIGlkLFxuICAgICAgICAgIGtpbmQ6IFwic3R5bGVcIixcbiAgICAgICAgICBuYW1lLFxuICAgICAgICAgIGNvbnRlbnQ6IHN0LmRlc2NyaXB0aW9uID8/IFwiXCIsXG4gICAgICAgICAgaW1hZ2U6IHN0LmltYWdlLFxuICAgICAgICAgIGltYWdlUGF0aDogc3QuaW1hZ2VQYXRoLFxuICAgICAgICAgIGNhcHR1cmVkOiBzdC5jYXB0dXJlZCxcbiAgICAgICAgfSk7XG4gICAgICAgIGlmIChzdC5hY3RpdmUpIHN0YXRlLmFjdGl2ZUNvbnRleHRJZHMucHVzaChpZCk7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGxlZ2FjeVByb21wdHMgPSAoc3RhdGUgYXMgeyBwcm9tcHRzPzogTGVnYWN5UHJvbXB0W10gfSkucHJvbXB0cztcbiAgICBpZiAoQXJyYXkuaXNBcnJheShsZWdhY3lQcm9tcHRzKSkge1xuICAgICAgZm9yIChjb25zdCBwIG9mIGxlZ2FjeVByb21wdHMpIHtcbiAgICAgICAgc3RhdGUubGlicmFyeS5wdXNoKHtcbiAgICAgICAgICBpZDogcC5pZCxcbiAgICAgICAgICBraW5kOiBcInByb21wdFwiLFxuICAgICAgICAgIG5hbWU6IHAubGFiZWwsXG4gICAgICAgICAgY29udGVudDogcC50ZXh0LFxuICAgICAgICB9KTtcbiAgICAgICAgc3RhdGUucXVpY2tQcm9tcHRJZHMucHVzaChwLmlkKTtcbiAgICAgIH1cbiAgICB9XG4gICAgZGVsZXRlIChzdGF0ZSBhcyB7IHN0eWxlcz86IHVua25vd24gfSkuc3R5bGVzO1xuICAgIGRlbGV0ZSAoc3RhdGUgYXMgeyBwcm9tcHRzPzogdW5rbm93biB9KS5wcm9tcHRzO1xuXG4gICAgZm9yIChjb25zdCBiIG9mIHN0YXRlLmJhdGNoZXMpIHtcbiAgICAgIGZvciAoY29uc3QgdjIgb2YgYi52YXJpYW50cykge1xuICAgICAgICBpZiAodjIuc3JjKSB2Mi5wYXRoID0gc2F2ZURhdGFVcmwoc2Vzc2lvbkZpbGVzRGlyLCB2Mi5pZCwgdjIuc3JjKSB8fCB2Mi5wYXRoO1xuICAgICAgICBpZiAodjIuYW5hbHlzaXMgPT09IHVuZGVmaW5lZCkgdjIuYW5hbHlzaXMgPSBcIlwiOyAvLyBiYWNrZmlsbCBwcmUtYW5hbHlzaXMgc25hcHNob3RzXG4gICAgICB9XG4gICAgfVxuICAgIGZvciAoY29uc3QgZSBvZiBzdGF0ZS5saWJyYXJ5KSB7XG4gICAgICBpZiAoZS5pbWFnZSkgZS5pbWFnZVBhdGggPSBzYXZlRGF0YVVybChzZXNzaW9uRmlsZXNEaXIsIGUuaWQsIGUuaW1hZ2UpIHx8IGUuaW1hZ2VQYXRoO1xuICAgIH1cbiAgICAvLyBNaWdyYXRlIHByZS1kdXJhYmlsaXR5IHNuYXBzaG90czogYSBsZWdhY3kgZ2xvYmFsIGBtYXJrc2AgYXJyYXkg4oaSIHRoZVxuICAgIC8vIGZvY3VzZWQgdmFyaWFudCdzIGJ1Y2tldC4gVGhlbiBub3JtYWxpemUgek9yZGVyIHdpdGhpbiBlYWNoIGJ1Y2tldC5cbiAgICBjb25zdCBsZWdhY3kgPSAoc3RhdGUgYXMgeyBtYXJrcz86IE1hcmtbXSB9KS5tYXJrcztcbiAgICBpZiAoQXJyYXkuaXNBcnJheShsZWdhY3kpKSB7XG4gICAgICBpZiAobGVnYWN5Lmxlbmd0aCAmJiBzdGF0ZS5mb2N1cykgc3RhdGUubWFya3NCeVZhcmlhbnRbc3RhdGUuZm9jdXMudmFyaWFudElkXSA9IGxlZ2FjeTtcbiAgICAgIGRlbGV0ZSAoc3RhdGUgYXMgeyBtYXJrcz86IE1hcmtbXSB9KS5tYXJrcztcbiAgICB9XG4gICAgc3RhdGUubWFya3NCeVZhcmlhbnQgPz89IHt9O1xuICAgIHN0YXRlLmxheWVyc0J5VmFyaWFudCA/Pz0ge307XG4gICAgZm9yIChjb25zdCB2aWQgb2YgT2JqZWN0LmtleXMoc3RhdGUubWFya3NCeVZhcmlhbnQpKSB7XG4gICAgICBjb25zdCBtYXJrcyA9IHN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF07XG4gICAgICAvLyBCYWNrZmlsbCB0aGUgY29udGFpbmVyIG1vZGVsOiB3cmFwIHByZS1sYXllciBtYXJrcyBpbnRvIG9uZSBkZWZhdWx0XG4gICAgICAvLyBcIkFubm90YXRpb25zXCIgbGF5ZXIsIHRoZW4gc3RhbXAgbGF5ZXJJZCArIG5vcm1hbGl6ZSB6T3JkZXIgYnkgcG9zaXRpb24uXG4gICAgICBsZXQgbGF5ZXJzID0gc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF07XG4gICAgICBpZiAoIWxheWVycz8ubGVuZ3RoICYmIG1hcmtzLmxlbmd0aCkge1xuICAgICAgICBsYXllcnMgPSBbeyBpZDogbmV3SWQoXCJsYXllclwiKSwgbmFtZTogXCJBbm5vdGF0aW9uc1wiLCBraW5kOiBcImFubm90YXRpb25cIiB9XTtcbiAgICAgICAgc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0gPSBsYXllcnM7XG4gICAgICB9XG4gICAgICBjb25zdCBkZWZhdWx0TGF5ZXJJZCA9IGxheWVycz8uW2xheWVycy5sZW5ndGggLSAxXT8uaWQ7XG4gICAgICBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdID0gbWFya3MubWFwKChtLCBpKSA9PiAoe1xuICAgICAgICAuLi5tLFxuICAgICAgICB6T3JkZXI6IG0uek9yZGVyID09PSB1bmRlZmluZWQgPyBpIDogbS56T3JkZXIsXG4gICAgICAgIGxheWVySWQ6IG0ubGF5ZXJJZCA/PyBkZWZhdWx0TGF5ZXJJZCxcbiAgICAgIH0pKTtcbiAgICB9XG4gICAgc2F2ZVNuYXBzaG90KCk7XG4gIH1cblxuICBjb25zdCB1cmwgPSBgaHR0cDovLyR7aG9zdH06JHtib3VuZFBvcnR9YDtcbiAgLy8gYG1vZGVgIGlzIHRoZSBPTkxZIHRoaW5nIHRoYXQgZGlzY3JpbWluYXRlcyBhIHJlbGVhc2UgZGFlbW9uIGZyb20gYSBkZXZcbiAgLy8gb25lOiB3aXRoIHJvb3QgZGVwcyBwcmVzZW50IGEgZGV2IGRhZW1vbiByZW5kZXJzIGFuIGlkZW50aWNhbC1sb29raW5nXG4gIC8vIHN1cmZhY2UsIHNvIFwiaXQgbG9va3MgcmlnaHRcIiBjYW5ub3QgdmVyaWZ5IENvbnRyYWN0IDEuIGltYWdvIHdyaXRlcyBOT1xuICAvLyBzdGRvdXQgaGFuZHNoYWtlIChtaW5kLW1hcHBlciBhbmQgYXN0cm9sYWJlIGRvKSDigJQgaXRzIGhhbmRzaGFrZSBpcyB0aGVcbiAgLy8gZGlzY292ZXJ5IGZpbGUgYmVsb3csIHNvIGBtb2RlYCByaWRlcyBCT1RILCBzYW1lIHJvbGUsIGRpZmZlcmVudCB0cmFuc3BvcnQuXG4gIGVtaXRFdmVudCh7IHR5cGU6IFwicmVhZHlcIiwgdXJsLCBwb3J0OiBib3VuZFBvcnQsIHNlc3Npb25faWQ6IHNlc3Npb25JZCwgbW9kZSB9KTtcblxuICAvLyBEaXNjb3ZlcnkgZmlsZXMg4oCUIGNsaS50cyByZWFkcyB0aGUgcG9ydCBmcm9tIGhlcmUuXG4gIGNvbnN0IHNlc3Npb25GaWxlID0gam9pbih0bXBkaXIoKSwgYGltYWdvLSR7c2Vzc2lvbklkfS5qc29uYCk7XG4gIGNvbnN0IGxhdGVzdEZpbGUgPSBqb2luKHRtcGRpcigpLCBgaW1hZ28tbGF0ZXN0Lmpzb25gKTtcbiAgY29uc3Qgc2Vzc2lvbkluZm8gPSBKU09OLnN0cmluZ2lmeSh7XG4gICAgdXJsLFxuICAgIHBvcnQ6IGJvdW5kUG9ydCxcbiAgICBzZXNzaW9uX2lkOiBzZXNzaW9uSWQsXG4gICAgdGl0bGU6IHN0YXRlLnRpdGxlLFxuICAgIGZpbGVzX2Rpcjogc2Vzc2lvbkZpbGVzRGlyLFxuICAgIG1vZGUsXG4gIH0pO1xuICAvLyDimqAgQVRPTUlDLCBiZWNhdXNlIHJlYWRTZXNzaW9uIHRyZWF0cyB1bnBhcnNlYWJsZSBjb250ZW50IGFzIGNvcnJ1cHRpb25cbiAgLy8gcmF0aGVyIHRoYW4gYWJzZW5jZSDigJQgYW5kIHRoaXMgaW1wbGVtZW50YXRpb24gaXMgbm93XG4gIC8vIGBraXQvd2lyZS9kaXNjb3ZlcnkudHNgLCBzaGFyZWQgd2l0aCB0aGUgc2luZ2xldG9uIGNvbnZlbnRpb24gRDMga2VwdCBhbGl2ZVxuICAvLyBiZXNpZGUgdGhpcyBvbmUuIEEgYmFyZSBgd3JpdGVGaWxlU3luY2AgaXMgbm90IGF0b21pYzogYSBDTEkgcmVhZGluZyB3aGlsZVxuICAvLyB0aGUgZGFlbW9uIHdyaXRlcyBvYnNlcnZlcyBhIGhhbGYtd3JpdHRlbiBwb2ludGVyLCB3aGljaCB0aGUgb2xkXG4gIC8vIGJlc3QtZWZmb3J0IHJlYWQgcmVwb3J0ZWQgYXMgXCJubyBydW5uaW5nIHNlc3Npb25cIi4gQ2Vuc3VzIGRlZmVjdCBMMyDigJRcbiAgLy8gaW1hZ28gd2FzIGFscmVhZHkgQ09SUkVDVCBoZXJlIChpdCB3YXMgZml4ZWQgMjAyNi0wOS0wOCBmcm9tIGdsYW1vdXInc1xuICAvLyBmaW5kKSwgc28gd2hhdCBhZG9wdGlvbiBidXlzIGlzIG5vdCBhIGZpeCBidXQgdGhlIHJlbW92YWwgb2YgdGhlIGZvdXJ0aFxuICAvLyBjb3B5OiB0aGUgdGVtcC1uYW1lLWNhcnJpZXMtdGhlLXBpZCBkZXRhaWwgYW5kIHRoZSBmYWlsZWQtd3JpdGUgY2xlYW51cCBhcmVcbiAgLy8gbm8gbG9uZ2VyIGZvdXIgdGhpbmdzIHRoYXQgbXVzdCBzdGF5IGVxdWFsLlxuICB0cnkge1xuICAgIHdyaXRlRmlsZUF0b21pYyhzZXNzaW9uRmlsZSwgc2Vzc2lvbkluZm8pO1xuICAgIHdyaXRlRmlsZUF0b21pYyhsYXRlc3RGaWxlLCBzZXNzaW9uSW5mbyk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGBpbWFnbzogY291bGQgbm90IHdyaXRlIGRpc2NvdmVyeSBmaWxlOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG5gLFxuICAgICk7XG4gIH1cbiAgLy8gVGhlIHNlc3Npb24gcG9pbnRlciBpcyB1bmNvbmRpdGlvbmFsbHkgb3VyczsgYGltYWdvLWxhdGVzdC5qc29uYCBpcyBOT1Qg4oCUIGFcbiAgLy8gbmV3ZXIgc2Vzc2lvbiBtYXkgYWxyZWFkeSBoYXZlIGNsYWltZWQgaXQsIGFuZCB1bmxpbmtpbmcgdGhhdCB3b3VsZCBtYWtlIHRoZVxuICAvLyBsaXZlIGRhZW1vbiBpbnZpc2libGUgdG8gdGhlIG5leHQgdmVyYiwgc28gdGhlIG5leHQgQ0xJIHZlcmIgc3Bhd25zIGEgdGhpcmQuXG4gIC8vIGB1bmxpbmtJZk1hdGNoZXNgJ3MgYGlkZW50aWZ5YCBob29rIGlzIHdoYXQgbGV0cyBPTkUgc2hhcmVkIHByZWRpY2F0ZSBzZXJ2ZVxuICAvLyBib3RoIHRoaXMgSlNPTiBwb2ludGVyIGFuZCBhc3Ryb2xhYmUncyBiYXJlIHBpZCBmaWxlLlxuICAvL1xuICAvLyDimqAgSVQgQUxTTyBTVE9QUEVEIEJFSU5HIEFTWU5DLCB3aGljaCBpcyBhIHJlYWwgc2ltcGxpZmljYXRpb24gYW5kIG5vdCBhXG4gIC8vIHN0eWxlIGVkaXQ6IHRoZSBvbGQgdmVyc2lvbiByZWFkIGBsYXRlc3RGaWxlYCB0aHJvdWdoIGBhd2FpdCBCdW4uZmlsZSgpLnRleHQoKWBcbiAgLy8gcHVyZWx5IHRvIGNvbXBhcmUgb25lIGZpZWxkLCB3aGljaCBtYWRlIHRoZSB3aG9sZSB0ZWFyZG93biBwYXRoIGFzeW5jIGZvciBhXG4gIC8vIHN5bmNocm9ub3VzIGRlY2lzaW9uLlxuICBjb25zdCBjbGVhbnVwRGlzY292ZXJ5ID0gKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICB1bmxpbmtTeW5jKHNlc3Npb25GaWxlKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGdvbmUg4oCUIGZpbmUgKi9cbiAgICB9XG4gICAgdW5saW5rSWZNYXRjaGVzKGxhdGVzdEZpbGUsIHNlc3Npb25JZCwgKHJhdykgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgaWQgPSAoSlNPTi5wYXJzZShyYXcpIGFzIHsgc2Vzc2lvbl9pZD86IHVua25vd24gfSkuc2Vzc2lvbl9pZDtcbiAgICAgICAgcmV0dXJuIHR5cGVvZiBpZCA9PT0gXCJzdHJpbmdcIiA/IGlkIDogbnVsbDtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICB9KTtcbiAgICB0cnkge1xuICAgICAgaWYgKHNlc3Npb25GaWxlc0Rpcikgcm1TeW5jKHNlc3Npb25GaWxlc0RpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9O1xuXG4gIGlmICghdltcIm5vLW9wZW5cIl0pIG9wZW5Ccm93c2VyKHVybCk7XG5cbiAgLy8gVGhlIHR3byBzdGFuZGluZyB0aW1lcnMg4oCUIHRoZSBpZGxlIHN3ZWVwIGFuZCB0aGUgZGVib3VuY2VkIHNuYXBzaG90IOKAlCBhcmVcbiAgLy8gT05FIGNhbGwsIGJlY2F1c2UgdGhleSBoYXZlIGFsd2F5cyBiZWVuIG9uZSBsaWZldGltZTogZXZlcnkgY29weSBjbGVhcmVkXG4gIC8vIGJvdGggaW4gdGhlIHNhbWUgdHdvIGxpbmVzIGFmdGVyIGBhd2FpdCBkb25lYCwgYW5kIHRoZSBwYWlyIHRoYXQgZ2V0c1xuICAvLyBmb3Jnb3R0ZW4gaXMgdGhlIHBhaXIgd2hvc2UgdGltZXJzIGtlZXAgYSBwcm9jZXNzIGFsaXZlIGFmdGVyIHRlYXJkb3duLlxuICAvL1xuICAvLyDim5QgVEhFIFNXRUVQIE5PVyBTRUVTIElUUyBTVUJTQ1JJQkVSUyDigJQgQ0VOU1VTIERFRkVDVCBMMSwgY2xvc2VkIGJ5IHRoZVxuICAvLyBzaGFyZWQgaG91c2VrZWVwZXIgUkVRVUlSSU5HIGEgYHN1YnNjcmliZXJDb3VudGAgcmF0aGVyIHRoYW4gYnkgYW55b25lXG4gIC8vIHJlbWVtYmVyaW5nIHRvIHBhc3Mgb25lLiBpbWFnbydzIGV4cHJlc3Npb24gcmVhZFxuICAvLyBgKG5vdyAtIGxhc3RBY3Rpdml0eSkgLyAxMDAwID49IHRpbWVvdXRgIGFuZCBub3RoaW5nIGVsc2UsIHNvIGFuIGFnZW50XG4gIC8vIGhvbGRpbmcgYSBgL2V2ZW50c2AgdGFpbCBvbiBhIHF1aWV0IGJvYXJkIHdhcyBraWxsZWQgV0lUSCBJVFMgQ09OTkVDVElPTlxuICAvLyBPUEVOIGF0IHRoZSAzMC1taW51dGUgZGVmYXVsdC4gYHRpbWVvdXRgIG5vdyBtZWFucyBcImxpbmdlciB0aGlzIGxvbmcgYWZ0ZXJcbiAgLy8gdGhlIExBU1Qgc3Vic2NyaWJlciBsZWF2ZXNcIiwgbm90IFwibWF4aW11bSBpZGxlIHdoaWxlIGNvbm5lY3RlZFwiIOKAlCBhXG4gIC8vIGRlbGliZXJhdGUgY2hhbmdlIG9mIG1lYW5pbmcsIGFuZCB0aGUgb25lIHRoZSBjZW5zdXMgYXNrZWQgZm9yLlxuICBjb25zdCBzdG9wSG91c2VrZWVwaW5nID0gc3RhcnRIb3VzZWtlZXBpbmcoe1xuICAgIHN1YnNjcmliZXJDb3VudDogKCkgPT4gc29ja2V0cy5zaXplICsgc3NlQ2xpZW50cy5zaXplLFxuICAgIGlkbGVNczogKCkgPT4gcGVyZm9ybWFuY2Uubm93KCkgLSBsYXN0QWN0aXZpdHksXG4gICAgdG91Y2gsXG4gICAgdGltZW91dE1zOiB0aW1lb3V0ICogMTAwMCxcbiAgICBvbklkbGVDbG9zZTogKCkgPT4gcmVzb2x2ZURvbmUoeyBjb2RlOiAxMjQsIHJlYXNvbjogXCJ0aW1lb3V0XCIgfSksXG4gICAgc25hcHNob3Q6IHtcbiAgICAgIGRpcnR5OiAoKSA9PiBzbmFwRGlydHksXG4gICAgICBjbGVhcjogKCkgPT4ge1xuICAgICAgICBzbmFwRGlydHkgPSBmYWxzZTtcbiAgICAgIH0sXG4gICAgICAvLyBEZWJvdW5jZWQgcGVyc2lzdGVuY2UsIHNvIGEgcmVzdGFydCAoYGNsaS50cyBvcGVuIC0tcmVzdG9yZSA8aWQ+YClcbiAgICAgIC8vIHJlc3VtZXMgZXhhY3RseSB3aGVyZSB3ZSBsZWZ0IG9mZi5cbiAgICAgIHdyaXRlOiBzYXZlU25hcHNob3QsXG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgeyBjb2RlLCByZWFzb24gfSA9IGF3YWl0IGRvbmU7XG4gIHN0b3BIb3VzZWtlZXBpbmcoKTtcbiAgc2F2ZVNuYXBzaG90KCk7IC8vIGZpbmFsIHdyaXRlIOKAlCBrZWVwIGl0ICh0aGUgcmVzdW1lIHBvaW50LCBOT1QgZGVsZXRlZCBvbiBjbG9zZSlcbiAgZW1pdEV2ZW50KHsgdHlwZTogXCJjbG9zZWRcIiwgcmVhc29uIH0pO1xuICBicm9hZGNhc3QoeyB0eXBlOiBcIm1lc3NhZ2VcIiwgdGV4dDogYHNlc3Npb24gZW5kZWQ6ICR7cmVhc29ufWAgfSk7XG4gIC8vIOKblCBUSEUgR1JBQ0UgUEVSSU9EIElTIE5PVCBQT0xJVEVORVNTOiBhIGBjbG9zZWRgIGZyYW1lIGZvbGxvd2VkIGltbWVkaWF0ZWx5XG4gIC8vIGJ5IGFuIGFnZ3Jlc3NpdmUgYHNlcnZlci5zdG9wKHRydWUpYCBpcyBhIGZyYW1lIHRoZSBjbGllbnQgbmV2ZXIgc2VlcywgYW5kXG4gIC8vIHRoZSBDTEkncyB0YWlsIHdhdGNoZXMgZm9yIGV4YWN0bHkgdGhhdCBmcmFtZSB0byBlbmQgdGhlIHdhdGNoLiBBTkQgVEhFIFNUT1BcbiAgLy8gSVMgUkFDRUQsIGJlY2F1c2UgYHN0b3AodHJ1ZSlgIGF3YWl0cyBpdHMgY29ubmVjdGlvbnMgYW5kIG9uZSB3ZWRnZWQgcGVlciBpc1xuICAvLyBlbm91Z2ggdG8gcGFyayB0ZWFyZG93biBmb3JldmVyLiBCb3RoIGFyZSBub3cgYGtpdC93aXJlL2hvdXNla2VlcGluZy50c2AuXG4gIC8vXG4gIC8vIOKaoCBBTkQgVEhFIFNFQ09ORCBSRUdJU1RSWSBJUyBHT05FLiBUaGlzIHN3ZXB0IGBzc2VUaW1lcnNgIGFuZCBgc3NlQ2xpZW50c2BcbiAgLy8gc2VwYXJhdGVseTsgdGhlIHBlci1zdHJlYW0gaGVhcnRiZWF0IG5vdyBsaXZlcyBpbnNpZGUgdGhlIHN0cmVhbSdzIG93blxuICAvLyB0ZWFyZG93biBmdW5uZWwsIHNvIHRoZXJlIGlzIG5vdGhpbmcgbGVmdCB0byBmYWxsIG91dCBvZiBzdGVwIHdpdGguXG4gIGF3YWl0IGRyYWluQW5kU3RvcCh7IHNlcnZlciwgY2xpZW50czogc3NlQ2xpZW50cywgc29ja2V0cyB9KTtcbiAgY2xlYW51cERpc2NvdmVyeSgpO1xuICByZXR1cm4gY29kZTtcbn1cblxuLyoqXG4gKiBUaGUgZGFlbW9uJ3MgT05FIGVudHJ5LCBhbmQgaXQgaXMgdGhlIExBVU5DSEVSJ3MgdG8gY2FsbCAoRDEyLCBwbGF5Ym9vayBCMykuXG4gKlxuICog4puUIE5PIGBpbXBvcnQubWV0YS5tYWluYCBCTE9DSywgRk9SIFRXTyBSRUFTT05TIEFORCBFSVRIRVIgT05FIElTIEZBVEFMLlxuICogRmlyc3QsIGBkaXN0L3NlcnZlci5qc2AgaXMgSU1QT1JURUQgYnkgYDxza2lsbD4vc2NyaXB0cy9zZXJ2ZXIudHNgLCBzb1xuICogYGltcG9ydC5tZXRhLm1haW5gIGlzIEZBTFNFIGFuZCB0aGUgYmxvY2sgd291bGQgbmV2ZXIgcnVuOiB0aGUgZGFlbW9uIHdvdWxkXG4gKiBib290LCBiaW5kIG5vdGhpbmcsIGV4aXQgMCwgYW5kIGV2ZXJ5IGludGVncmF0aW9uIHRlc3Qgd291bGQgZmFpbCBhcyBcIm5ldmVyXG4gKiBhbnN3ZXJlZFwiLCB3aGljaCByZWFkcyBsaWtlIGZsYWtlLiBTZWNvbmQg4oCUIGFuZCB0aGlzIGlzIHdoeSB0aGUgZGFlbW9uIGtlZXBzXG4gKiBubyBTRUNPTkQgZW50cnkgZXZlbiBmb3IgY29udmVuaWVuY2Ug4oCUIGBTS0lMTF9ST09UYCBpcyBgaW1wb3J0Lm1ldGEuZGlyLy4uYCxcbiAqIHdoaWNoIGlzIHRoZSBza2lsbCByb290IE9OTFkgZnJvbSBgZGlzdC9gLiBSdW4gZnJvbSBgc3JjL2ltYWdvL2JhY2tlbmQvYCBpdFxuICogY29tcHV0ZXMgYHNyYy9pbWFnby9gLCBmaW5kcyBubyBgZGlzdC9pbmRleC5odG1sYCwgc2lsZW50bHkgY2hvb3NlcyBERVYsIGFuZFxuICogdGhlbiBmYWlscyB0aGUgZGV2IGltcG9ydCBmcm9tIHRoZSB3cm9uZyBhbmNob3IuIE9mZmVyaW5nIHRoYXQgZW50cnkgd291bGQgYmVcbiAqIG9mZmVyaW5nIGEgd3JvbmcgZGFlbW9uLlxuICpcbiAqIOKaoCBUSEUgVEVSTUlOQUwgYHByb2Nlc3MuZXhpdChleGl0Q29kZSlgIE1PVkVEIFRPIFRIRSBMQVVOQ0hFUiBWRVJCQVRJTSBhbmRcbiAqIG11c3Qgc3RheSB0aGVyZTogaXQgaXMgZmFtaWx5IEUtdGVybWluYWwgaW4gYGdyaW1vaXJlL2V4aXQtc2l0ZS1pbnZlbnRvcnlgLFxuICogcGlubmVkIGF0IGA8c2tpbGw+L3NjcmlwdHMvc2VydmVyLnRzYC4gQSBkYWVtb24gaXMgbm90IGEgQ0xJIOKAlCBpdHMgdGVhcmRvd25cbiAqIGhhcyBhbHJlYWR5IHJ1biBpbnNpZGUgYG1haW5gLCB3aGljaCBhd2FpdHMgaXRzIG93biBkcmFpbiDigJQgc28gdGhlIENMSSdzXG4gKiBgcHJvY2Vzcy5leGl0Q29kZWAtYW5kLXJldHVybiBydWxlIGRvZXMgTk9UIGFwcGx5IGhlcmUsIGFuZCB0aGUgdHdvIGxhdW5jaGVyc1xuICogZGlmZmVyaW5nIG9uIHRoaXMgb25lIGxpbmUgaXMgZGVsaWJlcmF0ZS4gRG8gbm90IHRpZHkgdGhlbSBpbnRvIGEgbWF0Y2guXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cblxuZXhwb3J0IHR5cGUge1xuICBCYXRjaCxcbiAgSW1hZ29TdGF0ZSxcbiAgVmFyaWFudCxcbn0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9pbWFnby9zaGFyZWQvdHlwZXNcIjtcbmV4cG9ydCB7IGRlZmF1bHRTdGF0ZSB9IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvaW1hZ28vc2hhcmVkL3R5cGVzXCI7XG5leHBvcnQgeyBtYWluLCBwYXJzZVBvcnRGcm9tU2Vzc2lvbklkIH07XG4iLAogICAgIi8vIHNoYXJlZC90eXBlcy50c1xuLy8gVGhlIHNpbmdsZSBzaGFyZWQgY29udHJhY3QsIGFuZCB0aGUgcmVhc29uIHNoYXJlZC8gZXhpc3RzOiBpdCBpcyBhIFBFRVIgb2Zcbi8vIGJvdGggc2lkZXMsIG5vdCBiYWNrZW5kLW93bmVkIChSMSkuIEltcG9ydGVkIGJ5IHNjcmlwdHMvc2VydmVyLnRzIEFORCB0aGVcbi8vIFJlYWN0IGNsaWVudC4gSXQgbXVzdCBsaXZlIGluIHRoZSBTSElQUEVEIHRyZWUg4oCUIHRoZSBkYWVtb24gcnVucyBmcm9tIHNvdXJjZVxuLy8gYXQgYSBkZXN0aW5hdGlvbiB0aGF0IG5ldmVyIHJhbiBgaW5zdGFsbGAsIHNvIGFueXRoaW5nIGl0IGltcG9ydHMgaGFzIHRvIGJlXG4vLyBwaHlzaWNhbGx5IGhlcmUuXG4vL1xuLy8gaW1hZ28gaXMgYSBHUk9VTkRFRCBDT05WRVJTQVRJT04gYWJvdXQgYW4gaW1hZ2U6IHRoZSB1c2VyIGFuZCB0aGUgYWdlbnQgdGFsa1xuLy8gKHRoZSBgY29udmVyc2F0aW9uYCksIHRoZSBzdXJmYWNlIGhvbGRzIHRoZSBhcnRpZmFjdHMgdGhleSdyZSB0YWxraW5nIGFib3V0XG4vLyAoYGJhdGNoZXNgIG9mIGtlcHQgZ2VuZXJhdGlvbnMsIHRoZSBgZm9jdXNgZWQgb25lIG9uIHRoZSBjYW52YXMpLCBhbmQgc3VyZmFjZVxuLy8gZ2VzdHVyZXMgKGxpa2luZywgbWFya2luZywgYXR0YWNoaW5nIGEgcmVmKSBhcmUgdGhlbXNlbHZlcyBtZXNzYWdlcyB0aGUgYWdlbnRcbi8vIGhlYXJzLiBUaGVyZSBpcyBubyBcInBoYXNlXCIgcGlwZWxpbmUg4oCUIGl0J3MgYSBsb29wLCBub3QgYSBmdW5uZWwuXG5cbi8vIOKUgOKUgCB0aGUgYXJ0aWZhY3RzIChwaWVjZXMgb24gdGhlIGJvYXJkKSDilIDilIBcblxuLy8gQSBWYXJpYW50IGlzIFRIRSB1bml2ZXJzYWwgaW1hZ2UgYXNzZXQg4oCUIGdlbmVyYXRlZCwgaW1wb3J0ZWQsIG9yIGJyb3VnaHQgaW4gYXNcbi8vIGEgcmVmZXJlbmNlLiBcIkJlaW5nIGEgcmVmZXJlbmNlXCIgaXMgYSBmbGFnIChgcmVmU2VsZWN0ZWRgKSwgbm90IGEgc2VwYXJhdGUgdHlwZTpcbi8vIGFueSB2YXJpYW50IGNhbiBiZSBmb2N1c2VkLCBhbm5vdGF0ZWQsIEFORCBwb2ludGVkIGF0IGZvciB0aGUgbmV4dCBnZW5lcmF0aW9uLlxuZXhwb3J0IHR5cGUgVmFyaWFudCA9IHtcbiAgaWQ6IHN0cmluZztcbiAgc3JjOiBzdHJpbmc7IC8vIGJhc2U2NCB3ZWJwOyBzdHJpcHBlZCBpbiBsZWFuIHByb2plY3Rpb24gKGFnZW50IHJlYWRzIGBwYXRoYClcbiAgcGF0aDogc3RyaW5nOyAvLyBvbi1kaXNrIG1hdGVyaWFsaXplZCBmaWxlIGZvciB0aGUgYWdlbnQgdG8gUmVhZFxuICBzZWVkPzogbnVtYmVyO1xuICBtb2RlbD86IHN0cmluZztcbiAgbGlrZWQ6IGJvb2xlYW47XG4gIGFuYWx5c2lzOiBzdHJpbmc7IC8vIHRoZSBhZ2VudCdzIHJlYWQgb2YgVEhJUyBpbWFnZSDigJQgZHVyYWJsZSwgdXBkYXRhYmxlIG1ldGFkYXRhXG4gIC8vIChkaXN0aW5jdCBmcm9tIHRoZSBCYXRjaCBwcm9tcHQsIHdoaWNoIGlzIGZpeGVkIHByb3ZlbmFuY2UpLiBTaG93biBpbiBkZXRhaWxzLlxuICAvLyBObyBwZXItdmFyaWFudCBwcm9tcHQ6IHRoZSBzZXR0bGVkIHByb21wdCBsaXZlcyBvbiB0aGUgQmF0Y2ggKG9uZSBwcm9tcHQsXG4gIC8vIG1hbnkgc2VlZHMpLiBUaGUgZGlzcGxheSBsYWJlbCAoXCJhXCIvXCJiXCIv4oCmKSBpcyBkZXJpdmVkIGZyb20gYXJyYXkgaW5kZXguXG4gIG5hbWU/OiBzdHJpbmc7IC8vIGVkaXRhYmxlIGxhYmVsOyBibGFuayBmb3IgZ2VuZXJhdGVkICh1c2UgdGhlIGRlcml2ZWQgbGFiZWwpLCBmaWxlbmFtZSBmb3IgaW1wb3J0c1xuICByZWZTZWxlY3RlZD86IGJvb2xlYW47IC8vIHBvaW50ZWQgYXQgYXMgYSByZWZlcmVuY2UgZm9yIHRoZSBuZXh0IGdlbmVyYXRpb25cbiAgaGFzaD86IHN0cmluZzsgLy8gY29udGVudCBoYXNoIChpbXBvcnRzIG9ubHkpIOKAlCBpbXBvcnQgZGVkdXAgKyBhbmFseXNpc0NhY2hlIGtleVxufTtcblxuLy8gQSBiYXRjaCBpcyBvbmUgcm91bmQgb2YgZ2VuZXJhdGlvbiBrZXB0IHRvZ2V0aGVyIChhbGwgdmFyaWFudHMga2VwdCBieVxuLy8gZGVmYXVsdCDigJQgbm8gc2VsZWN0LW9uZS1kaXNjYXJkKS4ga2luZCBkaXN0aW5ndWlzaGVzIGEgZnJlc2ggZ2VuZXJhdGUgZnJvbSBhblxuLy8gZWRpdCBvZiBhbiBleGlzdGluZyB2YXJpYW50LiBUaGUgQmF0Y2gucHJvbXB0IGlzIFRIRSBzZXR0bGVkIHByb21wdCBzYXZlZFxuLy8gd2l0aCB0aGVzZSBpbWFnZXMgKHRoZSBicmllZidzIFwicHJvbXB0IHNhdmVkIHdpdGggdGhlIGltYWdlXCIpLiBEaXNwbGF5IG9yZGVyIC9cbi8vIFwiQmF0Y2ggTlwiIGxhYmVsIGlzIGRlcml2ZWQgZnJvbSBhcnJheSBpbmRleC5cbmV4cG9ydCB0eXBlIEJhdGNoID0ge1xuICBpZDogc3RyaW5nO1xuICBraW5kOiBcImdlbmVyYXRlXCIgfCBcImVkaXRcIiB8IFwiaW1wb3J0XCI7IC8vIGltcG9ydCA9IGEgd29ya2luZyBpbWFnZSB0aGUgdXNlciBicm91Z2h0IGluXG4gIHByb21wdDogc3RyaW5nOyAvLyB0aGUgc2V0dGxlZCBwcm9tcHQgZm9yIHRoaXMgYmF0Y2ggKFwiXCIgZm9yIGltcG9ydHMpXG4gIHRhZz86IHN0cmluZzsgLy8gc2hvcnQgaHVtYW4gc3VtbWFyeSAoXCJhIGZveCByZWFkaW5nIHVuZGVyIGFuIG9ha1wiKVxuICBlZGl0ZWRGcm9tVmFyaWFudElkPzogc3RyaW5nOyAvLyBzZXQgd2hlbiBraW5kID09PSBcImVkaXRcIlxuICB2YXJpYW50czogVmFyaWFudFtdO1xufTtcblxuZXhwb3J0IHR5cGUgRm9jdXMgPSB7IGJhdGNoSWQ6IHN0cmluZzsgdmFyaWFudElkOiBzdHJpbmcgfTtcblxuLy8g4pSA4pSAIHRoZSBjb252ZXJzYXRpb24gKHRoZSBzcGluZSkg4pSA4pSAXG5cbi8vIEV2ZXJ5IHR1cm4gYXQgdGhlIHRhYmxlIGlzIGEgTWVzc2FnZS4gTW9zdCBhcmUgcGxhaW4gYHRleHRgOyBhIGZldyBjYXJyeVxuLy8gc3RydWN0dXJlZCBwaWVjZXMgdGhlIHN1cmZhY2UgcmVuZGVycyBzcGVjaWFsbHkuXG5leHBvcnQgdHlwZSBNZXNzYWdlS2luZCA9XG4gIHwgXCJ0ZXh0XCIgLy8gcGxhaW4gZGlhbG9ndWUgKGVpdGhlciByb2xlKVxuICB8IFwicHJvbXB0XCIgLy8gYWdlbnQgcHJvcG9zZXMgYSBwcm9tcHQgdG8gc2VuZCAoYSBwaWVjZSBvbiB0aGUgYm9hcmQpXG4gIHwgXCJyZXN1bHRcIiAvLyBhZ2VudCByZXBvcnRzIGEgcHJvZHVjZWQgYmF0Y2ggKGxpbmtzIGBiYXRjaElkYClcbiAgfCBcImdlc3R1cmVcIiAvLyBhIHN1cmZhY2UgYWN0aW9uIHN1cmZhY2VkIGFzIGEgbWVzc2FnZSAodXNlciBsaWtlZC9tYXJrZWQv4oCmKVxuICB8IFwicXVlc3Rpb25cIjsgLy8gYWdlbnQgbmVlZHMgdGhlIHVzZXIgKGFuIHVuYW5zd2VyZWQgb25lIOKGkiBcImFza2luZ1wiIHByZXNlbmNlKVxuXG5leHBvcnQgdHlwZSBNZXNzYWdlID0ge1xuICBpZDogc3RyaW5nO1xuICByb2xlOiBcInVzZXJcIiB8IFwiYWdlbnRcIjtcbiAga2luZDogTWVzc2FnZUtpbmQ7XG4gIHRleHQ6IHN0cmluZztcbiAgdHM6IG51bWJlcjtcbiAgLy8ga2luZDogXCJwcm9tcHRcIiDigJQgdGhlIHByb3Bvc2FsIHRoZSB1c2VyIGNvbmZpcm1zIChTZW5kKSBvciBkaXNtaXNzZXMuIFRoZVxuICAvLyBzZXJ2ZXIgZmxpcHMgYHN0YXR1c2Agb24gcHJvcG9zYWwuc2VuZCAvIHByb3Bvc2FsLmRpc21pc3MgKG5vIGFnZW50IGNvbW1hbmRcbiAgLy8gbmVlZGVkIOKAlCBpdCBvd25zIHRoZSBjb252ZXJzYXRpb24gYXJyYXkpLlxuICBwcm9wb3NhbD86IHtcbiAgICBwcm9tcHQ6IHN0cmluZztcbiAgICBuOiBudW1iZXI7XG4gICAgc3RhdHVzOiBcInBlbmRpbmdcIiB8IFwic2VudFwiIHwgXCJkaXNtaXNzZWRcIjtcbiAgfTtcbiAgLy8ga2luZDogXCJyZXN1bHRcIiDigJQgdGhlIGJhdGNoIHRoaXMgbWVzc2FnZSBhbm5vdW5jZWRcbiAgYmF0Y2hJZD86IHN0cmluZztcbiAgLy8ga2luZDogXCJnZXN0dXJlXCIg4oCUIHdoYXQgdGhlIHVzZXIgZGlkLCBhbmQgdG8gd2hhdFxuICBnZXN0dXJlPzoge1xuICAgIGtpbmQ6IFwibGlrZWRcIiB8IFwibWFya2VkXCIgfCBcInJlZi1hZGRlZFwiIHwgXCJmb2N1c1wiIHwgXCJpbXBvcnRlZFwiO1xuICAgIHRhcmdldElkPzogc3RyaW5nO1xuICB9O1xuICAvLyBraW5kOiBcInF1ZXN0aW9uXCIg4oCUIG9wdGlvbmFsIHF1aWNrIHJlcGxpZXMgKHRoZSBmdWxsIGFuc3dlciBjYW4gYmUgZnJlZSB0ZXh0KVxuICBvcHRpb25zPzogc3RyaW5nW107XG59O1xuXG4vLyDilIDilIAgc3RlZXJpbmcgcGllY2VzIChncm91bmRlZCBzaG9ydGN1dHMpIOKUgOKUgFxuXG4vLyBBIHJldXNhYmxlIHN0eWxlOiBjbGlja2luZyB0ZWxscyB0aGUgYWdlbnQgdG8gYXBwbHkgaXRzIHRlY2huaXF1ZSBmb3IgdGhhdFxuLy8gbG9vay4gYGNhcHR1cmVkYCBtYXJrcyBvbmVzIGV4dHJhY3RlZCBmcm9tIGFuIGltYWdlICh0aGUgY2F0YWxvZyBsb29wLWNsb3NlcikuXG4vLyBgbmFtZWAgaXMgdGhlIGtleSDigJQgbm9ybWFsaXplZCAodHJpbW1lZCwgbG93ZXJjYXNlZCkgb24gd3JpdGUgc28gY2FzaW5nIC9cbi8vIHdoaXRlc3BhY2UgY2FuJ3QgY3JlYXRlIGR1cGxpY2F0ZXMuXG4vLyBBIHVuaWZpZWQsIHJldXNhYmxlIHBpZWNlIG9mIHRleHR1YWwgYWdlbnQtY29udGV4dC4gYGtpbmRgIGRyaXZlcyBiZWhhdmlvciArXG4vLyBkZWZhdWx0IGZpbHRlciAoYSBzdHlsZSBtYXRlcmlhbGl6ZXMgYW4gaW1hZ2UgKyBhY3RzIGFzIGFtYmllbnQgY29udGV4dDsgYVxuLy8gcHJvbXB0IGZpbGxzIHRoZSBjb21wb3NlcikgYnV0IGlzIE5PVCBhIGhhcmQgcm91dGVyIOKAlCBtZW1iZXJzaGlwIGluIGEgbGlua2VkXG4vLyBzZXQgKHNlZSBJbWFnb1N0YXRlLmFjdGl2ZUNvbnRleHRJZHMgLyBxdWlja1Byb21wdElkcykgaXMgd2hhdCBzdXJmYWNlcyBpdC5cbi8vIGB0YWdzYCBjYXJyeSBjcm9zcy1raW5kIGZpbmRhYmlsaXR5LiBObyBgYXJjaGl2ZWRgOiByZW1vdmFsIGZyb20gYSBzaXRlIGlzIGFuXG4vLyB1bmxpbms7IHRoZSBvbmx5IGRlc3Ryb3kgaXMgY29udGV4dC5kZWxldGUgb24gdGhlIGxpYnJhcnkuXG5leHBvcnQgdHlwZSBDb250ZXh0S2luZCA9IFwicHJvbXB0XCIgfCBcInN0eWxlXCIgfCBcInNraWxsXCIgfCBcImNvbnRleHRcIjtcbmV4cG9ydCB0eXBlIENvbnRleHRFbnRyeSA9IHtcbiAgaWQ6IHN0cmluZztcbiAga2luZDogQ29udGV4dEtpbmQ7XG4gIG5hbWU6IHN0cmluZztcbiAgY29udGVudDogc3RyaW5nO1xuICB0YWdzPzogc3RyaW5nW107XG4gIGltYWdlPzogc3RyaW5nOyAvLyBiYXNlNjQgaWRlbnRpdHkgaW1hZ2UgKHN0cmlwcGVkIGluIHRoZSBsZWFuIGFnZW50IHByb2plY3Rpb24pXG4gIGltYWdlUGF0aD86IHN0cmluZzsgLy8gb24tZGlzayBtYXRlcmlhbGl6ZWQgaW1hZ2UgdGhlIGFnZW50IGNhbiAtLXJlZlxuICBjYXB0dXJlZD86IGJvb2xlYW47IC8vIHN0eWxlLW9ubHk6IGV4dHJhY3RlZCBmcm9tIGFuIGltYWdlXG59O1xuLy8gVGhlIG5hbWVkIGxpbmtlZCBzZXRzIG92ZXIgYGxpYnJhcnlgICh0aGUgY29uc3VtcHRpb24gc2l0ZXMpLlxuZXhwb3J0IHR5cGUgQ29udGV4dFNldCA9IFwiYWN0aXZlXCIgfCBcInF1aWNrUHJvbXB0c1wiO1xuXG4vLyBBIHZhbHVlIHRoZSB1c2VyIHBpbnMgdG8gbG9jayBmb3IgdGhlIG5leHQgZ2VuZXJhdGUgKGFnZW50IHBpY2tzIHRoZSByZXN0KS5cbmV4cG9ydCB0eXBlIFBpbiA9IHsga2V5OiBzdHJpbmc7IHZhbHVlOiBzdHJpbmcgfTtcblxuLy8gKFJlZmVyZW5jZXMgYXJlIG5vIGxvbmdlciBhIHNlcGFyYXRlIHR5cGUg4oCUIHRoZXkncmUgVmFyaWFudHMgd2l0aCBgcmVmU2VsZWN0ZWRgLlxuLy8gXCJVc2UgdGhlc2UgZm9yIHRoaXMgZ2VuZXJhdGlvblwiID0gdGhlIHNldCBvZiB2YXJpYW50cyB3aGVyZSByZWZTZWxlY3RlZDsgYXRcbi8vIGdlbmVyYXRlIHRpbWUgdGhlIGFnZW50IHVzZXMgdGhhdCBzZXQsIG9yIGFsbCBpZiBub25lIGFyZSBzZWxlY3RlZC4pXG5cbi8vIEFuIGFubm90YXRpb24gbWFyayBvbiBhIHZhcmlhbnQuIENvb3JkcyBhcmUgZnJhY3Rpb25zICgw4oCTMSkgb2YgdGhlIGltYWdlIGJveCxcbi8vIHNvIG1hcmtzIHRyYW5zZm9ybSB3aXRoIHBhbi96b29tOyBzdHJva2Ugd2lkdGggKyB0ZXh0IHNpemUgYXJlIGF1dGhvcmVkIGF0XG4vLyAxMDAlIHpvb20gYW5kIHRoZSBzdXJmYWNlIHNjYWxlcyB0aGVtIHdpdGggdGhlIHpvb20gc28gdGhleSBzdGF5IHdlbGRlZCB0byB0aGVcbi8vIGltYWdlLiBNYXJrcyBhcmUgRFVSQUJMRSBwZXIgaW1hZ2Ug4oCUIGtlcHQgaW4gYG1hcmtzQnlWYXJpYW50YCBrZXllZCBieSB2YXJpYW50XG4vLyBpZCwgc28gc3dpdGNoaW5nIGF3YXkgYW5kIGJhY2sgcHJlc2VydmVzIHRoZW07IGNsZWFyZWQgZXhwbGljaXRseSAobWFya3MuY2xlYXIpXG4vLyBvciB3aGVuIGNvbW1pdHRlZCB0byB0aGUgY29udmVyc2F0aW9uLiBUb29sczogcGluIChsYWJlbGVkIHBvaW50KSwgYXJyb3cgKFwibW92ZVxuLy8gdGhpcyDihpIgdGhlcmVcIiksIGxpbmUsIHJlY3QsIGVsbGlwc2UuIFRoZSBtYXNrIHRvb2wgZHJvcHMgb250byB0aGUgc2FtZSB1bmlvbiBsYXRlci5cbi8vIGB6T3JkZXJgIGlzIHNlcnZlci1hc3NpZ25lZCBvbiBtYXJrLmFkZCAoaGlnaGVyID0gb24gdG9wKTsgdGhlIHN1cmZhY2Ugb21pdHNcbi8vIGl0LiBTZWUgZG9jcy9wcm9qZWN0cy9pbWFnby9hbm5vdGF0aW9uLWFyY2hpdGVjdHVyZS5tZC5cbi8vIGNvbG9yID0gc3Ryb2tlL2FjY2VudCBjb2xvciAoYSB0aGVtZSB0b2tlbiBuYW1lIG9yIENTUyBjb2xvcik7IHdpZHRoID0gc3Ryb2tlXG4vLyB3aWR0aCBpbiBweDsgZm9udFNpemUgPSBsYWJlbCB0ZXh0IHNpemUgaW4gcHggKHBpbnMgdXNlIGl0OyBvdGhlciBtYXJrcyBpZ25vcmVcbi8vIGl0KS4gQWxsIG9wdGlvbmFsIOKAlCB0aGUgc3VyZmFjZSBwaWNrcyBzZW5zaWJsZSBkZWZhdWx0cy5cbmV4cG9ydCB0eXBlIE1hcmtCYXNlID0ge1xuICBpZDogc3RyaW5nO1xuICB6T3JkZXI/OiBudW1iZXI7IC8vIG9yZGVyIFdJVEhJTiB0aGUgZWxlbWVudCdzIGxheWVyIChzZXJ2ZXItYXV0aG9yaXRhdGl2ZSlcbiAgbGF5ZXJJZD86IHN0cmluZzsgLy8gd2hpY2ggTGF5ZXIgKGNvbnRhaW5lcikgdGhpcyBlbGVtZW50IGJlbG9uZ3MgdG87IGJhY2tmaWxsZWQgb24gbWlncmF0aW9uXG4gIHJvdGF0aW9uPzogbnVtYmVyOyAvLyBkZWdyZWVzIGNsb2Nrd2lzZSBhYm91dCB0aGUgZWxlbWVudCdzIGJib3ggY2VudGVyOyBpbWFnZS1maXJzdCAoYWJzZW50ID0gMCA9IHRvZGF5KVxuICBsYWJlbD86IHN0cmluZztcbiAgY29sb3I/OiBzdHJpbmc7XG4gIHdpZHRoPzogbnVtYmVyO1xuICBmb250U2l6ZT86IG51bWJlcjtcbn07XG5leHBvcnQgdHlwZSBNYXJrID1cbiAgfCAoTWFya0Jhc2UgJiB7IHRvb2w6IFwicGluXCI7IHg6IG51bWJlcjsgeTogbnVtYmVyIH0pXG4gIHwgKE1hcmtCYXNlICYge1xuICAgICAgdG9vbDogXCJhcnJvd1wiO1xuICAgICAgeDE6IG51bWJlcjtcbiAgICAgIHkxOiBudW1iZXI7XG4gICAgICB4MjogbnVtYmVyO1xuICAgICAgeTI6IG51bWJlcjtcbiAgICB9KVxuICB8IChNYXJrQmFzZSAmIHtcbiAgICAgIHRvb2w6IFwibGluZVwiO1xuICAgICAgeDE6IG51bWJlcjtcbiAgICAgIHkxOiBudW1iZXI7XG4gICAgICB4MjogbnVtYmVyO1xuICAgICAgeTI6IG51bWJlcjtcbiAgICB9KVxuICB8IChNYXJrQmFzZSAmIHsgdG9vbDogXCJyZWN0XCI7IHg6IG51bWJlcjsgeTogbnVtYmVyOyB3OiBudW1iZXI7IGg6IG51bWJlciB9KVxuICB8IChNYXJrQmFzZSAmIHtcbiAgICAgIHRvb2w6IFwiZWxsaXBzZVwiO1xuICAgICAgY3g6IG51bWJlcjtcbiAgICAgIGN5OiBudW1iZXI7XG4gICAgICByeDogbnVtYmVyO1xuICAgICAgcnk6IG51bWJlcjtcbiAgICB9KVxuICAvLyBmcmVlZm9ybSBza2V0Y2gg4oCUIGFuIG9yZGVyZWQgbGlzdCBvZiBmcmFjdGlvbi1zcGFjZSBwb2ludHMgKGEgcG9seWxpbmUpLiBUaGVcbiAgLy8gdmlzdWFsIGhhbmRvZmYgKGZsYXR0ZW5lZCBpbWFnZSkgaXMgd2hhdCB0aGUgbW9kZWwgcmVhZHM7IGRvdWJsZXMgYXMgYSBmdXR1cmVcbiAgLy8gaW5wYWludC1tYXNrIHJlZ2lvbi5cbiAgfCAoTWFya0Jhc2UgJiB7IHRvb2w6IFwiZHJhd1wiOyBwb2ludHM6IHsgeDogbnVtYmVyOyB5OiBudW1iZXIgfVtdIH0pXG4gIC8vIGFuIGltYWdlIExBWUVSIGVsZW1lbnQg4oCUIGEgZHJvcHBlZCBjbGlwcGluZy9yZWZlcmVuY2UgY29tcG9zaXRlZCBvbnRvIHRoZVxuICAvLyBpbWFnZS4gUmV1c2VzIHJlY3QgZ2VvbWV0cnkgKHgseSx3LGggZnJhY3Rpb25zKSBzbyBpdCBpbmhlcml0c1xuICAvLyBib3VuZHMvaGl0L3Jlc2l6ZS90cmFuc2xhdGU7IGBzcmNgIGlzIGEgYmFzZTY0IHdlYnAgKHN0cmlwcGVkIGluIHRoZSBsZWFuXG4gIC8vIGFnZW50IHByb2plY3Rpb24g4oCUIHRoZSBhZ2VudCByZWFkcyB0aGUgZmxhdHRlbmVkIGNvbXBvc2l0ZSwgbm90IGxheWVyIGJpdG1hcHMpLlxuICB8IChNYXJrQmFzZSAmIHtcbiAgICAgIHRvb2w6IFwiaW1hZ2VcIjtcbiAgICAgIHNyYzogc3RyaW5nO1xuICAgICAgeDogbnVtYmVyO1xuICAgICAgeTogbnVtYmVyO1xuICAgICAgdzogbnVtYmVyO1xuICAgICAgaDogbnVtYmVyO1xuICAgIH0pO1xuZXhwb3J0IGNvbnN0IE1BUktfVE9PTFM6IHJlYWRvbmx5IE1hcmtbXCJ0b29sXCJdW10gPSBbXG4gIFwicGluXCIsXG4gIFwiYXJyb3dcIixcbiAgXCJsaW5lXCIsXG4gIFwicmVjdFwiLFxuICBcImVsbGlwc2VcIixcbiAgXCJkcmF3XCIsXG4gIFwiaW1hZ2VcIixcbl0gYXMgY29uc3Q7XG5cbi8vIEEgTEFZRVIgaXMgYSBDT05UQUlORVIgb2YgbWFya3MgKGVsZW1lbnRzKSBvbiBhIHZhcmlhbnQg4oCUIHRoZSBncm91cGluZyB1bml0IGZvclxuLy8gei1vcmRlciwgdmlzaWJpbGl0eSwgYW5kIGxvY2suIEVsZW1lbnRzIHJlZmVyZW5jZSBpdCB2aWEgTWFyay5sYXllcklkLiBFZmZlY3RpdmVcbi8vIHogPSBsYXllciBvcmRlciAoYXJyYXkgaW5kZXggaW4gYGxheWVyc0J5VmFyaWFudGAsIGJhY2vihpJmcm9udCkgdGhlbiB0aGUgZWxlbWVudCdzXG4vLyBgek9yZGVyYCBXSVRISU4gdGhlIGxheWVyLiBBIFwiZ3JvdXAtb2Ytb25lXCIgKGEgc3RhbmRhbG9uZSBhcnJvdykgaXMganVzdCBhIGxheWVyXG4vLyB3aXRoIGEgc2luZ2xlIGVsZW1lbnQ7IGEgc2tldGNoIGxheWVyIGFjY3JldGVzIG1hbnkgcGVuIHN0cm9rZXMuIFRoZSBiYXNlIGltYWdlXG4vLyAodGhlIGZvY3VzZWQgVmFyaWFudCkgaXMgc2hvd24gYXMgYSBzeW50aGV0aWMgbG9ja2VkIFwiQmFja2dyb3VuZFwiIHJvdyBhbmQgaXMgTk9UXG4vLyBzdG9yZWQgaGVyZS4gYGhpZGRlbmAgZG91YmxlcyBhcyB0aGUgYWdlbnQtaGFuZG9mZiBmaWx0ZXI6IGhpZGRlbiBsYXllcnMgZG9uJ3Rcbi8vIHJlbmRlciwgc28gdGhleSBkb24ndCBmbGF0dGVuLCBzbyB0aGUgYWdlbnQgbmV2ZXIgcmVjZWl2ZXMgdGhlbS5cbmV4cG9ydCB0eXBlIExheWVyID0ge1xuICBpZDogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7IC8vIGVkaXRhYmxlOyB0aGUgcGFuZWwgbGFiZWxcbiAga2luZDogXCJhbm5vdGF0aW9uXCIgfCBcInNrZXRjaFwiIHwgXCJpbWFnZVwiOyAvLyBhdXRvLW5hbWUgKyBpY29uOyBcInNrZXRjaFwiIGFjY3JldGVzIHBlbiBzdHJva2VzXG4gIGhpZGRlbj86IGJvb2xlYW47XG4gIGxvY2tlZD86IGJvb2xlYW47XG59O1xuXG4vLyDilIDilIAgdGhlIHdob2xlIHN0YXRlIOKUgOKUgFxuXG5leHBvcnQgdHlwZSBJbWFnb1N0YXRlID0ge1xuICB0aXRsZTogc3RyaW5nO1xuICBiYXRjaGVzOiBCYXRjaFtdO1xuICBmb2N1czogRm9jdXMgfCBudWxsOyAvLyB0aGUgaW1hZ2Ugb24gdGhlIGNhbnZhcyAobnVsbCA9IGJsYW5rIFwibmV3XCIgZnJhbWUpXG4gIGNvbnZlcnNhdGlvbjogTWVzc2FnZVtdO1xuICBsaWJyYXJ5OiBDb250ZXh0RW50cnlbXTsgLy8gdGhlIHVuaWZpZWQsIHBhc3NpdmUgY29udGV4dCBjYXRhbG9nIChzdHlsZXMgKyBxdWljay1wcm9tcHRzOyBza2lsbC9jb250ZXh0IHJlc2VydmVkKVxuICBhY3RpdmVDb250ZXh0SWRzOiBzdHJpbmdbXTsgLy8gc3R5bGVzIGF0dGFjaGVkIHRvIHRoZSBORVhUIGdlbmVyYXRpb24gKHRoZSBhY3RpdmUtY29udGV4dCB0cmF5KVxuICBxdWlja1Byb21wdElkczogc3RyaW5nW107IC8vIHByb21wdHMgc3VyZmFjZWQgaW4gdGhlIGNvbXBvc2VyIHF1aWNrLXByb21wdHMgbGlzdCAoYSBjdXJhdGVkIHN1YnNldClcbiAgcGluczogUGluW107XG4gIG1hcmtzQnlWYXJpYW50OiBSZWNvcmQ8c3RyaW5nLCBNYXJrW10+OyAvLyBkdXJhYmxlIGFubm90YXRpb24gbWFya3MgcGVyIHZhcmlhbnQgaWRcbiAgLy8gQ09OVEFJTkVSIG1ldGFkYXRhIHBlciB2YXJpYW50OiBhbiBvcmRlcmVkIGxpc3Qgb2YgTGF5ZXJzIChiYWNr4oaSZnJvbnQpIHRoYXRcbiAgLy8gZ3JvdXAgdGhlIG1hcmtzIGFib3ZlLiBFYWNoIE1hcmsgY2FycmllcyBhIGBsYXllcklkYCBpbnRvIHRoaXMgbGlzdDsgZWZmZWN0aXZlXG4gIC8vIHogPSBsYXllciBvcmRlciwgdGhlbiBNYXJrLnpPcmRlciB3aXRoaW4gdGhlIGxheWVyLiBTZWUgdHlwZSBMYXllci5cbiAgbGF5ZXJzQnlWYXJpYW50OiBSZWNvcmQ8c3RyaW5nLCBMYXllcltdPjtcbiAgYW5hbHlzaXNDYWNoZTogUmVjb3JkPHN0cmluZywgc3RyaW5nPjsgLy8gaGFzaCDihpIgYWdlbnQgYW5hbHlzaXM7IHN1cnZpdmVzIGEgcmVmIGRlbGV0ZS9yZS1hZGQgKGRhZW1vbi1tYWludGFpbmVkKVxuICBhc3BlY3Q6IHN0cmluZzsgLy8gYXNwZWN0IHJhdGlvIGZvciBhIE5FVyAoZnJlc2gpIGdlbmVyYXRpb25cbiAgc2l6ZTogSW1hZ2VTaXplOyAvLyBvdXRwdXQgcmVzb2x1dGlvbiBmb3IgYSBORVcgZ2VuZXJhdGlvblxuICBzdGF0dXM6IHsgYnVzeTogYm9vbGVhbjsgdGV4dDogc3RyaW5nIH07XG4gIGNvc3Q6IHN0cmluZzsgLy8gcHJlLWZvcm1hdHRlZCBmb3IgZGlzcGxheSwgZS5nLiBcIiQwLjE4XCJcbiAgaGFuZG9mZjogc3RyaW5nOyAvLyBhZ2VudCBlc2NhbGF0ZWQgdG8gYSB0ZXJtaW5hbCBBc2tVc2VyUXVlc3Rpb24gKHByZXNlbmNlOiBhc2tpbmcpXG4gIC8vIHVuZG8vcmVkbyBhdmFpbGFiaWxpdHkgZm9yIHRoZSBGT0NVU0VEIHZhcmlhbnQncyBtYXJrIGVkaXRzIChzZXJ2ZXItZGVyaXZlZFxuICAvLyBmcm9tIGFuIGluLW1lbW9yeSwgcGVyLXZhcmlhbnQgaGlzdG9yeTsgc2l0dWF0aW9uYWwsIG5vdCBwZXJzaXN0ZWQpLiBMZXRzIHRoZVxuICAvLyB0b29sYmFyIGVuYWJsZS9kaXNhYmxlIHRoZSBidXR0b25zLlxuICBoaXN0b3J5OiB7IGNhblVuZG86IGJvb2xlYW47IGNhblJlZG86IGJvb2xlYW4gfTtcbiAgLy8gT05FIGZyZXNobmVzcyBzaWduYWwgc2hhcmVkIGJ5IGJvdGggY2hhbm5lbHM6IHRydWUgd2hlbiB0aGUgRk9DVVNFRCBpbWFnZSBoYXNcbiAgLy8gYW5ub3RhdGlvbiBjaGFuZ2VzIHRoZSBhZ2VudCBoYXNuJ3QgcmVjZWl2ZWQgeWV0LiBTZXQgb24gYW55IG1hcmsgZWRpdDtcbiAgLy8gY2xlYXJlZCB3aGVuIHRoZSBhZ2VudCBnZXRzIHRoZSBtYXJrZWQgaW1hZ2Ug4oCUIHZpYSB0aGUgY29tbWl0IGJ1dHRvbiBPUiBhIGNoYXRcbiAgLy8gbWVzc2FnZSB0aGF0IGNhcnJpZXMgaXQuIERyaXZlcyB0aGUgY29tbWl0IGJ1dHRvbiAoXCJUYWtlIG1hcmtzXCIgdnMgXCJTaGFyZWRcIilcbiAgLy8gYW5kIHRoZSBjaGF0LXNlbmQgYXV0by1hdHRhY2guIFNlcnZlci1kZXJpdmVkIGZvciB0aGUgZm9jdXNlZCB2YXJpYW50LlxuICBtYXJrc1Vuc2VlbjogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIEltYWdlU2l6ZSA9IFwiMUtcIiB8IFwiMktcIjtcbmV4cG9ydCBjb25zdCBBU1BFQ1RTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcIjE6MVwiLCBcIjM6MlwiLCBcIjI6M1wiLCBcIjE2OjlcIiwgXCI5OjE2XCJdIGFzIGNvbnN0O1xuZXhwb3J0IGNvbnN0IFNJWkVTOiByZWFkb25seSBJbWFnZVNpemVbXSA9IFtcIjFLXCIsIFwiMktcIl0gYXMgY29uc3Q7XG5cbi8vIFByZXNlbmNlIChcImFza2luZ1wiKSBpcyBERVJJVkVELCBub3QgYSBzdG9yZWQgZmxhZyDigJQgc28gaXQgY2FuJ3QgZHJpZnQgZnJvbSB0aGVcbi8vIHRocmVhZDogdGhlIGFnZW50IGlzIFwiYXNraW5nXCIgd2hlbiBgaGFuZG9mZmAgaXMgc2V0IE9SIHRoZSBsYXN0IG1lc3NhZ2UgaXMgYW5cbi8vIHVuYW5zd2VyZWQgcXVlc3Rpb24uIChIZWxwZXIgbGl2ZXMgaW4gdGhlIHN1cmZhY2UuKVxuXG4vLyDilIDilIAgU2VydmVyIOKGkiBicm93c2VyIChXZWJTb2NrZXQpLiBUaGUgYnJvd3NlciBoYW5kbGVzIGV4YWN0bHkgdGhlc2UuIOKUgOKUgFxuZXhwb3J0IHR5cGUgU2VydmVyVG9DbGllbnQgPVxuICB8IHsgdHlwZTogXCJzdGF0ZVwiOyBzdGF0ZTogSW1hZ29TdGF0ZSB9XG4gIHwgeyB0eXBlOiBcIm1lc3NhZ2VcIjsgdGV4dDogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwic3VibWl0XCIgfVxuICB8IHsgdHlwZTogXCJjYW5jZWxcIiB9O1xuXG4vLyDilIDilIAgQnJvd3NlciDihpIgc2VydmVyIChXZWJTb2NrZXQpLiBUaGUgY2xpZW50IHNlbmRzIGV4YWN0bHkgdGhlc2UuIOKUgOKUgFxuLy8gRWFjaCBlaXRoZXIgbXV0YXRlcyBzdGF0ZSAocmUtYnJvYWRjYXN0KSBhbmQvb3IgZW1pdHMgYW4gU1NFIGV2ZW50IHRoZSBhZ2VudFxuLy8gcmVhY3RzIHRvLiBUaGUgY29udmVyc2F0aW9uIGlzIHRoZSBwcmltYXJ5IGNoYW5uZWw7IGdlc3R1cmVzIGFyZSBmaXJzdC1jbGFzcy5cbmV4cG9ydCB0eXBlIENsaWVudFRvU2VydmVyID1cbiAgfCB7XG4gICAgICB0eXBlOiBcInNheVwiOyAvLyB1c2VyIHBvc3RzIGEgbWVzc2FnZSAvIGluc3RydWN0aW9uXG4gICAgICB0ZXh0OiBzdHJpbmc7XG4gICAgICAvLyB3aGVuIHRoZSBmb2N1c2VkIGltYWdlIGhhcyB1bnNlZW4gbWFya3MsIHRoZSBzdXJmYWNlIGZsYXR0ZW5zIGl0IGFuZFxuICAgICAgLy8gcmlkZXMgdGhlIG1hcmtlZCBpbWFnZSBhbG9uZyB3aXRoIHRoZSBtZXNzYWdlIChvbmUgZnJlc2huZXNzIHNpZ25hbCkuXG4gICAgICBmbGF0dGVuZWRTcmM/OiBzdHJpbmc7XG4gICAgfVxuICB8IHsgdHlwZTogXCJwcm9wb3NhbC5zZW5kXCI7IGlkOiBzdHJpbmcgfSAvLyBjb25maXJtIGEgcHJvbXB0IHByb3Bvc2FsIOKGkiBnZW5lcmF0ZVxuICB8IHsgdHlwZTogXCJwcm9wb3NhbC5kaXNtaXNzXCI7IGlkOiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJmb2N1cy5zZXRcIjsgYmF0Y2hJZDogc3RyaW5nOyB2YXJpYW50SWQ6IHN0cmluZyB9IC8vIGZvY3VzIGFuIGltYWdlXG4gIHwgeyB0eXBlOiBcImZvY3VzLmNsZWFyXCIgfSAvLyBiYWNrIHRvIGEgYmxhbmsgXCJuZXdcIiBmcmFtZVxuICB8IHsgdHlwZTogXCJ2YXJpYW50Lmxpa2VcIjsgaWQ6IHN0cmluZzsgbGlrZWQ6IGJvb2xlYW4gfVxuICB8IHsgdHlwZTogXCJ2YXJpYW50LnJlbW92ZVwiOyBiYXRjaElkOiBzdHJpbmc7IHZhcmlhbnRJZDogc3RyaW5nIH0gLy8gZGVsZXRlIGEgdmFyaWFudCBmcm9tIHRoZSBsaWJyYXJ5ICgrIGl0cyBtYXJrcy9sYXllcnM7IGRyb3BzIHRoZSBiYXRjaCB3aGVuIGVtcHR5KTsgYW1iaWVudCAobm8gYWdlbnQgZXZlbnQpXG4gIHwge1xuICAgICAgdHlwZTogXCJjb250ZXh0LmFkZFwiO1xuICAgICAga2luZDogQ29udGV4dEtpbmQ7XG4gICAgICBuYW1lOiBzdHJpbmc7XG4gICAgICBjb250ZW50OiBzdHJpbmc7XG4gICAgICB0YWdzPzogc3RyaW5nW107XG4gICAgICBpbWFnZT86IHN0cmluZztcbiAgICAgIGxpbms/OiBDb250ZXh0U2V0O1xuICAgIH1cbiAgfCB7IHR5cGU6IFwiY29udGV4dC51cGRhdGVcIjsgaWQ6IHN0cmluZzsgbmFtZT86IHN0cmluZzsgY29udGVudD86IHN0cmluZzsgdGFncz86IHN0cmluZ1tdIH1cbiAgfCB7IHR5cGU6IFwiY29udGV4dC5kZWxldGVcIjsgaWQ6IHN0cmluZyB9IC8vIHRoZSBPTkxZIGRlc3Ryb3kgKGd1YXJkZWQgYnkgYSBVSSBjb25maXJtKVxuICB8IHsgdHlwZTogXCJjb250ZXh0LmxpbmtcIjsgaWQ6IHN0cmluZzsgc2V0OiBDb250ZXh0U2V0IH0gLy8gYWRkIHRvIGEgbGlua2VkIHNldFxuICB8IHsgdHlwZTogXCJjb250ZXh0LnVubGlua1wiOyBpZDogc3RyaW5nOyBzZXQ6IENvbnRleHRTZXQgfSAvLyByZW1vdmUgZnJvbSBhIGxpbmtlZCBzZXQgKHRoZSBldmVyeWRheSDinJUpXG4gIHwgeyB0eXBlOiBcImNvbnRleHQuY2FwdHVyZVwiIH0gLy8gY2FwdHVyZSBhIHN0eWxlIGZyb20gdGhlIGZvY3VzZWQgaW1hZ2VcbiAgfCB7IHR5cGU6IFwicGluLmFkZFwiOyBrZXk6IHN0cmluZzsgdmFsdWU6IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcInBpbi5yZW1vdmVcIjsga2V5OiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJyZWYuYWRkXCI7IGltYWdlOiB7IHNyYzogc3RyaW5nOyBuYW1lPzogc3RyaW5nIH0gfSAvLyBpbXBvcnQgYW4gZXh0ZXJuYWwgaW1hZ2UgYXMgYSB2YXJpYW50ICsgc2VsZWN0IGl0IGFzIGEgcmVmIChkZWR1cCBieSBoYXNoIOKGkiBzZWxlY3RzIHRoZSBleGlzdGluZyBvbmUpXG4gIHwgeyB0eXBlOiBcInJlZi5yZW1vdmVcIjsgaWQ6IHN0cmluZyB9IC8vIERFU0VMRUNUIGEgdmFyaWFudCBhcyBhIHJlZiAoaXQgc3RheXMgaW4gdGhlIGxpYnJhcnk7IHRvIGRlbGV0ZSB0aGUgaW1hZ2UgdXNlIHZhcmlhbnQucmVtb3ZlKVxuICB8IHsgdHlwZTogXCJpbWFnZS5pbXBvcnRcIjsgaW1hZ2U6IHsgc3JjOiBzdHJpbmc7IG5hbWU/OiBzdHJpbmcgfSB9IC8vIGRyb3Agb24gY2FudmFzIOKGkiB3b3JraW5nIGltYWdlXG4gIHwge1xuICAgICAgLy8gZHJvcCBhbiBpbWFnZSBhcyBhIExBWUVSIG9udG8gdGhlIGZvY3VzZWQgaW1hZ2UgKGNvbGxhZ2UpIOKAlCBkaXN0aW5jdCBmcm9tXG4gICAgICAvLyBpbWFnZS5pbXBvcnQsIHdoaWNoIFJFUExBQ0VTLiBUaGUgY2xpZW50IHN1cHBsaWVzIHRoZSBmcmFjdGlvbi1zcGFjZSBib3hcbiAgICAgIC8vIChpdCBrbm93cyB0aGUgYmFzZSBpbWFnZSBib3ggKyB0aGUgZHJvcHBlZCBiaXRtYXAncyBhc3BlY3QpOyB0aGUgc2VydmVyXG4gICAgICAvLyBvcHRpbWl6ZXMgdGhlIHNyYyArIHN0b3JlcyBpdC4gR2VvbWV0cnkgb3B0aW9uYWwg4oaSIHNlcnZlciBjZW50ZXJzIGEgNDAlIGJveC5cbiAgICAgIHR5cGU6IFwibGF5ZXIuYWRkSW1hZ2VcIjtcbiAgICAgIHNyYzogc3RyaW5nO1xuICAgICAgbmFtZT86IHN0cmluZztcbiAgICAgIHg/OiBudW1iZXI7XG4gICAgICB5PzogbnVtYmVyO1xuICAgICAgdz86IG51bWJlcjtcbiAgICAgIGg/OiBudW1iZXI7XG4gICAgfVxuICAvLyDilIDilIAgbGF5ZXIgKGNvbnRhaW5lcikgb3BzIOKAlCBQaGFzZSAyIGluc3BlY3RvciBwYW5lbC4gQWxsIHNlcnZlci1hdXRob3JpdGF0aXZlXG4gIC8vIGFuZCB1bmRvYWJsZSB2aWEgdGhlIHdpZGVuZWQge21hcmtzLGxheWVyc30gaGlzdG9yeTsgbG9jYWwgdW50aWwgY29tbWl0ICh0aGVcbiAgLy8gZmxhdHRlbiByZXNwZWN0cyBgaGlkZGVuYCksIHNvIG5vIGFnZW50IGV2ZW50IOKAlCBzYW1lIHJ1bGUgYXMgbWFyay4qIG9wcy5cbiAgfCB7IHR5cGU6IFwibGF5ZXIuYWRkXCI7IG5hbWU/OiBzdHJpbmc7IGtpbmQ/OiBMYXllcltcImtpbmRcIl0gfSAvLyBibGFuayBsYXllciBvbiB0b3BcbiAgfCB7IHR5cGU6IFwibGF5ZXIucmVuYW1lXCI7IGlkOiBzdHJpbmc7IG5hbWU6IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcImxheWVyLnNldEhpZGRlblwiOyBpZDogc3RyaW5nOyBoaWRkZW46IGJvb2xlYW4gfSAvLyB2aXNpYmlsaXR5ICsgaGFuZG9mZiBmaWx0ZXJcbiAgfCB7IHR5cGU6IFwibGF5ZXIuc2V0TG9ja2VkXCI7IGlkOiBzdHJpbmc7IGxvY2tlZDogYm9vbGVhbiB9IC8vIG5vdCBoaXQtdGVzdGFibGUgLyBzZWxlY3RhYmxlXG4gIHwgeyB0eXBlOiBcImxheWVyLnJlb3JkZXJcIjsgaWQ6IHN0cmluZzsgdG9JbmRleDogbnVtYmVyIH0gLy8gYWJzb2x1dGUgcGxhY2VtZW50IChkcmFnLWRyb3ApXG4gIHwgeyB0eXBlOiBcImxheWVyLnJlbW92ZVwiOyBpZDogc3RyaW5nIH0gLy8gZGVsZXRlcyB0aGUgbGF5ZXIgQU5EIGl0cyBlbGVtZW50c1xuICB8IHsgdHlwZTogXCJncm91cFwiOyBtYXJrSWRzOiBzdHJpbmdbXTsgbmFtZT86IHN0cmluZyB9IC8vIHdyYXAgc2VsZWN0ZWQgbWFya3MgaW4gYSBuZXcgbGF5ZXJcbiAgfCB7IHR5cGU6IFwidW5ncm91cFwiOyBpZDogc3RyaW5nIH0gLy8gZGlzc29sdmUg4oaSIGVhY2ggZWxlbWVudCBiZWNvbWVzIGl0cyBvd24gZ3JvdXAtb2Ytb25lIGxheWVyXG4gIC8vIE5PVEU6IHRoZXJlIGlzIG5vIGBsYXllci5zZXRBY3RpdmVgIOKAlCB0aGUgYWN0aXZlIGxheWVyICh3aGVyZSBuZXcgbWFya3MgZHJvcClcbiAgLy8gaXMgc3VyZmFjZS1vd25lZC4gVGhlIGNsaWVudCBzdGFtcHMgYG1hcmsubGF5ZXJJZGAgb24gbWFyay5hZGQ7IHRoZSBzZXJ2ZXJcbiAgLy8gaG9ub3JzIGEgdmFsaWQgb25lLCBlbHNlIGRyb3BzIGludG8gdGhlIHRvcG1vc3Qgbm9uLWltYWdlIGxheWVyLlxuICB8IHsgdHlwZTogXCJyZWYuc2VsZWN0XCI7IGlkOiBzdHJpbmc7IHNlbGVjdGVkOiBib29sZWFuIH0gLy8gcG9pbnQgYSBWQVJJQU5UIGF0IHRoZSBuZXh0IGdlbiAoaWQgPSB2YXJpYW50SWQ7IHRvZ2dsZXMgcmVmU2VsZWN0ZWQpXG4gIHwgeyB0eXBlOiBcIm1hcmsuYWRkXCI7IG1hcms6IE1hcmsgfSAvLyBsb2NhbC1pc2g7IG5vIGFnZW50IGV2ZW50IHVudGlsIGNvbW1pdCAoc2VydmVyIGFzc2lnbnMgek9yZGVyOyBob25vcnMgYSB2YWxpZCBtYXJrLmxheWVySWQgYXMgdGhlIGFjdGl2ZSBsYXllciwgZWxzZSB0b3Btb3N0IG5vbi1pbWFnZSBsYXllcilcbiAgfCB7IHR5cGU6IFwibWFyay5yZW1vdmVcIjsgaWQ6IHN0cmluZyB9IC8vIGRlbGV0ZSBvbmUgbWFyayAoY29tcGxlbWVudHMgbWFya3MuY2xlYXIpXG4gIHwge1xuICAgICAgLy8gbW92ZS9yZXNpemUvbGFiZWwgKHNlcnZlciBtZXJnZXM7IG5ldmVyIGlkL3Rvb2wvek9yZGVyKS4gVmFsdWVzIGFyZVxuICAgICAgLy8gc2NhbGFycyAoZ2VvbWV0cnkvbGFiZWwvc3R5bGUpIG9yIGEgZHJhdyBtYXJrJ3Mgd2hvbGUgYHBvaW50c2AgYXJyYXkuXG4gICAgICB0eXBlOiBcIm1hcmsudXBkYXRlXCI7XG4gICAgICBpZDogc3RyaW5nO1xuICAgICAgcGF0Y2g6IFJlY29yZDxzdHJpbmcsIG51bWJlciB8IHN0cmluZyB8IHsgeDogbnVtYmVyOyB5OiBudW1iZXIgfVtdPjtcbiAgICB9XG4gIHwge1xuICAgICAgdHlwZTogXCJtYXJrLnJlb3JkZXJcIjtcbiAgICAgIGlkOiBzdHJpbmc7XG4gICAgICBkaXJlY3Rpb246IFwiZm9yd2FyZFwiIHwgXCJiYWNrXCIgfCBcImZyb250XCIgfCBcImJhY2stbW9zdFwiO1xuICAgIH0gLy8gei1vcmRlclxuICB8IHsgdHlwZTogXCJtYXJrcy5jbGVhclwiIH1cbiAgfCB7IHR5cGU6IFwibWFya3MucmVwbGFjZVwiOyBtYXJrczogTWFya1tdIH0gLy8gc3dhcCB0aGUgZm9jdXNlZCBpbWFnZSdzIG1hcmtzIHdob2xlc2FsZSAob25lIGhpc3Rvcnkgc3RlcCkg4oCUIHVzZWQgYnkgdGhlIHBlbiBlcmFzZXIsIHdoaWNoIHRyaW1zL3NwbGl0cyBzdHJva2VzXG4gIHwgeyB0eXBlOiBcInVuZG9cIiB9IC8vIHN0ZXAgdGhlIGZvY3VzZWQgaW1hZ2UncyBtYXJrIGhpc3RvcnkgYmFja1xuICB8IHsgdHlwZTogXCJyZWRvXCIgfSAvLyBzdGVwIGl0IGZvcndhcmRcbiAgfCB7XG4gICAgICB0eXBlOiBcIm1hcmtzLmNvbW1pdFwiOyAvLyBcInRha2UgbWFya3MgdG8gdGhlIGNvbnZlcnNhdGlvbiDihpJcIlxuICAgICAgdGV4dDogc3RyaW5nO1xuICAgICAgYmF0Y2hJZDogc3RyaW5nO1xuICAgICAgdmFyaWFudElkOiBzdHJpbmc7XG4gICAgICBmbGF0dGVuZWRTcmM/OiBzdHJpbmc7IC8vIGRhdGEtdXJsIFBORzogdGhlIGltYWdlIHdpdGggbWFya3MgYnVybmVkIGluICh0aGUgdmlzdWFsIGhhbmRvZmYpLiBPcHRpb25hbCDigJQgY2FwdHVyZSBpcyBiZXN0LWVmZm9ydC5cbiAgICB9XG4gIHwgeyB0eXBlOiBcImFzcGVjdC5zZXRcIjsgYXNwZWN0OiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJzaXplLnNldFwiOyBzaXplOiBJbWFnZVNpemUgfVxuICB8IHsgdHlwZTogXCJzdWJtaXRcIiB9XG4gIHwgeyB0eXBlOiBcImNhbmNlbFwiIH07XG5cbi8vIOKUgOKUgCBBZ2VudCDihpIgc2VydmVyIChQT1NUIC9jbWQpLiBUaGUgYWdlbnQgZHJpdmVzIHRoZSBkYWVtb24gd2l0aCBleGFjdGx5IHRoZXNlLiDilIDilIBcbmV4cG9ydCB0eXBlIEFnZW50Q29tbWFuZCA9XG4gIHwgeyB0eXBlOiBcImluaXRcIjsgdGl0bGU/OiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJzYXlcIjsgdGV4dDogc3RyaW5nIH0gLy8gcG9zdCBhZ2VudCBkaWFsb2d1ZSAoa2luZDpcInRleHRcIilcbiAgfCB7IHR5cGU6IFwicHJvcG9zZVwiOyBwcm9tcHQ6IHN0cmluZzsgbj86IG51bWJlciB9IC8vIHBvc3QgYSBwcm9tcHQgcHJvcG9zYWxcbiAgfCB7IHR5cGU6IFwiYXNrXCI7IHRleHQ6IHN0cmluZzsgb3B0aW9ucz86IHN0cmluZ1tdIH0gLy8gcG9zdCBhbiBpbi10aHJlYWQgcXVlc3Rpb25cbiAgfCB7XG4gICAgICAvLyBhZGQgYSBwcm9kdWNlZCBiYXRjaCArIChhdXRvKSBhIFwicmVzdWx0XCIgbWVzc2FnZSBhbm5vdW5jaW5nIGl0XG4gICAgICB0eXBlOiBcImJhdGNoLmFkZFwiO1xuICAgICAga2luZDogXCJnZW5lcmF0ZVwiIHwgXCJlZGl0XCI7XG4gICAgICBwcm9tcHQ6IHN0cmluZztcbiAgICAgIHRhZz86IHN0cmluZztcbiAgICAgIGVkaXRlZEZyb21WYXJpYW50SWQ/OiBzdHJpbmc7XG4gICAgICBzdW1tYXJ5Pzogc3RyaW5nOyAvLyB0aGUgcmVzdWx0IG1lc3NhZ2UgdGV4dFxuICAgICAgdmFyaWFudHM6IHsgc3JjOiBzdHJpbmc7IHNlZWQ/OiBudW1iZXI7IG1vZGVsPzogc3RyaW5nOyBpZD86IHN0cmluZyB9W107XG4gICAgfVxuICB8IHsgdHlwZTogXCJmb2N1c1wiOyBiYXRjaElkOiBzdHJpbmc7IHZhcmlhbnRJZDogc3RyaW5nIH0gLy8gYWdlbnQgZm9jdXNlcyBhbiBpbWFnZVxuICB8IHsgdHlwZTogXCJyZWYuc2VsZWN0XCI7IGlkOiBzdHJpbmc7IHNlbGVjdGVkOiBib29sZWFuIH0gLy8gYWdlbnQgcG9pbnRzIGEgdmFyaWFudCBhdCB0aGUgbmV4dCBnZW4gKGlkID0gdmFyaWFudElkOyB0aGUgdXNlciBzZWVzIGl0IGhpZ2hsaWdodClcbiAgLy8gKHJlZi5hbmFseXplIHJlbW92ZWQg4oCUIHdyaXRlIGEgcmVhZCBvbnRvIGFueSBpbWFnZSB2aWEgdmFyaWFudC5hbmFseXplOyByZWZzIGFyZSB2YXJpYW50cyBub3cpXG4gIHwgeyB0eXBlOiBcInZhcmlhbnQuYW5hbHl6ZVwiOyBpZDogc3RyaW5nOyB0ZXh0OiBzdHJpbmcgfSAvLyB3cml0ZSB5b3VyIHJlYWQgb250byBhIGdlbmVyYXRlZC9pbXBvcnRlZCBpbWFnZVxuICB8IHtcbiAgICAgIHR5cGU6IFwiY29udGV4dC5hZGRcIjtcbiAgICAgIGtpbmQ6IENvbnRleHRLaW5kO1xuICAgICAgbmFtZTogc3RyaW5nO1xuICAgICAgY29udGVudDogc3RyaW5nO1xuICAgICAgdGFncz86IHN0cmluZ1tdO1xuICAgICAgaW1hZ2U/OiBzdHJpbmc7XG4gICAgICBsaW5rPzogQ29udGV4dFNldDtcbiAgICB9XG4gIHwgeyB0eXBlOiBcInN0YXR1c1wiOyBidXN5OiBib29sZWFuOyB0ZXh0Pzogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwiY29zdFwiOyB0ZXh0OiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJoYW5kb2ZmXCI7IHRleHQ6IHN0cmluZyB9IC8vIFwiXCIgY2xlYXJzICh0ZXJtaW5hbC1hc2sgZXNjYXBlKVxuICB8IHsgdHlwZTogXCJjbG9zZVwiIH07XG5cbi8vIFRoZSBhZ2VudCBldmVudCBzZXQgKHNlcnZlciDihpIgYWdlbnQgU1NFKSDigJQgSU1QRVJBVElWRVMgT05MWTogdGhlIG1vdmVzIHdoZXJlXG4vLyB0aGUgdXNlciBpcyBhc2tpbmcgdGhlIGFnZW50IGZvciBzb21ldGhpbmcgb3IgaGFuZGluZyB3b3JrIG9mZiwgcGx1cyBsaWZlY3ljbGUuXG4vLyBUaGUgYWdlbnQgcmVhY3RzIHRvIHRoZXNlLlxuLy9cbi8vIEFNQklFTlQgQk9BUkQgU1RBVEUgaXMgZGVsaWJlcmF0ZWx5IE5PVCBoZXJlIOKAlCBmb2N1cywgcmVmIHNlbGVjdGlvbiwgbGlrZXMsXG4vLyBzdHlsZSB0b2dnbGVzLCBhc3BlY3Qvc2l6ZSwgcGlucywgcmVmLWxpYnJhcnkgYWRkcywgaW1hZ2UgaW1wb3J0cy4gVGhvc2UgYXJlXG4vLyBwaWVjZXMgbW92aW5nIG9uIHRoZSBib2FyZDsgdGhlIGFnZW50IFJFQURTIHRoZW0gZnJvbSAvc3RhdGUgd2hlbiBpdCdzIGl0cyBtb3ZlLFxuLy8gaXQgZG9lcyBub3QgZ2V0IHBpbmdlZCBvbiBldmVyeSB0b2dnbGUgKHRoYXQgd2FzIGp1c3Qgbm9pc2UpLiBUbyBtYWtlIHRoYXQgc2FmZSxcbi8vIHRoZSBpbXBlcmF0aXZlcyB0aGF0IGFyZSBcImFib3V0IGFuIGltYWdlXCIgY2FycnkgdGhlaXIgYm9hcmQgY29udGV4dDogYHNheWAgYW5kXG4vLyBgbWFya3MuY29tbWl0YCByaWRlIHRoZSBmb2N1c2VkIHZhcmlhbnQgKyBzZWxlY3RlZCByZWYgaWRzOyBgY29udGV4dC5jYXB0dXJlYFxuLy8gcmlkZXMgdGhlIGZvY3VzLiBJbmNyZW1lbnRhbCBhbm5vdGF0aW9uIChtYXJrLmFkZC9tYXJrcy5jbGVhcikgaXMgbGlrZXdpc2UgTk9UXG4vLyBoZXJlIOKAlCB0aGUgYWdlbnQgcmVhY3RzIHdoZW4gdGhlIHVzZXIgQ09NTUlUUyBtYXJrcywgbm90IG9uIGV2ZXJ5IHN0cm9rZS5cbmV4cG9ydCBjb25zdCBBR0VOVF9FVkVOVF9UWVBFUyA9IE9iamVjdC5mcmVlemUoW1xuICBcInJlYWR5XCIsXG4gIFwiY29ubmVjdGVkXCIsXG4gIFwiZGlzY29ubmVjdGVkXCIsXG4gIFwic2F5XCIsXG4gIFwicHJvcG9zYWwuc2VuZFwiLFxuICBcInByb3Bvc2FsLmRpc21pc3NcIixcbiAgXCJjb250ZXh0LmNhcHR1cmVcIixcbiAgXCJtYXJrcy5jb21taXRcIixcbiAgXCJzdWJtaXRcIixcbiAgXCJjbG9zZWRcIixcbl0gYXMgY29uc3QpO1xuZXhwb3J0IHR5cGUgQWdlbnRFdmVudFR5cGUgPSAodHlwZW9mIEFHRU5UX0VWRU5UX1RZUEVTKVtudW1iZXJdO1xuXG4vLyBUeXBlZCBwYXlsb2FkcyBmb3IgdGhlIGV2ZW50cyB0aGF0IGNhcnJ5IGRhdGEg4oCUIHNvIHRoZSBhZ2VudCBpc24ndCBndWVzc2luZ1xuLy8gc2hhcGVzIGFuZCB0aGUgc2VydmVyJ3MgZW1pdCBjYWxscyBhcmUgY2hlY2tlZC4gRXZlbnRzIG5vdCBsaXN0ZWQgY2Fycnkgbm9cbi8vIHBheWxvYWQuXG5leHBvcnQgdHlwZSBBZ2VudEV2ZW50UGF5bG9hZCA9IHtcbiAgLy8gYSBjaGF0IG1lc3NhZ2UuIEl0IGNhcnJpZXMgdGhlIEFNQklFTlQgQk9BUkQgQ09OVEVYVCBzbyB0aGUgYWdlbnQgZG9lc24ndCBuZWVkXG4gIC8vIHRoZSAobm93LXJlbW92ZWQpIGZvY3VzLnNldC9yZWYuc2VsZWN0IHBpbmdzOiBgZm9jdXNgIGlzIHRoZSBpbWFnZSBvbiB0aGVcbiAgLy8gY2FudmFzIHdoZW4gdGhlIHVzZXIgc2VudCAobnVsbCA9IGJsYW5rIGZyYW1lKSwgYHNlbGVjdGVkUmVmSWRzYCB0aGUgcmVmcyB0aGVcbiAgLy8gdXNlciBwb2ludGVkIGF0IGZvciB0aGlzIHR1cm4uIElmIHRoZSBmb2N1c2VkIGltYWdlIGhhZCB1bnNlZW4gbWFya3MsIHRoZVxuICAvLyBtYXJrZWQgaW1hZ2UgKGZsYXR0ZW5lZEltYWdlUGF0aCwgLS1yZWYgaXQpICsgdGhlIG1hcmsgZ2VvbWV0cnkgcmlkZSBhbG9uZyB0b28uXG4gIHNheToge1xuICAgIHRleHQ6IHN0cmluZztcbiAgICBmb2N1czogRm9jdXMgfCBudWxsO1xuICAgIHNlbGVjdGVkUmVmSWRzOiBzdHJpbmdbXTtcbiAgICBmbGF0dGVuZWRJbWFnZVBhdGg/OiBzdHJpbmc7XG4gICAgbWFya3M/OiBNYXJrW107XG4gIH07XG4gIFwicHJvcG9zYWwuc2VuZFwiOiB7IGlkOiBzdHJpbmcgfTtcbiAgXCJwcm9wb3NhbC5kaXNtaXNzXCI6IHsgaWQ6IHN0cmluZyB9O1xuICAvLyBcImV4dHJhY3QgdGhpcyBpbWFnZSdzIGxvb2tcIiDigJQgY2FycmllcyB0aGUgZm9jdXNlZCB2YXJpYW50IHNvIHRoZSBhZ2VudCBrbm93c1xuICAvLyB3aGljaCBpbWFnZSB0byByZWFkIChmb2N1cy5zZXQgbm8gbG9uZ2VyIG5vdGlmaWVzKS5cbiAgXCJjb250ZXh0LmNhcHR1cmVcIjogeyBmb2N1czogRm9jdXMgfCBudWxsIH07XG4gIFwibWFya3MuY29tbWl0XCI6IHtcbiAgICB0ZXh0OiBzdHJpbmc7XG4gICAgYmF0Y2hJZDogc3RyaW5nO1xuICAgIHZhcmlhbnRJZDogc3RyaW5nO1xuICAgIG1hcmtzOiBNYXJrW107XG4gICAgc2VsZWN0ZWRSZWZJZHM6IHN0cmluZ1tdOyAvLyByZWZzIHRoZSB1c2VyIHBvaW50ZWQgYXQgKGFtYmllbnQgYm9hcmQgY29udGV4dClcbiAgICAvLyBvbi1kaXNrIFBORyBwYXRoIG9mIHRoZSBpbWFnZSB3aXRoIG1hcmtzIGJ1cm5lZCBpbiAodGhlIHZpc3VhbCBoYW5kb2ZmIOKAlFxuICAgIC8vIHBhc3MgYXMgLS1yZWYpLiBBYnNlbnQgaWYgY2FwdHVyZSBmYWlsZWQ7IGZhbGwgYmFjayB0byB0aGUgdmFyaWFudCBwYXRoLlxuICAgIGZsYXR0ZW5lZEltYWdlUGF0aD86IHN0cmluZztcbiAgfTtcbn07XG5cbmNvbnN0IERFRkFVTFRfU1RZTEVfTkFNRVMgPSBbXCJhbmltZVwiLCBcInBhaW50ZXJseVwiLCBcInBob3RvcmVhbFwiLCBcIjNkXCIsIFwid2F0ZXJjb2xvclwiLCBcImxpbmUgYXJ0XCJdO1xuLy8gZGV0ZXJtaW5pc3RpYywgcmVwcm9kdWNpYmxlIGlkIHNvIHNlZWRpbmcvcmVzdG9yZSBkb24ndCBjaHVybiBpZHNcbmV4cG9ydCBjb25zdCBzdHlsZUlkID0gKG5hbWU6IHN0cmluZykgPT4gYHN0eWxlLSR7bmFtZS50cmltKCkudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9cXHMrL2csIFwiLVwiKX1gO1xuXG5jb25zdCBERUZBVUxUX1BST01QVFM6IENvbnRleHRFbnRyeVtdID0gW1xuICB7XG4gICAgaWQ6IFwiZGVzY3JpYmVcIixcbiAgICBraW5kOiBcInByb21wdFwiLFxuICAgIG5hbWU6IFwiZGVzY3JpYmVcIixcbiAgICBjb250ZW50OiBcIkRlc2NyaWJlIHRoaXMgaW1hZ2UgaW4gZGV0YWlsIOKAlCBsaXRlcmFsbHkgd2hhdCBpcyBpbiBpdC5cIixcbiAgfSxcbiAge1xuICAgIGlkOiBcInBhbGV0dGVcIixcbiAgICBraW5kOiBcInByb21wdFwiLFxuICAgIG5hbWU6IFwicGFsZXR0ZVwiLFxuICAgIGNvbnRlbnQ6IFwiQnJlYWsgZG93biB0aGUgY29sb3IgcGFsZXR0ZSDigJQgdGhlIGtleSBjb2xvcnMgYW5kIGhvdyB0aGV5IHdvcmsgdG9nZXRoZXIuXCIsXG4gIH0sXG4gIHtcbiAgICBpZDogXCJsaWdodGluZ1wiLFxuICAgIGtpbmQ6IFwicHJvbXB0XCIsXG4gICAgbmFtZTogXCJsaWdodGluZ1wiLFxuICAgIGNvbnRlbnQ6IFwiRGVzY3JpYmUgdGhlIGxpZ2h0aW5nIOKAlCBkaXJlY3Rpb24sIHF1YWxpdHksIG1vb2Qg4oCUIHNvIEkgY2FuIHJldXNlIGl0LlwiLFxuICB9LFxuXTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRlZmF1bHRTdGF0ZSh0aXRsZTogc3RyaW5nKTogSW1hZ29TdGF0ZSB7XG4gIHJldHVybiB7XG4gICAgdGl0bGUsXG4gICAgYmF0Y2hlczogW10sXG4gICAgZm9jdXM6IG51bGwsXG4gICAgY29udmVyc2F0aW9uOiBbXSxcbiAgICBsaWJyYXJ5OiBbXG4gICAgICAuLi5ERUZBVUxUX1BST01QVFMubWFwKChwKSA9PiAoeyAuLi5wIH0pKSxcbiAgICAgIC4uLkRFRkFVTFRfU1RZTEVfTkFNRVMubWFwKChuYW1lKSA9PiAoe1xuICAgICAgICBpZDogc3R5bGVJZChuYW1lKSxcbiAgICAgICAga2luZDogXCJzdHlsZVwiIGFzIGNvbnN0LFxuICAgICAgICBuYW1lLFxuICAgICAgICBjb250ZW50OiBcIlwiLFxuICAgICAgfSkpLFxuICAgIF0sXG4gICAgYWN0aXZlQ29udGV4dElkczogW10sXG4gICAgcXVpY2tQcm9tcHRJZHM6IERFRkFVTFRfUFJPTVBUUy5tYXAoKHApID0+IHAuaWQpLFxuICAgIHBpbnM6IFtdLFxuICAgIG1hcmtzQnlWYXJpYW50OiB7fSxcbiAgICBsYXllcnNCeVZhcmlhbnQ6IHt9LFxuICAgIGFuYWx5c2lzQ2FjaGU6IHt9LFxuICAgIGFzcGVjdDogXCIxOjFcIixcbiAgICBzaXplOiBcIjFLXCIsXG4gICAgc3RhdHVzOiB7IGJ1c3k6IGZhbHNlLCB0ZXh0OiBcIlwiIH0sXG4gICAgY29zdDogXCJcIixcbiAgICBoYW5kb2ZmOiBcIlwiLFxuICAgIGhpc3Rvcnk6IHsgY2FuVW5kbzogZmFsc2UsIGNhblJlZG86IGZhbHNlIH0sXG4gICAgbWFya3NVbnNlZW46IGZhbHNlLFxuICB9O1xufVxuIiwKICAgICIvKipcbiAqIFRoZSB0d28gcHJpbWl0aXZlcyB1bmRlciBCT1RIIG9mIHRoZSBob3VzZSdzIGRhZW1vbi1kaXNjb3ZlcnkgY29udmVudGlvbnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBEMyBydWxlZCB0aGF0IHRoZSBjb252ZW50aW9ucyB0aGVtc2VsdmVzIOKAlCBwZXItc2Vzc2lvbiB0bXBkaXIgSlNPTiAoYm91bnR5LFxuICogZ2xhbW91ciwgaW1hZ28sIG1hZ3BpZSkgYW5kIHNpbmdsZXRvbiBgJEhPTUUvZGFlbW9uLnBvcnRgICsgYGRhZW1vbi5waWRgXG4gKiAoYXN0cm9sYWJlLCBncmFwZXZpbmUsIG1pbmQtbWFwcGVyKSDigJQgYm90aCBzdXJ2aXZlLCBiZWNhdXNlIHRoZXkgZW5jb2RlXG4gKiBnZW51aW5lbHkgZGlmZmVyZW50IG1vZGVscyAoY29uY3VycmVudCBzZXNzaW9ucyB2cyBhIHN0YW5kaW5nIHNpbmdsZXRvbikgYW5kXG4gKiBwaWNraW5nIG9uZSBpcyBhIHByb2R1Y3QgZGVjaXNpb24sIG5vdCBhIGZhY3RvcmluZyBvbmUuIFdoYXQgSVMgb25lXG4gKiBpbXBsZW1lbnRhdGlvbiBpcyB0aGUgcGFpciBiZWxvdywgd2hpY2ggaXMgYWxzbyBleGFjdGx5IHdoZXJlIGNlbnN1cyBkZWZlY3RcbiAqICoqTDMqKiBsaXZlcy5cbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMsIHJlbmFtZVN5bmMsIHJtU3luYywgdW5saW5rU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5cbi8qKlxuICogV3JpdGUgYHRleHRgIHRvIGB0YXJnZXRgIGF0b21pY2FsbHk6IHdyaXRlIGJlc2lkZSBpdCwgdGhlbiByZW5hbWUuXG4gKlxuICog4puUICoqTDMsIENMT1NFRCBCWSBDT05TVFJVQ1RJT04uKiogQSBiYXJlIGB3cml0ZUZpbGVTeW5jYCBpcyBub3QgYXRvbWljLCBzbyBhXG4gKiBDTEkgcmVhZGluZyB3aGlsZSB0aGUgZGFlbW9uIHdyaXRlcyBjYW4gb2JzZXJ2ZSBhIEhBTEYtV1JJVFRFTiBwb2ludGVyLiBVbmRlclxuICogYSBiZXN0LWVmZm9ydCByZWFkZXIgdGhhdCBzdXJmYWNlZCBhcyBcIm5vIHJ1bm5pbmcgc2Vzc2lvblwiIOKAlCBhYnNlbmNlIHJlcG9ydGVkXG4gKiBmb3Igd2hhdCB3YXMgcmVhbGx5IGEgdG9ybiByZWFkLCB3aGljaCBpcyB0aGUgZXhhY3QgY29uZmxhdGlvbiB0aGUgaG91c2Unc1xuICogYG51bGxgLW5vdC1gMGAgcnVsZSBleGlzdHMgdG8gcHJldmVudC4gUmVuYW1lIHdpdGhpbiBvbmUgZGlyZWN0b3J5IGlzIGF0b21pYyxcbiAqIHNvIGEgcmVhZGVyIHNlZXMgZWl0aGVyIHRoZSBwcmV2aW91cyBwb2ludGVyIG9yIHRoZSBuZXcgb25lLCBuZXZlciBhIHBhcnRpYWxcbiAqIGZpbGUuXG4gKlxuICogRml4ZWQgaW4gZ2xhbW91ciAyMDI2LTA5LTA3LCBmb3VuZCBzdGFuZGluZyBpbiB0aHJlZSBzaWJsaW5ncyB0aGUgbmV4dCBkYXkgYnlcbiAqIHRoZSBkdXBsaWNhdGlvbiByZWNvbiwgYW5kIHJlcGFpcmVkIGluIGFsbCBvZiB0aGVtIHRoZSBvbmx5IHdheSB0aGF0IGRvZXMgbm90XG4gKiBuZWVkIGZpbmRpbmcgYWdhaW46IHRoZXJlIGlzIG5vdyBvbmUgaW1wbGVtZW50YXRpb24uXG4gKlxuICog4pqgIFRoZSB0ZW1wIG5hbWUgY2FycmllcyB0aGUgcGlkLCBzbyB0d28gZGFlbW9ucyByYWNpbmcgdG8gcHVibGlzaCB0aGUgc2FtZVxuICogcG9pbnRlciBjYW5ub3QgY2xvYmJlciBlYWNoIG90aGVyJ3MgaW50ZXJtZWRpYXRlIGZpbGUg4oCUIGFuZCBpdCBpcyByZW1vdmVkIG9uXG4gKiBhIGZhaWxlZCB3cml0ZSByYXRoZXIgdGhhbiBsZWZ0IGFzIGxpdHRlciBiZXNpZGUgdGhlIHJlYWwgb25lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd3JpdGVGaWxlQXRvbWljKHRhcmdldDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgdG1wID0gYCR7dGFyZ2V0fS4ke3Byb2Nlc3MucGlkfS50bXBgO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmModG1wLCB0ZXh0KTtcbiAgICByZW5hbWVTeW5jKHRtcCwgdGFyZ2V0KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgdHJ5IHtcbiAgICAgIHJtU3luYyh0bXAsIHsgZm9yY2U6IHRydWUgfSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiB0aGUgdGVtcCBmaWxlIGlzIGFscmVhZHkgZ29uZSwgb3Igd2FzIG5ldmVyIGNyZWF0ZWQgKi9cbiAgICB9XG4gICAgdGhyb3cgZXJyO1xuICB9XG59XG5cbi8qKlxuICogRGVsZXRlIGBwYXRoYCBpZmYgaXQgc3RpbGwgbmFtZXMgVVMuIFJldHVybnMgd2hldGhlciBpdCB3YXMgZGVsZXRlZC5cbiAqXG4gKiDim5QgKipcIlNUSUxMIE9VUlNcIiBJUyBUSEUgV0hPTEUgRlVOQ1RJT04uKiogQSBkYWVtb24gdGhhdCB1bmxpbmtzIGl0cyBkaXNjb3ZlcnlcbiAqIGZpbGUgdW5jb25kaXRpb25hbGx5IGF0IGV4aXQgZGVsZXRlcyB0aGUgcG9pbnRlciBhIFNVQ0NFU1NPUiBoYXMgYWxyZWFkeVxuICogd3JpdHRlbiDigJQgdGhlIHN1Y2Nlc3NvciBjYW4gdGhlbiBubyBsb25nZXIgYmUgZm91bmQgYW5kIHRoZSBuZXh0IENMSSB2ZXJiIHNwYXducyBhXG4gKiB0aGlyZCBkYWVtb24uIEJvdGggY29udmVudGlvbnMgaGF2ZSB0aGlzIGhhemFyZCBhbmQgYm90aCBleHByZXNzIGl0XG4gKiBkaWZmZXJlbnRseTogYXN0cm9sYWJlIGNvbXBhcmVzIHRoZSBwaWQgZmlsZSdzIGJ5dGVzIHRvIGl0cyBvd24gcGlkLFxuICogbWFncGllIHBhcnNlcyB0aGUgSlNPTiBwb2ludGVyIGFuZCBjb21wYXJlcyBgc2Vzc2lvbl9pZGAuIGBpZGVudGlmeWAgaXMgd2hhdFxuICogbWFrZXMgdGhvc2Ugb25lIGZ1bmN0aW9uIOKAlCBpdCB0dXJucyB0aGUgZmlsZSdzIGJ5dGVzIGludG8gdGhlIGlkZW50aXR5IHRvXG4gKiBjb21wYXJlLCBhbmQgaXQgZGVmYXVsdHMgdG8gdGhlIHRyaW1tZWQgYnl0ZXMgdGhlbXNlbHZlcy5cbiAqXG4gKiDimqAgRXZlcnkgZmFpbHVyZSBpcyBzd2FsbG93ZWQgYW5kIHJlcG9ydGVkIGFzIGBmYWxzZWA6IHRoZSBmaWxlIGJlaW5nIGdvbmUsXG4gKiB1bnJlYWRhYmxlLCBvciB1bnBhcnNlYWJsZSBhbGwgbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlIOKAlCBpdCBpcyBub3Qgb3VycyB0b1xuICogcmVtb3ZlLiBBbiB1bnBhcnNlYWJsZSBwb2ludGVyIGlzIGRlbGliZXJhdGVseSBOT1QgdHJlYXRlZCBhcyBvdXJzLCB3aGljaCBpc1xuICogdGhlIGNvbnNlcnZhdGl2ZSBoYWxmIG9mIHRoZSBzYW1lIGBudWxsYC1ub3QtYDBgIHJ1bGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1bmxpbmtJZk1hdGNoZXMoXG4gIHBhdGg6IHN0cmluZyxcbiAgZXhwZWN0ZWQ6IHN0cmluZyxcbiAgaWRlbnRpZnk6IChyYXc6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbCA9IChyYXcpID0+IHJhdy50cmltKCksXG4pOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoaWRlbnRpZnkocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSkgIT09IGV4cGVjdGVkKSByZXR1cm4gZmFsc2U7XG4gICAgdW5saW5rU3luYyhwYXRoKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGluLXByb2Nlc3MgZXZlbnQgbG9nIOKAlCB0aGUgYXBwZW5kLW9ubHksIHJlcGxheWFibGUgYnVmZmVyXG4gKiBiZWhpbmQgZXZlcnkgc3BlbGwncyBgR0VUIC9ldmVudHNgIFNTRSB0YWlsLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIG1pbmQtbWFwcGVyJ3NcbiAqIGBzY3JpcHRzL2V2ZW50cy50c2Ag4oCUIHRoZSBjZW5zdXMncyBjb252ZXJnZW5jZSB0YXJnZXQgIzIsIGFuZCB0aGUgb25seSBvbmUgb2ZcbiAqIHRoZSBzaXggY29waWVkLWluLXBsYWNlIGJ1c2VzIHRoYXQgaXMgYSBtb2R1bGUsIGlzIGJvdW5kZWQsIGNhcnJpZXMgYW4gZXBvY2gsIGFuZCBpc1xuICogdW5pdC10ZXN0ZWQuIFRoZSBmaXZlIG90aGVycyBhcmUgdGhlIHNhbWUgdHdlbnR5IGxpbmVzIHdyaXR0ZW4gZml2ZSB0aW1lcy5cbiAqXG4gKiDilIDilIAgVEhFIFRIUkVFIFRISU5HUyBUSElTIEZJWEVTIEJZIENPTlNUUlVDVElPTiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKjEgwrcgTDUg4oCUIHRoZSBidWZmZXIgaXMgYm91bmRlZC4qKiBGaXZlIGRhZW1vbnMgYXBwZW5kIHRvIGFuIGFycmF5IGZvciB0aGVcbiAqIHdob2xlIGxpZmUgb2YgdGhlIHByb2Nlc3MuIFRoZSB3aW5kb3cgaXMgYSBSRVBMQVkgd2luZG93IGZvciByZWNvbm5lY3RzIHdpdGhpbiBvbmVcbiAqIGRhZW1vbidzIGxpZmV0aW1lLCBub3QgYSBkdXJhYmxlIGxvZzsgYSBjYXAgaXMgdGhlIGhvbmVzdCBzaGFwZS5cbiAqXG4gKiAqKjIgwrcgTDYg4oCUIGEgZnJhbWUgY2FycmllcyBhbiBlcG9jaCwgd2hlbiB0aGUgY2FsbGVyIGFza3MgZm9yIG9uZS4qKiBBZnRlciBhXG4gKiByZXN0YXJ0IHRoZSBpZHMgc3RhcnQgYWdhaW4gYXQgMSwgc28gYSByZXN1bWluZyBjbGllbnQgY2Fubm90IHRlbGwgYSBzdGFsZVxuICogd2F0ZXJtYXJrIGZyb20gYSBmcmVzaCBvbmUgYnkgaWQgYWxvbmUuXG4gKlxuICogKiozIMK3IEEgU1RBTEUgV0FURVJNQVJLIFJFUExBWVMgRlJPTSBUSEUgQkVHSU5OSU5HLCBhbmQgdGhpcyBpcyB0aGUgaGFsZiB0aGVcbiAqIGNsaWVudCBjYW5ub3QgZG8uKiogTUVBU1VSRUQgb24gYXN0cm9sYWJlOiBhIHRhaWwgdGhhdCByZXN1bWVzIGF0XG4gKiBgc2luY2U9PGxhc3QgaWQgb2YgdGhlIHByZXZpb3VzIGRhZW1vbj5gIGFnYWluc3QgYSByZXN0YXJ0ZWQgZGFlbW9uIHJlY2VpdmVzXG4gKiBOT1RISU5HIOKAlCB0aGUgbmV3IGRhZW1vbidzIGByZWFkeWAgaXMgaWQgMSwgd2hpY2ggaXMgbm90IGA+IHNpbmNlYCwgc28gdGhlXG4gKiBmaWx0ZXIgZHJvcHMgaXQsIHNvIG5vIGZyYW1lIGFycml2ZXMsIHNvIHRoZSBjbGllbnQncyBlcG9jaCBjaGVjayBuZXZlciBydW5zXG4gKiBhbmQgdGhlIHRhaWwgc2l0cyBjb25uZWN0ZWQgYW5kIHNpbGVudCB1bnRpbCB0aGUgbmV3IGRhZW1vbiBoYXMgZW1pdHRlZCBhc1xuICogbWFueSBldmVudHMgYXMgdGhlIG9sZCBvbmUgZGlkLiBTdGFtcGluZyBhbiBlcG9jaCBhbG9uZSBkb2VzIE5PVCBjbG9zZSB0aGF0XG4gKiBnYXA6IHRoZSBlcG9jaCByaWRlcyBhIGZyYW1lLCBhbmQgdGhlIGJ1ZyBpcyB0aGF0IG5vIGZyYW1lIGlzIHNlbnQuIFNvXG4gKiBgc3Vic2NyaWJlYCB0cmVhdHMgYHNpbmNlID4gY3Vyc29yYCBhcyBcInRoaXMgY3Vyc29yIGlzIGZyb20gYW5vdGhlciBwcm9jZXNzXCJcbiAqIGFuZCByZXBsYXlzIHdob2xlLiBgbWluZC1tYXBwZXIvc2NyaXB0cy90YWlsLnRlc3QudHNgJ3MgZXBvY2ggY2VsbCBpcyB0aGVcbiAqIGV4ZWN1dGFibGUgc3BlYyBvZiB0aGUgY2xpZW50IGhhbGYgYW5kIHNob3dzIHRoZSByZWNvbm5lY3Qgc3RpbGwgY2FycnlpbmcgdGhlXG4gKiBzdGFsZSBjdXJzb3Ig4oCUIGRldGVjdGlvbiBoYXBwZW5zIG9uIHdoYXQgaXMgUkVDRUlWRUQuXG4gKi9cblxuLyoqIFRoZSBkZWZhdWx0IHJlcGxheSB3aW5kb3csIGluaGVyaXRlZCBmcm9tIG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgY2FwLiAqL1xuZXhwb3J0IGNvbnN0IFJFUExBWV9CVUZGRVJfU0laRSA9IDEwMDA7XG5cbi8qKiBBIGZyYW1lIGFzIGl0IGdvZXMgb24gdGhlIHdpcmU6IHRoZSBjYWxsZXIncyBwYXlsb2FkIHBsdXMgYSBtb25vdG9uaWMgYGlkYCxcbiAqICBwbHVzIGFuIGBlcG9jaGAgd2hlbiB0aGUgbG9nIHdhcyBnaXZlbiBvbmUuICovXG5leHBvcnQgdHlwZSBGcmFtZTxUPiA9IFQgJiB7IGlkOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH07XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRMb2c8VD4ge1xuICAvKiogQXBwZW5kIG9uZSBmcmFtZSwgZmFuIGl0IG91dCB0byBsaXZlIHN1YnNjcmliZXJzLCBhbmQgcmV0dXJuIGl0LiAqL1xuICBlbWl0KG1zZzogVCk6IEZyYW1lPFQ+O1xuICAvKipcbiAgICogUmVwbGF5IGV2ZXJ5dGhpbmcgYWZ0ZXIgYHNpbmNlYCwgdGhlbiBzdGF5IHN1YnNjcmliZWQuIFJldHVybnMgYW5cbiAgICogdW5zdWJzY3JpYmUgZnVuY3Rpb24uXG4gICAqXG4gICAqIOKblCBSRVBMQVkgQU5EIFNVQlNDUklCRSBBUkUgT05FIENBTEwgT04gUFVSUE9TRS4gRG9pbmcgdGhlbSBpbiB0d28gc3RlcHNcbiAgICogbGVhdmVzIGEgd2luZG93IGluIHdoaWNoIGFuIGVtaXQgbGFuZHMgYmV0d2VlbiB0aGUgcmVwbGF5IGxvb3AgYW5kIHRoZVxuICAgKiBgYWRkYCwgYW5kIHRoYXQgZnJhbWUgaXMgZGVsaXZlcmVkIHRvIG5vYm9keSDigJQgdGhlIHNoYXBlIGZpdmUgZGFlbW9ucyBoYXZlLFxuICAgKiBzdXJ2aXZlZCBieSBub3RoaW5nIGJ1dCB0aGUgc2luZ2xlLXRocmVhZGVkIGV2ZW50IGxvb3AgaGFwcGVuaW5nIHRvIGNsb3NlXG4gICAqIGl0LiBEZXBlbmRpbmcgb24gdGhhdCBpcyBkZXBlbmRpbmcgb24gYW4gaW1wbGVtZW50YXRpb24gZGV0YWlsIG9mIHRoZVxuICAgKiBydW50aW1lIHJhdGhlciB0aGFuIG9uIHRoZSBjb2RlLlxuICAgKi9cbiAgc3Vic2NyaWJlKHNpbmNlOiBudW1iZXIsIGxpc3RlbmVyOiAoZnJhbWU6IEZyYW1lPFQ+KSA9PiB2b2lkKTogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBoaWdoZXN0IGlkIGVtaXR0ZWQgc28gZmFyIOKAlCB3aGF0IGBHRVQgL3N0YXRlYCByZXR1cm5zIGFzIGBjdXJzb3JgLiAqL1xuICBjdXJzb3IoKTogbnVtYmVyO1xuICAvKiogVGhlIGVwb2NoIHN0YW1wZWQgb24gZXZlcnkgZnJhbWUsIG9yIGB1bmRlZmluZWRgIGlmIG5vbmUgd2FzIGNvbmZpZ3VyZWQuICovXG4gIHJlYWRvbmx5IGVwb2NoOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVFdmVudExvZzxUIGV4dGVuZHMgb2JqZWN0PihcbiAgb3B0czogeyBlcG9jaD86IHN0cmluZzsgYnVmZmVyU2l6ZT86IG51bWJlciB9ID0ge30sXG4pOiBFdmVudExvZzxUPiB7XG4gIGNvbnN0IGJ1ZmZlclNpemUgPSBvcHRzLmJ1ZmZlclNpemUgPz8gUkVQTEFZX0JVRkZFUl9TSVpFO1xuICBjb25zdCBlcG9jaCA9IG9wdHMuZXBvY2g7XG4gIGNvbnN0IGJ1ZmZlcjogQXJyYXk8RnJhbWU8VD4+ID0gW107XG4gIGNvbnN0IGxpc3RlbmVycyA9IG5ldyBTZXQ8KGZyYW1lOiBGcmFtZTxUPikgPT4gdm9pZD4oKTtcbiAgbGV0IHNlcSA9IDA7XG5cbiAgcmV0dXJuIHtcbiAgICBlcG9jaCxcblxuICAgIGVtaXQobXNnKSB7XG4gICAgICBzZXEgKz0gMTtcbiAgICAgIC8vIOKblCBUSEUgTU9OT1RPTklDIElEIFdJTlMgT1ZFUiBBTllUSElORyBJTiBUSEUgUEFZTE9BRCwgQU5EIFVOVElMIE5PVyBJVFxuICAgICAgLy8gT05MWSBDTEFJTUVEIFRPLiBCb3RoIGFkb3B0aW5nIGRhZW1vbnMgd3JvdGUgYHsgaWQ6ICsrc2VxLCAuLi5tc2cgfWBcbiAgICAgIC8vIHVuZGVyIGEgY29tbWVudCBzYXlpbmcgXCJ0aGUgbW9ub3RvbmljIGBpZGAgTVVTVCB3aW4gb3ZlciBhbnkgYGlkYCBpblxuICAgICAgLy8gdGhlIHBheWxvYWQsIHNvIGNhbGxlcnMgY2FycnkgYSBwcm9qZWN0IGlkZW50aWZpZXIgYXMgYHByb2plY3RJZGAsXG4gICAgICAvLyBuZXZlciBgaWRgXCIg4oCUIGJ1dCBzcHJlYWQgb3JkZXIgbWVhbnMgYSBwYXlsb2FkIGBpZGAgb3ZlcnJvZGUgdGhlXG4gICAgICAvLyBjdXJzb3IsIHNpbGVudGx5LCBhbmQgdGhlIGNvbnZlbnRpb24gaW4gdGhlIGNvbW1lbnQgd2FzIHRoZSBvbmx5IHRoaW5nXG4gICAgICAvLyBob2xkaW5nIGl0LiBUaGUgbGl0ZXJhbCBrZWVwcyBgaWRgIEZJUlNUIHNvIHRoZSB3aXJlIGtleSBvcmRlciBpc1xuICAgICAgLy8gdW5jaGFuZ2VkOyB0aGUgYXNzaWdubWVudCBhZnRlciB0aGUgc3ByZWFkIGlzIHdoYXQgbWFrZXMgdGhlIHNlbnRlbmNlXG4gICAgICAvLyB0cnVlLiBgZXBvY2hgIGlzIHN0YW1wZWQgdGhlIHNhbWUgd2F5IGFuZCBmb3IgdGhlIHNhbWUgcmVhc29uLlxuICAgICAgY29uc3QgZnJhbWUgPSB7IGlkOiBzZXEsIC4uLm1zZyB9IGFzIEZyYW1lPFQ+O1xuICAgICAgZnJhbWUuaWQgPSBzZXE7XG4gICAgICBpZiAoZXBvY2ggIT09IHVuZGVmaW5lZCkgZnJhbWUuZXBvY2ggPSBlcG9jaDtcblxuICAgICAgYnVmZmVyLnB1c2goZnJhbWUpO1xuICAgICAgaWYgKGJ1ZmZlci5sZW5ndGggPiBidWZmZXJTaXplKSBidWZmZXIuc2hpZnQoKTtcbiAgICAgIGZvciAoY29uc3QgbGlzdGVuZXIgb2YgbGlzdGVuZXJzKSBsaXN0ZW5lcihmcmFtZSk7XG4gICAgICByZXR1cm4gZnJhbWU7XG4gICAgfSxcblxuICAgIHN1YnNjcmliZShzaW5jZSwgbGlzdGVuZXIpIHtcbiAgICAgIC8vIFNlZSB0aGUgaGVhZGVyLCBwb2ludCAzOiBhIGN1cnNvciBiZXlvbmQgb3VyIG93biBpcyBhIGN1cnNvciBmcm9tIGFcbiAgICAgIC8vIFBSSU9SIFBST0NFU1MsIGFuZCB0aGUgb25seSB1c2VmdWwgcmVhZGluZyBvZiBpdCBpcyBcInJlcGxheSB3aG9sZVwiLlxuICAgICAgLy9cbiAgICAgIC8vIOKaoCBBIE5PTi1GSU5JVEUgQ1VSU09SIEFMU08gTUVBTlMgXCJGUk9NIFRIRSBTVEFSVFwiLCB3aGljaCB0aGUgY29waWVzIGdvdFxuICAgICAgLy8gd3JvbmcgYnkgYWNjaWRlbnQ6IHRoZXkgd3JvdGUgYHBhcnNlSW50KHBhcmFtID8/IFwiLTFcIilgIGFuZCBjb21wYXJlZFxuICAgICAgLy8gYGlkID4gc2luY2VgLCBzbyBhIHR5cG8nZCBgP3NpbmNlPXhgIHByb2R1Y2VkIGBOYU5gLCBldmVyeSBjb21wYXJpc29uXG4gICAgICAvLyB3YXMgZmFsc2UsIGFuZCB0aGUgdGFpbCBvcGVuZWQgRU1QVFkgYW5kIHN0YXllZCBjb25uZWN0ZWQg4oCUIHRoZSBzYW1lXG4gICAgICAvLyBzaWxlbnQtYW5kLWNvbm5lY3RlZCBzeW1wdG9tIGFzIHRoZSBzdGFsZSB3YXRlcm1hcmssIGZyb20gYSBkaWZmZXJlbnRcbiAgICAgIC8vIGNhdXNlLiBBYnNlbnQgYW5kIHVucGFyc2VhYmxlIGFyZSB0aGUgc2FtZSByZXF1ZXN0IGhlcmUuXG4gICAgICBjb25zdCBmcm9tID0gIU51bWJlci5pc0Zpbml0ZShzaW5jZSkgfHwgc2luY2UgPiBzZXEgPyAtMSA6IHNpbmNlO1xuICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBidWZmZXIpIHtcbiAgICAgICAgaWYgKGZyYW1lLmlkID4gZnJvbSkgbGlzdGVuZXIoZnJhbWUpO1xuICAgICAgfVxuICAgICAgbGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG4gICAgICByZXR1cm4gKCkgPT4ge1xuICAgICAgICBsaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcbiAgICAgIH07XG4gICAgfSxcblxuICAgIGN1cnNvcigpIHtcbiAgICAgIHJldHVybiBzZXE7XG4gICAgfSxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgZGFlbW9uIGxpZmVjeWNsZSB0YWlsOiB0aGUgaWRsZS1jbG9zZSBkZWNpc2lvbiwgdGhlIHN3ZWVwXG4gKiB0aGF0IG1ha2VzIGl0LCBhbmQgdGhlIGJvdW5kZWQgdGVhcmRvd24uXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgYm91bnR5IOKAlCB0aGUgY2Vuc3VzJ3NcbiAqIGNvbnZlcmdlbmNlIHRhcmdldCAjMyDigJQgd2l0aCBhc3Ryb2xhYmUncyBgdGltZW91dE1zID4gMGAgZ3VhcmQgZm9sZGVkIGluLFxuICogd2hpY2ggaXMgdGhlIG9uZSB0aGluZyBib3VudHkncyBjb3B5IGRvZXMgbm90IGV4cHJlc3MuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTc2VDbGllbnRzIH0gZnJvbSBcIi4vc3NlLnRzXCI7XG5cbi8qKlxuICogU2hvdWxkIHRoZSBkYWVtb24gaWRsZS1jbG9zZT9cbiAqXG4gKiDim5QgKipgc3Vic2NyaWJlckNvdW50YCBJUyBBIFJFUVVJUkVEIEFSR1VNRU5ULCBBTkQgVEhBVCBJUyBUSEUgV0hPTEUgUE9JTlQuKipcbiAqIFRoaXMgY2xvc2VzIGNlbnN1cyBkZWZlY3QgKipMMSoqIGJ5IGNvbnN0cnVjdGlvbjogZ2xhbW91ciwgaW1hZ28gYW5kIG1hZ3BpZVxuICogY291bnRlZCB0aGVpciBpZGxlIGZsb29yIGRvd24gd2hpbGUgYW4gYWdlbnQgaGVsZCBhIHRhaWwgb3Blbiwgc28gYW4gYWdlbnRcbiAqIHdhdGNoaW5nIGEgcXVpZXQgYm9hcmQgd2FzIGtpbGxlZCBXSVRIIElUUyBDT05ORUNUSU9OIE9QRU4uIFRoZXJlIGlzIG5vXG4gKiBvdmVybG9hZCBvZiB0aGlzIGZ1bmN0aW9uIHRoYXQgY2Fubm90IHNlZSBpdHMgc3Vic2NyaWJlcnMsIHNvIHRoZSBkZWZlY3RcbiAqIGNhbm5vdCBiZSByZS1leHByZXNzZWQgYnkgYSBjYWxsZXIgd2hvIGZvcmdldHMuXG4gKlxuICog4puUICoqQU5EIFRIRSBTQ0FSIElUIENBTUUgV0lUSCwgcmUtaG9tZWQgZnJvbSBib3VudHkgdmVyYmF0aW0gaW4gc3Vic3RhbmNlOioqXG4gKiBhIGJvYXJkIG9ubHkgY291bnRzIGl0cyBpZGxlIGZsb29yIGRvd24gd2hpbGUgVU5XQVRDSEVELiBBIGxpdmUgc3Vic2NyaWJlciDigJRcbiAqIGEgYnJvd3NlciBXZWJTb2NrZXQsIG9yIGFuIGFnZW50IFNTRSB0YWlsIG9uIGAvZXZlbnRzYCDigJQga2VlcHMgaXQgb3BlblxuICogaW5kZWZpbml0ZWx5LiBTbyBgdGltZW91dGAgbWVhbnMgXCJsaW5nZXIgdGhpcyBsb25nIGFmdGVyIHRoZSBMQVNUIHN1YnNjcmliZXJcbiAqIGxlYXZlc1wiLCBOT1QgXCJtYXhpbXVtIGlkbGUgd2hpbGUgY29ubmVjdGVkXCIuIFRoZSBzd2VlcCBiZWxvdyBhbHNvIHRvdWNoZXMgdGhlXG4gKiBhY3Rpdml0eSBjbG9jayBvbiBldmVyeSB0aWNrIHdoaWxlIHdhdGNoZWQsIHNvIG9uY2UgdW53YXRjaGVkIHRoZSBmbG9vclxuICogY291bnRzIGZyb20gdGhhdCBsYXN0IGRpc2Nvbm5lY3QgYW5kIG5vdCBmcm9tIHRoZSBsYXN0IHJlcXVlc3QuXG4gKlxuICog4pqgIGB0aW1lb3V0TXMgPD0gMGAgbWVhbnMgTkVWRVIsIHdoaWNoIGlzIGFzdHJvbGFiZSdzIHN0YW5kaW5nLW9ic2VydmF0b3J5XG4gKiBkZWZhdWx0IGFuZCBpcyB3aHkgdGhlIGd1YXJkIGlzIGhlcmUgcmF0aGVyIHRoYW4gYXQgaXRzIG9uZSBjYWxsIHNpdGU6IGFcbiAqIHNpbmdsZXRvbiBkYWVtb24gaXMgbWVhbnQgdG8gc3RhbmQgdW50aWwgaXQgaXMgZXhwbGljaXRseSBjbG9zZWQsIGFuZCBhXG4gKiBgPj0gMGAgY29tcGFyaXNvbiB3b3VsZCBjbG9zZSBpdCBvbiB0aGUgZmlyc3QgdGljay5cbiAqXG4gKiBDbG9jay1mcmVlIGFuZCBmcy1mcmVlLCBzbyBpdCBpcyB0ZXN0YWJsZSB3aXRob3V0IGEgZGFlbW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkSWRsZUNsb3NlKFxuICBzdWJzY3JpYmVyQ291bnQ6IG51bWJlcixcbiAgaWRsZU1zOiBudW1iZXIsXG4gIHRpbWVvdXRNczogbnVtYmVyLFxuKTogYm9vbGVhbiB7XG4gIGlmICh0aW1lb3V0TXMgPD0gMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoc3Vic2NyaWJlckNvdW50ID4gMCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaWRsZU1zID49IHRpbWVvdXRNcztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBIb3VzZWtlZXBpbmdPcHRpb25zIHtcbiAgLyoqIOKblCBSRVFVSVJFRC4gU2VlIGBzaG91bGRJZGxlQ2xvc2VgIOKAlCB0aGlzIGlzIHdoYXQgY2xvc2VzIEwxLiAqL1xuICBzdWJzY3JpYmVyQ291bnQ6ICgpID0+IG51bWJlcjtcbiAgLyoqIE1pbGxpc2Vjb25kcyBzaW5jZSB0aGUgbGFzdCBhY3Rpdml0eS4gKi9cbiAgaWRsZU1zOiAoKSA9PiBudW1iZXI7XG4gIC8qKiBSZXNldCB0aGUgYWN0aXZpdHkgY2xvY2suIENhbGxlZCBvbiBldmVyeSB0aWNrIHRoYXQgaGFzIGEgc3Vic2NyaWJlci4gKi9cbiAgdG91Y2g6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgY29uZmlndXJlZCBpZGxlIHRpbWVvdXQgaW4gbXM7IGAwYCAob3IgbGVzcykgbWVhbnMgbmV2ZXIuICovXG4gIHRpbWVvdXRNczogbnVtYmVyO1xuICAvKiogRmlyZWQgb25jZSB3aGVuIHRoZSBkYWVtb24gc2hvdWxkIGNsb3NlIGl0c2VsZi4gKi9cbiAgb25JZGxlQ2xvc2U6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgZGVib3VuY2VkIHNuYXBzaG90LCBpZiB0aGUgc3BlbGwgaGFzIG9uZS4gKi9cbiAgc25hcHNob3Q/OiB7XG4gICAgZGlydHk6ICgpID0+IGJvb2xlYW47XG4gICAgY2xlYXI6ICgpID0+IHZvaWQ7XG4gICAgd3JpdGU6ICgpID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+O1xuICB9O1xuICAvKiogU3dlZXAgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDI1MCBtcy4gKi9cbiAgdGlja01zPzogbnVtYmVyO1xuICAvKiogU25hcHNob3QgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDEwMDAgbXMuICovXG4gIHNuYXBzaG90TXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogU3RhcnQgdGhlIHR3byBzdGFuZGluZyB0aW1lcnMgZXZlcnkgc2Vzc2lvbiBkYWVtb24gcnVucyDigJQgdGhlIGlkbGUgc3dlZXAgYW5kXG4gKiB0aGUgZGVib3VuY2VkIHNuYXBzaG90IOKAlCBhbmQgcmV0dXJuIHRoZSBmdW5jdGlvbiB0aGF0IHN0b3BzIGJvdGguXG4gKlxuICogVGhleSBhcmUgT05FIGNhbGwgYmVjYXVzZSB0aGV5IGhhdmUgYWx3YXlzIGJlZW4gb25lIGxpZmV0aW1lOiBldmVyeSBjb3B5XG4gKiBjbGVhcmVkIGJvdGggaW4gdGhlIHNhbWUgdHdvIGxpbmVzIGFmdGVyIGBhd2FpdCBkb25lYCwgYW5kIHRoZSBwYWlyIHRoYXQgZ2V0c1xuICogZm9yZ290dGVuIGlzIHRoZSBwYWlyIHdob3NlIHRpbWVycyBrZWVwIGEgcHJvY2VzcyBhbGl2ZSBhZnRlciB0ZWFyZG93bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0SG91c2VrZWVwaW5nKG9wdHM6IEhvdXNla2VlcGluZ09wdGlvbnMpOiAoKSA9PiB2b2lkIHtcbiAgY29uc3QgdGlja01zID0gb3B0cy50aWNrTXMgPz8gMjUwO1xuICBjb25zdCBzbmFwc2hvdE1zID0gb3B0cy5zbmFwc2hvdE1zID8/IDEwMDA7XG5cbiAgY29uc3QgaWRsZVRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIGNvbnN0IHN1YnNjcmliZXJzID0gb3B0cy5zdWJzY3JpYmVyQ291bnQoKTtcbiAgICBpZiAoc3Vic2NyaWJlcnMgPiAwKSBvcHRzLnRvdWNoKCk7XG4gICAgaWYgKHNob3VsZElkbGVDbG9zZShzdWJzY3JpYmVycywgb3B0cy5pZGxlTXMoKSwgb3B0cy50aW1lb3V0TXMpKSBvcHRzLm9uSWRsZUNsb3NlKCk7XG4gIH0sIHRpY2tNcyk7XG5cbiAgY29uc3Qgc25hcCA9IG9wdHMuc25hcHNob3Q7XG4gIGNvbnN0IHNuYXBUaW1lciA9IHNuYXBcbiAgICA/IHNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgaWYgKCFzbmFwLmRpcnR5KCkpIHJldHVybjtcbiAgICAgICAgc25hcC5jbGVhcigpO1xuICAgICAgICB2b2lkIHNuYXAud3JpdGUoKTtcbiAgICAgIH0sIHNuYXBzaG90TXMpXG4gICAgOiBudWxsO1xuXG4gIHJldHVybiAoKSA9PiB7XG4gICAgY2xlYXJJbnRlcnZhbChpZGxlVGltZXIpO1xuICAgIGlmIChzbmFwVGltZXIgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoc25hcFRpbWVyKTtcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEcmFpbk9wdGlvbnMge1xuICAvKiogVGhlIGJvdW5kIHNlcnZlci4gVHlwZWQgc3RydWN0dXJhbGx5IHNvIHRoZSBraXQgc3RheXMgZnJlZSBvZiBgYnVuYC4gKi9cbiAgc2VydmVyOiB7IHN0b3AoY2xvc2VBY3RpdmVDb25uZWN0aW9ucz86IGJvb2xlYW4pOiB1bmtub3duIH07XG4gIC8qKiBMaXZlIFNTRSB0YWlsczsgZXZlcnkgcmVnaXN0ZXJlZCBjbG9zZXIgaXMgaW52b2tlZC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBMaXZlIFdlYlNvY2tldHMuICovXG4gIHNvY2tldHM/OiBJdGVyYWJsZTx7IGNsb3NlKCk6IHZvaWQgfT47XG4gIC8qKiBIb3cgbG9uZyBxdWV1ZWQgZnJhbWVzIGdldCB0byBmbHVzaCBiZWZvcmUgYW55dGhpbmcgaXMgY2xvc2VkLiAqL1xuICBncmFjZU1zPzogbnVtYmVyO1xuICAvKiogSG93IGxvbmcgdGhlIGdyYWNlZnVsIHN0b3AgZ2V0cyBiZWZvcmUgdGVhcmRvd24gcHJvY2VlZHMgcmVnYXJkbGVzcy4gKi9cbiAgc3RvcE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIENsb3NlIGV2ZXJ5IGhlbGQgY29ubmVjdGlvbiBhbmQgc3RvcCB0aGUgc2VydmVyLCBpbiBib3VuZGVkIHRpbWUuXG4gKlxuICog4puUICoqVEhFIEdSQUNFIFBFUklPRCBJUyBOT1QgUE9MSVRFTkVTUy4qKiBBIGBjbG9zZWRgIGZyYW1lIGVtaXR0ZWQgYW5kIHRoZW5cbiAqIGZvbGxvd2VkIGltbWVkaWF0ZWx5IGJ5IGFuIGFnZ3Jlc3NpdmUgYHNlcnZlci5zdG9wKHRydWUpYCBpcyBhIGZyYW1lIHRoZVxuICogY2xpZW50IG5ldmVyIHNlZXMg4oCUIHRoZSBxdWV1ZSBnb2VzIHdpdGggdGhlIHNvY2tldC4gVGhlIDE1MCBtcyBpcyB3aGF0IHR1cm5zXG4gKiBcInRoZSBkYWVtb24gdG9sZCB5b3Ugd2h5IGl0IGRpZWRcIiBmcm9tIGEgaG9wZSBpbnRvIGFuIG9ic2VydmF0aW9uLCBhbmQgZXZlcnlcbiAqIG9uZSBvZiB0aGUgZWlnaHQgZGFlbW9ucyBjb252ZXJnZWQgb24gdGhhdCBudW1iZXIgaW5kZXBlbmRlbnRseS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNUT1AgSVMgUkFDRUQsIEJFQ0FVU0UgQSBTTE9XIFNPQ0tFVCBNVVNUIE5PVCBCRSBBQkxFIFRPIEhBTkdcbiAqIFRFQVJET1dOLioqIGBzZXJ2ZXIuc3RvcCh0cnVlKWAgYXdhaXRzIGl0cyBjb25uZWN0aW9uczsgb25lIHdlZGdlZCBwZWVyIGlzXG4gKiBlbm91Z2ggdG8gcGFyayBpdCBmb3JldmVyLCB3aGljaCBpcyBob3cgYSAyMy1taW51dGUgaGFuZyBzaGlwcGVkIG9uY2UuXG4gKlxuICog4pqgICoqV0hBVCBJUyBERUxJQkVSQVRFTFkgTk9UIEhFUkU6IGJvdW50eSdzIHNodXRkb3duIHdhdGNoZG9nLioqIEJvdW50eSBhcm1zXG4gKiBhIFJFRidkIGBzZXRUaW1lb3V0YCB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGlmIHRlYXJkb3duIGRvZXMgbm90IGZpbmlzaCxcbiAqIGFuZCB0aGUgY2Vuc3VzIGlzIHJpZ2h0IHRoYXQgaXQgaXMgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbFxuICogdGVybWluYXRpb24gZ3VhcmFudGVlLiBJdCBiZWxvbmdzIHRvIGJvdW50eSdzIFNJR05BTCBwYXRoIOKAlCBhIGRlYXRoIGFycml2aW5nXG4gKiBmcm9tIG91dHNpZGUsIHdoZXJlIG5vdGhpbmcgYm91bmRzIHdoYXQgdGhlIHRlYXJkb3duIGlzIHdhaXRpbmcgb24uIFRoZSB0d29cbiAqIGRhZW1vbnMgYWRvcHRpbmcgdGhpcyBtb2R1bGUgcmVnaXN0ZXIgbm8gc2lnbmFsIGhhbmRsZXJzLCBhbmQgdGhlaXIgd2hvbGVcbiAqIHRlYXJkb3duIGlzIGJvdW5kZWQgYnkgdGhlIHR3byBudW1iZXJzIGFib3ZlOyBhZGRpbmcgYW4gZXhpdCBoZXJlIHdvdWxkIHB1dFxuICogdGhlIGhvdXNlJ3Mgb25seSB1bmNvbmRpdGlvbmFsIGBwcm9jZXNzLmV4aXRgIGluc2lkZSBhIG1vZHVsZSBldmVyeSBzcGVsbCBpc1xuICogYWJvdXQgdG8gYnVuZGxlLCBvbmUgcGhhc2UgYWZ0ZXIgRDggdG9vayBleGFjdGx5IHRoYXQgaGF6YXJkIE9VVCBvZiBgZGllYC5cbiAqIFdoZW4gYSBzcGVsbCB3aXRoIGEgc2lnbmFsIHBhdGggYWRvcHRzIHRoaXMsIHRoZSB3YXRjaGRvZyBhcnJpdmVzIGFzIGFuXG4gKiBvcHRpb24gb24gdGhlc2UgYXJndW1lbnRzIGFuZCB0aGUgcmVhc29uaW5nIGlzIGFscmVhZHkgd3JpdHRlbiBkb3duLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZHJhaW5BbmRTdG9wKG9wdHM6IERyYWluT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBncmFjZU1zID0gb3B0cy5ncmFjZU1zID8/IDE1MDtcbiAgY29uc3Qgc3RvcE1zID0gb3B0cy5zdG9wTXMgPz8gMjAwO1xuXG4gIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIGdyYWNlTXMpKTtcblxuICBpZiAob3B0cy5jbGllbnRzKSB7XG4gICAgZm9yIChjb25zdCBjbGllbnQgb2YgWy4uLm9wdHMuY2xpZW50c10pIGNsaWVudC5jbG9zZSgpO1xuICB9XG4gIGlmIChvcHRzLnNvY2tldHMpIHtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIFsuLi5vcHRzLnNvY2tldHNdKSB7XG4gICAgICB0cnkge1xuICAgICAgICB3cy5jbG9zZSgpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIGFscmVhZHkgZ29uZSAqL1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgUHJvbWlzZS5yZXNvbHZlKG9wdHMuc2VydmVyLnN0b3AodHJ1ZSkpLFxuICAgIG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIHN0b3BNcykpLFxuICBdKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgYXNzZXQtc2VydmluZyB0cmlvIGZvciBhIHNwZWxsIGRhZW1vbjogd2hpY2ggc3VyZmFjZSBtb2RlIHdlXG4gKiBhcmUgaW4sIHdoYXQgY29udGVudCB0eXBlIGEgZmlsZSBnZXRzLCBhbmQgaG93IGEgZmlsZSB1bmRlciBgZGlzdC9gIGlzXG4gKiBhbnN3ZXJlZC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIEV4dHJhY3RlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIGZyb20gdGhlIGVpZ2h0IGBCdW4uc2VydmVgIGJhY2tlbmRzXG4gKiBjZW5zdXNlZCBpbiBgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LWRhZW1vbi1zcGluZS1jZW5zdXMubWRgLCB3aGljaFxuICogbWVhc3VyZWQgYHJlc29sdmVNb2RlYCBhcyBieXRlLWlkZW50aWNhbCBpbiBhbGwgZWlnaHQgKHRoZSBvbmx5IG1kNSBkaWZmZXJlbmNlXG4gKiBiZWluZyB0aGUgYGV4cG9ydGAga2V5d29yZCksIHRoZSBjb250ZW50LXR5cGUgbWFwIGFzIGRpZmZlcmluZyBpbiBleGFjdGx5XG4gKiBvbmUgY2VsbCwgYW5kIHRoZSBmaWxlIGhhbGYgb2YgYHNlcnZlRGlzdGAgYXMgaWRlbnRpY2FsIGluIGZpdmUuXG4gKlxuICog4pSA4pSAIFdIQVQgREVMSUJFUkFURUxZIERJRCBOT1QgQ09NRSBBTE9ORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKlRoZSBVUkwtdG8tZmlsZW5hbWUgbWFwcGluZyBzdGF5cyBpbiBlYWNoIHJvdXRlci4qKiBUaGUgY2Vuc3VzIG1hcmtlZCB0d29cbiAqIG9mIHRoZSBlaWdodCBgc2VydmVEaXN0YCBkaXZlcmdlbmNlcyBERUxJQkVSQVRFIGFuZCBib3RoIGxpdmUgaW4gdGhhdCBoYWxmOlxuICogZGlnZXN0aWZ5IHN1YnN0aXR1dGVzIGludG8gdGhlIGVudHJ5IEhUTUwgaW4gbWVtb3J5LCBhbmQgZ3JhcGV2aW5lIHNlcnZlcyBpdHNcbiAqIHN1cmZhY2UgYXQgYC93YXRjaGAgcmF0aGVyIHRoYW4gYXQgYC9gLiBBIHNpZ25hdHVyZSB3aWRlIGVub3VnaCB0byBhYnNvcmJcbiAqIHRob3NlIHN0b3BzIGJlaW5nIGEgZmlsZSBzZXJ2ZXIgYW5kIGJlY29tZXMgYSByb3V0ZXIuIFNvIHRoZSBjYWxsZXIgZGVjaWRlc1xuICogV0hJQ0ggZmlsZSAoYHBhdGggPT09IFwiL1wiID8gXCJpbmRleC5odG1sXCIgOiBwYXRoLnNsaWNlKDEpYCksIGFuZCB0aGlzIG1vZHVsZVxuICogZGVjaWRlcyB3aGV0aGVyIHRoYXQgZmlsZSBtYXkgYmUgcmVhZCBhbmQgd2hhdCBpdCBpcyBzZXJ2ZWQgYXMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG4vKipcbiAqIFJlbGVhc2UgaWZmIGA8ZGlzdERpcj4vaW5kZXguaHRtbGAgZXhpc3RzOyBlbHNlIGRldi4gVGhlIGVudiBvdmVycmlkZVxuICogKGBTUEVMTEJPT0tfU1VSRkFDRV9NT0RFYCkgd2lucyBlaXRoZXIgd2F5IOKAlCBzZWFtcyBDb250cmFjdCAxLlxuICpcbiAqIOKblCAqKlRIRSBGSUxFLCBORVZFUiBUSEUgRElSRUNUT1JZLCBBTkQgVEhBVCBJUyBBIFNDQVIgTk9UIEEgU1RZTEUgQ0hPSUNFLioqXG4gKiBSZS1ob21lZCBmcm9tIGJvdW50eSBhbmQgbWFncGllLCB3aGljaCBlYXJuZWQgaXQgaW5kZXBlbmRlbnRseTpcbiAqXG4gKiAtIG1hZ3BpZSdzIGBkaXN0L2AgQUxSRUFEWSBFWElTVEVEIGhvbGRpbmcgYGNsaS5qc2AgYW5kIG5vIGBpbmRleC5odG1sYCxcbiAqICAgd2hpY2ggaXMgcHJlY2lzZWx5IHdoeSBpdHMgZGFlbW9uIHN0YXllZCBjb3JyZWN0bHkgaW4gREVWIG1vZGUgdGhyb3VnaCB0aGVcbiAqICAgd2hvbGUgb2YgU2xpY2UgMi4gYGRpc3QvYCBleGlzdGluZyBpcyBub3QgdGhlIGRpc2NyaW1pbmF0b3IuXG4gKiAtIGJvdW50eSBzYXlzIHRoZSBzYW1lIHRoaW5nIGZyb20gdGhlIG90aGVyIHNpZGU6IGEgYnVpbHQgQkFDS0VORCBwdXRzXG4gKiAgIGBjbGkuanNgIChhbmQgbm93IGBzZXJ2ZXIuanNgKSBpbiBgZGlzdC9gIHdpdGggbm8gc3VyZmFjZSBhbnl3aGVyZSBuZWFyIGl0LlxuICpcbiAqIOKaoCAqKkFORCBUSEUgUFJFRElDQVRFIElTIEFOIFVOSEFTSEVEIEZJTEVOQU1FLCBXSElDSCBJUyBBIFNUQU5ESU5HXG4gKiBBU1NVTVBUSU9OIEFCT1VUIFRIRSBTVVJGQUNFIEJVSUxELioqIFJlbGVhc2UgbW9kZSBpcyBjaG9zZW4gYnkgT05FIGxpdGVyYWxcbiAqIG5hbWUuIEEgc3VyZmFjZSBidWlsZCB0aGF0IGV2ZXIgZW1pdHRlZCBhIGNvbnRlbnQtaGFzaGVkIGVudHJ5IGRvY3VtZW50IHdvdWxkXG4gKiBsZWF2ZSBubyBgaW5kZXguaHRtbGAgaGVyZSwgZXZlcnkgZGFlbW9uIHdvdWxkIHNpbGVudGx5IHJlc29sdmUgREVWLCBhbmQgdGhlXG4gKiBvbmx5IHN5bXB0b20gYW55b25lIGNhbiBzZWUgaXMgdGhlIGBtb2RlYCBmaWVsZCBvbiBhIGhhbmRzaGFrZSBub2JvZHkgcmVhZHMgaW5cbiAqIGFuZ2VyLiBgc3JjL2J1aWxkLnRzYCBlbWl0cyB0aGUgZW50cnkgdW5oYXNoZWQgdG9kYXkgKG9ubHkgdGhlIEpTIGFuZCBDU1NcbiAqIGNodW5rcyBjYXJyeSBoYXNoZXMpIGFuZCBDb250cmFjdCAyIHBpbnMgdGhhdCBmbGF0IGxheW91dDsgdGhpcyBjb21tZW50IGlzXG4gKiB0aGUgbm90ZSB0aGF0IHNheXMgd2hhdCB0aGUgcGluIGlzIGxvYWQtYmVhcmluZyBGT1IuXG4gKlxuICog4pqgIE5vdGhpbmcgYW5ub3VuY2VzIHRoZSBmbGlwIGZyb20gZGV2IHRvIHJlbGVhc2UgZWl0aGVyOiB0aGUgZmlyc3Qgc3VyZmFjZVxuICogYnVpbGQgdG8gbGFuZCBhbiBgaW5kZXguaHRtbGAgYmVzaWRlIGEgZGFlbW9uIGZsaXBzIGl0LCBzaWxlbnRseSwgb24gdGhlIG5leHRcbiAqIGJvb3QuIFRoYXQgaXMgd2h5IGBtb2RlYCByaWRlcyB0aGUgcmVhZHkgZnJhbWUg4oCUIHdpdGggcm9vdCBkZXBzIHByZXNlbnQgYSBkZXZcbiAqIGRhZW1vbiByZW5kZXJzIGFuIGlkZW50aWNhbC1sb29raW5nIHN1cmZhY2UsIHNvIFwiaXQgbG9va3MgcmlnaHRcIiBjYW5ub3RcbiAqIHZlcmlmeSBDb250cmFjdCAxLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZU1vZGUoZGlzdERpcjogc3RyaW5nKTogXCJkZXZcIiB8IFwicmVsZWFzZVwiIHtcbiAgY29uc3Qgb3ZlcnJpZGUgPSBwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFO1xuICBpZiAob3ZlcnJpZGUgPT09IFwiZGV2XCIgfHwgb3ZlcnJpZGUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gb3ZlcnJpZGU7XG4gIHJldHVybiBleGlzdHNTeW5jKGpvaW4oZGlzdERpciwgXCJpbmRleC5odG1sXCIpKSA/IFwicmVsZWFzZVwiIDogXCJkZXZcIjtcbn1cblxuLyoqXG4gKiBUaGUgY29udGVudCB0eXBlcyBhIGJ1aWx0IHN1cmZhY2UgYWN0dWFsbHkgc2hpcHMuIEV4dGVuc2lvbnMgb3V0c2lkZSB0aGVcbiAqIG1hcCBnZXQgYGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbWAg4oCUIGEgZGVsaWJlcmF0ZSByZWZ1c2FsIHRvIGd1ZXNzLCBzaW5jZVxuICogYW55dGhpbmcgbm90IGluIHRoaXMgbGlzdCBpcyBub3Qgc29tZXRoaW5nIENvbnRyYWN0IDIncyBidWlsZCBlbWl0cy5cbiAqXG4gKiDimqAgKipgY2hhcnNldD11dGYtOGAgT04gSFRNTCBJUyBUSEUgQ0VOU1VTJ1MgT05FIERJVkVSR0VOQ0UsIFJFU09MVkVEIFRPV0FSRFxuICogVEhFIENPUlJFQ1QgQ09QWS4qKiBUaHJlZSBvZiB0aGUgZWlnaHQgZGFlbW9ucyBjYXJyaWVkIGl0IGFuZCBmaXZlIGRpZCBub3Q7XG4gKiB0aGUgY2Vuc3VzIGdyYWRlZCB0aGF0IGBzdGFsZWAgd2l0aCB6ZXJvIGRlc2lnbiBjb250ZW50LiBJdCBpcyBrZXB0IGJlY2F1c2VcbiAqIGl0IGlzIHRoZSByaWdodCBhbnN3ZXIg4oCUIGFuIEhUTUwgZG9jdW1lbnQgc2VydmVkIHdpdGggbm8gY2hhcnNldCBpcyBkZWNvZGVkXG4gKiBieSB0aGUgYnJvd3NlcidzIGd1ZXNzIOKAlCBhbmQgaXQgaXMgdGhlIG9uZSB3aXJlLW9ic2VydmFibGUgY2hhbmdlIHRoaXNcbiAqIGNvbnZlcmdlbmNlIG1ha2VzIHRvIGEgcmVzcG9uc2UgaGVhZGVyLiBSZWNvcmRlZCBhcyBELW5vdGUgaW4gdGhlIHBoYXNlIGxvZ1xuICogcmF0aGVyIHRoYW4gc211Z2dsZWQuXG4gKi9cbmNvbnN0IFNUQVRJQ19DT05URU5UX1RZUEVTOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcIi5odG1sXCI6IFwidGV4dC9odG1sOyBjaGFyc2V0PXV0Zi04XCIsXG4gIFwiLmpzXCI6IFwidGV4dC9qYXZhc2NyaXB0XCIsXG4gIFwiLmNzc1wiOiBcInRleHQvY3NzXCIsXG4gIFwiLmpzb25cIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gIFwiLnN2Z1wiOiBcImltYWdlL3N2Zyt4bWxcIixcbiAgXCIucG5nXCI6IFwiaW1hZ2UvcG5nXCIsXG59O1xuXG4vKiogVGhlIGNvbnRlbnQgdHlwZSBmb3IgYSBmaWxlbmFtZSBvciBhbiBleHRlbnNpb24uIFVua25vd24gZXh0ZW5zaW9ucywgYW5kXG4gKiAgbmFtZXMgd2l0aCBubyBleHRlbnNpb24gYXQgYWxsLCBnZXQgYGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbWAuICovXG5leHBvcnQgZnVuY3Rpb24gY29udGVudFR5cGVGb3IobmFtZU9yRXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBkb3QgPSBuYW1lT3JFeHQubGFzdEluZGV4T2YoXCIuXCIpO1xuICBjb25zdCBleHQgPSBkb3QgPT09IC0xID8gXCJcIiA6IG5hbWVPckV4dC5zbGljZShkb3QpO1xuICByZXR1cm4gU1RBVElDX0NPTlRFTlRfVFlQRVNbZXh0XSA/PyBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiO1xufVxuXG4vKipcbiAqIEFuc3dlciBPTkUgZmlsZSBmcm9tIGBkaXN0RGlyYCwgb3IgYG51bGxgIGlmIHRoZSBjYWxsZXIgc2hvdWxkIGtlZXAgcm91dGluZy5cbiAqXG4gKiBgcmVsYCBpcyBhIGJhcmUgZmlsZW5hbWUg4oCUIHRoZSBlbnRyeSBkb2N1bWVudCBvciBvbmUgaGFzaGVkIGNodW5rLiBDb250cmFjdFxuICogMidzIGJ1aWx0IHN1cmZhY2UgaXMgRkxBVCBhbmQgbGlua3MgaXRzIGNodW5rcyByZWxhdGl2ZWx5LCBzbyBhIGxlZ2l0aW1hdGVcbiAqIGFzc2V0IHJlcXVlc3QgaXMgbmV2ZXIgbmVzdGVkIGFuZCBuZXZlciBjb250YWlucyBgLi5gOyBib3RoIGFyZSByZWZ1c2VkXG4gKiBoZXJlIHJhdGhlciB0aGFuIGluIHRoZSByb3V0ZXIsIGJlY2F1c2UgdGhlIGd1YXJkIHByb3RlY3RzIHRoZSByZWFkIGFuZCB0aGVcbiAqIHJlYWQgaXMgd2hhdCBsaXZlcyBpbiB0aGlzIGZpbGUuXG4gKlxuICog4pqgIFRoZSByZWZ1c2FsIGlzIGFsc28gd2hhdCBrZWVwcyBhbiBhc3NldCBzZXJ2ZSBjbGVhciBvZiBhIHNwZWxsJ3Mgb3duXG4gKiByb3V0ZXM6IG1hZ3BpZSBoYXMgYW4gYC9hc3NldHMvPG5hbWU+YCByb3V0ZSBvbmUgbGV2ZWwgZGVlcCwgYW5kIHRoaXNcbiAqIHJldHVybmluZyBgbnVsbGAgb24gYW55dGhpbmcgd2l0aCBhIHNsYXNoIGluIGl0IGlzIHdoYXQgc3RvcHMgdGhlIHR3b1xuICogZmlnaHRpbmcuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXJ2ZUZyb21EaXN0KGRpc3REaXI6IHN0cmluZywgcmVsOiBzdHJpbmcpOiBSZXNwb25zZSB8IG51bGwge1xuICBpZiAoIXJlbCB8fCByZWwuaW5jbHVkZXMoXCIuLlwiKSB8fCByZWwuaW5jbHVkZXMoXCIvXCIpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZmlsZSA9IGpvaW4oZGlzdERpciwgcmVsKTtcbiAgaWYgKCFleGlzdHNTeW5jKGZpbGUpKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIG5ldyBSZXNwb25zZShCdW4uZmlsZShmaWxlKSwgeyBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IGNvbnRlbnRUeXBlRm9yKHJlbCkgfSB9KTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgc2VydmVyIHNpZGUgb2YgdGhlIFNTRSB0YWlsIOKAlCB0aGUgZGFlbW9uLXNpZGUgdHdpbiBvZlxuICogYHRhaWxFdmVudHMudHNgLiBUaGF0IG1vZHVsZSBkZWNpZGVzIHdoYXQgYSBjYWxsZXIgb2JzZXJ2ZXM7IHRoaXMgb25lIGRlY2lkZXNcbiAqIHdoYXQgYSBjYWxsZXIgaXMgc2VudC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBleGNlcHQgaXRzXG4gKiBvd24gc2libGluZyB0eXBlcywgd2hpY2ggaXMgc3RpbGwgaW5zaWRlIHRoZSBsZWFmLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzIGBzc2VSZXNwb25zZWAsXG4gKiB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMxOiB0aGUgb25seSBvbmUgb2YgdGhlIHNldmVuIHdpdGggYVxuICogb25jZS1vbmx5IHRlYXJkb3duIGZ1bm5lbCwgdGhlIG9ubHkgb25lIHdpcmVkIHRvIGByZXEuc2lnbmFsYCwgYW5kIHRoZSBvbmx5XG4gKiBvbmUgd2hvc2UgY29tbWVudCByZWNvcmRzIGEgTUVBU1VSRUQgcmVzdWx0IHJhdGhlciB0aGFuIGEgYmVsaWVmLlxuICpcbiAqIOKUgOKUgCDim5QgVEhFIFNDQVIsIFJFLUhPTUVEOiBgdHJ5IHsgZW5xdWV1ZSB9IGNhdGNoYCBET0VTIE5PVCBERVRFQ1QgQSBERUFEXG4gKiAgICBDTElFTlQuIE1FQVNVUkVEIE9OIEJVTiAxLjMuMTQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogU2l4IGRhZW1vbnMgd3JpdGUgYSBoZWFydGJlYXQgYXMgYHRyeSB7IGNvbnRyb2xsZXIuZW5xdWV1ZSguLi4pIH0gY2F0Y2gge31gXG4gKiB3aXRoIGEgY29tbWVudCBzYXlpbmcgdGhlIGNhdGNoIGlzIGhvdyBhIGRlcGFydGVkIGNsaWVudCBpcyBub3RpY2VkLiBJdCBpc1xuICogbm90OiBlbnF1ZXVlIG9uIGFuIG9ycGhhbmVkIHN0cmVhbSBCVUZGRVJTIFNJTEVOVExZIGFuZCBuZXZlciB0aHJvd3MsIHNvIHRoZVxuICogY2F0Y2ggbmV2ZXIgZmlyZXMgYW5kIHRob3NlIGRhZW1vbnMnIGRlYWQtY2xpZW50IGRldGVjdGlvbiByZXN0cyBvbiBhXG4gKiBtZWNoYW5pc20gdGhlaXIgb3duIGNvbW1lbnRzIGRlc2NyaWJlIGluY29ycmVjdGx5LiBXaGF0IGFjdHVhbGx5IHJlY2xhaW1zIHRoZVxuICogY29ubmVjdGlvbiBpcyB0aGUgc3RyZWFtJ3MgYGNhbmNlbCgpYCDigJQgYW5kLCBmb3IgYSBjbGllbnQgdGhhdCBuZXZlciBjbG9zZXNcbiAqIHRoZSBzb2NrZXQsIGByZXEuc2lnbmFsYC5cbiAqXG4gKiBTbyB0aGUgZnVubmVsIGJlbG93IGlzIHRoZSBsb2FkLWJlYXJpbmcgcGFydC4gYHRlYXJkb3duKClgIHJ1bnMgQVQgTU9TVCBPTkNFXG4gKiBmcm9tIGV2ZXJ5IHBhdGggdGhlcmUgaXMg4oCUIGBjYW5jZWwoKWAsIGFuIGFib3J0IG9uIHRoZSByZXF1ZXN0IHNpZ25hbCwgYW5kXG4gKiB0aGUgYmVsdC1hbmQtYnJhY2VzIGVucXVldWUgY2F0Y2gg4oCUIGFuZCBpdCBpcyB3aGVyZSB0aGUgc3Vic2NyaWJlciBjb3VudCBhbmRcbiAqIGFueSBwcmVzZW5jZSBkZWNyZW1lbnQgcmlkZS4gQm91bmRpbmcgcHJlc2VuY2UgYWNjdXJhY3kgaXMgYm91bmRpbmcgdGhhdFxuICogZnVubmVsLlxuICpcbiAqIOKaoCBLbm93biBob2xlLCBhY2NlcHRlZCBhbmQgaW5oZXJpdGVkOiBCdW4ncyBvd24gYGZldGNoKClgIHJlYWRlciBgLmNhbmNlbCgpYFxuICogY2xvc2VzIG5vdGhpbmcgY2xpZW50LXNpZGUgYW5kIHRoZSBzZXJ2ZXIgY2Fubm90IHNlZSBpdC4gUmVhbCBjbGllbnRzIGNsb3NlXG4gKiB0aGUgc29ja2V0LlxuICovXG5cbmltcG9ydCB0eXBlIHsgRXZlbnRMb2csIEZyYW1lIH0gZnJvbSBcIi4vZXZlbnRMb2cudHNcIjtcblxuLyoqXG4gKiBPbmUgb3BlbiBTU0Ugc3RyZWFtLCBhcyB0aGUgZGFlbW9uIGNhbiBhY3Qgb24gaXQ6IGVuZCBpdCwgb3IgcHVzaCBhIGZyYW1lIHRvXG4gKiBpdCB0aGF0IGRpZCBub3QgY29tZSBvdXQgb2YgdGhlIGxvZy5cbiAqXG4gKiDim5QgSVQgSVMgTk9UIEEgQ09OVFJPTExFUi4gVGhlIGNvcGllcyBoZWxkXG4gKiBgU2V0PFJlYWRhYmxlU3RyZWFtRGVmYXVsdENvbnRyb2xsZXI+YCBhbmQgY2xvc2VkIHRoZW0gZGlyZWN0bHkgYXQgdGVhcmRvd24sXG4gKiB3aGljaCBieXBhc3NlcyB0aGUgdGVhcmRvd24gZnVubmVsIGFib3ZlIOKAlCB0aGUgaGVhcnRiZWF0IGludGVydmFsIGZvciB0aGF0XG4gKiBzdHJlYW0gd2FzIGNsZWFyZWQgb25seSBiZWNhdXNlIGEgc2Vjb25kIGBTZXRgIG9mIHRpbWVycyB3YXMga2VwdCBpbiBwYXJhbGxlbFxuICogYW5kIHN3ZXB0IHNlcGFyYXRlbHkuIEV2ZXJ5dGhpbmcgaGVyZSBnb2VzIHRocm91Z2ggdGhlIGZ1bm5lbCwgYW5kIGEgYHNlbmRgXG4gKiBhZnRlciB0ZWFyZG93biBpcyBhIG5vLW9wIHJhdGhlciB0aGFuIGEgdGhyb3cuXG4gKlxuICog4pqgICoqYHNlbmRgIEFSUklWRUQgSU4gUEhBU0UgMiwgRlJPTSBUSEUgRklSU1QgQ09OU1VNRVIgVEhBVCBXQVMgTk9UIE9ORSBPRiBUSEVcbiAqIFRXTyBUSElTIE1PRFVMRSBXQVMgREVTSUdORUQgQUdBSU5TVC4qKiBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSBhbm5vdW5jZSBwcmVzZW5jZVxuICogb3ZlciB0aGVpciBicm93c2VyIFdFQlNPQ0tFVCwgc28gYSByZWdpc3RyeSBvZiBiYXJlIGNsb3NlcnMgd2FzIHN1ZmZpY2llbnQgYW5kXG4gKiB0aGUgYm91bmRhcnkgbG9va2VkIHJpZ2h0LiBnbGFtb3VyIGFubm91bmNlcyBpdCBvbiB0aGUgQUdFTlQncyBTU0UgdGFpbCDigJRcbiAqIGB7dHlwZTpcImNvbm5lY3RlZFwifWAgLyBge3R5cGU6XCJkaXNjb25uZWN0ZWRcIn1gLCBkZWxpYmVyYXRlbHkgdW5sb2dnZWQsIHNvIGFcbiAqIHJlY29ubmVjdGluZyBhZ2VudCBkb2VzIG5vdCByZS1zZWUgZXZlcnkgcGFzdCBjb25uZWN0IGFuZCBzbyB0aGUgZnJhbWUgbmV2ZXJcbiAqIGFkdmFuY2VzIGEgdGFpbCBjdXJzb3IuIFRoYXQgaXMgbm90IGEgZ2xhbW91ciBxdWlyazsgaXQgaXMgdGhlIGdlbmVyYWwgc2hhcGVcbiAqIG9mIFwidGVsbCB0aGUgbGl2ZSBzdWJzY3JpYmVycyBzb21ldGhpbmcgdGhhdCBpcyBub3QgcGFydCBvZiB0aGUgaGlzdG9yeVwiLCBhbmRcbiAqIGEgcmVnaXN0cnkgdGhhdCBjYW4gb25seSBFTkQgYSBzdHJlYW0gY2Fubm90IGV4cHJlc3MgaXQuIFdpdGhvdXQgdGhpcyB0aGVcbiAqIHNwZWxsIHdvdWxkIGhhdmUgaGFkIHRvIGtlZXAgaXRzIG93biBwYXJhbGxlbCBgU2V0YCBvZiBjb250cm9sbGVycywgd2hpY2ggaXNcbiAqIGV4YWN0bHkgdGhlIGRyaWZ0IHRoaXMgcmVnaXN0cnkgZXhpc3RzIHRvIHJlbW92ZS5cbiAqL1xuZXhwb3J0IHR5cGUgU3NlQ2xpZW50ID0ge1xuICAvKiogRW5kIHRoaXMgc3RyZWFtLCB0aHJvdWdoIHRoZSB0ZWFyZG93biBmdW5uZWwsIGF0IG1vc3Qgb25jZS4gKi9cbiAgY2xvc2UoKTogdm9pZDtcbiAgLyoqIFdyaXRlIG9uZSByYXcgU1NFIGNodW5rIHRvIHRoaXMgc3RyZWFtLiBOby1vcCBvbmNlIHRvcm4gZG93bi4gKi9cbiAgc2VuZChjaHVuazogc3RyaW5nKTogdm9pZDtcbn07XG5cbi8qKlxuICogVGhlIGxpdmUtdGFpbCByZWdpc3RyeS4gYHNpemVgIGlzIHRoZSBkYWVtb24ncyBTU0Ugc3Vic2NyaWJlciBjb3VudCDigJQgdGhlXG4gKiBudW1iZXIgYHNob3VsZElkbGVDbG9zZWAgbXVzdCBzZWUg4oCUIGFuZCBjbG9zaW5nIGV2ZXJ5IGVudHJ5IGlzIHdoYXQgYSBkcmFpblxuICogZG9lcy5cbiAqL1xuZXhwb3J0IHR5cGUgU3NlQ2xpZW50cyA9IFNldDxTc2VDbGllbnQ+O1xuXG5leHBvcnQgaW50ZXJmYWNlIFNzZU9wdGlvbnM8VCBleHRlbmRzIG9iamVjdD4ge1xuICAvKiogVGhlIGxvZyB0byByZXBsYXkgZnJvbSBhbmQgc3Vic2NyaWJlIHRvLiAqL1xuICBsb2c6IEV2ZW50TG9nPFQ+O1xuICAvKiogVGhlIGNhbGxlcidzIHJlc3VtZSBjdXJzb3IuIEFic2VudCBvciB1bnBhcnNlYWJsZSByZXBsYXlzIGZyb20gdGhlIHN0YXJ0LiAqL1xuICBzaW5jZTogbnVtYmVyO1xuICAvKiogSGVhcnRiZWF0IGNvbW1lbnQgaW50ZXJ2YWwuIE1VU1Qgc3RheSB3ZWxsIHVuZGVyIHRoZSBzZXJ2ZXInc1xuICAgKiAgYGlkbGVUaW1lb3V0YCDigJQgc2VlIGBoZWFydGJlYXQudHNgLCB3aGljaCBpcyB3aGVyZSB0aGF0IHBhaXIgbGl2ZXMuICovXG4gIGhlYXJ0YmVhdE1zOiBudW1iZXI7XG4gIC8qKiBMaXZlbmVzcyByZWdpc3RyeTsgdGhlIHN0cmVhbSBhZGRzIGl0c2VsZiBvbiBvcGVuIGFuZCByZW1vdmVzIGl0c2VsZiBpblxuICAgKiAgdGhlIHRlYXJkb3duIGZ1bm5lbC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBgcmVxLnNpZ25hbGAg4oCUIHRoZSBvbmx5IHRoaW5nIHRoYXQgcmVjbGFpbXMgYSBjbGllbnQgdGhhdCB3ZW50IGF3YXlcbiAgICogIHdpdGhvdXQgY2FuY2VsbGluZyB0aGUgc3RyZWFtLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqIFNlcnZlci1zaWRlIGZpbHRlci4gQSByZWplY3RlZCBmcmFtZSBpcyBub3Qgc2VudDsgdGhlIGNsaWVudCBzdGlsbFxuICAgKiAgYWR2YW5jZXMgaXRzIGN1cnNvciBwYXN0IGl0LCB3aGljaCBpcyBgdGFpbEV2ZW50c2AncyBkb2N1bWVudGVkIHJ1bGUuICovXG4gIGZpbHRlcj86IChmcmFtZTogRnJhbWU8VD4pID0+IGJvb2xlYW47XG4gIC8qKiBSdW4gYWZ0ZXIgdGhlIHN0cmVhbSBpcyBzdWJzY3JpYmVkIChwcmVzZW5jZSB1cCwgYWN0aXZpdHkgdG91Y2gpLiAqL1xuICBvbk9wZW4/OiAoKSA9PiB2b2lkO1xuICAvKiogUnVuIGV4YWN0bHkgb25jZSwgZnJvbSB3aGljaGV2ZXIgdGVhcmRvd24gcGF0aCBmaXJlcyBmaXJzdC4gKi9cbiAgb25DbG9zZT86ICgpID0+IHZvaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzc2VSZXNwb25zZTxUIGV4dGVuZHMgb2JqZWN0PihvcHRzOiBTc2VPcHRpb25zPFQ+KTogUmVzcG9uc2Uge1xuICBjb25zdCB7IGxvZywgc2luY2UsIGhlYXJ0YmVhdE1zLCBjbGllbnRzLCBzaWduYWwsIGZpbHRlciwgb25PcGVuLCBvbkNsb3NlIH0gPSBvcHRzO1xuXG4gIGxldCB1bnN1YnNjcmliZTogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGxldCBrZWVwYWxpdmU6IFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPiB8IG51bGwgPSBudWxsO1xuICBsZXQgY2xvc2VkID0gZmFsc2U7XG4gIC8vIFRoZSByZWdpc3RyeSBlbnRyeSBmb3IgVEhJUyBzdHJlYW0uIEl0cyBtZXRob2RzIGFyZSBmaWxsZWQgaW4gYnkgYHN0YXJ0YCxcbiAgLy8gd2hpY2ggaXMgd2hlcmUgdGhlIGNvbnRyb2xsZXIgZXhpc3RzOyB0aGUgb2JqZWN0IGlkZW50aXR5IGlzIHN0YWJsZSBmcm9tXG4gIC8vIGhlcmUgc28gYHRlYXJkb3duYCBjYW4gcmVtb3ZlIGV4YWN0bHkgdGhpcyBlbnRyeS5cbiAgY29uc3QgY2xpZW50OiBTc2VDbGllbnQgPSB7IGNsb3NlOiAoKSA9PiB7fSwgc2VuZDogKCkgPT4ge30gfTtcblxuICBjb25zdCB0ZWFyZG93biA9ICgpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBpZiAoa2VlcGFsaXZlICE9PSBudWxsKSBjbGVhckludGVydmFsKGtlZXBhbGl2ZSk7XG4gICAgdW5zdWJzY3JpYmU/LigpO1xuICAgIGNsaWVudHM/LmRlbGV0ZShjbGllbnQpO1xuICAgIG9uQ2xvc2U/LigpO1xuICB9O1xuXG4gIGNvbnN0IHN0cmVhbSA9IG5ldyBSZWFkYWJsZVN0cmVhbSh7XG4gICAgc3RhcnQoY29udHJvbGxlcikge1xuICAgICAgY29uc3QgZW5jb2RlciA9IG5ldyBUZXh0RW5jb2RlcigpO1xuICAgICAgY29uc3Qgc2FmZUVucXVldWUgPSAoY2h1bms6IHN0cmluZykgPT4ge1xuICAgICAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29udHJvbGxlci5lbnF1ZXVlKGVuY29kZXIuZW5jb2RlKGNodW5rKSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHRlYXJkb3duKCk7XG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBjbGllbnQuY2xvc2UgPSAoKSA9PiB7XG4gICAgICAgIHRlYXJkb3duKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29udHJvbGxlci5jbG9zZSgpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAvKiBhbHJlYWR5IGNsb3NlZCBieSB0aGUgcnVudGltZSAqL1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgLy8g4puUIGBzZW5kYCBHT0VTIFRIUk9VR0ggYHNhZmVFbnF1ZXVlYCwgc28gYW4gb3V0LW9mLWJhbmQgZnJhbWUgb2JleXMgdGhlXG4gICAgICAvLyBzYW1lIGNsb3NlZC1jaGVjayBhbmQgdGhlIHNhbWUgdGVhcmRvd24tb24tdGhyb3cgYXMgYSBsb2dnZWQgb25lLiBBXG4gICAgICAvLyBkYWVtb24gbXVzdCBub3QgYmUgYWJsZSB0byB3cml0ZSB0byBhIHN0cmVhbSB0aGlzIG1vZHVsZSBoYXMgdG9ybiBkb3duLlxuICAgICAgY2xpZW50LnNlbmQgPSBzYWZlRW5xdWV1ZTtcblxuICAgICAgLy8g4puUIEFOIE9QRU5JTkcgQ09NTUVOVCwgQkVGT1JFIEFOWVRISU5HIEVMU0UuIEl0IGZsdXNoZXMgdGhlIHJlc3BvbnNlXG4gICAgICAvLyBoZWFkZXJzIGltbWVkaWF0ZWx5OiBzb21lIEhUVFAgY2xpZW50cyDigJQgQnVuJ3Mgb3duIGBmZXRjaCgpYCBpbmNsdWRlZCDigJRcbiAgICAgIC8vIGJ1ZmZlciB1bnRpbCB0aGUgZmlyc3QgYnl0ZSBvZiBib2R5IGFycml2ZXMsIHNvIGEgZ2VudWluZWx5IHF1aWV0IFNTRVxuICAgICAgLy8gc3RyZWFtIHdvdWxkIG90aGVyd2lzZSBsZWF2ZSB0aGUgY2FsbGVyJ3MgYGZldGNoKClgIHVucmVzb2x2ZWQuIEV2ZXJ5XG4gICAgICAvLyBob3VzZSB0YWlsIGNsaWVudCByZWFkcyBgOmAgbGluZXMgYXMgY29tbWVudHMgYW5kIGRyb3BzIHRoZW0uXG4gICAgICBzYWZlRW5xdWV1ZShcIjogY29ubmVjdGVkXFxuXFxuXCIpO1xuXG4gICAgICB1bnN1YnNjcmliZSA9IGxvZy5zdWJzY3JpYmUoc2luY2UsIChmcmFtZSkgPT4ge1xuICAgICAgICBpZiAoZmlsdGVyICYmICFmaWx0ZXIoZnJhbWUpKSByZXR1cm47XG4gICAgICAgIHNhZmVFbnF1ZXVlKGBkYXRhOiAke0pTT04uc3RyaW5naWZ5KGZyYW1lKX1cXG5cXG5gKTtcbiAgICAgIH0pO1xuXG4gICAgICBrZWVwYWxpdmUgPSBzZXRJbnRlcnZhbCgoKSA9PiBzYWZlRW5xdWV1ZShcIjogaGJcXG5cXG5cIiksIGhlYXJ0YmVhdE1zKTtcbiAgICAgIHNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIHRlYXJkb3duLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICBjbGllbnRzPy5hZGQoY2xpZW50KTtcbiAgICAgIG9uT3Blbj8uKCk7XG4gICAgfSxcbiAgICBjYW5jZWwoKSB7XG4gICAgICB0ZWFyZG93bigpO1xuICAgIH0sXG4gIH0pO1xuXG4gIHJldHVybiBuZXcgUmVzcG9uc2Uoc3RyZWFtLCB7XG4gICAgaGVhZGVyczoge1xuICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJ0ZXh0L2V2ZW50LXN0cmVhbVwiLFxuICAgICAgXCJDYWNoZS1Db250cm9sXCI6IFwibm8tY2FjaGVcIixcbiAgICAgIENvbm5lY3Rpb246IFwia2VlcC1hbGl2ZVwiLFxuICAgIH0sXG4gIH0pO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKiBUaGUgc2VydmVyJ3MgYGlkbGVUaW1lb3V0YCwgaW4gU0VDT05EUywgY2xhbXBlZCB0byB3aGF0IEJ1biBhY2NlcHRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlkbGVUaW1lb3V0U2VjKHJhdz86IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2sgPSBNQVhfSURMRV9USU1FT1VUX1NFQyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfSURMRV9USU1FT1VUX1NFQywgaW50T3IocmF3LCBmYWxsYmFjaykpKTtcbn1cblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCwgaW4gbXMsIENMQU1QRUQgVE8gSEFMRiB0aGUgaWRsZSB0aW1lb3V0LlxuICpcbiAqIFRoZSBjbGFtcCBpcyBhc3Ryb2xhYmUncywgYW5kIHRoZSBjZW5zdXMgbmFtZWQgaXQgY29udmVyZ2VuY2UgdGFyZ2V0ICM0OiB0aGVcbiAqIG90aGVyIGRhZW1vbnMgaGFyZC1jb2RlIDE1IHMgYWdhaW5zdCAyNTUgcyBhbmQgd3JpdGUgdGhlIHJlbGF0aW9uc2hpcCBvbmx5IGluXG4gKiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBFbmZvcmNpbmdcbiAqIGBoZWFydGJlYXQgPD0gaWRsZVRpbWVvdXQgLyAyYCBtYWtlcyB0aGUgaW52YXJpYW50IHRydWUgZm9yIEFOWSBjb25maWd1cmVkXG4gKiBwYWlyLCB3aGljaCBpcyBleGFjdGx5IHRoZSBpbnZhcmlhbnQgd2hvc2UgdmlvbGF0aW9uIGNhdXNlZCB0aGUgYnVnIGFib3ZlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5taW4oaW50T3IocmF3LCBmYWxsYmFjayksIE1hdGgubWF4KDUwMCwgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogSW1hZ28ncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aCBoYWx2ZXNcbiAqIG9mIHRoZSBzcGVsbC5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIFRIRSBTRUFNLCBBTkQgSVQgSVMgVEhFIENMRUFORVNUIFBST09GIFRIRSBQT1JUIFdPUktFRC5cbiAqIEJlZm9yZSBQaGFzZSAzIHRoZSBoZWFydGJlYXQgd2FzIGEgTElURVJBTCBgMTUwMDBgIGluc2lkZSBgc2VydmVyLnRzYCdzXG4gKiBgc3NlUmVzcG9uc2VgLCBzaXR0aW5nIHVuZGVyIGEgY29tbWVudCBhYm91dCBgaWRsZVRpbWVvdXQ6IDI1NWAgd3JpdHRlbiAxLDMwMFxuICogbGluZXMgYXdheSBpbiBhIGRpZmZlcmVudCBmdW5jdGlvbiDigJQgYW5kIGBjbGkudHNgIGhhZCBOTyBjb3JyZXNwb25kaW5nIG51bWJlclxuICogYXQgYWxsOiBpdHMgdGFpbCBsb29wIGJsb2NrZWQgb24gYHJlYWRlci5yZWFkKClgIHdpdGggbm8gd2F0Y2hkb2csIHdoaWNoIGlzXG4gKiB0aGUgZmFpbHVyZSBgdGFpbEV2ZW50c2AgZXhpc3RzIHRvIGVuZC4gTmVpdGhlciBmaWxlIGNvdWxkIGltcG9ydCB0aGUgb3RoZXIsXG4gKiBiZWNhdXNlIHRoZSBDTEkgcmVhY2hpbmcgaW50byB0aGUgZGFlbW9uIHdvdWxkIGRyYWcgdGhlIHdob2xlIHNlcnZlciBncmFwaFxuICogaW50byBgZGlzdC9jbGkuanNgLiBBIG1vZHVsZSB3aG9zZSBvbmx5IGltcG9ydHMgYXJlIHRoZSBraXQncyBkZXJpdmF0aW9ucyBoYXNcbiAqIG5vIHN1Y2ggZ3JhcGgsIHNvIGJvdGggaGFsdmVzIGltcG9ydCB0aGlzIG9uZS4gQSB2YWx1ZSB0aGF0IGNvdWxkIG5vdFxuICogcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFdBVENIRE9HIElTIERFUklWRUQgRlJPTSBJTUFHTydTIE9XTiBIRUFSVEJFQVQsIE5FVkVSIENPUElFRFxuICogRlJPTSBBIFNJQkxJTkcuKiogQXN0cm9sYWJlIGJlYXRzIGF0IDEwIHMgYW5kIGltYWdvIGF0IDE1IHMsIHNvIGEgaGFyZC1jb2RlZFxuICogd2F0Y2hkb2cgaXMgY29ycmVjdCBmb3IgYXQgbW9zdCBvbmUgb2YgdGhlbS4gQXN0cm9sYWJlIG1lYXN1cmVkIHdoYXQgYSBjb3BpZWRcbiAqIG51bWJlciBkb2VzOiBhIDQ1IHMgd2F0Y2hkb2cgYWdhaW5zdCBhbiBlbnYtdHVuZWQgaGVhcnRiZWF0IHByb2R1Y2VkXG4gKiByZWNvbm5lY3RzIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeVxuICogZGFlbW9uLCBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYW4gdW5yZWxhdGVkIHRoaXJkIGNvbnN0YW50IGFic29yYmVkIHRoZSBjaHVybi5cbiAqIGB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpYCBjYW5ub3QgZHJpZnQgZnJvbSB0aGUgYmVhdCBpdCBpcyB3YXRjaGluZyxcbiAqIHdoYXRldmVyIHRoZSBiZWF0IGJlY29tZXMuXG4gKlxuICog4pqgIEtFRVAgSVQgQSBMRUFGLVNIQVBFRCBGSUxFLiBUaGUgbW9tZW50IHRoaXMgaW1wb3J0cyBhbnl0aGluZyBvZiB0aGVcbiAqIGRhZW1vbidzLCB0aGUgQ0xJIGlzIGJhY2sgdG8gZHJhZ2dpbmcgdGhlIHNlcnZlciBncmFwaCBhbmQgdGhlIHNlYW0gY2xvc2VzLlxuICovXG5cbmltcG9ydCB7XG4gIERFRkFVTFRfSEVBUlRCRUFUX01TLFxuICBoZWFydGJlYXRNcyxcbiAgaWRsZVRpbWVvdXRTZWMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKlxuICogQnVuJ3MgbWF4aW11bSwgYW5kIGl0IGlzIGltYWdvJ3Mgb3duIG1lYXN1cmVkIHZhbHVlIHJhdGhlciB0aGFuIGFuIGluaGVyaXRlZFxuICogb25lOiBgc2VydmVyLnRzYCBjYXJyaWVkIGBpZGxlVGltZW91dDogMjU1YCB1bmRlciBhIGNvbW1lbnQgcmVjb3JkaW5nIHRoYXRcbiAqIEJ1bidzIGRlZmF1bHQgMTAgcyBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZSB0aGUgMTUgcyBrZWVwYWxpdmVcbiAqIGV2ZXIgZmlyZXMg4oCUIFwidGhlIGtlZXBhbGl2ZSBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiBrZWVwaW5nIGFsaXZlIGlzIGdvbmVcIiwgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGJlYXQgcmF0ZSB3b3VsZCBub3QgaGF2ZVxuICogaGVscGVkLiBgSU1BR09fSURMRV9USU1FT1VUX1NFQ2AgaXMgYWNjZXB0ZWQgc28gdGhlIHBhaXIgY2FuIGJlIHR1bmVkXG4gKiBUT0dFVEhFUjsgdGhlIGNsYW1wIGJlbG93IGlzIHdoYXQga2VlcHMgdGhlbSBhIHBhaXIuXG4gKi9cbmV4cG9ydCBjb25zdCBJRExFX1RJTUVPVVRfU0VDID0gaWRsZVRpbWVvdXRTZWMoXG4gIHByb2Nlc3MuZW52LklNQUdPX0lETEVfVElNRU9VVF9TRUMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuKTtcblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCDigJQgaW1hZ28ncyBvd24gbGl0ZXJhbCAxNSBzIGJlZm9yZSB0aGlzIGZpbGUgZXhpc3RlZCwgbm93XG4gKiBDTEFNUEVEIHRvIGhhbGYgdGhlIGlkbGUgdGltZW91dC5cbiAqXG4gKiDim5QgVEhFIENMQU1QIElTIFRIRSBGSVggRk9SIFRIRSBCVUcgVEhJUyBTUEVMTCBBTFJFQURZIFBBSUQgRk9SLiBUaGUgb2xkIGNvZGVcbiAqIHdyb3RlIDE1IHMgYW5kIDI1NSBzIGluIHR3byBkaWZmZXJlbnQgZnVuY3Rpb25zIGFuZCByZWNvcmRlZCB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIERlcml2aW5nIGl0XG4gKiBtYWtlcyBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWQgcGFpci5cbiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBoZWFydGJlYXRNcyhcbiAgcHJvY2Vzcy5lbnYuSU1BR09fSEVBUlRCRUFUX01TLFxuICBJRExFX1RJTUVPVVRfU0VDLFxuICBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbik7XG5cbi8qKlxuICogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cywgREVSSVZFRC5cbiAqXG4gKiDimqAgNDUsMDAwIG1zIGF0IHRoZSBkZWZhdWx0cy4gaW1hZ28ncyBDTEkgaGFzIG5vIGAtLXN0YXJ0LXRpbWVvdXRgOyB0aGUgbnVtYmVyXG4gKiBpdCBtaWdodCBiZSBjb25mdXNlZCB3aXRoIGlzIGBjbWRPcGVuYCdzIDUsMDAwIG1zIHN0YXJ0IGRlYWRsaW5lLCB3aGljaCBpcyBhXG4gKiBkaWZmZXJlbnQgcXVhbnRpdHkgZW50aXJlbHkg4oCUIG9uZSBib3VuZHMgYSBmaXJzdCBidW5kbGUgYnVpbGQsIHRoZSBvdGhlclxuICogYm91bmRzIGEgc2lsZW50IHNvY2tldC4gTmFtZWQgaGVyZSBzbyBub2JvZHkgbGF0ZXIgXCJkZS1kdXBsaWNhdGVzXCIgdGhlbS5cbiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUyk7XG4iLAogICAgIi8vIHNoYXJlZC9pbWFnZU9wdGltaXplLnRzXG4vLyBCcm93c2VyLXNhZmUgaW1hZ2Utb3B0aW1pemF0aW9uIFBPTElDWSwgdXNlZCBieSBCT1RIIHNpZGVzIOKAlCB0aGUgYnJvd3NlciBkcm9wXG4vLyBwYXRoIChzdXJmYWNlL3N0YXRlL2ZpbGVJbnRha2UudHMpIGFuZCB0aGUgZGFlbW9uIHZhcmlhbnQgcGF0aFxuLy8gKHNjcmlwdHMvaW1hZ2VPcHRpbWl6ZS5zZXJ2ZXIudHMpLiBUd28tc2lkZWQgYnkgUjEncyB0ZXN0LCBzbyBpdCBsaXZlcyBpblxuLy8gc2hhcmVkLyByYXRoZXIgdGhhbiB3aXRoIGVpdGhlciBjb25zdW1lci4gTm8gbmF0aXZlIGRlcHMgaGVyZSDigJQgc2FmZSB0b1xuLy8gaW1wb3J0IGludG8gdGhlIFJlYWN0IGJ1bmRsZS4gVGhlIEJ1bi5JbWFnZSBpbXBsZW1lbnRhdGlvbiB0aGF0IGFwcGxpZXMgdGhpc1xuLy8gcG9saWN5IGxpdmVzIGluIHNjcmlwdHMvaW1hZ2VPcHRpbWl6ZS5zZXJ2ZXIudHMuXG5leHBvcnQgY29uc3QgT1BUSU1JWkUgPSB7IG1heERpbTogMTIwMCwgcXVhbGl0eTogMC44NSB9IGFzIGNvbnN0O1xuIiwKICAgICIvLyBzY3JpcHRzL2ltYWdlT3B0aW1pemUuc2VydmVyLnRzXG4vLyBEYWVtb24tb25seTogbmF0aXZlIEJ1bi5JbWFnZSBkb3duc2NhbGUrd2VicC4gSXQgbGl2ZXMgaW4gc2NyaXB0cy8gYmVjYXVzZVxuLy8gb25seSB0aGUgZGFlbW9uIGV4ZWN1dGVzIGl0IChSMSdzIHRocmVlLXdheSBzb3J0IOKAlCB0aGUgYC5zZXJ2ZXIudHNgIHN1ZmZpeFxuLy8gYWxyZWFkeSBzYWlkIHNvKTsgdGhlIFBPTElDWSBpdCBhcHBsaWVzIGlzIHR3by1zaWRlZCBhbmQgbGl2ZXMgaW4gc2hhcmVkLy5cbi8vIERvIE5PVCBpbXBvcnQgdGhpcyBmcm9tIGJyb3dzZXIgY29kZSAoQnVuLkltYWdlIGlzIGEgQnVuIHJ1bnRpbWUgYnVpbHQtaW4sXG4vLyBhYnNlbnQgaW4gdGhlIGJyb3dzZXIpLiBCcm93c2VyIGNvZGUgaW1wb3J0cyBPUFRJTUlaRSBmcm9tIHNoYXJlZC9pbWFnZU9wdGltaXplLlxuaW1wb3J0IHsgT1BUSU1JWkUgfSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2ltYWdvL3NoYXJlZC9pbWFnZU9wdGltaXplXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBvcHRpbWl6ZUltYWdlQnVmZmVyKFxuICBpbnB1dDogVWludDhBcnJheSxcbik6IFByb21pc2U8eyBkYXRhOiBVaW50OEFycmF5OyBtaW1lOiBcImltYWdlL3dlYnBcIiB9PiB7XG4gIGNvbnN0IGRhdGEgPSBhd2FpdCBuZXcgQnVuLkltYWdlKGlucHV0KVxuICAgIC5yZXNpemUoT1BUSU1JWkUubWF4RGltLCBPUFRJTUlaRS5tYXhEaW0sIHtcbiAgICAgIGZpdDogXCJpbnNpZGVcIixcbiAgICAgIHdpdGhvdXRFbmxhcmdlbWVudDogdHJ1ZSxcbiAgICB9KVxuICAgIC53ZWJwKHsgcXVhbGl0eTogTWF0aC5yb3VuZChPUFRJTUlaRS5xdWFsaXR5ICogMTAwKSB9KVxuICAgIC5ieXRlcygpO1xuICByZXR1cm4geyBkYXRhOiBuZXcgVWludDhBcnJheShkYXRhKSwgbWltZTogXCJpbWFnZS93ZWJwXCIgfTtcbn1cbiIKICBdLAogICJtYXBwaW5ncyI6ICI7Ozs7O0FBNEJBLHVCQUFTLHdDQUF1Qix5QkFBYyx1QkFBUSw4QkFBWTtBQUNsRTtBQUNBLDBCQUFrQjtBQUNsQjtBQUNBOzs7QUNxSk8sSUFBTSxhQUFzQztBQUFBLEVBQ2pEO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0Y7QUErTU8sSUFBTSxvQkFBb0IsT0FBTyxPQUFPO0FBQUEsRUFDN0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRixDQUFVO0FBb0NWLElBQU0sc0JBQXNCLENBQUMsU0FBUyxhQUFhLGFBQWEsTUFBTSxjQUFjLFVBQVU7QUFFdkYsSUFBTSxVQUFVLENBQUMsU0FBaUIsU0FBUyxLQUFLLEtBQUssRUFBRSxZQUFZLEVBQUUsUUFBUSxRQUFRLEdBQUc7QUFFL0YsSUFBTSxrQkFBa0M7QUFBQSxFQUN0QztBQUFBLElBQ0UsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sU0FBUztBQUFBLEVBQ1g7QUFBQSxFQUNBO0FBQUEsSUFDRSxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixNQUFNO0FBQUEsSUFDTixTQUFTO0FBQUEsRUFDWDtBQUFBLEVBQ0E7QUFBQSxJQUNFLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLE1BQU07QUFBQSxJ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LEVBWUYsTUFBTSxtQkFBbUIsTUFBTTtBQUFBLElBQzdCLElBQUk7QUFBQSxNQUNGLFlBQVcsV0FBVztBQUFBLE1BQ3RCLE1BQU07QUFBQSxJQUdSLGdCQUFnQixZQUFZLFdBQVcsQ0FBQyxRQUFRO0FBQUEsTUFDOUMsSUFBSTtBQUFBLFFBQ0YsTUFBTSxLQUFNLEtBQUssTUFBTSxHQUFHLEVBQStCO0FBQUEsUUFDekQsT0FBTyxPQUFPLE9BQU8sV0FBVyxLQUFLO0FBQUEsUUFDckMsTUFBTTtBQUFBLFFBQ04sT0FBTztBQUFBO0FBQUEsS0FFVjtBQUFBLElBQ0QsSUFBSTtBQUFBLE1BQ0YsSUFBSTtBQUFBLFFBQWlCLFFBQU8saUJBQWlCLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsTUFDN0UsTUFBTTtBQUFBO0FBQUEsRUFLVixJQUFJLENBQUMsRUFBRTtBQUFBLElBQVksWUFBWSxHQUFHO0FBQUEsRUFlbEMsTUFBTSxtQkFBbUIsa0JBQWtCO0FBQUEsSUFDekMsaUJBQWlCLE1BQU0sUUFBUSxPQUFPLFdBQVc7QUFBQSxJQUNqRCxRQUFRLE1BQU0sWUFBWSxJQUFJLElBQUk7QUFBQSxJQUNsQztBQUFBLElBQ0EsV0FBVyxVQUFVO0FBQUEsSUFDckIsYUFBYSxNQUFNLFlBQVksRUFBRSxNQUFNLEtBQUssUUFBUSxVQUFVLENBQUM7QUFBQSxJQUMvRCxVQUFVO0FBQUEsTUFDUixPQUFPLE1BQU07QUFBQSxNQUNiLE9BQU8sTUFBTTtBQUFBLFFBQ1gsWUFBWTtBQUFBO0FBQUEsTUFJZCxPQUFPO0FBQUEsSUFDVDtBQUFBLEVBQ0YsQ0FBQztBQUFBLEVBRUQsUUFBUSxNQUFNLFdBQVcsTUFBTTtBQUFBLEVBQy9CLGlCQUFpQjtBQUFBLEVBQ2pCLGFBQWE7QUFBQSxFQUNiLFVBQVUsRUFBRSxNQUFNLFVBQVUsT0FBTyxDQUFDO0FBQUEsRUFDcEMsVUFBVSxFQUFFLE1BQU0sV0FBVyxNQUFNLGtCQUFrQixTQUFTLENBQUM7QUFBQSxFQVUvRCxNQUFNLGFBQWEsRUFBRSxRQUFRLFNBQVMsWUFBWSxRQUFRLENBQUM7QUFBQSxFQUMzRCxpQkFBaUI7QUFBQSxFQUNqQixPQUFPO0FBQUE7QUF3QlQsZUFBc0IsR0FBRyxHQUFvQjtBQUFBLEVBQzNDLE9BQU8sTUFBTSxLQUFLLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztBQUFBOyIsCiAgImRlYnVnSWQiOiAiRjE3MjYxQzRFMzE2MzE3QjY0NzU2RTIxNjQ3NTZFMjEiLAogICJuYW1lcyI6IFtdCn0=
