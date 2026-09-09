#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// src/imago/backend/server.ts
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
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
var IMAGO_HOME = process.env.IMAGO_HOME ?? join(homedir(), ".imago");
var SNAPSHOTS_DIR = join(IMAGO_HOME, "snapshots");
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
  const path = join(dir, `${safeId}${ext}`);
  try {
    writeFileSync(path, Buffer.from(m[2], "base64"));
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
  const assetsDir = join(SCRIPT_DIR, "..", "assets");
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
    const restorePath = existsSync(v.restore) ? v.restore : join(SNAPSHOTS_DIR, `${v.restore}.json`);
    try {
      const snap = JSON.parse(readFileSync(restorePath, "utf8"));
      state = { ...defaultState(v.title), ...snap };
      restored = true;
    } catch (e) {
      process.stderr.write(`imago: restore failed (${restorePath}): ${e instanceof Error ? e.message : String(e)}
`);
    }
  }
  const sockets = new Set;
  const enc = new TextEncoder;
  const events = [];
  let eventSeq = 0;
  const sseClients = new Set;
  const sseTimers = new Set;
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
  function emitEvent(msg) {
    const ev = { id: ++eventSeq, ...msg };
    events.push(ev);
    const frame = enc.encode(`data: ${JSON.stringify(ev)}

`);
    for (const c of sseClients) {
      try {
        c.enqueue(frame);
      } catch {}
    }
  }
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
      writeFileSync(join(SNAPSHOTS_DIR, `${sessionId}.json`), JSON.stringify(state));
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
  function sseResponse(url2) {
    touch();
    const since = parseInt(url2.searchParams.get("since") ?? "-1", 10);
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
        hb = setInterval(() => {
          try {
            controller.enqueue(enc.encode(`: hb

`));
          } catch {}
        }, 15000);
        sseTimers.add(hb);
      },
      cancel() {
        if (hb) {
          clearInterval(hb);
          sseTimers.delete(hb);
        }
        if (ref)
          sseClients.delete(ref);
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
            unlinkSync(toDelete.imagePath);
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
  const mode = resolveMode();
  const devIndex = mode === "dev" ? (await import("../../../../../src/imago/surface/index.html")).default : undefined;
  const routes = devIndex ? { "/": devIndex } : {};
  let server;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      routes,
      idleTimeout: 255,
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
          const lean = url2.searchParams.get("lean") === "1";
          const payload = lean ? leanState(state) : state;
          return new Response(JSON.stringify({ state: payload, cursor: eventSeq }), {
            headers: { "Content-Type": "application/json" }
          });
        }
        if (req.method === "GET" && path === "/events") {
          return sseResponse(url2);
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
          const f = Bun.file(join(assetsDir, assetName));
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
          emitEvent({ type: "connected" });
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
          emitEvent({ type: "disconnected" });
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
  sessionFilesDir = join(tmpdir(), `${sessionId}-files`);
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
  const sessionFile = join(tmpdir(), `imago-${sessionId}.json`);
  const latestFile = join(tmpdir(), `imago-latest.json`);
  const sessionInfo = JSON.stringify({
    url,
    port: boundPort,
    session_id: sessionId,
    title: state.title,
    files_dir: sessionFilesDir,
    mode
  });
  const writeAtomic = (target, text) => {
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
  };
  try {
    writeAtomic(sessionFile, sessionInfo);
    writeAtomic(latestFile, sessionInfo);
  } catch (e) {
    process.stderr.write(`imago: could not write discovery file: ${e instanceof Error ? e.message : String(e)}
`);
  }
  const cleanupDiscovery = async () => {
    try {
      unlinkSync(sessionFile);
    } catch {}
    try {
      const cur = await Bun.file(latestFile).text();
      if (JSON.parse(cur).session_id === sessionId)
        unlinkSync(latestFile);
    } catch {}
    try {
      if (sessionFilesDir)
        rmSync(sessionFilesDir, { recursive: true, force: true });
    } catch {}
  };
  if (!v["no-open"])
    openBrowser(url);
  const idleTimer = setInterval(() => {
    if ((performance.now() - lastActivity) / 1000 >= timeout) {
      resolveDone({ code: 124, reason: "timeout" });
    }
  }, 250);
  const snapTimer = setInterval(() => {
    if (snapDirty) {
      snapDirty = false;
      saveSnapshot();
    }
  }, 1000);
  const { code, reason } = await done;
  clearInterval(idleTimer);
  clearInterval(snapTimer);
  saveSnapshot();
  emitEvent({ type: "closed", reason });
  broadcast({ type: "message", text: `session ended: ${reason}` });
  await new Promise((r) => setTimeout(r, 150));
  for (const t of sseTimers)
    clearInterval(t);
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
  await cleanupDiscovery();
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

//# debugId=430C84ABCEB8C89B64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2ltYWdvL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uL3NoYXJlZC90eXBlcy50cyIsICIuLi9zaGFyZWQvaW1hZ2VPcHRpbWl6ZS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvaW1hZ28vYmFja2VuZC9pbWFnZU9wdGltaXplLnNlcnZlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIjIS91c3IvYmluL2VudiBidW5cblxuLy8gaW1hZ28g4oCUIGFuIGFnZW50LWRyaXZlbiBpbWFnZSBjYW52YXMgdGhlIHVzZXIgd29ya3MgaW5zaWRlLlxuLy9cbi8vIGltYWdvIGlzIGEgR1JPVU5ERUQgQ09OVkVSU0FUSU9OIGFib3V0IGFuIGltYWdlOiB0aGUgdXNlciBhbmQgdGhlIGFnZW50IHRhbGtcbi8vICh0aGUgY29udmVyc2F0aW9uKSwgdGhlIHN1cmZhY2UgaG9sZHMgdGhlIGFydGlmYWN0cyAoYmF0Y2hlcyBvZiBrZXB0XG4vLyBnZW5lcmF0aW9ucywgdGhlIGZvY3VzZWQgb25lIG9uIHRoZSBjYW52YXMpLCBhbmQgc3VyZmFjZSBnZXN0dXJlcyAobGlraW5nLFxuLy8gbWFya2luZywgYXR0YWNoaW5nIGEgcmVmKSBhcmUgbWVzc2FnZXMgdGhlIGFnZW50IGhlYXJzLiBJdCdzIGEgbG9vcCwgbm90IGFcbi8vIGZ1bm5lbCDigJQgbm8gcGhhc2UgcGlwZWxpbmUuXG4vL1xuLy8gQXJjaGl0ZWN0dXJlIChjbGkudHMgd3JhcHMgdGhpcyk6XG4vLyAgIC0gQWdlbnQg4oaUIHNlcnZlcjogSFRUUCBvbiB0aGUgc2FtZSBCdW4uc2VydmUuXG4vLyAgICAgICBQT1NUIC9jbWQgICAgICAgICAgICDigJQgYWdlbnQgY29tbWFuZCAoSlNPTjsgQWdlbnRDb21tYW5kIHVuaW9uKVxuLy8gICAgICAgR0VUICAvc3RhdGVbP2xlYW49MV0g4oCUIGZ1bGwgc25hcHNob3QgeyBzdGF0ZSwgY3Vyc29yIH07IGxlYW4gc3RyaXBzIGJsb2JzXG4vLyAgICAgICBHRVQgIC9ldmVudHM/c2luY2U9TiDigJQgU1NFIHN0cmVhbSBvZiB1c2VyIGV2ZW50cyAoTW9uaXRvci13cmFwcGFibGUpXG4vLyAgIC0gU2VydmVyIOKGlCBicm93c2VyOiBXZWJTb2NrZXQgYXQgL3dzIChDbGllbnRUb1NlcnZlciAvIFNlcnZlclRvQ2xpZW50KS5cbi8vICAgLSBTZXJ2ZXIgaG9sZHMgY2Fub25pY2FsIHN0YXRlOyBmdWxsLXN0YXRlIGJyb2FkY2FzdCB0byBicm93c2VycyBvbiBjaGFuZ2UuXG4vL1xuLy8gSU1QT1JUQU5UIChob3VzZS1zdHlsZToga2VlcCB0aGUgY2xpZW50IHRoaW4sIHRoZSBhZ2VudCBpcyB0aGUgcnVudGltZSk6IHRoZVxuLy8gc2VydmVyIGRvZXMgTk9UIGdlbmVyYXRlIGltYWdlcy4gR2VuZXJhdGlvbiBoYXBwZW5zIGFnZW50LXNpZGUgKG1lZGlhLWZvcmdlLFxuLy8gb3V0IG9mIGJhbmQpOyB0aGUgYWdlbnQgcG9zdHMgcmVzdWx0cyB2aWEgYmF0Y2guYWRkLiBUaGUgc3VyZmFjZSBkaXNwbGF5cyArXG4vLyBjb2xsZWN0cyB0aGUgY29udmVyc2F0aW9uIGFuZCBnZXN0dXJlcy5cbi8vXG4vLyBBZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKSBhbmQgdXNlciBldmVudHMgKEdFVCAvZXZlbnRzKSBhcmUgdGhlIEFnZW50Q29tbWFuZFxuLy8gdW5pb24gYW5kIEFHRU5UX0VWRU5UX1RZUEVTIGluIHNoYXJlZC90eXBlcy50cyDigJQgdGhlIHNpbmdsZSBjb250cmFjdC5cbi8vXG4vLyBFeGl0IGNvZGVzOiAwIHN1Ym1pdC9jbG9zZSwgMiBiYWQgYXJncywgMTI0IGlkbGUgdGltZW91dCwgMTMwIGNhbmNlbC5cblxuaW1wb3J0IHtcbiAgZXhpc3RzU3luYyxcbiAgbWtkaXJTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHJlbmFtZVN5bmMsXG4gIHJtU3luYyxcbiAgdW5saW5rU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIsIHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHR5cGUgeyBTZXJ2ZXJXZWJTb2NrZXQgfSBmcm9tIFwiYnVuXCI7XG5pbXBvcnQge1xuICB0eXBlIEJhdGNoLFxuICB0eXBlIENvbnRleHRFbnRyeSxcbiAgdHlwZSBDb250ZXh0S2luZCxcbiAgdHlwZSBDb250ZXh0U2V0LFxuICBkZWZhdWx0U3RhdGUsXG4gIHR5cGUgSW1hZ29TdGF0ZSxcbiAgdHlwZSBMYXllcixcbiAgTUFSS19UT09MUyxcbiAgdHlwZSBNYXJrLFxuICB0eXBlIE1lc3NhZ2UsXG4gIHN0eWxlSWQsXG4gIHR5cGUgVmFyaWFudCxcbn0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9pbWFnby9zaGFyZWQvdHlwZXNcIjtcbmltcG9ydCB7IG9wdGltaXplSW1hZ2VCdWZmZXIgfSBmcm9tIFwiLi9pbWFnZU9wdGltaXplLnNlcnZlclwiO1xuXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuXG4vLyDilIDilIAgc3VyZmFjZSBtb2RlIChzZWFtcyBDb250cmFjdCAxKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyBgaW1wb3J0IGluZGV4IGZyb20gXCIuLi9zdXJmYWNlL2luZGV4Lmh0bWxcImAgdXNlZCB0byBzaXQgYXQgdGhlIHRvcCBvZiB0aGlzXG4vLyBmaWxlLiBBIHRvcC1sZXZlbCBTVEFUSUMgaW1wb3J0IGZvcmNlcyBCdW4gdG8gcmVzb2x2ZSB0aGUgd2hvbGUgLnRzeCArXG4vLyBUYWlsd2luZCBidWlsZCBncmFwaCB3aGVuIHRoZSBtb2R1bGUgTE9BRFMsIHNvIGEgZGVzdGluYXRpb24gdGhhdCBzaGlwc1xuLy8gZGlzdC8gYW5kIG5vIHN1cmZhY2UvIOKAlCB0aGUgcHVibGlzaGVkIGFydGlmYWN0IOKAlCBkaWVzIGJlZm9yZSBpdCBjYW4gc2VydmVcbi8vIHRoZSBkaXN0IGl0IGRvZXMgaGF2ZS4gVGhlIGRldiBpbXBvcnQgaXMgdGhlcmVmb3JlIGR5bmFtaWMgYW5kIGluc2lkZSB0aGVcbi8vIHJlbGVhc2UgYnJhbmNoJ3MgYGVsc2VgLCBhcyBtaW5kLW1hcHBlciBhbmQgYXN0cm9sYWJlIGJvdGggZG8gaXQuXG4vL1xuLy8gUGF0aHMgYW5jaG9yIGF0IHRoZSBTS0lMTCBST09ULCBuZXZlciBhdCBjd2Q6IGNsaS50cyBwaW5zIHRoZSBkYWVtb24ncyBjd2Rcbi8vIGZvciBidW5maWcudG9tbCdzIHNha2UgKENvbnRyYWN0IDUpLCBzbyBjd2QgaXMgbm90IGEgc3RhYmxlIGJhc2UgZm9yIGRpc3QvLlxuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG5cbi8vIHJlbGVhc2UgaWZmIGRpc3QvaW5kZXguaHRtbCBleGlzdHMgYXQgdGhlIHNraWxsIHJvb3QsIGVsc2UgZGV2OyB0aGUgZW52XG4vLyBvdmVycmlkZSB3aW5zIGVpdGhlciB3YXkgKHNlYW1zIENvbnRyYWN0IDEpLiBSZWxlYXNlOiB6ZXJvIHJlYWRzIG9mIHN1cmZhY2UvXG4vLyBvciBidW5maWcudG9tbCDigJQgc3RhdGljIGZpbGVzIG9ubHkuXG5mdW5jdGlvbiByZXNvbHZlTW9kZSgpOiBcImRldlwiIHwgXCJyZWxlYXNlXCIge1xuICBjb25zdCBvdmVycmlkZSA9IHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREU7XG4gIGlmIChvdmVycmlkZSA9PT0gXCJkZXZcIiB8fCBvdmVycmlkZSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBvdmVycmlkZTtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFwicmVsZWFzZVwiIDogXCJkZXZcIjtcbn1cblxuY29uc3QgU1RBVElDX0NPTlRFTlRfVFlQRVM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiLmh0bWxcIjogXCJ0ZXh0L2h0bWxcIixcbiAgXCIuanNcIjogXCJ0ZXh0L2phdmFzY3JpcHRcIixcbiAgXCIuY3NzXCI6IFwidGV4dC9jc3NcIixcbiAgXCIuanNvblwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbn07XG5cbi8vIFNlcnZlcyBkaXN0LyB2ZXJiYXRpbSDigJQgZW50cnkgaW5kZXguaHRtbCwgaGFzaGVkIGNodW5rLSouanMvY3NzIGJ5IHBhdGhcbi8vIChDb250cmFjdCAyJ3MgZmxhdCwgcmVsYXRpdmUtaHJlZiBsYXlvdXQpLiBQYXRoIHRyYXZlcnNhbCBndWFyZGVkIChhIHN0YXRpY1xuLy8gYXNzZXQgcmVxdWVzdCBpcyBhbHdheXMgYSBiYXJlIGZpbGVuYW1lLCBuZXZlciBuZXN0ZWQpLCB3aGljaCBpcyBhbHNvIHdoYXRcbi8vIGtlZXBzIHRoaXMgY2xlYXIgb2YgaW1hZ28ncyBvd24gL2Fzc2V0cy88bmFtZT4gcm91dGUgYWJvdmUgaXQuXG5mdW5jdGlvbiBzZXJ2ZURpc3QocGF0aDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgY29uc3QgcmVsID0gcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSk7XG4gIGlmIChyZWwuaW5jbHVkZXMoXCIuLlwiKSB8fCByZWwuaW5jbHVkZXMoXCIvXCIpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZmlsZSA9IGpvaW4oRElTVF9ESVIsIHJlbCk7XG4gIGlmICghZXhpc3RzU3luYyhmaWxlKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGV4dCA9IHJlbC5zbGljZShyZWwubGFzdEluZGV4T2YoXCIuXCIpKTtcbiAgcmV0dXJuIG5ldyBSZXNwb25zZShCdW4uZmlsZShmaWxlKSwge1xuICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogU1RBVElDX0NPTlRFTlRfVFlQRVNbZXh0XSA/PyBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiIH0sXG4gIH0pO1xufVxuXG4vLyBQZXJzaXN0ZW50IGhvbWUgZm9yIHNlc3Npb24gc25hcHNob3RzIChzdXJ2aXZlcyByZXN0YXJ0cywgdW5saWtlIHRtcGRpcikuXG5jb25zdCBJTUFHT19IT01FID0gcHJvY2Vzcy5lbnYuSU1BR09fSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuaW1hZ29cIik7XG5jb25zdCBTTkFQU0hPVFNfRElSID0gam9pbihJTUFHT19IT01FLCBcInNuYXBzaG90c1wiKTtcblxudHlwZSBDbG9zZVJlYXNvbiA9IFwic3VibWl0XCIgfCBcImNhbmNlbFwiIHwgXCJ0aW1lb3V0XCIgfCBcImNsb3NlXCI7XG50eXBlIERvbmVSZXN1bHQgPSB7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBDbG9zZVJlYXNvbiB9O1xuXG5jb25zdCBQT1JUX1NVRkZJWF9SRSA9IC8tcChcXGR7Miw1fSkkLztcblxuZnVuY3Rpb24gcGFyc2VQb3J0RnJvbVNlc3Npb25JZChzaWQ6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuICBjb25zdCBtID0gc2lkPy5tYXRjaChQT1JUX1NVRkZJWF9SRSk7XG4gIGlmICghbSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHBvcnQgPSBwYXJzZUludChtWzFdLCAxMCk7XG4gIHJldHVybiBwb3J0ID49IDEgJiYgcG9ydCA8PSA2NTUzNSA/IHBvcnQgOiBudWxsO1xufVxuXG5mdW5jdGlvbiByYW5kSGV4KGJ5dGVzOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBidWYgPSBuZXcgVWludDhBcnJheShieXRlcyk7XG4gIGNyeXB0by5nZXRSYW5kb21WYWx1ZXMoYnVmKTtcbiAgcmV0dXJuIEFycmF5LmZyb20oYnVmLCAoYikgPT4gYi50b1N0cmluZygxNikucGFkU3RhcnQoMiwgXCIwXCIpKS5qb2luKFwiXCIpO1xufVxuXG5mdW5jdGlvbiBuZXdJZChwcmVmaXg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtwcmVmaXh9LSR7cmFuZEhleCg0KX1gO1xufVxuXG4vLyBTdGFibGUgY29udGVudCBoYXNoIG9mIGEgcmVmZXJlbmNlJ3MgYnl0ZXMg4oCUIGRlZHVwZXMgaWRlbnRpY2FsIGFkZHMgYW5kIGtleXNcbi8vIHRoZSBhbmFseXNpcyBjYWNoZSAoc28gYSBkZWxldGXihpJyZS1hZGQgb2YgdGhlIHNhbWUgaW1hZ2UgcmV1c2VzIGl0cyByZWFkKS5cbmZ1bmN0aW9uIGNvbnRlbnRIYXNoKHM6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBuZXcgQnVuLkNyeXB0b0hhc2hlcihcInNoYTI1NlwiKS51cGRhdGUocykuZGlnZXN0KFwiaGV4XCIpLnNsaWNlKDAsIDE2KTtcbn1cblxuZnVuY3Rpb24gb3BlbkJyb3dzZXIodXJsOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgY21kID1cbiAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiXG4gICAgICA/IFtcIm9wZW5cIiwgdXJsXVxuICAgICAgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCJcbiAgICAgICAgPyBbXCJjbWRcIiwgXCIvY1wiLCBcInN0YXJ0XCIsIFwiXCIsIHVybF1cbiAgICAgICAgOiBbXCJ4ZGctb3BlblwiLCB1cmxdO1xuICB0cnkge1xuICAgIEJ1bi5zcGF3bih7IGNtZCwgc3Rkb3V0OiBcImlnbm9yZVwiLCBzdGRlcnI6IFwiaWdub3JlXCIgfSk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGJlc3QtZWZmb3J0ICovXG4gIH1cbn1cblxuY29uc3QgTUlNRV9CWV9FWFQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiLmh0bWxcIjogXCJ0ZXh0L2h0bWw7IGNoYXJzZXQ9dXRmLThcIixcbiAgXCIuY3NzXCI6IFwidGV4dC9jc3M7IGNoYXJzZXQ9dXRmLThcIixcbiAgXCIuanNcIjogXCJhcHBsaWNhdGlvbi9qYXZhc2NyaXB0OyBjaGFyc2V0PXV0Zi04XCIsXG4gIFwiLmpzb25cIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gIFwiLnBuZ1wiOiBcImltYWdlL3BuZ1wiLFxuICBcIi5qcGdcIjogXCJpbWFnZS9qcGVnXCIsXG4gIFwiLmpwZWdcIjogXCJpbWFnZS9qcGVnXCIsXG4gIFwiLmdpZlwiOiBcImltYWdlL2dpZlwiLFxuICBcIi5zdmdcIjogXCJpbWFnZS9zdmcreG1sXCIsXG4gIFwiLndlYnBcIjogXCJpbWFnZS93ZWJwXCIsXG4gIFwiLmljb1wiOiBcImltYWdlL3gtaWNvblwiLFxuICBcIi53b2ZmXCI6IFwiZm9udC93b2ZmXCIsXG4gIFwiLndvZmYyXCI6IFwiZm9udC93b2ZmMlwiLFxufTtcbmZ1bmN0aW9uIGd1ZXNzTWltZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBkb3QgPSBuYW1lLmxhc3RJbmRleE9mKFwiLlwiKTtcbiAgY29uc3QgZXh0ID0gZG90ID49IDAgPyBuYW1lLnNsaWNlKGRvdCkudG9Mb3dlckNhc2UoKSA6IFwiXCI7XG4gIHJldHVybiBNSU1FX0JZX0VYVFtleHRdIHx8IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCI7XG59XG5cbmNvbnN0IEVYVF9CWV9NSU1FOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcImltYWdlL3BuZ1wiOiBcIi5wbmdcIixcbiAgXCJpbWFnZS9qcGVnXCI6IFwiLmpwZ1wiLFxuICBcImltYWdlL2pwZ1wiOiBcIi5qcGdcIixcbiAgXCJpbWFnZS93ZWJwXCI6IFwiLndlYnBcIixcbiAgXCJpbWFnZS9naWZcIjogXCIuZ2lmXCIsXG4gIFwiaW1hZ2Uvc3ZnK3htbFwiOiBcIi5zdmdcIixcbn07XG5cbi8vIERlY29kZSBhIGBkYXRhOjxtaW1lPjtiYXNlNjQsPHBheWxvYWQ+YCBVUkwgdG8gYSBmaWxlIHRoZSBhZ2VudCBjYW4gUmVhZCAoaXRzXG4vLyB2aXNpb24gbmVlZHMgcmVhbCBwaXhlbHMpLiBSZXR1cm5zIHRoZSBwYXRoLCBvciBcIlwiIG9uIGFueSBmYWlsdXJlLlxuZnVuY3Rpb24gc2F2ZURhdGFVcmwoZGlyOiBzdHJpbmcsIGlkOiBzdHJpbmcsIGRhdGFVcmw6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG0gPSAvXmRhdGE6KFteO10rKTtiYXNlNjQsKC4qKSQvcy5leGVjKGRhdGFVcmwpO1xuICBpZiAoIW0gfHwgIWRpcikgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IGV4dCA9IEVYVF9CWV9NSU1FW21bMV0udG9Mb3dlckNhc2UoKV0gPz8gXCIuYmluXCI7XG4gIC8vIGBpZGAgY2FuIGJlIGFnZW50LXN1cHBsaWVkIChiYXRjaC9yZWYgaWRzKSDigJQgc2FuaXRpemUgc28gaXQgY2FuJ3QgdHJhdmVyc2VcbiAgLy8gb3V0IG9mIHRoZSBzZXNzaW9uIGZpbGVzIGRpciB2aWEgYC4uYCBvciBhYnNvbHV0ZS1wYXRoIHNlZ21lbnRzLlxuICBjb25zdCBzYWZlSWQgPSBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV8tXS9nLCBcIl9cIik7XG4gIGNvbnN0IHBhdGggPSBqb2luKGRpciwgYCR7c2FmZUlkfSR7ZXh0fWApO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMocGF0aCwgQnVmZmVyLmZyb20obVsyXSwgXCJiYXNlNjRcIikpO1xuICAgIHJldHVybiBwYXRoO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gXCJcIjtcbiAgfVxufVxuXG4vLyDilIDilIAgYWdlbnQtZmFjaW5nIHByb2plY3Rpb25zOiBzdHJpcCB0aGUgKGh1Z2UpIGlubGluZWQgZGF0YS1VUkwgYmxvYnMuIFRoZVxuLy8gYWdlbnQgcmVhZHMgb24tZGlzayBgcGF0aGBzIGluc3RlYWQsIGtlZXBpbmcgL3N0YXRlIHNtYWxsIHJlZ2FyZGxlc3Mgb2Ygc2l6ZS5cbmZ1bmN0aW9uIHZhcmlhbnRGb3JBZ2VudCh2OiBWYXJpYW50KTogT21pdDxWYXJpYW50LCBcInNyY1wiPiB7XG4gIGNvbnN0IHsgc3JjOiBfZHJvcCwgLi4ucmVzdCB9ID0gdjtcbiAgcmV0dXJuIHJlc3Q7XG59XG5mdW5jdGlvbiBiYXRjaEZvckFnZW50KGI6IEJhdGNoKTogT21pdDxCYXRjaCwgXCJ2YXJpYW50c1wiPiAmIHsgdmFyaWFudHM6IE9taXQ8VmFyaWFudCwgXCJzcmNcIj5bXSB9IHtcbiAgcmV0dXJuIHsgLi4uYiwgdmFyaWFudHM6IGIudmFyaWFudHMubWFwKHZhcmlhbnRGb3JBZ2VudCkgfTtcbn1cbmZ1bmN0aW9uIGNvbnRleHRGb3JBZ2VudChlOiBDb250ZXh0RW50cnkpOiBPbWl0PENvbnRleHRFbnRyeSwgXCJpbWFnZVwiPiB7XG4gIGNvbnN0IHsgaW1hZ2U6IF9kcm9wLCAuLi5yZXN0IH0gPSBlO1xuICByZXR1cm4gcmVzdDsgLy8gYWdlbnQgcmVhZHMgaW1hZ2VQYXRoLCBub3QgdGhlIGlubGluZWQgYmxvYlxufVxuXG4vLyBTdHJpcCB0aGUgKGxhcmdlKSBpbmxpbmVkIGJpdG1hcCBmcm9tIGFuIGltYWdlLWxheWVyIG1hcmsgaW4gdGhlIGFnZW50XG4vLyBwcm9qZWN0aW9uIOKAlCB0aGUgYWdlbnQgcmVhZHMgdGhlIGZsYXR0ZW5lZCBjb21wb3NpdGUsIG5ldmVyIHBlci1sYXllciBiaXRtYXBzLlxuLy8gVmVjdG9yL3BpbiBtYXJrcyBwYXNzIHRocm91Z2ggdW5jaGFuZ2VkLlxuZnVuY3Rpb24gbWFya0ZvckFnZW50KG06IE1hcmspOiBNYXJrIHwgT21pdDxFeHRyYWN0PE1hcmssIHsgdG9vbDogXCJpbWFnZVwiIH0+LCBcInNyY1wiPiB7XG4gIGlmIChtLnRvb2wgPT09IFwiaW1hZ2VcIikge1xuICAgIGNvbnN0IHsgc3JjOiBfZHJvcCwgLi4ucmVzdCB9ID0gbTtcbiAgICByZXR1cm4gcmVzdDtcbiAgfVxuICByZXR1cm4gbTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxlYW5TdGF0ZShzOiBJbWFnb1N0YXRlKSB7XG4gIHJldHVybiB7XG4gICAgLi4ucyxcbiAgICBiYXRjaGVzOiBzLmJhdGNoZXMubWFwKGJhdGNoRm9yQWdlbnQpLFxuICAgIGxpYnJhcnk6IHMubGlicmFyeS5tYXAoY29udGV4dEZvckFnZW50KSxcbiAgICBtYXJrc0J5VmFyaWFudDogT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgT2JqZWN0LmVudHJpZXMocy5tYXJrc0J5VmFyaWFudCkubWFwKChbdmlkLCBtYXJrc10pID0+IFt2aWQsIG1hcmtzLm1hcChtYXJrRm9yQWdlbnQpXSksXG4gICAgKSxcbiAgfTtcbn1cblxuY29uc3QgSU1BR0VfREFUQV9VUkxfUkUgPSAvXmRhdGE6aW1hZ2VcXC9bYS16MC05ListXSs7YmFzZTY0LCguKikkL2lzO1xuXG4vLyBEb3duc2NhbGUrd2VicCBhbiBpbmxpbmVkIGltYWdlIGRhdGEtdXJsIGJlZm9yZSBpdCBlbnRlcnMgc3RhdGUgKHJhdyBtb2RlbFxuLy8gUE5HcyBhcmUgdGhlIGRvbWluYW50IHN0YXRlLWJsb2F0IHNvdXJjZSkuIE5vbi1kYXRhLXVybCBzcmNzIChodHRwLCBldGMuKSBhbmRcbi8vIGFueSBmYWlsdXJlIHBhc3MgdGhyb3VnaCB1bmNoYW5nZWQg4oCUIG9wdGltaXphdGlvbiBpcyBiZXN0LWVmZm9ydC5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBvcHRpbWl6ZVNyYyhzcmM6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IG0gPSBJTUFHRV9EQVRBX1VSTF9SRS5leGVjKHNyYyk7XG4gIGlmICghbSkgcmV0dXJuIHNyYztcbiAgdHJ5IHtcbiAgICBjb25zdCBpbnB1dCA9IG5ldyBVaW50OEFycmF5KEJ1ZmZlci5mcm9tKG1bMV0sIFwiYmFzZTY0XCIpKTtcbiAgICBjb25zdCB7IGRhdGEgfSA9IGF3YWl0IG9wdGltaXplSW1hZ2VCdWZmZXIoaW5wdXQpO1xuICAgIHJldHVybiBgZGF0YTppbWFnZS93ZWJwO2Jhc2U2NCwke0J1ZmZlci5mcm9tKGRhdGEpLnRvU3RyaW5nKFwiYmFzZTY0XCIpfWA7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBzcmM7XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybVN0eWxlKG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBuYW1lLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgbGV0IHBhcnNlZDogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VBcmdzPjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBwYXJzZUFyZ3Moe1xuICAgICAgYXJnczogYXJndixcbiAgICAgIG9wdGlvbnM6IHtcbiAgICAgICAgdGl0bGU6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVmYXVsdDogXCJpbWFnb1wiIH0sXG4gICAgICAgIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVmYXVsdDogXCIxODAwXCIgfSxcbiAgICAgICAgXCJuby1vcGVuXCI6IHsgdHlwZTogXCJib29sZWFuXCIsIGRlZmF1bHQ6IGZhbHNlIH0sXG4gICAgICAgIHBvcnQ6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVmYXVsdDogXCIwXCIgfSxcbiAgICAgICAgaG9zdDogeyB0eXBlOiBcInN0cmluZ1wiLCBkZWZhdWx0OiBcIjEyNy4wLjAuMVwiIH0sXG4gICAgICAgIGlkOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgcmVzdG9yZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sIC8vIHNuYXBzaG90IHBhdGggb3Igc2Vzc2lvbiBpZCB0byByZXN1bWVcbiAgICAgIH0sXG4gICAgICBzdHJpY3Q6IHRydWUsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiBmYWxzZSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBlcnJvcjogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuYCk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3QgdiA9IHBhcnNlZC52YWx1ZXM7XG4gIGNvbnN0IHRpbWVvdXQgPSBwYXJzZUZsb2F0KHYudGltZW91dCBhcyBzdHJpbmcpO1xuICBsZXQgcG9ydCA9IHBhcnNlSW50KHYucG9ydCBhcyBzdHJpbmcsIDEwKTtcbiAgY29uc3QgaG9zdCA9IHYuaG9zdCBhcyBzdHJpbmc7XG4gIGxldCBzZXNzaW9uSWQgPSAodi5pZCBhcyBzdHJpbmcgfCB1bmRlZmluZWQpID8/IFwiXCI7XG4gIGlmIChwb3J0ID09PSAwICYmIHNlc3Npb25JZCkge1xuICAgIGNvbnN0IGVtYmVkZGVkID0gcGFyc2VQb3J0RnJvbVNlc3Npb25JZChzZXNzaW9uSWQpO1xuICAgIGlmIChlbWJlZGRlZCAhPT0gbnVsbCkgcG9ydCA9IGVtYmVkZGVkO1xuICB9XG5cbiAgY29uc3QgYXNzZXRzRGlyID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiYXNzZXRzXCIpO1xuXG4gIGxldCBzdGF0ZSA9IGRlZmF1bHRTdGF0ZSh2LnRpdGxlIGFzIHN0cmluZyk7XG4gIGxldCByZXN0b3JlZCA9IGZhbHNlO1xuXG4gIC8vIEluLW1lbW9yeSwgcGVyLXZhcmlhbnQgbWFyay1lZGl0IGhpc3RvcnkgKHVuZG8vcmVkbykuIFNpdHVhdGlvbmFsIOKAlCBOT1RcbiAgLy8gc25hcHNob3R0ZWQsIHNvIGl0IHJlc2V0cyBvbiByZWRlcGxveTsgdGhhdCdzIGludGVuZGVkLiBFYWNoIG11dGF0aW5nIG1hcmsgb3BcbiAgLy8gc25hcHNob3RzIHRoZSBwcmUtbXV0YXRpb24gbWFya3MgZm9yIHRoYXQgdmFyaWFudCBvbnRvIGB1bmRvYCBhbmQgY2xlYXJzXG4gIC8vIGByZWRvYC4gQ2FwcGVkIHNvIGl0IGNhbid0IGdyb3cgd2l0aG91dCBib3VuZC5cbiAgY29uc3QgSElTVE9SWV9DQVAgPSAxMDA7XG4gIC8vIEEgaGlzdG9yeSBlbnRyeSBzbmFwc2hvdHMgQk9USCB0aGUgbWFya3MgQU5EIHRoZSBsYXllciBjb250YWluZXJzIGZvciBhXG4gIC8vIHZhcmlhbnQsIHNvIGEgbGF5ZXIgcmVuYW1lL3Jlb3JkZXIvdmlzaWJpbGl0eS9ncm91cCBvcCBpcyBhdG9taWNhbGx5IHVuZG9hYmxlXG4gIC8vIGFsb25nc2lkZSBlbGVtZW50IGVkaXRzIChjb250YWluZXIgbW9kZWwg4oCUIHNlZSB0eXBlIExheWVyKS5cbiAgdHlwZSBNYXJrU25hcCA9IHsgbWFya3M6IE1hcmtbXTsgbGF5ZXJzOiBMYXllcltdIH07XG4gIGNvbnN0IG1hcmtIaXN0b3J5OiBSZWNvcmQ8c3RyaW5nLCB7IHVuZG86IE1hcmtTbmFwW107IHJlZG86IE1hcmtTbmFwW10gfT4gPSB7fTtcbiAgY29uc3QgaGlzdEZvciA9ICh2aWQ6IHN0cmluZykgPT4gKG1hcmtIaXN0b3J5W3ZpZF0gPz89IHsgdW5kbzogW10sIHJlZG86IFtdIH0pO1xuICAvLyBPTkUgZnJlc2huZXNzIGZsYWcgcGVyIHZhcmlhbnQ6IHRoZSBhZ2VudCBoYXNuJ3Qgc2VlbiB0aGVzZSBtYXJrcyB5ZXQuIFNldCBvblxuICAvLyBldmVyeSBtYXJrIGNoYW5nZTsgY2xlYXJlZCB3aGVuIHRoZSBhZ2VudCByZWNlaXZlcyB0aGUgbWFya2VkIGltYWdlIChjb21taXRcbiAgLy8gYnV0dG9uIE9SIGEgc2F5IHRoYXQgY2FycmllcyBpdCkuIFNlZSBJbWFnb1N0YXRlLm1hcmtzVW5zZWVuLlxuICBjb25zdCBtYXJrVW5zZWVuOiBSZWNvcmQ8c3RyaW5nLCBib29sZWFuPiA9IHt9O1xuICBjb25zdCBzbmFwRm9yID0gKHZpZDogc3RyaW5nKTogTWFya1NuYXAgPT4gKHtcbiAgICBtYXJrczogc3RydWN0dXJlZENsb25lKHN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF0gPz8gW10pLFxuICAgIGxheWVyczogc3RydWN0dXJlZENsb25lKHN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdID8/IFtdKSxcbiAgfSk7XG4gIGNvbnN0IHB1c2hIaXN0b3J5ID0gKHZpZDogc3RyaW5nIHwgdW5kZWZpbmVkKSA9PiB7XG4gICAgaWYgKCF2aWQpIHJldHVybjtcbiAgICBtYXJrVW5zZWVuW3ZpZF0gPSB0cnVlOyAvLyBhIG1hcmsvbGF5ZXIgaXMgYWJvdXQgdG8gY2hhbmdlIOKGkiBhZ2VudCdzIHZpZXcgaXMgc3RhbGVcbiAgICBjb25zdCBoID0gaGlzdEZvcih2aWQpO1xuICAgIGgudW5kby5wdXNoKHNuYXBGb3IodmlkKSk7XG4gICAgaWYgKGgudW5kby5sZW5ndGggPiBISVNUT1JZX0NBUCkgaC51bmRvLnNoaWZ0KCk7XG4gICAgaC5yZWRvID0gW107IC8vIGEgZnJlc2ggZWRpdCBmb3JrcyB0aGUgdGltZWxpbmUg4oCUIHJlZG8gaXMgbm8gbG9uZ2VyIHZhbGlkXG4gIH07XG4gIC8vIENvbnRhaW5lciBtb2RlbDogZXZlcnkgZWxlbWVudCBiZWxvbmdzIHRvIGEgTGF5ZXIuIEEgbmV3IHZlY3RvciBtYXJrIGRyb3BzXG4gIC8vIGludG8gdGhlIGFjdGl2ZSBkcmF3IGxheWVyIOKAlCB0aGUgdG9wbW9zdCBOT04taW1hZ2UgbGF5ZXIgKGRyYXdpbmcgXCJpbnRvXCIgYW5cbiAgLy8gaW1hZ2UgbGF5ZXIgcmVhZHMgb2RkbHkpLCBjcmVhdGluZyBhIGRlZmF1bHQgXCJBbm5vdGF0aW9uc1wiIGxheWVyIGlmIHRoZXJlJ3NcbiAgLy8gbm8gbm9uLWltYWdlIGxheWVyIHlldCAoaXRzIHB1c2ggbGFuZHMgYWJvdmUgYW55IGltYWdlIGxheWVycywgc28gYW5ub3RhdGlvbnNcbiAgLy8gcGFpbnQgb3ZlciB0aGUgY29sbGFnZSkuIFRoZSBhY3RpdmUgbGF5ZXIgaXMgb3RoZXJ3aXNlIHN1cmZhY2Utb3duZWQ6IG1hcmsuYWRkXG4gIC8vIGhvbm9ycyBhIHZhbGlkIGNsaWVudCBgbWFyay5sYXllcklkYCBhbmQgb25seSBmYWxscyBiYWNrIHRvIHRoaXMuIENhbGwgQUZURVJcbiAgLy8gcHVzaEhpc3Rvcnkgc28gdGhlIGF1dG8tY3JlYXRlZCBsYXllciBpcyBwYXJ0IG9mIHRoZSBzYW1lIHVuZG9hYmxlIHN0ZXAuXG4gIGNvbnN0IGVuc3VyZURyYXdMYXllciA9ICh2aWQ6IHN0cmluZyk6IHN0cmluZyA9PiB7XG4gICAgaWYgKCFzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXSkgc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0gPSBbXTtcbiAgICBjb25zdCBsYXllcnMgPSBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXTtcbiAgICBmb3IgKGxldCBpID0gbGF5ZXJzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgICBpZiAobGF5ZXJzW2ldLmtpbmQgIT09IFwiaW1hZ2VcIikgcmV0dXJuIGxheWVyc1tpXS5pZDtcbiAgICB9XG4gICAgY29uc3QgbGF5ZXI6IExheWVyID0geyBpZDogbmV3SWQoXCJsYXllclwiKSwgbmFtZTogXCJBbm5vdGF0aW9uc1wiLCBraW5kOiBcImFubm90YXRpb25cIiB9O1xuICAgIGxheWVycy5wdXNoKGxheWVyKTtcbiAgICByZXR1cm4gbGF5ZXIuaWQ7XG4gIH07XG4gIC8vIOKUgOKUgCBjb250ZXh0IGxpYnJhcnkgaGVscGVycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgZnVuY3Rpb24gbGlua0NvbnRleHQoaWQ6IHN0cmluZywgc2V0OiBDb250ZXh0U2V0KSB7XG4gICAgaWYgKCFzdGF0ZS5saWJyYXJ5LnNvbWUoKGUpID0+IGUuaWQgPT09IGlkKSkgcmV0dXJuO1xuICAgIGNvbnN0IGFyciA9IHNldCA9PT0gXCJhY3RpdmVcIiA/IHN0YXRlLmFjdGl2ZUNvbnRleHRJZHMgOiBzdGF0ZS5xdWlja1Byb21wdElkcztcbiAgICBpZiAoIWFyci5pbmNsdWRlcyhpZCkpIGFyci5wdXNoKGlkKTtcbiAgfVxuICBmdW5jdGlvbiB1bmxpbmtDb250ZXh0KGlkOiBzdHJpbmcsIHNldDogQ29udGV4dFNldCkge1xuICAgIGlmIChzZXQgPT09IFwiYWN0aXZlXCIpIHN0YXRlLmFjdGl2ZUNvbnRleHRJZHMgPSBzdGF0ZS5hY3RpdmVDb250ZXh0SWRzLmZpbHRlcigoeCkgPT4geCAhPT0gaWQpO1xuICAgIGVsc2Ugc3RhdGUucXVpY2tQcm9tcHRJZHMgPSBzdGF0ZS5xdWlja1Byb21wdElkcy5maWx0ZXIoKHgpID0+IHggIT09IGlkKTtcbiAgfVxuICAvLyBDcmVhdGUgYSBsaWJyYXJ5IGVudHJ5LCBvciByZXBvcnQgd2h5IGl0IGRpZCBub3QgY3JlYXRlIG9uZS5cbiAgLy9cbiAgLy8gYjkg4oCUIHRoaXMgdXNlZCB0byBiZSBhbiBVUFNFUlQgb24gdGhlIHN0eWxlIHBhdGg6IGFuIGFkZCB3aG9zZSBuYW1lXG4gIC8vIG5vcm1hbGl6ZWQgb250byBhbiBleGlzdGluZyBzdHlsZSBPVkVSV1JPVEUgdGhhdCBlbnRyeSdzIGNvbnRlbnQsIHRhZ3MgYW5kXG4gIC8vIGltYWdlLCByZXR1cm5lZCB0aGUgZXhpc3RpbmcgaWQsIGFuZCBhbnN3ZXJlZCBhcHBsaWVkOnRydWUuIFNpbGVudCBkYXRhXG4gIC8vIGxvc3Mgb24gYSB2ZXJiIGNhbGxlZCBgYWRkYCwgaW4gYSBodW1hbi1wcmltYXJ5IHNwZWxsLiBJdCBhbHNvIG1hZGUgdGhlXG4gIC8vIGRvY3VtZW50ZWQgcmVjb3ZlcnkgZm9yICM4NyAoZGlmZiB0aGUgYm9hcmQgdG8gZmluZCB0aGUgbmV3IGVudHJ5KVxuICAvLyBDT05GSURFTlRMWSBXUk9ORyBpbiBleGFjdGx5IHRoZSBkZXN0cnVjdGl2ZSBjYXNlOiB0aGUgbGlicmFyeSBjb3VudCBpc1xuICAvLyB1bmNoYW5nZWQsIHNvIGEgZGlmZiByZXBvcnRzIFwibm90aGluZyB3YXMgY3JlYXRlZFwiIOKAlCB0cnVlIGZvciBhIHJlamVjdGVkXG4gIC8vIGFkZCwgZmFsc2UgZm9yIG9uZSB0aGF0IGhhZCBqdXN0IGRlc3Ryb3llZCBhIGh1bWFuJ3Mgc3R5bGUuXG4gIC8vXG4gIC8vIFRocmVlIG91dGNvbWVzIG5vdywgYW5kIHRoZSBjYWxsZXIgY2FuIHRlbGwgdGhlbSBhcGFydCAoZ3JpbW9pcmUvXG4gIC8vIG91dGNvbWUtY29udHJhY3QubWQpOlxuICAvLyAgIGNyZWF0ZWQgICAgICAgICAgYSBuZXcgZW50cnkgZXhpc3RzOyBgaWRgIGlzIG5ld1xuICAvLyAgIGFscmVhZHktcmVjb3JkZWQgdGhlIG5hbWUgaXMgdGFrZW4gYW5kIGhvbm9yaW5nIHRoaXMgYWRkIHdvdWxkIGNoYW5nZVxuICAvLyAgICAgICAgICAgICAgICAgICAgTk9USElORyDigJQgbm8gd3JpdGUgaGFwcGVuZWQsIGBpZGAgaXMgdGhlIGV4aXN0aW5nIGVudHJ5XG4gIC8vICAgcmVmdXNlZCAgICAgICAgICB0aGUgbmFtZSBpcyB0YWtlbiBhbmQgaG9ub3JpbmcgaXQgV09VTEQgY2hhbmdlIHRoZSBlbnRyeVxuICAvL1xuICAvLyDim5QgVGhlIHJlZnVzYWwgaXMgZGVsaWJlcmF0ZSBhbmQgaXQgaXMgdGhlIGNhcmQncyBpbnN0cnVjdGlvbjogd2hlcmUgdGhlXG4gIC8vIHNhZmUgYmVoYXZpb3VyIGlzIGFtYmlndW91cywgUkVGVVNFIEFORCBSRVBPUlQgcmF0aGVyIHRoYW4gZ3Vlc3MsIGJlY2F1c2UgYVxuICAvLyByZWZ1c2FsIGlzIHJlY292ZXJhYmxlIGFuZCBhbiBvdmVyd3JpdGUgaXMgbm90LiBgY29udGV4dC51cGRhdGVgIGFscmVhZHlcbiAgLy8gZXhpc3RzIGZvciBjYWxsZXJzIHRoYXQgZ2VudWluZWx5IG1lYW4gdG8gY2hhbmdlIGFuIGVudHJ5LlxuICAvL1xuICAvLyBOT1QgREVTSUdORUQgSEVSRSwgb24gcHVycG9zZTogd2hldGhlciBhbiBhZ2VudCBzaG91bGQgYmUgYWJsZSB0byB1cGRhdGUgYVxuICAvLyBzdHlsZSB0aHJvdWdoIGBhZGRgIGF0IGFsbCDigJQgYSBmbGFnLCBhIHNlcGFyYXRlIHZlcmIsIGEgcHJvbXB0LiBUaGF0XG4gIC8vIGNoYW5nZXMgd2hhdCBhIGh1bWFuIHNlZXMgYW5kIGlzIENvbGUncyBjYWxsLCBub3QgdGhlIHdpcmUncy5cbiAgdHlwZSBBZ2VudFZlcmRpY3QgPVxuICAgIHwgYm9vbGVhblxuICAgIHwgeyByZWNvZ25pc2VkOiB0cnVlOyBvazogdHJ1ZTsgZGV0YWlsOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB9XG4gICAgfCB7XG4gICAgICAgIHJlY29nbmlzZWQ6IHRydWU7XG4gICAgICAgIG9rOiBmYWxzZTtcbiAgICAgICAgc3RhdHVzOiBudW1iZXI7XG4gICAgICAgIGVycm9yOiBzdHJpbmc7XG4gICAgICAgIGRldGFpbD86IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgfTtcblxuICB0eXBlIEFkZENvbnRleHRSZXN1bHQgPVxuICAgIHwgeyBvazogdHJ1ZTsgaWQ6IHN0cmluZzsgb3V0Y29tZTogXCJjcmVhdGVkXCIgfCBcImFscmVhZHktcmVjb3JkZWRcIiB9XG4gICAgfCB7XG4gICAgICAgIG9rOiB0cnVlO1xuICAgICAgICBpZDogc3RyaW5nO1xuICAgICAgICBvdXRjb21lOiBcInVwZGF0ZWRcIjtcbiAgICAgICAgY2hhbmdlZDogc3RyaW5nW107XG4gICAgICAgIHByZXZpb3VzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIH1cbiAgICB8IHsgb2s6IGZhbHNlOyBlcnJvcjogc3RyaW5nOyBpZD86IHN0cmluZyB9O1xuXG4gIGZ1bmN0aW9uIGFkZENvbnRleHRFbnRyeShtc2c6IHtcbiAgICBraW5kOiBDb250ZXh0S2luZDtcbiAgICBuYW1lOiBzdHJpbmc7XG4gICAgY29udGVudD86IHN0cmluZztcbiAgICB0YWdzPzogc3RyaW5nW107XG4gICAgaW1hZ2U/OiBzdHJpbmc7XG4gIH0pOiBBZGRDb250ZXh0UmVzdWx0IHtcbiAgICBpZiAodHlwZW9mIG1zZy5uYW1lICE9PSBcInN0cmluZ1wiIHx8ICFtc2cubmFtZS50cmltKCkpXG4gICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBcImNvbnRleHQuYWRkIHJlcXVpcmVzIGEgbm9uLWVtcHR5IG5hbWVcIiB9O1xuICAgIGNvbnN0IGNvbnRlbnQgPSB0eXBlb2YgbXNnLmNvbnRlbnQgPT09IFwic3RyaW5nXCIgPyBtc2cuY29udGVudCA6IFwiXCI7XG4gICAgY29uc3QgdGFncyA9IEFycmF5LmlzQXJyYXkobXNnLnRhZ3MpID8gbXNnLnRhZ3MgOiB1bmRlZmluZWQ7XG4gICAgY29uc3QgaW1hZ2VTcmMgPVxuICAgICAgdHlwZW9mIG1zZy5pbWFnZSA9PT0gXCJzdHJpbmdcIiAmJiBtc2cuaW1hZ2Uuc3RhcnRzV2l0aChcImRhdGE6XCIpID8gbXNnLmltYWdlIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IGltYWdlUGF0aCA9IGltYWdlU3JjXG4gICAgICA/IHNhdmVEYXRhVXJsKHNlc3Npb25GaWxlc0RpciwgbmV3SWQoXCJjdHhcIiksIGltYWdlU3JjKSB8fCB1bmRlZmluZWRcbiAgICAgIDogdW5kZWZpbmVkO1xuICAgIGlmIChtc2cua2luZCA9PT0gXCJzdHlsZVwiKSB7XG4gICAgICBjb25zdCBuYW1lID0gbm9ybVN0eWxlKG1zZy5uYW1lKTtcbiAgICAgIGNvbnN0IGV4aXN0aW5nID0gc3RhdGUubGlicmFyeS5maW5kKChlKSA9PiBlLmtpbmQgPT09IFwic3R5bGVcIiAmJiBub3JtU3R5bGUoZS5uYW1lKSA9PT0gbmFtZSk7XG4gICAgICBpZiAoZXhpc3RpbmcpIHtcbiAgICAgICAgLy8gVGhlIHVwc2VydCBTVEFZUyDigJQgaXQgaXMgYSBkZXNpZ25lZCwgdGVzdGVkIGNhcGFiaWxpdHksIGFuZCByZWZ1c2luZ1xuICAgICAgICAvLyBpdCB3b3VsZCBhbnN3ZXIgYSBxdWVzdGlvbiByZXNlcnZlZCBmb3IgQ29sZSAoXCJzaG91bGQgYW4gYWdlbnQgYmUgYWJsZVxuICAgICAgICAvLyB0byB1cGRhdGUgYSBzdHlsZSB0aHJvdWdoIGFkZD9cIikgd2hpbGUgY2FsbGluZyB0aGF0IG5ldXRyYWxpdHkuXG4gICAgICAgIC8vXG4gICAgICAgIC8vIFdoYXQgY2hhbmdlcyBpcyB0aGF0IGl0IGlzIG5vIGxvbmdlciBTSUxFTlQsIGFuZCBubyBsb25nZXJcbiAgICAgICAgLy8gdW5yZWNvdmVyYWJsZTogdGhlIHJlc3VsdCBuYW1lcyBlYWNoIGZpZWxkIGl0IG92ZXJ3cm90ZSBhbmQgY2Fycmllc1xuICAgICAgICAvLyB0aGF0IGZpZWxkJ3MgUFJJT1IgVkFMVUUsIHNvIHRoZSBjYWxsZXIgY2FuIHB1dCBpdCBiYWNrLiBUaGF0IGNvbnZlcnRzXG4gICAgICAgIC8vIGFuIHVucmVjb3ZlcmFibGUgd3JpdGUgaW50byBhIHJlY292ZXJhYmxlIG9uZSBhdCB0aGUgd2lyZSBsZXZlbCDigJRcbiAgICAgICAgLy8gd2hpY2ggaXMgb3VycyDigJQgd2l0aG91dCB0b3VjaGluZyB0aGUgY2FwYWJpbGl0eSwgd2hpY2ggaXMgbm90LlxuICAgICAgICBjb25zdCBjaGFuZ2VkOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBjb25zdCBwcmV2aW91czogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICAgICAgaWYgKGNvbnRlbnQgJiYgY29udGVudCAhPT0gZXhpc3RpbmcuY29udGVudCkge1xuICAgICAgICAgIGNoYW5nZWQucHVzaChcImNvbnRlbnRcIik7XG4gICAgICAgICAgcHJldmlvdXMuY29udGVudCA9IGV4aXN0aW5nLmNvbnRlbnQ7XG4gICAgICAgICAgZXhpc3RpbmcuY29udGVudCA9IGNvbnRlbnQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHRhZ3MgJiYgSlNPTi5zdHJpbmdpZnkodGFncykgIT09IEpTT04uc3RyaW5naWZ5KGV4aXN0aW5nLnRhZ3MpKSB7XG4gICAgICAgICAgY2hhbmdlZC5wdXNoKFwidGFnc1wiKTtcbiAgICAgICAgICBwcmV2aW91cy50YWdzID0gZXhpc3RpbmcudGFncztcbiAgICAgICAgICBleGlzdGluZy50YWdzID0gdGFncztcbiAgICAgICAgfVxuICAgICAgICBpZiAoaW1hZ2VTcmMgJiYgaW1hZ2VTcmMgIT09IGV4aXN0aW5nLmltYWdlKSB7XG4gICAgICAgICAgY2hhbmdlZC5wdXNoKFwiaW1hZ2VcIik7XG4gICAgICAgICAgLy8gVGhlIFBBVEgsIG5vdCB0aGUgYmxvYi4gc2F2ZURhdGFVcmwgYWxyZWFkeSBwZXJzaXN0ZWQgdGhlIHByaW9yXG4gICAgICAgICAgLy8gaW1hZ2UgdG8gZGlzaywgc28gdGhlIHBhdGggaXMgYSBjb21wbGV0ZSByZWNvdmVyeSBoYW5kbGUgYW5kIGVjaG9pbmdcbiAgICAgICAgICAvLyBhIGJhc2U2NCBkYXRhIFVSTCBiYWNrIHRocm91Z2ggdGhlIGVudmVsb3BlIGNvdWxkIGJlIG1lZ2FieXRlcy4gQVxuICAgICAgICAgIC8vIHJlY292ZXJ5IGFmZm9yZGFuY2UgdGhhdCBpcyB0b28gaGVhdnkgdG8gc2VuZCBpcyBub3Qgb25lLlxuICAgICAgICAgIHByZXZpb3VzLmltYWdlID0gZXhpc3RpbmcuaW1hZ2VQYXRoID8/IG51bGw7XG4gICAgICAgICAgZXhpc3RpbmcuaW1hZ2UgPSBpbWFnZVNyYztcbiAgICAgICAgICBleGlzdGluZy5pbWFnZVBhdGggPSBpbWFnZVBhdGg7XG4gICAgICAgICAgZXhpc3RpbmcuY2FwdHVyZWQgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIC8vIE5hbWUgdGFrZW4gYW5kIG5vdGhpbmcgd291bGQgY2hhbmdlOiB0aGUgd29yayB3YXMgdW5uZWNlc3NhcnkgYW5kIE5PXG4gICAgICAgIC8vIFdSSVRFIGhhcHBlbmVkLiBEaXN0aW5jdCBmcm9tIGB1cGRhdGVkYCwgd2hlcmUgYSB3cml0ZSBkaWQuXG4gICAgICAgIGlmICghY2hhbmdlZC5sZW5ndGgpIHJldHVybiB7IG9rOiB0cnVlLCBpZDogZXhpc3RpbmcuaWQsIG91dGNvbWU6IFwiYWxyZWFkeS1yZWNvcmRlZFwiIH07XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBpZDogZXhpc3RpbmcuaWQsIG91dGNvbWU6IFwidXBkYXRlZFwiLCBjaGFuZ2VkLCBwcmV2aW91cyB9O1xuICAgICAgfVxuICAgICAgY29uc3QgaWQgPSBuZXdJZChcImN0eFwiKTtcbiAgICAgIHN0YXRlLmxpYnJhcnkucHVzaCh7XG4gICAgICAgIGlkLFxuICAgICAgICBraW5kOiBcInN0eWxlXCIsXG4gICAgICAgIG5hbWUsXG4gICAgICAgIGNvbnRlbnQsXG4gICAgICAgIHRhZ3MsXG4gICAgICAgIGltYWdlOiBpbWFnZVNyYyxcbiAgICAgICAgaW1hZ2VQYXRoLFxuICAgICAgICBjYXB0dXJlZDogaW1hZ2VTcmMgPyB0cnVlIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgaWQsIG91dGNvbWU6IFwiY3JlYXRlZFwiIH07XG4gICAgfVxuICAgIGNvbnN0IGlkID0gbmV3SWQoXCJjdHhcIik7XG4gICAgc3RhdGUubGlicmFyeS5wdXNoKHtcbiAgICAgIGlkLFxuICAgICAga2luZDogbXNnLmtpbmQsXG4gICAgICBuYW1lOiBtc2cubmFtZS50cmltKCksXG4gICAgICBjb250ZW50LFxuICAgICAgdGFncyxcbiAgICAgIGltYWdlOiBpbWFnZVNyYyxcbiAgICAgIGltYWdlUGF0aCxcbiAgICB9KTtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgaWQsIG91dGNvbWU6IFwiY3JlYXRlZFwiIH07XG4gIH1cblxuICAvLyBBIHNpbmdsZSBlbGVtZW50J3MgbmF0dXJhbCBjb250YWluZXIga2luZCArIGxhYmVsICh1c2VkIGJ5IGdyb3VwL3VuZ3JvdXApLlxuICBjb25zdCBraW5kRm9yVG9vbCA9ICh0b29sOiBNYXJrW1widG9vbFwiXSk6IExheWVyW1wia2luZFwiXSA9PlxuICAgIHRvb2wgPT09IFwiaW1hZ2VcIiA/IFwiaW1hZ2VcIiA6IHRvb2wgPT09IFwiZHJhd1wiID8gXCJza2V0Y2hcIiA6IFwiYW5ub3RhdGlvblwiO1xuICBjb25zdCBUT09MX0xBQkVMOiBSZWNvcmQ8TWFya1tcInRvb2xcIl0sIHN0cmluZz4gPSB7XG4gICAgcGluOiBcIlBpblwiLFxuICAgIGFycm93OiBcIkFycm93XCIsXG4gICAgbGluZTogXCJMaW5lXCIsXG4gICAgcmVjdDogXCJSZWN0YW5nbGVcIixcbiAgICBlbGxpcHNlOiBcIkVsbGlwc2VcIixcbiAgICBkcmF3OiBcIlNrZXRjaFwiLFxuICAgIGltYWdlOiBcIkltYWdlXCIsXG4gIH07XG4gIGlmICh2LnJlc3RvcmUpIHtcbiAgICBjb25zdCByZXN0b3JlUGF0aCA9IGV4aXN0c1N5bmModi5yZXN0b3JlIGFzIHN0cmluZylcbiAgICAgID8gKHYucmVzdG9yZSBhcyBzdHJpbmcpXG4gICAgICA6IGpvaW4oU05BUFNIT1RTX0RJUiwgYCR7di5yZXN0b3JlfS5qc29uYCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHNuYXAgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhyZXN0b3JlUGF0aCwgXCJ1dGY4XCIpKSBhcyBQYXJ0aWFsPEltYWdvU3RhdGU+O1xuICAgICAgLy8gTWVyZ2Ugb3ZlciBkZWZhdWx0cyBzbyBzbmFwc2hvdHMgZnJvbSBvbGRlciBidWlsZHMgZ2FpbiBuZXcgZmllbGRzLlxuICAgICAgc3RhdGUgPSB7IC4uLmRlZmF1bHRTdGF0ZSh2LnRpdGxlIGFzIHN0cmluZyksIC4uLnNuYXAgfSBhcyBJbWFnb1N0YXRlO1xuICAgICAgcmVzdG9yZWQgPSB0cnVlO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBgaW1hZ286IHJlc3RvcmUgZmFpbGVkICgke3Jlc3RvcmVQYXRofSk6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuICBjb25zdCBzb2NrZXRzID0gbmV3IFNldDxTZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4+KCk7XG4gIGNvbnN0IGVuYyA9IG5ldyBUZXh0RW5jb2RlcigpO1xuXG4gIC8vIEFwcGVuZC1vbmx5IGV2ZW50IGxvZyBmb3IgdGhlIGFnZW50J3MgU1NFIHRhaWwuIEVhY2ggZXZlbnQgZ2V0cyBhIG1vbm90b25pY1xuICAvLyBpZCBzbyBhIChyZSljb25uZWN0aW5nIHRhaWwgY2FuIHJlcGxheSB2aWEgP3NpbmNlPTxpZD4uXG4gIGNvbnN0IGV2ZW50czogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+ID0gW107XG4gIGxldCBldmVudFNlcSA9IDA7XG4gIGNvbnN0IHNzZUNsaWVudHMgPSBuZXcgU2V0PFJlYWRhYmxlU3RyZWFtRGVmYXVsdENvbnRyb2xsZXI+KCk7XG4gIGNvbnN0IHNzZVRpbWVycyA9IG5ldyBTZXQ8UmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+PigpO1xuXG4gIGxldCByZXNvbHZlRG9uZSE6ICh2YWw6IERvbmVSZXN1bHQpID0+IHZvaWQ7XG4gIGxldCBzZXR0bGVkID0gZmFsc2U7XG4gIGNvbnN0IGRvbmUgPSBuZXcgUHJvbWlzZTxEb25lUmVzdWx0PigocmVzKSA9PiB7XG4gICAgcmVzb2x2ZURvbmUgPSAodmFsKSA9PiB7XG4gICAgICBpZiAoc2V0dGxlZCkgcmV0dXJuO1xuICAgICAgc2V0dGxlZCA9IHRydWU7XG4gICAgICByZXModmFsKTtcbiAgICB9O1xuICB9KTtcblxuICBsZXQgbGFzdEFjdGl2aXR5ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gIGNvbnN0IHRvdWNoID0gKCkgPT4ge1xuICAgIGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICB9O1xuXG4gIGZ1bmN0aW9uIGVtaXRFdmVudChtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gICAgY29uc3QgZXYgPSB7IGlkOiArK2V2ZW50U2VxLCAuLi5tc2cgfTtcbiAgICBldmVudHMucHVzaChldik7XG4gICAgY29uc3QgZnJhbWUgPSBlbmMuZW5jb2RlKGBkYXRhOiAke0pTT04uc3RyaW5naWZ5KGV2KX1cXG5cXG5gKTtcbiAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYy5lbnF1ZXVlKGZyYW1lKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBjbGllbnQgZ29uZSAqL1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGJyb2FkY2FzdChtc2c6IG9iamVjdCkge1xuICAgIGNvbnN0IHMgPSBKU09OLnN0cmluZ2lmeShtc2cpO1xuICAgIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgd3Muc2VuZChzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBzb2NrZXQgY2xvc2VkICovXG4gICAgICB9XG4gICAgfVxuICB9XG4gIGxldCBzbmFwRGlydHkgPSBmYWxzZTtcbiAgY29uc3QgYnJvYWRjYXN0U3RhdGUgPSAoKSA9PiB7XG4gICAgc25hcERpcnR5ID0gdHJ1ZTsgLy8gbWFyayBmb3IgdGhlIHBlcnNpc3RlbmNlIHNuYXBzaG90XG4gICAgLy8gZGVyaXZlIHVuZG8vcmVkbyBhdmFpbGFiaWxpdHkgZm9yIHRoZSBmb2N1c2VkIHZhcmlhbnQgKGtlcHQgZnJlc2ggaGVyZSBzb1xuICAgIC8vIHRoZSB0b29sYmFyIGJ1dHRvbnMgcmVmbGVjdCB0aGUgbGl2ZSBoaXN0b3J5IHdpdGhvdXQgYSBzZXBhcmF0ZSBjaGFubmVsKVxuICAgIGNvbnN0IGggPSBzdGF0ZS5mb2N1cyA/IG1hcmtIaXN0b3J5W3N0YXRlLmZvY3VzLnZhcmlhbnRJZF0gOiB1bmRlZmluZWQ7XG4gICAgc3RhdGUuaGlzdG9yeSA9IHsgY2FuVW5kbzogKGg/LnVuZG8ubGVuZ3RoID8/IDApID4gMCwgY2FuUmVkbzogKGg/LnJlZG8ubGVuZ3RoID8/IDApID4gMCB9O1xuICAgIHN0YXRlLm1hcmtzVW5zZWVuID0gc3RhdGUuZm9jdXMgPyAobWFya1Vuc2VlbltzdGF0ZS5mb2N1cy52YXJpYW50SWRdID8/IGZhbHNlKSA6IGZhbHNlO1xuICAgIGJyb2FkY2FzdCh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGUgfSk7XG4gIH07XG5cbiAgbGV0IHNlc3Npb25GaWxlc0RpciA9IFwiXCI7IC8vIHNldCBvbmNlIHNlc3Npb25JZCBpcyBrbm93biAoYWZ0ZXIgYmluZClcbiAgY29uc3Qgc2F2ZVNuYXBzaG90ID0gKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmMoU05BUFNIT1RTX0RJUiwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oU05BUFNIT1RTX0RJUiwgYCR7c2Vzc2lvbklkfS5qc29uYCksIEpTT04uc3RyaW5naWZ5KHN0YXRlKSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBwZXJzaXN0ZW5jZSBpcyBiZXN0LWVmZm9ydCAqL1xuICAgIH1cbiAgfTtcblxuICAvLyDilIDilIAgaGVscGVycyBvdmVyIHRoZSBjYW5vbmljYWwgc3RhdGUg4pSA4pSAXG4gIGNvbnN0IGZpbmRCYXRjaCA9IChpZDogc3RyaW5nKSA9PiBzdGF0ZS5iYXRjaGVzLmZpbmQoKGIpID0+IGIuaWQgPT09IGlkKTtcbiAgZnVuY3Rpb24gZmluZFZhcmlhbnQoaWQ6IHN0cmluZyk6IHsgYmF0Y2g6IEJhdGNoOyB2YXJpYW50OiBWYXJpYW50OyBpbmRleDogbnVtYmVyIH0gfCBudWxsIHtcbiAgICBmb3IgKGNvbnN0IGIgb2Ygc3RhdGUuYmF0Y2hlcykge1xuICAgICAgY29uc3QgaW5kZXggPSBiLnZhcmlhbnRzLmZpbmRJbmRleCgoeCkgPT4geC5pZCA9PT0gaWQpO1xuICAgICAgaWYgKGluZGV4ID49IDApIHJldHVybiB7IGJhdGNoOiBiLCB2YXJpYW50OiBiLnZhcmlhbnRzW2luZGV4XSwgaW5kZXggfTtcbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgY29uc3QgbGFiZWxPZiA9IChpOiBudW1iZXIpID0+IFN0cmluZy5mcm9tQ2hhckNvZGUoOTcgKyBpKTtcbiAgLy8gVGhlIHJlZmVyZW5jZXMgXCJzZXRcIiBpcyBqdXN0IHRoZSB2YXJpYW50cyBmbGFnZ2VkIHJlZlNlbGVjdGVkIChvbmUgc291cmNlIG9mXG4gIC8vIHRydXRoOyB1c2VkIGJ5IGJvdGggdGhlIHNheSArIG1hcmtzLmNvbW1pdCBoYW5kb2ZmcykuIFNlZSByZWZzLWFzLWFzc2V0cyBwbGFuLlxuICBjb25zdCBzZWxlY3RlZFJlZklkcyA9ICgpOiBzdHJpbmdbXSA9PlxuICAgIHN0YXRlLmJhdGNoZXNcbiAgICAgIC5mbGF0TWFwKChiKSA9PiBiLnZhcmlhbnRzKVxuICAgICAgLmZpbHRlcigodikgPT4gdi5yZWZTZWxlY3RlZClcbiAgICAgIC5tYXAoKHYpID0+IHYuaWQpO1xuICAvLyBJbXBvcnQgYW4gZXh0ZXJuYWwgaW1hZ2UgYXMgYSBvbmUtdmFyaWFudCBpbXBvcnQta2luZCBiYXRjaCDigJQgdGhlIHVuaWZpZWQgcGF0aFxuICAvLyBmb3IgXCJicmluZyBpbiBhIHdvcmtpbmcgaW1hZ2VcIiBBTkQgXCJhZGQgYSByZWZlcmVuY2VcIi4gSGFzaGVzIGZvciBkZWR1cCArXG4gIC8vIGFuYWx5c2lzQ2FjaGU7IGlmIHRoZSBzYW1lIHBpeGVscyBhcmUgYWxyZWFkeSBpbXBvcnRlZCwgcmV0dXJucyB0aGUgZXhpc3RpbmdcbiAgLy8gdmFyaWFudCAobm8gZHVwbGljYXRlKS4gQ2FsbGVyIGRlY2lkZXMgZm9jdXMvcmVmU2VsZWN0ZWQuXG4gIGZ1bmN0aW9uIGltcG9ydEltYWdlVmFyaWFudChzcmM6IHN0cmluZywgbmFtZT86IHN0cmluZyk6IHsgYmF0Y2hJZDogc3RyaW5nOyB2YXJpYW50OiBWYXJpYW50IH0ge1xuICAgIGNvbnN0IGhhc2ggPSBjb250ZW50SGFzaChzcmMpO1xuICAgIGZvciAoY29uc3QgYiBvZiBzdGF0ZS5iYXRjaGVzKSB7XG4gICAgICBjb25zdCBleCA9IGIudmFyaWFudHMuZmluZCgodikgPT4gdi5oYXNoID09PSBoYXNoKTtcbiAgICAgIGlmIChleCkge1xuICAgICAgICBpZiAobmFtZSAmJiAhZXgubmFtZSkgZXgubmFtZSA9IG5hbWU7IC8vIGZpbGwgYSBtaXNzaW5nIG5hbWUgb24gYSBkZWR1cCBoaXRcbiAgICAgICAgcmV0dXJuIHsgYmF0Y2hJZDogYi5pZCwgdmFyaWFudDogZXggfTtcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgdmlkID0gbmV3SWQoXCJ2XCIpO1xuICAgIGNvbnN0IGJhdGNoSWQgPSBuZXdJZChcImJcIik7XG4gICAgY29uc3QgdmFyaWFudDogVmFyaWFudCA9IHtcbiAgICAgIGlkOiB2aWQsXG4gICAgICBzcmMsXG4gICAgICBwYXRoOiBzYXZlRGF0YVVybChzZXNzaW9uRmlsZXNEaXIsIHZpZCwgc3JjKSxcbiAgICAgIGxpa2VkOiBmYWxzZSxcbiAgICAgIGFuYWx5c2lzOiBzdGF0ZS5hbmFseXNpc0NhY2hlW2hhc2hdID8/IFwiXCIsIC8vIHJldXNlIGEgcHJpb3IgcmVhZCBvZiB0aGUgc2FtZSBwaXhlbHNcbiAgICAgIG5hbWUsXG4gICAgICBoYXNoLFxuICAgIH07XG4gICAgc3RhdGUuYmF0Y2hlcy5wdXNoKHsgaWQ6IGJhdGNoSWQsIGtpbmQ6IFwiaW1wb3J0XCIsIHByb21wdDogXCJcIiwgdGFnOiBuYW1lLCB2YXJpYW50czogW3ZhcmlhbnRdIH0pO1xuICAgIHJldHVybiB7IGJhdGNoSWQsIHZhcmlhbnQgfTtcbiAgfVxuICBmdW5jdGlvbiBwdXNoTWVzc2FnZShtOiBPbWl0PE1lc3NhZ2UsIFwiaWRcIiB8IFwidHNcIj4gJiB7IGlkPzogc3RyaW5nIH0pIHtcbiAgICBjb25zdCBtc2c6IE1lc3NhZ2UgPSB7IGlkOiBtLmlkID8/IG5ld0lkKFwibVwiKSwgdHM6IERhdGUubm93KCksIC4uLm0gfSBhcyBNZXNzYWdlO1xuICAgIHN0YXRlLmNvbnZlcnNhdGlvbi5wdXNoKG1zZyk7XG4gICAgcmV0dXJuIG1zZztcbiAgfVxuXG4gIC8vIOKUgOKUgCBhZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLy8gIzg0IOKAlCBSRVRVUk5TIEEgVkVSRElDVDogYHRydWVgIGlmIHRoZSBjb21tYW5kIHR5cGUgd2FzIFJFQ09HTklTRUQuXG4gIC8vXG4gIC8vIOKaoCBpbWFnbyBpcyB0aGUgRElTUFJPT0YgdGhhdCB0aGlzIGlzIGFuIGBhd2FpdGAgYnVnLiBUaGlzIGhhbmRsZXIgaXMgYXN5bmNcbiAgLy8gQU5EIGl0cyAvY21kIHJvdXRlIGFscmVhZHkgYXdhaXRzIGl0IGNvcnJlY3RseSDigJQgYW5kIHRoZSBkZWZlY3Qgd2FzIHByZXNlbnRcbiAgLy8gYW55d2F5LCBiZWNhdXNlIHRoZSByb3V0ZSBhbnN3ZXJlZCBhIGxpdGVyYWwge29rOnRydWV9IHdoaWxlIHRoZSBoYW5kbGVyXG4gIC8vIGdhdmUgaXQgbm90aGluZyB0byByZXBvcnQuIEFkZGluZyBgYXdhaXRgIHRvIGdsYW1vdXIgd291bGQgb25seSBoYXZlIG1hZGVcbiAgLy8gZ2xhbW91ciByZXNlbWJsZSBpbWFnbywgd2hpY2ggd2FzIGFsc28gYnJva2VuLlxuICAvL1xuICAvLyBcIlJlY29nbmlzZWRcIiwgTk9UIFwiY2hhbmdlZCBzdGF0ZVwiOiB0aGUgZm91ciBlYXJseSByZXR1cm5zIGJlbG93IGFyZSBndWFyZHNcbiAgLy8gaW5zaWRlIHJlY29nbmlzZWQgYnJhbmNoZXMgKGFuIGVtcHR5IHZhcmlhbnQgbGlzdCwgYSBtaXNzaW5nIGlkKSwgYW5kIGVhY2hcbiAgLy8gcmV0dXJucyBgdHJ1ZWAuIFJlcG9ydGluZyBhIHJlY29nbmlzZWQtYnV0LWluZXJ0IGNvbW1hbmQgYXMgYSBmYWlsdXJlIHdvdWxkXG4gIC8vIGJyZWFrIHdvcmtpbmcgY2FsbGVycyDigJQgdGhlIG92ZXItaW5jbHVzaXZlIGVycm9yIFAwYiBoYWQgdG8gYXZvaWQgaW4gdGhpc1xuICAvLyBzYW1lIHNwcmludC4gVGhlIG5hcnJvd2VyIGNvbnRyYWN0IChkaWQgaXQgYWN0dWFsbHkgdGFrZSBlZmZlY3Q/KSBpcyBhIHJlYWxcbiAgLy8gZ2FwLCBkZWxpYmVyYXRlbHkgVU5DTEFJTUVEIGFuZCByYWlzZWQgcmF0aGVyIHRoYW4gc2lsZW50bHkgYXNzdW1lZC5cbiAgLy9cbiAgLy8g4pqgIGhhbmRsZUJyb3dzZXJNc2cgYmVsb3cgaXMgYSBTRVBBUkFURSBmdW5jdGlvbiB3aXRoIGl0cyBvd24gaWYtY2hhaW4gYW5kIGFcbiAgLy8gbmVhci1pZGVudGljYWwgc2hhcGUuIEl0IGlzIE5PVCBwYXJ0IG9mIHRoaXMgdmVyZGljdCBhbmQgbXVzdCBub3QgYmUgZm9sZGVkXG4gIC8vIGluOiBpdCBzZXJ2ZXMgdGhlIFdlYlNvY2tldCwgd2hvc2UgY2FsbGVycyBoYXZlIG5vIHJlc3BvbnNlIHRvIGNhcnJ5IG9uZS5cbiAgLy8gQ29udHJhY3QgMTMgKHNlYW1zLm1kKTogdGhlIHZlcmRpY3Qgb3JpZ2luYXRlcyBpbiB0aGUgY29kZSB0aGF0IG93bnMgdGhlXG4gIC8vIHJlY29nbmlzZWQgc2V0LiBgZmFsc2VgID0gdGhlIHR5cGUgd2FzIG5vdCByZWNvZ25pc2VkOyBgdHJ1ZWAgPSBpdCB3YXMuXG4gIC8vXG4gIC8vIGI5IHdpZGVucyB0aGUgUkVUVVJOIHdpdGhvdXQgd2lkZW5pbmcgdGhlIENPTlRSQUNUOiBhIGNvbW1hbmQgbWF5IGluc3RlYWRcbiAgLy8gcmV0dXJuIGEgcmVzdWx0IG9iamVjdCBjYXJyeWluZyBpdHMgb3duIHN0YXR1cyBhbmQgcGF5bG9hZC4gRXZlcnkgY29tbWFuZFxuICAvLyB0aGF0IHJldHVybnMgYSBiYXJlIGJvb2xlYW4gaXMgdW5hZmZlY3RlZCBhbmQgaXRzIHJlc3BvbnNlIGlzIGJ5dGUtaWRlbnRpY2FsXG4gIC8vIOKAlCBvbmx5IGBjb250ZXh0LmFkZGAgdXNlcyB0aGUgcmljaGVyIGZvcm0gdG9kYXkuXG4gIGFzeW5jIGZ1bmN0aW9uIGhhbmRsZUFnZW50TXNnKG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPEFnZW50VmVyZGljdD4ge1xuICAgIGNvbnN0IHQgPSBtc2cudHlwZSBhcyBzdHJpbmc7XG4gICAgaWYgKHQgPT09IFwiaW5pdFwiKSB7XG4gICAgICBpZiAodHlwZW9mIG1zZy50aXRsZSA9PT0gXCJzdHJpbmdcIikgc3RhdGUudGl0bGUgPSBtc2cudGl0bGU7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJzYXlcIikge1xuICAgICAgaWYgKHR5cGVvZiBtc2cudGV4dCA9PT0gXCJzdHJpbmdcIiAmJiBtc2cudGV4dCkge1xuICAgICAgICBwdXNoTWVzc2FnZSh7IHJvbGU6IFwiYWdlbnRcIiwga2luZDogXCJ0ZXh0XCIsIHRleHQ6IG1zZy50ZXh0IH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJwcm9wb3NlXCIpIHtcbiAgICAgIGlmICh0eXBlb2YgbXNnLnByb21wdCA9PT0gXCJzdHJpbmdcIiAmJiBtc2cucHJvbXB0KSB7XG4gICAgICAgIGNvbnN0IG4gPSB0eXBlb2YgbXNnLm4gPT09IFwibnVtYmVyXCIgJiYgbXNnLm4gPiAwID8gTWF0aC5taW4oNCwgTWF0aC5mbG9vcihtc2cubikpIDogNDtcbiAgICAgICAgLy8gTm8gZnJhbWluZyB0ZXh0IG9uIHRoZSBwcm9wb3NhbCBpdHNlbGYg4oCUIHRoZSBhZ2VudCBgc2F5YHMgaXRzXG4gICAgICAgIC8vIHJlYXNvbmluZyBhcyBhIHByZWNlZGluZyBidWJibGUsIHRoZW4gYHByb3Bvc2VgcyB0aGUgY2FyZC5cbiAgICAgICAgcHVzaE1lc3NhZ2Uoe1xuICAgICAgICAgIHJvbGU6IFwiYWdlbnRcIixcbiAgICAgICAgICBraW5kOiBcInByb21wdFwiLFxuICAgICAgICAgIHRleHQ6IFwiXCIsXG4gICAgICAgICAgcHJvcG9zYWw6IHsgcHJvbXB0OiBtc2cucHJvbXB0LCBuLCBzdGF0dXM6IFwicGVuZGluZ1wiIH0sXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJhc2tcIikge1xuICAgICAgaWYgKHR5cGVvZiBtc2cudGV4dCA9PT0gXCJzdHJpbmdcIiAmJiBtc2cudGV4dCkge1xuICAgICAgICBwdXNoTWVzc2FnZSh7XG4gICAgICAgICAgcm9sZTogXCJhZ2VudFwiLFxuICAgICAgICAgIGtpbmQ6IFwicXVlc3Rpb25cIixcbiAgICAgICAgICB0ZXh0OiBtc2cudGV4dCxcbiAgICAgICAgICBvcHRpb25zOiBBcnJheS5pc0FycmF5KG1zZy5vcHRpb25zKSA/IChtc2cub3B0aW9ucyBhcyBzdHJpbmdbXSkgOiB1bmRlZmluZWQsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJiYXRjaC5hZGRcIikge1xuICAgICAgY29uc3QgdmFyaWFudHNJbiA9IEFycmF5LmlzQXJyYXkobXNnLnZhcmlhbnRzKVxuICAgICAgICA/IChtc2cudmFyaWFudHMgYXMgQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KVxuICAgICAgICA6IFtdO1xuICAgICAgaWYgKHZhcmlhbnRzSW4ubGVuZ3RoID09PSAwKSByZXR1cm4gdHJ1ZTtcbiAgICAgIGNvbnN0IGJhdGNoSWQgPSBuZXdJZChcImJcIik7XG4gICAgICBjb25zdCB2YXJpYW50czogVmFyaWFudFtdID0gW107XG4gICAgICBmb3IgKGNvbnN0IHJhdyBvZiB2YXJpYW50c0luKSB7XG4gICAgICAgIGlmICh0eXBlb2YgcmF3LnNyYyAhPT0gXCJzdHJpbmdcIikgY29udGludWU7XG4gICAgICAgIGNvbnN0IHZpZCA9IHR5cGVvZiByYXcuaWQgPT09IFwic3RyaW5nXCIgPyByYXcuaWQgOiBuZXdJZChcInZcIik7XG4gICAgICAgIGNvbnN0IHNyYyA9IGF3YWl0IG9wdGltaXplU3JjKHJhdy5zcmMpO1xuICAgICAgICB2YXJpYW50cy5wdXNoKHtcbiAgICAgICAgICBpZDogdmlkLFxuICAgICAgICAgIHNyYyxcbiAgICAgICAgICBwYXRoOiBzYXZlRGF0YVVybChzZXNzaW9uRmlsZXNEaXIsIHZpZCwgc3JjKSxcbiAgICAgICAgICBzZWVkOiB0eXBlb2YgcmF3LnNlZWQgPT09IFwibnVtYmVyXCIgPyByYXcuc2VlZCA6IHVuZGVmaW5lZCxcbiAgICAgICAgICBtb2RlbDogdHlwZW9mIHJhdy5tb2RlbCA9PT0gXCJzdHJpbmdcIiA/IHJhdy5tb2RlbCA6IHVuZGVmaW5lZCxcbiAgICAgICAgICBsaWtlZDogZmFsc2UsXG4gICAgICAgICAgYW5hbHlzaXM6IFwiXCIsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgaWYgKHZhcmlhbnRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHRydWU7XG4gICAgICBjb25zdCBiYXRjaDogQmF0Y2ggPSB7XG4gICAgICAgIGlkOiBiYXRjaElkLFxuICAgICAgICBraW5kOiBtc2cua2luZCA9PT0gXCJlZGl0XCIgPyBcImVkaXRcIiA6IFwiZ2VuZXJhdGVcIixcbiAgICAgICAgcHJvbXB0OiB0eXBlb2YgbXNnLnByb21wdCA9PT0gXCJzdHJpbmdcIiA/IG1zZy5wcm9tcHQgOiBcIlwiLFxuICAgICAgICB0YWc6IHR5cGVvZiBtc2cudGFnID09PSBcInN0cmluZ1wiID8gbXNnLnRhZyA6IHVuZGVmaW5lZCxcbiAgICAgICAgZWRpdGVkRnJvbVZhcmlhbnRJZDpcbiAgICAgICAgICB0eXBlb2YgbXNnLmVkaXRlZEZyb21WYXJpYW50SWQgPT09IFwic3RyaW5nXCIgPyBtc2cuZWRpdGVkRnJvbVZhcmlhbnRJZCA6IHVuZGVmaW5lZCxcbiAgICAgICAgdmFyaWFudHMsXG4gICAgICB9O1xuICAgICAgc3RhdGUuYmF0Y2hlcy5wdXNoKGJhdGNoKTtcbiAgICAgIHB1c2hNZXNzYWdlKHtcbiAgICAgICAgcm9sZTogXCJhZ2VudFwiLFxuICAgICAgICBraW5kOiBcInJlc3VsdFwiLFxuICAgICAgICB0ZXh0OlxuICAgICAgICAgIHR5cGVvZiBtc2cuc3VtbWFyeSA9PT0gXCJzdHJpbmdcIlxuICAgICAgICAgICAgPyBtc2cuc3VtbWFyeVxuICAgICAgICAgICAgOiBgR2VuZXJhdGVkICR7dmFyaWFudHMubGVuZ3RofSB2YXJpYW50JHt2YXJpYW50cy5sZW5ndGggPiAxID8gXCJzXCIgOiBcIlwifSDigJQgdGhleSdyZSBvbiB0aGUgbGVmdC5gLFxuICAgICAgICBiYXRjaElkLFxuICAgICAgfSk7XG4gICAgICAvLyBTaG93IHRoZSBmaXJzdCByZXN1bHQgb24gdGhlIGNhbnZhcyBpZiBub3RoaW5nIGlzIGZvY3VzZWQgeWV0LlxuICAgICAgaWYgKCFzdGF0ZS5mb2N1cykgc3RhdGUuZm9jdXMgPSB7IGJhdGNoSWQsIHZhcmlhbnRJZDogdmFyaWFudHNbMF0uaWQgfTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcImZvY3VzXCIpIHtcbiAgICAgIGNvbnN0IGIgPSBmaW5kQmF0Y2gobXNnLmJhdGNoSWQgYXMgc3RyaW5nKTtcbiAgICAgIGNvbnN0IGhhcyA9IGI/LnZhcmlhbnRzLnNvbWUoKHgpID0+IHguaWQgPT09IG1zZy52YXJpYW50SWQpO1xuICAgICAgaWYgKGIgJiYgaGFzKSB7XG4gICAgICAgIHN0YXRlLmZvY3VzID0geyBiYXRjaElkOiBiLmlkLCB2YXJpYW50SWQ6IG1zZy52YXJpYW50SWQgYXMgc3RyaW5nIH07XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7IC8vIG1hcmtzIGFyZSBkdXJhYmxlIHBlciB2YXJpYW50IOKAlCBzd2l0Y2hpbmcgbmV2ZXIgY2xlYXJzIHRoZW1cbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHQgPT09IFwicmVmLnNlbGVjdFwiKSB7XG4gICAgICAvLyB0aGUgYWdlbnQgcG9pbnRzIGEgdmFyaWFudCBhdCB0aGUgbmV4dCBnZW4g4oCUIHRoZSB1c2VyIHNlZXMgaXQgaGlnaGxpZ2h0XG4gICAgICBjb25zdCBoaXQgPSBmaW5kVmFyaWFudChtc2cuaWQgYXMgc3RyaW5nKTtcbiAgICAgIGlmICghaGl0KSByZXR1cm4gdHJ1ZTtcbiAgICAgIGhpdC52YXJpYW50LnJlZlNlbGVjdGVkID0gbXNnLnNlbGVjdGVkID09PSB0cnVlO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwidmFyaWFudC5hbmFseXplXCIpIHtcbiAgICAgIC8vIHRoZSBhZ2VudCB3cml0ZXMgaXRzIHJlYWQgb250byBhIGdlbmVyYXRlZC9pbXBvcnRlZCBpbWFnZSDigJQgZHVyYWJsZVxuICAgICAgLy8gbWV0YWRhdGEgc3RvcmVkIG9uIHRoZSB2YXJpYW50IChwZXJzaXN0cyBpbiB0aGUgc25hcHNob3QpLlxuICAgICAgY29uc3QgaGl0ID0gZmluZFZhcmlhbnQobXNnLmlkIGFzIHN0cmluZyk7XG4gICAgICBpZiAoIWhpdCB8fCB0eXBlb2YgbXNnLnRleHQgIT09IFwic3RyaW5nXCIpIHJldHVybiB0cnVlO1xuICAgICAgaGl0LnZhcmlhbnQuYW5hbHlzaXMgPSBtc2cudGV4dDtcbiAgICAgIC8vIGltcG9ydGVkIGltYWdlcyBjYXJyeSBhIGhhc2gg4oaSIGNhY2hlIGJ5IGl0IHNvIHJlLWltcG9ydGluZyB0aGUgc2FtZSBwaXhlbHNcbiAgICAgIC8vIHJldXNlcyB0aGUgcmVhZCAocHJlc2VydmVzIHRoZSBvbGQgcmVmLmFuYWx5emUgYmVoYXZpb3IgYWNyb3NzIHRoZSBtZXJnZSlcbiAgICAgIGlmIChoaXQudmFyaWFudC5oYXNoKSBzdGF0ZS5hbmFseXNpc0NhY2hlW2hpdC52YXJpYW50Lmhhc2hdID0gbXNnLnRleHQ7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJjb250ZXh0LmFkZFwiKSB7XG4gICAgICAvLyBiOS8jODcg4oCUIHRoZSBjYWxsZXIgbGVhcm5zIHRoZSBpZCBpdCBqdXN0IGNyZWF0ZWQsIGFuZCBXSElDSCBvZiB0aGVcbiAgICAgIC8vIHRocmVlIHBhdGhzIHJhbi4gUmV0dXJuaW5nIGEgcmVzdWx0IG9iamVjdCBoZXJlIHJhdGhlciB0aGFuIGB0cnVlYCBpc1xuICAgICAgLy8gdGhlIG9ubHkgcGxhY2UgaW4gdGhpcyBoYW5kbGVyIHRoYXQgZG9lcyBzbzsgZXZlcnkgb3RoZXIgY29tbWFuZCBrZWVwc1xuICAgICAgLy8gdGhlIHBsYWluIGJvb2xlYW4sIHNvIHRoZWlyIHJlc3BvbnNlcyBzdGF5IGJ5dGUtaWRlbnRpY2FsLlxuICAgICAgY29uc3QgcmVzID0gYWRkQ29udGV4dEVudHJ5KG1zZyBhcyBQYXJhbWV0ZXJzPHR5cGVvZiBhZGRDb250ZXh0RW50cnk+WzBdKTtcbiAgICAgIGlmICghcmVzLm9rKVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHJlY29nbmlzZWQ6IHRydWUsXG4gICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgIHN0YXR1czogNDA5LFxuICAgICAgICAgIGVycm9yOiByZXMuZXJyb3IsXG4gICAgICAgICAgZGV0YWlsOiB7XG4gICAgICAgICAgICAuLi4ocmVzLmlkID8geyBpZDogcmVzLmlkIH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocmVzLmNvbmZsaWN0cyA/IHsgY29uZmxpY3RzOiByZXMuY29uZmxpY3RzIH0gOiB7fSksXG4gICAgICAgICAgfSxcbiAgICAgICAgfTtcbiAgICAgIGlmIChtc2cubGluaykgbGlua0NvbnRleHQocmVzLmlkLCBtc2cubGluayBhcyBDb250ZXh0U2V0KTtcbiAgICAgIC8vIGBhbHJlYWR5LXJlY29yZGVkYCB3cm90ZSBub3RoaW5nLCBzbyB0aGVyZSBpcyBub3RoaW5nIHRvIGJyb2FkY2FzdCDigJRcbiAgICAgIC8vIGJ1dCBhIGxpbmsgbWF5IHN0aWxsIGhhdmUgYmVlbiBtYWRlIGFib3ZlLCBhbmQgdGhhdCBpcyBhIHJlYWwgY2hhbmdlLlxuICAgICAgaWYgKHJlcy5vdXRjb21lICE9PSBcImFscmVhZHktcmVjb3JkZWRcIiB8fCBtc2cubGluaykgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHJlY29nbmlzZWQ6IHRydWUsXG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICBkZXRhaWw6IHtcbiAgICAgICAgICBpZDogcmVzLmlkLFxuICAgICAgICAgIG91dGNvbWU6IHJlcy5vdXRjb21lLFxuICAgICAgICAgIC4uLihyZXMub3V0Y29tZSA9PT0gXCJ1cGRhdGVkXCIgPyB7IGNoYW5nZWQ6IHJlcy5jaGFuZ2VkLCBwcmV2aW91czogcmVzLnByZXZpb3VzIH0gOiB7fSksXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJzdGF0dXNcIikge1xuICAgICAgc3RhdGUuc3RhdHVzID0ge1xuICAgICAgICBidXN5OiBtc2cuYnVzeSA9PT0gdHJ1ZSxcbiAgICAgICAgdGV4dDogdHlwZW9mIG1zZy50ZXh0ID09PSBcInN0cmluZ1wiID8gbXNnLnRleHQgOiBcIlwiLFxuICAgICAgfTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcImNvc3RcIikge1xuICAgICAgaWYgKHR5cGVvZiBtc2cudGV4dCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICBzdGF0ZS5jb3N0ID0gbXNnLnRleHQ7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmICh0ID09PSBcImhhbmRvZmZcIikge1xuICAgICAgc3RhdGUuaGFuZG9mZiA9IHR5cGVvZiBtc2cudGV4dCA9PT0gXCJzdHJpbmdcIiA/IG1zZy50ZXh0IDogXCJcIjtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcImNsb3NlXCIpIHtcbiAgICAgIHJlc29sdmVEb25lKHsgY29kZTogMCwgcmVhc29uOiBcImNsb3NlXCIgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBmYWxzZTsgLy8gdW5yZWNvZ25pc2VkIHR5cGUg4oCUIHRoaXMgY2hhaW4gaGFkIG5vIHRlcm1pbmFsIGVsc2UgYXQgYWxsXG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgZnVuY3Rpb24gc3NlUmVzcG9uc2UodXJsOiBVUkwpOiBSZXNwb25zZSB7XG4gICAgdG91Y2goKTtcbiAgICBjb25zdCBzaW5jZSA9IHBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic2luY2VcIikgPz8gXCItMVwiLCAxMCk7XG4gICAgbGV0IHJlZjogUmVhZGFibGVTdHJlYW1EZWZhdWx0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xuICAgIGxldCBoYjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgbnVsbCA9IG51bGw7XG4gICAgY29uc3Qgc3RyZWFtID0gbmV3IFJlYWRhYmxlU3RyZWFtKHtcbiAgICAgIHN0YXJ0KGNvbnRyb2xsZXIpIHtcbiAgICAgICAgcmVmID0gY29udHJvbGxlcjtcbiAgICAgICAgZm9yIChjb25zdCBldiBvZiBldmVudHMpIHtcbiAgICAgICAgICBpZiAoKGV2LmlkIGFzIG51bWJlcikgPiBzaW5jZSkge1xuICAgICAgICAgICAgY29udHJvbGxlci5lbnF1ZXVlKGVuYy5lbmNvZGUoYGRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZXYpfVxcblxcbmApKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgc3NlQ2xpZW50cy5hZGQoY29udHJvbGxlcik7XG4gICAgICAgIGhiID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb250cm9sbGVyLmVucXVldWUoZW5jLmVuY29kZShgOiBoYlxcblxcbmApKTtcbiAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIGdvbmUgKi9cbiAgICAgICAgICB9XG4gICAgICAgIH0sIDE1MDAwKTtcbiAgICAgICAgc3NlVGltZXJzLmFkZChoYik7XG4gICAgICB9LFxuICAgICAgY2FuY2VsKCkge1xuICAgICAgICBpZiAoaGIpIHtcbiAgICAgICAgICBjbGVhckludGVydmFsKGhiKTtcbiAgICAgICAgICBzc2VUaW1lcnMuZGVsZXRlKGhiKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVmKSBzc2VDbGllbnRzLmRlbGV0ZShyZWYpO1xuICAgICAgfSxcbiAgICB9KTtcbiAgICByZXR1cm4gbmV3IFJlc3BvbnNlKHN0cmVhbSwge1xuICAgICAgaGVhZGVyczoge1xuICAgICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcInRleHQvZXZlbnQtc3RyZWFtXCIsXG4gICAgICAgIFwiQ2FjaGUtQ29udHJvbFwiOiBcIm5vLWNhY2hlXCIsXG4gICAgICAgIENvbm5lY3Rpb246IFwia2VlcC1hbGl2ZVwiLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBicm93c2VyIG1lc3NhZ2VzIChXZWJTb2NrZXQpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICBhc3luYyBmdW5jdGlvbiBoYW5kbGVCcm93c2VyTXNnKG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgICBjb25zdCB0ID0gbXNnLnR5cGUgYXMgc3RyaW5nO1xuICAgIGlmICh0ID09PSBcInNheVwiKSB7XG4gICAgICBpZiAodHlwZW9mIG1zZy50ZXh0ICE9PSBcInN0cmluZ1wiIHx8ICFtc2cudGV4dCkgcmV0dXJuO1xuICAgICAgcHVzaE1lc3NhZ2UoeyByb2xlOiBcInVzZXJcIiwga2luZDogXCJ0ZXh0XCIsIHRleHQ6IG1zZy50ZXh0IH0pO1xuICAgICAgLy8gQSBtZXNzYWdlIGFib3V0IGEgZnJlc2hseS1tYXJrZWQgaW1hZ2UgcmlkZXMgdGhlIG1hcmtlZCBpbWFnZSArIGdlb21ldHJ5XG4gICAgICAvLyBhbG9uZyAob25lIGZyZXNobmVzcyBzaWduYWwpLiBUaGUgc3VyZmFjZSBhdHRhY2hlcyBmbGF0dGVuZWRTcmMgb25seSB3aGVuXG4gICAgICAvLyB0aGUgZm9jdXNlZCBpbWFnZSBoYXMgdW5zZWVuIG1hcmtzOyByZWNlaXZpbmcgaXQgY2xlYXJzIHRoYXQgZmxhZy5cbiAgICAgIGxldCBmbGF0dGVuZWRJbWFnZVBhdGg6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgIGxldCBhdHRhY2hlZE1hcmtzOiBNYXJrW10gfCB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBmdmlkID0gc3RhdGUuZm9jdXM/LnZhcmlhbnRJZDtcbiAgICAgIGlmIChmdmlkICYmIHR5cGVvZiBtc2cuZmxhdHRlbmVkU3JjID09PSBcInN0cmluZ1wiICYmIG1zZy5mbGF0dGVuZWRTcmMuc3RhcnRzV2l0aChcImRhdGE6XCIpKSB7XG4gICAgICAgIGZsYXR0ZW5lZEltYWdlUGF0aCA9XG4gICAgICAgICAgc2F2ZURhdGFVcmwoc2Vzc2lvbkZpbGVzRGlyLCBuZXdJZChcImZsYXRcIiksIG1zZy5mbGF0dGVuZWRTcmMpIHx8IHVuZGVmaW5lZDtcbiAgICAgICAgYXR0YWNoZWRNYXJrcyA9IHN0YXRlLm1hcmtzQnlWYXJpYW50W2Z2aWRdID8/IFtdO1xuICAgICAgICBtYXJrVW5zZWVuW2Z2aWRdID0gZmFsc2U7IC8vIHRoZSBhZ2VudCBub3cgaGFzIHRoZSBsYXRlc3QgbWFya3NcbiAgICAgIH1cbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAvLyBhbWJpZW50IGJvYXJkIHN0YXRlIChmb2N1cyArIHNlbGVjdGVkIHJlZnMpIHJpZGVzIHRoZSBtZXNzYWdlLCBzbyB0aGVcbiAgICAgIC8vIGFnZW50IGhhcyBcIndoaWNoIGltYWdlLCB3aXRoIHdoaWNoIHJlZnNcIiB3aXRob3V0IHN1YnNjcmliaW5nIHRvIHRoZVxuICAgICAgLy8gYW1iaWVudCBmb2N1cy5zZXQvcmVmLnNlbGVjdCBldmVudHMgKHdoaWNoIG5vIGxvbmdlciBub3RpZnkpLlxuICAgICAgZW1pdEV2ZW50KHtcbiAgICAgICAgdHlwZTogXCJzYXlcIixcbiAgICAgICAgdGV4dDogbXNnLnRleHQsXG4gICAgICAgIGZvY3VzOiBzdGF0ZS5mb2N1cyxcbiAgICAgICAgc2VsZWN0ZWRSZWZJZHM6IHNlbGVjdGVkUmVmSWRzKCksXG4gICAgICAgIGZsYXR0ZW5lZEltYWdlUGF0aCxcbiAgICAgICAgbWFya3M6IGF0dGFjaGVkTWFya3MsXG4gICAgICB9KTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwicHJvcG9zYWwuc2VuZFwiKSB7XG4gICAgICBjb25zdCBtID0gc3RhdGUuY29udmVyc2F0aW9uLmZpbmQoKHgpID0+IHguaWQgPT09IG1zZy5pZCk7XG4gICAgICBpZiAobT8ucHJvcG9zYWwpIHtcbiAgICAgICAgbS5wcm9wb3NhbC5zdGF0dXMgPSBcInNlbnRcIjtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIH1cbiAgICAgIGVtaXRFdmVudCh7IHR5cGU6IFwicHJvcG9zYWwuc2VuZFwiLCBpZDogbXNnLmlkIH0pO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJwcm9wb3NhbC5kaXNtaXNzXCIpIHtcbiAgICAgIGNvbnN0IG0gPSBzdGF0ZS5jb252ZXJzYXRpb24uZmluZCgoeCkgPT4geC5pZCA9PT0gbXNnLmlkKTtcbiAgICAgIGlmIChtPy5wcm9wb3NhbCkge1xuICAgICAgICBtLnByb3Bvc2FsLnN0YXR1cyA9IFwiZGlzbWlzc2VkXCI7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICB9XG4gICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcInByb3Bvc2FsLmRpc21pc3NcIiwgaWQ6IG1zZy5pZCB9KTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwiZm9jdXMuc2V0XCIpIHtcbiAgICAgIGNvbnN0IGIgPSBmaW5kQmF0Y2gobXNnLmJhdGNoSWQgYXMgc3RyaW5nKTtcbiAgICAgIGlmICghYikgcmV0dXJuO1xuICAgICAgaWYgKCFiLnZhcmlhbnRzLnNvbWUoKHgpID0+IHguaWQgPT09IG1zZy52YXJpYW50SWQpKSByZXR1cm47XG4gICAgICBzdGF0ZS5mb2N1cyA9IHsgYmF0Y2hJZDogYi5pZCwgdmFyaWFudElkOiBtc2cudmFyaWFudElkIGFzIHN0cmluZyB9O1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTsgLy8gbWFya3MgYXJlIGR1cmFibGUgcGVyIHZhcmlhbnQg4oCUIHN3aXRjaGluZyBuZXZlciBjbGVhcnMgdGhlbVxuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJmb2N1cy5jbGVhclwiKSB7XG4gICAgICBzdGF0ZS5mb2N1cyA9IG51bGw7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJ2YXJpYW50Lmxpa2VcIikge1xuICAgICAgY29uc3QgaGl0ID0gZmluZFZhcmlhbnQobXNnLmlkIGFzIHN0cmluZyk7XG4gICAgICBpZiAoIWhpdCkgcmV0dXJuO1xuICAgICAgaGl0LnZhcmlhbnQubGlrZWQgPSBtc2cubGlrZWQgPT09IHRydWU7XG4gICAgICBpZiAoaGl0LnZhcmlhbnQubGlrZWQpIHtcbiAgICAgICAgcHVzaE1lc3NhZ2Uoe1xuICAgICAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgICAgIGtpbmQ6IFwiZ2VzdHVyZVwiLFxuICAgICAgICAgIHRleHQ6IGDwn5GNIHlvdSBsaWtlZCB2YXJpYW50ICR7bGFiZWxPZihoaXQuaW5kZXgpfSDigJQgaW1hZ28gY2FuIHNlZSB3aGljaCBvbmVgLFxuICAgICAgICAgIGdlc3R1cmU6IHsga2luZDogXCJsaWtlZFwiLCB0YXJnZXRJZDogaGl0LnZhcmlhbnQuaWQgfSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJ2YXJpYW50LnJlbW92ZVwiKSB7XG4gICAgICAvLyBkZWxldGUgYSB2YXJpYW50IGZyb20gdGhlIGxpYnJhcnk6IGRyb3AgaXQgZnJvbSBpdHMgYmF0Y2ggKGFuZCBkcm9wIHRoZVxuICAgICAgLy8gYmF0Y2ggd2hlbiBpdCBlbXB0aWVzKSwgY2xlYW4gaXRzIGFubm90YXRpb25zL2xheWVycy9oaXN0b3J5LCBhbmQgY2xlYXJcbiAgICAgIC8vIGZvY3VzIGlmIGl0IHdhcyB0aGUgZm9jdXNlZCBvbmUuIEFtYmllbnQgKGxpYnJhcnkgY3VyYXRpb24pIOKAlCBubyBhZ2VudFxuICAgICAgLy8gZXZlbnQ7IHRoZSBhZ2VudCByZWFkcyB0aGUgbmV3IHN0YXRlLlxuICAgICAgY29uc3QgYmF0Y2hJZCA9IG1zZy5iYXRjaElkO1xuICAgICAgY29uc3QgdmFyaWFudElkID0gbXNnLnZhcmlhbnRJZDtcbiAgICAgIGlmICh0eXBlb2YgYmF0Y2hJZCAhPT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgdmFyaWFudElkICE9PSBcInN0cmluZ1wiKSByZXR1cm47XG4gICAgICBjb25zdCBiYXRjaCA9IHN0YXRlLmJhdGNoZXMuZmluZCgoYikgPT4gYi5pZCA9PT0gYmF0Y2hJZCk7XG4gICAgICBpZiAoIWJhdGNoPy52YXJpYW50cy5zb21lKCh2KSA9PiB2LmlkID09PSB2YXJpYW50SWQpKSByZXR1cm47XG4gICAgICBiYXRjaC52YXJpYW50cyA9IGJhdGNoLnZhcmlhbnRzLmZpbHRlcigodikgPT4gdi5pZCAhPT0gdmFyaWFudElkKTtcbiAgICAgIGlmIChiYXRjaC52YXJpYW50cy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgc3RhdGUuYmF0Y2hlcyA9IHN0YXRlLmJhdGNoZXMuZmlsdGVyKChiKSA9PiBiLmlkICE9PSBiYXRjaElkKTtcbiAgICAgIH1cbiAgICAgIGRlbGV0ZSBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2YXJpYW50SWRdO1xuICAgICAgZGVsZXRlIHN0YXRlLmxheWVyc0J5VmFyaWFudFt2YXJpYW50SWRdO1xuICAgICAgZGVsZXRlIG1hcmtIaXN0b3J5W3ZhcmlhbnRJZF07XG4gICAgICBkZWxldGUgbWFya1Vuc2Vlblt2YXJpYW50SWRdO1xuICAgICAgaWYgKHN0YXRlLmZvY3VzPy52YXJpYW50SWQgPT09IHZhcmlhbnRJZCkgc3RhdGUuZm9jdXMgPSBudWxsO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwiY29udGV4dC5hZGRcIikge1xuICAgICAgLy8gU2FtZSBub24tZGVzdHJ1Y3RpdmUgYmVoYXZpb3VyIGFzIHRoZSBhZ2VudCBwYXRoIOKAlCB0aGUgZ3VhcmQgbGl2ZXMgaW5cbiAgICAgIC8vIGFkZENvbnRleHRFbnRyeSwgc28gYm90aCBjYWxsZXJzIGdldCBpdC4gQnV0IGEgV2ViU29ja2V0IG1lc3NhZ2UgaGFzIG5vXG4gICAgICAvLyByZXNwb25zZSB0byBjYXJyeSBhIHZlcmRpY3QgKHNlYW1zLm1kIENvbnRyYWN0IDEzJ3Mgc3RhdGVkIGdyYWluKSwgc28gYVxuICAgICAgLy8gcmVmdXNhbCBpcyBjdXJyZW50bHkgSU5WSVNJQkxFIHRvIHRoZSBodW1hbi4gVGhhdCBpcyBhIHBhcml0eS1mYWN0cyBnYXBcbiAgICAgIC8vIGFuZCBpdCBpcyBjaXJjZSdzIHN1cmZhY2UgY2FsbCwgbm90IHNvbWV0aGluZyB0byBwYXBlciBvdmVyIGhlcmUuXG4gICAgICBjb25zdCByZXMgPSBhZGRDb250ZXh0RW50cnkobXNnIGFzIFBhcmFtZXRlcnM8dHlwZW9mIGFkZENvbnRleHRFbnRyeT5bMF0pO1xuICAgICAgaWYgKHJlcy5vayAmJiBtc2cubGluaykgbGlua0NvbnRleHQocmVzLmlkLCBtc2cubGluayBhcyBDb250ZXh0U2V0KTtcbiAgICAgIGlmIChyZXMub2spIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcImNvbnRleHQudXBkYXRlXCIpIHtcbiAgICAgIGNvbnN0IGUgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKHgpID0+IHguaWQgPT09IG1zZy5pZCk7XG4gICAgICBpZiAoZSkge1xuICAgICAgICBpZiAodHlwZW9mIG1zZy5uYW1lID09PSBcInN0cmluZ1wiKSBlLm5hbWUgPSBtc2cubmFtZS50cmltKCkgfHwgZS5uYW1lO1xuICAgICAgICBpZiAodHlwZW9mIG1zZy5jb250ZW50ID09PSBcInN0cmluZ1wiKSBlLmNvbnRlbnQgPSBtc2cuY29udGVudDtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobXNnLnRhZ3MpKSBlLnRhZ3MgPSBtc2cudGFncyBhcyBzdHJpbmdbXTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHQgPT09IFwiY29udGV4dC5kZWxldGVcIikge1xuICAgICAgaWYgKHR5cGVvZiBtc2cuaWQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgY29uc3QgdG9EZWxldGUgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKHgpID0+IHguaWQgPT09IG1zZy5pZCk7XG4gICAgICAgIHN0YXRlLmxpYnJhcnkgPSBzdGF0ZS5saWJyYXJ5LmZpbHRlcigoeCkgPT4geC5pZCAhPT0gbXNnLmlkKTtcbiAgICAgICAgc3RhdGUuYWN0aXZlQ29udGV4dElkcyA9IHN0YXRlLmFjdGl2ZUNvbnRleHRJZHMuZmlsdGVyKCh4KSA9PiB4ICE9PSBtc2cuaWQpO1xuICAgICAgICBzdGF0ZS5xdWlja1Byb21wdElkcyA9IHN0YXRlLnF1aWNrUHJvbXB0SWRzLmZpbHRlcigoeCkgPT4geCAhPT0gbXNnLmlkKTtcbiAgICAgICAgaWYgKHRvRGVsZXRlPy5pbWFnZVBhdGgpIHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgdW5saW5rU3luYyh0b0RlbGV0ZS5pbWFnZVBhdGgpO1xuICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyogYmVzdC1lZmZvcnQg4oCUIGZpbGUgbWF5IGFscmVhZHkgYmUgZ29uZSAqL1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJjb250ZXh0LmxpbmtcIikge1xuICAgICAgaWYgKHR5cGVvZiBtc2cuaWQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgbGlua0NvbnRleHQobXNnLmlkLCBtc2cuc2V0IGFzIENvbnRleHRTZXQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJjb250ZXh0LnVubGlua1wiKSB7XG4gICAgICBpZiAodHlwZW9mIG1zZy5pZCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICB1bmxpbmtDb250ZXh0KG1zZy5pZCwgbXNnLnNldCBhcyBDb250ZXh0U2V0KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHQgPT09IFwiY29udGV4dC5jYXB0dXJlXCIpIHtcbiAgICAgIC8vIGNhcnJ5IHRoZSBmb2N1c2VkIHZhcmlhbnQgc28gdGhlIGFnZW50IGtub3dzIHdoaWNoIGltYWdlIHRvIHJlYWQgdGhlIGxvb2sgZnJvbVxuICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJjb250ZXh0LmNhcHR1cmVcIiwgZm9jdXM6IHN0YXRlLmZvY3VzIH0pO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJwaW4uYWRkXCIpIHtcbiAgICAgIGlmICh0eXBlb2YgbXNnLmtleSAhPT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgbXNnLnZhbHVlICE9PSBcInN0cmluZ1wiKSByZXR1cm47XG4gICAgICBjb25zdCBleCA9IHN0YXRlLnBpbnMuZmluZCgocCkgPT4gcC5rZXkgPT09IG1zZy5rZXkpO1xuICAgICAgaWYgKGV4KSBleC52YWx1ZSA9IG1zZy52YWx1ZTtcbiAgICAgIGVsc2Ugc3RhdGUucGlucy5wdXNoKHsga2V5OiBtc2cua2V5LCB2YWx1ZTogbXNnLnZhbHVlIH0pO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwicGluLnJlbW92ZVwiKSB7XG4gICAgICBzdGF0ZS5waW5zID0gc3RhdGUucGlucy5maWx0ZXIoKHApID0+IHAua2V5ICE9PSBtc2cua2V5KTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcInJlZi5hZGRcIikge1xuICAgICAgLy8gYWRkIGFuIGV4dGVybmFsIGltYWdlIGFzIGEgcmVmZXJlbmNlID0gaW1wb3J0IGl0IGFzIGEgbGlicmFyeSB2YXJpYW50ICtcbiAgICAgIC8vIGZsYWcgaXQgcmVmU2VsZWN0ZWQgKGRlZHVwIOKGkiBzZWxlY3RzIHRoZSBleGlzdGluZyBvbmUsIG5vIGR1cGxpY2F0ZSkuIERvZXNcbiAgICAgIC8vIE5PVCBzdGVhbCBmb2N1cyAoYSByZWYgaXNuJ3QgdGhlIHdvcmtpbmcgaW1hZ2U7IGltYWdlLmltcG9ydCBpcykuXG4gICAgICBjb25zdCByYXcgPSBtc2cuaW1hZ2UgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gICAgICBpZiAoIXJhdyB8fCB0eXBlb2YgcmF3LnNyYyAhPT0gXCJzdHJpbmdcIikgcmV0dXJuO1xuICAgICAgLy8gbGVhdmUgbmFtZSB1bmRlZmluZWQgd2hlbiBub3Qgc3VwcGxpZWQgKGRvbid0IHN0b3JlIGEgXCJyZWZlcmVuY2VcIlxuICAgICAgLy8gcGxhY2Vob2xkZXIg4oCUIGEgbGF0ZXIgaW1hZ2UuaW1wb3J0IG9mIHRoZSBzYW1lIHBpeGVscyBjYW4gZmlsbCB0aGUgbmFtZSlcbiAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgcmF3Lm5hbWUgPT09IFwic3RyaW5nXCIgPyByYXcubmFtZSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IHsgdmFyaWFudCB9ID0gaW1wb3J0SW1hZ2VWYXJpYW50KHJhdy5zcmMsIG5hbWUpO1xuICAgICAgdmFyaWFudC5yZWZTZWxlY3RlZCA9IHRydWU7XG4gICAgICBwdXNoTWVzc2FnZSh7XG4gICAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgICBraW5kOiBcImdlc3R1cmVcIixcbiAgICAgICAgdGV4dDogYPCfk44geW91IHBvaW50ZWQgYXQgYSByZWZlcmVuY2UgKCR7dmFyaWFudC5uYW1lID8/IFwiaW1hZ2VcIn0pYCxcbiAgICAgICAgZ2VzdHVyZTogeyBraW5kOiBcInJlZi1hZGRlZFwiLCB0YXJnZXRJZDogdmFyaWFudC5pZCB9LFxuICAgICAgfSk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJyZWYucmVtb3ZlXCIpIHtcbiAgICAgIC8vIERFU0VMRUNUIGEgdmFyaWFudCBhcyBhIHJlZiDigJQgaXQgc3RheXMgaW4gdGhlIGxpYnJhcnkgKGRlbGV0ZSA9IHZhcmlhbnQucmVtb3ZlKVxuICAgICAgY29uc3QgaGl0ID0gZmluZFZhcmlhbnQobXNnLmlkIGFzIHN0cmluZyk7XG4gICAgICBpZiAoIWhpdCkgcmV0dXJuO1xuICAgICAgaGl0LnZhcmlhbnQucmVmU2VsZWN0ZWQgPSBmYWxzZTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcInJlZi5zZWxlY3RcIikge1xuICAgICAgY29uc3QgaGl0ID0gZmluZFZhcmlhbnQobXNnLmlkIGFzIHN0cmluZyk7XG4gICAgICBpZiAoIWhpdCkgcmV0dXJuO1xuICAgICAgaGl0LnZhcmlhbnQucmVmU2VsZWN0ZWQgPSBtc2cuc2VsZWN0ZWQgPT09IHRydWU7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJpbWFnZS5pbXBvcnRcIikge1xuICAgICAgLy8gdGhlIHVzZXIgZHJvcHBlZCB0aGVpciBvd24gaW1hZ2Ugb250byB0aGUgY2FudmFzIOKAlCBhIHdvcmtpbmcgaW1hZ2VcbiAgICAgIC8vIChhIG9uZS12YXJpYW50IFwiaW1wb3J0XCIgYmF0Y2gpLCBmb2N1c2VkIHNvIHRoZXkgY2FuIGFubm90YXRlL2VkaXQgaXRcbiAgICAgIGNvbnN0IHJhdyA9IG1zZy5pbWFnZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgICAgIGlmICghcmF3IHx8IHR5cGVvZiByYXcuc3JjICE9PSBcInN0cmluZ1wiKSByZXR1cm47XG4gICAgICBjb25zdCBuYW1lID0gdHlwZW9mIHJhdy5uYW1lID09PSBcInN0cmluZ1wiID8gcmF3Lm5hbWUgOiBcImltcG9ydGVkIGltYWdlXCI7XG4gICAgICBjb25zdCB7IGJhdGNoSWQsIHZhcmlhbnQgfSA9IGltcG9ydEltYWdlVmFyaWFudChyYXcuc3JjLCBuYW1lKTtcbiAgICAgIHN0YXRlLmZvY3VzID0geyBiYXRjaElkLCB2YXJpYW50SWQ6IHZhcmlhbnQuaWQgfTtcbiAgICAgIHB1c2hNZXNzYWdlKHtcbiAgICAgICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgICAgIGtpbmQ6IFwiZ2VzdHVyZVwiLFxuICAgICAgICB0ZXh0OiBg8J+WvCB5b3UgYnJvdWdodCBpbiBhbiBpbWFnZSB0byB3b3JrIG9uICgke3ZhcmlhbnQubmFtZSA/PyBuYW1lfSlgLFxuICAgICAgICBnZXN0dXJlOiB7IGtpbmQ6IFwiaW1wb3J0ZWRcIiwgdGFyZ2V0SWQ6IHZhcmlhbnQuaWQgfSxcbiAgICAgIH0pO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwibGF5ZXIuYWRkSW1hZ2VcIikge1xuICAgICAgLy8gZHJvcCBhbiBpbWFnZSBhcyBhIExBWUVSIG9uIHRoZSBmb2N1c2VkIGltYWdlIChjb2xsYWdlKS4gVGhlIGNsaWVudFxuICAgICAgLy8gc3VwcGxpZXMgdGhlIGZyYWN0aW9uLXNwYWNlIGJveCAoaXQga25vd3MgdGhlIGJhc2UgaW1hZ2UgYm94ICsgdGhlIGRyb3BwZWRcbiAgICAgIC8vIGJpdG1hcCdzIGFzcGVjdCk7IGRlZmF1bHQgdG8gYSBjZW50ZXJlZCA0MCUgYm94LiBObyBhZ2VudCBldmVudCB1bnRpbFxuICAgICAgLy8gY29tbWl0IChzYW1lIHJ1bGUgYXMgbWFyay5hZGQpIOKAlCB0aGUgZmxhdHRlbmVkIGNvbXBvc2l0ZSBjYXJyaWVzIGl0LlxuICAgICAgY29uc3QgdmlkID0gc3RhdGUuZm9jdXM/LnZhcmlhbnRJZDtcbiAgICAgIGNvbnN0IHJhdyA9IG1zZyBhcyB7XG4gICAgICAgIHNyYz86IHVua25vd247XG4gICAgICAgIG5hbWU/OiB1bmtub3duO1xuICAgICAgICB4PzogdW5rbm93bjtcbiAgICAgICAgeT86IHVua25vd247XG4gICAgICAgIHc/OiB1bmtub3duO1xuICAgICAgICBoPzogdW5rbm93bjtcbiAgICAgIH07XG4gICAgICBpZiAoIXZpZCB8fCB0eXBlb2YgcmF3LnNyYyAhPT0gXCJzdHJpbmdcIikgcmV0dXJuO1xuICAgICAgY29uc3QgbnVtID0gKHY6IHVua25vd24sIGQ6IG51bWJlcikgPT4gKHR5cGVvZiB2ID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZSh2KSA/IHYgOiBkKTtcbiAgICAgIGNvbnN0IHcgPSBudW0ocmF3LncsIDAuNCk7XG4gICAgICBjb25zdCBoID0gbnVtKHJhdy5oLCAwLjQpO1xuICAgICAgY29uc3QgeCA9IG51bShyYXcueCwgKDEgLSB3KSAvIDIpO1xuICAgICAgY29uc3QgeSA9IG51bShyYXcueSwgKDEgLSBoKSAvIDIpO1xuICAgICAgY29uc3Qgb3B0aW1pemVkID0gYXdhaXQgb3B0aW1pemVTcmMocmF3LnNyYyk7XG4gICAgICBwdXNoSGlzdG9yeSh2aWQpOyAvLyBhZnRlciB0aGUgYXdhaXQsIHNvIGFueSBpbnRlcmxlYXZlZCBlZGl0IGlzIGluIHRoZSBzbmFwc2hvdFxuICAgICAgaWYgKCFzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXSkgc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0gPSBbXTtcbiAgICAgIGNvbnN0IGxheWVyOiBMYXllciA9IHtcbiAgICAgICAgaWQ6IG5ld0lkKFwibGF5ZXJcIiksXG4gICAgICAgIG5hbWU6IHR5cGVvZiByYXcubmFtZSA9PT0gXCJzdHJpbmdcIiAmJiByYXcubmFtZSA/IHJhdy5uYW1lIDogXCJJbWFnZVwiLFxuICAgICAgICBraW5kOiBcImltYWdlXCIsXG4gICAgICB9O1xuICAgICAgc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0ucHVzaChsYXllcik7IC8vIGEgbmV3IGltYWdlIGxheWVyIG9uIHRvcFxuICAgICAgaWYgKCFzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdKSBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdID0gW107XG4gICAgICBjb25zdCBhcnIgPSBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdO1xuICAgICAgYXJyLnB1c2goe1xuICAgICAgICBpZDogbmV3SWQoXCJpbWdcIiksXG4gICAgICAgIHRvb2w6IFwiaW1hZ2VcIixcbiAgICAgICAgc3JjOiBvcHRpbWl6ZWQsXG4gICAgICAgIHgsXG4gICAgICAgIHksXG4gICAgICAgIHcsXG4gICAgICAgIGgsXG4gICAgICAgIGxheWVySWQ6IGxheWVyLmlkLFxuICAgICAgICB6T3JkZXI6IGFyci5sZW5ndGgsXG4gICAgICB9KTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcImxheWVyLmFkZFwiKSB7XG4gICAgICAvLyBhIGJsYW5rIGxheWVyIG9uIHRvcCDigJQgYmVjb21lcyB0aGUgc3VyZmFjZSdzIGFjdGl2ZSBkcmF3IHRhcmdldFxuICAgICAgY29uc3QgdmlkID0gc3RhdGUuZm9jdXM/LnZhcmlhbnRJZDtcbiAgICAgIGlmICghdmlkKSByZXR1cm47XG4gICAgICBpZiAoIXN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdKSBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXSA9IFtdO1xuICAgICAgcHVzaEhpc3RvcnkodmlkKTtcbiAgICAgIGNvbnN0IGtpbmQ6IExheWVyW1wia2luZFwiXSA9XG4gICAgICAgIG1zZy5raW5kID09PSBcInNrZXRjaFwiIHx8IG1zZy5raW5kID09PSBcImltYWdlXCIgPyBtc2cua2luZCA6IFwiYW5ub3RhdGlvblwiO1xuICAgICAgc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0ucHVzaCh7XG4gICAgICAgIGlkOiBuZXdJZChcImxheWVyXCIpLFxuICAgICAgICBuYW1lOiB0eXBlb2YgbXNnLm5hbWUgPT09IFwic3RyaW5nXCIgJiYgbXNnLm5hbWUgPyBtc2cubmFtZSA6IFwiTGF5ZXJcIixcbiAgICAgICAga2luZCxcbiAgICAgIH0pO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwibGF5ZXIucmVuYW1lXCIpIHtcbiAgICAgIGNvbnN0IHZpZCA9IHN0YXRlLmZvY3VzPy52YXJpYW50SWQ7XG4gICAgICBjb25zdCBsYXllciA9IHZpZCA/IHN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdPy5maW5kKChsKSA9PiBsLmlkID09PSBtc2cuaWQpIDogdW5kZWZpbmVkO1xuICAgICAgaWYgKCFsYXllciB8fCB0eXBlb2YgbXNnLm5hbWUgIT09IFwic3RyaW5nXCIgfHwgIW1zZy5uYW1lIHx8IGxheWVyLm5hbWUgPT09IG1zZy5uYW1lKSByZXR1cm47XG4gICAgICBwdXNoSGlzdG9yeSh2aWQpO1xuICAgICAgbGF5ZXIubmFtZSA9IG1zZy5uYW1lO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwibGF5ZXIuc2V0SGlkZGVuXCIgfHwgdCA9PT0gXCJsYXllci5zZXRMb2NrZWRcIikge1xuICAgICAgY29uc3QgdmlkID0gc3RhdGUuZm9jdXM/LnZhcmlhbnRJZDtcbiAgICAgIGNvbnN0IGxheWVyID0gdmlkID8gc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0/LmZpbmQoKGwpID0+IGwuaWQgPT09IG1zZy5pZCkgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBrZXkgPSB0ID09PSBcImxheWVyLnNldEhpZGRlblwiID8gXCJoaWRkZW5cIiA6IFwibG9ja2VkXCI7XG4gICAgICBjb25zdCBuZXh0ID0gdCA9PT0gXCJsYXllci5zZXRIaWRkZW5cIiA/IG1zZy5oaWRkZW4gOiBtc2cubG9ja2VkO1xuICAgICAgaWYgKCFsYXllciB8fCB0eXBlb2YgbmV4dCAhPT0gXCJib29sZWFuXCIgfHwgQm9vbGVhbihsYXllcltrZXldKSA9PT0gbmV4dCkgcmV0dXJuO1xuICAgICAgcHVzaEhpc3RvcnkodmlkKTtcbiAgICAgIGxheWVyW2tleV0gPSBuZXh0O1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwibGF5ZXIucmVvcmRlclwiKSB7XG4gICAgICAvLyBhYnNvbHV0ZSBwbGFjZW1lbnQgKGRyYWctZHJvcCk6IG1vdmUgbGF5ZXIgYGlkYCB0byBgdG9JbmRleGAgKGJhY2vihpJmcm9udClcbiAgICAgIGNvbnN0IHZpZCA9IHN0YXRlLmZvY3VzPy52YXJpYW50SWQ7XG4gICAgICBjb25zdCBsYXllcnMgPSB2aWQgPyBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IGlkeCA9IGxheWVycz8uZmluZEluZGV4KChsKSA9PiBsLmlkID09PSBtc2cuaWQpID8/IC0xO1xuICAgICAgaWYgKCF2aWQgfHwgIWxheWVycyB8fCBpZHggPCAwIHx8IHR5cGVvZiBtc2cudG9JbmRleCAhPT0gXCJudW1iZXJcIikgcmV0dXJuO1xuICAgICAgY29uc3QgdG8gPSBNYXRoLm1heCgwLCBNYXRoLm1pbihsYXllcnMubGVuZ3RoIC0gMSwgTWF0aC50cnVuYyhtc2cudG9JbmRleCkpKTtcbiAgICAgIGlmICh0byA9PT0gaWR4KSByZXR1cm47XG4gICAgICBwdXNoSGlzdG9yeSh2aWQpO1xuICAgICAgY29uc3QgW2xdID0gbGF5ZXJzLnNwbGljZShpZHgsIDEpO1xuICAgICAgbGF5ZXJzLnNwbGljZSh0bywgMCwgbCk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJsYXllci5yZW1vdmVcIikge1xuICAgICAgLy8gZGVsZXRlIGEgbGF5ZXIgQU5EIHRoZSBlbGVtZW50cyBpdCBjb250YWluZWRcbiAgICAgIGNvbnN0IHZpZCA9IHN0YXRlLmZvY3VzPy52YXJpYW50SWQ7XG4gICAgICBpZiAoIXZpZCB8fCAhc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0/LnNvbWUoKGwpID0+IGwuaWQgPT09IG1zZy5pZCkpIHJldHVybjtcbiAgICAgIHB1c2hIaXN0b3J5KHZpZCk7XG4gICAgICBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXSA9IHN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdLmZpbHRlcigobCkgPT4gbC5pZCAhPT0gbXNnLmlkKTtcbiAgICAgIGlmIChzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdKSB7XG4gICAgICAgIHN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF0gPSBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdLmZpbHRlcigobSkgPT4gbS5sYXllcklkICE9PSBtc2cuaWQpO1xuICAgICAgfVxuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwiZ3JvdXBcIikge1xuICAgICAgLy8gd3JhcCB0aGUgc2VsZWN0ZWQgbWFya3MgaW4gYSBuZXcgbGF5ZXIgb24gdG9wOyByZWFzc2lnbiBsYXllcklkL3pPcmRlci5cbiAgICAgIGNvbnN0IHZpZCA9IHN0YXRlLmZvY3VzPy52YXJpYW50SWQ7XG4gICAgICBjb25zdCBpZHMgPSBtc2cubWFya0lkcztcbiAgICAgIGlmICghdmlkIHx8ICFBcnJheS5pc0FycmF5KGlkcykgfHwgIWlkcy5sZW5ndGgpIHJldHVybjtcbiAgICAgIGNvbnN0IG1hcmtzID0gc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXSA/PyBbXTtcbiAgICAgIGNvbnN0IGlkU2V0ID0gbmV3IFNldChpZHMuZmlsdGVyKCh4KTogeCBpcyBzdHJpbmcgPT4gdHlwZW9mIHggPT09IFwic3RyaW5nXCIpKTtcbiAgICAgIGNvbnN0IHBpY2tlZCA9IG1hcmtzLmZpbHRlcigobSkgPT4gaWRTZXQuaGFzKG0uaWQpKTtcbiAgICAgIGlmICghcGlja2VkLmxlbmd0aCkgcmV0dXJuO1xuICAgICAgcHVzaEhpc3RvcnkodmlkKTtcbiAgICAgIGlmICghc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0pIHN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdID0gW107XG4gICAgICBjb25zdCBsYXllcnMgPSBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXTtcbiAgICAgIGNvbnN0IHNvdXJjZUlkcyA9IG5ldyBTZXQocGlja2VkLm1hcCgobSkgPT4gbS5sYXllcklkKS5maWx0ZXIoQm9vbGVhbikgYXMgc3RyaW5nW10pO1xuICAgICAgLy8gaG9tb2dlbmVvdXMgc2VsZWN0aW9ucyBrZWVwIHRoZWlyIGtpbmQgKGEgcHVyZS1pbWFnZSBncm91cCBtdXN0IHN0YXkgYW5cbiAgICAgIC8vIGltYWdlIGxheWVyIOKAlCBlbHNlIGVuc3VyZURyYXdMYXllciB3b3VsZCB0cmVhdCBpdCBhcyBhIGRyYXcgdGFyZ2V0IGFuZCB0aGVcbiAgICAgIC8vIHBhbmVsIHdvdWxkIHNob3cgYSBzaGFwZXMgaWNvbiBpbnN0ZWFkIG9mIHRoZSBiaXRtYXAgdGh1bWJuYWlsKTsgYSBtaXhlZFxuICAgICAgLy8gc2VsZWN0aW9uIGlzIGEgZ2VuZXJpYyBhbm5vdGF0aW9uIGdyb3VwLlxuICAgICAgY29uc3QgZ3JvdXA6IExheWVyID0ge1xuICAgICAgICBpZDogbmV3SWQoXCJsYXllclwiKSxcbiAgICAgICAgbmFtZTogdHlwZW9mIG1zZy5uYW1lID09PSBcInN0cmluZ1wiICYmIG1zZy5uYW1lID8gbXNnLm5hbWUgOiBcIkdyb3VwXCIsXG4gICAgICAgIGtpbmQ6IHBpY2tlZC5ldmVyeSgobSkgPT4gbS50b29sID09PSBcImRyYXdcIilcbiAgICAgICAgICA/IFwic2tldGNoXCJcbiAgICAgICAgICA6IHBpY2tlZC5ldmVyeSgobSkgPT4gbS50b29sID09PSBcImltYWdlXCIpXG4gICAgICAgICAgICA/IFwiaW1hZ2VcIlxuICAgICAgICAgICAgOiBcImFubm90YXRpb25cIixcbiAgICAgIH07XG4gICAgICBsYXllcnMucHVzaChncm91cCk7XG4gICAgICBwaWNrZWQuZm9yRWFjaCgobSwgaSkgPT4ge1xuICAgICAgICBtLmxheWVySWQgPSBncm91cC5pZDtcbiAgICAgICAgbS56T3JkZXIgPSBpO1xuICAgICAgfSk7XG4gICAgICAvLyBwcnVuZSBzb3VyY2UgbGF5ZXJzIHRoZSBtb3ZlIGVtcHRpZWQgKG5ldmVyIHRoZSBuZXcgb25lIG9yIGEgc3RpbGwtb2NjdXBpZWQgb25lKVxuICAgICAgc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0gPSBsYXllcnMuZmlsdGVyKFxuICAgICAgICAobCkgPT4gbC5pZCA9PT0gZ3JvdXAuaWQgfHwgIXNvdXJjZUlkcy5oYXMobC5pZCkgfHwgbWFya3Muc29tZSgobSkgPT4gbS5sYXllcklkID09PSBsLmlkKSxcbiAgICAgICk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJ1bmdyb3VwXCIpIHtcbiAgICAgIC8vIGRpc3NvbHZlIGEgbGF5ZXIg4oaSIGVhY2ggZWxlbWVudCBiZWNvbWVzIGl0cyBvd24gZ3JvdXAtb2Ytb25lIGxheWVyIGluIHBsYWNlXG4gICAgICBjb25zdCB2aWQgPSBzdGF0ZS5mb2N1cz8udmFyaWFudElkO1xuICAgICAgY29uc3QgbGF5ZXJzID0gdmlkID8gc3RhdGUubGF5ZXJzQnlWYXJpYW50W3ZpZF0gOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBhdCA9IGxheWVycz8uZmluZEluZGV4KChsKSA9PiBsLmlkID09PSBtc2cuaWQpID8/IC0xO1xuICAgICAgaWYgKCF2aWQgfHwgIWxheWVycyB8fCBhdCA8IDApIHJldHVybjtcbiAgICAgIGNvbnN0IG1lbWJlcnMgPSAoc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXSA/PyBbXSlcbiAgICAgICAgLmZpbHRlcigobSkgPT4gbS5sYXllcklkID09PSBtc2cuaWQpXG4gICAgICAgIC5zb3J0KChhLCBiKSA9PiAoYS56T3JkZXIgPz8gMCkgLSAoYi56T3JkZXIgPz8gMCkpO1xuICAgICAgaWYgKG1lbWJlcnMubGVuZ3RoIDwgMikgcmV0dXJuOyAvLyAwLzEgZWxlbWVudCBpcyBhbHJlYWR5IGEgZ3JvdXAtb2Ytb25lXG4gICAgICBwdXNoSGlzdG9yeSh2aWQpO1xuICAgICAgY29uc3QgZnJlc2g6IExheWVyW10gPSBtZW1iZXJzLm1hcCgobSkgPT4ge1xuICAgICAgICBjb25zdCBpZCA9IG5ld0lkKFwibGF5ZXJcIik7XG4gICAgICAgIG0ubGF5ZXJJZCA9IGlkO1xuICAgICAgICBtLnpPcmRlciA9IDA7XG4gICAgICAgIHJldHVybiB7IGlkLCBuYW1lOiBUT09MX0xBQkVMW20udG9vbF0sIGtpbmQ6IGtpbmRGb3JUb29sKG0udG9vbCkgfTtcbiAgICAgIH0pO1xuICAgICAgbGF5ZXJzLnNwbGljZShhdCwgMSwgLi4uZnJlc2gpOyAvLyByZXBsYWNlIHRoZSBkaXNzb2x2ZWQgbGF5ZXIsIHByZXNlcnZpbmcgei1iYW5kXG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJtYXJrLmFkZFwiKSB7XG4gICAgICBjb25zdCBtayA9IG1zZy5tYXJrIGFzIE1hcmsgfCB1bmRlZmluZWQ7XG4gICAgICBjb25zdCB2aWQgPSBzdGF0ZS5mb2N1cz8udmFyaWFudElkO1xuICAgICAgaWYgKCF2aWQgfHwgIW1rPy5pZCB8fCAhTUFSS19UT09MUy5pbmNsdWRlcyhtay50b29sKSkgcmV0dXJuO1xuICAgICAgcHVzaEhpc3RvcnkodmlkKTtcbiAgICAgIGlmICghc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXSkgc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXSA9IFtdO1xuICAgICAgY29uc3QgYXJyID0gc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXTtcbiAgICAgIC8vIGNvbnRhaW5lciBtb2RlbDogaG9ub3IgYSB2YWxpZCBjbGllbnQtY2hvc2VuIGFjdGl2ZSBsYXllciwgZWxzZSBkZWZhdWx0XG4gICAgICBjb25zdCB3YW50ZWQgPSB0eXBlb2YgbWsubGF5ZXJJZCA9PT0gXCJzdHJpbmdcIiA/IG1rLmxheWVySWQgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBvbkxheWVyID0gd2FudGVkICYmIHN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdPy5zb21lKChsKSA9PiBsLmlkID09PSB3YW50ZWQpO1xuICAgICAgbWsubGF5ZXJJZCA9IG9uTGF5ZXIgPyAod2FudGVkIGFzIHN0cmluZykgOiBlbnN1cmVEcmF3TGF5ZXIodmlkKTtcbiAgICAgIG1rLnpPcmRlciA9IGFyci5sZW5ndGg7IC8vIHNlcnZlciBpcyBhdXRob3JpdGF0aXZlIGZvciB6LW9yZGVyXG4gICAgICBhcnIucHVzaChtayk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpOyAvLyBpbmNyZW1lbnRhbCDigJQgbm8gYWdlbnQgZXZlbnQgdW50aWwgY29tbWl0XG4gICAgfSBlbHNlIGlmICh0ID09PSBcIm1hcmsucmVtb3ZlXCIpIHtcbiAgICAgIGNvbnN0IHZpZCA9IHN0YXRlLmZvY3VzPy52YXJpYW50SWQ7XG4gICAgICBpZiAoIXZpZCB8fCAhc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXSkgcmV0dXJuO1xuICAgICAgaWYgKCFzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdLnNvbWUoKG0pID0+IG0uaWQgPT09IG1zZy5pZCkpIHJldHVybjsgLy8gbm8tb3Ag4oaSIG5vIGhpc3RvcnlcbiAgICAgIHB1c2hIaXN0b3J5KHZpZCk7XG4gICAgICBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdID0gc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXS5maWx0ZXIoKG0pID0+IG0uaWQgIT09IG1zZy5pZCk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJtYXJrLnVwZGF0ZVwiKSB7XG4gICAgICAvLyBtb3ZlL3Jlc2l6ZS9yZWxhYmVsIGEgY29tbWl0dGVkIG1hcmsgb24gdGhlIGZvY3VzZWQgaW1hZ2U7IG1lcmdlXG4gICAgICAvLyBnZW9tZXRyeS9sYWJlbC9zdHlsZSBrZXlzIG9ubHksIG5ldmVyIGlkL3Rvb2wvek9yZGVyIChzZXJ2ZXItb3duZWQpLlxuICAgICAgY29uc3QgdmlkID0gc3RhdGUuZm9jdXM/LnZhcmlhbnRJZDtcbiAgICAgIGNvbnN0IG0gPSB2aWRcbiAgICAgICAgPyAoc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXT8uZmluZCgoeCkgPT4geC5pZCA9PT0gbXNnLmlkKSBhc1xuICAgICAgICAgICAgfCBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPlxuICAgICAgICAgICAgfCB1bmRlZmluZWQpXG4gICAgICAgIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgcGF0Y2ggPSBtc2cucGF0Y2ggYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gICAgICBpZiAoIW0gfHwgIXBhdGNoIHx8IHR5cGVvZiBwYXRjaCAhPT0gXCJvYmplY3RcIikgcmV0dXJuO1xuICAgICAgcHVzaEhpc3RvcnkodmlkKTtcbiAgICAgIGZvciAoY29uc3QgW2ssIHZhbF0gb2YgT2JqZWN0LmVudHJpZXMocGF0Y2gpKSB7XG4gICAgICAgIGlmIChrID09PSBcImlkXCIgfHwgayA9PT0gXCJ0b29sXCIgfHwgayA9PT0gXCJ6T3JkZXJcIikgY29udGludWU7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsID09PSBcIm51bWJlclwiIHx8IHR5cGVvZiB2YWwgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICBtW2tdID0gdmFsO1xuICAgICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAgIC8vIGEgZHJhdyBtYXJrJ3MgYHBvaW50c2AgbW92ZS9yZXNpemUgYXMgYSB3aG9sZSBhcnJheSBvZiB7eCx5fVxuICAgICAgICAgIGsgPT09IFwicG9pbnRzXCIgJiZcbiAgICAgICAgICBBcnJheS5pc0FycmF5KHZhbCkgJiZcbiAgICAgICAgICB2YWwuZXZlcnkoXG4gICAgICAgICAgICAocCkgPT5cbiAgICAgICAgICAgICAgcCAmJlxuICAgICAgICAgICAgICB0eXBlb2YgcCA9PT0gXCJvYmplY3RcIiAmJlxuICAgICAgICAgICAgICB0eXBlb2YgKHAgYXMgeyB4OiB1bmtub3duIH0pLnggPT09IFwibnVtYmVyXCIgJiZcbiAgICAgICAgICAgICAgdHlwZW9mIChwIGFzIHsgeTogdW5rbm93biB9KS55ID09PSBcIm51bWJlclwiLFxuICAgICAgICAgIClcbiAgICAgICAgKSB7XG4gICAgICAgICAgbVtrXSA9IHZhbDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwibWFyay5yZW9yZGVyXCIpIHtcbiAgICAgIGNvbnN0IHZpZCA9IHN0YXRlLmZvY3VzPy52YXJpYW50SWQ7XG4gICAgICBpZiAoIXZpZCB8fCAhc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXSkgcmV0dXJuO1xuICAgICAgY29uc3Qgc29ydGVkID0gWy4uLnN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF1dLnNvcnQoXG4gICAgICAgIChhLCBiKSA9PiAoYS56T3JkZXIgPz8gMCkgLSAoYi56T3JkZXIgPz8gMCksXG4gICAgICApO1xuICAgICAgY29uc3QgaWR4ID0gc29ydGVkLmZpbmRJbmRleCgobSkgPT4gbS5pZCA9PT0gbXNnLmlkKTtcbiAgICAgIGlmIChpZHggPCAwKSByZXR1cm47XG4gICAgICBwdXNoSGlzdG9yeSh2aWQpOyAvLyBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdIGlzIHN0aWxsIHRoZSBwcmUtcmVvcmRlciBhcnJheVxuICAgICAgY29uc3QgW21dID0gc29ydGVkLnNwbGljZShpZHgsIDEpO1xuICAgICAgY29uc3QgdGFyZ2V0ID1cbiAgICAgICAgbXNnLmRpcmVjdGlvbiA9PT0gXCJmcm9udFwiXG4gICAgICAgICAgPyBzb3J0ZWQubGVuZ3RoXG4gICAgICAgICAgOiBtc2cuZGlyZWN0aW9uID09PSBcImJhY2stbW9zdFwiXG4gICAgICAgICAgICA/IDBcbiAgICAgICAgICAgIDogbXNnLmRpcmVjdGlvbiA9PT0gXCJmb3J3YXJkXCJcbiAgICAgICAgICAgICAgPyBNYXRoLm1pbihzb3J0ZWQubGVuZ3RoLCBpZHggKyAxKVxuICAgICAgICAgICAgICA6IE1hdGgubWF4KDAsIGlkeCAtIDEpOyAvLyBcImJhY2tcIlxuICAgICAgc29ydGVkLnNwbGljZSh0YXJnZXQsIDAsIG0pO1xuICAgICAgc29ydGVkLmZvckVhY2goKG1tLCBpKSA9PiB7XG4gICAgICAgIG1tLnpPcmRlciA9IGk7XG4gICAgICB9KTtcbiAgICAgIHN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF0gPSBzb3J0ZWQ7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJtYXJrcy5jbGVhclwiKSB7XG4gICAgICBjb25zdCB2aWQgPSBzdGF0ZS5mb2N1cz8udmFyaWFudElkO1xuICAgICAgaWYgKHZpZCAmJiBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdPy5sZW5ndGgpIHtcbiAgICAgICAgcHVzaEhpc3RvcnkodmlkKTtcbiAgICAgICAgc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXSA9IFtdO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJtYXJrcy5yZXBsYWNlXCIpIHtcbiAgICAgIC8vIHdob2xlc2FsZSBzd2FwIG9mIHRoZSBmb2N1c2VkIGltYWdlJ3MgbWFya3MgKHRoZSBlcmFzZXIgdHJpbXMvc3BsaXRzXG4gICAgICAvLyBzZXZlcmFsIHN0cm9rZXMgYXQgb25jZSDihpIgb25lIG1lc3NhZ2UsIG9uZSBoaXN0b3J5IHN0ZXApLiBWYWxpZGF0ZSArXG4gICAgICAvLyByZS1hc3NpZ24gek9yZGVyIGJ5IHBvc2l0aW9uIChzZXJ2ZXItYXV0aG9yaXRhdGl2ZSksIGxpa2UgbWFyay5hZGQuXG4gICAgICBjb25zdCB2aWQgPSBzdGF0ZS5mb2N1cz8udmFyaWFudElkO1xuICAgICAgY29uc3QgaW5jb21pbmcgPSBtc2cubWFya3MgYXMgTWFya1tdIHwgdW5kZWZpbmVkO1xuICAgICAgaWYgKCF2aWQgfHwgIUFycmF5LmlzQXJyYXkoaW5jb21pbmcpKSByZXR1cm47XG4gICAgICBjb25zdCB2YWxpZCA9IGluY29taW5nLmZpbHRlcigobSkgPT4gbT8uaWQgJiYgTUFSS19UT09MUy5pbmNsdWRlcyhtLnRvb2wpKTtcbiAgICAgIHB1c2hIaXN0b3J5KHZpZCk7XG4gICAgICB2YWxpZC5mb3JFYWNoKChtLCBpKSA9PiB7XG4gICAgICAgIG0uek9yZGVyID0gaTtcbiAgICAgIH0pO1xuICAgICAgc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXSA9IHZhbGlkO1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwidW5kb1wiIHx8IHQgPT09IFwicmVkb1wiKSB7XG4gICAgICBjb25zdCB2aWQgPSBzdGF0ZS5mb2N1cz8udmFyaWFudElkO1xuICAgICAgaWYgKCF2aWQpIHJldHVybjtcbiAgICAgIGNvbnN0IGggPSBoaXN0Rm9yKHZpZCk7XG4gICAgICBjb25zdCBmcm9tID0gdCA9PT0gXCJ1bmRvXCIgPyBoLnVuZG8gOiBoLnJlZG87XG4gICAgICBjb25zdCB0byA9IHQgPT09IFwidW5kb1wiID8gaC5yZWRvIDogaC51bmRvO1xuICAgICAgaWYgKCFmcm9tLmxlbmd0aCkgcmV0dXJuO1xuICAgICAgdG8ucHVzaChzbmFwRm9yKHZpZCkpO1xuICAgICAgY29uc3QgcHJldiA9IGZyb20ucG9wKCkgYXMgTWFya1NuYXA7XG4gICAgICBzdGF0ZS5tYXJrc0J5VmFyaWFudFt2aWRdID0gcHJldi5tYXJrcztcbiAgICAgIHN0YXRlLmxheWVyc0J5VmFyaWFudFt2aWRdID0gcHJldi5sYXllcnM7XG4gICAgICBtYXJrVW5zZWVuW3ZpZF0gPSB0cnVlOyAvLyB0aGUgbWFya3MvbGF5ZXJzIGNoYW5nZWQg4oaSIGFnZW50J3MgdmlldyBpcyBzdGFsZSBhZ2FpblxuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICB9IGVsc2UgaWYgKHQgPT09IFwibWFya3MuY29tbWl0XCIpIHtcbiAgICAgIGlmIChcbiAgICAgICAgdHlwZW9mIG1zZy50ZXh0ICE9PSBcInN0cmluZ1wiIHx8XG4gICAgICAgIHR5cGVvZiBtc2cuYmF0Y2hJZCAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICAgICB0eXBlb2YgbXNnLnZhcmlhbnRJZCAhPT0gXCJzdHJpbmdcIlxuICAgICAgKVxuICAgICAgICByZXR1cm47XG4gICAgICBjb25zdCBtYXJrcyA9IHN0YXRlLm1hcmtzQnlWYXJpYW50W21zZy52YXJpYW50SWRdID8/IFtdO1xuICAgICAgLy8gVGhlIHZpc3VhbCBoYW5kb2ZmOiB0aGUgc3VyZmFjZSBzZW5kcyB0aGUgaW1hZ2Ugd2l0aCBtYXJrcyBidXJuZWQgaW4gYXMgYVxuICAgICAgLy8gZGF0YS11cmw7IG1hdGVyaWFsaXplIGl0IHRvIGRpc2sgc28gdGhlIGFnZW50IGNhbiAtLXJlZiBpdCBkaXJlY3RseS4gVGhlXG4gICAgICAvLyBibG9iIHN0YXlzIGJyb3dzZXLihpJzZXJ2ZXIgb25seSDigJQganVzdCB0aGUgcGF0aCByaWRlcyB0aGUgU1NFIGV2ZW50LlxuICAgICAgbGV0IGZsYXR0ZW5lZEltYWdlUGF0aDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgICAgaWYgKHR5cGVvZiBtc2cuZmxhdHRlbmVkU3JjID09PSBcInN0cmluZ1wiICYmIG1zZy5mbGF0dGVuZWRTcmMuc3RhcnRzV2l0aChcImRhdGE6XCIpKSB7XG4gICAgICAgIGZsYXR0ZW5lZEltYWdlUGF0aCA9XG4gICAgICAgICAgc2F2ZURhdGFVcmwoc2Vzc2lvbkZpbGVzRGlyLCBuZXdJZChcImZsYXRcIiksIG1zZy5mbGF0dGVuZWRTcmMpIHx8IHVuZGVmaW5lZDtcbiAgICAgIH1cbiAgICAgIHB1c2hNZXNzYWdlKHtcbiAgICAgICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgICAgIGtpbmQ6IFwiZ2VzdHVyZVwiLFxuICAgICAgICB0ZXh0OiBg4pyN77iPICR7bXNnLnRleHR9YCxcbiAgICAgICAgZ2VzdHVyZTogeyBraW5kOiBcIm1hcmtlZFwiLCB0YXJnZXRJZDogbXNnLnZhcmlhbnRJZCB9LFxuICAgICAgfSk7XG4gICAgICAvLyBjb21taXR0aW5nIGhhbmRzIGEgU05BUFNIT1QgdG8gdGhlIGFnZW50IGJ1dCBsZWF2ZXMgdGhlIG1hcmtzIGluIHBsYWNlIOKAlFxuICAgICAgLy8gdGhleSdyZSBkdXJhYmxlIGFubm90YXRpb25zIG9uIHRoZSBpbWFnZSwgbm90IGNvbnN1bWVkIGJ5IHRoZSBzZW5kLiBUaGVcbiAgICAgIC8vIHVzZXIgY2xlYXJzIHRoZW0gZXhwbGljaXRseSAobWFya3MuY2xlYXIpIHdoZW4gdGhleSdyZSBkb25lIHdpdGggdGhlbS5cbiAgICAgIG1hcmtVbnNlZW5bbXNnLnZhcmlhbnRJZF0gPSBmYWxzZTsgLy8gdGhlIGFnZW50IG5vdyBoYXMgdGhlIGxhdGVzdCBtYXJrc1xuICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgIGVtaXRFdmVudCh7XG4gICAgICAgIHR5cGU6IFwibWFya3MuY29tbWl0XCIsXG4gICAgICAgIHRleHQ6IG1zZy50ZXh0LFxuICAgICAgICBiYXRjaElkOiBtc2cuYmF0Y2hJZCxcbiAgICAgICAgdmFyaWFudElkOiBtc2cudmFyaWFudElkLFxuICAgICAgICBtYXJrcyxcbiAgICAgICAgc2VsZWN0ZWRSZWZJZHM6IHNlbGVjdGVkUmVmSWRzKCksXG4gICAgICAgIGZsYXR0ZW5lZEltYWdlUGF0aCxcbiAgICAgIH0pO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJhc3BlY3Quc2V0XCIpIHtcbiAgICAgIGlmICh0eXBlb2YgbXNnLmFzcGVjdCAhPT0gXCJzdHJpbmdcIikgcmV0dXJuO1xuICAgICAgc3RhdGUuYXNwZWN0ID0gbXNnLmFzcGVjdDtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcInNpemUuc2V0XCIpIHtcbiAgICAgIGlmIChtc2cuc2l6ZSAhPT0gXCIxS1wiICYmIG1zZy5zaXplICE9PSBcIjJLXCIpIHJldHVybjtcbiAgICAgIHN0YXRlLnNpemUgPSBtc2cuc2l6ZTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgfSBlbHNlIGlmICh0ID09PSBcInN1Ym1pdFwiKSB7XG4gICAgICBicm9hZGNhc3QoeyB0eXBlOiBcInN1Ym1pdFwiIH0pO1xuICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJzdWJtaXRcIiB9KTtcbiAgICAgIHJlc29sdmVEb25lKHsgY29kZTogMCwgcmVhc29uOiBcInN1Ym1pdFwiIH0pO1xuICAgIH0gZWxzZSBpZiAodCA9PT0gXCJjYW5jZWxcIikge1xuICAgICAgYnJvYWRjYXN0KHsgdHlwZTogXCJjYW5jZWxcIiB9KTtcbiAgICAgIHJlc29sdmVEb25lKHsgY29kZTogMTMwLCByZWFzb246IFwiY2FuY2VsXCIgfSk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgbW9kZSA9IHJlc29sdmVNb2RlKCk7XG5cbiAgLy8gZGV2OiB0aGUgZHluYW1pYyBzdHJpbmctbGl0ZXJhbCBpbXBvcnQga2VlcHMgdGhlIHN1cmZhY2UgZ3JhcGggb2ZmIHRoZVxuICAvLyBtb2R1bGUgbG9hZCBwYXRoIChDb250cmFjdCAxKSDigJQgQnVuIGJ1bmRsZXMgdGhlIC50c3ggZ3JhcGggKyBUYWlsd2luZCBhdFxuICAvLyBzZXJ2ZSB0aW1lLCByZWFkaW5nIGJ1bmZpZy50b21sIGZyb20gY3dkLCB3aGljaCBjbGkudHMgcGlucyB0byBzcmMvaW1hZ28vXG4gIC8vIChDb250cmFjdCA1KS4gaG1yIG9uIGZvciB0aGUgc3VyZmFjZSBpdGVyYXRpb24gbG9vcC5cbiAgLy8gcmVsZWFzZTogZGlzdC8gaXMgc3RhdGljIGFuZCBwcmUtYnVpbHQgKENvbnRyYWN0IDIpIOKAlCBcIi9cIiBpcyBhbnN3ZXJlZCBieVxuICAvLyBzZXJ2ZURpc3QoKSBpbiB0aGUgZmV0Y2ggZmFsbC10aHJvdWdoIGJlbG93LCBzbyB0aGlzIGJyYW5jaCBuZXZlciB0b3VjaGVzXG4gIC8vIHN1cmZhY2UvIG9yIGJ1bmZpZy50b21sIGFuZCBuZXZlciBuZWVkcyBlaXRoZXIgdG8gZXhpc3QuXG4gIC8vIEJ1bidzIFJvdXRlcyB0eXBlIHRpZXMgdGhlIFwiL1wiIHZhbHVlJ3MgdHlwZSB0byB0aGUgbGl0ZXJhbCBvYmplY3Qgc2hhcGUsIHNvXG4gIC8vIGEgbW9kZS10ZXJuYXJ5IHVuaW9uIGNvbmZ1c2VzIGl0cyBvdmVybG9hZCByZXNvbHV0aW9uIOKAlCB0aGUgcnVudGltZVxuICAvLyBiZWhhdmlvciAoSFRNTEJ1bmRsZSBpbiBkZXYsIGFic2VudCBpbiByZWxlYXNlKSBpcyBjb3JyZWN0IGVpdGhlciB3YXkuXG4gIGNvbnN0IGRldkluZGV4ID1cbiAgICBtb2RlID09PSBcImRldlwiXG4gICAgICA/IChhd2FpdCBpbXBvcnQoXCIuLi8uLi8uLi8uLi8uLi9zcmMvaW1hZ28vc3VyZmFjZS9pbmRleC5odG1sXCIpKS5kZWZhdWx0XG4gICAgICA6IHVuZGVmaW5lZDtcbiAgY29uc3Qgcm91dGVzID0gKGRldkluZGV4ID8geyBcIi9cIjogZGV2SW5kZXggfSA6IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCBuZXZlcj47XG5cbiAgbGV0IHNlcnZlcjogUmV0dXJuVHlwZTx0eXBlb2YgQnVuLnNlcnZlPjtcbiAgdHJ5IHtcbiAgICBzZXJ2ZXIgPSBCdW4uc2VydmUoe1xuICAgICAgcG9ydCxcbiAgICAgIGhvc3RuYW1lOiBob3N0LFxuICAgICAgcm91dGVzLFxuICAgICAgLy8g4puUIEhFTEQgU1NFIENPTk5FQ1RJT05TIERJRSBXSVRIT1VUIFRISVMuIEJ1bidzIGRlZmF1bHQgcmVxdWVzdFxuICAgICAgLy8gaWRsZVRpbWVvdXQgaXMgMTBzIGFuZCBhIHNlcnZlci1zZW50IGhlYXJ0YmVhdCBkb2VzIE5PVCByZXNldCBpdCwgc28gYW5cbiAgICAgIC8vIFNTRSBjbGllbnQgaXMgY2xvc2VkIGJlZm9yZSB0aGUgMTVzIGA6IGhiYCBiZWxvdyBldmVyIGZpcmVzIOKAlCB0aGVcbiAgICAgIC8vIGtlZXBhbGl2ZSBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzIGtlZXBpbmcgYWxpdmUgaXNcbiAgICAgIC8vIGdvbmUsIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgcmF0ZSB3b3VsZCBub3QgaGF2ZSBoZWxwZWQuXG4gICAgICAvLyAyNTUgaXMgQnVuJ3MgbWF4aW11bSAoMCBpcyBub3QgXCJkaXNhYmxlZFwiKSwgbWF0Y2hpbmcgYm91bnR5LCBncmFwZXZpbmVcbiAgICAgIC8vIGFuZCBtaW5kLW1hcHBlcjsgYXN0cm9sYWJlIGVudi10dW5lcyBpdCBhbmQgY2xhbXBzIHRoZSBoZWFydGJlYXQgdG8gaGFsZi5cbiAgICAgIC8vIEZvdW5kIDIwMjYtMDktMDggYnkgdGhlIGJhY2tlbmQgZHVwbGljYXRpb24gcmVjb246IGZvdXIgc3BlbGxzIGhhZCBoaXRcbiAgICAgIC8vIHRoaXMgYW5kIGZpeGVkIGl0LCB0aHJlZSBoYWQgbm90LCBiZWNhdXNlIHRoZSBkYWVtb24gc3BpbmUgaXMgb25lIGRlc2lnblxuICAgICAgLy8gaW1wbGVtZW50ZWQgc2l4IHRpbWVzLlxuICAgICAgaWRsZVRpbWVvdXQ6IDI1NSxcbiAgICAgIGRldmVsb3BtZW50OiB7IGhtcjogbW9kZSA9PT0gXCJkZXZcIiB9LFxuICAgICAgZmV0Y2g6IChyZXEsIHNydikgPT4ge1xuICAgICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwpO1xuICAgICAgICBjb25zdCBwYXRoID0gdXJsLnBhdGhuYW1lO1xuICAgICAgICBpZiAocGF0aCA9PT0gXCIvd3NcIikge1xuICAgICAgICAgIGNvbnN0IHVwZ3JhZGVkID0gc3J2LnVwZ3JhZGUocmVxKTtcbiAgICAgICAgICBpZiAodXBncmFkZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShcInVwZ3JhZGUgcmVxdWlyZWRcIiwgeyBzdGF0dXM6IDQyNiB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9zdGF0ZVwiKSB7XG4gICAgICAgICAgY29uc3QgbGVhbiA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwibGVhblwiKSA9PT0gXCIxXCI7XG4gICAgICAgICAgY29uc3QgcGF5bG9hZCA9IGxlYW4gPyBsZWFuU3RhdGUoc3RhdGUpIDogc3RhdGU7XG4gICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShKU09OLnN0cmluZ2lmeSh7IHN0YXRlOiBwYXlsb2FkLCBjdXJzb3I6IGV2ZW50U2VxIH0pLCB7XG4gICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZXZlbnRzXCIpIHtcbiAgICAgICAgICByZXR1cm4gc3NlUmVzcG9uc2UodXJsKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJQT1NUXCIgJiYgcGF0aCA9PT0gXCIvY21kXCIpIHtcbiAgICAgICAgICByZXR1cm4gcmVxXG4gICAgICAgICAgICAuanNvbigpXG4gICAgICAgICAgICAudGhlbihhc3luYyAoYm9keSkgPT4ge1xuICAgICAgICAgICAgICB0b3VjaCgpO1xuICAgICAgICAgICAgICAvLyAjODQg4oCUIHRoZSBgYXdhaXRgIGhlcmUgd2FzIEFMUkVBRFkgY29ycmVjdC4gV2hhdCB3YXMgbWlzc2luZyBpc1xuICAgICAgICAgICAgICAvLyBhIHZlcmRpY3QgdG8gcHJvcGFnYXRlLCBzbyB0aGlzIGFuc3dlcmVkIGEgbGl0ZXJhbCBvazp0cnVlIGV2ZW5cbiAgICAgICAgICAgICAgLy8gdG8gY29tbWFuZHMgaXQgZHJvcHBlZC5cbiAgICAgICAgICAgICAgY29uc3QgdmVyZGljdCA9IGF3YWl0IGhhbmRsZUFnZW50TXNnKGJvZHkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pO1xuICAgICAgICAgICAgICAvLyBBIGNvbW1hbmQgdGhhdCBhbnN3ZXJlZCB3aXRoIGl0cyBvd24gcmVzdWx0IGNhcnJpZXMgaXRzIG93blxuICAgICAgICAgICAgICAvLyBzdGF0dXMgYW5kIHBheWxvYWQ7IHRoZSBib29sZWFuIHBhdGggYmVsb3cgaXMgdW5jaGFuZ2VkLlxuICAgICAgICAgICAgICBpZiAodHlwZW9mIHZlcmRpY3QgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXZlcmRpY3Qub2spIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKFxuICAgICAgICAgICAgICAgICAgICB7IG9rOiBmYWxzZSwgYXBwbGllZDogZmFsc2UsIGVycm9yOiB2ZXJkaWN0LmVycm9yLCAuLi52ZXJkaWN0LmRldGFpbCB9LFxuICAgICAgICAgICAgICAgICAgICB7IHN0YXR1czogdmVyZGljdC5zdGF0dXMgfSxcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IHRydWUsIGFwcGxpZWQ6IHRydWUsIC4uLnZlcmRpY3QuZGV0YWlsIH0pO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGNvbnN0IGFwcGxpZWQgPSB2ZXJkaWN0O1xuICAgICAgICAgICAgICBpZiAoIWFwcGxpZWQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbihcbiAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICBhcHBsaWVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgZXJyb3I6IGB1bnJlY29nbmlzZWQgY29tbWFuZCB0eXBlICR7SlNPTi5zdHJpbmdpZnkoXG4gICAgICAgICAgICAgICAgICAgICAgKGJvZHkgYXMgeyB0eXBlPzogdW5rbm93biB9KT8udHlwZSxcbiAgICAgICAgICAgICAgICAgICAgKX0g4oCUIG5vdGhpbmcgd2FzIGFwcGxpZWRgLFxuICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgIHsgc3RhdHVzOiA0MDAgfSxcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoJ3tcIm9rXCI6dHJ1ZSxcImFwcGxpZWRcIjp0cnVlfScsIHtcbiAgICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIC5jYXRjaChcbiAgICAgICAgICAgICAgKCkgPT5cbiAgICAgICAgICAgICAgICBuZXcgUmVzcG9uc2UoJ3tcImVycm9yXCI6XCJiYWQganNvblwifScsIHtcbiAgICAgICAgICAgICAgICAgIHN0YXR1czogNDAwLFxuICAgICAgICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoLnN0YXJ0c1dpdGgoXCIvYXNzZXRzL1wiKSkge1xuICAgICAgICAgIGNvbnN0IGFzc2V0TmFtZSA9IGRlY29kZVVSSUNvbXBvbmVudChwYXRoLnNsaWNlKFwiL2Fzc2V0cy9cIi5sZW5ndGgpKTtcbiAgICAgICAgICBpZiAoYXNzZXROYW1lLmluY2x1ZGVzKFwiLi5cIikgfHwgYXNzZXROYW1lLnN0YXJ0c1dpdGgoXCIvXCIpKSB7XG4gICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCd7XCJlcnJvclwiOlwibm90IGZvdW5kXCJ9Jywge1xuICAgICAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IGYgPSBCdW4uZmlsZShqb2luKGFzc2V0c0RpciwgYXNzZXROYW1lKSk7XG4gICAgICAgICAgcmV0dXJuIGYuZXhpc3RzKCkudGhlbigoZXhpc3RzKSA9PlxuICAgICAgICAgICAgZXhpc3RzXG4gICAgICAgICAgICAgID8gbmV3IFJlc3BvbnNlKGYsIHsgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBndWVzc01pbWUoYXNzZXROYW1lKSB9IH0pXG4gICAgICAgICAgICAgIDogbmV3IFJlc3BvbnNlKCd7XCJlcnJvclwiOlwibm90IGZvdW5kXCJ9Jywge1xuICAgICAgICAgICAgICAgICAgc3RhdHVzOiA0MDQsXG4gICAgICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICAvLyByZWxlYXNlOiBcIi9cIiBhbmQgdGhlIGhhc2hlZCBjaHVuay0qLmpzL2NzcyBhcmUgc3RhdGljIGRpc3QgcmVhZHMuIERldlxuICAgICAgICAvLyBuZXZlciByZWFjaGVzIGhlcmUgZm9yIFwiL1wiIOKAlCB0aGUgcm91dGVzIHRhYmxlIGFib3ZlIGFuc3dlcnMgaXQgZmlyc3QuXG4gICAgICAgIC8vIFRoaXMgc2l0cyBBRlRFUiAvYXNzZXRzLywgd2hpY2ggc2VydmVzIHNlc3Npb24gZmlsZXMsIG5vdCBkaXN0IG9uZXMuXG4gICAgICAgIGlmIChtb2RlID09PSBcInJlbGVhc2VcIikge1xuICAgICAgICAgIGNvbnN0IGFzc2V0ID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICAgIGlmIChhc3NldCkgcmV0dXJuIGFzc2V0O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoJ3tcImVycm9yXCI6XCJub3QgZm91bmRcIn0nLCB7XG4gICAgICAgICAgc3RhdHVzOiA0MDQsXG4gICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICB9KTtcbiAgICAgIH0sXG4gICAgICB3ZWJzb2NrZXQ6IHtcbiAgICAgICAgb3Blbih3cykge1xuICAgICAgICAgIHNvY2tldHMuYWRkKHdzKTtcbiAgICAgICAgICB0b3VjaCgpO1xuICAgICAgICAgIGVtaXRFdmVudCh7IHR5cGU6IFwiY29ubmVjdGVkXCIgfSk7XG4gICAgICAgICAgd3Muc2VuZChKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGUgfSkpO1xuICAgICAgICB9LFxuICAgICAgICBtZXNzYWdlKF93cywgcmF3KSB7XG4gICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICBsZXQgbXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgbXNnID0gSlNPTi5wYXJzZSh0eXBlb2YgcmF3ID09PSBcInN0cmluZ1wiID8gcmF3IDogbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHJhdykpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgICBgaW1hZ286IGJhZCBqc29uIGZyb20gYnJvd3NlcjogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuYCxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIHZvaWQgaGFuZGxlQnJvd3Nlck1zZyhtc2cpO1xuICAgICAgICB9LFxuICAgICAgICBjbG9zZSh3cykge1xuICAgICAgICAgIHNvY2tldHMuZGVsZXRlKHdzKTtcbiAgICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcImRpc2Nvbm5lY3RlZFwiIH0pO1xuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBldmVudDogXCJiaW5kX2Vycm9yXCIsXG4gICAgICAgIGhvc3QsXG4gICAgICAgIHBvcnQsXG4gICAgICAgIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSksXG4gICAgICB9KX1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIDI7XG4gIH1cblxuICBjb25zdCBib3VuZFBvcnQgPSBzZXJ2ZXIucG9ydDtcbiAgaWYgKCFzZXNzaW9uSWQpIHNlc3Npb25JZCA9IGBpbWFnby0ke3JhbmRIZXgoNCl9LXAke2JvdW5kUG9ydH1gO1xuICBzZXNzaW9uRmlsZXNEaXIgPSBqb2luKHRtcGRpcigpLCBgJHtzZXNzaW9uSWR9LWZpbGVzYCk7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKHNlc3Npb25GaWxlc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGZhbGwgYmFjayB0byBuby1maWxlLXBhdGhzIChwYXRoIHN0YXlzIFwiXCIpICovXG4gIH1cbiAgLy8gT24gcmVzdG9yZSwgdGhlIHNuYXBzaG90J3Mgc3JjIGJsb2JzIGFyZSBzZWxmLWNvbnRhaW5lZCBidXQgaXRzIGZpbGUgcGF0aHNcbiAgLy8gYXJlIHN0YWxlIChvbGQgdG1wZGlyLCBjbGVhbmVkKS4gUmUtbWF0ZXJpYWxpemUgZmlsZXMgc28gdGhlIGFnZW50J3MgdmlzaW9uXG4gIC8vIChSZWFkIGJ5IHBhdGgpIHdvcmtzIGFnYWluLlxuICBpZiAocmVzdG9yZWQpIHtcbiAgICAvLyByZWZzLWFzLWFzc2V0cyBtaWdyYXRpb246IGEgbGVnYWN5IGByZWZzW11gIGFycmF5IOKGkiBhbiBpbXBvcnQta2luZCBiYXRjaCBvZlxuICAgIC8vIHZhcmlhbnRzLCBSRVVTSU5HIGVhY2ggcmVmIGlkIGFzIHRoZSB2YXJpYW50IGlkIChzbyByZS1yZXN0b3JlIGlzIGlkZW1wb3RlbnRcbiAgICAvLyBhbmQgYW55IGhpc3RvcmljYWwgc2VsZWN0ZWRSZWZJZHMgc3RpbGwgcmVzb2x2ZSkuIFJ1bnMgQkVGT1JFIG1hdGVyaWFsaXphdGlvblxuICAgIC8vIHNvIHRoZSBuZXcgdmFyaWFudHMgZ2V0IHRoZWlyIG9uLWRpc2sgcGF0aHMuXG4gICAgdHlwZSBMZWdhY3lSZWYgPSB7XG4gICAgICBpZDogc3RyaW5nO1xuICAgICAgc3JjOiBzdHJpbmc7XG4gICAgICBwYXRoPzogc3RyaW5nO1xuICAgICAgbmFtZT86IHN0cmluZztcbiAgICAgIHNlbGVjdGVkPzogYm9vbGVhbjtcbiAgICAgIGhhc2g/OiBzdHJpbmc7XG4gICAgICBhbmFseXNpcz86IHN0cmluZztcbiAgICB9O1xuICAgIGNvbnN0IGxlZ2FjeVJlZnMgPSAoc3RhdGUgYXMgeyByZWZzPzogTGVnYWN5UmVmW10gfSkucmVmcztcbiAgICBpZiAoQXJyYXkuaXNBcnJheShsZWdhY3lSZWZzKSAmJiBsZWdhY3lSZWZzLmxlbmd0aCkge1xuICAgICAgc3RhdGUuYmF0Y2hlcy5wdXNoKHtcbiAgICAgICAgaWQ6IG5ld0lkKFwiYlwiKSxcbiAgICAgICAga2luZDogXCJpbXBvcnRcIixcbiAgICAgICAgcHJvbXB0OiBcIlwiLFxuICAgICAgICB0YWc6IFwicmVmZXJlbmNlc1wiLFxuICAgICAgICB2YXJpYW50czogbGVnYWN5UmVmcy5tYXAoKHIpID0+IHtcbiAgICAgICAgICBjb25zdCBoYXNoID0gci5oYXNoID8/IChyLnNyYyA/IGNvbnRlbnRIYXNoKHIuc3JjKSA6IHVuZGVmaW5lZCk7XG4gICAgICAgICAgLy8gc2VlZCB0aGUgaGFzaOKGkmFuYWx5c2lzIGNhY2hlIHNvIGRlbGV0aW5nICsgcmUtaW1wb3J0aW5nIHRoZSBzYW1lIHBpeGVsc1xuICAgICAgICAgIC8vIHN0aWxsIHJldXNlcyB0aGUgYWdlbnQncyBwcmlvciByZWFkICh0aGUgb2xkIGRlbGV0ZS9yZS1hZGQgaW52YXJpYW50KVxuICAgICAgICAgIGlmIChoYXNoICYmIHIuYW5hbHlzaXMpIHN0YXRlLmFuYWx5c2lzQ2FjaGVbaGFzaF0gPSByLmFuYWx5c2lzO1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBpZDogci5pZCwgLy8gcmV1c2UgdGhlIHJlZiBpZCBhcyB0aGUgdmFyaWFudCBpZFxuICAgICAgICAgICAgc3JjOiByLnNyYyxcbiAgICAgICAgICAgIHBhdGg6IHIucGF0aCA/PyBcIlwiLFxuICAgICAgICAgICAgbGlrZWQ6IGZhbHNlLFxuICAgICAgICAgICAgYW5hbHlzaXM6IHIuYW5hbHlzaXMgPz8gXCJcIixcbiAgICAgICAgICAgIG5hbWU6IHIubmFtZSxcbiAgICAgICAgICAgIHJlZlNlbGVjdGVkOiByLnNlbGVjdGVkID09PSB0cnVlLFxuICAgICAgICAgICAgaGFzaCxcbiAgICAgICAgICB9O1xuICAgICAgICB9KSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBkZWxldGUgKHN0YXRlIGFzIHsgcmVmcz86IHVua25vd24gfSkucmVmcztcblxuICAgIC8vIGNvbnRleHQtbGlicmFyeSBtaWdyYXRpb246IGxlZ2FjeSBzdHlsZXNbXS9wcm9tcHRzW10g4oaSIHVuaWZpZWQgbGlicmFyeSArIHNldHMuXG4gICAgdHlwZSBMZWdhY3lTdHlsZSA9IHtcbiAgICAgIG5hbWU6IHN0cmluZztcbiAgICAgIGFjdGl2ZT86IGJvb2xlYW47XG4gICAgICBjYXB0dXJlZD86IGJvb2xlYW47XG4gICAgICBkZXNjcmlwdGlvbj86IHN0cmluZztcbiAgICAgIGltYWdlPzogc3RyaW5nO1xuICAgICAgaW1hZ2VQYXRoPzogc3RyaW5nO1xuICAgIH07XG4gICAgdHlwZSBMZWdhY3lQcm9tcHQgPSB7IGlkOiBzdHJpbmc7IGxhYmVsOiBzdHJpbmc7IHRleHQ6IHN0cmluZyB9O1xuICAgIGNvbnN0IGlzTGVnYWN5Q29udGV4dCA9XG4gICAgICBBcnJheS5pc0FycmF5KChzdGF0ZSBhcyB7IHN0eWxlcz86IHVua25vd24gfSkuc3R5bGVzKSB8fFxuICAgICAgQXJyYXkuaXNBcnJheSgoc3RhdGUgYXMgeyBwcm9tcHRzPzogdW5rbm93biB9KS5wcm9tcHRzKTtcbiAgICBpZiAoaXNMZWdhY3lDb250ZXh0KSB7XG4gICAgICBzdGF0ZS5saWJyYXJ5ID0gW107XG4gICAgICBzdGF0ZS5hY3RpdmVDb250ZXh0SWRzID0gW107XG4gICAgICBzdGF0ZS5xdWlja1Byb21wdElkcyA9IFtdO1xuICAgIH0gZWxzZSB7XG4gICAgICBzdGF0ZS5saWJyYXJ5ID8/PSBbXTtcbiAgICAgIHN0YXRlLmFjdGl2ZUNvbnRleHRJZHMgPz89IFtdO1xuICAgICAgc3RhdGUucXVpY2tQcm9tcHRJZHMgPz89IFtdO1xuICAgIH1cbiAgICBjb25zdCBsZWdhY3lTdHlsZXMgPSAoc3RhdGUgYXMgeyBzdHlsZXM/OiBMZWdhY3lTdHlsZVtdIH0pLnN0eWxlcztcbiAgICBpZiAoQXJyYXkuaXNBcnJheShsZWdhY3lTdHlsZXMpKSB7XG4gICAgICBmb3IgKGNvbnN0IHN0IG9mIGxlZ2FjeVN0eWxlcykge1xuICAgICAgICBjb25zdCBuYW1lID0gbm9ybVN0eWxlKHN0Lm5hbWUpO1xuICAgICAgICBjb25zdCBpZCA9IHN0eWxlSWQobmFtZSk7XG4gICAgICAgIHN0YXRlLmxpYnJhcnkucHVzaCh7XG4gICAgICAgICAgaWQsXG4gICAgICAgICAga2luZDogXCJzdHlsZVwiLFxuICAgICAgICAgIG5hbWUsXG4gICAgICAgICAgY29udGVudDogc3QuZGVzY3JpcHRpb24gPz8gXCJcIixcbiAgICAgICAgICBpbWFnZTogc3QuaW1hZ2UsXG4gICAgICAgICAgaW1hZ2VQYXRoOiBzdC5pbWFnZVBhdGgsXG4gICAgICAgICAgY2FwdHVyZWQ6IHN0LmNhcHR1cmVkLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKHN0LmFjdGl2ZSkgc3RhdGUuYWN0aXZlQ29udGV4dElkcy5wdXNoKGlkKTtcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgbGVnYWN5UHJvbXB0cyA9IChzdGF0ZSBhcyB7IHByb21wdHM/OiBMZWdhY3lQcm9tcHRbXSB9KS5wcm9tcHRzO1xuICAgIGlmIChBcnJheS5pc0FycmF5KGxlZ2FjeVByb21wdHMpKSB7XG4gICAgICBmb3IgKGNvbnN0IHAgb2YgbGVnYWN5UHJvbXB0cykge1xuICAgICAgICBzdGF0ZS5saWJyYXJ5LnB1c2goe1xuICAgICAgICAgIGlkOiBwLmlkLFxuICAgICAgICAgIGtpbmQ6IFwicHJvbXB0XCIsXG4gICAgICAgICAgbmFtZTogcC5sYWJlbCxcbiAgICAgICAgICBjb250ZW50OiBwLnRleHQsXG4gICAgICAgIH0pO1xuICAgICAgICBzdGF0ZS5xdWlja1Byb21wdElkcy5wdXNoKHAuaWQpO1xuICAgICAgfVxuICAgIH1cbiAgICBkZWxldGUgKHN0YXRlIGFzIHsgc3R5bGVzPzogdW5rbm93biB9KS5zdHlsZXM7XG4gICAgZGVsZXRlIChzdGF0ZSBhcyB7IHByb21wdHM/OiB1bmtub3duIH0pLnByb21wdHM7XG5cbiAgICBmb3IgKGNvbnN0IGIgb2Ygc3RhdGUuYmF0Y2hlcykge1xuICAgICAgZm9yIChjb25zdCB2MiBvZiBiLnZhcmlhbnRzKSB7XG4gICAgICAgIGlmICh2Mi5zcmMpIHYyLnBhdGggPSBzYXZlRGF0YVVybChzZXNzaW9uRmlsZXNEaXIsIHYyLmlkLCB2Mi5zcmMpIHx8IHYyLnBhdGg7XG4gICAgICAgIGlmICh2Mi5hbmFseXNpcyA9PT0gdW5kZWZpbmVkKSB2Mi5hbmFseXNpcyA9IFwiXCI7IC8vIGJhY2tmaWxsIHByZS1hbmFseXNpcyBzbmFwc2hvdHNcbiAgICAgIH1cbiAgICB9XG4gICAgZm9yIChjb25zdCBlIG9mIHN0YXRlLmxpYnJhcnkpIHtcbiAgICAgIGlmIChlLmltYWdlKSBlLmltYWdlUGF0aCA9IHNhdmVEYXRhVXJsKHNlc3Npb25GaWxlc0RpciwgZS5pZCwgZS5pbWFnZSkgfHwgZS5pbWFnZVBhdGg7XG4gICAgfVxuICAgIC8vIE1pZ3JhdGUgcHJlLWR1cmFiaWxpdHkgc25hcHNob3RzOiBhIGxlZ2FjeSBnbG9iYWwgYG1hcmtzYCBhcnJheSDihpIgdGhlXG4gICAgLy8gZm9jdXNlZCB2YXJpYW50J3MgYnVja2V0LiBUaGVuIG5vcm1hbGl6ZSB6T3JkZXIgd2l0aGluIGVhY2ggYnVja2V0LlxuICAgIGNvbnN0IGxlZ2FjeSA9IChzdGF0ZSBhcyB7IG1hcmtzPzogTWFya1tdIH0pLm1hcmtzO1xuICAgIGlmIChBcnJheS5pc0FycmF5KGxlZ2FjeSkpIHtcbiAgICAgIGlmIChsZWdhY3kubGVuZ3RoICYmIHN0YXRlLmZvY3VzKSBzdGF0ZS5tYXJrc0J5VmFyaWFudFtzdGF0ZS5mb2N1cy52YXJpYW50SWRdID0gbGVnYWN5O1xuICAgICAgZGVsZXRlIChzdGF0ZSBhcyB7IG1hcmtzPzogTWFya1tdIH0pLm1hcmtzO1xuICAgIH1cbiAgICBzdGF0ZS5tYXJrc0J5VmFyaWFudCA/Pz0ge307XG4gICAgc3RhdGUubGF5ZXJzQnlWYXJpYW50ID8/PSB7fTtcbiAgICBmb3IgKGNvbnN0IHZpZCBvZiBPYmplY3Qua2V5cyhzdGF0ZS5tYXJrc0J5VmFyaWFudCkpIHtcbiAgICAgIGNvbnN0IG1hcmtzID0gc3RhdGUubWFya3NCeVZhcmlhbnRbdmlkXTtcbiAgICAgIC8vIEJhY2tmaWxsIHRoZSBjb250YWluZXIgbW9kZWw6IHdyYXAgcHJlLWxheWVyIG1hcmtzIGludG8gb25lIGRlZmF1bHRcbiAgICAgIC8vIFwiQW5ub3RhdGlvbnNcIiBsYXllciwgdGhlbiBzdGFtcCBsYXllcklkICsgbm9ybWFsaXplIHpPcmRlciBieSBwb3NpdGlvbi5cbiAgICAgIGxldCBsYXllcnMgPSBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXTtcbiAgICAgIGlmICghbGF5ZXJzPy5sZW5ndGggJiYgbWFya3MubGVuZ3RoKSB7XG4gICAgICAgIGxheWVycyA9IFt7IGlkOiBuZXdJZChcImxheWVyXCIpLCBuYW1lOiBcIkFubm90YXRpb25zXCIsIGtpbmQ6IFwiYW5ub3RhdGlvblwiIH1dO1xuICAgICAgICBzdGF0ZS5sYXllcnNCeVZhcmlhbnRbdmlkXSA9IGxheWVycztcbiAgICAgIH1cbiAgICAgIGNvbnN0IGRlZmF1bHRMYXllcklkID0gbGF5ZXJzPy5bbGF5ZXJzLmxlbmd0aCAtIDFdPy5pZDtcbiAgICAgIHN0YXRlLm1hcmtzQnlWYXJpYW50W3ZpZF0gPSBtYXJrcy5tYXAoKG0sIGkpID0+ICh7XG4gICAgICAgIC4uLm0sXG4gICAgICAgIHpPcmRlcjogbS56T3JkZXIgPT09IHVuZGVmaW5lZCA/IGkgOiBtLnpPcmRlcixcbiAgICAgICAgbGF5ZXJJZDogbS5sYXllcklkID8/IGRlZmF1bHRMYXllcklkLFxuICAgICAgfSkpO1xuICAgIH1cbiAgICBzYXZlU25hcHNob3QoKTtcbiAgfVxuXG4gIGNvbnN0IHVybCA9IGBodHRwOi8vJHtob3N0fToke2JvdW5kUG9ydH1gO1xuICAvLyBgbW9kZWAgaXMgdGhlIE9OTFkgdGhpbmcgdGhhdCBkaXNjcmltaW5hdGVzIGEgcmVsZWFzZSBkYWVtb24gZnJvbSBhIGRldlxuICAvLyBvbmU6IHdpdGggcm9vdCBkZXBzIHByZXNlbnQgYSBkZXYgZGFlbW9uIHJlbmRlcnMgYW4gaWRlbnRpY2FsLWxvb2tpbmdcbiAgLy8gc3VyZmFjZSwgc28gXCJpdCBsb29rcyByaWdodFwiIGNhbm5vdCB2ZXJpZnkgQ29udHJhY3QgMS4gaW1hZ28gd3JpdGVzIE5PXG4gIC8vIHN0ZG91dCBoYW5kc2hha2UgKG1pbmQtbWFwcGVyIGFuZCBhc3Ryb2xhYmUgZG8pIOKAlCBpdHMgaGFuZHNoYWtlIGlzIHRoZVxuICAvLyBkaXNjb3ZlcnkgZmlsZSBiZWxvdywgc28gYG1vZGVgIHJpZGVzIEJPVEgsIHNhbWUgcm9sZSwgZGlmZmVyZW50IHRyYW5zcG9ydC5cbiAgZW1pdEV2ZW50KHsgdHlwZTogXCJyZWFkeVwiLCB1cmwsIHBvcnQ6IGJvdW5kUG9ydCwgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLCBtb2RlIH0pO1xuXG4gIC8vIERpc2NvdmVyeSBmaWxlcyDigJQgY2xpLnRzIHJlYWRzIHRoZSBwb3J0IGZyb20gaGVyZS5cbiAgY29uc3Qgc2Vzc2lvbkZpbGUgPSBqb2luKHRtcGRpcigpLCBgaW1hZ28tJHtzZXNzaW9uSWR9Lmpzb25gKTtcbiAgY29uc3QgbGF0ZXN0RmlsZSA9IGpvaW4odG1wZGlyKCksIGBpbWFnby1sYXRlc3QuanNvbmApO1xuICBjb25zdCBzZXNzaW9uSW5mbyA9IEpTT04uc3RyaW5naWZ5KHtcbiAgICB1cmwsXG4gICAgcG9ydDogYm91bmRQb3J0LFxuICAgIHNlc3Npb25faWQ6IHNlc3Npb25JZCxcbiAgICB0aXRsZTogc3RhdGUudGl0bGUsXG4gICAgZmlsZXNfZGlyOiBzZXNzaW9uRmlsZXNEaXIsXG4gICAgbW9kZSxcbiAgfSk7XG4gIC8vIOKaoCBBVE9NSUMsIGJlY2F1c2UgcmVhZFNlc3Npb24gbm93IHRyZWF0cyB1bnBhcnNlYWJsZSBjb250ZW50IGFzIGNvcnJ1cHRpb25cbiAgLy8gcmF0aGVyIHRoYW4gYWJzZW5jZS4gQSBiYXJlIHdyaXRlRmlsZVN5bmMgaXMgbm90IGF0b21pYzogYSBDTEkgcmVhZGluZ1xuICAvLyB3aGlsZSB0aGUgZGFlbW9uIHdyaXRlcyBjYW4gb2JzZXJ2ZSBhIGhhbGYtd3JpdHRlbiBwb2ludGVyLCBhbmQgdW5kZXIgdGhlXG4gIC8vIG9sZCBiZXN0LWVmZm9ydCByZWFkIHRoYXQgc3VyZmFjZWQgYXMgXCJubyBydW5uaW5nIHNlc3Npb25cIi4gV3JpdGUgYmVzaWRlXG4gIC8vIHRoZSB0YXJnZXQgYW5kIHJlbmFtZSDigJQgcmVuYW1lIHdpdGhpbiBvbmUgZGlyZWN0b3J5IGlzIGF0b21pYywgc28gYSByZWFkZXJcbiAgLy8gc2VlcyBlaXRoZXIgdGhlIHByZXZpb3VzIHBvaW50ZXIgb3IgdGhlIG5ldyBvbmUsIG5ldmVyIGEgcGFydGlhbCBmaWxlLlxuICAvLyBGaXhlZCBpbiBnbGFtb3VyIDIwMjYtMDktMDc7IGZvdW5kIHN0YW5kaW5nIGluIHRocmVlIHNpYmxpbmdzIDIwMjYtMDktMDhcbiAgLy8gKGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC1iYWNrZW5kLWR1cGxpY2F0aW9uLXJlY29uLm1kKS5cbiAgY29uc3Qgd3JpdGVBdG9taWMgPSAodGFyZ2V0OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4ge1xuICAgIGNvbnN0IHRtcCA9IGAke3RhcmdldH0uJHtwcm9jZXNzLnBpZH0udG1wYDtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlU3luYyh0bXAsIHRleHQpO1xuICAgICAgcmVuYW1lU3luYyh0bXAsIHRhcmdldCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0cnkge1xuICAgICAgICBybVN5bmModG1wLCB7IGZvcmNlOiB0cnVlIH0pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHRoZSB0ZW1wIGZpbGUgaXMgYWxyZWFkeSBnb25lLCBvciB3YXMgbmV2ZXIgY3JlYXRlZCAqL1xuICAgICAgfVxuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cbiAgfTtcbiAgdHJ5IHtcbiAgICB3cml0ZUF0b21pYyhzZXNzaW9uRmlsZSwgc2Vzc2lvbkluZm8pO1xuICAgIHdyaXRlQXRvbWljKGxhdGVzdEZpbGUsIHNlc3Npb25JbmZvKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYGltYWdvOiBjb3VsZCBub3Qgd3JpdGUgZGlzY292ZXJ5IGZpbGU6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmAsXG4gICAgKTtcbiAgfVxuICBjb25zdCBjbGVhbnVwRGlzY292ZXJ5ID0gYXN5bmMgKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICB1bmxpbmtTeW5jKHNlc3Npb25GaWxlKTtcbiAgICB9IGNhdGNoIHt9XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGN1ciA9IGF3YWl0IEJ1bi5maWxlKGxhdGVzdEZpbGUpLnRleHQoKTtcbiAgICAgIGlmIChKU09OLnBhcnNlKGN1cikuc2Vzc2lvbl9pZCA9PT0gc2Vzc2lvbklkKSB1bmxpbmtTeW5jKGxhdGVzdEZpbGUpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogZ29uZSDigJQgZmluZSAqL1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgaWYgKHNlc3Npb25GaWxlc0Rpcikgcm1TeW5jKHNlc3Npb25GaWxlc0RpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge31cbiAgfTtcblxuICBpZiAoIXZbXCJuby1vcGVuXCJdKSBvcGVuQnJvd3Nlcih1cmwpO1xuXG4gIGNvbnN0IGlkbGVUaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICBpZiAoKHBlcmZvcm1hbmNlLm5vdygpIC0gbGFzdEFjdGl2aXR5KSAvIDEwMDAgPj0gdGltZW91dCkge1xuICAgICAgcmVzb2x2ZURvbmUoeyBjb2RlOiAxMjQsIHJlYXNvbjogXCJ0aW1lb3V0XCIgfSk7XG4gICAgfVxuICB9LCAyNTApO1xuXG4gIC8vIERlYm91bmNlZCBwZXJzaXN0ZW5jZTogc25hcHNob3QgdGhlIGZ1bGwgc3RhdGUgfjFzIGFmdGVyIGFueSBjaGFuZ2UsIHNvIGFcbiAgLy8gcmVzdGFydCAoY2xpLnRzIG9wZW4gLS1yZXN0b3JlIDxpZD4pIHJlc3VtZXMgZXhhY3RseSB3aGVyZSB3ZSBsZWZ0IG9mZi5cbiAgY29uc3Qgc25hcFRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIGlmIChzbmFwRGlydHkpIHtcbiAgICAgIHNuYXBEaXJ0eSA9IGZhbHNlO1xuICAgICAgc2F2ZVNuYXBzaG90KCk7XG4gICAgfVxuICB9LCAxMDAwKTtcblxuICBjb25zdCB7IGNvZGUsIHJlYXNvbiB9ID0gYXdhaXQgZG9uZTtcbiAgY2xlYXJJbnRlcnZhbChpZGxlVGltZXIpO1xuICBjbGVhckludGVydmFsKHNuYXBUaW1lcik7XG4gIHNhdmVTbmFwc2hvdCgpOyAvLyBmaW5hbCB3cml0ZSDigJQga2VlcCBpdCAodGhlIHJlc3VtZSBwb2ludCwgTk9UIGRlbGV0ZWQgb24gY2xvc2UpXG4gIGVtaXRFdmVudCh7IHR5cGU6IFwiY2xvc2VkXCIsIHJlYXNvbiB9KTtcbiAgYnJvYWRjYXN0KHsgdHlwZTogXCJtZXNzYWdlXCIsIHRleHQ6IGBzZXNzaW9uIGVuZGVkOiAke3JlYXNvbn1gIH0pO1xuICAvLyBHcmFjZSBwZXJpb2Qgc28gdGhlIGNsb3NlZCBldmVudCArIHN1Ym1pdC9jYW5jZWwgYnJvYWRjYXN0cyBmbHVzaC5cbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMTUwKSk7XG4gIGZvciAoY29uc3QgdCBvZiBzc2VUaW1lcnMpIGNsZWFySW50ZXJ2YWwodCk7XG4gIGZvciAoY29uc3QgYyBvZiBzc2VDbGllbnRzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGMuY2xvc2UoKTtcbiAgICB9IGNhdGNoIHt9XG4gIH1cbiAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzKSB7XG4gICAgdHJ5IHtcbiAgICAgIHdzLmNsb3NlKCk7XG4gICAgfSBjYXRjaCB7fVxuICB9XG4gIGF3YWl0IFByb21pc2UucmFjZShbc2VydmVyLnN0b3AodHJ1ZSksIG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDIwMCkpXSk7XG4gIGF3YWl0IGNsZWFudXBEaXNjb3ZlcnkoKTtcbiAgcmV0dXJuIGNvZGU7XG59XG5cbi8qKlxuICogVGhlIGRhZW1vbidzIE9ORSBlbnRyeSwgYW5kIGl0IGlzIHRoZSBMQVVOQ0hFUidzIHRvIGNhbGwgKEQxMiwgcGxheWJvb2sgQjMpLlxuICpcbiAqIOKblCBOTyBgaW1wb3J0Lm1ldGEubWFpbmAgQkxPQ0ssIEZPUiBUV08gUkVBU09OUyBBTkQgRUlUSEVSIE9ORSBJUyBGQVRBTC5cbiAqIEZpcnN0LCBgZGlzdC9zZXJ2ZXIuanNgIGlzIElNUE9SVEVEIGJ5IGA8c2tpbGw+L3NjcmlwdHMvc2VydmVyLnRzYCwgc29cbiAqIGBpbXBvcnQubWV0YS5tYWluYCBpcyBGQUxTRSBhbmQgdGhlIGJsb2NrIHdvdWxkIG5ldmVyIHJ1bjogdGhlIGRhZW1vbiB3b3VsZFxuICogYm9vdCwgYmluZCBub3RoaW5nLCBleGl0IDAsIGFuZCBldmVyeSBpbnRlZ3JhdGlvbiB0ZXN0IHdvdWxkIGZhaWwgYXMgXCJuZXZlclxuICogYW5zd2VyZWRcIiwgd2hpY2ggcmVhZHMgbGlrZSBmbGFrZS4gU2Vjb25kIOKAlCBhbmQgdGhpcyBpcyB3aHkgdGhlIGRhZW1vbiBrZWVwc1xuICogbm8gU0VDT05EIGVudHJ5IGV2ZW4gZm9yIGNvbnZlbmllbmNlIOKAlCBgU0tJTExfUk9PVGAgaXMgYGltcG9ydC5tZXRhLmRpci8uLmAsXG4gKiB3aGljaCBpcyB0aGUgc2tpbGwgcm9vdCBPTkxZIGZyb20gYGRpc3QvYC4gUnVuIGZyb20gYHNyYy9pbWFnby9iYWNrZW5kL2AgaXRcbiAqIGNvbXB1dGVzIGBzcmMvaW1hZ28vYCwgZmluZHMgbm8gYGRpc3QvaW5kZXguaHRtbGAsIHNpbGVudGx5IGNob29zZXMgREVWLCBhbmRcbiAqIHRoZW4gZmFpbHMgdGhlIGRldiBpbXBvcnQgZnJvbSB0aGUgd3JvbmcgYW5jaG9yLiBPZmZlcmluZyB0aGF0IGVudHJ5IHdvdWxkIGJlXG4gKiBvZmZlcmluZyBhIHdyb25nIGRhZW1vbi5cbiAqXG4gKiDimqAgVEhFIFRFUk1JTkFMIGBwcm9jZXNzLmV4aXQoZXhpdENvZGUpYCBNT1ZFRCBUTyBUSEUgTEFVTkNIRVIgVkVSQkFUSU0gYW5kXG4gKiBtdXN0IHN0YXkgdGhlcmU6IGl0IGlzIGZhbWlseSBFLXRlcm1pbmFsIGluIGBncmltb2lyZS9leGl0LXNpdGUtaW52ZW50b3J5YCxcbiAqIHBpbm5lZCBhdCBgPHNraWxsPi9zY3JpcHRzL3NlcnZlci50c2AuIEEgZGFlbW9uIGlzIG5vdCBhIENMSSDigJQgaXRzIHRlYXJkb3duXG4gKiBoYXMgYWxyZWFkeSBydW4gaW5zaWRlIGBtYWluYCwgd2hpY2ggYXdhaXRzIGl0cyBvd24gZHJhaW4g4oCUIHNvIHRoZSBDTEknc1xuICogYHByb2Nlc3MuZXhpdENvZGVgLWFuZC1yZXR1cm4gcnVsZSBkb2VzIE5PVCBhcHBseSBoZXJlLCBhbmQgdGhlIHR3byBsYXVuY2hlcnNcbiAqIGRpZmZlcmluZyBvbiB0aGlzIG9uZSBsaW5lIGlzIGRlbGliZXJhdGUuIERvIG5vdCB0aWR5IHRoZW0gaW50byBhIG1hdGNoLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG5cbmV4cG9ydCB0eXBlIHtcbiAgQmF0Y2gsXG4gIEltYWdvU3RhdGUsXG4gIFZhcmlhbnQsXG59IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvaW1hZ28vc2hhcmVkL3R5cGVzXCI7XG5leHBvcnQgeyBkZWZhdWx0U3RhdGUgfSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2ltYWdvL3NoYXJlZC90eXBlc1wiO1xuZXhwb3J0IHsgbWFpbiwgcGFyc2VQb3J0RnJvbVNlc3Npb25JZCB9O1xuIiwKICAgICIvLyBzaGFyZWQvdHlwZXMudHNcbi8vIFRoZSBzaW5nbGUgc2hhcmVkIGNvbnRyYWN0LCBhbmQgdGhlIHJlYXNvbiBzaGFyZWQvIGV4aXN0czogaXQgaXMgYSBQRUVSIG9mXG4vLyBib3RoIHNpZGVzLCBub3QgYmFja2VuZC1vd25lZCAoUjEpLiBJbXBvcnRlZCBieSBzY3JpcHRzL3NlcnZlci50cyBBTkQgdGhlXG4vLyBSZWFjdCBjbGllbnQuIEl0IG11c3QgbGl2ZSBpbiB0aGUgU0hJUFBFRCB0cmVlIOKAlCB0aGUgZGFlbW9uIHJ1bnMgZnJvbSBzb3VyY2Vcbi8vIGF0IGEgZGVzdGluYXRpb24gdGhhdCBuZXZlciByYW4gYGluc3RhbGxgLCBzbyBhbnl0aGluZyBpdCBpbXBvcnRzIGhhcyB0byBiZVxuLy8gcGh5c2ljYWxseSBoZXJlLlxuLy9cbi8vIGltYWdvIGlzIGEgR1JPVU5ERUQgQ09OVkVSU0FUSU9OIGFib3V0IGFuIGltYWdlOiB0aGUgdXNlciBhbmQgdGhlIGFnZW50IHRhbGtcbi8vICh0aGUgYGNvbnZlcnNhdGlvbmApLCB0aGUgc3VyZmFjZSBob2xkcyB0aGUgYXJ0aWZhY3RzIHRoZXkncmUgdGFsa2luZyBhYm91dFxuLy8gKGBiYXRjaGVzYCBvZiBrZXB0IGdlbmVyYXRpb25zLCB0aGUgYGZvY3VzYGVkIG9uZSBvbiB0aGUgY2FudmFzKSwgYW5kIHN1cmZhY2Vcbi8vIGdlc3R1cmVzIChsaWtpbmcsIG1hcmtpbmcsIGF0dGFjaGluZyBhIHJlZikgYXJlIHRoZW1zZWx2ZXMgbWVzc2FnZXMgdGhlIGFnZW50XG4vLyBoZWFycy4gVGhlcmUgaXMgbm8gXCJwaGFzZVwiIHBpcGVsaW5lIOKAlCBpdCdzIGEgbG9vcCwgbm90IGEgZnVubmVsLlxuXG4vLyDilIDilIAgdGhlIGFydGlmYWN0cyAocGllY2VzIG9uIHRoZSBib2FyZCkg4pSA4pSAXG5cbi8vIEEgVmFyaWFudCBpcyBUSEUgdW5pdmVyc2FsIGltYWdlIGFzc2V0IOKAlCBnZW5lcmF0ZWQsIGltcG9ydGVkLCBvciBicm91Z2h0IGluIGFzXG4vLyBhIHJlZmVyZW5jZS4gXCJCZWluZyBhIHJlZmVyZW5jZVwiIGlzIGEgZmxhZyAoYHJlZlNlbGVjdGVkYCksIG5vdCBhIHNlcGFyYXRlIHR5cGU6XG4vLyBhbnkgdmFyaWFudCBjYW4gYmUgZm9jdXNlZCwgYW5ub3RhdGVkLCBBTkQgcG9pbnRlZCBhdCBmb3IgdGhlIG5leHQgZ2VuZXJhdGlvbi5cbmV4cG9ydCB0eXBlIFZhcmlhbnQgPSB7XG4gIGlkOiBzdHJpbmc7XG4gIHNyYzogc3RyaW5nOyAvLyBiYXNlNjQgd2VicDsgc3RyaXBwZWQgaW4gbGVhbiBwcm9qZWN0aW9uIChhZ2VudCByZWFkcyBgcGF0aGApXG4gIHBhdGg6IHN0cmluZzsgLy8gb24tZGlzayBtYXRlcmlhbGl6ZWQgZmlsZSBmb3IgdGhlIGFnZW50IHRvIFJlYWRcbiAgc2VlZD86IG51bWJlcjtcbiAgbW9kZWw/OiBzdHJpbmc7XG4gIGxpa2VkOiBib29sZWFuO1xuICBhbmFseXNpczogc3RyaW5nOyAvLyB0aGUgYWdlbnQncyByZWFkIG9mIFRISVMgaW1hZ2Ug4oCUIGR1cmFibGUsIHVwZGF0YWJsZSBtZXRhZGF0YVxuICAvLyAoZGlzdGluY3QgZnJvbSB0aGUgQmF0Y2ggcHJvbXB0LCB3aGljaCBpcyBmaXhlZCBwcm92ZW5hbmNlKS4gU2hvd24gaW4gZGV0YWlscy5cbiAgLy8gTm8gcGVyLXZhcmlhbnQgcHJvbXB0OiB0aGUgc2V0dGxlZCBwcm9tcHQgbGl2ZXMgb24gdGhlIEJhdGNoIChvbmUgcHJvbXB0LFxuICAvLyBtYW55IHNlZWRzKS4gVGhlIGRpc3BsYXkgbGFiZWwgKFwiYVwiL1wiYlwiL+KApikgaXMgZGVyaXZlZCBmcm9tIGFycmF5IGluZGV4LlxuICBuYW1lPzogc3RyaW5nOyAvLyBlZGl0YWJsZSBsYWJlbDsgYmxhbmsgZm9yIGdlbmVyYXRlZCAodXNlIHRoZSBkZXJpdmVkIGxhYmVsKSwgZmlsZW5hbWUgZm9yIGltcG9ydHNcbiAgcmVmU2VsZWN0ZWQ/OiBib29sZWFuOyAvLyBwb2ludGVkIGF0IGFzIGEgcmVmZXJlbmNlIGZvciB0aGUgbmV4dCBnZW5lcmF0aW9uXG4gIGhhc2g/OiBzdHJpbmc7IC8vIGNvbnRlbnQgaGFzaCAoaW1wb3J0cyBvbmx5KSDigJQgaW1wb3J0IGRlZHVwICsgYW5hbHlzaXNDYWNoZSBrZXlcbn07XG5cbi8vIEEgYmF0Y2ggaXMgb25lIHJvdW5kIG9mIGdlbmVyYXRpb24ga2VwdCB0b2dldGhlciAoYWxsIHZhcmlhbnRzIGtlcHQgYnlcbi8vIGRlZmF1bHQg4oCUIG5vIHNlbGVjdC1vbmUtZGlzY2FyZCkuIGtpbmQgZGlzdGluZ3Vpc2hlcyBhIGZyZXNoIGdlbmVyYXRlIGZyb20gYW5cbi8vIGVkaXQgb2YgYW4gZXhpc3RpbmcgdmFyaWFudC4gVGhlIEJhdGNoLnByb21wdCBpcyBUSEUgc2V0dGxlZCBwcm9tcHQgc2F2ZWRcbi8vIHdpdGggdGhlc2UgaW1hZ2VzICh0aGUgYnJpZWYncyBcInByb21wdCBzYXZlZCB3aXRoIHRoZSBpbWFnZVwiKS4gRGlzcGxheSBvcmRlciAvXG4vLyBcIkJhdGNoIE5cIiBsYWJlbCBpcyBkZXJpdmVkIGZyb20gYXJyYXkgaW5kZXguXG5leHBvcnQgdHlwZSBCYXRjaCA9IHtcbiAgaWQ6IHN0cmluZztcbiAga2luZDogXCJnZW5lcmF0ZVwiIHwgXCJlZGl0XCIgfCBcImltcG9ydFwiOyAvLyBpbXBvcnQgPSBhIHdvcmtpbmcgaW1hZ2UgdGhlIHVzZXIgYnJvdWdodCBpblxuICBwcm9tcHQ6IHN0cmluZzsgLy8gdGhlIHNldHRsZWQgcHJvbXB0IGZvciB0aGlzIGJhdGNoIChcIlwiIGZvciBpbXBvcnRzKVxuICB0YWc/OiBzdHJpbmc7IC8vIHNob3J0IGh1bWFuIHN1bW1hcnkgKFwiYSBmb3ggcmVhZGluZyB1bmRlciBhbiBvYWtcIilcbiAgZWRpdGVkRnJvbVZhcmlhbnRJZD86IHN0cmluZzsgLy8gc2V0IHdoZW4ga2luZCA9PT0gXCJlZGl0XCJcbiAgdmFyaWFudHM6IFZhcmlhbnRbXTtcbn07XG5cbmV4cG9ydCB0eXBlIEZvY3VzID0geyBiYXRjaElkOiBzdHJpbmc7IHZhcmlhbnRJZDogc3RyaW5nIH07XG5cbi8vIOKUgOKUgCB0aGUgY29udmVyc2F0aW9uICh0aGUgc3BpbmUpIOKUgOKUgFxuXG4vLyBFdmVyeSB0dXJuIGF0IHRoZSB0YWJsZSBpcyBhIE1lc3NhZ2UuIE1vc3QgYXJlIHBsYWluIGB0ZXh0YDsgYSBmZXcgY2Fycnlcbi8vIHN0cnVjdHVyZWQgcGllY2VzIHRoZSBzdXJmYWNlIHJlbmRlcnMgc3BlY2lhbGx5LlxuZXhwb3J0IHR5cGUgTWVzc2FnZUtpbmQgPVxuICB8IFwidGV4dFwiIC8vIHBsYWluIGRpYWxvZ3VlIChlaXRoZXIgcm9sZSlcbiAgfCBcInByb21wdFwiIC8vIGFnZW50IHByb3Bvc2VzIGEgcHJvbXB0IHRvIHNlbmQgKGEgcGllY2Ugb24gdGhlIGJvYXJkKVxuICB8IFwicmVzdWx0XCIgLy8gYWdlbnQgcmVwb3J0cyBhIHByb2R1Y2VkIGJhdGNoIChsaW5rcyBgYmF0Y2hJZGApXG4gIHwgXCJnZXN0dXJlXCIgLy8gYSBzdXJmYWNlIGFjdGlvbiBzdXJmYWNlZCBhcyBhIG1lc3NhZ2UgKHVzZXIgbGlrZWQvbWFya2VkL+KApilcbiAgfCBcInF1ZXN0aW9uXCI7IC8vIGFnZW50IG5lZWRzIHRoZSB1c2VyIChhbiB1bmFuc3dlcmVkIG9uZSDihpIgXCJhc2tpbmdcIiBwcmVzZW5jZSlcblxuZXhwb3J0IHR5cGUgTWVzc2FnZSA9IHtcbiAgaWQ6IHN0cmluZztcbiAgcm9sZTogXCJ1c2VyXCIgfCBcImFnZW50XCI7XG4gIGtpbmQ6IE1lc3NhZ2VLaW5kO1xuICB0ZXh0OiBzdHJpbmc7XG4gIHRzOiBudW1iZXI7XG4gIC8vIGtpbmQ6IFwicHJvbXB0XCIg4oCUIHRoZSBwcm9wb3NhbCB0aGUgdXNlciBjb25maXJtcyAoU2VuZCkgb3IgZGlzbWlzc2VzLiBUaGVcbiAgLy8gc2VydmVyIGZsaXBzIGBzdGF0dXNgIG9uIHByb3Bvc2FsLnNlbmQgLyBwcm9wb3NhbC5kaXNtaXNzIChubyBhZ2VudCBjb21tYW5kXG4gIC8vIG5lZWRlZCDigJQgaXQgb3ducyB0aGUgY29udmVyc2F0aW9uIGFycmF5KS5cbiAgcHJvcG9zYWw/OiB7XG4gICAgcHJvbXB0OiBzdHJpbmc7XG4gICAgbjogbnVtYmVyO1xuICAgIHN0YXR1czogXCJwZW5kaW5nXCIgfCBcInNlbnRcIiB8IFwiZGlzbWlzc2VkXCI7XG4gIH07XG4gIC8vIGtpbmQ6IFwicmVzdWx0XCIg4oCUIHRoZSBiYXRjaCB0aGlzIG1lc3NhZ2UgYW5ub3VuY2VkXG4gIGJhdGNoSWQ/OiBzdHJpbmc7XG4gIC8vIGtpbmQ6IFwiZ2VzdHVyZVwiIOKAlCB3aGF0IHRoZSB1c2VyIGRpZCwgYW5kIHRvIHdoYXRcbiAgZ2VzdHVyZT86IHtcbiAgICBraW5kOiBcImxpa2VkXCIgfCBcIm1hcmtlZFwiIHwgXCJyZWYtYWRkZWRcIiB8IFwiZm9jdXNcIiB8IFwiaW1wb3J0ZWRcIjtcbiAgICB0YXJnZXRJZD86IHN0cmluZztcbiAgfTtcbiAgLy8ga2luZDogXCJxdWVzdGlvblwiIOKAlCBvcHRpb25hbCBxdWljayByZXBsaWVzICh0aGUgZnVsbCBhbnN3ZXIgY2FuIGJlIGZyZWUgdGV4dClcbiAgb3B0aW9ucz86IHN0cmluZ1tdO1xufTtcblxuLy8g4pSA4pSAIHN0ZWVyaW5nIHBpZWNlcyAoZ3JvdW5kZWQgc2hvcnRjdXRzKSDilIDilIBcblxuLy8gQSByZXVzYWJsZSBzdHlsZTogY2xpY2tpbmcgdGVsbHMgdGhlIGFnZW50IHRvIGFwcGx5IGl0cyB0ZWNobmlxdWUgZm9yIHRoYXRcbi8vIGxvb2suIGBjYXB0dXJlZGAgbWFya3Mgb25lcyBleHRyYWN0ZWQgZnJvbSBhbiBpbWFnZSAodGhlIGNhdGFsb2cgbG9vcC1jbG9zZXIpLlxuLy8gYG5hbWVgIGlzIHRoZSBrZXkg4oCUIG5vcm1hbGl6ZWQgKHRyaW1tZWQsIGxvd2VyY2FzZWQpIG9uIHdyaXRlIHNvIGNhc2luZyAvXG4vLyB3aGl0ZXNwYWNlIGNhbid0IGNyZWF0ZSBkdXBsaWNhdGVzLlxuLy8gQSB1bmlmaWVkLCByZXVzYWJsZSBwaWVjZSBvZiB0ZXh0dWFsIGFnZW50LWNvbnRleHQuIGBraW5kYCBkcml2ZXMgYmVoYXZpb3IgK1xuLy8gZGVmYXVsdCBmaWx0ZXIgKGEgc3R5bGUgbWF0ZXJpYWxpemVzIGFuIGltYWdlICsgYWN0cyBhcyBhbWJpZW50IGNvbnRleHQ7IGFcbi8vIHByb21wdCBmaWxscyB0aGUgY29tcG9zZXIpIGJ1dCBpcyBOT1QgYSBoYXJkIHJvdXRlciDigJQgbWVtYmVyc2hpcCBpbiBhIGxpbmtlZFxuLy8gc2V0IChzZWUgSW1hZ29TdGF0ZS5hY3RpdmVDb250ZXh0SWRzIC8gcXVpY2tQcm9tcHRJZHMpIGlzIHdoYXQgc3VyZmFjZXMgaXQuXG4vLyBgdGFnc2AgY2FycnkgY3Jvc3Mta2luZCBmaW5kYWJpbGl0eS4gTm8gYGFyY2hpdmVkYDogcmVtb3ZhbCBmcm9tIGEgc2l0ZSBpcyBhblxuLy8gdW5saW5rOyB0aGUgb25seSBkZXN0cm95IGlzIGNvbnRleHQuZGVsZXRlIG9uIHRoZSBsaWJyYXJ5LlxuZXhwb3J0IHR5cGUgQ29udGV4dEtpbmQgPSBcInByb21wdFwiIHwgXCJzdHlsZVwiIHwgXCJza2lsbFwiIHwgXCJjb250ZXh0XCI7XG5leHBvcnQgdHlwZSBDb250ZXh0RW50cnkgPSB7XG4gIGlkOiBzdHJpbmc7XG4gIGtpbmQ6IENvbnRleHRLaW5kO1xuICBuYW1lOiBzdHJpbmc7XG4gIGNvbnRlbnQ6IHN0cmluZztcbiAgdGFncz86IHN0cmluZ1tdO1xuICBpbWFnZT86IHN0cmluZzsgLy8gYmFzZTY0IGlkZW50aXR5IGltYWdlIChzdHJpcHBlZCBpbiB0aGUgbGVhbiBhZ2VudCBwcm9qZWN0aW9uKVxuICBpbWFnZVBhdGg/OiBzdHJpbmc7IC8vIG9uLWRpc2sgbWF0ZXJpYWxpemVkIGltYWdlIHRoZSBhZ2VudCBjYW4gLS1yZWZcbiAgY2FwdHVyZWQ/OiBib29sZWFuOyAvLyBzdHlsZS1vbmx5OiBleHRyYWN0ZWQgZnJvbSBhbiBpbWFnZVxufTtcbi8vIFRoZSBuYW1lZCBsaW5rZWQgc2V0cyBvdmVyIGBsaWJyYXJ5YCAodGhlIGNvbnN1bXB0aW9uIHNpdGVzKS5cbmV4cG9ydCB0eXBlIENvbnRleHRTZXQgPSBcImFjdGl2ZVwiIHwgXCJxdWlja1Byb21wdHNcIjtcblxuLy8gQSB2YWx1ZSB0aGUgdXNlciBwaW5zIHRvIGxvY2sgZm9yIHRoZSBuZXh0IGdlbmVyYXRlIChhZ2VudCBwaWNrcyB0aGUgcmVzdCkuXG5leHBvcnQgdHlwZSBQaW4gPSB7IGtleTogc3RyaW5nOyB2YWx1ZTogc3RyaW5nIH07XG5cbi8vIChSZWZlcmVuY2VzIGFyZSBubyBsb25nZXIgYSBzZXBhcmF0ZSB0eXBlIOKAlCB0aGV5J3JlIFZhcmlhbnRzIHdpdGggYHJlZlNlbGVjdGVkYC5cbi8vIFwiVXNlIHRoZXNlIGZvciB0aGlzIGdlbmVyYXRpb25cIiA9IHRoZSBzZXQgb2YgdmFyaWFudHMgd2hlcmUgcmVmU2VsZWN0ZWQ7IGF0XG4vLyBnZW5lcmF0ZSB0aW1lIHRoZSBhZ2VudCB1c2VzIHRoYXQgc2V0LCBvciBhbGwgaWYgbm9uZSBhcmUgc2VsZWN0ZWQuKVxuXG4vLyBBbiBhbm5vdGF0aW9uIG1hcmsgb24gYSB2YXJpYW50LiBDb29yZHMgYXJlIGZyYWN0aW9ucyAoMOKAkzEpIG9mIHRoZSBpbWFnZSBib3gsXG4vLyBzbyBtYXJrcyB0cmFuc2Zvcm0gd2l0aCBwYW4vem9vbTsgc3Ryb2tlIHdpZHRoICsgdGV4dCBzaXplIGFyZSBhdXRob3JlZCBhdFxuLy8gMTAwJSB6b29tIGFuZCB0aGUgc3VyZmFjZSBzY2FsZXMgdGhlbSB3aXRoIHRoZSB6b29tIHNvIHRoZXkgc3RheSB3ZWxkZWQgdG8gdGhlXG4vLyBpbWFnZS4gTWFya3MgYXJlIERVUkFCTEUgcGVyIGltYWdlIOKAlCBrZXB0IGluIGBtYXJrc0J5VmFyaWFudGAga2V5ZWQgYnkgdmFyaWFudFxuLy8gaWQsIHNvIHN3aXRjaGluZyBhd2F5IGFuZCBiYWNrIHByZXNlcnZlcyB0aGVtOyBjbGVhcmVkIGV4cGxpY2l0bHkgKG1hcmtzLmNsZWFyKVxuLy8gb3Igd2hlbiBjb21taXR0ZWQgdG8gdGhlIGNvbnZlcnNhdGlvbi4gVG9vbHM6IHBpbiAobGFiZWxlZCBwb2ludCksIGFycm93IChcIm1vdmVcbi8vIHRoaXMg4oaSIHRoZXJlXCIpLCBsaW5lLCByZWN0LCBlbGxpcHNlLiBUaGUgbWFzayB0b29sIGRyb3BzIG9udG8gdGhlIHNhbWUgdW5pb24gbGF0ZXIuXG4vLyBgek9yZGVyYCBpcyBzZXJ2ZXItYXNzaWduZWQgb24gbWFyay5hZGQgKGhpZ2hlciA9IG9uIHRvcCk7IHRoZSBzdXJmYWNlIG9taXRzXG4vLyBpdC4gU2VlIGRvY3MvcHJvamVjdHMvaW1hZ28vYW5ub3RhdGlvbi1hcmNoaXRlY3R1cmUubWQuXG4vLyBjb2xvciA9IHN0cm9rZS9hY2NlbnQgY29sb3IgKGEgdGhlbWUgdG9rZW4gbmFtZSBvciBDU1MgY29sb3IpOyB3aWR0aCA9IHN0cm9rZVxuLy8gd2lkdGggaW4gcHg7IGZvbnRTaXplID0gbGFiZWwgdGV4dCBzaXplIGluIHB4IChwaW5zIHVzZSBpdDsgb3RoZXIgbWFya3MgaWdub3JlXG4vLyBpdCkuIEFsbCBvcHRpb25hbCDigJQgdGhlIHN1cmZhY2UgcGlja3Mgc2Vuc2libGUgZGVmYXVsdHMuXG5leHBvcnQgdHlwZSBNYXJrQmFzZSA9IHtcbiAgaWQ6IHN0cmluZztcbiAgek9yZGVyPzogbnVtYmVyOyAvLyBvcmRlciBXSVRISU4gdGhlIGVsZW1lbnQncyBsYXllciAoc2VydmVyLWF1dGhvcml0YXRpdmUpXG4gIGxheWVySWQ/OiBzdHJpbmc7IC8vIHdoaWNoIExheWVyIChjb250YWluZXIpIHRoaXMgZWxlbWVudCBiZWxvbmdzIHRvOyBiYWNrZmlsbGVkIG9uIG1pZ3JhdGlvblxuICByb3RhdGlvbj86IG51bWJlcjsgLy8gZGVncmVlcyBjbG9ja3dpc2UgYWJvdXQgdGhlIGVsZW1lbnQncyBiYm94IGNlbnRlcjsgaW1hZ2UtZmlyc3QgKGFic2VudCA9IDAgPSB0b2RheSlcbiAgbGFiZWw/OiBzdHJpbmc7XG4gIGNvbG9yPzogc3RyaW5nO1xuICB3aWR0aD86IG51bWJlcjtcbiAgZm9udFNpemU/OiBudW1iZXI7XG59O1xuZXhwb3J0IHR5cGUgTWFyayA9XG4gIHwgKE1hcmtCYXNlICYgeyB0b29sOiBcInBpblwiOyB4OiBudW1iZXI7IHk6IG51bWJlciB9KVxuICB8IChNYXJrQmFzZSAmIHtcbiAgICAgIHRvb2w6IFwiYXJyb3dcIjtcbiAgICAgIHgxOiBudW1iZXI7XG4gICAgICB5MTogbnVtYmVyO1xuICAgICAgeDI6IG51bWJlcjtcbiAgICAgIHkyOiBudW1iZXI7XG4gICAgfSlcbiAgfCAoTWFya0Jhc2UgJiB7XG4gICAgICB0b29sOiBcImxpbmVcIjtcbiAgICAgIHgxOiBudW1iZXI7XG4gICAgICB5MTogbnVtYmVyO1xuICAgICAgeDI6IG51bWJlcjtcbiAgICAgIHkyOiBudW1iZXI7XG4gICAgfSlcbiAgfCAoTWFya0Jhc2UgJiB7IHRvb2w6IFwicmVjdFwiOyB4OiBudW1iZXI7IHk6IG51bWJlcjsgdzogbnVtYmVyOyBoOiBudW1iZXIgfSlcbiAgfCAoTWFya0Jhc2UgJiB7XG4gICAgICB0b29sOiBcImVsbGlwc2VcIjtcbiAgICAgIGN4OiBudW1iZXI7XG4gICAgICBjeTogbnVtYmVyO1xuICAgICAgcng6IG51bWJlcjtcbiAgICAgIHJ5OiBudW1iZXI7XG4gICAgfSlcbiAgLy8gZnJlZWZvcm0gc2tldGNoIOKAlCBhbiBvcmRlcmVkIGxpc3Qgb2YgZnJhY3Rpb24tc3BhY2UgcG9pbnRzIChhIHBvbHlsaW5lKS4gVGhlXG4gIC8vIHZpc3VhbCBoYW5kb2ZmIChmbGF0dGVuZWQgaW1hZ2UpIGlzIHdoYXQgdGhlIG1vZGVsIHJlYWRzOyBkb3VibGVzIGFzIGEgZnV0dXJlXG4gIC8vIGlucGFpbnQtbWFzayByZWdpb24uXG4gIHwgKE1hcmtCYXNlICYgeyB0b29sOiBcImRyYXdcIjsgcG9pbnRzOiB7IHg6IG51bWJlcjsgeTogbnVtYmVyIH1bXSB9KVxuICAvLyBhbiBpbWFnZSBMQVlFUiBlbGVtZW50IOKAlCBhIGRyb3BwZWQgY2xpcHBpbmcvcmVmZXJlbmNlIGNvbXBvc2l0ZWQgb250byB0aGVcbiAgLy8gaW1hZ2UuIFJldXNlcyByZWN0IGdlb21ldHJ5ICh4LHksdyxoIGZyYWN0aW9ucykgc28gaXQgaW5oZXJpdHNcbiAgLy8gYm91bmRzL2hpdC9yZXNpemUvdHJhbnNsYXRlOyBgc3JjYCBpcyBhIGJhc2U2NCB3ZWJwIChzdHJpcHBlZCBpbiB0aGUgbGVhblxuICAvLyBhZ2VudCBwcm9qZWN0aW9uIOKAlCB0aGUgYWdlbnQgcmVhZHMgdGhlIGZsYXR0ZW5lZCBjb21wb3NpdGUsIG5vdCBsYXllciBiaXRtYXBzKS5cbiAgfCAoTWFya0Jhc2UgJiB7XG4gICAgICB0b29sOiBcImltYWdlXCI7XG4gICAgICBzcmM6IHN0cmluZztcbiAgICAgIHg6IG51bWJlcjtcbiAgICAgIHk6IG51bWJlcjtcbiAgICAgIHc6IG51bWJlcjtcbiAgICAgIGg6IG51bWJlcjtcbiAgICB9KTtcbmV4cG9ydCBjb25zdCBNQVJLX1RPT0xTOiByZWFkb25seSBNYXJrW1widG9vbFwiXVtdID0gW1xuICBcInBpblwiLFxuICBcImFycm93XCIsXG4gIFwibGluZVwiLFxuICBcInJlY3RcIixcbiAgXCJlbGxpcHNlXCIsXG4gIFwiZHJhd1wiLFxuICBcImltYWdlXCIsXG5dIGFzIGNvbnN0O1xuXG4vLyBBIExBWUVSIGlzIGEgQ09OVEFJTkVSIG9mIG1hcmtzIChlbGVtZW50cykgb24gYSB2YXJpYW50IOKAlCB0aGUgZ3JvdXBpbmcgdW5pdCBmb3Jcbi8vIHotb3JkZXIsIHZpc2liaWxpdHksIGFuZCBsb2NrLiBFbGVtZW50cyByZWZlcmVuY2UgaXQgdmlhIE1hcmsubGF5ZXJJZC4gRWZmZWN0aXZlXG4vLyB6ID0gbGF5ZXIgb3JkZXIgKGFycmF5IGluZGV4IGluIGBsYXllcnNCeVZhcmlhbnRgLCBiYWNr4oaSZnJvbnQpIHRoZW4gdGhlIGVsZW1lbnQnc1xuLy8gYHpPcmRlcmAgV0lUSElOIHRoZSBsYXllci4gQSBcImdyb3VwLW9mLW9uZVwiIChhIHN0YW5kYWxvbmUgYXJyb3cpIGlzIGp1c3QgYSBsYXllclxuLy8gd2l0aCBhIHNpbmdsZSBlbGVtZW50OyBhIHNrZXRjaCBsYXllciBhY2NyZXRlcyBtYW55IHBlbiBzdHJva2VzLiBUaGUgYmFzZSBpbWFnZVxuLy8gKHRoZSBmb2N1c2VkIFZhcmlhbnQpIGlzIHNob3duIGFzIGEgc3ludGhldGljIGxvY2tlZCBcIkJhY2tncm91bmRcIiByb3cgYW5kIGlzIE5PVFxuLy8gc3RvcmVkIGhlcmUuIGBoaWRkZW5gIGRvdWJsZXMgYXMgdGhlIGFnZW50LWhhbmRvZmYgZmlsdGVyOiBoaWRkZW4gbGF5ZXJzIGRvbid0XG4vLyByZW5kZXIsIHNvIHRoZXkgZG9uJ3QgZmxhdHRlbiwgc28gdGhlIGFnZW50IG5ldmVyIHJlY2VpdmVzIHRoZW0uXG5leHBvcnQgdHlwZSBMYXllciA9IHtcbiAgaWQ6IHN0cmluZztcbiAgbmFtZTogc3RyaW5nOyAvLyBlZGl0YWJsZTsgdGhlIHBhbmVsIGxhYmVsXG4gIGtpbmQ6IFwiYW5ub3RhdGlvblwiIHwgXCJza2V0Y2hcIiB8IFwiaW1hZ2VcIjsgLy8gYXV0by1uYW1lICsgaWNvbjsgXCJza2V0Y2hcIiBhY2NyZXRlcyBwZW4gc3Ryb2tlc1xuICBoaWRkZW4/OiBib29sZWFuO1xuICBsb2NrZWQ/OiBib29sZWFuO1xufTtcblxuLy8g4pSA4pSAIHRoZSB3aG9sZSBzdGF0ZSDilIDilIBcblxuZXhwb3J0IHR5cGUgSW1hZ29TdGF0ZSA9IHtcbiAgdGl0bGU6IHN0cmluZztcbiAgYmF0Y2hlczogQmF0Y2hbXTtcbiAgZm9jdXM6IEZvY3VzIHwgbnVsbDsgLy8gdGhlIGltYWdlIG9uIHRoZSBjYW52YXMgKG51bGwgPSBibGFuayBcIm5ld1wiIGZyYW1lKVxuICBjb252ZXJzYXRpb246IE1lc3NhZ2VbXTtcbiAgbGlicmFyeTogQ29udGV4dEVudHJ5W107IC8vIHRoZSB1bmlmaWVkLCBwYXNzaXZlIGNvbnRleHQgY2F0YWxvZyAoc3R5bGVzICsgcXVpY2stcHJvbXB0czsgc2tpbGwvY29udGV4dCByZXNlcnZlZClcbiAgYWN0aXZlQ29udGV4dElkczogc3RyaW5nW107IC8vIHN0eWxlcyBhdHRhY2hlZCB0byB0aGUgTkVYVCBnZW5lcmF0aW9uICh0aGUgYWN0aXZlLWNvbnRleHQgdHJheSlcbiAgcXVpY2tQcm9tcHRJZHM6IHN0cmluZ1tdOyAvLyBwcm9tcHRzIHN1cmZhY2VkIGluIHRoZSBjb21wb3NlciBxdWljay1wcm9tcHRzIGxpc3QgKGEgY3VyYXRlZCBzdWJzZXQpXG4gIHBpbnM6IFBpbltdO1xuICBtYXJrc0J5VmFyaWFudDogUmVjb3JkPHN0cmluZywgTWFya1tdPjsgLy8gZHVyYWJsZSBhbm5vdGF0aW9uIG1hcmtzIHBlciB2YXJpYW50IGlkXG4gIC8vIENPTlRBSU5FUiBtZXRhZGF0YSBwZXIgdmFyaWFudDogYW4gb3JkZXJlZCBsaXN0IG9mIExheWVycyAoYmFja+KGkmZyb250KSB0aGF0XG4gIC8vIGdyb3VwIHRoZSBtYXJrcyBhYm92ZS4gRWFjaCBNYXJrIGNhcnJpZXMgYSBgbGF5ZXJJZGAgaW50byB0aGlzIGxpc3Q7IGVmZmVjdGl2ZVxuICAvLyB6ID0gbGF5ZXIgb3JkZXIsIHRoZW4gTWFyay56T3JkZXIgd2l0aGluIHRoZSBsYXllci4gU2VlIHR5cGUgTGF5ZXIuXG4gIGxheWVyc0J5VmFyaWFudDogUmVjb3JkPHN0cmluZywgTGF5ZXJbXT47XG4gIGFuYWx5c2lzQ2FjaGU6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47IC8vIGhhc2gg4oaSIGFnZW50IGFuYWx5c2lzOyBzdXJ2aXZlcyBhIHJlZiBkZWxldGUvcmUtYWRkIChkYWVtb24tbWFpbnRhaW5lZClcbiAgYXNwZWN0OiBzdHJpbmc7IC8vIGFzcGVjdCByYXRpbyBmb3IgYSBORVcgKGZyZXNoKSBnZW5lcmF0aW9uXG4gIHNpemU6IEltYWdlU2l6ZTsgLy8gb3V0cHV0IHJlc29sdXRpb24gZm9yIGEgTkVXIGdlbmVyYXRpb25cbiAgc3RhdHVzOiB7IGJ1c3k6IGJvb2xlYW47IHRleHQ6IHN0cmluZyB9O1xuICBjb3N0OiBzdHJpbmc7IC8vIHByZS1mb3JtYXR0ZWQgZm9yIGRpc3BsYXksIGUuZy4gXCIkMC4xOFwiXG4gIGhhbmRvZmY6IHN0cmluZzsgLy8gYWdlbnQgZXNjYWxhdGVkIHRvIGEgdGVybWluYWwgQXNrVXNlclF1ZXN0aW9uIChwcmVzZW5jZTogYXNraW5nKVxuICAvLyB1bmRvL3JlZG8gYXZhaWxhYmlsaXR5IGZvciB0aGUgRk9DVVNFRCB2YXJpYW50J3MgbWFyayBlZGl0cyAoc2VydmVyLWRlcml2ZWRcbiAgLy8gZnJvbSBhbiBpbi1tZW1vcnksIHBlci12YXJpYW50IGhpc3Rvcnk7IHNpdHVhdGlvbmFsLCBub3QgcGVyc2lzdGVkKS4gTGV0cyB0aGVcbiAgLy8gdG9vbGJhciBlbmFibGUvZGlzYWJsZSB0aGUgYnV0dG9ucy5cbiAgaGlzdG9yeTogeyBjYW5VbmRvOiBib29sZWFuOyBjYW5SZWRvOiBib29sZWFuIH07XG4gIC8vIE9ORSBmcmVzaG5lc3Mgc2lnbmFsIHNoYXJlZCBieSBib3RoIGNoYW5uZWxzOiB0cnVlIHdoZW4gdGhlIEZPQ1VTRUQgaW1hZ2UgaGFzXG4gIC8vIGFubm90YXRpb24gY2hhbmdlcyB0aGUgYWdlbnQgaGFzbid0IHJlY2VpdmVkIHlldC4gU2V0IG9uIGFueSBtYXJrIGVkaXQ7XG4gIC8vIGNsZWFyZWQgd2hlbiB0aGUgYWdlbnQgZ2V0cyB0aGUgbWFya2VkIGltYWdlIOKAlCB2aWEgdGhlIGNvbW1pdCBidXR0b24gT1IgYSBjaGF0XG4gIC8vIG1lc3NhZ2UgdGhhdCBjYXJyaWVzIGl0LiBEcml2ZXMgdGhlIGNvbW1pdCBidXR0b24gKFwiVGFrZSBtYXJrc1wiIHZzIFwiU2hhcmVkXCIpXG4gIC8vIGFuZCB0aGUgY2hhdC1zZW5kIGF1dG8tYXR0YWNoLiBTZXJ2ZXItZGVyaXZlZCBmb3IgdGhlIGZvY3VzZWQgdmFyaWFudC5cbiAgbWFya3NVbnNlZW46IGJvb2xlYW47XG59O1xuXG5leHBvcnQgdHlwZSBJbWFnZVNpemUgPSBcIjFLXCIgfCBcIjJLXCI7XG5leHBvcnQgY29uc3QgQVNQRUNUUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXCIxOjFcIiwgXCIzOjJcIiwgXCIyOjNcIiwgXCIxNjo5XCIsIFwiOToxNlwiXSBhcyBjb25zdDtcbmV4cG9ydCBjb25zdCBTSVpFUzogcmVhZG9ubHkgSW1hZ2VTaXplW10gPSBbXCIxS1wiLCBcIjJLXCJdIGFzIGNvbnN0O1xuXG4vLyBQcmVzZW5jZSAoXCJhc2tpbmdcIikgaXMgREVSSVZFRCwgbm90IGEgc3RvcmVkIGZsYWcg4oCUIHNvIGl0IGNhbid0IGRyaWZ0IGZyb20gdGhlXG4vLyB0aHJlYWQ6IHRoZSBhZ2VudCBpcyBcImFza2luZ1wiIHdoZW4gYGhhbmRvZmZgIGlzIHNldCBPUiB0aGUgbGFzdCBtZXNzYWdlIGlzIGFuXG4vLyB1bmFuc3dlcmVkIHF1ZXN0aW9uLiAoSGVscGVyIGxpdmVzIGluIHRoZSBzdXJmYWNlLilcblxuLy8g4pSA4pSAIFNlcnZlciDihpIgYnJvd3NlciAoV2ViU29ja2V0KS4gVGhlIGJyb3dzZXIgaGFuZGxlcyBleGFjdGx5IHRoZXNlLiDilIDilIBcbmV4cG9ydCB0eXBlIFNlcnZlclRvQ2xpZW50ID1cbiAgfCB7IHR5cGU6IFwic3RhdGVcIjsgc3RhdGU6IEltYWdvU3RhdGUgfVxuICB8IHsgdHlwZTogXCJtZXNzYWdlXCI7IHRleHQ6IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcInN1Ym1pdFwiIH1cbiAgfCB7IHR5cGU6IFwiY2FuY2VsXCIgfTtcblxuLy8g4pSA4pSAIEJyb3dzZXIg4oaSIHNlcnZlciAoV2ViU29ja2V0KS4gVGhlIGNsaWVudCBzZW5kcyBleGFjdGx5IHRoZXNlLiDilIDilIBcbi8vIEVhY2ggZWl0aGVyIG11dGF0ZXMgc3RhdGUgKHJlLWJyb2FkY2FzdCkgYW5kL29yIGVtaXRzIGFuIFNTRSBldmVudCB0aGUgYWdlbnRcbi8vIHJlYWN0cyB0by4gVGhlIGNvbnZlcnNhdGlvbiBpcyB0aGUgcHJpbWFyeSBjaGFubmVsOyBnZXN0dXJlcyBhcmUgZmlyc3QtY2xhc3MuXG5leHBvcnQgdHlwZSBDbGllbnRUb1NlcnZlciA9XG4gIHwge1xuICAgICAgdHlwZTogXCJzYXlcIjsgLy8gdXNlciBwb3N0cyBhIG1lc3NhZ2UgLyBpbnN0cnVjdGlvblxuICAgICAgdGV4dDogc3RyaW5nO1xuICAgICAgLy8gd2hlbiB0aGUgZm9jdXNlZCBpbWFnZSBoYXMgdW5zZWVuIG1hcmtzLCB0aGUgc3VyZmFjZSBmbGF0dGVucyBpdCBhbmRcbiAgICAgIC8vIHJpZGVzIHRoZSBtYXJrZWQgaW1hZ2UgYWxvbmcgd2l0aCB0aGUgbWVzc2FnZSAob25lIGZyZXNobmVzcyBzaWduYWwpLlxuICAgICAgZmxhdHRlbmVkU3JjPzogc3RyaW5nO1xuICAgIH1cbiAgfCB7IHR5cGU6IFwicHJvcG9zYWwuc2VuZFwiOyBpZDogc3RyaW5nIH0gLy8gY29uZmlybSBhIHByb21wdCBwcm9wb3NhbCDihpIgZ2VuZXJhdGVcbiAgfCB7IHR5cGU6IFwicHJvcG9zYWwuZGlzbWlzc1wiOyBpZDogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwiZm9jdXMuc2V0XCI7IGJhdGNoSWQ6IHN0cmluZzsgdmFyaWFudElkOiBzdHJpbmcgfSAvLyBmb2N1cyBhbiBpbWFnZVxuICB8IHsgdHlwZTogXCJmb2N1cy5jbGVhclwiIH0gLy8gYmFjayB0byBhIGJsYW5rIFwibmV3XCIgZnJhbWVcbiAgfCB7IHR5cGU6IFwidmFyaWFudC5saWtlXCI7IGlkOiBzdHJpbmc7IGxpa2VkOiBib29sZWFuIH1cbiAgfCB7IHR5cGU6IFwidmFyaWFudC5yZW1vdmVcIjsgYmF0Y2hJZDogc3RyaW5nOyB2YXJpYW50SWQ6IHN0cmluZyB9IC8vIGRlbGV0ZSBhIHZhcmlhbnQgZnJvbSB0aGUgbGlicmFyeSAoKyBpdHMgbWFya3MvbGF5ZXJzOyBkcm9wcyB0aGUgYmF0Y2ggd2hlbiBlbXB0eSk7IGFtYmllbnQgKG5vIGFnZW50IGV2ZW50KVxuICB8IHtcbiAgICAgIHR5cGU6IFwiY29udGV4dC5hZGRcIjtcbiAgICAgIGtpbmQ6IENvbnRleHRLaW5kO1xuICAgICAgbmFtZTogc3RyaW5nO1xuICAgICAgY29udGVudDogc3RyaW5nO1xuICAgICAgdGFncz86IHN0cmluZ1tdO1xuICAgICAgaW1hZ2U/OiBzdHJpbmc7XG4gICAgICBsaW5rPzogQ29udGV4dFNldDtcbiAgICB9XG4gIHwgeyB0eXBlOiBcImNvbnRleHQudXBkYXRlXCI7IGlkOiBzdHJpbmc7IG5hbWU/OiBzdHJpbmc7IGNvbnRlbnQ/OiBzdHJpbmc7IHRhZ3M/OiBzdHJpbmdbXSB9XG4gIHwgeyB0eXBlOiBcImNvbnRleHQuZGVsZXRlXCI7IGlkOiBzdHJpbmcgfSAvLyB0aGUgT05MWSBkZXN0cm95IChndWFyZGVkIGJ5IGEgVUkgY29uZmlybSlcbiAgfCB7IHR5cGU6IFwiY29udGV4dC5saW5rXCI7IGlkOiBzdHJpbmc7IHNldDogQ29udGV4dFNldCB9IC8vIGFkZCB0byBhIGxpbmtlZCBzZXRcbiAgfCB7IHR5cGU6IFwiY29udGV4dC51bmxpbmtcIjsgaWQ6IHN0cmluZzsgc2V0OiBDb250ZXh0U2V0IH0gLy8gcmVtb3ZlIGZyb20gYSBsaW5rZWQgc2V0ICh0aGUgZXZlcnlkYXkg4pyVKVxuICB8IHsgdHlwZTogXCJjb250ZXh0LmNhcHR1cmVcIiB9IC8vIGNhcHR1cmUgYSBzdHlsZSBmcm9tIHRoZSBmb2N1c2VkIGltYWdlXG4gIHwgeyB0eXBlOiBcInBpbi5hZGRcIjsga2V5OiBzdHJpbmc7IHZhbHVlOiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJwaW4ucmVtb3ZlXCI7IGtleTogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwicmVmLmFkZFwiOyBpbWFnZTogeyBzcmM6IHN0cmluZzsgbmFtZT86IHN0cmluZyB9IH0gLy8gaW1wb3J0IGFuIGV4dGVybmFsIGltYWdlIGFzIGEgdmFyaWFudCArIHNlbGVjdCBpdCBhcyBhIHJlZiAoZGVkdXAgYnkgaGFzaCDihpIgc2VsZWN0cyB0aGUgZXhpc3Rpbmcgb25lKVxuICB8IHsgdHlwZTogXCJyZWYucmVtb3ZlXCI7IGlkOiBzdHJpbmcgfSAvLyBERVNFTEVDVCBhIHZhcmlhbnQgYXMgYSByZWYgKGl0IHN0YXlzIGluIHRoZSBsaWJyYXJ5OyB0byBkZWxldGUgdGhlIGltYWdlIHVzZSB2YXJpYW50LnJlbW92ZSlcbiAgfCB7IHR5cGU6IFwiaW1hZ2UuaW1wb3J0XCI7IGltYWdlOiB7IHNyYzogc3RyaW5nOyBuYW1lPzogc3RyaW5nIH0gfSAvLyBkcm9wIG9uIGNhbnZhcyDihpIgd29ya2luZyBpbWFnZVxuICB8IHtcbiAgICAgIC8vIGRyb3AgYW4gaW1hZ2UgYXMgYSBMQVlFUiBvbnRvIHRoZSBmb2N1c2VkIGltYWdlIChjb2xsYWdlKSDigJQgZGlzdGluY3QgZnJvbVxuICAgICAgLy8gaW1hZ2UuaW1wb3J0LCB3aGljaCBSRVBMQUNFUy4gVGhlIGNsaWVudCBzdXBwbGllcyB0aGUgZnJhY3Rpb24tc3BhY2UgYm94XG4gICAgICAvLyAoaXQga25vd3MgdGhlIGJhc2UgaW1hZ2UgYm94ICsgdGhlIGRyb3BwZWQgYml0bWFwJ3MgYXNwZWN0KTsgdGhlIHNlcnZlclxuICAgICAgLy8gb3B0aW1pemVzIHRoZSBzcmMgKyBzdG9yZXMgaXQuIEdlb21ldHJ5IG9wdGlvbmFsIOKGkiBzZXJ2ZXIgY2VudGVycyBhIDQwJSBib3guXG4gICAgICB0eXBlOiBcImxheWVyLmFkZEltYWdlXCI7XG4gICAgICBzcmM6IHN0cmluZztcbiAgICAgIG5hbWU/OiBzdHJpbmc7XG4gICAgICB4PzogbnVtYmVyO1xuICAgICAgeT86IG51bWJlcjtcbiAgICAgIHc/OiBudW1iZXI7XG4gICAgICBoPzogbnVtYmVyO1xuICAgIH1cbiAgLy8g4pSA4pSAIGxheWVyIChjb250YWluZXIpIG9wcyDigJQgUGhhc2UgMiBpbnNwZWN0b3IgcGFuZWwuIEFsbCBzZXJ2ZXItYXV0aG9yaXRhdGl2ZVxuICAvLyBhbmQgdW5kb2FibGUgdmlhIHRoZSB3aWRlbmVkIHttYXJrcyxsYXllcnN9IGhpc3Rvcnk7IGxvY2FsIHVudGlsIGNvbW1pdCAodGhlXG4gIC8vIGZsYXR0ZW4gcmVzcGVjdHMgYGhpZGRlbmApLCBzbyBubyBhZ2VudCBldmVudCDigJQgc2FtZSBydWxlIGFzIG1hcmsuKiBvcHMuXG4gIHwgeyB0eXBlOiBcImxheWVyLmFkZFwiOyBuYW1lPzogc3RyaW5nOyBraW5kPzogTGF5ZXJbXCJraW5kXCJdIH0gLy8gYmxhbmsgbGF5ZXIgb24gdG9wXG4gIHwgeyB0eXBlOiBcImxheWVyLnJlbmFtZVwiOyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJsYXllci5zZXRIaWRkZW5cIjsgaWQ6IHN0cmluZzsgaGlkZGVuOiBib29sZWFuIH0gLy8gdmlzaWJpbGl0eSArIGhhbmRvZmYgZmlsdGVyXG4gIHwgeyB0eXBlOiBcImxheWVyLnNldExvY2tlZFwiOyBpZDogc3RyaW5nOyBsb2NrZWQ6IGJvb2xlYW4gfSAvLyBub3QgaGl0LXRlc3RhYmxlIC8gc2VsZWN0YWJsZVxuICB8IHsgdHlwZTogXCJsYXllci5yZW9yZGVyXCI7IGlkOiBzdHJpbmc7IHRvSW5kZXg6IG51bWJlciB9IC8vIGFic29sdXRlIHBsYWNlbWVudCAoZHJhZy1kcm9wKVxuICB8IHsgdHlwZTogXCJsYXllci5yZW1vdmVcIjsgaWQ6IHN0cmluZyB9IC8vIGRlbGV0ZXMgdGhlIGxheWVyIEFORCBpdHMgZWxlbWVudHNcbiAgfCB7IHR5cGU6IFwiZ3JvdXBcIjsgbWFya0lkczogc3RyaW5nW107IG5hbWU/OiBzdHJpbmcgfSAvLyB3cmFwIHNlbGVjdGVkIG1hcmtzIGluIGEgbmV3IGxheWVyXG4gIHwgeyB0eXBlOiBcInVuZ3JvdXBcIjsgaWQ6IHN0cmluZyB9IC8vIGRpc3NvbHZlIOKGkiBlYWNoIGVsZW1lbnQgYmVjb21lcyBpdHMgb3duIGdyb3VwLW9mLW9uZSBsYXllclxuICAvLyBOT1RFOiB0aGVyZSBpcyBubyBgbGF5ZXIuc2V0QWN0aXZlYCDigJQgdGhlIGFjdGl2ZSBsYXllciAod2hlcmUgbmV3IG1hcmtzIGRyb3ApXG4gIC8vIGlzIHN1cmZhY2Utb3duZWQuIFRoZSBjbGllbnQgc3RhbXBzIGBtYXJrLmxheWVySWRgIG9uIG1hcmsuYWRkOyB0aGUgc2VydmVyXG4gIC8vIGhvbm9ycyBhIHZhbGlkIG9uZSwgZWxzZSBkcm9wcyBpbnRvIHRoZSB0b3Btb3N0IG5vbi1pbWFnZSBsYXllci5cbiAgfCB7IHR5cGU6IFwicmVmLnNlbGVjdFwiOyBpZDogc3RyaW5nOyBzZWxlY3RlZDogYm9vbGVhbiB9IC8vIHBvaW50IGEgVkFSSUFOVCBhdCB0aGUgbmV4dCBnZW4gKGlkID0gdmFyaWFudElkOyB0b2dnbGVzIHJlZlNlbGVjdGVkKVxuICB8IHsgdHlwZTogXCJtYXJrLmFkZFwiOyBtYXJrOiBNYXJrIH0gLy8gbG9jYWwtaXNoOyBubyBhZ2VudCBldmVudCB1bnRpbCBjb21taXQgKHNlcnZlciBhc3NpZ25zIHpPcmRlcjsgaG9ub3JzIGEgdmFsaWQgbWFyay5sYXllcklkIGFzIHRoZSBhY3RpdmUgbGF5ZXIsIGVsc2UgdG9wbW9zdCBub24taW1hZ2UgbGF5ZXIpXG4gIHwgeyB0eXBlOiBcIm1hcmsucmVtb3ZlXCI7IGlkOiBzdHJpbmcgfSAvLyBkZWxldGUgb25lIG1hcmsgKGNvbXBsZW1lbnRzIG1hcmtzLmNsZWFyKVxuICB8IHtcbiAgICAgIC8vIG1vdmUvcmVzaXplL2xhYmVsIChzZXJ2ZXIgbWVyZ2VzOyBuZXZlciBpZC90b29sL3pPcmRlcikuIFZhbHVlcyBhcmVcbiAgICAgIC8vIHNjYWxhcnMgKGdlb21ldHJ5L2xhYmVsL3N0eWxlKSBvciBhIGRyYXcgbWFyaydzIHdob2xlIGBwb2ludHNgIGFycmF5LlxuICAgICAgdHlwZTogXCJtYXJrLnVwZGF0ZVwiO1xuICAgICAgaWQ6IHN0cmluZztcbiAgICAgIHBhdGNoOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXIgfCBzdHJpbmcgfCB7IHg6IG51bWJlcjsgeTogbnVtYmVyIH1bXT47XG4gICAgfVxuICB8IHtcbiAgICAgIHR5cGU6IFwibWFyay5yZW9yZGVyXCI7XG4gICAgICBpZDogc3RyaW5nO1xuICAgICAgZGlyZWN0aW9uOiBcImZvcndhcmRcIiB8IFwiYmFja1wiIHwgXCJmcm9udFwiIHwgXCJiYWNrLW1vc3RcIjtcbiAgICB9IC8vIHotb3JkZXJcbiAgfCB7IHR5cGU6IFwibWFya3MuY2xlYXJcIiB9XG4gIHwgeyB0eXBlOiBcIm1hcmtzLnJlcGxhY2VcIjsgbWFya3M6IE1hcmtbXSB9IC8vIHN3YXAgdGhlIGZvY3VzZWQgaW1hZ2UncyBtYXJrcyB3aG9sZXNhbGUgKG9uZSBoaXN0b3J5IHN0ZXApIOKAlCB1c2VkIGJ5IHRoZSBwZW4gZXJhc2VyLCB3aGljaCB0cmltcy9zcGxpdHMgc3Ryb2tlc1xuICB8IHsgdHlwZTogXCJ1bmRvXCIgfSAvLyBzdGVwIHRoZSBmb2N1c2VkIGltYWdlJ3MgbWFyayBoaXN0b3J5IGJhY2tcbiAgfCB7IHR5cGU6IFwicmVkb1wiIH0gLy8gc3RlcCBpdCBmb3J3YXJkXG4gIHwge1xuICAgICAgdHlwZTogXCJtYXJrcy5jb21taXRcIjsgLy8gXCJ0YWtlIG1hcmtzIHRvIHRoZSBjb252ZXJzYXRpb24g4oaSXCJcbiAgICAgIHRleHQ6IHN0cmluZztcbiAgICAgIGJhdGNoSWQ6IHN0cmluZztcbiAgICAgIHZhcmlhbnRJZDogc3RyaW5nO1xuICAgICAgZmxhdHRlbmVkU3JjPzogc3RyaW5nOyAvLyBkYXRhLXVybCBQTkc6IHRoZSBpbWFnZSB3aXRoIG1hcmtzIGJ1cm5lZCBpbiAodGhlIHZpc3VhbCBoYW5kb2ZmKS4gT3B0aW9uYWwg4oCUIGNhcHR1cmUgaXMgYmVzdC1lZmZvcnQuXG4gICAgfVxuICB8IHsgdHlwZTogXCJhc3BlY3Quc2V0XCI7IGFzcGVjdDogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwic2l6ZS5zZXRcIjsgc2l6ZTogSW1hZ2VTaXplIH1cbiAgfCB7IHR5cGU6IFwic3VibWl0XCIgfVxuICB8IHsgdHlwZTogXCJjYW5jZWxcIiB9O1xuXG4vLyDilIDilIAgQWdlbnQg4oaSIHNlcnZlciAoUE9TVCAvY21kKS4gVGhlIGFnZW50IGRyaXZlcyB0aGUgZGFlbW9uIHdpdGggZXhhY3RseSB0aGVzZS4g4pSA4pSAXG5leHBvcnQgdHlwZSBBZ2VudENvbW1hbmQgPVxuICB8IHsgdHlwZTogXCJpbml0XCI7IHRpdGxlPzogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwic2F5XCI7IHRleHQ6IHN0cmluZyB9IC8vIHBvc3QgYWdlbnQgZGlhbG9ndWUgKGtpbmQ6XCJ0ZXh0XCIpXG4gIHwgeyB0eXBlOiBcInByb3Bvc2VcIjsgcHJvbXB0OiBzdHJpbmc7IG4/OiBudW1iZXIgfSAvLyBwb3N0IGEgcHJvbXB0IHByb3Bvc2FsXG4gIHwgeyB0eXBlOiBcImFza1wiOyB0ZXh0OiBzdHJpbmc7IG9wdGlvbnM/OiBzdHJpbmdbXSB9IC8vIHBvc3QgYW4gaW4tdGhyZWFkIHF1ZXN0aW9uXG4gIHwge1xuICAgICAgLy8gYWRkIGEgcHJvZHVjZWQgYmF0Y2ggKyAoYXV0bykgYSBcInJlc3VsdFwiIG1lc3NhZ2UgYW5ub3VuY2luZyBpdFxuICAgICAgdHlwZTogXCJiYXRjaC5hZGRcIjtcbiAgICAgIGtpbmQ6IFwiZ2VuZXJhdGVcIiB8IFwiZWRpdFwiO1xuICAgICAgcHJvbXB0OiBzdHJpbmc7XG4gICAgICB0YWc/OiBzdHJpbmc7XG4gICAgICBlZGl0ZWRGcm9tVmFyaWFudElkPzogc3RyaW5nO1xuICAgICAgc3VtbWFyeT86IHN0cmluZzsgLy8gdGhlIHJlc3VsdCBtZXNzYWdlIHRleHRcbiAgICAgIHZhcmlhbnRzOiB7IHNyYzogc3RyaW5nOyBzZWVkPzogbnVtYmVyOyBtb2RlbD86IHN0cmluZzsgaWQ/OiBzdHJpbmcgfVtdO1xuICAgIH1cbiAgfCB7IHR5cGU6IFwiZm9jdXNcIjsgYmF0Y2hJZDogc3RyaW5nOyB2YXJpYW50SWQ6IHN0cmluZyB9IC8vIGFnZW50IGZvY3VzZXMgYW4gaW1hZ2VcbiAgfCB7IHR5cGU6IFwicmVmLnNlbGVjdFwiOyBpZDogc3RyaW5nOyBzZWxlY3RlZDogYm9vbGVhbiB9IC8vIGFnZW50IHBvaW50cyBhIHZhcmlhbnQgYXQgdGhlIG5leHQgZ2VuIChpZCA9IHZhcmlhbnRJZDsgdGhlIHVzZXIgc2VlcyBpdCBoaWdobGlnaHQpXG4gIC8vIChyZWYuYW5hbHl6ZSByZW1vdmVkIOKAlCB3cml0ZSBhIHJlYWQgb250byBhbnkgaW1hZ2UgdmlhIHZhcmlhbnQuYW5hbHl6ZTsgcmVmcyBhcmUgdmFyaWFudHMgbm93KVxuICB8IHsgdHlwZTogXCJ2YXJpYW50LmFuYWx5emVcIjsgaWQ6IHN0cmluZzsgdGV4dDogc3RyaW5nIH0gLy8gd3JpdGUgeW91ciByZWFkIG9udG8gYSBnZW5lcmF0ZWQvaW1wb3J0ZWQgaW1hZ2VcbiAgfCB7XG4gICAgICB0eXBlOiBcImNvbnRleHQuYWRkXCI7XG4gICAgICBraW5kOiBDb250ZXh0S2luZDtcbiAgICAgIG5hbWU6IHN0cmluZztcbiAgICAgIGNvbnRlbnQ6IHN0cmluZztcbiAgICAgIHRhZ3M/OiBzdHJpbmdbXTtcbiAgICAgIGltYWdlPzogc3RyaW5nO1xuICAgICAgbGluaz86IENvbnRleHRTZXQ7XG4gICAgfVxuICB8IHsgdHlwZTogXCJzdGF0dXNcIjsgYnVzeTogYm9vbGVhbjsgdGV4dD86IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcImNvc3RcIjsgdGV4dDogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwiaGFuZG9mZlwiOyB0ZXh0OiBzdHJpbmcgfSAvLyBcIlwiIGNsZWFycyAodGVybWluYWwtYXNrIGVzY2FwZSlcbiAgfCB7IHR5cGU6IFwiY2xvc2VcIiB9O1xuXG4vLyBUaGUgYWdlbnQgZXZlbnQgc2V0IChzZXJ2ZXIg4oaSIGFnZW50IFNTRSkg4oCUIElNUEVSQVRJVkVTIE9OTFk6IHRoZSBtb3ZlcyB3aGVyZVxuLy8gdGhlIHVzZXIgaXMgYXNraW5nIHRoZSBhZ2VudCBmb3Igc29tZXRoaW5nIG9yIGhhbmRpbmcgd29yayBvZmYsIHBsdXMgbGlmZWN5Y2xlLlxuLy8gVGhlIGFnZW50IHJlYWN0cyB0byB0aGVzZS5cbi8vXG4vLyBBTUJJRU5UIEJPQVJEIFNUQVRFIGlzIGRlbGliZXJhdGVseSBOT1QgaGVyZSDigJQgZm9jdXMsIHJlZiBzZWxlY3Rpb24sIGxpa2VzLFxuLy8gc3R5bGUgdG9nZ2xlcywgYXNwZWN0L3NpemUsIHBpbnMsIHJlZi1saWJyYXJ5IGFkZHMsIGltYWdlIGltcG9ydHMuIFRob3NlIGFyZVxuLy8gcGllY2VzIG1vdmluZyBvbiB0aGUgYm9hcmQ7IHRoZSBhZ2VudCBSRUFEUyB0aGVtIGZyb20gL3N0YXRlIHdoZW4gaXQncyBpdHMgbW92ZSxcbi8vIGl0IGRvZXMgbm90IGdldCBwaW5nZWQgb24gZXZlcnkgdG9nZ2xlICh0aGF0IHdhcyBqdXN0IG5vaXNlKS4gVG8gbWFrZSB0aGF0IHNhZmUsXG4vLyB0aGUgaW1wZXJhdGl2ZXMgdGhhdCBhcmUgXCJhYm91dCBhbiBpbWFnZVwiIGNhcnJ5IHRoZWlyIGJvYXJkIGNvbnRleHQ6IGBzYXlgIGFuZFxuLy8gYG1hcmtzLmNvbW1pdGAgcmlkZSB0aGUgZm9jdXNlZCB2YXJpYW50ICsgc2VsZWN0ZWQgcmVmIGlkczsgYGNvbnRleHQuY2FwdHVyZWBcbi8vIHJpZGVzIHRoZSBmb2N1cy4gSW5jcmVtZW50YWwgYW5ub3RhdGlvbiAobWFyay5hZGQvbWFya3MuY2xlYXIpIGlzIGxpa2V3aXNlIE5PVFxuLy8gaGVyZSDigJQgdGhlIGFnZW50IHJlYWN0cyB3aGVuIHRoZSB1c2VyIENPTU1JVFMgbWFya3MsIG5vdCBvbiBldmVyeSBzdHJva2UuXG5leHBvcnQgY29uc3QgQUdFTlRfRVZFTlRfVFlQRVMgPSBPYmplY3QuZnJlZXplKFtcbiAgXCJyZWFkeVwiLFxuICBcImNvbm5lY3RlZFwiLFxuICBcImRpc2Nvbm5lY3RlZFwiLFxuICBcInNheVwiLFxuICBcInByb3Bvc2FsLnNlbmRcIixcbiAgXCJwcm9wb3NhbC5kaXNtaXNzXCIsXG4gIFwiY29udGV4dC5jYXB0dXJlXCIsXG4gIFwibWFya3MuY29tbWl0XCIsXG4gIFwic3VibWl0XCIsXG4gIFwiY2xvc2VkXCIsXG5dIGFzIGNvbnN0KTtcbmV4cG9ydCB0eXBlIEFnZW50RXZlbnRUeXBlID0gKHR5cGVvZiBBR0VOVF9FVkVOVF9UWVBFUylbbnVtYmVyXTtcblxuLy8gVHlwZWQgcGF5bG9hZHMgZm9yIHRoZSBldmVudHMgdGhhdCBjYXJyeSBkYXRhIOKAlCBzbyB0aGUgYWdlbnQgaXNuJ3QgZ3Vlc3Npbmdcbi8vIHNoYXBlcyBhbmQgdGhlIHNlcnZlcidzIGVtaXQgY2FsbHMgYXJlIGNoZWNrZWQuIEV2ZW50cyBub3QgbGlzdGVkIGNhcnJ5IG5vXG4vLyBwYXlsb2FkLlxuZXhwb3J0IHR5cGUgQWdlbnRFdmVudFBheWxvYWQgPSB7XG4gIC8vIGEgY2hhdCBtZXNzYWdlLiBJdCBjYXJyaWVzIHRoZSBBTUJJRU5UIEJPQVJEIENPTlRFWFQgc28gdGhlIGFnZW50IGRvZXNuJ3QgbmVlZFxuICAvLyB0aGUgKG5vdy1yZW1vdmVkKSBmb2N1cy5zZXQvcmVmLnNlbGVjdCBwaW5nczogYGZvY3VzYCBpcyB0aGUgaW1hZ2Ugb24gdGhlXG4gIC8vIGNhbnZhcyB3aGVuIHRoZSB1c2VyIHNlbnQgKG51bGwgPSBibGFuayBmcmFtZSksIGBzZWxlY3RlZFJlZklkc2AgdGhlIHJlZnMgdGhlXG4gIC8vIHVzZXIgcG9pbnRlZCBhdCBmb3IgdGhpcyB0dXJuLiBJZiB0aGUgZm9jdXNlZCBpbWFnZSBoYWQgdW5zZWVuIG1hcmtzLCB0aGVcbiAgLy8gbWFya2VkIGltYWdlIChmbGF0dGVuZWRJbWFnZVBhdGgsIC0tcmVmIGl0KSArIHRoZSBtYXJrIGdlb21ldHJ5IHJpZGUgYWxvbmcgdG9vLlxuICBzYXk6IHtcbiAgICB0ZXh0OiBzdHJpbmc7XG4gICAgZm9jdXM6IEZvY3VzIHwgbnVsbDtcbiAgICBzZWxlY3RlZFJlZklkczogc3RyaW5nW107XG4gICAgZmxhdHRlbmVkSW1hZ2VQYXRoPzogc3RyaW5nO1xuICAgIG1hcmtzPzogTWFya1tdO1xuICB9O1xuICBcInByb3Bvc2FsLnNlbmRcIjogeyBpZDogc3RyaW5nIH07XG4gIFwicHJvcG9zYWwuZGlzbWlzc1wiOiB7IGlkOiBzdHJpbmcgfTtcbiAgLy8gXCJleHRyYWN0IHRoaXMgaW1hZ2UncyBsb29rXCIg4oCUIGNhcnJpZXMgdGhlIGZvY3VzZWQgdmFyaWFudCBzbyB0aGUgYWdlbnQga25vd3NcbiAgLy8gd2hpY2ggaW1hZ2UgdG8gcmVhZCAoZm9jdXMuc2V0IG5vIGxvbmdlciBub3RpZmllcykuXG4gIFwiY29udGV4dC5jYXB0dXJlXCI6IHsgZm9jdXM6IEZvY3VzIHwgbnVsbCB9O1xuICBcIm1hcmtzLmNvbW1pdFwiOiB7XG4gICAgdGV4dDogc3RyaW5nO1xuICAgIGJhdGNoSWQ6IHN0cmluZztcbiAgICB2YXJpYW50SWQ6IHN0cmluZztcbiAgICBtYXJrczogTWFya1tdO1xuICAgIHNlbGVjdGVkUmVmSWRzOiBzdHJpbmdbXTsgLy8gcmVmcyB0aGUgdXNlciBwb2ludGVkIGF0IChhbWJpZW50IGJvYXJkIGNvbnRleHQpXG4gICAgLy8gb24tZGlzayBQTkcgcGF0aCBvZiB0aGUgaW1hZ2Ugd2l0aCBtYXJrcyBidXJuZWQgaW4gKHRoZSB2aXN1YWwgaGFuZG9mZiDigJRcbiAgICAvLyBwYXNzIGFzIC0tcmVmKS4gQWJzZW50IGlmIGNhcHR1cmUgZmFpbGVkOyBmYWxsIGJhY2sgdG8gdGhlIHZhcmlhbnQgcGF0aC5cbiAgICBmbGF0dGVuZWRJbWFnZVBhdGg/OiBzdHJpbmc7XG4gIH07XG59O1xuXG5jb25zdCBERUZBVUxUX1NUWUxFX05BTUVTID0gW1wiYW5pbWVcIiwgXCJwYWludGVybHlcIiwgXCJwaG90b3JlYWxcIiwgXCIzZFwiLCBcIndhdGVyY29sb3JcIiwgXCJsaW5lIGFydFwiXTtcbi8vIGRldGVybWluaXN0aWMsIHJlcHJvZHVjaWJsZSBpZCBzbyBzZWVkaW5nL3Jlc3RvcmUgZG9uJ3QgY2h1cm4gaWRzXG5leHBvcnQgY29uc3Qgc3R5bGVJZCA9IChuYW1lOiBzdHJpbmcpID0+IGBzdHlsZS0ke25hbWUudHJpbSgpLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvXFxzKy9nLCBcIi1cIil9YDtcblxuY29uc3QgREVGQVVMVF9QUk9NUFRTOiBDb250ZXh0RW50cnlbXSA9IFtcbiAge1xuICAgIGlkOiBcImRlc2NyaWJlXCIsXG4gICAga2luZDogXCJwcm9tcHRcIixcbiAgICBuYW1lOiBcImRlc2NyaWJlXCIsXG4gICAgY29udGVudDogXCJEZXNjcmliZSB0aGlzIGltYWdlIGluIGRldGFpbCDigJQgbGl0ZXJhbGx5IHdoYXQgaXMgaW4gaXQuXCIsXG4gIH0sXG4gIHtcbiAgICBpZDogXCJwYWxldHRlXCIsXG4gICAga2luZDogXCJwcm9tcHRcIixcbiAgICBuYW1lOiBcInBhbGV0dGVcIixcbiAgICBjb250ZW50OiBcIkJyZWFrIGRvd24gdGhlIGNvbG9yIHBhbGV0dGUg4oCUIHRoZSBrZXkgY29sb3JzIGFuZCBob3cgdGhleSB3b3JrIHRvZ2V0aGVyLlwiLFxuICB9LFxuICB7XG4gICAgaWQ6IFwibGlnaHRpbmdcIixcbiAgICBraW5kOiBcInByb21wdFwiLFxuICAgIG5hbWU6IFwibGlnaHRpbmdcIixcbiAgICBjb250ZW50OiBcIkRlc2NyaWJlIHRoZSBsaWdodGluZyDigJQgZGlyZWN0aW9uLCBxdWFsaXR5LCBtb29kIOKAlCBzbyBJIGNhbiByZXVzZSBpdC5cIixcbiAgfSxcbl07XG5cbmV4cG9ydCBmdW5jdGlvbiBkZWZhdWx0U3RhdGUodGl0bGU6IHN0cmluZyk6IEltYWdvU3RhdGUge1xuICByZXR1cm4ge1xuICAgIHRpdGxlLFxuICAgIGJhdGNoZXM6IFtdLFxuICAgIGZvY3VzOiBudWxsLFxuICAgIGNvbnZlcnNhdGlvbjogW10sXG4gICAgbGlicmFyeTogW1xuICAgICAgLi4uREVGQVVMVF9QUk9NUFRTLm1hcCgocCkgPT4gKHsgLi4ucCB9KSksXG4gICAgICAuLi5ERUZBVUxUX1NUWUxFX05BTUVTLm1hcCgobmFtZSkgPT4gKHtcbiAgICAgICAgaWQ6IHN0eWxlSWQobmFtZSksXG4gICAgICAgIGtpbmQ6IFwic3R5bGVcIiBhcyBjb25zdCxcbiAgICAgICAgbmFtZSxcbiAgICAgICAgY29udGVudDogXCJcIixcbiAgICAgIH0pKSxcbiAgICBdLFxuICAgIGFjdGl2ZUNvbnRleHRJZHM6IFtdLFxuICAgIHF1aWNrUHJvbXB0SWRzOiBERUZBVUxUX1BST01QVFMubWFwKChwKSA9PiBwLmlkKSxcbiAgICBwaW5zOiBbXSxcbiAgICBtYXJrc0J5VmFyaWFudDoge30sXG4gICAgbGF5ZXJzQnlWYXJpYW50OiB7fSxcbiAgICBhbmFseXNpc0NhY2hlOiB7fSxcbiAgICBhc3BlY3Q6IFwiMToxXCIsXG4gICAgc2l6ZTogXCIxS1wiLFxuICAgIHN0YXR1czogeyBidXN5OiBmYWxzZSwgdGV4dDogXCJcIiB9LFxuICAgIGNvc3Q6IFwiXCIsXG4gICAgaGFuZG9mZjogXCJcIixcbiAgICBoaXN0b3J5OiB7IGNhblVuZG86IGZhbHNlLCBjYW5SZWRvOiBmYWxzZSB9LFxuICAgIG1hcmtzVW5zZWVuOiBmYWxzZSxcbiAgfTtcbn1cbiIsCiAgICAiLy8gc2hhcmVkL2ltYWdlT3B0aW1pemUudHNcbi8vIEJyb3dzZXItc2FmZSBpbWFnZS1vcHRpbWl6YXRpb24gUE9MSUNZLCB1c2VkIGJ5IEJPVEggc2lkZXMg4oCUIHRoZSBicm93c2VyIGRyb3Bcbi8vIHBhdGggKHN1cmZhY2Uvc3RhdGUvZmlsZUludGFrZS50cykgYW5kIHRoZSBkYWVtb24gdmFyaWFudCBwYXRoXG4vLyAoc2NyaXB0cy9pbWFnZU9wdGltaXplLnNlcnZlci50cykuIFR3by1zaWRlZCBieSBSMSdzIHRlc3QsIHNvIGl0IGxpdmVzIGluXG4vLyBzaGFyZWQvIHJhdGhlciB0aGFuIHdpdGggZWl0aGVyIGNvbnN1bWVyLiBObyBuYXRpdmUgZGVwcyBoZXJlIOKAlCBzYWZlIHRvXG4vLyBpbXBvcnQgaW50byB0aGUgUmVhY3QgYnVuZGxlLiBUaGUgQnVuLkltYWdlIGltcGxlbWVudGF0aW9uIHRoYXQgYXBwbGllcyB0aGlzXG4vLyBwb2xpY3kgbGl2ZXMgaW4gc2NyaXB0cy9pbWFnZU9wdGltaXplLnNlcnZlci50cy5cbmV4cG9ydCBjb25zdCBPUFRJTUlaRSA9IHsgbWF4RGltOiAxMjAwLCBxdWFsaXR5OiAwLjg1IH0gYXMgY29uc3Q7XG4iLAogICAgIi8vIHNjcmlwdHMvaW1hZ2VPcHRpbWl6ZS5zZXJ2ZXIudHNcbi8vIERhZW1vbi1vbmx5OiBuYXRpdmUgQnVuLkltYWdlIGRvd25zY2FsZSt3ZWJwLiBJdCBsaXZlcyBpbiBzY3JpcHRzLyBiZWNhdXNlXG4vLyBvbmx5IHRoZSBkYWVtb24gZXhlY3V0ZXMgaXQgKFIxJ3MgdGhyZWUtd2F5IHNvcnQg4oCUIHRoZSBgLnNlcnZlci50c2Agc3VmZml4XG4vLyBhbHJlYWR5IHNhaWQgc28pOyB0aGUgUE9MSUNZIGl0IGFwcGxpZXMgaXMgdHdvLXNpZGVkIGFuZCBsaXZlcyBpbiBzaGFyZWQvLlxuLy8gRG8gTk9UIGltcG9ydCB0aGlzIGZyb20gYnJvd3NlciBjb2RlIChCdW4uSW1hZ2UgaXMgYSBCdW4gcnVudGltZSBidWlsdC1pbixcbi8vIGFic2VudCBpbiB0aGUgYnJvd3NlcikuIEJyb3dzZXIgY29kZSBpbXBvcnRzIE9QVElNSVpFIGZyb20gc2hhcmVkL2ltYWdlT3B0aW1pemUuXG5pbXBvcnQgeyBPUFRJTUlaRSB9IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvaW1hZ28vc2hhcmVkL2ltYWdlT3B0aW1pemVcIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG9wdGltaXplSW1hZ2VCdWZmZXIoXG4gIGlucHV0OiBVaW50OEFycmF5LFxuKTogUHJvbWlzZTx7IGRhdGE6IFVpbnQ4QXJyYXk7IG1pbWU6IFwiaW1hZ2Uvd2VicFwiIH0+IHtcbiAgY29uc3QgZGF0YSA9IGF3YWl0IG5ldyBCdW4uSW1hZ2UoaW5wdXQpXG4gICAgLnJlc2l6ZShPUFRJTUlaRS5tYXhEaW0sIE9QVElNSVpFLm1heERpbSwge1xuICAgICAgZml0OiBcImluc2lkZVwiLFxuICAgICAgd2l0aG91dEVubGFyZ2VtZW50OiB0cnVlLFxuICAgIH0pXG4gICAgLndlYnAoeyBxdWFsaXR5OiBNYXRoLnJvdW5kKE9QVElNSVpFLnF1YWxpdHkgKiAxMDApIH0pXG4gICAgLmJ5dGVzKCk7XG4gIHJldHVybiB7IGRhdGE6IG5ldyBVaW50OEFycmF5KGRhdGEpLCBtaW1lOiBcImltYWdlL3dlYnBcIiB9O1xufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7Ozs7QUE0QkE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBU0E7QUFDQTtBQUNBO0FBQ0E7OztBQzZJTyxJQUFNLGFBQXNDO0FBQUEsRUFDakQ7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRjtBQStNTyxJQUFNLG9CQUFvQixPQUFPLE9BQU87QUFBQSxFQUM3QztBQUFBLEVBQ0E7QUFBQSxFQUNB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
