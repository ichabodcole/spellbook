#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// src/magpie/backend/server.ts
import { existsSync, mkdirSync as mkdirSync2, renameSync, rmSync, unlinkSync, writeFileSync as writeFileSync3 } from "fs";
import { tmpdir } from "os";
import { dirname, join as join3 } from "path";
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

// src/magpie/backend/persist.server.ts
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
function magpieHome() {
  return process.env.MAGPIE_HOME ?? join(homedir(), ".magpie");
}
function snapshotsDir() {
  return join(magpieHome(), "snapshots");
}
function snapshotPath(sessionId) {
  return join(snapshotsDir(), `${sessionId}.json`);
}
function saveSnapshot(sessionId, state) {
  try {
    mkdirSync(snapshotsDir(), { recursive: true });
    writeFileSync(snapshotPath(sessionId), JSON.stringify(state));
  } catch {}
}
function loadSnapshot(idOrPath, title) {
  const path = idOrPath.endsWith(".json") ? idOrPath : snapshotPath(idOrPath);
  try {
    const snap = JSON.parse(readFileSync(path, "utf8"));
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
import { writeFileSync as writeFileSync2 } from "fs";
import { basename, join as join2 } from "path";
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
  const path = join2(filesDir, safe);
  writeFileSync2(path, bytes);
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
var SKILL_ROOT = join3(SCRIPT_DIR, "..");
var DIST_DIR = join3(SKILL_ROOT, "dist");
function resolveMode() {
  const override = process.env.SPELLBOOK_SURFACE_MODE;
  if (override === "dev" || override === "release")
    return override;
  return existsSync(join3(DIST_DIR, "index.html")) ? "release" : "dev";
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
  const file = join3(DIST_DIR, rel);
  if (!existsSync(file))
    return null;
  const ext = rel.slice(rel.lastIndexOf("."));
  return new Response(Bun.file(file), {
    headers: { "Content-Type": STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream" }
  });
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
        broadcastPresence();
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
        broadcastPresence();
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
  let sessionFilesDir = "";
  const mode = resolveMode();
  const devIndex = mode === "dev" ? (await import("../../../../../src/magpie/surface/index.html")).default : undefined;
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
          const f = Bun.file(join3(sessionFilesDir, assetName));
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
  sessionFilesDir = join3(tmpdir(), `${sessionId}-files`);
  try {
    mkdirSync2(sessionFilesDir, { recursive: true });
  } catch {}
  if (restored)
    saveSnapshot(sessionId, state);
  const url = `http://${host}:${boundPort}`;
  emitEvent({ type: "ready", url, port: boundPort, session_id: sessionId, mode });
  const sessionFile = join3(tmpdir(), `magpie-${sessionId}.json`);
  const latestFile = join3(tmpdir(), `magpie-latest.json`);
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
      writeFileSync3(tmp, text);
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
    process.stderr.write(`magpie: could not write discovery file: ${e instanceof Error ? e.message : String(e)}
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
      saveSnapshot(sessionId, state);
    }
  }, 1000);
  const { code, reason } = await done;
  clearInterval(idleTimer);
  clearInterval(snapTimer);
  saveSnapshot(sessionId, state);
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
  snapshotsDir,
  run,
  parsePortFromSessionId,
  main,
  leanState,
  defaultState
};

//# debugId=C89E740B1F8CC51664756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL21hZ3BpZS9iYWNrZW5kL3NlcnZlci50cyIsICIuLi9zaGFyZWQvdHlwZXMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL21hZ3BpZS9iYWNrZW5kL3BlcnNpc3Quc2VydmVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9tYWdwaWUvYmFja2VuZC9yZWR1Y2UudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL21hZ3BpZS9iYWNrZW5kL3NvdXJjZS5zZXJ2ZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIG1hZ3BpZSDigJQgYSBzdGFuZGluZyBjb25qdXJhdGlvbiBvdmVyIGEgY29tcG9zaXRlIGltYWdlLlxuLy9cbi8vIFRoZSBkYWVtb24gaG9sZHMgdGhlIGNhbm9uaWNhbCBleHRyYWN0aW9uIHN0YXRlOyB0aGUgUmVhY3Qgc3VyZmFjZSBzaG93cyB0aGVcbi8vIGVsZW1lbnQgYnJlYWtkb3duLCB0aGUgdXNlciBqdWRnZXMgZWFjaCBjdXRvdXQsIGNvbXBhcmVzIHJlbW92YWwtbW9kZWxcbi8vIHJlc3VsdHMsIGFuZCBzZWxlY3RpdmVseSByZXRyaWVzLiBUaGUgYWdlbnQgZHJpdmVzIGRpc2NvdmVyeSArIGV4dHJhY3Rpb24gb3V0XG4vLyBvZiBiYW5kIGFuZCBwb3N0cyByZXN1bHRzIGhlcmU7IHRoZSBzdXJmYWNlIGlzIHdoZXJlIHRoZSB1c2VyIHN0ZWVycy5cbi8vXG4vLyBBcmNoaXRlY3R1cmUgKGNsaS50cyB3cmFwcyB0aGlzKTpcbi8vICAgLSBBZ2VudCDihpQgc2VydmVyOiBIVFRQIG9uIHRoZSBzYW1lIEJ1bi5zZXJ2ZS5cbi8vICAgICAgIFBPU1QgL2NtZCAgICAgICAgICAgIOKAlCBhZ2VudCBjb21tYW5kIChKU09OOyBBZ2VudENvbW1hbmQgdW5pb24pXG4vLyAgICAgICBHRVQgIC9zdGF0ZVs/bGVhbj0xXSDigJQgZnVsbCBzbmFwc2hvdCB7IHN0YXRlLCBjdXJzb3IgfTsgbGVhbiBzdHJpcHMgYmxvYnNcbi8vICAgICAgIEdFVCAgL2V2ZW50cz9zaW5jZT1OIOKAlCBTU0Ugc3RyZWFtIG9mIHVzZXIgZXZlbnRzIChNb25pdG9yLXdyYXBwYWJsZSlcbi8vICAgLSBTZXJ2ZXIg4oaUIGJyb3dzZXI6IFdlYlNvY2tldCBhdCAvd3MgKENsaWVudFRvU2VydmVyIC8gU2VydmVyVG9DbGllbnQpLlxuLy8gICAtIEdFVCAvYXNzZXRzLzxuYW1lPiAgICAg4oCUIHNlcnZlIHBlci1zZXNzaW9uIGZpbGVzIChzb3VyY2UvY3V0b3V0cykgZnJvbSBhXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBlci1zZXNzaW9uIHRtcCBkaXIsIHNhbml0aXplZCBhZ2FpbnN0IHRyYXZlcnNhbC5cbi8vICAgLSBTZXJ2ZXIgaG9sZHMgY2Fub25pY2FsIHN0YXRlOyBmdWxsLXN0YXRlIGJyb2FkY2FzdCB0byBicm93c2VycyBvbiBjaGFuZ2UuXG4vL1xuLy8gVGhlIHNpbmdsZSBjb250cmFjdCBpcyBzaGFyZWQvdHlwZXMudHMgKHRoZSBBZ2VudENvbW1hbmQgLyBDbGllbnRUb1NlcnZlclxuLy8gdW5pb25zICsgQUdFTlRfRVZFTlRfVFlQRVMpIOKAlCBUV08tU0lERUQsIHNvIGl0IHNpdHMgaW4gdGhlIHNwZWxsJ3Mgb3duXG4vLyBzaGFyZWQvIHJhdGhlciB0aGFuIGluIGVpdGhlciBzaWRlJ3MgdHJlZS4gUHVyZSBtdXRhdG9ycyBsaXZlIGluXG4vLyBzY3JpcHRzL3JlZHVjZS50cyBhbmQgc25hcHNob3QgcGVyc2lzdGVuY2UgaW4gc2NyaXB0cy9wZXJzaXN0LnNlcnZlci50cztcbi8vIGJvdGggYXJlIGRhZW1vbi1vbmx5IGFuZCBuZWl0aGVyIGlzIGltcG9ydGVkIGJ5IGJyb3dzZXIgY29kZS5cbi8vXG4vLyBFeGl0IGNvZGVzOiAwIHN1Ym1pdC9jbG9zZSwgMiBiYWQgYXJncywgMTI0IGlkbGUgdGltZW91dCwgMTMwIGNhbmNlbC5cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCByZW5hbWVTeW5jLCBybVN5bmMsIHVubGlua1N5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5pbXBvcnQgdHlwZSB7IFNlcnZlcldlYlNvY2tldCB9IGZyb20gXCJidW5cIjtcbmltcG9ydCB7XG4gIHR5cGUgQWdlbnRDb21tYW5kLFxuICB0eXBlIEJhY2tkcm9wLFxuICB0eXBlIENsaWVudFRvU2VydmVyLFxuICBkZWZhdWx0U3RhdGUsXG4gIHR5cGUgRWxlbWVudCxcbiAgdHlwZSBFbGVtZW50U3RhdHVzLFxuICB0eXBlIE1hZ3BpZVN0YXRlLFxuICB0eXBlIFBoYXNlS2V5LFxufSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21hZ3BpZS9zaGFyZWQvdHlwZXNcIjtcbmltcG9ydCB7IGxvYWRTbmFwc2hvdCwgc2F2ZVNuYXBzaG90LCBzbmFwc2hvdHNEaXIgfSBmcm9tIFwiLi9wZXJzaXN0LnNlcnZlclwiO1xuaW1wb3J0IHtcbiAgYWRkRWxlbWVudCxcbiAgYWRkVmVyc2lvbixcbiAgYWR2YW5jZVBoYXNlLFxuICBjaG9vc2VWZXJzaW9uLFxuICBmbGFnRWxlbWVudCxcbiAganVkZ2VFbGVtZW50LFxuICBsZWFuU3RhdGUsXG4gIHB1c2hNZXNzYWdlLFxuICByZW1vdmVFbGVtZW50LFxuICBzZXRCYWNrZHJvcCxcbiAgc2V0QnVuZGxlLFxuICBzZXRFbGVtZW50cyxcbiAgc2V0SW50ZW50LFxuICBzZXRQaGFzZSxcbiAgc2V0U291cmNlLFxuICBzZXRTdGF0dXMsXG4gIHVwZGF0ZUVsZW1lbnQsXG59IGZyb20gXCIuL3JlZHVjZVwiO1xuaW1wb3J0IHsgbWF0ZXJpYWxpemVTb3VyY2UgfSBmcm9tIFwiLi9zb3VyY2Uuc2VydmVyXCI7XG5cbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSk7XG5cbi8vIOKUgOKUgCBzdXJmYWNlIG1vZGUgKHNlYW1zIENvbnRyYWN0IDEpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIGBpbXBvcnQgaW5kZXggZnJvbSBcIi4uL3N1cmZhY2UvaW5kZXguaHRtbFwiYCB1c2VkIHRvIHNpdCBhdCB0aGUgdG9wIG9mIHRoaXNcbi8vIGZpbGUuIEEgdG9wLWxldmVsIFNUQVRJQyBpbXBvcnQgZm9yY2VzIEJ1biB0byByZXNvbHZlIHRoZSB3aG9sZSAudHN4ICtcbi8vIFRhaWx3aW5kIGJ1aWxkIGdyYXBoIHdoZW4gdGhlIG1vZHVsZSBMT0FEUywgc28gYSBkZXN0aW5hdGlvbiB0aGF0IHNoaXBzXG4vLyBkaXN0LyBhbmQgbm8gc3VyZmFjZS8g4oCUIHRoZSBwdWJsaXNoZWQgYXJ0aWZhY3Qg4oCUIGRpZXMgYmVmb3JlIGl0IGNhbiBzZXJ2ZVxuLy8gdGhlIGRpc3QgaXQgZG9lcyBoYXZlLiBUaGUgZGV2IGltcG9ydCBpcyB0aGVyZWZvcmUgZHluYW1pYyBhbmQgcmVhY2hlZCBvbmx5XG4vLyBvbiB0aGUgZGV2IGJyYW5jaCwgYXMgYXN0cm9sYWJlLCBpbWFnbyBhbmQgbWluZC1tYXBwZXIgYWxsIGRvIGl0LlxuLy9cbi8vIOKblCBNQUdQSUUnUyBkaXN0LyBBTFJFQURZIEVYSVNURUQsIEhPTERJTkcgY2xpLmpzIEFORCBOTyBpbmRleC5odG1sIOKAlCB3aGljaFxuLy8gaXMgcHJlY2lzZWx5IHdoeSB0aGlzIGRhZW1vbiBzdGF5ZWQgY29ycmVjdGx5IGluIERFViBtb2RlIHRocm91Z2ggYWxsIG9mXG4vLyBTbGljZSAyLiBUaGUgRklSU1Qgc3VyZmFjZSBidWlsZCB0byBsYW5kIGFuIGluZGV4Lmh0bWwgaGVyZSBGTElQU1xuLy8gcmVzb2x2ZU1vZGUoKSwgYW5kIG5vdGhpbmcgYW5ub3VuY2VzIHRoZSB0cmFuc2l0aW9uLiBgZGlzdC9gIGV4aXN0aW5nIGlzIG5vdFxuLy8gdGhlIGRpc2NyaW1pbmF0b3I7IGBkaXN0L2luZGV4Lmh0bWxgIGlzLlxuLy9cbi8vIFBhdGhzIGFuY2hvciBhdCB0aGUgU0tJTEwgUk9PVCwgbmV2ZXIgYXQgY3dkOiBjbGkudHMgcGlucyB0aGUgZGFlbW9uJ3MgY3dkXG4vLyBmb3IgYnVuZmlnLnRvbWwncyBzYWtlIChDb250cmFjdCA1KSwgc28gY3dkIGlzIG5vdCBhIHN0YWJsZSBiYXNlIGZvciBkaXN0Ly5cbi8vXG4vLyDim5QgYFNDUklQVF9ESVJgIEhFUkUgSVMgVEhFIERJUkVDVE9SWSBPRiBUSEUgRU1JVFRFRCBCVU5ETEUsIE5PVCBPRiBUSElTIEZJTEUuXG4vLyBUaGlzIG1vZHVsZSBpcyBBVVRIT1JFRCBhdCBgc3JjL21hZ3BpZS9iYWNrZW5kL3NlcnZlci50c2AgYW5kIEVYRUNVVEVTIGFzXG4vLyBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21hZ3BpZS9kaXN0L3NlcnZlci5qc2AgKFBoYXNlIDFiKS4gYGRpc3QvYCBzaXRzIGF0XG4vLyB0aGUgU0FNRSBERVBUSCBhcyB0aGUgYHNjcmlwdHMvYCBpdCByZXBsYWNlZCwgc28gZXZlcnkgQU5DRVNUT1ItcmVsYXRpdmUgcGF0aFxuLy8gYmVsb3cgaXMgdW5jaGFuZ2VkIGJ5IHRoZSBtb3ZlLiBBIFNJQkxJTkctcmVsYXRpdmUgb25lIGlzIE5PVCDigJQgc2VlXG4vLyBgYmFja2VuZC50c2AncyBgcmVtb3ZlLnB5YCwgd2hpY2ggaXMgd2hlcmUgZXhhY3RseSB0aGF0IHdlbnQgd3JvbmcgYW5kXG4vLyBzaGlwcGVkLiBBc3NlcnRlZCBpbiBgc2VydmVyLnRlc3QudHNgLCBub3QgcmVhc29uZWQgYWJvdXQuXG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcblxuLy8gcmVsZWFzZSBpZmYgZGlzdC9pbmRleC5odG1sIGV4aXN0cyBhdCB0aGUgc2tpbGwgcm9vdCwgZWxzZSBkZXY7IHRoZSBlbnZcbi8vIG92ZXJyaWRlIHdpbnMgZWl0aGVyIHdheSAoc2VhbXMgQ29udHJhY3QgMSkuIFJlbGVhc2U6IHplcm8gcmVhZHMgb2Ygc3VyZmFjZS9cbi8vIG9yIGJ1bmZpZy50b21sIOKAlCBzdGF0aWMgZmlsZXMgb25seS5cbmZ1bmN0aW9uIHJlc29sdmVNb2RlKCk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIGNvbnN0IG92ZXJyaWRlID0gcHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERTtcbiAgaWYgKG92ZXJyaWRlID09PSBcImRldlwiIHx8IG92ZXJyaWRlID09PSBcInJlbGVhc2VcIikgcmV0dXJuIG92ZXJyaWRlO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gXCJyZWxlYXNlXCIgOiBcImRldlwiO1xufVxuXG5jb25zdCBTVEFUSUNfQ09OVEVOVF9UWVBFUzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIuaHRtbFwiOiBcInRleHQvaHRtbFwiLFxuICBcIi5qc1wiOiBcInRleHQvamF2YXNjcmlwdFwiLFxuICBcIi5jc3NcIjogXCJ0ZXh0L2Nzc1wiLFxuICBcIi5qc29uXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICBcIi5zdmdcIjogXCJpbWFnZS9zdmcreG1sXCIsXG4gIFwiLnBuZ1wiOiBcImltYWdlL3BuZ1wiLFxufTtcblxuLy8gU2VydmVzIGRpc3QvIHZlcmJhdGltIOKAlCBlbnRyeSBpbmRleC5odG1sLCBoYXNoZWQgY2h1bmstKi5qcy9jc3MgYnkgcGF0aFxuLy8gKENvbnRyYWN0IDIncyBmbGF0LCByZWxhdGl2ZS1ocmVmIGxheW91dCkuIFBhdGggdHJhdmVyc2FsIGd1YXJkZWQgKGEgc3RhdGljXG4vLyBhc3NldCByZXF1ZXN0IGlzIGFsd2F5cyBhIGJhcmUgZmlsZW5hbWUsIG5ldmVyIG5lc3RlZCksIHdoaWNoIGlzIGFsc28gd2hhdFxuLy8ga2VlcHMgdGhpcyBjbGVhciBvZiBtYWdwaWUncyBvd24gL2Fzc2V0cy88bmFtZT4gcm91dGUgYWJvdmUgaXQuXG5mdW5jdGlvbiBzZXJ2ZURpc3QocGF0aDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgY29uc3QgcmVsID0gcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSk7XG4gIGlmIChyZWwuaW5jbHVkZXMoXCIuLlwiKSB8fCByZWwuaW5jbHVkZXMoXCIvXCIpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZmlsZSA9IGpvaW4oRElTVF9ESVIsIHJlbCk7XG4gIGlmICghZXhpc3RzU3luYyhmaWxlKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGV4dCA9IHJlbC5zbGljZShyZWwubGFzdEluZGV4T2YoXCIuXCIpKTtcbiAgcmV0dXJuIG5ldyBSZXNwb25zZShCdW4uZmlsZShmaWxlKSwge1xuICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogU1RBVElDX0NPTlRFTlRfVFlQRVNbZXh0XSA/PyBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiIH0sXG4gIH0pO1xufVxuXG50eXBlIENsb3NlUmVhc29uID0gXCJzdWJtaXRcIiB8IFwiY2FuY2VsXCIgfCBcInRpbWVvdXRcIiB8IFwiY2xvc2VcIjtcbnR5cGUgRG9uZVJlc3VsdCA9IHsgY29kZTogbnVtYmVyOyByZWFzb246IENsb3NlUmVhc29uIH07XG5cbmNvbnN0IFBPUlRfU1VGRklYX1JFID0gLy1wKFxcZHsyLDV9KSQvO1xuZnVuY3Rpb24gcGFyc2VQb3J0RnJvbVNlc3Npb25JZChzaWQ6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuICBjb25zdCBtID0gc2lkPy5tYXRjaChQT1JUX1NVRkZJWF9SRSk7XG4gIGlmICghbSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHBvcnQgPSBwYXJzZUludChtWzFdLCAxMCk7XG4gIHJldHVybiBwb3J0ID49IDEgJiYgcG9ydCA8PSA2NTUzNSA/IHBvcnQgOiBudWxsO1xufVxuXG5mdW5jdGlvbiByYW5kSGV4KGJ5dGVzOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBidWYgPSBuZXcgVWludDhBcnJheShieXRlcyk7XG4gIGNyeXB0by5nZXRSYW5kb21WYWx1ZXMoYnVmKTtcbiAgcmV0dXJuIEFycmF5LmZyb20oYnVmLCAoYikgPT4gYi50b1N0cmluZygxNikucGFkU3RhcnQoMiwgXCIwXCIpKS5qb2luKFwiXCIpO1xufVxuXG5mdW5jdGlvbiBvcGVuQnJvd3Nlcih1cmw6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBjbWQgPVxuICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCJcbiAgICAgID8gW1wib3BlblwiLCB1cmxdXG4gICAgICA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIlxuICAgICAgICA/IFtcImNtZFwiLCBcIi9jXCIsIFwic3RhcnRcIiwgXCJcIiwgdXJsXVxuICAgICAgICA6IFtcInhkZy1vcGVuXCIsIHVybF07XG4gIHRyeSB7XG4gICAgQnVuLnNwYXduKHsgY21kLCBzdGRvdXQ6IFwiaWdub3JlXCIsIHN0ZGVycjogXCJpZ25vcmVcIiB9KTtcbiAgfSBjYXRjaCB7XG4gICAgLyogYmVzdC1lZmZvcnQgKi9cbiAgfVxufVxuXG5jb25zdCBNSU1FX0JZX0VYVDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIucG5nXCI6IFwiaW1hZ2UvcG5nXCIsXG4gIFwiLmpwZ1wiOiBcImltYWdlL2pwZWdcIixcbiAgXCIuanBlZ1wiOiBcImltYWdlL2pwZWdcIixcbiAgXCIuZ2lmXCI6IFwiaW1hZ2UvZ2lmXCIsXG4gIFwiLnN2Z1wiOiBcImltYWdlL3N2Zyt4bWxcIixcbiAgXCIud2VicFwiOiBcImltYWdlL3dlYnBcIixcbn07XG5mdW5jdGlvbiBndWVzc01pbWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZG90ID0gbmFtZS5sYXN0SW5kZXhPZihcIi5cIik7XG4gIGNvbnN0IGV4dCA9IGRvdCA+PSAwID8gbmFtZS5zbGljZShkb3QpLnRvTG93ZXJDYXNlKCkgOiBcIlwiO1xuICByZXR1cm4gTUlNRV9CWV9FWFRbZXh0XSB8fCBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgbGV0IHBhcnNlZDogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VBcmdzPjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBwYXJzZUFyZ3Moe1xuICAgICAgYXJnczogYXJndixcbiAgICAgIG9wdGlvbnM6IHtcbiAgICAgICAgdGl0bGU6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVmYXVsdDogXCJtYWdwaWVcIiB9LFxuICAgICAgICBpbnRlbnQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIsIGRlZmF1bHQ6IFwiMTgwMFwiIH0sXG4gICAgICAgIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiLCBkZWZhdWx0OiBmYWxzZSB9LFxuICAgICAgICBwb3J0OiB7IHR5cGU6IFwic3RyaW5nXCIsIGRlZmF1bHQ6IFwiMFwiIH0sXG4gICAgICAgIGhvc3Q6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVmYXVsdDogXCIxMjcuMC4wLjFcIiB9LFxuICAgICAgICBpZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LCAvLyBzbmFwc2hvdCBwYXRoIG9yIHNlc3Npb24gaWQgdG8gcmVzdW1lXG4gICAgICB9LFxuICAgICAgc3RyaWN0OiB0cnVlLFxuICAgICAgYWxsb3dQb3NpdGlvbmFsczogZmFsc2UsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgZXJyb3I6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIGNvbnN0IHYgPSBwYXJzZWQudmFsdWVzO1xuICBjb25zdCB0aW1lb3V0ID0gcGFyc2VGbG9hdCh2LnRpbWVvdXQgYXMgc3RyaW5nKTtcbiAgbGV0IHBvcnQgPSBwYXJzZUludCh2LnBvcnQgYXMgc3RyaW5nLCAxMCk7XG4gIGNvbnN0IGhvc3QgPSB2Lmhvc3QgYXMgc3RyaW5nO1xuICBsZXQgc2Vzc2lvbklkID0gKHYuaWQgYXMgc3RyaW5nIHwgdW5kZWZpbmVkKSA/PyBcIlwiO1xuICBpZiAocG9ydCA9PT0gMCAmJiBzZXNzaW9uSWQpIHtcbiAgICBjb25zdCBlbWJlZGRlZCA9IHBhcnNlUG9ydEZyb21TZXNzaW9uSWQoc2Vzc2lvbklkKTtcbiAgICBpZiAoZW1iZWRkZWQgIT09IG51bGwpIHBvcnQgPSBlbWJlZGRlZDtcbiAgfVxuXG4gIGxldCBzdGF0ZTogTWFncGllU3RhdGUgPSBkZWZhdWx0U3RhdGUodi50aXRsZSBhcyBzdHJpbmcpO1xuICBpZiAodHlwZW9mIHYuaW50ZW50ID09PSBcInN0cmluZ1wiKSBzdGF0ZS5pbnRlbnQgPSB2LmludGVudDtcbiAgbGV0IHJlc3RvcmVkID0gZmFsc2U7XG4gIGlmICh2LnJlc3RvcmUpIHtcbiAgICBjb25zdCBsb2FkZWQgPSBsb2FkU25hcHNob3Qodi5yZXN0b3JlIGFzIHN0cmluZywgdi50aXRsZSBhcyBzdHJpbmcpO1xuICAgIGlmIChsb2FkZWQpIHtcbiAgICAgIHN0YXRlID0gbG9hZGVkO1xuICAgICAgcmVzdG9yZWQgPSB0cnVlO1xuICAgIH0gZWxzZSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgbWFncGllOiByZXN0b3JlIGZhaWxlZCAoJHt2LnJlc3RvcmV9KVxcbmApO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHNvY2tldHMgPSBuZXcgU2V0PFNlcnZlcldlYlNvY2tldDx1bmtub3duPj4oKTtcbiAgY29uc3QgZW5jID0gbmV3IFRleHRFbmNvZGVyKCk7XG5cbiAgLy8gQXBwZW5kLW9ubHkgZXZlbnQgbG9nIGZvciB0aGUgYWdlbnQncyBTU0UgdGFpbDsgbW9ub3RvbmljIGlkcyBzbyBhXG4gIC8vIHJlY29ubmVjdGluZyB0YWlsIHJlcGxheXMgdmlhID9zaW5jZT08aWQ+LlxuICBjb25zdCBldmVudHM6IEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9IFtdO1xuICBsZXQgZXZlbnRTZXEgPSAwO1xuICBjb25zdCBzc2VDbGllbnRzID0gbmV3IFNldDxSZWFkYWJsZVN0cmVhbURlZmF1bHRDb250cm9sbGVyPigpO1xuICBjb25zdCBzc2VUaW1lcnMgPSBuZXcgU2V0PFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPj4oKTtcblxuICBsZXQgcmVzb2x2ZURvbmUhOiAodmFsOiBEb25lUmVzdWx0KSA9PiB2b2lkO1xuICBsZXQgc2V0dGxlZCA9IGZhbHNlO1xuICBjb25zdCBkb25lID0gbmV3IFByb21pc2U8RG9uZVJlc3VsdD4oKHJlcykgPT4ge1xuICAgIHJlc29sdmVEb25lID0gKHZhbCkgPT4ge1xuICAgICAgaWYgKHNldHRsZWQpIHJldHVybjtcbiAgICAgIHNldHRsZWQgPSB0cnVlO1xuICAgICAgcmVzKHZhbCk7XG4gICAgfTtcbiAgfSk7XG5cbiAgbGV0IGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICBjb25zdCB0b3VjaCA9ICgpID0+IHtcbiAgICBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgfTtcblxuICBmdW5jdGlvbiBlbWl0RXZlbnQobXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICAgIGNvbnN0IGV2ID0geyBpZDogKytldmVudFNlcSwgLi4ubXNnIH07XG4gICAgZXZlbnRzLnB1c2goZXYpO1xuICAgIGNvbnN0IGZyYW1lID0gZW5jLmVuY29kZShgZGF0YTogJHtKU09OLnN0cmluZ2lmeShldil9XFxuXFxuYCk7XG4gICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGMuZW5xdWV1ZShmcmFtZSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogY2xpZW50IGdvbmUgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBicm9hZGNhc3QobXNnOiBvYmplY3QpIHtcbiAgICBjb25zdCBzID0gSlNPTi5zdHJpbmdpZnkobXNnKTtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLnNlbmQocyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogc29ja2V0IGNsb3NlZCAqL1xuICAgICAgfVxuICAgIH1cbiAgfVxuICBsZXQgc25hcERpcnR5ID0gZmFsc2U7XG4gIGNvbnN0IGJyb2FkY2FzdFN0YXRlID0gKCkgPT4ge1xuICAgIHNuYXBEaXJ0eSA9IHRydWU7IC8vIG1hcmsgZm9yIHRoZSBkZWJvdW5jZWQgcGVyc2lzdGVuY2Ugc25hcHNob3RcbiAgICBicm9hZGNhc3QoeyB0eXBlOiBcInN0YXRlXCIsIHN0YXRlIH0pO1xuICB9O1xuICAvLyBBZ2VudCBwcmVzZW5jZSA9IGF0IGxlYXN0IG9uZSBsaXZlIFNTRSB0YWlsIChhbiBhZ2VudCBtb25pdG9yaW5nIC9ldmVudHMpLlxuICAvLyBSdW50aW1lLW9ubHkg4oCUIHB1c2hlZCB0byBicm93c2VycywgbmV2ZXIgZm9sZGVkIGludG8gcGVyc2lzdGVkIHN0YXRlLlxuICBjb25zdCBicm9hZGNhc3RQcmVzZW5jZSA9ICgpID0+IGJyb2FkY2FzdCh7IHR5cGU6IFwicHJlc2VuY2VcIiwgYWdlbnQ6IHNzZUNsaWVudHMuc2l6ZSA+IDAgfSk7XG5cbiAgLy8g4pSA4pSAIGFnZW50IGNvbW1hbmRzIChQT1NUIC9jbWQpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvLyAjODQg4oCUIFJFVFVSTlMgQSBWRVJESUNUOiBgdHJ1ZWAgaWYgdGhlIGNvbW1hbmQgdHlwZSB3YXMgUkVDT0dOSVNFRC5cbiAgLy8gVGhlIHN3aXRjaCBiZWxvdyBoYWQgMTMgY2FzZXMgYW5kIE5PIGBkZWZhdWx0OmAsIHNvIGFuIHVucmVjb2duaXNlZCB0eXBlXG4gIC8vIGZlbGwgc3RyYWlnaHQgdGhyb3VnaCBhbmQgdGhlIC9jbWQgcm91dGUgc3RpbGwgYW5zd2VyZWQge29rOnRydWV9IOKAlCBhIGJvZ3VzXG4gIC8vIHR5cGUgd2FzIGJ5dGUtaWRlbnRpY2FsIHRvIGFuIGV4ZWN1dGVkIG9uZSwgbWVhc3VyZWQgbGl2ZS5cbiAgLy9cbiAgLy8gXCJSZWNvZ25pc2VkXCIsIE5PVCBcImNoYW5nZWQgc3RhdGVcIjogc2V2ZXJhbCBjYXNlcyBhcmUgZ3VhcmRlZCBieSBhIHNoYXBlXG4gIC8vIGNoZWNrIGFuZCBsZWdpdGltYXRlbHkgZG8gbm90aGluZywgYW5kIHJlcG9ydGluZyB0aG9zZSBhcyBmYWlsdXJlcyB3b3VsZFxuICAvLyBicmVhayB3b3JraW5nIGNhbGxlcnMuIFRoZSBuYXJyb3dlciBjb250cmFjdCBpcyBhIGRlbGliZXJhdGVseSB1bmNsYWltZWQgZ2FwLlxuICAvL1xuICAvLyDimqAgaGFuZGxlQnJvd3Nlck1zZyBiZWxvdyBpcyBhIFNFUEFSQVRFIGZ1bmN0aW9uIHdpdGggYSBuZWFyLWlkZW50aWNhbFxuICAvLyBzd2l0Y2guIEl0IGlzIE5PVCBwYXJ0IG9mIHRoaXMgdmVyZGljdCDigJQgdGhlIFdlYlNvY2tldCBoYXMgbm8gcmVzcG9uc2UgdG9cbiAgLy8gY2Fycnkgb25lIOKAlCBhbmQgbXVzdCBub3QgYmUgZm9sZGVkIGluLlxuICAvLyBDb250cmFjdCAxMzogdGhlIHZlcmRpY3Qgb3JpZ2luYXRlcyBpbiB0aGUgY29kZSBvd25pbmcgdGhlIHJlY29nbmlzZWQgc2V0LlxuICAvLyBiMTMgd2lkZW5zIHRoZSBSRVRVUk4gd2l0aG91dCB3aWRlbmluZyB0aGUgQ09OVFJBQ1Qg4oCUIGEgY29tbWFuZCBtYXkgYW5zd2VyXG4gIC8vIHdpdGggYSByZXN1bHQgb2JqZWN0IGluc3RlYWQgb2YgdGhlIGJvb2xlYW4sIGFuZCBldmVyeSBvdGhlciBjb21tYW5kIGtlZXBzXG4gIC8vIHRoZSBiYXJlIGJvb2xlYW4gd2l0aCBhIGJ5dGUtaWRlbnRpY2FsIHJlc3BvbnNlLiBUaGlyZCBzcGVsbCBvbiB0aGlzIHNoYXBlXG4gIC8vIChpbWFnbyA1ZTZhYWNkLCBnbGFtb3VyIDM0ZThhYjIpLCBzbyBpdCBpcyBhIGhvdXNlIHBhdHRlcm4gbm93LlxuICB0eXBlIEFnZW50VmVyZGljdCA9XG4gICAgfCBib29sZWFuXG4gICAgfCB7IHJlY29nbmlzZWQ6IHRydWU7IG9rOiB0cnVlOyBkZXRhaWw6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IH1cbiAgICB8IHsgcmVjb2duaXNlZDogdHJ1ZTsgb2s6IGZhbHNlOyBzdGF0dXM6IG51bWJlcjsgZXJyb3I6IHN0cmluZyB9O1xuICBmdW5jdGlvbiBoYW5kbGVBZ2VudE1zZyhyYXc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogQWdlbnRWZXJkaWN0IHtcbiAgICBjb25zdCBtc2cgPSByYXcgYXMgQWdlbnRDb21tYW5kO1xuICAgIHN3aXRjaCAobXNnLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJpbml0XCI6XG4gICAgICAgIGlmICh0eXBlb2YgbXNnLnRpdGxlID09PSBcInN0cmluZ1wiKSBzdGF0ZS50aXRsZSA9IG1zZy50aXRsZTtcbiAgICAgICAgaWYgKHR5cGVvZiBtc2cuaW50ZW50ID09PSBcInN0cmluZ1wiKSBzZXRJbnRlbnQoc3RhdGUsIG1zZy5pbnRlbnQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJzYXlcIjpcbiAgICAgICAgaWYgKHR5cGVvZiBtc2cudGV4dCA9PT0gXCJzdHJpbmdcIiAmJiBtc2cudGV4dCkge1xuICAgICAgICAgIC8vIEFuIG9wdGlvbmFsIGlubGluZSBDVEEgKGEgb25lLWNsaWNrIHNob3J0Y3V0IGZvciBhIGNvbnZlcnNhdGlvbmFsXG4gICAgICAgICAgLy8gYWN0KSByaWRlcyBhbG9uZyB3aGVuIHRoZSBhZ2VudCBhdHRhY2hlcyBvbmUuXG4gICAgICAgICAgcHVzaE1lc3NhZ2Uoc3RhdGUsIHsgcm9sZTogXCJhZ2VudFwiLCBraW5kOiBcInRleHRcIiwgdGV4dDogbXNnLnRleHQsIGFjdGlvbjogbXNnLmFjdGlvbiB9KTtcbiAgICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImFza1wiOlxuICAgICAgICBpZiAodHlwZW9mIG1zZy50ZXh0ID09PSBcInN0cmluZ1wiICYmIG1zZy50ZXh0KSB7XG4gICAgICAgICAgcHVzaE1lc3NhZ2Uoc3RhdGUsIHtcbiAgICAgICAgICAgIHJvbGU6IFwiYWdlbnRcIixcbiAgICAgICAgICAgIGtpbmQ6IFwicXVlc3Rpb25cIixcbiAgICAgICAgICAgIHRleHQ6IG1zZy50ZXh0LFxuICAgICAgICAgICAgb3B0aW9uczogQXJyYXkuaXNBcnJheShtc2cub3B0aW9ucykgPyBtc2cub3B0aW9ucyA6IHVuZGVmaW5lZCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInNvdXJjZS5zZXRcIjpcbiAgICAgICAgaWYgKHR5cGVvZiBtc2cucGF0aCA9PT0gXCJzdHJpbmdcIiAmJiBBcnJheS5pc0FycmF5KG1zZy5zaXplKSkge1xuICAgICAgICAgIHNldFNvdXJjZShzdGF0ZSwgeyBwYXRoOiBtc2cucGF0aCwgc2l6ZTogbXNnLnNpemUsIHNoYTogU3RyaW5nKG1zZy5zaGEgPz8gXCJcIikgfSk7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJlbGVtZW50cy5zZXRcIjpcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobXNnLmVsZW1lbnRzKSkge1xuICAgICAgICAgIHNldEVsZW1lbnRzKHN0YXRlLCBtc2cuZWxlbWVudHMgYXMgRWxlbWVudFtdKTtcbiAgICAgICAgICAvLyBJbnRha2UgYXV0by1zZWFscyB0byBTbGljZSBvbmNlIGRpc2NvdmVyeSByZXR1cm5zIGVsZW1lbnRzIOKAlCB0aGVyZSdzXG4gICAgICAgICAgLy8gbm90aGluZyB0byBcImFwcHJvdmVcIiBhYm91dCBhIGRyb3AsIHNvIG5vIHVzZXIgZ2F0ZSBmb3IgSW50YWtlLlxuICAgICAgICAgIGlmIChzdGF0ZS5waGFzZSA9PT0gXCJpbnRha2VcIiAmJiBzdGF0ZS5lbGVtZW50cy5sZW5ndGgpIGFkdmFuY2VQaGFzZShzdGF0ZSk7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJlbGVtZW50LmFkZFwiOlxuICAgICAgICAvLyBUaGUgYWdlbnQgYm94aW5nIGEgcmVnaW9uIGluY3JlbWVudGFsbHkuIEJyb2FkY2FzdCBzbyB0aGUgc3VyZmFjZVxuICAgICAgICAvLyBzaG93cyBpdDsgTk8gU1NFIChpdCdzIHRoZSBhZ2VudCdzIG93biBtb3ZlKSBhbmQgTk8gZ2VzdHVyZSBtZXNzYWdlXG4gICAgICAgIC8vIChhZ2VudCBlZGl0cyBhcmVuJ3QgXCJ1c2VyIGdlc3R1cmVzXCIpLlxuICAgICAgICAvLyBiMTMgKyAjODcgKGZvdXJ0aCBzcGVsbCkg4oCUIHRoaXMgY2FsbGVkIHRoZSBtdXRhdG9yIFdJVEhPVVQgQ0FQVFVSSU5HXG4gICAgICAgIC8vIGl0cyByZXR1cm4gYXQgYWxsLCB3aGljaCBpcyB0aGUgbW9zdCBjb21wbGV0ZSBkcm9wIG9mIHRoZSBmYW1pbHk6IHRoZVxuICAgICAgICAvLyBicm93c2VyIHBhdGggb25lIHNjcmVlbiBkb3duIGRvZXMgYGNvbnN0IGVsID0gYWRkRWxlbWVudCguLi4pYCBhbmRcbiAgICAgICAgLy8gdXNlcyBlbC5pZC9lbC5uYW1lLCBzbyB0aGUgZWxlbWVudCdzIGlkZW50aXR5IGV4aXN0cyBhbmQgb25seSB0aGVcbiAgICAgICAgLy8gYWdlbnQgd2FzIGRlbmllZCBpdC4gSXQgY291bGQgbm90IHJlZmVyZW5jZSB0aGUgYm94IGl0IGhhZCBqdXN0XG4gICAgICAgIC8vIGNyZWF0ZWQuXG4gICAgICAgIC8vXG4gICAgICAgIC8vIFRoZSBndWFyZCB3YXMgdGhlIHNlY29uZCBoYWxmOiBhIG1hbGZvcm1lZCBlbGVtZW50IGZlbGwgdGhyb3VnaCB0byB0aGVcbiAgICAgICAgLy8gdGVybWluYWwgYHJldHVybiB0cnVlYCwgc28gXCJub3RoaW5nIHdhcyBhZGRlZFwiIGFuZCBcImFkZGVkXCIgd2VyZSB0aGVcbiAgICAgICAgLy8gc2FtZSBhbnN3ZXIuIFRoYXQgb25lIGlzIGFuIGFtYmlndW91cyBhYnNlbmNlLCBub3QgYSBsb3N0IHZhbHVlLlxuICAgICAgICBpZiAobXNnLmVsZW1lbnQgJiYgQXJyYXkuaXNBcnJheShtc2cuZWxlbWVudC5iYm94KSkge1xuICAgICAgICAgIGNvbnN0IGVsID0gYWRkRWxlbWVudChzdGF0ZSwgbXNnLmVsZW1lbnQpO1xuICAgICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHJlY29nbmlzZWQ6IHRydWUsXG4gICAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICAgIGRldGFpbDogeyBpZDogZWwuaWQsIG5hbWU6IGVsLm5hbWUsIG91dGNvbWU6IFwiY3JlYXRlZFwiIH0sXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHJlY29nbmlzZWQ6IHRydWUsXG4gICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgIHN0YXR1czogNDAwLFxuICAgICAgICAgIGVycm9yOlxuICAgICAgICAgICAgXCJlbGVtZW50LmFkZCByZXF1aXJlcyBgZWxlbWVudGAgd2l0aCBhIGBiYm94YCBhcnJheSDigJQgbm90aGluZyB3YXMgYWRkZWQgXCIgK1xuICAgICAgICAgICAgXCIodGhlIGVsZW1lbnQgaXMgdW5jaGFuZ2VkIGFuZCBubyBpZCB3YXMgbWludGVkKVwiLFxuICAgICAgICB9O1xuICAgICAgY2FzZSBcImVsZW1lbnQudXBkYXRlXCI6XG4gICAgICAgIC8vIFBhcnRpYWwtbWVyZ2Ugb2YgbmFtZS90eXBlL2Jib3gvc3RhdHVzLiBWZXJzaW9uIHJlc3VsdHMgZG8gTk9UIGNvbWVcbiAgICAgICAgLy8gdGhyb3VnaCBoZXJlIOKAlCB0aGV5IGFwcGVuZCB2aWEgZWxlbWVudC5hZGRWZXJzaW9uIChhIGxpc3Qgb3ApLlxuICAgICAgICBpZiAodHlwZW9mIG1zZy5pZCA9PT0gXCJzdHJpbmdcIiAmJiBtc2cucGF0Y2ggJiYgdXBkYXRlRWxlbWVudChzdGF0ZSwgbXNnLmlkLCBtc2cucGF0Y2gpKSB7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJlbGVtZW50LnJlbW92ZVwiOlxuICAgICAgICAvLyBUaGUgYWdlbnQgcmV0cmFjdGluZyBhIGJveC4gQnJvYWRjYXN0OyBOTyBTU0UuXG4gICAgICAgIGlmICh0eXBlb2YgbXNnLmlkID09PSBcInN0cmluZ1wiICYmIHJlbW92ZUVsZW1lbnQoc3RhdGUsIG1zZy5pZCkpIHtcbiAgICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImVsZW1lbnQuYWRkVmVyc2lvblwiOlxuICAgICAgICAvLyBUaGUgYWdlbnQgcG9zdGluZyBhIHByb2R1Y2VkIHZlcnNpb24gKGNyb3Agb3IgcmVtb3ZhbCByZXN1bHQpLiBBcHBlbmRcbiAgICAgICAgLy8gKHVwc2VydCBieSBtb2RlbCkgKyBicm9hZGNhc3Q7IE5PIFNTRSAoaXQncyB0aGUgYWdlbnQncyBvd24gb3V0cHV0KS5cbiAgICAgICAgaWYgKFxuICAgICAgICAgIHR5cGVvZiBtc2cuaWQgPT09IFwic3RyaW5nXCIgJiZcbiAgICAgICAgICBtc2cudmVyc2lvbiAmJlxuICAgICAgICAgIGFkZFZlcnNpb24oc3RhdGUsIG1zZy5pZCwgbXNnLnZlcnNpb24sIHsgY2hvb3NlOiBtc2cuY2hvb3NlID8/IHRydWUgfSlcbiAgICAgICAgKSB7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJwaGFzZS5zZXRcIjpcbiAgICAgICAgLy8gVGhlIGFnZW50IGFkdmFuY2luZy9tb3ZpbmcgdGhlIGN1cnNvciBvbiB0aGUgdXNlcidzIGNvbnZlcnNhdGlvbmFsXG4gICAgICAgIC8vIHJlcXVlc3QgKFwibG9va3MgZ29vZCwgbGV0J3MgZ29cIikuIEFnZW50LWRyaXZlbiDihpIgYnJvYWRjYXN0IG9ubHkuXG4gICAgICAgIGlmICh0eXBlb2YgbXNnLnBoYXNlID09PSBcInN0cmluZ1wiICYmIHNldFBoYXNlKHN0YXRlLCBtc2cucGhhc2UgYXMgUGhhc2VLZXkpKSB7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJidW5kbGUuc2V0XCI6XG4gICAgICAgIC8vIFRoZSBhZ2VudCBwb3N0aW5nIHRoZSBidWlsdCBleHBvcnQgYnVuZGxlIChhZnRlciB6aXBwaW5nKS4gQnJvYWRjYXN0IHNvXG4gICAgICAgIC8vIHRoZSBFeHBvcnQgdmlldyBvZmZlcnMgdGhlIGRvd25sb2FkOyBOTyBTU0UgKGFnZW50J3Mgb3duIG91dHB1dCkuXG4gICAgICAgIGlmICh0eXBlb2YgbXNnLm5hbWUgPT09IFwic3RyaW5nXCIgJiYgdHlwZW9mIG1zZy5jb3VudCA9PT0gXCJudW1iZXJcIikge1xuICAgICAgICAgIHNldEJ1bmRsZShzdGF0ZSwgbXNnLm5hbWUsIG1zZy5jb3VudCk7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJzdGF0dXNcIjpcbiAgICAgICAgc2V0U3RhdHVzKHN0YXRlLCBtc2cuYnVzeSA9PT0gdHJ1ZSwgdHlwZW9mIG1zZy50ZXh0ID09PSBcInN0cmluZ1wiID8gbXNnLnRleHQgOiBcIlwiKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiY2xvc2VcIjpcbiAgICAgICAgcmVzb2x2ZURvbmUoeyBjb2RlOiAwLCByZWFzb246IFwiY2xvc2VcIiB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICByZXR1cm4gZmFsc2U7IC8vIHVucmVjb2duaXNlZCB0eXBlIOKAlCB0aGUgbWlzc2luZyBgZGVmYXVsdDpgIGlzIHRoZSBkZWZlY3RcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICAvLyDilIDilIAgYnJvd3NlciBtZXNzYWdlcyAoV2ViU29ja2V0KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgZnVuY3Rpb24gaGFuZGxlQnJvd3Nlck1zZyhyYXc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gICAgY29uc3QgbXNnID0gcmF3IGFzIENsaWVudFRvU2VydmVyO1xuICAgIHN3aXRjaCAobXNnLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJzYXlcIjpcbiAgICAgICAgaWYgKHR5cGVvZiBtc2cudGV4dCAhPT0gXCJzdHJpbmdcIiB8fCAhbXNnLnRleHQpIHJldHVybjtcbiAgICAgICAgcHVzaE1lc3NhZ2Uoc3RhdGUsIHsgcm9sZTogXCJ1c2VyXCIsIGtpbmQ6IFwidGV4dFwiLCB0ZXh0OiBtc2cudGV4dCB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJzYXlcIiwgdGV4dDogbXNnLnRleHQgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInNvdXJjZS5pbXBvcnRcIjoge1xuICAgICAgICAvLyBUaGUgdXNlciBkcm9wcGVkIGEgY29tcG9zaXRlLiBNYXRlcmlhbGl6ZSBpdCBvbnRvIHRoZSBzZXNzaW9uIGZpbGVzXG4gICAgICAgIC8vIGRpciBvZmYtdGhyZWFkIChkZWNvZGUvbWV0YWRhdGEgaXMgYXN5bmMpLCB0aGVuIHNldCBzb3VyY2UgKyBlbWl0IHRoZVxuICAgICAgICAvLyBpbXBlcmF0aXZlIHRoZSBhZ2VudCBydW5zIGRpc2NvdmVyIG9uLiBGYWlsdXJlIGxvZ3MgdG8gc3RkZXJyOyBuZXZlclxuICAgICAgICAvLyBjcmFzaGVzIHRoZSBkYWVtb24uXG4gICAgICAgIGlmICh0eXBlb2YgbXNnLm5hbWUgIT09IFwic3RyaW5nXCIgfHwgdHlwZW9mIG1zZy5kYXRhVXJsICE9PSBcInN0cmluZ1wiKSByZXR1cm47XG4gICAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3Qgc291cmNlID0gYXdhaXQgbWF0ZXJpYWxpemVTb3VyY2Uoc2Vzc2lvbkZpbGVzRGlyLCBtc2cubmFtZSwgbXNnLmRhdGFVcmwpO1xuICAgICAgICAgICAgc2V0U291cmNlKHN0YXRlLCBzb3VyY2UpO1xuICAgICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgICAgIGVtaXRFdmVudCh7XG4gICAgICAgICAgICAgIHR5cGU6IFwic291cmNlLmFkZGVkXCIsXG4gICAgICAgICAgICAgIHBhdGg6IHNvdXJjZS5wYXRoLFxuICAgICAgICAgICAgICBzaXplOiBzb3VyY2Uuc2l6ZSxcbiAgICAgICAgICAgICAgc2hhOiBzb3VyY2Uuc2hhLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICAgIGBtYWdwaWU6IHNvdXJjZS5pbXBvcnQgZmFpbGVkOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG5gLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImVsZW1lbnQuYWRkXCI6IHtcbiAgICAgICAgLy8gVGhlIHVzZXIgZHJldyBhIG1pc3NlZCByZWdpb24g4oCUIGFtYmllbnQgZWRpdGluZyBvZiB0aGUgYnJlYWtkb3duLlxuICAgICAgICAvLyBNYXRlcmlhbGl6ZSBpdCArIGxvZyB0aGUgZ2VzdHVyZTsgZG8gTk9UIHB1c2ggdGhlIGFnZW50OiBpdCBwaWNrcyB0aGVcbiAgICAgICAgLy8gbmV3IGJveCB1cCBmcm9tIC9zdGF0ZSB3aGVuIGEgY3V0IGFjdHVhbGx5IGZpcmVzLlxuICAgICAgICBpZiAoIW1zZy5lbGVtZW50IHx8ICFBcnJheS5pc0FycmF5KG1zZy5lbGVtZW50LmJib3gpKSByZXR1cm47XG4gICAgICAgIGNvbnN0IGVsID0gYWRkRWxlbWVudChzdGF0ZSwgbXNnLmVsZW1lbnQpO1xuICAgICAgICBwdXNoTWVzc2FnZShzdGF0ZSwge1xuICAgICAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgICAgIGtpbmQ6IFwiZ2VzdHVyZVwiLFxuICAgICAgICAgIHRleHQ6IGBkcmV3ICR7ZWwubmFtZX1gLFxuICAgICAgICAgIGdlc3R1cmU6IHsga2luZDogXCJkcmF3XCIsIHRhcmdldElkOiBlbC5pZCB9LFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiZWxlbWVudC51cGRhdGVcIjoge1xuICAgICAgICAvLyBNb3ZlIC8gcmVzaXplIC8gcmVuYW1lIC8gcmV0eXBlIOKAlCBhbWJpZW50IGVkaXRpbmcgb2YgdGhlIGJyZWFrZG93biwgTk9UXG4gICAgICAgIC8vIHB1c2hlZCB0byB0aGUgYWdlbnQgKGl0IHJlYWRzIHRoZSBsYXRlc3QgYm94ZXMgZnJvbSAvc3RhdGUgYXQgY3V0IHRpbWUpLlxuICAgICAgICAvLyBBIGdlc3R1cmUgTWVzc2FnZSBsYW5kcyBPTkxZIG9uIGEgcmVuYW1lL3JldHlwZTsgcHVyZSBiYm94IG1vdmVzIGFyZSB0b29cbiAgICAgICAgLy8gbm9pc3kgZXZlbiBmb3IgdGhlIHRocmVhZCAodGhleSBsZWF2ZSBubyBtZXNzYWdlKS5cbiAgICAgICAgaWYgKHR5cGVvZiBtc2cuaWQgIT09IFwic3RyaW5nXCIgfHwgIW1zZy5wYXRjaCkgcmV0dXJuO1xuICAgICAgICBpZiAoIXVwZGF0ZUVsZW1lbnQoc3RhdGUsIG1zZy5pZCwgbXNnLnBhdGNoKSkgcmV0dXJuO1xuICAgICAgICBjb25zdCByZW5hbWVkID0gdHlwZW9mIG1zZy5wYXRjaC5uYW1lID09PSBcInN0cmluZ1wiO1xuICAgICAgICBjb25zdCByZXR5cGVkID0gdHlwZW9mIG1zZy5wYXRjaC50eXBlID09PSBcInN0cmluZ1wiO1xuICAgICAgICBpZiAocmVuYW1lZCB8fCByZXR5cGVkKSB7XG4gICAgICAgICAgY29uc3QgZWwgPSBzdGF0ZS5lbGVtZW50cy5maW5kKChlKSA9PiBlLmlkID09PSBtc2cuaWQpO1xuICAgICAgICAgIGNvbnN0IHRleHQgPSByZW5hbWVkXG4gICAgICAgICAgICA/IGByZW5hbWVkICR7ZWw/Lm5hbWUgPz8gbXNnLmlkfWBcbiAgICAgICAgICAgIDogYHJldHlwZWQgJHtlbD8ubmFtZSA/PyBtc2cuaWR9IOKGkiAke21zZy5wYXRjaC50eXBlfWA7XG4gICAgICAgICAgcHVzaE1lc3NhZ2Uoc3RhdGUsIHtcbiAgICAgICAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgICAgICAga2luZDogXCJnZXN0dXJlXCIsXG4gICAgICAgICAgICB0ZXh0LFxuICAgICAgICAgICAgZ2VzdHVyZTogeyBraW5kOiByZW5hbWVkID8gXCJyZW5hbWVcIiA6IFwicmV0eXBlXCIsIHRhcmdldElkOiBtc2cuaWQgfSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJlbGVtZW50LnJlbW92ZVwiOiB7XG4gICAgICAgIC8vIEhhcmQtZGVsZXRlIGEgYm94IOKAlCBhbWJpZW50IGVkaXRpbmcsIG5vdCBwdXNoZWQgdG8gdGhlIGFnZW50IChhIHJlbW92ZWRcbiAgICAgICAgLy8gYm94IGlzIHNpbXBseSBhYnNlbnQgZnJvbSAvc3RhdGUgYXQgY3V0IHRpbWUpLiBDYXB0dXJlIHRoZSBuYW1lIGZpcnN0XG4gICAgICAgIC8vIGZvciB0aGUgZ2VzdHVyZSBtZXNzYWdlLlxuICAgICAgICBpZiAodHlwZW9mIG1zZy5pZCAhPT0gXCJzdHJpbmdcIikgcmV0dXJuO1xuICAgICAgICBjb25zdCBuYW1lID0gc3RhdGUuZWxlbWVudHMuZmluZCgoZSkgPT4gZS5pZCA9PT0gbXNnLmlkKT8ubmFtZSA/PyBtc2cuaWQ7XG4gICAgICAgIGlmICghcmVtb3ZlRWxlbWVudChzdGF0ZSwgbXNnLmlkKSkgcmV0dXJuO1xuICAgICAgICBwdXNoTWVzc2FnZShzdGF0ZSwge1xuICAgICAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgICAgIGtpbmQ6IFwiZ2VzdHVyZVwiLFxuICAgICAgICAgIHRleHQ6IGByZW1vdmVkICR7bmFtZX1gLFxuICAgICAgICAgIGdlc3R1cmU6IHsga2luZDogXCJyZW1vdmVcIiwgdGFyZ2V0SWQ6IG1zZy5pZCB9LFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiZWxlbWVudC5qdWRnZVwiOiB7XG4gICAgICAgIC8vIENvbmZpcm0gLyBkcm9wIC8gcmVzdG9yZSBhbiBlbGVtZW50IOKAlCBhbWJpZW50IGVkaXRpbmcsIG5vdCBwdXNoZWQgdG8gdGhlXG4gICAgICAgIC8vIGFnZW50IChkcm9wcGVkIGJveGVzIGFyZSBza2lwcGVkIGF0IGN1dCB0aW1lLCByZWFkIGZyb20gL3N0YXRlKS5cbiAgICAgICAgaWYgKHR5cGVvZiBtc2cuaWQgIT09IFwic3RyaW5nXCIpIHJldHVybjtcbiAgICAgICAgaWYgKCFqdWRnZUVsZW1lbnQoc3RhdGUsIG1zZy5pZCwgbXNnLnN0YXR1cyBhcyBFbGVtZW50U3RhdHVzKSkgcmV0dXJuO1xuICAgICAgICBjb25zdCBlbCA9IHN0YXRlLmVsZW1lbnRzLmZpbmQoKGUpID0+IGUuaWQgPT09IG1zZy5pZCk7XG4gICAgICAgIHB1c2hNZXNzYWdlKHN0YXRlLCB7XG4gICAgICAgICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgICAgICAga2luZDogXCJnZXN0dXJlXCIsXG4gICAgICAgICAgdGV4dDogYGp1ZGdlZCAke2VsPy5uYW1lID8/IG1zZy5pZH06ICR7bXNnLnN0YXR1c31gLFxuICAgICAgICAgIGdlc3R1cmU6IHsga2luZDogXCJqdWRnZVwiLCB0YXJnZXRJZDogbXNnLmlkIH0sXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJleHRyYWN0XCI6IHtcbiAgICAgICAgLy8gVGhlIHVzZXIgYXNrZWQgdG8gY3V0IHNsaWNlcyBmb3IgdGhlIGNvbmZpcm1lZCBlbGVtZW50cyAob3IgYSBzdWJzZXQsXG4gICAgICAgIC8vIG9uIHJlLWN1dCkuIFRoZSBkYWVtb24gc3RheXMgdGhpbiDigJQgaXQgZG9lcyBOT1Qgc3Bhd24gcHl0aG9uOyBpdCBoYW5kc1xuICAgICAgICAvLyB0aGUgYWdlbnQgdGhlIGltcGVyYXRpdmUgKGxpa2UgZGlzY292ZXIsIHdpdGggdGhlIHN1YnNldCBpZHMpIGFuZCB0aGVcbiAgICAgICAgLy8gYWdlbnQgcnVucyB0aGUgY3V0IGxvb3AsIHBvc3RpbmcgZWFjaCByZXN1bHQgYmFjayB2aWEgZWxlbWVudC5hZGRWZXJzaW9uLlxuICAgICAgICBjb25zdCBpZHMgPSBBcnJheS5pc0FycmF5KG1zZy5pZHMpID8gbXNnLmlkcyA6IHVuZGVmaW5lZDtcbiAgICAgICAgY29uc3QgbiA9IGlkcyA/IGlkcy5sZW5ndGggOiBzdGF0ZS5lbGVtZW50cy5maWx0ZXIoKGUpID0+IGUuc3RhdHVzICE9PSBcImRyb3BwZWRcIikubGVuZ3RoO1xuICAgICAgICBwdXNoTWVzc2FnZShzdGF0ZSwge1xuICAgICAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgICAgIGtpbmQ6IFwiZ2VzdHVyZVwiLFxuICAgICAgICAgIHRleHQ6IGBhc2tlZCB0byBjdXQgJHtufSBzbGljZSR7biA9PT0gMSA/IFwiXCIgOiBcInNcIn1gLFxuICAgICAgICAgIGdlc3R1cmU6IHsga2luZDogXCJleHRyYWN0XCIgfSxcbiAgICAgICAgfSk7XG4gICAgICAgIC8vIFNob3cgdGhlIHdvcmtpbmcgc2lnbmFsIElNTUVESUFURUxZIOKAlCB3aXRob3V0IHRoaXMgdGhlIHNwaW5uZXIgb25seVxuICAgICAgICAvLyBhcHBlYXJzIG9uY2UgdGhlIGFnZW50IHBpY2tzIHVwIHRoZSBTU0UgZXZlbnQgYW5kIHN0YXJ0cyBpdHMgY3V0IGxvb3BcbiAgICAgICAgLy8gKHNlY29uZHMgbGF0ZXIpLCBzbyB0aGUgY2xpY2sgZmVlbHMgbGlrZSBpdCBkaWQgbm90aGluZy4gVGhlIGFnZW50J3NcbiAgICAgICAgLy8gY3V0IGxvb3AgY2xlYXJzIGl0IChzdGF0dXMgYnVzeTpmYWxzZSkgd2hlbiB0aGUgY3V0cyBsYW5kLlxuICAgICAgICBzZXRTdGF0dXMoc3RhdGUsIHRydWUsIGBSZS1zbGljaW5nICR7bn0gc2xpY2Uke24gPT09IDEgPyBcIlwiIDogXCJzXCJ94oCmYCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGVtaXRFdmVudCh7IHR5cGU6IFwiZXh0cmFjdFwiLCBpZHMgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImVsZW1lbnQuZmxhZ1wiOiB7XG4gICAgICAgIC8vIEZsYWcgLyB1bmZsYWcgZm9yIGEgcmUtcnVuIOKAlCBhbWJpZW50IGJvb2trZWVwaW5nLCBOT1QgcHVzaGVkIHRvIHRoZVxuICAgICAgICAvLyBhZ2VudC4gVGhlIGFnZW50IGxlYXJucyB3aGljaCB0byByZS1ydW4gZnJvbSB0aGUgZXh0cmFjdC9yZW1vdmVCZy9cbiAgICAgICAgLy8gcmV0cnlSZW1vdmFsIGltcGVyYXRpdmUgKHRoZSB1c2VyJ3MgXCJkbyBpdFwiIGNsaWNrKSwgbm90IGVhY2ggZmxhZyB0b2dnbGUuXG4gICAgICAgIGlmICh0eXBlb2YgbXNnLmlkICE9PSBcInN0cmluZ1wiKSByZXR1cm47XG4gICAgICAgIGNvbnN0IGZsYWdnZWQgPSBtc2cuZmxhZ2dlZCA9PT0gdHJ1ZTtcbiAgICAgICAgaWYgKCFmbGFnRWxlbWVudChzdGF0ZSwgbXNnLmlkLCBmbGFnZ2VkKSkgcmV0dXJuO1xuICAgICAgICBjb25zdCBlbCA9IHN0YXRlLmVsZW1lbnRzLmZpbmQoKGUpID0+IGUuaWQgPT09IG1zZy5pZCk7XG4gICAgICAgIHB1c2hNZXNzYWdlKHN0YXRlLCB7XG4gICAgICAgICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgICAgICAga2luZDogXCJnZXN0dXJlXCIsXG4gICAgICAgICAgdGV4dDogZmxhZ2dlZCA/IGBmbGFnZ2VkICR7ZWw/Lm5hbWUgPz8gbXNnLmlkfWAgOiBgdW5mbGFnZ2VkICR7ZWw/Lm5hbWUgPz8gbXNnLmlkfWAsXG4gICAgICAgICAgZ2VzdHVyZTogeyBraW5kOiBcImZsYWdcIiwgdGFyZ2V0SWQ6IG1zZy5pZCB9LFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwidmVyc2lvbi5jaG9vc2VcIjpcbiAgICAgICAgLy8gUGlja2luZyB3aGljaCB2ZXJzaW9uIGlzIGNob3NlbiDigJQgYW4gYW1iaWVudCBwcmV2aWV3L3ByZWZlcmVuY2UgdG9nZ2xlLFxuICAgICAgICAvLyBsaWtlIGJhY2tkcm9wLnNldDogdG9vIGZyZXF1ZW50ICsgbG93LXNpZ25hbCB0byBsb2cgaW4gdGhlIHRocmVhZCwgYW5kXG4gICAgICAgIC8vIG5ldmVyIHB1c2hlZCB0byB0aGUgYWdlbnQuIEp1c3QgbXV0YXRlICsgYnJvYWRjYXN0LlxuICAgICAgICBpZiAodHlwZW9mIG1zZy5pZCAhPT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgbXNnLnZlcnNpb25JZCAhPT0gXCJzdHJpbmdcIikgcmV0dXJuO1xuICAgICAgICBpZiAoY2hvb3NlVmVyc2lvbihzdGF0ZSwgbXNnLmlkLCBtc2cudmVyc2lvbklkKSkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwicmVtb3ZlQmdcIjoge1xuICAgICAgICAvLyBJbXBlcmF0aXZlOiByZW1vdmUgYmFja2dyb3VuZHMgZm9yIHRoZXNlIChvciBhbGwgZWxpZ2libGUpIGVsZW1lbnRzLiBUaGVcbiAgICAgICAgLy8gYWdlbnQgcGlja3MgdGhlIG1vZGVsICsgcnVucyBpdC4gRmxpcCBidXN5IGltbWVkaWF0ZWx5ICh0aGUgYWZmb3JkYW5jZSkuXG4gICAgICAgIGNvbnN0IGlkcyA9IEFycmF5LmlzQXJyYXkobXNnLmlkcykgPyBtc2cuaWRzIDogdW5kZWZpbmVkO1xuICAgICAgICBjb25zdCBuID0gaWRzID8gaWRzLmxlbmd0aCA6IHN0YXRlLmVsZW1lbnRzLmZpbHRlcigoZSkgPT4gZS5zdGF0dXMgIT09IFwiZHJvcHBlZFwiKS5sZW5ndGg7XG4gICAgICAgIHB1c2hNZXNzYWdlKHN0YXRlLCB7XG4gICAgICAgICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgICAgICAga2luZDogXCJnZXN0dXJlXCIsXG4gICAgICAgICAgdGV4dDogYGFza2VkIHRvIHJlbW92ZSAke259IGJhY2tncm91bmQke24gPT09IDEgPyBcIlwiIDogXCJzXCJ9YCxcbiAgICAgICAgICBnZXN0dXJlOiB7IGtpbmQ6IFwicmVtb3ZlQmdcIiB9LFxuICAgICAgICB9KTtcbiAgICAgICAgc2V0U3RhdHVzKHN0YXRlLCB0cnVlLCBgUmVtb3ZpbmcgJHtufSBiYWNrZ3JvdW5kJHtuID09PSAxID8gXCJcIiA6IFwic1wifeKApmApO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcInJlbW92ZUJnXCIsIGlkcyB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwicmV0cnlSZW1vdmFsXCI6IHtcbiAgICAgICAgLy8gSW1wZXJhdGl2ZTogXCJ0cnkgYSBkaWZmZXJlbnQgcmVtb3ZhbFwiIG9uIHRoZXNlIGZsYWdnZWQgaXRlbXMuIFBheWxvYWQgaXNcbiAgICAgICAgLy8gaWRzIE9OTFkg4oCUIHRoZSBhZ2VudCBwaWNrcyBhbiB1bnVzZWQgbW9kZWwuIEZsaXAgYnVzeSBpbW1lZGlhdGVseS5cbiAgICAgICAgY29uc3QgaWRzID0gQXJyYXkuaXNBcnJheShtc2cuaWRzKSA/IG1zZy5pZHMgOiBbXTtcbiAgICAgICAgaWYgKCFpZHMubGVuZ3RoKSByZXR1cm47XG4gICAgICAgIHB1c2hNZXNzYWdlKHN0YXRlLCB7XG4gICAgICAgICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgICAgICAga2luZDogXCJnZXN0dXJlXCIsXG4gICAgICAgICAgdGV4dDogYGFza2VkIHRvIHRyeSBhIGRpZmZlcmVudCByZW1vdmFsIG9uICR7aWRzLmxlbmd0aH1gLFxuICAgICAgICAgIGdlc3R1cmU6IHsga2luZDogXCJyZXRyeVJlbW92YWxcIiB9LFxuICAgICAgICB9KTtcbiAgICAgICAgc2V0U3RhdHVzKHN0YXRlLCB0cnVlLCBgVHJ5aW5nIGEgZGlmZmVyZW50IHJlbW92YWwgb24gJHtpZHMubGVuZ3RofeKApmApO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcInJldHJ5UmVtb3ZhbFwiLCBpZHMgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImJhY2tkcm9wLnNldFwiOlxuICAgICAgICAvLyBhbWJpZW50IHByZXZpZXcgc3RhdGUg4oCUIG5vIGFnZW50IGV2ZW50LlxuICAgICAgICBpZiAoc2V0QmFja2Ryb3Aoc3RhdGUsIG1zZy5iYWNrZHJvcCBhcyBCYWNrZHJvcCkpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInBoYXNlLmFkdmFuY2VcIjoge1xuICAgICAgICAvLyBUaGUgdXNlciBzZWFsaW5nIHRoZSBhY3RpdmUgcGhhc2Ug4oCUIGFuIGltcGVyYXRpdmUgaGFuZC1vZmYuIEFkdmFuY2UgdGhlXG4gICAgICAgIC8vIGN1cnNvciArIHRlbGwgdGhlIGFnZW50IHdoZXJlIHdlIG1vdmVkIHRvLiBOby1vcCBhdCB0aGUgbGFzdCBwaGFzZS5cbiAgICAgICAgY29uc3QgcHJldiA9IHN0YXRlLnBoYXNlO1xuICAgICAgICBjb25zdCBuZXh0ID0gYWR2YW5jZVBoYXNlKHN0YXRlKTtcbiAgICAgICAgaWYgKCFuZXh0KSByZXR1cm47XG4gICAgICAgIHB1c2hNZXNzYWdlKHN0YXRlLCB7XG4gICAgICAgICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgICAgICAga2luZDogXCJnZXN0dXJlXCIsXG4gICAgICAgICAgdGV4dDogYHNlYWxlZCAke3ByZXZ9IOKGkiAke25leHR9YCxcbiAgICAgICAgICBnZXN0dXJlOiB7IGtpbmQ6IFwicGhhc2UuYWR2YW5jZVwiIH0sXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcInBoYXNlLmFkdmFuY2VcIiwgcGhhc2U6IG5leHQgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInBoYXNlLnNldFwiOiB7XG4gICAgICAgIC8vIEJhY2stbmF2IC8ganVtcCDigJQgcmUtb3BlbnMgbGF0ZXIgcGhhc2VzIGZvciBlZGl0cy4gQSBwaGFzZSBzd2l0Y2ggaXMgYVxuICAgICAgICAvLyBkZWxpYmVyYXRlIHJlbG9jYXRpb24gKE5PVCBhbWJpZW50IGVkaXRpbmcpLCBzbyBpdCBJUyBwdXNoZWQgdG8gdGhlXG4gICAgICAgIC8vIGFnZW50IGFzIGNvbnRleHQgZm9yIHdoYXQncyBjb21pbmcgKHJlLWN1dHMgbGlrZWx5KSDigJQgZXZlbiB0aG91Z2hcbiAgICAgICAgLy8gdGhlcmUncyBubyBhY3Rpb24gdG8gdGFrZS4gUmFyZSBlbm91Z2ggdG8gbmV2ZXIgYmUgc3BhbW15LlxuICAgICAgICBpZiAodHlwZW9mIG1zZy5waGFzZSAhPT0gXCJzdHJpbmdcIikgcmV0dXJuO1xuICAgICAgICBpZiAoIXNldFBoYXNlKHN0YXRlLCBtc2cucGhhc2UgYXMgUGhhc2VLZXkpKSByZXR1cm47XG4gICAgICAgIHB1c2hNZXNzYWdlKHN0YXRlLCB7XG4gICAgICAgICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgICAgICAga2luZDogXCJnZXN0dXJlXCIsXG4gICAgICAgICAgdGV4dDogYHN0ZXBwZWQgdG8gJHttc2cucGhhc2V9YCxcbiAgICAgICAgICBnZXN0dXJlOiB7IGtpbmQ6IFwicGhhc2Uuc2V0XCIsIHRhcmdldElkOiBtc2cucGhhc2UgfSxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGVtaXRFdmVudCh7IHR5cGU6IFwicGhhc2Uuc2V0XCIsIHBoYXNlOiBtc2cucGhhc2UgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImV4cG9ydFwiOiB7XG4gICAgICAgIC8vIFRoZSB1c2VyIGFza2VkIHRvIGJ1aWxkIHRoZSBkb3dubG9hZGFibGUgYnVuZGxlLiBGbGlwIGJ1c3kgKyBlbWl0IHRvIHRoZVxuICAgICAgICAvLyBhZ2VudCwgd2hpY2ggemlwcyB0aGUgY2hvc2VuIGFzc2V0cyBvdXQgb2YgYmFuZCB0aGVuIHBvc3RzIGJ1bmRsZS5zZXQuXG4gICAgICAgIGNvbnN0IGlkcyA9IEFycmF5LmlzQXJyYXkobXNnLmlkcykgPyBtc2cuaWRzIDogdW5kZWZpbmVkO1xuICAgICAgICBjb25zdCBuID0gaWRzID8gaWRzLmxlbmd0aCA6IHN0YXRlLmVsZW1lbnRzLmZpbHRlcigoZSkgPT4gZS5zdGF0dXMgIT09IFwiZHJvcHBlZFwiKS5sZW5ndGg7XG4gICAgICAgIHB1c2hNZXNzYWdlKHN0YXRlLCB7XG4gICAgICAgICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgICAgICAga2luZDogXCJnZXN0dXJlXCIsXG4gICAgICAgICAgdGV4dDogYGFza2VkIHRvIGV4cG9ydCAke259IGFzc2V0JHtuID09PSAxID8gXCJcIiA6IFwic1wifWAsXG4gICAgICAgICAgZ2VzdHVyZTogeyBraW5kOiBcImV4cG9ydFwiIH0sXG4gICAgICAgIH0pO1xuICAgICAgICBzZXRTdGF0dXMoc3RhdGUsIHRydWUsIGBCdWlsZGluZyBidW5kbGUgKCR7bn0gYXNzZXQke24gPT09IDEgPyBcIlwiIDogXCJzXCJ9KeKApmApO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcImV4cG9ydFwiLCBpZHMgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInN1Ym1pdFwiOlxuICAgICAgICBicm9hZGNhc3QoeyB0eXBlOiBcInN1Ym1pdFwiIH0pO1xuICAgICAgICBlbWl0RXZlbnQoeyB0eXBlOiBcInN1Ym1pdFwiIH0pO1xuICAgICAgICByZXNvbHZlRG9uZSh7IGNvZGU6IDAsIHJlYXNvbjogXCJzdWJtaXRcIiB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiY2FuY2VsXCI6XG4gICAgICAgIGJyb2FkY2FzdCh7IHR5cGU6IFwiY2FuY2VsXCIgfSk7XG4gICAgICAgIHJlc29sdmVEb25lKHsgY29kZTogMTMwLCByZWFzb246IFwiY2FuY2VsXCIgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHNzZVJlc3BvbnNlKHVybDogVVJMKTogUmVzcG9uc2Uge1xuICAgIHRvdWNoKCk7XG4gICAgY29uc3Qgc2luY2UgPSBwYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInNpbmNlXCIpID8/IFwiLTFcIiwgMTApO1xuICAgIGxldCByZWY6IFJlYWRhYmxlU3RyZWFtRGVmYXVsdENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgaGI6IFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPiB8IG51bGwgPSBudWxsO1xuICAgIGNvbnN0IHN0cmVhbSA9IG5ldyBSZWFkYWJsZVN0cmVhbSh7XG4gICAgICBzdGFydChjb250cm9sbGVyKSB7XG4gICAgICAgIHJlZiA9IGNvbnRyb2xsZXI7XG4gICAgICAgIGZvciAoY29uc3QgZXYgb2YgZXZlbnRzKSB7XG4gICAgICAgICAgaWYgKChldi5pZCBhcyBudW1iZXIpID4gc2luY2UpIHtcbiAgICAgICAgICAgIGNvbnRyb2xsZXIuZW5xdWV1ZShlbmMuZW5jb2RlKGBkYXRhOiAke0pTT04uc3RyaW5naWZ5KGV2KX1cXG5cXG5gKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHNzZUNsaWVudHMuYWRkKGNvbnRyb2xsZXIpO1xuICAgICAgICBicm9hZGNhc3RQcmVzZW5jZSgpOyAvLyBhbiBhZ2VudCB0YWlsIGF0dGFjaGVkIOKGkiB0ZWxsIHRoZSBicm93c2Vyc1xuICAgICAgICBoYiA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29udHJvbGxlci5lbnF1ZXVlKGVuYy5lbmNvZGUoYDogaGJcXG5cXG5gKSk7XG4gICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiBnb25lICovXG4gICAgICAgICAgfVxuICAgICAgICB9LCAxNTAwMCk7XG4gICAgICAgIHNzZVRpbWVycy5hZGQoaGIpO1xuICAgICAgfSxcbiAgICAgIGNhbmNlbCgpIHtcbiAgICAgICAgaWYgKGhiKSB7XG4gICAgICAgICAgY2xlYXJJbnRlcnZhbChoYik7XG4gICAgICAgICAgc3NlVGltZXJzLmRlbGV0ZShoYik7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlZikgc3NlQ2xpZW50cy5kZWxldGUocmVmKTtcbiAgICAgICAgYnJvYWRjYXN0UHJlc2VuY2UoKTsgLy8gdGhlIGFnZW50IHRhaWwgZHJvcHBlZCDihpIgdGVsbCB0aGUgYnJvd3NlcnNcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgcmV0dXJuIG5ldyBSZXNwb25zZShzdHJlYW0sIHtcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJ0ZXh0L2V2ZW50LXN0cmVhbVwiLFxuICAgICAgICBcIkNhY2hlLUNvbnRyb2xcIjogXCJuby1jYWNoZVwiLFxuICAgICAgICBDb25uZWN0aW9uOiBcImtlZXAtYWxpdmVcIixcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cblxuICBsZXQgc2Vzc2lvbkZpbGVzRGlyID0gXCJcIjsgLy8gc2V0IG9uY2Ugc2Vzc2lvbklkIGlzIGtub3duIChhZnRlciBiaW5kKVxuXG4gIGNvbnN0IG1vZGUgPSByZXNvbHZlTW9kZSgpO1xuXG4gIC8vIGRldjogdGhlIGR5bmFtaWMgc3RyaW5nLWxpdGVyYWwgaW1wb3J0IGtlZXBzIHRoZSBzdXJmYWNlIGdyYXBoIG9mZiB0aGVcbiAgLy8gbW9kdWxlIGxvYWQgcGF0aCAoQ29udHJhY3QgMSkg4oCUIEJ1biBidW5kbGVzIHRoZSAudHN4IGdyYXBoICsgVGFpbHdpbmQgYXRcbiAgLy8gc2VydmUgdGltZSwgcmVhZGluZyBidW5maWcudG9tbCBmcm9tIGN3ZCwgd2hpY2ggY2xpLnRzIHBpbnMgdG8gc3JjL21hZ3BpZS9cbiAgLy8gKENvbnRyYWN0IDUpLiBobXIgb24gZm9yIHRoZSBzdXJmYWNlIGl0ZXJhdGlvbiBsb29wLlxuICAvLyByZWxlYXNlOiBkaXN0LyBpcyBzdGF0aWMgYW5kIHByZS1idWlsdCAoQ29udHJhY3QgMikg4oCUIFwiL1wiIGlzIGFuc3dlcmVkIGJ5XG4gIC8vIHNlcnZlRGlzdCgpIGluIHRoZSBmZXRjaCBmYWxsLXRocm91Z2ggYmVsb3csIHNvIHRoaXMgYnJhbmNoIG5ldmVyIHRvdWNoZXNcbiAgLy8gc3VyZmFjZS8gb3IgYnVuZmlnLnRvbWwgYW5kIG5ldmVyIG5lZWRzIGVpdGhlciB0byBleGlzdC5cbiAgLy8gQnVuJ3MgUm91dGVzIHR5cGUgdGllcyB0aGUgXCIvXCIgdmFsdWUncyB0eXBlIHRvIHRoZSBsaXRlcmFsIG9iamVjdCBzaGFwZSwgc29cbiAgLy8gYSBtb2RlLXRlcm5hcnkgdW5pb24gY29uZnVzZXMgaXRzIG92ZXJsb2FkIHJlc29sdXRpb24g4oCUIHRoZSBydW50aW1lXG4gIC8vIGJlaGF2aW9yIChIVE1MQnVuZGxlIGluIGRldiwgYWJzZW50IGluIHJlbGVhc2UpIGlzIGNvcnJlY3QgZWl0aGVyIHdheS5cbiAgLy8g4puUIFRISVMgU1BFQ0lGSUVSIElTIFJFU09MVkVEIEZST00gYGRpc3QvYCwgTk9UIEZST00gVEhJUyBGSUxFLiBgc3JjL2J1aWxkLnRzYFxuICAvLyBwYXNzZXMgYGV4dGVybmFsYCBmb3IgdGhlIHN1cmZhY2UtSFRNTCBnbG9iLCBzbyB0aGUgYnVuZGxlciBkb2VzIG5vdCBmb2xsb3dcbiAgLy8gdGhpcyBpbXBvcnQgYW5kIGxlYXZlcyB0aGUgc3RyaW5nIGluIGBkaXN0L3NlcnZlci5qc2AgQllURS1GT1ItQllURS4gVGhlXG4gIC8vIGZpdmUgYC4uYCB0aGVyZWZvcmUgY291bnQgdXAgZnJvbVxuICAvLyBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21hZ3BpZS9kaXN0L2Ag4oCUIGRpc3Qg4oaSIG1hZ3BpZSDihpIgc2tpbGxzIOKGklxuICAvLyBzcGVsbGJvb2sg4oaSIHBsdWdpbnMg4oaSIHJlcG8gcm9vdCDigJQgYW5kIE5PVCBmcm9tIGBzcmMvbWFncGllL2JhY2tlbmQvYCwgd2hlcmVcbiAgLy8gdGhlIHNhbWUgc3RyaW5nIHdvdWxkIGNsaW1iIG91dCBvZiB0aGUgcmVwby4gUmVhZGluZyBpdCBhcyBhIG5vcm1hbFxuICAvLyByZWxhdGl2ZSBpbXBvcnQgb2YgdGhpcyBmaWxlIGlzIHRoZSBtaXN0YWtlIHRvIG1ha2UgaGVyZSwgYW5kIHJlbGVhc2UgbW9kZVxuICAvLyBuZXZlciBleGVjdXRlcyB0aGUgbGluZSwgc28gbm90aGluZyBidXQgYm9vdGluZyBhIERFViBkYWVtb24gY2FuIGNhdGNoIGl0LlxuICAvLyBgZ3JpbW9pcmUvaW1wb3J0LWJvdW5kYXJ5LXdhcmRzLnRlc3QudHNgIHBpbnMgaXQgYXQgdGhlIGVtaXR0ZWQgYWRkcmVzcyBmb3JcbiAgLy8gZXhhY3RseSB0aGF0IHJlYXNvbi5cbiAgY29uc3QgZGV2SW5kZXggPVxuICAgIG1vZGUgPT09IFwiZGV2XCJcbiAgICAgID8gKGF3YWl0IGltcG9ydChcIi4uLy4uLy4uLy4uLy4uL3NyYy9tYWdwaWUvc3VyZmFjZS9pbmRleC5odG1sXCIpKS5kZWZhdWx0XG4gICAgICA6IHVuZGVmaW5lZDtcbiAgY29uc3Qgcm91dGVzID0gKGRldkluZGV4ID8geyBcIi9cIjogZGV2SW5kZXggfSA6IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCBuZXZlcj47XG5cbiAgbGV0IHNlcnZlcjogUmV0dXJuVHlwZTx0eXBlb2YgQnVuLnNlcnZlPjtcbiAgdHJ5IHtcbiAgICBzZXJ2ZXIgPSBCdW4uc2VydmUoe1xuICAgICAgcG9ydCxcbiAgICAgIGhvc3RuYW1lOiBob3N0LFxuICAgICAgcm91dGVzLFxuICAgICAgLy8g4puUIEhFTEQgU1NFIENPTk5FQ1RJT05TIERJRSBXSVRIT1VUIFRISVMuIEJ1bidzIGRlZmF1bHQgcmVxdWVzdFxuICAgICAgLy8gaWRsZVRpbWVvdXQgaXMgMTBzIGFuZCBhIHNlcnZlci1zZW50IGhlYXJ0YmVhdCBkb2VzIE5PVCByZXNldCBpdCwgc28gYW5cbiAgICAgIC8vIFNTRSBjbGllbnQgaXMgY2xvc2VkIGJlZm9yZSB0aGUgMTVzIGA6IGhiYCBiZWxvdyBldmVyIGZpcmVzIOKAlCB0aGVcbiAgICAgIC8vIGtlZXBhbGl2ZSBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzIGtlZXBpbmcgYWxpdmUgaXNcbiAgICAgIC8vIGdvbmUsIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgcmF0ZSB3b3VsZCBub3QgaGF2ZSBoZWxwZWQuXG4gICAgICAvLyAyNTUgaXMgQnVuJ3MgbWF4aW11bSAoMCBpcyBub3QgXCJkaXNhYmxlZFwiKSwgbWF0Y2hpbmcgYm91bnR5LCBncmFwZXZpbmVcbiAgICAgIC8vIGFuZCBtaW5kLW1hcHBlcjsgYXN0cm9sYWJlIGVudi10dW5lcyBpdCBhbmQgY2xhbXBzIHRoZSBoZWFydGJlYXQgdG8gaGFsZi5cbiAgICAgIC8vIEZvdW5kIDIwMjYtMDktMDggYnkgdGhlIGJhY2tlbmQgZHVwbGljYXRpb24gcmVjb246IGZvdXIgc3BlbGxzIGhhZCBoaXRcbiAgICAgIC8vIHRoaXMgYW5kIGZpeGVkIGl0LCB0aHJlZSBoYWQgbm90LCBiZWNhdXNlIHRoZSBkYWVtb24gc3BpbmUgaXMgb25lIGRlc2lnblxuICAgICAgLy8gaW1wbGVtZW50ZWQgc2l4IHRpbWVzLlxuICAgICAgaWRsZVRpbWVvdXQ6IDI1NSxcbiAgICAgIGRldmVsb3BtZW50OiB7IGhtcjogbW9kZSA9PT0gXCJkZXZcIiB9LFxuICAgICAgZmV0Y2g6IChyZXEsIHNydikgPT4ge1xuICAgICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwpO1xuICAgICAgICBjb25zdCBwYXRoID0gdXJsLnBhdGhuYW1lO1xuICAgICAgICBpZiAocGF0aCA9PT0gXCIvd3NcIikge1xuICAgICAgICAgIGNvbnN0IHVwZ3JhZGVkID0gc3J2LnVwZ3JhZGUocmVxKTtcbiAgICAgICAgICBpZiAodXBncmFkZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShcInVwZ3JhZGUgcmVxdWlyZWRcIiwgeyBzdGF0dXM6IDQyNiB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9zdGF0ZVwiKSB7XG4gICAgICAgICAgY29uc3QgbGVhbiA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwibGVhblwiKSA9PT0gXCIxXCI7XG4gICAgICAgICAgY29uc3QgcGF5bG9hZCA9IGxlYW4gPyBsZWFuU3RhdGUoc3RhdGUpIDogc3RhdGU7XG4gICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShKU09OLnN0cmluZ2lmeSh7IHN0YXRlOiBwYXlsb2FkLCBjdXJzb3I6IGV2ZW50U2VxIH0pLCB7XG4gICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZXZlbnRzXCIpIHtcbiAgICAgICAgICByZXR1cm4gc3NlUmVzcG9uc2UodXJsKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJQT1NUXCIgJiYgcGF0aCA9PT0gXCIvY21kXCIpIHtcbiAgICAgICAgICByZXR1cm4gcmVxXG4gICAgICAgICAgICAuanNvbigpXG4gICAgICAgICAgICAudGhlbigoYm9keSkgPT4ge1xuICAgICAgICAgICAgICB0b3VjaCgpO1xuICAgICAgICAgICAgICAvLyAjODQg4oCUIHByb3BhZ2F0ZSB0aGUgaGFuZGxlcidzIHZlcmRpY3QgcmF0aGVyIHRoYW4gYSBsaXRlcmFsXG4gICAgICAgICAgICAgIC8vIHtvazp0cnVlfS4gYGFwcGxpZWRgIGlzIGJvdW50eSdzIGV4aXN0aW5nIGZpZWxkOyBub3RoaW5nIG5ldy5cbiAgICAgICAgICAgICAgY29uc3QgdmVyZGljdCA9IGhhbmRsZUFnZW50TXNnKGJvZHkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pO1xuICAgICAgICAgICAgICAvLyBBIGNvbW1hbmQgdGhhdCBhbnN3ZXJlZCB3aXRoIGl0cyBvd24gcmVzdWx0IGNhcnJpZXMgaXRzIHN0YXR1c1xuICAgICAgICAgICAgICAvLyBhbmQgcGF5bG9hZDsgdGhlIGJvb2xlYW4gcGF0aCBiZWxvdyBpcyB1bmNoYW5nZWQuXG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgdmVyZGljdCA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgICAgIGlmICghdmVyZGljdC5vaylcbiAgICAgICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKFxuICAgICAgICAgICAgICAgICAgICB7IG9rOiBmYWxzZSwgYXBwbGllZDogZmFsc2UsIGVycm9yOiB2ZXJkaWN0LmVycm9yIH0sXG4gICAgICAgICAgICAgICAgICAgIHsgc3RhdHVzOiB2ZXJkaWN0LnN0YXR1cyB9LFxuICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiB0cnVlLCBhcHBsaWVkOiB0cnVlLCAuLi52ZXJkaWN0LmRldGFpbCB9KTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBjb25zdCBhcHBsaWVkID0gdmVyZGljdDtcbiAgICAgICAgICAgICAgaWYgKCFhcHBsaWVkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oXG4gICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgYXBwbGllZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIGVycm9yOiBgdW5yZWNvZ25pc2VkIGNvbW1hbmQgdHlwZSAke0pTT04uc3RyaW5naWZ5KFxuICAgICAgICAgICAgICAgICAgICAgIChib2R5IGFzIHsgdHlwZT86IHVua25vd24gfSk/LnR5cGUsXG4gICAgICAgICAgICAgICAgICAgICl9IOKAlCBub3RoaW5nIHdhcyBhcHBsaWVkYCxcbiAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICB7IHN0YXR1czogNDAwIH0sXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCd7XCJva1wiOnRydWUsXCJhcHBsaWVkXCI6dHJ1ZX0nLCB7XG4gICAgICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAuY2F0Y2goXG4gICAgICAgICAgICAgICgpID0+XG4gICAgICAgICAgICAgICAgbmV3IFJlc3BvbnNlKCd7XCJlcnJvclwiOlwiYmFkIGpzb25cIn0nLCB7XG4gICAgICAgICAgICAgICAgICBzdGF0dXM6IDQwMCxcbiAgICAgICAgICAgICAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aC5zdGFydHNXaXRoKFwiL2Fzc2V0cy9cIikpIHtcbiAgICAgICAgICAvLyBTZXJ2ZSBwZXItc2Vzc2lvbiBmaWxlcyAodGhlIHNvdXJjZSBib2FyZCwgbWF0ZXJpYWxpemVkIGN1dG91dHMpLlxuICAgICAgICAgIGNvbnN0IGFzc2V0TmFtZSA9IGRlY29kZVVSSUNvbXBvbmVudChwYXRoLnNsaWNlKFwiL2Fzc2V0cy9cIi5sZW5ndGgpKTtcbiAgICAgICAgICBpZiAoYXNzZXROYW1lLmluY2x1ZGVzKFwiLi5cIikgfHwgYXNzZXROYW1lLnN0YXJ0c1dpdGgoXCIvXCIpIHx8ICFzZXNzaW9uRmlsZXNEaXIpIHtcbiAgICAgICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoJ3tcImVycm9yXCI6XCJub3QgZm91bmRcIn0nLCB7XG4gICAgICAgICAgICAgIHN0YXR1czogNDA0LFxuICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgZiA9IEJ1bi5maWxlKGpvaW4oc2Vzc2lvbkZpbGVzRGlyLCBhc3NldE5hbWUpKTtcbiAgICAgICAgICByZXR1cm4gZi5leGlzdHMoKS50aGVuKChleGlzdHMpID0+XG4gICAgICAgICAgICBleGlzdHNcbiAgICAgICAgICAgICAgPyBuZXcgUmVzcG9uc2UoZiwgeyBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IGd1ZXNzTWltZShhc3NldE5hbWUpIH0gfSlcbiAgICAgICAgICAgICAgOiBuZXcgUmVzcG9uc2UoJ3tcImVycm9yXCI6XCJub3QgZm91bmRcIn0nLCB7XG4gICAgICAgICAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgICAgICAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIC8vIHJlbGVhc2U6IFwiL1wiIGFuZCB0aGUgaGFzaGVkIGNodW5rLSouanMvY3NzIGFyZSBzdGF0aWMgZGlzdCByZWFkcy4gRGV2XG4gICAgICAgIC8vIG5ldmVyIHJlYWNoZXMgaGVyZSBmb3IgXCIvXCIg4oCUIHRoZSByb3V0ZXMgdGFibGUgYWJvdmUgYW5zd2VycyBpdCBmaXJzdC5cbiAgICAgICAgLy8gVGhpcyBzaXRzIEFGVEVSIC9hc3NldHMvLCB3aGljaCBzZXJ2ZXMgc2Vzc2lvbiBmaWxlcywgbm90IGRpc3Qgb25lcy5cbiAgICAgICAgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgICAgY29uc3QgYXNzZXQgPSBzZXJ2ZURpc3QocGF0aCk7XG4gICAgICAgICAgaWYgKGFzc2V0KSByZXR1cm4gYXNzZXQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZSgne1wiZXJyb3JcIjpcIm5vdCBmb3VuZFwifScsIHtcbiAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgIH0pO1xuICAgICAgfSxcbiAgICAgIHdlYnNvY2tldDoge1xuICAgICAgICBvcGVuKHdzKSB7XG4gICAgICAgICAgc29ja2V0cy5hZGQod3MpO1xuICAgICAgICAgIHRvdWNoKCk7XG4gICAgICAgICAgZW1pdEV2ZW50KHsgdHlwZTogXCJjb25uZWN0ZWRcIiB9KTtcbiAgICAgICAgICB3cy5zZW5kKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJzdGF0ZVwiLCBzdGF0ZSB9KSk7XG4gICAgICAgICAgd3Muc2VuZChKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwicHJlc2VuY2VcIiwgYWdlbnQ6IHNzZUNsaWVudHMuc2l6ZSA+IDAgfSkpO1xuICAgICAgICB9LFxuICAgICAgICBtZXNzYWdlKF93cywgcmF3KSB7XG4gICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICBsZXQgbXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgbXNnID0gSlNPTi5wYXJzZSh0eXBlb2YgcmF3ID09PSBcInN0cmluZ1wiID8gcmF3IDogbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHJhdykpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgICBgbWFncGllOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmAsXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBoYW5kbGVCcm93c2VyTXNnKG1zZyk7XG4gICAgICAgIH0sXG4gICAgICAgIGNsb3NlKHdzKSB7XG4gICAgICAgICAgc29ja2V0cy5kZWxldGUod3MpO1xuICAgICAgICAgIGVtaXRFdmVudCh7IHR5cGU6IFwiZGlzY29ubmVjdGVkXCIgfSk7XG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGV2ZW50OiBcImJpbmRfZXJyb3JcIixcbiAgICAgICAgaG9zdCxcbiAgICAgICAgcG9ydCxcbiAgICAgICAgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSxcbiAgICAgIH0pfVxcbmAsXG4gICAgKTtcbiAgICByZXR1cm4gMjtcbiAgfVxuXG4gIGNvbnN0IGJvdW5kUG9ydCA9IHNlcnZlci5wb3J0O1xuICBpZiAoIXNlc3Npb25JZCkgc2Vzc2lvbklkID0gYG1hZ3BpZS0ke3JhbmRIZXgoNCl9LXAke2JvdW5kUG9ydH1gO1xuICBzdGF0ZS5zZXNzaW9uSWQgPSBzZXNzaW9uSWQ7IC8vIHJ1bnRpbWU6IHN1cmZhY2UgKEV4cG9ydCByZW9wZW4gaGludCkgcmVhZHMgaXRcbiAgc2Vzc2lvbkZpbGVzRGlyID0gam9pbih0bXBkaXIoKSwgYCR7c2Vzc2lvbklkfS1maWxlc2ApO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhzZXNzaW9uRmlsZXNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIGJhY2sgdG8gbm8tZmlsZS1wYXRocyAqL1xuICB9XG4gIGlmIChyZXN0b3JlZCkgc2F2ZVNuYXBzaG90KHNlc3Npb25JZCwgc3RhdGUpO1xuXG4gIGNvbnN0IHVybCA9IGBodHRwOi8vJHtob3N0fToke2JvdW5kUG9ydH1gO1xuICAvLyBgbW9kZWAgaXMgdGhlIE9OTFkgdGhpbmcgdGhhdCBkaXNjcmltaW5hdGVzIGEgcmVsZWFzZSBkYWVtb24gZnJvbSBhIGRldlxuICAvLyBvbmU6IHdpdGggcm9vdCBkZXBzIHByZXNlbnQgYSBkZXYgZGFlbW9uIHJlbmRlcnMgYW4gaWRlbnRpY2FsLWxvb2tpbmdcbiAgLy8gc3VyZmFjZSwgc28gXCJpdCBsb29rcyByaWdodFwiIGNhbm5vdCB2ZXJpZnkgQ29udHJhY3QgMS5cbiAgZW1pdEV2ZW50KHsgdHlwZTogXCJyZWFkeVwiLCB1cmwsIHBvcnQ6IGJvdW5kUG9ydCwgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLCBtb2RlIH0pO1xuXG4gIC8vIERpc2NvdmVyeSBmaWxlcyDigJQgY2xpLnRzIHJlYWRzIHRoZSBwb3J0IGZyb20gaGVyZS5cbiAgY29uc3Qgc2Vzc2lvbkZpbGUgPSBqb2luKHRtcGRpcigpLCBgbWFncGllLSR7c2Vzc2lvbklkfS5qc29uYCk7XG4gIGNvbnN0IGxhdGVzdEZpbGUgPSBqb2luKHRtcGRpcigpLCBgbWFncGllLWxhdGVzdC5qc29uYCk7XG4gIGNvbnN0IHNlc3Npb25JbmZvID0gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHVybCxcbiAgICBwb3J0OiBib3VuZFBvcnQsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIHRpdGxlOiBzdGF0ZS50aXRsZSxcbiAgICBmaWxlc19kaXI6IHNlc3Npb25GaWxlc0RpcixcbiAgICAvLyBtYWdwaWUgd3JpdGVzIE5PIHN0ZG91dCBoYW5kc2hha2UgKG1pbmQtbWFwcGVyIGFuZCBhc3Ryb2xhYmUgZG8pIOKAlCBpdHNcbiAgICAvLyBoYW5kc2hha2UgaXMgdGhpcyBkaXNjb3ZlcnkgZmlsZSwgc28gYG1vZGVgIHJpZGVzIEJPVEggaXQgYW5kIHRoZSBTU0VcbiAgICAvLyBgcmVhZHlgIGV2ZW50OiBzYW1lIHJvbGUsIGRpZmZlcmVudCB0cmFuc3BvcnQsIGFzIGltYWdvIGRvZXMgaXQuXG4gICAgbW9kZSxcbiAgfSk7XG4gIC8vIOKaoCBBVE9NSUMsIGJlY2F1c2UgcmVhZFNlc3Npb24gbm93IHRyZWF0cyB1bnBhcnNlYWJsZSBjb250ZW50IGFzIGNvcnJ1cHRpb25cbiAgLy8gcmF0aGVyIHRoYW4gYWJzZW5jZS4gQSBiYXJlIHdyaXRlRmlsZVN5bmMgaXMgbm90IGF0b21pYzogYSBDTEkgcmVhZGluZ1xuICAvLyB3aGlsZSB0aGUgZGFlbW9uIHdyaXRlcyBjYW4gb2JzZXJ2ZSBhIGhhbGYtd3JpdHRlbiBwb2ludGVyLCBhbmQgdW5kZXIgdGhlXG4gIC8vIG9sZCBiZXN0LWVmZm9ydCByZWFkIHRoYXQgc3VyZmFjZWQgYXMgXCJubyBydW5uaW5nIHNlc3Npb25cIi4gV3JpdGUgYmVzaWRlXG4gIC8vIHRoZSB0YXJnZXQgYW5kIHJlbmFtZSDigJQgcmVuYW1lIHdpdGhpbiBvbmUgZGlyZWN0b3J5IGlzIGF0b21pYywgc28gYSByZWFkZXJcbiAgLy8gc2VlcyBlaXRoZXIgdGhlIHByZXZpb3VzIHBvaW50ZXIgb3IgdGhlIG5ldyBvbmUsIG5ldmVyIGEgcGFydGlhbCBmaWxlLlxuICAvLyBGaXhlZCBpbiBnbGFtb3VyIDIwMjYtMDktMDc7IGZvdW5kIHN0YW5kaW5nIGluIHRocmVlIHNpYmxpbmdzIDIwMjYtMDktMDhcbiAgLy8gKGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC1iYWNrZW5kLWR1cGxpY2F0aW9uLXJlY29uLm1kKS5cbiAgY29uc3Qgd3JpdGVBdG9taWMgPSAodGFyZ2V0OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4ge1xuICAgIGNvbnN0IHRtcCA9IGAke3RhcmdldH0uJHtwcm9jZXNzLnBpZH0udG1wYDtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlU3luYyh0bXAsIHRleHQpO1xuICAgICAgcmVuYW1lU3luYyh0bXAsIHRhcmdldCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0cnkge1xuICAgICAgICBybVN5bmModG1wLCB7IGZvcmNlOiB0cnVlIH0pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHRoZSB0ZW1wIGZpbGUgaXMgYWxyZWFkeSBnb25lLCBvciB3YXMgbmV2ZXIgY3JlYXRlZCAqL1xuICAgICAgfVxuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cbiAgfTtcbiAgdHJ5IHtcbiAgICB3cml0ZUF0b21pYyhzZXNzaW9uRmlsZSwgc2Vzc2lvbkluZm8pO1xuICAgIHdyaXRlQXRvbWljKGxhdGVzdEZpbGUsIHNlc3Npb25JbmZvKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYG1hZ3BpZTogY291bGQgbm90IHdyaXRlIGRpc2NvdmVyeSBmaWxlOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG5gLFxuICAgICk7XG4gIH1cbiAgY29uc3QgY2xlYW51cERpc2NvdmVyeSA9IGFzeW5jICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgdW5saW5rU3luYyhzZXNzaW9uRmlsZSk7XG4gICAgfSBjYXRjaCB7fVxuICAgIHRyeSB7XG4gICAgICBjb25zdCBjdXIgPSBhd2FpdCBCdW4uZmlsZShsYXRlc3RGaWxlKS50ZXh0KCk7XG4gICAgICBpZiAoSlNPTi5wYXJzZShjdXIpLnNlc3Npb25faWQgPT09IHNlc3Npb25JZCkgdW5saW5rU3luYyhsYXRlc3RGaWxlKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGdvbmUg4oCUIGZpbmUgKi9cbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIGlmIChzZXNzaW9uRmlsZXNEaXIpIHJtU3luYyhzZXNzaW9uRmlsZXNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9IGNhdGNoIHt9XG4gIH07XG5cbiAgaWYgKCF2W1wibm8tb3BlblwiXSkgb3BlbkJyb3dzZXIodXJsKTtcblxuICBjb25zdCBpZGxlVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgaWYgKChwZXJmb3JtYW5jZS5ub3coKSAtIGxhc3RBY3Rpdml0eSkgLyAxMDAwID49IHRpbWVvdXQpIHtcbiAgICAgIHJlc29sdmVEb25lKHsgY29kZTogMTI0LCByZWFzb246IFwidGltZW91dFwiIH0pO1xuICAgIH1cbiAgfSwgMjUwKTtcblxuICAvLyBEZWJvdW5jZWQgcGVyc2lzdGVuY2U6IHNuYXBzaG90IH4xcyBhZnRlciBhbnkgY2hhbmdlIHNvIGEgcmVzdGFydCByZXN1bWVzLlxuICBjb25zdCBzbmFwVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgaWYgKHNuYXBEaXJ0eSkge1xuICAgICAgc25hcERpcnR5ID0gZmFsc2U7XG4gICAgICBzYXZlU25hcHNob3Qoc2Vzc2lvbklkLCBzdGF0ZSk7XG4gICAgfVxuICB9LCAxMDAwKTtcblxuICBjb25zdCB7IGNvZGUsIHJlYXNvbiB9ID0gYXdhaXQgZG9uZTtcbiAgY2xlYXJJbnRlcnZhbChpZGxlVGltZXIpO1xuICBjbGVhckludGVydmFsKHNuYXBUaW1lcik7XG4gIHNhdmVTbmFwc2hvdChzZXNzaW9uSWQsIHN0YXRlKTsgLy8gZmluYWwgd3JpdGUg4oCUIHRoZSByZXN1bWUgcG9pbnRcbiAgZW1pdEV2ZW50KHsgdHlwZTogXCJjbG9zZWRcIiwgcmVhc29uIH0pO1xuICBicm9hZGNhc3QoeyB0eXBlOiBcIm1lc3NhZ2VcIiwgdGV4dDogYHNlc3Npb24gZW5kZWQ6ICR7cmVhc29ufWAgfSk7XG4gIC8vIEdyYWNlIHBlcmlvZCBzbyB0aGUgY2xvc2VkIGV2ZW50ICsgc3VibWl0L2NhbmNlbCBicm9hZGNhc3RzIGZsdXNoLlxuICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxNTApKTtcbiAgZm9yIChjb25zdCB0IG9mIHNzZVRpbWVycykgY2xlYXJJbnRlcnZhbCh0KTtcbiAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIHtcbiAgICB0cnkge1xuICAgICAgYy5jbG9zZSgpO1xuICAgIH0gY2F0Y2gge31cbiAgfVxuICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMpIHtcbiAgICB0cnkge1xuICAgICAgd3MuY2xvc2UoKTtcbiAgICB9IGNhdGNoIHt9XG4gIH1cbiAgLy8gUmFjZSB0aGUgZ3JhY2VmdWwgc3RvcCBhZ2FpbnN0IGEgdGltZXIg4oCUIG5ldmVyIGhhbmcgdGVhcmRvd24gb24gYSBzbG93IHNvY2tldC5cbiAgYXdhaXQgUHJvbWlzZS5yYWNlKFtzZXJ2ZXIuc3RvcCh0cnVlKSwgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMjAwKSldKTtcbiAgYXdhaXQgY2xlYW51cERpc2NvdmVyeSgpO1xuICByZXR1cm4gY29kZTtcbn1cblxuLyoqXG4gKiBUaGUgZGFlbW9uJ3MgZW50cnksIGZvciB0aGUgTEFVTkNIRVIgYXRcbiAqIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWFncGllL3NjcmlwdHMvc2VydmVyLnRzYC5cbiAqXG4gKiDim5QgYGltcG9ydC5tZXRhLm1haW5gIElTIEZBTFNFIElOIFRIRSBCVU5ETEUuIGBkaXN0L3NlcnZlci5qc2AgaXMgSU1QT1JURUQgYnlcbiAqIHRoZSBsYXVuY2hlciwgbmV2ZXIgZXhlY3V0ZWQgYXMgdGhlIHByb2Nlc3MgZW50cnksIHNvIHRoZSBvbGRcbiAqIGBpZiAoaW1wb3J0Lm1ldGEubWFpbilgIGJsb2NrIHdvdWxkIHNpbXBseSBuZXZlciBydW4g4oCUIHRoZSBkYWVtb24gd291bGQgYm9vdCxcbiAqIHNlcnZlIG5vdGhpbmcgYW5kIGV4aXQgMC4gVGhhdCBpcyB0aGUgZmFpbHVyZSB0aGlzIGV4cG9ydCBleGlzdHMgdG8gcHJldmVudC5cbiAqXG4gKiDim5QgQU5EIElUIFRBS0VTIE5PIEFSR1VNRU5UUywgZm9yIHRoZSBzYW1lIHJlYXNvbiBgY2xpLnRzYCdzIGBydW4oKWAgZG9lcyBub3Q6XG4gKiB0aGUgY29tbWFuZCBsaW5lIGJlbG9uZ3MgdG8gdGhlIGZpbGUgdGhhdCBQQVJTRVMgaXQuIEEgbGF1bmNoZXIgdGhhdCB0b3VjaGVkXG4gKiBgcHJvY2Vzcy5hcmd2YCB3b3VsZCBtYXRjaCBgZ3JpbW9pcmUvbGliL2VudHJ5LXBvaW50cy50c2AncyBhcmctcGFyc2luZ1xuICogcHJlZGljYXRlIGFuZCB0aGUgd2FyZHMgd291bGQganVkZ2UgdGhpcyBkYWVtb24ncyBmbGFncyBhZ2FpbnN0IGEgZmlsZSB0aGF0XG4gKiByZWNvZ25pc2VzIG5vbmUuXG4gKlxuICogVGhlIHRlcm1pbmFsIGBwcm9jZXNzLmV4aXQoZXhpdENvZGUpYCBzdGF5cyB3aGVyZSBpdCBhbHdheXMgd2FzIOKAlCBhdCB0aGUgc2l0ZVxuICogdGhhdCBpcyB0aGUgcHJvY2VzcyBlbnRyeSwgd2hpY2ggaXMgbm93IHRoZSBsYXVuY2hlci4gSXQgaXMgZmFtaWx5IEUtdGVybWluYWxcbiAqIGluIGBncmltb2lyZS9leGl0LXNpdGUtaW52ZW50b3J5LnRlc3QudHNgICh0ZWFyZG93biBoYXMgYWxyZWFkeSBydW4gaW5zaWRlXG4gKiBgbWFpbmApLCBpdCBpcyBhIERBRU1PTidzIGV4aXQgYW5kIG5vdCBhIENMSSdzLCBhbmQgRDgncyBgZGllYC10aHJvd3MgcnVsaW5nXG4gKiBkZWxpYmVyYXRlbHkgZG9lcyBub3QgcmVhY2ggaXQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cblxuZXhwb3J0IHR5cGUgeyBNYWdwaWVTdGF0ZSB9IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWFncGllL3NoYXJlZC90eXBlc1wiO1xuZXhwb3J0IHsgZGVmYXVsdFN0YXRlIH0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9tYWdwaWUvc2hhcmVkL3R5cGVzXCI7XG5leHBvcnQgeyBsZWFuU3RhdGUgfSBmcm9tIFwiLi9yZWR1Y2VcIjtcbmV4cG9ydCB7IG1haW4sIHBhcnNlUG9ydEZyb21TZXNzaW9uSWQsIHNuYXBzaG90c0RpciB9O1xuIiwKICAgICIvLyBzaGFyZWQvdHlwZXMudHNcbi8vIFRoZSBzaW5nbGUgc2hhcmVkIGNvbnRyYWN0IGZvciBtYWdwaWUncyBjb25qdXJhdGlvbi4gSW1wb3J0ZWQgYnkgc2VydmVyLnRzLFxuLy8gcmVkdWNlLnRzLCBjbGkudHMsIEFORCB0aGUgUmVhY3QgY2xpZW50LlxuLy9cbi8vIG1hZ3BpZSAocmVidWlsdCkgaXMgYSBTVEFORElORyBSRVZJRVcgU1VSRkFDRSBvdmVyIGEgY29tcG9zaXRlIGltYWdlOiB0aGVcbi8vIGRhZW1vbiBob2xkcyB0aGUgZXh0cmFjdGlvbiBzdGF0ZSwgdGhlIFJlYWN0IHN1cmZhY2Ugc2hvd3MgdGhlIGVsZW1lbnRcbi8vIGJyZWFrZG93biwgYW5kIHRoZSB1c2VyIGp1ZGdlcyBlYWNoIGN1dG91dCwgY29tcGFyZXMgcmVtb3ZhbC1tb2RlbCByZXN1bHRzLFxuLy8gYW5kIHNlbGVjdGl2ZWx5IHJldHJpZXMuIFRoZSBhZ2VudCBkcml2ZXMgZGlzY292ZXJ5ICsgZXh0cmFjdGlvbjsgdGhlIHN1cmZhY2Vcbi8vIGlzIHdoZXJlIHRoZSB1c2VyIHN0ZWVycy5cbi8vXG4vLyBQUk9WSVNJT05BTCDigJQgdGhpcyBzdGF0ZSBzaGFwZSBpcyBhIGRlc2lnbi1pbmRlcGVuZGVudCBza2VsZXRvbi4gVGhlXG4vLyBtYWdwaWUtc3BlY2lmaWMgc3VyZmFjZSArIHRoZSBmaW5hbCBzZXR0bGVkIHNoYXBlIGFyZSBiZWluZyBkZXNpZ25lZCBpblxuLy8gcGFyYWxsZWwuIEV2ZXJ5dGhpbmcgbWFya2VkIGAvLyBUT0RPKG1vY2spOiDigKZgIGlzIGEgZGVsaWJlcmF0ZSBwbGFjZWhvbGRlciB0aGVcbi8vIG1vY2sgdHJhY2sgd2lsbCByZXBsYWNlOyBrZWVwIG11dGF0b3JzIChyZWR1Y2UudHMpIHRoaW4gYXJvdW5kIGl0LlxuXG4vLyBUaGUgZWxlbWVudCB0eXBlIHRheG9ub215IHBvcnRlZCBmcm9tIHRoZSBQeXRob24gb3JpZ2luYWwg4oCUIGRyaXZlcyB0aGUgKGZ1dHVyZSlcbi8vIGJhY2tncm91bmQtcmVtb3ZhbCBkZWNpc2lvbiBpbiBleHRyYWN0LlxuZXhwb3J0IHR5cGUgRWxlbWVudFR5cGUgPVxuICB8IFwid29yZG1hcmtcIlxuICB8IFwidGFnbGluZVwiXG4gIHwgXCJpY29uXCJcbiAgfCBcImlsbHVzdHJhdGlvblwiXG4gIHwgXCJzdGlja2VyXCJcbiAgfCBcInBhbGV0dGVcIlxuICB8IFwidHlwb2dyYXBoeVwiXG4gIHwgXCJzY3JlZW5zaG90XCJcbiAgfCBcIm90aGVyXCI7XG5cbmV4cG9ydCBjb25zdCBFTEVNRU5UX1RZUEVTOiByZWFkb25seSBFbGVtZW50VHlwZVtdID0gW1xuICBcIndvcmRtYXJrXCIsXG4gIFwidGFnbGluZVwiLFxuICBcImljb25cIixcbiAgXCJpbGx1c3RyYXRpb25cIixcbiAgXCJzdGlja2VyXCIsXG4gIFwicGFsZXR0ZVwiLFxuICBcInR5cG9ncmFwaHlcIixcbiAgXCJzY3JlZW5zaG90XCIsXG4gIFwib3RoZXJcIixcbl0gYXMgY29uc3Q7XG5cbi8vIFRoZSBsaW5lYXIgcHJvY2VzcyBzcGluZSAodGhlIHRvcC1iYXIgc3RlcHBlcikuIE9uZSBhY3RpdmUgcGhhc2UgYXQgYSB0aW1lO1xuLy8gdGhlIGN1cnNvciBhZHZhbmNlcyB3aGVuIHRoZSB1c2VyIHNlYWxzIGEgcGhhc2UuIFN0YXR1cyBpcyBERVJJVkVEIGZyb20gdGhlXG4vLyBjdXJzb3Ig4oCUIHBoYXNlcyBiZWZvcmUgaXQgYXJlIHNlYWxlZCwgdGhlIGN1cnNvciBpcyBhY3RpdmUsIGFmdGVyIGlzIHVwY29taW5nLlxuZXhwb3J0IHR5cGUgUGhhc2VLZXkgPSBcImludGFrZVwiIHwgXCJzbGljZVwiIHwgXCJyZW1vdmVcIiB8IFwiZXhwb3J0XCI7XG5leHBvcnQgY29uc3QgUEhBU0VTOiByZWFkb25seSBQaGFzZUtleVtdID0gW1wiaW50YWtlXCIsIFwic2xpY2VcIiwgXCJyZW1vdmVcIiwgXCJleHBvcnRcIl0gYXMgY29uc3Q7XG5cbi8vIEEgcGl4ZWwgYm91bmRpbmcgYm94IFt4MSwgeTEsIHgyLCB5Ml0gaW4gc291cmNlLWltYWdlIGNvb3JkaW5hdGVzIChtYXRjaGVzXG4vLyB0aGUgUHl0aG9uIG9yaWdpbmFsJ3MgYGJib3hfcGl4ZWxgKS5cbmV4cG9ydCB0eXBlIEJib3ggPSBbbnVtYmVyLCBudW1iZXIsIG51bWJlciwgbnVtYmVyXTtcblxuLy8gVGhlIGJhY2tkcm9wIHRoZSBzdXJmYWNlIHByZXZpZXdzIGN1dG91dHMgYWdhaW5zdCAoYSBjaGVja2VyIGZvciB0cmFuc3BhcmVudCkuXG5leHBvcnQgdHlwZSBCYWNrZHJvcCA9IFwid2hpdGVcIiB8IFwiZ3JheVwiIHwgXCJibGFja1wiIHwgXCJ0cmFuc3BhcmVudFwiO1xuXG4vLyBPbmUgZXh0cmFjdGFibGUgZWxlbWVudC4gTUlOSU1BTCBwcm92aXNpb25hbCBzaGFwZSDigJQgdGhlIHJldmlldy9qdWRnbWVudFxuLy8gbWFjaGluZXJ5IGlzIG1vY2tlZCBvdXQgZm9yIG5vdy4gYGJib3hgIGlzIGNhbm9uaWNhbCBpbiBTT1VSQ0UgUElYRUxTICh3aGF0XG4vLyBkaXNjb3ZlciBwcm9kdWNlcyBhbmQgY3JvcCBjb25zdW1lcyk7IHRoZSBjYW52YXMgY29udmVydHMgcHjihpRmcmFjdGlvbiB2aWFcbi8vIGBzb3VyY2Uuc2l6ZWAgZm9yIHJlbmRlcmluZy9lZGl0aW5nLlxuZXhwb3J0IHR5cGUgRWxlbWVudFN0YXR1cyA9IFwicHJvcG9zZWRcIiB8IFwiY29uZmlybWVkXCIgfCBcImRyb3BwZWRcIjtcblxuLy8gQSBwcm9kdWNlZCBhc3NldCBmb3Igb25lIGVsZW1lbnQ6IHRoZSByYXcgY3JvcCAobW9kZWw6XCJjcm9wXCIpIG9yIGEgcmVtb3ZhbFxuLy8gcmVzdWx0LiBgcGF0aGAgaXMgdGhlIG9uLWRpc2sgUE5HIHNlcnZlZCB2aWEgL2Fzc2V0czsgYHJldmAgYnVtcHMgb24gZXZlcnlcbi8vIChyZS0pcnVuIG9mIHRoZSBTQU1FIG1vZGVsIOKAlCB0aGUgZmlsZSBpcyBvdmVyd3JpdHRlbiBpbiBwbGFjZSwgc28gdGhlIHN1cmZhY2Vcbi8vIGFwcGVuZHMgP3Y9PHJldj4gdG8gYnVzdCB0aGUgYnJvd3NlciBjYWNoZS4gYGtpbmRgIGlzIGEgbGFiZWwtY2hpcCBoaW50IHRoZVxuLy8gYWdlbnQgc3VwcGxpZXM7IG5ldmVyIGluZmVycmVkIGluIHRoZSBVSS5cbmV4cG9ydCB0eXBlIEVsZW1lbnRWZXJzaW9uID0ge1xuICBpZDogc3RyaW5nO1xuICBtb2RlbDogc3RyaW5nOyAvLyBcImNyb3BcIiB8IFwicmVtYmdcIiB8IFwiYnJpYVwiIHwgXCJpZGVvZ3JhbVwiIHwg4oCmIChhZ2VudC1kZWZpbmVkKVxuICBraW5kPzogXCJyYXdcIiB8IFwibG9jYWxcIiB8IFwiY2xvdWRcIjtcbiAgcGF0aDogc3RyaW5nO1xuICByZXY6IG51bWJlcjtcbiAgbm90ZT86IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIEVsZW1lbnQgPSB7XG4gIGlkOiBzdHJpbmc7XG4gIG5hbWU6IHN0cmluZztcbiAgdHlwZTogRWxlbWVudFR5cGU7XG4gIGJib3g6IEJib3g7XG4gIHN0YXR1czogRWxlbWVudFN0YXR1cztcbiAgLy8g4pSA4pSAIGV4dHJhY3Rpb24g4pSA4pSAXG4gIC8vIFByb2R1Y2VkIGFzc2V0cywgb25lIHJvdyBwZXIgbW9kZWwuIGNyb3AgPSB2ZXJzaW9uc1swXSAobW9kZWw6XCJjcm9wXCIpLlxuICAvLyBBYnNlbnQgdW50aWwgdGhlIGZpcnN0IGN1dDsgdHJlYXQgdW5kZWZpbmVkIGFzIFtdLiBUaGUgY2hvc2VuIHZlcnNpb24gaXNcbiAgLy8gd2hhdCB0aGUgcmFpbC9nYWxsZXJ5IHJlbmRlciAoY2hvc2VuVmVyc2lvbigpIGZhbGxzIGJhY2sgdG8gdmVyc2lvbnNbMF0pLlxuICB2ZXJzaW9ucz86IEVsZW1lbnRWZXJzaW9uW107XG4gIGNob3NlblZlcnNpb25JZD86IHN0cmluZztcbiAgLy8gVGhlIHNvbGUgcmV2aWV3IHNpZ25hbDogdGhlIHVzZXIgZmxhZ2dlZCB0aGlzIGVsZW1lbnQgdG8gYmUgcmUtcnVuIChyZS1zbGljZVxuICAvLyBpbiB0aGUgc2xpY2VzIHBoYXNlLCByZS1yZW1vdmUgaW4gdGhlIGJnIHBoYXNlKS4gQXBwcm92YWwgaXMgdGhlIEFCU0VOQ0Ugb2YgYVxuICAvLyBmbGFnOyBkaXNjYXJkaW5nIGlzIHN0YXR1czpcImRyb3BwZWRcIi4gQ2xlYXJlZCB3aGVuIGEgZnJlc2ggdmVyc2lvbiBsYW5kcy5cbiAgZmxhZ2dlZD86IGJvb2xlYW47XG59O1xuXG4vLyDilIDilIAgdGhlIGNvbnZlcnNhdGlvbiAodGhlIHNwaW5lLCBwb3J0ZWQgc2V0dGxlZCBmcm9tIGltYWdvKSDilIDilIBcbmV4cG9ydCB0eXBlIE1lc3NhZ2VLaW5kID1cbiAgfCBcInRleHRcIiAvLyBwbGFpbiBkaWFsb2d1ZSAoZWl0aGVyIHJvbGUpXG4gIHwgXCJnZXN0dXJlXCIgLy8gYSBzdXJmYWNlIGFjdGlvbiBzdXJmYWNlZCBhcyBhIG1lc3NhZ2UgKHVzZXIganVkZ2VkL3JldHJpZWQv4oCmKVxuICB8IFwicXVlc3Rpb25cIjsgLy8gYWdlbnQgbmVlZHMgdGhlIHVzZXIgKGFuIHVuYW5zd2VyZWQgb25lIOKGkiBcImFza2luZ1wiIHByZXNlbmNlKVxuXG5leHBvcnQgdHlwZSBNZXNzYWdlID0ge1xuICBpZDogc3RyaW5nO1xuICByb2xlOiBcInVzZXJcIiB8IFwiYWdlbnRcIjtcbiAga2luZDogTWVzc2FnZUtpbmQ7XG4gIHRleHQ6IHN0cmluZztcbiAgdHM6IG51bWJlcjtcbiAgLy8ga2luZDogXCJxdWVzdGlvblwiIOKAlCBvcHRpb25hbCBxdWljayByZXBsaWVzICh0aGUgZnVsbCBhbnN3ZXIgY2FuIGJlIGZyZWUgdGV4dClcbiAgb3B0aW9ucz86IHN0cmluZ1tdO1xuICAvLyBraW5kOiBcImdlc3R1cmVcIiDigJQgd2hhdCB0aGUgdXNlciBkaWQsIGFuZCB0byB3aGF0XG4gIGdlc3R1cmU/OiB7IGtpbmQ6IHN0cmluZzsgdGFyZ2V0SWQ/OiBzdHJpbmcgfTtcbiAgLy8gQW4gb3B0aW9uYWwgb25lLWNsaWNrIENUQSB0aGUgYWdlbnQgYXR0YWNoZXMgdG8gYSBtZXNzYWdlIOKAlCBhIFNIT1JUQ1VUIGZvciBhXG4gIC8vIGNvbnZlcnNhdGlvbmFsIGFjdCAodGhlIHVzZXIgY291bGQgaGF2ZSBqdXN0IHNhaWQgaXQpLiBDbGlja2luZyBkaXNwYXRjaGVzXG4gIC8vIGBjb21tYW5kYCAoZS5nLiB7IHR5cGU6IFwicGhhc2UuYWR2YW5jZVwiIH0pLiBDb252ZXJzYXRpb24gc3RheXMgdGhlIHByaW1hcnlcbiAgLy8gY2FwYWJpbGl0eTsgdGhpcyBpcyBzdWdhciBvbiB0b3AsIHN1cmZhY2VkIGJ5IHRoZSBhZ2VudCBhdCBpdHMgZGlzY3JldGlvbi5cbiAgYWN0aW9uPzogeyBsYWJlbDogc3RyaW5nOyBjb21tYW5kOiBDbGllbnRUb1NlcnZlciB9O1xufTtcblxuLy8gQSBib3ggYmVmb3JlIHRoZSBkYWVtb24gYXNzaWducyBpdCBhbiBpZCDigJQgZHJhd24gYnkgdGhlIHVzZXIgKFwibWFyayBhIG1pc3NlZFxuLy8gcmVnaW9uXCIpIG9yIGJ5IHRoZSBhZ2VudCBib3hpbmcgaW5jcmVtZW50YWxseS4gVGhlIGRhZW1vbiBmaWxscyBgaWRgIGFuZFxuLy8gZGVmYXVsdHMgbmFtZS90eXBlL3N0YXR1cyBvbiBlbGVtZW50LmFkZC5cbmV4cG9ydCB0eXBlIE5ld0VsZW1lbnQgPSB7XG4gIGJib3g6IEJib3g7XG4gIG5hbWU/OiBzdHJpbmc7XG4gIHR5cGU/OiBFbGVtZW50VHlwZTtcbiAgc3RhdHVzPzogRWxlbWVudFN0YXR1cztcbn07XG5cbi8vIFRoZSBzb3VyY2UgY29tcG9zaXRlIGltYWdlIHVuZGVyIHJldmlldy4gYHBhdGhgIGlzIHRoZSBvbi1kaXNrIGZpbGUgdGhlIGFnZW50XG4vLyByZWFkczsgYHNpemVgIGlzIFt3LCBoXSBpbiBweDsgYHNoYWAgaXMgdGhlIGZpcnN0LTE2IG9mIHRoZSBzaGEyNTYgKG1hdGNoZXNcbi8vIHRoZSBQeXRob24gb3JpZ2luYWwncyBgc291cmNlX3NoYTI1Nl8xNmApLlxuZXhwb3J0IHR5cGUgU291cmNlID0ge1xuICBwYXRoOiBzdHJpbmc7XG4gIHNpemU6IFtudW1iZXIsIG51bWJlcl07XG4gIHNoYTogc3RyaW5nO1xufTtcblxuLy8g4pSA4pSAIHRoZSB3aG9sZSBzdGF0ZSAoUFJPVklTSU9OQUwpIOKUgOKUgFxuZXhwb3J0IHR5cGUgTWFncGllU3RhdGUgPSB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGludGVudDogc3RyaW5nOyAvLyB3aGF0IHRoZSB1c2VyIHdhbnRzIG91dCBvZiB0aGlzIGJvYXJkIChmcmVlIHRleHQgdGhlIGFnZW50IHNldHMpXG4gIHBoYXNlOiBQaGFzZUtleTsgLy8gdGhlIGxpbmVhciBwcm9jZXNzIGN1cnNvciAoSW50YWtlIOKGkiBTbGljZSDihpIgUmVtb3ZlIOKGkiBFeHBvcnQpXG4gIHNvdXJjZTogU291cmNlIHwgbnVsbDtcbiAgZWxlbWVudHM6IEVsZW1lbnRbXTtcbiAgY29udmVyc2F0aW9uOiBNZXNzYWdlW107XG4gIGJhY2tkcm9wOiBCYWNrZHJvcDtcbiAgc3RhdHVzOiB7IGJ1c3k6IGJvb2xlYW47IHRleHQ6IHN0cmluZyB9O1xuICAvLyBUaGUgYnVpbHQgZXhwb3J0IGJ1bmRsZSAoRXhwb3J0IHBoYXNlKSwgaWYgYW55IOKAlCBzZXJ2ZWQgdmlhIC9hc3NldHMvPG5hbWU+LlxuICBidW5kbGU/OiB7IG5hbWU6IHN0cmluZzsgY291bnQ6IG51bWJlciB9O1xuICAvLyBUaGUgY3VycmVudCBzZXNzaW9uIGlkIChydW50aW1lOyB0aGUgZGFlbW9uIHNldHMgaXQgYXQgc3RhcnQsIE5PVCBwZXJzaXN0ZWQtXG4gIC8vIG1lYW5pbmdmdWwgc2luY2UgcmVzdG9yZSBtaW50cyBhIG5ldyBvbmUpIOKAlCBzaG93biBpbiBFeHBvcnQncyByZW9wZW4gaGludC5cbiAgc2Vzc2lvbklkPzogc3RyaW5nO1xufTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRlZmF1bHRTdGF0ZSh0aXRsZTogc3RyaW5nKTogTWFncGllU3RhdGUge1xuICByZXR1cm4ge1xuICAgIHRpdGxlLFxuICAgIGludGVudDogXCJcIixcbiAgICBwaGFzZTogXCJpbnRha2VcIixcbiAgICBzb3VyY2U6IG51bGwsXG4gICAgZWxlbWVudHM6IFtdLFxuICAgIGNvbnZlcnNhdGlvbjogW10sXG4gICAgYmFja2Ryb3A6IFwidHJhbnNwYXJlbnRcIixcbiAgICBzdGF0dXM6IHsgYnVzeTogZmFsc2UsIHRleHQ6IFwiXCIgfSxcbiAgfTtcbn1cblxuLy8g4pSA4pSAIFNlcnZlciDihpIgYnJvd3NlciAoV2ViU29ja2V0KS4gVGhlIGJyb3dzZXIgaGFuZGxlcyBleGFjdGx5IHRoZXNlLiDilIDilIBcbmV4cG9ydCB0eXBlIFNlcnZlclRvQ2xpZW50ID1cbiAgfCB7IHR5cGU6IFwic3RhdGVcIjsgc3RhdGU6IE1hZ3BpZVN0YXRlIH1cbiAgfCB7IHR5cGU6IFwibWVzc2FnZVwiOyB0ZXh0OiBzdHJpbmcgfVxuICAvLyBhZ2VudCBwcmVzZW5jZSDigJQgaXMgYXQgbGVhc3Qgb25lIGFnZW50IHRhaWxpbmcgL2V2ZW50cyAod2F0Y2hpbmcgdGhlIGJvYXJkKT9cbiAgLy8gcHVzaGVkIG9uIGNoYW5nZSArIG9uIGJyb3dzZXIgY29ubmVjdDsgcnVudGltZS1vbmx5LCBuZXZlciBwZXJzaXN0ZWQgaW4gc3RhdGUuXG4gIHwgeyB0eXBlOiBcInByZXNlbmNlXCI7IGFnZW50OiBib29sZWFuIH1cbiAgfCB7IHR5cGU6IFwic3VibWl0XCIgfVxuICB8IHsgdHlwZTogXCJjYW5jZWxcIiB9O1xuXG4vLyDilIDilIAgQnJvd3NlciDihpIgc2VydmVyIChXZWJTb2NrZXQpLiBUaGUgY2xpZW50IHNlbmRzIGV4YWN0bHkgdGhlc2UuIOKUgOKUgFxuLy8gRWFjaCBlaXRoZXIgbXV0YXRlcyBzdGF0ZSAocmUtYnJvYWRjYXN0KSBhbmQvb3IgZW1pdHMgYW4gU1NFIGV2ZW50IHRoZSBhZ2VudFxuLy8gcmVhY3RzIHRvLlxuZXhwb3J0IHR5cGUgQ2xpZW50VG9TZXJ2ZXIgPVxuICB8IHsgdHlwZTogXCJzYXlcIjsgdGV4dDogc3RyaW5nIH0gLy8gdXNlciBwb3N0cyBhIG1lc3NhZ2UgLyBpbnN0cnVjdGlvblxuICB8IHsgdHlwZTogXCJzb3VyY2UuaW1wb3J0XCI7IG5hbWU6IHN0cmluZzsgZGF0YVVybDogc3RyaW5nIH0gLy8gdXNlciBkcm9wcGVkIGEgY29tcG9zaXRlIOKGkiBkYWVtb24gbWF0ZXJpYWxpemVzIGl0XG4gIHwgeyB0eXBlOiBcImVsZW1lbnQuYWRkXCI7IGVsZW1lbnQ6IE5ld0VsZW1lbnQgfSAvLyB1c2VyIGRyZXcgYSBtaXNzZWQgcmVnaW9uIG9uIHRoZSBjYW52YXNcbiAgfCB7IHR5cGU6IFwiZWxlbWVudC51cGRhdGVcIjsgaWQ6IHN0cmluZzsgcGF0Y2g6IFBhcnRpYWw8RWxlbWVudD4gfSAvLyBtb3ZlIC8gcmVzaXplIC8gcmVuYW1lIC8gcmV0eXBlXG4gIHwgeyB0eXBlOiBcImVsZW1lbnQucmVtb3ZlXCI7IGlkOiBzdHJpbmcgfSAvLyBoYXJkLWRlbGV0ZSBhIGJveCAodXN1YWxseSBhIHVzZXItZHJhd24gb25lKVxuICB8IHsgdHlwZTogXCJlbGVtZW50Lmp1ZGdlXCI7IGlkOiBzdHJpbmc7IHN0YXR1czogRWxlbWVudFN0YXR1cyB9IC8vIHNvZnQgY29uZmlybS9kcm9wIGEgZGlzY292ZXJlZCBlbGVtZW50XG4gIHwgeyB0eXBlOiBcImV4dHJhY3RcIjsgaWRzPzogc3RyaW5nW10gfSAvLyBjdXQgc2xpY2VzIGZvciBhbGwgY29uZmlybWVkIGVsZW1lbnRzLCBvciBhIHN1YnNldCAocmUtY3V0KVxuICB8IHsgdHlwZTogXCJlbGVtZW50LmZsYWdcIjsgaWQ6IHN0cmluZzsgZmxhZ2dlZDogYm9vbGVhbiB9IC8vIGZsYWcvdW5mbGFnIGZvciByZS1ydW4gKHJlLXNsaWNlIG9yIHJlLXJlbW92ZSlcbiAgfCB7IHR5cGU6IFwidmVyc2lvbi5jaG9vc2VcIjsgaWQ6IHN0cmluZzsgdmVyc2lvbklkOiBzdHJpbmcgfSAvLyB1c2VyIHBpY2tlZCBhIHZlcnNpb24g4oaSIGl0IGJlY29tZXMgY2hvc2VuIChhbWJpZW50KVxuICB8IHsgdHlwZTogXCJyZW1vdmVCZ1wiOyBpZHM/OiBzdHJpbmdbXSB9IC8vIHJlbW92ZSBiYWNrZ3JvdW5kcyBmb3IgdGhlc2UgYWxwaGEtZWxpZ2libGUgZWxlbWVudHMgKGFic2VudCDihpIgYWxsIGVsaWdpYmxlKVxuICB8IHsgdHlwZTogXCJyZXRyeVJlbW92YWxcIjsgaWRzOiBzdHJpbmdbXSB9IC8vIFwidHJ5IGEgZGlmZmVyZW50IHJlbW92YWxcIiDigJQgYWdlbnQgcGlja3MgYW4gVU5VU0VEIG1vZGVsOyBwYXlsb2FkIGlzIGlkcyBvbmx5XG4gIHwgeyB0eXBlOiBcImJhY2tkcm9wLnNldFwiOyBiYWNrZHJvcDogQmFja2Ryb3AgfSAvLyBhbWJpZW50IHByZXZpZXcgYmFja2Ryb3BcbiAgfCB7IHR5cGU6IFwicGhhc2UuYWR2YW5jZVwiIH0gLy8gc2VhbCB0aGUgYWN0aXZlIHBoYXNlLCBtb3ZlIHRoZSBjdXJzb3IgdG8gdGhlIG5leHQgKGltcGVyYXRpdmUgaGFuZC1vZmYpXG4gIHwgeyB0eXBlOiBcInBoYXNlLnNldFwiOyBwaGFzZTogUGhhc2VLZXkgfSAvLyBiYWNrLW5hdiAvIGp1bXAgdG8gYSBwaGFzZSAoYW1iaWVudClcbiAgfCB7IHR5cGU6IFwiZXhwb3J0XCI7IGlkcz86IHN0cmluZ1tdIH0gLy8gYnVpbGQgdGhlIGRvd25sb2FkYWJsZSBhc3NldCBidW5kbGUgKGNob3NlbiB2ZXJzaW9ucyBvZiB0aGVzZSAvIGFsbCBub24tZHJvcHBlZClcbiAgfCB7IHR5cGU6IFwic3VibWl0XCIgfVxuICB8IHsgdHlwZTogXCJjYW5jZWxcIiB9O1xuXG4vLyDilIDilIAgQWdlbnQg4oaSIHNlcnZlciAoUE9TVCAvY21kKS4gVGhlIGFnZW50IGRyaXZlcyB0aGUgZGFlbW9uIHdpdGggZXhhY3RseSB0aGVzZS4g4pSA4pSAXG5leHBvcnQgdHlwZSBBZ2VudENvbW1hbmQgPVxuICB8IHsgdHlwZTogXCJpbml0XCI7IHRpdGxlPzogc3RyaW5nOyBpbnRlbnQ/OiBzdHJpbmcgfVxuICB8IHtcbiAgICAgIHR5cGU6IFwic2F5XCI7XG4gICAgICB0ZXh0OiBzdHJpbmc7XG4gICAgICBhY3Rpb24/OiB7IGxhYmVsOiBzdHJpbmc7IGNvbW1hbmQ6IENsaWVudFRvU2VydmVyIH07XG4gICAgfSAvLyBwb3N0IGFnZW50IGRpYWxvZ3VlIChraW5kOlwidGV4dFwiKTsgb3B0aW9uYWwgaW5saW5lIENUQSBzaG9ydGN1dFxuICB8IHsgdHlwZTogXCJhc2tcIjsgdGV4dDogc3RyaW5nOyBvcHRpb25zPzogc3RyaW5nW10gfSAvLyBwb3N0IGFuIGluLXRocmVhZCBxdWVzdGlvblxuICB8IHsgdHlwZTogXCJzb3VyY2Uuc2V0XCI7IHBhdGg6IHN0cmluZzsgc2l6ZTogW251bWJlciwgbnVtYmVyXTsgc2hhOiBzdHJpbmcgfSAvLyB0aGUgY29tcG9zaXRlIHVuZGVyIHJldmlld1xuICB8IHsgdHlwZTogXCJlbGVtZW50cy5zZXRcIjsgZWxlbWVudHM6IEVsZW1lbnRbXSB9IC8vIHBvc3QgdGhlIGRpc2NvdmVyZWQgYnJlYWtkb3duXG4gIHwgeyB0eXBlOiBcImVsZW1lbnQuYWRkXCI7IGVsZW1lbnQ6IE5ld0VsZW1lbnQgfSAvLyBhZ2VudCBib3hlcyBhIHJlZ2lvbiBpbmNyZW1lbnRhbGx5XG4gIHwgeyB0eXBlOiBcImVsZW1lbnQudXBkYXRlXCI7IGlkOiBzdHJpbmc7IHBhdGNoOiBQYXJ0aWFsPEVsZW1lbnQ+IH0gLy8gbW92ZS9yZXNpemUvcmVuYW1lL3JldHlwZSAodmVyc2lvbnMgYXBwZW5kIHZpYSBlbGVtZW50LmFkZFZlcnNpb24pXG4gIHwgeyB0eXBlOiBcImVsZW1lbnQucmVtb3ZlXCI7IGlkOiBzdHJpbmcgfSAvLyBhZ2VudCByZXRyYWN0cyBhIGJveFxuICB8IHsgdHlwZTogXCJlbGVtZW50LmFkZFZlcnNpb25cIjsgaWQ6IHN0cmluZzsgdmVyc2lvbjogRWxlbWVudFZlcnNpb247IGNob29zZT86IGJvb2xlYW4gfSAvLyBhZ2VudCBhcHBlbmRzIGEgcHJvZHVjZWQgdmVyc2lvblxuICB8IHsgdHlwZTogXCJwaGFzZS5zZXRcIjsgcGhhc2U6IFBoYXNlS2V5IH0gLy8gYWdlbnQgYWR2YW5jZXMvbW92ZXMgdGhlIGN1cnNvciBvbiB0aGUgdXNlcidzIGNvbnZlcnNhdGlvbmFsIHJlcXVlc3RcbiAgfCB7IHR5cGU6IFwiYnVuZGxlLnNldFwiOyBuYW1lOiBzdHJpbmc7IGNvdW50OiBudW1iZXIgfSAvLyBhZ2VudCBwb3N0cyB0aGUgYnVpbHQgZXhwb3J0IGJ1bmRsZSAoc2VydmVkIHZpYSAvYXNzZXRzLzxuYW1lPilcbiAgfCB7IHR5cGU6IFwic3RhdHVzXCI7IGJ1c3k6IGJvb2xlYW47IHRleHQ/OiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJjbG9zZVwiIH07XG5cbi8vIFRoZSBhZ2VudCBldmVudCBzZXQgKHNlcnZlciDihpIgYWdlbnQgU1NFKSDigJQgSU1QRVJBVElWRVMgT05MWTogdGhlIG1vdmVzIHdoZXJlXG4vLyB0aGUgdXNlciAqaGFuZHMgd29yayB0byB0aGUgYWdlbnQqLCBwbHVzIGxpZmVjeWNsZS4gQW1iaWVudCBlZGl0aW5nIG9mIHRoZVxuLy8gYnJlYWtkb3duIGlzIGRlbGliZXJhdGVseSBOT1QgaGVyZSDigJQgYm94IG1vdmUvcmVzaXplL3JlbmFtZS9yZXR5cGVcbi8vIChlbGVtZW50LnVwZGF0ZSksIGRyYXcgKGVsZW1lbnQuYWRkKSwgZGVsZXRlIChlbGVtZW50LnJlbW92ZSksIGNvbmZpcm0vZHJvcFxuLy8gKGVsZW1lbnQuanVkZ2UpLCByZS1ydW4gZmxhZyAoZWxlbWVudC5mbGFnKSwgdmVyc2lvbiBwaWNrICh2ZXJzaW9uLmNob29zZSksIGFuZFxuLy8gYmFja2Ryb3AgYXJlIGFsbCByZWFjaGFibGUgZnJvbSAvc3RhdGUsIHdoaWNoIHRoZSBhZ2VudCByZWFkcyBhdCB0aGUgbW9tZW50IGFuXG4vLyBpbXBlcmF0aXZlIGZpcmVzLiBQdXNoaW5nIGVhY2ggZWRpdCB3b3VsZCBqdXN0IG5hcnJhdGUgdGhlIHVzZXIncyBidXN5IHdvcmsuXG4vLyBUaGUgaW1wZXJhdGl2ZXM6IGBzYXlgLCBgc291cmNlLmFkZGVkYCAo4oaSIGRpc2NvdmVyKSwgYGV4dHJhY3RgICjihpIgY3V0IHRoZVxuLy8gY3VycmVudCBib3hlcyksIGByZW1vdmVCZ2AgKOKGkiByZW1vdmUgYmFja2dyb3VuZHMsIGFnZW50IHBpY2tzIHRoZSBtb2RlbCksXG4vLyBgcmV0cnlSZW1vdmFsYCAo4oaSIHRyeSBhIGRpZmZlcmVudCByZW1vdmFsLCBhZ2VudCBwaWNrcyBhbiB1bnVzZWQgbW9kZWwpLFxuLy8gYHBoYXNlLmFkdmFuY2VgICjihpIgdXNlciBzZWFsZWQgYSBwaGFzZTsgYSBoYW5kLW9mZiB0byB0aGUgbmV4dCBsZWcpLFxuLy8gYHBoYXNlLnNldGAgKOKGkiB1c2VyIHN0ZXBwZWQgQkFDSyB0byBhIHBoYXNlIOKAlCBub3QgYW4gYWN0aW9uIHRvIHRha2UsIGJ1dFxuLy8gY29udGV4dCBmb3Igd2hhdCdzIGNvbWluZywgZS5nLiByZS1jdXRzKSwgYHN1Ym1pdGAsICsgbGlmZWN5Y2xlLiBBIHBoYXNlIHN3aXRjaFxuLy8gaXMgYSBkZWxpYmVyYXRlIHJlbG9jYXRpb24sIE5PVCBhbWJpZW50IGVkaXRpbmcg4oCUIHNvIGJvdGggZGlyZWN0aW9ucyBhcmUgcHVzaGVkLlxuZXhwb3J0IGNvbnN0IEFHRU5UX0VWRU5UX1RZUEVTID0gT2JqZWN0LmZyZWV6ZShbXG4gIFwicmVhZHlcIixcbiAgXCJjb25uZWN0ZWRcIixcbiAgXCJkaXNjb25uZWN0ZWRcIixcbiAgXCJzYXlcIixcbiAgXCJzb3VyY2UuYWRkZWRcIiwgLy8gdXNlciBkcm9wcGVkIGEgY29tcG9zaXRlIOKAlCB0aGUgYWdlbnQgcnVucyBkaXNjb3ZlciBvbiBpdFxuICBcImV4dHJhY3RcIiwgLy8gdXNlciBhc2tlZCB0byAocmUtKWN1dCDigJQgdGhlIGFnZW50IHJlYWRzIHRoZSBib3hlcyBmcm9tIC9zdGF0ZVxuICBcInJlbW92ZUJnXCIsIC8vIHVzZXIgYXNrZWQgdG8gcmVtb3ZlIGJhY2tncm91bmRzIOKAlCB0aGUgYWdlbnQgcGlja3MgdGhlIG1vZGVsXG4gIFwicmV0cnlSZW1vdmFsXCIsIC8vIHVzZXIgYXNrZWQgdG8gdHJ5IGEgZGlmZmVyZW50IHJlbW92YWwg4oCUIHRoZSBhZ2VudCBwaWNrcyBhbiBVTlVTRUQgbW9kZWxcbiAgXCJwaGFzZS5hZHZhbmNlXCIsIC8vIHVzZXIgc2VhbGVkIHRoZSBhY3RpdmUgcGhhc2Ug4oCUIGEgaGFuZC1vZmYgdG8gdGhlIG5leHQgbGVnIG9mIHdvcmtcbiAgXCJwaGFzZS5zZXRcIiwgLy8gdXNlciBzdGVwcGVkIEJBQ0sgdG8gYSBwaGFzZSDigJQgY29udGV4dCAocmUtY3V0cyBsaWtlbHkpLCBubyBhY3Rpb24gcmVxdWlyZWRcbiAgXCJleHBvcnRcIiwgLy8gdXNlciBhc2tlZCB0byBidWlsZCB0aGUgZG93bmxvYWRhYmxlIGFzc2V0IGJ1bmRsZSDigJQgdGhlIGFnZW50IHppcHMgaXRcbiAgXCJzdWJtaXRcIixcbiAgXCJjbG9zZWRcIixcbl0gYXMgY29uc3QpO1xuZXhwb3J0IHR5cGUgQWdlbnRFdmVudFR5cGUgPSAodHlwZW9mIEFHRU5UX0VWRU5UX1RZUEVTKVtudW1iZXJdO1xuXG4vLyBUeXBlZCBwYXlsb2FkcyBmb3IgdGhlIGV2ZW50cyB0aGF0IGNhcnJ5IGRhdGEuXG5leHBvcnQgdHlwZSBBZ2VudEV2ZW50UGF5bG9hZCA9IHtcbiAgc2F5OiB7IHRleHQ6IHN0cmluZyB9O1xuICBcInNvdXJjZS5hZGRlZFwiOiB7IHBhdGg6IHN0cmluZzsgc2l6ZTogW251bWJlciwgbnVtYmVyXTsgc2hhOiBzdHJpbmcgfTtcbiAgZXh0cmFjdDogeyBpZHM/OiBzdHJpbmdbXSB9OyAvLyB3aGljaCBlbGVtZW50cyB0byAocmUtKWN1dDsgYWJzZW50IOKGkiBhbGwgY29uZmlybWVkXG4gIHJlbW92ZUJnOiB7IGlkcz86IHN0cmluZ1tdIH07IC8vIHdoaWNoIGVsZW1lbnRzIHRvIHJlbW92ZSBiZyBmb3I7IGFic2VudCDihpIgYWxsIGVsaWdpYmxlXG4gIHJldHJ5UmVtb3ZhbDogeyBpZHM6IHN0cmluZ1tdIH07IC8vIHdoaWNoIChmbGFnZ2VkKSBlbGVtZW50cyB0byByZS1yZW1vdmU7IG1vZGVsIGlzIHRoZSBhZ2VudCdzIGNhbGxcbiAgXCJwaGFzZS5hZHZhbmNlXCI6IHsgcGhhc2U6IFBoYXNlS2V5IH07IC8vIHRoZSBORVcgcGhhc2UgdGhlIHVzZXIgYWR2YW5jZWQgdG9cbiAgXCJwaGFzZS5zZXRcIjogeyBwaGFzZTogUGhhc2VLZXkgfTsgLy8gdGhlIHBoYXNlIHRoZSB1c2VyIHN0ZXBwZWQgYmFjayB0b1xuICBleHBvcnQ6IHsgaWRzPzogc3RyaW5nW10gfTsgLy8gd2hpY2ggZWxlbWVudHMgdG8gYnVuZGxlIChhYnNlbnQg4oaSIGFsbCBub24tZHJvcHBlZClcbn07XG4iLAogICAgIi8vIHNyYy9tYWdwaWUvYmFja2VuZC9wZXJzaXN0LnNlcnZlci50c1xuLy8gU2VydmVyL0NMSS1vbmx5IHNuYXBzaG90IHBlcnNpc3RlbmNlIGZvciB0aGUgbWFncGllIGRhZW1vbi4gU25hcHNob3RzIGxpdmVcbi8vIHVuZGVyICRNQUdQSUVfSE9NRS9zbmFwc2hvdHMvPHNlc3Npb25JZD4uanNvbiAoZGVmYXVsdCB+Ly5tYWdwaWUpIHNvIGEgc2Vzc2lvblxuLy8gcmVzdW1lcyBhY3Jvc3MgcmVzdGFydHMgKGNsaS50cyBvcGVuIC0tcmVzdG9yZSA8aWQ+KS4gRG8gTk9UIGltcG9ydCBmcm9tXG4vLyBicm93c2VyIGNvZGUg4oCUIHRoaXMgdXNlcyBub2RlOmZzICsgbm9kZTpvcy5cblxuaW1wb3J0IHsgbWtkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHtcbiAgZGVmYXVsdFN0YXRlLFxuICB0eXBlIE1hZ3BpZVN0YXRlLFxufSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21hZ3BpZS9zaGFyZWQvdHlwZXNcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIG1hZ3BpZUhvbWUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHByb2Nlc3MuZW52Lk1BR1BJRV9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5tYWdwaWVcIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzbmFwc2hvdHNEaXIoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4obWFncGllSG9tZSgpLCBcInNuYXBzaG90c1wiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNuYXBzaG90UGF0aChzZXNzaW9uSWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKHNuYXBzaG90c0RpcigpLCBgJHtzZXNzaW9uSWR9Lmpzb25gKTtcbn1cblxuLy8gUGVyc2lzdCB0aGUgY2Fub25pY2FsIHN0YXRlIChiZXN0LWVmZm9ydCDigJQgcGVyc2lzdGVuY2UgbXVzdCBuZXZlciBjcmFzaCB0aGVcbi8vIGRhZW1vbikuIENhbGxlZCBkZWJvdW5jZWQgKH4xcykgb24gY2hhbmdlIGFuZCBvbmNlIG9uIGNsb3NlLlxuZXhwb3J0IGZ1bmN0aW9uIHNhdmVTbmFwc2hvdChzZXNzaW9uSWQ6IHN0cmluZywgc3RhdGU6IE1hZ3BpZVN0YXRlKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKHNuYXBzaG90c0RpcigpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKHNuYXBzaG90UGF0aChzZXNzaW9uSWQpLCBKU09OLnN0cmluZ2lmeShzdGF0ZSkpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBwZXJzaXN0ZW5jZSBpcyBiZXN0LWVmZm9ydCAqL1xuICB9XG59XG5cbi8vIExvYWQgYSBzbmFwc2hvdCBieSBzZXNzaW9uIGlkIE9SIGFuIGV4cGxpY2l0IHBhdGgsIG1lcmdlZCBvdmVyIGRlZmF1bHRzIHNvIGFuXG4vLyBvbGRlciBzbmFwc2hvdCBnYWlucyBhbnkgbmV3IGZpZWxkcy4gUmV0dXJucyBudWxsIGlmIGl0IGNhbid0IGJlIHJlYWQuXG5leHBvcnQgZnVuY3Rpb24gbG9hZFNuYXBzaG90KGlkT3JQYXRoOiBzdHJpbmcsIHRpdGxlOiBzdHJpbmcpOiBNYWdwaWVTdGF0ZSB8IG51bGwge1xuICBjb25zdCBwYXRoID0gaWRPclBhdGguZW5kc1dpdGgoXCIuanNvblwiKSA/IGlkT3JQYXRoIDogc25hcHNob3RQYXRoKGlkT3JQYXRoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBzbmFwID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSBhcyBQYXJ0aWFsPE1hZ3BpZVN0YXRlPjtcbiAgICBjb25zdCBtZXJnZWQgPSB7IC4uLmRlZmF1bHRTdGF0ZSh0aXRsZSksIC4uLnNuYXAgfSBhcyBNYWdwaWVTdGF0ZTtcbiAgICAvLyBOb3JtYWxpemUgdGhlIHBoYXNlIGN1cnNvciBmb3Igc25hcHNob3RzIHRoYXQgcHJlZGF0ZSB0aGUgcGhhc2Ugc3BpbmUgKG9yXG4gICAgLy8gd2VyZSBzYXZlZCBhdCBpbnRha2Ugd2l0aCBlbGVtZW50cyBhbHJlYWR5IHByZXNlbnQpOiBsYW5kIHRoZW0gaW4gU2xpY2Ugc29cbiAgICAvLyB0aGUgYm9hcmQgcmVuZGVycyBpbnN0ZWFkIG9mIHRoZSBpbnRha2Uvc2Nhbm5pbmcgdmlldy5cbiAgICBpZiAobWVyZ2VkLnBoYXNlID09PSBcImludGFrZVwiICYmIG1lcmdlZC5lbGVtZW50cy5sZW5ndGggPiAwKSBtZXJnZWQucGhhc2UgPSBcInNsaWNlXCI7XG4gICAgcmV0dXJuIG1lcmdlZDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cbiIsCiAgICAiLy8gc3JjL21hZ3BpZS9iYWNrZW5kL3JlZHVjZS50c1xuLy8gUHVyZSwgaW4tcGxhY2UgbXV0YXRvcnMgb3ZlciBNYWdwaWVTdGF0ZSArIHRoZSBsZWFuIHByb2plY3Rpb24uIFRoZSBkYWVtb25cbi8vIChzZXJ2ZXIudHMpIG9yY2hlc3RyYXRlcyB0aGVzZSAoaXQgb3ducyBpZHMsIGJyb2FkY2FzdCwgU1NFKTsgdGhlc2UgZnVuY3Rpb25zXG4vLyBqdXN0IG11dGF0ZSBjYW5vbmljYWwgc3RhdGUgYW5kIHJlcG9ydCB3aGV0aGVyIGFueXRoaW5nIGNoYW5nZWQsIHNvIHRoZXkncmVcbi8vIHVuaXQtdGVzdGFibGUgd2l0aCBubyBzdWJwcm9jZXNzLiBLZWVwIHRoZW0gVEhJTiDigJQgdGhlIG1hZ3BpZS1zcGVjaWZpYyByZXZpZXdcbi8vIG1hY2hpbmVyeSAoanVkZ21lbnQsIGN1dG91dHMpIGlzIG1vY2tlZCBvdXQgZm9yIG5vdzsgd2lkZW4gdGhlc2UgYXMgaXQgbGFuZHMuXG5cbmltcG9ydCB7XG4gIHR5cGUgQmFja2Ryb3AsXG4gIHR5cGUgRWxlbWVudCxcbiAgdHlwZSBFbGVtZW50U3RhdHVzLFxuICB0eXBlIEVsZW1lbnRWZXJzaW9uLFxuICB0eXBlIE1hZ3BpZVN0YXRlLFxuICB0eXBlIE1lc3NhZ2UsXG4gIHR5cGUgTmV3RWxlbWVudCxcbiAgUEhBU0VTLFxuICB0eXBlIFBoYXNlS2V5LFxuICB0eXBlIFNvdXJjZSxcbn0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9tYWdwaWUvc2hhcmVkL3R5cGVzXCI7XG5cbi8vIOKUgOKUgCBpZCBoZWxwZXJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gcmFuZEhleChieXRlczogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgYnVmID0gbmV3IFVpbnQ4QXJyYXkoYnl0ZXMpO1xuICBjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKGJ1Zik7XG4gIHJldHVybiBBcnJheS5mcm9tKGJ1ZiwgKGIpID0+IGIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsIFwiMFwiKSkuam9pbihcIlwiKTtcbn1cbmV4cG9ydCBmdW5jdGlvbiBuZXdJZChwcmVmaXg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtwcmVmaXh9LSR7cmFuZEhleCg0KX1gO1xufVxuXG4vLyDilIDilIAgbXV0YXRvcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCBmdW5jdGlvbiBwdXNoTWVzc2FnZShcbiAgczogTWFncGllU3RhdGUsXG4gIG06IE9taXQ8TWVzc2FnZSwgXCJpZFwiIHwgXCJ0c1wiPiAmIHsgaWQ/OiBzdHJpbmcgfSxcbik6IE1lc3NhZ2Uge1xuICBjb25zdCBtc2c6IE1lc3NhZ2UgPSB7IGlkOiBtLmlkID8/IG5ld0lkKFwibVwiKSwgdHM6IERhdGUubm93KCksIC4uLm0gfSBhcyBNZXNzYWdlO1xuICBzLmNvbnZlcnNhdGlvbi5wdXNoKG1zZyk7XG4gIHJldHVybiBtc2c7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRTdGF0dXMoczogTWFncGllU3RhdGUsIGJ1c3k6IGJvb2xlYW4sIHRleHQgPSBcIlwiKTogdm9pZCB7XG4gIHMuc3RhdHVzID0geyBidXN5LCB0ZXh0IH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRJbnRlbnQoczogTWFncGllU3RhdGUsIGludGVudDogc3RyaW5nKTogdm9pZCB7XG4gIHMuaW50ZW50ID0gaW50ZW50O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0U291cmNlKHM6IE1hZ3BpZVN0YXRlLCBzb3VyY2U6IFNvdXJjZSk6IHZvaWQge1xuICBzLnNvdXJjZSA9IHNvdXJjZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldEVsZW1lbnRzKHM6IE1hZ3BpZVN0YXRlLCBlbGVtZW50czogRWxlbWVudFtdKTogdm9pZCB7XG4gIC8vIFRydXN0IHRoZSBhZ2VudCdzIGRpc2NvdmVyZWQgYnJlYWtkb3duIHdob2xlc2FsZTsgZGVmYXVsdCBhbnkgbWlzc2luZ1xuICAvLyBzdGF0dXMgdG8gXCJwcm9wb3NlZFwiIHNvIHRoZSBzdXJmYWNlIGFsd2F5cyBoYXMgYSBqdWRnZWFibGUgZWxlbWVudCwgYW5kXG4gIC8vIChkZWZlbnNpdmVseSkgbWludCBhbiBpZCBmb3IgYW55IGVsZW1lbnQgcG9zdGVkIHdpdGhvdXQgb25lIOKAlCBkaXNjb3ZlclxuICAvLyBhc3NpZ25zIGlkcywgYnV0IGEgaGFuZC1yb2xsZWQgYGVsZW1lbnRzLnNldGAgYm9keSBtaWdodCBub3QuXG4gIHMuZWxlbWVudHMgPSBlbGVtZW50cy5tYXAoKGUpID0+ICh7XG4gICAgLi4uZSxcbiAgICBpZDogZS5pZCB8fCBuZXdJZChcImVcIiksXG4gICAgc3RhdHVzOiBlLnN0YXR1cyA/PyBcInByb3Bvc2VkXCIsXG4gIH0pKTtcbn1cblxuLy8gRGVmYXVsdCBuYW1lIGZvciBhbiB1bm5hbWVkIGRyYXduIHJlZ2lvbjogcmVnaW9uXzxuPiwgd2hlcmUgbiBpcyBvbmUgcGFzdCB0aGVcbi8vIGNvdW50IG9mIGV4aXN0aW5nIHJlZ2lvbl9cXGQrIG5hbWVzIChzbyBhIGRlbGV0ZS10aGVuLWRyYXcgZG9lc24ndCBjb2xsaWRlIHdpdGhcbi8vIGEgbGl2ZSBvbmUg4oCUIGl0IG51bWJlcnMgb2ZmIHRoZSBjdXJyZW50IHBvcHVsYXRpb24sIHRoZSBjaGVhcCBob3VzZSBoZXVyaXN0aWMpLlxuY29uc3QgUkVHSU9OX1JFID0gL15yZWdpb25fXFxkKyQvO1xuZnVuY3Rpb24gbmV4dFJlZ2lvbk5hbWUoczogTWFncGllU3RhdGUpOiBzdHJpbmcge1xuICBjb25zdCBuID0gcy5lbGVtZW50cy5maWx0ZXIoKGUpID0+IFJFR0lPTl9SRS50ZXN0KGUubmFtZSkpLmxlbmd0aCArIDE7XG4gIHJldHVybiBgcmVnaW9uXyR7bn1gO1xufVxuXG4vLyBBZGQgYSB1c2VyLWRyYXduIChvciBhZ2VudC1ib3hlZCkgcmVnaW9uOiBtaW50IGFuIGlkLCBkZWZhdWx0IG5hbWUvdHlwZS9zdGF0dXMuXG4vLyBSZXR1cm5zIHRoZSBtYXRlcmlhbGl6ZWQgRWxlbWVudCAodGhlIGRhZW1vbiBlbWl0cyBpdCBvbiB0aGUgU1NFL2Jyb2FkY2FzdCkuXG5leHBvcnQgZnVuY3Rpb24gYWRkRWxlbWVudChzOiBNYWdwaWVTdGF0ZSwgZHJhZnQ6IE5ld0VsZW1lbnQpOiBFbGVtZW50IHtcbiAgY29uc3QgZWw6IEVsZW1lbnQgPSB7XG4gICAgaWQ6IG5ld0lkKFwiZVwiKSxcbiAgICBuYW1lOiBkcmFmdC5uYW1lIHx8IG5leHRSZWdpb25OYW1lKHMpLFxuICAgIHR5cGU6IGRyYWZ0LnR5cGUgPz8gXCJvdGhlclwiLFxuICAgIGJib3g6IGRyYWZ0LmJib3gsXG4gICAgc3RhdHVzOiBkcmFmdC5zdGF0dXMgPz8gXCJjb25maXJtZWRcIixcbiAgfTtcbiAgcy5lbGVtZW50cy5wdXNoKGVsKTtcbiAgcmV0dXJuIGVsO1xufVxuXG4vLyBIYXJkLWRlbGV0ZSBhbiBlbGVtZW50IGJ5IGlkIChhIHVzZXIgcmV0cmFjdGluZyBhIGRyYXduIGJveCkuIFJldHVybnMgd2hldGhlclxuLy8gaXQgZXhpc3RlZC5cbmV4cG9ydCBmdW5jdGlvbiByZW1vdmVFbGVtZW50KHM6IE1hZ3BpZVN0YXRlLCBpZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGkgPSBzLmVsZW1lbnRzLmZpbmRJbmRleCgoZSkgPT4gZS5pZCA9PT0gaWQpO1xuICBpZiAoaSA8IDApIHJldHVybiBmYWxzZTtcbiAgcy5lbGVtZW50cy5zcGxpY2UoaSwgMSk7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyBQYXJ0aWFsLW1lcmdlIGFuIGVsZW1lbnQgKHRoZSBhZ2VudCBwb3N0aW5nIG5hbWUvdHlwZS9iYm94L3N0YXR1cyBlZGl0cyBsYW5kc1xuLy8gaGVyZSkuIE5ldmVyIGxldHMgYGlkYCBiZSBvdmVyd3JpdHRlbi4gUmV0dXJucyB0cnVlIGlmIHRoZSBlbGVtZW50IGV4aXN0ZWQuXG4vLyBWZXJzaW9uIHJlc3VsdHMgZG8gTk9UIGZsb3cgdGhyb3VnaCBoZXJlIOKAlCB0aGV5IGFwcGVuZCB2aWEgYWRkVmVyc2lvbiAoYSBsaXN0XG4vLyBvcCwgbm90IGEgZmllbGQgbWVyZ2UpLlxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZUVsZW1lbnQoczogTWFncGllU3RhdGUsIGlkOiBzdHJpbmcsIHBhdGNoOiBQYXJ0aWFsPEVsZW1lbnQ+KTogYm9vbGVhbiB7XG4gIGNvbnN0IGVsID0gcy5lbGVtZW50cy5maW5kKChlKSA9PiBlLmlkID09PSBpZCk7XG4gIGlmICghZWwpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgeyBpZDogX2Ryb3AsIC4uLnJlc3QgfSA9IHBhdGNoO1xuICBPYmplY3QuYXNzaWduKGVsLCByZXN0KTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmNvbnN0IEVMRU1FTlRfU1RBVFVTRVM6IHJlYWRvbmx5IEVsZW1lbnRTdGF0dXNbXSA9IFtcInByb3Bvc2VkXCIsIFwiY29uZmlybWVkXCIsIFwiZHJvcHBlZFwiXTtcblxuZXhwb3J0IGZ1bmN0aW9uIGp1ZGdlRWxlbWVudChzOiBNYWdwaWVTdGF0ZSwgaWQ6IHN0cmluZywgc3RhdHVzOiBFbGVtZW50U3RhdHVzKTogYm9vbGVhbiB7XG4gIGlmICghRUxFTUVOVF9TVEFUVVNFUy5pbmNsdWRlcyhzdGF0dXMpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGVsID0gcy5lbGVtZW50cy5maW5kKChlKSA9PiBlLmlkID09PSBpZCk7XG4gIGlmICghZWwgfHwgZWwuc3RhdHVzID09PSBzdGF0dXMpIHJldHVybiBmYWxzZTtcbiAgZWwuc3RhdHVzID0gc3RhdHVzO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8gRmxhZyAob3IgdW5mbGFnKSBhbiBlbGVtZW50IGZvciBhIHJlLXJ1biDigJQgdGhlIHNvbGUgcmV2aWV3IHNpZ25hbC4gQXBwcm92YWwgaXNcbi8vIHRoZSBhYnNlbmNlIG9mIGEgZmxhZzsgZGlzY2FyZGluZyBpcyBzdGF0dXM6XCJkcm9wcGVkXCIuIFJldHVybnMgd2hldGhlciB0aGUgZmxhZ1xuLy8gYWN0dWFsbHkgY2hhbmdlZCAodGhlIGRhZW1vbiBvbmx5IGJyb2FkY2FzdHMgb24gYSBjaGFuZ2UpLlxuZXhwb3J0IGZ1bmN0aW9uIGZsYWdFbGVtZW50KHM6IE1hZ3BpZVN0YXRlLCBpZDogc3RyaW5nLCBmbGFnZ2VkOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGVsID0gcy5lbGVtZW50cy5maW5kKChlKSA9PiBlLmlkID09PSBpZCk7XG4gIGlmICghZWwpIHJldHVybiBmYWxzZTtcbiAgaWYgKChlbC5mbGFnZ2VkID8/IGZhbHNlKSA9PT0gZmxhZ2dlZCkgcmV0dXJuIGZhbHNlO1xuICBlbC5mbGFnZ2VkID0gZmxhZ2dlZDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIEFwcGVuZCBhIHByb2R1Y2VkIHZlcnNpb24sIFVQU0VSVElORyBieSBtb2RlbDogcmUtcnVubmluZyB0aGUgc2FtZSBtb2RlbFxuLy8gb3ZlcndyaXRlcyBpdHMgcGF0aCArIGJ1bXBzIHJldiAoY2FjaGUtYnVzdCkgYW5kIGtlZXBzIHRoZSBzdGFibGUgaWQ7IGEgbmV3XG4vLyBtb2RlbCBhcHBlbmRzIGEgcm93LiBBIGZyZXNoIHJlc3VsdCBjbGVhcnMgYGZsYWdnZWRgICh0aGUgcmVxdWVzdCBpcyBmdWxmaWxsZWQpXG4vLyBhbmQg4oCUIHVubGVzcyB7IGNob29zZTpmYWxzZSB9IOKAlCBiZWNvbWVzIHRoZSBjaG9zZW4gdmVyc2lvbi4gUmV0dXJucyB0aGUgc3RvcmVkXG4vLyB2ZXJzaW9uLCBvciBudWxsIGlmIHRoZSBlbGVtZW50IGlzIGdvbmUuXG5leHBvcnQgZnVuY3Rpb24gYWRkVmVyc2lvbihcbiAgczogTWFncGllU3RhdGUsXG4gIGlkOiBzdHJpbmcsXG4gIHY6IEVsZW1lbnRWZXJzaW9uLFxuICBvcHRzOiB7IGNob29zZT86IGJvb2xlYW4gfSA9IHt9LFxuKTogRWxlbWVudFZlcnNpb24gfCBudWxsIHtcbiAgY29uc3QgZWwgPSBzLmVsZW1lbnRzLmZpbmQoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgaWYgKCFlbCkgcmV0dXJuIG51bGw7XG4gIGlmICghZWwudmVyc2lvbnMpIGVsLnZlcnNpb25zID0gW107XG4gIGNvbnN0IGV4aXN0aW5nID0gZWwudmVyc2lvbnMuZmluZCgoeCkgPT4geC5tb2RlbCA9PT0gdi5tb2RlbCk7XG4gIGxldCBzdG9yZWQ6IEVsZW1lbnRWZXJzaW9uO1xuICBpZiAoZXhpc3RpbmcpIHtcbiAgICBleGlzdGluZy5wYXRoID0gdi5wYXRoO1xuICAgIGV4aXN0aW5nLnJldiA9IChleGlzdGluZy5yZXYgPz8gMCkgKyAxO1xuICAgIGlmICh2LmtpbmQgIT09IHVuZGVmaW5lZCkgZXhpc3Rpbmcua2luZCA9IHYua2luZDtcbiAgICBpZiAodi5ub3RlICE9PSB1bmRlZmluZWQpIGV4aXN0aW5nLm5vdGUgPSB2Lm5vdGU7XG4gICAgc3RvcmVkID0gZXhpc3Rpbmc7XG4gIH0gZWxzZSB7XG4gICAgc3RvcmVkID0geyAuLi52LCByZXY6IHYucmV2ID8/IDAgfTtcbiAgICBlbC52ZXJzaW9ucy5wdXNoKHN0b3JlZCk7XG4gIH1cbiAgaWYgKG9wdHMuY2hvb3NlID8/IHRydWUpIGVsLmNob3NlblZlcnNpb25JZCA9IHN0b3JlZC5pZDtcbiAgZWwuZmxhZ2dlZCA9IGZhbHNlO1xuICByZXR1cm4gc3RvcmVkO1xufVxuXG4vLyBUaGUgdXNlciBzZWxlY3RpbmcgYSB2ZXJzaW9uIOKGkiBpdCBiZWNvbWVzIGNob3NlbiAoYW1iaWVudCkuIFJldHVybnMgd2hldGhlciBpdFxuLy8gY2hhbmdlZDsgcmVqZWN0cyBhbiB1bmtub3duIGVsZW1lbnQgb3IgYSB2ZXJzaW9uSWQgbm90IHByZXNlbnQgb24gaXQuXG5leHBvcnQgZnVuY3Rpb24gY2hvb3NlVmVyc2lvbihzOiBNYWdwaWVTdGF0ZSwgaWQ6IHN0cmluZywgdmVyc2lvbklkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgZWwgPSBzLmVsZW1lbnRzLmZpbmQoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgaWYgKCFlbCB8fCAhKGVsLnZlcnNpb25zID8/IFtdKS5zb21lKCh2KSA9PiB2LmlkID09PSB2ZXJzaW9uSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmIChlbC5jaG9zZW5WZXJzaW9uSWQgPT09IHZlcnNpb25JZCkgcmV0dXJuIGZhbHNlO1xuICBlbC5jaG9zZW5WZXJzaW9uSWQgPSB2ZXJzaW9uSWQ7XG4gIHJldHVybiB0cnVlO1xufVxuXG5jb25zdCBCQUNLRFJPUFM6IHJlYWRvbmx5IEJhY2tkcm9wW10gPSBbXCJ3aGl0ZVwiLCBcImdyYXlcIiwgXCJibGFja1wiLCBcInRyYW5zcGFyZW50XCJdO1xuXG5leHBvcnQgZnVuY3Rpb24gc2V0QmFja2Ryb3AoczogTWFncGllU3RhdGUsIGJhY2tkcm9wOiBCYWNrZHJvcCk6IGJvb2xlYW4ge1xuICBpZiAoIUJBQ0tEUk9QUy5pbmNsdWRlcyhiYWNrZHJvcCkgfHwgcy5iYWNrZHJvcCA9PT0gYmFja2Ryb3ApIHJldHVybiBmYWxzZTtcbiAgcy5iYWNrZHJvcCA9IGJhY2tkcm9wO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8g4pSA4pSAIHBoYXNlIHNwaW5lIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vLyBBZHZhbmNlIHRoZSBsaW5lYXIgcGhhc2UgY3Vyc29yIHRvIHRoZSBuZXh0IHBoYXNlIOKAlCB3aGF0IHRoZSBzZWFsLWFuZC1oYW5kLW9mZlxuLy8gZ2F0ZSBmaXJlcy4gUmV0dXJucyB0aGUgbmV3IHBoYXNlLCBvciBudWxsIGlmIGFscmVhZHkgYXQgdGhlIGxhc3QgKG5vLW9wKS5cbmV4cG9ydCBmdW5jdGlvbiBhZHZhbmNlUGhhc2UoczogTWFncGllU3RhdGUpOiBQaGFzZUtleSB8IG51bGwge1xuICBjb25zdCBpID0gUEhBU0VTLmluZGV4T2Yocy5waGFzZSk7XG4gIGlmIChpIDwgMCB8fCBpID49IFBIQVNFUy5sZW5ndGggLSAxKSByZXR1cm4gbnVsbDtcbiAgcy5waGFzZSA9IFBIQVNFU1tpICsgMV07XG4gIHJldHVybiBzLnBoYXNlO1xufVxuXG4vLyBTZXQgdGhlIHBoYXNlIGN1cnNvciBkaXJlY3RseSAoYmFjay1uYXYgLyBqdW1wKS4gVmFsaWRhdGVzIGFnYWluc3QgUEhBU0VTO1xuLy8gcmVwb3J0cyB3aGV0aGVyIGl0IGNoYW5nZWQuXG5leHBvcnQgZnVuY3Rpb24gc2V0UGhhc2UoczogTWFncGllU3RhdGUsIHBoYXNlOiBQaGFzZUtleSk6IGJvb2xlYW4ge1xuICBpZiAoIVBIQVNFUy5pbmNsdWRlcyhwaGFzZSkgfHwgcy5waGFzZSA9PT0gcGhhc2UpIHJldHVybiBmYWxzZTtcbiAgcy5waGFzZSA9IHBoYXNlO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8gUmVjb3JkIHRoZSBidWlsdCBleHBvcnQgYnVuZGxlICh0aGUgYWdlbnQgcG9zdHMgaXQgYWZ0ZXIgemlwcGluZykuIFRoZSBzdXJmYWNlXG4vLyBvZmZlcnMgaXQgYXMgYSBkb3dubG9hZCB2aWEgL2Fzc2V0cy88bmFtZT4uXG5leHBvcnQgZnVuY3Rpb24gc2V0QnVuZGxlKHM6IE1hZ3BpZVN0YXRlLCBuYW1lOiBzdHJpbmcsIGNvdW50OiBudW1iZXIpOiB2b2lkIHtcbiAgcy5idW5kbGUgPSB7IG5hbWUsIGNvdW50IH07XG59XG5cbi8vIOKUgOKUgCBsZWFuIHByb2plY3Rpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBTdHJpcCBhbnkgKGV2ZW50dWFsbHkgaGVhdnkpIGlubGluZWQgYmxvYnMgZnJvbSB0aGUgYWdlbnQtZmFjaW5nIC9zdGF0ZSBzbyB0aGVcbi8vIHNuYXBzaG90IHN0YXlzIHNtYWxsOyB0aGUgYWdlbnQgcmVhZHMgb24tZGlzayB2ZXJzaW9uIHBhdGhzIGluc3RlYWQuIFZlcnNpb25zXG4vLyBjYXJyeSBvbmx5IGBwYXRoYCAobm90IGlubGluZWQgaW1hZ2UgZGF0YSksIHNvIHRoaXMgaXMgbmVhci1pZGVudGl0eSDigJQgYnV0IGl0XG4vLyBkZWZlbnNpdmVseSBkcm9wcyBhbnkgYHNyY2AvYGN1dG91dHNgIGZpZWxkcyBhbiBlbGVtZW50IG1pZ2h0IGlubGluZSwgYW5kIG5ldmVyXG4vLyBtdXRhdGVzIHRoZSBzb3VyY2Ugc3RhdGUuXG5leHBvcnQgZnVuY3Rpb24gbGVhblN0YXRlKHM6IE1hZ3BpZVN0YXRlKTogTWFncGllU3RhdGUge1xuICByZXR1cm4ge1xuICAgIC4uLnMsXG4gICAgZWxlbWVudHM6IHMuZWxlbWVudHMubWFwKChlKSA9PiB7XG4gICAgICBjb25zdCBsZWFuID0geyAuLi5lIH0gYXMgRWxlbWVudCAmIHsgc3JjPzogdW5rbm93bjsgY3V0b3V0cz86IHVua25vd24gfTtcbiAgICAgIGRlbGV0ZSBsZWFuLnNyYztcbiAgICAgIGRlbGV0ZSBsZWFuLmN1dG91dHM7XG4gICAgICByZXR1cm4gbGVhbjtcbiAgICB9KSxcbiAgfTtcbn1cbiIsCiAgICAiLy8gc3JjL21hZ3BpZS9iYWNrZW5kL3NvdXJjZS5zZXJ2ZXIudHNcbi8vIFNlcnZlci9DTEktb25seTogbWF0ZXJpYWxpemUgYSB1c2VyLWRyb3BwZWQgY29tcG9zaXRlIChhIGJhc2U2NCBkYXRhLVVSTCB0aGVcbi8vIGJyb3dzZXIgc2VudCBvdmVyIGBzb3VyY2UuaW1wb3J0YCkgb250byB0aGUgcGVyLXNlc3Npb24gZmlsZXMgZGlyLCB0aGVuIGRlcml2ZVxuLy8gdGhlIGNhbm9uaWNhbCBTb3VyY2UgeyBwYXRoLCBzaXplLCBzaGEgfS4gYHBhdGhgIGlzIHRoZSBBQlNPTFVURSBvbi1kaXNrIGZpbGVcbi8vICh0aGUgYWdlbnQgcmVhZHMgKyBjcm9wcyBpdCk7IHRoZSBzdXJmYWNlIHJlbmRlcnMgaXQgdmlhIC9hc3NldHMvPGJhc2VuYW1lPi5cbi8vIERvIE5PVCBpbXBvcnQgZnJvbSBicm93c2VyIGNvZGUg4oCUIHVzZXMgbm9kZTpmcyArIEJ1bi5JbWFnZS9DcnlwdG9IYXNoZXIuXG5cbmltcG9ydCB7IHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdHlwZSB7IFNvdXJjZSB9IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWFncGllL3NoYXJlZC90eXBlc1wiO1xuXG4vLyBkYXRhOjxtaW1lPjtiYXNlNjQsPHBheWxvYWQ+IOKGkiByYXcgYnl0ZXMuIFRvbGVyYXRlcyBhIG1pc3NpbmcgcHJlZml4ICh0cmVhdHNcbi8vIHRoZSB3aG9sZSBzdHJpbmcgYXMgYmFzZTY0KS4gVGhyb3dzIG9uIGFuIGVtcHR5L3VuZGVjb2RhYmxlIHBheWxvYWQuXG5mdW5jdGlvbiBkZWNvZGVEYXRhVXJsKGRhdGFVcmw6IHN0cmluZyk6IFVpbnQ4QXJyYXkge1xuICBjb25zdCBjb21tYSA9IGRhdGFVcmwuaW5kZXhPZihcIixcIik7XG4gIGNvbnN0IGI2NCA9IGNvbW1hID49IDAgPyBkYXRhVXJsLnNsaWNlKGNvbW1hICsgMSkgOiBkYXRhVXJsO1xuICBjb25zdCBieXRlcyA9IEJ1ZmZlci5mcm9tKGI2NCwgXCJiYXNlNjRcIik7XG4gIGlmIChieXRlcy5sZW5ndGggPT09IDApIHRocm93IG5ldyBFcnJvcihcImVtcHR5IGltYWdlIHBheWxvYWRcIik7XG4gIHJldHVybiBuZXcgVWludDhBcnJheShieXRlcyk7XG59XG5cbi8vIFJlZHVjZSBhbiBhcmJpdHJhcnkgY2xpZW50LXN1cHBsaWVkIGZpbGVuYW1lIHRvIGEgc2FmZSBiYXNlbmFtZTogc3RyaXAgYW55XG4vLyBkaXJlY3RvcnkgY29tcG9uZW50cyArIHRyYXZlcnNhbCwga2VlcCBhIHNhbmUgY2hhcnNldCwgZmFsbCBiYWNrIHRvIHNvdXJjZS5wbmcuXG5mdW5jdGlvbiBzYW5pdGl6ZU5hbWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IGJhc2VuYW1lKG5hbWUgfHwgXCJcIikucmVwbGFjZSgvW15BLVphLXowLTkuXy1dL2csIFwiX1wiKTtcbiAgaWYgKCFiYXNlIHx8IGJhc2UgPT09IFwiLlwiIHx8IGJhc2UgPT09IFwiLi5cIiB8fCBiYXNlLnN0YXJ0c1dpdGgoXCIuXCIpKSByZXR1cm4gXCJzb3VyY2UucG5nXCI7XG4gIHJldHVybiBiYXNlO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWF0ZXJpYWxpemVTb3VyY2UoXG4gIGZpbGVzRGlyOiBzdHJpbmcsXG4gIG5hbWU6IHN0cmluZyxcbiAgZGF0YVVybDogc3RyaW5nLFxuKTogUHJvbWlzZTxTb3VyY2U+IHtcbiAgY29uc3QgYnl0ZXMgPSBkZWNvZGVEYXRhVXJsKGRhdGFVcmwpO1xuICBjb25zdCBzYWZlID0gc2FuaXRpemVOYW1lKG5hbWUpO1xuICBjb25zdCBwYXRoID0gam9pbihmaWxlc0Rpciwgc2FmZSk7XG4gIHdyaXRlRmlsZVN5bmMocGF0aCwgYnl0ZXMpO1xuXG4gIGNvbnN0IG1ldGEgPSBhd2FpdCBuZXcgQnVuLkltYWdlKGJ5dGVzKS5tZXRhZGF0YSgpO1xuICBjb25zdCBzaGEgPSBuZXcgQnVuLkNyeXB0b0hhc2hlcihcInNoYTI1NlwiKS51cGRhdGUoYnl0ZXMpLmRpZ2VzdChcImhleFwiKS5zbGljZSgwLCAxNik7XG4gIHJldHVybiB7XG4gICAgcGF0aCxcbiAgICBzaXplOiBbbWV0YS53aWR0aCA/PyAwLCBtZXRhLmhlaWdodCA/PyAwXSxcbiAgICBzaGEsXG4gIH07XG59XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7OztBQTJCQSxrQ0FBcUIsNkRBQTJDO0FBQ2hFO0FBQ0EsMEJBQWtCO0FBQ2xCO0FBQ0E7OztBQ2FPLElBQU0sU0FBOEIsQ0FBQyxVQUFVLFNBQVMsVUFBVSxRQUFRO0FBMEcxRSxTQUFTLFlBQVksQ0FBQyxPQUE0QjtBQUFBLEVBQ3ZELE9BQU87QUFBQSxJQUNMO0FBQUEsSUFDQSxRQUFRO0FBQUEsSUFDUixPQUFPO0FBQUEsSUFDUCxRQUFRO0FBQUEsSUFDUixVQUFVLENBQUM7QUFBQSxJQUNYLGNBQWMsQ0FBQztBQUFBLElBQ2YsVUFBVTtBQUFBLElBQ1YsUUFBUSxFQUFFLE1BQU0sT0FBTyxNQUFNLEdBQUc7QUFBQSxFQUNsQztBQUFBO0FBcUVLLElBQU0sb0JBQW9CLE9BQU8sT0FBTztBQUFBLEVBQzdDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0YsQ0FBVTs7O0FDN09WO0FBQ0E7QUFDQTtBQU1P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
