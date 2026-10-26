#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// src/magpie/backend/server.ts
import { mkdirSync as mkdirSync2, rmSync as rmSync2, unlinkSync as unlinkSync2 } from "fs";
import { tmpdir } from "os";
import { dirname, join as join4 } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";

// plugins/spellbook/skills/magpie/shared/types.ts
var PHASES = ["intake", "slice", "remove", "export"];
function defaultState(title) {
  return {
    title,
    intent: "",
    phase: "intake",
    source: null,
    elements: [],
    conversation: [],
    backdrop: "transparent",
    status: { busy: false, text: "" }
  };
}
var AGENT_EVENT_TYPES = Object.freeze([
  "ready",
  "connected",
  "disconnected",
  "say",
  "source.added",
  "extract",
  "removeBg",
  "retryRemoval",
  "phase.advance",
  "phase.set",
  "export",
  "submit",
  "closed"
]);

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
function tailIdleMs(beatMs) {
  return beatMs * MISSED_BEATS;
}

// src/magpie/backend/heartbeat.ts
var IDLE_TIMEOUT_SEC = MAX_IDLE_TIMEOUT_SEC;
var SSE_HEARTBEAT_MS = DEFAULT_HEARTBEAT_MS;
var TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

// src/magpie/backend/persist.server.ts
import { mkdirSync, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "fs";
import { homedir } from "os";
import { join as join2 } from "path";
function magpieHome() {
  return process.env.MAGPIE_HOME ?? join2(homedir(), ".magpie");
}
function snapshotsDir() {
  return join2(magpieHome(), "snapshots");
}
function snapshotPath(sessionId) {
  return join2(snapshotsDir(), `${sessionId}.json`);
}
function saveSnapshot(sessionId, state) {
  try {
    mkdirSync(snapshotsDir(), { recursive: true });
    writeFileSync2(snapshotPath(sessionId), JSON.stringify(state));
  } catch {}
}
function loadSnapshot(idOrPath, title) {
  const path = idOrPath.endsWith(".json") ? idOrPath : snapshotPath(idOrPath);
  try {
    const snap = JSON.parse(readFileSync3(path, "utf8"));
    const merged = { ...defaultState(title), ...snap };
    if (merged.phase === "intake" && merged.elements.length > 0)
      merged.phase = "slice";
    return merged;
  } catch {
    return null;
  }
}

// src/magpie/backend/reduce.ts
function randHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
function newId(prefix) {
  return `${prefix}-${randHex(4)}`;
}
function pushMessage(s, m) {
  const msg = { id: m.id ?? newId("m"), ts: Date.now(), ...m };
  s.conversation.push(msg);
  return msg;
}
function setStatus(s, busy, text = "") {
  s.status = { busy, text };
}
function setIntent(s, intent) {
  s.intent = intent;
}
function setSource(s, source) {
  s.source = source;
}
function setElements(s, elements) {
  s.elements = elements.map((e) => ({
    ...e,
    id: e.id || newId("e"),
    status: e.status ?? "proposed"
  }));
}
var REGION_RE = /^region_\d+$/;
function nextRegionName(s) {
  const n = s.elements.filter((e) => REGION_RE.test(e.name)).length + 1;
  return `region_${n}`;
}
function addElement(s, draft) {
  const el = {
    id: newId("e"),
    name: draft.name || nextRegionName(s),
    type: draft.type ?? "other",
    bbox: draft.bbox,
    status: draft.status ?? "confirmed"
  };
  s.elements.push(el);
  return el;
}
function removeElement(s, id) {
  const i = s.elements.findIndex((e) => e.id === id);
  if (i < 0)
    return false;
  s.elements.splice(i, 1);
  return true;
}
function updateElement(s, id, patch) {
  const el = s.elements.find((e) => e.id === id);
  if (!el)
    return false;
  const { id: _drop, ...rest } = patch;
  Object.assign(el, rest);
  return true;
}
var ELEMENT_STATUSES = ["proposed", "confirmed", "dropped"];
function judgeElement(s, id, status) {
  if (!ELEMENT_STATUSES.includes(status))
    return false;
  const el = s.elements.find((e) => e.id === id);
  if (!el || el.status === status)
    return false;
  el.status = status;
  return true;
}
function flagElement(s, id, flagged) {
  const el = s.elements.find((e) => e.id === id);
  if (!el)
    return false;
  if ((el.flagged ?? false) === flagged)
    return false;
  el.flagged = flagged;
  return true;
}
function addVersion(s, id, v, opts = {}) {
  const el = s.elements.find((e) => e.id === id);
  if (!el)
    return null;
  if (!el.versions)
    el.versions = [];
  const existing = el.versions.find((x) => x.model === v.model);
  let stored;
  if (existing) {
    existing.path = v.path;
    existing.rev = (existing.rev ?? 0) + 1;
    if (v.kind !== undefined)
      existing.kind = v.kind;
    if (v.note !== undefined)
      existing.note = v.note;
    stored = existing;
  } else {
    stored = { ...v, rev: v.rev ?? 0 };
    el.versions.push(stored);
  }
  if (opts.choose ?? true)
    el.chosenVersionId = stored.id;
  el.flagged = false;
  return stored;
}
function chooseVersion(s, id, versionId) {
  const el = s.elements.find((e) => e.id === id);
  if (!el || !(el.versions ?? []).some((v) => v.id === versionId))
    return false;
  if (el.chosenVersionId === versionId)
    return false;
  el.chosenVersionId = versionId;
  return true;
}
var BACKDROPS = ["white", "gray", "black", "transparent"];
function setBackdrop(s, backdrop) {
  if (!BACKDROPS.includes(backdrop) || s.backdrop === backdrop)
    return false;
  s.backdrop = backdrop;
  return true;
}
function advancePhase(s) {
  const i = PHASES.indexOf(s.phase);
  if (i < 0 || i >= PHASES.length - 1)
    return null;
  const next = PHASES[i + 1];
  if (next === undefined)
    return null;
  s.phase = next;
  return s.phase;
}
function setPhase(s, phase) {
  if (!PHASES.includes(phase) || s.phase === phase)
    return false;
  s.phase = phase;
  return true;
}
function setBundle(s, name, count) {
  s.bundle = { name, count };
}
function leanState(s) {
  return {
    ...s,
    elements: s.elements.map((e) => {
      const lean = { ...e };
      delete lean.src;
      delete lean.cutouts;
      return lean;
    })
  };
}

// src/magpie/backend/source.server.ts
import { writeFileSync as writeFileSync3 } from "fs";
import { basename, join as join3 } from "path";
function decodeDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0)
    throw new Error("empty image payload");
  return new Uint8Array(bytes);
}
function sanitizeName(name) {
  const base = basename(name || "").replace(/[^A-Za-z0-9._-]/g, "_");
  if (!base || base === "." || base === ".." || base.startsWith("."))
    return "source.png";
  return base;
}
async function materializeSource(filesDir, name, dataUrl) {
  const bytes = decodeDataUrl(dataUrl);
  const safe = sanitizeName(name);
  const path = join3(filesDir, safe);
  writeFileSync3(path, bytes);
  const meta = await new Bun.Image(bytes).metadata();
  const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16);
  return {
    path,
    size: [meta.width ?? 0, meta.height ?? 0],
    sha
  };
}

