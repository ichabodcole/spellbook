#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// src/grapevine/backend/daemon.ts
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync as existsSync3,
  mkdirSync,
  openSync,
  readdirSync as readdirSync2,
  readFileSync as readFileSync3,
  readSync,
  statSync as statSync2,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync2
} from "fs";
import { homedir } from "os";
import { dirname, join as join2 } from "path";
import { fileURLToPath } from "url";

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

// src/kit/wire/housekeeping.ts
var TIMER_MAX_S = Math.floor((2 ** 31 - 1) / 1000);
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

// src/grapevine/backend/heartbeat.ts
var IDLE_TIMEOUT_SEC = idleTimeoutSec(process.env.GRAPEVINE_IDLE_TIMEOUT_SEC, MAX_IDLE_TIMEOUT_SEC);
var DEFAULT_SSE_HEARTBEAT_MS = 3000;
var SSE_HEARTBEAT_MS = heartbeatMs(process.env.GRAPEVINE_HEARTBEAT_MS, IDLE_TIMEOUT_SEC, DEFAULT_SSE_HEARTBEAT_MS);
var TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

// src/grapevine/backend/daemon.ts
var SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
var SKILL_ROOT = join2(SCRIPT_DIR, "..");
var DIST_DIR = join2(SKILL_ROOT, "dist");
function resolveMode2() {
  return resolveMode(DIST_DIR);
}
var MODE = resolveMode2();
function serveDist(rel) {
  return serveFromDist(DIST_DIR, rel);
}
function readPluginVersion() {
  try {
    const pluginJsonPath = join2(SCRIPT_DIR, "..", "..", "..", ".claude-plugin", "plugin.json");
    const raw = readFileSync3(pluginJsonPath, "utf-8");
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}
var PLUGIN_VERSION = readPluginVersion();
var DATA_DIR = process.env.GRAPEVINE_HOME ?? join2(homedir(), ".grapevine");
var CHANNELS_DIR = join2(DATA_DIR, "channels");
var ARCHIVE_DIR = join2(DATA_DIR, "archive");
var PORT_FILE = join2(DATA_DIR, "daemon.port");
var PID_FILE = join2(DATA_DIR, "daemon.pid");
var HOLD_FILE = join2(DATA_DIR, "daemon.hold");
var CONFIG_FILE = join2(DATA_DIR, "config.json");
function readConfigAlias() {
  try {
    const cfg = JSON.parse(readFileSync3(CONFIG_FILE, "utf-8"));
    return typeof cfg.alias === "string" && cfg.alias.trim() ? cfg.alias.trim() : null;
  } catch {
    return null;
  }
}
var channels = new Map;
function ensureDirs() {
  mkdirSync(CHANNELS_DIR, { recursive: true });
}
function channelPath(name) {
  const VALID = /^[a-zA-Z0-9_-]([a-zA-Z0-9_.-]{0,62}[a-zA-Z0-9_-])?$/;
  if (!VALID.test(name) || name.includes("..")) {
    throw new Error(`invalid channel name: ${JSON.stringify(name)}`);
  }
  return join2(CHANNELS_DIR, `${name}.jsonl`);
}
function archivedPath(name) {
  channelPath(name);
  return join2(CHANNELS_DIR, `${name}.archived`);
}
function snapshotAndClear(name) {
  const p = channelPath(name);
  let snapshot = null;
  if (existsSync3(p)) {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    snapshot = join2(ARCHIVE_DIR, `${name}-${Date.now()}.jsonl`);
    copyFileSync(p, snapshot);
    writeFileSync2(p, "");
  }
  const ch = channels.get(name);
  if (ch) {
    ch.next_id = 1;
    ch.topic = null;
    ch.last_activity = Date.now();
  }
  return snapshot;
}
function persistChannel(name) {
  const p = channelPath(name);
  if (!existsSync3(p))
    writeFileSync2(p, "");
  const ch = channels.get(name);
  if (ch && ch.next_id === 1) {
    try {
      const st = statSync2(p);
      ch.created_at = st.birthtimeMs || st.mtimeMs;
    } catch {}
  }
}
function loadChannel(name) {
  const existing = channels.get(name);
  if (existing)
    return existing;
  const path = channelPath(name);
  let next_id = 1;
  let created_at = Date.now();
  let topic = null;
  if (existsSync3(path)) {
    const raw = readFileSync3(path, "utf-8");
    const lines = raw.split(`
`).filter((l) => l.trim());
    let sawParseableLine = false;
    if (lines.length) {
      let maxId = 0;
      for (const line of lines) {
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (!sawParseableLine && typeof m.ts === "number") {
          created_at = m.ts;
          sawParseableLine = true;
        }
        if (typeof m.id === "number" && m.id > maxId)
          maxId = m.id;
        if (m.kind === "topic")
          topic = m.text;
      }
      next_id = Math.max(maxId, lines.length) + 1;
    }
    if (!sawParseableLine) {
      try {
        const st = statSync2(path);
        created_at = st.birthtimeMs || st.mtimeMs;
      } catch {}
    }
  }
  const ch = {
    name,
    created_at,
    next_id,
    subscribers: new Map,
    waits: new Set,
    last_activity: Date.now(),
    topic,
    archived: existsSync3(archivedPath(name))
  };
  channels.set(name, ch);
  return ch;
}
function channelMessageCount(path) {
  try {
    const raw = readFileSync3(path, "utf-8");
    let n = 0;
    for (const line of raw.split(`
`))
      if (line.trim())
        n++;
    return n;
  } catch {
    return null;
  }
}
function listChannels() {
  const onDisk = readdirSync2(CHANNELS_DIR).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length));
  const merged = new Set([...channels.keys(), ...onDisk]);
  return Array.from(merged).sort().map((name) => {
    const ch = channels.get(name);
    let last_activity = 0;
    let message_count = null;
    if (ch) {
      last_activity = ch.last_activity;
      message_count = ch.next_id - 1;
    } else {
      try {
        const s = statSync2(channelPath(name));
        last_activity = s.mtimeMs;
      } catch {}
      message_count = channelMessageCount(channelPath(name));
    }
    return {
      name,
      subscribers: ch ? visibleSubs(ch).length : 0,
      message_count,
      last_activity,
      loaded: !!ch,
      archived: existsSync3(archivedPath(name))
    };
  });
}
function appendMessage(name, from, text, kind = "message", inReplyTo, extra) {
  const ch = loadChannel(name);
  const msg = {
    id: ch.next_id++,
    channel: name,
    from,
    text,
    ts: Date.now(),
    kind,
    ...typeof inReplyTo === "number" ? { in_reply_to: inReplyTo } : {},
    ...extra ?? {}
  };
  const p = channelPath(name);
  let separator = "";
  try {
    const size = statSync2(p).size;
    if (size > 0) {
      const fd = openSync(p, "r");
      try {
        const tailByte = Buffer.alloc(1);
        readSync(fd, tailByte, 0, 1, size - 1);
        if (tailByte[0] !== 10)
          separator = `
`;
      } finally {
        closeSync(fd);
      }
    }
  } catch {}
  appendFileSync(p, `${separator}${JSON.stringify(msg)}
`);
  if (kind === "topic")
    ch.topic = text;
  ch.last_activity = msg.ts;
  for (const sub of ch.subscribers.values()) {
    try {
      sub.send(msg);
    } catch (e) {
      console.error("subscriber error:", e);
    }
  }
  for (const w of [...ch.waits]) {
    if (msg.id > w.since) {
      ch.waits.delete(w);
      try {
        w.resolve(readBacklog(name, w.since));
      } catch (e) {
        console.error("wait resolve error:", e);
      }
    }
  }
  return msg;
}
function visibleSubs(ch) {
  return Array.from(ch.subscribers.values()).filter((s) => !s.lurk);
}
function subscriberAliases(name) {
  const ch = channels.get(name);
  if (!ch)
    return [];
  const seen = new Set;
  for (const sub of visibleSubs(ch)) {
    if (sub.alias)
      seen.add(sub.alias);
  }
  return Array.from(seen).sort();
}
function subscriberHumans(name) {
  const ch = channels.get(name);
  if (!ch)
    return [];
  const seen = new Set;
  for (const sub of visibleSubs(ch)) {
    if (sub.alias && sub.human)
      seen.add(sub.alias);
  }
  return Array.from(seen).sort();
}
function readBacklog(name, since) {
  const path = channelPath(name);
  if (!existsSync3(path))
    return [];
  const out = [];
  const raw = readFileSync3(path, "utf-8");
  for (const line of raw.split(`
`)) {
    if (!line.trim())
      continue;
    try {
      const m = JSON.parse(line);
      if (m.id > since)
        out.push(m);
    } catch {}
  }
  return out;
}
function channelExists(name) {
  if (channels.has(name))
    return true;
  try {
    return existsSync3(channelPath(name));
  } catch {
    return false;
  }
}
function missingChannel(name) {
  return json({ error: `no channel "${name}"`, channel: name, hint: `open ${name}` }, { status: 404 });
}
function archivedChannel(name) {
  return json({ error: "archived", channel: name, hint: `unarchive ${name}` }, { status: 409 });
}
function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers ?? {} }
  });
}
function lifecycleTarget(name) {
  if (channelExists(name))
    return true;
  try {
    return existsSync3(archivedPath(name));
  } catch {
    return false;
  }
}
async function lifecycleFrom(req) {
  const body = await readJsonBody(req);
  return body && typeof body.from === "string" && body.from.trim() ? body.from.trim() : "system";
}
function appendLifecycle(name, from, event) {
  const text = event === "archived" ? "channel archived \u2014 read-only" : "channel unarchived \u2014 writable again";
  return appendMessage(name, from, text, "status", undefined, { event });
}
async function readJsonBody(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
async function handle(req, srv) {
  {
    const refused = refuseForeignOrigin(req, srv?.port, srv?.hostname);
    if (refused)
      return refused;
  }
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  if (path === "/" && method === "GET") {
    return json({
      ok: true,
      pid: process.pid,
      started_at: STARTED_AT,
      channels: channels.size,
      data_dir: DATA_DIR,
      version: PLUGIN_VERSION,
      mode: MODE
    });
  }
  if (path === "/" && method === "DELETE") {
    setTimeout(() => shutdown(0), 10);
    return json({ ok: true, shutting_down: true });
  }
  if (path === "/watch" && method === "GET") {
    return serveDist("index.html") ?? json({
      error: "watch surface missing",
      details: `${join2(DIST_DIR, "index.html")} not found (mode ${MODE})`
    }, { status: 500 });
  }
  if (path === "/channels" && method === "GET") {
    return json({ channels: listChannels() });
  }
  if (path === "/identity" && method === "GET") {
    return json({ alias: readConfigAlias() });
  }
  if (path === "/presence" && method === "GET") {
    const out = [];
    for (const ch of channels.values()) {
      const subs = visibleSubs(ch);
      if (subs.length === 0)
        continue;
      out.push({
        name: ch.name,
        subscribers: subscriberAliases(ch.name),
        humans: subscriberHumans(ch.name),
        connections: subs.length,
        named: subs.filter((s) => s.alias).length,
        anonymous: subs.filter((s) => !s.alias).length
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return json({ channels: out });
  }
  if (path === "/channels" && method === "POST") {
    const body = await readJsonBody(req);
    if (!body || typeof body.name !== "string") {
      return json({ error: "name required" }, { status: 400 });
    }
    try {
      let unarchived = false;
      const ap = archivedPath(body.name);
      if (body.explicit === true && existsSync3(ap)) {
        try {
          unlinkSync2(ap);
        } catch {}
        if (existsSync3(ap)) {
          return json({ error: "unarchive failed \u2014 marker still present", channel: body.name }, { status: 500 });
        }
        unarchived = true;
      } else if (body.explicit !== true && existsSync3(ap)) {
        return archivedChannel(body.name);
      }
      let cleared = false;
      let snapshot = null;
      if (body.fresh === true) {
        const existing = channels.get(body.name);
        const liveSubs = existing ? existing.subscribers.size : 0;
        if (liveSubs === 0) {
          snapshot = snapshotAndClear(body.name);
          cleared = true;
        }
      }
      const ch = loadChannel(body.name);
      persistChannel(body.name);
      if (unarchived) {
        ch.archived = false;
        appendLifecycle(body.name, typeof body.from === "string" ? body.from : "system", "unarchived");
      }
      if (typeof body.topic === "string" && body.topic.trim() !== "" && ch.topic === null) {
        appendMessage(body.name, typeof body.from === "string" ? body.from : "system", body.topic, "topic");
      }
      return json({
        name: ch.name,
        created_at: ch.created_at,
        message_count: ch.next_id - 1,
        subscribers: visibleSubs(ch).length,
        topic: ch.topic,
        unarchived,
        cleared,
        snapshot
      });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  }
  if (path === "/announce" && method === "POST") {
    const body = await readJsonBody(req);
    if (!body || typeof body.from !== "string" || typeof body.text !== "string") {
      return json({ error: "from and text required" }, { status: 400 });
    }
    const requested = Array.isArray(body.channels) ? body.channels.filter((c) => typeof c === "string") : undefined;
    const delivered = [];
    const skipped = [];
    let targets;
    if (requested) {
      targets = [];
      for (const name2 of requested) {
        let onDisk = false;
        try {
          onDisk = existsSync3(channelPath(name2));
        } catch {}
        if (existsSync3(archivedPath(name2))) {
          skipped.push({ name: name2, reason: "archived" });
        } else if (channels.has(name2) || onDisk) {
          targets.push(name2);
        } else {
          skipped.push({ name: name2, reason: "unknown" });
        }
      }
    } else {
      targets = [...channels.keys()].filter((name2) => !channels.get(name2)?.archived);
    }
    for (const name2 of targets) {
      if (existsSync3(archivedPath(name2))) {
        skipped.push({ name: name2, reason: "archived" });
        continue;
      }
      appendMessage(name2, body.from, body.text, "announcement");
      const ch = channels.get(name2);
      const vis = ch ? visibleSubs(ch) : [];
      const recipients = vis.reduce((n, sub) => sub.alias !== body.from ? n + 1 : n, 0);
      delivered.push({ name: name2, recipients });
    }
    const total_recipients = delivered.reduce((n, d) => n + d.recipients, 0);
    return json({ ok: true, channels: delivered, skipped, total_recipients });
  }
  const chMatch = path.match(/^\/channels\/([a-zA-Z0-9_-](?:[a-zA-Z0-9_.-]{0,62}[a-zA-Z0-9_-])?)(\/.*)?$/);
  const name = chMatch?.[1];
  if (chMatch && name !== undefined) {
    const sub = chMatch[2] ?? "";
    if (sub === "" && method === "DELETE") {
      const ch = channels.get(name);
      if (ch) {
        for (const s of ch.subscribers.values()) {
          try {
            s.send({
              id: -1,
              channel: name,
              from: "system",
              text: "channel closed",
              ts: Date.now(),
              kind: "message"
            });
          } catch {}
        }
        ch.subscribers.clear();
        channels.delete(name);
      }
      const p = channelPath(name);
      if (existsSync3(p)) {
        try {
          unlinkSync2(p);
        } catch {}
      }
      const ap = archivedPath(name);
      if (existsSync3(ap)) {
        try {
          unlinkSync2(ap);
        } catch {}
      }
      return json({ ok: true });
    }
    if (sub === "/archive" && method === "POST") {
      if (!lifecycleTarget(name))
        return missingChannel(name);
      const from = await lifecycleFrom(req);
      const wasArchived = existsSync3(archivedPath(name));
      writeFileSync2(archivedPath(name), "");
      const ch = channels.get(name);
      if (ch)
        ch.archived = true;
      const m = wasArchived ? null : appendLifecycle(name, from, "archived");
      return json({
        ok: true,
        channel: name,
        archived: true,
        changed: !wasArchived,
        id: m ? m.id : null
      });
    }
    if (sub === "/reset" && method === "POST") {
      const body = await readJsonBody(req) ?? {};
      const ch = channels.get(name);
      const liveSubs = ch ? ch.subscribers.size : 0;
      if (liveSubs > 0 && body.force !== true) {
        return json({ error: "live", channel: name, subscribers: liveSubs }, { status: 409 });
      }
      const snapshot = snapshotAndClear(name);
      return json({
        ok: true,
        channel: name,
        snapshot,
        cleared: snapshot !== null
      });
    }
    if (sub === "/unarchive" && method === "POST") {
      if (!lifecycleTarget(name))
        return missingChannel(name);
      const from = await lifecycleFrom(req);
      const ap = archivedPath(name);
      const wasArchived = existsSync3(ap);
      if (existsSync3(ap)) {
        try {
          unlinkSync2(ap);
        } catch {}
      }
      if (existsSync3(ap)) {
        return json({ error: "unarchive failed \u2014 marker still present", channel: name }, { status: 500 });
      }
      const ch = channels.get(name);
      if (ch)
        ch.archived = false;
      const m = wasArchived ? appendLifecycle(name, from, "unarchived") : null;
      return json({
        ok: true,
        channel: name,
        archived: false,
        changed: wasArchived,
        id: m ? m.id : null
      });
    }
    if (sub === "/messages" && method === "GET") {
      if (!channelExists(name))
        return missingChannel(name);
      const since = parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
      return json({ messages: readBacklog(name, since) });
    }
    if (sub === "/messages" && method === "POST") {
      const body = await readJsonBody(req);
      if (!body || typeof body.text !== "string" || typeof body.from !== "string") {
        return json({ error: "from and text required" }, { status: 400 });
      }
      if (existsSync3(archivedPath(name))) {
        return archivedChannel(name);
      }
      try {
        const inReplyTo = typeof body.in_reply_to === "number" ? body.in_reply_to : undefined;
        const m = appendMessage(name, body.from, body.text, "message", inReplyTo);
        const ch = channels.get(name);
        const aliases = subscriberAliases(name);
        const vis = ch ? visibleSubs(ch) : [];
        const recipients = vis.reduce((n, sub2) => sub2.alias !== body.from ? n + 1 : n, 0);
        return json({
          ...m,
          subscribers: vis.length,
          recipients,
          subscriber_aliases: aliases
        }, { status: 201 });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
      }
    }
    if (sub === "/status" && method === "POST") {
      const body = await readJsonBody(req);
      if (!body || typeof body.from !== "string" || typeof body.target !== "number" || typeof body.disposition !== "string") {
        return json({ error: "from, target, disposition required" }, { status: 400 });
      }
      const exists = readBacklog(name, 0).some((m2) => m2.id === body.target && m2.kind !== "status");
      if (!exists) {
        return json({ error: `no message ${body.target} in ${name}` }, { status: 404 });
      }
      const note = typeof body.note === "string" ? body.note : "";
      const m = appendMessage(name, body.from, note, "status", undefined, {
        target: body.target,
        disposition: body.disposition
      });
      return json(m, { status: 201 });
    }
    if (sub === "/wait" && method === "GET") {
      if (!channelExists(name))
        return missingChannel(name);
      const ch = loadChannel(name);
      const since = parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
      const alias = url.searchParams.get("as");
      const timeoutS = Math.min(Math.max(parseFloat(url.searchParams.get("timeout") ?? "30") || 30, 0.1), 300);
      let presenceKey = null;
      if (alias) {
        presenceKey = Symbol(`wait:${alias}`);
        ch.subscribers.set(presenceKey, {
          alias,
          send: () => {}
        });
      }
      const cleanupPresence = () => {
        if (presenceKey)
          ch.subscribers.delete(presenceKey);
      };
      const immediate = readBacklog(name, since);
      const cursorOf = (msgs) => msgs.at(-1)?.id ?? Math.max(since, ch.next_id - 1);
      if (immediate.length) {
        cleanupPresence();
        return json({
          messages: immediate,
          cursor: cursorOf(immediate),
          timed_out: false
        });
      }
      const result = await new Promise((resolve) => {
        let timeoutHandle = null;
        const waiter = {
          since,
          resolve: (msgs) => {
            if (timeoutHandle !== null)
              clearTimeout(timeoutHandle);
            resolve({ messages: msgs, timed_out: false });
          }
        };
        ch.waits.add(waiter);
        const missed = readBacklog(name, since);
        if (missed.length > 0) {
          ch.waits.delete(waiter);
          resolve({ messages: missed, timed_out: false });
          return;
        }
        timeoutHandle = setTimeout(() => {
          ch.waits.delete(waiter);
          resolve({ messages: [], timed_out: true });
        }, timeoutS * 1000);
      });
      cleanupPresence();
      return json({
        messages: result.messages,
        cursor: cursorOf(result.messages),
        timed_out: result.timed_out
      });
    }
    if (sub === "/subscribers" && method === "GET") {
      const ch = channels.get(name);
      const subs = ch ? visibleSubs(ch) : [];
      const named = subs.filter((s) => s.alias).length;
      const anonymous = subs.filter((s) => !s.alias).length;
      return json({
        channel: name,
        subscribers: subscriberAliases(name),
        humans: subscriberHumans(name),
        count: subs.length,
        connections: subs.length,
        named,
        anonymous,
        topic: ch?.topic ?? null
      });
    }
    if (sub === "/topic" && method === "GET") {
      if (!channelExists(name))
        return missingChannel(name);
      const ch = loadChannel(name);
      return json({ channel: name, topic: ch.topic });
    }
    if (sub === "/topic" && method === "PUT") {
      const body = await readJsonBody(req);
      if (!body || typeof body.topic !== "string") {
        return json({ error: "topic required" }, { status: 400 });
      }
      if (existsSync3(archivedPath(name))) {
        return archivedChannel(name);
      }
      try {
        const m = appendMessage(name, typeof body.from === "string" ? body.from : "system", body.topic, "topic");
        return json({ ok: true, channel: name, topic: body.topic, id: m.id });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
      }
    }
    if (sub === "/tail" && method === "GET") {
      const created = !channelExists(name);
      const ch = loadChannel(name);
      if (created)
        persistChannel(name);
      const archived = existsSync3(archivedPath(name));
      const since = parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
      const alias = url.searchParams.get("as");
      const human = ["1", "true"].includes(url.searchParams.get("human") ?? "");
      const lurk = ["1", "true"].includes(url.searchParams.get("lurk") ?? "");
      const lastRaw = url.searchParams.get("last");
      const lastN = lastRaw !== null ? parseInt(lastRaw, 10) : Number.NaN;
      const hasLast = Number.isFinite(lastN) && lastN >= 0;
      const effectiveSince = hasLast ? Math.max(-1, ch.next_id - 1 - lastN) : since;
      const backlog = effectiveSince >= 0 ? readBacklog(name, effectiveSince) : [];
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder;
          const send = (m) => {
            try {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(m)}

`));
            } catch {}
          };
          controller.enqueue(enc.encode(`event: subscribed
data: ${JSON.stringify({ channel: name, since: effectiveSince, as: alias, topic: ch.topic, latest_id: ch.next_id - 1, created, archived })}

`));
          for (const m of backlog)
            send(m);
          const key = Symbol(`sub:${alias ?? "anon"}`);
          ch.subscribers.set(key, { alias: alias ?? null, human, lurk, send });
          let cleanedUp = false;
          const cleanup = () => {
            if (cleanedUp)
              return;
            cleanedUp = true;
            clearInterval(hb);
            ch.subscribers.delete(key);
          };
          const hb = setInterval(() => {
            try {
              controller.enqueue(enc.encode(`: hb ${Date.now()}

`));
            } catch {
              cleanup();
            }
          }, SSE_HEARTBEAT_MS);
          controller.__cleanup = cleanup;
        },
        cancel() {
          this.__cleanup?.();
        }
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        }
      });
    }
  }
  if (MODE === "release" && method === "GET") {
    const served = serveDist(path.slice(1));
    if (served)
      return served;
  }
  return json({ error: "not found", path }, { status: 404 });
}
var server = null;
var STARTED_AT = Date.now();
function fileHasValue(path, expected) {
  try {
    return existsSync3(path) && readFileSync3(path, "utf-8").trim() === expected;
  } catch {
    return false;
  }
}
async function shutdown(code) {
  try {
    if (server)
      unlinkIfMatches(PORT_FILE, String(server.port));
    unlinkIfMatches(PID_FILE, String(process.pid));
  } catch {}
  if (server) {
    await drainAndStop({ server, graceMs: 0, stopMs: 200 });
  }
  process.exit(code);
}
async function main() {
  const devIndex = MODE === "dev" ? (await import("../../../../../src/grapevine/surface/index.html")).default : undefined;
  const routes = devIndex ? { "/watch": devIndex } : {};
  ensureDirs();
  try {
    if (existsSync3(HOLD_FILE)) {
      const until = parseInt(readFileSync3(HOLD_FILE, "utf-8").trim(), 10);
      if (!Number.isFinite(until) || until <= Date.now())
        unlinkSync2(HOLD_FILE);
    }
  } catch {}
  if (existsSync3(PORT_FILE) && existsSync3(PID_FILE)) {
    try {
      const port = parseInt(readFileSync3(PORT_FILE, "utf-8").trim(), 10);
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(500)
      });
      if (res.ok) {
        console.error(`daemon already running on port ${port}`);
        process.exit(0);
      }
    } catch {
      try {
        unlinkSync2(PORT_FILE);
      } catch {}
      try {
        unlinkSync2(PID_FILE);
      } catch {}
    }
  }
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: IDLE_TIMEOUT_SEC,
    routes,
    development: { hmr: MODE === "dev" },
    fetch: handle
  });
  writeFileAtomic(PORT_FILE, String(server.port));
  writeFileAtomic(PID_FILE, String(process.pid));
  STARTED_AT = Date.now();
  console.error(`grapevine daemon listening on http://127.0.0.1:${server.port} (pid ${process.pid}, mode ${MODE})`);
  console.error(`data dir: ${DATA_DIR}`);
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}
async function run() {
  await main();
  return 0;
}
export {
  fileHasValue,
  resolveMode2 as resolveMode,
  run
};
