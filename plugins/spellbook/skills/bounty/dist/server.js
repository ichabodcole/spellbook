#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// src/bounty/backend/server.ts
import {
  accessSync,
  appendFileSync,
  copyFileSync,
  existsSync as existsSync3,
  constants as fsConstants,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync2,
  readFileSync as readFileSync4,
  statSync as statSync2,
  unlinkSync as unlinkSync3
} from "fs";
import { homedir, tmpdir } from "os";
import { dirname as dirname2, join as join3, resolve } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";

// plugins/spellbook/skills/bounty/shared/types.ts
var VALID_STATUS = ["todo", "doing", "review", "done"];
var SIZE_MINUTES = { S: 5, M: 10, L: 20 };

// plugins/spellbook/skills/bounty/shared/predicates.ts
function expectedMinutes(task) {
  if (typeof task.expect === "number" && task.expect > 0)
    return task.expect;
  if (task.size && task.size in SIZE_MINUTES)
    return SIZE_MINUTES[task.size];
  return;
}
function liveBlockerCount(task, tasks) {
  return (task.blockedBy ?? []).filter((bid) => {
    const b = tasks.find((t) => t.id === bid);
    return b !== undefined && b.status !== "done";
  }).length;
}
function isBlocked(task, tasks) {
  return liveBlockerCount(task, tasks) > 0;
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

// src/bounty/backend/heartbeat.ts
var IDLE_TIMEOUT_SEC = idleTimeoutSec(process.env.BOUNTY_IDLE_TIMEOUT_SEC, MAX_IDLE_TIMEOUT_SEC);
var SSE_HEARTBEAT_MS = heartbeatMs(process.env.BOUNTY_HEARTBEAT_MS, IDLE_TIMEOUT_SEC, DEFAULT_HEARTBEAT_MS);
var TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

// src/bounty/backend/lock.ts
import { linkSync, mkdirSync, readFileSync as readFileSync3, renameSync as renameSync2, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "fs";
import { dirname, join as join2 } from "path";
function lockPath(home, id) {
  return join2(home, "locks", `${id}.lock`);
}
function readLock(path) {
  try {
    const raw = JSON.parse(readFileSync3(path, "utf8"));
    return typeof raw.pid === "number" ? raw : null;
  } catch {
    return null;
  }
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function holderLiveness(holder, id) {
  if (!Number.isInteger(holder.pid) || holder.pid <= 0)
    return { state: "stale" };
  if (holder.pid === process.pid)
    return { state: "stale" };
  if (!pidAlive(holder.pid))
    return { state: "stale" };
  let ps;
  try {
    ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(holder.pid)]);
  } catch (e) {
    return {
      state: "unknown",
      why: `\`ps\` could not be run (${e instanceof Error ? e.message : String(e)})`
    };
  }
  const argv = new TextDecoder().decode(ps.stdout ?? new Uint8Array);
  if (ps.exitCode !== 0) {
    if (!pidAlive(holder.pid))
      return { state: "stale" };
    const err = new TextDecoder().decode(ps.stderr ?? new Uint8Array).trim();
    return {
      state: "unknown",
      why: `\`ps\` exited ${ps.exitCode}${err ? ` (${err.split(`
`)[0]})` : ""} for a pid that is alive`
    };
  }
  if (!argv.trim())
    return { state: "unknown", why: "`ps` answered with no command line" };
  return argv.includes(`--id ${id}`) ? { state: "live" } : { state: "stale" };
}
function unlinkQuiet(path) {
  try {
    unlinkSync2(path);
  } catch {}
}
function unknownHolderRefusal(path, id, pid, why) {
  return {
    message: `board ${id} cannot start: its lock ${path} is held by pid ${pid}, which is alive, and bounty cannot tell whether it is this board's daemon because ${why}; refusing rather than risk two daemons for one board`,
    hint: `put a working \`ps\` on PATH and run open again; or, if pid ${pid} is not a bounty daemon for ${id} (check: ps -o command= -p ${pid}), remove the lock (rm ${path}) and run open again`
  };
}
async function acquireLock(path, id, opts) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync2(tmp, JSON.stringify({ pid: process.pid }));
  const waitUntil = Date.now() + opts.closingWaitMs;
  try {
    for (let attempt = 0;attempt < 50; attempt++) {
      try {
        linkSync(tmp, path);
        return { ok: true };
      } catch (e) {
        if (e.code !== "EEXIST")
          throw e;
      }
      const holder = readLock(path);
      const live = holder ? holderLiveness(holder, id) : null;
      if (holder && live && live.state !== "stale") {
        if (holder.closing && Date.now() < waitUntil) {
          await Bun.sleep(50);
          continue;
        }
        return live.state === "unknown" ? { ok: false, holder, unknown: live.why } : { ok: false, holder };
      }
      const aside = `${path}.stale.${process.pid}`;
      try {
        renameSync2(path, aside);
      } catch {
        continue;
      }
      const moved = readLock(aside);
      const movedLive = moved ? holderLiveness(moved, id) : null;
      if (moved && movedLive && movedLive.state !== "stale") {
        try {
          linkSync(aside, path);
        } catch {}
        unlinkQuiet(aside);
        return movedLive.state === "unknown" ? { ok: false, holder: moved, unknown: movedLive.why } : { ok: false, holder: moved };
      }
      unlinkQuiet(aside);
    }
    return { ok: false, holder: readLock(path) };
  } finally {
    unlinkQuiet(tmp);
  }
}
function updateLock(path, holder) {
  if (readLock(path)?.pid !== process.pid)
    return;
  const tmp = `${path}.${process.pid}.upd`;
  try {
    writeFileSync2(tmp, JSON.stringify(holder));
    renameSync2(tmp, path);
  } catch {
    unlinkQuiet(tmp);
  }
}
function releaseLock(path) {
  if (readLock(path)?.pid === process.pid)
    unlinkQuiet(path);
}

