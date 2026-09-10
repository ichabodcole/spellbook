#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// src/grapevine/backend/daemon.ts
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
var SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
var SKILL_ROOT = join(SCRIPT_DIR, "..");
var DIST_DIR = join(SKILL_ROOT, "dist");
function resolveMode() {
  const override = process.env.SPELLBOOK_SURFACE_MODE;
  if (override === "dev" || override === "release")
    return override;
  return existsSync(join(DIST_DIR, "index.html")) ? "release" : "dev";
}
var MODE = resolveMode();
var STATIC_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};
function serveDist(rel) {
  if (!rel || rel.includes("..") || rel.includes("/"))
    return null;
  const file = join(DIST_DIR, rel);
  if (!existsSync(file))
    return null;
  const ext = rel.slice(rel.lastIndexOf("."));
  return new Response(Bun.file(file), {
    headers: { "content-type": STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream" }
  });
}
function readPluginVersion() {
  try {
    const pluginJsonPath = join(SCRIPT_DIR, "..", "..", "..", ".claude-plugin", "plugin.json");
    const raw = readFileSync(pluginJsonPath, "utf-8");
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}
var PLUGIN_VERSION = readPluginVersion();
var DATA_DIR = process.env.GRAPEVINE_HOME ?? join(homedir(), ".grapevine");
var CHANNELS_DIR = join(DATA_DIR, "channels");
var ARCHIVE_DIR = join(DATA_DIR, "archive");
var PORT_FILE = join(DATA_DIR, "daemon.port");
var PID_FILE = join(DATA_DIR, "daemon.pid");
var HOLD_FILE = join(DATA_DIR, "daemon.hold");
var CONFIG_FILE = join(DATA_DIR, "config.json");
function readConfigAlias() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
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
  return join(CHANNELS_DIR, `${name}.jsonl`);
}
function archivedPath(name) {
  channelPath(name);
  return join(CHANNELS_DIR, `${name}.archived`);
}
function snapshotAndClear(name) {
  const p = channelPath(name);
  let snapshot = null;
  if (existsSync(p)) {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    snapshot = join(ARCHIVE_DIR, `${name}-${Date.now()}.jsonl`);
    copyFileSync(p, snapshot);
    writeFileSync(p, "");
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
  if (!existsSync(p))
    writeFileSync(p, "");
  const ch = channels.get(name);
  if (ch && ch.next_id === 1) {
    try {
      const st = statSync(p);
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
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf-8");
    const lines = raw.split(`
`).filter((l) => l.trim());
    let sawParseableLine = false;
    if (lines.length) {
      let maxId = 0;
      for (let i = 0;i < lines.length; i++) {
        let m;
        try {
          m = JSON.parse(lines[i]);
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
        const st = statSync(path);
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
    archived: existsSync(archivedPath(name))
  };
  channels.set(name, ch);
  return ch;
}
function channelMessageCount(path) {
  try {
    const raw = readFileSync(path, "utf-8");
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
  const onDisk = readdirSync(CHANNELS_DIR).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length));
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
        const s = statSync(channelPath(name));
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
      archived: existsSync(archivedPath(name))
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
    const size = statSync(p).size;
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
  if (!existsSync(path))
    return [];
  const out = [];
  const raw = readFileSync(path, "utf-8");
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
    return existsSync(channelPath(name));
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
    return existsSync(archivedPath(name));
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
async function handle(req) {
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
      details: `${join(DIST_DIR, "index.html")} not found (mode ${MODE})`
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
      if (body.explicit === true && existsSync(ap)) {
        try {
          unlinkSync(ap);
        } catch {}
        if (existsSync(ap)) {
          return json({ error: "unarchive failed \u2014 marker still present", channel: body.name }, { status: 500 });
        }
        unarchived = true;
      } else if (body.explicit !== true && existsSync(ap)) {
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
      for (const name of requested) {
        let onDisk = false;
        try {
          onDisk = existsSync(channelPath(name));
        } catch {}
        if (existsSync(archivedPath(name))) {
          skipped.push({ name, reason: "archived" });
        } else if (channels.has(name) || onDisk) {
          targets.push(name);
        } else {
          skipped.push({ name, reason: "unknown" });
        }
      }
    } else {
      targets = [...channels.keys()].filter((name) => !channels.get(name)?.archived);
    }
    for (const name of targets) {
      if (existsSync(archivedPath(name))) {
        skipped.push({ name, reason: "archived" });
        continue;
      }
      appendMessage(name, body.from, body.text, "announcement");
      const ch = channels.get(name);
      const vis = ch ? visibleSubs(ch) : [];
      const recipients = vis.reduce((n, sub) => sub.alias !== body.from ? n + 1 : n, 0);
      delivered.push({ name, recipients });
    }
    const total_recipients = delivered.reduce((n, d) => n + d.recipients, 0);
    return json({ ok: true, channels: delivered, skipped, total_recipients });
  }
  const chMatch = path.match(/^\/channels\/([a-zA-Z0-9_-](?:[a-zA-Z0-9_.-]{0,62}[a-zA-Z0-9_-])?)(\/.*)?$/);
  if (chMatch) {
    const name = chMatch[1];
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
      if (existsSync(p)) {
        try {
          unlinkSync(p);
        } catch {}
      }
      const ap = archivedPath(name);
      if (existsSync(ap)) {
        try {
          unlinkSync(ap);
        } catch {}
      }
      return json({ ok: true });
    }
    if (sub === "/archive" && method === "POST") {
      if (!lifecycleTarget(name))
        return missingChannel(name);
      const from = await lifecycleFrom(req);
      const wasArchived = existsSync(archivedPath(name));
      writeFileSync(archivedPath(name), "");
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
      const wasArchived = existsSync(ap);
      if (existsSync(ap)) {
        try {
          unlinkSync(ap);
        } catch {}
      }
      if (existsSync(ap)) {
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
      if (existsSync(archivedPath(name))) {
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
      const cursorOf = (msgs) => msgs.length ? msgs[msgs.length - 1].id : Math.max(since, ch.next_id - 1);
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
      if (existsSync(archivedPath(name))) {
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
      const archived = existsSync(archivedPath(name));
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
          }, 3000);
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
    return existsSync(path) && readFileSync(path, "utf-8").trim() === expected;
  } catch {
    return false;
  }
}
function shutdown(code) {
  try {
    if (server && fileHasValue(PORT_FILE, String(server.port)))
      unlinkSync(PORT_FILE);
    if (fileHasValue(PID_FILE, String(process.pid)))
      unlinkSync(PID_FILE);
  } catch {}
  if (server) {
    Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 200))]).finally(() => process.exit(code));
  } else {
    process.exit(code);
  }
}
async function main() {
  const devIndex = MODE === "dev" ? (await import("../../../../../src/grapevine/surface/index.html")).default : undefined;
  const routes = devIndex ? { "/watch": devIndex } : {};
  ensureDirs();
  try {
    if (existsSync(HOLD_FILE)) {
      const until = parseInt(readFileSync(HOLD_FILE, "utf-8").trim(), 10);
      if (!Number.isFinite(until) || until <= Date.now())
        unlinkSync(HOLD_FILE);
    }
  } catch {}
  if (existsSync(PORT_FILE) && existsSync(PID_FILE)) {
    try {
      const port = parseInt(readFileSync(PORT_FILE, "utf-8").trim(), 10);
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(500)
      });
      if (res.ok) {
        console.error(`daemon already running on port ${port}`);
        process.exit(0);
      }
    } catch {
      try {
        unlinkSync(PORT_FILE);
      } catch {}
      try {
        unlinkSync(PID_FILE);
      } catch {}
    }
  }
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    routes,
    development: { hmr: MODE === "dev" },
    fetch: handle
  });
  Bun.write(PORT_FILE, String(server.port));
  Bun.write(PID_FILE, String(process.pid));
  STARTED_AT = Date.now();
  console.error(`grapevine daemon listening on http://127.0.0.1:${server.port} (pid ${process.pid}, mode ${MODE})`);
  console.error(`data dir: ${DATA_DIR}`);
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}
async function run() {
  await main();
  return;
}
export {
  fileHasValue,
  resolveMode,
  run
};

