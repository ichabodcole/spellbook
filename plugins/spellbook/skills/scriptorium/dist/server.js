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

// src/scriptorium/backend/anchors.ts
var CONTEXT_CHARS = 48;
var ORPHANED = { from: null, to: null, how: "orphaned" };
function anchorOf(text, from, to) {
  return {
    quote: text.slice(from, to),
    before: text.slice(Math.max(0, from - CONTEXT_CHARS), from),
    after: text.slice(to, to + CONTEXT_CHARS),
    at: from
  };
}
function occurrences(hay, needle) {
  if (needle === "")
    return [];
  const found = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    found.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return found;
}
function findAnchor(text, anchor) {
  if (anchor.quote === "")
    return ORPHANED;
  const withContext = anchor.before + anchor.quote + anchor.after;
  const contexts = occurrences(text, withContext);
  if (contexts.length === 1) {
    const from = contexts[0] + anchor.before.length;
    return { from, to: from + anchor.quote.length, how: "context" };
  }
  const hits = occurrences(text, anchor.quote);
  if (hits.length === 0)
    return ORPHANED;
  if (hits.length === 1) {
    const from = hits[0];
    return { from, to: from + anchor.quote.length, how: "unique" };
  }
  let best = hits[0];
  for (const hit of hits)
    if (Math.abs(hit - anchor.at) < Math.abs(best - anchor.at))
      best = hit;
  return { from: best, to: best + anchor.quote.length, how: "nearest" };
}
function quoteLabel(quote, max = 60) {
  const flat = quote.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}\u2026`;
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
function bodyLineOffset(text) {
  const { body } = splitFrontmatter(text);
  const prefix = text.slice(0, text.length - body.length);
  let lines = 0;
  for (let i = 0;i < prefix.length; i++)
    if (prefix.charCodeAt(i) === 10)
      lines++;
  return lines;
}
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
function decodePath(raw) {
  if (!raw.includes("%"))
    return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
function splitTarget(raw) {
  const hash = raw.indexOf("#");
  const withoutAnchor = hash === -1 ? raw : raw.slice(0, hash);
  const anchor = hash === -1 ? undefined : raw.slice(hash + 1);
  const q = withoutAnchor.indexOf("?");
  return {
    path: decodePath((q === -1 ? withoutAnchor : withoutAnchor.slice(0, q)).trim()),
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
  const lineAt = (at) => {
    let line = 1;
    for (let i = 0;i < at && i < text.length; i++)
      if (text.charCodeAt(i) === 10)
        line++;
    return line;
  };
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
      raw,
      line: lineAt(m.index ?? 0),
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
    out.push({
      kind: "wiki",
      target: path,
      raw: targetPart,
      line: lineAt(m.index ?? 0),
      rel: parseRel(query),
      ...label ? { label } : {}
    });
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
function resolveTarget(rawTarget, from, index) {
  const target = splitTarget(rawTarget).path;
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
        raw: link.raw,
        line: link.line,
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
  activeText(d) {
    return readFileSync3(this.versionPath(d, d.active), "utf8");
  }
  placedNotes(d) {
    const notes = d.notes ?? [];
    if (notes.length === 0)
      return [];
    const text = this.activeText(d);
    return notes.map((n) => ({ ...n, ...findAnchor(text, n) }));
  }
  addNote(opts) {
    const d = this.docOrDie(opts.doc);
    const body = opts.body.trim();
    if (!body)
      throw new SessionError("a note needs something written in it", 400);
    const text = this.activeText(d);
    let anchor;
    if (opts.range) {
      const { from, to } = opts.range;
      if (from < 0 || to > text.length || from >= to)
        throw new SessionError(`${from}..${to} is not a range in v${d.active} of ${d.slug} (${text.length} characters)`, 400);
      anchor = anchorOf(text, from, to);
    } else {
      const quote = opts.quote ?? "";
      if (!quote)
        throw new SessionError("a note needs a selection or a quote", 400);
      const at = text.indexOf(quote);
      if (at === -1)
        throw new SessionError(`v${d.active} of ${d.slug} does not contain that text \u2014 quote it exactly as it appears`, 404);
      anchor = anchorOf(text, at, at + quote.length);
    }
    const note = {
      id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      version: d.active,
      ...anchor,
      body,
      who: opts.who,
      createdAt: Date.now(),
      resolved: false
    };
    d.notes = [...d.notes ?? [], note];
    this.persist();
    return { slug: d.slug, note, how: opts.range ? "selection" : "quote" };
  }
  notesOf(opts) {
    const d = this.docOrDie(opts.doc);
    const placed = this.placedNotes(d);
    return { slug: d.slug, notes: opts.all ? placed : placed.filter((n) => !n.resolved) };
  }
  noteOrDie(d, id) {
    const note = (d.notes ?? []).find((n) => n.id === id);
    if (!note)
      throw new SessionError(`${d.slug} has no note ${id}`, 404, (d.notes ?? []).map((n) => n.id));
    return note;
  }
  editNote(opts) {
    const d = this.docOrDie(opts.doc);
    const note = this.noteOrDie(d, opts.id);
    const body = opts.body.trim();
    if (!body)
      throw new SessionError("a note needs something written in it", 400);
    note.body = body;
    note.editedAt = Date.now();
    this.persist();
    return { slug: d.slug, note };
  }
  resolveNote(opts) {
    const d = this.docOrDie(opts.doc);
    const note = this.noteOrDie(d, opts.id);
    note.resolved = opts.resolved;
    this.persist();
    return { slug: d.slug, note };
  }
  removeNote(opts) {
    const d = this.docOrDie(opts.doc);
    const note = this.noteOrDie(d, opts.id);
    d.notes = (d.notes ?? []).filter((n) => n.id !== opts.id);
    this.persist();
    return { slug: d.slug, note };
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
  startTask(text, who) {
    const body = text.trim();
    if (!body)
      throw new SessionError("a task needs to say what the work is", 400);
    const message = this.addMessage(who, body);
    const task = {
      id: `t-${randHex(4)}`,
      text: body,
      who,
      createdAt: Date.now(),
      messageId: message.id
    };
    this.m.tasks = [...this.m.tasks ?? [], task];
    this.persist();
    return task;
  }
  taskOrDie(id) {
    const task = (this.m.tasks ?? []).find((t) => t.id === id);
    if (!task)
      throw new SessionError(`no task ${id} in this session`, 404, (this.m.tasks ?? []).filter((t) => t.doneAt === undefined).map((t) => t.id));
    return task;
  }
  setTaskStatus(id, status) {
    const task = this.taskOrDie(id);
    if (task.doneAt !== undefined)
      throw new SessionError(`task ${id} is already done \u2014 its status cannot change`, 409);
    task.status = status.trim();
    this.persist();
    return task;
  }
  finishTask(id, outcome) {
    const task = this.taskOrDie(id);
    const already = task.doneAt !== undefined;
    if (!already) {
      task.doneAt = Date.now();
      task.status = undefined;
      if (outcome?.trim())
        task.outcome = outcome.trim();
      this.persist();
    }
    return { task, already };
  }
  removeTask(id) {
    const task = this.taskOrDie(id);
    this.m.tasks = (this.m.tasks ?? []).filter((t) => t.id !== id);
    this.persist();
    return task;
  }
  clearDoneTasks() {
    const before = (this.m.tasks ?? []).length;
    this.m.tasks = (this.m.tasks ?? []).filter((t) => t.doneAt === undefined);
    const cleared = before - (this.m.tasks?.length ?? 0);
    if (cleared > 0)
      this.persist();
    return cleared;
  }
  tasks() {
    return [...this.m.tasks ?? []].sort((a, b) => b.createdAt - a.createdAt);
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
      notes: this.placedNotes(d),
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
  danglingLinks(entryId) {
    const g = this.graphFor(entryId);
    const broken = g.edges.filter((e) => e.state === "missing");
    const offsets = new Map;
    const offsetOf = (path) => {
      const known = offsets.get(path);
      if (known !== undefined)
        return known;
      let off = 0;
      try {
        off = bodyLineOffset(readFileSync3(path, "utf8"));
      } catch {}
      offsets.set(path, off);
      return off;
    };
    return {
      entry: g.entry,
      root: g.root,
      count: broken.length,
      links: broken.map((e) => ({
        from: e.from,
        ...e.line !== undefined ? { line: e.line + offsetOf(e.from) } : {},
        ...e.raw !== undefined ? { wrote: e.raw } : {},
        tried: e.to,
        source: e.source,
        ...e.key ? { key: e.key } : {},
        ...e.rel.length ? { rel: e.rel } : {}
      }))
    };
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
  messages() {
    return this.m.chat;
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
      chat: this.m.chat,
      tasks: this.tasks()
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

// src/scriptorium/backend/waiting.ts
var STALL_MS = 30000;
var DEFAULT_SNOOZE_MS = 120000;
function waitingOn(chat, now, opts = {}) {
  const stallMs = opts.stallMs ?? STALL_MS;
  let pending = null;
  for (let i = chat.length - 1;i >= 0; i--) {
    const m = chat[i];
    if (!m || m.who === "system")
      continue;
    if (m.who === "agent")
      return null;
    pending = m;
    break;
  }
  if (!pending)
    return null;
  let since = pending.ts;
  let messageId = pending.id;
  for (let i = chat.length - 1;i >= 0; i--) {
    const m = chat[i];
    if (!m || m.who === "system")
      continue;
    if (m.who !== "human")
      break;
    since = m.ts;
    messageId = m.id;
  }
  const acknowledged = opts.acknowledgedUntil !== undefined && now < opts.acknowledgedUntil;
  const stalled = now - since >= stallMs && !acknowledged;
  return { messageId, since, badge: stalled ? "stalled" : "working" };
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
  let acknowledgedUntil;
  const nudged = new Set;
  const viewState = () => {
    const base = { ...session.view(mode, selection), prefs: readPrefs(), userHome };
    return { ...base, waiting: waitingOn(base.chat, Date.now(), { acknowledgedUntil }) };
  };
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
      case "note.add": {
        const r = session.addNote({
          doc: msg.doc,
          body: msg.body,
          who: "human",
          range: { from: msg.from, to: msg.to }
        });
        log.emit({ type: "note.added", doc: r.slug, note: r.note.id, by: "human" });
        broadcastState();
        return;
      }
      case "task.done": {
        const r = session.finishTask(msg.id, msg.outcome);
        if (!r.already) {
          session.addMessage("system", `Done: ${r.task.text}`);
          log.emit({ type: "task.done", task: r.task.id, by: "human" });
        }
        broadcastState();
        return;
      }
      case "task.remove": {
        session.removeTask(msg.id);
        broadcastState();
        return;
      }
      case "tasks.clear": {
        session.clearDoneTasks();
        broadcastState();
        return;
      }
      case "note.edit": {
        const r = session.editNote({ doc: msg.doc, id: msg.id, body: msg.body });
        log.emit({ type: "note.edited", doc: r.slug, note: r.note.id, by: "human" });
        broadcastState();
        return;
      }
      case "note.resolve": {
        const r = session.resolveNote({ doc: msg.doc, id: msg.id, resolved: msg.resolved });
        log.emit({
          type: msg.resolved ? "note.resolved" : "note.reopened",
          doc: r.slug,
          note: r.note.id,
          by: "human"
        });
        broadcastState();
        return;
      }
      case "note.remove": {
        const r = session.removeNote({ doc: msg.doc, id: msg.id });
        log.emit({ type: "note.removed", doc: r.slug, note: r.note.id, by: "human" });
        broadcastState();
        return;
      }
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
      case "dangling":
        return session.danglingLinks(cmd.entry);
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
      case "note.add": {
        const r = session.addNote({
          doc: cmd.doc,
          body: cmd.body,
          who: "agent",
          quote: cmd.quote
        });
        announce(`Agent noted \u201C${quoteLabel(r.note.quote)}\u201D on ${r.slug}.`, {
          fact: "note.added",
          doc: r.slug,
          note: r.note.id,
          by: "agent"
        });
        return { doc: r.slug, note: r.note.id, quote: r.note.quote };
      }
      case "notes": {
        const r = session.notesOf({ doc: cmd.doc, ...cmd.all ? { all: true } : {} });
        return { doc: r.slug, notes: r.notes };
      }
      case "task.remove": {
        const t = session.removeTask(cmd.id);
        broadcastState();
        return { task: t.id, removed: true };
      }
      case "tasks.clear": {
        const cleared = session.clearDoneTasks();
        broadcastState();
        return { cleared };
      }
      case "working": {
        const ms = cmd.seconds !== undefined ? cmd.seconds * 1000 : DEFAULT_SNOOZE_MS;
        acknowledgedUntil = Date.now() + Math.max(0, ms);
        const w = waitingOn(session.messages(), Date.now(), { acknowledgedUntil });
        if (w)
          nudged.add(w.messageId);
        broadcastState();
        return {
          until: acknowledgedUntil,
          seconds: Math.round(Math.max(0, ms) / 1000),
          ...w ? { waiting: w.messageId } : {}
        };
      }
      case "task.start": {
        const t = session.startTask(cmd.text, "agent");
        log.emit({ type: "task.started", task: t.id, text: t.text, by: "agent" });
        broadcastState();
        return { task: t.id, text: t.text };
      }
      case "task.status": {
        const t = session.setTaskStatus(cmd.id, cmd.status);
        broadcastState();
        return { task: t.id, status: t.status };
      }
      case "task.done": {
        const r = session.finishTask(cmd.id, cmd.outcome);
        if (!r.already)
          announce(`Done: ${r.task.text}${r.task.outcome ? ` \u2014 ${r.task.outcome}` : ""}`, {
            fact: "task.done",
            task: r.task.id,
            by: "agent"
          });
        broadcastState();
        return { task: r.task.id, already: r.already };
      }
      case "note.edit": {
        const r = session.editNote({ doc: cmd.doc, id: cmd.id, body: cmd.body });
        announce(`Agent rewrote a note on ${r.slug}: \u201C${quoteLabel(r.note.quote)}\u201D.`, {
          fact: "note.edited",
          doc: r.slug,
          note: r.note.id,
          by: "agent"
        });
        return { doc: r.slug, note: r.note.id };
      }
      case "note.resolve": {
        const r = session.resolveNote({ doc: cmd.doc, id: cmd.id, resolved: cmd.resolved });
        announce(`Agent ${cmd.resolved ? "resolved" : "reopened"} a note on ${r.slug}: \u201C${quoteLabel(r.note.quote)}\u201D.`, { fact: "note.resolved", doc: r.slug, note: r.note.id, by: "agent" });
        return { doc: r.slug, note: r.note.id, resolved: r.note.resolved };
      }
      case "note.remove": {
        const r = session.removeNote({ doc: cmd.doc, id: cmd.id });
        announce(`Agent removed a note on ${r.slug}: \u201C${quoteLabel(r.note.quote)}\u201D.`, {
          fact: "note.removed",
          doc: r.slug,
          note: r.note.id,
          by: "agent"
        });
        return { doc: r.slug, note: r.note.id };
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
  log.emit({
    type: "ready",
    mode,
    session_id: sessionId,
    restored: !!opts.restore,
    idle_timeout_s: opts.timeoutS ?? 1800
  });
  for (const f of session.restoreFindings)
    announce(f.missing ? `${f.original} is gone from disk since this session was last open. Save would recreate it; Revert cannot run.` : `${f.original} changed on disk while this session was closed. Save overwrites it with the active version; Revert takes the file's version.`, { fact: "original.conflict", doc: f.doc, whileClosed: true });
  let lastWaiting = null;
  const attentionTimer = setInterval(() => {
    const w = waitingOn(session.messages(), Date.now(), { acknowledgedUntil });
    const key = w ? `${w.messageId}:${w.badge}` : null;
    if (key === lastWaiting)
      return;
    lastWaiting = key;
    broadcastState();
    if (!w)
      return;
    if (w.badge !== "stalled" || nudged.has(w.messageId))
      return;
    nudged.add(w.messageId);
    const pending2 = session.messages().find((m) => m.id === w.messageId);
    log.emit({
      type: "waiting",
      message_id: w.messageId,
      seconds: Math.round((Date.now() - w.since) / 1000),
      ...pending2 ? { text: pending2.text } : {},
      hint: "reply with `say`, or `working` to say you are still on it"
    });
  }, 1000);
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
    clearInterval(attentionTimer);
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

//# debugId=A373951A44962A9364756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc3NlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2FuY2hvcnMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvZGlmZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9waWNrZXIudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2Vzc2lvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9mcm9udG1hdHRlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9saW5rcy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC90cmVlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3dhaXRpbmcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiLyoqXG4gKiBzY3JpcHRvcml1bSdzIHBlci1zZXNzaW9uIGRhZW1vbiDigJQgdGhlIHByb2Nlc3MgdGhlIHN1cmZhY2UgdGFsa3MgdG8gb3ZlciBhXG4gKiBXZWJTb2NrZXQgYW5kIHRoZSBDTEkgdGFsa3MgdG8gb3ZlciBIVFRQLiBMYXVuY2hlZCBieVxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9zY3JpcHRvcml1bS9zY3JpcHRzL3NlcnZlci50c2AgKHRoZSBsYXVuY2hlciksIHdoaWNoXG4gKiBpbXBvcnRzIHRoZSBCVUlMVCBgZGlzdC9zZXJ2ZXIuanNgLlxuICpcbiAqIOKUgOKUgCBUSEUgRUlHSFQgUVVFU1RJT05TIChzY2FmZm9sZGluZyBwbGF5Ym9vayBOMSksIEFOU1dFUkVEIEFTIERFU0lHTiDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAxLiBBcml0aG1ldGljOiBgU0tJTExfUk9PVGAvYERJU1RfRElSYCBvbmx5LCBmb3IgdGhlIGtpdCdzIGByZXNvbHZlTW9kZWAgYW5kXG4gKiAgICBgc2VydmVGcm9tRGlzdGAsIGFuZCB0cnVlIGF0IHRoZSBFTUlUVEVEIGFkZHJlc3MgKGBkaXN0L3NlcnZlci5qc2AsIHdob3NlXG4gKiAgICBgLi5gIGlzIHRoZSBza2lsbCBmb2xkZXIpLiBOb3RoaW5nIGVsc2UgaXMgcGlubmVkIG9mZiBgaW1wb3J0Lm1ldGFgLlxuICogMi4gU2VydmVzOiBZRVMuIGAvYCBpcyB0aGUgYnVpbHQgYGluZGV4Lmh0bWxgIHZpYSBgc2VydmVGcm9tRGlzdGAsIG5vXG4gKiAgICBzdWJzdGl0dXRpb247IHRoZSBvbmx5IHJvdXRlcyBvZiBpdHMgb3duIGFyZSBgL3N0YXRlYCwgYC9jbWRgLCBgL2V2ZW50c2AsXG4gKiAgICBgL3dzYCBhbmQgYC9mcy8qYCAocmVhZC1vbmx5OiBhIHZlcnNpb24ncyB0ZXh0LCBhIGRpcmVjdG9yeSBsaXN0aW5nKS5cbiAqIDMuIFNlY29uZCBoYWxmOiBZRVMg4oCUIGBjbGkudHNgOyB0aGUgdHdvIHNoYXJlIGAuL2hlYXJ0YmVhdC50c2AuXG4gKiA0LiBMaWZlY3ljbGU6IGxvbmctcnVubmluZywgb25lIGRhZW1vbiBwZXIgc2Vzc2lvbiwgaWRsZS10aW1lb3V0IGxpa2VcbiAqICAgIGdsYW1vdXIgKGxpbmdlciBhZnRlciB0aGUgbGFzdCBzdWJzY3JpYmVyIGxlYXZlczsgZXhpdCAxMjQpLlxuICogNS4gYG1haW4oKWAgcmV0dXJucyB3aGlsZSB0aGUgcHJvY2VzcyBtdXN0IGxpdmU/IE5PIOKAlCBgbWFpbmAgYXdhaXRzIHRoZVxuICogICAgc2Vzc2lvbidzIGVuZCBhbmQgaXRzIG93biBkcmFpbiwgZXhhY3RseSBhcyBnbGFtb3VyJ3Mgc2VydmVyIGRvZXMsIHNvIHRoZVxuICogICAgbGF1bmNoZXIgaXMgVEVSTUlOQUwtRVhJVCAoYHByb2Nlc3MuZXhpdChhd2FpdCBydW4oKSlgKTogb25jZSBgbWFpbmBcbiAqICAgIHJlc29sdmVzIG5vdGhpbmcgbWF5IGtlZXAgdGhlIHByb2Nlc3MgYWxpdmUsIGFuZCBhIHdhdGNoZXIgaGFuZGxlIG9yIGFcbiAqICAgIHN0cmFnZ2xpbmcgc29ja2V0IHdvdWxkLiBEcml2ZW4sIG5vdCByZWFkIChzZWUgdGhlIHNsaWNlLUEgam91cm5hbCkuXG4gKiA2LiBFdmVudCBpZHMgcmVjb3ZlcmVkIGFjcm9zcyByZXN0YXJ0PyBOTyDigJQgdGhlIGxvZyBpcyBpbiBtZW1vcnkgYW5kIGlkc1xuICogICAgcmVzdGFydCBhdCAxLCBldmVuIHVuZGVyIGAtLXJlc3RvcmVgICh3aGljaCByZXN0b3JlcyB0aGUgTUFOSUZFU1QsIG5vdCB0aGVcbiAqICAgIGxvZykuIFNvIHRoZSBsb2cgaXMgc3RhbXBlZCB3aXRoIGEgcGVyLWJvb3QgRVBPQ0ggKG1pbmQtbWFwcGVyJ3Mgc2hhcGUpXG4gKiAgICBhbmQgdGhlIHRhaWwgcmVzZXRzIGl0cyBjdXJzb3Igd2hlbiB0aGUgZXBvY2ggY2hhbmdlcy5cbiAqIDcuIEEga2l0IHN1YmplY3QgaW4gYSBkaWZmZXJlbnQgc2hhcGU/IE5vIOKAlCB0aGUgc2hhcGUgd2FzIGNob3NlbiB0byBiZSB0aGVcbiAqICAgIGtpdCdzLlxuICogOC4gQSBraXQgbW9kdWxlIG5hbWVzIHRoaXMgc3BlbGwgYXMgaXRzIHNvdXJjZT8gU3RydWN0dXJhbGx5IE5POiBzY3JpcHRvcml1bVxuICogICAgaXMgdGhlIGZpcnN0IHNwZWxsIHNjYWZmb2xkZWQgYWZ0ZXIgdGhlIGNvbnZlcmdlbmNlLlxuICpcbiAqIOKUgOKUgCBLSVQgVkVSRElDVFMgKHBsYXlib29rIE40KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBlcnJvcnMgU1VCSkVDVCAodGhlIENMSTsgdGhlIGRhZW1vbiBhbnN3ZXJzIEhUVFAgc3RhdHVzZXMgdGhlIENMSSBtYXBzKSDCt1xuICogc2VydmVEaXN0IFNVQkpFQ1QgKGByZXNvbHZlTW9kZWAsIGBzZXJ2ZUZyb21EaXN0YCkgwrcgaG91c2VrZWVwaW5nIFNVQkpFQ1QsIGFsbFxuICogdGhyZWUgZXhwb3J0cyAoYHNob3VsZElkbGVDbG9zZWAgdmlhIGBzdGFydEhvdXNla2VlcGluZ2AncyBpZGxlLWNsb3NlLCB0aGVcbiAqIHNuYXBzaG90IHN3ZWVwIOKAlCBoZXJlIHRoZSBtYW5pZmVzdCBpcyB3cml0dGVuIG9uIGV2ZXJ5IGNoYW5nZSBpbnN0ZWFkLCBzbyB0aGVcbiAqIHN3ZWVwJ3Mgc25hcHNob3QgaG9vayBpcyBkZWxpYmVyYXRlbHkgTk9UIHBhc3NlZCDigJQgYW5kIGBkcmFpbkFuZFN0b3BgKSDCt1xuICogdGFpbEV2ZW50cyBTVUJKRUNUICh0aGUgQ0xJJ3MgYHRhaWxgKSDCtyBoZWFydGJlYXQgU1VCSkVDVCAoYC4vaGVhcnRiZWF0LnRzYCkgwrdcbiAqIGRpc2NvdmVyeSBTVUJKRUNUIChzZXNzaW9uLUpTT04sIEUxMzogYHNjcmlwdG9yaXVtLTxpZD4uanNvbmAgK1xuICogYHNjcmlwdG9yaXVtLWxhdGVzdC5qc29uYCBpbiB0bXBkaXIgdmlhIGB3cml0ZUZpbGVBdG9taWNgL2B1bmxpbmtJZk1hdGNoZXNgKSDCt1xuICogZXZlbnRMb2cgU1VCSkVDVCwgV0lUSCBFUE9DSCAoUTYpIMK3IHNzZSBTVUJKRUNUIChgR0VUIC9ldmVudHNgKSDCt1xuICogbGliL3ByaW50SnNvbiBTVUJKRUNUICh0aGUgQ0xJIHNwZWFrcyB0aGUgYWdlbnQgd2lyZSkuXG4gKlxuICog4pSA4pSAIFRFQVJET1dOIE9SREVSIChyZWdpc3RlciBBNiksIFNUQVRFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBnbGFtb3VyJ3Mgb3JkZXI6IHN0b3AgaG91c2VrZWVwaW5nIOKGkiBjbG9zZSB0aGUgd2F0Y2hlcnMg4oaSIHBlcnNpc3QgdGhlXG4gKiBtYW5pZmVzdCDihpIgdW5saW5rIGRpc2NvdmVyeSDihpIgZW1pdCBgY2xvc2VkYCDihpIgZHJhaW4uIERpc2NvdmVyeSBnb2VzIEJFRk9SRSB0aGVcbiAqIGBjbG9zZWRgIGZyYW1lIHNvIGEgdGFpbCB0aGF0IHNlZXMgYGNsb3NlZGAgYW5kIGEgQ0xJIHZlcmIgdGhhdCBydW5zIHJpZ2h0XG4gKiBhZnRlciBpdCBib3RoIGZpbmQgbm8gcG9pbnRlciB0byBhIGRhZW1vbiB0aGF0IGlzIGxlYXZpbmc7IHRoZSBvdGhlciBvcmRlclxuICogbGVhdmVzIGEgd2luZG93IGluIHdoaWNoIGEgdmVyYiByZXNvbHZlcyBhIHNlc3Npb24gdGhhdCB3aWxsIHJlZnVzZSBpdC5cbiAqL1xuXG5pbXBvcnQgeyB0eXBlIEZTV2F0Y2hlciwgcmVhZEZpbGVTeW5jLCBzdGF0U3luYywgdW5saW5rU3luYywgd2F0Y2ggfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIGFzIG5vZGVQYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5pbXBvcnQgeyB1bmxpbmtJZk1hdGNoZXMsIHdyaXRlRmlsZUF0b21pYyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9kaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB7IGNyZWF0ZUV2ZW50TG9nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2V2ZW50TG9nLnRzXCI7XG5pbXBvcnQgeyBkcmFpbkFuZFN0b3AsIHN0YXJ0SG91c2VrZWVwaW5nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hvdXNla2VlcGluZy50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZU1vZGUgYXMgcmVzb2x2ZU1vZGVJbiwgc2VydmVGcm9tRGlzdCB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9zZXJ2ZURpc3QudHNcIjtcbmltcG9ydCB7IHR5cGUgU3NlQ2xpZW50cywgc3NlUmVzcG9uc2UgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvc3NlLnRzXCI7XG5pbXBvcnQgeyBxdW90ZUxhYmVsIH0gZnJvbSBcIi4vYW5jaG9yc1wiO1xuaW1wb3J0IHsgdW5pZmllZCB9IGZyb20gXCIuL2RpZmZcIjtcbmltcG9ydCB7IElETEVfVElNRU9VVF9TRUMsIFNTRV9IRUFSVEJFQVRfTVMgfSBmcm9tIFwiLi9oZWFydGJlYXRcIjtcbmltcG9ydCB7IHR5cGUgUGlja0tpbmQsIHBhcnNlUGlja2VyT3V0cHV0LCBwaWNrZXJDb21tYW5kLCB3YXNDYW5jZWxsZWQgfSBmcm9tIFwiLi9waWNrZXJcIjtcbmltcG9ydCB0eXBlIHtcbiAgQWdlbnRDbWQsXG4gIENsaWVudE1zZyxcbiAgUHVibGljU3RhdGUsXG4gIFNlbGVjdGlvbixcbiAgU2VydmVyTXNnLFxuICBTdHJ1Y3R1cmVPcCxcbn0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcbmltcG9ydCB7IHR5cGUgRmlsZUV2ZW50LCBTZXNzaW9uLCBTZXNzaW9uRXJyb3IsIHNpZGVOYW1lIH0gZnJvbSBcIi4vc2Vzc2lvblwiO1xuaW1wb3J0IHsgbGlzdERpciwgUGF0aEVycm9yIH0gZnJvbSBcIi4vdHJlZVwiO1xuaW1wb3J0IHsgREVGQVVMVF9TTk9PWkVfTVMsIHdhaXRpbmdPbiB9IGZyb20gXCIuL3dhaXRpbmdcIjtcblxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuXG4vKiogcmVsZWFzZSBpZmYgYGRpc3QvaW5kZXguaHRtbGAgZXhpc3RzIGF0IHRoZSBza2lsbCByb290OyB0aGUgZW52IHZhciBvdmVycmlkZXMgKENvbnRyYWN0IDEpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKCk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIHJldHVybiByZXNvbHZlTW9kZUluKERJU1RfRElSKTtcbn1cblxuZnVuY3Rpb24gc2VydmVEaXN0KHBhdGg6IHN0cmluZyk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIHJldHVybiBzZXJ2ZUZyb21EaXN0KERJU1RfRElSLCBwYXRoID09PSBcIi9cIiA/IFwiaW5kZXguaHRtbFwiIDogcGF0aC5zbGljZSgxKSk7XG59XG5cbi8qKiBgJFNDUklQVE9SSVVNX0hPTUVgLCBkZWZhdWx0IGB+Ly5zY3JpcHRvcml1bWAuIGBwcm9tcHRzLmpzb25gIGJlc2lkZSBgc2Vzc2lvbnMvYCBpcyBzbGljZSBCJ3MgKEU5KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY3JpcHRvcml1bUhvbWUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlc29sdmUocHJvY2Vzcy5lbnYuU0NSSVBUT1JJVU1fSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuc2NyaXB0b3JpdW1cIikpO1xufVxuXG5leHBvcnQgdHlwZSBTdGFydE9wdHMgPSB7XG4gIHBvcnQ/OiBudW1iZXI7XG4gIHJlc3RvcmU/OiBzdHJpbmc7XG4gIHRpbWVvdXRTPzogbnVtYmVyO1xuICAvKiogRTIzOiBhIE5FVyBzZXNzaW9uJ3Mgd29ya3NwYWNlIOKAlCB0aGUgZGlyZWN0b3J5IGBvcGVuYCByYW4gaW4uIEEgcmVzdG9yZSBrZWVwcyBpdHMgb3duLiAqL1xuICB3b3Jrc3BhY2U/OiBzdHJpbmc7XG59O1xuXG4vKiogQSB0YWlsIGZyYW1lJ3MgcGF5bG9hZC4gVGhlIGxvZyBzdGFtcHMgYGlkYCBhbmQgYGVwb2NoYC4gKi9cbnR5cGUgTG9nRXZlbnQgPSBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiAmIHsgdHlwZTogc3RyaW5nIH07XG5cbi8qKiBIb3cgbG9uZyBhIGJ1cnN0IG9mIHdhdGNoZXIgZXZlbnRzIG9uIG9uZSBwYXRoIHNldHRsZXMgYmVmb3JlIGl0IGlzIHJlYWQuICovXG5jb25zdCBXQVRDSF9TRVRUTEVfTVMgPSA2MDtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0RGFlbW9uKG9wdHM6IFN0YXJ0T3B0cykge1xuICBjb25zdCBob21lID0gc2NyaXB0b3JpdW1Ib21lKCk7XG4gIC8vIE1vZGUgQkVGT1JFIGFueSB3cml0ZTogYSBmb3JjZWQtZGV2IGJvb3QgYXQgYSBzdXJmYWNlLWZyZWUgZGVzdGluYXRpb24gbXVzdFxuICAvLyBkaWUgYXQgdGhlIGltcG9ydCBoYXZpbmcgY3JlYXRlZCBub3RoaW5nIChnbGFtb3VyJ3MgbWVhc3VyZWQgb3JkZXIpLlxuICBjb25zdCBtb2RlID0gcmVzb2x2ZU1vZGUoKTtcbiAgY29uc3QgZGV2SW5kZXggPVxuICAgIG1vZGUgPT09IFwiZGV2XCJcbiAgICAgID8gKGF3YWl0IGltcG9ydChcIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9zdXJmYWNlL2luZGV4Lmh0bWxcIikpLmRlZmF1bHRcbiAgICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCByb3V0ZXMgPSAoZGV2SW5kZXggPyB7IFwiL1wiOiBkZXZJbmRleCB9IDoge30pIGFzIFJlY29yZDxzdHJpbmcsIG5ldmVyPjtcblxuICBjb25zdCBzZXNzaW9uID0gb3B0cy5yZXN0b3JlXG4gICAgPyBTZXNzaW9uLnJlc3RvcmUoaG9tZSwgb3B0cy5yZXN0b3JlKVxuICAgIDogU2Vzc2lvbi5jcmVhdGUoaG9tZSwgdW5kZWZpbmVkLCBvcHRzLndvcmtzcGFjZSk7XG4gIGNvbnN0IHNlc3Npb25JZCA9IHNlc3Npb24uaWQ7XG4gIGxldCBzZWxlY3Rpb246IFNlbGVjdGlvbiB8IG51bGwgPSBudWxsO1xuXG4gIC8vIC0tLSBwcmVmczogcGVyLXZpZXdlciBjb252ZW5pZW5jZXMgdGhhdCBvdXRsaXZlIGEgc2Vzc2lvbidzIHBvcnQgLS0tLS0tLS0tLS0tXG4gIC8vIEJyb3dzZXIgc3RvcmFnZSBpcyBrZXllZCBieSBvcmlnaW4sIHBvcnQgaW5jbHVkZWQsIGFuZCBldmVyeSBzZXNzaW9uIGdldHMgYVxuICAvLyBuZXcgcG9ydCDigJQgc28gYSBwYW5lIHNpemUga2VwdCBpbiBsb2NhbFN0b3JhZ2UgcmVzZXRzIGF0IHRoZSBuZXh0IGBvcGVuYC5cbiAgLy8gVGhleSBsaXZlIGluIHRoZSBob21lIGluc3RlYWQsIHNoYXJlZCBieSBldmVyeSBzZXNzaW9uIG9mIHRoaXMgaG9tZS5cbiAgY29uc3QgcHJlZnNGaWxlID0gam9pbihob21lLCBcInByZWZzLmpzb25cIik7XG4gIGNvbnN0IFBSRUZfS0VZID0gL15bYS16XVthLXowLTk6Ll8tXXswLDYzfSQvO1xuICBjb25zdCBQUkVGX1ZBTFVFX01BWCA9IDQwOTY7XG4gIGNvbnN0IFBSRUZfS0VZU19NQVggPSA2NDtcbiAgLyoqXG4gICAqIFJlYWQgdGhlIGhvbWUncyBwcmVmcyBGUkVTSC4gU2V2ZXJhbCBzZXNzaW9ucyBjYW4gc2hhcmUgb25lIGhvbWUgKEUxMyksIGVhY2hcbiAgICogaXRzIG93biBkYWVtb24sIHNvIGEgY29weSBsb2FkZWQgb25jZSBhdCBib290IGFuZCB3cml0dGVuIGJhY2sgd2hvbGUgd291bGRcbiAgICogZXJhc2UgYSBrZXkgYW5vdGhlciBzZXNzaW9uIHdyb3RlIHNpbmNlICh2ZXJpZnkgcGFzcykuIEV2ZXJ5IHdyaXRlIGlzXG4gICAqIHRoZXJlZm9yZSByZWFkIOKGkiBzZXQgb25lIGtleSDihpIgd3JpdGUsIGFuZCBldmVyeSBzbmFwc2hvdCByZWFkcyB0aGUgZmlsZS5cbiAgICogT25seSB3ZWxsLWZvcm1lZCBlbnRyaWVzIHN1cnZpdmUgYSByZWFkOyBhIGJhZCBmaWxlIHJlYWRzIGFzIGVtcHR5IGFuZCBpc1xuICAgKiByZXBsYWNlZCBieSB0aGUgbmV4dCB3cml0ZS5cbiAgICovXG4gIGNvbnN0IHJlYWRQcmVmcyA9ICgpOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0+IHtcbiAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmF3ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocHJlZnNGaWxlLCBcInV0ZjhcIikpIGFzIHVua25vd247XG4gICAgICBpZiAocmF3ICYmIHR5cGVvZiByYXcgPT09IFwib2JqZWN0XCIgJiYgIUFycmF5LmlzQXJyYXkocmF3KSkge1xuICAgICAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhyYXcpKVxuICAgICAgICAgIGlmIChQUkVGX0tFWS50ZXN0KGspICYmIHR5cGVvZiB2ID09PSBcInN0cmluZ1wiICYmIHYubGVuZ3RoIDw9IFBSRUZfVkFMVUVfTUFYKSBvdXRba10gPSB2O1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLyogbm8gcHJlZnMgeWV0LCBvciB1bnJlYWRhYmxlIOKAlCBlbXB0eSAqL1xuICAgIH1cbiAgICByZXR1cm4gb3V0O1xuICB9O1xuICBjb25zdCB1c2VySG9tZSA9IGhvbWVkaXIoKTtcbiAgLyoqXG4gICAqIEU1MzogdGhlIHNub296ZSB0aGUgYWdlbnQgYXNrZWQgZm9yLCBhbmQgdGhlIG1lc3NhZ2VzIGFscmVhZHkgbnVkZ2VkLlxuICAgKlxuICAgKiDim5QgT05FIE5VREdFIFBFUiBNRVNTQUdFLCBBTkQgVEhBVCBJUyBUSEUgV0hPTEUgQU5USS1OQUcgUlVMRS4gQ29sZTogXCJ3ZVxuICAgKiBkb24ndCB3YW50IHRvIGhhdmUgYSBzaXR1YXRpb24gd2hlcmUgYW4gYWdlbnQga2VlcHMgZ2V0dGluZyBwaW5nZWQgYWJvdXRcbiAgICogc29tZXRoaW5nIGFuZCBpdCdzIGxpa2UsIG5vLCBJJ20gYWN0dWFsbHkgd29ya2luZy5cIiBTbyBhIG1lc3NhZ2UgaWQgZW50ZXJzXG4gICAqIGBudWRnZWRgIHRoZSBmaXJzdCB0aW1lIGl0IGlzIHJlcG9ydGVkIOKAlCBvciB0aGUgbW9tZW50IHRoZSBhZ2VudCBzbm9vemVzIGl0XG4gICAqIOKAlCBhbmQgbmV2ZXIgbGVhdmVzLiBBIHNub296ZSBFWFBJUklORyB0aGVyZWZvcmUgY2hhbmdlcyB3aGF0IHRoZSBIVU1BTlxuICAgKiBzZWVzIChiYWNrIHRvIFwibWF5IGJlIHN0dWNrXCIsIGJlY2F1c2UgdGhleSBhcmUgb3dlZCB0aGUgdHJ1dGgpIHdpdGhvdXRcbiAgICogcGluZ2luZyB0aGUgYWdlbnQgYWdhaW4uXG4gICAqXG4gICAqIOKaoCBJTiBNRU1PUlksIE5PVCBJTiBUSEUgTUFOSUZFU1QsIGRlbGliZXJhdGVseS4gQSByZXN0b3JlZCBzZXNzaW9uIHdob3NlXG4gICAqIGh1bWFuIHdhcyBsZWZ0IHdhaXRpbmcgU0hPVUxEIHRlbGwgdGhlIGFnZW50IHRoYXQgYXJyaXZlcyDigJQgdGhlIHdhaXQgaXNcbiAgICogcmVhbCBhbmQgdGhlIG5ldyBhZ2VudCBoYXMgbm90IGhlYXJkIGFib3V0IGl0LlxuICAgKi9cbiAgbGV0IGFja25vd2xlZGdlZFVudGlsOiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIGNvbnN0IG51ZGdlZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIGNvbnN0IHZpZXdTdGF0ZSA9ICgpOiBQdWJsaWNTdGF0ZSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IHsgLi4uc2Vzc2lvbi52aWV3KG1vZGUsIHNlbGVjdGlvbiksIHByZWZzOiByZWFkUHJlZnMoKSwgdXNlckhvbWUgfTtcbiAgICByZXR1cm4geyAuLi5iYXNlLCB3YWl0aW5nOiB3YWl0aW5nT24oYmFzZS5jaGF0LCBEYXRlLm5vdygpLCB7IGFja25vd2xlZGdlZFVudGlsIH0pIH07XG4gIH07XG5cbiAgLy8gLS0tIGNoYW5uZWxzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzb2NrZXRzID0gbmV3IFNldDxpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+PigpO1xuICBjb25zdCBsb2cgPSBjcmVhdGVFdmVudExvZzxMb2dFdmVudD4oeyBlcG9jaDogY3J5cHRvLnJhbmRvbVVVSUQoKSB9KTtcbiAgY29uc3Qgc3NlQ2xpZW50czogU3NlQ2xpZW50cyA9IG5ldyBTZXQoKTtcbiAgbGV0IGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICBjb25zdCB0b3VjaCA9ICgpID0+IHtcbiAgICBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgfTtcblxuICBjb25zdCBzZW5kID0gKG1zZzogU2VydmVyTXNnKSA9PiB7XG4gICAgY29uc3QgcyA9IEpTT04uc3RyaW5naWZ5KG1zZyk7XG4gICAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzKSB7XG4gICAgICB0cnkge1xuICAgICAgICB3cy5zZW5kKHMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHNvY2tldCBjbG9zZWQgKi9cbiAgICAgIH1cbiAgICB9XG4gIH07XG4gIGNvbnN0IGJyb2FkY2FzdFN0YXRlID0gKCkgPT4gc2VuZCh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGU6IHZpZXdTdGF0ZSgpIH0pO1xuXG4gIC8qKiBBIHN5c3RlbSBsaW5lIGluIHRoZSBjaGF0IOKAlCBhbmQsIGJlY2F1c2UgdGhlIGFnZW50IG11c3Qga25vdyBpdCB0b28sIG9uIHRoZSB0YWlsLiAqL1xuICBjb25zdCBhbm5vdW5jZSA9ICh0ZXh0OiBzdHJpbmcsIGZhY3Q6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge30pID0+IHtcbiAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwic3lzdGVtXCIsIHRleHQpO1xuICAgIGxvZy5lbWl0KHsgdHlwZTogXCJzeXN0ZW1cIiwgdGV4dCwgdHM6IG0udHMsIC4uLmZhY3QgfSk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgfTtcblxuICAvLyAtLS0gdGhlIHdhdGNoZXIgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy9cbiAgLy8g4pqgIERFVklBVElPTiBGUk9NIFRIRSBCUklFRiwgV0lUSCBJVFMgUkVBU09OOiBgbm9kZTpmc2AgYHdhdGNoYCAoQnVuJ3NcbiAgLy8gYnVpbHQtaW4pLCBOT1QgYEBwYXJjZWwvd2F0Y2hlcmAuIGBAcGFyY2VsL3dhdGNoZXJgIGlzIGEgbmF0aXZlIGFkZG9uIHdob3NlXG4gIC8vIGxvYWRlciBkb2VzIGEgcnVudGltZSBgcmVxdWlyZSgpYCBvZiBhIHBlci1wbGF0Zm9ybSBwYWNrYWdlOyBidW5kbGVkIGludG9cbiAgLy8gYGRpc3Qvc2VydmVyLmpzYCBpdCBpcyBub3QgaW5saW5lZCwgc28gdGhlIHNoaXBwZWQgZGFlbW9uIHdvdWxkIG5lZWQgYVxuICAvLyBgbm9kZV9tb2R1bGVzYCB0aGUgbWFya2V0cGxhY2UgbmV2ZXIgY29waWVzIChpbXBvcnQtYm91bmRhcnkgd2FyZCAxYidzXG4gIC8vIFwidGhlIHNoaXBwZWQgZXhlY3V0aW9uIHBhdGggY2FycmllcyBubyBkZXBlbmRlbmNpZXNcIikuIE1lYXN1cmVkIHVuZGVyIEJ1blxuICAvLyAxLjQuMCBvbiBtYWNPUyBiZWZvcmUgY2hvb3Npbmc6IGEgcmVjdXJzaXZlIGRpcmVjdG9yeSB3YXRjaCByZXBvcnRzIGFuXG4gIC8vIGluLXBsYWNlIHdyaXRlLCBhbiBhdG9taWMgdG1wK3JlbmFtZSBzYXZlLCBhbmQgYm90aCBhZ2FpbiBpbiBhXG4gIC8vIHN1YmRpcmVjdG9yeSDigJQgdGhlIGZvdXIgY2FzZXMgaW52ZXN0aWdhdGlvbiDCpzUgZHJvdmUgQHBhcmNlbC93YXRjaGVyIG9uLlxuICAvLyBUaGUgaGFzaC1jb21wYXJlIGFuZCBzZWxmLXdyaXRlIHN1cHByZXNzaW9uIGFyZSB1bmNoYW5nZWQgKHNlc3Npb24udHMpLlxuICBjb25zdCB3YXRjaGVycyA9IG5ldyBNYXA8c3RyaW5nLCBGU1dhdGNoZXI+KCk7XG4gIGNvbnN0IHBlbmRpbmcgPSBuZXcgTWFwPHN0cmluZywgUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4+KCk7XG4gIGNvbnN0IG9uRnMgPSAoYWJzOiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCB0ID0gcGVuZGluZy5nZXQoYWJzKTtcbiAgICBpZiAodCkgY2xlYXJUaW1lb3V0KHQpO1xuICAgIHBlbmRpbmcuc2V0KFxuICAgICAgYWJzLFxuICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHBlbmRpbmcuZGVsZXRlKGFicyk7XG4gICAgICAgIGxldCBldjogRmlsZUV2ZW50IHwgbnVsbCA9IG51bGw7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgZXYgPSBzZXNzaW9uLm9uRmlsZUV2ZW50KGFicyk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgc2NyaXB0b3JpdW06IHdhdGNoZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZXYpIGhhbmRsZUZpbGVFdmVudChldik7XG4gICAgICB9LCBXQVRDSF9TRVRUTEVfTVMpLFxuICAgICk7XG4gIH07XG4gIGNvbnN0IHN5bmNXYXRjaGVycyA9ICgpID0+IHtcbiAgICBjb25zdCB3YW50ID0gbmV3IE1hcChcbiAgICAgIHNlc3Npb24ud2F0Y2hSb290cygpLm1hcCgocikgPT4gW2Ake3IucmVjdXJzaXZlID8gXCJSXCIgOiBcIkZcIn06JHtyLndhdGNofT4ke3IucGF0aH1gLCByXSksXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIHddIG9mIHdhdGNoZXJzKVxuICAgICAgaWYgKCF3YW50LmhhcyhrZXkpKSB7XG4gICAgICAgIHcuY2xvc2UoKTtcbiAgICAgICAgd2F0Y2hlcnMuZGVsZXRlKGtleSk7XG4gICAgICB9XG4gICAgZm9yIChjb25zdCBba2V5LCByXSBvZiB3YW50KSB7XG4gICAgICBpZiAod2F0Y2hlcnMuaGFzKGtleSkpIGNvbnRpbnVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgLy8gV2F0Y2hlZCBhdCB0aGUgUkVBTFBBVEgsIHJlcG9ydGVkIHVuZGVyIHRoZSBzdG9yZWQgcGF0aCBmb3JtXG4gICAgICAgIC8vICh2ZXJpZnktcGFzcyBmaXggMyDigJQgc2VlIFNlc3Npb24ud2F0Y2hSb290cykuXG4gICAgICAgIGNvbnN0IHcgPSB3YXRjaChyLndhdGNoLCB7IHJlY3Vyc2l2ZTogci5yZWN1cnNpdmUgfSwgKF9ldmVudCwgbmFtZSkgPT4ge1xuICAgICAgICAgIGlmIChuYW1lKSBvbkZzKGpvaW4oci5wYXRoLCBuYW1lLnRvU3RyaW5nKCkpKTtcbiAgICAgICAgICBlbHNlIGlmIChyLmVudHJ5SWQpIG9uRnMoci5wYXRoKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHcub24oXCJlcnJvclwiLCAoKSA9PiB7XG4gICAgICAgICAgLyogdGhlIGRpcmVjdG9yeSB3ZW50IGF3YXk7IHRoZSBuZXh0IHN5bmMgZHJvcHMgaXQgKi9cbiAgICAgICAgfSk7XG4gICAgICAgIHdhdGNoZXJzLnNldChrZXksIHcpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHVud2F0Y2hhYmxlIChnb25lLCBwZXJtaXNzaW9ucykg4oCUIG91dHNpZGUgY2hhbmdlcyB0aGVyZSBnbyB1bnNlZW4gKi9cbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgY29uc3QgaGFuZGxlRmlsZUV2ZW50ID0gKGV2OiBGaWxlRXZlbnQpID0+IHtcbiAgICBzd2l0Y2ggKGV2LmtpbmQpIHtcbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLmNoYW5nZWRcIjpcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IGV2LnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInZlcnNpb24uY3JlYXRlZFwiOlxuICAgICAgICBhbm5vdW5jZShgdiR7ZXYudmVyc2lvbn0gb2YgJHtldi5kb2N9IGFwcGVhcmVkICh3cml0dGVuIGRpcmVjdGx5IHRvICR7ZXYucGF0aH0pYCwge1xuICAgICAgICAgIGZhY3Q6IFwidmVyc2lvbi5jcmVhdGVkXCIsXG4gICAgICAgICAgZG9jOiBldi5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogZXYudmVyc2lvbixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJhY3RpdmUub3V0c2lkZVwiOlxuICAgICAgICAvLyBFMjogdGhlIGFnZW50IG5ldmVyIHdyaXRlcyB0aGUgdmVyc2lvbiB0aGUgaHVtYW4gaXMgZWRpdGluZy4gVGhlXG4gICAgICAgIC8vIG91dHNpZGUgdGV4dCBpcyBLRVBUIGFzIGEgbmV3IGFnZW50IHZlcnNpb24gYW5kIHRoZSBhY3RpdmUgdmVyc2lvblxuICAgICAgICAvLyBrZWVwcyB0aGUgaHVtYW4ncyB0ZXh0IOKAlCBub3RoaW5nIGlzIGxvc3QsIGFuZCB0aGUgaHVtYW4ncyBidWZmZXIgaXNcbiAgICAgICAgLy8gbm90IHRvdWNoZWQgKHZlcmlmeS1wYXNzIGZpeCA0KS5cbiAgICAgICAgYW5ub3VuY2VPdXRzaWRlKGV2LmRvYywgZXYudmVyc2lvbiwgZXYucGF0aCwgZXYucHJlc2VydmVkQXMsIGV2LnByZXNlcnZlZFBhdGgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwib3JpZ2luYWwucmVsb2FkZWRcIjpcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IGV2LnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoYCR7ZXYub3JpZ2luYWx9IGNoYW5nZWQgb24gZGlzayDigJQgcmVsb2FkZWQgKHlvdSBoYWQgbm8gdW5zYXZlZCBlZGl0cykuYCwge1xuICAgICAgICAgIGZhY3Q6IFwib3JpZ2luYWwucmVsb2FkZWRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJvcmlnaW5hbC5jb25mbGljdFwiOlxuICAgICAgICBhbm5vdW5jZShcbiAgICAgICAgICBgJHtldi5vcmlnaW5hbH0gY2hhbmdlZCBvbiBkaXNrIHdoaWxlIHlvdSBoYXZlIHVuc2F2ZWQgZWRpdHMuIFNhdmUgb3ZlcndyaXRlcyBpdCB3aXRoIHlvdXJzOyBSZXZlcnQgdGFrZXMgdGhlIGZpbGUncyB2ZXJzaW9uLmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm9yaWdpbmFsLmNvbmZsaWN0XCIsIGRvYzogZXYuZG9jIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJ0cmVlXCI6XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgYW5ub3VuY2VPdXRzaWRlID0gKFxuICAgIGRvYzogc3RyaW5nLFxuICAgIHZlcnNpb246IG51bWJlcixcbiAgICBwYXRoOiBzdHJpbmcsXG4gICAgcHJlc2VydmVkQXM6IG51bWJlcixcbiAgICBwcmVzZXJ2ZWRQYXRoOiBzdHJpbmcsXG4gICkgPT5cbiAgICBhbm5vdW5jZShcbiAgICAgIGB2JHt2ZXJzaW9ufSBvZiAke2RvY30gaXMgdGhlIEFDVElWRSB2ZXJzaW9uIGFuZCB3YXMgd3JpdHRlbiBmcm9tIG91dHNpZGUgdGhlIGVkaXRvci4gVGhhdCB0ZXh0IGlzIGtlcHQgYXMgdiR7cHJlc2VydmVkQXN9OyB0aGUgYWN0aXZlIHZlcnNpb24ga2VlcHMgeW91ciB0ZXh0LiBBZ2VudCBlZGl0cyBiZWxvbmcgaW4gYSBuZXcgdmVyc2lvbiAodmVyc2lvbi1uZXcpLmAsXG4gICAgICB7IGZhY3Q6IFwiYWN0aXZlLm91dHNpZGVcIiwgZG9jLCB2ZXJzaW9uLCBwYXRoLCBwcmVzZXJ2ZWRBcywgcHJlc2VydmVkUGF0aCB9LFxuICAgICk7XG5cbiAgLy8gLS0tIHNoYXJlZCBhY3RzIChzdXJmYWNlIGFuZCBhZ2VudCByZWFjaCB0aGUgc2FtZSBjb2RlKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgYWRkUGF0aHMgPSAocGF0aHM6IHN0cmluZ1tdKSA9PiB7XG4gICAgY29uc3QgYWRkZWQgPSBwYXRocy5tYXAoKHApID0+IHNlc3Npb24uYWRkQ29udGV4dChwKSk7XG4gICAgc3luY1dhdGNoZXJzKCk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4gYWRkZWQ7XG4gIH07XG5cbiAgY29uc3QgYWN0aXZhdGUgPSAoZG9jOiBzdHJpbmcgfCB1bmRlZmluZWQsIHZlcnNpb246IG51bWJlciwgYnk6IFwiaHVtYW5cIiB8IFwiYWdlbnRcIikgPT4ge1xuICAgIGNvbnN0IHIgPSBzZXNzaW9uLmFjdGl2YXRlKHsgZG9jLCB2ZXJzaW9uIH0pO1xuICAgIGNvbnN0IHZpZXcgPSBzZXNzaW9uLmRvYyhyLnNsdWcpO1xuICAgIGNvbnN0IHBhdGggPSB2aWV3LnZlcnNpb25zLmZpbmQoKHYpID0+IHYubiA9PT0gdmVyc2lvbik/LnBhdGggPz8gbnVsbDtcbiAgICBzZW5kKHtcbiAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgIHZlcnNpb24sXG4gICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKHIuc2x1ZywgdmVyc2lvbikudGV4dCxcbiAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgfSk7XG4gICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgIFwic3lzdGVtXCIsXG4gICAgICBgJHtieSA9PT0gXCJhZ2VudFwiID8gXCJBZ2VudFwiIDogXCJZb3VcIn0gbWFkZSB2JHt2ZXJzaW9ufSBvZiAke3Iuc2x1Z30gYWN0aXZlICh3YXMgdiR7ci5wcmV2aW91c30pLmAsXG4gICAgKTtcbiAgICBsb2cuZW1pdCh7IHR5cGU6IFwiYWN0aXZhdGVkXCIsIGJ5LCBkb2M6IHIuc2x1ZywgdmVyc2lvbiwgcHJldmlvdXM6IHIucHJldmlvdXMsIHBhdGgsIHRzOiBtLnRzIH0pO1xuICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIHZlcnNpb24sIHByZXZpb3VzOiByLnByZXZpb3VzLCBwYXRoIH07XG4gIH07XG5cbiAgLyoqXG4gICAqIEUyNDogb25lIHN0cnVjdHVyZSBjaGFuZ2UsIGZyb20gZWl0aGVyIHBhcnR5IOKAlCB0aGUgc2FtZSBzZXNzaW9uIG1ldGhvZCwgdGhlXG4gICAqIHNhbWUgYW5ub3VuY2VtZW50IChuYW1pbmcgd2hvIGRpZCBpdCksIHRoZSBzYW1lIHRhaWwgZmFjdC4gUmV0dXJucyB0aGUgcGF0aFxuICAgKiB0aGUgY2hhbmdlIGxhbmRlZCBhdCwgd2hpY2ggdGhlIHN1cmZhY2UgdXNlcyB0byBvcGVuIG9yIHJlbmFtZSBpdC5cbiAgICovXG4gIGNvbnN0IFNUUlVDVFVSRV9PUFMgPSBuZXcgU2V0PHN0cmluZz4oW1xuICAgIFwiZG9jLmNyZWF0ZVwiLFxuICAgIFwiZm9sZGVyLmNyZWF0ZVwiLFxuICAgIFwibW92ZVwiLFxuICAgIFwicmVuYW1lXCIsXG4gICAgXCJoaWRlXCIsXG4gICAgXCJ1bmhpZGVcIixcbiAgICBcInNldC5tYWtlXCIsXG4gICAgXCJpbXBvcnRcIixcbiAgICBcIndvcmtzcGFjZS5zZXRcIixcbiAgXSBzYXRpc2ZpZXMgU3RydWN0dXJlT3BbXCJ0eXBlXCJdW10pO1xuICBjb25zdCBpc1N0cnVjdHVyZU9wID0gKG06IHsgdHlwZTogc3RyaW5nIH0pOiBtIGlzIFN0cnVjdHVyZU9wID0+IFNUUlVDVFVSRV9PUFMuaGFzKG0udHlwZSk7XG5cbiAgY29uc3Qgc3RydWN0dXJlID0gKG9wOiBTdHJ1Y3R1cmVPcCwgYnk6IFwiaHVtYW5cIiB8IFwiYWdlbnRcIik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+IHtcbiAgICBjb25zdCB3aG8gPSBieSA9PT0gXCJhZ2VudFwiID8gXCJBZ2VudFwiIDogXCJZb3VcIjtcbiAgICBjb25zdCBzaG93biA9IChwOiBzdHJpbmcpID0+IHNlc3Npb24uZGlzcGxheShwKTtcbiAgICBsZXQgcjogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gJiB7IHBhdGg/OiBzdHJpbmcgfTtcbiAgICBsZXQgbGluZTogc3RyaW5nO1xuICAgIHN3aXRjaCAob3AudHlwZSkge1xuICAgICAgY2FzZSBcImRvYy5jcmVhdGVcIjpcbiAgICAgICAgciA9IHNlc3Npb24uY3JlYXRlRG9jKG9wLmRpciwgb3AubmFtZSk7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IGNyZWF0ZWQgJHtzaG93bihyLnBhdGggYXMgc3RyaW5nKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiZm9sZGVyLmNyZWF0ZVwiOlxuICAgICAgICByID0gc2Vzc2lvbi5jcmVhdGVGb2xkZXIob3AuZGlyLCBvcC5uYW1lKTtcbiAgICAgICAgbGluZSA9IGAke3dob30gY3JlYXRlZCB0aGUgZm9sZGVyICR7c2hvd24oci5wYXRoIGFzIHN0cmluZyl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIm1vdmVcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5tb3ZlKG9wLnBhdGgsIG9wLmludG8pO1xuICAgICAgICByID0gbTtcbiAgICAgICAgbGluZSA9IGAke3dob30gbW92ZWQgJHtzaG93bihtLmZyb20pfSB0byAke3Nob3duKG0ucGF0aCl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInJlbmFtZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLnJlbmFtZShvcC5wYXRoLCBvcC5uYW1lKTtcbiAgICAgICAgciA9IG07XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IHJlbmFtZWQgJHtzaG93bihtLmZyb20pfSB0byAke3Nob3duKG0ucGF0aCl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImhpZGVcIjoge1xuICAgICAgICBjb25zdCBoID0gc2Vzc2lvbi5oaWRlKG9wLnBhdGgpO1xuICAgICAgICByID0gaDtcbiAgICAgICAgbGluZSA9IGAke3dob30gcmVtb3ZlZCAke3Nob3duKGgucGF0aCl9IGZyb20gU2NyaXB0b3JpdW0gKHRoZSBmaWxlIGlzIHN0aWxsIG9uIGRpc2spLmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInVuaGlkZVwiOiB7XG4gICAgICAgIGNvbnN0IHUgPSBzZXNzaW9uLnVuaGlkZShvcC5lbnRyeSk7XG4gICAgICAgIHIgPSB1O1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBicm91Z2h0IGJhY2sgJHt1LnJlc3RvcmVkfSBoaWRkZW4gaXRlbSR7dS5yZXN0b3JlZCA9PT0gMSA/IFwiXCIgOiBcInNcIn0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwic2V0Lm1ha2VcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5tYWtlU2V0KG9wLnBhdGgpO1xuICAgICAgICByID0gbTtcbiAgICAgICAgbGluZSA9IGAke3dob30gdHVybmVkICR7YmFzZW5hbWUobS5wYXRoKX0gaW50byBhIHNldDogJHtzaG93bihtLmZvbGRlcil9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImltcG9ydFwiOlxuICAgICAgICByID0gc2Vzc2lvbi5pbXBvcnRUZXh0KG9wLm5hbWUsIG9wLnRleHQsIG9wLmludG8pO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBjb3BpZWQgJHtvcC5uYW1lfSBpbiBhcyAke3Nob3duKHIucGF0aCBhcyBzdHJpbmcpfS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ3b3Jrc3BhY2Uuc2V0XCI6XG4gICAgICAgIHIgPSBzZXNzaW9uLnNldFdvcmtzcGFjZShvcC5wYXRoKTtcbiAgICAgICAgbGluZSA9IGAke3dob30gc2V0IHRoZSB3b3Jrc3BhY2UgdG8gJHtzaG93bihyLnBhdGggYXMgc3RyaW5nKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgfVxuICAgIHN5bmNXYXRjaGVycygpO1xuICAgIGFubm91bmNlKGxpbmUsIHsgZmFjdDogb3AudHlwZSwgYnksIC4uLnIgfSk7XG4gICAgcmV0dXJuIHI7XG4gIH07XG5cbiAgLy8gLS0tIHN1cmZhY2UgbWVzc2FnZXMgKFdlYlNvY2tldCkgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgcmVwbHkgPSAod3M6IGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4sIG1zZzogU2VydmVyTXNnKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkobXNnKSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBnb25lICovXG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGhhbmRsZUNsaWVudE1zZyA9ICh3czogaW1wb3J0KFwiYnVuXCIpLlNlcnZlcldlYlNvY2tldDx1bmtub3duPiwgbXNnOiBDbGllbnRNc2cpID0+IHtcbiAgICBpZiAoaXNTdHJ1Y3R1cmVPcChtc2cpKSB7XG4gICAgICBjb25zdCByID0gc3RydWN0dXJlKGFuY2hvclN1cmZhY2VQYXRocyhtc2cpLCBcImh1bWFuXCIpO1xuICAgICAgaWYgKHR5cGVvZiByLnBhdGggPT09IFwic3RyaW5nXCIpXG4gICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwic3RydWN0dXJlLmRvbmVcIiwgb3A6IG1zZy50eXBlLCBwYXRoOiByLnBhdGggfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHN3aXRjaCAobXNnLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJvcGVuXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ub3BlblBhdGgobXNnLnBhdGgpO1xuICAgICAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgLy8gVGhlIG9wZW5lciBnZXRzIHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgc3RyYWlnaHQgYXdheSDigJQgdGhlIHN0YXRlXG4gICAgICAgIC8vIHNuYXBzaG90IGNhcnJpZXMgbm8gdGV4dHMsIGFuZCBhIHZpZXdlciBtdXN0IG5vdCB3YWl0IG9uIGEgc2Vjb25kIGFzay5cbiAgICAgICAge1xuICAgICAgICAgIGNvbnN0IGQgPSBzZXNzaW9uLmRvYyhyLnNsdWcpO1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgICAgICAgIHRleHQ6IHNlc3Npb24ucmVhZFZlcnNpb24oci5zbHVnLCBkLmFjdGl2ZSkudGV4dCxcbiAgICAgICAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHIuY3JlYXRlZClcbiAgICAgICAgICBsb2cuZW1pdCh7IHR5cGU6IFwiZG9jLm9wZW5lZFwiLCBkb2M6IHIuc2x1ZywgcGF0aDogc2Vzc2lvbi5hY3RpdmVQYXRoKHIuc2x1ZykgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJvcGVuLmRvY1wiOlxuICAgICAgICBzZXNzaW9uLm9wZW5TbHVnKG1zZy5kb2MpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwiZWRpdFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmVkaXQobXNnLmRvYywgbXNnLnZlcnNpb24sIG1zZy50ZXh0KTtcbiAgICAgICAgaWYgKHIucHJlc2VydmVkKSB7XG4gICAgICAgICAgY29uc3QgZCA9IHNlc3Npb24uZG9jKG1zZy5kb2MpO1xuICAgICAgICAgIGFubm91bmNlT3V0c2lkZShcbiAgICAgICAgICAgIGQuc2x1ZyxcbiAgICAgICAgICAgIG1zZy52ZXJzaW9uLFxuICAgICAgICAgICAgc2Vzc2lvbi5hY3RpdmVQYXRoKGQuc2x1ZykgPz8gXCJcIixcbiAgICAgICAgICAgIHIucHJlc2VydmVkLm4sXG4gICAgICAgICAgICByLnByZXNlcnZlZC5wYXRoLFxuICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSBpZiAoci5kaXJ0eUNoYW5nZWQpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzZWxlY3RcIjpcbiAgICAgICAgLy8gQU1CSUVOVCBzdGF0ZTogc3RvcmVkIGFuZCBzaG93biwgbmV2ZXIgcHVzaGVkIG9udG8gdGhlIGFnZW50J3MgdGFpbC5cbiAgICAgICAgc2VsZWN0aW9uID0gbXNnLnNlbGVjdGlvbjtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInNheVwiOiB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBtc2cudGV4dC50cmltKCk7XG4gICAgICAgIGlmICghdGV4dCkgcmV0dXJuO1xuICAgICAgICBjb25zdCBzZWwgPSBtc2cud2l0aFNlbGVjdGlvbiA/IHNlbGVjdGlvbiA6IG51bGw7XG4gICAgICAgIGNvbnN0IGFjdGl2ZVBhdGggPSBzZWwgPyBzZXNzaW9uLmFjdGl2ZVBhdGgoc2VsLmRvYykgOiBzZXNzaW9uLmFjdGl2ZVBhdGgoKTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcImh1bWFuXCIsIHRleHQsIHsgc2VsZWN0aW9uOiBzZWwsIGFjdGl2ZVBhdGggfSk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcIm1lc3NhZ2VcIixcbiAgICAgICAgICBtZXNzYWdlX2lkOiBtLmlkLFxuICAgICAgICAgIHRleHQsXG4gICAgICAgICAgc2VsZWN0aW9uOiBzZWwsXG4gICAgICAgICAgYWN0aXZlOiBhY3RpdmVPZihzZWw/LmRvYyksXG4gICAgICAgICAgdHM6IG0udHMsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiYWN0aXZhdGVcIjpcbiAgICAgICAgYWN0aXZhdGUobXNnLmRvYywgbXNnLnZlcnNpb24sIFwiaHVtYW5cIik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJub3RlLmFkZFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmFkZE5vdGUoe1xuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICBib2R5OiBtc2cuYm9keSxcbiAgICAgICAgICB3aG86IFwiaHVtYW5cIixcbiAgICAgICAgICByYW5nZTogeyBmcm9tOiBtc2cuZnJvbSwgdG86IG1zZy50byB9LFxuICAgICAgICB9KTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcIm5vdGUuYWRkZWRcIiwgZG9jOiByLnNsdWcsIG5vdGU6IHIubm90ZS5pZCwgYnk6IFwiaHVtYW5cIiB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2suZG9uZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmZpbmlzaFRhc2sobXNnLmlkLCBtc2cub3V0Y29tZSk7XG4gICAgICAgIGlmICghci5hbHJlYWR5KSB7XG4gICAgICAgICAgc2Vzc2lvbi5hZGRNZXNzYWdlKFwic3lzdGVtXCIsIGBEb25lOiAke3IudGFzay50ZXh0fWApO1xuICAgICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJ0YXNrLmRvbmVcIiwgdGFzazogci50YXNrLmlkLCBieTogXCJodW1hblwiIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ0YXNrLnJlbW92ZVwiOiB7XG4gICAgICAgIHNlc3Npb24ucmVtb3ZlVGFzayhtc2cuaWQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFza3MuY2xlYXJcIjoge1xuICAgICAgICBzZXNzaW9uLmNsZWFyRG9uZVRhc2tzKCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJub3RlLmVkaXRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5lZGl0Tm90ZSh7IGRvYzogbXNnLmRvYywgaWQ6IG1zZy5pZCwgYm9keTogbXNnLmJvZHkgfSk7XG4gICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJub3RlLmVkaXRlZFwiLCBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCBieTogXCJodW1hblwiIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5yZXNvbHZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVzb2x2ZU5vdGUoeyBkb2M6IG1zZy5kb2MsIGlkOiBtc2cuaWQsIHJlc29sdmVkOiBtc2cucmVzb2x2ZWQgfSk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBtc2cucmVzb2x2ZWQgPyBcIm5vdGUucmVzb2x2ZWRcIiA6IFwibm90ZS5yZW9wZW5lZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIG5vdGU6IHIubm90ZS5pZCxcbiAgICAgICAgICBieTogXCJodW1hblwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUucmVtb3ZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVtb3ZlTm90ZSh7IGRvYzogbXNnLmRvYywgaWQ6IG1zZy5pZCB9KTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcIm5vdGUucmVtb3ZlZFwiLCBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCBieTogXCJodW1hblwiIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwidmVyc2lvbi5kZWxldGVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5kZWxldGVWZXJzaW9uKHsgZG9jOiBtc2cuZG9jLCB2ZXJzaW9uOiBtc2cudmVyc2lvbiB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBEZWxldGVkIHYke3IudmVyc2lvbn0gb2YgJHtyLnNsdWd9JHtyLmxhYmVsID8gYCDigJQgJHtyLmxhYmVsfWAgOiBcIlwifS5gLFxuICAgICAgICApO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLmRlbGV0ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgYnk6IFwiaHVtYW5cIixcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLm5ld1wiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm5ld1ZlcnNpb24oe1xuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICAuLi4obXNnLmZyb20gPT09IHVuZGVmaW5lZCA/IHt9IDogeyBmcm9tOiBtc2cuZnJvbSB9KSxcbiAgICAgICAgICAuLi4obXNnLmxhYmVsID8geyBsYWJlbDogbXNnLmxhYmVsIH0gOiB7fSksXG4gICAgICAgICAgYXV0aG9yOiBcImh1bWFuXCIsXG4gICAgICAgIH0pO1xuICAgICAgICAvLyDim5QgU0FZIFdIRVJFIFRIRVkgQVJFLCBub3QganVzdCB3aGF0IHdhcyBtYWRlIChFNDIpLiBUaGUgb2xkIG1lc3NhZ2VcbiAgICAgICAgLy8gYW5ub3VuY2VkIHRoZSBuZXcgdmVyc2lvbiBhbmQgd2VudCBxdWlldCBhYm91dCB3aGljaCBvbmUgdGhlIGh1bWFuXG4gICAgICAgIC8vIHdhcyBlZGl0aW5nIOKAlCB3aGljaCBpcyBleGFjdGx5IGhvdyBzb21lb25lIHR5cGVzIGludG8gdjEgYmVsaWV2aW5nXG4gICAgICAgIC8vIHRoZXkgYXJlIGluIHYyLlxuICAgICAgICBpZiAobXNnLmFjdGl2YXRlKSBzZXNzaW9uLmFjdGl2YXRlKHsgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbi5uIH0pO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgICAgIFwic3lzdGVtXCIsXG4gICAgICAgICAgYE1hZGUgdiR7ci52ZXJzaW9uLm59IG9mICR7ci5zbHVnfSBmcm9tIHYke3IudmVyc2lvbi5mcm9tfSR7bXNnLmxhYmVsID8gYCDigJQgJHttc2cubGFiZWx9YCA6IFwiXCJ9LiBgICtcbiAgICAgICAgICAgIChtc2cuYWN0aXZhdGVcbiAgICAgICAgICAgICAgPyBgWW91IGFyZSBub3cgZWRpdGluZyB2JHtyLnZlcnNpb24ubn0uYFxuICAgICAgICAgICAgICA6IGBZb3UgYXJlIHN0aWxsIGVkaXRpbmcgdiR7ci52ZXJzaW9uLmZyb219LmApLFxuICAgICAgICApO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLmNyZWF0ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24ubixcbiAgICAgICAgICBmcm9tOiByLnZlcnNpb24uZnJvbSxcbiAgICAgICAgICBhY3RpdmF0ZWQ6IG1zZy5hY3RpdmF0ZSA9PT0gdHJ1ZSxcbiAgICAgICAgICBieTogXCJodW1hblwiLFxuICAgICAgICAgIHRzOiBtLnRzLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInNhdmVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5zYXZlKG1zZy5kb2MpO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwic3lzdGVtXCIsIGBTYXZlZCB2JHtyLnZlcnNpb259IHRvICR7ci5vcmlnaW5hbH0uYCk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcInNhdmVkXCIsXG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICBvcmlnaW5hbDogci5vcmlnaW5hbCxcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJyZXZlcnRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXZlcnQobXNnLmRvYyk7XG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiByLnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBSZXZlcnRlZCB2JHtyLnZlcnNpb259IG9mICR7bXNnLmRvY30gdG8gdGhlIHNhdmVkIGZpbGUuYCxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcInJldmVydGVkXCIsIGRvYzogbXNnLmRvYywgdmVyc2lvbjogci52ZXJzaW9uLCB0czogbS50cyB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImNvbnRleHQuYWRkXCI6XG4gICAgICAgIGFkZFBhdGhzKFtzdXJmYWNlUGF0aChtc2cucGF0aCldKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInJldmVhbFwiOlxuICAgICAgICByZXZlYWxQYXRoKHNlc3Npb24uc2hvd25QYXRoKHN1cmZhY2VQYXRoKG1zZy5wYXRoKSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwicmV2ZWFsLnZlcnNpb25cIjpcbiAgICAgICAgLy8gVGhlIGRhZW1vbiByZXNvbHZlcyBpdCwgc28gdGhlIHN1cmZhY2UgbmV2ZXIgbmFtZXMgYSBwYXRoIG91dHNpZGVcbiAgICAgICAgLy8gd2hhdCB0aGUgc2Vzc2lvbiBhbHJlYWR5IG93bnMuXG4gICAgICAgIHJldmVhbFBhdGgoc2Vzc2lvbi5yZWFkVmVyc2lvbihtc2cuZG9jLCBtc2cudmVyc2lvbikucGF0aCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJwaWNrXCI6IHtcbiAgICAgICAgdm9pZCBvcGVuUGlja2VyKHdzLCBtc2cud2FudCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJjb250ZXh0LnJlbW92ZVwiOlxuICAgICAgICBzZXNzaW9uLnJlbW92ZUNvbnRleHQobXNnLmlkKTtcbiAgICAgICAgc3luY1dhdGNoZXJzKCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJyZWFkXCI6IHtcbiAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBtc2cudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKG1zZy5kb2MsIG1zZy52ZXJzaW9uKS50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiZGlmZlwiOiB7XG4gICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZGlmZlwiLCAuLi5zZXNzaW9uLmNvbXBhcmUoeyBkb2M6IG1zZy5kb2MsIGFnYWluc3Q6IG1zZy5hZ2FpbnN0IH0pIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibWVyZ2VcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5tZXJnZSh7IGRvYzogbXNnLmRvYywgYWdhaW5zdDogbXNnLmFnYWluc3QsIGh1bmtzOiBtc2cuaHVua3MgfSk7XG4gICAgICAgIC8vIFRoZSBidWZmZXIgdGhlIGh1bWFuIGlzIGxvb2tpbmcgYXQgbXVzdCBiZSB0b2xkOiB0aGUgbWVyZ2Ugd3JvdGUgdGhlXG4gICAgICAgIC8vIGFjdGl2ZSB2ZXJzaW9uJ3MgRklMRSwgYW5kIHRoZSBlZGl0b3IncyB0ZXh0IGlzIG5vdyBiZWhpbmQgaXQuXG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IHIudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgICAgIFwic3lzdGVtXCIsXG4gICAgICAgICAgYFRvb2sgJHtyLmFwcGxpZWR9IGNoYW5nZSR7ci5hcHBsaWVkID09PSAxID8gXCJcIiA6IFwic1wifSBmcm9tICR7c2lkZU5hbWUobXNnLmFnYWluc3QsIHNlc3Npb24uZG9jKHIuc2x1ZykubmFtZSl9IGludG8gdiR7ci52ZXJzaW9ufSBvZiAke3Iuc2x1Z30uYCxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgIHR5cGU6IFwibWVyZ2VkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIGFnYWluc3Q6IG1zZy5hZ2FpbnN0LFxuICAgICAgICAgIGh1bmtzOiBtc2cuaHVua3MsXG4gICAgICAgICAgYnk6IFwiaHVtYW5cIixcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJwcmVmcy5zZXRcIjoge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgIVBSRUZfS0VZLnRlc3QobXNnLmtleSkgfHxcbiAgICAgICAgICB0eXBlb2YgbXNnLnZhbHVlICE9PSBcInN0cmluZ1wiIHx8XG4gICAgICAgICAgbXNnLnZhbHVlLmxlbmd0aCA+IFBSRUZfVkFMVUVfTUFYXG4gICAgICAgIClcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYHJlZnVzZWQgcHJlZiAke0pTT04uc3RyaW5naWZ5KG1zZy5rZXkpfWApO1xuICAgICAgICBjb25zdCBjdXJyZW50ID0gcmVhZFByZWZzKCk7XG4gICAgICAgIGlmIChjdXJyZW50W21zZy5rZXldID09PSBtc2cudmFsdWUpIHJldHVybjtcbiAgICAgICAgaWYgKCEobXNnLmtleSBpbiBjdXJyZW50KSAmJiBPYmplY3Qua2V5cyhjdXJyZW50KS5sZW5ndGggPj0gUFJFRl9LRVlTX01BWClcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgcmVmdXNlZCBwcmVmICR7SlNPTi5zdHJpbmdpZnkobXNnLmtleSl9OiAke1BSRUZfS0VZU19NQVh9IGtleXMgYWxyZWFkeSBrZXB0YCxcbiAgICAgICAgICApO1xuICAgICAgICB3cml0ZUZpbGVBdG9taWMoXG4gICAgICAgICAgcHJlZnNGaWxlLFxuICAgICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgLi4uY3VycmVudCwgW21zZy5rZXldOiBtc2cudmFsdWUgfSwgbnVsbCwgMil9XFxuYCxcbiAgICAgICAgKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImdyYXBoXCI6IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImdyYXBoXCIsIGVudHJ5OiBtc2cuZW50cnksIGdyYXBoOiBzZXNzaW9uLmdyYXBoRm9yKG1zZy5lbnRyeSkgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJncmFwaFwiLFxuICAgICAgICAgICAgZW50cnk6IG1zZy5lbnRyeSxcbiAgICAgICAgICAgIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImxpbmsub3BlblwiOiB7XG4gICAgICAgIC8vIEUzMzogYSBsaW5rIGluc2lkZSB0aGUgYnVuZGxlIGlzIEZPTExPV0VEOyBvbmUgdGhhdCBlc2NhcGVzIGl0IGlzXG4gICAgICAgIC8vIHJlcG9ydGVkIHNvIHRoZSBzdXJmYWNlIGNhbiBvZmZlciB0byBhZGQgaXQsIG5ldmVyIGFkZGVkIHNpbGVudGx5LlxuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXNvbHZlTGluayhtc2cuZnJvbSwgbXNnLnRhcmdldCk7XG4gICAgICAgIGlmIChyLnN0YXRlID09PSBcImluLWJ1bmRsZVwiKSB7XG4gICAgICAgICAgc2Vzc2lvbi5vcGVuUGF0aChyLnBhdGgpO1xuICAgICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgICAgY29uc3QgZCA9IHNlc3Npb24uZG9jKHNlc3Npb24ub3BlbkRvY1NsdWcgPz8gXCJcIik7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgICBkb2M6IGQuc2x1ZyxcbiAgICAgICAgICAgIHZlcnNpb246IGQuYWN0aXZlLFxuICAgICAgICAgICAgdGV4dDogc2Vzc2lvbi5yZWFkVmVyc2lvbihkLnNsdWcsIGQuYWN0aXZlKS50ZXh0LFxuICAgICAgICAgICAgb3JpZ2luOiBcImxvYWRcIixcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgIHR5cGU6IFwibGluay50YXJnZXRcIixcbiAgICAgICAgICB0YXJnZXQ6IG1zZy50YXJnZXQsXG4gICAgICAgICAgc3RhdGU6IHIuc3RhdGUsXG4gICAgICAgICAgLi4uKHIuc3RhdGUgPT09IFwibWlzc2luZ1wiID8ge30gOiB7IHBhdGg6IHIucGF0aCB9KSxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJtZXRhLnN1Z2dlc3RcIjoge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnN1Z2dlc3RNZXRhKG1zZy5wYXRoLCBcImh1bWFuXCIpO1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcIm1ldGEuc3VnZ2VzdGlvblwiLFxuICAgICAgICAgICAgcGF0aDogbXNnLnBhdGgsXG4gICAgICAgICAgICBibG9jazogci5ibG9jayxcbiAgICAgICAgICAgIC4uLihyLnR5cGUgPyB7IHN1Z2dlc3RlZFR5cGU6IHIudHlwZSB9IDoge30pLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwibWV0YS5zdWdnZXN0aW9uXCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1vdmUucGxhblwiOiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwibW92ZS5wbGFuXCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGludG86IG1zZy5pbnRvLFxuICAgICAgICAgICAgcGxhbjogc2Vzc2lvbi5tb3ZlUGxhbihzdXJmYWNlUGF0aChtc2cucGF0aCksIHN1cmZhY2VQYXRoKG1zZy5pbnRvKSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJtb3ZlLnBsYW5cIixcbiAgICAgICAgICAgIHBhdGg6IG1zZy5wYXRoLFxuICAgICAgICAgICAgaW50bzogbXNnLmludG8sXG4gICAgICAgICAgICBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmcy5saXN0XCI6IHtcbiAgICAgICAgY29uc3QgcGF0aCA9IGV4cGFuZEhvbWUobXNnLnBhdGgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZnMubGlzdFwiLCBwYXRoOiBtc2cucGF0aCwgZW50cmllczogbGlzdERpcihwYXRoKSB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcImZzLmxpc3RcIixcbiAgICAgICAgICAgIHBhdGg6IG1zZy5wYXRoLFxuICAgICAgICAgICAgZW50cmllczogW10sXG4gICAgICAgICAgICBlcnJvcjogU3RyaW5nKChlIGFzIEVycm9yKS5tZXNzYWdlKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIC8vIOKUgOKUgCB0aGUgbmF0aXZlIHBpY2tlciAob25lIGRpYWxvZyBhdCBhIHRpbWUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvL1xuICAvLyBBIG1vZGFsIGRpYWxvZyBvd25zIHRoZSBodW1hbidzIGF0dGVudGlvbiwgYW5kIGEgc2Vjb25kIG9uZSBiZWhpbmQgdGhlXG4gIC8vIGZpcnN0IGNhbm5vdCBiZSBzZWVuIG9yIGRpc21pc3NlZCDigJQgc28gYSByZXF1ZXN0IHdoaWxlIG9uZSBpcyBvcGVuIGlzXG4gIC8vIHJlZnVzZWQgaW4gd29yZHMgcmF0aGVyIHRoYW4gcXVldWVkLlxuICBsZXQgcGlja2VyT3BlbiA9IGZhbHNlO1xuICBjb25zdCB6ZW5pdHkgPSBwcm9jZXNzLnBsYXRmb3JtID09PSBcImxpbnV4XCIgPyBCdW4ud2hpY2goXCJ6ZW5pdHlcIikgOiBudWxsO1xuICBjb25zdCBvcGVuUGlja2VyID0gYXN5bmMgKFxuICAgIHdzOiBpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+LFxuICAgIHdhbnQ6IFwiY29udGV4dC1maWxlXCIgfCBcImNvbnRleHQtZm9sZGVyXCIgfCBcIndvcmtzcGFjZVwiLFxuICApID0+IHtcbiAgICBpZiAocGlja2VyT3Blbikge1xuICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBcImEgZmlsZSBwaWNrZXIgaXMgYWxyZWFkeSBvcGVuXCIgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGtpbmQ6IFBpY2tLaW5kID0gd2FudCA9PT0gXCJjb250ZXh0LWZpbGVcIiA/IFwiZmlsZVwiIDogXCJmb2xkZXJcIjtcbiAgICBjb25zdCBwcm9tcHQgPVxuICAgICAgd2FudCA9PT0gXCJ3b3Jrc3BhY2VcIlxuICAgICAgICA/IFwiQ2hvb3NlIHRoZSB3b3Jrc3BhY2UgZm9sZGVyIGZvciBzY3JpcHRvcml1bVwiXG4gICAgICAgIDogd2FudCA9PT0gXCJjb250ZXh0LWZvbGRlclwiXG4gICAgICAgICAgPyBcIkNob29zZSBhIGZvbGRlciB0byBhZGQgdG8gc2NyaXB0b3JpdW1cIlxuICAgICAgICAgIDogXCJDaG9vc2UgZG9jdW1lbnRzIHRvIGFkZCB0byBzY3JpcHRvcml1bVwiO1xuICAgIGNvbnN0IGNtZCA9IHBpY2tlckNvbW1hbmQocHJvY2Vzcy5wbGF0Zm9ybSwga2luZCwgcHJvbXB0LCB6ZW5pdHkpO1xuICAgIGlmICghY21kKSB7XG4gICAgICByZXBseSh3cywge1xuICAgICAgICB0eXBlOiBcImVycm9yXCIsXG4gICAgICAgIG1lc3NhZ2U6IGBubyBmaWxlIHBpY2tlciBvbiB0aGlzIHN5c3RlbSAoJHtwcm9jZXNzLnBsYXRmb3JtfSkg4oCUIHR5cGUgdGhlIHBhdGggaW5zdGVhZGAsXG4gICAgICB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgcGlja2VyT3BlbiA9IHRydWU7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHByb2MgPSBCdW4uc3Bhd24oY21kLCB7IHN0ZG91dDogXCJwaXBlXCIsIHN0ZGVycjogXCJwaXBlXCIsIHN0ZGluOiBcImlnbm9yZVwiIH0pO1xuICAgICAgY29uc3QgW291dCwgY29kZV0gPSBhd2FpdCBQcm9taXNlLmFsbChbbmV3IFJlc3BvbnNlKHByb2Muc3Rkb3V0KS50ZXh0KCksIHByb2MuZXhpdGVkXSk7XG4gICAgICB0b3VjaCgpOyAvLyBhIGh1bWFuIHN0b29kIGF0IGEgZGlhbG9nOyB0aGUgc2Vzc2lvbiBpcyBub3QgaWRsZVxuICAgICAgY29uc3QgcGF0aHMgPSBwYXJzZVBpY2tlck91dHB1dChvdXQpO1xuICAgICAgaWYgKHBhdGhzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAvLyBDYW5jZWxsZWQ6IG5vdGhpbmcgY2hvc2VuLCBub3RoaW5nIHNhaWQuIEEgcmVhbCBmYWlsdXJlIGlzIHNhaWQuXG4gICAgICAgIGlmICghd2FzQ2FuY2VsbGVkKGNvZGUsIG91dCkpXG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBgdGhlIGZpbGUgcGlja2VyIGZhaWxlZCAoZXhpdCAke2NvZGV9KWAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIFdoYXQgd2FzIGNob3NlbiBpcyBhZG1pdHRlZCBsaWtlIGFueSBvdGhlciBwYXRoIOKAlCBhIHBpY2tlZCBmaWxlIHRoYXRcbiAgICAgIC8vIHNjcmlwdG9yaXVtIGRvZXMgbm90IG9wZW4gaXMgcmVmdXNlZCBpbiB0aGUgc2lkZWJhcidzIG93biB3b3JkcywgYW5kXG4gICAgICAvLyB0aGF0IHJlZnVzYWwgbXVzdCBub3QgcmVhZCBhcyBcInRoZSBwaWNrZXIgZmFpbGVkXCIuXG4gICAgICB0cnkge1xuICAgICAgICBpZiAod2FudCA9PT0gXCJ3b3Jrc3BhY2VcIilcbiAgICAgICAgICBzdHJ1Y3R1cmUoeyB0eXBlOiBcIndvcmtzcGFjZS5zZXRcIiwgcGF0aDogcGF0aHNbMF0gYXMgc3RyaW5nIH0sIFwiaHVtYW5cIik7XG4gICAgICAgIGVsc2UgYWRkUGF0aHMocGF0aHMpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICByZXBseSh3cywge1xuICAgICAgICB0eXBlOiBcImVycm9yXCIsXG4gICAgICAgIG1lc3NhZ2U6IGBjb3VsZCBub3Qgb3BlbiB0aGUgZmlsZSBwaWNrZXI6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfWAsXG4gICAgICB9KTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcGlja2VyT3BlbiA9IGZhbHNlO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBhY3RpdmVPZiA9IChkb2M/OiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCBzbHVnID0gZG9jID8/IHNlc3Npb24ub3BlbkRvY1NsdWc7XG4gICAgaWYgKCFzbHVnKSByZXR1cm4gbnVsbDtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdiA9IHNlc3Npb24uZG9jKHNsdWcpO1xuICAgICAgcmV0dXJuIHsgZG9jOiB2LnNsdWcsIHZlcnNpb246IHYuYWN0aXZlLCBwYXRoOiBzZXNzaW9uLmFjdGl2ZVBhdGgodi5zbHVnKSB9O1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9O1xuXG4gIC8vIC0tLSBhZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGxldCByZXNvbHZlRG9uZSE6ICh2OiB7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmcgfSkgPT4gdm9pZDtcbiAgY29uc3QgZG9uZSA9IG5ldyBQcm9taXNlPHsgY29kZTogbnVtYmVyOyByZWFzb246IHN0cmluZyB9PigocikgPT4ge1xuICAgIHJlc29sdmVEb25lID0gcjtcbiAgfSk7XG5cbiAgLyoqIFNob3cgYSBmaWxlIGluIHRoZSBwbGF0Zm9ybSdzIGZpbGUgbWFuYWdlci4gQW4gYXJndiwgbmV2ZXIgYSBzaGVsbCBzdHJpbmc6XG4gICAqICB0aGUgcGF0aCBpcyBkYXRhLCB3aGF0ZXZlciBpdCBob2xkcy4gKi9cbiAgY29uc3QgcmV2ZWFsUGF0aCA9IChwYXRoOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICBjb25zdCBbY21kLCAuLi5hcmdzXSA9XG4gICAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiXG4gICAgICAgID8gW1wib3BlblwiLCBcIi1SXCIsIHBhdGhdXG4gICAgICAgIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiXG4gICAgICAgICAgPyBbXCJleHBsb3JlclwiLCBgL3NlbGVjdCwke3BhdGh9YF1cbiAgICAgICAgICA6IFtcInhkZy1vcGVuXCIsIGRpcm5hbWUocGF0aCldO1xuICAgIEJ1bi5zcGF3bihbY21kIGFzIHN0cmluZywgLi4uYXJnc10sIHsgc3RkaW86IFtcImlnbm9yZVwiLCBcImlnbm9yZVwiLCBcImlnbm9yZVwiXSB9KS51bnJlZigpO1xuICB9O1xuXG4gIGNvbnN0IGhhbmRsZUFnZW50Q21kID0gKGNtZDogQWdlbnRDbWQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiB7XG4gICAgaWYgKGlzU3RydWN0dXJlT3AoY21kKSkgcmV0dXJuIHN0cnVjdHVyZShjbWQsIFwiYWdlbnRcIik7XG4gICAgc3dpdGNoIChjbWQudHlwZSkge1xuICAgICAgY2FzZSBcIm1ldGFcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24ubWV0YUZvcihjbWQucGF0aCk7XG4gICAgICBjYXNlIFwiZ3JhcGhcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24uZ3JhcGhGb3IoY21kLmVudHJ5KSBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgY2FzZSBcImRhbmdsaW5nXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLmRhbmdsaW5nTGlua3MoY21kLmVudHJ5KTtcbiAgICAgIGNhc2UgXCJiYWNrbGlua3NcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24uYmFja2xpbmtzKGNtZC5wYXRoKTtcbiAgICAgIGNhc2UgXCJtZXRhLmluaXRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5tZXRhSW5pdChjbWQucGF0aCwge1xuICAgICAgICAgIC4uLihjbWQubWV0YVR5cGUgPyB7IHR5cGU6IGNtZC5tZXRhVHlwZSB9IDoge30pLFxuICAgICAgICAgIGJ5OiBjbWQuYnkgPz8gXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoYEFnZW50IGFkZGVkIGZyb250bWF0dGVyIHRvICR7c2Vzc2lvbi5kaXNwbGF5KFN0cmluZyhyLnBhdGgpKX0uYCwge1xuICAgICAgICAgIGZhY3Q6IFwibWV0YS5pbml0XCIsXG4gICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgICAuLi5yLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHI7XG4gICAgICB9XG4gICAgICBjYXNlIFwibWV0YS5zZXRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5tZXRhU2V0KGNtZC5wYXRoLCBjbWQuZmllbGRzKTtcbiAgICAgICAgYW5ub3VuY2UoXG4gICAgICAgICAgYEFnZW50IHNldCAkeyhyLnNldCBhcyBzdHJpbmdbXSkuam9pbihcIiwgXCIpfSBvbiAke3Nlc3Npb24uZGlzcGxheShTdHJpbmcoci5wYXRoKSl9LmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm1ldGEuc2V0XCIsIGJ5OiBcImFnZW50XCIsIC4uLnIgfSxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIHI7XG4gICAgICB9XG4gICAgICBjYXNlIFwidmVyc2lvbi5kZWxldGVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5kZWxldGVWZXJzaW9uKHsgZG9jOiBjbWQuZG9jLCB2ZXJzaW9uOiBjbWQudmVyc2lvbiB9KTtcbiAgICAgICAgYW5ub3VuY2UoYEFnZW50IGRlbGV0ZWQgdiR7ci52ZXJzaW9ufSBvZiAke3Iuc2x1Z30ke3IubGFiZWwgPyBgIOKAlCAke3IubGFiZWx9YCA6IFwiXCJ9LmAsIHtcbiAgICAgICAgICBmYWN0OiBcInZlcnNpb24uZGVsZXRlZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbiwgcmVtYWluaW5nOiByLnJlbWFpbmluZyB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUuYWRkXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uYWRkTm90ZSh7XG4gICAgICAgICAgZG9jOiBjbWQuZG9jLFxuICAgICAgICAgIGJvZHk6IGNtZC5ib2R5LFxuICAgICAgICAgIHdobzogXCJhZ2VudFwiLFxuICAgICAgICAgIHF1b3RlOiBjbWQucXVvdGUsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShgQWdlbnQgbm90ZWQg4oCcJHtxdW90ZUxhYmVsKHIubm90ZS5xdW90ZSl94oCdIG9uICR7ci5zbHVnfS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJub3RlLmFkZGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgbm90ZTogci5ub3RlLmlkLFxuICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCBxdW90ZTogci5ub3RlLnF1b3RlIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZXNcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5ub3Rlc09mKHsgZG9jOiBjbWQuZG9jLCAuLi4oY21kLmFsbCA/IHsgYWxsOiB0cnVlIH0gOiB7fSkgfSk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCBub3Rlczogci5ub3RlcyB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2sucmVtb3ZlXCI6IHtcbiAgICAgICAgY29uc3QgdCA9IHNlc3Npb24ucmVtb3ZlVGFzayhjbWQuaWQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyB0YXNrOiB0LmlkLCByZW1vdmVkOiB0cnVlIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFza3MuY2xlYXJcIjoge1xuICAgICAgICBjb25zdCBjbGVhcmVkID0gc2Vzc2lvbi5jbGVhckRvbmVUYXNrcygpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyBjbGVhcmVkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwid29ya2luZ1wiOiB7XG4gICAgICAgIC8vIEU1MydzIHNub296ZS4gSXQgZG9lcyBOT1QgcG9zdCB0byB0aGUgY2hhdDogYW4gYWdlbnQgc2F5aW5nIFwic3RpbGxcbiAgICAgICAgLy8gd29ya2luZ1wiIGluIHRoZSBjb252ZXJzYXRpb24gaXMgYSByZXBseSwgYW5kIGl0IGNhbiBkbyB0aGF0IHdpdGhcbiAgICAgICAgLy8gYHNheWAg4oCUIHRoaXMgaXMgdGhlIHF1aWV0ZXIgdGhpbmcsIGZvciB3aGVuIHRoZXJlIGlzIG5vdGhpbmcgdG9cbiAgICAgICAgLy8gcmVwb3J0IHlldCBidXQgdGhlIGFsYXJtIHNob3VsZCBzdG9wLlxuICAgICAgICBjb25zdCBtcyA9IGNtZC5zZWNvbmRzICE9PSB1bmRlZmluZWQgPyBjbWQuc2Vjb25kcyAqIDEwMDAgOiBERUZBVUxUX1NOT09aRV9NUztcbiAgICAgICAgYWNrbm93bGVkZ2VkVW50aWwgPSBEYXRlLm5vdygpICsgTWF0aC5tYXgoMCwgbXMpO1xuICAgICAgICAvLyBXaGF0ZXZlciBpcyBwZW5kaW5nIGlzIGFja25vd2xlZGdlZCwgc28gaXQgbXVzdCBuZXZlciBiZSBudWRnZWQgYWdhaW4uXG4gICAgICAgIGNvbnN0IHcgPSB3YWl0aW5nT24oc2Vzc2lvbi5tZXNzYWdlcygpLCBEYXRlLm5vdygpLCB7IGFja25vd2xlZGdlZFVudGlsIH0pO1xuICAgICAgICBpZiAodykgbnVkZ2VkLmFkZCh3Lm1lc3NhZ2VJZCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgdW50aWw6IGFja25vd2xlZGdlZFVudGlsLFxuICAgICAgICAgIHNlY29uZHM6IE1hdGgucm91bmQoTWF0aC5tYXgoMCwgbXMpIC8gMTAwMCksXG4gICAgICAgICAgLi4uKHcgPyB7IHdhaXRpbmc6IHcubWVzc2FnZUlkIH0gOiB7fSksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFzay5zdGFydFwiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBzZXNzaW9uLnN0YXJ0VGFzayhjbWQudGV4dCwgXCJhZ2VudFwiKTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcInRhc2suc3RhcnRlZFwiLCB0YXNrOiB0LmlkLCB0ZXh0OiB0LnRleHQsIGJ5OiBcImFnZW50XCIgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiB7IHRhc2s6IHQuaWQsIHRleHQ6IHQudGV4dCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2suc3RhdHVzXCI6IHtcbiAgICAgICAgY29uc3QgdCA9IHNlc3Npb24uc2V0VGFza1N0YXR1cyhjbWQuaWQsIGNtZC5zdGF0dXMpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyB0YXNrOiB0LmlkLCBzdGF0dXM6IHQuc3RhdHVzIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFzay5kb25lXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZmluaXNoVGFzayhjbWQuaWQsIGNtZC5vdXRjb21lKTtcbiAgICAgICAgaWYgKCFyLmFscmVhZHkpXG4gICAgICAgICAgYW5ub3VuY2UoYERvbmU6ICR7ci50YXNrLnRleHR9JHtyLnRhc2sub3V0Y29tZSA/IGAg4oCUICR7ci50YXNrLm91dGNvbWV9YCA6IFwiXCJ9YCwge1xuICAgICAgICAgICAgZmFjdDogXCJ0YXNrLmRvbmVcIixcbiAgICAgICAgICAgIHRhc2s6IHIudGFzay5pZCxcbiAgICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiB7IHRhc2s6IHIudGFzay5pZCwgYWxyZWFkeTogci5hbHJlYWR5IH07XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5lZGl0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZWRpdE5vdGUoeyBkb2M6IGNtZC5kb2MsIGlkOiBjbWQuaWQsIGJvZHk6IGNtZC5ib2R5IH0pO1xuICAgICAgICBhbm5vdW5jZShgQWdlbnQgcmV3cm90ZSBhIG5vdGUgb24gJHtyLnNsdWd9OiDigJwke3F1b3RlTGFiZWwoci5ub3RlLnF1b3RlKX3igJ0uYCwge1xuICAgICAgICAgIGZhY3Q6IFwibm90ZS5lZGl0ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICBub3RlOiByLm5vdGUuaWQsXG4gICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCBub3RlOiByLm5vdGUuaWQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJub3RlLnJlc29sdmVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXNvbHZlTm90ZSh7IGRvYzogY21kLmRvYywgaWQ6IGNtZC5pZCwgcmVzb2x2ZWQ6IGNtZC5yZXNvbHZlZCB9KTtcbiAgICAgICAgYW5ub3VuY2UoXG4gICAgICAgICAgYEFnZW50ICR7Y21kLnJlc29sdmVkID8gXCJyZXNvbHZlZFwiIDogXCJyZW9wZW5lZFwifSBhIG5vdGUgb24gJHtyLnNsdWd9OiDigJwke3F1b3RlTGFiZWwoci5ub3RlLnF1b3RlKX3igJ0uYCxcbiAgICAgICAgICB7IGZhY3Q6IFwibm90ZS5yZXNvbHZlZFwiLCBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCBieTogXCJhZ2VudFwiIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCBub3RlOiByLm5vdGUuaWQsIHJlc29sdmVkOiByLm5vdGUucmVzb2x2ZWQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJub3RlLnJlbW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlbW92ZU5vdGUoeyBkb2M6IGNtZC5kb2MsIGlkOiBjbWQuaWQgfSk7XG4gICAgICAgIGFubm91bmNlKGBBZ2VudCByZW1vdmVkIGEgbm90ZSBvbiAke3Iuc2x1Z306IOKAnCR7cXVvdGVMYWJlbChyLm5vdGUucXVvdGUpfeKAnS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJub3RlLnJlbW92ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICBub3RlOiByLm5vdGUuaWQsXG4gICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCBub3RlOiByLm5vdGUuaWQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJkaWZmXCI6IHtcbiAgICAgICAgY29uc3QgcCA9IHNlc3Npb24uY29tcGFyZSh7IGRvYzogY21kLmRvYywgYWdhaW5zdDogY21kLmFnYWluc3QgfSk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgZG9jOiBwLmRvYyxcbiAgICAgICAgICBhY3RpdmU6IHAuYWN0aXZlLFxuICAgICAgICAgIGFnYWluc3Q6IHAuYWdhaW5zdCxcbiAgICAgICAgICBzYW1lOiBwLmRpZmYuc2FtZSxcbiAgICAgICAgICBjb2Fyc2U6IHAuZGlmZi5jb2Fyc2UsXG4gICAgICAgICAgaHVua3M6IHAuZGlmZi5odW5rcyxcbiAgICAgICAgICB1bmlmaWVkOiB1bmlmaWVkKHAuZGlmZiwge1xuICAgICAgICAgICAgZnJvbTogYHYke3AuYWN0aXZlfWAsXG4gICAgICAgICAgICB0bzogc2lkZU5hbWUocC5hZ2FpbnN0LCBzZXNzaW9uLmRvYyhwLmRvYykubmFtZSksXG4gICAgICAgICAgICAuLi4oY21kLmNvbnRleHQgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBjb250ZXh0OiBjbWQuY29udGV4dCB9KSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJtZXJnZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm1lcmdlKHsgZG9jOiBjbWQuZG9jLCBhZ2FpbnN0OiBjbWQuYWdhaW5zdCwgaHVua3M6IGNtZC5odW5rcyB9KTtcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogci50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJyZW1vdGVcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCB0b29rICR7ci5hcHBsaWVkfSBjaGFuZ2Uke3IuYXBwbGllZCA9PT0gMSA/IFwiXCIgOiBcInNcIn0gZnJvbSAke3NpZGVOYW1lKGNtZC5hZ2FpbnN0LCBzZXNzaW9uLmRvYyhyLnNsdWcpLm5hbWUpfSBpbnRvIHYke3IudmVyc2lvbn0gb2YgJHtyLnNsdWd9LmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm1lcmdlZFwiLCBkb2M6IHIuc2x1ZywgdmVyc2lvbjogci52ZXJzaW9uLCBodW5rczogY21kLmh1bmtzLCBieTogXCJhZ2VudFwiIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24sIGFwcGxpZWQ6IHIuYXBwbGllZCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImZpbmRcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24uZmluZChjbWQuZmlsdGVyKTtcbiAgICAgIGNhc2UgXCJjb250ZXh0LmFkZFwiOiB7XG4gICAgICAgIGNvbnN0IGFkZGVkID0gYWRkUGF0aHMoY21kLnBhdGhzKTtcbiAgICAgICAgcmV0dXJuIHsgZW50cmllczogYWRkZWQubWFwKChhKSA9PiAoeyAuLi5hLmVudHJ5LCBhZGRlZDogYS5hZGRlZCB9KSkgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLm5ld1wiOiB7XG4gICAgICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggNzogdGhlIGFnZW50IG1heSBuYW1lIGEgZG9jIHRoZSBodW1hbiBoYXMgbm90XG4gICAgICAgIC8vIG9wZW5lZCwgYnkgQUJTT0xVVEUgcGF0aCAodGhlIENMSSByZXNvbHZlcyBpdCBhZ2FpbnN0IGl0cyBvd24gY3dkKTtcbiAgICAgICAgLy8gaXQgaXMgb3BlbmVkIGltcGxpY2l0bHkgdW5kZXIgdGhlIHNhbWUgYWRtaXNzaW9uIHJ1bGUgYXMgdGhlXG4gICAgICAgIC8vIHN1cmZhY2UncyBgb3BlbmAg4oCUIGEgZG9jLXR5cGUgZmlsZSBpbnNpZGUgYSBjb250ZXh0IGVudHJ5IOKAlCB3aXRob3V0XG4gICAgICAgIC8vIG1vdmluZyB0aGUgaHVtYW4ncyBvcGVuIGRvY3VtZW50LlxuICAgICAgICBpZiAoY21kLmRvYyAmJiBpc0Fic29sdXRlKGNtZC5kb2MpICYmICFzZXNzaW9uLmZpbmREb2MoY21kLmRvYykpIHtcbiAgICAgICAgICBjb25zdCBvID0gc2Vzc2lvbi5vcGVuUGF0aChjbWQuZG9jLCB7IGZvY3VzOiBmYWxzZSB9KTtcbiAgICAgICAgICBpZiAoby5jcmVhdGVkKVxuICAgICAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgICAgICB0eXBlOiBcImRvYy5vcGVuZWRcIixcbiAgICAgICAgICAgICAgZG9jOiBvLnNsdWcsXG4gICAgICAgICAgICAgIHBhdGg6IHNlc3Npb24uYWN0aXZlUGF0aChvLnNsdWcpLFxuICAgICAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubmV3VmVyc2lvbih7XG4gICAgICAgICAgZG9jOiBjbWQuZG9jLFxuICAgICAgICAgIGZyb206IGNtZC5mcm9tLFxuICAgICAgICAgIGxhYmVsOiBjbWQubGFiZWwsXG4gICAgICAgICAgYXV0aG9yOiBcImFnZW50XCIsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShcbiAgICAgICAgICBgQWdlbnQgY3JlYXRlZCB2JHtyLnZlcnNpb24ubn0gb2YgJHtyLnNsdWd9IGZyb20gdiR7ci52ZXJzaW9uLmZyb219JHtjbWQubGFiZWwgPyBgIOKAlCAke2NtZC5sYWJlbH1gIDogXCJcIn0uYCxcbiAgICAgICAgICB7IGZhY3Q6IFwidmVyc2lvbi5jcmVhdGVkXCIsIGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24ubiB9LFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1ZywgdmVyc2lvbjogci52ZXJzaW9uLm4sIGZyb206IHIudmVyc2lvbi5mcm9tLCBwYXRoOiByLnZlcnNpb24ucGF0aCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInNheVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJhZ2VudFwiLCBjbWQudGV4dCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiB7IGlkOiBtLmlkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiYWN0aXZhdGVcIjpcbiAgICAgICAgcmV0dXJuIGFjdGl2YXRlKGNtZC5kb2MsIGNtZC52ZXJzaW9uLCBcImFnZW50XCIpO1xuICAgICAgY2FzZSBcImNsb3NlXCI6XG4gICAgICAgIHJlc29sdmVEb25lKHsgY29kZTogMCwgcmVhc29uOiBcImNsb3NlXCIgfSk7XG4gICAgICAgIHJldHVybiB7fTtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgICAgYHVucmVjb2duaXNlZCBjb21tYW5kIHR5cGUgJHtKU09OLnN0cmluZ2lmeSgoY21kIGFzIHsgdHlwZT86IHVua25vd24gfSkudHlwZSl9IOKAlCBub3RoaW5nIHdhcyBhcHBsaWVkYCxcbiAgICAgICAgICA0MDAsXG4gICAgICAgICAgW1xuICAgICAgICAgICAgXCJjb250ZXh0LmFkZFwiLFxuICAgICAgICAgICAgXCJ2ZXJzaW9uLm5ld1wiLFxuICAgICAgICAgICAgXCJzYXlcIixcbiAgICAgICAgICAgIFwiYWN0aXZhdGVcIixcbiAgICAgICAgICAgIFwiY2xvc2VcIixcbiAgICAgICAgICAgIFwibWV0YVwiLFxuICAgICAgICAgICAgXCJmaW5kXCIsXG4gICAgICAgICAgICBcImdyYXBoXCIsXG4gICAgICAgICAgICBcImJhY2tsaW5rc1wiLFxuICAgICAgICAgICAgXCJtZXRhLmluaXRcIixcbiAgICAgICAgICAgIFwibWV0YS5zZXRcIixcbiAgICAgICAgICAgIC4uLlNUUlVDVFVSRV9PUFMsXG4gICAgICAgICAgXSxcbiAgICAgICAgKTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgcmVmdXNhbCA9IChlOiB1bmtub3duKTogUmVzcG9uc2UgPT4ge1xuICAgIGlmIChlIGluc3RhbmNlb2YgU2Vzc2lvbkVycm9yKVxuICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oXG4gICAgICAgIHsgb2s6IGZhbHNlLCBlcnJvcjogZS5tZXNzYWdlLCAuLi4oZS5jaG9pY2VzID8geyBjaG9pY2VzOiBlLmNob2ljZXMgfSA6IHt9KSB9LFxuICAgICAgICB7IHN0YXR1czogZS5zdGF0dXMgfSxcbiAgICAgICk7XG4gICAgaWYgKGUgaW5zdGFuY2VvZiBQYXRoRXJyb3IpXG4gICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSB9LCB7IHN0YXR1czogNDA0IH0pO1xuICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogU3RyaW5nKGUpIH0sIHsgc3RhdHVzOiA1MDAgfSk7XG4gIH07XG5cbiAgY29uc3QgZXZlbnRzUmVzcG9uc2UgPSAocmVxOiBSZXF1ZXN0LCB1cmw6IFVSTCk6IFJlc3BvbnNlID0+IHtcbiAgICB0b3VjaCgpO1xuICAgIHJldHVybiBzc2VSZXNwb25zZSh7XG4gICAgICBsb2csXG4gICAgICBzaW5jZTogTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic2luY2VcIikgPz8gXCItMVwiLCAxMCksXG4gICAgICBoZWFydGJlYXRNczogU1NFX0hFQVJUQkVBVF9NUyxcbiAgICAgIGNsaWVudHM6IHNzZUNsaWVudHMsXG4gICAgICBzaWduYWw6IHJlcS5zaWduYWwsXG4gICAgICBvbk9wZW46IHRvdWNoLFxuICAgICAgb25DbG9zZTogdG91Y2gsXG4gICAgfSk7XG4gIH07XG5cbiAgLy8gLS0tIHNlcnZlIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc2VydmVyID0gQnVuLnNlcnZlKHtcbiAgICBwb3J0OiBvcHRzLnBvcnQgPz8gMCxcbiAgICBob3N0bmFtZTogXCIxMjcuMC4wLjFcIixcbiAgICByb3V0ZXMsXG4gICAgaWRsZVRpbWVvdXQ6IElETEVfVElNRU9VVF9TRUMsXG4gICAgZGV2ZWxvcG1lbnQ6IHsgaG1yOiBtb2RlID09PSBcImRldlwiIH0sXG4gICAgZmV0Y2gocmVxLCBzcnYpIHtcbiAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmVxLnVybCk7XG4gICAgICBjb25zdCBwYXRoID0gdXJsLnBhdGhuYW1lO1xuICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAxYSDigJQgQSBGT1JFSUdOIE9SSUdJTiBJUyBSRUZVU0VELiBBbnkgd2ViIHBhZ2UgdGhlXG4gICAgICAvLyBodW1hbiB2aXNpdHMgY2FuIG9wZW4gYSBXZWJTb2NrZXQgb3IgUE9TVCB0byAxMjcuMC4wLjE7IHRoZSBicm93c2VyXG4gICAgICAvLyBzZW5kcyBpdHMgT3JpZ2luLCBhbmQgb25seSB0aGlzIGRhZW1vbidzIG93biBwYWdlIG1heSBkcml2ZSBpdC4gVGhlXG4gICAgICAvLyBDTEkncyBmZXRjaCBzZW5kcyBubyBPcmlnaW4gYXQgYWxsLCBzbyBpdCBpcyB1bmFmZmVjdGVkLlxuICAgICAgaWYgKFxuICAgICAgICAocGF0aCA9PT0gXCIvd3NcIiB8fCBwYXRoID09PSBcIi9jbWRcIiB8fCBwYXRoLnN0YXJ0c1dpdGgoXCIvZnMvXCIpKSAmJlxuICAgICAgICAhc2FtZU9yaWdpbihyZXEsIHNydi5wb3J0KVxuICAgICAgKVxuICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IFwiZm9yZWlnbiBvcmlnaW4gcmVmdXNlZFwiIH0sIHsgc3RhdHVzOiA0MDMgfSk7XG4gICAgICBpZiAocGF0aCA9PT0gXCIvd3NcIilcbiAgICAgICAgcmV0dXJuIHNydi51cGdyYWRlKHJlcSkgPyB1bmRlZmluZWQgOiBuZXcgUmVzcG9uc2UoXCJ1cGdyYWRlIHJlcXVpcmVkXCIsIHsgc3RhdHVzOiA0MjYgfSk7XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9zdGF0ZVwiKSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGNvbnN0IHN0YXRlID0gdmlld1N0YXRlKCk7XG4gICAgICAgIGNvbnN0IGZ1bGwgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcImZ1bGxcIikgPT09IFwiMVwiO1xuICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7XG4gICAgICAgICAgLi4uc3RhdGUsXG4gICAgICAgICAgY2hhdDogZnVsbCA/IHN0YXRlLmNoYXQgOiBzdGF0ZS5jaGF0LnNsaWNlKC0xMCksXG4gICAgICAgICAgY2hhdFRvdGFsOiBzdGF0ZS5jaGF0Lmxlbmd0aCxcbiAgICAgICAgICBhY3RpdmU6IGFjdGl2ZU9mKCksXG4gICAgICAgICAgY3Vyc29yOiBsb2cuY3Vyc29yKCksXG4gICAgICAgICAgZXBvY2g6IGxvZy5lcG9jaCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9ldmVudHNcIikgcmV0dXJuIGV2ZW50c1Jlc3BvbnNlKHJlcSwgdXJsKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL2ZzL3ZlcnNpb25cIikge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlYWRWZXJzaW9uKFxuICAgICAgICAgICAgdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJkb2NcIikgPz8gXCJcIixcbiAgICAgICAgICAgIE51bWJlci5wYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInZcIikgPz8gXCJcIiwgMTApLFxuICAgICAgICAgICk7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24ocik7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXR1cm4gcmVmdXNhbChlKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZnMvbGlzdFwiKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oe1xuICAgICAgICAgICAgZW50cmllczogbGlzdERpcihleHBhbmRIb21lKHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwicGF0aFwiKSA/PyBcIn5cIikpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcoKGUgYXMgRXJyb3IpLm1lc3NhZ2UpIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9jbWRcIilcbiAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAudGhlbigoYikgPT4ge1xuICAgICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IHRydWUsIC4uLmhhbmRsZUFnZW50Q21kKGIgYXMgQWdlbnRDbWQpIH0pO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICByZXR1cm4gcmVmdXNhbChlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoKSA9PiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogXCJiYWQganNvblwiIH0sIHsgc3RhdHVzOiA0MDAgfSkpO1xuICAgICAgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgIGNvbnN0IGFzc2V0ID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICBpZiAoYXNzZXQpIHJldHVybiBhc3NldDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwibm90IGZvdW5kXCIgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICB9LFxuICAgIHdlYnNvY2tldDoge1xuICAgICAgb3Blbih3cykge1xuICAgICAgICBzb2NrZXRzLmFkZCh3cyk7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcInN0YXRlXCIsIHN0YXRlOiB2aWV3U3RhdGUoKSB9KSk7XG4gICAgICB9LFxuICAgICAgbWVzc2FnZSh3cywgcmF3KSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGxldCBtc2c6IENsaWVudE1zZztcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBtc2cgPSBKU09OLnBhcnNlKFxuICAgICAgICAgICAgdHlwZW9mIHJhdyA9PT0gXCJzdHJpbmdcIiA/IHJhdyA6IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyYXcpLFxuICAgICAgICAgICkgYXMgQ2xpZW50TXNnO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYHNjcmlwdG9yaXVtOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBoYW5kbGVDbGllbnRNc2cod3MsIG1zZyk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAvLyBBIHJlZnVzYWwgdGhlIGh1bWFuIGNhdXNlZCAoZWRpdCBhIG5vbi1hY3RpdmUgdmVyc2lvbiwgb3BlbiBhXG4gICAgICAgICAgLy8gdmFuaXNoZWQgZmlsZSkgcmVhY2hlcyBUSEVNLCBhcyBhIGNoYXQtdmlzaWJsZSBzeXN0ZW0gbGluZSB3b3VsZCBiZVxuICAgICAgICAgIC8vIHRvbyBsb3VkIGZvciBhIGtleXN0cm9rZSDigJQgc28gaXQgaXMgYW4gZXJyb3IgZnJhbWUgdGhlIHN1cmZhY2Ugc2hvd3MuXG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICBjbG9zZSh3cykge1xuICAgICAgICBzb2NrZXRzLmRlbGV0ZSh3cyk7XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGJvdW5kUG9ydCA9IHNlcnZlci5wb3J0O1xuICAvLyAtLS0gZGlzY292ZXJ5IChFMTM6IHNlc3Npb24tSlNPTiwgdGhlIG9ubHkgY29udmVudGlvbiB0aGF0IGNhbiBleHByZXNzIHNldmVyYWwpIC0tXG4gIGNvbnN0IHNlc3Npb25GaWxlID0gam9pbih0bXBkaXIoKSwgYHNjcmlwdG9yaXVtLSR7c2Vzc2lvbklkfS5qc29uYCk7XG4gIGNvbnN0IGxhdGVzdEZpbGUgPSBqb2luKHRtcGRpcigpLCBcInNjcmlwdG9yaXVtLWxhdGVzdC5qc29uXCIpO1xuICBjb25zdCBpbmZvID0gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHVybDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtib3VuZFBvcnR9YCxcbiAgICBwb3J0OiBib3VuZFBvcnQsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIGhvbWUsXG4gICAgZGlyOiBzZXNzaW9uLmRpcixcbiAgICBtb2RlLFxuICB9KTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVBdG9taWMoc2Vzc2lvbkZpbGUsIGluZm8pO1xuICAgIHdyaXRlRmlsZUF0b21pYyhsYXRlc3RGaWxlLCBpbmZvKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogZGlzY292ZXJ5IGlzIGJlc3QtZWZmb3J0ICovXG4gIH1cblxuICBzeW5jV2F0Y2hlcnMoKTtcbiAgLy8g4pqgIFRIRSBTRVNTSU9OIFNBWVMgV0hBVCBJVFMgT1dOIFRJTUVPVVQgSVMuIGAtLXRpbWVvdXQgMGAgaGFzIGFsd2F5cyBtZWFudFxuICAvLyBcInN0YW5kIHVudGlsIGNsb3NlZFwiIGFuZCB0aGVyZSB3YXMgbm8gd2F5IHRvIGNvbmZpcm0gZnJvbSBvdXRzaWRlIHRoYXQgYVxuICAvLyBkYWVtb24gaGFkIHRha2VuIGl0IOKAlCB3aGljaCBpcyB0aGUga2luZCBvZiBzZXR0aW5nIHlvdSBmaW5kIG91dCBhYm91dCBieVxuICAvLyBsb3NpbmcgYSBzZXNzaW9uIGF0IHRoZSB3cm9uZyBtb21lbnQuXG4gIGxvZy5lbWl0KHtcbiAgICB0eXBlOiBcInJlYWR5XCIsXG4gICAgbW9kZSxcbiAgICBzZXNzaW9uX2lkOiBzZXNzaW9uSWQsXG4gICAgcmVzdG9yZWQ6ICEhb3B0cy5yZXN0b3JlLFxuICAgIGlkbGVfdGltZW91dF9zOiBvcHRzLnRpbWVvdXRTID8/IDE4MDAsXG4gIH0pO1xuICAvLyBWZXJpZnktcGFzcyBmaXggMjogd2hhdCBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgbm8gZGFlbW9uIHdhcyB3YXRjaGluZy5cbiAgZm9yIChjb25zdCBmIG9mIHNlc3Npb24ucmVzdG9yZUZpbmRpbmdzKVxuICAgIGFubm91bmNlKFxuICAgICAgZi5taXNzaW5nXG4gICAgICAgID8gYCR7Zi5vcmlnaW5hbH0gaXMgZ29uZSBmcm9tIGRpc2sgc2luY2UgdGhpcyBzZXNzaW9uIHdhcyBsYXN0IG9wZW4uIFNhdmUgd291bGQgcmVjcmVhdGUgaXQ7IFJldmVydCBjYW5ub3QgcnVuLmBcbiAgICAgICAgOiBgJHtmLm9yaWdpbmFsfSBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgdGhpcyBzZXNzaW9uIHdhcyBjbG9zZWQuIFNhdmUgb3ZlcndyaXRlcyBpdCB3aXRoIHRoZSBhY3RpdmUgdmVyc2lvbjsgUmV2ZXJ0IHRha2VzIHRoZSBmaWxlJ3MgdmVyc2lvbi5gLFxuICAgICAgeyBmYWN0OiBcIm9yaWdpbmFsLmNvbmZsaWN0XCIsIGRvYzogZi5kb2MsIHdoaWxlQ2xvc2VkOiB0cnVlIH0sXG4gICAgKTtcblxuICAvKipcbiAgICogRTUzJ3MgYXR0ZW50aW9uIHRpY2suIFNlcGFyYXRlIGZyb20gaG91c2VrZWVwaW5nIGJlY2F1c2UgaXQgaXMgYWJvdXQgdGhlXG4gICAqIEhVTUFOJ3MgcGF0aWVuY2UgcmF0aGVyIHRoYW4gdGhlIGRhZW1vbidzIGxpZmV0aW1lLCBhbmQgYmVjYXVzZSBpdCBtdXN0IHJ1blxuICAgKiBvbiBhIHNsb3dlciBjbG9jazogYSAyNTAgbXMgc3dlZXAgcmUtYnJvYWRjYXN0aW5nIHN0YXRlIHdvdWxkIGJlIGNodXJuIGZvciBhXG4gICAqIHZhbHVlIHRoYXQgY2hhbmdlcyB0d2ljZSBpbiBhIHdhaXQuXG4gICAqL1xuICBsZXQgbGFzdFdhaXRpbmc6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBjb25zdCBhdHRlbnRpb25UaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICBjb25zdCB3ID0gd2FpdGluZ09uKHNlc3Npb24ubWVzc2FnZXMoKSwgRGF0ZS5ub3coKSwgeyBhY2tub3dsZWRnZWRVbnRpbCB9KTtcbiAgICBjb25zdCBrZXkgPSB3ID8gYCR7dy5tZXNzYWdlSWR9OiR7dy5iYWRnZX1gIDogbnVsbDtcbiAgICBpZiAoa2V5ID09PSBsYXN0V2FpdGluZykgcmV0dXJuO1xuICAgIGxhc3RXYWl0aW5nID0ga2V5O1xuICAgIC8vIFRoZSBiYWRnZSBjaGFuZ2VkLCBzbyB0aGUgc3VyZmFjZSBuZWVkcyB0aGUgbmV3IHNuYXBzaG90LlxuICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgaWYgKCF3KSByZXR1cm47XG4gICAgaWYgKHcuYmFkZ2UgIT09IFwic3RhbGxlZFwiIHx8IG51ZGdlZC5oYXMody5tZXNzYWdlSWQpKSByZXR1cm47XG4gICAgbnVkZ2VkLmFkZCh3Lm1lc3NhZ2VJZCk7XG4gICAgLy8g4puUIFRIRSBOVURHRSBHT0VTIFRPIFRIRSBBR0VOVCdTIFRBSUwgQU5EIE5PV0hFUkUgRUxTRS4gVGhlIGh1bWFuIGFscmVhZHlcbiAgICAvLyBzZWVzIHRoZSBiYWRnZTsgcHV0dGluZyB0aGlzIGluIHRoZSBjaGF0IGFzIHdlbGwgd291bGQgYmUgdGVsbGluZyB0aGVtXG4gICAgLy8gd2hhdCB0aGV5IGFyZSBsb29raW5nIGF0LiBJdCBjYXJyaWVzIHRoZSBtZXNzYWdlIFRFWFQgYmVjYXVzZSBhbiBhZ2VudFxuICAgIC8vIHRoYXQgaGFzIGJlZW4gYXdheSBuZWVkcyB0byBrbm93IHdoYXQgaXMgcGVuZGluZywgbm90IGp1c3QgdGhhdCBzb21ldGhpbmdcbiAgICAvLyBpcyDigJQgYW5kIGl0IG5hbWVzIHRoZSB0d28gd2F5cyBvdXQsIGJlY2F1c2UgYSBudWRnZSB0aGF0IGRvZXMgbm90IHNheSBob3dcbiAgICAvLyB0byBhbnN3ZXIgaXQgaW52aXRlcyBhIGZvdXJ0aCBwcmltaXRpdmUuXG4gICAgY29uc3QgcGVuZGluZyA9IHNlc3Npb24ubWVzc2FnZXMoKS5maW5kKChtKSA9PiBtLmlkID09PSB3Lm1lc3NhZ2VJZCk7XG4gICAgbG9nLmVtaXQoe1xuICAgICAgdHlwZTogXCJ3YWl0aW5nXCIsXG4gICAgICBtZXNzYWdlX2lkOiB3Lm1lc3NhZ2VJZCxcbiAgICAgIHNlY29uZHM6IE1hdGgucm91bmQoKERhdGUubm93KCkgLSB3LnNpbmNlKSAvIDEwMDApLFxuICAgICAgLi4uKHBlbmRpbmcgPyB7IHRleHQ6IHBlbmRpbmcudGV4dCB9IDoge30pLFxuICAgICAgaGludDogXCJyZXBseSB3aXRoIGBzYXlgLCBvciBgd29ya2luZ2AgdG8gc2F5IHlvdSBhcmUgc3RpbGwgb24gaXRcIixcbiAgICB9KTtcbiAgfSwgMTAwMCk7XG5cbiAgY29uc3Qgc3RvcEhvdXNla2VlcGluZyA9IHN0YXJ0SG91c2VrZWVwaW5nKHtcbiAgICBzdWJzY3JpYmVyQ291bnQ6ICgpID0+IHNvY2tldHMuc2l6ZSArIHNzZUNsaWVudHMuc2l6ZSxcbiAgICBpZGxlTXM6ICgpID0+IHBlcmZvcm1hbmNlLm5vdygpIC0gbGFzdEFjdGl2aXR5LFxuICAgIHRvdWNoLFxuICAgIHRpbWVvdXRNczogKG9wdHMudGltZW91dFMgPz8gMTgwMCkgKiAxMDAwLFxuICAgIG9uSWRsZUNsb3NlOiAoKSA9PiByZXNvbHZlRG9uZSh7IGNvZGU6IDEyNCwgcmVhc29uOiBcInRpbWVvdXRcIiB9KSxcbiAgfSk7XG5cbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICBsZXQgcmVzb2x2ZVNodXRkb3duITogKCkgPT4gdm9pZDtcbiAgY29uc3Qgc2h1dGRvd24gPSBuZXcgUHJvbWlzZTx2b2lkPigocikgPT4ge1xuICAgIHJlc29sdmVTaHV0ZG93biA9IHI7XG4gIH0pO1xuXG4gIGNvbnN0IGNsZWFudXBEaXNjb3ZlcnkgPSAoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMoc2Vzc2lvbkZpbGUpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogZ29uZSDigJQgZmluZSAqL1xuICAgIH1cbiAgICB1bmxpbmtJZk1hdGNoZXMobGF0ZXN0RmlsZSwgc2Vzc2lvbklkLCAocmF3KSA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBpZCA9IChKU09OLnBhcnNlKHJhdykgYXMgeyBzZXNzaW9uX2lkPzogdW5rbm93biB9KS5zZXNzaW9uX2lkO1xuICAgICAgICByZXR1cm4gdHlwZW9mIGlkID09PSBcInN0cmluZ1wiID8gaWQgOiBudWxsO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgIH0pO1xuICB9O1xuXG4gIC8vIFRoZSBvcmRlciBpcyB0aGUgaGVhZGVyJ3MsIGFuZCB0aGUgaGVhZGVyIHNheXMgd2h5LlxuICBjb25zdCBjbG9zZSA9ICgpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBzdG9wSG91c2VrZWVwaW5nKCk7XG4gICAgY2xlYXJJbnRlcnZhbChhdHRlbnRpb25UaW1lcik7XG4gICAgZm9yIChjb25zdCB3IG9mIHdhdGNoZXJzLnZhbHVlcygpKSB3LmNsb3NlKCk7XG4gICAgd2F0Y2hlcnMuY2xlYXIoKTtcbiAgICBmb3IgKGNvbnN0IHQgb2YgcGVuZGluZy52YWx1ZXMoKSkgY2xlYXJUaW1lb3V0KHQpO1xuICAgIHRyeSB7XG4gICAgICBzZXNzaW9uLnBlcnNpc3QoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGJlc3QtZWZmb3J0ICovXG4gICAgfVxuICAgIGNsZWFudXBEaXNjb3ZlcnkoKTtcbiAgICBsb2cuZW1pdCh7IHR5cGU6IFwiY2xvc2VkXCIgfSk7XG4gICAgdm9pZCBkcmFpbkFuZFN0b3AoeyBzZXJ2ZXIsIGNsaWVudHM6IHNzZUNsaWVudHMsIHNvY2tldHMgfSkudGhlbihyZXNvbHZlU2h1dGRvd24pO1xuICB9O1xuICBkb25lLnRoZW4oKCkgPT4gY2xvc2UoKSk7XG5cbiAgcmV0dXJuIHsgcG9ydDogYm91bmRQb3J0LCBzZXNzaW9uSWQsIG1vZGUsIGRpcjogc2Vzc2lvbi5kaXIsIGNsb3NlLCBkb25lLCBzaHV0ZG93biB9O1xufVxuXG4vKiogQW4gYWJzZW50IE9yaWdpbiAodGhlIENMSSwgY3VybCkgb3IgdGhpcyBkYWVtb24ncyBvd24gcGFnZTsgbm90aGluZyBlbHNlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNhbWVPcmlnaW4ocmVxOiBSZXF1ZXN0LCBwb3J0OiBudW1iZXIgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcbiAgY29uc3Qgb3JpZ2luID0gcmVxLmhlYWRlcnMuZ2V0KFwib3JpZ2luXCIpO1xuICBpZiAob3JpZ2luID09PSBudWxsKSByZXR1cm4gdHJ1ZTtcbiAgcmV0dXJuIG9yaWdpbiA9PT0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fWAgfHwgb3JpZ2luID09PSBgaHR0cDovL2xvY2FsaG9zdDoke3BvcnR9YDtcbn1cblxuLyoqXG4gKiBBIHBhdGggdHlwZWQgaW4gdGhlIFNVUkZBQ0UuIFRoZSBwYWdlIGhhcyBubyB3b3JraW5nIGRpcmVjdG9yeSwgc28gYSBwYXRoXG4gKiBmcm9tIGl0IG11c3QgYmUgYWJzb2x1dGUgb3Igc3RhcnQgYXQgYH5gIOKAlCB3aGljaCBpcyBleHBhbmRlZCBIRVJFLiBCZWZvcmVcbiAqIHRoaXMsIGB+L0RvY3VtZW50c2AgcmVhY2hlZCBgcmVzb2x2ZSgpYCBhbmQgd2FzIHRha2VuIGFzIHJlbGF0aXZlIHRvIHRoZVxuICogZGFlbW9uJ3MgY3dkICh0aGUgc2tpbGwgZm9sZGVyKTogdGhlIHBhdGggYm94IGNvbXBsZXRlZCBgfi/igKZgIChsaXN0aW5nXG4gKiBleHBhbmRzIGl0KSBhbmQgdGhlbiBFbnRlciBmYWlsZWQgd2l0aCBcIm5vIHN1Y2ggZmlsZSBvciBmb2xkZXI6XG4gKiDigKYvc2tpbGxzL3NjcmlwdG9yaXVtL34vRG9jdW1lbnRzL+KAplwiIChDb2xlLCAyMDI2LTA5LTExKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN1cmZhY2VQYXRoKHA6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHQgPSBwLnRyaW0oKTtcbiAgaWYgKHQgPT09IFwiflwiIHx8IHQuc3RhcnRzV2l0aChcIn4vXCIpKSByZXR1cm4gZXhwYW5kSG9tZSh0KTtcbiAgaWYgKCFpc0Fic29sdXRlKHQpKVxuICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYFwiJHtwfVwiIGlzIG5vdCBhIGZ1bGwgcGF0aCDigJQgc3RhcnQgaXQgd2l0aCAvIG9yIH4vYCwgNDAwKTtcbiAgcmV0dXJuIHJlc29sdmUodCk7XG59XG5cbi8qKiBBIHN0cnVjdHVyZSBvcCBmcm9tIHRoZSBzdXJmYWNlLCB3aXRoIGV2ZXJ5IHBhdGggZmllbGQgdGhyb3VnaCBgc3VyZmFjZVBhdGhgLiAqL1xuZnVuY3Rpb24gYW5jaG9yU3VyZmFjZVBhdGhzKG9wOiBTdHJ1Y3R1cmVPcCk6IFN0cnVjdHVyZU9wIHtcbiAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgLi4ub3AgfTtcbiAgZm9yIChjb25zdCBrIG9mIFtcImRpclwiLCBcInBhdGhcIiwgXCJpbnRvXCJdIGFzIGNvbnN0KVxuICAgIGlmICh0eXBlb2Ygb3V0W2tdID09PSBcInN0cmluZ1wiKSBvdXRba10gPSBzdXJmYWNlUGF0aChvdXRba10gYXMgc3RyaW5nKTtcbiAgcmV0dXJuIG91dCBhcyBTdHJ1Y3R1cmVPcDtcbn1cblxuZnVuY3Rpb24gZXhwYW5kSG9tZShwOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAocCA9PT0gXCJ+XCIpIHJldHVybiBob21lZGlyKCk7XG4gIGlmIChwLnN0YXJ0c1dpdGgoXCJ+L1wiKSkgcmV0dXJuIGpvaW4oaG9tZWRpcigpLCBwLnNsaWNlKDIpKTtcbiAgcmV0dXJuIHJlc29sdmUocCk7XG59XG5cbi8qKiBUaGUgZGFlbW9uJ3MgcHJpdmF0ZSBhcmd2IOKAlCB0aGUgQ0xJIHNwYXducyBpdCB3aXRoIGV4YWN0bHkgdGhlc2UuICovXG5jb25zdCBEQUVNT05fT1BUSU9OUyA9IHtcbiAgbG9nOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcG9ydDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgd29ya3NwYWNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbn0gYXMgY29uc3Q7XG5cbi8qKiBQYXJzZSB0aGUgZGFlbW9uJ3MgYXJndiwgYm9vdCwgcHJpbnQgdGhlIGhhbmRzaGFrZSwgd2FpdCBmb3IgdGhlIGVuZC4gUmV0dXJucyB0aGUgZXhpdCBjb2RlLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD47XG4gIHRyeSB7XG4gICAgZmxhZ3MgPSBub2RlUGFyc2VBcmdzKHsgYXJnczogYXJndiwgb3B0aW9uczogREFFTU9OX09QVElPTlMsIHN0cmljdDogdHJ1ZSB9KS52YWx1ZXMgYXMgUmVjb3JkPFxuICAgICAgc3RyaW5nLFxuICAgICAgc3RyaW5nIHwgdW5kZWZpbmVkXG4gICAgPjtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYHNjcmlwdG9yaXVtOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG4gIHJlY29nbml6ZWQgZmxhZ3M6ICR7T2JqZWN0LmtleXMoXG4gICAgICAgIERBRU1PTl9PUFRJT05TLFxuICAgICAgKVxuICAgICAgICAubWFwKChrKSA9PiBgLS0ke2t9YClcbiAgICAgICAgLmpvaW4oXCIgXCIpfVxcbmAsXG4gICAgKTtcbiAgICByZXR1cm4gMjtcbiAgfVxuICBsZXQgZDogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiBzdGFydERhZW1vbj4+O1xuICB0cnkge1xuICAgIGQgPSBhd2FpdCBzdGFydERhZW1vbih7XG4gICAgICBwb3J0OiBmbGFncy5wb3J0ID8gTnVtYmVyKGZsYWdzLnBvcnQpIDogMCxcbiAgICAgIHJlc3RvcmU6IGZsYWdzLnJlc3RvcmUsXG4gICAgICB0aW1lb3V0UzogZmxhZ3MudGltZW91dCA/IE51bWJlcihmbGFncy50aW1lb3V0KSA6IHVuZGVmaW5lZCxcbiAgICAgIHdvcmtzcGFjZTogZmxhZ3Mud29ya3NwYWNlLFxuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgLy8gVGhlIGhhbmRzaGFrZSBsaW5lIGlzIEpTT04gZWl0aGVyIHdheSwgc28gdGhlIENMSSByZWFkcyBPTkUgc2hhcGUuXG4gICAgY29uc3Qgc3RhdHVzID0gZSBpbnN0YW5jZW9mIFNlc3Npb25FcnJvciA/IGUuc3RhdHVzIDogNTAwO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoeyBvazogZmFsc2UsIHN0YXR1cywgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KX1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIHN0YXR1cyA9PT0gNDA0ID8gNSA6IHN0YXR1cyA9PT0gNDA5ID8gNiA6IDE7XG4gIH1cbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7ZC5wb3J0fWAsIHBvcnQ6IGQucG9ydCwgc2Vzc2lvbl9pZDogZC5zZXNzaW9uSWQsIG1vZGU6IGQubW9kZSwgZGlyOiBkLmRpciB9KX1cXG5gLFxuICApO1xuICBjb25zdCByZXMgPSBhd2FpdCBkLmRvbmU7XG4gIGF3YWl0IGQuc2h1dGRvd247XG4gIC8vIFZlcmlmeS1wYXNzIGZpeCA2OiBhIGNsZWFuIGNsb3NlIGxlYXZlcyBubyBlbXB0eSBsb2cgYmVoaW5kLlxuICBpZiAocmVzLmNvZGUgPT09IDAgJiYgZmxhZ3MubG9nKSB7XG4gICAgdHJ5IHtcbiAgICAgIGlmIChzdGF0U3luYyhmbGFncy5sb2cpLnNpemUgPT09IDApIHVubGlua1N5bmMoZmxhZ3MubG9nKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGFscmVhZHkgZ29uZSAqL1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzLmNvZGU7XG59XG5cbi8qKlxuICogVGhlIGRhZW1vbidzIGVudHJ5LCBmb3IgdGhlIExBVU5DSEVSLiBgaW1wb3J0Lm1ldGEubWFpbmAgaXMgRkFMU0UgaW4gdGhlXG4gKiBidW5kbGUsIHNvIHRoZXJlIGlzIG5vIHN1Y2ggYmxvY2sgaGVyZSwgYW5kIHRoaXMgdGFrZXMgbm8gYXJndW1lbnRzOiB0aGVcbiAqIGNvbW1hbmQgbGluZSBiZWxvbmdzIHRvIHRoZSBmaWxlIHRoYXQgcGFyc2VzIGl0LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIHR3byBwcmltaXRpdmVzIHVuZGVyIEJPVEggb2YgdGhlIGhvdXNlJ3MgZGFlbW9uLWRpc2NvdmVyeSBjb252ZW50aW9ucy5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIEQzIHJ1bGVkIHRoYXQgdGhlIGNvbnZlbnRpb25zIHRoZW1zZWx2ZXMg4oCUIHBlci1zZXNzaW9uIHRtcGRpciBKU09OIChib3VudHksXG4gKiBnbGFtb3VyLCBpbWFnbywgbWFncGllKSBhbmQgc2luZ2xldG9uIGAkSE9NRS9kYWVtb24ucG9ydGAgKyBgZGFlbW9uLnBpZGBcbiAqIChhc3Ryb2xhYmUsIGdyYXBldmluZSwgbWluZC1tYXBwZXIpIOKAlCBib3RoIHN1cnZpdmUsIGJlY2F1c2UgdGhleSBlbmNvZGVcbiAqIGdlbnVpbmVseSBkaWZmZXJlbnQgbW9kZWxzIChjb25jdXJyZW50IHNlc3Npb25zIHZzIGEgc3RhbmRpbmcgc2luZ2xldG9uKSBhbmRcbiAqIHBpY2tpbmcgb25lIGlzIGEgcHJvZHVjdCBkZWNpc2lvbiwgbm90IGEgZmFjdG9yaW5nIG9uZS4gV2hhdCBJUyBvbmVcbiAqIGltcGxlbWVudGF0aW9uIGlzIHRoZSBwYWlyIGJlbG93LCB3aGljaCBpcyBhbHNvIGV4YWN0bHkgd2hlcmUgY2Vuc3VzIGRlZmVjdFxuICogKipMMyoqIGxpdmVzLlxuICovXG5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYywgcmVuYW1lU3luYywgcm1TeW5jLCB1bmxpbmtTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcblxuLyoqXG4gKiBXcml0ZSBgdGV4dGAgdG8gYHRhcmdldGAgYXRvbWljYWxseTogd3JpdGUgYmVzaWRlIGl0LCB0aGVuIHJlbmFtZS5cbiAqXG4gKiDim5QgKipMMywgQ0xPU0VEIEJZIENPTlNUUlVDVElPTi4qKiBBIGJhcmUgYHdyaXRlRmlsZVN5bmNgIGlzIG5vdCBhdG9taWMsIHNvIGFcbiAqIENMSSByZWFkaW5nIHdoaWxlIHRoZSBkYWVtb24gd3JpdGVzIGNhbiBvYnNlcnZlIGEgSEFMRi1XUklUVEVOIHBvaW50ZXIuIFVuZGVyXG4gKiBhIGJlc3QtZWZmb3J0IHJlYWRlciB0aGF0IHN1cmZhY2VkIGFzIFwibm8gcnVubmluZyBzZXNzaW9uXCIg4oCUIGFic2VuY2UgcmVwb3J0ZWRcbiAqIGZvciB3aGF0IHdhcyByZWFsbHkgYSB0b3JuIHJlYWQsIHdoaWNoIGlzIHRoZSBleGFjdCBjb25mbGF0aW9uIHRoZSBob3VzZSdzXG4gKiBgbnVsbGAtbm90LWAwYCBydWxlIGV4aXN0cyB0byBwcmV2ZW50LiBSZW5hbWUgd2l0aGluIG9uZSBkaXJlY3RvcnkgaXMgYXRvbWljLFxuICogc28gYSByZWFkZXIgc2VlcyBlaXRoZXIgdGhlIHByZXZpb3VzIHBvaW50ZXIgb3IgdGhlIG5ldyBvbmUsIG5ldmVyIGEgcGFydGlhbFxuICogZmlsZS5cbiAqXG4gKiBGaXhlZCBpbiBnbGFtb3VyIDIwMjYtMDktMDcsIGZvdW5kIHN0YW5kaW5nIGluIHRocmVlIHNpYmxpbmdzIHRoZSBuZXh0IGRheSBieVxuICogdGhlIGR1cGxpY2F0aW9uIHJlY29uLCBhbmQgcmVwYWlyZWQgaW4gYWxsIG9mIHRoZW0gdGhlIG9ubHkgd2F5IHRoYXQgZG9lcyBub3RcbiAqIG5lZWQgZmluZGluZyBhZ2FpbjogdGhlcmUgaXMgbm93IG9uZSBpbXBsZW1lbnRhdGlvbi5cbiAqXG4gKiDimqAgVGhlIHRlbXAgbmFtZSBjYXJyaWVzIHRoZSBwaWQsIHNvIHR3byBkYWVtb25zIHJhY2luZyB0byBwdWJsaXNoIHRoZSBzYW1lXG4gKiBwb2ludGVyIGNhbm5vdCBjbG9iYmVyIGVhY2ggb3RoZXIncyBpbnRlcm1lZGlhdGUgZmlsZSDigJQgYW5kIGl0IGlzIHJlbW92ZWQgb25cbiAqIGEgZmFpbGVkIHdyaXRlIHJhdGhlciB0aGFuIGxlZnQgYXMgbGl0dGVyIGJlc2lkZSB0aGUgcmVhbCBvbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3cml0ZUZpbGVBdG9taWModGFyZ2V0OiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCB0bXAgPSBgJHt0YXJnZXR9LiR7cHJvY2Vzcy5waWR9LnRtcGA7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyh0bXAsIHRleHQpO1xuICAgIHJlbmFtZVN5bmModG1wLCB0YXJnZXQpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICB0cnkge1xuICAgICAgcm1TeW5jKHRtcCwgeyBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHRoZSB0ZW1wIGZpbGUgaXMgYWxyZWFkeSBnb25lLCBvciB3YXMgbmV2ZXIgY3JlYXRlZCAqL1xuICAgIH1cbiAgICB0aHJvdyBlcnI7XG4gIH1cbn1cblxuLyoqXG4gKiBEZWxldGUgYHBhdGhgIGlmZiBpdCBzdGlsbCBuYW1lcyBVUy4gUmV0dXJucyB3aGV0aGVyIGl0IHdhcyBkZWxldGVkLlxuICpcbiAqIOKblCAqKlwiU1RJTEwgT1VSU1wiIElTIFRIRSBXSE9MRSBGVU5DVElPTi4qKiBBIGRhZW1vbiB0aGF0IHVubGlua3MgaXRzIGRpc2NvdmVyeVxuICogZmlsZSB1bmNvbmRpdGlvbmFsbHkgYXQgZXhpdCBkZWxldGVzIHRoZSBwb2ludGVyIGEgU1VDQ0VTU09SIGhhcyBhbHJlYWR5XG4gKiB3cml0dGVuIOKAlCB0aGUgc3VjY2Vzc29yIGNhbiB0aGVuIG5vIGxvbmdlciBiZSBmb3VuZCBhbmQgdGhlIG5leHQgQ0xJIHZlcmIgc3Bhd25zIGFcbiAqIHRoaXJkIGRhZW1vbi4gQm90aCBjb252ZW50aW9ucyBoYXZlIHRoaXMgaGF6YXJkIGFuZCBib3RoIGV4cHJlc3MgaXRcbiAqIGRpZmZlcmVudGx5OiBhc3Ryb2xhYmUgY29tcGFyZXMgdGhlIHBpZCBmaWxlJ3MgYnl0ZXMgdG8gaXRzIG93biBwaWQsXG4gKiBtYWdwaWUgcGFyc2VzIHRoZSBKU09OIHBvaW50ZXIgYW5kIGNvbXBhcmVzIGBzZXNzaW9uX2lkYC4gYGlkZW50aWZ5YCBpcyB3aGF0XG4gKiBtYWtlcyB0aG9zZSBvbmUgZnVuY3Rpb24g4oCUIGl0IHR1cm5zIHRoZSBmaWxlJ3MgYnl0ZXMgaW50byB0aGUgaWRlbnRpdHkgdG9cbiAqIGNvbXBhcmUsIGFuZCBpdCBkZWZhdWx0cyB0byB0aGUgdHJpbW1lZCBieXRlcyB0aGVtc2VsdmVzLlxuICpcbiAqIOKaoCBFdmVyeSBmYWlsdXJlIGlzIHN3YWxsb3dlZCBhbmQgcmVwb3J0ZWQgYXMgYGZhbHNlYDogdGhlIGZpbGUgYmVpbmcgZ29uZSxcbiAqIHVucmVhZGFibGUsIG9yIHVucGFyc2VhYmxlIGFsbCBtZWFuIHRoZSBzYW1lIHRoaW5nIGhlcmUg4oCUIGl0IGlzIG5vdCBvdXJzIHRvXG4gKiByZW1vdmUuIEFuIHVucGFyc2VhYmxlIHBvaW50ZXIgaXMgZGVsaWJlcmF0ZWx5IE5PVCB0cmVhdGVkIGFzIG91cnMsIHdoaWNoIGlzXG4gKiB0aGUgY29uc2VydmF0aXZlIGhhbGYgb2YgdGhlIHNhbWUgYG51bGxgLW5vdC1gMGAgcnVsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVubGlua0lmTWF0Y2hlcyhcbiAgcGF0aDogc3RyaW5nLFxuICBleHBlY3RlZDogc3RyaW5nLFxuICBpZGVudGlmeTogKHJhdzogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsID0gKHJhdykgPT4gcmF3LnRyaW0oKSxcbik6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIGlmICghZXhpc3RzU3luYyhwYXRoKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChpZGVudGlmeShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSAhPT0gZXhwZWN0ZWQpIHJldHVybiBmYWxzZTtcbiAgICB1bmxpbmtTeW5jKHBhdGgpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgaW4tcHJvY2VzcyBldmVudCBsb2cg4oCUIHRoZSBhcHBlbmQtb25seSwgcmVwbGF5YWJsZSBidWZmZXJcbiAqIGJlaGluZCBldmVyeSBzcGVsbCdzIGBHRVQgL2V2ZW50c2AgU1NFIHRhaWwuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgbWluZC1tYXBwZXInc1xuICogYHNjcmlwdHMvZXZlbnRzLnRzYCDigJQgdGhlIGNlbnN1cydzIGNvbnZlcmdlbmNlIHRhcmdldCAjMiwgYW5kIHRoZSBvbmx5IG9uZSBvZlxuICogdGhlIHNpeCBjb3BpZWQtaW4tcGxhY2UgYnVzZXMgdGhhdCBpcyBhIG1vZHVsZSwgaXMgYm91bmRlZCwgY2FycmllcyBhbiBlcG9jaCwgYW5kIGlzXG4gKiB1bml0LXRlc3RlZC4gVGhlIGZpdmUgb3RoZXJzIGFyZSB0aGUgc2FtZSB0d2VudHkgbGluZXMgd3JpdHRlbiBmaXZlIHRpbWVzLlxuICpcbiAqIOKUgOKUgCBUSEUgVEhSRUUgVEhJTkdTIFRISVMgRklYRVMg4oCUIFRXTyBCWSBDT05TVFJVQ1RJT04sIE9ORSBCWSBPUFQtSU4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICog4puUIFRIRSBIRUFESU5HIFVTRUQgVE8gU0FZIFwiVEhFIFRIUkVFIFRISU5HUyBUSElTIEZJWEVTIEJZIENPTlNUUlVDVElPTlwiIEFORFxuICogSVRFTSAyIElTIE5PVCBPTkUgT0YgVEhFTS4gQ29ycmVjdGVkIDIwMjYtMDktMDkgaW4gbWluZC1tYXBwZXIncyBwcmUtd29ya1xuICogKEQ3OSk6IGBlcG9jaGAgaXMgT1BUSU9OQUwgaGVyZSwgc28gTDYgaXMgY2xvc2VkIG9ubHkgZm9yIGEgY2FsbGVyIHRoYXQgYXNrcy5cbiAqIFRocmVlIGFkb3B0ZXJzIGhhdmUgc2luY2UgZGVjbGluZWQgdG8g4oCUIGltYWdvIChEMzkpLCBib3VudHkgKEQ0OCkgYW5kXG4gKiBncmFwZXZpbmUgKEQ3MCkg4oCUIHNvIHRoZSBkZWZlY3QgdGhlIGhlYWRpbmcgY2xhaW1lZCB0byBtYWtlIGltcG9zc2libGUgaXNcbiAqIGxpdmUgaW4gdGhlIHRyZWUsIGJ5IG9wdC1vdXQsIGFuZCB0aGUgb3ZlcmNsYWltIGlzIHdoYXQgaGlkIHRoYXQuIEl0ZW1zIDEgYW5kXG4gKiAzIEFSRSBieSBjb25zdHJ1Y3Rpb246IGEgY2FsbGVyIGNhbm5vdCBzd2l0Y2ggdGhlIGNhcCBvZmYgb3IgcmVhY2ggdGhlIGJ1ZmZlci5cbiAqXG4gKiDimqAgQU5EIE1JTkQtTUFQUEVSJ1MgT1dOIEJVUywgV0hJQ0ggVEhJUyBNT0RVTEUgQ09OVkVSR0VEIFRPV0FSRCwgVFlQRVMgVEhFXG4gKiBFUE9DSCBBUyBSRVFVSVJFRCBhbmQgc3RhbXBzIGl0IHVuY29uZGl0aW9uYWxseSDigJQgaXQgaXMgdGhlIHNwZWxsIGNlbnN1cyBMNlxuICogbmFtZXMgYXMgQ09SUkVDVC4gTWFraW5nIGl0IHJlcXVpcmVkIEhFUkUgaXMgbm90IHRoZSByZXBhaXI6IGl0IHdvdWxkIHJldmVyc2VcbiAqIEQzOSwgRDQ4IGFuZCBENzAuIFRoZSBob25lc3Qgc3RhdGVtZW50IGlzIHRoaXMgaGVhZGluZy5cbiAqXG4gKiDim5QgKipSRVNPTFZFRCBBVCBUSEFUIFNQRUxMJ1MgUE9SVCwgQU5EIFRIRSBESVNQT1NJVElPTiBJUyBSRUNPUkRFRCBIRVJFXG4gKiBCRUNBVVNFIEEgTE9TUyBUSEFUIExJVkVTIE9OTFkgSU4gQSBKT1VSTkFMIElTIEEgTE9TUyBOT0JPRFkgQ0FOIFNFRVxuICogKEQ3OS9EODUpLioqIG1pbmQtbWFwcGVyIGFkb3B0ZWQgdGhpcyBtb2R1bGUgaW4gUGhhc2UgNyBhbmQga2VwdCBpdHNcbiAqIGd1YXJhbnRlZSBXSVRIT1VUIEEgS0lUIENIQU5HRTogaXQgcGFzc2VzIGB7IGVwb2NoOiBjcnlwdG8ucmFuZG9tVVVJRCgpIH1gIGF0XG4gKiBpdHMgT05FIGNvbnN0cnVjdGlvbiBzaXRlIGFuZCByZS10aWdodGVucyBgZXBvY2hgIHRvIFJFUVVJUkVEIGluIGl0cyBvd25cbiAqIGxvY2FsIGZyYW1lIHR5cGUsIHNvIG5vdGhpbmcgaXRzIGJ1cyBlbWl0cyBjYW4gbGFjayBvbmUuIEtpdCBieXRlczogemVyby5cbiAqICoqU28gdGhlIGVwb2NoIGlzIGEgTE9TU1ktQ09QWSBwcm9wZXJ0eSB3aG9zZSBkaXNwb3NpdGlvbiBpcyBLRUVQLUxPQ0FMLCBub3RcbiAqIFJFU1RPUkUqKiDigJQgdGhlIG9ubHkgcHJvcGVydHkgb2YgdGhhdCBzcGVsbCdzIG93biBtb2R1bGUgdGhpcyBtb2R1bGUgY291bGRcbiAqIG5vdCBjYXJyeSBhbmQgZGlkIG5vdCBuZWVkIHRvLiBMNiBpcyBDTE9TRUQgZm9yIHRoZSB0d28gc3BlbGxzIHRoYXQgYXNrIGFuZFxuICogT1BFTiwgYnkgb3B0LW91dCwgZm9yIHRoZSB0aHJlZSB0aGF0IGRlY2xpbmU7IHRoYXQgYXN5bW1ldHJ5IGlzIHRoZSBob25lc3RcbiAqIHN0YXRlIGFuZCB0aGlzIGhlYWRpbmcgaXMgd2hlcmUgaXQgaXMgd3JpdHRlbi5cbiAqXG4gKiDimqAgKipBTkQgVEhFIEFET1BUSU9OIFJFTkFNRVMgQSBGSUVMRCBPTiBBTiBBRE9QVEVSJ1MgUFVCTElTSEVEIFdJUkUuKiogYGlkYFxuICogaXMgbmFtZWQgaW4gYEZyYW1lPFQ+YCBhbmQgaW4gdGhlIGVtaXQgbGl0ZXJhbCBiZWxvdywgc28gYSBzcGVsbCB3aG9zZSBidXNcbiAqIHNwZWxsZWQgdGhlIGN1cnNvciBhbnl0aGluZyBlbHNlIHBheXMgYSByZW5hbWUgYXQgZXZlcnkgcmVhZGVyIOKAlCBmb3JcbiAqIG1pbmQtbWFwcGVyLCAxNzMgb2NjdXJyZW5jZXMgYWNyb3NzIDUgc3VyZmFjZSBmaWxlcywgfjIwOSBhY3Jvc3MgfjMwIGJhY2tlbmRcbiAqIGZpbGVzLCBldmVyeSBKU09OTCBsaW5lIGl0cyBgdGFpbGAgd3JpdGVzIGludG8gYW4gYWdlbnQncyBwaXBlLCBhbmQgKHRoZSBvbmVcbiAqIG5vYm9keSBjb3VudGVkKSB0aGUgRklYVFVSRSBpbiBpdHMgb3duIGB0YWlsLnRlc3QudHNgLCB3aGljaCBXUklURVMgdGhlXG4gKiBlbnZlbG9wZSB3aGlsZSBzdGFuZGluZyBpbiBmb3IgdGhlIGRhZW1vbi4gVGhlIE5FU1RJTkcgaXMgbm90IGZvcmNlZCDigJRcbiAqIGBGcmFtZTxUPmAgaXMgZ2VuZXJpYywgYW5kIG1pbmQtbWFwcGVyIGtlcHQgYHtraW5kLCBwYXlsb2FkfWAgbmVzdGVkIHdoZXJlIGFsbFxuICogZml2ZSBlYXJsaWVyIGFkb3B0ZXJzIGZsYXR0ZW4gYnkgaWRpb20uICoqQW4gaWRpb20gZml2ZSBzaWJsaW5ncyBzaGFyZSBpc1xuICogaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBhIGNvbnRyYWN0IHVudGlsIHlvdSBvcGVuIHRoZSB0eXBlKiogKEQ4MSwgRDg2KS5cbiAqXG4gKiAqKjEgwrcgTDUg4oCUIHRoZSBidWZmZXIgaXMgYm91bmRlZC4qKiBGaXZlIGRhZW1vbnMgYXBwZW5kIHRvIGFuIGFycmF5IGZvciB0aGVcbiAqIHdob2xlIGxpZmUgb2YgdGhlIHByb2Nlc3MuIFRoZSB3aW5kb3cgaXMgYSBSRVBMQVkgd2luZG93IGZvciByZWNvbm5lY3RzIHdpdGhpbiBvbmVcbiAqIGRhZW1vbidzIGxpZmV0aW1lLCBub3QgYSBkdXJhYmxlIGxvZzsgYSBjYXAgaXMgdGhlIGhvbmVzdCBzaGFwZS5cbiAqXG4gKiAqKjIgwrcgTDYg4oCUIGEgZnJhbWUgY2FycmllcyBhbiBlcG9jaCwgV0hFTiBUSEUgQ0FMTEVSIEFTS1MgRk9SIE9ORSAob3B0LWluLFxuICogbm90IGNvbnN0cnVjdGlvbiDigJQgc2VlIGFib3ZlKS4qKiBBZnRlciBhIHJlc3RhcnQgdGhlIGlkcyBzdGFydCBhZ2FpbiBhdCAxLCBzb1xuICogYSByZXN1bWluZyBjbGllbnQgY2Fubm90IHRlbGwgYSBzdGFsZSB3YXRlcm1hcmsgZnJvbSBhIGZyZXNoIG9uZSBieSBpZCBhbG9uZS5cbiAqXG4gKiAqKjMgwrcgQSBTVEFMRSBXQVRFUk1BUksgUkVQTEFZUyBGUk9NIFRIRSBCRUdJTk5JTkcsIGFuZCB0aGlzIGlzIHRoZSBoYWxmIHRoZVxuICogY2xpZW50IGNhbm5vdCBkby4qKiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IGEgdGFpbCB0aGF0IHJlc3VtZXMgYXRcbiAqIGBzaW5jZT08bGFzdCBpZCBvZiB0aGUgcHJldmlvdXMgZGFlbW9uPmAgYWdhaW5zdCBhIHJlc3RhcnRlZCBkYWVtb24gcmVjZWl2ZXNcbiAqIE5PVEhJTkcg4oCUIHRoZSBuZXcgZGFlbW9uJ3MgYHJlYWR5YCBpcyBpZCAxLCB3aGljaCBpcyBub3QgYD4gc2luY2VgLCBzbyB0aGVcbiAqIGZpbHRlciBkcm9wcyBpdCwgc28gbm8gZnJhbWUgYXJyaXZlcywgc28gdGhlIGNsaWVudCdzIGVwb2NoIGNoZWNrIG5ldmVyIHJ1bnNcbiAqIGFuZCB0aGUgdGFpbCBzaXRzIGNvbm5lY3RlZCBhbmQgc2lsZW50IHVudGlsIHRoZSBuZXcgZGFlbW9uIGhhcyBlbWl0dGVkIGFzXG4gKiBtYW55IGV2ZW50cyBhcyB0aGUgb2xkIG9uZSBkaWQuIFN0YW1waW5nIGFuIGVwb2NoIGFsb25lIGRvZXMgTk9UIGNsb3NlIHRoYXRcbiAqIGdhcDogdGhlIGVwb2NoIHJpZGVzIGEgZnJhbWUsIGFuZCB0aGUgYnVnIGlzIHRoYXQgbm8gZnJhbWUgaXMgc2VudC4gU29cbiAqIGBzdWJzY3JpYmVgIHRyZWF0cyBgc2luY2UgPiBjdXJzb3JgIGFzIFwidGhpcyBjdXJzb3IgaXMgZnJvbSBhbm90aGVyIHByb2Nlc3NcIlxuICogYW5kIHJlcGxheXMgd2hvbGUuIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC90YWlsLnRlc3QudHNgJ3MgZXBvY2ggY2VsbCBpcyB0aGVcbiAqIGV4ZWN1dGFibGUgc3BlYyBvZiB0aGUgY2xpZW50IGhhbGYgYW5kIHNob3dzIHRoZSByZWNvbm5lY3Qgc3RpbGwgY2FycnlpbmcgdGhlXG4gKiBzdGFsZSBjdXJzb3Ig4oCUIGRldGVjdGlvbiBoYXBwZW5zIG9uIHdoYXQgaXMgUkVDRUlWRUQuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgRE9FUyBOT1QgQURPUFQgVEhJUywgQU5EIFRIRSBSRUZVU0FMIElTIFBBUlQgT0YgVEhFIFJVTElORyDilIDilIBcbiAqXG4gKiBSRUpFQ1QtU1RSVUNUVVJBTCwgcnVsZWQgYXQgZ3JhcGV2aW5lJ3MgcG9ydCAoUGhhc2UgNiwgMjAyNi0wOS0wOTsgRDY4KS4gTm90XG4gKiBcIm5vIHN1YmplY3RcIiDigJQgZ3JhcGV2aW5lIEhBUyBhbiBldmVudCBidXMgYW5kIGl0IGlzIHRoZSBidXNpZXN0IHRoaW5nIGluIHRoZVxuICogc3BlbGwg4oCUIGJ1dCB0aGUgdHdvIHNoYXBlcyBjYW5ub3QgYmUgY29uc3RydWN0ZWQgZnJvbSBlYWNoIG90aGVyOlxuICpcbiAqICAgdGhpcyBtb2R1bGUgIG9uZSBwcm9jZXNzLXdpZGUgYXJyYXkgY2FwcGVkIGF0IFJFUExBWV9CVUZGRVJfU0laRSwgd2l0aCBvbmVcbiAqICAgICAgICAgICAgICAgIG1vbm90b25pYyBgc2VxYCwgYW5kIHRoZSBoZWFkZXIgdGhyZWUgcGFyYWdyYXBocyB1cCBzYXlzIGluIGFzXG4gKiAgICAgICAgICAgICAgICBtYW55IHdvcmRzIHRoYXQgaXQgaXMgYSBSRVBMQVkgd2luZG93IGZvciByZWNvbm5lY3RzIHdpdGhpbiBvbmVcbiAqICAgICAgICAgICAgICAgIGRhZW1vbidzIGxpZmV0aW1lLCBOT1QgYSBkdXJhYmxlIGxvZy5cbiAqICAgZ3JhcGV2aW5lICAgIE4gZHVyYWJsZSBhcHBlbmQtb25seSBgLmpzb25sYCBmaWxlcywgb25lIHBlciBuYW1lZCBjaGFubmVsLFxuICogICAgICAgICAgICAgICAgZWFjaCB3aXRoIGl0cyBvd24gYG5leHRfaWRgLCByZXBsYXllZCBmcm9tIGRpc2sgYnlcbiAqICAgICAgICAgICAgICAgIGByZWFkQmFja2xvZ2AsIHN1cnZpdmluZyByZXN0YXJ0LCBgcm9sbGAsIGFyY2hpdmUgYW5kIGNsZWFyLlxuICpcbiAqICoqVGhlIHJlYWRlciB0aGF0IG1ha2VzIHRoZW0gaW5jb21wYXRpYmxlLCBhcyBhIG1lYXN1cmVtZW50IHJhdGhlciB0aGFuIGFuXG4gKiBhc3NlcnRpb246KiogZ3JhcGV2aW5lJ3MgYGxvYWRDaGFubmVsKClgIGRlcml2ZXMgYG5leHRfaWRgIGFzIGEgSElHSC1XQVRFUlxuICogTUFSSyBvdmVyIGV2ZXJ5IHBhcnNlYWJsZSBsaW5lIG9mIHRoZSBjaGFubmVsJ3MgZmlsZSBvbiBib290LiBUaGVyZSBpcyBub1xuICogYXJyYXkgdG8gYmUgdGhhdCBtYXJrIG9mLCBhbmQgbm8gY2FwIHRoYXQgd291bGQgbm90IHNpbGVudGx5IGRpc2NhcmQgaGlzdG9yeVxuICogYSBjYWxsZXIgY2FuIHN0aWxsIGFzayBmb3IgYnkgaWQuIEl0IGlzIHRoZSB0aGluZyB0aGlzIG1vZHVsZSdzIG93biBoZWFkZXJcbiAqIHNheXMgaXQgaXMgZGVsaWJlcmF0ZWx5IG5vdC5cbiAqXG4gKiAqKlRoZSB3aWRlbmluZyBOT1QgZG9uZSwgd2l0aCBpdHMgY29zdDoqKiBhZG1pdHRpbmcgYSBwZXItY2hhbm5lbCBkdXJhYmxlXG4gKiBzdG9yZSB3b3VsZCBjaGFuZ2UgYGNyZWF0ZUV2ZW50TG9nYCdzIHN0b3JhZ2UgYW5kIGl0cyBgc3Vic2NyaWJlYCBjb250cmFjdCBmb3JcbiAqIGZpdmUgb3RoZXIgZGFlbW9ucywgcmUtZW1pdHRpbmcgU0lYIGFydGlmYWN0cyBhY3Jvc3MgRklWRSBzcGVsbHMsIGVhY2ggb3dlZCBhXG4gKiBkcml2ZSDigJQgcGFpZCBieSBwb3J0cyB0aGF0IGFyZSBhbHJlYWR5IGZpbmlzaGVkIGFuZCBieSBhZ2VudHMgbm90IGluIHRoZSByb29tLlxuICogQSB3aWRlbmluZyByZW1haW5zIGF2YWlsYWJsZSBhcyBpdHMgb3duIGFyZ3VlZCBkZWNpc2lvbiB3aXRoIGl0cyBvd25cbiAqIGJsYXN0LXJhZGl1cyBjb3VudDsgaXQgaXMgbmV2ZXIgYSBzdGVwIGluc2lkZSBhIHBvcnQuXG4gKlxuICog4pqgIEFORCBUSEUgYGVwb2NoYCBBQk9WRSBJUyBUSEUgU0hBUlBFU1QgSEFMRiBPRiBXSFkgKEQ3MCkuIEdyYXBldmluZSdzIGlkcyBhcmVcbiAqIFJFQ09WRVJFRCBhY3Jvc3MgYSByZXN0YXJ0LCBzbyB0aGUgY29uZGl0aW9uIHBhcmFncmFwaCAyIGRlc2NyaWJlcyDigJQgaWRzXG4gKiBzdGFydGluZyBhZ2FpbiBhdCAxIOKAlCBjYW5ub3Qgb2NjdXIgdGhlcmUsIGFuZCBzdGFtcGluZyBvbmUgYW55d2F5IGlzIG5vdFxuICogaW5lcnQ6IGB0YWlsRXZlbnRzYCdzIGBvbkVwb2NoQ2hhbmdlYCBzZXRzIHRoZSBjdXJzb3IgdG8gMCwgYW5kIGdyYXBldmluZSdzXG4gKiB0YWlsIHJvdXRlIGFuc3dlcnMgYHNpbmNlPTBgIHdpdGggdGhlIFdIT0xFIGNoYW5uZWwgbG9nIG9mZiBkaXNrLCBpbnRvIGFuXG4gKiBhZ2VudCdzIHBpcGUsIG9uIGV2ZXJ5IGByb2xsYC4gVGhlIGVwb2NoJ3MgY2xpZW50LXNpZGUgYWN0aW9uIGlzIFwieW91ciBjdXJzb3JcbiAqIGlzIHdvcnRobGVzcywgc3RhcnQgb3ZlclwiLCBhbmQgdGhhdCBpcyBzYWZlIG9ubHkgd2hlcmUgc3RhcnRpbmcgb3ZlciBjb3N0cyBhXG4gKiBib3VuZGVkIGluLW1lbW9yeSByZXBsYXkgd2luZG93LlxuICovXG5cbi8qKiBUaGUgZGVmYXVsdCByZXBsYXkgd2luZG93LCBpbmhlcml0ZWQgZnJvbSBtaW5kLW1hcHBlcidzIG1lYXN1cmVkIGNhcC4gKi9cbmV4cG9ydCBjb25zdCBSRVBMQVlfQlVGRkVSX1NJWkUgPSAxMDAwO1xuXG4vKiogQSBmcmFtZSBhcyBpdCBnb2VzIG9uIHRoZSB3aXJlOiB0aGUgY2FsbGVyJ3MgcGF5bG9hZCBwbHVzIGEgbW9ub3RvbmljIGBpZGAsXG4gKiAgcGx1cyBhbiBgZXBvY2hgIHdoZW4gdGhlIGxvZyB3YXMgZ2l2ZW4gb25lLiAqL1xuZXhwb3J0IHR5cGUgRnJhbWU8VD4gPSBUICYgeyBpZDogbnVtYmVyOyBlcG9jaD86IHN0cmluZyB9O1xuXG5leHBvcnQgaW50ZXJmYWNlIEV2ZW50TG9nPFQ+IHtcbiAgLyoqIEFwcGVuZCBvbmUgZnJhbWUsIGZhbiBpdCBvdXQgdG8gbGl2ZSBzdWJzY3JpYmVycywgYW5kIHJldHVybiBpdC4gKi9cbiAgZW1pdChtc2c6IFQpOiBGcmFtZTxUPjtcbiAgLyoqXG4gICAqIFJlcGxheSBldmVyeXRoaW5nIGFmdGVyIGBzaW5jZWAsIHRoZW4gc3RheSBzdWJzY3JpYmVkLiBSZXR1cm5zIGFuXG4gICAqIHVuc3Vic2NyaWJlIGZ1bmN0aW9uLlxuICAgKlxuICAgKiDim5QgUkVQTEFZIEFORCBTVUJTQ1JJQkUgQVJFIE9ORSBDQUxMIE9OIFBVUlBPU0UuIERvaW5nIHRoZW0gaW4gdHdvIHN0ZXBzXG4gICAqIGxlYXZlcyBhIHdpbmRvdyBpbiB3aGljaCBhbiBlbWl0IGxhbmRzIGJldHdlZW4gdGhlIHJlcGxheSBsb29wIGFuZCB0aGVcbiAgICogYGFkZGAsIGFuZCB0aGF0IGZyYW1lIGlzIGRlbGl2ZXJlZCB0byBub2JvZHkg4oCUIHRoZSBzaGFwZSBmaXZlIGRhZW1vbnMgaGF2ZSxcbiAgICogc3Vydml2ZWQgYnkgbm90aGluZyBidXQgdGhlIHNpbmdsZS10aHJlYWRlZCBldmVudCBsb29wIGhhcHBlbmluZyB0byBjbG9zZVxuICAgKiBpdC4gRGVwZW5kaW5nIG9uIHRoYXQgaXMgZGVwZW5kaW5nIG9uIGFuIGltcGxlbWVudGF0aW9uIGRldGFpbCBvZiB0aGVcbiAgICogcnVudGltZSByYXRoZXIgdGhhbiBvbiB0aGUgY29kZS5cbiAgICovXG4gIHN1YnNjcmliZShzaW5jZTogbnVtYmVyLCBsaXN0ZW5lcjogKGZyYW1lOiBGcmFtZTxUPikgPT4gdm9pZCk6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgaGlnaGVzdCBpZCBlbWl0dGVkIHNvIGZhciDigJQgd2hhdCBgR0VUIC9zdGF0ZWAgcmV0dXJucyBhcyBgY3Vyc29yYC4gKi9cbiAgY3Vyc29yKCk6IG51bWJlcjtcbiAgLyoqIFRoZSBlcG9jaCBzdGFtcGVkIG9uIGV2ZXJ5IGZyYW1lLCBvciBgdW5kZWZpbmVkYCBpZiBub25lIHdhcyBjb25maWd1cmVkLiAqL1xuICByZWFkb25seSBlcG9jaDogc3RyaW5nIHwgdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRXZlbnRMb2c8VCBleHRlbmRzIG9iamVjdD4oXG4gIG9wdHM6IHsgZXBvY2g/OiBzdHJpbmc7IGJ1ZmZlclNpemU/OiBudW1iZXIgfSA9IHt9LFxuKTogRXZlbnRMb2c8VD4ge1xuICBjb25zdCBidWZmZXJTaXplID0gb3B0cy5idWZmZXJTaXplID8/IFJFUExBWV9CVUZGRVJfU0laRTtcbiAgY29uc3QgZXBvY2ggPSBvcHRzLmVwb2NoO1xuICBjb25zdCBidWZmZXI6IEFycmF5PEZyYW1lPFQ+PiA9IFtdO1xuICBjb25zdCBsaXN0ZW5lcnMgPSBuZXcgU2V0PChmcmFtZTogRnJhbWU8VD4pID0+IHZvaWQ+KCk7XG4gIGxldCBzZXEgPSAwO1xuXG4gIHJldHVybiB7XG4gICAgZXBvY2gsXG5cbiAgICBlbWl0KG1zZykge1xuICAgICAgc2VxICs9IDE7XG4gICAgICAvLyDim5QgVEhFIE1PTk9UT05JQyBJRCBXSU5TIE9WRVIgQU5ZVEhJTkcgSU4gVEhFIFBBWUxPQUQsIEFORCBVTlRJTCBOT1cgSVRcbiAgICAgIC8vIE9OTFkgQ0xBSU1FRCBUTy4gQm90aCBhZG9wdGluZyBkYWVtb25zIHdyb3RlIGB7IGlkOiArK3NlcSwgLi4ubXNnIH1gXG4gICAgICAvLyB1bmRlciBhIGNvbW1lbnQgc2F5aW5nIFwidGhlIG1vbm90b25pYyBgaWRgIE1VU1Qgd2luIG92ZXIgYW55IGBpZGAgaW5cbiAgICAgIC8vIHRoZSBwYXlsb2FkLCBzbyBjYWxsZXJzIGNhcnJ5IGEgcHJvamVjdCBpZGVudGlmaWVyIGFzIGBwcm9qZWN0SWRgLFxuICAgICAgLy8gbmV2ZXIgYGlkYFwiIOKAlCBidXQgc3ByZWFkIG9yZGVyIG1lYW5zIGEgcGF5bG9hZCBgaWRgIG92ZXJyb2RlIHRoZVxuICAgICAgLy8gY3Vyc29yLCBzaWxlbnRseSwgYW5kIHRoZSBjb252ZW50aW9uIGluIHRoZSBjb21tZW50IHdhcyB0aGUgb25seSB0aGluZ1xuICAgICAgLy8gaG9sZGluZyBpdC4gVGhlIGxpdGVyYWwga2VlcHMgYGlkYCBGSVJTVCBzbyB0aGUgd2lyZSBrZXkgb3JkZXIgaXNcbiAgICAgIC8vIHVuY2hhbmdlZDsgdGhlIGFzc2lnbm1lbnQgYWZ0ZXIgdGhlIHNwcmVhZCBpcyB3aGF0IG1ha2VzIHRoZSBzZW50ZW5jZVxuICAgICAgLy8gdHJ1ZS4gYGVwb2NoYCBpcyBzdGFtcGVkIHRoZSBzYW1lIHdheSBhbmQgZm9yIHRoZSBzYW1lIHJlYXNvbi5cbiAgICAgIGNvbnN0IGZyYW1lID0geyBpZDogc2VxLCAuLi5tc2cgfSBhcyBGcmFtZTxUPjtcbiAgICAgIGZyYW1lLmlkID0gc2VxO1xuICAgICAgaWYgKGVwb2NoICE9PSB1bmRlZmluZWQpIGZyYW1lLmVwb2NoID0gZXBvY2g7XG5cbiAgICAgIGJ1ZmZlci5wdXNoKGZyYW1lKTtcbiAgICAgIGlmIChidWZmZXIubGVuZ3RoID4gYnVmZmVyU2l6ZSkgYnVmZmVyLnNoaWZ0KCk7XG4gICAgICBmb3IgKGNvbnN0IGxpc3RlbmVyIG9mIGxpc3RlbmVycykgbGlzdGVuZXIoZnJhbWUpO1xuICAgICAgcmV0dXJuIGZyYW1lO1xuICAgIH0sXG5cbiAgICBzdWJzY3JpYmUoc2luY2UsIGxpc3RlbmVyKSB7XG4gICAgICAvLyBTZWUgdGhlIGhlYWRlciwgcG9pbnQgMzogYSBjdXJzb3IgYmV5b25kIG91ciBvd24gaXMgYSBjdXJzb3IgZnJvbSBhXG4gICAgICAvLyBQUklPUiBQUk9DRVNTLCBhbmQgdGhlIG9ubHkgdXNlZnVsIHJlYWRpbmcgb2YgaXQgaXMgXCJyZXBsYXkgd2hvbGVcIi5cbiAgICAgIC8vXG4gICAgICAvLyDimqAgQSBOT04tRklOSVRFIENVUlNPUiBBTFNPIE1FQU5TIFwiRlJPTSBUSEUgU1RBUlRcIiwgd2hpY2ggdGhlIGNvcGllcyBnb3RcbiAgICAgIC8vIHdyb25nIGJ5IGFjY2lkZW50OiB0aGV5IHdyb3RlIGBwYXJzZUludChwYXJhbSA/PyBcIi0xXCIpYCBhbmQgY29tcGFyZWRcbiAgICAgIC8vIGBpZCA+IHNpbmNlYCwgc28gYSB0eXBvJ2QgYD9zaW5jZT14YCBwcm9kdWNlZCBgTmFOYCwgZXZlcnkgY29tcGFyaXNvblxuICAgICAgLy8gd2FzIGZhbHNlLCBhbmQgdGhlIHRhaWwgb3BlbmVkIEVNUFRZIGFuZCBzdGF5ZWQgY29ubmVjdGVkIOKAlCB0aGUgc2FtZVxuICAgICAgLy8gc2lsZW50LWFuZC1jb25uZWN0ZWQgc3ltcHRvbSBhcyB0aGUgc3RhbGUgd2F0ZXJtYXJrLCBmcm9tIGEgZGlmZmVyZW50XG4gICAgICAvLyBjYXVzZS4gQWJzZW50IGFuZCB1bnBhcnNlYWJsZSBhcmUgdGhlIHNhbWUgcmVxdWVzdCBoZXJlLlxuICAgICAgY29uc3QgZnJvbSA9ICFOdW1iZXIuaXNGaW5pdGUoc2luY2UpIHx8IHNpbmNlID4gc2VxID8gLTEgOiBzaW5jZTtcbiAgICAgIGZvciAoY29uc3QgZnJhbWUgb2YgYnVmZmVyKSB7XG4gICAgICAgIGlmIChmcmFtZS5pZCA+IGZyb20pIGxpc3RlbmVyKGZyYW1lKTtcbiAgICAgIH1cbiAgICAgIGxpc3RlbmVycy5hZGQobGlzdGVuZXIpO1xuICAgICAgcmV0dXJuICgpID0+IHtcbiAgICAgICAgbGlzdGVuZXJzLmRlbGV0ZShsaXN0ZW5lcik7XG4gICAgICB9O1xuICAgIH0sXG5cbiAgICBjdXJzb3IoKSB7XG4gICAgICByZXR1cm4gc2VxO1xuICAgIH0sXG4gIH07XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGRhZW1vbiBsaWZlY3ljbGUgdGFpbDogdGhlIGlkbGUtY2xvc2UgZGVjaXNpb24sIHRoZSBzd2VlcFxuICogdGhhdCBtYWtlcyBpdCwgYW5kIHRoZSBib3VuZGVkIHRlYXJkb3duLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIGJvdW50eSDigJQgdGhlIGNlbnN1cydzXG4gKiBjb252ZXJnZW5jZSB0YXJnZXQgIzMg4oCUIHdpdGggYXN0cm9sYWJlJ3MgYHRpbWVvdXRNcyA+IDBgIGd1YXJkIGZvbGRlZCBpbixcbiAqIHdoaWNoIGlzIHRoZSBvbmUgdGhpbmcgYm91bnR5J3MgY29weSBkb2VzIG5vdCBleHByZXNzLlxuICpcbiAqIOKUgOKUgCDim5QgR1JBUEVWSU5FIEFET1BUUyBgZHJhaW5BbmRTdG9wYCBBTkQgTk9USElORyBFTFNFIEhFUkUg4oCUIFNQTElUIFBFUiBFWFBPUlRcbiAqXG4gKiBSdWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLCBhbmQgaXQgaXMgd3JpdHRlbiBkb3duXG4gKiBiZWNhdXNlIGEgcm93IGlzIGEgTU9EVUxFIGFuZCBcInBhcnRpYWxcIiBpcyBub3QgYW4gYW5zd2VyIHVudGlsIGl0IHNheXMgd2hpY2hcbiAqIGV4cG9ydHMuIEdyYXBldmluZSBpcyBsb25nLXJ1bm5pbmcsIHNvIG5vdGhpbmcgYWJvdXQgaXRzIGxpZmVjeWNsZSBtYWtlcyB0aGlzXG4gKiBtb2R1bGUgcmVhZCBhcyBpbmFwcGxpY2FibGUg4oCUIGFuZCB0d28gb2YgaXRzIHRocmVlIGV4cG9ydHMgc3RpbGwgaGF2ZSBub1xuICogc3ViamVjdCB0aGVyZTpcbiAqXG4gKiAgIGBzaG91bGRJZGxlQ2xvc2VgICAgICAgTk8gU1VCSkVDVC4gR3JhcGV2aW5lIHJ1bnMgbm8gaWRsZSBzd2VlcCBhbmQgaGFzIG5vXG4gKiAgIGBzdGFydEhvdXNla2VlcGluZ2AgICAgYC0tdGltZW91dGA7IGl0IGlzIGEgYnJva2VyIHRoYXQgc3RhbmRzIHVudGlsIGBzdG9wYFxuICogICAgICAgICAgICAgICAgICAgICAgICAgIChgREVMRVRFIC9gKSBvciBhIHNpZ25hbCwgYW5kIGl0IHRha2VzIG5vIHNuYXBzaG90LlxuICogICAgICAgICAgICAgICAgICAgICAgICAgIEFkb3B0aW5nIHRoZSBwYWlyLW1hbmFnZXIgd291bGQgbWVhbiB3cml0aW5nIGEgbm8tb3BcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgdG91Y2hgIGFuZCBhIGBzdWJzY3JpYmVyQ291bnRgIHRoYXQgZXhpc3RzIG9ubHkgdG9cbiAqICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gYSBudW1iZXIgbm9ib2R5IGFjdHMgb24g4oCUIHR3byBsaWVzIHRvIGdhaW4gYVxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBjbGVhckludGVydmFsYC5cbiAqICAgYGRyYWluQW5kU3RvcGAgICAgICAgICBBRE9QVEVELCBhbmQgaXQgaXMgYSBERS1EVVBMSUNBVElPTiByYXRoZXIgdGhhbiBhXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgZ2FpbjogZ3JhcGV2aW5lJ3MgdGVhcmRvd24gYWxyZWFkeSBXQVNcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgUHJvbWlzZS5yYWNlKFtzZXJ2ZXIuc3RvcCh0cnVlKSwgMjAwIG1zXSlgLCB3aGljaCBpc1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBzdG9wTXNgIGV4YWN0bHkuXG4gKlxuICog4pqgICoqQU5EIElUIElTIENBTExFRCBXSVRIIE5PIGBjbGllbnRzYCwgV0hJQ0ggSVMgQSBNRUFTVVJFTUVOVCwgTk9UIEFOXG4gKiBPVkVSU0lHSFQuKiogVGhpcyBtb2R1bGUgY2xvc2VzIGEgaGVsZCBjb25uZWN0aW9uIGJ5IGNhbGxpbmcgYGNsaWVudC5jbG9zZSgpYDtcbiAqIGdyYXBldmluZSdzIHN1YnNjcmliZXIgcmVjb3JkcyBhcmUgYHthbGlhcywgaHVtYW4sIGx1cmssIHNlbmR9YCBhbmQgY2Fycnkgbm9cbiAqIGBjbG9zZWAg4oCUIGl0cyBwZXItc3RyZWFtIHRlYXJkb3duIGlzIGEgY2xvc3VyZSBzdGFzaGVkIG9uIHRoZSBSZWFkYWJsZVN0cmVhbVxuICogY29udHJvbGxlciwgcmVhY2hhYmxlIG9ubHkgZnJvbSBgY2FuY2VsKClgLiBUaGVyZSBpcyBub3RoaW5nIHRvIGhhbmQgdGhlXG4gKiBhcmd1bWVudC4gYHNzZS50c2AncyBoZWFkZXIgY2FycmllcyB0aGUgcmVzdCBvZiB0aGF0IHJ1bGluZywgaW5jbHVkaW5nIHRoZVxuICogd2lkZW5pbmcgbm90IGRvbmUgYW5kIGl0cyBjb3N0IChzaXggYXJ0aWZhY3RzIGFjcm9zcyBmaXZlIHNwZWxscykuXG4gKlxuICog4pqgIEdyYXBldmluZSBhbHNvIHBhc3NlcyBgZ3JhY2VNczogMGAuIE5vdCBhIGRpc2FncmVlbWVudCB3aXRoIHRoZSBncmFjZVxuICogcGVyaW9kOiBpdCBlbWl0cyBubyBmYXJld2VsbCBmcmFtZSBhdCBkYWVtb24gc2h1dGRvd24sIGFuZCBpdHMgYERFTEVURSAvYFxuICogYWxyZWFkeSByZXR1cm5zIHRoZSByZXNwb25zZSBhbmQgc2NoZWR1bGVzIHRoZSB0ZWFyZG93biAxMCBtcyBsYXRlciwgc28gaXRzXG4gKiBmbHVzaCB3aW5kb3cgc2l0cyBhdCB0aGUgcm91dGUgcmF0aGVyIHRoYW4gaW4gdGhlIGRyYWluLlxuICovXG5cbmltcG9ydCB0eXBlIHsgU3NlQ2xpZW50cyB9IGZyb20gXCIuL3NzZS50c1wiO1xuXG4vKipcbiAqIFNob3VsZCB0aGUgZGFlbW9uIGlkbGUtY2xvc2U/XG4gKlxuICog4puUICoqYHN1YnNjcmliZXJDb3VudGAgSVMgQSBSRVFVSVJFRCBBUkdVTUVOVCwgQU5EIFRIQVQgSVMgVEhFIFdIT0xFIFBPSU5ULioqXG4gKiBUaGlzIGNsb3NlcyBjZW5zdXMgZGVmZWN0ICoqTDEqKiBieSBjb25zdHJ1Y3Rpb246IGdsYW1vdXIsIGltYWdvIGFuZCBtYWdwaWVcbiAqIGNvdW50ZWQgdGhlaXIgaWRsZSBmbG9vciBkb3duIHdoaWxlIGFuIGFnZW50IGhlbGQgYSB0YWlsIG9wZW4sIHNvIGFuIGFnZW50XG4gKiB3YXRjaGluZyBhIHF1aWV0IGJvYXJkIHdhcyBraWxsZWQgV0lUSCBJVFMgQ09OTkVDVElPTiBPUEVOLiBUaGVyZSBpcyBub1xuICogb3ZlcmxvYWQgb2YgdGhpcyBmdW5jdGlvbiB0aGF0IGNhbm5vdCBzZWUgaXRzIHN1YnNjcmliZXJzLCBzbyB0aGUgZGVmZWN0XG4gKiBjYW5ub3QgYmUgcmUtZXhwcmVzc2VkIGJ5IGEgY2FsbGVyIHdobyBmb3JnZXRzLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0NBUiBJVCBDQU1FIFdJVEgsIHJlLWhvbWVkIGZyb20gYm91bnR5IHZlcmJhdGltIGluIHN1YnN0YW5jZToqKlxuICogYSBib2FyZCBvbmx5IGNvdW50cyBpdHMgaWRsZSBmbG9vciBkb3duIHdoaWxlIFVOV0FUQ0hFRC4gQSBsaXZlIHN1YnNjcmliZXIg4oCUXG4gKiBhIGJyb3dzZXIgV2ViU29ja2V0LCBvciBhbiBhZ2VudCBTU0UgdGFpbCBvbiBgL2V2ZW50c2Ag4oCUIGtlZXBzIGl0IG9wZW5cbiAqIGluZGVmaW5pdGVseS4gU28gYHRpbWVvdXRgIG1lYW5zIFwibGluZ2VyIHRoaXMgbG9uZyBhZnRlciB0aGUgTEFTVCBzdWJzY3JpYmVyXG4gKiBsZWF2ZXNcIiwgTk9UIFwibWF4aW11bSBpZGxlIHdoaWxlIGNvbm5lY3RlZFwiLiBUaGUgc3dlZXAgYmVsb3cgYWxzbyB0b3VjaGVzIHRoZVxuICogYWN0aXZpdHkgY2xvY2sgb24gZXZlcnkgdGljayB3aGlsZSB3YXRjaGVkLCBzbyBvbmNlIHVud2F0Y2hlZCB0aGUgZmxvb3JcbiAqIGNvdW50cyBmcm9tIHRoYXQgbGFzdCBkaXNjb25uZWN0IGFuZCBub3QgZnJvbSB0aGUgbGFzdCByZXF1ZXN0LlxuICpcbiAqIOKaoCBgdGltZW91dE1zIDw9IDBgIG1lYW5zIE5FVkVSLCB3aGljaCBpcyBhc3Ryb2xhYmUncyBzdGFuZGluZy1vYnNlcnZhdG9yeVxuICogZGVmYXVsdCBhbmQgaXMgd2h5IHRoZSBndWFyZCBpcyBoZXJlIHJhdGhlciB0aGFuIGF0IGl0cyBvbmUgY2FsbCBzaXRlOiBhXG4gKiBzaW5nbGV0b24gZGFlbW9uIGlzIG1lYW50IHRvIHN0YW5kIHVudGlsIGl0IGlzIGV4cGxpY2l0bHkgY2xvc2VkLCBhbmQgYVxuICogYD49IDBgIGNvbXBhcmlzb24gd291bGQgY2xvc2UgaXQgb24gdGhlIGZpcnN0IHRpY2suXG4gKlxuICogQ2xvY2stZnJlZSBhbmQgZnMtZnJlZSwgc28gaXQgaXMgdGVzdGFibGUgd2l0aG91dCBhIGRhZW1vbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZElkbGVDbG9zZShcbiAgc3Vic2NyaWJlckNvdW50OiBudW1iZXIsXG4gIGlkbGVNczogbnVtYmVyLFxuICB0aW1lb3V0TXM6IG51bWJlcixcbik6IGJvb2xlYW4ge1xuICBpZiAodGltZW91dE1zIDw9IDApIHJldHVybiBmYWxzZTtcbiAgaWYgKHN1YnNjcmliZXJDb3VudCA+IDApIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGlkbGVNcyA+PSB0aW1lb3V0TXM7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSG91c2VrZWVwaW5nT3B0aW9ucyB7XG4gIC8qKiDim5QgUkVRVUlSRUQuIFNlZSBgc2hvdWxkSWRsZUNsb3NlYCDigJQgdGhpcyBpcyB3aGF0IGNsb3NlcyBMMS4gKi9cbiAgc3Vic2NyaWJlckNvdW50OiAoKSA9PiBudW1iZXI7XG4gIC8qKiBNaWxsaXNlY29uZHMgc2luY2UgdGhlIGxhc3QgYWN0aXZpdHkuICovXG4gIGlkbGVNczogKCkgPT4gbnVtYmVyO1xuICAvKiogUmVzZXQgdGhlIGFjdGl2aXR5IGNsb2NrLiBDYWxsZWQgb24gZXZlcnkgdGljayB0aGF0IGhhcyBhIHN1YnNjcmliZXIuICovXG4gIHRvdWNoOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGNvbmZpZ3VyZWQgaWRsZSB0aW1lb3V0IGluIG1zOyBgMGAgKG9yIGxlc3MpIG1lYW5zIG5ldmVyLiAqL1xuICB0aW1lb3V0TXM6IG51bWJlcjtcbiAgLyoqIEZpcmVkIG9uY2Ugd2hlbiB0aGUgZGFlbW9uIHNob3VsZCBjbG9zZSBpdHNlbGYuICovXG4gIG9uSWRsZUNsb3NlOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGRlYm91bmNlZCBzbmFwc2hvdCwgaWYgdGhlIHNwZWxsIGhhcyBvbmUuICovXG4gIHNuYXBzaG90Pzoge1xuICAgIGRpcnR5OiAoKSA9PiBib29sZWFuO1xuICAgIGNsZWFyOiAoKSA9PiB2b2lkO1xuICAgIHdyaXRlOiAoKSA9PiB2b2lkIHwgUHJvbWlzZTx2b2lkPjtcbiAgfTtcbiAgLyoqIFN3ZWVwIGludGVydmFsOyBib3RoIGFkb3B0aW5nIGRhZW1vbnMgdXNlZCAyNTAgbXMuICovXG4gIHRpY2tNcz86IG51bWJlcjtcbiAgLyoqIFNuYXBzaG90IGludGVydmFsOyBib3RoIGFkb3B0aW5nIGRhZW1vbnMgdXNlZCAxMDAwIG1zLiAqL1xuICBzbmFwc2hvdE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFN0YXJ0IHRoZSB0d28gc3RhbmRpbmcgdGltZXJzIGV2ZXJ5IHNlc3Npb24gZGFlbW9uIHJ1bnMg4oCUIHRoZSBpZGxlIHN3ZWVwIGFuZFxuICogdGhlIGRlYm91bmNlZCBzbmFwc2hvdCDigJQgYW5kIHJldHVybiB0aGUgZnVuY3Rpb24gdGhhdCBzdG9wcyBib3RoLlxuICpcbiAqIFRoZXkgYXJlIE9ORSBjYWxsIGJlY2F1c2UgdGhleSBoYXZlIGFsd2F5cyBiZWVuIG9uZSBsaWZldGltZTogZXZlcnkgY29weVxuICogY2xlYXJlZCBib3RoIGluIHRoZSBzYW1lIHR3byBsaW5lcyBhZnRlciBgYXdhaXQgZG9uZWAsIGFuZCB0aGUgcGFpciB0aGF0IGdldHNcbiAqIGZvcmdvdHRlbiBpcyB0aGUgcGFpciB3aG9zZSB0aW1lcnMga2VlcCBhIHByb2Nlc3MgYWxpdmUgYWZ0ZXIgdGVhcmRvd24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFydEhvdXNla2VlcGluZyhvcHRzOiBIb3VzZWtlZXBpbmdPcHRpb25zKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHRpY2tNcyA9IG9wdHMudGlja01zID8/IDI1MDtcbiAgY29uc3Qgc25hcHNob3RNcyA9IG9wdHMuc25hcHNob3RNcyA/PyAxMDAwO1xuXG4gIGNvbnN0IGlkbGVUaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICBjb25zdCBzdWJzY3JpYmVycyA9IG9wdHMuc3Vic2NyaWJlckNvdW50KCk7XG4gICAgaWYgKHN1YnNjcmliZXJzID4gMCkgb3B0cy50b3VjaCgpO1xuICAgIGlmIChzaG91bGRJZGxlQ2xvc2Uoc3Vic2NyaWJlcnMsIG9wdHMuaWRsZU1zKCksIG9wdHMudGltZW91dE1zKSkgb3B0cy5vbklkbGVDbG9zZSgpO1xuICB9LCB0aWNrTXMpO1xuXG4gIGNvbnN0IHNuYXAgPSBvcHRzLnNuYXBzaG90O1xuICBjb25zdCBzbmFwVGltZXIgPSBzbmFwXG4gICAgPyBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICAgIGlmICghc25hcC5kaXJ0eSgpKSByZXR1cm47XG4gICAgICAgIHNuYXAuY2xlYXIoKTtcbiAgICAgICAgdm9pZCBzbmFwLndyaXRlKCk7XG4gICAgICB9LCBzbmFwc2hvdE1zKVxuICAgIDogbnVsbDtcblxuICByZXR1cm4gKCkgPT4ge1xuICAgIGNsZWFySW50ZXJ2YWwoaWRsZVRpbWVyKTtcbiAgICBpZiAoc25hcFRpbWVyICE9PSBudWxsKSBjbGVhckludGVydmFsKHNuYXBUaW1lcik7XG4gIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRHJhaW5PcHRpb25zIHtcbiAgLyoqIFRoZSBib3VuZCBzZXJ2ZXIuIFR5cGVkIHN0cnVjdHVyYWxseSBzbyB0aGUga2l0IHN0YXlzIGZyZWUgb2YgYGJ1bmAuICovXG4gIHNlcnZlcjogeyBzdG9wKGNsb3NlQWN0aXZlQ29ubmVjdGlvbnM/OiBib29sZWFuKTogdW5rbm93biB9O1xuICAvKiogTGl2ZSBTU0UgdGFpbHM7IGV2ZXJ5IHJlZ2lzdGVyZWQgY2xvc2VyIGlzIGludm9rZWQuICovXG4gIGNsaWVudHM/OiBTc2VDbGllbnRzO1xuICAvKiogTGl2ZSBXZWJTb2NrZXRzLiAqL1xuICBzb2NrZXRzPzogSXRlcmFibGU8eyBjbG9zZSgpOiB2b2lkIH0+O1xuICAvKiogSG93IGxvbmcgcXVldWVkIGZyYW1lcyBnZXQgdG8gZmx1c2ggYmVmb3JlIGFueXRoaW5nIGlzIGNsb3NlZC4gKi9cbiAgZ3JhY2VNcz86IG51bWJlcjtcbiAgLyoqIEhvdyBsb25nIHRoZSBncmFjZWZ1bCBzdG9wIGdldHMgYmVmb3JlIHRlYXJkb3duIHByb2NlZWRzIHJlZ2FyZGxlc3MuICovXG4gIHN0b3BNcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBDbG9zZSBldmVyeSBoZWxkIGNvbm5lY3Rpb24gYW5kIHN0b3AgdGhlIHNlcnZlciwgaW4gYm91bmRlZCB0aW1lLlxuICpcbiAqIOKblCAqKlRIRSBHUkFDRSBQRVJJT0QgSVMgTk9UIFBPTElURU5FU1MuKiogQSBgY2xvc2VkYCBmcmFtZSBlbWl0dGVkIGFuZCB0aGVuXG4gKiBmb2xsb3dlZCBpbW1lZGlhdGVseSBieSBhbiBhZ2dyZXNzaXZlIGBzZXJ2ZXIuc3RvcCh0cnVlKWAgaXMgYSBmcmFtZSB0aGVcbiAqIGNsaWVudCBuZXZlciBzZWVzIOKAlCB0aGUgcXVldWUgZ29lcyB3aXRoIHRoZSBzb2NrZXQuIFRoZSAxNTAgbXMgaXMgd2hhdCB0dXJuc1xuICogXCJ0aGUgZGFlbW9uIHRvbGQgeW91IHdoeSBpdCBkaWVkXCIgZnJvbSBhIGhvcGUgaW50byBhbiBvYnNlcnZhdGlvbiwgYW5kIGV2ZXJ5XG4gKiBvbmUgb2YgdGhlIGVpZ2h0IGRhZW1vbnMgY29udmVyZ2VkIG9uIHRoYXQgbnVtYmVyIGluZGVwZW5kZW50bHkuXG4gKlxuICog4puUICoqQU5EIFRIRSBTVE9QIElTIFJBQ0VELCBCRUNBVVNFIEEgU0xPVyBTT0NLRVQgTVVTVCBOT1QgQkUgQUJMRSBUTyBIQU5HXG4gKiBURUFSRE9XTi4qKiBgc2VydmVyLnN0b3AodHJ1ZSlgIGF3YWl0cyBpdHMgY29ubmVjdGlvbnM7IG9uZSB3ZWRnZWQgcGVlciBpc1xuICogZW5vdWdoIHRvIHBhcmsgaXQgZm9yZXZlciwgd2hpY2ggaXMgaG93IGEgMjMtbWludXRlIGhhbmcgc2hpcHBlZCBvbmNlLlxuICpcbiAqIOKaoCAqKldIQVQgSVMgREVMSUJFUkFURUxZIE5PVCBIRVJFOiBib3VudHkncyBzaHV0ZG93biB3YXRjaGRvZy4qKiBCb3VudHkgYXJtc1xuICogYSBSRUYnZCBgc2V0VGltZW91dGAgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBpZiB0ZWFyZG93biBkb2VzIG5vdCBmaW5pc2gsXG4gKiBhbmQgdGhlIGNlbnN1cyBpcyByaWdodCB0aGF0IGl0IGlzIHRoZSBjb3JwdXMncyBvbmx5IHVuY29uZGl0aW9uYWxcbiAqIHRlcm1pbmF0aW9uIGd1YXJhbnRlZS4gSXQgYmVsb25ncyB0byBib3VudHkncyBURUFSRE9XTiDigJQgdGhlIHN0cmV0Y2ggd2hlcmVcbiAqIG5vdGhpbmcgYm91bmRzIHdoYXQgaXMgYmVpbmcgd2FpdGVkIG9uLiDim5QgKipUSElTIFBBUkFHUkFQSCBTQUlEIFwiU0lHTkFMXG4gKiBQQVRIXCIgVU5USUwgRDUzLCBBTkQgVEhFIENPREUgQUdSRUVEIFdJVEggSVQsIFdISUNIIFdBUyBUSEUgREVGRUNULioqIEJvdW50eVxuICogaGFzIEZPVVIgd2F5cyBpbnRvIG9uZSB0ZWFyZG93biAoYSBzaWduYWwsIGEgYGNsb3NlYCB2ZXJiLCB0aGUgYnJvd3NlcidzXG4gKiBjbG9zZSBvdmVyIHRoZSBXZWJTb2NrZXQsIGFuIGlkbGUgdGltZW91dCkgYW5kIG9ubHkgdGhlIHNpZ25hbCBvbmUgYXJtZWQgdGhlXG4gKiB0aW1lciwgd2hpbGUgdGhlIGNvbW1lbnQgYWJvdmUgaXQgY2xhaW1lZCB0aGUgZW5kaW5nIHdhcyB1bmNvbmRpdGlvbmFsLlxuICogRHJpdmVuIHdpdGggYSBwbGFudGVkIGhhbmc6IHRoZSBvdGhlciB0aHJlZSByYW4gcGFzdCAxMCBzLCB0aGUgaWRsZSBvbmVcbiAqIGluY2x1ZGVkIOKAlCB0aGUgb3JwaGFuLWRhZW1vbiBjbGFzcyB0aGUgMjMtbWludXRlIGhhbmcgY2FtZSBmcm9tLiBUaGUgYXJtaW5nXG4gKiBub3cgbGl2ZXMgaW4gdGhlIFJFU09MVkUgdGhhdCBhbGwgZm91ciBlbnRyaWVzIHBhc3MgdGhyb3VnaC4gKipUaGUgbGVzc29uIGZvclxuICogYW4gYWRvcHRlciBpcyB0aGUgY291bnQsIG5vdCB0aGUgcGxhY2VtZW50OiBlbnVtZXJhdGUgZXZlcnkgZW50cnkgaW50byB0aGVcbiAqIHRlYXJkb3duIGJlZm9yZSB5b3UgYmVsaWV2ZSBhIGd1YXJhbnRlZSBjb3ZlcnMgaXQuKiogVGhlIHR3b1xuICogZGFlbW9ucyBhZG9wdGluZyB0aGlzIG1vZHVsZSByZWdpc3RlciBubyBzaWduYWwgaGFuZGxlcnMsIGFuZCB0aGVpciB3aG9sZVxuICogdGVhcmRvd24gaXMgYm91bmRlZCBieSB0aGUgdHdvIG51bWJlcnMgYWJvdmU7IGFkZGluZyBhbiBleGl0IGhlcmUgd291bGQgcHV0XG4gKiB0aGUgaG91c2UncyBvbmx5IHVuY29uZGl0aW9uYWwgYHByb2Nlc3MuZXhpdGAgaW5zaWRlIGEgbW9kdWxlIGV2ZXJ5IHNwZWxsIGlzXG4gKiBhYm91dCB0byBidW5kbGUsIG9uZSBwaGFzZSBhZnRlciBEOCB0b29rIGV4YWN0bHkgdGhhdCBoYXphcmQgT1VUIG9mIGBkaWVgLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VOVEVOQ0UgVEhBVCBVU0VEIFRPIEVORCBUSEFUIFBBUkFHUkFQSCBXQVMgQSBQUkVESUNUSU9OLCBXSElDSFxuICogQk9VTlRZJ1MgT1dOIFBPUlQgRkFMU0lGSUVELioqIEl0IHJlYWQ6IFwid2hlbiBhIHNwZWxsIHdpdGggYSBzaWduYWwgcGF0aFxuICogYWRvcHRzIHRoaXMsIHRoZSB3YXRjaGRvZyBhcnJpdmVzIGFzIGFuIG9wdGlvbiBvbiB0aGVzZSBhcmd1bWVudHMgYW5kIHRoZVxuICogcmVhc29uaW5nIGlzIGFscmVhZHkgd3JpdHRlbiBkb3duLlwiIGJvdW50eSBhZG9wdGVkIGBkcmFpbkFuZFN0b3BgIG9uXG4gKiAyMDI2LTA5LTA5IChQaGFzZSA0KSBhbmQgdGhlIG9wdGlvbiB3YXMgTk9UIGFkZGVkLCBiZWNhdXNlIHRoZSB3aW5kb3cgaXNcbiAqIHdyb25nLiAqKkEgYHdhdGNoZG9nTXNgIG9uIHRoZXNlIGFyZ3VtZW50cyB3b3VsZCBhcm0gYXQgRFJBSU4gdGltZTsgYm91bnR5J3NcbiAqIGFybXMgYXQgU0lHTkFMIHRpbWUqKiwgYW5kIHRoZSB3aG9sZSByZWFzb24gaXQgZXhpc3RzIGlzIHRoZSBzdHJldGNoIEJFVFdFRU5cbiAqIHRob3NlIHR3byBwb2ludHMg4oCUIGBhd2FpdCBkb25lYCwgYW4gZnMgYXBwZW5kIHRvIHRoZSBkYWVtb24gbG9nLCBhIGZ1bGxcbiAqIHNuYXBzaG90IHdyaXRlIHRoYXQgY2FuIHJvdGF0ZSBhbmQgQ09QWSBhIGJhY2t1cCBvZiBhIGxhcmdlIGJvYXJkLCBhIGBjbG9zZWRgXG4gKiBmcmFtZSBhbmQgYSBicm9hZGNhc3QuIGBkcmFpbkFuZFN0b3BgJ3Mgb3duIGJvZHkgaXMgYWxyZWFkeSBib3VuZGVkIGJ5IHRoZSB0d29cbiAqIG51bWJlcnMgYWJvdmUsIHNvIGEgd2F0Y2hkb2cgc2NvcGVkIHRvIGl0IHdvdWxkIGd1YXJkIHRoZSBvbmUgc3RyZXRjaCB0aGF0XG4gKiBjYW5ub3QgaGFuZyBhbmQgYWJhbmRvbiB0aGUgc3RyZXRjaCB0aGF0IGNhbjogaXQgd291bGQgUkVBRCBhcyBhZG9wdGlvbiBhbmRcbiAqIEJFIGEgbmFycm93aW5nIG9mIHRoZSBjb3JwdXMncyBvbmx5IHVuY29uZGl0aW9uYWwgdGVybWluYXRpb24gZ3VhcmFudGVlLiBUaGVcbiAqIDIzLW1pbnV0ZSBoYW5nIHRoaXMgcHJvamVjdCBrZWVwcyBjaXRpbmcgaGFwcGVuZWQgaW4gdGhlIHVuYm91bmRlZCBzdHJldGNoLlxuICpcbiAqIOKaoCAqKlNPIFRIRSBSVUxFIEZPUiBUSEUgTkVYVCBTUEVMTCwgV0hJQ0ggSVMgVEhFIFRSQU5TRkVSQUJMRSBIQUxGOioqIHRoZVxuICogcXVlc3Rpb24gaXMgbmV2ZXIgXCJkb2VzIHRoaXMgbW9kdWxlIGhhdmUgYSBwbGFjZSB0byBwdXQgYSB3YXRjaGRvZ1wiIGJ1dFxuICogXCJkb2VzIHRoZSB3YXRjaGRvZydzIHdpbmRvdyBjb2luY2lkZSB3aXRoIHRoaXMgbW9kdWxlJ3NcIi4gV2hlcmUgYSBzcGVsbCdzXG4gKiB0ZWFyZG93biBoYXMgdW5ib3VuZGVkIHdvcmsgQkVGT1JFIHRoZSBkcmFpbiwgdGhlIHdhdGNoZG9nIGJlbG9uZ3MgYXQgdGhlXG4gKiBzcGVsbCwgd3JhcHBlZCBhcm91bmQgYWxsIG9mIGl0IOKAlCBhbmQgYXJvdW5kIEVWRVJZIFdBWSBJTiwgd2hpY2ggaXMgdGhlIGhhbGZcbiAqIEQ1MyBoYWQgdG8gcmVwYWlyIGFmdGVyIHRoaXMgaGVhZGVyIHdhcyB3cml0dGVuLiBJZiBhIHNwZWxsIGV2ZXIgYXBwZWFycyB3aG9zZSBzaWduYWwgcGF0aFxuICogZW50ZXJzIGBkcmFpbkFuZFN0b3BgIGltbWVkaWF0ZWx5LCBhZGQgdGhlIG9wdGlvbiBUSEVOIOKAlCBhbmQgdGhlIG9wdGlvbiBtdXN0XG4gKiB0YWtlIGFuIGBvbkV4cGlyZWAgY2FsbGJhY2sgcmF0aGVyIHRoYW4gZXhpdGluZywgc28gdGhlIGBwcm9jZXNzLmV4aXRgIHN0YXlzXG4gKiBvdXRzaWRlIGEgbW9kdWxlIGV2ZXJ5IHNwZWxsIGJ1bmRsZXMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkcmFpbkFuZFN0b3Aob3B0czogRHJhaW5PcHRpb25zKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGdyYWNlTXMgPSBvcHRzLmdyYWNlTXMgPz8gMTUwO1xuICBjb25zdCBzdG9wTXMgPSBvcHRzLnN0b3BNcyA/PyAyMDA7XG5cbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgZ3JhY2VNcykpO1xuXG4gIGlmIChvcHRzLmNsaWVudHMpIHtcbiAgICBmb3IgKGNvbnN0IGNsaWVudCBvZiBbLi4ub3B0cy5jbGllbnRzXSkgY2xpZW50LmNsb3NlKCk7XG4gIH1cbiAgaWYgKG9wdHMuc29ja2V0cykge1xuICAgIGZvciAoY29uc3Qgd3Mgb2YgWy4uLm9wdHMuc29ja2V0c10pIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLmNsb3NlKCk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICBQcm9taXNlLnJlc29sdmUob3B0cy5zZXJ2ZXIuc3RvcCh0cnVlKSksXG4gICAgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgc3RvcE1zKSksXG4gIF0pO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBhc3NldC1zZXJ2aW5nIHRyaW8gZm9yIGEgc3BlbGwgZGFlbW9uOiB3aGljaCBzdXJmYWNlIG1vZGUgd2VcbiAqIGFyZSBpbiwgd2hhdCBjb250ZW50IHR5cGUgYSBmaWxlIGdldHMsIGFuZCBob3cgYSBmaWxlIHVuZGVyIGBkaXN0L2AgaXNcbiAqIGFuc3dlcmVkLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIGFuZCB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3MgYXJ0aWZhY3QuXG4gKlxuICogRXh0cmFjdGVkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgZnJvbSB0aGUgZWlnaHQgYEJ1bi5zZXJ2ZWAgYmFja2VuZHNcbiAqIGNlbnN1c2VkIGluIGBkb2NzL2ludmVzdGlnYXRpb25zLzIwMjYtMDktMDgtZGFlbW9uLXNwaW5lLWNlbnN1cy5tZGAsIHdoaWNoXG4gKiBtZWFzdXJlZCBgcmVzb2x2ZU1vZGVgIGFzIGJ5dGUtaWRlbnRpY2FsIGluIGFsbCBlaWdodCAodGhlIG9ubHkgbWQ1IGRpZmZlcmVuY2VcbiAqIGJlaW5nIHRoZSBgZXhwb3J0YCBrZXl3b3JkKSwgdGhlIGNvbnRlbnQtdHlwZSBtYXAgYXMgZGlmZmVyaW5nIGluIGV4YWN0bHlcbiAqIG9uZSBjZWxsLCBhbmQgdGhlIGZpbGUgaGFsZiBvZiBgc2VydmVEaXN0YCBhcyBpZGVudGljYWwgaW4gZml2ZS5cbiAqXG4gKiDilIDilIAgV0hBVCBERUxJQkVSQVRFTFkgRElEIE5PVCBDT01FIEFMT05HIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICoqVGhlIFVSTC10by1maWxlbmFtZSBtYXBwaW5nIHN0YXlzIGluIGVhY2ggcm91dGVyLioqIFRoZSBjZW5zdXMgbWFya2VkIHR3b1xuICogb2YgdGhlIGVpZ2h0IGBzZXJ2ZURpc3RgIGRpdmVyZ2VuY2VzIERFTElCRVJBVEUgYW5kIGJvdGggbGl2ZSBpbiB0aGF0IGhhbGY6XG4gKiBkaWdlc3RpZnkgc3Vic3RpdHV0ZXMgaW50byB0aGUgZW50cnkgSFRNTCBpbiBtZW1vcnksIGFuZCBncmFwZXZpbmUgc2VydmVzIGl0c1xuICogc3VyZmFjZSBhdCBgL3dhdGNoYCByYXRoZXIgdGhhbiBhdCBgL2AuIEEgc2lnbmF0dXJlIHdpZGUgZW5vdWdoIHRvIGFic29yYlxuICogdGhvc2Ugc3RvcHMgYmVpbmcgYSBmaWxlIHNlcnZlciBhbmQgYmVjb21lcyBhIHJvdXRlci4gU28gdGhlIGNhbGxlciBkZWNpZGVzXG4gKiBXSElDSCBmaWxlIChgcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSlgKSwgYW5kIHRoaXMgbW9kdWxlXG4gKiBkZWNpZGVzIHdoZXRoZXIgdGhhdCBmaWxlIG1heSBiZSByZWFkIGFuZCB3aGF0IGl0IGlzIHNlcnZlZCBhcy5cbiAqXG4gKiDilIDilIAgQU5EIFwiV0hFVEhFUiBJVCBNQVkgQkUgUkVBRFwiIElTIE5PVyBBIFdISVRFTElTVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBFeHRyYWN0ZWQgd2l0aCB0aHJlZSBndWFyZHMgKGVtcHR5IC8gYC4uYCAvIG5lc3RlZCkgYW5kIGBleGlzdHNTeW5jYCBmb3IgdGhlXG4gKiByZXN0LCB3aGljaCB3YXMgdHJ1ZSBvZiBhIGBkaXN0L2AgdGhhdCBoZWxkIG9ubHkgYSBzdXJmYWNlLiBQaGFzZSAxYiBwdXQgZXZlcnlcbiAqIGRhZW1vbidzIEJVTkRMRSBpbiB0aGF0IHNhbWUgZGlyZWN0b3J5LCBhbmQgYWxsIGZpdmUgYWRvcHRlcnMgc2VydmVkIGl0OlxuICogYC9jbGkuanNgLCBgL3NlcnZlci5qc2AsIGAvam9pbi5qc2AgYXQgMjAwLCBieXRlLWlkZW50aWNhbCB0byB0aGUgY29tbWl0dGVkXG4gKiBhcnRpZmFjdHMsIGVtYmVkZGVkIHNvdXJjZW1hcHMgYW5kIGFsbC4gYHNlcnZlRnJvbURpc3RgIG5vdyBzZXJ2ZXMgb25seSB3aGF0IHRoZVxuICogYnVpbHQgYGluZGV4Lmh0bWxgIHRyYW5zaXRpdmVseSBsaW5rcyDigJQgc2VlIGBzdXJmYWNlV2hpdGVsaXN0YCBiZWxvdywgd2hpY2ggaXNcbiAqIHRoZSBzaGFwZSBkaWdlc3RpZnkgcHJvdmVkIGxvY2FsbHkgaW4gYGQ4Y2JhZmZgIGFuZCB0aGlzIGlzIGl0cyBvbmUgZWRpdCBmb3JcbiAqIGZpdmUgc3BlbGxzLlxuICovXG5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG4vKipcbiAqIFJlbGVhc2UgaWZmIGA8ZGlzdERpcj4vaW5kZXguaHRtbGAgZXhpc3RzOyBlbHNlIGRldi4gVGhlIGVudiBvdmVycmlkZVxuICogKGBTUEVMTEJPT0tfU1VSRkFDRV9NT0RFYCkgd2lucyBlaXRoZXIgd2F5IOKAlCBzZWFtcyBDb250cmFjdCAxLlxuICpcbiAqIOKblCAqKlRIRSBGSUxFLCBORVZFUiBUSEUgRElSRUNUT1JZLCBBTkQgVEhBVCBJUyBBIFNDQVIgTk9UIEEgU1RZTEUgQ0hPSUNFLioqXG4gKiBSZS1ob21lZCBmcm9tIGJvdW50eSBhbmQgbWFncGllLCB3aGljaCBlYXJuZWQgaXQgaW5kZXBlbmRlbnRseTpcbiAqXG4gKiAtIG1hZ3BpZSdzIGBkaXN0L2AgQUxSRUFEWSBFWElTVEVEIGhvbGRpbmcgYGNsaS5qc2AgYW5kIG5vIGBpbmRleC5odG1sYCxcbiAqICAgd2hpY2ggaXMgcHJlY2lzZWx5IHdoeSBpdHMgZGFlbW9uIHN0YXllZCBjb3JyZWN0bHkgaW4gREVWIG1vZGUgdGhyb3VnaCB0aGVcbiAqICAgd2hvbGUgb2YgU2xpY2UgMi4gYGRpc3QvYCBleGlzdGluZyBpcyBub3QgdGhlIGRpc2NyaW1pbmF0b3IuXG4gKiAtIGJvdW50eSBzYXlzIHRoZSBzYW1lIHRoaW5nIGZyb20gdGhlIG90aGVyIHNpZGU6IGEgYnVpbHQgQkFDS0VORCBwdXRzXG4gKiAgIGBjbGkuanNgIChhbmQgbm93IGBzZXJ2ZXIuanNgKSBpbiBgZGlzdC9gIHdpdGggbm8gc3VyZmFjZSBhbnl3aGVyZSBuZWFyIGl0LlxuICpcbiAqIOKaoCAqKkFORCBUSEUgUFJFRElDQVRFIElTIEFOIFVOSEFTSEVEIEZJTEVOQU1FLCBXSElDSCBJUyBBIFNUQU5ESU5HXG4gKiBBU1NVTVBUSU9OIEFCT1VUIFRIRSBTVVJGQUNFIEJVSUxELioqIFJlbGVhc2UgbW9kZSBpcyBjaG9zZW4gYnkgT05FIGxpdGVyYWxcbiAqIG5hbWUuIEEgc3VyZmFjZSBidWlsZCB0aGF0IGV2ZXIgZW1pdHRlZCBhIGNvbnRlbnQtaGFzaGVkIGVudHJ5IGRvY3VtZW50IHdvdWxkXG4gKiBsZWF2ZSBubyBgaW5kZXguaHRtbGAgaGVyZSwgZXZlcnkgZGFlbW9uIHdvdWxkIHNpbGVudGx5IHJlc29sdmUgREVWLCBhbmQgdGhlXG4gKiBvbmx5IHN5bXB0b20gYW55b25lIGNhbiBzZWUgaXMgdGhlIGBtb2RlYCBmaWVsZCBvbiBhIGhhbmRzaGFrZSBub2JvZHkgcmVhZHMgaW5cbiAqIGFuZ2VyLiBgc3JjL2J1aWxkLnRzYCBlbWl0cyB0aGUgZW50cnkgdW5oYXNoZWQgdG9kYXkgKG9ubHkgdGhlIEpTIGFuZCBDU1NcbiAqIGNodW5rcyBjYXJyeSBoYXNoZXMpIGFuZCBDb250cmFjdCAyIHBpbnMgdGhhdCBmbGF0IGxheW91dDsgdGhpcyBjb21tZW50IGlzXG4gKiB0aGUgbm90ZSB0aGF0IHNheXMgd2hhdCB0aGUgcGluIGlzIGxvYWQtYmVhcmluZyBGT1IuXG4gKlxuICog4pqgIE5vdGhpbmcgYW5ub3VuY2VzIHRoZSBmbGlwIGZyb20gZGV2IHRvIHJlbGVhc2UgZWl0aGVyOiB0aGUgZmlyc3Qgc3VyZmFjZVxuICogYnVpbGQgdG8gbGFuZCBhbiBgaW5kZXguaHRtbGAgYmVzaWRlIGEgZGFlbW9uIGZsaXBzIGl0LCBzaWxlbnRseSwgb24gdGhlIG5leHRcbiAqIGJvb3QuIFRoYXQgaXMgd2h5IGBtb2RlYCByaWRlcyB0aGUgcmVhZHkgZnJhbWUg4oCUIHdpdGggcm9vdCBkZXBzIHByZXNlbnQgYSBkZXZcbiAqIGRhZW1vbiByZW5kZXJzIGFuIGlkZW50aWNhbC1sb29raW5nIHN1cmZhY2UsIHNvIFwiaXQgbG9va3MgcmlnaHRcIiBjYW5ub3RcbiAqIHZlcmlmeSBDb250cmFjdCAxLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZU1vZGUoZGlzdERpcjogc3RyaW5nKTogXCJkZXZcIiB8IFwicmVsZWFzZVwiIHtcbiAgY29uc3Qgb3ZlcnJpZGUgPSBwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFO1xuICBpZiAob3ZlcnJpZGUgPT09IFwiZGV2XCIgfHwgb3ZlcnJpZGUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gb3ZlcnJpZGU7XG4gIHJldHVybiBleGlzdHNTeW5jKGpvaW4oZGlzdERpciwgXCJpbmRleC5odG1sXCIpKSA/IFwicmVsZWFzZVwiIDogXCJkZXZcIjtcbn1cblxuLyoqXG4gKiBUaGUgY29udGVudCB0eXBlcyBhIGJ1aWx0IHN1cmZhY2UgYWN0dWFsbHkgc2hpcHMuIEV4dGVuc2lvbnMgb3V0c2lkZSB0aGVcbiAqIG1hcCBnZXQgYGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbWAg4oCUIGEgZGVsaWJlcmF0ZSByZWZ1c2FsIHRvIGd1ZXNzLCBzaW5jZVxuICogYW55dGhpbmcgbm90IGluIHRoaXMgbGlzdCBpcyBub3Qgc29tZXRoaW5nIENvbnRyYWN0IDIncyBidWlsZCBlbWl0cy5cbiAqXG4gKiDimqAgKipgY2hhcnNldD11dGYtOGAgT04gSFRNTCBJUyBUSEUgQ0VOU1VTJ1MgT05FIERJVkVSR0VOQ0UsIFJFU09MVkVEIFRPV0FSRFxuICogVEhFIENPUlJFQ1QgQ09QWS4qKiBUaHJlZSBvZiB0aGUgZWlnaHQgZGFlbW9ucyBjYXJyaWVkIGl0IGFuZCBmaXZlIGRpZCBub3Q7XG4gKiB0aGUgY2Vuc3VzIGdyYWRlZCB0aGF0IGBzdGFsZWAgd2l0aCB6ZXJvIGRlc2lnbiBjb250ZW50LiBJdCBpcyBrZXB0IGJlY2F1c2VcbiAqIGl0IGlzIHRoZSByaWdodCBhbnN3ZXIg4oCUIGFuIEhUTUwgZG9jdW1lbnQgc2VydmVkIHdpdGggbm8gY2hhcnNldCBpcyBkZWNvZGVkXG4gKiBieSB0aGUgYnJvd3NlcidzIGd1ZXNzIOKAlCBhbmQgaXQgaXMgdGhlIG9uZSB3aXJlLW9ic2VydmFibGUgY2hhbmdlIHRoaXNcbiAqIGNvbnZlcmdlbmNlIG1ha2VzIHRvIGEgcmVzcG9uc2UgaGVhZGVyLiBSZWNvcmRlZCBhcyBELW5vdGUgaW4gdGhlIHBoYXNlIGxvZ1xuICogcmF0aGVyIHRoYW4gc211Z2dsZWQuXG4gKi9cbmNvbnN0IFNUQVRJQ19DT05URU5UX1RZUEVTOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcIi5odG1sXCI6IFwidGV4dC9odG1sOyBjaGFyc2V0PXV0Zi04XCIsXG4gIFwiLmpzXCI6IFwidGV4dC9qYXZhc2NyaXB0XCIsXG4gIFwiLmNzc1wiOiBcInRleHQvY3NzXCIsXG4gIFwiLmpzb25cIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gIFwiLnN2Z1wiOiBcImltYWdlL3N2Zyt4bWxcIixcbiAgXCIucG5nXCI6IFwiaW1hZ2UvcG5nXCIsXG59O1xuXG4vKiogVGhlIGNvbnRlbnQgdHlwZSBmb3IgYSBmaWxlbmFtZSBvciBhbiBleHRlbnNpb24uIFVua25vd24gZXh0ZW5zaW9ucywgYW5kXG4gKiAgbmFtZXMgd2l0aCBubyBleHRlbnNpb24gYXQgYWxsLCBnZXQgYGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbWAuICovXG5leHBvcnQgZnVuY3Rpb24gY29udGVudFR5cGVGb3IobmFtZU9yRXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBkb3QgPSBuYW1lT3JFeHQubGFzdEluZGV4T2YoXCIuXCIpO1xuICBjb25zdCBleHQgPSBkb3QgPT09IC0xID8gXCJcIiA6IG5hbWVPckV4dC5zbGljZShkb3QpO1xuICByZXR1cm4gU1RBVElDX0NPTlRFTlRfVFlQRVNbZXh0XSA/PyBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiO1xufVxuXG4vKipcbiAqIEFuc3dlciBPTkUgZmlsZSBmcm9tIGBkaXN0RGlyYCwgb3IgYG51bGxgIGlmIHRoZSBjYWxsZXIgc2hvdWxkIGtlZXAgcm91dGluZy5cbiAqXG4gKiBgcmVsYCBpcyBhIGJhcmUgZmlsZW5hbWUg4oCUIHRoZSBlbnRyeSBkb2N1bWVudCBvciBvbmUgaGFzaGVkIGNodW5rLiBDb250cmFjdFxuICogMidzIGJ1aWx0IHN1cmZhY2UgaXMgRkxBVCBhbmQgbGlua3MgaXRzIGNodW5rcyByZWxhdGl2ZWx5LCBzbyBhIGxlZ2l0aW1hdGVcbiAqIGFzc2V0IHJlcXVlc3QgaXMgbmV2ZXIgbmVzdGVkIGFuZCBuZXZlciBjb250YWlucyBgLi5gOyBib3RoIGFyZSByZWZ1c2VkXG4gKiBoZXJlIHJhdGhlciB0aGFuIGluIHRoZSByb3V0ZXIsIGJlY2F1c2UgdGhlIGd1YXJkIHByb3RlY3RzIHRoZSByZWFkIGFuZCB0aGVcbiAqIHJlYWQgaXMgd2hhdCBsaXZlcyBpbiB0aGlzIGZpbGUuXG4gKlxuICog4puUIEFORCBgZXhpc3RzU3luY2AgSVMgTk8gTE9OR0VSIFRIRSBQRVJNSVNTSU9OLiBBIGZpbGUgdW5kZXIgYGRpc3REaXJgIGlzXG4gKiBzZXJ2ZWQgb25seSBpZiBpdCBpcyBpbiBgc3VyZmFjZVdoaXRlbGlzdChkaXN0RGlyKWAg4oCUIHdoYXQgdGhlIGJ1aWx0XG4gKiBgaW5kZXguaHRtbGAgdHJhbnNpdGl2ZWx5IExJTktTLiBgZGlzdC9gIHN0b3BwZWQgYmVpbmcgYSBzdXJmYWNlIGRpcmVjdG9yeVxuICogd2hlbiB0aGUgYmFja2VuZCBjb252ZXJnZW5jZSBidWlsdCB0aGUgZGFlbW9ucyBpbnRvIGl0LCBhbmQgdGhlIGd1YXJkcyBhYm92ZVxuICogZG8gbm90IGRpc3Rpbmd1aXNoIGBpbmRleC08aGFzaD4uanNgIGZyb20gYHNlcnZlci5qc2AuIFJlYWQgdGhhdCBmdW5jdGlvbidzXG4gKiBoZWFkZXIgYmVmb3JlIHRvdWNoaW5nIHRoaXMgbGluZTsgdGhlIHdoaXRlbGlzdCBpcyB0aGUgZGVmZW5jZS5cbiAqXG4gKiDimqAgVGhlIG5lc3RpbmcgcmVmdXNhbCBpcyBhbHNvIHdoYXQga2VlcHMgYW4gYXNzZXQgc2VydmUgY2xlYXIgb2YgYSBzcGVsbCdzXG4gKiBvd24gcm91dGVzOiBtYWdwaWUsIGJvdW50eSwgZ2xhbW91ciBhbmQgaW1hZ28gZWFjaCBoYXZlIGFuIGAvYXNzZXRzLzxuYW1lPmBcbiAqIHJvdXRlIG9uZSBsZXZlbCBkZWVwLCBhbmQgdGhpcyByZXR1cm5pbmcgYG51bGxgIG9uIGFueXRoaW5nIHdpdGggYSBzbGFzaCBpblxuICogaXQgaXMgd2hhdCBzdG9wcyB0aGUgdHdvIGZpZ2h0aW5nLiBUaGUgd2hpdGVsaXN0IGdvdmVybnMgYGRpc3QvYCByZWFkcyBPTkxZXG4gKiDigJQgaXQgbmV2ZXIgc2VlcyB0aG9zZSByb3V0ZXMgYW5kIG11c3QgbmV2ZXIgYmUgd2lkZW5lZCBpbnRvIHRoZW0uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXJ2ZUZyb21EaXN0KGRpc3REaXI6IHN0cmluZywgcmVsOiBzdHJpbmcpOiBSZXNwb25zZSB8IG51bGwge1xuICBpZiAoIXJlbCB8fCByZWwuaW5jbHVkZXMoXCIuLlwiKSB8fCByZWwuaW5jbHVkZXMoXCIvXCIpKSByZXR1cm4gbnVsbDtcbiAgaWYgKCFzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXIpLmhhcyhyZWwpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZmlsZSA9IGpvaW4oZGlzdERpciwgcmVsKTtcbiAgaWYgKCFleGlzdHNTeW5jKGZpbGUpKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIG5ldyBSZXNwb25zZShCdW4uZmlsZShmaWxlKSwgeyBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IGNvbnRlbnRUeXBlRm9yKHJlbCkgfSB9KTtcbn1cblxuLyoqIGBzcmNgL2BocmVmYCB2YWx1ZXMgaW4gYSBidWlsdCBlbnRyeSBkb2N1bWVudCwgYC4vYC1wcmVmaXhlZCBvciBiYXJlLiAqL1xuY29uc3QgRU5UUllfUkVGX1JFID0gLyg/OnNyY3xocmVmKVxccyo9XFxzKlwiKD86XFwuXFwvKT8oW15cIl0rKVwiL2c7XG5cbi8qKiBBIGAuL2AtUFJFRklYRUQgc2libGluZyBzcGVjaWZpZXIg4oCUIGBcIi4vbmFtZVwiYCwgYCcuL25hbWUnYCwgYCguL25hbWUpYCDigJQgd2hpY2hcbiAqICBpcyB0aGUgb25seSBzaGFwZSBhIGJ1bmRsZXIgZW1pdHMgZm9yIGEgc2libGluZyBjaHVuay4gUmVxdWlyaW5nIHRoZSBgLi9gIGlzXG4gKiAgd2hhdCBrZWVwcyBhIHN0cmluZyBsaXRlcmFsIHRoYXQgbWVyZWx5IFNBWVMgYGNsaS5qc2Agb3V0IG9mIHRoZSBzZXQuICovXG5jb25zdCBSRUxBVElWRV9SRUZfUkUgPSAvW1wiJyhdXFwuXFwvKFteXCInKClcXHNdKylbXCInKV0vZztcblxuLyoqIE9ubHkgdGV4dCB0aGUgYnVpbGQgZW1pdHMgYXMgc3VyZmFjZSBjb2RlIGlzIHNjYW5uZWQgZm9yIG9ud2FyZCByZWZlcmVuY2VzLlxuICogIEEgYC5wbmdgIGlzIGEgbGVhZjsgb3BlbmluZyBpdCB3b3VsZCBiZSByZWFkaW5nIGEgYmluYXJ5IGZvciBmaWxlbmFtZXMuICovXG5jb25zdCBUUkFOU0lUSVZFX0VYVFMgPSBbXCIuanNcIiwgXCIuY3NzXCJdO1xuXG4vKiogT25lIGRlcml2YXRpb24gcGVyIGBkaXN0L2AsIGZvciB0aGUgbGlmZSBvZiB0aGUgcHJvY2VzcyDigJQgYGRpc3QvYCBpcyBhIGJ1aWxkXG4gKiAgYXJ0aWZhY3QgYW5kIGRvZXMgbm90IGNoYW5nZSB1bmRlciBhIHJ1bm5pbmcgZGFlbW9uLiBLZXllZCBieSBkaXJlY3Rvcnkgc29cbiAqICB0d28gZGFlbW9ucyBpbiBvbmUgcHJvY2VzcyAoYW5kIGV2ZXJ5IHRlc3Qgd2l0aCBpdHMgb3duIHRlbXAgdHJlZSkgc3RheVxuICogIGluZGVwZW5kZW50LiAqL1xuY29uc3Qgd2hpdGVsaXN0Q2FjaGUgPSBuZXcgTWFwPHN0cmluZywgUmVhZG9ubHlTZXQ8c3RyaW5nPj4oKTtcblxuZnVuY3Rpb24gcmVmc0luKHRleHQ6IHN0cmluZywgcmU6IFJlZ0V4cCk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIChcbiAgICBbLi4udGV4dC5tYXRjaEFsbChyZSldXG4gICAgICAubWFwKChbLCByZWZdKSA9PiByZWYpXG4gICAgICAvLyBBIFRZUEUgUFJFRElDQVRFLCBhbmQgaG9uZXN0IG9ubHkgYmVjYXVzZSBpdHMgZmlyc3QgY2xhdXNlIHdhcyBhbHJlYWR5XG4gICAgICAvLyBoZXJlOiBgISFyZWZgIGlzIHRoZSBydW50aW1lIGNoZWNrIHRoYXQgbWFrZXMgYHJlZiBpcyBzdHJpbmdgIHRydWUgKHRoZVxuICAgICAgLy8gRkVMTCBzZW50ZW5jZSdzIHByZWRpY2F0ZSByb3V0ZSwgdGFrZW4gd2l0aCBpdHMgY2xhdXNlIOKAlCB0eXBlLWRlYnQgVDM2KS5cbiAgICAgIC5maWx0ZXIoXG4gICAgICAgIChyZWYpOiByZWYgaXMgc3RyaW5nID0+XG4gICAgICAgICAgISFyZWYgJiZcbiAgICAgICAgICAhcmVmLmluY2x1ZGVzKFwiL1wiKSAmJlxuICAgICAgICAgICFyZWYuaW5jbHVkZXMoXCIuLlwiKSAmJlxuICAgICAgICAgICFyZWYuaW5jbHVkZXMoXCI6XCIpICYmXG4gICAgICAgICAgIXJlZi5zdGFydHNXaXRoKFwiI1wiKSAmJlxuICAgICAgICAgICFyZWYuc3RhcnRzV2l0aChcIj9cIiksXG4gICAgICApXG4gICk7XG59XG5cbi8qKlxuICogVGhlIG5hbWVzIHVuZGVyIGBkaXN0RGlyYCBhIGJyb3dzZXIgbWF5IGZldGNoOiB0aGUgZW50cnkgZG9jdW1lbnQsIHBsdXMgdGhlXG4gKiBUUkFOU0lUSVZFIGNsb3N1cmUgb2Ygd2hhdCBpdCBsaW5rcy5cbiAqXG4gKiDim5QgKipBIFdISVRFTElTVCwgQU5EIFRIRSBMRUFLIElUIFJFUExBQ0VEIElTIFdIWS4qKiBVbnRpbCB0aGlzIGZpeCB0aGUgZmlsZVxuICogaGFsZiBvZiB0aGlzIG1vZHVsZSBoYWQgZXhhY3RseSB0aHJlZSBndWFyZHMg4oCUIGVtcHR5LCBgLi5gLCBuZXN0ZWQg4oCUIGFuZFxuICogYGV4aXN0c1N5bmNgIGRlY2lkZWQgdGhlIHJlc3QuIFRoYXQgd2FzIGNvcnJlY3QgZm9yIGFzIGxvbmcgYXMgYGRpc3QvYCBoZWxkXG4gKiBvbmx5IGEgc3VyZmFjZS4gVGhlIGJhY2tlbmQgY29udmVyZ2VuY2UgbW92ZWQgZXZlcnkgc3BlbGwncyBJTVBMRU1FTlRBVElPTlxuICogaW50byB0aGUgc2FtZSBkaXJlY3RvcnksIGFuZCB0aGUgc2VydmUgZGlkIHdoYXQgaXQgd2FzIHdyaXR0ZW4gdG8gZG86XG4gKlxuICogICBHRVQgL2NsaS5qcyAgICAgMjAwICAyNDIsNDMxIEIgIHRleHQvamF2YXNjcmlwdCAgIOKGkCBib3VudHksIGJ5dGUtaWRlbnRpY2FsXG4gKiAgIEdFVCAvc2VydmVyLmpzICAyMDAgIDI3Niw0MTUgQiAgdGV4dC9qYXZhc2NyaXB0ICAgICAgdG8gdGhlIGNvbW1pdHRlZFxuICogICBHRVQgL2pvaW4uanMgICAgMjAwICAgNDcsMzQ4IEIgIHRleHQvamF2YXNjcmlwdCAgICAgIGFydGlmYWN0c1xuICpcbiAqIGFuZCB0aG9zZSBidW5kbGVzIGFyZSBidWlsdCB3aXRoIHRoZSBzb3VyY2VtYXAgRU1CRURERUQsIHNvIGVhY2ggb25lIGNhcnJpZXNcbiAqIHRoZSBjb21wbGV0ZSBvcmlnaW5hbCBUeXBlU2NyaXB0LiBGaXZlIHNwZWxscyDigJQgYXN0cm9sYWJlLCBib3VudHksIGdsYW1vdXIsIGltYWdvLCBtYWdwaWVcbiAqIOKAlCBlbGV2ZW4gYXJ0aWZhY3RzLCBhbGwgcmVhY2hhYmxlIGJ5IGFueSBicm93c2VyIHRoYXQgY2FuIHJlYWNoIHRoZSBkYWVtb24uXG4gKiBEaWdlc3RpZnkgaGl0IHRoZSBpZGVudGljYWwgZGVmZWN0IG9uZSBicmFuY2ggZWFybGllciBhbmQgYW5zd2VyZWQgaXQgbG9jYWxseTtcbiAqIHRoaXMgaXMgdGhhdCBhbnN3ZXIgcmUtaG9tZWQgdG8gdGhlIG9uZSBwbGFjZSBhbGwgZml2ZSBjYWxsZXJzIGFscmVhZHkgc2hhcmUuXG4gKlxuICog4puUICoqREVSSVZFRCwgTk9UIEVOVU1FUkFURUQsIEFORCBOT1QgTUFUQ0hFRCBCWSBTSEFQRS4qKiBBIGxpdGVyYWwgbmFtZSBsaXN0XG4gKiBpcyB3cm9uZyBhdCB0aGUgbmV4dCBidWlsZCAodGhlIGNodW5rcyBjYXJyeSBjb250ZW50IGhhc2hlcykuIEEgc2hhcGUgbWF0Y2hcbiAqIChgaW5kZXgtPGhhc2g+LmpzYCkgaXMgd3JvbmcgdGhlIGZpcnN0IHRpbWUgdGhlIGJ1bmRsZXIgc3BsaXRzIGEgY2h1bmsuIEFza2luZ1xuICogdGhlIGVudHJ5IGRvY3VtZW50IHdoYXQgaXQgbG9hZHMgaXMgdGhlIG9ubHkgZm9ybXVsYXRpb24gdGhhdCBpcyB0cnVlIG9mXG4gKiB3aGF0ZXZlciBgYnVuIHJ1biBidWlsZGAgYWN0dWFsbHkgZW1pdHRlZC5cbiAqXG4gKiDim5QgKipBTkQgVEhFIENMT1NVUkUgSVMgVFJBTlNJVElWRSBGT1IgVEhFIFNBTUUgUkVBU09OLioqIGBpbmRleC5odG1sYCBsaW5rc1xuICogb25lIGNodW5rIHRvZGF5OyBhIHNwbGl0IGJ1aWxkIGhhcyB0aGF0IGNodW5rIGBpbXBvcnQgXCIuL2NodW5rLTxoYXNoPi5qc1wiYCxcbiAqIHdoaWNoIHRoZSBlbnRyeSBkb2N1bWVudCBuZXZlciBuYW1lcy4gU28gZXZlcnkgYWRtaXR0ZWQgYC5qc2AvYC5jc3NgIGlzIGl0c2VsZlxuICogc2Nhbm5lZCBmb3IgYC4vYC1wcmVmaXhlZCBzaWJsaW5ncywgdW50aWwgdGhlIHNldCBzdG9wcyBncm93aW5nIOKAlCBhIHdoaXRlbGlzdFxuICogdGhhdCByZWFkIG9ubHkgdGhlIGVudHJ5IHdvdWxkIDQwNCBhIGxlZ2l0aW1hdGUgY2h1bmsgaW4gcmVsZWFzZSwgYW5kIG9ubHkgaW5cbiAqIHJlbGVhc2UuXG4gKlxuICog4puUICoqTUVNQkVSU0hJUCBJUyBBTiBFWEFDVCBNQVRDSCwgV0hJQ0ggTUFLRVMgVEhFIFJFRlVTQUwgQ0FTRS1JTlNFTlNJVElWRSBCWVxuICogQ09OU1RSVUNUSU9OLioqIEFQRlMgaXMgY2FzZS1pbnNlbnNpdGl2ZSwgc28gYC9JTkRFWC5IVE1MYCBhbmQgYC9pTmRFeC5IdE1sYFxuICogcmVzb2x2ZSB0byB0aGUgc2FtZSBpbm9kZSBhIGNhc2Utc2Vuc2l0aXZlIGJsYWNrbGlzdCB3b3VsZCBtaXNzIChtZWFzdXJlZCBvblxuICogYWxsIGZpdmUgc3BlbGxzIGJlZm9yZSB0aGlzIGZpeDogZm91ciB2YXJpYW50cywgZm91ciAyMDBzLCB0aHJlZSBvZiB0aGVtIGFzXG4gKiBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYCBiZWNhdXNlIHRoZSBjb250ZW50LXR5cGUgbG9va3VwIGlzIGNhc2Utc2Vuc2l0aXZlXG4gKiB0b28pLiBBIHNldCBvZiBleGFjdGx5IHRoZSBlbWl0dGVkIG5hbWVzIHJlZnVzZXMgZXZlcnkgdmFyaWFudCBvZiBldmVyeSBuYW1lXG4gKiDigJQgc2VydmFibGUgb3Igbm90IOKAlCB3aXRoIG5vIGxvd2VyLWNhc2UgcGFzcyBhbnl3aGVyZS5cbiAqXG4gKiDimqAgKipUSEUgVFJBREU6KiogYSBmaWxlIHRoZSBlbnRyeSBncmFwaCBkb2VzIG5vdCByZWZlcmVuY2Ug4oCUIGEgbGF6aWx5IGZldGNoZWRcbiAqIGNodW5rLCBhIGZvbnQgcHVsbGVkIGJ5IGEgQ1NTIGB1cmwoKWAgdGhpcyBzY2FuIGRvZXMgbm90IG1vZGVsLCBhbiBhc3NldCB0aGVcbiAqIGJ1aWxkIGVtaXRzIGJ1dCBub3RoaW5nIGxpbmtzIOKAlCA0MDRzIGluIHJlbGVhc2Ugd2l0aCBub3RoaW5nIHJlZC4gRWFjaFxuICogYWRvcHRlcidzIGByZWxlYXNlLXNlcnZlLnRlc3QudHNgIGhvbGRzIHRoZSBpbnN0cnVtZW50OiBhbiBJTlZFTlRPUlkgY2VsbCB0aGF0XG4gKiBhY2NvdW50cyBmb3IgZXZlcnkgZmlsZSBpbiBgZGlzdC9gIGFzIHNlcnZlZCBvciBkZWxpYmVyYXRlbHkgcmVmdXNlZCwgc28gYW5cbiAqIHVubGlua2VkIGVtaXNzaW9uIGdvZXMgcmVkIGF0IGJ1aWxkIHRpbWUgcmF0aGVyIHRoYW4gc2lsZW50IGF0IHJ1bnRpbWUuXG4gKlxuICog4pqgIFRoZSBlbnRyeSBkb2N1bWVudCBpcyBJTiB0aGUgc2V0LCBiZWNhdXNlIHRoZSBob3VzZSBjYWxsZXIgbWFwcyBgL2AgdG9cbiAqIGBpbmRleC5odG1sYCBhbmQgdGhhdCBpcyB0aGUgc3VyZmFjZS4gQSBzcGVsbCB0aGF0IG11c3QgbmV2ZXIgaGFuZCBvdmVyIGl0c1xuICogb24tZGlzayBlbnRyeSDigJQgZGlnZXN0aWZ5IHN1YnN0aXR1dGVzIGEgcGF5bG9hZCBpbnRvIGl0IGluIG1lbW9yeSDigJQgcmVmdXNlc1xuICogdGhhdCBPTkUgbmFtZSBpbiBpdHMgb3duIHJvdXRlciwgYWJvdmUgdGhpcyBjYWxsLiBUaGF0IHJlZnVzYWwgaXMgdGhlIHNwZWxsJ3M7XG4gKiBldmVyeXRoaW5nIGVsc2UgaGVyZSBpcyB0aGUga2l0J3MuXG4gKi9cbmZ1bmN0aW9uIHN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcjogc3RyaW5nKTogUmVhZG9ubHlTZXQ8c3RyaW5nPiB7XG4gIGNvbnN0IGNhY2hlZCA9IHdoaXRlbGlzdENhY2hlLmdldChkaXN0RGlyKTtcbiAgaWYgKGNhY2hlZCkgcmV0dXJuIGNhY2hlZDtcblxuICBjb25zdCBuYW1lcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBlbnRyeSA9IGpvaW4oZGlzdERpciwgXCJpbmRleC5odG1sXCIpO1xuICBpZiAoZXhpc3RzU3luYyhlbnRyeSkpIHtcbiAgICBuYW1lcy5hZGQoXCJpbmRleC5odG1sXCIpO1xuICAgIGNvbnN0IGh0bWwgPSByZWFkRmlsZVN5bmMoZW50cnksIFwidXRmOFwiKTtcbiAgICBjb25zdCBwZW5kaW5nID0gWy4uLnJlZnNJbihodG1sLCBFTlRSWV9SRUZfUkUpLCAuLi5yZWZzSW4oaHRtbCwgUkVMQVRJVkVfUkVGX1JFKV07XG4gICAgLy8gVW50aWwgdGhlIHNldCBzdG9wcyBncm93aW5nOiBlYWNoIGFkbWl0dGVkIGNodW5rIG1heSBuYW1lIHRoZSBuZXh0IG9uZS5cbiAgICB3aGlsZSAocGVuZGluZy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBuYW1lID0gcGVuZGluZy5wb3AoKSBhcyBzdHJpbmc7XG4gICAgICBpZiAobmFtZXMuaGFzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgIC8vIOKaoCBSRUZFUkVOQ0VEICoqQU5EKiogUFJFU0VOVC4gQSBtaW5pZmllZCBidW5kbGUgY2FuIGNvbnRhaW4gYSBzdHJpbmdcbiAgICAgIC8vIHRoYXQgbWVyZWx5IExPT0tTIGxpa2Ugb25lOyBhZG1pdHRpbmcgb25seSBuYW1lcyB0aGF0XG4gICAgICAvLyBhcmUgYWN0dWFsbHkgb24gZGlzayBrZWVwcyB0aGUgc2NhbiBmcm9tIHdpZGVuaW5nIHRoZSBzZXQgb24gYVxuICAgICAgLy8gY29pbmNpZGVuY2UsIGFuZCBhIG5hbWUgdGhhdCBpcyBhYnNlbnQgNDA0cyBpZGVudGljYWxseSBlaXRoZXIgd2F5LlxuICAgICAgY29uc3QgZmlsZSA9IGpvaW4oZGlzdERpciwgbmFtZSk7XG4gICAgICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIGNvbnRpbnVlO1xuICAgICAgbmFtZXMuYWRkKG5hbWUpO1xuICAgICAgaWYgKCFUUkFOU0lUSVZFX0VYVFMuc29tZSgoZXh0KSA9PiBuYW1lLmVuZHNXaXRoKGV4dCkpKSBjb250aW51ZTtcbiAgICAgIHBlbmRpbmcucHVzaCguLi5yZWZzSW4ocmVhZEZpbGVTeW5jKGZpbGUsIFwidXRmOFwiKSwgUkVMQVRJVkVfUkVGX1JFKSk7XG4gICAgfVxuICB9XG5cbiAgd2hpdGVsaXN0Q2FjaGUuc2V0KGRpc3REaXIsIG5hbWVzKTtcbiAgcmV0dXJuIG5hbWVzO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBzZXJ2ZXIgc2lkZSBvZiB0aGUgU1NFIHRhaWwg4oCUIHRoZSBkYWVtb24tc2lkZSB0d2luIG9mXG4gKiBgdGFpbEV2ZW50cy50c2AuIFRoYXQgbW9kdWxlIGRlY2lkZXMgd2hhdCBhIGNhbGxlciBvYnNlcnZlczsgdGhpcyBvbmUgZGVjaWRlc1xuICogd2hhdCBhIGNhbGxlciBpcyBzZW50LlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIGV4Y2VwdCBpdHNcbiAqIG93biBzaWJsaW5nIHR5cGVzLCB3aGljaCBpcyBzdGlsbCBpbnNpZGUgdGhlIGxlYWYuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIG1pbmQtbWFwcGVyJ3MgYHNzZVJlc3BvbnNlYCxcbiAqIHRoZSBjZW5zdXMncyBjb252ZXJnZW5jZSB0YXJnZXQgIzE6IHRoZSBvbmx5IG9uZSBvZiB0aGUgc2V2ZW4gd2l0aCBhXG4gKiBvbmNlLW9ubHkgdGVhcmRvd24gZnVubmVsLCB0aGUgb25seSBvbmUgd2lyZWQgdG8gYHJlcS5zaWduYWxgLCBhbmQgdGhlIG9ubHlcbiAqIG9uZSB3aG9zZSBjb21tZW50IHJlY29yZHMgYSBNRUFTVVJFRCByZXN1bHQgcmF0aGVyIHRoYW4gYSBiZWxpZWYuXG4gKlxuICog4pSA4pSAIOKblCBBTkQgV0hBVCBUSEUgQ09QWSBMRUZUIEJFSElORCwgU0FJRCBIRVJFIEJFQ0FVU0UgQSBMT1NTIFJFQ09SREVEIE9OTFkgSU5cbiAqICAgIEEgUE9SVCdTIEpPVVJOQUwgR0VUUyBSRS1MSVRJR0FURUQgQlkgRVZFUlkgU1BFTEwgQUZURVIgSVQgKEQ3OS9EODUpIOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSBzZW50ZW5jZSBhYm92ZSBuYW1lcyBhIFNPVVJDRSB0aGlzIG1vZHVsZSBoYWQgbmV2ZXIgYmVlbiBjaGVja2VkIGFnYWluc3Q6XG4gKiBEMSBydWxlZCB0aGUgc3BpbmUgYmUgcHJvdmVuIG9uIHRoZSB0d28gc3BlbGxzIHRoYXQgYWxyZWFkeSBidWlsdCwgYW5kIGJvdGggb2ZcbiAqIHRob3NlIGFyZSBkb3duc3RyZWFtIEZPUktTIG9mIHRoZSBtaW5kLW1hcHBlciBsaW5lLCBzbyB0aGUgYm91bmRhcmllcyB3ZXJlXG4gKiBzZXR0bGVkIGFnYWluc3QgdHdvIGNvcGllcyB3aGlsZSB0aGUgb3JpZ2luYWwgd2FzIG5vdCBpbiB0aGUgcm9vbS4gKipBXG4gKiBjb252ZXJnZW5jZSBjYW4gbmFtZSBpdHMgc291cmNlIGFuZCBzdGlsbCBuZXZlciBjb25zdWx0IGl0LioqXG4gKlxuICogV2hlbiBpdCB3YXMgZmluYWxseSBjb25zdWx0ZWQgKFBoYXNlIDcsIHRoZSBsYXN0IHBvcnQpLCBleGFjdGx5IE9ORSBwcm9wZXJ0eVxuICogb2YgdGhlIHNvdXJjZSB3YXMgbWlzc2luZyBoZXJlLCBhbmQgaXQgb2NjdXBpZWQgbm8gdHlwZTogKiptaW5kLW1hcHBlciB3cm90ZVxuICogaXRzIGB0YWlsIC0taW5ib3VuZGAgZ3JvdW5kaW5nIGZyYW1lIEJFRk9SRSB0aGUgcmVwbGF5Kiog4oCUIG9uZSBsaW5lIGFib3ZlXG4gKiBgYnVzLnN1YnNjcmliZWAg4oCUIHNvIGl0IHdhcyB0aGUgc3RyZWFtJ3MgZmlyc3QgZGF0YSBsaW5lLiBgb25PcGVuYCBmaXJlcyBhdFxuICogdGhlIEVORCBvZiBgc3RhcnRgLCBhZnRlciB0aGUgcHJlYW1ibGUsIGFmdGVyIGBsb2cuc3Vic2NyaWJlYCwgYWZ0ZXJcbiAqIGBjbGllbnRzLmFkZGAsIHNvIGEgY2FsbGVyIHRoYXQgc3VwcGxpZWQgaXRzIG93biBgY2xpZW50c2Agc2V0IGFuZCBzZW50IGZyb21cbiAqIHRoZXJlIHdvdWxkIGxhbmQgdGhlIGZyYW1lIEFGVEVSIHRoZSByZXBsYXllZCBiYWNrbG9nLiBUaGF0IGlzIEVYUFJFU1NJQkxFLFxuICogd2hpY2ggaXMgd2hhdCBtYWtlcyB0aGlzIGEgbWVhc3VyZW1lbnQgcmF0aGVyIHRoYW4gYW4gYXNzZXJ0aW9uOiB0aGVcbiAqIHBsYXlib29rJ3MgdHlwZS10by10eXBlIGNvbXBhdGliaWxpdHkgcHJvY2VkdXJlIGFuc3dlcnMgXCJyZXByZXNlbnRhYmxlXCIgaGVyZVxuICogKHRoZSBzdWJqZWN0IHR5cGUgaXMgYFNldDxTc2VDbGllbnQ+YCwgdGhlIHNwZWxsIGtlZXBzIG5vIHJlZ2lzdHJ5LCBzbyB5b3VcbiAqIHBhc3MgYW4gZW1wdHkgc2V0KSBhbmQgYSB0eXBlIGNoZWNrIGNhbm5vdCBzZWUgYSBQT1NJVElPTi5cbiAqXG4gKiAqKlRoZSBkaXNwb3NpdGlvbiB3YXMgUkVTVE9SRSwgbm90IEtFRVAtTE9DQUwgYW5kIG5vdCBGSUxFKiog4oCUIHNlZVxuICogYG9wZW5GcmFtZXNgIGJlbG93LCB3aGVyZSB0aGUgdHdvIG51bWJlcnMgdGhhdCBwZXJtaXQgaXQgYXJlIHJlY29yZGVkIGFuZFxuICogZHJpdmVuLiBUaGUgZ2VuZXJhbGlzYXRpb24sIHdoaWNoIGlzIHRoZSBwYXJ0IHdvcnRoIGNhcnJ5aW5nOiB3aGVyZSBhXG4gKiBtb2R1bGUncyBzdWJqZWN0IGlzIGEgU0VRVUVOQ0UgT0YgV1JJVEVTLCBjb21wYXJlIHRoZSBPUkRFUiBvZiBpdHMgaG9va3NcbiAqIGFnYWluc3QgdGhlIG9yZGVyIHRoZSBhZG9wdGluZyBzcGVsbCB3cml0ZXMgaW4uIFR3byBob29rcyB3aXRoIHRoZSByaWdodFxuICogc2lnbmF0dXJlcyBpbiB0aGUgd3Jvbmcgb3JkZXIgYXJlIGFzIGluY29tcGF0aWJsZSBhcyB0d28gdHlwZXMgdGhhdCB3aWxsIG5vdFxuICogdW5pZnksIGFuZCBvbmx5IG9uZSBvZiB0aGUgdHdvIGNhbiBiZSBTRUVOIGJ5IGEgY29tcGF0aWJpbGl0eSBjaGVjay5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSLCBSRS1IT01FRDogYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgRE9FUyBOT1QgREVURUNUIEEgREVBRFxuICogICAgQ0xJRU5ULiBNRUFTVVJFRCBPTiBCVU4gMS4zLjE0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFNpeCBkYWVtb25zIHdyaXRlIGEgaGVhcnRiZWF0IGFzIGB0cnkgeyBjb250cm9sbGVyLmVucXVldWUoLi4uKSB9IGNhdGNoIHt9YFxuICogd2l0aCBhIGNvbW1lbnQgc2F5aW5nIHRoZSBjYXRjaCBpcyBob3cgYSBkZXBhcnRlZCBjbGllbnQgaXMgbm90aWNlZC4gSXQgaXNcbiAqIG5vdDogZW5xdWV1ZSBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gQlVGRkVSUyBTSUxFTlRMWSBhbmQgbmV2ZXIgdGhyb3dzLCBzbyB0aGVcbiAqIGNhdGNoIG5ldmVyIGZpcmVzIGFuZCB0aG9zZSBkYWVtb25zJyBkZWFkLWNsaWVudCBkZXRlY3Rpb24gcmVzdHMgb24gYVxuICogbWVjaGFuaXNtIHRoZWlyIG93biBjb21tZW50cyBkZXNjcmliZSBpbmNvcnJlY3RseS4gV2hhdCBhY3R1YWxseSByZWNsYWltcyB0aGVcbiAqIGNvbm5lY3Rpb24gaXMgdGhlIHN0cmVhbSdzIGBjYW5jZWwoKWAg4oCUIGFuZCwgZm9yIGEgY2xpZW50IHRoYXQgbmV2ZXIgY2xvc2VzXG4gKiB0aGUgc29ja2V0LCBgcmVxLnNpZ25hbGAuXG4gKlxuICogU28gdGhlIGZ1bm5lbCBiZWxvdyBpcyB0aGUgbG9hZC1iZWFyaW5nIHBhcnQuIGB0ZWFyZG93bigpYCBydW5zIEFUIE1PU1QgT05DRVxuICogZnJvbSBldmVyeSBwYXRoIHRoZXJlIGlzIOKAlCBgY2FuY2VsKClgLCBhbiBhYm9ydCBvbiB0aGUgcmVxdWVzdCBzaWduYWwsIGFuZFxuICogdGhlIGJlbHQtYW5kLWJyYWNlcyBlbnF1ZXVlIGNhdGNoIOKAlCBhbmQgaXQgaXMgd2hlcmUgdGhlIHN1YnNjcmliZXIgY291bnQgYW5kXG4gKiBhbnkgcHJlc2VuY2UgZGVjcmVtZW50IHJpZGUuIEJvdW5kaW5nIHByZXNlbmNlIGFjY3VyYWN5IGlzIGJvdW5kaW5nIHRoYXRcbiAqIGZ1bm5lbC5cbiAqXG4gKiDimqAgS25vd24gaG9sZSwgYWNjZXB0ZWQgYW5kIGluaGVyaXRlZDogQnVuJ3Mgb3duIGBmZXRjaCgpYCByZWFkZXIgYC5jYW5jZWwoKWBcbiAqIGNsb3NlcyBub3RoaW5nIGNsaWVudC1zaWRlIGFuZCB0aGUgc2VydmVyIGNhbm5vdCBzZWUgaXQuIFJlYWwgY2xpZW50cyBjbG9zZVxuICogdGhlIHNvY2tldC5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBET0VTIE5PVCBBRE9QVCBUSElTLCBBTkQgVEhFIFJFRlVTQUwgSVMgUEFSVCBPRiBUSEUgUlVMSU5HIOKUgOKUgFxuICpcbiAqIFJFSkVDVC1TVFJVQ1RVUkFMLCBydWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLlxuICogR3JhcGV2aW5lIEhBUyBhbiBTU0UgcmVnaXN0cnkgYW5kIGl0IGlzIHRoZSBidXNpZXN0IHRoaW5nIGluIHRoZSBzcGVsbDsgdGhlXG4gKiB0d28gdHlwZXMgc2ltcGx5IGNhbm5vdCBiZSBjb25zdHJ1Y3RlZCBmcm9tIGVhY2ggb3RoZXI6XG4gKlxuICogICB0aGlzIG1vZHVsZSAgYFNzZUNsaWVudHMgPSBTZXQ8U3NlQ2xpZW50PmAgd2hlcmUgYFNzZUNsaWVudCA9IHtjbG9zZSwgc2VuZH1gXG4gKiAgICAgICAgICAgICAgICDigJQgYSByZWdpc3RyeSBvZiBBTk9OWU1PVVMgY2xvc2VycywgYW5kIGBzaXplYCBpcyB0aGUgb25seSB0aGluZ1xuICogICAgICAgICAgICAgICAgYW55IGFkb3B0aW5nIGRhZW1vbiByZWFkcyBvZmYgaXQuXG4gKiAgIGdyYXBldmluZSAgICBgTWFwPHN5bWJvbCwge2FsaWFzLCBodW1hbiwgbHVyaywgc2VuZH0+YCwgcGVyIGNoYW5uZWwuXG4gKlxuICogKipUaGUgcmVhZGVycyB0aGF0IG1ha2UgdGhlbSBpbmNvbXBhdGlibGUsIGNvdW50ZWQgcmF0aGVyIHRoYW4gYXNzZXJ0ZWQ6IFNJWFxuICogcm91dGVzIHJlYWQgYGFsaWFzYC9gaHVtYW5gL2BsdXJrYCoqIOKAlCBgR0VUIC9jaGFubmVsc2AgKHRocm91Z2hcbiAqIGBsaXN0Q2hhbm5lbHNgIOKGkiBgdmlzaWJsZVN1YnNgKSwgYEdFVCAvcHJlc2VuY2VgLCBgUE9TVCAvY2hhbm5lbHNgLFxuICogYFBPU1QgL2Fubm91bmNlYCwgYFBPU1QgL2NoYW5uZWxzLzpuYW1lL21lc3NhZ2VzYCwgYW5kXG4gKiBgR0VUIC9jaGFubmVscy86bmFtZS9zdWJzY3JpYmVyc2AuIGBhbGlhc2AgaXMgYSBuYW1lIGEgaHVtYW4gc2VlcyBpbiBhIHJvc3RlcixcbiAqIGBodW1hbmAgdGVsbHMgYW4gYWdlbnQgaXQgaXMgdGFsa2luZyB0byBhIHBlcnNvbiwgYW5kIGBsdXJrYCBleGNsdWRlcyBhXG4gKiBjb25uZWN0aW9uIGZyb20gZXZlcnkgcHJlc2VuY2UgY291bnQuIFRoZXJlIGlzIG5vIHdheSB0byBwdXQgYW55IG9mIHRoYXQgaW50b1xuICogYSBzZXQgb2YgY2xvc2Vycy4gQWRvcHRpbmcgdGhpcyBtb2R1bGUgd291bGQgbm90IGJlIGRlYWQgY29kZTsgaXQgd291bGQgYmUgYVxuICogcmV3cml0ZSBvZiB3aGF0IGdyYXBldmluZSBJUy5cbiAqXG4gKiDimqAgKipBTkQgVEhFIExJU1QgSVMgREVMSUJFUkFURUxZIE5PVCBUSEUgT0JWSU9VUyBPTkUuKiogVGhlIHBvcnQncyBmaXJzdFxuICogY291bnQgbmFtZWQgdGhlIGByb2xsYC9jbGVhciBicm9hZGNhc3QsIHRoZSBhcmNoaXZlIGxpdmUtZ3VhcmQgYW5kIHR3b1xuICogUkVHSVNUUkFUSU9OUyDigJQgYW5kIGV2ZXJ5IG9uZSBvZiB0aG9zZSBpcyBhIHNpdGUgdGhpcyBtb2R1bGUncyB0eXBlIHdvdWxkXG4gKiBzZXJ2ZSBwZXJmZWN0bHk6IHRoZSBicm9hZGNhc3QgcmVhZHMgb25seSBgcy5zZW5kYCwgdGhlIGxpdmUtZ3VhcmQgb25seVxuICogYHN1YnNjcmliZXJzLnNpemVgICh3aGljaCB0aGlzIGhlYWRlciBpdHNlbGYgc2F5cyBpcyBhbGwgYW55IGFkb3B0ZXIgcmVhZHMpLFxuICogYW5kIGEgcmVnaXN0cmF0aW9uIFdSSVRFUyB0aGUgcmVjb3JkIHJhdGhlciB0aGFuIHJlYWRpbmcgaXQuIFRoZSBzaXggYWJvdmUgYXJlXG4gKiB0aGUgb25lcyB0aGF0IHJlYWQgYSBmaWVsZCB0aGUga2l0J3MgYFNzZUNsaWVudGAgZG9lcyBub3QgaGF2ZTsgdGhlIHdyaXRlcnNcbiAqIChgL3dhaXRgJ3MgcHJlc2VuY2UgcmVnaXN0cmF0aW9uIGFuZCB0aGUgdGFpbCdzKSBhcmUgbmFtZWQgc2VwYXJhdGVseSBiZWNhdXNlXG4gKiBhIHdyaXRlciBpcyBub3QgZXZpZGVuY2Ugb2YgYW55dGhpbmcuIENvdW50ZWQgaW4gdGhlIHByZS1wb3J0IGRhZW1vbixcbiAqIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvZ3JhcGV2aW5lL3NjcmlwdHMvZGFlbW9uLnRzYCBvbiBgZGV2ZWxvcGA6XG4gKiBsLjQyMSwgNzM5LTc0NywgODI2LCA4ODYtODg3LCAxMDQ5LTEwNTQsIDExODItMTE4OCDigJQgd3JpdGVycyBhdCAxMTExLTExMTIgYW5kXG4gKiAxMzA3LiAoQ29ycmVjdGVkIDIwMjYtMDktMDkgaW4gdGhlIHJlcGFpciBjaGFwdGVyOyBENjgncyByZXF1aXJlbWVudCBpcyB0aGF0XG4gKiB0aGUgcmVmdXNhbCBiZSB3cml0dGVuIHdoZXJlIHRoZSBuZXh0IHJlYWRlciBtZWV0cyBpdCwgd2hpY2ggbWFrZXMgYVxuICogbWlzLW1lYXN1cmVkIGxpc3Qgd29yc2UgdGhhbiBub25lLilcbiAqXG4gKiDimqAgQW5kIGdyYXBldmluZSdzIHJlY29yZHMgY2Fycnkgbm8gYGNsb3NlYCBhdCBhbGwg4oCUIHRoZSBwZXItc3RyZWFtIHRlYXJkb3duIGlzXG4gKiBhIGNsb3N1cmUgc3Rhc2hlZCBvbiB0aGUgUmVhZGFibGVTdHJlYW0gY29udHJvbGxlciwgcmVhY2hhYmxlIG9ubHkgZnJvbVxuICogYGNhbmNlbCgpYCDigJQgd2hpY2ggaXMgYWxzbyB3aHkgYGhvdXNla2VlcGluZ2AncyBgZHJhaW5BbmRTdG9wYCBpcyBhZG9wdGVkXG4gKiB0aGVyZSB3aXRoIGl0cyBgY2xpZW50c2AgYXJndW1lbnQgZGVsaWJlcmF0ZWx5IGVtcHR5LlxuICpcbiAqICoqVGhlIHdpZGVuaW5nIE5PVCBkb25lLCB3aXRoIGl0cyBjb3N0OioqIGFkbWl0dGluZyBhbiBhbGlhcy1iZWFyaW5nIHJlY29yZFxuICogd291bGQgY2hhbmdlIHRoZSB0eXBlIGZpdmUgb3RoZXIgZGFlbW9ucyBjb21waWxlIGFnYWluc3QgYW5kIHJlLWVtaXQgU0lYXG4gKiBhcnRpZmFjdHMgYWNyb3NzIEZJVkUgc3BlbGxzLCBlYWNoIG93ZWQgYSBkcml2ZS4gSXQgd291bGQgYWxzbyByZS1jcmVhdGUgdGhlXG4gKiB0aGluZyB0aGlzIHJlZ2lzdHJ5IGV4aXN0cyB0byBzdG9wLCBhbmQgdGhpcyBmaWxlJ3Mgb3duIGJvdW5kYXJ5IHBhcmFncmFwaFxuICogc2F5cyBob3c6IGEgc2lnbmF0dXJlIHdpZGUgZW5vdWdoIHRvIGFic29yYiBldmVyeSBjYWxsZXIncyBzaGFwZSBzdG9wcyBiZWluZyBhXG4gKiByZWdpc3RyeSBhbmQgYmVjb21lcyBhIHVuaW9uLiBUaGUgY2Vuc3VzIGNvbnZlcmdlZCBjb3BpZXMgaW50byBvbmUgbW9kdWxlIGJ5XG4gKiBmaW5kaW5nIHdoYXQgdGhleSBTSEFSRUQ7IGEgbW9kdWxlIHdpZGVuZWQgdG8gZml0IHRoZSBvbmUgc3BlbGwgdGhhdCBzaGFyZXNcbiAqIG5vdGhpbmcgaXMgdGhvc2UgY29waWVzIGFnYWluIHdpdGggYSB1bmlvbiB0eXBlIG92ZXIgdGhlIHRvcC4gVGhlIHNwZWxsIGtlZXBzXG4gKiBpdHMgb3duLCBhbmQgYSB3aWRlbmluZyByZW1haW5zIGEgc2VwYXJhdGUsIGFyZ3VlZCBkZWNpc2lvbi5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEV2ZW50TG9nLCBGcmFtZSB9IGZyb20gXCIuL2V2ZW50TG9nLnRzXCI7XG5cbi8qKlxuICogT25lIG9wZW4gU1NFIHN0cmVhbSwgYXMgdGhlIGRhZW1vbiBjYW4gYWN0IG9uIGl0OiBlbmQgaXQsIG9yIHB1c2ggYSBmcmFtZSB0b1xuICogaXQgdGhhdCBkaWQgbm90IGNvbWUgb3V0IG9mIHRoZSBsb2cuXG4gKlxuICog4puUIElUIElTIE5PVCBBIENPTlRST0xMRVIuIFRoZSBjb3BpZXMgaGVsZFxuICogYFNldDxSZWFkYWJsZVN0cmVhbURlZmF1bHRDb250cm9sbGVyPmAgYW5kIGNsb3NlZCB0aGVtIGRpcmVjdGx5IGF0IHRlYXJkb3duLFxuICogd2hpY2ggYnlwYXNzZXMgdGhlIHRlYXJkb3duIGZ1bm5lbCBhYm92ZSDigJQgdGhlIGhlYXJ0YmVhdCBpbnRlcnZhbCBmb3IgdGhhdFxuICogc3RyZWFtIHdhcyBjbGVhcmVkIG9ubHkgYmVjYXVzZSBhIHNlY29uZCBgU2V0YCBvZiB0aW1lcnMgd2FzIGtlcHQgaW4gcGFyYWxsZWxcbiAqIGFuZCBzd2VwdCBzZXBhcmF0ZWx5LiBFdmVyeXRoaW5nIGhlcmUgZ29lcyB0aHJvdWdoIHRoZSBmdW5uZWwsIGFuZCBhIGBzZW5kYFxuICogYWZ0ZXIgdGVhcmRvd24gaXMgYSBuby1vcCByYXRoZXIgdGhhbiBhIHRocm93LlxuICpcbiAqIOKaoCAqKmBzZW5kYCBBUlJJVkVEIElOIFBIQVNFIDIsIEZST00gVEhFIEZJUlNUIENPTlNVTUVSIFRIQVQgV0FTIE5PVCBPTkUgT0YgVEhFXG4gKiBUV08gVEhJUyBNT0RVTEUgV0FTIERFU0lHTkVEIEFHQUlOU1QuKiogYXN0cm9sYWJlIGFuZCBtYWdwaWUgYW5ub3VuY2UgcHJlc2VuY2VcbiAqIG92ZXIgdGhlaXIgYnJvd3NlciBXRUJTT0NLRVQsIHNvIGEgcmVnaXN0cnkgb2YgYmFyZSBjbG9zZXJzIHdhcyBzdWZmaWNpZW50IGFuZFxuICogdGhlIGJvdW5kYXJ5IGxvb2tlZCByaWdodC4gZ2xhbW91ciBhbm5vdW5jZXMgaXQgb24gdGhlIEFHRU5UJ3MgU1NFIHRhaWwg4oCUXG4gKiBge3R5cGU6XCJjb25uZWN0ZWRcIn1gIC8gYHt0eXBlOlwiZGlzY29ubmVjdGVkXCJ9YCwgZGVsaWJlcmF0ZWx5IHVubG9nZ2VkLCBzbyBhXG4gKiByZWNvbm5lY3RpbmcgYWdlbnQgZG9lcyBub3QgcmUtc2VlIGV2ZXJ5IHBhc3QgY29ubmVjdCBhbmQgc28gdGhlIGZyYW1lIG5ldmVyXG4gKiBhZHZhbmNlcyBhIHRhaWwgY3Vyc29yLiBUaGF0IGlzIG5vdCBhIGdsYW1vdXIgcXVpcms7IGl0IGlzIHRoZSBnZW5lcmFsIHNoYXBlXG4gKiBvZiBcInRlbGwgdGhlIGxpdmUgc3Vic2NyaWJlcnMgc29tZXRoaW5nIHRoYXQgaXMgbm90IHBhcnQgb2YgdGhlIGhpc3RvcnlcIiwgYW5kXG4gKiBhIHJlZ2lzdHJ5IHRoYXQgY2FuIG9ubHkgRU5EIGEgc3RyZWFtIGNhbm5vdCBleHByZXNzIGl0LiBXaXRob3V0IHRoaXMgdGhlXG4gKiBzcGVsbCB3b3VsZCBoYXZlIGhhZCB0byBrZWVwIGl0cyBvd24gcGFyYWxsZWwgYFNldGAgb2YgY29udHJvbGxlcnMsIHdoaWNoIGlzXG4gKiBleGFjdGx5IHRoZSBkcmlmdCB0aGlzIHJlZ2lzdHJ5IGV4aXN0cyB0byByZW1vdmUuXG4gKi9cbmV4cG9ydCB0eXBlIFNzZUNsaWVudCA9IHtcbiAgLyoqIEVuZCB0aGlzIHN0cmVhbSwgdGhyb3VnaCB0aGUgdGVhcmRvd24gZnVubmVsLCBhdCBtb3N0IG9uY2UuICovXG4gIGNsb3NlKCk6IHZvaWQ7XG4gIC8qKiBXcml0ZSBvbmUgcmF3IFNTRSBjaHVuayB0byB0aGlzIHN0cmVhbS4gTm8tb3Agb25jZSB0b3JuIGRvd24uICovXG4gIHNlbmQoY2h1bms6IHN0cmluZyk6IHZvaWQ7XG59O1xuXG4vKipcbiAqIFRoZSBsaXZlLXRhaWwgcmVnaXN0cnkuIGBzaXplYCBpcyB0aGUgZGFlbW9uJ3MgU1NFIHN1YnNjcmliZXIgY291bnQg4oCUIHRoZVxuICogbnVtYmVyIGBzaG91bGRJZGxlQ2xvc2VgIG11c3Qgc2VlIOKAlCBhbmQgY2xvc2luZyBldmVyeSBlbnRyeSBpcyB3aGF0IGEgZHJhaW5cbiAqIGRvZXMuXG4gKi9cbmV4cG9ydCB0eXBlIFNzZUNsaWVudHMgPSBTZXQ8U3NlQ2xpZW50PjtcblxuZXhwb3J0IGludGVyZmFjZSBTc2VPcHRpb25zPFQgZXh0ZW5kcyBvYmplY3Q+IHtcbiAgLyoqIFRoZSBsb2cgdG8gcmVwbGF5IGZyb20gYW5kIHN1YnNjcmliZSB0by4gKi9cbiAgbG9nOiBFdmVudExvZzxUPjtcbiAgLyoqIFRoZSBjYWxsZXIncyByZXN1bWUgY3Vyc29yLiBBYnNlbnQgb3IgdW5wYXJzZWFibGUgcmVwbGF5cyBmcm9tIHRoZSBzdGFydC4gKi9cbiAgc2luY2U6IG51bWJlcjtcbiAgLyoqIEhlYXJ0YmVhdCBjb21tZW50IGludGVydmFsLiBNVVNUIHN0YXkgd2VsbCB1bmRlciB0aGUgc2VydmVyJ3NcbiAgICogIGBpZGxlVGltZW91dGAg4oCUIHNlZSBgaGVhcnRiZWF0LnRzYCwgd2hpY2ggaXMgd2hlcmUgdGhhdCBwYWlyIGxpdmVzLiAqL1xuICBoZWFydGJlYXRNczogbnVtYmVyO1xuICAvKiogTGl2ZW5lc3MgcmVnaXN0cnk7IHRoZSBzdHJlYW0gYWRkcyBpdHNlbGYgb24gb3BlbiBhbmQgcmVtb3ZlcyBpdHNlbGYgaW5cbiAgICogIHRoZSB0ZWFyZG93biBmdW5uZWwuICovXG4gIGNsaWVudHM/OiBTc2VDbGllbnRzO1xuICAvKiogYHJlcS5zaWduYWxgIOKAlCB0aGUgb25seSB0aGluZyB0aGF0IHJlY2xhaW1zIGEgY2xpZW50IHRoYXQgd2VudCBhd2F5XG4gICAqICB3aXRob3V0IGNhbmNlbGxpbmcgdGhlIHN0cmVhbS4gKi9cbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIC8qKiBTZXJ2ZXItc2lkZSBmaWx0ZXIuIEEgcmVqZWN0ZWQgZnJhbWUgaXMgbm90IHNlbnQ7IHRoZSBjbGllbnQgc3RpbGxcbiAgICogIGFkdmFuY2VzIGl0cyBjdXJzb3IgcGFzdCBpdCwgd2hpY2ggaXMgYHRhaWxFdmVudHNgJ3MgZG9jdW1lbnRlZCBydWxlLiAqL1xuICBmaWx0ZXI/OiAoZnJhbWU6IEZyYW1lPFQ+KSA9PiBib29sZWFuO1xuICAvKipcbiAgICogUmF3IFNTRSBjaHVua3Mgd3JpdHRlbiB0byBUSElTIHN0cmVhbSBCRUZPUkUgdGhlIHJlcGxheSDigJQgYWZ0ZXIgdGhlXG4gICAqIGBcIjogY29ubmVjdGVkXCJgIHByZWFtYmxlIGFuZCBiZWZvcmUgYGxvZy5zdWJzY3JpYmVgLCBzbyB3aGF0ZXZlciBpdCByZXR1cm5zXG4gICAqIGlzIHRoZSBzdHJlYW0ncyBmaXJzdCBEQVRBIGxpbmUgcmF0aGVyIHRoYW4gYSBmcmFtZSBidXJpZWQgYmVoaW5kIGFcbiAgICogcmVwbGF5ZWQgYmFja2xvZy5cbiAgICpcbiAgICog4puUIElUIElTIEEgUE9TSVRJT04sIFdISUNIIElTIFdIWSBgb25PcGVuYCBDT1VMRCBOT1QgU0VSVkUgKEQ4NSkuIGBvbk9wZW5gXG4gICAqIGZpcmVzIGF0IHRoZSBlbmQgb2YgYHN0YXJ0YCDigJQgYWZ0ZXIgdGhlIHByZWFtYmxlLCBhZnRlciBgbG9nLnN1YnNjcmliZWAsXG4gICAqIGFmdGVyIGBjbGllbnRzLmFkZGAg4oCUIHNvIGEgY2FsbGVyIHRoYXQgc3VwcGxpZXMgaXRzIG93biBgY2xpZW50c2Agc2V0IGFuZFxuICAgKiBzZW5kcyBmcm9tIHRoZXJlIGxhbmRzIGl0cyBmcmFtZSBBRlRFUiB0aGUgYmFja2xvZy4gVGhhdCBpcyBleHByZXNzaWJsZSBhbmRcbiAgICogaXQgaXMgdGhlIHdyb25nIG9yZGVyLCB3aGljaCBpcyB0aGUgbmVhci1taXNzIHRoYXQgbWFrZXMgdGhpcyBhIG1lYXN1cmVtZW50XG4gICAqIHJhdGhlciB0aGFuIGFuIGFzc2VydGlvbjogbm90aGluZyBhYm91dCB0aGUgVFlQRVMgcHJldmVudHMgaXQsIGFuZCBhXG4gICAqIHR5cGUtdG8tdHlwZSBjb21wYXRpYmlsaXR5IGNoZWNrIGNhbm5vdCBzZWUgYSBwb3NpdGlvbi5cbiAgICpcbiAgICog4puUIFJFU1RPUkVEIEZST00gVEhFIFNQRUxMIFRISVMgTU9EVUxFIFdBUyBDT05WRVJHRUQgVE9XQVJELCBBTkQgSVQgSVMgQVxuICAgKiBSRVNUT1JBVElPTiBSQVRIRVIgVEhBTiBBIFdJREVOSU5HIE9OIFRXTyBNRUFTVVJFRCBOVU1CRVJTIChENzkvRDg1KS5cbiAgICogbWluZC1tYXBwZXIncyBgc3NlUmVzcG9uc2VgIHdyb3RlIGl0cyBgdGFpbCAtLWluYm91bmRgIGdyb3VuZGluZyBmcmFtZSBvbmVcbiAgICogbGluZSBBQk9WRSBgYnVzLnN1YnNjcmliZWA7IHRoaXMgbW9kdWxlJ3MgY29udmVyZ2VuY2UgZHJvcHBlZCB0aGUgcG9zaXRpb24sXG4gICAqIHNvIHRoZSBvbmx5IHByb3BlcnR5IG1pbmQtbWFwcGVyIGNvdWxkIG5vdCBhZG9wdCB3YXMgdGhlIG9yZGVyaW5nLiBBcHBsaWVkLFxuICAgKiB3aXRoIGV2ZXJ5IGtpdC1idW5kbGluZyBzcGVsbCByZWJ1aWx0OiAqKihhKSBzb3VyY2UgZWRpdHMgbmVlZGVkIGF0IHRoZVxuICAgKiBvdGhlciBmaXZlIGFkb3B0ZXJzOiBaRVJPKiog4oCUIHRoZSBmaWVsZCBpcyBvcHRpb25hbCBhbmQgbm9ib2R5IHBhc3NlcyBpdDtcbiAgICogKiooYikgYnl0ZXMgb2YgYW55IG90aGVyIGFkb3B0ZXIncyBXSVJFIHRoYXQgZGlmZmVyOiBaRVJPKiog4oCUIGFzdHJvbGFiZSxcbiAgICogYm91bnR5LCBnbGFtb3VyLCBpbWFnbyBhbmQgbWFncGllIHdlcmUgZHJpdmVuIHVuZGVyIHRoZWlyIG93biBzdWl0ZXMgYW5kXG4gICAqIHRoZWlyIHJlbGVhc2UgZHJpdmVzLCBhbmQgbm9uZSBvZiB0aGVtIHdyaXRlcyBhdCBvcGVuLiBCb3RoIG51bWJlcnMgemVybyBpc1xuICAgKiB3aGF0IFwidGhlIGtpdCByZW1vdmVkIGl0IHdoZW4gaXQgY29waWVkXCIgbWVhbnMgb3BlcmF0aW9uYWxseS5cbiAgICpcbiAgICog4pqgIEFORCBUSEUgSE9PSyBXQVMgUkVKRUNURUQgT05DRSwgRk9SIEEgUkVBU09OIFRIQVQgRE9FUyBOT1QgUkVBQ0ggVEhJU1xuICAgKiBDQVNFLiBEMzIncyBub3QtdGFrZW4gYXJndWVkIGFnYWluc3QgXCJhIGBzc2VSZXNwb25zZWAgaG9vayB0aGF0IGhhbmRzIHRoZVxuICAgKiBjYWxsZXIgYSByYXcgYHNlbmRgIOKApiB0aGUgY2FsbGVyIHRoZW4gaGFzIHRvIGtlZXAgaXRzIG93biBjb2xsZWN0aW9uIG9mXG4gICAqIHRoZW1cIiDigJQgYWdhaW5zdCBnbGFtb3VyJ3MgcHJlc2VuY2UgQlJPQURDQVNULCB3aGljaCBwdXNoZXMgdG9cbiAgICogYWxyZWFkeS1vcGVuIHN0cmVhbXMgZnJvbSBvdXRzaWRlIGFuZCBkb2VzIG5lZWQgYSBjb2xsZWN0aW9uLiBUaGlzIGlzIG9uZVxuICAgKiBmcmFtZSwgb24gb25lIHN0cmVhbSwgYXQgb3BlbiwgYW5kIHRoZSBjYWxsZXIga2VlcHMgbm8gY29sbGVjdGlvbiBhdCBhbGwuXG4gICAqIEEgcmVqZWN0aW9uIGlzIHNjb3BlZCB0byB0aGUgY2FzZSB0aGF0IHByb2R1Y2VkIGl0LlxuICAgKi9cbiAgb3BlbkZyYW1lcz86ICgpID0+IHN0cmluZ1tdO1xuICAvKiogUnVuIGFmdGVyIHRoZSBzdHJlYW0gaXMgc3Vic2NyaWJlZCAocHJlc2VuY2UgdXAsIGFjdGl2aXR5IHRvdWNoKS4gKi9cbiAgb25PcGVuPzogKCkgPT4gdm9pZDtcbiAgLyoqIFJ1biBleGFjdGx5IG9uY2UsIGZyb20gd2hpY2hldmVyIHRlYXJkb3duIHBhdGggZmlyZXMgZmlyc3QuICovXG4gIG9uQ2xvc2U/OiAoKSA9PiB2b2lkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3NlUmVzcG9uc2U8VCBleHRlbmRzIG9iamVjdD4ob3B0czogU3NlT3B0aW9uczxUPik6IFJlc3BvbnNlIHtcbiAgY29uc3QgeyBsb2csIHNpbmNlLCBoZWFydGJlYXRNcywgY2xpZW50cywgc2lnbmFsLCBmaWx0ZXIsIG9wZW5GcmFtZXMsIG9uT3Blbiwgb25DbG9zZSB9ID0gb3B0cztcblxuICBsZXQgdW5zdWJzY3JpYmU6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBsZXQga2VlcGFsaXZlOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRJbnRlcnZhbD4gfCBudWxsID0gbnVsbDtcbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICAvLyBUaGUgcmVnaXN0cnkgZW50cnkgZm9yIFRISVMgc3RyZWFtLiBJdHMgbWV0aG9kcyBhcmUgZmlsbGVkIGluIGJ5IGBzdGFydGAsXG4gIC8vIHdoaWNoIGlzIHdoZXJlIHRoZSBjb250cm9sbGVyIGV4aXN0czsgdGhlIG9iamVjdCBpZGVudGl0eSBpcyBzdGFibGUgZnJvbVxuICAvLyBoZXJlIHNvIGB0ZWFyZG93bmAgY2FuIHJlbW92ZSBleGFjdGx5IHRoaXMgZW50cnkuXG4gIGNvbnN0IGNsaWVudDogU3NlQ2xpZW50ID0geyBjbG9zZTogKCkgPT4ge30sIHNlbmQ6ICgpID0+IHt9IH07XG5cbiAgY29uc3QgdGVhcmRvd24gPSAoKSA9PiB7XG4gICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgIGNsb3NlZCA9IHRydWU7XG4gICAgaWYgKGtlZXBhbGl2ZSAhPT0gbnVsbCkgY2xlYXJJbnRlcnZhbChrZWVwYWxpdmUpO1xuICAgIHVuc3Vic2NyaWJlPy4oKTtcbiAgICBjbGllbnRzPy5kZWxldGUoY2xpZW50KTtcbiAgICBvbkNsb3NlPy4oKTtcbiAgfTtcblxuICBjb25zdCBzdHJlYW0gPSBuZXcgUmVhZGFibGVTdHJlYW0oe1xuICAgIHN0YXJ0KGNvbnRyb2xsZXIpIHtcbiAgICAgIGNvbnN0IGVuY29kZXIgPSBuZXcgVGV4dEVuY29kZXIoKTtcbiAgICAgIGNvbnN0IHNhZmVFbnF1ZXVlID0gKGNodW5rOiBzdHJpbmcpID0+IHtcbiAgICAgICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnRyb2xsZXIuZW5xdWV1ZShlbmNvZGVyLmVuY29kZShjaHVuaykpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICB0ZWFyZG93bigpO1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgY2xpZW50LmNsb3NlID0gKCkgPT4ge1xuICAgICAgICB0ZWFyZG93bigpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnRyb2xsZXIuY2xvc2UoKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLyogYWxyZWFkeSBjbG9zZWQgYnkgdGhlIHJ1bnRpbWUgKi9cbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIC8vIOKblCBgc2VuZGAgR09FUyBUSFJPVUdIIGBzYWZlRW5xdWV1ZWAsIHNvIGFuIG91dC1vZi1iYW5kIGZyYW1lIG9iZXlzIHRoZVxuICAgICAgLy8gc2FtZSBjbG9zZWQtY2hlY2sgYW5kIHRoZSBzYW1lIHRlYXJkb3duLW9uLXRocm93IGFzIGEgbG9nZ2VkIG9uZS4gQVxuICAgICAgLy8gZGFlbW9uIG11c3Qgbm90IGJlIGFibGUgdG8gd3JpdGUgdG8gYSBzdHJlYW0gdGhpcyBtb2R1bGUgaGFzIHRvcm4gZG93bi5cbiAgICAgIGNsaWVudC5zZW5kID0gc2FmZUVucXVldWU7XG5cbiAgICAgIC8vIOKblCBBTiBPUEVOSU5HIENPTU1FTlQsIEJFRk9SRSBBTllUSElORyBFTFNFLiBJdCBmbHVzaGVzIHRoZSByZXNwb25zZVxuICAgICAgLy8gaGVhZGVycyBpbW1lZGlhdGVseTogc29tZSBIVFRQIGNsaWVudHMg4oCUIEJ1bidzIG93biBgZmV0Y2goKWAgaW5jbHVkZWQg4oCUXG4gICAgICAvLyBidWZmZXIgdW50aWwgdGhlIGZpcnN0IGJ5dGUgb2YgYm9keSBhcnJpdmVzLCBzbyBhIGdlbnVpbmVseSBxdWlldCBTU0VcbiAgICAgIC8vIHN0cmVhbSB3b3VsZCBvdGhlcndpc2UgbGVhdmUgdGhlIGNhbGxlcidzIGBmZXRjaCgpYCB1bnJlc29sdmVkLiBFdmVyeVxuICAgICAgLy8gaG91c2UgdGFpbCBjbGllbnQgcmVhZHMgYDpgIGxpbmVzIGFzIGNvbW1lbnRzIGFuZCBkcm9wcyB0aGVtLlxuICAgICAgc2FmZUVucXVldWUoXCI6IGNvbm5lY3RlZFxcblxcblwiKTtcblxuICAgICAgLy8g4puUIEJFRk9SRSBUSEUgUkVQTEFZLCBBTkQgVEhFIE9SREVSIElTIFRIRSBXSE9MRSBQT0lOVCDigJQgc2VlXG4gICAgICAvLyBgb3BlbkZyYW1lc2AgaW4gdGhlIG9wdGlvbnMgYWJvdmUuIEEgZ3JvdW5kaW5nIGZyYW1lIHdyaXR0ZW4gaGVyZSBpc1xuICAgICAgLy8gdGhlIHN0cmVhbSdzIGZpcnN0IGRhdGEgbGluZTsgd3JpdHRlbiBmcm9tIGBvbk9wZW5gIGl0IGFycml2ZXMgYWZ0ZXJcbiAgICAgIC8vIHRoZSByZXBsYXllZCBiYWNrbG9nLCB3aGljaCBpcyBhIGRpZmZlcmVudCBjb250cmFjdCB3ZWFyaW5nIHRoZSBzYW1lXG4gICAgICAvLyB0eXBlcy5cbiAgICAgIGlmIChvcGVuRnJhbWVzKSBmb3IgKGNvbnN0IGNodW5rIG9mIG9wZW5GcmFtZXMoKSkgc2FmZUVucXVldWUoY2h1bmspO1xuXG4gICAgICB1bnN1YnNjcmliZSA9IGxvZy5zdWJzY3JpYmUoc2luY2UsIChmcmFtZSkgPT4ge1xuICAgICAgICBpZiAoZmlsdGVyICYmICFmaWx0ZXIoZnJhbWUpKSByZXR1cm47XG4gICAgICAgIHNhZmVFbnF1ZXVlKGBkYXRhOiAke0pTT04uc3RyaW5naWZ5KGZyYW1lKX1cXG5cXG5gKTtcbiAgICAgIH0pO1xuXG4gICAgICBrZWVwYWxpdmUgPSBzZXRJbnRlcnZhbCgoKSA9PiBzYWZlRW5xdWV1ZShcIjogaGJcXG5cXG5cIiksIGhlYXJ0YmVhdE1zKTtcbiAgICAgIHNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIHRlYXJkb3duLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICBjbGllbnRzPy5hZGQoY2xpZW50KTtcbiAgICAgIG9uT3Blbj8uKCk7XG4gICAgfSxcbiAgICBjYW5jZWwoKSB7XG4gICAgICB0ZWFyZG93bigpO1xuICAgIH0sXG4gIH0pO1xuXG4gIHJldHVybiBuZXcgUmVzcG9uc2Uoc3RyZWFtLCB7XG4gICAgaGVhZGVyczoge1xuICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJ0ZXh0L2V2ZW50LXN0cmVhbVwiLFxuICAgICAgXCJDYWNoZS1Db250cm9sXCI6IFwibm8tY2FjaGVcIixcbiAgICAgIENvbm5lY3Rpb246IFwia2VlcC1hbGl2ZVwiLFxuICAgIH0sXG4gIH0pO1xufVxuIiwKICAgICIvLyBGaW5kaW5nIHdoZXJlIGEgbm90ZSBiZWxvbmdzLCBpbiBhIGRvY3VtZW50IHRoYXQgaGFzIG1vdmVkIHVuZGVyIGl0IChFNDUpLlxuLy9cbi8vIOKblCBRVU9URUQtVEVYVCBBTkNIT1JJTkcsIEFORCBUSEUgQUxURVJOQVRJVkUgSVMgV0hZLiBBbiBvZmZzZXQgZ29lcyBzdGFsZSBvblxuLy8gdGhlIG5leHQga2V5c3Ryb2tlOiBmaXggYSB0eXBvIHRocmVlIGxpbmVzIHVwIGFuZCBldmVyeSBub3RlIGJlbG93IHBvaW50cyBhdFxuLy8gdGhlIHdyb25nIHdvcmRzLiBQaW5uaW5nIGEgbm90ZSB0byB0aGUgVkVSU0lPTiBpdCB3YXMgbWFkZSBvbiB3b3VsZCBiZSBleGFjdFxuLy8gZm9yZXZlciBhbmQgdXNlbGVzcyDigJQgdGhlIHN0YXRlZCB1c2UgaXMgbWFraW5nIG5vdGVzIFdISUxFIHJlYWRpbmcgYW5kXG4vLyBlZGl0aW5nLCBhbmQgYSBub3RlIHRoYXQgZGV0YWNoZXMgdGhlIG1vbWVudCB5b3UgZWRpdCBpcyBhIG5vdGUgeW91IGNhbm5vdFxuLy8gdXNlLiBTbyBhIG5vdGUgcmVtZW1iZXJzIHRoZSBURVhUIGl0IHdhcyBtYWRlIG9uLCBwbHVzIGEgbGl0dGxlIG9mIHdoYXRcbi8vIHN1cnJvdW5kZWQgaXQsIGFuZCBpcyByZS1mb3VuZCBvbiBldmVyeSByZWFkIChDb2xlIGFwcHJvdmVkIHRoZSB0cmFkZTogXCJ3ZVxuLy8gdGVzdCBpdCBvdXQgYW5kIHNlZSBpZiBpdCB3b3JrcyBhbmQgYWRqdXN0IGFzIG5lZWRlZFwiKS5cbi8vXG4vLyDim5QgQU5EIElUIFNBWVMgV0hFTiBJVCBIQVMgTE9TVC4gVGhlIGZvdXJ0aCBvdXRjb21lIGlzIE9SUEhBTkVEIOKAlCB0aGUgcXVvdGUgaXNcbi8vIGdvbmUgYW5kIHRoZSBub3RlIGlzIHNob3duIGRldGFjaGVkIHJhdGhlciB0aGFuIHBpbm5lZCBzb21ld2hlcmUgcGxhdXNpYmxlLlxuLy8gVmlzaWJsZS1hbmQtd3JvbmcgYmVhdHMgaW52aXNpYmxlLWFuZC13cm9uZzsgYSBub3RlIHNpbGVudGx5IHJlLWFuY2hvcmVkIG9udG9cbi8vIHVucmVsYXRlZCB3b3JkcyBpcyB0aGUgZmFpbHVyZSB0aGlzIGRlc2lnbiBleGlzdHMgdG8gYXZvaWQuXG5cbi8qKiBIb3cgbXVjaCB0ZXh0IGVpdGhlciBzaWRlIGlzIGtlcHQsIHRvIHRlbGwgaWRlbnRpY2FsIHF1b3RlcyBhcGFydC4gKi9cbmV4cG9ydCBjb25zdCBDT05URVhUX0NIQVJTID0gNDg7XG5cbi8qKiBXaGF0IGEgbm90ZSByZW1lbWJlcnMgYWJvdXQgd2hlcmUgaXQgd2FzIG1hZGUuICovXG5leHBvcnQgdHlwZSBBbmNob3IgPSB7XG4gIC8qKiBUaGUgdGV4dCB0aGUgbm90ZSB3YXMgbWFkZSBvbi4gRW1wdHkgbWVhbnMgdGhlIG5vdGUgaXMgYWJvdXQgdGhlIGRvY3VtZW50LiAqL1xuICBxdW90ZTogc3RyaW5nO1xuICAvKiogVGhlIGNoYXJhY3RlcnMgaW1tZWRpYXRlbHkgYmVmb3JlIGFuZCBhZnRlciB0aGUgcXVvdGUsIHdoZW4gaXQgd2FzIG1hZGUuICovXG4gIGJlZm9yZTogc3RyaW5nO1xuICBhZnRlcjogc3RyaW5nO1xuICAvKiogV2hlcmUgaXQgd2FzIHRoZW4g4oCUIGEgSElOVCBmb3IgY2hvb3NpbmcgYmV0d2VlbiBpZGVudGljYWwgcXVvdGVzLCBuZXZlciBhIHNvdXJjZSBvZiB0cnV0aC4gKi9cbiAgYXQ6IG51bWJlcjtcbn07XG5cbi8qKiBXaGVyZSBhIG5vdGUgYmVsb25ncyBub3csIGFuZCBob3cgc3VyZSB3ZSBhcmUuICovXG5leHBvcnQgdHlwZSBGb3VuZCA9XG4gIHwgeyBmcm9tOiBudW1iZXI7IHRvOiBudW1iZXI7IGhvdzogXCJjb250ZXh0XCIgfCBcInVuaXF1ZVwiIHwgXCJuZWFyZXN0XCIgfVxuICB8IHsgZnJvbTogbnVsbDsgdG86IG51bGw7IGhvdzogXCJvcnBoYW5lZFwiIH07XG5cbmNvbnN0IE9SUEhBTkVEOiBGb3VuZCA9IHsgZnJvbTogbnVsbCwgdG86IG51bGwsIGhvdzogXCJvcnBoYW5lZFwiIH07XG5cbi8qKiBUYWtlIGFuIGFuY2hvciBmcm9tIGEgc2VsZWN0aW9uIOKAlCB3aGF0IHRoZSBub3RlIHdpbGwgcmVtZW1iZXIuICovXG5leHBvcnQgZnVuY3Rpb24gYW5jaG9yT2YodGV4dDogc3RyaW5nLCBmcm9tOiBudW1iZXIsIHRvOiBudW1iZXIpOiBBbmNob3Ige1xuICByZXR1cm4ge1xuICAgIHF1b3RlOiB0ZXh0LnNsaWNlKGZyb20sIHRvKSxcbiAgICBiZWZvcmU6IHRleHQuc2xpY2UoTWF0aC5tYXgoMCwgZnJvbSAtIENPTlRFWFRfQ0hBUlMpLCBmcm9tKSxcbiAgICBhZnRlcjogdGV4dC5zbGljZSh0bywgdG8gKyBDT05URVhUX0NIQVJTKSxcbiAgICBhdDogZnJvbSxcbiAgfTtcbn1cblxuLyoqIEV2ZXJ5IGluZGV4IGF0IHdoaWNoIGBuZWVkbGVgIG9jY3VycyBpbiBgaGF5YCwgaW5jbHVkaW5nIG92ZXJsYXBzLiAqL1xuZnVuY3Rpb24gb2NjdXJyZW5jZXMoaGF5OiBzdHJpbmcsIG5lZWRsZTogc3RyaW5nKTogbnVtYmVyW10ge1xuICBpZiAobmVlZGxlID09PSBcIlwiKSByZXR1cm4gW107XG4gIGNvbnN0IGZvdW5kOiBudW1iZXJbXSA9IFtdO1xuICBsZXQgaSA9IGhheS5pbmRleE9mKG5lZWRsZSk7XG4gIHdoaWxlIChpICE9PSAtMSkge1xuICAgIGZvdW5kLnB1c2goaSk7XG4gICAgaSA9IGhheS5pbmRleE9mKG5lZWRsZSwgaSArIDEpO1xuICB9XG4gIHJldHVybiBmb3VuZDtcbn1cblxuLyoqXG4gKiBXaGVyZSB0aGUgbm90ZSBiZWxvbmdzIGluIGB0ZXh0YCBub3cuXG4gKlxuICogRm91ciBhbnN3ZXJzLCB0cmllZCBpbiBvcmRlciwgYW5kIGVhY2ggc2F5cyBob3cgaXQgd2FzIHJlYWNoZWQgc28gdGhlIHN1cmZhY2VcbiAqIGNhbiBzaG93IGEgcmUtYW5jaG9yZWQgbm90ZSBkaWZmZXJlbnRseSBmcm9tIGEgY2VydGFpbiBvbmU6XG4gKlxuICogMS4gKipjb250ZXh0Kiog4oCUIHRoZSBxdW90ZSBXSVRIIGl0cyBzdXJyb3VuZGluZ3Mgb2NjdXJzIGV4YWN0bHkgb25jZS4gVGhlXG4gKiAgICBzdHJvbmdlc3QgYW5zd2VyOiB0d28gaWRlbnRpY2FsIHNlbnRlbmNlcyBhcmUgdG9sZCBhcGFydCBieSB3aGF0IGlzXG4gKiAgICBhcm91bmQgdGhlbS5cbiAqIDIuICoqdW5pcXVlKiog4oCUIHRoZSBxdW90ZSBvY2N1cnMgZXhhY3RseSBvbmNlLiBJdHMgc3Vycm91bmRpbmdzIGNoYW5nZWQsIHRoZVxuICogICAgdGV4dCBkaWQgbm90LlxuICogMy4gKipuZWFyZXN0Kiog4oCUIHRoZSBxdW90ZSBvY2N1cnMgc2V2ZXJhbCB0aW1lczsgdGhlIG9uZSBjbG9zZXN0IHRvIHdoZXJlIGl0XG4gKiAgICB1c2VkIHRvIGJlIHdpbnMuIEEgZ3Vlc3MsIGFuZCBsYWJlbGxlZCBhcyBvbmUuXG4gKiA0LiAqKm9ycGhhbmVkKiog4oCUIHRoZSBxdW90ZSBpcyBnb25lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZEFuY2hvcih0ZXh0OiBzdHJpbmcsIGFuY2hvcjogQW5jaG9yKTogRm91bmQge1xuICBpZiAoYW5jaG9yLnF1b3RlID09PSBcIlwiKSByZXR1cm4gT1JQSEFORUQ7XG5cbiAgLy8gMS4gV2l0aCBjb250ZXh0LiBUaGUgcmVjb3JkZWQgY29udGV4dCBtYXkgaXRzZWxmIGJlIGNsaXBwZWQgYXQgYSBkb2N1bWVudFxuICAvLyAgICBlZGdlLCBzbyB0aGUgd2hvbGUgcnVuIGlzIHNlYXJjaGVkIHJhdGhlciB0aGFuIGFzc2VtYmxlZCBibGluZGx5LlxuICBjb25zdCB3aXRoQ29udGV4dCA9IGFuY2hvci5iZWZvcmUgKyBhbmNob3IucXVvdGUgKyBhbmNob3IuYWZ0ZXI7XG4gIGNvbnN0IGNvbnRleHRzID0gb2NjdXJyZW5jZXModGV4dCwgd2l0aENvbnRleHQpO1xuICBpZiAoY29udGV4dHMubGVuZ3RoID09PSAxKSB7XG4gICAgY29uc3QgZnJvbSA9IChjb250ZXh0c1swXSBhcyBudW1iZXIpICsgYW5jaG9yLmJlZm9yZS5sZW5ndGg7XG4gICAgcmV0dXJuIHsgZnJvbSwgdG86IGZyb20gKyBhbmNob3IucXVvdGUubGVuZ3RoLCBob3c6IFwiY29udGV4dFwiIH07XG4gIH1cblxuICBjb25zdCBoaXRzID0gb2NjdXJyZW5jZXModGV4dCwgYW5jaG9yLnF1b3RlKTtcbiAgaWYgKGhpdHMubGVuZ3RoID09PSAwKSByZXR1cm4gT1JQSEFORUQ7XG5cbiAgLy8gMi4gVGhlIHF1b3RlIGFsb25lLCBvbmNlLlxuICBpZiAoaGl0cy5sZW5ndGggPT09IDEpIHtcbiAgICBjb25zdCBmcm9tID0gaGl0c1swXSBhcyBudW1iZXI7XG4gICAgcmV0dXJuIHsgZnJvbSwgdG86IGZyb20gKyBhbmNob3IucXVvdGUubGVuZ3RoLCBob3c6IFwidW5pcXVlXCIgfTtcbiAgfVxuXG4gIC8vIDMuIFNldmVyYWwg4oCUIHRha2UgdGhlIG9uZSBuZWFyZXN0IHdoZXJlIGl0IHdhcy4gYGF0YCBpcyBhIGhpbnQsIHdoaWNoIGlzXG4gIC8vICAgIHdoeSB0aGlzIGFuc3dlciBpcyBsYWJlbGxlZDogdGhlIG5vdGUgbWF5IGhhdmUgbGFuZGVkIG9uIGEgdHdpbi5cbiAgbGV0IGJlc3QgPSBoaXRzWzBdIGFzIG51bWJlcjtcbiAgZm9yIChjb25zdCBoaXQgb2YgaGl0cykgaWYgKE1hdGguYWJzKGhpdCAtIGFuY2hvci5hdCkgPCBNYXRoLmFicyhiZXN0IC0gYW5jaG9yLmF0KSkgYmVzdCA9IGhpdDtcbiAgcmV0dXJuIHsgZnJvbTogYmVzdCwgdG86IGJlc3QgKyBhbmNob3IucXVvdGUubGVuZ3RoLCBob3c6IFwibmVhcmVzdFwiIH07XG59XG5cbi8qKiBBIG9uZS1saW5lIHZlcnNpb24gb2YgdGhlIHF1b3RlLCBmb3IgYSBsaXN0IHRoYXQgY2Fubm90IHNob3cgYWxsIG9mIGl0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHF1b3RlTGFiZWwocXVvdGU6IHN0cmluZywgbWF4ID0gNjApOiBzdHJpbmcge1xuICBjb25zdCBmbGF0ID0gcXVvdGUucmVwbGFjZSgvXFxzKy9ndSwgXCIgXCIpLnRyaW0oKTtcbiAgcmV0dXJuIGZsYXQubGVuZ3RoIDw9IG1heCA/IGZsYXQgOiBgJHtmbGF0LnNsaWNlKDAsIG1heCAtIDEpLnRyaW1FbmQoKX3igKZgO1xufVxuIiwKICAgICIvLyBDb21wYXJpbmcgdHdvIHRleHRzLCBhbmQgdGFraW5nIHBhcnQgb2Ygb25lIGludG8gdGhlIG90aGVyIChFMzYpLlxuLy9cbi8vIOKblCBPTkUgRElGRiwgQ09NUFVURUQgSU4gVEhFIERBRU1PTi4gYEBjb2RlbWlycm9yL21lcmdlYCB3YXMgbWVhc3VyZWQgZmlyc3Rcbi8vIGFuZCBpdCBpcyBidW5kbGUtY2xlYW4g4oCUIGl0cyBvbmx5IGRlcGVuZGVuY2llcyBhcmUgYEBjb2RlbWlycm9yL2xhbmd1YWdlYCxcbi8vIGBzdGF0ZWAsIGB2aWV3YCBhbmQgYEBsZXplci9oaWdobGlnaHRgLCBldmVyeSBvbmUgb2Ygd2hpY2ggdGhlIHN1cmZhY2Vcbi8vIGFscmVhZHkgc2hpcHMsIHNvIHdhcmQgMWIgaGFzIG5vdGhpbmcgdG8gc2F5IGFib3V0IGl0LiBJdCBpcyBub3QgdXNlZFxuLy8gYW55d2F5LCBhbmQgdGhlIHJlYXNvbiBpcyBub3Qgd2VpZ2h0OiBpdCB3b3VsZCBnaXZlIHRoZSBTVVJGQUNFIGl0cyBvd25cbi8vIGRpZmYgd2hpbGUgdGhlIGBkaWZmYCBDTEkgdmVyYiB1c2VkIHRoaXMgbW9kdWxlJ3MsIGFuZCBhIGh1bmsgdGhlIGh1bWFuXG4vLyBhY2NlcHRzIHdvdWxkIHRoZW4gYmUgYSBodW5rIGEgZGlmZmVyZW50IGVuZ2luZSBmb3VuZC4gVHdvIGRpZmYgZW5naW5lcyBvdmVyXG4vLyBvbmUgZG9jdW1lbnQgaXMgdGhlIGxvY2tzdGVwLW1pcnJvciBkcmlmdCB0aGlzIHJlcG8gaGFzIGFscmVhZHkgcGFpZCBmb3Jcbi8vIG9uY2UuIFRoZSBzdXJmYWNlIHJlbmRlcnMgdGhlIGh1bmtzIHRoZSBkYWVtb24gY29tcHV0ZWQsIGFuZCBgbWVyZ2VgIGFwcGxpZXNcbi8vIHRoZSBzYW1lIG9uZXMg4oCUIHNvIGEgbWlzbWF0Y2ggaXMgbm90IGEgYnVnIHRoYXQgY2FuIGJlIHdyaXR0ZW4gaGVyZS5cbi8vXG4vLyBXaGF0IHRoaXMgZGVsaWJlcmF0ZWx5IGlzIG5vdDogYSBzZW1hbnRpYyBvciBzeW50YWN0aWMgZGlmZi4gSXQgY29tcGFyZXNcbi8vIExJTkVTLCB0aGVuIHJlZmluZXMgaW5zaWRlIHBhaXJlZCBsaW5lcyBieSBXT1JELCB3aGljaCBpcyB3aGF0IGEgcHJvc2Vcbi8vIHJlYWRlciB3YW50cyDigJQgbW92ZWQgcGFyYWdyYXBocyByZWFkIGFzIGEgZGVsZXRlIGFuZCBhbiBhZGQsIGFuZCB0aGF0IGlzXG4vLyB0aGUgaG9uZXN0IGFuc3dlciByYXRoZXIgdGhhbiBhIHdyb25nIGNsZXZlciBvbmUuXG5pbXBvcnQgdHlwZSB7IERpZmYsIERpZmZIdW5rLCBEaWZmTGluZSwgRGlmZlNwYW4gfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKipcbiAqIFNwbGl0dGluZyBvbiBcIlxcblwiIGFuZCBqb2luaW5nIG9uIFwiXFxuXCIgcm91bmQtdHJpcHMgZXhhY3RseSwgSU5DTFVESU5HIHRoZVxuICogdHJhaWxpbmcgZW1wdHkgc3RyaW5nIGEgZmlsZSBlbmRpbmcgaW4gYSBuZXdsaW5lIHByb2R1Y2VzLiBUaGF0IGVtcHR5IGxpbmVcbiAqIGlzIHJlYWwgYXMgZmFyIGFzIHRoaXMgbW9kdWxlIGlzIGNvbmNlcm5lZCwgd2hpY2ggaXMgd2hhdCBrZWVwcyBhIG1lcmdlIGZyb21cbiAqIHF1aWV0bHkgYWRkaW5nIG9yIGRyb3BwaW5nIGEgZmluYWwgbmV3bGluZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNwbGl0TGluZXModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC5zcGxpdChcIlxcblwiKTtcbn1cblxuLyoqXG4gKiBUaGUgY2FwIG9uIE15ZXJzJyBEIOKAlCB0aGUgbnVtYmVyIG9mIGVkaXRzIGl0IHdpbGwgd2FsayBiZWZvcmUgZ2l2aW5nIHVwLlxuICogVHdvIHRleHRzIGRpZmZlcmluZyBieSBtb3JlIHRoYW4gdGhpcyBhcmUgbm90IHNvbWV0aGluZyBhIGh1bWFuIHJlYWRzIGh1bmtcbiAqIGJ5IGh1bmsgYW55d2F5LCBhbmQgdGhlIHF1YWRyYXRpYyB3b3JzdCBjYXNlIGlzIHdoYXQgdGhlIGNhcCBleGlzdHMgdG8ga2VlcFxuICogb3V0IG9mIGEgZGFlbW9uIHNlcnZpbmcgYSBzdXJmYWNlLlxuICovXG5jb25zdCBNQVhfRURJVFMgPSAzMDAwO1xuXG4vKipcbiAqIE15ZXJzJyBncmVlZHkgTyhORCkgZGlmZiBvdmVyIGxpbmVzLiBSZXR1cm5zIHRoZSB0cmFjZSBvZiBWIGFycmF5cywgb3IgbnVsbFxuICogd2hlbiB0aGUgdGV4dHMgZGlmZmVyIGJ5IG1vcmUgdGhhbiBgTUFYX0VESVRTYC5cbiAqL1xuZnVuY3Rpb24gbXllcnNUcmFjZShhOiBzdHJpbmdbXSwgYjogc3RyaW5nW10pOiBJbnQzMkFycmF5W10gfCBudWxsIHtcbiAgY29uc3QgbiA9IGEubGVuZ3RoO1xuICBjb25zdCBtID0gYi5sZW5ndGg7XG4gIGNvbnN0IG1heCA9IE1hdGgubWluKG4gKyBtLCBNQVhfRURJVFMpO1xuICBjb25zdCBzaXplID0gMiAqIG1heCArIDE7XG4gIGNvbnN0IG9mZnNldCA9IG1heDtcbiAgbGV0IHYgPSBuZXcgSW50MzJBcnJheShzaXplKTtcbiAgY29uc3QgdHJhY2U6IEludDMyQXJyYXlbXSA9IFtdO1xuICBmb3IgKGxldCBkID0gMDsgZCA8PSBtYXg7IGQrKykge1xuICAgIHRyYWNlLnB1c2godi5zbGljZSgpKTtcbiAgICBmb3IgKGxldCBrID0gLWQ7IGsgPD0gZDsgayArPSAyKSB7XG4gICAgICAvLyBUYWtlIHRoZSBsb25nZXIgb2YgdGhlIHR3byByZWFjaGFibGUgcGF0aHM6IGRvd24gKGFuIGluc2VydGlvbikgd2hlblxuICAgICAgLy8gayBpcyBhdCB0aGUgbG93ZXIgZWRnZSBvciB0aGUgZG93bi1uZWlnaGJvdXIgaGFzIGNvbWUgZnVydGhlci5cbiAgICAgIGNvbnN0IGRvd24gPSB2W29mZnNldCArIGsgKyAxXSBhcyBudW1iZXI7XG4gICAgICBjb25zdCByaWdodCA9IHZbb2Zmc2V0ICsgayAtIDFdIGFzIG51bWJlcjtcbiAgICAgIGxldCB4OiBudW1iZXI7XG4gICAgICBpZiAoayA9PT0gLWQgfHwgKGsgIT09IGQgJiYgcmlnaHQgPCBkb3duKSkgeCA9IGRvd247XG4gICAgICBlbHNlIHggPSByaWdodCArIDE7XG4gICAgICBsZXQgeSA9IHggLSBrO1xuICAgICAgd2hpbGUgKHggPCBuICYmIHkgPCBtICYmIGFbeF0gPT09IGJbeV0pIHtcbiAgICAgICAgeCsrO1xuICAgICAgICB5Kys7XG4gICAgICB9XG4gICAgICB2W29mZnNldCArIGtdID0geDtcbiAgICAgIGlmICh4ID49IG4gJiYgeSA+PSBtKSByZXR1cm4gdHJhY2U7XG4gICAgfVxuICAgIHYgPSB2LnNsaWNlKCk7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiBXYWxrIHRoZSB0cmFjZSBiYWNrd2FyZHMgaW50byBhIGxpc3Qgb2YgbGluZSBvcGVyYXRpb25zLCBmcm9udCB0byBiYWNrLiAqL1xuZnVuY3Rpb24gYmFja3RyYWNrKGE6IHN0cmluZ1tdLCBiOiBzdHJpbmdbXSwgdHJhY2U6IEludDMyQXJyYXlbXSk6IERpZmZMaW5lW10ge1xuICBjb25zdCBvZmZzZXQgPSBNYXRoLm1pbihhLmxlbmd0aCArIGIubGVuZ3RoLCBNQVhfRURJVFMpO1xuICBjb25zdCBvdXQ6IERpZmZMaW5lW10gPSBbXTtcbiAgbGV0IHggPSBhLmxlbmd0aDtcbiAgbGV0IHkgPSBiLmxlbmd0aDtcbiAgZm9yIChsZXQgZCA9IHRyYWNlLmxlbmd0aCAtIDE7IGQgPj0gMDsgZC0tKSB7XG4gICAgY29uc3QgdiA9IHRyYWNlW2RdIGFzIEludDMyQXJyYXk7XG4gICAgY29uc3QgayA9IHggLSB5O1xuICAgIGxldCBwcmV2SzogbnVtYmVyO1xuICAgIGlmIChrID09PSAtZCB8fCAoayAhPT0gZCAmJiAodltvZmZzZXQgKyBrIC0gMV0gYXMgbnVtYmVyKSA8ICh2W29mZnNldCArIGsgKyAxXSBhcyBudW1iZXIpKSlcbiAgICAgIHByZXZLID0gayArIDE7XG4gICAgZWxzZSBwcmV2SyA9IGsgLSAxO1xuICAgIGNvbnN0IHByZXZYID0gdltvZmZzZXQgKyBwcmV2S10gYXMgbnVtYmVyO1xuICAgIGNvbnN0IHByZXZZID0gcHJldlggLSBwcmV2SztcbiAgICB3aGlsZSAoeCA+IHByZXZYICYmIHkgPiBwcmV2WSkge1xuICAgICAgeC0tO1xuICAgICAgeS0tO1xuICAgICAgb3V0LnB1c2goeyBvcDogXCJzYW1lXCIsIGE6IHgsIGI6IHksIHRleHQ6IGFbeF0gYXMgc3RyaW5nIH0pO1xuICAgIH1cbiAgICBpZiAoZCA9PT0gMCkgYnJlYWs7XG4gICAgaWYgKHggPiBwcmV2WCkge1xuICAgICAgeC0tO1xuICAgICAgb3V0LnB1c2goeyBvcDogXCJkZWxcIiwgYTogeCwgdGV4dDogYVt4XSBhcyBzdHJpbmcgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHktLTtcbiAgICAgIG91dC5wdXNoKHsgb3A6IFwiYWRkXCIsIGI6IHksIHRleHQ6IGJbeV0gYXMgc3RyaW5nIH0pO1xuICAgIH1cbiAgfVxuICBvdXQucmV2ZXJzZSgpO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogRXZlcnkgbGluZSBhcyBvbmUgcmVwbGFjZW1lbnQg4oCUIHRoZSBob25lc3QgYW5zd2VyIHdoZW4gTXllcnMgZ2l2ZXMgdXAuICovXG5mdW5jdGlvbiBjb2Fyc2VMaW5lcyhhOiBzdHJpbmdbXSwgYjogc3RyaW5nW10pOiBEaWZmTGluZVtdIHtcbiAgcmV0dXJuIFtcbiAgICAuLi5hLm1hcCgodGV4dCwgaSkgPT4gKHsgb3A6IFwiZGVsXCIgYXMgY29uc3QsIGE6IGksIHRleHQgfSkpLFxuICAgIC4uLmIubWFwKCh0ZXh0LCBpKSA9PiAoeyBvcDogXCJhZGRcIiBhcyBjb25zdCwgYjogaSwgdGV4dCB9KSksXG4gIF07XG59XG5cbi8qKiBHcm91cCB0aGUgbGluZSBvcHMgaW50byBjb250aWd1b3VzIGh1bmtzLCBudW1iZXJlZCBmcm9tIDEuICovXG5mdW5jdGlvbiBjb2xsZWN0KGxpbmVzOiBEaWZmTGluZVtdKTogRGlmZkh1bmtbXSB7XG4gIGNvbnN0IGh1bmtzOiBEaWZmSHVua1tdID0gW107XG4gIGxldCBpID0gMDtcbiAgbGV0IGlkID0gMTtcbiAgd2hpbGUgKGkgPCBsaW5lcy5sZW5ndGgpIHtcbiAgICBpZiAoKGxpbmVzW2ldIGFzIERpZmZMaW5lKS5vcCA9PT0gXCJzYW1lXCIpIHtcbiAgICAgIGkrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBzdGFydCA9IGk7XG4gICAgd2hpbGUgKGkgPCBsaW5lcy5sZW5ndGggJiYgKGxpbmVzW2ldIGFzIERpZmZMaW5lKS5vcCAhPT0gXCJzYW1lXCIpIGkrKztcbiAgICBjb25zdCBydW4gPSBsaW5lcy5zbGljZShzdGFydCwgaSk7XG4gICAgY29uc3QgZGVsID0gcnVuLmZpbHRlcigobCkgPT4gbC5vcCA9PT0gXCJkZWxcIik7XG4gICAgY29uc3QgYWRkID0gcnVuLmZpbHRlcigobCkgPT4gbC5vcCA9PT0gXCJhZGRcIik7XG4gICAgLy8gV2hlcmUgdGhlIGh1bmsgc2l0cyBpbiBlYWNoIHRleHQ6IHRoZSBpbmRleCBvZiB0aGUgZmlyc3QgbGluZSBpdCB0b3VjaGVzLFxuICAgIC8vIGFuZCBmb3IgYSBwdXJlIGluc2VydGlvbiwgdGhlIHBvaW50IGl0IGlzIGluc2VydGVkIEFULlxuICAgIGNvbnN0IGFGcm9tID0gZGVsLmxlbmd0aCA/ICgoZGVsWzBdIGFzIERpZmZMaW5lKS5hIGFzIG51bWJlcikgOiBuZXh0SW5kZXgobGluZXMsIHN0YXJ0LCBcImFcIik7XG4gICAgY29uc3QgYkZyb20gPSBhZGQubGVuZ3RoID8gKChhZGRbMF0gYXMgRGlmZkxpbmUpLmIgYXMgbnVtYmVyKSA6IG5leHRJbmRleChsaW5lcywgc3RhcnQsIFwiYlwiKTtcbiAgICBodW5rcy5wdXNoKHtcbiAgICAgIGlkOiBpZCsrLFxuICAgICAgYUZyb20sXG4gICAgICBhVG86IGFGcm9tICsgZGVsLmxlbmd0aCxcbiAgICAgIGJGcm9tLFxuICAgICAgYlRvOiBiRnJvbSArIGFkZC5sZW5ndGgsXG4gICAgICBkZWw6IGRlbC5tYXAoKGwpID0+IGwudGV4dCksXG4gICAgICBhZGQ6IGFkZC5tYXAoKGwpID0+IGwudGV4dCksXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIGh1bmtzO1xufVxuXG4vKipcbiAqIFRoZSBpbmRleCBhIHB1cmUgaW5zZXJ0aW9uIG9yIGRlbGV0aW9uIHNpdHMgYXQ6IHRoZSBsaW5lIG51bWJlciBvZiB0aGUgbmV4dFxuICogYHNhbWVgIGxpbmUgb24gdGhhdCBzaWRlLCBvciB0aGUgZW5kIG9mIHRoYXQgdGV4dCB3aGVuIHRoZXJlIGlzIG5vbmUuXG4gKi9cbmZ1bmN0aW9uIG5leHRJbmRleChsaW5lczogRGlmZkxpbmVbXSwgZnJvbTogbnVtYmVyLCBzaWRlOiBcImFcIiB8IFwiYlwiKTogbnVtYmVyIHtcbiAgZm9yIChsZXQgaSA9IGZyb207IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGF0ID0gKGxpbmVzW2ldIGFzIERpZmZMaW5lKVtzaWRlXTtcbiAgICBpZiAoYXQgIT09IHVuZGVmaW5lZCkgcmV0dXJuIGF0O1xuICB9XG4gIGxldCBsYXN0ID0gLTE7XG4gIGZvciAoY29uc3QgbCBvZiBsaW5lcykge1xuICAgIGNvbnN0IGF0ID0gbFtzaWRlXTtcbiAgICBpZiAoYXQgIT09IHVuZGVmaW5lZCAmJiBhdCA+IGxhc3QpIGxhc3QgPSBhdDtcbiAgfVxuICByZXR1cm4gbGFzdCArIDE7XG59XG5cbi8qKiBXb3Jkcywgd2hpdGVzcGFjZSBydW5zIGFuZCBwdW5jdHVhdGlvbiBydW5zLCBrZXB0IHNlcGFyYXRlIHNvIHNwYW5zIGFsaWduLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdvcmRzKGxpbmU6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIGxpbmUubWF0Y2goL1xccyt8W1xccHtMfVxccHtOfV9dK3xbXlxcc1xccHtMfVxccHtOfV9dKy9ndSkgPz8gW107XG59XG5cbi8qKiBUaGUgd29yZC1sZXZlbCBkaWZmIG9mIG9uZSBsaW5lIHBhaXIsIGFzIHNwYW5zIG92ZXIgZWFjaCBzaWRlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZmluZShiZWZvcmU6IHN0cmluZywgYWZ0ZXI6IHN0cmluZyk6IHsgZGVsOiBEaWZmU3BhbltdOyBhZGQ6IERpZmZTcGFuW10gfSB7XG4gIGNvbnN0IGEgPSB3b3JkcyhiZWZvcmUpO1xuICBjb25zdCBiID0gd29yZHMoYWZ0ZXIpO1xuICBjb25zdCB0cmFjZSA9IG15ZXJzVHJhY2UoYSwgYik7XG4gIGlmICghdHJhY2UpXG4gICAgcmV0dXJuIHsgZGVsOiBbeyB0ZXh0OiBiZWZvcmUsIGNoYW5nZWQ6IHRydWUgfV0sIGFkZDogW3sgdGV4dDogYWZ0ZXIsIGNoYW5nZWQ6IHRydWUgfV0gfTtcbiAgY29uc3Qgb3BzID0gYmFja3RyYWNrKGEsIGIsIHRyYWNlKTtcbiAgY29uc3QgZGVsOiBEaWZmU3BhbltdID0gW107XG4gIGNvbnN0IGFkZDogRGlmZlNwYW5bXSA9IFtdO1xuICBmb3IgKGNvbnN0IG9wIG9mIG9wcykge1xuICAgIGlmIChvcC5vcCA9PT0gXCJzYW1lXCIpIHtcbiAgICAgIHB1c2goZGVsLCBvcC50ZXh0LCBmYWxzZSk7XG4gICAgICBwdXNoKGFkZCwgb3AudGV4dCwgZmFsc2UpO1xuICAgIH0gZWxzZSBpZiAob3Aub3AgPT09IFwiZGVsXCIpIHB1c2goZGVsLCBvcC50ZXh0LCB0cnVlKTtcbiAgICBlbHNlIHB1c2goYWRkLCBvcC50ZXh0LCB0cnVlKTtcbiAgfVxuICByZXR1cm4geyBkZWwsIGFkZCB9O1xufVxuXG4vKiogQXBwZW5kLCBtZXJnaW5nIGludG8gdGhlIHByZXZpb3VzIHNwYW4gd2hlbiBpdCBjYXJyaWVzIHRoZSBzYW1lIHZlcmRpY3QuICovXG5mdW5jdGlvbiBwdXNoKHNwYW5zOiBEaWZmU3BhbltdLCB0ZXh0OiBzdHJpbmcsIGNoYW5nZWQ6IGJvb2xlYW4pOiB2b2lkIHtcbiAgY29uc3QgbGFzdCA9IHNwYW5zW3NwYW5zLmxlbmd0aCAtIDFdO1xuICBpZiAobGFzdCAmJiBsYXN0LmNoYW5nZWQgPT09IGNoYW5nZWQpIGxhc3QudGV4dCArPSB0ZXh0O1xuICBlbHNlIHNwYW5zLnB1c2goeyB0ZXh0LCBjaGFuZ2VkIH0pO1xufVxuXG4vKipcbiAqIFJlZmluZSBhIGh1bmsncyBsaW5lcyB3aGVuIHRoZXkgY2FuIGJlIFBBSVJFRC4gQSBodW5rIHJlcGxhY2luZyB0aHJlZSBsaW5lc1xuICogd2l0aCB0aHJlZSBpcyBwYWlyZWQgbGluZSBieSBsaW5lOyBhIDEtZm9yLW1hbnkgaHVuayBpcyBub3QsIGFuZCBnZXRzIG5vXG4gKiBzcGFucyByYXRoZXIgdGhhbiBhbiBhcmJpdHJhcnkgcGFpcmluZyDigJQgc2hvd2luZyBhIHdvcmQtbGV2ZWwgZGlmZiBhZ2FpbnN0XG4gKiB0aGUgd3JvbmcgbGluZSBpcyB3b3JzZSB0aGFuIHNob3dpbmcgbm9uZS5cbiAqL1xuZnVuY3Rpb24gcmVmaW5lSHVuayhsaW5lczogRGlmZkxpbmVbXSwgaHVuazogRGlmZkh1bmspOiB2b2lkIHtcbiAgaWYgKGh1bmsuZGVsLmxlbmd0aCAhPT0gaHVuay5hZGQubGVuZ3RoIHx8IGh1bmsuZGVsLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICBjb25zdCBkZWxzID0gbGluZXMuZmlsdGVyKChsKSA9PiBsLm9wID09PSBcImRlbFwiICYmIGluUmFuZ2UobC5hLCBodW5rLmFGcm9tLCBodW5rLmFUbykpO1xuICBjb25zdCBhZGRzID0gbGluZXMuZmlsdGVyKChsKSA9PiBsLm9wID09PSBcImFkZFwiICYmIGluUmFuZ2UobC5iLCBodW5rLmJGcm9tLCBodW5rLmJUbykpO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGRlbHMubGVuZ3RoICYmIGkgPCBhZGRzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgZCA9IGRlbHNbaV0gYXMgRGlmZkxpbmU7XG4gICAgY29uc3QgYWQgPSBhZGRzW2ldIGFzIERpZmZMaW5lO1xuICAgIGNvbnN0IHsgZGVsLCBhZGQgfSA9IHJlZmluZShkLnRleHQsIGFkLnRleHQpO1xuICAgIGQuc3BhbnMgPSBkZWw7XG4gICAgYWQuc3BhbnMgPSBhZGQ7XG4gIH1cbn1cblxuZnVuY3Rpb24gaW5SYW5nZShhdDogbnVtYmVyIHwgdW5kZWZpbmVkLCBmcm9tOiBudW1iZXIsIHRvOiBudW1iZXIpOiBib29sZWFuIHtcbiAgcmV0dXJuIGF0ICE9PSB1bmRlZmluZWQgJiYgYXQgPj0gZnJvbSAmJiBhdCA8IHRvO1xufVxuXG4vKiogQ29tcGFyZSB0d28gdGV4dHMgYnkgbGluZSwgcmVmaW5lZCBieSB3b3JkIGluc2lkZSBwYWlyZWQgbGluZXMuICovXG5leHBvcnQgZnVuY3Rpb24gZGlmZlRleHQoYmVmb3JlOiBzdHJpbmcsIGFmdGVyOiBzdHJpbmcpOiBEaWZmIHtcbiAgaWYgKGJlZm9yZSA9PT0gYWZ0ZXIpIHtcbiAgICBjb25zdCBsaW5lcyA9IHNwbGl0TGluZXMoYmVmb3JlKS5tYXAoKHRleHQsIGkpID0+ICh7XG4gICAgICBvcDogXCJzYW1lXCIgYXMgY29uc3QsXG4gICAgICBhOiBpLFxuICAgICAgYjogaSxcbiAgICAgIHRleHQsXG4gICAgfSkpO1xuICAgIHJldHVybiB7IGxpbmVzLCBodW5rczogW10sIHNhbWU6IHRydWUsIGNvYXJzZTogZmFsc2UgfTtcbiAgfVxuICBjb25zdCBhID0gc3BsaXRMaW5lcyhiZWZvcmUpO1xuICBjb25zdCBiID0gc3BsaXRMaW5lcyhhZnRlcik7XG4gIGNvbnN0IHRyYWNlID0gbXllcnNUcmFjZShhLCBiKTtcbiAgY29uc3QgY29hcnNlID0gdHJhY2UgPT09IG51bGw7XG4gIGNvbnN0IGxpbmVzID0gdHJhY2UgPyBiYWNrdHJhY2soYSwgYiwgdHJhY2UpIDogY29hcnNlTGluZXMoYSwgYik7XG4gIGNvbnN0IGh1bmtzID0gY29sbGVjdChsaW5lcyk7XG4gIGZvciAoY29uc3QgaCBvZiBodW5rcykgcmVmaW5lSHVuayhsaW5lcywgaCk7XG4gIHJldHVybiB7IGxpbmVzLCBodW5rcywgc2FtZTogZmFsc2UsIGNvYXJzZSB9O1xufVxuXG4vKipcbiAqIFRha2UgaHVua3MgZnJvbSB0aGUgcmlnaHQgc2lkZSBpbnRvIHRoZSBsZWZ0LiBgdGFrZWAgaXMgdGhlIGlkcyB0byBhcHBseTtcbiAqIGV2ZXJ5IGh1bmsgbm90IG5hbWVkIGlzIGxlZnQgYXMgdGhlIGxlZnQgc2lkZSBoYXMgaXQuXG4gKlxuICog4puUIEFQUExJRUQgQkFDSyBUTyBGUk9OVCwgc28gYW4gZWFybGllciBodW5rJ3MgbGluZSBudW1iZXJzIGFyZSBzdGlsbCB0aGVcbiAqIG9uZXMgdGhlIGRpZmYgcmVwb3J0ZWQgd2hlbiBpdCBpcyByZWFjaGVkLiBBcHBseWluZyBmcm9udCB0byBiYWNrIHdvdWxkXG4gKiBzaGlmdCBldmVyeSBsYXRlciBodW5rIGJ5IHRoZSBzaXplIG9mIHRoZSBjaGFuZ2UganVzdCBtYWRlIOKAlCB0aGUgY2xhc3NpYyB3YXlcbiAqIGEgbXVsdGktaHVuayBtZXJnZSBsYW5kcyBpdHMgbGFzdCBodW5rIGluIHRoZSB3cm9uZyBwbGFjZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5SHVua3MoYmVmb3JlOiBzdHJpbmcsIGh1bmtzOiBEaWZmSHVua1tdLCB0YWtlOiBudW1iZXJbXSk6IHN0cmluZyB7XG4gIGNvbnN0IHdhbnRlZCA9IG5ldyBTZXQodGFrZSk7XG4gIGNvbnN0IGNob3NlbiA9IGh1bmtzLmZpbHRlcigoaCkgPT4gd2FudGVkLmhhcyhoLmlkKSkuc29ydCgoeCwgeSkgPT4geS5hRnJvbSAtIHguYUZyb20pO1xuICBjb25zdCBsaW5lcyA9IHNwbGl0TGluZXMoYmVmb3JlKTtcbiAgZm9yIChjb25zdCBoIG9mIGNob3NlbikgbGluZXMuc3BsaWNlKGguYUZyb20sIGguYVRvIC0gaC5hRnJvbSwgLi4uaC5hZGQpO1xuICByZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cblxuLyoqIFVuaWZpZWQtZGlmZiB0ZXh0LCBmb3IgdGhlIGFnZW50J3MgYGRpZmZgIHZlcmIuIGBjb250ZXh0YCBsaW5lcyBlaXRoZXIgc2lkZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1bmlmaWVkKFxuICBkaWZmOiBEaWZmLFxuICBvcHRzOiB7IGZyb206IHN0cmluZzsgdG86IHN0cmluZzsgY29udGV4dD86IG51bWJlciB9ID0geyBmcm9tOiBcImFcIiwgdG86IFwiYlwiIH0sXG4pOiBzdHJpbmcge1xuICBpZiAoZGlmZi5zYW1lKSByZXR1cm4gXCJcIjtcbiAgY29uc3QgY29udGV4dCA9IG9wdHMuY29udGV4dCA/PyAzO1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW2AtLS0gJHtvcHRzLmZyb219YCwgYCsrKyAke29wdHMudG99YF07XG4gIC8vIEh1bmtzIGNsb3NlciB0b2dldGhlciB0aGFuIDLDlyBjb250ZXh0IHNoYXJlIG9uZSBoZWFkZXIsIHRoZSB3YXkgZXZlcnlcbiAgLy8gb3RoZXIgZGlmZiB0b29sIGpvaW5zIHRoZW0g4oCUIG90aGVyd2lzZSB0aGUgY29udGV4dCBsaW5lcyBwcmludCB0d2ljZS5cbiAgY29uc3QgZ3JvdXBzOiBEaWZmSHVua1tdW10gPSBbXTtcbiAgZm9yIChjb25zdCBoIG9mIGRpZmYuaHVua3MpIHtcbiAgICBjb25zdCBsYXN0ID0gZ3JvdXBzW2dyb3Vwcy5sZW5ndGggLSAxXTtcbiAgICBjb25zdCBwcmV2ID0gbGFzdD8uW2xhc3QubGVuZ3RoIC0gMV07XG4gICAgaWYgKHByZXYgJiYgaC5hRnJvbSAtIHByZXYuYVRvIDw9IGNvbnRleHQgKiAyKSAobGFzdCBhcyBEaWZmSHVua1tdKS5wdXNoKGgpO1xuICAgIGVsc2UgZ3JvdXBzLnB1c2goW2hdKTtcbiAgfVxuICBjb25zdCBhID0gc3BsaXRMaW5lcyhzaWRlVGV4dChkaWZmLCBcImFcIikpO1xuICBjb25zdCBiID0gc3BsaXRMaW5lcyhzaWRlVGV4dChkaWZmLCBcImJcIikpO1xuICBmb3IgKGNvbnN0IGdyb3VwIG9mIGdyb3Vwcykge1xuICAgIGNvbnN0IGZpcnN0ID0gZ3JvdXBbMF0gYXMgRGlmZkh1bms7XG4gICAgY29uc3QgbGFzdCA9IGdyb3VwW2dyb3VwLmxlbmd0aCAtIDFdIGFzIERpZmZIdW5rO1xuICAgIGNvbnN0IGFTdGFydCA9IE1hdGgubWF4KDAsIGZpcnN0LmFGcm9tIC0gY29udGV4dCk7XG4gICAgY29uc3QgYUVuZCA9IE1hdGgubWluKGEubGVuZ3RoLCBsYXN0LmFUbyArIGNvbnRleHQpO1xuICAgIGNvbnN0IGJTdGFydCA9IE1hdGgubWF4KDAsIGZpcnN0LmJGcm9tIC0gY29udGV4dCk7XG4gICAgY29uc3QgYkVuZCA9IE1hdGgubWluKGIubGVuZ3RoLCBsYXN0LmJUbyArIGNvbnRleHQpO1xuICAgIG91dC5wdXNoKGBAQCAtJHthU3RhcnQgKyAxfSwke2FFbmQgLSBhU3RhcnR9ICske2JTdGFydCArIDF9LCR7YkVuZCAtIGJTdGFydH0gQEBgKTtcbiAgICBsZXQgYXQgPSBhU3RhcnQ7XG4gICAgZm9yIChjb25zdCBoIG9mIGdyb3VwKSB7XG4gICAgICBmb3IgKDsgYXQgPCBoLmFGcm9tOyBhdCsrKSBvdXQucHVzaChgICR7YVthdF19YCk7XG4gICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgaC5kZWwpIG91dC5wdXNoKGAtJHtsaW5lfWApO1xuICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGguYWRkKSBvdXQucHVzaChgKyR7bGluZX1gKTtcbiAgICAgIGF0ID0gaC5hVG87XG4gICAgfVxuICAgIGZvciAoOyBhdCA8IGFFbmQ7IGF0KyspIG91dC5wdXNoKGAgJHthW2F0XX1gKTtcbiAgfVxuICByZXR1cm4gYCR7b3V0LmpvaW4oXCJcXG5cIil9XFxuYDtcbn1cblxuLyoqIFJlYnVpbGQgb25lIHNpZGUncyB0ZXh0IGZyb20gdGhlIGxpbmUgb3BzIOKAlCB1c2VkIGJ5IGB1bmlmaWVkYCBmb3IgY29udGV4dC4gKi9cbmZ1bmN0aW9uIHNpZGVUZXh0KGRpZmY6IERpZmYsIHNpZGU6IFwiYVwiIHwgXCJiXCIpOiBzdHJpbmcge1xuICBjb25zdCBza2lwID0gc2lkZSA9PT0gXCJhXCIgPyBcImFkZFwiIDogXCJkZWxcIjtcbiAgcmV0dXJuIGRpZmYubGluZXNcbiAgICAuZmlsdGVyKChsKSA9PiBsLm9wICE9PSBza2lwKVxuICAgIC5tYXAoKGwpID0+IGwudGV4dClcbiAgICAuam9pbihcIlxcblwiKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKipcbiAqIFRoZSBzbWFsbGVzdCBiZWF0IHRoaXMgbW9kdWxlIHdpbGwgaGFuZCBiYWNrLCBpbiBtcyDigJQgdGhlIEZMT09SIGhhbGYgb2YgdGhlXG4gKiBjbGFtcCB3aG9zZSBjZWlsaW5nIGlzIGBpZGxlVGltZW91dCAvIDJgLlxuICpcbiAqIOKblCBJVCBFWElTVFMgQkVDQVVTRSBgaW50T3JgIFBBUlNFUyBXSVRIIGBwYXJzZUludGAsIEFORCBgcGFyc2VJbnRgIElTIExFTklFTlRcbiAqIFdIRVJFIElUIE1BVFRFUlMgTU9TVC4gYGludE9yYCBmYWxscyBiYWNrIHNhZmVseSBvbiBldmVyeXRoaW5nIHRoYXQgTE9PS1NcbiAqIGhvc3RpbGUg4oCUIGBcIlwiYCwgYFwiMFwiYCwgYFwiLTFcImAsIGBcImFiY1wiYCwgYFwiTmFOXCJgLCBgXCJJbmZpbml0eVwiYCBhbGwgdGFrZSB0aGVcbiAqIGZhbGxiYWNrIOKAlCBhbmQgdGhlbiByZWFkcyBgXCIxZTlcImAsIHRoZSBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXRcbiAqIGh1Z2VcIiwgYXMgKioxKiouIE1FQVNVUkVEIGF0IGdyYXBldmluZSdzIFBoYXNlIDYgcmVwYWlyLCBiZWZvcmUgdGhpcyBmbG9vcjpcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTFlOWAgcHV0IH41Mjgga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0VcbiAqIGNsaWVudCBpbiA1MjggbXMuIGBcIjMuOVwiYCBnaXZlcyAzIG1zIGFuZCBgXCI1YWJjXCJgIGdpdmVzIDUgbXMgdGhlIHNhbWUgd2F5LlxuICogQSBrbm9iIHdob3NlIGZhc3Rlc3Qgc2V0dGluZyBpcyBzcGVsbGVkIGxpa2UgaXRzIHNsb3dlc3QgaXMgYSBmbG9vZC5cbiAqXG4gKiDimqAgKipUSEUgRkxPT1IgSVMgSEVSRSBBTkQgTk9UIElOIGBpbnRPcmAg4oCUIHRoYXQgaXMgdGhlIHJ1bGluZywgbm90IGFuXG4gKiBhY2NpZGVudCBvZiB3aGVyZSBpdCB3YXMgZWFzeSB0byB3cml0ZSoqIChENzYpLiBgaW50T3JgIGlzIHRoZSBnZW5lcmFsIHBhcnNlclxuICogYmVoaW5kIGV2ZXJ5IGVudiBrbm9iIGluIHRoZSBraXQ7IHRoZXJlIGlzIG5vIHNpbmdsZSByb3N0ZXItY29ycmVjdCBtaW5pbXVtXG4gKiBmb3IgXCJhIHBvc2l0aXZlIGludGVnZXJcIiwgYW5kIHRpZ2h0ZW5pbmcgaXRzIFBBUlNFIChyZWplY3RpbmcgYDFlOWAgb3V0cmlnaHQpXG4gKiB3b3VsZCBjaGFuZ2Ugd2hhdCBldmVyeSBvdGhlciBrbm9iIGFjY2VwdHMsIHNpbGVudGx5LCBmb3IgdmFsdWVzIG5vYm9keSBoYXNcbiAqIGF1ZGl0ZWQuIGBoZWFydGJlYXRNc2AgYWxyZWFkeSBvd25zIG9uZSBlbmQgb2YgdGhpcyBpbnZhcmlhbnQsIGFuZCA1MDAgd2FzXG4gKiBhbHJlYWR5IHdyaXR0ZW4gaW50byBpdCBhcyB0aGUgc21hbGxlc3QgY2VpbGluZyBpdCB3b3VsZCBjb21wdXRlLiBUaGUgZmxvb3JcbiAqIGJlbG9uZ3MgYmVzaWRlIHRoZSBjZWlsaW5nLCB3aGVyZSB0aGUgcXVhbnRpdHkgaXMga25vd24uXG4gKi9cbmV4cG9ydCBjb25zdCBNSU5fSEVBUlRCRUFUX01TID0gNTAwO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4g4pqgIGBwYXJzZUludGAgc2VtYW50aWNzOiBgXCIxZTlcImBcbiAqICBpcyAxIGFuZCBgXCI1YWJjXCJgIGlzIDUuIEFueSBjYWxsZXIgd2l0aCBhIGtub3duIHNhZmUgbWluaW11bSBtdXN0IGNsYW1wIOKAlFxuICogIHNlZSBgTUlOX0hFQVJUQkVBVF9NU2AuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqIFRoZSBzZXJ2ZXIncyBgaWRsZVRpbWVvdXRgLCBpbiBTRUNPTkRTLCBjbGFtcGVkIHRvIHdoYXQgQnVuIGFjY2VwdHMuICovXG5leHBvcnQgZnVuY3Rpb24gaWRsZVRpbWVvdXRTZWMocmF3Pzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjayA9IE1BWF9JRExFX1RJTUVPVVRfU0VDKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKE1BWF9JRExFX1RJTUVPVVRfU0VDLCBpbnRPcihyYXcsIGZhbGxiYWNrKSkpO1xufVxuXG4vKipcbiAqIFRoZSBTU0UgaGVhcnRiZWF0LCBpbiBtcywgQ0xBTVBFRCBBVCBCT1RIIEVORFM6IG5ldmVyIGFib3ZlIGhhbGYgdGhlIGlkbGVcbiAqIHRpbWVvdXQsIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiBUaGUgY2VpbGluZyBpcyBhc3Ryb2xhYmUncywgYW5kIHRoZSBjZW5zdXMgbmFtZWQgaXQgY29udmVyZ2VuY2UgdGFyZ2V0ICM0OlxuICogdGhlIG90aGVyIGRhZW1vbnMgaGFyZC1jb2RlIDE1IHMgYWdhaW5zdCAyNTUgcyBhbmQgd3JpdGUgdGhlIHJlbGF0aW9uc2hpcFxuICogb25seSBpbiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBFbmZvcmNpbmdcbiAqIGBoZWFydGJlYXQgPD0gaWRsZVRpbWVvdXQgLyAyYCBtYWtlcyB0aGUgaW52YXJpYW50IHRydWUgZm9yIEFOWSBjb25maWd1cmVkXG4gKiBwYWlyLCB3aGljaCBpcyBleGFjdGx5IHRoZSBpbnZhcmlhbnQgd2hvc2UgdmlvbGF0aW9uIGNhdXNlZCB0aGUgYnVnIGFib3ZlLlxuICpcbiAqIOKaoCBUaGUgZmxvb3IgY2Fubm90IGZpZ2h0IHRoZSBjZWlsaW5nOiB0aGUgY2VpbGluZyBleHByZXNzaW9uIGlzIGl0c2VsZlxuICogYE1hdGgubWF4KDUwMCwg4oCmKWAsIHNvIGl0IGlzIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYCBhbmQgdGhlIHR3b1xuICogY2xhbXBzIGNhbiBuZXZlciBjcm9zcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgY29uc3QgY2VpbGluZyA9IE1hdGgubWF4KE1JTl9IRUFSVEJFQVRfTVMsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKTtcbiAgcmV0dXJuIE1hdGgubWluKE1hdGgubWF4KGludE9yKHJhdywgZmFsbGJhY2spLCBNSU5fSEVBUlRCRUFUX01TKSwgY2VpbGluZyk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIHNjcmlwdG9yaXVtJ3MgY29ubmVjdGlvbi10aW1pbmcgY29uc3RhbnRzIOKAlCBUSEUgT05FIENPUFksIGltcG9ydGVkIGJ5IGJvdGhcbiAqIGhhbHZlcyAoYGNsaS50c2AncyB0YWlsIHdhdGNoZG9nLCBgc2VydmVyLnRzYCdzIFNTRSBoZWFydGJlYXQgYW5kIGlkbGVcbiAqIHRpbWVvdXQpLiBLaXQgdmVyZGljdCBgaGVhcnRiZWF0YDogU1VCSkVDVCDigJQgdGhlIHNlYW0gZXhpc3RzIGJlY2F1c2UgdGhlIENMSVxuICogYW5kIHRoZSBkYWVtb24gYXJlIHR3byBwcm9jZXNzZXMgdGhhdCBtdXN0IGFncmVlIG9uIG9uZSBpbnZhcmlhbnRcbiAqIChgaWRsZVRpbWVvdXQgPiBoZWFydGJlYXRgLCBgd2F0Y2hkb2cgPiBoZWFydGJlYXRgKSwgYW5kIG5laXRoZXIgbWF5IGltcG9ydFxuICogdGhlIG90aGVyLlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgYGRpc3QvY2xpLmpzYCBkcmFncyB0aGUgc2VydmVyIGdyYXBoIGFuZCB0aGUgc2VhbSBjbG9zZXMuXG4gKi9cblxuaW1wb3J0IHtcbiAgREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKiBCdW4ncyBtYXhpbXVtOiBhIGhlbGQgU1NFIHRhaWwgbXVzdCBvdXRsaXZlIEJ1bidzIDEwIHMgZGVmYXVsdC4gKi9cbmV4cG9ydCBjb25zdCBJRExFX1RJTUVPVVRfU0VDID0gTUFYX0lETEVfVElNRU9VVF9TRUM7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdC4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gREVGQVVMVF9IRUFSVEJFQVRfTVM7XG5cbi8qKiBUaGUgdGFpbCB3YXRjaGRvZzogdGhyZWUgbWlzc2VkIGJlYXRzIG9mIFRISVMgZGFlbW9uJ3MgaGVhcnRiZWF0LCBkZXJpdmVkLiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUyk7XG4iLAogICAgIi8qKlxuICogVGhlIE5BVElWRSBmaWxlIHBpY2tlciDigJQgdGhlIGFmZm9yZGFuY2UgYSB3ZWIgcGFnZSBjYW5ub3QgaGF2ZS5cbiAqXG4gKiBBIGJyb3dzZXIncyBvd24gYDxpbnB1dCB0eXBlPVwiZmlsZVwiPmAgYW5kIGBzaG93T3BlbkZpbGVQaWNrZXIoKWAgYm90aCBoYW5kXG4gKiBiYWNrIGZpbGUgQ09OVEVOVCBhbmQgYSBuYW1lLCBuZXZlciBhIHBhdGggKGFuZCBCcmF2ZSwgQ29sZSdzIGJyb3dzZXIsXG4gKiBkaXNhYmxlcyB0aGUgRmlsZSBTeXN0ZW0gQWNjZXNzIEFQSSBvdXRyaWdodCkuIEEgY29weSBpcyBhbGwgYSBwYWdlIGNhbiBkb1xuICogd2l0aCB0aGF0LCB3aGljaCBpcyBleGFjdGx5IHdoYXQgYSBkcm9wIGFscmVhZHkgZG9lcyAoRTIzKS4gQnV0IHNjcmlwdG9yaXVtJ3NcbiAqIGRhZW1vbiBpcyBhIExPQ0FMIFBST0NFU1M6IGl0IGNhbiBhc2sgdGhlIE9TIGZvciBpdHMgb3duIG9wZW4gZGlhbG9nIGFuZCBnZXRcbiAqIGJhY2sgYSByZWFsIGZpbGVzeXN0ZW0gcGF0aCDigJQgc28gXCJDaG9vc2XigKZcIiBsaW5rcyB0aGUgcmVhbCBmaWxlIChFMSkgaW5zdGVhZFxuICogb2YgY29weWluZyBpdC5cbiAqXG4gKiBFdmVyeXRoaW5nIGhlcmUgaXMgcHVyZTogd2hpY2ggYXJndiB0byBydW4sIGFuZCBob3cgdG8gcmVhZCB3aGF0IGl0IHByaW50ZWQuXG4gKiBUaGUgc3Bhd25pbmcgKGFuZCB0aGUgb25lLWF0LWEtdGltZSBydWxlKSBpcyB0aGUgZGFlbW9uJ3MuXG4gKi9cblxuZXhwb3J0IHR5cGUgUGlja0tpbmQgPSBcImZpbGVcIiB8IFwiZm9sZGVyXCI7XG5cbi8qKiBBbiBBcHBsZVNjcmlwdCB0aGF0IHB1dHMgb25lIFBPU0lYIHBhdGggcGVyIGxpbmUgb24gc3Rkb3V0LiAqL1xuZnVuY3Rpb24gYXBwbGVTY3JpcHQoa2luZDogUGlja0tpbmQsIHByb21wdDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcXVvdGVkID0gcHJvbXB0LnJlcGxhY2UoL1tcIlxcXFxdL2csIFwiXCIpO1xuICBjb25zdCBjaG9vc2UgPVxuICAgIGtpbmQgPT09IFwiZmlsZVwiXG4gICAgICA/IGBjaG9vc2UgZmlsZSB3aXRoIHByb21wdCBcIiR7cXVvdGVkfVwiIHdpdGggbXVsdGlwbGUgc2VsZWN0aW9ucyBhbGxvd2VkYFxuICAgICAgOiBge2Nob29zZSBmb2xkZXIgd2l0aCBwcm9tcHQgXCIke3F1b3RlZH1cIn1gO1xuICByZXR1cm4gW1xuICAgIGBzZXQgY2hvc2VuIHRvICR7Y2hvb3NlfWAsXG4gICAgJ3NldCBvdXQgdG8gXCJcIicsXG4gICAgXCJyZXBlYXQgd2l0aCBmIGluIGNob3NlblwiLFxuICAgIFwic2V0IG91dCB0byBvdXQgJiBQT1NJWCBwYXRoIG9mIGYgJiBsaW5lZmVlZFwiLFxuICAgIFwiZW5kIHJlcGVhdFwiLFxuICAgIFwicmV0dXJuIG91dFwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKlxuICogVGhlIGNvbW1hbmQgdGhhdCBvcGVucyB0aGUgT1MncyBwaWNrZXIsIG9yIG51bGwgd2hlcmUgdGhlcmUgaXMgbm9uZSDigJQgdGhlXG4gKiBjYWxsZXIgdGhlbiBzYXlzIHNvIHJhdGhlciB0aGFuIGhhbmdpbmcgb24gYSBkaWFsb2cgbm9ib2R5IHdpbGwgc2VlLlxuICogYHplbml0eUF0YCBpcyB3aGVyZSBhIExpbnV4IHplbml0eSB3YXMgZm91bmQgKHRoZSBjYWxsZXIgbG9va3MgaXQgdXApLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGlja2VyQ29tbWFuZChcbiAgcGxhdGZvcm06IHN0cmluZyxcbiAga2luZDogUGlja0tpbmQsXG4gIHByb21wdDogc3RyaW5nLFxuICB6ZW5pdHlBdD86IHN0cmluZyB8IG51bGwsXG4pOiBzdHJpbmdbXSB8IG51bGwge1xuICBpZiAocGxhdGZvcm0gPT09IFwiZGFyd2luXCIpIHJldHVybiBbXCJvc2FzY3JpcHRcIiwgXCItZVwiLCBhcHBsZVNjcmlwdChraW5kLCBwcm9tcHQpXTtcbiAgaWYgKHBsYXRmb3JtID09PSBcIndpbjMyXCIpIHJldHVybiBudWxsOyAvLyBQb3dlclNoZWxsJ3MgZGlhbG9nIG5lZWRzIGEgU1RBIGhvc3Q7IG5vdCB3cml0dGVuIHVudGlsIGFza2VkIGZvclxuICBpZiAoemVuaXR5QXQpXG4gICAgcmV0dXJuIFtcbiAgICAgIHplbml0eUF0LFxuICAgICAgXCItLWZpbGUtc2VsZWN0aW9uXCIsXG4gICAgICAuLi4oa2luZCA9PT0gXCJmb2xkZXJcIiA/IFtcIi0tZGlyZWN0b3J5XCJdIDogW1wiLS1tdWx0aXBsZVwiXSksXG4gICAgICBcIi0tc2VwYXJhdG9yPVxcblwiLFxuICAgICAgYC0tdGl0bGU9JHtwcm9tcHR9YCxcbiAgICBdO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFRoZSBwYXRocyBhIHBpY2tlciBwcmludGVkOiBvbmUgcGVyIGxpbmUsIGJsYW5rcyBkcm9wcGVkLCBvcmRlciBrZXB0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUGlja2VyT3V0cHV0KHN0ZG91dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gc3Rkb3V0XG4gICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgLm1hcCgobCkgPT4gbC50cmltKCkpXG4gICAgLmZpbHRlcigobCkgPT4gbC5zdGFydHNXaXRoKFwiL1wiKSlcbiAgICAubWFwKChsKSA9PiAobC5sZW5ndGggPiAxICYmIGwuZW5kc1dpdGgoXCIvXCIpID8gbC5zbGljZSgwLCAtMSkgOiBsKSk7XG59XG5cbi8qKiBBIGNhbmNlbGxlZCBkaWFsb2cgaXMgbm90IGEgZmFpbHVyZSDigJQgb3Nhc2NyaXB0IGV4aXRzIDEsIHplbml0eSBleGl0cyAxLCBhbmQgbm90aGluZyB3YXMgY2hvc2VuLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdhc0NhbmNlbGxlZChleGl0Q29kZTogbnVtYmVyLCBzdGRvdXQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gZXhpdENvZGUgIT09IDAgJiYgcGFyc2VQaWNrZXJPdXRwdXQoc3Rkb3V0KS5sZW5ndGggPT09IDA7XG59XG4iLAogICAgIi8qKlxuICogVGhlIHNlc3Npb24g4oCUIHRoZSBkYWVtb24ncyBzdGF0ZSwgYW5kIHRoZSBvbmx5IGNvZGUgdGhhdCB3cml0ZXMgYSBmaWxlLlxuICpcbiAqIEU4J3Mgc2hhcGUsIHRoZSBob3VzZSdzIFwibWF0ZXJpYWxpemVkIHBhdGhcIiBwYXR0ZXJuOiB0aGUgZGFlbW9uIG93bnMgdGhlXG4gKiBzZXNzaW9uIChjb250ZXh0LCBkb2NzLCB2ZXJzaW9ucywgd2hpY2ggaXMgYWN0aXZlLCB0aGUgY2hhdCkgYW5kIHBlcnNpc3RzIGl0XG4gKiBhcyBgbWFuaWZlc3QuanNvbmA7IGV2ZXJ5IHZlcnNpb24ncyBURVhUIGlzIGEgZmlsZSBpbiB0aGUgc2Vzc2lvbiBmb2xkZXIsIHNvXG4gKiB0aGUgYWdlbnQgZWRpdHMgdmVyc2lvbnMgd2l0aCBpdHMgb3duIGZpbGUgdG9vbHMuXG4gKlxuICogICAgICRTQ1JJUFRPUklVTV9IT01FL3Nlc3Npb25zLzxzZXNzaW9uSWQ+L1xuICogICAgICAgbWFuaWZlc3QuanNvbiAgICAgICAgICAgICAgd3JpdHRlbiBhdG9taWNhbGx5LCBvbiBldmVyeSBjaGFuZ2VcbiAqICAgICAgIGRvY3MvPHNsdWc+L3YxLm1kLCB2Mi5tZCAgIG9uZSBmaWxlIHBlciB2ZXJzaW9uXG4gKlxuICogVGhlIHRocmVlIHdyaXRlIHJ1bGVzLCBlYWNoIGEgZGVjaXNpb24gcmF0aGVyIHRoYW4gYSBoYWJpdDpcbiAqXG4gKiAtICoqVGhlIG9yaWdpbmFsIGlzIHdyaXR0ZW4gT05MWSBieSBgc2F2ZWAqKiAoRTcpLiBPcGVuaW5nIGNvcGllcyBpdCB0byB2MTtcbiAqICAgbm90aGluZyBlbHNlIHRvdWNoZXMgaXQuXG4gKiAtICoqRXZlcnkgd3JpdGUgdGhpcyBtb2R1bGUgbWFrZXMgaXMgcmVtZW1iZXJlZCBieSBjb250ZW50IGhhc2gqKiAodGhlXG4gKiAgIGBvd25lZGAgbWFwKSBzbyB0aGUgd2F0Y2hlciBjYW4gdGVsbCB0aGUgZGFlbW9uJ3Mgb3duIHdyaXRlcyBmcm9tIGFueW9uZVxuICogICBlbHNlJ3MgKGludmVzdGlnYXRpb24gwqc1KS4gQSB3cml0ZSB0byB0aGUgQUNUSVZFIHZlcnNpb24gdGhhdCBpcyBub3Qgb3Vyc1xuICogICBpcyBhbiBFMiB2aW9sYXRpb24gdGhlIGRhZW1vbiBhbm5vdW5jZXMuXG4gKiAtICoqVGhlIGFnZW50IG5ldmVyIHdyaXRlcyB0aGUgYWN0aXZlIHZlcnNpb24qKiAoRTIpIOKAlCBlbmZvcmNlZCBzb2NpYWxseSBieVxuICogICBTS0lMTC5tZCBhbmQgZGV0ZWN0ZWQgaGVyZSwgbm90IHByZXZlbnRlZDogdGhlIGZpbGUgaXMgdGhlIGFnZW50J3MgbWVkaXVtLlxuICpcbiAqIE5vdGhpbmcgaGVyZSBrbm93cyBhYm91dCBzb2NrZXRzLCBIVFRQIG9yIHRoZSBldmVudCBsb2cuIFRoZSBkYWVtb24gY2FsbHMgYVxuICogbWV0aG9kLCBnZXRzIGEgcmVzdWx0LCBhbmQgZGVjaWRlcyB3aGF0IHRvIGJyb2FkY2FzdDsgdGhhdCBzcGxpdCBpcyB3aGF0XG4gKiBsZXRzIHRoZSB1bml0IGNlbGxzIGRyaXZlIHRoZSB3aG9sZSBtb2RlbCB3aXRoIGEgdGVtcCBob21lLlxuICovXG5cbmltcG9ydCB7XG4gIGNsb3NlU3luYyxcbiAgZXhpc3RzU3luYyxcbiAgbWtkaXJTeW5jLFxuICBvcGVuU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgcmVhZFN5bmMsXG4gIHJlYWxwYXRoU3luYyxcbiAgcmVuYW1lU3luYyxcbiAgcm1TeW5jLFxuICBzdGF0U3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGV4dG5hbWUsIGlzQWJzb2x1dGUsIGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB3cml0ZUZpbGVBdG9taWMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZGlzY292ZXJ5LnRzXCI7XG5pbXBvcnQgeyB0eXBlIEFuY2hvciwgYW5jaG9yT2YsIGZpbmRBbmNob3IgfSBmcm9tIFwiLi9hbmNob3JzXCI7XG5pbXBvcnQgeyBhcHBseUh1bmtzLCBkaWZmVGV4dCB9IGZyb20gXCIuL2RpZmZcIjtcbmltcG9ydCB7XG4gIGJvZHlMaW5lT2Zmc2V0LFxuICBidWlsZEJsb2NrLFxuICBndWVzc1R5cGUsXG4gIG1hdGNoZXNGaWx0ZXIsXG4gIHJlYWRNZXRhLFxuICBzZXRLZXksXG4gIHNwbGl0RnJvbnRtYXR0ZXIsXG4gIHN1bW1hcml6ZSxcbiAgdGl0bGVGcm9tQm9keSxcbiAgd2l0aEJsb2NrLFxufSBmcm9tIFwiLi9mcm9udG1hdHRlclwiO1xuaW1wb3J0IHsgdHlwZSBCdW5kbGVJbmRleCwgYnVpbGRHcmFwaCwgdHlwZSBSZXNvbHV0aW9uLCByZXNvbHZlVGFyZ2V0IH0gZnJvbSBcIi4vbGlua3NcIjtcbmltcG9ydCB0eXBlIHtcbiAgQ2hhdE1lc3NhZ2UsXG4gIENoYXRXaG8sXG4gIENvbnRleHRFbnRyeSxcbiAgRGlmZlBheWxvYWQsXG4gIERpZmZTaWRlLFxuICBEb2NNZXRhLFxuICBEb2NTdW1tYXJ5LFxuICBEb2NWaWV3LFxuICBHcmFwaFBheWxvYWQsXG4gIE1ldGFGaWx0ZXIsXG4gIE1vdmVQbGFuLFxuICBOb3RlLFxuICBQbGFjZWROb3RlLFxuICBQdWJsaWNTdGF0ZSxcbiAgU2VsZWN0aW9uLFxuICBUYXNrLFxuICBWZXJzaW9uLFxuICBWZXJzaW9uQXV0aG9yLFxufSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuaW1wb3J0IHtcbiAgRE9DX0VYVEVOU0lPTlMsXG4gIGRvY1BhdGhzLFxuICBlbnRyeUZvclBhdGgsXG4gIGZpbmROb2RlLFxuICBpc0RvY05hbWUsXG4gIGxvY2F0ZSxcbiAgTUlSUk9SX05PREVfQ0FQLFxuICBzY2FuVHJlZSxcbiAgdG9Qb3NpeCxcbn0gZnJvbSBcIi4vdHJlZVwiO1xuXG5leHBvcnQgY29uc3QgTUFOSUZFU1RfRk9STUFUID0gMTtcblxuLyoqIFRoZSBtb3N0IGRvY3VtZW50cyBvbmUgZnJvbnRtYXR0ZXIgc2NhbiByZWFkcy4gKi9cbmV4cG9ydCBjb25zdCBNRVRBX1NDQU5fQ0FQID0gNTAwO1xuLyoqIEEgZnJvbnRtYXR0ZXIgYmxvY2sgbGl2ZXMgYXQgdGhlIHRvcCBvZiBhIGZpbGU7IHRoaXMgaXMgaG93IG11Y2ggd2UgcmVhZCB0byBmaW5kIGl0LiAqL1xuY29uc3QgTUVUQV9IRUFEX0JZVEVTID0gODE5MjtcblxuLyoqIFRoZSBmaXJzdCA4IEtCIG9mIGEgZmlsZSwgYXMgdGV4dCDigJQgZW5vdWdoIGZvciBhbnkgZnJvbnRtYXR0ZXIgYmxvY2suICovXG5mdW5jdGlvbiByZWFkSGVhZChwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBsZXQgZmQ6IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBmZCA9IG9wZW5TeW5jKHBhdGgsIFwiclwiKTtcbiAgICBjb25zdCBidWYgPSBCdWZmZXIuYWxsb2MoTUVUQV9IRUFEX0JZVEVTKTtcbiAgICBjb25zdCByZWFkID0gcmVhZFN5bmMoZmQsIGJ1ZiwgMCwgTUVUQV9IRUFEX0JZVEVTLCAwKTtcbiAgICByZXR1cm4gYnVmLnN1YmFycmF5KDAsIHJlYWQpLnRvU3RyaW5nKFwidXRmOFwiKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFwiXCI7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKGZkICE9PSB1bmRlZmluZWQpIGNsb3NlU3luYyhmZCk7XG4gIH1cbn1cblxudHlwZSBEb2NSZWNvcmQgPSB7XG4gIHNsdWc6IHN0cmluZztcbiAgbmFtZTogc3RyaW5nO1xuICBvcmlnaW5hbDogc3RyaW5nO1xuICBlbnRyeUlkOiBzdHJpbmcgfCBudWxsO1xuICByZWw6IHN0cmluZyB8IG51bGw7XG4gIGV4dDogc3RyaW5nO1xuICB2ZXJzaW9uczogT21pdDxWZXJzaW9uLCBcInBhdGhcIj5bXTtcbiAgYWN0aXZlOiBudW1iZXI7XG4gIC8qKlxuICAgKiBUaGUgbmV4dCB2ZXJzaW9uIG51bWJlciB0byBoYW5kIG91dCDigJQgTU9OT1RPTklDLCBhbmQgbmV2ZXIgZGVyaXZlZCBmcm9tXG4gICAqIHRoZSB2ZXJzaW9ucyBzdGlsbCBwcmVzZW50IChFNDEpLiBOdW1iZXJpbmcgYXMgYG1heChleGlzdGluZykgKyAxYCB3YXNcbiAgICogY29ycmVjdCB3aGlsZSBub3RoaW5nIGNvdWxkIGJlIGRlbGV0ZWQ7IHRoZSBtb21lbnQgYSB2ZXJzaW9uIGNhbiBiZVxuICAgKiByZW1vdmVkLCBkZWxldGluZyB0aGUgaGlnaGVzdCBtYWtlcyB0aGUgbmV4dCBvbmUgUkVVU0UgaXRzIG51bWJlciwgYW5kIGFcbiAgICogYHYzYCBuYW1lZCBpbiBhIGNoYXQgbWVzc2FnZSwgYSBsb2cgbGluZSBvciBhbiBhZ2VudCdzIG5vdGVzIHdvdWxkIHRoZW5cbiAgICogcG9pbnQgYXQgYSBkaWZmZXJlbnQgZG9jdW1lbnQuIEFic2VudCBvbiBhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIEU0MSDigJRcbiAgICogYHRha2VWZXJzaW9uYCBkZXJpdmVzIGl0IG9uY2UsIGZyb20gdGhlIGhpZ2hlc3QgdGhhdCBldmVyIHdhcy5cbiAgICovXG4gIG5leHRWZXJzaW9uPzogbnVtYmVyO1xuICAvKiogTm90ZXMgb24gdGhpcyBkb2N1bWVudCAoRTQ1KS4gU3RvcmVkIGluIHRoZSBtYW5pZmVzdDogdGhleSB0cmF2ZWwgd2l0aCB0aGVcbiAgICogIHNlc3Npb24gYW5kIG5ldmVyIGxpdHRlciB0aGUgaHVtYW4ncyBmb2xkZXIuICovXG4gIG5vdGVzPzogTm90ZVtdO1xuICAvKiogSGFzaCBvZiB0aGUgb3JpZ2luYWwgYXMgd2UgbGFzdCByZWFkIG9yIHdyb3RlIGl0IOKAlCBhdCBvcGVuLCBzYXZlLCByZXZlcnRcbiAgICogIGFuZCByZWxvYWQg4oCUIHNvIGEgcmVzdG9yZSBjYW4gdGVsbCB0aGF0IGl0IGNoYW5nZWQgd2hpbGUgbm8gZGFlbW9uIHdhc1xuICAgKiAgd2F0Y2hpbmcgKHZlcmlmeS1wYXNzIGZpeCAyKS4gKi9cbiAgb3JpZ2luYWxIYXNoOiBzdHJpbmc7XG4gIC8qKiBTZXQgb25seSBieSBgb3BlblBhdGhgLCB3aGljaCBhZG1pdHMgYSBkb2MtdHlwZSBmaWxlIElOU0lERSBhIGNvbnRleHRcbiAgICogIGVudHJ5LiBgc2F2ZWAgd3JpdGVzIG5vIG9yaWdpbmFsIHRoYXQgbGFja3MgaXQgKHZlcmlmeS1wYXNzIGZpeCAxYykuICovXG4gIGFkbWl0dGVkPzogYm9vbGVhbjtcbiAgb3V0c2lkZUNoYW5nZWQ6IGJvb2xlYW47XG59O1xuXG5leHBvcnQgdHlwZSBNYW5pZmVzdCA9IHtcbiAgZm9ybWF0OiBudW1iZXI7XG4gIHNlc3Npb25JZDogc3RyaW5nO1xuICBjcmVhdGVkQXQ6IG51bWJlcjtcbiAgY29udGV4dDogQ29udGV4dEVudHJ5W107XG4gIGRvY3M6IERvY1JlY29yZFtdO1xuICBvcGVuRG9jOiBzdHJpbmcgfCBudWxsO1xuICBjaGF0OiBDaGF0TWVzc2FnZVtdO1xuICAvKiogVGhlIHdvcmsgcXVldWUgKEU1MCkuIEFic2VudCBpbiBhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIGl0IGV4aXN0ZWQuICovXG4gIHRhc2tzPzogVGFza1tdO1xuICAvKiogRTIzJ3Mgd29ya3NwYWNlLiBBYnNlbnQgaW4gYSBtYW5pZmVzdCB3cml0dGVuIGJlZm9yZSBpdCBleGlzdGVkOiB0aGUgdXNlcidzIGhvbWUuICovXG4gIHdvcmtzcGFjZT86IHN0cmluZztcbn07XG5cbi8qKiBBIHJlZnVzYWwgdGhlIGRhZW1vbiB0dXJucyBpbnRvIGFuIEhUVFAgc3RhdHVzIOKAlCBgY2hvaWNlc2Agd2hlbiB0aGUgc2V0IGlzIGluIGhhbmQgKEExKS4gKi9cbmV4cG9ydCBjbGFzcyBTZXNzaW9uRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICByZWFkb25seSBzdGF0dXM6IDQwMCB8IDQwNCB8IDQwOSxcbiAgICByZWFkb25seSBjaG9pY2VzPzogc3RyaW5nW10sXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5cbmV4cG9ydCBjb25zdCBjb250ZW50SGFzaCA9ICh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcgPT4gQnVuLmhhc2godGV4dCkudG9TdHJpbmcoMTYpO1xuXG5jb25zdCByYW5kSGV4ID0gKG46IG51bWJlcikgPT5cbiAgQXJyYXkuZnJvbShjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKG5ldyBVaW50OEFycmF5KG4pKSlcbiAgICAubWFwKChiKSA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpXG4gICAgLmpvaW4oXCJcIik7XG5cbmV4cG9ydCBjb25zdCBuZXdTZXNzaW9uSWQgPSAoKTogc3RyaW5nID0+IHJhbmRIZXgoNCk7XG5cbi8qKiBBIHBhdGgncyByZWFscGF0aCwgb3IgdGhlIHBhdGggaXRzZWxmIHdoZW4gaXQgY2Fubm90IGJlIHJlc29sdmVkIChnb25lKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFsT3IocDogc3RyaW5nKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhbHBhdGhTeW5jKHApO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gcDtcbiAgfVxufVxuXG4vKiogV2hhdCBhIHdhdGNoZXIgZXZlbnQgdHVybmVkIG91dCB0byBiZS4gYG51bGxgID0gbm90aGluZyAob3Vycywgb3Igbm8gY2hhbmdlKS4gKi9cbmV4cG9ydCB0eXBlIEZpbGVFdmVudCA9XG4gIHwgeyBraW5kOiBcInZlcnNpb24uY2hhbmdlZFwiOyBkb2M6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyOyB0ZXh0OiBzdHJpbmc7IGFjdGl2ZTogZmFsc2UgfVxuICB8IHtcbiAgICAgIGtpbmQ6IFwiYWN0aXZlLm91dHNpZGVcIjtcbiAgICAgIGRvYzogc3RyaW5nO1xuICAgICAgdmVyc2lvbjogbnVtYmVyO1xuICAgICAgcGF0aDogc3RyaW5nO1xuICAgICAgLyoqIFRoZSBuZXcgYWdlbnQgdmVyc2lvbiB0aGUgb3V0c2lkZSB0ZXh0IHdhcyBwcmVzZXJ2ZWQgYXMuICovXG4gICAgICBwcmVzZXJ2ZWRBczogbnVtYmVyO1xuICAgICAgcHJlc2VydmVkUGF0aDogc3RyaW5nO1xuICAgIH1cbiAgfCB7IGtpbmQ6IFwidmVyc2lvbi5jcmVhdGVkXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHBhdGg6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcIm9yaWdpbmFsLnJlbG9hZGVkXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHRleHQ6IHN0cmluZzsgb3JpZ2luYWw6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcIm9yaWdpbmFsLmNvbmZsaWN0XCI7IGRvYzogc3RyaW5nOyBvcmlnaW5hbDogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwidHJlZVwiOyBlbnRyeUlkOiBzdHJpbmcgfTtcblxuZXhwb3J0IGNsYXNzIFNlc3Npb24ge1xuICByZWFkb25seSBkaXI6IHN0cmluZztcbiAgcHJpdmF0ZSBtOiBNYW5pZmVzdDtcbiAgLyoqIHBhdGgg4oaSIGhhc2ggb2YgdGhlIGRhZW1vbidzIGxhc3Qgd3JpdGUgdG8gaXQuICovXG4gIHByaXZhdGUgb3duZWQgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAvKiogc2x1ZyDihpIgaGFzaCBvZiB0aGUgYWN0aXZlIHZlcnNpb24ncyBjdXJyZW50IHRleHQuICovXG4gIHByaXZhdGUgYWN0aXZlSGFzaCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIC8qKiBzbHVnIOKGkiB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IGFzIHRoZSBkYWVtb24gbGFzdCB3cm90ZSAob3IgYWRvcHRlZClcbiAgICogIGl0IOKAlCB3aGF0IGFuIG91dHNpZGUgd3JpdGUgdG8gdGhlIGFjdGl2ZSB2ZXJzaW9uIGlzIHJldmVydGVkIHRvLiAqL1xuICBwcml2YXRlIGxhc3RBY3RpdmVUZXh0ID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgLyoqIFdoYXQgYSByZXN0b3JlIGZvdW5kIGNoYW5nZWQgb24gZGlzayB3aGlsZSBubyBkYWVtb24gd2FzIHdhdGNoaW5nLiAqL1xuICByZXN0b3JlRmluZGluZ3M6IHsgZG9jOiBzdHJpbmc7IG9yaWdpbmFsOiBzdHJpbmc7IG1pc3Npbmc6IGJvb2xlYW4gfVtdID0gW107XG5cbiAgcHJpdmF0ZSBjb25zdHJ1Y3RvcihcbiAgICByZWFkb25seSBob21lOiBzdHJpbmcsXG4gICAgbWFuaWZlc3Q6IE1hbmlmZXN0LFxuICApIHtcbiAgICB0aGlzLm0gPSBtYW5pZmVzdDtcbiAgICB0aGlzLmRpciA9IGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiLCBtYW5pZmVzdC5zZXNzaW9uSWQpO1xuICB9XG5cbiAgc3RhdGljIGNyZWF0ZShob21lOiBzdHJpbmcsIHNlc3Npb25JZDogc3RyaW5nID0gbmV3U2Vzc2lvbklkKCksIHdvcmtzcGFjZT86IHN0cmluZyk6IFNlc3Npb24ge1xuICAgIGNvbnN0IHMgPSBuZXcgU2Vzc2lvbihob21lLCB7XG4gICAgICBmb3JtYXQ6IE1BTklGRVNUX0ZPUk1BVCxcbiAgICAgIHNlc3Npb25JZCxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIGNvbnRleHQ6IFtdLFxuICAgICAgZG9jczogW10sXG4gICAgICBvcGVuRG9jOiBudWxsLFxuICAgICAgY2hhdDogW10sXG4gICAgICAuLi4od29ya3NwYWNlID8geyB3b3Jrc3BhY2U6IHJlc29sdmUod29ya3NwYWNlKSB9IDoge30pLFxuICAgIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKHMuZGlyLCBcImRvY3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHMucGVyc2lzdCgpO1xuICAgIHJldHVybiBzO1xuICB9XG5cbiAgLyoqIFJlbG9hZCBhIHNlc3Npb24gZnJvbSBpdHMgbWFuaWZlc3QgKGBvcGVuIC0tcmVzdG9yZSA8aWQ+YCkuICovXG4gIHN0YXRpYyByZXN0b3JlKGhvbWU6IHN0cmluZywgc2Vzc2lvbklkOiBzdHJpbmcpOiBTZXNzaW9uIHtcbiAgICBjb25zdCBwYXRoID0gam9pbihob21lLCBcInNlc3Npb25zXCIsIHNlc3Npb25JZCwgXCJtYW5pZmVzdC5qc29uXCIpO1xuICAgIGlmICghZXhpc3RzU3luYyhwYXRoKSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgbm8gc2F2ZWQgc2Vzc2lvbiAke3Nlc3Npb25JZH1gLCA0MDQpO1xuICAgIGNvbnN0IG0gPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpIGFzIE1hbmlmZXN0O1xuICAgIGlmIChtLmZvcm1hdCAhPT0gTUFOSUZFU1RfRk9STUFUKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgc2Vzc2lvbiAke3Nlc3Npb25JZH0gaGFzIG1hbmlmZXN0IGZvcm1hdCAke20uZm9ybWF0fWAsIDQwOSk7XG4gICAgY29uc3QgcyA9IG5ldyBTZXNzaW9uKGhvbWUsIG0pO1xuICAgIG1rZGlyU3luYyhqb2luKHMuZGlyLCBcImRvY3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIC8vIE1pcnJvcnMgYXJlIHJlLXJlYWQsIG5vdCB0cnVzdGVkOiB0aGUgZm9sZGVyIG1heSBoYXZlIGNoYW5nZWQgd2hpbGUgbm9cbiAgICAvLyBkYWVtb24gd2FzIHdhdGNoaW5nIGl0LlxuICAgIGZvciAoY29uc3QgZSBvZiBzLm0uY29udGV4dCkgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiKSBzLnJlc2NhbihlLmlkKTtcbiAgICBmb3IgKGNvbnN0IGQgb2Ygcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IHAgPSBzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKTtcbiAgICAgIGNvbnN0IHRleHQgPSBleGlzdHNTeW5jKHApID8gcmVhZEZpbGVTeW5jKHAsIFwidXRmOFwiKSA6IFwiXCI7XG4gICAgICBzLmFkb3B0QWN0aXZlKGQsIHRleHQpO1xuICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAyOiBhbiBvcmlnaW5hbCBjaGFuZ2VkIHdoaWxlIHRoZSBzZXNzaW9uIHdhcyBjbG9zZWRcbiAgICAgIC8vIHdhcyBpbnZpc2libGUgaGVyZSwgc28gdGhlIG5leHQgU2F2ZSBvdmVyd3JvdGUgaXQgdW5hbm5vdW5jZWQuIFRoZVxuICAgICAgLy8gbWFuaWZlc3QgaG9sZHMgdGhlIG9yaWdpbmFsJ3MgaGFzaCBhcyBvZiB0aGUgbGFzdCBvcGVuL3NhdmUvcmV2ZXJ0L1xuICAgICAgLy8gcmVsb2FkOyBhIGRpZmZlcmVudCBoYXNoIG5vdyBpcyBhbiBvdXRzaWRlIGNoYW5nZSwgbWFya2VkIGV4YWN0bHkgYXMgYVxuICAgICAgLy8gbGl2ZSBvbmUgd2l0aCBhIGRpcnR5IGJ1ZmZlciBpcyDigJQgYXNrZWQsIG5ldmVyIG1lcmdlZCBvciByZWxvYWRlZC5cbiAgICAgIGxldCBub3c6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgICAgdHJ5IHtcbiAgICAgICAgbm93ID0gY29udGVudEhhc2gocmVhZEZpbGVTeW5jKGQub3JpZ2luYWwsIFwidXRmOFwiKSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgbm93ID0gbnVsbDtcbiAgICAgIH1cbiAgICAgIGlmIChub3cgPT09IG51bGwgfHwgbm93ICE9PSBkLm9yaWdpbmFsSGFzaCkge1xuICAgICAgICBkLm91dHNpZGVDaGFuZ2VkID0gdHJ1ZTtcbiAgICAgICAgcy5yZXN0b3JlRmluZGluZ3MucHVzaCh7IGRvYzogZC5zbHVnLCBvcmlnaW5hbDogZC5vcmlnaW5hbCwgbWlzc2luZzogbm93ID09PSBudWxsIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAocy5yZXN0b3JlRmluZGluZ3MubGVuZ3RoID4gMCkgcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHM7XG4gIH1cblxuICBzdGF0aWMgbGlzdFNhdmVkKGhvbWU6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHJlYWRkaXJTeW5jKGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiKSkuZmlsdGVyKChpZCkgPT5cbiAgICAgICAgZXhpc3RzU3luYyhqb2luKGhvbWUsIFwic2Vzc2lvbnNcIiwgaWQsIFwibWFuaWZlc3QuanNvblwiKSksXG4gICAgICApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgfVxuXG4gIGdldCBpZCgpOiBzdHJpbmcge1xuICAgIHJldHVybiB0aGlzLm0uc2Vzc2lvbklkO1xuICB9XG5cbiAgZ2V0IGRvY3NEaXIoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gam9pbih0aGlzLmRpciwgXCJkb2NzXCIpO1xuICB9XG5cbiAgZ2V0IG9wZW5Eb2NTbHVnKCk6IHN0cmluZyB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLm0ub3BlbkRvYztcbiAgfVxuXG4gIGdldCBjb250ZXh0KCk6IHJlYWRvbmx5IENvbnRleHRFbnRyeVtdIHtcbiAgICByZXR1cm4gdGhpcy5tLmNvbnRleHQ7XG4gIH1cblxuICAvKipcbiAgICogRXZlcnkgZGlyZWN0b3J5IHRoZSB3YXRjaGVyIG11c3Qgc2VlOiB0aGUgc2Vzc2lvbidzIGRvY3MsIGVhY2ggZW50cnkgcm9vdCxcbiAgICogYW5kIHRoZSBSRUFMIGRpcmVjdG9yeSBvZiBldmVyeSBvcGVuZWQgb3JpZ2luYWwuXG4gICAqXG4gICAqIOKblCBWRVJJRlktUEFTUyBGSVggMzogZWFjaCByb290IGlzIHdhdGNoZWQgYXQgaXRzIFJFQUxQQVRIIChgd2F0Y2hgKSwgYW5kXG4gICAqIGFuIGV2ZW50IGlzIHJlcG9ydGVkIHVuZGVyIHRoZSBwYXRoIGZvcm0gdGhlIHNlc3Npb24gc3RvcmVzIChgcGF0aGApLiBBXG4gICAqIHdhdGNoIG9uIGEgc3ltbGlua2VkIGRpcmVjdG9yeSDigJQgYSBzeW1saW5rZWQgaG9tZSwgYSBzeW1saW5rZWQgZm9sZGVyXG4gICAqIGVudHJ5IOKAlCBvciBvbiB0aGUgbGluaydzIG93biBkaXJlY3RvcnkgZm9yIGEgc3ltbGlua2VkIG9yaWdpbmFsIHNhd1xuICAgKiBub3RoaW5nIHdoZW4gdGhlIFRBUkdFVCBjaGFuZ2VkIChGU0V2ZW50cyByZXBvcnRzIHJlYWwgcGF0aHMpLiBBIHN5bWxpbmtlZFxuICAgKiBvcmlnaW5hbCBpcyBtYXRjaGVkIGJhY2sgdG8gaXRzIGRvYyBieSByZWFscGF0aCBpbiBgb25GaWxlRXZlbnRgLlxuICAgKi9cbiAgd2F0Y2hSb290cygpOiB7IHBhdGg6IHN0cmluZzsgd2F0Y2g6IHN0cmluZzsgcmVjdXJzaXZlOiBib29sZWFuOyBlbnRyeUlkPzogc3RyaW5nIH1bXSB7XG4gICAgY29uc3Qgcm9vdHM6IHsgcGF0aDogc3RyaW5nOyB3YXRjaDogc3RyaW5nOyByZWN1cnNpdmU6IGJvb2xlYW47IGVudHJ5SWQ/OiBzdHJpbmcgfVtdID0gW1xuICAgICAgeyBwYXRoOiB0aGlzLmRvY3NEaXIsIHdhdGNoOiByZWFsT3IodGhpcy5kb2NzRGlyKSwgcmVjdXJzaXZlOiB0cnVlIH0sXG4gICAgXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpXG4gICAgICByb290cy5wdXNoKHtcbiAgICAgICAgcGF0aDogZS5yb290LFxuICAgICAgICB3YXRjaDogcmVhbE9yKGUucm9vdCksXG4gICAgICAgIHJlY3Vyc2l2ZTogZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIsXG4gICAgICAgIGVudHJ5SWQ6IGUuaWQsXG4gICAgICB9KTtcbiAgICBmb3IgKGNvbnN0IGQgb2YgdGhpcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IHJlYWxEaXIgPSBkaXJuYW1lKHJlYWxPcihkLm9yaWdpbmFsKSk7XG4gICAgICBpZiAoXG4gICAgICAgICFyb290cy5zb21lKChyKSA9PiByLndhdGNoID09PSByZWFsRGlyICYmIHIucmVjdXJzaXZlID09PSBmYWxzZSkgJiZcbiAgICAgICAgIXJvb3RzLnNvbWUoXG4gICAgICAgICAgKHIpID0+IHIucmVjdXJzaXZlICYmIChyZWFsRGlyID09PSByLndhdGNoIHx8IHJlYWxEaXIuc3RhcnRzV2l0aChyLndhdGNoICsgc2VwKSksXG4gICAgICAgIClcbiAgICAgIClcbiAgICAgICAgcm9vdHMucHVzaCh7IHBhdGg6IHJlYWxEaXIsIHdhdGNoOiByZWFsRGlyLCByZWN1cnNpdmU6IGZhbHNlIH0pO1xuICAgIH1cbiAgICByZXR1cm4gcm9vdHM7XG4gIH1cblxuICAvLyDilIDilIAgcGVyc2lzdGVuY2Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcGVyc2lzdCgpOiB2b2lkIHtcbiAgICBta2RpclN5bmModGhpcy5kaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZUF0b21pYyhqb2luKHRoaXMuZGlyLCBcIm1hbmlmZXN0Lmpzb25cIiksIGAke0pTT04uc3RyaW5naWZ5KHRoaXMubSwgbnVsbCwgMil9XFxuYCk7XG4gIH1cblxuICBwcml2YXRlIHdyaXRlT3duZWQocGF0aDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBta2RpclN5bmMoZGlybmFtZShwYXRoKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgLy8gUmVtZW1iZXIgQkVGT1JFIHdyaXRpbmc6IHRoZSB3YXRjaGVyJ3MgZXZlbnQgY2FuIGFycml2ZSBiZWZvcmUgdGhpc1xuICAgIC8vIGZ1bmN0aW9uIHJldHVybnMsIGFuZCBpdCBtdXN0IGZpbmQgdGhlIGhhc2ggYWxyZWFkeSB0aGVyZS5cbiAgICB0aGlzLm93bmVkLnNldChwYXRoLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgd3JpdGVGaWxlU3luYyhwYXRoLCB0ZXh0KTtcbiAgfVxuXG4gIHByaXZhdGUgYWRvcHRBY3RpdmUoZDogRG9jUmVjb3JkLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBwID0gdGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSk7XG4gICAgdGhpcy5vd25lZC5zZXQocCwgY29udGVudEhhc2godGV4dCkpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5sYXN0QWN0aXZlVGV4dC5zZXQoZC5zbHVnLCB0ZXh0KTtcbiAgfVxuXG4gIHByaXZhdGUgd3JpdGVBY3RpdmUoZDogRG9jUmVjb3JkLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIHRleHQpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5sYXN0QWN0aXZlVGV4dC5zZXQoZC5zbHVnLCB0ZXh0KTtcbiAgfVxuXG4gIC8qKiBLZWVwIGFuIG91dHNpZGUgd3JpdGUgdG8gdGhlIGFjdGl2ZSB2ZXJzaW9uIGFzIGEgTkVXIGFnZW50IHZlcnNpb24uICovXG4gIHByaXZhdGUgcHJlc2VydmVPdXRzaWRlKGQ6IERvY1JlY29yZCwgdGV4dDogc3RyaW5nKTogVmVyc2lvbiB7XG4gICAgY29uc3QgbiA9IHRoaXMudGFrZVZlcnNpb24oZCk7XG4gICAgY29uc3QgcmVjOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPiA9IHtcbiAgICAgIG4sXG4gICAgICBhdXRob3I6IFwiYWdlbnRcIixcbiAgICAgIGZyb206IGQuYWN0aXZlLFxuICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgbGFiZWw6IGBvdXRzaWRlIHdyaXRlIHRvIHYke2QuYWN0aXZlfWAsXG4gICAgfTtcbiAgICBkLnZlcnNpb25zLnB1c2gocmVjKTtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCBuKSwgdGV4dCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgLi4ucmVjLCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIG4pIH07XG4gIH1cblxuICAvKiogVHJ1ZSBpZmYgYHRleHRgIGF0IGBwYXRoYCBpcyBleGFjdGx5IHdoYXQgdGhlIGRhZW1vbiBsYXN0IHdyb3RlIHRoZXJlLiAqL1xuICBpc093bldyaXRlKHBhdGg6IHN0cmluZywgdGV4dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMub3duZWQuZ2V0KHBhdGgpID09PSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBjb250ZXh0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIGFkZENvbnRleHQocmF3UGF0aDogc3RyaW5nKTogeyBlbnRyeTogQ29udGV4dEVudHJ5OyBhZGRlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBhYnMgPSByZXNvbHZlKHJhd1BhdGgpO1xuICAgIGNvbnN0IHByb2JlID0gZW50cnlGb3JQYXRoKGFicywgYGMtJHtyYW5kSGV4KDMpfWApO1xuICAgIGNvbnN0IHNhbWUgPSB0aGlzLm0uY29udGV4dC5maW5kKFxuICAgICAgKGUpID0+XG4gICAgICAgIGUucm9vdCA9PT0gcHJvYmUucm9vdCAmJlxuICAgICAgICBlLm1lbWJlcnNoaXAgPT09IHByb2JlLm1lbWJlcnNoaXAgJiZcbiAgICAgICAgKHByb2JlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiB8fFxuICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGUubm9kZXMpID09PSBKU09OLnN0cmluZ2lmeShwcm9iZS5ub2RlcykpLFxuICAgICk7XG4gICAgaWYgKHNhbWUpIHJldHVybiB7IGVudHJ5OiBzYW1lLCBhZGRlZDogZmFsc2UgfTtcbiAgICB0aGlzLm0uY29udGV4dC5wdXNoKHByb2JlKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IGVudHJ5OiBwcm9iZSwgYWRkZWQ6IHRydWUgfTtcbiAgfVxuXG4gIHJlbW92ZUNvbnRleHQoaWQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IGkgPSB0aGlzLm0uY29udGV4dC5maW5kSW5kZXgoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgICBpZiAoaSA8IDApXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm8gY29udGV4dCBlbnRyeSAke2lkfWAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgdGhpcy5tLmNvbnRleHQubWFwKChlKSA9PiBlLmlkKSxcbiAgICAgICk7XG4gICAgdGhpcy5tLmNvbnRleHQuc3BsaWNlKGksIDEpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5jbG9zZU9ycGhhbmVkT3BlbkRvYygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBvcGVuIGRvY3VtZW50IGxlZnQgdGhlIGNvbnRleHQgKGl0cyBlbnRyeSByZW1vdmVkLCBvciB0aGUgZG9jdW1lbnRcbiAgICogaGlkZGVuKTogY2xvc2UgaXQgaW4gdGhlIHZpZXcuIEl0cyB2ZXJzaW9ucyBzdGF5IGluIHRoZSBzZXNzaW9uIOKAlCBub3RoaW5nXG4gICAqIGlzIGRlbGV0ZWQg4oCUIGFuZCBicmluZ2luZyBpdCBiYWNrIGFuZCBvcGVuaW5nIGl0IGFnYWluIGZpbmRzIHRoZW0uXG4gICAqL1xuICBwcml2YXRlIGNsb3NlT3JwaGFuZWRPcGVuRG9jKCk6IHZvaWQge1xuICAgIGNvbnN0IG9wZW4gPSB0aGlzLm0ub3BlbkRvYyA/IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQuc2x1ZyA9PT0gdGhpcy5tLm9wZW5Eb2MpIDogdW5kZWZpbmVkO1xuICAgIGlmIChvcGVuICYmIG9wZW4uZW50cnlJZCA9PT0gbnVsbCkgdGhpcy5tLm9wZW5Eb2MgPSBudWxsO1xuICB9XG5cbiAgLyoqIFJlLW1pcnJvciBhIGZvbGRlciBlbnRyeS4gUmV0dXJucyB3aGV0aGVyIGl0cyBub2RlcyBjaGFuZ2VkLiAqL1xuICByZXNjYW4oZW50cnlJZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgY29uc3QgZSA9IHRoaXMubS5jb250ZXh0LmZpbmQoKHgpID0+IHguaWQgPT09IGVudHJ5SWQpO1xuICAgIGlmIChlPy5tZW1iZXJzaGlwICE9PSBcIm1pcnJvcmVkXCIpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCB7IG5vZGVzLCB0cnVuY2F0ZWQgfSA9IHNjYW5UcmVlKGUucm9vdCwgTUlSUk9SX05PREVfQ0FQLCBlLmhpZGRlbik7XG4gICAgY29uc3QgY2hhbmdlZCA9XG4gICAgICBKU09OLnN0cmluZ2lmeShub2RlcykgIT09IEpTT04uc3RyaW5naWZ5KGUubm9kZXMpIHx8ICEhdHJ1bmNhdGVkICE9PSAhIWUudHJ1bmNhdGVkO1xuICAgIGUubm9kZXMgPSBub2RlcztcbiAgICBpZiAodHJ1bmNhdGVkKSBlLnRydW5jYXRlZCA9IHRydWU7XG4gICAgZWxzZSBkZWxldGUgZS50cnVuY2F0ZWQ7XG4gICAgaWYgKGNoYW5nZWQpIHRoaXMucmVsaW5rKCk7XG4gICAgcmV0dXJuIGNoYW5nZWQ7XG4gIH1cblxuICBwcml2YXRlIHJlbGluaygpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGQgb2YgdGhpcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IGF0ID0gbG9jYXRlKHRoaXMubS5jb250ZXh0LCBkLm9yaWdpbmFsKTtcbiAgICAgIGQuZW50cnlJZCA9IGF0Py5lbnRyeUlkID8/IG51bGw7XG4gICAgICBkLnJlbCA9IGF0Py5yZWwgPz8gbnVsbDtcbiAgICB9XG4gIH1cblxuICAvLyDilIDilIAgZG9jdW1lbnRzIGFuZCB2ZXJzaW9ucyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBwcml2YXRlIHZlcnNpb25QYXRoKGQ6IERvY1JlY29yZCwgbjogbnVtYmVyKTogc3RyaW5nIHtcbiAgICByZXR1cm4gam9pbih0aGlzLmRvY3NEaXIsIGQuc2x1ZywgYHYke259JHtkLmV4dH1gKTtcbiAgfVxuXG4gIHByaXZhdGUgZG9jT3JEaWUoc2x1Zz86IHN0cmluZyk6IERvY1JlY29yZCB7XG4gICAgY29uc3Qgd2FudCA9IHNsdWcgPz8gdGhpcy5tLm9wZW5Eb2MgPz8gdW5kZWZpbmVkO1xuICAgIGNvbnN0IGNob2ljZXMgPSB0aGlzLm0uZG9jcy5tYXAoKGQpID0+IGQuc2x1Zyk7XG4gICAgaWYgKHdhbnQgPT09IHVuZGVmaW5lZClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXCJubyBkb2N1bWVudCBpcyBvcGVuIOKAlCBuYW1lIG9uZSB3aXRoIC0tZG9jXCIsIDQwOSwgY2hvaWNlcyk7XG4gICAgY29uc3QgZCA9IHRoaXMuZmluZERvYyh3YW50KTtcbiAgICBpZiAoIWQpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vIGRvY3VtZW50IFwiJHt3YW50fVwiIGluIHRoaXMgc2Vzc2lvbmAsIDQwNCwgY2hvaWNlcyk7XG4gICAgcmV0dXJuIGQ7XG4gIH1cblxuICAvKiogQSBkb2MgYnkgc2x1ZywgYnkgb3JpZ2luYWwgcGF0aCwgb3IgYnkgYSB1bmlxdWUgb3JpZ2luYWwgYmFzZW5hbWUuICovXG4gIGZpbmREb2Moa2V5OiBzdHJpbmcpOiBEb2NSZWNvcmQgfCB1bmRlZmluZWQge1xuICAgIGNvbnN0IGJ5U2x1ZyA9IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQuc2x1ZyA9PT0ga2V5KTtcbiAgICBpZiAoYnlTbHVnKSByZXR1cm4gYnlTbHVnO1xuICAgIC8vIOKblCBPTkxZIEFOIEFCU09MVVRFIGtleSBpcyBhIHBhdGggKHZlcmlmeS1wYXNzIGZpeCA4KTogcmVzb2x2aW5nIGFcbiAgICAvLyByZWxhdGl2ZSBvbmUgaGVyZSByZXNvbHZlZCBpdCBhZ2FpbnN0IHRoZSBEQUVNT04ncyBjd2QuIFRoZSBDTEkgcmVzb2x2ZXNcbiAgICAvLyBhZ2FpbnN0IGl0cyBvd24gY3dkIGFuZCBzZW5kcyBhbiBhYnNvbHV0ZSBwYXRoLlxuICAgIGlmIChpc0Fic29sdXRlKGtleSkpIHtcbiAgICAgIGNvbnN0IGJ5UGF0aCA9IHRoaXMubS5kb2NzLmZpbmQoXG4gICAgICAgIChkKSA9PiBkLm9yaWdpbmFsID09PSBrZXkgfHwgcmVhbE9yKGQub3JpZ2luYWwpID09PSByZWFsT3Ioa2V5KSxcbiAgICAgICk7XG4gICAgICBpZiAoYnlQYXRoKSByZXR1cm4gYnlQYXRoO1xuICAgIH1cbiAgICBjb25zdCBieU5hbWUgPSB0aGlzLm0uZG9jcy5maWx0ZXIoKGQpID0+IGJhc2VuYW1lKGQub3JpZ2luYWwpID09PSBrZXkgfHwgZC5yZWwgPT09IGtleSk7XG4gICAgcmV0dXJuIGJ5TmFtZS5sZW5ndGggPT09IDEgPyBieU5hbWVbMF0gOiB1bmRlZmluZWQ7XG4gIH1cblxuICAvKiogVGhlIG5leHQgdmVyc2lvbiBudW1iZXIsIGNvbnN1bWVkLiBOdW1iZXJzIGFyZSBuZXZlciByZXVzZWQgKEU0MSkuICovXG4gIHByaXZhdGUgdGFrZVZlcnNpb24oZDogRG9jUmVjb3JkKTogbnVtYmVyIHtcbiAgICBjb25zdCBuID0gZC5uZXh0VmVyc2lvbiA/PyBNYXRoLm1heCguLi5kLnZlcnNpb25zLm1hcCgodikgPT4gdi5uKSkgKyAxO1xuICAgIGQubmV4dFZlcnNpb24gPSBuICsgMTtcbiAgICByZXR1cm4gbjtcbiAgfVxuXG4gIHByaXZhdGUgdmVyc2lvbk9yRGllKGQ6IERvY1JlY29yZCwgbjogbnVtYmVyKTogT21pdDxWZXJzaW9uLCBcInBhdGhcIj4ge1xuICAgIGNvbnN0IHYgPSBkLnZlcnNpb25zLmZpbmQoKHgpID0+IHgubiA9PT0gbik7XG4gICAgaWYgKCF2KVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7ZC5zbHVnfSBoYXMgbm8gdiR7bn1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIGQudmVyc2lvbnMubWFwKCh4KSA9PiBgdiR7eC5ufWApLFxuICAgICAgKTtcbiAgICByZXR1cm4gdjtcbiAgfVxuXG4gIHByaXZhdGUgc2x1Z0ZvcihvcmlnaW5hbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBzdGVtID1cbiAgICAgIGJhc2VuYW1lKG9yaWdpbmFsLCBleHRuYW1lKG9yaWdpbmFsKSlcbiAgICAgICAgLnRvTG93ZXJDYXNlKClcbiAgICAgICAgLnJlcGxhY2UoL1teYS16MC05Xy1dKy9nLCBcIi1cIilcbiAgICAgICAgLnJlcGxhY2UoL14tK3wtKyQvZywgXCJcIikgfHwgXCJkb2NcIjtcbiAgICBsZXQgc2x1ZyA9IHN0ZW07XG4gICAgZm9yIChsZXQgaSA9IDI7IHRoaXMubS5kb2NzLnNvbWUoKGQpID0+IGQuc2x1ZyA9PT0gc2x1Zyk7IGkrKykgc2x1ZyA9IGAke3N0ZW19LSR7aX1gO1xuICAgIHJldHVybiBzbHVnO1xuICB9XG5cbiAgLyoqXG4gICAqIE9wZW4gYSBkb2N1bWVudCBieSBpdHMgb3JpZ2luYWwncyBwYXRoOiB2MSBpcyB3cml0dGVuIGZyb20gdGhlIG9yaWdpbmFsXG4gICAqIHRoZSBmaXJzdCB0aW1lLiBgZm9jdXM6IGZhbHNlYCAodGhlIGFnZW50J3MgaW1wbGljaXQgb3BlbiB0aHJvdWdoXG4gICAqIGB2ZXJzaW9uLW5ldyAtLWRvYyA8cGF0aD5gKSBkb2VzIG5vdCBtb3ZlIHRoZSBodW1hbidzIG9wZW4gZG9jdW1lbnQuXG4gICAqXG4gICAqIOKblCBWRVJJRlktUEFTUyBGSVggMWIg4oCUIEFETUlTU0lPTi4gT25seSBhIGRvYy10eXBlIGZpbGUgSU5TSURFIGEgY29udGV4dFxuICAgKiBlbnRyeSBpcyBhZG1pdHRlZDsgYGNvbnRleHQuYWRkYCBzdGF5cyB0aGUgb25lIHdheSBpbi4gQmVmb3JlIHRoaXMsIGFueVxuICAgKiBwYXRoIG9mIGFueSB0eXBlIHdhcyBvcGVuZWQsIGFuZCBTYXZlIHRoZW4gd3JvdGUgaXQ6IGEgZm9yZWlnbiB3ZWIgcGFnZVxuICAgKiB3cm90ZSBgY3VybCBldmlsIHwgc2hgIGludG8gYSBgLnJjYCBmaWxlIG91dHNpZGUgdGhlIGNvbnRleHQuXG4gICAqL1xuICBvcGVuUGF0aChyYXdQYXRoOiBzdHJpbmcsIG9wdHM6IHsgZm9jdXM/OiBib29sZWFuIH0gPSB7fSk6IHsgc2x1Zzogc3RyaW5nOyBjcmVhdGVkOiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGZvY3VzID0gb3B0cy5mb2N1cyA/PyB0cnVlO1xuICAgIC8vIFRoZSBjb250ZXh0J3Mgb3duIHNwZWxsaW5nIG9mIHRoZSBwYXRoOiBhIGNhbGxlciB3aG9zZSBjd2QgaXMgYSByZWFscGF0aFxuICAgIC8vICgvcHJpdmF0ZS92YXIv4oCmIGZvciAvdmFyL+KApiwgb3IgdGhyb3VnaCBhIHN5bWxpbmtlZCBmb2xkZXIpIG5hbWVzIHRoZSBzYW1lXG4gICAgLy8gZmlsZSBkaWZmZXJlbnRseSwgYW5kIGl0IG11c3QgbGFuZCBvbiB0aGUgc2FtZSBkb2MuXG4gICAgY29uc3QgYWJzID0gdGhpcy5jYW5vbmljYWwocmVzb2x2ZShyYXdQYXRoKSk7XG4gICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLm9yaWdpbmFsID09PSBhYnMpO1xuICAgIGlmIChleGlzdGluZykge1xuICAgICAgaWYgKGZvY3VzKSB0aGlzLm0ub3BlbkRvYyA9IGV4aXN0aW5nLnNsdWc7XG4gICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgIHJldHVybiB7IHNsdWc6IGV4aXN0aW5nLnNsdWcsIGNyZWF0ZWQ6IGZhbHNlIH07XG4gICAgfVxuICAgIGlmICghaXNEb2NOYW1lKGFicykpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zOiAke2Fic31gLCA0MDApO1xuICAgIGlmICghbG9jYXRlKHRoaXMubS5jb250ZXh0LCBhYnMpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7YWJzfSBpcyBub3QgaW4gdGhpcyBzZXNzaW9uJ3MgY29udGV4dCDigJQgYWRkIGl0IChvciBpdHMgZm9sZGVyKSBmaXJzdGAsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICB0cnkge1xuICAgICAgaWYgKCFzdGF0U3luYyhhYnMpLmlzRmlsZSgpKSB0aHJvdyBuZXcgRXJyb3IoXCJub3QgYSBmaWxlXCIpO1xuICAgICAgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYGNhbm5vdCBvcGVuICR7YWJzfTogbm8gc3VjaCBmaWxlYCwgNDA0KTtcbiAgICB9XG4gICAgY29uc3QgZXh0ID0gW1wiLm1kXCIsIFwiLm1hcmtkb3duXCIsIFwiLm1keFwiLCBcIi50eHRcIl0uaW5jbHVkZXMoZXh0bmFtZShhYnMpLnRvTG93ZXJDYXNlKCkpXG4gICAgICA/IGV4dG5hbWUoYWJzKS50b0xvd2VyQ2FzZSgpXG4gICAgICA6IFwiLm1kXCI7XG4gICAgY29uc3QgYXQgPSBsb2NhdGUodGhpcy5tLmNvbnRleHQsIGFicyk7XG4gICAgY29uc3QgZDogRG9jUmVjb3JkID0ge1xuICAgICAgc2x1ZzogdGhpcy5zbHVnRm9yKGFicyksXG4gICAgICBuYW1lOiBiYXNlbmFtZShhYnMpLFxuICAgICAgb3JpZ2luYWw6IGFicyxcbiAgICAgIGVudHJ5SWQ6IGF0Py5lbnRyeUlkID8/IG51bGwsXG4gICAgICByZWw6IGF0Py5yZWwgPz8gbnVsbCxcbiAgICAgIGV4dCxcbiAgICAgIHZlcnNpb25zOiBbeyBuOiAxLCBhdXRob3I6IFwiaHVtYW5cIiwgY3JlYXRlZEF0OiBEYXRlLm5vdygpIH1dLFxuICAgICAgYWN0aXZlOiAxLFxuICAgICAgb3JpZ2luYWxIYXNoOiBjb250ZW50SGFzaCh0ZXh0KSxcbiAgICAgIG91dHNpZGVDaGFuZ2VkOiBmYWxzZSxcbiAgICAgIGFkbWl0dGVkOiB0cnVlLFxuICAgIH07XG4gICAgdGhpcy5tLmRvY3MucHVzaChkKTtcbiAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRleHQpO1xuICAgIGlmIChmb2N1cykgdGhpcy5tLm9wZW5Eb2MgPSBkLnNsdWc7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBjcmVhdGVkOiB0cnVlIH07XG4gIH1cblxuICAvKiogYGFic2AgYXMgdGhlIGNvbnRleHQgc3BlbGxzIGl0LCB3aGVuIGl0IGlzIHRoZSBzYW1lIGZpbGUgYnkgcmVhbHBhdGguICovXG4gIHByaXZhdGUgY2Fub25pY2FsKGFiczogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAobG9jYXRlKHRoaXMubS5jb250ZXh0LCBhYnMpKSByZXR1cm4gYWJzO1xuICAgIGNvbnN0IHJlYWwgPSByZWFsT3IoYWJzKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGNvbnN0IHJlYWxSb290ID0gcmVhbE9yKGUucm9vdCk7XG4gICAgICBpZiAoIXJlYWwuc3RhcnRzV2l0aChyZWFsUm9vdCArIHNlcCkpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qgc3BlbGxlZCA9IGpvaW4oZS5yb290LCByZWxhdGl2ZShyZWFsUm9vdCwgcmVhbCkpO1xuICAgICAgaWYgKGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgc3BlbGxlZCkpIHJldHVybiBzcGVsbGVkO1xuICAgIH1cbiAgICByZXR1cm4gYWJzO1xuICB9XG5cbiAgb3BlblNsdWcoc2x1Zzogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5tLm9wZW5Eb2MgPSB0aGlzLmRvY09yRGllKHNsdWcpLnNsdWc7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gIH1cblxuICByZWFkVmVyc2lvbihzbHVnOiBzdHJpbmcsIG46IG51bWJlcik6IHsgdGV4dDogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgdGhpcy52ZXJzaW9uT3JEaWUoZCwgbik7XG4gICAgY29uc3QgcGF0aCA9IHRoaXMudmVyc2lvblBhdGgoZCwgbik7XG4gICAgcmV0dXJuIHsgdGV4dDogcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSwgcGF0aCB9O1xuICB9XG5cbiAgYWN0aXZlUGF0aChzbHVnPzogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgY29uc3QgZCA9IHNsdWcgPyB0aGlzLmZpbmREb2Moc2x1ZykgOiB0aGlzLm0ub3BlbkRvYyA/IHRoaXMuZmluZERvYyh0aGlzLm0ub3BlbkRvYykgOiB1bmRlZmluZWQ7XG4gICAgcmV0dXJuIGQgPyB0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSA6IG51bGw7XG4gIH1cblxuICAvKiogVGhlIGh1bWFuJ3MgYnVmZmVyIHJlYWNoZXMgdGhlIEFDVElWRSB2ZXJzaW9uJ3MgZmlsZSAoZGVib3VuY2VkIGJ5IHRoZSBzdXJmYWNlKS4gKi9cbiAgLyoqXG4gICAqIOKblCBWRVJJRlktUEFTUyBGSVggNCDigJQgQ0hFQ0sgQkVGT1JFIFdSSVRFLiBCZWZvcmUgdGhlIGh1bWFuJ3MgZWRpdCBpc1xuICAgKiB3cml0dGVuLCB0aGUgZmlsZSBvbiBkaXNrIGlzIGhhc2hlZDogaWYgaXQgaXMgbm90IHRoZSBkYWVtb24ncyBvd24gbGFzdFxuICAgKiB3cml0ZSwgc29tZW9uZSBlbHNlIHdyb3RlIHRoZSBhY3RpdmUgdmVyc2lvbiAoRTIpLiBUaGF0IHRleHQgaXMga2VwdCBhcyBhXG4gICAqIE5FVyBhZ2VudCB2ZXJzaW9uLCBhbmQgb25seSB0aGVuIGlzIHRoZSBlZGl0IHdyaXR0ZW4uIERldGVjdGlvbiB1c2VkIHRvXG4gICAqIGRlcGVuZCBvbiB0aGUgd2F0Y2hlcidzIDYwIG1zIHNldHRsZSB0aW1lciBmaXJpbmcgYmVmb3JlIHRoZSBuZXh0XG4gICAqIGtleXN0cm9rZTsgYSBidXJzdCBvZiBlZGl0cyBhdCAzMCBtcyBjbG9iYmVyZWQgYW4gb3V0c2lkZSB3cml0ZVxuICAgKiB1bmFubm91bmNlZC4gTm93IG5vdGhpbmcgaXMgbG9zdCB3aGF0ZXZlciB0aGUgdGltaW5nIOKAlCB0aGUgb25lIHdpbmRvdyBsZWZ0XG4gICAqIGlzIHRoZSBtaWNyb3NlY29uZHMgYmV0d2VlbiB0aGlzIHJlYWQgYW5kIHRoaXMgd3JpdGUuXG4gICAqL1xuICBlZGl0KFxuICAgIHNsdWc6IHN0cmluZyxcbiAgICBuOiBudW1iZXIsXG4gICAgdGV4dDogc3RyaW5nLFxuICApOiB7IGRpcnR5Q2hhbmdlZDogYm9vbGVhbjsgcHJlc2VydmVkOiBWZXJzaW9uIHwgbnVsbCB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShzbHVnKTtcbiAgICBpZiAobiAhPT0gZC5hY3RpdmUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgdiR7bn0gaXMgbm90IHRoZSBhY3RpdmUgdmVyc2lvbiBvZiAke2Quc2x1Z30gKHYke2QuYWN0aXZlfSBpcykg4oCUIG9ubHkgdGhlIGFjdGl2ZSB2ZXJzaW9uIGlzIGVkaXRhYmxlYCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBjb25zdCBiZWZvcmUgPSB0aGlzLmlzRGlydHkoZCk7XG4gICAgY29uc3QgcGF0aCA9IHRoaXMudmVyc2lvblBhdGgoZCwgbik7XG4gICAgLy8gVGhlIGVkaXQgaXMgc3RhZ2VkIGluIGEgc2libGluZyBmaWxlIEZJUlNULCBzbyB0aGUgY2hlY2sgYmVsb3cgYW5kIHRoZVxuICAgIC8vIHJlbmFtZSB0aGF0IGxhbmRzIHRoZSBlZGl0IGFyZSBhZGphY2VudCBzeXNjYWxsczogdGhlIHdpbmRvdyBpbiB3aGljaCBhblxuICAgIC8vIG91dHNpZGUgd3JpdGUgY291bGQgc2xpcCBiZXR3ZWVuIHRoZW0gaXMgbWljcm9zZWNvbmRzLCBub3QgdGhlIGxlbmd0aCBvZlxuICAgIC8vIGEgbXVsdGktbWVnYWJ5dGUgd3JpdGUg4oCUIGFuZCBhIHdyaXRlIGxhbmRpbmcgQUZURVIgdGhlIHJlbmFtZSBnb2VzIHRvIHRoZVxuICAgIC8vIG5ldyBmaWxlLCB3aGVyZSB0aGUgd2F0Y2hlciBmaW5kcyBpdCBhbmQgcHJlc2VydmVzIGl0IHRvby5cbiAgICBjb25zdCBzdGFnZWQgPSBgJHtwYXRofS4ke3Byb2Nlc3MucGlkfS5lZGl0YDtcbiAgICB3cml0ZUZpbGVTeW5jKHN0YWdlZCwgdGV4dCk7XG4gICAgbGV0IHByZXNlcnZlZDogVmVyc2lvbiB8IG51bGwgPSBudWxsO1xuICAgIGxldCBvbkRpc2s6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBvbkRpc2sgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgb25EaXNrID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKG9uRGlzayAhPT0gbnVsbCAmJiAhdGhpcy5pc093bldyaXRlKHBhdGgsIG9uRGlzaykpXG4gICAgICBwcmVzZXJ2ZWQgPSB0aGlzLnByZXNlcnZlT3V0c2lkZShkLCBvbkRpc2spO1xuICAgIHRoaXMub3duZWQuc2V0KHBhdGgsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICByZW5hbWVTeW5jKHN0YWdlZCwgcGF0aCk7XG4gICAgdGhpcy5hY3RpdmVIYXNoLnNldChkLnNsdWcsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLmxhc3RBY3RpdmVUZXh0LnNldChkLnNsdWcsIHRleHQpO1xuICAgIHJldHVybiB7IGRpcnR5Q2hhbmdlZDogYmVmb3JlICE9PSB0aGlzLmlzRGlydHkoZCksIHByZXNlcnZlZCB9O1xuICB9XG5cbiAgLyoqIENvcHkgYSB2ZXJzaW9uIHRvIGEgbmV3IGZpbGU7IHRoZSBhZ2VudCB0aGVuIGVkaXRzIHRoYXQgZmlsZSB3aXRoIGl0cyBvd24gdG9vbHMuICovXG4gIG5ld1ZlcnNpb24ob3B0czogeyBkb2M/OiBzdHJpbmc7IGZyb20/OiBudW1iZXI7IGxhYmVsPzogc3RyaW5nOyBhdXRob3I6IFZlcnNpb25BdXRob3IgfSk6IHtcbiAgICBzbHVnOiBzdHJpbmc7XG4gICAgdmVyc2lvbjogVmVyc2lvbjtcbiAgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IGZyb20gPSBvcHRzLmZyb20gPz8gZC5hY3RpdmU7XG4gICAgdGhpcy52ZXJzaW9uT3JEaWUoZCwgZnJvbSk7XG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGZyb20pLCBcInV0ZjhcIik7XG4gICAgY29uc3QgbiA9IHRoaXMudGFrZVZlcnNpb24oZCk7XG4gICAgY29uc3QgcmVjOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPiA9IHtcbiAgICAgIG4sXG4gICAgICBhdXRob3I6IG9wdHMuYXV0aG9yLFxuICAgICAgZnJvbSxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIC4uLihvcHRzLmxhYmVsID8geyBsYWJlbDogb3B0cy5sYWJlbCB9IDoge30pLFxuICAgIH07XG4gICAgZC52ZXJzaW9ucy5wdXNoKHJlYyk7XG4gICAgdGhpcy53cml0ZU93bmVkKHRoaXMudmVyc2lvblBhdGgoZCwgbiksIHRleHQpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1ZywgdmVyc2lvbjogeyAuLi5yZWMsIHBhdGg6IHRoaXMudmVyc2lvblBhdGgoZCwgbikgfSB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFJlbW92ZSBhIHZlcnNpb24gYW5kIGl0cyBmaWxlIChFNDEpLlxuICAgKlxuICAgKiDim5QgVEhFIEFDVElWRSBWRVJTSU9OIENBTk5PVCBCRSBERUxFVEVELCBhbmQgcmVmdXNpbmcgaXMgYmV0dGVyIHRoYW5cbiAgICogcGlja2luZyBhIHJlcGxhY2VtZW50OiBjaG9vc2luZyBvbmUgZm9yIHRoZSBodW1hbiB3b3VsZCBzaWxlbnRseSBtb3ZlXG4gICAqIHdoZXJlIHRoZWlyIGVkaXRzIGFuZCBTYXZlIGFyZSBwb2ludGVkLCB3aGljaCBpcyB0aGUgb25lIHRoaW5nIEUyIGFuZCBFN1xuICAgKiBleGlzdCB0byBrZWVwIGV4cGxpY2l0LiBCZWNhdXNlIGV4YWN0bHkgb25lIHZlcnNpb24gaXMgYWx3YXlzIGFjdGl2ZSwgdGhpc1xuICAgKiBhbHNvIG1lYW5zIHRoZSBsYXN0IHZlcnNpb24gY2FuIG5ldmVyIGJlIGRlbGV0ZWQg4oCUIGEgZG9jdW1lbnQgYWx3YXlzIGhhc1xuICAgKiBzb21ldGhpbmcgdG8gZWRpdCwgd2l0aG91dCB0aGF0IGJlaW5nIGEgc2Vjb25kIHJ1bGUuXG4gICAqXG4gICAqIGBmcm9tYCBwb2ludGVycyBvbiBPVEhFUiB2ZXJzaW9ucyBhcmUgbGVmdCBhcyB0aGV5IGFyZS4gXCJNYWRlIGZyb20gdjJcIlxuICAgKiBzdGF5cyB0cnVlIGFmdGVyIHYyIGlzIGdvbmU7IGRlbGV0aW5nIGEgdmVyc2lvbiBpcyBub3QgcmV3cml0aW5nIHRoZVxuICAgKiBoaXN0b3J5IG9mIHRoZSBvbmVzIHRoYXQgcmVtYWluLlxuICAgKi9cbiAgZGVsZXRlVmVyc2lvbihvcHRzOiB7IGRvYz86IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyIH0pOiB7XG4gICAgc2x1Zzogc3RyaW5nO1xuICAgIHZlcnNpb246IG51bWJlcjtcbiAgICBsYWJlbD86IHN0cmluZztcbiAgICByZW1haW5pbmc6IG51bWJlcjtcbiAgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IHYgPSB0aGlzLnZlcnNpb25PckRpZShkLCBvcHRzLnZlcnNpb24pO1xuICAgIGlmIChvcHRzLnZlcnNpb24gPT09IGQuYWN0aXZlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYHYke29wdHMudmVyc2lvbn0gaXMgdGhlIGFjdGl2ZSB2ZXJzaW9uIG9mICR7ZC5zbHVnfSDigJQgYWN0aXZhdGUgYW5vdGhlciBvbmUgZmlyc3QsIGAgK1xuICAgICAgICAgIGB0aGVuIGRlbGV0ZSB0aGlzYCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICAvLyDim5QgTUFURVJJQUxJU0UgVEhFIENPVU5URVIgQkVGT1JFIFJFTU9WSU5HIFRIRSBSRUNPUkQuIGB0YWtlVmVyc2lvbmBcbiAgICAvLyBkZXJpdmVzIGl0IGxhemlseSBmcm9tIHRoZSB2ZXJzaW9ucyBQUkVTRU5ULCBzbyBvbiBhIGRvYyB0aGF0IGhhcyBuZXZlclxuICAgIC8vIGFsbG9jYXRlZCBvbmUgKGEgbWFuaWZlc3Qgd3JpdHRlbiBiZWZvcmUgRTQxLCByZXN0b3JlZCkgZGVsZXRpbmcgdGhlXG4gICAgLy8gaGlnaGVzdCB3b3VsZCBsZXQgdGhlIG5leHQgYWxsb2NhdGlvbiBkZXJpdmUgdGhlIHNhbWUgbnVtYmVyIGFnYWluLiBGb3VuZFxuICAgIC8vIGJ5IGRyaXZpbmcgaXQsIG5vdCBieSB0aGUgdW5pdCB0ZXN0IGFib3ZlIOKAlCB3aGljaCBhbGxvY2F0ZWQgZmlyc3QgYW5kIHNvXG4gICAgLy8gbmV2ZXIgaGFkIGEgY29sZCBjb3VudGVyLlxuICAgIGQubmV4dFZlcnNpb24gPz89IE1hdGgubWF4KC4uLmQudmVyc2lvbnMubWFwKCh4KSA9PiB4Lm4pKSArIDE7XG4gICAgY29uc3QgcGF0aCA9IHRoaXMudmVyc2lvblBhdGgoZCwgb3B0cy52ZXJzaW9uKTtcbiAgICBkLnZlcnNpb25zID0gZC52ZXJzaW9ucy5maWx0ZXIoKHgpID0+IHgubiAhPT0gb3B0cy52ZXJzaW9uKTtcbiAgICB0cnkge1xuICAgICAgcm1TeW5jKHBhdGgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gVGhlIHJlY29yZCBpcyB3aGF0IHRoZSBzZXNzaW9uIGJlbGlldmVzOyBhIGZpbGUgYWxyZWFkeSBnb25lIChhIGhhbmRcbiAgICAgIC8vIHRpZHksIGEgY3Jhc2ggYmV0d2VlbiB3cml0ZSBhbmQgcmVjb3JkKSBtdXN0IG5vdCBibG9jayByZW1vdmluZyBpdC5cbiAgICB9XG4gICAgdGhpcy5vd25lZC5kZWxldGUocGF0aCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNsdWc6IGQuc2x1ZyxcbiAgICAgIHZlcnNpb246IG9wdHMudmVyc2lvbixcbiAgICAgIC4uLih2LmxhYmVsID8geyBsYWJlbDogdi5sYWJlbCB9IDoge30pLFxuICAgICAgcmVtYWluaW5nOiBkLnZlcnNpb25zLmxlbmd0aCxcbiAgICB9O1xuICB9XG5cbiAgYWN0aXZhdGUob3B0czogeyBkb2M/OiBzdHJpbmc7IHZlcnNpb246IG51bWJlciB9KTogeyBzbHVnOiBzdHJpbmc7IHByZXZpb3VzOiBudW1iZXIgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIG9wdHMudmVyc2lvbik7XG4gICAgY29uc3QgcHJldmlvdXMgPSBkLmFjdGl2ZTtcbiAgICBkLmFjdGl2ZSA9IG9wdHMudmVyc2lvbjtcbiAgICAvLyBUaGUgbmV3IGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCBBUyBJVCBJUyBOT1cgaXMgdGhlIGJhc2VsaW5lIHRoZSBuZXh0XG4gICAgLy8gY2hlY2stYmVmb3JlLXdyaXRlIGNvbXBhcmVzIGFnYWluc3QuXG4gICAgdGhpcy5hZG9wdEFjdGl2ZShkLCByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKSk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBwcmV2aW91cyB9O1xuICB9XG5cbiAgLy8g4pSA4pSAIGNvbXBhcmluZyBhbmQgbWVyZ2luZyAoRTM2KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogVGhlIHRleHQgb2Ygb25lIHNpZGUgb2YgYSBjb21wYXJpc29uLiBgXCJvcmlnaW5hbFwiYCBpcyByZWFkIGZyb20gRElTSywgbm90XG4gICAqIGZyb20gYSBjYWNoZTogdGhlIHdob2xlIHBvaW50IG9mIGNvbXBhcmluZyBhZ2FpbnN0IGl0IGlzIHRvIHNlZSB3aGF0IHRoZVxuICAgKiBmaWxlIG9mIHJlY29yZCBhY3R1YWxseSBzYXlzIHJpZ2h0IG5vdywgaW5jbHVkaW5nIGEgY2hhbmdlIHNvbWVvbmUgZWxzZVxuICAgKiBtYWRlIHdoaWxlIHRoaXMgc2Vzc2lvbiB3YXMgb3Blbi5cbiAgICovXG4gIHByaXZhdGUgc2lkZVRleHQoZDogRG9jUmVjb3JkLCBzaWRlOiBEaWZmU2lkZSk6IHN0cmluZyB7XG4gICAgaWYgKHNpZGUgPT09IFwib3JpZ2luYWxcIikgcmV0dXJuIHJlYWRGaWxlU3luYyhkLm9yaWdpbmFsLCBcInV0ZjhcIik7XG4gICAgdGhpcy52ZXJzaW9uT3JEaWUoZCwgc2lkZSk7XG4gICAgcmV0dXJuIHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIHNpZGUpLCBcInV0ZjhcIik7XG4gIH1cblxuICAvKiogQ29tcGFyZSB0aGUgQUNUSVZFIHZlcnNpb24gKGxlZnQpIGFnYWluc3QgYW5vdGhlciBzaWRlIChyaWdodCkuICovXG4gIGNvbXBhcmUob3B0czogeyBkb2M/OiBzdHJpbmc7IGFnYWluc3Q6IERpZmZTaWRlIH0pOiBEaWZmUGF5bG9hZCB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGlmIChvcHRzLmFnYWluc3QgPT09IGQuYWN0aXZlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYHYke2QuYWN0aXZlfSBpcyB0aGUgYWN0aXZlIHZlcnNpb24gb2YgJHtkLnNsdWd9IOKAlCBjb21wYXJpbmcgaXQgd2l0aCBpdHNlbGYgc2F5cyBub3RoaW5nYCxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICBjb25zdCBsZWZ0ID0gcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIik7XG4gICAgcmV0dXJuIHtcbiAgICAgIGRvYzogZC5zbHVnLFxuICAgICAgYWN0aXZlOiBkLmFjdGl2ZSxcbiAgICAgIGFnYWluc3Q6IG9wdHMuYWdhaW5zdCxcbiAgICAgIGRpZmY6IGRpZmZUZXh0KGxlZnQsIHRoaXMuc2lkZVRleHQoZCwgb3B0cy5hZ2FpbnN0KSksXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUYWtlIG5hbWVkIGh1bmtzIGZyb20gYGFnYWluc3RgIGludG8gdGhlIGFjdGl2ZSB2ZXJzaW9uLlxuICAgKlxuICAgKiDim5QgVEhFIFdSSVRFIEdPRVMgVEhST1VHSCBgZWRpdGAsIHdoaWNoIGlzIHdoYXQgbWFrZXMgYSBtZXJnZSBvYmV5IGV2ZXJ5XG4gICAqIHJ1bGUgYW4gb3JkaW5hcnkga2V5c3Ryb2tlIG9iZXlzOiBpdCBsYW5kcyBvbiB0aGUgYWN0aXZlIHZlcnNpb24gYW5kIG5ldmVyXG4gICAqIHRoZSBvcmlnaW5hbCAoRTcpLCBhbmQgY2hlY2stYmVmb3JlLXdyaXRlIHByZXNlcnZlcyBhbiBvdXRzaWRlIHdyaXRlIGFzIGFcbiAgICogbmV3IHZlcnNpb24gZmlyc3QgKEUyKS4gQSBtZXJnZSB3cml0aW5nIHRoZSBmaWxlIGRpcmVjdGx5IHdvdWxkIGJlIHRoZSBvbmVcbiAgICogcGF0aCBpbnRvIHRoZSBkb2N1bWVudCB0aGF0IGNvdWxkIHNpbGVudGx5IGNsb2JiZXIgdGhlIGFnZW50LlxuICAgKi9cbiAgbWVyZ2Uob3B0czogeyBkb2M/OiBzdHJpbmc7IGFnYWluc3Q6IERpZmZTaWRlOyBodW5rczogbnVtYmVyW10gfSk6IHtcbiAgICBzbHVnOiBzdHJpbmc7XG4gICAgdmVyc2lvbjogbnVtYmVyO1xuICAgIHRleHQ6IHN0cmluZztcbiAgICBhcHBsaWVkOiBudW1iZXI7XG4gICAgcHJlc2VydmVkOiBWZXJzaW9uIHwgbnVsbDtcbiAgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IHBheWxvYWQgPSB0aGlzLmNvbXBhcmUoeyBkb2M6IGQuc2x1ZywgYWdhaW5zdDogb3B0cy5hZ2FpbnN0IH0pO1xuICAgIGNvbnN0IGtub3duID0gbmV3IFNldChwYXlsb2FkLmRpZmYuaHVua3MubWFwKChoKSA9PiBoLmlkKSk7XG4gICAgY29uc3QgbWlzc2luZyA9IG9wdHMuaHVua3MuZmlsdGVyKChpZCkgPT4gIWtub3duLmhhcyhpZCkpO1xuICAgIGlmIChtaXNzaW5nLmxlbmd0aClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Quc2x1Z30gaGFzIG5vIGh1bmsgJHttaXNzaW5nLmpvaW4oXCIsIFwiKX0gYWdhaW5zdCAke3NpZGVOYW1lKG9wdHMuYWdhaW5zdCwgZC5uYW1lKX0g4oCUIGAgK1xuICAgICAgICAgIGBpdCBoYXMgJHtrbm93bi5zaXplID09PSAwID8gXCJub25lXCIgOiBgMS4uJHtNYXRoLm1heCguLi5rbm93bil9YH0uIFJ1biBkaWZmIGFnYWluOiBgICtcbiAgICAgICAgICBgdGhlIHRleHQgY2hhbmdlZCB1bmRlciB0aGUgbnVtYmVycy5gLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIGNvbnN0IGJlZm9yZSA9IHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHRleHQgPSBhcHBseUh1bmtzKGJlZm9yZSwgcGF5bG9hZC5kaWZmLmh1bmtzLCBvcHRzLmh1bmtzKTtcbiAgICBjb25zdCB7IHByZXNlcnZlZCB9ID0gdGhpcy5lZGl0KGQuc2x1ZywgZC5hY3RpdmUsIHRleHQpO1xuICAgIHJldHVybiB7XG4gICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgIHRleHQsXG4gICAgICBhcHBsaWVkOiBvcHRzLmh1bmtzLmZpbHRlcigoaWQpID0+IGtub3duLmhhcyhpZCkpLmxlbmd0aCxcbiAgICAgIHByZXNlcnZlZCxcbiAgICB9O1xuICB9XG5cbiAgLy8g4pSA4pSAIG5vdGVzIChFNDUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKiBUaGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IOKAlCB3aGF0IGV2ZXJ5IG5vdGUgaXMgYW5jaG9yZWQgYWdhaW5zdC4gKi9cbiAgcHJpdmF0ZSBhY3RpdmVUZXh0KGQ6IERvY1JlY29yZCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpO1xuICB9XG5cbiAgLyoqIFBsYWNlIGV2ZXJ5IG5vdGUgaW4gdGhlIGFjdGl2ZSB0ZXh0IGFzIGl0IHN0YW5kcyBub3cuICovXG4gIHByaXZhdGUgcGxhY2VkTm90ZXMoZDogRG9jUmVjb3JkKTogUGxhY2VkTm90ZVtdIHtcbiAgICBjb25zdCBub3RlcyA9IGQubm90ZXMgPz8gW107XG4gICAgaWYgKG5vdGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IHRleHQgPSB0aGlzLmFjdGl2ZVRleHQoZCk7XG4gICAgcmV0dXJuIG5vdGVzLm1hcCgobikgPT4gKHsgLi4ubiwgLi4uZmluZEFuY2hvcih0ZXh0LCBuKSB9KSk7XG4gIH1cblxuICAvKipcbiAgICogTm90ZSBhIHJhbmdlIG9mIHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgKHRoZSBodW1hbiBzZWxlY3RzKSBvciBhIHF1b3RlXG4gICAqIGZvdW5kIGluIGl0ICh0aGUgYWdlbnQgcXVvdGVzIOKAlCBpdCBoYXMgbm8gb2Zmc2V0cykuXG4gICAqL1xuICBhZGROb3RlKG9wdHM6IHtcbiAgICBkb2M/OiBzdHJpbmc7XG4gICAgYm9keTogc3RyaW5nO1xuICAgIHdobzogVmVyc2lvbkF1dGhvcjtcbiAgICByYW5nZT86IHsgZnJvbTogbnVtYmVyOyB0bzogbnVtYmVyIH07XG4gICAgcXVvdGU/OiBzdHJpbmc7XG4gIH0pOiB7IHNsdWc6IHN0cmluZzsgbm90ZTogTm90ZTsgaG93OiBcInNlbGVjdGlvblwiIHwgXCJxdW90ZVwiIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBib2R5ID0gb3B0cy5ib2R5LnRyaW0oKTtcbiAgICBpZiAoIWJvZHkpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXCJhIG5vdGUgbmVlZHMgc29tZXRoaW5nIHdyaXR0ZW4gaW4gaXRcIiwgNDAwKTtcbiAgICBjb25zdCB0ZXh0ID0gdGhpcy5hY3RpdmVUZXh0KGQpO1xuXG4gICAgbGV0IGFuY2hvcjogQW5jaG9yO1xuICAgIGlmIChvcHRzLnJhbmdlKSB7XG4gICAgICBjb25zdCB7IGZyb20sIHRvIH0gPSBvcHRzLnJhbmdlO1xuICAgICAgaWYgKGZyb20gPCAwIHx8IHRvID4gdGV4dC5sZW5ndGggfHwgZnJvbSA+PSB0bylcbiAgICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgICBgJHtmcm9tfS4uJHt0b30gaXMgbm90IGEgcmFuZ2UgaW4gdiR7ZC5hY3RpdmV9IG9mICR7ZC5zbHVnfSAoJHt0ZXh0Lmxlbmd0aH0gY2hhcmFjdGVycylgLFxuICAgICAgICAgIDQwMCxcbiAgICAgICAgKTtcbiAgICAgIGFuY2hvciA9IGFuY2hvck9mKHRleHQsIGZyb20sIHRvKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgcXVvdGUgPSBvcHRzLnF1b3RlID8/IFwiXCI7XG4gICAgICBpZiAoIXF1b3RlKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwiYSBub3RlIG5lZWRzIGEgc2VsZWN0aW9uIG9yIGEgcXVvdGVcIiwgNDAwKTtcbiAgICAgIGNvbnN0IGF0ID0gdGV4dC5pbmRleE9mKHF1b3RlKTtcbiAgICAgIC8vIOKblCBSRUZVU0VELCBub3QgYW5jaG9yZWQgaG9wZWZ1bGx5LiBBIHF1b3RlIHRoZSBhY3RpdmUgdmVyc2lvbiBkb2VzIG5vdFxuICAgICAgLy8gY29udGFpbiB3b3VsZCBiZWNvbWUgYW4gb3JwaGFuIHRoZSBtb21lbnQgaXQgd2FzIG1hZGUsIHdoaWNoIHJlYWRzIGFzXG4gICAgICAvLyBcInRoZSB0ZXh0IGNoYW5nZWRcIiB3aGVuIHRoZSB0cnV0aCBpcyBcInlvdSBxdW90ZWQgc29tZXRoaW5nIGVsc2VcIi5cbiAgICAgIGlmIChhdCA9PT0gLTEpXG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgICAgYHYke2QuYWN0aXZlfSBvZiAke2Quc2x1Z30gZG9lcyBub3QgY29udGFpbiB0aGF0IHRleHQg4oCUIHF1b3RlIGl0IGV4YWN0bHkgYXMgaXQgYXBwZWFyc2AsXG4gICAgICAgICAgNDA0LFxuICAgICAgICApO1xuICAgICAgYW5jaG9yID0gYW5jaG9yT2YodGV4dCwgYXQsIGF0ICsgcXVvdGUubGVuZ3RoKTtcbiAgICB9XG5cbiAgICBjb25zdCBub3RlOiBOb3RlID0ge1xuICAgICAgaWQ6IGBuJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDYpfWAsXG4gICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgIC4uLmFuY2hvcixcbiAgICAgIGJvZHksXG4gICAgICB3aG86IG9wdHMud2hvLFxuICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgcmVzb2x2ZWQ6IGZhbHNlLFxuICAgIH07XG4gICAgZC5ub3RlcyA9IFsuLi4oZC5ub3RlcyA/PyBbXSksIG5vdGVdO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1Zywgbm90ZSwgaG93OiBvcHRzLnJhbmdlID8gXCJzZWxlY3Rpb25cIiA6IFwicXVvdGVcIiB9O1xuICB9XG5cbiAgLyoqIE5vdGVzIG9uIGEgZG9jdW1lbnQsIHBsYWNlZCDigJQgYGFsbGAgaW5jbHVkZXMgdGhlIHJlc29sdmVkIG9uZXMuICovXG4gIG5vdGVzT2Yob3B0czogeyBkb2M/OiBzdHJpbmc7IGFsbD86IGJvb2xlYW4gfSk6IHsgc2x1Zzogc3RyaW5nOyBub3RlczogUGxhY2VkTm90ZVtdIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBwbGFjZWQgPSB0aGlzLnBsYWNlZE5vdGVzKGQpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1Zywgbm90ZXM6IG9wdHMuYWxsID8gcGxhY2VkIDogcGxhY2VkLmZpbHRlcigobikgPT4gIW4ucmVzb2x2ZWQpIH07XG4gIH1cblxuICBwcml2YXRlIG5vdGVPckRpZShkOiBEb2NSZWNvcmQsIGlkOiBzdHJpbmcpOiBOb3RlIHtcbiAgICBjb25zdCBub3RlID0gKGQubm90ZXMgPz8gW10pLmZpbmQoKG4pID0+IG4uaWQgPT09IGlkKTtcbiAgICBpZiAoIW5vdGUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHtkLnNsdWd9IGhhcyBubyBub3RlICR7aWR9YCxcbiAgICAgICAgNDA0LFxuICAgICAgICAoZC5ub3RlcyA/PyBbXSkubWFwKChuKSA9PiBuLmlkKSxcbiAgICAgICk7XG4gICAgcmV0dXJuIG5vdGU7XG4gIH1cblxuICAvKiogQ2hhbmdlIHdoYXQgYSBub3RlIFNBWVMuIEl0cyBhbmNob3IgaXMgdW50b3VjaGVkIOKAlCBpdCBpcyBzdGlsbCBhYm91dCB0aGVcbiAgICogIHNhbWUgcGFzc2FnZSwgd2hpY2ggaXMgd2h5IGVkaXRpbmcgZG9lcyBub3QgcmUtcXVvdGUgKEU0NikuICovXG4gIGVkaXROb3RlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBpZDogc3RyaW5nOyBib2R5OiBzdHJpbmcgfSk6IHsgc2x1Zzogc3RyaW5nOyBub3RlOiBOb3RlIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBub3RlID0gdGhpcy5ub3RlT3JEaWUoZCwgb3B0cy5pZCk7XG4gICAgY29uc3QgYm9keSA9IG9wdHMuYm9keS50cmltKCk7XG4gICAgaWYgKCFib2R5KSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwiYSBub3RlIG5lZWRzIHNvbWV0aGluZyB3cml0dGVuIGluIGl0XCIsIDQwMCk7XG4gICAgbm90ZS5ib2R5ID0gYm9keTtcbiAgICBub3RlLmVkaXRlZEF0ID0gRGF0ZS5ub3coKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIG5vdGUgfTtcbiAgfVxuXG4gIHJlc29sdmVOb3RlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBpZDogc3RyaW5nOyByZXNvbHZlZDogYm9vbGVhbiB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICBub3RlOiBOb3RlO1xuICB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3Qgbm90ZSA9IHRoaXMubm90ZU9yRGllKGQsIG9wdHMuaWQpO1xuICAgIG5vdGUucmVzb2x2ZWQgPSBvcHRzLnJlc29sdmVkO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1Zywgbm90ZSB9O1xuICB9XG5cbiAgcmVtb3ZlTm90ZShvcHRzOiB7IGRvYz86IHN0cmluZzsgaWQ6IHN0cmluZyB9KTogeyBzbHVnOiBzdHJpbmc7IG5vdGU6IE5vdGUgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IG5vdGUgPSB0aGlzLm5vdGVPckRpZShkLCBvcHRzLmlkKTtcbiAgICBkLm5vdGVzID0gKGQubm90ZXMgPz8gW10pLmZpbHRlcigobikgPT4gbi5pZCAhPT0gb3B0cy5pZCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBub3RlIH07XG4gIH1cblxuICAvKiogU2F2ZTogdGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCBvdmVyIHRoZSBvcmlnaW5hbC4gVGhlIE9OTFkgd3JpdGUgdG8gaXQgKEU3KS4gKi9cbiAgc2F2ZShzbHVnOiBzdHJpbmcpOiB7IG9yaWdpbmFsOiBzdHJpbmc7IHZlcnNpb246IG51bWJlciB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShzbHVnKTtcbiAgICAvLyDim5QgVkVSSUZZLVBBU1MgRklYIDFjOiBTYXZlIHdyaXRlcyBvbmx5IGFuIG9yaWdpbmFsIGFkbWl0dGVkIGJ5XG4gICAgLy8gYG9wZW5QYXRoYCAoYSBkb2MtdHlwZSBmaWxlIGluc2lkZSBhIGNvbnRleHQgZW50cnkpLiBDaGVja2VkIGFnYWluIGhlcmVcbiAgICAvLyBzbyBubyBvdGhlciBwYXRoIGludG8gdGhlIG1hbmlmZXN0IOKAlCBhIGhhbmQtZWRpdGVkIG9uZSwgYSBmdXR1cmUgdmVyYiDigJRcbiAgICAvLyBjYW4gdHVybiBTYXZlIGludG8gXCJ3cml0ZSBhbnkgZmlsZVwiLlxuICAgIGlmICghZC5hZG1pdHRlZCB8fCAhaXNEb2NOYW1lKGQub3JpZ2luYWwpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYHJlZnVzaW5nIHRvIHNhdmUgJHtkLm9yaWdpbmFsfTogaXQgd2FzIG5vdCBvcGVuZWQgZnJvbSB0aGUgY29udGV4dGAsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpO1xuICAgIHRoaXMud3JpdGVPd25lZChkLm9yaWdpbmFsLCB0ZXh0KTtcbiAgICBkLm9yaWdpbmFsSGFzaCA9IGNvbnRlbnRIYXNoKHRleHQpO1xuICAgIGQub3V0c2lkZUNoYW5nZWQgPSBmYWxzZTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBvcmlnaW5hbDogZC5vcmlnaW5hbCwgdmVyc2lvbjogZC5hY3RpdmUgfTtcbiAgfVxuXG4gIC8qKiBSZXZlcnQ6IHRoZSBvcmlnaW5hbCdzIHRleHQgYmFjayBvdmVyIHRoZSBhY3RpdmUgdmVyc2lvbi4gKi9cbiAgcmV2ZXJ0KHNsdWc6IHN0cmluZyk6IHsgdmVyc2lvbjogbnVtYmVyOyB0ZXh0OiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyhkLm9yaWdpbmFsLCBcInV0ZjhcIik7XG4gICAgZC5vcmlnaW5hbEhhc2ggPSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgICBkLm91dHNpZGVDaGFuZ2VkID0gZmFsc2U7XG4gICAgdGhpcy53cml0ZUFjdGl2ZShkLCB0ZXh0KTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyB2ZXJzaW9uOiBkLmFjdGl2ZSwgdGV4dCB9O1xuICB9XG5cbiAgcHJpdmF0ZSBpc0RpcnR5KGQ6IERvY1JlY29yZCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiAodGhpcy5hY3RpdmVIYXNoLmdldChkLnNsdWcpID8/IFwiXCIpICE9PSBkLm9yaWdpbmFsSGFzaDtcbiAgfVxuXG4gIC8vIOKUgOKUgCB0aGUgd2F0Y2hlcidzIHF1ZXN0aW9uOiB3aG9zZSB3cml0ZSB3YXMgdGhhdD8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIENsYXNzaWZ5IG9uZSBmaWxlc3lzdGVtIGV2ZW50LiBSZWFkcyB0aGUgZmlsZTsgcmV0dXJucyBgbnVsbGAgd2hlbiBpdCBpc1xuICAgKiB0aGUgZGFlbW9uJ3Mgb3duIHdyaXRlLCB1bmNoYW5nZWQsIGdvbmUsIG9yIG5vdCBvdXJzIHRvIGNhcmUgYWJvdXQuXG4gICAqL1xuICBvbkZpbGVFdmVudChhYnM6IHN0cmluZyk6IEZpbGVFdmVudCB8IG51bGwge1xuICAgIC8vIEEgdmVyc2lvbiBmaWxlIHVuZGVyIGRvY3MvPHNsdWc+L3ZOLmV4dD9cbiAgICBpZiAoYWJzLnN0YXJ0c1dpdGgodGhpcy5kb2NzRGlyICsgc2VwKSkge1xuICAgICAgY29uc3QgcmVzdCA9IGFicy5zbGljZSh0aGlzLmRvY3NEaXIubGVuZ3RoICsgMSkuc3BsaXQoc2VwKTtcbiAgICAgIGlmIChyZXN0Lmxlbmd0aCAhPT0gMikgcmV0dXJuIG51bGw7XG4gICAgICBjb25zdCBbc2x1ZywgZmlsZV0gPSByZXN0IGFzIFtzdHJpbmcsIHN0cmluZ107XG4gICAgICBjb25zdCBkID0gdGhpcy5tLmRvY3MuZmluZCgoeCkgPT4geC5zbHVnID09PSBzbHVnKTtcbiAgICAgIGNvbnN0IG1hdGNoID0gL152KFxcZCspKFxcLlthLXpdKykkLy5leGVjKGZpbGUpO1xuICAgICAgaWYgKCFkIHx8ICFtYXRjaCB8fCBtYXRjaFsyXSAhPT0gZC5leHQpIHJldHVybiBudWxsO1xuICAgICAgY29uc3QgbiA9IE51bWJlcihtYXRjaFsxXSk7XG4gICAgICBsZXQgdGV4dDogc3RyaW5nO1xuICAgICAgdHJ5IHtcbiAgICAgICAgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICAgIGlmICh0aGlzLmlzT3duV3JpdGUoYWJzLCB0ZXh0KSkgcmV0dXJuIG51bGw7XG4gICAgICBpZiAoIWQudmVyc2lvbnMuc29tZSgodikgPT4gdi5uID09PSBuKSkge1xuICAgICAgICAvLyBUaGUgYWdlbnQgd3JvdGUgYSB2ZXJzaW9uIGZpbGUgYnkgaGFuZCByYXRoZXIgdGhhbiB0aHJvdWdoXG4gICAgICAgIC8vIGB2ZXJzaW9uLW5ld2Ag4oCUIGFkb3B0IGl0IHJhdGhlciB0aGFuIGxlYXZlIGEgZmlsZSB0aGUgc3VyZmFjZSBjYW5ub3Qgc2VlLlxuICAgICAgICBkLnZlcnNpb25zLnB1c2goeyBuLCBhdXRob3I6IFwiYWdlbnRcIiwgY3JlYXRlZEF0OiBEYXRlLm5vdygpIH0pO1xuICAgICAgICBkLnZlcnNpb25zLnNvcnQoKGEsIGIpID0+IGEubiAtIGIubik7XG4gICAgICAgIHRoaXMub3duZWQuc2V0KGFicywgY29udGVudEhhc2godGV4dCkpO1xuICAgICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgICAgcmV0dXJuIHsga2luZDogXCJ2ZXJzaW9uLmNyZWF0ZWRcIiwgZG9jOiBkLnNsdWcsIHZlcnNpb246IG4sIHBhdGg6IGFicyB9O1xuICAgICAgfVxuICAgICAgaWYgKG4gPT09IGQuYWN0aXZlKSB7XG4gICAgICAgIC8vIEUyLCByZWZ1c2VkIGFuZCBSRS1MQUJFTExFRDogdGhlIG91dHNpZGUgdGV4dCBiZWNvbWVzIGEgbmV3IGFnZW50XG4gICAgICAgIC8vIHZlcnNpb24sIGFuZCB0aGUgYWN0aXZlIHZlcnNpb24gZ29lcyBiYWNrIHRvIHRoZSBkYWVtb24ncyBvd24gbGFzdFxuICAgICAgICAvLyB0ZXh0IOKAlCBzbyB0aGUgYWN0aXZlIHZlcnNpb24gb25seSBldmVyIGhvbGRzIHdoYXQgdGhlIGh1bWFuIHR5cGVkLFxuICAgICAgICAvLyBhbmQgbm90aGluZyBhbnlvbmUgd3JvdGUgaXMgbG9zdCAodmVyaWZ5LXBhc3MgZml4IDQsIHdhdGNoZXIgaGFsZikuXG4gICAgICAgIGNvbnN0IGtlcHQgPSB0aGlzLnByZXNlcnZlT3V0c2lkZShkLCB0ZXh0KTtcbiAgICAgICAgdGhpcy53cml0ZUFjdGl2ZShkLCB0aGlzLmxhc3RBY3RpdmVUZXh0LmdldChkLnNsdWcpID8/IHRleHQpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGtpbmQ6IFwiYWN0aXZlLm91dHNpZGVcIixcbiAgICAgICAgICBkb2M6IGQuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiBuLFxuICAgICAgICAgIHBhdGg6IGFicyxcbiAgICAgICAgICBwcmVzZXJ2ZWRBczoga2VwdC5uLFxuICAgICAgICAgIHByZXNlcnZlZFBhdGg6IGtlcHQucGF0aCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIHRoaXMub3duZWQuc2V0KGFicywgY29udGVudEhhc2godGV4dCkpO1xuICAgICAgcmV0dXJuIHsga2luZDogXCJ2ZXJzaW9uLmNoYW5nZWRcIiwgZG9jOiBkLnNsdWcsIHZlcnNpb246IG4sIHRleHQsIGFjdGl2ZTogZmFsc2UgfTtcbiAgICB9XG5cbiAgICAvLyBBbiBvcGVuZWQgb3JpZ2luYWwg4oCUIGJ5IGl0cyBzdG9yZWQgcGF0aCwgb3IgYnkgcmVhbHBhdGggZm9yIGEgc3ltbGluaz9cbiAgICBjb25zdCBkID0gdGhpcy5tLmRvY3MuZmluZCgoeCkgPT4geC5vcmlnaW5hbCA9PT0gYWJzIHx8IHJlYWxPcih4Lm9yaWdpbmFsKSA9PT0gYWJzKTtcbiAgICBpZiAoZCkge1xuICAgICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICAgIHRyeSB7XG4gICAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgICBjb25zdCBoID0gY29udGVudEhhc2godGV4dCk7XG4gICAgICBpZiAoaCA9PT0gZC5vcmlnaW5hbEhhc2gpIHJldHVybiBudWxsOyAvLyBvdXIgb3duIHNhdmUsIG9yIG5vIGNoYW5nZVxuICAgICAgY29uc3QgY2xlYW4gPSAhdGhpcy5pc0RpcnR5KGQpO1xuICAgICAgaWYgKGNsZWFuKSB7XG4gICAgICAgIGQub3JpZ2luYWxIYXNoID0gaDtcbiAgICAgICAgdGhpcy53cml0ZUFjdGl2ZShkLCB0ZXh0KTtcbiAgICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAga2luZDogXCJvcmlnaW5hbC5yZWxvYWRlZFwiLFxuICAgICAgICAgIGRvYzogZC5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IGQuYWN0aXZlLFxuICAgICAgICAgIHRleHQsXG4gICAgICAgICAgb3JpZ2luYWw6IGQub3JpZ2luYWwsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBpZiAoZC5vdXRzaWRlQ2hhbmdlZCkgcmV0dXJuIG51bGw7IC8vIGFscmVhZHkgYXNrZWRcbiAgICAgIGQub3V0c2lkZUNoYW5nZWQgPSB0cnVlO1xuICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICByZXR1cm4geyBraW5kOiBcIm9yaWdpbmFsLmNvbmZsaWN0XCIsIGRvYzogZC5zbHVnLCBvcmlnaW5hbDogZC5vcmlnaW5hbCB9O1xuICAgIH1cblxuICAgIC8vIFNvbWV0aGluZyB1bmRlciBhIG1pcnJvcmVkIHJvb3Q6IHRoZSB0cmVlIG1heSBoYXZlIGNoYW5nZWQuXG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgJiYgKGFicyA9PT0gZS5yb290IHx8IGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpKSB7XG4gICAgICAgIHJldHVybiB0aGlzLnJlc2NhbihlLmlkKSA/IHsga2luZDogXCJ0cmVlXCIsIGVudHJ5SWQ6IGUuaWQgfSA6IG51bGw7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgLy8g4pSA4pSAIHN0cnVjdHVyZSAoRTIy4oCTRTI0KTogcmVhbCBjaGFuZ2VzIG9uIGRpc2ssIG9uZSBwYXRoIGZvciBib3RoIHBhcnRpZXMg4pSA4pSAXG4gIC8vXG4gIC8vIEV2ZXJ5IG1ldGhvZCBiZWxvdyBkb2VzIHRoZSBjaGFuZ2UgT04gRElTSyBhbmQgdGhlbiBicmluZ3MgdGhlIGNvbnRleHRcbiAgLy8gbW9kZWwgYmFjayBpbiBsaW5lIHdpdGggaXQuIFRoZSBzdXJmYWNlIHJlYWNoZXMgdGhlbSB0aHJvdWdoIG1lbnVzIGFuZFxuICAvLyBkcmFnIGFuZCBkcm9wLCB0aGUgYWdlbnQgdGhyb3VnaCBDTEkgdmVyYnM7IHRoZSBkYWVtb24gYW5ub3VuY2VzIGVhY2ggb25lXG4gIC8vIHVuZGVyIHRoZSBuYW1lIG9mIHdob2V2ZXIgZGlkIGl0LiBUd28gcnVsZXMgaG9sZCB0aHJvdWdob3V0OlxuICAvL1xuICAvLyAtIE5PVEhJTkcgSVMgREVMRVRFRC4gYGhpZGVgIHRha2VzIGEgbm9kZSBvdXQgb2YgU2NyaXB0b3JpdW07IHRoZSBmaWxlIHN0YXlzLlxuICAvLyAtIE5PVEhJTkcgSVMgT1ZFUldSSVRURU4uIEEgZGVzdGluYXRpb24gdGhhdCBleGlzdHMgaXMgcmVmdXNlZCAoYW4gZXhwbGljaXRcbiAgLy8gICBuYW1lKSBvciBnaXZlbiBhIGZyZWUgbmFtZSAoYSBkZWZhdWx0IG9uZSwgYSBkcm9wKTsgZmlsZXMgYXJlIGNyZWF0ZWRcbiAgLy8gICB3aXRoIHRoZSBleGNsdXNpdmUgZmxhZywgc28gYSByYWNlIGNhbm5vdCBjbG9iYmVyIGVpdGhlci5cblxuICAvKiogRTIzOiB3aGVyZSBkcm9wcyBhbmQgbmV3IHRvcC1sZXZlbCBkb2N1bWVudHMgbGFuZC4gKi9cbiAgZ2V0IHdvcmtzcGFjZSgpOiBzdHJpbmcge1xuICAgIHJldHVybiB0aGlzLm0ud29ya3NwYWNlID8/IGhvbWVkaXIoKTtcbiAgfVxuXG4gIHNldFdvcmtzcGFjZShyYXdQYXRoOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZyB9IHtcbiAgICBjb25zdCBhYnMgPSByZXNvbHZlKHJhd1BhdGgpO1xuICAgIGxldCBpc0RpciA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICBpc0RpciA9IHN0YXRTeW5jKGFicykuaXNEaXJlY3RvcnkoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vIHN1Y2ggZm9sZGVyOiAke2Fic31gLCA0MDQpO1xuICAgIH1cbiAgICBpZiAoIWlzRGlyKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGB0aGUgd29ya3NwYWNlIG11c3QgYmUgYSBmb2xkZXI6ICR7YWJzfWAsIDQwMCk7XG4gICAgdGhpcy5tLndvcmtzcGFjZSA9IGFicztcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBIb3cgYSBwYXRoIHJlYWRzIGluIGEgY2hhdCBsaW5lOiBgc2V0L3JlbGAgaW5zaWRlIGEgc2V0LCBhIHNpbmdsZVxuICAgKiBkb2N1bWVudCdzIGZpbGUgbmFtZSwgYHdvcmtzcGFjZS/igKZgIGluIHRoZSB3b3Jrc3BhY2UsIGVsc2UgYH4v4oCmYC5cbiAgICovXG4gIGRpc3BsYXkoYWJzOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiKSB7XG4gICAgICAgIGlmIChhYnMgPT09IGUucm9vdCkgcmV0dXJuIGUubGFiZWw7XG4gICAgICAgIGlmIChhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSByZXR1cm4gYCR7ZS5sYWJlbH0vJHt0b1Bvc2l4KHJlbGF0aXZlKGUucm9vdCwgYWJzKSl9YDtcbiAgICAgIH0gZWxzZSBpZiAoZS5ub2Rlcy5zb21lKChuKSA9PiBqb2luKGUucm9vdCwgbi5yZWwpID09PSBhYnMpKSByZXR1cm4gZS5sYWJlbDtcbiAgICB9XG4gICAgaWYgKGFicy5zdGFydHNXaXRoKHRoaXMud29ya3NwYWNlICsgc2VwKSlcbiAgICAgIHJldHVybiBgd29ya3NwYWNlLyR7dG9Qb3NpeChyZWxhdGl2ZSh0aGlzLndvcmtzcGFjZSwgYWJzKSl9YDtcbiAgICBjb25zdCBob21lID0gaG9tZWRpcigpO1xuICAgIHJldHVybiBhYnMgPT09IGhvbWUgPyBcIn5cIiA6IGFicy5zdGFydHNXaXRoKGhvbWUgKyBzZXApID8gYH4ke2Ficy5zbGljZShob21lLmxlbmd0aCl9YCA6IGFicztcbiAgfVxuXG4gIC8qKlxuICAgKiBgYWJzYCBzcGVsbGVkIHRoZSB3YXkgdGhlIGNvbnRleHQgc3BlbGxzIGl0LiBBIGNhbGxlciB3aG9zZSBjd2QgaXMgYVxuICAgKiByZWFscGF0aCAoL3ByaXZhdGUvdmFyL+KApiBmb3IgL3Zhci/igKYsIGEgc3ltbGlua2VkIGZvbGRlcikgbmFtZXMgdGhlIHNhbWVcbiAgICogcGxhY2UgZGlmZmVyZW50bHksIGFuZCBpdCBtdXN0IGxhbmQgb24gdGhlIHNhbWUgbm9kZS5cbiAgICovXG4gIHByaXZhdGUgc3BlbGwoYWJzOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGlmICh0aGlzLm0uY29udGV4dC5zb21lKChlKSA9PiBhYnMgPT09IGUucm9vdCB8fCBhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSkgcmV0dXJuIGFicztcbiAgICBjb25zdCByZWFsID0gcmVhbE9yKGFicyk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBjb25zdCByZWFsUm9vdCA9IHJlYWxPcihlLnJvb3QpO1xuICAgICAgaWYgKHJlYWwgPT09IHJlYWxSb290KSByZXR1cm4gZS5yb290O1xuICAgICAgaWYgKHJlYWwuc3RhcnRzV2l0aChyZWFsUm9vdCArIHNlcCkpIHJldHVybiBqb2luKGUucm9vdCwgcmVsYXRpdmUocmVhbFJvb3QsIHJlYWwpKTtcbiAgICB9XG4gICAgcmV0dXJuIGFicztcbiAgfVxuXG4gIHByaXZhdGUgaXNXb3Jrc3BhY2UoYWJzOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gYWJzID09PSB0aGlzLndvcmtzcGFjZSB8fCByZWFsT3IoYWJzKSA9PT0gcmVhbE9yKHRoaXMud29ya3NwYWNlKTtcbiAgfVxuXG4gIC8qKiBUaGUgbWlycm9yZWQgZW50cnkgdGhhdCBjb3ZlcnMgYGFic2AgKGl0cyByb290LCBvciBhbnl0aGluZyB1bmRlciBpdCksIGlmIGFueS4gKi9cbiAgcHJpdmF0ZSBjb3ZlcmluZ0VudHJ5KGFiczogc3RyaW5nLCBleGNlcHQ/OiBzdHJpbmcpOiBDb250ZXh0RW50cnkgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLm0uY29udGV4dC5maW5kKFxuICAgICAgKGUpID0+XG4gICAgICAgIGUuaWQgIT09IGV4Y2VwdCAmJlxuICAgICAgICBlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiAmJlxuICAgICAgICAoYWJzID09PSBlLnJvb3QgfHwgYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSksXG4gICAgKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBBIGZvbGRlciB0aGluZ3MgbWF5IGJlIG1hZGUgaW4gb3IgbW92ZWQgaW50bzogYSBtaXJyb3JlZCBlbnRyeSdzIHJvb3QsIGFcbiAgICogdmlzaWJsZSBmb2xkZXIgdW5kZXIgb25lLCBvciB0aGUgd29ya3NwYWNlLiBSZXR1cm5zIHRoZSBhYnNvbHV0ZSBmb2xkZXI7XG4gICAqIHJlZnVzZXMgYW55dGhpbmcgZWxzZSDigJQgdGhlIGNvbnRleHQgc3RheXMgdGhlIHdheSBpbiAodmVyaWZ5LXBhc3MgZml4IDFiKS5cbiAgICovXG4gIHByaXZhdGUgZGVzdGluYXRpb25PckRpZShyYXdEaXI6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zcGVsbChyZXNvbHZlKHJhd0RpcikpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCAhPT0gXCJtaXJyb3JlZFwiKSBjb250aW51ZTtcbiAgICAgIGlmIChhYnMgPT09IGUucm9vdCkgcmV0dXJuIGFicztcbiAgICAgIGlmIChhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSB7XG4gICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZShlLm5vZGVzLCB0b1Bvc2l4KHJlbGF0aXZlKGUucm9vdCwgYWJzKSkpO1xuICAgICAgICBpZiAobm9kZT8ua2luZCA9PT0gXCJncm91cFwiKSByZXR1cm4gYWJzO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAodGhpcy5pc1dvcmtzcGFjZShhYnMpKSByZXR1cm4gdGhpcy53b3Jrc3BhY2U7XG4gICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgIGAke2Fic30gaXMgbm90IGEgZm9sZGVyIGluIHRoaXMgc2Vzc2lvbiDigJQgbmFtZSBhIHNldCwgYSBmb2xkZXIgaW5zaWRlIG9uZSwgb3IgdGhlIHdvcmtzcGFjZSAoJHt0aGlzLndvcmtzcGFjZX0pYCxcbiAgICAgIDQwMCxcbiAgICApO1xuICB9XG5cbiAgLyoqIEEgZG9jdW1lbnQgb3IgZm9sZGVyIHNob3duIGluIHRoZSBjb250ZXh0LCB3aXRoIHdoZXJlIGl0IGlzIHNob3duLiAqL1xuICBwcml2YXRlIGl0ZW1PckRpZShyYXdQYXRoOiBzdHJpbmcpOiB7XG4gICAgYWJzOiBzdHJpbmc7XG4gICAgZW50cnk6IENvbnRleHRFbnRyeTtcbiAgICAvKiogVGhlIHdob2xlIGVudHJ5IChhIHNldCdzIG93biBmb2xkZXIsIGEgbGlzdGVkIGRvY3VtZW50KSwgb3IgYSBub2RlIGluc2lkZSBhIHNldC4gKi9cbiAgICB3aG9sZTogYm9vbGVhbjtcbiAgICBkaXI6IGJvb2xlYW47XG4gIH0ge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc3BlbGwocmVzb2x2ZShyYXdQYXRoKSk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwID09PSBcImxpc3RlZFwiKSB7XG4gICAgICAgIGNvbnN0IG9ubHkgPSBlLm5vZGVzWzBdO1xuICAgICAgICBpZiAoZS5ub2Rlcy5sZW5ndGggPT09IDEgJiYgb25seT8ua2luZCA9PT0gXCJkb2NcIiAmJiBqb2luKGUucm9vdCwgb25seS5yZWwpID09PSBhYnMpXG4gICAgICAgICAgcmV0dXJuIHsgYWJzLCBlbnRyeTogZSwgd2hvbGU6IHRydWUsIGRpcjogZmFsc2UgfTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoYWJzID09PSBlLnJvb3QpIHJldHVybiB7IGFicywgZW50cnk6IGUsIHdob2xlOiB0cnVlLCBkaXI6IHRydWUgfTtcbiAgICAgIGlmIChhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSB7XG4gICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZShlLm5vZGVzLCB0b1Bvc2l4KHJlbGF0aXZlKGUucm9vdCwgYWJzKSkpO1xuICAgICAgICBpZiAobm9kZSkgcmV0dXJuIHsgYWJzLCBlbnRyeTogZSwgd2hvbGU6IGZhbHNlLCBkaXI6IG5vZGUua2luZCA9PT0gXCJncm91cFwiIH07XG4gICAgICB9XG4gICAgfVxuICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YWJzfSBpcyBub3Qgc2hvd24gaW4gdGhpcyBzZXNzaW9uJ3MgY29udGV4dGAsIDQwNCk7XG4gIH1cblxuICAvKipcbiAgICogYHJhd1BhdGhgIGlmIHRoZSBjb250ZXh0IHNob3dzIGl0IOKAlCBhIGRvY3VtZW50IG9yIGZvbGRlciBpbiBhIHNldCwgYVxuICAgKiBsaXN0ZWQgZG9jdW1lbnQsIGEgc2V0J3Mgb3duIGZvbGRlciDigJQgb3IgaXQgaXMgdGhlIHdvcmtzcGFjZTsgcmVmdXNlZFxuICAgKiBvdGhlcndpc2UuIEZvciBhY3RzIHRoYXQgcmVhY2ggb3V0c2lkZSB0aGUgc3BlbGwgKHJldmVhbGluZyBhIHBhdGggaW4gdGhlXG4gICAqIGZpbGUgbWFuYWdlciksIHNvIGEgcGFnZSBjYW5ub3QgYWltIHRoZW0gYXQgYW4gYXJiaXRyYXJ5IHBhdGguXG4gICAqL1xuICBzaG93blBhdGgocmF3UGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBhYnMgPSB0aGlzLnNwZWxsKHJlc29sdmUocmF3UGF0aCkpO1xuICAgIGlmICh0aGlzLml0ZW1BdChhYnMpKSByZXR1cm4gYWJzO1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gdGhpcy5kZXN0aW5hdGlvbk9yRGllKGFicyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Fic30gaXMgbm90IHNob3duIGluIHRoaXMgc2Vzc2lvbmAsIDQwMCk7XG4gICAgfVxuICB9XG5cbiAgLyoqIFJlZnVzZSBhIG5hbWUgdGhhdCBpcyBub3Qgb25lIHBsYWluIGZpbGUgb3IgZm9sZGVyIG5hbWUuICovXG4gIHByaXZhdGUgbmFtZU9yRGllKG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgbiA9IG5hbWUudHJpbSgpO1xuICAgIGlmIChcbiAgICAgIG4gPT09IFwiXCIgfHxcbiAgICAgIG4gPT09IFwiLlwiIHx8XG4gICAgICBuID09PSBcIi4uXCIgfHxcbiAgICAgIG4uc3RhcnRzV2l0aChcIi5cIikgfHxcbiAgICAgIC9bL1xcXFxcXDBdLy50ZXN0KG4pIHx8XG4gICAgICBuLmxlbmd0aCA+IDI1NVxuICAgIClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGBcIiR7bmFtZX1cIiBpcyBub3QgYSB1c2FibGUgbmFtZSDigJQgb25lIHBsYWluIG5hbWUsIG5vIHNsYXNoZXMsIG5vdCBzdGFydGluZyB3aXRoIGEgZG90YCxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICByZXR1cm4gbjtcbiAgfVxuXG4gIC8qKiBBIGRvY3VtZW50IG5hbWU6IGEgbmFtZSB3aXRob3V0IGEgZG9jdW1lbnQgZXh0ZW5zaW9uIGdldHMgYC5tZGAuICovXG4gIHByaXZhdGUgZG9jTmFtZU9yRGllKG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgbiA9IHRoaXMubmFtZU9yRGllKG5hbWUpO1xuICAgIHJldHVybiBpc0RvY05hbWUobikgPyBuIDogYCR7bn0ubWRgO1xuICB9XG5cbiAgLyoqXG4gICAqIEFmdGVyIHNvbWV0aGluZyBtb3ZlZCBvbiBkaXNrIGZyb20gYGZyb21gIHRvIGB0b2AsIGJyaW5nIHRoZSBtb2RlbCB3aXRoIGl0OlxuICAgKiBvcGVuZWQgZG9jdW1lbnRzIGtlZXAgdGhlaXIgdmVyc2lvbnMgdW5kZXIgdGhlIG5ldyBwYXRoLCBlbnRyaWVzIHJvb3RlZCBhdFxuICAgKiBvciBob2xkaW5nIHRoZSBtb3ZlZCB0aGluZyBmb2xsb3cgaXQsIGFuZCBldmVyeSBtaXJyb3IgaXMgcmUtcmVhZC4gQW4gZW50cnlcbiAgICogdGhhdCBub3cgc2l0cyBpbnNpZGUgYW5vdGhlciBzZXQgaXMgZHJvcHBlZCDigJQgdGhlIHNldCBzaG93cyBpdCBhbHJlYWR5LlxuICAgKi9cbiAgcHJpdmF0ZSBmb2xsb3dNb3ZlKGZyb206IHN0cmluZywgdG86IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IG1vdmVkID0gKHA6IHN0cmluZyk6IHN0cmluZyB8IG51bGwgPT5cbiAgICAgIHAgPT09IGZyb20gPyB0byA6IHAuc3RhcnRzV2l0aChmcm9tICsgc2VwKSA/IHRvICsgcC5zbGljZShmcm9tLmxlbmd0aCkgOiBudWxsO1xuICAgIGZvciAoY29uc3QgZCBvZiB0aGlzLm0uZG9jcykge1xuICAgICAgY29uc3Qgbm93ID0gbW92ZWQoZC5vcmlnaW5hbCk7XG4gICAgICBpZiAobm93KSB7XG4gICAgICAgIGQub3JpZ2luYWwgPSBub3c7XG4gICAgICAgIGQubmFtZSA9IGJhc2VuYW1lKG5vdyk7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGRyb3AgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibGlzdGVkXCIpIHtcbiAgICAgICAgY29uc3Qgb25seSA9IGUubm9kZXNbMF07XG4gICAgICAgIGlmIChvbmx5Py5raW5kICE9PSBcImRvY1wiKSBjb250aW51ZTtcbiAgICAgICAgY29uc3Qgbm93ID0gbW92ZWQoam9pbihlLnJvb3QsIG9ubHkucmVsKSk7XG4gICAgICAgIGlmICghbm93KSBjb250aW51ZTtcbiAgICAgICAgaWYgKHRoaXMuY292ZXJpbmdFbnRyeShub3csIGUuaWQpKSBkcm9wLmFkZChlLmlkKTtcbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgZS5yb290ID0gZGlybmFtZShub3cpO1xuICAgICAgICAgIGUubGFiZWwgPSBiYXNlbmFtZShub3cpO1xuICAgICAgICAgIGUubm9kZXMgPSBbeyBraW5kOiBcImRvY1wiLCByZWw6IGJhc2VuYW1lKG5vdykgfV07XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IG5vdyA9IG1vdmVkKGUucm9vdCk7XG4gICAgICAgIGlmICghbm93KSBjb250aW51ZTtcbiAgICAgICAgaWYgKHRoaXMuY292ZXJpbmdFbnRyeShub3csIGUuaWQpKSBkcm9wLmFkZChlLmlkKTtcbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgZS5yb290ID0gbm93O1xuICAgICAgICAgIGUubGFiZWwgPSBiYXNlbmFtZShub3cpIHx8IG5vdztcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICB0aGlzLm0uY29udGV4dCA9IHRoaXMubS5jb250ZXh0LmZpbHRlcigoZSkgPT4gIWRyb3AuaGFzKGUuaWQpKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIikgdGhpcy5yZXNjYW4oZS5pZCk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgfVxuXG4gIC8qKiBBZnRlciBhIGZpbGUgb3IgZm9sZGVyIGxhbmRlZCBhdCBgYWJzYDogcmUtcmVhZCB0aGUgc2V0IGl0IGlzIGluLCBvciBnaXZlIGl0IGFuIGVudHJ5LiAqL1xuICBwcml2YXRlIGFkb3B0TmV3KGFiczogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3Qgc2V0ID0gdGhpcy5jb3ZlcmluZ0VudHJ5KGFicyk7XG4gICAgaWYgKHNldCkgdGhpcy5yZXNjYW4oc2V0LmlkKTtcbiAgICBlbHNlIHRoaXMubS5jb250ZXh0LnB1c2goZW50cnlGb3JQYXRoKGFicywgYGMtJHtyYW5kSGV4KDMpfWApKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICB9XG5cbiAgLyoqIEEgbmFtZSBpbiBgZGlyYCB0aGF0IGlzIGZyZWU6IGBuYW1lYCwgZWxzZSBgc3RlbSAyLmV4dGAsIGBzdGVtIDMuZXh0YCwg4oCmICovXG4gIHByaXZhdGUgZnJlZU5hbWUoZGlyOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgaXNEaXI6IGJvb2xlYW4pOiBzdHJpbmcge1xuICAgIGlmICghZXhpc3RzU3luYyhqb2luKGRpciwgbmFtZSkpKSByZXR1cm4gbmFtZTtcbiAgICBjb25zdCBleHQgPSBpc0RpciA/IFwiXCIgOiBleHRuYW1lKG5hbWUpO1xuICAgIGNvbnN0IHN0ZW0gPSBleHQgPyBuYW1lLnNsaWNlKDAsIC1leHQubGVuZ3RoKSA6IG5hbWU7XG4gICAgZm9yIChsZXQgaSA9IDI7IDsgaSsrKSB7XG4gICAgICBjb25zdCBuID0gYCR7c3RlbX0gJHtpfSR7ZXh0fWA7XG4gICAgICBpZiAoIWV4aXN0c1N5bmMoam9pbihkaXIsIG4pKSkgcmV0dXJuIG47XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSByZWZ1c2VFeGlzdGluZyhhYnM6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmIChleGlzdHNTeW5jKGFicykpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Fic30gYWxyZWFkeSBleGlzdHMg4oCUIG5vdGhpbmcgd2FzIG92ZXJ3cml0dGVuYCwgNDA5KTtcbiAgfVxuXG4gIGNyZWF0ZURvYyhyYXdEaXI6IHN0cmluZywgbmFtZT86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGRpciA9IHRoaXMuZGVzdGluYXRpb25PckRpZShyYXdEaXIpO1xuICAgIGNvbnN0IGZpbGUgPVxuICAgICAgbmFtZSA9PT0gdW5kZWZpbmVkID8gdGhpcy5mcmVlTmFtZShkaXIsIFwiVW50aXRsZWQubWRcIiwgZmFsc2UpIDogdGhpcy5kb2NOYW1lT3JEaWUobmFtZSk7XG4gICAgY29uc3QgYWJzID0gam9pbihkaXIsIGZpbGUpO1xuICAgIHRoaXMucmVmdXNlRXhpc3RpbmcoYWJzKTtcbiAgICB3cml0ZUZpbGVTeW5jKGFicywgXCJcIiwgeyBmbGFnOiBcInd4XCIgfSk7XG4gICAgdGhpcy5hZG9wdE5ldyhhYnMpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicyB9O1xuICB9XG5cbiAgY3JlYXRlRm9sZGVyKHJhd0Rpcjogc3RyaW5nLCBuYW1lPzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZGlyID0gdGhpcy5kZXN0aW5hdGlvbk9yRGllKHJhd0Rpcik7XG4gICAgY29uc3QgZm9sZGVyID1cbiAgICAgIG5hbWUgPT09IHVuZGVmaW5lZCA/IHRoaXMuZnJlZU5hbWUoZGlyLCBcIk5ldyBmb2xkZXJcIiwgdHJ1ZSkgOiB0aGlzLm5hbWVPckRpZShuYW1lKTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgZm9sZGVyKTtcbiAgICB0aGlzLnJlZnVzZUV4aXN0aW5nKGFicyk7XG4gICAgbWtkaXJTeW5jKGFicyk7XG4gICAgdGhpcy5hZG9wdE5ldyhhYnMpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicyB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEUyNjogd2hhdCBhIG1vdmUgV09VTEQgZG8sIGZvciB0aGUgY29uZmlybWF0aW9uIHRoZSBzdXJmYWNlIHNob3dzIGJlZm9yZVxuICAgKiBtb3ZpbmcgYSBGT0xERVIuIFJlYWRzIG5vdGhpbmcgYnV0IHRoZSBkaXNrIGFuZCByZWZ1c2VzIGV4YWN0bHkgd2hhdFxuICAgKiBgbW92ZWAgd291bGQgcmVmdXNlLCBzbyBhIGNvbmZpcm1lZCBtb3ZlIGNhbm5vdCB0aGVuIGZhaWwgb24gYWRtaXNzaW9uLlxuICAgKlxuICAgKiBUaGUgZ2l0IGhhbGYgaXMgaGVyZSBiZWNhdXNlIG9ubHkgdGhlIGRhZW1vbiBjYW4gc2VlIGEgYC5naXRgOiBhIGZvbGRlclxuICAgKiBkcmFnZ2VkIG91dCBvZiBhIHJlcG9zaXRvcnkgaXMgdGhlIGNhc2Ugd2hlcmUgdGhlIGNvbnNlcXVlbmNlIHJlYWNoZXMgcGFzdFxuICAgKiBzY3JpcHRvcml1bSAoQ29sZSBtb3ZlZCB0aGlzIHByb2plY3QncyBvd24gZG9jcyBmb2xkZXIgaW50byBoaXMgd29ya3NwYWNlLFxuICAgKiBhbmQgZ2l0IHNhdyBzaXggZGVsZXRlZCBmaWxlcykuXG4gICAqL1xuICBtb3ZlUGxhbihyYXdQYXRoOiBzdHJpbmcsIHJhd0ludG86IHN0cmluZyk6IE1vdmVQbGFuIHtcbiAgICBjb25zdCBpdGVtID0gdGhpcy5pdGVtT3JEaWUocmF3UGF0aCk7XG4gICAgY29uc3QgaW50byA9IHRoaXMuZGVzdGluYXRpb25PckRpZShyYXdJbnRvKTtcbiAgICBjb25zdCBmcm9tUmVwbyA9IGdpdFJvb3RPZihkaXJuYW1lKGl0ZW0uYWJzKSk7XG4gICAgY29uc3QgaW50b1JlcG8gPSBnaXRSb290T2YoaW50byk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGZyb206IGl0ZW0uYWJzLFxuICAgICAgaW50byxcbiAgICAgIG5hbWU6IGJhc2VuYW1lKGl0ZW0uYWJzKSxcbiAgICAgIGZvbGRlcjogaXRlbS5kaXIsXG4gICAgICBkb2NzOiBpdGVtLmRpciA/IGNvdW50RG9jcyhpdGVtLmFicykgOiAxLFxuICAgICAgcmVwbzogZnJvbVJlcG8gPyBiYXNlbmFtZShmcm9tUmVwbykgOiBudWxsLFxuICAgICAgbGVhdmVzUmVwbzogZnJvbVJlcG8gIT09IG51bGwgJiYgZnJvbVJlcG8gIT09IGludG9SZXBvLFxuICAgIH07XG4gIH1cblxuICBtb3ZlKHJhd1BhdGg6IHN0cmluZywgcmF3SW50bzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IGZyb206IHN0cmluZyB9IHtcbiAgICBjb25zdCBpdGVtID0gdGhpcy5pdGVtT3JEaWUocmF3UGF0aCk7XG4gICAgY29uc3QgaW50byA9IHRoaXMuZGVzdGluYXRpb25PckRpZShyYXdJbnRvKTtcbiAgICBpZiAoaW50byA9PT0gaXRlbS5hYnMgfHwgaW50by5zdGFydHNXaXRoKGl0ZW0uYWJzICsgc2VwKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYGNhbm5vdCBtb3ZlICR7dGhpcy5kaXNwbGF5KGl0ZW0uYWJzKX0gaW50byBpdHNlbGZgLCA0MDApO1xuICAgIGlmIChkaXJuYW1lKGl0ZW0uYWJzKSA9PT0gaW50bylcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7dGhpcy5kaXNwbGF5KGl0ZW0uYWJzKX0gaXMgYWxyZWFkeSBpbiB0aGF0IGZvbGRlcmAsIDQwMCk7XG4gICAgY29uc3QgdG8gPSBqb2luKGludG8sIGJhc2VuYW1lKGl0ZW0uYWJzKSk7XG4gICAgdGhpcy5yZWZ1c2VFeGlzdGluZyh0byk7XG4gICAgdGhpcy5yZW5hbWVPckRpZShpdGVtLmFicywgdG8pO1xuICAgIHRoaXMuZm9sbG93TW92ZShpdGVtLmFicywgdG8pO1xuICAgIGlmICghdGhpcy5pdGVtQXQodG8pKSB0aGlzLmFkb3B0TmV3KHRvKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiB0bywgZnJvbTogaXRlbS5hYnMgfTtcbiAgfVxuXG4gIHJlbmFtZShyYXdQYXRoOiBzdHJpbmcsIG5hbWU6IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBmcm9tOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGxldCBuZXh0ID0gdGhpcy5uYW1lT3JEaWUobmFtZSk7XG4gICAgLy8gQSBkb2N1bWVudCBrZWVwcyBhIGRvY3VtZW50IGV4dGVuc2lvbjogXCJub3Rlc1wiIHJlbmFtZXMgbm90ZXMubWQgdG9cbiAgICAvLyBub3Rlcy5tZCwgbm90IHRvIGFuIGV4dGVuc2lvbmxlc3MgZmlsZSBTY3JpcHRvcml1bSB3b3VsZCBzdG9wIHNob3dpbmcuXG4gICAgaWYgKCFpdGVtLmRpciAmJiAhaXNEb2NOYW1lKG5leHQpKSBuZXh0ICs9IGV4dG5hbWUoaXRlbS5hYnMpIHx8IFwiLm1kXCI7XG4gICAgY29uc3QgdG8gPSBqb2luKGRpcm5hbWUoaXRlbS5hYnMpLCBuZXh0KTtcbiAgICBpZiAodG8gPT09IGl0ZW0uYWJzKSByZXR1cm4geyBwYXRoOiB0bywgZnJvbTogaXRlbS5hYnMgfTtcbiAgICAvLyBBIGNhc2Utb25seSByZW5hbWUgb24gYSBjYXNlLWluc2Vuc2l0aXZlIGRpc2sgZmluZHMgXCJpdHNlbGZcIiBleGlzdGluZy5cbiAgICBpZiAodG8udG9Mb3dlckNhc2UoKSAhPT0gaXRlbS5hYnMudG9Mb3dlckNhc2UoKSkgdGhpcy5yZWZ1c2VFeGlzdGluZyh0byk7XG4gICAgdGhpcy5yZW5hbWVPckRpZShpdGVtLmFicywgdG8pO1xuICAgIHRoaXMuZm9sbG93TW92ZShpdGVtLmFicywgdG8pO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IHRvLCBmcm9tOiBpdGVtLmFicyB9O1xuICB9XG5cbiAgcHJpdmF0ZSByZW5hbWVPckRpZShmcm9tOiBzdHJpbmcsIHRvOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0cnkge1xuICAgICAgcmVuYW1lU3luYyhmcm9tLCB0byk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc3QgY29kZSA9IChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZTtcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGNvZGUgPT09IFwiRVhERVZcIlxuICAgICAgICAgID8gYGNhbm5vdCBtb3ZlICR7ZnJvbX0gdG8gYW5vdGhlciBkaXNrICgke3RvfSkg4oCUIGNvcHkgaXQgaW5zdGVhZGBcbiAgICAgICAgICA6IGBjYW5ub3QgbW92ZSAke2Zyb219IHRvICR7dG99OiAke2NvZGUgPz8gU3RyaW5nKGUpfWAsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLyoqIFdoZXRoZXIgYGFic2AgaXMgc2hvd24gYW55d2hlcmUgaW4gdGhlIGNvbnRleHQgbm93LiAqL1xuICBwcml2YXRlIGl0ZW1BdChhYnM6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHRyeSB7XG4gICAgICB0aGlzLml0ZW1PckRpZShhYnMpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgLyoqIFwiUmVtb3ZlIGZyb20gU2NyaXB0b3JpdW1cIiDigJQgbmV2ZXIgZnJvbSBkaXNrIChFMjQpLiAqL1xuICBoaWRlKHJhd1BhdGg6IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBlbnRyeTogc3RyaW5nOyByZW1vdmVkRW50cnk6IGJvb2xlYW4gfSB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGlmIChpdGVtLndob2xlKSB7XG4gICAgICB0aGlzLnJlbW92ZUNvbnRleHQoaXRlbS5lbnRyeS5pZCk7XG4gICAgICByZXR1cm4geyBwYXRoOiBpdGVtLmFicywgZW50cnk6IGl0ZW0uZW50cnkuaWQsIHJlbW92ZWRFbnRyeTogdHJ1ZSB9O1xuICAgIH1cbiAgICBjb25zdCByZWwgPSB0b1Bvc2l4KHJlbGF0aXZlKGl0ZW0uZW50cnkucm9vdCwgaXRlbS5hYnMpKTtcbiAgICBpdGVtLmVudHJ5LmhpZGRlbiA9IFsuLi4oaXRlbS5lbnRyeS5oaWRkZW4gPz8gW10pLmZpbHRlcigoaCkgPT4gaCAhPT0gcmVsKSwgcmVsXTtcbiAgICB0aGlzLnJlc2NhbihpdGVtLmVudHJ5LmlkKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMuY2xvc2VPcnBoYW5lZE9wZW5Eb2MoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBpdGVtLmFicywgZW50cnk6IGl0ZW0uZW50cnkuaWQsIHJlbW92ZWRFbnRyeTogZmFsc2UgfTtcbiAgfVxuXG4gIHVuaGlkZShlbnRyeUlkOiBzdHJpbmcpOiB7IGVudHJ5OiBzdHJpbmc7IHJlc3RvcmVkOiBudW1iZXIgfSB7XG4gICAgY29uc3QgZSA9IHRoaXMubS5jb250ZXh0LmZpbmQoKHgpID0+IHguaWQgPT09IGVudHJ5SWQpO1xuICAgIGlmICghZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGBubyBjb250ZXh0IGVudHJ5ICR7ZW50cnlJZH1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIHRoaXMubS5jb250ZXh0Lm1hcCgoeCkgPT4geC5pZCksXG4gICAgICApO1xuICAgIGNvbnN0IHJlc3RvcmVkID0gZS5oaWRkZW4/Lmxlbmd0aCA/PyAwO1xuICAgIGRlbGV0ZSBlLmhpZGRlbjtcbiAgICB0aGlzLnJlc2NhbihlLmlkKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IGVudHJ5OiBlLmlkLCByZXN0b3JlZCB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEUyMjogYSBzaW5nbGUgZG9jdW1lbnQgYmVjb21lcyBhIHNldCDigJQgYSBmb2xkZXIgbmFtZWQgZm9yIGl0IGJlc2lkZSBpdCwgdGhlXG4gICAqIGRvY3VtZW50IG1vdmVkIGluLCBhbmQgdGhlIGVudHJ5IChzYW1lIGlkKSBub3cgbWlycm9ycyB0aGF0IGZvbGRlci5cbiAgICovXG4gIG1ha2VTZXQocmF3UGF0aDogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IGZvbGRlcjogc3RyaW5nOyBlbnRyeTogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBpZiAoaXRlbS5lbnRyeS5tZW1iZXJzaGlwICE9PSBcImxpc3RlZFwiIHx8IGl0ZW0uZGlyKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7dGhpcy5kaXNwbGF5KGl0ZW0uYWJzKX0gaXMgYWxyZWFkeSBpbiBhIHNldCDigJQgbWFrZSBhIGZvbGRlciB0aGVyZSBpbnN0ZWFkYCxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKGl0ZW0uYWJzKTtcbiAgICBjb25zdCBzdGVtID0gYmFzZW5hbWUoaXRlbS5hYnMsIGV4dG5hbWUoaXRlbS5hYnMpKSB8fCBcIlVudGl0bGVkXCI7XG4gICAgY29uc3QgZm9sZGVyID0gam9pbihwYXJlbnQsIHRoaXMuZnJlZU5hbWUocGFyZW50LCBzdGVtLCB0cnVlKSk7XG4gICAgbWtkaXJTeW5jKGZvbGRlcik7XG4gICAgY29uc3QgdG8gPSBqb2luKGZvbGRlciwgYmFzZW5hbWUoaXRlbS5hYnMpKTtcbiAgICB0aGlzLnJlbmFtZU9yRGllKGl0ZW0uYWJzLCB0byk7XG4gICAgY29uc3QgZSA9IGl0ZW0uZW50cnk7XG4gICAgZS5tZW1iZXJzaGlwID0gXCJtaXJyb3JlZFwiO1xuICAgIGUucm9vdCA9IGZvbGRlcjtcbiAgICBlLmxhYmVsID0gYmFzZW5hbWUoZm9sZGVyKTtcbiAgICBlLm5vZGVzID0gW107XG4gICAgdGhpcy5mb2xsb3dNb3ZlKGl0ZW0uYWJzLCB0byk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogdG8sIGZvbGRlciwgZW50cnk6IGUuaWQgfTtcbiAgfVxuXG4gIC8qKiBUaGUgbW9zdCB0ZXh0IG9uZSBpbXBvcnQgY2FycmllcyDigJQgYSBkb2N1bWVudCwgbm90IGEgZGF0YSBkdW1wLiAqL1xuICBzdGF0aWMgcmVhZG9ubHkgSU1QT1JUX01BWF9CWVRFUyA9IDggKiAxMDI0ICogMTAyNDtcblxuICAvKipcbiAgICogRTIzJ3MgZHJvcDogYSBDT1BZIG9mIGEgZmlsZSdzIHRleHQsIHdyaXR0ZW4gdW5kZXIgYSBmcmVlIG5hbWUgaW50byBgaW50b2BcbiAgICogKGRlZmF1bHQ6IHRoZSB3b3Jrc3BhY2UpLCB0aGVuIHNob3duIGxpa2UgYW55IG90aGVyIGRvY3VtZW50LlxuICAgKi9cbiAgaW1wb3J0VGV4dChuYW1lOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgcmF3SW50bz86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGZpbGUgPSB0aGlzLm5hbWVPckRpZShuYW1lKTtcbiAgICBpZiAoIWlzRG9jTmFtZShmaWxlKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGBub3QgYSBkb2N1bWVudCBTY3JpcHRvcml1bSBvcGVucyAoJHtET0NfRVhURU5TSU9OUy5qb2luKFwiIFwiKX0pOiAke2ZpbGV9YCxcbiAgICAgICAgNDAwLFxuICAgICAgICBbLi4uRE9DX0VYVEVOU0lPTlNdLFxuICAgICAgKTtcbiAgICBpZiAoQnVmZmVyLmJ5dGVMZW5ndGgodGV4dCkgPiBTZXNzaW9uLklNUE9SVF9NQVhfQllURVMpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHtmaWxlfSBpcyBsYXJnZXIgdGhhbiAke1Nlc3Npb24uSU1QT1JUX01BWF9CWVRFUyAvIDEwMjQgLyAxMDI0fSBNQiDigJQgbm90IGltcG9ydGVkYCxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICBjb25zdCBkaXIgPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3SW50byA/PyB0aGlzLndvcmtzcGFjZSk7XG4gICAgY29uc3QgYWJzID0gam9pbihkaXIsIHRoaXMuZnJlZU5hbWUoZGlyLCBmaWxlLCBmYWxzZSkpO1xuICAgIHdyaXRlRmlsZVN5bmMoYWJzLCB0ZXh0LCB7IGZsYWc6IFwid3hcIiB9KTtcbiAgICB0aGlzLmFkb3B0TmV3KGFicyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzIH07XG4gIH1cblxuICAvLyDilIDilIAgY2hhdCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvLyDilIDilIAgdGhlIHdvcmsgcXVldWUgKEU1MCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIFN0YXJ0IGEgdGFzay4gSXQgaXMgQU5OT1VOQ0VEIGFzIGEgY2hhdCBtZXNzYWdlIGFuZCByZWNvcmRlZCBhcyBhIHRhc2sgYXRcbiAgICogdGhlIHNhbWUgbW9tZW50IOKAlCBDb2xlJ3MgZnJhbWluZywgXCJhIG1lc3NhZ2UgdGhhdCBjYW4gYmUgbWFya2VkIGRvbmVcIiDigJRcbiAgICogc28gdGhlIGNvbnZlcnNhdGlvbiByZWFkcyBhcyBhIG5hcnJhdGl2ZSBhbmQgdGhlIHF1ZXVlIHJlYWRzIGFzIHN0YXRlLFxuICAgKiBvdmVyIG9uZSBmYWN0IHJhdGhlciB0aGFuIHR3by5cbiAgICovXG4gIHN0YXJ0VGFzayh0ZXh0OiBzdHJpbmcsIHdobzogVmVyc2lvbkF1dGhvcik6IFRhc2sge1xuICAgIGNvbnN0IGJvZHkgPSB0ZXh0LnRyaW0oKTtcbiAgICBpZiAoIWJvZHkpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXCJhIHRhc2sgbmVlZHMgdG8gc2F5IHdoYXQgdGhlIHdvcmsgaXNcIiwgNDAwKTtcbiAgICBjb25zdCBtZXNzYWdlID0gdGhpcy5hZGRNZXNzYWdlKHdobywgYm9keSk7XG4gICAgY29uc3QgdGFzazogVGFzayA9IHtcbiAgICAgIGlkOiBgdC0ke3JhbmRIZXgoNCl9YCxcbiAgICAgIHRleHQ6IGJvZHksXG4gICAgICB3aG8sXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICBtZXNzYWdlSWQ6IG1lc3NhZ2UuaWQsXG4gICAgfTtcbiAgICB0aGlzLm0udGFza3MgPSBbLi4uKHRoaXMubS50YXNrcyA/PyBbXSksIHRhc2tdO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB0YXNrO1xuICB9XG5cbiAgcHJpdmF0ZSB0YXNrT3JEaWUoaWQ6IHN0cmluZyk6IFRhc2sge1xuICAgIGNvbnN0IHRhc2sgPSAodGhpcy5tLnRhc2tzID8/IFtdKS5maW5kKCh0KSA9PiB0LmlkID09PSBpZCk7XG4gICAgaWYgKCF0YXNrKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vIHRhc2sgJHtpZH0gaW4gdGhpcyBzZXNzaW9uYCxcbiAgICAgICAgNDA0LFxuICAgICAgICAodGhpcy5tLnRhc2tzID8/IFtdKS5maWx0ZXIoKHQpID0+IHQuZG9uZUF0ID09PSB1bmRlZmluZWQpLm1hcCgodCkgPT4gdC5pZCksXG4gICAgICApO1xuICAgIHJldHVybiB0YXNrO1xuICB9XG5cbiAgLyoqIFNheSB3aGF0IGlzIGJlaW5nIGRvbmUgcmlnaHQgbm93IOKAlCBmb3Igd29yayB3aXRoIHN0ZXBzIHdvcnRoIHdhdGNoaW5nLiAqL1xuICBzZXRUYXNrU3RhdHVzKGlkOiBzdHJpbmcsIHN0YXR1czogc3RyaW5nKTogVGFzayB7XG4gICAgY29uc3QgdGFzayA9IHRoaXMudGFza09yRGllKGlkKTtcbiAgICBpZiAodGFzay5kb25lQXQgIT09IHVuZGVmaW5lZClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYHRhc2sgJHtpZH0gaXMgYWxyZWFkeSBkb25lIOKAlCBpdHMgc3RhdHVzIGNhbm5vdCBjaGFuZ2VgLCA0MDkpO1xuICAgIHRhc2suc3RhdHVzID0gc3RhdHVzLnRyaW0oKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gdGFzaztcbiAgfVxuXG4gIC8qKlxuICAgKiBNYXJrIGl0IGRvbmUuIElkZW1wb3RlbnQgb24gcHVycG9zZTogYSB0YXNrIGZpbmlzaGVkIHR3aWNlIOKAlCBhbiBhZ2VudFxuICAgKiByZXRyeWluZywgYSBodW1hbiBjbGlja2luZyBhcyB0aGUgYWdlbnQgcmVwb3J0cyDigJQgaXMgbm90IGFuIGVycm9yLCBhbmRcbiAgICogcmVmdXNpbmcgd291bGQgbWFrZSB0aGUgc3VyZmFjZSBoYW5kbGUgYSByYWNlIGl0IGRpZCBub3QgY2F1c2UuXG4gICAqL1xuICBmaW5pc2hUYXNrKGlkOiBzdHJpbmcsIG91dGNvbWU/OiBzdHJpbmcpOiB7IHRhc2s6IFRhc2s7IGFscmVhZHk6IGJvb2xlYW4gfSB7XG4gICAgY29uc3QgdGFzayA9IHRoaXMudGFza09yRGllKGlkKTtcbiAgICBjb25zdCBhbHJlYWR5ID0gdGFzay5kb25lQXQgIT09IHVuZGVmaW5lZDtcbiAgICBpZiAoIWFscmVhZHkpIHtcbiAgICAgIHRhc2suZG9uZUF0ID0gRGF0ZS5ub3coKTtcbiAgICAgIHRhc2suc3RhdHVzID0gdW5kZWZpbmVkO1xuICAgICAgaWYgKG91dGNvbWU/LnRyaW0oKSkgdGFzay5vdXRjb21lID0gb3V0Y29tZS50cmltKCk7XG4gICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgdGFzaywgYWxyZWFkeSB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEZvcmdldCBhIHRhc2sgZW50aXJlbHkg4oCUIGZvciBvbmUgc3RhcnRlZCBieSBtaXN0YWtlLiBNYXJraW5nIGl0IGRvbmUgd291bGRcbiAgICogcHV0IGEgdGhpbmcgdGhhdCBuZXZlciBoYXBwZW5lZCBpbnRvIHRoZSByZWNvcmQ7IGEgcXVldWUgeW91IGNhbm5vdCBjbGVhclxuICAgKiBvZiBpdHMgb3duIG1pc3Rha2VzIHN0b3BzIGJlaW5nIGEgdHJ1c3R3b3J0aHkgYWNjb3VudCBvZiB0aGUgd29yay5cbiAgICovXG4gIHJlbW92ZVRhc2soaWQ6IHN0cmluZyk6IFRhc2sge1xuICAgIGNvbnN0IHRhc2sgPSB0aGlzLnRhc2tPckRpZShpZCk7XG4gICAgdGhpcy5tLnRhc2tzID0gKHRoaXMubS50YXNrcyA/PyBbXSkuZmlsdGVyKCh0KSA9PiB0LmlkICE9PSBpZCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHRhc2s7XG4gIH1cblxuICAvKipcbiAgICogRm9yZ2V0IGV2ZXJ5IGZpbmlzaGVkIHRhc2suIE91dHN0YW5kaW5nIG9uZXMgYXJlIHVudG91Y2hlZCDigJQgY2xlYXJpbmcgaXNcbiAgICogdGlkeWluZyB3aGF0IGlzIE9WRVIsIG5ldmVyIGFiYW5kb25pbmcgd29yayBzdGlsbCBpbiBmbGlnaHQuXG4gICAqL1xuICBjbGVhckRvbmVUYXNrcygpOiBudW1iZXIge1xuICAgIGNvbnN0IGJlZm9yZSA9ICh0aGlzLm0udGFza3MgPz8gW10pLmxlbmd0aDtcbiAgICB0aGlzLm0udGFza3MgPSAodGhpcy5tLnRhc2tzID8/IFtdKS5maWx0ZXIoKHQpID0+IHQuZG9uZUF0ID09PSB1bmRlZmluZWQpO1xuICAgIGNvbnN0IGNsZWFyZWQgPSBiZWZvcmUgLSAodGhpcy5tLnRhc2tzPy5sZW5ndGggPz8gMCk7XG4gICAgaWYgKGNsZWFyZWQgPiAwKSB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gY2xlYXJlZDtcbiAgfVxuXG4gIC8qKiBOZXdlc3QgZmlyc3Qg4oCUIGEgcXVldWUgaXMgcmVhZCBmcm9tIHRoZSB0b3AuICovXG4gIHRhc2tzKCk6IFRhc2tbXSB7XG4gICAgcmV0dXJuIFsuLi4odGhpcy5tLnRhc2tzID8/IFtdKV0uc29ydCgoYSwgYikgPT4gYi5jcmVhdGVkQXQgLSBhLmNyZWF0ZWRBdCk7XG4gIH1cblxuICBhZGRNZXNzYWdlKFxuICAgIHdobzogQ2hhdFdobyxcbiAgICB0ZXh0OiBzdHJpbmcsXG4gICAgZXh0cmE6IHsgc2VsZWN0aW9uPzogU2VsZWN0aW9uIHwgbnVsbDsgYWN0aXZlUGF0aD86IHN0cmluZyB8IG51bGwgfSA9IHt9LFxuICApOiBDaGF0TWVzc2FnZSB7XG4gICAgY29uc3QgbXNnOiBDaGF0TWVzc2FnZSA9IHsgaWQ6IGBtLSR7cmFuZEhleCg0KX1gLCB3aG8sIHRleHQsIHRzOiBEYXRlLm5vdygpLCAuLi5leHRyYSB9O1xuICAgIHRoaXMubS5jaGF0LnB1c2gobXNnKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gbXNnO1xuICB9XG5cbiAgLy8g4pSA4pSAIHZpZXdzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKiBBIGRvY3VtZW50J3MgZnJvbnRtYXR0ZXIsIGZyb20gdGhlIEFDVElWRSB2ZXJzaW9uJ3MgdGV4dCDigJQgd2hhdCB0aGUgaHVtYW5cbiAgICogIGlzIHJlYWRpbmcsIHdoaWNoIGlzIG5vdCBhbHdheXMgd2hhdCBpcyBvbiBkaXNrIChFMzIpLiAqL1xuICBwcml2YXRlIG1ldGFPZihkOiBEb2NSZWNvcmQpOiBEb2NWaWV3W1wibWV0YVwiXSB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiByZWFkTWV0YShyZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gIH1cblxuICBkb2NWaWV3KGQ6IERvY1JlY29yZCk6IERvY1ZpZXcge1xuICAgIHJldHVybiB7XG4gICAgICBtZXRhOiB0aGlzLm1ldGFPZihkKSxcbiAgICAgIHNsdWc6IGQuc2x1ZyxcbiAgICAgIG5hbWU6IGQubmFtZSxcbiAgICAgIG9yaWdpbmFsOiBkLm9yaWdpbmFsLFxuICAgICAgZW50cnlJZDogZC5lbnRyeUlkLFxuICAgICAgcmVsOiBkLnJlbCxcbiAgICAgIHZlcnNpb25zOiBkLnZlcnNpb25zLm1hcCgodikgPT4gKHsgLi4udiwgcGF0aDogdGhpcy52ZXJzaW9uUGF0aChkLCB2Lm4pIH0pKSxcbiAgICAgIG5vdGVzOiB0aGlzLnBsYWNlZE5vdGVzKGQpLFxuICAgICAgYWN0aXZlOiBkLmFjdGl2ZSxcbiAgICAgIGRpcnR5OiB0aGlzLmlzRGlydHkoZCksXG4gICAgICBvdXRzaWRlQ2hhbmdlZDogZC5vdXRzaWRlQ2hhbmdlZCxcbiAgICB9O1xuICB9XG5cbiAgZG9jKHNsdWc6IHN0cmluZyk6IERvY1ZpZXcge1xuICAgIHJldHVybiB0aGlzLmRvY1ZpZXcodGhpcy5kb2NPckRpZShzbHVnKSk7XG4gIH1cblxuICAvKipcbiAgICogRnJvbnRtYXR0ZXIgZm9yIGV2ZXJ5IGRvY3VtZW50IGluIHRoZSBjb250ZXh0LCBieSBwYXRoIChFMzIpLlxuICAgKlxuICAgKiBDYWNoZWQgYnkgcGF0aCBhbmQgbXRpbWUsIGFuZCByZWFkIEhFQUQtRklSU1Q6IGEgZnJvbnRtYXR0ZXIgYmxvY2sgc2l0cyBhdFxuICAgKiB0aGUgdG9wIG9mIGEgZmlsZSwgc28gYSAzMDAgS0IgZG9jdW1lbnQgY29zdHMgOCBLQiBvZiByZWFkLiBUaGUgY2FwIGtlZXBzIGFcbiAgICogMiwwMDAtbm9kZSBtaXJyb3IgZnJvbSBtZWFuaW5nIDIsMDAwIHJlYWRzIHBlciBzbmFwc2hvdCwgYW5kIGhpdHRpbmcgaXQgaXNcbiAgICogU0FJRCBvbiB0aGUgd2lyZSByYXRoZXIgdGhhbiBsZWZ0IHRvIGxvb2sgbGlrZSBkb2N1bWVudHMgd2l0aG91dCBhbnkuXG4gICAqL1xuICBwcml2YXRlIG1ldGFDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCB7IG10aW1lTXM6IG51bWJlcjsgc3VtbWFyeTogRG9jU3VtbWFyeSB8IG51bGwgfT4oKTtcblxuICBjb250ZXh0TWV0YShjYXAgPSBNRVRBX1NDQU5fQ0FQKTogeyBtYXA6IFJlY29yZDxzdHJpbmcsIERvY1N1bW1hcnk+OyB0cnVuY2F0ZWQ6IGJvb2xlYW4gfSB7XG4gICAgY29uc3QgbWFwOiBSZWNvcmQ8c3RyaW5nLCBEb2NTdW1tYXJ5PiA9IHt9O1xuICAgIGxldCBzZWVuID0gMDtcbiAgICBsZXQgdHJ1bmNhdGVkID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBmb3IgKGNvbnN0IGFicyBvZiBkb2NQYXRocyhlKSkge1xuICAgICAgICBpZiAoc2VlbiA+PSBjYXApIHtcbiAgICAgICAgICB0cnVuY2F0ZWQgPSB0cnVlO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICAgIHNlZW4rKztcbiAgICAgICAgbGV0IG10aW1lTXM6IG51bWJlcjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBtdGltZU1zID0gc3RhdFN5bmMoYWJzKS5tdGltZU1zO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBoaXQgPSB0aGlzLm1ldGFDYWNoZS5nZXQoYWJzKTtcbiAgICAgICAgbGV0IHN1bW1hcnk6IERvY1N1bW1hcnkgfCBudWxsO1xuICAgICAgICBpZiAoaGl0ICYmIGhpdC5tdGltZU1zID09PSBtdGltZU1zKSBzdW1tYXJ5ID0gaGl0LnN1bW1hcnk7XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIHN1bW1hcnkgPSBzdW1tYXJpemUocmVhZE1ldGEocmVhZEhlYWQoYWJzKSkpO1xuICAgICAgICAgIHRoaXMubWV0YUNhY2hlLnNldChhYnMsIHsgbXRpbWVNcywgc3VtbWFyeSB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc3VtbWFyeSkgbWFwW2Fic10gPSBzdW1tYXJ5O1xuICAgICAgfVxuICAgICAgaWYgKHRydW5jYXRlZCkgYnJlYWs7XG4gICAgfVxuICAgIHJldHVybiB7IG1hcCwgdHJ1bmNhdGVkIH07XG4gIH1cblxuICAvKipcbiAgICogT25lIGRvY3VtZW50J3MgZnJvbnRtYXR0ZXIgYXMgcmVhZCwgb3IgZXZlcnkgY29udGV4dCBkb2N1bWVudCdzIChFMzIpLiBUaGVcbiAgICogYWdlbnQgZ2V0cyB0aGUgZGFlbW9uJ3MgcGFyc2UgcmF0aGVyIHRoYW4gcmUtcmVhZGluZyB0aGUgWUFNTCBpdHNlbGYuXG4gICAqL1xuICBtZXRhRm9yKHJhd1BhdGg/OiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgaWYgKHJhd1BhdGggIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgYWJzID0gdGhpcy5zaG93blBhdGgocmF3UGF0aCk7XG4gICAgICBjb25zdCBtZXRhID0gcmVhZE1ldGEocmVhZEhlYWQoYWJzKSk7XG4gICAgICByZXR1cm4geyBwYXRoOiBhYnMsIG1ldGEsIC4uLihtZXRhID8ge30gOiB7IG5vdGU6IFwibm8gZnJvbnRtYXR0ZXIgYmxvY2tcIiB9KSB9O1xuICAgIH1cbiAgICBjb25zdCBvdXQ6IHsgcGF0aDogc3RyaW5nOyBtZXRhOiBEb2NNZXRhIHwgbnVsbCB9W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpXG4gICAgICBmb3IgKGNvbnN0IGFicyBvZiBkb2NQYXRocyhlKSkgb3V0LnB1c2goeyBwYXRoOiBhYnMsIG1ldGE6IHJlYWRNZXRhKHJlYWRIZWFkKGFicykpIH0pO1xuICAgIHJldHVybiB7IGRvY3VtZW50czogb3V0LCBjb3VudDogb3V0Lmxlbmd0aCB9O1xuICB9XG5cbiAgLyoqXG4gICAqIHBkb2NzJ3MgYGZpbmRgLCBvdmVyIHRoaXMgc2Vzc2lvbidzIGNvbnRleHQuIFNhbWUgZmlsdGVyIG5hbWVzLCBzYW1lXG4gICAqIEFORGluZywgYW5kIHRoZSBzYW1lIHJ1bGUgdGhhdCBhbiBlbXB0eSByZXN1bHQgaXMgYW4gQU5TV0VSOiBgY291bnRgIHNheXNcbiAgICogaG93IG1hbnkgbWF0Y2hlZCwgYW5kIHRoZSBjYWxsZXIgcmVhZHMgdGhhdCByYXRoZXIgdGhhbiB0aGUgZXhpdCBjb2RlLlxuICAgKi9cbiAgZmluZChmaWx0ZXI6IE1ldGFGaWx0ZXIpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3QgbWF0Y2hlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj5bXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dClcbiAgICAgIGZvciAoY29uc3QgYWJzIG9mIGRvY1BhdGhzKGUpKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSByZWFkTWV0YShyZWFkSGVhZChhYnMpKTtcbiAgICAgICAgaWYgKCFtYXRjaGVzRmlsdGVyKG1ldGEsIGZpbHRlcikpIGNvbnRpbnVlO1xuICAgICAgICBtYXRjaGVzLnB1c2goe1xuICAgICAgICAgIHBhdGg6IGFicyxcbiAgICAgICAgICBlbnRyeTogZS5pZCxcbiAgICAgICAgICAuLi4obWV0YT8udHlwZSA/IHsgdHlwZTogbWV0YS50eXBlIH0gOiB7fSksXG4gICAgICAgICAgLi4uKG1ldGE/LnRpdGxlID8geyB0aXRsZTogbWV0YS50aXRsZSB9IDoge30pLFxuICAgICAgICAgIC4uLihtZXRhPy5kZXNjcmlwdGlvbiA/IHsgZGVzY3JpcHRpb246IG1ldGEuZGVzY3JpcHRpb24gfSA6IHt9KSxcbiAgICAgICAgICBzdGF0dXM6IG1ldGE/LnN0YXR1cyA/PyBudWxsLFxuICAgICAgICAgIC4uLihtZXRhPy5saWZlY3ljbGUgPyB7IGxpZmVjeWNsZTogbWV0YS5saWZlY3ljbGUgfSA6IHt9KSxcbiAgICAgICAgICB0YWdzOiBtZXRhPy50YWdzID8/IFtdLFxuICAgICAgICAgIGRhdGU6IG1ldGE/LmRhdGUgPz8gbnVsbCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgcmV0dXJuIHsgbWF0Y2hlcywgY291bnQ6IG1hdGNoZXMubGVuZ3RoIH07XG4gIH1cblxuICAvKipcbiAgICogT25lIHNldCdzIG1hcCAoRTMzKTogaXRzIGRvY3VtZW50cyBhcyBub2RlcywgYW5kIHRoZSBmb3VyIHNvdXJjZXMgb2YgZWRnZXNcbiAgICog4oCUIGJvZHkgbGlua3MsIHdpa2kgbGlua3MsIHR5cGVkIGxpbmtzIGFuZCBmcm9udG1hdHRlciByZWZlcmVuY2VzLlxuICAgKi9cbiAgZ3JhcGhGb3IoZW50cnlJZD86IHN0cmluZyk6IEdyYXBoUGF5bG9hZCB7XG4gICAgY29uc3QgZSA9IGVudHJ5SWRcbiAgICAgID8gdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5pZCA9PT0gZW50cnlJZClcbiAgICAgIDogdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIpO1xuICAgIGlmICghZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGVudHJ5SWQgPyBgbm8gY29udGV4dCBlbnRyeSAke2VudHJ5SWR9YCA6IFwidGhpcyBzZXNzaW9uIGhhcyBubyBzZXQgdG8gbWFwXCIsXG4gICAgICAgIDQwNCxcbiAgICAgICAgdGhpcy5tLmNvbnRleHQubWFwKCh4KSA9PiB4LmlkKSxcbiAgICAgICk7XG4gICAgY29uc3QgcGF0aHMgPSBkb2NQYXRocyhlKTtcbiAgICBjb25zdCBpbmRleDogQnVuZGxlSW5kZXggPSB7XG4gICAgICByb290OiBlLnJvb3QsXG4gICAgICBwYXRocyxcbiAgICAgIG1ldGFPZjogKHApID0+IHJlYWRNZXRhKHJlYWRIZWFkKHApKSxcbiAgICAgIGV4aXN0czogKHApID0+IGV4aXN0c1N5bmMocCksXG4gICAgICByZXBvUm9vdDogZ2l0Um9vdE9mKGUucm9vdCksXG4gICAgfTtcbiAgICBjb25zdCBnID0gYnVpbGRHcmFwaChpbmRleCwgKHApID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBzcGxpdEZyb250bWF0dGVyKHJlYWRGaWxlU3luYyhwLCBcInV0ZjhcIikpLmJvZHk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIFwiXCI7XG4gICAgICB9XG4gICAgfSk7XG4gICAgcmV0dXJuIHsgZW50cnk6IGUuaWQsIC4uLmcgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFdmVyeSBsaW5rIGluIGEgc2V0IHRoYXQgbm90aGluZyBhbnN3ZXJzIOKAlCB0aGUgcmVwb3J0IHlvdSBjYW4gQUNUIG9uIChFNTQpLlxuICAgKlxuICAgKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgYGdyYXBoYCBBTFJFQURZIEhBRCBUSEUgRkFDVFMgQU5EIFNUSUxMIERJRCBOT1QgQU5TV0VSXG4gICAqIFRIRSBRVUVTVElPTi4gQ29sZSBhc2tlZCB3aGV0aGVyIGFuIGFnZW50IGNhbiBjaGVjayBkYW5nbGluZyBsaW5rczsgdGhlXG4gICAqIGhvbmVzdCBhbnN3ZXIgd2FzIFwieWVzLCBieSBmZXRjaGluZyBhIHNldCdzIHdob2xlIG1hcCBhbmQgZmlsdGVyaW5nIHNldmVyYWxcbiAgICogaHVuZHJlZCBlZGdlc1wiLCB3aGljaCBpcyBhIGRpZmZlcmVudCB0aGluZyBmcm9tIGJlaW5nIGFibGUgdG8gY2hlY2sgdGhlbS5cbiAgICogVGhpcyBzYXlzIG9ubHkgd2hhdCBpcyBicm9rZW4sIGFuZCBzYXlzIGl0IGFzIGBmaWxlOmxpbmVgIHBsdXMgVEhFIFNUUklOR1xuICAgKiBUSEUgRE9DVU1FTlQgQUNUVUFMTFkgQ09OVEFJTlMg4oCUIHdoaWNoIGlzIHdoYXQgeW91IG5lZWQgdG8gcmVwYWlyIG9uZSwgYW5kXG4gICAqIHdoYXQgdGhlIG1hcCdzIHJlc29sdmVkIGB0b2AgaGFkIHF1aWV0bHkgdGhyb3duIGF3YXkuXG4gICAqXG4gICAqIOKaoCBOT1QgQU4gRVJST1IuIEEgZGFuZ2xpbmcgbGluayBpcyBhIGZhY3QgYWJvdXQgYSBzZXQsIG5vdCBhIGZhaWx1cmU6IE9LRlxuICAgKiDCpzExJ3MgcnVsZSwgYW5kIGl0IGlzIHdoeSB0aGlzIHJlcG9ydHMgYW5kIGV4aXRzIHplcm8uIERvY3VtZW50cyB0aGF0IHBvaW50XG4gICAqIGF0IHRoaW5ncyBub3Qgd3JpdHRlbiB5ZXQgYXJlIG5vcm1hbCBpbiBhIHdvcmxkIGJpYmxlLlxuICAgKi9cbiAgZGFuZ2xpbmdMaW5rcyhlbnRyeUlkPzogc3RyaW5nKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IGcgPSB0aGlzLmdyYXBoRm9yKGVudHJ5SWQpO1xuICAgIGNvbnN0IGJyb2tlbiA9IGcuZWRnZXMuZmlsdGVyKChlKSA9PiBlLnN0YXRlID09PSBcIm1pc3NpbmdcIik7XG4gICAgLy8g4puUIEJPRFkgTElORVMgQkVDT01FIEZJTEUgTElORVMgSEVSRS4gTGlua3MgYXJlIGV4dHJhY3RlZCBmcm9tIHRoZSBib2R5LFxuICAgIC8vIHNvIHRoZSBudW1iZXIgdGhlIGdyYXBoIGNhcnJpZXMgaXMgc2hvcnQgYnkgaG93ZXZlciBtdWNoIGZyb250bWF0dGVyIHRoZVxuICAgIC8vIGRvY3VtZW50IGhhcyDigJQgYW5kIGEgcmVwb3J0IGlzIGZvciBvcGVuaW5nIGEgZmlsZSBhdCBhIGxpbmUuXG4gICAgY29uc3Qgb2Zmc2V0cyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gICAgY29uc3Qgb2Zmc2V0T2YgPSAocGF0aDogc3RyaW5nKTogbnVtYmVyID0+IHtcbiAgICAgIGNvbnN0IGtub3duID0gb2Zmc2V0cy5nZXQocGF0aCk7XG4gICAgICBpZiAoa25vd24gIT09IHVuZGVmaW5lZCkgcmV0dXJuIGtub3duO1xuICAgICAgbGV0IG9mZiA9IDA7XG4gICAgICB0cnkge1xuICAgICAgICBvZmYgPSBib2R5TGluZU9mZnNldChyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiB1bnJlYWRhYmxlIOKAlCByZXBvcnQgdGhlIGJvZHkgbGluZSByYXRoZXIgdGhhbiBub3RoaW5nICovXG4gICAgICB9XG4gICAgICBvZmZzZXRzLnNldChwYXRoLCBvZmYpO1xuICAgICAgcmV0dXJuIG9mZjtcbiAgICB9O1xuICAgIHJldHVybiB7XG4gICAgICBlbnRyeTogZy5lbnRyeSxcbiAgICAgIHJvb3Q6IGcucm9vdCxcbiAgICAgIGNvdW50OiBicm9rZW4ubGVuZ3RoLFxuICAgICAgbGlua3M6IGJyb2tlbi5tYXAoKGUpID0+ICh7XG4gICAgICAgIGZyb206IGUuZnJvbSxcbiAgICAgICAgLi4uKGUubGluZSAhPT0gdW5kZWZpbmVkID8geyBsaW5lOiBlLmxpbmUgKyBvZmZzZXRPZihlLmZyb20pIH0gOiB7fSksXG4gICAgICAgIC8vIFdoYXQgdGhlIGRvY3VtZW50IHNheXMsIG5vdCB3aGF0IHdlIGxvb2tlZCBmb3IuXG4gICAgICAgIC4uLihlLnJhdyAhPT0gdW5kZWZpbmVkID8geyB3cm90ZTogZS5yYXcgfSA6IHt9KSxcbiAgICAgICAgLy8gV2hlcmUgdGhlIHJlc29sdXRpb24gZW5kZWQgdXAsIHNvIGEgbmVhci1taXNzIGlzIHZpc2libGUuXG4gICAgICAgIHRyaWVkOiBlLnRvLFxuICAgICAgICBzb3VyY2U6IGUuc291cmNlLFxuICAgICAgICAuLi4oZS5rZXkgPyB7IGtleTogZS5rZXkgfSA6IHt9KSxcbiAgICAgICAgLi4uKGUucmVsLmxlbmd0aCA/IHsgcmVsOiBlLnJlbCB9IDoge30pLFxuICAgICAgfSkpLFxuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogV2hhdCBjaXRlcyBhIGRvY3VtZW50LiBgcmVsYXRlZGAgKGZyb250bWF0dGVyKSBhbmQgYGxpbmtzYCAoYm9keSkgYXJlIGtlcHRcbiAgICogQVBBUlQsIHdoaWNoIGlzIGhvdyBwZG9jcyByZXBvcnRzIGl0IGFuZCB0aGUgZGlzdGluY3Rpb24gaXMgcmVhbDogb25lIGlzIGFcbiAgICogY2xhaW0gYWJvdXQgdGhlIGRvY3VtZW50LCB0aGUgb3RoZXIgYSBjaXRhdGlvbiBpbiBwcm9zZS5cbiAgICovXG4gIGJhY2tsaW5rcyhyYXdQYXRoOiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zaG93blBhdGgocmF3UGF0aCk7XG4gICAgY29uc3QgZW50cnkgPSB0aGlzLm0uY29udGV4dC5maW5kKFxuICAgICAgKGUpID0+IGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiICYmIChhYnMgPT09IGUucm9vdCB8fCBhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSxcbiAgICApO1xuICAgIGlmICghZW50cnkpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YWJzfSBpcyBub3QgaW5zaWRlIGEgc2V0LCBzbyBub3RoaW5nIG1hcHMgaXRgLCA0MDApO1xuICAgIGNvbnN0IGcgPSB0aGlzLmdyYXBoRm9yKGVudHJ5LmlkKTtcbiAgICBjb25zdCBpbmJvdW5kID0gZy5lZGdlcy5maWx0ZXIoKHgpID0+IHgudG8gPT09IGFicyk7XG4gICAgY29uc3QgdGl0bGUgPSAocDogc3RyaW5nKSA9PiBnLm5vZGVzLmZpbmQoKG4pID0+IG4ucGF0aCA9PT0gcCk/LnRpdGxlID8/IGJhc2VuYW1lKHApO1xuICAgIHJldHVybiB7XG4gICAgICB0YXJnZXQ6IHsgcGF0aDogYWJzLCB0aXRsZTogdGl0bGUoYWJzKSB9LFxuICAgICAgcmVsYXRlZDogaW5ib3VuZFxuICAgICAgICAuZmlsdGVyKCh4KSA9PiB4LnNvdXJjZSA9PT0gXCJmcm9udG1hdHRlclwiKVxuICAgICAgICAubWFwKCh4KSA9PiAoeyBwYXRoOiB4LmZyb20sIHRpdGxlOiB0aXRsZSh4LmZyb20pLCBrZXk6IHgua2V5IH0pKSxcbiAgICAgIGxpbmtzOiBpbmJvdW5kXG4gICAgICAgIC5maWx0ZXIoKHgpID0+IHguc291cmNlID09PSBcImxpbmtcIilcbiAgICAgICAgLm1hcCgoeCkgPT4gKHsgcGF0aDogeC5mcm9tLCB0aXRsZTogdGl0bGUoeC5mcm9tKSwgcmVsOiB4LnJlbCB9KSksXG4gICAgICBjb3VudDogaW5ib3VuZC5sZW5ndGgsXG4gICAgfTtcbiAgfVxuXG4gIC8qKiBXaGVyZSBkb2VzIHRoaXMgbGluayBnbz8gVGhlIHN1cmZhY2UgYXNrcyBiZWZvcmUgZm9sbG93aW5nIG9uZSAoRTMzKS4gKi9cbiAgcmVzb2x2ZUxpbmsoZnJvbTogc3RyaW5nLCB0YXJnZXQ6IHN0cmluZyk6IFJlc29sdXRpb24ge1xuICAgIGNvbnN0IHNyYyA9IHRoaXMuc2hvd25QYXRoKGZyb20pO1xuICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5tLmNvbnRleHQuZmluZChcbiAgICAgIChlKSA9PiBlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiAmJiBzcmMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApLFxuICAgICk7XG4gICAgY29uc3Qgcm9vdCA9IGVudHJ5Py5yb290ID8/IGRpcm5hbWUoc3JjKTtcbiAgICBjb25zdCBwYXRocyA9IGVudHJ5ID8gZG9jUGF0aHMoZW50cnkpIDogW3NyY107XG4gICAgcmV0dXJuIHJlc29sdmVUYXJnZXQodGFyZ2V0LCBzcmMsIHtcbiAgICAgIHJvb3QsXG4gICAgICBwYXRocyxcbiAgICAgIG1ldGFPZjogKHApID0+IHJlYWRNZXRhKHJlYWRIZWFkKHApKSxcbiAgICAgIGV4aXN0czogKHApID0+IGV4aXN0c1N5bmMocCksXG4gICAgICByZXBvUm9vdDogZ2l0Um9vdE9mKHJvb3QpLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFdoYXQgYSBmcm9udG1hdHRlciBibG9jayBmb3IgdGhpcyBkb2N1bWVudCBXT1VMRCBzYXkgKEUzNSkuIFN1Z2dlc3RlZCwgbm90XG4gICAqIHdyaXR0ZW46IHRoZSB0eXBlIGNvbWVzIGZyb20gdGhlIGRvY3VtZW50cyBiZXNpZGUgaXQsIHRoZSB0aXRsZSBmcm9tIGl0c1xuICAgKiBvd24gSDEsIGFuZCBgZGVzY3JpcHRpb25gIGlzIGxlZnQgYmxhbmsgZm9yIHdob2V2ZXIgZmlsbHMgaXQgaW4uXG4gICAqL1xuICBzdWdnZXN0TWV0YShyYXdQYXRoOiBzdHJpbmcsIGJ5Pzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IGJsb2NrOiBzdHJpbmc7IHR5cGU/OiBzdHJpbmcgfSB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zaG93blBhdGgocmF3UGF0aCk7XG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICBpZiAoc3BsaXRGcm9udG1hdHRlcih0ZXh0KS5yYXcgIT09IG51bGwpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Jhc2VuYW1lKGFicyl9IGFscmVhZHkgaGFzIGZyb250bWF0dGVyYCwgNDA5KTtcbiAgICBjb25zdCBmb2xkZXIgPSBkaXJuYW1lKGFicyk7XG4gICAgY29uc3Qgc2libGluZ3M6IHN0cmluZ1tdID0gW107XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KVxuICAgICAgZm9yIChjb25zdCBwIG9mIGRvY1BhdGhzKGUpKVxuICAgICAgICBpZiAocCAhPT0gYWJzICYmIGRpcm5hbWUocCkgPT09IGZvbGRlcikge1xuICAgICAgICAgIGNvbnN0IHQgPSByZWFkTWV0YShyZWFkSGVhZChwKSk/LnR5cGU7XG4gICAgICAgICAgaWYgKHQpIHNpYmxpbmdzLnB1c2godCk7XG4gICAgICAgIH1cbiAgICBjb25zdCB0eXBlID0gZ3Vlc3NUeXBlKHNpYmxpbmdzLCBiYXNlbmFtZShmb2xkZXIpKTtcbiAgICByZXR1cm4ge1xuICAgICAgcGF0aDogYWJzLFxuICAgICAgdHlwZSxcbiAgICAgIGJsb2NrOiBidWlsZEJsb2NrKHtcbiAgICAgICAgLi4uKHR5cGUgPyB7IHR5cGUgfSA6IHt9KSxcbiAgICAgICAgLi4uKHRpdGxlRnJvbUJvZHkodGV4dCkgPyB7IHRpdGxlOiB0aXRsZUZyb21Cb2R5KHRleHQpIGFzIHN0cmluZyB9IDoge30pLFxuICAgICAgICAuLi4oYnkgPyB7IGJ5IH0gOiB7fSksXG4gICAgICB9KSxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFdyaXRlIGEgbmV3IGJsb2NrIGludG8gYSBkb2N1bWVudCB0aGF0IGhhcyBub25lIChFMzUpLlxuICAgKlxuICAgKiDim5QgVEhJUyBXUklURVMgVEhFIE9SSUdJTkFMLCB3aGljaCBFNyBvdGhlcndpc2UgcmVzZXJ2ZXMgZm9yIFNhdmUg4oCUIGFuZFxuICAgKiB0aGF0IGlzIHRoZSBydWxpbmcsIG5vdCBhbiBvdmVyc2lnaHQ6IHRoZSBhZ2VudCdzIHZlcmIgd3JpdGVzIHRoZSBmaWxlLCBhbmRcbiAgICogaWYgdGhlIGh1bWFuIGhhcyB1bnNhdmVkIGVkaXRzIHRvIGl0IHRoZSBDT05GTElDVCBCQVIgYXBwZWFycyBhbmQgdGhleVxuICAgKiBjaG9vc2UgKENvbGU6IFwid2UgY2FuIGFkanVzdCBpZiBuZWVkZWQgYWZ0ZXIgZ2V0dGluZyBhY3R1YWwgdXNhZ2UgYmVoaW5kXG4gICAqIHVzXCIpLiBSZWZ1c2luZyB3aGlsZSBhIGJ1ZmZlciBpcyBkaXJ0eSB3b3VsZCBsZXQgYW4gb3BlbiBkb2N1bWVudCBibG9jayB0aGVcbiAgICogYWdlbnQgaW5kZWZpbml0ZWx5LiBUaGUgSFVNQU4ncyBvd24gcGF0aCBuZXZlciBjb21lcyBoZXJlOiB0aGVpciBcImFkZFxuICAgKiBmcm9udG1hdHRlclwiIGlzIGFuIGVkaXQgdG8gdGhlaXIgYnVmZmVyLCB3aGljaCBTYXZlIHdyaXRlcyBsaWtlIGFueSBvdGhlci5cbiAgICovXG4gIG1ldGFJbml0KHJhd1BhdGg6IHN0cmluZywgb3B0czogeyB0eXBlPzogc3RyaW5nOyBieT86IHN0cmluZyB9ID0ge30pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3Qgc3VnZ2VzdGVkID0gdGhpcy5zdWdnZXN0TWV0YShyYXdQYXRoLCBvcHRzLmJ5KTtcbiAgICBjb25zdCBhYnMgPSBzdWdnZXN0ZWQucGF0aDtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IGJsb2NrID0gb3B0cy50eXBlXG4gICAgICA/IGJ1aWxkQmxvY2soe1xuICAgICAgICAgIHR5cGU6IG9wdHMudHlwZSxcbiAgICAgICAgICAuLi4odGl0bGVGcm9tQm9keSh0ZXh0KSA/IHsgdGl0bGU6IHRpdGxlRnJvbUJvZHkodGV4dCkgYXMgc3RyaW5nIH0gOiB7fSksXG4gICAgICAgICAgLi4uKG9wdHMuYnkgPyB7IGJ5OiBvcHRzLmJ5IH0gOiB7fSksXG4gICAgICAgIH0pXG4gICAgICA6IHN1Z2dlc3RlZC5ibG9jaztcbiAgICB3cml0ZUZpbGVTeW5jKGFicywgd2l0aEJsb2NrKHRleHQsIGJsb2NrKSk7XG4gICAgdGhpcy5tZXRhQ2FjaGUuZGVsZXRlKGFicyk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzLCB0eXBlOiBvcHRzLnR5cGUgPz8gc3VnZ2VzdGVkLnR5cGUgPz8gbnVsbCwgYWRkZWQ6IHRydWUgfTtcbiAgfVxuXG4gIC8qKiBTZXQga2V5cyBpbiBhbiBleGlzdGluZyBibG9jayDigJQgYSBMSU5FIGVkaXQgZWFjaCwgc28gbm90aGluZyBlbHNlIG1vdmVzLiAqL1xuICBtZXRhU2V0KHJhd1BhdGg6IHN0cmluZywgcGFpcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zaG93blBhdGgocmF3UGF0aCk7XG4gICAgbGV0IHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgaWYgKHNwbGl0RnJvbnRtYXR0ZXIodGV4dCkucmF3ID09PSBudWxsKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHtiYXNlbmFtZShhYnMpfSBoYXMgbm8gZnJvbnRtYXR0ZXIg4oCUIGFkZCBpdCBmaXJzdCAobWV0YS1pbml0KWAsIDQwOSk7XG4gICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocGFpcnMpKSB7XG4gICAgICBpZiAoIS9eW0EtWmEtel9dW0EtWmEtejAtOV8uLV0qJC8udGVzdChrZXkpKVxuICAgICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBcIiR7a2V5fVwiIGlzIG5vdCBhIGZyb250bWF0dGVyIGtleWAsIDQwMCk7XG4gICAgICB0ZXh0ID0gc2V0S2V5KHRleHQsIGtleSwgdmFsdWUpO1xuICAgIH1cbiAgICB3cml0ZUZpbGVTeW5jKGFicywgdGV4dCk7XG4gICAgdGhpcy5tZXRhQ2FjaGUuZGVsZXRlKGFicyk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzLCBzZXQ6IE9iamVjdC5rZXlzKHBhaXJzKSB9O1xuICB9XG5cbiAgLyoqIFRoZSBzZXNzaW9uJ3MgaGFsZiBvZiBgUHVibGljU3RhdGVgOyB0aGUgZGFlbW9uIGFkZHMgdGhlIGhvbWUtbGV2ZWwgYHByZWZzYCBhbmQgYHVzZXJIb21lYC4gKi9cbiAgLyoqXG4gICAqIFRoZSBjb252ZXJzYXRpb24sIHdpdGhvdXQgYnVpbGRpbmcgYSBzbmFwc2hvdCBhcm91bmQgaXQuXG4gICAqXG4gICAqIOKaoCBFNTMncyBhdHRlbnRpb24gdGljayBydW5zIGV2ZXJ5IHNlY29uZCBhbmQgb25seSBuZWVkcyB0aGUgY2hhdDsgY2FsbGluZ1xuICAgKiBgdmlldygpYCBmb3IgaXQgd291bGQgcmUtcmVhZCBldmVyeSBkb2N1bWVudCdzIGZyb250bWF0dGVyIG9uIGEgdGltZXIuXG4gICAqL1xuICBtZXNzYWdlcygpOiByZWFkb25seSBDaGF0TWVzc2FnZVtdIHtcbiAgICByZXR1cm4gdGhpcy5tLmNoYXQ7XG4gIH1cblxuICB2aWV3KFxuICAgIG1vZGU6IFwiZGV2XCIgfCBcInJlbGVhc2VcIixcbiAgICBzZWxlY3Rpb246IFNlbGVjdGlvbiB8IG51bGwsXG4gICAgLy8g4pqgIGB3YWl0aW5nYCBpcyB0aGUgU0VSVkVSJ3MgdG8gYWRkIChFNTMpOiBpdCBkZXBlbmRzIG9uIHRoZSBjbG9jayBhbmQgb25cbiAgICAvLyB0aGUgc25vb3plIHRoZSBzZXJ2ZXIgaG9sZHMsIG5laXRoZXIgb2Ygd2hpY2ggYmVsb25ncyBpbiB0aGUgc2Vzc2lvbi5cbiAgKTogT21pdDxQdWJsaWNTdGF0ZSwgXCJwcmVmc1wiIHwgXCJ1c2VySG9tZVwiIHwgXCJ3YWl0aW5nXCI+IHtcbiAgICBjb25zdCBtZXRhID0gdGhpcy5jb250ZXh0TWV0YSgpO1xuICAgIHJldHVybiB7XG4gICAgICBzZXNzaW9uSWQ6IHRoaXMubS5zZXNzaW9uSWQsXG4gICAgICBob21lOiB0aGlzLmhvbWUsXG4gICAgICB3b3Jrc3BhY2U6IHRoaXMud29ya3NwYWNlLFxuICAgICAgZG9jTWV0YTogbWV0YS5tYXAsXG4gICAgICAuLi4obWV0YS50cnVuY2F0ZWQgPyB7IGRvY01ldGFUcnVuY2F0ZWQ6IHRydWUgfSA6IHt9KSxcbiAgICAgIG1vZGUsXG4gICAgICBjb250ZXh0OiB0aGlzLm0uY29udGV4dCxcbiAgICAgIGRvY3M6IHRoaXMubS5kb2NzLm1hcCgoZCkgPT4gdGhpcy5kb2NWaWV3KGQpKSxcbiAgICAgIG9wZW5Eb2M6IHRoaXMubS5vcGVuRG9jLFxuICAgICAgc2VsZWN0aW9uLFxuICAgICAgY2hhdDogdGhpcy5tLmNoYXQsXG4gICAgICB0YXNrczogdGhpcy50YXNrcygpLFxuICAgIH07XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgZ2l0IHdvcmtpbmcgdHJlZSBgZGlyYCBpcyBpbiwgb3IgbnVsbC4gQSBgLmdpdGAgRU5UUlksIG5vdCBhIGRpcmVjdG9yeVxuICogdGVzdDogYSB3b3JrdHJlZSBhbmQgYSBzdWJtb2R1bGUgYm90aCBoYXZlIGAuZ2l0YCBhcyBhIEZJTEUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnaXRSb290T2YoZGlyOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgbGV0IGF0ID0gZGlyO1xuICBmb3IgKDs7KSB7XG4gICAgaWYgKGV4aXN0c1N5bmMoam9pbihhdCwgXCIuZ2l0XCIpKSkgcmV0dXJuIGF0O1xuICAgIGNvbnN0IHVwID0gZGlybmFtZShhdCk7XG4gICAgaWYgKHVwID09PSBhdCkgcmV0dXJuIG51bGw7XG4gICAgYXQgPSB1cDtcbiAgfVxufVxuXG4vKiogRG9jdW1lbnRzIHVuZGVyIGEgZm9sZGVyLCBmb3Igc2F5aW5nIGhvdyBtdWNoIGEgbW92ZSBtb3Zlcy4gKi9cbmZ1bmN0aW9uIGNvdW50RG9jcyhkaXI6IHN0cmluZyk6IG51bWJlciB7XG4gIGxldCBuID0gMDtcbiAgY29uc3Qgd2FsayA9IChhdDogc3RyaW5nKSA9PiB7XG4gICAgbGV0IG5hbWVzOiBzdHJpbmdbXTtcbiAgICB0cnkge1xuICAgICAgbmFtZXMgPSByZWFkZGlyU3luYyhhdCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcykge1xuICAgICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgYWJzID0gam9pbihhdCwgbmFtZSk7XG4gICAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB3YWxrKGFicyk7XG4gICAgICBlbHNlIGlmIChpc0RvY05hbWUobmFtZSkpIG4rKztcbiAgICB9XG4gIH07XG4gIHdhbGsoZGlyKTtcbiAgcmV0dXJuIG47XG59XG5cbi8qKlxuICogSG93IGEgY29tcGFyaXNvbiBzaWRlIHJlYWRzIGluIGEgbWVzc2FnZSB0byBhIGh1bWFuIG9yIGFuIGFnZW50LlxuICpcbiAqIOKblCBUSEUgRklMRSBJUyBOQU1FRCwgTk9UIERFU0NSSUJFRCAoRTQzLCByZXZpc2VkKS4gXCJUaGUgb3JpZ2luYWxcIiBzb3VuZGVkXG4gKiB0ZW1wb3JhbCB3aGVuIHRoZSB0aGluZyBpcyBsb2NhdGlvbmFsOyBcInRoZSBzYXZlZCBmaWxlXCIgZml4ZWQgdGhhdCBidXQgcmVhZHNcbiAqIGNpcmN1bGFyIHRoZSBtb21lbnQgaXQgaXMgYSBERVNUSU5BVElPTiDigJQgXCJzYXZlIHRvIHRoZSBzYXZlZCBmaWxlXCIgc2F5c1xuICogbm90aGluZy4gTm8gbm91biBlbmNhcHN1bGF0ZXMgXCJ0aGlzIGZpbGUsIGF0IHRoaXMgcGxhY2VcIiwgc28gdGhlIGZpbGUgZ2V0c1xuICogaXRzIG93biBuYW1lOiBgbm90ZS5tZGAuIENvbGU6IFwidGhhdCdzIHByb2JhYmx5IGNsb3NlciB0byB0aGUgcmlnaHQgYW5zd2VyXG4gKiB2ZXJzdXMgdHJ5aW5nIHRvIGNvbWUgdXAgd2l0aCBhIHdvcmQgdGhhdCBlbmNhcHN1bGF0ZXMgaXQuXCJcbiAqXG4gKiBgZmlsZWAgaXMgdGhlIGRvY3VtZW50J3MgbmFtZSB3aGVuIHRoZSBjYWxsZXIga25vd3MgaXQ7IHdpdGhvdXQgb25lIHRoaXNcbiAqIGZhbGxzIGJhY2sgdG8gYSBnZW5lcmljLCB3aGljaCBpcyBvbmx5IGZvciBjb250ZXh0cyB0aGF0IGhhdmUgbm8gZG9jdW1lbnQgaW5cbiAqIGhhbmQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaWRlTmFtZShzaWRlOiBEaWZmU2lkZSwgZmlsZT86IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChzaWRlICE9PSBcIm9yaWdpbmFsXCIpIHJldHVybiBgdiR7c2lkZX1gO1xuICByZXR1cm4gZmlsZSA/PyBcInRoZSBzYXZlZCBmaWxlXCI7XG59XG4iLAogICAgIi8qKlxuICogT0tGIGZyb250bWF0dGVyLCByZWFkIChFMzIpLiBUaGUgZGFlbW9uIHBhcnNlczsgdGhlIHN1cmZhY2UgcmVuZGVycyB3aGF0IGl0XG4gKiBpcyBnaXZlbiDigJQgYEJ1bi5ZQU1MLnBhcnNlYCBpcyBoZXJlLCBzbyBubyBZQU1MIHBhcnNlciByZWFjaGVzIHRoZSBicm93c2VyLlxuICpcbiAqIOKblCBUSEUgU1BFQydTIFRFTVBFUiBJUyBUSEUgUE9JTlQsIEFORCBJVCBJUyBOT1QgVEhFIFVTVUFMIE9ORS4gQSBjb25zdW1lclxuICogXCJNVVNUIE5PVCByZWplY3QgZG9jdW1lbnRzXCIgZm9yIHVua25vd24gdHlwZXMsIHVua25vd24ga2V5cywgbWlzc2luZyBvcHRpb25hbFxuICogZmllbGRzIG9yIGJyb2tlbiBsaW5rcywgYW5kIFwiU0hPVUxEIHByZXNlcnZlIHVua25vd24ga2V5cyB3aGVuIHJvdW5kLXRyaXBwaW5nXCJcbiAqIChPS0YgMC4yIMKnMTEpLiBTbyBub3RoaW5nIGhlcmUgdmFsaWRhdGVzOiBhIGRvY3VtZW50IHdob3NlIGZyb250bWF0dGVyIHdpbGxcbiAqIG5vdCBwYXJzZSBrZWVwcyBpdHMgdGV4dCBhbmQgcmVwb3J0cyB0aGUgcmVhc29uLCBldmVyeSBrZXkgc3Vydml2ZXMgaW5cbiAqIGBmaWVsZHNgIHdoZXRoZXIgb3Igbm90IHRoaXMgc3BlbGwgaGFzIGhlYXJkIG9mIGl0LCBhbmQgYHR5cGVgIOKAlCB0aGUgT05FXG4gKiByZXF1aXJlZCBmaWVsZCDigJQgYmVpbmcgYWJzZW50IGlzIGEgZmFjdCB0byBzaG93LCBuZXZlciBhbiBlcnJvciB0byByYWlzZS5cbiAqXG4gKiBUaGUgREVSSVZFRCB2YWx1ZXMgKHRydXN0LCBzdGFsZW5lc3MpIGFyZSBjb21wdXRlZCBvbiByZWFkIGFuZCBuZXZlciBzdG9yZWQsXG4gKiB3aGljaCBpcyBhbHNvIHRoZSBzcGVjJ3MgcnVsZTogYSB0cnVzdCB0aWVyIHdyaXR0ZW4gaW50byBhIGZpbGUgd291bGQgYmUgYVxuICogY2xhaW0gYWJvdXQgaXRzZWxmLlxuICovXG5pbXBvcnQgdHlwZSB7IERvY01ldGEsIERvY1N1bW1hcnksIFRydXN0VGllciB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKiBBIGZyb250bWF0dGVyIGJsb2NrOiBgLS0tYCBvbiBpdHMgb3duIGZpcnN0IGxpbmUsIHRvIHRoZSBuZXh0IGAtLS1gIGxpbmUuICovXG5jb25zdCBCTE9DSyA9IC9eLS0tXFxyP1xcbihbXFxzXFxTXSo/KVxccj9cXG4tLS1bIFxcdF0qKD86XFxyP1xcbnwkKS87XG5cbi8qKlxuICogU3BsaXQgYSBkb2N1bWVudCBpbnRvIGl0cyByYXcgZnJvbnRtYXR0ZXIgYmxvY2sgYW5kIHRoZSBib2R5IGJlbmVhdGggaXQuXG4gKiBQdXJlIHN0cmluZyB3b3JrLCBubyBZQU1MIOKAlCB0aGUgU1VSRkFDRSBoYXMgdGhlIHNhbWUgZnVuY3Rpb24gKGl0IG11c3Qgc3RyaXBcbiAqIHRoZSBibG9jayBiZWZvcmUgcmVuZGVyaW5nKSBhbmQgYGZyb250bWF0dGVyLnRlc3QudHNgIGhvbGRzIHRoZSB0d28gZXF1YWwuXG4gKi9cbi8qKlxuICogSG93IG1hbnkgbGluZXMgb2YgYSBkb2N1bWVudCBjb21lIEJFRk9SRSBpdHMgYm9keSDigJQgdGhlIGZyb250bWF0dGVyIGJsb2NrIGFuZFxuICogaXRzIGRlbGltaXRlcnMuXG4gKlxuICog4puUIFdJVEhPVVQgVEhJUyBBIFJFUE9SVEVEIExJTkUgTlVNQkVSIElTIEEgTElFLiBMaW5rcyBhcmUgZXh0cmFjdGVkIGZyb20gdGhlXG4gKiBCT0RZLCBzbyBhIGxpbmsgb24gYm9keSBsaW5lIDkgb2YgYSBkb2N1bWVudCB3aXRoIGZvdXIgbGluZXMgb2YgZnJvbnRtYXR0ZXJcbiAqIGlzIG9uIEZJTEUgbGluZSAxMyDigJQgYW5kIGEgcmVwb3J0IHRoYXQgc2F5cyA5IHNlbmRzIHdob2V2ZXIgaXMgZml4aW5nIGl0IHRvXG4gKiB0aGUgd3JvbmcgcGxhY2UsIGNvbmZpZGVudGx5LiBDYXVnaHQgdGhlIG1vbWVudCBFNTQncyByZXBvcnQgd2FzIGZpcnN0IHJlYWRcbiAqIGFnYWluc3QgYSBkb2N1bWVudCB0aGF0IGhhZCBmcm9udG1hdHRlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJvZHlMaW5lT2Zmc2V0KHRleHQ6IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IHsgYm9keSB9ID0gc3BsaXRGcm9udG1hdHRlcih0ZXh0KTtcbiAgY29uc3QgcHJlZml4ID0gdGV4dC5zbGljZSgwLCB0ZXh0Lmxlbmd0aCAtIGJvZHkubGVuZ3RoKTtcbiAgbGV0IGxpbmVzID0gMDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBwcmVmaXgubGVuZ3RoOyBpKyspIGlmIChwcmVmaXguY2hhckNvZGVBdChpKSA9PT0gMTApIGxpbmVzKys7XG4gIHJldHVybiBsaW5lcztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNwbGl0RnJvbnRtYXR0ZXIodGV4dDogc3RyaW5nKTogeyByYXc6IHN0cmluZyB8IG51bGw7IGJvZHk6IHN0cmluZyB9IHtcbiAgY29uc3QgbSA9IEJMT0NLLmV4ZWModGV4dCk7XG4gIGlmICghbSkgcmV0dXJuIHsgcmF3OiBudWxsLCBib2R5OiB0ZXh0IH07XG4gIHJldHVybiB7IHJhdzogbVsxXSA/PyBcIlwiLCBib2R5OiB0ZXh0LnNsaWNlKG1bMF0ubGVuZ3RoKSB9O1xufVxuXG4vKiogT0tGJ3MgdGhyZWUsIGFuZCBhbnl0aGluZyBlbHNlIGEgcHJvZHVjZXIgd3JvdGUuIGBzdGFibGVgIGlzIHRoZSBkZWZhdWx0LiAqL1xuZnVuY3Rpb24gc3RhdHVzT2YoZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHN0cmluZyB7XG4gIGNvbnN0IHMgPSBmaWVsZHMuc3RhdHVzO1xuICByZXR1cm4gdHlwZW9mIHMgPT09IFwic3RyaW5nXCIgJiYgcy50cmltKCkgIT09IFwiXCIgPyBzIDogXCJzdGFibGVcIjtcbn1cblxuY29uc3QgYXNMaXN0ID0gKHY6IHVua25vd24pOiBzdHJpbmdbXSA9PlxuICBBcnJheS5pc0FycmF5KHYpID8gdi5maWx0ZXIoKHgpID0+IHR5cGVvZiB4ID09PSBcInN0cmluZ1wiKSA6IHR5cGVvZiB2ID09PSBcInN0cmluZ1wiID8gW3ZdIDogW107XG5cbi8qKiBBbiBhY3RvciBpcyBodW1hbiBpZmYgaXQgaXMgc3BlbGxlZCBgaHVtYW46PGlkPmAg4oCUIE9LRiAwLjIgwqc2J3MgcnVsZS4gKi9cbmNvbnN0IGlzSHVtYW4gPSAoYWN0b3I6IHVua25vd24pOiBib29sZWFuID0+XG4gIHR5cGVvZiBhY3RvciA9PT0gXCJzdHJpbmdcIiAmJiBhY3Rvci50b0xvd2VyQ2FzZSgpLnN0YXJ0c1dpdGgoXCJodW1hbjpcIik7XG5cbi8qKlxuICogT0tGJ3MgdHJ1c3QgdGllcnMsIERFUklWRUQ6IG5vIGB2ZXJpZmllZGAg4oaSIHVudmVyaWZpZWQ7IHZlcmlmaWVkIGJ5IG1hY2hpbmVzXG4gKiBvbmx5IOKGkiBtYWNoaW5lLWNvbmZpcm1lZDsgdmVyaWZpZWQgYnkgYSBgaHVtYW46PGlkPmAg4oaSIGh1bWFuLXJldmlld2VkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdHJ1c3RUaWVyKGZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBUcnVzdFRpZXIge1xuICBjb25zdCB2ZXJpZmllZCA9IGZpZWxkcy52ZXJpZmllZDtcbiAgY29uc3QgZXZlbnRzID0gQXJyYXkuaXNBcnJheSh2ZXJpZmllZCkgPyB2ZXJpZmllZCA6IHZlcmlmaWVkID8gW3ZlcmlmaWVkXSA6IFtdO1xuICBpZiAoZXZlbnRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFwidW52ZXJpZmllZFwiO1xuICBmb3IgKGNvbnN0IGUgb2YgZXZlbnRzKVxuICAgIGlmIChlICYmIHR5cGVvZiBlID09PSBcIm9iamVjdFwiICYmIGlzSHVtYW4oKGUgYXMgeyBieT86IHVua25vd24gfSkuYnkpKSByZXR1cm4gXCJodW1hbi1yZXZpZXdlZFwiO1xuICByZXR1cm4gXCJtYWNoaW5lLWNvbmZpcm1lZFwiO1xufVxuXG4vKiogYHN0YWxlX2FmdGVyYCBpcyBhbiBJTlNUQU5ULCBub3QgYSBUVEw6IHN0YWxlIHdoZW4gbm93ID49IGl0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzU3RhbGUoZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgbm93OiBudW1iZXIpOiBib29sZWFuIHtcbiAgY29uc3QgYXQgPSBmaWVsZHMuc3RhbGVfYWZ0ZXI7XG4gIGNvbnN0IHQgPVxuICAgIGF0IGluc3RhbmNlb2YgRGF0ZSA/IGF0LmdldFRpbWUoKSA6IHR5cGVvZiBhdCA9PT0gXCJzdHJpbmdcIiA/IERhdGUucGFyc2UoYXQpIDogTnVtYmVyLk5hTjtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZSh0KSAmJiBub3cgPj0gdDtcbn1cblxuLyoqIFdoZW4gdGhlIGNvbnRlbnQgbGFzdCBtZWFuaW5nZnVsbHkgY2hhbmdlZCwgcGVyIGBnZW5lcmF0ZWQuYXRgLCBhcyBhbiBJU08gZGF0ZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZW5lcmF0ZWRBdChmaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGcgPSBmaWVsZHMuZ2VuZXJhdGVkO1xuICBjb25zdCBhdCA9IGcgJiYgdHlwZW9mIGcgPT09IFwib2JqZWN0XCIgPyAoZyBhcyB7IGF0PzogdW5rbm93biB9KS5hdCA6IHVuZGVmaW5lZDtcbiAgaWYgKGF0IGluc3RhbmNlb2YgRGF0ZSkgcmV0dXJuIGF0LnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApO1xuICBpZiAodHlwZW9mIGF0ID09PSBcInN0cmluZ1wiKSB7XG4gICAgY29uc3QgdCA9IERhdGUucGFyc2UoYXQpO1xuICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodCkgPyBuZXcgRGF0ZSh0KS50b0lTT1N0cmluZygpLnNsaWNlKDAsIDEwKSA6IGF0O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5jb25zdCBzdHIgPSAodjogdW5rbm93bik6IHN0cmluZyB8IHVuZGVmaW5lZCA9PlxuICB0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiAmJiB2LnRyaW0oKSAhPT0gXCJcIiA/IHYudHJpbSgpIDogdW5kZWZpbmVkO1xuXG4vKipcbiAqIFJlYWQgYSBkb2N1bWVudCdzIGZyb250bWF0dGVyLiBSZXR1cm5zIG51bGwgd2hlbiB0aGVyZSBpcyBubyBibG9jayBhdCBhbGwg4oCUXG4gKiB3aGljaCBpcyBhIG5vcm1hbCBkb2N1bWVudCwgbm90IGEgZGVmZWN0LiBBIGJsb2NrIHRoYXQgd2lsbCBub3QgcGFyc2UgY29tZXNcbiAqIGJhY2sgd2l0aCBgZXJyb3JgIHNldCBhbmQgZXZlcnkgb3RoZXIgZmllbGQgZW1wdHk6IHNhaWQsIG5vdCBzd2FsbG93ZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFkTWV0YSh0ZXh0OiBzdHJpbmcsIG5vdyA9IERhdGUubm93KCkpOiBEb2NNZXRhIHwgbnVsbCB7XG4gIGNvbnN0IHsgcmF3IH0gPSBzcGxpdEZyb250bWF0dGVyKHRleHQpO1xuICBpZiAocmF3ID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgbGV0IGZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgbGV0IGVycm9yOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkID0gQnVuLllBTUwucGFyc2UocmF3KSBhcyB1bmtub3duO1xuICAgIGlmIChwYXJzZWQgJiYgdHlwZW9mIHBhcnNlZCA9PT0gXCJvYmplY3RcIiAmJiAhQXJyYXkuaXNBcnJheShwYXJzZWQpKVxuICAgICAgZmllbGRzID0gcGFyc2VkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGVsc2UgaWYgKHBhcnNlZCAhPT0gbnVsbCAmJiBwYXJzZWQgIT09IHVuZGVmaW5lZClcbiAgICAgIGVycm9yID0gXCJ0aGUgZnJvbnRtYXR0ZXIgaXMgbm90IGEgbWFwcGluZyBvZiBrZXlzIHRvIHZhbHVlc1wiO1xuICB9IGNhdGNoIChlKSB7XG4gICAgZXJyb3IgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2Uuc3BsaXQoXCJcXG5cIilbMF0gOiBTdHJpbmcoZSk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICByYXcsXG4gICAgZmllbGRzLFxuICAgIHR5cGU6IHN0cihmaWVsZHMudHlwZSksXG4gICAgdGl0bGU6IHN0cihmaWVsZHMudGl0bGUpLFxuICAgIGRlc2NyaXB0aW9uOiBzdHIoZmllbGRzLmRlc2NyaXB0aW9uKSxcbiAgICBzdGF0dXM6IHN0YXR1c09mKGZpZWxkcyksXG4gICAgdGFnczogYXNMaXN0KGZpZWxkcy50YWdzKSxcbiAgICBsaWZlY3ljbGU6IHN0cihmaWVsZHMubGlmZWN5Y2xlKSxcbiAgICB0cnVzdDogdHJ1c3RUaWVyKGZpZWxkcyksXG4gICAgc3RhbGU6IGlzU3RhbGUoZmllbGRzLCBub3cpLFxuICAgIGRhdGU6IGdlbmVyYXRlZEF0KGZpZWxkcyksXG4gICAgLi4uKGVycm9yID8geyBlcnJvciB9IDoge30pLFxuICB9O1xufVxuXG4vKiogVGhlIHNtYWxsIHNoYXBlIHRoZSBzaWRlYmFyIG5lZWRzIGZvciBldmVyeSBjb250ZXh0IGRvY3VtZW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN1bW1hcml6ZShtZXRhOiBEb2NNZXRhIHwgbnVsbCk6IERvY1N1bW1hcnkgfCBudWxsIHtcbiAgaWYgKCFtZXRhKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHtcbiAgICAuLi4obWV0YS50eXBlID8geyB0eXBlOiBtZXRhLnR5cGUgfSA6IHt9KSxcbiAgICAuLi4obWV0YS50aXRsZSA/IHsgdGl0bGU6IG1ldGEudGl0bGUgfSA6IHt9KSxcbiAgICBzdGF0dXM6IG1ldGEuc3RhdHVzLFxuICAgIHRhZ3M6IG1ldGEudGFncyxcbiAgICB0cnVzdDogbWV0YS50cnVzdCxcbiAgICBzdGFsZTogbWV0YS5zdGFsZSxcbiAgICAuLi4obWV0YS5saWZlY3ljbGUgPyB7IGxpZmVjeWNsZTogbWV0YS5saWZlY3ljbGUgfSA6IHt9KSxcbiAgICAuLi4obWV0YS5lcnJvciA/IHsgZXJyb3I6IG1ldGEuZXJyb3IgfSA6IHt9KSxcbiAgfTtcbn1cblxuLyoqIHBkb2NzJ3MgZmlsdGVyIHZvY2FidWxhcnksIHNvIHdoYXQgdGhlIGh1bWFuIGxlYXJucyB0aGVyZSBob2xkcyBoZXJlLiAqL1xuZXhwb3J0IHR5cGUgTWV0YUZpbHRlciA9IHtcbiAgdHlwZT86IHN0cmluZztcbiAgc3RhdHVzPzogc3RyaW5nO1xuICBsaWZlY3ljbGU/OiBzdHJpbmc7XG4gIHRhZz86IHN0cmluZztcbiAgLyoqIEFuIElTTyBkYXRlOyBtYXRjaGVzIGRvY3VtZW50cyB3aG9zZSBgZ2VuZXJhdGVkLmF0YCBpcyBvbiBvciBhZnRlciBpdC4gKi9cbiAgc2luY2U/OiBzdHJpbmc7XG59O1xuXG4vKipcbiAqIEZpbHRlcnMgYXJlIEFORGVkLCBhbmQgZXZlcnkgb25lIGlzIG9wdGlvbmFsIOKAlCBhIGJhcmUgZmlsdGVyIG1hdGNoZXMgYWxsLlxuICpcbiAqIOKblCBBIERPQ1VNRU5UIFdJVEggTk8gRlJPTlRNQVRURVIgTUFUQ0hFUyBPTkxZIFRIRSBFTVBUWSBGSUxURVIsIGFuZCB0aGF0XG4gKiBpbmNsdWRlcyBgLS1zdGF0dXMgc3RhYmxlYC4gQWJzZW50IGBzdGF0dXNgIGRlZmF1bHRzIHRvIGBzdGFibGVgIGZvciBhbiBPS0ZcbiAqIGRvY3VtZW50ICjCpzUpLCBidXQgYSBkb2N1bWVudCB3aXRoIG5vIGJsb2NrIGF0IGFsbCBpcyBub3QgbWFraW5nIHRoZSBjbGFpbTpcbiAqIGBmaW5kIC0tc3RhdHVzIHN0YWJsZWAgYXNrcyB3aGljaCBkb2N1bWVudHMgU0FZIHRoZXkgYXJlIHN0YWJsZSwgYW5kIGEgZmlsZVxuICogd2l0aCBubyBmcm9udG1hdHRlciBzYXlzIG5vdGhpbmcuIFJlYWRpbmcgdGhlIGRlZmF1bHQgdGhlIG90aGVyIHdheSB3b3VsZCBwdXRcbiAqIGV2ZXJ5IHVudG91Y2hlZCBub3RlIGluIHRoZSByZXN1bHQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYXRjaGVzRmlsdGVyKG1ldGE6IERvY01ldGEgfCBudWxsLCBmaWx0ZXI6IE1ldGFGaWx0ZXIpOiBib29sZWFuIHtcbiAgaWYgKG1ldGEgPT09IG51bGwpIHJldHVybiBPYmplY3QudmFsdWVzKGZpbHRlcikuZXZlcnkoKHYpID0+IHYgPT09IHVuZGVmaW5lZCk7XG4gIGlmIChmaWx0ZXIudHlwZSAhPT0gdW5kZWZpbmVkICYmIG1ldGEudHlwZSAhPT0gZmlsdGVyLnR5cGUpIHJldHVybiBmYWxzZTtcbiAgaWYgKGZpbHRlci5zdGF0dXMgIT09IHVuZGVmaW5lZCAmJiBtZXRhLnN0YXR1cyAhPT0gZmlsdGVyLnN0YXR1cykgcmV0dXJuIGZhbHNlO1xuICBpZiAoZmlsdGVyLmxpZmVjeWNsZSAhPT0gdW5kZWZpbmVkICYmIG1ldGEubGlmZWN5Y2xlICE9PSBmaWx0ZXIubGlmZWN5Y2xlKSByZXR1cm4gZmFsc2U7XG4gIGlmIChmaWx0ZXIudGFnICE9PSB1bmRlZmluZWQgJiYgIW1ldGEudGFncy5pbmNsdWRlcyhmaWx0ZXIudGFnKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoZmlsdGVyLnNpbmNlICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAoIW1ldGEuZGF0ZSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChtZXRhLmRhdGUgPCBmaWx0ZXIuc2luY2UpIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8g4pSA4pSAIFdSSVRJTkcgKEUzNSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vL1xuLy8g4puUIEVWRVJZIFdSSVRFIEhFUkUgSVMgQSBURVhUIEVESVQsIE5FVkVSIEEgUkVTRVJJQUxJU0FUSU9OLiBQYXJzaW5nIGEgYmxvY2tcbi8vIGFuZCBwcmludGluZyBpdCBiYWNrIHJlb3JkZXJzIGtleXMsIGRyb3BzIGNvbW1lbnRzIGFuZCBjaGFuZ2VzIHF1b3Rpbmcg4oCUIGFuZFxuLy8gdGhlIHNwZWMgYXNrcyBhIGNvbnN1bWVyIHRvIFwicHJlc2VydmUgdW5rbm93biBrZXlzIHdoZW4gcm91bmQtdHJpcHBpbmdcIlxuLy8gKMKnMTEpLCB3aGljaCBpcyBwcmVjaXNlbHkgd2hhdCB0aGF0IGxvc2VzLiBTbyBhIG5ldyBibG9jayBpcyBCVUlMVCAodGhlcmUgaXNcbi8vIG5vdGhpbmcgdG8gcHJlc2VydmUgeWV0KSBhbmQgYW4gZXhpc3Rpbmcgb25lIGlzIGVkaXRlZCBhIExJTkUgYXQgYSB0aW1lLlxuXG4vKiogVGhlIGRvY3VtZW50J3MgZmlyc3QgSDEsIHdoaWNoIGlzIHRoZSB0aXRsZSBhIGh1bWFuIGFscmVhZHkgd3JvdGUuICovXG5leHBvcnQgZnVuY3Rpb24gdGl0bGVGcm9tQm9keShib2R5OiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgYm9keS5zcGxpdChcIlxcblwiKSkge1xuICAgIGNvbnN0IG0gPSAvXiNcXHMrKC4rPylcXHMqJC8uZXhlYyhsaW5lKTtcbiAgICBpZiAobSkgcmV0dXJuIG1bMV07XG4gICAgaWYgKGxpbmUudHJpbSgpICE9PSBcIlwiICYmICFsaW5lLnN0YXJ0c1dpdGgoXCIjXCIpKSBicmVhazsgLy8gcHJvc2UgYmVmb3JlIGFueSBoZWFkaW5nXG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBBIGB0eXBlYCB0byBTVUdHRVNUIGZvciBhIGRvY3VtZW50IHRoYXQgaGFzIG5vbmUuXG4gKlxuICog4puUIEZST00gVEhFIE5FSUdIQk9VUlMsIE5FVkVSIEZST00gQSBGSVhFRCBMSVNULiBPS0YncyBgdHlwZWAgaXMgXCJub3RcbiAqIGNlbnRyYWxseSByZWdpc3RlcmVkXCIgYW5kIGV2ZXJ5IGNvcnB1cyBpbnZlbnRzIGl0cyBvd24g4oCUIGByZXBvcnRgLCBgcnVsZWAsXG4gKiBgYXJjaGV0eXBlYCBpbiBvbmUsIHNvbWV0aGluZyBlbHNlIGluIHRoZSBuZXh0IOKAlCBzbyB0aGUgb25seSBob25lc3Qgc291cmNlIGlzXG4gKiB3aGF0IHRoZSBkb2N1bWVudHMgYmVzaWRlIHRoaXMgb25lIGFscmVhZHkgc2F5LiBUaGUgZm9sZGVyJ3MgbmFtZSBpcyB0aGVcbiAqIGZhbGxiYWNrLCBhbmQgd2hlbiBuZWl0aGVyIGFuc3dlcnMsIG5vdGhpbmcgaXMgc3VnZ2VzdGVkOiBhIGJsYW5rIHRoZSBodW1hblxuICogZmlsbHMgYmVhdHMgYSBwbGF1c2libGUgZ3Vlc3MgKFNDSEVNQS5tZCdzIG93biBydWxlIGFib3V0IGBnZW5lcmF0ZWQuYnlgKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGd1ZXNzVHlwZShzaWJsaW5nVHlwZXM6IHJlYWRvbmx5IHN0cmluZ1tdLCBmb2xkZXI6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IGNvdW50cyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGZvciAoY29uc3QgdCBvZiBzaWJsaW5nVHlwZXMpIGlmICh0KSBjb3VudHMuc2V0KHQsIChjb3VudHMuZ2V0KHQpID8/IDApICsgMSk7XG4gIGNvbnN0IGJlc3QgPSBbLi4uY291bnRzLmVudHJpZXMoKV0uc29ydCgoYSwgYikgPT4gYlsxXSAtIGFbMV0gfHwgYVswXS5sb2NhbGVDb21wYXJlKGJbMF0pKVswXTtcbiAgaWYgKGJlc3QpIHJldHVybiBiZXN0WzBdO1xuICBjb25zdCBuYW1lID0gZm9sZGVyLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICBpZiAobmFtZSA9PT0gXCJcIiB8fCBuYW1lID09PSBcIi5cIiB8fCBuYW1lID09PSBcIi9cIikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgLy8gYGRlY2lzaW9ucy9gIOKGkiBgZGVjaXNpb25gOyBgZG9jcy9gIOKGkiBgZG9jYC4gQSBwbHVyYWwgZm9sZGVyIG5hbWVzIGl0cyBraW5kLlxuICByZXR1cm4gbmFtZS5lbmRzV2l0aChcImllc1wiKVxuICAgID8gYCR7bmFtZS5zbGljZSgwLCAtMyl9eWBcbiAgICA6IG5hbWUuZW5kc1dpdGgoXCJzXCIpXG4gICAgICA/IG5hbWUuc2xpY2UoMCwgLTEpXG4gICAgICA6IG5hbWU7XG59XG5cbi8qKiBBIFlBTUwgc2NhbGFyLCBxdW90ZWQgb25seSB3aGVuIGl0IG11c3QgYmUuICovXG5mdW5jdGlvbiBzY2FsYXIodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiAvXltcXHcgLiwnJy9AKy1dKiQvLnRlc3QodmFsdWUpICYmICEvXlxcc3xcXHMkLy50ZXN0KHZhbHVlKSAmJiB2YWx1ZSAhPT0gXCJcIlxuICAgID8gdmFsdWVcbiAgICA6IEpTT04uc3RyaW5naWZ5KHZhbHVlKTtcbn1cblxuZXhwb3J0IHR5cGUgTmV3TWV0YSA9IHtcbiAgdHlwZT86IHN0cmluZztcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuICBzdGF0dXM/OiBzdHJpbmc7XG4gIHRhZ3M/OiBzdHJpbmdbXTtcbiAgLyoqIGBnZW5lcmF0ZWQuYnlgIOKAlCB0aGUgYWN0b3IsIHJlY29yZGVkIGhvbmVzdGx5IG9yIGxlZnQgYHVua25vd25gLiAqL1xuICBieT86IHN0cmluZztcbiAgYXQ/OiBzdHJpbmc7XG59O1xuXG4vKipcbiAqIEEgZnJvbnRtYXR0ZXIgYmxvY2sgZm9yIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZS4gT0tGJ3MgcmVjb21tZW5kZWQgc2V0IGluXG4gKiB0aGUgb3JkZXIgdGhlIGNvcnBvcmEgd3JpdGUgaXQsIHdpdGggYGRlc2NyaXB0aW9uYCBsZWZ0IEVNUFRZIGZvciB0aGUgYXV0aG9yOlxuICogYSBvbmUtbGluZSBzdW1tYXJ5IG5vYm9keSB3cm90ZSBpcyB3b3JzZSB0aGFuIGEgYmxhbmsgdGhhdCBhc2tzIHRvIGJlIGZpbGxlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkQmxvY2sobWV0YTogTmV3TWV0YSk6IHN0cmluZyB7XG4gIGNvbnN0IGF0ID0gbWV0YS5hdCA/PyBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApO1xuICBjb25zdCBsaW5lcyA9IFtcbiAgICBgdHlwZTogJHtzY2FsYXIobWV0YS50eXBlID8/IFwiXCIpfWAsXG4gICAgYHRpdGxlOiAke3NjYWxhcihtZXRhLnRpdGxlID8/IFwiXCIpfWAsXG4gICAgYGRlc2NyaXB0aW9uOiAke21ldGEuZGVzY3JpcHRpb24gPyBzY2FsYXIobWV0YS5kZXNjcmlwdGlvbikgOiBcIlwifWAsXG4gICAgYHRhZ3M6IFskeyhtZXRhLnRhZ3MgPz8gW10pLm1hcChzY2FsYXIpLmpvaW4oXCIsIFwiKX1dYCxcbiAgICBgc3RhdHVzOiAke3NjYWxhcihtZXRhLnN0YXR1cyA/PyBcImRyYWZ0XCIpfWAsXG4gICAgYGdlbmVyYXRlZDogeyBieTogJHtzY2FsYXIobWV0YS5ieSA/PyBcInVua25vd25cIil9LCBhdDogJHthdH0gfWAsXG4gIF07XG4gIHJldHVybiBgLS0tXFxuJHtsaW5lcy5qb2luKFwiXFxuXCIpfVxcbi0tLVxcbmA7XG59XG5cbi8qKlxuICogUHV0IGEgbmV3IGJsb2NrIGF0IHRoZSB0b3Agb2YgYSBkb2N1bWVudCB0aGF0IGhhcyBub25lLiBObyBibGFuayBsaW5lIGlzXG4gKiBpbnNlcnRlZDogdGhlIGNvcnBvcmEgd3JpdGUgdGhlIGJvZHkgZGlyZWN0bHkgdW5kZXIgdGhlIGNsb3NpbmcgYC0tLWAsIGFuZCBhXG4gKiBibG9jayB0aGF0IGFkZHMgb25lIHdvdWxkIHNob3cgYXMgYSBkaWZmIG9uIGV2ZXJ5IGRvY3VtZW50IGl0IHRvdWNoZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3aXRoQmxvY2sodGV4dDogc3RyaW5nLCBibG9jazogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke2Jsb2NrfSR7dGV4dH1gO1xufVxuXG4vKipcbiAqIFNldCBvbmUga2V5IGluIGFuIEVYSVNUSU5HIGJsb2NrLCBhcyBhIGxpbmUgZWRpdDogdGhlIGtleSdzIGxpbmUgaXMgcmVwbGFjZWRcbiAqIHdoZXJlIGl0IGV4aXN0cyBhbmQgYXBwZW5kZWQgYmVmb3JlIHRoZSBjbG9zaW5nIGAtLS1gIHdoZXJlIGl0IGRvZXMgbm90LlxuICogRXZlcnl0aGluZyBlbHNlIOKAlCBvcmRlciwgY29tbWVudHMsIHNwYWNpbmcsIGtleXMgdGhpcyBzcGVsbCBuZXZlciBoZWFyZCBvZiDigJRcbiAqIHN1cnZpdmVzIGJ5dGUgZm9yIGJ5dGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXRLZXkodGV4dDogc3RyaW5nLCBrZXk6IHN0cmluZywgdmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHsgcmF3IH0gPSBzcGxpdEZyb250bWF0dGVyKHRleHQpO1xuICBpZiAocmF3ID09PSBudWxsKSB0aHJvdyBuZXcgRXJyb3IoXCJ0aGlzIGRvY3VtZW50IGhhcyBubyBmcm9udG1hdHRlciBibG9ja1wiKTtcbiAgY29uc3QgbGluZSA9IGAke2tleX06ICR7c2NhbGFyKHZhbHVlKX1gO1xuICBjb25zdCBrZXlMaW5lID0gbmV3IFJlZ0V4cChgXiR7a2V5LnJlcGxhY2UoL1suKis/XiR7fSgpfFtcXF1cXFxcXS9nLCBcIlxcXFwkJlwiKX1cXFxccyo6YCk7XG4gIGNvbnN0IGxpbmVzID0gcmF3LnNwbGl0KFwiXFxuXCIpO1xuICBjb25zdCBhdCA9IGxpbmVzLmZpbmRJbmRleCgobCkgPT4ga2V5TGluZS50ZXN0KGwpKTtcbiAgaWYgKGF0ID09PSAtMSkgbGluZXMucHVzaChsaW5lKTtcbiAgZWxzZSB7XG4gICAgLy8gQSBtdWx0aS1saW5lIHZhbHVlIChhIGZvbGRlZCBkZXNjcmlwdGlvbiwgYSBuZXN0ZWQgbWFwcGluZykgaXMgdGhlXG4gICAgLy8ga2V5J3MgbGluZSBQTFVTIGV2ZXJ5IGluZGVudGVkIGxpbmUgdW5kZXIgaXQ7IGFsbCBvZiB0aGVtIGdvLlxuICAgIGxldCBlbmQgPSBhdCArIDE7XG4gICAgd2hpbGUgKGVuZCA8IGxpbmVzLmxlbmd0aCAmJiAvXlxccytcXFMvLnRlc3QobGluZXNbZW5kXSA/PyBcIlwiKSkgZW5kKys7XG4gICAgbGluZXMuc3BsaWNlKGF0LCBlbmQgLSBhdCwgbGluZSk7XG4gIH1cbiAgY29uc3QgcmVidWlsdCA9IGxpbmVzLmpvaW4oXCJcXG5cIik7XG4gIHJldHVybiB0ZXh0LnJlcGxhY2UocmF3LCByZWJ1aWx0KTtcbn1cbiIsCiAgICAiLyoqXG4gKiBMaW5rcyBiZXR3ZWVuIGRvY3VtZW50cyAoRTMzKTogd2hhdCBhIGRvY3VtZW50IHBvaW50cyBhdCwgYW5kIHdoYXQgdGhhdFxuICogcmVzb2x2ZXMgdG8gaW5zaWRlIGEgc2V0LlxuICpcbiAqIOKUgOKUgCBGT1VSIFNPVVJDRVMgT0YgRURHRVMsIEFORCBUSEVZIEFSRSBOT1QgT05FIEtJTkQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogICAxLiBtYXJrZG93biBsaW5rcyAgICAgIGBbbGFiZWxdKC4vb3RoZXIubWQpYCAgICAgIOKAlCBib2R5XG4gKiAgIDIuIHdpa2kgbGlua3MgICAgICAgICAgYFtbb3RoZXItZG9jfGxhYmVsXV1gICAgICAg4oCUIGJvZHlcbiAqICAgMy4gZnJvbnRtYXR0ZXIgdmFsdWVzICBgcmVsYXRlZDogW2NvbmNlcHQveF1gICAgICDigJQgYXV0aG9yZWQgaW50ZW50XG4gKiAgIDQuIGBzb3VyY2VzW10ucmVzb3VyY2VgICAgICAgICAgICAgICAgICAgICAgICAgICAg4oCUIGF1dGhvcmVkIGludGVudFxuICpcbiAqIHBkb2NzIGtlZXBzIHRoZSBmcm9udG1hdHRlciBlZGdlIGFuZCB0aGUgYm9keS1saW5rIGVkZ2UgQVBBUlQgKGByZWxhdGVkW11gXG4gKiBhbmQgYGxpbmtzW11gIGluIGl0cyBgYmFja2xpbmtzYCBvdXRwdXQpLCBhbmQgdGhlIGRpc3RpbmN0aW9uIGlzIHJlYWw6IGFcbiAqIGByZWxhdGVkYCBrZXkgaXMgYSBjbGFpbSB0aGUgYXV0aG9yIG1hZGUgYWJvdXQgdGhlIGRvY3VtZW50IGFzIGEgd2hvbGUsIGFcbiAqIGJvZHkgbGluayBpcyBhIGNpdGF0aW9uIGF0IGEgcGxhY2UgaW4gdGhlIHByb3NlLiBUaGV5IHN0YXkgYXBhcnQgaGVyZSB0b28uXG4gKlxuICog4pSA4pSAIFRZUEVEIExJTktTIChPcGVyYXRvcidzIHNoYXBlLCBDb2xlIDIwMjYtMDktMTEpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEEgcmVsYXRpb24gcmlkZXMgdGhlIGxpbmsgYXMgYSBxdWVyeTogYFtsYWJlbF0oLi9vdGhlci5tZD9yZWw9ZXh0ZW5kcylgLFxuICogYFtbb3RoZXI/cmVsPXN1cGVyc2VkZXN8bGFiZWxdXWAuIENvcGllZCBleGFjdGx5IGZyb20gT3BlcmF0b3IncyBwYXJzZXJcbiAqIChgcGFja2FnZXMvc2hhcmVkL3NyYy9saW5rcy9gKTogb25lIGxpbmsgY2FycmllcyBBTEwgb2YgaXRzIHJlbHMsIHRoZXkgYXJlXG4gKiBub3JtYWxpc2VkIChsb3dlcmNhc2VkLCB0cmltbWVkLCBkZWR1cGVkLCBmaXJzdC1hdXRob3JlZCBvcmRlciBrZXB0KSBidXRcbiAqIHRoZWlyIFNQRUxMSU5HIGlzIG5vdCBjYW5vbmljYWxpc2VkLCBhbmQgKiphIGJhcmUgbGluayBpcyBgW11gIOKAlCB0aGUgQUJTRU5DRVxuICogb2YgYW4gYXNzZXJ0aW9uLCBub3QgYW4gaW1wbGljaXQgYHJlZmVyZW5jZXNgKiouIEEgZ3JhcGggbXVzdCBub3QgZHJhdyBhXG4gKiBjbGFpbSBub2JvZHkgbWFkZS5cbiAqXG4gKiDilIDilIAgV0hBVCBBIEJVTkRMRSBJUyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBPS0YncyBidW5kbGUtcmVsYXRpdmUgZm9ybSAoYC9jb25jZXB0cy94Lm1kYCkgbWVhbnMgdGhlIEJVTkRMRSByb290LCBub3QgdGhlXG4gKiBmaWxlc3lzdGVtIHJvb3QsIHNvIGEgcmVzb2x2ZXIgbmVlZHMgYSBidW5kbGUgYmVmb3JlIGl0IGNhbiByZXNvbHZlIGFueXRoaW5nOlxuICogKiphIHNldCdzIGVudHJ5IHJvb3QgaXMgdGhlIGJ1bmRsZSoqIChFMzMpLiBBIHRhcmdldCB0aGF0IGVzY2FwZXMgaXQgaXMgbm90IGFuXG4gKiBlcnJvciDigJQgdGhlIHNwZWMgcmVxdWlyZXMgdG9sZXJhdGluZyBicm9rZW4gbGlua3Mg4oCUIGl0IGlzIGFuIGVkZ2UgbWFya2VkXG4gKiBgb3V0c2lkZWAgb3IgYG1pc3NpbmdgLCB3aGljaCB0aGUgc3VyZmFjZSBvZmZlcnMgdG8gYWRkIHJhdGhlciB0aGFuIGZvbGxvdy5cbiAqL1xuaW1wb3J0IHtcbiAgYmFzZW5hbWUsXG4gIGRpcm5hbWUsXG4gIGV4dG5hbWUsXG4gIGpvaW4sXG4gIG5vcm1hbGl6ZSxcbiAgcmVsYXRpdmUsXG4gIHJlc29sdmUgYXMgcmVzb2x2ZVBhdGgsXG59IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgRG9jTWV0YSB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5pbXBvcnQgeyB0b1Bvc2l4IH0gZnJvbSBcIi4vdHJlZVwiO1xuXG5leHBvcnQgdHlwZSBMaW5rS2luZCA9IFwibWFya2Rvd25cIiB8IFwid2lraVwiO1xuXG4vKiogT25lIGxpbmsgYXMgd3JpdHRlbiwgYmVmb3JlIGFueXRoaW5nIGlzIHJlc29sdmVkLiAqL1xuZXhwb3J0IHR5cGUgTGlua1JlZiA9IHtcbiAga2luZDogTGlua0tpbmQ7XG4gIC8qKiBUaGUgdGFyZ2V0IGFzIGF1dGhvcmVkLCB3aXRoIGl0cyBxdWVyeSBhbmQgYW5jaG9yIHN0cmlwcGVkLiAqL1xuICB0YXJnZXQ6IHN0cmluZztcbiAgLyoqXG4gICAqIFRoZSB0YXJnZXQgRVhBQ1RMWSBhcyB3cml0dGVuIOKAlCBxdWVyeSwgYW5jaG9yLCBwZXJjZW50LWVuY29kaW5nIGFuZCBhbGwuXG4gICAqXG4gICAqIOKblCBUSElTIElTIFdIQVQgTUFLRVMgQSBEQU5HTElORyBMSU5LIEZJWEFCTEUuIGB0YXJnZXRgIGlzIHRoZSByZXNvbHZlZFxuICAgKiBzaGFwZSwgc28gYSByZXBvcnQgYnVpbHQgZnJvbSBpdCB0ZWxscyB5b3UgdG8gbG9vayBmb3IgYGRlZXAubWRgIHdoZW4gdGhlXG4gICAqIGRvY3VtZW50IGFjdHVhbGx5IHNheXMgYC4vbWlzc2luZy9kZWVwLm1kP3JlbD14YCDigJQgYSBzdHJpbmcgdGhhdCBpcyBub3QgaW5cbiAgICogdGhlIGZpbGUuIFdob2V2ZXIgKG9yIHdoYXRldmVyKSBnb2VzIHRvIHJlcGFpciB0aGUgbGluayBuZWVkcyB0aGUgc3RyaW5nXG4gICAqIHRoYXQgaXMgdGhlcmUuXG4gICAqL1xuICByYXc6IHN0cmluZztcbiAgLyoqIDEtYmFzZWQgbGluZSBpbiB0aGUgYm9keSB0aGUgbGluayB3YXMgd3JpdHRlbiBvbiwgZm9yIHRoZSBzYW1lIHJlYXNvbi4gKi9cbiAgbGluZTogbnVtYmVyO1xuICAvKiogUmVsYXRpb25zIGZyb20gYD9yZWw9YDsgRU1QVFkgbWVhbnMgbm8gYXNzZXJ0aW9uLCBuZXZlciBgcmVmZXJlbmNlc2AuICovXG4gIHJlbDogc3RyaW5nW107XG4gIGxhYmVsPzogc3RyaW5nO1xufTtcblxuLyoqIEEgcmVmZXJlbmNlIGZvdW5kIGluIGZyb250bWF0dGVyLCB3aXRoIHRoZSBrZXkgdGhhdCBjYXJyaWVkIGl0LiAqL1xuZXhwb3J0IHR5cGUgRmllbGRSZWYgPSB7IGtleTogc3RyaW5nOyB2YWx1ZTogc3RyaW5nIH07XG5cbmNvbnN0IEZFTkNFX0xJTkUgPSAvXig/OmBgYHx+fn4pLztcblxuLyoqXG4gKiBTdHJpcCBmZW5jZWQgY29kZSBibG9ja3MuIEEgZG9jdW1lbnQgYWJvdXQgbGlua3MgcXVvdGVzIGxpbmsgc3ludGF4LCBhbmQgdGhlXG4gKiB3aWtpIHRoaXMgd2FzIGJ1aWx0IGFnYWluc3QgZG9lcyBleGFjdGx5IHRoYXQg4oCUIHdpdGhvdXQgdGhpcywgU0NIRU1BLm1kJ3NcbiAqIGV4YW1wbGVzIGJlY29tZSBlZGdlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdpdGhvdXRGZW5jZXMoYm9keTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgZmVuY2U6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgYm9keS5zcGxpdChcIlxcblwiKSkge1xuICAgIGNvbnN0IG0gPSBGRU5DRV9MSU5FLmV4ZWMobGluZSk7XG4gICAgaWYgKGZlbmNlID09PSBudWxsICYmIG0pIHtcbiAgICAgIGZlbmNlID0gbVswXTtcbiAgICAgIG91dC5wdXNoKFwiXCIpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChmZW5jZSAhPT0gbnVsbCkge1xuICAgICAgaWYgKG0gJiYgbGluZS5zdGFydHNXaXRoKGZlbmNlKSkgZmVuY2UgPSBudWxsO1xuICAgICAgb3V0LnB1c2goXCJcIik7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgb3V0LnB1c2gobGluZSk7XG4gIH1cbiAgcmV0dXJuIG91dC5qb2luKFwiXFxuXCIpO1xufVxuXG4vKiogYD9yZWw9YSxiYCDihpIgYFtcImFcIixcImJcIl1gLCBub3JtYWxpc2VkIHRoZSB3YXkgT3BlcmF0b3Igbm9ybWFsaXNlcyB0aGVtLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUmVsKHF1ZXJ5OiBzdHJpbmcgfCB1bmRlZmluZWQpOiBzdHJpbmdbXSB7XG4gIGlmICghcXVlcnkpIHJldHVybiBbXTtcbiAgY29uc3QgbSA9IC8oPzpefFs/Jl0pcmVsPShbXiZdKikvLmV4ZWMocXVlcnkpO1xuICBpZiAoIW0pIHJldHVybiBbXTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgcmF3IG9mIGRlY29kZVVSSUNvbXBvbmVudChtWzFdID8/IFwiXCIpLnNwbGl0KFwiLFwiKSkge1xuICAgIGNvbnN0IHJlbCA9IHJhdy50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgICBpZiAocmVsID09PSBcIlwiIHx8IHNlZW4uaGFzKHJlbCkpIGNvbnRpbnVlO1xuICAgIHNlZW4uYWRkKHJlbCk7XG4gICAgb3V0LnB1c2gocmVsKTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vKiogU3BsaXQgYSB3cml0dGVuIHRhcmdldCBpbnRvIGl0cyBwYXRoLCBpdHMgcXVlcnkgYW5kIGl0cyBhbmNob3IuICovXG4vKipcbiAqIFBlcmNlbnQtZGVjb2RpbmcsIHdoaWNoIGEgbWFya2Rvd24gbGluayB0YXJnZXQgY2FycmllcyB3aGVuZXZlciB0aGUgZmlsZSBpdFxuICogbmFtZXMgaGFzIGEgc3BhY2UgaW4gaXQg4oCUIGBNYXJlbidzJTIwQmFrZXJ5Lm1kYCAoRTQ5KS5cbiAqXG4gKiDim5QgSVQgTVVTVCBOT1QgVEhST1cuIGBkZWNvZGVVUklDb21wb25lbnRgIHJlamVjdHMgYSBsb25lIGAlYCwgYW5kIGEgZmlsZVxuICogY2FsbGVkIGAxMDAlIGRvbmUubWRgIGlzIGEgcGVyZmVjdGx5IG9yZGluYXJ5IHRoaW5nIHRvIGxpbmsgdG8uIEFuXG4gKiB1bmRlY29kYWJsZSB0YXJnZXQgaXMgcmV0dXJuZWQgYXMgaXQgc3RhbmRzOiB3b3JzdCBjYXNlIGl0IGZhaWxzIHRvIHJlc29sdmUsXG4gKiB3aGljaCBpcyB0aGUgYmVoYXZpb3VyIGJlZm9yZSBkZWNvZGluZyBleGlzdGVkLCByYXRoZXIgdGhhbiB0YWtpbmcgdGhlIGdyYXBoXG4gKiBkb3duIHdpdGggaXQuXG4gKi9cbmZ1bmN0aW9uIGRlY29kZVBhdGgocmF3OiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIXJhdy5pbmNsdWRlcyhcIiVcIikpIHJldHVybiByYXc7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGRlY29kZVVSSUNvbXBvbmVudChyYXcpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gcmF3O1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzcGxpdFRhcmdldChyYXc6IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBxdWVyeT86IHN0cmluZzsgYW5jaG9yPzogc3RyaW5nIH0ge1xuICBjb25zdCBoYXNoID0gcmF3LmluZGV4T2YoXCIjXCIpO1xuICBjb25zdCB3aXRob3V0QW5jaG9yID0gaGFzaCA9PT0gLTEgPyByYXcgOiByYXcuc2xpY2UoMCwgaGFzaCk7XG4gIGNvbnN0IGFuY2hvciA9IGhhc2ggPT09IC0xID8gdW5kZWZpbmVkIDogcmF3LnNsaWNlKGhhc2ggKyAxKTtcbiAgY29uc3QgcSA9IHdpdGhvdXRBbmNob3IuaW5kZXhPZihcIj9cIik7XG4gIHJldHVybiB7XG4gICAgcGF0aDogZGVjb2RlUGF0aCgocSA9PT0gLTEgPyB3aXRob3V0QW5jaG9yIDogd2l0aG91dEFuY2hvci5zbGljZSgwLCBxKSkudHJpbSgpKSxcbiAgICAuLi4ocSA9PT0gLTEgPyB7fSA6IHsgcXVlcnk6IHdpdGhvdXRBbmNob3Iuc2xpY2UocSArIDEpIH0pLFxuICAgIC4uLihhbmNob3IgPyB7IGFuY2hvciB9IDoge30pLFxuICB9O1xufVxuXG5jb25zdCBFWFRFUk5BTCA9IC9eW2Etel1bYS16MC05Ky4tXSo6L2k7XG5jb25zdCBNRF9MSU5LID0gLyghPylcXFsoW15cXF1cXG5dKilcXF1cXCgoW14pXFxzXSspKD86XFxzK1wiW15cIl0qXCIpP1xcKS9nO1xuY29uc3QgV0lLSV9MSU5LID0gL1xcW1xcWyhbXlxcXVxcbl0rKVxcXVxcXS9nO1xuXG4vKiogRXZlcnkgbGluayBhIGRvY3VtZW50J3MgQk9EWSBwb2ludHMgYXQg4oCUIGV4dGVybmFsIHRhcmdldHMgYW5kIGltYWdlcyBsZWZ0IG91dC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0TGlua3MoYm9keTogc3RyaW5nKTogTGlua1JlZltdIHtcbiAgY29uc3QgdGV4dCA9IHdpdGhvdXRGZW5jZXMoYm9keSk7XG4gIGNvbnN0IG91dDogTGlua1JlZltdID0gW107XG4gIC8vIOKaoCBMSU5FIE5VTUJFUlMgU1VSVklWRSBgd2l0aG91dEZlbmNlc2AgQU5EIE9GRlNFVFMgRE8gTk9UOiBpdCBibGFua3MgZWFjaFxuICAvLyBmZW5jZWQgbGluZSByYXRoZXIgdGhhbiBkZWxldGluZyBpdCwgc28gdGhlIGxpbmUgQ09VTlQgaXMgcHJlc2VydmVkIHdoaWxlXG4gIC8vIHRoZSBjaGFyYWN0ZXIgb2Zmc2V0cyBhcmUgbm90LiBDb3VudGluZyBuZXdsaW5lcyBpcyB0aGVyZWZvcmUgc291bmQ7IHVzaW5nXG4gIC8vIGBtLmluZGV4YCBhcyBhIGNoYXJhY3RlciBwb3NpdGlvbiBpbiB0aGUgb3JpZ2luYWwgYm9keSB3b3VsZCBub3QgYmUuXG4gIGNvbnN0IGxpbmVBdCA9IChhdDogbnVtYmVyKSA9PiB7XG4gICAgbGV0IGxpbmUgPSAxO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYXQgJiYgaSA8IHRleHQubGVuZ3RoOyBpKyspIGlmICh0ZXh0LmNoYXJDb2RlQXQoaSkgPT09IDEwKSBsaW5lKys7XG4gICAgcmV0dXJuIGxpbmU7XG4gIH07XG4gIGZvciAoY29uc3QgbSBvZiB0ZXh0Lm1hdGNoQWxsKE1EX0xJTkspKSB7XG4gICAgaWYgKG1bMV0gPT09IFwiIVwiKSBjb250aW51ZTsgLy8gYW4gaW1hZ2UgaXMgbm90IGEgZG9jdW1lbnQgbGlua1xuICAgIGNvbnN0IHJhdyA9IG1bM10gPz8gXCJcIjtcbiAgICBpZiAoRVhURVJOQUwudGVzdChyYXcpIHx8IHJhdy5zdGFydHNXaXRoKFwiI1wiKSkgY29udGludWU7XG4gICAgY29uc3QgeyBwYXRoLCBxdWVyeSB9ID0gc3BsaXRUYXJnZXQocmF3KTtcbiAgICBpZiAocGF0aCA9PT0gXCJcIikgY29udGludWU7XG4gICAgb3V0LnB1c2goe1xuICAgICAga2luZDogXCJtYXJrZG93blwiLFxuICAgICAgdGFyZ2V0OiBwYXRoLFxuICAgICAgcmF3LFxuICAgICAgbGluZTogbGluZUF0KG0uaW5kZXggPz8gMCksXG4gICAgICByZWw6IHBhcnNlUmVsKHF1ZXJ5KSxcbiAgICAgIC4uLihtWzJdID8geyBsYWJlbDogbVsyXSB9IDoge30pLFxuICAgIH0pO1xuICB9XG4gIGZvciAoY29uc3QgbSBvZiB0ZXh0Lm1hdGNoQWxsKFdJS0lfTElOSykpIHtcbiAgICBjb25zdCBpbm5lciA9IG1bMV0gPz8gXCJcIjtcbiAgICBjb25zdCBwaXBlID0gaW5uZXIuaW5kZXhPZihcInxcIik7XG4gICAgY29uc3QgdGFyZ2V0UGFydCA9IHBpcGUgPT09IC0xID8gaW5uZXIgOiBpbm5lci5zbGljZSgwLCBwaXBlKTtcbiAgICBjb25zdCBsYWJlbCA9IHBpcGUgPT09IC0xID8gdW5kZWZpbmVkIDogaW5uZXIuc2xpY2UocGlwZSArIDEpLnRyaW0oKTtcbiAgICBjb25zdCB7IHBhdGgsIHF1ZXJ5IH0gPSBzcGxpdFRhcmdldCh0YXJnZXRQYXJ0KTtcbiAgICBpZiAocGF0aCA9PT0gXCJcIikgY29udGludWU7XG4gICAgb3V0LnB1c2goe1xuICAgICAga2luZDogXCJ3aWtpXCIsXG4gICAgICB0YXJnZXQ6IHBhdGgsXG4gICAgICByYXc6IHRhcmdldFBhcnQsXG4gICAgICBsaW5lOiBsaW5lQXQobS5pbmRleCA/PyAwKSxcbiAgICAgIHJlbDogcGFyc2VSZWwocXVlcnkpLFxuICAgICAgLi4uKGxhYmVsID8geyBsYWJlbCB9IDoge30pLFxuICAgIH0pO1xuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBEb2VzIHRoaXMgZnJvbnRtYXR0ZXIgdmFsdWUgTE9PSyBsaWtlIGEgZG9jdW1lbnQgcmVmZXJlbmNlPyAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvb2tzTGlrZVJlZih2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIHN0cmluZyB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgdiA9IHZhbHVlLnRyaW0oKTtcbiAgaWYgKHYgPT09IFwiXCIgfHwgRVhURVJOQUwudGVzdCh2KSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gdi5pbmNsdWRlcyhcIi9cIikgfHwgdi50b0xvd2VyQ2FzZSgpLmVuZHNXaXRoKFwiLm1kXCIpO1xufVxuXG4vKipcbiAqIFJlZmVyZW5jZXMgaW5zaWRlIGZyb250bWF0dGVyLCB3aGF0ZXZlciBrZXkgY2FycmllcyB0aGVtIOKAlCBgcmVsYXRlZGAsXG4gKiBgc3VwZXJzZWRlc2AsIGBzb3VyY2VzW10ucmVzb3VyY2VgLCBvciBhIGtleSBpbnZlbnRlZCB0b21vcnJvdy4gVGhlIFNIQVBFXG4gKiBkZWNpZGVzIChhIHNsYXNoIG9yIGEgYC5tZGApLCB3aGljaCBpcyB3aHkgYmFyZSBgdGFnc2AgYXJlIG5vdCByZWZlcmVuY2VzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZmllbGRSZWZzKGZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIG1heERlcHRoID0gNCk6IEZpZWxkUmVmW10ge1xuICBjb25zdCBvdXQ6IEZpZWxkUmVmW10gPSBbXTtcbiAgY29uc3Qgd2FsayA9IChrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24sIGRlcHRoOiBudW1iZXIpID0+IHtcbiAgICBpZiAoZGVwdGggPiBtYXhEZXB0aCkgcmV0dXJuO1xuICAgIGlmIChsb29rc0xpa2VSZWYodmFsdWUpKSBvdXQucHVzaCh7IGtleSwgdmFsdWU6IHZhbHVlLnRyaW0oKSB9KTtcbiAgICBlbHNlIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgZm9yIChjb25zdCB2IG9mIHZhbHVlKSB3YWxrKGtleSwgdiwgZGVwdGggKyAxKTtcbiAgICBlbHNlIGlmICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIpXG4gICAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyh2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpXG4gICAgICAgIHdhbGsoYCR7a2V5fS4ke2t9YCwgdiwgZGVwdGggKyAxKTtcbiAgfTtcbiAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMoZmllbGRzKSkgd2FsayhrLCB2LCAwKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIFdoZXJlIGEgdGFyZ2V0IGxhbmRlZC4gYG91dHNpZGVgIGV4aXN0cyBvbiBkaXNrIGJ1dCBub3QgaW4gdGhpcyBidW5kbGUuICovXG5leHBvcnQgdHlwZSBSZXNvbHV0aW9uID1cbiAgfCB7IHN0YXRlOiBcImluLWJ1bmRsZVwiOyBwYXRoOiBzdHJpbmcgfVxuICB8IHsgc3RhdGU6IFwib3V0c2lkZVwiOyBwYXRoOiBzdHJpbmcgfVxuICB8IHsgc3RhdGU6IFwibWlzc2luZ1wiOyB0cmllZDogc3RyaW5nIH07XG5cbmV4cG9ydCB0eXBlIEJ1bmRsZUluZGV4ID0ge1xuICAvKiogVGhlIHNldCdzIHJvb3Qg4oCUIE9LRidzIGJ1bmRsZSwgYW5kIHdoYXQgYSBgL2AtdGFyZ2V0IGlzIHJlbGF0aXZlIHRvLiAqL1xuICByb290OiBzdHJpbmc7XG4gIC8qKiBBYnNvbHV0ZSBwYXRocyBvZiBldmVyeSBkb2N1bWVudCBpbiB0aGUgYnVuZGxlLiAqL1xuICBwYXRoczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBBIGRvY3VtZW50J3MgcGFyc2VkIGZyb250bWF0dGVyLCBmb3IgYHR5cGUvc2x1Z2AgcmVzb2x1dGlvbi4gKi9cbiAgbWV0YU9mOiAocGF0aDogc3RyaW5nKSA9PiBEb2NNZXRhIHwgbnVsbDtcbiAgLyoqIERvZXMgdGhpcyBwYXRoIGV4aXN0IG9uIGRpc2s/IChJbmplY3RlZCwgc28gdGhlIHJlc29sdmVyIHN0YXlzIHB1cmUuKSAqL1xuICBleGlzdHM6IChwYXRoOiBzdHJpbmcpID0+IGJvb2xlYW47XG4gIC8qKlxuICAgKiBUaGUgZ2l0IHdvcmtpbmcgdHJlZSB0aGUgYnVuZGxlIHNpdHMgaW4sIHdoZW4gdGhlcmUgaXMgb25lLiBBIHRoaXJkIHBsYWNlXG4gICAqIGFuIHVuYW5jaG9yZWQgcGF0aCBpcyB0cmllZDogcGRvY3Mgd3JpdGVzIHJlcG8tcmVsYXRpdmUgcGF0aHNcbiAgICogKGBkb2NzL3BsYXlib29rcy9mb28ubWRgKSBhbmQgdGhlIHdpa2kncyBydWxlIHBhZ2VzIGNhcnJ5IHJlcG8tcmVsYXRpdmVcbiAgICogYGNoZWNrZXI6YCB2YWx1ZXMsIGFuZCBuZWl0aGVyIHJlc29sdmVzIGZyb20gdGhlIGRvY3VtZW50IG9yIHRoZSBidW5kbGUuXG4gICAqL1xuICByZXBvUm9vdD86IHN0cmluZyB8IG51bGw7XG59O1xuXG5jb25zdCBzdGVtID0gKHA6IHN0cmluZykgPT4gYmFzZW5hbWUocCwgZXh0bmFtZShwKSk7XG5cbi8qKlxuICogUmVzb2x2ZSBvbmUgd3JpdHRlbiB0YXJnZXQgYWdhaW5zdCB0aGUgYnVuZGxlLlxuICpcbiAqIEZvdXIgZm9ybXMsIGluIG9yZGVyOiBhIGJ1bmRsZS1yZWxhdGl2ZSBwYXRoIChgL3gveS5tZGApLCBhIHJlbGF0aXZlIHBhdGhcbiAqIChgLi95Lm1kYCwgYC4uL3gveS5tZGApLCBhIGB0eXBlL3NsdWdgIGtleSDigJQgcGRvY3MnIGFuZCB0aGUgd2lraSdzIG93biBmb3JtLFxuICogd2hpY2ggcmVzb2x2ZXMgYnkgVFlQRSBhbmQgQkFTRU5BTUUgc28gYSBwYWdlIGNhbiBtb3ZlIGZvbGRlcnMgd2l0aG91dFxuICogYnJlYWtpbmcgaW5ib3VuZCByZWZlcmVuY2VzIOKAlCBhbmQgYSBiYXJlIG5hbWUgKGEgd2lraSBsaW5rKSwgYnkgYmFzZW5hbWUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlVGFyZ2V0KHJhd1RhcmdldDogc3RyaW5nLCBmcm9tOiBzdHJpbmcsIGluZGV4OiBCdW5kbGVJbmRleCk6IFJlc29sdXRpb24ge1xuICAvLyDim5QgU1BMSVQgRklSU1QsIEJFQ0FVU0UgVEhFIENBTExFUlMgRElTQUdSRUUgQUJPVVQgV0hBVCBUSEVZIEhBTkQgT1ZFUi5cbiAgLy8gYGV4dHJhY3RMaW5rc2Agc3BsaXRzIGEgdGFyZ2V0IGJlZm9yZSBpdCBldmVyIGdldHMgaGVyZSAoRTQ5KSwgYnV0IHRoZVxuICAvLyBDTElDSyBwYXRoIGRvZXMgbm90OiBgbGluay5vcGVuYCBjYXJyaWVzIHRoZSBocmVmIGV4YWN0bHkgYXMgdGhlIGRvY3VtZW50XG4gIC8vIHdyb3RlIGl0LiBTbyBhbiBPcGVyYXRvciB0eXBlZCBsaW5rIOKAlCBgTWFyZW4ncyUyMEJha2VyeS5tZD9yZWw9bG9jYXRlZC1pbmBcbiAgLy8g4oCUIGFycml2ZWQgd2l0aCBpdHMgcXVlcnkgYW5kIGl0cyBlbmNvZGluZyBpbnRhY3QsIGBleHRuYW1lYCByZWFkXG4gIC8vIGAubWQ/cmVsPWxvY2F0ZWQtaW5gLCBhbmQgdGhlIGxvb2t1cCB3ZW50IGh1bnRpbmcgZm9yIGEgZmlsZSBuYW1lZCBhZnRlclxuICAvLyB0aGUgd2hvbGUgc3RyaW5nLiBUaGUgR1JBUEggZHJldyB0aGF0IGVkZ2UgY29ycmVjdGx5IHRoZSBlbnRpcmUgdGltZSwgd2hpY2hcbiAgLy8gaXMgd2hhdCBtYWRlIGl0IHB1enpsaW5nOiB0aGUgc2FtZSBsaW5rIHdhcyBmaW5lIGluIHRoZSBtYXAgYW5kIGRlYWQgdW5kZXJcbiAgLy8gdGhlIHBvaW50ZXIuIFNwbGl0dGluZyBoZXJlIGZpeGVzIGV2ZXJ5IGNhbGxlciBhdCBvbmNlIGFuZCBpcyBpZGVtcG90ZW50XG4gIC8vIGZvciB0aGUgdHdvIHRoYXQgaGFkIGFscmVhZHkgZG9uZSBpdC4gKENvbGUgZm91bmQgaXQgYnkgY2xpY2tpbmcgb25lIGluXG4gIC8vIEhvbGxvd2Jyb29rLCAyMDI2LTA5LTE0LilcbiAgY29uc3QgdGFyZ2V0ID0gc3BsaXRUYXJnZXQocmF3VGFyZ2V0KS5wYXRoO1xuICAvLyDim5QgV0hBVCBNQUtFUyBBIFRBUkdFVCBBIFBBVEggUkFUSEVSIFRIQU4gQSBLRVksIGFuZCB0aGUgY2FzZSB0aGF0IHRhdWdodFxuICAvLyBpdDogYFt0aGUgbGludGVyXShsaW50LnRzKWAgaW4gdGhlIHJlYWwgd2lraSBoYXMgbm8gYC4vYCBhbmQgaXMgbm90IGEgYC5tZGAsXG4gIC8vIHNvIGEgcnVsZSBrZXllZCBvbiB0aG9zZSB0d28gcmVhZCBpdCBhcyBhIE5BTUUgYW5kIHJlcG9ydGVkIGl0IG1pc3NpbmdcbiAgLy8gd2hpbGUgdGhlIGZpbGUgc2F0IHJpZ2h0IHRoZXJlLiBBIHRhcmdldCBpcyBhIHBhdGggd2hlbiBpdCBpcyBhbmNob3JlZFxuICAvLyAoYC9gLCBgLi9gLCBgLi4vYCkgb3IgY2FycmllcyBBTlkgZXh0ZW5zaW9uOyBgY29uY2VwdC9leGl0LWNvZGVzYCBoYXNcbiAgLy8gbmVpdGhlciwgd2hpY2ggaXMgd2hhdCBrZWVwcyBhIGB0eXBlL3NsdWdgIGtleSBhIGtleS5cbiAgY29uc3QgbG9va3NQYXRoID1cbiAgICB0YXJnZXQuc3RhcnRzV2l0aChcIi9cIikgfHxcbiAgICB0YXJnZXQuc3RhcnRzV2l0aChcIi4vXCIpIHx8XG4gICAgdGFyZ2V0LnN0YXJ0c1dpdGgoXCIuLi9cIikgfHxcbiAgICBleHRuYW1lKHRhcmdldCkgIT09IFwiXCI7XG4gIGlmIChsb29rc1BhdGgpIHtcbiAgICAvLyBBbiBVTkFOQ0hPUkVEIHBhdGggKGBzcmMvYWNjL2tpdC94LnRzYCwgYHJlcG9ydHMvYS5tZGAg4oCUIG5vIGAuL2AgYW5kIG5vXG4gICAgLy8gbGVhZGluZyBgL2ApIGlzIGFtYmlndW91czogcmVsYXRpdmUgdG8gdGhlIGRvY3VtZW50LCBvciB0byB0aGUgYnVuZGxlP1xuICAgIC8vIEJvdGggYXJlIHRyaWVkLCBkb2N1bWVudCBmaXJzdC4gTWVhc3VyZWQgb24gdGhlIHJlYWwgd2lraSwgd2hlcmUgYSBydWxlXG4gICAgLy8gcGFnZSdzIGBjaGVja2VyOiBzcmMvYWNjL2tpdC9jaGVja2Vycy/igKZgIHdhcyByZXBvcnRlZCBtaXNzaW5nIHdoaWxlXG4gICAgLy8gcmVzb2x2aW5nIGZyb20gdGhlIGJ1bmRsZSByb290IHdvdWxkIGhhdmUgZm91bmQgaXQuXG4gICAgY29uc3QgYW5jaG9yZWQgPSB0YXJnZXQuc3RhcnRzV2l0aChcIi9cIikgfHwgdGFyZ2V0LnN0YXJ0c1dpdGgoXCIuL1wiKSB8fCB0YXJnZXQuc3RhcnRzV2l0aChcIi4uL1wiKTtcbiAgICBjb25zdCBjYW5kaWRhdGVzID0gdGFyZ2V0LnN0YXJ0c1dpdGgoXCIvXCIpXG4gICAgICA/IFtub3JtYWxpemUoam9pbihpbmRleC5yb290LCB0YXJnZXQpKV1cbiAgICAgIDogYW5jaG9yZWRcbiAgICAgICAgPyBbbm9ybWFsaXplKHJlc29sdmVQYXRoKGRpcm5hbWUoZnJvbSksIHRhcmdldCkpXVxuICAgICAgICA6IFtcbiAgICAgICAgICAgIG5vcm1hbGl6ZShyZXNvbHZlUGF0aChkaXJuYW1lKGZyb20pLCB0YXJnZXQpKSxcbiAgICAgICAgICAgIG5vcm1hbGl6ZShqb2luKGluZGV4LnJvb3QsIHRhcmdldCkpLFxuICAgICAgICAgICAgLi4uKGluZGV4LnJlcG9Sb290ID8gW25vcm1hbGl6ZShqb2luKGluZGV4LnJlcG9Sb290LCB0YXJnZXQpKV0gOiBbXSksXG4gICAgICAgICAgXTtcbiAgICBjb25zdCB0cmllZCA9IGNhbmRpZGF0ZXMubWFwKChjKSA9PiAoZXh0bmFtZShjKSA9PT0gXCJcIiA/IGAke2N9Lm1kYCA6IGMpKTtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdHJpZWQpIGlmIChpbmRleC5wYXRocy5pbmNsdWRlcyhjKSkgcmV0dXJuIHsgc3RhdGU6IFwiaW4tYnVuZGxlXCIsIHBhdGg6IGMgfTtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdHJpZWQpIGlmIChpbmRleC5leGlzdHMoYykpIHJldHVybiB7IHN0YXRlOiBcIm91dHNpZGVcIiwgcGF0aDogYyB9O1xuICAgIHJldHVybiB7IHN0YXRlOiBcIm1pc3NpbmdcIiwgdHJpZWQ6IHRyaWVkWzBdIGFzIHN0cmluZyB9O1xuICB9XG4gIGNvbnN0IHNsYXNoID0gdGFyZ2V0LmluZGV4T2YoXCIvXCIpO1xuICBpZiAoc2xhc2ggPiAwKSB7XG4gICAgLy8gYHR5cGUvc2x1Z2A6IHRoZSB0eXBlIGlzIGEgY2xhaW0gdGhlIHRhcmdldCdzIG93biBmcm9udG1hdHRlciBtdXN0IG1ha2UuXG4gICAgY29uc3QgdHlwZSA9IHRhcmdldC5zbGljZSgwLCBzbGFzaCk7XG4gICAgY29uc3Qgc2x1ZyA9IHRhcmdldC5zbGljZShzbGFzaCArIDEpO1xuICAgIGZvciAoY29uc3QgcCBvZiBpbmRleC5wYXRocylcbiAgICAgIGlmIChzdGVtKHApID09PSBzbHVnICYmIGluZGV4Lm1ldGFPZihwKT8udHlwZSA9PT0gdHlwZSlcbiAgICAgICAgcmV0dXJuIHsgc3RhdGU6IFwiaW4tYnVuZGxlXCIsIHBhdGg6IHAgfTtcbiAgfVxuICBjb25zdCBoaXQgPSBpbmRleC5wYXRocy5maW5kKChwKSA9PiBzdGVtKHApID09PSBzdGVtKHRhcmdldCkpO1xuICBpZiAoaGl0KSByZXR1cm4geyBzdGF0ZTogXCJpbi1idW5kbGVcIiwgcGF0aDogaGl0IH07XG4gIHJldHVybiB7IHN0YXRlOiBcIm1pc3NpbmdcIiwgdHJpZWQ6IHRhcmdldCB9O1xufVxuXG4vKiogQW4gZWRnZSBpbiBhIHNldCdzIG1hcC4gYHJlbGAgZW1wdHkgbWVhbnMgbm8gYXNzZXJ0aW9uIHdhcyBtYWRlLiAqL1xuZXhwb3J0IHR5cGUgRWRnZSA9IHtcbiAgZnJvbTogc3RyaW5nO1xuICAvKiogQWJzb2x1dGUgcGF0aCB3aGVuIHJlc29sdmVkOyB0aGUgd3JpdHRlbiB0YXJnZXQgd2hlbiBub3QuICovXG4gIHRvOiBzdHJpbmc7XG4gIC8qKiBBIGJvZHkgbGluaywgb3IgYSBmcm9udG1hdHRlciB2YWx1ZSDigJQga2VwdCBhcGFydCwgYXMgcGRvY3Mga2VlcHMgdGhlbS4gKi9cbiAgc291cmNlOiBcImxpbmtcIiB8IFwiZnJvbnRtYXR0ZXJcIjtcbiAgLyoqIFRoZSBmcm9udG1hdHRlciBrZXkgdGhhdCBjYXJyaWVkIGl0IChgcmVsYXRlZGAsIGBzb3VyY2VzLnJlc291cmNlYCwg4oCmKS4gKi9cbiAga2V5Pzogc3RyaW5nO1xuICAvKipcbiAgICogRm9yIGEgQk9EWSBsaW5rOiB0aGUgdGFyZ2V0IGFzIHdyaXR0ZW4sIGFuZCB0aGUgbGluZSBpdCBpcyBvbi4gQWJzZW50IGZvciBhXG4gICAqIGZyb250bWF0dGVyIHJlZmVyZW5jZSwgd2hlcmUgYGtleWAgaXMgdGhlIGFkZHJlc3MgaW5zdGVhZC5cbiAgICovXG4gIHJhdz86IHN0cmluZztcbiAgbGluZT86IG51bWJlcjtcbiAgcmVsOiBzdHJpbmdbXTtcbiAgc3RhdGU6IFJlc29sdXRpb25bXCJzdGF0ZVwiXTtcbn07XG5cbmV4cG9ydCB0eXBlIEdyYXBoTm9kZSA9IHtcbiAgcGF0aDogc3RyaW5nO1xuICByZWw6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgdHlwZT86IHN0cmluZztcbiAgc3RhdHVzOiBzdHJpbmc7XG4gIHN0YWxlOiBib29sZWFuO1xuICB0YWdzOiBzdHJpbmdbXTtcbiAgbGlua3NPdXQ6IG51bWJlcjtcbiAgbGlua3NJbjogbnVtYmVyO1xufTtcblxuZXhwb3J0IHR5cGUgR3JhcGggPSB7XG4gIHJvb3Q6IHN0cmluZztcbiAgbm9kZXM6IEdyYXBoTm9kZVtdO1xuICBlZGdlczogRWRnZVtdO1xuICAvKiogVGFyZ2V0cyBub3RoaW5nIGluIHRoZSBidW5kbGUgYW5zd2VycyDigJQgc2FpZCwgbmV2ZXIgYW4gZXJyb3IgKE9LRiDCpzExKS4gKi9cbiAgZGFuZ2xpbmc6IG51bWJlcjtcbn07XG5cbi8qKiBCdWlsZCBhIHNldCdzIG1hcDogbm9kZXMgYXJlIGl0cyBkb2N1bWVudHMsIGVkZ2VzIGFyZSB0aGUgZm91ciBzb3VyY2VzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkR3JhcGgoaW5kZXg6IEJ1bmRsZUluZGV4LCBib2R5T2Y6IChwYXRoOiBzdHJpbmcpID0+IHN0cmluZywgY2FwID0gNDAwKTogR3JhcGgge1xuICBjb25zdCBwYXRocyA9IGluZGV4LnBhdGhzLnNsaWNlKDAsIGNhcCk7XG4gIGNvbnN0IGVkZ2VzOiBFZGdlW10gPSBbXTtcbiAgZm9yIChjb25zdCBmcm9tIG9mIHBhdGhzKSB7XG4gICAgY29uc3QgbWV0YSA9IGluZGV4Lm1ldGFPZihmcm9tKTtcbiAgICBmb3IgKGNvbnN0IGxpbmsgb2YgZXh0cmFjdExpbmtzKGJvZHlPZihmcm9tKSkpIHtcbiAgICAgIGNvbnN0IHIgPSByZXNvbHZlVGFyZ2V0KGxpbmsudGFyZ2V0LCBmcm9tLCBpbmRleCk7XG4gICAgICBlZGdlcy5wdXNoKHtcbiAgICAgICAgZnJvbSxcbiAgICAgICAgdG86IHIuc3RhdGUgPT09IFwibWlzc2luZ1wiID8gci50cmllZCA6IHIucGF0aCxcbiAgICAgICAgc291cmNlOiBcImxpbmtcIixcbiAgICAgICAgcmF3OiBsaW5rLnJhdyxcbiAgICAgICAgbGluZTogbGluay5saW5lLFxuICAgICAgICByZWw6IGxpbmsucmVsLFxuICAgICAgICBzdGF0ZTogci5zdGF0ZSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IHJlZiBvZiBtZXRhID8gZmllbGRSZWZzKG1ldGEuZmllbGRzKSA6IFtdKSB7XG4gICAgICBjb25zdCByID0gcmVzb2x2ZVRhcmdldChyZWYudmFsdWUsIGZyb20sIGluZGV4KTtcbiAgICAgIGVkZ2VzLnB1c2goe1xuICAgICAgICBmcm9tLFxuICAgICAgICB0bzogci5zdGF0ZSA9PT0gXCJtaXNzaW5nXCIgPyByLnRyaWVkIDogci5wYXRoLFxuICAgICAgICBzb3VyY2U6IFwiZnJvbnRtYXR0ZXJcIixcbiAgICAgICAga2V5OiByZWYua2V5LFxuICAgICAgICByZWw6IFtdLFxuICAgICAgICBzdGF0ZTogci5zdGF0ZSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuICBjb25zdCBvdXRPZiA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGNvbnN0IGludG9PZiA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGZvciAoY29uc3QgZSBvZiBlZGdlcykge1xuICAgIG91dE9mLnNldChlLmZyb20sIChvdXRPZi5nZXQoZS5mcm9tKSA/PyAwKSArIDEpO1xuICAgIGlmIChlLnN0YXRlID09PSBcImluLWJ1bmRsZVwiKSBpbnRvT2Yuc2V0KGUudG8sIChpbnRvT2YuZ2V0KGUudG8pID8/IDApICsgMSk7XG4gIH1cbiAgY29uc3Qgbm9kZXM6IEdyYXBoTm9kZVtdID0gcGF0aHMubWFwKChwYXRoKSA9PiB7XG4gICAgY29uc3QgbWV0YSA9IGluZGV4Lm1ldGFPZihwYXRoKTtcbiAgICByZXR1cm4ge1xuICAgICAgcGF0aCxcbiAgICAgIHJlbDogdG9Qb3NpeChyZWxhdGl2ZShpbmRleC5yb290LCBwYXRoKSksXG4gICAgICB0aXRsZTogbWV0YT8udGl0bGUgPz8gc3RlbShwYXRoKSxcbiAgICAgIC4uLihtZXRhPy50eXBlID8geyB0eXBlOiBtZXRhLnR5cGUgfSA6IHt9KSxcbiAgICAgIHN0YXR1czogbWV0YT8uc3RhdHVzID8/IFwic3RhYmxlXCIsXG4gICAgICBzdGFsZTogbWV0YT8uc3RhbGUgPz8gZmFsc2UsXG4gICAgICB0YWdzOiBtZXRhPy50YWdzID8/IFtdLFxuICAgICAgbGlua3NPdXQ6IG91dE9mLmdldChwYXRoKSA/PyAwLFxuICAgICAgbGlua3NJbjogaW50b09mLmdldChwYXRoKSA/PyAwLFxuICAgIH07XG4gIH0pO1xuICByZXR1cm4ge1xuICAgIHJvb3Q6IGluZGV4LnJvb3QsXG4gICAgbm9kZXMsXG4gICAgZWRnZXMsXG4gICAgZGFuZ2xpbmc6IGVkZ2VzLmZpbHRlcigoZSkgPT4gZS5zdGF0ZSA9PT0gXCJtaXNzaW5nXCIpLmxlbmd0aCxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBDb250ZXh0IGVudHJpZXMgb24gZGlzayDigJQgYnVpbGRpbmcgYW4gZW50cnkgZnJvbSBhIHBhdGggKEUxNSdzIG9uZSBtb2RlbCksXG4gKiBtaXJyb3JpbmcgYSBmb2xkZXIgaW50byBhIG5vZGUgdHJlZSwgYW5kIGxpc3RpbmcgYSBkaXJlY3RvcnkgZm9yIHRoZVxuICogc3VyZmFjZSdzIHBhdGggY29tcGxldGlvbiAoYGZzLmxpc3RgKS5cbiAqXG4gKiBQdXJlIG92ZXIgdGhlIGZpbGVzeXN0ZW06IG5vIGRhZW1vbiBzdGF0ZSwgc28gdGhlIHVuaXQgY2VsbHMgZHJpdmUgaXQgd2l0aCBhXG4gKiB0ZW1wIGRpcmVjdG9yeSBhbmQgbm90aGluZyBlbHNlLlxuICovXG5cbmltcG9ydCB7IHJlYWRkaXJTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVsYXRpdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgQ29udGV4dEVudHJ5LCBDb250ZXh0Tm9kZSwgRnNMaXN0RW50cnkgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKiogV2hhdCBzY3JpcHRvcml1bSBvcGVucyBhcyBhIGRvY3VtZW50LiBFdmVyeXRoaW5nIGVsc2UgaXMgbm90IHNob3duLiAqL1xuZXhwb3J0IGNvbnN0IERPQ19FWFRFTlNJT05TID0gW1wiLm1kXCIsIFwiLm1hcmtkb3duXCIsIFwiLm1keFwiLCBcIi50eHRcIl0gYXMgY29uc3Q7XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0RvY05hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGxvd2VyID0gbmFtZS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gRE9DX0VYVEVOU0lPTlMuc29tZSgoZXh0KSA9PiBsb3dlci5lbmRzV2l0aChleHQpKTtcbn1cblxuLyoqIERpcmVjdG9yaWVzIGEgbWlycm9yIG5ldmVyIGRlc2NlbmRzIGludG8g4oCUIG5vaXNlLCBub3QgZG9jdW1lbnRzLiAqL1xuY29uc3QgU0tJUF9ESVJTID0gbmV3IFNldChbXCJub2RlX21vZHVsZXNcIiwgXCIuZ2l0XCIsIFwiZGlzdFwiLCBcIm91dFwiLCBcImNvdmVyYWdlXCJdKTtcblxuLyoqXG4gKiBUaGUgbW9zdCBub2RlcyBvbmUgbWlycm9yZWQgc2NhbiB3aWxsIGhvbGQuIEEgZm9sZGVyIGVudHJ5IHBvaW50ZWQgYXQgYSBodWdlXG4gKiB0cmVlIG11c3Qgbm90IHN0YWxsIHRoZSBkYWVtb24gb3IgZmxvb2QgZXZlcnkgc3RhdGUgYnJvYWRjYXN0OyBoaXR0aW5nIHRoZVxuICogY2FwIHNldHMgYHRydW5jYXRlZGAgb24gdGhlIGVudHJ5IHNvIHRoZSBzdXJmYWNlIGNhbiBTQVkgdGhlIGxpc3QgaXMgc2hvcnRcbiAqIHJhdGhlciB0aGFuIHJlbmRlciBhIHNob3J0IGxpc3QgYXMgYSBjb21wbGV0ZSBvbmUuXG4gKi9cbmV4cG9ydCBjb25zdCBNSVJST1JfTk9ERV9DQVAgPSAyMDAwO1xuXG5leHBvcnQgY29uc3QgdG9Qb3NpeCA9IChwOiBzdHJpbmcpID0+IHAuc3BsaXQoc2VwKS5qb2luKFwiL1wiKTtcblxuLyoqXG4gKiBNaXJyb3IgYHJvb3RgIGludG8gYSBzb3J0ZWQgbm9kZSB0cmVlOiBncm91cHMgZmlyc3QsIHRoZW4gZG9jcywgYnkgbmFtZS5cbiAqIGBoaWRkZW5gIHJlbHMgKEUyNCdzIFwiUmVtb3ZlIGZyb20gU2NyaXB0b3JpdW1cIikgYXJlIHNraXBwZWQsIGEgZm9sZGVyIHdpdGhcbiAqIGV2ZXJ5dGhpbmcgdW5kZXIgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY2FuVHJlZShcbiAgcm9vdDogc3RyaW5nLFxuICBjYXAgPSBNSVJST1JfTk9ERV9DQVAsXG4gIGhpZGRlbjogcmVhZG9ubHkgc3RyaW5nW10gPSBbXSxcbik6IHsgbm9kZXM6IENvbnRleHROb2RlW107IHRydW5jYXRlZDogYm9vbGVhbiB9IHtcbiAgbGV0IGNvdW50ID0gMDtcbiAgbGV0IHRydW5jYXRlZCA9IGZhbHNlO1xuICBjb25zdCBza2lwID0gbmV3IFNldChoaWRkZW4pO1xuICBjb25zdCB3YWxrID0gKGRpcjogc3RyaW5nKTogQ29udGV4dE5vZGVbXSA9PiB7XG4gICAgbGV0IG5hbWVzOiBzdHJpbmdbXTtcbiAgICB0cnkge1xuICAgICAgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgICBjb25zdCBncm91cHM6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBjb25zdCBkb2NzOiBDb250ZXh0Tm9kZVtdID0gW107XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzLnNvcnQoKGEsIGIpID0+IGEubG9jYWxlQ29tcGFyZShiKSkpIHtcbiAgICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICAgIGlmIChjb3VudCA+PSBjYXApIHtcbiAgICAgICAgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlbCA9IHRvUG9zaXgocmVsYXRpdmUocm9vdCwgYWJzKSk7XG4gICAgICBpZiAoc2tpcC5oYXMocmVsKSkgY29udGludWU7XG4gICAgICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgICAgICBpZiAoU0tJUF9ESVJTLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGNvbnN0IGNoaWxkcmVuID0gd2FsayhhYnMpO1xuICAgICAgICAvLyBBIGZvbGRlciBob2xkaW5nIG9ubHkgbm9uLWRvY3VtZW50cyAoaW1hZ2VzLCBhc3NldHMpIGlzIG5vaXNlIGluIGFcbiAgICAgICAgLy8gZG9jcyBtaXJyb3IgYW5kIGlzIGxlZnQgb3V0LiBBIFRSVUxZIEVNUFRZIGZvbGRlciBpcyBrZXB0OiBpdCBpcyBvbmVcbiAgICAgICAgLy8gc29tZWJvZHkganVzdCBtYWRlIHRvIHB1dCBkb2N1bWVudHMgaW4gKFwiTmV3IGZvbGRlclwiLCBFMjQpLCBhbmRcbiAgICAgICAgLy8gbGVhdmluZyBpdCBvdXQgbWFkZSBpdCB2YW5pc2ggdGhlIG1vbWVudCBpdCB3YXMgY3JlYXRlZC5cbiAgICAgICAgaWYgKGNoaWxkcmVuLmxlbmd0aCA+IDAgfHwgaXNFbXB0eURpcihhYnMpKSBncm91cHMucHVzaCh7IGtpbmQ6IFwiZ3JvdXBcIiwgcmVsLCBjaGlsZHJlbiB9KTtcbiAgICAgIH0gZWxzZSBpZiAoc3QuaXNGaWxlKCkgJiYgaXNEb2NOYW1lKG5hbWUpKSB7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGRvY3MucHVzaCh7IGtpbmQ6IFwiZG9jXCIsIHJlbCB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIFsuLi5ncm91cHMsIC4uLmRvY3NdO1xuICB9O1xuICBjb25zdCBub2RlcyA9IHdhbGsocm9vdCk7XG4gIHJldHVybiB7IG5vZGVzLCB0cnVuY2F0ZWQgfTtcbn1cblxuLyoqIE5vdGhpbmcgaW4gaXQgYnV0IGRvdGZpbGVzIChhIGAuRFNfU3RvcmVgIGRvZXMgbm90IG1ha2UgYSBmb2xkZXIgZnVsbCkuICovXG5mdW5jdGlvbiBpc0VtcHR5RGlyKGRpcjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHJlYWRkaXJTeW5jKGRpcikuZXZlcnkoKG4pID0+IG4uc3RhcnRzV2l0aChcIi5cIikpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqIFRoZSBub2RlIGF0IGByZWxgIGluIGEgdHJlZSwgb3IgdW5kZWZpbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmROb2RlKG5vZGVzOiByZWFkb25seSBDb250ZXh0Tm9kZVtdLCByZWw6IHN0cmluZyk6IENvbnRleHROb2RlIHwgdW5kZWZpbmVkIHtcbiAgZm9yIChjb25zdCBuIG9mIG5vZGVzKSB7XG4gICAgaWYgKG4ucmVsID09PSByZWwpIHJldHVybiBuO1xuICAgIGlmIChuLmtpbmQgPT09IFwiZ3JvdXBcIiAmJiByZWwuc3RhcnRzV2l0aChgJHtuLnJlbH0vYCkpIHJldHVybiBmaW5kTm9kZShuLmNoaWxkcmVuLCByZWwpO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBjbGFzcyBQYXRoRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICByZWFkb25seSBjb2RlOiBcIm1pc3NpbmdcIiB8IFwibm90LWEtZG9jXCIsXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5cbi8qKlxuICogQW4gZW50cnkgZm9yIGFuIGFic29sdXRlIHBhdGguIEEgZGlyZWN0b3J5IGlzIGBtaXJyb3JlZGA7IGEgZG9jdW1lbnQgZmlsZSBpc1xuICogYGxpc3RlZGAsIHJvb3RlZCBhdCBpdHMgcGFyZW50LCBob2xkaW5nIG9ubHkgaXRzZWxmIChFMTUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZW50cnlGb3JQYXRoKGFiczogc3RyaW5nLCBpZDogc3RyaW5nKTogQ29udGV4dEVudHJ5IHtcbiAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gIHRyeSB7XG4gICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKGBubyBzdWNoIGZpbGUgb3IgZm9sZGVyOiAke2Fic31gLCBcIm1pc3NpbmdcIik7XG4gIH1cbiAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHtcbiAgICBjb25zdCB7IG5vZGVzLCB0cnVuY2F0ZWQgfSA9IHNjYW5UcmVlKGFicyk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGlkLFxuICAgICAgbGFiZWw6IGJhc2VuYW1lKGFicykgfHwgYWJzLFxuICAgICAgcm9vdDogYWJzLFxuICAgICAgbWVtYmVyc2hpcDogXCJtaXJyb3JlZFwiLFxuICAgICAgbm9kZXMsXG4gICAgICAuLi4odHJ1bmNhdGVkID8geyB0cnVuY2F0ZWQgfSA6IHt9KSxcbiAgICB9O1xuICB9XG4gIGlmICghaXNEb2NOYW1lKGFicykpIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKFxuICAgICAgYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zICgke0RPQ19FWFRFTlNJT05TLmpvaW4oXCIgXCIpfSk6ICR7YWJzfWAsXG4gICAgICBcIm5vdC1hLWRvY1wiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSxcbiAgICByb290OiBkaXJuYW1lKGFicyksXG4gICAgbWVtYmVyc2hpcDogXCJsaXN0ZWRcIixcbiAgICBub2RlczogW3sga2luZDogXCJkb2NcIiwgcmVsOiBiYXNlbmFtZShhYnMpIH1dLFxuICB9O1xufVxuXG4vKiogRXZlcnkgZG9jIG5vZGUncyBhYnNvbHV0ZSBwYXRoLCBkZXB0aC1maXJzdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkb2NQYXRocyhlbnRyeTogQ29udGV4dEVudHJ5KTogc3RyaW5nW10ge1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHdhbGsgPSAobm9kZXM6IENvbnRleHROb2RlW10pID0+IHtcbiAgICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICAgIGlmIChuLmtpbmQgPT09IFwiZG9jXCIpIG91dC5wdXNoKGpvaW4oZW50cnkucm9vdCwgbi5yZWwpKTtcbiAgICAgIGVsc2Ugd2FsayhuLmNoaWxkcmVuKTtcbiAgICB9XG4gIH07XG4gIHdhbGsoZW50cnkubm9kZXMpO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogV2hpY2ggZW50cnkgKGlmIGFueSkgaG9sZHMgYGFic2AsIGFuZCBhdCB3aGF0IGByZWxgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvY2F0ZShcbiAgZW50cmllczogQ29udGV4dEVudHJ5W10sXG4gIGFiczogc3RyaW5nLFxuKTogeyBlbnRyeUlkOiBzdHJpbmc7IHJlbDogc3RyaW5nIH0gfCBudWxsIHtcbiAgZm9yIChjb25zdCBlIG9mIGVudHJpZXMpIHtcbiAgICBpZiAoZG9jUGF0aHMoZSkuaW5jbHVkZXMoYWJzKSkgcmV0dXJuIHsgZW50cnlJZDogZS5pZCwgcmVsOiB0b1Bvc2l4KHJlbGF0aXZlKGUucm9vdCwgYWJzKSkgfTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBPbmUgZGlyZWN0b3J5LCBmb3IgdGhlIHN1cmZhY2UncyBhZGQtYnktcGF0aCBjb21wbGV0aW9uOiBzdWJkaXJlY3RvcmllcyBhbmRcbiAqIGRvY3VtZW50cyBvbmx5LCBkaXJlY3RvcmllcyBmaXJzdC4gYH5gIGlzIGV4cGFuZGVkIGJ5IHRoZSBjYWxsZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsaXN0RGlyKGRpcjogc3RyaW5nKTogRnNMaXN0RW50cnlbXSB7XG4gIGNvbnN0IG5hbWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgY29uc3Qgb3V0OiBGc0xpc3RFbnRyeVtdID0gW107XG4gIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcykge1xuICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgbGV0IGlzRGlyID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGlzRGlyID0gc3RhdFN5bmMoYWJzKS5pc0RpcmVjdG9yeSgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChpc0RpciB8fCBpc0RvY05hbWUobmFtZSkpIG91dC5wdXNoKHsgbmFtZSwgcGF0aDogYWJzLCBkaXI6IGlzRGlyIH0pO1xuICB9XG4gIHJldHVybiBvdXQuc29ydCgoYSwgYikgPT4gKGEuZGlyID09PSBiLmRpciA/IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSkgOiBhLmRpciA/IC0xIDogMSkpO1xufVxuIiwKICAgICIvLyBJcyB0aGUgaHVtYW4gd2FpdGluZyBvbiBhbiBhbnN3ZXIsIGFuZCBmb3IgaG93IGxvbmcgKEU1Myk/XG4vL1xuLy8g4puUIERFUklWRUQsIE5PVCBERUNMQVJFRCDigJQgQ29sZSdzIHJ1bGluZywgYW5kIHRoZSByZWFzb24gaXMgbG9hZC1iZWFyaW5nOiBcIndlXG4vLyBjb3VsZCBhZGQgc29tZSBhZmZvcmRhbmNlIHRoYXQgc2VuZHMgYSBjaGVjay1pbiB3aXRoIGFuIGFnZW504oCmIHdoZXJlIHdlJ3JlXG4vLyBub3QgYWRkaW5nIG1vcmUgdGFza3MgZm9yIHRoZSBhZ2VudCB0byBoYXZlIHRvIGV4cGxpY2l0bHkgZG8uXCIgQW4gYWdlbnQgdGhhdFxuLy8gbXVzdCByZW1lbWJlciB0byBzYXkgXCJ0aGlua2luZ1wiIHdpbGwgZm9yZ2V0IGV4YWN0bHkgd2hlbiBpdCBtYXR0ZXJzIOKAlCBpdCBpc1xuLy8gYnVzeSwgd2hpY2ggaXMgdGhlIHdob2xlIHNpdHVhdGlvbiBiZWluZyBzaWduYWxsZWQuIFNvIG5vdGhpbmcgaGVyZSBhc2tzIHRoZVxuLy8gYWdlbnQgZm9yIGFueXRoaW5nLiBUaGUgc3RhdGUgaXMgcmVhZCBvZmYgdGhlIGNvbnZlcnNhdGlvbjogYSBodW1hbiBtZXNzYWdlXG4vLyB3aXRoIG5vIGFnZW50IG1lc3NhZ2UgYWZ0ZXIgaXQgaXMgYSBodW1hbiB3YWl0aW5nLlxuLy9cbi8vIOKblCBBTkQgVEhFIEFHRU5UJ1MgUkVQTFkgSVMgVEhFIENPTVBMRVRJT04gU0lHTkFMLCB3aGljaCBpcyBtaW5kLW1hcHBlcidzXG4vLyBydWxlIChSMTEgU0VBTSAyKSBhbmQgaXMgc3RvbGVuIGRlbGliZXJhdGVseS4gVGhlcmUgaXMgbm8gYGRvbmVgIHN0YXRlIHRvXG4vLyBlbWl0LCBzbyB0aGVyZSBpcyBubyBgZG9uZWAgc3RhdGUgdG8gZ2V0IG91dCBvZiBzeW5jLiBPbmUgY29uc2VxdWVuY2Ugd29ydGhcbi8vIG5hbWluZyBiZWNhdXNlIGl0IGZlbGwgb3V0IGZvciBmcmVlOiBgc3RhcnRUYXNrYCBwb3N0cyBpdHMgYW5ub3VuY2VtZW50IEFTXG4vLyBUSEUgQUdFTlQgKEU1MCksIHNvIHRoZSBoYXBweSBwYXRoIENvbGUgZGVzY3JpYmVkIOKAlCBcImdyZWF0LCBJJ20gZ29pbmcgdG8gZ2V0XG4vLyB0aGF0IHN0YXJ0ZWRcIiwgdGhlbiBhIHRhc2ssIHRoZW4gYSBzdWJhZ2VudCDigJQgY2xlYXJzIHRoaXMgYnkgY29uc3RydWN0aW9uLlxuLy9cbi8vIOKaoCBBIFNZU1RFTSBMSU5FIElTIE5PVCBBIFJFUExZLiBgYW5ub3VuY2UoKWAgbmFycmF0ZXMgYWdlbnQgQUNUUyAoXCJBZ2VudFxuLy8gbm90ZWQg4oCmIG9uIG1hcmVuXCIpLCB3aGljaCBpcyBldmlkZW5jZSBvZiBsaWZlIGJ1dCBub3QgYSBjaGVjay1pbiB3aXRoIHRoZVxuLy8gcGVyc29uIHdhaXRpbmcuIENvdW50aW5nIGl0IHdvdWxkIHNpbGVuY2UgdGhlIHNpZ25hbCBwcmVjaXNlbHkgaW4gdGhlIGNhc2Vcbi8vIHRoaXMgZXhpc3RzIGZvcjogYW4gYWdlbnQgdGhhdCBpcyBidXN5IGRvaW5nIHRoaW5ncyBhbmQgaGFzIG5vdCBzYWlkIGEgd29yZFxuLy8gdG8gdGhlIGh1bWFuLiBPbmx5IGB3aG8gPT09IFwiYWdlbnRcImAgY2xlYXJzLlxuaW1wb3J0IHR5cGUgeyBDaGF0V2hvLCBXYWl0aW5nIH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcblxuLyoqXG4gKiBIb3cgbG9uZyBhIGh1bWFuIHdhaXRzIGJlZm9yZSB0aGUgd2FpdCBpcyB3b3J0aCByZXBvcnRpbmcuIDMwIHMsIENvbGUnc1xuICogbnVtYmVyIOKAlCBsb25nIGVub3VnaCB0aGF0IGFuIG9yZGluYXJ5IGFuc3dlciBuZXZlciB0cmlwcyBpdCwgc2hvcnQgZW5vdWdoXG4gKiB0aGF0IGl0IGlzIHN0aWxsIHRoZSBzYW1lIG1vbWVudCBmb3IgdGhlIHBlcnNvbiBzaXR0aW5nIHRoZXJlLlxuICovXG5leHBvcnQgY29uc3QgU1RBTExfTVMgPSAzMF8wMDA7XG5cbi8qKiBXaGF0IGEgc25vb3plIGJ1eXMsIHdoZW4gdGhlIGFnZW50IGRvZXMgbm90IG5hbWUgYSBkdXJhdGlvbi4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NOT09aRV9NUyA9IDEyMF8wMDA7XG5cbi8vIGBXYWl0aW5nYCBpdHNlbGYgbGl2ZXMgaW4gYHByb3RvY29sLnRzYCDigJQgaXQgcmlkZXMgaW4gYFB1YmxpY1N0YXRlYCwgYW5kIHRoYXRcbi8vIGZpbGUgaXMgaW1wb3J0LWZyZWUgb24gcHVycG9zZS4gSXRzIGBiYWRnZWAgY2FycmllcyB0aGUgcnVsZSB0aGF0IG1hdHRlcnM6XG4vLyDim5QgU1RBTExFRCBNVVNUIE5PVCBQVUxTRS4gQSBwdWxzZSBvdmVyIGEgd2VkZ2VkIGFnZW50IGlzIGZhbHNlIGxpdmVuZXNzIOKAlCB0aGVcbi8vIGFuaW1hdGlvbiBjbGFpbXMgXCJzb21ldGhpbmcgaXMgaGFwcGVuaW5nXCIgd2hlbiB0aGUgaG9uZXN0IGFuc3dlciBpcyBcIkkgY2Fubm90XG4vLyB0ZWxsIGFueSBtb3JlXCIuIG1pbmQtbWFwcGVyIHNlcGFyYXRlcyB0aGVzZSB0d28gZm9yIHRoZSBzYW1lIHJlYXNvbi5cblxudHlwZSBNc2cgPSB7IGlkOiBzdHJpbmc7IHdobzogQ2hhdFdobzsgdHM6IG51bWJlciB9O1xuXG4vKipcbiAqIFRoZSBodW1hbiBtZXNzYWdlIG5vdGhpbmcgaGFzIGFuc3dlcmVkIHlldCwgb3IgbnVsbC5cbiAqXG4gKiBgYWNrbm93bGVkZ2VkVW50aWxgIGlzIGEgc25vb3plICh0aGUgYWdlbnQgc2FpZCBpdCBpcyBzdGlsbCB3b3JraW5nKS4gV2hpbGVcbiAqIGl0IGhvbGRzLCB0aGUgYmFkZ2Ugc3RheXMgYSBwdWxzZSBwYXN0IHRoZSBzdGFsbCB0aHJlc2hvbGQg4oCUIHRoZSBhZ2VudFxuICogdm9sdW50ZWVyZWQgZXZpZGVuY2Ugb2YgbGlmZSwgc28gc2hvd2luZyBcIm1heSBiZSBzdHVja1wiIHdvdWxkIGJlIHRoZSBsaWUuXG4gKiBXaGVuIGl0IEVYUElSRVMgdGhlIGJhZGdlIGdvZXMgc3RhbGxlZCBhZ2FpbiwgYmVjYXVzZSB0aGUgaHVtYW4gaXMgb3dlZCB0aGVcbiAqIHRydXRoIGV2ZW50dWFsbHk7IHRoYXQgZXhwaXJ5IGlzIGRlbGliZXJhdGVseSBub3QgYSByZWFzb24gdG8gbnVkZ2UgdGhlIGFnZW50XG4gKiBhIHNlY29uZCB0aW1lIChzZWUgdGhlIHNlcnZlcidzIG9uY2UtcGVyLW1lc3NhZ2UgcnVsZSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3YWl0aW5nT24oXG4gIGNoYXQ6IHJlYWRvbmx5IE1zZ1tdLFxuICBub3c6IG51bWJlcixcbiAgb3B0czogeyBzdGFsbE1zPzogbnVtYmVyOyBhY2tub3dsZWRnZWRVbnRpbD86IG51bWJlciB9ID0ge30sXG4pOiBXYWl0aW5nIHwgbnVsbCB7XG4gIGNvbnN0IHN0YWxsTXMgPSBvcHRzLnN0YWxsTXMgPz8gU1RBTExfTVM7XG4gIC8vIFdhbGsgYmFjayB0byB0aGUgbGFzdCB0aGluZyB0aGF0IHdhcyBub3QgbmFycmF0aW9uLiBBIGh1bWFuIHRoZXJlIG1lYW5zXG4gIC8vIG5vYm9keSBoYXMgYW5zd2VyZWQgdGhlbS5cbiAgbGV0IHBlbmRpbmc6IE1zZyB8IG51bGwgPSBudWxsO1xuICBmb3IgKGxldCBpID0gY2hhdC5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgIGNvbnN0IG0gPSBjaGF0W2ldO1xuICAgIGlmICghbSB8fCBtLndobyA9PT0gXCJzeXN0ZW1cIikgY29udGludWU7XG4gICAgaWYgKG0ud2hvID09PSBcImFnZW50XCIpIHJldHVybiBudWxsO1xuICAgIHBlbmRpbmcgPSBtO1xuICAgIGJyZWFrO1xuICB9XG4gIGlmICghcGVuZGluZykgcmV0dXJuIG51bGw7XG5cbiAgLy8g4pqgIFRoZSBGSVJTVCBvZiB0aGUgdW5hbnN3ZXJlZCBydW4sIG5vdCB0aGUgbGFzdC4gU29tZW9uZSB3aG8gc2VuZHMgdGhyZWVcbiAgLy8gbWVzc2FnZXMgd2hpbGUgd2FpdGluZyBoYXMgYmVlbiB3YWl0aW5nIHNpbmNlIHRoZSBmaXJzdCBvbmUsIGFuZCByZXNldHRpbmdcbiAgLy8gdGhlIGNsb2NrIG9uIGV2ZXJ5IGZvbGxvdy11cCB3b3VsZCBtZWFuIHRoZSBtb3JlIGFueGlvdXMgdGhleSBnZXQsIHRoZVxuICAvLyBsb25nZXIgd2UgY2xhaW0gdGhleSBoYXZlIGJlZW4gd2FpdGluZyBpcyB6ZXJvLlxuICBsZXQgc2luY2UgPSBwZW5kaW5nLnRzO1xuICBsZXQgbWVzc2FnZUlkID0gcGVuZGluZy5pZDtcbiAgZm9yIChsZXQgaSA9IGNoYXQubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICBjb25zdCBtID0gY2hhdFtpXTtcbiAgICBpZiAoIW0gfHwgbS53aG8gPT09IFwic3lzdGVtXCIpIGNvbnRpbnVlO1xuICAgIGlmIChtLndobyAhPT0gXCJodW1hblwiKSBicmVhaztcbiAgICBzaW5jZSA9IG0udHM7XG4gICAgbWVzc2FnZUlkID0gbS5pZDtcbiAgfVxuXG4gIGNvbnN0IGFja25vd2xlZGdlZCA9IG9wdHMuYWNrbm93bGVkZ2VkVW50aWwgIT09IHVuZGVmaW5lZCAmJiBub3cgPCBvcHRzLmFja25vd2xlZGdlZFVudGlsO1xuICBjb25zdCBzdGFsbGVkID0gbm93IC0gc2luY2UgPj0gc3RhbGxNcyAmJiAhYWNrbm93bGVkZ2VkO1xuICByZXR1cm4geyBtZXNzYWdlSWQsIHNpbmNlLCBiYWRnZTogc3RhbGxlZCA/IFwic3RhbGxlZFwiIDogXCJ3b3JraW5nXCIgfTtcbn1cblxuLyoqIFdoYXQgdGhlIGNvbnZlcnNhdGlvbiBzaG93cywgcGVyIGJhZGdlLiBtaW5kLW1hcHBlcidzIHdvcmRzLCBuZWFyIGVub3VnaC4gKi9cbmV4cG9ydCBjb25zdCBXQUlUSU5HX0xBQkVMOiBSZWNvcmQ8V2FpdGluZ1tcImJhZGdlXCJdLCBzdHJpbmc+ID0ge1xuICB3b3JraW5nOiBcIndvcmtpbmcgb24gdGhpc+KAplwiLFxuICBzdGFsbGVkOiBcInRvb2sgdGhpcyBpbiwgdGhlbiB3ZW50IHF1aWV0IOKAlCBtYXkgYmUgc3R1Y2tcIixcbn07XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7O0FBcURBLHlC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LElBQUk7QUFBQSxJQUNGLFFBQVEsY0FBYyxFQUFFLE1BQU0sTUFBTSxTQUFTLGdCQUFnQixRQUFRLEtBQUssQ0FBQyxFQUFFO0FBQUEsSUFJN0UsT0FBTyxHQUFHO0FBQUEsSUFDVixRQUFRLE9BQU8sTUFDYixnQkFBZ0IsYUFBYSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUM7QUFBQSxzQkFBMEIsT0FBTyxLQUN4RixjQUNGLEVBQ0csSUFBSSxDQUFDLE1BQU0sS0FBSyxHQUFHLEVBQ25CLEtBQUssR0FBRztBQUFBLENBQ2I7QUFBQSxJQUNBLE9BQU87QUFBQTtBQUFBLEVBRVQsSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLElBQ0YsSUFBSSxNQUFNLFlBQVk7QUFBQSxNQUNwQixNQUFNLE1BQU0sT0FBTyxPQUFPLE1BQU0sSUFBSSxJQUFJO0FBQUEsTUFDeEMsU0FBUyxNQUFNO0FBQUEsTUFDZixVQUFVLE1BQU0sVUFBVSxPQUFPLE1BQU0sT0FBTyxJQUFJO0FBQUEsTUFDbEQsV0FBVyxNQUFNO0FBQUEsSUFDbkIsQ0FBQztBQUFBLElBQ0QsT0FBTyxHQUFHO0FBQUEsSUFFVixNQUFNLFNBQVMsYUFBYSxlQUFlLEVBQUUsU0FBUztBQUFBLElBQ3RELFFBQVEsT0FBTyxNQUNiLEdBQUcsS0FBSyxVQUFVLEVBQUUsSUFBSSxPQUFPLFFBQVEsT0FBTyxhQUFhLFFBQVEsRUFBRSxVQUFVLE9BQU8sQ0FBQyxFQUFFLENBQUM7QUFBQSxDQUM1RjtBQUFBLElBQ0EsT0FBTyxXQUFXLE1BQU0sSUFBSSxXQUFXLE1BQU0sSUFBSTtBQUFBO0FBQUEsRUFFbkQsUUFBUSxPQUFPLE1BQ2IsR0FBRyxLQUFLLFVBQVUsRUFBRSxLQUFLLG9CQUFvQixFQUFFLFFBQVEsTUFBTSxFQUFFLE1BQU0sWUFBWSxFQUFFLFdBQVcsTUFBTSxFQUFFLE1BQU0sS0FBSyxFQUFFLElBQUksQ0FBQztBQUFBLENBQzFIO0FBQUEsRUFDQSxNQUFNLE1BQU0sTUFBTSxFQUFFO0FBQUEsRUFDcEIsTUFBTSxFQUFFO0FBQUEsRUFFUixJQUFJLElBQUksU0FBUyxLQUFLLE1BQU0sS0FBSztBQUFBLElBQy9CLElBQUk7QUFBQSxNQUNGLElBQUksVUFBUyxNQUFNLEdBQUcsRUFBRSxTQUFTO0FBQUEsUUFBRyxZQUFXLE1BQU0sR0FBRztBQUFBLE1BQ3hELE1BQU07QUFBQSxFQUdWO0FBQUEsRUFDQSxPQUFPLElBQUk7QUFBQTtBQVFiLGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIkEzNzM5NTFBNDQ5NjJBOTM2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