// src/magpie/backend/server.ts
var SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
var SKILL_ROOT = join4(SCRIPT_DIR, "..");
var DIST_DIR = join4(SKILL_ROOT, "dist");
function serveDist(path) {
  return serveFromDist(DIST_DIR, path === "/" ? "index.html" : path.slice(1));
}
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
function randHex2(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" });
  } catch {}
}
var MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};
function guessMime(name) {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}
async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        title: { type: "string", default: "magpie" },
        intent: { type: "string" },
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
  let state = defaultState(v.title);
  if (typeof v.intent === "string")
    state.intent = v.intent;
  let restored = false;
  if (v.restore) {
    const loaded = loadSnapshot(v.restore, v.title);
    if (loaded) {
      state = loaded;
      restored = true;
    } else {
      process.stderr.write(`magpie: restore failed (${v.restore})
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
  function emitEvent(msg) {
    log.emit(msg);
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
    broadcast({ type: "state", state });
  };
  const broadcastPresence = () => broadcast({ type: "presence", agent: sseClients.size > 0 });
  function handleAgentMsg(raw) {
    const msg = raw;
    switch (msg.type) {
      case "init":
        if (typeof msg.title === "string")
          state.title = msg.title;
        if (typeof msg.intent === "string")
          setIntent(state, msg.intent);
        broadcastState();
        break;
      case "say":
        if (typeof msg.text === "string" && msg.text) {
          pushMessage(state, { role: "agent", kind: "text", text: msg.text, action: msg.action });
          broadcastState();
        }
        break;
      case "ask":
        if (typeof msg.text === "string" && msg.text) {
          pushMessage(state, {
            role: "agent",
            kind: "question",
            text: msg.text,
            options: Array.isArray(msg.options) ? msg.options : undefined
          });
          broadcastState();
        }
        break;
      case "source.set":
        if (typeof msg.path === "string" && Array.isArray(msg.size)) {
          setSource(state, { path: msg.path, size: msg.size, sha: String(msg.sha ?? "") });
          broadcastState();
        }
        break;
      case "elements.set":
        if (Array.isArray(msg.elements)) {
          setElements(state, msg.elements);
          if (state.phase === "intake" && state.elements.length)
            advancePhase(state);
          broadcastState();
        }
        break;
      case "element.add":
        if (msg.element && Array.isArray(msg.element.bbox)) {
          const el = addElement(state, msg.element);
          broadcastState();
          return {
            recognised: true,
            ok: true,
            detail: { id: el.id, name: el.name, outcome: "created" }
          };
        }
        return {
          recognised: true,
          ok: false,
          status: 400,
          error: "element.add requires `element` with a `bbox` array \u2014 nothing was added " + "(the element is unchanged and no id was minted)"
        };
      case "element.update":
        if (typeof msg.id === "string" && msg.patch && updateElement(state, msg.id, msg.patch)) {
          broadcastState();
        }
        break;
      case "element.remove":
        if (typeof msg.id === "string" && removeElement(state, msg.id)) {
          broadcastState();
        }
        break;
      case "element.addVersion":
        if (typeof msg.id === "string" && msg.version && addVersion(state, msg.id, msg.version, { choose: msg.choose ?? true })) {
          broadcastState();
        }
        break;
      case "phase.set":
        if (typeof msg.phase === "string" && setPhase(state, msg.phase)) {
          broadcastState();
        }
        break;
      case "bundle.set":
        if (typeof msg.name === "string" && typeof msg.count === "number") {
          setBundle(state, msg.name, msg.count);
          broadcastState();
        }
        break;
      case "status":
        setStatus(state, msg.busy === true, typeof msg.text === "string" ? msg.text : "");
        broadcastState();
        break;
      case "close":
        resolveDone({ code: 0, reason: "close" });
        break;
      default:
        return false;
    }
    return true;
  }
  function handleBrowserMsg(raw) {
    const msg = raw;
    switch (msg.type) {
      case "say":
        if (typeof msg.text !== "string" || !msg.text)
          return;
        pushMessage(state, { role: "user", kind: "text", text: msg.text });
        broadcastState();
        emitEvent({ type: "say", text: msg.text });
        break;
      case "source.import": {
        if (typeof msg.name !== "string" || typeof msg.dataUrl !== "string")
          return;
        (async () => {
          try {
            const source = await materializeSource(sessionFilesDir, msg.name, msg.dataUrl);
            setSource(state, source);
            broadcastState();
            emitEvent({
              type: "source.added",
              path: source.path,
              size: source.size,
              sha: source.sha
            });
          } catch (e) {
            process.stderr.write(`magpie: source.import failed: ${e instanceof Error ? e.message : String(e)}
`);
          }
        })();
        break;
      }
      case "element.add": {
        if (!msg.element || !Array.isArray(msg.element.bbox))
          return;
        const el = addElement(state, msg.element);
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `drew ${el.name}`,
          gesture: { kind: "draw", targetId: el.id }
        });
        broadcastState();
        break;
      }
      case "element.update": {
        if (typeof msg.id !== "string" || !msg.patch)
          return;
        if (!updateElement(state, msg.id, msg.patch))
          return;
        const renamed = typeof msg.patch.name === "string";
        const retyped = typeof msg.patch.type === "string";
        if (renamed || retyped) {
          const el = state.elements.find((e) => e.id === msg.id);
          const text = renamed ? `renamed ${el?.name ?? msg.id}` : `retyped ${el?.name ?? msg.id} \u2192 ${msg.patch.type}`;
          pushMessage(state, {
            role: "user",
            kind: "gesture",
            text,
            gesture: { kind: renamed ? "rename" : "retype", targetId: msg.id }
          });
        }
        broadcastState();
        break;
      }
      case "element.remove": {
        if (typeof msg.id !== "string")
          return;
        const name = state.elements.find((e) => e.id === msg.id)?.name ?? msg.id;
        if (!removeElement(state, msg.id))
          return;
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `removed ${name}`,
          gesture: { kind: "remove", targetId: msg.id }
        });
        broadcastState();
        break;
      }
      case "element.judge": {
        if (typeof msg.id !== "string")
          return;
        if (!judgeElement(state, msg.id, msg.status))
          return;
        const el = state.elements.find((e) => e.id === msg.id);
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `judged ${el?.name ?? msg.id}: ${msg.status}`,
          gesture: { kind: "judge", targetId: msg.id }
        });
        broadcastState();
        break;
      }
      case "extract": {
        const ids = Array.isArray(msg.ids) ? msg.ids : undefined;
        const n = ids ? ids.length : state.elements.filter((e) => e.status !== "dropped").length;
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `asked to cut ${n} slice${n === 1 ? "" : "s"}`,
          gesture: { kind: "extract" }
        });
        setStatus(state, true, `Re-slicing ${n} slice${n === 1 ? "" : "s"}\u2026`);
        broadcastState();
        emitEvent({ type: "extract", ids });
        break;
      }
      case "element.flag": {
        if (typeof msg.id !== "string")
          return;
        const flagged = msg.flagged === true;
        if (!flagElement(state, msg.id, flagged))
          return;
        const el = state.elements.find((e) => e.id === msg.id);
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: flagged ? `flagged ${el?.name ?? msg.id}` : `unflagged ${el?.name ?? msg.id}`,
          gesture: { kind: "flag", targetId: msg.id }
        });
        broadcastState();
        break;
      }
      case "version.choose":
        if (typeof msg.id !== "string" || typeof msg.versionId !== "string")
          return;
        if (chooseVersion(state, msg.id, msg.versionId))
          broadcastState();
        break;
      case "removeBg": {
        const ids = Array.isArray(msg.ids) ? msg.ids : undefined;
        const n = ids ? ids.length : state.elements.filter((e) => e.status !== "dropped").length;
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `asked to remove ${n} background${n === 1 ? "" : "s"}`,
          gesture: { kind: "removeBg" }
        });
        setStatus(state, true, `Removing ${n} background${n === 1 ? "" : "s"}\u2026`);
        broadcastState();
        emitEvent({ type: "removeBg", ids });
        break;
      }
      case "retryRemoval": {
        const ids = Array.isArray(msg.ids) ? msg.ids : [];
        if (!ids.length)
          return;
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `asked to try a different removal on ${ids.length}`,
          gesture: { kind: "retryRemoval" }
        });
        setStatus(state, true, `Trying a different removal on ${ids.length}\u2026`);
        broadcastState();
        emitEvent({ type: "retryRemoval", ids });
        break;
      }
      case "backdrop.set":
        if (setBackdrop(state, msg.backdrop))
          broadcastState();
        break;
      case "phase.advance": {
        const prev = state.phase;
        const next = advancePhase(state);
        if (!next)
          return;
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `sealed ${prev} \u2192 ${next}`,
          gesture: { kind: "phase.advance" }
        });
        broadcastState();
        emitEvent({ type: "phase.advance", phase: next });
        break;
      }
      case "phase.set": {
        if (typeof msg.phase !== "string")
          return;
        if (!setPhase(state, msg.phase))
          return;
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `stepped to ${msg.phase}`,
          gesture: { kind: "phase.set", targetId: msg.phase }
        });
        broadcastState();
        emitEvent({ type: "phase.set", phase: msg.phase });
        break;
      }
      case "export": {
        const ids = Array.isArray(msg.ids) ? msg.ids : undefined;
        const n = ids ? ids.length : state.elements.filter((e) => e.status !== "dropped").length;
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `asked to export ${n} asset${n === 1 ? "" : "s"}`,
          gesture: { kind: "export" }
        });
        setStatus(state, true, `Building bundle (${n} asset${n === 1 ? "" : "s"})\u2026`);
        broadcastState();
        emitEvent({ type: "export", ids });
        break;
      }
      case "submit":
        broadcast({ type: "submit" });
        emitEvent({ type: "submit" });
        resolveDone({ code: 0, reason: "submit" });
        break;
      case "cancel":
        broadcast({ type: "cancel" });
        resolveDone({ code: EXIT_CANCELLED, reason: "cancel" });
        break;
    }
  }
  function eventsResponse(req, url2) {
    touch();
    return sseResponse({
      log,
      since: Number.parseInt(url2.searchParams.get("since") ?? "-1", 10),
      heartbeatMs: SSE_HEARTBEAT_MS,
      clients: sseClients,
      signal: req.signal,
      onOpen: broadcastPresence,
      onClose: broadcastPresence
    });
  }
  let sessionFilesDir = "";
  const mode = resolveMode(DIST_DIR);
  const devIndex = mode === "dev" ? (await import("../../../../../src/magpie/surface/index.html")).default : undefined;
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
          return req.json().then((body) => {
            touch();
            const verdict = handleAgentMsg(body);
            if (typeof verdict === "object") {
              if (!verdict.ok)
                return Response.json({ ok: false, applied: false, error: verdict.error }, { status: verdict.status });
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
          if (assetName.includes("..") || assetName.startsWith("/") || !sessionFilesDir) {
            return new Response('{"error":"not found"}', {
              status: 404,
              headers: { "Content-Type": "application/json" }
            });
          }
          const f = Bun.file(join4(sessionFilesDir, assetName));
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
          ws.send(JSON.stringify({ type: "presence", agent: sseClients.size > 0 }));
        },
        message(_ws, raw) {
          touch();
          let msg;
          try {
            msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
          } catch (e) {
            process.stderr.write(`magpie: bad json from browser: ${e instanceof Error ? e.message : String(e)}
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
    sessionId = `magpie-${randHex2(4)}-p${boundPort}`;
  state.sessionId = sessionId;
  sessionFilesDir = join4(tmpdir(), `${sessionId}-files`);
  try {
    mkdirSync2(sessionFilesDir, { recursive: true });
  } catch {}
  if (restored)
    saveSnapshot(sessionId, state);
  const url = `http://${host}:${boundPort}`;
  emitEvent({ type: "ready", url, port: boundPort, session_id: sessionId, mode });
  const sessionFile = join4(tmpdir(), `magpie-${sessionId}.json`);
  const latestFile = join4(tmpdir(), `magpie-latest.json`);
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
    process.stderr.write(`magpie: could not write discovery file: ${e instanceof Error ? e.message : String(e)}
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
      write: () => saveSnapshot(sessionId, state)
    }
  });
  const { code, reason } = await done;
  stopHousekeeping();
  saveSnapshot(sessionId, state);
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
  parsePortFromSessionId,
  run,
  snapshotsDir
};