//# debugId=A6C0F29015E546C864756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dyYXBldmluZS9iYWNrZW5kL2RhZW1vbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIjIS91c3IvYmluL2VudiBidW5cbi8vIGdyYXBldmluZSBkYWVtb24g4oCUIG11bHRpLXRlbmFudCBicm9rZXIgaG9zdGluZyBOIG5hbWVkIGNoYW5uZWxzIG9uXG4vLyAxMjcuMC4wLjEuIE9uZSBkYWVtb24gcGVyIG1hY2hpbmU7IENMSSB2ZXJicyAob3Blbi9saXN0L3RhaWwvc2VuZC9jbG9zZSlcbi8vIHRhbGsgdG8gaXQgb3ZlciBIVFRQLiBDaGFubmVscyBwZXJzaXN0IGFzIGFwcGVuZC1vbmx5IEpTT05MIHVuZGVyXG4vLyB+Ly5ncmFwZXZpbmUvY2hhbm5lbHMvPG5hbWU+Lmpzb25sLiBMaXZlIGZhbi1vdXQgdXNlcyBTU0UuXG4vL1xuLy8gU3RhcnRlZCBvbiBkZW1hbmQgYnkgYW55IENMSSB2ZXJiIHRoYXQgZmluZHMgbm8gcnVubmluZyBkYWVtb24uIFdyaXRlc1xuLy8gaXRzIHBvcnQgKyBwaWQgdG8gfi8uZ3JhcGV2aW5lL2RhZW1vbi57cG9ydCxwaWR9IGZvciBkaXNjb3ZlcnkuIFN0YXlzIHVwXG4vLyB1bnRpbCBgZ3JhcGV2aW5lIHN0b3BgIChERUxFVEUgLykgb3IgdGhlIHVzZXIga2lsbHMgaXQuXG4vL1xuLy8gSFRUUCBzdXJmYWNlIChhbGwgMTI3LjAuMC4xKTpcbi8vICAgR0VUICAgIC8gICAgICAgICAgICAg4oCUIGRhZW1vbiBpbmZvICh7cGlkLCBzdGFydGVkX2F0LCBjaGFubmVsczogTiwgdmVyc2lvbn0pXG4vLyAgIERFTEVURSAvICAgICAgICAgICAgIOKAlCBzaHV0IGRvd24gdGhlIGRhZW1vblxuLy8gICBHRVQgICAgL3dhdGNoICAgICAgICDigJQgdGhlIHdhdGNoIHN1cmZhY2UgKGxpdmUgdmlldzsgY2hhbm5lbCBmcm9tIFVSTCBoYXNoKS4gQnVpbHQ6XG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgcmVsZWFzZSBzZXJ2ZXMgZGlzdC9pbmRleC5odG1sICsgaXRzIGhhc2hlZCBjaHVua3MgYXQgdGhlIHJvb3Q7XG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgZGV2IHNlcnZlcyBCdW4ncyBidW5kbGUgb2Ygc3JjL2dyYXBldmluZS9zdXJmYWNlLyAoQ29udHJhY3QgMSlcbi8vICAgR0VUICAgIC9pZGVudGl0eSAgICAg4oCUIHsgYWxpYXMgfSB0aGUgcGVyc2lzdGVkIGRlZmF1bHQgYWxpYXMgKGNvbmZpZy5qc29uKSBbVjEuN11cbi8vICAgR0VUICAgIC9jaGFubmVscyAgICAg4oCUIGxpc3QgY2hhbm5lbHMgKGVhY2g6IHsg4oCmLCBhcmNoaXZlZCB9KVxuLy8gICBHRVQgICAgL3ByZXNlbmNlICAgICDigJQgY3Jvc3MtY2hhbm5lbCByb3N0ZXI6IFt7IG5hbWUsIHN1YnNjcmliZXJzOlthbGlhc10sIGh1bWFuczpbYWxpYXNdLCBjb25uZWN0aW9ucywgbmFtZWQsIGFub255bW91cyB9XVxuLy8gICBQT1NUICAgL2NoYW5uZWxzICAgICDigJQgeyBuYW1lLCB0b3BpYz8sIGZyb20/LCBleHBsaWNpdD8gfSBjcmVhdGUgY2hhbm5lbCAoaWRlbXBvdGVudDsgNDA5IGlmXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgYXJjaGl2ZWQgdW5sZXNzIGV4cGxpY2l0LCB3aGljaCBhdXRvLXVuYXJjaGl2ZXMgYW5kIGFwcGVuZHMgdGhlXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAga2luZDpcInN0YXR1c1wiIHVuYXJjaGl2ZWQgZnJhbWUpXG4vLyAgIERFTEVURSAvY2hhbm5lbHMvOm5hbWUg4oCUIGNsb3NlIGNoYW5uZWwgKGRlbGV0ZXMgbG9nICsgYXJjaGl2ZWQgbWFya2VyKVxuLy8gICBQT1NUICAgL2NoYW5uZWxzLzpuYW1lL2FyY2hpdmUgICDigJQgeyBmcm9tPyB9IG1hcmsgcmVhZC1vbmx5IChzaWRlY2FyIG1hcmtlcikgW1YxLjddOyBhcHBlbmRzIGFcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2luZDpcInN0YXR1c1wiIGZyYW1lIChldmVudDpcImFyY2hpdmVkXCIpIE9OTFkgd2hlbiB0aGUgc3RhdGVcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZmxpcHBlZDsgcmVzcG9uc2UgY2FycmllcyB7IGNoYW5nZWQsIGlkIH0gWzIwMjYtMDktMDZdXG4vLyAgIFBPU1QgICAvY2hhbm5lbHMvOm5hbWUvdW5hcmNoaXZlIOKAlCB7IGZyb20/IH0gY2xlYXIgcmVhZC1vbmx5IFtWMS43XTsgc2FtZSwgZXZlbnQ6XCJ1bmFyY2hpdmVkXCJcbi8vICAgUE9TVCAgIC9jaGFubmVscy86bmFtZS9tZXNzYWdlcyDigJQgeyBmcm9tLCB0ZXh0LCBpbl9yZXBseV90bz8gfSBhcHBlbmQgKyBicm9hZGNhc3QgKDQwOSBpZiBhcmNoaXZlZClcbi8vICAgR0VUICAgIC9jaGFubmVscy86bmFtZS9tZXNzYWdlcyDigJQgYmFja2xvZyAoP3NpbmNlPTxpZD4pIFs0MDQgaWYgbm8gc3VjaCBjaGFubmVsXVxuLy8gICBHRVQgICAgL2NoYW5uZWxzLzpuYW1lL3N1YnNjcmliZXJzIOKAlCB7IGNoYW5uZWwsIHN1YnNjcmliZXJzOlthbGlhc10sIGh1bWFuczpbYWxpYXNdLCBjb3VudCwgY29ubmVjdGlvbnMsIG5hbWVkLCBhbm9ueW1vdXMsIHRvcGljIH1cbi8vICAgR0VUICAgIC9jaGFubmVscy86bmFtZS90b3BpYyAgICDigJQgeyBjaGFubmVsLCB0b3BpYyB9IFs0MDQgaWYgbm8gc3VjaCBjaGFubmVsXVxuLy8gICBQVVQgICAgL2NoYW5uZWxzLzpuYW1lL3RvcGljICAgIOKAlCB7IHRvcGljLCBmcm9tPyB9IHVwZGF0ZSB0b3BpYyAoYXBwZW5kcyBhIGtpbmQ6XCJ0b3BpY1wiIG1lc3NhZ2U7XG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNyZWF0ZXMgdGhlIGNoYW5uZWwg4oCUIGl0IGlzIGEgd3JpdGU7IDQwOSBpZiBhcmNoaXZlZClcbi8vICAgR0VUICAgIC9jaGFubmVscy86bmFtZS93YWl0ICAgICDigJQgbG9uZy1wb2xsIGZvciBuZXcgbWVzc2FnZXMgWzQwNCBpZiBubyBzdWNoIGNoYW5uZWxdXG4vLyAgIEdFVCAgICAvY2hhbm5lbHMvOm5hbWUvdGFpbCAgICAg4oCUIFNTRTogbGl2ZSBtZXNzYWdlcyAoP3NpbmNlPTxpZD4gY2F0Y2gtdXAsID9hcz08YWxpYXM+IHJlZ2lzdGVycyxcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgP2h1bWFuPTEgbWFya3MgaHVtYW4gW1YxLjddLCA/bHVyaz0xIHJlY2VpdmVzIGJ1dCByZWdpc3RlcnMgbm8gcHJlc2VuY2UgW1YxLjddKS5cbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3Vic2NyaWJlZCBldmVudCBpbmNsdWRlcyB0aGUgY3VycmVudCB0b3BpYywgYGNyZWF0ZWRgICh0cnVlIHdoZW4gVEhJU1xuLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzdWJzY3JpYmUgYnJvdWdodCB0aGUgY2hhbm5lbCBpbnRvIGJlaW5nIOKAlCBpLmUuIGEgbWlzdHlwZWQgbmFtZSkgYW5kXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBhcmNoaXZlZGAgKHRoZSBjaGFubmVsIGlzIHJlYWQtb25seTsgYSBzZW5kIHdpbGwgYmUgcmVqZWN0ZWQpLlxuLy9cbi8vIFJFQURTIERPIE5PVCBDUkVBVEUgKDIwMjYtMDktMDYpLiBPbmx5IGFuIGFjdCBkZWNsYXJpbmcgaW50ZW50IHRoYXQgdGhlXG4vLyBjaGFubmVsIGV4aXN0IG1heSBicmluZyBvbmUgaW50byBiZWluZzogUE9TVCAvY2hhbm5lbHMsIGV2ZXJ5IGFwcGVuZCwgUFVUXG4vLyAvdG9waWMsIGFuZCBHRVQgL3RhaWwgKGEgc3Vic2NyaXB0aW9uIGlzIGZvcndhcmQtbG9va2luZykuIEdFVCAvbWVzc2FnZXMsXG4vLyBHRVQgL3dhaXQgYW5kIEdFVCAvdG9waWMgYW5zd2VyIDQwNCB3aXRoIGEgYGhpbnRgIG5hbWluZyB0aGUgYG9wZW5gIHRoYXRcbi8vIHdvdWxkIGZpeCBpdC4gQmVmb3JlIHRoaXMsIHRoZXkgYWxsIHJhbiB0aHJvdWdoIGxvYWRDaGFubmVsKCksIHdoaWNoXG4vLyByZWdpc3RlcnMgYW55IG5hbWUgaXQgaXMgaGFuZGVkLCBzbyBhIHJlYWQgcmVzdXJyZWN0ZWQgYSBjbG9zZWQgY2hhbm5lbCBpbnRvXG4vLyBgbGlzdGAg4oCUIGVtcHR5LCBmaWxlLWxlc3MsIGFuZCB1bmRldGVjdGFibGUgZnJvbSB0aGUgcmVhZGVyJ3Mgc2lkZS5cbi8vXG4vLyBNZXNzYWdlIHNoYXBlOiB7IGlkLCBjaGFubmVsLCBmcm9tLCB0ZXh0LCB0cywga2luZDogXCJtZXNzYWdlXCIsIGluX3JlcGx5X3RvPzogPGlkPiB9XG4vLyBJRHMgYXJlIGNoYW5uZWwtc2NvcGVkLCBtb25vdG9uaWNhbGx5IGFzY2VuZGluZyBpbnRlZ2Vycy4gYHRzYCBpcyB1bml4XG4vLyBtaWxsaXMgYXQgYXBwZW5kIHRpbWUuXG5cbmltcG9ydCB7XG4gIGFwcGVuZEZpbGVTeW5jLFxuICBjbG9zZVN5bmMsXG4gIGNvcHlGaWxlU3luYyxcbiAgZXhpc3RzU3luYyxcbiAgbWtkaXJTeW5jLFxuICBvcGVuU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgcmVhZFN5bmMsXG4gIHN0YXRTeW5jLFxuICB1bmxpbmtTeW5jLFxuICB3cml0ZUZpbGVTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuLy8gUGF0aHMgYW5jaG9yIGF0IHRoZSBTS0lMTCBST09ULCBuZXZlciBhdCBjd2Q6IGNsaS50cyBwaW5zIHRoZSBkYWVtb24ncyBjd2QgdG9cbi8vIHNyYy9ncmFwZXZpbmUvIGluIGRldiBmb3IgYnVuZmlnLnRvbWwncyBzYWtlIChDb250cmFjdCA1KSwgc28gY3dkIGlzIG5vdCBhXG4vLyBzdGFibGUgYmFzZSBmb3IgZGlzdC8uXG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcblxuLy8gcmVsZWFzZSBpZmYgZGlzdC9pbmRleC5odG1sIGV4aXN0cyBhdCB0aGUgc2tpbGwgcm9vdCDigJQgdGhlIEZJTEUsIG5ldmVyIHRoZVxuLy8gZGlyZWN0b3J5IChhIGJ1aWx0IGJhY2tlbmQgY2FuIHB1dCBjbGkuanMgaW4gZGlzdC8gd2l0aCBubyBzdXJmYWNlIHRoZXJlKSDigJRcbi8vIGVsc2UgZGV2OyB0aGUgZW52IG92ZXJyaWRlIHdpbnMgZWl0aGVyIHdheSAoQ29udHJhY3QgMSkuIFJlbGVhc2U6IHplcm8gcmVhZHNcbi8vIG9mIHN1cmZhY2Ugc291cmNlIG9yIGJ1bmZpZy50b21sIOKAlCBzdGF0aWMgZmlsZXMgb25seS4gU2FtZSBzaGFwZSBhc1xuLy8gZ2xhbW91cidzIHNlcnZlci50cy4gRXhwb3J0ZWQgZm9yIHRlc3RzLlxuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKCk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIGNvbnN0IG92ZXJyaWRlID0gcHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERTtcbiAgaWYgKG92ZXJyaWRlID09PSBcImRldlwiIHx8IG92ZXJyaWRlID09PSBcInJlbGVhc2VcIikgcmV0dXJuIG92ZXJyaWRlO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gXCJyZWxlYXNlXCIgOiBcImRldlwiO1xufVxuY29uc3QgTU9ERSA9IHJlc29sdmVNb2RlKCk7XG5cbmNvbnN0IFNUQVRJQ19DT05URU5UX1RZUEVTOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcIi5odG1sXCI6IFwidGV4dC9odG1sOyBjaGFyc2V0PXV0Zi04XCIsXG4gIFwiLmpzXCI6IFwidGV4dC9qYXZhc2NyaXB0XCIsXG4gIFwiLmNzc1wiOiBcInRleHQvY3NzXCIsXG4gIFwiLmpzb25cIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gIFwiLnN2Z1wiOiBcImltYWdlL3N2Zyt4bWxcIixcbiAgXCIucG5nXCI6IFwiaW1hZ2UvcG5nXCIsXG59O1xuXG4vLyBTZXJ2ZXMgb25lIGZpbGUgZnJvbSBkaXN0LyB2ZXJiYXRpbSDigJQgdGhlIHVuaGFzaGVkIGVudHJ5IGluZGV4Lmh0bWwsIGFuZCB0aGVcbi8vIGhhc2hlZCBpbmRleC0qLmpzIC8gaW5kZXgtKi5jc3MgaXQgbGlua3MgUkVMQVRJVkVMWSAoYC4vaW5kZXgtPGhhc2g+LmpzYCksXG4vLyB3aGljaCBmcm9tIC93YXRjaCByZXNvbHZlIHRvIGJhcmUgZmlsZW5hbWVzIGF0IHRoZSByb290IChDb250cmFjdCAyJ3MgZmxhdFxuLy8gbGF5b3V0KS4gVGhlIGd1YXJkIGtlZXBzIHRoaXMgb25lIGxldmVsIGRlZXA6IGEgbmVzdGVkIG9yIGAuLmAgcGF0aCBpc1xuLy8gcmVmdXNlZCwgc28gaXQgY2FuIG5ldmVyIHJlYWNoIG91dHNpZGUgZGlzdC8gYW5kIG5ldmVyIHNoYWRvd3MgYSBKU09OIHJvdXRlLlxuZnVuY3Rpb24gc2VydmVEaXN0KHJlbDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgaWYgKCFyZWwgfHwgcmVsLmluY2x1ZGVzKFwiLi5cIikgfHwgcmVsLmluY2x1ZGVzKFwiL1wiKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGZpbGUgPSBqb2luKERJU1RfRElSLCByZWwpO1xuICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIHJldHVybiBudWxsO1xuICBjb25zdCBleHQgPSByZWwuc2xpY2UocmVsLmxhc3RJbmRleE9mKFwiLlwiKSk7XG4gIHJldHVybiBuZXcgUmVzcG9uc2UoQnVuLmZpbGUoZmlsZSksIHtcbiAgICBoZWFkZXJzOiB7IFwiY29udGVudC10eXBlXCI6IFNUQVRJQ19DT05URU5UX1RZUEVTW2V4dF0gPz8gXCJhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1cIiB9LFxuICB9KTtcbn1cblxuLy8gUmVhZCBvdXIgcGx1Z2luIHZlcnNpb24gZnJvbSB0aGUgc2FtZSBwbHVnaW4uanNvbiB0aGUgQ0xJIHJlYWRzLiBEYWVtb25cbi8vIGFkdmVydGlzZXMgdGhpcyBvbiBHRVQgLyBzbyBDTEkgY2xpZW50cyBjYW4gZGV0ZWN0IGNhY2hlLXBpbm5pbmcgbWlzbWF0Y2hlc1xuLy8gKGUuZy4gYSBWMS41IGRhZW1vbiBzZXJ2aW5nIGEgVjEuNiBDTEksIHdoZXJlIGRhZW1vbi1zaWRlIGZlYXR1cmVzIGxpa2Vcbi8vIGByZWNpcGllbnRzYCBhcmUgc2lsZW50bHkgYWJzZW50KS4gQmVzdC1lZmZvcnQg4oCUIHZlcnNpb24gaXMgbnVsbCBpZiByZWFkIGZhaWxzLlxuZnVuY3Rpb24gcmVhZFBsdWdpblZlcnNpb24oKTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgY29uc3QgcGx1Z2luSnNvblBhdGggPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLmNsYXVkZS1wbHVnaW5cIiwgXCJwbHVnaW4uanNvblwiKTtcbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMocGx1Z2luSnNvblBhdGgsIFwidXRmLThcIik7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KS52ZXJzaW9uID8/IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5jb25zdCBQTFVHSU5fVkVSU0lPTiA9IHJlYWRQbHVnaW5WZXJzaW9uKCk7XG5cbmNvbnN0IERBVEFfRElSID0gcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0hPTUUgPz8gam9pbihob21lZGlyKCksIFwiLmdyYXBldmluZVwiKTtcbmNvbnN0IENIQU5ORUxTX0RJUiA9IGpvaW4oREFUQV9ESVIsIFwiY2hhbm5lbHNcIik7XG5jb25zdCBBUkNISVZFX0RJUiA9IGpvaW4oREFUQV9ESVIsIFwiYXJjaGl2ZVwiKTtcbmNvbnN0IFBPUlRfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiZGFlbW9uLnBvcnRcIik7XG5jb25zdCBQSURfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiZGFlbW9uLnBpZFwiKTtcbmNvbnN0IEhPTERfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiZGFlbW9uLmhvbGRcIik7XG4vLyBQZXItSE9NRSBpZGVudGl0eSBjb25maWcgKFYxLjcpIOKAlCB0aGUgcGVyc2lzdGVkIGRlZmF1bHQgYWxpYXMgdGhlIENMSSBzZXRzXG4vLyAoYGdyYXBldmluZSBhbGlhcyA8bmFtZT5gKSBhbmQgdGhlIHdhdGNoIHN1cmZhY2UgcmVhZHMgdmlhIEdFVCAvaWRlbnRpdHkgc28gYVxuLy8gaHVtYW4gaGFzIGEgY29uc2lzdGVudCBuYW1lIGFjcm9zcyBldmVyeSBncmFwZXZpbmUgd2l0aG91dCByZS10eXBpbmcgaXQuXG5jb25zdCBDT05GSUdfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiY29uZmlnLmpzb25cIik7XG5cbmZ1bmN0aW9uIHJlYWRDb25maWdBbGlhcygpOiBzdHJpbmcgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBjZmcgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhDT05GSUdfRklMRSwgXCJ1dGYtOFwiKSk7XG4gICAgcmV0dXJuIHR5cGVvZiBjZmcuYWxpYXMgPT09IFwic3RyaW5nXCIgJiYgY2ZnLmFsaWFzLnRyaW0oKSA/IGNmZy5hbGlhcy50cmltKCkgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG50eXBlIE1lc3NhZ2UgPSB7XG4gIGlkOiBudW1iZXI7XG4gIGNoYW5uZWw6IHN0cmluZztcbiAgZnJvbTogc3RyaW5nO1xuICB0ZXh0OiBzdHJpbmc7XG4gIHRzOiBudW1iZXI7XG4gIGtpbmQ6IFwibWVzc2FnZVwiIHwgXCJ0b3BpY1wiIHwgXCJhbm5vdW5jZW1lbnRcIiB8IFwic3RhdHVzXCI7XG4gIC8vIFYxLjcgdGhyZWFkaW5nIOKAlCBpZCBvZiB0aGUgbWVzc2FnZSB0aGlzIG9uZSByZXBsaWVzIHRvIChzYW1lIGNoYW5uZWwpLlxuICAvLyBTdG9yZWQgb25seSB3aGVuIHNldDsgcmVhZGVycyB0aGF0IGRvbid0IHVuZGVyc3RhbmQgaXQgaWdub3JlIGl0LlxuICBpbl9yZXBseV90bz86IG51bWJlcjtcbiAgLy8gVjEuOSBkaXNwb3NpdGlvbiDigJQgc3RhdHVzIGZyYW1lcyByZWZlcmVuY2UgdGhlIG1lc3NhZ2UgYmVpbmcgYWN0ZWQgb24uXG4gIHRhcmdldD86IG51bWJlcjtcbiAgZGlzcG9zaXRpb24/OiBzdHJpbmc7XG4gIC8vIDIwMjYtMDktMDYg4oCUIHRoZSBPVEhFUiBraW5kIG9mIGtpbmQ6XCJzdGF0dXNcIiBmcmFtZTogYSBjaGFubmVsLWxldmVsXG4gIC8vIGxpZmVjeWNsZSBmYWN0IChhcmNoaXZlIC8gdW5hcmNoaXZlKSwgd2hpY2ggcmVmZXJlbmNlcyBubyBtZXNzYWdlIGFuZFxuICAvLyBjYXJyaWVzIG5vIGRpc3Bvc2l0aW9uLiBgZXZlbnRgIGlzIHRoZSBkaXNjcmltaW5hdG9yLCBhbmQgY29uc3VtZXJzIG5lZWRcbiAgLy8gaXQ6IGBwdWxsYCBhbmQgYHRhaWxgIGRyb3AgRElTUE9TSVRJT04gZnJhbWVzIGFzIG1ldGFkYXRhLCBhbmQgd291bGRcbiAgLy8gb3RoZXJ3aXNlIHN3YWxsb3cgdGhlc2UgdG9vLlxuICBldmVudD86IFwiYXJjaGl2ZWRcIiB8IFwidW5hcmNoaXZlZFwiO1xufTtcblxudHlwZSBTdWJzY3JpYmVyID0ge1xuICBhbGlhczogc3RyaW5nIHwgbnVsbDtcbiAgLy8gVjEuNyDigJQgYSBodW1hbi1kcml2ZW4gY29ubmVjdGlvbiAodGhlIHdhdGNoIHN1cmZhY2UsIG9yIGB0YWlsIC0taHVtYW5gKVxuICAvLyBtYXJrcyBpdHNlbGYgc28gYWdlbnRzIGNhbiB0ZWxsIHRoZSBodW1hbiBhcGFydCBmcm9tIGFub3RoZXIgYWdlbnQgcmF0aGVyXG4gIC8vIHRoYW4gc2VlaW5nIGFuIGFub255bW91cyBjb3VudCBidW1wLlxuICBodW1hbj86IGJvb2xlYW47XG4gIC8vIFYxLjcg4oCUIGEgbHVyayBjb25uZWN0aW9uICh0aGUgd2F0Y2ggaW4gbHVyayBtb2RlLCBvciBgdGFpbCAtLWx1cmtgKSBzdGlsbFxuICAvLyByZWNlaXZlcyBsaXZlIG1lc3NhZ2VzIGJ1dCBpcyAqKmV4Y2x1ZGVkIGZyb20gZXZlcnkgcHJlc2VuY2UgY291bnQqKiDigJQgaXRcbiAgLy8gYnVtcHMgbm90aGluZywgc28gYnJvd3NpbmcgYSBjaGFubmVsIGlzIGdlbnVpbmVseSBpbnZpc2libGUgdG8gYWdlbnRzLlxuICBsdXJrPzogYm9vbGVhbjtcbiAgc2VuZDogKG06IE1lc3NhZ2UpID0+IHZvaWQ7XG59O1xuXG50eXBlIFBlbmRpbmdXYWl0ID0ge1xuICBzaW5jZTogbnVtYmVyO1xuICByZXNvbHZlOiAobXNnczogTWVzc2FnZVtdKSA9PiB2b2lkO1xufTtcblxudHlwZSBDaGFubmVsID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIGNyZWF0ZWRfYXQ6IG51bWJlcjtcbiAgbmV4dF9pZDogbnVtYmVyO1xuICBzdWJzY3JpYmVyczogTWFwPHN5bWJvbCwgU3Vic2NyaWJlcj47XG4gIHdhaXRzOiBTZXQ8UGVuZGluZ1dhaXQ+O1xuICBsYXN0X2FjdGl2aXR5OiBudW1iZXI7XG4gIHRvcGljOiBzdHJpbmcgfCBudWxsOyAvLyBsYXRlc3Qga2luZDpcInRvcGljXCIgbWVzc2FnZSB0ZXh0OyBudWxsIGlmIG5ldmVyIHNldC5cbiAgLy8gVjEuNyDigJQgYXJjaGl2ZWQgY2hhbm5lbHMgYXJlIHJlYWQtb25seTogaGlzdG9yeSBzdGF5cyByZWFkYWJsZSwgYnV0IHNlbmRzXG4gIC8vIGFyZSByZWplY3RlZCBhbmQgdGhlIG5hbWUgaXMgbG9ja2VkIGZyb20gcmUtb3Blbi4gUGVyc2lzdGVkIGFzIGEgc2lkZWNhclxuICAvLyBtYXJrZXIgZmlsZSAoc2VlIGFyY2hpdmVkUGF0aCkgc28gaXQgc3Vydml2ZXMgYSBkYWVtb24gcmVzdGFydC5cbiAgYXJjaGl2ZWQ6IGJvb2xlYW47XG59O1xuXG5jb25zdCBjaGFubmVscyA9IG5ldyBNYXA8c3RyaW5nLCBDaGFubmVsPigpO1xuXG5mdW5jdGlvbiBlbnN1cmVEaXJzKCkge1xuICBta2RpclN5bmMoQ0hBTk5FTFNfRElSLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbn1cblxuZnVuY3Rpb24gY2hhbm5lbFBhdGgobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgLy8gRGVmZW5zaXZlOiBhbGxvdyBbYS16QS1aMC05Xy4tXSBpbiB0aGUgbWlkZGxlLCBhbHBoYW51bWVyaWMvdW5kZXJzY29yZS9cbiAgLy8gaHlwaGVuIGF0IHRoZSBlbmRzLiBSZWplY3QgbGVhZGluZy90cmFpbGluZyBkb3RzIChoaWRkZW4gZmlsZXMsXG4gIC8vIHRyYWlsaW5nLWRvdCBvZGRpdGllcykgYW5kIGNvbnNlY3V0aXZlIGRvdHMgKHBhdGggdHJhdmVyc2FsIOKAlCBgLi5gLFxuICAvLyBgZm9vLi5iYXJgKS4gSW50ZXJuYWwgZG90cyBhcmUgYWxsb3dlZCBzbyB2ZXJzaW9uLW51bWJlcmVkIGNoYW5uZWxcbiAgLy8gbmFtZXMgbGlrZSBgZ3JhcGV2aW5lLXYxLjdgIHdvcmsgbmF0dXJhbGx5LlxuICBjb25zdCBWQUxJRCA9IC9eW2EtekEtWjAtOV8tXShbYS16QS1aMC05Xy4tXXswLDYyfVthLXpBLVowLTlfLV0pPyQvO1xuICBpZiAoIVZBTElELnRlc3QobmFtZSkgfHwgbmFtZS5pbmNsdWRlcyhcIi4uXCIpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBpbnZhbGlkIGNoYW5uZWwgbmFtZTogJHtKU09OLnN0cmluZ2lmeShuYW1lKX1gKTtcbiAgfVxuICByZXR1cm4gam9pbihDSEFOTkVMU19ESVIsIGAke25hbWV9Lmpzb25sYCk7XG59XG5cbi8vIFNpZGVjYXIgbWFya2VyIGZvciB0aGUgYXJjaGl2ZWQgKHJlYWQtb25seSkgc3RhdGUuIEl0cyBtZXJlIGV4aXN0ZW5jZSBtZWFuc1xuLy8gYXJjaGl2ZWQg4oCUIGNvbnRlbnQgaXMgaXJyZWxldmFudC4gVmFsaWRhdGVkIHZpYSBjaGFubmVsUGF0aCBmaXJzdC5cbmZ1bmN0aW9uIGFyY2hpdmVkUGF0aChuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjaGFubmVsUGF0aChuYW1lKTsgLy8gcmV1c2UgbmFtZSB2YWxpZGF0aW9uICh0aHJvd3Mgb24gaW52YWxpZClcbiAgcmV0dXJuIGpvaW4oQ0hBTk5FTFNfRElSLCBgJHtuYW1lfS5hcmNoaXZlZGApO1xufVxuXG4vLyBTbmFwc2hvdCBhIGNoYW5uZWwncyBsb2cgdG8gdGhlIGFyY2hpdmUgZGlyLCB0aGVuIGNsZWFyIHRoZSBsaXZlIGxvZy4gUmV0dXJuc1xuLy8gdGhlIHNuYXBzaG90IHBhdGgsIG9yIG51bGwgaWYgdGhlcmUgd2FzIG5vdGhpbmcgdG8gc25hcHNob3QuIE5vIHN1YnNjcmliZXJcbi8vIGd1YXJkIGhlcmUg4oCUIGNhbGxlcnMgKHJlc2V0IC8gb3BlbiAtLWZyZXNoKSBhcHBseSB0aGVpciBvd24uXG5mdW5jdGlvbiBzbmFwc2hvdEFuZENsZWFyKG5hbWU6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBwID0gY2hhbm5lbFBhdGgobmFtZSk7IC8vIHZhbGlkYXRlcyB0aGUgbmFtZVxuICBsZXQgc25hcHNob3Q6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBpZiAoZXhpc3RzU3luYyhwKSkge1xuICAgIG1rZGlyU3luYyhBUkNISVZFX0RJUiwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgc25hcHNob3QgPSBqb2luKEFSQ0hJVkVfRElSLCBgJHtuYW1lfS0ke0RhdGUubm93KCl9Lmpzb25sYCk7XG4gICAgY29weUZpbGVTeW5jKHAsIHNuYXBzaG90KTtcbiAgICB3cml0ZUZpbGVTeW5jKHAsIFwiXCIpO1xuICB9XG4gIGNvbnN0IGNoID0gY2hhbm5lbHMuZ2V0KG5hbWUpO1xuICBpZiAoY2gpIHtcbiAgICBjaC5uZXh0X2lkID0gMTtcbiAgICBjaC50b3BpYyA9IG51bGw7XG4gICAgY2gubGFzdF9hY3Rpdml0eSA9IERhdGUubm93KCk7XG4gIH1cbiAgcmV0dXJuIHNuYXBzaG90O1xufVxuXG4vLyBWMi4yIOKAlCBhIGNyZWF0aW5nIGFjdCB3cml0ZXMgdGhlIGNoYW5uZWwgZG93bi4gQmVmb3JlIHRoaXMsIGBvcGVuYCB3aXRoIG5vXG4vLyBgLS10b3BpY2AgYXBwZW5kZWQgbm90aGluZywgc28gdGhlIGNoYW5uZWwgbGl2ZWQgb25seSBpbiB0aGUgZGFlbW9uJ3MgbWFwOlxuLy8gYHJlc3RhcnRgIChhIERPQ1VNRU5URUQgaGVhbGluZyBhY3Rpb24pIGRyb3BwZWQgaXQsIGFuZCBvbmNlIHJlYWRzIHN0b3BwZWRcbi8vIHJlc3VycmVjdGluZyBtaXNzaW5nIGNoYW5uZWxzLCBhIHdyYXBwZXIgdGhhdCBoYWQgY29ycmVjdGx5IG9wZW5lZCBmaXJzdFxuLy8gc3RpbGwgYnJva2UuIFwiT25seSBpbnRlbnQgY3JlYXRlc1wiIGNhbm5vdCByZXN0IG9uIGEgcmVjb3JkIHRoYXQgZG9lcyBub3Rcbi8vIG91dGxpdmUgdGhlIHByb2Nlc3MgaG9sZGluZyBpdC5cbi8vXG4vLyBBbiBFTVBUWSBgLmpzb25sYCwgbm90IGEgaGVhZGVyIHJlY29yZDogdGhpcyBmaWxlIGlzIGEgbWVzc2FnZSBsb2cgYW5kIGV2ZXJ5XG4vLyBjb25zdW1lciBwYXJzZXMgaXRzIGxpbmVzIGFzIG1lc3NhZ2VzIOKAlCBpbmNsdWRpbmcgYGdyZXBgLCB3aGljaCByZWFkcyBpdCBvZmZcbi8vIGRpc2sgd2l0aG91dCB0aGUgZGFlbW9uLCBhbmQgdGhlIGNvdW50LCB3aGljaCBjb3VudHMgbm9uLWVtcHR5IGxpbmVzLiBBXG4vLyBtZXRhZGF0YSBmaXJzdCBsaW5lIHdvdWxkIGhhdmUgdG8gYmUgdGF1Z2h0IHRvIGVhY2ggb2YgdGhlbSBhbmQgd291bGQgbWFrZSBhblxuLy8gZW1wdHkgY2hhbm5lbCByZXBvcnQgb25lIG1lc3NhZ2UuIFRoZSBmaWxlJ3MgZXhpc3RlbmNlIGlzIHRoZSByZWNvcmQgb2Zcbi8vIGV4aXN0ZW5jZTsgaXRzIGJpcnRoIHRpbWUgaXMgdGhlIGNyZWF0aW9uIHRpbWU7IGFuZCBhIG51bGwgdG9waWMgaXMgZXhhY3RseVxuLy8gd2hhdCBcIm5vIHRvcGljIGZyYW1lIHlldFwiIGFscmVhZHkgbWVhbnMuIFRydW5jYXRpb24gdG8gemVybyBieXRlcyBpcyBhbHNvXG4vLyBhbHJlYWR5IGEgc3VwcG9ydGVkIHN0YXRlIOKAlCB0aGF0IGlzIHdoYXQgY2xlYXJpbmcgYSBjaGFubmVsIGxlYXZlcyBiZWhpbmQuXG5mdW5jdGlvbiBwZXJzaXN0Q2hhbm5lbChuYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgcCA9IGNoYW5uZWxQYXRoKG5hbWUpOyAvLyB2YWxpZGF0ZXMgdGhlIG5hbWVcbiAgaWYgKCFleGlzdHNTeW5jKHApKSB3cml0ZUZpbGVTeW5jKHAsIFwiXCIpO1xuICAvLyDimqAgQWxpZ24gdGhlIGluLW1lbW9yeSByZWNvcmQgdG8gdGhlIGZpbGUgaXQgbm93IGhhcy4gYGxvYWRDaGFubmVsYCBzdGFtcHNcbiAgLy8gYERhdGUubm93KClgIGZvciBhIGNoYW5uZWwgd2l0aCBub3RoaW5nIHRvIHJlYWQgYSBgdHNgIGZyb20sIGFuZCB0aGlzIHdyaXRlXG4gIC8vIGhhcHBlbnMgYSBtb21lbnQgbGF0ZXIg4oCUIHNvIG1lbW9yeSBhbmQgZGlzayBob2xkIHR3byByZWFkaW5ncyBvZiB0aGUgc2FtZVxuICAvLyBpbnN0YW50LCBhbmQgYGNyZWF0ZWRfYXRgIENIQU5HRUQgYWNyb3NzIGEgcmVzdGFydCBldmVuIHRob3VnaCB0aGUgY2hhbm5lbFxuICAvLyBoYWQgbm90LiBUaGUgZmlsZSBpcyB0aGUgcmVjb3JkOyBtYWtlIGl0IHRoZSBhZ2UgdG9vLiBHdWFyZGVkIG9uIGFuIGVtcHR5XG4gIC8vIGxvZzogb25jZSBhIG1lc3NhZ2UgZXhpc3RzLCBpdHMgYHRzYCBpcyB0aGUgYmV0dGVyIGFuc3dlciBhbmQgbXVzdCBzdGFuZC5cbiAgY29uc3QgY2ggPSBjaGFubmVscy5nZXQobmFtZSk7XG4gIGlmIChjaCAmJiBjaC5uZXh0X2lkID09PSAxKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHN0ID0gc3RhdFN5bmMocCk7XG4gICAgICBjaC5jcmVhdGVkX2F0ID0gc3QuYmlydGh0aW1lTXMgfHwgc3QubXRpbWVNcztcbiAgICB9IGNhdGNoIHt9XG4gIH1cbn1cblxuZnVuY3Rpb24gbG9hZENoYW5uZWwobmFtZTogc3RyaW5nKTogQ2hhbm5lbCB7XG4gIGNvbnN0IGV4aXN0aW5nID0gY2hhbm5lbHMuZ2V0KG5hbWUpO1xuICBpZiAoZXhpc3RpbmcpIHJldHVybiBleGlzdGluZztcbiAgY29uc3QgcGF0aCA9IGNoYW5uZWxQYXRoKG5hbWUpO1xuICBsZXQgbmV4dF9pZCA9IDE7XG4gIGxldCBjcmVhdGVkX2F0ID0gRGF0ZS5ub3coKTtcbiAgbGV0IHRvcGljOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgaWYgKGV4aXN0c1N5bmMocGF0aCkpIHtcbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBsaW5lcyA9IHJhdy5zcGxpdChcIlxcblwiKS5maWx0ZXIoKGwpID0+IGwudHJpbSgpKTtcbiAgICBsZXQgc2F3UGFyc2VhYmxlTGluZSA9IGZhbHNlO1xuICAgIGlmIChsaW5lcy5sZW5ndGgpIHtcbiAgICAgIC8vIGIxMSDigJQgdGhpcyBibG9jayB1c2VkIHRvIHJlYWQgdGhlIEZJUlNUIGxpbmUgZm9yIGNyZWF0ZWRfYXQgYW5kIHRoZVxuICAgICAgLy8gTEFTVCBsaW5lIGZvciBuZXh0X2lkLCBlYWNoIGluIGEgYHRyeWAgd2l0aCBhbiBFTVBUWSBDQVRDSC4gQSBmaW5hbFxuICAgICAgLy8gbGluZSB0cnVuY2F0ZWQgbWlkLUpTT04g4oCUIGEgY3Jhc2ggb3Iga2lsbCBkdXJpbmcgYXBwZW5kRmlsZVN5bmMg4oCUIHRocmV3LFxuICAgICAgLy8gYW5kIGBuZXh0X2lkYCB3YXMgbGVmdCBhdCBpdHMgaW5pdGlhbGlzZWQgMS4gTWVhc3VyZWQgY29uc2VxdWVuY2VzLCBhbGxcbiAgICAgIC8vIGF0IG9rOnRydWU6IHRoZSBuZXh0IG1lc3NhZ2Ugd2FzIGFzc2lnbmVkIGFuIEFMUkVBRFktVVNFRCBpZCwgc28gZXZlcnlcbiAgICAgIC8vIC0tc2luY2UgY3Vyc29yIGFuZCB0YWlsIHJlc3VtZSBmb3IgdGhhdCBjaGFubmVsIHdhcyB3cm9uZzsgYW5kIGJlY2F1c2VcbiAgICAgIC8vIHRoZSB0cnVuY2F0ZWQgbGluZSBoYWQgbm8gdGVybWluYXRpbmcgbmV3bGluZSwgdGhlIGFwcGVuZCBGVVNFRCBvbnRvIGl0XG4gICAgICAvLyBhbmQgdGhlIG1lc3NhZ2UgYmVjYW1lIHBlcm1hbmVudGx5IHVucmVhZGFibGUuXG4gICAgICAvL1xuICAgICAgLy8gQW4gZW1wdHkgY2F0Y2ggY29udmVydHMgXCJJIGNvdWxkIG5vdCBjb21wdXRlIHRoaXNcIiBpbnRvIFwiaGVyZSBpcyB0aGVcbiAgICAgIC8vIGluaXRpYWwgdmFsdWVcIiwgYW5kIG5vdGhpbmcgZG93bnN0cmVhbSBjYW4gdGVsbCB3aGljaCBoYXBwZW5lZC4gVGhlXG4gICAgICAvLyByZXBhaXIgaXMgdG8gZGVyaXZlIG5leHRfaWQgZnJvbSBFVkVSWSBwYXJzZWFibGUgbGluZSByYXRoZXIgdGhhbiBmcm9tXG4gICAgICAvLyBvbmUgbGluZSB0aGF0IG1pZ2h0IGJlIHRoZSBicm9rZW4gb25lLlxuICAgICAgLy9cbiAgICAgIC8vIEhJR0gtV0FURVIgTUFSSywgbm90IGxhc3QtaWQ6IGlkcyBhcmUgZXhwZWN0ZWQgdG8gYXNjZW5kLCBidXQgYSBjb3JydXB0XG4gICAgICAvLyBsaW5lIGFueXdoZXJlIG11c3Qgbm90IGxvd2VyIHRoZSBtYXJrLiBgbGluZXMubGVuZ3RoYCBpcyBmb2xkZWQgaW4gc28gYVxuICAgICAgLy8gZmlsZSB3aG9zZSBsaW5lcyBOT05FIHBhcnNlIHN0aWxsIGFkdmFuY2VzIHBhc3QgdGhlIG51bWJlciBvZiByZWNvcmRzXG4gICAgICAvLyBwcmVzZW50IGluc3RlYWQgb2YgcmVzdGFydGluZyBhdCAxIOKAlCBvdmVyLXJlcG9ydCwgbmV2ZXIgdW5kZXItcmVwb3J0LFxuICAgICAgLy8gYmVjYXVzZSB1bmRlci1yZXBvcnRpbmcgaGVyZSBpcyB3aGF0IHJldXNlcyBhbiBpZC5cbiAgICAgIGxldCBtYXhJZCA9IDA7XG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGxldCBtOiBNZXNzYWdlO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIG0gPSBKU09OLnBhcnNlKGxpbmVzW2ldKSBhcyBNZXNzYWdlO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICBjb250aW51ZTsgLy8gYSBjb3JydXB0IGxpbmUgaXMgc2tpcHBlZCBmb3IgUkVDT1ZFUlksIG5ldmVyIGZvciBDT1VOVElOR1xuICAgICAgICB9XG4gICAgICAgIGlmICghc2F3UGFyc2VhYmxlTGluZSAmJiB0eXBlb2YgbS50cyA9PT0gXCJudW1iZXJcIikge1xuICAgICAgICAgIGNyZWF0ZWRfYXQgPSBtLnRzO1xuICAgICAgICAgIHNhd1BhcnNlYWJsZUxpbmUgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICh0eXBlb2YgbS5pZCA9PT0gXCJudW1iZXJcIiAmJiBtLmlkID4gbWF4SWQpIG1heElkID0gbS5pZDtcbiAgICAgICAgLy8gTGF0ZXN0IHRvcGljIHdpbnM7IHRoaXMgd2Fsa3MgZm9yd2FyZCwgc28gdGhlIGxhc3Qgb25lIGFzc2lnbmVkIHN0YW5kcy5cbiAgICAgICAgaWYgKG0ua2luZCA9PT0gXCJ0b3BpY1wiKSB0b3BpYyA9IG0udGV4dDtcbiAgICAgIH1cbiAgICAgIG5leHRfaWQgPSBNYXRoLm1heChtYXhJZCwgbGluZXMubGVuZ3RoKSArIDE7XG4gICAgfVxuICAgIGlmICghc2F3UGFyc2VhYmxlTGluZSkge1xuICAgICAgLy8gQW4gRU1QVFkgbG9nIGlzIGEgcmVhbCBzdGF0ZSwgbm90IGEgbWlzc2luZyBvbmU6IGBvcGVuYCBjcmVhdGVzIHRoZVxuICAgICAgLy8gZmlsZSAoVjIuMiksIGFuZCBjbGVhcmluZyBhIGNoYW5uZWwgdHJ1bmNhdGVzIGl0IHRvIHplcm8gYnl0ZXMuIFdpdGggbm9cbiAgICAgIC8vIGxpbmUgdG8gcmVhZCBhIGB0c2AgZnJvbSwgYERhdGUubm93KClgIHdvdWxkIG1ha2UgdGhlIGNoYW5uZWwncyBhZ2VcbiAgICAgIC8vIHJlc3RhcnQgb24gZXZlcnkgZGFlbW9uIGJvb3Qg4oCUIHRoZSBzYW1lIGRyaWZ0IHRoZSBmaWxlIHdhcyB3cml0dGVuIHRvXG4gICAgICAvLyBzdG9wLiBUaGUgZmlsZSdzIG93biBiaXJ0aCBpcyB0aGUgaG9uZXN0IGFuc3dlcjsgbXRpbWUgYmFja3MgaXQgdXAgb25cbiAgICAgIC8vIGZpbGVzeXN0ZW1zIHRoYXQgZG8gbm90IHJlY29yZCBvbmUuXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBzdCA9IHN0YXRTeW5jKHBhdGgpO1xuICAgICAgICBjcmVhdGVkX2F0ID0gc3QuYmlydGh0aW1lTXMgfHwgc3QubXRpbWVNcztcbiAgICAgIH0gY2F0Y2gge31cbiAgICB9XG4gIH1cbiAgY29uc3QgY2g6IENoYW5uZWwgPSB7XG4gICAgbmFtZSxcbiAgICBjcmVhdGVkX2F0LFxuICAgIG5leHRfaWQsXG4gICAgc3Vic2NyaWJlcnM6IG5ldyBNYXAoKSxcbiAgICB3YWl0czogbmV3IFNldCgpLFxuICAgIGxhc3RfYWN0aXZpdHk6IERhdGUubm93KCksXG4gICAgdG9waWMsXG4gICAgYXJjaGl2ZWQ6IGV4aXN0c1N5bmMoYXJjaGl2ZWRQYXRoKG5hbWUpKSxcbiAgfTtcbiAgY2hhbm5lbHMuc2V0KG5hbWUsIGNoKTtcbiAgcmV0dXJuIGNoO1xufVxuXG4vLyBiNSDigJQgYW4gVU5MT0FERUQgY2hhbm5lbCByZXBvcnRlZCBgbWVzc2FnZV9jb3VudDogMGAsIHdoaWNoIGlzXG4vLyBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgY2hhbm5lbCB0aGF0IGdlbnVpbmVseSBob2xkcyBub3RoaW5nLiBNZWFzdXJlZDogNTcgb2Zcbi8vIDU3IGNoYW5uZWxzIHJlYWQgMCBhZnRlciBhIHJvbGwuIFRoYXQgemVybyBmZWVkcyBhIGphbml0b3IgY2hvb3NpbmcgYmV0d2VlblxuLy8gYGFyY2hpdmVgIChwcmVzZXJ2ZXMpIGFuZCBgY2xvc2VgIChERUxFVEVTIHRoZSBsb2cpLCBzbyB0aGUgd3JvbmcgcmVhZGluZyBpc1xuLy8gdGhlIGRlc3RydWN0aXZlIG9uZS5cbi8vXG4vLyBQT1JURUQgZnJvbSBib3VudHkncyBgc25hcHNob3RUYXNrQ291bnQoKWAgcmF0aGVyIHRoYW4gcmUtZGVyaXZlZCBhIGZpZnRoXG4vLyB0aW1lOiBgbnVtYmVyIHwgbnVsbGAsIHdoZXJlIG51bGwgbWVhbnMgXCJJIGNvdWxkIG5vdCBjb3VudFwiIGFuZCBpcyBuZXZlclxuLy8gc3BlbGxlZCAwLlxuLy9cbi8vIFRoZSBjb3N0IG9iamVjdGlvbiBpcyBNRUFTVVJFRCwgbm90IGFzc3VtZWQ6IGNvdW50aW5nIGV2ZXJ5IG9uZSBvZiB0aGUgNjEgcmVhbFxuLy8gY2hhbm5lbHMgKDMsOTA1IG1lc3NhZ2VzLCA3LjcgTUIpIHRha2VzIDE2LTQ1IG1zLCBuPTMg4oCUIGFuZCBgbG9hZENoYW5uZWxgXG4vLyBhbHJlYWR5IHJlYWRzIGVhY2ggZmlsZSBJTiBGVUxMIHRvIHJlY292ZXIgY3JlYXRlZF9hdC9uZXh0X2lkL3RvcGljLCBzbyB0aGlzXG4vLyBpcyBhIHJlYWQgdGhlIGRhZW1vbiB3YXMgZG9pbmcgYW55d2F5IG9uIHRoZSBwYXRoIHRoYXQgbWF0dGVycy5cbi8vXG4vLyDimqAgTk9OLUVNUFRZIGxpbmVzLCBkZWxpYmVyYXRlbHkgTk9UIHBhcnNlYWJsZS1vbmx5LiBUaGlzIGNvdW50IGZlZWRzIGFcbi8vIGRlbGV0ZS1vci1rZWVwIGRlY2lzaW9uLCBzbyBpdCBtdXN0IE9WRVItcmVwb3J0IGNvbnRlbnQgYW5kIG5ldmVyIFVOREVSLXJlcG9ydFxuLy8gaXQg4oCUIGEgY29ycnVwdCBsaW5lIGlzIHN0aWxsIHNvbWV0aGluZyBzb21lYm9keSB3cm90ZS4gVW5kZXItcmVwb3J0aW5nIGhlcmUgaXNcbi8vIHdoYXQgZGVsZXRlcyBhIGNoYW5uZWwuXG5mdW5jdGlvbiBjaGFubmVsTWVzc2FnZUNvdW50KHBhdGg6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuICB0cnkge1xuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0Zi04XCIpO1xuICAgIGxldCBuID0gMDtcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgcmF3LnNwbGl0KFwiXFxuXCIpKSBpZiAobGluZS50cmltKCkpIG4rKztcbiAgICByZXR1cm4gbjtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuZnVuY3Rpb24gbGlzdENoYW5uZWxzKCkge1xuICAvLyBJbmNsdWRlIGNoYW5uZWxzIG9uIGRpc2sgdGhhdCB3ZSBoYXZlbid0IGxvYWRlZCB5ZXQuXG4gIGNvbnN0IG9uRGlzayA9IHJlYWRkaXJTeW5jKENIQU5ORUxTX0RJUilcbiAgICAuZmlsdGVyKChmKSA9PiBmLmVuZHNXaXRoKFwiLmpzb25sXCIpKVxuICAgIC5tYXAoKGYpID0+IGYuc2xpY2UoMCwgLVwiLmpzb25sXCIubGVuZ3RoKSk7XG4gIGNvbnN0IG1lcmdlZCA9IG5ldyBTZXQoWy4uLmNoYW5uZWxzLmtleXMoKSwgLi4ub25EaXNrXSk7XG4gIHJldHVybiBBcnJheS5mcm9tKG1lcmdlZClcbiAgICAuc29ydCgpXG4gICAgLm1hcCgobmFtZSkgPT4ge1xuICAgICAgY29uc3QgY2ggPSBjaGFubmVscy5nZXQobmFtZSk7XG4gICAgICBsZXQgbGFzdF9hY3Rpdml0eSA9IDA7XG4gICAgICAvLyBudWxsLCBub3QgMCDigJQgc2VlIGNoYW5uZWxNZXNzYWdlQ291bnQuIEEgY291bnQgaXMgb25seSBldmVyIGEgbnVtYmVyXG4gICAgICAvLyB3aGVuIHRoaXMgZGFlbW9uIGFjdHVhbGx5IGVzdGFibGlzaGVkIG9uZS5cbiAgICAgIGxldCBtZXNzYWdlX2NvdW50OiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgICAgIGlmIChjaCkge1xuICAgICAgICBsYXN0X2FjdGl2aXR5ID0gY2gubGFzdF9hY3Rpdml0eTtcbiAgICAgICAgLy8gVGhpcyBpcyB0aGUgaGlnaC13YXRlciBpZCwgd2hpY2ggZXF1YWxzIHRoZSBjb3VudCBmb3IgYSBjaGFubmVsIHdob3NlXG4gICAgICAgIC8vIGlkcyBhcmUgY29udGlndW91cyBmcm9tIDEg4oCUIHRoZSBub3JtYWwgY2FzZS4gSXQgbm8gbG9uZ2VyIGNvbGxhcHNlcyB0b1xuICAgICAgICAvLyAwIG9uIGEgdHJ1bmNhdGVkIGZpbmFsIGxpbmU6IGIxMSBtYWRlIG5leHRfaWQgYSBoaWdoLXdhdGVyIG1hcmsgb3ZlclxuICAgICAgICAvLyBldmVyeSBwYXJzZWFibGUgbGluZSwgc28gYSBjb3JydXB0IHRhaWwgY2FuIG5vIGxvbmdlciByZXN0YXJ0IGl0IGF0IDEuXG4gICAgICAgIG1lc3NhZ2VfY291bnQgPSBjaC5uZXh0X2lkIC0gMTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFN0YXQgZGlzayBmaWxlIGZvciBsYXN0X2FjdGl2aXR5OyB0aGUgY291bnQgaXMgYSByZWFsIHJlYWQuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgcyA9IHN0YXRTeW5jKGNoYW5uZWxQYXRoKG5hbWUpKTtcbiAgICAgICAgICBsYXN0X2FjdGl2aXR5ID0gcy5tdGltZU1zO1xuICAgICAgICB9IGNhdGNoIHt9XG4gICAgICAgIG1lc3NhZ2VfY291bnQgPSBjaGFubmVsTWVzc2FnZUNvdW50KGNoYW5uZWxQYXRoKG5hbWUpKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7XG4gICAgICAgIG5hbWUsXG4gICAgICAgIC8vIEV4Y2x1ZGUgbHVya2VycyDigJQgdGhlIGxlZnQtcmFpbCBjb3VudCBtdXN0IG1hdGNoIGB3aG9gJ3MgcHJlc2VuY2UsXG4gICAgICAgIC8vIG9yIGEgbHVya2luZyB3YXRjaCB0YWIgbWFrZXMgdGhlIGJhZGdlIHRpY2sgdXAgd2hpbGUgd2hvIHNob3dzIG5vIG9uZS5cbiAgICAgICAgc3Vic2NyaWJlcnM6IGNoID8gdmlzaWJsZVN1YnMoY2gpLmxlbmd0aCA6IDAsXG4gICAgICAgIG1lc3NhZ2VfY291bnQsXG4gICAgICAgIGxhc3RfYWN0aXZpdHksXG4gICAgICAgIGxvYWRlZDogISFjaCxcbiAgICAgICAgYXJjaGl2ZWQ6IGV4aXN0c1N5bmMoYXJjaGl2ZWRQYXRoKG5hbWUpKSxcbiAgICAgIH07XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIGFwcGVuZE1lc3NhZ2UoXG4gIG5hbWU6IHN0cmluZyxcbiAgZnJvbTogc3RyaW5nLFxuICB0ZXh0OiBzdHJpbmcsXG4gIGtpbmQ6IE1lc3NhZ2VbXCJraW5kXCJdID0gXCJtZXNzYWdlXCIsXG4gIGluUmVwbHlUbz86IG51bWJlcixcbiAgZXh0cmE/OiBQYXJ0aWFsPFBpY2s8TWVzc2FnZSwgXCJ0YXJnZXRcIiB8IFwiZGlzcG9zaXRpb25cIiB8IFwiZXZlbnRcIj4+LFxuKTogTWVzc2FnZSB7XG4gIGNvbnN0IGNoID0gbG9hZENoYW5uZWwobmFtZSk7XG4gIGNvbnN0IG1zZzogTWVzc2FnZSA9IHtcbiAgICBpZDogY2gubmV4dF9pZCsrLFxuICAgIGNoYW5uZWw6IG5hbWUsXG4gICAgZnJvbSxcbiAgICB0ZXh0LFxuICAgIHRzOiBEYXRlLm5vdygpLFxuICAgIGtpbmQsXG4gICAgLi4uKHR5cGVvZiBpblJlcGx5VG8gPT09IFwibnVtYmVyXCIgPyB7IGluX3JlcGx5X3RvOiBpblJlcGx5VG8gfSA6IHt9KSxcbiAgICAuLi4oZXh0cmEgPz8ge30pLFxuICB9O1xuICAvLyBiMTEg4oCUIHRoZSBzZWNvbmQgaGFsZiBvZiB0aGUgZGVzdHJveWVkLXdyaXRlIGRlZmVjdC4gQSBKU09OTCByZWNvcmQgaXMgb25seVxuICAvLyBhIHJlY29yZCBiZWNhdXNlIGEgbmV3bGluZSB0ZXJtaW5hdGVzIGl0LCBhbmQgYSBwYXJ0aWFsIHdyaXRlIChjcmFzaCwga2lsbCxcbiAgLy8gZnVsbCBkaXNrKSBjYW4gbGVhdmUgYSBmaW5hbCBsaW5lIHdpdGhvdXQgb25lLiBBcHBlbmRpbmcgc3RyYWlnaHQgb250byB0aGF0XG4gIC8vIGZ1c2VzIHRoZSBuZXcgbWVzc2FnZSBpbnRvIHRoZSBicm9rZW4gZnJhZ21lbnQsIGFuZCBCT1RIIGJlY29tZSB1bnJlYWRhYmxlXG4gIC8vIOKAlCB0aGUgd3JpdGUgaXMgZGVzdHJveWVkIGFuZCB0aGlzIGZ1bmN0aW9uIHN0aWxsIHJldHVybnMgYSBNZXNzYWdlIGFuZFxuICAvLyBhbnN3ZXJzIG9rOnRydWUuXG4gIC8vXG4gIC8vIFNvIHRlcm1pbmF0ZSB0aGUgcHJldmlvdXMgcmVjb3JkIGJlZm9yZSB3cml0aW5nIGEgbmV3IG9uZS4gVGhpcyByZXBhaXJzIHRoZVxuICAvLyBmaWxlIHJhdGhlciB0aGFuIHJlZnVzaW5nOiB0aGUgdHJ1bmNhdGVkIGZyYWdtZW50IHN0YXlzIG9uIGl0cyBvd24gbGluZVxuICAvLyB3aGVyZSBhIGh1bWFuIG9yIGEgcmVjb3ZlcnkgcGFzcyBjYW4gc2VlIGl0LCBhbmQgaXQgc3RvcHMgZWF0aW5nIHdyaXRlc1xuICAvLyBpbW1lZGlhdGVseS4gT25seSByZWFjaGFibGUgd2hlbiB0aGUgZmlsZSBkb2VzIE5PVCBhbHJlYWR5IGVuZCBpbiBhXG4gIC8vIG5ld2xpbmUsIHNvIHRoZSBoZWFsdGh5IHBhdGggaXMgYnl0ZS1pZGVudGljYWwgdG8gYmVmb3JlLlxuICBjb25zdCBwID0gY2hhbm5lbFBhdGgobmFtZSk7XG4gIGxldCBzZXBhcmF0b3IgPSBcIlwiO1xuICB0cnkge1xuICAgIGNvbnN0IHNpemUgPSBzdGF0U3luYyhwKS5zaXplO1xuICAgIGlmIChzaXplID4gMCkge1xuICAgICAgY29uc3QgZmQgPSBvcGVuU3luYyhwLCBcInJcIik7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCB0YWlsQnl0ZSA9IEJ1ZmZlci5hbGxvYygxKTtcbiAgICAgICAgcmVhZFN5bmMoZmQsIHRhaWxCeXRlLCAwLCAxLCBzaXplIC0gMSk7XG4gICAgICAgIGlmICh0YWlsQnl0ZVswXSAhPT0gMHgwYSkgc2VwYXJhdG9yID0gXCJcXG5cIjtcbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIGNsb3NlU3luYyhmZCk7XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBUaGUgZmlsZSBpcyB1bnJlYWRhYmxlIG9yIGFic2VudDsgYXBwZW5kRmlsZVN5bmMgd2lsbCBjcmVhdGUgaXQuIExlYXZpbmdcbiAgICAvLyBzZXBhcmF0b3IgZW1wdHkgaXMgY29ycmVjdCBoZXJlIGFuZCBpcyBOT1QgYW4gZW1wdHktY2F0Y2ggb2YgdGhlIGtpbmQgYjExXG4gICAgLy8gZXhpc3RzIHRvIGtpbGwg4oCUIHRoZXJlIGlzIG5vIHZhbHVlIGJlaW5nIHNpbGVudGx5IGRlZmF1bHRlZCwgYW5kIHRoZVxuICAgIC8vIGhlYWx0aHkgcGF0aCBpcyBhIGZyZXNoIGZpbGUuXG4gIH1cbiAgYXBwZW5kRmlsZVN5bmMocCwgYCR7c2VwYXJhdG9yfSR7SlNPTi5zdHJpbmdpZnkobXNnKX1cXG5gKTtcbiAgaWYgKGtpbmQgPT09IFwidG9waWNcIikgY2gudG9waWMgPSB0ZXh0O1xuICBjaC5sYXN0X2FjdGl2aXR5ID0gbXNnLnRzO1xuICAvLyBGYW4gb3V0IHRvIGxpdmUgc3Vic2NyaWJlcnMuIEVycm9ycyBpbiBvbmUgc3Vic2NyaWJlciBtdXN0IG5vdCBicmVha1xuICAvLyBkZWxpdmVyeSB0byBvdGhlcnMuXG4gIGZvciAoY29uc3Qgc3ViIG9mIGNoLnN1YnNjcmliZXJzLnZhbHVlcygpKSB7XG4gICAgdHJ5IHtcbiAgICAgIHN1Yi5zZW5kKG1zZyk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS5lcnJvcihcInN1YnNjcmliZXIgZXJyb3I6XCIsIGUpO1xuICAgIH1cbiAgfVxuICAvLyBEcmFpbiBsb25nLXBvbGwgd2FpdGVyczogYW55b25lIHdob3NlIGBzaW5jZWAgPCBtc2cuaWQgaXMgbm93IHJlc29sdmFibGUuXG4gIC8vIFRoZXkgcmVjZWl2ZSBldmVyeSBtZXNzYWdlIHRoZXkgaGF2ZW4ndCBzZWVuIHlldCwgbm90IGp1c3QgdGhlIG5ldyBvbmUsXG4gIC8vIGluIGNhc2UgbXVsdGlwbGUgbWVzc2FnZXMgbGFuZGVkIGR1cmluZyB0aGUgc2FtZSB0aWNrLlxuICBmb3IgKGNvbnN0IHcgb2YgWy4uLmNoLndhaXRzXSkge1xuICAgIGlmIChtc2cuaWQgPiB3LnNpbmNlKSB7XG4gICAgICBjaC53YWl0cy5kZWxldGUodyk7XG4gICAgICB0cnkge1xuICAgICAgICB3LnJlc29sdmUocmVhZEJhY2tsb2cobmFtZSwgdy5zaW5jZSkpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwid2FpdCByZXNvbHZlIGVycm9yOlwiLCBlKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgcmV0dXJuIG1zZztcbn1cblxuLy8gQ29ubmVjdGlvbnMgdGhhdCBjb3VudCBhcyBwcmVzZW5jZSDigJQgZXZlcnl0aGluZyBleGNlcHQgbHVya2VycyAoVjEuNykuIEFcbi8vIGx1cmsgY29ubmVjdGlvbiByZWNlaXZlcyBtZXNzYWdlcyBidXQgaXMgaW52aXNpYmxlOiBleGNsdWRlZCBmcm9tIGV2ZXJ5XG4vLyBjb3VudCBhbmQgcm9zdGVyIGJlbG93LlxuZnVuY3Rpb24gdmlzaWJsZVN1YnMoY2g6IENoYW5uZWwpOiBTdWJzY3JpYmVyW10ge1xuICByZXR1cm4gQXJyYXkuZnJvbShjaC5zdWJzY3JpYmVycy52YWx1ZXMoKSkuZmlsdGVyKChzKSA9PiAhcy5sdXJrKTtcbn1cblxuLy8gVGhlIHJvc3RlciBpcyBhIHNldCBvZiBkaXN0aW5jdCBhbGlhc2VzIOKAlCBhIHNlYXQgd2l0aCBtdWx0aXBsZSBsaXZlXG4vLyBjb25uZWN0aW9ucyAoZS5nLiB0d28gdGFpbHMgdW5kZXIgb25lIGFsaWFzKSBhcHBlYXJzIG9uY2UuIFRoZSBjb25uZWN0aW9uXG4vLyAqY291bnRzKiAoYGNvbm5lY3Rpb25zYC9gbmFtZWRgKSBzdGF5IHBlci1jb25uZWN0aW9uOyBvbmx5IHRoZSBuYW1lIGxpc3Rcbi8vIGRlZHVwZXMuXG5mdW5jdGlvbiBzdWJzY3JpYmVyQWxpYXNlcyhuYW1lOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGNoID0gY2hhbm5lbHMuZ2V0KG5hbWUpO1xuICBpZiAoIWNoKSByZXR1cm4gW107XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBzdWIgb2YgdmlzaWJsZVN1YnMoY2gpKSB7XG4gICAgaWYgKHN1Yi5hbGlhcykgc2Vlbi5hZGQoc3ViLmFsaWFzKTtcbiAgfVxuICByZXR1cm4gQXJyYXkuZnJvbShzZWVuKS5zb3J0KCk7XG59XG5cbi8vIE5hbWVkIHN1YnNjcmliZXJzIGZsYWdnZWQgYXMgaHVtYW4gKFYxLjcpIOKAlCBhIHN1YnNldCBvZiBzdWJzY3JpYmVyQWxpYXNlcyxcbi8vIHNvIGNvbnN1bWVycyBjYW4gcmVuZGVyIGBjb2xlIChodW1hbilgIGFuZCBhZ2VudHMgY2FuIHRlbGwgd2hvIGlzIHRoZSBodW1hbi5cbi8vIERlZHVwZWQgYnkgYWxpYXMgZm9yIHRoZSBzYW1lIHJlYXNvbi5cbmZ1bmN0aW9uIHN1YnNjcmliZXJIdW1hbnMobmFtZTogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCBjaCA9IGNoYW5uZWxzLmdldChuYW1lKTtcbiAgaWYgKCFjaCkgcmV0dXJuIFtdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3Qgc3ViIG9mIHZpc2libGVTdWJzKGNoKSkge1xuICAgIGlmIChzdWIuYWxpYXMgJiYgc3ViLmh1bWFuKSBzZWVuLmFkZChzdWIuYWxpYXMpO1xuICB9XG4gIHJldHVybiBBcnJheS5mcm9tKHNlZW4pLnNvcnQoKTtcbn1cblxuZnVuY3Rpb24gcmVhZEJhY2tsb2cobmFtZTogc3RyaW5nLCBzaW5jZTogbnVtYmVyKTogTWVzc2FnZVtdIHtcbiAgY29uc3QgcGF0aCA9IGNoYW5uZWxQYXRoKG5hbWUpO1xuICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHJldHVybiBbXTtcbiAgY29uc3Qgb3V0OiBNZXNzYWdlW10gPSBbXTtcbiAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmLThcIik7XG4gIGZvciAoY29uc3QgbGluZSBvZiByYXcuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAoIWxpbmUudHJpbSgpKSBjb250aW51ZTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgbSA9IEpTT04ucGFyc2UobGluZSkgYXMgTWVzc2FnZTtcbiAgICAgIGlmIChtLmlkID4gc2luY2UpIG91dC5wdXNoKG0pO1xuICAgIH0gY2F0Y2gge31cbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vLyBEb2VzIHRoaXMgY2hhbm5lbCBleGlzdD8gQSBOT04tQ1JFQVRJTkcgbG9va3VwIOKAlCB0aGUgY291bnRlcnBhcnQgdG9cbi8vIGxvYWRDaGFubmVsLCB3aGljaCBidWlsZHMgYSByZWNvcmQgZm9yIGFueSBuYW1lIHlvdSBoYW5kIGl0IGFuZCByZWdpc3RlcnMgaXRcbi8vIGluIGBjaGFubmVsc2AsIHNvIGBsaXN0Q2hhbm5lbHMoKWAgKHdoaWNoIHVuaW9ucyB0aGUgbWFwIHdpdGggdGhlIC5qc29ubFxuLy8gZmlsZXMgb24gZGlzaykgcmVwb3J0cyBpdCBhcyBsaXZlLiBUaGF0IGlzIHRoZSByZXN1cnJlY3Rpb246IGEgcmVhZCB2ZXJiIG9uIGFcbi8vIGNoYW5uZWwgdGhlIGh1bWFuIGp1c3QgY2xvc2VkIHB1dCBpdCBiYWNrIGluIGBsaXN0YCB3aXRoIG5vIGZpbGUsIG5vIG1lc3NhZ2VzXG4vLyBhbmQgbm8gd2F5IGZvciB0aGUgcmVhZGVyIHRvIHRlbGwuXG4vL1xuLy8gXCJFeGlzdHNcIiBpcyBsb2FkZWQtaW4tbWVtb3J5IE9SIGEgbG9nIG9uIGRpc2ssIG1hdGNoaW5nIGV4YWN0bHkgd2hhdFxuLy8gYGxpc3RDaGFubmVscygpYCB3aWxsIHJlcG9ydC4gQW4gaW52YWxpZCBuYW1lIGlzIG5vdCBhbiBleGlzdGVuY2UgcXVlc3Rpb24g4oCUXG4vLyBpdCBjYW4gbmV2ZXIgYmUgb24gZGlzaywgc28gaXQgYW5zd2VycyBmYWxzZSBhbmQgdGhlIGNhbGxlciA0MDRzIHJhdGhlciB0aGFuXG4vLyB0aHJvd2luZyBhIDQwMCBvdXQgb2YgYSByZWFkLlxuZnVuY3Rpb24gY2hhbm5lbEV4aXN0cyhuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgaWYgKGNoYW5uZWxzLmhhcyhuYW1lKSkgcmV0dXJuIHRydWU7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGV4aXN0c1N5bmMoY2hhbm5lbFBhdGgobmFtZSkpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLy8gVGhlIHJlZnVzYWwgYSByZWFkIHJvdXRlIGdpdmVzIGZvciBhIGNoYW5uZWwgdGhhdCBpcyBub3QgdGhlcmUuIFNhbWUgZW52ZWxvcGVcbi8vIGFzIGV2ZXJ5IG90aGVyIGRhZW1vbiBlcnJvciAoeyBlcnJvciwgY2hhbm5lbCB9KSBwbHVzIGBoaW50YDogYSByZXNwb25zZVxuLy8gc2hvdWxkIG5hbWUgdGhlIGFjdCBpdCBtYWtlcyBsaWtlbHksIGFuZCB0aGUgb25seSBhY3QgdGhhdCByZWNvdmVycyBmcm9tIHRoaXNcbi8vIG9uZSBpcyBhbiBleHBsaWNpdCBvcGVuLiBXaXRob3V0IHRoZSBoaW50IHRoZSBhZ2VudCBpcyBsZWZ0IGd1ZXNzaW5nIHdoZXRoZXJcbi8vIHRoZSBuYW1lIGlzIHdyb25nLCB0aGUgZGFlbW9uIGlzIHdyb25nLCBvciB0aGUgY2hhbm5lbCBpcyBtZXJlbHkgZW1wdHkuXG4vL1xuLy8g4pqgIGBoaW50YCBJUyBBIFZFUkIgSU5WT0NBVElPTiDigJQgdGhlIGFyZ3VtZW50cyB0byB0aGUgQ0xJIOKAlCBOT1QgYSBzaGVsbFxuLy8gY29tbWFuZC4gSXQgcmVhZCBgZ3JhcGV2aW5lIG9wZW4gPG5hbWU+YCwgd2hpY2ggbG9va3MgcGFzdGVhYmxlIGFuZCBpcyBub3Q6XG4vLyBub3RoaW5nIGluc3RhbGxzIGEgYGdyYXBldmluZWAgYmluYXJ5IG9uIFBBVEgsIGFuZCBTS0lMTC5tZCdzIG93biBjYW5vbmljYWxcbi8vIGZvcm0gaXMgYGJ1biDigKYvY2xpLnRzIG9wZW4gPG5hbWU+YC4gVGhlIGRhZW1vbiBjYW5ub3QgaG9uZXN0bHkgcmVuZGVyIHRoZVxuLy8gcnVubmFibGUgbGluZSwgYmVjYXVzZSBpdCBkb2VzIG5vdCBrbm93IGhvdyBpdHMgY2xpZW50IHdhcyBpbnZva2VkIOKAlCBhIENMSVxuLy8gZnJvbSB0aGUgcGx1Z2luIGNhY2hlIGNhbiBiZSB0YWxraW5nIHRvIGEgZGFlbW9uIHN0YXJ0ZWQgZnJvbSBhIGNoZWNrb3V0LiBTb1xuLy8gdGhlIGRhZW1vbiBuYW1lcyB0aGUgQUNUIGFuZCB0aGUgQ0xJLCB3aGljaCBpcyB0aGUgdGhpbmcgYmVpbmcgaW52b2tlZCxcbi8vIGNvbXBvc2VzIHRoZSBydW5uYWJsZSBjb21tYW5kIGZyb20gaXRzIG93biBhcmd2LiBDb25zdW1lcnMgdGhhdCBidWlsZCBhXG4vLyBjb21tYW5kIGZyb20gdGhpcyBmaWVsZCBtdXN0IHByZWZpeCB0aGVpciBvd24gaW52b2NhdGlvbi5cbmZ1bmN0aW9uIG1pc3NpbmdDaGFubmVsKG5hbWU6IHN0cmluZyk6IFJlc3BvbnNlIHtcbiAgcmV0dXJuIGpzb24oXG4gICAgeyBlcnJvcjogYG5vIGNoYW5uZWwgXCIke25hbWV9XCJgLCBjaGFubmVsOiBuYW1lLCBoaW50OiBgb3BlbiAke25hbWV9YCB9LFxuICAgIHsgc3RhdHVzOiA0MDQgfSxcbiAgKTtcbn1cblxuLy8gVGhlIHJlZnVzYWwgZm9yIGEgY2hhbm5lbCB0aGF0IElTIHRoZXJlIGFuZCBpcyByZXRpcmVkLiBTYW1lIHJlYXNvbmluZyBhc1xuLy8gbWlzc2luZ0NoYW5uZWwsIGFuZCB0aGUgc2FtZSBgaGludGAgY29udHJhY3QgKGEgVkVSQiBJTlZPQ0FUSU9OLCBub3QgYSBzaGVsbFxuLy8gY29tbWFuZCDigJQgdGhlIENMSSBjb21wb3NlcyB0aGUgcnVubmFibGUgbGluZSBmcm9tIGl0cyBvd24gYXJndikuXG4vL1xuLy8g4pqgIFRoZXNlIDQwOXMgdXNlZCB0byBjYXJyeSBubyBoaW50IHdoaWxlIHRoZSA0MDRzIGRpZCwgd2hpY2ggbWFkZSB0aGUgU0FNRVxuLy8gdmVyYiBhbnN3ZXIgdHdvIHdheXM6IGB0b3BpYyA8bWlzc2luZz5gIG5hbWVkIGl0cyByZWNvdmVyeSBhbmRcbi8vIGB0b3BpYyA8YXJjaGl2ZWQ+YCBkaWQgbm90LiBBbiBhZ2VudCB0aGF0IGhhcyBsZWFybmVkIHRvIHJlYWQgYGhpbnRgIHJlYWRzXG4vLyBpdHMgYWJzZW5jZSBhcyBcIm5vdGhpbmcgcmVjb3ZlcnMgdGhpc1wiLiBVbmFyY2hpdmluZyBpcyBleGFjdGx5IGFzIGd1ZXNzYWJsZVxuLy8gYXMgb3BlbmluZyB3YXMsIHdoaWNoIGlzIHRvIHNheSBub3QgYXQgYWxsIHVudGlsIHNvbWV0aGluZyBzYXlzIGl0LlxuLy9cbi8vIERlbGliZXJhdGVseSBOT1QgZXh0ZW5kZWQgdG8gdGhlIGBsaXZlYCA0MDkgb24gYSBkZXN0cnVjdGl2ZSByZXNldDogdGhlIGFjdFxuLy8gdGhhdCByZWNvdmVycyBmcm9tIGl0IGlzIGAtLWZvcmNlYCwgYW5kIG5hbWluZyBpdCB3b3VsZCB0dXJuIGEgZ3VhcmQgdGhhdFxuLy8gZXhpc3RzIHRvIHByb3RlY3QgYSBsaXZlIHNlc3Npb24gaW50byBhIHN1Z2dlc3Rpb24gdG8gb3ZlcnJpZGUgaXQuIFRoYXRcbi8vIHJlZnVzYWwgd2FudHMgYSBodW1hbiwgbm90IGEgaGludC5cbmZ1bmN0aW9uIGFyY2hpdmVkQ2hhbm5lbChuYW1lOiBzdHJpbmcpOiBSZXNwb25zZSB7XG4gIHJldHVybiBqc29uKHsgZXJyb3I6IFwiYXJjaGl2ZWRcIiwgY2hhbm5lbDogbmFtZSwgaGludDogYHVuYXJjaGl2ZSAke25hbWV9YCB9LCB7IHN0YXR1czogNDA5IH0pO1xufVxuXG5mdW5jdGlvbiBqc29uKGRhdGE6IHVua25vd24sIGluaXQ6IFJlc3BvbnNlSW5pdCA9IHt9KTogUmVzcG9uc2Uge1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKEpTT04uc3RyaW5naWZ5KGRhdGEpLCB7XG4gICAgLi4uaW5pdCxcbiAgICBoZWFkZXJzOiB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLCAuLi4oaW5pdC5oZWFkZXJzID8/IHt9KSB9LFxuICB9KTtcbn1cblxuLy8gUmVxdWVzdCBib2RpZXMgYXJlIHVudHJ1c3RlZCBleHRlcm5hbCBKU09OLiBXZSByZXR1cm4gYSBsb29zZSByZWNvcmQgKG9yXG4vLyBudWxsIG9uIHBhcnNlIGZhaWx1cmUpIGFuZCBuYXJyb3cgZWFjaCBmaWVsZCBhdCB0aGUgdXNlIHNpdGUuXG50eXBlIEpzb25Cb2R5ID0gUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsO1xuXG4vLyBJcyB0aGVyZSBzb21ldGhpbmcgaGVyZSB0byBhcmNoaXZlIG9yIHVuYXJjaGl2ZT8gU2FtZSBub24tY3JlYXRpbmcgcXVlc3Rpb25cbi8vIGFzIGNoYW5uZWxFeGlzdHMsIHdpZGVuZWQgYnkgdGhlIGFyY2hpdmVkIG1hcmtlcjogYSBjaGFubmVsIHRoYXQgd2FzIG9wZW5lZCxcbi8vIGFyY2hpdmVkIGFuZCBuZXZlciB3cml0dGVuIHRvIGhhcyBhIG1hcmtlciBhbmQgbm8gbG9nLCBhbmQgdW5hcmNoaXZpbmcgaXRcbi8vIG11c3Qgc3RpbGwgd29yay4gQXJjaGl2aW5nIGEgbmFtZSB0aGF0IGRvZXMgbm90IGV4aXN0IHdvdWxkIG90aGVyd2lzZSBDUkVBVEVcbi8vIGl0cyBsb2cgdmlhIGFwcGVuZExpZmVjeWNsZSDigJQgcmVpbnRyb2R1Y2luZywgb24gYSBsaWZlY3ljbGUgcm91dGUsIGV4YWN0bHlcbi8vIHRoZSByZXN1cnJlY3Rpb24gdGhlIHJlYWQgZ3VhcmQgcmVtb3ZlZC5cbmZ1bmN0aW9uIGxpZmVjeWNsZVRhcmdldChuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgaWYgKGNoYW5uZWxFeGlzdHMobmFtZSkpIHJldHVybiB0cnVlO1xuICB0cnkge1xuICAgIHJldHVybiBleGlzdHNTeW5jKGFyY2hpdmVkUGF0aChuYW1lKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vLyBXaG8gcmV0aXJlZCBpdC4gQm90aCBjbGllbnRzIHNlbmQgYHtmcm9tfWAgd2hlbiB0aGV5IGhhdmUgYSBuYW1lOiB0aGUgQ0xJXG4vLyBwYXNzZXMgdGhlIGdsb2JhbGx5LWFjY2VwdGVkIGAtLWFzYC9gLS1mcm9tYCwgYW5kIHRoZSB3YXRjaCBzdXJmYWNlIHNpZ25zXG4vLyB3aXRoIHRoZSBzYW1lIGFsaWFzIGl0cyB0b3BpYyBlZGl0IHVzZXMgKHN1cmZhY2UgaW52ZW50b3J5IEw1YSkuIFwic3lzdGVtXCIgaXNcbi8vIHRoZXJlZm9yZSB3aGF0IHlvdSBnZXQgd2hlbiB0aGVyZSBnZW51aW5lbHkgaXMgbm8gbmFtZSDigJQgYSBsdXJrZXIgd2l0aCBub1xuLy8gcGVyc2lzdGVkIGRlZmF1bHQg4oCUIHJhdGhlciB0aGFuIGEgcGxhY2Vob2xkZXIgZm9yIGEgbmFtZSB3ZSBmYWlsZWQgdG8gcmVhZC5cbi8vXG4vLyDimqAgVGhpcyBjb21tZW50IHByZXZpb3VzbHkgc2FpZCBib3RoIGNsaWVudHMgcG9zdGVkIHdpdGggbm8gYm9keS4gSXQgd2FzXG4vLyBzdGFsZSBpbiB0aGUgY29tbWl0IHRoYXQgaW50cm9kdWNlZCBpdCAodGhlIENMSSBoYWxmIGNoYW5nZWQgaW4gdGhlIHNhbWVcbi8vIGRpZmYpLCBhbmQgdGhlIHN1cmZhY2UgaGFsZiB0aGVuIHN0YXllZCB1bnNpZ25lZCBmb3IgYSBjb21taXQgYmVjYXVzZSB0aGVcbi8vIGNvbW1lbnQgc2FpZCB0aGF0IHdhcyBpbnRlbmRlZC4gQSBjb21tZW50IHRoYXQgZGVzY3JpYmVzIHRoZSBjYWxsZXIgaXMgYVxuLy8gY2xhaW0gYWJvdXQgYSBmaWxlIHlvdSBhcmUgbm90IGVkaXRpbmc7IHJlLXJlYWQgdGhlIGNhbGxlci5cbmFzeW5jIGZ1bmN0aW9uIGxpZmVjeWNsZUZyb20ocmVxOiBSZXF1ZXN0KTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgYm9keSA9IGF3YWl0IHJlYWRKc29uQm9keShyZXEpO1xuICByZXR1cm4gYm9keSAmJiB0eXBlb2YgYm9keS5mcm9tID09PSBcInN0cmluZ1wiICYmIGJvZHkuZnJvbS50cmltKCkgPyBib2R5LmZyb20udHJpbSgpIDogXCJzeXN0ZW1cIjtcbn1cblxuLy8gVGhlIGFyY2hpdmUvdW5hcmNoaXZlIGZyYW1lLiBraW5kOlwic3RhdHVzXCIgd2l0aCBhbiBgZXZlbnRgIGFuZCBOT1xuLy8gYGRpc3Bvc2l0aW9uYCDigJQgc2VlIHRoZSBNZXNzYWdlIHR5cGU6IHRoYXQgYWJzZW5jZSBpcyB3aGF0IHRlbGxzIGBwdWxsYCBhbmRcbi8vIGB0YWlsYCB0aGlzIGlzIGEgY2hhbm5lbC1sZXZlbCBmYWN0IHJhdGhlciB0aGFuIGRpc3Bvc2l0aW9uIG1ldGFkYXRhLlxuLy9cbi8vIEdvZXMgdGhyb3VnaCBhcHBlbmRNZXNzYWdlIHJhdGhlciB0aGFuIHdyaXRpbmcgdGhlIGxpbmUgaXRzZWxmLCBzbyBpdFxuLy8gaW5oZXJpdHMgdGhlIGIxMSBuZXdsaW5lIHJlcGFpciwgdGhlIGlkIGFsbG9jYXRpb24sIHRoZSBTU0UgZmFuLW91dCBhbmQgdGhlXG4vLyBsb25nLXBvbGwgZHJhaW4uIEEgc2Vjb25kIGFwcGVuZGVyIGlzIGEgc2Vjb25kIHBsYWNlIHRvIGdldCBKU09OTCB3cm9uZy5cbmZ1bmN0aW9uIGFwcGVuZExpZmVjeWNsZShuYW1lOiBzdHJpbmcsIGZyb206IHN0cmluZywgZXZlbnQ6IFwiYXJjaGl2ZWRcIiB8IFwidW5hcmNoaXZlZFwiKTogTWVzc2FnZSB7XG4gIGNvbnN0IHRleHQgPVxuICAgIGV2ZW50ID09PSBcImFyY2hpdmVkXCIgPyBcImNoYW5uZWwgYXJjaGl2ZWQg4oCUIHJlYWQtb25seVwiIDogXCJjaGFubmVsIHVuYXJjaGl2ZWQg4oCUIHdyaXRhYmxlIGFnYWluXCI7XG4gIHJldHVybiBhcHBlbmRNZXNzYWdlKG5hbWUsIGZyb20sIHRleHQsIFwic3RhdHVzXCIsIHVuZGVmaW5lZCwgeyBldmVudCB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZEpzb25Cb2R5KHJlcTogUmVxdWVzdCk6IFByb21pc2U8SnNvbkJvZHk+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gKGF3YWl0IHJlcS5qc29uKCkpIGFzIEpzb25Cb2R5O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGUocmVxOiBSZXF1ZXN0KTogUHJvbWlzZTxSZXNwb25zZT4ge1xuICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwpO1xuICBjb25zdCBwYXRoID0gdXJsLnBhdGhuYW1lO1xuICBjb25zdCBtZXRob2QgPSByZXEubWV0aG9kO1xuXG4gIGlmIChwYXRoID09PSBcIi9cIiAmJiBtZXRob2QgPT09IFwiR0VUXCIpIHtcbiAgICByZXR1cm4ganNvbih7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHBpZDogcHJvY2Vzcy5waWQsXG4gICAgICBzdGFydGVkX2F0OiBTVEFSVEVEX0FULFxuICAgICAgY2hhbm5lbHM6IGNoYW5uZWxzLnNpemUsXG4gICAgICBkYXRhX2RpcjogREFUQV9ESVIsXG4gICAgICB2ZXJzaW9uOiBQTFVHSU5fVkVSU0lPTixcbiAgICAgIC8vIFdoaWNoIHN1cmZhY2UgdGhpcyBkYWVtb24gc2VydmVzIChDb250cmFjdCAxKSDigJQgYWRkaXRpdmUsIHNvIGEgQ0xJXG4gICAgICAvLyB0aGF0IGRvZXMgbm90IGtub3cgdGhlIGZpZWxkIGlnbm9yZXMgaXQuXG4gICAgICBtb2RlOiBNT0RFLFxuICAgIH0pO1xuICB9XG5cbiAgaWYgKHBhdGggPT09IFwiL1wiICYmIG1ldGhvZCA9PT0gXCJERUxFVEVcIikge1xuICAgIC8vIFJlcGx5LCB0aGVuIHNjaGVkdWxlIHNodXRkb3duIHNvIHRoZSByZXNwb25zZSBhY3R1YWxseSBmbHVzaGVzLlxuICAgIHNldFRpbWVvdXQoKCkgPT4gc2h1dGRvd24oMCksIDEwKTtcbiAgICByZXR1cm4ganNvbih7IG9rOiB0cnVlLCBzaHV0dGluZ19kb3duOiB0cnVlIH0pO1xuICB9XG5cbiAgaWYgKHBhdGggPT09IFwiL3dhdGNoXCIgJiYgbWV0aG9kID09PSBcIkdFVFwiKSB7XG4gICAgLy8gUmVsZWFzZTogdGhlIGJ1aWx0IHN1cmZhY2UncyBlbnRyeS4gRGV2IG5ldmVyIHJlYWNoZXMgaGVyZSDigJQgQnVuJ3NcbiAgICAvLyBgcm91dGVzYCBhbnN3ZXJzIC93YXRjaCB3aXRoIHRoZSBIVE1MQnVuZGxlIGJlZm9yZSBmZXRjaCgpIHJ1bnMg4oCUIHNvIGFcbiAgICAvLyBtaXNzIGlzIGEgYnJva2VuIGluc3RhbGwsIGFuZCBpdCBmYWlscyBMT1VEIHdpdGggdGhlIHBhdGggaXQgbG9va2VkIGZvci5cbiAgICByZXR1cm4gKFxuICAgICAgc2VydmVEaXN0KFwiaW5kZXguaHRtbFwiKSA/P1xuICAgICAganNvbihcbiAgICAgICAge1xuICAgICAgICAgIGVycm9yOiBcIndhdGNoIHN1cmZhY2UgbWlzc2luZ1wiLFxuICAgICAgICAgIGRldGFpbHM6IGAke2pvaW4oRElTVF9ESVIsIFwiaW5kZXguaHRtbFwiKX0gbm90IGZvdW5kIChtb2RlICR7TU9ERX0pYCxcbiAgICAgICAgfSxcbiAgICAgICAgeyBzdGF0dXM6IDUwMCB9LFxuICAgICAgKVxuICAgICk7XG4gIH1cblxuICBpZiAocGF0aCA9PT0gXCIvY2hhbm5lbHNcIiAmJiBtZXRob2QgPT09IFwiR0VUXCIpIHtcbiAgICByZXR1cm4ganNvbih7IGNoYW5uZWxzOiBsaXN0Q2hhbm5lbHMoKSB9KTtcbiAgfVxuXG4gIC8vIFBlcnNpc3RlZCBkZWZhdWx0IGlkZW50aXR5IChWMS43KSDigJQgdGhlIHdhdGNoIHN1cmZhY2UgcmVhZHMgdGhpcyBvbiBsb2FkIHRvXG4gIC8vIHByZS1maWxsIHRoZSBodW1hbidzIGFsaWFzLiBTZXQgdmlhIGBncmFwZXZpbmUgYWxpYXMgPG5hbWU+YCAod3JpdGVzXG4gIC8vIGNvbmZpZy5qc29uKTsgcmVhZCBmcmVzaCBlYWNoIHJlcXVlc3Qgc28gYSBDTEkgY2hhbmdlIHNob3dzIHVwIGxpdmUuXG4gIGlmIChwYXRoID09PSBcIi9pZGVudGl0eVwiICYmIG1ldGhvZCA9PT0gXCJHRVRcIikge1xuICAgIHJldHVybiBqc29uKHsgYWxpYXM6IHJlYWRDb25maWdBbGlhcygpIH0pO1xuICB9XG5cbiAgLy8gQ3Jvc3MtY2hhbm5lbCBwcmVzZW5jZSBhZ2dyZWdhdGlvbiDigJQgb25lIHNob3Qgb2YgbmFtZXMgw5cgY2hhbm5lbCBmb3IgdGhlXG4gIC8vIGB3aG8gLS1hbGxgIHZpZXcgYW5kIGBkb2N0b3JgJ3MgY3Jvc3MtY2hlY2suIE9ubHkgY2hhbm5lbHMgd2l0aCBhdCBsZWFzdFxuICAvLyBvbmUgbGl2ZSBjb25uZWN0aW9uIGFwcGVhciAocHJlc2VuY2Ugb25seSBleGlzdHMgZm9yIGxvYWRlZCBjaGFubmVscykuXG4gIGlmIChwYXRoID09PSBcIi9wcmVzZW5jZVwiICYmIG1ldGhvZCA9PT0gXCJHRVRcIikge1xuICAgIGNvbnN0IG91dCA9IFtdO1xuICAgIGZvciAoY29uc3QgY2ggb2YgY2hhbm5lbHMudmFsdWVzKCkpIHtcbiAgICAgIGNvbnN0IHN1YnMgPSB2aXNpYmxlU3VicyhjaCk7IC8vIGx1cmtlcnMgZXhjbHVkZWQg4oCUIGludmlzaWJsZSBwcmVzZW5jZVxuICAgICAgaWYgKHN1YnMubGVuZ3RoID09PSAwKSBjb250aW51ZTtcbiAgICAgIG91dC5wdXNoKHtcbiAgICAgICAgbmFtZTogY2gubmFtZSxcbiAgICAgICAgc3Vic2NyaWJlcnM6IHN1YnNjcmliZXJBbGlhc2VzKGNoLm5hbWUpLFxuICAgICAgICBodW1hbnM6IHN1YnNjcmliZXJIdW1hbnMoY2gubmFtZSksXG4gICAgICAgIGNvbm5lY3Rpb25zOiBzdWJzLmxlbmd0aCxcbiAgICAgICAgbmFtZWQ6IHN1YnMuZmlsdGVyKChzKSA9PiBzLmFsaWFzKS5sZW5ndGgsXG4gICAgICAgIGFub255bW91czogc3Vicy5maWx0ZXIoKHMpID0+ICFzLmFsaWFzKS5sZW5ndGgsXG4gICAgICB9KTtcbiAgICB9XG4gICAgb3V0LnNvcnQoKGEsIGIpID0+IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSkpO1xuICAgIHJldHVybiBqc29uKHsgY2hhbm5lbHM6IG91dCB9KTtcbiAgfVxuXG4gIGlmIChwYXRoID09PSBcIi9jaGFubmVsc1wiICYmIG1ldGhvZCA9PT0gXCJQT1NUXCIpIHtcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVhZEpzb25Cb2R5KHJlcSk7XG4gICAgaWYgKCFib2R5IHx8IHR5cGVvZiBib2R5Lm5hbWUgIT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHJldHVybiBqc29uKHsgZXJyb3I6IFwibmFtZSByZXF1aXJlZFwiIH0sIHsgc3RhdHVzOiA0MDAgfSk7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAvLyBBdXRvLXVuYXJjaGl2ZTogdGhlIG9idmlvdXMgdmVyYiBkb2VzIHRoZSBvYnZpb3VzIHRoaW5nLCBzbyBhXG4gICAgICAvLyBjb252ZW5lLWF0LXN0YXJ0IHdyYXBwZXIgbmV2ZXIgYnJlYWtzIG9uIGEgY2hhbm5lbCBhIHByaW9yIHNlc3Npb24gcmV0aXJlZC5cbiAgICAgIC8vIEF1dG8tdW5hcmNoaXZlIG9ubHkgZm9yIGV4cGxpY2l0IGBvcGVuYCBjYWxscyAoYm9keS5leHBsaWNpdCA9PT0gdHJ1ZSkuXG4gICAgICAvLyBPdGhlciB2ZXJicyAocHVsbCwgdGFpbCwgd2hvLCByZWFkKSBhbHNvIGNhbGwgUE9TVCAvY2hhbm5lbHMgdG8gZW5zdXJlXG4gICAgICAvLyB0aGUgY2hhbm5lbCBpcyBsb2FkZWQsIGJ1dCBzaG91bGQgbm90IHNpbGVudGx5IHVuYXJjaGl2ZSBhIHJldGlyZWQgY2hhbm5lbC5cbiAgICAgIGxldCB1bmFyY2hpdmVkID0gZmFsc2U7XG4gICAgICBjb25zdCBhcCA9IGFyY2hpdmVkUGF0aChib2R5Lm5hbWUpO1xuICAgICAgaWYgKGJvZHkuZXhwbGljaXQgPT09IHRydWUgJiYgZXhpc3RzU3luYyhhcCkpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICB1bmxpbmtTeW5jKGFwKTtcbiAgICAgICAgfSBjYXRjaCB7fVxuICAgICAgICBpZiAoZXhpc3RzU3luYyhhcCkpIHtcbiAgICAgICAgICByZXR1cm4ganNvbihcbiAgICAgICAgICAgIHsgZXJyb3I6IFwidW5hcmNoaXZlIGZhaWxlZCDigJQgbWFya2VyIHN0aWxsIHByZXNlbnRcIiwgY2hhbm5lbDogYm9keS5uYW1lIH0sXG4gICAgICAgICAgICB7IHN0YXR1czogNTAwIH0sXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICB1bmFyY2hpdmVkID0gdHJ1ZTtcbiAgICAgIH0gZWxzZSBpZiAoYm9keS5leHBsaWNpdCAhPT0gdHJ1ZSAmJiBleGlzdHNTeW5jKGFwKSkge1xuICAgICAgICByZXR1cm4gYXJjaGl2ZWRDaGFubmVsKGJvZHkubmFtZSk7XG4gICAgICB9XG4gICAgICAvLyBvcGVuIC0tZnJlc2g6IGNsZWFyIHRoZSBjaGFubmVsIGZvciBhIG5ldyBzZXNzaW9uLCBidXQgT05MWSB3aGVuIG5vIHNlYXRzXG4gICAgICAvLyBhcmUgY29ubmVjdGVkLiBBIHJlLXJ1bm5hYmxlIGNvbnZlbmUgbXVzdCBuZXZlciB3aXBlIGEgbGl2ZSBzZXNzaW9uLlxuICAgICAgbGV0IGNsZWFyZWQgPSBmYWxzZTtcbiAgICAgIGxldCBzbmFwc2hvdDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgICBpZiAoYm9keS5mcmVzaCA9PT0gdHJ1ZSkge1xuICAgICAgICBjb25zdCBleGlzdGluZyA9IGNoYW5uZWxzLmdldChib2R5Lm5hbWUpO1xuICAgICAgICBjb25zdCBsaXZlU3VicyA9IGV4aXN0aW5nID8gZXhpc3Rpbmcuc3Vic2NyaWJlcnMuc2l6ZSA6IDA7XG4gICAgICAgIGlmIChsaXZlU3VicyA9PT0gMCkge1xuICAgICAgICAgIHNuYXBzaG90ID0gc25hcHNob3RBbmRDbGVhcihib2R5Lm5hbWUpO1xuICAgICAgICAgIGNsZWFyZWQgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBjb25zdCBjaCA9IGxvYWRDaGFubmVsKGJvZHkubmFtZSk7XG4gICAgICAvLyBUaGUgY2hhbm5lbCBpcyB3cml0dGVuIGRvd24gaGVyZSwgbm90IG9uIGl0cyBmaXJzdCBtZXNzYWdlOiB0aGlzIHJvdXRlXG4gICAgICAvLyBJUyB0aGUgZXhwbGljaXQgY3JlYXRpbmcgYWN0LCBhbmQgYW4gb3BlbiB0aGF0IGxlYXZlcyBubyB0cmFjZSBkb2VzIG5vdFxuICAgICAgLy8gc3Vydml2ZSBhIHJlc3RhcnQgKHNlZSBwZXJzaXN0Q2hhbm5lbCkuXG4gICAgICBwZXJzaXN0Q2hhbm5lbChib2R5Lm5hbWUpO1xuICAgICAgaWYgKHVuYXJjaGl2ZWQpIHtcbiAgICAgICAgY2guYXJjaGl2ZWQgPSBmYWxzZTtcbiAgICAgICAgLy8g4puUIGBvcGVuYCdzIGF1dG8tdW5hcmNoaXZlIGlzIGFuIFVOQVJDSElWRSwgYW5kIGl0IG11c3QgYW5ub3VuY2VcbiAgICAgICAgLy8gaXRzZWxmIGZvciB0aGUgc2FtZSByZWFzb24gdGhlIGV4cGxpY2l0IHJvdXRlIGRvZXMg4oCUIG90aGVyd2lzZSBhXG4gICAgICAgIC8vIGNvbnZlbmUtYXQtc3RhcnQgd3JhcHBlciBzaWxlbnRseSBtYWtlcyBhIHJldGlyZWQgY2hhbm5lbCB3cml0YWJsZVxuICAgICAgICAvLyBhZ2FpbiBhbmQgdGhlIGFnZW50cyB0YWlsaW5nIGl0IG5ldmVyIHNlZSB0aGUgc3RhdGUgY2hhbmdlLiBUaGlzIGlzXG4gICAgICAgIC8vIHRoZSB0aGlyZCB1bmFyY2hpdmUgcGF0aCwgYW5kIGl0IHdhcyB0aGUgb25lIHdpdGggbm8gc2lnbmFsLlxuICAgICAgICBhcHBlbmRMaWZlY3ljbGUoXG4gICAgICAgICAgYm9keS5uYW1lLFxuICAgICAgICAgIHR5cGVvZiBib2R5LmZyb20gPT09IFwic3RyaW5nXCIgPyBib2R5LmZyb20gOiBcInN5c3RlbVwiLFxuICAgICAgICAgIFwidW5hcmNoaXZlZFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgLy8gT3B0aW9uYWwgdG9waWMgb24gb3BlbiDigJQgb25seSBzZXQgaWYgcHJvdmlkZWQgQU5EIGNoYW5uZWwgaGFzIG5vXG4gICAgICAvLyB0b3BpYyB5ZXQgKHNvIHJlLW9wZW5pbmcgZG9lc24ndCBjbG9iYmVyKS4gVG8gdXBkYXRlIGxhdGVyLCB1c2VcbiAgICAgIC8vIHRoZSBleHBsaWNpdCBQVVQgL3RvcGljIGVuZHBvaW50LlxuICAgICAgaWYgKHR5cGVvZiBib2R5LnRvcGljID09PSBcInN0cmluZ1wiICYmIGJvZHkudG9waWMudHJpbSgpICE9PSBcIlwiICYmIGNoLnRvcGljID09PSBudWxsKSB7XG4gICAgICAgIGFwcGVuZE1lc3NhZ2UoXG4gICAgICAgICAgYm9keS5uYW1lLFxuICAgICAgICAgIHR5cGVvZiBib2R5LmZyb20gPT09IFwic3RyaW5nXCIgPyBib2R5LmZyb20gOiBcInN5c3RlbVwiLFxuICAgICAgICAgIGJvZHkudG9waWMsXG4gICAgICAgICAgXCJ0b3BpY1wiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGpzb24oe1xuICAgICAgICBuYW1lOiBjaC5uYW1lLFxuICAgICAgICBjcmVhdGVkX2F0OiBjaC5jcmVhdGVkX2F0LFxuICAgICAgICBtZXNzYWdlX2NvdW50OiBjaC5uZXh0X2lkIC0gMSxcbiAgICAgICAgc3Vic2NyaWJlcnM6IHZpc2libGVTdWJzKGNoKS5sZW5ndGgsXG4gICAgICAgIHRvcGljOiBjaC50b3BpYyxcbiAgICAgICAgdW5hcmNoaXZlZCxcbiAgICAgICAgY2xlYXJlZCxcbiAgICAgICAgc25hcHNob3QsXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICByZXR1cm4ganNvbih7IGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSwgeyBzdGF0dXM6IDQwMCB9KTtcbiAgICB9XG4gIH1cblxuICBpZiAocGF0aCA9PT0gXCIvYW5ub3VuY2VcIiAmJiBtZXRob2QgPT09IFwiUE9TVFwiKSB7XG4gICAgY29uc3QgYm9keSA9IGF3YWl0IHJlYWRKc29uQm9keShyZXEpO1xuICAgIGlmICghYm9keSB8fCB0eXBlb2YgYm9keS5mcm9tICE9PSBcInN0cmluZ1wiIHx8IHR5cGVvZiBib2R5LnRleHQgIT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHJldHVybiBqc29uKHsgZXJyb3I6IFwiZnJvbSBhbmQgdGV4dCByZXF1aXJlZFwiIH0sIHsgc3RhdHVzOiA0MDAgfSk7XG4gICAgfVxuICAgIGNvbnN0IHJlcXVlc3RlZDogc3RyaW5nW10gfCB1bmRlZmluZWQgPSBBcnJheS5pc0FycmF5KGJvZHkuY2hhbm5lbHMpXG4gICAgICA/IGJvZHkuY2hhbm5lbHMuZmlsdGVyKChjOiB1bmtub3duKTogYyBpcyBzdHJpbmcgPT4gdHlwZW9mIGMgPT09IFwic3RyaW5nXCIpXG4gICAgICA6IHVuZGVmaW5lZDtcblxuICAgIGNvbnN0IGRlbGl2ZXJlZDogeyBuYW1lOiBzdHJpbmc7IHJlY2lwaWVudHM6IG51bWJlciB9W10gPSBbXTtcbiAgICBjb25zdCBza2lwcGVkOiB7IG5hbWU6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfVtdID0gW107XG5cbiAgICAvLyBSZXNvbHZlIHRoZSB0YXJnZXQgc2V0LlxuICAgIGxldCB0YXJnZXRzOiBzdHJpbmdbXTtcbiAgICBpZiAocmVxdWVzdGVkKSB7XG4gICAgICAvLyBFeHBsaWNpdCB0YXJnZXRpbmc6IG5hbWVkIGNoYW5uZWxzIHJlZ2FyZGxlc3Mgb2YgYWN0aXZpdHkuIEFyY2hpdmVkIOKGklxuICAgICAgLy8gc2tpcCAocmVhZC1vbmx5KS4gVW5rbm93biAobm90IGxvYWRlZCBhbmQgbm8gb24tZGlzayBsb2cpIOKGkiBza2lwLlxuICAgICAgdGFyZ2V0cyA9IFtdO1xuICAgICAgZm9yIChjb25zdCBuYW1lIG9mIHJlcXVlc3RlZCkge1xuICAgICAgICBsZXQgb25EaXNrID0gZmFsc2U7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgb25EaXNrID0gZXhpc3RzU3luYyhjaGFubmVsUGF0aChuYW1lKSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8vIGludmFsaWQgY2hhbm5lbCBuYW1lIOKGkiB0cmVhdCBhcyB1bmtub3duXG4gICAgICAgIH1cbiAgICAgICAgaWYgKGV4aXN0c1N5bmMoYXJjaGl2ZWRQYXRoKG5hbWUpKSkge1xuICAgICAgICAgIHNraXBwZWQucHVzaCh7IG5hbWUsIHJlYXNvbjogXCJhcmNoaXZlZFwiIH0pO1xuICAgICAgICB9IGVsc2UgaWYgKGNoYW5uZWxzLmhhcyhuYW1lKSB8fCBvbkRpc2spIHtcbiAgICAgICAgICB0YXJnZXRzLnB1c2gobmFtZSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgc2tpcHBlZC5wdXNoKHsgbmFtZSwgcmVhc29uOiBcInVua25vd25cIiB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBEZWZhdWx0OiBldmVyeSBhY3RpdmUgKGluLW1lbW9yeSkgY2hhbm5lbCwgbWludXMgYXJjaGl2ZWQuIEFyY2hpdmVkXG4gICAgICAvLyBpbi1tZW1vcnkgY2hhbm5lbHMgYXJlIHNpbGVudGx5IGV4Y2x1ZGVkIOKAlCB0aGUgY2FsbGVyIGRpZG4ndCBuYW1lIHRoZW0uXG4gICAgICB0YXJnZXRzID0gWy4uLmNoYW5uZWxzLmtleXMoKV0uZmlsdGVyKChuYW1lKSA9PiAhY2hhbm5lbHMuZ2V0KG5hbWUpPy5hcmNoaXZlZCk7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBuYW1lIG9mIHRhcmdldHMpIHtcbiAgICAgIC8vIFJlLWNoZWNrIGFyY2hpdmVkIGltbWVkaWF0ZWx5IGJlZm9yZSBhcHBlbmQ6IGEgY2hhbm5lbCBjb3VsZCBoYXZlIGJlZW5cbiAgICAgIC8vIGFyY2hpdmVkIGJldHdlZW4gdGFyZ2V0IHJlc29sdXRpb24gYW5kIGhlcmUuIE1pcnJvcnMgdGhlIHNpYmxpbmdcbiAgICAgIC8vIFBPU1QgL2NoYW5uZWxzLzpuYW1lL21lc3NhZ2VzIGhhbmRsZXIsIHdoaWNoIHJlLWNoZWNrcyBiZWZvcmUgYXBwZW5kaW5nLlxuICAgICAgaWYgKGV4aXN0c1N5bmMoYXJjaGl2ZWRQYXRoKG5hbWUpKSkge1xuICAgICAgICBza2lwcGVkLnB1c2goeyBuYW1lLCByZWFzb246IFwiYXJjaGl2ZWRcIiB9KTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBhcHBlbmRNZXNzYWdlKG5hbWUsIGJvZHkuZnJvbSwgYm9keS50ZXh0LCBcImFubm91bmNlbWVudFwiKTtcbiAgICAgIGNvbnN0IGNoID0gY2hhbm5lbHMuZ2V0KG5hbWUpO1xuICAgICAgY29uc3QgdmlzID0gY2ggPyB2aXNpYmxlU3VicyhjaCkgOiBbXTtcbiAgICAgIGNvbnN0IHJlY2lwaWVudHMgPSB2aXMucmVkdWNlKChuLCBzdWIpID0+IChzdWIuYWxpYXMgIT09IGJvZHkuZnJvbSA/IG4gKyAxIDogbiksIDApO1xuICAgICAgZGVsaXZlcmVkLnB1c2goeyBuYW1lLCByZWNpcGllbnRzIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IHRvdGFsX3JlY2lwaWVudHMgPSBkZWxpdmVyZWQucmVkdWNlKChuLCBkKSA9PiBuICsgZC5yZWNpcGllbnRzLCAwKTtcbiAgICByZXR1cm4ganNvbih7IG9rOiB0cnVlLCBjaGFubmVsczogZGVsaXZlcmVkLCBza2lwcGVkLCB0b3RhbF9yZWNpcGllbnRzIH0pO1xuICB9XG5cbiAgLy8gUm91dGUtbGV2ZWwgY2hhbm5lbCBuYW1lIHBhdHRlcm4uIE1pcnJvcnMgY2hhbm5lbFBhdGgoKSdzIHJ1bGVzOlxuICAvLyBhbG51bS91bmRlcnNjb3JlL2h5cGhlbiBhdCB0aGUgZW5kcywgb3B0aW9uYWwgZG90IGluIHRoZSBtaWRkbGUuXG4gIC8vIGNoYW5uZWxQYXRoKCkgZG9lcyB0aGUgY2Fub25pY2FsIHZhbGlkYXRpb24gKGluY2wuIG5vLWAuLmApIG9uXG4gIC8vIGFueXRoaW5nIHRoYXQgZ2V0cyB0aHJvdWdoIGhlcmUuXG4gIGNvbnN0IGNoTWF0Y2ggPSBwYXRoLm1hdGNoKFxuICAgIC9eXFwvY2hhbm5lbHNcXC8oW2EtekEtWjAtOV8tXSg/OlthLXpBLVowLTlfLi1dezAsNjJ9W2EtekEtWjAtOV8tXSk/KShcXC8uKik/JC8sXG4gICk7XG4gIGlmIChjaE1hdGNoKSB7XG4gICAgY29uc3QgbmFtZSA9IGNoTWF0Y2hbMV07XG4gICAgY29uc3Qgc3ViID0gY2hNYXRjaFsyXSA/PyBcIlwiO1xuXG4gICAgaWYgKHN1YiA9PT0gXCJcIiAmJiBtZXRob2QgPT09IFwiREVMRVRFXCIpIHtcbiAgICAgIGNvbnN0IGNoID0gY2hhbm5lbHMuZ2V0KG5hbWUpO1xuICAgICAgaWYgKGNoKSB7XG4gICAgICAgIGZvciAoY29uc3QgcyBvZiBjaC5zdWJzY3JpYmVycy52YWx1ZXMoKSkge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBzLnNlbmQoe1xuICAgICAgICAgICAgICBpZDogLTEsXG4gICAgICAgICAgICAgIGNoYW5uZWw6IG5hbWUsXG4gICAgICAgICAgICAgIGZyb206IFwic3lzdGVtXCIsXG4gICAgICAgICAgICAgIHRleHQ6IFwiY2hhbm5lbCBjbG9zZWRcIixcbiAgICAgICAgICAgICAgdHM6IERhdGUubm93KCksXG4gICAgICAgICAgICAgIGtpbmQ6IFwibWVzc2FnZVwiLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSBjYXRjaCB7fVxuICAgICAgICB9XG4gICAgICAgIGNoLnN1YnNjcmliZXJzLmNsZWFyKCk7XG4gICAgICAgIGNoYW5uZWxzLmRlbGV0ZShuYW1lKTtcbiAgICAgIH1cbiAgICAgIC8vIERlbGV0ZSBwZXJzaXN0ZWQgbG9nIHRvbywgcGx1cyBhbnkgYXJjaGl2ZWQgbWFya2VyLlxuICAgICAgY29uc3QgcCA9IGNoYW5uZWxQYXRoKG5hbWUpO1xuICAgICAgaWYgKGV4aXN0c1N5bmMocCkpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICB1bmxpbmtTeW5jKHApO1xuICAgICAgICB9IGNhdGNoIHt9XG4gICAgICB9XG4gICAgICBjb25zdCBhcCA9IGFyY2hpdmVkUGF0aChuYW1lKTtcbiAgICAgIGlmIChleGlzdHNTeW5jKGFwKSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHVubGlua1N5bmMoYXApO1xuICAgICAgICB9IGNhdGNoIHt9XG4gICAgICB9XG4gICAgICByZXR1cm4ganNvbih7IG9rOiB0cnVlIH0pO1xuICAgIH1cblxuICAgIC8vIEFyY2hpdmUgLyB1bmFyY2hpdmUgKFYxLjcpIOKAlCBhIG5vbi1kZXN0cnVjdGl2ZSBhbHRlcm5hdGl2ZSB0byBjbG9zZS4gVGhlXG4gICAgLy8gbWFya2VyIGZpbGUgaXMgdGhlIHNvdXJjZSBvZiB0cnV0aDsgdGhlIGluLW1lbW9yeSBmbGFnIG1pcnJvcnMgaXQuXG4gICAgLy9cbiAgICAvLyBCb3RoIEFQUEVORCBhIGtpbmQ6XCJzdGF0dXNcIiBmcmFtZSAoMjAyNi0wOS0wNikuIFBlcnNpc3RlZCwgbm90IGFuXG4gICAgLy8gU1NFLW9ubHkgZXZlbnQ6IGFuIGFnZW50IHRoYXQgd2FzIG5vdCBjb25uZWN0ZWQgYXQgdGhlIG1vbWVudCBsZWFybnMgZnJvbVxuICAgIC8vIGBwdWxsYCwgYW5kIGEgcmVjb25uZWN0aW5nIHRhaWwgcmVwbGF5cyBpdCDigJQgYW4gZXZlbnQgd291bGQgYmUgaW52aXNpYmxlXG4gICAgLy8gdG8gYm90aC4gUmV0aXJpbmcgYSBjaGFubmVsIGlzIGEgZmFjdCBhYm91dCB0aGUgY2hhbm5lbCwgYW5kIGJlZm9yZSB0aGlzXG4gICAgLy8gdGhlIG9ubHkgc2lnbmFsIGVpdGhlciBwYXJ0eSBnb3Qgd2FzIGl0cyBuZXh0IHNlbmQgYmVpbmcgcmVqZWN0ZWQuXG4gICAgLy9cbiAgICAvLyDimqAgVEhFIEZSQU1FIElTIEVNSVRURUQgT05MWSBXSEVOIFRIRSBTVEFURSBBQ1RVQUxMWSBGTElQUEVELiBCb3RoIHJvdXRlc1xuICAgIC8vIGFyZSBpZGVtcG90ZW50IOKAlCBhcmNoaXZpbmcgYW4gYXJjaGl2ZWQgY2hhbm5lbCBoYXMgYWx3YXlzIGJlZW4gYW4gb2s6dHJ1ZVxuICAgIC8vIG5vLW9wIOKAlCBhbmQgYW4gdW5jb25kaXRpb25hbCBlbWl0dGVyIHR1cm5lZCB0aGF0IG5vLW9wIGludG8gYSBkdXJhYmxlLFxuICAgIC8vIGJyb2FkY2FzdCBjbGFpbSB0aGF0IGEgdHJhbnNpdGlvbiBoYXBwZW5lZC4gYHVuYXJjaGl2ZWAgb24gYSBoZWFsdGh5XG4gICAgLy8gY2hhbm5lbCB3cm90ZSBgZXZlbnQ6XCJ1bmFyY2hpdmVkXCJgIGludG8gaXRzIGxvZyBhbmQgZXZlcnkgdGFpbGluZyBhZ2VudFxuICAgIC8vIHNhdyBpdDogYSBmYWxzZSBzdGF0ZW1lbnQgaW4gdGhlIHBlcm1hbmVudCByZWNvcmQsIHdoaWNoIGlzIHRoZSBleGFjdFxuICAgIC8vIGZhaWx1cmUgY2xhc3MgdGhpcyBicmFuY2ggZXhpc3RzIHRvIHJlbW92ZS4gVGhlIHNhbWUgZ3VhcmQgYWxyZWFkeSBsaXZlc1xuICAgIC8vIG9uIHRoZSBleHBsaWNpdC1vcGVuIHBhdGgsIHdoaWNoIGVtaXRzIG9ubHkgd2hlbiBgdW5hcmNoaXZlZGAgZmxpcHBlZC5cbiAgICAvLyBgY2hhbmdlZGAgcmVwb3J0cyB3aGljaCBpdCB3YXMsIHNvIGFuIGlkZW1wb3RlbnQgY2FsbGVyIGNhbiB0ZWxsLlxuICAgIGlmIChzdWIgPT09IFwiL2FyY2hpdmVcIiAmJiBtZXRob2QgPT09IFwiUE9TVFwiKSB7XG4gICAgICBpZiAoIWxpZmVjeWNsZVRhcmdldChuYW1lKSkgcmV0dXJuIG1pc3NpbmdDaGFubmVsKG5hbWUpO1xuICAgICAgY29uc3QgZnJvbSA9IGF3YWl0IGxpZmVjeWNsZUZyb20ocmVxKTtcbiAgICAgIC8vIFJlYWQgdGhlIHByaW9yIHN0YXRlIEJFRk9SRSB0aGUgd3JpdGUsIG9yIHRoZXJlIGlzIG5vdGhpbmcgbGVmdCB0b1xuICAgICAgLy8gY29tcGFyZSBhZ2FpbnN0LlxuICAgICAgY29uc3Qgd2FzQXJjaGl2ZWQgPSBleGlzdHNTeW5jKGFyY2hpdmVkUGF0aChuYW1lKSk7XG4gICAgICAvLyBNYXJrZXIgZmlyc3QsIGZyYW1lIHNlY29uZDogdGhlIGZyYW1lIGFzc2VydHMgYSBzdGF0ZSwgc28gdGhlIHN0YXRlIGlzXG4gICAgICAvLyB0cnVlIGJ5IHRoZSB0aW1lIGFueSByZWFkZXIgY2FuIHNlZSB0aGUgYXNzZXJ0aW9uLlxuICAgICAgd3JpdGVGaWxlU3luYyhhcmNoaXZlZFBhdGgobmFtZSksIFwiXCIpO1xuICAgICAgY29uc3QgY2ggPSBjaGFubmVscy5nZXQobmFtZSk7XG4gICAgICBpZiAoY2gpIGNoLmFyY2hpdmVkID0gdHJ1ZTtcbiAgICAgIGNvbnN0IG0gPSB3YXNBcmNoaXZlZCA/IG51bGwgOiBhcHBlbmRMaWZlY3ljbGUobmFtZSwgZnJvbSwgXCJhcmNoaXZlZFwiKTtcbiAgICAgIHJldHVybiBqc29uKHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIGNoYW5uZWw6IG5hbWUsXG4gICAgICAgIGFyY2hpdmVkOiB0cnVlLFxuICAgICAgICBjaGFuZ2VkOiAhd2FzQXJjaGl2ZWQsXG4gICAgICAgIGlkOiBtID8gbS5pZCA6IG51bGwsXG4gICAgICB9KTtcbiAgICB9XG4gICAgaWYgKHN1YiA9PT0gXCIvcmVzZXRcIiAmJiBtZXRob2QgPT09IFwiUE9TVFwiKSB7XG4gICAgICBjb25zdCBib2R5ID0gKGF3YWl0IHJlYWRKc29uQm9keShyZXEpKSA/PyB7fTtcbiAgICAgIGNvbnN0IGNoID0gY2hhbm5lbHMuZ2V0KG5hbWUpO1xuICAgICAgY29uc3QgbGl2ZVN1YnMgPSBjaCA/IGNoLnN1YnNjcmliZXJzLnNpemUgOiAwO1xuICAgICAgaWYgKGxpdmVTdWJzID4gMCAmJiBib2R5LmZvcmNlICE9PSB0cnVlKSB7XG4gICAgICAgIHJldHVybiBqc29uKHsgZXJyb3I6IFwibGl2ZVwiLCBjaGFubmVsOiBuYW1lLCBzdWJzY3JpYmVyczogbGl2ZVN1YnMgfSwgeyBzdGF0dXM6IDQwOSB9KTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHNuYXBzaG90ID0gc25hcHNob3RBbmRDbGVhcihuYW1lKTtcbiAgICAgIHJldHVybiBqc29uKHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIGNoYW5uZWw6IG5hbWUsXG4gICAgICAgIHNuYXBzaG90LFxuICAgICAgICBjbGVhcmVkOiBzbmFwc2hvdCAhPT0gbnVsbCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmIChzdWIgPT09IFwiL3VuYXJjaGl2ZVwiICYmIG1ldGhvZCA9PT0gXCJQT1NUXCIpIHtcbiAgICAgIGlmICghbGlmZWN5Y2xlVGFyZ2V0KG5hbWUpKSByZXR1cm4gbWlzc2luZ0NoYW5uZWwobmFtZSk7XG4gICAgICBjb25zdCBmcm9tID0gYXdhaXQgbGlmZWN5Y2xlRnJvbShyZXEpO1xuICAgICAgY29uc3QgYXAgPSBhcmNoaXZlZFBhdGgobmFtZSk7XG4gICAgICAvLyBUaGUgcHJpb3Igc3RhdGUsIHJlYWQgYmVmb3JlIHRoZSB1bmxpbmsg4oCUIHNlZSB0aGUgYXJjaGl2ZSByb3V0ZSBhYm92ZTpcbiAgICAgIC8vIG5vIGZsaXAsIG5vIGZyYW1lLlxuICAgICAgY29uc3Qgd2FzQXJjaGl2ZWQgPSBleGlzdHNTeW5jKGFwKTtcbiAgICAgIGlmIChleGlzdHNTeW5jKGFwKSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHVubGlua1N5bmMoYXApO1xuICAgICAgICB9IGNhdGNoIHt9XG4gICAgICB9XG4gICAgICAvLyBUaGUgbWFya2VyIGZpbGUgaXMgdGhlIHNvdXJjZSBvZiB0cnV0aCBhY3Jvc3MgcmVzdGFydHMuIElmIGl0IHN0aWxsXG4gICAgICAvLyBleGlzdHMsIHRoZSB1bmxpbmsgZmFpbGVkIOKAlCBkb24ndCByZXBvcnQgc3VjY2VzcyB3aXRoIGEgc3RhbGUgb24tZGlza1xuICAgICAgLy8gc3RhdGUgdGhhdCB3b3VsZCBzaWxlbnRseSByZS1hcmNoaXZlIG9uIHRoZSBuZXh0IGRhZW1vbiBzdGFydC5cbiAgICAgIGlmIChleGlzdHNTeW5jKGFwKSkge1xuICAgICAgICByZXR1cm4ganNvbihcbiAgICAgICAgICB7IGVycm9yOiBcInVuYXJjaGl2ZSBmYWlsZWQg4oCUIG1hcmtlciBzdGlsbCBwcmVzZW50XCIsIGNoYW5uZWw6IG5hbWUgfSxcbiAgICAgICAgICB7IHN0YXR1czogNTAwIH0sXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBjaCA9IGNoYW5uZWxzLmdldChuYW1lKTtcbiAgICAgIGlmIChjaCkgY2guYXJjaGl2ZWQgPSBmYWxzZTtcbiAgICAgIGNvbnN0IG0gPSB3YXNBcmNoaXZlZCA/IGFwcGVuZExpZmVjeWNsZShuYW1lLCBmcm9tLCBcInVuYXJjaGl2ZWRcIikgOiBudWxsO1xuICAgICAgcmV0dXJuIGpzb24oe1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgY2hhbm5lbDogbmFtZSxcbiAgICAgICAgYXJjaGl2ZWQ6IGZhbHNlLFxuICAgICAgICBjaGFuZ2VkOiB3YXNBcmNoaXZlZCxcbiAgICAgICAgaWQ6IG0gPyBtLmlkIDogbnVsbCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmIChzdWIgPT09IFwiL21lc3NhZ2VzXCIgJiYgbWV0aG9kID09PSBcIkdFVFwiKSB7XG4gICAgICAvLyBBIHJlYWQgbmV2ZXIgY3JlYXRlcy4gVGhpcyByb3V0ZSBuZXZlciBkaWQgKHJlYWRCYWNrbG9nIGdvZXMgc3RyYWlnaHRcbiAgICAgIC8vIHRvIHRoZSBmaWxlKSDigJQgYnV0IGl0IGFuc3dlcmVkIGB7XCJtZXNzYWdlc1wiOltdfWAgZm9yIGEgbmFtZSB0aGF0IGRvZXNcbiAgICAgIC8vIG5vdCBleGlzdCwgd2hpY2ggaXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBhbiBlbXB0eSBjaGFubmVsLiBUaGUgZ3VhcmRcbiAgICAgIC8vIGlzIGhlcmUgZm9yIHRoZSBsaWUsIG5vdCBmb3IgdGhlIHJlc3VycmVjdGlvbi5cbiAgICAgIGlmICghY2hhbm5lbEV4aXN0cyhuYW1lKSkgcmV0dXJuIG1pc3NpbmdDaGFubmVsKG5hbWUpO1xuICAgICAgY29uc3Qgc2luY2UgPSBwYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInNpbmNlXCIpID8/IFwiMFwiLCAxMCkgfHwgMDtcbiAgICAgIHJldHVybiBqc29uKHsgbWVzc2FnZXM6IHJlYWRCYWNrbG9nKG5hbWUsIHNpbmNlKSB9KTtcbiAgICB9XG5cbiAgICBpZiAoc3ViID09PSBcIi9tZXNzYWdlc1wiICYmIG1ldGhvZCA9PT0gXCJQT1NUXCIpIHtcbiAgICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZWFkSnNvbkJvZHkocmVxKTtcbiAgICAgIGlmICghYm9keSB8fCB0eXBlb2YgYm9keS50ZXh0ICE9PSBcInN0cmluZ1wiIHx8IHR5cGVvZiBib2R5LmZyb20gIT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgcmV0dXJuIGpzb24oeyBlcnJvcjogXCJmcm9tIGFuZCB0ZXh0IHJlcXVpcmVkXCIgfSwgeyBzdGF0dXM6IDQwMCB9KTtcbiAgICAgIH1cbiAgICAgIGlmIChleGlzdHNTeW5jKGFyY2hpdmVkUGF0aChuYW1lKSkpIHtcbiAgICAgICAgcmV0dXJuIGFyY2hpdmVkQ2hhbm5lbChuYW1lKTtcbiAgICAgIH1cbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGluUmVwbHlUbyA9IHR5cGVvZiBib2R5LmluX3JlcGx5X3RvID09PSBcIm51bWJlclwiID8gYm9keS5pbl9yZXBseV90byA6IHVuZGVmaW5lZDtcbiAgICAgICAgY29uc3QgbSA9IGFwcGVuZE1lc3NhZ2UobmFtZSwgYm9keS5mcm9tLCBib2R5LnRleHQsIFwibWVzc2FnZVwiLCBpblJlcGx5VG8pO1xuICAgICAgICBjb25zdCBjaCA9IGNoYW5uZWxzLmdldChuYW1lKTtcbiAgICAgICAgY29uc3QgYWxpYXNlcyA9IHN1YnNjcmliZXJBbGlhc2VzKG5hbWUpO1xuICAgICAgICAvLyByZWNpcGllbnRzID0gdmlzaWJsZSBzdWJzY3JpYmVycyBleGNsdWRpbmcgdGhlIHNlbmRlci4gTHVya2VycyByZWNlaXZlXG4gICAgICAgIC8vIHRoZSBtZXNzYWdlIGJ1dCBzdGF5IHVuY291bnRlZCAoaW52aXNpYmxlKTsgYW5vbnltb3VzIG5vbi1sdXJrIHdhdGNoXG4gICAgICAgIC8vIHRhYnMgZG8gY291bnQuXG4gICAgICAgIGNvbnN0IHZpcyA9IGNoID8gdmlzaWJsZVN1YnMoY2gpIDogW107XG4gICAgICAgIGNvbnN0IHJlY2lwaWVudHMgPSB2aXMucmVkdWNlKChuLCBzdWIpID0+IChzdWIuYWxpYXMgIT09IGJvZHkuZnJvbSA/IG4gKyAxIDogbiksIDApO1xuICAgICAgICByZXR1cm4ganNvbihcbiAgICAgICAgICB7XG4gICAgICAgICAgICAuLi5tLFxuICAgICAgICAgICAgc3Vic2NyaWJlcnM6IHZpcy5sZW5ndGgsXG4gICAgICAgICAgICByZWNpcGllbnRzLFxuICAgICAgICAgICAgc3Vic2NyaWJlcl9hbGlhc2VzOiBhbGlhc2VzLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgeyBzdGF0dXM6IDIwMSB9LFxuICAgICAgICApO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICByZXR1cm4ganNvbih7IGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSwgeyBzdGF0dXM6IDQwMCB9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoc3ViID09PSBcIi9zdGF0dXNcIiAmJiBtZXRob2QgPT09IFwiUE9TVFwiKSB7XG4gICAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVhZEpzb25Cb2R5KHJlcSk7XG4gICAgICBpZiAoXG4gICAgICAgICFib2R5IHx8XG4gICAgICAgIHR5cGVvZiBib2R5LmZyb20gIT09IFwic3RyaW5nXCIgfHxcbiAgICAgICAgdHlwZW9mIGJvZHkudGFyZ2V0ICE9PSBcIm51bWJlclwiIHx8XG4gICAgICAgIHR5cGVvZiBib2R5LmRpc3Bvc2l0aW9uICE9PSBcInN0cmluZ1wiXG4gICAgICApIHtcbiAgICAgICAgcmV0dXJuIGpzb24oeyBlcnJvcjogXCJmcm9tLCB0YXJnZXQsIGRpc3Bvc2l0aW9uIHJlcXVpcmVkXCIgfSwgeyBzdGF0dXM6IDQwMCB9KTtcbiAgICAgIH1cbiAgICAgIC8vIFRhcmdldCBtdXN0IGJlIGEgcmVhbCwgbm9uLXN0YXR1cyBtZXNzYWdlIGluIHRoaXMgY2hhbm5lbC5cbiAgICAgIGNvbnN0IGV4aXN0cyA9IHJlYWRCYWNrbG9nKG5hbWUsIDApLnNvbWUoKG0pID0+IG0uaWQgPT09IGJvZHkudGFyZ2V0ICYmIG0ua2luZCAhPT0gXCJzdGF0dXNcIik7XG4gICAgICBpZiAoIWV4aXN0cykge1xuICAgICAgICByZXR1cm4ganNvbih7IGVycm9yOiBgbm8gbWVzc2FnZSAke2JvZHkudGFyZ2V0fSBpbiAke25hbWV9YCB9LCB7IHN0YXR1czogNDA0IH0pO1xuICAgICAgfVxuICAgICAgY29uc3Qgbm90ZSA9IHR5cGVvZiBib2R5Lm5vdGUgPT09IFwic3RyaW5nXCIgPyBib2R5Lm5vdGUgOiBcIlwiO1xuICAgICAgY29uc3QgbSA9IGFwcGVuZE1lc3NhZ2UobmFtZSwgYm9keS5mcm9tLCBub3RlLCBcInN0YXR1c1wiLCB1bmRlZmluZWQsIHtcbiAgICAgICAgdGFyZ2V0OiBib2R5LnRhcmdldCBhcyBudW1iZXIsXG4gICAgICAgIGRpc3Bvc2l0aW9uOiBib2R5LmRpc3Bvc2l0aW9uIGFzIHN0cmluZyxcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIGpzb24obSwgeyBzdGF0dXM6IDIwMSB9KTtcbiAgICB9XG5cbiAgICBpZiAoc3ViID09PSBcIi93YWl0XCIgJiYgbWV0aG9kID09PSBcIkdFVFwiKSB7XG4gICAgICAvLyBBIHJlYWQgbmV2ZXIgY3JlYXRlcyDigJQgYW5kIHRoaXMgb25lIERJRDogbG9hZENoYW5uZWwgYmVsb3cgcmVnaXN0ZXJzXG4gICAgICAvLyB0aGUgbmFtZSBpbiBgY2hhbm5lbHNgLCB3aGljaCBpcyB3aGF0IHB1dCBhIGNsb3NlZCBjaGFubmVsIGJhY2sgaW5cbiAgICAgIC8vIGBsaXN0YC5cbiAgICAgIGlmICghY2hhbm5lbEV4aXN0cyhuYW1lKSkgcmV0dXJuIG1pc3NpbmdDaGFubmVsKG5hbWUpO1xuICAgICAgY29uc3QgY2ggPSBsb2FkQ2hhbm5lbChuYW1lKTtcbiAgICAgIGNvbnN0IHNpbmNlID0gcGFyc2VJbnQodXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJzaW5jZVwiKSA/PyBcIjBcIiwgMTApIHx8IDA7XG4gICAgICBjb25zdCBhbGlhcyA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwiYXNcIik7XG4gICAgICBjb25zdCB0aW1lb3V0UyA9IE1hdGgubWluKFxuICAgICAgICBNYXRoLm1heChwYXJzZUZsb2F0KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwidGltZW91dFwiKSA/PyBcIjMwXCIpIHx8IDMwLCAwLjEpLFxuICAgICAgICAzMDAsXG4gICAgICApO1xuICAgICAgLy8gUmVnaXN0ZXIgYSBuby1vcCBwcmVzZW5jZSBzdWJzY3JpYmVyIGZvciB0aGUgd2FpdCBkdXJhdGlvbiBzbyB0aGVcbiAgICAgIC8vIGFsaWFzIGFwcGVhcnMgb24gYHdob2AuIGB3YWl0YCBpcyBsb25nLXBvbGwg4oCUIHNlbWFudGljYWxseSBhIHRhaWxcbiAgICAgIC8vIHdpdGggYSBkZWFkbGluZSDigJQgc28gaXQgZGVzZXJ2ZXMgcHJlc2VuY2UuIGBwdWxsYCBpcyBmaXJlLWFuZC1mb3JnZXRcbiAgICAgIC8vIGFuZCBpbnRlbnRpb25hbGx5IGRvZXMgbm90IHJlZ2lzdGVyLlxuICAgICAgbGV0IHByZXNlbmNlS2V5OiBzeW1ib2wgfCBudWxsID0gbnVsbDtcbiAgICAgIGlmIChhbGlhcykge1xuICAgICAgICBwcmVzZW5jZUtleSA9IFN5bWJvbChgd2FpdDoke2FsaWFzfWApO1xuICAgICAgICBjaC5zdWJzY3JpYmVycy5zZXQocHJlc2VuY2VLZXksIHtcbiAgICAgICAgICBhbGlhcyxcbiAgICAgICAgICBzZW5kOiAoKSA9PiB7fSwgLy8gbm8tb3A7IHdhaXQgZnVsZmlsbG1lbnQgaXMgdmlhIHRoZSB3YWl0cyBzZXQsIG5vdCBTU0VcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBjb25zdCBjbGVhbnVwUHJlc2VuY2UgPSAoKSA9PiB7XG4gICAgICAgIGlmIChwcmVzZW5jZUtleSkgY2guc3Vic2NyaWJlcnMuZGVsZXRlKHByZXNlbmNlS2V5KTtcbiAgICAgIH07XG4gICAgICAvLyBJbW1lZGlhdGUtcmV0dXJuIHBhdGg6IGlmIHRoZXJlIGFyZSBtZXNzYWdlcyBuZXdlciB0aGFuIGBzaW5jZWAsIGhhbmRcbiAgICAgIC8vIHRoZW0gYmFjayByaWdodCBhd2F5LiBNaXJyb3JzIHRoZSBjb2RleCBgd2FpdGAgVVgg4oCUIGxvbmctcG9sbCBvbmx5XG4gICAgICAvLyB3aGVuIHlvdSdyZSB0cnVseSBjdXJyZW50LlxuICAgICAgY29uc3QgaW1tZWRpYXRlID0gcmVhZEJhY2tsb2cobmFtZSwgc2luY2UpO1xuICAgICAgY29uc3QgY3Vyc29yT2YgPSAobXNnczogTWVzc2FnZVtdKSA9PlxuICAgICAgICBtc2dzLmxlbmd0aCA/IG1zZ3NbbXNncy5sZW5ndGggLSAxXS5pZCA6IE1hdGgubWF4KHNpbmNlLCBjaC5uZXh0X2lkIC0gMSk7XG4gICAgICBpZiAoaW1tZWRpYXRlLmxlbmd0aCkge1xuICAgICAgICBjbGVhbnVwUHJlc2VuY2UoKTtcbiAgICAgICAgcmV0dXJuIGpzb24oe1xuICAgICAgICAgIG1lc3NhZ2VzOiBpbW1lZGlhdGUsXG4gICAgICAgICAgY3Vyc29yOiBjdXJzb3JPZihpbW1lZGlhdGUpLFxuICAgICAgICAgIHRpbWVkX291dDogZmFsc2UsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgLy8gRWxzZSBob2xkIGZvciB1cCB0byBgdGltZW91dFNgIHNlY29uZHM7IHJlc29sdmVzIHdoZW4gYXBwZW5kTWVzc2FnZVxuICAgICAgLy8gc2VlcyBzb21ldGhpbmcgbmV3IGZvciB0aGlzIGBzaW5jZWAuXG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBuZXcgUHJvbWlzZTx7XG4gICAgICAgIG1lc3NhZ2VzOiBNZXNzYWdlW107XG4gICAgICAgIHRpbWVkX291dDogYm9vbGVhbjtcbiAgICAgIH0+KChyZXNvbHZlKSA9PiB7XG4gICAgICAgIGxldCB0aW1lb3V0SGFuZGxlOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICAgICAgICBjb25zdCB3YWl0ZXI6IFBlbmRpbmdXYWl0ID0ge1xuICAgICAgICAgIHNpbmNlLFxuICAgICAgICAgIHJlc29sdmU6IChtc2dzKSA9PiB7XG4gICAgICAgICAgICBpZiAodGltZW91dEhhbmRsZSAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHRpbWVvdXRIYW5kbGUpO1xuICAgICAgICAgICAgcmVzb2x2ZSh7IG1lc3NhZ2VzOiBtc2dzLCB0aW1lZF9vdXQ6IGZhbHNlIH0pO1xuICAgICAgICAgIH0sXG4gICAgICAgIH07XG4gICAgICAgIGNoLndhaXRzLmFkZCh3YWl0ZXIpO1xuICAgICAgICAvLyBEZWZlbnNlLWluLWRlcHRoIHJlY2hlY2suIEpTIGV2ZW50LWxvb3Agc2VtYW50aWNzIG1ha2UgdGhlXG4gICAgICAgIC8vIHJlZ2lzdGVyLWFmdGVyLWJyb2FkY2FzdCByYWNlIG5lYXJseSBpbXBvc3NpYmxlIGluIHByYWN0aWNlLCBidXRcbiAgICAgICAgLy8gc29tZSBydW50aW1lcyAobm90YWJseSBCdW4gcHJlLTEuMy4xMCkgaGF2ZSBzaG93biBsb25nLXBvbGwgaGFuZ3NcbiAgICAgICAgLy8gd2hlcmUgdGhlIGF3YWl0ZWQgUHJvbWlzZSBuZWl0aGVyIHJlc29sdmVzIHZpYSBkcmFpbiBub3IgdmlhXG4gICAgICAgIC8vIHNldFRpbWVvdXQuIFJlLXJlYWRpbmcgdGhlIGJhY2tsb2cgYWZ0ZXIgcmVnaXN0ZXJpbmcgY2xvc2VzIHRoZVxuICAgICAgICAvLyB0aGVvcmV0aWNhbCByYWNlIEFORCBnaXZlcyB1cyBhIGZhbGxiYWNrIGlmIGFwcGVuZCBzZWVzIG5vXG4gICAgICAgIC8vIHdhaXRlcnMgZHVyaW5nIGl0cyBkcmFpbiBwYXNzIGZvciB3aGF0ZXZlciByZWFzb24uXG4gICAgICAgIGNvbnN0IG1pc3NlZCA9IHJlYWRCYWNrbG9nKG5hbWUsIHNpbmNlKTtcbiAgICAgICAgaWYgKG1pc3NlZC5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgY2gud2FpdHMuZGVsZXRlKHdhaXRlcik7XG4gICAgICAgICAgcmVzb2x2ZSh7IG1lc3NhZ2VzOiBtaXNzZWQsIHRpbWVkX291dDogZmFsc2UgfSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHRpbWVvdXRIYW5kbGUgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICBjaC53YWl0cy5kZWxldGUod2FpdGVyKTtcbiAgICAgICAgICByZXNvbHZlKHsgbWVzc2FnZXM6IFtdLCB0aW1lZF9vdXQ6IHRydWUgfSk7XG4gICAgICAgIH0sIHRpbWVvdXRTICogMTAwMCk7XG4gICAgICB9KTtcbiAgICAgIGNsZWFudXBQcmVzZW5jZSgpO1xuICAgICAgcmV0dXJuIGpzb24oe1xuICAgICAgICBtZXNzYWdlczogcmVzdWx0Lm1lc3NhZ2VzLFxuICAgICAgICBjdXJzb3I6IGN1cnNvck9mKHJlc3VsdC5tZXNzYWdlcyksXG4gICAgICAgIHRpbWVkX291dDogcmVzdWx0LnRpbWVkX291dCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmIChzdWIgPT09IFwiL3N1YnNjcmliZXJzXCIgJiYgbWV0aG9kID09PSBcIkdFVFwiKSB7XG4gICAgICBjb25zdCBjaCA9IGNoYW5uZWxzLmdldChuYW1lKTtcbiAgICAgIC8vIEx1cmtlcnMgYXJlIGV4Y2x1ZGVkIGZyb20gZXZlcnkgY291bnQg4oCUIGFuIGludmlzaWJsZSB3YXRjaGVyIGJ1bXBzXG4gICAgICAvLyBub3RoaW5nLiBIb25lc3QgcHJlc2VuY2UgYWNjb3VudGluZyBvdmVyIHdoYXQncyBsZWZ0OiBgY29ubmVjdGlvbnNgIGlzXG4gICAgICAvLyB0aGUgcmF3IChub24tbHVyaykgc29ja2V0IGNvdW50LCBgbmFtZWRgIGNhcnJpZXMgYW4gYWxpYXMsIGBhbm9ueW1vdXNgXG4gICAgICAvLyBpcyBudWxsLWFsaWFzIChlLmcuIGEgQ0xJIGB0YWlsYCB3aXRoIG5vIGAtLWFzYCkuIG5hbWVkICsgYW5vbnltb3VzID09PVxuICAgICAgLy8gY29ubmVjdGlvbnMsIHNvIGEgYGNvdW50YCBvdmVyIHRoZSBuYW1lIGxpc3QgaXMgZXhwbGFpbmFibGUsIG5vdCBhXG4gICAgICAvLyBnaG9zdC4gYGNvdW50YCBzdGF5cyA9PT0gY29ubmVjdGlvbnMgZm9yIGJhY2stY29tcGF0LlxuICAgICAgY29uc3Qgc3VicyA9IGNoID8gdmlzaWJsZVN1YnMoY2gpIDogW107XG4gICAgICBjb25zdCBuYW1lZCA9IHN1YnMuZmlsdGVyKChzKSA9PiBzLmFsaWFzKS5sZW5ndGg7XG4gICAgICBjb25zdCBhbm9ueW1vdXMgPSBzdWJzLmZpbHRlcigocykgPT4gIXMuYWxpYXMpLmxlbmd0aDtcbiAgICAgIHJldHVybiBqc29uKHtcbiAgICAgICAgY2hhbm5lbDogbmFtZSxcbiAgICAgICAgc3Vic2NyaWJlcnM6IHN1YnNjcmliZXJBbGlhc2VzKG5hbWUpLFxuICAgICAgICBodW1hbnM6IHN1YnNjcmliZXJIdW1hbnMobmFtZSksXG4gICAgICAgIGNvdW50OiBzdWJzLmxlbmd0aCxcbiAgICAgICAgY29ubmVjdGlvbnM6IHN1YnMubGVuZ3RoLFxuICAgICAgICBuYW1lZCxcbiAgICAgICAgYW5vbnltb3VzLFxuICAgICAgICB0b3BpYzogY2g/LnRvcGljID8/IG51bGwsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAoc3ViID09PSBcIi90b3BpY1wiICYmIG1ldGhvZCA9PT0gXCJHRVRcIikge1xuICAgICAgLy8gUmVhZGluZyBhIHRvcGljIGlzIGEgcmVhZDogaXQgZG9lcyBub3QgY3JlYXRlLiAoUFVUIGRvZXMg4oCUIGl0IGlzIGFcbiAgICAgIC8vIHdyaXRlLCBhbmQgb25seSBpbnRlbnQgY3JlYXRlcy4pXG4gICAgICBpZiAoIWNoYW5uZWxFeGlzdHMobmFtZSkpIHJldHVybiBtaXNzaW5nQ2hhbm5lbChuYW1lKTtcbiAgICAgIGNvbnN0IGNoID0gbG9hZENoYW5uZWwobmFtZSk7XG4gICAgICByZXR1cm4ganNvbih7IGNoYW5uZWw6IG5hbWUsIHRvcGljOiBjaC50b3BpYyB9KTtcbiAgICB9XG5cbiAgICBpZiAoc3ViID09PSBcIi90b3BpY1wiICYmIG1ldGhvZCA9PT0gXCJQVVRcIikge1xuICAgICAgY29uc3QgYm9keSA9IGF3YWl0IHJlYWRKc29uQm9keShyZXEpO1xuICAgICAgaWYgKCFib2R5IHx8IHR5cGVvZiBib2R5LnRvcGljICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIHJldHVybiBqc29uKHsgZXJyb3I6IFwidG9waWMgcmVxdWlyZWRcIiB9LCB7IHN0YXR1czogNDAwIH0pO1xuICAgICAgfVxuICAgICAgLy8gQXJjaGl2ZWQgbWVhbnMgcmVhZC1vbmx5LCBhbmQgYSB0b3BpYyBpcyBhIHdyaXRlIOKAlCBpdCBhcHBlbmRzIGFcbiAgICAgIC8vIGtpbmQ6XCJ0b3BpY1wiIGZyYW1lIHRvIHRoZSBsb2cgbGlrZSBhbnkgb3RoZXIgbWVzc2FnZS4gVGhlIHNpYmxpbmdcbiAgICAgIC8vIFBPU1Qg4oCmL21lc3NhZ2VzIGhhcyBoYWQgdGhpcyBndWFyZCBzaW5jZSBWMS43OyB0aGlzIHJvdXRlIG5ldmVyIGRpZCwgc29cbiAgICAgIC8vIGBhcmNoaXZlIHhgIHRoZW4gYHRvcGljIHggXCJ0XCJgIGxhbmRlZCBhIGZyYW1lIG9uIGEgcmVhZC1vbmx5IGNoYW5uZWxcbiAgICAgIC8vIGFuZCBhbnN3ZXJlZCBvazp0cnVlLiBTYW1lIHN0YXR1cywgc2FtZSBlbnZlbG9wZSBhcyB0aGUgc2libGluZy5cbiAgICAgIGlmIChleGlzdHNTeW5jKGFyY2hpdmVkUGF0aChuYW1lKSkpIHtcbiAgICAgICAgcmV0dXJuIGFyY2hpdmVkQ2hhbm5lbChuYW1lKTtcbiAgICAgIH1cbiAgICAgIC8vIERlbGliZXJhdGVseSBOTyBleGlzdGVuY2UgZ3VhcmQ6IHVuZGVyIFwib25seSBpbnRlbnQgY3JlYXRlc1wiLCBhIHRvcGljXG4gICAgICAvLyBXUklURSBkZWNsYXJlcyB0aGF0IHRoaXMgY2hhbm5lbCBzaG91bGQgaG9sZCB0aGlzLCBzbyBpdCBtYXkgY3JlYXRlXG4gICAgICAvLyBvbmUg4oCUIHRoZSBzYW1lIGNsYXNzIG9mIGFjdCBhcyBgc2VuZGAuIE9ubHkgdGhlIHJlYWQgKEdFVCkgcmVmdXNlcy5cbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IG0gPSBhcHBlbmRNZXNzYWdlKFxuICAgICAgICAgIG5hbWUsXG4gICAgICAgICAgdHlwZW9mIGJvZHkuZnJvbSA9PT0gXCJzdHJpbmdcIiA/IGJvZHkuZnJvbSA6IFwic3lzdGVtXCIsXG4gICAgICAgICAgYm9keS50b3BpYyxcbiAgICAgICAgICBcInRvcGljXCIsXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiBqc29uKHsgb2s6IHRydWUsIGNoYW5uZWw6IG5hbWUsIHRvcGljOiBib2R5LnRvcGljLCBpZDogbS5pZCB9KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgcmV0dXJuIGpzb24oeyBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0sIHsgc3RhdHVzOiA0MDAgfSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHN1YiA9PT0gXCIvdGFpbFwiICYmIG1ldGhvZCA9PT0gXCJHRVRcIikge1xuICAgICAgLy8gQSBzdWJzY3JpYmUgaXMgZm9yd2FyZC1sb29raW5nIOKAlCBcInRlbGwgbWUgYWJvdXQgdGhpcyBmcm9tIG5vdyBvblwiIOKAlCBzb1xuICAgICAgLy8gaXQgTUFZIGNyZWF0ZSB0aGUgY2hhbm5lbCwgYW5kIHRoYXQgaXMgZGVsaWJlcmF0ZTogYSBmcmVzaCBgdGFpbCBuYW1lYFxuICAgICAgLy8gd29ya3Mgd2l0aG91dCBhbiBleHBsaWNpdCBvcGVuLCBhbmQgdGhlIHdhdGNoIHN1cmZhY2UncyBmaXJzdCBsb2FkXG4gICAgICAvLyByZWxpZXMgb24gaXQuIEJ1dCBhbiBhZ2VudCB0aGF0IHRhaWxzIGEgTUlTVFlQRUQgbmFtZSB0aGVuIHdhaXRzXG4gICAgICAvLyBmb3JldmVyIGluc2lkZSBhIGNoYW5uZWwgb2YgaXRzIG93biBtYWtpbmcsIHdpdGggbm8gc2lnbmFsIHRoYXQgdGhpcyBpc1xuICAgICAgLy8gd2hhdCBoYXBwZW5lZCDigJQgdGhlIHNhbWUgc2lsZW50LWZhaWx1cmUgY2xhc3MgYXMgYSByZXN1cnJlY3RpbmcgcmVhZCxcbiAgICAgIC8vIGp1c3Qgc2xvd2VyLiBTbyB0aGUgc3Vic2NyaWJlZCBldmVudCBzYXlzIHNvLiBDb21wdXRlZCBCRUZPUkVcbiAgICAgIC8vIGxvYWRDaGFubmVsLCB3aGljaCBpcyB3aGF0IGRvZXMgdGhlIGNyZWF0aW5nLlxuICAgICAgY29uc3QgY3JlYXRlZCA9ICFjaGFubmVsRXhpc3RzKG5hbWUpO1xuICAgICAgY29uc3QgY2ggPSBsb2FkQ2hhbm5lbChuYW1lKTtcbiAgICAgIC8vIEEgc3Vic2NyaWJlIHRoYXQgY3JlYXRlZCB0aGUgY2hhbm5lbCBpcyBhIGNyZWF0aW5nIGFjdCBsaWtlIGFueSBvdGhlcixcbiAgICAgIC8vIHNvIGl0IHdyaXRlcyB0aGUgY2hhbm5lbCBkb3duIHRvbyDigJQgb3RoZXJ3aXNlIGB0YWlsYCdzIG93biBjcmVhdGlvbiBpc1xuICAgICAgLy8gdGhlIG9uZSB0aGF0IHN0aWxsIGV2YXBvcmF0ZXMgb24gYSByZXN0YXJ0LlxuICAgICAgaWYgKGNyZWF0ZWQpIHBlcnNpc3RDaGFubmVsKG5hbWUpO1xuICAgICAgLy8g4pqgIFRoZSBMQVRFIEpPSU5FUi4gYGNyZWF0ZWRgIHRlbGxzIGEgc3Vic2NyaWJlciBpdCBqdXN0IGludmVudGVkIHRoZVxuICAgICAgLy8gY2hhbm5lbDsgbm90aGluZyB0b2xkIGl0IHRoZSBjaGFubmVsIGl0IGpvaW5lZCBpcyBhbHJlYWR5IHJldGlyZWQuIFRoZVxuICAgICAgLy8gbGlmZWN5Y2xlIGZyYW1lIGNsb3NlcyB0aGUgY2FzZSBmb3IgYW4gYWdlbnQgdGhhdCB3YXMgY29ubmVjdGVkIGF0IHRoZVxuICAgICAgLy8gbW9tZW50LCBvciB0aGF0IHB1bGxzIGhpc3Rvcnkg4oCUIGJ1dCBhIGB0YWlsYCB0aGF0IGFycml2ZXMgYWZ0ZXJ3YXJkc1xuICAgICAgLy8gZ290IGFuIG9yZGluYXJ5IGdyb3VuZGluZyBsaW5lIGFuZCB0aGVuIFwiZm91bmQgb3V0IHdoZW4gaXRzIG5leHQgc2VuZFxuICAgICAgLy8gd2FzIHJlamVjdGVkXCIsIHdoaWNoIGlzIHZlcmJhdGltIHRoZSBmYWlsdXJlIHRoZSBmcmFtZSB3YXMgYWRkZWQgdG9cbiAgICAgIC8vIGVuZC4gUmVhZCBvZmYgdGhlIE1BUktFUiwgbm90IGBjaC5hcmNoaXZlZGA6IHRoZSBtYXJrZXIgZmlsZSBpcyB0aGVcbiAgICAgIC8vIHNvdXJjZSBvZiB0cnV0aCBhbmQgdGhlIGluLW1lbW9yeSBmbGFnIG9ubHkgbWlycm9ycyBpdC5cbiAgICAgIGNvbnN0IGFyY2hpdmVkID0gZXhpc3RzU3luYyhhcmNoaXZlZFBhdGgobmFtZSkpO1xuICAgICAgY29uc3Qgc2luY2UgPSBwYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInNpbmNlXCIpID8/IFwiMFwiLCAxMCkgfHwgMDtcbiAgICAgIGNvbnN0IGFsaWFzID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJhc1wiKTtcbiAgICAgIC8vIFYxLjcg4oCUIGEgaHVtYW4tZHJpdmVuIGNvbm5lY3Rpb24gKHRoZSB3YXRjaCwgb3IgYHRhaWwgLS1odW1hbmApIGZsYWdzXG4gICAgICAvLyBpdHNlbGYgc28gaXQgc2hvd3MgYXMgYGNvbGUgKGh1bWFuKWAgaW4gcHJlc2VuY2UgaW5zdGVhZCBvZiBhblxuICAgICAgLy8gdW5hdHRyaWJ1dGVkIGNvdW50IGJ1bXAuXG4gICAgICBjb25zdCBodW1hbiA9IFtcIjFcIiwgXCJ0cnVlXCJdLmluY2x1ZGVzKHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwiaHVtYW5cIikgPz8gXCJcIik7XG4gICAgICAvLyBWMS43IOKAlCBhIGx1cmsgY29ubmVjdGlvbiByZWNlaXZlcyBtZXNzYWdlcyBidXQgaXMgZXhjbHVkZWQgZnJvbSBldmVyeVxuICAgICAgLy8gcHJlc2VuY2UgY291bnQsIHNvIGJyb3dzaW5nIGEgY2hhbm5lbCBpcyBnZW51aW5lbHkgaW52aXNpYmxlLlxuICAgICAgY29uc3QgbHVyayA9IFtcIjFcIiwgXCJ0cnVlXCJdLmluY2x1ZGVzKHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwibHVya1wiKSA/PyBcIlwiKTtcbiAgICAgIC8vICM2OCDigJQgYHRhaWwgLS1sYXN0IE5gOiBiYWNrZmlsbCB0aGUgbW9zdCByZWNlbnQgTiBtZXNzYWdlcywgdGhlbiBnb1xuICAgICAgLy8gbGl2ZS4gVGhlIGRhZW1vbiBob2xkcyB0aGUgbG9nLCBzbyB0aGUgc2xpY2UgaXMgY29tcHV0ZWQgaGVyZVxuICAgICAgLy8gKHJhY2UtZnJlZSkgYXMgYW4gZWZmZWN0aXZlIGBzaW5jZWAgPSBsYXRlc3RfaWQgLSBOOyBpdCBvdmVycmlkZXNcbiAgICAgIC8vIGBzaW5jZWAuIEEgY29sZCBtaWQtc2Vzc2lvbiBqb2luZXIgY2FuIHRodXMgY2F0Y2ggdXAgb24gYSBib3VuZGVkIHZvbHVtZVxuICAgICAgLy8gd2l0aG91dCBrbm93aW5nIGEgY3Vyc29yICgtLXNpbmNlKSBvciByZXBsYXlpbmcgdGhlIHdob2xlIGxvZ1xuICAgICAgLy8gKC0tZnJvbS1zdGFydCkuIE4gaXMgY2xhbXBlZCB0byDiiaUwOyBOPTAgYmFja2ZpbGxzIG5vdGhpbmcgKGxpdmUgb25seSkuXG4gICAgICBjb25zdCBsYXN0UmF3ID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJsYXN0XCIpO1xuICAgICAgY29uc3QgbGFzdE4gPSBsYXN0UmF3ICE9PSBudWxsID8gcGFyc2VJbnQobGFzdFJhdywgMTApIDogTnVtYmVyLk5hTjtcbiAgICAgIGNvbnN0IGhhc0xhc3QgPSBOdW1iZXIuaXNGaW5pdGUobGFzdE4pICYmIGxhc3ROID49IDA7XG4gICAgICBjb25zdCBlZmZlY3RpdmVTaW5jZSA9IGhhc0xhc3QgPyBNYXRoLm1heCgtMSwgY2gubmV4dF9pZCAtIDEgLSBsYXN0TikgOiBzaW5jZTtcbiAgICAgIGNvbnN0IGJhY2tsb2cgPSBlZmZlY3RpdmVTaW5jZSA+PSAwID8gcmVhZEJhY2tsb2cobmFtZSwgZWZmZWN0aXZlU2luY2UpIDogW107XG5cbiAgICAgIC8vIFdlIHN0YXNoIHRoZSBwZXItc3RyZWFtIGNsZWFudXAgZm4gb24gdGhlIGNvbnRyb2xsZXIgc28gY2FuY2VsKCkgY2FuXG4gICAgICAvLyByZWFjaCBpdCB2aWEgYHRoaXNgLiBSZWFkYWJsZVN0cmVhbSdzIHR5cGluZ3MgZG9uJ3QgbW9kZWwgYXJiaXRyYXJ5XG4gICAgICAvLyBwcm9wZXJ0aWVzLCBzbyB3ZSB1c2UgYSBzbWFsbCBhdWdtZW50aW5nIGludGVyZmFjZS5cbiAgICAgIHR5cGUgQ2xlYW51cENvbnRyb2xsZXIgPSBSZWFkYWJsZVN0cmVhbURlZmF1bHRDb250cm9sbGVyPFVpbnQ4QXJyYXk+ICYge1xuICAgICAgICBfX2NsZWFudXA/OiAoKSA9PiB2b2lkO1xuICAgICAgfTtcbiAgICAgIGNvbnN0IHN0cmVhbSA9IG5ldyBSZWFkYWJsZVN0cmVhbTxVaW50OEFycmF5Pih7XG4gICAgICAgIHN0YXJ0KGNvbnRyb2xsZXI6IENsZWFudXBDb250cm9sbGVyKSB7XG4gICAgICAgICAgY29uc3QgZW5jID0gbmV3IFRleHRFbmNvZGVyKCk7XG4gICAgICAgICAgY29uc3Qgc2VuZCA9IChtOiBNZXNzYWdlKSA9PiB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBjb250cm9sbGVyLmVucXVldWUoZW5jLmVuY29kZShgZGF0YTogJHtKU09OLnN0cmluZ2lmeShtKX1cXG5cXG5gKSk7XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgLy8gQ29udHJvbGxlciBjbG9zZWQ7IGRyb3AuXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfTtcbiAgICAgICAgICAvLyBJbml0aWFsIGV2ZW50OiBzdWJzY3JpYmVkIG1hcmtlciBzbyBjbGllbnQga25vd3MgdGhlIHN0cmVhbSBpc1xuICAgICAgICAgIC8vIGhvdC4gSW5jbHVkZXMgdGhlIGN1cnJlbnQgdG9waWMgc28gYSBmcmVzaGx5LWpvaW5lZCBhZ2VudCBoYXNcbiAgICAgICAgICAvLyBncm91bmRpbmcgY29udGV4dCBiZWZvcmUgYW55IG1lc3NhZ2VzIGFycml2ZS5cbiAgICAgICAgICBjb250cm9sbGVyLmVucXVldWUoXG4gICAgICAgICAgICBlbmMuZW5jb2RlKFxuICAgICAgICAgICAgICBgZXZlbnQ6IHN1YnNjcmliZWRcXG5kYXRhOiAke0pTT04uc3RyaW5naWZ5KHsgY2hhbm5lbDogbmFtZSwgc2luY2U6IGVmZmVjdGl2ZVNpbmNlLCBhczogYWxpYXMsIHRvcGljOiBjaC50b3BpYywgbGF0ZXN0X2lkOiBjaC5uZXh0X2lkIC0gMSwgY3JlYXRlZCwgYXJjaGl2ZWQgfSl9XFxuXFxuYCxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgKTtcbiAgICAgICAgICAvLyBSZXBsYXkgYmFja2xvZyBiZWZvcmUgbGl2ZSB0YWlsIGJlZ2lucy5cbiAgICAgICAgICBmb3IgKGNvbnN0IG0gb2YgYmFja2xvZykgc2VuZChtKTtcblxuICAgICAgICAgIGNvbnN0IGtleSA9IFN5bWJvbChgc3ViOiR7YWxpYXMgPz8gXCJhbm9uXCJ9YCk7XG4gICAgICAgICAgY2guc3Vic2NyaWJlcnMuc2V0KGtleSwgeyBhbGlhczogYWxpYXMgPz8gbnVsbCwgaHVtYW4sIGx1cmssIHNlbmQgfSk7XG5cbiAgICAgICAgICBsZXQgY2xlYW5lZFVwID0gZmFsc2U7XG4gICAgICAgICAgY29uc3QgY2xlYW51cCA9ICgpID0+IHtcbiAgICAgICAgICAgIGlmIChjbGVhbmVkVXApIHJldHVybjtcbiAgICAgICAgICAgIGNsZWFuZWRVcCA9IHRydWU7XG4gICAgICAgICAgICBjbGVhckludGVydmFsKGhiKTtcbiAgICAgICAgICAgIGNoLnN1YnNjcmliZXJzLmRlbGV0ZShrZXkpO1xuICAgICAgICAgIH07XG5cbiAgICAgICAgICAvLyBIZWFydGJlYXQgZXZlcnkgM3Mg4oCUIGJvdGggYSBrZWVwLWFsaXZlIHNpZ25hbCBhbmQgYSBsaXZlbmVzc1xuICAgICAgICAgIC8vIHByb2JlLiBJZiB0aGUgd3JpdGUgZmFpbHMsIHRoZSBjbGllbnQgaGFzIGRyb3BwZWQsIHNvIHdlXG4gICAgICAgICAgLy8gdW5yZWdpc3RlciB0aGUgc3Vic2NyaWJlciBzbyBgd2hvYCBkb2Vzbid0IHNob3cgZ2hvc3RzLlxuICAgICAgICAgIC8vIFNTRSBjb21tZW50cyAoYDpgKSBhcmUgaWdub3JlZCBieSB0aGUgc3BlYyBwYXJzZXIuXG4gICAgICAgICAgY29uc3QgaGIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBjb250cm9sbGVyLmVucXVldWUoZW5jLmVuY29kZShgOiBoYiAke0RhdGUubm93KCl9XFxuXFxuYCkpO1xuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgIGNsZWFudXAoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9LCAzMDAwKTtcblxuICAgICAgICAgIC8vIEhvbGQgYSByZWZlcmVuY2Ugc28gY2FuY2VsKCkgY2FuIGNsZWFuIHVwLlxuICAgICAgICAgIGNvbnRyb2xsZXIuX19jbGVhbnVwID0gY2xlYW51cDtcbiAgICAgICAgfSxcbiAgICAgICAgY2FuY2VsKHRoaXM6IHsgX19jbGVhbnVwPzogKCkgPT4gdm9pZCB9KSB7XG4gICAgICAgICAgdGhpcy5fX2NsZWFudXA/LigpO1xuICAgICAgICB9LFxuICAgICAgfSk7XG5cbiAgICAgIHJldHVybiBuZXcgUmVzcG9uc2Uoc3RyZWFtLCB7XG4gICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICBcImNvbnRlbnQtdHlwZVwiOiBcInRleHQvZXZlbnQtc3RyZWFtXCIsXG4gICAgICAgICAgXCJjYWNoZS1jb250cm9sXCI6IFwibm8tY2FjaGVcIixcbiAgICAgICAgICBjb25uZWN0aW9uOiBcImtlZXAtYWxpdmVcIixcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIFJlbGVhc2Ugb25seTogdGhlIHN1cmZhY2UncyBoYXNoZWQgY2h1bmtzLCBsaW5rZWQgcmVsYXRpdmVseSBmcm9tIC93YXRjaCxcbiAgLy8gYXJyaXZlIGFzIGJhcmUgZmlsZW5hbWVzIGF0IHRoZSByb290LiBEZXYgbmV2ZXIgc2VydmVzIGZyb20gZGlzdC8g4oCUIGFcbiAgLy8gY2hlY2tvdXQgY2FuIGNhcnJ5IGEgY29tbWl0dGVkIGRpc3QvIHRoYXQgaXMgc3RhbGUgYWdhaW5zdCBpdHMgc291cmNlLFxuICAvLyBhbmQgaW4gZGV2IEJ1bidzIHJvdXRlciBvd25zIHRoZSBidW5kbGUncyBhc3NldHMuXG4gIGlmIChNT0RFID09PSBcInJlbGVhc2VcIiAmJiBtZXRob2QgPT09IFwiR0VUXCIpIHtcbiAgICBjb25zdCBzZXJ2ZWQgPSBzZXJ2ZURpc3QocGF0aC5zbGljZSgxKSk7XG4gICAgaWYgKHNlcnZlZCkgcmV0dXJuIHNlcnZlZDtcbiAgfVxuXG4gIHJldHVybiBqc29uKHsgZXJyb3I6IFwibm90IGZvdW5kXCIsIHBhdGggfSwgeyBzdGF0dXM6IDQwNCB9KTtcbn1cblxubGV0IHNlcnZlcjogUmV0dXJuVHlwZTx0eXBlb2YgQnVuLnNlcnZlPiB8IG51bGwgPSBudWxsO1xubGV0IFNUQVJURURfQVQgPSBEYXRlLm5vdygpO1xuXG4vLyBUcnVlIGlmZiB0aGUgZmlsZSBleGlzdHMgYW5kIGl0cyB0cmltbWVkIGNvbnRlbnQgZXF1YWxzIGBleHBlY3RlZGAuIFVzZWQgc28gYVxuLy8gc3RhbGUgZGFlbW9uIG5ldmVyIGRlbGV0ZXMgbGlmZWN5Y2xlIGZpbGVzIGEgbmV3ZXIgZGFlbW9uIG5vdyBvd25zLlxuZXhwb3J0IGZ1bmN0aW9uIGZpbGVIYXNWYWx1ZShwYXRoOiBzdHJpbmcsIGV4cGVjdGVkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gZXhpc3RzU3luYyhwYXRoKSAmJiByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGYtOFwiKS50cmltKCkgPT09IGV4cGVjdGVkO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuZnVuY3Rpb24gc2h1dGRvd24oY29kZTogbnVtYmVyKSB7XG4gIHRyeSB7XG4gICAgaWYgKHNlcnZlciAmJiBmaWxlSGFzVmFsdWUoUE9SVF9GSUxFLCBTdHJpbmcoc2VydmVyLnBvcnQpKSkgdW5saW5rU3luYyhQT1JUX0ZJTEUpO1xuICAgIGlmIChmaWxlSGFzVmFsdWUoUElEX0ZJTEUsIFN0cmluZyhwcm9jZXNzLnBpZCkpKSB1bmxpbmtTeW5jKFBJRF9GSUxFKTtcbiAgfSBjYXRjaCB7fVxuICBpZiAoc2VydmVyKSB7XG4gICAgUHJvbWlzZS5yYWNlKFtzZXJ2ZXIuc3RvcCh0cnVlKSwgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMjAwKSldKS5maW5hbGx5KCgpID0+XG4gICAgICBwcm9jZXNzLmV4aXQoY29kZSksXG4gICAgKTtcbiAgfSBlbHNlIHtcbiAgICBwcm9jZXNzLmV4aXQoY29kZSk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gbWFpbigpIHtcbiAgLy8gLS0tIG1vZGUsIHJlc29sdmVkIEJFRk9SRSBhbnkgZmlsZXN5c3RlbSB3cml0ZSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBkZXY6IGEgZHluYW1pYyBzdHJpbmctbGl0ZXJhbCBpbXBvcnQga2VlcHMgdGhlIHN1cmZhY2UgZ3JhcGggb2ZmIHRoZSBtb2R1bGVcbiAgLy8gbG9hZCBwYXRoIChDb250cmFjdCAxKSDigJQgQnVuIGJ1bmRsZXMgdGhlIC50c3ggZ3JhcGggKyBUYWlsd2luZCBhdCBzZXJ2ZVxuICAvLyB0aW1lLCByZWFkaW5nIGJ1bmZpZy50b21sIGZyb20gY3dkLCB3aGljaCBjbGkudHMgcGlucyB0byBzcmMvZ3JhcGV2aW5lL1xuICAvLyAoQ29udHJhY3QgNSkuIEEgZm9yY2VkLWRldiBib290IGF0IGEgc3VyZmFjZS1mcmVlIGRlc3RpbmF0aW9uIG11c3QgZGllXG4gIC8vIEhFUkUsIGF0IHRoZSBpbXBvcnQsIGhhdmluZyB3cml0dGVuIG5vdGhpbmc6IG5vIHBvcnQgZmlsZSwgbm8gcGlkIGZpbGUsIG5vXG4gIC8vIGNoYW5uZWxzIGRpciDigJQgc28gYSBDTEkgcG9sbGluZyBmb3IgdGhlIHBvcnQgZmlsZSBzZWVzIGEgY2xlYW4gZmFpbHVyZVxuICAvLyByYXRoZXIgdGhhbiBhIGhhbGYtYm9ybiBkYWVtb24uIHJlbGVhc2U6IGRpc3QvIGlzIHN0YXRpYyBhbmQgcHJlLWJ1aWx0XG4gIC8vIChDb250cmFjdCAyKSDigJQgL3dhdGNoIGFuZCB0aGUgaGFzaGVkIGNodW5rcyBhcmUgYW5zd2VyZWQgYnkgc2VydmVEaXN0KCkgaW5cbiAgLy8gaGFuZGxlKCksIHNvIHRoaXMgYnJhbmNoIG5ldmVyIHRvdWNoZXMgc3VyZmFjZSBzb3VyY2Ugb3IgYnVuZmlnLnRvbWwgYW5kXG4gIC8vIG5ldmVyIG5lZWRzIGVpdGhlciB0byBleGlzdC4gVGhpcyBpcyB0aGUgT05FIHNyYy8tbmFtaW5nIHNwZWNpZmllciBpbiB0aGVcbiAgLy8gZGVwbG95ZWQgc3BlbGwgKGdyaW1vaXJlL2ltcG9ydC1ib3VuZGFyeS13YXJkcy50ZXN0LnRzIHBpbnMgaXQpLlxuICBjb25zdCBkZXZJbmRleCA9XG4gICAgTU9ERSA9PT0gXCJkZXZcIlxuICAgICAgPyAoYXdhaXQgaW1wb3J0KFwiLi4vLi4vLi4vLi4vLi4vc3JjL2dyYXBldmluZS9zdXJmYWNlL2luZGV4Lmh0bWxcIikpLmRlZmF1bHRcbiAgICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCByb3V0ZXMgPSAoZGV2SW5kZXggPyB7IFwiL3dhdGNoXCI6IGRldkluZGV4IH0gOiB7fSkgYXMgUmVjb3JkPHN0cmluZywgbmV2ZXI+O1xuXG4gIGVuc3VyZURpcnMoKTtcblxuICAvLyBEZWxldGUgYW4gZXhwaXJlZCBob2xkIGZpbGUgZm9yIHRpZGluZXNzICh0aGUgaG9sZCBpcyBlbmZvcmNlZCBDTEktc2lkZSkuXG4gIHRyeSB7XG4gICAgaWYgKGV4aXN0c1N5bmMoSE9MRF9GSUxFKSkge1xuICAgICAgY29uc3QgdW50aWwgPSBwYXJzZUludChyZWFkRmlsZVN5bmMoSE9MRF9GSUxFLCBcInV0Zi04XCIpLnRyaW0oKSwgMTApO1xuICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUodW50aWwpIHx8IHVudGlsIDw9IERhdGUubm93KCkpIHVubGlua1N5bmMoSE9MRF9GSUxFKTtcbiAgICB9XG4gIH0gY2F0Y2gge31cblxuICAvLyBDaGVjayBpZiBhIGRhZW1vbiBpcyBhbHJlYWR5IHJ1bm5pbmcgYnkgcmVhZGluZyB0aGUgcG9ydCBmaWxlIGFuZFxuICAvLyB0cnlpbmcgdG8gcGluZyBpdC4gSWYgYWxpdmUsIGV4aXQgMCBxdWlldGx5IOKAlCBjYWxsZXIgd2lsbCBkaXNjb3Zlci5cbiAgaWYgKGV4aXN0c1N5bmMoUE9SVF9GSUxFKSAmJiBleGlzdHNTeW5jKFBJRF9GSUxFKSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwb3J0ID0gcGFyc2VJbnQocmVhZEZpbGVTeW5jKFBPUlRfRklMRSwgXCJ1dGYtOFwiKS50cmltKCksIDEwKTtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vYCwge1xuICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoNTAwKSxcbiAgICAgIH0pO1xuICAgICAgaWYgKHJlcy5vaykge1xuICAgICAgICBjb25zb2xlLmVycm9yKGBkYWVtb24gYWxyZWFkeSBydW5uaW5nIG9uIHBvcnQgJHtwb3J0fWApO1xuICAgICAgICBwcm9jZXNzLmV4aXQoMCk7XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBTdGFsZTsgY2xlYW4gdXAuXG4gICAgICB0cnkge1xuICAgICAgICB1bmxpbmtTeW5jKFBPUlRfRklMRSk7XG4gICAgICB9IGNhdGNoIHt9XG4gICAgICB0cnkge1xuICAgICAgICB1bmxpbmtTeW5jKFBJRF9GSUxFKTtcbiAgICAgIH0gY2F0Y2gge31cbiAgICB9XG4gIH1cblxuICBzZXJ2ZXIgPSBCdW4uc2VydmUoe1xuICAgIGhvc3RuYW1lOiBcIjEyNy4wLjAuMVwiLFxuICAgIHBvcnQ6IDAsIC8vIE9TLWFzc2lnbmVkXG4gICAgLy8gU1NFIHN0cmVhbXMgYXJlIGxvbmctbGl2ZWQgYW5kIHNpbGVudCBjbGllbnTihpJzZXJ2ZXIuIERlZmF1bHQgMTBzXG4gICAgLy8gaWRsZVRpbWVvdXQgY2xvc2VzIHRoZW0gcHJlbWF0dXJlbHk7IHNldCB0byAyNTUgKEJ1bidzIG1heCDigJQgMCBpc24ndFxuICAgIC8vIGhvbm9yZWQgb24gYWxsIHBhdGhzKS4gT3VyIG93biAzcyBoZWFydGJlYXQga2VlcHMgY2xpZW50cyBhd2FyZS5cbiAgICBpZGxlVGltZW91dDogMjU1LFxuICAgIC8vIGRldjogdGhlIEhUTUxCdW5kbGUgYXQgL3dhdGNoIChCdW4gc2VydmVzIGl0cyBhc3NldHMgaXRzZWxmKS4gcmVsZWFzZTpcbiAgICAvLyBubyByb3V0ZXMg4oCUIGhhbmRsZSgpIHNlcnZlcyBkaXN0Ly4gQnVuJ3MgUm91dGVzIHR5cGUgdGllcyB0aGUgdmFsdWUnc1xuICAgIC8vIHR5cGUgdG8gdGhlIGxpdGVyYWwgb2JqZWN0IHNoYXBlLCBzbyB0aGUgbW9kZS10ZXJuYXJ5IHVuaW9uIGlzIGNhc3QuXG4gICAgcm91dGVzLFxuICAgIGRldmVsb3BtZW50OiB7IGhtcjogTU9ERSA9PT0gXCJkZXZcIiB9LFxuICAgIGZldGNoOiBoYW5kbGUsXG4gIH0pO1xuXG4gIEJ1bi53cml0ZShQT1JUX0ZJTEUsIFN0cmluZyhzZXJ2ZXIucG9ydCkpO1xuICBCdW4ud3JpdGUoUElEX0ZJTEUsIFN0cmluZyhwcm9jZXNzLnBpZCkpO1xuICBTVEFSVEVEX0FUID0gRGF0ZS5ub3coKTtcbiAgY29uc29sZS5lcnJvcihcbiAgICBgZ3JhcGV2aW5lIGRhZW1vbiBsaXN0ZW5pbmcgb24gaHR0cDovLzEyNy4wLjAuMToke3NlcnZlci5wb3J0fSAocGlkICR7cHJvY2Vzcy5waWR9LCBtb2RlICR7TU9ERX0pYCxcbiAgKTtcbiAgY29uc29sZS5lcnJvcihgZGF0YSBkaXI6ICR7REFUQV9ESVJ9YCk7XG5cbiAgcHJvY2Vzcy5vbihcIlNJR0lOVFwiLCAoKSA9PiBzaHV0ZG93bigwKSk7XG4gIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsICgpID0+IHNodXRkb3duKDApKTtcbn1cblxuLy8g4puUIE5PIGBpbXBvcnQubWV0YS5tYWluYCBCTE9DSywgQU5EIElUUyBBQlNFTkNFIElTIFRIRSBTVEVQIChwbGF5Ym9vayBCMykuXG4vLyBgZGlzdC9kYWVtb24uanNgIGlzIElNUE9SVEVEIGJ5IGBzY3JpcHRzL2RhZW1vbi50c2AsIG5ldmVyIGV4ZWN1dGVkIGFzIHRoZVxuLy8gcHJvY2VzcyBlbnRyeSwgc28gdGhlIGd1YXJkIHdvdWxkIG5ldmVyIHJ1bjogdGhlIGRhZW1vbiB3b3VsZCBib290LCBzZXJ2ZVxuLy8gbm90aGluZyBhbmQgZXhpdCAwLCBhbmQgZXZlcnkgdGVzdCB3b3VsZCBmYWlsIGFzIFwibmV2ZXIgYm91bmQgYSBwb3J0XCIuXG4vL1xuLy8g4puUIEFORCBOTyBTRUNPTkQgRU5UUlkgSVMgT0ZGRVJFRCBGUk9NIFRISVMgQUREUkVTUywgREVMSUJFUkFURUxZLiBFdmVyeSBwYXRoXG4vLyB0aGlzIGZpbGUgY29tcHV0ZXMgaXMgYW5jaG9yZWQgYXQgYFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIilgLFxuLy8gd2hpY2ggaXMgdGhlIHNraWxsIHJvb3QgT05MWSBmcm9tIGBkaXN0L2AuIFJ1biBmcm9tIGBzcmMvZ3JhcGV2aW5lL2JhY2tlbmQvYFxuLy8gaXQgY29tcHV0ZXMgYHNyYy9ncmFwZXZpbmUvYCwgZmluZHMgbm8gYGRpc3QvaW5kZXguaHRtbGAsIHJlc29sdmVzIERFViwgYW5kXG4vLyB0aGVuIGZhaWxzIHRoZSBkZXYgaW1wb3J0IGZyb20gdGhlIHdyb25nIGFuY2hvciDigJQgd2l0aCBhIGRpYWdub3N0aWMgY29tcHV0ZWRcbi8vIGJ5IHRoZSBidWcgaXQgaXMgcmVwb3J0aW5nIChENTcpLiBUaGUgYXJ0aWZhY3QgaXMgdGhlIG9uZSBhZGRyZXNzIHRoaXNcbi8vIGFyaXRobWV0aWMgd2FzIGV2ZXIgdHJ1ZSBhdC5cbi8vXG4vLyDim5QgQU5EIFRIRSBMQVVOQ0hFUiBUSEFUIElNUE9SVFMgVEhJUyBJUyBgcHJvY2Vzcy5leGl0Q29kZWAgKyBBIE5BVFVSQUxcbi8vIFJFVFVSTiwgTk9UIFRIRSBURVJNSU5BTCBFWElUIFRIRSBPVEhFUiBGSVZFIERBRU1PTlMgU0hJUC4gYG1haW4oKWAgcmVzb2x2ZXNcbi8vIHRoZSBpbnN0YW50IGBCdW4uc2VydmVgIGJpbmRzOyB0aGUgRVZFTlQgTE9PUCBpcyB3aGF0IGhvbGRzIHRoaXMgcHJvY2VzcyB1cCxcbi8vIGFuZCBhbiBleHBsaWNpdCBleGl0IGF0IHRoZSBsYXVuY2hlciB0ZXJtaW5hdGVzIGEgbGl2ZSBzZXJ2ZXIgbWlsbGlzZWNvbmRzXG4vLyBhZnRlciBpdCBib3VuZCAoRDY5LCBkcml2ZW4gYm90aCB3YXlzKS4gVGhlIHJlYXNvbiBsaXZlcyBpbiBmdWxsIGF0XG4vLyBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dyYXBldmluZS9zY3JpcHRzL2RhZW1vbi50c2A7IGl0IGlzIG5hbWVkIGhlcmUgdG9vXG4vLyBiZWNhdXNlIHRoaXMgaXMgdGhlIGZpbGUgd2hvc2Ugc2hhcGUgbWFrZXMgaXQgdHJ1ZS5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTx1bmRlZmluZWQ+IHtcbiAgYXdhaXQgbWFpbigpO1xuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7Ozs7QUFvREE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQWNBO0FBQ0E7QUFDQTtBQUVBLElBQU0sYUFBYSxRQUFRLGNBQWMsWUFBWSxHQUFHLENBQUM7QUFJekQsSUFBTSxhQUFhLEtBQUssWUFBWSxJQUFJO0FBQ3hDLElBQU0sV0FBVyxLQUFLLFlBQVksTUFBTTtBQU9qQyxTQUFTLFdBQVcsR0FBc0I7QUFBQSxFQUMvQyxNQUFNLFdBQVcsUUFBUSxJQUFJO0FBQUEsRUFDN0IsSUFBSSxhQUFhLFNBQVMsYUFBYTtBQUFBLElBQVcsT0FBTztBQUFBLEVBQ3pELE9BQU8sV0FBVyxLQUFLLFVBQVUsWUFBWSxDQUFDLElBQUksWUFBWTtBQUFBO0FBRWhFLElBQU0sT0FBTyxZQUFZO0FBRXpCLElBQU0sdUJBQStDO0FBQUEsRUFDbkQsU0FBUztBQUFBLEVBQ1QsT0FBTztBQUFBLEVBQ1AsUUFBUTtBQUFBLEVBQ1IsU0FBUztBQUFBLEVBQ1QsUUFBUTtBQUFBLEVBQ1IsUUFBUTtBQUNWO0FBT0EsU0FBUyxTQUFTLENBQUMsS0FBOEI7QUFBQSxFQUMvQyxJQUFJLENBQUMsT0FBTyxJQUFJLFNBQVMsSUFBSSxLQUFLLElBQUksU0FBUyxHQUFHO0FBQUEsSUFBRyxPQUFPO0FBQUEsRUFDNUQsTUFBTSxPQUFPLEtBQUssVUFBVSxHQUFHO0FBQUEsRUFDL0IsSUFBSSxDQUFDLFdBQVcsSUFBSTtBQUFBLElBQUcs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