// src/bounty/backend/server.ts
var SCRIPT_DIR = dirname2(fileURLToPath(import.meta.url));
var SKILL_ROOT = join3(SCRIPT_DIR, "..");
var DIST_DIR = join3(SKILL_ROOT, "dist");
function resolveMode2() {
  return resolveMode(DIST_DIR);
}
function serveDist(path) {
  return serveFromDist(DIST_DIR, path === "/" ? "index.html" : path.slice(1));
}
var BOUNTY_HOME = process.env.BOUNTY_HOME ?? join3(homedir(), ".bounty");
var SNAPSHOTS_DIR = join3(BOUNTY_HOME, "snapshots");
var SHUTDOWN_WATCHDOG_MS = Number(process.env.BOUNTY_SHUTDOWN_WATCHDOG_MS ?? 5000);
var DAEMON_LOG = join3(BOUNTY_HOME, "daemon.log");
var MAX_STATUS_HISTORY = 20;
function computeDuePokes(tasks, pokeState, now) {
  const next = new Map;
  const pokes = [];
  for (const task of tasks) {
    if (task.status !== "doing" || task.enteredStatusAt === undefined)
      continue;
    const exp = expectedMinutes(task);
    if (exp === undefined)
      continue;
    if (isBlocked(task, tasks))
      continue;
    const expMs = exp * 60000;
    const overdueByMs = now - (task.enteredStatusAt + expMs);
    if (overdueByMs < 0)
      continue;
    const last = pokeState.get(task.id);
    if (last === undefined || now - last >= expMs) {
      pokes.push({ taskId: task.id, owner: task.owner, overdueByMs, expectedMinutes: exp });
      next.set(task.id, now);
    } else {
      next.set(task.id, last);
    }
  }
  return { pokes, pokeState: next };
}
function snapshotTaskCount(path) {
  try {
    const parsed = JSON.parse(readFileSync4(path, "utf8"));
    return Array.isArray(parsed.tasks) ? parsed.tasks.length : null;
  } catch {
    return null;
  }
}
function snapshotProblem(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return "the snapshot is not a JSON object";
  const tasks = parsed.tasks;
  if (!Array.isArray(tasks))
    return `the snapshot's \`tasks\` is ${tasks === undefined ? "missing" : `not an array (${tasks === null ? "null" : typeof tasks})`}`;
  return null;
}
function unreadableReason(path) {
  const raw = readFileSync4(path, "utf8");
  try {
    return snapshotProblem(JSON.parse(raw));
  } catch (e) {
    return `it is not valid JSON (${e instanceof Error ? e.message : String(e)})`;
  }
}
function snapshotPresent(path) {
  try {
    lstatSync2(path);
    return true;
  } catch (e) {
    if (e.code === "ENOENT")
      return false;
    throw e;
  }
}
function boardHoldsSnapshot(board, parsed) {
  const diff = snapshotDiff(board, parsed);
  return diff !== null && !diff.fields.length && !diff.changed.length && !diff.missing;
}
var NORMALISED_WHEN_EMPTY = new Set(["tags", "statusHistory"]);
function snapshotDiff(board, parsed) {
  if (snapshotProblem(parsed))
    return null;
  const snap = parsed;
  const b = board;
  const fields = Object.keys(snap).filter((k) => k !== "tasks" && canonicalJson(snap[k]) !== canonicalJson(b[k])).sort();
  const have = new Map(board.tasks.map((t) => [t.id, taskData(t)]));
  const seen = new Set;
  const changed = [];
  let missing = 0;
  for (const raw of snap.tasks) {
    const id = raw?.id;
    const mine = typeof id === "string" && !seen.has(id) ? have.get(id) : undefined;
    if (typeof id === "string")
      seen.add(id);
    if (typeof id !== "string" || mine === undefined) {
      missing++;
      continue;
    }
    const theirs = taskData(raw);
    const differ = [...new Set([...Object.keys(theirs), ...Object.keys(mine)])].filter((k) => canonicalJson(theirs[k]) !== canonicalJson(mine[k])).sort();
    if (differ.length)
      changed.push({ id, fields: differ });
  }
  return { fields, changed, missing };
}
function canonicalJson(v) {
  return JSON.stringify(v, (_k, val) => val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a < b ? -1 : 1)) : val);
}
function taskData(t) {
  if (!t || typeof t !== "object" || Array.isArray(t))
    return {};
  return Object.fromEntries(Object.entries(t).filter(([k, val]) => !(NORMALISED_WHEN_EMPTY.has(k) && Array.isArray(val) && val.length === 0)));
}
function snapshotFix(path) {
  const dir = dirname2(path);
  try {
    if (!statSync2(dir).isDirectory())
      return `${dir} is a file where bounty keeps its snapshots folder: move it aside`;
  } catch {}
  try {
    if (statSync2(path).isDirectory())
      return `remove the directory ${path} (a snapshot is a file)`;
  } catch {}
  if (existsSync3(path)) {
    try {
      accessSync(path, fsConstants.R_OK | fsConstants.W_OK);
    } catch {
      return `make ${path} readable and writable`;
    }
  }
  try {
    accessSync(dir, fsConstants.W_OK);
  } catch {
    return `make the folder ${dir} writable`;
  }
  return `make ${path} and its folder writable, or free some disk space`;
}
function shouldRotateSnapshot(priorTaskCount, nextTaskCount, alreadyRotatedThisSession) {
  if (alreadyRotatedThisSession)
    return false;
  if (priorTaskCount === null)
    return false;
  return nextTaskCount < priorTaskCount;
}
function transitionStamp(prev, status, now) {
  const statusHistory = [...prev ?? [], { status, at: now }].slice(-MAX_STATUS_HISTORY);
  return { enteredStatusAt: now, statusHistory };
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
function htmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}
function randHex(bytes) {
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
function cleanTags(value) {
  if (!Array.isArray(value))
    return [];
  const out = [];
  for (const x of value) {
    if (typeof x !== "string")
      continue;
    const t = x.trim();
    if (t && !out.includes(t))
      out.push(t);
  }
  return out;
}
function taskRejection(t) {
  if (!t || typeof t !== "object")
    return "not a JSON object";
  const cand = t;
  if (typeof cand.id !== "string")
    return "missing `id` (string, REQUIRED \u2014 init does not mint ids; `add` does)";
  if (typeof cand.title !== "string")
    return "missing `title` (string, required)";
  if (typeof cand.status !== "string" || !VALID_STATUS.includes(cand.status))
    return `invalid \`status\` (required, one of ${VALID_STATUS.join(" | ")})`;
  if (cand.notes !== undefined && typeof cand.notes !== "string")
    return "`notes` must be a string";
  if (cand.owner !== undefined && typeof cand.owner !== "string")
    return "`owner` must be a string";
  if (cand.blockedBy !== undefined && (!Array.isArray(cand.blockedBy) || cand.blockedBy.some((x) => typeof x !== "string")))
    return "`blockedBy` must be an array of strings";
  return null;
}
function describeDrops(dropped) {
  return dropped.map((d) => `[${d.index}]${d.id !== null ? ` ${d.id}` : " (no id)"}: ${d.reason}`).join("; ");
}
function describeUnheld(dropped, diff) {
  const parts = [];
  if (dropped.length)
    parts.push(`it dropped ${dropped.length} task(s): ${describeDrops(dropped)}`);
  if (diff?.changed.length)
    parts.push(`changed: ${diff.changed.map((c) => `${c.id} (${c.fields.join(", ")})`).join(", ")}`);
  if (diff?.fields.length)
    parts.push(`${diff.fields.length === 1 ? "a board field" : "board fields"} (${diff.fields.join(", ")})`);
  return parts.length ? parts.join("; ") : "it differs from the file in a way this build cannot name";
}
function validateTask(t) {
  if (taskRejection(t) !== null)
    return null;
  const cand = t;
  const { id, title } = cand;
  if (typeof id !== "string" || typeof title !== "string")
    return null;
  const tags = cleanTags(cand.tags);
  const enteredStatusAt = typeof cand.enteredStatusAt === "number" ? cand.enteredStatusAt : undefined;
  const statusHistory = Array.isArray(cand.statusHistory) ? cand.statusHistory.filter((h) => !!h && typeof h === "object" && VALID_STATUS.includes(h.status) && typeof h.at === "number") : undefined;
  const size = typeof cand.size === "string" && cand.size in SIZE_MINUTES ? cand.size : undefined;
  const expect = typeof cand.expect === "number" && cand.expect > 0 ? cand.expect : undefined;
  return {
    id,
    title,
    status: cand.status,
    ...cand.notes !== undefined ? { notes: cand.notes } : {},
    ...cand.owner !== undefined ? { owner: cand.owner } : {},
    ...cand.blockedBy !== undefined ? { blockedBy: cand.blockedBy } : {},
    ...tags.length ? { tags } : {},
    ...enteredStatusAt !== undefined ? { enteredStatusAt } : {},
    ...statusHistory?.length ? { statusHistory } : {},
    ...size !== undefined ? { size } : {},
    ...expect !== undefined ? { expect } : {}
  };
}
function applyTaskAdd(state, task, now = Date.now()) {
  if (state.tasks.some((t) => t.id === task.id))
    return false;
  const stamped = task.enteredStatusAt === undefined ? { ...task, ...transitionStamp(task.statusHistory, task.status, now) } : task;
  state.tasks.push(stamped);
  return true;
}
function applyTaskUpdate(state, id, patch, now = Date.now()) {
  const idx = state.tasks.findIndex((t) => t.id === id);
  if (idx === -1)
    return false;
  if (patch.status && !VALID_STATUS.includes(patch.status)) {
    const { status: _drop, ...rest } = patch;
    patch = rest;
  }
  const prev = state.tasks[idx];
  if (prev === undefined)
    return false;
  const merged = { ...prev, ...patch };
  if (patch.status !== undefined && patch.status !== prev.status) {
    Object.assign(merged, transitionStamp(prev.statusHistory, patch.status, now));
  }
  state.tasks[idx] = merged;
  return true;
}
function applyTaskRemove(state, id) {
  const idx = state.tasks.findIndex((t) => t.id === id);
  if (idx === -1)
    return false;
  state.tasks.splice(idx, 1);
  return true;
}
function applyTaskMove(state, id, status, index, now = Date.now()) {
  const fromIdx = state.tasks.findIndex((t) => t.id === id);
  if (fromIdx === -1)
    return -1;
  const [task] = state.tasks.splice(fromIdx, 1);
  if (task === undefined)
    return -1;
  if (task.status !== status) {
    Object.assign(task, { status }, transitionStamp(task.statusHistory, status, now));
  }
  const clamped = Math.max(0, Math.floor(index));
  let seen = 0;
  let insertAt = state.tasks.length;
  for (const [i, t] of state.tasks.entries()) {
    if (t.status !== status)
      continue;
    if (seen === clamped) {
      insertAt = i;
      break;
    }
    seen++;
  }
  state.tasks.splice(insertAt, 0, task);
  return insertAt;
}
function isNoOpUpdate(state, id, patch) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task)
    return false;
  let eff = patch;
  if (eff.status && !VALID_STATUS.includes(eff.status)) {
    const { status: _drop, ...rest } = eff;
    eff = rest;
  }
  return Object.keys(eff).every((k) => task[k] === eff[k]);
}
function isNoOpMove(state, id, status, index) {
  if (!state.tasks.some((t) => t.id === id))
    return false;
  const columnView = (s) => VALID_STATUS.map((st) => s.tasks.filter((t) => t.status === st).map((t) => t.id).join(",")).join("|");
  const before = columnView(state);
  const probe = { ...state, tasks: state.tasks.map((t) => ({ ...t })) };
  applyTaskMove(probe, id, status, index);
  return before === columnView(probe);
}
async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        title: { type: "string", default: "Bounty Board" },
        timeout: { type: "string", default: "7200" },
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
  const logDaemon = (reason2, extra) => {
    try {
      mkdirSync2(BOUNTY_HOME, { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        session_id: sessionId,
        pid: process.pid,
        reason: reason2,
        ...extra
      });
      appendFileSync(DAEMON_LOG, `${line}
`);
    } catch {}
  };
  let requestShutdown = null;
  const onFatal = (signal, code2) => () => {
    if (requestShutdown)
      requestShutdown(code2, "signal", signal);
    else {
      logDaemon("signal", { signal, phase: "pre-init" });
      process.exit(code2);
    }
  };
  process.on("uncaughtException", (e) => {
    logDaemon("uncaughtException", {
      error: String(e),
      stack: e instanceof Error ? e.stack : undefined
    });
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    logDaemon("unhandledRejection", { error: String(e) });
  });
  process.on("SIGTERM", onFatal("SIGTERM", 143));
  process.on("SIGINT", onFatal("SIGINT", 130));
  const lockFile = sessionId ? lockPath(BOUNTY_HOME, sessionId) : null;
  if (lockFile) {
    const got = await acquireLock(lockFile, sessionId, {
      closingWaitMs: SHUTDOWN_WATCHDOG_MS + 1000
    });
    if (!got.ok) {
      const h = got.holder;
      if (got.unknown !== undefined && h) {
        const r = unknownHolderRefusal(lockFile, sessionId, h.pid, got.unknown);
        logDaemon("lockLivenessUnknown", { holder: h, lock: lockFile, why: got.unknown });
        process.stderr.write(`bounty: ${r.message}
  hint: ${r.hint}
`);
        return 6;
      }
      logDaemon("lockHeld", { holder: h });
      process.stderr.write(`bounty: board ${sessionId} is already running${h ? ` (pid ${h.pid}${h.port ? `, port ${h.port}` : ""})` : ""}; this daemon exits without touching it
`);
      return 6;
    }
  }
  const mode = resolveMode2();
  let devIndex;
  if (mode === "dev") {
    try {
      devIndex = (await import("../../../../../src/bounty/surface/index.html")).default;
    } catch (e) {
      process.stderr.write(`bounty: cannot start in dev mode \u2014 the surface source is missing.
` + `  needed: src/bounty/surface/index.html (relative to the repo root)
  reason: ${e instanceof Error ? e.message : String(e)}
  A published spell ships a built dist/ and resolves to release mode; dev mode
  needs the repo. Unset SPELLBOOK_SURFACE_MODE, or run from a checkout.
`);
      return 2;
    }
  }
  const routes = devIndex ? { "/": devIndex } : {};
  const assetsDir = join3(SCRIPT_DIR, "..", "assets");
  const state = { title: v.title, tasks: [] };
  let restoreFailed = null;
  let restoreDropped = [];
  let snapshotBackupFailed = null;
  let restoredFromElsewhere = false;
  if (v.restore) {
    const restoreArg = v.restore;
    const restorePath = existsSync3(restoreArg) ? restoreArg : join3(SNAPSHOTS_DIR, `${restoreArg}.json`);
    try {
      const snap = JSON.parse(readFileSync4(restorePath, "utf8"));
      const problem = snapshotProblem(snap);
      if (problem)
        throw new Error(problem);
      const merged = { title: state.title, tasks: [], ...snap };
      if (typeof merged.title === "string")
        state.title = merged.title;
      const kept = [];
      const dropped = [];
      const firstAt = new Map;
      merged.tasks.forEach((raw, index) => {
        const rawId = raw?.id;
        const earlier = typeof rawId === "string" ? firstAt.get(rawId) : undefined;
        if (earlier !== undefined) {
          dropped.push({
            index,
            id: rawId,
            reason: `duplicate id (index ${earlier} already has it)`
          });
          return;
        }
        const reason2 = taskRejection(raw);
        const task = reason2 === null ? validateTask(raw) : null;
        if (task) {
          kept.push(task);
          firstAt.set(task.id, index);
        } else {
          dropped.push({
            index,
            id: typeof rawId === "string" ? rawId : null,
            reason: reason2 ?? "rejected"
          });
        }
      });
      state.tasks = kept;
      restoreDropped = dropped;
      if (dropped.length)
        process.stderr.write(`bounty: restore dropped ${dropped.length} task(s) (${restorePath}): ${describeDrops(dropped)}
`);
      restoredFromElsewhere = !sessionId || resolve(restorePath) !== resolve(SNAPSHOTS_DIR, `${sessionId}.json`);
    } catch (e) {
      restoreFailed = {
        path: restorePath,
        reason: e instanceof Error ? e.message : String(e)
      };
      process.stderr.write(`bounty: restore failed (${restorePath}): ${restoreFailed.reason}
`);
    }
  }
  const sockets = new Set;
  const log = createEventLog();
  const sseClients = new Set;
  let snapDirty = restoredFromElsewhere;
  let rotatedThisSession = false;
  let snapshotBackedUp = null;
  const backupsThisSession = [];
  let ownsSnapshot = false;
  let unownedWhy = "this board did not read it at boot";
  let keptSinceWrite = false;
  let unreadableKept = false;
  const keepUnreadable = (path, why, announce) => {
    const backup = join3(SNAPSHOTS_DIR, `${sessionId}.unreadable-${Date.now()}.bak.json`);
    copyFileSync(path, backup);
    unreadableKept = true;
    ownsSnapshot = true;
    keptSinceWrite = true;
    const reason2 = `the snapshot could not be read as a board: ${why}; it is kept byte-for-byte before anything is written over it`;
    backupsThisSession.push({ kind: "unreadable", path: backup, taskCount: null, reason: reason2 });
    logDaemon("snapshotBackedUp", { kind: "unreadable", backup, why });
    if (announce)
      emitEvent({ type: "snapshotBackedUp", kind: "unreadable", backup, by: "system" });
    process.stderr.write(`bounty: ${reason2} \u2014 copied to ${backup}
`);
  };
  const keepUnowned = (path, taskCount) => {
    const backup = join3(SNAPSHOTS_DIR, `${sessionId}.unread-${Date.now()}.bak.json`);
    try {
      copyFileSync(path, backup);
    } catch (e) {
      throw new Error(`${path} could not be copied aside (${e instanceof Error ? e.message : String(e)}), and ${unownedWhy}, so it was not written over`);
    }
    ownsSnapshot = true;
    keptSinceWrite = true;
    const reason2 = `${unownedWhy}; kept before the board was first written over it`;
    backupsThisSession.push({ kind: "unread", path: backup, taskCount, reason: reason2 });
    logDaemon("snapshotBackedUp", { kind: "unread", backup, why: unownedWhy });
    emitEvent({ type: "snapshotBackedUp", kind: "unread", backup, by: "system" });
    process.stderr.write(`bounty: ${reason2} \u2014 copied to ${backup}
`);
  };
  let snapshotSaveFailed = null;
  let unsavedRecord = null;
  const dumpUnsaved = () => {
    const name = `${sessionId}.unsaved-${Date.now()}.json`;
    const candidates = [
      ...unsavedRecord ? [unsavedRecord.path] : [],
      join3(SNAPSHOTS_DIR, name),
      join3(BOUNTY_HOME, name)
    ];
    for (const p of candidates) {
      try {
        mkdirSync2(dirname2(p), { recursive: true });
        writeFileAtomic(p, JSON.stringify(state));
        return p;
      } catch {}
    }
    return null;
  };
  const snapshotWriteFailed = (path, e) => {
    const error = e instanceof Error ? e.message : String(e);
    const unsaved = dumpUnsaved();
    const first = snapshotSaveFailed === null;
    snapshotSaveFailed = {
      path,
      error,
      unsaved,
      taskCount: state.tasks.length,
      held: unsaved ? null : snapshotSaveFailed?.held ?? null,
      fix: snapshotFix(path)
    };
    if (unsaved) {
      const reason2 = `the snapshot ${path} could not be written (${error}); the board was saved here instead`;
      if (!unsavedRecord) {
        unsavedRecord = { kind: "unsaved", path: unsaved, taskCount: 0, reason: reason2 };
        backupsThisSession.push(unsavedRecord);
      }
      unsavedRecord.path = unsaved;
      unsavedRecord.taskCount = state.tasks.length;
      unsavedRecord.reason = reason2;
      delete unsavedRecord.superseded;
    }
    logDaemon("snapshotSaveFailed", { path, error, unsaved, tasks: state.tasks.length });
    if (first) {
      emitEvent({ type: "snapshotSaveFailed", path, error, unsaved, by: "system" });
      process.stderr.write(`bounty: could not write the snapshot ${path} (${error}); ${unsaved ? `the board was saved to ${unsaved}` : "no fallback file could be written either"}
`);
    }
  };
  const saveSnapshot = () => {
    const path = join3(SNAPSHOTS_DIR, `${sessionId}.json`);
    try {
      mkdirSync2(SNAPSHOTS_DIR, { recursive: true });
      if (!unreadableKept && existsSync3(path)) {
        const why = unreadableReason(path);
        if (why)
          keepUnreadable(path, why, true);
      }
      const prior = snapshotTaskCount(path);
      const owned = ownsSnapshot;
      if (!keptSinceWrite && prior !== null && shouldRotateSnapshot(prior, state.tasks.length, rotatedThisSession)) {
        const backup = join3(SNAPSHOTS_DIR, `${sessionId}.pre-${Date.now()}.bak.json`);
        try {
          copyFileSync(path, backup);
        } catch (e) {
          if (owned)
            throw e;
          throw new Error(`${path} could not be copied aside (${e instanceof Error ? e.message : String(e)}), and ${unownedWhy}, so it was not written over`);
        }
        rotatedThisSession = true;
        ownsSnapshot = true;
        keptSinceWrite = true;
        snapshotBackedUp = {
          path: backup,
          taskCount: prior,
          reason: `about to write ${state.tasks.length} tasks over ${prior}`
        };
        backupsThisSession.push({ kind: "shrink", ...snapshotBackedUp });
        logDaemon("snapshotBackedUp", {
          backup,
          priorTasks: prior,
          nextTasks: state.tasks.length
        });
        emitEvent({
          type: "snapshotBackedUp",
          backup,
          priorTasks: prior,
          nextTasks: state.tasks.length,
          by: "system"
        });
        process.stderr.write(`bounty: snapshot was about to shrink ${prior} \u2192 ${state.tasks.length} tasks; copied the old one to ${backup}
`);
      }
      if (!ownsSnapshot) {
        if (snapshotPresent(path))
          keepUnowned(path, prior);
        else
          ownsSnapshot = true;
      }
      writeFileAtomic(path, JSON.stringify(state));
      ownsSnapshot = true;
      keptSinceWrite = false;
      unreadableKept = false;
      snapshotSaveFailed = null;
      if (unsavedRecord && !unsavedRecord.superseded) {
        unsavedRecord.superseded = `the snapshot ${path} was written after this dump, with ${state.tasks.length} task(s): it is the newer board, and restoring this file would roll the board back. Kept; deleting it is your call`;
        logDaemon("unsavedSuperseded", { unsaved: unsavedRecord.path, snapshot: path });
      }
      return true;
    } catch (e) {
      snapshotWriteFailed(path, e);
      return false;
    }
  };
  const boardInNoFile = () => {
    const saved = saveSnapshot();
    snapDirty = false;
    return !saved && !snapshotSaveFailed?.unsaved;
  };
  const holdEnding = (event, held) => {
    if (!snapshotSaveFailed)
      return;
    const first = snapshotSaveFailed.held !== held;
    snapshotSaveFailed.held = held;
    if (first) {
      logDaemon(event, { path: snapshotSaveFailed.path, tasks: state.tasks.length });
      process.stderr.write(`bounty: ${held}
`);
    }
  };
  const nowhereToWrite = () => `the board is in no file (its snapshot ${snapshotSaveFailed?.path} and every fallback in ${SNAPSHOTS_DIR} and ${BOUNTY_HOME} could not be written), so ending the daemon would lose its ${state.tasks.length} task(s)`;
  if (sessionId) {
    const own = join3(SNAPSHOTS_DIR, `${sessionId}.json`);
    const readOwn = Boolean(v.restore) && !restoreFailed && !restoredFromElsewhere;
    let present = true;
    try {
      present = snapshotPresent(own);
    } catch {}
    let parsed2;
    let readable = false;
    try {
      parsed2 = JSON.parse(readFileSync4(own, "utf8"));
      readable = true;
    } catch {}
    if (!present || readable && boardHoldsSnapshot(state, parsed2)) {
      ownsSnapshot = true;
    } else {
      unownedWhy = restoreFailed ? `this board's restore failed (${restoreFailed.reason}), so it never read its own snapshot` : restoredFromElsewhere ? "this board was restored from another file and never read its own snapshot" : readOwn ? `this board restored its own snapshot but could not hold all of it (${describeUnheld(restoreDropped, readable ? snapshotDiff(state, parsed2) : null)})` : "this board started without reading its own snapshot";
      let why = null;
      try {
        why = present ? unreadableReason(own) : null;
      } catch {}
      if (why) {
        try {
          keepUnreadable(own, why, false);
        } catch {}
      }
      const ownTasks = readable ? parsed2.tasks : undefined;
      if (restoredFromElsewhere && !restoreFailed && Array.isArray(ownTasks)) {
        const restored = new Map(state.tasks.map((t) => [t.id, JSON.stringify(t)]));
        const lost = ownTasks.filter((t) => restored.get(t?.id ?? "") !== JSON.stringify(t)).length;
        const backup = join3(SNAPSHOTS_DIR, `${sessionId}.pre-restore-${Date.now()}.bak.json`);
        try {
          copyFileSync(own, backup);
          ownsSnapshot = true;
          keptSinceWrite = true;
          const held = lost > 0 ? `${lost} task(s) the restored board does not` : "a title (or another board field) the restored board does not";
          const reason2 = `this board was restored from another file, and its own snapshot held ${held}; kept before the restored board is written over it`;
          backupsThisSession.push({
            kind: "pre-restore",
            path: backup,
            taskCount: ownTasks.length,
            reason: reason2
          });
          logDaemon("snapshotBackedUp", { kind: "pre-restore", backup, lost });
          process.stderr.write(`bounty: ${reason2} \u2014 copied to ${backup}
`);
        } catch {}
      }
      if (readOwn && readable && !ownsSnapshot) {
        const backup = join3(SNAPSHOTS_DIR, `${sessionId}.partial-restore-${Date.now()}.bak.json`);
        try {
          copyFileSync(own, backup);
          ownsSnapshot = true;
          keptSinceWrite = true;
          const ownTaskCount = Array.isArray(ownTasks) ? ownTasks.length : null;
          const reason2 = `${unownedWhy}; kept byte-for-byte before the board is written over it`;
          backupsThisSession.push({
            kind: "partial-restore",
            path: backup,
            taskCount: ownTaskCount,
            reason: reason2
          });
          logDaemon("snapshotBackedUp", {
            kind: "partial-restore",
            backup,
            dropped: restoreDropped.length
          });
          process.stderr.write(`bounty: ${reason2} \u2014 copied to ${backup}
`);
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          snapshotBackupFailed = {
            kind: "partial-restore",
            path: own,
            error,
            fix: snapshotFix(backup)
          };
          logDaemon("snapshotBackupFailed", { kind: "partial-restore", path: own, error });
          process.stderr.write(`bounty: could not copy ${own} aside (${error}); ${unownedWhy}
`);
        }
      }
    }
  }
  const DIRTYING = new Set([
    "init",
    "task.add",
    "task.update",
    "task.remove",
    "task.toggle",
    "task.move",
    "task.edit"
  ]);
  let shutdownWatchdog = null;
  let resolveDone;
  let settled = false;
  const done = new Promise((res) => {
    resolveDone = (v2) => {
      if (settled)
        return;
      settled = true;
      shutdownWatchdog = setTimeout(() => {
        logDaemon("shutdownWatchdog", {
          reason: v2.reason,
          note: "teardown did not finish; forcing exit"
        });
        process.exit(v2.code);
      }, SHUTDOWN_WATCHDOG_MS);
      res(v2);
    };
  });
  requestShutdown = (code2, reason2, signal) => {
    logDaemon("signal", { signal, subscribers: sockets.size + sseClients.size });
    resolveDone({ code: code2, reason: reason2 });
  };
  let lastActivity = performance.now();
  const touch = () => {
    lastActivity = performance.now();
  };
  function broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of sockets) {
      try {
        ws.send(s);
      } catch {}
    }
  }
  function emitEvent(msg) {
    const ev = log.emit(msg);
    if (typeof msg.type === "string" && DIRTYING.has(msg.type))
      snapDirty = true;
    return ev;
  }
  function emitPresence(msg) {
    const chunk = `data: ${JSON.stringify(msg)}

`;
    for (const c of [...sseClients])
      c.send(chunk);
  }
  const eventsResponse = (req, url2) => sseResponse({
    log,
    since: Number.parseInt(url2.searchParams.get("since") ?? "-1", 10),
    heartbeatMs: SSE_HEARTBEAT_MS,
    clients: sseClients,
    signal: req.signal,
    onOpen: touch,
    onClose: touch
  });
  const ownerOf = (id) => state.tasks.find((t) => t.id === id)?.owner;
  function canReach(from, target, seen = new Set) {
    if (from === target)
      return true;
    if (seen.has(from))
      return false;
    seen.add(from);
    const task = state.tasks.find((t) => t.id === from);
    return (task?.blockedBy ?? []).some((bid) => canReach(bid, target, seen));
  }
  const prevBlocked = new Map;
  for (const t of state.tasks)
    prevBlocked.set(t.id, isBlocked(t, state.tasks));
  function reconcileBlocked() {
    for (const task of state.tasks) {
      const now = isBlocked(task, state.tasks);
      const was = prevBlocked.get(task.id) ?? false;
      if (was && !now && task.status !== "done") {
        emitEvent({ type: "unblocked", taskId: task.id, owner: task.owner, by: "system" });
      }
      prevBlocked.set(task.id, now);
    }
  }
  function projectState() {
    return {
      title: state.title,
      tasks: state.tasks.map((task) => {
        const liveBlockers = (task.blockedBy ?? []).map((bid) => state.tasks.find((t) => t.id === bid)).filter((b) => b !== undefined && b.status !== "done").map((b) => ({ id: b.id, title: b.title, status: b.status }));
        return { ...task, blocked: liveBlockers.length > 0, liveBlockers };
      })
    };
  }
  function handleAgentMsg(msg) {
    const by = typeof msg.as === "string" ? msg.as : "agent";
    if (msg.type === "init") {
      if (Array.isArray(msg.tasks) && state.tasks.length > 0 && msg.replace !== true) {
        const n = state.tasks.length;
        return {
          ok: true,
          applied: false,
          kind: "conflict",
          error: `init: the board already has ${n} task${n === 1 ? "" : "s"} and seeding would replace ${n === 1 ? "it" : "all of them"}; the board is unchanged`
        };
      }
      const replaced = msg.replace === true ? state.tasks.length : undefined;
      if (typeof msg.title === "string")
        state.title = msg.title;
      let dropped = [];
      if (Array.isArray(msg.tasks)) {
        state.tasks = [];
        dropped = msg.tasks.map((raw, index) => ({ index, reason: taskRejection(raw) })).filter((d) => d.reason !== null);
        for (const task of msg.tasks.map(validateTask))
          if (task)
            applyTaskAdd(state, task);
      }
      broadcast({
        type: "init",
        title: state.title,
        tasks: state.tasks,
        restoreFailed,
        restoreDropped,
        sessionId
      });
      emitEvent({ type: "init", title: state.title, by });
      return {
        ok: true,
        applied: true,
        tasksDropped: dropped.length ? { requested: Array.isArray(msg.tasks) ? msg.tasks.length : 0, dropped } : null,
        ...replaced !== undefined ? { tasksReplaced: replaced } : {}
      };
    } else if (msg.type === "task.add") {
      const task = validateTask(msg.task);
      if (!task) {
        return {
          ok: true,
          applied: false,
          kind: "usage",
          error: "task rejected: needs a string id, a string title, and a valid status"
        };
      }
      if (!applyTaskAdd(state, task)) {
        return {
          ok: true,
          applied: false,
          kind: "conflict",
          error: `task ${task.id} already exists \u2014 the board is unchanged and the existing task kept its id`
        };
      }
      broadcast({ type: "task.add", task });
      emitEvent({ type: "task.add", task, by, owner: task.owner });
      return { ok: true, applied: true };
    } else if (msg.type === "task.update") {
      if (msg.claim) {
        const existing = state.tasks.find((t) => t.id === msg.id);
        const claimant = typeof msg.as === "string" ? msg.as : undefined;
        if (existing?.owner && existing.owner !== claimant) {
          return {
            ok: true,
            applied: false,
            kind: "conflict",
            error: `task ${msg.id} is owned by ${existing.owner}`
          };
        }
      }
      const { blockedBy: _stripped, ...patch } = msg.patch;
      if ("tags" in patch)
        patch.tags = cleanTags(patch.tags);
      if ("size" in patch && !(typeof patch.size === "string" && (patch.size in SIZE_MINUTES))) {
        delete patch.size;
      }
      if ("expect" in patch && !(typeof patch.expect === "number" && patch.expect > 0)) {
        delete patch.expect;
      }
      if (!msg.claim && isNoOpUpdate(state, msg.id, patch)) {
        return { ok: true, applied: false };
      }
      if (applyTaskUpdate(state, msg.id, patch)) {
        broadcast({ type: "task.update", id: msg.id, patch });
        emitEvent({ type: "task.update", taskId: msg.id, patch, by, owner: ownerOf(msg.id) });
        return { ok: true, applied: true };
      }
      return { ok: true, applied: false, kind: "not_found", error: `no such task ${msg.id}` };
    } else if (msg.type === "task.remove") {
      const owner = ownerOf(msg.id);
      if (applyTaskRemove(state, msg.id)) {
        broadcast({ type: "task.remove", id: msg.id });
        emitEvent({ type: "task.remove", taskId: msg.id, by, owner });
        return { ok: true, applied: true };
      }
      return { ok: true, applied: false, kind: "not_found", error: `no such task ${msg.id}` };
    } else if (msg.type === "task.block") {
      const task = state.tasks.find((t) => t.id === msg.id);
      if (!task)
        return { ok: true, applied: false, kind: "not_found", error: `no such task ${msg.id}` };
      const unknown = msg.on.filter((b) => !state.tasks.some((t) => t.id === b));
      if (unknown.length)
        return {
          ok: true,
          applied: false,
          kind: "not_found",
          error: `no such task${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} \u2014 ` + `nothing was blocked (a blocker that does not exist would constrain nothing)`
        };
      for (const b of msg.on) {
        if (canReach(b, msg.id)) {
          return {
            ok: true,
            applied: false,
            kind: "conflict",
            error: `would create a cycle: ${msg.id} \u2192 ${b}`
          };
        }
      }
      const next = Array.from(new Set([...task.blockedBy ?? [], ...msg.on]));
      applyTaskUpdate(state, msg.id, { blockedBy: next });
      broadcast({ type: "task.update", id: msg.id, patch: { blockedBy: next } });
      emitEvent({
        type: "task.update",
        taskId: msg.id,
        patch: { blockedBy: next },
        by,
        owner: task.owner
      });
      return { ok: true, applied: true };
    } else if (msg.type === "task.unblock") {
      const task = state.tasks.find((t) => t.id === msg.id);
      if (!task)
        return { ok: true, applied: false, kind: "not_found", error: `no such task ${msg.id}` };
      const next = (task.blockedBy ?? []).filter((b) => !msg.on.includes(b));
      applyTaskUpdate(state, msg.id, { blockedBy: next });
      broadcast({ type: "task.update", id: msg.id, patch: { blockedBy: next } });
      emitEvent({
        type: "task.update",
        taskId: msg.id,
        patch: { blockedBy: next },
        by,
        owner: task.owner
      });
      return { ok: true, applied: true };
    } else if (msg.type === "message") {
      broadcast({ type: "message", text: msg.text });
      return { ok: true, applied: true };
    } else if (msg.type === "close") {
      if (boardInNoFile()) {
        return {
          ok: true,
          applied: false,
          kind: "conflict",
          error: `board not closed: its snapshot ${snapshotSaveFailed?.path} could not be written (${snapshotSaveFailed?.error}), and no fallback file could be written in ${SNAPSHOTS_DIR} or ${BOUNTY_HOME} either; the board is left running so its ${state.tasks.length} task(s) are not lost. Make one of those writable, then close again`,
          snapshotSaveFailed
        };
      }
      resolveDone({ code: 0, reason: "close" });
      return {
        ok: true,
        applied: true,
        snapshotBackups: backupsThisSession,
        snapshotSaveFailed
      };
    }
    return { ok: true, applied: false, kind: "usage", error: "unknown command type" };
  }
  let server;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      routes,
      development: { hmr: mode === "dev" },
      idleTimeout: IDLE_TIMEOUT_SEC,
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
          return new Response(JSON.stringify({
            state: projectState(),
            cursor: log.cursor(),
            snapshotBackedUp,
            restoreFailed,
            restoreDropped,
            snapshotSaveFailed
          }), { headers: { "Content-Type": "application/json" } });
        }
        if (req.method === "GET" && path === "/events") {
          return eventsResponse(req, url2);
        }
        if (req.method === "POST" && path === "/cmd") {
          return req.json().then((body) => {
            touch();
            const result = handleAgentMsg(body);
            reconcileBlocked();
            return new Response(JSON.stringify(result), {
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
          const f = Bun.file(join3(assetsDir, assetName));
          return f.exists().then((exists) => exists ? new Response(f, { headers: { "Content-Type": guessMime(assetName) } }) : new Response('{"error":"not found"}', {
            status: 404,
            headers: { "Content-Type": "application/json" }
          }));
        }
        if (mode === "release" && req.method === "GET") {
          const served = serveDist(path);
          if (served)
            return served;
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
          emitPresence({ type: "connected", by: "user" });
          ws.send(JSON.stringify({
            type: "init",
            title: state.title,
            tasks: state.tasks,
            restoreFailed,
            restoreDropped,
            sessionId
          }));
        },
        message(_ws, raw) {
          touch();
          let msg;
          try {
            msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
          } catch (e) {
            process.stderr.write(`bounty: bad json from browser: ${e instanceof Error ? e.message : String(e)}
`);
            return;
          }
          if (msg.type === "task.toggle") {
            if (!VALID_STATUS.includes(msg.status))
              return;
            if (isNoOpUpdate(state, msg.id, { status: msg.status }))
              return;
            if (applyTaskUpdate(state, msg.id, { status: msg.status })) {
              broadcast({ type: "task.update", id: msg.id, patch: { status: msg.status } });
              emitEvent({
                type: "task.toggle",
                taskId: msg.id,
                status: msg.status,
                by: "user",
                owner: ownerOf(msg.id)
              });
            }
          } else if (msg.type === "task.move") {
            if (!VALID_STATUS.includes(msg.status))
              return;
            if (isNoOpMove(state, msg.id, msg.status, msg.index))
              return;
            if (applyTaskMove(state, msg.id, msg.status, msg.index) !== -1) {
              broadcast({
                type: "init",
                title: state.title,
                tasks: state.tasks,
                restoreFailed,
                restoreDropped,
                sessionId
              });
              emitEvent({
                type: "task.move",
                taskId: msg.id,
                status: msg.status,
                index: msg.index,
                by: "user",
                owner: ownerOf(msg.id)
              });
            }
          } else if (msg.type === "task.edit") {
            const patch = {};
            if (msg.title !== undefined) {
              if (typeof msg.title !== "string" || msg.title.trim() === "")
                return;
              patch.title = msg.title;
            }
            if (msg.notes !== undefined) {
              if (typeof msg.notes !== "string")
                return;
              patch.notes = msg.notes;
            }
            if (Object.keys(patch).length === 0)
              return;
            if (applyTaskUpdate(state, msg.id, patch)) {
              broadcast({ type: "task.update", id: msg.id, patch });
              emitEvent({
                type: "task.edit",
                taskId: msg.id,
                ...patch,
                by: "user",
                owner: ownerOf(msg.id)
              });
            }
          } else if (msg.type === "task.add") {
            const task = validateTask(msg.task);
            if (task && applyTaskAdd(state, task)) {
              broadcast({ type: "task.add", task });
              emitEvent({ type: "task.add", task, by: "user", owner: task.owner });
            }
          } else if (msg.type === "task.remove") {
            const owner = ownerOf(msg.id);
            if (applyTaskRemove(state, msg.id)) {
              broadcast({ type: "task.remove", id: msg.id });
              emitEvent({ type: "task.remove", taskId: msg.id, by: "user", owner });
            }
          } else if (msg.type === "close") {
            if (boardInNoFile()) {
              const held = `Close board was refused: ${nowhereToWrite()}. Make one of those writable, then close again`;
              holdEnding("closeRefused", held);
              broadcast({ type: "message", text: `board not closed: ${held}` });
            } else
              resolveDone({ code: 0, reason: "user" });
          }
          reconcileBlocked();
        },
        close(ws) {
          sockets.delete(ws);
          emitPresence({ type: "disconnected", by: "user" });
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
    sessionId = `bounty-${randHex(4)}-p${boundPort}`;
  const url = `http://${host}:${boundPort}`;
  if (lockFile)
    updateLock(lockFile, { pid: process.pid, port: boundPort });
  emitEvent({ type: "ready", url, port: boundPort, session_id: sessionId, mode, by: "system" });
  logDaemon("ready", { port: boundPort });
  const sessionFile = join3(tmpdir(), `bounty-${sessionId}.json`);
  const latestFile = join3(tmpdir(), `bounty-latest.json`);
  const sessionInfo = JSON.stringify({
    url,
    port: boundPort,
    session_id: sessionId,
    title: state.title,
    mode,
    restoreFailed,
    restoreDropped,
    snapshotBackups: backupsThisSession,
    snapshotBackupFailed
  });
  try {
    writeFileAtomic(sessionFile, sessionInfo);
    writeFileAtomic(latestFile, sessionInfo);
  } catch (e) {
    process.stderr.write(`bounty: could not write discovery file: ${e instanceof Error ? e.message : String(e)}
`);
  }
  const cleanupDiscovery = () => {
    try {
      unlinkSync3(sessionFile);
    } catch {}
    unlinkIfMatches(latestFile, sessionId, (raw) => {
      try {
        return JSON.parse(raw).session_id ?? null;
      } catch {
        return null;
      }
    });
  };
  if (!v["no-open"])
    openBrowser(url);
  const stopHousekeeping = startHousekeeping({
    subscriberCount: () => sockets.size + sseClients.size,
    idleMs: () => performance.now() - lastActivity,
    touch,
    timeoutMs: timeout * 1000,
    onIdleClose: () => {
      if (boardInNoFile()) {
        holdEnding("idleCloseHeld", `the idle timeout is held: ${nowhereToWrite()}. Make one of those writable; the save is retried each time the timeout comes round, and the first that works ends the board`);
        touch();
        return;
      }
      resolveDone({ code: EXIT_IDLE_TIMEOUT, reason: "timeout" });
    },
    snapshot: {
      dirty: () => snapDirty,
      clear: () => {
        snapDirty = false;
      },
      write: () => {
        saveSnapshot();
      }
    }
  });
  let pokeState = new Map;
  const heartbeatTimer = setInterval(() => {
    const swept = computeDuePokes(state.tasks, pokeState, Date.now());
    pokeState = swept.pokeState;
    for (const p of swept.pokes) {
      const label = state.tasks.find((t) => t.id === p.taskId)?.title ?? p.taskId;
      const overdueMin = Math.max(1, Math.round(p.overdueByMs / 60000));
      if (p.owner) {
        emitEvent({
          type: "heartbeat",
          taskId: p.taskId,
          owner: p.owner,
          overdueByMs: p.overdueByMs,
          expectedMinutes: p.expectedMinutes,
          by: "system"
        });
      }
      broadcast({
        type: "message",
        text: `\u23F0 "${label}" overdue \u2014 ~${overdueMin}m past its ${p.expectedMinutes}m estimate${p.owner ? ` (@${p.owner})` : ""}`
      });
    }
  }, 30000);
  const { code, reason } = await done;
  if (lockFile)
    updateLock(lockFile, { pid: process.pid, port: boundPort, closing: true });
  logDaemon("exit", {
    reason,
    subscribers: sockets.size + sseClients.size,
    idleMs: performance.now() - lastActivity
  });
  stopHousekeeping();
  clearInterval(heartbeatTimer);
  saveSnapshot();
  emitEvent({ type: "closed", reason, by: "system" });
  broadcast({ type: "message", text: `session ended: ${reason}` });
  await drainAndStop({ server, clients: sseClients, sockets });
  cleanupDiscovery();
  if (lockFile)
    releaseLock(lockFile);
  if (shutdownWatchdog)
    clearTimeout(shutdownWatchdog);
  return code;
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  applyTaskAdd,
  applyTaskMove,
  applyTaskRemove,
  applyTaskUpdate,
  cleanTags,
  computeDuePokes,
  htmlEscape,
  isNoOpMove,
  isNoOpUpdate,
  main,
  parsePortFromSessionId,
  resolveMode2 as resolveMode,
  run,
  shouldIdleClose,
  shouldRotateSnapshot,
  snapshotTaskCount,
  validateTask
};
