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

// src/magpie/backend/heartbeat.ts
var IDLE_TIMEOUT_SEC = MAX_IDLE_TIMEOUT_SEC;
var SSE_HEARTBEAT_MS = DEFAULT_HEARTBEAT_MS;
var TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

// src/magpie/backend/persist.server.ts
import { mkdirSync, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";
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
    const snap = JSON.parse(readFileSync2(path, "utf8"));
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
  s.phase = PHASES[i + 1];
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
  const port = parseInt(m[1], 10);
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
        resolveDone({ code: 130, reason: "cancel" });
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
    onIdleClose: () => resolveDone({ code: 124, reason: "timeout" }),
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

//# debugId=743894A511E6605564756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL21hZ3BpZS9iYWNrZW5kL3NlcnZlci50cyIsICIuLi9zaGFyZWQvdHlwZXMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2Rpc2NvdmVyeS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXZlbnRMb2cudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2hvdXNla2VlcGluZy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc2VydmVEaXN0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9zc2UudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvbWFncGllL2JhY2tlbmQvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9tYWdwaWUvYmFja2VuZC9wZXJzaXN0LnNlcnZlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvbWFncGllL2JhY2tlbmQvcmVkdWNlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9tYWdwaWUvYmFja2VuZC9zb3VyY2Uuc2VydmVyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIiMhL3Vzci9iaW4vZW52IGJ1blxuXG4vLyBtYWdwaWUg4oCUIGEgc3RhbmRpbmcgY29uanVyYXRpb24gb3ZlciBhIGNvbXBvc2l0ZSBpbWFnZS5cbi8vXG4vLyBUaGUgZGFlbW9uIGhvbGRzIHRoZSBjYW5vbmljYWwgZXh0cmFjdGlvbiBzdGF0ZTsgdGhlIFJlYWN0IHN1cmZhY2Ugc2hvd3MgdGhlXG4vLyBlbGVtZW50IGJyZWFrZG93biwgdGhlIHVzZXIganVkZ2VzIGVhY2ggY3V0b3V0LCBjb21wYXJlcyByZW1vdmFsLW1vZGVsXG4vLyByZXN1bHRzLCBhbmQgc2VsZWN0aXZlbHkgcmV0cmllcy4gVGhlIGFnZW50IGRyaXZlcyBkaXNjb3ZlcnkgKyBleHRyYWN0aW9uIG91dFxuLy8gb2YgYmFuZCBhbmQgcG9zdHMgcmVzdWx0cyBoZXJlOyB0aGUgc3VyZmFjZSBpcyB3aGVyZSB0aGUgdXNlciBzdGVlcnMuXG4vL1xuLy8gQXJjaGl0ZWN0dXJlIChjbGkudHMgd3JhcHMgdGhpcyk6XG4vLyAgIC0gQWdlbnQg4oaUIHNlcnZlcjogSFRUUCBvbiB0aGUgc2FtZSBCdW4uc2VydmUuXG4vLyAgICAgICBQT1NUIC9jbWQgICAgICAgICAgICDigJQgYWdlbnQgY29tbWFuZCAoSlNPTjsgQWdlbnRDb21tYW5kIHVuaW9uKVxuLy8gICAgICAgR0VUICAvc3RhdGVbP2xlYW49MV0g4oCUIGZ1bGwgc25hcHNob3QgeyBzdGF0ZSwgY3Vyc29yIH07IGxlYW4gc3RyaXBzIGJsb2JzXG4vLyAgICAgICBHRVQgIC9ldmVudHM/c2luY2U9TiDigJQgU1NFIHN0cmVhbSBvZiB1c2VyIGV2ZW50cyAoTW9uaXRvci13cmFwcGFibGUpXG4vLyAgIC0gU2VydmVyIOKGlCBicm93c2VyOiBXZWJTb2NrZXQgYXQgL3dzIChDbGllbnRUb1NlcnZlciAvIFNlcnZlclRvQ2xpZW50KS5cbi8vICAgLSBHRVQgL2Fzc2V0cy88bmFtZT4gICAgIOKAlCBzZXJ2ZSBwZXItc2Vzc2lvbiBmaWxlcyAoc291cmNlL2N1dG91dHMpIGZyb20gYVxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwZXItc2Vzc2lvbiB0bXAgZGlyLCBzYW5pdGl6ZWQgYWdhaW5zdCB0cmF2ZXJzYWwuXG4vLyAgIC0gU2VydmVyIGhvbGRzIGNhbm9uaWNhbCBzdGF0ZTsgZnVsbC1zdGF0ZSBicm9hZGNhc3QgdG8gYnJvd3NlcnMgb24gY2hhbmdlLlxuLy9cbi8vIFRoZSBzaW5nbGUgY29udHJhY3QgaXMgc2hhcmVkL3R5cGVzLnRzICh0aGUgQWdlbnRDb21tYW5kIC8gQ2xpZW50VG9TZXJ2ZXJcbi8vIHVuaW9ucyArIEFHRU5UX0VWRU5UX1RZUEVTKSDigJQgVFdPLVNJREVELCBzbyBpdCBzaXRzIGluIHRoZSBzcGVsbCdzIG93blxuLy8gc2hhcmVkLyByYXRoZXIgdGhhbiBpbiBlaXRoZXIgc2lkZSdzIHRyZWUuIFB1cmUgbXV0YXRvcnMgbGl2ZSBpblxuLy8gc2NyaXB0cy9yZWR1Y2UudHMgYW5kIHNuYXBzaG90IHBlcnNpc3RlbmNlIGluIHNjcmlwdHMvcGVyc2lzdC5zZXJ2ZXIudHM7XG4vLyBib3RoIGFyZSBkYWVtb24tb25seSBhbmQgbmVpdGhlciBpcyBpbXBvcnRlZCBieSBicm93c2VyIGNvZGUuXG4vL1xuLy8gRXhpdCBjb2RlczogMCBzdWJtaXQvY2xvc2UsIDIgYmFkIGFyZ3MsIDEyNCBpZGxlIHRpbWVvdXQsIDEzMCBjYW5jZWwuXG5cbmltcG9ydCB7IG1rZGlyU3luYywgcm1TeW5jLCB1bmxpbmtTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHR5cGUgeyBTZXJ2ZXJXZWJTb2NrZXQgfSBmcm9tIFwiYnVuXCI7XG5pbXBvcnQge1xuICB0eXBlIEFnZW50Q29tbWFuZCxcbiAgdHlwZSBCYWNrZHJvcCxcbiAgdHlwZSBDbGllbnRUb1NlcnZlcixcbiAgZGVmYXVsdFN0YXRlLFxuICB0eXBlIEVsZW1lbnQsXG4gIHR5cGUgRWxlbWVudFN0YXR1cyxcbiAgdHlwZSBNYWdwaWVTdGF0ZSxcbiAgdHlwZSBQaGFzZUtleSxcbn0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9tYWdwaWUvc2hhcmVkL3R5cGVzXCI7XG5pbXBvcnQgeyB1bmxpbmtJZk1hdGNoZXMsIHdyaXRlRmlsZUF0b21pYyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9kaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB7IGNyZWF0ZUV2ZW50TG9nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2V2ZW50TG9nLnRzXCI7XG5pbXBvcnQgeyBkcmFpbkFuZFN0b3AsIHN0YXJ0SG91c2VrZWVwaW5nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hvdXNla2VlcGluZy50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZU1vZGUsIHNlcnZlRnJvbURpc3QgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvc2VydmVEaXN0LnRzXCI7XG5pbXBvcnQgeyB0eXBlIFNzZUNsaWVudHMsIHNzZVJlc3BvbnNlIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3NzZS50c1wiO1xuaW1wb3J0IHsgSURMRV9USU1FT1VUX1NFQywgU1NFX0hFQVJUQkVBVF9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdC50c1wiO1xuaW1wb3J0IHsgbG9hZFNuYXBzaG90LCBzYXZlU25hcHNob3QsIHNuYXBzaG90c0RpciB9IGZyb20gXCIuL3BlcnNpc3Quc2VydmVyXCI7XG5pbXBvcnQge1xuICBhZGRFbGVtZW50LFxuICBhZGRWZXJzaW9uLFxuICBhZHZhbmNlUGhhc2UsXG4gIGNob29zZVZlcnNpb24sXG4gIGZsYWdFbGVtZW50LFxuICBqdWRnZUVsZW1lbnQsXG4gIGxlYW5TdGF0ZSxcbiAgcHVzaE1lc3NhZ2UsXG4gIHJlbW92ZUVsZW1lbnQsXG4gIHNldEJhY2tkcm9wLFxuICBzZXRCdW5kbGUsXG4gIHNldEVsZW1lbnRzLFxuICBzZXRJbnRlbnQsXG4gIHNldFBoYXNlLFxuICBzZXRTb3VyY2UsXG4gIHNldFN0YXR1cyxcbiAgdXBkYXRlRWxlbWVudCxcbn0gZnJvbSBcIi4vcmVkdWNlXCI7XG5pbXBvcnQgeyBtYXRlcmlhbGl6ZVNvdXJjZSB9IGZyb20gXCIuL3NvdXJjZS5zZXJ2ZXJcIjtcblxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcblxuLy8g4pSA4pSAIHN1cmZhY2UgbW9kZSAoc2VhbXMgQ29udHJhY3QgMSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vL1xuLy8gYGltcG9ydCBpbmRleCBmcm9tIFwiLi4vc3VyZmFjZS9pbmRleC5odG1sXCJgIHVzZWQgdG8gc2l0IGF0IHRoZSB0b3Agb2YgdGhpc1xuLy8gZmlsZS4gQSB0b3AtbGV2ZWwgU1RBVElDIGltcG9ydCBmb3JjZXMgQnVuIHRvIHJlc29sdmUgdGhlIHdob2xlIC50c3ggK1xuLy8gVGFpbHdpbmQgYnVpbGQgZ3JhcGggd2hlbiB0aGUgbW9kdWxlIExPQURTLCBzbyBhIGRlc3RpbmF0aW9uIHRoYXQgc2hpcHNcbi8vIGRpc3QvIGFuZCBubyBzdXJmYWNlLyDigJQgdGhlIHB1Ymxpc2hlZCBhcnRpZmFjdCDigJQgZGllcyBiZWZvcmUgaXQgY2FuIHNlcnZlXG4vLyB0aGUgZGlzdCBpdCBkb2VzIGhhdmUuIFRoZSBkZXYgaW1wb3J0IGlzIHRoZXJlZm9yZSBkeW5hbWljIGFuZCByZWFjaGVkIG9ubHlcbi8vIG9uIHRoZSBkZXYgYnJhbmNoLCBhcyBhc3Ryb2xhYmUsIGltYWdvIGFuZCBtaW5kLW1hcHBlciBhbGwgZG8gaXQuXG4vL1xuLy8g4puUIE1BR1BJRSdTIGRpc3QvIEFMUkVBRFkgRVhJU1RFRCwgSE9MRElORyBjbGkuanMgQU5EIE5PIGluZGV4Lmh0bWwg4oCUIHdoaWNoXG4vLyBpcyBwcmVjaXNlbHkgd2h5IHRoaXMgZGFlbW9uIHN0YXllZCBjb3JyZWN0bHkgaW4gREVWIG1vZGUgdGhyb3VnaCBhbGwgb2Zcbi8vIFNsaWNlIDIuIFRoZSBGSVJTVCBzdXJmYWNlIGJ1aWxkIHRvIGxhbmQgYW4gaW5kZXguaHRtbCBoZXJlIEZMSVBTXG4vLyByZXNvbHZlTW9kZSgpLCBhbmQgbm90aGluZyBhbm5vdW5jZXMgdGhlIHRyYW5zaXRpb24uIGBkaXN0L2AgZXhpc3RpbmcgaXMgbm90XG4vLyB0aGUgZGlzY3JpbWluYXRvcjsgYGRpc3QvaW5kZXguaHRtbGAgaXMuXG4vL1xuLy8gUGF0aHMgYW5jaG9yIGF0IHRoZSBTS0lMTCBST09ULCBuZXZlciBhdCBjd2Q6IGNsaS50cyBwaW5zIHRoZSBkYWVtb24ncyBjd2Rcbi8vIGZvciBidW5maWcudG9tbCdzIHNha2UgKENvbnRyYWN0IDUpLCBzbyBjd2QgaXMgbm90IGEgc3RhYmxlIGJhc2UgZm9yIGRpc3QvLlxuLy9cbi8vIOKblCBgU0NSSVBUX0RJUmAgSEVSRSBJUyBUSEUgRElSRUNUT1JZIE9GIFRIRSBFTUlUVEVEIEJVTkRMRSwgTk9UIE9GIFRISVMgRklMRS5cbi8vIFRoaXMgbW9kdWxlIGlzIEFVVEhPUkVEIGF0IGBzcmMvbWFncGllL2JhY2tlbmQvc2VydmVyLnRzYCBhbmQgRVhFQ1VURVMgYXNcbi8vIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWFncGllL2Rpc3Qvc2VydmVyLmpzYCAoUGhhc2UgMWIpLiBgZGlzdC9gIHNpdHMgYXRcbi8vIHRoZSBTQU1FIERFUFRIIGFzIHRoZSBgc2NyaXB0cy9gIGl0IHJlcGxhY2VkLCBzbyBldmVyeSBBTkNFU1RPUi1yZWxhdGl2ZSBwYXRoXG4vLyBiZWxvdyBpcyB1bmNoYW5nZWQgYnkgdGhlIG1vdmUuIEEgU0lCTElORy1yZWxhdGl2ZSBvbmUgaXMgTk9UIOKAlCBzZWVcbi8vIGBiYWNrZW5kLnRzYCdzIGByZW1vdmUucHlgLCB3aGljaCBpcyB3aGVyZSBleGFjdGx5IHRoYXQgd2VudCB3cm9uZyBhbmRcbi8vIHNoaXBwZWQuIEFzc2VydGVkIGluIGBzZXJ2ZXIudGVzdC50c2AsIG5vdCByZWFzb25lZCBhYm91dC5cbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuXG4vLyBTZXJ2ZXMgZGlzdC8gdmVyYmF0aW0g4oCUIGVudHJ5IGluZGV4Lmh0bWwgcGx1cyB0aGUgaGFzaGVkIEpTIGFuZCBDU1MgY2h1bmtzXG4vLyAoQ29udHJhY3QgMidzIGZsYXQsIHJlbGF0aXZlLWhyZWYgbGF5b3V0KS4gVEhFIFVSTC1UTy1GSUxFTkFNRSBNQVBQSU5HIElTXG4vLyBUSElTIFNQRUxMJ1M7IHRoZSBmaWxlIHJlYWQsIHRoZSB0cmF2ZXJzYWwgZ3VhcmQgYW5kIHRoZSBjb250ZW50IHR5cGUgYXJlXG4vLyBgc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50c2AuIFRoZSBndWFyZCBpcyBhbHNvIHdoYXQga2VlcHMgdGhpcyBjbGVhciBvZlxuLy8gbWFncGllJ3Mgb3duIGAvYXNzZXRzLzxuYW1lPmAgcm91dGUgYWJvdmUgaXQg4oCUIGEgbmVzdGVkIHBhdGggaXMgcmVmdXNlZCBoZXJlXG4vLyByYXRoZXIgdGhhbiBzaGFkb3dlZCB0aGVyZS5cbmZ1bmN0aW9uIHNlcnZlRGlzdChwYXRoOiBzdHJpbmcpOiBSZXNwb25zZSB8IG51bGwge1xuICByZXR1cm4gc2VydmVGcm9tRGlzdChESVNUX0RJUiwgcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSkpO1xufVxuXG50eXBlIENsb3NlUmVhc29uID0gXCJzdWJtaXRcIiB8IFwiY2FuY2VsXCIgfCBcInRpbWVvdXRcIiB8IFwiY2xvc2VcIjtcbnR5cGUgRG9uZVJlc3VsdCA9IHsgY29kZTogbnVtYmVyOyByZWFzb246IENsb3NlUmVhc29uIH07XG5cbmNvbnN0IFBPUlRfU1VGRklYX1JFID0gLy1wKFxcZHsyLDV9KSQvO1xuZnVuY3Rpb24gcGFyc2VQb3J0RnJvbVNlc3Npb25JZChzaWQ6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuICBjb25zdCBtID0gc2lkPy5tYXRjaChQT1JUX1NVRkZJWF9SRSk7XG4gIGlmICghbSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHBvcnQgPSBwYXJzZUludChtWzFdLCAxMCk7XG4gIHJldHVybiBwb3J0ID49IDEgJiYgcG9ydCA8PSA2NTUzNSA/IHBvcnQgOiBudWxsO1xufVxuXG5mdW5jdGlvbiByYW5kSGV4KGJ5dGVzOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBidWYgPSBuZXcgVWludDhBcnJheShieXRlcyk7XG4gIGNyeXB0by5nZXRSYW5kb21WYWx1ZXMoYnVmKTtcbiAgcmV0dXJuIEFycmF5LmZyb20oYnVmLCAoYikgPT4gYi50b1N0cmluZygxNikucGFkU3RhcnQoMiwgXCIwXCIpKS5qb2luKFwiXCIpO1xufVxuXG5mdW5jdGlvbiBvcGVuQnJvd3Nlcih1cmw6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBjbWQgPVxuICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCJcbiAgICAgID8gW1wib3BlblwiLCB1cmxdXG4gICAgICA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIlxuICAgICAgICA/IFtcImNtZFwiLCBcIi9jXCIsIFwic3RhcnRcIiwgXCJcIiwgdXJsXVxuICAgICAgICA6IFtcInhkZy1vcGVuXCIsIHVybF07XG4gIHRyeSB7XG4gICAgQnVuLnNwYXduKHsgY21kLCBzdGRvdXQ6IFwiaWdub3JlXCIsIHN0ZGVycjogXCJpZ25vcmVcIiB9KTtcbiAgfSBjYXRjaCB7XG4gICAgLyogYmVzdC1lZmZvcnQgKi9cbiAgfVxufVxuXG5jb25zdCBNSU1FX0JZX0VYVDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIucG5nXCI6IFwiaW1hZ2UvcG5nXCIsXG4gIFwiLmpwZ1wiOiBcImltYWdlL2pwZWdcIixcbiAgXCIuanBlZ1wiOiBcImltYWdlL2pwZWdcIixcbiAgXCIuZ2lmXCI6IFwiaW1hZ2UvZ2lmXCIsXG4gIFwiLnN2Z1wiOiBcImltYWdlL3N2Zyt4bWxcIixcbiAgXCIud2VicFwiOiBcImltYWdlL3dlYnBcIixcbn07XG5mdW5jdGlvbiBndWVzc01pbWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZG90ID0gbmFtZS5sYXN0SW5kZXhPZihcIi5cIik7XG4gIGNvbnN0IGV4dCA9IGRvdCA+PSAwID8gbmFtZS5zbGljZShkb3QpLnRvTG93ZXJDYXNlKCkgOiBcIlwiO1xuICByZXR1cm4gTUlNRV9CWV9FWFRbZXh0XSB8fCBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgbGV0IHBhcnNlZDogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VBcmdzPjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBwYXJzZUFyZ3Moe1xuICAgICAgYXJnczogYXJndixcbiAgICAgIG9wdGlvbnM6IHtcbiAgICAgICAgdGl0bGU6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVmYXVsdDogXCJtYWdwaWVcIiB9LFxuICAgICAgICBpbnRlbnQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIsIGRlZmF1bHQ6IFwiMTgwMFwiIH0sXG4gICAgICAgIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiLCBkZWZhdWx0OiBmYWxzZSB9LFxuICAgICAgICBwb3J0OiB7IHR5cGU6IFwic3RyaW5nXCIsIGRlZmF1bHQ6IFwiMFwiIH0sXG4gICAgICAgIGhvc3Q6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVmYXVsdDogXCIxMjcuMC4wLjFcIiB9LFxuICAgICAgICBpZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LCAvLyBzbmFwc2hvdCBwYXRoIG9yIHNlc3Npb24gaWQgdG8gcmVzdW1lXG4gICAgICB9LFxuICAgICAgc3RyaWN0OiB0cnVlLFxuICAgICAgYWxsb3dQb3NpdGlvbmFsczogZmFsc2UsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgZXJyb3I6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIGNvbnN0IHYgPSBwYXJzZWQudmFsdWVzO1xuICBjb25zdCB0aW1lb3V0ID0gcGFyc2VGbG9hdCh2LnRpbWVvdXQgYXMgc3RyaW5nKTtcbiAgbGV0IHBvcnQgPSBwYXJzZUludCh2LnBvcnQgYXMgc3RyaW5nLCAxMCk7XG4gIGNvbnN0IGhvc3QgPSB2Lmhvc3QgYXMgc3RyaW5nO1xuICBsZXQgc2Vzc2lvbklkID0gKHYuaWQgYXMgc3RyaW5nIHwgdW5kZWZpbmVkKSA/PyBcIlwiO1xuICBpZiAocG9ydCA9PT0gMCAmJiBzZXNzaW9uSWQpIHtcbiAgICBjb25zdCBlbWJlZGRlZCA9IHBhcnNlUG9ydEZyb21TZXNzaW9uSWQoc2Vzc2lvbklkKTtcbiAgICBpZiAoZW1iZWRkZWQgIT09IG51bGwpIHBvcnQgPSBlbWJlZGRlZDtcbiAgfVxuXG4gIGxldCBzdGF0ZTogTWFncGllU3RhdGUgPSBkZWZhdWx0U3RhdGUodi50aXRsZSBhcyBzdHJpbmcpO1xuICBpZiAodHlwZW9mIHYuaW50ZW50ID09PSBcInN0cmluZ1wiKSBzdGF0ZS5pbnRlbnQgPSB2LmludGVudDtcbiAgbGV0IHJlc3RvcmVkID0gZmFsc2U7XG4gIGlmICh2LnJlc3RvcmUpIHtcbiAgICBjb25zdCBsb2FkZWQgPSBsb2FkU25hcHNob3Qodi5yZXN0b3JlIGFzIHN0cmluZywgdi50aXRsZSBhcyBzdHJpbmcpO1xuICAgIGlmIChsb2FkZWQpIHtcbiAgICAgIHN0YXRlID0gbG9hZGVkO1xuICAgICAgcmVzdG9yZWQgPSB0cnVlO1xuICAgIH0gZWxzZSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgbWFncGllOiByZXN0b3JlIGZhaWxlZCAoJHt2LnJlc3RvcmV9KVxcbmApO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHNvY2tldHMgPSBuZXcgU2V0PFNlcnZlcldlYlNvY2tldDx1bmtub3duPj4oKTtcblxuICAvLyBBcHBlbmQtb25seSBldmVudCBsb2cgZm9yIHRoZSBhZ2VudCdzIFNTRSB0YWlsOyBtb25vdG9uaWMgaWRzIHNvIGFcbiAgLy8gcmVjb25uZWN0aW5nIHRhaWwgcmVwbGF5cyB2aWEgP3NpbmNlPTxpZD4uIFNoYXJlZCAoYGtpdC93aXJlL2V2ZW50TG9nLnRzYCksXG4gIC8vIHdoaWNoIGFsc28gYm91bmRzIHRoZSByZXBsYXkgd2luZG93IOKAlCBjZW5zdXMgZGVmZWN0IEw1LCBhbiBhcnJheSB0aGlzXG4gIC8vIGRhZW1vbiB1c2VkIHRvIGdyb3cgZm9yIGl0cyB3aG9sZSBsaWZlLlxuICAvL1xuICAvLyDimqAgTk8gRVBPQ0ggSEVSRSwgREVMSUJFUkFURUxZLiBBc3Ryb2xhYmUgc3RhbXBzIG9uZSBiZWNhdXNlIGl0IGlzIGFcbiAgLy8gU0lOR0xFVE9OIHRoYXQgZ2V0cyByZXNwYXduZWQgdW5kZXIgYSBydW5uaW5nIHRhaWw7IGEgbWFncGllIHNlc3Npb24gaXNcbiAgLy8gaWRlbnRpZmllZCBieSBpdHMgYHNlc3Npb25faWRgIGFuZCBhIHJlc3RhcnQgaXMgYSBkaWZmZXJlbnQgc2Vzc2lvbiwgc28gYVxuICAvLyByZXN1bWluZyB0YWlsIGlzIGFscmVhZHkgdGFsa2luZyB0byBhIGRpZmZlcmVudCBkYWVtb24gYnkgbmFtZS4gRXBvY2ggZm9yXG4gIC8vIHRoZSBvdGhlciBkYWVtb25zIGlzIG91dCBvZiB0aGlzIHBoYXNlJ3Mgc2NvcGUgYW5kIHRoaXMgaXMgdGhlIHJlYXNvbiBpdFxuICAvLyB3YXMgbm90IGZyZWUtcmlkZGVuIGludG8gbWFncGllIGp1c3QgYmVjYXVzZSB0aGUgbW9kdWxlIG9mZmVycyBpdC5cbiAgY29uc3QgbG9nID0gY3JlYXRlRXZlbnRMb2c8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KCk7XG4gIGNvbnN0IHNzZUNsaWVudHM6IFNzZUNsaWVudHMgPSBuZXcgU2V0KCk7XG5cbiAgbGV0IHJlc29sdmVEb25lITogKHZhbDogRG9uZVJlc3VsdCkgPT4gdm9pZDtcbiAgbGV0IHNldHRsZWQgPSBmYWxzZTtcbiAgY29uc3QgZG9uZSA9IG5ldyBQcm9taXNlPERvbmVSZXN1bHQ+KChyZXMpID0+IHtcbiAgICByZXNvbHZlRG9uZSA9ICh2YWwpID0+IHtcbiAgICAgIGlmIChzZXR0bGVkKSByZXR1cm47XG4gICAgICBzZXR0bGVkID0gdHJ1ZTtcbiAgICAgIHJlcyh2YWwpO1xuICAgIH07XG4gIH0pO1xuXG4gIGxldCBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgY29uc3QgdG91Y2ggPSAoKSA9PiB7XG4gICAgbGFzdEFjdGl2aXR5ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gIH07XG5cbiAgZnVuY3Rpb24gZW1pdEV2ZW50KG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgICBsb2cuZW1pdChtc2cpO1xuICB9XG5cbiAgZnVuY3Rpb24gYnJvYWRjYXN0KG1zZzogb2JqZWN0KSB7XG4gICAgY29uc3QgcyA9IEpTT04uc3RyaW5naWZ5KG1zZyk7XG4gICAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzKSB7XG4gICAgICB0cnkge1xuICAgICAgICB3cy5zZW5kKHMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHNvY2tldCBjbG9zZWQgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgbGV0IHNuYXBEaXJ0eSA9IGZhbHNlO1xuICBjb25zdCBicm9hZGNhc3RTdGF0ZSA9ICgpID0+IHtcbiAgICBzbmFwRGlydHkgPSB0cnVlOyAvLyBtYXJrIGZvciB0aGUgZGVib3VuY2VkIHBlcnNpc3RlbmNlIHNuYXBzaG90XG4gICAgYnJvYWRjYXN0KHsgdHlwZTogXCJzdGF0ZVwiLCBzdGF0ZSB9KTtcbiAgfTtcbiAgLy8gQWdlbnQgcHJlc2VuY2UgPSBhdCBsZWFzdCBvbmUgbGl2ZSBTU0UgdGFpbCAoYW4gYWdlbnQgbW9uaXRvcmluZyAvZXZlbnRzKS5cbiAgLy8gUnVudGltZS1vbmx5IOKAlCBwdXNoZWQgdG8gYnJvd3NlcnMsIG5ldmVyIGZvbGRlZCBpbnRvIHBlcnNpc3RlZCBzdGF0ZS5cbiAgY29uc3QgYnJvYWRjYXN0UHJlc2VuY2UgPSAoKSA9PiBicm9hZGNhc3QoeyB0eXBlOiBcInByZXNlbmNlXCIsIGFnZW50OiBzc2VDbGllbnRzLnNpemUgPiAwIH0pO1xuXG4gIC8vIOKUgOKUgCBhZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLy8gIzg0IOKAlCBSRVRVUk5TIEEgVkVSRElDVDogYHRydWVgIGlmIHRoZSBjb21tYW5kIHR5cGUgd2FzIFJFQ09HTklTRUQuXG4gIC8vIFRoZSBzd2l0Y2ggYmVsb3cgaGFkIDEzIGNhc2VzIGFuZCBOTyBgZGVmYXVsdDpgLCBzbyBhbiB1bnJlY29nbmlzZWQgdHlwZVxuICAvLyBmZWxsIHN0cmFpZ2h0IHRocm91Z2ggYW5kIHRoZSAvY21kIHJvdXRlIHN0aWxsIGFuc3dlcmVkIHtvazp0cnVlfSDigJQgYSBib2d1c1xuICAvLyB0eXBlIHdhcyBieXRlLWlkZW50aWNhbCB0byBhbiBleGVjdXRlZCBvbmUsIG1lYXN1cmVkIGxpdmUuXG4gIC8vXG4gIC8vIFwiUmVjb2duaXNlZFwiLCBOT1QgXCJjaGFuZ2VkIHN0YXRlXCI6IHNldmVyYWwgY2FzZXMgYXJlIGd1YXJkZWQgYnkgYSBzaGFwZVxuICAvLyBjaGVjayBhbmQgbGVnaXRpbWF0ZWx5IGRvIG5vdGhpbmcsIGFuZCByZXBvcnRpbmcgdGhvc2UgYXMgZmFpbHVyZXMgd291bGRcbiAgLy8gYnJlYWsgd29ya2luZyBjYWxsZXJzLiBUaGUgbmFycm93ZXIgY29udHJhY3QgaXMgYSBkZWxpYmVyYXRlbHkgdW5jbGFpbWVkIGdhcC5cbiAgLy9cbiAgLy8g4pqgIGhhbmRsZUJyb3dzZXJNc2cgYmVsb3cgaXMgYSBTRVBBUkFURSBmdW5jdGlvbiB3aXRoIGEgbmVhci1pZGVudGljYWxcbiAgLy8gc3dpdGNoLiBJdCBpcyBOT1QgcGFydCBvZiB0aGlzIHZlcmRpY3Qg4oCUIHRoZSBXZWJTb2NrZXQgaGFzIG5vIHJlc3BvbnNlIHRvXG4gIC8vIGNhcnJ5IG9uZSDigJQgYW5kIG11c3Qgbm90IGJlIGZvbGRlZCBpbi5cbiAgLy8gQ29udHJhY3QgMTM6IHRoZSB2ZXJkaWN0IG9yaWdpbmF0ZXMgaW4gdGhlIGNvZGUgb3duaW5nIHRoZSByZWNvZ25pc2VkIHNldC5cbiAgLy8gYjEzIHdpZGVucyB0aGUgUkVUVVJOIHdpdGhvdXQgd2lkZW5pbmcgdGhlIENPTlRSQUNUIOKAlCBhIGNvbW1hbmQgbWF5IGFuc3dlclxuICAvLyB3aXRoIGEgcmVzdWx0IG9iamVjdCBpbnN0ZWFkIG9mIHRoZSBib29sZWFuLCBhbmQgZXZlcnkgb3RoZXIgY29tbWFuZCBrZWVwc1xuICAvLyB0aGUgYmFyZSBib29sZWFuIHdpdGggYSBieXRlLWlkZW50aWNhbCByZXNwb25zZS4gVGhpcmQgc3BlbGwgb24gdGhpcyBzaGFwZVxuICAvLyAoaW1hZ28gNWU2YWFjZCwgZ2xhbW91ciAzNGU4YWIyKSwgc28gaXQgaXMgYSBob3VzZSBwYXR0ZXJuIG5vdy5cbiAgdHlwZSBBZ2VudFZlcmRpY3QgPVxuICAgIHwgYm9vbGVhblxuICAgIHwgeyByZWNvZ25pc2VkOiB0cnVlOyBvazogdHJ1ZTsgZGV0YWlsOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB9XG4gICAgfCB7IHJlY29nbmlzZWQ6IHRydWU7IG9rOiBmYWxzZTsgc3RhdHVzOiBudW1iZXI7IGVycm9yOiBzdHJpbmcgfTtcbiAgZnVuY3Rpb24gaGFuZGxlQWdlbnRNc2cocmF3OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IEFnZW50VmVyZGljdCB7XG4gICAgY29uc3QgbXNnID0gcmF3IGFzIEFnZW50Q29tbWFuZDtcbiAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XG4gICAgICBjYXNlIFwiaW5pdFwiOlxuICAgICAgICBpZiAodHlwZW9mIG1zZy50aXRsZSA9PT0gXCJzdHJpbmdcIikgc3RhdGUudGl0bGUgPSBtc2cudGl0bGU7XG4gICAgICAgIGlmICh0eXBlb2YgbXNnLmludGVudCA9PT0gXCJzdHJpbmdcIikgc2V0SW50ZW50KHN0YXRlLCBtc2cuaW50ZW50KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwic2F5XCI6XG4gICAgICAgIGlmICh0eXBlb2YgbXNnLnRleHQgPT09IFwic3RyaW5nXCIgJiYgbXNnLnRleHQpIHtcbiAgICAgICAgICAvLyBBbiBvcHRpb25hbCBpbmxpbmUgQ1RBIChhIG9uZS1jbGljayBzaG9ydGN1dCBmb3IgYSBjb252ZXJzYXRpb25hbFxuICAgICAgICAgIC8vIGFjdCkgcmlkZXMgYWxvbmcgd2hlbiB0aGUgYWdlbnQgYXR0YWNoZXMgb25lLlxuICAgICAgICAgIHB1c2hNZXNzYWdlKHN0YXRlLCB7IHJvbGU6IFwiYWdlbnRcIiwga2luZDogXCJ0ZXh0XCIsIHRleHQ6IG1zZy50ZXh0LCBhY3Rpb246IG1zZy5hY3Rpb24gfSk7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJhc2tcIjpcbiAgICAgICAgaWYgKHR5cGVvZiBtc2cudGV4dCA9PT0gXCJzdHJpbmdcIiAmJiBtc2cudGV4dCkge1xuICAgICAgICAgIHB1c2hNZXNzYWdlKHN0YXRlLCB7XG4gICAgICAgICAgICByb2xlOiBcImFnZW50XCIsXG4gICAgICAgICAgICBraW5kOiBcInF1ZXN0aW9uXCIsXG4gICAgICAgICAgICB0ZXh0OiBtc2cudGV4dCxcbiAgICAgICAgICAgIG9wdGlvbnM6IEFycmF5LmlzQXJyYXkobXNnLm9wdGlvbnMpID8gbXNnLm9wdGlvbnMgOiB1bmRlZmluZWQsXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJzb3VyY2Uuc2V0XCI6XG4gICAgICAgIGlmICh0eXBlb2YgbXNnLnBhdGggPT09IFwic3RyaW5nXCIgJiYgQXJyYXkuaXNBcnJheShtc2cuc2l6ZSkpIHtcbiAgICAgICAgICBzZXRTb3VyY2Uoc3RhdGUsIHsgcGF0aDogbXNnLnBhdGgsIHNpemU6IG1zZy5zaXplLCBzaGE6IFN0cmluZyhtc2cuc2hhID8/IFwiXCIpIH0pO1xuICAgICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiZWxlbWVudHMuc2V0XCI6XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KG1zZy5lbGVtZW50cykpIHtcbiAgICAgICAgICBzZXRFbGVtZW50cyhzdGF0ZSwgbXNnLmVsZW1lbnRzIGFzIEVsZW1lbnRbXSk7XG4gICAgICAgICAgLy8gSW50YWtlIGF1dG8tc2VhbHMgdG8gU2xpY2Ugb25jZSBkaXNjb3ZlcnkgcmV0dXJucyBlbGVtZW50cyDigJQgdGhlcmUnc1xuICAgICAgICAgIC8vIG5vdGhpbmcgdG8gXCJhcHByb3ZlXCIgYWJvdXQgYSBkcm9wLCBzbyBubyB1c2VyIGdhdGUgZm9yIEludGFrZS5cbiAgICAgICAgICBpZiAoc3RhdGUucGhhc2UgPT09IFwiaW50YWtlXCIgJiYgc3RhdGUuZWxlbWVudHMubGVuZ3RoKSBhZHZhbmNlUGhhc2Uoc3RhdGUpO1xuICAgICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiZWxlbWVudC5hZGRcIjpcbiAgICAgICAgLy8gVGhlIGFnZW50IGJveGluZyBhIHJlZ2lvbiBpbmNyZW1lbnRhbGx5LiBCcm9hZGNhc3Qgc28gdGhlIHN1cmZhY2VcbiAgICAgICAgLy8gc2hvd3MgaXQ7IE5PIFNTRSAoaXQncyB0aGUgYWdlbnQncyBvd24gbW92ZSkgYW5kIE5PIGdlc3R1cmUgbWVzc2FnZVxuICAgICAgICAvLyAoYWdlbnQgZWRpdHMgYXJlbid0IFwidXNlciBnZXN0dXJlc1wiKS5cbiAgICAgICAgLy8gYjEzICsgIzg3IChmb3VydGggc3BlbGwpIOKAlCB0aGlzIGNhbGxlZCB0aGUgbXV0YXRvciBXSVRIT1VUIENBUFRVUklOR1xuICAgICAgICAvLyBpdHMgcmV0dXJuIGF0IGFsbCwgd2hpY2ggaXMgdGhlIG1vc3QgY29tcGxldGUgZHJvcCBvZiB0aGUgZmFtaWx5OiB0aGVcbiAgICAgICAgLy8gYnJvd3NlciBwYXRoIG9uZSBzY3JlZW4gZG93biBkb2VzIGBjb25zdCBlbCA9IGFkZEVsZW1lbnQoLi4uKWAgYW5kXG4gICAgICAgIC8vIHVzZXMgZWwuaWQvZWwubmFtZSwgc28gdGhlIGVsZW1lbnQncyBpZGVudGl0eSBleGlzdHMgYW5kIG9ubHkgdGhlXG4gICAgICAgIC8vIGFnZW50IHdhcyBkZW5pZWQgaXQuIEl0IGNvdWxkIG5vdCByZWZlcmVuY2UgdGhlIGJveCBpdCBoYWQganVzdFxuICAgICAgICAvLyBjcmVhdGVkLlxuICAgICAgICAvL1xuICAgICAgICAvLyBUaGUgZ3VhcmQgd2FzIHRoZSBzZWNvbmQgaGFsZjogYSBtYWxmb3JtZWQgZWxlbWVudCBmZWxsIHRocm91Z2ggdG8gdGhlXG4gICAgICAgIC8vIHRlcm1pbmFsIGByZXR1cm4gdHJ1ZWAsIHNvIFwibm90aGluZyB3YXMgYWRkZWRcIiBhbmQgXCJhZGRlZFwiIHdlcmUgdGhlXG4gICAgICAgIC8vIHNhbWUgYW5zd2VyLiBUaGF0IG9uZSBpcyBhbiBhbWJpZ3VvdXMgYWJzZW5jZSwgbm90IGEgbG9zdCB2YWx1ZS5cbiAgICAgICAgaWYgKG1zZy5lbGVtZW50ICYmIEFycmF5LmlzQXJyYXkobXNnLmVsZW1lbnQuYmJveCkpIHtcbiAgICAgICAgICBjb25zdCBlbCA9IGFkZEVsZW1lbnQoc3RhdGUsIG1zZy5lbGVtZW50KTtcbiAgICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICByZWNvZ25pc2VkOiB0cnVlLFxuICAgICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgICBkZXRhaWw6IHsgaWQ6IGVsLmlkLCBuYW1lOiBlbC5uYW1lLCBvdXRjb21lOiBcImNyZWF0ZWRcIiB9LFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICByZWNvZ25pc2VkOiB0cnVlLFxuICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICBzdGF0dXM6IDQwMCxcbiAgICAgICAgICBlcnJvcjpcbiAgICAgICAgICAgIFwiZWxlbWVudC5hZGQgcmVxdWlyZXMgYGVsZW1lbnRgIHdpdGggYSBgYmJveGAgYXJyYXkg4oCUIG5vdGhpbmcgd2FzIGFkZGVkIFwiICtcbiAgICAgICAgICAgIFwiKHRoZSBlbGVtZW50IGlzIHVuY2hhbmdlZCBhbmQgbm8gaWQgd2FzIG1pbnRlZClcIixcbiAgICAgICAgfTtcbiAgICAgIGNhc2UgXCJlbGVtZW50LnVwZGF0ZVwiOlxuICAgICAgICAvLyBQYXJ0aWFsLW1lcmdlIG9mIG5hbWUvdHlwZS9iYm94L3N0YXR1cy4gVmVyc2lvbiByZXN1bHRzIGRvIE5PVCBjb21lXG4gICAgICAgIC8vIHRocm91Z2ggaGVyZSDigJQgdGhleSBhcHBlbmQgdmlhIGVsZW1lbnQuYWRkVmVyc2lvbiAoYSBsaXN0IG9wKS5cbiAgICAgICAgaWYgKHR5cGVvZiBtc2cuaWQgPT09IFwic3RyaW5nXCIgJiYgbXNnLnBhdGNoICYmIHVwZGF0ZUVsZW1lbnQoc3RhdGUsIG1zZy5pZCwgbXNnLnBhdGNoKSkge1xuICAgICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiZWxlbWVudC5yZW1vdmVcIjpcbiAgICAgICAgLy8gVGhlIGFnZW50IHJldHJhY3RpbmcgYSBib3guIEJyb2FkY2FzdDsgTk8gU1NFLlxuICAgICAgICBpZiAodHlwZW9mIG1zZy5pZCA9PT0gXCJzdHJpbmdcIiAmJiByZW1vdmVFbGVtZW50KHN0YXRlLCBtc2cuaWQpKSB7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJlbGVtZW50LmFkZFZlcnNpb25cIjpcbiAgICAgICAgLy8gVGhlIGFnZW50IHBvc3RpbmcgYSBwcm9kdWNlZCB2ZXJzaW9uIChjcm9wIG9yIHJlbW92YWwgcmVzdWx0KS4gQXBwZW5kXG4gICAgICAgIC8vICh1cHNlcnQgYnkgbW9kZWwpICsgYnJvYWRjYXN0OyBOTyBTU0UgKGl0J3MgdGhlIGFnZW50J3Mgb3duIG91dHB1dCkuXG4gICAgICAgIGlmIChcbiAgICAgICAgICB0eXBlb2YgbXNnLmlkID09PSBcInN0cmluZ1wiICYmXG4gICAgICAgICAgbXNnLnZlcnNpb24gJiZcbiAgICAgICAgICBhZGRWZXJzaW9uKHN0YXRlLCBtc2cuaWQsIG1zZy52ZXJzaW9uLCB7IGNob29zZTogbXNnLmNob29zZSA/PyB0cnVlIH0pXG4gICAgICAgICkge1xuICAgICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwicGhhc2Uuc2V0XCI6XG4gICAgICAgIC8vIFRoZSBhZ2VudCBhZHZhbmNpbmcvbW92aW5nIHRoZSBjdXJzb3Igb24gdGhlIHVzZXIncyBjb252ZXJzYXRpb25hbFxuICAgICAgICAvLyByZXF1ZXN0IChcImxvb2tzIGdvb2QsIGxldCdzIGdvXCIpLiBBZ2VudC1kcml2ZW4g4oaSIGJyb2FkY2FzdCBvbmx5LlxuICAgICAgICBpZiAodHlwZW9mIG1zZy5waGFzZSA9PT0gXCJzdHJpbmdcIiAmJiBzZXRQaGFzZShzdGF0ZSwgbXNnLnBoYXNlIGFzIFBoYXNlS2V5KSkge1xuICAgICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiYnVuZGxlLnNldFwiOlxuICAgICAgICAvLyBUaGUgYWdlbnQgcG9zdGluZyB0aGUgYnVpbHQgZXhwb3J0IGJ1bmRsZSAoYWZ0ZXIgemlwcGluZykuIEJyb2FkY2FzdCBzb1xuICAgICAgICAvLyB0aGUgRXhwb3J0IHZpZXcgb2ZmZXJzIHRoZSBkb3dubG9hZDsgTk8gU1NFIChhZ2VudCdzIG93biBvdXRwdXQpLlxuICAgICAgICBpZiAodHlwZW9mIG1zZy5uYW1lID09PSBcInN0cmluZ1wiICYmIHR5cGVvZiBtc2cuY291bnQgPT09IFwibnVtYmVyXCIpIHtcbiAgICAgICAgICBzZXRCdW5kbGUoc3RhdGUsIG1zZy5uYW1lLCBtc2cuY291bnQpO1xuICAgICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwic3RhdHVzXCI6XG4gICAgICAgIHNldFN0YXR1cyhzdGF0ZSwgbXNnLmJ1c3kgPT09IHRydWUsIHR5cGVvZiBtc2cudGV4dCA9PT0gXCJzdHJpbmdcIiA/IG1zZy50ZXh0IDogXCJcIik7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImNsb3NlXCI6XG4gICAgICAgIHJlc29sdmVEb25lKHsgY29kZTogMCwgcmVhc29uOiBcImNsb3NlXCIgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgcmV0dXJuIGZhbHNlOyAvLyB1bnJlY29nbmlzZWQgdHlwZSDigJQgdGhlIG1pc3NpbmcgYGRlZmF1bHQ6YCBpcyB0aGUgZGVmZWN0XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgLy8g4pSA4pSAIGJyb3dzZXIgbWVzc2FnZXMgKFdlYlNvY2tldCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIGZ1bmN0aW9uIGhhbmRsZUJyb3dzZXJNc2cocmF3OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICAgIGNvbnN0IG1zZyA9IHJhdyBhcyBDbGllbnRUb1NlcnZlcjtcbiAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XG4gICAgICBjYXNlIFwic2F5XCI6XG4gICAgICAgIGlmICh0eXBlb2YgbXNnLnRleHQgIT09IFwic3RyaW5nXCIgfHwgIW1zZy50ZXh0KSByZXR1cm47XG4gICAgICAgIHB1c2hNZXNzYWdlKHN0YXRlLCB7IHJvbGU6IFwidXNlclwiLCBraW5kOiBcInRleHRcIiwgdGV4dDogbXNnLnRleHQgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGVtaXRFdmVudCh7IHR5cGU6IFwic2F5XCIsIHRleHQ6IG1zZy50ZXh0IH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJzb3VyY2UuaW1wb3J0XCI6IHtcbiAgICAgICAgLy8gVGhlIHVzZXIgZHJvcHBlZCBhIGNvbXBvc2l0ZS4gTWF0ZXJpYWxpemUgaXQgb250byB0aGUgc2Vzc2lvbiBmaWxlc1xuICAgICAgICAvLyBkaXIgb2ZmLXRocmVhZCAoZGVjb2RlL21ldGFkYXRhIGlzIGFzeW5jKSwgdGhlbiBzZXQgc291cmNlICsgZW1pdCB0aGVcbiAgICAgICAgLy8gaW1wZXJhdGl2ZSB0aGUgYWdlbnQgcnVucyBkaXNjb3ZlciBvbi4gRmFpbHVyZSBsb2dzIHRvIHN0ZGVycjsgbmV2ZXJcbiAgICAgICAgLy8gY3Jhc2hlcyB0aGUgZGFlbW9uLlxuICAgICAgICBpZiAodHlwZW9mIG1zZy5uYW1lICE9PSBcInN0cmluZ1wiIHx8IHR5cGVvZiBtc2cuZGF0YVVybCAhPT0gXCJzdHJpbmdcIikgcmV0dXJuO1xuICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHNvdXJjZSA9IGF3YWl0IG1hdGVyaWFsaXplU291cmNlKHNlc3Npb25GaWxlc0RpciwgbXNnLm5hbWUsIG1zZy5kYXRhVXJsKTtcbiAgICAgICAgICAgIHNldFNvdXJjZShzdGF0ZSwgc291cmNlKTtcbiAgICAgICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgICAgICBlbWl0RXZlbnQoe1xuICAgICAgICAgICAgICB0eXBlOiBcInNvdXJjZS5hZGRlZFwiLFxuICAgICAgICAgICAgICBwYXRoOiBzb3VyY2UucGF0aCxcbiAgICAgICAgICAgICAgc2l6ZTogc291cmNlLnNpemUsXG4gICAgICAgICAgICAgIHNoYTogc291cmNlLnNoYSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgICBgbWFncGllOiBzb3VyY2UuaW1wb3J0IGZhaWxlZDogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuYCxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICB9KSgpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJlbGVtZW50LmFkZFwiOiB7XG4gICAgICAgIC8vIFRoZSB1c2VyIGRyZXcgYSBtaXNzZWQgcmVnaW9uIOKAlCBhbWJpZW50IGVkaXRpbmcgb2YgdGhlIGJyZWFrZG93bi5cbiAgICAgICAgLy8gTWF0ZXJpYWxpemUgaXQgKyBsb2cgdGhlIGdlc3R1cmU7IGRvIE5PVCBwdXNoIHRoZSBhZ2VudDogaXQgcGlja3MgdGhlXG4gICAgICAgIC8vIG5ldyBib3ggdXAgZnJvbSAvc3RhdGUgd2hlbiBhIGN1dCBhY3R1YWxseSBmaXJlcy5cbiAgICAgICAgaWYgKCFtc2cuZWxlbWVudCB8fCAhQXJyYXkuaXNBcnJheShtc2cuZWxlbWVudC5iYm94KSkgcmV0dXJuO1xuICAgICAgICBjb25zdCBlbCA9IGFkZEVsZW1lbnQoc3RhdGUsIG1zZy5lbGVtZW50KTtcbiAgICAgICAgcHVzaE1lc3NhZ2Uoc3RhdGUsIHtcbiAgICAgICAgICByb2xlOiBcInVzZXJcIixcbiAgICAgICAgICBraW5kOiBcImdlc3R1cmVcIixcbiAgICAgICAgICB0ZXh0OiBgZHJldyAke2VsLm5hbWV9YCxcbiAgICAgICAgICBnZXN0dXJlOiB7IGtpbmQ6IFwiZHJhd1wiLCB0YXJnZXRJZDogZWwuaWQgfSxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImVsZW1lbnQudXBkYXRlXCI6IHtcbiAgICAgICAgLy8gTW92ZSAvIHJlc2l6ZSAvIHJlbmFtZSAvIHJldHlwZSDigJQgYW1iaWVudCBlZGl0aW5nIG9mIHRoZSBicmVha2Rvd24sIE5PVFxuICAgICAgICAvLyBwdXNoZWQgdG8gdGhlIGFnZW50IChpdCByZWFkcyB0aGUgbGF0ZXN0IGJveGVzIGZyb20gL3N0YXRlIGF0IGN1dCB0aW1lKS5cbiAgICAgICAgLy8gQSBnZXN0dXJlIE1lc3NhZ2UgbGFuZHMgT05MWSBvbiBhIHJlbmFtZS9yZXR5cGU7IHB1cmUgYmJveCBtb3ZlcyBhcmUgdG9vXG4gICAgICAgIC8vIG5vaXN5IGV2ZW4gZm9yIHRoZSB0aHJlYWQgKHRoZXkgbGVhdmUgbm8gbWVzc2FnZSkuXG4gICAgICAgIGlmICh0eXBlb2YgbXNnLmlkICE9PSBcInN0cmluZ1wiIHx8ICFtc2cucGF0Y2gpIHJldHVybjtcbiAgICAgICAgaWYgKCF1cGRhdGVFbGVtZW50KHN0YXRlLCBtc2cuaWQsIG1zZy5wYXRjaCkpIHJldHVybjtcbiAgICAgICAgY29uc3QgcmVuYW1lZCA9IHR5cGVvZiBtc2cucGF0Y2gubmFtZSA9PT0gXCJzdHJpbmdcIjtcbiAgICAgICAgY29uc3QgcmV0eXBlZCA9IHR5cGVvZiBtc2cucGF0Y2gudHlwZSA9PT0gXCJzdHJpbmdcIjtcbiAgICAgICAgaWYgKHJlbmFtZWQgfHwgcmV0eXBlZCkge1xuICAgICAgICAgIGNvbnN0IGVsID0gc3RhdGUuZWxlbWVudHMuZmluZCgoZSkgPT4gZS5pZCA9PT0gbXNnLmlkKTtcbiAgICAgICAgICBjb25zdCB0ZXh0ID0gcmVuYW1lZFxuICAgICAgICAgICAgPyBgcmVuYW1lZCAke2VsPy5uYW1lID8/IG1zZy5pZH1gXG4gICAgICAgICAgICA6IGByZXR5cGVkICR7ZWw/Lm5hbWUgPz8gbXNnLmlkfSDihpIgJHttc2cucGF0Y2gudHlwZX1gO1xuICAgICAgICAgIHB1c2hNZXNzYWdlKHN0YXRlLCB7XG4gICAgICAgICAgICByb2xlOiBcInVzZXJcIixcbiAgICAgICAgICAgIGtpbmQ6IFwiZ2VzdHVyZVwiLFxuICAgICAgICAgICAgdGV4dCxcbiAgICAgICAgICAgIGdlc3R1cmU6IHsga2luZDogcmVuYW1lZCA/IFwicmVuYW1lXCIgOiBcInJldHlwZVwiLCB0YXJnZXRJZDogbXNnLmlkIH0sXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiZWxlbWVudC5yZW1vdmVcIjoge1xuICAgICAgICAvLyBIYXJkLWRlbGV0ZSBhIGJveCDigJQgYW1iaWVudCBlZGl0aW5nLCBub3QgcHVzaGVkIHRvIHRoZSBhZ2VudCAoYSByZW1vdmVkXG4gICAgICAgIC8vIGJveCBpcyBzaW1wbHkgYWJzZW50IGZyb20gL3N0YXRlIGF0IGN1dCB0aW1lKS4gQ2FwdHVyZSB0aGUgbmFtZSBmaXJzdFxuICAgICAgICAvLyBmb3IgdGhlIGdlc3R1cmUgbWVzc2FnZS5cbiAgICAgICAgaWYgKHR5cGVvZiBtc2cuaWQgIT09IFwic3RyaW5nXCIpIHJldHVybjtcbiAgICAgICAgY29uc3QgbmFtZSA9IHN0YXRlLmVsZW1lbnRzLmZpbmQoKGUpID0+IGUuaWQgPT09IG1zZy5pZCk/Lm5hbWUgPz8gbXNnLmlkO1xuICAgICAgICBpZiAoIXJlbW92ZUVsZW1lbnQoc3RhdGUsIG1zZy5pZCkpIHJldHVybjtcbiAgICAgICAgcHVzaE1lc3NhZ2Uoc3RhdGUsIHtcbiAgICAgICAgICByb2xlOiBcInVzZXJcIixcbiAgICAgICAgICBraW5kOiBcImdlc3R1cmVcIixcbiAgICAgICAgICB0ZXh0OiBgcmVtb3ZlZCAke25hbWV9YCxcbiAgICAgICAgICBnZXN0dXJlOiB7IGtpbmQ6IFwicmVtb3ZlXCIsIHRhcmdldElkOiBtc2cuaWQgfSxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImVsZW1lbnQuanVkZ2VcIjoge1xuICAgICAgICAvLyBDb25maXJtIC8gZHJvcCAvIHJlc3RvcmUgYW4gZWxlbWVudCDigJQgYW1iaWVudCBlZGl0aW5nLCBub3QgcHVzaGVkIHRvIHRoZVxuICAgICAgICAvLyBhZ2VudCAoZHJvcHBlZCBib3hlcyBhcmUgc2tpcHBlZCBhdCBjdXQgdGltZSwgcmVhZCBmcm9tIC9zdGF0ZSkuXG4gICAgICAgIGlmICh0eXBlb2YgbXNnLmlkICE9PSBcInN0cmluZ1wiKSByZXR1cm47XG4gICAgICAgIGlmICghanVkZ2VFbGVtZW50KHN0YXRlLCBtc2cuaWQsIG1zZy5zdGF0dXMgYXMgRWxlbWVudFN0YXR1cykpIHJldHVybjtcbiAgICAgICAgY29uc3QgZWwgPSBzdGF0ZS5lbGVtZW50cy5maW5kKChlKSA9PiBlLmlkID09PSBtc2cuaWQpO1xuICAgICAgICBwdXNoTWVzc2FnZShzdGF0ZSwge1xuICAgICAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgICAgIGtpbmQ6IFwiZ2VzdHVyZVwiLFxuICAgICAgICAgIHRleHQ6IGBqdWRnZWQgJHtlbD8ubmFtZSA/PyBtc2cuaWR9OiAke21zZy5zdGF0dXN9YCxcbiAgICAgICAgICBnZXN0dXJlOiB7IGtpbmQ6IFwianVkZ2VcIiwgdGFyZ2V0SWQ6IG1zZy5pZCB9LFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiZXh0cmFjdFwiOiB7XG4gICAgICAgIC8vIFRoZSB1c2VyIGFza2VkIHRvIGN1dCBzbGljZXMgZm9yIHRoZSBjb25maXJtZWQgZWxlbWVudHMgKG9yIGEgc3Vic2V0LFxuICAgICAgICAvLyBvbiByZS1jdXQpLiBUaGUgZGFlbW9uIHN0YXlzIHRoaW4g4oCUIGl0IGRvZXMgTk9UIHNwYXduIHB5dGhvbjsgaXQgaGFuZHNcbiAgICAgICAgLy8gdGhlIGFnZW50IHRoZSBpbXBlcmF0aXZlIChsaWtlIGRpc2NvdmVyLCB3aXRoIHRoZSBzdWJzZXQgaWRzKSBhbmQgdGhlXG4gICAgICAgIC8vIGFnZW50IHJ1bnMgdGhlIGN1dCBsb29wLCBwb3N0aW5nIGVhY2ggcmVzdWx0IGJhY2sgdmlhIGVsZW1lbnQuYWRkVmVyc2lvbi5cbiAgICAgICAgY29uc3QgaWRzID0gQXJyYXkuaXNBcnJheShtc2cuaWRzKSA/IG1zZy5pZHMgOiB1bmRlZmluZWQ7XG4gICAgICAgIGNvbnN0IG4gPSBpZHMgPyBpZHMubGVuZ3RoIDogc3RhdGUuZWxlbWVudHMuZmlsdGVyKChlKSA9PiBlLnN0YXR1cyAhPT0gXCJkcm9wcGVkXCIpLmxlbmd0aDtcbiAgICAgICAgcHVzaE1lc3NhZ2Uoc3RhdGUsIHtcbiAgICAgICAgICByb2xlOiBcInVzZXJcIixcbiAgICAgICAgICBraW5kOiBcImdlc3R1cmVcIixcbiAgICAgICAgICB0ZXh0OiBgYXNrZWQgdG8gY3V0ICR7bn0gc2xpY2Uke24gPT09IDEgPyBcIlwiIDogXCJzXCJ9YCxcbiAgICAgICAgICBnZXN0dXJlOiB7IGtpbmQ6IFwiZXh0cmFjdFwiIH0sXG4gICAgICAgIH0pO1xuICAgICAgICAvLyBTaG93IHRoZSB3b3JraW5nIHNpZ25hbCBJTU1FRElBVEVMWSDigJQgd2l0aG91dCB0aGlzIHRoZSBzcGlubmVyIG9ubHlcbiAgICAgICAgLy8gYXBwZWFycyBvbmNlIHRoZSBhZ2VudCBwaWNrcyB1cCB0aGUgU1NFIGV2ZW50IGFuZCBzdGFydHMgaXRzIGN1dCBsb29wXG4gICAgICAgIC8vIChzZWNvbmRzIGxhdGVyKSwgc28gdGhlIGNsaWNrIGZlZWxzIGxpa2UgaXQgZGlkIG5vdGhpbmcuIFRoZSBhZ2VudCdzXG4gICAgICAgIC8vIGN1dCBsb29wIGNsZWFycyBpdCAoc3RhdHVzIGJ1c3k6ZmFsc2UpIHdoZW4gdGhlIGN1dHMgbGFuZC5cbiAgICAgICAgc2V0U3RhdHVzKHN0YXRlLCB0cnVlLCBgUmUtc2xpY2luZyAke259IHNsaWNlJHtuID09PSAxID8gXCJcIiA6IFwic1wifeKApmApO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcImV4dHJhY3RcIiwgaWRzIH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJlbGVtZW50LmZsYWdcIjoge1xuICAgICAgICAvLyBGbGFnIC8gdW5mbGFnIGZvciBhIHJlLXJ1biDigJQgYW1iaWVudCBib29ra2VlcGluZywgTk9UIHB1c2hlZCB0byB0aGVcbiAgICAgICAgLy8gYWdlbnQuIFRoZSBhZ2VudCBsZWFybnMgd2hpY2ggdG8gcmUtcnVuIGZyb20gdGhlIGV4dHJhY3QvcmVtb3ZlQmcvXG4gICAgICAgIC8vIHJldHJ5UmVtb3ZhbCBpbXBlcmF0aXZlICh0aGUgdXNlcidzIFwiZG8gaXRcIiBjbGljayksIG5vdCBlYWNoIGZsYWcgdG9nZ2xlLlxuICAgICAgICBpZiAodHlwZW9mIG1zZy5pZCAhPT0gXCJzdHJpbmdcIikgcmV0dXJuO1xuICAgICAgICBjb25zdCBmbGFnZ2VkID0gbXNnLmZsYWdnZWQgPT09IHRydWU7XG4gICAgICAgIGlmICghZmxhZ0VsZW1lbnQoc3RhdGUsIG1zZy5pZCwgZmxhZ2dlZCkpIHJldHVybjtcbiAgICAgICAgY29uc3QgZWwgPSBzdGF0ZS5lbGVtZW50cy5maW5kKChlKSA9PiBlLmlkID09PSBtc2cuaWQpO1xuICAgICAgICBwdXNoTWVzc2FnZShzdGF0ZSwge1xuICAgICAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgICAgIGtpbmQ6IFwiZ2VzdHVyZVwiLFxuICAgICAgICAgIHRleHQ6IGZsYWdnZWQgPyBgZmxhZ2dlZCAke2VsPy5uYW1lID8/IG1zZy5pZH1gIDogYHVuZmxhZ2dlZCAke2VsPy5uYW1lID8/IG1zZy5pZH1gLFxuICAgICAgICAgIGdlc3R1cmU6IHsga2luZDogXCJmbGFnXCIsIHRhcmdldElkOiBtc2cuaWQgfSxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInZlcnNpb24uY2hvb3NlXCI6XG4gICAgICAgIC8vIFBpY2tpbmcgd2hpY2ggdmVyc2lvbiBpcyBjaG9zZW4g4oCUIGFuIGFtYmllbnQgcHJldmlldy9wcmVmZXJlbmNlIHRvZ2dsZSxcbiAgICAgICAgLy8gbGlrZSBiYWNrZHJvcC5zZXQ6IHRvbyBmcmVxdWVudCArIGxvdy1zaWduYWwgdG8gbG9nIGluIHRoZSB0aHJlYWQsIGFuZFxuICAgICAgICAvLyBuZXZlciBwdXNoZWQgdG8gdGhlIGFnZW50LiBKdXN0IG11dGF0ZSArIGJyb2FkY2FzdC5cbiAgICAgICAgaWYgKHR5cGVvZiBtc2cuaWQgIT09IFwic3RyaW5nXCIgfHwgdHlwZW9mIG1zZy52ZXJzaW9uSWQgIT09IFwic3RyaW5nXCIpIHJldHVybjtcbiAgICAgICAgaWYgKGNob29zZVZlcnNpb24oc3RhdGUsIG1zZy5pZCwgbXNnLnZlcnNpb25JZCkpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInJlbW92ZUJnXCI6IHtcbiAgICAgICAgLy8gSW1wZXJhdGl2ZTogcmVtb3ZlIGJhY2tncm91bmRzIGZvciB0aGVzZSAob3IgYWxsIGVsaWdpYmxlKSBlbGVtZW50cy4gVGhlXG4gICAgICAgIC8vIGFnZW50IHBpY2tzIHRoZSBtb2RlbCArIHJ1bnMgaXQuIEZsaXAgYnVzeSBpbW1lZGlhdGVseSAodGhlIGFmZm9yZGFuY2UpLlxuICAgICAgICBjb25zdCBpZHMgPSBBcnJheS5pc0FycmF5KG1zZy5pZHMpID8gbXNnLmlkcyA6IHVuZGVmaW5lZDtcbiAgICAgICAgY29uc3QgbiA9IGlkcyA/IGlkcy5sZW5ndGggOiBzdGF0ZS5lbGVtZW50cy5maWx0ZXIoKGUpID0+IGUuc3RhdHVzICE9PSBcImRyb3BwZWRcIikubGVuZ3RoO1xuICAgICAgICBwdXNoTWVzc2FnZShzdGF0ZSwge1xuICAgICAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgICAgIGtpbmQ6IFwiZ2VzdHVyZVwiLFxuICAgICAgICAgIHRleHQ6IGBhc2tlZCB0byByZW1vdmUgJHtufSBiYWNrZ3JvdW5kJHtuID09PSAxID8gXCJcIiA6IFwic1wifWAsXG4gICAgICAgICAgZ2VzdHVyZTogeyBraW5kOiBcInJlbW92ZUJnXCIgfSxcbiAgICAgICAgfSk7XG4gICAgICAgIHNldFN0YXR1cyhzdGF0ZSwgdHJ1ZSwgYFJlbW92aW5nICR7bn0gYmFja2dyb3VuZCR7biA9PT0gMSA/IFwiXCIgOiBcInNcIn3igKZgKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJyZW1vdmVCZ1wiLCBpZHMgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInJldHJ5UmVtb3ZhbFwiOiB7XG4gICAgICAgIC8vIEltcGVyYXRpdmU6IFwidHJ5IGEgZGlmZmVyZW50IHJlbW92YWxcIiBvbiB0aGVzZSBmbGFnZ2VkIGl0ZW1zLiBQYXlsb2FkIGlzXG4gICAgICAgIC8vIGlkcyBPTkxZIOKAlCB0aGUgYWdlbnQgcGlja3MgYW4gdW51c2VkIG1vZGVsLiBGbGlwIGJ1c3kgaW1tZWRpYXRlbHkuXG4gICAgICAgIGNvbnN0IGlkcyA9IEFycmF5LmlzQXJyYXkobXNnLmlkcykgPyBtc2cuaWRzIDogW107XG4gICAgICAgIGlmICghaWRzLmxlbmd0aCkgcmV0dXJuO1xuICAgICAgICBwdXNoTWVzc2FnZShzdGF0ZSwge1xuICAgICAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgICAgIGtpbmQ6IFwiZ2VzdHVyZVwiLFxuICAgICAgICAgIHRleHQ6IGBhc2tlZCB0byB0cnkgYSBkaWZmZXJlbnQgcmVtb3ZhbCBvbiAke2lkcy5sZW5ndGh9YCxcbiAgICAgICAgICBnZXN0dXJlOiB7IGtpbmQ6IFwicmV0cnlSZW1vdmFsXCIgfSxcbiAgICAgICAgfSk7XG4gICAgICAgIHNldFN0YXR1cyhzdGF0ZSwgdHJ1ZSwgYFRyeWluZyBhIGRpZmZlcmVudCByZW1vdmFsIG9uICR7aWRzLmxlbmd0aH3igKZgKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJyZXRyeVJlbW92YWxcIiwgaWRzIH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJiYWNrZHJvcC5zZXRcIjpcbiAgICAgICAgLy8gYW1iaWVudCBwcmV2aWV3IHN0YXRlIOKAlCBubyBhZ2VudCBldmVudC5cbiAgICAgICAgaWYgKHNldEJhY2tkcm9wKHN0YXRlLCBtc2cuYmFja2Ryb3AgYXMgQmFja2Ryb3ApKSBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJwaGFzZS5hZHZhbmNlXCI6IHtcbiAgICAgICAgLy8gVGhlIHVzZXIgc2VhbGluZyB0aGUgYWN0aXZlIHBoYXNlIOKAlCBhbiBpbXBlcmF0aXZlIGhhbmQtb2ZmLiBBZHZhbmNlIHRoZVxuICAgICAgICAvLyBjdXJzb3IgKyB0ZWxsIHRoZSBhZ2VudCB3aGVyZSB3ZSBtb3ZlZCB0by4gTm8tb3AgYXQgdGhlIGxhc3QgcGhhc2UuXG4gICAgICAgIGNvbnN0IHByZXYgPSBzdGF0ZS5waGFzZTtcbiAgICAgICAgY29uc3QgbmV4dCA9IGFkdmFuY2VQaGFzZShzdGF0ZSk7XG4gICAgICAgIGlmICghbmV4dCkgcmV0dXJuO1xuICAgICAgICBwdXNoTWVzc2FnZShzdGF0ZSwge1xuICAgICAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgICAgIGtpbmQ6IFwiZ2VzdHVyZVwiLFxuICAgICAgICAgIHRleHQ6IGBzZWFsZWQgJHtwcmV2fSDihpIgJHtuZXh0fWAsXG4gICAgICAgICAgZ2VzdHVyZTogeyBraW5kOiBcInBoYXNlLmFkdmFuY2VcIiB9LFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJwaGFzZS5hZHZhbmNlXCIsIHBoYXNlOiBuZXh0IH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJwaGFzZS5zZXRcIjoge1xuICAgICAgICAvLyBCYWNrLW5hdiAvIGp1bXAg4oCUIHJlLW9wZW5zIGxhdGVyIHBoYXNlcyBmb3IgZWRpdHMuIEEgcGhhc2Ugc3dpdGNoIGlzIGFcbiAgICAgICAgLy8gZGVsaWJlcmF0ZSByZWxvY2F0aW9uIChOT1QgYW1iaWVudCBlZGl0aW5nKSwgc28gaXQgSVMgcHVzaGVkIHRvIHRoZVxuICAgICAgICAvLyBhZ2VudCBhcyBjb250ZXh0IGZvciB3aGF0J3MgY29taW5nIChyZS1jdXRzIGxpa2VseSkg4oCUIGV2ZW4gdGhvdWdoXG4gICAgICAgIC8vIHRoZXJlJ3Mgbm8gYWN0aW9uIHRvIHRha2UuIFJhcmUgZW5vdWdoIHRvIG5ldmVyIGJlIHNwYW1teS5cbiAgICAgICAgaWYgKHR5cGVvZiBtc2cucGhhc2UgIT09IFwic3RyaW5nXCIpIHJldHVybjtcbiAgICAgICAgaWYgKCFzZXRQaGFzZShzdGF0ZSwgbXNnLnBoYXNlIGFzIFBoYXNlS2V5KSkgcmV0dXJuO1xuICAgICAgICBwdXNoTWVzc2FnZShzdGF0ZSwge1xuICAgICAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgICAgIGtpbmQ6IFwiZ2VzdHVyZVwiLFxuICAgICAgICAgIHRleHQ6IGBzdGVwcGVkIHRvICR7bXNnLnBoYXNlfWAsXG4gICAgICAgICAgZ2VzdHVyZTogeyBraW5kOiBcInBoYXNlLnNldFwiLCB0YXJnZXRJZDogbXNnLnBoYXNlIH0sXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcInBoYXNlLnNldFwiLCBwaGFzZTogbXNnLnBoYXNlIH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJleHBvcnRcIjoge1xuICAgICAgICAvLyBUaGUgdXNlciBhc2tlZCB0byBidWlsZCB0aGUgZG93bmxvYWRhYmxlIGJ1bmRsZS4gRmxpcCBidXN5ICsgZW1pdCB0byB0aGVcbiAgICAgICAgLy8gYWdlbnQsIHdoaWNoIHppcHMgdGhlIGNob3NlbiBhc3NldHMgb3V0IG9mIGJhbmQgdGhlbiBwb3N0cyBidW5kbGUuc2V0LlxuICAgICAgICBjb25zdCBpZHMgPSBBcnJheS5pc0FycmF5KG1zZy5pZHMpID8gbXNnLmlkcyA6IHVuZGVmaW5lZDtcbiAgICAgICAgY29uc3QgbiA9IGlkcyA/IGlkcy5sZW5ndGggOiBzdGF0ZS5lbGVtZW50cy5maWx0ZXIoKGUpID0+IGUuc3RhdHVzICE9PSBcImRyb3BwZWRcIikubGVuZ3RoO1xuICAgICAgICBwdXNoTWVzc2FnZShzdGF0ZSwge1xuICAgICAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgICAgIGtpbmQ6IFwiZ2VzdHVyZVwiLFxuICAgICAgICAgIHRleHQ6IGBhc2tlZCB0byBleHBvcnQgJHtufSBhc3NldCR7biA9PT0gMSA/IFwiXCIgOiBcInNcIn1gLFxuICAgICAgICAgIGdlc3R1cmU6IHsga2luZDogXCJleHBvcnRcIiB9LFxuICAgICAgICB9KTtcbiAgICAgICAgc2V0U3RhdHVzKHN0YXRlLCB0cnVlLCBgQnVpbGRpbmcgYnVuZGxlICgke259IGFzc2V0JHtuID09PSAxID8gXCJcIiA6IFwic1wifSnigKZgKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJleHBvcnRcIiwgaWRzIH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzdWJtaXRcIjpcbiAgICAgICAgYnJvYWRjYXN0KHsgdHlwZTogXCJzdWJtaXRcIiB9KTtcbiAgICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJzdWJtaXRcIiB9KTtcbiAgICAgICAgcmVzb2x2ZURvbmUoeyBjb2RlOiAwLCByZWFzb246IFwic3VibWl0XCIgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImNhbmNlbFwiOlxuICAgICAgICBicm9hZGNhc3QoeyB0eXBlOiBcImNhbmNlbFwiIH0pO1xuICAgICAgICByZXNvbHZlRG9uZSh7IGNvZGU6IDEzMCwgcmVhc29uOiBcImNhbmNlbFwiIH0pO1xuICAgICAgICBicmVhaztcbiAgICB9XG4gIH1cblxuICAvLyBHRVQgL2V2ZW50cz9zaW5jZT08aWQ+IOKAlCByZXBsYXksIHRoZW4gc3RheSBvcGVuIGZvciBsaXZlIGZyYW1lcyBwbHVzIGFcbiAgLy8gaGVhcnRiZWF0IGNvbW1lbnQuIEFuIG9wZW4gdGFpbCBJUyBhZ2VudCBwcmVzZW5jZSBmb3IgdGhlIGJyb3dzZXJzLCBhbmQgaXRcbiAgLy8gcmlkZXMgdGhlIGtpdCdzIG9wZW4vY2xvc2UgaG9va3MsIHdoaWNoIGZpcmUgZXhhY3RseSBvbmNlIGVhY2gg4oCUIHRoZSBmdW5uZWxcbiAgLy8gaXMgd2hhdCBib3VuZHMgcHJlc2VuY2UgYWNjdXJhY3kuXG4gIGZ1bmN0aW9uIGV2ZW50c1Jlc3BvbnNlKHJlcTogUmVxdWVzdCwgdXJsOiBVUkwpOiBSZXNwb25zZSB7XG4gICAgdG91Y2goKTtcbiAgICByZXR1cm4gc3NlUmVzcG9uc2Uoe1xuICAgICAgbG9nLFxuICAgICAgc2luY2U6IE51bWJlci5wYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInNpbmNlXCIpID8/IFwiLTFcIiwgMTApLFxuICAgICAgaGVhcnRiZWF0TXM6IFNTRV9IRUFSVEJFQVRfTVMsXG4gICAgICBjbGllbnRzOiBzc2VDbGllbnRzLFxuICAgICAgc2lnbmFsOiByZXEuc2lnbmFsLFxuICAgICAgb25PcGVuOiBicm9hZGNhc3RQcmVzZW5jZSwgLy8gYW4gYWdlbnQgdGFpbCBhdHRhY2hlZCDihpIgdGVsbCB0aGUgYnJvd3NlcnNcbiAgICAgIG9uQ2xvc2U6IGJyb2FkY2FzdFByZXNlbmNlLCAvLyB0aGUgYWdlbnQgdGFpbCBkcm9wcGVkIOKGkiB0ZWxsIHRoZSBicm93c2Vyc1xuICAgIH0pO1xuICB9XG5cbiAgbGV0IHNlc3Npb25GaWxlc0RpciA9IFwiXCI7IC8vIHNldCBvbmNlIHNlc3Npb25JZCBpcyBrbm93biAoYWZ0ZXIgYmluZClcblxuICBjb25zdCBtb2RlID0gcmVzb2x2ZU1vZGUoRElTVF9ESVIpO1xuXG4gIC8vIGRldjogdGhlIGR5bmFtaWMgc3RyaW5nLWxpdGVyYWwgaW1wb3J0IGtlZXBzIHRoZSBzdXJmYWNlIGdyYXBoIG9mZiB0aGVcbiAgLy8gbW9kdWxlIGxvYWQgcGF0aCAoQ29udHJhY3QgMSkg4oCUIEJ1biBidW5kbGVzIHRoZSAudHN4IGdyYXBoICsgVGFpbHdpbmQgYXRcbiAgLy8gc2VydmUgdGltZSwgcmVhZGluZyBidW5maWcudG9tbCBmcm9tIGN3ZCwgd2hpY2ggY2xpLnRzIHBpbnMgdG8gc3JjL21hZ3BpZS9cbiAgLy8gKENvbnRyYWN0IDUpLiBobXIgb24gZm9yIHRoZSBzdXJmYWNlIGl0ZXJhdGlvbiBsb29wLlxuICAvLyByZWxlYXNlOiBkaXN0LyBpcyBzdGF0aWMgYW5kIHByZS1idWlsdCAoQ29udHJhY3QgMikg4oCUIFwiL1wiIGlzIGFuc3dlcmVkIGJ5XG4gIC8vIHNlcnZlRGlzdCgpIGluIHRoZSBmZXRjaCBmYWxsLXRocm91Z2ggYmVsb3csIHNvIHRoaXMgYnJhbmNoIG5ldmVyIHRvdWNoZXNcbiAgLy8gc3VyZmFjZS8gb3IgYnVuZmlnLnRvbWwgYW5kIG5ldmVyIG5lZWRzIGVpdGhlciB0byBleGlzdC5cbiAgLy8gQnVuJ3MgUm91dGVzIHR5cGUgdGllcyB0aGUgXCIvXCIgdmFsdWUncyB0eXBlIHRvIHRoZSBsaXRlcmFsIG9iamVjdCBzaGFwZSwgc29cbiAgLy8gYSBtb2RlLXRlcm5hcnkgdW5pb24gY29uZnVzZXMgaXRzIG92ZXJsb2FkIHJlc29sdXRpb24g4oCUIHRoZSBydW50aW1lXG4gIC8vIGJlaGF2aW9yIChIVE1MQnVuZGxlIGluIGRldiwgYWJzZW50IGluIHJlbGVhc2UpIGlzIGNvcnJlY3QgZWl0aGVyIHdheS5cbiAgLy8g4puUIFRISVMgU1BFQ0lGSUVSIElTIFJFU09MVkVEIEZST00gYGRpc3QvYCwgTk9UIEZST00gVEhJUyBGSUxFLiBgc3JjL2J1aWxkLnRzYFxuICAvLyBwYXNzZXMgYGV4dGVybmFsYCBmb3IgdGhlIHN1cmZhY2UtSFRNTCBnbG9iLCBzbyB0aGUgYnVuZGxlciBkb2VzIG5vdCBmb2xsb3dcbiAgLy8gdGhpcyBpbXBvcnQgYW5kIGxlYXZlcyB0aGUgc3RyaW5nIGluIGBkaXN0L3NlcnZlci5qc2AgQllURS1GT1ItQllURS4gVGhlXG4gIC8vIGZpdmUgYC4uYCB0aGVyZWZvcmUgY291bnQgdXAgZnJvbVxuICAvLyBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21hZ3BpZS9kaXN0L2Ag4oCUIGRpc3Qg4oaSIG1hZ3BpZSDihpIgc2tpbGxzIOKGklxuICAvLyBzcGVsbGJvb2sg4oaSIHBsdWdpbnMg4oaSIHJlcG8gcm9vdCDigJQgYW5kIE5PVCBmcm9tIGBzcmMvbWFncGllL2JhY2tlbmQvYCwgd2hlcmVcbiAgLy8gdGhlIHNhbWUgc3RyaW5nIHdvdWxkIGNsaW1iIG91dCBvZiB0aGUgcmVwby4gUmVhZGluZyBpdCBhcyBhIG5vcm1hbFxuICAvLyByZWxhdGl2ZSBpbXBvcnQgb2YgdGhpcyBmaWxlIGlzIHRoZSBtaXN0YWtlIHRvIG1ha2UgaGVyZSwgYW5kIHJlbGVhc2UgbW9kZVxuICAvLyBuZXZlciBleGVjdXRlcyB0aGUgbGluZSwgc28gbm90aGluZyBidXQgYm9vdGluZyBhIERFViBkYWVtb24gY2FuIGNhdGNoIGl0LlxuICAvLyBgZ3JpbW9pcmUvaW1wb3J0LWJvdW5kYXJ5LXdhcmRzLnRlc3QudHNgIHBpbnMgaXQgYXQgdGhlIGVtaXR0ZWQgYWRkcmVzcyBmb3JcbiAgLy8gZXhhY3RseSB0aGF0IHJlYXNvbi5cbiAgY29uc3QgZGV2SW5kZXggPVxuICAgIG1vZGUgPT09IFwiZGV2XCJcbiAgICAgID8gKGF3YWl0IGltcG9ydChcIi4uLy4uLy4uLy4uLy4uL3NyYy9tYWdwaWUvc3VyZmFjZS9pbmRleC5odG1sXCIpKS5kZWZhdWx0XG4gICAgICA6IHVuZGVmaW5lZDtcbiAgY29uc3Qgcm91dGVzID0gKGRldkluZGV4ID8geyBcIi9cIjogZGV2SW5kZXggfSA6IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCBuZXZlcj47XG5cbiAgbGV0IHNlcnZlcjogUmV0dXJuVHlwZTx0eXBlb2YgQnVuLnNlcnZlPjtcbiAgdHJ5IHtcbiAgICBzZXJ2ZXIgPSBCdW4uc2VydmUoe1xuICAgICAgcG9ydCxcbiAgICAgIGhvc3RuYW1lOiBob3N0LFxuICAgICAgcm91dGVzLFxuICAgICAgLy8g4puUIEhFTEQgU1NFIENPTk5FQ1RJT05TIERJRSBXSVRIT1VUIFRISVMg4oCUIGFuZCB0aGUgcGFpciBvZiBudW1iZXJzIGlzXG4gICAgICAvLyBub3cgT05FIGZhY3QgaW4gYC4vaGVhcnRiZWF0LnRzYCwgaW1wb3J0ZWQgYnkgdGhpcyBkYWVtb24gYW5kIGJ5XG4gICAgICAvLyBgY2xpLnRzYCwgd2l0aCB0aGUgbWVhc3VyZW1lbnQgcmUtaG9tZWQgdG8gYGtpdC93aXJlL2hlYXJ0YmVhdC50c2AuIFRoZVxuICAgICAgLy8gaGVhcnRiZWF0IGxpdGVyYWwgdGhhdCB1c2VkIHRvIHNpdCBpbiBgc3NlUmVzcG9uc2VgIGJlbG93IChhbmQgd2FzXG4gICAgICAvLyBoYW5kLW1pcnJvcmVkIGluIHRoZSBDTEkpIGNvbWVzIGZyb20gdGhlIHNhbWUgcGxhY2UuXG4gICAgICBpZGxlVGltZW91dDogSURMRV9USU1FT1VUX1NFQyxcbiAgICAgIGRldmVsb3BtZW50OiB7IGhtcjogbW9kZSA9PT0gXCJkZXZcIiB9LFxuICAgICAgZmV0Y2g6IChyZXEsIHNydikgPT4ge1xuICAgICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwpO1xuICAgICAgICBjb25zdCBwYXRoID0gdXJsLnBhdGhuYW1lO1xuICAgICAgICBpZiAocGF0aCA9PT0gXCIvd3NcIikge1xuICAgICAgICAgIGNvbnN0IHVwZ3JhZGVkID0gc3J2LnVwZ3JhZGUocmVxKTtcbiAgICAgICAgICBpZiAodXBncmFkZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShcInVwZ3JhZGUgcmVxdWlyZWRcIiwgeyBzdGF0dXM6IDQyNiB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9zdGF0ZVwiKSB7XG4gICAgICAgICAgY29uc3QgbGVhbiA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwibGVhblwiKSA9PT0gXCIxXCI7XG4gICAgICAgICAgY29uc3QgcGF5bG9hZCA9IGxlYW4gPyBsZWFuU3RhdGUoc3RhdGUpIDogc3RhdGU7XG4gICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShKU09OLnN0cmluZ2lmeSh7IHN0YXRlOiBwYXlsb2FkLCBjdXJzb3I6IGxvZy5jdXJzb3IoKSB9KSwge1xuICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL2V2ZW50c1wiKSB7XG4gICAgICAgICAgcmV0dXJuIGV2ZW50c1Jlc3BvbnNlKHJlcSwgdXJsKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJQT1NUXCIgJiYgcGF0aCA9PT0gXCIvY21kXCIpIHtcbiAgICAgICAgICByZXR1cm4gcmVxXG4gICAgICAgICAgICAuanNvbigpXG4gICAgICAgICAgICAudGhlbigoYm9keSkgPT4ge1xuICAgICAgICAgICAgICB0b3VjaCgpO1xuICAgICAgICAgICAgICAvLyAjODQg4oCUIHByb3BhZ2F0ZSB0aGUgaGFuZGxlcidzIHZlcmRpY3QgcmF0aGVyIHRoYW4gYSBsaXRlcmFsXG4gICAgICAgICAgICAgIC8vIHtvazp0cnVlfS4gYGFwcGxpZWRgIGlzIGJvdW50eSdzIGV4aXN0aW5nIGZpZWxkOyBub3RoaW5nIG5ldy5cbiAgICAgICAgICAgICAgY29uc3QgdmVyZGljdCA9IGhhbmRsZUFnZW50TXNnKGJvZHkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pO1xuICAgICAgICAgICAgICAvLyBBIGNvbW1hbmQgdGhhdCBhbnN3ZXJlZCB3aXRoIGl0cyBvd24gcmVzdWx0IGNhcnJpZXMgaXRzIHN0YXR1c1xuICAgICAgICAgICAgICAvLyBhbmQgcGF5bG9hZDsgdGhlIGJvb2xlYW4gcGF0aCBiZWxvdyBpcyB1bmNoYW5nZWQuXG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgdmVyZGljdCA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgICAgIGlmICghdmVyZGljdC5vaylcbiAgICAgICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKFxuICAgICAgICAgICAgICAgICAgICB7IG9rOiBmYWxzZSwgYXBwbGllZDogZmFsc2UsIGVycm9yOiB2ZXJkaWN0LmVycm9yIH0sXG4gICAgICAgICAgICAgICAgICAgIHsgc3RhdHVzOiB2ZXJkaWN0LnN0YXR1cyB9LFxuICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiB0cnVlLCBhcHBsaWVkOiB0cnVlLCAuLi52ZXJkaWN0LmRldGFpbCB9KTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBjb25zdCBhcHBsaWVkID0gdmVyZGljdDtcbiAgICAgICAgICAgICAgaWYgKCFhcHBsaWVkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oXG4gICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgYXBwbGllZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIGVycm9yOiBgdW5yZWNvZ25pc2VkIGNvbW1hbmQgdHlwZSAke0pTT04uc3RyaW5naWZ5KFxuICAgICAgICAgICAgICAgICAgICAgIChib2R5IGFzIHsgdHlwZT86IHVua25vd24gfSk/LnR5cGUsXG4gICAgICAgICAgICAgICAgICAgICl9IOKAlCBub3RoaW5nIHdhcyBhcHBsaWVkYCxcbiAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICB7IHN0YXR1czogNDAwIH0sXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCd7XCJva1wiOnRydWUsXCJhcHBsaWVkXCI6dHJ1ZX0nLCB7XG4gICAgICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAuY2F0Y2goXG4gICAgICAgICAgICAgICgpID0+XG4gICAgICAgICAgICAgICAgbmV3IFJlc3BvbnNlKCd7XCJlcnJvclwiOlwiYmFkIGpzb25cIn0nLCB7XG4gICAgICAgICAgICAgICAgICBzdGF0dXM6IDQwMCxcbiAgICAgICAgICAgICAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aC5zdGFydHNXaXRoKFwiL2Fzc2V0cy9cIikpIHtcbiAgICAgICAgICAvLyBTZXJ2ZSBwZXItc2Vzc2lvbiBmaWxlcyAodGhlIHNvdXJjZSBib2FyZCwgbWF0ZXJpYWxpemVkIGN1dG91dHMpLlxuICAgICAgICAgIGNvbnN0IGFzc2V0TmFtZSA9IGRlY29kZVVSSUNvbXBvbmVudChwYXRoLnNsaWNlKFwiL2Fzc2V0cy9cIi5sZW5ndGgpKTtcbiAgICAgICAgICBpZiAoYXNzZXROYW1lLmluY2x1ZGVzKFwiLi5cIikgfHwgYXNzZXROYW1lLnN0YXJ0c1dpdGgoXCIvXCIpIHx8ICFzZXNzaW9uRmlsZXNEaXIpIHtcbiAgICAgICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoJ3tcImVycm9yXCI6XCJub3QgZm91bmRcIn0nLCB7XG4gICAgICAgICAgICAgIHN0YXR1czogNDA0LFxuICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgZiA9IEJ1bi5maWxlKGpvaW4oc2Vzc2lvbkZpbGVzRGlyLCBhc3NldE5hbWUpKTtcbiAgICAgICAgICByZXR1cm4gZi5leGlzdHMoKS50aGVuKChleGlzdHMpID0+XG4gICAgICAgICAgICBleGlzdHNcbiAgICAgICAgICAgICAgPyBuZXcgUmVzcG9uc2UoZiwgeyBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IGd1ZXNzTWltZShhc3NldE5hbWUpIH0gfSlcbiAgICAgICAgICAgICAgOiBuZXcgUmVzcG9uc2UoJ3tcImVycm9yXCI6XCJub3QgZm91bmRcIn0nLCB7XG4gICAgICAgICAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgICAgICAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIC8vIHJlbGVhc2U6IFwiL1wiIGFuZCB0aGUgaGFzaGVkIGNodW5rLSouanMvY3NzIGFyZSBzdGF0aWMgZGlzdCByZWFkcy4gRGV2XG4gICAgICAgIC8vIG5ldmVyIHJlYWNoZXMgaGVyZSBmb3IgXCIvXCIg4oCUIHRoZSByb3V0ZXMgdGFibGUgYWJvdmUgYW5zd2VycyBpdCBmaXJzdC5cbiAgICAgICAgLy8gVGhpcyBzaXRzIEFGVEVSIC9hc3NldHMvLCB3aGljaCBzZXJ2ZXMgc2Vzc2lvbiBmaWxlcywgbm90IGRpc3Qgb25lcy5cbiAgICAgICAgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgICAgY29uc3QgYXNzZXQgPSBzZXJ2ZURpc3QocGF0aCk7XG4gICAgICAgICAgaWYgKGFzc2V0KSByZXR1cm4gYXNzZXQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZSgne1wiZXJyb3JcIjpcIm5vdCBmb3VuZFwifScsIHtcbiAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgIH0pO1xuICAgICAgfSxcbiAgICAgIHdlYnNvY2tldDoge1xuICAgICAgICBvcGVuKHdzKSB7XG4gICAgICAgICAgc29ja2V0cy5hZGQod3MpO1xuICAgICAgICAgIHRvdWNoKCk7XG4gICAgICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJjb25uZWN0ZWRcIiB9KTtcbiAgICAgICAgICB3cy5zZW5kKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJzdGF0ZVwiLCBzdGF0ZSB9KSk7XG4gICAgICAgICAgd3Muc2VuZChKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwicHJlc2VuY2VcIiwgYWdlbnQ6IHNzZUNsaWVudHMuc2l6ZSA+IDAgfSkpO1xuICAgICAgICB9LFxuICAgICAgICBtZXNzYWdlKF93cywgcmF3KSB7XG4gICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICBsZXQgbXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgbXNnID0gSlNPTi5wYXJzZSh0eXBlb2YgcmF3ID09PSBcInN0cmluZ1wiID8gcmF3IDogbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHJhdykpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgICBgbWFncGllOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmAsXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBoYW5kbGVCcm93c2VyTXNnKG1zZyk7XG4gICAgICAgIH0sXG4gICAgICAgIGNsb3NlKHdzKSB7XG4gICAgICAgICAgc29ja2V0cy5kZWxldGUod3MpO1xuICAgICAgICAgIGVtaXRFdmVudCh7IHR5cGU6IFwiZGlzY29ubmVjdGVkXCIgfSk7XG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGV2ZW50OiBcImJpbmRfZXJyb3JcIixcbiAgICAgICAgaG9zdCxcbiAgICAgICAgcG9ydCxcbiAgICAgICAgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSxcbiAgICAgIH0pfVxcbmAsXG4gICAgKTtcbiAgICByZXR1cm4gMjtcbiAgfVxuXG4gIGNvbnN0IGJvdW5kUG9ydCA9IHNlcnZlci5wb3J0O1xuICBpZiAoIXNlc3Npb25JZCkgc2Vzc2lvbklkID0gYG1hZ3BpZS0ke3JhbmRIZXgoNCl9LXAke2JvdW5kUG9ydH1gO1xuICBzdGF0ZS5zZXNzaW9uSWQgPSBzZXNzaW9uSWQ7IC8vIHJ1bnRpbWU6IHN1cmZhY2UgKEV4cG9ydCByZW9wZW4gaGludCkgcmVhZHMgaXRcbiAgc2Vzc2lvbkZpbGVzRGlyID0gam9pbih0bXBkaXIoKSwgYCR7c2Vzc2lvbklkfS1maWxlc2ApO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhzZXNzaW9uRmlsZXNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIGJhY2sgdG8gbm8tZmlsZS1wYXRocyAqL1xuICB9XG4gIGlmIChyZXN0b3JlZCkgc2F2ZVNuYXBzaG90KHNlc3Npb25JZCwgc3RhdGUpO1xuXG4gIGNvbnN0IHVybCA9IGBodHRwOi8vJHtob3N0fToke2JvdW5kUG9ydH1gO1xuICAvLyBgbW9kZWAgaXMgdGhlIE9OTFkgdGhpbmcgdGhhdCBkaXNjcmltaW5hdGVzIGEgcmVsZWFzZSBkYWVtb24gZnJvbSBhIGRldlxuICAvLyBvbmU6IHdpdGggcm9vdCBkZXBzIHByZXNlbnQgYSBkZXYgZGFlbW9uIHJlbmRlcnMgYW4gaWRlbnRpY2FsLWxvb2tpbmdcbiAgLy8gc3VyZmFjZSwgc28gXCJpdCBsb29rcyByaWdodFwiIGNhbm5vdCB2ZXJpZnkgQ29udHJhY3QgMS5cbiAgZW1pdEV2ZW50KHsgdHlwZTogXCJyZWFkeVwiLCB1cmwsIHBvcnQ6IGJvdW5kUG9ydCwgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLCBtb2RlIH0pO1xuXG4gIC8vIERpc2NvdmVyeSBmaWxlcyDigJQgY2xpLnRzIHJlYWRzIHRoZSBwb3J0IGZyb20gaGVyZS5cbiAgY29uc3Qgc2Vzc2lvbkZpbGUgPSBqb2luKHRtcGRpcigpLCBgbWFncGllLSR7c2Vzc2lvbklkfS5qc29uYCk7XG4gIGNvbnN0IGxhdGVzdEZpbGUgPSBqb2luKHRtcGRpcigpLCBgbWFncGllLWxhdGVzdC5qc29uYCk7XG4gIGNvbnN0IHNlc3Npb25JbmZvID0gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHVybCxcbiAgICBwb3J0OiBib3VuZFBvcnQsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIHRpdGxlOiBzdGF0ZS50aXRsZSxcbiAgICBmaWxlc19kaXI6IHNlc3Npb25GaWxlc0RpcixcbiAgICAvLyBtYWdwaWUgd3JpdGVzIE5PIHN0ZG91dCBoYW5kc2hha2UgKG1pbmQtbWFwcGVyIGFuZCBhc3Ryb2xhYmUgZG8pIOKAlCBpdHNcbiAgICAvLyBoYW5kc2hha2UgaXMgdGhpcyBkaXNjb3ZlcnkgZmlsZSwgc28gYG1vZGVgIHJpZGVzIEJPVEggaXQgYW5kIHRoZSBTU0VcbiAgICAvLyBgcmVhZHlgIGV2ZW50OiBzYW1lIHJvbGUsIGRpZmZlcmVudCB0cmFuc3BvcnQsIGFzIGltYWdvIGRvZXMgaXQuXG4gICAgbW9kZSxcbiAgfSk7XG4gIC8vIOKaoCBBVE9NSUMsIGJlY2F1c2UgcmVhZFNlc3Npb24gdHJlYXRzIHVucGFyc2VhYmxlIGNvbnRlbnQgYXMgY29ycnVwdGlvblxuICAvLyByYXRoZXIgdGhhbiBhYnNlbmNlIOKAlCBhbmQgdGhpcyBpbXBsZW1lbnRhdGlvbiBpcyBub3cgYGtpdC93aXJlL2Rpc2NvdmVyeS50c2AsXG4gIC8vIHNoYXJlZCB3aXRoIHRoZSBzaW5nbGV0b24gY29udmVudGlvbiBEMyBrZXB0IGFsaXZlIGJlc2lkZSB0aGlzIG9uZS4gVGhlXG4gIC8vIHJlYXNvbmluZyB0cmF2ZWxsZWQgd2l0aCBpdDsgd2hhdCBzdGF5ZWQgaGVyZSBpcyB3aGljaCBmaWxlcyBtYWdwaWUgd3JpdGVzLlxuICB0cnkge1xuICAgIHdyaXRlRmlsZUF0b21pYyhzZXNzaW9uRmlsZSwgc2Vzc2lvbkluZm8pO1xuICAgIHdyaXRlRmlsZUF0b21pYyhsYXRlc3RGaWxlLCBzZXNzaW9uSW5mbyk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGBtYWdwaWU6IGNvdWxkIG5vdCB3cml0ZSBkaXNjb3ZlcnkgZmlsZTogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuYCxcbiAgICApO1xuICB9XG4gIC8vIFRoZSBzZXNzaW9uIHBvaW50ZXIgaXMgdW5jb25kaXRpb25hbGx5IG91cnM7IGBtYWdwaWUtbGF0ZXN0Lmpzb25gIGlzIE5PVCDigJRcbiAgLy8gYSBuZXdlciBzZXNzaW9uIG1heSBhbHJlYWR5IGhhdmUgY2xhaW1lZCBpdCwgYW5kIHVubGlua2luZyB0aGF0IHdvdWxkIG1ha2VcbiAgLy8gdGhlIGxpdmUgZGFlbW9uIGludmlzaWJsZSB0byB0aGUgbmV4dCB2ZXJiLiBgaWRlbnRpZnlgIGlzIHdoYXQgbGV0cyBvbmVcbiAgLy8gc2hhcmVkIHByZWRpY2F0ZSBzZXJ2ZSBib3RoIHRoaXMgSlNPTiBwb2ludGVyIGFuZCBhc3Ryb2xhYmUncyBiYXJlIHBpZCBmaWxlLlxuICBjb25zdCBjbGVhbnVwRGlzY292ZXJ5ID0gKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICB1bmxpbmtTeW5jKHNlc3Npb25GaWxlKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGdvbmUg4oCUIGZpbmUgKi9cbiAgICB9XG4gICAgdW5saW5rSWZNYXRjaGVzKGxhdGVzdEZpbGUsIHNlc3Npb25JZCwgKHJhdykgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgaWQgPSAoSlNPTi5wYXJzZShyYXcpIGFzIHsgc2Vzc2lvbl9pZD86IHVua25vd24gfSkuc2Vzc2lvbl9pZDtcbiAgICAgICAgcmV0dXJuIHR5cGVvZiBpZCA9PT0gXCJzdHJpbmdcIiA/IGlkIDogbnVsbDtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICB9KTtcbiAgICB0cnkge1xuICAgICAgaWYgKHNlc3Npb25GaWxlc0Rpcikgcm1TeW5jKHNlc3Npb25GaWxlc0RpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9O1xuXG4gIGlmICghdltcIm5vLW9wZW5cIl0pIG9wZW5Ccm93c2VyKHVybCk7XG5cbiAgLy8gVGhlIGlkbGUgc3dlZXAgKyB0aGUgZGVib3VuY2VkIHNuYXBzaG90ICh+MXMgYWZ0ZXIgYW55IGNoYW5nZSwgc28gYSByZXN0YXJ0XG4gIC8vIHJlc3VtZXMpLlxuICAvL1xuICAvLyDim5QgVEhFIFNXRUVQIE5PVyBTRUVTIElUUyBTVUJTQ1JJQkVSUyDigJQgY2Vuc3VzIGRlZmVjdCBMMSwgY2xvc2VkIGJ5IHRoZVxuICAvLyBzaGFyZWQgaG91c2VrZWVwZXIgUkVRVUlSSU5HIGEgYHN1YnNjcmliZXJDb3VudGAuIFRoZSBvbGQgZXhwcmVzc2lvbiBoZXJlXG4gIC8vIHJlYWQgYChub3cgLSBsYXN0QWN0aXZpdHkpLzEwMDAgPj0gdGltZW91dGAgYW5kIG5vdGhpbmcgZWxzZSwgc28gYW4gYWdlbnRcbiAgLy8gaG9sZGluZyBhIGAvZXZlbnRzYCB0YWlsIG9uIGEgcXVpZXQgc2Vzc2lvbiB3YXMga2lsbGVkIHdpdGggaXRzIGNvbm5lY3Rpb25cbiAgLy8gb3BlbiBhdCB0aGUgMzAtbWludXRlIGZsb29yLiBgdGltZW91dGAgbm93IG1lYW5zIFwibGluZ2VyIHRoaXMgbG9uZyBhZnRlclxuICAvLyB0aGUgTEFTVCBzdWJzY3JpYmVyIGxlYXZlc1wiLCB3aGljaCBpcyB3aGF0IGJvdW50eSdzIGNvcHkgaGFzIGFsd2F5cyBtZWFudFxuICAvLyBhbmQgd2hhdCBtYWdwaWUncyBwcm9zZSBhbHJlYWR5IGNsYWltZWQuXG4gIGNvbnN0IHN0b3BIb3VzZWtlZXBpbmcgPSBzdGFydEhvdXNla2VlcGluZyh7XG4gICAgc3Vic2NyaWJlckNvdW50OiAoKSA9PiBzb2NrZXRzLnNpemUgKyBzc2VDbGllbnRzLnNpemUsXG4gICAgaWRsZU1zOiAoKSA9PiBwZXJmb3JtYW5jZS5ub3coKSAtIGxhc3RBY3Rpdml0eSxcbiAgICB0b3VjaCxcbiAgICB0aW1lb3V0TXM6IHRpbWVvdXQgKiAxMDAwLFxuICAgIG9uSWRsZUNsb3NlOiAoKSA9PiByZXNvbHZlRG9uZSh7IGNvZGU6IDEyNCwgcmVhc29uOiBcInRpbWVvdXRcIiB9KSxcbiAgICBzbmFwc2hvdDoge1xuICAgICAgZGlydHk6ICgpID0+IHNuYXBEaXJ0eSxcbiAgICAgIGNsZWFyOiAoKSA9PiB7XG4gICAgICAgIHNuYXBEaXJ0eSA9IGZhbHNlO1xuICAgICAgfSxcbiAgICAgIHdyaXRlOiAoKSA9PiBzYXZlU25hcHNob3Qoc2Vzc2lvbklkLCBzdGF0ZSksXG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgeyBjb2RlLCByZWFzb24gfSA9IGF3YWl0IGRvbmU7XG4gIHN0b3BIb3VzZWtlZXBpbmcoKTtcbiAgc2F2ZVNuYXBzaG90KHNlc3Npb25JZCwgc3RhdGUpOyAvLyBmaW5hbCB3cml0ZSDigJQgdGhlIHJlc3VtZSBwb2ludFxuICBlbWl0RXZlbnQoeyB0eXBlOiBcImNsb3NlZFwiLCByZWFzb24gfSk7XG4gIGJyb2FkY2FzdCh7IHR5cGU6IFwibWVzc2FnZVwiLCB0ZXh0OiBgc2Vzc2lvbiBlbmRlZDogJHtyZWFzb259YCB9KTtcbiAgYXdhaXQgZHJhaW5BbmRTdG9wKHsgc2VydmVyLCBjbGllbnRzOiBzc2VDbGllbnRzLCBzb2NrZXRzIH0pO1xuICBjbGVhbnVwRGlzY292ZXJ5KCk7XG4gIHJldHVybiBjb2RlO1xufVxuXG4vKipcbiAqIFRoZSBkYWVtb24ncyBlbnRyeSwgZm9yIHRoZSBMQVVOQ0hFUiBhdFxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9tYWdwaWUvc2NyaXB0cy9zZXJ2ZXIudHNgLlxuICpcbiAqIOKblCBgaW1wb3J0Lm1ldGEubWFpbmAgSVMgRkFMU0UgSU4gVEhFIEJVTkRMRS4gYGRpc3Qvc2VydmVyLmpzYCBpcyBJTVBPUlRFRCBieVxuICogdGhlIGxhdW5jaGVyLCBuZXZlciBleGVjdXRlZCBhcyB0aGUgcHJvY2VzcyBlbnRyeSwgc28gdGhlIG9sZFxuICogYGlmIChpbXBvcnQubWV0YS5tYWluKWAgYmxvY2sgd291bGQgc2ltcGx5IG5ldmVyIHJ1biDigJQgdGhlIGRhZW1vbiB3b3VsZCBib290LFxuICogc2VydmUgbm90aGluZyBhbmQgZXhpdCAwLiBUaGF0IGlzIHRoZSBmYWlsdXJlIHRoaXMgZXhwb3J0IGV4aXN0cyB0byBwcmV2ZW50LlxuICpcbiAqIOKblCBBTkQgSVQgVEFLRVMgTk8gQVJHVU1FTlRTLCBmb3IgdGhlIHNhbWUgcmVhc29uIGBjbGkudHNgJ3MgYHJ1bigpYCBkb2VzIG5vdDpcbiAqIHRoZSBjb21tYW5kIGxpbmUgYmVsb25ncyB0byB0aGUgZmlsZSB0aGF0IFBBUlNFUyBpdC4gQSBsYXVuY2hlciB0aGF0IHRvdWNoZWRcbiAqIGBwcm9jZXNzLmFyZ3ZgIHdvdWxkIG1hdGNoIGBncmltb2lyZS9saWIvZW50cnktcG9pbnRzLnRzYCdzIGFyZy1wYXJzaW5nXG4gKiBwcmVkaWNhdGUgYW5kIHRoZSB3YXJkcyB3b3VsZCBqdWRnZSB0aGlzIGRhZW1vbidzIGZsYWdzIGFnYWluc3QgYSBmaWxlIHRoYXRcbiAqIHJlY29nbmlzZXMgbm9uZS5cbiAqXG4gKiBUaGUgdGVybWluYWwgYHByb2Nlc3MuZXhpdChleGl0Q29kZSlgIHN0YXlzIHdoZXJlIGl0IGFsd2F5cyB3YXMg4oCUIGF0IHRoZSBzaXRlXG4gKiB0aGF0IGlzIHRoZSBwcm9jZXNzIGVudHJ5LCB3aGljaCBpcyBub3cgdGhlIGxhdW5jaGVyLiBJdCBpcyBmYW1pbHkgRS10ZXJtaW5hbFxuICogaW4gYGdyaW1vaXJlL2V4aXQtc2l0ZS1pbnZlbnRvcnkudGVzdC50c2AgKHRlYXJkb3duIGhhcyBhbHJlYWR5IHJ1biBpbnNpZGVcbiAqIGBtYWluYCksIGl0IGlzIGEgREFFTU9OJ3MgZXhpdCBhbmQgbm90IGEgQ0xJJ3MsIGFuZCBEOCdzIGBkaWVgLXRocm93cyBydWxpbmdcbiAqIGRlbGliZXJhdGVseSBkb2VzIG5vdCByZWFjaCBpdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG5leHBvcnQgdHlwZSB7IE1hZ3BpZVN0YXRlIH0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9tYWdwaWUvc2hhcmVkL3R5cGVzXCI7XG5leHBvcnQgeyBkZWZhdWx0U3RhdGUgfSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21hZ3BpZS9zaGFyZWQvdHlwZXNcIjtcbmV4cG9ydCB7IGxlYW5TdGF0ZSB9IGZyb20gXCIuL3JlZHVjZVwiO1xuZXhwb3J0IHsgbWFpbiwgcGFyc2VQb3J0RnJvbVNlc3Npb25JZCwgc25hcHNob3RzRGlyIH07XG4iLAogICAgIi8vIHNoYXJlZC90eXBlcy50c1xuLy8gVGhlIHNpbmdsZSBzaGFyZWQgY29udHJhY3QgZm9yIG1hZ3BpZSdzIGNvbmp1cmF0aW9uLiBJbXBvcnRlZCBieSBzZXJ2ZXIudHMsXG4vLyByZWR1Y2UudHMsIGNsaS50cywgQU5EIHRoZSBSZWFjdCBjbGllbnQuXG4vL1xuLy8gbWFncGllIChyZWJ1aWx0KSBpcyBhIFNUQU5ESU5HIFJFVklFVyBTVVJGQUNFIG92ZXIgYSBjb21wb3NpdGUgaW1hZ2U6IHRoZVxuLy8gZGFlbW9uIGhvbGRzIHRoZSBleHRyYWN0aW9uIHN0YXRlLCB0aGUgUmVhY3Qgc3VyZmFjZSBzaG93cyB0aGUgZWxlbWVudFxuLy8gYnJlYWtkb3duLCBhbmQgdGhlIHVzZXIganVkZ2VzIGVhY2ggY3V0b3V0LCBjb21wYXJlcyByZW1vdmFsLW1vZGVsIHJlc3VsdHMsXG4vLyBhbmQgc2VsZWN0aXZlbHkgcmV0cmllcy4gVGhlIGFnZW50IGRyaXZlcyBkaXNjb3ZlcnkgKyBleHRyYWN0aW9uOyB0aGUgc3VyZmFjZVxuLy8gaXMgd2hlcmUgdGhlIHVzZXIgc3RlZXJzLlxuLy9cbi8vIFBST1ZJU0lPTkFMIOKAlCB0aGlzIHN0YXRlIHNoYXBlIGlzIGEgZGVzaWduLWluZGVwZW5kZW50IHNrZWxldG9uLiBUaGVcbi8vIG1hZ3BpZS1zcGVjaWZpYyBzdXJmYWNlICsgdGhlIGZpbmFsIHNldHRsZWQgc2hhcGUgYXJlIGJlaW5nIGRlc2lnbmVkIGluXG4vLyBwYXJhbGxlbC4gRXZlcnl0aGluZyBtYXJrZWQgYC8vIFRPRE8obW9jayk6IOKApmAgaXMgYSBkZWxpYmVyYXRlIHBsYWNlaG9sZGVyIHRoZVxuLy8gbW9jayB0cmFjayB3aWxsIHJlcGxhY2U7IGtlZXAgbXV0YXRvcnMgKHJlZHVjZS50cykgdGhpbiBhcm91bmQgaXQuXG5cbi8vIFRoZSBlbGVtZW50IHR5cGUgdGF4b25vbXkgcG9ydGVkIGZyb20gdGhlIFB5dGhvbiBvcmlnaW5hbCDigJQgZHJpdmVzIHRoZSAoZnV0dXJlKVxuLy8gYmFja2dyb3VuZC1yZW1vdmFsIGRlY2lzaW9uIGluIGV4dHJhY3QuXG5leHBvcnQgdHlwZSBFbGVtZW50VHlwZSA9XG4gIHwgXCJ3b3JkbWFya1wiXG4gIHwgXCJ0YWdsaW5lXCJcbiAgfCBcImljb25cIlxuICB8IFwiaWxsdXN0cmF0aW9uXCJcbiAgfCBcInN0aWNrZXJcIlxuICB8IFwicGFsZXR0ZVwiXG4gIHwgXCJ0eXBvZ3JhcGh5XCJcbiAgfCBcInNjcmVlbnNob3RcIlxuICB8IFwib3RoZXJcIjtcblxuZXhwb3J0IGNvbnN0IEVMRU1FTlRfVFlQRVM6IHJlYWRvbmx5IEVsZW1lbnRUeXBlW10gPSBbXG4gIFwid29yZG1hcmtcIixcbiAgXCJ0YWdsaW5lXCIsXG4gIFwiaWNvblwiLFxuICBcImlsbHVzdHJhdGlvblwiLFxuICBcInN0aWNrZXJcIixcbiAgXCJwYWxldHRlXCIsXG4gIFwidHlwb2dyYXBoeVwiLFxuICBcInNjcmVlbnNob3RcIixcbiAgXCJvdGhlclwiLFxuXSBhcyBjb25zdDtcblxuLy8gVGhlIGxpbmVhciBwcm9jZXNzIHNwaW5lICh0aGUgdG9wLWJhciBzdGVwcGVyKS4gT25lIGFjdGl2ZSBwaGFzZSBhdCBhIHRpbWU7XG4vLyB0aGUgY3Vyc29yIGFkdmFuY2VzIHdoZW4gdGhlIHVzZXIgc2VhbHMgYSBwaGFzZS4gU3RhdHVzIGlzIERFUklWRUQgZnJvbSB0aGVcbi8vIGN1cnNvciDigJQgcGhhc2VzIGJlZm9yZSBpdCBhcmUgc2VhbGVkLCB0aGUgY3Vyc29yIGlzIGFjdGl2ZSwgYWZ0ZXIgaXMgdXBjb21pbmcuXG5leHBvcnQgdHlwZSBQaGFzZUtleSA9IFwiaW50YWtlXCIgfCBcInNsaWNlXCIgfCBcInJlbW92ZVwiIHwgXCJleHBvcnRcIjtcbmV4cG9ydCBjb25zdCBQSEFTRVM6IHJlYWRvbmx5IFBoYXNlS2V5W10gPSBbXCJpbnRha2VcIiwgXCJzbGljZVwiLCBcInJlbW92ZVwiLCBcImV4cG9ydFwiXSBhcyBjb25zdDtcblxuLy8gQSBwaXhlbCBib3VuZGluZyBib3ggW3gxLCB5MSwgeDIsIHkyXSBpbiBzb3VyY2UtaW1hZ2UgY29vcmRpbmF0ZXMgKG1hdGNoZXNcbi8vIHRoZSBQeXRob24gb3JpZ2luYWwncyBgYmJveF9waXhlbGApLlxuZXhwb3J0IHR5cGUgQmJveCA9IFtudW1iZXIsIG51bWJlciwgbnVtYmVyLCBudW1iZXJdO1xuXG4vLyBUaGUgYmFja2Ryb3AgdGhlIHN1cmZhY2UgcHJldmlld3MgY3V0b3V0cyBhZ2FpbnN0IChhIGNoZWNrZXIgZm9yIHRyYW5zcGFyZW50KS5cbmV4cG9ydCB0eXBlIEJhY2tkcm9wID0gXCJ3aGl0ZVwiIHwgXCJncmF5XCIgfCBcImJsYWNrXCIgfCBcInRyYW5zcGFyZW50XCI7XG5cbi8vIE9uZSBleHRyYWN0YWJsZSBlbGVtZW50LiBNSU5JTUFMIHByb3Zpc2lvbmFsIHNoYXBlIOKAlCB0aGUgcmV2aWV3L2p1ZGdtZW50XG4vLyBtYWNoaW5lcnkgaXMgbW9ja2VkIG91dCBmb3Igbm93LiBgYmJveGAgaXMgY2Fub25pY2FsIGluIFNPVVJDRSBQSVhFTFMgKHdoYXRcbi8vIGRpc2NvdmVyIHByb2R1Y2VzIGFuZCBjcm9wIGNvbnN1bWVzKTsgdGhlIGNhbnZhcyBjb252ZXJ0cyBweOKGlGZyYWN0aW9uIHZpYVxuLy8gYHNvdXJjZS5zaXplYCBmb3IgcmVuZGVyaW5nL2VkaXRpbmcuXG5leHBvcnQgdHlwZSBFbGVtZW50U3RhdHVzID0gXCJwcm9wb3NlZFwiIHwgXCJjb25maXJtZWRcIiB8IFwiZHJvcHBlZFwiO1xuXG4vLyBBIHByb2R1Y2VkIGFzc2V0IGZvciBvbmUgZWxlbWVudDogdGhlIHJhdyBjcm9wIChtb2RlbDpcImNyb3BcIikgb3IgYSByZW1vdmFsXG4vLyByZXN1bHQuIGBwYXRoYCBpcyB0aGUgb24tZGlzayBQTkcgc2VydmVkIHZpYSAvYXNzZXRzOyBgcmV2YCBidW1wcyBvbiBldmVyeVxuLy8gKHJlLSlydW4gb2YgdGhlIFNBTUUgbW9kZWwg4oCUIHRoZSBmaWxlIGlzIG92ZXJ3cml0dGVuIGluIHBsYWNlLCBzbyB0aGUgc3VyZmFjZVxuLy8gYXBwZW5kcyA/dj08cmV2PiB0byBidXN0IHRoZSBicm93c2VyIGNhY2hlLiBga2luZGAgaXMgYSBsYWJlbC1jaGlwIGhpbnQgdGhlXG4vLyBhZ2VudCBzdXBwbGllczsgbmV2ZXIgaW5mZXJyZWQgaW4gdGhlIFVJLlxuZXhwb3J0IHR5cGUgRWxlbWVudFZlcnNpb24gPSB7XG4gIGlkOiBzdHJpbmc7XG4gIG1vZGVsOiBzdHJpbmc7IC8vIFwiY3JvcFwiIHwgXCJyZW1iZ1wiIHwgXCJicmlhXCIgfCBcImlkZW9ncmFtXCIgfCDigKYgKGFnZW50LWRlZmluZWQpXG4gIGtpbmQ/OiBcInJhd1wiIHwgXCJsb2NhbFwiIHwgXCJjbG91ZFwiO1xuICBwYXRoOiBzdHJpbmc7XG4gIHJldjogbnVtYmVyO1xuICBub3RlPzogc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgRWxlbWVudCA9IHtcbiAgaWQ6IHN0cmluZztcbiAgbmFtZTogc3RyaW5nO1xuICB0eXBlOiBFbGVtZW50VHlwZTtcbiAgYmJveDogQmJveDtcbiAgc3RhdHVzOiBFbGVtZW50U3RhdHVzO1xuICAvLyDilIDilIAgZXh0cmFjdGlvbiDilIDilIBcbiAgLy8gUHJvZHVjZWQgYXNzZXRzLCBvbmUgcm93IHBlciBtb2RlbC4gY3JvcCA9IHZlcnNpb25zWzBdIChtb2RlbDpcImNyb3BcIikuXG4gIC8vIEFic2VudCB1bnRpbCB0aGUgZmlyc3QgY3V0OyB0cmVhdCB1bmRlZmluZWQgYXMgW10uIFRoZSBjaG9zZW4gdmVyc2lvbiBpc1xuICAvLyB3aGF0IHRoZSByYWlsL2dhbGxlcnkgcmVuZGVyIChjaG9zZW5WZXJzaW9uKCkgZmFsbHMgYmFjayB0byB2ZXJzaW9uc1swXSkuXG4gIHZlcnNpb25zPzogRWxlbWVudFZlcnNpb25bXTtcbiAgY2hvc2VuVmVyc2lvbklkPzogc3RyaW5nO1xuICAvLyBUaGUgc29sZSByZXZpZXcgc2lnbmFsOiB0aGUgdXNlciBmbGFnZ2VkIHRoaXMgZWxlbWVudCB0byBiZSByZS1ydW4gKHJlLXNsaWNlXG4gIC8vIGluIHRoZSBzbGljZXMgcGhhc2UsIHJlLXJlbW92ZSBpbiB0aGUgYmcgcGhhc2UpLiBBcHByb3ZhbCBpcyB0aGUgQUJTRU5DRSBvZiBhXG4gIC8vIGZsYWc7IGRpc2NhcmRpbmcgaXMgc3RhdHVzOlwiZHJvcHBlZFwiLiBDbGVhcmVkIHdoZW4gYSBmcmVzaCB2ZXJzaW9uIGxhbmRzLlxuICBmbGFnZ2VkPzogYm9vbGVhbjtcbn07XG5cbi8vIOKUgOKUgCB0aGUgY29udmVyc2F0aW9uICh0aGUgc3BpbmUsIHBvcnRlZCBzZXR0bGVkIGZyb20gaW1hZ28pIOKUgOKUgFxuZXhwb3J0IHR5cGUgTWVzc2FnZUtpbmQgPVxuICB8IFwidGV4dFwiIC8vIHBsYWluIGRpYWxvZ3VlIChlaXRoZXIgcm9sZSlcbiAgfCBcImdlc3R1cmVcIiAvLyBhIHN1cmZhY2UgYWN0aW9uIHN1cmZhY2VkIGFzIGEgbWVzc2FnZSAodXNlciBqdWRnZWQvcmV0cmllZC/igKYpXG4gIHwgXCJxdWVzdGlvblwiOyAvLyBhZ2VudCBuZWVkcyB0aGUgdXNlciAoYW4gdW5hbnN3ZXJlZCBvbmUg4oaSIFwiYXNraW5nXCIgcHJlc2VuY2UpXG5cbmV4cG9ydCB0eXBlIE1lc3NhZ2UgPSB7XG4gIGlkOiBzdHJpbmc7XG4gIHJvbGU6IFwidXNlclwiIHwgXCJhZ2VudFwiO1xuICBraW5kOiBNZXNzYWdlS2luZDtcbiAgdGV4dDogc3RyaW5nO1xuICB0czogbnVtYmVyO1xuICAvLyBraW5kOiBcInF1ZXN0aW9uXCIg4oCUIG9wdGlvbmFsIHF1aWNrIHJlcGxpZXMgKHRoZSBmdWxsIGFuc3dlciBjYW4gYmUgZnJlZSB0ZXh0KVxuICBvcHRpb25zPzogc3RyaW5nW107XG4gIC8vIGtpbmQ6IFwiZ2VzdHVyZVwiIOKAlCB3aGF0IHRoZSB1c2VyIGRpZCwgYW5kIHRvIHdoYXRcbiAgZ2VzdHVyZT86IHsga2luZDogc3RyaW5nOyB0YXJnZXRJZD86IHN0cmluZyB9O1xuICAvLyBBbiBvcHRpb25hbCBvbmUtY2xpY2sgQ1RBIHRoZSBhZ2VudCBhdHRhY2hlcyB0byBhIG1lc3NhZ2Ug4oCUIGEgU0hPUlRDVVQgZm9yIGFcbiAgLy8gY29udmVyc2F0aW9uYWwgYWN0ICh0aGUgdXNlciBjb3VsZCBoYXZlIGp1c3Qgc2FpZCBpdCkuIENsaWNraW5nIGRpc3BhdGNoZXNcbiAgLy8gYGNvbW1hbmRgIChlLmcuIHsgdHlwZTogXCJwaGFzZS5hZHZhbmNlXCIgfSkuIENvbnZlcnNhdGlvbiBzdGF5cyB0aGUgcHJpbWFyeVxuICAvLyBjYXBhYmlsaXR5OyB0aGlzIGlzIHN1Z2FyIG9uIHRvcCwgc3VyZmFjZWQgYnkgdGhlIGFnZW50IGF0IGl0cyBkaXNjcmV0aW9uLlxuICBhY3Rpb24/OiB7IGxhYmVsOiBzdHJpbmc7IGNvbW1hbmQ6IENsaWVudFRvU2VydmVyIH07XG59O1xuXG4vLyBBIGJveCBiZWZvcmUgdGhlIGRhZW1vbiBhc3NpZ25zIGl0IGFuIGlkIOKAlCBkcmF3biBieSB0aGUgdXNlciAoXCJtYXJrIGEgbWlzc2VkXG4vLyByZWdpb25cIikgb3IgYnkgdGhlIGFnZW50IGJveGluZyBpbmNyZW1lbnRhbGx5LiBUaGUgZGFlbW9uIGZpbGxzIGBpZGAgYW5kXG4vLyBkZWZhdWx0cyBuYW1lL3R5cGUvc3RhdHVzIG9uIGVsZW1lbnQuYWRkLlxuZXhwb3J0IHR5cGUgTmV3RWxlbWVudCA9IHtcbiAgYmJveDogQmJveDtcbiAgbmFtZT86IHN0cmluZztcbiAgdHlwZT86IEVsZW1lbnRUeXBlO1xuICBzdGF0dXM/OiBFbGVtZW50U3RhdHVzO1xufTtcblxuLy8gVGhlIHNvdXJjZSBjb21wb3NpdGUgaW1hZ2UgdW5kZXIgcmV2aWV3LiBgcGF0aGAgaXMgdGhlIG9uLWRpc2sgZmlsZSB0aGUgYWdlbnRcbi8vIHJlYWRzOyBgc2l6ZWAgaXMgW3csIGhdIGluIHB4OyBgc2hhYCBpcyB0aGUgZmlyc3QtMTYgb2YgdGhlIHNoYTI1NiAobWF0Y2hlc1xuLy8gdGhlIFB5dGhvbiBvcmlnaW5hbCdzIGBzb3VyY2Vfc2hhMjU2XzE2YCkuXG5leHBvcnQgdHlwZSBTb3VyY2UgPSB7XG4gIHBhdGg6IHN0cmluZztcbiAgc2l6ZTogW251bWJlciwgbnVtYmVyXTtcbiAgc2hhOiBzdHJpbmc7XG59O1xuXG4vLyDilIDilIAgdGhlIHdob2xlIHN0YXRlIChQUk9WSVNJT05BTCkg4pSA4pSAXG5leHBvcnQgdHlwZSBNYWdwaWVTdGF0ZSA9IHtcbiAgdGl0bGU6IHN0cmluZztcbiAgaW50ZW50OiBzdHJpbmc7IC8vIHdoYXQgdGhlIHVzZXIgd2FudHMgb3V0IG9mIHRoaXMgYm9hcmQgKGZyZWUgdGV4dCB0aGUgYWdlbnQgc2V0cylcbiAgcGhhc2U6IFBoYXNlS2V5OyAvLyB0aGUgbGluZWFyIHByb2Nlc3MgY3Vyc29yIChJbnRha2Ug4oaSIFNsaWNlIOKGkiBSZW1vdmUg4oaSIEV4cG9ydClcbiAgc291cmNlOiBTb3VyY2UgfCBudWxsO1xuICBlbGVtZW50czogRWxlbWVudFtdO1xuICBjb252ZXJzYXRpb246IE1lc3NhZ2VbXTtcbiAgYmFja2Ryb3A6IEJhY2tkcm9wO1xuICBzdGF0dXM6IHsgYnVzeTogYm9vbGVhbjsgdGV4dDogc3RyaW5nIH07XG4gIC8vIFRoZSBidWlsdCBleHBvcnQgYnVuZGxlIChFeHBvcnQgcGhhc2UpLCBpZiBhbnkg4oCUIHNlcnZlZCB2aWEgL2Fzc2V0cy88bmFtZT4uXG4gIGJ1bmRsZT86IHsgbmFtZTogc3RyaW5nOyBjb3VudDogbnVtYmVyIH07XG4gIC8vIFRoZSBjdXJyZW50IHNlc3Npb24gaWQgKHJ1bnRpbWU7IHRoZSBkYWVtb24gc2V0cyBpdCBhdCBzdGFydCwgTk9UIHBlcnNpc3RlZC1cbiAgLy8gbWVhbmluZ2Z1bCBzaW5jZSByZXN0b3JlIG1pbnRzIGEgbmV3IG9uZSkg4oCUIHNob3duIGluIEV4cG9ydCdzIHJlb3BlbiBoaW50LlxuICBzZXNzaW9uSWQ/OiBzdHJpbmc7XG59O1xuXG5leHBvcnQgZnVuY3Rpb24gZGVmYXVsdFN0YXRlKHRpdGxlOiBzdHJpbmcpOiBNYWdwaWVTdGF0ZSB7XG4gIHJldHVybiB7XG4gICAgdGl0bGUsXG4gICAgaW50ZW50OiBcIlwiLFxuICAgIHBoYXNlOiBcImludGFrZVwiLFxuICAgIHNvdXJjZTogbnVsbCxcbiAgICBlbGVtZW50czogW10sXG4gICAgY29udmVyc2F0aW9uOiBbXSxcbiAgICBiYWNrZHJvcDogXCJ0cmFuc3BhcmVudFwiLFxuICAgIHN0YXR1czogeyBidXN5OiBmYWxzZSwgdGV4dDogXCJcIiB9LFxuICB9O1xufVxuXG4vLyDilIDilIAgU2VydmVyIOKGkiBicm93c2VyIChXZWJTb2NrZXQpLiBUaGUgYnJvd3NlciBoYW5kbGVzIGV4YWN0bHkgdGhlc2UuIOKUgOKUgFxuZXhwb3J0IHR5cGUgU2VydmVyVG9DbGllbnQgPVxuICB8IHsgdHlwZTogXCJzdGF0ZVwiOyBzdGF0ZTogTWFncGllU3RhdGUgfVxuICB8IHsgdHlwZTogXCJtZXNzYWdlXCI7IHRleHQ6IHN0cmluZyB9XG4gIC8vIGFnZW50IHByZXNlbmNlIOKAlCBpcyBhdCBsZWFzdCBvbmUgYWdlbnQgdGFpbGluZyAvZXZlbnRzICh3YXRjaGluZyB0aGUgYm9hcmQpP1xuICAvLyBwdXNoZWQgb24gY2hhbmdlICsgb24gYnJvd3NlciBjb25uZWN0OyBydW50aW1lLW9ubHksIG5ldmVyIHBlcnNpc3RlZCBpbiBzdGF0ZS5cbiAgfCB7IHR5cGU6IFwicHJlc2VuY2VcIjsgYWdlbnQ6IGJvb2xlYW4gfVxuICB8IHsgdHlwZTogXCJzdWJtaXRcIiB9XG4gIHwgeyB0eXBlOiBcImNhbmNlbFwiIH07XG5cbi8vIOKUgOKUgCBCcm93c2VyIOKGkiBzZXJ2ZXIgKFdlYlNvY2tldCkuIFRoZSBjbGllbnQgc2VuZHMgZXhhY3RseSB0aGVzZS4g4pSA4pSAXG4vLyBFYWNoIGVpdGhlciBtdXRhdGVzIHN0YXRlIChyZS1icm9hZGNhc3QpIGFuZC9vciBlbWl0cyBhbiBTU0UgZXZlbnQgdGhlIGFnZW50XG4vLyByZWFjdHMgdG8uXG5leHBvcnQgdHlwZSBDbGllbnRUb1NlcnZlciA9XG4gIHwgeyB0eXBlOiBcInNheVwiOyB0ZXh0OiBzdHJpbmcgfSAvLyB1c2VyIHBvc3RzIGEgbWVzc2FnZSAvIGluc3RydWN0aW9uXG4gIHwgeyB0eXBlOiBcInNvdXJjZS5pbXBvcnRcIjsgbmFtZTogc3RyaW5nOyBkYXRhVXJsOiBzdHJpbmcgfSAvLyB1c2VyIGRyb3BwZWQgYSBjb21wb3NpdGUg4oaSIGRhZW1vbiBtYXRlcmlhbGl6ZXMgaXRcbiAgfCB7IHR5cGU6IFwiZWxlbWVudC5hZGRcIjsgZWxlbWVudDogTmV3RWxlbWVudCB9IC8vIHVzZXIgZHJldyBhIG1pc3NlZCByZWdpb24gb24gdGhlIGNhbnZhc1xuICB8IHsgdHlwZTogXCJlbGVtZW50LnVwZGF0ZVwiOyBpZDogc3RyaW5nOyBwYXRjaDogUGFydGlhbDxFbGVtZW50PiB9IC8vIG1vdmUgLyByZXNpemUgLyByZW5hbWUgLyByZXR5cGVcbiAgfCB7IHR5cGU6IFwiZWxlbWVudC5yZW1vdmVcIjsgaWQ6IHN0cmluZyB9IC8vIGhhcmQtZGVsZXRlIGEgYm94ICh1c3VhbGx5IGEgdXNlci1kcmF3biBvbmUpXG4gIHwgeyB0eXBlOiBcImVsZW1lbnQuanVkZ2VcIjsgaWQ6IHN0cmluZzsgc3RhdHVzOiBFbGVtZW50U3RhdHVzIH0gLy8gc29mdCBjb25maXJtL2Ryb3AgYSBkaXNjb3ZlcmVkIGVsZW1lbnRcbiAgfCB7IHR5cGU6IFwiZXh0cmFjdFwiOyBpZHM/OiBzdHJpbmdbXSB9IC8vIGN1dCBzbGljZXMgZm9yIGFsbCBjb25maXJtZWQgZWxlbWVudHMsIG9yIGEgc3Vic2V0IChyZS1jdXQpXG4gIHwgeyB0eXBlOiBcImVsZW1lbnQuZmxhZ1wiOyBpZDogc3RyaW5nOyBmbGFnZ2VkOiBib29sZWFuIH0gLy8gZmxhZy91bmZsYWcgZm9yIHJlLXJ1biAocmUtc2xpY2Ugb3IgcmUtcmVtb3ZlKVxuICB8IHsgdHlwZTogXCJ2ZXJzaW9uLmNob29zZVwiOyBpZDogc3RyaW5nOyB2ZXJzaW9uSWQ6IHN0cmluZyB9IC8vIHVzZXIgcGlja2VkIGEgdmVyc2lvbiDihpIgaXQgYmVjb21lcyBjaG9zZW4gKGFtYmllbnQpXG4gIHwgeyB0eXBlOiBcInJlbW92ZUJnXCI7IGlkcz86IHN0cmluZ1tdIH0gLy8gcmVtb3ZlIGJhY2tncm91bmRzIGZvciB0aGVzZSBhbHBoYS1lbGlnaWJsZSBlbGVtZW50cyAoYWJzZW50IOKGkiBhbGwgZWxpZ2libGUpXG4gIHwgeyB0eXBlOiBcInJldHJ5UmVtb3ZhbFwiOyBpZHM6IHN0cmluZ1tdIH0gLy8gXCJ0cnkgYSBkaWZmZXJlbnQgcmVtb3ZhbFwiIOKAlCBhZ2VudCBwaWNrcyBhbiBVTlVTRUQgbW9kZWw7IHBheWxvYWQgaXMgaWRzIG9ubHlcbiAgfCB7IHR5cGU6IFwiYmFja2Ryb3Auc2V0XCI7IGJhY2tkcm9wOiBCYWNrZHJvcCB9IC8vIGFtYmllbnQgcHJldmlldyBiYWNrZHJvcFxuICB8IHsgdHlwZTogXCJwaGFzZS5hZHZhbmNlXCIgfSAvLyBzZWFsIHRoZSBhY3RpdmUgcGhhc2UsIG1vdmUgdGhlIGN1cnNvciB0byB0aGUgbmV4dCAoaW1wZXJhdGl2ZSBoYW5kLW9mZilcbiAgfCB7IHR5cGU6IFwicGhhc2Uuc2V0XCI7IHBoYXNlOiBQaGFzZUtleSB9IC8vIGJhY2stbmF2IC8ganVtcCB0byBhIHBoYXNlIChhbWJpZW50KVxuICB8IHsgdHlwZTogXCJleHBvcnRcIjsgaWRzPzogc3RyaW5nW10gfSAvLyBidWlsZCB0aGUgZG93bmxvYWRhYmxlIGFzc2V0IGJ1bmRsZSAoY2hvc2VuIHZlcnNpb25zIG9mIHRoZXNlIC8gYWxsIG5vbi1kcm9wcGVkKVxuICB8IHsgdHlwZTogXCJzdWJtaXRcIiB9XG4gIHwgeyB0eXBlOiBcImNhbmNlbFwiIH07XG5cbi8vIOKUgOKUgCBBZ2VudCDihpIgc2VydmVyIChQT1NUIC9jbWQpLiBUaGUgYWdlbnQgZHJpdmVzIHRoZSBkYWVtb24gd2l0aCBleGFjdGx5IHRoZXNlLiDilIDilIBcbmV4cG9ydCB0eXBlIEFnZW50Q29tbWFuZCA9XG4gIHwgeyB0eXBlOiBcImluaXRcIjsgdGl0bGU/OiBzdHJpbmc7IGludGVudD86IHN0cmluZyB9XG4gIHwge1xuICAgICAgdHlwZTogXCJzYXlcIjtcbiAgICAgIHRleHQ6IHN0cmluZztcbiAgICAgIGFjdGlvbj86IHsgbGFiZWw6IHN0cmluZzsgY29tbWFuZDogQ2xpZW50VG9TZXJ2ZXIgfTtcbiAgICB9IC8vIHBvc3QgYWdlbnQgZGlhbG9ndWUgKGtpbmQ6XCJ0ZXh0XCIpOyBvcHRpb25hbCBpbmxpbmUgQ1RBIHNob3J0Y3V0XG4gIHwgeyB0eXBlOiBcImFza1wiOyB0ZXh0OiBzdHJpbmc7IG9wdGlvbnM/OiBzdHJpbmdbXSB9IC8vIHBvc3QgYW4gaW4tdGhyZWFkIHF1ZXN0aW9uXG4gIHwgeyB0eXBlOiBcInNvdXJjZS5zZXRcIjsgcGF0aDogc3RyaW5nOyBzaXplOiBbbnVtYmVyLCBudW1iZXJdOyBzaGE6IHN0cmluZyB9IC8vIHRoZSBjb21wb3NpdGUgdW5kZXIgcmV2aWV3XG4gIHwgeyB0eXBlOiBcImVsZW1lbnRzLnNldFwiOyBlbGVtZW50czogRWxlbWVudFtdIH0gLy8gcG9zdCB0aGUgZGlzY292ZXJlZCBicmVha2Rvd25cbiAgfCB7IHR5cGU6IFwiZWxlbWVudC5hZGRcIjsgZWxlbWVudDogTmV3RWxlbWVudCB9IC8vIGFnZW50IGJveGVzIGEgcmVnaW9uIGluY3JlbWVudGFsbHlcbiAgfCB7IHR5cGU6IFwiZWxlbWVudC51cGRhdGVcIjsgaWQ6IHN0cmluZzsgcGF0Y2g6IFBhcnRpYWw8RWxlbWVudD4gfSAvLyBtb3ZlL3Jlc2l6ZS9yZW5hbWUvcmV0eXBlICh2ZXJzaW9ucyBhcHBlbmQgdmlhIGVsZW1lbnQuYWRkVmVyc2lvbilcbiAgfCB7IHR5cGU6IFwiZWxlbWVudC5yZW1vdmVcIjsgaWQ6IHN0cmluZyB9IC8vIGFnZW50IHJldHJhY3RzIGEgYm94XG4gIHwgeyB0eXBlOiBcImVsZW1lbnQuYWRkVmVyc2lvblwiOyBpZDogc3RyaW5nOyB2ZXJzaW9uOiBFbGVtZW50VmVyc2lvbjsgY2hvb3NlPzogYm9vbGVhbiB9IC8vIGFnZW50IGFwcGVuZHMgYSBwcm9kdWNlZCB2ZXJzaW9uXG4gIHwgeyB0eXBlOiBcInBoYXNlLnNldFwiOyBwaGFzZTogUGhhc2VLZXkgfSAvLyBhZ2VudCBhZHZhbmNlcy9tb3ZlcyB0aGUgY3Vyc29yIG9uIHRoZSB1c2VyJ3MgY29udmVyc2F0aW9uYWwgcmVxdWVzdFxuICB8IHsgdHlwZTogXCJidW5kbGUuc2V0XCI7IG5hbWU6IHN0cmluZzsgY291bnQ6IG51bWJlciB9IC8vIGFnZW50IHBvc3RzIHRoZSBidWlsdCBleHBvcnQgYnVuZGxlIChzZXJ2ZWQgdmlhIC9hc3NldHMvPG5hbWU+KVxuICB8IHsgdHlwZTogXCJzdGF0dXNcIjsgYnVzeTogYm9vbGVhbjsgdGV4dD86IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcImNsb3NlXCIgfTtcblxuLy8gVGhlIGFnZW50IGV2ZW50IHNldCAoc2VydmVyIOKGkiBhZ2VudCBTU0UpIOKAlCBJTVBFUkFUSVZFUyBPTkxZOiB0aGUgbW92ZXMgd2hlcmVcbi8vIHRoZSB1c2VyICpoYW5kcyB3b3JrIHRvIHRoZSBhZ2VudCosIHBsdXMgbGlmZWN5Y2xlLiBBbWJpZW50IGVkaXRpbmcgb2YgdGhlXG4vLyBicmVha2Rvd24gaXMgZGVsaWJlcmF0ZWx5IE5PVCBoZXJlIOKAlCBib3ggbW92ZS9yZXNpemUvcmVuYW1lL3JldHlwZVxuLy8gKGVsZW1lbnQudXBkYXRlKSwgZHJhdyAoZWxlbWVudC5hZGQpLCBkZWxldGUgKGVsZW1lbnQucmVtb3ZlKSwgY29uZmlybS9kcm9wXG4vLyAoZWxlbWVudC5qdWRnZSksIHJlLXJ1biBmbGFnIChlbGVtZW50LmZsYWcpLCB2ZXJzaW9uIHBpY2sgKHZlcnNpb24uY2hvb3NlKSwgYW5kXG4vLyBiYWNrZHJvcCBhcmUgYWxsIHJlYWNoYWJsZSBmcm9tIC9zdGF0ZSwgd2hpY2ggdGhlIGFnZW50IHJlYWRzIGF0IHRoZSBtb21lbnQgYW5cbi8vIGltcGVyYXRpdmUgZmlyZXMuIFB1c2hpbmcgZWFjaCBlZGl0IHdvdWxkIGp1c3QgbmFycmF0ZSB0aGUgdXNlcidzIGJ1c3kgd29yay5cbi8vIFRoZSBpbXBlcmF0aXZlczogYHNheWAsIGBzb3VyY2UuYWRkZWRgICjihpIgZGlzY292ZXIpLCBgZXh0cmFjdGAgKOKGkiBjdXQgdGhlXG4vLyBjdXJyZW50IGJveGVzKSwgYHJlbW92ZUJnYCAo4oaSIHJlbW92ZSBiYWNrZ3JvdW5kcywgYWdlbnQgcGlja3MgdGhlIG1vZGVsKSxcbi8vIGByZXRyeVJlbW92YWxgICjihpIgdHJ5IGEgZGlmZmVyZW50IHJlbW92YWwsIGFnZW50IHBpY2tzIGFuIHVudXNlZCBtb2RlbCksXG4vLyBgcGhhc2UuYWR2YW5jZWAgKOKGkiB1c2VyIHNlYWxlZCBhIHBoYXNlOyBhIGhhbmQtb2ZmIHRvIHRoZSBuZXh0IGxlZyksXG4vLyBgcGhhc2Uuc2V0YCAo4oaSIHVzZXIgc3RlcHBlZCBCQUNLIHRvIGEgcGhhc2Ug4oCUIG5vdCBhbiBhY3Rpb24gdG8gdGFrZSwgYnV0XG4vLyBjb250ZXh0IGZvciB3aGF0J3MgY29taW5nLCBlLmcuIHJlLWN1dHMpLCBgc3VibWl0YCwgKyBsaWZlY3ljbGUuIEEgcGhhc2Ugc3dpdGNoXG4vLyBpcyBhIGRlbGliZXJhdGUgcmVsb2NhdGlvbiwgTk9UIGFtYmllbnQgZWRpdGluZyDigJQgc28gYm90aCBkaXJlY3Rpb25zIGFyZSBwdXNoZWQuXG5leHBvcnQgY29uc3QgQUdFTlRfRVZFTlRfVFlQRVMgPSBPYmplY3QuZnJlZXplKFtcbiAgXCJyZWFkeVwiLFxuICBcImNvbm5lY3RlZFwiLFxuICBcImRpc2Nvbm5lY3RlZFwiLFxuICBcInNheVwiLFxuICBcInNvdXJjZS5hZGRlZFwiLCAvLyB1c2VyIGRyb3BwZWQgYSBjb21wb3NpdGUg4oCUIHRoZSBhZ2VudCBydW5zIGRpc2NvdmVyIG9uIGl0XG4gIFwiZXh0cmFjdFwiLCAvLyB1c2VyIGFza2VkIHRvIChyZS0pY3V0IOKAlCB0aGUgYWdlbnQgcmVhZHMgdGhlIGJveGVzIGZyb20gL3N0YXRlXG4gIFwicmVtb3ZlQmdcIiwgLy8gdXNlciBhc2tlZCB0byByZW1vdmUgYmFja2dyb3VuZHMg4oCUIHRoZSBhZ2VudCBwaWNrcyB0aGUgbW9kZWxcbiAgXCJyZXRyeVJlbW92YWxcIiwgLy8gdXNlciBhc2tlZCB0byB0cnkgYSBkaWZmZXJlbnQgcmVtb3ZhbCDigJQgdGhlIGFnZW50IHBpY2tzIGFuIFVOVVNFRCBtb2RlbFxuICBcInBoYXNlLmFkdmFuY2VcIiwgLy8gdXNlciBzZWFsZWQgdGhlIGFjdGl2ZSBwaGFzZSDigJQgYSBoYW5kLW9mZiB0byB0aGUgbmV4dCBsZWcgb2Ygd29ya1xuICBcInBoYXNlLnNldFwiLCAvLyB1c2VyIHN0ZXBwZWQgQkFDSyB0byBhIHBoYXNlIOKAlCBjb250ZXh0IChyZS1jdXRzIGxpa2VseSksIG5vIGFjdGlvbiByZXF1aXJlZFxuICBcImV4cG9ydFwiLCAvLyB1c2VyIGFza2VkIHRvIGJ1aWxkIHRoZSBkb3dubG9hZGFibGUgYXNzZXQgYnVuZGxlIOKAlCB0aGUgYWdlbnQgemlwcyBpdFxuICBcInN1Ym1pdFwiLFxuICBcImNsb3NlZFwiLFxuXSBhcyBjb25zdCk7XG5leHBvcnQgdHlwZSBBZ2VudEV2ZW50VHlwZSA9ICh0eXBlb2YgQUdFTlRfRVZFTlRfVFlQRVMpW251bWJlcl07XG5cbi8vIFR5cGVkIHBheWxvYWRzIGZvciB0aGUgZXZlbnRzIHRoYXQgY2FycnkgZGF0YS5cbmV4cG9ydCB0eXBlIEFnZW50RXZlbnRQYXlsb2FkID0ge1xuICBzYXk6IHsgdGV4dDogc3RyaW5nIH07XG4gIFwic291cmNlLmFkZGVkXCI6IHsgcGF0aDogc3RyaW5nOyBzaXplOiBbbnVtYmVyLCBudW1iZXJdOyBzaGE6IHN0cmluZyB9O1xuICBleHRyYWN0OiB7IGlkcz86IHN0cmluZ1tdIH07IC8vIHdoaWNoIGVsZW1lbnRzIHRvIChyZS0pY3V0OyBhYnNlbnQg4oaSIGFsbCBjb25maXJtZWRcbiAgcmVtb3ZlQmc6IHsgaWRzPzogc3RyaW5nW10gfTsgLy8gd2hpY2ggZWxlbWVudHMgdG8gcmVtb3ZlIGJnIGZvcjsgYWJzZW50IOKGkiBhbGwgZWxpZ2libGVcbiAgcmV0cnlSZW1vdmFsOiB7IGlkczogc3RyaW5nW10gfTsgLy8gd2hpY2ggKGZsYWdnZWQpIGVsZW1lbnRzIHRvIHJlLXJlbW92ZTsgbW9kZWwgaXMgdGhlIGFnZW50J3MgY2FsbFxuICBcInBoYXNlLmFkdmFuY2VcIjogeyBwaGFzZTogUGhhc2VLZXkgfTsgLy8gdGhlIE5FVyBwaGFzZSB0aGUgdXNlciBhZHZhbmNlZCB0b1xuICBcInBoYXNlLnNldFwiOiB7IHBoYXNlOiBQaGFzZUtleSB9OyAvLyB0aGUgcGhhc2UgdGhlIHVzZXIgc3RlcHBlZCBiYWNrIHRvXG4gIGV4cG9ydDogeyBpZHM/OiBzdHJpbmdbXSB9OyAvLyB3aGljaCBlbGVtZW50cyB0byBidW5kbGUgKGFic2VudCDihpIgYWxsIG5vbi1kcm9wcGVkKVxufTtcbiIsCiAgICAiLyoqXG4gKiBUaGUgdHdvIHByaW1pdGl2ZXMgdW5kZXIgQk9USCBvZiB0aGUgaG91c2UncyBkYWVtb24tZGlzY292ZXJ5IGNvbnZlbnRpb25zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogRDMgcnVsZWQgdGhhdCB0aGUgY29udmVudGlvbnMgdGhlbXNlbHZlcyDigJQgcGVyLXNlc3Npb24gdG1wZGlyIEpTT04gKGJvdW50eSxcbiAqIGdsYW1vdXIsIGltYWdvLCBtYWdwaWUpIGFuZCBzaW5nbGV0b24gYCRIT01FL2RhZW1vbi5wb3J0YCArIGBkYWVtb24ucGlkYFxuICogKGFzdHJvbGFiZSwgZ3JhcGV2aW5lLCBtaW5kLW1hcHBlcikg4oCUIGJvdGggc3Vydml2ZSwgYmVjYXVzZSB0aGV5IGVuY29kZVxuICogZ2VudWluZWx5IGRpZmZlcmVudCBtb2RlbHMgKGNvbmN1cnJlbnQgc2Vzc2lvbnMgdnMgYSBzdGFuZGluZyBzaW5nbGV0b24pIGFuZFxuICogcGlja2luZyBvbmUgaXMgYSBwcm9kdWN0IGRlY2lzaW9uLCBub3QgYSBmYWN0b3Jpbmcgb25lLiBXaGF0IElTIG9uZVxuICogaW1wbGVtZW50YXRpb24gaXMgdGhlIHBhaXIgYmVsb3csIHdoaWNoIGlzIGFsc28gZXhhY3RseSB3aGVyZSBjZW5zdXMgZGVmZWN0XG4gKiAqKkwzKiogbGl2ZXMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCByZW5hbWVTeW5jLCBybVN5bmMsIHVubGlua1N5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuXG4vKipcbiAqIFdyaXRlIGB0ZXh0YCB0byBgdGFyZ2V0YCBhdG9taWNhbGx5OiB3cml0ZSBiZXNpZGUgaXQsIHRoZW4gcmVuYW1lLlxuICpcbiAqIOKblCAqKkwzLCBDTE9TRUQgQlkgQ09OU1RSVUNUSU9OLioqIEEgYmFyZSBgd3JpdGVGaWxlU3luY2AgaXMgbm90IGF0b21pYywgc28gYVxuICogQ0xJIHJlYWRpbmcgd2hpbGUgdGhlIGRhZW1vbiB3cml0ZXMgY2FuIG9ic2VydmUgYSBIQUxGLVdSSVRURU4gcG9pbnRlci4gVW5kZXJcbiAqIGEgYmVzdC1lZmZvcnQgcmVhZGVyIHRoYXQgc3VyZmFjZWQgYXMgXCJubyBydW5uaW5nIHNlc3Npb25cIiDigJQgYWJzZW5jZSByZXBvcnRlZFxuICogZm9yIHdoYXQgd2FzIHJlYWxseSBhIHRvcm4gcmVhZCwgd2hpY2ggaXMgdGhlIGV4YWN0IGNvbmZsYXRpb24gdGhlIGhvdXNlJ3NcbiAqIGBudWxsYC1ub3QtYDBgIHJ1bGUgZXhpc3RzIHRvIHByZXZlbnQuIFJlbmFtZSB3aXRoaW4gb25lIGRpcmVjdG9yeSBpcyBhdG9taWMsXG4gKiBzbyBhIHJlYWRlciBzZWVzIGVpdGhlciB0aGUgcHJldmlvdXMgcG9pbnRlciBvciB0aGUgbmV3IG9uZSwgbmV2ZXIgYSBwYXJ0aWFsXG4gKiBmaWxlLlxuICpcbiAqIEZpeGVkIGluIGdsYW1vdXIgMjAyNi0wOS0wNywgZm91bmQgc3RhbmRpbmcgaW4gdGhyZWUgc2libGluZ3MgdGhlIG5leHQgZGF5IGJ5XG4gKiB0aGUgZHVwbGljYXRpb24gcmVjb24sIGFuZCByZXBhaXJlZCBpbiBhbGwgb2YgdGhlbSB0aGUgb25seSB3YXkgdGhhdCBkb2VzIG5vdFxuICogbmVlZCBmaW5kaW5nIGFnYWluOiB0aGVyZSBpcyBub3cgb25lIGltcGxlbWVudGF0aW9uLlxuICpcbiAqIOKaoCBUaGUgdGVtcCBuYW1lIGNhcnJpZXMgdGhlIHBpZCwgc28gdHdvIGRhZW1vbnMgcmFjaW5nIHRvIHB1Ymxpc2ggdGhlIHNhbWVcbiAqIHBvaW50ZXIgY2Fubm90IGNsb2JiZXIgZWFjaCBvdGhlcidzIGludGVybWVkaWF0ZSBmaWxlIOKAlCBhbmQgaXQgaXMgcmVtb3ZlZCBvblxuICogYSBmYWlsZWQgd3JpdGUgcmF0aGVyIHRoYW4gbGVmdCBhcyBsaXR0ZXIgYmVzaWRlIHRoZSByZWFsIG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlRmlsZUF0b21pYyh0YXJnZXQ6IHN0cmluZywgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHRtcCA9IGAke3RhcmdldH0uJHtwcm9jZXNzLnBpZH0udG1wYDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKHRtcCwgdGV4dCk7XG4gICAgcmVuYW1lU3luYyh0bXAsIHRhcmdldCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRyeSB7XG4gICAgICBybVN5bmModG1wLCB7IGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogdGhlIHRlbXAgZmlsZSBpcyBhbHJlYWR5IGdvbmUsIG9yIHdhcyBuZXZlciBjcmVhdGVkICovXG4gICAgfVxuICAgIHRocm93IGVycjtcbiAgfVxufVxuXG4vKipcbiAqIERlbGV0ZSBgcGF0aGAgaWZmIGl0IHN0aWxsIG5hbWVzIFVTLiBSZXR1cm5zIHdoZXRoZXIgaXQgd2FzIGRlbGV0ZWQuXG4gKlxuICog4puUICoqXCJTVElMTCBPVVJTXCIgSVMgVEhFIFdIT0xFIEZVTkNUSU9OLioqIEEgZGFlbW9uIHRoYXQgdW5saW5rcyBpdHMgZGlzY292ZXJ5XG4gKiBmaWxlIHVuY29uZGl0aW9uYWxseSBhdCBleGl0IGRlbGV0ZXMgdGhlIHBvaW50ZXIgYSBTVUNDRVNTT1IgaGFzIGFscmVhZHlcbiAqIHdyaXR0ZW4g4oCUIHRoZSBzdWNjZXNzb3IgY2FuIHRoZW4gbm8gbG9uZ2VyIGJlIGZvdW5kIGFuZCB0aGUgbmV4dCBDTEkgdmVyYiBzcGF3bnMgYVxuICogdGhpcmQgZGFlbW9uLiBCb3RoIGNvbnZlbnRpb25zIGhhdmUgdGhpcyBoYXphcmQgYW5kIGJvdGggZXhwcmVzcyBpdFxuICogZGlmZmVyZW50bHk6IGFzdHJvbGFiZSBjb21wYXJlcyB0aGUgcGlkIGZpbGUncyBieXRlcyB0byBpdHMgb3duIHBpZCxcbiAqIG1hZ3BpZSBwYXJzZXMgdGhlIEpTT04gcG9pbnRlciBhbmQgY29tcGFyZXMgYHNlc3Npb25faWRgLiBgaWRlbnRpZnlgIGlzIHdoYXRcbiAqIG1ha2VzIHRob3NlIG9uZSBmdW5jdGlvbiDigJQgaXQgdHVybnMgdGhlIGZpbGUncyBieXRlcyBpbnRvIHRoZSBpZGVudGl0eSB0b1xuICogY29tcGFyZSwgYW5kIGl0IGRlZmF1bHRzIHRvIHRoZSB0cmltbWVkIGJ5dGVzIHRoZW1zZWx2ZXMuXG4gKlxuICog4pqgIEV2ZXJ5IGZhaWx1cmUgaXMgc3dhbGxvd2VkIGFuZCByZXBvcnRlZCBhcyBgZmFsc2VgOiB0aGUgZmlsZSBiZWluZyBnb25lLFxuICogdW5yZWFkYWJsZSwgb3IgdW5wYXJzZWFibGUgYWxsIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZSDigJQgaXQgaXMgbm90IG91cnMgdG9cbiAqIHJlbW92ZS4gQW4gdW5wYXJzZWFibGUgcG9pbnRlciBpcyBkZWxpYmVyYXRlbHkgTk9UIHRyZWF0ZWQgYXMgb3Vycywgd2hpY2ggaXNcbiAqIHRoZSBjb25zZXJ2YXRpdmUgaGFsZiBvZiB0aGUgc2FtZSBgbnVsbGAtbm90LWAwYCBydWxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdW5saW5rSWZNYXRjaGVzKFxuICBwYXRoOiBzdHJpbmcsXG4gIGV4cGVjdGVkOiBzdHJpbmcsXG4gIGlkZW50aWZ5OiAocmF3OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGwgPSAocmF3KSA9PiByYXcudHJpbSgpLFxuKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGlkZW50aWZ5KHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpICE9PSBleHBlY3RlZCkgcmV0dXJuIGZhbHNlO1xuICAgIHVubGlua1N5bmMocGF0aCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBpbi1wcm9jZXNzIGV2ZW50IGxvZyDigJQgdGhlIGFwcGVuZC1vbmx5LCByZXBsYXlhYmxlIGJ1ZmZlclxuICogYmVoaW5kIGV2ZXJ5IHNwZWxsJ3MgYEdFVCAvZXZlbnRzYCBTU0UgdGFpbC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzXG4gKiBgc2NyaXB0cy9ldmVudHMudHNgIOKAlCB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMyLCBhbmQgdGhlIG9ubHkgb25lIG9mXG4gKiB0aGUgc2l4IGNvcGllZC1pbi1wbGFjZSBidXNlcyB0aGF0IGlzIGEgbW9kdWxlLCBpcyBib3VuZGVkLCBjYXJyaWVzIGFuIGVwb2NoLCBhbmQgaXNcbiAqIHVuaXQtdGVzdGVkLiBUaGUgZml2ZSBvdGhlcnMgYXJlIHRoZSBzYW1lIHR3ZW50eSBsaW5lcyB3cml0dGVuIGZpdmUgdGltZXMuXG4gKlxuICog4pSA4pSAIFRIRSBUSFJFRSBUSElOR1MgVEhJUyBGSVhFUyBCWSBDT05TVFJVQ1RJT04g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKioxIMK3IEw1IOKAlCB0aGUgYnVmZmVyIGlzIGJvdW5kZWQuKiogRml2ZSBkYWVtb25zIGFwcGVuZCB0byBhbiBhcnJheSBmb3IgdGhlXG4gKiB3aG9sZSBsaWZlIG9mIHRoZSBwcm9jZXNzLiBUaGUgd2luZG93IGlzIGEgUkVQTEFZIHdpbmRvdyBmb3IgcmVjb25uZWN0cyB3aXRoaW4gb25lXG4gKiBkYWVtb24ncyBsaWZldGltZSwgbm90IGEgZHVyYWJsZSBsb2c7IGEgY2FwIGlzIHRoZSBob25lc3Qgc2hhcGUuXG4gKlxuICogKioyIMK3IEw2IOKAlCBhIGZyYW1lIGNhcnJpZXMgYW4gZXBvY2gsIHdoZW4gdGhlIGNhbGxlciBhc2tzIGZvciBvbmUuKiogQWZ0ZXIgYVxuICogcmVzdGFydCB0aGUgaWRzIHN0YXJ0IGFnYWluIGF0IDEsIHNvIGEgcmVzdW1pbmcgY2xpZW50IGNhbm5vdCB0ZWxsIGEgc3RhbGVcbiAqIHdhdGVybWFyayBmcm9tIGEgZnJlc2ggb25lIGJ5IGlkIGFsb25lLlxuICpcbiAqICoqMyDCtyBBIFNUQUxFIFdBVEVSTUFSSyBSRVBMQVlTIEZST00gVEhFIEJFR0lOTklORywgYW5kIHRoaXMgaXMgdGhlIGhhbGYgdGhlXG4gKiBjbGllbnQgY2Fubm90IGRvLioqIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogYSB0YWlsIHRoYXQgcmVzdW1lcyBhdFxuICogYHNpbmNlPTxsYXN0IGlkIG9mIHRoZSBwcmV2aW91cyBkYWVtb24+YCBhZ2FpbnN0IGEgcmVzdGFydGVkIGRhZW1vbiByZWNlaXZlc1xuICogTk9USElORyDigJQgdGhlIG5ldyBkYWVtb24ncyBgcmVhZHlgIGlzIGlkIDEsIHdoaWNoIGlzIG5vdCBgPiBzaW5jZWAsIHNvIHRoZVxuICogZmlsdGVyIGRyb3BzIGl0LCBzbyBubyBmcmFtZSBhcnJpdmVzLCBzbyB0aGUgY2xpZW50J3MgZXBvY2ggY2hlY2sgbmV2ZXIgcnVuc1xuICogYW5kIHRoZSB0YWlsIHNpdHMgY29ubmVjdGVkIGFuZCBzaWxlbnQgdW50aWwgdGhlIG5ldyBkYWVtb24gaGFzIGVtaXR0ZWQgYXNcbiAqIG1hbnkgZXZlbnRzIGFzIHRoZSBvbGQgb25lIGRpZC4gU3RhbXBpbmcgYW4gZXBvY2ggYWxvbmUgZG9lcyBOT1QgY2xvc2UgdGhhdFxuICogZ2FwOiB0aGUgZXBvY2ggcmlkZXMgYSBmcmFtZSwgYW5kIHRoZSBidWcgaXMgdGhhdCBubyBmcmFtZSBpcyBzZW50LiBTb1xuICogYHN1YnNjcmliZWAgdHJlYXRzIGBzaW5jZSA+IGN1cnNvcmAgYXMgXCJ0aGlzIGN1cnNvciBpcyBmcm9tIGFub3RoZXIgcHJvY2Vzc1wiXG4gKiBhbmQgcmVwbGF5cyB3aG9sZS4gYG1pbmQtbWFwcGVyL3NjcmlwdHMvdGFpbC50ZXN0LnRzYCdzIGVwb2NoIGNlbGwgaXMgdGhlXG4gKiBleGVjdXRhYmxlIHNwZWMgb2YgdGhlIGNsaWVudCBoYWxmIGFuZCBzaG93cyB0aGUgcmVjb25uZWN0IHN0aWxsIGNhcnJ5aW5nIHRoZVxuICogc3RhbGUgY3Vyc29yIOKAlCBkZXRlY3Rpb24gaGFwcGVucyBvbiB3aGF0IGlzIFJFQ0VJVkVELlxuICovXG5cbi8qKiBUaGUgZGVmYXVsdCByZXBsYXkgd2luZG93LCBpbmhlcml0ZWQgZnJvbSBtaW5kLW1hcHBlcidzIG1lYXN1cmVkIGNhcC4gKi9cbmV4cG9ydCBjb25zdCBSRVBMQVlfQlVGRkVSX1NJWkUgPSAxMDAwO1xuXG4vKiogQSBmcmFtZSBhcyBpdCBnb2VzIG9uIHRoZSB3aXJlOiB0aGUgY2FsbGVyJ3MgcGF5bG9hZCBwbHVzIGEgbW9ub3RvbmljIGBpZGAsXG4gKiAgcGx1cyBhbiBgZXBvY2hgIHdoZW4gdGhlIGxvZyB3YXMgZ2l2ZW4gb25lLiAqL1xuZXhwb3J0IHR5cGUgRnJhbWU8VD4gPSBUICYgeyBpZDogbnVtYmVyOyBlcG9jaD86IHN0cmluZyB9O1xuXG5leHBvcnQgaW50ZXJmYWNlIEV2ZW50TG9nPFQ+IHtcbiAgLyoqIEFwcGVuZCBvbmUgZnJhbWUsIGZhbiBpdCBvdXQgdG8gbGl2ZSBzdWJzY3JpYmVycywgYW5kIHJldHVybiBpdC4gKi9cbiAgZW1pdChtc2c6IFQpOiBGcmFtZTxUPjtcbiAgLyoqXG4gICAqIFJlcGxheSBldmVyeXRoaW5nIGFmdGVyIGBzaW5jZWAsIHRoZW4gc3RheSBzdWJzY3JpYmVkLiBSZXR1cm5zIGFuXG4gICAqIHVuc3Vic2NyaWJlIGZ1bmN0aW9uLlxuICAgKlxuICAgKiDim5QgUkVQTEFZIEFORCBTVUJTQ1JJQkUgQVJFIE9ORSBDQUxMIE9OIFBVUlBPU0UuIERvaW5nIHRoZW0gaW4gdHdvIHN0ZXBzXG4gICAqIGxlYXZlcyBhIHdpbmRvdyBpbiB3aGljaCBhbiBlbWl0IGxhbmRzIGJldHdlZW4gdGhlIHJlcGxheSBsb29wIGFuZCB0aGVcbiAgICogYGFkZGAsIGFuZCB0aGF0IGZyYW1lIGlzIGRlbGl2ZXJlZCB0byBub2JvZHkg4oCUIHRoZSBzaGFwZSBmaXZlIGRhZW1vbnMgaGF2ZSxcbiAgICogc3Vydml2ZWQgYnkgbm90aGluZyBidXQgdGhlIHNpbmdsZS10aHJlYWRlZCBldmVudCBsb29wIGhhcHBlbmluZyB0byBjbG9zZVxuICAgKiBpdC4gRGVwZW5kaW5nIG9uIHRoYXQgaXMgZGVwZW5kaW5nIG9uIGFuIGltcGxlbWVudGF0aW9uIGRldGFpbCBvZiB0aGVcbiAgICogcnVudGltZSByYXRoZXIgdGhhbiBvbiB0aGUgY29kZS5cbiAgICovXG4gIHN1YnNjcmliZShzaW5jZTogbnVtYmVyLCBsaXN0ZW5lcjogKGZyYW1lOiBGcmFtZTxUPikgPT4gdm9pZCk6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgaGlnaGVzdCBpZCBlbWl0dGVkIHNvIGZhciDigJQgd2hhdCBgR0VUIC9zdGF0ZWAgcmV0dXJucyBhcyBgY3Vyc29yYC4gKi9cbiAgY3Vyc29yKCk6IG51bWJlcjtcbiAgLyoqIFRoZSBlcG9jaCBzdGFtcGVkIG9uIGV2ZXJ5IGZyYW1lLCBvciBgdW5kZWZpbmVkYCBpZiBub25lIHdhcyBjb25maWd1cmVkLiAqL1xuICByZWFkb25seSBlcG9jaDogc3RyaW5nIHwgdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRXZlbnRMb2c8VCBleHRlbmRzIG9iamVjdD4oXG4gIG9wdHM6IHsgZXBvY2g/OiBzdHJpbmc7IGJ1ZmZlclNpemU/OiBudW1iZXIgfSA9IHt9LFxuKTogRXZlbnRMb2c8VD4ge1xuICBjb25zdCBidWZmZXJTaXplID0gb3B0cy5idWZmZXJTaXplID8/IFJFUExBWV9CVUZGRVJfU0laRTtcbiAgY29uc3QgZXBvY2ggPSBvcHRzLmVwb2NoO1xuICBjb25zdCBidWZmZXI6IEFycmF5PEZyYW1lPFQ+PiA9IFtdO1xuICBjb25zdCBsaXN0ZW5lcnMgPSBuZXcgU2V0PChmcmFtZTogRnJhbWU8VD4pID0+IHZvaWQ+KCk7XG4gIGxldCBzZXEgPSAwO1xuXG4gIHJldHVybiB7XG4gICAgZXBvY2gsXG5cbiAgICBlbWl0KG1zZykge1xuICAgICAgc2VxICs9IDE7XG4gICAgICAvLyDim5QgVEhFIE1PTk9UT05JQyBJRCBXSU5TIE9WRVIgQU5ZVEhJTkcgSU4gVEhFIFBBWUxPQUQsIEFORCBVTlRJTCBOT1cgSVRcbiAgICAgIC8vIE9OTFkgQ0xBSU1FRCBUTy4gQm90aCBhZG9wdGluZyBkYWVtb25zIHdyb3RlIGB7IGlkOiArK3NlcSwgLi4ubXNnIH1gXG4gICAgICAvLyB1bmRlciBhIGNvbW1lbnQgc2F5aW5nIFwidGhlIG1vbm90b25pYyBgaWRgIE1VU1Qgd2luIG92ZXIgYW55IGBpZGAgaW5cbiAgICAgIC8vIHRoZSBwYXlsb2FkLCBzbyBjYWxsZXJzIGNhcnJ5IGEgcHJvamVjdCBpZGVudGlmaWVyIGFzIGBwcm9qZWN0SWRgLFxuICAgICAgLy8gbmV2ZXIgYGlkYFwiIOKAlCBidXQgc3ByZWFkIG9yZGVyIG1lYW5zIGEgcGF5bG9hZCBgaWRgIG92ZXJyb2RlIHRoZVxuICAgICAgLy8gY3Vyc29yLCBzaWxlbnRseSwgYW5kIHRoZSBjb252ZW50aW9uIGluIHRoZSBjb21tZW50IHdhcyB0aGUgb25seSB0aGluZ1xuICAgICAgLy8gaG9sZGluZyBpdC4gVGhlIGxpdGVyYWwga2VlcHMgYGlkYCBGSVJTVCBzbyB0aGUgd2lyZSBrZXkgb3JkZXIgaXNcbiAgICAgIC8vIHVuY2hhbmdlZDsgdGhlIGFzc2lnbm1lbnQgYWZ0ZXIgdGhlIHNwcmVhZCBpcyB3aGF0IG1ha2VzIHRoZSBzZW50ZW5jZVxuICAgICAgLy8gdHJ1ZS4gYGVwb2NoYCBpcyBzdGFtcGVkIHRoZSBzYW1lIHdheSBhbmQgZm9yIHRoZSBzYW1lIHJlYXNvbi5cbiAgICAgIGNvbnN0IGZyYW1lID0geyBpZDogc2VxLCAuLi5tc2cgfSBhcyBGcmFtZTxUPjtcbiAgICAgIGZyYW1lLmlkID0gc2VxO1xuICAgICAgaWYgKGVwb2NoICE9PSB1bmRlZmluZWQpIGZyYW1lLmVwb2NoID0gZXBvY2g7XG5cbiAgICAgIGJ1ZmZlci5wdXNoKGZyYW1lKTtcbiAgICAgIGlmIChidWZmZXIubGVuZ3RoID4gYnVmZmVyU2l6ZSkgYnVmZmVyLnNoaWZ0KCk7XG4gICAgICBmb3IgKGNvbnN0IGxpc3RlbmVyIG9mIGxpc3RlbmVycykgbGlzdGVuZXIoZnJhbWUpO1xuICAgICAgcmV0dXJuIGZyYW1lO1xuICAgIH0sXG5cbiAgICBzdWJzY3JpYmUoc2luY2UsIGxpc3RlbmVyKSB7XG4gICAgICAvLyBTZWUgdGhlIGhlYWRlciwgcG9pbnQgMzogYSBjdXJzb3IgYmV5b25kIG91ciBvd24gaXMgYSBjdXJzb3IgZnJvbSBhXG4gICAgICAvLyBQUklPUiBQUk9DRVNTLCBhbmQgdGhlIG9ubHkgdXNlZnVsIHJlYWRpbmcgb2YgaXQgaXMgXCJyZXBsYXkgd2hvbGVcIi5cbiAgICAgIC8vXG4gICAgICAvLyDimqAgQSBOT04tRklOSVRFIENVUlNPUiBBTFNPIE1FQU5TIFwiRlJPTSBUSEUgU1RBUlRcIiwgd2hpY2ggdGhlIGNvcGllcyBnb3RcbiAgICAgIC8vIHdyb25nIGJ5IGFjY2lkZW50OiB0aGV5IHdyb3RlIGBwYXJzZUludChwYXJhbSA/PyBcIi0xXCIpYCBhbmQgY29tcGFyZWRcbiAgICAgIC8vIGBpZCA+IHNpbmNlYCwgc28gYSB0eXBvJ2QgYD9zaW5jZT14YCBwcm9kdWNlZCBgTmFOYCwgZXZlcnkgY29tcGFyaXNvblxuICAgICAgLy8gd2FzIGZhbHNlLCBhbmQgdGhlIHRhaWwgb3BlbmVkIEVNUFRZIGFuZCBzdGF5ZWQgY29ubmVjdGVkIOKAlCB0aGUgc2FtZVxuICAgICAgLy8gc2lsZW50LWFuZC1jb25uZWN0ZWQgc3ltcHRvbSBhcyB0aGUgc3RhbGUgd2F0ZXJtYXJrLCBmcm9tIGEgZGlmZmVyZW50XG4gICAgICAvLyBjYXVzZS4gQWJzZW50IGFuZCB1bnBhcnNlYWJsZSBhcmUgdGhlIHNhbWUgcmVxdWVzdCBoZXJlLlxuICAgICAgY29uc3QgZnJvbSA9ICFOdW1iZXIuaXNGaW5pdGUoc2luY2UpIHx8IHNpbmNlID4gc2VxID8gLTEgOiBzaW5jZTtcbiAgICAgIGZvciAoY29uc3QgZnJhbWUgb2YgYnVmZmVyKSB7XG4gICAgICAgIGlmIChmcmFtZS5pZCA+IGZyb20pIGxpc3RlbmVyKGZyYW1lKTtcbiAgICAgIH1cbiAgICAgIGxpc3RlbmVycy5hZGQobGlzdGVuZXIpO1xuICAgICAgcmV0dXJuICgpID0+IHtcbiAgICAgICAgbGlzdGVuZXJzLmRlbGV0ZShsaXN0ZW5lcik7XG4gICAgICB9O1xuICAgIH0sXG5cbiAgICBjdXJzb3IoKSB7XG4gICAgICByZXR1cm4gc2VxO1xuICAgIH0sXG4gIH07XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGRhZW1vbiBsaWZlY3ljbGUgdGFpbDogdGhlIGlkbGUtY2xvc2UgZGVjaXNpb24sIHRoZSBzd2VlcFxuICogdGhhdCBtYWtlcyBpdCwgYW5kIHRoZSBib3VuZGVkIHRlYXJkb3duLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIGJvdW50eSDigJQgdGhlIGNlbnN1cydzXG4gKiBjb252ZXJnZW5jZSB0YXJnZXQgIzMg4oCUIHdpdGggYXN0cm9sYWJlJ3MgYHRpbWVvdXRNcyA+IDBgIGd1YXJkIGZvbGRlZCBpbixcbiAqIHdoaWNoIGlzIHRoZSBvbmUgdGhpbmcgYm91bnR5J3MgY29weSBkb2VzIG5vdCBleHByZXNzLlxuICovXG5cbmltcG9ydCB0eXBlIHsgU3NlQ2xpZW50cyB9IGZyb20gXCIuL3NzZS50c1wiO1xuXG4vKipcbiAqIFNob3VsZCB0aGUgZGFlbW9uIGlkbGUtY2xvc2U/XG4gKlxuICog4puUICoqYHN1YnNjcmliZXJDb3VudGAgSVMgQSBSRVFVSVJFRCBBUkdVTUVOVCwgQU5EIFRIQVQgSVMgVEhFIFdIT0xFIFBPSU5ULioqXG4gKiBUaGlzIGNsb3NlcyBjZW5zdXMgZGVmZWN0ICoqTDEqKiBieSBjb25zdHJ1Y3Rpb246IGdsYW1vdXIsIGltYWdvIGFuZCBtYWdwaWVcbiAqIGNvdW50ZWQgdGhlaXIgaWRsZSBmbG9vciBkb3duIHdoaWxlIGFuIGFnZW50IGhlbGQgYSB0YWlsIG9wZW4sIHNvIGFuIGFnZW50XG4gKiB3YXRjaGluZyBhIHF1aWV0IGJvYXJkIHdhcyBraWxsZWQgV0lUSCBJVFMgQ09OTkVDVElPTiBPUEVOLiBUaGVyZSBpcyBub1xuICogb3ZlcmxvYWQgb2YgdGhpcyBmdW5jdGlvbiB0aGF0IGNhbm5vdCBzZWUgaXRzIHN1YnNjcmliZXJzLCBzbyB0aGUgZGVmZWN0XG4gKiBjYW5ub3QgYmUgcmUtZXhwcmVzc2VkIGJ5IGEgY2FsbGVyIHdobyBmb3JnZXRzLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0NBUiBJVCBDQU1FIFdJVEgsIHJlLWhvbWVkIGZyb20gYm91bnR5IHZlcmJhdGltIGluIHN1YnN0YW5jZToqKlxuICogYSBib2FyZCBvbmx5IGNvdW50cyBpdHMgaWRsZSBmbG9vciBkb3duIHdoaWxlIFVOV0FUQ0hFRC4gQSBsaXZlIHN1YnNjcmliZXIg4oCUXG4gKiBhIGJyb3dzZXIgV2ViU29ja2V0LCBvciBhbiBhZ2VudCBTU0UgdGFpbCBvbiBgL2V2ZW50c2Ag4oCUIGtlZXBzIGl0IG9wZW5cbiAqIGluZGVmaW5pdGVseS4gU28gYHRpbWVvdXRgIG1lYW5zIFwibGluZ2VyIHRoaXMgbG9uZyBhZnRlciB0aGUgTEFTVCBzdWJzY3JpYmVyXG4gKiBsZWF2ZXNcIiwgTk9UIFwibWF4aW11bSBpZGxlIHdoaWxlIGNvbm5lY3RlZFwiLiBUaGUgc3dlZXAgYmVsb3cgYWxzbyB0b3VjaGVzIHRoZVxuICogYWN0aXZpdHkgY2xvY2sgb24gZXZlcnkgdGljayB3aGlsZSB3YXRjaGVkLCBzbyBvbmNlIHVud2F0Y2hlZCB0aGUgZmxvb3JcbiAqIGNvdW50cyBmcm9tIHRoYXQgbGFzdCBkaXNjb25uZWN0IGFuZCBub3QgZnJvbSB0aGUgbGFzdCByZXF1ZXN0LlxuICpcbiAqIOKaoCBgdGltZW91dE1zIDw9IDBgIG1lYW5zIE5FVkVSLCB3aGljaCBpcyBhc3Ryb2xhYmUncyBzdGFuZGluZy1vYnNlcnZhdG9yeVxuICogZGVmYXVsdCBhbmQgaXMgd2h5IHRoZSBndWFyZCBpcyBoZXJlIHJhdGhlciB0aGFuIGF0IGl0cyBvbmUgY2FsbCBzaXRlOiBhXG4gKiBzaW5nbGV0b24gZGFlbW9uIGlzIG1lYW50IHRvIHN0YW5kIHVudGlsIGl0IGlzIGV4cGxpY2l0bHkgY2xvc2VkLCBhbmQgYVxuICogYD49IDBgIGNvbXBhcmlzb24gd291bGQgY2xvc2UgaXQgb24gdGhlIGZpcnN0IHRpY2suXG4gKlxuICogQ2xvY2stZnJlZSBhbmQgZnMtZnJlZSwgc28gaXQgaXMgdGVzdGFibGUgd2l0aG91dCBhIGRhZW1vbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZElkbGVDbG9zZShcbiAgc3Vic2NyaWJlckNvdW50OiBudW1iZXIsXG4gIGlkbGVNczogbnVtYmVyLFxuICB0aW1lb3V0TXM6IG51bWJlcixcbik6IGJvb2xlYW4ge1xuICBpZiAodGltZW91dE1zIDw9IDApIHJldHVybiBmYWxzZTtcbiAgaWYgKHN1YnNjcmliZXJDb3VudCA+IDApIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGlkbGVNcyA+PSB0aW1lb3V0TXM7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSG91c2VrZWVwaW5nT3B0aW9ucyB7XG4gIC8qKiDim5QgUkVRVUlSRUQuIFNlZSBgc2hvdWxkSWRsZUNsb3NlYCDigJQgdGhpcyBpcyB3aGF0IGNsb3NlcyBMMS4gKi9cbiAgc3Vic2NyaWJlckNvdW50OiAoKSA9PiBudW1iZXI7XG4gIC8qKiBNaWxsaXNlY29uZHMgc2luY2UgdGhlIGxhc3QgYWN0aXZpdHkuICovXG4gIGlkbGVNczogKCkgPT4gbnVtYmVyO1xuICAvKiogUmVzZXQgdGhlIGFjdGl2aXR5IGNsb2NrLiBDYWxsZWQgb24gZXZlcnkgdGljayB0aGF0IGhhcyBhIHN1YnNjcmliZXIuICovXG4gIHRvdWNoOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGNvbmZpZ3VyZWQgaWRsZSB0aW1lb3V0IGluIG1zOyBgMGAgKG9yIGxlc3MpIG1lYW5zIG5ldmVyLiAqL1xuICB0aW1lb3V0TXM6IG51bWJlcjtcbiAgLyoqIEZpcmVkIG9uY2Ugd2hlbiB0aGUgZGFlbW9uIHNob3VsZCBjbG9zZSBpdHNlbGYuICovXG4gIG9uSWRsZUNsb3NlOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGRlYm91bmNlZCBzbmFwc2hvdCwgaWYgdGhlIHNwZWxsIGhhcyBvbmUuICovXG4gIHNuYXBzaG90Pzoge1xuICAgIGRpcnR5OiAoKSA9PiBib29sZWFuO1xuICAgIGNsZWFyOiAoKSA9PiB2b2lkO1xuICAgIHdyaXRlOiAoKSA9PiB2b2lkIHwgUHJvbWlzZTx2b2lkPjtcbiAgfTtcbiAgLyoqIFN3ZWVwIGludGVydmFsOyBib3RoIGFkb3B0aW5nIGRhZW1vbnMgdXNlZCAyNTAgbXMuICovXG4gIHRpY2tNcz86IG51bWJlcjtcbiAgLyoqIFNuYXBzaG90IGludGVydmFsOyBib3RoIGFkb3B0aW5nIGRhZW1vbnMgdXNlZCAxMDAwIG1zLiAqL1xuICBzbmFwc2hvdE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFN0YXJ0IHRoZSB0d28gc3RhbmRpbmcgdGltZXJzIGV2ZXJ5IHNlc3Npb24gZGFlbW9uIHJ1bnMg4oCUIHRoZSBpZGxlIHN3ZWVwIGFuZFxuICogdGhlIGRlYm91bmNlZCBzbmFwc2hvdCDigJQgYW5kIHJldHVybiB0aGUgZnVuY3Rpb24gdGhhdCBzdG9wcyBib3RoLlxuICpcbiAqIFRoZXkgYXJlIE9ORSBjYWxsIGJlY2F1c2UgdGhleSBoYXZlIGFsd2F5cyBiZWVuIG9uZSBsaWZldGltZTogZXZlcnkgY29weVxuICogY2xlYXJlZCBib3RoIGluIHRoZSBzYW1lIHR3byBsaW5lcyBhZnRlciBgYXdhaXQgZG9uZWAsIGFuZCB0aGUgcGFpciB0aGF0IGdldHNcbiAqIGZvcmdvdHRlbiBpcyB0aGUgcGFpciB3aG9zZSB0aW1lcnMga2VlcCBhIHByb2Nlc3MgYWxpdmUgYWZ0ZXIgdGVhcmRvd24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFydEhvdXNla2VlcGluZyhvcHRzOiBIb3VzZWtlZXBpbmdPcHRpb25zKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHRpY2tNcyA9IG9wdHMudGlja01zID8/IDI1MDtcbiAgY29uc3Qgc25hcHNob3RNcyA9IG9wdHMuc25hcHNob3RNcyA/PyAxMDAwO1xuXG4gIGNvbnN0IGlkbGVUaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICBjb25zdCBzdWJzY3JpYmVycyA9IG9wdHMuc3Vic2NyaWJlckNvdW50KCk7XG4gICAgaWYgKHN1YnNjcmliZXJzID4gMCkgb3B0cy50b3VjaCgpO1xuICAgIGlmIChzaG91bGRJZGxlQ2xvc2Uoc3Vic2NyaWJlcnMsIG9wdHMuaWRsZU1zKCksIG9wdHMudGltZW91dE1zKSkgb3B0cy5vbklkbGVDbG9zZSgpO1xuICB9LCB0aWNrTXMpO1xuXG4gIGNvbnN0IHNuYXAgPSBvcHRzLnNuYXBzaG90O1xuICBjb25zdCBzbmFwVGltZXIgPSBzbmFwXG4gICAgPyBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICAgIGlmICghc25hcC5kaXJ0eSgpKSByZXR1cm47XG4gICAgICAgIHNuYXAuY2xlYXIoKTtcbiAgICAgICAgdm9pZCBzbmFwLndyaXRlKCk7XG4gICAgICB9LCBzbmFwc2hvdE1zKVxuICAgIDogbnVsbDtcblxuICByZXR1cm4gKCkgPT4ge1xuICAgIGNsZWFySW50ZXJ2YWwoaWRsZVRpbWVyKTtcbiAgICBpZiAoc25hcFRpbWVyICE9PSBudWxsKSBjbGVhckludGVydmFsKHNuYXBUaW1lcik7XG4gIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRHJhaW5PcHRpb25zIHtcbiAgLyoqIFRoZSBib3VuZCBzZXJ2ZXIuIFR5cGVkIHN0cnVjdHVyYWxseSBzbyB0aGUga2l0IHN0YXlzIGZyZWUgb2YgYGJ1bmAuICovXG4gIHNlcnZlcjogeyBzdG9wKGNsb3NlQWN0aXZlQ29ubmVjdGlvbnM/OiBib29sZWFuKTogdW5rbm93biB9O1xuICAvKiogTGl2ZSBTU0UgdGFpbHM7IGV2ZXJ5IHJlZ2lzdGVyZWQgY2xvc2VyIGlzIGludm9rZWQuICovXG4gIGNsaWVudHM/OiBTc2VDbGllbnRzO1xuICAvKiogTGl2ZSBXZWJTb2NrZXRzLiAqL1xuICBzb2NrZXRzPzogSXRlcmFibGU8eyBjbG9zZSgpOiB2b2lkIH0+O1xuICAvKiogSG93IGxvbmcgcXVldWVkIGZyYW1lcyBnZXQgdG8gZmx1c2ggYmVmb3JlIGFueXRoaW5nIGlzIGNsb3NlZC4gKi9cbiAgZ3JhY2VNcz86IG51bWJlcjtcbiAgLyoqIEhvdyBsb25nIHRoZSBncmFjZWZ1bCBzdG9wIGdldHMgYmVmb3JlIHRlYXJkb3duIHByb2NlZWRzIHJlZ2FyZGxlc3MuICovXG4gIHN0b3BNcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBDbG9zZSBldmVyeSBoZWxkIGNvbm5lY3Rpb24gYW5kIHN0b3AgdGhlIHNlcnZlciwgaW4gYm91bmRlZCB0aW1lLlxuICpcbiAqIOKblCAqKlRIRSBHUkFDRSBQRVJJT0QgSVMgTk9UIFBPTElURU5FU1MuKiogQSBgY2xvc2VkYCBmcmFtZSBlbWl0dGVkIGFuZCB0aGVuXG4gKiBmb2xsb3dlZCBpbW1lZGlhdGVseSBieSBhbiBhZ2dyZXNzaXZlIGBzZXJ2ZXIuc3RvcCh0cnVlKWAgaXMgYSBmcmFtZSB0aGVcbiAqIGNsaWVudCBuZXZlciBzZWVzIOKAlCB0aGUgcXVldWUgZ29lcyB3aXRoIHRoZSBzb2NrZXQuIFRoZSAxNTAgbXMgaXMgd2hhdCB0dXJuc1xuICogXCJ0aGUgZGFlbW9uIHRvbGQgeW91IHdoeSBpdCBkaWVkXCIgZnJvbSBhIGhvcGUgaW50byBhbiBvYnNlcnZhdGlvbiwgYW5kIGV2ZXJ5XG4gKiBvbmUgb2YgdGhlIGVpZ2h0IGRhZW1vbnMgY29udmVyZ2VkIG9uIHRoYXQgbnVtYmVyIGluZGVwZW5kZW50bHkuXG4gKlxuICog4puUICoqQU5EIFRIRSBTVE9QIElTIFJBQ0VELCBCRUNBVVNFIEEgU0xPVyBTT0NLRVQgTVVTVCBOT1QgQkUgQUJMRSBUTyBIQU5HXG4gKiBURUFSRE9XTi4qKiBgc2VydmVyLnN0b3AodHJ1ZSlgIGF3YWl0cyBpdHMgY29ubmVjdGlvbnM7IG9uZSB3ZWRnZWQgcGVlciBpc1xuICogZW5vdWdoIHRvIHBhcmsgaXQgZm9yZXZlciwgd2hpY2ggaXMgaG93IGEgMjMtbWludXRlIGhhbmcgc2hpcHBlZCBvbmNlLlxuICpcbiAqIOKaoCAqKldIQVQgSVMgREVMSUJFUkFURUxZIE5PVCBIRVJFOiBib3VudHkncyBzaHV0ZG93biB3YXRjaGRvZy4qKiBCb3VudHkgYXJtc1xuICogYSBSRUYnZCBgc2V0VGltZW91dGAgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBpZiB0ZWFyZG93biBkb2VzIG5vdCBmaW5pc2gsXG4gKiBhbmQgdGhlIGNlbnN1cyBpcyByaWdodCB0aGF0IGl0IGlzIHRoZSBjb3JwdXMncyBvbmx5IHVuY29uZGl0aW9uYWxcbiAqIHRlcm1pbmF0aW9uIGd1YXJhbnRlZS4gSXQgYmVsb25ncyB0byBib3VudHkncyBTSUdOQUwgcGF0aCDigJQgYSBkZWF0aCBhcnJpdmluZ1xuICogZnJvbSBvdXRzaWRlLCB3aGVyZSBub3RoaW5nIGJvdW5kcyB3aGF0IHRoZSB0ZWFyZG93biBpcyB3YWl0aW5nIG9uLiBUaGUgdHdvXG4gKiBkYWVtb25zIGFkb3B0aW5nIHRoaXMgbW9kdWxlIHJlZ2lzdGVyIG5vIHNpZ25hbCBoYW5kbGVycywgYW5kIHRoZWlyIHdob2xlXG4gKiB0ZWFyZG93biBpcyBib3VuZGVkIGJ5IHRoZSB0d28gbnVtYmVycyBhYm92ZTsgYWRkaW5nIGFuIGV4aXQgaGVyZSB3b3VsZCBwdXRcbiAqIHRoZSBob3VzZSdzIG9ubHkgdW5jb25kaXRpb25hbCBgcHJvY2Vzcy5leGl0YCBpbnNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgaXNcbiAqIGFib3V0IHRvIGJ1bmRsZSwgb25lIHBoYXNlIGFmdGVyIEQ4IHRvb2sgZXhhY3RseSB0aGF0IGhhemFyZCBPVVQgb2YgYGRpZWAuXG4gKlxuICog4puUICoqQU5EIFRIRSBTRU5URU5DRSBUSEFUIFVTRUQgVE8gRU5EIFRIQVQgUEFSQUdSQVBIIFdBUyBBIFBSRURJQ1RJT04sIFdISUNIXG4gKiBCT1VOVFknUyBPV04gUE9SVCBGQUxTSUZJRUQuKiogSXQgcmVhZDogXCJ3aGVuIGEgc3BlbGwgd2l0aCBhIHNpZ25hbCBwYXRoXG4gKiBhZG9wdHMgdGhpcywgdGhlIHdhdGNoZG9nIGFycml2ZXMgYXMgYW4gb3B0aW9uIG9uIHRoZXNlIGFyZ3VtZW50cyBhbmQgdGhlXG4gKiByZWFzb25pbmcgaXMgYWxyZWFkeSB3cml0dGVuIGRvd24uXCIgYm91bnR5IGFkb3B0ZWQgYGRyYWluQW5kU3RvcGAgb25cbiAqIDIwMjYtMDktMDkgKFBoYXNlIDQpIGFuZCB0aGUgb3B0aW9uIHdhcyBOT1QgYWRkZWQsIGJlY2F1c2UgdGhlIHdpbmRvdyBpc1xuICogd3JvbmcuICoqQSBgd2F0Y2hkb2dNc2Agb24gdGhlc2UgYXJndW1lbnRzIHdvdWxkIGFybSBhdCBEUkFJTiB0aW1lOyBib3VudHknc1xuICogYXJtcyBhdCBTSUdOQUwgdGltZSoqLCBhbmQgdGhlIHdob2xlIHJlYXNvbiBpdCBleGlzdHMgaXMgdGhlIHN0cmV0Y2ggQkVUV0VFTlxuICogdGhvc2UgdHdvIHBvaW50cyDigJQgYGF3YWl0IGRvbmVgLCBhbiBmcyBhcHBlbmQgdG8gdGhlIGRhZW1vbiBsb2csIGEgZnVsbFxuICogc25hcHNob3Qgd3JpdGUgdGhhdCBjYW4gcm90YXRlIGFuZCBDT1BZIGEgYmFja3VwIG9mIGEgbGFyZ2UgYm9hcmQsIGEgYGNsb3NlZGBcbiAqIGZyYW1lIGFuZCBhIGJyb2FkY2FzdC4gYGRyYWluQW5kU3RvcGAncyBvd24gYm9keSBpcyBhbHJlYWR5IGJvdW5kZWQgYnkgdGhlIHR3b1xuICogbnVtYmVycyBhYm92ZSwgc28gYSB3YXRjaGRvZyBzY29wZWQgdG8gaXQgd291bGQgZ3VhcmQgdGhlIG9uZSBzdHJldGNoIHRoYXRcbiAqIGNhbm5vdCBoYW5nIGFuZCBhYmFuZG9uIHRoZSBzdHJldGNoIHRoYXQgY2FuOiBpdCB3b3VsZCBSRUFEIGFzIGFkb3B0aW9uIGFuZFxuICogQkUgYSBuYXJyb3dpbmcgb2YgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbCB0ZXJtaW5hdGlvbiBndWFyYW50ZWUuIFRoZVxuICogMjMtbWludXRlIGhhbmcgdGhpcyBwcm9qZWN0IGtlZXBzIGNpdGluZyBoYXBwZW5lZCBpbiB0aGUgdW5ib3VuZGVkIHN0cmV0Y2guXG4gKlxuICog4pqgICoqU08gVEhFIFJVTEUgRk9SIFRIRSBORVhUIFNQRUxMLCBXSElDSCBJUyBUSEUgVFJBTlNGRVJBQkxFIEhBTEY6KiogdGhlXG4gKiBxdWVzdGlvbiBpcyBuZXZlciBcImRvZXMgdGhpcyBtb2R1bGUgaGF2ZSBhIHBsYWNlIHRvIHB1dCBhIHdhdGNoZG9nXCIgYnV0XG4gKiBcImRvZXMgdGhlIHdhdGNoZG9nJ3Mgd2luZG93IGNvaW5jaWRlIHdpdGggdGhpcyBtb2R1bGUnc1wiLiBXaGVyZSBhIHNwZWxsJ3NcbiAqIHRlYXJkb3duIGhhcyB1bmJvdW5kZWQgd29yayBCRUZPUkUgdGhlIGRyYWluLCB0aGUgd2F0Y2hkb2cgYmVsb25ncyBhdCB0aGVcbiAqIHNwZWxsLCB3cmFwcGVkIGFyb3VuZCBhbGwgb2YgaXQuIElmIGEgc3BlbGwgZXZlciBhcHBlYXJzIHdob3NlIHNpZ25hbCBwYXRoXG4gKiBlbnRlcnMgYGRyYWluQW5kU3RvcGAgaW1tZWRpYXRlbHksIGFkZCB0aGUgb3B0aW9uIFRIRU4g4oCUIGFuZCB0aGUgb3B0aW9uIG11c3RcbiAqIHRha2UgYW4gYG9uRXhwaXJlYCBjYWxsYmFjayByYXRoZXIgdGhhbiBleGl0aW5nLCBzbyB0aGUgYHByb2Nlc3MuZXhpdGAgc3RheXNcbiAqIG91dHNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgYnVuZGxlcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRyYWluQW5kU3RvcChvcHRzOiBEcmFpbk9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZ3JhY2VNcyA9IG9wdHMuZ3JhY2VNcyA/PyAxNTA7XG4gIGNvbnN0IHN0b3BNcyA9IG9wdHMuc3RvcE1zID8/IDIwMDtcblxuICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBncmFjZU1zKSk7XG5cbiAgaWYgKG9wdHMuY2xpZW50cykge1xuICAgIGZvciAoY29uc3QgY2xpZW50IG9mIFsuLi5vcHRzLmNsaWVudHNdKSBjbGllbnQuY2xvc2UoKTtcbiAgfVxuICBpZiAob3B0cy5zb2NrZXRzKSB7XG4gICAgZm9yIChjb25zdCB3cyBvZiBbLi4ub3B0cy5zb2NrZXRzXSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgd3MuY2xvc2UoKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBhbHJlYWR5IGdvbmUgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgIFByb21pc2UucmVzb2x2ZShvcHRzLnNlcnZlci5zdG9wKHRydWUpKSxcbiAgICBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBzdG9wTXMpKSxcbiAgXSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGFzc2V0LXNlcnZpbmcgdHJpbyBmb3IgYSBzcGVsbCBkYWVtb246IHdoaWNoIHN1cmZhY2UgbW9kZSB3ZVxuICogYXJlIGluLCB3aGF0IGNvbnRlbnQgdHlwZSBhIGZpbGUgZ2V0cywgYW5kIGhvdyBhIGZpbGUgdW5kZXIgYGRpc3QvYCBpc1xuICogYW5zd2VyZWQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwncyBhcnRpZmFjdC5cbiAqXG4gKiBFeHRyYWN0ZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBmcm9tIHRoZSBlaWdodCBgQnVuLnNlcnZlYCBiYWNrZW5kc1xuICogY2Vuc3VzZWQgaW4gYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC1kYWVtb24tc3BpbmUtY2Vuc3VzLm1kYCwgd2hpY2hcbiAqIG1lYXN1cmVkIGByZXNvbHZlTW9kZWAgYXMgYnl0ZS1pZGVudGljYWwgaW4gYWxsIGVpZ2h0ICh0aGUgb25seSBtZDUgZGlmZmVyZW5jZVxuICogYmVpbmcgdGhlIGBleHBvcnRgIGtleXdvcmQpLCB0aGUgY29udGVudC10eXBlIG1hcCBhcyBkaWZmZXJpbmcgaW4gZXhhY3RseVxuICogb25lIGNlbGwsIGFuZCB0aGUgZmlsZSBoYWxmIG9mIGBzZXJ2ZURpc3RgIGFzIGlkZW50aWNhbCBpbiBmaXZlLlxuICpcbiAqIOKUgOKUgCBXSEFUIERFTElCRVJBVEVMWSBESUQgTk9UIENPTUUgQUxPTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKipUaGUgVVJMLXRvLWZpbGVuYW1lIG1hcHBpbmcgc3RheXMgaW4gZWFjaCByb3V0ZXIuKiogVGhlIGNlbnN1cyBtYXJrZWQgdHdvXG4gKiBvZiB0aGUgZWlnaHQgYHNlcnZlRGlzdGAgZGl2ZXJnZW5jZXMgREVMSUJFUkFURSBhbmQgYm90aCBsaXZlIGluIHRoYXQgaGFsZjpcbiAqIGRpZ2VzdGlmeSBzdWJzdGl0dXRlcyBpbnRvIHRoZSBlbnRyeSBIVE1MIGluIG1lbW9yeSwgYW5kIGdyYXBldmluZSBzZXJ2ZXMgaXRzXG4gKiBzdXJmYWNlIGF0IGAvd2F0Y2hgIHJhdGhlciB0aGFuIGF0IGAvYC4gQSBzaWduYXR1cmUgd2lkZSBlbm91Z2ggdG8gYWJzb3JiXG4gKiB0aG9zZSBzdG9wcyBiZWluZyBhIGZpbGUgc2VydmVyIGFuZCBiZWNvbWVzIGEgcm91dGVyLiBTbyB0aGUgY2FsbGVyIGRlY2lkZXNcbiAqIFdISUNIIGZpbGUgKGBwYXRoID09PSBcIi9cIiA/IFwiaW5kZXguaHRtbFwiIDogcGF0aC5zbGljZSgxKWApLCBhbmQgdGhpcyBtb2R1bGVcbiAqIGRlY2lkZXMgd2hldGhlciB0aGF0IGZpbGUgbWF5IGJlIHJlYWQgYW5kIHdoYXQgaXQgaXMgc2VydmVkIGFzLlxuICovXG5cbmltcG9ydCB7IGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuLyoqXG4gKiBSZWxlYXNlIGlmZiBgPGRpc3REaXI+L2luZGV4Lmh0bWxgIGV4aXN0czsgZWxzZSBkZXYuIFRoZSBlbnYgb3ZlcnJpZGVcbiAqIChgU1BFTExCT09LX1NVUkZBQ0VfTU9ERWApIHdpbnMgZWl0aGVyIHdheSDigJQgc2VhbXMgQ29udHJhY3QgMS5cbiAqXG4gKiDim5QgKipUSEUgRklMRSwgTkVWRVIgVEhFIERJUkVDVE9SWSwgQU5EIFRIQVQgSVMgQSBTQ0FSIE5PVCBBIFNUWUxFIENIT0lDRS4qKlxuICogUmUtaG9tZWQgZnJvbSBib3VudHkgYW5kIG1hZ3BpZSwgd2hpY2ggZWFybmVkIGl0IGluZGVwZW5kZW50bHk6XG4gKlxuICogLSBtYWdwaWUncyBgZGlzdC9gIEFMUkVBRFkgRVhJU1RFRCBob2xkaW5nIGBjbGkuanNgIGFuZCBubyBgaW5kZXguaHRtbGAsXG4gKiAgIHdoaWNoIGlzIHByZWNpc2VseSB3aHkgaXRzIGRhZW1vbiBzdGF5ZWQgY29ycmVjdGx5IGluIERFViBtb2RlIHRocm91Z2ggdGhlXG4gKiAgIHdob2xlIG9mIFNsaWNlIDIuIGBkaXN0L2AgZXhpc3RpbmcgaXMgbm90IHRoZSBkaXNjcmltaW5hdG9yLlxuICogLSBib3VudHkgc2F5cyB0aGUgc2FtZSB0aGluZyBmcm9tIHRoZSBvdGhlciBzaWRlOiBhIGJ1aWx0IEJBQ0tFTkQgcHV0c1xuICogICBgY2xpLmpzYCAoYW5kIG5vdyBgc2VydmVyLmpzYCkgaW4gYGRpc3QvYCB3aXRoIG5vIHN1cmZhY2UgYW55d2hlcmUgbmVhciBpdC5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBSRURJQ0FURSBJUyBBTiBVTkhBU0hFRCBGSUxFTkFNRSwgV0hJQ0ggSVMgQSBTVEFORElOR1xuICogQVNTVU1QVElPTiBBQk9VVCBUSEUgU1VSRkFDRSBCVUlMRC4qKiBSZWxlYXNlIG1vZGUgaXMgY2hvc2VuIGJ5IE9ORSBsaXRlcmFsXG4gKiBuYW1lLiBBIHN1cmZhY2UgYnVpbGQgdGhhdCBldmVyIGVtaXR0ZWQgYSBjb250ZW50LWhhc2hlZCBlbnRyeSBkb2N1bWVudCB3b3VsZFxuICogbGVhdmUgbm8gYGluZGV4Lmh0bWxgIGhlcmUsIGV2ZXJ5IGRhZW1vbiB3b3VsZCBzaWxlbnRseSByZXNvbHZlIERFViwgYW5kIHRoZVxuICogb25seSBzeW1wdG9tIGFueW9uZSBjYW4gc2VlIGlzIHRoZSBgbW9kZWAgZmllbGQgb24gYSBoYW5kc2hha2Ugbm9ib2R5IHJlYWRzIGluXG4gKiBhbmdlci4gYHNyYy9idWlsZC50c2AgZW1pdHMgdGhlIGVudHJ5IHVuaGFzaGVkIHRvZGF5IChvbmx5IHRoZSBKUyBhbmQgQ1NTXG4gKiBjaHVua3MgY2FycnkgaGFzaGVzKSBhbmQgQ29udHJhY3QgMiBwaW5zIHRoYXQgZmxhdCBsYXlvdXQ7IHRoaXMgY29tbWVudCBpc1xuICogdGhlIG5vdGUgdGhhdCBzYXlzIHdoYXQgdGhlIHBpbiBpcyBsb2FkLWJlYXJpbmcgRk9SLlxuICpcbiAqIOKaoCBOb3RoaW5nIGFubm91bmNlcyB0aGUgZmxpcCBmcm9tIGRldiB0byByZWxlYXNlIGVpdGhlcjogdGhlIGZpcnN0IHN1cmZhY2VcbiAqIGJ1aWxkIHRvIGxhbmQgYW4gYGluZGV4Lmh0bWxgIGJlc2lkZSBhIGRhZW1vbiBmbGlwcyBpdCwgc2lsZW50bHksIG9uIHRoZSBuZXh0XG4gKiBib290LiBUaGF0IGlzIHdoeSBgbW9kZWAgcmlkZXMgdGhlIHJlYWR5IGZyYW1lIOKAlCB3aXRoIHJvb3QgZGVwcyBwcmVzZW50IGEgZGV2XG4gKiBkYWVtb24gcmVuZGVycyBhbiBpZGVudGljYWwtbG9va2luZyBzdXJmYWNlLCBzbyBcIml0IGxvb2tzIHJpZ2h0XCIgY2Fubm90XG4gKiB2ZXJpZnkgQ29udHJhY3QgMS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKGRpc3REaXI6IHN0cmluZyk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIGNvbnN0IG92ZXJyaWRlID0gcHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERTtcbiAgaWYgKG92ZXJyaWRlID09PSBcImRldlwiIHx8IG92ZXJyaWRlID09PSBcInJlbGVhc2VcIikgcmV0dXJuIG92ZXJyaWRlO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKGRpc3REaXIsIFwiaW5kZXguaHRtbFwiKSkgPyBcInJlbGVhc2VcIiA6IFwiZGV2XCI7XG59XG5cbi8qKlxuICogVGhlIGNvbnRlbnQgdHlwZXMgYSBidWlsdCBzdXJmYWNlIGFjdHVhbGx5IHNoaXBzLiBFeHRlbnNpb25zIG91dHNpZGUgdGhlXG4gKiBtYXAgZ2V0IGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gIOKAlCBhIGRlbGliZXJhdGUgcmVmdXNhbCB0byBndWVzcywgc2luY2VcbiAqIGFueXRoaW5nIG5vdCBpbiB0aGlzIGxpc3QgaXMgbm90IHNvbWV0aGluZyBDb250cmFjdCAyJ3MgYnVpbGQgZW1pdHMuXG4gKlxuICog4pqgICoqYGNoYXJzZXQ9dXRmLThgIE9OIEhUTUwgSVMgVEhFIENFTlNVUydTIE9ORSBESVZFUkdFTkNFLCBSRVNPTFZFRCBUT1dBUkRcbiAqIFRIRSBDT1JSRUNUIENPUFkuKiogVGhyZWUgb2YgdGhlIGVpZ2h0IGRhZW1vbnMgY2FycmllZCBpdCBhbmQgZml2ZSBkaWQgbm90O1xuICogdGhlIGNlbnN1cyBncmFkZWQgdGhhdCBgc3RhbGVgIHdpdGggemVybyBkZXNpZ24gY29udGVudC4gSXQgaXMga2VwdCBiZWNhdXNlXG4gKiBpdCBpcyB0aGUgcmlnaHQgYW5zd2VyIOKAlCBhbiBIVE1MIGRvY3VtZW50IHNlcnZlZCB3aXRoIG5vIGNoYXJzZXQgaXMgZGVjb2RlZFxuICogYnkgdGhlIGJyb3dzZXIncyBndWVzcyDigJQgYW5kIGl0IGlzIHRoZSBvbmUgd2lyZS1vYnNlcnZhYmxlIGNoYW5nZSB0aGlzXG4gKiBjb252ZXJnZW5jZSBtYWtlcyB0byBhIHJlc3BvbnNlIGhlYWRlci4gUmVjb3JkZWQgYXMgRC1ub3RlIGluIHRoZSBwaGFzZSBsb2dcbiAqIHJhdGhlciB0aGFuIHNtdWdnbGVkLlxuICovXG5jb25zdCBTVEFUSUNfQ09OVEVOVF9UWVBFUzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIuaHRtbFwiOiBcInRleHQvaHRtbDsgY2hhcnNldD11dGYtOFwiLFxuICBcIi5qc1wiOiBcInRleHQvamF2YXNjcmlwdFwiLFxuICBcIi5jc3NcIjogXCJ0ZXh0L2Nzc1wiLFxuICBcIi5qc29uXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICBcIi5zdmdcIjogXCJpbWFnZS9zdmcreG1sXCIsXG4gIFwiLnBuZ1wiOiBcImltYWdlL3BuZ1wiLFxufTtcblxuLyoqIFRoZSBjb250ZW50IHR5cGUgZm9yIGEgZmlsZW5hbWUgb3IgYW4gZXh0ZW5zaW9uLiBVbmtub3duIGV4dGVuc2lvbnMsIGFuZFxuICogIG5hbWVzIHdpdGggbm8gZXh0ZW5zaW9uIGF0IGFsbCwgZ2V0IGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbnRlbnRUeXBlRm9yKG5hbWVPckV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZG90ID0gbmFtZU9yRXh0Lmxhc3RJbmRleE9mKFwiLlwiKTtcbiAgY29uc3QgZXh0ID0gZG90ID09PSAtMSA/IFwiXCIgOiBuYW1lT3JFeHQuc2xpY2UoZG90KTtcbiAgcmV0dXJuIFNUQVRJQ19DT05URU5UX1RZUEVTW2V4dF0gPz8gXCJhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1cIjtcbn1cblxuLyoqXG4gKiBBbnN3ZXIgT05FIGZpbGUgZnJvbSBgZGlzdERpcmAsIG9yIGBudWxsYCBpZiB0aGUgY2FsbGVyIHNob3VsZCBrZWVwIHJvdXRpbmcuXG4gKlxuICogYHJlbGAgaXMgYSBiYXJlIGZpbGVuYW1lIOKAlCB0aGUgZW50cnkgZG9jdW1lbnQgb3Igb25lIGhhc2hlZCBjaHVuay4gQ29udHJhY3RcbiAqIDIncyBidWlsdCBzdXJmYWNlIGlzIEZMQVQgYW5kIGxpbmtzIGl0cyBjaHVua3MgcmVsYXRpdmVseSwgc28gYSBsZWdpdGltYXRlXG4gKiBhc3NldCByZXF1ZXN0IGlzIG5ldmVyIG5lc3RlZCBhbmQgbmV2ZXIgY29udGFpbnMgYC4uYDsgYm90aCBhcmUgcmVmdXNlZFxuICogaGVyZSByYXRoZXIgdGhhbiBpbiB0aGUgcm91dGVyLCBiZWNhdXNlIHRoZSBndWFyZCBwcm90ZWN0cyB0aGUgcmVhZCBhbmQgdGhlXG4gKiByZWFkIGlzIHdoYXQgbGl2ZXMgaW4gdGhpcyBmaWxlLlxuICpcbiAqIOKaoCBUaGUgcmVmdXNhbCBpcyBhbHNvIHdoYXQga2VlcHMgYW4gYXNzZXQgc2VydmUgY2xlYXIgb2YgYSBzcGVsbCdzIG93blxuICogcm91dGVzOiBtYWdwaWUgaGFzIGFuIGAvYXNzZXRzLzxuYW1lPmAgcm91dGUgb25lIGxldmVsIGRlZXAsIGFuZCB0aGlzXG4gKiByZXR1cm5pbmcgYG51bGxgIG9uIGFueXRoaW5nIHdpdGggYSBzbGFzaCBpbiBpdCBpcyB3aGF0IHN0b3BzIHRoZSB0d29cbiAqIGZpZ2h0aW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2VydmVGcm9tRGlzdChkaXN0RGlyOiBzdHJpbmcsIHJlbDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgaWYgKCFyZWwgfHwgcmVsLmluY2x1ZGVzKFwiLi5cIikgfHwgcmVsLmluY2x1ZGVzKFwiL1wiKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGZpbGUgPSBqb2luKGRpc3REaXIsIHJlbCk7XG4gIGlmICghZXhpc3RzU3luYyhmaWxlKSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBuZXcgUmVzcG9uc2UoQnVuLmZpbGUoZmlsZSksIHsgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBjb250ZW50VHlwZUZvcihyZWwpIH0gfSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIHNlcnZlciBzaWRlIG9mIHRoZSBTU0UgdGFpbCDigJQgdGhlIGRhZW1vbi1zaWRlIHR3aW4gb2ZcbiAqIGB0YWlsRXZlbnRzLnRzYC4gVGhhdCBtb2R1bGUgZGVjaWRlcyB3aGF0IGEgY2FsbGVyIG9ic2VydmVzOyB0aGlzIG9uZSBkZWNpZGVzXG4gKiB3aGF0IGEgY2FsbGVyIGlzIHNlbnQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgZXhjZXB0IGl0c1xuICogb3duIHNpYmxpbmcgdHlwZXMsIHdoaWNoIGlzIHN0aWxsIGluc2lkZSB0aGUgbGVhZi5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgbWluZC1tYXBwZXIncyBgc3NlUmVzcG9uc2VgLFxuICogdGhlIGNlbnN1cydzIGNvbnZlcmdlbmNlIHRhcmdldCAjMTogdGhlIG9ubHkgb25lIG9mIHRoZSBzZXZlbiB3aXRoIGFcbiAqIG9uY2Utb25seSB0ZWFyZG93biBmdW5uZWwsIHRoZSBvbmx5IG9uZSB3aXJlZCB0byBgcmVxLnNpZ25hbGAsIGFuZCB0aGUgb25seVxuICogb25lIHdob3NlIGNvbW1lbnQgcmVjb3JkcyBhIE1FQVNVUkVEIHJlc3VsdCByYXRoZXIgdGhhbiBhIGJlbGllZi5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSLCBSRS1IT01FRDogYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgRE9FUyBOT1QgREVURUNUIEEgREVBRFxuICogICAgQ0xJRU5ULiBNRUFTVVJFRCBPTiBCVU4gMS4zLjE0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFNpeCBkYWVtb25zIHdyaXRlIGEgaGVhcnRiZWF0IGFzIGB0cnkgeyBjb250cm9sbGVyLmVucXVldWUoLi4uKSB9IGNhdGNoIHt9YFxuICogd2l0aCBhIGNvbW1lbnQgc2F5aW5nIHRoZSBjYXRjaCBpcyBob3cgYSBkZXBhcnRlZCBjbGllbnQgaXMgbm90aWNlZC4gSXQgaXNcbiAqIG5vdDogZW5xdWV1ZSBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gQlVGRkVSUyBTSUxFTlRMWSBhbmQgbmV2ZXIgdGhyb3dzLCBzbyB0aGVcbiAqIGNhdGNoIG5ldmVyIGZpcmVzIGFuZCB0aG9zZSBkYWVtb25zJyBkZWFkLWNsaWVudCBkZXRlY3Rpb24gcmVzdHMgb24gYVxuICogbWVjaGFuaXNtIHRoZWlyIG93biBjb21tZW50cyBkZXNjcmliZSBpbmNvcnJlY3RseS4gV2hhdCBhY3R1YWxseSByZWNsYWltcyB0aGVcbiAqIGNvbm5lY3Rpb24gaXMgdGhlIHN0cmVhbSdzIGBjYW5jZWwoKWAg4oCUIGFuZCwgZm9yIGEgY2xpZW50IHRoYXQgbmV2ZXIgY2xvc2VzXG4gKiB0aGUgc29ja2V0LCBgcmVxLnNpZ25hbGAuXG4gKlxuICogU28gdGhlIGZ1bm5lbCBiZWxvdyBpcyB0aGUgbG9hZC1iZWFyaW5nIHBhcnQuIGB0ZWFyZG93bigpYCBydW5zIEFUIE1PU1QgT05DRVxuICogZnJvbSBldmVyeSBwYXRoIHRoZXJlIGlzIOKAlCBgY2FuY2VsKClgLCBhbiBhYm9ydCBvbiB0aGUgcmVxdWVzdCBzaWduYWwsIGFuZFxuICogdGhlIGJlbHQtYW5kLWJyYWNlcyBlbnF1ZXVlIGNhdGNoIOKAlCBhbmQgaXQgaXMgd2hlcmUgdGhlIHN1YnNjcmliZXIgY291bnQgYW5kXG4gKiBhbnkgcHJlc2VuY2UgZGVjcmVtZW50IHJpZGUuIEJvdW5kaW5nIHByZXNlbmNlIGFjY3VyYWN5IGlzIGJvdW5kaW5nIHRoYXRcbiAqIGZ1bm5lbC5cbiAqXG4gKiDimqAgS25vd24gaG9sZSwgYWNjZXB0ZWQgYW5kIGluaGVyaXRlZDogQnVuJ3Mgb3duIGBmZXRjaCgpYCByZWFkZXIgYC5jYW5jZWwoKWBcbiAqIGNsb3NlcyBub3RoaW5nIGNsaWVudC1zaWRlIGFuZCB0aGUgc2VydmVyIGNhbm5vdCBzZWUgaXQuIFJlYWwgY2xpZW50cyBjbG9zZVxuICogdGhlIHNvY2tldC5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEV2ZW50TG9nLCBGcmFtZSB9IGZyb20gXCIuL2V2ZW50TG9nLnRzXCI7XG5cbi8qKlxuICogT25lIG9wZW4gU1NFIHN0cmVhbSwgYXMgdGhlIGRhZW1vbiBjYW4gYWN0IG9uIGl0OiBlbmQgaXQsIG9yIHB1c2ggYSBmcmFtZSB0b1xuICogaXQgdGhhdCBkaWQgbm90IGNvbWUgb3V0IG9mIHRoZSBsb2cuXG4gKlxuICog4puUIElUIElTIE5PVCBBIENPTlRST0xMRVIuIFRoZSBjb3BpZXMgaGVsZFxuICogYFNldDxSZWFkYWJsZVN0cmVhbURlZmF1bHRDb250cm9sbGVyPmAgYW5kIGNsb3NlZCB0aGVtIGRpcmVjdGx5IGF0IHRlYXJkb3duLFxuICogd2hpY2ggYnlwYXNzZXMgdGhlIHRlYXJkb3duIGZ1bm5lbCBhYm92ZSDigJQgdGhlIGhlYXJ0YmVhdCBpbnRlcnZhbCBmb3IgdGhhdFxuICogc3RyZWFtIHdhcyBjbGVhcmVkIG9ubHkgYmVjYXVzZSBhIHNlY29uZCBgU2V0YCBvZiB0aW1lcnMgd2FzIGtlcHQgaW4gcGFyYWxsZWxcbiAqIGFuZCBzd2VwdCBzZXBhcmF0ZWx5LiBFdmVyeXRoaW5nIGhlcmUgZ29lcyB0aHJvdWdoIHRoZSBmdW5uZWwsIGFuZCBhIGBzZW5kYFxuICogYWZ0ZXIgdGVhcmRvd24gaXMgYSBuby1vcCByYXRoZXIgdGhhbiBhIHRocm93LlxuICpcbiAqIOKaoCAqKmBzZW5kYCBBUlJJVkVEIElOIFBIQVNFIDIsIEZST00gVEhFIEZJUlNUIENPTlNVTUVSIFRIQVQgV0FTIE5PVCBPTkUgT0YgVEhFXG4gKiBUV08gVEhJUyBNT0RVTEUgV0FTIERFU0lHTkVEIEFHQUlOU1QuKiogYXN0cm9sYWJlIGFuZCBtYWdwaWUgYW5ub3VuY2UgcHJlc2VuY2VcbiAqIG92ZXIgdGhlaXIgYnJvd3NlciBXRUJTT0NLRVQsIHNvIGEgcmVnaXN0cnkgb2YgYmFyZSBjbG9zZXJzIHdhcyBzdWZmaWNpZW50IGFuZFxuICogdGhlIGJvdW5kYXJ5IGxvb2tlZCByaWdodC4gZ2xhbW91ciBhbm5vdW5jZXMgaXQgb24gdGhlIEFHRU5UJ3MgU1NFIHRhaWwg4oCUXG4gKiBge3R5cGU6XCJjb25uZWN0ZWRcIn1gIC8gYHt0eXBlOlwiZGlzY29ubmVjdGVkXCJ9YCwgZGVsaWJlcmF0ZWx5IHVubG9nZ2VkLCBzbyBhXG4gKiByZWNvbm5lY3RpbmcgYWdlbnQgZG9lcyBub3QgcmUtc2VlIGV2ZXJ5IHBhc3QgY29ubmVjdCBhbmQgc28gdGhlIGZyYW1lIG5ldmVyXG4gKiBhZHZhbmNlcyBhIHRhaWwgY3Vyc29yLiBUaGF0IGlzIG5vdCBhIGdsYW1vdXIgcXVpcms7IGl0IGlzIHRoZSBnZW5lcmFsIHNoYXBlXG4gKiBvZiBcInRlbGwgdGhlIGxpdmUgc3Vic2NyaWJlcnMgc29tZXRoaW5nIHRoYXQgaXMgbm90IHBhcnQgb2YgdGhlIGhpc3RvcnlcIiwgYW5kXG4gKiBhIHJlZ2lzdHJ5IHRoYXQgY2FuIG9ubHkgRU5EIGEgc3RyZWFtIGNhbm5vdCBleHByZXNzIGl0LiBXaXRob3V0IHRoaXMgdGhlXG4gKiBzcGVsbCB3b3VsZCBoYXZlIGhhZCB0byBrZWVwIGl0cyBvd24gcGFyYWxsZWwgYFNldGAgb2YgY29udHJvbGxlcnMsIHdoaWNoIGlzXG4gKiBleGFjdGx5IHRoZSBkcmlmdCB0aGlzIHJlZ2lzdHJ5IGV4aXN0cyB0byByZW1vdmUuXG4gKi9cbmV4cG9ydCB0eXBlIFNzZUNsaWVudCA9IHtcbiAgLyoqIEVuZCB0aGlzIHN0cmVhbSwgdGhyb3VnaCB0aGUgdGVhcmRvd24gZnVubmVsLCBhdCBtb3N0IG9uY2UuICovXG4gIGNsb3NlKCk6IHZvaWQ7XG4gIC8qKiBXcml0ZSBvbmUgcmF3IFNTRSBjaHVuayB0byB0aGlzIHN0cmVhbS4gTm8tb3Agb25jZSB0b3JuIGRvd24uICovXG4gIHNlbmQoY2h1bms6IHN0cmluZyk6IHZvaWQ7XG59O1xuXG4vKipcbiAqIFRoZSBsaXZlLXRhaWwgcmVnaXN0cnkuIGBzaXplYCBpcyB0aGUgZGFlbW9uJ3MgU1NFIHN1YnNjcmliZXIgY291bnQg4oCUIHRoZVxuICogbnVtYmVyIGBzaG91bGRJZGxlQ2xvc2VgIG11c3Qgc2VlIOKAlCBhbmQgY2xvc2luZyBldmVyeSBlbnRyeSBpcyB3aGF0IGEgZHJhaW5cbiAqIGRvZXMuXG4gKi9cbmV4cG9ydCB0eXBlIFNzZUNsaWVudHMgPSBTZXQ8U3NlQ2xpZW50PjtcblxuZXhwb3J0IGludGVyZmFjZSBTc2VPcHRpb25zPFQgZXh0ZW5kcyBvYmplY3Q+IHtcbiAgLyoqIFRoZSBsb2cgdG8gcmVwbGF5IGZyb20gYW5kIHN1YnNjcmliZSB0by4gKi9cbiAgbG9nOiBFdmVudExvZzxUPjtcbiAgLyoqIFRoZSBjYWxsZXIncyByZXN1bWUgY3Vyc29yLiBBYnNlbnQgb3IgdW5wYXJzZWFibGUgcmVwbGF5cyBmcm9tIHRoZSBzdGFydC4gKi9cbiAgc2luY2U6IG51bWJlcjtcbiAgLyoqIEhlYXJ0YmVhdCBjb21tZW50IGludGVydmFsLiBNVVNUIHN0YXkgd2VsbCB1bmRlciB0aGUgc2VydmVyJ3NcbiAgICogIGBpZGxlVGltZW91dGAg4oCUIHNlZSBgaGVhcnRiZWF0LnRzYCwgd2hpY2ggaXMgd2hlcmUgdGhhdCBwYWlyIGxpdmVzLiAqL1xuICBoZWFydGJlYXRNczogbnVtYmVyO1xuICAvKiogTGl2ZW5lc3MgcmVnaXN0cnk7IHRoZSBzdHJlYW0gYWRkcyBpdHNlbGYgb24gb3BlbiBhbmQgcmVtb3ZlcyBpdHNlbGYgaW5cbiAgICogIHRoZSB0ZWFyZG93biBmdW5uZWwuICovXG4gIGNsaWVudHM/OiBTc2VDbGllbnRzO1xuICAvKiogYHJlcS5zaWduYWxgIOKAlCB0aGUgb25seSB0aGluZyB0aGF0IHJlY2xhaW1zIGEgY2xpZW50IHRoYXQgd2VudCBhd2F5XG4gICAqICB3aXRob3V0IGNhbmNlbGxpbmcgdGhlIHN0cmVhbS4gKi9cbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIC8qKiBTZXJ2ZXItc2lkZSBmaWx0ZXIuIEEgcmVqZWN0ZWQgZnJhbWUgaXMgbm90IHNlbnQ7IHRoZSBjbGllbnQgc3RpbGxcbiAgICogIGFkdmFuY2VzIGl0cyBjdXJzb3IgcGFzdCBpdCwgd2hpY2ggaXMgYHRhaWxFdmVudHNgJ3MgZG9jdW1lbnRlZCBydWxlLiAqL1xuICBmaWx0ZXI/OiAoZnJhbWU6IEZyYW1lPFQ+KSA9PiBib29sZWFuO1xuICAvKiogUnVuIGFmdGVyIHRoZSBzdHJlYW0gaXMgc3Vic2NyaWJlZCAocHJlc2VuY2UgdXAsIGFjdGl2aXR5IHRvdWNoKS4gKi9cbiAgb25PcGVuPzogKCkgPT4gdm9pZDtcbiAgLyoqIFJ1biBleGFjdGx5IG9uY2UsIGZyb20gd2hpY2hldmVyIHRlYXJkb3duIHBhdGggZmlyZXMgZmlyc3QuICovXG4gIG9uQ2xvc2U/OiAoKSA9PiB2b2lkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3NlUmVzcG9uc2U8VCBleHRlbmRzIG9iamVjdD4ob3B0czogU3NlT3B0aW9uczxUPik6IFJlc3BvbnNlIHtcbiAgY29uc3QgeyBsb2csIHNpbmNlLCBoZWFydGJlYXRNcywgY2xpZW50cywgc2lnbmFsLCBmaWx0ZXIsIG9uT3Blbiwgb25DbG9zZSB9ID0gb3B0cztcblxuICBsZXQgdW5zdWJzY3JpYmU6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBsZXQga2VlcGFsaXZlOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRJbnRlcnZhbD4gfCBudWxsID0gbnVsbDtcbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICAvLyBUaGUgcmVnaXN0cnkgZW50cnkgZm9yIFRISVMgc3RyZWFtLiBJdHMgbWV0aG9kcyBhcmUgZmlsbGVkIGluIGJ5IGBzdGFydGAsXG4gIC8vIHdoaWNoIGlzIHdoZXJlIHRoZSBjb250cm9sbGVyIGV4aXN0czsgdGhlIG9iamVjdCBpZGVudGl0eSBpcyBzdGFibGUgZnJvbVxuICAvLyBoZXJlIHNvIGB0ZWFyZG93bmAgY2FuIHJlbW92ZSBleGFjdGx5IHRoaXMgZW50cnkuXG4gIGNvbnN0IGNsaWVudDogU3NlQ2xpZW50ID0geyBjbG9zZTogKCkgPT4ge30sIHNlbmQ6ICgpID0+IHt9IH07XG5cbiAgY29uc3QgdGVhcmRvd24gPSAoKSA9PiB7XG4gICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgIGNsb3NlZCA9IHRydWU7XG4gICAgaWYgKGtlZXBhbGl2ZSAhPT0gbnVsbCkgY2xlYXJJbnRlcnZhbChrZWVwYWxpdmUpO1xuICAgIHVuc3Vic2NyaWJlPy4oKTtcbiAgICBjbGllbnRzPy5kZWxldGUoY2xpZW50KTtcbiAgICBvbkNsb3NlPy4oKTtcbiAgfTtcblxuICBjb25zdCBzdHJlYW0gPSBuZXcgUmVhZGFibGVTdHJlYW0oe1xuICAgIHN0YXJ0KGNvbnRyb2xsZXIpIHtcbiAgICAgIGNvbnN0IGVuY29kZXIgPSBuZXcgVGV4dEVuY29kZXIoKTtcbiAgICAgIGNvbnN0IHNhZmVFbnF1ZXVlID0gKGNodW5rOiBzdHJpbmcpID0+IHtcbiAgICAgICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnRyb2xsZXIuZW5xdWV1ZShlbmNvZGVyLmVuY29kZShjaHVuaykpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICB0ZWFyZG93bigpO1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgY2xpZW50LmNsb3NlID0gKCkgPT4ge1xuICAgICAgICB0ZWFyZG93bigpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnRyb2xsZXIuY2xvc2UoKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLyogYWxyZWFkeSBjbG9zZWQgYnkgdGhlIHJ1bnRpbWUgKi9cbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIC8vIOKblCBgc2VuZGAgR09FUyBUSFJPVUdIIGBzYWZlRW5xdWV1ZWAsIHNvIGFuIG91dC1vZi1iYW5kIGZyYW1lIG9iZXlzIHRoZVxuICAgICAgLy8gc2FtZSBjbG9zZWQtY2hlY2sgYW5kIHRoZSBzYW1lIHRlYXJkb3duLW9uLXRocm93IGFzIGEgbG9nZ2VkIG9uZS4gQVxuICAgICAgLy8gZGFlbW9uIG11c3Qgbm90IGJlIGFibGUgdG8gd3JpdGUgdG8gYSBzdHJlYW0gdGhpcyBtb2R1bGUgaGFzIHRvcm4gZG93bi5cbiAgICAgIGNsaWVudC5zZW5kID0gc2FmZUVucXVldWU7XG5cbiAgICAgIC8vIOKblCBBTiBPUEVOSU5HIENPTU1FTlQsIEJFRk9SRSBBTllUSElORyBFTFNFLiBJdCBmbHVzaGVzIHRoZSByZXNwb25zZVxuICAgICAgLy8gaGVhZGVycyBpbW1lZGlhdGVseTogc29tZSBIVFRQIGNsaWVudHMg4oCUIEJ1bidzIG93biBgZmV0Y2goKWAgaW5jbHVkZWQg4oCUXG4gICAgICAvLyBidWZmZXIgdW50aWwgdGhlIGZpcnN0IGJ5dGUgb2YgYm9keSBhcnJpdmVzLCBzbyBhIGdlbnVpbmVseSBxdWlldCBTU0VcbiAgICAgIC8vIHN0cmVhbSB3b3VsZCBvdGhlcndpc2UgbGVhdmUgdGhlIGNhbGxlcidzIGBmZXRjaCgpYCB1bnJlc29sdmVkLiBFdmVyeVxuICAgICAgLy8gaG91c2UgdGFpbCBjbGllbnQgcmVhZHMgYDpgIGxpbmVzIGFzIGNvbW1lbnRzIGFuZCBkcm9wcyB0aGVtLlxuICAgICAgc2FmZUVucXVldWUoXCI6IGNvbm5lY3RlZFxcblxcblwiKTtcblxuICAgICAgdW5zdWJzY3JpYmUgPSBsb2cuc3Vic2NyaWJlKHNpbmNlLCAoZnJhbWUpID0+IHtcbiAgICAgICAgaWYgKGZpbHRlciAmJiAhZmlsdGVyKGZyYW1lKSkgcmV0dXJuO1xuICAgICAgICBzYWZlRW5xdWV1ZShgZGF0YTogJHtKU09OLnN0cmluZ2lmeShmcmFtZSl9XFxuXFxuYCk7XG4gICAgICB9KTtcblxuICAgICAga2VlcGFsaXZlID0gc2V0SW50ZXJ2YWwoKCkgPT4gc2FmZUVucXVldWUoXCI6IGhiXFxuXFxuXCIpLCBoZWFydGJlYXRNcyk7XG4gICAgICBzaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCB0ZWFyZG93biwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgY2xpZW50cz8uYWRkKGNsaWVudCk7XG4gICAgICBvbk9wZW4/LigpO1xuICAgIH0sXG4gICAgY2FuY2VsKCkge1xuICAgICAgdGVhcmRvd24oKTtcbiAgICB9LFxuICB9KTtcblxuICByZXR1cm4gbmV3IFJlc3BvbnNlKHN0cmVhbSwge1xuICAgIGhlYWRlcnM6IHtcbiAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwidGV4dC9ldmVudC1zdHJlYW1cIixcbiAgICAgIFwiQ2FjaGUtQ29udHJvbFwiOiBcIm5vLWNhY2hlXCIsXG4gICAgICBDb25uZWN0aW9uOiBcImtlZXAtYWxpdmVcIixcbiAgICB9LFxuICB9KTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIFRPIEhBTEYgdGhlIGlkbGUgdGltZW91dC5cbiAqXG4gKiBUaGUgY2xhbXAgaXMgYXN0cm9sYWJlJ3MsIGFuZCB0aGUgY2Vuc3VzIG5hbWVkIGl0IGNvbnZlcmdlbmNlIHRhcmdldCAjNDogdGhlXG4gKiBvdGhlciBkYWVtb25zIGhhcmQtY29kZSAxNSBzIGFnYWluc3QgMjU1IHMgYW5kIHdyaXRlIHRoZSByZWxhdGlvbnNoaXAgb25seSBpblxuICogcHJvc2UsIHdoaWNoIGhvbGRzIGF0IHRoZSBkZWZhdWx0IGFuZCBhdCBubyBvdGhlciB2YWx1ZS4gRW5mb3JjaW5nXG4gKiBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgbWFrZXMgdGhlIGludmFyaWFudCB0cnVlIGZvciBBTlkgY29uZmlndXJlZFxuICogcGFpciwgd2hpY2ggaXMgZXhhY3RseSB0aGUgaW52YXJpYW50IHdob3NlIHZpb2xhdGlvbiBjYXVzZWQgdGhlIGJ1ZyBhYm92ZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWluKGludE9yKHJhdywgZmFsbGJhY2spLCBNYXRoLm1heCg1MDAsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKSk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIE1hZ3BpZSdzIGNvbm5lY3Rpb24tdGltaW5nIGNvbnN0YW50cyDigJQgVEhFIE9ORSBDT1BZLCBpbXBvcnRlZCBieSBib3RoIGhhbHZlc1xuICogb2YgdGhlIHNwZWxsLlxuICpcbiAqIOKblCBUSElTIEZJTEUgSVMgVEhFIFNFQU0uIEJlZm9yZSBQaGFzZSAxYiB0aGUgaGVhcnRiZWF0IHdhcyBhIExJVEVSQUwgMTUsMDAwXG4gKiBpbnNpZGUgdGhlIGRhZW1vbidzIGBzc2VSZXNwb25zZWAgYW5kIGEgc2Vjb25kIGxpdGVyYWwgMTUsMDAwIGluIGBjbGkudHNgLFxuICogdW5kZXIgYSBjb21tZW50IG5hbWluZyB0aGUgZmlsZSBhbmQgdGhlIGZ1bmN0aW9uIHRoZSBmaXJzdCBvbmUgbGl2ZWQgaW4uXG4gKiBUaGF0IGlzIHRoZSBzaGFwZSBhIHNoYXJlZCBzcGluZSBleGlzdHMgdG8gZW5kOiB0aGUgQ0xJIGNvdWxkIG5vdCBpbXBvcnQgdGhlXG4gKiBkYWVtb24gd2l0aG91dCBkcmFnZ2luZyB0aGUgd2hvbGUgc2VydmVyIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYCwgc28gdGhlXG4gKiBvbmx5IGF2YWlsYWJsZSBmaXggd2FzIGEgc2VudGVuY2UgYXNraW5nIHRoZSBuZXh0IGF1dGhvciB0byByZW1lbWJlci5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUg4oCUIHNlZSBhc3Ryb2xhYmUncyB0d2luIGZvciB3aHkuXG4gKi9cblxuaW1wb3J0IHtcbiAgREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKiBCdW4ncyBtYXhpbXVtLiBNYWdwaWUgZG9lcyBub3QgZW52LXR1bmUgdGhpcyDigJQgYSBzZXNzaW9uIGRhZW1vbidzIGNvbm5lY3Rpb25cbiAqICBsaWZldGltZSBpcyBub3Qgc29tZXRoaW5nIGEgY2FsbGVyIGhhcyBldmVyIG5lZWRlZCB0byBzaG9ydGVuLiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBNQVhfSURMRV9USU1FT1VUX1NFQztcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBERUZBVUxUX0hFQVJUQkVBVF9NUztcblxuLyoqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMsIERFUklWRUQgcmF0aGVyIHRoYW4gY2hvc2VuLiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUyk7XG4iLAogICAgIi8vIHNyYy9tYWdwaWUvYmFja2VuZC9wZXJzaXN0LnNlcnZlci50c1xuLy8gU2VydmVyL0NMSS1vbmx5IHNuYXBzaG90IHBlcnNpc3RlbmNlIGZvciB0aGUgbWFncGllIGRhZW1vbi4gU25hcHNob3RzIGxpdmVcbi8vIHVuZGVyICRNQUdQSUVfSE9NRS9zbmFwc2hvdHMvPHNlc3Npb25JZD4uanNvbiAoZGVmYXVsdCB+Ly5tYWdwaWUpIHNvIGEgc2Vzc2lvblxuLy8gcmVzdW1lcyBhY3Jvc3MgcmVzdGFydHMgKGNsaS50cyBvcGVuIC0tcmVzdG9yZSA8aWQ+KS4gRG8gTk9UIGltcG9ydCBmcm9tXG4vLyBicm93c2VyIGNvZGUg4oCUIHRoaXMgdXNlcyBub2RlOmZzICsgbm9kZTpvcy5cblxuaW1wb3J0IHsgbWtkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHtcbiAgZGVmYXVsdFN0YXRlLFxuICB0eXBlIE1hZ3BpZVN0YXRlLFxufSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21hZ3BpZS9zaGFyZWQvdHlwZXNcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIG1hZ3BpZUhvbWUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHByb2Nlc3MuZW52Lk1BR1BJRV9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5tYWdwaWVcIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzbmFwc2hvdHNEaXIoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4obWFncGllSG9tZSgpLCBcInNuYXBzaG90c1wiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNuYXBzaG90UGF0aChzZXNzaW9uSWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKHNuYXBzaG90c0RpcigpLCBgJHtzZXNzaW9uSWR9Lmpzb25gKTtcbn1cblxuLy8gUGVyc2lzdCB0aGUgY2Fub25pY2FsIHN0YXRlIChiZXN0LWVmZm9ydCDigJQgcGVyc2lzdGVuY2UgbXVzdCBuZXZlciBjcmFzaCB0aGVcbi8vIGRhZW1vbikuIENhbGxlZCBkZWJvdW5jZWQgKH4xcykgb24gY2hhbmdlIGFuZCBvbmNlIG9uIGNsb3NlLlxuZXhwb3J0IGZ1bmN0aW9uIHNhdmVTbmFwc2hvdChzZXNzaW9uSWQ6IHN0cmluZywgc3RhdGU6IE1hZ3BpZVN0YXRlKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKHNuYXBzaG90c0RpcigpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKHNuYXBzaG90UGF0aChzZXNzaW9uSWQpLCBKU09OLnN0cmluZ2lmeShzdGF0ZSkpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBwZXJzaXN0ZW5jZSBpcyBiZXN0LWVmZm9ydCAqL1xuICB9XG59XG5cbi8vIExvYWQgYSBzbmFwc2hvdCBieSBzZXNzaW9uIGlkIE9SIGFuIGV4cGxpY2l0IHBhdGgsIG1lcmdlZCBvdmVyIGRlZmF1bHRzIHNvIGFuXG4vLyBvbGRlciBzbmFwc2hvdCBnYWlucyBhbnkgbmV3IGZpZWxkcy4gUmV0dXJucyBudWxsIGlmIGl0IGNhbid0IGJlIHJlYWQuXG5leHBvcnQgZnVuY3Rpb24gbG9hZFNuYXBzaG90KGlkT3JQYXRoOiBzdHJpbmcsIHRpdGxlOiBzdHJpbmcpOiBNYWdwaWVTdGF0ZSB8IG51bGwge1xuICBjb25zdCBwYXRoID0gaWRPclBhdGguZW5kc1dpdGgoXCIuanNvblwiKSA/IGlkT3JQYXRoIDogc25hcHNob3RQYXRoKGlkT3JQYXRoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBzbmFwID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSBhcyBQYXJ0aWFsPE1hZ3BpZVN0YXRlPjtcbiAgICBjb25zdCBtZXJnZWQgPSB7IC4uLmRlZmF1bHRTdGF0ZSh0aXRsZSksIC4uLnNuYXAgfSBhcyBNYWdwaWVTdGF0ZTtcbiAgICAvLyBOb3JtYWxpemUgdGhlIHBoYXNlIGN1cnNvciBmb3Igc25hcHNob3RzIHRoYXQgcHJlZGF0ZSB0aGUgcGhhc2Ugc3BpbmUgKG9yXG4gICAgLy8gd2VyZSBzYXZlZCBhdCBpbnRha2Ugd2l0aCBlbGVtZW50cyBhbHJlYWR5IHByZXNlbnQpOiBsYW5kIHRoZW0gaW4gU2xpY2Ugc29cbiAgICAvLyB0aGUgYm9hcmQgcmVuZGVycyBpbnN0ZWFkIG9mIHRoZSBpbnRha2Uvc2Nhbm5pbmcgdmlldy5cbiAgICBpZiAobWVyZ2VkLnBoYXNlID09PSBcImludGFrZVwiICYmIG1lcmdlZC5lbGVtZW50cy5sZW5ndGggPiAwKSBtZXJnZWQucGhhc2UgPSBcInNsaWNlXCI7XG4gICAgcmV0dXJuIG1lcmdlZDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cbiIsCiAgICAiLy8gc3JjL21hZ3BpZS9iYWNrZW5kL3JlZHVjZS50c1xuLy8gUHVyZSwgaW4tcGxhY2UgbXV0YXRvcnMgb3ZlciBNYWdwaWVTdGF0ZSArIHRoZSBsZWFuIHByb2plY3Rpb24uIFRoZSBkYWVtb25cbi8vIChzZXJ2ZXIudHMpIG9yY2hlc3RyYXRlcyB0aGVzZSAoaXQgb3ducyBpZHMsIGJyb2FkY2FzdCwgU1NFKTsgdGhlc2UgZnVuY3Rpb25zXG4vLyBqdXN0IG11dGF0ZSBjYW5vbmljYWwgc3RhdGUgYW5kIHJlcG9ydCB3aGV0aGVyIGFueXRoaW5nIGNoYW5nZWQsIHNvIHRoZXkncmVcbi8vIHVuaXQtdGVzdGFibGUgd2l0aCBubyBzdWJwcm9jZXNzLiBLZWVwIHRoZW0gVEhJTiDigJQgdGhlIG1hZ3BpZS1zcGVjaWZpYyByZXZpZXdcbi8vIG1hY2hpbmVyeSAoanVkZ21lbnQsIGN1dG91dHMpIGlzIG1vY2tlZCBvdXQgZm9yIG5vdzsgd2lkZW4gdGhlc2UgYXMgaXQgbGFuZHMuXG5cbmltcG9ydCB7XG4gIHR5cGUgQmFja2Ryb3AsXG4gIHR5cGUgRWxlbWVudCxcbiAgdHlwZSBFbGVtZW50U3RhdHVzLFxuICB0eXBlIEVsZW1lbnRWZXJzaW9uLFxuICB0eXBlIE1hZ3BpZVN0YXRlLFxuICB0eXBlIE1lc3NhZ2UsXG4gIHR5cGUgTmV3RWxlbWVudCxcbiAgUEhBU0VTLFxuICB0eXBlIFBoYXNlS2V5LFxuICB0eXBlIFNvdXJjZSxcbn0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9tYWdwaWUvc2hhcmVkL3R5cGVzXCI7XG5cbi8vIOKUgOKUgCBpZCBoZWxwZXJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gcmFuZEhleChieXRlczogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgYnVmID0gbmV3IFVpbnQ4QXJyYXkoYnl0ZXMpO1xuICBjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKGJ1Zik7XG4gIHJldHVybiBBcnJheS5mcm9tKGJ1ZiwgKGIpID0+IGIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsIFwiMFwiKSkuam9pbihcIlwiKTtcbn1cbmV4cG9ydCBmdW5jdGlvbiBuZXdJZChwcmVmaXg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtwcmVmaXh9LSR7cmFuZEhleCg0KX1gO1xufVxuXG4vLyDilIDilIAgbXV0YXRvcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCBmdW5jdGlvbiBwdXNoTWVzc2FnZShcbiAgczogTWFncGllU3RhdGUsXG4gIG06IE9taXQ8TWVzc2FnZSwgXCJpZFwiIHwgXCJ0c1wiPiAmIHsgaWQ/OiBzdHJpbmcgfSxcbik6IE1lc3NhZ2Uge1xuICBjb25zdCBtc2c6IE1lc3NhZ2UgPSB7IGlkOiBtLmlkID8/IG5ld0lkKFwibVwiKSwgdHM6IERhdGUubm93KCksIC4uLm0gfSBhcyBNZXNzYWdlO1xuICBzLmNvbnZlcnNhdGlvbi5wdXNoKG1zZyk7XG4gIHJldHVybiBtc2c7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRTdGF0dXMoczogTWFncGllU3RhdGUsIGJ1c3k6IGJvb2xlYW4sIHRleHQgPSBcIlwiKTogdm9pZCB7XG4gIHMuc3RhdHVzID0geyBidXN5LCB0ZXh0IH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRJbnRlbnQoczogTWFncGllU3RhdGUsIGludGVudDogc3RyaW5nKTogdm9pZCB7XG4gIHMuaW50ZW50ID0gaW50ZW50O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0U291cmNlKHM6IE1hZ3BpZVN0YXRlLCBzb3VyY2U6IFNvdXJjZSk6IHZvaWQge1xuICBzLnNvdXJjZSA9IHNvdXJjZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldEVsZW1lbnRzKHM6IE1hZ3BpZVN0YXRlLCBlbGVtZW50czogRWxlbWVudFtdKTogdm9pZCB7XG4gIC8vIFRydXN0IHRoZSBhZ2VudCdzIGRpc2NvdmVyZWQgYnJlYWtkb3duIHdob2xlc2FsZTsgZGVmYXVsdCBhbnkgbWlzc2luZ1xuICAvLyBzdGF0dXMgdG8gXCJwcm9wb3NlZFwiIHNvIHRoZSBzdXJmYWNlIGFsd2F5cyBoYXMgYSBqdWRnZWFibGUgZWxlbWVudCwgYW5kXG4gIC8vIChkZWZlbnNpdmVseSkgbWludCBhbiBpZCBmb3IgYW55IGVsZW1lbnQgcG9zdGVkIHdpdGhvdXQgb25lIOKAlCBkaXNjb3ZlclxuICAvLyBhc3NpZ25zIGlkcywgYnV0IGEgaGFuZC1yb2xsZWQgYGVsZW1lbnRzLnNldGAgYm9keSBtaWdodCBub3QuXG4gIHMuZWxlbWVudHMgPSBlbGVtZW50cy5tYXAoKGUpID0+ICh7XG4gICAgLi4uZSxcbiAgICBpZDogZS5pZCB8fCBuZXdJZChcImVcIiksXG4gICAgc3RhdHVzOiBlLnN0YXR1cyA/PyBcInByb3Bvc2VkXCIsXG4gIH0pKTtcbn1cblxuLy8gRGVmYXVsdCBuYW1lIGZvciBhbiB1bm5hbWVkIGRyYXduIHJlZ2lvbjogcmVnaW9uXzxuPiwgd2hlcmUgbiBpcyBvbmUgcGFzdCB0aGVcbi8vIGNvdW50IG9mIGV4aXN0aW5nIHJlZ2lvbl9cXGQrIG5hbWVzIChzbyBhIGRlbGV0ZS10aGVuLWRyYXcgZG9lc24ndCBjb2xsaWRlIHdpdGhcbi8vIGEgbGl2ZSBvbmUg4oCUIGl0IG51bWJlcnMgb2ZmIHRoZSBjdXJyZW50IHBvcHVsYXRpb24sIHRoZSBjaGVhcCBob3VzZSBoZXVyaXN0aWMpLlxuY29uc3QgUkVHSU9OX1JFID0gL15yZWdpb25fXFxkKyQvO1xuZnVuY3Rpb24gbmV4dFJlZ2lvbk5hbWUoczogTWFncGllU3RhdGUpOiBzdHJpbmcge1xuICBjb25zdCBuID0gcy5lbGVtZW50cy5maWx0ZXIoKGUpID0+IFJFR0lPTl9SRS50ZXN0KGUubmFtZSkpLmxlbmd0aCArIDE7XG4gIHJldHVybiBgcmVnaW9uXyR7bn1gO1xufVxuXG4vLyBBZGQgYSB1c2VyLWRyYXduIChvciBhZ2VudC1ib3hlZCkgcmVnaW9uOiBtaW50IGFuIGlkLCBkZWZhdWx0IG5hbWUvdHlwZS9zdGF0dXMuXG4vLyBSZXR1cm5zIHRoZSBtYXRlcmlhbGl6ZWQgRWxlbWVudCAodGhlIGRhZW1vbiBlbWl0cyBpdCBvbiB0aGUgU1NFL2Jyb2FkY2FzdCkuXG5leHBvcnQgZnVuY3Rpb24gYWRkRWxlbWVudChzOiBNYWdwaWVTdGF0ZSwgZHJhZnQ6IE5ld0VsZW1lbnQpOiBFbGVtZW50IHtcbiAgY29uc3QgZWw6IEVsZW1lbnQgPSB7XG4gICAgaWQ6IG5ld0lkKFwiZVwiKSxcbiAgICBuYW1lOiBkcmFmdC5uYW1lIHx8IG5leHRSZWdpb25OYW1lKHMpLFxuICAgIHR5cGU6IGRyYWZ0LnR5cGUgPz8gXCJvdGhlclwiLFxuICAgIGJib3g6IGRyYWZ0LmJib3gsXG4gICAgc3RhdHVzOiBkcmFmdC5zdGF0dXMgPz8gXCJjb25maXJtZWRcIixcbiAgfTtcbiAgcy5lbGVtZW50cy5wdXNoKGVsKTtcbiAgcmV0dXJuIGVsO1xufVxuXG4vLyBIYXJkLWRlbGV0ZSBhbiBlbGVtZW50IGJ5IGlkIChhIHVzZXIgcmV0cmFjdGluZyBhIGRyYXduIGJveCkuIFJldHVybnMgd2hldGhlclxuLy8gaXQgZXhpc3RlZC5cbmV4cG9ydCBmdW5jdGlvbiByZW1vdmVFbGVtZW50KHM6IE1hZ3BpZVN0YXRlLCBpZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGkgPSBzLmVsZW1lbnRzLmZpbmRJbmRleCgoZSkgPT4gZS5pZCA9PT0gaWQpO1xuICBpZiAoaSA8IDApIHJldHVybiBmYWxzZTtcbiAgcy5lbGVtZW50cy5zcGxpY2UoaSwgMSk7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyBQYXJ0aWFsLW1lcmdlIGFuIGVsZW1lbnQgKHRoZSBhZ2VudCBwb3N0aW5nIG5hbWUvdHlwZS9iYm94L3N0YXR1cyBlZGl0cyBsYW5kc1xuLy8gaGVyZSkuIE5ldmVyIGxldHMgYGlkYCBiZSBvdmVyd3JpdHRlbi4gUmV0dXJucyB0cnVlIGlmIHRoZSBlbGVtZW50IGV4aXN0ZWQuXG4vLyBWZXJzaW9uIHJlc3VsdHMgZG8gTk9UIGZsb3cgdGhyb3VnaCBoZXJlIOKAlCB0aGV5IGFwcGVuZCB2aWEgYWRkVmVyc2lvbiAoYSBsaXN0XG4vLyBvcCwgbm90IGEgZmllbGQgbWVyZ2UpLlxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZUVsZW1lbnQoczogTWFncGllU3RhdGUsIGlkOiBzdHJpbmcsIHBhdGNoOiBQYXJ0aWFsPEVsZW1lbnQ+KTogYm9vbGVhbiB7XG4gIGNvbnN0IGVsID0gcy5lbGVtZW50cy5maW5kKChlKSA9PiBlLmlkID09PSBpZCk7XG4gIGlmICghZWwpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgeyBpZDogX2Ryb3AsIC4uLnJlc3QgfSA9IHBhdGNoO1xuICBPYmplY3QuYXNzaWduKGVsLCByZXN0KTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmNvbnN0IEVMRU1FTlRfU1RBVFVTRVM6IHJlYWRvbmx5IEVsZW1lbnRTdGF0dXNbXSA9IFtcInByb3Bvc2VkXCIsIFwiY29uZmlybWVkXCIsIFwiZHJvcHBlZFwiXTtcblxuZXhwb3J0IGZ1bmN0aW9uIGp1ZGdlRWxlbWVudChzOiBNYWdwaWVTdGF0ZSwgaWQ6IHN0cmluZywgc3RhdHVzOiBFbGVtZW50U3RhdHVzKTogYm9vbGVhbiB7XG4gIGlmICghRUxFTUVOVF9TVEFUVVNFUy5pbmNsdWRlcyhzdGF0dXMpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGVsID0gcy5lbGVtZW50cy5maW5kKChlKSA9PiBlLmlkID09PSBpZCk7XG4gIGlmICghZWwgfHwgZWwuc3RhdHVzID09PSBzdGF0dXMpIHJldHVybiBmYWxzZTtcbiAgZWwuc3RhdHVzID0gc3RhdHVzO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8gRmxhZyAob3IgdW5mbGFnKSBhbiBlbGVtZW50IGZvciBhIHJlLXJ1biDigJQgdGhlIHNvbGUgcmV2aWV3IHNpZ25hbC4gQXBwcm92YWwgaXNcbi8vIHRoZSBhYnNlbmNlIG9mIGEgZmxhZzsgZGlzY2FyZGluZyBpcyBzdGF0dXM6XCJkcm9wcGVkXCIuIFJldHVybnMgd2hldGhlciB0aGUgZmxhZ1xuLy8gYWN0dWFsbHkgY2hhbmdlZCAodGhlIGRhZW1vbiBvbmx5IGJyb2FkY2FzdHMgb24gYSBjaGFuZ2UpLlxuZXhwb3J0IGZ1bmN0aW9uIGZsYWdFbGVtZW50KHM6IE1hZ3BpZVN0YXRlLCBpZDogc3RyaW5nLCBmbGFnZ2VkOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGVsID0gcy5lbGVtZW50cy5maW5kKChlKSA9PiBlLmlkID09PSBpZCk7XG4gIGlmICghZWwpIHJldHVybiBmYWxzZTtcbiAgaWYgKChlbC5mbGFnZ2VkID8/IGZhbHNlKSA9PT0gZmxhZ2dlZCkgcmV0dXJuIGZhbHNlO1xuICBlbC5mbGFnZ2VkID0gZmxhZ2dlZDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIEFwcGVuZCBhIHByb2R1Y2VkIHZlcnNpb24sIFVQU0VSVElORyBieSBtb2RlbDogcmUtcnVubmluZyB0aGUgc2FtZSBtb2RlbFxuLy8gb3ZlcndyaXRlcyBpdHMgcGF0aCArIGJ1bXBzIHJldiAoY2FjaGUtYnVzdCkgYW5kIGtlZXBzIHRoZSBzdGFibGUgaWQ7IGEgbmV3XG4vLyBtb2RlbCBhcHBlbmRzIGEgcm93LiBBIGZyZXNoIHJlc3VsdCBjbGVhcnMgYGZsYWdnZWRgICh0aGUgcmVxdWVzdCBpcyBmdWxmaWxsZWQpXG4vLyBhbmQg4oCUIHVubGVzcyB7IGNob29zZTpmYWxzZSB9IOKAlCBiZWNvbWVzIHRoZSBjaG9zZW4gdmVyc2lvbi4gUmV0dXJucyB0aGUgc3RvcmVkXG4vLyB2ZXJzaW9uLCBvciBudWxsIGlmIHRoZSBlbGVtZW50IGlzIGdvbmUuXG5leHBvcnQgZnVuY3Rpb24gYWRkVmVyc2lvbihcbiAgczogTWFncGllU3RhdGUsXG4gIGlkOiBzdHJpbmcsXG4gIHY6IEVsZW1lbnRWZXJzaW9uLFxuICBvcHRzOiB7IGNob29zZT86IGJvb2xlYW4gfSA9IHt9LFxuKTogRWxlbWVudFZlcnNpb24gfCBudWxsIHtcbiAgY29uc3QgZWwgPSBzLmVsZW1lbnRzLmZpbmQoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgaWYgKCFlbCkgcmV0dXJuIG51bGw7XG4gIGlmICghZWwudmVyc2lvbnMpIGVsLnZlcnNpb25zID0gW107XG4gIGNvbnN0IGV4aXN0aW5nID0gZWwudmVyc2lvbnMuZmluZCgoeCkgPT4geC5tb2RlbCA9PT0gdi5tb2RlbCk7XG4gIGxldCBzdG9yZWQ6IEVsZW1lbnRWZXJzaW9uO1xuICBpZiAoZXhpc3RpbmcpIHtcbiAgICBleGlzdGluZy5wYXRoID0gdi5wYXRoO1xuICAgIGV4aXN0aW5nLnJldiA9IChleGlzdGluZy5yZXYgPz8gMCkgKyAxO1xuICAgIGlmICh2LmtpbmQgIT09IHVuZGVmaW5lZCkgZXhpc3Rpbmcua2luZCA9IHYua2luZDtcbiAgICBpZiAodi5ub3RlICE9PSB1bmRlZmluZWQpIGV4aXN0aW5nLm5vdGUgPSB2Lm5vdGU7XG4gICAgc3RvcmVkID0gZXhpc3Rpbmc7XG4gIH0gZWxzZSB7XG4gICAgc3RvcmVkID0geyAuLi52LCByZXY6IHYucmV2ID8/IDAgfTtcbiAgICBlbC52ZXJzaW9ucy5wdXNoKHN0b3JlZCk7XG4gIH1cbiAgaWYgKG9wdHMuY2hvb3NlID8/IHRydWUpIGVsLmNob3NlblZlcnNpb25JZCA9IHN0b3JlZC5pZDtcbiAgZWwuZmxhZ2dlZCA9IGZhbHNlO1xuICByZXR1cm4gc3RvcmVkO1xufVxuXG4vLyBUaGUgdXNlciBzZWxlY3RpbmcgYSB2ZXJzaW9uIOKGkiBpdCBiZWNvbWVzIGNob3NlbiAoYW1iaWVudCkuIFJldHVybnMgd2hldGhlciBpdFxuLy8gY2hhbmdlZDsgcmVqZWN0cyBhbiB1bmtub3duIGVsZW1lbnQgb3IgYSB2ZXJzaW9uSWQgbm90IHByZXNlbnQgb24gaXQuXG5leHBvcnQgZnVuY3Rpb24gY2hvb3NlVmVyc2lvbihzOiBNYWdwaWVTdGF0ZSwgaWQ6IHN0cmluZywgdmVyc2lvbklkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgZWwgPSBzLmVsZW1lbnRzLmZpbmQoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgaWYgKCFlbCB8fCAhKGVsLnZlcnNpb25zID8/IFtdKS5zb21lKCh2KSA9PiB2LmlkID09PSB2ZXJzaW9uSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmIChlbC5jaG9zZW5WZXJzaW9uSWQgPT09IHZlcnNpb25JZCkgcmV0dXJuIGZhbHNlO1xuICBlbC5jaG9zZW5WZXJzaW9uSWQgPSB2ZXJzaW9uSWQ7XG4gIHJldHVybiB0cnVlO1xufVxuXG5jb25zdCBCQUNLRFJPUFM6IHJlYWRvbmx5IEJhY2tkcm9wW10gPSBbXCJ3aGl0ZVwiLCBcImdyYXlcIiwgXCJibGFja1wiLCBcInRyYW5zcGFyZW50XCJdO1xuXG5leHBvcnQgZnVuY3Rpb24gc2V0QmFja2Ryb3AoczogTWFncGllU3RhdGUsIGJhY2tkcm9wOiBCYWNrZHJvcCk6IGJvb2xlYW4ge1xuICBpZiAoIUJBQ0tEUk9QUy5pbmNsdWRlcyhiYWNrZHJvcCkgfHwgcy5iYWNrZHJvcCA9PT0gYmFja2Ryb3ApIHJldHVybiBmYWxzZTtcbiAgcy5iYWNrZHJvcCA9IGJhY2tkcm9wO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8g4pSA4pSAIHBoYXNlIHNwaW5lIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vLyBBZHZhbmNlIHRoZSBsaW5lYXIgcGhhc2UgY3Vyc29yIHRvIHRoZSBuZXh0IHBoYXNlIOKAlCB3aGF0IHRoZSBzZWFsLWFuZC1oYW5kLW9mZlxuLy8gZ2F0ZSBmaXJlcy4gUmV0dXJucyB0aGUgbmV3IHBoYXNlLCBvciBudWxsIGlmIGFscmVhZHkgYXQgdGhlIGxhc3QgKG5vLW9wKS5cbmV4cG9ydCBmdW5jdGlvbiBhZHZhbmNlUGhhc2UoczogTWFncGllU3RhdGUpOiBQaGFzZUtleSB8IG51bGwge1xuICBjb25zdCBpID0gUEhBU0VTLmluZGV4T2Yocy5waGFzZSk7XG4gIGlmIChpIDwgMCB8fCBpID49IFBIQVNFUy5sZW5ndGggLSAxKSByZXR1cm4gbnVsbDtcbiAgcy5waGFzZSA9IFBIQVNFU1tpICsgMV07XG4gIHJldHVybiBzLnBoYXNlO1xufVxuXG4vLyBTZXQgdGhlIHBoYXNlIGN1cnNvciBkaXJlY3RseSAoYmFjay1uYXYgLyBqdW1wKS4gVmFsaWRhdGVzIGFnYWluc3QgUEhBU0VTO1xuLy8gcmVwb3J0cyB3aGV0aGVyIGl0IGNoYW5nZWQuXG5leHBvcnQgZnVuY3Rpb24gc2V0UGhhc2UoczogTWFncGllU3RhdGUsIHBoYXNlOiBQaGFzZUtleSk6IGJvb2xlYW4ge1xuICBpZiAoIVBIQVNFUy5pbmNsdWRlcyhwaGFzZSkgfHwgcy5waGFzZSA9PT0gcGhhc2UpIHJldHVybiBmYWxzZTtcbiAgcy5waGFzZSA9IHBoYXNlO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8gUmVjb3JkIHRoZSBidWlsdCBleHBvcnQgYnVuZGxlICh0aGUgYWdlbnQgcG9zdHMgaXQgYWZ0ZXIgemlwcGluZykuIFRoZSBzdXJmYWNlXG4vLyBvZmZlcnMgaXQgYXMgYSBkb3dubG9hZCB2aWEgL2Fzc2V0cy88bmFtZT4uXG5leHBvcnQgZnVuY3Rpb24gc2V0QnVuZGxlKHM6IE1hZ3BpZVN0YXRlLCBuYW1lOiBzdHJpbmcsIGNvdW50OiBudW1iZXIpOiB2b2lkIHtcbiAgcy5idW5kbGUgPSB7IG5hbWUsIGNvdW50IH07XG59XG5cbi8vIOKUgOKUgCBsZWFuIHByb2plY3Rpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBTdHJpcCBhbnkgKGV2ZW50dWFsbHkgaGVhdnkpIGlubGluZWQgYmxvYnMgZnJvbSB0aGUgYWdlbnQtZmFjaW5nIC9zdGF0ZSBzbyB0aGVcbi8vIHNuYXBzaG90IHN0YXlzIHNtYWxsOyB0aGUgYWdlbnQgcmVhZHMgb24tZGlzayB2ZXJzaW9uIHBhdGhzIGluc3RlYWQuIFZlcnNpb25zXG4vLyBjYXJyeSBvbmx5IGBwYXRoYCAobm90IGlubGluZWQgaW1hZ2UgZGF0YSksIHNvIHRoaXMgaXMgbmVhci1pZGVudGl0eSDigJQgYnV0IGl0XG4vLyBkZWZlbnNpdmVseSBkcm9wcyBhbnkgYHNyY2AvYGN1dG91dHNgIGZpZWxkcyBhbiBlbGVtZW50IG1pZ2h0IGlubGluZSwgYW5kIG5ldmVyXG4vLyBtdXRhdGVzIHRoZSBzb3VyY2Ugc3RhdGUuXG5leHBvcnQgZnVuY3Rpb24gbGVhblN0YXRlKHM6IE1hZ3BpZVN0YXRlKTogTWFncGllU3RhdGUge1xuICByZXR1cm4ge1xuICAgIC4uLnMsXG4gICAgZWxlbWVudHM6IHMuZWxlbWVudHMubWFwKChlKSA9PiB7XG4gICAgICBjb25zdCBsZWFuID0geyAuLi5lIH0gYXMgRWxlbWVudCAmIHsgc3JjPzogdW5rbm93bjsgY3V0b3V0cz86IHVua25vd24gfTtcbiAgICAgIGRlbGV0ZSBsZWFuLnNyYztcbiAgICAgIGRlbGV0ZSBsZWFuLmN1dG91dHM7XG4gICAgICByZXR1cm4gbGVhbjtcbiAgICB9KSxcbiAgfTtcbn1cbiIsCiAgICAiLy8gc3JjL21hZ3BpZS9iYWNrZW5kL3NvdXJjZS5zZXJ2ZXIudHNcbi8vIFNlcnZlci9DTEktb25seTogbWF0ZXJpYWxpemUgYSB1c2VyLWRyb3BwZWQgY29tcG9zaXRlIChhIGJhc2U2NCBkYXRhLVVSTCB0aGVcbi8vIGJyb3dzZXIgc2VudCBvdmVyIGBzb3VyY2UuaW1wb3J0YCkgb250byB0aGUgcGVyLXNlc3Npb24gZmlsZXMgZGlyLCB0aGVuIGRlcml2ZVxuLy8gdGhlIGNhbm9uaWNhbCBTb3VyY2UgeyBwYXRoLCBzaXplLCBzaGEgfS4gYHBhdGhgIGlzIHRoZSBBQlNPTFVURSBvbi1kaXNrIGZpbGVcbi8vICh0aGUgYWdlbnQgcmVhZHMgKyBjcm9wcyBpdCk7IHRoZSBzdXJmYWNlIHJlbmRlcnMgaXQgdmlhIC9hc3NldHMvPGJhc2VuYW1lPi5cbi8vIERvIE5PVCBpbXBvcnQgZnJvbSBicm93c2VyIGNvZGUg4oCUIHVzZXMgbm9kZTpmcyArIEJ1bi5JbWFnZS9DcnlwdG9IYXNoZXIuXG5cbmltcG9ydCB7IHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdHlwZSB7IFNvdXJjZSB9IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWFncGllL3NoYXJlZC90eXBlc1wiO1xuXG4vLyBkYXRhOjxtaW1lPjtiYXNlNjQsPHBheWxvYWQ+IOKGkiByYXcgYnl0ZXMuIFRvbGVyYXRlcyBhIG1pc3NpbmcgcHJlZml4ICh0cmVhdHNcbi8vIHRoZSB3aG9sZSBzdHJpbmcgYXMgYmFzZTY0KS4gVGhyb3dzIG9uIGFuIGVtcHR5L3VuZGVjb2RhYmxlIHBheWxvYWQuXG5mdW5jdGlvbiBkZWNvZGVEYXRhVXJsKGRhdGFVcmw6IHN0cmluZyk6IFVpbnQ4QXJyYXkge1xuICBjb25zdCBjb21tYSA9IGRhdGFVcmwuaW5kZXhPZihcIixcIik7XG4gIGNvbnN0IGI2NCA9IGNvbW1hID49IDAgPyBkYXRhVXJsLnNsaWNlKGNvbW1hICsgMSkgOiBkYXRhVXJsO1xuICBjb25zdCBieXRlcyA9IEJ1ZmZlci5mcm9tKGI2NCwgXCJiYXNlNjRcIik7XG4gIGlmIChieXRlcy5sZW5ndGggPT09IDApIHRocm93IG5ldyBFcnJvcihcImVtcHR5IGltYWdlIHBheWxvYWRcIik7XG4gIHJldHVybiBuZXcgVWludDhBcnJheShieXRlcyk7XG59XG5cbi8vIFJlZHVjZSBhbiBhcmJpdHJhcnkgY2xpZW50LXN1cHBsaWVkIGZpbGVuYW1lIHRvIGEgc2FmZSBiYXNlbmFtZTogc3RyaXAgYW55XG4vLyBkaXJlY3RvcnkgY29tcG9uZW50cyArIHRyYXZlcnNhbCwga2VlcCBhIHNhbmUgY2hhcnNldCwgZmFsbCBiYWNrIHRvIHNvdXJjZS5wbmcuXG5mdW5jdGlvbiBzYW5pdGl6ZU5hbWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IGJhc2VuYW1lKG5hbWUgfHwgXCJcIikucmVwbGFjZSgvW15BLVphLXowLTkuXy1dL2csIFwiX1wiKTtcbiAgaWYgKCFiYXNlIHx8IGJhc2UgPT09IFwiLlwiIHx8IGJhc2UgPT09IFwiLi5cIiB8fCBiYXNlLnN0YXJ0c1dpdGgoXCIuXCIpKSByZXR1cm4gXCJzb3VyY2UucG5nXCI7XG4gIHJldHVybiBiYXNlO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWF0ZXJpYWxpemVTb3VyY2UoXG4gIGZpbGVzRGlyOiBzdHJpbmcsXG4gIG5hbWU6IHN0cmluZyxcbiAgZGF0YVVybDogc3RyaW5nLFxuKTogUHJvbWlzZTxTb3VyY2U+IHtcbiAgY29uc3QgYnl0ZXMgPSBkZWNvZGVEYXRhVXJsKGRhdGFVcmwpO1xuICBjb25zdCBzYWZlID0gc2FuaXRpemVOYW1lKG5hbWUpO1xuICBjb25zdCBwYXRoID0gam9pbihmaWxlc0Rpciwgc2FmZSk7XG4gIHdyaXRlRmlsZVN5bmMocGF0aCwgYnl0ZXMpO1xuXG4gIGNvbnN0IG1ldGEgPSBhd2FpdCBuZXcgQnVuLkltYWdlKGJ5dGVzKS5tZXRhZGF0YSgpO1xuICBjb25zdCBzaGEgPSBuZXcgQnVuLkNyeXB0b0hhc2hlcihcInNoYTI1NlwiKS51cGRhdGUoYnl0ZXMpLmRpZ2VzdChcImhleFwiKS5zbGljZSgwLCAxNik7XG4gIHJldHVybiB7XG4gICAgcGF0aCxcbiAgICBzaXplOiBbbWV0YS53aWR0aCA/PyAwLCBtZXRhLmhlaWdodCA/PyAwXSxcbiAgICBzaGEsXG4gIH07XG59XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7OztBQTJCQSxzQkFBUyxzQkFBVyx1QkFBUTtBQUM1QjtBQUNBLDBCQUFrQjtBQUNsQjtBQUNBOzs7QUNhTyxJQUFNLFNBQThCLENBQUMsVUFBVSxTQUFTLFVBQVUsUUFBUTtBQTBHMUUsU0FBUyxZQUFZLENBQUMsT0FBNEI7QUFBQSxFQUN2RCxPQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0EsUUFBUTtBQUFBLElBQ1IsT0FBTztBQUFBLElBQ1AsUUFBUTtBQUFBLElBQ1IsVUFBVSxDQUFDO0FBQUEsSUFDWCxjQUFjLENBQUM7QUFBQSxJQUNmLFVBQVU7QUFBQSxJQUNWLFFBQVEsRUFBRSxNQUFNLE9BQU8sTUFBTSxHQUFHO0FBQUEsRUFDbEM7QUFBQTtBQXFFSyxJQUFNLG9CQUFvQixPQUFPLE9BQU87QUFBQSxFQUM3QztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNGLENBQVU7OztBQ3JPVjtBQXFCTyxTQUFTLGVBQWUsQ0FBQyxRQUFnQixNQUFvQjtBQUFBLEVBQ2xFLE1BQU0sTUFBTSxHQUFHLFVBQVUsUUFBUTtBQUFBLEVBQ2pDLElBQUk7QUFBQSxJQUNGLGNBQWMsS0FBSyxJQUFJO0FBQUEsSUFDdkIsV0FBVyxLQUFLLE1BQU07QUFBQSxJQUN0QixPQUFPLEtBQUs7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
