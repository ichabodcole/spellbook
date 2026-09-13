// @bun
var __require = import.meta.require;

// src/scriptorium/backend/server.ts
import { readFileSync as readFileSync4, statSync as statSync3, unlinkSync as unlinkSync2, watch } from "fs";
import { homedir as homedir2, tmpdir } from "os";
import { basename as basename4, dirname as dirname4, isAbsolute as isAbsolute2, join as join5, resolve as resolve2 } from "path";
import { fileURLToPath } from "url";
import { parseArgs as nodeParseArgs } from "util";

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

// src/scriptorium/backend/diff.ts
function splitLines(text) {
  return text.split(`
`);
}
var MAX_EDITS = 3000;
function myersTrace(a, b) {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const size = 2 * max + 1;
  const offset = max;
  let v = new Int32Array(size);
  const trace = [];
  for (let d = 0;d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d;k <= d; k += 2) {
      const down = v[offset + k + 1];
      const right = v[offset + k - 1];
      let x;
      if (k === -d || k !== d && right < down)
        x = down;
      else
        x = right + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m)
        return trace;
    }
    v = v.slice();
  }
  return null;
}
function backtrack(a, b, trace) {
  const offset = Math.min(a.length + b.length, MAX_EDITS);
  const out = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1;d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || k !== d && v[offset + k - 1] < v[offset + k + 1])
      prevK = k + 1;
    else
      prevK = k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      out.push({ op: "same", a: x, b: y, text: a[x] });
    }
    if (d === 0)
      break;
    if (x > prevX) {
      x--;
      out.push({ op: "del", a: x, text: a[x] });
    } else {
      y--;
      out.push({ op: "add", b: y, text: b[y] });
    }
  }
  out.reverse();
  return out;
}
function coarseLines(a, b) {
  return [
    ...a.map((text, i) => ({ op: "del", a: i, text })),
    ...b.map((text, i) => ({ op: "add", b: i, text }))
  ];
}
function collect(lines) {
  const hunks = [];
  let i = 0;
  let id = 1;
  while (i < lines.length) {
    if (lines[i].op === "same") {
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && lines[i].op !== "same")
      i++;
    const run = lines.slice(start, i);
    const del = run.filter((l) => l.op === "del");
    const add = run.filter((l) => l.op === "add");
    const aFrom = del.length ? del[0].a : nextIndex(lines, start, "a");
    const bFrom = add.length ? add[0].b : nextIndex(lines, start, "b");
    hunks.push({
      id: id++,
      aFrom,
      aTo: aFrom + del.length,
      bFrom,
      bTo: bFrom + add.length,
      del: del.map((l) => l.text),
      add: add.map((l) => l.text)
    });
  }
  return hunks;
}
function nextIndex(lines, from, side) {
  for (let i = from;i < lines.length; i++) {
    const at = lines[i][side];
    if (at !== undefined)
      return at;
  }
  let last = -1;
  for (const l of lines) {
    const at = l[side];
    if (at !== undefined && at > last)
      last = at;
  }
  return last + 1;
}
function words(line) {
  return line.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu) ?? [];
}
function refine(before, after) {
  const a = words(before);
  const b = words(after);
  const trace = myersTrace(a, b);
  if (!trace)
    return { del: [{ text: before, changed: true }], add: [{ text: after, changed: true }] };
  const ops = backtrack(a, b, trace);
  const del = [];
  const add = [];
  for (const op of ops) {
    if (op.op === "same") {
      push(del, op.text, false);
      push(add, op.text, false);
    } else if (op.op === "del")
      push(del, op.text, true);
    else
      push(add, op.text, true);
  }
  return { del, add };
}
function push(spans, text, changed) {
  const last = spans[spans.length - 1];
  if (last && last.changed === changed)
    last.text += text;
  else
    spans.push({ text, changed });
}
function refineHunk(lines, hunk) {
  if (hunk.del.length !== hunk.add.length || hunk.del.length === 0)
    return;
  const dels = lines.filter((l) => l.op === "del" && inRange(l.a, hunk.aFrom, hunk.aTo));
  const adds = lines.filter((l) => l.op === "add" && inRange(l.b, hunk.bFrom, hunk.bTo));
  for (let i = 0;i < dels.length && i < adds.length; i++) {
    const d = dels[i];
    const ad = adds[i];
    const { del, add } = refine(d.text, ad.text);
    d.spans = del;
    ad.spans = add;
  }
}
function inRange(at, from, to) {
  return at !== undefined && at >= from && at < to;
}
function diffText(before, after) {
  if (before === after) {
    const lines2 = splitLines(before).map((text, i) => ({
      op: "same",
      a: i,
      b: i,
      text
    }));
    return { lines: lines2, hunks: [], same: true, coarse: false };
  }
  const a = splitLines(before);
  const b = splitLines(after);
  const trace = myersTrace(a, b);
  const coarse = trace === null;
  const lines = trace ? backtrack(a, b, trace) : coarseLines(a, b);
  const hunks = collect(lines);
  for (const h of hunks)
    refineHunk(lines, h);
  return { lines, hunks, same: false, coarse };
}
function applyHunks(before, hunks, take) {
  const wanted = new Set(take);
  const chosen = hunks.filter((h) => wanted.has(h.id)).sort((x, y) => y.aFrom - x.aFrom);
  const lines = splitLines(before);
  for (const h of chosen)
    lines.splice(h.aFrom, h.aTo - h.aFrom, ...h.add);
  return lines.join(`
`);
}
function unified(diff, opts = { from: "a", to: "b" }) {
  if (diff.same)
    return "";
  const context = opts.context ?? 3;
  const out = [`--- ${opts.from}`, `+++ ${opts.to}`];
  const groups = [];
  for (const h of diff.hunks) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && h.aFrom - prev.aTo <= context * 2)
      last.push(h);
    else
      groups.push([h]);
  }
  const a = splitLines(sideText(diff, "a"));
  const b = splitLines(sideText(diff, "b"));
  for (const group of groups) {
    const first = group[0];
    const last = group[group.length - 1];
    const aStart = Math.max(0, first.aFrom - context);
    const aEnd = Math.min(a.length, last.aTo + context);
    const bStart = Math.max(0, first.bFrom - context);
    const bEnd = Math.min(b.length, last.bTo + context);
    out.push(`@@ -${aStart + 1},${aEnd - aStart} +${bStart + 1},${bEnd - bStart} @@`);
    let at = aStart;
    for (const h of group) {
      for (;at < h.aFrom; at++)
        out.push(` ${a[at]}`);
      for (const line of h.del)
        out.push(`-${line}`);
      for (const line of h.add)
        out.push(`+${line}`);
      at = h.aTo;
    }
    for (;at < aEnd; at++)
      out.push(` ${a[at]}`);
  }
  return `${out.join(`
`)}
`;
}
function sideText(diff, side) {
  const skip = side === "a" ? "add" : "del";
  return diff.lines.filter((l) => l.op !== skip).map((l) => l.text).join(`
`);
}

// src/kit/wire/heartbeat.ts
var MAX_IDLE_TIMEOUT_SEC = 255;
var DEFAULT_HEARTBEAT_MS = 15000;
var MISSED_BEATS = 3;
function tailIdleMs(beatMs) {
  return beatMs * MISSED_BEATS;
}

// src/scriptorium/backend/heartbeat.ts
var IDLE_TIMEOUT_SEC = MAX_IDLE_TIMEOUT_SEC;
var SSE_HEARTBEAT_MS = DEFAULT_HEARTBEAT_MS;
var TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

// src/scriptorium/backend/picker.ts
function appleScript(kind, prompt) {
  const quoted = prompt.replace(/["\\]/g, "");
  const choose = kind === "file" ? `choose file with prompt "${quoted}" with multiple selections allowed` : `{choose folder with prompt "${quoted}"}`;
  return [
    `set chosen to ${choose}`,
    'set out to ""',
    "repeat with f in chosen",
    "set out to out & POSIX path of f & linefeed",
    "end repeat",
    "return out"
  ].join(`
`);
}
function pickerCommand(platform, kind, prompt, zenityAt) {
  if (platform === "darwin")
    return ["osascript", "-e", appleScript(kind, prompt)];
  if (platform === "win32")
    return null;
  if (zenityAt)
    return [
      zenityAt,
      "--file-selection",
      ...kind === "folder" ? ["--directory"] : ["--multiple"],
      `--separator=
`,
      `--title=${prompt}`
    ];
  return null;
}
function parsePickerOutput(stdout) {
  return stdout.split(`
`).map((l) => l.trim()).filter((l) => l.startsWith("/")).map((l) => l.length > 1 && l.endsWith("/") ? l.slice(0, -1) : l);
}
function wasCancelled(exitCode, stdout) {
  return exitCode !== 0 && parsePickerOutput(stdout).length === 0;
}

// src/scriptorium/backend/session.ts
import {
  closeSync,
  existsSync as existsSync3,
  mkdirSync,
  openSync,
  readdirSync as readdirSync2,
  readFileSync as readFileSync3,
  readSync,
  realpathSync,
  renameSync as renameSync2,
  rmSync as rmSync2,
  statSync as statSync2,
  writeFileSync as writeFileSync2
} from "fs";
import { homedir } from "os";
import { basename as basename3, dirname as dirname3, extname as extname2, isAbsolute, join as join4, relative as relative3, resolve, sep as sep2 } from "path";

// src/scriptorium/backend/frontmatter.ts
var BLOCK = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
function splitFrontmatter(text) {
  const m = BLOCK.exec(text);
  if (!m)
    return { raw: null, body: text };
  return { raw: m[1] ?? "", body: text.slice(m[0].length) };
}
function statusOf(fields) {
  const s = fields.status;
  return typeof s === "string" && s.trim() !== "" ? s : "stable";
}
var asList = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : typeof v === "string" ? [v] : [];
var isHuman = (actor) => typeof actor === "string" && actor.toLowerCase().startsWith("human:");
function trustTier(fields) {
  const verified = fields.verified;
  const events = Array.isArray(verified) ? verified : verified ? [verified] : [];
  if (events.length === 0)
    return "unverified";
  for (const e of events)
    if (e && typeof e === "object" && isHuman(e.by))
      return "human-reviewed";
  return "machine-confirmed";
}
function isStale(fields, now) {
  const at = fields.stale_after;
  const t = at instanceof Date ? at.getTime() : typeof at === "string" ? Date.parse(at) : Number.NaN;
  return Number.isFinite(t) && now >= t;
}
function generatedAt(fields) {
  const g = fields.generated;
  const at = g && typeof g === "object" ? g.at : undefined;
  if (at instanceof Date)
    return at.toISOString().slice(0, 10);
  if (typeof at === "string") {
    const t = Date.parse(at);
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : at;
  }
  return null;
}
var str = (v) => typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
function readMeta(text, now = Date.now()) {
  const { raw } = splitFrontmatter(text);
  if (raw === null)
    return null;
  let fields = {};
  let error;
  try {
    const parsed = Bun.YAML.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      fields = parsed;
    else if (parsed !== null && parsed !== undefined)
      error = "the frontmatter is not a mapping of keys to values";
  } catch (e) {
    error = e instanceof Error ? e.message.split(`
`)[0] : String(e);
  }
  return {
    raw,
    fields,
    type: str(fields.type),
    title: str(fields.title),
    description: str(fields.description),
    status: statusOf(fields),
    tags: asList(fields.tags),
    lifecycle: str(fields.lifecycle),
    trust: trustTier(fields),
    stale: isStale(fields, now),
    date: generatedAt(fields),
    ...error ? { error } : {}
  };
}
function summarize(meta) {
  if (!meta)
    return null;
  return {
    ...meta.type ? { type: meta.type } : {},
    ...meta.title ? { title: meta.title } : {},
    status: meta.status,
    tags: meta.tags,
    trust: meta.trust,
    stale: meta.stale,
    ...meta.lifecycle ? { lifecycle: meta.lifecycle } : {},
    ...meta.error ? { error: meta.error } : {}
  };
}
function matchesFilter(meta, filter) {
  if (meta === null)
    return Object.values(filter).every((v) => v === undefined);
  if (filter.type !== undefined && meta.type !== filter.type)
    return false;
  if (filter.status !== undefined && meta.status !== filter.status)
    return false;
  if (filter.lifecycle !== undefined && meta.lifecycle !== filter.lifecycle)
    return false;
  if (filter.tag !== undefined && !meta.tags.includes(filter.tag))
    return false;
  if (filter.since !== undefined) {
    if (!meta.date)
      return false;
    if (meta.date < filter.since)
      return false;
  }
  return true;
}
function titleFromBody(body) {
  for (const line of body.split(`
`)) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m)
      return m[1];
    if (line.trim() !== "" && !line.startsWith("#"))
      break;
  }
  return;
}
function guessType(siblingTypes, folder) {
  const counts = new Map;
  for (const t of siblingTypes)
    if (t)
      counts.set(t, (counts.get(t) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (best)
    return best[0];
  const name = folder.trim().toLowerCase();
  if (name === "" || name === "." || name === "/")
    return;
  return name.endsWith("ies") ? `${name.slice(0, -3)}y` : name.endsWith("s") ? name.slice(0, -1) : name;
}
function scalar(value) {
  return /^[\w .,''/@+-]*$/.test(value) && !/^\s|\s$/.test(value) && value !== "" ? value : JSON.stringify(value);
}
function buildBlock(meta) {
  const at = meta.at ?? new Date().toISOString().slice(0, 10);
  const lines = [
    `type: ${scalar(meta.type ?? "")}`,
    `title: ${scalar(meta.title ?? "")}`,
    `description: ${meta.description ? scalar(meta.description) : ""}`,
    `tags: [${(meta.tags ?? []).map(scalar).join(", ")}]`,
    `status: ${scalar(meta.status ?? "draft")}`,
    `generated: { by: ${scalar(meta.by ?? "unknown")}, at: ${at} }`
  ];
  return `---
${lines.join(`
`)}
---
`;
}
function withBlock(text, block) {
  return `${block}${text}`;
}
function setKey(text, key, value) {
  const { raw } = splitFrontmatter(text);
  if (raw === null)
    throw new Error("this document has no frontmatter block");
  const line = `${key}: ${scalar(value)}`;
  const keyLine = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
  const lines = raw.split(`
`);
  const at = lines.findIndex((l) => keyLine.test(l));
  if (at === -1)
    lines.push(line);
  else {
    let end = at + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end] ?? ""))
      end++;
    lines.splice(at, end - at, line);
  }
  const rebuilt = lines.join(`
`);
  return text.replace(raw, rebuilt);
}

// src/scriptorium/backend/links.ts
import {
  basename as basename2,
  dirname as dirname2,
  extname,
  join as join3,
  normalize,
  relative as relative2,
  resolve as resolvePath
} from "path";

// src/scriptorium/backend/tree.ts
import { readdirSync, statSync } from "fs";
import { basename, dirname, join as join2, relative, sep } from "path";
var DOC_EXTENSIONS = [".md", ".markdown", ".mdx", ".txt"];
function isDocName(name) {
  const lower = name.toLowerCase();
  return DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
var SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "coverage"]);
var MIRROR_NODE_CAP = 2000;
var toPosix = (p) => p.split(sep).join("/");
function scanTree(root, cap = MIRROR_NODE_CAP, hidden = []) {
  let count = 0;
  let truncated = false;
  const skip = new Set(hidden);
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const groups = [];
    const docs = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (name.startsWith("."))
        continue;
      if (count >= cap) {
        truncated = true;
        break;
      }
      const abs = join2(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const rel = toPosix(relative(root, abs));
      if (skip.has(rel))
        continue;
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name))
          continue;
        count++;
        const children = walk(abs);
        if (children.length > 0 || isEmptyDir(abs))
          groups.push({ kind: "group", rel, children });
      } else if (st.isFile() && isDocName(name)) {
        count++;
        docs.push({ kind: "doc", rel });
      }
    }
    return [...groups, ...docs];
  };
  const nodes = walk(root);
  return { nodes, truncated };
}
function isEmptyDir(dir) {
  try {
    return readdirSync(dir).every((n) => n.startsWith("."));
  } catch {
    return false;
  }
}
function findNode(nodes, rel) {
  for (const n of nodes) {
    if (n.rel === rel)
      return n;
    if (n.kind === "group" && rel.startsWith(`${n.rel}/`))
      return findNode(n.children, rel);
  }
  return;
}

class PathError extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
function entryForPath(abs, id) {
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new PathError(`no such file or folder: ${abs}`, "missing");
  }
  if (st.isDirectory()) {
    const { nodes, truncated } = scanTree(abs);
    return {
      id,
      label: basename(abs) || abs,
      root: abs,
      membership: "mirrored",
      nodes,
      ...truncated ? { truncated } : {}
    };
  }
  if (!isDocName(abs)) {
    throw new PathError(`not a document scriptorium opens (${DOC_EXTENSIONS.join(" ")}): ${abs}`, "not-a-doc");
  }
  return {
    id,
    label: basename(abs),
    root: dirname(abs),
    membership: "listed",
    nodes: [{ kind: "doc", rel: basename(abs) }]
  };
}
function docPaths(entry) {
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.kind === "doc")
        out.push(join2(entry.root, n.rel));
      else
        walk(n.children);
    }
  };
  walk(entry.nodes);
  return out;
}
function locate(entries, abs) {
  for (const e of entries) {
    if (docPaths(e).includes(abs))
      return { entryId: e.id, rel: toPosix(relative(e.root, abs)) };
  }
  return null;
}
function listDir(dir) {
  const names = readdirSync(dir);
  const out = [];
  for (const name of names) {
    if (name.startsWith("."))
      continue;
    const abs = join2(dir, name);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir || isDocName(name))
      out.push({ name, path: abs, dir: isDir });
  }
  return out.sort((a, b) => a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1);
}

// src/scriptorium/backend/links.ts
var FENCE_LINE = /^(?:```|~~~)/;
function withoutFences(body) {
  const out = [];
  let fence = null;
  for (const line of body.split(`
`)) {
    const m = FENCE_LINE.exec(line);
    if (fence === null && m) {
      fence = m[0];
      out.push("");
      continue;
    }
    if (fence !== null) {
      if (m && line.startsWith(fence))
        fence = null;
      out.push("");
      continue;
    }
    out.push(line);
  }
  return out.join(`
`);
}
function parseRel(query) {
  if (!query)
    return [];
  const m = /(?:^|[?&])rel=([^&]*)/.exec(query);
  if (!m)
    return [];
  const seen = new Set;
  const out = [];
  for (const raw of decodeURIComponent(m[1] ?? "").split(",")) {
    const rel = raw.trim().toLowerCase();
    if (rel === "" || seen.has(rel))
      continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}
function splitTarget(raw) {
  const hash = raw.indexOf("#");
  const withoutAnchor = hash === -1 ? raw : raw.slice(0, hash);
  const anchor = hash === -1 ? undefined : raw.slice(hash + 1);
  const q = withoutAnchor.indexOf("?");
  return {
    path: (q === -1 ? withoutAnchor : withoutAnchor.slice(0, q)).trim(),
    ...q === -1 ? {} : { query: withoutAnchor.slice(q + 1) },
    ...anchor ? { anchor } : {}
  };
}
var EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;
var MD_LINK = /(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
var WIKI_LINK = /\[\[([^\]\n]+)\]\]/g;
function extractLinks(body) {
  const text = withoutFences(body);
  const out = [];
  for (const m of text.matchAll(MD_LINK)) {
    if (m[1] === "!")
      continue;
    const raw = m[3] ?? "";
    if (EXTERNAL.test(raw) || raw.startsWith("#"))
      continue;
    const { path, query } = splitTarget(raw);
    if (path === "")
      continue;
    out.push({
      kind: "markdown",
      target: path,
      rel: parseRel(query),
      ...m[2] ? { label: m[2] } : {}
    });
  }
  for (const m of text.matchAll(WIKI_LINK)) {
    const inner = m[1] ?? "";
    const pipe = inner.indexOf("|");
    const targetPart = pipe === -1 ? inner : inner.slice(0, pipe);
    const label = pipe === -1 ? undefined : inner.slice(pipe + 1).trim();
    const { path, query } = splitTarget(targetPart);
    if (path === "")
      continue;
    out.push({ kind: "wiki", target: path, rel: parseRel(query), ...label ? { label } : {} });
  }
  return out;
}
function looksLikeRef(value) {
  if (typeof value !== "string")
    return false;
  const v = value.trim();
  if (v === "" || EXTERNAL.test(v))
    return false;
  return v.includes("/") || v.toLowerCase().endsWith(".md");
}
function fieldRefs(fields, maxDepth = 4) {
  const out = [];
  const walk = (key, value, depth) => {
    if (depth > maxDepth)
      return;
    if (looksLikeRef(value))
      out.push({ key, value: value.trim() });
    else if (Array.isArray(value))
      for (const v of value)
        walk(key, v, depth + 1);
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value))
        walk(`${key}.${k}`, v, depth + 1);
  };
  for (const [k, v] of Object.entries(fields))
    walk(k, v, 0);
  return out;
}
var stem = (p) => basename2(p, extname(p));
function resolveTarget(target, from, index) {
  const looksPath = target.startsWith("/") || target.startsWith("./") || target.startsWith("../") || extname(target) !== "";
  if (looksPath) {
    const anchored = target.startsWith("/") || target.startsWith("./") || target.startsWith("../");
    const candidates = target.startsWith("/") ? [normalize(join3(index.root, target))] : anchored ? [normalize(resolvePath(dirname2(from), target))] : [
      normalize(resolvePath(dirname2(from), target)),
      normalize(join3(index.root, target)),
      ...index.repoRoot ? [normalize(join3(index.repoRoot, target))] : []
    ];
    const tried = candidates.map((c) => extname(c) === "" ? `${c}.md` : c);
    for (const c of tried)
      if (index.paths.includes(c))
        return { state: "in-bundle", path: c };
    for (const c of tried)
      if (index.exists(c))
        return { state: "outside", path: c };
    return { state: "missing", tried: tried[0] };
  }
  const slash = target.indexOf("/");
  if (slash > 0) {
    const type = target.slice(0, slash);
    const slug = target.slice(slash + 1);
    for (const p of index.paths)
      if (stem(p) === slug && index.metaOf(p)?.type === type)
        return { state: "in-bundle", path: p };
  }
  const hit = index.paths.find((p) => stem(p) === stem(target));
  if (hit)
    return { state: "in-bundle", path: hit };
  return { state: "missing", tried: target };
}
function buildGraph(index, bodyOf, cap = 400) {
  const paths = index.paths.slice(0, cap);
  const edges = [];
  for (const from of paths) {
    const meta = index.metaOf(from);
    for (const link of extractLinks(bodyOf(from))) {
      const r = resolveTarget(link.target, from, index);
      edges.push({
        from,
        to: r.state === "missing" ? r.tried : r.path,
        source: "link",
        rel: link.rel,
        state: r.state
      });
    }
    for (const ref of meta ? fieldRefs(meta.fields) : []) {
      const r = resolveTarget(ref.value, from, index);
      edges.push({
        from,
        to: r.state === "missing" ? r.tried : r.path,
        source: "frontmatter",
        key: ref.key,
        rel: [],
        state: r.state
      });
    }
  }
  const outOf = new Map;
  const intoOf = new Map;
  for (const e of edges) {
    outOf.set(e.from, (outOf.get(e.from) ?? 0) + 1);
    if (e.state === "in-bundle")
      intoOf.set(e.to, (intoOf.get(e.to) ?? 0) + 1);
  }
  const nodes = paths.map((path) => {
    const meta = index.metaOf(path);
    return {
      path,
      rel: toPosix(relative2(index.root, path)),
      title: meta?.title ?? stem(path),
      ...meta?.type ? { type: meta.type } : {},
      status: meta?.status ?? "stable",
      stale: meta?.stale ?? false,
      tags: meta?.tags ?? [],
      linksOut: outOf.get(path) ?? 0,
      linksIn: intoOf.get(path) ?? 0
    };
  });
  return {
    root: index.root,
    nodes,
    edges,
    dangling: edges.filter((e) => e.state === "missing").length
  };
}

// src/scriptorium/backend/session.ts
var MANIFEST_FORMAT = 1;
var META_SCAN_CAP = 500;
var META_HEAD_BYTES = 8192;
function readHead(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(META_HEAD_BYTES);
    const read = readSync(fd, buf, 0, META_HEAD_BYTES, 0);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined)
      closeSync(fd);
  }
}

class SessionError extends Error {
  status;
  choices;
  constructor(message, status, choices) {
    super(message);
    this.status = status;
    this.choices = choices;
  }
}
var contentHash = (text) => Bun.hash(text).toString(16);
var randHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map((b) => b.toString(16).padStart(2, "0")).join("");
var newSessionId = () => randHex(4);
function realOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

class Session {
  home;
  dir;
  m;
  owned = new Map;
  activeHash = new Map;
  lastActiveText = new Map;
  restoreFindings = [];
  constructor(home, manifest) {
    this.home = home;
    this.m = manifest;
    this.dir = join4(home, "sessions", manifest.sessionId);
  }
  static create(home, sessionId = newSessionId(), workspace) {
    const s = new Session(home, {
      format: MANIFEST_FORMAT,
      sessionId,
      createdAt: Date.now(),
      context: [],
      docs: [],
      openDoc: null,
      chat: [],
      ...workspace ? { workspace: resolve(workspace) } : {}
    });
    mkdirSync(join4(s.dir, "docs"), { recursive: true });
    s.persist();
    return s;
  }
  static restore(home, sessionId) {
    const path = join4(home, "sessions", sessionId, "manifest.json");
    if (!existsSync3(path))
      throw new SessionError(`no saved session ${sessionId}`, 404);
    const m = JSON.parse(readFileSync3(path, "utf8"));
    if (m.format !== MANIFEST_FORMAT)
      throw new SessionError(`session ${sessionId} has manifest format ${m.format}`, 409);
    const s = new Session(home, m);
    mkdirSync(join4(s.dir, "docs"), { recursive: true });
    for (const e of s.m.context)
      if (e.membership === "mirrored")
        s.rescan(e.id);
    for (const d of s.m.docs) {
      const p = s.versionPath(d, d.active);
      const text = existsSync3(p) ? readFileSync3(p, "utf8") : "";
      s.adoptActive(d, text);
      let now = null;
      try {
        now = contentHash(readFileSync3(d.original, "utf8"));
      } catch {
        now = null;
      }
      if (now === null || now !== d.originalHash) {
        d.outsideChanged = true;
        s.restoreFindings.push({ doc: d.slug, original: d.original, missing: now === null });
      }
    }
    if (s.restoreFindings.length > 0)
      s.persist();
    return s;
  }
  static listSaved(home) {
    try {
      return readdirSync2(join4(home, "sessions")).filter((id) => existsSync3(join4(home, "sessions", id, "manifest.json")));
    } catch {
      return [];
    }
  }
  get id() {
    return this.m.sessionId;
  }
  get docsDir() {
    return join4(this.dir, "docs");
  }
  get openDocSlug() {
    return this.m.openDoc;
  }
  get context() {
    return this.m.context;
  }
  watchRoots() {
    const roots = [
      { path: this.docsDir, watch: realOr(this.docsDir), recursive: true }
    ];
    for (const e of this.m.context)
      roots.push({
        path: e.root,
        watch: realOr(e.root),
        recursive: e.membership === "mirrored",
        entryId: e.id
      });
    for (const d of this.m.docs) {
      const realDir = dirname3(realOr(d.original));
      if (!roots.some((r) => r.watch === realDir && r.recursive === false) && !roots.some((r) => r.recursive && (realDir === r.watch || realDir.startsWith(r.watch + sep2))))
        roots.push({ path: realDir, watch: realDir, recursive: false });
    }
    return roots;
  }
  persist() {
    mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(join4(this.dir, "manifest.json"), `${JSON.stringify(this.m, null, 2)}
`);
  }
  writeOwned(path, text) {
    mkdirSync(dirname3(path), { recursive: true });
    this.owned.set(path, contentHash(text));
    writeFileSync2(path, text);
  }
  adoptActive(d, text) {
    const p = this.versionPath(d, d.active);
    this.owned.set(p, contentHash(text));
    this.activeHash.set(d.slug, contentHash(text));
    this.lastActiveText.set(d.slug, text);
  }
  writeActive(d, text) {
    this.writeOwned(this.versionPath(d, d.active), text);
    this.activeHash.set(d.slug, contentHash(text));
    this.lastActiveText.set(d.slug, text);
  }
  preserveOutside(d, text) {
    const n = this.takeVersion(d);
    const rec = {
      n,
      author: "agent",
      from: d.active,
      createdAt: Date.now(),
      label: `outside write to v${d.active}`
    };
    d.versions.push(rec);
    this.writeOwned(this.versionPath(d, n), text);
    this.persist();
    return { ...rec, path: this.versionPath(d, n) };
  }
  isOwnWrite(path, text) {
    return this.owned.get(path) === contentHash(text);
  }
  addContext(rawPath) {
    const abs = resolve(rawPath);
    const probe = entryForPath(abs, `c-${randHex(3)}`);
    const same = this.m.context.find((e) => e.root === probe.root && e.membership === probe.membership && (probe.membership === "mirrored" || JSON.stringify(e.nodes) === JSON.stringify(probe.nodes)));
    if (same)
      return { entry: same, added: false };
    this.m.context.push(probe);
    this.relink();
    this.persist();
    return { entry: probe, added: true };
  }
  removeContext(id) {
    const i = this.m.context.findIndex((e) => e.id === id);
    if (i < 0)
      throw new SessionError(`no context entry ${id}`, 404, this.m.context.map((e) => e.id));
    this.m.context.splice(i, 1);
    this.relink();
    this.closeOrphanedOpenDoc();
    this.persist();
  }
  closeOrphanedOpenDoc() {
    const open = this.m.openDoc ? this.m.docs.find((d) => d.slug === this.m.openDoc) : undefined;
    if (open && open.entryId === null)
      this.m.openDoc = null;
  }
  rescan(entryId) {
    const e = this.m.context.find((x) => x.id === entryId);
    if (e?.membership !== "mirrored")
      return false;
    const { nodes, truncated } = scanTree(e.root, MIRROR_NODE_CAP, e.hidden);
    const changed = JSON.stringify(nodes) !== JSON.stringify(e.nodes) || !!truncated !== !!e.truncated;
    e.nodes = nodes;
    if (truncated)
      e.truncated = true;
    else
      delete e.truncated;
    if (changed)
      this.relink();
    return changed;
  }
  relink() {
    for (const d of this.m.docs) {
      const at = locate(this.m.context, d.original);
      d.entryId = at?.entryId ?? null;
      d.rel = at?.rel ?? null;
    }
  }
  versionPath(d, n) {
    return join4(this.docsDir, d.slug, `v${n}${d.ext}`);
  }
  docOrDie(slug) {
    const want = slug ?? this.m.openDoc ?? undefined;
    const choices = this.m.docs.map((d2) => d2.slug);
    if (want === undefined)
      throw new SessionError("no document is open \u2014 name one with --doc", 409, choices);
    const d = this.findDoc(want);
    if (!d)
      throw new SessionError(`no document "${want}" in this session`, 404, choices);
    return d;
  }
  findDoc(key) {
    const bySlug = this.m.docs.find((d) => d.slug === key);
    if (bySlug)
      return bySlug;
    if (isAbsolute(key)) {
      const byPath = this.m.docs.find((d) => d.original === key || realOr(d.original) === realOr(key));
      if (byPath)
        return byPath;
    }
    const byName = this.m.docs.filter((d) => basename3(d.original) === key || d.rel === key);
    return byName.length === 1 ? byName[0] : undefined;
  }
  takeVersion(d) {
    const n = d.nextVersion ?? Math.max(...d.versions.map((v) => v.n)) + 1;
    d.nextVersion = n + 1;
    return n;
  }
  versionOrDie(d, n) {
    const v = d.versions.find((x) => x.n === n);
    if (!v)
      throw new SessionError(`${d.slug} has no v${n}`, 404, d.versions.map((x) => `v${x.n}`));
    return v;
  }
  slugFor(original) {
    const stem2 = basename3(original, extname2(original)).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "doc";
    let slug = stem2;
    for (let i = 2;this.m.docs.some((d) => d.slug === slug); i++)
      slug = `${stem2}-${i}`;
    return slug;
  }
  openPath(rawPath, opts = {}) {
    const focus = opts.focus ?? true;
    const abs = this.canonical(resolve(rawPath));
    const existing = this.m.docs.find((d2) => d2.original === abs);
    if (existing) {
      if (focus)
        this.m.openDoc = existing.slug;
      this.persist();
      return { slug: existing.slug, created: false };
    }
    if (!isDocName(abs))
      throw new SessionError(`not a document scriptorium opens: ${abs}`, 400);
    if (!locate(this.m.context, abs))
      throw new SessionError(`${abs} is not in this session's context \u2014 add it (or its folder) first`, 400);
    let text;
    try {
      if (!statSync2(abs).isFile())
        throw new Error("not a file");
      text = readFileSync3(abs, "utf8");
    } catch {
      throw new SessionError(`cannot open ${abs}: no such file`, 404);
    }
    const ext = [".md", ".markdown", ".mdx", ".txt"].includes(extname2(abs).toLowerCase()) ? extname2(abs).toLowerCase() : ".md";
    const at = locate(this.m.context, abs);
    const d = {
      slug: this.slugFor(abs),
      name: basename3(abs),
      original: abs,
      entryId: at?.entryId ?? null,
      rel: at?.rel ?? null,
      ext,
      versions: [{ n: 1, author: "human", createdAt: Date.now() }],
      active: 1,
      originalHash: contentHash(text),
      outsideChanged: false,
      admitted: true
    };
    this.m.docs.push(d);
    this.writeActive(d, text);
    if (focus)
      this.m.openDoc = d.slug;
    this.persist();
    return { slug: d.slug, created: true };
  }
  canonical(abs) {
    if (locate(this.m.context, abs))
      return abs;
    const real = realOr(abs);
    for (const e of this.m.context) {
      const realRoot = realOr(e.root);
      if (!real.startsWith(realRoot + sep2))
        continue;
      const spelled = join4(e.root, relative3(realRoot, real));
      if (locate(this.m.context, spelled))
        return spelled;
    }
    return abs;
  }
  openSlug(slug) {
    this.m.openDoc = this.docOrDie(slug).slug;
    this.persist();
  }
  readVersion(slug, n) {
    const d = this.docOrDie(slug);
    this.versionOrDie(d, n);
    const path = this.versionPath(d, n);
    return { text: readFileSync3(path, "utf8"), path };
  }
  activePath(slug) {
    const d = slug ? this.findDoc(slug) : this.m.openDoc ? this.findDoc(this.m.openDoc) : undefined;
    return d ? this.versionPath(d, d.active) : null;
  }
  edit(slug, n, text) {
    const d = this.docOrDie(slug);
    if (n !== d.active)
      throw new SessionError(`v${n} is not the active version of ${d.slug} (v${d.active} is) \u2014 only the active version is editable`, 409);
    const before = this.isDirty(d);
    const path = this.versionPath(d, n);
    const staged = `${path}.${process.pid}.edit`;
    writeFileSync2(staged, text);
    let preserved = null;
    let onDisk = null;
    try {
      onDisk = readFileSync3(path, "utf8");
    } catch {
      onDisk = null;
    }
    if (onDisk !== null && !this.isOwnWrite(path, onDisk))
      preserved = this.preserveOutside(d, onDisk);
    this.owned.set(path, contentHash(text));
    renameSync2(staged, path);
    this.activeHash.set(d.slug, contentHash(text));
    this.lastActiveText.set(d.slug, text);
    return { dirtyChanged: before !== this.isDirty(d), preserved };
  }
  newVersion(opts) {
    const d = this.docOrDie(opts.doc);
    const from = opts.from ?? d.active;
    this.versionOrDie(d, from);
    const text = readFileSync3(this.versionPath(d, from), "utf8");
    const n = this.takeVersion(d);
    const rec = {
      n,
      author: opts.author,
      from,
      createdAt: Date.now(),
      ...opts.label ? { label: opts.label } : {}
    };
    d.versions.push(rec);
    this.writeOwned(this.versionPath(d, n), text);
    this.persist();
    return { slug: d.slug, version: { ...rec, path: this.versionPath(d, n) } };
  }
  deleteVersion(opts) {
    const d = this.docOrDie(opts.doc);
    const v = this.versionOrDie(d, opts.version);
    if (opts.version === d.active)
      throw new SessionError(`v${opts.version} is the active version of ${d.slug} \u2014 activate another one first, ` + `then delete this`, 409);
    d.nextVersion ??= Math.max(...d.versions.map((x) => x.n)) + 1;
    const path = this.versionPath(d, opts.version);
    d.versions = d.versions.filter((x) => x.n !== opts.version);
    try {
      rmSync2(path);
    } catch {}
    this.owned.delete(path);
    this.persist();
    return {
      slug: d.slug,
      version: opts.version,
      ...v.label ? { label: v.label } : {},
      remaining: d.versions.length
    };
  }
  activate(opts) {
    const d = this.docOrDie(opts.doc);
    this.versionOrDie(d, opts.version);
    const previous = d.active;
    d.active = opts.version;
    this.adoptActive(d, readFileSync3(this.versionPath(d, d.active), "utf8"));
    this.persist();
    return { slug: d.slug, previous };
  }
  sideText(d, side) {
    if (side === "original")
      return readFileSync3(d.original, "utf8");
    this.versionOrDie(d, side);
    return readFileSync3(this.versionPath(d, side), "utf8");
  }
  compare(opts) {
    const d = this.docOrDie(opts.doc);
    if (opts.against === d.active)
      throw new SessionError(`v${d.active} is the active version of ${d.slug} \u2014 comparing it with itself says nothing`, 400);
    const left = readFileSync3(this.versionPath(d, d.active), "utf8");
    return {
      doc: d.slug,
      active: d.active,
      against: opts.against,
      diff: diffText(left, this.sideText(d, opts.against))
    };
  }
  merge(opts) {
    const d = this.docOrDie(opts.doc);
    const payload = this.compare({ doc: d.slug, against: opts.against });
    const known = new Set(payload.diff.hunks.map((h) => h.id));
    const missing = opts.hunks.filter((id) => !known.has(id));
    if (missing.length)
      throw new SessionError(`${d.slug} has no hunk ${missing.join(", ")} against ${sideName(opts.against, d.name)} \u2014 ` + `it has ${known.size === 0 ? "none" : `1..${Math.max(...known)}`}. Run diff again: ` + `the text changed under the numbers.`, 409);
    const before = readFileSync3(this.versionPath(d, d.active), "utf8");
    const text = applyHunks(before, payload.diff.hunks, opts.hunks);
    const { preserved } = this.edit(d.slug, d.active, text);
    return {
      slug: d.slug,
      version: d.active,
      text,
      applied: opts.hunks.filter((id) => known.has(id)).length,
      preserved
    };
  }
  save(slug) {
    const d = this.docOrDie(slug);
    if (!d.admitted || !isDocName(d.original))
      throw new SessionError(`refusing to save ${d.original}: it was not opened from the context`, 409);
    const text = readFileSync3(this.versionPath(d, d.active), "utf8");
    this.writeOwned(d.original, text);
    d.originalHash = contentHash(text);
    d.outsideChanged = false;
    this.persist();
    return { original: d.original, version: d.active };
  }
  revert(slug) {
    const d = this.docOrDie(slug);
    const text = readFileSync3(d.original, "utf8");
    d.originalHash = contentHash(text);
    d.outsideChanged = false;
    this.writeActive(d, text);
    this.persist();
    return { version: d.active, text };
  }
  isDirty(d) {
    return (this.activeHash.get(d.slug) ?? "") !== d.originalHash;
  }
  onFileEvent(abs) {
    if (abs.startsWith(this.docsDir + sep2)) {
      const rest = abs.slice(this.docsDir.length + 1).split(sep2);
      if (rest.length !== 2)
        return null;
      const [slug, file] = rest;
      const d2 = this.m.docs.find((x) => x.slug === slug);
      const match = /^v(\d+)(\.[a-z]+)$/.exec(file);
      if (!d2 || !match || match[2] !== d2.ext)
        return null;
      const n = Number(match[1]);
      let text;
      try {
        text = readFileSync3(abs, "utf8");
      } catch {
        return null;
      }
      if (this.isOwnWrite(abs, text))
        return null;
      if (!d2.versions.some((v) => v.n === n)) {
        d2.versions.push({ n, author: "agent", createdAt: Date.now() });
        d2.versions.sort((a, b) => a.n - b.n);
        this.owned.set(abs, contentHash(text));
        this.persist();
        return { kind: "version.created", doc: d2.slug, version: n, path: abs };
      }
      if (n === d2.active) {
        const kept = this.preserveOutside(d2, text);
        this.writeActive(d2, this.lastActiveText.get(d2.slug) ?? text);
        return {
          kind: "active.outside",
          doc: d2.slug,
          version: n,
          path: abs,
          preservedAs: kept.n,
          preservedPath: kept.path
        };
      }
      this.owned.set(abs, contentHash(text));
      return { kind: "version.changed", doc: d2.slug, version: n, text, active: false };
    }
    const d = this.m.docs.find((x) => x.original === abs || realOr(x.original) === abs);
    if (d) {
      let text;
      try {
        text = readFileSync3(abs, "utf8");
      } catch {
        return null;
      }
      const h = contentHash(text);
      if (h === d.originalHash)
        return null;
      const clean = !this.isDirty(d);
      if (clean) {
        d.originalHash = h;
        this.writeActive(d, text);
        this.persist();
        return {
          kind: "original.reloaded",
          doc: d.slug,
          version: d.active,
          text,
          original: d.original
        };
      }
      if (d.outsideChanged)
        return null;
      d.outsideChanged = true;
      this.persist();
      return { kind: "original.conflict", doc: d.slug, original: d.original };
    }
    for (const e of this.m.context) {
      if (e.membership === "mirrored" && (abs === e.root || abs.startsWith(e.root + sep2))) {
        return this.rescan(e.id) ? { kind: "tree", entryId: e.id } : null;
      }
    }
    return null;
  }
  get workspace() {
    return this.m.workspace ?? homedir();
  }
  setWorkspace(rawPath) {
    const abs = resolve(rawPath);
    let isDir = false;
    try {
      isDir = statSync2(abs).isDirectory();
    } catch {
      throw new SessionError(`no such folder: ${abs}`, 404);
    }
    if (!isDir)
      throw new SessionError(`the workspace must be a folder: ${abs}`, 400);
    this.m.workspace = abs;
    this.persist();
    return { path: abs };
  }
  display(abs) {
    for (const e of this.m.context) {
      if (e.membership === "mirrored") {
        if (abs === e.root)
          return e.label;
        if (abs.startsWith(e.root + sep2))
          return `${e.label}/${toPosix(relative3(e.root, abs))}`;
      } else if (e.nodes.some((n) => join4(e.root, n.rel) === abs))
        return e.label;
    }
    if (abs.startsWith(this.workspace + sep2))
      return `workspace/${toPosix(relative3(this.workspace, abs))}`;
    const home = homedir();
    return abs === home ? "~" : abs.startsWith(home + sep2) ? `~${abs.slice(home.length)}` : abs;
  }
  spell(abs) {
    if (this.m.context.some((e) => abs === e.root || abs.startsWith(e.root + sep2)))
      return abs;
    const real = realOr(abs);
    for (const e of this.m.context) {
      const realRoot = realOr(e.root);
      if (real === realRoot)
        return e.root;
      if (real.startsWith(realRoot + sep2))
        return join4(e.root, relative3(realRoot, real));
    }
    return abs;
  }
  isWorkspace(abs) {
    return abs === this.workspace || realOr(abs) === realOr(this.workspace);
  }
  coveringEntry(abs, except) {
    return this.m.context.find((e) => e.id !== except && e.membership === "mirrored" && (abs === e.root || abs.startsWith(e.root + sep2)));
  }
  destinationOrDie(rawDir) {
    const abs = this.spell(resolve(rawDir));
    for (const e of this.m.context) {
      if (e.membership !== "mirrored")
        continue;
      if (abs === e.root)
        return abs;
      if (abs.startsWith(e.root + sep2)) {
        const node = findNode(e.nodes, toPosix(relative3(e.root, abs)));
        if (node?.kind === "group")
          return abs;
      }
    }
    if (this.isWorkspace(abs))
      return this.workspace;
    throw new SessionError(`${abs} is not a folder in this session \u2014 name a set, a folder inside one, or the workspace (${this.workspace})`, 400);
  }
  itemOrDie(rawPath) {
    const abs = this.spell(resolve(rawPath));
    for (const e of this.m.context) {
      if (e.membership === "listed") {
        const only = e.nodes[0];
        if (e.nodes.length === 1 && only?.kind === "doc" && join4(e.root, only.rel) === abs)
          return { abs, entry: e, whole: true, dir: false };
        continue;
      }
      if (abs === e.root)
        return { abs, entry: e, whole: true, dir: true };
      if (abs.startsWith(e.root + sep2)) {
        const node = findNode(e.nodes, toPosix(relative3(e.root, abs)));
        if (node)
          return { abs, entry: e, whole: false, dir: node.kind === "group" };
      }
    }
    throw new SessionError(`${abs} is not shown in this session's context`, 404);
  }
  shownPath(rawPath) {
    const abs = this.spell(resolve(rawPath));
    if (this.itemAt(abs))
      return abs;
    try {
      return this.destinationOrDie(abs);
    } catch {
      throw new SessionError(`${abs} is not shown in this session`, 400);
    }
  }
  nameOrDie(name) {
    const n = name.trim();
    if (n === "" || n === "." || n === ".." || n.startsWith(".") || /[/\\\0]/.test(n) || n.length > 255)
      throw new SessionError(`"${name}" is not a usable name \u2014 one plain name, no slashes, not starting with a dot`, 400);
    return n;
  }
  docNameOrDie(name) {
    const n = this.nameOrDie(name);
    return isDocName(n) ? n : `${n}.md`;
  }
  followMove(from, to) {
    const moved = (p) => p === from ? to : p.startsWith(from + sep2) ? to + p.slice(from.length) : null;
    for (const d of this.m.docs) {
      const now = moved(d.original);
      if (now) {
        d.original = now;
        d.name = basename3(now);
      }
    }
    const drop = new Set;
    for (const e of this.m.context) {
      if (e.membership === "listed") {
        const only = e.nodes[0];
        if (only?.kind !== "doc")
          continue;
        const now = moved(join4(e.root, only.rel));
        if (!now)
          continue;
        if (this.coveringEntry(now, e.id))
          drop.add(e.id);
        else {
          e.root = dirname3(now);
          e.label = basename3(now);
          e.nodes = [{ kind: "doc", rel: basename3(now) }];
        }
      } else {
        const now = moved(e.root);
        if (!now)
          continue;
        if (this.coveringEntry(now, e.id))
          drop.add(e.id);
        else {
          e.root = now;
          e.label = basename3(now) || now;
        }
      }
    }
    this.m.context = this.m.context.filter((e) => !drop.has(e.id));
    for (const e of this.m.context)
      if (e.membership === "mirrored")
        this.rescan(e.id);
    this.relink();
  }
  adoptNew(abs) {
    const set = this.coveringEntry(abs);
    if (set)
      this.rescan(set.id);
    else
      this.m.context.push(entryForPath(abs, `c-${randHex(3)}`));
    this.relink();
  }
  freeName(dir, name, isDir) {
    if (!existsSync3(join4(dir, name)))
      return name;
    const ext = isDir ? "" : extname2(name);
    const stem2 = ext ? name.slice(0, -ext.length) : name;
    for (let i = 2;; i++) {
      const n = `${stem2} ${i}${ext}`;
      if (!existsSync3(join4(dir, n)))
        return n;
    }
  }
  refuseExisting(abs) {
    if (existsSync3(abs))
      throw new SessionError(`${abs} already exists \u2014 nothing was overwritten`, 409);
  }
  createDoc(rawDir, name) {
    const dir = this.destinationOrDie(rawDir);
    const file = name === undefined ? this.freeName(dir, "Untitled.md", false) : this.docNameOrDie(name);
    const abs = join4(dir, file);
    this.refuseExisting(abs);
    writeFileSync2(abs, "", { flag: "wx" });
    this.adoptNew(abs);
    this.persist();
    return { path: abs };
  }
  createFolder(rawDir, name) {
    const dir = this.destinationOrDie(rawDir);
    const folder = name === undefined ? this.freeName(dir, "New folder", true) : this.nameOrDie(name);
    const abs = join4(dir, folder);
    this.refuseExisting(abs);
    mkdirSync(abs);
    this.adoptNew(abs);
    this.persist();
    return { path: abs };
  }
  movePlan(rawPath, rawInto) {
    const item = this.itemOrDie(rawPath);
    const into = this.destinationOrDie(rawInto);
    const fromRepo = gitRootOf(dirname3(item.abs));
    const intoRepo = gitRootOf(into);
    return {
      from: item.abs,
      into,
      name: basename3(item.abs),
      folder: item.dir,
      docs: item.dir ? countDocs(item.abs) : 1,
      repo: fromRepo ? basename3(fromRepo) : null,
      leavesRepo: fromRepo !== null && fromRepo !== intoRepo
    };
  }
  move(rawPath, rawInto) {
    const item = this.itemOrDie(rawPath);
    const into = this.destinationOrDie(rawInto);
    if (into === item.abs || into.startsWith(item.abs + sep2))
      throw new SessionError(`cannot move ${this.display(item.abs)} into itself`, 400);
    if (dirname3(item.abs) === into)
      throw new SessionError(`${this.display(item.abs)} is already in that folder`, 400);
    const to = join4(into, basename3(item.abs));
    this.refuseExisting(to);
    this.renameOrDie(item.abs, to);
    this.followMove(item.abs, to);
    if (!this.itemAt(to))
      this.adoptNew(to);
    this.persist();
    return { path: to, from: item.abs };
  }
  rename(rawPath, name) {
    const item = this.itemOrDie(rawPath);
    let next = this.nameOrDie(name);
    if (!item.dir && !isDocName(next))
      next += extname2(item.abs) || ".md";
    const to = join4(dirname3(item.abs), next);
    if (to === item.abs)
      return { path: to, from: item.abs };
    if (to.toLowerCase() !== item.abs.toLowerCase())
      this.refuseExisting(to);
    this.renameOrDie(item.abs, to);
    this.followMove(item.abs, to);
    this.persist();
    return { path: to, from: item.abs };
  }
  renameOrDie(from, to) {
    try {
      renameSync2(from, to);
    } catch (e) {
      const code = e.code;
      throw new SessionError(code === "EXDEV" ? `cannot move ${from} to another disk (${to}) \u2014 copy it instead` : `cannot move ${from} to ${to}: ${code ?? String(e)}`, 409);
    }
  }
  itemAt(abs) {
    try {
      this.itemOrDie(abs);
      return true;
    } catch {
      return false;
    }
  }
  hide(rawPath) {
    const item = this.itemOrDie(rawPath);
    if (item.whole) {
      this.removeContext(item.entry.id);
      return { path: item.abs, entry: item.entry.id, removedEntry: true };
    }
    const rel = toPosix(relative3(item.entry.root, item.abs));
    item.entry.hidden = [...(item.entry.hidden ?? []).filter((h) => h !== rel), rel];
    this.rescan(item.entry.id);
    this.relink();
    this.closeOrphanedOpenDoc();
    this.persist();
    return { path: item.abs, entry: item.entry.id, removedEntry: false };
  }
  unhide(entryId) {
    const e = this.m.context.find((x) => x.id === entryId);
    if (!e)
      throw new SessionError(`no context entry ${entryId}`, 404, this.m.context.map((x) => x.id));
    const restored = e.hidden?.length ?? 0;
    delete e.hidden;
    this.rescan(e.id);
    this.relink();
    this.persist();
    return { entry: e.id, restored };
  }
  makeSet(rawPath) {
    const item = this.itemOrDie(rawPath);
    if (item.entry.membership !== "listed" || item.dir)
      throw new SessionError(`${this.display(item.abs)} is already in a set \u2014 make a folder there instead`, 400);
    const parent = dirname3(item.abs);
    const stem2 = basename3(item.abs, extname2(item.abs)) || "Untitled";
    const folder = join4(parent, this.freeName(parent, stem2, true));
    mkdirSync(folder);
    const to = join4(folder, basename3(item.abs));
    this.renameOrDie(item.abs, to);
    const e = item.entry;
    e.membership = "mirrored";
    e.root = folder;
    e.label = basename3(folder);
    e.nodes = [];
    this.followMove(item.abs, to);
    this.persist();
    return { path: to, folder, entry: e.id };
  }
  static IMPORT_MAX_BYTES = 8 * 1024 * 1024;
  importText(name, text, rawInto) {
    const file = this.nameOrDie(name);
    if (!isDocName(file))
      throw new SessionError(`not a document Scriptorium opens (${DOC_EXTENSIONS.join(" ")}): ${file}`, 400, [...DOC_EXTENSIONS]);
    if (Buffer.byteLength(text) > Session.IMPORT_MAX_BYTES)
      throw new SessionError(`${file} is larger than ${Session.IMPORT_MAX_BYTES / 1024 / 1024} MB \u2014 not imported`, 400);
    const dir = this.destinationOrDie(rawInto ?? this.workspace);
    const abs = join4(dir, this.freeName(dir, file, false));
    writeFileSync2(abs, text, { flag: "wx" });
    this.adoptNew(abs);
    this.persist();
    return { path: abs };
  }
  addMessage(who, text, extra = {}) {
    const msg = { id: `m-${randHex(4)}`, who, text, ts: Date.now(), ...extra };
    this.m.chat.push(msg);
    this.persist();
    return msg;
  }
  metaOf(d) {
    try {
      return readMeta(readFileSync3(this.versionPath(d, d.active), "utf8"));
    } catch {
      return null;
    }
  }
  docView(d) {
    return {
      meta: this.metaOf(d),
      slug: d.slug,
      name: d.name,
      original: d.original,
      entryId: d.entryId,
      rel: d.rel,
      versions: d.versions.map((v) => ({ ...v, path: this.versionPath(d, v.n) })),
      active: d.active,
      dirty: this.isDirty(d),
      outsideChanged: d.outsideChanged
    };
  }
  doc(slug) {
    return this.docView(this.docOrDie(slug));
  }
  metaCache = new Map;
  contextMeta(cap = META_SCAN_CAP) {
    const map = {};
    let seen = 0;
    let truncated = false;
    for (const e of this.m.context) {
      for (const abs of docPaths(e)) {
        if (seen >= cap) {
          truncated = true;
          break;
        }
        seen++;
        let mtimeMs;
        try {
          mtimeMs = statSync2(abs).mtimeMs;
        } catch {
          continue;
        }
        const hit = this.metaCache.get(abs);
        let summary;
        if (hit && hit.mtimeMs === mtimeMs)
          summary = hit.summary;
        else {
          summary = summarize(readMeta(readHead(abs)));
          this.metaCache.set(abs, { mtimeMs, summary });
        }
        if (summary)
          map[abs] = summary;
      }
      if (truncated)
        break;
    }
    return { map, truncated };
  }
  metaFor(rawPath) {
    if (rawPath !== undefined) {
      const abs = this.shownPath(rawPath);
      const meta = readMeta(readHead(abs));
      return { path: abs, meta, ...meta ? {} : { note: "no frontmatter block" } };
    }
    const out = [];
    for (const e of this.m.context)
      for (const abs of docPaths(e))
        out.push({ path: abs, meta: readMeta(readHead(abs)) });
    return { documents: out, count: out.length };
  }
  find(filter) {
    const matches = [];
    for (const e of this.m.context)
      for (const abs of docPaths(e)) {
        const meta = readMeta(readHead(abs));
        if (!matchesFilter(meta, filter))
          continue;
        matches.push({
          path: abs,
          entry: e.id,
          ...meta?.type ? { type: meta.type } : {},
          ...meta?.title ? { title: meta.title } : {},
          ...meta?.description ? { description: meta.description } : {},
          status: meta?.status ?? null,
          ...meta?.lifecycle ? { lifecycle: meta.lifecycle } : {},
          tags: meta?.tags ?? [],
          date: meta?.date ?? null
        });
      }
    return { matches, count: matches.length };
  }
  graphFor(entryId) {
    const e = entryId ? this.m.context.find((x) => x.id === entryId) : this.m.context.find((x) => x.membership === "mirrored");
    if (!e)
      throw new SessionError(entryId ? `no context entry ${entryId}` : "this session has no set to map", 404, this.m.context.map((x) => x.id));
    const paths = docPaths(e);
    const index = {
      root: e.root,
      paths,
      metaOf: (p) => readMeta(readHead(p)),
      exists: (p) => existsSync3(p),
      repoRoot: gitRootOf(e.root)
    };
    const g = buildGraph(index, (p) => {
      try {
        return splitFrontmatter(readFileSync3(p, "utf8")).body;
      } catch {
        return "";
      }
    });
    return { entry: e.id, ...g };
  }
  backlinks(rawPath) {
    const abs = this.shownPath(rawPath);
    const entry = this.m.context.find((e) => e.membership === "mirrored" && (abs === e.root || abs.startsWith(e.root + sep2)));
    if (!entry)
      throw new SessionError(`${abs} is not inside a set, so nothing maps it`, 400);
    const g = this.graphFor(entry.id);
    const inbound = g.edges.filter((x) => x.to === abs);
    const title = (p) => g.nodes.find((n) => n.path === p)?.title ?? basename3(p);
    return {
      target: { path: abs, title: title(abs) },
      related: inbound.filter((x) => x.source === "frontmatter").map((x) => ({ path: x.from, title: title(x.from), key: x.key })),
      links: inbound.filter((x) => x.source === "link").map((x) => ({ path: x.from, title: title(x.from), rel: x.rel })),
      count: inbound.length
    };
  }
  resolveLink(from, target) {
    const src = this.shownPath(from);
    const entry = this.m.context.find((e) => e.membership === "mirrored" && src.startsWith(e.root + sep2));
    const root = entry?.root ?? dirname3(src);
    const paths = entry ? docPaths(entry) : [src];
    return resolveTarget(target, src, {
      root,
      paths,
      metaOf: (p) => readMeta(readHead(p)),
      exists: (p) => existsSync3(p),
      repoRoot: gitRootOf(root)
    });
  }
  suggestMeta(rawPath, by) {
    const abs = this.shownPath(rawPath);
    const text = readFileSync3(abs, "utf8");
    if (splitFrontmatter(text).raw !== null)
      throw new SessionError(`${basename3(abs)} already has frontmatter`, 409);
    const folder = dirname3(abs);
    const siblings = [];
    for (const e of this.m.context)
      for (const p of docPaths(e))
        if (p !== abs && dirname3(p) === folder) {
          const t = readMeta(readHead(p))?.type;
          if (t)
            siblings.push(t);
        }
    const type = guessType(siblings, basename3(folder));
    return {
      path: abs,
      type,
      block: buildBlock({
        ...type ? { type } : {},
        ...titleFromBody(text) ? { title: titleFromBody(text) } : {},
        ...by ? { by } : {}
      })
    };
  }
  metaInit(rawPath, opts = {}) {
    const suggested = this.suggestMeta(rawPath, opts.by);
    const abs = suggested.path;
    const text = readFileSync3(abs, "utf8");
    const block = opts.type ? buildBlock({
      type: opts.type,
      ...titleFromBody(text) ? { title: titleFromBody(text) } : {},
      ...opts.by ? { by: opts.by } : {}
    }) : suggested.block;
    writeFileSync2(abs, withBlock(text, block));
    this.metaCache.delete(abs);
    return { path: abs, type: opts.type ?? suggested.type ?? null, added: true };
  }
  metaSet(rawPath, pairs) {
    const abs = this.shownPath(rawPath);
    let text = readFileSync3(abs, "utf8");
    if (splitFrontmatter(text).raw === null)
      throw new SessionError(`${basename3(abs)} has no frontmatter \u2014 add it first (meta-init)`, 409);
    for (const [key, value] of Object.entries(pairs)) {
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key))
        throw new SessionError(`"${key}" is not a frontmatter key`, 400);
      text = setKey(text, key, value);
    }
    writeFileSync2(abs, text);
    this.metaCache.delete(abs);
    return { path: abs, set: Object.keys(pairs) };
  }
  view(mode, selection) {
    const meta = this.contextMeta();
    return {
      sessionId: this.m.sessionId,
      home: this.home,
      workspace: this.workspace,
      docMeta: meta.map,
      ...meta.truncated ? { docMetaTruncated: true } : {},
      mode,
      context: this.m.context,
      docs: this.m.docs.map((d) => this.docView(d)),
      openDoc: this.m.openDoc,
      selection,
      chat: this.m.chat
    };
  }
}
function gitRootOf(dir) {
  let at = dir;
  for (;; ) {
    if (existsSync3(join4(at, ".git")))
      return at;
    const up = dirname3(at);
    if (up === at)
      return null;
    at = up;
  }
}
function countDocs(dir) {
  let n = 0;
  const walk = (at) => {
    let names;
    try {
      names = readdirSync2(at);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith("."))
        continue;
      const abs = join4(at, name);
      let st;
      try {
        st = statSync2(abs);
      } catch {
        continue;
      }
      if (st.isDirectory())
        walk(abs);
      else if (isDocName(name))
        n++;
    }
  };
  walk(dir);
  return n;
}
function sideName(side, file) {
  if (side !== "original")
    return `v${side}`;
  return file ?? "the saved file";
}

// src/scriptorium/backend/server.ts
var SCRIPT_DIR = dirname4(fileURLToPath(import.meta.url));
var SKILL_ROOT = join5(SCRIPT_DIR, "..");
var DIST_DIR = join5(SKILL_ROOT, "dist");
function resolveMode2() {
  return resolveMode(DIST_DIR);
}
function serveDist(path) {
  return serveFromDist(DIST_DIR, path === "/" ? "index.html" : path.slice(1));
}
function scriptoriumHome() {
  return resolve2(process.env.SCRIPTORIUM_HOME ?? join5(homedir2(), ".scriptorium"));
}
var WATCH_SETTLE_MS = 60;
async function startDaemon(opts) {
  const home = scriptoriumHome();
  const mode = resolveMode2();
  const devIndex = mode === "dev" ? (await import("../../../../../src/scriptorium/surface/index.html")).default : undefined;
  const routes = devIndex ? { "/": devIndex } : {};
  const session = opts.restore ? Session.restore(home, opts.restore) : Session.create(home, undefined, opts.workspace);
  const sessionId = session.id;
  let selection = null;
  const prefsFile = join5(home, "prefs.json");
  const PREF_KEY = /^[a-z][a-z0-9:._-]{0,63}$/;
  const PREF_VALUE_MAX = 4096;
  const PREF_KEYS_MAX = 64;
  const readPrefs = () => {
    const out = {};
    try {
      const raw = JSON.parse(readFileSync4(prefsFile, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw))
          if (PREF_KEY.test(k) && typeof v === "string" && v.length <= PREF_VALUE_MAX)
            out[k] = v;
      }
    } catch {}
    return out;
  };
  const userHome = homedir2();
  const viewState = () => ({ ...session.view(mode, selection), prefs: readPrefs(), userHome });
  const sockets = new Set;
  const log = createEventLog({ epoch: crypto.randomUUID() });
  const sseClients = new Set;
  let lastActivity = performance.now();
  const touch = () => {
    lastActivity = performance.now();
  };
  const send = (msg) => {
    const s = JSON.stringify(msg);
    for (const ws of sockets) {
      try {
        ws.send(s);
      } catch {}
    }
  };
  const broadcastState = () => send({ type: "state", state: viewState() });
  const announce = (text, fact = {}) => {
    const m = session.addMessage("system", text);
    log.emit({ type: "system", text, ts: m.ts, ...fact });
    broadcastState();
  };
  const watchers = new Map;
  const pending = new Map;
  const onFs = (abs) => {
    const t = pending.get(abs);
    if (t)
      clearTimeout(t);
    pending.set(abs, setTimeout(() => {
      pending.delete(abs);
      let ev = null;
      try {
        ev = session.onFileEvent(abs);
      } catch (e) {
        process.stderr.write(`scriptorium: watcher: ${e}
`);
      }
      if (ev)
        handleFileEvent(ev);
    }, WATCH_SETTLE_MS));
  };
  const syncWatchers = () => {
    const want = new Map(session.watchRoots().map((r) => [`${r.recursive ? "R" : "F"}:${r.watch}>${r.path}`, r]));
    for (const [key, w] of watchers)
      if (!want.has(key)) {
        w.close();
        watchers.delete(key);
      }
    for (const [key, r] of want) {
      if (watchers.has(key))
        continue;
      try {
        const w = watch(r.watch, { recursive: r.recursive }, (_event, name) => {
          if (name)
            onFs(join5(r.path, name.toString()));
          else if (r.entryId)
            onFs(r.path);
        });
        w.on("error", () => {});
        watchers.set(key, w);
      } catch {}
    }
  };
  const handleFileEvent = (ev) => {
    switch (ev.kind) {
      case "version.changed":
        send({
          type: "version.text",
          doc: ev.doc,
          version: ev.version,
          text: ev.text,
          origin: "remote"
        });
        broadcastState();
        return;
      case "version.created":
        announce(`v${ev.version} of ${ev.doc} appeared (written directly to ${ev.path})`, {
          fact: "version.created",
          doc: ev.doc,
          version: ev.version
        });
        return;
      case "active.outside":
        announceOutside(ev.doc, ev.version, ev.path, ev.preservedAs, ev.preservedPath);
        return;
      case "original.reloaded":
        send({
          type: "version.text",
          doc: ev.doc,
          version: ev.version,
          text: ev.text,
          origin: "remote"
        });
        announce(`${ev.original} changed on disk \u2014 reloaded (you had no unsaved edits).`, {
          fact: "original.reloaded",
          doc: ev.doc
        });
        return;
      case "original.conflict":
        announce(`${ev.original} changed on disk while you have unsaved edits. Save overwrites it with yours; Revert takes the file's version.`, { fact: "original.conflict", doc: ev.doc });
        return;
      case "tree":
        broadcastState();
        return;
    }
  };
  const announceOutside = (doc, version, path, preservedAs, preservedPath) => announce(`v${version} of ${doc} is the ACTIVE version and was written from outside the editor. That text is kept as v${preservedAs}; the active version keeps your text. Agent edits belong in a new version (version-new).`, { fact: "active.outside", doc, version, path, preservedAs, preservedPath });
  const addPaths = (paths) => {
    const added = paths.map((p) => session.addContext(p));
    syncWatchers();
    broadcastState();
    return added;
  };
  const activate = (doc, version, by) => {
    const r = session.activate({ doc, version });
    const view = session.doc(r.slug);
    const path = view.versions.find((v) => v.n === version)?.path ?? null;
    send({
      type: "version.text",
      doc: r.slug,
      version,
      text: session.readVersion(r.slug, version).text,
      origin: "load"
    });
    const m = session.addMessage("system", `${by === "agent" ? "Agent" : "You"} made v${version} of ${r.slug} active (was v${r.previous}).`);
    log.emit({ type: "activated", by, doc: r.slug, version, previous: r.previous, path, ts: m.ts });
    broadcastState();
    return { doc: r.slug, version, previous: r.previous, path };
  };
  const STRUCTURE_OPS = new Set([
    "doc.create",
    "folder.create",
    "move",
    "rename",
    "hide",
    "unhide",
    "set.make",
    "import",
    "workspace.set"
  ]);
  const isStructureOp = (m) => STRUCTURE_OPS.has(m.type);
  const structure = (op, by) => {
    const who = by === "agent" ? "Agent" : "You";
    const shown = (p) => session.display(p);
    let r;
    let line;
    switch (op.type) {
      case "doc.create":
        r = session.createDoc(op.dir, op.name);
        line = `${who} created ${shown(r.path)}.`;
        break;
      case "folder.create":
        r = session.createFolder(op.dir, op.name);
        line = `${who} created the folder ${shown(r.path)}.`;
        break;
      case "move": {
        const m = session.move(op.path, op.into);
        r = m;
        line = `${who} moved ${shown(m.from)} to ${shown(m.path)}.`;
        break;
      }
      case "rename": {
        const m = session.rename(op.path, op.name);
        r = m;
        line = `${who} renamed ${shown(m.from)} to ${shown(m.path)}.`;
        break;
      }
      case "hide": {
        const h = session.hide(op.path);
        r = h;
        line = `${who} removed ${shown(h.path)} from Scriptorium (the file is still on disk).`;
        break;
      }
      case "unhide": {
        const u = session.unhide(op.entry);
        r = u;
        line = `${who} brought back ${u.restored} hidden item${u.restored === 1 ? "" : "s"}.`;
        break;
      }
      case "set.make": {
        const m = session.makeSet(op.path);
        r = m;
        line = `${who} turned ${basename4(m.path)} into a set: ${shown(m.folder)}.`;
        break;
      }
      case "import":
        r = session.importText(op.name, op.text, op.into);
        line = `${who} copied ${op.name} in as ${shown(r.path)}.`;
        break;
      case "workspace.set":
        r = session.setWorkspace(op.path);
        line = `${who} set the workspace to ${shown(r.path)}.`;
        break;
    }
    syncWatchers();
    announce(line, { fact: op.type, by, ...r });
    return r;
  };
  const reply = (ws, msg) => {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  };
  const handleClientMsg = (ws, msg) => {
    if (isStructureOp(msg)) {
      const r = structure(anchorSurfacePaths(msg), "human");
      if (typeof r.path === "string")
        reply(ws, { type: "structure.done", op: msg.type, path: r.path });
      return;
    }
    switch (msg.type) {
      case "open": {
        const r = session.openPath(msg.path);
        syncWatchers();
        broadcastState();
        {
          const d = session.doc(r.slug);
          reply(ws, {
            type: "version.text",
            doc: r.slug,
            version: d.active,
            text: session.readVersion(r.slug, d.active).text,
            origin: "load"
          });
        }
        if (r.created)
          log.emit({ type: "doc.opened", doc: r.slug, path: session.activePath(r.slug) });
        return;
      }
      case "open.doc":
        session.openSlug(msg.doc);
        broadcastState();
        return;
      case "edit": {
        const r = session.edit(msg.doc, msg.version, msg.text);
        if (r.preserved) {
          const d = session.doc(msg.doc);
          announceOutside(d.slug, msg.version, session.activePath(d.slug) ?? "", r.preserved.n, r.preserved.path);
        } else if (r.dirtyChanged)
          broadcastState();
        return;
      }
      case "select":
        selection = msg.selection;
        return;
      case "say": {
        const text = msg.text.trim();
        if (!text)
          return;
        const sel = msg.withSelection ? selection : null;
        const activePath = sel ? session.activePath(sel.doc) : session.activePath();
        const m = session.addMessage("human", text, { selection: sel, activePath });
        log.emit({
          type: "message",
          message_id: m.id,
          text,
          selection: sel,
          active: activeOf(sel?.doc),
          ts: m.ts
        });
        broadcastState();
        return;
      }
      case "activate":
        activate(msg.doc, msg.version, "human");
        return;
      case "version.delete": {
        const r = session.deleteVersion({ doc: msg.doc, version: msg.version });
        const m = session.addMessage("system", `Deleted v${r.version} of ${r.slug}${r.label ? ` \u2014 ${r.label}` : ""}.`);
        log.emit({
          type: "version.deleted",
          doc: r.slug,
          version: r.version,
          by: "human",
          ts: m.ts
        });
        broadcastState();
        return;
      }
      case "version.new": {
        const r = session.newVersion({
          doc: msg.doc,
          ...msg.from === undefined ? {} : { from: msg.from },
          ...msg.label ? { label: msg.label } : {},
          author: "human"
        });
        if (msg.activate)
          session.activate({ doc: r.slug, version: r.version.n });
        const m = session.addMessage("system", `Made v${r.version.n} of ${r.slug} from v${r.version.from}${msg.label ? ` \u2014 ${msg.label}` : ""}. ` + (msg.activate ? `You are now editing v${r.version.n}.` : `You are still editing v${r.version.from}.`));
        log.emit({
          type: "version.created",
          doc: r.slug,
          version: r.version.n,
          from: r.version.from,
          activated: msg.activate === true,
          by: "human",
          ts: m.ts
        });
        broadcastState();
        return;
      }
      case "save": {
        const r = session.save(msg.doc);
        const m = session.addMessage("system", `Saved v${r.version} to ${r.original}.`);
        log.emit({
          type: "saved",
          doc: msg.doc,
          version: r.version,
          original: r.original,
          ts: m.ts
        });
        broadcastState();
        return;
      }
      case "revert": {
        const r = session.revert(msg.doc);
        send({
          type: "version.text",
          doc: msg.doc,
          version: r.version,
          text: r.text,
          origin: "remote"
        });
        const m = session.addMessage("system", `Reverted v${r.version} of ${msg.doc} to the saved file.`);
        log.emit({ type: "reverted", doc: msg.doc, version: r.version, ts: m.ts });
        broadcastState();
        return;
      }
      case "context.add":
        addPaths([surfacePath(msg.path)]);
        return;
      case "reveal":
        revealPath(session.shownPath(surfacePath(msg.path)));
        return;
      case "reveal.version":
        revealPath(session.readVersion(msg.doc, msg.version).path);
        return;
      case "pick": {
        openPicker(ws, msg.want);
        return;
      }
      case "context.remove":
        session.removeContext(msg.id);
        syncWatchers();
        broadcastState();
        return;
      case "read": {
        reply(ws, {
          type: "version.text",
          doc: msg.doc,
          version: msg.version,
          text: session.readVersion(msg.doc, msg.version).text,
          origin: "load"
        });
        return;
      }
      case "diff": {
        reply(ws, { type: "diff", ...session.compare({ doc: msg.doc, against: msg.against }) });
        return;
      }
      case "merge": {
        const r = session.merge({ doc: msg.doc, against: msg.against, hunks: msg.hunks });
        send({
          type: "version.text",
          doc: r.slug,
          version: r.version,
          text: r.text,
          origin: "remote"
        });
        const m = session.addMessage("system", `Took ${r.applied} change${r.applied === 1 ? "" : "s"} from ${sideName(msg.against, session.doc(r.slug).name)} into v${r.version} of ${r.slug}.`);
        log.emit({
          type: "merged",
          doc: r.slug,
          version: r.version,
          against: msg.against,
          hunks: msg.hunks,
          by: "human",
          ts: m.ts
        });
        broadcastState();
        return;
      }
      case "prefs.set": {
        if (!PREF_KEY.test(msg.key) || typeof msg.value !== "string" || msg.value.length > PREF_VALUE_MAX)
          throw new Error(`refused pref ${JSON.stringify(msg.key)}`);
        const current = readPrefs();
        if (current[msg.key] === msg.value)
          return;
        if (!(msg.key in current) && Object.keys(current).length >= PREF_KEYS_MAX)
          throw new Error(`refused pref ${JSON.stringify(msg.key)}: ${PREF_KEYS_MAX} keys already kept`);
        writeFileAtomic(prefsFile, `${JSON.stringify({ ...current, [msg.key]: msg.value }, null, 2)}
`);
        broadcastState();
        return;
      }
      case "graph": {
        try {
          reply(ws, { type: "graph", entry: msg.entry, graph: session.graphFor(msg.entry) });
        } catch (e) {
          reply(ws, {
            type: "graph",
            entry: msg.entry,
            error: e instanceof Error ? e.message : String(e)
          });
        }
        return;
      }
      case "link.open": {
        const r = session.resolveLink(msg.from, msg.target);
        if (r.state === "in-bundle") {
          session.openPath(r.path);
          broadcastState();
          const d = session.doc(session.openDocSlug ?? "");
          reply(ws, {
            type: "version.text",
            doc: d.slug,
            version: d.active,
            text: session.readVersion(d.slug, d.active).text,
            origin: "load"
          });
        }
        reply(ws, {
          type: "link.target",
          target: msg.target,
          state: r.state,
          ...r.state === "missing" ? {} : { path: r.path }
        });
        return;
      }
      case "meta.suggest": {
        try {
          const r = session.suggestMeta(msg.path, "human");
          reply(ws, {
            type: "meta.suggestion",
            path: msg.path,
            block: r.block,
            ...r.type ? { suggestedType: r.type } : {}
          });
        } catch (e) {
          reply(ws, {
            type: "meta.suggestion",
            path: msg.path,
            error: e instanceof Error ? e.message : String(e)
          });
        }
        return;
      }
      case "move.plan": {
        try {
          reply(ws, {
            type: "move.plan",
            path: msg.path,
            into: msg.into,
            plan: session.movePlan(surfacePath(msg.path), surfacePath(msg.into))
          });
        } catch (e) {
          reply(ws, {
            type: "move.plan",
            path: msg.path,
            into: msg.into,
            error: e instanceof Error ? e.message : String(e)
          });
        }
        return;
      }
      case "fs.list": {
        const path = expandHome(msg.path);
        try {
          reply(ws, { type: "fs.list", path: msg.path, entries: listDir(path) });
        } catch (e) {
          reply(ws, {
            type: "fs.list",
            path: msg.path,
            entries: [],
            error: String(e.message)
          });
        }
        return;
      }
    }
  };
  let pickerOpen = false;
  const zenity = process.platform === "linux" ? Bun.which("zenity") : null;
  const openPicker = async (ws, want) => {
    if (pickerOpen) {
      reply(ws, { type: "error", message: "a file picker is already open" });
      return;
    }
    const kind = want === "context-file" ? "file" : "folder";
    const prompt = want === "workspace" ? "Choose the workspace folder for scriptorium" : want === "context-folder" ? "Choose a folder to add to scriptorium" : "Choose documents to add to scriptorium";
    const cmd = pickerCommand(process.platform, kind, prompt, zenity);
    if (!cmd) {
      reply(ws, {
        type: "error",
        message: `no file picker on this system (${process.platform}) \u2014 type the path instead`
      });
      return;
    }
    pickerOpen = true;
    try {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      touch();
      const paths = parsePickerOutput(out);
      if (paths.length === 0) {
        if (!wasCancelled(code, out))
          reply(ws, { type: "error", message: `the file picker failed (exit ${code})` });
        return;
      }
      try {
        if (want === "workspace")
          structure({ type: "workspace.set", path: paths[0] }, "human");
        else
          addPaths(paths);
      } catch (e) {
        reply(ws, { type: "error", message: e instanceof Error ? e.message : String(e) });
      }
    } catch (e) {
      reply(ws, {
        type: "error",
        message: `could not open the file picker: ${e instanceof Error ? e.message : String(e)}`
      });
    } finally {
      pickerOpen = false;
    }
  };
  const activeOf = (doc) => {
    const slug = doc ?? session.openDocSlug;
    if (!slug)
      return null;
    try {
      const v = session.doc(slug);
      return { doc: v.slug, version: v.active, path: session.activePath(v.slug) };
    } catch {
      return null;
    }
  };
  let resolveDone;
  const done = new Promise((r) => {
    resolveDone = r;
  });
  const revealPath = (path) => {
    const [cmd, ...args] = process.platform === "darwin" ? ["open", "-R", path] : process.platform === "win32" ? ["explorer", `/select,${path}`] : ["xdg-open", dirname4(path)];
    Bun.spawn([cmd, ...args], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  };
  const handleAgentCmd = (cmd) => {
    if (isStructureOp(cmd))
      return structure(cmd, "agent");
    switch (cmd.type) {
      case "meta":
        return session.metaFor(cmd.path);
      case "graph":
        return session.graphFor(cmd.entry);
      case "backlinks":
        return session.backlinks(cmd.path);
      case "meta.init": {
        const r = session.metaInit(cmd.path, {
          ...cmd.metaType ? { type: cmd.metaType } : {},
          by: cmd.by ?? "agent"
        });
        announce(`Agent added frontmatter to ${session.display(String(r.path))}.`, {
          fact: "meta.init",
          by: "agent",
          ...r
        });
        return r;
      }
      case "meta.set": {
        const r = session.metaSet(cmd.path, cmd.fields);
        announce(`Agent set ${r.set.join(", ")} on ${session.display(String(r.path))}.`, { fact: "meta.set", by: "agent", ...r });
        return r;
      }
      case "version.delete": {
        const r = session.deleteVersion({ doc: cmd.doc, version: cmd.version });
        announce(`Agent deleted v${r.version} of ${r.slug}${r.label ? ` \u2014 ${r.label}` : ""}.`, {
          fact: "version.deleted",
          doc: r.slug,
          version: r.version,
          by: "agent"
        });
        return { doc: r.slug, version: r.version, remaining: r.remaining };
      }
      case "diff": {
        const p = session.compare({ doc: cmd.doc, against: cmd.against });
        return {
          doc: p.doc,
          active: p.active,
          against: p.against,
          same: p.diff.same,
          coarse: p.diff.coarse,
          hunks: p.diff.hunks,
          unified: unified(p.diff, {
            from: `v${p.active}`,
            to: sideName(p.against, session.doc(p.doc).name),
            ...cmd.context === undefined ? {} : { context: cmd.context }
          })
        };
      }
      case "merge": {
        const r = session.merge({ doc: cmd.doc, against: cmd.against, hunks: cmd.hunks });
        send({
          type: "version.text",
          doc: r.slug,
          version: r.version,
          text: r.text,
          origin: "remote"
        });
        announce(`Agent took ${r.applied} change${r.applied === 1 ? "" : "s"} from ${sideName(cmd.against, session.doc(r.slug).name)} into v${r.version} of ${r.slug}.`, { fact: "merged", doc: r.slug, version: r.version, hunks: cmd.hunks, by: "agent" });
        return { doc: r.slug, version: r.version, applied: r.applied };
      }
      case "find":
        return session.find(cmd.filter);
      case "context.add": {
        const added = addPaths(cmd.paths);
        return { entries: added.map((a) => ({ ...a.entry, added: a.added })) };
      }
      case "version.new": {
        if (cmd.doc && isAbsolute2(cmd.doc) && !session.findDoc(cmd.doc)) {
          const o = session.openPath(cmd.doc, { focus: false });
          if (o.created)
            log.emit({
              type: "doc.opened",
              doc: o.slug,
              path: session.activePath(o.slug),
              by: "agent"
            });
        }
        const r = session.newVersion({
          doc: cmd.doc,
          from: cmd.from,
          label: cmd.label,
          author: "agent"
        });
        announce(`Agent created v${r.version.n} of ${r.slug} from v${r.version.from}${cmd.label ? ` \u2014 ${cmd.label}` : ""}.`, { fact: "version.created", doc: r.slug, version: r.version.n });
        return { doc: r.slug, version: r.version.n, from: r.version.from, path: r.version.path };
      }
      case "say": {
        const m = session.addMessage("agent", cmd.text);
        broadcastState();
        return { id: m.id };
      }
      case "activate":
        return activate(cmd.doc, cmd.version, "agent");
      case "close":
        resolveDone({ code: 0, reason: "close" });
        return {};
      default:
        throw new SessionError(`unrecognised command type ${JSON.stringify(cmd.type)} \u2014 nothing was applied`, 400, [
          "context.add",
          "version.new",
          "say",
          "activate",
          "close",
          "meta",
          "find",
          "graph",
          "backlinks",
          "meta.init",
          "meta.set",
          ...STRUCTURE_OPS
        ]);
    }
  };
  const refusal = (e) => {
    if (e instanceof SessionError)
      return Response.json({ ok: false, error: e.message, ...e.choices ? { choices: e.choices } : {} }, { status: e.status });
    if (e instanceof PathError)
      return Response.json({ ok: false, error: e.message }, { status: 404 });
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  };
  const eventsResponse = (req, url) => {
    touch();
    return sseResponse({
      log,
      since: Number.parseInt(url.searchParams.get("since") ?? "-1", 10),
      heartbeatMs: SSE_HEARTBEAT_MS,
      clients: sseClients,
      signal: req.signal,
      onOpen: touch,
      onClose: touch
    });
  };
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    routes,
    idleTimeout: IDLE_TIMEOUT_SEC,
    development: { hmr: mode === "dev" },
    fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      if ((path === "/ws" || path === "/cmd" || path.startsWith("/fs/")) && !sameOrigin(req, srv.port))
        return Response.json({ ok: false, error: "foreign origin refused" }, { status: 403 });
      if (path === "/ws")
        return srv.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 });
      if (req.method === "GET" && path === "/state") {
        touch();
        const state = viewState();
        const full = url.searchParams.get("full") === "1";
        return Response.json({
          ...state,
          chat: full ? state.chat : state.chat.slice(-10),
          chatTotal: state.chat.length,
          active: activeOf(),
          cursor: log.cursor(),
          epoch: log.epoch
        });
      }
      if (req.method === "GET" && path === "/events")
        return eventsResponse(req, url);
      if (req.method === "GET" && path === "/fs/version") {
        touch();
        try {
          const r = session.readVersion(url.searchParams.get("doc") ?? "", Number.parseInt(url.searchParams.get("v") ?? "", 10));
          return Response.json(r);
        } catch (e) {
          return refusal(e);
        }
      }
      if (req.method === "GET" && path === "/fs/list") {
        try {
          return Response.json({
            entries: listDir(expandHome(url.searchParams.get("path") ?? "~"))
          });
        } catch (e) {
          return Response.json({ ok: false, error: String(e.message) }, { status: 404 });
        }
      }
      if (req.method === "POST" && path === "/cmd")
        return req.json().then((b) => {
          touch();
          try {
            return Response.json({ ok: true, ...handleAgentCmd(b) });
          } catch (e) {
            return refusal(e);
          }
        }).catch(() => Response.json({ ok: false, error: "bad json" }, { status: 400 }));
      if (mode === "release") {
        const asset = serveDist(path);
        if (asset)
          return asset;
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        touch();
        ws.send(JSON.stringify({ type: "state", state: viewState() }));
      },
      message(ws, raw) {
        touch();
        let msg;
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        } catch (e) {
          process.stderr.write(`scriptorium: bad json from browser: ${e}
`);
          return;
        }
        try {
          handleClientMsg(ws, msg);
        } catch (e) {
          reply(ws, { type: "error", message: e instanceof Error ? e.message : String(e) });
        }
      },
      close(ws) {
        sockets.delete(ws);
      }
    }
  });
  const boundPort = server.port;
  const sessionFile = join5(tmpdir(), `scriptorium-${sessionId}.json`);
  const latestFile = join5(tmpdir(), "scriptorium-latest.json");
  const info = JSON.stringify({
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    session_id: sessionId,
    home,
    dir: session.dir,
    mode
  });
  try {
    writeFileAtomic(sessionFile, info);
    writeFileAtomic(latestFile, info);
  } catch {}
  syncWatchers();
  log.emit({ type: "ready", mode, session_id: sessionId, restored: !!opts.restore });
  for (const f of session.restoreFindings)
    announce(f.missing ? `${f.original} is gone from disk since this session was last open. Save would recreate it; Revert cannot run.` : `${f.original} changed on disk while this session was closed. Save overwrites it with the active version; Revert takes the file's version.`, { fact: "original.conflict", doc: f.doc, whileClosed: true });
  const stopHousekeeping = startHousekeeping({
    subscriberCount: () => sockets.size + sseClients.size,
    idleMs: () => performance.now() - lastActivity,
    touch,
    timeoutMs: (opts.timeoutS ?? 1800) * 1000,
    onIdleClose: () => resolveDone({ code: 124, reason: "timeout" })
  });
  let closed = false;
  let resolveShutdown;
  const shutdown = new Promise((r) => {
    resolveShutdown = r;
  });
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
  };
  const close = () => {
    if (closed)
      return;
    closed = true;
    stopHousekeeping();
    for (const w of watchers.values())
      w.close();
    watchers.clear();
    for (const t of pending.values())
      clearTimeout(t);
    try {
      session.persist();
    } catch {}
    cleanupDiscovery();
    log.emit({ type: "closed" });
    drainAndStop({ server, clients: sseClients, sockets }).then(resolveShutdown);
  };
  done.then(() => close());
  return { port: boundPort, sessionId, mode, dir: session.dir, close, done, shutdown };
}
function sameOrigin(req, port) {
  const origin = req.headers.get("origin");
  if (origin === null)
    return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}
function surfacePath(p) {
  const t = p.trim();
  if (t === "~" || t.startsWith("~/"))
    return expandHome(t);
  if (!isAbsolute2(t))
    throw new SessionError(`"${p}" is not a full path \u2014 start it with / or ~/`, 400);
  return resolve2(t);
}
function anchorSurfacePaths(op) {
  const out = { ...op };
  for (const k of ["dir", "path", "into"])
    if (typeof out[k] === "string")
      out[k] = surfacePath(out[k]);
  return out;
}
function expandHome(p) {
  if (p === "~")
    return homedir2();
  if (p.startsWith("~/"))
    return join5(homedir2(), p.slice(2));
  return resolve2(p);
}
var DAEMON_OPTIONS = {
  log: { type: "string" },
  port: { type: "string" },
  restore: { type: "string" },
  timeout: { type: "string" },
  workspace: { type: "string" }
};
async function main(argv) {
  let flags;
  try {
    flags = nodeParseArgs({ args: argv, options: DAEMON_OPTIONS, strict: true }).values;
  } catch (e) {
    process.stderr.write(`scriptorium: ${e instanceof Error ? e.message : String(e)}
  recognized flags: ${Object.keys(DAEMON_OPTIONS).map((k) => `--${k}`).join(" ")}
`);
    return 2;
  }
  let d;
  try {
    d = await startDaemon({
      port: flags.port ? Number(flags.port) : 0,
      restore: flags.restore,
      timeoutS: flags.timeout ? Number(flags.timeout) : undefined,
      workspace: flags.workspace
    });
  } catch (e) {
    const status = e instanceof SessionError ? e.status : 500;
    process.stdout.write(`${JSON.stringify({ ok: false, status, error: e instanceof Error ? e.message : String(e) })}
`);
    return status === 404 ? 5 : status === 409 ? 6 : 1;
  }
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${d.port}`, port: d.port, session_id: d.sessionId, mode: d.mode, dir: d.dir })}
`);
  const res = await d.done;
  await d.shutdown;
  if (res.code === 0 && flags.log) {
    try {
      if (statSync3(flags.log).size === 0)
        unlinkSync2(flags.log);
    } catch {}
  }
  return res.code;
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  main,
  resolveMode2 as resolveMode,
  run,
  sameOrigin,
  scriptoriumHome,
  startDaemon,
  surfacePath
};

//# debugId=7305D921B868F7E664756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc3NlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2RpZmYudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvcGlja2VyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3Nlc3Npb24udHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvZnJvbnRtYXR0ZXIudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvbGlua3MudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvdHJlZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIvKipcbiAqIHNjcmlwdG9yaXVtJ3MgcGVyLXNlc3Npb24gZGFlbW9uIOKAlCB0aGUgcHJvY2VzcyB0aGUgc3VyZmFjZSB0YWxrcyB0byBvdmVyIGFcbiAqIFdlYlNvY2tldCBhbmQgdGhlIENMSSB0YWxrcyB0byBvdmVyIEhUVFAuIExhdW5jaGVkIGJ5XG4gKiBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL3NjcmlwdG9yaXVtL3NjcmlwdHMvc2VydmVyLnRzYCAodGhlIGxhdW5jaGVyKSwgd2hpY2hcbiAqIGltcG9ydHMgdGhlIEJVSUxUIGBkaXN0L3NlcnZlci5qc2AuXG4gKlxuICog4pSA4pSAIFRIRSBFSUdIVCBRVUVTVElPTlMgKHNjYWZmb2xkaW5nIHBsYXlib29rIE4xKSwgQU5TV0VSRUQgQVMgREVTSUdOIOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIDEuIEFyaXRobWV0aWM6IGBTS0lMTF9ST09UYC9gRElTVF9ESVJgIG9ubHksIGZvciB0aGUga2l0J3MgYHJlc29sdmVNb2RlYCBhbmRcbiAqICAgIGBzZXJ2ZUZyb21EaXN0YCwgYW5kIHRydWUgYXQgdGhlIEVNSVRURUQgYWRkcmVzcyAoYGRpc3Qvc2VydmVyLmpzYCwgd2hvc2VcbiAqICAgIGAuLmAgaXMgdGhlIHNraWxsIGZvbGRlcikuIE5vdGhpbmcgZWxzZSBpcyBwaW5uZWQgb2ZmIGBpbXBvcnQubWV0YWAuXG4gKiAyLiBTZXJ2ZXM6IFlFUy4gYC9gIGlzIHRoZSBidWlsdCBgaW5kZXguaHRtbGAgdmlhIGBzZXJ2ZUZyb21EaXN0YCwgbm9cbiAqICAgIHN1YnN0aXR1dGlvbjsgdGhlIG9ubHkgcm91dGVzIG9mIGl0cyBvd24gYXJlIGAvc3RhdGVgLCBgL2NtZGAsIGAvZXZlbnRzYCxcbiAqICAgIGAvd3NgIGFuZCBgL2ZzLypgIChyZWFkLW9ubHk6IGEgdmVyc2lvbidzIHRleHQsIGEgZGlyZWN0b3J5IGxpc3RpbmcpLlxuICogMy4gU2Vjb25kIGhhbGY6IFlFUyDigJQgYGNsaS50c2A7IHRoZSB0d28gc2hhcmUgYC4vaGVhcnRiZWF0LnRzYC5cbiAqIDQuIExpZmVjeWNsZTogbG9uZy1ydW5uaW5nLCBvbmUgZGFlbW9uIHBlciBzZXNzaW9uLCBpZGxlLXRpbWVvdXQgbGlrZVxuICogICAgZ2xhbW91ciAobGluZ2VyIGFmdGVyIHRoZSBsYXN0IHN1YnNjcmliZXIgbGVhdmVzOyBleGl0IDEyNCkuXG4gKiA1LiBgbWFpbigpYCByZXR1cm5zIHdoaWxlIHRoZSBwcm9jZXNzIG11c3QgbGl2ZT8gTk8g4oCUIGBtYWluYCBhd2FpdHMgdGhlXG4gKiAgICBzZXNzaW9uJ3MgZW5kIGFuZCBpdHMgb3duIGRyYWluLCBleGFjdGx5IGFzIGdsYW1vdXIncyBzZXJ2ZXIgZG9lcywgc28gdGhlXG4gKiAgICBsYXVuY2hlciBpcyBURVJNSU5BTC1FWElUIChgcHJvY2Vzcy5leGl0KGF3YWl0IHJ1bigpKWApOiBvbmNlIGBtYWluYFxuICogICAgcmVzb2x2ZXMgbm90aGluZyBtYXkga2VlcCB0aGUgcHJvY2VzcyBhbGl2ZSwgYW5kIGEgd2F0Y2hlciBoYW5kbGUgb3IgYVxuICogICAgc3RyYWdnbGluZyBzb2NrZXQgd291bGQuIERyaXZlbiwgbm90IHJlYWQgKHNlZSB0aGUgc2xpY2UtQSBqb3VybmFsKS5cbiAqIDYuIEV2ZW50IGlkcyByZWNvdmVyZWQgYWNyb3NzIHJlc3RhcnQ/IE5PIOKAlCB0aGUgbG9nIGlzIGluIG1lbW9yeSBhbmQgaWRzXG4gKiAgICByZXN0YXJ0IGF0IDEsIGV2ZW4gdW5kZXIgYC0tcmVzdG9yZWAgKHdoaWNoIHJlc3RvcmVzIHRoZSBNQU5JRkVTVCwgbm90IHRoZVxuICogICAgbG9nKS4gU28gdGhlIGxvZyBpcyBzdGFtcGVkIHdpdGggYSBwZXItYm9vdCBFUE9DSCAobWluZC1tYXBwZXIncyBzaGFwZSlcbiAqICAgIGFuZCB0aGUgdGFpbCByZXNldHMgaXRzIGN1cnNvciB3aGVuIHRoZSBlcG9jaCBjaGFuZ2VzLlxuICogNy4gQSBraXQgc3ViamVjdCBpbiBhIGRpZmZlcmVudCBzaGFwZT8gTm8g4oCUIHRoZSBzaGFwZSB3YXMgY2hvc2VuIHRvIGJlIHRoZVxuICogICAga2l0J3MuXG4gKiA4LiBBIGtpdCBtb2R1bGUgbmFtZXMgdGhpcyBzcGVsbCBhcyBpdHMgc291cmNlPyBTdHJ1Y3R1cmFsbHkgTk86IHNjcmlwdG9yaXVtXG4gKiAgICBpcyB0aGUgZmlyc3Qgc3BlbGwgc2NhZmZvbGRlZCBhZnRlciB0aGUgY29udmVyZ2VuY2UuXG4gKlxuICog4pSA4pSAIEtJVCBWRVJESUNUUyAocGxheWJvb2sgTjQpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGVycm9ycyBTVUJKRUNUICh0aGUgQ0xJOyB0aGUgZGFlbW9uIGFuc3dlcnMgSFRUUCBzdGF0dXNlcyB0aGUgQ0xJIG1hcHMpIMK3XG4gKiBzZXJ2ZURpc3QgU1VCSkVDVCAoYHJlc29sdmVNb2RlYCwgYHNlcnZlRnJvbURpc3RgKSDCtyBob3VzZWtlZXBpbmcgU1VCSkVDVCwgYWxsXG4gKiB0aHJlZSBleHBvcnRzIChgc2hvdWxkSWRsZUNsb3NlYCB2aWEgYHN0YXJ0SG91c2VrZWVwaW5nYCdzIGlkbGUtY2xvc2UsIHRoZVxuICogc25hcHNob3Qgc3dlZXAg4oCUIGhlcmUgdGhlIG1hbmlmZXN0IGlzIHdyaXR0ZW4gb24gZXZlcnkgY2hhbmdlIGluc3RlYWQsIHNvIHRoZVxuICogc3dlZXAncyBzbmFwc2hvdCBob29rIGlzIGRlbGliZXJhdGVseSBOT1QgcGFzc2VkIOKAlCBhbmQgYGRyYWluQW5kU3RvcGApIMK3XG4gKiB0YWlsRXZlbnRzIFNVQkpFQ1QgKHRoZSBDTEkncyBgdGFpbGApIMK3IGhlYXJ0YmVhdCBTVUJKRUNUIChgLi9oZWFydGJlYXQudHNgKSDCt1xuICogZGlzY292ZXJ5IFNVQkpFQ1QgKHNlc3Npb24tSlNPTiwgRTEzOiBgc2NyaXB0b3JpdW0tPGlkPi5qc29uYCArXG4gKiBgc2NyaXB0b3JpdW0tbGF0ZXN0Lmpzb25gIGluIHRtcGRpciB2aWEgYHdyaXRlRmlsZUF0b21pY2AvYHVubGlua0lmTWF0Y2hlc2ApIMK3XG4gKiBldmVudExvZyBTVUJKRUNULCBXSVRIIEVQT0NIIChRNikgwrcgc3NlIFNVQkpFQ1QgKGBHRVQgL2V2ZW50c2ApIMK3XG4gKiBsaWIvcHJpbnRKc29uIFNVQkpFQ1QgKHRoZSBDTEkgc3BlYWtzIHRoZSBhZ2VudCB3aXJlKS5cbiAqXG4gKiDilIDilIAgVEVBUkRPV04gT1JERVIgKHJlZ2lzdGVyIEE2KSwgU1RBVEVEIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGdsYW1vdXIncyBvcmRlcjogc3RvcCBob3VzZWtlZXBpbmcg4oaSIGNsb3NlIHRoZSB3YXRjaGVycyDihpIgcGVyc2lzdCB0aGVcbiAqIG1hbmlmZXN0IOKGkiB1bmxpbmsgZGlzY292ZXJ5IOKGkiBlbWl0IGBjbG9zZWRgIOKGkiBkcmFpbi4gRGlzY292ZXJ5IGdvZXMgQkVGT1JFIHRoZVxuICogYGNsb3NlZGAgZnJhbWUgc28gYSB0YWlsIHRoYXQgc2VlcyBgY2xvc2VkYCBhbmQgYSBDTEkgdmVyYiB0aGF0IHJ1bnMgcmlnaHRcbiAqIGFmdGVyIGl0IGJvdGggZmluZCBubyBwb2ludGVyIHRvIGEgZGFlbW9uIHRoYXQgaXMgbGVhdmluZzsgdGhlIG90aGVyIG9yZGVyXG4gKiBsZWF2ZXMgYSB3aW5kb3cgaW4gd2hpY2ggYSB2ZXJiIHJlc29sdmVzIGEgc2Vzc2lvbiB0aGF0IHdpbGwgcmVmdXNlIGl0LlxuICovXG5cbmltcG9ydCB7IHR5cGUgRlNXYXRjaGVyLCByZWFkRmlsZVN5bmMsIHN0YXRTeW5jLCB1bmxpbmtTeW5jLCB3YXRjaCB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyLCB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGlzQWJzb2x1dGUsIGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgYXMgbm9kZVBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IHVubGlua0lmTWF0Y2hlcywgd3JpdGVGaWxlQXRvbWljIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Rpc2NvdmVyeS50c1wiO1xuaW1wb3J0IHsgY3JlYXRlRXZlbnRMb2cgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZXZlbnRMb2cudHNcIjtcbmltcG9ydCB7IGRyYWluQW5kU3RvcCwgc3RhcnRIb3VzZWtlZXBpbmcgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaG91c2VrZWVwaW5nLnRzXCI7XG5pbXBvcnQgeyByZXNvbHZlTW9kZSBhcyByZXNvbHZlTW9kZUluLCBzZXJ2ZUZyb21EaXN0IH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3NlcnZlRGlzdC50c1wiO1xuaW1wb3J0IHsgdHlwZSBTc2VDbGllbnRzLCBzc2VSZXNwb25zZSB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9zc2UudHNcIjtcbmltcG9ydCB7IHVuaWZpZWQgfSBmcm9tIFwiLi9kaWZmXCI7XG5pbXBvcnQgeyBJRExFX1RJTUVPVVRfU0VDLCBTU0VfSEVBUlRCRUFUX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0XCI7XG5pbXBvcnQgeyB0eXBlIFBpY2tLaW5kLCBwYXJzZVBpY2tlck91dHB1dCwgcGlja2VyQ29tbWFuZCwgd2FzQ2FuY2VsbGVkIH0gZnJvbSBcIi4vcGlja2VyXCI7XG5pbXBvcnQgdHlwZSB7IEFnZW50Q21kLCBDbGllbnRNc2csIFNlbGVjdGlvbiwgU2VydmVyTXNnLCBTdHJ1Y3R1cmVPcCB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5pbXBvcnQgeyB0eXBlIEZpbGVFdmVudCwgU2Vzc2lvbiwgU2Vzc2lvbkVycm9yLCBzaWRlTmFtZSB9IGZyb20gXCIuL3Nlc3Npb25cIjtcbmltcG9ydCB7IGxpc3REaXIsIFBhdGhFcnJvciB9IGZyb20gXCIuL3RyZWVcIjtcblxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuXG4vKiogcmVsZWFzZSBpZmYgYGRpc3QvaW5kZXguaHRtbGAgZXhpc3RzIGF0IHRoZSBza2lsbCByb290OyB0aGUgZW52IHZhciBvdmVycmlkZXMgKENvbnRyYWN0IDEpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKCk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIHJldHVybiByZXNvbHZlTW9kZUluKERJU1RfRElSKTtcbn1cblxuZnVuY3Rpb24gc2VydmVEaXN0KHBhdGg6IHN0cmluZyk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIHJldHVybiBzZXJ2ZUZyb21EaXN0KERJU1RfRElSLCBwYXRoID09PSBcIi9cIiA/IFwiaW5kZXguaHRtbFwiIDogcGF0aC5zbGljZSgxKSk7XG59XG5cbi8qKiBgJFNDUklQVE9SSVVNX0hPTUVgLCBkZWZhdWx0IGB+Ly5zY3JpcHRvcml1bWAuIGBwcm9tcHRzLmpzb25gIGJlc2lkZSBgc2Vzc2lvbnMvYCBpcyBzbGljZSBCJ3MgKEU5KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY3JpcHRvcml1bUhvbWUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlc29sdmUocHJvY2Vzcy5lbnYuU0NSSVBUT1JJVU1fSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuc2NyaXB0b3JpdW1cIikpO1xufVxuXG5leHBvcnQgdHlwZSBTdGFydE9wdHMgPSB7XG4gIHBvcnQ/OiBudW1iZXI7XG4gIHJlc3RvcmU/OiBzdHJpbmc7XG4gIHRpbWVvdXRTPzogbnVtYmVyO1xuICAvKiogRTIzOiBhIE5FVyBzZXNzaW9uJ3Mgd29ya3NwYWNlIOKAlCB0aGUgZGlyZWN0b3J5IGBvcGVuYCByYW4gaW4uIEEgcmVzdG9yZSBrZWVwcyBpdHMgb3duLiAqL1xuICB3b3Jrc3BhY2U/OiBzdHJpbmc7XG59O1xuXG4vKiogQSB0YWlsIGZyYW1lJ3MgcGF5bG9hZC4gVGhlIGxvZyBzdGFtcHMgYGlkYCBhbmQgYGVwb2NoYC4gKi9cbnR5cGUgTG9nRXZlbnQgPSBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiAmIHsgdHlwZTogc3RyaW5nIH07XG5cbi8qKiBIb3cgbG9uZyBhIGJ1cnN0IG9mIHdhdGNoZXIgZXZlbnRzIG9uIG9uZSBwYXRoIHNldHRsZXMgYmVmb3JlIGl0IGlzIHJlYWQuICovXG5jb25zdCBXQVRDSF9TRVRUTEVfTVMgPSA2MDtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0RGFlbW9uKG9wdHM6IFN0YXJ0T3B0cykge1xuICBjb25zdCBob21lID0gc2NyaXB0b3JpdW1Ib21lKCk7XG4gIC8vIE1vZGUgQkVGT1JFIGFueSB3cml0ZTogYSBmb3JjZWQtZGV2IGJvb3QgYXQgYSBzdXJmYWNlLWZyZWUgZGVzdGluYXRpb24gbXVzdFxuICAvLyBkaWUgYXQgdGhlIGltcG9ydCBoYXZpbmcgY3JlYXRlZCBub3RoaW5nIChnbGFtb3VyJ3MgbWVhc3VyZWQgb3JkZXIpLlxuICBjb25zdCBtb2RlID0gcmVzb2x2ZU1vZGUoKTtcbiAgY29uc3QgZGV2SW5kZXggPVxuICAgIG1vZGUgPT09IFwiZGV2XCJcbiAgICAgID8gKGF3YWl0IGltcG9ydChcIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9zdXJmYWNlL2luZGV4Lmh0bWxcIikpLmRlZmF1bHRcbiAgICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCByb3V0ZXMgPSAoZGV2SW5kZXggPyB7IFwiL1wiOiBkZXZJbmRleCB9IDoge30pIGFzIFJlY29yZDxzdHJpbmcsIG5ldmVyPjtcblxuICBjb25zdCBzZXNzaW9uID0gb3B0cy5yZXN0b3JlXG4gICAgPyBTZXNzaW9uLnJlc3RvcmUoaG9tZSwgb3B0cy5yZXN0b3JlKVxuICAgIDogU2Vzc2lvbi5jcmVhdGUoaG9tZSwgdW5kZWZpbmVkLCBvcHRzLndvcmtzcGFjZSk7XG4gIGNvbnN0IHNlc3Npb25JZCA9IHNlc3Npb24uaWQ7XG4gIGxldCBzZWxlY3Rpb246IFNlbGVjdGlvbiB8IG51bGwgPSBudWxsO1xuXG4gIC8vIC0tLSBwcmVmczogcGVyLXZpZXdlciBjb252ZW5pZW5jZXMgdGhhdCBvdXRsaXZlIGEgc2Vzc2lvbidzIHBvcnQgLS0tLS0tLS0tLS0tXG4gIC8vIEJyb3dzZXIgc3RvcmFnZSBpcyBrZXllZCBieSBvcmlnaW4sIHBvcnQgaW5jbHVkZWQsIGFuZCBldmVyeSBzZXNzaW9uIGdldHMgYVxuICAvLyBuZXcgcG9ydCDigJQgc28gYSBwYW5lIHNpemUga2VwdCBpbiBsb2NhbFN0b3JhZ2UgcmVzZXRzIGF0IHRoZSBuZXh0IGBvcGVuYC5cbiAgLy8gVGhleSBsaXZlIGluIHRoZSBob21lIGluc3RlYWQsIHNoYXJlZCBieSBldmVyeSBzZXNzaW9uIG9mIHRoaXMgaG9tZS5cbiAgY29uc3QgcHJlZnNGaWxlID0gam9pbihob21lLCBcInByZWZzLmpzb25cIik7XG4gIGNvbnN0IFBSRUZfS0VZID0gL15bYS16XVthLXowLTk6Ll8tXXswLDYzfSQvO1xuICBjb25zdCBQUkVGX1ZBTFVFX01BWCA9IDQwOTY7XG4gIGNvbnN0IFBSRUZfS0VZU19NQVggPSA2NDtcbiAgLyoqXG4gICAqIFJlYWQgdGhlIGhvbWUncyBwcmVmcyBGUkVTSC4gU2V2ZXJhbCBzZXNzaW9ucyBjYW4gc2hhcmUgb25lIGhvbWUgKEUxMyksIGVhY2hcbiAgICogaXRzIG93biBkYWVtb24sIHNvIGEgY29weSBsb2FkZWQgb25jZSBhdCBib290IGFuZCB3cml0dGVuIGJhY2sgd2hvbGUgd291bGRcbiAgICogZXJhc2UgYSBrZXkgYW5vdGhlciBzZXNzaW9uIHdyb3RlIHNpbmNlICh2ZXJpZnkgcGFzcykuIEV2ZXJ5IHdyaXRlIGlzXG4gICAqIHRoZXJlZm9yZSByZWFkIOKGkiBzZXQgb25lIGtleSDihpIgd3JpdGUsIGFuZCBldmVyeSBzbmFwc2hvdCByZWFkcyB0aGUgZmlsZS5cbiAgICogT25seSB3ZWxsLWZvcm1lZCBlbnRyaWVzIHN1cnZpdmUgYSByZWFkOyBhIGJhZCBmaWxlIHJlYWRzIGFzIGVtcHR5IGFuZCBpc1xuICAgKiByZXBsYWNlZCBieSB0aGUgbmV4dCB3cml0ZS5cbiAgICovXG4gIGNvbnN0IHJlYWRQcmVmcyA9ICgpOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0+IHtcbiAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmF3ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocHJlZnNGaWxlLCBcInV0ZjhcIikpIGFzIHVua25vd247XG4gICAgICBpZiAocmF3ICYmIHR5cGVvZiByYXcgPT09IFwib2JqZWN0XCIgJiYgIUFycmF5LmlzQXJyYXkocmF3KSkge1xuICAgICAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhyYXcpKVxuICAgICAgICAgIGlmIChQUkVGX0tFWS50ZXN0KGspICYmIHR5cGVvZiB2ID09PSBcInN0cmluZ1wiICYmIHYubGVuZ3RoIDw9IFBSRUZfVkFMVUVfTUFYKSBvdXRba10gPSB2O1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLyogbm8gcHJlZnMgeWV0LCBvciB1bnJlYWRhYmxlIOKAlCBlbXB0eSAqL1xuICAgIH1cbiAgICByZXR1cm4gb3V0O1xuICB9O1xuICBjb25zdCB1c2VySG9tZSA9IGhvbWVkaXIoKTtcbiAgY29uc3Qgdmlld1N0YXRlID0gKCkgPT4gKHsgLi4uc2Vzc2lvbi52aWV3KG1vZGUsIHNlbGVjdGlvbiksIHByZWZzOiByZWFkUHJlZnMoKSwgdXNlckhvbWUgfSk7XG5cbiAgLy8gLS0tIGNoYW5uZWxzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzb2NrZXRzID0gbmV3IFNldDxpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+PigpO1xuICBjb25zdCBsb2cgPSBjcmVhdGVFdmVudExvZzxMb2dFdmVudD4oeyBlcG9jaDogY3J5cHRvLnJhbmRvbVVVSUQoKSB9KTtcbiAgY29uc3Qgc3NlQ2xpZW50czogU3NlQ2xpZW50cyA9IG5ldyBTZXQoKTtcbiAgbGV0IGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICBjb25zdCB0b3VjaCA9ICgpID0+IHtcbiAgICBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgfTtcblxuICBjb25zdCBzZW5kID0gKG1zZzogU2VydmVyTXNnKSA9PiB7XG4gICAgY29uc3QgcyA9IEpTT04uc3RyaW5naWZ5KG1zZyk7XG4gICAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzKSB7XG4gICAgICB0cnkge1xuICAgICAgICB3cy5zZW5kKHMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHNvY2tldCBjbG9zZWQgKi9cbiAgICAgIH1cbiAgICB9XG4gIH07XG4gIGNvbnN0IGJyb2FkY2FzdFN0YXRlID0gKCkgPT4gc2VuZCh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGU6IHZpZXdTdGF0ZSgpIH0pO1xuXG4gIC8qKiBBIHN5c3RlbSBsaW5lIGluIHRoZSBjaGF0IOKAlCBhbmQsIGJlY2F1c2UgdGhlIGFnZW50IG11c3Qga25vdyBpdCB0b28sIG9uIHRoZSB0YWlsLiAqL1xuICBjb25zdCBhbm5vdW5jZSA9ICh0ZXh0OiBzdHJpbmcsIGZhY3Q6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge30pID0+IHtcbiAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwic3lzdGVtXCIsIHRleHQpO1xuICAgIGxvZy5lbWl0KHsgdHlwZTogXCJzeXN0ZW1cIiwgdGV4dCwgdHM6IG0udHMsIC4uLmZhY3QgfSk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgfTtcblxuICAvLyAtLS0gdGhlIHdhdGNoZXIgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy9cbiAgLy8g4pqgIERFVklBVElPTiBGUk9NIFRIRSBCUklFRiwgV0lUSCBJVFMgUkVBU09OOiBgbm9kZTpmc2AgYHdhdGNoYCAoQnVuJ3NcbiAgLy8gYnVpbHQtaW4pLCBOT1QgYEBwYXJjZWwvd2F0Y2hlcmAuIGBAcGFyY2VsL3dhdGNoZXJgIGlzIGEgbmF0aXZlIGFkZG9uIHdob3NlXG4gIC8vIGxvYWRlciBkb2VzIGEgcnVudGltZSBgcmVxdWlyZSgpYCBvZiBhIHBlci1wbGF0Zm9ybSBwYWNrYWdlOyBidW5kbGVkIGludG9cbiAgLy8gYGRpc3Qvc2VydmVyLmpzYCBpdCBpcyBub3QgaW5saW5lZCwgc28gdGhlIHNoaXBwZWQgZGFlbW9uIHdvdWxkIG5lZWQgYVxuICAvLyBgbm9kZV9tb2R1bGVzYCB0aGUgbWFya2V0cGxhY2UgbmV2ZXIgY29waWVzIChpbXBvcnQtYm91bmRhcnkgd2FyZCAxYidzXG4gIC8vIFwidGhlIHNoaXBwZWQgZXhlY3V0aW9uIHBhdGggY2FycmllcyBubyBkZXBlbmRlbmNpZXNcIikuIE1lYXN1cmVkIHVuZGVyIEJ1blxuICAvLyAxLjQuMCBvbiBtYWNPUyBiZWZvcmUgY2hvb3Npbmc6IGEgcmVjdXJzaXZlIGRpcmVjdG9yeSB3YXRjaCByZXBvcnRzIGFuXG4gIC8vIGluLXBsYWNlIHdyaXRlLCBhbiBhdG9taWMgdG1wK3JlbmFtZSBzYXZlLCBhbmQgYm90aCBhZ2FpbiBpbiBhXG4gIC8vIHN1YmRpcmVjdG9yeSDigJQgdGhlIGZvdXIgY2FzZXMgaW52ZXN0aWdhdGlvbiDCpzUgZHJvdmUgQHBhcmNlbC93YXRjaGVyIG9uLlxuICAvLyBUaGUgaGFzaC1jb21wYXJlIGFuZCBzZWxmLXdyaXRlIHN1cHByZXNzaW9uIGFyZSB1bmNoYW5nZWQgKHNlc3Npb24udHMpLlxuICBjb25zdCB3YXRjaGVycyA9IG5ldyBNYXA8c3RyaW5nLCBGU1dhdGNoZXI+KCk7XG4gIGNvbnN0IHBlbmRpbmcgPSBuZXcgTWFwPHN0cmluZywgUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4+KCk7XG4gIGNvbnN0IG9uRnMgPSAoYWJzOiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCB0ID0gcGVuZGluZy5nZXQoYWJzKTtcbiAgICBpZiAodCkgY2xlYXJUaW1lb3V0KHQpO1xuICAgIHBlbmRpbmcuc2V0KFxuICAgICAgYWJzLFxuICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHBlbmRpbmcuZGVsZXRlKGFicyk7XG4gICAgICAgIGxldCBldjogRmlsZUV2ZW50IHwgbnVsbCA9IG51bGw7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgZXYgPSBzZXNzaW9uLm9uRmlsZUV2ZW50KGFicyk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgc2NyaXB0b3JpdW06IHdhdGNoZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZXYpIGhhbmRsZUZpbGVFdmVudChldik7XG4gICAgICB9LCBXQVRDSF9TRVRUTEVfTVMpLFxuICAgICk7XG4gIH07XG4gIGNvbnN0IHN5bmNXYXRjaGVycyA9ICgpID0+IHtcbiAgICBjb25zdCB3YW50ID0gbmV3IE1hcChcbiAgICAgIHNlc3Npb24ud2F0Y2hSb290cygpLm1hcCgocikgPT4gW2Ake3IucmVjdXJzaXZlID8gXCJSXCIgOiBcIkZcIn06JHtyLndhdGNofT4ke3IucGF0aH1gLCByXSksXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIHddIG9mIHdhdGNoZXJzKVxuICAgICAgaWYgKCF3YW50LmhhcyhrZXkpKSB7XG4gICAgICAgIHcuY2xvc2UoKTtcbiAgICAgICAgd2F0Y2hlcnMuZGVsZXRlKGtleSk7XG4gICAgICB9XG4gICAgZm9yIChjb25zdCBba2V5LCByXSBvZiB3YW50KSB7XG4gICAgICBpZiAod2F0Y2hlcnMuaGFzKGtleSkpIGNvbnRpbnVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgLy8gV2F0Y2hlZCBhdCB0aGUgUkVBTFBBVEgsIHJlcG9ydGVkIHVuZGVyIHRoZSBzdG9yZWQgcGF0aCBmb3JtXG4gICAgICAgIC8vICh2ZXJpZnktcGFzcyBmaXggMyDigJQgc2VlIFNlc3Npb24ud2F0Y2hSb290cykuXG4gICAgICAgIGNvbnN0IHcgPSB3YXRjaChyLndhdGNoLCB7IHJlY3Vyc2l2ZTogci5yZWN1cnNpdmUgfSwgKF9ldmVudCwgbmFtZSkgPT4ge1xuICAgICAgICAgIGlmIChuYW1lKSBvbkZzKGpvaW4oci5wYXRoLCBuYW1lLnRvU3RyaW5nKCkpKTtcbiAgICAgICAgICBlbHNlIGlmIChyLmVudHJ5SWQpIG9uRnMoci5wYXRoKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHcub24oXCJlcnJvclwiLCAoKSA9PiB7XG4gICAgICAgICAgLyogdGhlIGRpcmVjdG9yeSB3ZW50IGF3YXk7IHRoZSBuZXh0IHN5bmMgZHJvcHMgaXQgKi9cbiAgICAgICAgfSk7XG4gICAgICAgIHdhdGNoZXJzLnNldChrZXksIHcpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHVud2F0Y2hhYmxlIChnb25lLCBwZXJtaXNzaW9ucykg4oCUIG91dHNpZGUgY2hhbmdlcyB0aGVyZSBnbyB1bnNlZW4gKi9cbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgY29uc3QgaGFuZGxlRmlsZUV2ZW50ID0gKGV2OiBGaWxlRXZlbnQpID0+IHtcbiAgICBzd2l0Y2ggKGV2LmtpbmQpIHtcbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLmNoYW5nZWRcIjpcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IGV2LnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInZlcnNpb24uY3JlYXRlZFwiOlxuICAgICAgICBhbm5vdW5jZShgdiR7ZXYudmVyc2lvbn0gb2YgJHtldi5kb2N9IGFwcGVhcmVkICh3cml0dGVuIGRpcmVjdGx5IHRvICR7ZXYucGF0aH0pYCwge1xuICAgICAgICAgIGZhY3Q6IFwidmVyc2lvbi5jcmVhdGVkXCIsXG4gICAgICAgICAgZG9jOiBldi5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogZXYudmVyc2lvbixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJhY3RpdmUub3V0c2lkZVwiOlxuICAgICAgICAvLyBFMjogdGhlIGFnZW50IG5ldmVyIHdyaXRlcyB0aGUgdmVyc2lvbiB0aGUgaHVtYW4gaXMgZWRpdGluZy4gVGhlXG4gICAgICAgIC8vIG91dHNpZGUgdGV4dCBpcyBLRVBUIGFzIGEgbmV3IGFnZW50IHZlcnNpb24gYW5kIHRoZSBhY3RpdmUgdmVyc2lvblxuICAgICAgICAvLyBrZWVwcyB0aGUgaHVtYW4ncyB0ZXh0IOKAlCBub3RoaW5nIGlzIGxvc3QsIGFuZCB0aGUgaHVtYW4ncyBidWZmZXIgaXNcbiAgICAgICAgLy8gbm90IHRvdWNoZWQgKHZlcmlmeS1wYXNzIGZpeCA0KS5cbiAgICAgICAgYW5ub3VuY2VPdXRzaWRlKGV2LmRvYywgZXYudmVyc2lvbiwgZXYucGF0aCwgZXYucHJlc2VydmVkQXMsIGV2LnByZXNlcnZlZFBhdGgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwib3JpZ2luYWwucmVsb2FkZWRcIjpcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IGV2LnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoYCR7ZXYub3JpZ2luYWx9IGNoYW5nZWQgb24gZGlzayDigJQgcmVsb2FkZWQgKHlvdSBoYWQgbm8gdW5zYXZlZCBlZGl0cykuYCwge1xuICAgICAgICAgIGZhY3Q6IFwib3JpZ2luYWwucmVsb2FkZWRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJvcmlnaW5hbC5jb25mbGljdFwiOlxuICAgICAgICBhbm5vdW5jZShcbiAgICAgICAgICBgJHtldi5vcmlnaW5hbH0gY2hhbmdlZCBvbiBkaXNrIHdoaWxlIHlvdSBoYXZlIHVuc2F2ZWQgZWRpdHMuIFNhdmUgb3ZlcndyaXRlcyBpdCB3aXRoIHlvdXJzOyBSZXZlcnQgdGFrZXMgdGhlIGZpbGUncyB2ZXJzaW9uLmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm9yaWdpbmFsLmNvbmZsaWN0XCIsIGRvYzogZXYuZG9jIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJ0cmVlXCI6XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgYW5ub3VuY2VPdXRzaWRlID0gKFxuICAgIGRvYzogc3RyaW5nLFxuICAgIHZlcnNpb246IG51bWJlcixcbiAgICBwYXRoOiBzdHJpbmcsXG4gICAgcHJlc2VydmVkQXM6IG51bWJlcixcbiAgICBwcmVzZXJ2ZWRQYXRoOiBzdHJpbmcsXG4gICkgPT5cbiAgICBhbm5vdW5jZShcbiAgICAgIGB2JHt2ZXJzaW9ufSBvZiAke2RvY30gaXMgdGhlIEFDVElWRSB2ZXJzaW9uIGFuZCB3YXMgd3JpdHRlbiBmcm9tIG91dHNpZGUgdGhlIGVkaXRvci4gVGhhdCB0ZXh0IGlzIGtlcHQgYXMgdiR7cHJlc2VydmVkQXN9OyB0aGUgYWN0aXZlIHZlcnNpb24ga2VlcHMgeW91ciB0ZXh0LiBBZ2VudCBlZGl0cyBiZWxvbmcgaW4gYSBuZXcgdmVyc2lvbiAodmVyc2lvbi1uZXcpLmAsXG4gICAgICB7IGZhY3Q6IFwiYWN0aXZlLm91dHNpZGVcIiwgZG9jLCB2ZXJzaW9uLCBwYXRoLCBwcmVzZXJ2ZWRBcywgcHJlc2VydmVkUGF0aCB9LFxuICAgICk7XG5cbiAgLy8gLS0tIHNoYXJlZCBhY3RzIChzdXJmYWNlIGFuZCBhZ2VudCByZWFjaCB0aGUgc2FtZSBjb2RlKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgYWRkUGF0aHMgPSAocGF0aHM6IHN0cmluZ1tdKSA9PiB7XG4gICAgY29uc3QgYWRkZWQgPSBwYXRocy5tYXAoKHApID0+IHNlc3Npb24uYWRkQ29udGV4dChwKSk7XG4gICAgc3luY1dhdGNoZXJzKCk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4gYWRkZWQ7XG4gIH07XG5cbiAgY29uc3QgYWN0aXZhdGUgPSAoZG9jOiBzdHJpbmcgfCB1bmRlZmluZWQsIHZlcnNpb246IG51bWJlciwgYnk6IFwiaHVtYW5cIiB8IFwiYWdlbnRcIikgPT4ge1xuICAgIGNvbnN0IHIgPSBzZXNzaW9uLmFjdGl2YXRlKHsgZG9jLCB2ZXJzaW9uIH0pO1xuICAgIGNvbnN0IHZpZXcgPSBzZXNzaW9uLmRvYyhyLnNsdWcpO1xuICAgIGNvbnN0IHBhdGggPSB2aWV3LnZlcnNpb25zLmZpbmQoKHYpID0+IHYubiA9PT0gdmVyc2lvbik/LnBhdGggPz8gbnVsbDtcbiAgICBzZW5kKHtcbiAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgIHZlcnNpb24sXG4gICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKHIuc2x1ZywgdmVyc2lvbikudGV4dCxcbiAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgfSk7XG4gICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgIFwic3lzdGVtXCIsXG4gICAgICBgJHtieSA9PT0gXCJhZ2VudFwiID8gXCJBZ2VudFwiIDogXCJZb3VcIn0gbWFkZSB2JHt2ZXJzaW9ufSBvZiAke3Iuc2x1Z30gYWN0aXZlICh3YXMgdiR7ci5wcmV2aW91c30pLmAsXG4gICAgKTtcbiAgICBsb2cuZW1pdCh7IHR5cGU6IFwiYWN0aXZhdGVkXCIsIGJ5LCBkb2M6IHIuc2x1ZywgdmVyc2lvbiwgcHJldmlvdXM6IHIucHJldmlvdXMsIHBhdGgsIHRzOiBtLnRzIH0pO1xuICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIHZlcnNpb24sIHByZXZpb3VzOiByLnByZXZpb3VzLCBwYXRoIH07XG4gIH07XG5cbiAgLyoqXG4gICAqIEUyNDogb25lIHN0cnVjdHVyZSBjaGFuZ2UsIGZyb20gZWl0aGVyIHBhcnR5IOKAlCB0aGUgc2FtZSBzZXNzaW9uIG1ldGhvZCwgdGhlXG4gICAqIHNhbWUgYW5ub3VuY2VtZW50IChuYW1pbmcgd2hvIGRpZCBpdCksIHRoZSBzYW1lIHRhaWwgZmFjdC4gUmV0dXJucyB0aGUgcGF0aFxuICAgKiB0aGUgY2hhbmdlIGxhbmRlZCBhdCwgd2hpY2ggdGhlIHN1cmZhY2UgdXNlcyB0byBvcGVuIG9yIHJlbmFtZSBpdC5cbiAgICovXG4gIGNvbnN0IFNUUlVDVFVSRV9PUFMgPSBuZXcgU2V0PHN0cmluZz4oW1xuICAgIFwiZG9jLmNyZWF0ZVwiLFxuICAgIFwiZm9sZGVyLmNyZWF0ZVwiLFxuICAgIFwibW92ZVwiLFxuICAgIFwicmVuYW1lXCIsXG4gICAgXCJoaWRlXCIsXG4gICAgXCJ1bmhpZGVcIixcbiAgICBcInNldC5tYWtlXCIsXG4gICAgXCJpbXBvcnRcIixcbiAgICBcIndvcmtzcGFjZS5zZXRcIixcbiAgXSBzYXRpc2ZpZXMgU3RydWN0dXJlT3BbXCJ0eXBlXCJdW10pO1xuICBjb25zdCBpc1N0cnVjdHVyZU9wID0gKG06IHsgdHlwZTogc3RyaW5nIH0pOiBtIGlzIFN0cnVjdHVyZU9wID0+IFNUUlVDVFVSRV9PUFMuaGFzKG0udHlwZSk7XG5cbiAgY29uc3Qgc3RydWN0dXJlID0gKG9wOiBTdHJ1Y3R1cmVPcCwgYnk6IFwiaHVtYW5cIiB8IFwiYWdlbnRcIik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+IHtcbiAgICBjb25zdCB3aG8gPSBieSA9PT0gXCJhZ2VudFwiID8gXCJBZ2VudFwiIDogXCJZb3VcIjtcbiAgICBjb25zdCBzaG93biA9IChwOiBzdHJpbmcpID0+IHNlc3Npb24uZGlzcGxheShwKTtcbiAgICBsZXQgcjogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gJiB7IHBhdGg/OiBzdHJpbmcgfTtcbiAgICBsZXQgbGluZTogc3RyaW5nO1xuICAgIHN3aXRjaCAob3AudHlwZSkge1xuICAgICAgY2FzZSBcImRvYy5jcmVhdGVcIjpcbiAgICAgICAgciA9IHNlc3Npb24uY3JlYXRlRG9jKG9wLmRpciwgb3AubmFtZSk7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IGNyZWF0ZWQgJHtzaG93bihyLnBhdGggYXMgc3RyaW5nKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiZm9sZGVyLmNyZWF0ZVwiOlxuICAgICAgICByID0gc2Vzc2lvbi5jcmVhdGVGb2xkZXIob3AuZGlyLCBvcC5uYW1lKTtcbiAgICAgICAgbGluZSA9IGAke3dob30gY3JlYXRlZCB0aGUgZm9sZGVyICR7c2hvd24oci5wYXRoIGFzIHN0cmluZyl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIm1vdmVcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5tb3ZlKG9wLnBhdGgsIG9wLmludG8pO1xuICAgICAgICByID0gbTtcbiAgICAgICAgbGluZSA9IGAke3dob30gbW92ZWQgJHtzaG93bihtLmZyb20pfSB0byAke3Nob3duKG0ucGF0aCl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInJlbmFtZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLnJlbmFtZShvcC5wYXRoLCBvcC5uYW1lKTtcbiAgICAgICAgciA9IG07XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IHJlbmFtZWQgJHtzaG93bihtLmZyb20pfSB0byAke3Nob3duKG0ucGF0aCl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImhpZGVcIjoge1xuICAgICAgICBjb25zdCBoID0gc2Vzc2lvbi5oaWRlKG9wLnBhdGgpO1xuICAgICAgICByID0gaDtcbiAgICAgICAgbGluZSA9IGAke3dob30gcmVtb3ZlZCAke3Nob3duKGgucGF0aCl9IGZyb20gU2NyaXB0b3JpdW0gKHRoZSBmaWxlIGlzIHN0aWxsIG9uIGRpc2spLmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInVuaGlkZVwiOiB7XG4gICAgICAgIGNvbnN0IHUgPSBzZXNzaW9uLnVuaGlkZShvcC5lbnRyeSk7XG4gICAgICAgIHIgPSB1O1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBicm91Z2h0IGJhY2sgJHt1LnJlc3RvcmVkfSBoaWRkZW4gaXRlbSR7dS5yZXN0b3JlZCA9PT0gMSA/IFwiXCIgOiBcInNcIn0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwic2V0Lm1ha2VcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5tYWtlU2V0KG9wLnBhdGgpO1xuICAgICAgICByID0gbTtcbiAgICAgICAgbGluZSA9IGAke3dob30gdHVybmVkICR7YmFzZW5hbWUobS5wYXRoKX0gaW50byBhIHNldDogJHtzaG93bihtLmZvbGRlcil9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImltcG9ydFwiOlxuICAgICAgICByID0gc2Vzc2lvbi5pbXBvcnRUZXh0KG9wLm5hbWUsIG9wLnRleHQsIG9wLmludG8pO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBjb3BpZWQgJHtvcC5uYW1lfSBpbiBhcyAke3Nob3duKHIucGF0aCBhcyBzdHJpbmcpfS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ3b3Jrc3BhY2Uuc2V0XCI6XG4gICAgICAgIHIgPSBzZXNzaW9uLnNldFdvcmtzcGFjZShvcC5wYXRoKTtcbiAgICAgICAgbGluZSA9IGAke3dob30gc2V0IHRoZSB3b3Jrc3BhY2UgdG8gJHtzaG93bihyLnBhdGggYXMgc3RyaW5nKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgfVxuICAgIHN5bmNXYXRjaGVycygpO1xuICAgIGFubm91bmNlKGxpbmUsIHsgZmFjdDogb3AudHlwZSwgYnksIC4uLnIgfSk7XG4gICAgcmV0dXJuIHI7XG4gIH07XG5cbiAgLy8gLS0tIHN1cmZhY2UgbWVzc2FnZXMgKFdlYlNvY2tldCkgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgcmVwbHkgPSAod3M6IGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4sIG1zZzogU2VydmVyTXNnKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkobXNnKSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBnb25lICovXG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGhhbmRsZUNsaWVudE1zZyA9ICh3czogaW1wb3J0KFwiYnVuXCIpLlNlcnZlcldlYlNvY2tldDx1bmtub3duPiwgbXNnOiBDbGllbnRNc2cpID0+IHtcbiAgICBpZiAoaXNTdHJ1Y3R1cmVPcChtc2cpKSB7XG4gICAgICBjb25zdCByID0gc3RydWN0dXJlKGFuY2hvclN1cmZhY2VQYXRocyhtc2cpLCBcImh1bWFuXCIpO1xuICAgICAgaWYgKHR5cGVvZiByLnBhdGggPT09IFwic3RyaW5nXCIpXG4gICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwic3RydWN0dXJlLmRvbmVcIiwgb3A6IG1zZy50eXBlLCBwYXRoOiByLnBhdGggfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHN3aXRjaCAobXNnLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJvcGVuXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ub3BlblBhdGgobXNnLnBhdGgpO1xuICAgICAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgLy8gVGhlIG9wZW5lciBnZXRzIHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgc3RyYWlnaHQgYXdheSDigJQgdGhlIHN0YXRlXG4gICAgICAgIC8vIHNuYXBzaG90IGNhcnJpZXMgbm8gdGV4dHMsIGFuZCBhIHZpZXdlciBtdXN0IG5vdCB3YWl0IG9uIGEgc2Vjb25kIGFzay5cbiAgICAgICAge1xuICAgICAgICAgIGNvbnN0IGQgPSBzZXNzaW9uLmRvYyhyLnNsdWcpO1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgICAgICAgIHRleHQ6IHNlc3Npb24ucmVhZFZlcnNpb24oci5zbHVnLCBkLmFjdGl2ZSkudGV4dCxcbiAgICAgICAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHIuY3JlYXRlZClcbiAgICAgICAgICBsb2cuZW1pdCh7IHR5cGU6IFwiZG9jLm9wZW5lZFwiLCBkb2M6IHIuc2x1ZywgcGF0aDogc2Vzc2lvbi5hY3RpdmVQYXRoKHIuc2x1ZykgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJvcGVuLmRvY1wiOlxuICAgICAgICBzZXNzaW9uLm9wZW5TbHVnKG1zZy5kb2MpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwiZWRpdFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmVkaXQobXNnLmRvYywgbXNnLnZlcnNpb24sIG1zZy50ZXh0KTtcbiAgICAgICAgaWYgKHIucHJlc2VydmVkKSB7XG4gICAgICAgICAgY29uc3QgZCA9IHNlc3Npb24uZG9jKG1zZy5kb2MpO1xuICAgICAgICAgIGFubm91bmNlT3V0c2lkZShcbiAgICAgICAgICAgIGQuc2x1ZyxcbiAgICAgICAgICAgIG1zZy52ZXJzaW9uLFxuICAgICAgICAgICAgc2Vzc2lvbi5hY3RpdmVQYXRoKGQuc2x1ZykgPz8gXCJcIixcbiAgICAgICAgICAgIHIucHJlc2VydmVkLm4sXG4gICAgICAgICAgICByLnByZXNlcnZlZC5wYXRoLFxuICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSBpZiAoci5kaXJ0eUNoYW5nZWQpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzZWxlY3RcIjpcbiAgICAgICAgLy8gQU1CSUVOVCBzdGF0ZTogc3RvcmVkIGFuZCBzaG93biwgbmV2ZXIgcHVzaGVkIG9udG8gdGhlIGFnZW50J3MgdGFpbC5cbiAgICAgICAgc2VsZWN0aW9uID0gbXNnLnNlbGVjdGlvbjtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInNheVwiOiB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBtc2cudGV4dC50cmltKCk7XG4gICAgICAgIGlmICghdGV4dCkgcmV0dXJuO1xuICAgICAgICBjb25zdCBzZWwgPSBtc2cud2l0aFNlbGVjdGlvbiA/IHNlbGVjdGlvbiA6IG51bGw7XG4gICAgICAgIGNvbnN0IGFjdGl2ZVBhdGggPSBzZWwgPyBzZXNzaW9uLmFjdGl2ZVBhdGgoc2VsLmRvYykgOiBzZXNzaW9uLmFjdGl2ZVBhdGgoKTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcImh1bWFuXCIsIHRleHQsIHsgc2VsZWN0aW9uOiBzZWwsIGFjdGl2ZVBhdGggfSk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcIm1lc3NhZ2VcIixcbiAgICAgICAgICBtZXNzYWdlX2lkOiBtLmlkLFxuICAgICAgICAgIHRleHQsXG4gICAgICAgICAgc2VsZWN0aW9uOiBzZWwsXG4gICAgICAgICAgYWN0aXZlOiBhY3RpdmVPZihzZWw/LmRvYyksXG4gICAgICAgICAgdHM6IG0udHMsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiYWN0aXZhdGVcIjpcbiAgICAgICAgYWN0aXZhdGUobXNnLmRvYywgbXNnLnZlcnNpb24sIFwiaHVtYW5cIik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLmRlbGV0ZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmRlbGV0ZVZlcnNpb24oeyBkb2M6IG1zZy5kb2MsIHZlcnNpb246IG1zZy52ZXJzaW9uIH0pO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgICAgIFwic3lzdGVtXCIsXG4gICAgICAgICAgYERlbGV0ZWQgdiR7ci52ZXJzaW9ufSBvZiAke3Iuc2x1Z30ke3IubGFiZWwgPyBgIOKAlCAke3IubGFiZWx9YCA6IFwiXCJ9LmAsXG4gICAgICAgICk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24uZGVsZXRlZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICBieTogXCJodW1hblwiLFxuICAgICAgICAgIHRzOiBtLnRzLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInZlcnNpb24ubmV3XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubmV3VmVyc2lvbih7XG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIC4uLihtc2cuZnJvbSA9PT0gdW5kZWZpbmVkID8ge30gOiB7IGZyb206IG1zZy5mcm9tIH0pLFxuICAgICAgICAgIC4uLihtc2cubGFiZWwgPyB7IGxhYmVsOiBtc2cubGFiZWwgfSA6IHt9KSxcbiAgICAgICAgICBhdXRob3I6IFwiaHVtYW5cIixcbiAgICAgICAgfSk7XG4gICAgICAgIC8vIOKblCBTQVkgV0hFUkUgVEhFWSBBUkUsIG5vdCBqdXN0IHdoYXQgd2FzIG1hZGUgKEU0MikuIFRoZSBvbGQgbWVzc2FnZVxuICAgICAgICAvLyBhbm5vdW5jZWQgdGhlIG5ldyB2ZXJzaW9uIGFuZCB3ZW50IHF1aWV0IGFib3V0IHdoaWNoIG9uZSB0aGUgaHVtYW5cbiAgICAgICAgLy8gd2FzIGVkaXRpbmcg4oCUIHdoaWNoIGlzIGV4YWN0bHkgaG93IHNvbWVvbmUgdHlwZXMgaW50byB2MSBiZWxpZXZpbmdcbiAgICAgICAgLy8gdGhleSBhcmUgaW4gdjIuXG4gICAgICAgIGlmIChtc2cuYWN0aXZhdGUpIHNlc3Npb24uYWN0aXZhdGUoeyBkb2M6IHIuc2x1ZywgdmVyc2lvbjogci52ZXJzaW9uLm4gfSk7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXG4gICAgICAgICAgXCJzeXN0ZW1cIixcbiAgICAgICAgICBgTWFkZSB2JHtyLnZlcnNpb24ubn0gb2YgJHtyLnNsdWd9IGZyb20gdiR7ci52ZXJzaW9uLmZyb219JHttc2cubGFiZWwgPyBgIOKAlCAke21zZy5sYWJlbH1gIDogXCJcIn0uIGAgK1xuICAgICAgICAgICAgKG1zZy5hY3RpdmF0ZVxuICAgICAgICAgICAgICA/IGBZb3UgYXJlIG5vdyBlZGl0aW5nIHYke3IudmVyc2lvbi5ufS5gXG4gICAgICAgICAgICAgIDogYFlvdSBhcmUgc3RpbGwgZWRpdGluZyB2JHtyLnZlcnNpb24uZnJvbX0uYCksXG4gICAgICAgICk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24uY3JlYXRlZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbi5uLFxuICAgICAgICAgIGZyb206IHIudmVyc2lvbi5mcm9tLFxuICAgICAgICAgIGFjdGl2YXRlZDogbXNnLmFjdGl2YXRlID09PSB0cnVlLFxuICAgICAgICAgIGJ5OiBcImh1bWFuXCIsXG4gICAgICAgICAgdHM6IG0udHMsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwic2F2ZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnNhdmUobXNnLmRvYyk7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJzeXN0ZW1cIiwgYFNhdmVkIHYke3IudmVyc2lvbn0gdG8gJHtyLm9yaWdpbmFsfS5gKTtcbiAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgIHR5cGU6IFwic2F2ZWRcIixcbiAgICAgICAgICBkb2M6IG1zZy5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIG9yaWdpbmFsOiByLm9yaWdpbmFsLFxuICAgICAgICAgIHRzOiBtLnRzLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInJldmVydFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJldmVydChtc2cuZG9jKTtcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IG1zZy5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IHIudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgICAgIFwic3lzdGVtXCIsXG4gICAgICAgICAgYFJldmVydGVkIHYke3IudmVyc2lvbn0gb2YgJHttc2cuZG9jfSB0byB0aGUgc2F2ZWQgZmlsZS5gLFxuICAgICAgICApO1xuICAgICAgICBsb2cuZW1pdCh7IHR5cGU6IFwicmV2ZXJ0ZWRcIiwgZG9jOiBtc2cuZG9jLCB2ZXJzaW9uOiByLnZlcnNpb24sIHRzOiBtLnRzIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiY29udGV4dC5hZGRcIjpcbiAgICAgICAgYWRkUGF0aHMoW3N1cmZhY2VQYXRoKG1zZy5wYXRoKV0pO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwicmV2ZWFsXCI6XG4gICAgICAgIHJldmVhbFBhdGgoc2Vzc2lvbi5zaG93blBhdGgoc3VyZmFjZVBhdGgobXNnLnBhdGgpKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJyZXZlYWwudmVyc2lvblwiOlxuICAgICAgICAvLyBUaGUgZGFlbW9uIHJlc29sdmVzIGl0LCBzbyB0aGUgc3VyZmFjZSBuZXZlciBuYW1lcyBhIHBhdGggb3V0c2lkZVxuICAgICAgICAvLyB3aGF0IHRoZSBzZXNzaW9uIGFscmVhZHkgb3ducy5cbiAgICAgICAgcmV2ZWFsUGF0aChzZXNzaW9uLnJlYWRWZXJzaW9uKG1zZy5kb2MsIG1zZy52ZXJzaW9uKS5wYXRoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInBpY2tcIjoge1xuICAgICAgICB2b2lkIG9wZW5QaWNrZXIod3MsIG1zZy53YW50KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImNvbnRleHQucmVtb3ZlXCI6XG4gICAgICAgIHNlc3Npb24ucmVtb3ZlQ29udGV4dChtc2cuaWQpO1xuICAgICAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInJlYWRcIjoge1xuICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIHZlcnNpb246IG1zZy52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IHNlc3Npb24ucmVhZFZlcnNpb24obXNnLmRvYywgbXNnLnZlcnNpb24pLnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcImxvYWRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJkaWZmXCI6IHtcbiAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJkaWZmXCIsIC4uLnNlc3Npb24uY29tcGFyZSh7IGRvYzogbXNnLmRvYywgYWdhaW5zdDogbXNnLmFnYWluc3QgfSkgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJtZXJnZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm1lcmdlKHsgZG9jOiBtc2cuZG9jLCBhZ2FpbnN0OiBtc2cuYWdhaW5zdCwgaHVua3M6IG1zZy5odW5rcyB9KTtcbiAgICAgICAgLy8gVGhlIGJ1ZmZlciB0aGUgaHVtYW4gaXMgbG9va2luZyBhdCBtdXN0IGJlIHRvbGQ6IHRoZSBtZXJnZSB3cm90ZSB0aGVcbiAgICAgICAgLy8gYWN0aXZlIHZlcnNpb24ncyBGSUxFLCBhbmQgdGhlIGVkaXRvcidzIHRleHQgaXMgbm93IGJlaGluZCBpdC5cbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogci50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJyZW1vdGVcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXG4gICAgICAgICAgXCJzeXN0ZW1cIixcbiAgICAgICAgICBgVG9vayAke3IuYXBwbGllZH0gY2hhbmdlJHtyLmFwcGxpZWQgPT09IDEgPyBcIlwiIDogXCJzXCJ9IGZyb20gJHtzaWRlTmFtZShtc2cuYWdhaW5zdCwgc2Vzc2lvbi5kb2Moci5zbHVnKS5uYW1lKX0gaW50byB2JHtyLnZlcnNpb259IG9mICR7ci5zbHVnfS5gLFxuICAgICAgICApO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJtZXJnZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgYWdhaW5zdDogbXNnLmFnYWluc3QsXG4gICAgICAgICAgaHVua3M6IG1zZy5odW5rcyxcbiAgICAgICAgICBieTogXCJodW1hblwiLFxuICAgICAgICAgIHRzOiBtLnRzLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInByZWZzLnNldFwiOiB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICAhUFJFRl9LRVkudGVzdChtc2cua2V5KSB8fFxuICAgICAgICAgIHR5cGVvZiBtc2cudmFsdWUgIT09IFwic3RyaW5nXCIgfHxcbiAgICAgICAgICBtc2cudmFsdWUubGVuZ3RoID4gUFJFRl9WQUxVRV9NQVhcbiAgICAgICAgKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgcmVmdXNlZCBwcmVmICR7SlNPTi5zdHJpbmdpZnkobXNnLmtleSl9YCk7XG4gICAgICAgIGNvbnN0IGN1cnJlbnQgPSByZWFkUHJlZnMoKTtcbiAgICAgICAgaWYgKGN1cnJlbnRbbXNnLmtleV0gPT09IG1zZy52YWx1ZSkgcmV0dXJuO1xuICAgICAgICBpZiAoIShtc2cua2V5IGluIGN1cnJlbnQpICYmIE9iamVjdC5rZXlzKGN1cnJlbnQpLmxlbmd0aCA+PSBQUkVGX0tFWVNfTUFYKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGByZWZ1c2VkIHByZWYgJHtKU09OLnN0cmluZ2lmeShtc2cua2V5KX06ICR7UFJFRl9LRVlTX01BWH0ga2V5cyBhbHJlYWR5IGtlcHRgLFxuICAgICAgICAgICk7XG4gICAgICAgIHdyaXRlRmlsZUF0b21pYyhcbiAgICAgICAgICBwcmVmc0ZpbGUsXG4gICAgICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoeyAuLi5jdXJyZW50LCBbbXNnLmtleV06IG1zZy52YWx1ZSB9LCBudWxsLCAyKX1cXG5gLFxuICAgICAgICApO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiZ3JhcGhcIjoge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZ3JhcGhcIiwgZW50cnk6IG1zZy5lbnRyeSwgZ3JhcGg6IHNlc3Npb24uZ3JhcGhGb3IobXNnLmVudHJ5KSB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcImdyYXBoXCIsXG4gICAgICAgICAgICBlbnRyeTogbXNnLmVudHJ5LFxuICAgICAgICAgICAgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibGluay5vcGVuXCI6IHtcbiAgICAgICAgLy8gRTMzOiBhIGxpbmsgaW5zaWRlIHRoZSBidW5kbGUgaXMgRk9MTE9XRUQ7IG9uZSB0aGF0IGVzY2FwZXMgaXQgaXNcbiAgICAgICAgLy8gcmVwb3J0ZWQgc28gdGhlIHN1cmZhY2UgY2FuIG9mZmVyIHRvIGFkZCBpdCwgbmV2ZXIgYWRkZWQgc2lsZW50bHkuXG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlc29sdmVMaW5rKG1zZy5mcm9tLCBtc2cudGFyZ2V0KTtcbiAgICAgICAgaWYgKHIuc3RhdGUgPT09IFwiaW4tYnVuZGxlXCIpIHtcbiAgICAgICAgICBzZXNzaW9uLm9wZW5QYXRoKHIucGF0aCk7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgICBjb25zdCBkID0gc2Vzc2lvbi5kb2Moc2Vzc2lvbi5vcGVuRG9jU2x1ZyA/PyBcIlwiKTtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICAgIGRvYzogZC5zbHVnLFxuICAgICAgICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICAgICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKGQuc2x1ZywgZC5hY3RpdmUpLnRleHQsXG4gICAgICAgICAgICBvcmlnaW46IFwibG9hZFwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgdHlwZTogXCJsaW5rLnRhcmdldFwiLFxuICAgICAgICAgIHRhcmdldDogbXNnLnRhcmdldCxcbiAgICAgICAgICBzdGF0ZTogci5zdGF0ZSxcbiAgICAgICAgICAuLi4oci5zdGF0ZSA9PT0gXCJtaXNzaW5nXCIgPyB7fSA6IHsgcGF0aDogci5wYXRoIH0pLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1ldGEuc3VnZ2VzdFwiOiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgciA9IHNlc3Npb24uc3VnZ2VzdE1ldGEobXNnLnBhdGgsIFwiaHVtYW5cIik7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwibWV0YS5zdWdnZXN0aW9uXCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGJsb2NrOiByLmJsb2NrLFxuICAgICAgICAgICAgLi4uKHIudHlwZSA/IHsgc3VnZ2VzdGVkVHlwZTogci50eXBlIH0gOiB7fSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJtZXRhLnN1Z2dlc3Rpb25cIixcbiAgICAgICAgICAgIHBhdGg6IG1zZy5wYXRoLFxuICAgICAgICAgICAgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibW92ZS5wbGFuXCI6IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJtb3ZlLnBsYW5cIixcbiAgICAgICAgICAgIHBhdGg6IG1zZy5wYXRoLFxuICAgICAgICAgICAgaW50bzogbXNnLmludG8sXG4gICAgICAgICAgICBwbGFuOiBzZXNzaW9uLm1vdmVQbGFuKHN1cmZhY2VQYXRoKG1zZy5wYXRoKSwgc3VyZmFjZVBhdGgobXNnLmludG8pKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcIm1vdmUucGxhblwiLFxuICAgICAgICAgICAgcGF0aDogbXNnLnBhdGgsXG4gICAgICAgICAgICBpbnRvOiBtc2cuaW50byxcbiAgICAgICAgICAgIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImZzLmxpc3RcIjoge1xuICAgICAgICBjb25zdCBwYXRoID0gZXhwYW5kSG9tZShtc2cucGF0aCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJmcy5saXN0XCIsIHBhdGg6IG1zZy5wYXRoLCBlbnRyaWVzOiBsaXN0RGlyKHBhdGgpIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwiZnMubGlzdFwiLFxuICAgICAgICAgICAgcGF0aDogbXNnLnBhdGgsXG4gICAgICAgICAgICBlbnRyaWVzOiBbXSxcbiAgICAgICAgICAgIGVycm9yOiBTdHJpbmcoKGUgYXMgRXJyb3IpLm1lc3NhZ2UpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgLy8g4pSA4pSAIHRoZSBuYXRpdmUgcGlja2VyIChvbmUgZGlhbG9nIGF0IGEgdGltZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8vXG4gIC8vIEEgbW9kYWwgZGlhbG9nIG93bnMgdGhlIGh1bWFuJ3MgYXR0ZW50aW9uLCBhbmQgYSBzZWNvbmQgb25lIGJlaGluZCB0aGVcbiAgLy8gZmlyc3QgY2Fubm90IGJlIHNlZW4gb3IgZGlzbWlzc2VkIOKAlCBzbyBhIHJlcXVlc3Qgd2hpbGUgb25lIGlzIG9wZW4gaXNcbiAgLy8gcmVmdXNlZCBpbiB3b3JkcyByYXRoZXIgdGhhbiBxdWV1ZWQuXG4gIGxldCBwaWNrZXJPcGVuID0gZmFsc2U7XG4gIGNvbnN0IHplbml0eSA9IHByb2Nlc3MucGxhdGZvcm0gPT09IFwibGludXhcIiA/IEJ1bi53aGljaChcInplbml0eVwiKSA6IG51bGw7XG4gIGNvbnN0IG9wZW5QaWNrZXIgPSBhc3luYyAoXG4gICAgd3M6IGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4sXG4gICAgd2FudDogXCJjb250ZXh0LWZpbGVcIiB8IFwiY29udGV4dC1mb2xkZXJcIiB8IFwid29ya3NwYWNlXCIsXG4gICkgPT4ge1xuICAgIGlmIChwaWNrZXJPcGVuKSB7XG4gICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IFwiYSBmaWxlIHBpY2tlciBpcyBhbHJlYWR5IG9wZW5cIiB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3Qga2luZDogUGlja0tpbmQgPSB3YW50ID09PSBcImNvbnRleHQtZmlsZVwiID8gXCJmaWxlXCIgOiBcImZvbGRlclwiO1xuICAgIGNvbnN0IHByb21wdCA9XG4gICAgICB3YW50ID09PSBcIndvcmtzcGFjZVwiXG4gICAgICAgID8gXCJDaG9vc2UgdGhlIHdvcmtzcGFjZSBmb2xkZXIgZm9yIHNjcmlwdG9yaXVtXCJcbiAgICAgICAgOiB3YW50ID09PSBcImNvbnRleHQtZm9sZGVyXCJcbiAgICAgICAgICA/IFwiQ2hvb3NlIGEgZm9sZGVyIHRvIGFkZCB0byBzY3JpcHRvcml1bVwiXG4gICAgICAgICAgOiBcIkNob29zZSBkb2N1bWVudHMgdG8gYWRkIHRvIHNjcmlwdG9yaXVtXCI7XG4gICAgY29uc3QgY21kID0gcGlja2VyQ29tbWFuZChwcm9jZXNzLnBsYXRmb3JtLCBraW5kLCBwcm9tcHQsIHplbml0eSk7XG4gICAgaWYgKCFjbWQpIHtcbiAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgIHR5cGU6IFwiZXJyb3JcIixcbiAgICAgICAgbWVzc2FnZTogYG5vIGZpbGUgcGlja2VyIG9uIHRoaXMgc3lzdGVtICgke3Byb2Nlc3MucGxhdGZvcm19KSDigJQgdHlwZSB0aGUgcGF0aCBpbnN0ZWFkYCxcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBwaWNrZXJPcGVuID0gdHJ1ZTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcHJvYyA9IEJ1bi5zcGF3bihjbWQsIHsgc3Rkb3V0OiBcInBpcGVcIiwgc3RkZXJyOiBcInBpcGVcIiwgc3RkaW46IFwiaWdub3JlXCIgfSk7XG4gICAgICBjb25zdCBbb3V0LCBjb2RlXSA9IGF3YWl0IFByb21pc2UuYWxsKFtuZXcgUmVzcG9uc2UocHJvYy5zdGRvdXQpLnRleHQoKSwgcHJvYy5leGl0ZWRdKTtcbiAgICAgIHRvdWNoKCk7IC8vIGEgaHVtYW4gc3Rvb2QgYXQgYSBkaWFsb2c7IHRoZSBzZXNzaW9uIGlzIG5vdCBpZGxlXG4gICAgICBjb25zdCBwYXRocyA9IHBhcnNlUGlja2VyT3V0cHV0KG91dCk7XG4gICAgICBpZiAocGF0aHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIC8vIENhbmNlbGxlZDogbm90aGluZyBjaG9zZW4sIG5vdGhpbmcgc2FpZC4gQSByZWFsIGZhaWx1cmUgaXMgc2FpZC5cbiAgICAgICAgaWYgKCF3YXNDYW5jZWxsZWQoY29kZSwgb3V0KSlcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGB0aGUgZmlsZSBwaWNrZXIgZmFpbGVkIChleGl0ICR7Y29kZX0pYCB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgLy8gV2hhdCB3YXMgY2hvc2VuIGlzIGFkbWl0dGVkIGxpa2UgYW55IG90aGVyIHBhdGgg4oCUIGEgcGlja2VkIGZpbGUgdGhhdFxuICAgICAgLy8gc2NyaXB0b3JpdW0gZG9lcyBub3Qgb3BlbiBpcyByZWZ1c2VkIGluIHRoZSBzaWRlYmFyJ3Mgb3duIHdvcmRzLCBhbmRcbiAgICAgIC8vIHRoYXQgcmVmdXNhbCBtdXN0IG5vdCByZWFkIGFzIFwidGhlIHBpY2tlciBmYWlsZWRcIi5cbiAgICAgIHRyeSB7XG4gICAgICAgIGlmICh3YW50ID09PSBcIndvcmtzcGFjZVwiKVxuICAgICAgICAgIHN0cnVjdHVyZSh7IHR5cGU6IFwid29ya3NwYWNlLnNldFwiLCBwYXRoOiBwYXRoc1swXSBhcyBzdHJpbmcgfSwgXCJodW1hblwiKTtcbiAgICAgICAgZWxzZSBhZGRQYXRocyhwYXRocyk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgIHR5cGU6IFwiZXJyb3JcIixcbiAgICAgICAgbWVzc2FnZTogYGNvdWxkIG5vdCBvcGVuIHRoZSBmaWxlIHBpY2tlcjogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCxcbiAgICAgIH0pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwaWNrZXJPcGVuID0gZmFsc2U7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGFjdGl2ZU9mID0gKGRvYz86IHN0cmluZykgPT4ge1xuICAgIGNvbnN0IHNsdWcgPSBkb2MgPz8gc2Vzc2lvbi5vcGVuRG9jU2x1ZztcbiAgICBpZiAoIXNsdWcpIHJldHVybiBudWxsO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB2ID0gc2Vzc2lvbi5kb2Moc2x1Zyk7XG4gICAgICByZXR1cm4geyBkb2M6IHYuc2x1ZywgdmVyc2lvbjogdi5hY3RpdmUsIHBhdGg6IHNlc3Npb24uYWN0aXZlUGF0aCh2LnNsdWcpIH07XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gIH07XG5cbiAgLy8gLS0tIGFnZW50IGNvbW1hbmRzIChQT1NUIC9jbWQpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgbGV0IHJlc29sdmVEb25lITogKHY6IHsgY29kZTogbnVtYmVyOyByZWFzb246IHN0cmluZyB9KSA9PiB2b2lkO1xuICBjb25zdCBkb25lID0gbmV3IFByb21pc2U8eyBjb2RlOiBudW1iZXI7IHJlYXNvbjogc3RyaW5nIH0+KChyKSA9PiB7XG4gICAgcmVzb2x2ZURvbmUgPSByO1xuICB9KTtcblxuICAvKiogU2hvdyBhIGZpbGUgaW4gdGhlIHBsYXRmb3JtJ3MgZmlsZSBtYW5hZ2VyLiBBbiBhcmd2LCBuZXZlciBhIHNoZWxsIHN0cmluZzpcbiAgICogIHRoZSBwYXRoIGlzIGRhdGEsIHdoYXRldmVyIGl0IGhvbGRzLiAqL1xuICBjb25zdCByZXZlYWxQYXRoID0gKHBhdGg6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgIGNvbnN0IFtjbWQsIC4uLmFyZ3NdID1cbiAgICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCJcbiAgICAgICAgPyBbXCJvcGVuXCIsIFwiLVJcIiwgcGF0aF1cbiAgICAgICAgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCJcbiAgICAgICAgICA/IFtcImV4cGxvcmVyXCIsIGAvc2VsZWN0LCR7cGF0aH1gXVxuICAgICAgICAgIDogW1wieGRnLW9wZW5cIiwgZGlybmFtZShwYXRoKV07XG4gICAgQnVuLnNwYXduKFtjbWQgYXMgc3RyaW5nLCAuLi5hcmdzXSwgeyBzdGRpbzogW1wiaWdub3JlXCIsIFwiaWdub3JlXCIsIFwiaWdub3JlXCJdIH0pLnVucmVmKCk7XG4gIH07XG5cbiAgY29uc3QgaGFuZGxlQWdlbnRDbWQgPSAoY21kOiBBZ2VudENtZCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+IHtcbiAgICBpZiAoaXNTdHJ1Y3R1cmVPcChjbWQpKSByZXR1cm4gc3RydWN0dXJlKGNtZCwgXCJhZ2VudFwiKTtcbiAgICBzd2l0Y2ggKGNtZC50eXBlKSB7XG4gICAgICBjYXNlIFwibWV0YVwiOlxuICAgICAgICByZXR1cm4gc2Vzc2lvbi5tZXRhRm9yKGNtZC5wYXRoKTtcbiAgICAgIGNhc2UgXCJncmFwaFwiOlxuICAgICAgICByZXR1cm4gc2Vzc2lvbi5ncmFwaEZvcihjbWQuZW50cnkpIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICBjYXNlIFwiYmFja2xpbmtzXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLmJhY2tsaW5rcyhjbWQucGF0aCk7XG4gICAgICBjYXNlIFwibWV0YS5pbml0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubWV0YUluaXQoY21kLnBhdGgsIHtcbiAgICAgICAgICAuLi4oY21kLm1ldGFUeXBlID8geyB0eXBlOiBjbWQubWV0YVR5cGUgfSA6IHt9KSxcbiAgICAgICAgICBieTogY21kLmJ5ID8/IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGFubm91bmNlKGBBZ2VudCBhZGRlZCBmcm9udG1hdHRlciB0byAke3Nlc3Npb24uZGlzcGxheShTdHJpbmcoci5wYXRoKSl9LmAsIHtcbiAgICAgICAgICBmYWN0OiBcIm1ldGEuaW5pdFwiLFxuICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgICAgLi4ucixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiByO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1ldGEuc2V0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubWV0YVNldChjbWQucGF0aCwgY21kLmZpZWxkcyk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCBzZXQgJHsoci5zZXQgYXMgc3RyaW5nW10pLmpvaW4oXCIsIFwiKX0gb24gJHtzZXNzaW9uLmRpc3BsYXkoU3RyaW5nKHIucGF0aCkpfS5gLFxuICAgICAgICAgIHsgZmFjdDogXCJtZXRhLnNldFwiLCBieTogXCJhZ2VudFwiLCAuLi5yIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiByO1xuICAgICAgfVxuICAgICAgY2FzZSBcInZlcnNpb24uZGVsZXRlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZGVsZXRlVmVyc2lvbih7IGRvYzogY21kLmRvYywgdmVyc2lvbjogY21kLnZlcnNpb24gfSk7XG4gICAgICAgIGFubm91bmNlKGBBZ2VudCBkZWxldGVkIHYke3IudmVyc2lvbn0gb2YgJHtyLnNsdWd9JHtyLmxhYmVsID8gYCDigJQgJHtyLmxhYmVsfWAgOiBcIlwifS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJ2ZXJzaW9uLmRlbGV0ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24sIHJlbWFpbmluZzogci5yZW1haW5pbmcgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJkaWZmXCI6IHtcbiAgICAgICAgY29uc3QgcCA9IHNlc3Npb24uY29tcGFyZSh7IGRvYzogY21kLmRvYywgYWdhaW5zdDogY21kLmFnYWluc3QgfSk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgZG9jOiBwLmRvYyxcbiAgICAgICAgICBhY3RpdmU6IHAuYWN0aXZlLFxuICAgICAgICAgIGFnYWluc3Q6IHAuYWdhaW5zdCxcbiAgICAgICAgICBzYW1lOiBwLmRpZmYuc2FtZSxcbiAgICAgICAgICBjb2Fyc2U6IHAuZGlmZi5jb2Fyc2UsXG4gICAgICAgICAgaHVua3M6IHAuZGlmZi5odW5rcyxcbiAgICAgICAgICB1bmlmaWVkOiB1bmlmaWVkKHAuZGlmZiwge1xuICAgICAgICAgICAgZnJvbTogYHYke3AuYWN0aXZlfWAsXG4gICAgICAgICAgICB0bzogc2lkZU5hbWUocC5hZ2FpbnN0LCBzZXNzaW9uLmRvYyhwLmRvYykubmFtZSksXG4gICAgICAgICAgICAuLi4oY21kLmNvbnRleHQgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBjb250ZXh0OiBjbWQuY29udGV4dCB9KSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJtZXJnZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm1lcmdlKHsgZG9jOiBjbWQuZG9jLCBhZ2FpbnN0OiBjbWQuYWdhaW5zdCwgaHVua3M6IGNtZC5odW5rcyB9KTtcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogci50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJyZW1vdGVcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCB0b29rICR7ci5hcHBsaWVkfSBjaGFuZ2Uke3IuYXBwbGllZCA9PT0gMSA/IFwiXCIgOiBcInNcIn0gZnJvbSAke3NpZGVOYW1lKGNtZC5hZ2FpbnN0LCBzZXNzaW9uLmRvYyhyLnNsdWcpLm5hbWUpfSBpbnRvIHYke3IudmVyc2lvbn0gb2YgJHtyLnNsdWd9LmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm1lcmdlZFwiLCBkb2M6IHIuc2x1ZywgdmVyc2lvbjogci52ZXJzaW9uLCBodW5rczogY21kLmh1bmtzLCBieTogXCJhZ2VudFwiIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24sIGFwcGxpZWQ6IHIuYXBwbGllZCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImZpbmRcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24uZmluZChjbWQuZmlsdGVyKTtcbiAgICAgIGNhc2UgXCJjb250ZXh0LmFkZFwiOiB7XG4gICAgICAgIGNvbnN0IGFkZGVkID0gYWRkUGF0aHMoY21kLnBhdGhzKTtcbiAgICAgICAgcmV0dXJuIHsgZW50cmllczogYWRkZWQubWFwKChhKSA9PiAoeyAuLi5hLmVudHJ5LCBhZGRlZDogYS5hZGRlZCB9KSkgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLm5ld1wiOiB7XG4gICAgICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggNzogdGhlIGFnZW50IG1heSBuYW1lIGEgZG9jIHRoZSBodW1hbiBoYXMgbm90XG4gICAgICAgIC8vIG9wZW5lZCwgYnkgQUJTT0xVVEUgcGF0aCAodGhlIENMSSByZXNvbHZlcyBpdCBhZ2FpbnN0IGl0cyBvd24gY3dkKTtcbiAgICAgICAgLy8gaXQgaXMgb3BlbmVkIGltcGxpY2l0bHkgdW5kZXIgdGhlIHNhbWUgYWRtaXNzaW9uIHJ1bGUgYXMgdGhlXG4gICAgICAgIC8vIHN1cmZhY2UncyBgb3BlbmAg4oCUIGEgZG9jLXR5cGUgZmlsZSBpbnNpZGUgYSBjb250ZXh0IGVudHJ5IOKAlCB3aXRob3V0XG4gICAgICAgIC8vIG1vdmluZyB0aGUgaHVtYW4ncyBvcGVuIGRvY3VtZW50LlxuICAgICAgICBpZiAoY21kLmRvYyAmJiBpc0Fic29sdXRlKGNtZC5kb2MpICYmICFzZXNzaW9uLmZpbmREb2MoY21kLmRvYykpIHtcbiAgICAgICAgICBjb25zdCBvID0gc2Vzc2lvbi5vcGVuUGF0aChjbWQuZG9jLCB7IGZvY3VzOiBmYWxzZSB9KTtcbiAgICAgICAgICBpZiAoby5jcmVhdGVkKVxuICAgICAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgICAgICB0eXBlOiBcImRvYy5vcGVuZWRcIixcbiAgICAgICAgICAgICAgZG9jOiBvLnNsdWcsXG4gICAgICAgICAgICAgIHBhdGg6IHNlc3Npb24uYWN0aXZlUGF0aChvLnNsdWcpLFxuICAgICAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubmV3VmVyc2lvbih7XG4gICAgICAgICAgZG9jOiBjbWQuZG9jLFxuICAgICAgICAgIGZyb206IGNtZC5mcm9tLFxuICAgICAgICAgIGxhYmVsOiBjbWQubGFiZWwsXG4gICAgICAgICAgYXV0aG9yOiBcImFnZW50XCIsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShcbiAgICAgICAgICBgQWdlbnQgY3JlYXRlZCB2JHtyLnZlcnNpb24ubn0gb2YgJHtyLnNsdWd9IGZyb20gdiR7ci52ZXJzaW9uLmZyb219JHtjbWQubGFiZWwgPyBgIOKAlCAke2NtZC5sYWJlbH1gIDogXCJcIn0uYCxcbiAgICAgICAgICB7IGZhY3Q6IFwidmVyc2lvbi5jcmVhdGVkXCIsIGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24ubiB9LFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1ZywgdmVyc2lvbjogci52ZXJzaW9uLm4sIGZyb206IHIudmVyc2lvbi5mcm9tLCBwYXRoOiByLnZlcnNpb24ucGF0aCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInNheVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJhZ2VudFwiLCBjbWQudGV4dCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiB7IGlkOiBtLmlkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiYWN0aXZhdGVcIjpcbiAgICAgICAgcmV0dXJuIGFjdGl2YXRlKGNtZC5kb2MsIGNtZC52ZXJzaW9uLCBcImFnZW50XCIpO1xuICAgICAgY2FzZSBcImNsb3NlXCI6XG4gICAgICAgIHJlc29sdmVEb25lKHsgY29kZTogMCwgcmVhc29uOiBcImNsb3NlXCIgfSk7XG4gICAgICAgIHJldHVybiB7fTtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgICAgYHVucmVjb2duaXNlZCBjb21tYW5kIHR5cGUgJHtKU09OLnN0cmluZ2lmeSgoY21kIGFzIHsgdHlwZT86IHVua25vd24gfSkudHlwZSl9IOKAlCBub3RoaW5nIHdhcyBhcHBsaWVkYCxcbiAgICAgICAgICA0MDAsXG4gICAgICAgICAgW1xuICAgICAgICAgICAgXCJjb250ZXh0LmFkZFwiLFxuICAgICAgICAgICAgXCJ2ZXJzaW9uLm5ld1wiLFxuICAgICAgICAgICAgXCJzYXlcIixcbiAgICAgICAgICAgIFwiYWN0aXZhdGVcIixcbiAgICAgICAgICAgIFwiY2xvc2VcIixcbiAgICAgICAgICAgIFwibWV0YVwiLFxuICAgICAgICAgICAgXCJmaW5kXCIsXG4gICAgICAgICAgICBcImdyYXBoXCIsXG4gICAgICAgICAgICBcImJhY2tsaW5rc1wiLFxuICAgICAgICAgICAgXCJtZXRhLmluaXRcIixcbiAgICAgICAgICAgIFwibWV0YS5zZXRcIixcbiAgICAgICAgICAgIC4uLlNUUlVDVFVSRV9PUFMsXG4gICAgICAgICAgXSxcbiAgICAgICAgKTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgcmVmdXNhbCA9IChlOiB1bmtub3duKTogUmVzcG9uc2UgPT4ge1xuICAgIGlmIChlIGluc3RhbmNlb2YgU2Vzc2lvbkVycm9yKVxuICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oXG4gICAgICAgIHsgb2s6IGZhbHNlLCBlcnJvcjogZS5tZXNzYWdlLCAuLi4oZS5jaG9pY2VzID8geyBjaG9pY2VzOiBlLmNob2ljZXMgfSA6IHt9KSB9LFxuICAgICAgICB7IHN0YXR1czogZS5zdGF0dXMgfSxcbiAgICAgICk7XG4gICAgaWYgKGUgaW5zdGFuY2VvZiBQYXRoRXJyb3IpXG4gICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSB9LCB7IHN0YXR1czogNDA0IH0pO1xuICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogU3RyaW5nKGUpIH0sIHsgc3RhdHVzOiA1MDAgfSk7XG4gIH07XG5cbiAgY29uc3QgZXZlbnRzUmVzcG9uc2UgPSAocmVxOiBSZXF1ZXN0LCB1cmw6IFVSTCk6IFJlc3BvbnNlID0+IHtcbiAgICB0b3VjaCgpO1xuICAgIHJldHVybiBzc2VSZXNwb25zZSh7XG4gICAgICBsb2csXG4gICAgICBzaW5jZTogTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic2luY2VcIikgPz8gXCItMVwiLCAxMCksXG4gICAgICBoZWFydGJlYXRNczogU1NFX0hFQVJUQkVBVF9NUyxcbiAgICAgIGNsaWVudHM6IHNzZUNsaWVudHMsXG4gICAgICBzaWduYWw6IHJlcS5zaWduYWwsXG4gICAgICBvbk9wZW46IHRvdWNoLFxuICAgICAgb25DbG9zZTogdG91Y2gsXG4gICAgfSk7XG4gIH07XG5cbiAgLy8gLS0tIHNlcnZlIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc2VydmVyID0gQnVuLnNlcnZlKHtcbiAgICBwb3J0OiBvcHRzLnBvcnQgPz8gMCxcbiAgICBob3N0bmFtZTogXCIxMjcuMC4wLjFcIixcbiAgICByb3V0ZXMsXG4gICAgaWRsZVRpbWVvdXQ6IElETEVfVElNRU9VVF9TRUMsXG4gICAgZGV2ZWxvcG1lbnQ6IHsgaG1yOiBtb2RlID09PSBcImRldlwiIH0sXG4gICAgZmV0Y2gocmVxLCBzcnYpIHtcbiAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmVxLnVybCk7XG4gICAgICBjb25zdCBwYXRoID0gdXJsLnBhdGhuYW1lO1xuICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAxYSDigJQgQSBGT1JFSUdOIE9SSUdJTiBJUyBSRUZVU0VELiBBbnkgd2ViIHBhZ2UgdGhlXG4gICAgICAvLyBodW1hbiB2aXNpdHMgY2FuIG9wZW4gYSBXZWJTb2NrZXQgb3IgUE9TVCB0byAxMjcuMC4wLjE7IHRoZSBicm93c2VyXG4gICAgICAvLyBzZW5kcyBpdHMgT3JpZ2luLCBhbmQgb25seSB0aGlzIGRhZW1vbidzIG93biBwYWdlIG1heSBkcml2ZSBpdC4gVGhlXG4gICAgICAvLyBDTEkncyBmZXRjaCBzZW5kcyBubyBPcmlnaW4gYXQgYWxsLCBzbyBpdCBpcyB1bmFmZmVjdGVkLlxuICAgICAgaWYgKFxuICAgICAgICAocGF0aCA9PT0gXCIvd3NcIiB8fCBwYXRoID09PSBcIi9jbWRcIiB8fCBwYXRoLnN0YXJ0c1dpdGgoXCIvZnMvXCIpKSAmJlxuICAgICAgICAhc2FtZU9yaWdpbihyZXEsIHNydi5wb3J0KVxuICAgICAgKVxuICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IFwiZm9yZWlnbiBvcmlnaW4gcmVmdXNlZFwiIH0sIHsgc3RhdHVzOiA0MDMgfSk7XG4gICAgICBpZiAocGF0aCA9PT0gXCIvd3NcIilcbiAgICAgICAgcmV0dXJuIHNydi51cGdyYWRlKHJlcSkgPyB1bmRlZmluZWQgOiBuZXcgUmVzcG9uc2UoXCJ1cGdyYWRlIHJlcXVpcmVkXCIsIHsgc3RhdHVzOiA0MjYgfSk7XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9zdGF0ZVwiKSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGNvbnN0IHN0YXRlID0gdmlld1N0YXRlKCk7XG4gICAgICAgIGNvbnN0IGZ1bGwgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcImZ1bGxcIikgPT09IFwiMVwiO1xuICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7XG4gICAgICAgICAgLi4uc3RhdGUsXG4gICAgICAgICAgY2hhdDogZnVsbCA/IHN0YXRlLmNoYXQgOiBzdGF0ZS5jaGF0LnNsaWNlKC0xMCksXG4gICAgICAgICAgY2hhdFRvdGFsOiBzdGF0ZS5jaGF0Lmxlbmd0aCxcbiAgICAgICAgICBhY3RpdmU6IGFjdGl2ZU9mKCksXG4gICAgICAgICAgY3Vyc29yOiBsb2cuY3Vyc29yKCksXG4gICAgICAgICAgZXBvY2g6IGxvZy5lcG9jaCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9ldmVudHNcIikgcmV0dXJuIGV2ZW50c1Jlc3BvbnNlKHJlcSwgdXJsKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL2ZzL3ZlcnNpb25cIikge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlYWRWZXJzaW9uKFxuICAgICAgICAgICAgdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJkb2NcIikgPz8gXCJcIixcbiAgICAgICAgICAgIE51bWJlci5wYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInZcIikgPz8gXCJcIiwgMTApLFxuICAgICAgICAgICk7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24ocik7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXR1cm4gcmVmdXNhbChlKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZnMvbGlzdFwiKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oe1xuICAgICAgICAgICAgZW50cmllczogbGlzdERpcihleHBhbmRIb21lKHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwicGF0aFwiKSA/PyBcIn5cIikpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcoKGUgYXMgRXJyb3IpLm1lc3NhZ2UpIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9jbWRcIilcbiAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAudGhlbigoYikgPT4ge1xuICAgICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IHRydWUsIC4uLmhhbmRsZUFnZW50Q21kKGIgYXMgQWdlbnRDbWQpIH0pO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICByZXR1cm4gcmVmdXNhbChlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoKSA9PiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogXCJiYWQganNvblwiIH0sIHsgc3RhdHVzOiA0MDAgfSkpO1xuICAgICAgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgIGNvbnN0IGFzc2V0ID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICBpZiAoYXNzZXQpIHJldHVybiBhc3NldDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwibm90IGZvdW5kXCIgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICB9LFxuICAgIHdlYnNvY2tldDoge1xuICAgICAgb3Blbih3cykge1xuICAgICAgICBzb2NrZXRzLmFkZCh3cyk7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcInN0YXRlXCIsIHN0YXRlOiB2aWV3U3RhdGUoKSB9KSk7XG4gICAgICB9LFxuICAgICAgbWVzc2FnZSh3cywgcmF3KSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGxldCBtc2c6IENsaWVudE1zZztcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBtc2cgPSBKU09OLnBhcnNlKFxuICAgICAgICAgICAgdHlwZW9mIHJhdyA9PT0gXCJzdHJpbmdcIiA/IHJhdyA6IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyYXcpLFxuICAgICAgICAgICkgYXMgQ2xpZW50TXNnO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYHNjcmlwdG9yaXVtOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBoYW5kbGVDbGllbnRNc2cod3MsIG1zZyk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAvLyBBIHJlZnVzYWwgdGhlIGh1bWFuIGNhdXNlZCAoZWRpdCBhIG5vbi1hY3RpdmUgdmVyc2lvbiwgb3BlbiBhXG4gICAgICAgICAgLy8gdmFuaXNoZWQgZmlsZSkgcmVhY2hlcyBUSEVNLCBhcyBhIGNoYXQtdmlzaWJsZSBzeXN0ZW0gbGluZSB3b3VsZCBiZVxuICAgICAgICAgIC8vIHRvbyBsb3VkIGZvciBhIGtleXN0cm9rZSDigJQgc28gaXQgaXMgYW4gZXJyb3IgZnJhbWUgdGhlIHN1cmZhY2Ugc2hvd3MuXG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICBjbG9zZSh3cykge1xuICAgICAgICBzb2NrZXRzLmRlbGV0ZSh3cyk7XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGJvdW5kUG9ydCA9IHNlcnZlci5wb3J0O1xuICAvLyAtLS0gZGlzY292ZXJ5IChFMTM6IHNlc3Npb24tSlNPTiwgdGhlIG9ubHkgY29udmVudGlvbiB0aGF0IGNhbiBleHByZXNzIHNldmVyYWwpIC0tXG4gIGNvbnN0IHNlc3Npb25GaWxlID0gam9pbih0bXBkaXIoKSwgYHNjcmlwdG9yaXVtLSR7c2Vzc2lvbklkfS5qc29uYCk7XG4gIGNvbnN0IGxhdGVzdEZpbGUgPSBqb2luKHRtcGRpcigpLCBcInNjcmlwdG9yaXVtLWxhdGVzdC5qc29uXCIpO1xuICBjb25zdCBpbmZvID0gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHVybDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtib3VuZFBvcnR9YCxcbiAgICBwb3J0OiBib3VuZFBvcnQsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIGhvbWUsXG4gICAgZGlyOiBzZXNzaW9uLmRpcixcbiAgICBtb2RlLFxuICB9KTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVBdG9taWMoc2Vzc2lvbkZpbGUsIGluZm8pO1xuICAgIHdyaXRlRmlsZUF0b21pYyhsYXRlc3RGaWxlLCBpbmZvKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogZGlzY292ZXJ5IGlzIGJlc3QtZWZmb3J0ICovXG4gIH1cblxuICBzeW5jV2F0Y2hlcnMoKTtcbiAgbG9nLmVtaXQoeyB0eXBlOiBcInJlYWR5XCIsIG1vZGUsIHNlc3Npb25faWQ6IHNlc3Npb25JZCwgcmVzdG9yZWQ6ICEhb3B0cy5yZXN0b3JlIH0pO1xuICAvLyBWZXJpZnktcGFzcyBmaXggMjogd2hhdCBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgbm8gZGFlbW9uIHdhcyB3YXRjaGluZy5cbiAgZm9yIChjb25zdCBmIG9mIHNlc3Npb24ucmVzdG9yZUZpbmRpbmdzKVxuICAgIGFubm91bmNlKFxuICAgICAgZi5taXNzaW5nXG4gICAgICAgID8gYCR7Zi5vcmlnaW5hbH0gaXMgZ29uZSBmcm9tIGRpc2sgc2luY2UgdGhpcyBzZXNzaW9uIHdhcyBsYXN0IG9wZW4uIFNhdmUgd291bGQgcmVjcmVhdGUgaXQ7IFJldmVydCBjYW5ub3QgcnVuLmBcbiAgICAgICAgOiBgJHtmLm9yaWdpbmFsfSBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgdGhpcyBzZXNzaW9uIHdhcyBjbG9zZWQuIFNhdmUgb3ZlcndyaXRlcyBpdCB3aXRoIHRoZSBhY3RpdmUgdmVyc2lvbjsgUmV2ZXJ0IHRha2VzIHRoZSBmaWxlJ3MgdmVyc2lvbi5gLFxuICAgICAgeyBmYWN0OiBcIm9yaWdpbmFsLmNvbmZsaWN0XCIsIGRvYzogZi5kb2MsIHdoaWxlQ2xvc2VkOiB0cnVlIH0sXG4gICAgKTtcblxuICBjb25zdCBzdG9wSG91c2VrZWVwaW5nID0gc3RhcnRIb3VzZWtlZXBpbmcoe1xuICAgIHN1YnNjcmliZXJDb3VudDogKCkgPT4gc29ja2V0cy5zaXplICsgc3NlQ2xpZW50cy5zaXplLFxuICAgIGlkbGVNczogKCkgPT4gcGVyZm9ybWFuY2Uubm93KCkgLSBsYXN0QWN0aXZpdHksXG4gICAgdG91Y2gsXG4gICAgdGltZW91dE1zOiAob3B0cy50aW1lb3V0UyA/PyAxODAwKSAqIDEwMDAsXG4gICAgb25JZGxlQ2xvc2U6ICgpID0+IHJlc29sdmVEb25lKHsgY29kZTogMTI0LCByZWFzb246IFwidGltZW91dFwiIH0pLFxuICB9KTtcblxuICBsZXQgY2xvc2VkID0gZmFsc2U7XG4gIGxldCByZXNvbHZlU2h1dGRvd24hOiAoKSA9PiB2b2lkO1xuICBjb25zdCBzaHV0ZG93biA9IG5ldyBQcm9taXNlPHZvaWQ+KChyKSA9PiB7XG4gICAgcmVzb2x2ZVNodXRkb3duID0gcjtcbiAgfSk7XG5cbiAgY29uc3QgY2xlYW51cERpc2NvdmVyeSA9ICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgdW5saW5rU3luYyhzZXNzaW9uRmlsZSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBnb25lIOKAlCBmaW5lICovXG4gICAgfVxuICAgIHVubGlua0lmTWF0Y2hlcyhsYXRlc3RGaWxlLCBzZXNzaW9uSWQsIChyYXcpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGlkID0gKEpTT04ucGFyc2UocmF3KSBhcyB7IHNlc3Npb25faWQ/OiB1bmtub3duIH0pLnNlc3Npb25faWQ7XG4gICAgICAgIHJldHVybiB0eXBlb2YgaWQgPT09IFwic3RyaW5nXCIgPyBpZCA6IG51bGw7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgfSk7XG4gIH07XG5cbiAgLy8gVGhlIG9yZGVyIGlzIHRoZSBoZWFkZXIncywgYW5kIHRoZSBoZWFkZXIgc2F5cyB3aHkuXG4gIGNvbnN0IGNsb3NlID0gKCkgPT4ge1xuICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICBjbG9zZWQgPSB0cnVlO1xuICAgIHN0b3BIb3VzZWtlZXBpbmcoKTtcbiAgICBmb3IgKGNvbnN0IHcgb2Ygd2F0Y2hlcnMudmFsdWVzKCkpIHcuY2xvc2UoKTtcbiAgICB3YXRjaGVycy5jbGVhcigpO1xuICAgIGZvciAoY29uc3QgdCBvZiBwZW5kaW5nLnZhbHVlcygpKSBjbGVhclRpbWVvdXQodCk7XG4gICAgdHJ5IHtcbiAgICAgIHNlc3Npb24ucGVyc2lzdCgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYmVzdC1lZmZvcnQgKi9cbiAgICB9XG4gICAgY2xlYW51cERpc2NvdmVyeSgpO1xuICAgIGxvZy5lbWl0KHsgdHlwZTogXCJjbG9zZWRcIiB9KTtcbiAgICB2b2lkIGRyYWluQW5kU3RvcCh7IHNlcnZlciwgY2xpZW50czogc3NlQ2xpZW50cywgc29ja2V0cyB9KS50aGVuKHJlc29sdmVTaHV0ZG93bik7XG4gIH07XG4gIGRvbmUudGhlbigoKSA9PiBjbG9zZSgpKTtcblxuICByZXR1cm4geyBwb3J0OiBib3VuZFBvcnQsIHNlc3Npb25JZCwgbW9kZSwgZGlyOiBzZXNzaW9uLmRpciwgY2xvc2UsIGRvbmUsIHNodXRkb3duIH07XG59XG5cbi8qKiBBbiBhYnNlbnQgT3JpZ2luICh0aGUgQ0xJLCBjdXJsKSBvciB0aGlzIGRhZW1vbidzIG93biBwYWdlOyBub3RoaW5nIGVsc2UuICovXG5leHBvcnQgZnVuY3Rpb24gc2FtZU9yaWdpbihyZXE6IFJlcXVlc3QsIHBvcnQ6IG51bWJlciB8IHVuZGVmaW5lZCk6IGJvb2xlYW4ge1xuICBjb25zdCBvcmlnaW4gPSByZXEuaGVhZGVycy5nZXQoXCJvcmlnaW5cIik7XG4gIGlmIChvcmlnaW4gPT09IG51bGwpIHJldHVybiB0cnVlO1xuICByZXR1cm4gb3JpZ2luID09PSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9YCB8fCBvcmlnaW4gPT09IGBodHRwOi8vbG9jYWxob3N0OiR7cG9ydH1gO1xufVxuXG4vKipcbiAqIEEgcGF0aCB0eXBlZCBpbiB0aGUgU1VSRkFDRS4gVGhlIHBhZ2UgaGFzIG5vIHdvcmtpbmcgZGlyZWN0b3J5LCBzbyBhIHBhdGhcbiAqIGZyb20gaXQgbXVzdCBiZSBhYnNvbHV0ZSBvciBzdGFydCBhdCBgfmAg4oCUIHdoaWNoIGlzIGV4cGFuZGVkIEhFUkUuIEJlZm9yZVxuICogdGhpcywgYH4vRG9jdW1lbnRzYCByZWFjaGVkIGByZXNvbHZlKClgIGFuZCB3YXMgdGFrZW4gYXMgcmVsYXRpdmUgdG8gdGhlXG4gKiBkYWVtb24ncyBjd2QgKHRoZSBza2lsbCBmb2xkZXIpOiB0aGUgcGF0aCBib3ggY29tcGxldGVkIGB+L+KApmAgKGxpc3RpbmdcbiAqIGV4cGFuZHMgaXQpIGFuZCB0aGVuIEVudGVyIGZhaWxlZCB3aXRoIFwibm8gc3VjaCBmaWxlIG9yIGZvbGRlcjpcbiAqIOKApi9za2lsbHMvc2NyaXB0b3JpdW0vfi9Eb2N1bWVudHMv4oCmXCIgKENvbGUsIDIwMjYtMDktMTEpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3VyZmFjZVBhdGgocDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdCA9IHAudHJpbSgpO1xuICBpZiAodCA9PT0gXCJ+XCIgfHwgdC5zdGFydHNXaXRoKFwifi9cIikpIHJldHVybiBleHBhbmRIb21lKHQpO1xuICBpZiAoIWlzQWJzb2x1dGUodCkpXG4gICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgXCIke3B9XCIgaXMgbm90IGEgZnVsbCBwYXRoIOKAlCBzdGFydCBpdCB3aXRoIC8gb3Igfi9gLCA0MDApO1xuICByZXR1cm4gcmVzb2x2ZSh0KTtcbn1cblxuLyoqIEEgc3RydWN0dXJlIG9wIGZyb20gdGhlIHN1cmZhY2UsIHdpdGggZXZlcnkgcGF0aCBmaWVsZCB0aHJvdWdoIGBzdXJmYWNlUGF0aGAuICovXG5mdW5jdGlvbiBhbmNob3JTdXJmYWNlUGF0aHMob3A6IFN0cnVjdHVyZU9wKTogU3RydWN0dXJlT3Age1xuICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyAuLi5vcCB9O1xuICBmb3IgKGNvbnN0IGsgb2YgW1wiZGlyXCIsIFwicGF0aFwiLCBcImludG9cIl0gYXMgY29uc3QpXG4gICAgaWYgKHR5cGVvZiBvdXRba10gPT09IFwic3RyaW5nXCIpIG91dFtrXSA9IHN1cmZhY2VQYXRoKG91dFtrXSBhcyBzdHJpbmcpO1xuICByZXR1cm4gb3V0IGFzIFN0cnVjdHVyZU9wO1xufVxuXG5mdW5jdGlvbiBleHBhbmRIb21lKHA6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChwID09PSBcIn5cIikgcmV0dXJuIGhvbWVkaXIoKTtcbiAgaWYgKHAuc3RhcnRzV2l0aChcIn4vXCIpKSByZXR1cm4gam9pbihob21lZGlyKCksIHAuc2xpY2UoMikpO1xuICByZXR1cm4gcmVzb2x2ZShwKTtcbn1cblxuLyoqIFRoZSBkYWVtb24ncyBwcml2YXRlIGFyZ3Yg4oCUIHRoZSBDTEkgc3Bhd25zIGl0IHdpdGggZXhhY3RseSB0aGVzZS4gKi9cbmNvbnN0IERBRU1PTl9PUFRJT05TID0ge1xuICBsb2c6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBwb3J0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcmVzdG9yZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB3b3Jrc3BhY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxufSBhcyBjb25zdDtcblxuLyoqIFBhcnNlIHRoZSBkYWVtb24ncyBhcmd2LCBib290LCBwcmludCB0aGUgaGFuZHNoYWtlLCB3YWl0IGZvciB0aGUgZW5kLiBSZXR1cm5zIHRoZSBleGl0IGNvZGUuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgdW5kZWZpbmVkPjtcbiAgdHJ5IHtcbiAgICBmbGFncyA9IG5vZGVQYXJzZUFyZ3MoeyBhcmdzOiBhcmd2LCBvcHRpb25zOiBEQUVNT05fT1BUSU9OUywgc3RyaWN0OiB0cnVlIH0pLnZhbHVlcyBhcyBSZWNvcmQ8XG4gICAgICBzdHJpbmcsXG4gICAgICBzdHJpbmcgfCB1bmRlZmluZWRcbiAgICA+O1xuICB9IGNhdGNoIChlKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgc2NyaXB0b3JpdW06ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbiAgcmVjb2duaXplZCBmbGFnczogJHtPYmplY3Qua2V5cyhcbiAgICAgICAgREFFTU9OX09QVElPTlMsXG4gICAgICApXG4gICAgICAgIC5tYXAoKGspID0+IGAtLSR7a31gKVxuICAgICAgICAuam9pbihcIiBcIil9XFxuYCxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIGxldCBkOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHN0YXJ0RGFlbW9uPj47XG4gIHRyeSB7XG4gICAgZCA9IGF3YWl0IHN0YXJ0RGFlbW9uKHtcbiAgICAgIHBvcnQ6IGZsYWdzLnBvcnQgPyBOdW1iZXIoZmxhZ3MucG9ydCkgOiAwLFxuICAgICAgcmVzdG9yZTogZmxhZ3MucmVzdG9yZSxcbiAgICAgIHRpbWVvdXRTOiBmbGFncy50aW1lb3V0ID8gTnVtYmVyKGZsYWdzLnRpbWVvdXQpIDogdW5kZWZpbmVkLFxuICAgICAgd29ya3NwYWNlOiBmbGFncy53b3Jrc3BhY2UsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICAvLyBUaGUgaGFuZHNoYWtlIGxpbmUgaXMgSlNPTiBlaXRoZXIgd2F5LCBzbyB0aGUgQ0xJIHJlYWRzIE9ORSBzaGFwZS5cbiAgICBjb25zdCBzdGF0dXMgPSBlIGluc3RhbmNlb2YgU2Vzc2lvbkVycm9yID8gZS5zdGF0dXMgOiA1MDA7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICBgJHtKU09OLnN0cmluZ2lmeSh7IG9rOiBmYWxzZSwgc3RhdHVzLCBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pfVxcbmAsXG4gICAgKTtcbiAgICByZXR1cm4gc3RhdHVzID09PSA0MDQgPyA1IDogc3RhdHVzID09PSA0MDkgPyA2IDogMTtcbiAgfVxuICBwcm9jZXNzLnN0ZG91dC53cml0ZShcbiAgICBgJHtKU09OLnN0cmluZ2lmeSh7IHVybDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtkLnBvcnR9YCwgcG9ydDogZC5wb3J0LCBzZXNzaW9uX2lkOiBkLnNlc3Npb25JZCwgbW9kZTogZC5tb2RlLCBkaXI6IGQuZGlyIH0pfVxcbmAsXG4gICk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGQuZG9uZTtcbiAgYXdhaXQgZC5zaHV0ZG93bjtcbiAgLy8gVmVyaWZ5LXBhc3MgZml4IDY6IGEgY2xlYW4gY2xvc2UgbGVhdmVzIG5vIGVtcHR5IGxvZyBiZWhpbmQuXG4gIGlmIChyZXMuY29kZSA9PT0gMCAmJiBmbGFncy5sb2cpIHtcbiAgICB0cnkge1xuICAgICAgaWYgKHN0YXRTeW5jKGZsYWdzLmxvZykuc2l6ZSA9PT0gMCkgdW5saW5rU3luYyhmbGFncy5sb2cpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9XG4gIHJldHVybiByZXMuY29kZTtcbn1cblxuLyoqXG4gKiBUaGUgZGFlbW9uJ3MgZW50cnksIGZvciB0aGUgTEFVTkNIRVIuIGBpbXBvcnQubWV0YS5tYWluYCBpcyBGQUxTRSBpbiB0aGVcbiAqIGJ1bmRsZSwgc28gdGhlcmUgaXMgbm8gc3VjaCBibG9jayBoZXJlLCBhbmQgdGhpcyB0YWtlcyBubyBhcmd1bWVudHM6IHRoZVxuICogY29tbWFuZCBsaW5lIGJlbG9uZ3MgdG8gdGhlIGZpbGUgdGhhdCBwYXJzZXMgaXQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgdHdvIHByaW1pdGl2ZXMgdW5kZXIgQk9USCBvZiB0aGUgaG91c2UncyBkYWVtb24tZGlzY292ZXJ5IGNvbnZlbnRpb25zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogRDMgcnVsZWQgdGhhdCB0aGUgY29udmVudGlvbnMgdGhlbXNlbHZlcyDigJQgcGVyLXNlc3Npb24gdG1wZGlyIEpTT04gKGJvdW50eSxcbiAqIGdsYW1vdXIsIGltYWdvLCBtYWdwaWUpIGFuZCBzaW5nbGV0b24gYCRIT01FL2RhZW1vbi5wb3J0YCArIGBkYWVtb24ucGlkYFxuICogKGFzdHJvbGFiZSwgZ3JhcGV2aW5lLCBtaW5kLW1hcHBlcikg4oCUIGJvdGggc3Vydml2ZSwgYmVjYXVzZSB0aGV5IGVuY29kZVxuICogZ2VudWluZWx5IGRpZmZlcmVudCBtb2RlbHMgKGNvbmN1cnJlbnQgc2Vzc2lvbnMgdnMgYSBzdGFuZGluZyBzaW5nbGV0b24pIGFuZFxuICogcGlja2luZyBvbmUgaXMgYSBwcm9kdWN0IGRlY2lzaW9uLCBub3QgYSBmYWN0b3Jpbmcgb25lLiBXaGF0IElTIG9uZVxuICogaW1wbGVtZW50YXRpb24gaXMgdGhlIHBhaXIgYmVsb3csIHdoaWNoIGlzIGFsc28gZXhhY3RseSB3aGVyZSBjZW5zdXMgZGVmZWN0XG4gKiAqKkwzKiogbGl2ZXMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCByZW5hbWVTeW5jLCBybVN5bmMsIHVubGlua1N5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuXG4vKipcbiAqIFdyaXRlIGB0ZXh0YCB0byBgdGFyZ2V0YCBhdG9taWNhbGx5OiB3cml0ZSBiZXNpZGUgaXQsIHRoZW4gcmVuYW1lLlxuICpcbiAqIOKblCAqKkwzLCBDTE9TRUQgQlkgQ09OU1RSVUNUSU9OLioqIEEgYmFyZSBgd3JpdGVGaWxlU3luY2AgaXMgbm90IGF0b21pYywgc28gYVxuICogQ0xJIHJlYWRpbmcgd2hpbGUgdGhlIGRhZW1vbiB3cml0ZXMgY2FuIG9ic2VydmUgYSBIQUxGLVdSSVRURU4gcG9pbnRlci4gVW5kZXJcbiAqIGEgYmVzdC1lZmZvcnQgcmVhZGVyIHRoYXQgc3VyZmFjZWQgYXMgXCJubyBydW5uaW5nIHNlc3Npb25cIiDigJQgYWJzZW5jZSByZXBvcnRlZFxuICogZm9yIHdoYXQgd2FzIHJlYWxseSBhIHRvcm4gcmVhZCwgd2hpY2ggaXMgdGhlIGV4YWN0IGNvbmZsYXRpb24gdGhlIGhvdXNlJ3NcbiAqIGBudWxsYC1ub3QtYDBgIHJ1bGUgZXhpc3RzIHRvIHByZXZlbnQuIFJlbmFtZSB3aXRoaW4gb25lIGRpcmVjdG9yeSBpcyBhdG9taWMsXG4gKiBzbyBhIHJlYWRlciBzZWVzIGVpdGhlciB0aGUgcHJldmlvdXMgcG9pbnRlciBvciB0aGUgbmV3IG9uZSwgbmV2ZXIgYSBwYXJ0aWFsXG4gKiBmaWxlLlxuICpcbiAqIEZpeGVkIGluIGdsYW1vdXIgMjAyNi0wOS0wNywgZm91bmQgc3RhbmRpbmcgaW4gdGhyZWUgc2libGluZ3MgdGhlIG5leHQgZGF5IGJ5XG4gKiB0aGUgZHVwbGljYXRpb24gcmVjb24sIGFuZCByZXBhaXJlZCBpbiBhbGwgb2YgdGhlbSB0aGUgb25seSB3YXkgdGhhdCBkb2VzIG5vdFxuICogbmVlZCBmaW5kaW5nIGFnYWluOiB0aGVyZSBpcyBub3cgb25lIGltcGxlbWVudGF0aW9uLlxuICpcbiAqIOKaoCBUaGUgdGVtcCBuYW1lIGNhcnJpZXMgdGhlIHBpZCwgc28gdHdvIGRhZW1vbnMgcmFjaW5nIHRvIHB1Ymxpc2ggdGhlIHNhbWVcbiAqIHBvaW50ZXIgY2Fubm90IGNsb2JiZXIgZWFjaCBvdGhlcidzIGludGVybWVkaWF0ZSBmaWxlIOKAlCBhbmQgaXQgaXMgcmVtb3ZlZCBvblxuICogYSBmYWlsZWQgd3JpdGUgcmF0aGVyIHRoYW4gbGVmdCBhcyBsaXR0ZXIgYmVzaWRlIHRoZSByZWFsIG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlRmlsZUF0b21pYyh0YXJnZXQ6IHN0cmluZywgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHRtcCA9IGAke3RhcmdldH0uJHtwcm9jZXNzLnBpZH0udG1wYDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKHRtcCwgdGV4dCk7XG4gICAgcmVuYW1lU3luYyh0bXAsIHRhcmdldCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRyeSB7XG4gICAgICBybVN5bmModG1wLCB7IGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogdGhlIHRlbXAgZmlsZSBpcyBhbHJlYWR5IGdvbmUsIG9yIHdhcyBuZXZlciBjcmVhdGVkICovXG4gICAgfVxuICAgIHRocm93IGVycjtcbiAgfVxufVxuXG4vKipcbiAqIERlbGV0ZSBgcGF0aGAgaWZmIGl0IHN0aWxsIG5hbWVzIFVTLiBSZXR1cm5zIHdoZXRoZXIgaXQgd2FzIGRlbGV0ZWQuXG4gKlxuICog4puUICoqXCJTVElMTCBPVVJTXCIgSVMgVEhFIFdIT0xFIEZVTkNUSU9OLioqIEEgZGFlbW9uIHRoYXQgdW5saW5rcyBpdHMgZGlzY292ZXJ5XG4gKiBmaWxlIHVuY29uZGl0aW9uYWxseSBhdCBleGl0IGRlbGV0ZXMgdGhlIHBvaW50ZXIgYSBTVUNDRVNTT1IgaGFzIGFscmVhZHlcbiAqIHdyaXR0ZW4g4oCUIHRoZSBzdWNjZXNzb3IgY2FuIHRoZW4gbm8gbG9uZ2VyIGJlIGZvdW5kIGFuZCB0aGUgbmV4dCBDTEkgdmVyYiBzcGF3bnMgYVxuICogdGhpcmQgZGFlbW9uLiBCb3RoIGNvbnZlbnRpb25zIGhhdmUgdGhpcyBoYXphcmQgYW5kIGJvdGggZXhwcmVzcyBpdFxuICogZGlmZmVyZW50bHk6IGFzdHJvbGFiZSBjb21wYXJlcyB0aGUgcGlkIGZpbGUncyBieXRlcyB0byBpdHMgb3duIHBpZCxcbiAqIG1hZ3BpZSBwYXJzZXMgdGhlIEpTT04gcG9pbnRlciBhbmQgY29tcGFyZXMgYHNlc3Npb25faWRgLiBgaWRlbnRpZnlgIGlzIHdoYXRcbiAqIG1ha2VzIHRob3NlIG9uZSBmdW5jdGlvbiDigJQgaXQgdHVybnMgdGhlIGZpbGUncyBieXRlcyBpbnRvIHRoZSBpZGVudGl0eSB0b1xuICogY29tcGFyZSwgYW5kIGl0IGRlZmF1bHRzIHRvIHRoZSB0cmltbWVkIGJ5dGVzIHRoZW1zZWx2ZXMuXG4gKlxuICog4pqgIEV2ZXJ5IGZhaWx1cmUgaXMgc3dhbGxvd2VkIGFuZCByZXBvcnRlZCBhcyBgZmFsc2VgOiB0aGUgZmlsZSBiZWluZyBnb25lLFxuICogdW5yZWFkYWJsZSwgb3IgdW5wYXJzZWFibGUgYWxsIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZSDigJQgaXQgaXMgbm90IG91cnMgdG9cbiAqIHJlbW92ZS4gQW4gdW5wYXJzZWFibGUgcG9pbnRlciBpcyBkZWxpYmVyYXRlbHkgTk9UIHRyZWF0ZWQgYXMgb3Vycywgd2hpY2ggaXNcbiAqIHRoZSBjb25zZXJ2YXRpdmUgaGFsZiBvZiB0aGUgc2FtZSBgbnVsbGAtbm90LWAwYCBydWxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdW5saW5rSWZNYXRjaGVzKFxuICBwYXRoOiBzdHJpbmcsXG4gIGV4cGVjdGVkOiBzdHJpbmcsXG4gIGlkZW50aWZ5OiAocmF3OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGwgPSAocmF3KSA9PiByYXcudHJpbSgpLFxuKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGlkZW50aWZ5KHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpICE9PSBleHBlY3RlZCkgcmV0dXJuIGZhbHNlO1xuICAgIHVubGlua1N5bmMocGF0aCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBpbi1wcm9jZXNzIGV2ZW50IGxvZyDigJQgdGhlIGFwcGVuZC1vbmx5LCByZXBsYXlhYmxlIGJ1ZmZlclxuICogYmVoaW5kIGV2ZXJ5IHNwZWxsJ3MgYEdFVCAvZXZlbnRzYCBTU0UgdGFpbC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzXG4gKiBgc2NyaXB0cy9ldmVudHMudHNgIOKAlCB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMyLCBhbmQgdGhlIG9ubHkgb25lIG9mXG4gKiB0aGUgc2l4IGNvcGllZC1pbi1wbGFjZSBidXNlcyB0aGF0IGlzIGEgbW9kdWxlLCBpcyBib3VuZGVkLCBjYXJyaWVzIGFuIGVwb2NoLCBhbmQgaXNcbiAqIHVuaXQtdGVzdGVkLiBUaGUgZml2ZSBvdGhlcnMgYXJlIHRoZSBzYW1lIHR3ZW50eSBsaW5lcyB3cml0dGVuIGZpdmUgdGltZXMuXG4gKlxuICog4pSA4pSAIFRIRSBUSFJFRSBUSElOR1MgVEhJUyBGSVhFUyDigJQgVFdPIEJZIENPTlNUUlVDVElPTiwgT05FIEJZIE9QVC1JTiDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiDim5QgVEhFIEhFQURJTkcgVVNFRCBUTyBTQVkgXCJUSEUgVEhSRUUgVEhJTkdTIFRISVMgRklYRVMgQlkgQ09OU1RSVUNUSU9OXCIgQU5EXG4gKiBJVEVNIDIgSVMgTk9UIE9ORSBPRiBUSEVNLiBDb3JyZWN0ZWQgMjAyNi0wOS0wOSBpbiBtaW5kLW1hcHBlcidzIHByZS13b3JrXG4gKiAoRDc5KTogYGVwb2NoYCBpcyBPUFRJT05BTCBoZXJlLCBzbyBMNiBpcyBjbG9zZWQgb25seSBmb3IgYSBjYWxsZXIgdGhhdCBhc2tzLlxuICogVGhyZWUgYWRvcHRlcnMgaGF2ZSBzaW5jZSBkZWNsaW5lZCB0byDigJQgaW1hZ28gKEQzOSksIGJvdW50eSAoRDQ4KSBhbmRcbiAqIGdyYXBldmluZSAoRDcwKSDigJQgc28gdGhlIGRlZmVjdCB0aGUgaGVhZGluZyBjbGFpbWVkIHRvIG1ha2UgaW1wb3NzaWJsZSBpc1xuICogbGl2ZSBpbiB0aGUgdHJlZSwgYnkgb3B0LW91dCwgYW5kIHRoZSBvdmVyY2xhaW0gaXMgd2hhdCBoaWQgdGhhdC4gSXRlbXMgMSBhbmRcbiAqIDMgQVJFIGJ5IGNvbnN0cnVjdGlvbjogYSBjYWxsZXIgY2Fubm90IHN3aXRjaCB0aGUgY2FwIG9mZiBvciByZWFjaCB0aGUgYnVmZmVyLlxuICpcbiAqIOKaoCBBTkQgTUlORC1NQVBQRVInUyBPV04gQlVTLCBXSElDSCBUSElTIE1PRFVMRSBDT05WRVJHRUQgVE9XQVJELCBUWVBFUyBUSEVcbiAqIEVQT0NIIEFTIFJFUVVJUkVEIGFuZCBzdGFtcHMgaXQgdW5jb25kaXRpb25hbGx5IOKAlCBpdCBpcyB0aGUgc3BlbGwgY2Vuc3VzIEw2XG4gKiBuYW1lcyBhcyBDT1JSRUNULiBNYWtpbmcgaXQgcmVxdWlyZWQgSEVSRSBpcyBub3QgdGhlIHJlcGFpcjogaXQgd291bGQgcmV2ZXJzZVxuICogRDM5LCBENDggYW5kIEQ3MC4gVGhlIGhvbmVzdCBzdGF0ZW1lbnQgaXMgdGhpcyBoZWFkaW5nLlxuICpcbiAqIOKblCAqKlJFU09MVkVEIEFUIFRIQVQgU1BFTEwnUyBQT1JULCBBTkQgVEhFIERJU1BPU0lUSU9OIElTIFJFQ09SREVEIEhFUkVcbiAqIEJFQ0FVU0UgQSBMT1NTIFRIQVQgTElWRVMgT05MWSBJTiBBIEpPVVJOQUwgSVMgQSBMT1NTIE5PQk9EWSBDQU4gU0VFXG4gKiAoRDc5L0Q4NSkuKiogbWluZC1tYXBwZXIgYWRvcHRlZCB0aGlzIG1vZHVsZSBpbiBQaGFzZSA3IGFuZCBrZXB0IGl0c1xuICogZ3VhcmFudGVlIFdJVEhPVVQgQSBLSVQgQ0hBTkdFOiBpdCBwYXNzZXMgYHsgZXBvY2g6IGNyeXB0by5yYW5kb21VVUlEKCkgfWAgYXRcbiAqIGl0cyBPTkUgY29uc3RydWN0aW9uIHNpdGUgYW5kIHJlLXRpZ2h0ZW5zIGBlcG9jaGAgdG8gUkVRVUlSRUQgaW4gaXRzIG93blxuICogbG9jYWwgZnJhbWUgdHlwZSwgc28gbm90aGluZyBpdHMgYnVzIGVtaXRzIGNhbiBsYWNrIG9uZS4gS2l0IGJ5dGVzOiB6ZXJvLlxuICogKipTbyB0aGUgZXBvY2ggaXMgYSBMT1NTWS1DT1BZIHByb3BlcnR5IHdob3NlIGRpc3Bvc2l0aW9uIGlzIEtFRVAtTE9DQUwsIG5vdFxuICogUkVTVE9SRSoqIOKAlCB0aGUgb25seSBwcm9wZXJ0eSBvZiB0aGF0IHNwZWxsJ3Mgb3duIG1vZHVsZSB0aGlzIG1vZHVsZSBjb3VsZFxuICogbm90IGNhcnJ5IGFuZCBkaWQgbm90IG5lZWQgdG8uIEw2IGlzIENMT1NFRCBmb3IgdGhlIHR3byBzcGVsbHMgdGhhdCBhc2sgYW5kXG4gKiBPUEVOLCBieSBvcHQtb3V0LCBmb3IgdGhlIHRocmVlIHRoYXQgZGVjbGluZTsgdGhhdCBhc3ltbWV0cnkgaXMgdGhlIGhvbmVzdFxuICogc3RhdGUgYW5kIHRoaXMgaGVhZGluZyBpcyB3aGVyZSBpdCBpcyB3cml0dGVuLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgQURPUFRJT04gUkVOQU1FUyBBIEZJRUxEIE9OIEFOIEFET1BURVInUyBQVUJMSVNIRUQgV0lSRS4qKiBgaWRgXG4gKiBpcyBuYW1lZCBpbiBgRnJhbWU8VD5gIGFuZCBpbiB0aGUgZW1pdCBsaXRlcmFsIGJlbG93LCBzbyBhIHNwZWxsIHdob3NlIGJ1c1xuICogc3BlbGxlZCB0aGUgY3Vyc29yIGFueXRoaW5nIGVsc2UgcGF5cyBhIHJlbmFtZSBhdCBldmVyeSByZWFkZXIg4oCUIGZvclxuICogbWluZC1tYXBwZXIsIDE3MyBvY2N1cnJlbmNlcyBhY3Jvc3MgNSBzdXJmYWNlIGZpbGVzLCB+MjA5IGFjcm9zcyB+MzAgYmFja2VuZFxuICogZmlsZXMsIGV2ZXJ5IEpTT05MIGxpbmUgaXRzIGB0YWlsYCB3cml0ZXMgaW50byBhbiBhZ2VudCdzIHBpcGUsIGFuZCAodGhlIG9uZVxuICogbm9ib2R5IGNvdW50ZWQpIHRoZSBGSVhUVVJFIGluIGl0cyBvd24gYHRhaWwudGVzdC50c2AsIHdoaWNoIFdSSVRFUyB0aGVcbiAqIGVudmVsb3BlIHdoaWxlIHN0YW5kaW5nIGluIGZvciB0aGUgZGFlbW9uLiBUaGUgTkVTVElORyBpcyBub3QgZm9yY2VkIOKAlFxuICogYEZyYW1lPFQ+YCBpcyBnZW5lcmljLCBhbmQgbWluZC1tYXBwZXIga2VwdCBge2tpbmQsIHBheWxvYWR9YCBuZXN0ZWQgd2hlcmUgYWxsXG4gKiBmaXZlIGVhcmxpZXIgYWRvcHRlcnMgZmxhdHRlbiBieSBpZGlvbS4gKipBbiBpZGlvbSBmaXZlIHNpYmxpbmdzIHNoYXJlIGlzXG4gKiBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgY29udHJhY3QgdW50aWwgeW91IG9wZW4gdGhlIHR5cGUqKiAoRDgxLCBEODYpLlxuICpcbiAqICoqMSDCtyBMNSDigJQgdGhlIGJ1ZmZlciBpcyBib3VuZGVkLioqIEZpdmUgZGFlbW9ucyBhcHBlbmQgdG8gYW4gYXJyYXkgZm9yIHRoZVxuICogd2hvbGUgbGlmZSBvZiB0aGUgcHJvY2Vzcy4gVGhlIHdpbmRvdyBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogZGFlbW9uJ3MgbGlmZXRpbWUsIG5vdCBhIGR1cmFibGUgbG9nOyBhIGNhcCBpcyB0aGUgaG9uZXN0IHNoYXBlLlxuICpcbiAqICoqMiDCtyBMNiDigJQgYSBmcmFtZSBjYXJyaWVzIGFuIGVwb2NoLCBXSEVOIFRIRSBDQUxMRVIgQVNLUyBGT1IgT05FIChvcHQtaW4sXG4gKiBub3QgY29uc3RydWN0aW9uIOKAlCBzZWUgYWJvdmUpLioqIEFmdGVyIGEgcmVzdGFydCB0aGUgaWRzIHN0YXJ0IGFnYWluIGF0IDEsIHNvXG4gKiBhIHJlc3VtaW5nIGNsaWVudCBjYW5ub3QgdGVsbCBhIHN0YWxlIHdhdGVybWFyayBmcm9tIGEgZnJlc2ggb25lIGJ5IGlkIGFsb25lLlxuICpcbiAqICoqMyDCtyBBIFNUQUxFIFdBVEVSTUFSSyBSRVBMQVlTIEZST00gVEhFIEJFR0lOTklORywgYW5kIHRoaXMgaXMgdGhlIGhhbGYgdGhlXG4gKiBjbGllbnQgY2Fubm90IGRvLioqIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogYSB0YWlsIHRoYXQgcmVzdW1lcyBhdFxuICogYHNpbmNlPTxsYXN0IGlkIG9mIHRoZSBwcmV2aW91cyBkYWVtb24+YCBhZ2FpbnN0IGEgcmVzdGFydGVkIGRhZW1vbiByZWNlaXZlc1xuICogTk9USElORyDigJQgdGhlIG5ldyBkYWVtb24ncyBgcmVhZHlgIGlzIGlkIDEsIHdoaWNoIGlzIG5vdCBgPiBzaW5jZWAsIHNvIHRoZVxuICogZmlsdGVyIGRyb3BzIGl0LCBzbyBubyBmcmFtZSBhcnJpdmVzLCBzbyB0aGUgY2xpZW50J3MgZXBvY2ggY2hlY2sgbmV2ZXIgcnVuc1xuICogYW5kIHRoZSB0YWlsIHNpdHMgY29ubmVjdGVkIGFuZCBzaWxlbnQgdW50aWwgdGhlIG5ldyBkYWVtb24gaGFzIGVtaXR0ZWQgYXNcbiAqIG1hbnkgZXZlbnRzIGFzIHRoZSBvbGQgb25lIGRpZC4gU3RhbXBpbmcgYW4gZXBvY2ggYWxvbmUgZG9lcyBOT1QgY2xvc2UgdGhhdFxuICogZ2FwOiB0aGUgZXBvY2ggcmlkZXMgYSBmcmFtZSwgYW5kIHRoZSBidWcgaXMgdGhhdCBubyBmcmFtZSBpcyBzZW50LiBTb1xuICogYHN1YnNjcmliZWAgdHJlYXRzIGBzaW5jZSA+IGN1cnNvcmAgYXMgXCJ0aGlzIGN1cnNvciBpcyBmcm9tIGFub3RoZXIgcHJvY2Vzc1wiXG4gKiBhbmQgcmVwbGF5cyB3aG9sZS4gYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3RhaWwudGVzdC50c2AncyBlcG9jaCBjZWxsIGlzIHRoZVxuICogZXhlY3V0YWJsZSBzcGVjIG9mIHRoZSBjbGllbnQgaGFsZiBhbmQgc2hvd3MgdGhlIHJlY29ubmVjdCBzdGlsbCBjYXJyeWluZyB0aGVcbiAqIHN0YWxlIGN1cnNvciDigJQgZGV0ZWN0aW9uIGhhcHBlbnMgb24gd2hhdCBpcyBSRUNFSVZFRC5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBET0VTIE5PVCBBRE9QVCBUSElTLCBBTkQgVEhFIFJFRlVTQUwgSVMgUEFSVCBPRiBUSEUgUlVMSU5HIOKUgOKUgFxuICpcbiAqIFJFSkVDVC1TVFJVQ1RVUkFMLCBydWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLiBOb3RcbiAqIFwibm8gc3ViamVjdFwiIOKAlCBncmFwZXZpbmUgSEFTIGFuIGV2ZW50IGJ1cyBhbmQgaXQgaXMgdGhlIGJ1c2llc3QgdGhpbmcgaW4gdGhlXG4gKiBzcGVsbCDigJQgYnV0IHRoZSB0d28gc2hhcGVzIGNhbm5vdCBiZSBjb25zdHJ1Y3RlZCBmcm9tIGVhY2ggb3RoZXI6XG4gKlxuICogICB0aGlzIG1vZHVsZSAgb25lIHByb2Nlc3Mtd2lkZSBhcnJheSBjYXBwZWQgYXQgUkVQTEFZX0JVRkZFUl9TSVpFLCB3aXRoIG9uZVxuICogICAgICAgICAgICAgICAgbW9ub3RvbmljIGBzZXFgLCBhbmQgdGhlIGhlYWRlciB0aHJlZSBwYXJhZ3JhcGhzIHVwIHNheXMgaW4gYXNcbiAqICAgICAgICAgICAgICAgIG1hbnkgd29yZHMgdGhhdCBpdCBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogICAgICAgICAgICAgICAgZGFlbW9uJ3MgbGlmZXRpbWUsIE5PVCBhIGR1cmFibGUgbG9nLlxuICogICBncmFwZXZpbmUgICAgTiBkdXJhYmxlIGFwcGVuZC1vbmx5IGAuanNvbmxgIGZpbGVzLCBvbmUgcGVyIG5hbWVkIGNoYW5uZWwsXG4gKiAgICAgICAgICAgICAgICBlYWNoIHdpdGggaXRzIG93biBgbmV4dF9pZGAsIHJlcGxheWVkIGZyb20gZGlzayBieVxuICogICAgICAgICAgICAgICAgYHJlYWRCYWNrbG9nYCwgc3Vydml2aW5nIHJlc3RhcnQsIGByb2xsYCwgYXJjaGl2ZSBhbmQgY2xlYXIuXG4gKlxuICogKipUaGUgcmVhZGVyIHRoYXQgbWFrZXMgdGhlbSBpbmNvbXBhdGlibGUsIGFzIGEgbWVhc3VyZW1lbnQgcmF0aGVyIHRoYW4gYW5cbiAqIGFzc2VydGlvbjoqKiBncmFwZXZpbmUncyBgbG9hZENoYW5uZWwoKWAgZGVyaXZlcyBgbmV4dF9pZGAgYXMgYSBISUdILVdBVEVSXG4gKiBNQVJLIG92ZXIgZXZlcnkgcGFyc2VhYmxlIGxpbmUgb2YgdGhlIGNoYW5uZWwncyBmaWxlIG9uIGJvb3QuIFRoZXJlIGlzIG5vXG4gKiBhcnJheSB0byBiZSB0aGF0IG1hcmsgb2YsIGFuZCBubyBjYXAgdGhhdCB3b3VsZCBub3Qgc2lsZW50bHkgZGlzY2FyZCBoaXN0b3J5XG4gKiBhIGNhbGxlciBjYW4gc3RpbGwgYXNrIGZvciBieSBpZC4gSXQgaXMgdGhlIHRoaW5nIHRoaXMgbW9kdWxlJ3Mgb3duIGhlYWRlclxuICogc2F5cyBpdCBpcyBkZWxpYmVyYXRlbHkgbm90LlxuICpcbiAqICoqVGhlIHdpZGVuaW5nIE5PVCBkb25lLCB3aXRoIGl0cyBjb3N0OioqIGFkbWl0dGluZyBhIHBlci1jaGFubmVsIGR1cmFibGVcbiAqIHN0b3JlIHdvdWxkIGNoYW5nZSBgY3JlYXRlRXZlbnRMb2dgJ3Mgc3RvcmFnZSBhbmQgaXRzIGBzdWJzY3JpYmVgIGNvbnRyYWN0IGZvclxuICogZml2ZSBvdGhlciBkYWVtb25zLCByZS1lbWl0dGluZyBTSVggYXJ0aWZhY3RzIGFjcm9zcyBGSVZFIHNwZWxscywgZWFjaCBvd2VkIGFcbiAqIGRyaXZlIOKAlCBwYWlkIGJ5IHBvcnRzIHRoYXQgYXJlIGFscmVhZHkgZmluaXNoZWQgYW5kIGJ5IGFnZW50cyBub3QgaW4gdGhlIHJvb20uXG4gKiBBIHdpZGVuaW5nIHJlbWFpbnMgYXZhaWxhYmxlIGFzIGl0cyBvd24gYXJndWVkIGRlY2lzaW9uIHdpdGggaXRzIG93blxuICogYmxhc3QtcmFkaXVzIGNvdW50OyBpdCBpcyBuZXZlciBhIHN0ZXAgaW5zaWRlIGEgcG9ydC5cbiAqXG4gKiDimqAgQU5EIFRIRSBgZXBvY2hgIEFCT1ZFIElTIFRIRSBTSEFSUEVTVCBIQUxGIE9GIFdIWSAoRDcwKS4gR3JhcGV2aW5lJ3MgaWRzIGFyZVxuICogUkVDT1ZFUkVEIGFjcm9zcyBhIHJlc3RhcnQsIHNvIHRoZSBjb25kaXRpb24gcGFyYWdyYXBoIDIgZGVzY3JpYmVzIOKAlCBpZHNcbiAqIHN0YXJ0aW5nIGFnYWluIGF0IDEg4oCUIGNhbm5vdCBvY2N1ciB0aGVyZSwgYW5kIHN0YW1waW5nIG9uZSBhbnl3YXkgaXMgbm90XG4gKiBpbmVydDogYHRhaWxFdmVudHNgJ3MgYG9uRXBvY2hDaGFuZ2VgIHNldHMgdGhlIGN1cnNvciB0byAwLCBhbmQgZ3JhcGV2aW5lJ3NcbiAqIHRhaWwgcm91dGUgYW5zd2VycyBgc2luY2U9MGAgd2l0aCB0aGUgV0hPTEUgY2hhbm5lbCBsb2cgb2ZmIGRpc2ssIGludG8gYW5cbiAqIGFnZW50J3MgcGlwZSwgb24gZXZlcnkgYHJvbGxgLiBUaGUgZXBvY2gncyBjbGllbnQtc2lkZSBhY3Rpb24gaXMgXCJ5b3VyIGN1cnNvclxuICogaXMgd29ydGhsZXNzLCBzdGFydCBvdmVyXCIsIGFuZCB0aGF0IGlzIHNhZmUgb25seSB3aGVyZSBzdGFydGluZyBvdmVyIGNvc3RzIGFcbiAqIGJvdW5kZWQgaW4tbWVtb3J5IHJlcGxheSB3aW5kb3cuXG4gKi9cblxuLyoqIFRoZSBkZWZhdWx0IHJlcGxheSB3aW5kb3csIGluaGVyaXRlZCBmcm9tIG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgY2FwLiAqL1xuZXhwb3J0IGNvbnN0IFJFUExBWV9CVUZGRVJfU0laRSA9IDEwMDA7XG5cbi8qKiBBIGZyYW1lIGFzIGl0IGdvZXMgb24gdGhlIHdpcmU6IHRoZSBjYWxsZXIncyBwYXlsb2FkIHBsdXMgYSBtb25vdG9uaWMgYGlkYCxcbiAqICBwbHVzIGFuIGBlcG9jaGAgd2hlbiB0aGUgbG9nIHdhcyBnaXZlbiBvbmUuICovXG5leHBvcnQgdHlwZSBGcmFtZTxUPiA9IFQgJiB7IGlkOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH07XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRMb2c8VD4ge1xuICAvKiogQXBwZW5kIG9uZSBmcmFtZSwgZmFuIGl0IG91dCB0byBsaXZlIHN1YnNjcmliZXJzLCBhbmQgcmV0dXJuIGl0LiAqL1xuICBlbWl0KG1zZzogVCk6IEZyYW1lPFQ+O1xuICAvKipcbiAgICogUmVwbGF5IGV2ZXJ5dGhpbmcgYWZ0ZXIgYHNpbmNlYCwgdGhlbiBzdGF5IHN1YnNjcmliZWQuIFJldHVybnMgYW5cbiAgICogdW5zdWJzY3JpYmUgZnVuY3Rpb24uXG4gICAqXG4gICAqIOKblCBSRVBMQVkgQU5EIFNVQlNDUklCRSBBUkUgT05FIENBTEwgT04gUFVSUE9TRS4gRG9pbmcgdGhlbSBpbiB0d28gc3RlcHNcbiAgICogbGVhdmVzIGEgd2luZG93IGluIHdoaWNoIGFuIGVtaXQgbGFuZHMgYmV0d2VlbiB0aGUgcmVwbGF5IGxvb3AgYW5kIHRoZVxuICAgKiBgYWRkYCwgYW5kIHRoYXQgZnJhbWUgaXMgZGVsaXZlcmVkIHRvIG5vYm9keSDigJQgdGhlIHNoYXBlIGZpdmUgZGFlbW9ucyBoYXZlLFxuICAgKiBzdXJ2aXZlZCBieSBub3RoaW5nIGJ1dCB0aGUgc2luZ2xlLXRocmVhZGVkIGV2ZW50IGxvb3AgaGFwcGVuaW5nIHRvIGNsb3NlXG4gICAqIGl0LiBEZXBlbmRpbmcgb24gdGhhdCBpcyBkZXBlbmRpbmcgb24gYW4gaW1wbGVtZW50YXRpb24gZGV0YWlsIG9mIHRoZVxuICAgKiBydW50aW1lIHJhdGhlciB0aGFuIG9uIHRoZSBjb2RlLlxuICAgKi9cbiAgc3Vic2NyaWJlKHNpbmNlOiBudW1iZXIsIGxpc3RlbmVyOiAoZnJhbWU6IEZyYW1lPFQ+KSA9PiB2b2lkKTogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBoaWdoZXN0IGlkIGVtaXR0ZWQgc28gZmFyIOKAlCB3aGF0IGBHRVQgL3N0YXRlYCByZXR1cm5zIGFzIGBjdXJzb3JgLiAqL1xuICBjdXJzb3IoKTogbnVtYmVyO1xuICAvKiogVGhlIGVwb2NoIHN0YW1wZWQgb24gZXZlcnkgZnJhbWUsIG9yIGB1bmRlZmluZWRgIGlmIG5vbmUgd2FzIGNvbmZpZ3VyZWQuICovXG4gIHJlYWRvbmx5IGVwb2NoOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVFdmVudExvZzxUIGV4dGVuZHMgb2JqZWN0PihcbiAgb3B0czogeyBlcG9jaD86IHN0cmluZzsgYnVmZmVyU2l6ZT86IG51bWJlciB9ID0ge30sXG4pOiBFdmVudExvZzxUPiB7XG4gIGNvbnN0IGJ1ZmZlclNpemUgPSBvcHRzLmJ1ZmZlclNpemUgPz8gUkVQTEFZX0JVRkZFUl9TSVpFO1xuICBjb25zdCBlcG9jaCA9IG9wdHMuZXBvY2g7XG4gIGNvbnN0IGJ1ZmZlcjogQXJyYXk8RnJhbWU8VD4+ID0gW107XG4gIGNvbnN0IGxpc3RlbmVycyA9IG5ldyBTZXQ8KGZyYW1lOiBGcmFtZTxUPikgPT4gdm9pZD4oKTtcbiAgbGV0IHNlcSA9IDA7XG5cbiAgcmV0dXJuIHtcbiAgICBlcG9jaCxcblxuICAgIGVtaXQobXNnKSB7XG4gICAgICBzZXEgKz0gMTtcbiAgICAgIC8vIOKblCBUSEUgTU9OT1RPTklDIElEIFdJTlMgT1ZFUiBBTllUSElORyBJTiBUSEUgUEFZTE9BRCwgQU5EIFVOVElMIE5PVyBJVFxuICAgICAgLy8gT05MWSBDTEFJTUVEIFRPLiBCb3RoIGFkb3B0aW5nIGRhZW1vbnMgd3JvdGUgYHsgaWQ6ICsrc2VxLCAuLi5tc2cgfWBcbiAgICAgIC8vIHVuZGVyIGEgY29tbWVudCBzYXlpbmcgXCJ0aGUgbW9ub3RvbmljIGBpZGAgTVVTVCB3aW4gb3ZlciBhbnkgYGlkYCBpblxuICAgICAgLy8gdGhlIHBheWxvYWQsIHNvIGNhbGxlcnMgY2FycnkgYSBwcm9qZWN0IGlkZW50aWZpZXIgYXMgYHByb2plY3RJZGAsXG4gICAgICAvLyBuZXZlciBgaWRgXCIg4oCUIGJ1dCBzcHJlYWQgb3JkZXIgbWVhbnMgYSBwYXlsb2FkIGBpZGAgb3ZlcnJvZGUgdGhlXG4gICAgICAvLyBjdXJzb3IsIHNpbGVudGx5LCBhbmQgdGhlIGNvbnZlbnRpb24gaW4gdGhlIGNvbW1lbnQgd2FzIHRoZSBvbmx5IHRoaW5nXG4gICAgICAvLyBob2xkaW5nIGl0LiBUaGUgbGl0ZXJhbCBrZWVwcyBgaWRgIEZJUlNUIHNvIHRoZSB3aXJlIGtleSBvcmRlciBpc1xuICAgICAgLy8gdW5jaGFuZ2VkOyB0aGUgYXNzaWdubWVudCBhZnRlciB0aGUgc3ByZWFkIGlzIHdoYXQgbWFrZXMgdGhlIHNlbnRlbmNlXG4gICAgICAvLyB0cnVlLiBgZXBvY2hgIGlzIHN0YW1wZWQgdGhlIHNhbWUgd2F5IGFuZCBmb3IgdGhlIHNhbWUgcmVhc29uLlxuICAgICAgY29uc3QgZnJhbWUgPSB7IGlkOiBzZXEsIC4uLm1zZyB9IGFzIEZyYW1lPFQ+O1xuICAgICAgZnJhbWUuaWQgPSBzZXE7XG4gICAgICBpZiAoZXBvY2ggIT09IHVuZGVmaW5lZCkgZnJhbWUuZXBvY2ggPSBlcG9jaDtcblxuICAgICAgYnVmZmVyLnB1c2goZnJhbWUpO1xuICAgICAgaWYgKGJ1ZmZlci5sZW5ndGggPiBidWZmZXJTaXplKSBidWZmZXIuc2hpZnQoKTtcbiAgICAgIGZvciAoY29uc3QgbGlzdGVuZXIgb2YgbGlzdGVuZXJzKSBsaXN0ZW5lcihmcmFtZSk7XG4gICAgICByZXR1cm4gZnJhbWU7XG4gICAgfSxcblxuICAgIHN1YnNjcmliZShzaW5jZSwgbGlzdGVuZXIpIHtcbiAgICAgIC8vIFNlZSB0aGUgaGVhZGVyLCBwb2ludCAzOiBhIGN1cnNvciBiZXlvbmQgb3VyIG93biBpcyBhIGN1cnNvciBmcm9tIGFcbiAgICAgIC8vIFBSSU9SIFBST0NFU1MsIGFuZCB0aGUgb25seSB1c2VmdWwgcmVhZGluZyBvZiBpdCBpcyBcInJlcGxheSB3aG9sZVwiLlxuICAgICAgLy9cbiAgICAgIC8vIOKaoCBBIE5PTi1GSU5JVEUgQ1VSU09SIEFMU08gTUVBTlMgXCJGUk9NIFRIRSBTVEFSVFwiLCB3aGljaCB0aGUgY29waWVzIGdvdFxuICAgICAgLy8gd3JvbmcgYnkgYWNjaWRlbnQ6IHRoZXkgd3JvdGUgYHBhcnNlSW50KHBhcmFtID8/IFwiLTFcIilgIGFuZCBjb21wYXJlZFxuICAgICAgLy8gYGlkID4gc2luY2VgLCBzbyBhIHR5cG8nZCBgP3NpbmNlPXhgIHByb2R1Y2VkIGBOYU5gLCBldmVyeSBjb21wYXJpc29uXG4gICAgICAvLyB3YXMgZmFsc2UsIGFuZCB0aGUgdGFpbCBvcGVuZWQgRU1QVFkgYW5kIHN0YXllZCBjb25uZWN0ZWQg4oCUIHRoZSBzYW1lXG4gICAgICAvLyBzaWxlbnQtYW5kLWNvbm5lY3RlZCBzeW1wdG9tIGFzIHRoZSBzdGFsZSB3YXRlcm1hcmssIGZyb20gYSBkaWZmZXJlbnRcbiAgICAgIC8vIGNhdXNlLiBBYnNlbnQgYW5kIHVucGFyc2VhYmxlIGFyZSB0aGUgc2FtZSByZXF1ZXN0IGhlcmUuXG4gICAgICBjb25zdCBmcm9tID0gIU51bWJlci5pc0Zpbml0ZShzaW5jZSkgfHwgc2luY2UgPiBzZXEgPyAtMSA6IHNpbmNlO1xuICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBidWZmZXIpIHtcbiAgICAgICAgaWYgKGZyYW1lLmlkID4gZnJvbSkgbGlzdGVuZXIoZnJhbWUpO1xuICAgICAgfVxuICAgICAgbGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG4gICAgICByZXR1cm4gKCkgPT4ge1xuICAgICAgICBsaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcbiAgICAgIH07XG4gICAgfSxcblxuICAgIGN1cnNvcigpIHtcbiAgICAgIHJldHVybiBzZXE7XG4gICAgfSxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgZGFlbW9uIGxpZmVjeWNsZSB0YWlsOiB0aGUgaWRsZS1jbG9zZSBkZWNpc2lvbiwgdGhlIHN3ZWVwXG4gKiB0aGF0IG1ha2VzIGl0LCBhbmQgdGhlIGJvdW5kZWQgdGVhcmRvd24uXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgYm91bnR5IOKAlCB0aGUgY2Vuc3VzJ3NcbiAqIGNvbnZlcmdlbmNlIHRhcmdldCAjMyDigJQgd2l0aCBhc3Ryb2xhYmUncyBgdGltZW91dE1zID4gMGAgZ3VhcmQgZm9sZGVkIGluLFxuICogd2hpY2ggaXMgdGhlIG9uZSB0aGluZyBib3VudHkncyBjb3B5IGRvZXMgbm90IGV4cHJlc3MuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgQURPUFRTIGBkcmFpbkFuZFN0b3BgIEFORCBOT1RISU5HIEVMU0UgSEVSRSDigJQgU1BMSVQgUEVSIEVYUE9SVFxuICpcbiAqIFJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCksIGFuZCBpdCBpcyB3cml0dGVuIGRvd25cbiAqIGJlY2F1c2UgYSByb3cgaXMgYSBNT0RVTEUgYW5kIFwicGFydGlhbFwiIGlzIG5vdCBhbiBhbnN3ZXIgdW50aWwgaXQgc2F5cyB3aGljaFxuICogZXhwb3J0cy4gR3JhcGV2aW5lIGlzIGxvbmctcnVubmluZywgc28gbm90aGluZyBhYm91dCBpdHMgbGlmZWN5Y2xlIG1ha2VzIHRoaXNcbiAqIG1vZHVsZSByZWFkIGFzIGluYXBwbGljYWJsZSDigJQgYW5kIHR3byBvZiBpdHMgdGhyZWUgZXhwb3J0cyBzdGlsbCBoYXZlIG5vXG4gKiBzdWJqZWN0IHRoZXJlOlxuICpcbiAqICAgYHNob3VsZElkbGVDbG9zZWAgICAgICBOTyBTVUJKRUNULiBHcmFwZXZpbmUgcnVucyBubyBpZGxlIHN3ZWVwIGFuZCBoYXMgbm9cbiAqICAgYHN0YXJ0SG91c2VrZWVwaW5nYCAgICBgLS10aW1lb3V0YDsgaXQgaXMgYSBicm9rZXIgdGhhdCBzdGFuZHMgdW50aWwgYHN0b3BgXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgKGBERUxFVEUgL2ApIG9yIGEgc2lnbmFsLCBhbmQgaXQgdGFrZXMgbm8gc25hcHNob3QuXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgQWRvcHRpbmcgdGhlIHBhaXItbWFuYWdlciB3b3VsZCBtZWFuIHdyaXRpbmcgYSBuby1vcFxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGB0b3VjaGAgYW5kIGEgYHN1YnNjcmliZXJDb3VudGAgdGhhdCBleGlzdHMgb25seSB0b1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBhIG51bWJlciBub2JvZHkgYWN0cyBvbiDigJQgdHdvIGxpZXMgdG8gZ2FpbiBhXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYGNsZWFySW50ZXJ2YWxgLlxuICogICBgZHJhaW5BbmRTdG9wYCAgICAgICAgIEFET1BURUQsIGFuZCBpdCBpcyBhIERFLURVUExJQ0FUSU9OIHJhdGhlciB0aGFuIGFcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBnYWluOiBncmFwZXZpbmUncyB0ZWFyZG93biBhbHJlYWR5IFdBU1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBQcm9taXNlLnJhY2UoW3NlcnZlci5zdG9wKHRydWUpLCAyMDAgbXNdKWAsIHdoaWNoIGlzXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYHN0b3BNc2AgZXhhY3RseS5cbiAqXG4gKiDimqAgKipBTkQgSVQgSVMgQ0FMTEVEIFdJVEggTk8gYGNsaWVudHNgLCBXSElDSCBJUyBBIE1FQVNVUkVNRU5ULCBOT1QgQU5cbiAqIE9WRVJTSUdIVC4qKiBUaGlzIG1vZHVsZSBjbG9zZXMgYSBoZWxkIGNvbm5lY3Rpb24gYnkgY2FsbGluZyBgY2xpZW50LmNsb3NlKClgO1xuICogZ3JhcGV2aW5lJ3Mgc3Vic2NyaWJlciByZWNvcmRzIGFyZSBge2FsaWFzLCBodW1hbiwgbHVyaywgc2VuZH1gIGFuZCBjYXJyeSBub1xuICogYGNsb3NlYCDigJQgaXRzIHBlci1zdHJlYW0gdGVhcmRvd24gaXMgYSBjbG9zdXJlIHN0YXNoZWQgb24gdGhlIFJlYWRhYmxlU3RyZWFtXG4gKiBjb250cm9sbGVyLCByZWFjaGFibGUgb25seSBmcm9tIGBjYW5jZWwoKWAuIFRoZXJlIGlzIG5vdGhpbmcgdG8gaGFuZCB0aGVcbiAqIGFyZ3VtZW50LiBgc3NlLnRzYCdzIGhlYWRlciBjYXJyaWVzIHRoZSByZXN0IG9mIHRoYXQgcnVsaW5nLCBpbmNsdWRpbmcgdGhlXG4gKiB3aWRlbmluZyBub3QgZG9uZSBhbmQgaXRzIGNvc3QgKHNpeCBhcnRpZmFjdHMgYWNyb3NzIGZpdmUgc3BlbGxzKS5cbiAqXG4gKiDimqAgR3JhcGV2aW5lIGFsc28gcGFzc2VzIGBncmFjZU1zOiAwYC4gTm90IGEgZGlzYWdyZWVtZW50IHdpdGggdGhlIGdyYWNlXG4gKiBwZXJpb2Q6IGl0IGVtaXRzIG5vIGZhcmV3ZWxsIGZyYW1lIGF0IGRhZW1vbiBzaHV0ZG93biwgYW5kIGl0cyBgREVMRVRFIC9gXG4gKiBhbHJlYWR5IHJldHVybnMgdGhlIHJlc3BvbnNlIGFuZCBzY2hlZHVsZXMgdGhlIHRlYXJkb3duIDEwIG1zIGxhdGVyLCBzbyBpdHNcbiAqIGZsdXNoIHdpbmRvdyBzaXRzIGF0IHRoZSByb3V0ZSByYXRoZXIgdGhhbiBpbiB0aGUgZHJhaW4uXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTc2VDbGllbnRzIH0gZnJvbSBcIi4vc3NlLnRzXCI7XG5cbi8qKlxuICogU2hvdWxkIHRoZSBkYWVtb24gaWRsZS1jbG9zZT9cbiAqXG4gKiDim5QgKipgc3Vic2NyaWJlckNvdW50YCBJUyBBIFJFUVVJUkVEIEFSR1VNRU5ULCBBTkQgVEhBVCBJUyBUSEUgV0hPTEUgUE9JTlQuKipcbiAqIFRoaXMgY2xvc2VzIGNlbnN1cyBkZWZlY3QgKipMMSoqIGJ5IGNvbnN0cnVjdGlvbjogZ2xhbW91ciwgaW1hZ28gYW5kIG1hZ3BpZVxuICogY291bnRlZCB0aGVpciBpZGxlIGZsb29yIGRvd24gd2hpbGUgYW4gYWdlbnQgaGVsZCBhIHRhaWwgb3Blbiwgc28gYW4gYWdlbnRcbiAqIHdhdGNoaW5nIGEgcXVpZXQgYm9hcmQgd2FzIGtpbGxlZCBXSVRIIElUUyBDT05ORUNUSU9OIE9QRU4uIFRoZXJlIGlzIG5vXG4gKiBvdmVybG9hZCBvZiB0aGlzIGZ1bmN0aW9uIHRoYXQgY2Fubm90IHNlZSBpdHMgc3Vic2NyaWJlcnMsIHNvIHRoZSBkZWZlY3RcbiAqIGNhbm5vdCBiZSByZS1leHByZXNzZWQgYnkgYSBjYWxsZXIgd2hvIGZvcmdldHMuXG4gKlxuICog4puUICoqQU5EIFRIRSBTQ0FSIElUIENBTUUgV0lUSCwgcmUtaG9tZWQgZnJvbSBib3VudHkgdmVyYmF0aW0gaW4gc3Vic3RhbmNlOioqXG4gKiBhIGJvYXJkIG9ubHkgY291bnRzIGl0cyBpZGxlIGZsb29yIGRvd24gd2hpbGUgVU5XQVRDSEVELiBBIGxpdmUgc3Vic2NyaWJlciDigJRcbiAqIGEgYnJvd3NlciBXZWJTb2NrZXQsIG9yIGFuIGFnZW50IFNTRSB0YWlsIG9uIGAvZXZlbnRzYCDigJQga2VlcHMgaXQgb3BlblxuICogaW5kZWZpbml0ZWx5LiBTbyBgdGltZW91dGAgbWVhbnMgXCJsaW5nZXIgdGhpcyBsb25nIGFmdGVyIHRoZSBMQVNUIHN1YnNjcmliZXJcbiAqIGxlYXZlc1wiLCBOT1QgXCJtYXhpbXVtIGlkbGUgd2hpbGUgY29ubmVjdGVkXCIuIFRoZSBzd2VlcCBiZWxvdyBhbHNvIHRvdWNoZXMgdGhlXG4gKiBhY3Rpdml0eSBjbG9jayBvbiBldmVyeSB0aWNrIHdoaWxlIHdhdGNoZWQsIHNvIG9uY2UgdW53YXRjaGVkIHRoZSBmbG9vclxuICogY291bnRzIGZyb20gdGhhdCBsYXN0IGRpc2Nvbm5lY3QgYW5kIG5vdCBmcm9tIHRoZSBsYXN0IHJlcXVlc3QuXG4gKlxuICog4pqgIGB0aW1lb3V0TXMgPD0gMGAgbWVhbnMgTkVWRVIsIHdoaWNoIGlzIGFzdHJvbGFiZSdzIHN0YW5kaW5nLW9ic2VydmF0b3J5XG4gKiBkZWZhdWx0IGFuZCBpcyB3aHkgdGhlIGd1YXJkIGlzIGhlcmUgcmF0aGVyIHRoYW4gYXQgaXRzIG9uZSBjYWxsIHNpdGU6IGFcbiAqIHNpbmdsZXRvbiBkYWVtb24gaXMgbWVhbnQgdG8gc3RhbmQgdW50aWwgaXQgaXMgZXhwbGljaXRseSBjbG9zZWQsIGFuZCBhXG4gKiBgPj0gMGAgY29tcGFyaXNvbiB3b3VsZCBjbG9zZSBpdCBvbiB0aGUgZmlyc3QgdGljay5cbiAqXG4gKiBDbG9jay1mcmVlIGFuZCBmcy1mcmVlLCBzbyBpdCBpcyB0ZXN0YWJsZSB3aXRob3V0IGEgZGFlbW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkSWRsZUNsb3NlKFxuICBzdWJzY3JpYmVyQ291bnQ6IG51bWJlcixcbiAgaWRsZU1zOiBudW1iZXIsXG4gIHRpbWVvdXRNczogbnVtYmVyLFxuKTogYm9vbGVhbiB7XG4gIGlmICh0aW1lb3V0TXMgPD0gMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoc3Vic2NyaWJlckNvdW50ID4gMCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaWRsZU1zID49IHRpbWVvdXRNcztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBIb3VzZWtlZXBpbmdPcHRpb25zIHtcbiAgLyoqIOKblCBSRVFVSVJFRC4gU2VlIGBzaG91bGRJZGxlQ2xvc2VgIOKAlCB0aGlzIGlzIHdoYXQgY2xvc2VzIEwxLiAqL1xuICBzdWJzY3JpYmVyQ291bnQ6ICgpID0+IG51bWJlcjtcbiAgLyoqIE1pbGxpc2Vjb25kcyBzaW5jZSB0aGUgbGFzdCBhY3Rpdml0eS4gKi9cbiAgaWRsZU1zOiAoKSA9PiBudW1iZXI7XG4gIC8qKiBSZXNldCB0aGUgYWN0aXZpdHkgY2xvY2suIENhbGxlZCBvbiBldmVyeSB0aWNrIHRoYXQgaGFzIGEgc3Vic2NyaWJlci4gKi9cbiAgdG91Y2g6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgY29uZmlndXJlZCBpZGxlIHRpbWVvdXQgaW4gbXM7IGAwYCAob3IgbGVzcykgbWVhbnMgbmV2ZXIuICovXG4gIHRpbWVvdXRNczogbnVtYmVyO1xuICAvKiogRmlyZWQgb25jZSB3aGVuIHRoZSBkYWVtb24gc2hvdWxkIGNsb3NlIGl0c2VsZi4gKi9cbiAgb25JZGxlQ2xvc2U6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgZGVib3VuY2VkIHNuYXBzaG90LCBpZiB0aGUgc3BlbGwgaGFzIG9uZS4gKi9cbiAgc25hcHNob3Q/OiB7XG4gICAgZGlydHk6ICgpID0+IGJvb2xlYW47XG4gICAgY2xlYXI6ICgpID0+IHZvaWQ7XG4gICAgd3JpdGU6ICgpID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+O1xuICB9O1xuICAvKiogU3dlZXAgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDI1MCBtcy4gKi9cbiAgdGlja01zPzogbnVtYmVyO1xuICAvKiogU25hcHNob3QgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDEwMDAgbXMuICovXG4gIHNuYXBzaG90TXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogU3RhcnQgdGhlIHR3byBzdGFuZGluZyB0aW1lcnMgZXZlcnkgc2Vzc2lvbiBkYWVtb24gcnVucyDigJQgdGhlIGlkbGUgc3dlZXAgYW5kXG4gKiB0aGUgZGVib3VuY2VkIHNuYXBzaG90IOKAlCBhbmQgcmV0dXJuIHRoZSBmdW5jdGlvbiB0aGF0IHN0b3BzIGJvdGguXG4gKlxuICogVGhleSBhcmUgT05FIGNhbGwgYmVjYXVzZSB0aGV5IGhhdmUgYWx3YXlzIGJlZW4gb25lIGxpZmV0aW1lOiBldmVyeSBjb3B5XG4gKiBjbGVhcmVkIGJvdGggaW4gdGhlIHNhbWUgdHdvIGxpbmVzIGFmdGVyIGBhd2FpdCBkb25lYCwgYW5kIHRoZSBwYWlyIHRoYXQgZ2V0c1xuICogZm9yZ290dGVuIGlzIHRoZSBwYWlyIHdob3NlIHRpbWVycyBrZWVwIGEgcHJvY2VzcyBhbGl2ZSBhZnRlciB0ZWFyZG93bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0SG91c2VrZWVwaW5nKG9wdHM6IEhvdXNla2VlcGluZ09wdGlvbnMpOiAoKSA9PiB2b2lkIHtcbiAgY29uc3QgdGlja01zID0gb3B0cy50aWNrTXMgPz8gMjUwO1xuICBjb25zdCBzbmFwc2hvdE1zID0gb3B0cy5zbmFwc2hvdE1zID8/IDEwMDA7XG5cbiAgY29uc3QgaWRsZVRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIGNvbnN0IHN1YnNjcmliZXJzID0gb3B0cy5zdWJzY3JpYmVyQ291bnQoKTtcbiAgICBpZiAoc3Vic2NyaWJlcnMgPiAwKSBvcHRzLnRvdWNoKCk7XG4gICAgaWYgKHNob3VsZElkbGVDbG9zZShzdWJzY3JpYmVycywgb3B0cy5pZGxlTXMoKSwgb3B0cy50aW1lb3V0TXMpKSBvcHRzLm9uSWRsZUNsb3NlKCk7XG4gIH0sIHRpY2tNcyk7XG5cbiAgY29uc3Qgc25hcCA9IG9wdHMuc25hcHNob3Q7XG4gIGNvbnN0IHNuYXBUaW1lciA9IHNuYXBcbiAgICA/IHNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgaWYgKCFzbmFwLmRpcnR5KCkpIHJldHVybjtcbiAgICAgICAgc25hcC5jbGVhcigpO1xuICAgICAgICB2b2lkIHNuYXAud3JpdGUoKTtcbiAgICAgIH0sIHNuYXBzaG90TXMpXG4gICAgOiBudWxsO1xuXG4gIHJldHVybiAoKSA9PiB7XG4gICAgY2xlYXJJbnRlcnZhbChpZGxlVGltZXIpO1xuICAgIGlmIChzbmFwVGltZXIgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoc25hcFRpbWVyKTtcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEcmFpbk9wdGlvbnMge1xuICAvKiogVGhlIGJvdW5kIHNlcnZlci4gVHlwZWQgc3RydWN0dXJhbGx5IHNvIHRoZSBraXQgc3RheXMgZnJlZSBvZiBgYnVuYC4gKi9cbiAgc2VydmVyOiB7IHN0b3AoY2xvc2VBY3RpdmVDb25uZWN0aW9ucz86IGJvb2xlYW4pOiB1bmtub3duIH07XG4gIC8qKiBMaXZlIFNTRSB0YWlsczsgZXZlcnkgcmVnaXN0ZXJlZCBjbG9zZXIgaXMgaW52b2tlZC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBMaXZlIFdlYlNvY2tldHMuICovXG4gIHNvY2tldHM/OiBJdGVyYWJsZTx7IGNsb3NlKCk6IHZvaWQgfT47XG4gIC8qKiBIb3cgbG9uZyBxdWV1ZWQgZnJhbWVzIGdldCB0byBmbHVzaCBiZWZvcmUgYW55dGhpbmcgaXMgY2xvc2VkLiAqL1xuICBncmFjZU1zPzogbnVtYmVyO1xuICAvKiogSG93IGxvbmcgdGhlIGdyYWNlZnVsIHN0b3AgZ2V0cyBiZWZvcmUgdGVhcmRvd24gcHJvY2VlZHMgcmVnYXJkbGVzcy4gKi9cbiAgc3RvcE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIENsb3NlIGV2ZXJ5IGhlbGQgY29ubmVjdGlvbiBhbmQgc3RvcCB0aGUgc2VydmVyLCBpbiBib3VuZGVkIHRpbWUuXG4gKlxuICog4puUICoqVEhFIEdSQUNFIFBFUklPRCBJUyBOT1QgUE9MSVRFTkVTUy4qKiBBIGBjbG9zZWRgIGZyYW1lIGVtaXR0ZWQgYW5kIHRoZW5cbiAqIGZvbGxvd2VkIGltbWVkaWF0ZWx5IGJ5IGFuIGFnZ3Jlc3NpdmUgYHNlcnZlci5zdG9wKHRydWUpYCBpcyBhIGZyYW1lIHRoZVxuICogY2xpZW50IG5ldmVyIHNlZXMg4oCUIHRoZSBxdWV1ZSBnb2VzIHdpdGggdGhlIHNvY2tldC4gVGhlIDE1MCBtcyBpcyB3aGF0IHR1cm5zXG4gKiBcInRoZSBkYWVtb24gdG9sZCB5b3Ugd2h5IGl0IGRpZWRcIiBmcm9tIGEgaG9wZSBpbnRvIGFuIG9ic2VydmF0aW9uLCBhbmQgZXZlcnlcbiAqIG9uZSBvZiB0aGUgZWlnaHQgZGFlbW9ucyBjb252ZXJnZWQgb24gdGhhdCBudW1iZXIgaW5kZXBlbmRlbnRseS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNUT1AgSVMgUkFDRUQsIEJFQ0FVU0UgQSBTTE9XIFNPQ0tFVCBNVVNUIE5PVCBCRSBBQkxFIFRPIEhBTkdcbiAqIFRFQVJET1dOLioqIGBzZXJ2ZXIuc3RvcCh0cnVlKWAgYXdhaXRzIGl0cyBjb25uZWN0aW9uczsgb25lIHdlZGdlZCBwZWVyIGlzXG4gKiBlbm91Z2ggdG8gcGFyayBpdCBmb3JldmVyLCB3aGljaCBpcyBob3cgYSAyMy1taW51dGUgaGFuZyBzaGlwcGVkIG9uY2UuXG4gKlxuICog4pqgICoqV0hBVCBJUyBERUxJQkVSQVRFTFkgTk9UIEhFUkU6IGJvdW50eSdzIHNodXRkb3duIHdhdGNoZG9nLioqIEJvdW50eSBhcm1zXG4gKiBhIFJFRidkIGBzZXRUaW1lb3V0YCB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGlmIHRlYXJkb3duIGRvZXMgbm90IGZpbmlzaCxcbiAqIGFuZCB0aGUgY2Vuc3VzIGlzIHJpZ2h0IHRoYXQgaXQgaXMgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbFxuICogdGVybWluYXRpb24gZ3VhcmFudGVlLiBJdCBiZWxvbmdzIHRvIGJvdW50eSdzIFRFQVJET1dOIOKAlCB0aGUgc3RyZXRjaCB3aGVyZVxuICogbm90aGluZyBib3VuZHMgd2hhdCBpcyBiZWluZyB3YWl0ZWQgb24uIOKblCAqKlRISVMgUEFSQUdSQVBIIFNBSUQgXCJTSUdOQUxcbiAqIFBBVEhcIiBVTlRJTCBENTMsIEFORCBUSEUgQ09ERSBBR1JFRUQgV0lUSCBJVCwgV0hJQ0ggV0FTIFRIRSBERUZFQ1QuKiogQm91bnR5XG4gKiBoYXMgRk9VUiB3YXlzIGludG8gb25lIHRlYXJkb3duIChhIHNpZ25hbCwgYSBgY2xvc2VgIHZlcmIsIHRoZSBicm93c2VyJ3NcbiAqIGNsb3NlIG92ZXIgdGhlIFdlYlNvY2tldCwgYW4gaWRsZSB0aW1lb3V0KSBhbmQgb25seSB0aGUgc2lnbmFsIG9uZSBhcm1lZCB0aGVcbiAqIHRpbWVyLCB3aGlsZSB0aGUgY29tbWVudCBhYm92ZSBpdCBjbGFpbWVkIHRoZSBlbmRpbmcgd2FzIHVuY29uZGl0aW9uYWwuXG4gKiBEcml2ZW4gd2l0aCBhIHBsYW50ZWQgaGFuZzogdGhlIG90aGVyIHRocmVlIHJhbiBwYXN0IDEwIHMsIHRoZSBpZGxlIG9uZVxuICogaW5jbHVkZWQg4oCUIHRoZSBvcnBoYW4tZGFlbW9uIGNsYXNzIHRoZSAyMy1taW51dGUgaGFuZyBjYW1lIGZyb20uIFRoZSBhcm1pbmdcbiAqIG5vdyBsaXZlcyBpbiB0aGUgUkVTT0xWRSB0aGF0IGFsbCBmb3VyIGVudHJpZXMgcGFzcyB0aHJvdWdoLiAqKlRoZSBsZXNzb24gZm9yXG4gKiBhbiBhZG9wdGVyIGlzIHRoZSBjb3VudCwgbm90IHRoZSBwbGFjZW1lbnQ6IGVudW1lcmF0ZSBldmVyeSBlbnRyeSBpbnRvIHRoZVxuICogdGVhcmRvd24gYmVmb3JlIHlvdSBiZWxpZXZlIGEgZ3VhcmFudGVlIGNvdmVycyBpdC4qKiBUaGUgdHdvXG4gKiBkYWVtb25zIGFkb3B0aW5nIHRoaXMgbW9kdWxlIHJlZ2lzdGVyIG5vIHNpZ25hbCBoYW5kbGVycywgYW5kIHRoZWlyIHdob2xlXG4gKiB0ZWFyZG93biBpcyBib3VuZGVkIGJ5IHRoZSB0d28gbnVtYmVycyBhYm92ZTsgYWRkaW5nIGFuIGV4aXQgaGVyZSB3b3VsZCBwdXRcbiAqIHRoZSBob3VzZSdzIG9ubHkgdW5jb25kaXRpb25hbCBgcHJvY2Vzcy5leGl0YCBpbnNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgaXNcbiAqIGFib3V0IHRvIGJ1bmRsZSwgb25lIHBoYXNlIGFmdGVyIEQ4IHRvb2sgZXhhY3RseSB0aGF0IGhhemFyZCBPVVQgb2YgYGRpZWAuXG4gKlxuICog4puUICoqQU5EIFRIRSBTRU5URU5DRSBUSEFUIFVTRUQgVE8gRU5EIFRIQVQgUEFSQUdSQVBIIFdBUyBBIFBSRURJQ1RJT04sIFdISUNIXG4gKiBCT1VOVFknUyBPV04gUE9SVCBGQUxTSUZJRUQuKiogSXQgcmVhZDogXCJ3aGVuIGEgc3BlbGwgd2l0aCBhIHNpZ25hbCBwYXRoXG4gKiBhZG9wdHMgdGhpcywgdGhlIHdhdGNoZG9nIGFycml2ZXMgYXMgYW4gb3B0aW9uIG9uIHRoZXNlIGFyZ3VtZW50cyBhbmQgdGhlXG4gKiByZWFzb25pbmcgaXMgYWxyZWFkeSB3cml0dGVuIGRvd24uXCIgYm91bnR5IGFkb3B0ZWQgYGRyYWluQW5kU3RvcGAgb25cbiAqIDIwMjYtMDktMDkgKFBoYXNlIDQpIGFuZCB0aGUgb3B0aW9uIHdhcyBOT1QgYWRkZWQsIGJlY2F1c2UgdGhlIHdpbmRvdyBpc1xuICogd3JvbmcuICoqQSBgd2F0Y2hkb2dNc2Agb24gdGhlc2UgYXJndW1lbnRzIHdvdWxkIGFybSBhdCBEUkFJTiB0aW1lOyBib3VudHknc1xuICogYXJtcyBhdCBTSUdOQUwgdGltZSoqLCBhbmQgdGhlIHdob2xlIHJlYXNvbiBpdCBleGlzdHMgaXMgdGhlIHN0cmV0Y2ggQkVUV0VFTlxuICogdGhvc2UgdHdvIHBvaW50cyDigJQgYGF3YWl0IGRvbmVgLCBhbiBmcyBhcHBlbmQgdG8gdGhlIGRhZW1vbiBsb2csIGEgZnVsbFxuICogc25hcHNob3Qgd3JpdGUgdGhhdCBjYW4gcm90YXRlIGFuZCBDT1BZIGEgYmFja3VwIG9mIGEgbGFyZ2UgYm9hcmQsIGEgYGNsb3NlZGBcbiAqIGZyYW1lIGFuZCBhIGJyb2FkY2FzdC4gYGRyYWluQW5kU3RvcGAncyBvd24gYm9keSBpcyBhbHJlYWR5IGJvdW5kZWQgYnkgdGhlIHR3b1xuICogbnVtYmVycyBhYm92ZSwgc28gYSB3YXRjaGRvZyBzY29wZWQgdG8gaXQgd291bGQgZ3VhcmQgdGhlIG9uZSBzdHJldGNoIHRoYXRcbiAqIGNhbm5vdCBoYW5nIGFuZCBhYmFuZG9uIHRoZSBzdHJldGNoIHRoYXQgY2FuOiBpdCB3b3VsZCBSRUFEIGFzIGFkb3B0aW9uIGFuZFxuICogQkUgYSBuYXJyb3dpbmcgb2YgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbCB0ZXJtaW5hdGlvbiBndWFyYW50ZWUuIFRoZVxuICogMjMtbWludXRlIGhhbmcgdGhpcyBwcm9qZWN0IGtlZXBzIGNpdGluZyBoYXBwZW5lZCBpbiB0aGUgdW5ib3VuZGVkIHN0cmV0Y2guXG4gKlxuICog4pqgICoqU08gVEhFIFJVTEUgRk9SIFRIRSBORVhUIFNQRUxMLCBXSElDSCBJUyBUSEUgVFJBTlNGRVJBQkxFIEhBTEY6KiogdGhlXG4gKiBxdWVzdGlvbiBpcyBuZXZlciBcImRvZXMgdGhpcyBtb2R1bGUgaGF2ZSBhIHBsYWNlIHRvIHB1dCBhIHdhdGNoZG9nXCIgYnV0XG4gKiBcImRvZXMgdGhlIHdhdGNoZG9nJ3Mgd2luZG93IGNvaW5jaWRlIHdpdGggdGhpcyBtb2R1bGUnc1wiLiBXaGVyZSBhIHNwZWxsJ3NcbiAqIHRlYXJkb3duIGhhcyB1bmJvdW5kZWQgd29yayBCRUZPUkUgdGhlIGRyYWluLCB0aGUgd2F0Y2hkb2cgYmVsb25ncyBhdCB0aGVcbiAqIHNwZWxsLCB3cmFwcGVkIGFyb3VuZCBhbGwgb2YgaXQg4oCUIGFuZCBhcm91bmQgRVZFUlkgV0FZIElOLCB3aGljaCBpcyB0aGUgaGFsZlxuICogRDUzIGhhZCB0byByZXBhaXIgYWZ0ZXIgdGhpcyBoZWFkZXIgd2FzIHdyaXR0ZW4uIElmIGEgc3BlbGwgZXZlciBhcHBlYXJzIHdob3NlIHNpZ25hbCBwYXRoXG4gKiBlbnRlcnMgYGRyYWluQW5kU3RvcGAgaW1tZWRpYXRlbHksIGFkZCB0aGUgb3B0aW9uIFRIRU4g4oCUIGFuZCB0aGUgb3B0aW9uIG11c3RcbiAqIHRha2UgYW4gYG9uRXhwaXJlYCBjYWxsYmFjayByYXRoZXIgdGhhbiBleGl0aW5nLCBzbyB0aGUgYHByb2Nlc3MuZXhpdGAgc3RheXNcbiAqIG91dHNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgYnVuZGxlcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRyYWluQW5kU3RvcChvcHRzOiBEcmFpbk9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZ3JhY2VNcyA9IG9wdHMuZ3JhY2VNcyA/PyAxNTA7XG4gIGNvbnN0IHN0b3BNcyA9IG9wdHMuc3RvcE1zID8/IDIwMDtcblxuICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBncmFjZU1zKSk7XG5cbiAgaWYgKG9wdHMuY2xpZW50cykge1xuICAgIGZvciAoY29uc3QgY2xpZW50IG9mIFsuLi5vcHRzLmNsaWVudHNdKSBjbGllbnQuY2xvc2UoKTtcbiAgfVxuICBpZiAob3B0cy5zb2NrZXRzKSB7XG4gICAgZm9yIChjb25zdCB3cyBvZiBbLi4ub3B0cy5zb2NrZXRzXSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgd3MuY2xvc2UoKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBhbHJlYWR5IGdvbmUgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgIFByb21pc2UucmVzb2x2ZShvcHRzLnNlcnZlci5zdG9wKHRydWUpKSxcbiAgICBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBzdG9wTXMpKSxcbiAgXSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGFzc2V0LXNlcnZpbmcgdHJpbyBmb3IgYSBzcGVsbCBkYWVtb246IHdoaWNoIHN1cmZhY2UgbW9kZSB3ZVxuICogYXJlIGluLCB3aGF0IGNvbnRlbnQgdHlwZSBhIGZpbGUgZ2V0cywgYW5kIGhvdyBhIGZpbGUgdW5kZXIgYGRpc3QvYCBpc1xuICogYW5zd2VyZWQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwncyBhcnRpZmFjdC5cbiAqXG4gKiBFeHRyYWN0ZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBmcm9tIHRoZSBlaWdodCBgQnVuLnNlcnZlYCBiYWNrZW5kc1xuICogY2Vuc3VzZWQgaW4gYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC1kYWVtb24tc3BpbmUtY2Vuc3VzLm1kYCwgd2hpY2hcbiAqIG1lYXN1cmVkIGByZXNvbHZlTW9kZWAgYXMgYnl0ZS1pZGVudGljYWwgaW4gYWxsIGVpZ2h0ICh0aGUgb25seSBtZDUgZGlmZmVyZW5jZVxuICogYmVpbmcgdGhlIGBleHBvcnRgIGtleXdvcmQpLCB0aGUgY29udGVudC10eXBlIG1hcCBhcyBkaWZmZXJpbmcgaW4gZXhhY3RseVxuICogb25lIGNlbGwsIGFuZCB0aGUgZmlsZSBoYWxmIG9mIGBzZXJ2ZURpc3RgIGFzIGlkZW50aWNhbCBpbiBmaXZlLlxuICpcbiAqIOKUgOKUgCBXSEFUIERFTElCRVJBVEVMWSBESUQgTk9UIENPTUUgQUxPTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKipUaGUgVVJMLXRvLWZpbGVuYW1lIG1hcHBpbmcgc3RheXMgaW4gZWFjaCByb3V0ZXIuKiogVGhlIGNlbnN1cyBtYXJrZWQgdHdvXG4gKiBvZiB0aGUgZWlnaHQgYHNlcnZlRGlzdGAgZGl2ZXJnZW5jZXMgREVMSUJFUkFURSBhbmQgYm90aCBsaXZlIGluIHRoYXQgaGFsZjpcbiAqIGRpZ2VzdGlmeSBzdWJzdGl0dXRlcyBpbnRvIHRoZSBlbnRyeSBIVE1MIGluIG1lbW9yeSwgYW5kIGdyYXBldmluZSBzZXJ2ZXMgaXRzXG4gKiBzdXJmYWNlIGF0IGAvd2F0Y2hgIHJhdGhlciB0aGFuIGF0IGAvYC4gQSBzaWduYXR1cmUgd2lkZSBlbm91Z2ggdG8gYWJzb3JiXG4gKiB0aG9zZSBzdG9wcyBiZWluZyBhIGZpbGUgc2VydmVyIGFuZCBiZWNvbWVzIGEgcm91dGVyLiBTbyB0aGUgY2FsbGVyIGRlY2lkZXNcbiAqIFdISUNIIGZpbGUgKGBwYXRoID09PSBcIi9cIiA/IFwiaW5kZXguaHRtbFwiIDogcGF0aC5zbGljZSgxKWApLCBhbmQgdGhpcyBtb2R1bGVcbiAqIGRlY2lkZXMgd2hldGhlciB0aGF0IGZpbGUgbWF5IGJlIHJlYWQgYW5kIHdoYXQgaXQgaXMgc2VydmVkIGFzLlxuICpcbiAqIOKUgOKUgCBBTkQgXCJXSEVUSEVSIElUIE1BWSBCRSBSRUFEXCIgSVMgTk9XIEEgV0hJVEVMSVNUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEV4dHJhY3RlZCB3aXRoIHRocmVlIGd1YXJkcyAoZW1wdHkgLyBgLi5gIC8gbmVzdGVkKSBhbmQgYGV4aXN0c1N5bmNgIGZvciB0aGVcbiAqIHJlc3QsIHdoaWNoIHdhcyB0cnVlIG9mIGEgYGRpc3QvYCB0aGF0IGhlbGQgb25seSBhIHN1cmZhY2UuIFBoYXNlIDFiIHB1dCBldmVyeVxuICogZGFlbW9uJ3MgQlVORExFIGluIHRoYXQgc2FtZSBkaXJlY3RvcnksIGFuZCBhbGwgZml2ZSBhZG9wdGVycyBzZXJ2ZWQgaXQ6XG4gKiBgL2NsaS5qc2AsIGAvc2VydmVyLmpzYCwgYC9qb2luLmpzYCBhdCAyMDAsIGJ5dGUtaWRlbnRpY2FsIHRvIHRoZSBjb21taXR0ZWRcbiAqIGFydGlmYWN0cywgZW1iZWRkZWQgc291cmNlbWFwcyBhbmQgYWxsLiBgc2VydmVGcm9tRGlzdGAgbm93IHNlcnZlcyBvbmx5IHdoYXQgdGhlXG4gKiBidWlsdCBgaW5kZXguaHRtbGAgdHJhbnNpdGl2ZWx5IGxpbmtzIOKAlCBzZWUgYHN1cmZhY2VXaGl0ZWxpc3RgIGJlbG93LCB3aGljaCBpc1xuICogdGhlIHNoYXBlIGRpZ2VzdGlmeSBwcm92ZWQgbG9jYWxseSBpbiBgZDhjYmFmZmAgYW5kIHRoaXMgaXMgaXRzIG9uZSBlZGl0IGZvclxuICogZml2ZSBzcGVsbHMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbi8qKlxuICogUmVsZWFzZSBpZmYgYDxkaXN0RGlyPi9pbmRleC5odG1sYCBleGlzdHM7IGVsc2UgZGV2LiBUaGUgZW52IG92ZXJyaWRlXG4gKiAoYFNQRUxMQk9PS19TVVJGQUNFX01PREVgKSB3aW5zIGVpdGhlciB3YXkg4oCUIHNlYW1zIENvbnRyYWN0IDEuXG4gKlxuICog4puUICoqVEhFIEZJTEUsIE5FVkVSIFRIRSBESVJFQ1RPUlksIEFORCBUSEFUIElTIEEgU0NBUiBOT1QgQSBTVFlMRSBDSE9JQ0UuKipcbiAqIFJlLWhvbWVkIGZyb20gYm91bnR5IGFuZCBtYWdwaWUsIHdoaWNoIGVhcm5lZCBpdCBpbmRlcGVuZGVudGx5OlxuICpcbiAqIC0gbWFncGllJ3MgYGRpc3QvYCBBTFJFQURZIEVYSVNURUQgaG9sZGluZyBgY2xpLmpzYCBhbmQgbm8gYGluZGV4Lmh0bWxgLFxuICogICB3aGljaCBpcyBwcmVjaXNlbHkgd2h5IGl0cyBkYWVtb24gc3RheWVkIGNvcnJlY3RseSBpbiBERVYgbW9kZSB0aHJvdWdoIHRoZVxuICogICB3aG9sZSBvZiBTbGljZSAyLiBgZGlzdC9gIGV4aXN0aW5nIGlzIG5vdCB0aGUgZGlzY3JpbWluYXRvci5cbiAqIC0gYm91bnR5IHNheXMgdGhlIHNhbWUgdGhpbmcgZnJvbSB0aGUgb3RoZXIgc2lkZTogYSBidWlsdCBCQUNLRU5EIHB1dHNcbiAqICAgYGNsaS5qc2AgKGFuZCBub3cgYHNlcnZlci5qc2ApIGluIGBkaXN0L2Agd2l0aCBubyBzdXJmYWNlIGFueXdoZXJlIG5lYXIgaXQuXG4gKlxuICog4pqgICoqQU5EIFRIRSBQUkVESUNBVEUgSVMgQU4gVU5IQVNIRUQgRklMRU5BTUUsIFdISUNIIElTIEEgU1RBTkRJTkdcbiAqIEFTU1VNUFRJT04gQUJPVVQgVEhFIFNVUkZBQ0UgQlVJTEQuKiogUmVsZWFzZSBtb2RlIGlzIGNob3NlbiBieSBPTkUgbGl0ZXJhbFxuICogbmFtZS4gQSBzdXJmYWNlIGJ1aWxkIHRoYXQgZXZlciBlbWl0dGVkIGEgY29udGVudC1oYXNoZWQgZW50cnkgZG9jdW1lbnQgd291bGRcbiAqIGxlYXZlIG5vIGBpbmRleC5odG1sYCBoZXJlLCBldmVyeSBkYWVtb24gd291bGQgc2lsZW50bHkgcmVzb2x2ZSBERVYsIGFuZCB0aGVcbiAqIG9ubHkgc3ltcHRvbSBhbnlvbmUgY2FuIHNlZSBpcyB0aGUgYG1vZGVgIGZpZWxkIG9uIGEgaGFuZHNoYWtlIG5vYm9keSByZWFkcyBpblxuICogYW5nZXIuIGBzcmMvYnVpbGQudHNgIGVtaXRzIHRoZSBlbnRyeSB1bmhhc2hlZCB0b2RheSAob25seSB0aGUgSlMgYW5kIENTU1xuICogY2h1bmtzIGNhcnJ5IGhhc2hlcykgYW5kIENvbnRyYWN0IDIgcGlucyB0aGF0IGZsYXQgbGF5b3V0OyB0aGlzIGNvbW1lbnQgaXNcbiAqIHRoZSBub3RlIHRoYXQgc2F5cyB3aGF0IHRoZSBwaW4gaXMgbG9hZC1iZWFyaW5nIEZPUi5cbiAqXG4gKiDimqAgTm90aGluZyBhbm5vdW5jZXMgdGhlIGZsaXAgZnJvbSBkZXYgdG8gcmVsZWFzZSBlaXRoZXI6IHRoZSBmaXJzdCBzdXJmYWNlXG4gKiBidWlsZCB0byBsYW5kIGFuIGBpbmRleC5odG1sYCBiZXNpZGUgYSBkYWVtb24gZmxpcHMgaXQsIHNpbGVudGx5LCBvbiB0aGUgbmV4dFxuICogYm9vdC4gVGhhdCBpcyB3aHkgYG1vZGVgIHJpZGVzIHRoZSByZWFkeSBmcmFtZSDigJQgd2l0aCByb290IGRlcHMgcHJlc2VudCBhIGRldlxuICogZGFlbW9uIHJlbmRlcnMgYW4gaWRlbnRpY2FsLWxvb2tpbmcgc3VyZmFjZSwgc28gXCJpdCBsb29rcyByaWdodFwiIGNhbm5vdFxuICogdmVyaWZ5IENvbnRyYWN0IDEuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9kZShkaXN0RGlyOiBzdHJpbmcpOiBcImRldlwiIHwgXCJyZWxlYXNlXCIge1xuICBjb25zdCBvdmVycmlkZSA9IHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREU7XG4gIGlmIChvdmVycmlkZSA9PT0gXCJkZXZcIiB8fCBvdmVycmlkZSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBvdmVycmlkZTtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihkaXN0RGlyLCBcImluZGV4Lmh0bWxcIikpID8gXCJyZWxlYXNlXCIgOiBcImRldlwiO1xufVxuXG4vKipcbiAqIFRoZSBjb250ZW50IHR5cGVzIGEgYnVpbHQgc3VyZmFjZSBhY3R1YWxseSBzaGlwcy4gRXh0ZW5zaW9ucyBvdXRzaWRlIHRoZVxuICogbWFwIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYCDigJQgYSBkZWxpYmVyYXRlIHJlZnVzYWwgdG8gZ3Vlc3MsIHNpbmNlXG4gKiBhbnl0aGluZyBub3QgaW4gdGhpcyBsaXN0IGlzIG5vdCBzb21ldGhpbmcgQ29udHJhY3QgMidzIGJ1aWxkIGVtaXRzLlxuICpcbiAqIOKaoCAqKmBjaGFyc2V0PXV0Zi04YCBPTiBIVE1MIElTIFRIRSBDRU5TVVMnUyBPTkUgRElWRVJHRU5DRSwgUkVTT0xWRUQgVE9XQVJEXG4gKiBUSEUgQ09SUkVDVCBDT1BZLioqIFRocmVlIG9mIHRoZSBlaWdodCBkYWVtb25zIGNhcnJpZWQgaXQgYW5kIGZpdmUgZGlkIG5vdDtcbiAqIHRoZSBjZW5zdXMgZ3JhZGVkIHRoYXQgYHN0YWxlYCB3aXRoIHplcm8gZGVzaWduIGNvbnRlbnQuIEl0IGlzIGtlcHQgYmVjYXVzZVxuICogaXQgaXMgdGhlIHJpZ2h0IGFuc3dlciDigJQgYW4gSFRNTCBkb2N1bWVudCBzZXJ2ZWQgd2l0aCBubyBjaGFyc2V0IGlzIGRlY29kZWRcbiAqIGJ5IHRoZSBicm93c2VyJ3MgZ3Vlc3Mg4oCUIGFuZCBpdCBpcyB0aGUgb25lIHdpcmUtb2JzZXJ2YWJsZSBjaGFuZ2UgdGhpc1xuICogY29udmVyZ2VuY2UgbWFrZXMgdG8gYSByZXNwb25zZSBoZWFkZXIuIFJlY29yZGVkIGFzIEQtbm90ZSBpbiB0aGUgcGhhc2UgbG9nXG4gKiByYXRoZXIgdGhhbiBzbXVnZ2xlZC5cbiAqL1xuY29uc3QgU1RBVElDX0NPTlRFTlRfVFlQRVM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiLmh0bWxcIjogXCJ0ZXh0L2h0bWw7IGNoYXJzZXQ9dXRmLThcIixcbiAgXCIuanNcIjogXCJ0ZXh0L2phdmFzY3JpcHRcIixcbiAgXCIuY3NzXCI6IFwidGV4dC9jc3NcIixcbiAgXCIuanNvblwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbn07XG5cbi8qKiBUaGUgY29udGVudCB0eXBlIGZvciBhIGZpbGVuYW1lIG9yIGFuIGV4dGVuc2lvbi4gVW5rbm93biBleHRlbnNpb25zLCBhbmRcbiAqICBuYW1lcyB3aXRoIG5vIGV4dGVuc2lvbiBhdCBhbGwsIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb250ZW50VHlwZUZvcihuYW1lT3JFeHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGRvdCA9IG5hbWVPckV4dC5sYXN0SW5kZXhPZihcIi5cIik7XG4gIGNvbnN0IGV4dCA9IGRvdCA9PT0gLTEgPyBcIlwiIDogbmFtZU9yRXh0LnNsaWNlKGRvdCk7XG4gIHJldHVybiBTVEFUSUNfQ09OVEVOVF9UWVBFU1tleHRdID8/IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCI7XG59XG5cbi8qKlxuICogQW5zd2VyIE9ORSBmaWxlIGZyb20gYGRpc3REaXJgLCBvciBgbnVsbGAgaWYgdGhlIGNhbGxlciBzaG91bGQga2VlcCByb3V0aW5nLlxuICpcbiAqIGByZWxgIGlzIGEgYmFyZSBmaWxlbmFtZSDigJQgdGhlIGVudHJ5IGRvY3VtZW50IG9yIG9uZSBoYXNoZWQgY2h1bmsuIENvbnRyYWN0XG4gKiAyJ3MgYnVpbHQgc3VyZmFjZSBpcyBGTEFUIGFuZCBsaW5rcyBpdHMgY2h1bmtzIHJlbGF0aXZlbHksIHNvIGEgbGVnaXRpbWF0ZVxuICogYXNzZXQgcmVxdWVzdCBpcyBuZXZlciBuZXN0ZWQgYW5kIG5ldmVyIGNvbnRhaW5zIGAuLmA7IGJvdGggYXJlIHJlZnVzZWRcbiAqIGhlcmUgcmF0aGVyIHRoYW4gaW4gdGhlIHJvdXRlciwgYmVjYXVzZSB0aGUgZ3VhcmQgcHJvdGVjdHMgdGhlIHJlYWQgYW5kIHRoZVxuICogcmVhZCBpcyB3aGF0IGxpdmVzIGluIHRoaXMgZmlsZS5cbiAqXG4gKiDim5QgQU5EIGBleGlzdHNTeW5jYCBJUyBOTyBMT05HRVIgVEhFIFBFUk1JU1NJT04uIEEgZmlsZSB1bmRlciBgZGlzdERpcmAgaXNcbiAqIHNlcnZlZCBvbmx5IGlmIGl0IGlzIGluIGBzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXIpYCDigJQgd2hhdCB0aGUgYnVpbHRcbiAqIGBpbmRleC5odG1sYCB0cmFuc2l0aXZlbHkgTElOS1MuIGBkaXN0L2Agc3RvcHBlZCBiZWluZyBhIHN1cmZhY2UgZGlyZWN0b3J5XG4gKiB3aGVuIHRoZSBiYWNrZW5kIGNvbnZlcmdlbmNlIGJ1aWx0IHRoZSBkYWVtb25zIGludG8gaXQsIGFuZCB0aGUgZ3VhcmRzIGFib3ZlXG4gKiBkbyBub3QgZGlzdGluZ3Vpc2ggYGluZGV4LTxoYXNoPi5qc2AgZnJvbSBgc2VydmVyLmpzYC4gUmVhZCB0aGF0IGZ1bmN0aW9uJ3NcbiAqIGhlYWRlciBiZWZvcmUgdG91Y2hpbmcgdGhpcyBsaW5lOyB0aGUgd2hpdGVsaXN0IGlzIHRoZSBkZWZlbmNlLlxuICpcbiAqIOKaoCBUaGUgbmVzdGluZyByZWZ1c2FsIGlzIGFsc28gd2hhdCBrZWVwcyBhbiBhc3NldCBzZXJ2ZSBjbGVhciBvZiBhIHNwZWxsJ3NcbiAqIG93biByb3V0ZXM6IG1hZ3BpZSwgYm91bnR5LCBnbGFtb3VyIGFuZCBpbWFnbyBlYWNoIGhhdmUgYW4gYC9hc3NldHMvPG5hbWU+YFxuICogcm91dGUgb25lIGxldmVsIGRlZXAsIGFuZCB0aGlzIHJldHVybmluZyBgbnVsbGAgb24gYW55dGhpbmcgd2l0aCBhIHNsYXNoIGluXG4gKiBpdCBpcyB3aGF0IHN0b3BzIHRoZSB0d28gZmlnaHRpbmcuIFRoZSB3aGl0ZWxpc3QgZ292ZXJucyBgZGlzdC9gIHJlYWRzIE9OTFlcbiAqIOKAlCBpdCBuZXZlciBzZWVzIHRob3NlIHJvdXRlcyBhbmQgbXVzdCBuZXZlciBiZSB3aWRlbmVkIGludG8gdGhlbS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlcnZlRnJvbURpc3QoZGlzdERpcjogc3RyaW5nLCByZWw6IHN0cmluZyk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIGlmICghcmVsIHx8IHJlbC5pbmNsdWRlcyhcIi4uXCIpIHx8IHJlbC5pbmNsdWRlcyhcIi9cIikpIHJldHVybiBudWxsO1xuICBpZiAoIXN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcikuaGFzKHJlbCkpIHJldHVybiBudWxsO1xuICBjb25zdCBmaWxlID0gam9pbihkaXN0RGlyLCByZWwpO1xuICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIHJldHVybiBudWxsO1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKEJ1bi5maWxlKGZpbGUpLCB7IGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogY29udGVudFR5cGVGb3IocmVsKSB9IH0pO1xufVxuXG4vKiogYHNyY2AvYGhyZWZgIHZhbHVlcyBpbiBhIGJ1aWx0IGVudHJ5IGRvY3VtZW50LCBgLi9gLXByZWZpeGVkIG9yIGJhcmUuICovXG5jb25zdCBFTlRSWV9SRUZfUkUgPSAvKD86c3JjfGhyZWYpXFxzKj1cXHMqXCIoPzpcXC5cXC8pPyhbXlwiXSspXCIvZztcblxuLyoqIEEgYC4vYC1QUkVGSVhFRCBzaWJsaW5nIHNwZWNpZmllciDigJQgYFwiLi9uYW1lXCJgLCBgJy4vbmFtZSdgLCBgKC4vbmFtZSlgIOKAlCB3aGljaFxuICogIGlzIHRoZSBvbmx5IHNoYXBlIGEgYnVuZGxlciBlbWl0cyBmb3IgYSBzaWJsaW5nIGNodW5rLiBSZXF1aXJpbmcgdGhlIGAuL2AgaXNcbiAqICB3aGF0IGtlZXBzIGEgc3RyaW5nIGxpdGVyYWwgdGhhdCBtZXJlbHkgU0FZUyBgY2xpLmpzYCBvdXQgb2YgdGhlIHNldC4gKi9cbmNvbnN0IFJFTEFUSVZFX1JFRl9SRSA9IC9bXCInKF1cXC5cXC8oW15cIicoKVxcc10rKVtcIicpXS9nO1xuXG4vKiogT25seSB0ZXh0IHRoZSBidWlsZCBlbWl0cyBhcyBzdXJmYWNlIGNvZGUgaXMgc2Nhbm5lZCBmb3Igb253YXJkIHJlZmVyZW5jZXMuXG4gKiAgQSBgLnBuZ2AgaXMgYSBsZWFmOyBvcGVuaW5nIGl0IHdvdWxkIGJlIHJlYWRpbmcgYSBiaW5hcnkgZm9yIGZpbGVuYW1lcy4gKi9cbmNvbnN0IFRSQU5TSVRJVkVfRVhUUyA9IFtcIi5qc1wiLCBcIi5jc3NcIl07XG5cbi8qKiBPbmUgZGVyaXZhdGlvbiBwZXIgYGRpc3QvYCwgZm9yIHRoZSBsaWZlIG9mIHRoZSBwcm9jZXNzIOKAlCBgZGlzdC9gIGlzIGEgYnVpbGRcbiAqICBhcnRpZmFjdCBhbmQgZG9lcyBub3QgY2hhbmdlIHVuZGVyIGEgcnVubmluZyBkYWVtb24uIEtleWVkIGJ5IGRpcmVjdG9yeSBzb1xuICogIHR3byBkYWVtb25zIGluIG9uZSBwcm9jZXNzIChhbmQgZXZlcnkgdGVzdCB3aXRoIGl0cyBvd24gdGVtcCB0cmVlKSBzdGF5XG4gKiAgaW5kZXBlbmRlbnQuICovXG5jb25zdCB3aGl0ZWxpc3RDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBSZWFkb25seVNldDxzdHJpbmc+PigpO1xuXG5mdW5jdGlvbiByZWZzSW4odGV4dDogc3RyaW5nLCByZTogUmVnRXhwKTogc3RyaW5nW10ge1xuICByZXR1cm4gKFxuICAgIFsuLi50ZXh0Lm1hdGNoQWxsKHJlKV1cbiAgICAgIC5tYXAoKFssIHJlZl0pID0+IHJlZilcbiAgICAgIC8vIEEgVFlQRSBQUkVESUNBVEUsIGFuZCBob25lc3Qgb25seSBiZWNhdXNlIGl0cyBmaXJzdCBjbGF1c2Ugd2FzIGFscmVhZHlcbiAgICAgIC8vIGhlcmU6IGAhIXJlZmAgaXMgdGhlIHJ1bnRpbWUgY2hlY2sgdGhhdCBtYWtlcyBgcmVmIGlzIHN0cmluZ2AgdHJ1ZSAodGhlXG4gICAgICAvLyBGRUxMIHNlbnRlbmNlJ3MgcHJlZGljYXRlIHJvdXRlLCB0YWtlbiB3aXRoIGl0cyBjbGF1c2Ug4oCUIHR5cGUtZGVidCBUMzYpLlxuICAgICAgLmZpbHRlcihcbiAgICAgICAgKHJlZik6IHJlZiBpcyBzdHJpbmcgPT5cbiAgICAgICAgICAhIXJlZiAmJlxuICAgICAgICAgICFyZWYuaW5jbHVkZXMoXCIvXCIpICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIi4uXCIpICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIjpcIikgJiZcbiAgICAgICAgICAhcmVmLnN0YXJ0c1dpdGgoXCIjXCIpICYmXG4gICAgICAgICAgIXJlZi5zdGFydHNXaXRoKFwiP1wiKSxcbiAgICAgIClcbiAgKTtcbn1cblxuLyoqXG4gKiBUaGUgbmFtZXMgdW5kZXIgYGRpc3REaXJgIGEgYnJvd3NlciBtYXkgZmV0Y2g6IHRoZSBlbnRyeSBkb2N1bWVudCwgcGx1cyB0aGVcbiAqIFRSQU5TSVRJVkUgY2xvc3VyZSBvZiB3aGF0IGl0IGxpbmtzLlxuICpcbiAqIOKblCAqKkEgV0hJVEVMSVNULCBBTkQgVEhFIExFQUsgSVQgUkVQTEFDRUQgSVMgV0hZLioqIFVudGlsIHRoaXMgZml4IHRoZSBmaWxlXG4gKiBoYWxmIG9mIHRoaXMgbW9kdWxlIGhhZCBleGFjdGx5IHRocmVlIGd1YXJkcyDigJQgZW1wdHksIGAuLmAsIG5lc3RlZCDigJQgYW5kXG4gKiBgZXhpc3RzU3luY2AgZGVjaWRlZCB0aGUgcmVzdC4gVGhhdCB3YXMgY29ycmVjdCBmb3IgYXMgbG9uZyBhcyBgZGlzdC9gIGhlbGRcbiAqIG9ubHkgYSBzdXJmYWNlLiBUaGUgYmFja2VuZCBjb252ZXJnZW5jZSBtb3ZlZCBldmVyeSBzcGVsbCdzIElNUExFTUVOVEFUSU9OXG4gKiBpbnRvIHRoZSBzYW1lIGRpcmVjdG9yeSwgYW5kIHRoZSBzZXJ2ZSBkaWQgd2hhdCBpdCB3YXMgd3JpdHRlbiB0byBkbzpcbiAqXG4gKiAgIEdFVCAvY2xpLmpzICAgICAyMDAgIDI0Miw0MzEgQiAgdGV4dC9qYXZhc2NyaXB0ICAg4oaQIGJvdW50eSwgYnl0ZS1pZGVudGljYWxcbiAqICAgR0VUIC9zZXJ2ZXIuanMgIDIwMCAgMjc2LDQxNSBCICB0ZXh0L2phdmFzY3JpcHQgICAgICB0byB0aGUgY29tbWl0dGVkXG4gKiAgIEdFVCAvam9pbi5qcyAgICAyMDAgICA0NywzNDggQiAgdGV4dC9qYXZhc2NyaXB0ICAgICAgYXJ0aWZhY3RzXG4gKlxuICogYW5kIHRob3NlIGJ1bmRsZXMgYXJlIGJ1aWx0IHdpdGggdGhlIHNvdXJjZW1hcCBFTUJFRERFRCwgc28gZWFjaCBvbmUgY2Fycmllc1xuICogdGhlIGNvbXBsZXRlIG9yaWdpbmFsIFR5cGVTY3JpcHQuIEZpdmUgc3BlbGxzIOKAlCBhc3Ryb2xhYmUsIGJvdW50eSwgZ2xhbW91ciwgaW1hZ28sIG1hZ3BpZVxuICog4oCUIGVsZXZlbiBhcnRpZmFjdHMsIGFsbCByZWFjaGFibGUgYnkgYW55IGJyb3dzZXIgdGhhdCBjYW4gcmVhY2ggdGhlIGRhZW1vbi5cbiAqIERpZ2VzdGlmeSBoaXQgdGhlIGlkZW50aWNhbCBkZWZlY3Qgb25lIGJyYW5jaCBlYXJsaWVyIGFuZCBhbnN3ZXJlZCBpdCBsb2NhbGx5O1xuICogdGhpcyBpcyB0aGF0IGFuc3dlciByZS1ob21lZCB0byB0aGUgb25lIHBsYWNlIGFsbCBmaXZlIGNhbGxlcnMgYWxyZWFkeSBzaGFyZS5cbiAqXG4gKiDim5QgKipERVJJVkVELCBOT1QgRU5VTUVSQVRFRCwgQU5EIE5PVCBNQVRDSEVEIEJZIFNIQVBFLioqIEEgbGl0ZXJhbCBuYW1lIGxpc3RcbiAqIGlzIHdyb25nIGF0IHRoZSBuZXh0IGJ1aWxkICh0aGUgY2h1bmtzIGNhcnJ5IGNvbnRlbnQgaGFzaGVzKS4gQSBzaGFwZSBtYXRjaFxuICogKGBpbmRleC08aGFzaD4uanNgKSBpcyB3cm9uZyB0aGUgZmlyc3QgdGltZSB0aGUgYnVuZGxlciBzcGxpdHMgYSBjaHVuay4gQXNraW5nXG4gKiB0aGUgZW50cnkgZG9jdW1lbnQgd2hhdCBpdCBsb2FkcyBpcyB0aGUgb25seSBmb3JtdWxhdGlvbiB0aGF0IGlzIHRydWUgb2ZcbiAqIHdoYXRldmVyIGBidW4gcnVuIGJ1aWxkYCBhY3R1YWxseSBlbWl0dGVkLlxuICpcbiAqIOKblCAqKkFORCBUSEUgQ0xPU1VSRSBJUyBUUkFOU0lUSVZFIEZPUiBUSEUgU0FNRSBSRUFTT04uKiogYGluZGV4Lmh0bWxgIGxpbmtzXG4gKiBvbmUgY2h1bmsgdG9kYXk7IGEgc3BsaXQgYnVpbGQgaGFzIHRoYXQgY2h1bmsgYGltcG9ydCBcIi4vY2h1bmstPGhhc2g+LmpzXCJgLFxuICogd2hpY2ggdGhlIGVudHJ5IGRvY3VtZW50IG5ldmVyIG5hbWVzLiBTbyBldmVyeSBhZG1pdHRlZCBgLmpzYC9gLmNzc2AgaXMgaXRzZWxmXG4gKiBzY2FubmVkIGZvciBgLi9gLXByZWZpeGVkIHNpYmxpbmdzLCB1bnRpbCB0aGUgc2V0IHN0b3BzIGdyb3dpbmcg4oCUIGEgd2hpdGVsaXN0XG4gKiB0aGF0IHJlYWQgb25seSB0aGUgZW50cnkgd291bGQgNDA0IGEgbGVnaXRpbWF0ZSBjaHVuayBpbiByZWxlYXNlLCBhbmQgb25seSBpblxuICogcmVsZWFzZS5cbiAqXG4gKiDim5QgKipNRU1CRVJTSElQIElTIEFOIEVYQUNUIE1BVENILCBXSElDSCBNQUtFUyBUSEUgUkVGVVNBTCBDQVNFLUlOU0VOU0lUSVZFIEJZXG4gKiBDT05TVFJVQ1RJT04uKiogQVBGUyBpcyBjYXNlLWluc2Vuc2l0aXZlLCBzbyBgL0lOREVYLkhUTUxgIGFuZCBgL2lOZEV4Lkh0TWxgXG4gKiByZXNvbHZlIHRvIHRoZSBzYW1lIGlub2RlIGEgY2FzZS1zZW5zaXRpdmUgYmxhY2tsaXN0IHdvdWxkIG1pc3MgKG1lYXN1cmVkIG9uXG4gKiBhbGwgZml2ZSBzcGVsbHMgYmVmb3JlIHRoaXMgZml4OiBmb3VyIHZhcmlhbnRzLCBmb3VyIDIwMHMsIHRocmVlIG9mIHRoZW0gYXNcbiAqIGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gIGJlY2F1c2UgdGhlIGNvbnRlbnQtdHlwZSBsb29rdXAgaXMgY2FzZS1zZW5zaXRpdmVcbiAqIHRvbykuIEEgc2V0IG9mIGV4YWN0bHkgdGhlIGVtaXR0ZWQgbmFtZXMgcmVmdXNlcyBldmVyeSB2YXJpYW50IG9mIGV2ZXJ5IG5hbWVcbiAqIOKAlCBzZXJ2YWJsZSBvciBub3Qg4oCUIHdpdGggbm8gbG93ZXItY2FzZSBwYXNzIGFueXdoZXJlLlxuICpcbiAqIOKaoCAqKlRIRSBUUkFERToqKiBhIGZpbGUgdGhlIGVudHJ5IGdyYXBoIGRvZXMgbm90IHJlZmVyZW5jZSDigJQgYSBsYXppbHkgZmV0Y2hlZFxuICogY2h1bmssIGEgZm9udCBwdWxsZWQgYnkgYSBDU1MgYHVybCgpYCB0aGlzIHNjYW4gZG9lcyBub3QgbW9kZWwsIGFuIGFzc2V0IHRoZVxuICogYnVpbGQgZW1pdHMgYnV0IG5vdGhpbmcgbGlua3Mg4oCUIDQwNHMgaW4gcmVsZWFzZSB3aXRoIG5vdGhpbmcgcmVkLiBFYWNoXG4gKiBhZG9wdGVyJ3MgYHJlbGVhc2Utc2VydmUudGVzdC50c2AgaG9sZHMgdGhlIGluc3RydW1lbnQ6IGFuIElOVkVOVE9SWSBjZWxsIHRoYXRcbiAqIGFjY291bnRzIGZvciBldmVyeSBmaWxlIGluIGBkaXN0L2AgYXMgc2VydmVkIG9yIGRlbGliZXJhdGVseSByZWZ1c2VkLCBzbyBhblxuICogdW5saW5rZWQgZW1pc3Npb24gZ29lcyByZWQgYXQgYnVpbGQgdGltZSByYXRoZXIgdGhhbiBzaWxlbnQgYXQgcnVudGltZS5cbiAqXG4gKiDimqAgVGhlIGVudHJ5IGRvY3VtZW50IGlzIElOIHRoZSBzZXQsIGJlY2F1c2UgdGhlIGhvdXNlIGNhbGxlciBtYXBzIGAvYCB0b1xuICogYGluZGV4Lmh0bWxgIGFuZCB0aGF0IGlzIHRoZSBzdXJmYWNlLiBBIHNwZWxsIHRoYXQgbXVzdCBuZXZlciBoYW5kIG92ZXIgaXRzXG4gKiBvbi1kaXNrIGVudHJ5IOKAlCBkaWdlc3RpZnkgc3Vic3RpdHV0ZXMgYSBwYXlsb2FkIGludG8gaXQgaW4gbWVtb3J5IOKAlCByZWZ1c2VzXG4gKiB0aGF0IE9ORSBuYW1lIGluIGl0cyBvd24gcm91dGVyLCBhYm92ZSB0aGlzIGNhbGwuIFRoYXQgcmVmdXNhbCBpcyB0aGUgc3BlbGwncztcbiAqIGV2ZXJ5dGhpbmcgZWxzZSBoZXJlIGlzIHRoZSBraXQncy5cbiAqL1xuZnVuY3Rpb24gc3VyZmFjZVdoaXRlbGlzdChkaXN0RGlyOiBzdHJpbmcpOiBSZWFkb25seVNldDxzdHJpbmc+IHtcbiAgY29uc3QgY2FjaGVkID0gd2hpdGVsaXN0Q2FjaGUuZ2V0KGRpc3REaXIpO1xuICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkO1xuXG4gIGNvbnN0IG5hbWVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGVudHJ5ID0gam9pbihkaXN0RGlyLCBcImluZGV4Lmh0bWxcIik7XG4gIGlmIChleGlzdHNTeW5jKGVudHJ5KSkge1xuICAgIG5hbWVzLmFkZChcImluZGV4Lmh0bWxcIik7XG4gICAgY29uc3QgaHRtbCA9IHJlYWRGaWxlU3luYyhlbnRyeSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHBlbmRpbmcgPSBbLi4ucmVmc0luKGh0bWwsIEVOVFJZX1JFRl9SRSksIC4uLnJlZnNJbihodG1sLCBSRUxBVElWRV9SRUZfUkUpXTtcbiAgICAvLyBVbnRpbCB0aGUgc2V0IHN0b3BzIGdyb3dpbmc6IGVhY2ggYWRtaXR0ZWQgY2h1bmsgbWF5IG5hbWUgdGhlIG5leHQgb25lLlxuICAgIHdoaWxlIChwZW5kaW5nLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IG5hbWUgPSBwZW5kaW5nLnBvcCgpIGFzIHN0cmluZztcbiAgICAgIGlmIChuYW1lcy5oYXMobmFtZSkpIGNvbnRpbnVlO1xuICAgICAgLy8g4pqgIFJFRkVSRU5DRUQgKipBTkQqKiBQUkVTRU5ULiBBIG1pbmlmaWVkIGJ1bmRsZSBjYW4gY29udGFpbiBhIHN0cmluZ1xuICAgICAgLy8gdGhhdCBtZXJlbHkgTE9PS1MgbGlrZSBvbmU7IGFkbWl0dGluZyBvbmx5IG5hbWVzIHRoYXRcbiAgICAgIC8vIGFyZSBhY3R1YWxseSBvbiBkaXNrIGtlZXBzIHRoZSBzY2FuIGZyb20gd2lkZW5pbmcgdGhlIHNldCBvbiBhXG4gICAgICAvLyBjb2luY2lkZW5jZSwgYW5kIGEgbmFtZSB0aGF0IGlzIGFic2VudCA0MDRzIGlkZW50aWNhbGx5IGVpdGhlciB3YXkuXG4gICAgICBjb25zdCBmaWxlID0gam9pbihkaXN0RGlyLCBuYW1lKTtcbiAgICAgIGlmICghZXhpc3RzU3luYyhmaWxlKSkgY29udGludWU7XG4gICAgICBuYW1lcy5hZGQobmFtZSk7XG4gICAgICBpZiAoIVRSQU5TSVRJVkVfRVhUUy5zb21lKChleHQpID0+IG5hbWUuZW5kc1dpdGgoZXh0KSkpIGNvbnRpbnVlO1xuICAgICAgcGVuZGluZy5wdXNoKC4uLnJlZnNJbihyZWFkRmlsZVN5bmMoZmlsZSwgXCJ1dGY4XCIpLCBSRUxBVElWRV9SRUZfUkUpKTtcbiAgICB9XG4gIH1cblxuICB3aGl0ZWxpc3RDYWNoZS5zZXQoZGlzdERpciwgbmFtZXMpO1xuICByZXR1cm4gbmFtZXM7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIHNlcnZlciBzaWRlIG9mIHRoZSBTU0UgdGFpbCDigJQgdGhlIGRhZW1vbi1zaWRlIHR3aW4gb2ZcbiAqIGB0YWlsRXZlbnRzLnRzYC4gVGhhdCBtb2R1bGUgZGVjaWRlcyB3aGF0IGEgY2FsbGVyIG9ic2VydmVzOyB0aGlzIG9uZSBkZWNpZGVzXG4gKiB3aGF0IGEgY2FsbGVyIGlzIHNlbnQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgZXhjZXB0IGl0c1xuICogb3duIHNpYmxpbmcgdHlwZXMsIHdoaWNoIGlzIHN0aWxsIGluc2lkZSB0aGUgbGVhZi5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgbWluZC1tYXBwZXIncyBgc3NlUmVzcG9uc2VgLFxuICogdGhlIGNlbnN1cydzIGNvbnZlcmdlbmNlIHRhcmdldCAjMTogdGhlIG9ubHkgb25lIG9mIHRoZSBzZXZlbiB3aXRoIGFcbiAqIG9uY2Utb25seSB0ZWFyZG93biBmdW5uZWwsIHRoZSBvbmx5IG9uZSB3aXJlZCB0byBgcmVxLnNpZ25hbGAsIGFuZCB0aGUgb25seVxuICogb25lIHdob3NlIGNvbW1lbnQgcmVjb3JkcyBhIE1FQVNVUkVEIHJlc3VsdCByYXRoZXIgdGhhbiBhIGJlbGllZi5cbiAqXG4gKiDilIDilIAg4puUIEFORCBXSEFUIFRIRSBDT1BZIExFRlQgQkVISU5ELCBTQUlEIEhFUkUgQkVDQVVTRSBBIExPU1MgUkVDT1JERUQgT05MWSBJTlxuICogICAgQSBQT1JUJ1MgSk9VUk5BTCBHRVRTIFJFLUxJVElHQVRFRCBCWSBFVkVSWSBTUEVMTCBBRlRFUiBJVCAoRDc5L0Q4NSkg4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHNlbnRlbmNlIGFib3ZlIG5hbWVzIGEgU09VUkNFIHRoaXMgbW9kdWxlIGhhZCBuZXZlciBiZWVuIGNoZWNrZWQgYWdhaW5zdDpcbiAqIEQxIHJ1bGVkIHRoZSBzcGluZSBiZSBwcm92ZW4gb24gdGhlIHR3byBzcGVsbHMgdGhhdCBhbHJlYWR5IGJ1aWx0LCBhbmQgYm90aCBvZlxuICogdGhvc2UgYXJlIGRvd25zdHJlYW0gRk9SS1Mgb2YgdGhlIG1pbmQtbWFwcGVyIGxpbmUsIHNvIHRoZSBib3VuZGFyaWVzIHdlcmVcbiAqIHNldHRsZWQgYWdhaW5zdCB0d28gY29waWVzIHdoaWxlIHRoZSBvcmlnaW5hbCB3YXMgbm90IGluIHRoZSByb29tLiAqKkFcbiAqIGNvbnZlcmdlbmNlIGNhbiBuYW1lIGl0cyBzb3VyY2UgYW5kIHN0aWxsIG5ldmVyIGNvbnN1bHQgaXQuKipcbiAqXG4gKiBXaGVuIGl0IHdhcyBmaW5hbGx5IGNvbnN1bHRlZCAoUGhhc2UgNywgdGhlIGxhc3QgcG9ydCksIGV4YWN0bHkgT05FIHByb3BlcnR5XG4gKiBvZiB0aGUgc291cmNlIHdhcyBtaXNzaW5nIGhlcmUsIGFuZCBpdCBvY2N1cGllZCBubyB0eXBlOiAqKm1pbmQtbWFwcGVyIHdyb3RlXG4gKiBpdHMgYHRhaWwgLS1pbmJvdW5kYCBncm91bmRpbmcgZnJhbWUgQkVGT1JFIHRoZSByZXBsYXkqKiDigJQgb25lIGxpbmUgYWJvdmVcbiAqIGBidXMuc3Vic2NyaWJlYCDigJQgc28gaXQgd2FzIHRoZSBzdHJlYW0ncyBmaXJzdCBkYXRhIGxpbmUuIGBvbk9wZW5gIGZpcmVzIGF0XG4gKiB0aGUgRU5EIG9mIGBzdGFydGAsIGFmdGVyIHRoZSBwcmVhbWJsZSwgYWZ0ZXIgYGxvZy5zdWJzY3JpYmVgLCBhZnRlclxuICogYGNsaWVudHMuYWRkYCwgc28gYSBjYWxsZXIgdGhhdCBzdXBwbGllZCBpdHMgb3duIGBjbGllbnRzYCBzZXQgYW5kIHNlbnQgZnJvbVxuICogdGhlcmUgd291bGQgbGFuZCB0aGUgZnJhbWUgQUZURVIgdGhlIHJlcGxheWVkIGJhY2tsb2cuIFRoYXQgaXMgRVhQUkVTU0lCTEUsXG4gKiB3aGljaCBpcyB3aGF0IG1ha2VzIHRoaXMgYSBtZWFzdXJlbWVudCByYXRoZXIgdGhhbiBhbiBhc3NlcnRpb246IHRoZVxuICogcGxheWJvb2sncyB0eXBlLXRvLXR5cGUgY29tcGF0aWJpbGl0eSBwcm9jZWR1cmUgYW5zd2VycyBcInJlcHJlc2VudGFibGVcIiBoZXJlXG4gKiAodGhlIHN1YmplY3QgdHlwZSBpcyBgU2V0PFNzZUNsaWVudD5gLCB0aGUgc3BlbGwga2VlcHMgbm8gcmVnaXN0cnksIHNvIHlvdVxuICogcGFzcyBhbiBlbXB0eSBzZXQpIGFuZCBhIHR5cGUgY2hlY2sgY2Fubm90IHNlZSBhIFBPU0lUSU9OLlxuICpcbiAqICoqVGhlIGRpc3Bvc2l0aW9uIHdhcyBSRVNUT1JFLCBub3QgS0VFUC1MT0NBTCBhbmQgbm90IEZJTEUqKiDigJQgc2VlXG4gKiBgb3BlbkZyYW1lc2AgYmVsb3csIHdoZXJlIHRoZSB0d28gbnVtYmVycyB0aGF0IHBlcm1pdCBpdCBhcmUgcmVjb3JkZWQgYW5kXG4gKiBkcml2ZW4uIFRoZSBnZW5lcmFsaXNhdGlvbiwgd2hpY2ggaXMgdGhlIHBhcnQgd29ydGggY2Fycnlpbmc6IHdoZXJlIGFcbiAqIG1vZHVsZSdzIHN1YmplY3QgaXMgYSBTRVFVRU5DRSBPRiBXUklURVMsIGNvbXBhcmUgdGhlIE9SREVSIG9mIGl0cyBob29rc1xuICogYWdhaW5zdCB0aGUgb3JkZXIgdGhlIGFkb3B0aW5nIHNwZWxsIHdyaXRlcyBpbi4gVHdvIGhvb2tzIHdpdGggdGhlIHJpZ2h0XG4gKiBzaWduYXR1cmVzIGluIHRoZSB3cm9uZyBvcmRlciBhcmUgYXMgaW5jb21wYXRpYmxlIGFzIHR3byB0eXBlcyB0aGF0IHdpbGwgbm90XG4gKiB1bmlmeSwgYW5kIG9ubHkgb25lIG9mIHRoZSB0d28gY2FuIGJlIFNFRU4gYnkgYSBjb21wYXRpYmlsaXR5IGNoZWNrLlxuICpcbiAqIOKUgOKUgCDim5QgVEhFIFNDQVIsIFJFLUhPTUVEOiBgdHJ5IHsgZW5xdWV1ZSB9IGNhdGNoYCBET0VTIE5PVCBERVRFQ1QgQSBERUFEXG4gKiAgICBDTElFTlQuIE1FQVNVUkVEIE9OIEJVTiAxLjMuMTQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogU2l4IGRhZW1vbnMgd3JpdGUgYSBoZWFydGJlYXQgYXMgYHRyeSB7IGNvbnRyb2xsZXIuZW5xdWV1ZSguLi4pIH0gY2F0Y2gge31gXG4gKiB3aXRoIGEgY29tbWVudCBzYXlpbmcgdGhlIGNhdGNoIGlzIGhvdyBhIGRlcGFydGVkIGNsaWVudCBpcyBub3RpY2VkLiBJdCBpc1xuICogbm90OiBlbnF1ZXVlIG9uIGFuIG9ycGhhbmVkIHN0cmVhbSBCVUZGRVJTIFNJTEVOVExZIGFuZCBuZXZlciB0aHJvd3MsIHNvIHRoZVxuICogY2F0Y2ggbmV2ZXIgZmlyZXMgYW5kIHRob3NlIGRhZW1vbnMnIGRlYWQtY2xpZW50IGRldGVjdGlvbiByZXN0cyBvbiBhXG4gKiBtZWNoYW5pc20gdGhlaXIgb3duIGNvbW1lbnRzIGRlc2NyaWJlIGluY29ycmVjdGx5LiBXaGF0IGFjdHVhbGx5IHJlY2xhaW1zIHRoZVxuICogY29ubmVjdGlvbiBpcyB0aGUgc3RyZWFtJ3MgYGNhbmNlbCgpYCDigJQgYW5kLCBmb3IgYSBjbGllbnQgdGhhdCBuZXZlciBjbG9zZXNcbiAqIHRoZSBzb2NrZXQsIGByZXEuc2lnbmFsYC5cbiAqXG4gKiBTbyB0aGUgZnVubmVsIGJlbG93IGlzIHRoZSBsb2FkLWJlYXJpbmcgcGFydC4gYHRlYXJkb3duKClgIHJ1bnMgQVQgTU9TVCBPTkNFXG4gKiBmcm9tIGV2ZXJ5IHBhdGggdGhlcmUgaXMg4oCUIGBjYW5jZWwoKWAsIGFuIGFib3J0IG9uIHRoZSByZXF1ZXN0IHNpZ25hbCwgYW5kXG4gKiB0aGUgYmVsdC1hbmQtYnJhY2VzIGVucXVldWUgY2F0Y2gg4oCUIGFuZCBpdCBpcyB3aGVyZSB0aGUgc3Vic2NyaWJlciBjb3VudCBhbmRcbiAqIGFueSBwcmVzZW5jZSBkZWNyZW1lbnQgcmlkZS4gQm91bmRpbmcgcHJlc2VuY2UgYWNjdXJhY3kgaXMgYm91bmRpbmcgdGhhdFxuICogZnVubmVsLlxuICpcbiAqIOKaoCBLbm93biBob2xlLCBhY2NlcHRlZCBhbmQgaW5oZXJpdGVkOiBCdW4ncyBvd24gYGZldGNoKClgIHJlYWRlciBgLmNhbmNlbCgpYFxuICogY2xvc2VzIG5vdGhpbmcgY2xpZW50LXNpZGUgYW5kIHRoZSBzZXJ2ZXIgY2Fubm90IHNlZSBpdC4gUmVhbCBjbGllbnRzIGNsb3NlXG4gKiB0aGUgc29ja2V0LlxuICpcbiAqIOKUgOKUgCDim5QgR1JBUEVWSU5FIERPRVMgTk9UIEFET1BUIFRISVMsIEFORCBUSEUgUkVGVVNBTCBJUyBQQVJUIE9GIFRIRSBSVUxJTkcg4pSA4pSAXG4gKlxuICogUkVKRUNULVNUUlVDVFVSQUwsIHJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCkuXG4gKiBHcmFwZXZpbmUgSEFTIGFuIFNTRSByZWdpc3RyeSBhbmQgaXQgaXMgdGhlIGJ1c2llc3QgdGhpbmcgaW4gdGhlIHNwZWxsOyB0aGVcbiAqIHR3byB0eXBlcyBzaW1wbHkgY2Fubm90IGJlIGNvbnN0cnVjdGVkIGZyb20gZWFjaCBvdGhlcjpcbiAqXG4gKiAgIHRoaXMgbW9kdWxlICBgU3NlQ2xpZW50cyA9IFNldDxTc2VDbGllbnQ+YCB3aGVyZSBgU3NlQ2xpZW50ID0ge2Nsb3NlLCBzZW5kfWBcbiAqICAgICAgICAgICAgICAgIOKAlCBhIHJlZ2lzdHJ5IG9mIEFOT05ZTU9VUyBjbG9zZXJzLCBhbmQgYHNpemVgIGlzIHRoZSBvbmx5IHRoaW5nXG4gKiAgICAgICAgICAgICAgICBhbnkgYWRvcHRpbmcgZGFlbW9uIHJlYWRzIG9mZiBpdC5cbiAqICAgZ3JhcGV2aW5lICAgIGBNYXA8c3ltYm9sLCB7YWxpYXMsIGh1bWFuLCBsdXJrLCBzZW5kfT5gLCBwZXIgY2hhbm5lbC5cbiAqXG4gKiAqKlRoZSByZWFkZXJzIHRoYXQgbWFrZSB0aGVtIGluY29tcGF0aWJsZSwgY291bnRlZCByYXRoZXIgdGhhbiBhc3NlcnRlZDogU0lYXG4gKiByb3V0ZXMgcmVhZCBgYWxpYXNgL2BodW1hbmAvYGx1cmtgKiog4oCUIGBHRVQgL2NoYW5uZWxzYCAodGhyb3VnaFxuICogYGxpc3RDaGFubmVsc2Ag4oaSIGB2aXNpYmxlU3Vic2ApLCBgR0VUIC9wcmVzZW5jZWAsIGBQT1NUIC9jaGFubmVsc2AsXG4gKiBgUE9TVCAvYW5ub3VuY2VgLCBgUE9TVCAvY2hhbm5lbHMvOm5hbWUvbWVzc2FnZXNgLCBhbmRcbiAqIGBHRVQgL2NoYW5uZWxzLzpuYW1lL3N1YnNjcmliZXJzYC4gYGFsaWFzYCBpcyBhIG5hbWUgYSBodW1hbiBzZWVzIGluIGEgcm9zdGVyLFxuICogYGh1bWFuYCB0ZWxscyBhbiBhZ2VudCBpdCBpcyB0YWxraW5nIHRvIGEgcGVyc29uLCBhbmQgYGx1cmtgIGV4Y2x1ZGVzIGFcbiAqIGNvbm5lY3Rpb24gZnJvbSBldmVyeSBwcmVzZW5jZSBjb3VudC4gVGhlcmUgaXMgbm8gd2F5IHRvIHB1dCBhbnkgb2YgdGhhdCBpbnRvXG4gKiBhIHNldCBvZiBjbG9zZXJzLiBBZG9wdGluZyB0aGlzIG1vZHVsZSB3b3VsZCBub3QgYmUgZGVhZCBjb2RlOyBpdCB3b3VsZCBiZSBhXG4gKiByZXdyaXRlIG9mIHdoYXQgZ3JhcGV2aW5lIElTLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgTElTVCBJUyBERUxJQkVSQVRFTFkgTk9UIFRIRSBPQlZJT1VTIE9ORS4qKiBUaGUgcG9ydCdzIGZpcnN0XG4gKiBjb3VudCBuYW1lZCB0aGUgYHJvbGxgL2NsZWFyIGJyb2FkY2FzdCwgdGhlIGFyY2hpdmUgbGl2ZS1ndWFyZCBhbmQgdHdvXG4gKiBSRUdJU1RSQVRJT05TIOKAlCBhbmQgZXZlcnkgb25lIG9mIHRob3NlIGlzIGEgc2l0ZSB0aGlzIG1vZHVsZSdzIHR5cGUgd291bGRcbiAqIHNlcnZlIHBlcmZlY3RseTogdGhlIGJyb2FkY2FzdCByZWFkcyBvbmx5IGBzLnNlbmRgLCB0aGUgbGl2ZS1ndWFyZCBvbmx5XG4gKiBgc3Vic2NyaWJlcnMuc2l6ZWAgKHdoaWNoIHRoaXMgaGVhZGVyIGl0c2VsZiBzYXlzIGlzIGFsbCBhbnkgYWRvcHRlciByZWFkcyksXG4gKiBhbmQgYSByZWdpc3RyYXRpb24gV1JJVEVTIHRoZSByZWNvcmQgcmF0aGVyIHRoYW4gcmVhZGluZyBpdC4gVGhlIHNpeCBhYm92ZSBhcmVcbiAqIHRoZSBvbmVzIHRoYXQgcmVhZCBhIGZpZWxkIHRoZSBraXQncyBgU3NlQ2xpZW50YCBkb2VzIG5vdCBoYXZlOyB0aGUgd3JpdGVyc1xuICogKGAvd2FpdGAncyBwcmVzZW5jZSByZWdpc3RyYXRpb24gYW5kIHRoZSB0YWlsJ3MpIGFyZSBuYW1lZCBzZXBhcmF0ZWx5IGJlY2F1c2VcbiAqIGEgd3JpdGVyIGlzIG5vdCBldmlkZW5jZSBvZiBhbnl0aGluZy4gQ291bnRlZCBpbiB0aGUgcHJlLXBvcnQgZGFlbW9uLFxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9ncmFwZXZpbmUvc2NyaXB0cy9kYWVtb24udHNgIG9uIGBkZXZlbG9wYDpcbiAqIGwuNDIxLCA3MzktNzQ3LCA4MjYsIDg4Ni04ODcsIDEwNDktMTA1NCwgMTE4Mi0xMTg4IOKAlCB3cml0ZXJzIGF0IDExMTEtMTExMiBhbmRcbiAqIDEzMDcuIChDb3JyZWN0ZWQgMjAyNi0wOS0wOSBpbiB0aGUgcmVwYWlyIGNoYXB0ZXI7IEQ2OCdzIHJlcXVpcmVtZW50IGlzIHRoYXRcbiAqIHRoZSByZWZ1c2FsIGJlIHdyaXR0ZW4gd2hlcmUgdGhlIG5leHQgcmVhZGVyIG1lZXRzIGl0LCB3aGljaCBtYWtlcyBhXG4gKiBtaXMtbWVhc3VyZWQgbGlzdCB3b3JzZSB0aGFuIG5vbmUuKVxuICpcbiAqIOKaoCBBbmQgZ3JhcGV2aW5lJ3MgcmVjb3JkcyBjYXJyeSBubyBgY2xvc2VgIGF0IGFsbCDigJQgdGhlIHBlci1zdHJlYW0gdGVhcmRvd24gaXNcbiAqIGEgY2xvc3VyZSBzdGFzaGVkIG9uIHRoZSBSZWFkYWJsZVN0cmVhbSBjb250cm9sbGVyLCByZWFjaGFibGUgb25seSBmcm9tXG4gKiBgY2FuY2VsKClgIOKAlCB3aGljaCBpcyBhbHNvIHdoeSBgaG91c2VrZWVwaW5nYCdzIGBkcmFpbkFuZFN0b3BgIGlzIGFkb3B0ZWRcbiAqIHRoZXJlIHdpdGggaXRzIGBjbGllbnRzYCBhcmd1bWVudCBkZWxpYmVyYXRlbHkgZW1wdHkuXG4gKlxuICogKipUaGUgd2lkZW5pbmcgTk9UIGRvbmUsIHdpdGggaXRzIGNvc3Q6KiogYWRtaXR0aW5nIGFuIGFsaWFzLWJlYXJpbmcgcmVjb3JkXG4gKiB3b3VsZCBjaGFuZ2UgdGhlIHR5cGUgZml2ZSBvdGhlciBkYWVtb25zIGNvbXBpbGUgYWdhaW5zdCBhbmQgcmUtZW1pdCBTSVhcbiAqIGFydGlmYWN0cyBhY3Jvc3MgRklWRSBzcGVsbHMsIGVhY2ggb3dlZCBhIGRyaXZlLiBJdCB3b3VsZCBhbHNvIHJlLWNyZWF0ZSB0aGVcbiAqIHRoaW5nIHRoaXMgcmVnaXN0cnkgZXhpc3RzIHRvIHN0b3AsIGFuZCB0aGlzIGZpbGUncyBvd24gYm91bmRhcnkgcGFyYWdyYXBoXG4gKiBzYXlzIGhvdzogYSBzaWduYXR1cmUgd2lkZSBlbm91Z2ggdG8gYWJzb3JiIGV2ZXJ5IGNhbGxlcidzIHNoYXBlIHN0b3BzIGJlaW5nIGFcbiAqIHJlZ2lzdHJ5IGFuZCBiZWNvbWVzIGEgdW5pb24uIFRoZSBjZW5zdXMgY29udmVyZ2VkIGNvcGllcyBpbnRvIG9uZSBtb2R1bGUgYnlcbiAqIGZpbmRpbmcgd2hhdCB0aGV5IFNIQVJFRDsgYSBtb2R1bGUgd2lkZW5lZCB0byBmaXQgdGhlIG9uZSBzcGVsbCB0aGF0IHNoYXJlc1xuICogbm90aGluZyBpcyB0aG9zZSBjb3BpZXMgYWdhaW4gd2l0aCBhIHVuaW9uIHR5cGUgb3ZlciB0aGUgdG9wLiBUaGUgc3BlbGwga2VlcHNcbiAqIGl0cyBvd24sIGFuZCBhIHdpZGVuaW5nIHJlbWFpbnMgYSBzZXBhcmF0ZSwgYXJndWVkIGRlY2lzaW9uLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRXZlbnRMb2csIEZyYW1lIH0gZnJvbSBcIi4vZXZlbnRMb2cudHNcIjtcblxuLyoqXG4gKiBPbmUgb3BlbiBTU0Ugc3RyZWFtLCBhcyB0aGUgZGFlbW9uIGNhbiBhY3Qgb24gaXQ6IGVuZCBpdCwgb3IgcHVzaCBhIGZyYW1lIHRvXG4gKiBpdCB0aGF0IGRpZCBub3QgY29tZSBvdXQgb2YgdGhlIGxvZy5cbiAqXG4gKiDim5QgSVQgSVMgTk9UIEEgQ09OVFJPTExFUi4gVGhlIGNvcGllcyBoZWxkXG4gKiBgU2V0PFJlYWRhYmxlU3RyZWFtRGVmYXVsdENvbnRyb2xsZXI+YCBhbmQgY2xvc2VkIHRoZW0gZGlyZWN0bHkgYXQgdGVhcmRvd24sXG4gKiB3aGljaCBieXBhc3NlcyB0aGUgdGVhcmRvd24gZnVubmVsIGFib3ZlIOKAlCB0aGUgaGVhcnRiZWF0IGludGVydmFsIGZvciB0aGF0XG4gKiBzdHJlYW0gd2FzIGNsZWFyZWQgb25seSBiZWNhdXNlIGEgc2Vjb25kIGBTZXRgIG9mIHRpbWVycyB3YXMga2VwdCBpbiBwYXJhbGxlbFxuICogYW5kIHN3ZXB0IHNlcGFyYXRlbHkuIEV2ZXJ5dGhpbmcgaGVyZSBnb2VzIHRocm91Z2ggdGhlIGZ1bm5lbCwgYW5kIGEgYHNlbmRgXG4gKiBhZnRlciB0ZWFyZG93biBpcyBhIG5vLW9wIHJhdGhlciB0aGFuIGEgdGhyb3cuXG4gKlxuICog4pqgICoqYHNlbmRgIEFSUklWRUQgSU4gUEhBU0UgMiwgRlJPTSBUSEUgRklSU1QgQ09OU1VNRVIgVEhBVCBXQVMgTk9UIE9ORSBPRiBUSEVcbiAqIFRXTyBUSElTIE1PRFVMRSBXQVMgREVTSUdORUQgQUdBSU5TVC4qKiBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSBhbm5vdW5jZSBwcmVzZW5jZVxuICogb3ZlciB0aGVpciBicm93c2VyIFdFQlNPQ0tFVCwgc28gYSByZWdpc3RyeSBvZiBiYXJlIGNsb3NlcnMgd2FzIHN1ZmZpY2llbnQgYW5kXG4gKiB0aGUgYm91bmRhcnkgbG9va2VkIHJpZ2h0LiBnbGFtb3VyIGFubm91bmNlcyBpdCBvbiB0aGUgQUdFTlQncyBTU0UgdGFpbCDigJRcbiAqIGB7dHlwZTpcImNvbm5lY3RlZFwifWAgLyBge3R5cGU6XCJkaXNjb25uZWN0ZWRcIn1gLCBkZWxpYmVyYXRlbHkgdW5sb2dnZWQsIHNvIGFcbiAqIHJlY29ubmVjdGluZyBhZ2VudCBkb2VzIG5vdCByZS1zZWUgZXZlcnkgcGFzdCBjb25uZWN0IGFuZCBzbyB0aGUgZnJhbWUgbmV2ZXJcbiAqIGFkdmFuY2VzIGEgdGFpbCBjdXJzb3IuIFRoYXQgaXMgbm90IGEgZ2xhbW91ciBxdWlyazsgaXQgaXMgdGhlIGdlbmVyYWwgc2hhcGVcbiAqIG9mIFwidGVsbCB0aGUgbGl2ZSBzdWJzY3JpYmVycyBzb21ldGhpbmcgdGhhdCBpcyBub3QgcGFydCBvZiB0aGUgaGlzdG9yeVwiLCBhbmRcbiAqIGEgcmVnaXN0cnkgdGhhdCBjYW4gb25seSBFTkQgYSBzdHJlYW0gY2Fubm90IGV4cHJlc3MgaXQuIFdpdGhvdXQgdGhpcyB0aGVcbiAqIHNwZWxsIHdvdWxkIGhhdmUgaGFkIHRvIGtlZXAgaXRzIG93biBwYXJhbGxlbCBgU2V0YCBvZiBjb250cm9sbGVycywgd2hpY2ggaXNcbiAqIGV4YWN0bHkgdGhlIGRyaWZ0IHRoaXMgcmVnaXN0cnkgZXhpc3RzIHRvIHJlbW92ZS5cbiAqL1xuZXhwb3J0IHR5cGUgU3NlQ2xpZW50ID0ge1xuICAvKiogRW5kIHRoaXMgc3RyZWFtLCB0aHJvdWdoIHRoZSB0ZWFyZG93biBmdW5uZWwsIGF0IG1vc3Qgb25jZS4gKi9cbiAgY2xvc2UoKTogdm9pZDtcbiAgLyoqIFdyaXRlIG9uZSByYXcgU1NFIGNodW5rIHRvIHRoaXMgc3RyZWFtLiBOby1vcCBvbmNlIHRvcm4gZG93bi4gKi9cbiAgc2VuZChjaHVuazogc3RyaW5nKTogdm9pZDtcbn07XG5cbi8qKlxuICogVGhlIGxpdmUtdGFpbCByZWdpc3RyeS4gYHNpemVgIGlzIHRoZSBkYWVtb24ncyBTU0Ugc3Vic2NyaWJlciBjb3VudCDigJQgdGhlXG4gKiBudW1iZXIgYHNob3VsZElkbGVDbG9zZWAgbXVzdCBzZWUg4oCUIGFuZCBjbG9zaW5nIGV2ZXJ5IGVudHJ5IGlzIHdoYXQgYSBkcmFpblxuICogZG9lcy5cbiAqL1xuZXhwb3J0IHR5cGUgU3NlQ2xpZW50cyA9IFNldDxTc2VDbGllbnQ+O1xuXG5leHBvcnQgaW50ZXJmYWNlIFNzZU9wdGlvbnM8VCBleHRlbmRzIG9iamVjdD4ge1xuICAvKiogVGhlIGxvZyB0byByZXBsYXkgZnJvbSBhbmQgc3Vic2NyaWJlIHRvLiAqL1xuICBsb2c6IEV2ZW50TG9nPFQ+O1xuICAvKiogVGhlIGNhbGxlcidzIHJlc3VtZSBjdXJzb3IuIEFic2VudCBvciB1bnBhcnNlYWJsZSByZXBsYXlzIGZyb20gdGhlIHN0YXJ0LiAqL1xuICBzaW5jZTogbnVtYmVyO1xuICAvKiogSGVhcnRiZWF0IGNvbW1lbnQgaW50ZXJ2YWwuIE1VU1Qgc3RheSB3ZWxsIHVuZGVyIHRoZSBzZXJ2ZXInc1xuICAgKiAgYGlkbGVUaW1lb3V0YCDigJQgc2VlIGBoZWFydGJlYXQudHNgLCB3aGljaCBpcyB3aGVyZSB0aGF0IHBhaXIgbGl2ZXMuICovXG4gIGhlYXJ0YmVhdE1zOiBudW1iZXI7XG4gIC8qKiBMaXZlbmVzcyByZWdpc3RyeTsgdGhlIHN0cmVhbSBhZGRzIGl0c2VsZiBvbiBvcGVuIGFuZCByZW1vdmVzIGl0c2VsZiBpblxuICAgKiAgdGhlIHRlYXJkb3duIGZ1bm5lbC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBgcmVxLnNpZ25hbGAg4oCUIHRoZSBvbmx5IHRoaW5nIHRoYXQgcmVjbGFpbXMgYSBjbGllbnQgdGhhdCB3ZW50IGF3YXlcbiAgICogIHdpdGhvdXQgY2FuY2VsbGluZyB0aGUgc3RyZWFtLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqIFNlcnZlci1zaWRlIGZpbHRlci4gQSByZWplY3RlZCBmcmFtZSBpcyBub3Qgc2VudDsgdGhlIGNsaWVudCBzdGlsbFxuICAgKiAgYWR2YW5jZXMgaXRzIGN1cnNvciBwYXN0IGl0LCB3aGljaCBpcyBgdGFpbEV2ZW50c2AncyBkb2N1bWVudGVkIHJ1bGUuICovXG4gIGZpbHRlcj86IChmcmFtZTogRnJhbWU8VD4pID0+IGJvb2xlYW47XG4gIC8qKlxuICAgKiBSYXcgU1NFIGNodW5rcyB3cml0dGVuIHRvIFRISVMgc3RyZWFtIEJFRk9SRSB0aGUgcmVwbGF5IOKAlCBhZnRlciB0aGVcbiAgICogYFwiOiBjb25uZWN0ZWRcImAgcHJlYW1ibGUgYW5kIGJlZm9yZSBgbG9nLnN1YnNjcmliZWAsIHNvIHdoYXRldmVyIGl0IHJldHVybnNcbiAgICogaXMgdGhlIHN0cmVhbSdzIGZpcnN0IERBVEEgbGluZSByYXRoZXIgdGhhbiBhIGZyYW1lIGJ1cmllZCBiZWhpbmQgYVxuICAgKiByZXBsYXllZCBiYWNrbG9nLlxuICAgKlxuICAgKiDim5QgSVQgSVMgQSBQT1NJVElPTiwgV0hJQ0ggSVMgV0hZIGBvbk9wZW5gIENPVUxEIE5PVCBTRVJWRSAoRDg1KS4gYG9uT3BlbmBcbiAgICogZmlyZXMgYXQgdGhlIGVuZCBvZiBgc3RhcnRgIOKAlCBhZnRlciB0aGUgcHJlYW1ibGUsIGFmdGVyIGBsb2cuc3Vic2NyaWJlYCxcbiAgICogYWZ0ZXIgYGNsaWVudHMuYWRkYCDigJQgc28gYSBjYWxsZXIgdGhhdCBzdXBwbGllcyBpdHMgb3duIGBjbGllbnRzYCBzZXQgYW5kXG4gICAqIHNlbmRzIGZyb20gdGhlcmUgbGFuZHMgaXRzIGZyYW1lIEFGVEVSIHRoZSBiYWNrbG9nLiBUaGF0IGlzIGV4cHJlc3NpYmxlIGFuZFxuICAgKiBpdCBpcyB0aGUgd3Jvbmcgb3JkZXIsIHdoaWNoIGlzIHRoZSBuZWFyLW1pc3MgdGhhdCBtYWtlcyB0aGlzIGEgbWVhc3VyZW1lbnRcbiAgICogcmF0aGVyIHRoYW4gYW4gYXNzZXJ0aW9uOiBub3RoaW5nIGFib3V0IHRoZSBUWVBFUyBwcmV2ZW50cyBpdCwgYW5kIGFcbiAgICogdHlwZS10by10eXBlIGNvbXBhdGliaWxpdHkgY2hlY2sgY2Fubm90IHNlZSBhIHBvc2l0aW9uLlxuICAgKlxuICAgKiDim5QgUkVTVE9SRUQgRlJPTSBUSEUgU1BFTEwgVEhJUyBNT0RVTEUgV0FTIENPTlZFUkdFRCBUT1dBUkQsIEFORCBJVCBJUyBBXG4gICAqIFJFU1RPUkFUSU9OIFJBVEhFUiBUSEFOIEEgV0lERU5JTkcgT04gVFdPIE1FQVNVUkVEIE5VTUJFUlMgKEQ3OS9EODUpLlxuICAgKiBtaW5kLW1hcHBlcidzIGBzc2VSZXNwb25zZWAgd3JvdGUgaXRzIGB0YWlsIC0taW5ib3VuZGAgZ3JvdW5kaW5nIGZyYW1lIG9uZVxuICAgKiBsaW5lIEFCT1ZFIGBidXMuc3Vic2NyaWJlYDsgdGhpcyBtb2R1bGUncyBjb252ZXJnZW5jZSBkcm9wcGVkIHRoZSBwb3NpdGlvbixcbiAgICogc28gdGhlIG9ubHkgcHJvcGVydHkgbWluZC1tYXBwZXIgY291bGQgbm90IGFkb3B0IHdhcyB0aGUgb3JkZXJpbmcuIEFwcGxpZWQsXG4gICAqIHdpdGggZXZlcnkga2l0LWJ1bmRsaW5nIHNwZWxsIHJlYnVpbHQ6ICoqKGEpIHNvdXJjZSBlZGl0cyBuZWVkZWQgYXQgdGhlXG4gICAqIG90aGVyIGZpdmUgYWRvcHRlcnM6IFpFUk8qKiDigJQgdGhlIGZpZWxkIGlzIG9wdGlvbmFsIGFuZCBub2JvZHkgcGFzc2VzIGl0O1xuICAgKiAqKihiKSBieXRlcyBvZiBhbnkgb3RoZXIgYWRvcHRlcidzIFdJUkUgdGhhdCBkaWZmZXI6IFpFUk8qKiDigJQgYXN0cm9sYWJlLFxuICAgKiBib3VudHksIGdsYW1vdXIsIGltYWdvIGFuZCBtYWdwaWUgd2VyZSBkcml2ZW4gdW5kZXIgdGhlaXIgb3duIHN1aXRlcyBhbmRcbiAgICogdGhlaXIgcmVsZWFzZSBkcml2ZXMsIGFuZCBub25lIG9mIHRoZW0gd3JpdGVzIGF0IG9wZW4uIEJvdGggbnVtYmVycyB6ZXJvIGlzXG4gICAqIHdoYXQgXCJ0aGUga2l0IHJlbW92ZWQgaXQgd2hlbiBpdCBjb3BpZWRcIiBtZWFucyBvcGVyYXRpb25hbGx5LlxuICAgKlxuICAgKiDimqAgQU5EIFRIRSBIT09LIFdBUyBSRUpFQ1RFRCBPTkNFLCBGT1IgQSBSRUFTT04gVEhBVCBET0VTIE5PVCBSRUFDSCBUSElTXG4gICAqIENBU0UuIEQzMidzIG5vdC10YWtlbiBhcmd1ZWQgYWdhaW5zdCBcImEgYHNzZVJlc3BvbnNlYCBob29rIHRoYXQgaGFuZHMgdGhlXG4gICAqIGNhbGxlciBhIHJhdyBgc2VuZGAg4oCmIHRoZSBjYWxsZXIgdGhlbiBoYXMgdG8ga2VlcCBpdHMgb3duIGNvbGxlY3Rpb24gb2ZcbiAgICogdGhlbVwiIOKAlCBhZ2FpbnN0IGdsYW1vdXIncyBwcmVzZW5jZSBCUk9BRENBU1QsIHdoaWNoIHB1c2hlcyB0b1xuICAgKiBhbHJlYWR5LW9wZW4gc3RyZWFtcyBmcm9tIG91dHNpZGUgYW5kIGRvZXMgbmVlZCBhIGNvbGxlY3Rpb24uIFRoaXMgaXMgb25lXG4gICAqIGZyYW1lLCBvbiBvbmUgc3RyZWFtLCBhdCBvcGVuLCBhbmQgdGhlIGNhbGxlciBrZWVwcyBubyBjb2xsZWN0aW9uIGF0IGFsbC5cbiAgICogQSByZWplY3Rpb24gaXMgc2NvcGVkIHRvIHRoZSBjYXNlIHRoYXQgcHJvZHVjZWQgaXQuXG4gICAqL1xuICBvcGVuRnJhbWVzPzogKCkgPT4gc3RyaW5nW107XG4gIC8qKiBSdW4gYWZ0ZXIgdGhlIHN0cmVhbSBpcyBzdWJzY3JpYmVkIChwcmVzZW5jZSB1cCwgYWN0aXZpdHkgdG91Y2gpLiAqL1xuICBvbk9wZW4/OiAoKSA9PiB2b2lkO1xuICAvKiogUnVuIGV4YWN0bHkgb25jZSwgZnJvbSB3aGljaGV2ZXIgdGVhcmRvd24gcGF0aCBmaXJlcyBmaXJzdC4gKi9cbiAgb25DbG9zZT86ICgpID0+IHZvaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzc2VSZXNwb25zZTxUIGV4dGVuZHMgb2JqZWN0PihvcHRzOiBTc2VPcHRpb25zPFQ+KTogUmVzcG9uc2Uge1xuICBjb25zdCB7IGxvZywgc2luY2UsIGhlYXJ0YmVhdE1zLCBjbGllbnRzLCBzaWduYWwsIGZpbHRlciwgb3BlbkZyYW1lcywgb25PcGVuLCBvbkNsb3NlIH0gPSBvcHRzO1xuXG4gIGxldCB1bnN1YnNjcmliZTogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGxldCBrZWVwYWxpdmU6IFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPiB8IG51bGwgPSBudWxsO1xuICBsZXQgY2xvc2VkID0gZmFsc2U7XG4gIC8vIFRoZSByZWdpc3RyeSBlbnRyeSBmb3IgVEhJUyBzdHJlYW0uIEl0cyBtZXRob2RzIGFyZSBmaWxsZWQgaW4gYnkgYHN0YXJ0YCxcbiAgLy8gd2hpY2ggaXMgd2hlcmUgdGhlIGNvbnRyb2xsZXIgZXhpc3RzOyB0aGUgb2JqZWN0IGlkZW50aXR5IGlzIHN0YWJsZSBmcm9tXG4gIC8vIGhlcmUgc28gYHRlYXJkb3duYCBjYW4gcmVtb3ZlIGV4YWN0bHkgdGhpcyBlbnRyeS5cbiAgY29uc3QgY2xpZW50OiBTc2VDbGllbnQgPSB7IGNsb3NlOiAoKSA9PiB7fSwgc2VuZDogKCkgPT4ge30gfTtcblxuICBjb25zdCB0ZWFyZG93biA9ICgpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBpZiAoa2VlcGFsaXZlICE9PSBudWxsKSBjbGVhckludGVydmFsKGtlZXBhbGl2ZSk7XG4gICAgdW5zdWJzY3JpYmU/LigpO1xuICAgIGNsaWVudHM/LmRlbGV0ZShjbGllbnQpO1xuICAgIG9uQ2xvc2U/LigpO1xuICB9O1xuXG4gIGNvbnN0IHN0cmVhbSA9IG5ldyBSZWFkYWJsZVN0cmVhbSh7XG4gICAgc3RhcnQoY29udHJvbGxlcikge1xuICAgICAgY29uc3QgZW5jb2RlciA9IG5ldyBUZXh0RW5jb2RlcigpO1xuICAgICAgY29uc3Qgc2FmZUVucXVldWUgPSAoY2h1bms6IHN0cmluZykgPT4ge1xuICAgICAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29udHJvbGxlci5lbnF1ZXVlKGVuY29kZXIuZW5jb2RlKGNodW5rKSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHRlYXJkb3duKCk7XG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBjbGllbnQuY2xvc2UgPSAoKSA9PiB7XG4gICAgICAgIHRlYXJkb3duKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29udHJvbGxlci5jbG9zZSgpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAvKiBhbHJlYWR5IGNsb3NlZCBieSB0aGUgcnVudGltZSAqL1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgLy8g4puUIGBzZW5kYCBHT0VTIFRIUk9VR0ggYHNhZmVFbnF1ZXVlYCwgc28gYW4gb3V0LW9mLWJhbmQgZnJhbWUgb2JleXMgdGhlXG4gICAgICAvLyBzYW1lIGNsb3NlZC1jaGVjayBhbmQgdGhlIHNhbWUgdGVhcmRvd24tb24tdGhyb3cgYXMgYSBsb2dnZWQgb25lLiBBXG4gICAgICAvLyBkYWVtb24gbXVzdCBub3QgYmUgYWJsZSB0byB3cml0ZSB0byBhIHN0cmVhbSB0aGlzIG1vZHVsZSBoYXMgdG9ybiBkb3duLlxuICAgICAgY2xpZW50LnNlbmQgPSBzYWZlRW5xdWV1ZTtcblxuICAgICAgLy8g4puUIEFOIE9QRU5JTkcgQ09NTUVOVCwgQkVGT1JFIEFOWVRISU5HIEVMU0UuIEl0IGZsdXNoZXMgdGhlIHJlc3BvbnNlXG4gICAgICAvLyBoZWFkZXJzIGltbWVkaWF0ZWx5OiBzb21lIEhUVFAgY2xpZW50cyDigJQgQnVuJ3Mgb3duIGBmZXRjaCgpYCBpbmNsdWRlZCDigJRcbiAgICAgIC8vIGJ1ZmZlciB1bnRpbCB0aGUgZmlyc3QgYnl0ZSBvZiBib2R5IGFycml2ZXMsIHNvIGEgZ2VudWluZWx5IHF1aWV0IFNTRVxuICAgICAgLy8gc3RyZWFtIHdvdWxkIG90aGVyd2lzZSBsZWF2ZSB0aGUgY2FsbGVyJ3MgYGZldGNoKClgIHVucmVzb2x2ZWQuIEV2ZXJ5XG4gICAgICAvLyBob3VzZSB0YWlsIGNsaWVudCByZWFkcyBgOmAgbGluZXMgYXMgY29tbWVudHMgYW5kIGRyb3BzIHRoZW0uXG4gICAgICBzYWZlRW5xdWV1ZShcIjogY29ubmVjdGVkXFxuXFxuXCIpO1xuXG4gICAgICAvLyDim5QgQkVGT1JFIFRIRSBSRVBMQVksIEFORCBUSEUgT1JERVIgSVMgVEhFIFdIT0xFIFBPSU5UIOKAlCBzZWVcbiAgICAgIC8vIGBvcGVuRnJhbWVzYCBpbiB0aGUgb3B0aW9ucyBhYm92ZS4gQSBncm91bmRpbmcgZnJhbWUgd3JpdHRlbiBoZXJlIGlzXG4gICAgICAvLyB0aGUgc3RyZWFtJ3MgZmlyc3QgZGF0YSBsaW5lOyB3cml0dGVuIGZyb20gYG9uT3BlbmAgaXQgYXJyaXZlcyBhZnRlclxuICAgICAgLy8gdGhlIHJlcGxheWVkIGJhY2tsb2csIHdoaWNoIGlzIGEgZGlmZmVyZW50IGNvbnRyYWN0IHdlYXJpbmcgdGhlIHNhbWVcbiAgICAgIC8vIHR5cGVzLlxuICAgICAgaWYgKG9wZW5GcmFtZXMpIGZvciAoY29uc3QgY2h1bmsgb2Ygb3BlbkZyYW1lcygpKSBzYWZlRW5xdWV1ZShjaHVuayk7XG5cbiAgICAgIHVuc3Vic2NyaWJlID0gbG9nLnN1YnNjcmliZShzaW5jZSwgKGZyYW1lKSA9PiB7XG4gICAgICAgIGlmIChmaWx0ZXIgJiYgIWZpbHRlcihmcmFtZSkpIHJldHVybjtcbiAgICAgICAgc2FmZUVucXVldWUoYGRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZnJhbWUpfVxcblxcbmApO1xuICAgICAgfSk7XG5cbiAgICAgIGtlZXBhbGl2ZSA9IHNldEludGVydmFsKCgpID0+IHNhZmVFbnF1ZXVlKFwiOiBoYlxcblxcblwiKSwgaGVhcnRiZWF0TXMpO1xuICAgICAgc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgdGVhcmRvd24sIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgIGNsaWVudHM/LmFkZChjbGllbnQpO1xuICAgICAgb25PcGVuPy4oKTtcbiAgICB9LFxuICAgIGNhbmNlbCgpIHtcbiAgICAgIHRlYXJkb3duKCk7XG4gICAgfSxcbiAgfSk7XG5cbiAgcmV0dXJuIG5ldyBSZXNwb25zZShzdHJlYW0sIHtcbiAgICBoZWFkZXJzOiB7XG4gICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcInRleHQvZXZlbnQtc3RyZWFtXCIsXG4gICAgICBcIkNhY2hlLUNvbnRyb2xcIjogXCJuby1jYWNoZVwiLFxuICAgICAgQ29ubmVjdGlvbjogXCJrZWVwLWFsaXZlXCIsXG4gICAgfSxcbiAgfSk7XG59XG4iLAogICAgIi8vIENvbXBhcmluZyB0d28gdGV4dHMsIGFuZCB0YWtpbmcgcGFydCBvZiBvbmUgaW50byB0aGUgb3RoZXIgKEUzNikuXG4vL1xuLy8g4puUIE9ORSBESUZGLCBDT01QVVRFRCBJTiBUSEUgREFFTU9OLiBgQGNvZGVtaXJyb3IvbWVyZ2VgIHdhcyBtZWFzdXJlZCBmaXJzdFxuLy8gYW5kIGl0IGlzIGJ1bmRsZS1jbGVhbiDigJQgaXRzIG9ubHkgZGVwZW5kZW5jaWVzIGFyZSBgQGNvZGVtaXJyb3IvbGFuZ3VhZ2VgLFxuLy8gYHN0YXRlYCwgYHZpZXdgIGFuZCBgQGxlemVyL2hpZ2hsaWdodGAsIGV2ZXJ5IG9uZSBvZiB3aGljaCB0aGUgc3VyZmFjZVxuLy8gYWxyZWFkeSBzaGlwcywgc28gd2FyZCAxYiBoYXMgbm90aGluZyB0byBzYXkgYWJvdXQgaXQuIEl0IGlzIG5vdCB1c2VkXG4vLyBhbnl3YXksIGFuZCB0aGUgcmVhc29uIGlzIG5vdCB3ZWlnaHQ6IGl0IHdvdWxkIGdpdmUgdGhlIFNVUkZBQ0UgaXRzIG93blxuLy8gZGlmZiB3aGlsZSB0aGUgYGRpZmZgIENMSSB2ZXJiIHVzZWQgdGhpcyBtb2R1bGUncywgYW5kIGEgaHVuayB0aGUgaHVtYW5cbi8vIGFjY2VwdHMgd291bGQgdGhlbiBiZSBhIGh1bmsgYSBkaWZmZXJlbnQgZW5naW5lIGZvdW5kLiBUd28gZGlmZiBlbmdpbmVzIG92ZXJcbi8vIG9uZSBkb2N1bWVudCBpcyB0aGUgbG9ja3N0ZXAtbWlycm9yIGRyaWZ0IHRoaXMgcmVwbyBoYXMgYWxyZWFkeSBwYWlkIGZvclxuLy8gb25jZS4gVGhlIHN1cmZhY2UgcmVuZGVycyB0aGUgaHVua3MgdGhlIGRhZW1vbiBjb21wdXRlZCwgYW5kIGBtZXJnZWAgYXBwbGllc1xuLy8gdGhlIHNhbWUgb25lcyDigJQgc28gYSBtaXNtYXRjaCBpcyBub3QgYSBidWcgdGhhdCBjYW4gYmUgd3JpdHRlbiBoZXJlLlxuLy9cbi8vIFdoYXQgdGhpcyBkZWxpYmVyYXRlbHkgaXMgbm90OiBhIHNlbWFudGljIG9yIHN5bnRhY3RpYyBkaWZmLiBJdCBjb21wYXJlc1xuLy8gTElORVMsIHRoZW4gcmVmaW5lcyBpbnNpZGUgcGFpcmVkIGxpbmVzIGJ5IFdPUkQsIHdoaWNoIGlzIHdoYXQgYSBwcm9zZVxuLy8gcmVhZGVyIHdhbnRzIOKAlCBtb3ZlZCBwYXJhZ3JhcGhzIHJlYWQgYXMgYSBkZWxldGUgYW5kIGFuIGFkZCwgYW5kIHRoYXQgaXNcbi8vIHRoZSBob25lc3QgYW5zd2VyIHJhdGhlciB0aGFuIGEgd3JvbmcgY2xldmVyIG9uZS5cbmltcG9ydCB0eXBlIHsgRGlmZiwgRGlmZkh1bmssIERpZmZMaW5lLCBEaWZmU3BhbiB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKlxuICogU3BsaXR0aW5nIG9uIFwiXFxuXCIgYW5kIGpvaW5pbmcgb24gXCJcXG5cIiByb3VuZC10cmlwcyBleGFjdGx5LCBJTkNMVURJTkcgdGhlXG4gKiB0cmFpbGluZyBlbXB0eSBzdHJpbmcgYSBmaWxlIGVuZGluZyBpbiBhIG5ld2xpbmUgcHJvZHVjZXMuIFRoYXQgZW1wdHkgbGluZVxuICogaXMgcmVhbCBhcyBmYXIgYXMgdGhpcyBtb2R1bGUgaXMgY29uY2VybmVkLCB3aGljaCBpcyB3aGF0IGtlZXBzIGEgbWVyZ2UgZnJvbVxuICogcXVpZXRseSBhZGRpbmcgb3IgZHJvcHBpbmcgYSBmaW5hbCBuZXdsaW5lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3BsaXRMaW5lcyh0ZXh0OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiB0ZXh0LnNwbGl0KFwiXFxuXCIpO1xufVxuXG4vKipcbiAqIFRoZSBjYXAgb24gTXllcnMnIEQg4oCUIHRoZSBudW1iZXIgb2YgZWRpdHMgaXQgd2lsbCB3YWxrIGJlZm9yZSBnaXZpbmcgdXAuXG4gKiBUd28gdGV4dHMgZGlmZmVyaW5nIGJ5IG1vcmUgdGhhbiB0aGlzIGFyZSBub3Qgc29tZXRoaW5nIGEgaHVtYW4gcmVhZHMgaHVua1xuICogYnkgaHVuayBhbnl3YXksIGFuZCB0aGUgcXVhZHJhdGljIHdvcnN0IGNhc2UgaXMgd2hhdCB0aGUgY2FwIGV4aXN0cyB0byBrZWVwXG4gKiBvdXQgb2YgYSBkYWVtb24gc2VydmluZyBhIHN1cmZhY2UuXG4gKi9cbmNvbnN0IE1BWF9FRElUUyA9IDMwMDA7XG5cbi8qKlxuICogTXllcnMnIGdyZWVkeSBPKE5EKSBkaWZmIG92ZXIgbGluZXMuIFJldHVybnMgdGhlIHRyYWNlIG9mIFYgYXJyYXlzLCBvciBudWxsXG4gKiB3aGVuIHRoZSB0ZXh0cyBkaWZmZXIgYnkgbW9yZSB0aGFuIGBNQVhfRURJVFNgLlxuICovXG5mdW5jdGlvbiBteWVyc1RyYWNlKGE6IHN0cmluZ1tdLCBiOiBzdHJpbmdbXSk6IEludDMyQXJyYXlbXSB8IG51bGwge1xuICBjb25zdCBuID0gYS5sZW5ndGg7XG4gIGNvbnN0IG0gPSBiLmxlbmd0aDtcbiAgY29uc3QgbWF4ID0gTWF0aC5taW4obiArIG0sIE1BWF9FRElUUyk7XG4gIGNvbnN0IHNpemUgPSAyICogbWF4ICsgMTtcbiAgY29uc3Qgb2Zmc2V0ID0gbWF4O1xuICBsZXQgdiA9IG5ldyBJbnQzMkFycmF5KHNpemUpO1xuICBjb25zdCB0cmFjZTogSW50MzJBcnJheVtdID0gW107XG4gIGZvciAobGV0IGQgPSAwOyBkIDw9IG1heDsgZCsrKSB7XG4gICAgdHJhY2UucHVzaCh2LnNsaWNlKCkpO1xuICAgIGZvciAobGV0IGsgPSAtZDsgayA8PSBkOyBrICs9IDIpIHtcbiAgICAgIC8vIFRha2UgdGhlIGxvbmdlciBvZiB0aGUgdHdvIHJlYWNoYWJsZSBwYXRoczogZG93biAoYW4gaW5zZXJ0aW9uKSB3aGVuXG4gICAgICAvLyBrIGlzIGF0IHRoZSBsb3dlciBlZGdlIG9yIHRoZSBkb3duLW5laWdoYm91ciBoYXMgY29tZSBmdXJ0aGVyLlxuICAgICAgY29uc3QgZG93biA9IHZbb2Zmc2V0ICsgayArIDFdIGFzIG51bWJlcjtcbiAgICAgIGNvbnN0IHJpZ2h0ID0gdltvZmZzZXQgKyBrIC0gMV0gYXMgbnVtYmVyO1xuICAgICAgbGV0IHg6IG51bWJlcjtcbiAgICAgIGlmIChrID09PSAtZCB8fCAoayAhPT0gZCAmJiByaWdodCA8IGRvd24pKSB4ID0gZG93bjtcbiAgICAgIGVsc2UgeCA9IHJpZ2h0ICsgMTtcbiAgICAgIGxldCB5ID0geCAtIGs7XG4gICAgICB3aGlsZSAoeCA8IG4gJiYgeSA8IG0gJiYgYVt4XSA9PT0gYlt5XSkge1xuICAgICAgICB4Kys7XG4gICAgICAgIHkrKztcbiAgICAgIH1cbiAgICAgIHZbb2Zmc2V0ICsga10gPSB4O1xuICAgICAgaWYgKHggPj0gbiAmJiB5ID49IG0pIHJldHVybiB0cmFjZTtcbiAgICB9XG4gICAgdiA9IHYuc2xpY2UoKTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFdhbGsgdGhlIHRyYWNlIGJhY2t3YXJkcyBpbnRvIGEgbGlzdCBvZiBsaW5lIG9wZXJhdGlvbnMsIGZyb250IHRvIGJhY2suICovXG5mdW5jdGlvbiBiYWNrdHJhY2soYTogc3RyaW5nW10sIGI6IHN0cmluZ1tdLCB0cmFjZTogSW50MzJBcnJheVtdKTogRGlmZkxpbmVbXSB7XG4gIGNvbnN0IG9mZnNldCA9IE1hdGgubWluKGEubGVuZ3RoICsgYi5sZW5ndGgsIE1BWF9FRElUUyk7XG4gIGNvbnN0IG91dDogRGlmZkxpbmVbXSA9IFtdO1xuICBsZXQgeCA9IGEubGVuZ3RoO1xuICBsZXQgeSA9IGIubGVuZ3RoO1xuICBmb3IgKGxldCBkID0gdHJhY2UubGVuZ3RoIC0gMTsgZCA+PSAwOyBkLS0pIHtcbiAgICBjb25zdCB2ID0gdHJhY2VbZF0gYXMgSW50MzJBcnJheTtcbiAgICBjb25zdCBrID0geCAtIHk7XG4gICAgbGV0IHByZXZLOiBudW1iZXI7XG4gICAgaWYgKGsgPT09IC1kIHx8IChrICE9PSBkICYmICh2W29mZnNldCArIGsgLSAxXSBhcyBudW1iZXIpIDwgKHZbb2Zmc2V0ICsgayArIDFdIGFzIG51bWJlcikpKVxuICAgICAgcHJldksgPSBrICsgMTtcbiAgICBlbHNlIHByZXZLID0gayAtIDE7XG4gICAgY29uc3QgcHJldlggPSB2W29mZnNldCArIHByZXZLXSBhcyBudW1iZXI7XG4gICAgY29uc3QgcHJldlkgPSBwcmV2WCAtIHByZXZLO1xuICAgIHdoaWxlICh4ID4gcHJldlggJiYgeSA+IHByZXZZKSB7XG4gICAgICB4LS07XG4gICAgICB5LS07XG4gICAgICBvdXQucHVzaCh7IG9wOiBcInNhbWVcIiwgYTogeCwgYjogeSwgdGV4dDogYVt4XSBhcyBzdHJpbmcgfSk7XG4gICAgfVxuICAgIGlmIChkID09PSAwKSBicmVhaztcbiAgICBpZiAoeCA+IHByZXZYKSB7XG4gICAgICB4LS07XG4gICAgICBvdXQucHVzaCh7IG9wOiBcImRlbFwiLCBhOiB4LCB0ZXh0OiBhW3hdIGFzIHN0cmluZyB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgeS0tO1xuICAgICAgb3V0LnB1c2goeyBvcDogXCJhZGRcIiwgYjogeSwgdGV4dDogYlt5XSBhcyBzdHJpbmcgfSk7XG4gICAgfVxuICB9XG4gIG91dC5yZXZlcnNlKCk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBFdmVyeSBsaW5lIGFzIG9uZSByZXBsYWNlbWVudCDigJQgdGhlIGhvbmVzdCBhbnN3ZXIgd2hlbiBNeWVycyBnaXZlcyB1cC4gKi9cbmZ1bmN0aW9uIGNvYXJzZUxpbmVzKGE6IHN0cmluZ1tdLCBiOiBzdHJpbmdbXSk6IERpZmZMaW5lW10ge1xuICByZXR1cm4gW1xuICAgIC4uLmEubWFwKCh0ZXh0LCBpKSA9PiAoeyBvcDogXCJkZWxcIiBhcyBjb25zdCwgYTogaSwgdGV4dCB9KSksXG4gICAgLi4uYi5tYXAoKHRleHQsIGkpID0+ICh7IG9wOiBcImFkZFwiIGFzIGNvbnN0LCBiOiBpLCB0ZXh0IH0pKSxcbiAgXTtcbn1cblxuLyoqIEdyb3VwIHRoZSBsaW5lIG9wcyBpbnRvIGNvbnRpZ3VvdXMgaHVua3MsIG51bWJlcmVkIGZyb20gMS4gKi9cbmZ1bmN0aW9uIGNvbGxlY3QobGluZXM6IERpZmZMaW5lW10pOiBEaWZmSHVua1tdIHtcbiAgY29uc3QgaHVua3M6IERpZmZIdW5rW10gPSBbXTtcbiAgbGV0IGkgPSAwO1xuICBsZXQgaWQgPSAxO1xuICB3aGlsZSAoaSA8IGxpbmVzLmxlbmd0aCkge1xuICAgIGlmICgobGluZXNbaV0gYXMgRGlmZkxpbmUpLm9wID09PSBcInNhbWVcIikge1xuICAgICAgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IHN0YXJ0ID0gaTtcbiAgICB3aGlsZSAoaSA8IGxpbmVzLmxlbmd0aCAmJiAobGluZXNbaV0gYXMgRGlmZkxpbmUpLm9wICE9PSBcInNhbWVcIikgaSsrO1xuICAgIGNvbnN0IHJ1biA9IGxpbmVzLnNsaWNlKHN0YXJ0LCBpKTtcbiAgICBjb25zdCBkZWwgPSBydW4uZmlsdGVyKChsKSA9PiBsLm9wID09PSBcImRlbFwiKTtcbiAgICBjb25zdCBhZGQgPSBydW4uZmlsdGVyKChsKSA9PiBsLm9wID09PSBcImFkZFwiKTtcbiAgICAvLyBXaGVyZSB0aGUgaHVuayBzaXRzIGluIGVhY2ggdGV4dDogdGhlIGluZGV4IG9mIHRoZSBmaXJzdCBsaW5lIGl0IHRvdWNoZXMsXG4gICAgLy8gYW5kIGZvciBhIHB1cmUgaW5zZXJ0aW9uLCB0aGUgcG9pbnQgaXQgaXMgaW5zZXJ0ZWQgQVQuXG4gICAgY29uc3QgYUZyb20gPSBkZWwubGVuZ3RoID8gKChkZWxbMF0gYXMgRGlmZkxpbmUpLmEgYXMgbnVtYmVyKSA6IG5leHRJbmRleChsaW5lcywgc3RhcnQsIFwiYVwiKTtcbiAgICBjb25zdCBiRnJvbSA9IGFkZC5sZW5ndGggPyAoKGFkZFswXSBhcyBEaWZmTGluZSkuYiBhcyBudW1iZXIpIDogbmV4dEluZGV4KGxpbmVzLCBzdGFydCwgXCJiXCIpO1xuICAgIGh1bmtzLnB1c2goe1xuICAgICAgaWQ6IGlkKyssXG4gICAgICBhRnJvbSxcbiAgICAgIGFUbzogYUZyb20gKyBkZWwubGVuZ3RoLFxuICAgICAgYkZyb20sXG4gICAgICBiVG86IGJGcm9tICsgYWRkLmxlbmd0aCxcbiAgICAgIGRlbDogZGVsLm1hcCgobCkgPT4gbC50ZXh0KSxcbiAgICAgIGFkZDogYWRkLm1hcCgobCkgPT4gbC50ZXh0KSxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gaHVua3M7XG59XG5cbi8qKlxuICogVGhlIGluZGV4IGEgcHVyZSBpbnNlcnRpb24gb3IgZGVsZXRpb24gc2l0cyBhdDogdGhlIGxpbmUgbnVtYmVyIG9mIHRoZSBuZXh0XG4gKiBgc2FtZWAgbGluZSBvbiB0aGF0IHNpZGUsIG9yIHRoZSBlbmQgb2YgdGhhdCB0ZXh0IHdoZW4gdGhlcmUgaXMgbm9uZS5cbiAqL1xuZnVuY3Rpb24gbmV4dEluZGV4KGxpbmVzOiBEaWZmTGluZVtdLCBmcm9tOiBudW1iZXIsIHNpZGU6IFwiYVwiIHwgXCJiXCIpOiBudW1iZXIge1xuICBmb3IgKGxldCBpID0gZnJvbTsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgYXQgPSAobGluZXNbaV0gYXMgRGlmZkxpbmUpW3NpZGVdO1xuICAgIGlmIChhdCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gYXQ7XG4gIH1cbiAgbGV0IGxhc3QgPSAtMTtcbiAgZm9yIChjb25zdCBsIG9mIGxpbmVzKSB7XG4gICAgY29uc3QgYXQgPSBsW3NpZGVdO1xuICAgIGlmIChhdCAhPT0gdW5kZWZpbmVkICYmIGF0ID4gbGFzdCkgbGFzdCA9IGF0O1xuICB9XG4gIHJldHVybiBsYXN0ICsgMTtcbn1cblxuLyoqIFdvcmRzLCB3aGl0ZXNwYWNlIHJ1bnMgYW5kIHB1bmN0dWF0aW9uIHJ1bnMsIGtlcHQgc2VwYXJhdGUgc28gc3BhbnMgYWxpZ24uICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHMobGluZTogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gbGluZS5tYXRjaCgvXFxzK3xbXFxwe0x9XFxwe059X10rfFteXFxzXFxwe0x9XFxwe059X10rL2d1KSA/PyBbXTtcbn1cblxuLyoqIFRoZSB3b3JkLWxldmVsIGRpZmYgb2Ygb25lIGxpbmUgcGFpciwgYXMgc3BhbnMgb3ZlciBlYWNoIHNpZGUuICovXG5leHBvcnQgZnVuY3Rpb24gcmVmaW5lKGJlZm9yZTogc3RyaW5nLCBhZnRlcjogc3RyaW5nKTogeyBkZWw6IERpZmZTcGFuW107IGFkZDogRGlmZlNwYW5bXSB9IHtcbiAgY29uc3QgYSA9IHdvcmRzKGJlZm9yZSk7XG4gIGNvbnN0IGIgPSB3b3JkcyhhZnRlcik7XG4gIGNvbnN0IHRyYWNlID0gbXllcnNUcmFjZShhLCBiKTtcbiAgaWYgKCF0cmFjZSlcbiAgICByZXR1cm4geyBkZWw6IFt7IHRleHQ6IGJlZm9yZSwgY2hhbmdlZDogdHJ1ZSB9XSwgYWRkOiBbeyB0ZXh0OiBhZnRlciwgY2hhbmdlZDogdHJ1ZSB9XSB9O1xuICBjb25zdCBvcHMgPSBiYWNrdHJhY2soYSwgYiwgdHJhY2UpO1xuICBjb25zdCBkZWw6IERpZmZTcGFuW10gPSBbXTtcbiAgY29uc3QgYWRkOiBEaWZmU3BhbltdID0gW107XG4gIGZvciAoY29uc3Qgb3Agb2Ygb3BzKSB7XG4gICAgaWYgKG9wLm9wID09PSBcInNhbWVcIikge1xuICAgICAgcHVzaChkZWwsIG9wLnRleHQsIGZhbHNlKTtcbiAgICAgIHB1c2goYWRkLCBvcC50ZXh0LCBmYWxzZSk7XG4gICAgfSBlbHNlIGlmIChvcC5vcCA9PT0gXCJkZWxcIikgcHVzaChkZWwsIG9wLnRleHQsIHRydWUpO1xuICAgIGVsc2UgcHVzaChhZGQsIG9wLnRleHQsIHRydWUpO1xuICB9XG4gIHJldHVybiB7IGRlbCwgYWRkIH07XG59XG5cbi8qKiBBcHBlbmQsIG1lcmdpbmcgaW50byB0aGUgcHJldmlvdXMgc3BhbiB3aGVuIGl0IGNhcnJpZXMgdGhlIHNhbWUgdmVyZGljdC4gKi9cbmZ1bmN0aW9uIHB1c2goc3BhbnM6IERpZmZTcGFuW10sIHRleHQ6IHN0cmluZywgY2hhbmdlZDogYm9vbGVhbik6IHZvaWQge1xuICBjb25zdCBsYXN0ID0gc3BhbnNbc3BhbnMubGVuZ3RoIC0gMV07XG4gIGlmIChsYXN0ICYmIGxhc3QuY2hhbmdlZCA9PT0gY2hhbmdlZCkgbGFzdC50ZXh0ICs9IHRleHQ7XG4gIGVsc2Ugc3BhbnMucHVzaCh7IHRleHQsIGNoYW5nZWQgfSk7XG59XG5cbi8qKlxuICogUmVmaW5lIGEgaHVuaydzIGxpbmVzIHdoZW4gdGhleSBjYW4gYmUgUEFJUkVELiBBIGh1bmsgcmVwbGFjaW5nIHRocmVlIGxpbmVzXG4gKiB3aXRoIHRocmVlIGlzIHBhaXJlZCBsaW5lIGJ5IGxpbmU7IGEgMS1mb3ItbWFueSBodW5rIGlzIG5vdCwgYW5kIGdldHMgbm9cbiAqIHNwYW5zIHJhdGhlciB0aGFuIGFuIGFyYml0cmFyeSBwYWlyaW5nIOKAlCBzaG93aW5nIGEgd29yZC1sZXZlbCBkaWZmIGFnYWluc3RcbiAqIHRoZSB3cm9uZyBsaW5lIGlzIHdvcnNlIHRoYW4gc2hvd2luZyBub25lLlxuICovXG5mdW5jdGlvbiByZWZpbmVIdW5rKGxpbmVzOiBEaWZmTGluZVtdLCBodW5rOiBEaWZmSHVuayk6IHZvaWQge1xuICBpZiAoaHVuay5kZWwubGVuZ3RoICE9PSBodW5rLmFkZC5sZW5ndGggfHwgaHVuay5kZWwubGVuZ3RoID09PSAwKSByZXR1cm47XG4gIGNvbnN0IGRlbHMgPSBsaW5lcy5maWx0ZXIoKGwpID0+IGwub3AgPT09IFwiZGVsXCIgJiYgaW5SYW5nZShsLmEsIGh1bmsuYUZyb20sIGh1bmsuYVRvKSk7XG4gIGNvbnN0IGFkZHMgPSBsaW5lcy5maWx0ZXIoKGwpID0+IGwub3AgPT09IFwiYWRkXCIgJiYgaW5SYW5nZShsLmIsIGh1bmsuYkZyb20sIGh1bmsuYlRvKSk7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgZGVscy5sZW5ndGggJiYgaSA8IGFkZHMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBkID0gZGVsc1tpXSBhcyBEaWZmTGluZTtcbiAgICBjb25zdCBhZCA9IGFkZHNbaV0gYXMgRGlmZkxpbmU7XG4gICAgY29uc3QgeyBkZWwsIGFkZCB9ID0gcmVmaW5lKGQudGV4dCwgYWQudGV4dCk7XG4gICAgZC5zcGFucyA9IGRlbDtcbiAgICBhZC5zcGFucyA9IGFkZDtcbiAgfVxufVxuXG5mdW5jdGlvbiBpblJhbmdlKGF0OiBudW1iZXIgfCB1bmRlZmluZWQsIGZyb206IG51bWJlciwgdG86IG51bWJlcik6IGJvb2xlYW4ge1xuICByZXR1cm4gYXQgIT09IHVuZGVmaW5lZCAmJiBhdCA+PSBmcm9tICYmIGF0IDwgdG87XG59XG5cbi8qKiBDb21wYXJlIHR3byB0ZXh0cyBieSBsaW5lLCByZWZpbmVkIGJ5IHdvcmQgaW5zaWRlIHBhaXJlZCBsaW5lcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWZmVGV4dChiZWZvcmU6IHN0cmluZywgYWZ0ZXI6IHN0cmluZyk6IERpZmYge1xuICBpZiAoYmVmb3JlID09PSBhZnRlcikge1xuICAgIGNvbnN0IGxpbmVzID0gc3BsaXRMaW5lcyhiZWZvcmUpLm1hcCgodGV4dCwgaSkgPT4gKHtcbiAgICAgIG9wOiBcInNhbWVcIiBhcyBjb25zdCxcbiAgICAgIGE6IGksXG4gICAgICBiOiBpLFxuICAgICAgdGV4dCxcbiAgICB9KSk7XG4gICAgcmV0dXJuIHsgbGluZXMsIGh1bmtzOiBbXSwgc2FtZTogdHJ1ZSwgY29hcnNlOiBmYWxzZSB9O1xuICB9XG4gIGNvbnN0IGEgPSBzcGxpdExpbmVzKGJlZm9yZSk7XG4gIGNvbnN0IGIgPSBzcGxpdExpbmVzKGFmdGVyKTtcbiAgY29uc3QgdHJhY2UgPSBteWVyc1RyYWNlKGEsIGIpO1xuICBjb25zdCBjb2Fyc2UgPSB0cmFjZSA9PT0gbnVsbDtcbiAgY29uc3QgbGluZXMgPSB0cmFjZSA/IGJhY2t0cmFjayhhLCBiLCB0cmFjZSkgOiBjb2Fyc2VMaW5lcyhhLCBiKTtcbiAgY29uc3QgaHVua3MgPSBjb2xsZWN0KGxpbmVzKTtcbiAgZm9yIChjb25zdCBoIG9mIGh1bmtzKSByZWZpbmVIdW5rKGxpbmVzLCBoKTtcbiAgcmV0dXJuIHsgbGluZXMsIGh1bmtzLCBzYW1lOiBmYWxzZSwgY29hcnNlIH07XG59XG5cbi8qKlxuICogVGFrZSBodW5rcyBmcm9tIHRoZSByaWdodCBzaWRlIGludG8gdGhlIGxlZnQuIGB0YWtlYCBpcyB0aGUgaWRzIHRvIGFwcGx5O1xuICogZXZlcnkgaHVuayBub3QgbmFtZWQgaXMgbGVmdCBhcyB0aGUgbGVmdCBzaWRlIGhhcyBpdC5cbiAqXG4gKiDim5QgQVBQTElFRCBCQUNLIFRPIEZST05ULCBzbyBhbiBlYXJsaWVyIGh1bmsncyBsaW5lIG51bWJlcnMgYXJlIHN0aWxsIHRoZVxuICogb25lcyB0aGUgZGlmZiByZXBvcnRlZCB3aGVuIGl0IGlzIHJlYWNoZWQuIEFwcGx5aW5nIGZyb250IHRvIGJhY2sgd291bGRcbiAqIHNoaWZ0IGV2ZXJ5IGxhdGVyIGh1bmsgYnkgdGhlIHNpemUgb2YgdGhlIGNoYW5nZSBqdXN0IG1hZGUg4oCUIHRoZSBjbGFzc2ljIHdheVxuICogYSBtdWx0aS1odW5rIG1lcmdlIGxhbmRzIGl0cyBsYXN0IGh1bmsgaW4gdGhlIHdyb25nIHBsYWNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlIdW5rcyhiZWZvcmU6IHN0cmluZywgaHVua3M6IERpZmZIdW5rW10sIHRha2U6IG51bWJlcltdKTogc3RyaW5nIHtcbiAgY29uc3Qgd2FudGVkID0gbmV3IFNldCh0YWtlKTtcbiAgY29uc3QgY2hvc2VuID0gaHVua3MuZmlsdGVyKChoKSA9PiB3YW50ZWQuaGFzKGguaWQpKS5zb3J0KCh4LCB5KSA9PiB5LmFGcm9tIC0geC5hRnJvbSk7XG4gIGNvbnN0IGxpbmVzID0gc3BsaXRMaW5lcyhiZWZvcmUpO1xuICBmb3IgKGNvbnN0IGggb2YgY2hvc2VuKSBsaW5lcy5zcGxpY2UoaC5hRnJvbSwgaC5hVG8gLSBoLmFGcm9tLCAuLi5oLmFkZCk7XG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuXG4vKiogVW5pZmllZC1kaWZmIHRleHQsIGZvciB0aGUgYWdlbnQncyBgZGlmZmAgdmVyYi4gYGNvbnRleHRgIGxpbmVzIGVpdGhlciBzaWRlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVuaWZpZWQoXG4gIGRpZmY6IERpZmYsXG4gIG9wdHM6IHsgZnJvbTogc3RyaW5nOyB0bzogc3RyaW5nOyBjb250ZXh0PzogbnVtYmVyIH0gPSB7IGZyb206IFwiYVwiLCB0bzogXCJiXCIgfSxcbik6IHN0cmluZyB7XG4gIGlmIChkaWZmLnNhbWUpIHJldHVybiBcIlwiO1xuICBjb25zdCBjb250ZXh0ID0gb3B0cy5jb250ZXh0ID8/IDM7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbYC0tLSAke29wdHMuZnJvbX1gLCBgKysrICR7b3B0cy50b31gXTtcbiAgLy8gSHVua3MgY2xvc2VyIHRvZ2V0aGVyIHRoYW4gMsOXIGNvbnRleHQgc2hhcmUgb25lIGhlYWRlciwgdGhlIHdheSBldmVyeVxuICAvLyBvdGhlciBkaWZmIHRvb2wgam9pbnMgdGhlbSDigJQgb3RoZXJ3aXNlIHRoZSBjb250ZXh0IGxpbmVzIHByaW50IHR3aWNlLlxuICBjb25zdCBncm91cHM6IERpZmZIdW5rW11bXSA9IFtdO1xuICBmb3IgKGNvbnN0IGggb2YgZGlmZi5odW5rcykge1xuICAgIGNvbnN0IGxhc3QgPSBncm91cHNbZ3JvdXBzLmxlbmd0aCAtIDFdO1xuICAgIGNvbnN0IHByZXYgPSBsYXN0Py5bbGFzdC5sZW5ndGggLSAxXTtcbiAgICBpZiAocHJldiAmJiBoLmFGcm9tIC0gcHJldi5hVG8gPD0gY29udGV4dCAqIDIpIChsYXN0IGFzIERpZmZIdW5rW10pLnB1c2goaCk7XG4gICAgZWxzZSBncm91cHMucHVzaChbaF0pO1xuICB9XG4gIGNvbnN0IGEgPSBzcGxpdExpbmVzKHNpZGVUZXh0KGRpZmYsIFwiYVwiKSk7XG4gIGNvbnN0IGIgPSBzcGxpdExpbmVzKHNpZGVUZXh0KGRpZmYsIFwiYlwiKSk7XG4gIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzKSB7XG4gICAgY29uc3QgZmlyc3QgPSBncm91cFswXSBhcyBEaWZmSHVuaztcbiAgICBjb25zdCBsYXN0ID0gZ3JvdXBbZ3JvdXAubGVuZ3RoIC0gMV0gYXMgRGlmZkh1bms7XG4gICAgY29uc3QgYVN0YXJ0ID0gTWF0aC5tYXgoMCwgZmlyc3QuYUZyb20gLSBjb250ZXh0KTtcbiAgICBjb25zdCBhRW5kID0gTWF0aC5taW4oYS5sZW5ndGgsIGxhc3QuYVRvICsgY29udGV4dCk7XG4gICAgY29uc3QgYlN0YXJ0ID0gTWF0aC5tYXgoMCwgZmlyc3QuYkZyb20gLSBjb250ZXh0KTtcbiAgICBjb25zdCBiRW5kID0gTWF0aC5taW4oYi5sZW5ndGgsIGxhc3QuYlRvICsgY29udGV4dCk7XG4gICAgb3V0LnB1c2goYEBAIC0ke2FTdGFydCArIDF9LCR7YUVuZCAtIGFTdGFydH0gKyR7YlN0YXJ0ICsgMX0sJHtiRW5kIC0gYlN0YXJ0fSBAQGApO1xuICAgIGxldCBhdCA9IGFTdGFydDtcbiAgICBmb3IgKGNvbnN0IGggb2YgZ3JvdXApIHtcbiAgICAgIGZvciAoOyBhdCA8IGguYUZyb207IGF0KyspIG91dC5wdXNoKGAgJHthW2F0XX1gKTtcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBoLmRlbCkgb3V0LnB1c2goYC0ke2xpbmV9YCk7XG4gICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgaC5hZGQpIG91dC5wdXNoKGArJHtsaW5lfWApO1xuICAgICAgYXQgPSBoLmFUbztcbiAgICB9XG4gICAgZm9yICg7IGF0IDwgYUVuZDsgYXQrKykgb3V0LnB1c2goYCAke2FbYXRdfWApO1xuICB9XG4gIHJldHVybiBgJHtvdXQuam9pbihcIlxcblwiKX1cXG5gO1xufVxuXG4vKiogUmVidWlsZCBvbmUgc2lkZSdzIHRleHQgZnJvbSB0aGUgbGluZSBvcHMg4oCUIHVzZWQgYnkgYHVuaWZpZWRgIGZvciBjb250ZXh0LiAqL1xuZnVuY3Rpb24gc2lkZVRleHQoZGlmZjogRGlmZiwgc2lkZTogXCJhXCIgfCBcImJcIik6IHN0cmluZyB7XG4gIGNvbnN0IHNraXAgPSBzaWRlID09PSBcImFcIiA/IFwiYWRkXCIgOiBcImRlbFwiO1xuICByZXR1cm4gZGlmZi5saW5lc1xuICAgIC5maWx0ZXIoKGwpID0+IGwub3AgIT09IHNraXApXG4gICAgLm1hcCgobCkgPT4gbC50ZXh0KVxuICAgIC5qb2luKFwiXFxuXCIpO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKlxuICogVGhlIHNtYWxsZXN0IGJlYXQgdGhpcyBtb2R1bGUgd2lsbCBoYW5kIGJhY2ssIGluIG1zIOKAlCB0aGUgRkxPT1IgaGFsZiBvZiB0aGVcbiAqIGNsYW1wIHdob3NlIGNlaWxpbmcgaXMgYGlkbGVUaW1lb3V0IC8gMmAuXG4gKlxuICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBpbnRPcmAgUEFSU0VTIFdJVEggYHBhcnNlSW50YCwgQU5EIGBwYXJzZUludGAgSVMgTEVOSUVOVFxuICogV0hFUkUgSVQgTUFUVEVSUyBNT1NULiBgaW50T3JgIGZhbGxzIGJhY2sgc2FmZWx5IG9uIGV2ZXJ5dGhpbmcgdGhhdCBMT09LU1xuICogaG9zdGlsZSDigJQgYFwiXCJgLCBgXCIwXCJgLCBgXCItMVwiYCwgYFwiYWJjXCJgLCBgXCJOYU5cImAsIGBcIkluZmluaXR5XCJgIGFsbCB0YWtlIHRoZVxuICogZmFsbGJhY2sg4oCUIGFuZCB0aGVuIHJlYWRzIGBcIjFlOVwiYCwgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdFxuICogaHVnZVwiLCBhcyAqKjEqKi4gTUVBU1VSRUQgYXQgZ3JhcGV2aW5lJ3MgUGhhc2UgNiByZXBhaXIsIGJlZm9yZSB0aGlzIGZsb29yOlxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRVxuICogY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIGdpdmVzIDMgbXMgYW5kIGBcIjVhYmNcImAgZ2l2ZXMgNSBtcyB0aGUgc2FtZSB3YXkuXG4gKiBBIGtub2Igd2hvc2UgZmFzdGVzdCBzZXR0aW5nIGlzIHNwZWxsZWQgbGlrZSBpdHMgc2xvd2VzdCBpcyBhIGZsb29kLlxuICpcbiAqIOKaoCAqKlRIRSBGTE9PUiBJUyBIRVJFIEFORCBOT1QgSU4gYGludE9yYCDigJQgdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW5cbiAqIGFjY2lkZW50IG9mIHdoZXJlIGl0IHdhcyBlYXN5IHRvIHdyaXRlKiogKEQ3NikuIGBpbnRPcmAgaXMgdGhlIGdlbmVyYWwgcGFyc2VyXG4gKiBiZWhpbmQgZXZlcnkgZW52IGtub2IgaW4gdGhlIGtpdDsgdGhlcmUgaXMgbm8gc2luZ2xlIHJvc3Rlci1jb3JyZWN0IG1pbmltdW1cbiAqIGZvciBcImEgcG9zaXRpdmUgaW50ZWdlclwiLCBhbmQgdGlnaHRlbmluZyBpdHMgUEFSU0UgKHJlamVjdGluZyBgMWU5YCBvdXRyaWdodClcbiAqIHdvdWxkIGNoYW5nZSB3aGF0IGV2ZXJ5IG90aGVyIGtub2IgYWNjZXB0cywgc2lsZW50bHksIGZvciB2YWx1ZXMgbm9ib2R5IGhhc1xuICogYXVkaXRlZC4gYGhlYXJ0YmVhdE1zYCBhbHJlYWR5IG93bnMgb25lIGVuZCBvZiB0aGlzIGludmFyaWFudCwgYW5kIDUwMCB3YXNcbiAqIGFscmVhZHkgd3JpdHRlbiBpbnRvIGl0IGFzIHRoZSBzbWFsbGVzdCBjZWlsaW5nIGl0IHdvdWxkIGNvbXB1dGUuIFRoZSBmbG9vclxuICogYmVsb25ncyBiZXNpZGUgdGhlIGNlaWxpbmcsIHdoZXJlIHRoZSBxdWFudGl0eSBpcyBrbm93bi5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JTl9IRUFSVEJFQVRfTVMgPSA1MDA7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiDimqAgYHBhcnNlSW50YCBzZW1hbnRpY3M6IGBcIjFlOVwiYFxuICogIGlzIDEgYW5kIGBcIjVhYmNcImAgaXMgNS4gQW55IGNhbGxlciB3aXRoIGEga25vd24gc2FmZSBtaW5pbXVtIG11c3QgY2xhbXAg4oCUXG4gKiAgc2VlIGBNSU5fSEVBUlRCRUFUX01TYC4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIEFUIEJPVEggRU5EUzogbmV2ZXIgYWJvdmUgaGFsZiB0aGUgaWRsZVxuICogdGltZW91dCwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIFRoZSBjZWlsaW5nIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6XG4gKiB0aGUgb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKlxuICog4pqgIFRoZSBmbG9vciBjYW5ub3QgZmlnaHQgdGhlIGNlaWxpbmc6IHRoZSBjZWlsaW5nIGV4cHJlc3Npb24gaXMgaXRzZWxmXG4gKiBgTWF0aC5tYXgoNTAwLCDigKYpYCwgc28gaXQgaXMgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgIGFuZCB0aGUgdHdvXG4gKiBjbGFtcHMgY2FuIG5ldmVyIGNyb3NzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICBjb25zdCBjZWlsaW5nID0gTWF0aC5tYXgoTUlOX0hFQVJUQkVBVF9NUywgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgoaW50T3IocmF3LCBmYWxsYmFjayksIE1JTl9IRUFSVEJFQVRfTVMpLCBjZWlsaW5nKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogc2NyaXB0b3JpdW0ncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aFxuICogaGFsdmVzIChgY2xpLnRzYCdzIHRhaWwgd2F0Y2hkb2csIGBzZXJ2ZXIudHNgJ3MgU1NFIGhlYXJ0YmVhdCBhbmQgaWRsZVxuICogdGltZW91dCkuIEtpdCB2ZXJkaWN0IGBoZWFydGJlYXRgOiBTVUJKRUNUIOKAlCB0aGUgc2VhbSBleGlzdHMgYmVjYXVzZSB0aGUgQ0xJXG4gKiBhbmQgdGhlIGRhZW1vbiBhcmUgdHdvIHByb2Nlc3NlcyB0aGF0IG11c3QgYWdyZWUgb24gb25lIGludmFyaWFudFxuICogKGBpZGxlVGltZW91dCA+IGhlYXJ0YmVhdGAsIGB3YXRjaGRvZyA+IGhlYXJ0YmVhdGApLCBhbmQgbmVpdGhlciBtYXkgaW1wb3J0XG4gKiB0aGUgb3RoZXIuXG4gKlxuICog4pqgIEtFRVAgSVQgQSBMRUFGLVNIQVBFRCBGSUxFLiBUaGUgbW9tZW50IHRoaXMgaW1wb3J0cyBhbnl0aGluZyBvZiB0aGVcbiAqIGRhZW1vbidzLCBgZGlzdC9jbGkuanNgIGRyYWdzIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqL1xuXG5pbXBvcnQge1xuICBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4gIHRhaWxJZGxlTXMsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9oZWFydGJlYXQudHNcIjtcblxuLyoqIEJ1bidzIG1heGltdW06IGEgaGVsZCBTU0UgdGFpbCBtdXN0IG91dGxpdmUgQnVuJ3MgMTAgcyBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBNQVhfSURMRV9USU1FT1VUX1NFQztcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBERUZBVUxUX0hFQVJUQkVBVF9NUztcblxuLyoqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMgb2YgVEhJUyBkYWVtb24ncyBoZWFydGJlYXQsIGRlcml2ZWQuICovXG5leHBvcnQgY29uc3QgVEFJTF9JRExFX01TID0gdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKTtcbiIsCiAgICAiLyoqXG4gKiBUaGUgTkFUSVZFIGZpbGUgcGlja2VyIOKAlCB0aGUgYWZmb3JkYW5jZSBhIHdlYiBwYWdlIGNhbm5vdCBoYXZlLlxuICpcbiAqIEEgYnJvd3NlcidzIG93biBgPGlucHV0IHR5cGU9XCJmaWxlXCI+YCBhbmQgYHNob3dPcGVuRmlsZVBpY2tlcigpYCBib3RoIGhhbmRcbiAqIGJhY2sgZmlsZSBDT05URU5UIGFuZCBhIG5hbWUsIG5ldmVyIGEgcGF0aCAoYW5kIEJyYXZlLCBDb2xlJ3MgYnJvd3NlcixcbiAqIGRpc2FibGVzIHRoZSBGaWxlIFN5c3RlbSBBY2Nlc3MgQVBJIG91dHJpZ2h0KS4gQSBjb3B5IGlzIGFsbCBhIHBhZ2UgY2FuIGRvXG4gKiB3aXRoIHRoYXQsIHdoaWNoIGlzIGV4YWN0bHkgd2hhdCBhIGRyb3AgYWxyZWFkeSBkb2VzIChFMjMpLiBCdXQgc2NyaXB0b3JpdW0nc1xuICogZGFlbW9uIGlzIGEgTE9DQUwgUFJPQ0VTUzogaXQgY2FuIGFzayB0aGUgT1MgZm9yIGl0cyBvd24gb3BlbiBkaWFsb2cgYW5kIGdldFxuICogYmFjayBhIHJlYWwgZmlsZXN5c3RlbSBwYXRoIOKAlCBzbyBcIkNob29zZeKAplwiIGxpbmtzIHRoZSByZWFsIGZpbGUgKEUxKSBpbnN0ZWFkXG4gKiBvZiBjb3B5aW5nIGl0LlxuICpcbiAqIEV2ZXJ5dGhpbmcgaGVyZSBpcyBwdXJlOiB3aGljaCBhcmd2IHRvIHJ1biwgYW5kIGhvdyB0byByZWFkIHdoYXQgaXQgcHJpbnRlZC5cbiAqIFRoZSBzcGF3bmluZyAoYW5kIHRoZSBvbmUtYXQtYS10aW1lIHJ1bGUpIGlzIHRoZSBkYWVtb24ncy5cbiAqL1xuXG5leHBvcnQgdHlwZSBQaWNrS2luZCA9IFwiZmlsZVwiIHwgXCJmb2xkZXJcIjtcblxuLyoqIEFuIEFwcGxlU2NyaXB0IHRoYXQgcHV0cyBvbmUgUE9TSVggcGF0aCBwZXIgbGluZSBvbiBzdGRvdXQuICovXG5mdW5jdGlvbiBhcHBsZVNjcmlwdChraW5kOiBQaWNrS2luZCwgcHJvbXB0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBxdW90ZWQgPSBwcm9tcHQucmVwbGFjZSgvW1wiXFxcXF0vZywgXCJcIik7XG4gIGNvbnN0IGNob29zZSA9XG4gICAga2luZCA9PT0gXCJmaWxlXCJcbiAgICAgID8gYGNob29zZSBmaWxlIHdpdGggcHJvbXB0IFwiJHtxdW90ZWR9XCIgd2l0aCBtdWx0aXBsZSBzZWxlY3Rpb25zIGFsbG93ZWRgXG4gICAgICA6IGB7Y2hvb3NlIGZvbGRlciB3aXRoIHByb21wdCBcIiR7cXVvdGVkfVwifWA7XG4gIHJldHVybiBbXG4gICAgYHNldCBjaG9zZW4gdG8gJHtjaG9vc2V9YCxcbiAgICAnc2V0IG91dCB0byBcIlwiJyxcbiAgICBcInJlcGVhdCB3aXRoIGYgaW4gY2hvc2VuXCIsXG4gICAgXCJzZXQgb3V0IHRvIG91dCAmIFBPU0lYIHBhdGggb2YgZiAmIGxpbmVmZWVkXCIsXG4gICAgXCJlbmQgcmVwZWF0XCIsXG4gICAgXCJyZXR1cm4gb3V0XCIsXG4gIF0uam9pbihcIlxcblwiKTtcbn1cblxuLyoqXG4gKiBUaGUgY29tbWFuZCB0aGF0IG9wZW5zIHRoZSBPUydzIHBpY2tlciwgb3IgbnVsbCB3aGVyZSB0aGVyZSBpcyBub25lIOKAlCB0aGVcbiAqIGNhbGxlciB0aGVuIHNheXMgc28gcmF0aGVyIHRoYW4gaGFuZ2luZyBvbiBhIGRpYWxvZyBub2JvZHkgd2lsbCBzZWUuXG4gKiBgemVuaXR5QXRgIGlzIHdoZXJlIGEgTGludXggemVuaXR5IHdhcyBmb3VuZCAodGhlIGNhbGxlciBsb29rcyBpdCB1cCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwaWNrZXJDb21tYW5kKFxuICBwbGF0Zm9ybTogc3RyaW5nLFxuICBraW5kOiBQaWNrS2luZCxcbiAgcHJvbXB0OiBzdHJpbmcsXG4gIHplbml0eUF0Pzogc3RyaW5nIHwgbnVsbCxcbik6IHN0cmluZ1tdIHwgbnVsbCB7XG4gIGlmIChwbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIikgcmV0dXJuIFtcIm9zYXNjcmlwdFwiLCBcIi1lXCIsIGFwcGxlU2NyaXB0KGtpbmQsIHByb21wdCldO1xuICBpZiAocGxhdGZvcm0gPT09IFwid2luMzJcIikgcmV0dXJuIG51bGw7IC8vIFBvd2VyU2hlbGwncyBkaWFsb2cgbmVlZHMgYSBTVEEgaG9zdDsgbm90IHdyaXR0ZW4gdW50aWwgYXNrZWQgZm9yXG4gIGlmICh6ZW5pdHlBdClcbiAgICByZXR1cm4gW1xuICAgICAgemVuaXR5QXQsXG4gICAgICBcIi0tZmlsZS1zZWxlY3Rpb25cIixcbiAgICAgIC4uLihraW5kID09PSBcImZvbGRlclwiID8gW1wiLS1kaXJlY3RvcnlcIl0gOiBbXCItLW11bHRpcGxlXCJdKSxcbiAgICAgIFwiLS1zZXBhcmF0b3I9XFxuXCIsXG4gICAgICBgLS10aXRsZT0ke3Byb21wdH1gLFxuICAgIF07XG4gIHJldHVybiBudWxsO1xufVxuXG4vKiogVGhlIHBhdGhzIGEgcGlja2VyIHByaW50ZWQ6IG9uZSBwZXIgbGluZSwgYmxhbmtzIGRyb3BwZWQsIG9yZGVyIGtlcHQuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VQaWNrZXJPdXRwdXQoc3Rkb3V0OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBzdGRvdXRcbiAgICAuc3BsaXQoXCJcXG5cIilcbiAgICAubWFwKChsKSA9PiBsLnRyaW0oKSlcbiAgICAuZmlsdGVyKChsKSA9PiBsLnN0YXJ0c1dpdGgoXCIvXCIpKVxuICAgIC5tYXAoKGwpID0+IChsLmxlbmd0aCA+IDEgJiYgbC5lbmRzV2l0aChcIi9cIikgPyBsLnNsaWNlKDAsIC0xKSA6IGwpKTtcbn1cblxuLyoqIEEgY2FuY2VsbGVkIGRpYWxvZyBpcyBub3QgYSBmYWlsdXJlIOKAlCBvc2FzY3JpcHQgZXhpdHMgMSwgemVuaXR5IGV4aXRzIDEsIGFuZCBub3RoaW5nIHdhcyBjaG9zZW4uICovXG5leHBvcnQgZnVuY3Rpb24gd2FzQ2FuY2VsbGVkKGV4aXRDb2RlOiBudW1iZXIsIHN0ZG91dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBleGl0Q29kZSAhPT0gMCAmJiBwYXJzZVBpY2tlck91dHB1dChzdGRvdXQpLmxlbmd0aCA9PT0gMDtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgc2Vzc2lvbiDigJQgdGhlIGRhZW1vbidzIHN0YXRlLCBhbmQgdGhlIG9ubHkgY29kZSB0aGF0IHdyaXRlcyBhIGZpbGUuXG4gKlxuICogRTgncyBzaGFwZSwgdGhlIGhvdXNlJ3MgXCJtYXRlcmlhbGl6ZWQgcGF0aFwiIHBhdHRlcm46IHRoZSBkYWVtb24gb3ducyB0aGVcbiAqIHNlc3Npb24gKGNvbnRleHQsIGRvY3MsIHZlcnNpb25zLCB3aGljaCBpcyBhY3RpdmUsIHRoZSBjaGF0KSBhbmQgcGVyc2lzdHMgaXRcbiAqIGFzIGBtYW5pZmVzdC5qc29uYDsgZXZlcnkgdmVyc2lvbidzIFRFWFQgaXMgYSBmaWxlIGluIHRoZSBzZXNzaW9uIGZvbGRlciwgc29cbiAqIHRoZSBhZ2VudCBlZGl0cyB2ZXJzaW9ucyB3aXRoIGl0cyBvd24gZmlsZSB0b29scy5cbiAqXG4gKiAgICAgJFNDUklQVE9SSVVNX0hPTUUvc2Vzc2lvbnMvPHNlc3Npb25JZD4vXG4gKiAgICAgICBtYW5pZmVzdC5qc29uICAgICAgICAgICAgICB3cml0dGVuIGF0b21pY2FsbHksIG9uIGV2ZXJ5IGNoYW5nZVxuICogICAgICAgZG9jcy88c2x1Zz4vdjEubWQsIHYyLm1kICAgb25lIGZpbGUgcGVyIHZlcnNpb25cbiAqXG4gKiBUaGUgdGhyZWUgd3JpdGUgcnVsZXMsIGVhY2ggYSBkZWNpc2lvbiByYXRoZXIgdGhhbiBhIGhhYml0OlxuICpcbiAqIC0gKipUaGUgb3JpZ2luYWwgaXMgd3JpdHRlbiBPTkxZIGJ5IGBzYXZlYCoqIChFNykuIE9wZW5pbmcgY29waWVzIGl0IHRvIHYxO1xuICogICBub3RoaW5nIGVsc2UgdG91Y2hlcyBpdC5cbiAqIC0gKipFdmVyeSB3cml0ZSB0aGlzIG1vZHVsZSBtYWtlcyBpcyByZW1lbWJlcmVkIGJ5IGNvbnRlbnQgaGFzaCoqICh0aGVcbiAqICAgYG93bmVkYCBtYXApIHNvIHRoZSB3YXRjaGVyIGNhbiB0ZWxsIHRoZSBkYWVtb24ncyBvd24gd3JpdGVzIGZyb20gYW55b25lXG4gKiAgIGVsc2UncyAoaW52ZXN0aWdhdGlvbiDCpzUpLiBBIHdyaXRlIHRvIHRoZSBBQ1RJVkUgdmVyc2lvbiB0aGF0IGlzIG5vdCBvdXJzXG4gKiAgIGlzIGFuIEUyIHZpb2xhdGlvbiB0aGUgZGFlbW9uIGFubm91bmNlcy5cbiAqIC0gKipUaGUgYWdlbnQgbmV2ZXIgd3JpdGVzIHRoZSBhY3RpdmUgdmVyc2lvbioqIChFMikg4oCUIGVuZm9yY2VkIHNvY2lhbGx5IGJ5XG4gKiAgIFNLSUxMLm1kIGFuZCBkZXRlY3RlZCBoZXJlLCBub3QgcHJldmVudGVkOiB0aGUgZmlsZSBpcyB0aGUgYWdlbnQncyBtZWRpdW0uXG4gKlxuICogTm90aGluZyBoZXJlIGtub3dzIGFib3V0IHNvY2tldHMsIEhUVFAgb3IgdGhlIGV2ZW50IGxvZy4gVGhlIGRhZW1vbiBjYWxscyBhXG4gKiBtZXRob2QsIGdldHMgYSByZXN1bHQsIGFuZCBkZWNpZGVzIHdoYXQgdG8gYnJvYWRjYXN0OyB0aGF0IHNwbGl0IGlzIHdoYXRcbiAqIGxldHMgdGhlIHVuaXQgY2VsbHMgZHJpdmUgdGhlIHdob2xlIG1vZGVsIHdpdGggYSB0ZW1wIGhvbWUuXG4gKi9cblxuaW1wb3J0IHtcbiAgY2xvc2VTeW5jLFxuICBleGlzdHNTeW5jLFxuICBta2RpclN5bmMsXG4gIG9wZW5TeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICByZWFkU3luYyxcbiAgcmVhbHBhdGhTeW5jLFxuICByZW5hbWVTeW5jLFxuICBybVN5bmMsXG4gIHN0YXRTeW5jLFxuICB3cml0ZUZpbGVTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgZXh0bmFtZSwgaXNBYnNvbHV0ZSwgam9pbiwgcmVsYXRpdmUsIHJlc29sdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHdyaXRlRmlsZUF0b21pYyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9kaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB7IGFwcGx5SHVua3MsIGRpZmZUZXh0IH0gZnJvbSBcIi4vZGlmZlwiO1xuaW1wb3J0IHtcbiAgYnVpbGRCbG9jayxcbiAgZ3Vlc3NUeXBlLFxuICBtYXRjaGVzRmlsdGVyLFxuICByZWFkTWV0YSxcbiAgc2V0S2V5LFxuICBzcGxpdEZyb250bWF0dGVyLFxuICBzdW1tYXJpemUsXG4gIHRpdGxlRnJvbUJvZHksXG4gIHdpdGhCbG9jayxcbn0gZnJvbSBcIi4vZnJvbnRtYXR0ZXJcIjtcbmltcG9ydCB7IHR5cGUgQnVuZGxlSW5kZXgsIGJ1aWxkR3JhcGgsIHR5cGUgUmVzb2x1dGlvbiwgcmVzb2x2ZVRhcmdldCB9IGZyb20gXCIuL2xpbmtzXCI7XG5pbXBvcnQgdHlwZSB7XG4gIENoYXRNZXNzYWdlLFxuICBDaGF0V2hvLFxuICBDb250ZXh0RW50cnksXG4gIERpZmZQYXlsb2FkLFxuICBEaWZmU2lkZSxcbiAgRG9jTWV0YSxcbiAgRG9jU3VtbWFyeSxcbiAgRG9jVmlldyxcbiAgR3JhcGhQYXlsb2FkLFxuICBNZXRhRmlsdGVyLFxuICBNb3ZlUGxhbixcbiAgUHVibGljU3RhdGUsXG4gIFNlbGVjdGlvbixcbiAgVmVyc2lvbixcbiAgVmVyc2lvbkF1dGhvcixcbn0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcbmltcG9ydCB7XG4gIERPQ19FWFRFTlNJT05TLFxuICBkb2NQYXRocyxcbiAgZW50cnlGb3JQYXRoLFxuICBmaW5kTm9kZSxcbiAgaXNEb2NOYW1lLFxuICBsb2NhdGUsXG4gIE1JUlJPUl9OT0RFX0NBUCxcbiAgc2NhblRyZWUsXG4gIHRvUG9zaXgsXG59IGZyb20gXCIuL3RyZWVcIjtcblxuZXhwb3J0IGNvbnN0IE1BTklGRVNUX0ZPUk1BVCA9IDE7XG5cbi8qKiBUaGUgbW9zdCBkb2N1bWVudHMgb25lIGZyb250bWF0dGVyIHNjYW4gcmVhZHMuICovXG5leHBvcnQgY29uc3QgTUVUQV9TQ0FOX0NBUCA9IDUwMDtcbi8qKiBBIGZyb250bWF0dGVyIGJsb2NrIGxpdmVzIGF0IHRoZSB0b3Agb2YgYSBmaWxlOyB0aGlzIGlzIGhvdyBtdWNoIHdlIHJlYWQgdG8gZmluZCBpdC4gKi9cbmNvbnN0IE1FVEFfSEVBRF9CWVRFUyA9IDgxOTI7XG5cbi8qKiBUaGUgZmlyc3QgOCBLQiBvZiBhIGZpbGUsIGFzIHRleHQg4oCUIGVub3VnaCBmb3IgYW55IGZyb250bWF0dGVyIGJsb2NrLiAqL1xuZnVuY3Rpb24gcmVhZEhlYWQocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgbGV0IGZkOiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgZmQgPSBvcGVuU3luYyhwYXRoLCBcInJcIik7XG4gICAgY29uc3QgYnVmID0gQnVmZmVyLmFsbG9jKE1FVEFfSEVBRF9CWVRFUyk7XG4gICAgY29uc3QgcmVhZCA9IHJlYWRTeW5jKGZkLCBidWYsIDAsIE1FVEFfSEVBRF9CWVRFUywgMCk7XG4gICAgcmV0dXJuIGJ1Zi5zdWJhcnJheSgwLCByZWFkKS50b1N0cmluZyhcInV0ZjhcIik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBcIlwiO1xuICB9IGZpbmFsbHkge1xuICAgIGlmIChmZCAhPT0gdW5kZWZpbmVkKSBjbG9zZVN5bmMoZmQpO1xuICB9XG59XG5cbnR5cGUgRG9jUmVjb3JkID0ge1xuICBzbHVnOiBzdHJpbmc7XG4gIG5hbWU6IHN0cmluZztcbiAgb3JpZ2luYWw6IHN0cmluZztcbiAgZW50cnlJZDogc3RyaW5nIHwgbnVsbDtcbiAgcmVsOiBzdHJpbmcgfCBudWxsO1xuICBleHQ6IHN0cmluZztcbiAgdmVyc2lvbnM6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+W107XG4gIGFjdGl2ZTogbnVtYmVyO1xuICAvKipcbiAgICogVGhlIG5leHQgdmVyc2lvbiBudW1iZXIgdG8gaGFuZCBvdXQg4oCUIE1PTk9UT05JQywgYW5kIG5ldmVyIGRlcml2ZWQgZnJvbVxuICAgKiB0aGUgdmVyc2lvbnMgc3RpbGwgcHJlc2VudCAoRTQxKS4gTnVtYmVyaW5nIGFzIGBtYXgoZXhpc3RpbmcpICsgMWAgd2FzXG4gICAqIGNvcnJlY3Qgd2hpbGUgbm90aGluZyBjb3VsZCBiZSBkZWxldGVkOyB0aGUgbW9tZW50IGEgdmVyc2lvbiBjYW4gYmVcbiAgICogcmVtb3ZlZCwgZGVsZXRpbmcgdGhlIGhpZ2hlc3QgbWFrZXMgdGhlIG5leHQgb25lIFJFVVNFIGl0cyBudW1iZXIsIGFuZCBhXG4gICAqIGB2M2AgbmFtZWQgaW4gYSBjaGF0IG1lc3NhZ2UsIGEgbG9nIGxpbmUgb3IgYW4gYWdlbnQncyBub3RlcyB3b3VsZCB0aGVuXG4gICAqIHBvaW50IGF0IGEgZGlmZmVyZW50IGRvY3VtZW50LiBBYnNlbnQgb24gYSBtYW5pZmVzdCB3cml0dGVuIGJlZm9yZSBFNDEg4oCUXG4gICAqIGB0YWtlVmVyc2lvbmAgZGVyaXZlcyBpdCBvbmNlLCBmcm9tIHRoZSBoaWdoZXN0IHRoYXQgZXZlciB3YXMuXG4gICAqL1xuICBuZXh0VmVyc2lvbj86IG51bWJlcjtcbiAgLyoqIEhhc2ggb2YgdGhlIG9yaWdpbmFsIGFzIHdlIGxhc3QgcmVhZCBvciB3cm90ZSBpdCDigJQgYXQgb3Blbiwgc2F2ZSwgcmV2ZXJ0XG4gICAqICBhbmQgcmVsb2FkIOKAlCBzbyBhIHJlc3RvcmUgY2FuIHRlbGwgdGhhdCBpdCBjaGFuZ2VkIHdoaWxlIG5vIGRhZW1vbiB3YXNcbiAgICogIHdhdGNoaW5nICh2ZXJpZnktcGFzcyBmaXggMikuICovXG4gIG9yaWdpbmFsSGFzaDogc3RyaW5nO1xuICAvKiogU2V0IG9ubHkgYnkgYG9wZW5QYXRoYCwgd2hpY2ggYWRtaXRzIGEgZG9jLXR5cGUgZmlsZSBJTlNJREUgYSBjb250ZXh0XG4gICAqICBlbnRyeS4gYHNhdmVgIHdyaXRlcyBubyBvcmlnaW5hbCB0aGF0IGxhY2tzIGl0ICh2ZXJpZnktcGFzcyBmaXggMWMpLiAqL1xuICBhZG1pdHRlZD86IGJvb2xlYW47XG4gIG91dHNpZGVDaGFuZ2VkOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgTWFuaWZlc3QgPSB7XG4gIGZvcm1hdDogbnVtYmVyO1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIGNvbnRleHQ6IENvbnRleHRFbnRyeVtdO1xuICBkb2NzOiBEb2NSZWNvcmRbXTtcbiAgb3BlbkRvYzogc3RyaW5nIHwgbnVsbDtcbiAgY2hhdDogQ2hhdE1lc3NhZ2VbXTtcbiAgLyoqIEUyMydzIHdvcmtzcGFjZS4gQWJzZW50IGluIGEgbWFuaWZlc3Qgd3JpdHRlbiBiZWZvcmUgaXQgZXhpc3RlZDogdGhlIHVzZXIncyBob21lLiAqL1xuICB3b3Jrc3BhY2U/OiBzdHJpbmc7XG59O1xuXG4vKiogQSByZWZ1c2FsIHRoZSBkYWVtb24gdHVybnMgaW50byBhbiBIVFRQIHN0YXR1cyDigJQgYGNob2ljZXNgIHdoZW4gdGhlIHNldCBpcyBpbiBoYW5kIChBMSkuICovXG5leHBvcnQgY2xhc3MgU2Vzc2lvbkVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgcmVhZG9ubHkgc3RhdHVzOiA0MDAgfCA0MDQgfCA0MDksXG4gICAgcmVhZG9ubHkgY2hvaWNlcz86IHN0cmluZ1tdLFxuICApIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgfVxufVxuXG5leHBvcnQgY29uc3QgY29udGVudEhhc2ggPSAodGV4dDogc3RyaW5nKTogc3RyaW5nID0+IEJ1bi5oYXNoKHRleHQpLnRvU3RyaW5nKDE2KTtcblxuY29uc3QgcmFuZEhleCA9IChuOiBudW1iZXIpID0+XG4gIEFycmF5LmZyb20oY3J5cHRvLmdldFJhbmRvbVZhbHVlcyhuZXcgVWludDhBcnJheShuKSkpXG4gICAgLm1hcCgoYikgPT4gYi50b1N0cmluZygxNikucGFkU3RhcnQoMiwgXCIwXCIpKVxuICAgIC5qb2luKFwiXCIpO1xuXG5leHBvcnQgY29uc3QgbmV3U2Vzc2lvbklkID0gKCk6IHN0cmluZyA9PiByYW5kSGV4KDQpO1xuXG4vKiogQSBwYXRoJ3MgcmVhbHBhdGgsIG9yIHRoZSBwYXRoIGl0c2VsZiB3aGVuIGl0IGNhbm5vdCBiZSByZXNvbHZlZCAoZ29uZSkuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhbE9yKHA6IHN0cmluZyk6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHJlYWxwYXRoU3luYyhwKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHA7XG4gIH1cbn1cblxuLyoqIFdoYXQgYSB3YXRjaGVyIGV2ZW50IHR1cm5lZCBvdXQgdG8gYmUuIGBudWxsYCA9IG5vdGhpbmcgKG91cnMsIG9yIG5vIGNoYW5nZSkuICovXG5leHBvcnQgdHlwZSBGaWxlRXZlbnQgPVxuICB8IHsga2luZDogXCJ2ZXJzaW9uLmNoYW5nZWRcIjsgZG9jOiBzdHJpbmc7IHZlcnNpb246IG51bWJlcjsgdGV4dDogc3RyaW5nOyBhY3RpdmU6IGZhbHNlIH1cbiAgfCB7XG4gICAgICBraW5kOiBcImFjdGl2ZS5vdXRzaWRlXCI7XG4gICAgICBkb2M6IHN0cmluZztcbiAgICAgIHZlcnNpb246IG51bWJlcjtcbiAgICAgIHBhdGg6IHN0cmluZztcbiAgICAgIC8qKiBUaGUgbmV3IGFnZW50IHZlcnNpb24gdGhlIG91dHNpZGUgdGV4dCB3YXMgcHJlc2VydmVkIGFzLiAqL1xuICAgICAgcHJlc2VydmVkQXM6IG51bWJlcjtcbiAgICAgIHByZXNlcnZlZFBhdGg6IHN0cmluZztcbiAgICB9XG4gIHwgeyBraW5kOiBcInZlcnNpb24uY3JlYXRlZFwiOyBkb2M6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyOyBwYXRoOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJvcmlnaW5hbC5yZWxvYWRlZFwiOyBkb2M6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyOyB0ZXh0OiBzdHJpbmc7IG9yaWdpbmFsOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJvcmlnaW5hbC5jb25mbGljdFwiOyBkb2M6IHN0cmluZzsgb3JpZ2luYWw6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcInRyZWVcIjsgZW50cnlJZDogc3RyaW5nIH07XG5cbmV4cG9ydCBjbGFzcyBTZXNzaW9uIHtcbiAgcmVhZG9ubHkgZGlyOiBzdHJpbmc7XG4gIHByaXZhdGUgbTogTWFuaWZlc3Q7XG4gIC8qKiBwYXRoIOKGkiBoYXNoIG9mIHRoZSBkYWVtb24ncyBsYXN0IHdyaXRlIHRvIGl0LiAqL1xuICBwcml2YXRlIG93bmVkID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgLyoqIHNsdWcg4oaSIGhhc2ggb2YgdGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgY3VycmVudCB0ZXh0LiAqL1xuICBwcml2YXRlIGFjdGl2ZUhhc2ggPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAvKiogc2x1ZyDihpIgdGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCBhcyB0aGUgZGFlbW9uIGxhc3Qgd3JvdGUgKG9yIGFkb3B0ZWQpXG4gICAqICBpdCDigJQgd2hhdCBhbiBvdXRzaWRlIHdyaXRlIHRvIHRoZSBhY3RpdmUgdmVyc2lvbiBpcyByZXZlcnRlZCB0by4gKi9cbiAgcHJpdmF0ZSBsYXN0QWN0aXZlVGV4dCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIC8qKiBXaGF0IGEgcmVzdG9yZSBmb3VuZCBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgbm8gZGFlbW9uIHdhcyB3YXRjaGluZy4gKi9cbiAgcmVzdG9yZUZpbmRpbmdzOiB7IGRvYzogc3RyaW5nOyBvcmlnaW5hbDogc3RyaW5nOyBtaXNzaW5nOiBib29sZWFuIH1bXSA9IFtdO1xuXG4gIHByaXZhdGUgY29uc3RydWN0b3IoXG4gICAgcmVhZG9ubHkgaG9tZTogc3RyaW5nLFxuICAgIG1hbmlmZXN0OiBNYW5pZmVzdCxcbiAgKSB7XG4gICAgdGhpcy5tID0gbWFuaWZlc3Q7XG4gICAgdGhpcy5kaXIgPSBqb2luKGhvbWUsIFwic2Vzc2lvbnNcIiwgbWFuaWZlc3Quc2Vzc2lvbklkKTtcbiAgfVxuXG4gIHN0YXRpYyBjcmVhdGUoaG9tZTogc3RyaW5nLCBzZXNzaW9uSWQ6IHN0cmluZyA9IG5ld1Nlc3Npb25JZCgpLCB3b3Jrc3BhY2U/OiBzdHJpbmcpOiBTZXNzaW9uIHtcbiAgICBjb25zdCBzID0gbmV3IFNlc3Npb24oaG9tZSwge1xuICAgICAgZm9ybWF0OiBNQU5JRkVTVF9GT1JNQVQsXG4gICAgICBzZXNzaW9uSWQsXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICBjb250ZXh0OiBbXSxcbiAgICAgIGRvY3M6IFtdLFxuICAgICAgb3BlbkRvYzogbnVsbCxcbiAgICAgIGNoYXQ6IFtdLFxuICAgICAgLi4uKHdvcmtzcGFjZSA/IHsgd29ya3NwYWNlOiByZXNvbHZlKHdvcmtzcGFjZSkgfSA6IHt9KSxcbiAgICB9KTtcbiAgICBta2RpclN5bmMoam9pbihzLmRpciwgXCJkb2NzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gcztcbiAgfVxuXG4gIC8qKiBSZWxvYWQgYSBzZXNzaW9uIGZyb20gaXRzIG1hbmlmZXN0IChgb3BlbiAtLXJlc3RvcmUgPGlkPmApLiAqL1xuICBzdGF0aWMgcmVzdG9yZShob21lOiBzdHJpbmcsIHNlc3Npb25JZDogc3RyaW5nKTogU2Vzc2lvbiB7XG4gICAgY29uc3QgcGF0aCA9IGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiLCBzZXNzaW9uSWQsIFwibWFuaWZlc3QuanNvblwiKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vIHNhdmVkIHNlc3Npb24gJHtzZXNzaW9uSWR9YCwgNDA0KTtcbiAgICBjb25zdCBtID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSBhcyBNYW5pZmVzdDtcbiAgICBpZiAobS5mb3JtYXQgIT09IE1BTklGRVNUX0ZPUk1BVClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYHNlc3Npb24gJHtzZXNzaW9uSWR9IGhhcyBtYW5pZmVzdCBmb3JtYXQgJHttLmZvcm1hdH1gLCA0MDkpO1xuICAgIGNvbnN0IHMgPSBuZXcgU2Vzc2lvbihob21lLCBtKTtcbiAgICBta2RpclN5bmMoam9pbihzLmRpciwgXCJkb2NzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAvLyBNaXJyb3JzIGFyZSByZS1yZWFkLCBub3QgdHJ1c3RlZDogdGhlIGZvbGRlciBtYXkgaGF2ZSBjaGFuZ2VkIHdoaWxlIG5vXG4gICAgLy8gZGFlbW9uIHdhcyB3YXRjaGluZyBpdC5cbiAgICBmb3IgKGNvbnN0IGUgb2Ygcy5tLmNvbnRleHQpIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIikgcy5yZXNjYW4oZS5pZCk7XG4gICAgZm9yIChjb25zdCBkIG9mIHMubS5kb2NzKSB7XG4gICAgICBjb25zdCBwID0gcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSk7XG4gICAgICBjb25zdCB0ZXh0ID0gZXhpc3RzU3luYyhwKSA/IHJlYWRGaWxlU3luYyhwLCBcInV0ZjhcIikgOiBcIlwiO1xuICAgICAgcy5hZG9wdEFjdGl2ZShkLCB0ZXh0KTtcbiAgICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggMjogYW4gb3JpZ2luYWwgY2hhbmdlZCB3aGlsZSB0aGUgc2Vzc2lvbiB3YXMgY2xvc2VkXG4gICAgICAvLyB3YXMgaW52aXNpYmxlIGhlcmUsIHNvIHRoZSBuZXh0IFNhdmUgb3Zlcndyb3RlIGl0IHVuYW5ub3VuY2VkLiBUaGVcbiAgICAgIC8vIG1hbmlmZXN0IGhvbGRzIHRoZSBvcmlnaW5hbCdzIGhhc2ggYXMgb2YgdGhlIGxhc3Qgb3Blbi9zYXZlL3JldmVydC9cbiAgICAgIC8vIHJlbG9hZDsgYSBkaWZmZXJlbnQgaGFzaCBub3cgaXMgYW4gb3V0c2lkZSBjaGFuZ2UsIG1hcmtlZCBleGFjdGx5IGFzIGFcbiAgICAgIC8vIGxpdmUgb25lIHdpdGggYSBkaXJ0eSBidWZmZXIgaXMg4oCUIGFza2VkLCBuZXZlciBtZXJnZWQgb3IgcmVsb2FkZWQuXG4gICAgICBsZXQgbm93OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICAgIHRyeSB7XG4gICAgICAgIG5vdyA9IGNvbnRlbnRIYXNoKHJlYWRGaWxlU3luYyhkLm9yaWdpbmFsLCBcInV0ZjhcIikpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIG5vdyA9IG51bGw7XG4gICAgICB9XG4gICAgICBpZiAobm93ID09PSBudWxsIHx8IG5vdyAhPT0gZC5vcmlnaW5hbEhhc2gpIHtcbiAgICAgICAgZC5vdXRzaWRlQ2hhbmdlZCA9IHRydWU7XG4gICAgICAgIHMucmVzdG9yZUZpbmRpbmdzLnB1c2goeyBkb2M6IGQuc2x1Zywgb3JpZ2luYWw6IGQub3JpZ2luYWwsIG1pc3Npbmc6IG5vdyA9PT0gbnVsbCB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHMucmVzdG9yZUZpbmRpbmdzLmxlbmd0aCA+IDApIHMucGVyc2lzdCgpO1xuICAgIHJldHVybiBzO1xuICB9XG5cbiAgc3RhdGljIGxpc3RTYXZlZChob21lOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiByZWFkZGlyU3luYyhqb2luKGhvbWUsIFwic2Vzc2lvbnNcIikpLmZpbHRlcigoaWQpID0+XG4gICAgICAgIGV4aXN0c1N5bmMoam9pbihob21lLCBcInNlc3Npb25zXCIsIGlkLCBcIm1hbmlmZXN0Lmpzb25cIikpLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG4gIH1cblxuICBnZXQgaWQoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5tLnNlc3Npb25JZDtcbiAgfVxuXG4gIGdldCBkb2NzRGlyKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGpvaW4odGhpcy5kaXIsIFwiZG9jc1wiKTtcbiAgfVxuXG4gIGdldCBvcGVuRG9jU2x1ZygpOiBzdHJpbmcgfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5tLm9wZW5Eb2M7XG4gIH1cblxuICBnZXQgY29udGV4dCgpOiByZWFkb25seSBDb250ZXh0RW50cnlbXSB7XG4gICAgcmV0dXJuIHRoaXMubS5jb250ZXh0O1xuICB9XG5cbiAgLyoqXG4gICAqIEV2ZXJ5IGRpcmVjdG9yeSB0aGUgd2F0Y2hlciBtdXN0IHNlZTogdGhlIHNlc3Npb24ncyBkb2NzLCBlYWNoIGVudHJ5IHJvb3QsXG4gICAqIGFuZCB0aGUgUkVBTCBkaXJlY3Rvcnkgb2YgZXZlcnkgb3BlbmVkIG9yaWdpbmFsLlxuICAgKlxuICAgKiDim5QgVkVSSUZZLVBBU1MgRklYIDM6IGVhY2ggcm9vdCBpcyB3YXRjaGVkIGF0IGl0cyBSRUFMUEFUSCAoYHdhdGNoYCksIGFuZFxuICAgKiBhbiBldmVudCBpcyByZXBvcnRlZCB1bmRlciB0aGUgcGF0aCBmb3JtIHRoZSBzZXNzaW9uIHN0b3JlcyAoYHBhdGhgKS4gQVxuICAgKiB3YXRjaCBvbiBhIHN5bWxpbmtlZCBkaXJlY3Rvcnkg4oCUIGEgc3ltbGlua2VkIGhvbWUsIGEgc3ltbGlua2VkIGZvbGRlclxuICAgKiBlbnRyeSDigJQgb3Igb24gdGhlIGxpbmsncyBvd24gZGlyZWN0b3J5IGZvciBhIHN5bWxpbmtlZCBvcmlnaW5hbCBzYXdcbiAgICogbm90aGluZyB3aGVuIHRoZSBUQVJHRVQgY2hhbmdlZCAoRlNFdmVudHMgcmVwb3J0cyByZWFsIHBhdGhzKS4gQSBzeW1saW5rZWRcbiAgICogb3JpZ2luYWwgaXMgbWF0Y2hlZCBiYWNrIHRvIGl0cyBkb2MgYnkgcmVhbHBhdGggaW4gYG9uRmlsZUV2ZW50YC5cbiAgICovXG4gIHdhdGNoUm9vdHMoKTogeyBwYXRoOiBzdHJpbmc7IHdhdGNoOiBzdHJpbmc7IHJlY3Vyc2l2ZTogYm9vbGVhbjsgZW50cnlJZD86IHN0cmluZyB9W10ge1xuICAgIGNvbnN0IHJvb3RzOiB7IHBhdGg6IHN0cmluZzsgd2F0Y2g6IHN0cmluZzsgcmVjdXJzaXZlOiBib29sZWFuOyBlbnRyeUlkPzogc3RyaW5nIH1bXSA9IFtcbiAgICAgIHsgcGF0aDogdGhpcy5kb2NzRGlyLCB3YXRjaDogcmVhbE9yKHRoaXMuZG9jc0RpciksIHJlY3Vyc2l2ZTogdHJ1ZSB9LFxuICAgIF07XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KVxuICAgICAgcm9vdHMucHVzaCh7XG4gICAgICAgIHBhdGg6IGUucm9vdCxcbiAgICAgICAgd2F0Y2g6IHJlYWxPcihlLnJvb3QpLFxuICAgICAgICByZWN1cnNpdmU6IGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiLFxuICAgICAgICBlbnRyeUlkOiBlLmlkLFxuICAgICAgfSk7XG4gICAgZm9yIChjb25zdCBkIG9mIHRoaXMubS5kb2NzKSB7XG4gICAgICBjb25zdCByZWFsRGlyID0gZGlybmFtZShyZWFsT3IoZC5vcmlnaW5hbCkpO1xuICAgICAgaWYgKFxuICAgICAgICAhcm9vdHMuc29tZSgocikgPT4gci53YXRjaCA9PT0gcmVhbERpciAmJiByLnJlY3Vyc2l2ZSA9PT0gZmFsc2UpICYmXG4gICAgICAgICFyb290cy5zb21lKFxuICAgICAgICAgIChyKSA9PiByLnJlY3Vyc2l2ZSAmJiAocmVhbERpciA9PT0gci53YXRjaCB8fCByZWFsRGlyLnN0YXJ0c1dpdGgoci53YXRjaCArIHNlcCkpLFxuICAgICAgICApXG4gICAgICApXG4gICAgICAgIHJvb3RzLnB1c2goeyBwYXRoOiByZWFsRGlyLCB3YXRjaDogcmVhbERpciwgcmVjdXJzaXZlOiBmYWxzZSB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHJvb3RzO1xuICB9XG5cbiAgLy8g4pSA4pSAIHBlcnNpc3RlbmNlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIHBlcnNpc3QoKTogdm9pZCB7XG4gICAgbWtkaXJTeW5jKHRoaXMuZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVBdG9taWMoam9pbih0aGlzLmRpciwgXCJtYW5pZmVzdC5qc29uXCIpLCBgJHtKU09OLnN0cmluZ2lmeSh0aGlzLm0sIG51bGwsIDIpfVxcbmApO1xuICB9XG5cbiAgcHJpdmF0ZSB3cml0ZU93bmVkKHBhdGg6IHN0cmluZywgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gICAgbWtkaXJTeW5jKGRpcm5hbWUocGF0aCksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIC8vIFJlbWVtYmVyIEJFRk9SRSB3cml0aW5nOiB0aGUgd2F0Y2hlcidzIGV2ZW50IGNhbiBhcnJpdmUgYmVmb3JlIHRoaXNcbiAgICAvLyBmdW5jdGlvbiByZXR1cm5zLCBhbmQgaXQgbXVzdCBmaW5kIHRoZSBoYXNoIGFscmVhZHkgdGhlcmUuXG4gICAgdGhpcy5vd25lZC5zZXQocGF0aCwgY29udGVudEhhc2godGV4dCkpO1xuICAgIHdyaXRlRmlsZVN5bmMocGF0aCwgdGV4dCk7XG4gIH1cblxuICBwcml2YXRlIGFkb3B0QWN0aXZlKGQ6IERvY1JlY29yZCwgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgcCA9IHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpO1xuICAgIHRoaXMub3duZWQuc2V0KHAsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLmFjdGl2ZUhhc2guc2V0KGQuc2x1ZywgY29udGVudEhhc2godGV4dCkpO1xuICAgIHRoaXMubGFzdEFjdGl2ZVRleHQuc2V0KGQuc2x1ZywgdGV4dCk7XG4gIH1cblxuICBwcml2YXRlIHdyaXRlQWN0aXZlKGQ6IERvY1JlY29yZCwgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy53cml0ZU93bmVkKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCB0ZXh0KTtcbiAgICB0aGlzLmFjdGl2ZUhhc2guc2V0KGQuc2x1ZywgY29udGVudEhhc2godGV4dCkpO1xuICAgIHRoaXMubGFzdEFjdGl2ZVRleHQuc2V0KGQuc2x1ZywgdGV4dCk7XG4gIH1cblxuICAvKiogS2VlcCBhbiBvdXRzaWRlIHdyaXRlIHRvIHRoZSBhY3RpdmUgdmVyc2lvbiBhcyBhIE5FVyBhZ2VudCB2ZXJzaW9uLiAqL1xuICBwcml2YXRlIHByZXNlcnZlT3V0c2lkZShkOiBEb2NSZWNvcmQsIHRleHQ6IHN0cmluZyk6IFZlcnNpb24ge1xuICAgIGNvbnN0IG4gPSB0aGlzLnRha2VWZXJzaW9uKGQpO1xuICAgIGNvbnN0IHJlYzogT21pdDxWZXJzaW9uLCBcInBhdGhcIj4gPSB7XG4gICAgICBuLFxuICAgICAgYXV0aG9yOiBcImFnZW50XCIsXG4gICAgICBmcm9tOiBkLmFjdGl2ZSxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIGxhYmVsOiBgb3V0c2lkZSB3cml0ZSB0byB2JHtkLmFjdGl2ZX1gLFxuICAgIH07XG4gICAgZC52ZXJzaW9ucy5wdXNoKHJlYyk7XG4gICAgdGhpcy53cml0ZU93bmVkKHRoaXMudmVyc2lvblBhdGgoZCwgbiksIHRleHQpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IC4uLnJlYywgcGF0aDogdGhpcy52ZXJzaW9uUGF0aChkLCBuKSB9O1xuICB9XG5cbiAgLyoqIFRydWUgaWZmIGB0ZXh0YCBhdCBgcGF0aGAgaXMgZXhhY3RseSB3aGF0IHRoZSBkYWVtb24gbGFzdCB3cm90ZSB0aGVyZS4gKi9cbiAgaXNPd25Xcml0ZShwYXRoOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLm93bmVkLmdldChwYXRoKSA9PT0gY29udGVudEhhc2godGV4dCk7XG4gIH1cblxuICAvLyDilIDilIAgY29udGV4dCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBhZGRDb250ZXh0KHJhd1BhdGg6IHN0cmluZyk6IHsgZW50cnk6IENvbnRleHRFbnRyeTsgYWRkZWQ6IGJvb2xlYW4gfSB7XG4gICAgY29uc3QgYWJzID0gcmVzb2x2ZShyYXdQYXRoKTtcbiAgICBjb25zdCBwcm9iZSA9IGVudHJ5Rm9yUGF0aChhYnMsIGBjLSR7cmFuZEhleCgzKX1gKTtcbiAgICBjb25zdCBzYW1lID0gdGhpcy5tLmNvbnRleHQuZmluZChcbiAgICAgIChlKSA9PlxuICAgICAgICBlLnJvb3QgPT09IHByb2JlLnJvb3QgJiZcbiAgICAgICAgZS5tZW1iZXJzaGlwID09PSBwcm9iZS5tZW1iZXJzaGlwICYmXG4gICAgICAgIChwcm9iZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgfHxcbiAgICAgICAgICBKU09OLnN0cmluZ2lmeShlLm5vZGVzKSA9PT0gSlNPTi5zdHJpbmdpZnkocHJvYmUubm9kZXMpKSxcbiAgICApO1xuICAgIGlmIChzYW1lKSByZXR1cm4geyBlbnRyeTogc2FtZSwgYWRkZWQ6IGZhbHNlIH07XG4gICAgdGhpcy5tLmNvbnRleHQucHVzaChwcm9iZSk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBlbnRyeTogcHJvYmUsIGFkZGVkOiB0cnVlIH07XG4gIH1cblxuICByZW1vdmVDb250ZXh0KGlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBpID0gdGhpcy5tLmNvbnRleHQuZmluZEluZGV4KChlKSA9PiBlLmlkID09PSBpZCk7XG4gICAgaWYgKGkgPCAwKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vIGNvbnRleHQgZW50cnkgJHtpZH1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIHRoaXMubS5jb250ZXh0Lm1hcCgoZSkgPT4gZS5pZCksXG4gICAgICApO1xuICAgIHRoaXMubS5jb250ZXh0LnNwbGljZShpLCAxKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMuY2xvc2VPcnBoYW5lZE9wZW5Eb2MoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgb3BlbiBkb2N1bWVudCBsZWZ0IHRoZSBjb250ZXh0IChpdHMgZW50cnkgcmVtb3ZlZCwgb3IgdGhlIGRvY3VtZW50XG4gICAqIGhpZGRlbik6IGNsb3NlIGl0IGluIHRoZSB2aWV3LiBJdHMgdmVyc2lvbnMgc3RheSBpbiB0aGUgc2Vzc2lvbiDigJQgbm90aGluZ1xuICAgKiBpcyBkZWxldGVkIOKAlCBhbmQgYnJpbmdpbmcgaXQgYmFjayBhbmQgb3BlbmluZyBpdCBhZ2FpbiBmaW5kcyB0aGVtLlxuICAgKi9cbiAgcHJpdmF0ZSBjbG9zZU9ycGhhbmVkT3BlbkRvYygpOiB2b2lkIHtcbiAgICBjb25zdCBvcGVuID0gdGhpcy5tLm9wZW5Eb2MgPyB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLnNsdWcgPT09IHRoaXMubS5vcGVuRG9jKSA6IHVuZGVmaW5lZDtcbiAgICBpZiAob3BlbiAmJiBvcGVuLmVudHJ5SWQgPT09IG51bGwpIHRoaXMubS5vcGVuRG9jID0gbnVsbDtcbiAgfVxuXG4gIC8qKiBSZS1taXJyb3IgYSBmb2xkZXIgZW50cnkuIFJldHVybnMgd2hldGhlciBpdHMgbm9kZXMgY2hhbmdlZC4gKi9cbiAgcmVzY2FuKGVudHJ5SWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IGUgPSB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4LmlkID09PSBlbnRyeUlkKTtcbiAgICBpZiAoZT8ubWVtYmVyc2hpcCAhPT0gXCJtaXJyb3JlZFwiKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgeyBub2RlcywgdHJ1bmNhdGVkIH0gPSBzY2FuVHJlZShlLnJvb3QsIE1JUlJPUl9OT0RFX0NBUCwgZS5oaWRkZW4pO1xuICAgIGNvbnN0IGNoYW5nZWQgPVxuICAgICAgSlNPTi5zdHJpbmdpZnkobm9kZXMpICE9PSBKU09OLnN0cmluZ2lmeShlLm5vZGVzKSB8fCAhIXRydW5jYXRlZCAhPT0gISFlLnRydW5jYXRlZDtcbiAgICBlLm5vZGVzID0gbm9kZXM7XG4gICAgaWYgKHRydW5jYXRlZCkgZS50cnVuY2F0ZWQgPSB0cnVlO1xuICAgIGVsc2UgZGVsZXRlIGUudHJ1bmNhdGVkO1xuICAgIGlmIChjaGFuZ2VkKSB0aGlzLnJlbGluaygpO1xuICAgIHJldHVybiBjaGFuZ2VkO1xuICB9XG5cbiAgcHJpdmF0ZSByZWxpbmsoKTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBkIG9mIHRoaXMubS5kb2NzKSB7XG4gICAgICBjb25zdCBhdCA9IGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgZC5vcmlnaW5hbCk7XG4gICAgICBkLmVudHJ5SWQgPSBhdD8uZW50cnlJZCA/PyBudWxsO1xuICAgICAgZC5yZWwgPSBhdD8ucmVsID8/IG51bGw7XG4gICAgfVxuICB9XG5cbiAgLy8g4pSA4pSAIGRvY3VtZW50cyBhbmQgdmVyc2lvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcHJpdmF0ZSB2ZXJzaW9uUGF0aChkOiBEb2NSZWNvcmQsIG46IG51bWJlcik6IHN0cmluZyB7XG4gICAgcmV0dXJuIGpvaW4odGhpcy5kb2NzRGlyLCBkLnNsdWcsIGB2JHtufSR7ZC5leHR9YCk7XG4gIH1cblxuICBwcml2YXRlIGRvY09yRGllKHNsdWc/OiBzdHJpbmcpOiBEb2NSZWNvcmQge1xuICAgIGNvbnN0IHdhbnQgPSBzbHVnID8/IHRoaXMubS5vcGVuRG9jID8/IHVuZGVmaW5lZDtcbiAgICBjb25zdCBjaG9pY2VzID0gdGhpcy5tLmRvY3MubWFwKChkKSA9PiBkLnNsdWcpO1xuICAgIGlmICh3YW50ID09PSB1bmRlZmluZWQpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwibm8gZG9jdW1lbnQgaXMgb3BlbiDigJQgbmFtZSBvbmUgd2l0aCAtLWRvY1wiLCA0MDksIGNob2ljZXMpO1xuICAgIGNvbnN0IGQgPSB0aGlzLmZpbmREb2Mod2FudCk7XG4gICAgaWYgKCFkKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBubyBkb2N1bWVudCBcIiR7d2FudH1cIiBpbiB0aGlzIHNlc3Npb25gLCA0MDQsIGNob2ljZXMpO1xuICAgIHJldHVybiBkO1xuICB9XG5cbiAgLyoqIEEgZG9jIGJ5IHNsdWcsIGJ5IG9yaWdpbmFsIHBhdGgsIG9yIGJ5IGEgdW5pcXVlIG9yaWdpbmFsIGJhc2VuYW1lLiAqL1xuICBmaW5kRG9jKGtleTogc3RyaW5nKTogRG9jUmVjb3JkIHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCBieVNsdWcgPSB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLnNsdWcgPT09IGtleSk7XG4gICAgaWYgKGJ5U2x1ZykgcmV0dXJuIGJ5U2x1ZztcbiAgICAvLyDim5QgT05MWSBBTiBBQlNPTFVURSBrZXkgaXMgYSBwYXRoICh2ZXJpZnktcGFzcyBmaXggOCk6IHJlc29sdmluZyBhXG4gICAgLy8gcmVsYXRpdmUgb25lIGhlcmUgcmVzb2x2ZWQgaXQgYWdhaW5zdCB0aGUgREFFTU9OJ3MgY3dkLiBUaGUgQ0xJIHJlc29sdmVzXG4gICAgLy8gYWdhaW5zdCBpdHMgb3duIGN3ZCBhbmQgc2VuZHMgYW4gYWJzb2x1dGUgcGF0aC5cbiAgICBpZiAoaXNBYnNvbHV0ZShrZXkpKSB7XG4gICAgICBjb25zdCBieVBhdGggPSB0aGlzLm0uZG9jcy5maW5kKFxuICAgICAgICAoZCkgPT4gZC5vcmlnaW5hbCA9PT0ga2V5IHx8IHJlYWxPcihkLm9yaWdpbmFsKSA9PT0gcmVhbE9yKGtleSksXG4gICAgICApO1xuICAgICAgaWYgKGJ5UGF0aCkgcmV0dXJuIGJ5UGF0aDtcbiAgICB9XG4gICAgY29uc3QgYnlOYW1lID0gdGhpcy5tLmRvY3MuZmlsdGVyKChkKSA9PiBiYXNlbmFtZShkLm9yaWdpbmFsKSA9PT0ga2V5IHx8IGQucmVsID09PSBrZXkpO1xuICAgIHJldHVybiBieU5hbWUubGVuZ3RoID09PSAxID8gYnlOYW1lWzBdIDogdW5kZWZpbmVkO1xuICB9XG5cbiAgLyoqIFRoZSBuZXh0IHZlcnNpb24gbnVtYmVyLCBjb25zdW1lZC4gTnVtYmVycyBhcmUgbmV2ZXIgcmV1c2VkIChFNDEpLiAqL1xuICBwcml2YXRlIHRha2VWZXJzaW9uKGQ6IERvY1JlY29yZCk6IG51bWJlciB7XG4gICAgY29uc3QgbiA9IGQubmV4dFZlcnNpb24gPz8gTWF0aC5tYXgoLi4uZC52ZXJzaW9ucy5tYXAoKHYpID0+IHYubikpICsgMTtcbiAgICBkLm5leHRWZXJzaW9uID0gbiArIDE7XG4gICAgcmV0dXJuIG47XG4gIH1cblxuICBwcml2YXRlIHZlcnNpb25PckRpZShkOiBEb2NSZWNvcmQsIG46IG51bWJlcik6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+IHtcbiAgICBjb25zdCB2ID0gZC52ZXJzaW9ucy5maW5kKCh4KSA9PiB4Lm4gPT09IG4pO1xuICAgIGlmICghdilcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Quc2x1Z30gaGFzIG5vIHYke259YCxcbiAgICAgICAgNDA0LFxuICAgICAgICBkLnZlcnNpb25zLm1hcCgoeCkgPT4gYHYke3gubn1gKSxcbiAgICAgICk7XG4gICAgcmV0dXJuIHY7XG4gIH1cblxuICBwcml2YXRlIHNsdWdGb3Iob3JpZ2luYWw6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3Qgc3RlbSA9XG4gICAgICBiYXNlbmFtZShvcmlnaW5hbCwgZXh0bmFtZShvcmlnaW5hbCkpXG4gICAgICAgIC50b0xvd2VyQ2FzZSgpXG4gICAgICAgIC5yZXBsYWNlKC9bXmEtejAtOV8tXSsvZywgXCItXCIpXG4gICAgICAgIC5yZXBsYWNlKC9eLSt8LSskL2csIFwiXCIpIHx8IFwiZG9jXCI7XG4gICAgbGV0IHNsdWcgPSBzdGVtO1xuICAgIGZvciAobGV0IGkgPSAyOyB0aGlzLm0uZG9jcy5zb21lKChkKSA9PiBkLnNsdWcgPT09IHNsdWcpOyBpKyspIHNsdWcgPSBgJHtzdGVtfS0ke2l9YDtcbiAgICByZXR1cm4gc2x1ZztcbiAgfVxuXG4gIC8qKlxuICAgKiBPcGVuIGEgZG9jdW1lbnQgYnkgaXRzIG9yaWdpbmFsJ3MgcGF0aDogdjEgaXMgd3JpdHRlbiBmcm9tIHRoZSBvcmlnaW5hbFxuICAgKiB0aGUgZmlyc3QgdGltZS4gYGZvY3VzOiBmYWxzZWAgKHRoZSBhZ2VudCdzIGltcGxpY2l0IG9wZW4gdGhyb3VnaFxuICAgKiBgdmVyc2lvbi1uZXcgLS1kb2MgPHBhdGg+YCkgZG9lcyBub3QgbW92ZSB0aGUgaHVtYW4ncyBvcGVuIGRvY3VtZW50LlxuICAgKlxuICAgKiDim5QgVkVSSUZZLVBBU1MgRklYIDFiIOKAlCBBRE1JU1NJT04uIE9ubHkgYSBkb2MtdHlwZSBmaWxlIElOU0lERSBhIGNvbnRleHRcbiAgICogZW50cnkgaXMgYWRtaXR0ZWQ7IGBjb250ZXh0LmFkZGAgc3RheXMgdGhlIG9uZSB3YXkgaW4uIEJlZm9yZSB0aGlzLCBhbnlcbiAgICogcGF0aCBvZiBhbnkgdHlwZSB3YXMgb3BlbmVkLCBhbmQgU2F2ZSB0aGVuIHdyb3RlIGl0OiBhIGZvcmVpZ24gd2ViIHBhZ2VcbiAgICogd3JvdGUgYGN1cmwgZXZpbCB8IHNoYCBpbnRvIGEgYC5yY2AgZmlsZSBvdXRzaWRlIHRoZSBjb250ZXh0LlxuICAgKi9cbiAgb3BlblBhdGgocmF3UGF0aDogc3RyaW5nLCBvcHRzOiB7IGZvY3VzPzogYm9vbGVhbiB9ID0ge30pOiB7IHNsdWc6IHN0cmluZzsgY3JlYXRlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBmb2N1cyA9IG9wdHMuZm9jdXMgPz8gdHJ1ZTtcbiAgICAvLyBUaGUgY29udGV4dCdzIG93biBzcGVsbGluZyBvZiB0aGUgcGF0aDogYSBjYWxsZXIgd2hvc2UgY3dkIGlzIGEgcmVhbHBhdGhcbiAgICAvLyAoL3ByaXZhdGUvdmFyL+KApiBmb3IgL3Zhci/igKYsIG9yIHRocm91Z2ggYSBzeW1saW5rZWQgZm9sZGVyKSBuYW1lcyB0aGUgc2FtZVxuICAgIC8vIGZpbGUgZGlmZmVyZW50bHksIGFuZCBpdCBtdXN0IGxhbmQgb24gdGhlIHNhbWUgZG9jLlxuICAgIGNvbnN0IGFicyA9IHRoaXMuY2Fub25pY2FsKHJlc29sdmUocmF3UGF0aCkpO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gdGhpcy5tLmRvY3MuZmluZCgoZCkgPT4gZC5vcmlnaW5hbCA9PT0gYWJzKTtcbiAgICBpZiAoZXhpc3RpbmcpIHtcbiAgICAgIGlmIChmb2N1cykgdGhpcy5tLm9wZW5Eb2MgPSBleGlzdGluZy5zbHVnO1xuICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICByZXR1cm4geyBzbHVnOiBleGlzdGluZy5zbHVnLCBjcmVhdGVkOiBmYWxzZSB9O1xuICAgIH1cbiAgICBpZiAoIWlzRG9jTmFtZShhYnMpKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBub3QgYSBkb2N1bWVudCBzY3JpcHRvcml1bSBvcGVuczogJHthYnN9YCwgNDAwKTtcbiAgICBpZiAoIWxvY2F0ZSh0aGlzLm0uY29udGV4dCwgYWJzKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Fic30gaXMgbm90IGluIHRoaXMgc2Vzc2lvbidzIGNvbnRleHQg4oCUIGFkZCBpdCAob3IgaXRzIGZvbGRlcikgZmlyc3RgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgdHJ5IHtcbiAgICAgIGlmICghc3RhdFN5bmMoYWJzKS5pc0ZpbGUoKSkgdGhyb3cgbmV3IEVycm9yKFwibm90IGEgZmlsZVwiKTtcbiAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBjYW5ub3Qgb3BlbiAke2Fic306IG5vIHN1Y2ggZmlsZWAsIDQwNCk7XG4gICAgfVxuICAgIGNvbnN0IGV4dCA9IFtcIi5tZFwiLCBcIi5tYXJrZG93blwiLCBcIi5tZHhcIiwgXCIudHh0XCJdLmluY2x1ZGVzKGV4dG5hbWUoYWJzKS50b0xvd2VyQ2FzZSgpKVxuICAgICAgPyBleHRuYW1lKGFicykudG9Mb3dlckNhc2UoKVxuICAgICAgOiBcIi5tZFwiO1xuICAgIGNvbnN0IGF0ID0gbG9jYXRlKHRoaXMubS5jb250ZXh0LCBhYnMpO1xuICAgIGNvbnN0IGQ6IERvY1JlY29yZCA9IHtcbiAgICAgIHNsdWc6IHRoaXMuc2x1Z0ZvcihhYnMpLFxuICAgICAgbmFtZTogYmFzZW5hbWUoYWJzKSxcbiAgICAgIG9yaWdpbmFsOiBhYnMsXG4gICAgICBlbnRyeUlkOiBhdD8uZW50cnlJZCA/PyBudWxsLFxuICAgICAgcmVsOiBhdD8ucmVsID8/IG51bGwsXG4gICAgICBleHQsXG4gICAgICB2ZXJzaW9uczogW3sgbjogMSwgYXV0aG9yOiBcImh1bWFuXCIsIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSB9XSxcbiAgICAgIGFjdGl2ZTogMSxcbiAgICAgIG9yaWdpbmFsSGFzaDogY29udGVudEhhc2godGV4dCksXG4gICAgICBvdXRzaWRlQ2hhbmdlZDogZmFsc2UsXG4gICAgICBhZG1pdHRlZDogdHJ1ZSxcbiAgICB9O1xuICAgIHRoaXMubS5kb2NzLnB1c2goZCk7XG4gICAgdGhpcy53cml0ZUFjdGl2ZShkLCB0ZXh0KTtcbiAgICBpZiAoZm9jdXMpIHRoaXMubS5vcGVuRG9jID0gZC5zbHVnO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1ZywgY3JlYXRlZDogdHJ1ZSB9O1xuICB9XG5cbiAgLyoqIGBhYnNgIGFzIHRoZSBjb250ZXh0IHNwZWxscyBpdCwgd2hlbiBpdCBpcyB0aGUgc2FtZSBmaWxlIGJ5IHJlYWxwYXRoLiAqL1xuICBwcml2YXRlIGNhbm9uaWNhbChhYnM6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgYWJzKSkgcmV0dXJuIGFicztcbiAgICBjb25zdCByZWFsID0gcmVhbE9yKGFicyk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBjb25zdCByZWFsUm9vdCA9IHJlYWxPcihlLnJvb3QpO1xuICAgICAgaWYgKCFyZWFsLnN0YXJ0c1dpdGgocmVhbFJvb3QgKyBzZXApKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHNwZWxsZWQgPSBqb2luKGUucm9vdCwgcmVsYXRpdmUocmVhbFJvb3QsIHJlYWwpKTtcbiAgICAgIGlmIChsb2NhdGUodGhpcy5tLmNvbnRleHQsIHNwZWxsZWQpKSByZXR1cm4gc3BlbGxlZDtcbiAgICB9XG4gICAgcmV0dXJuIGFicztcbiAgfVxuXG4gIG9wZW5TbHVnKHNsdWc6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMubS5vcGVuRG9jID0gdGhpcy5kb2NPckRpZShzbHVnKS5zbHVnO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICB9XG5cbiAgcmVhZFZlcnNpb24oc2x1Zzogc3RyaW5nLCBuOiBudW1iZXIpOiB7IHRleHQ6IHN0cmluZzsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIG4pO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG4pO1xuICAgIHJldHVybiB7IHRleHQ6IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIiksIHBhdGggfTtcbiAgfVxuXG4gIGFjdGl2ZVBhdGgoc2x1Zz86IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICAgIGNvbnN0IGQgPSBzbHVnID8gdGhpcy5maW5kRG9jKHNsdWcpIDogdGhpcy5tLm9wZW5Eb2MgPyB0aGlzLmZpbmREb2ModGhpcy5tLm9wZW5Eb2MpIDogdW5kZWZpbmVkO1xuICAgIHJldHVybiBkID8gdGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSkgOiBudWxsO1xuICB9XG5cbiAgLyoqIFRoZSBodW1hbidzIGJ1ZmZlciByZWFjaGVzIHRoZSBBQ1RJVkUgdmVyc2lvbidzIGZpbGUgKGRlYm91bmNlZCBieSB0aGUgc3VyZmFjZSkuICovXG4gIC8qKlxuICAgKiDim5QgVkVSSUZZLVBBU1MgRklYIDQg4oCUIENIRUNLIEJFRk9SRSBXUklURS4gQmVmb3JlIHRoZSBodW1hbidzIGVkaXQgaXNcbiAgICogd3JpdHRlbiwgdGhlIGZpbGUgb24gZGlzayBpcyBoYXNoZWQ6IGlmIGl0IGlzIG5vdCB0aGUgZGFlbW9uJ3Mgb3duIGxhc3RcbiAgICogd3JpdGUsIHNvbWVvbmUgZWxzZSB3cm90ZSB0aGUgYWN0aXZlIHZlcnNpb24gKEUyKS4gVGhhdCB0ZXh0IGlzIGtlcHQgYXMgYVxuICAgKiBORVcgYWdlbnQgdmVyc2lvbiwgYW5kIG9ubHkgdGhlbiBpcyB0aGUgZWRpdCB3cml0dGVuLiBEZXRlY3Rpb24gdXNlZCB0b1xuICAgKiBkZXBlbmQgb24gdGhlIHdhdGNoZXIncyA2MCBtcyBzZXR0bGUgdGltZXIgZmlyaW5nIGJlZm9yZSB0aGUgbmV4dFxuICAgKiBrZXlzdHJva2U7IGEgYnVyc3Qgb2YgZWRpdHMgYXQgMzAgbXMgY2xvYmJlcmVkIGFuIG91dHNpZGUgd3JpdGVcbiAgICogdW5hbm5vdW5jZWQuIE5vdyBub3RoaW5nIGlzIGxvc3Qgd2hhdGV2ZXIgdGhlIHRpbWluZyDigJQgdGhlIG9uZSB3aW5kb3cgbGVmdFxuICAgKiBpcyB0aGUgbWljcm9zZWNvbmRzIGJldHdlZW4gdGhpcyByZWFkIGFuZCB0aGlzIHdyaXRlLlxuICAgKi9cbiAgZWRpdChcbiAgICBzbHVnOiBzdHJpbmcsXG4gICAgbjogbnVtYmVyLFxuICAgIHRleHQ6IHN0cmluZyxcbiAgKTogeyBkaXJ0eUNoYW5nZWQ6IGJvb2xlYW47IHByZXNlcnZlZDogVmVyc2lvbiB8IG51bGwgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgaWYgKG4gIT09IGQuYWN0aXZlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYHYke259IGlzIG5vdCB0aGUgYWN0aXZlIHZlcnNpb24gb2YgJHtkLnNsdWd9ICh2JHtkLmFjdGl2ZX0gaXMpIOKAlCBvbmx5IHRoZSBhY3RpdmUgdmVyc2lvbiBpcyBlZGl0YWJsZWAsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgY29uc3QgYmVmb3JlID0gdGhpcy5pc0RpcnR5KGQpO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG4pO1xuICAgIC8vIFRoZSBlZGl0IGlzIHN0YWdlZCBpbiBhIHNpYmxpbmcgZmlsZSBGSVJTVCwgc28gdGhlIGNoZWNrIGJlbG93IGFuZCB0aGVcbiAgICAvLyByZW5hbWUgdGhhdCBsYW5kcyB0aGUgZWRpdCBhcmUgYWRqYWNlbnQgc3lzY2FsbHM6IHRoZSB3aW5kb3cgaW4gd2hpY2ggYW5cbiAgICAvLyBvdXRzaWRlIHdyaXRlIGNvdWxkIHNsaXAgYmV0d2VlbiB0aGVtIGlzIG1pY3Jvc2Vjb25kcywgbm90IHRoZSBsZW5ndGggb2ZcbiAgICAvLyBhIG11bHRpLW1lZ2FieXRlIHdyaXRlIOKAlCBhbmQgYSB3cml0ZSBsYW5kaW5nIEFGVEVSIHRoZSByZW5hbWUgZ29lcyB0byB0aGVcbiAgICAvLyBuZXcgZmlsZSwgd2hlcmUgdGhlIHdhdGNoZXIgZmluZHMgaXQgYW5kIHByZXNlcnZlcyBpdCB0b28uXG4gICAgY29uc3Qgc3RhZ2VkID0gYCR7cGF0aH0uJHtwcm9jZXNzLnBpZH0uZWRpdGA7XG4gICAgd3JpdGVGaWxlU3luYyhzdGFnZWQsIHRleHQpO1xuICAgIGxldCBwcmVzZXJ2ZWQ6IFZlcnNpb24gfCBudWxsID0gbnVsbDtcbiAgICBsZXQgb25EaXNrOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgb25EaXNrID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIG9uRGlzayA9IG51bGw7XG4gICAgfVxuICAgIGlmIChvbkRpc2sgIT09IG51bGwgJiYgIXRoaXMuaXNPd25Xcml0ZShwYXRoLCBvbkRpc2spKVxuICAgICAgcHJlc2VydmVkID0gdGhpcy5wcmVzZXJ2ZU91dHNpZGUoZCwgb25EaXNrKTtcbiAgICB0aGlzLm93bmVkLnNldChwYXRoLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgcmVuYW1lU3luYyhzdGFnZWQsIHBhdGgpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5sYXN0QWN0aXZlVGV4dC5zZXQoZC5zbHVnLCB0ZXh0KTtcbiAgICByZXR1cm4geyBkaXJ0eUNoYW5nZWQ6IGJlZm9yZSAhPT0gdGhpcy5pc0RpcnR5KGQpLCBwcmVzZXJ2ZWQgfTtcbiAgfVxuXG4gIC8qKiBDb3B5IGEgdmVyc2lvbiB0byBhIG5ldyBmaWxlOyB0aGUgYWdlbnQgdGhlbiBlZGl0cyB0aGF0IGZpbGUgd2l0aCBpdHMgb3duIHRvb2xzLiAqL1xuICBuZXdWZXJzaW9uKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBmcm9tPzogbnVtYmVyOyBsYWJlbD86IHN0cmluZzsgYXV0aG9yOiBWZXJzaW9uQXV0aG9yIH0pOiB7XG4gICAgc2x1Zzogc3RyaW5nO1xuICAgIHZlcnNpb246IFZlcnNpb247XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBmcm9tID0gb3B0cy5mcm9tID8/IGQuYWN0aXZlO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIGZyb20pO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBmcm9tKSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IG4gPSB0aGlzLnRha2VWZXJzaW9uKGQpO1xuICAgIGNvbnN0IHJlYzogT21pdDxWZXJzaW9uLCBcInBhdGhcIj4gPSB7XG4gICAgICBuLFxuICAgICAgYXV0aG9yOiBvcHRzLmF1dGhvcixcbiAgICAgIGZyb20sXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICAuLi4ob3B0cy5sYWJlbCA/IHsgbGFiZWw6IG9wdHMubGFiZWwgfSA6IHt9KSxcbiAgICB9O1xuICAgIGQudmVyc2lvbnMucHVzaChyZWMpO1xuICAgIHRoaXMud3JpdGVPd25lZCh0aGlzLnZlcnNpb25QYXRoKGQsIG4pLCB0ZXh0KTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIHZlcnNpb246IHsgLi4ucmVjLCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIG4pIH0gfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZW1vdmUgYSB2ZXJzaW9uIGFuZCBpdHMgZmlsZSAoRTQxKS5cbiAgICpcbiAgICog4puUIFRIRSBBQ1RJVkUgVkVSU0lPTiBDQU5OT1QgQkUgREVMRVRFRCwgYW5kIHJlZnVzaW5nIGlzIGJldHRlciB0aGFuXG4gICAqIHBpY2tpbmcgYSByZXBsYWNlbWVudDogY2hvb3Npbmcgb25lIGZvciB0aGUgaHVtYW4gd291bGQgc2lsZW50bHkgbW92ZVxuICAgKiB3aGVyZSB0aGVpciBlZGl0cyBhbmQgU2F2ZSBhcmUgcG9pbnRlZCwgd2hpY2ggaXMgdGhlIG9uZSB0aGluZyBFMiBhbmQgRTdcbiAgICogZXhpc3QgdG8ga2VlcCBleHBsaWNpdC4gQmVjYXVzZSBleGFjdGx5IG9uZSB2ZXJzaW9uIGlzIGFsd2F5cyBhY3RpdmUsIHRoaXNcbiAgICogYWxzbyBtZWFucyB0aGUgbGFzdCB2ZXJzaW9uIGNhbiBuZXZlciBiZSBkZWxldGVkIOKAlCBhIGRvY3VtZW50IGFsd2F5cyBoYXNcbiAgICogc29tZXRoaW5nIHRvIGVkaXQsIHdpdGhvdXQgdGhhdCBiZWluZyBhIHNlY29uZCBydWxlLlxuICAgKlxuICAgKiBgZnJvbWAgcG9pbnRlcnMgb24gT1RIRVIgdmVyc2lvbnMgYXJlIGxlZnQgYXMgdGhleSBhcmUuIFwiTWFkZSBmcm9tIHYyXCJcbiAgICogc3RheXMgdHJ1ZSBhZnRlciB2MiBpcyBnb25lOyBkZWxldGluZyBhIHZlcnNpb24gaXMgbm90IHJld3JpdGluZyB0aGVcbiAgICogaGlzdG9yeSBvZiB0aGUgb25lcyB0aGF0IHJlbWFpbi5cbiAgICovXG4gIGRlbGV0ZVZlcnNpb24ob3B0czogeyBkb2M/OiBzdHJpbmc7IHZlcnNpb246IG51bWJlciB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICB2ZXJzaW9uOiBudW1iZXI7XG4gICAgbGFiZWw/OiBzdHJpbmc7XG4gICAgcmVtYWluaW5nOiBudW1iZXI7XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCB2ID0gdGhpcy52ZXJzaW9uT3JEaWUoZCwgb3B0cy52ZXJzaW9uKTtcbiAgICBpZiAob3B0cy52ZXJzaW9uID09PSBkLmFjdGl2ZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGB2JHtvcHRzLnZlcnNpb259IGlzIHRoZSBhY3RpdmUgdmVyc2lvbiBvZiAke2Quc2x1Z30g4oCUIGFjdGl2YXRlIGFub3RoZXIgb25lIGZpcnN0LCBgICtcbiAgICAgICAgICBgdGhlbiBkZWxldGUgdGhpc2AsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgLy8g4puUIE1BVEVSSUFMSVNFIFRIRSBDT1VOVEVSIEJFRk9SRSBSRU1PVklORyBUSEUgUkVDT1JELiBgdGFrZVZlcnNpb25gXG4gICAgLy8gZGVyaXZlcyBpdCBsYXppbHkgZnJvbSB0aGUgdmVyc2lvbnMgUFJFU0VOVCwgc28gb24gYSBkb2MgdGhhdCBoYXMgbmV2ZXJcbiAgICAvLyBhbGxvY2F0ZWQgb25lIChhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIEU0MSwgcmVzdG9yZWQpIGRlbGV0aW5nIHRoZVxuICAgIC8vIGhpZ2hlc3Qgd291bGQgbGV0IHRoZSBuZXh0IGFsbG9jYXRpb24gZGVyaXZlIHRoZSBzYW1lIG51bWJlciBhZ2Fpbi4gRm91bmRcbiAgICAvLyBieSBkcml2aW5nIGl0LCBub3QgYnkgdGhlIHVuaXQgdGVzdCBhYm92ZSDigJQgd2hpY2ggYWxsb2NhdGVkIGZpcnN0IGFuZCBzb1xuICAgIC8vIG5ldmVyIGhhZCBhIGNvbGQgY291bnRlci5cbiAgICBkLm5leHRWZXJzaW9uID8/PSBNYXRoLm1heCguLi5kLnZlcnNpb25zLm1hcCgoeCkgPT4geC5uKSkgKyAxO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG9wdHMudmVyc2lvbik7XG4gICAgZC52ZXJzaW9ucyA9IGQudmVyc2lvbnMuZmlsdGVyKCh4KSA9PiB4Lm4gIT09IG9wdHMudmVyc2lvbik7XG4gICAgdHJ5IHtcbiAgICAgIHJtU3luYyhwYXRoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIFRoZSByZWNvcmQgaXMgd2hhdCB0aGUgc2Vzc2lvbiBiZWxpZXZlczsgYSBmaWxlIGFscmVhZHkgZ29uZSAoYSBoYW5kXG4gICAgICAvLyB0aWR5LCBhIGNyYXNoIGJldHdlZW4gd3JpdGUgYW5kIHJlY29yZCkgbXVzdCBub3QgYmxvY2sgcmVtb3ZpbmcgaXQuXG4gICAgfVxuICAgIHRoaXMub3duZWQuZGVsZXRlKHBhdGgpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7XG4gICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICB2ZXJzaW9uOiBvcHRzLnZlcnNpb24sXG4gICAgICAuLi4odi5sYWJlbCA/IHsgbGFiZWw6IHYubGFiZWwgfSA6IHt9KSxcbiAgICAgIHJlbWFpbmluZzogZC52ZXJzaW9ucy5sZW5ndGgsXG4gICAgfTtcbiAgfVxuXG4gIGFjdGl2YXRlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXIgfSk6IHsgc2x1Zzogc3RyaW5nOyBwcmV2aW91czogbnVtYmVyIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICB0aGlzLnZlcnNpb25PckRpZShkLCBvcHRzLnZlcnNpb24pO1xuICAgIGNvbnN0IHByZXZpb3VzID0gZC5hY3RpdmU7XG4gICAgZC5hY3RpdmUgPSBvcHRzLnZlcnNpb247XG4gICAgLy8gVGhlIG5ldyBhY3RpdmUgdmVyc2lvbidzIHRleHQgQVMgSVQgSVMgTk9XIGlzIHRoZSBiYXNlbGluZSB0aGUgbmV4dFxuICAgIC8vIGNoZWNrLWJlZm9yZS13cml0ZSBjb21wYXJlcyBhZ2FpbnN0LlxuICAgIHRoaXMuYWRvcHRBY3RpdmUoZCwgcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIikpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1ZywgcHJldmlvdXMgfTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBjb21wYXJpbmcgYW5kIG1lcmdpbmcgKEUzNikg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIFRoZSB0ZXh0IG9mIG9uZSBzaWRlIG9mIGEgY29tcGFyaXNvbi4gYFwib3JpZ2luYWxcImAgaXMgcmVhZCBmcm9tIERJU0ssIG5vdFxuICAgKiBmcm9tIGEgY2FjaGU6IHRoZSB3aG9sZSBwb2ludCBvZiBjb21wYXJpbmcgYWdhaW5zdCBpdCBpcyB0byBzZWUgd2hhdCB0aGVcbiAgICogZmlsZSBvZiByZWNvcmQgYWN0dWFsbHkgc2F5cyByaWdodCBub3csIGluY2x1ZGluZyBhIGNoYW5nZSBzb21lb25lIGVsc2VcbiAgICogbWFkZSB3aGlsZSB0aGlzIHNlc3Npb24gd2FzIG9wZW4uXG4gICAqL1xuICBwcml2YXRlIHNpZGVUZXh0KGQ6IERvY1JlY29yZCwgc2lkZTogRGlmZlNpZGUpOiBzdHJpbmcge1xuICAgIGlmIChzaWRlID09PSBcIm9yaWdpbmFsXCIpIHJldHVybiByZWFkRmlsZVN5bmMoZC5vcmlnaW5hbCwgXCJ1dGY4XCIpO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIHNpZGUpO1xuICAgIHJldHVybiByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBzaWRlKSwgXCJ1dGY4XCIpO1xuICB9XG5cbiAgLyoqIENvbXBhcmUgdGhlIEFDVElWRSB2ZXJzaW9uIChsZWZ0KSBhZ2FpbnN0IGFub3RoZXIgc2lkZSAocmlnaHQpLiAqL1xuICBjb21wYXJlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBhZ2FpbnN0OiBEaWZmU2lkZSB9KTogRGlmZlBheWxvYWQge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBpZiAob3B0cy5hZ2FpbnN0ID09PSBkLmFjdGl2ZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGB2JHtkLmFjdGl2ZX0gaXMgdGhlIGFjdGl2ZSB2ZXJzaW9uIG9mICR7ZC5zbHVnfSDigJQgY29tcGFyaW5nIGl0IHdpdGggaXRzZWxmIHNheXMgbm90aGluZ2AsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgY29uc3QgbGVmdCA9IHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpO1xuICAgIHJldHVybiB7XG4gICAgICBkb2M6IGQuc2x1ZyxcbiAgICAgIGFjdGl2ZTogZC5hY3RpdmUsXG4gICAgICBhZ2FpbnN0OiBvcHRzLmFnYWluc3QsXG4gICAgICBkaWZmOiBkaWZmVGV4dChsZWZ0LCB0aGlzLnNpZGVUZXh0KGQsIG9wdHMuYWdhaW5zdCkpLFxuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogVGFrZSBuYW1lZCBodW5rcyBmcm9tIGBhZ2FpbnN0YCBpbnRvIHRoZSBhY3RpdmUgdmVyc2lvbi5cbiAgICpcbiAgICog4puUIFRIRSBXUklURSBHT0VTIFRIUk9VR0ggYGVkaXRgLCB3aGljaCBpcyB3aGF0IG1ha2VzIGEgbWVyZ2Ugb2JleSBldmVyeVxuICAgKiBydWxlIGFuIG9yZGluYXJ5IGtleXN0cm9rZSBvYmV5czogaXQgbGFuZHMgb24gdGhlIGFjdGl2ZSB2ZXJzaW9uIGFuZCBuZXZlclxuICAgKiB0aGUgb3JpZ2luYWwgKEU3KSwgYW5kIGNoZWNrLWJlZm9yZS13cml0ZSBwcmVzZXJ2ZXMgYW4gb3V0c2lkZSB3cml0ZSBhcyBhXG4gICAqIG5ldyB2ZXJzaW9uIGZpcnN0IChFMikuIEEgbWVyZ2Ugd3JpdGluZyB0aGUgZmlsZSBkaXJlY3RseSB3b3VsZCBiZSB0aGUgb25lXG4gICAqIHBhdGggaW50byB0aGUgZG9jdW1lbnQgdGhhdCBjb3VsZCBzaWxlbnRseSBjbG9iYmVyIHRoZSBhZ2VudC5cbiAgICovXG4gIG1lcmdlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBhZ2FpbnN0OiBEaWZmU2lkZTsgaHVua3M6IG51bWJlcltdIH0pOiB7XG4gICAgc2x1Zzogc3RyaW5nO1xuICAgIHZlcnNpb246IG51bWJlcjtcbiAgICB0ZXh0OiBzdHJpbmc7XG4gICAgYXBwbGllZDogbnVtYmVyO1xuICAgIHByZXNlcnZlZDogVmVyc2lvbiB8IG51bGw7XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBwYXlsb2FkID0gdGhpcy5jb21wYXJlKHsgZG9jOiBkLnNsdWcsIGFnYWluc3Q6IG9wdHMuYWdhaW5zdCB9KTtcbiAgICBjb25zdCBrbm93biA9IG5ldyBTZXQocGF5bG9hZC5kaWZmLmh1bmtzLm1hcCgoaCkgPT4gaC5pZCkpO1xuICAgIGNvbnN0IG1pc3NpbmcgPSBvcHRzLmh1bmtzLmZpbHRlcigoaWQpID0+ICFrbm93bi5oYXMoaWQpKTtcbiAgICBpZiAobWlzc2luZy5sZW5ndGgpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHtkLnNsdWd9IGhhcyBubyBodW5rICR7bWlzc2luZy5qb2luKFwiLCBcIil9IGFnYWluc3QgJHtzaWRlTmFtZShvcHRzLmFnYWluc3QsIGQubmFtZSl9IOKAlCBgICtcbiAgICAgICAgICBgaXQgaGFzICR7a25vd24uc2l6ZSA9PT0gMCA/IFwibm9uZVwiIDogYDEuLiR7TWF0aC5tYXgoLi4ua25vd24pfWB9LiBSdW4gZGlmZiBhZ2FpbjogYCArXG4gICAgICAgICAgYHRoZSB0ZXh0IGNoYW5nZWQgdW5kZXIgdGhlIG51bWJlcnMuYCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBjb25zdCBiZWZvcmUgPSByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKTtcbiAgICBjb25zdCB0ZXh0ID0gYXBwbHlIdW5rcyhiZWZvcmUsIHBheWxvYWQuZGlmZi5odW5rcywgb3B0cy5odW5rcyk7XG4gICAgY29uc3QgeyBwcmVzZXJ2ZWQgfSA9IHRoaXMuZWRpdChkLnNsdWcsIGQuYWN0aXZlLCB0ZXh0KTtcbiAgICByZXR1cm4ge1xuICAgICAgc2x1ZzogZC5zbHVnLFxuICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICB0ZXh0LFxuICAgICAgYXBwbGllZDogb3B0cy5odW5rcy5maWx0ZXIoKGlkKSA9PiBrbm93bi5oYXMoaWQpKS5sZW5ndGgsXG4gICAgICBwcmVzZXJ2ZWQsXG4gICAgfTtcbiAgfVxuXG4gIC8qKiBTYXZlOiB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IG92ZXIgdGhlIG9yaWdpbmFsLiBUaGUgT05MWSB3cml0ZSB0byBpdCAoRTcpLiAqL1xuICBzYXZlKHNsdWc6IHN0cmluZyk6IHsgb3JpZ2luYWw6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggMWM6IFNhdmUgd3JpdGVzIG9ubHkgYW4gb3JpZ2luYWwgYWRtaXR0ZWQgYnlcbiAgICAvLyBgb3BlblBhdGhgIChhIGRvYy10eXBlIGZpbGUgaW5zaWRlIGEgY29udGV4dCBlbnRyeSkuIENoZWNrZWQgYWdhaW4gaGVyZVxuICAgIC8vIHNvIG5vIG90aGVyIHBhdGggaW50byB0aGUgbWFuaWZlc3Qg4oCUIGEgaGFuZC1lZGl0ZWQgb25lLCBhIGZ1dHVyZSB2ZXJiIOKAlFxuICAgIC8vIGNhbiB0dXJuIFNhdmUgaW50byBcIndyaXRlIGFueSBmaWxlXCIuXG4gICAgaWYgKCFkLmFkbWl0dGVkIHx8ICFpc0RvY05hbWUoZC5vcmlnaW5hbCkpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgcmVmdXNpbmcgdG8gc2F2ZSAke2Qub3JpZ2luYWx9OiBpdCB3YXMgbm90IG9wZW5lZCBmcm9tIHRoZSBjb250ZXh0YCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIik7XG4gICAgdGhpcy53cml0ZU93bmVkKGQub3JpZ2luYWwsIHRleHQpO1xuICAgIGQub3JpZ2luYWxIYXNoID0gY29udGVudEhhc2godGV4dCk7XG4gICAgZC5vdXRzaWRlQ2hhbmdlZCA9IGZhbHNlO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IG9yaWdpbmFsOiBkLm9yaWdpbmFsLCB2ZXJzaW9uOiBkLmFjdGl2ZSB9O1xuICB9XG5cbiAgLyoqIFJldmVydDogdGhlIG9yaWdpbmFsJ3MgdGV4dCBiYWNrIG92ZXIgdGhlIGFjdGl2ZSB2ZXJzaW9uLiAqL1xuICByZXZlcnQoc2x1Zzogc3RyaW5nKTogeyB2ZXJzaW9uOiBudW1iZXI7IHRleHQ6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShzbHVnKTtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKGQub3JpZ2luYWwsIFwidXRmOFwiKTtcbiAgICBkLm9yaWdpbmFsSGFzaCA9IGNvbnRlbnRIYXNoKHRleHQpO1xuICAgIGQub3V0c2lkZUNoYW5nZWQgPSBmYWxzZTtcbiAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRleHQpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHZlcnNpb246IGQuYWN0aXZlLCB0ZXh0IH07XG4gIH1cblxuICBwcml2YXRlIGlzRGlydHkoZDogRG9jUmVjb3JkKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuICh0aGlzLmFjdGl2ZUhhc2guZ2V0KGQuc2x1ZykgPz8gXCJcIikgIT09IGQub3JpZ2luYWxIYXNoO1xuICB9XG5cbiAgLy8g4pSA4pSAIHRoZSB3YXRjaGVyJ3MgcXVlc3Rpb246IHdob3NlIHdyaXRlIHdhcyB0aGF0PyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogQ2xhc3NpZnkgb25lIGZpbGVzeXN0ZW0gZXZlbnQuIFJlYWRzIHRoZSBmaWxlOyByZXR1cm5zIGBudWxsYCB3aGVuIGl0IGlzXG4gICAqIHRoZSBkYWVtb24ncyBvd24gd3JpdGUsIHVuY2hhbmdlZCwgZ29uZSwgb3Igbm90IG91cnMgdG8gY2FyZSBhYm91dC5cbiAgICovXG4gIG9uRmlsZUV2ZW50KGFiczogc3RyaW5nKTogRmlsZUV2ZW50IHwgbnVsbCB7XG4gICAgLy8gQSB2ZXJzaW9uIGZpbGUgdW5kZXIgZG9jcy88c2x1Zz4vdk4uZXh0P1xuICAgIGlmIChhYnMuc3RhcnRzV2l0aCh0aGlzLmRvY3NEaXIgKyBzZXApKSB7XG4gICAgICBjb25zdCByZXN0ID0gYWJzLnNsaWNlKHRoaXMuZG9jc0Rpci5sZW5ndGggKyAxKS5zcGxpdChzZXApO1xuICAgICAgaWYgKHJlc3QubGVuZ3RoICE9PSAyKSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IFtzbHVnLCBmaWxlXSA9IHJlc3QgYXMgW3N0cmluZywgc3RyaW5nXTtcbiAgICAgIGNvbnN0IGQgPSB0aGlzLm0uZG9jcy5maW5kKCh4KSA9PiB4LnNsdWcgPT09IHNsdWcpO1xuICAgICAgY29uc3QgbWF0Y2ggPSAvXnYoXFxkKykoXFwuW2Etel0rKSQvLmV4ZWMoZmlsZSk7XG4gICAgICBpZiAoIWQgfHwgIW1hdGNoIHx8IG1hdGNoWzJdICE9PSBkLmV4dCkgcmV0dXJuIG51bGw7XG4gICAgICBjb25zdCBuID0gTnVtYmVyKG1hdGNoWzFdKTtcbiAgICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgICB0cnkge1xuICAgICAgICB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgaWYgKHRoaXMuaXNPd25Xcml0ZShhYnMsIHRleHQpKSByZXR1cm4gbnVsbDtcbiAgICAgIGlmICghZC52ZXJzaW9ucy5zb21lKCh2KSA9PiB2Lm4gPT09IG4pKSB7XG4gICAgICAgIC8vIFRoZSBhZ2VudCB3cm90ZSBhIHZlcnNpb24gZmlsZSBieSBoYW5kIHJhdGhlciB0aGFuIHRocm91Z2hcbiAgICAgICAgLy8gYHZlcnNpb24tbmV3YCDigJQgYWRvcHQgaXQgcmF0aGVyIHRoYW4gbGVhdmUgYSBmaWxlIHRoZSBzdXJmYWNlIGNhbm5vdCBzZWUuXG4gICAgICAgIGQudmVyc2lvbnMucHVzaCh7IG4sIGF1dGhvcjogXCJhZ2VudFwiLCBjcmVhdGVkQXQ6IERhdGUubm93KCkgfSk7XG4gICAgICAgIGQudmVyc2lvbnMuc29ydCgoYSwgYikgPT4gYS5uIC0gYi5uKTtcbiAgICAgICAgdGhpcy5vd25lZC5zZXQoYWJzLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgICByZXR1cm4geyBraW5kOiBcInZlcnNpb24uY3JlYXRlZFwiLCBkb2M6IGQuc2x1ZywgdmVyc2lvbjogbiwgcGF0aDogYWJzIH07XG4gICAgICB9XG4gICAgICBpZiAobiA9PT0gZC5hY3RpdmUpIHtcbiAgICAgICAgLy8gRTIsIHJlZnVzZWQgYW5kIFJFLUxBQkVMTEVEOiB0aGUgb3V0c2lkZSB0ZXh0IGJlY29tZXMgYSBuZXcgYWdlbnRcbiAgICAgICAgLy8gdmVyc2lvbiwgYW5kIHRoZSBhY3RpdmUgdmVyc2lvbiBnb2VzIGJhY2sgdG8gdGhlIGRhZW1vbidzIG93biBsYXN0XG4gICAgICAgIC8vIHRleHQg4oCUIHNvIHRoZSBhY3RpdmUgdmVyc2lvbiBvbmx5IGV2ZXIgaG9sZHMgd2hhdCB0aGUgaHVtYW4gdHlwZWQsXG4gICAgICAgIC8vIGFuZCBub3RoaW5nIGFueW9uZSB3cm90ZSBpcyBsb3N0ICh2ZXJpZnktcGFzcyBmaXggNCwgd2F0Y2hlciBoYWxmKS5cbiAgICAgICAgY29uc3Qga2VwdCA9IHRoaXMucHJlc2VydmVPdXRzaWRlKGQsIHRleHQpO1xuICAgICAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRoaXMubGFzdEFjdGl2ZVRleHQuZ2V0KGQuc2x1ZykgPz8gdGV4dCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAga2luZDogXCJhY3RpdmUub3V0c2lkZVwiLFxuICAgICAgICAgIGRvYzogZC5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IG4sXG4gICAgICAgICAgcGF0aDogYWJzLFxuICAgICAgICAgIHByZXNlcnZlZEFzOiBrZXB0Lm4sXG4gICAgICAgICAgcHJlc2VydmVkUGF0aDoga2VwdC5wYXRoLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgdGhpcy5vd25lZC5zZXQoYWJzLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgICByZXR1cm4geyBraW5kOiBcInZlcnNpb24uY2hhbmdlZFwiLCBkb2M6IGQuc2x1ZywgdmVyc2lvbjogbiwgdGV4dCwgYWN0aXZlOiBmYWxzZSB9O1xuICAgIH1cblxuICAgIC8vIEFuIG9wZW5lZCBvcmlnaW5hbCDigJQgYnkgaXRzIHN0b3JlZCBwYXRoLCBvciBieSByZWFscGF0aCBmb3IgYSBzeW1saW5rP1xuICAgIGNvbnN0IGQgPSB0aGlzLm0uZG9jcy5maW5kKCh4KSA9PiB4Lm9yaWdpbmFsID09PSBhYnMgfHwgcmVhbE9yKHgub3JpZ2luYWwpID09PSBhYnMpO1xuICAgIGlmIChkKSB7XG4gICAgICBsZXQgdGV4dDogc3RyaW5nO1xuICAgICAgdHJ5IHtcbiAgICAgICAgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGggPSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgICAgIGlmIChoID09PSBkLm9yaWdpbmFsSGFzaCkgcmV0dXJuIG51bGw7IC8vIG91ciBvd24gc2F2ZSwgb3Igbm8gY2hhbmdlXG4gICAgICBjb25zdCBjbGVhbiA9ICF0aGlzLmlzRGlydHkoZCk7XG4gICAgICBpZiAoY2xlYW4pIHtcbiAgICAgICAgZC5vcmlnaW5hbEhhc2ggPSBoO1xuICAgICAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRleHQpO1xuICAgICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBraW5kOiBcIm9yaWdpbmFsLnJlbG9hZGVkXCIsXG4gICAgICAgICAgZG9jOiBkLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICAgICAgdGV4dCxcbiAgICAgICAgICBvcmlnaW5hbDogZC5vcmlnaW5hbCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGlmIChkLm91dHNpZGVDaGFuZ2VkKSByZXR1cm4gbnVsbDsgLy8gYWxyZWFkeSBhc2tlZFxuICAgICAgZC5vdXRzaWRlQ2hhbmdlZCA9IHRydWU7XG4gICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgIHJldHVybiB7IGtpbmQ6IFwib3JpZ2luYWwuY29uZmxpY3RcIiwgZG9jOiBkLnNsdWcsIG9yaWdpbmFsOiBkLm9yaWdpbmFsIH07XG4gICAgfVxuXG4gICAgLy8gU29tZXRoaW5nIHVuZGVyIGEgbWlycm9yZWQgcm9vdDogdGhlIHRyZWUgbWF5IGhhdmUgY2hhbmdlZC5cbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiAmJiAoYWJzID09PSBlLnJvb3QgfHwgYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMucmVzY2FuKGUuaWQpID8geyBraW5kOiBcInRyZWVcIiwgZW50cnlJZDogZS5pZCB9IDogbnVsbDtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICAvLyDilIDilIAgc3RydWN0dXJlIChFMjLigJNFMjQpOiByZWFsIGNoYW5nZXMgb24gZGlzaywgb25lIHBhdGggZm9yIGJvdGggcGFydGllcyDilIDilIBcbiAgLy9cbiAgLy8gRXZlcnkgbWV0aG9kIGJlbG93IGRvZXMgdGhlIGNoYW5nZSBPTiBESVNLIGFuZCB0aGVuIGJyaW5ncyB0aGUgY29udGV4dFxuICAvLyBtb2RlbCBiYWNrIGluIGxpbmUgd2l0aCBpdC4gVGhlIHN1cmZhY2UgcmVhY2hlcyB0aGVtIHRocm91Z2ggbWVudXMgYW5kXG4gIC8vIGRyYWcgYW5kIGRyb3AsIHRoZSBhZ2VudCB0aHJvdWdoIENMSSB2ZXJiczsgdGhlIGRhZW1vbiBhbm5vdW5jZXMgZWFjaCBvbmVcbiAgLy8gdW5kZXIgdGhlIG5hbWUgb2Ygd2hvZXZlciBkaWQgaXQuIFR3byBydWxlcyBob2xkIHRocm91Z2hvdXQ6XG4gIC8vXG4gIC8vIC0gTk9USElORyBJUyBERUxFVEVELiBgaGlkZWAgdGFrZXMgYSBub2RlIG91dCBvZiBTY3JpcHRvcml1bTsgdGhlIGZpbGUgc3RheXMuXG4gIC8vIC0gTk9USElORyBJUyBPVkVSV1JJVFRFTi4gQSBkZXN0aW5hdGlvbiB0aGF0IGV4aXN0cyBpcyByZWZ1c2VkIChhbiBleHBsaWNpdFxuICAvLyAgIG5hbWUpIG9yIGdpdmVuIGEgZnJlZSBuYW1lIChhIGRlZmF1bHQgb25lLCBhIGRyb3ApOyBmaWxlcyBhcmUgY3JlYXRlZFxuICAvLyAgIHdpdGggdGhlIGV4Y2x1c2l2ZSBmbGFnLCBzbyBhIHJhY2UgY2Fubm90IGNsb2JiZXIgZWl0aGVyLlxuXG4gIC8qKiBFMjM6IHdoZXJlIGRyb3BzIGFuZCBuZXcgdG9wLWxldmVsIGRvY3VtZW50cyBsYW5kLiAqL1xuICBnZXQgd29ya3NwYWNlKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHRoaXMubS53b3Jrc3BhY2UgPz8gaG9tZWRpcigpO1xuICB9XG5cbiAgc2V0V29ya3NwYWNlKHJhd1BhdGg6IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGFicyA9IHJlc29sdmUocmF3UGF0aCk7XG4gICAgbGV0IGlzRGlyID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGlzRGlyID0gc3RhdFN5bmMoYWJzKS5pc0RpcmVjdG9yeSgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgbm8gc3VjaCBmb2xkZXI6ICR7YWJzfWAsIDQwNCk7XG4gICAgfVxuICAgIGlmICghaXNEaXIpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYHRoZSB3b3Jrc3BhY2UgbXVzdCBiZSBhIGZvbGRlcjogJHthYnN9YCwgNDAwKTtcbiAgICB0aGlzLm0ud29ya3NwYWNlID0gYWJzO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicyB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEhvdyBhIHBhdGggcmVhZHMgaW4gYSBjaGF0IGxpbmU6IGBzZXQvcmVsYCBpbnNpZGUgYSBzZXQsIGEgc2luZ2xlXG4gICAqIGRvY3VtZW50J3MgZmlsZSBuYW1lLCBgd29ya3NwYWNlL+KApmAgaW4gdGhlIHdvcmtzcGFjZSwgZWxzZSBgfi/igKZgLlxuICAgKi9cbiAgZGlzcGxheShhYnM6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIpIHtcbiAgICAgICAgaWYgKGFicyA9PT0gZS5yb290KSByZXR1cm4gZS5sYWJlbDtcbiAgICAgICAgaWYgKGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpIHJldHVybiBgJHtlLmxhYmVsfS8ke3RvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKX1gO1xuICAgICAgfSBlbHNlIGlmIChlLm5vZGVzLnNvbWUoKG4pID0+IGpvaW4oZS5yb290LCBuLnJlbCkgPT09IGFicykpIHJldHVybiBlLmxhYmVsO1xuICAgIH1cbiAgICBpZiAoYWJzLnN0YXJ0c1dpdGgodGhpcy53b3Jrc3BhY2UgKyBzZXApKVxuICAgICAgcmV0dXJuIGB3b3Jrc3BhY2UvJHt0b1Bvc2l4KHJlbGF0aXZlKHRoaXMud29ya3NwYWNlLCBhYnMpKX1gO1xuICAgIGNvbnN0IGhvbWUgPSBob21lZGlyKCk7XG4gICAgcmV0dXJuIGFicyA9PT0gaG9tZSA/IFwiflwiIDogYWJzLnN0YXJ0c1dpdGgoaG9tZSArIHNlcCkgPyBgfiR7YWJzLnNsaWNlKGhvbWUubGVuZ3RoKX1gIDogYWJzO1xuICB9XG5cbiAgLyoqXG4gICAqIGBhYnNgIHNwZWxsZWQgdGhlIHdheSB0aGUgY29udGV4dCBzcGVsbHMgaXQuIEEgY2FsbGVyIHdob3NlIGN3ZCBpcyBhXG4gICAqIHJlYWxwYXRoICgvcHJpdmF0ZS92YXIv4oCmIGZvciAvdmFyL+KApiwgYSBzeW1saW5rZWQgZm9sZGVyKSBuYW1lcyB0aGUgc2FtZVxuICAgKiBwbGFjZSBkaWZmZXJlbnRseSwgYW5kIGl0IG11c3QgbGFuZCBvbiB0aGUgc2FtZSBub2RlLlxuICAgKi9cbiAgcHJpdmF0ZSBzcGVsbChhYnM6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKHRoaXMubS5jb250ZXh0LnNvbWUoKGUpID0+IGFicyA9PT0gZS5yb290IHx8IGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpKSByZXR1cm4gYWJzO1xuICAgIGNvbnN0IHJlYWwgPSByZWFsT3IoYWJzKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGNvbnN0IHJlYWxSb290ID0gcmVhbE9yKGUucm9vdCk7XG4gICAgICBpZiAocmVhbCA9PT0gcmVhbFJvb3QpIHJldHVybiBlLnJvb3Q7XG4gICAgICBpZiAocmVhbC5zdGFydHNXaXRoKHJlYWxSb290ICsgc2VwKSkgcmV0dXJuIGpvaW4oZS5yb290LCByZWxhdGl2ZShyZWFsUm9vdCwgcmVhbCkpO1xuICAgIH1cbiAgICByZXR1cm4gYWJzO1xuICB9XG5cbiAgcHJpdmF0ZSBpc1dvcmtzcGFjZShhYnM6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBhYnMgPT09IHRoaXMud29ya3NwYWNlIHx8IHJlYWxPcihhYnMpID09PSByZWFsT3IodGhpcy53b3Jrc3BhY2UpO1xuICB9XG5cbiAgLyoqIFRoZSBtaXJyb3JlZCBlbnRyeSB0aGF0IGNvdmVycyBgYWJzYCAoaXRzIHJvb3QsIG9yIGFueXRoaW5nIHVuZGVyIGl0KSwgaWYgYW55LiAqL1xuICBwcml2YXRlIGNvdmVyaW5nRW50cnkoYWJzOiBzdHJpbmcsIGV4Y2VwdD86IHN0cmluZyk6IENvbnRleHRFbnRyeSB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMubS5jb250ZXh0LmZpbmQoXG4gICAgICAoZSkgPT5cbiAgICAgICAgZS5pZCAhPT0gZXhjZXB0ICYmXG4gICAgICAgIGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiICYmXG4gICAgICAgIChhYnMgPT09IGUucm9vdCB8fCBhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSxcbiAgICApO1xuICB9XG5cbiAgLyoqXG4gICAqIEEgZm9sZGVyIHRoaW5ncyBtYXkgYmUgbWFkZSBpbiBvciBtb3ZlZCBpbnRvOiBhIG1pcnJvcmVkIGVudHJ5J3Mgcm9vdCwgYVxuICAgKiB2aXNpYmxlIGZvbGRlciB1bmRlciBvbmUsIG9yIHRoZSB3b3Jrc3BhY2UuIFJldHVybnMgdGhlIGFic29sdXRlIGZvbGRlcjtcbiAgICogcmVmdXNlcyBhbnl0aGluZyBlbHNlIOKAlCB0aGUgY29udGV4dCBzdGF5cyB0aGUgd2F5IGluICh2ZXJpZnktcGFzcyBmaXggMWIpLlxuICAgKi9cbiAgcHJpdmF0ZSBkZXN0aW5hdGlvbk9yRGllKHJhd0Rpcjogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBhYnMgPSB0aGlzLnNwZWxsKHJlc29sdmUocmF3RGlyKSk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwICE9PSBcIm1pcnJvcmVkXCIpIGNvbnRpbnVlO1xuICAgICAgaWYgKGFicyA9PT0gZS5yb290KSByZXR1cm4gYWJzO1xuICAgICAgaWYgKGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpIHtcbiAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKGUubm9kZXMsIHRvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKSk7XG4gICAgICAgIGlmIChub2RlPy5raW5kID09PSBcImdyb3VwXCIpIHJldHVybiBhYnM7XG4gICAgICB9XG4gICAgfVxuICAgIGlmICh0aGlzLmlzV29ya3NwYWNlKGFicykpIHJldHVybiB0aGlzLndvcmtzcGFjZTtcbiAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgYCR7YWJzfSBpcyBub3QgYSBmb2xkZXIgaW4gdGhpcyBzZXNzaW9uIOKAlCBuYW1lIGEgc2V0LCBhIGZvbGRlciBpbnNpZGUgb25lLCBvciB0aGUgd29ya3NwYWNlICgke3RoaXMud29ya3NwYWNlfSlgLFxuICAgICAgNDAwLFxuICAgICk7XG4gIH1cblxuICAvKiogQSBkb2N1bWVudCBvciBmb2xkZXIgc2hvd24gaW4gdGhlIGNvbnRleHQsIHdpdGggd2hlcmUgaXQgaXMgc2hvd24uICovXG4gIHByaXZhdGUgaXRlbU9yRGllKHJhd1BhdGg6IHN0cmluZyk6IHtcbiAgICBhYnM6IHN0cmluZztcbiAgICBlbnRyeTogQ29udGV4dEVudHJ5O1xuICAgIC8qKiBUaGUgd2hvbGUgZW50cnkgKGEgc2V0J3Mgb3duIGZvbGRlciwgYSBsaXN0ZWQgZG9jdW1lbnQpLCBvciBhIG5vZGUgaW5zaWRlIGEgc2V0LiAqL1xuICAgIHdob2xlOiBib29sZWFuO1xuICAgIGRpcjogYm9vbGVhbjtcbiAgfSB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zcGVsbChyZXNvbHZlKHJhd1BhdGgpKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibGlzdGVkXCIpIHtcbiAgICAgICAgY29uc3Qgb25seSA9IGUubm9kZXNbMF07XG4gICAgICAgIGlmIChlLm5vZGVzLmxlbmd0aCA9PT0gMSAmJiBvbmx5Py5raW5kID09PSBcImRvY1wiICYmIGpvaW4oZS5yb290LCBvbmx5LnJlbCkgPT09IGFicylcbiAgICAgICAgICByZXR1cm4geyBhYnMsIGVudHJ5OiBlLCB3aG9sZTogdHJ1ZSwgZGlyOiBmYWxzZSB9O1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChhYnMgPT09IGUucm9vdCkgcmV0dXJuIHsgYWJzLCBlbnRyeTogZSwgd2hvbGU6IHRydWUsIGRpcjogdHJ1ZSB9O1xuICAgICAgaWYgKGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpIHtcbiAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKGUubm9kZXMsIHRvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKSk7XG4gICAgICAgIGlmIChub2RlKSByZXR1cm4geyBhYnMsIGVudHJ5OiBlLCB3aG9sZTogZmFsc2UsIGRpcjogbm9kZS5raW5kID09PSBcImdyb3VwXCIgfTtcbiAgICAgIH1cbiAgICB9XG4gICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHthYnN9IGlzIG5vdCBzaG93biBpbiB0aGlzIHNlc3Npb24ncyBjb250ZXh0YCwgNDA0KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBgcmF3UGF0aGAgaWYgdGhlIGNvbnRleHQgc2hvd3MgaXQg4oCUIGEgZG9jdW1lbnQgb3IgZm9sZGVyIGluIGEgc2V0LCBhXG4gICAqIGxpc3RlZCBkb2N1bWVudCwgYSBzZXQncyBvd24gZm9sZGVyIOKAlCBvciBpdCBpcyB0aGUgd29ya3NwYWNlOyByZWZ1c2VkXG4gICAqIG90aGVyd2lzZS4gRm9yIGFjdHMgdGhhdCByZWFjaCBvdXRzaWRlIHRoZSBzcGVsbCAocmV2ZWFsaW5nIGEgcGF0aCBpbiB0aGVcbiAgICogZmlsZSBtYW5hZ2VyKSwgc28gYSBwYWdlIGNhbm5vdCBhaW0gdGhlbSBhdCBhbiBhcmJpdHJhcnkgcGF0aC5cbiAgICovXG4gIHNob3duUGF0aChyYXdQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc3BlbGwocmVzb2x2ZShyYXdQYXRoKSk7XG4gICAgaWYgKHRoaXMuaXRlbUF0KGFicykpIHJldHVybiBhYnM7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiB0aGlzLmRlc3RpbmF0aW9uT3JEaWUoYWJzKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YWJzfSBpcyBub3Qgc2hvd24gaW4gdGhpcyBzZXNzaW9uYCwgNDAwKTtcbiAgICB9XG4gIH1cblxuICAvKiogUmVmdXNlIGEgbmFtZSB0aGF0IGlzIG5vdCBvbmUgcGxhaW4gZmlsZSBvciBmb2xkZXIgbmFtZS4gKi9cbiAgcHJpdmF0ZSBuYW1lT3JEaWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBuID0gbmFtZS50cmltKCk7XG4gICAgaWYgKFxuICAgICAgbiA9PT0gXCJcIiB8fFxuICAgICAgbiA9PT0gXCIuXCIgfHxcbiAgICAgIG4gPT09IFwiLi5cIiB8fFxuICAgICAgbi5zdGFydHNXaXRoKFwiLlwiKSB8fFxuICAgICAgL1svXFxcXFxcMF0vLnRlc3QobikgfHxcbiAgICAgIG4ubGVuZ3RoID4gMjU1XG4gICAgKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYFwiJHtuYW1lfVwiIGlzIG5vdCBhIHVzYWJsZSBuYW1lIOKAlCBvbmUgcGxhaW4gbmFtZSwgbm8gc2xhc2hlcywgbm90IHN0YXJ0aW5nIHdpdGggYSBkb3RgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIHJldHVybiBuO1xuICB9XG5cbiAgLyoqIEEgZG9jdW1lbnQgbmFtZTogYSBuYW1lIHdpdGhvdXQgYSBkb2N1bWVudCBleHRlbnNpb24gZ2V0cyBgLm1kYC4gKi9cbiAgcHJpdmF0ZSBkb2NOYW1lT3JEaWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBuID0gdGhpcy5uYW1lT3JEaWUobmFtZSk7XG4gICAgcmV0dXJuIGlzRG9jTmFtZShuKSA/IG4gOiBgJHtufS5tZGA7XG4gIH1cblxuICAvKipcbiAgICogQWZ0ZXIgc29tZXRoaW5nIG1vdmVkIG9uIGRpc2sgZnJvbSBgZnJvbWAgdG8gYHRvYCwgYnJpbmcgdGhlIG1vZGVsIHdpdGggaXQ6XG4gICAqIG9wZW5lZCBkb2N1bWVudHMga2VlcCB0aGVpciB2ZXJzaW9ucyB1bmRlciB0aGUgbmV3IHBhdGgsIGVudHJpZXMgcm9vdGVkIGF0XG4gICAqIG9yIGhvbGRpbmcgdGhlIG1vdmVkIHRoaW5nIGZvbGxvdyBpdCwgYW5kIGV2ZXJ5IG1pcnJvciBpcyByZS1yZWFkLiBBbiBlbnRyeVxuICAgKiB0aGF0IG5vdyBzaXRzIGluc2lkZSBhbm90aGVyIHNldCBpcyBkcm9wcGVkIOKAlCB0aGUgc2V0IHNob3dzIGl0IGFscmVhZHkuXG4gICAqL1xuICBwcml2YXRlIGZvbGxvd01vdmUoZnJvbTogc3RyaW5nLCB0bzogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgbW92ZWQgPSAocDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCA9PlxuICAgICAgcCA9PT0gZnJvbSA/IHRvIDogcC5zdGFydHNXaXRoKGZyb20gKyBzZXApID8gdG8gKyBwLnNsaWNlKGZyb20ubGVuZ3RoKSA6IG51bGw7XG4gICAgZm9yIChjb25zdCBkIG9mIHRoaXMubS5kb2NzKSB7XG4gICAgICBjb25zdCBub3cgPSBtb3ZlZChkLm9yaWdpbmFsKTtcbiAgICAgIGlmIChub3cpIHtcbiAgICAgICAgZC5vcmlnaW5hbCA9IG5vdztcbiAgICAgICAgZC5uYW1lID0gYmFzZW5hbWUobm93KTtcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgZHJvcCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJsaXN0ZWRcIikge1xuICAgICAgICBjb25zdCBvbmx5ID0gZS5ub2Rlc1swXTtcbiAgICAgICAgaWYgKG9ubHk/LmtpbmQgIT09IFwiZG9jXCIpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBub3cgPSBtb3ZlZChqb2luKGUucm9vdCwgb25seS5yZWwpKTtcbiAgICAgICAgaWYgKCFub3cpIGNvbnRpbnVlO1xuICAgICAgICBpZiAodGhpcy5jb3ZlcmluZ0VudHJ5KG5vdywgZS5pZCkpIGRyb3AuYWRkKGUuaWQpO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBlLnJvb3QgPSBkaXJuYW1lKG5vdyk7XG4gICAgICAgICAgZS5sYWJlbCA9IGJhc2VuYW1lKG5vdyk7XG4gICAgICAgICAgZS5ub2RlcyA9IFt7IGtpbmQ6IFwiZG9jXCIsIHJlbDogYmFzZW5hbWUobm93KSB9XTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3Qgbm93ID0gbW92ZWQoZS5yb290KTtcbiAgICAgICAgaWYgKCFub3cpIGNvbnRpbnVlO1xuICAgICAgICBpZiAodGhpcy5jb3ZlcmluZ0VudHJ5KG5vdywgZS5pZCkpIGRyb3AuYWRkKGUuaWQpO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBlLnJvb3QgPSBub3c7XG4gICAgICAgICAgZS5sYWJlbCA9IGJhc2VuYW1lKG5vdykgfHwgbm93O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHRoaXMubS5jb250ZXh0ID0gdGhpcy5tLmNvbnRleHQuZmlsdGVyKChlKSA9PiAhZHJvcC5oYXMoZS5pZCkpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiKSB0aGlzLnJlc2NhbihlLmlkKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICB9XG5cbiAgLyoqIEFmdGVyIGEgZmlsZSBvciBmb2xkZXIgbGFuZGVkIGF0IGBhYnNgOiByZS1yZWFkIHRoZSBzZXQgaXQgaXMgaW4sIG9yIGdpdmUgaXQgYW4gZW50cnkuICovXG4gIHByaXZhdGUgYWRvcHROZXcoYWJzOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBzZXQgPSB0aGlzLmNvdmVyaW5nRW50cnkoYWJzKTtcbiAgICBpZiAoc2V0KSB0aGlzLnJlc2NhbihzZXQuaWQpO1xuICAgIGVsc2UgdGhpcy5tLmNvbnRleHQucHVzaChlbnRyeUZvclBhdGgoYWJzLCBgYy0ke3JhbmRIZXgoMyl9YCkpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gIH1cblxuICAvKiogQSBuYW1lIGluIGBkaXJgIHRoYXQgaXMgZnJlZTogYG5hbWVgLCBlbHNlIGBzdGVtIDIuZXh0YCwgYHN0ZW0gMy5leHRgLCDigKYgKi9cbiAgcHJpdmF0ZSBmcmVlTmFtZShkaXI6IHN0cmluZywgbmFtZTogc3RyaW5nLCBpc0RpcjogYm9vbGVhbik6IHN0cmluZyB7XG4gICAgaWYgKCFleGlzdHNTeW5jKGpvaW4oZGlyLCBuYW1lKSkpIHJldHVybiBuYW1lO1xuICAgIGNvbnN0IGV4dCA9IGlzRGlyID8gXCJcIiA6IGV4dG5hbWUobmFtZSk7XG4gICAgY29uc3Qgc3RlbSA9IGV4dCA/IG5hbWUuc2xpY2UoMCwgLWV4dC5sZW5ndGgpIDogbmFtZTtcbiAgICBmb3IgKGxldCBpID0gMjsgOyBpKyspIHtcbiAgICAgIGNvbnN0IG4gPSBgJHtzdGVtfSAke2l9JHtleHR9YDtcbiAgICAgIGlmICghZXhpc3RzU3luYyhqb2luKGRpciwgbikpKSByZXR1cm4gbjtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHJlZnVzZUV4aXN0aW5nKGFiczogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKGV4aXN0c1N5bmMoYWJzKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YWJzfSBhbHJlYWR5IGV4aXN0cyDigJQgbm90aGluZyB3YXMgb3ZlcndyaXR0ZW5gLCA0MDkpO1xuICB9XG5cbiAgY3JlYXRlRG9jKHJhd0Rpcjogc3RyaW5nLCBuYW1lPzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZGlyID0gdGhpcy5kZXN0aW5hdGlvbk9yRGllKHJhd0Rpcik7XG4gICAgY29uc3QgZmlsZSA9XG4gICAgICBuYW1lID09PSB1bmRlZmluZWQgPyB0aGlzLmZyZWVOYW1lKGRpciwgXCJVbnRpdGxlZC5tZFwiLCBmYWxzZSkgOiB0aGlzLmRvY05hbWVPckRpZShuYW1lKTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgZmlsZSk7XG4gICAgdGhpcy5yZWZ1c2VFeGlzdGluZyhhYnMpO1xuICAgIHdyaXRlRmlsZVN5bmMoYWJzLCBcIlwiLCB7IGZsYWc6IFwid3hcIiB9KTtcbiAgICB0aGlzLmFkb3B0TmV3KGFicyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzIH07XG4gIH1cblxuICBjcmVhdGVGb2xkZXIocmF3RGlyOiBzdHJpbmcsIG5hbWU/OiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkaXIgPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3RGlyKTtcbiAgICBjb25zdCBmb2xkZXIgPVxuICAgICAgbmFtZSA9PT0gdW5kZWZpbmVkID8gdGhpcy5mcmVlTmFtZShkaXIsIFwiTmV3IGZvbGRlclwiLCB0cnVlKSA6IHRoaXMubmFtZU9yRGllKG5hbWUpO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBmb2xkZXIpO1xuICAgIHRoaXMucmVmdXNlRXhpc3RpbmcoYWJzKTtcbiAgICBta2RpclN5bmMoYWJzKTtcbiAgICB0aGlzLmFkb3B0TmV3KGFicyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzIH07XG4gIH1cblxuICAvKipcbiAgICogRTI2OiB3aGF0IGEgbW92ZSBXT1VMRCBkbywgZm9yIHRoZSBjb25maXJtYXRpb24gdGhlIHN1cmZhY2Ugc2hvd3MgYmVmb3JlXG4gICAqIG1vdmluZyBhIEZPTERFUi4gUmVhZHMgbm90aGluZyBidXQgdGhlIGRpc2sgYW5kIHJlZnVzZXMgZXhhY3RseSB3aGF0XG4gICAqIGBtb3ZlYCB3b3VsZCByZWZ1c2UsIHNvIGEgY29uZmlybWVkIG1vdmUgY2Fubm90IHRoZW4gZmFpbCBvbiBhZG1pc3Npb24uXG4gICAqXG4gICAqIFRoZSBnaXQgaGFsZiBpcyBoZXJlIGJlY2F1c2Ugb25seSB0aGUgZGFlbW9uIGNhbiBzZWUgYSBgLmdpdGA6IGEgZm9sZGVyXG4gICAqIGRyYWdnZWQgb3V0IG9mIGEgcmVwb3NpdG9yeSBpcyB0aGUgY2FzZSB3aGVyZSB0aGUgY29uc2VxdWVuY2UgcmVhY2hlcyBwYXN0XG4gICAqIHNjcmlwdG9yaXVtIChDb2xlIG1vdmVkIHRoaXMgcHJvamVjdCdzIG93biBkb2NzIGZvbGRlciBpbnRvIGhpcyB3b3Jrc3BhY2UsXG4gICAqIGFuZCBnaXQgc2F3IHNpeCBkZWxldGVkIGZpbGVzKS5cbiAgICovXG4gIG1vdmVQbGFuKHJhd1BhdGg6IHN0cmluZywgcmF3SW50bzogc3RyaW5nKTogTW92ZVBsYW4ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBjb25zdCBpbnRvID0gdGhpcy5kZXN0aW5hdGlvbk9yRGllKHJhd0ludG8pO1xuICAgIGNvbnN0IGZyb21SZXBvID0gZ2l0Um9vdE9mKGRpcm5hbWUoaXRlbS5hYnMpKTtcbiAgICBjb25zdCBpbnRvUmVwbyA9IGdpdFJvb3RPZihpbnRvKTtcbiAgICByZXR1cm4ge1xuICAgICAgZnJvbTogaXRlbS5hYnMsXG4gICAgICBpbnRvLFxuICAgICAgbmFtZTogYmFzZW5hbWUoaXRlbS5hYnMpLFxuICAgICAgZm9sZGVyOiBpdGVtLmRpcixcbiAgICAgIGRvY3M6IGl0ZW0uZGlyID8gY291bnREb2NzKGl0ZW0uYWJzKSA6IDEsXG4gICAgICByZXBvOiBmcm9tUmVwbyA/IGJhc2VuYW1lKGZyb21SZXBvKSA6IG51bGwsXG4gICAgICBsZWF2ZXNSZXBvOiBmcm9tUmVwbyAhPT0gbnVsbCAmJiBmcm9tUmVwbyAhPT0gaW50b1JlcG8sXG4gICAgfTtcbiAgfVxuXG4gIG1vdmUocmF3UGF0aDogc3RyaW5nLCByYXdJbnRvOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZnJvbTogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBjb25zdCBpbnRvID0gdGhpcy5kZXN0aW5hdGlvbk9yRGllKHJhd0ludG8pO1xuICAgIGlmIChpbnRvID09PSBpdGVtLmFicyB8fCBpbnRvLnN0YXJ0c1dpdGgoaXRlbS5hYnMgKyBzZXApKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgY2Fubm90IG1vdmUgJHt0aGlzLmRpc3BsYXkoaXRlbS5hYnMpfSBpbnRvIGl0c2VsZmAsIDQwMCk7XG4gICAgaWYgKGRpcm5hbWUoaXRlbS5hYnMpID09PSBpbnRvKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHt0aGlzLmRpc3BsYXkoaXRlbS5hYnMpfSBpcyBhbHJlYWR5IGluIHRoYXQgZm9sZGVyYCwgNDAwKTtcbiAgICBjb25zdCB0byA9IGpvaW4oaW50bywgYmFzZW5hbWUoaXRlbS5hYnMpKTtcbiAgICB0aGlzLnJlZnVzZUV4aXN0aW5nKHRvKTtcbiAgICB0aGlzLnJlbmFtZU9yRGllKGl0ZW0uYWJzLCB0byk7XG4gICAgdGhpcy5mb2xsb3dNb3ZlKGl0ZW0uYWJzLCB0byk7XG4gICAgaWYgKCF0aGlzLml0ZW1BdCh0bykpIHRoaXMuYWRvcHROZXcodG8pO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IHRvLCBmcm9tOiBpdGVtLmFicyB9O1xuICB9XG5cbiAgcmVuYW1lKHJhd1BhdGg6IHN0cmluZywgbmFtZTogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IGZyb206IHN0cmluZyB9IHtcbiAgICBjb25zdCBpdGVtID0gdGhpcy5pdGVtT3JEaWUocmF3UGF0aCk7XG4gICAgbGV0IG5leHQgPSB0aGlzLm5hbWVPckRpZShuYW1lKTtcbiAgICAvLyBBIGRvY3VtZW50IGtlZXBzIGEgZG9jdW1lbnQgZXh0ZW5zaW9uOiBcIm5vdGVzXCIgcmVuYW1lcyBub3Rlcy5tZCB0b1xuICAgIC8vIG5vdGVzLm1kLCBub3QgdG8gYW4gZXh0ZW5zaW9ubGVzcyBmaWxlIFNjcmlwdG9yaXVtIHdvdWxkIHN0b3Agc2hvd2luZy5cbiAgICBpZiAoIWl0ZW0uZGlyICYmICFpc0RvY05hbWUobmV4dCkpIG5leHQgKz0gZXh0bmFtZShpdGVtLmFicykgfHwgXCIubWRcIjtcbiAgICBjb25zdCB0byA9IGpvaW4oZGlybmFtZShpdGVtLmFicyksIG5leHQpO1xuICAgIGlmICh0byA9PT0gaXRlbS5hYnMpIHJldHVybiB7IHBhdGg6IHRvLCBmcm9tOiBpdGVtLmFicyB9O1xuICAgIC8vIEEgY2FzZS1vbmx5IHJlbmFtZSBvbiBhIGNhc2UtaW5zZW5zaXRpdmUgZGlzayBmaW5kcyBcIml0c2VsZlwiIGV4aXN0aW5nLlxuICAgIGlmICh0by50b0xvd2VyQ2FzZSgpICE9PSBpdGVtLmFicy50b0xvd2VyQ2FzZSgpKSB0aGlzLnJlZnVzZUV4aXN0aW5nKHRvKTtcbiAgICB0aGlzLnJlbmFtZU9yRGllKGl0ZW0uYWJzLCB0byk7XG4gICAgdGhpcy5mb2xsb3dNb3ZlKGl0ZW0uYWJzLCB0byk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogdG8sIGZyb206IGl0ZW0uYWJzIH07XG4gIH1cblxuICBwcml2YXRlIHJlbmFtZU9yRGllKGZyb206IHN0cmluZywgdG86IHN0cmluZyk6IHZvaWQge1xuICAgIHRyeSB7XG4gICAgICByZW5hbWVTeW5jKGZyb20sIHRvKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zdCBjb2RlID0gKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlO1xuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgY29kZSA9PT0gXCJFWERFVlwiXG4gICAgICAgICAgPyBgY2Fubm90IG1vdmUgJHtmcm9tfSB0byBhbm90aGVyIGRpc2sgKCR7dG99KSDigJQgY29weSBpdCBpbnN0ZWFkYFxuICAgICAgICAgIDogYGNhbm5vdCBtb3ZlICR7ZnJvbX0gdG8gJHt0b306ICR7Y29kZSA/PyBTdHJpbmcoZSl9YCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvKiogV2hldGhlciBgYWJzYCBpcyBzaG93biBhbnl3aGVyZSBpbiB0aGUgY29udGV4dCBub3cuICovXG4gIHByaXZhdGUgaXRlbUF0KGFiczogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgdHJ5IHtcbiAgICAgIHRoaXMuaXRlbU9yRGllKGFicyk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cblxuICAvKiogXCJSZW1vdmUgZnJvbSBTY3JpcHRvcml1bVwiIOKAlCBuZXZlciBmcm9tIGRpc2sgKEUyNCkuICovXG4gIGhpZGUocmF3UGF0aDogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IGVudHJ5OiBzdHJpbmc7IHJlbW92ZWRFbnRyeTogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBpdGVtID0gdGhpcy5pdGVtT3JEaWUocmF3UGF0aCk7XG4gICAgaWYgKGl0ZW0ud2hvbGUpIHtcbiAgICAgIHRoaXMucmVtb3ZlQ29udGV4dChpdGVtLmVudHJ5LmlkKTtcbiAgICAgIHJldHVybiB7IHBhdGg6IGl0ZW0uYWJzLCBlbnRyeTogaXRlbS5lbnRyeS5pZCwgcmVtb3ZlZEVudHJ5OiB0cnVlIH07XG4gICAgfVxuICAgIGNvbnN0IHJlbCA9IHRvUG9zaXgocmVsYXRpdmUoaXRlbS5lbnRyeS5yb290LCBpdGVtLmFicykpO1xuICAgIGl0ZW0uZW50cnkuaGlkZGVuID0gWy4uLihpdGVtLmVudHJ5LmhpZGRlbiA/PyBbXSkuZmlsdGVyKChoKSA9PiBoICE9PSByZWwpLCByZWxdO1xuICAgIHRoaXMucmVzY2FuKGl0ZW0uZW50cnkuaWQpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5jbG9zZU9ycGhhbmVkT3BlbkRvYygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IGl0ZW0uYWJzLCBlbnRyeTogaXRlbS5lbnRyeS5pZCwgcmVtb3ZlZEVudHJ5OiBmYWxzZSB9O1xuICB9XG5cbiAgdW5oaWRlKGVudHJ5SWQ6IHN0cmluZyk6IHsgZW50cnk6IHN0cmluZzsgcmVzdG9yZWQ6IG51bWJlciB9IHtcbiAgICBjb25zdCBlID0gdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5pZCA9PT0gZW50cnlJZCk7XG4gICAgaWYgKCFlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vIGNvbnRleHQgZW50cnkgJHtlbnRyeUlkfWAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgdGhpcy5tLmNvbnRleHQubWFwKCh4KSA9PiB4LmlkKSxcbiAgICAgICk7XG4gICAgY29uc3QgcmVzdG9yZWQgPSBlLmhpZGRlbj8ubGVuZ3RoID8/IDA7XG4gICAgZGVsZXRlIGUuaGlkZGVuO1xuICAgIHRoaXMucmVzY2FuKGUuaWQpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgZW50cnk6IGUuaWQsIHJlc3RvcmVkIH07XG4gIH1cblxuICAvKipcbiAgICogRTIyOiBhIHNpbmdsZSBkb2N1bWVudCBiZWNvbWVzIGEgc2V0IOKAlCBhIGZvbGRlciBuYW1lZCBmb3IgaXQgYmVzaWRlIGl0LCB0aGVcbiAgICogZG9jdW1lbnQgbW92ZWQgaW4sIGFuZCB0aGUgZW50cnkgKHNhbWUgaWQpIG5vdyBtaXJyb3JzIHRoYXQgZm9sZGVyLlxuICAgKi9cbiAgbWFrZVNldChyYXdQYXRoOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZm9sZGVyOiBzdHJpbmc7IGVudHJ5OiBzdHJpbmcgfSB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGlmIChpdGVtLmVudHJ5Lm1lbWJlcnNoaXAgIT09IFwibGlzdGVkXCIgfHwgaXRlbS5kaXIpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHt0aGlzLmRpc3BsYXkoaXRlbS5hYnMpfSBpcyBhbHJlYWR5IGluIGEgc2V0IOKAlCBtYWtlIGEgZm9sZGVyIHRoZXJlIGluc3RlYWRgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoaXRlbS5hYnMpO1xuICAgIGNvbnN0IHN0ZW0gPSBiYXNlbmFtZShpdGVtLmFicywgZXh0bmFtZShpdGVtLmFicykpIHx8IFwiVW50aXRsZWRcIjtcbiAgICBjb25zdCBmb2xkZXIgPSBqb2luKHBhcmVudCwgdGhpcy5mcmVlTmFtZShwYXJlbnQsIHN0ZW0sIHRydWUpKTtcbiAgICBta2RpclN5bmMoZm9sZGVyKTtcbiAgICBjb25zdCB0byA9IGpvaW4oZm9sZGVyLCBiYXNlbmFtZShpdGVtLmFicykpO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICBjb25zdCBlID0gaXRlbS5lbnRyeTtcbiAgICBlLm1lbWJlcnNoaXAgPSBcIm1pcnJvcmVkXCI7XG4gICAgZS5yb290ID0gZm9sZGVyO1xuICAgIGUubGFiZWwgPSBiYXNlbmFtZShmb2xkZXIpO1xuICAgIGUubm9kZXMgPSBbXTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiB0bywgZm9sZGVyLCBlbnRyeTogZS5pZCB9O1xuICB9XG5cbiAgLyoqIFRoZSBtb3N0IHRleHQgb25lIGltcG9ydCBjYXJyaWVzIOKAlCBhIGRvY3VtZW50LCBub3QgYSBkYXRhIGR1bXAuICovXG4gIHN0YXRpYyByZWFkb25seSBJTVBPUlRfTUFYX0JZVEVTID0gOCAqIDEwMjQgKiAxMDI0O1xuXG4gIC8qKlxuICAgKiBFMjMncyBkcm9wOiBhIENPUFkgb2YgYSBmaWxlJ3MgdGV4dCwgd3JpdHRlbiB1bmRlciBhIGZyZWUgbmFtZSBpbnRvIGBpbnRvYFxuICAgKiAoZGVmYXVsdDogdGhlIHdvcmtzcGFjZSksIHRoZW4gc2hvd24gbGlrZSBhbnkgb3RoZXIgZG9jdW1lbnQuXG4gICAqL1xuICBpbXBvcnRUZXh0KG5hbWU6IHN0cmluZywgdGV4dDogc3RyaW5nLCByYXdJbnRvPzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZmlsZSA9IHRoaXMubmFtZU9yRGllKG5hbWUpO1xuICAgIGlmICghaXNEb2NOYW1lKGZpbGUpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vdCBhIGRvY3VtZW50IFNjcmlwdG9yaXVtIG9wZW5zICgke0RPQ19FWFRFTlNJT05TLmpvaW4oXCIgXCIpfSk6ICR7ZmlsZX1gLFxuICAgICAgICA0MDAsXG4gICAgICAgIFsuLi5ET0NfRVhURU5TSU9OU10sXG4gICAgICApO1xuICAgIGlmIChCdWZmZXIuYnl0ZUxlbmd0aCh0ZXh0KSA+IFNlc3Npb24uSU1QT1JUX01BWF9CWVRFUylcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2ZpbGV9IGlzIGxhcmdlciB0aGFuICR7U2Vzc2lvbi5JTVBPUlRfTUFYX0JZVEVTIC8gMTAyNCAvIDEwMjR9IE1CIOKAlCBub3QgaW1wb3J0ZWRgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIGNvbnN0IGRpciA9IHRoaXMuZGVzdGluYXRpb25PckRpZShyYXdJbnRvID8/IHRoaXMud29ya3NwYWNlKTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgdGhpcy5mcmVlTmFtZShkaXIsIGZpbGUsIGZhbHNlKSk7XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIHRleHQsIHsgZmxhZzogXCJ3eFwiIH0pO1xuICAgIHRoaXMuYWRvcHROZXcoYWJzKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBjaGF0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIGFkZE1lc3NhZ2UoXG4gICAgd2hvOiBDaGF0V2hvLFxuICAgIHRleHQ6IHN0cmluZyxcbiAgICBleHRyYTogeyBzZWxlY3Rpb24/OiBTZWxlY3Rpb24gfCBudWxsOyBhY3RpdmVQYXRoPzogc3RyaW5nIHwgbnVsbCB9ID0ge30sXG4gICk6IENoYXRNZXNzYWdlIHtcbiAgICBjb25zdCBtc2c6IENoYXRNZXNzYWdlID0geyBpZDogYG0tJHtyYW5kSGV4KDQpfWAsIHdobywgdGV4dCwgdHM6IERhdGUubm93KCksIC4uLmV4dHJhIH07XG4gICAgdGhpcy5tLmNoYXQucHVzaChtc2cpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiBtc2c7XG4gIH1cblxuICAvLyDilIDilIAgdmlld3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqIEEgZG9jdW1lbnQncyBmcm9udG1hdHRlciwgZnJvbSB0aGUgQUNUSVZFIHZlcnNpb24ncyB0ZXh0IOKAlCB3aGF0IHRoZSBodW1hblxuICAgKiAgaXMgcmVhZGluZywgd2hpY2ggaXMgbm90IGFsd2F5cyB3aGF0IGlzIG9uIGRpc2sgKEUzMikuICovXG4gIHByaXZhdGUgbWV0YU9mKGQ6IERvY1JlY29yZCk6IERvY1ZpZXdbXCJtZXRhXCJdIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHJlYWRNZXRhKHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgfVxuXG4gIGRvY1ZpZXcoZDogRG9jUmVjb3JkKTogRG9jVmlldyB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG1ldGE6IHRoaXMubWV0YU9mKGQpLFxuICAgICAgc2x1ZzogZC5zbHVnLFxuICAgICAgbmFtZTogZC5uYW1lLFxuICAgICAgb3JpZ2luYWw6IGQub3JpZ2luYWwsXG4gICAgICBlbnRyeUlkOiBkLmVudHJ5SWQsXG4gICAgICByZWw6IGQucmVsLFxuICAgICAgdmVyc2lvbnM6IGQudmVyc2lvbnMubWFwKCh2KSA9PiAoeyAuLi52LCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIHYubikgfSkpLFxuICAgICAgYWN0aXZlOiBkLmFjdGl2ZSxcbiAgICAgIGRpcnR5OiB0aGlzLmlzRGlydHkoZCksXG4gICAgICBvdXRzaWRlQ2hhbmdlZDogZC5vdXRzaWRlQ2hhbmdlZCxcbiAgICB9O1xuICB9XG5cbiAgZG9jKHNsdWc6IHN0cmluZyk6IERvY1ZpZXcge1xuICAgIHJldHVybiB0aGlzLmRvY1ZpZXcodGhpcy5kb2NPckRpZShzbHVnKSk7XG4gIH1cblxuICAvKipcbiAgICogRnJvbnRtYXR0ZXIgZm9yIGV2ZXJ5IGRvY3VtZW50IGluIHRoZSBjb250ZXh0LCBieSBwYXRoIChFMzIpLlxuICAgKlxuICAgKiBDYWNoZWQgYnkgcGF0aCBhbmQgbXRpbWUsIGFuZCByZWFkIEhFQUQtRklSU1Q6IGEgZnJvbnRtYXR0ZXIgYmxvY2sgc2l0cyBhdFxuICAgKiB0aGUgdG9wIG9mIGEgZmlsZSwgc28gYSAzMDAgS0IgZG9jdW1lbnQgY29zdHMgOCBLQiBvZiByZWFkLiBUaGUgY2FwIGtlZXBzIGFcbiAgICogMiwwMDAtbm9kZSBtaXJyb3IgZnJvbSBtZWFuaW5nIDIsMDAwIHJlYWRzIHBlciBzbmFwc2hvdCwgYW5kIGhpdHRpbmcgaXQgaXNcbiAgICogU0FJRCBvbiB0aGUgd2lyZSByYXRoZXIgdGhhbiBsZWZ0IHRvIGxvb2sgbGlrZSBkb2N1bWVudHMgd2l0aG91dCBhbnkuXG4gICAqL1xuICBwcml2YXRlIG1ldGFDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCB7IG10aW1lTXM6IG51bWJlcjsgc3VtbWFyeTogRG9jU3VtbWFyeSB8IG51bGwgfT4oKTtcblxuICBjb250ZXh0TWV0YShjYXAgPSBNRVRBX1NDQU5fQ0FQKTogeyBtYXA6IFJlY29yZDxzdHJpbmcsIERvY1N1bW1hcnk+OyB0cnVuY2F0ZWQ6IGJvb2xlYW4gfSB7XG4gICAgY29uc3QgbWFwOiBSZWNvcmQ8c3RyaW5nLCBEb2NTdW1tYXJ5PiA9IHt9O1xuICAgIGxldCBzZWVuID0gMDtcbiAgICBsZXQgdHJ1bmNhdGVkID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBmb3IgKGNvbnN0IGFicyBvZiBkb2NQYXRocyhlKSkge1xuICAgICAgICBpZiAoc2VlbiA+PSBjYXApIHtcbiAgICAgICAgICB0cnVuY2F0ZWQgPSB0cnVlO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICAgIHNlZW4rKztcbiAgICAgICAgbGV0IG10aW1lTXM6IG51bWJlcjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBtdGltZU1zID0gc3RhdFN5bmMoYWJzKS5tdGltZU1zO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBoaXQgPSB0aGlzLm1ldGFDYWNoZS5nZXQoYWJzKTtcbiAgICAgICAgbGV0IHN1bW1hcnk6IERvY1N1bW1hcnkgfCBudWxsO1xuICAgICAgICBpZiAoaGl0ICYmIGhpdC5tdGltZU1zID09PSBtdGltZU1zKSBzdW1tYXJ5ID0gaGl0LnN1bW1hcnk7XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIHN1bW1hcnkgPSBzdW1tYXJpemUocmVhZE1ldGEocmVhZEhlYWQoYWJzKSkpO1xuICAgICAgICAgIHRoaXMubWV0YUNhY2hlLnNldChhYnMsIHsgbXRpbWVNcywgc3VtbWFyeSB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc3VtbWFyeSkgbWFwW2Fic10gPSBzdW1tYXJ5O1xuICAgICAgfVxuICAgICAgaWYgKHRydW5jYXRlZCkgYnJlYWs7XG4gICAgfVxuICAgIHJldHVybiB7IG1hcCwgdHJ1bmNhdGVkIH07XG4gIH1cblxuICAvKipcbiAgICogT25lIGRvY3VtZW50J3MgZnJvbnRtYXR0ZXIgYXMgcmVhZCwgb3IgZXZlcnkgY29udGV4dCBkb2N1bWVudCdzIChFMzIpLiBUaGVcbiAgICogYWdlbnQgZ2V0cyB0aGUgZGFlbW9uJ3MgcGFyc2UgcmF0aGVyIHRoYW4gcmUtcmVhZGluZyB0aGUgWUFNTCBpdHNlbGYuXG4gICAqL1xuICBtZXRhRm9yKHJhd1BhdGg/OiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgaWYgKHJhd1BhdGggIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgYWJzID0gdGhpcy5zaG93blBhdGgocmF3UGF0aCk7XG4gICAgICBjb25zdCBtZXRhID0gcmVhZE1ldGEocmVhZEhlYWQoYWJzKSk7XG4gICAgICByZXR1cm4geyBwYXRoOiBhYnMsIG1ldGEsIC4uLihtZXRhID8ge30gOiB7IG5vdGU6IFwibm8gZnJvbnRtYXR0ZXIgYmxvY2tcIiB9KSB9O1xuICAgIH1cbiAgICBjb25zdCBvdXQ6IHsgcGF0aDogc3RyaW5nOyBtZXRhOiBEb2NNZXRhIHwgbnVsbCB9W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpXG4gICAgICBmb3IgKGNvbnN0IGFicyBvZiBkb2NQYXRocyhlKSkgb3V0LnB1c2goeyBwYXRoOiBhYnMsIG1ldGE6IHJlYWRNZXRhKHJlYWRIZWFkKGFicykpIH0pO1xuICAgIHJldHVybiB7IGRvY3VtZW50czogb3V0LCBjb3VudDogb3V0Lmxlbmd0aCB9O1xuICB9XG5cbiAgLyoqXG4gICAqIHBkb2NzJ3MgYGZpbmRgLCBvdmVyIHRoaXMgc2Vzc2lvbidzIGNvbnRleHQuIFNhbWUgZmlsdGVyIG5hbWVzLCBzYW1lXG4gICAqIEFORGluZywgYW5kIHRoZSBzYW1lIHJ1bGUgdGhhdCBhbiBlbXB0eSByZXN1bHQgaXMgYW4gQU5TV0VSOiBgY291bnRgIHNheXNcbiAgICogaG93IG1hbnkgbWF0Y2hlZCwgYW5kIHRoZSBjYWxsZXIgcmVhZHMgdGhhdCByYXRoZXIgdGhhbiB0aGUgZXhpdCBjb2RlLlxuICAgKi9cbiAgZmluZChmaWx0ZXI6IE1ldGFGaWx0ZXIpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3QgbWF0Y2hlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj5bXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dClcbiAgICAgIGZvciAoY29uc3QgYWJzIG9mIGRvY1BhdGhzKGUpKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSByZWFkTWV0YShyZWFkSGVhZChhYnMpKTtcbiAgICAgICAgaWYgKCFtYXRjaGVzRmlsdGVyKG1ldGEsIGZpbHRlcikpIGNvbnRpbnVlO1xuICAgICAgICBtYXRjaGVzLnB1c2goe1xuICAgICAgICAgIHBhdGg6IGFicyxcbiAgICAgICAgICBlbnRyeTogZS5pZCxcbiAgICAgICAgICAuLi4obWV0YT8udHlwZSA/IHsgdHlwZTogbWV0YS50eXBlIH0gOiB7fSksXG4gICAgICAgICAgLi4uKG1ldGE/LnRpdGxlID8geyB0aXRsZTogbWV0YS50aXRsZSB9IDoge30pLFxuICAgICAgICAgIC4uLihtZXRhPy5kZXNjcmlwdGlvbiA/IHsgZGVzY3JpcHRpb246IG1ldGEuZGVzY3JpcHRpb24gfSA6IHt9KSxcbiAgICAgICAgICBzdGF0dXM6IG1ldGE/LnN0YXR1cyA/PyBudWxsLFxuICAgICAgICAgIC4uLihtZXRhPy5saWZlY3ljbGUgPyB7IGxpZmVjeWNsZTogbWV0YS5saWZlY3ljbGUgfSA6IHt9KSxcbiAgICAgICAgICB0YWdzOiBtZXRhPy50YWdzID8/IFtdLFxuICAgICAgICAgIGRhdGU6IG1ldGE/LmRhdGUgPz8gbnVsbCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgcmV0dXJuIHsgbWF0Y2hlcywgY291bnQ6IG1hdGNoZXMubGVuZ3RoIH07XG4gIH1cblxuICAvKipcbiAgICogT25lIHNldCdzIG1hcCAoRTMzKTogaXRzIGRvY3VtZW50cyBhcyBub2RlcywgYW5kIHRoZSBmb3VyIHNvdXJjZXMgb2YgZWRnZXNcbiAgICog4oCUIGJvZHkgbGlua3MsIHdpa2kgbGlua3MsIHR5cGVkIGxpbmtzIGFuZCBmcm9udG1hdHRlciByZWZlcmVuY2VzLlxuICAgKi9cbiAgZ3JhcGhGb3IoZW50cnlJZD86IHN0cmluZyk6IEdyYXBoUGF5bG9hZCB7XG4gICAgY29uc3QgZSA9IGVudHJ5SWRcbiAgICAgID8gdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5pZCA9PT0gZW50cnlJZClcbiAgICAgIDogdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIpO1xuICAgIGlmICghZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGVudHJ5SWQgPyBgbm8gY29udGV4dCBlbnRyeSAke2VudHJ5SWR9YCA6IFwidGhpcyBzZXNzaW9uIGhhcyBubyBzZXQgdG8gbWFwXCIsXG4gICAgICAgIDQwNCxcbiAgICAgICAgdGhpcy5tLmNvbnRleHQubWFwKCh4KSA9PiB4LmlkKSxcbiAgICAgICk7XG4gICAgY29uc3QgcGF0aHMgPSBkb2NQYXRocyhlKTtcbiAgICBjb25zdCBpbmRleDogQnVuZGxlSW5kZXggPSB7XG4gICAgICByb290OiBlLnJvb3QsXG4gICAgICBwYXRocyxcbiAgICAgIG1ldGFPZjogKHApID0+IHJlYWRNZXRhKHJlYWRIZWFkKHApKSxcbiAgICAgIGV4aXN0czogKHApID0+IGV4aXN0c1N5bmMocCksXG4gICAgICByZXBvUm9vdDogZ2l0Um9vdE9mKGUucm9vdCksXG4gICAgfTtcbiAgICBjb25zdCBnID0gYnVpbGRHcmFwaChpbmRleCwgKHApID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBzcGxpdEZyb250bWF0dGVyKHJlYWRGaWxlU3luYyhwLCBcInV0ZjhcIikpLmJvZHk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIFwiXCI7XG4gICAgICB9XG4gICAgfSk7XG4gICAgcmV0dXJuIHsgZW50cnk6IGUuaWQsIC4uLmcgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXaGF0IGNpdGVzIGEgZG9jdW1lbnQuIGByZWxhdGVkYCAoZnJvbnRtYXR0ZXIpIGFuZCBgbGlua3NgIChib2R5KSBhcmUga2VwdFxuICAgKiBBUEFSVCwgd2hpY2ggaXMgaG93IHBkb2NzIHJlcG9ydHMgaXQgYW5kIHRoZSBkaXN0aW5jdGlvbiBpcyByZWFsOiBvbmUgaXMgYVxuICAgKiBjbGFpbSBhYm91dCB0aGUgZG9jdW1lbnQsIHRoZSBvdGhlciBhIGNpdGF0aW9uIGluIHByb3NlLlxuICAgKi9cbiAgYmFja2xpbmtzKHJhd1BhdGg6IHN0cmluZyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBhYnMgPSB0aGlzLnNob3duUGF0aChyYXdQYXRoKTtcbiAgICBjb25zdCBlbnRyeSA9IHRoaXMubS5jb250ZXh0LmZpbmQoXG4gICAgICAoZSkgPT4gZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgJiYgKGFicyA9PT0gZS5yb290IHx8IGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpLFxuICAgICk7XG4gICAgaWYgKCFlbnRyeSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHthYnN9IGlzIG5vdCBpbnNpZGUgYSBzZXQsIHNvIG5vdGhpbmcgbWFwcyBpdGAsIDQwMCk7XG4gICAgY29uc3QgZyA9IHRoaXMuZ3JhcGhGb3IoZW50cnkuaWQpO1xuICAgIGNvbnN0IGluYm91bmQgPSBnLmVkZ2VzLmZpbHRlcigoeCkgPT4geC50byA9PT0gYWJzKTtcbiAgICBjb25zdCB0aXRsZSA9IChwOiBzdHJpbmcpID0+IGcubm9kZXMuZmluZCgobikgPT4gbi5wYXRoID09PSBwKT8udGl0bGUgPz8gYmFzZW5hbWUocCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHRhcmdldDogeyBwYXRoOiBhYnMsIHRpdGxlOiB0aXRsZShhYnMpIH0sXG4gICAgICByZWxhdGVkOiBpbmJvdW5kXG4gICAgICAgIC5maWx0ZXIoKHgpID0+IHguc291cmNlID09PSBcImZyb250bWF0dGVyXCIpXG4gICAgICAgIC5tYXAoKHgpID0+ICh7IHBhdGg6IHguZnJvbSwgdGl0bGU6IHRpdGxlKHguZnJvbSksIGtleTogeC5rZXkgfSkpLFxuICAgICAgbGlua3M6IGluYm91bmRcbiAgICAgICAgLmZpbHRlcigoeCkgPT4geC5zb3VyY2UgPT09IFwibGlua1wiKVxuICAgICAgICAubWFwKCh4KSA9PiAoeyBwYXRoOiB4LmZyb20sIHRpdGxlOiB0aXRsZSh4LmZyb20pLCByZWw6IHgucmVsIH0pKSxcbiAgICAgIGNvdW50OiBpbmJvdW5kLmxlbmd0aCxcbiAgICB9O1xuICB9XG5cbiAgLyoqIFdoZXJlIGRvZXMgdGhpcyBsaW5rIGdvPyBUaGUgc3VyZmFjZSBhc2tzIGJlZm9yZSBmb2xsb3dpbmcgb25lIChFMzMpLiAqL1xuICByZXNvbHZlTGluayhmcm9tOiBzdHJpbmcsIHRhcmdldDogc3RyaW5nKTogUmVzb2x1dGlvbiB7XG4gICAgY29uc3Qgc3JjID0gdGhpcy5zaG93blBhdGgoZnJvbSk7XG4gICAgY29uc3QgZW50cnkgPSB0aGlzLm0uY29udGV4dC5maW5kKFxuICAgICAgKGUpID0+IGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiICYmIHNyYy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCksXG4gICAgKTtcbiAgICBjb25zdCByb290ID0gZW50cnk/LnJvb3QgPz8gZGlybmFtZShzcmMpO1xuICAgIGNvbnN0IHBhdGhzID0gZW50cnkgPyBkb2NQYXRocyhlbnRyeSkgOiBbc3JjXTtcbiAgICByZXR1cm4gcmVzb2x2ZVRhcmdldCh0YXJnZXQsIHNyYywge1xuICAgICAgcm9vdCxcbiAgICAgIHBhdGhzLFxuICAgICAgbWV0YU9mOiAocCkgPT4gcmVhZE1ldGEocmVhZEhlYWQocCkpLFxuICAgICAgZXhpc3RzOiAocCkgPT4gZXhpc3RzU3luYyhwKSxcbiAgICAgIHJlcG9Sb290OiBnaXRSb290T2Yocm9vdCksXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogV2hhdCBhIGZyb250bWF0dGVyIGJsb2NrIGZvciB0aGlzIGRvY3VtZW50IFdPVUxEIHNheSAoRTM1KS4gU3VnZ2VzdGVkLCBub3RcbiAgICogd3JpdHRlbjogdGhlIHR5cGUgY29tZXMgZnJvbSB0aGUgZG9jdW1lbnRzIGJlc2lkZSBpdCwgdGhlIHRpdGxlIGZyb20gaXRzXG4gICAqIG93biBIMSwgYW5kIGBkZXNjcmlwdGlvbmAgaXMgbGVmdCBibGFuayBmb3Igd2hvZXZlciBmaWxscyBpdCBpbi5cbiAgICovXG4gIHN1Z2dlc3RNZXRhKHJhd1BhdGg6IHN0cmluZywgYnk/OiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgYmxvY2s6IHN0cmluZzsgdHlwZT86IHN0cmluZyB9IHtcbiAgICBjb25zdCBhYnMgPSB0aGlzLnNob3duUGF0aChyYXdQYXRoKTtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgIGlmIChzcGxpdEZyb250bWF0dGVyKHRleHQpLnJhdyAhPT0gbnVsbClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YmFzZW5hbWUoYWJzKX0gYWxyZWFkeSBoYXMgZnJvbnRtYXR0ZXJgLCA0MDkpO1xuICAgIGNvbnN0IGZvbGRlciA9IGRpcm5hbWUoYWJzKTtcbiAgICBjb25zdCBzaWJsaW5nczogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpXG4gICAgICBmb3IgKGNvbnN0IHAgb2YgZG9jUGF0aHMoZSkpXG4gICAgICAgIGlmIChwICE9PSBhYnMgJiYgZGlybmFtZShwKSA9PT0gZm9sZGVyKSB7XG4gICAgICAgICAgY29uc3QgdCA9IHJlYWRNZXRhKHJlYWRIZWFkKHApKT8udHlwZTtcbiAgICAgICAgICBpZiAodCkgc2libGluZ3MucHVzaCh0KTtcbiAgICAgICAgfVxuICAgIGNvbnN0IHR5cGUgPSBndWVzc1R5cGUoc2libGluZ3MsIGJhc2VuYW1lKGZvbGRlcikpO1xuICAgIHJldHVybiB7XG4gICAgICBwYXRoOiBhYnMsXG4gICAgICB0eXBlLFxuICAgICAgYmxvY2s6IGJ1aWxkQmxvY2soe1xuICAgICAgICAuLi4odHlwZSA/IHsgdHlwZSB9IDoge30pLFxuICAgICAgICAuLi4odGl0bGVGcm9tQm9keSh0ZXh0KSA/IHsgdGl0bGU6IHRpdGxlRnJvbUJvZHkodGV4dCkgYXMgc3RyaW5nIH0gOiB7fSksXG4gICAgICAgIC4uLihieSA/IHsgYnkgfSA6IHt9KSxcbiAgICAgIH0pLFxuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogV3JpdGUgYSBuZXcgYmxvY2sgaW50byBhIGRvY3VtZW50IHRoYXQgaGFzIG5vbmUgKEUzNSkuXG4gICAqXG4gICAqIOKblCBUSElTIFdSSVRFUyBUSEUgT1JJR0lOQUwsIHdoaWNoIEU3IG90aGVyd2lzZSByZXNlcnZlcyBmb3IgU2F2ZSDigJQgYW5kXG4gICAqIHRoYXQgaXMgdGhlIHJ1bGluZywgbm90IGFuIG92ZXJzaWdodDogdGhlIGFnZW50J3MgdmVyYiB3cml0ZXMgdGhlIGZpbGUsIGFuZFxuICAgKiBpZiB0aGUgaHVtYW4gaGFzIHVuc2F2ZWQgZWRpdHMgdG8gaXQgdGhlIENPTkZMSUNUIEJBUiBhcHBlYXJzIGFuZCB0aGV5XG4gICAqIGNob29zZSAoQ29sZTogXCJ3ZSBjYW4gYWRqdXN0IGlmIG5lZWRlZCBhZnRlciBnZXR0aW5nIGFjdHVhbCB1c2FnZSBiZWhpbmRcbiAgICogdXNcIikuIFJlZnVzaW5nIHdoaWxlIGEgYnVmZmVyIGlzIGRpcnR5IHdvdWxkIGxldCBhbiBvcGVuIGRvY3VtZW50IGJsb2NrIHRoZVxuICAgKiBhZ2VudCBpbmRlZmluaXRlbHkuIFRoZSBIVU1BTidzIG93biBwYXRoIG5ldmVyIGNvbWVzIGhlcmU6IHRoZWlyIFwiYWRkXG4gICAqIGZyb250bWF0dGVyXCIgaXMgYW4gZWRpdCB0byB0aGVpciBidWZmZXIsIHdoaWNoIFNhdmUgd3JpdGVzIGxpa2UgYW55IG90aGVyLlxuICAgKi9cbiAgbWV0YUluaXQocmF3UGF0aDogc3RyaW5nLCBvcHRzOiB7IHR5cGU/OiBzdHJpbmc7IGJ5Pzogc3RyaW5nIH0gPSB7fSk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBzdWdnZXN0ZWQgPSB0aGlzLnN1Z2dlc3RNZXRhKHJhd1BhdGgsIG9wdHMuYnkpO1xuICAgIGNvbnN0IGFicyA9IHN1Z2dlc3RlZC5wYXRoO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgY29uc3QgYmxvY2sgPSBvcHRzLnR5cGVcbiAgICAgID8gYnVpbGRCbG9jayh7XG4gICAgICAgICAgdHlwZTogb3B0cy50eXBlLFxuICAgICAgICAgIC4uLih0aXRsZUZyb21Cb2R5KHRleHQpID8geyB0aXRsZTogdGl0bGVGcm9tQm9keSh0ZXh0KSBhcyBzdHJpbmcgfSA6IHt9KSxcbiAgICAgICAgICAuLi4ob3B0cy5ieSA/IHsgYnk6IG9wdHMuYnkgfSA6IHt9KSxcbiAgICAgICAgfSlcbiAgICAgIDogc3VnZ2VzdGVkLmJsb2NrO1xuICAgIHdyaXRlRmlsZVN5bmMoYWJzLCB3aXRoQmxvY2sodGV4dCwgYmxvY2spKTtcbiAgICB0aGlzLm1ldGFDYWNoZS5kZWxldGUoYWJzKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMsIHR5cGU6IG9wdHMudHlwZSA/PyBzdWdnZXN0ZWQudHlwZSA/PyBudWxsLCBhZGRlZDogdHJ1ZSB9O1xuICB9XG5cbiAgLyoqIFNldCBrZXlzIGluIGFuIGV4aXN0aW5nIGJsb2NrIOKAlCBhIExJTkUgZWRpdCBlYWNoLCBzbyBub3RoaW5nIGVsc2UgbW92ZXMuICovXG4gIG1ldGFTZXQocmF3UGF0aDogc3RyaW5nLCBwYWlyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBhYnMgPSB0aGlzLnNob3duUGF0aChyYXdQYXRoKTtcbiAgICBsZXQgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICBpZiAoc3BsaXRGcm9udG1hdHRlcih0ZXh0KS5yYXcgPT09IG51bGwpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Jhc2VuYW1lKGFicyl9IGhhcyBubyBmcm9udG1hdHRlciDigJQgYWRkIGl0IGZpcnN0IChtZXRhLWluaXQpYCwgNDA5KTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhwYWlycykpIHtcbiAgICAgIGlmICghL15bQS1aYS16X11bQS1aYS16MC05Xy4tXSokLy50ZXN0KGtleSkpXG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYFwiJHtrZXl9XCIgaXMgbm90IGEgZnJvbnRtYXR0ZXIga2V5YCwgNDAwKTtcbiAgICAgIHRleHQgPSBzZXRLZXkodGV4dCwga2V5LCB2YWx1ZSk7XG4gICAgfVxuICAgIHdyaXRlRmlsZVN5bmMoYWJzLCB0ZXh0KTtcbiAgICB0aGlzLm1ldGFDYWNoZS5kZWxldGUoYWJzKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMsIHNldDogT2JqZWN0LmtleXMocGFpcnMpIH07XG4gIH1cblxuICAvKiogVGhlIHNlc3Npb24ncyBoYWxmIG9mIGBQdWJsaWNTdGF0ZWA7IHRoZSBkYWVtb24gYWRkcyB0aGUgaG9tZS1sZXZlbCBgcHJlZnNgIGFuZCBgdXNlckhvbWVgLiAqL1xuICB2aWV3KFxuICAgIG1vZGU6IFwiZGV2XCIgfCBcInJlbGVhc2VcIixcbiAgICBzZWxlY3Rpb246IFNlbGVjdGlvbiB8IG51bGwsXG4gICk6IE9taXQ8UHVibGljU3RhdGUsIFwicHJlZnNcIiB8IFwidXNlckhvbWVcIj4ge1xuICAgIGNvbnN0IG1ldGEgPSB0aGlzLmNvbnRleHRNZXRhKCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNlc3Npb25JZDogdGhpcy5tLnNlc3Npb25JZCxcbiAgICAgIGhvbWU6IHRoaXMuaG9tZSxcbiAgICAgIHdvcmtzcGFjZTogdGhpcy53b3Jrc3BhY2UsXG4gICAgICBkb2NNZXRhOiBtZXRhLm1hcCxcbiAgICAgIC4uLihtZXRhLnRydW5jYXRlZCA/IHsgZG9jTWV0YVRydW5jYXRlZDogdHJ1ZSB9IDoge30pLFxuICAgICAgbW9kZSxcbiAgICAgIGNvbnRleHQ6IHRoaXMubS5jb250ZXh0LFxuICAgICAgZG9jczogdGhpcy5tLmRvY3MubWFwKChkKSA9PiB0aGlzLmRvY1ZpZXcoZCkpLFxuICAgICAgb3BlbkRvYzogdGhpcy5tLm9wZW5Eb2MsXG4gICAgICBzZWxlY3Rpb24sXG4gICAgICBjaGF0OiB0aGlzLm0uY2hhdCxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogVGhlIGdpdCB3b3JraW5nIHRyZWUgYGRpcmAgaXMgaW4sIG9yIG51bGwuIEEgYC5naXRgIEVOVFJZLCBub3QgYSBkaXJlY3RvcnlcbiAqIHRlc3Q6IGEgd29ya3RyZWUgYW5kIGEgc3VibW9kdWxlIGJvdGggaGF2ZSBgLmdpdGAgYXMgYSBGSUxFLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2l0Um9vdE9mKGRpcjogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGxldCBhdCA9IGRpcjtcbiAgZm9yICg7Oykge1xuICAgIGlmIChleGlzdHNTeW5jKGpvaW4oYXQsIFwiLmdpdFwiKSkpIHJldHVybiBhdDtcbiAgICBjb25zdCB1cCA9IGRpcm5hbWUoYXQpO1xuICAgIGlmICh1cCA9PT0gYXQpIHJldHVybiBudWxsO1xuICAgIGF0ID0gdXA7XG4gIH1cbn1cblxuLyoqIERvY3VtZW50cyB1bmRlciBhIGZvbGRlciwgZm9yIHNheWluZyBob3cgbXVjaCBhIG1vdmUgbW92ZXMuICovXG5mdW5jdGlvbiBjb3VudERvY3MoZGlyOiBzdHJpbmcpOiBudW1iZXIge1xuICBsZXQgbiA9IDA7XG4gIGNvbnN0IHdhbGsgPSAoYXQ6IHN0cmluZykgPT4ge1xuICAgIGxldCBuYW1lczogc3RyaW5nW107XG4gICAgdHJ5IHtcbiAgICAgIG5hbWVzID0gcmVhZGRpclN5bmMoYXQpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMpIHtcbiAgICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGFicyA9IGpvaW4oYXQsIG5hbWUpO1xuICAgICAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gICAgICB0cnkge1xuICAgICAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkgd2FsayhhYnMpO1xuICAgICAgZWxzZSBpZiAoaXNEb2NOYW1lKG5hbWUpKSBuKys7XG4gICAgfVxuICB9O1xuICB3YWxrKGRpcik7XG4gIHJldHVybiBuO1xufVxuXG4vKipcbiAqIEhvdyBhIGNvbXBhcmlzb24gc2lkZSByZWFkcyBpbiBhIG1lc3NhZ2UgdG8gYSBodW1hbiBvciBhbiBhZ2VudC5cbiAqXG4gKiDim5QgVEhFIEZJTEUgSVMgTkFNRUQsIE5PVCBERVNDUklCRUQgKEU0MywgcmV2aXNlZCkuIFwiVGhlIG9yaWdpbmFsXCIgc291bmRlZFxuICogdGVtcG9yYWwgd2hlbiB0aGUgdGhpbmcgaXMgbG9jYXRpb25hbDsgXCJ0aGUgc2F2ZWQgZmlsZVwiIGZpeGVkIHRoYXQgYnV0IHJlYWRzXG4gKiBjaXJjdWxhciB0aGUgbW9tZW50IGl0IGlzIGEgREVTVElOQVRJT04g4oCUIFwic2F2ZSB0byB0aGUgc2F2ZWQgZmlsZVwiIHNheXNcbiAqIG5vdGhpbmcuIE5vIG5vdW4gZW5jYXBzdWxhdGVzIFwidGhpcyBmaWxlLCBhdCB0aGlzIHBsYWNlXCIsIHNvIHRoZSBmaWxlIGdldHNcbiAqIGl0cyBvd24gbmFtZTogYG5vdGUubWRgLiBDb2xlOiBcInRoYXQncyBwcm9iYWJseSBjbG9zZXIgdG8gdGhlIHJpZ2h0IGFuc3dlclxuICogdmVyc3VzIHRyeWluZyB0byBjb21lIHVwIHdpdGggYSB3b3JkIHRoYXQgZW5jYXBzdWxhdGVzIGl0LlwiXG4gKlxuICogYGZpbGVgIGlzIHRoZSBkb2N1bWVudCdzIG5hbWUgd2hlbiB0aGUgY2FsbGVyIGtub3dzIGl0OyB3aXRob3V0IG9uZSB0aGlzXG4gKiBmYWxscyBiYWNrIHRvIGEgZ2VuZXJpYywgd2hpY2ggaXMgb25seSBmb3IgY29udGV4dHMgdGhhdCBoYXZlIG5vIGRvY3VtZW50IGluXG4gKiBoYW5kLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2lkZU5hbWUoc2lkZTogRGlmZlNpZGUsIGZpbGU/OiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoc2lkZSAhPT0gXCJvcmlnaW5hbFwiKSByZXR1cm4gYHYke3NpZGV9YDtcbiAgcmV0dXJuIGZpbGUgPz8gXCJ0aGUgc2F2ZWQgZmlsZVwiO1xufVxuIiwKICAgICIvKipcbiAqIE9LRiBmcm9udG1hdHRlciwgcmVhZCAoRTMyKS4gVGhlIGRhZW1vbiBwYXJzZXM7IHRoZSBzdXJmYWNlIHJlbmRlcnMgd2hhdCBpdFxuICogaXMgZ2l2ZW4g4oCUIGBCdW4uWUFNTC5wYXJzZWAgaXMgaGVyZSwgc28gbm8gWUFNTCBwYXJzZXIgcmVhY2hlcyB0aGUgYnJvd3Nlci5cbiAqXG4gKiDim5QgVEhFIFNQRUMnUyBURU1QRVIgSVMgVEhFIFBPSU5ULCBBTkQgSVQgSVMgTk9UIFRIRSBVU1VBTCBPTkUuIEEgY29uc3VtZXJcbiAqIFwiTVVTVCBOT1QgcmVqZWN0IGRvY3VtZW50c1wiIGZvciB1bmtub3duIHR5cGVzLCB1bmtub3duIGtleXMsIG1pc3Npbmcgb3B0aW9uYWxcbiAqIGZpZWxkcyBvciBicm9rZW4gbGlua3MsIGFuZCBcIlNIT1VMRCBwcmVzZXJ2ZSB1bmtub3duIGtleXMgd2hlbiByb3VuZC10cmlwcGluZ1wiXG4gKiAoT0tGIDAuMiDCpzExKS4gU28gbm90aGluZyBoZXJlIHZhbGlkYXRlczogYSBkb2N1bWVudCB3aG9zZSBmcm9udG1hdHRlciB3aWxsXG4gKiBub3QgcGFyc2Uga2VlcHMgaXRzIHRleHQgYW5kIHJlcG9ydHMgdGhlIHJlYXNvbiwgZXZlcnkga2V5IHN1cnZpdmVzIGluXG4gKiBgZmllbGRzYCB3aGV0aGVyIG9yIG5vdCB0aGlzIHNwZWxsIGhhcyBoZWFyZCBvZiBpdCwgYW5kIGB0eXBlYCDigJQgdGhlIE9ORVxuICogcmVxdWlyZWQgZmllbGQg4oCUIGJlaW5nIGFic2VudCBpcyBhIGZhY3QgdG8gc2hvdywgbmV2ZXIgYW4gZXJyb3IgdG8gcmFpc2UuXG4gKlxuICogVGhlIERFUklWRUQgdmFsdWVzICh0cnVzdCwgc3RhbGVuZXNzKSBhcmUgY29tcHV0ZWQgb24gcmVhZCBhbmQgbmV2ZXIgc3RvcmVkLFxuICogd2hpY2ggaXMgYWxzbyB0aGUgc3BlYydzIHJ1bGU6IGEgdHJ1c3QgdGllciB3cml0dGVuIGludG8gYSBmaWxlIHdvdWxkIGJlIGFcbiAqIGNsYWltIGFib3V0IGl0c2VsZi5cbiAqL1xuaW1wb3J0IHR5cGUgeyBEb2NNZXRhLCBEb2NTdW1tYXJ5LCBUcnVzdFRpZXIgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKiogQSBmcm9udG1hdHRlciBibG9jazogYC0tLWAgb24gaXRzIG93biBmaXJzdCBsaW5lLCB0byB0aGUgbmV4dCBgLS0tYCBsaW5lLiAqL1xuY29uc3QgQkxPQ0sgPSAvXi0tLVxccj9cXG4oW1xcc1xcU10qPylcXHI/XFxuLS0tWyBcXHRdKig/Olxccj9cXG58JCkvO1xuXG4vKipcbiAqIFNwbGl0IGEgZG9jdW1lbnQgaW50byBpdHMgcmF3IGZyb250bWF0dGVyIGJsb2NrIGFuZCB0aGUgYm9keSBiZW5lYXRoIGl0LlxuICogUHVyZSBzdHJpbmcgd29yaywgbm8gWUFNTCDigJQgdGhlIFNVUkZBQ0UgaGFzIHRoZSBzYW1lIGZ1bmN0aW9uIChpdCBtdXN0IHN0cmlwXG4gKiB0aGUgYmxvY2sgYmVmb3JlIHJlbmRlcmluZykgYW5kIGBmcm9udG1hdHRlci50ZXN0LnRzYCBob2xkcyB0aGUgdHdvIGVxdWFsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3BsaXRGcm9udG1hdHRlcih0ZXh0OiBzdHJpbmcpOiB7IHJhdzogc3RyaW5nIHwgbnVsbDsgYm9keTogc3RyaW5nIH0ge1xuICBjb25zdCBtID0gQkxPQ0suZXhlYyh0ZXh0KTtcbiAgaWYgKCFtKSByZXR1cm4geyByYXc6IG51bGwsIGJvZHk6IHRleHQgfTtcbiAgcmV0dXJuIHsgcmF3OiBtWzFdID8/IFwiXCIsIGJvZHk6IHRleHQuc2xpY2UobVswXS5sZW5ndGgpIH07XG59XG5cbi8qKiBPS0YncyB0aHJlZSwgYW5kIGFueXRoaW5nIGVsc2UgYSBwcm9kdWNlciB3cm90ZS4gYHN0YWJsZWAgaXMgdGhlIGRlZmF1bHQuICovXG5mdW5jdGlvbiBzdGF0dXNPZihmaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogc3RyaW5nIHtcbiAgY29uc3QgcyA9IGZpZWxkcy5zdGF0dXM7XG4gIHJldHVybiB0eXBlb2YgcyA9PT0gXCJzdHJpbmdcIiAmJiBzLnRyaW0oKSAhPT0gXCJcIiA/IHMgOiBcInN0YWJsZVwiO1xufVxuXG5jb25zdCBhc0xpc3QgPSAodjogdW5rbm93bik6IHN0cmluZ1tdID0+XG4gIEFycmF5LmlzQXJyYXkodikgPyB2LmZpbHRlcigoeCkgPT4gdHlwZW9mIHggPT09IFwic3RyaW5nXCIpIDogdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgPyBbdl0gOiBbXTtcblxuLyoqIEFuIGFjdG9yIGlzIGh1bWFuIGlmZiBpdCBpcyBzcGVsbGVkIGBodW1hbjo8aWQ+YCDigJQgT0tGIDAuMiDCpzYncyBydWxlLiAqL1xuY29uc3QgaXNIdW1hbiA9IChhY3RvcjogdW5rbm93bik6IGJvb2xlYW4gPT5cbiAgdHlwZW9mIGFjdG9yID09PSBcInN0cmluZ1wiICYmIGFjdG9yLnRvTG93ZXJDYXNlKCkuc3RhcnRzV2l0aChcImh1bWFuOlwiKTtcblxuLyoqXG4gKiBPS0YncyB0cnVzdCB0aWVycywgREVSSVZFRDogbm8gYHZlcmlmaWVkYCDihpIgdW52ZXJpZmllZDsgdmVyaWZpZWQgYnkgbWFjaGluZXNcbiAqIG9ubHkg4oaSIG1hY2hpbmUtY29uZmlybWVkOyB2ZXJpZmllZCBieSBhIGBodW1hbjo8aWQ+YCDihpIgaHVtYW4tcmV2aWV3ZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0cnVzdFRpZXIoZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFRydXN0VGllciB7XG4gIGNvbnN0IHZlcmlmaWVkID0gZmllbGRzLnZlcmlmaWVkO1xuICBjb25zdCBldmVudHMgPSBBcnJheS5pc0FycmF5KHZlcmlmaWVkKSA/IHZlcmlmaWVkIDogdmVyaWZpZWQgPyBbdmVyaWZpZWRdIDogW107XG4gIGlmIChldmVudHMubGVuZ3RoID09PSAwKSByZXR1cm4gXCJ1bnZlcmlmaWVkXCI7XG4gIGZvciAoY29uc3QgZSBvZiBldmVudHMpXG4gICAgaWYgKGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgaXNIdW1hbigoZSBhcyB7IGJ5PzogdW5rbm93biB9KS5ieSkpIHJldHVybiBcImh1bWFuLXJldmlld2VkXCI7XG4gIHJldHVybiBcIm1hY2hpbmUtY29uZmlybWVkXCI7XG59XG5cbi8qKiBgc3RhbGVfYWZ0ZXJgIGlzIGFuIElOU1RBTlQsIG5vdCBhIFRUTDogc3RhbGUgd2hlbiBub3cgPj0gaXQuICovXG5leHBvcnQgZnVuY3Rpb24gaXNTdGFsZShmaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBub3c6IG51bWJlcik6IGJvb2xlYW4ge1xuICBjb25zdCBhdCA9IGZpZWxkcy5zdGFsZV9hZnRlcjtcbiAgY29uc3QgdCA9XG4gICAgYXQgaW5zdGFuY2VvZiBEYXRlID8gYXQuZ2V0VGltZSgpIDogdHlwZW9mIGF0ID09PSBcInN0cmluZ1wiID8gRGF0ZS5wYXJzZShhdCkgOiBOdW1iZXIuTmFOO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHQpICYmIG5vdyA+PSB0O1xufVxuXG4vKiogV2hlbiB0aGUgY29udGVudCBsYXN0IG1lYW5pbmdmdWxseSBjaGFuZ2VkLCBwZXIgYGdlbmVyYXRlZC5hdGAsIGFzIGFuIElTTyBkYXRlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdlbmVyYXRlZEF0KGZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgZyA9IGZpZWxkcy5nZW5lcmF0ZWQ7XG4gIGNvbnN0IGF0ID0gZyAmJiB0eXBlb2YgZyA9PT0gXCJvYmplY3RcIiA/IChnIGFzIHsgYXQ/OiB1bmtub3duIH0pLmF0IDogdW5kZWZpbmVkO1xuICBpZiAoYXQgaW5zdGFuY2VvZiBEYXRlKSByZXR1cm4gYXQudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCk7XG4gIGlmICh0eXBlb2YgYXQgPT09IFwic3RyaW5nXCIpIHtcbiAgICBjb25zdCB0ID0gRGF0ZS5wYXJzZShhdCk7XG4gICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZSh0KSA/IG5ldyBEYXRlKHQpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApIDogYXQ7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmNvbnN0IHN0ciA9ICh2OiB1bmtub3duKTogc3RyaW5nIHwgdW5kZWZpbmVkID0+XG4gIHR5cGVvZiB2ID09PSBcInN0cmluZ1wiICYmIHYudHJpbSgpICE9PSBcIlwiID8gdi50cmltKCkgOiB1bmRlZmluZWQ7XG5cbi8qKlxuICogUmVhZCBhIGRvY3VtZW50J3MgZnJvbnRtYXR0ZXIuIFJldHVybnMgbnVsbCB3aGVuIHRoZXJlIGlzIG5vIGJsb2NrIGF0IGFsbCDigJRcbiAqIHdoaWNoIGlzIGEgbm9ybWFsIGRvY3VtZW50LCBub3QgYSBkZWZlY3QuIEEgYmxvY2sgdGhhdCB3aWxsIG5vdCBwYXJzZSBjb21lc1xuICogYmFjayB3aXRoIGBlcnJvcmAgc2V0IGFuZCBldmVyeSBvdGhlciBmaWVsZCBlbXB0eTogc2FpZCwgbm90IHN3YWxsb3dlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWRNZXRhKHRleHQ6IHN0cmluZywgbm93ID0gRGF0ZS5ub3coKSk6IERvY01ldGEgfCBudWxsIHtcbiAgY29uc3QgeyByYXcgfSA9IHNwbGl0RnJvbnRtYXR0ZXIodGV4dCk7XG4gIGlmIChyYXcgPT09IG51bGwpIHJldHVybiBudWxsO1xuICBsZXQgZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICBsZXQgZXJyb3I6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQgPSBCdW4uWUFNTC5wYXJzZShyYXcpIGFzIHVua25vd247XG4gICAgaWYgKHBhcnNlZCAmJiB0eXBlb2YgcGFyc2VkID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHBhcnNlZCkpXG4gICAgICBmaWVsZHMgPSBwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgZWxzZSBpZiAocGFyc2VkICE9PSBudWxsICYmIHBhcnNlZCAhPT0gdW5kZWZpbmVkKVxuICAgICAgZXJyb3IgPSBcInRoZSBmcm9udG1hdHRlciBpcyBub3QgYSBtYXBwaW5nIG9mIGtleXMgdG8gdmFsdWVzXCI7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBlcnJvciA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZS5zcGxpdChcIlxcblwiKVswXSA6IFN0cmluZyhlKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIHJhdyxcbiAgICBmaWVsZHMsXG4gICAgdHlwZTogc3RyKGZpZWxkcy50eXBlKSxcbiAgICB0aXRsZTogc3RyKGZpZWxkcy50aXRsZSksXG4gICAgZGVzY3JpcHRpb246IHN0cihmaWVsZHMuZGVzY3JpcHRpb24pLFxuICAgIHN0YXR1czogc3RhdHVzT2YoZmllbGRzKSxcbiAgICB0YWdzOiBhc0xpc3QoZmllbGRzLnRhZ3MpLFxuICAgIGxpZmVjeWNsZTogc3RyKGZpZWxkcy5saWZlY3ljbGUpLFxuICAgIHRydXN0OiB0cnVzdFRpZXIoZmllbGRzKSxcbiAgICBzdGFsZTogaXNTdGFsZShmaWVsZHMsIG5vdyksXG4gICAgZGF0ZTogZ2VuZXJhdGVkQXQoZmllbGRzKSxcbiAgICAuLi4oZXJyb3IgPyB7IGVycm9yIH0gOiB7fSksXG4gIH07XG59XG5cbi8qKiBUaGUgc21hbGwgc2hhcGUgdGhlIHNpZGViYXIgbmVlZHMgZm9yIGV2ZXJ5IGNvbnRleHQgZG9jdW1lbnQuICovXG5leHBvcnQgZnVuY3Rpb24gc3VtbWFyaXplKG1ldGE6IERvY01ldGEgfCBudWxsKTogRG9jU3VtbWFyeSB8IG51bGwge1xuICBpZiAoIW1ldGEpIHJldHVybiBudWxsO1xuICByZXR1cm4ge1xuICAgIC4uLihtZXRhLnR5cGUgPyB7IHR5cGU6IG1ldGEudHlwZSB9IDoge30pLFxuICAgIC4uLihtZXRhLnRpdGxlID8geyB0aXRsZTogbWV0YS50aXRsZSB9IDoge30pLFxuICAgIHN0YXR1czogbWV0YS5zdGF0dXMsXG4gICAgdGFnczogbWV0YS50YWdzLFxuICAgIHRydXN0OiBtZXRhLnRydXN0LFxuICAgIHN0YWxlOiBtZXRhLnN0YWxlLFxuICAgIC4uLihtZXRhLmxpZmVjeWNsZSA/IHsgbGlmZWN5Y2xlOiBtZXRhLmxpZmVjeWNsZSB9IDoge30pLFxuICAgIC4uLihtZXRhLmVycm9yID8geyBlcnJvcjogbWV0YS5lcnJvciB9IDoge30pLFxuICB9O1xufVxuXG4vKiogcGRvY3MncyBmaWx0ZXIgdm9jYWJ1bGFyeSwgc28gd2hhdCB0aGUgaHVtYW4gbGVhcm5zIHRoZXJlIGhvbGRzIGhlcmUuICovXG5leHBvcnQgdHlwZSBNZXRhRmlsdGVyID0ge1xuICB0eXBlPzogc3RyaW5nO1xuICBzdGF0dXM/OiBzdHJpbmc7XG4gIGxpZmVjeWNsZT86IHN0cmluZztcbiAgdGFnPzogc3RyaW5nO1xuICAvKiogQW4gSVNPIGRhdGU7IG1hdGNoZXMgZG9jdW1lbnRzIHdob3NlIGBnZW5lcmF0ZWQuYXRgIGlzIG9uIG9yIGFmdGVyIGl0LiAqL1xuICBzaW5jZT86IHN0cmluZztcbn07XG5cbi8qKlxuICogRmlsdGVycyBhcmUgQU5EZWQsIGFuZCBldmVyeSBvbmUgaXMgb3B0aW9uYWwg4oCUIGEgYmFyZSBmaWx0ZXIgbWF0Y2hlcyBhbGwuXG4gKlxuICog4puUIEEgRE9DVU1FTlQgV0lUSCBOTyBGUk9OVE1BVFRFUiBNQVRDSEVTIE9OTFkgVEhFIEVNUFRZIEZJTFRFUiwgYW5kIHRoYXRcbiAqIGluY2x1ZGVzIGAtLXN0YXR1cyBzdGFibGVgLiBBYnNlbnQgYHN0YXR1c2AgZGVmYXVsdHMgdG8gYHN0YWJsZWAgZm9yIGFuIE9LRlxuICogZG9jdW1lbnQgKMKnNSksIGJ1dCBhIGRvY3VtZW50IHdpdGggbm8gYmxvY2sgYXQgYWxsIGlzIG5vdCBtYWtpbmcgdGhlIGNsYWltOlxuICogYGZpbmQgLS1zdGF0dXMgc3RhYmxlYCBhc2tzIHdoaWNoIGRvY3VtZW50cyBTQVkgdGhleSBhcmUgc3RhYmxlLCBhbmQgYSBmaWxlXG4gKiB3aXRoIG5vIGZyb250bWF0dGVyIHNheXMgbm90aGluZy4gUmVhZGluZyB0aGUgZGVmYXVsdCB0aGUgb3RoZXIgd2F5IHdvdWxkIHB1dFxuICogZXZlcnkgdW50b3VjaGVkIG5vdGUgaW4gdGhlIHJlc3VsdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hdGNoZXNGaWx0ZXIobWV0YTogRG9jTWV0YSB8IG51bGwsIGZpbHRlcjogTWV0YUZpbHRlcik6IGJvb2xlYW4ge1xuICBpZiAobWV0YSA9PT0gbnVsbCkgcmV0dXJuIE9iamVjdC52YWx1ZXMoZmlsdGVyKS5ldmVyeSgodikgPT4gdiA9PT0gdW5kZWZpbmVkKTtcbiAgaWYgKGZpbHRlci50eXBlICE9PSB1bmRlZmluZWQgJiYgbWV0YS50eXBlICE9PSBmaWx0ZXIudHlwZSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoZmlsdGVyLnN0YXR1cyAhPT0gdW5kZWZpbmVkICYmIG1ldGEuc3RhdHVzICE9PSBmaWx0ZXIuc3RhdHVzKSByZXR1cm4gZmFsc2U7XG4gIGlmIChmaWx0ZXIubGlmZWN5Y2xlICE9PSB1bmRlZmluZWQgJiYgbWV0YS5saWZlY3ljbGUgIT09IGZpbHRlci5saWZlY3ljbGUpIHJldHVybiBmYWxzZTtcbiAgaWYgKGZpbHRlci50YWcgIT09IHVuZGVmaW5lZCAmJiAhbWV0YS50YWdzLmluY2x1ZGVzKGZpbHRlci50YWcpKSByZXR1cm4gZmFsc2U7XG4gIGlmIChmaWx0ZXIuc2luY2UgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICghbWV0YS5kYXRlKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKG1ldGEuZGF0ZSA8IGZpbHRlci5zaW5jZSkgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyDilIDilIAgV1JJVElORyAoRTM1KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyDim5QgRVZFUlkgV1JJVEUgSEVSRSBJUyBBIFRFWFQgRURJVCwgTkVWRVIgQSBSRVNFUklBTElTQVRJT04uIFBhcnNpbmcgYSBibG9ja1xuLy8gYW5kIHByaW50aW5nIGl0IGJhY2sgcmVvcmRlcnMga2V5cywgZHJvcHMgY29tbWVudHMgYW5kIGNoYW5nZXMgcXVvdGluZyDigJQgYW5kXG4vLyB0aGUgc3BlYyBhc2tzIGEgY29uc3VtZXIgdG8gXCJwcmVzZXJ2ZSB1bmtub3duIGtleXMgd2hlbiByb3VuZC10cmlwcGluZ1wiXG4vLyAowqcxMSksIHdoaWNoIGlzIHByZWNpc2VseSB3aGF0IHRoYXQgbG9zZXMuIFNvIGEgbmV3IGJsb2NrIGlzIEJVSUxUICh0aGVyZSBpc1xuLy8gbm90aGluZyB0byBwcmVzZXJ2ZSB5ZXQpIGFuZCBhbiBleGlzdGluZyBvbmUgaXMgZWRpdGVkIGEgTElORSBhdCBhIHRpbWUuXG5cbi8qKiBUaGUgZG9jdW1lbnQncyBmaXJzdCBIMSwgd2hpY2ggaXMgdGhlIHRpdGxlIGEgaHVtYW4gYWxyZWFkeSB3cm90ZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0aXRsZUZyb21Cb2R5KGJvZHk6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGZvciAoY29uc3QgbGluZSBvZiBib2R5LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgY29uc3QgbSA9IC9eI1xccysoLis/KVxccyokLy5leGVjKGxpbmUpO1xuICAgIGlmIChtKSByZXR1cm4gbVsxXTtcbiAgICBpZiAobGluZS50cmltKCkgIT09IFwiXCIgJiYgIWxpbmUuc3RhcnRzV2l0aChcIiNcIikpIGJyZWFrOyAvLyBwcm9zZSBiZWZvcmUgYW55IGhlYWRpbmdcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIEEgYHR5cGVgIHRvIFNVR0dFU1QgZm9yIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZS5cbiAqXG4gKiDim5QgRlJPTSBUSEUgTkVJR0hCT1VSUywgTkVWRVIgRlJPTSBBIEZJWEVEIExJU1QuIE9LRidzIGB0eXBlYCBpcyBcIm5vdFxuICogY2VudHJhbGx5IHJlZ2lzdGVyZWRcIiBhbmQgZXZlcnkgY29ycHVzIGludmVudHMgaXRzIG93biDigJQgYHJlcG9ydGAsIGBydWxlYCxcbiAqIGBhcmNoZXR5cGVgIGluIG9uZSwgc29tZXRoaW5nIGVsc2UgaW4gdGhlIG5leHQg4oCUIHNvIHRoZSBvbmx5IGhvbmVzdCBzb3VyY2UgaXNcbiAqIHdoYXQgdGhlIGRvY3VtZW50cyBiZXNpZGUgdGhpcyBvbmUgYWxyZWFkeSBzYXkuIFRoZSBmb2xkZXIncyBuYW1lIGlzIHRoZVxuICogZmFsbGJhY2ssIGFuZCB3aGVuIG5laXRoZXIgYW5zd2Vycywgbm90aGluZyBpcyBzdWdnZXN0ZWQ6IGEgYmxhbmsgdGhlIGh1bWFuXG4gKiBmaWxscyBiZWF0cyBhIHBsYXVzaWJsZSBndWVzcyAoU0NIRU1BLm1kJ3Mgb3duIHJ1bGUgYWJvdXQgYGdlbmVyYXRlZC5ieWApLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ3Vlc3NUeXBlKHNpYmxpbmdUeXBlczogcmVhZG9ubHkgc3RyaW5nW10sIGZvbGRlcjogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgY291bnRzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgZm9yIChjb25zdCB0IG9mIHNpYmxpbmdUeXBlcykgaWYgKHQpIGNvdW50cy5zZXQodCwgKGNvdW50cy5nZXQodCkgPz8gMCkgKyAxKTtcbiAgY29uc3QgYmVzdCA9IFsuLi5jb3VudHMuZW50cmllcygpXS5zb3J0KChhLCBiKSA9PiBiWzFdIC0gYVsxXSB8fCBhWzBdLmxvY2FsZUNvbXBhcmUoYlswXSkpWzBdO1xuICBpZiAoYmVzdCkgcmV0dXJuIGJlc3RbMF07XG4gIGNvbnN0IG5hbWUgPSBmb2xkZXIudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChuYW1lID09PSBcIlwiIHx8IG5hbWUgPT09IFwiLlwiIHx8IG5hbWUgPT09IFwiL1wiKSByZXR1cm4gdW5kZWZpbmVkO1xuICAvLyBgZGVjaXNpb25zL2Ag4oaSIGBkZWNpc2lvbmA7IGBkb2NzL2Ag4oaSIGBkb2NgLiBBIHBsdXJhbCBmb2xkZXIgbmFtZXMgaXRzIGtpbmQuXG4gIHJldHVybiBuYW1lLmVuZHNXaXRoKFwiaWVzXCIpXG4gICAgPyBgJHtuYW1lLnNsaWNlKDAsIC0zKX15YFxuICAgIDogbmFtZS5lbmRzV2l0aChcInNcIilcbiAgICAgID8gbmFtZS5zbGljZSgwLCAtMSlcbiAgICAgIDogbmFtZTtcbn1cblxuLyoqIEEgWUFNTCBzY2FsYXIsIHF1b3RlZCBvbmx5IHdoZW4gaXQgbXVzdCBiZS4gKi9cbmZ1bmN0aW9uIHNjYWxhcih2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIC9eW1xcdyAuLCcnL0ArLV0qJC8udGVzdCh2YWx1ZSkgJiYgIS9eXFxzfFxccyQvLnRlc3QodmFsdWUpICYmIHZhbHVlICE9PSBcIlwiXG4gICAgPyB2YWx1ZVxuICAgIDogSlNPTi5zdHJpbmdpZnkodmFsdWUpO1xufVxuXG5leHBvcnQgdHlwZSBOZXdNZXRhID0ge1xuICB0eXBlPzogc3RyaW5nO1xuICB0aXRsZT86IHN0cmluZztcbiAgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gIHN0YXR1cz86IHN0cmluZztcbiAgdGFncz86IHN0cmluZ1tdO1xuICAvKiogYGdlbmVyYXRlZC5ieWAg4oCUIHRoZSBhY3RvciwgcmVjb3JkZWQgaG9uZXN0bHkgb3IgbGVmdCBgdW5rbm93bmAuICovXG4gIGJ5Pzogc3RyaW5nO1xuICBhdD86IHN0cmluZztcbn07XG5cbi8qKlxuICogQSBmcm9udG1hdHRlciBibG9jayBmb3IgYSBkb2N1bWVudCB0aGF0IGhhcyBub25lLiBPS0YncyByZWNvbW1lbmRlZCBzZXQgaW5cbiAqIHRoZSBvcmRlciB0aGUgY29ycG9yYSB3cml0ZSBpdCwgd2l0aCBgZGVzY3JpcHRpb25gIGxlZnQgRU1QVFkgZm9yIHRoZSBhdXRob3I6XG4gKiBhIG9uZS1saW5lIHN1bW1hcnkgbm9ib2R5IHdyb3RlIGlzIHdvcnNlIHRoYW4gYSBibGFuayB0aGF0IGFza3MgdG8gYmUgZmlsbGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRCbG9jayhtZXRhOiBOZXdNZXRhKTogc3RyaW5nIHtcbiAgY29uc3QgYXQgPSBtZXRhLmF0ID8/IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCk7XG4gIGNvbnN0IGxpbmVzID0gW1xuICAgIGB0eXBlOiAke3NjYWxhcihtZXRhLnR5cGUgPz8gXCJcIil9YCxcbiAgICBgdGl0bGU6ICR7c2NhbGFyKG1ldGEudGl0bGUgPz8gXCJcIil9YCxcbiAgICBgZGVzY3JpcHRpb246ICR7bWV0YS5kZXNjcmlwdGlvbiA/IHNjYWxhcihtZXRhLmRlc2NyaXB0aW9uKSA6IFwiXCJ9YCxcbiAgICBgdGFnczogWyR7KG1ldGEudGFncyA/PyBbXSkubWFwKHNjYWxhcikuam9pbihcIiwgXCIpfV1gLFxuICAgIGBzdGF0dXM6ICR7c2NhbGFyKG1ldGEuc3RhdHVzID8/IFwiZHJhZnRcIil9YCxcbiAgICBgZ2VuZXJhdGVkOiB7IGJ5OiAke3NjYWxhcihtZXRhLmJ5ID8/IFwidW5rbm93blwiKX0sIGF0OiAke2F0fSB9YCxcbiAgXTtcbiAgcmV0dXJuIGAtLS1cXG4ke2xpbmVzLmpvaW4oXCJcXG5cIil9XFxuLS0tXFxuYDtcbn1cblxuLyoqXG4gKiBQdXQgYSBuZXcgYmxvY2sgYXQgdGhlIHRvcCBvZiBhIGRvY3VtZW50IHRoYXQgaGFzIG5vbmUuIE5vIGJsYW5rIGxpbmUgaXNcbiAqIGluc2VydGVkOiB0aGUgY29ycG9yYSB3cml0ZSB0aGUgYm9keSBkaXJlY3RseSB1bmRlciB0aGUgY2xvc2luZyBgLS0tYCwgYW5kIGFcbiAqIGJsb2NrIHRoYXQgYWRkcyBvbmUgd291bGQgc2hvdyBhcyBhIGRpZmYgb24gZXZlcnkgZG9jdW1lbnQgaXQgdG91Y2hlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdpdGhCbG9jayh0ZXh0OiBzdHJpbmcsIGJsb2NrOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7YmxvY2t9JHt0ZXh0fWA7XG59XG5cbi8qKlxuICogU2V0IG9uZSBrZXkgaW4gYW4gRVhJU1RJTkcgYmxvY2ssIGFzIGEgbGluZSBlZGl0OiB0aGUga2V5J3MgbGluZSBpcyByZXBsYWNlZFxuICogd2hlcmUgaXQgZXhpc3RzIGFuZCBhcHBlbmRlZCBiZWZvcmUgdGhlIGNsb3NpbmcgYC0tLWAgd2hlcmUgaXQgZG9lcyBub3QuXG4gKiBFdmVyeXRoaW5nIGVsc2Ug4oCUIG9yZGVyLCBjb21tZW50cywgc3BhY2luZywga2V5cyB0aGlzIHNwZWxsIG5ldmVyIGhlYXJkIG9mIOKAlFxuICogc3Vydml2ZXMgYnl0ZSBmb3IgYnl0ZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldEtleSh0ZXh0OiBzdHJpbmcsIGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgeyByYXcgfSA9IHNwbGl0RnJvbnRtYXR0ZXIodGV4dCk7XG4gIGlmIChyYXcgPT09IG51bGwpIHRocm93IG5ldyBFcnJvcihcInRoaXMgZG9jdW1lbnQgaGFzIG5vIGZyb250bWF0dGVyIGJsb2NrXCIpO1xuICBjb25zdCBsaW5lID0gYCR7a2V5fTogJHtzY2FsYXIodmFsdWUpfWA7XG4gIGNvbnN0IGtleUxpbmUgPSBuZXcgUmVnRXhwKGBeJHtrZXkucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xcXVxcXFxdL2csIFwiXFxcXCQmXCIpfVxcXFxzKjpgKTtcbiAgY29uc3QgbGluZXMgPSByYXcuc3BsaXQoXCJcXG5cIik7XG4gIGNvbnN0IGF0ID0gbGluZXMuZmluZEluZGV4KChsKSA9PiBrZXlMaW5lLnRlc3QobCkpO1xuICBpZiAoYXQgPT09IC0xKSBsaW5lcy5wdXNoKGxpbmUpO1xuICBlbHNlIHtcbiAgICAvLyBBIG11bHRpLWxpbmUgdmFsdWUgKGEgZm9sZGVkIGRlc2NyaXB0aW9uLCBhIG5lc3RlZCBtYXBwaW5nKSBpcyB0aGVcbiAgICAvLyBrZXkncyBsaW5lIFBMVVMgZXZlcnkgaW5kZW50ZWQgbGluZSB1bmRlciBpdDsgYWxsIG9mIHRoZW0gZ28uXG4gICAgbGV0IGVuZCA9IGF0ICsgMTtcbiAgICB3aGlsZSAoZW5kIDwgbGluZXMubGVuZ3RoICYmIC9eXFxzK1xcUy8udGVzdChsaW5lc1tlbmRdID8/IFwiXCIpKSBlbmQrKztcbiAgICBsaW5lcy5zcGxpY2UoYXQsIGVuZCAtIGF0LCBsaW5lKTtcbiAgfVxuICBjb25zdCByZWJ1aWx0ID0gbGluZXMuam9pbihcIlxcblwiKTtcbiAgcmV0dXJuIHRleHQucmVwbGFjZShyYXcsIHJlYnVpbHQpO1xufVxuIiwKICAgICIvKipcbiAqIExpbmtzIGJldHdlZW4gZG9jdW1lbnRzIChFMzMpOiB3aGF0IGEgZG9jdW1lbnQgcG9pbnRzIGF0LCBhbmQgd2hhdCB0aGF0XG4gKiByZXNvbHZlcyB0byBpbnNpZGUgYSBzZXQuXG4gKlxuICog4pSA4pSAIEZPVVIgU09VUkNFUyBPRiBFREdFUywgQU5EIFRIRVkgQVJFIE5PVCBPTkUgS0lORCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAgIDEuIG1hcmtkb3duIGxpbmtzICAgICAgYFtsYWJlbF0oLi9vdGhlci5tZClgICAgICAg4oCUIGJvZHlcbiAqICAgMi4gd2lraSBsaW5rcyAgICAgICAgICBgW1tvdGhlci1kb2N8bGFiZWxdXWAgICAgICDigJQgYm9keVxuICogICAzLiBmcm9udG1hdHRlciB2YWx1ZXMgIGByZWxhdGVkOiBbY29uY2VwdC94XWAgICAgIOKAlCBhdXRob3JlZCBpbnRlbnRcbiAqICAgNC4gYHNvdXJjZXNbXS5yZXNvdXJjZWAgICAgICAgICAgICAgICAgICAgICAgICAgICDigJQgYXV0aG9yZWQgaW50ZW50XG4gKlxuICogcGRvY3Mga2VlcHMgdGhlIGZyb250bWF0dGVyIGVkZ2UgYW5kIHRoZSBib2R5LWxpbmsgZWRnZSBBUEFSVCAoYHJlbGF0ZWRbXWBcbiAqIGFuZCBgbGlua3NbXWAgaW4gaXRzIGBiYWNrbGlua3NgIG91dHB1dCksIGFuZCB0aGUgZGlzdGluY3Rpb24gaXMgcmVhbDogYVxuICogYHJlbGF0ZWRgIGtleSBpcyBhIGNsYWltIHRoZSBhdXRob3IgbWFkZSBhYm91dCB0aGUgZG9jdW1lbnQgYXMgYSB3aG9sZSwgYVxuICogYm9keSBsaW5rIGlzIGEgY2l0YXRpb24gYXQgYSBwbGFjZSBpbiB0aGUgcHJvc2UuIFRoZXkgc3RheSBhcGFydCBoZXJlIHRvby5cbiAqXG4gKiDilIDilIAgVFlQRUQgTElOS1MgKE9wZXJhdG9yJ3Mgc2hhcGUsIENvbGUgMjAyNi0wOS0xMSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQSByZWxhdGlvbiByaWRlcyB0aGUgbGluayBhcyBhIHF1ZXJ5OiBgW2xhYmVsXSguL290aGVyLm1kP3JlbD1leHRlbmRzKWAsXG4gKiBgW1tvdGhlcj9yZWw9c3VwZXJzZWRlc3xsYWJlbF1dYC4gQ29waWVkIGV4YWN0bHkgZnJvbSBPcGVyYXRvcidzIHBhcnNlclxuICogKGBwYWNrYWdlcy9zaGFyZWQvc3JjL2xpbmtzL2ApOiBvbmUgbGluayBjYXJyaWVzIEFMTCBvZiBpdHMgcmVscywgdGhleSBhcmVcbiAqIG5vcm1hbGlzZWQgKGxvd2VyY2FzZWQsIHRyaW1tZWQsIGRlZHVwZWQsIGZpcnN0LWF1dGhvcmVkIG9yZGVyIGtlcHQpIGJ1dFxuICogdGhlaXIgU1BFTExJTkcgaXMgbm90IGNhbm9uaWNhbGlzZWQsIGFuZCAqKmEgYmFyZSBsaW5rIGlzIGBbXWAg4oCUIHRoZSBBQlNFTkNFXG4gKiBvZiBhbiBhc3NlcnRpb24sIG5vdCBhbiBpbXBsaWNpdCBgcmVmZXJlbmNlc2AqKi4gQSBncmFwaCBtdXN0IG5vdCBkcmF3IGFcbiAqIGNsYWltIG5vYm9keSBtYWRlLlxuICpcbiAqIOKUgOKUgCBXSEFUIEEgQlVORExFIElTIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIE9LRidzIGJ1bmRsZS1yZWxhdGl2ZSBmb3JtIChgL2NvbmNlcHRzL3gubWRgKSBtZWFucyB0aGUgQlVORExFIHJvb3QsIG5vdCB0aGVcbiAqIGZpbGVzeXN0ZW0gcm9vdCwgc28gYSByZXNvbHZlciBuZWVkcyBhIGJ1bmRsZSBiZWZvcmUgaXQgY2FuIHJlc29sdmUgYW55dGhpbmc6XG4gKiAqKmEgc2V0J3MgZW50cnkgcm9vdCBpcyB0aGUgYnVuZGxlKiogKEUzMykuIEEgdGFyZ2V0IHRoYXQgZXNjYXBlcyBpdCBpcyBub3QgYW5cbiAqIGVycm9yIOKAlCB0aGUgc3BlYyByZXF1aXJlcyB0b2xlcmF0aW5nIGJyb2tlbiBsaW5rcyDigJQgaXQgaXMgYW4gZWRnZSBtYXJrZWRcbiAqIGBvdXRzaWRlYCBvciBgbWlzc2luZ2AsIHdoaWNoIHRoZSBzdXJmYWNlIG9mZmVycyB0byBhZGQgcmF0aGVyIHRoYW4gZm9sbG93LlxuICovXG5pbXBvcnQge1xuICBiYXNlbmFtZSxcbiAgZGlybmFtZSxcbiAgZXh0bmFtZSxcbiAgam9pbixcbiAgbm9ybWFsaXplLFxuICByZWxhdGl2ZSxcbiAgcmVzb2x2ZSBhcyByZXNvbHZlUGF0aCxcbn0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBEb2NNZXRhIH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcbmltcG9ydCB7IHRvUG9zaXggfSBmcm9tIFwiLi90cmVlXCI7XG5cbmV4cG9ydCB0eXBlIExpbmtLaW5kID0gXCJtYXJrZG93blwiIHwgXCJ3aWtpXCI7XG5cbi8qKiBPbmUgbGluayBhcyB3cml0dGVuLCBiZWZvcmUgYW55dGhpbmcgaXMgcmVzb2x2ZWQuICovXG5leHBvcnQgdHlwZSBMaW5rUmVmID0ge1xuICBraW5kOiBMaW5rS2luZDtcbiAgLyoqIFRoZSB0YXJnZXQgYXMgYXV0aG9yZWQsIHdpdGggaXRzIHF1ZXJ5IGFuZCBhbmNob3Igc3RyaXBwZWQuICovXG4gIHRhcmdldDogc3RyaW5nO1xuICAvKiogUmVsYXRpb25zIGZyb20gYD9yZWw9YDsgRU1QVFkgbWVhbnMgbm8gYXNzZXJ0aW9uLCBuZXZlciBgcmVmZXJlbmNlc2AuICovXG4gIHJlbDogc3RyaW5nW107XG4gIGxhYmVsPzogc3RyaW5nO1xufTtcblxuLyoqIEEgcmVmZXJlbmNlIGZvdW5kIGluIGZyb250bWF0dGVyLCB3aXRoIHRoZSBrZXkgdGhhdCBjYXJyaWVkIGl0LiAqL1xuZXhwb3J0IHR5cGUgRmllbGRSZWYgPSB7IGtleTogc3RyaW5nOyB2YWx1ZTogc3RyaW5nIH07XG5cbmNvbnN0IEZFTkNFX0xJTkUgPSAvXig/OmBgYHx+fn4pLztcblxuLyoqXG4gKiBTdHJpcCBmZW5jZWQgY29kZSBibG9ja3MuIEEgZG9jdW1lbnQgYWJvdXQgbGlua3MgcXVvdGVzIGxpbmsgc3ludGF4LCBhbmQgdGhlXG4gKiB3aWtpIHRoaXMgd2FzIGJ1aWx0IGFnYWluc3QgZG9lcyBleGFjdGx5IHRoYXQg4oCUIHdpdGhvdXQgdGhpcywgU0NIRU1BLm1kJ3NcbiAqIGV4YW1wbGVzIGJlY29tZSBlZGdlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdpdGhvdXRGZW5jZXMoYm9keTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgZmVuY2U6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgYm9keS5zcGxpdChcIlxcblwiKSkge1xuICAgIGNvbnN0IG0gPSBGRU5DRV9MSU5FLmV4ZWMobGluZSk7XG4gICAgaWYgKGZlbmNlID09PSBudWxsICYmIG0pIHtcbiAgICAgIGZlbmNlID0gbVswXTtcbiAgICAgIG91dC5wdXNoKFwiXCIpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChmZW5jZSAhPT0gbnVsbCkge1xuICAgICAgaWYgKG0gJiYgbGluZS5zdGFydHNXaXRoKGZlbmNlKSkgZmVuY2UgPSBudWxsO1xuICAgICAgb3V0LnB1c2goXCJcIik7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgb3V0LnB1c2gobGluZSk7XG4gIH1cbiAgcmV0dXJuIG91dC5qb2luKFwiXFxuXCIpO1xufVxuXG4vKiogYD9yZWw9YSxiYCDihpIgYFtcImFcIixcImJcIl1gLCBub3JtYWxpc2VkIHRoZSB3YXkgT3BlcmF0b3Igbm9ybWFsaXNlcyB0aGVtLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUmVsKHF1ZXJ5OiBzdHJpbmcgfCB1bmRlZmluZWQpOiBzdHJpbmdbXSB7XG4gIGlmICghcXVlcnkpIHJldHVybiBbXTtcbiAgY29uc3QgbSA9IC8oPzpefFs/Jl0pcmVsPShbXiZdKikvLmV4ZWMocXVlcnkpO1xuICBpZiAoIW0pIHJldHVybiBbXTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgcmF3IG9mIGRlY29kZVVSSUNvbXBvbmVudChtWzFdID8/IFwiXCIpLnNwbGl0KFwiLFwiKSkge1xuICAgIGNvbnN0IHJlbCA9IHJhdy50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgICBpZiAocmVsID09PSBcIlwiIHx8IHNlZW4uaGFzKHJlbCkpIGNvbnRpbnVlO1xuICAgIHNlZW4uYWRkKHJlbCk7XG4gICAgb3V0LnB1c2gocmVsKTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vKiogU3BsaXQgYSB3cml0dGVuIHRhcmdldCBpbnRvIGl0cyBwYXRoLCBpdHMgcXVlcnkgYW5kIGl0cyBhbmNob3IuICovXG5leHBvcnQgZnVuY3Rpb24gc3BsaXRUYXJnZXQocmF3OiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgcXVlcnk/OiBzdHJpbmc7IGFuY2hvcj86IHN0cmluZyB9IHtcbiAgY29uc3QgaGFzaCA9IHJhdy5pbmRleE9mKFwiI1wiKTtcbiAgY29uc3Qgd2l0aG91dEFuY2hvciA9IGhhc2ggPT09IC0xID8gcmF3IDogcmF3LnNsaWNlKDAsIGhhc2gpO1xuICBjb25zdCBhbmNob3IgPSBoYXNoID09PSAtMSA/IHVuZGVmaW5lZCA6IHJhdy5zbGljZShoYXNoICsgMSk7XG4gIGNvbnN0IHEgPSB3aXRob3V0QW5jaG9yLmluZGV4T2YoXCI/XCIpO1xuICByZXR1cm4ge1xuICAgIHBhdGg6IChxID09PSAtMSA/IHdpdGhvdXRBbmNob3IgOiB3aXRob3V0QW5jaG9yLnNsaWNlKDAsIHEpKS50cmltKCksXG4gICAgLi4uKHEgPT09IC0xID8ge30gOiB7IHF1ZXJ5OiB3aXRob3V0QW5jaG9yLnNsaWNlKHEgKyAxKSB9KSxcbiAgICAuLi4oYW5jaG9yID8geyBhbmNob3IgfSA6IHt9KSxcbiAgfTtcbn1cblxuY29uc3QgRVhURVJOQUwgPSAvXlthLXpdW2EtejAtOSsuLV0qOi9pO1xuY29uc3QgTURfTElOSyA9IC8oIT8pXFxbKFteXFxdXFxuXSopXFxdXFwoKFteKVxcc10rKSg/OlxccytcIlteXCJdKlwiKT9cXCkvZztcbmNvbnN0IFdJS0lfTElOSyA9IC9cXFtcXFsoW15cXF1cXG5dKylcXF1cXF0vZztcblxuLyoqIEV2ZXJ5IGxpbmsgYSBkb2N1bWVudCdzIEJPRFkgcG9pbnRzIGF0IOKAlCBleHRlcm5hbCB0YXJnZXRzIGFuZCBpbWFnZXMgbGVmdCBvdXQuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdExpbmtzKGJvZHk6IHN0cmluZyk6IExpbmtSZWZbXSB7XG4gIGNvbnN0IHRleHQgPSB3aXRob3V0RmVuY2VzKGJvZHkpO1xuICBjb25zdCBvdXQ6IExpbmtSZWZbXSA9IFtdO1xuICBmb3IgKGNvbnN0IG0gb2YgdGV4dC5tYXRjaEFsbChNRF9MSU5LKSkge1xuICAgIGlmIChtWzFdID09PSBcIiFcIikgY29udGludWU7IC8vIGFuIGltYWdlIGlzIG5vdCBhIGRvY3VtZW50IGxpbmtcbiAgICBjb25zdCByYXcgPSBtWzNdID8/IFwiXCI7XG4gICAgaWYgKEVYVEVSTkFMLnRlc3QocmF3KSB8fCByYXcuc3RhcnRzV2l0aChcIiNcIikpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHsgcGF0aCwgcXVlcnkgfSA9IHNwbGl0VGFyZ2V0KHJhdyk7XG4gICAgaWYgKHBhdGggPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIG91dC5wdXNoKHtcbiAgICAgIGtpbmQ6IFwibWFya2Rvd25cIixcbiAgICAgIHRhcmdldDogcGF0aCxcbiAgICAgIHJlbDogcGFyc2VSZWwocXVlcnkpLFxuICAgICAgLi4uKG1bMl0gPyB7IGxhYmVsOiBtWzJdIH0gOiB7fSksXG4gICAgfSk7XG4gIH1cbiAgZm9yIChjb25zdCBtIG9mIHRleHQubWF0Y2hBbGwoV0lLSV9MSU5LKSkge1xuICAgIGNvbnN0IGlubmVyID0gbVsxXSA/PyBcIlwiO1xuICAgIGNvbnN0IHBpcGUgPSBpbm5lci5pbmRleE9mKFwifFwiKTtcbiAgICBjb25zdCB0YXJnZXRQYXJ0ID0gcGlwZSA9PT0gLTEgPyBpbm5lciA6IGlubmVyLnNsaWNlKDAsIHBpcGUpO1xuICAgIGNvbnN0IGxhYmVsID0gcGlwZSA9PT0gLTEgPyB1bmRlZmluZWQgOiBpbm5lci5zbGljZShwaXBlICsgMSkudHJpbSgpO1xuICAgIGNvbnN0IHsgcGF0aCwgcXVlcnkgfSA9IHNwbGl0VGFyZ2V0KHRhcmdldFBhcnQpO1xuICAgIGlmIChwYXRoID09PSBcIlwiKSBjb250aW51ZTtcbiAgICBvdXQucHVzaCh7IGtpbmQ6IFwid2lraVwiLCB0YXJnZXQ6IHBhdGgsIHJlbDogcGFyc2VSZWwocXVlcnkpLCAuLi4obGFiZWwgPyB7IGxhYmVsIH0gOiB7fSkgfSk7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIERvZXMgdGhpcyBmcm9udG1hdHRlciB2YWx1ZSBMT09LIGxpa2UgYSBkb2N1bWVudCByZWZlcmVuY2U/ICovXG5leHBvcnQgZnVuY3Rpb24gbG9va3NMaWtlUmVmKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgc3RyaW5nIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIGZhbHNlO1xuICBjb25zdCB2ID0gdmFsdWUudHJpbSgpO1xuICBpZiAodiA9PT0gXCJcIiB8fCBFWFRFUk5BTC50ZXN0KHYpKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiB2LmluY2x1ZGVzKFwiL1wiKSB8fCB2LnRvTG93ZXJDYXNlKCkuZW5kc1dpdGgoXCIubWRcIik7XG59XG5cbi8qKlxuICogUmVmZXJlbmNlcyBpbnNpZGUgZnJvbnRtYXR0ZXIsIHdoYXRldmVyIGtleSBjYXJyaWVzIHRoZW0g4oCUIGByZWxhdGVkYCxcbiAqIGBzdXBlcnNlZGVzYCwgYHNvdXJjZXNbXS5yZXNvdXJjZWAsIG9yIGEga2V5IGludmVudGVkIHRvbW9ycm93LiBUaGUgU0hBUEVcbiAqIGRlY2lkZXMgKGEgc2xhc2ggb3IgYSBgLm1kYCksIHdoaWNoIGlzIHdoeSBiYXJlIGB0YWdzYCBhcmUgbm90IHJlZmVyZW5jZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaWVsZFJlZnMoZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgbWF4RGVwdGggPSA0KTogRmllbGRSZWZbXSB7XG4gIGNvbnN0IG91dDogRmllbGRSZWZbXSA9IFtdO1xuICBjb25zdCB3YWxrID0gKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgZGVwdGg6IG51bWJlcikgPT4ge1xuICAgIGlmIChkZXB0aCA+IG1heERlcHRoKSByZXR1cm47XG4gICAgaWYgKGxvb2tzTGlrZVJlZih2YWx1ZSkpIG91dC5wdXNoKHsga2V5LCB2YWx1ZTogdmFsdWUudHJpbSgpIH0pO1xuICAgIGVsc2UgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSBmb3IgKGNvbnN0IHYgb2YgdmFsdWUpIHdhbGsoa2V5LCB2LCBkZXB0aCArIDEpO1xuICAgIGVsc2UgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIilcbiAgICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSlcbiAgICAgICAgd2FsayhgJHtrZXl9LiR7a31gLCB2LCBkZXB0aCArIDEpO1xuICB9O1xuICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhmaWVsZHMpKSB3YWxrKGssIHYsIDApO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogV2hlcmUgYSB0YXJnZXQgbGFuZGVkLiBgb3V0c2lkZWAgZXhpc3RzIG9uIGRpc2sgYnV0IG5vdCBpbiB0aGlzIGJ1bmRsZS4gKi9cbmV4cG9ydCB0eXBlIFJlc29sdXRpb24gPVxuICB8IHsgc3RhdGU6IFwiaW4tYnVuZGxlXCI7IHBhdGg6IHN0cmluZyB9XG4gIHwgeyBzdGF0ZTogXCJvdXRzaWRlXCI7IHBhdGg6IHN0cmluZyB9XG4gIHwgeyBzdGF0ZTogXCJtaXNzaW5nXCI7IHRyaWVkOiBzdHJpbmcgfTtcblxuZXhwb3J0IHR5cGUgQnVuZGxlSW5kZXggPSB7XG4gIC8qKiBUaGUgc2V0J3Mgcm9vdCDigJQgT0tGJ3MgYnVuZGxlLCBhbmQgd2hhdCBhIGAvYC10YXJnZXQgaXMgcmVsYXRpdmUgdG8uICovXG4gIHJvb3Q6IHN0cmluZztcbiAgLyoqIEFic29sdXRlIHBhdGhzIG9mIGV2ZXJ5IGRvY3VtZW50IGluIHRoZSBidW5kbGUuICovXG4gIHBhdGhzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIEEgZG9jdW1lbnQncyBwYXJzZWQgZnJvbnRtYXR0ZXIsIGZvciBgdHlwZS9zbHVnYCByZXNvbHV0aW9uLiAqL1xuICBtZXRhT2Y6IChwYXRoOiBzdHJpbmcpID0+IERvY01ldGEgfCBudWxsO1xuICAvKiogRG9lcyB0aGlzIHBhdGggZXhpc3Qgb24gZGlzaz8gKEluamVjdGVkLCBzbyB0aGUgcmVzb2x2ZXIgc3RheXMgcHVyZS4pICovXG4gIGV4aXN0czogKHBhdGg6IHN0cmluZykgPT4gYm9vbGVhbjtcbiAgLyoqXG4gICAqIFRoZSBnaXQgd29ya2luZyB0cmVlIHRoZSBidW5kbGUgc2l0cyBpbiwgd2hlbiB0aGVyZSBpcyBvbmUuIEEgdGhpcmQgcGxhY2VcbiAgICogYW4gdW5hbmNob3JlZCBwYXRoIGlzIHRyaWVkOiBwZG9jcyB3cml0ZXMgcmVwby1yZWxhdGl2ZSBwYXRoc1xuICAgKiAoYGRvY3MvcGxheWJvb2tzL2Zvby5tZGApIGFuZCB0aGUgd2lraSdzIHJ1bGUgcGFnZXMgY2FycnkgcmVwby1yZWxhdGl2ZVxuICAgKiBgY2hlY2tlcjpgIHZhbHVlcywgYW5kIG5laXRoZXIgcmVzb2x2ZXMgZnJvbSB0aGUgZG9jdW1lbnQgb3IgdGhlIGJ1bmRsZS5cbiAgICovXG4gIHJlcG9Sb290Pzogc3RyaW5nIHwgbnVsbDtcbn07XG5cbmNvbnN0IHN0ZW0gPSAocDogc3RyaW5nKSA9PiBiYXNlbmFtZShwLCBleHRuYW1lKHApKTtcblxuLyoqXG4gKiBSZXNvbHZlIG9uZSB3cml0dGVuIHRhcmdldCBhZ2FpbnN0IHRoZSBidW5kbGUuXG4gKlxuICogRm91ciBmb3JtcywgaW4gb3JkZXI6IGEgYnVuZGxlLXJlbGF0aXZlIHBhdGggKGAveC95Lm1kYCksIGEgcmVsYXRpdmUgcGF0aFxuICogKGAuL3kubWRgLCBgLi4veC95Lm1kYCksIGEgYHR5cGUvc2x1Z2Aga2V5IOKAlCBwZG9jcycgYW5kIHRoZSB3aWtpJ3Mgb3duIGZvcm0sXG4gKiB3aGljaCByZXNvbHZlcyBieSBUWVBFIGFuZCBCQVNFTkFNRSBzbyBhIHBhZ2UgY2FuIG1vdmUgZm9sZGVycyB3aXRob3V0XG4gKiBicmVha2luZyBpbmJvdW5kIHJlZmVyZW5jZXMg4oCUIGFuZCBhIGJhcmUgbmFtZSAoYSB3aWtpIGxpbmspLCBieSBiYXNlbmFtZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVUYXJnZXQodGFyZ2V0OiBzdHJpbmcsIGZyb206IHN0cmluZywgaW5kZXg6IEJ1bmRsZUluZGV4KTogUmVzb2x1dGlvbiB7XG4gIC8vIOKblCBXSEFUIE1BS0VTIEEgVEFSR0VUIEEgUEFUSCBSQVRIRVIgVEhBTiBBIEtFWSwgYW5kIHRoZSBjYXNlIHRoYXQgdGF1Z2h0XG4gIC8vIGl0OiBgW3RoZSBsaW50ZXJdKGxpbnQudHMpYCBpbiB0aGUgcmVhbCB3aWtpIGhhcyBubyBgLi9gIGFuZCBpcyBub3QgYSBgLm1kYCxcbiAgLy8gc28gYSBydWxlIGtleWVkIG9uIHRob3NlIHR3byByZWFkIGl0IGFzIGEgTkFNRSBhbmQgcmVwb3J0ZWQgaXQgbWlzc2luZ1xuICAvLyB3aGlsZSB0aGUgZmlsZSBzYXQgcmlnaHQgdGhlcmUuIEEgdGFyZ2V0IGlzIGEgcGF0aCB3aGVuIGl0IGlzIGFuY2hvcmVkXG4gIC8vIChgL2AsIGAuL2AsIGAuLi9gKSBvciBjYXJyaWVzIEFOWSBleHRlbnNpb247IGBjb25jZXB0L2V4aXQtY29kZXNgIGhhc1xuICAvLyBuZWl0aGVyLCB3aGljaCBpcyB3aGF0IGtlZXBzIGEgYHR5cGUvc2x1Z2Aga2V5IGEga2V5LlxuICBjb25zdCBsb29rc1BhdGggPVxuICAgIHRhcmdldC5zdGFydHNXaXRoKFwiL1wiKSB8fFxuICAgIHRhcmdldC5zdGFydHNXaXRoKFwiLi9cIikgfHxcbiAgICB0YXJnZXQuc3RhcnRzV2l0aChcIi4uL1wiKSB8fFxuICAgIGV4dG5hbWUodGFyZ2V0KSAhPT0gXCJcIjtcbiAgaWYgKGxvb2tzUGF0aCkge1xuICAgIC8vIEFuIFVOQU5DSE9SRUQgcGF0aCAoYHNyYy9hY2Mva2l0L3gudHNgLCBgcmVwb3J0cy9hLm1kYCDigJQgbm8gYC4vYCBhbmQgbm9cbiAgICAvLyBsZWFkaW5nIGAvYCkgaXMgYW1iaWd1b3VzOiByZWxhdGl2ZSB0byB0aGUgZG9jdW1lbnQsIG9yIHRvIHRoZSBidW5kbGU/XG4gICAgLy8gQm90aCBhcmUgdHJpZWQsIGRvY3VtZW50IGZpcnN0LiBNZWFzdXJlZCBvbiB0aGUgcmVhbCB3aWtpLCB3aGVyZSBhIHJ1bGVcbiAgICAvLyBwYWdlJ3MgYGNoZWNrZXI6IHNyYy9hY2Mva2l0L2NoZWNrZXJzL+KApmAgd2FzIHJlcG9ydGVkIG1pc3Npbmcgd2hpbGVcbiAgICAvLyByZXNvbHZpbmcgZnJvbSB0aGUgYnVuZGxlIHJvb3Qgd291bGQgaGF2ZSBmb3VuZCBpdC5cbiAgICBjb25zdCBhbmNob3JlZCA9IHRhcmdldC5zdGFydHNXaXRoKFwiL1wiKSB8fCB0YXJnZXQuc3RhcnRzV2l0aChcIi4vXCIpIHx8IHRhcmdldC5zdGFydHNXaXRoKFwiLi4vXCIpO1xuICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSB0YXJnZXQuc3RhcnRzV2l0aChcIi9cIilcbiAgICAgID8gW25vcm1hbGl6ZShqb2luKGluZGV4LnJvb3QsIHRhcmdldCkpXVxuICAgICAgOiBhbmNob3JlZFxuICAgICAgICA/IFtub3JtYWxpemUocmVzb2x2ZVBhdGgoZGlybmFtZShmcm9tKSwgdGFyZ2V0KSldXG4gICAgICAgIDogW1xuICAgICAgICAgICAgbm9ybWFsaXplKHJlc29sdmVQYXRoKGRpcm5hbWUoZnJvbSksIHRhcmdldCkpLFxuICAgICAgICAgICAgbm9ybWFsaXplKGpvaW4oaW5kZXgucm9vdCwgdGFyZ2V0KSksXG4gICAgICAgICAgICAuLi4oaW5kZXgucmVwb1Jvb3QgPyBbbm9ybWFsaXplKGpvaW4oaW5kZXgucmVwb1Jvb3QsIHRhcmdldCkpXSA6IFtdKSxcbiAgICAgICAgICBdO1xuICAgIGNvbnN0IHRyaWVkID0gY2FuZGlkYXRlcy5tYXAoKGMpID0+IChleHRuYW1lKGMpID09PSBcIlwiID8gYCR7Y30ubWRgIDogYykpO1xuICAgIGZvciAoY29uc3QgYyBvZiB0cmllZCkgaWYgKGluZGV4LnBhdGhzLmluY2x1ZGVzKGMpKSByZXR1cm4geyBzdGF0ZTogXCJpbi1idW5kbGVcIiwgcGF0aDogYyB9O1xuICAgIGZvciAoY29uc3QgYyBvZiB0cmllZCkgaWYgKGluZGV4LmV4aXN0cyhjKSkgcmV0dXJuIHsgc3RhdGU6IFwib3V0c2lkZVwiLCBwYXRoOiBjIH07XG4gICAgcmV0dXJuIHsgc3RhdGU6IFwibWlzc2luZ1wiLCB0cmllZDogdHJpZWRbMF0gYXMgc3RyaW5nIH07XG4gIH1cbiAgY29uc3Qgc2xhc2ggPSB0YXJnZXQuaW5kZXhPZihcIi9cIik7XG4gIGlmIChzbGFzaCA+IDApIHtcbiAgICAvLyBgdHlwZS9zbHVnYDogdGhlIHR5cGUgaXMgYSBjbGFpbSB0aGUgdGFyZ2V0J3Mgb3duIGZyb250bWF0dGVyIG11c3QgbWFrZS5cbiAgICBjb25zdCB0eXBlID0gdGFyZ2V0LnNsaWNlKDAsIHNsYXNoKTtcbiAgICBjb25zdCBzbHVnID0gdGFyZ2V0LnNsaWNlKHNsYXNoICsgMSk7XG4gICAgZm9yIChjb25zdCBwIG9mIGluZGV4LnBhdGhzKVxuICAgICAgaWYgKHN0ZW0ocCkgPT09IHNsdWcgJiYgaW5kZXgubWV0YU9mKHApPy50eXBlID09PSB0eXBlKVxuICAgICAgICByZXR1cm4geyBzdGF0ZTogXCJpbi1idW5kbGVcIiwgcGF0aDogcCB9O1xuICB9XG4gIGNvbnN0IGhpdCA9IGluZGV4LnBhdGhzLmZpbmQoKHApID0+IHN0ZW0ocCkgPT09IHN0ZW0odGFyZ2V0KSk7XG4gIGlmIChoaXQpIHJldHVybiB7IHN0YXRlOiBcImluLWJ1bmRsZVwiLCBwYXRoOiBoaXQgfTtcbiAgcmV0dXJuIHsgc3RhdGU6IFwibWlzc2luZ1wiLCB0cmllZDogdGFyZ2V0IH07XG59XG5cbi8qKiBBbiBlZGdlIGluIGEgc2V0J3MgbWFwLiBgcmVsYCBlbXB0eSBtZWFucyBubyBhc3NlcnRpb24gd2FzIG1hZGUuICovXG5leHBvcnQgdHlwZSBFZGdlID0ge1xuICBmcm9tOiBzdHJpbmc7XG4gIC8qKiBBYnNvbHV0ZSBwYXRoIHdoZW4gcmVzb2x2ZWQ7IHRoZSB3cml0dGVuIHRhcmdldCB3aGVuIG5vdC4gKi9cbiAgdG86IHN0cmluZztcbiAgLyoqIEEgYm9keSBsaW5rLCBvciBhIGZyb250bWF0dGVyIHZhbHVlIOKAlCBrZXB0IGFwYXJ0LCBhcyBwZG9jcyBrZWVwcyB0aGVtLiAqL1xuICBzb3VyY2U6IFwibGlua1wiIHwgXCJmcm9udG1hdHRlclwiO1xuICAvKiogVGhlIGZyb250bWF0dGVyIGtleSB0aGF0IGNhcnJpZWQgaXQgKGByZWxhdGVkYCwgYHNvdXJjZXMucmVzb3VyY2VgLCDigKYpLiAqL1xuICBrZXk/OiBzdHJpbmc7XG4gIHJlbDogc3RyaW5nW107XG4gIHN0YXRlOiBSZXNvbHV0aW9uW1wic3RhdGVcIl07XG59O1xuXG5leHBvcnQgdHlwZSBHcmFwaE5vZGUgPSB7XG4gIHBhdGg6IHN0cmluZztcbiAgcmVsOiBzdHJpbmc7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIHR5cGU/OiBzdHJpbmc7XG4gIHN0YXR1czogc3RyaW5nO1xuICBzdGFsZTogYm9vbGVhbjtcbiAgdGFnczogc3RyaW5nW107XG4gIGxpbmtzT3V0OiBudW1iZXI7XG4gIGxpbmtzSW46IG51bWJlcjtcbn07XG5cbmV4cG9ydCB0eXBlIEdyYXBoID0ge1xuICByb290OiBzdHJpbmc7XG4gIG5vZGVzOiBHcmFwaE5vZGVbXTtcbiAgZWRnZXM6IEVkZ2VbXTtcbiAgLyoqIFRhcmdldHMgbm90aGluZyBpbiB0aGUgYnVuZGxlIGFuc3dlcnMg4oCUIHNhaWQsIG5ldmVyIGFuIGVycm9yIChPS0YgwqcxMSkuICovXG4gIGRhbmdsaW5nOiBudW1iZXI7XG59O1xuXG4vKiogQnVpbGQgYSBzZXQncyBtYXA6IG5vZGVzIGFyZSBpdHMgZG9jdW1lbnRzLCBlZGdlcyBhcmUgdGhlIGZvdXIgc291cmNlcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEdyYXBoKGluZGV4OiBCdW5kbGVJbmRleCwgYm9keU9mOiAocGF0aDogc3RyaW5nKSA9PiBzdHJpbmcsIGNhcCA9IDQwMCk6IEdyYXBoIHtcbiAgY29uc3QgcGF0aHMgPSBpbmRleC5wYXRocy5zbGljZSgwLCBjYXApO1xuICBjb25zdCBlZGdlczogRWRnZVtdID0gW107XG4gIGZvciAoY29uc3QgZnJvbSBvZiBwYXRocykge1xuICAgIGNvbnN0IG1ldGEgPSBpbmRleC5tZXRhT2YoZnJvbSk7XG4gICAgZm9yIChjb25zdCBsaW5rIG9mIGV4dHJhY3RMaW5rcyhib2R5T2YoZnJvbSkpKSB7XG4gICAgICBjb25zdCByID0gcmVzb2x2ZVRhcmdldChsaW5rLnRhcmdldCwgZnJvbSwgaW5kZXgpO1xuICAgICAgZWRnZXMucHVzaCh7XG4gICAgICAgIGZyb20sXG4gICAgICAgIHRvOiByLnN0YXRlID09PSBcIm1pc3NpbmdcIiA/IHIudHJpZWQgOiByLnBhdGgsXG4gICAgICAgIHNvdXJjZTogXCJsaW5rXCIsXG4gICAgICAgIHJlbDogbGluay5yZWwsXG4gICAgICAgIHN0YXRlOiByLnN0YXRlLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgcmVmIG9mIG1ldGEgPyBmaWVsZFJlZnMobWV0YS5maWVsZHMpIDogW10pIHtcbiAgICAgIGNvbnN0IHIgPSByZXNvbHZlVGFyZ2V0KHJlZi52YWx1ZSwgZnJvbSwgaW5kZXgpO1xuICAgICAgZWRnZXMucHVzaCh7XG4gICAgICAgIGZyb20sXG4gICAgICAgIHRvOiByLnN0YXRlID09PSBcIm1pc3NpbmdcIiA/IHIudHJpZWQgOiByLnBhdGgsXG4gICAgICAgIHNvdXJjZTogXCJmcm9udG1hdHRlclwiLFxuICAgICAgICBrZXk6IHJlZi5rZXksXG4gICAgICAgIHJlbDogW10sXG4gICAgICAgIHN0YXRlOiByLnN0YXRlLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG4gIGNvbnN0IG91dE9mID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgY29uc3QgaW50b09mID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgZm9yIChjb25zdCBlIG9mIGVkZ2VzKSB7XG4gICAgb3V0T2Yuc2V0KGUuZnJvbSwgKG91dE9mLmdldChlLmZyb20pID8/IDApICsgMSk7XG4gICAgaWYgKGUuc3RhdGUgPT09IFwiaW4tYnVuZGxlXCIpIGludG9PZi5zZXQoZS50bywgKGludG9PZi5nZXQoZS50bykgPz8gMCkgKyAxKTtcbiAgfVxuICBjb25zdCBub2RlczogR3JhcGhOb2RlW10gPSBwYXRocy5tYXAoKHBhdGgpID0+IHtcbiAgICBjb25zdCBtZXRhID0gaW5kZXgubWV0YU9mKHBhdGgpO1xuICAgIHJldHVybiB7XG4gICAgICBwYXRoLFxuICAgICAgcmVsOiB0b1Bvc2l4KHJlbGF0aXZlKGluZGV4LnJvb3QsIHBhdGgpKSxcbiAgICAgIHRpdGxlOiBtZXRhPy50aXRsZSA/PyBzdGVtKHBhdGgpLFxuICAgICAgLi4uKG1ldGE/LnR5cGUgPyB7IHR5cGU6IG1ldGEudHlwZSB9IDoge30pLFxuICAgICAgc3RhdHVzOiBtZXRhPy5zdGF0dXMgPz8gXCJzdGFibGVcIixcbiAgICAgIHN0YWxlOiBtZXRhPy5zdGFsZSA/PyBmYWxzZSxcbiAgICAgIHRhZ3M6IG1ldGE/LnRhZ3MgPz8gW10sXG4gICAgICBsaW5rc091dDogb3V0T2YuZ2V0KHBhdGgpID8/IDAsXG4gICAgICBsaW5rc0luOiBpbnRvT2YuZ2V0KHBhdGgpID8/IDAsXG4gICAgfTtcbiAgfSk7XG4gIHJldHVybiB7XG4gICAgcm9vdDogaW5kZXgucm9vdCxcbiAgICBub2RlcyxcbiAgICBlZGdlcyxcbiAgICBkYW5nbGluZzogZWRnZXMuZmlsdGVyKChlKSA9PiBlLnN0YXRlID09PSBcIm1pc3NpbmdcIikubGVuZ3RoLFxuICB9O1xufVxuIiwKICAgICIvKipcbiAqIENvbnRleHQgZW50cmllcyBvbiBkaXNrIOKAlCBidWlsZGluZyBhbiBlbnRyeSBmcm9tIGEgcGF0aCAoRTE1J3Mgb25lIG1vZGVsKSxcbiAqIG1pcnJvcmluZyBhIGZvbGRlciBpbnRvIGEgbm9kZSB0cmVlLCBhbmQgbGlzdGluZyBhIGRpcmVjdG9yeSBmb3IgdGhlXG4gKiBzdXJmYWNlJ3MgcGF0aCBjb21wbGV0aW9uIChgZnMubGlzdGApLlxuICpcbiAqIFB1cmUgb3ZlciB0aGUgZmlsZXN5c3RlbTogbm8gZGFlbW9uIHN0YXRlLCBzbyB0aGUgdW5pdCBjZWxscyBkcml2ZSBpdCB3aXRoIGFcbiAqIHRlbXAgZGlyZWN0b3J5IGFuZCBub3RoaW5nIGVsc2UuXG4gKi9cblxuaW1wb3J0IHsgcmVhZGRpclN5bmMsIHN0YXRTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luLCByZWxhdGl2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBDb250ZXh0RW50cnksIENvbnRleHROb2RlLCBGc0xpc3RFbnRyeSB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKiBXaGF0IHNjcmlwdG9yaXVtIG9wZW5zIGFzIGEgZG9jdW1lbnQuIEV2ZXJ5dGhpbmcgZWxzZSBpcyBub3Qgc2hvd24uICovXG5leHBvcnQgY29uc3QgRE9DX0VYVEVOU0lPTlMgPSBbXCIubWRcIiwgXCIubWFya2Rvd25cIiwgXCIubWR4XCIsIFwiLnR4dFwiXSBhcyBjb25zdDtcblxuZXhwb3J0IGZ1bmN0aW9uIGlzRG9jTmFtZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgbG93ZXIgPSBuYW1lLnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiBET0NfRVhURU5TSU9OUy5zb21lKChleHQpID0+IGxvd2VyLmVuZHNXaXRoKGV4dCkpO1xufVxuXG4vKiogRGlyZWN0b3JpZXMgYSBtaXJyb3IgbmV2ZXIgZGVzY2VuZHMgaW50byDigJQgbm9pc2UsIG5vdCBkb2N1bWVudHMuICovXG5jb25zdCBTS0lQX0RJUlMgPSBuZXcgU2V0KFtcIm5vZGVfbW9kdWxlc1wiLCBcIi5naXRcIiwgXCJkaXN0XCIsIFwib3V0XCIsIFwiY292ZXJhZ2VcIl0pO1xuXG4vKipcbiAqIFRoZSBtb3N0IG5vZGVzIG9uZSBtaXJyb3JlZCBzY2FuIHdpbGwgaG9sZC4gQSBmb2xkZXIgZW50cnkgcG9pbnRlZCBhdCBhIGh1Z2VcbiAqIHRyZWUgbXVzdCBub3Qgc3RhbGwgdGhlIGRhZW1vbiBvciBmbG9vZCBldmVyeSBzdGF0ZSBicm9hZGNhc3Q7IGhpdHRpbmcgdGhlXG4gKiBjYXAgc2V0cyBgdHJ1bmNhdGVkYCBvbiB0aGUgZW50cnkgc28gdGhlIHN1cmZhY2UgY2FuIFNBWSB0aGUgbGlzdCBpcyBzaG9ydFxuICogcmF0aGVyIHRoYW4gcmVuZGVyIGEgc2hvcnQgbGlzdCBhcyBhIGNvbXBsZXRlIG9uZS5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JUlJPUl9OT0RFX0NBUCA9IDIwMDA7XG5cbmV4cG9ydCBjb25zdCB0b1Bvc2l4ID0gKHA6IHN0cmluZykgPT4gcC5zcGxpdChzZXApLmpvaW4oXCIvXCIpO1xuXG4vKipcbiAqIE1pcnJvciBgcm9vdGAgaW50byBhIHNvcnRlZCBub2RlIHRyZWU6IGdyb3VwcyBmaXJzdCwgdGhlbiBkb2NzLCBieSBuYW1lLlxuICogYGhpZGRlbmAgcmVscyAoRTI0J3MgXCJSZW1vdmUgZnJvbSBTY3JpcHRvcml1bVwiKSBhcmUgc2tpcHBlZCwgYSBmb2xkZXIgd2l0aFxuICogZXZlcnl0aGluZyB1bmRlciBpdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjYW5UcmVlKFxuICByb290OiBzdHJpbmcsXG4gIGNhcCA9IE1JUlJPUl9OT0RFX0NBUCxcbiAgaGlkZGVuOiByZWFkb25seSBzdHJpbmdbXSA9IFtdLFxuKTogeyBub2RlczogQ29udGV4dE5vZGVbXTsgdHJ1bmNhdGVkOiBib29sZWFuIH0ge1xuICBsZXQgY291bnQgPSAwO1xuICBsZXQgdHJ1bmNhdGVkID0gZmFsc2U7XG4gIGNvbnN0IHNraXAgPSBuZXcgU2V0KGhpZGRlbik7XG4gIGNvbnN0IHdhbGsgPSAoZGlyOiBzdHJpbmcpOiBDb250ZXh0Tm9kZVtdID0+IHtcbiAgICBsZXQgbmFtZXM6IHN0cmluZ1tdO1xuICAgIHRyeSB7XG4gICAgICBuYW1lcyA9IHJlYWRkaXJTeW5jKGRpcik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICAgIGNvbnN0IGdyb3VwczogQ29udGV4dE5vZGVbXSA9IFtdO1xuICAgIGNvbnN0IGRvY3M6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMuc29ydCgoYSwgYikgPT4gYS5sb2NhbGVDb21wYXJlKGIpKSkge1xuICAgICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNvdW50ID49IGNhcCkge1xuICAgICAgICB0cnVuY2F0ZWQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgcmVsID0gdG9Qb3NpeChyZWxhdGl2ZShyb290LCBhYnMpKTtcbiAgICAgIGlmIChza2lwLmhhcyhyZWwpKSBjb250aW51ZTtcbiAgICAgIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICAgIGlmIChTS0lQX0RJUlMuaGFzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgY29uc3QgY2hpbGRyZW4gPSB3YWxrKGFicyk7XG4gICAgICAgIC8vIEEgZm9sZGVyIGhvbGRpbmcgb25seSBub24tZG9jdW1lbnRzIChpbWFnZXMsIGFzc2V0cykgaXMgbm9pc2UgaW4gYVxuICAgICAgICAvLyBkb2NzIG1pcnJvciBhbmQgaXMgbGVmdCBvdXQuIEEgVFJVTFkgRU1QVFkgZm9sZGVyIGlzIGtlcHQ6IGl0IGlzIG9uZVxuICAgICAgICAvLyBzb21lYm9keSBqdXN0IG1hZGUgdG8gcHV0IGRvY3VtZW50cyBpbiAoXCJOZXcgZm9sZGVyXCIsIEUyNCksIGFuZFxuICAgICAgICAvLyBsZWF2aW5nIGl0IG91dCBtYWRlIGl0IHZhbmlzaCB0aGUgbW9tZW50IGl0IHdhcyBjcmVhdGVkLlxuICAgICAgICBpZiAoY2hpbGRyZW4ubGVuZ3RoID4gMCB8fCBpc0VtcHR5RGlyKGFicykpIGdyb3Vwcy5wdXNoKHsga2luZDogXCJncm91cFwiLCByZWwsIGNoaWxkcmVuIH0pO1xuICAgICAgfSBlbHNlIGlmIChzdC5pc0ZpbGUoKSAmJiBpc0RvY05hbWUobmFtZSkpIHtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgZG9jcy5wdXNoKHsga2luZDogXCJkb2NcIiwgcmVsIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gWy4uLmdyb3VwcywgLi4uZG9jc107XG4gIH07XG4gIGNvbnN0IG5vZGVzID0gd2Fsayhyb290KTtcbiAgcmV0dXJuIHsgbm9kZXMsIHRydW5jYXRlZCB9O1xufVxuXG4vKiogTm90aGluZyBpbiBpdCBidXQgZG90ZmlsZXMgKGEgYC5EU19TdG9yZWAgZG9lcyBub3QgbWFrZSBhIGZvbGRlciBmdWxsKS4gKi9cbmZ1bmN0aW9uIGlzRW1wdHlEaXIoZGlyOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhZGRpclN5bmMoZGlyKS5ldmVyeSgobikgPT4gbi5zdGFydHNXaXRoKFwiLlwiKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKiogVGhlIG5vZGUgYXQgYHJlbGAgaW4gYSB0cmVlLCBvciB1bmRlZmluZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZE5vZGUobm9kZXM6IHJlYWRvbmx5IENvbnRleHROb2RlW10sIHJlbDogc3RyaW5nKTogQ29udGV4dE5vZGUgfCB1bmRlZmluZWQge1xuICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICBpZiAobi5yZWwgPT09IHJlbCkgcmV0dXJuIG47XG4gICAgaWYgKG4ua2luZCA9PT0gXCJncm91cFwiICYmIHJlbC5zdGFydHNXaXRoKGAke24ucmVsfS9gKSkgcmV0dXJuIGZpbmROb2RlKG4uY2hpbGRyZW4sIHJlbCk7XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGNsYXNzIFBhdGhFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgbWVzc2FnZTogc3RyaW5nLFxuICAgIHJlYWRvbmx5IGNvZGU6IFwibWlzc2luZ1wiIHwgXCJub3QtYS1kb2NcIixcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gIH1cbn1cblxuLyoqXG4gKiBBbiBlbnRyeSBmb3IgYW4gYWJzb2x1dGUgcGF0aC4gQSBkaXJlY3RvcnkgaXMgYG1pcnJvcmVkYDsgYSBkb2N1bWVudCBmaWxlIGlzXG4gKiBgbGlzdGVkYCwgcm9vdGVkIGF0IGl0cyBwYXJlbnQsIGhvbGRpbmcgb25seSBpdHNlbGYgKEUxNSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbnRyeUZvclBhdGgoYWJzOiBzdHJpbmcsIGlkOiBzdHJpbmcpOiBDb250ZXh0RW50cnkge1xuICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgdHJ5IHtcbiAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoYG5vIHN1Y2ggZmlsZSBvciBmb2xkZXI6ICR7YWJzfWAsIFwibWlzc2luZ1wiKTtcbiAgfVxuICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgIGNvbnN0IHsgbm9kZXMsIHRydW5jYXRlZCB9ID0gc2NhblRyZWUoYWJzKTtcbiAgICByZXR1cm4ge1xuICAgICAgaWQsXG4gICAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSB8fCBhYnMsXG4gICAgICByb290OiBhYnMsXG4gICAgICBtZW1iZXJzaGlwOiBcIm1pcnJvcmVkXCIsXG4gICAgICBub2RlcyxcbiAgICAgIC4uLih0cnVuY2F0ZWQgPyB7IHRydW5jYXRlZCB9IDoge30pLFxuICAgIH07XG4gIH1cbiAgaWYgKCFpc0RvY05hbWUoYWJzKSkge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoXG4gICAgICBgbm90IGEgZG9jdW1lbnQgc2NyaXB0b3JpdW0gb3BlbnMgKCR7RE9DX0VYVEVOU0lPTlMuam9pbihcIiBcIil9KTogJHthYnN9YCxcbiAgICAgIFwibm90LWEtZG9jXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIGxhYmVsOiBiYXNlbmFtZShhYnMpLFxuICAgIHJvb3Q6IGRpcm5hbWUoYWJzKSxcbiAgICBtZW1iZXJzaGlwOiBcImxpc3RlZFwiLFxuICAgIG5vZGVzOiBbeyBraW5kOiBcImRvY1wiLCByZWw6IGJhc2VuYW1lKGFicykgfV0sXG4gIH07XG59XG5cbi8qKiBFdmVyeSBkb2Mgbm9kZSdzIGFic29sdXRlIHBhdGgsIGRlcHRoLWZpcnN0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRvY1BhdGhzKGVudHJ5OiBDb250ZXh0RW50cnkpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgd2FsayA9IChub2RlczogQ29udGV4dE5vZGVbXSkgPT4ge1xuICAgIGZvciAoY29uc3QgbiBvZiBub2Rlcykge1xuICAgICAgaWYgKG4ua2luZCA9PT0gXCJkb2NcIikgb3V0LnB1c2goam9pbihlbnRyeS5yb290LCBuLnJlbCkpO1xuICAgICAgZWxzZSB3YWxrKG4uY2hpbGRyZW4pO1xuICAgIH1cbiAgfTtcbiAgd2FsayhlbnRyeS5ub2Rlcyk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBXaGljaCBlbnRyeSAoaWYgYW55KSBob2xkcyBgYWJzYCwgYW5kIGF0IHdoYXQgYHJlbGAuICovXG5leHBvcnQgZnVuY3Rpb24gbG9jYXRlKFxuICBlbnRyaWVzOiBDb250ZXh0RW50cnlbXSxcbiAgYWJzOiBzdHJpbmcsXG4pOiB7IGVudHJ5SWQ6IHN0cmluZzsgcmVsOiBzdHJpbmcgfSB8IG51bGwge1xuICBmb3IgKGNvbnN0IGUgb2YgZW50cmllcykge1xuICAgIGlmIChkb2NQYXRocyhlKS5pbmNsdWRlcyhhYnMpKSByZXR1cm4geyBlbnRyeUlkOiBlLmlkLCByZWw6IHRvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKSB9O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIE9uZSBkaXJlY3RvcnksIGZvciB0aGUgc3VyZmFjZSdzIGFkZC1ieS1wYXRoIGNvbXBsZXRpb246IHN1YmRpcmVjdG9yaWVzIGFuZFxuICogZG9jdW1lbnRzIG9ubHksIGRpcmVjdG9yaWVzIGZpcnN0LiBgfmAgaXMgZXhwYW5kZWQgYnkgdGhlIGNhbGxlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxpc3REaXIoZGlyOiBzdHJpbmcpOiBGc0xpc3RFbnRyeVtdIHtcbiAgY29uc3QgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICBjb25zdCBvdXQ6IEZzTGlzdEVudHJ5W10gPSBbXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzKSB7XG4gICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICBsZXQgaXNEaXIgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgaXNEaXIgPSBzdGF0U3luYyhhYnMpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGlzRGlyIHx8IGlzRG9jTmFtZShuYW1lKSkgb3V0LnB1c2goeyBuYW1lLCBwYXRoOiBhYnMsIGRpcjogaXNEaXIgfSk7XG4gIH1cbiAgcmV0dXJuIG91dC5zb3J0KChhLCBiKSA9PiAoYS5kaXIgPT09IGIuZGlyID8gYS5uYW1lLmxvY2FsZUNvbXBhcmUoYi5uYW1lKSA6IGEuZGlyID8gLTEgOiAxKSk7XG59XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7O0FBcURBLHlCQUF5QiwyQkFBYyx5QkFBVTtBQUNqRCxvQkFBUztBQUNULHFCQUFTLHNCQUFVLHdCQUFTLHFCQUFZLGtCQUFNO0FBQzlDO0FBQ0Esc0JBQVM7OztBQzNDVDtBQXFCTyxTQUFTLGVBQWUsQ0FBQyxRQUFnQixNQUFvQjtBQUFBLEVBQ2xFLE1BQU0sTUFBTSxHQUFHLFVBQVUsUUFBUTtBQUFBLEVBQ2pDLElBQUk7QUFBQSxJQUNGLGNBQWMsS0FBSyxJQUFJO0FBQUEsSUFDdkIsV0FBVyxLQUFLLE1BQU07QUFBQSxJQUN0QixPQUFPLEtBQUs7QUFBQSxJQUNaLElBQUk7QUFBQSxNQUNGLE9BQU8sS0FBSyxFQUFFLE9BQU8sS0FBSyxDQUFDO0FBQUEsTUFDM0IsTUFBTTtBQUFBLElBR1IsTUFBTTtBQUFBO0FBQUE7QUFxQkgsU0FBUyxlQUFlLENBQzdCLE1BQ0EsVUFDQSxXQUEyQyxDQUFDLFFBQVEsSUFBSSxLQUFLLEdBQ3BEO0FBQUEsRUFDVCxJQUFJO0FBQUEsSUFDRixJQUFJLENBQUMsV0FBVyxJQUFJO0FBQUEsTUFBRyxPQUFPO0FBQUEsSUFDOUIsSUFBSSxTQUFTLGFBQWEsTUFBTSxNQUFNLENBQUMsTUFBTTtBQUFBLE1BQVUsT0FBTztBQUFBLElBQzlELFdBQVcsSUFBSTtBQUFBLElBQ2YsT0FBTztBQUFBLElBQ1AsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBO0FBQUE7OztBQytCSixJQUFNLHFCQUFxQjtBQTJCM0IsU0FBUyxjQUFnQyxDQUM5QyxPQUFnRCxDQUFDLEdBQ3BDO0FBQUEsRUFDYixNQUFNLGFBQWEs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USxFQUFFLFVBQVUsT0FBTyxDQUFDLEVBQUUsQ0FBQztBQUFBLENBQzVGO0FBQUEsSUFDQSxPQUFPLFdBQVcsTUFBTSxJQUFJLFdBQVcsTUFBTSxJQUFJO0FBQUE7QUFBQSxFQUVuRCxRQUFRLE9BQU8sTUFDYixHQUFHLEtBQUssVUFBVSxFQUFFLEtBQUssb0JBQW9CLEVBQUUsUUFBUSxNQUFNLEVBQUUsTUFBTSxZQUFZLEVBQUUsV0FBVyxNQUFNLEVBQUUsTUFBTSxLQUFLLEVBQUUsSUFBSSxDQUFDO0FBQUEsQ0FDMUg7QUFBQSxFQUNBLE1BQU0sTUFBTSxNQUFNLEVBQUU7QUFBQSxFQUNwQixNQUFNLEVBQUU7QUFBQSxFQUVSLElBQUksSUFBSSxTQUFTLEtBQUssTUFBTSxLQUFLO0FBQUEsSUFDL0IsSUFBSTtBQUFBLE1BQ0YsSUFBSSxVQUFTLE1BQU0sR0FBRyxFQUFFLFNBQVM7QUFBQSxRQUFHLFlBQVcsTUFBTSxHQUFHO0FBQUEsTUFDeEQsTUFBTTtBQUFBLEVBR1Y7QUFBQSxFQUNBLE9BQU8sSUFBSTtBQUFBO0FBUWIsZUFBc0IsR0FBRyxHQUFvQjtBQUFBLEVBQzNDLE9BQU8sTUFBTSxLQUFLLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztBQUFBOyIsCiAgImRlYnVnSWQiOiAiNzMwNUQ5MjFCODY4RjdFNjY0NzU2RTIxNjQ3NTZFMjEiLAogICJuYW1lcyI6IFtdCn0=
