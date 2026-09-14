// @bun
var __require = import.meta.require;

// src/scriptorium/backend/server.ts
import { readFileSync as readFileSync4, statSync as statSync3, unlinkSync as unlinkSync3, watch } from "fs";
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

// src/scriptorium/backend/history.ts
var base = (p) => p.split("/").pop() ?? p;
var parent = (p) => p.slice(0, Math.max(0, p.lastIndexOf("/"))) || "/";
function planInverse(op, after, before) {
  switch (op.type) {
    case "doc.create":
      return {
        label: `created ${base(after.path ?? "")}`,
        inverse: { kind: "delete", path: after.path ?? "", dir: false }
      };
    case "folder.create":
      return {
        label: `created the folder ${base(after.path ?? "")}`,
        inverse: { kind: "delete", path: after.path ?? "", dir: true }
      };
    case "import":
      return {
        label: `copied in ${base(after.path ?? "")}`,
        inverse: { kind: "delete", path: after.path ?? "", dir: false }
      };
    case "set.make":
      return {
        label: `turned ${base(op.path)} into a set`,
        inverse: { kind: "delete", path: after.folder ?? "", dir: true }
      };
    case "move": {
      if (after.path === undefined || after.from === undefined)
        return null;
      return {
        label: `moved ${base(after.from)} into ${base(parent(after.path))}`,
        inverse: { kind: "move", path: after.path, into: parent(after.from) }
      };
    }
    case "rename": {
      if (after.path === undefined || after.from === undefined)
        return null;
      return {
        label: `renamed ${base(after.from)} to ${base(after.path)}`,
        inverse: { kind: "rename", path: after.path, name: base(after.from) }
      };
    }
    case "hide": {
      if (after.removedEntry) {
        return {
          label: `removed ${base(after.path ?? "")} from the context`,
          inverse: { kind: "context.add", path: after.path ?? "" }
        };
      }
      const had = before.hidden;
      if (!had)
        return null;
      return {
        label: `removed ${base(after.path ?? "")} from the context`,
        inverse: { kind: "hidden", entry: had.entry, rels: had.rels }
      };
    }
    case "unhide": {
      const had = before.hidden;
      if (!had || had.rels.length === 0)
        return null;
      return {
        label: `brought back ${had.rels.length} hidden item${had.rels.length === 1 ? "" : "s"}`,
        inverse: { kind: "hidden", entry: had.entry, rels: had.rels }
      };
    }
    case "workspace.set": {
      const was = before.workspace;
      if (was === undefined || was === after.path)
        return null;
      return {
        label: `set the workspace to ${base(after.path ?? "")}`,
        inverse: { kind: "workspace", path: was }
      };
    }
  }
}

class History {
  undos = [];
  redos = [];
  did(act) {
    if (!act)
      return;
    this.undos.push(act);
    this.redos = [];
  }
  peekUndo() {
    return this.undos[this.undos.length - 1] ?? null;
  }
  peekRedo() {
    return this.redos[this.redos.length - 1] ?? null;
  }
  tookUndo(redo) {
    const act = this.undos.pop();
    if (!act)
      return;
    if (redo)
      this.redos.push(redo);
  }
  tookRedo(undo) {
    const act = this.redos.pop();
    if (!act)
      return;
    if (undo)
      this.undos.push(undo);
  }
  view() {
    const undo = this.peekUndo();
    const redo = this.peekRedo();
    const deletes = undo?.inverse.kind === "delete" ? undo.inverse : undefined;
    return {
      canUndo: undo !== null,
      canRedo: redo !== null,
      ...undo ? { undoLabel: undo.label } : {},
      ...redo ? { redoLabel: redo.label } : {},
      ...deletes ? { undoDeletes: { path: deletes.path, dir: deletes.dir } } : {}
    };
  }
  depth() {
    return { undo: this.undos.length, redo: this.redos.length };
  }
}

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
  rmdirSync,
  rmSync as rmSync2,
  statSync as statSync2,
  unlinkSync as unlinkSync2,
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

// src/scriptorium/backend/search.ts
var LINE_CAP = 240;
function searchText(text, query, limit = 50) {
  const needle = query.trim().toLowerCase();
  if (needle === "" || limit <= 0)
    return [];
  const hay = text.toLowerCase();
  let at = hay.indexOf(needle);
  if (at === -1)
    return [];
  const starts = [0];
  for (let i = 0;i < text.length; i++)
    if (text.charCodeAt(i) === 10)
      starts.push(i + 1);
  const hits = [];
  let cursor = 0;
  while (at !== -1 && hits.length < limit) {
    while (cursor + 1 < starts.length && starts[cursor + 1] <= at)
      cursor++;
    const lineStart = starts[cursor];
    const lineEnd = cursor + 1 < starts.length ? starts[cursor + 1] - 1 : text.length;
    const whole = text.slice(lineStart, lineEnd);
    hits.push({
      line: cursor + 1,
      text: whole.length > LINE_CAP ? `${whole.slice(0, LINE_CAP - 1)}\u2026` : whole,
      from: at,
      to: at + needle.length
    });
    at = hay.indexOf(needle, at + needle.length);
  }
  return hits;
}
function isBoundary(ch) {
  return ch === " " || ch === "-" || ch === "_" || ch === "/" || ch === "." || ch === "'";
}
function scoreName(name, query) {
  const q = query.trim().toLowerCase();
  if (q === "")
    return null;
  const hay = name.toLowerCase();
  let score = 0;
  let at = 0;
  let run = 0;
  for (const ch of q) {
    const found = hay.indexOf(ch, at);
    if (found === -1)
      return null;
    run = found === at && at > 0 ? run + 1 : 0;
    score += 10 + run * 12;
    if (found === 0 || isBoundary(hay[found - 1]))
      score += 14;
    score -= Math.min(found - at, 12);
    at = found + 1;
  }
  if (hay.includes(q))
    score += 40;
  if (hay.startsWith(q))
    score += 25;
  score -= Math.min(name.length, 40) / 4;
  return score;
}
var PER_DOC = 20;
var TOTAL = 200;
var NAMES = 10;
var rankNames = (candidates, query, limit) => {
  const out = [];
  for (const c of candidates) {
    const byName = scoreName(c.name, query);
    const byTitle = c.title === undefined ? null : scoreName(c.title, query);
    if (byName === null && byTitle === null)
      continue;
    out.push({
      path: c.path,
      ...c.slug !== undefined ? { slug: c.slug } : {},
      name: c.name,
      ...c.title !== undefined ? { title: c.title } : {},
      score: Math.max(byName ?? -Infinity, byTitle ?? -Infinity)
    });
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return out.slice(0, limit);
};
function searchDocuments(candidates, query, read, caps = {}) {
  const q = query.trim();
  if (q === "")
    return { query: "", documents: [], text: [], count: 0, truncated: false };
  const perDoc = caps.perDoc ?? PER_DOC;
  const total = caps.total ?? TOTAL;
  const names = caps.names ?? NAMES;
  const scored = (caps.nameSearch ?? rankNames)(candidates, q, names);
  const text = [];
  let count = 0;
  let truncated = false;
  for (const c of candidates) {
    if (count >= total) {
      truncated = true;
      break;
    }
    let body = null;
    try {
      body = read(c);
    } catch {
      body = null;
    }
    if (body === null)
      continue;
    const room = Math.min(perDoc, total - count);
    const hits = searchText(body, q, room + 1);
    if (hits.length === 0)
      continue;
    if (hits.length > room)
      truncated = true;
    const kept = hits.slice(0, room);
    count += kept.length;
    text.push({
      path: c.path,
      ...c.slug !== undefined ? { slug: c.slug } : {},
      name: c.name,
      ...c.version !== undefined ? { version: c.version } : {},
      hits: kept
    });
  }
  return { query: q, documents: scored, text, count, truncated };
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
  entryRoot(id) {
    return this.m.context.find((e) => e.id === id)?.root ?? null;
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
  hiddenBefore(rawPath) {
    try {
      const item = this.itemOrDie(rawPath);
      return { entry: item.entry.id, rels: [...item.entry.hidden ?? []] };
    } catch {
      return null;
    }
  }
  hiddenOfEntry(entryId) {
    const e = this.m.context.find((x) => x.id === entryId);
    return e ? { entry: e.id, rels: [...e.hidden ?? []] } : null;
  }
  restoreHidden(entryId, rels) {
    const e = this.m.context.find((x) => x.id === entryId);
    if (!e)
      throw new SessionError(`no context entry ${entryId}`, 404, this.m.context.map((x) => x.id));
    const was = [...e.hidden ?? []];
    if (rels.length === 0)
      delete e.hidden;
    else
      e.hidden = [...rels];
    this.rescan(e.id);
    this.relink();
    this.closeOrphanedOpenDoc();
    this.persist();
    return { entry: e.id, was };
  }
  removeCreated(rawPath, dir) {
    const abs = resolve(rawPath);
    let st;
    try {
      st = statSync2(abs);
    } catch {
      return { path: abs, removed: false };
    }
    if (st.isDirectory() !== dir)
      throw new SessionError(`${this.display(abs)} is ${st.isDirectory() ? "a folder" : "a file"} now \u2014 the change this would undo no longer describes it`, 409);
    if (dir) {
      const left = readdirSync2(abs);
      if (left.length > 0)
        throw new SessionError(`${this.display(abs)} is not empty (${left.length} item${left.length === 1 ? "" : "s"}) \u2014 move what is inside it out first`, 409, left.slice(0, 10));
      rmdirSync(abs);
    } else {
      unlinkSync2(abs);
    }
    for (const e of this.m.context)
      this.rescan(e.id);
    this.relink();
    this.closeOrphanedOpenDoc();
    this.persist();
    return { path: abs, removed: true };
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
    const parent2 = dirname3(item.abs);
    const stem2 = basename3(item.abs, extname2(item.abs)) || "Untitled";
    const folder = join4(parent2, this.freeName(parent2, stem2, true));
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
  searchAll(opts) {
    const candidates = [];
    const seen = new Set;
    for (const entry of this.m.context) {
      for (const path of docPaths(entry)) {
        if (seen.has(path))
          continue;
        seen.add(path);
        const record = this.m.docs.find((d) => d.original === path);
        const title = readMeta(readHead(path))?.title;
        candidates.push({
          path,
          name: basename3(path),
          ...record ? { slug: record.slug, version: record.active } : {},
          ...title ? { title } : {}
        });
      }
    }
    return searchDocuments(candidates, opts.query, (c) => {
      const record = c.slug === undefined ? undefined : this.m.docs.find((d) => d.slug === c.slug);
      if (record)
        return this.activeText(record);
      return readFileSync3(c.path, "utf8");
    }, opts.limit !== undefined ? { total: opts.limit } : {});
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
  const history = new History;
  const viewState = () => {
    const base2 = { ...session.view(mode, selection), prefs: readPrefs(), userHome };
    return {
      ...base2,
      waiting: waitingOn(base2.chat, Date.now(), { acknowledgedUntil }),
      history: history.view()
    };
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
    const before = {
      ...op.type === "hide" ? { hidden: session.hiddenBefore(op.path) ?? undefined } : {},
      ...op.type === "unhide" ? { hidden: session.hiddenOfEntry(op.entry) ?? undefined } : {},
      ...op.type === "workspace.set" ? { workspace: session.workspace } : {}
    };
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
    history.did(planInverse(op, r, before));
    announce(line, { fact: op.type, by, ...r });
    broadcastState();
    return r;
  };
  const applyInverse = (inv) => {
    switch (inv.kind) {
      case "move": {
        const m = session.move(inv.path, inv.into);
        return {
          label: `moved ${basename4(m.from)} back into ${basename4(dirname4(m.path))}`,
          inverse: { kind: "move", path: m.path, into: dirname4(m.from) }
        };
      }
      case "rename": {
        const m = session.rename(inv.path, inv.name);
        return {
          label: `renamed ${basename4(m.from)} back to ${basename4(m.path)}`,
          inverse: { kind: "rename", path: m.path, name: basename4(m.from) }
        };
      }
      case "hidden": {
        const r = session.restoreHidden(inv.entry, inv.rels);
        return {
          label: r.was.length > inv.rels.length ? "brought items back" : "hid items again",
          inverse: { kind: "hidden", entry: r.entry, rels: r.was }
        };
      }
      case "context.add": {
        const { entry } = session.addContext(inv.path);
        return {
          label: `put ${basename4(inv.path)} back in the context`,
          inverse: { kind: "context.remove", entry: entry.id }
        };
      }
      case "context.remove": {
        const path = session.entryRoot(inv.entry);
        session.removeContext(inv.entry);
        return path === null ? null : {
          label: `took ${basename4(path)} back out of the context`,
          inverse: { kind: "context.add", path }
        };
      }
      case "workspace": {
        const was = session.workspace;
        session.setWorkspace(inv.path);
        return {
          label: `set the workspace back to ${basename4(inv.path)}`,
          inverse: { kind: "workspace", path: was }
        };
      }
      case "delete": {
        session.removeCreated(inv.path, inv.dir);
        return null;
      }
    }
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
      case "search": {
        try {
          reply(ws, { type: "search.results", report: session.searchAll(msg) });
        } catch (e) {
          reply(ws, { type: "error", message: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      case "history.undo": {
        const act = history.peekUndo();
        if (!act)
          return;
        if (act.inverse.kind === "delete" && msg.confirmDelete !== true) {
          reply(ws, {
            type: "error",
            message: `Undoing "${act.label}" would delete ${session.display(act.inverse.path)} \u2014 confirm it first.`
          });
          return;
        }
        try {
          history.tookUndo(applyInverse(act.inverse));
          syncWatchers();
          announce(`You undid: ${act.label}.`, { fact: "history.undo" });
          broadcastState();
        } catch (e) {
          reply(ws, { type: "error", message: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      case "history.redo": {
        const act = history.peekRedo();
        if (!act)
          return;
        try {
          history.tookRedo(applyInverse(act.inverse));
          syncWatchers();
          announce(`You redid: ${act.label}.`, { fact: "history.redo" });
          broadcastState();
        } catch (e) {
          reply(ws, { type: "error", message: e instanceof Error ? e.message : String(e) });
        }
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
      case "search":
        return session.searchAll(cmd);
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
      unlinkSync3(sessionFile);
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
        unlinkSync3(flags.log);
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

//# debugId=D1FC26062A4A56F764756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc3NlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2FuY2hvcnMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvZGlmZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9oaXN0b3J5LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3BpY2tlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9zZXNzaW9uLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2Zyb250bWF0dGVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2xpbmtzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3RyZWUudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2VhcmNoLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3dhaXRpbmcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiLyoqXG4gKiBzY3JpcHRvcml1bSdzIHBlci1zZXNzaW9uIGRhZW1vbiDigJQgdGhlIHByb2Nlc3MgdGhlIHN1cmZhY2UgdGFsa3MgdG8gb3ZlciBhXG4gKiBXZWJTb2NrZXQgYW5kIHRoZSBDTEkgdGFsa3MgdG8gb3ZlciBIVFRQLiBMYXVuY2hlZCBieVxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9zY3JpcHRvcml1bS9zY3JpcHRzL3NlcnZlci50c2AgKHRoZSBsYXVuY2hlciksIHdoaWNoXG4gKiBpbXBvcnRzIHRoZSBCVUlMVCBgZGlzdC9zZXJ2ZXIuanNgLlxuICpcbiAqIOKUgOKUgCBUSEUgRUlHSFQgUVVFU1RJT05TIChzY2FmZm9sZGluZyBwbGF5Ym9vayBOMSksIEFOU1dFUkVEIEFTIERFU0lHTiDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAxLiBBcml0aG1ldGljOiBgU0tJTExfUk9PVGAvYERJU1RfRElSYCBvbmx5LCBmb3IgdGhlIGtpdCdzIGByZXNvbHZlTW9kZWAgYW5kXG4gKiAgICBgc2VydmVGcm9tRGlzdGAsIGFuZCB0cnVlIGF0IHRoZSBFTUlUVEVEIGFkZHJlc3MgKGBkaXN0L3NlcnZlci5qc2AsIHdob3NlXG4gKiAgICBgLi5gIGlzIHRoZSBza2lsbCBmb2xkZXIpLiBOb3RoaW5nIGVsc2UgaXMgcGlubmVkIG9mZiBgaW1wb3J0Lm1ldGFgLlxuICogMi4gU2VydmVzOiBZRVMuIGAvYCBpcyB0aGUgYnVpbHQgYGluZGV4Lmh0bWxgIHZpYSBgc2VydmVGcm9tRGlzdGAsIG5vXG4gKiAgICBzdWJzdGl0dXRpb247IHRoZSBvbmx5IHJvdXRlcyBvZiBpdHMgb3duIGFyZSBgL3N0YXRlYCwgYC9jbWRgLCBgL2V2ZW50c2AsXG4gKiAgICBgL3dzYCBhbmQgYC9mcy8qYCAocmVhZC1vbmx5OiBhIHZlcnNpb24ncyB0ZXh0LCBhIGRpcmVjdG9yeSBsaXN0aW5nKS5cbiAqIDMuIFNlY29uZCBoYWxmOiBZRVMg4oCUIGBjbGkudHNgOyB0aGUgdHdvIHNoYXJlIGAuL2hlYXJ0YmVhdC50c2AuXG4gKiA0LiBMaWZlY3ljbGU6IGxvbmctcnVubmluZywgb25lIGRhZW1vbiBwZXIgc2Vzc2lvbiwgaWRsZS10aW1lb3V0IGxpa2VcbiAqICAgIGdsYW1vdXIgKGxpbmdlciBhZnRlciB0aGUgbGFzdCBzdWJzY3JpYmVyIGxlYXZlczsgZXhpdCAxMjQpLlxuICogNS4gYG1haW4oKWAgcmV0dXJucyB3aGlsZSB0aGUgcHJvY2VzcyBtdXN0IGxpdmU/IE5PIOKAlCBgbWFpbmAgYXdhaXRzIHRoZVxuICogICAgc2Vzc2lvbidzIGVuZCBhbmQgaXRzIG93biBkcmFpbiwgZXhhY3RseSBhcyBnbGFtb3VyJ3Mgc2VydmVyIGRvZXMsIHNvIHRoZVxuICogICAgbGF1bmNoZXIgaXMgVEVSTUlOQUwtRVhJVCAoYHByb2Nlc3MuZXhpdChhd2FpdCBydW4oKSlgKTogb25jZSBgbWFpbmBcbiAqICAgIHJlc29sdmVzIG5vdGhpbmcgbWF5IGtlZXAgdGhlIHByb2Nlc3MgYWxpdmUsIGFuZCBhIHdhdGNoZXIgaGFuZGxlIG9yIGFcbiAqICAgIHN0cmFnZ2xpbmcgc29ja2V0IHdvdWxkLiBEcml2ZW4sIG5vdCByZWFkIChzZWUgdGhlIHNsaWNlLUEgam91cm5hbCkuXG4gKiA2LiBFdmVudCBpZHMgcmVjb3ZlcmVkIGFjcm9zcyByZXN0YXJ0PyBOTyDigJQgdGhlIGxvZyBpcyBpbiBtZW1vcnkgYW5kIGlkc1xuICogICAgcmVzdGFydCBhdCAxLCBldmVuIHVuZGVyIGAtLXJlc3RvcmVgICh3aGljaCByZXN0b3JlcyB0aGUgTUFOSUZFU1QsIG5vdCB0aGVcbiAqICAgIGxvZykuIFNvIHRoZSBsb2cgaXMgc3RhbXBlZCB3aXRoIGEgcGVyLWJvb3QgRVBPQ0ggKG1pbmQtbWFwcGVyJ3Mgc2hhcGUpXG4gKiAgICBhbmQgdGhlIHRhaWwgcmVzZXRzIGl0cyBjdXJzb3Igd2hlbiB0aGUgZXBvY2ggY2hhbmdlcy5cbiAqIDcuIEEga2l0IHN1YmplY3QgaW4gYSBkaWZmZXJlbnQgc2hhcGU/IE5vIOKAlCB0aGUgc2hhcGUgd2FzIGNob3NlbiB0byBiZSB0aGVcbiAqICAgIGtpdCdzLlxuICogOC4gQSBraXQgbW9kdWxlIG5hbWVzIHRoaXMgc3BlbGwgYXMgaXRzIHNvdXJjZT8gU3RydWN0dXJhbGx5IE5POiBzY3JpcHRvcml1bVxuICogICAgaXMgdGhlIGZpcnN0IHNwZWxsIHNjYWZmb2xkZWQgYWZ0ZXIgdGhlIGNvbnZlcmdlbmNlLlxuICpcbiAqIOKUgOKUgCBLSVQgVkVSRElDVFMgKHBsYXlib29rIE40KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBlcnJvcnMgU1VCSkVDVCAodGhlIENMSTsgdGhlIGRhZW1vbiBhbnN3ZXJzIEhUVFAgc3RhdHVzZXMgdGhlIENMSSBtYXBzKSDCt1xuICogc2VydmVEaXN0IFNVQkpFQ1QgKGByZXNvbHZlTW9kZWAsIGBzZXJ2ZUZyb21EaXN0YCkgwrcgaG91c2VrZWVwaW5nIFNVQkpFQ1QsIGFsbFxuICogdGhyZWUgZXhwb3J0cyAoYHNob3VsZElkbGVDbG9zZWAgdmlhIGBzdGFydEhvdXNla2VlcGluZ2AncyBpZGxlLWNsb3NlLCB0aGVcbiAqIHNuYXBzaG90IHN3ZWVwIOKAlCBoZXJlIHRoZSBtYW5pZmVzdCBpcyB3cml0dGVuIG9uIGV2ZXJ5IGNoYW5nZSBpbnN0ZWFkLCBzbyB0aGVcbiAqIHN3ZWVwJ3Mgc25hcHNob3QgaG9vayBpcyBkZWxpYmVyYXRlbHkgTk9UIHBhc3NlZCDigJQgYW5kIGBkcmFpbkFuZFN0b3BgKSDCt1xuICogdGFpbEV2ZW50cyBTVUJKRUNUICh0aGUgQ0xJJ3MgYHRhaWxgKSDCtyBoZWFydGJlYXQgU1VCSkVDVCAoYC4vaGVhcnRiZWF0LnRzYCkgwrdcbiAqIGRpc2NvdmVyeSBTVUJKRUNUIChzZXNzaW9uLUpTT04sIEUxMzogYHNjcmlwdG9yaXVtLTxpZD4uanNvbmAgK1xuICogYHNjcmlwdG9yaXVtLWxhdGVzdC5qc29uYCBpbiB0bXBkaXIgdmlhIGB3cml0ZUZpbGVBdG9taWNgL2B1bmxpbmtJZk1hdGNoZXNgKSDCt1xuICogZXZlbnRMb2cgU1VCSkVDVCwgV0lUSCBFUE9DSCAoUTYpIMK3IHNzZSBTVUJKRUNUIChgR0VUIC9ldmVudHNgKSDCt1xuICogbGliL3ByaW50SnNvbiBTVUJKRUNUICh0aGUgQ0xJIHNwZWFrcyB0aGUgYWdlbnQgd2lyZSkuXG4gKlxuICog4pSA4pSAIFRFQVJET1dOIE9SREVSIChyZWdpc3RlciBBNiksIFNUQVRFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBnbGFtb3VyJ3Mgb3JkZXI6IHN0b3AgaG91c2VrZWVwaW5nIOKGkiBjbG9zZSB0aGUgd2F0Y2hlcnMg4oaSIHBlcnNpc3QgdGhlXG4gKiBtYW5pZmVzdCDihpIgdW5saW5rIGRpc2NvdmVyeSDihpIgZW1pdCBgY2xvc2VkYCDihpIgZHJhaW4uIERpc2NvdmVyeSBnb2VzIEJFRk9SRSB0aGVcbiAqIGBjbG9zZWRgIGZyYW1lIHNvIGEgdGFpbCB0aGF0IHNlZXMgYGNsb3NlZGAgYW5kIGEgQ0xJIHZlcmIgdGhhdCBydW5zIHJpZ2h0XG4gKiBhZnRlciBpdCBib3RoIGZpbmQgbm8gcG9pbnRlciB0byBhIGRhZW1vbiB0aGF0IGlzIGxlYXZpbmc7IHRoZSBvdGhlciBvcmRlclxuICogbGVhdmVzIGEgd2luZG93IGluIHdoaWNoIGEgdmVyYiByZXNvbHZlcyBhIHNlc3Npb24gdGhhdCB3aWxsIHJlZnVzZSBpdC5cbiAqL1xuXG5pbXBvcnQgeyB0eXBlIEZTV2F0Y2hlciwgcmVhZEZpbGVTeW5jLCBzdGF0U3luYywgdW5saW5rU3luYywgd2F0Y2ggfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIGFzIG5vZGVQYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5pbXBvcnQgeyB1bmxpbmtJZk1hdGNoZXMsIHdyaXRlRmlsZUF0b21pYyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9kaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB7IGNyZWF0ZUV2ZW50TG9nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2V2ZW50TG9nLnRzXCI7XG5pbXBvcnQgeyBkcmFpbkFuZFN0b3AsIHN0YXJ0SG91c2VrZWVwaW5nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hvdXNla2VlcGluZy50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZU1vZGUgYXMgcmVzb2x2ZU1vZGVJbiwgc2VydmVGcm9tRGlzdCB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9zZXJ2ZURpc3QudHNcIjtcbmltcG9ydCB7IHR5cGUgU3NlQ2xpZW50cywgc3NlUmVzcG9uc2UgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvc3NlLnRzXCI7XG5pbXBvcnQgeyBxdW90ZUxhYmVsIH0gZnJvbSBcIi4vYW5jaG9yc1wiO1xuaW1wb3J0IHsgdW5pZmllZCB9IGZyb20gXCIuL2RpZmZcIjtcbmltcG9ydCB7IElETEVfVElNRU9VVF9TRUMsIFNTRV9IRUFSVEJFQVRfTVMgfSBmcm9tIFwiLi9oZWFydGJlYXRcIjtcbmltcG9ydCB7IHR5cGUgQWN0LCB0eXBlIEFmdGVyLCB0eXBlIEJlZm9yZSwgSGlzdG9yeSwgdHlwZSBJbnZlcnNlLCBwbGFuSW52ZXJzZSB9IGZyb20gXCIuL2hpc3RvcnlcIjtcbmltcG9ydCB7IHR5cGUgUGlja0tpbmQsIHBhcnNlUGlja2VyT3V0cHV0LCBwaWNrZXJDb21tYW5kLCB3YXNDYW5jZWxsZWQgfSBmcm9tIFwiLi9waWNrZXJcIjtcbmltcG9ydCB0eXBlIHtcbiAgQWdlbnRDbWQsXG4gIENsaWVudE1zZyxcbiAgUHVibGljU3RhdGUsXG4gIFNlbGVjdGlvbixcbiAgU2VydmVyTXNnLFxuICBTdHJ1Y3R1cmVPcCxcbn0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcbmltcG9ydCB7IHR5cGUgRmlsZUV2ZW50LCBTZXNzaW9uLCBTZXNzaW9uRXJyb3IsIHNpZGVOYW1lIH0gZnJvbSBcIi4vc2Vzc2lvblwiO1xuaW1wb3J0IHsgbGlzdERpciwgUGF0aEVycm9yIH0gZnJvbSBcIi4vdHJlZVwiO1xuaW1wb3J0IHsgREVGQVVMVF9TTk9PWkVfTVMsIHdhaXRpbmdPbiB9IGZyb20gXCIuL3dhaXRpbmdcIjtcblxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuXG4vKiogcmVsZWFzZSBpZmYgYGRpc3QvaW5kZXguaHRtbGAgZXhpc3RzIGF0IHRoZSBza2lsbCByb290OyB0aGUgZW52IHZhciBvdmVycmlkZXMgKENvbnRyYWN0IDEpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKCk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIHJldHVybiByZXNvbHZlTW9kZUluKERJU1RfRElSKTtcbn1cblxuZnVuY3Rpb24gc2VydmVEaXN0KHBhdGg6IHN0cmluZyk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIHJldHVybiBzZXJ2ZUZyb21EaXN0KERJU1RfRElSLCBwYXRoID09PSBcIi9cIiA/IFwiaW5kZXguaHRtbFwiIDogcGF0aC5zbGljZSgxKSk7XG59XG5cbi8qKiBgJFNDUklQVE9SSVVNX0hPTUVgLCBkZWZhdWx0IGB+Ly5zY3JpcHRvcml1bWAuIGBwcm9tcHRzLmpzb25gIGJlc2lkZSBgc2Vzc2lvbnMvYCBpcyBzbGljZSBCJ3MgKEU5KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY3JpcHRvcml1bUhvbWUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlc29sdmUocHJvY2Vzcy5lbnYuU0NSSVBUT1JJVU1fSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuc2NyaXB0b3JpdW1cIikpO1xufVxuXG5leHBvcnQgdHlwZSBTdGFydE9wdHMgPSB7XG4gIHBvcnQ/OiBudW1iZXI7XG4gIHJlc3RvcmU/OiBzdHJpbmc7XG4gIHRpbWVvdXRTPzogbnVtYmVyO1xuICAvKiogRTIzOiBhIE5FVyBzZXNzaW9uJ3Mgd29ya3NwYWNlIOKAlCB0aGUgZGlyZWN0b3J5IGBvcGVuYCByYW4gaW4uIEEgcmVzdG9yZSBrZWVwcyBpdHMgb3duLiAqL1xuICB3b3Jrc3BhY2U/OiBzdHJpbmc7XG59O1xuXG4vKiogQSB0YWlsIGZyYW1lJ3MgcGF5bG9hZC4gVGhlIGxvZyBzdGFtcHMgYGlkYCBhbmQgYGVwb2NoYC4gKi9cbnR5cGUgTG9nRXZlbnQgPSBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiAmIHsgdHlwZTogc3RyaW5nIH07XG5cbi8qKiBIb3cgbG9uZyBhIGJ1cnN0IG9mIHdhdGNoZXIgZXZlbnRzIG9uIG9uZSBwYXRoIHNldHRsZXMgYmVmb3JlIGl0IGlzIHJlYWQuICovXG5jb25zdCBXQVRDSF9TRVRUTEVfTVMgPSA2MDtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0RGFlbW9uKG9wdHM6IFN0YXJ0T3B0cykge1xuICBjb25zdCBob21lID0gc2NyaXB0b3JpdW1Ib21lKCk7XG4gIC8vIE1vZGUgQkVGT1JFIGFueSB3cml0ZTogYSBmb3JjZWQtZGV2IGJvb3QgYXQgYSBzdXJmYWNlLWZyZWUgZGVzdGluYXRpb24gbXVzdFxuICAvLyBkaWUgYXQgdGhlIGltcG9ydCBoYXZpbmcgY3JlYXRlZCBub3RoaW5nIChnbGFtb3VyJ3MgbWVhc3VyZWQgb3JkZXIpLlxuICBjb25zdCBtb2RlID0gcmVzb2x2ZU1vZGUoKTtcbiAgY29uc3QgZGV2SW5kZXggPVxuICAgIG1vZGUgPT09IFwiZGV2XCJcbiAgICAgID8gKGF3YWl0IGltcG9ydChcIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9zdXJmYWNlL2luZGV4Lmh0bWxcIikpLmRlZmF1bHRcbiAgICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCByb3V0ZXMgPSAoZGV2SW5kZXggPyB7IFwiL1wiOiBkZXZJbmRleCB9IDoge30pIGFzIFJlY29yZDxzdHJpbmcsIG5ldmVyPjtcblxuICBjb25zdCBzZXNzaW9uID0gb3B0cy5yZXN0b3JlXG4gICAgPyBTZXNzaW9uLnJlc3RvcmUoaG9tZSwgb3B0cy5yZXN0b3JlKVxuICAgIDogU2Vzc2lvbi5jcmVhdGUoaG9tZSwgdW5kZWZpbmVkLCBvcHRzLndvcmtzcGFjZSk7XG4gIGNvbnN0IHNlc3Npb25JZCA9IHNlc3Npb24uaWQ7XG4gIGxldCBzZWxlY3Rpb246IFNlbGVjdGlvbiB8IG51bGwgPSBudWxsO1xuXG4gIC8vIC0tLSBwcmVmczogcGVyLXZpZXdlciBjb252ZW5pZW5jZXMgdGhhdCBvdXRsaXZlIGEgc2Vzc2lvbidzIHBvcnQgLS0tLS0tLS0tLS0tXG4gIC8vIEJyb3dzZXIgc3RvcmFnZSBpcyBrZXllZCBieSBvcmlnaW4sIHBvcnQgaW5jbHVkZWQsIGFuZCBldmVyeSBzZXNzaW9uIGdldHMgYVxuICAvLyBuZXcgcG9ydCDigJQgc28gYSBwYW5lIHNpemUga2VwdCBpbiBsb2NhbFN0b3JhZ2UgcmVzZXRzIGF0IHRoZSBuZXh0IGBvcGVuYC5cbiAgLy8gVGhleSBsaXZlIGluIHRoZSBob21lIGluc3RlYWQsIHNoYXJlZCBieSBldmVyeSBzZXNzaW9uIG9mIHRoaXMgaG9tZS5cbiAgY29uc3QgcHJlZnNGaWxlID0gam9pbihob21lLCBcInByZWZzLmpzb25cIik7XG4gIGNvbnN0IFBSRUZfS0VZID0gL15bYS16XVthLXowLTk6Ll8tXXswLDYzfSQvO1xuICBjb25zdCBQUkVGX1ZBTFVFX01BWCA9IDQwOTY7XG4gIGNvbnN0IFBSRUZfS0VZU19NQVggPSA2NDtcbiAgLyoqXG4gICAqIFJlYWQgdGhlIGhvbWUncyBwcmVmcyBGUkVTSC4gU2V2ZXJhbCBzZXNzaW9ucyBjYW4gc2hhcmUgb25lIGhvbWUgKEUxMyksIGVhY2hcbiAgICogaXRzIG93biBkYWVtb24sIHNvIGEgY29weSBsb2FkZWQgb25jZSBhdCBib290IGFuZCB3cml0dGVuIGJhY2sgd2hvbGUgd291bGRcbiAgICogZXJhc2UgYSBrZXkgYW5vdGhlciBzZXNzaW9uIHdyb3RlIHNpbmNlICh2ZXJpZnkgcGFzcykuIEV2ZXJ5IHdyaXRlIGlzXG4gICAqIHRoZXJlZm9yZSByZWFkIOKGkiBzZXQgb25lIGtleSDihpIgd3JpdGUsIGFuZCBldmVyeSBzbmFwc2hvdCByZWFkcyB0aGUgZmlsZS5cbiAgICogT25seSB3ZWxsLWZvcm1lZCBlbnRyaWVzIHN1cnZpdmUgYSByZWFkOyBhIGJhZCBmaWxlIHJlYWRzIGFzIGVtcHR5IGFuZCBpc1xuICAgKiByZXBsYWNlZCBieSB0aGUgbmV4dCB3cml0ZS5cbiAgICovXG4gIGNvbnN0IHJlYWRQcmVmcyA9ICgpOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0+IHtcbiAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmF3ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocHJlZnNGaWxlLCBcInV0ZjhcIikpIGFzIHVua25vd247XG4gICAgICBpZiAocmF3ICYmIHR5cGVvZiByYXcgPT09IFwib2JqZWN0XCIgJiYgIUFycmF5LmlzQXJyYXkocmF3KSkge1xuICAgICAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhyYXcpKVxuICAgICAgICAgIGlmIChQUkVGX0tFWS50ZXN0KGspICYmIHR5cGVvZiB2ID09PSBcInN0cmluZ1wiICYmIHYubGVuZ3RoIDw9IFBSRUZfVkFMVUVfTUFYKSBvdXRba10gPSB2O1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLyogbm8gcHJlZnMgeWV0LCBvciB1bnJlYWRhYmxlIOKAlCBlbXB0eSAqL1xuICAgIH1cbiAgICByZXR1cm4gb3V0O1xuICB9O1xuICBjb25zdCB1c2VySG9tZSA9IGhvbWVkaXIoKTtcbiAgLyoqXG4gICAqIEU1MzogdGhlIHNub296ZSB0aGUgYWdlbnQgYXNrZWQgZm9yLCBhbmQgdGhlIG1lc3NhZ2VzIGFscmVhZHkgbnVkZ2VkLlxuICAgKlxuICAgKiDim5QgT05FIE5VREdFIFBFUiBNRVNTQUdFLCBBTkQgVEhBVCBJUyBUSEUgV0hPTEUgQU5USS1OQUcgUlVMRS4gQ29sZTogXCJ3ZVxuICAgKiBkb24ndCB3YW50IHRvIGhhdmUgYSBzaXR1YXRpb24gd2hlcmUgYW4gYWdlbnQga2VlcHMgZ2V0dGluZyBwaW5nZWQgYWJvdXRcbiAgICogc29tZXRoaW5nIGFuZCBpdCdzIGxpa2UsIG5vLCBJJ20gYWN0dWFsbHkgd29ya2luZy5cIiBTbyBhIG1lc3NhZ2UgaWQgZW50ZXJzXG4gICAqIGBudWRnZWRgIHRoZSBmaXJzdCB0aW1lIGl0IGlzIHJlcG9ydGVkIOKAlCBvciB0aGUgbW9tZW50IHRoZSBhZ2VudCBzbm9vemVzIGl0XG4gICAqIOKAlCBhbmQgbmV2ZXIgbGVhdmVzLiBBIHNub296ZSBFWFBJUklORyB0aGVyZWZvcmUgY2hhbmdlcyB3aGF0IHRoZSBIVU1BTlxuICAgKiBzZWVzIChiYWNrIHRvIFwibWF5IGJlIHN0dWNrXCIsIGJlY2F1c2UgdGhleSBhcmUgb3dlZCB0aGUgdHJ1dGgpIHdpdGhvdXRcbiAgICogcGluZ2luZyB0aGUgYWdlbnQgYWdhaW4uXG4gICAqXG4gICAqIOKaoCBJTiBNRU1PUlksIE5PVCBJTiBUSEUgTUFOSUZFU1QsIGRlbGliZXJhdGVseS4gQSByZXN0b3JlZCBzZXNzaW9uIHdob3NlXG4gICAqIGh1bWFuIHdhcyBsZWZ0IHdhaXRpbmcgU0hPVUxEIHRlbGwgdGhlIGFnZW50IHRoYXQgYXJyaXZlcyDigJQgdGhlIHdhaXQgaXNcbiAgICogcmVhbCBhbmQgdGhlIG5ldyBhZ2VudCBoYXMgbm90IGhlYXJkIGFib3V0IGl0LlxuICAgKi9cbiAgbGV0IGFja25vd2xlZGdlZFVudGlsOiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIGNvbnN0IG51ZGdlZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAvKipcbiAgICogRTYwOiB0aGUgQ09OVEVYVCdzIHVuZG8gaGlzdG9yeSDigJQgbm90IHRoZSBlZGl0b3Incywgd2hpY2ggQ29kZU1pcnJvciBvd25zLlxuICAgKiBJbiBtZW1vcnkgb24gcHVycG9zZSAoc2VlIGBoaXN0b3J5LnRzYCk6IGFuIGludmVyc2UgZGVzY3JpYmVzIHRoZSB3b3JsZCBhc1xuICAgKiBpdCBpcyBub3csIGFuZCBhIHNlc3Npb24gcmVzdG9yZWQgdG9tb3Jyb3cgbWF5IG1lZXQgZmlsZXMgc29tZWJvZHkgaGFzXG4gICAqIHNpbmNlIG1vdmVkIGJ5IGhhbmQuXG4gICAqL1xuICBjb25zdCBoaXN0b3J5ID0gbmV3IEhpc3RvcnkoKTtcblxuICBjb25zdCB2aWV3U3RhdGUgPSAoKTogUHVibGljU3RhdGUgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSB7IC4uLnNlc3Npb24udmlldyhtb2RlLCBzZWxlY3Rpb24pLCBwcmVmczogcmVhZFByZWZzKCksIHVzZXJIb21lIH07XG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLmJhc2UsXG4gICAgICB3YWl0aW5nOiB3YWl0aW5nT24oYmFzZS5jaGF0LCBEYXRlLm5vdygpLCB7IGFja25vd2xlZGdlZFVudGlsIH0pLFxuICAgICAgaGlzdG9yeTogaGlzdG9yeS52aWV3KCksXG4gICAgfTtcbiAgfTtcblxuICAvLyAtLS0gY2hhbm5lbHMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHNvY2tldHMgPSBuZXcgU2V0PGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4+KCk7XG4gIGNvbnN0IGxvZyA9IGNyZWF0ZUV2ZW50TG9nPExvZ0V2ZW50Pih7IGVwb2NoOiBjcnlwdG8ucmFuZG9tVVVJRCgpIH0pO1xuICBjb25zdCBzc2VDbGllbnRzOiBTc2VDbGllbnRzID0gbmV3IFNldCgpO1xuICBsZXQgbGFzdEFjdGl2aXR5ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gIGNvbnN0IHRvdWNoID0gKCkgPT4ge1xuICAgIGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICB9O1xuXG4gIGNvbnN0IHNlbmQgPSAobXNnOiBTZXJ2ZXJNc2cpID0+IHtcbiAgICBjb25zdCBzID0gSlNPTi5zdHJpbmdpZnkobXNnKTtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLnNlbmQocyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogc29ja2V0IGNsb3NlZCAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcbiAgY29uc3QgYnJvYWRjYXN0U3RhdGUgPSAoKSA9PiBzZW5kKHsgdHlwZTogXCJzdGF0ZVwiLCBzdGF0ZTogdmlld1N0YXRlKCkgfSk7XG5cbiAgLyoqIEEgc3lzdGVtIGxpbmUgaW4gdGhlIGNoYXQg4oCUIGFuZCwgYmVjYXVzZSB0aGUgYWdlbnQgbXVzdCBrbm93IGl0IHRvbywgb24gdGhlIHRhaWwuICovXG4gIGNvbnN0IGFubm91bmNlID0gKHRleHQ6IHN0cmluZywgZmFjdDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fSkgPT4ge1xuICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJzeXN0ZW1cIiwgdGV4dCk7XG4gICAgbG9nLmVtaXQoeyB0eXBlOiBcInN5c3RlbVwiLCB0ZXh0LCB0czogbS50cywgLi4uZmFjdCB9KTtcbiAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICB9O1xuXG4gIC8vIC0tLSB0aGUgd2F0Y2hlciAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvL1xuICAvLyDimqAgREVWSUFUSU9OIEZST00gVEhFIEJSSUVGLCBXSVRIIElUUyBSRUFTT046IGBub2RlOmZzYCBgd2F0Y2hgIChCdW4nc1xuICAvLyBidWlsdC1pbiksIE5PVCBgQHBhcmNlbC93YXRjaGVyYC4gYEBwYXJjZWwvd2F0Y2hlcmAgaXMgYSBuYXRpdmUgYWRkb24gd2hvc2VcbiAgLy8gbG9hZGVyIGRvZXMgYSBydW50aW1lIGByZXF1aXJlKClgIG9mIGEgcGVyLXBsYXRmb3JtIHBhY2thZ2U7IGJ1bmRsZWQgaW50b1xuICAvLyBgZGlzdC9zZXJ2ZXIuanNgIGl0IGlzIG5vdCBpbmxpbmVkLCBzbyB0aGUgc2hpcHBlZCBkYWVtb24gd291bGQgbmVlZCBhXG4gIC8vIGBub2RlX21vZHVsZXNgIHRoZSBtYXJrZXRwbGFjZSBuZXZlciBjb3BpZXMgKGltcG9ydC1ib3VuZGFyeSB3YXJkIDFiJ3NcbiAgLy8gXCJ0aGUgc2hpcHBlZCBleGVjdXRpb24gcGF0aCBjYXJyaWVzIG5vIGRlcGVuZGVuY2llc1wiKS4gTWVhc3VyZWQgdW5kZXIgQnVuXG4gIC8vIDEuNC4wIG9uIG1hY09TIGJlZm9yZSBjaG9vc2luZzogYSByZWN1cnNpdmUgZGlyZWN0b3J5IHdhdGNoIHJlcG9ydHMgYW5cbiAgLy8gaW4tcGxhY2Ugd3JpdGUsIGFuIGF0b21pYyB0bXArcmVuYW1lIHNhdmUsIGFuZCBib3RoIGFnYWluIGluIGFcbiAgLy8gc3ViZGlyZWN0b3J5IOKAlCB0aGUgZm91ciBjYXNlcyBpbnZlc3RpZ2F0aW9uIMKnNSBkcm92ZSBAcGFyY2VsL3dhdGNoZXIgb24uXG4gIC8vIFRoZSBoYXNoLWNvbXBhcmUgYW5kIHNlbGYtd3JpdGUgc3VwcHJlc3Npb24gYXJlIHVuY2hhbmdlZCAoc2Vzc2lvbi50cykuXG4gIGNvbnN0IHdhdGNoZXJzID0gbmV3IE1hcDxzdHJpbmcsIEZTV2F0Y2hlcj4oKTtcbiAgY29uc3QgcGVuZGluZyA9IG5ldyBNYXA8c3RyaW5nLCBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0Pj4oKTtcbiAgY29uc3Qgb25GcyA9IChhYnM6IHN0cmluZykgPT4ge1xuICAgIGNvbnN0IHQgPSBwZW5kaW5nLmdldChhYnMpO1xuICAgIGlmICh0KSBjbGVhclRpbWVvdXQodCk7XG4gICAgcGVuZGluZy5zZXQoXG4gICAgICBhYnMsXG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgcGVuZGluZy5kZWxldGUoYWJzKTtcbiAgICAgICAgbGV0IGV2OiBGaWxlRXZlbnQgfCBudWxsID0gbnVsbDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBldiA9IHNlc3Npb24ub25GaWxlRXZlbnQoYWJzKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBzY3JpcHRvcml1bTogd2F0Y2hlcjogJHtlfVxcbmApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChldikgaGFuZGxlRmlsZUV2ZW50KGV2KTtcbiAgICAgIH0sIFdBVENIX1NFVFRMRV9NUyksXG4gICAgKTtcbiAgfTtcbiAgY29uc3Qgc3luY1dhdGNoZXJzID0gKCkgPT4ge1xuICAgIGNvbnN0IHdhbnQgPSBuZXcgTWFwKFxuICAgICAgc2Vzc2lvbi53YXRjaFJvb3RzKCkubWFwKChyKSA9PiBbYCR7ci5yZWN1cnNpdmUgPyBcIlJcIiA6IFwiRlwifToke3Iud2F0Y2h9PiR7ci5wYXRofWAsIHJdKSxcbiAgICApO1xuICAgIGZvciAoY29uc3QgW2tleSwgd10gb2Ygd2F0Y2hlcnMpXG4gICAgICBpZiAoIXdhbnQuaGFzKGtleSkpIHtcbiAgICAgICAgdy5jbG9zZSgpO1xuICAgICAgICB3YXRjaGVycy5kZWxldGUoa2V5KTtcbiAgICAgIH1cbiAgICBmb3IgKGNvbnN0IFtrZXksIHJdIG9mIHdhbnQpIHtcbiAgICAgIGlmICh3YXRjaGVycy5oYXMoa2V5KSkgY29udGludWU7XG4gICAgICB0cnkge1xuICAgICAgICAvLyBXYXRjaGVkIGF0IHRoZSBSRUFMUEFUSCwgcmVwb3J0ZWQgdW5kZXIgdGhlIHN0b3JlZCBwYXRoIGZvcm1cbiAgICAgICAgLy8gKHZlcmlmeS1wYXNzIGZpeCAzIOKAlCBzZWUgU2Vzc2lvbi53YXRjaFJvb3RzKS5cbiAgICAgICAgY29uc3QgdyA9IHdhdGNoKHIud2F0Y2gsIHsgcmVjdXJzaXZlOiByLnJlY3Vyc2l2ZSB9LCAoX2V2ZW50LCBuYW1lKSA9PiB7XG4gICAgICAgICAgaWYgKG5hbWUpIG9uRnMoam9pbihyLnBhdGgsIG5hbWUudG9TdHJpbmcoKSkpO1xuICAgICAgICAgIGVsc2UgaWYgKHIuZW50cnlJZCkgb25GcyhyLnBhdGgpO1xuICAgICAgICB9KTtcbiAgICAgICAgdy5vbihcImVycm9yXCIsICgpID0+IHtcbiAgICAgICAgICAvKiB0aGUgZGlyZWN0b3J5IHdlbnQgYXdheTsgdGhlIG5leHQgc3luYyBkcm9wcyBpdCAqL1xuICAgICAgICB9KTtcbiAgICAgICAgd2F0Y2hlcnMuc2V0KGtleSwgdyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogdW53YXRjaGFibGUgKGdvbmUsIHBlcm1pc3Npb25zKSDigJQgb3V0c2lkZSBjaGFuZ2VzIHRoZXJlIGdvIHVuc2VlbiAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICBjb25zdCBoYW5kbGVGaWxlRXZlbnQgPSAoZXY6IEZpbGVFdmVudCkgPT4ge1xuICAgIHN3aXRjaCAoZXYua2luZCkge1xuICAgICAgY2FzZSBcInZlcnNpb24uY2hhbmdlZFwiOlxuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICAgIHZlcnNpb246IGV2LnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogZXYudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwidmVyc2lvbi5jcmVhdGVkXCI6XG4gICAgICAgIGFubm91bmNlKGB2JHtldi52ZXJzaW9ufSBvZiAke2V2LmRvY30gYXBwZWFyZWQgKHdyaXR0ZW4gZGlyZWN0bHkgdG8gJHtldi5wYXRofSlgLCB7XG4gICAgICAgICAgZmFjdDogXCJ2ZXJzaW9uLmNyZWF0ZWRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcImFjdGl2ZS5vdXRzaWRlXCI6XG4gICAgICAgIC8vIEUyOiB0aGUgYWdlbnQgbmV2ZXIgd3JpdGVzIHRoZSB2ZXJzaW9uIHRoZSBodW1hbiBpcyBlZGl0aW5nLiBUaGVcbiAgICAgICAgLy8gb3V0c2lkZSB0ZXh0IGlzIEtFUFQgYXMgYSBuZXcgYWdlbnQgdmVyc2lvbiBhbmQgdGhlIGFjdGl2ZSB2ZXJzaW9uXG4gICAgICAgIC8vIGtlZXBzIHRoZSBodW1hbidzIHRleHQg4oCUIG5vdGhpbmcgaXMgbG9zdCwgYW5kIHRoZSBodW1hbidzIGJ1ZmZlciBpc1xuICAgICAgICAvLyBub3QgdG91Y2hlZCAodmVyaWZ5LXBhc3MgZml4IDQpLlxuICAgICAgICBhbm5vdW5jZU91dHNpZGUoZXYuZG9jLCBldi52ZXJzaW9uLCBldi5wYXRoLCBldi5wcmVzZXJ2ZWRBcywgZXYucHJlc2VydmVkUGF0aCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJvcmlnaW5hbC5yZWxvYWRlZFwiOlxuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICAgIHZlcnNpb246IGV2LnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogZXYudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShgJHtldi5vcmlnaW5hbH0gY2hhbmdlZCBvbiBkaXNrIOKAlCByZWxvYWRlZCAoeW91IGhhZCBubyB1bnNhdmVkIGVkaXRzKS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJvcmlnaW5hbC5yZWxvYWRlZFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcIm9yaWdpbmFsLmNvbmZsaWN0XCI6XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGAke2V2Lm9yaWdpbmFsfSBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgeW91IGhhdmUgdW5zYXZlZCBlZGl0cy4gU2F2ZSBvdmVyd3JpdGVzIGl0IHdpdGggeW91cnM7IFJldmVydCB0YWtlcyB0aGUgZmlsZSdzIHZlcnNpb24uYCxcbiAgICAgICAgICB7IGZhY3Q6IFwib3JpZ2luYWwuY29uZmxpY3RcIiwgZG9jOiBldi5kb2MgfSxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInRyZWVcIjpcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBhbm5vdW5jZU91dHNpZGUgPSAoXG4gICAgZG9jOiBzdHJpbmcsXG4gICAgdmVyc2lvbjogbnVtYmVyLFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBwcmVzZXJ2ZWRBczogbnVtYmVyLFxuICAgIHByZXNlcnZlZFBhdGg6IHN0cmluZyxcbiAgKSA9PlxuICAgIGFubm91bmNlKFxuICAgICAgYHYke3ZlcnNpb259IG9mICR7ZG9jfSBpcyB0aGUgQUNUSVZFIHZlcnNpb24gYW5kIHdhcyB3cml0dGVuIGZyb20gb3V0c2lkZSB0aGUgZWRpdG9yLiBUaGF0IHRleHQgaXMga2VwdCBhcyB2JHtwcmVzZXJ2ZWRBc307IHRoZSBhY3RpdmUgdmVyc2lvbiBrZWVwcyB5b3VyIHRleHQuIEFnZW50IGVkaXRzIGJlbG9uZyBpbiBhIG5ldyB2ZXJzaW9uICh2ZXJzaW9uLW5ldykuYCxcbiAgICAgIHsgZmFjdDogXCJhY3RpdmUub3V0c2lkZVwiLCBkb2MsIHZlcnNpb24sIHBhdGgsIHByZXNlcnZlZEFzLCBwcmVzZXJ2ZWRQYXRoIH0sXG4gICAgKTtcblxuICAvLyAtLS0gc2hhcmVkIGFjdHMgKHN1cmZhY2UgYW5kIGFnZW50IHJlYWNoIHRoZSBzYW1lIGNvZGUpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBhZGRQYXRocyA9IChwYXRoczogc3RyaW5nW10pID0+IHtcbiAgICBjb25zdCBhZGRlZCA9IHBhdGhzLm1hcCgocCkgPT4gc2Vzc2lvbi5hZGRDb250ZXh0KHApKTtcbiAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIHJldHVybiBhZGRlZDtcbiAgfTtcblxuICBjb25zdCBhY3RpdmF0ZSA9IChkb2M6IHN0cmluZyB8IHVuZGVmaW5lZCwgdmVyc2lvbjogbnVtYmVyLCBieTogXCJodW1hblwiIHwgXCJhZ2VudFwiKSA9PiB7XG4gICAgY29uc3QgciA9IHNlc3Npb24uYWN0aXZhdGUoeyBkb2MsIHZlcnNpb24gfSk7XG4gICAgY29uc3QgdmlldyA9IHNlc3Npb24uZG9jKHIuc2x1Zyk7XG4gICAgY29uc3QgcGF0aCA9IHZpZXcudmVyc2lvbnMuZmluZCgodikgPT4gdi5uID09PSB2ZXJzaW9uKT8ucGF0aCA/PyBudWxsO1xuICAgIHNlbmQoe1xuICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgIGRvYzogci5zbHVnLFxuICAgICAgdmVyc2lvbixcbiAgICAgIHRleHQ6IHNlc3Npb24ucmVhZFZlcnNpb24oci5zbHVnLCB2ZXJzaW9uKS50ZXh0LFxuICAgICAgb3JpZ2luOiBcImxvYWRcIixcbiAgICB9KTtcbiAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgXCJzeXN0ZW1cIixcbiAgICAgIGAke2J5ID09PSBcImFnZW50XCIgPyBcIkFnZW50XCIgOiBcIllvdVwifSBtYWRlIHYke3ZlcnNpb259IG9mICR7ci5zbHVnfSBhY3RpdmUgKHdhcyB2JHtyLnByZXZpb3VzfSkuYCxcbiAgICApO1xuICAgIGxvZy5lbWl0KHsgdHlwZTogXCJhY3RpdmF0ZWRcIiwgYnksIGRvYzogci5zbHVnLCB2ZXJzaW9uLCBwcmV2aW91czogci5wcmV2aW91cywgcGF0aCwgdHM6IG0udHMgfSk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4geyBkb2M6IHIuc2x1ZywgdmVyc2lvbiwgcHJldmlvdXM6IHIucHJldmlvdXMsIHBhdGggfTtcbiAgfTtcblxuICAvKipcbiAgICogRTI0OiBvbmUgc3RydWN0dXJlIGNoYW5nZSwgZnJvbSBlaXRoZXIgcGFydHkg4oCUIHRoZSBzYW1lIHNlc3Npb24gbWV0aG9kLCB0aGVcbiAgICogc2FtZSBhbm5vdW5jZW1lbnQgKG5hbWluZyB3aG8gZGlkIGl0KSwgdGhlIHNhbWUgdGFpbCBmYWN0LiBSZXR1cm5zIHRoZSBwYXRoXG4gICAqIHRoZSBjaGFuZ2UgbGFuZGVkIGF0LCB3aGljaCB0aGUgc3VyZmFjZSB1c2VzIHRvIG9wZW4gb3IgcmVuYW1lIGl0LlxuICAgKi9cbiAgY29uc3QgU1RSVUNUVVJFX09QUyA9IG5ldyBTZXQ8c3RyaW5nPihbXG4gICAgXCJkb2MuY3JlYXRlXCIsXG4gICAgXCJmb2xkZXIuY3JlYXRlXCIsXG4gICAgXCJtb3ZlXCIsXG4gICAgXCJyZW5hbWVcIixcbiAgICBcImhpZGVcIixcbiAgICBcInVuaGlkZVwiLFxuICAgIFwic2V0Lm1ha2VcIixcbiAgICBcImltcG9ydFwiLFxuICAgIFwid29ya3NwYWNlLnNldFwiLFxuICBdIHNhdGlzZmllcyBTdHJ1Y3R1cmVPcFtcInR5cGVcIl1bXSk7XG4gIGNvbnN0IGlzU3RydWN0dXJlT3AgPSAobTogeyB0eXBlOiBzdHJpbmcgfSk6IG0gaXMgU3RydWN0dXJlT3AgPT4gU1RSVUNUVVJFX09QUy5oYXMobS50eXBlKTtcblxuICBjb25zdCBzdHJ1Y3R1cmUgPSAob3A6IFN0cnVjdHVyZU9wLCBieTogXCJodW1hblwiIHwgXCJhZ2VudFwiKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgIGNvbnN0IHdobyA9IGJ5ID09PSBcImFnZW50XCIgPyBcIkFnZW50XCIgOiBcIllvdVwiO1xuICAgIC8vIOKblCBDQVBUVVJFRCBCRUZPUkUgVEhFIEFDVCwgYmVjYXVzZSBldmVyeSBmaWVsZCBoZXJlIGlzIHNvbWV0aGluZyB0aGUgYWN0XG4gICAgLy8gQ0hBTkdFUzogcmVhZGluZyBhbiBlbnRyeSdzIGhpZGRlbiBsaXN0IGFmdGVyd2FyZHMgcmV0dXJucyB0aGUgbGlzdFxuICAgIC8vIGluY2x1ZGluZyB3aGF0IHdhcyBqdXN0IGhpZGRlbiwgd2hpY2ggcmVzdG9yZXMgbm90aGluZyAoRTYwKS5cbiAgICBjb25zdCBiZWZvcmU6IEJlZm9yZSA9IHtcbiAgICAgIC4uLihvcC50eXBlID09PSBcImhpZGVcIiA/IHsgaGlkZGVuOiBzZXNzaW9uLmhpZGRlbkJlZm9yZShvcC5wYXRoKSA/PyB1bmRlZmluZWQgfSA6IHt9KSxcbiAgICAgIC4uLihvcC50eXBlID09PSBcInVuaGlkZVwiID8geyBoaWRkZW46IHNlc3Npb24uaGlkZGVuT2ZFbnRyeShvcC5lbnRyeSkgPz8gdW5kZWZpbmVkIH0gOiB7fSksXG4gICAgICAuLi4ob3AudHlwZSA9PT0gXCJ3b3Jrc3BhY2Uuc2V0XCIgPyB7IHdvcmtzcGFjZTogc2Vzc2lvbi53b3Jrc3BhY2UgfSA6IHt9KSxcbiAgICB9O1xuICAgIGNvbnN0IHNob3duID0gKHA6IHN0cmluZykgPT4gc2Vzc2lvbi5kaXNwbGF5KHApO1xuICAgIGxldCByOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiAmIHsgcGF0aD86IHN0cmluZyB9O1xuICAgIGxldCBsaW5lOiBzdHJpbmc7XG4gICAgc3dpdGNoIChvcC50eXBlKSB7XG4gICAgICBjYXNlIFwiZG9jLmNyZWF0ZVwiOlxuICAgICAgICByID0gc2Vzc2lvbi5jcmVhdGVEb2Mob3AuZGlyLCBvcC5uYW1lKTtcbiAgICAgICAgbGluZSA9IGAke3dob30gY3JlYXRlZCAke3Nob3duKHIucGF0aCBhcyBzdHJpbmcpfS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJmb2xkZXIuY3JlYXRlXCI6XG4gICAgICAgIHIgPSBzZXNzaW9uLmNyZWF0ZUZvbGRlcihvcC5kaXIsIG9wLm5hbWUpO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBjcmVhdGVkIHRoZSBmb2xkZXIgJHtzaG93bihyLnBhdGggYXMgc3RyaW5nKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLm1vdmUob3AucGF0aCwgb3AuaW50byk7XG4gICAgICAgIHIgPSBtO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBtb3ZlZCAke3Nob3duKG0uZnJvbSl9IHRvICR7c2hvd24obS5wYXRoKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwicmVuYW1lXCI6IHtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24ucmVuYW1lKG9wLnBhdGgsIG9wLm5hbWUpO1xuICAgICAgICByID0gbTtcbiAgICAgICAgbGluZSA9IGAke3dob30gcmVuYW1lZCAke3Nob3duKG0uZnJvbSl9IHRvICR7c2hvd24obS5wYXRoKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiaGlkZVwiOiB7XG4gICAgICAgIGNvbnN0IGggPSBzZXNzaW9uLmhpZGUob3AucGF0aCk7XG4gICAgICAgIHIgPSBoO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSByZW1vdmVkICR7c2hvd24oaC5wYXRoKX0gZnJvbSBTY3JpcHRvcml1bSAodGhlIGZpbGUgaXMgc3RpbGwgb24gZGlzaykuYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwidW5oaWRlXCI6IHtcbiAgICAgICAgY29uc3QgdSA9IHNlc3Npb24udW5oaWRlKG9wLmVudHJ5KTtcbiAgICAgICAgciA9IHU7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IGJyb3VnaHQgYmFjayAke3UucmVzdG9yZWR9IGhpZGRlbiBpdGVtJHt1LnJlc3RvcmVkID09PSAxID8gXCJcIiA6IFwic1wifS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzZXQubWFrZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLm1ha2VTZXQob3AucGF0aCk7XG4gICAgICAgIHIgPSBtO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSB0dXJuZWQgJHtiYXNlbmFtZShtLnBhdGgpfSBpbnRvIGEgc2V0OiAke3Nob3duKG0uZm9sZGVyKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiaW1wb3J0XCI6XG4gICAgICAgIHIgPSBzZXNzaW9uLmltcG9ydFRleHQob3AubmFtZSwgb3AudGV4dCwgb3AuaW50byk7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IGNvcGllZCAke29wLm5hbWV9IGluIGFzICR7c2hvd24oci5wYXRoIGFzIHN0cmluZyl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIndvcmtzcGFjZS5zZXRcIjpcbiAgICAgICAgciA9IHNlc3Npb24uc2V0V29ya3NwYWNlKG9wLnBhdGgpO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBzZXQgdGhlIHdvcmtzcGFjZSB0byAke3Nob3duKHIucGF0aCBhcyBzdHJpbmcpfS5gO1xuICAgICAgICBicmVhaztcbiAgICB9XG4gICAgc3luY1dhdGNoZXJzKCk7XG4gICAgLy8gVGhlIHdheSBiYWNrLCBwbGFubmVkIG5vdyBhbmQgZnJvbSB3aGF0IHdhcyB0cnVlIG5vdy5cbiAgICBoaXN0b3J5LmRpZChwbGFuSW52ZXJzZShvcCwgciBhcyBBZnRlciwgYmVmb3JlKSk7XG4gICAgYW5ub3VuY2UobGluZSwgeyBmYWN0OiBvcC50eXBlLCBieSwgLi4uciB9KTtcbiAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIHJldHVybiByO1xuICB9O1xuXG4gIC8qKlxuICAgKiBBcHBseSBvbmUgcmVjb3JkZWQgaW52ZXJzZSwgYW5kIHJldHVybiB0aGUgYWN0IHRoYXQgd291bGQgcmV2ZXJzZSBUSEFUIOKAlFxuICAgKiB3aGljaCBpcyB3aGF0IGdvZXMgb250byB0aGUgb3RoZXIgc3RhY2suXG4gICAqXG4gICAqIOKblCBBIERFTEVURSBIQVMgTk8gV0FZIEJBQ0ssIGFuZCBzYXlzIHNvIGJ5IHJldHVybmluZyBudWxsLiBPbmNlIGEgY3JlYXRlZFxuICAgKiBmaWxlIGlzIGdvbmUgaXRzIGNvbnRlbnRzIGFyZSBnb25lIHdpdGggaXQsIHNvIGEgcmVkbyB0aGF0IFwicmUtY3JlYXRlc1wiIGl0XG4gICAqIHdvdWxkIGhhbmQgYmFjayBhbiBlbXB0eSBmaWxlIHdlYXJpbmcgdGhlIHNhbWUgbmFtZSDigJQgdGhlIGtpbmQgb2YgbGllIGFuXG4gICAqIHVuZG8gc3RhY2sgbXVzdCBub3QgdGVsbC4gQ29uZmlybWVkIGRlbGV0aW9ucyBhcmUgdGhlcmVmb3JlIG9uZS13YXksIHdoaWNoXG4gICAqIGlzIGFsc28gd2h5IHRoZXkgYXJlIGNvbmZpcm1lZC5cbiAgICovXG4gIGNvbnN0IGFwcGx5SW52ZXJzZSA9IChpbnY6IEludmVyc2UpOiBBY3QgfCBudWxsID0+IHtcbiAgICBzd2l0Y2ggKGludi5raW5kKSB7XG4gICAgICBjYXNlIFwibW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLm1vdmUoaW52LnBhdGgsIGludi5pbnRvKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBsYWJlbDogYG1vdmVkICR7YmFzZW5hbWUobS5mcm9tKX0gYmFjayBpbnRvICR7YmFzZW5hbWUoZGlybmFtZShtLnBhdGgpKX1gLFxuICAgICAgICAgIGludmVyc2U6IHsga2luZDogXCJtb3ZlXCIsIHBhdGg6IG0ucGF0aCwgaW50bzogZGlybmFtZShtLmZyb20pIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwicmVuYW1lXCI6IHtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24ucmVuYW1lKGludi5wYXRoLCBpbnYubmFtZSk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgbGFiZWw6IGByZW5hbWVkICR7YmFzZW5hbWUobS5mcm9tKX0gYmFjayB0byAke2Jhc2VuYW1lKG0ucGF0aCl9YCxcbiAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwicmVuYW1lXCIsIHBhdGg6IG0ucGF0aCwgbmFtZTogYmFzZW5hbWUobS5mcm9tKSB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImhpZGRlblwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlc3RvcmVIaWRkZW4oaW52LmVudHJ5LCBpbnYucmVscyk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgbGFiZWw6IHIud2FzLmxlbmd0aCA+IGludi5yZWxzLmxlbmd0aCA/IFwiYnJvdWdodCBpdGVtcyBiYWNrXCIgOiBcImhpZCBpdGVtcyBhZ2FpblwiLFxuICAgICAgICAgIGludmVyc2U6IHsga2luZDogXCJoaWRkZW5cIiwgZW50cnk6IHIuZW50cnksIHJlbHM6IHIud2FzIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiY29udGV4dC5hZGRcIjoge1xuICAgICAgICBjb25zdCB7IGVudHJ5IH0gPSBzZXNzaW9uLmFkZENvbnRleHQoaW52LnBhdGgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxhYmVsOiBgcHV0ICR7YmFzZW5hbWUoaW52LnBhdGgpfSBiYWNrIGluIHRoZSBjb250ZXh0YCxcbiAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiY29udGV4dC5yZW1vdmVcIiwgZW50cnk6IGVudHJ5LmlkIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiY29udGV4dC5yZW1vdmVcIjoge1xuICAgICAgICBjb25zdCBwYXRoID0gc2Vzc2lvbi5lbnRyeVJvb3QoaW52LmVudHJ5KTtcbiAgICAgICAgc2Vzc2lvbi5yZW1vdmVDb250ZXh0KGludi5lbnRyeSk7XG4gICAgICAgIHJldHVybiBwYXRoID09PSBudWxsXG4gICAgICAgICAgPyBudWxsXG4gICAgICAgICAgOiB7XG4gICAgICAgICAgICAgIGxhYmVsOiBgdG9vayAke2Jhc2VuYW1lKHBhdGgpfSBiYWNrIG91dCBvZiB0aGUgY29udGV4dGAsXG4gICAgICAgICAgICAgIGludmVyc2U6IHsga2luZDogXCJjb250ZXh0LmFkZFwiLCBwYXRoIH0sXG4gICAgICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIndvcmtzcGFjZVwiOiB7XG4gICAgICAgIGNvbnN0IHdhcyA9IHNlc3Npb24ud29ya3NwYWNlO1xuICAgICAgICBzZXNzaW9uLnNldFdvcmtzcGFjZShpbnYucGF0aCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgbGFiZWw6IGBzZXQgdGhlIHdvcmtzcGFjZSBiYWNrIHRvICR7YmFzZW5hbWUoaW52LnBhdGgpfWAsXG4gICAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcIndvcmtzcGFjZVwiLCBwYXRoOiB3YXMgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJkZWxldGVcIjoge1xuICAgICAgICBzZXNzaW9uLnJlbW92ZUNyZWF0ZWQoaW52LnBhdGgsIGludi5kaXIpO1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgLy8gLS0tIHN1cmZhY2UgbWVzc2FnZXMgKFdlYlNvY2tldCkgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgcmVwbHkgPSAod3M6IGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4sIG1zZzogU2VydmVyTXNnKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkobXNnKSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBnb25lICovXG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGhhbmRsZUNsaWVudE1zZyA9ICh3czogaW1wb3J0KFwiYnVuXCIpLlNlcnZlcldlYlNvY2tldDx1bmtub3duPiwgbXNnOiBDbGllbnRNc2cpID0+IHtcbiAgICBpZiAoaXNTdHJ1Y3R1cmVPcChtc2cpKSB7XG4gICAgICBjb25zdCByID0gc3RydWN0dXJlKGFuY2hvclN1cmZhY2VQYXRocyhtc2cpLCBcImh1bWFuXCIpO1xuICAgICAgaWYgKHR5cGVvZiByLnBhdGggPT09IFwic3RyaW5nXCIpXG4gICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwic3RydWN0dXJlLmRvbmVcIiwgb3A6IG1zZy50eXBlLCBwYXRoOiByLnBhdGggfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHN3aXRjaCAobXNnLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJvcGVuXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ub3BlblBhdGgobXNnLnBhdGgpO1xuICAgICAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgLy8gVGhlIG9wZW5lciBnZXRzIHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgc3RyYWlnaHQgYXdheSDigJQgdGhlIHN0YXRlXG4gICAgICAgIC8vIHNuYXBzaG90IGNhcnJpZXMgbm8gdGV4dHMsIGFuZCBhIHZpZXdlciBtdXN0IG5vdCB3YWl0IG9uIGEgc2Vjb25kIGFzay5cbiAgICAgICAge1xuICAgICAgICAgIGNvbnN0IGQgPSBzZXNzaW9uLmRvYyhyLnNsdWcpO1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgICAgICAgIHRleHQ6IHNlc3Npb24ucmVhZFZlcnNpb24oci5zbHVnLCBkLmFjdGl2ZSkudGV4dCxcbiAgICAgICAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHIuY3JlYXRlZClcbiAgICAgICAgICBsb2cuZW1pdCh7IHR5cGU6IFwiZG9jLm9wZW5lZFwiLCBkb2M6IHIuc2x1ZywgcGF0aDogc2Vzc2lvbi5hY3RpdmVQYXRoKHIuc2x1ZykgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJvcGVuLmRvY1wiOlxuICAgICAgICBzZXNzaW9uLm9wZW5TbHVnKG1zZy5kb2MpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwiZWRpdFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmVkaXQobXNnLmRvYywgbXNnLnZlcnNpb24sIG1zZy50ZXh0KTtcbiAgICAgICAgaWYgKHIucHJlc2VydmVkKSB7XG4gICAgICAgICAgY29uc3QgZCA9IHNlc3Npb24uZG9jKG1zZy5kb2MpO1xuICAgICAgICAgIGFubm91bmNlT3V0c2lkZShcbiAgICAgICAgICAgIGQuc2x1ZyxcbiAgICAgICAgICAgIG1zZy52ZXJzaW9uLFxuICAgICAgICAgICAgc2Vzc2lvbi5hY3RpdmVQYXRoKGQuc2x1ZykgPz8gXCJcIixcbiAgICAgICAgICAgIHIucHJlc2VydmVkLm4sXG4gICAgICAgICAgICByLnByZXNlcnZlZC5wYXRoLFxuICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSBpZiAoci5kaXJ0eUNoYW5nZWQpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzZWFyY2hcIjoge1xuICAgICAgICAvLyDim5QgUkVQTElFRCBUTyBUSEUgQVNLSU5HIFNPQ0tFVCwgTk9UIEJST0FEQ0FTVC4gQSBzZWFyY2ggaXMgb25lXG4gICAgICAgIC8vIHZpZXdlcidzIHF1ZXN0aW9uOyBwdXNoaW5nIHJlc3VsdHMgdG8gZXZlcnkgY2xpZW50IHdvdWxkIHB1dCBzb21lb25lXG4gICAgICAgIC8vIGVsc2UncyBxdWVyeSBpbiB5b3VyIHBhbmUuIChUaGUgc2FtZSByZWFzb24gYGRpZmZgIHJlcGxpZXMgcmF0aGVyXG4gICAgICAgIC8vIHRoYW4gYnJvYWRjYXN0aW5nLilcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcInNlYXJjaC5yZXN1bHRzXCIsIHJlcG9ydDogc2Vzc2lvbi5zZWFyY2hBbGwobXNnKSB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJoaXN0b3J5LnVuZG9cIjoge1xuICAgICAgICBjb25zdCBhY3QgPSBoaXN0b3J5LnBlZWtVbmRvKCk7XG4gICAgICAgIGlmICghYWN0KSByZXR1cm47XG4gICAgICAgIC8vIOKblCBBIERFTEVUSU5HIFVORE8gTkVFRFMgVEhFIEhVTUFOJ1MgV09SRCwgY2FycmllZCBleHBsaWNpdGx5LiBBXG4gICAgICAgIC8vIGNsaWVudCB0aGF0IHNpbXBseSBvbWl0cyB0aGUgZmxhZyBnZXRzIGEgcmVmdXNhbCByYXRoZXIgdGhhbiBhXG4gICAgICAgIC8vIGRlbGV0aW9uLCBzbyBcImZvcmdvdCB0byBjb25maXJtXCIgY2FuIG5ldmVyIGJlY29tZSBcImRlbGV0ZWQgYW55d2F5XCIuXG4gICAgICAgIGlmIChhY3QuaW52ZXJzZS5raW5kID09PSBcImRlbGV0ZVwiICYmIG1zZy5jb25maXJtRGVsZXRlICE9PSB0cnVlKSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwiZXJyb3JcIixcbiAgICAgICAgICAgIG1lc3NhZ2U6IGBVbmRvaW5nIFwiJHthY3QubGFiZWx9XCIgd291bGQgZGVsZXRlICR7c2Vzc2lvbi5kaXNwbGF5KGFjdC5pbnZlcnNlLnBhdGgpfSDigJQgY29uZmlybSBpdCBmaXJzdC5gLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICB0cnkge1xuICAgICAgICAgIGhpc3RvcnkudG9va1VuZG8oYXBwbHlJbnZlcnNlKGFjdC5pbnZlcnNlKSk7XG4gICAgICAgICAgc3luY1dhdGNoZXJzKCk7XG4gICAgICAgICAgYW5ub3VuY2UoYFlvdSB1bmRpZDogJHthY3QubGFiZWx9LmAsIHsgZmFjdDogXCJoaXN0b3J5LnVuZG9cIiB9KTtcbiAgICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgLy8gVGhlIHJlZnVzYWwgdGhlIGh1bWFuIG5lZWRzIHRvIHJlYWQg4oCUIGEgZm9sZGVyIHdpdGggdGhpbmdzIGluIGl0LFxuICAgICAgICAgIC8vIG9yIGEgd29ybGQgdGhhdCBoYXMgbW92ZWQgdW5kZXIgYSByZWNvcmRlZCBpbnZlcnNlLiBUaGUgYWN0IFNUQVlTXG4gICAgICAgICAgLy8gb24gdGhlIHN0YWNrOiBub3RoaW5nIGhhcHBlbmVkLCBzbyBub3RoaW5nIHNob3VsZCBiZSBmb3Jnb3R0ZW4uXG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImhpc3RvcnkucmVkb1wiOiB7XG4gICAgICAgIGNvbnN0IGFjdCA9IGhpc3RvcnkucGVla1JlZG8oKTtcbiAgICAgICAgaWYgKCFhY3QpIHJldHVybjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBoaXN0b3J5LnRvb2tSZWRvKGFwcGx5SW52ZXJzZShhY3QuaW52ZXJzZSkpO1xuICAgICAgICAgIHN5bmNXYXRjaGVycygpO1xuICAgICAgICAgIGFubm91bmNlKGBZb3UgcmVkaWQ6ICR7YWN0LmxhYmVsfS5gLCB7IGZhY3Q6IFwiaGlzdG9yeS5yZWRvXCIgfSk7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzZWxlY3RcIjpcbiAgICAgICAgLy8gQU1CSUVOVCBzdGF0ZTogc3RvcmVkIGFuZCBzaG93biwgbmV2ZXIgcHVzaGVkIG9udG8gdGhlIGFnZW50J3MgdGFpbC5cbiAgICAgICAgc2VsZWN0aW9uID0gbXNnLnNlbGVjdGlvbjtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInNheVwiOiB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBtc2cudGV4dC50cmltKCk7XG4gICAgICAgIGlmICghdGV4dCkgcmV0dXJuO1xuICAgICAgICBjb25zdCBzZWwgPSBtc2cud2l0aFNlbGVjdGlvbiA/IHNlbGVjdGlvbiA6IG51bGw7XG4gICAgICAgIGNvbnN0IGFjdGl2ZVBhdGggPSBzZWwgPyBzZXNzaW9uLmFjdGl2ZVBhdGgoc2VsLmRvYykgOiBzZXNzaW9uLmFjdGl2ZVBhdGgoKTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcImh1bWFuXCIsIHRleHQsIHsgc2VsZWN0aW9uOiBzZWwsIGFjdGl2ZVBhdGggfSk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcIm1lc3NhZ2VcIixcbiAgICAgICAgICBtZXNzYWdlX2lkOiBtLmlkLFxuICAgICAgICAgIHRleHQsXG4gICAgICAgICAgc2VsZWN0aW9uOiBzZWwsXG4gICAgICAgICAgYWN0aXZlOiBhY3RpdmVPZihzZWw/LmRvYyksXG4gICAgICAgICAgdHM6IG0udHMsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiYWN0aXZhdGVcIjpcbiAgICAgICAgYWN0aXZhdGUobXNnLmRvYywgbXNnLnZlcnNpb24sIFwiaHVtYW5cIik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJub3RlLmFkZFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmFkZE5vdGUoe1xuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICBib2R5OiBtc2cuYm9keSxcbiAgICAgICAgICB3aG86IFwiaHVtYW5cIixcbiAgICAgICAgICByYW5nZTogeyBmcm9tOiBtc2cuZnJvbSwgdG86IG1zZy50byB9LFxuICAgICAgICB9KTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcIm5vdGUuYWRkZWRcIiwgZG9jOiByLnNsdWcsIG5vdGU6IHIubm90ZS5pZCwgYnk6IFwiaHVtYW5cIiB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2suZG9uZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmZpbmlzaFRhc2sobXNnLmlkLCBtc2cub3V0Y29tZSk7XG4gICAgICAgIGlmICghci5hbHJlYWR5KSB7XG4gICAgICAgICAgc2Vzc2lvbi5hZGRNZXNzYWdlKFwic3lzdGVtXCIsIGBEb25lOiAke3IudGFzay50ZXh0fWApO1xuICAgICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJ0YXNrLmRvbmVcIiwgdGFzazogci50YXNrLmlkLCBieTogXCJodW1hblwiIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ0YXNrLnJlbW92ZVwiOiB7XG4gICAgICAgIHNlc3Npb24ucmVtb3ZlVGFzayhtc2cuaWQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFza3MuY2xlYXJcIjoge1xuICAgICAgICBzZXNzaW9uLmNsZWFyRG9uZVRhc2tzKCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJub3RlLmVkaXRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5lZGl0Tm90ZSh7IGRvYzogbXNnLmRvYywgaWQ6IG1zZy5pZCwgYm9keTogbXNnLmJvZHkgfSk7XG4gICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJub3RlLmVkaXRlZFwiLCBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCBieTogXCJodW1hblwiIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5yZXNvbHZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVzb2x2ZU5vdGUoeyBkb2M6IG1zZy5kb2MsIGlkOiBtc2cuaWQsIHJlc29sdmVkOiBtc2cucmVzb2x2ZWQgfSk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBtc2cucmVzb2x2ZWQgPyBcIm5vdGUucmVzb2x2ZWRcIiA6IFwibm90ZS5yZW9wZW5lZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIG5vdGU6IHIubm90ZS5pZCxcbiAgICAgICAgICBieTogXCJodW1hblwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUucmVtb3ZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVtb3ZlTm90ZSh7IGRvYzogbXNnLmRvYywgaWQ6IG1zZy5pZCB9KTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcIm5vdGUucmVtb3ZlZFwiLCBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCBieTogXCJodW1hblwiIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwidmVyc2lvbi5kZWxldGVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5kZWxldGVWZXJzaW9uKHsgZG9jOiBtc2cuZG9jLCB2ZXJzaW9uOiBtc2cudmVyc2lvbiB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBEZWxldGVkIHYke3IudmVyc2lvbn0gb2YgJHtyLnNsdWd9JHtyLmxhYmVsID8gYCDigJQgJHtyLmxhYmVsfWAgOiBcIlwifS5gLFxuICAgICAgICApO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLmRlbGV0ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgYnk6IFwiaHVtYW5cIixcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLm5ld1wiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm5ld1ZlcnNpb24oe1xuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICAuLi4obXNnLmZyb20gPT09IHVuZGVmaW5lZCA/IHt9IDogeyBmcm9tOiBtc2cuZnJvbSB9KSxcbiAgICAgICAgICAuLi4obXNnLmxhYmVsID8geyBsYWJlbDogbXNnLmxhYmVsIH0gOiB7fSksXG4gICAgICAgICAgYXV0aG9yOiBcImh1bWFuXCIsXG4gICAgICAgIH0pO1xuICAgICAgICAvLyDim5QgU0FZIFdIRVJFIFRIRVkgQVJFLCBub3QganVzdCB3aGF0IHdhcyBtYWRlIChFNDIpLiBUaGUgb2xkIG1lc3NhZ2VcbiAgICAgICAgLy8gYW5ub3VuY2VkIHRoZSBuZXcgdmVyc2lvbiBhbmQgd2VudCBxdWlldCBhYm91dCB3aGljaCBvbmUgdGhlIGh1bWFuXG4gICAgICAgIC8vIHdhcyBlZGl0aW5nIOKAlCB3aGljaCBpcyBleGFjdGx5IGhvdyBzb21lb25lIHR5cGVzIGludG8gdjEgYmVsaWV2aW5nXG4gICAgICAgIC8vIHRoZXkgYXJlIGluIHYyLlxuICAgICAgICBpZiAobXNnLmFjdGl2YXRlKSBzZXNzaW9uLmFjdGl2YXRlKHsgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbi5uIH0pO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgICAgIFwic3lzdGVtXCIsXG4gICAgICAgICAgYE1hZGUgdiR7ci52ZXJzaW9uLm59IG9mICR7ci5zbHVnfSBmcm9tIHYke3IudmVyc2lvbi5mcm9tfSR7bXNnLmxhYmVsID8gYCDigJQgJHttc2cubGFiZWx9YCA6IFwiXCJ9LiBgICtcbiAgICAgICAgICAgIChtc2cuYWN0aXZhdGVcbiAgICAgICAgICAgICAgPyBgWW91IGFyZSBub3cgZWRpdGluZyB2JHtyLnZlcnNpb24ubn0uYFxuICAgICAgICAgICAgICA6IGBZb3UgYXJlIHN0aWxsIGVkaXRpbmcgdiR7ci52ZXJzaW9uLmZyb219LmApLFxuICAgICAgICApO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLmNyZWF0ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24ubixcbiAgICAgICAgICBmcm9tOiByLnZlcnNpb24uZnJvbSxcbiAgICAgICAgICBhY3RpdmF0ZWQ6IG1zZy5hY3RpdmF0ZSA9PT0gdHJ1ZSxcbiAgICAgICAgICBieTogXCJodW1hblwiLFxuICAgICAgICAgIHRzOiBtLnRzLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInNhdmVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5zYXZlKG1zZy5kb2MpO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwic3lzdGVtXCIsIGBTYXZlZCB2JHtyLnZlcnNpb259IHRvICR7ci5vcmlnaW5hbH0uYCk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcInNhdmVkXCIsXG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICBvcmlnaW5hbDogci5vcmlnaW5hbCxcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJyZXZlcnRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXZlcnQobXNnLmRvYyk7XG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiByLnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBSZXZlcnRlZCB2JHtyLnZlcnNpb259IG9mICR7bXNnLmRvY30gdG8gdGhlIHNhdmVkIGZpbGUuYCxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcInJldmVydGVkXCIsIGRvYzogbXNnLmRvYywgdmVyc2lvbjogci52ZXJzaW9uLCB0czogbS50cyB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImNvbnRleHQuYWRkXCI6XG4gICAgICAgIGFkZFBhdGhzKFtzdXJmYWNlUGF0aChtc2cucGF0aCldKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInJldmVhbFwiOlxuICAgICAgICByZXZlYWxQYXRoKHNlc3Npb24uc2hvd25QYXRoKHN1cmZhY2VQYXRoKG1zZy5wYXRoKSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwicmV2ZWFsLnZlcnNpb25cIjpcbiAgICAgICAgLy8gVGhlIGRhZW1vbiByZXNvbHZlcyBpdCwgc28gdGhlIHN1cmZhY2UgbmV2ZXIgbmFtZXMgYSBwYXRoIG91dHNpZGVcbiAgICAgICAgLy8gd2hhdCB0aGUgc2Vzc2lvbiBhbHJlYWR5IG93bnMuXG4gICAgICAgIHJldmVhbFBhdGgoc2Vzc2lvbi5yZWFkVmVyc2lvbihtc2cuZG9jLCBtc2cudmVyc2lvbikucGF0aCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJwaWNrXCI6IHtcbiAgICAgICAgdm9pZCBvcGVuUGlja2VyKHdzLCBtc2cud2FudCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJjb250ZXh0LnJlbW92ZVwiOlxuICAgICAgICBzZXNzaW9uLnJlbW92ZUNvbnRleHQobXNnLmlkKTtcbiAgICAgICAgc3luY1dhdGNoZXJzKCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJyZWFkXCI6IHtcbiAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBtc2cudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKG1zZy5kb2MsIG1zZy52ZXJzaW9uKS50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiZGlmZlwiOiB7XG4gICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZGlmZlwiLCAuLi5zZXNzaW9uLmNvbXBhcmUoeyBkb2M6IG1zZy5kb2MsIGFnYWluc3Q6IG1zZy5hZ2FpbnN0IH0pIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibWVyZ2VcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5tZXJnZSh7IGRvYzogbXNnLmRvYywgYWdhaW5zdDogbXNnLmFnYWluc3QsIGh1bmtzOiBtc2cuaHVua3MgfSk7XG4gICAgICAgIC8vIFRoZSBidWZmZXIgdGhlIGh1bWFuIGlzIGxvb2tpbmcgYXQgbXVzdCBiZSB0b2xkOiB0aGUgbWVyZ2Ugd3JvdGUgdGhlXG4gICAgICAgIC8vIGFjdGl2ZSB2ZXJzaW9uJ3MgRklMRSwgYW5kIHRoZSBlZGl0b3IncyB0ZXh0IGlzIG5vdyBiZWhpbmQgaXQuXG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IHIudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgICAgIFwic3lzdGVtXCIsXG4gICAgICAgICAgYFRvb2sgJHtyLmFwcGxpZWR9IGNoYW5nZSR7ci5hcHBsaWVkID09PSAxID8gXCJcIiA6IFwic1wifSBmcm9tICR7c2lkZU5hbWUobXNnLmFnYWluc3QsIHNlc3Npb24uZG9jKHIuc2x1ZykubmFtZSl9IGludG8gdiR7ci52ZXJzaW9ufSBvZiAke3Iuc2x1Z30uYCxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgIHR5cGU6IFwibWVyZ2VkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIGFnYWluc3Q6IG1zZy5hZ2FpbnN0LFxuICAgICAgICAgIGh1bmtzOiBtc2cuaHVua3MsXG4gICAgICAgICAgYnk6IFwiaHVtYW5cIixcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJwcmVmcy5zZXRcIjoge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgIVBSRUZfS0VZLnRlc3QobXNnLmtleSkgfHxcbiAgICAgICAgICB0eXBlb2YgbXNnLnZhbHVlICE9PSBcInN0cmluZ1wiIHx8XG4gICAgICAgICAgbXNnLnZhbHVlLmxlbmd0aCA+IFBSRUZfVkFMVUVfTUFYXG4gICAgICAgIClcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYHJlZnVzZWQgcHJlZiAke0pTT04uc3RyaW5naWZ5KG1zZy5rZXkpfWApO1xuICAgICAgICBjb25zdCBjdXJyZW50ID0gcmVhZFByZWZzKCk7XG4gICAgICAgIGlmIChjdXJyZW50W21zZy5rZXldID09PSBtc2cudmFsdWUpIHJldHVybjtcbiAgICAgICAgaWYgKCEobXNnLmtleSBpbiBjdXJyZW50KSAmJiBPYmplY3Qua2V5cyhjdXJyZW50KS5sZW5ndGggPj0gUFJFRl9LRVlTX01BWClcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgcmVmdXNlZCBwcmVmICR7SlNPTi5zdHJpbmdpZnkobXNnLmtleSl9OiAke1BSRUZfS0VZU19NQVh9IGtleXMgYWxyZWFkeSBrZXB0YCxcbiAgICAgICAgICApO1xuICAgICAgICB3cml0ZUZpbGVBdG9taWMoXG4gICAgICAgICAgcHJlZnNGaWxlLFxuICAgICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgLi4uY3VycmVudCwgW21zZy5rZXldOiBtc2cudmFsdWUgfSwgbnVsbCwgMil9XFxuYCxcbiAgICAgICAgKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImdyYXBoXCI6IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImdyYXBoXCIsIGVudHJ5OiBtc2cuZW50cnksIGdyYXBoOiBzZXNzaW9uLmdyYXBoRm9yKG1zZy5lbnRyeSkgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJncmFwaFwiLFxuICAgICAgICAgICAgZW50cnk6IG1zZy5lbnRyeSxcbiAgICAgICAgICAgIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImxpbmsub3BlblwiOiB7XG4gICAgICAgIC8vIEUzMzogYSBsaW5rIGluc2lkZSB0aGUgYnVuZGxlIGlzIEZPTExPV0VEOyBvbmUgdGhhdCBlc2NhcGVzIGl0IGlzXG4gICAgICAgIC8vIHJlcG9ydGVkIHNvIHRoZSBzdXJmYWNlIGNhbiBvZmZlciB0byBhZGQgaXQsIG5ldmVyIGFkZGVkIHNpbGVudGx5LlxuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXNvbHZlTGluayhtc2cuZnJvbSwgbXNnLnRhcmdldCk7XG4gICAgICAgIGlmIChyLnN0YXRlID09PSBcImluLWJ1bmRsZVwiKSB7XG4gICAgICAgICAgc2Vzc2lvbi5vcGVuUGF0aChyLnBhdGgpO1xuICAgICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgICAgY29uc3QgZCA9IHNlc3Npb24uZG9jKHNlc3Npb24ub3BlbkRvY1NsdWcgPz8gXCJcIik7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgICBkb2M6IGQuc2x1ZyxcbiAgICAgICAgICAgIHZlcnNpb246IGQuYWN0aXZlLFxuICAgICAgICAgICAgdGV4dDogc2Vzc2lvbi5yZWFkVmVyc2lvbihkLnNsdWcsIGQuYWN0aXZlKS50ZXh0LFxuICAgICAgICAgICAgb3JpZ2luOiBcImxvYWRcIixcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgIHR5cGU6IFwibGluay50YXJnZXRcIixcbiAgICAgICAgICB0YXJnZXQ6IG1zZy50YXJnZXQsXG4gICAgICAgICAgc3RhdGU6IHIuc3RhdGUsXG4gICAgICAgICAgLi4uKHIuc3RhdGUgPT09IFwibWlzc2luZ1wiID8ge30gOiB7IHBhdGg6IHIucGF0aCB9KSxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJtZXRhLnN1Z2dlc3RcIjoge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnN1Z2dlc3RNZXRhKG1zZy5wYXRoLCBcImh1bWFuXCIpO1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcIm1ldGEuc3VnZ2VzdGlvblwiLFxuICAgICAgICAgICAgcGF0aDogbXNnLnBhdGgsXG4gICAgICAgICAgICBibG9jazogci5ibG9jayxcbiAgICAgICAgICAgIC4uLihyLnR5cGUgPyB7IHN1Z2dlc3RlZFR5cGU6IHIudHlwZSB9IDoge30pLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwibWV0YS5zdWdnZXN0aW9uXCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1vdmUucGxhblwiOiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwibW92ZS5wbGFuXCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGludG86IG1zZy5pbnRvLFxuICAgICAgICAgICAgcGxhbjogc2Vzc2lvbi5tb3ZlUGxhbihzdXJmYWNlUGF0aChtc2cucGF0aCksIHN1cmZhY2VQYXRoKG1zZy5pbnRvKSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJtb3ZlLnBsYW5cIixcbiAgICAgICAgICAgIHBhdGg6IG1zZy5wYXRoLFxuICAgICAgICAgICAgaW50bzogbXNnLmludG8sXG4gICAgICAgICAgICBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmcy5saXN0XCI6IHtcbiAgICAgICAgY29uc3QgcGF0aCA9IGV4cGFuZEhvbWUobXNnLnBhdGgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZnMubGlzdFwiLCBwYXRoOiBtc2cucGF0aCwgZW50cmllczogbGlzdERpcihwYXRoKSB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcImZzLmxpc3RcIixcbiAgICAgICAgICAgIHBhdGg6IG1zZy5wYXRoLFxuICAgICAgICAgICAgZW50cmllczogW10sXG4gICAgICAgICAgICBlcnJvcjogU3RyaW5nKChlIGFzIEVycm9yKS5tZXNzYWdlKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIC8vIOKUgOKUgCB0aGUgbmF0aXZlIHBpY2tlciAob25lIGRpYWxvZyBhdCBhIHRpbWUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvL1xuICAvLyBBIG1vZGFsIGRpYWxvZyBvd25zIHRoZSBodW1hbidzIGF0dGVudGlvbiwgYW5kIGEgc2Vjb25kIG9uZSBiZWhpbmQgdGhlXG4gIC8vIGZpcnN0IGNhbm5vdCBiZSBzZWVuIG9yIGRpc21pc3NlZCDigJQgc28gYSByZXF1ZXN0IHdoaWxlIG9uZSBpcyBvcGVuIGlzXG4gIC8vIHJlZnVzZWQgaW4gd29yZHMgcmF0aGVyIHRoYW4gcXVldWVkLlxuICBsZXQgcGlja2VyT3BlbiA9IGZhbHNlO1xuICBjb25zdCB6ZW5pdHkgPSBwcm9jZXNzLnBsYXRmb3JtID09PSBcImxpbnV4XCIgPyBCdW4ud2hpY2goXCJ6ZW5pdHlcIikgOiBudWxsO1xuICBjb25zdCBvcGVuUGlja2VyID0gYXN5bmMgKFxuICAgIHdzOiBpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+LFxuICAgIHdhbnQ6IFwiY29udGV4dC1maWxlXCIgfCBcImNvbnRleHQtZm9sZGVyXCIgfCBcIndvcmtzcGFjZVwiLFxuICApID0+IHtcbiAgICBpZiAocGlja2VyT3Blbikge1xuICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBcImEgZmlsZSBwaWNrZXIgaXMgYWxyZWFkeSBvcGVuXCIgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGtpbmQ6IFBpY2tLaW5kID0gd2FudCA9PT0gXCJjb250ZXh0LWZpbGVcIiA/IFwiZmlsZVwiIDogXCJmb2xkZXJcIjtcbiAgICBjb25zdCBwcm9tcHQgPVxuICAgICAgd2FudCA9PT0gXCJ3b3Jrc3BhY2VcIlxuICAgICAgICA/IFwiQ2hvb3NlIHRoZSB3b3Jrc3BhY2UgZm9sZGVyIGZvciBzY3JpcHRvcml1bVwiXG4gICAgICAgIDogd2FudCA9PT0gXCJjb250ZXh0LWZvbGRlclwiXG4gICAgICAgICAgPyBcIkNob29zZSBhIGZvbGRlciB0byBhZGQgdG8gc2NyaXB0b3JpdW1cIlxuICAgICAgICAgIDogXCJDaG9vc2UgZG9jdW1lbnRzIHRvIGFkZCB0byBzY3JpcHRvcml1bVwiO1xuICAgIGNvbnN0IGNtZCA9IHBpY2tlckNvbW1hbmQocHJvY2Vzcy5wbGF0Zm9ybSwga2luZCwgcHJvbXB0LCB6ZW5pdHkpO1xuICAgIGlmICghY21kKSB7XG4gICAgICByZXBseSh3cywge1xuICAgICAgICB0eXBlOiBcImVycm9yXCIsXG4gICAgICAgIG1lc3NhZ2U6IGBubyBmaWxlIHBpY2tlciBvbiB0aGlzIHN5c3RlbSAoJHtwcm9jZXNzLnBsYXRmb3JtfSkg4oCUIHR5cGUgdGhlIHBhdGggaW5zdGVhZGAsXG4gICAgICB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgcGlja2VyT3BlbiA9IHRydWU7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHByb2MgPSBCdW4uc3Bhd24oY21kLCB7IHN0ZG91dDogXCJwaXBlXCIsIHN0ZGVycjogXCJwaXBlXCIsIHN0ZGluOiBcImlnbm9yZVwiIH0pO1xuICAgICAgY29uc3QgW291dCwgY29kZV0gPSBhd2FpdCBQcm9taXNlLmFsbChbbmV3IFJlc3BvbnNlKHByb2Muc3Rkb3V0KS50ZXh0KCksIHByb2MuZXhpdGVkXSk7XG4gICAgICB0b3VjaCgpOyAvLyBhIGh1bWFuIHN0b29kIGF0IGEgZGlhbG9nOyB0aGUgc2Vzc2lvbiBpcyBub3QgaWRsZVxuICAgICAgY29uc3QgcGF0aHMgPSBwYXJzZVBpY2tlck91dHB1dChvdXQpO1xuICAgICAgaWYgKHBhdGhzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAvLyBDYW5jZWxsZWQ6IG5vdGhpbmcgY2hvc2VuLCBub3RoaW5nIHNhaWQuIEEgcmVhbCBmYWlsdXJlIGlzIHNhaWQuXG4gICAgICAgIGlmICghd2FzQ2FuY2VsbGVkKGNvZGUsIG91dCkpXG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBgdGhlIGZpbGUgcGlja2VyIGZhaWxlZCAoZXhpdCAke2NvZGV9KWAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIFdoYXQgd2FzIGNob3NlbiBpcyBhZG1pdHRlZCBsaWtlIGFueSBvdGhlciBwYXRoIOKAlCBhIHBpY2tlZCBmaWxlIHRoYXRcbiAgICAgIC8vIHNjcmlwdG9yaXVtIGRvZXMgbm90IG9wZW4gaXMgcmVmdXNlZCBpbiB0aGUgc2lkZWJhcidzIG93biB3b3JkcywgYW5kXG4gICAgICAvLyB0aGF0IHJlZnVzYWwgbXVzdCBub3QgcmVhZCBhcyBcInRoZSBwaWNrZXIgZmFpbGVkXCIuXG4gICAgICB0cnkge1xuICAgICAgICBpZiAod2FudCA9PT0gXCJ3b3Jrc3BhY2VcIilcbiAgICAgICAgICBzdHJ1Y3R1cmUoeyB0eXBlOiBcIndvcmtzcGFjZS5zZXRcIiwgcGF0aDogcGF0aHNbMF0gYXMgc3RyaW5nIH0sIFwiaHVtYW5cIik7XG4gICAgICAgIGVsc2UgYWRkUGF0aHMocGF0aHMpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICByZXBseSh3cywge1xuICAgICAgICB0eXBlOiBcImVycm9yXCIsXG4gICAgICAgIG1lc3NhZ2U6IGBjb3VsZCBub3Qgb3BlbiB0aGUgZmlsZSBwaWNrZXI6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfWAsXG4gICAgICB9KTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcGlja2VyT3BlbiA9IGZhbHNlO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBhY3RpdmVPZiA9IChkb2M/OiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCBzbHVnID0gZG9jID8/IHNlc3Npb24ub3BlbkRvY1NsdWc7XG4gICAgaWYgKCFzbHVnKSByZXR1cm4gbnVsbDtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdiA9IHNlc3Npb24uZG9jKHNsdWcpO1xuICAgICAgcmV0dXJuIHsgZG9jOiB2LnNsdWcsIHZlcnNpb246IHYuYWN0aXZlLCBwYXRoOiBzZXNzaW9uLmFjdGl2ZVBhdGgodi5zbHVnKSB9O1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9O1xuXG4gIC8vIC0tLSBhZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGxldCByZXNvbHZlRG9uZSE6ICh2OiB7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmcgfSkgPT4gdm9pZDtcbiAgY29uc3QgZG9uZSA9IG5ldyBQcm9taXNlPHsgY29kZTogbnVtYmVyOyByZWFzb246IHN0cmluZyB9PigocikgPT4ge1xuICAgIHJlc29sdmVEb25lID0gcjtcbiAgfSk7XG5cbiAgLyoqIFNob3cgYSBmaWxlIGluIHRoZSBwbGF0Zm9ybSdzIGZpbGUgbWFuYWdlci4gQW4gYXJndiwgbmV2ZXIgYSBzaGVsbCBzdHJpbmc6XG4gICAqICB0aGUgcGF0aCBpcyBkYXRhLCB3aGF0ZXZlciBpdCBob2xkcy4gKi9cbiAgY29uc3QgcmV2ZWFsUGF0aCA9IChwYXRoOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICBjb25zdCBbY21kLCAuLi5hcmdzXSA9XG4gICAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiXG4gICAgICAgID8gW1wib3BlblwiLCBcIi1SXCIsIHBhdGhdXG4gICAgICAgIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiXG4gICAgICAgICAgPyBbXCJleHBsb3JlclwiLCBgL3NlbGVjdCwke3BhdGh9YF1cbiAgICAgICAgICA6IFtcInhkZy1vcGVuXCIsIGRpcm5hbWUocGF0aCldO1xuICAgIEJ1bi5zcGF3bihbY21kIGFzIHN0cmluZywgLi4uYXJnc10sIHsgc3RkaW86IFtcImlnbm9yZVwiLCBcImlnbm9yZVwiLCBcImlnbm9yZVwiXSB9KS51bnJlZigpO1xuICB9O1xuXG4gIGNvbnN0IGhhbmRsZUFnZW50Q21kID0gKGNtZDogQWdlbnRDbWQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiB7XG4gICAgaWYgKGlzU3RydWN0dXJlT3AoY21kKSkgcmV0dXJuIHN0cnVjdHVyZShjbWQsIFwiYWdlbnRcIik7XG4gICAgc3dpdGNoIChjbWQudHlwZSkge1xuICAgICAgY2FzZSBcIm1ldGFcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24ubWV0YUZvcihjbWQucGF0aCk7XG4gICAgICBjYXNlIFwiZ3JhcGhcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24uZ3JhcGhGb3IoY21kLmVudHJ5KSBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgY2FzZSBcImRhbmdsaW5nXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLmRhbmdsaW5nTGlua3MoY21kLmVudHJ5KTtcbiAgICAgIGNhc2UgXCJzZWFyY2hcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24uc2VhcmNoQWxsKGNtZCkgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGNhc2UgXCJiYWNrbGlua3NcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24uYmFja2xpbmtzKGNtZC5wYXRoKTtcbiAgICAgIGNhc2UgXCJtZXRhLmluaXRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5tZXRhSW5pdChjbWQucGF0aCwge1xuICAgICAgICAgIC4uLihjbWQubWV0YVR5cGUgPyB7IHR5cGU6IGNtZC5tZXRhVHlwZSB9IDoge30pLFxuICAgICAgICAgIGJ5OiBjbWQuYnkgPz8gXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoYEFnZW50IGFkZGVkIGZyb250bWF0dGVyIHRvICR7c2Vzc2lvbi5kaXNwbGF5KFN0cmluZyhyLnBhdGgpKX0uYCwge1xuICAgICAgICAgIGZhY3Q6IFwibWV0YS5pbml0XCIsXG4gICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgICAuLi5yLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHI7XG4gICAgICB9XG4gICAgICBjYXNlIFwibWV0YS5zZXRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5tZXRhU2V0KGNtZC5wYXRoLCBjbWQuZmllbGRzKTtcbiAgICAgICAgYW5ub3VuY2UoXG4gICAgICAgICAgYEFnZW50IHNldCAkeyhyLnNldCBhcyBzdHJpbmdbXSkuam9pbihcIiwgXCIpfSBvbiAke3Nlc3Npb24uZGlzcGxheShTdHJpbmcoci5wYXRoKSl9LmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm1ldGEuc2V0XCIsIGJ5OiBcImFnZW50XCIsIC4uLnIgfSxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIHI7XG4gICAgICB9XG4gICAgICBjYXNlIFwidmVyc2lvbi5kZWxldGVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5kZWxldGVWZXJzaW9uKHsgZG9jOiBjbWQuZG9jLCB2ZXJzaW9uOiBjbWQudmVyc2lvbiB9KTtcbiAgICAgICAgYW5ub3VuY2UoYEFnZW50IGRlbGV0ZWQgdiR7ci52ZXJzaW9ufSBvZiAke3Iuc2x1Z30ke3IubGFiZWwgPyBgIOKAlCAke3IubGFiZWx9YCA6IFwiXCJ9LmAsIHtcbiAgICAgICAgICBmYWN0OiBcInZlcnNpb24uZGVsZXRlZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbiwgcmVtYWluaW5nOiByLnJlbWFpbmluZyB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUuYWRkXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uYWRkTm90ZSh7XG4gICAgICAgICAgZG9jOiBjbWQuZG9jLFxuICAgICAgICAgIGJvZHk6IGNtZC5ib2R5LFxuICAgICAgICAgIHdobzogXCJhZ2VudFwiLFxuICAgICAgICAgIHF1b3RlOiBjbWQucXVvdGUsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShgQWdlbnQgbm90ZWQg4oCcJHtxdW90ZUxhYmVsKHIubm90ZS5xdW90ZSl94oCdIG9uICR7ci5zbHVnfS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJub3RlLmFkZGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgbm90ZTogci5ub3RlLmlkLFxuICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCBxdW90ZTogci5ub3RlLnF1b3RlIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZXNcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5ub3Rlc09mKHsgZG9jOiBjbWQuZG9jLCAuLi4oY21kLmFsbCA/IHsgYWxsOiB0cnVlIH0gOiB7fSkgfSk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCBub3Rlczogci5ub3RlcyB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2sucmVtb3ZlXCI6IHtcbiAgICAgICAgY29uc3QgdCA9IHNlc3Npb24ucmVtb3ZlVGFzayhjbWQuaWQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyB0YXNrOiB0LmlkLCByZW1vdmVkOiB0cnVlIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFza3MuY2xlYXJcIjoge1xuICAgICAgICBjb25zdCBjbGVhcmVkID0gc2Vzc2lvbi5jbGVhckRvbmVUYXNrcygpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyBjbGVhcmVkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwid29ya2luZ1wiOiB7XG4gICAgICAgIC8vIEU1MydzIHNub296ZS4gSXQgZG9lcyBOT1QgcG9zdCB0byB0aGUgY2hhdDogYW4gYWdlbnQgc2F5aW5nIFwic3RpbGxcbiAgICAgICAgLy8gd29ya2luZ1wiIGluIHRoZSBjb252ZXJzYXRpb24gaXMgYSByZXBseSwgYW5kIGl0IGNhbiBkbyB0aGF0IHdpdGhcbiAgICAgICAgLy8gYHNheWAg4oCUIHRoaXMgaXMgdGhlIHF1aWV0ZXIgdGhpbmcsIGZvciB3aGVuIHRoZXJlIGlzIG5vdGhpbmcgdG9cbiAgICAgICAgLy8gcmVwb3J0IHlldCBidXQgdGhlIGFsYXJtIHNob3VsZCBzdG9wLlxuICAgICAgICBjb25zdCBtcyA9IGNtZC5zZWNvbmRzICE9PSB1bmRlZmluZWQgPyBjbWQuc2Vjb25kcyAqIDEwMDAgOiBERUZBVUxUX1NOT09aRV9NUztcbiAgICAgICAgYWNrbm93bGVkZ2VkVW50aWwgPSBEYXRlLm5vdygpICsgTWF0aC5tYXgoMCwgbXMpO1xuICAgICAgICAvLyBXaGF0ZXZlciBpcyBwZW5kaW5nIGlzIGFja25vd2xlZGdlZCwgc28gaXQgbXVzdCBuZXZlciBiZSBudWRnZWQgYWdhaW4uXG4gICAgICAgIGNvbnN0IHcgPSB3YWl0aW5nT24oc2Vzc2lvbi5tZXNzYWdlcygpLCBEYXRlLm5vdygpLCB7IGFja25vd2xlZGdlZFVudGlsIH0pO1xuICAgICAgICBpZiAodykgbnVkZ2VkLmFkZCh3Lm1lc3NhZ2VJZCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgdW50aWw6IGFja25vd2xlZGdlZFVudGlsLFxuICAgICAgICAgIHNlY29uZHM6IE1hdGgucm91bmQoTWF0aC5tYXgoMCwgbXMpIC8gMTAwMCksXG4gICAgICAgICAgLi4uKHcgPyB7IHdhaXRpbmc6IHcubWVzc2FnZUlkIH0gOiB7fSksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFzay5zdGFydFwiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBzZXNzaW9uLnN0YXJ0VGFzayhjbWQudGV4dCwgXCJhZ2VudFwiKTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcInRhc2suc3RhcnRlZFwiLCB0YXNrOiB0LmlkLCB0ZXh0OiB0LnRleHQsIGJ5OiBcImFnZW50XCIgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiB7IHRhc2s6IHQuaWQsIHRleHQ6IHQudGV4dCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2suc3RhdHVzXCI6IHtcbiAgICAgICAgY29uc3QgdCA9IHNlc3Npb24uc2V0VGFza1N0YXR1cyhjbWQuaWQsIGNtZC5zdGF0dXMpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyB0YXNrOiB0LmlkLCBzdGF0dXM6IHQuc3RhdHVzIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFzay5kb25lXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZmluaXNoVGFzayhjbWQuaWQsIGNtZC5vdXRjb21lKTtcbiAgICAgICAgaWYgKCFyLmFscmVhZHkpXG4gICAgICAgICAgYW5ub3VuY2UoYERvbmU6ICR7ci50YXNrLnRleHR9JHtyLnRhc2sub3V0Y29tZSA/IGAg4oCUICR7ci50YXNrLm91dGNvbWV9YCA6IFwiXCJ9YCwge1xuICAgICAgICAgICAgZmFjdDogXCJ0YXNrLmRvbmVcIixcbiAgICAgICAgICAgIHRhc2s6IHIudGFzay5pZCxcbiAgICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiB7IHRhc2s6IHIudGFzay5pZCwgYWxyZWFkeTogci5hbHJlYWR5IH07XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5lZGl0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZWRpdE5vdGUoeyBkb2M6IGNtZC5kb2MsIGlkOiBjbWQuaWQsIGJvZHk6IGNtZC5ib2R5IH0pO1xuICAgICAgICBhbm5vdW5jZShgQWdlbnQgcmV3cm90ZSBhIG5vdGUgb24gJHtyLnNsdWd9OiDigJwke3F1b3RlTGFiZWwoci5ub3RlLnF1b3RlKX3igJ0uYCwge1xuICAgICAgICAgIGZhY3Q6IFwibm90ZS5lZGl0ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICBub3RlOiByLm5vdGUuaWQsXG4gICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCBub3RlOiByLm5vdGUuaWQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJub3RlLnJlc29sdmVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXNvbHZlTm90ZSh7IGRvYzogY21kLmRvYywgaWQ6IGNtZC5pZCwgcmVzb2x2ZWQ6IGNtZC5yZXNvbHZlZCB9KTtcbiAgICAgICAgYW5ub3VuY2UoXG4gICAgICAgICAgYEFnZW50ICR7Y21kLnJlc29sdmVkID8gXCJyZXNvbHZlZFwiIDogXCJyZW9wZW5lZFwifSBhIG5vdGUgb24gJHtyLnNsdWd9OiDigJwke3F1b3RlTGFiZWwoci5ub3RlLnF1b3RlKX3igJ0uYCxcbiAgICAgICAgICB7IGZhY3Q6IFwibm90ZS5yZXNvbHZlZFwiLCBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCBieTogXCJhZ2VudFwiIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCBub3RlOiByLm5vdGUuaWQsIHJlc29sdmVkOiByLm5vdGUucmVzb2x2ZWQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJub3RlLnJlbW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlbW92ZU5vdGUoeyBkb2M6IGNtZC5kb2MsIGlkOiBjbWQuaWQgfSk7XG4gICAgICAgIGFubm91bmNlKGBBZ2VudCByZW1vdmVkIGEgbm90ZSBvbiAke3Iuc2x1Z306IOKAnCR7cXVvdGVMYWJlbChyLm5vdGUucXVvdGUpfeKAnS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJub3RlLnJlbW92ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICBub3RlOiByLm5vdGUuaWQsXG4gICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCBub3RlOiByLm5vdGUuaWQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJkaWZmXCI6IHtcbiAgICAgICAgY29uc3QgcCA9IHNlc3Npb24uY29tcGFyZSh7IGRvYzogY21kLmRvYywgYWdhaW5zdDogY21kLmFnYWluc3QgfSk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgZG9jOiBwLmRvYyxcbiAgICAgICAgICBhY3RpdmU6IHAuYWN0aXZlLFxuICAgICAgICAgIGFnYWluc3Q6IHAuYWdhaW5zdCxcbiAgICAgICAgICBzYW1lOiBwLmRpZmYuc2FtZSxcbiAgICAgICAgICBjb2Fyc2U6IHAuZGlmZi5jb2Fyc2UsXG4gICAgICAgICAgaHVua3M6IHAuZGlmZi5odW5rcyxcbiAgICAgICAgICB1bmlmaWVkOiB1bmlmaWVkKHAuZGlmZiwge1xuICAgICAgICAgICAgZnJvbTogYHYke3AuYWN0aXZlfWAsXG4gICAgICAgICAgICB0bzogc2lkZU5hbWUocC5hZ2FpbnN0LCBzZXNzaW9uLmRvYyhwLmRvYykubmFtZSksXG4gICAgICAgICAgICAuLi4oY21kLmNvbnRleHQgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBjb250ZXh0OiBjbWQuY29udGV4dCB9KSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJtZXJnZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm1lcmdlKHsgZG9jOiBjbWQuZG9jLCBhZ2FpbnN0OiBjbWQuYWdhaW5zdCwgaHVua3M6IGNtZC5odW5rcyB9KTtcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogci50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJyZW1vdGVcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCB0b29rICR7ci5hcHBsaWVkfSBjaGFuZ2Uke3IuYXBwbGllZCA9PT0gMSA/IFwiXCIgOiBcInNcIn0gZnJvbSAke3NpZGVOYW1lKGNtZC5hZ2FpbnN0LCBzZXNzaW9uLmRvYyhyLnNsdWcpLm5hbWUpfSBpbnRvIHYke3IudmVyc2lvbn0gb2YgJHtyLnNsdWd9LmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm1lcmdlZFwiLCBkb2M6IHIuc2x1ZywgdmVyc2lvbjogci52ZXJzaW9uLCBodW5rczogY21kLmh1bmtzLCBieTogXCJhZ2VudFwiIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24sIGFwcGxpZWQ6IHIuYXBwbGllZCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImZpbmRcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24uZmluZChjbWQuZmlsdGVyKTtcbiAgICAgIGNhc2UgXCJjb250ZXh0LmFkZFwiOiB7XG4gICAgICAgIGNvbnN0IGFkZGVkID0gYWRkUGF0aHMoY21kLnBhdGhzKTtcbiAgICAgICAgcmV0dXJuIHsgZW50cmllczogYWRkZWQubWFwKChhKSA9PiAoeyAuLi5hLmVudHJ5LCBhZGRlZDogYS5hZGRlZCB9KSkgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLm5ld1wiOiB7XG4gICAgICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggNzogdGhlIGFnZW50IG1heSBuYW1lIGEgZG9jIHRoZSBodW1hbiBoYXMgbm90XG4gICAgICAgIC8vIG9wZW5lZCwgYnkgQUJTT0xVVEUgcGF0aCAodGhlIENMSSByZXNvbHZlcyBpdCBhZ2FpbnN0IGl0cyBvd24gY3dkKTtcbiAgICAgICAgLy8gaXQgaXMgb3BlbmVkIGltcGxpY2l0bHkgdW5kZXIgdGhlIHNhbWUgYWRtaXNzaW9uIHJ1bGUgYXMgdGhlXG4gICAgICAgIC8vIHN1cmZhY2UncyBgb3BlbmAg4oCUIGEgZG9jLXR5cGUgZmlsZSBpbnNpZGUgYSBjb250ZXh0IGVudHJ5IOKAlCB3aXRob3V0XG4gICAgICAgIC8vIG1vdmluZyB0aGUgaHVtYW4ncyBvcGVuIGRvY3VtZW50LlxuICAgICAgICBpZiAoY21kLmRvYyAmJiBpc0Fic29sdXRlKGNtZC5kb2MpICYmICFzZXNzaW9uLmZpbmREb2MoY21kLmRvYykpIHtcbiAgICAgICAgICBjb25zdCBvID0gc2Vzc2lvbi5vcGVuUGF0aChjbWQuZG9jLCB7IGZvY3VzOiBmYWxzZSB9KTtcbiAgICAgICAgICBpZiAoby5jcmVhdGVkKVxuICAgICAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgICAgICB0eXBlOiBcImRvYy5vcGVuZWRcIixcbiAgICAgICAgICAgICAgZG9jOiBvLnNsdWcsXG4gICAgICAgICAgICAgIHBhdGg6IHNlc3Npb24uYWN0aXZlUGF0aChvLnNsdWcpLFxuICAgICAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubmV3VmVyc2lvbih7XG4gICAgICAgICAgZG9jOiBjbWQuZG9jLFxuICAgICAgICAgIGZyb206IGNtZC5mcm9tLFxuICAgICAgICAgIGxhYmVsOiBjbWQubGFiZWwsXG4gICAgICAgICAgYXV0aG9yOiBcImFnZW50XCIsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShcbiAgICAgICAgICBgQWdlbnQgY3JlYXRlZCB2JHtyLnZlcnNpb24ubn0gb2YgJHtyLnNsdWd9IGZyb20gdiR7ci52ZXJzaW9uLmZyb219JHtjbWQubGFiZWwgPyBgIOKAlCAke2NtZC5sYWJlbH1gIDogXCJcIn0uYCxcbiAgICAgICAgICB7IGZhY3Q6IFwidmVyc2lvbi5jcmVhdGVkXCIsIGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24ubiB9LFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1ZywgdmVyc2lvbjogci52ZXJzaW9uLm4sIGZyb206IHIudmVyc2lvbi5mcm9tLCBwYXRoOiByLnZlcnNpb24ucGF0aCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInNheVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJhZ2VudFwiLCBjbWQudGV4dCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiB7IGlkOiBtLmlkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiYWN0aXZhdGVcIjpcbiAgICAgICAgcmV0dXJuIGFjdGl2YXRlKGNtZC5kb2MsIGNtZC52ZXJzaW9uLCBcImFnZW50XCIpO1xuICAgICAgY2FzZSBcImNsb3NlXCI6XG4gICAgICAgIHJlc29sdmVEb25lKHsgY29kZTogMCwgcmVhc29uOiBcImNsb3NlXCIgfSk7XG4gICAgICAgIHJldHVybiB7fTtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgICAgYHVucmVjb2duaXNlZCBjb21tYW5kIHR5cGUgJHtKU09OLnN0cmluZ2lmeSgoY21kIGFzIHsgdHlwZT86IHVua25vd24gfSkudHlwZSl9IOKAlCBub3RoaW5nIHdhcyBhcHBsaWVkYCxcbiAgICAgICAgICA0MDAsXG4gICAgICAgICAgW1xuICAgICAgICAgICAgXCJjb250ZXh0LmFkZFwiLFxuICAgICAgICAgICAgXCJ2ZXJzaW9uLm5ld1wiLFxuICAgICAgICAgICAgXCJzYXlcIixcbiAgICAgICAgICAgIFwiYWN0aXZhdGVcIixcbiAgICAgICAgICAgIFwiY2xvc2VcIixcbiAgICAgICAgICAgIFwibWV0YVwiLFxuICAgICAgICAgICAgXCJmaW5kXCIsXG4gICAgICAgICAgICBcImdyYXBoXCIsXG4gICAgICAgICAgICBcImJhY2tsaW5rc1wiLFxuICAgICAgICAgICAgXCJtZXRhLmluaXRcIixcbiAgICAgICAgICAgIFwibWV0YS5zZXRcIixcbiAgICAgICAgICAgIC4uLlNUUlVDVFVSRV9PUFMsXG4gICAgICAgICAgXSxcbiAgICAgICAgKTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgcmVmdXNhbCA9IChlOiB1bmtub3duKTogUmVzcG9uc2UgPT4ge1xuICAgIGlmIChlIGluc3RhbmNlb2YgU2Vzc2lvbkVycm9yKVxuICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oXG4gICAgICAgIHsgb2s6IGZhbHNlLCBlcnJvcjogZS5tZXNzYWdlLCAuLi4oZS5jaG9pY2VzID8geyBjaG9pY2VzOiBlLmNob2ljZXMgfSA6IHt9KSB9LFxuICAgICAgICB7IHN0YXR1czogZS5zdGF0dXMgfSxcbiAgICAgICk7XG4gICAgaWYgKGUgaW5zdGFuY2VvZiBQYXRoRXJyb3IpXG4gICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSB9LCB7IHN0YXR1czogNDA0IH0pO1xuICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogU3RyaW5nKGUpIH0sIHsgc3RhdHVzOiA1MDAgfSk7XG4gIH07XG5cbiAgY29uc3QgZXZlbnRzUmVzcG9uc2UgPSAocmVxOiBSZXF1ZXN0LCB1cmw6IFVSTCk6IFJlc3BvbnNlID0+IHtcbiAgICB0b3VjaCgpO1xuICAgIHJldHVybiBzc2VSZXNwb25zZSh7XG4gICAgICBsb2csXG4gICAgICBzaW5jZTogTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic2luY2VcIikgPz8gXCItMVwiLCAxMCksXG4gICAgICBoZWFydGJlYXRNczogU1NFX0hFQVJUQkVBVF9NUyxcbiAgICAgIGNsaWVudHM6IHNzZUNsaWVudHMsXG4gICAgICBzaWduYWw6IHJlcS5zaWduYWwsXG4gICAgICBvbk9wZW46IHRvdWNoLFxuICAgICAgb25DbG9zZTogdG91Y2gsXG4gICAgfSk7XG4gIH07XG5cbiAgLy8gLS0tIHNlcnZlIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc2VydmVyID0gQnVuLnNlcnZlKHtcbiAgICBwb3J0OiBvcHRzLnBvcnQgPz8gMCxcbiAgICBob3N0bmFtZTogXCIxMjcuMC4wLjFcIixcbiAgICByb3V0ZXMsXG4gICAgaWRsZVRpbWVvdXQ6IElETEVfVElNRU9VVF9TRUMsXG4gICAgZGV2ZWxvcG1lbnQ6IHsgaG1yOiBtb2RlID09PSBcImRldlwiIH0sXG4gICAgZmV0Y2gocmVxLCBzcnYpIHtcbiAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmVxLnVybCk7XG4gICAgICBjb25zdCBwYXRoID0gdXJsLnBhdGhuYW1lO1xuICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAxYSDigJQgQSBGT1JFSUdOIE9SSUdJTiBJUyBSRUZVU0VELiBBbnkgd2ViIHBhZ2UgdGhlXG4gICAgICAvLyBodW1hbiB2aXNpdHMgY2FuIG9wZW4gYSBXZWJTb2NrZXQgb3IgUE9TVCB0byAxMjcuMC4wLjE7IHRoZSBicm93c2VyXG4gICAgICAvLyBzZW5kcyBpdHMgT3JpZ2luLCBhbmQgb25seSB0aGlzIGRhZW1vbidzIG93biBwYWdlIG1heSBkcml2ZSBpdC4gVGhlXG4gICAgICAvLyBDTEkncyBmZXRjaCBzZW5kcyBubyBPcmlnaW4gYXQgYWxsLCBzbyBpdCBpcyB1bmFmZmVjdGVkLlxuICAgICAgaWYgKFxuICAgICAgICAocGF0aCA9PT0gXCIvd3NcIiB8fCBwYXRoID09PSBcIi9jbWRcIiB8fCBwYXRoLnN0YXJ0c1dpdGgoXCIvZnMvXCIpKSAmJlxuICAgICAgICAhc2FtZU9yaWdpbihyZXEsIHNydi5wb3J0KVxuICAgICAgKVxuICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IFwiZm9yZWlnbiBvcmlnaW4gcmVmdXNlZFwiIH0sIHsgc3RhdHVzOiA0MDMgfSk7XG4gICAgICBpZiAocGF0aCA9PT0gXCIvd3NcIilcbiAgICAgICAgcmV0dXJuIHNydi51cGdyYWRlKHJlcSkgPyB1bmRlZmluZWQgOiBuZXcgUmVzcG9uc2UoXCJ1cGdyYWRlIHJlcXVpcmVkXCIsIHsgc3RhdHVzOiA0MjYgfSk7XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9zdGF0ZVwiKSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGNvbnN0IHN0YXRlID0gdmlld1N0YXRlKCk7XG4gICAgICAgIGNvbnN0IGZ1bGwgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcImZ1bGxcIikgPT09IFwiMVwiO1xuICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7XG4gICAgICAgICAgLi4uc3RhdGUsXG4gICAgICAgICAgY2hhdDogZnVsbCA/IHN0YXRlLmNoYXQgOiBzdGF0ZS5jaGF0LnNsaWNlKC0xMCksXG4gICAgICAgICAgY2hhdFRvdGFsOiBzdGF0ZS5jaGF0Lmxlbmd0aCxcbiAgICAgICAgICBhY3RpdmU6IGFjdGl2ZU9mKCksXG4gICAgICAgICAgY3Vyc29yOiBsb2cuY3Vyc29yKCksXG4gICAgICAgICAgZXBvY2g6IGxvZy5lcG9jaCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9ldmVudHNcIikgcmV0dXJuIGV2ZW50c1Jlc3BvbnNlKHJlcSwgdXJsKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL2ZzL3ZlcnNpb25cIikge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlYWRWZXJzaW9uKFxuICAgICAgICAgICAgdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJkb2NcIikgPz8gXCJcIixcbiAgICAgICAgICAgIE51bWJlci5wYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInZcIikgPz8gXCJcIiwgMTApLFxuICAgICAgICAgICk7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24ocik7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXR1cm4gcmVmdXNhbChlKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZnMvbGlzdFwiKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oe1xuICAgICAgICAgICAgZW50cmllczogbGlzdERpcihleHBhbmRIb21lKHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwicGF0aFwiKSA/PyBcIn5cIikpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcoKGUgYXMgRXJyb3IpLm1lc3NhZ2UpIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9jbWRcIilcbiAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAudGhlbigoYikgPT4ge1xuICAgICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IHRydWUsIC4uLmhhbmRsZUFnZW50Q21kKGIgYXMgQWdlbnRDbWQpIH0pO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICByZXR1cm4gcmVmdXNhbChlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoKSA9PiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogXCJiYWQganNvblwiIH0sIHsgc3RhdHVzOiA0MDAgfSkpO1xuICAgICAgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgIGNvbnN0IGFzc2V0ID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICBpZiAoYXNzZXQpIHJldHVybiBhc3NldDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwibm90IGZvdW5kXCIgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICB9LFxuICAgIHdlYnNvY2tldDoge1xuICAgICAgb3Blbih3cykge1xuICAgICAgICBzb2NrZXRzLmFkZCh3cyk7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcInN0YXRlXCIsIHN0YXRlOiB2aWV3U3RhdGUoKSB9KSk7XG4gICAgICB9LFxuICAgICAgbWVzc2FnZSh3cywgcmF3KSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGxldCBtc2c6IENsaWVudE1zZztcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBtc2cgPSBKU09OLnBhcnNlKFxuICAgICAgICAgICAgdHlwZW9mIHJhdyA9PT0gXCJzdHJpbmdcIiA/IHJhdyA6IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyYXcpLFxuICAgICAgICAgICkgYXMgQ2xpZW50TXNnO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYHNjcmlwdG9yaXVtOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBoYW5kbGVDbGllbnRNc2cod3MsIG1zZyk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAvLyBBIHJlZnVzYWwgdGhlIGh1bWFuIGNhdXNlZCAoZWRpdCBhIG5vbi1hY3RpdmUgdmVyc2lvbiwgb3BlbiBhXG4gICAgICAgICAgLy8gdmFuaXNoZWQgZmlsZSkgcmVhY2hlcyBUSEVNLCBhcyBhIGNoYXQtdmlzaWJsZSBzeXN0ZW0gbGluZSB3b3VsZCBiZVxuICAgICAgICAgIC8vIHRvbyBsb3VkIGZvciBhIGtleXN0cm9rZSDigJQgc28gaXQgaXMgYW4gZXJyb3IgZnJhbWUgdGhlIHN1cmZhY2Ugc2hvd3MuXG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICBjbG9zZSh3cykge1xuICAgICAgICBzb2NrZXRzLmRlbGV0ZSh3cyk7XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGJvdW5kUG9ydCA9IHNlcnZlci5wb3J0O1xuICAvLyAtLS0gZGlzY292ZXJ5IChFMTM6IHNlc3Npb24tSlNPTiwgdGhlIG9ubHkgY29udmVudGlvbiB0aGF0IGNhbiBleHByZXNzIHNldmVyYWwpIC0tXG4gIGNvbnN0IHNlc3Npb25GaWxlID0gam9pbih0bXBkaXIoKSwgYHNjcmlwdG9yaXVtLSR7c2Vzc2lvbklkfS5qc29uYCk7XG4gIGNvbnN0IGxhdGVzdEZpbGUgPSBqb2luKHRtcGRpcigpLCBcInNjcmlwdG9yaXVtLWxhdGVzdC5qc29uXCIpO1xuICBjb25zdCBpbmZvID0gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHVybDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtib3VuZFBvcnR9YCxcbiAgICBwb3J0OiBib3VuZFBvcnQsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIGhvbWUsXG4gICAgZGlyOiBzZXNzaW9uLmRpcixcbiAgICBtb2RlLFxuICB9KTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVBdG9taWMoc2Vzc2lvbkZpbGUsIGluZm8pO1xuICAgIHdyaXRlRmlsZUF0b21pYyhsYXRlc3RGaWxlLCBpbmZvKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogZGlzY292ZXJ5IGlzIGJlc3QtZWZmb3J0ICovXG4gIH1cblxuICBzeW5jV2F0Y2hlcnMoKTtcbiAgLy8g4pqgIFRIRSBTRVNTSU9OIFNBWVMgV0hBVCBJVFMgT1dOIFRJTUVPVVQgSVMuIGAtLXRpbWVvdXQgMGAgaGFzIGFsd2F5cyBtZWFudFxuICAvLyBcInN0YW5kIHVudGlsIGNsb3NlZFwiIGFuZCB0aGVyZSB3YXMgbm8gd2F5IHRvIGNvbmZpcm0gZnJvbSBvdXRzaWRlIHRoYXQgYVxuICAvLyBkYWVtb24gaGFkIHRha2VuIGl0IOKAlCB3aGljaCBpcyB0aGUga2luZCBvZiBzZXR0aW5nIHlvdSBmaW5kIG91dCBhYm91dCBieVxuICAvLyBsb3NpbmcgYSBzZXNzaW9uIGF0IHRoZSB3cm9uZyBtb21lbnQuXG4gIGxvZy5lbWl0KHtcbiAgICB0eXBlOiBcInJlYWR5XCIsXG4gICAgbW9kZSxcbiAgICBzZXNzaW9uX2lkOiBzZXNzaW9uSWQsXG4gICAgcmVzdG9yZWQ6ICEhb3B0cy5yZXN0b3JlLFxuICAgIGlkbGVfdGltZW91dF9zOiBvcHRzLnRpbWVvdXRTID8/IDE4MDAsXG4gIH0pO1xuICAvLyBWZXJpZnktcGFzcyBmaXggMjogd2hhdCBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgbm8gZGFlbW9uIHdhcyB3YXRjaGluZy5cbiAgZm9yIChjb25zdCBmIG9mIHNlc3Npb24ucmVzdG9yZUZpbmRpbmdzKVxuICAgIGFubm91bmNlKFxuICAgICAgZi5taXNzaW5nXG4gICAgICAgID8gYCR7Zi5vcmlnaW5hbH0gaXMgZ29uZSBmcm9tIGRpc2sgc2luY2UgdGhpcyBzZXNzaW9uIHdhcyBsYXN0IG9wZW4uIFNhdmUgd291bGQgcmVjcmVhdGUgaXQ7IFJldmVydCBjYW5ub3QgcnVuLmBcbiAgICAgICAgOiBgJHtmLm9yaWdpbmFsfSBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgdGhpcyBzZXNzaW9uIHdhcyBjbG9zZWQuIFNhdmUgb3ZlcndyaXRlcyBpdCB3aXRoIHRoZSBhY3RpdmUgdmVyc2lvbjsgUmV2ZXJ0IHRha2VzIHRoZSBmaWxlJ3MgdmVyc2lvbi5gLFxuICAgICAgeyBmYWN0OiBcIm9yaWdpbmFsLmNvbmZsaWN0XCIsIGRvYzogZi5kb2MsIHdoaWxlQ2xvc2VkOiB0cnVlIH0sXG4gICAgKTtcblxuICAvKipcbiAgICogRTUzJ3MgYXR0ZW50aW9uIHRpY2suIFNlcGFyYXRlIGZyb20gaG91c2VrZWVwaW5nIGJlY2F1c2UgaXQgaXMgYWJvdXQgdGhlXG4gICAqIEhVTUFOJ3MgcGF0aWVuY2UgcmF0aGVyIHRoYW4gdGhlIGRhZW1vbidzIGxpZmV0aW1lLCBhbmQgYmVjYXVzZSBpdCBtdXN0IHJ1blxuICAgKiBvbiBhIHNsb3dlciBjbG9jazogYSAyNTAgbXMgc3dlZXAgcmUtYnJvYWRjYXN0aW5nIHN0YXRlIHdvdWxkIGJlIGNodXJuIGZvciBhXG4gICAqIHZhbHVlIHRoYXQgY2hhbmdlcyB0d2ljZSBpbiBhIHdhaXQuXG4gICAqL1xuICBsZXQgbGFzdFdhaXRpbmc6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBjb25zdCBhdHRlbnRpb25UaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICBjb25zdCB3ID0gd2FpdGluZ09uKHNlc3Npb24ubWVzc2FnZXMoKSwgRGF0ZS5ub3coKSwgeyBhY2tub3dsZWRnZWRVbnRpbCB9KTtcbiAgICBjb25zdCBrZXkgPSB3ID8gYCR7dy5tZXNzYWdlSWR9OiR7dy5iYWRnZX1gIDogbnVsbDtcbiAgICBpZiAoa2V5ID09PSBsYXN0V2FpdGluZykgcmV0dXJuO1xuICAgIGxhc3RXYWl0aW5nID0ga2V5O1xuICAgIC8vIFRoZSBiYWRnZSBjaGFuZ2VkLCBzbyB0aGUgc3VyZmFjZSBuZWVkcyB0aGUgbmV3IHNuYXBzaG90LlxuICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgaWYgKCF3KSByZXR1cm47XG4gICAgaWYgKHcuYmFkZ2UgIT09IFwic3RhbGxlZFwiIHx8IG51ZGdlZC5oYXMody5tZXNzYWdlSWQpKSByZXR1cm47XG4gICAgbnVkZ2VkLmFkZCh3Lm1lc3NhZ2VJZCk7XG4gICAgLy8g4puUIFRIRSBOVURHRSBHT0VTIFRPIFRIRSBBR0VOVCdTIFRBSUwgQU5EIE5PV0hFUkUgRUxTRS4gVGhlIGh1bWFuIGFscmVhZHlcbiAgICAvLyBzZWVzIHRoZSBiYWRnZTsgcHV0dGluZyB0aGlzIGluIHRoZSBjaGF0IGFzIHdlbGwgd291bGQgYmUgdGVsbGluZyB0aGVtXG4gICAgLy8gd2hhdCB0aGV5IGFyZSBsb29raW5nIGF0LiBJdCBjYXJyaWVzIHRoZSBtZXNzYWdlIFRFWFQgYmVjYXVzZSBhbiBhZ2VudFxuICAgIC8vIHRoYXQgaGFzIGJlZW4gYXdheSBuZWVkcyB0byBrbm93IHdoYXQgaXMgcGVuZGluZywgbm90IGp1c3QgdGhhdCBzb21ldGhpbmdcbiAgICAvLyBpcyDigJQgYW5kIGl0IG5hbWVzIHRoZSB0d28gd2F5cyBvdXQsIGJlY2F1c2UgYSBudWRnZSB0aGF0IGRvZXMgbm90IHNheSBob3dcbiAgICAvLyB0byBhbnN3ZXIgaXQgaW52aXRlcyBhIGZvdXJ0aCBwcmltaXRpdmUuXG4gICAgY29uc3QgcGVuZGluZyA9IHNlc3Npb24ubWVzc2FnZXMoKS5maW5kKChtKSA9PiBtLmlkID09PSB3Lm1lc3NhZ2VJZCk7XG4gICAgbG9nLmVtaXQoe1xuICAgICAgdHlwZTogXCJ3YWl0aW5nXCIsXG4gICAgICBtZXNzYWdlX2lkOiB3Lm1lc3NhZ2VJZCxcbiAgICAgIHNlY29uZHM6IE1hdGgucm91bmQoKERhdGUubm93KCkgLSB3LnNpbmNlKSAvIDEwMDApLFxuICAgICAgLi4uKHBlbmRpbmcgPyB7IHRleHQ6IHBlbmRpbmcudGV4dCB9IDoge30pLFxuICAgICAgaGludDogXCJyZXBseSB3aXRoIGBzYXlgLCBvciBgd29ya2luZ2AgdG8gc2F5IHlvdSBhcmUgc3RpbGwgb24gaXRcIixcbiAgICB9KTtcbiAgfSwgMTAwMCk7XG5cbiAgY29uc3Qgc3RvcEhvdXNla2VlcGluZyA9IHN0YXJ0SG91c2VrZWVwaW5nKHtcbiAgICBzdWJzY3JpYmVyQ291bnQ6ICgpID0+IHNvY2tldHMuc2l6ZSArIHNzZUNsaWVudHMuc2l6ZSxcbiAgICBpZGxlTXM6ICgpID0+IHBlcmZvcm1hbmNlLm5vdygpIC0gbGFzdEFjdGl2aXR5LFxuICAgIHRvdWNoLFxuICAgIHRpbWVvdXRNczogKG9wdHMudGltZW91dFMgPz8gMTgwMCkgKiAxMDAwLFxuICAgIG9uSWRsZUNsb3NlOiAoKSA9PiByZXNvbHZlRG9uZSh7IGNvZGU6IDEyNCwgcmVhc29uOiBcInRpbWVvdXRcIiB9KSxcbiAgfSk7XG5cbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICBsZXQgcmVzb2x2ZVNodXRkb3duITogKCkgPT4gdm9pZDtcbiAgY29uc3Qgc2h1dGRvd24gPSBuZXcgUHJvbWlzZTx2b2lkPigocikgPT4ge1xuICAgIHJlc29sdmVTaHV0ZG93biA9IHI7XG4gIH0pO1xuXG4gIGNvbnN0IGNsZWFudXBEaXNjb3ZlcnkgPSAoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMoc2Vzc2lvbkZpbGUpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogZ29uZSDigJQgZmluZSAqL1xuICAgIH1cbiAgICB1bmxpbmtJZk1hdGNoZXMobGF0ZXN0RmlsZSwgc2Vzc2lvbklkLCAocmF3KSA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBpZCA9IChKU09OLnBhcnNlKHJhdykgYXMgeyBzZXNzaW9uX2lkPzogdW5rbm93biB9KS5zZXNzaW9uX2lkO1xuICAgICAgICByZXR1cm4gdHlwZW9mIGlkID09PSBcInN0cmluZ1wiID8gaWQgOiBudWxsO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgIH0pO1xuICB9O1xuXG4gIC8vIFRoZSBvcmRlciBpcyB0aGUgaGVhZGVyJ3MsIGFuZCB0aGUgaGVhZGVyIHNheXMgd2h5LlxuICBjb25zdCBjbG9zZSA9ICgpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBzdG9wSG91c2VrZWVwaW5nKCk7XG4gICAgY2xlYXJJbnRlcnZhbChhdHRlbnRpb25UaW1lcik7XG4gICAgZm9yIChjb25zdCB3IG9mIHdhdGNoZXJzLnZhbHVlcygpKSB3LmNsb3NlKCk7XG4gICAgd2F0Y2hlcnMuY2xlYXIoKTtcbiAgICBmb3IgKGNvbnN0IHQgb2YgcGVuZGluZy52YWx1ZXMoKSkgY2xlYXJUaW1lb3V0KHQpO1xuICAgIHRyeSB7XG4gICAgICBzZXNzaW9uLnBlcnNpc3QoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGJlc3QtZWZmb3J0ICovXG4gICAgfVxuICAgIGNsZWFudXBEaXNjb3ZlcnkoKTtcbiAgICBsb2cuZW1pdCh7IHR5cGU6IFwiY2xvc2VkXCIgfSk7XG4gICAgdm9pZCBkcmFpbkFuZFN0b3AoeyBzZXJ2ZXIsIGNsaWVudHM6IHNzZUNsaWVudHMsIHNvY2tldHMgfSkudGhlbihyZXNvbHZlU2h1dGRvd24pO1xuICB9O1xuICBkb25lLnRoZW4oKCkgPT4gY2xvc2UoKSk7XG5cbiAgcmV0dXJuIHsgcG9ydDogYm91bmRQb3J0LCBzZXNzaW9uSWQsIG1vZGUsIGRpcjogc2Vzc2lvbi5kaXIsIGNsb3NlLCBkb25lLCBzaHV0ZG93biB9O1xufVxuXG4vKiogQW4gYWJzZW50IE9yaWdpbiAodGhlIENMSSwgY3VybCkgb3IgdGhpcyBkYWVtb24ncyBvd24gcGFnZTsgbm90aGluZyBlbHNlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNhbWVPcmlnaW4ocmVxOiBSZXF1ZXN0LCBwb3J0OiBudW1iZXIgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcbiAgY29uc3Qgb3JpZ2luID0gcmVxLmhlYWRlcnMuZ2V0KFwib3JpZ2luXCIpO1xuICBpZiAob3JpZ2luID09PSBudWxsKSByZXR1cm4gdHJ1ZTtcbiAgcmV0dXJuIG9yaWdpbiA9PT0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fWAgfHwgb3JpZ2luID09PSBgaHR0cDovL2xvY2FsaG9zdDoke3BvcnR9YDtcbn1cblxuLyoqXG4gKiBBIHBhdGggdHlwZWQgaW4gdGhlIFNVUkZBQ0UuIFRoZSBwYWdlIGhhcyBubyB3b3JraW5nIGRpcmVjdG9yeSwgc28gYSBwYXRoXG4gKiBmcm9tIGl0IG11c3QgYmUgYWJzb2x1dGUgb3Igc3RhcnQgYXQgYH5gIOKAlCB3aGljaCBpcyBleHBhbmRlZCBIRVJFLiBCZWZvcmVcbiAqIHRoaXMsIGB+L0RvY3VtZW50c2AgcmVhY2hlZCBgcmVzb2x2ZSgpYCBhbmQgd2FzIHRha2VuIGFzIHJlbGF0aXZlIHRvIHRoZVxuICogZGFlbW9uJ3MgY3dkICh0aGUgc2tpbGwgZm9sZGVyKTogdGhlIHBhdGggYm94IGNvbXBsZXRlZCBgfi/igKZgIChsaXN0aW5nXG4gKiBleHBhbmRzIGl0KSBhbmQgdGhlbiBFbnRlciBmYWlsZWQgd2l0aCBcIm5vIHN1Y2ggZmlsZSBvciBmb2xkZXI6XG4gKiDigKYvc2tpbGxzL3NjcmlwdG9yaXVtL34vRG9jdW1lbnRzL+KAplwiIChDb2xlLCAyMDI2LTA5LTExKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN1cmZhY2VQYXRoKHA6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHQgPSBwLnRyaW0oKTtcbiAgaWYgKHQgPT09IFwiflwiIHx8IHQuc3RhcnRzV2l0aChcIn4vXCIpKSByZXR1cm4gZXhwYW5kSG9tZSh0KTtcbiAgaWYgKCFpc0Fic29sdXRlKHQpKVxuICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYFwiJHtwfVwiIGlzIG5vdCBhIGZ1bGwgcGF0aCDigJQgc3RhcnQgaXQgd2l0aCAvIG9yIH4vYCwgNDAwKTtcbiAgcmV0dXJuIHJlc29sdmUodCk7XG59XG5cbi8qKiBBIHN0cnVjdHVyZSBvcCBmcm9tIHRoZSBzdXJmYWNlLCB3aXRoIGV2ZXJ5IHBhdGggZmllbGQgdGhyb3VnaCBgc3VyZmFjZVBhdGhgLiAqL1xuZnVuY3Rpb24gYW5jaG9yU3VyZmFjZVBhdGhzKG9wOiBTdHJ1Y3R1cmVPcCk6IFN0cnVjdHVyZU9wIHtcbiAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgLi4ub3AgfTtcbiAgZm9yIChjb25zdCBrIG9mIFtcImRpclwiLCBcInBhdGhcIiwgXCJpbnRvXCJdIGFzIGNvbnN0KVxuICAgIGlmICh0eXBlb2Ygb3V0W2tdID09PSBcInN0cmluZ1wiKSBvdXRba10gPSBzdXJmYWNlUGF0aChvdXRba10gYXMgc3RyaW5nKTtcbiAgcmV0dXJuIG91dCBhcyBTdHJ1Y3R1cmVPcDtcbn1cblxuZnVuY3Rpb24gZXhwYW5kSG9tZShwOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAocCA9PT0gXCJ+XCIpIHJldHVybiBob21lZGlyKCk7XG4gIGlmIChwLnN0YXJ0c1dpdGgoXCJ+L1wiKSkgcmV0dXJuIGpvaW4oaG9tZWRpcigpLCBwLnNsaWNlKDIpKTtcbiAgcmV0dXJuIHJlc29sdmUocCk7XG59XG5cbi8qKiBUaGUgZGFlbW9uJ3MgcHJpdmF0ZSBhcmd2IOKAlCB0aGUgQ0xJIHNwYXducyBpdCB3aXRoIGV4YWN0bHkgdGhlc2UuICovXG5jb25zdCBEQUVNT05fT1BUSU9OUyA9IHtcbiAgbG9nOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcG9ydDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgd29ya3NwYWNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbn0gYXMgY29uc3Q7XG5cbi8qKiBQYXJzZSB0aGUgZGFlbW9uJ3MgYXJndiwgYm9vdCwgcHJpbnQgdGhlIGhhbmRzaGFrZSwgd2FpdCBmb3IgdGhlIGVuZC4gUmV0dXJucyB0aGUgZXhpdCBjb2RlLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD47XG4gIHRyeSB7XG4gICAgZmxhZ3MgPSBub2RlUGFyc2VBcmdzKHsgYXJnczogYXJndiwgb3B0aW9uczogREFFTU9OX09QVElPTlMsIHN0cmljdDogdHJ1ZSB9KS52YWx1ZXMgYXMgUmVjb3JkPFxuICAgICAgc3RyaW5nLFxuICAgICAgc3RyaW5nIHwgdW5kZWZpbmVkXG4gICAgPjtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYHNjcmlwdG9yaXVtOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG4gIHJlY29nbml6ZWQgZmxhZ3M6ICR7T2JqZWN0LmtleXMoXG4gICAgICAgIERBRU1PTl9PUFRJT05TLFxuICAgICAgKVxuICAgICAgICAubWFwKChrKSA9PiBgLS0ke2t9YClcbiAgICAgICAgLmpvaW4oXCIgXCIpfVxcbmAsXG4gICAgKTtcbiAgICByZXR1cm4gMjtcbiAgfVxuICBsZXQgZDogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiBzdGFydERhZW1vbj4+O1xuICB0cnkge1xuICAgIGQgPSBhd2FpdCBzdGFydERhZW1vbih7XG4gICAgICBwb3J0OiBmbGFncy5wb3J0ID8gTnVtYmVyKGZsYWdzLnBvcnQpIDogMCxcbiAgICAgIHJlc3RvcmU6IGZsYWdzLnJlc3RvcmUsXG4gICAgICB0aW1lb3V0UzogZmxhZ3MudGltZW91dCA/IE51bWJlcihmbGFncy50aW1lb3V0KSA6IHVuZGVmaW5lZCxcbiAgICAgIHdvcmtzcGFjZTogZmxhZ3Mud29ya3NwYWNlLFxuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgLy8gVGhlIGhhbmRzaGFrZSBsaW5lIGlzIEpTT04gZWl0aGVyIHdheSwgc28gdGhlIENMSSByZWFkcyBPTkUgc2hhcGUuXG4gICAgY29uc3Qgc3RhdHVzID0gZSBpbnN0YW5jZW9mIFNlc3Npb25FcnJvciA/IGUuc3RhdHVzIDogNTAwO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoeyBvazogZmFsc2UsIHN0YXR1cywgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KX1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIHN0YXR1cyA9PT0gNDA0ID8gNSA6IHN0YXR1cyA9PT0gNDA5ID8gNiA6IDE7XG4gIH1cbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7ZC5wb3J0fWAsIHBvcnQ6IGQucG9ydCwgc2Vzc2lvbl9pZDogZC5zZXNzaW9uSWQsIG1vZGU6IGQubW9kZSwgZGlyOiBkLmRpciB9KX1cXG5gLFxuICApO1xuICBjb25zdCByZXMgPSBhd2FpdCBkLmRvbmU7XG4gIGF3YWl0IGQuc2h1dGRvd247XG4gIC8vIFZlcmlmeS1wYXNzIGZpeCA2OiBhIGNsZWFuIGNsb3NlIGxlYXZlcyBubyBlbXB0eSBsb2cgYmVoaW5kLlxuICBpZiAocmVzLmNvZGUgPT09IDAgJiYgZmxhZ3MubG9nKSB7XG4gICAgdHJ5IHtcbiAgICAgIGlmIChzdGF0U3luYyhmbGFncy5sb2cpLnNpemUgPT09IDApIHVubGlua1N5bmMoZmxhZ3MubG9nKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGFscmVhZHkgZ29uZSAqL1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzLmNvZGU7XG59XG5cbi8qKlxuICogVGhlIGRhZW1vbidzIGVudHJ5LCBmb3IgdGhlIExBVU5DSEVSLiBgaW1wb3J0Lm1ldGEubWFpbmAgaXMgRkFMU0UgaW4gdGhlXG4gKiBidW5kbGUsIHNvIHRoZXJlIGlzIG5vIHN1Y2ggYmxvY2sgaGVyZSwgYW5kIHRoaXMgdGFrZXMgbm8gYXJndW1lbnRzOiB0aGVcbiAqIGNvbW1hbmQgbGluZSBiZWxvbmdzIHRvIHRoZSBmaWxlIHRoYXQgcGFyc2VzIGl0LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIHR3byBwcmltaXRpdmVzIHVuZGVyIEJPVEggb2YgdGhlIGhvdXNlJ3MgZGFlbW9uLWRpc2NvdmVyeSBjb252ZW50aW9ucy5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIEQzIHJ1bGVkIHRoYXQgdGhlIGNvbnZlbnRpb25zIHRoZW1zZWx2ZXMg4oCUIHBlci1zZXNzaW9uIHRtcGRpciBKU09OIChib3VudHksXG4gKiBnbGFtb3VyLCBpbWFnbywgbWFncGllKSBhbmQgc2luZ2xldG9uIGAkSE9NRS9kYWVtb24ucG9ydGAgKyBgZGFlbW9uLnBpZGBcbiAqIChhc3Ryb2xhYmUsIGdyYXBldmluZSwgbWluZC1tYXBwZXIpIOKAlCBib3RoIHN1cnZpdmUsIGJlY2F1c2UgdGhleSBlbmNvZGVcbiAqIGdlbnVpbmVseSBkaWZmZXJlbnQgbW9kZWxzIChjb25jdXJyZW50IHNlc3Npb25zIHZzIGEgc3RhbmRpbmcgc2luZ2xldG9uKSBhbmRcbiAqIHBpY2tpbmcgb25lIGlzIGEgcHJvZHVjdCBkZWNpc2lvbiwgbm90IGEgZmFjdG9yaW5nIG9uZS4gV2hhdCBJUyBvbmVcbiAqIGltcGxlbWVudGF0aW9uIGlzIHRoZSBwYWlyIGJlbG93LCB3aGljaCBpcyBhbHNvIGV4YWN0bHkgd2hlcmUgY2Vuc3VzIGRlZmVjdFxuICogKipMMyoqIGxpdmVzLlxuICovXG5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYywgcmVuYW1lU3luYywgcm1TeW5jLCB1bmxpbmtTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcblxuLyoqXG4gKiBXcml0ZSBgdGV4dGAgdG8gYHRhcmdldGAgYXRvbWljYWxseTogd3JpdGUgYmVzaWRlIGl0LCB0aGVuIHJlbmFtZS5cbiAqXG4gKiDim5QgKipMMywgQ0xPU0VEIEJZIENPTlNUUlVDVElPTi4qKiBBIGJhcmUgYHdyaXRlRmlsZVN5bmNgIGlzIG5vdCBhdG9taWMsIHNvIGFcbiAqIENMSSByZWFkaW5nIHdoaWxlIHRoZSBkYWVtb24gd3JpdGVzIGNhbiBvYnNlcnZlIGEgSEFMRi1XUklUVEVOIHBvaW50ZXIuIFVuZGVyXG4gKiBhIGJlc3QtZWZmb3J0IHJlYWRlciB0aGF0IHN1cmZhY2VkIGFzIFwibm8gcnVubmluZyBzZXNzaW9uXCIg4oCUIGFic2VuY2UgcmVwb3J0ZWRcbiAqIGZvciB3aGF0IHdhcyByZWFsbHkgYSB0b3JuIHJlYWQsIHdoaWNoIGlzIHRoZSBleGFjdCBjb25mbGF0aW9uIHRoZSBob3VzZSdzXG4gKiBgbnVsbGAtbm90LWAwYCBydWxlIGV4aXN0cyB0byBwcmV2ZW50LiBSZW5hbWUgd2l0aGluIG9uZSBkaXJlY3RvcnkgaXMgYXRvbWljLFxuICogc28gYSByZWFkZXIgc2VlcyBlaXRoZXIgdGhlIHByZXZpb3VzIHBvaW50ZXIgb3IgdGhlIG5ldyBvbmUsIG5ldmVyIGEgcGFydGlhbFxuICogZmlsZS5cbiAqXG4gKiBGaXhlZCBpbiBnbGFtb3VyIDIwMjYtMDktMDcsIGZvdW5kIHN0YW5kaW5nIGluIHRocmVlIHNpYmxpbmdzIHRoZSBuZXh0IGRheSBieVxuICogdGhlIGR1cGxpY2F0aW9uIHJlY29uLCBhbmQgcmVwYWlyZWQgaW4gYWxsIG9mIHRoZW0gdGhlIG9ubHkgd2F5IHRoYXQgZG9lcyBub3RcbiAqIG5lZWQgZmluZGluZyBhZ2FpbjogdGhlcmUgaXMgbm93IG9uZSBpbXBsZW1lbnRhdGlvbi5cbiAqXG4gKiDimqAgVGhlIHRlbXAgbmFtZSBjYXJyaWVzIHRoZSBwaWQsIHNvIHR3byBkYWVtb25zIHJhY2luZyB0byBwdWJsaXNoIHRoZSBzYW1lXG4gKiBwb2ludGVyIGNhbm5vdCBjbG9iYmVyIGVhY2ggb3RoZXIncyBpbnRlcm1lZGlhdGUgZmlsZSDigJQgYW5kIGl0IGlzIHJlbW92ZWQgb25cbiAqIGEgZmFpbGVkIHdyaXRlIHJhdGhlciB0aGFuIGxlZnQgYXMgbGl0dGVyIGJlc2lkZSB0aGUgcmVhbCBvbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3cml0ZUZpbGVBdG9taWModGFyZ2V0OiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCB0bXAgPSBgJHt0YXJnZXR9LiR7cHJvY2Vzcy5waWR9LnRtcGA7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyh0bXAsIHRleHQpO1xuICAgIHJlbmFtZVN5bmModG1wLCB0YXJnZXQpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICB0cnkge1xuICAgICAgcm1TeW5jKHRtcCwgeyBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHRoZSB0ZW1wIGZpbGUgaXMgYWxyZWFkeSBnb25lLCBvciB3YXMgbmV2ZXIgY3JlYXRlZCAqL1xuICAgIH1cbiAgICB0aHJvdyBlcnI7XG4gIH1cbn1cblxuLyoqXG4gKiBEZWxldGUgYHBhdGhgIGlmZiBpdCBzdGlsbCBuYW1lcyBVUy4gUmV0dXJucyB3aGV0aGVyIGl0IHdhcyBkZWxldGVkLlxuICpcbiAqIOKblCAqKlwiU1RJTEwgT1VSU1wiIElTIFRIRSBXSE9MRSBGVU5DVElPTi4qKiBBIGRhZW1vbiB0aGF0IHVubGlua3MgaXRzIGRpc2NvdmVyeVxuICogZmlsZSB1bmNvbmRpdGlvbmFsbHkgYXQgZXhpdCBkZWxldGVzIHRoZSBwb2ludGVyIGEgU1VDQ0VTU09SIGhhcyBhbHJlYWR5XG4gKiB3cml0dGVuIOKAlCB0aGUgc3VjY2Vzc29yIGNhbiB0aGVuIG5vIGxvbmdlciBiZSBmb3VuZCBhbmQgdGhlIG5leHQgQ0xJIHZlcmIgc3Bhd25zIGFcbiAqIHRoaXJkIGRhZW1vbi4gQm90aCBjb252ZW50aW9ucyBoYXZlIHRoaXMgaGF6YXJkIGFuZCBib3RoIGV4cHJlc3MgaXRcbiAqIGRpZmZlcmVudGx5OiBhc3Ryb2xhYmUgY29tcGFyZXMgdGhlIHBpZCBmaWxlJ3MgYnl0ZXMgdG8gaXRzIG93biBwaWQsXG4gKiBtYWdwaWUgcGFyc2VzIHRoZSBKU09OIHBvaW50ZXIgYW5kIGNvbXBhcmVzIGBzZXNzaW9uX2lkYC4gYGlkZW50aWZ5YCBpcyB3aGF0XG4gKiBtYWtlcyB0aG9zZSBvbmUgZnVuY3Rpb24g4oCUIGl0IHR1cm5zIHRoZSBmaWxlJ3MgYnl0ZXMgaW50byB0aGUgaWRlbnRpdHkgdG9cbiAqIGNvbXBhcmUsIGFuZCBpdCBkZWZhdWx0cyB0byB0aGUgdHJpbW1lZCBieXRlcyB0aGVtc2VsdmVzLlxuICpcbiAqIOKaoCBFdmVyeSBmYWlsdXJlIGlzIHN3YWxsb3dlZCBhbmQgcmVwb3J0ZWQgYXMgYGZhbHNlYDogdGhlIGZpbGUgYmVpbmcgZ29uZSxcbiAqIHVucmVhZGFibGUsIG9yIHVucGFyc2VhYmxlIGFsbCBtZWFuIHRoZSBzYW1lIHRoaW5nIGhlcmUg4oCUIGl0IGlzIG5vdCBvdXJzIHRvXG4gKiByZW1vdmUuIEFuIHVucGFyc2VhYmxlIHBvaW50ZXIgaXMgZGVsaWJlcmF0ZWx5IE5PVCB0cmVhdGVkIGFzIG91cnMsIHdoaWNoIGlzXG4gKiB0aGUgY29uc2VydmF0aXZlIGhhbGYgb2YgdGhlIHNhbWUgYG51bGxgLW5vdC1gMGAgcnVsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVubGlua0lmTWF0Y2hlcyhcbiAgcGF0aDogc3RyaW5nLFxuICBleHBlY3RlZDogc3RyaW5nLFxuICBpZGVudGlmeTogKHJhdzogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsID0gKHJhdykgPT4gcmF3LnRyaW0oKSxcbik6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIGlmICghZXhpc3RzU3luYyhwYXRoKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChpZGVudGlmeShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSAhPT0gZXhwZWN0ZWQpIHJldHVybiBmYWxzZTtcbiAgICB1bmxpbmtTeW5jKHBhdGgpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgaW4tcHJvY2VzcyBldmVudCBsb2cg4oCUIHRoZSBhcHBlbmQtb25seSwgcmVwbGF5YWJsZSBidWZmZXJcbiAqIGJlaGluZCBldmVyeSBzcGVsbCdzIGBHRVQgL2V2ZW50c2AgU1NFIHRhaWwuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgbWluZC1tYXBwZXInc1xuICogYHNjcmlwdHMvZXZlbnRzLnRzYCDigJQgdGhlIGNlbnN1cydzIGNvbnZlcmdlbmNlIHRhcmdldCAjMiwgYW5kIHRoZSBvbmx5IG9uZSBvZlxuICogdGhlIHNpeCBjb3BpZWQtaW4tcGxhY2UgYnVzZXMgdGhhdCBpcyBhIG1vZHVsZSwgaXMgYm91bmRlZCwgY2FycmllcyBhbiBlcG9jaCwgYW5kIGlzXG4gKiB1bml0LXRlc3RlZC4gVGhlIGZpdmUgb3RoZXJzIGFyZSB0aGUgc2FtZSB0d2VudHkgbGluZXMgd3JpdHRlbiBmaXZlIHRpbWVzLlxuICpcbiAqIOKUgOKUgCBUSEUgVEhSRUUgVEhJTkdTIFRISVMgRklYRVMg4oCUIFRXTyBCWSBDT05TVFJVQ1RJT04sIE9ORSBCWSBPUFQtSU4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICog4puUIFRIRSBIRUFESU5HIFVTRUQgVE8gU0FZIFwiVEhFIFRIUkVFIFRISU5HUyBUSElTIEZJWEVTIEJZIENPTlNUUlVDVElPTlwiIEFORFxuICogSVRFTSAyIElTIE5PVCBPTkUgT0YgVEhFTS4gQ29ycmVjdGVkIDIwMjYtMDktMDkgaW4gbWluZC1tYXBwZXIncyBwcmUtd29ya1xuICogKEQ3OSk6IGBlcG9jaGAgaXMgT1BUSU9OQUwgaGVyZSwgc28gTDYgaXMgY2xvc2VkIG9ubHkgZm9yIGEgY2FsbGVyIHRoYXQgYXNrcy5cbiAqIFRocmVlIGFkb3B0ZXJzIGhhdmUgc2luY2UgZGVjbGluZWQgdG8g4oCUIGltYWdvIChEMzkpLCBib3VudHkgKEQ0OCkgYW5kXG4gKiBncmFwZXZpbmUgKEQ3MCkg4oCUIHNvIHRoZSBkZWZlY3QgdGhlIGhlYWRpbmcgY2xhaW1lZCB0byBtYWtlIGltcG9zc2libGUgaXNcbiAqIGxpdmUgaW4gdGhlIHRyZWUsIGJ5IG9wdC1vdXQsIGFuZCB0aGUgb3ZlcmNsYWltIGlzIHdoYXQgaGlkIHRoYXQuIEl0ZW1zIDEgYW5kXG4gKiAzIEFSRSBieSBjb25zdHJ1Y3Rpb246IGEgY2FsbGVyIGNhbm5vdCBzd2l0Y2ggdGhlIGNhcCBvZmYgb3IgcmVhY2ggdGhlIGJ1ZmZlci5cbiAqXG4gKiDimqAgQU5EIE1JTkQtTUFQUEVSJ1MgT1dOIEJVUywgV0hJQ0ggVEhJUyBNT0RVTEUgQ09OVkVSR0VEIFRPV0FSRCwgVFlQRVMgVEhFXG4gKiBFUE9DSCBBUyBSRVFVSVJFRCBhbmQgc3RhbXBzIGl0IHVuY29uZGl0aW9uYWxseSDigJQgaXQgaXMgdGhlIHNwZWxsIGNlbnN1cyBMNlxuICogbmFtZXMgYXMgQ09SUkVDVC4gTWFraW5nIGl0IHJlcXVpcmVkIEhFUkUgaXMgbm90IHRoZSByZXBhaXI6IGl0IHdvdWxkIHJldmVyc2VcbiAqIEQzOSwgRDQ4IGFuZCBENzAuIFRoZSBob25lc3Qgc3RhdGVtZW50IGlzIHRoaXMgaGVhZGluZy5cbiAqXG4gKiDim5QgKipSRVNPTFZFRCBBVCBUSEFUIFNQRUxMJ1MgUE9SVCwgQU5EIFRIRSBESVNQT1NJVElPTiBJUyBSRUNPUkRFRCBIRVJFXG4gKiBCRUNBVVNFIEEgTE9TUyBUSEFUIExJVkVTIE9OTFkgSU4gQSBKT1VSTkFMIElTIEEgTE9TUyBOT0JPRFkgQ0FOIFNFRVxuICogKEQ3OS9EODUpLioqIG1pbmQtbWFwcGVyIGFkb3B0ZWQgdGhpcyBtb2R1bGUgaW4gUGhhc2UgNyBhbmQga2VwdCBpdHNcbiAqIGd1YXJhbnRlZSBXSVRIT1VUIEEgS0lUIENIQU5HRTogaXQgcGFzc2VzIGB7IGVwb2NoOiBjcnlwdG8ucmFuZG9tVVVJRCgpIH1gIGF0XG4gKiBpdHMgT05FIGNvbnN0cnVjdGlvbiBzaXRlIGFuZCByZS10aWdodGVucyBgZXBvY2hgIHRvIFJFUVVJUkVEIGluIGl0cyBvd25cbiAqIGxvY2FsIGZyYW1lIHR5cGUsIHNvIG5vdGhpbmcgaXRzIGJ1cyBlbWl0cyBjYW4gbGFjayBvbmUuIEtpdCBieXRlczogemVyby5cbiAqICoqU28gdGhlIGVwb2NoIGlzIGEgTE9TU1ktQ09QWSBwcm9wZXJ0eSB3aG9zZSBkaXNwb3NpdGlvbiBpcyBLRUVQLUxPQ0FMLCBub3RcbiAqIFJFU1RPUkUqKiDigJQgdGhlIG9ubHkgcHJvcGVydHkgb2YgdGhhdCBzcGVsbCdzIG93biBtb2R1bGUgdGhpcyBtb2R1bGUgY291bGRcbiAqIG5vdCBjYXJyeSBhbmQgZGlkIG5vdCBuZWVkIHRvLiBMNiBpcyBDTE9TRUQgZm9yIHRoZSB0d28gc3BlbGxzIHRoYXQgYXNrIGFuZFxuICogT1BFTiwgYnkgb3B0LW91dCwgZm9yIHRoZSB0aHJlZSB0aGF0IGRlY2xpbmU7IHRoYXQgYXN5bW1ldHJ5IGlzIHRoZSBob25lc3RcbiAqIHN0YXRlIGFuZCB0aGlzIGhlYWRpbmcgaXMgd2hlcmUgaXQgaXMgd3JpdHRlbi5cbiAqXG4gKiDimqAgKipBTkQgVEhFIEFET1BUSU9OIFJFTkFNRVMgQSBGSUVMRCBPTiBBTiBBRE9QVEVSJ1MgUFVCTElTSEVEIFdJUkUuKiogYGlkYFxuICogaXMgbmFtZWQgaW4gYEZyYW1lPFQ+YCBhbmQgaW4gdGhlIGVtaXQgbGl0ZXJhbCBiZWxvdywgc28gYSBzcGVsbCB3aG9zZSBidXNcbiAqIHNwZWxsZWQgdGhlIGN1cnNvciBhbnl0aGluZyBlbHNlIHBheXMgYSByZW5hbWUgYXQgZXZlcnkgcmVhZGVyIOKAlCBmb3JcbiAqIG1pbmQtbWFwcGVyLCAxNzMgb2NjdXJyZW5jZXMgYWNyb3NzIDUgc3VyZmFjZSBmaWxlcywgfjIwOSBhY3Jvc3MgfjMwIGJhY2tlbmRcbiAqIGZpbGVzLCBldmVyeSBKU09OTCBsaW5lIGl0cyBgdGFpbGAgd3JpdGVzIGludG8gYW4gYWdlbnQncyBwaXBlLCBhbmQgKHRoZSBvbmVcbiAqIG5vYm9keSBjb3VudGVkKSB0aGUgRklYVFVSRSBpbiBpdHMgb3duIGB0YWlsLnRlc3QudHNgLCB3aGljaCBXUklURVMgdGhlXG4gKiBlbnZlbG9wZSB3aGlsZSBzdGFuZGluZyBpbiBmb3IgdGhlIGRhZW1vbi4gVGhlIE5FU1RJTkcgaXMgbm90IGZvcmNlZCDigJRcbiAqIGBGcmFtZTxUPmAgaXMgZ2VuZXJpYywgYW5kIG1pbmQtbWFwcGVyIGtlcHQgYHtraW5kLCBwYXlsb2FkfWAgbmVzdGVkIHdoZXJlIGFsbFxuICogZml2ZSBlYXJsaWVyIGFkb3B0ZXJzIGZsYXR0ZW4gYnkgaWRpb20uICoqQW4gaWRpb20gZml2ZSBzaWJsaW5ncyBzaGFyZSBpc1xuICogaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBhIGNvbnRyYWN0IHVudGlsIHlvdSBvcGVuIHRoZSB0eXBlKiogKEQ4MSwgRDg2KS5cbiAqXG4gKiAqKjEgwrcgTDUg4oCUIHRoZSBidWZmZXIgaXMgYm91bmRlZC4qKiBGaXZlIGRhZW1vbnMgYXBwZW5kIHRvIGFuIGFycmF5IGZvciB0aGVcbiAqIHdob2xlIGxpZmUgb2YgdGhlIHByb2Nlc3MuIFRoZSB3aW5kb3cgaXMgYSBSRVBMQVkgd2luZG93IGZvciByZWNvbm5lY3RzIHdpdGhpbiBvbmVcbiAqIGRhZW1vbidzIGxpZmV0aW1lLCBub3QgYSBkdXJhYmxlIGxvZzsgYSBjYXAgaXMgdGhlIGhvbmVzdCBzaGFwZS5cbiAqXG4gKiAqKjIgwrcgTDYg4oCUIGEgZnJhbWUgY2FycmllcyBhbiBlcG9jaCwgV0hFTiBUSEUgQ0FMTEVSIEFTS1MgRk9SIE9ORSAob3B0LWluLFxuICogbm90IGNvbnN0cnVjdGlvbiDigJQgc2VlIGFib3ZlKS4qKiBBZnRlciBhIHJlc3RhcnQgdGhlIGlkcyBzdGFydCBhZ2FpbiBhdCAxLCBzb1xuICogYSByZXN1bWluZyBjbGllbnQgY2Fubm90IHRlbGwgYSBzdGFsZSB3YXRlcm1hcmsgZnJvbSBhIGZyZXNoIG9uZSBieSBpZCBhbG9uZS5cbiAqXG4gKiAqKjMgwrcgQSBTVEFMRSBXQVRFUk1BUksgUkVQTEFZUyBGUk9NIFRIRSBCRUdJTk5JTkcsIGFuZCB0aGlzIGlzIHRoZSBoYWxmIHRoZVxuICogY2xpZW50IGNhbm5vdCBkby4qKiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IGEgdGFpbCB0aGF0IHJlc3VtZXMgYXRcbiAqIGBzaW5jZT08bGFzdCBpZCBvZiB0aGUgcHJldmlvdXMgZGFlbW9uPmAgYWdhaW5zdCBhIHJlc3RhcnRlZCBkYWVtb24gcmVjZWl2ZXNcbiAqIE5PVEhJTkcg4oCUIHRoZSBuZXcgZGFlbW9uJ3MgYHJlYWR5YCBpcyBpZCAxLCB3aGljaCBpcyBub3QgYD4gc2luY2VgLCBzbyB0aGVcbiAqIGZpbHRlciBkcm9wcyBpdCwgc28gbm8gZnJhbWUgYXJyaXZlcywgc28gdGhlIGNsaWVudCdzIGVwb2NoIGNoZWNrIG5ldmVyIHJ1bnNcbiAqIGFuZCB0aGUgdGFpbCBzaXRzIGNvbm5lY3RlZCBhbmQgc2lsZW50IHVudGlsIHRoZSBuZXcgZGFlbW9uIGhhcyBlbWl0dGVkIGFzXG4gKiBtYW55IGV2ZW50cyBhcyB0aGUgb2xkIG9uZSBkaWQuIFN0YW1waW5nIGFuIGVwb2NoIGFsb25lIGRvZXMgTk9UIGNsb3NlIHRoYXRcbiAqIGdhcDogdGhlIGVwb2NoIHJpZGVzIGEgZnJhbWUsIGFuZCB0aGUgYnVnIGlzIHRoYXQgbm8gZnJhbWUgaXMgc2VudC4gU29cbiAqIGBzdWJzY3JpYmVgIHRyZWF0cyBgc2luY2UgPiBjdXJzb3JgIGFzIFwidGhpcyBjdXJzb3IgaXMgZnJvbSBhbm90aGVyIHByb2Nlc3NcIlxuICogYW5kIHJlcGxheXMgd2hvbGUuIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC90YWlsLnRlc3QudHNgJ3MgZXBvY2ggY2VsbCBpcyB0aGVcbiAqIGV4ZWN1dGFibGUgc3BlYyBvZiB0aGUgY2xpZW50IGhhbGYgYW5kIHNob3dzIHRoZSByZWNvbm5lY3Qgc3RpbGwgY2FycnlpbmcgdGhlXG4gKiBzdGFsZSBjdXJzb3Ig4oCUIGRldGVjdGlvbiBoYXBwZW5zIG9uIHdoYXQgaXMgUkVDRUlWRUQuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgRE9FUyBOT1QgQURPUFQgVEhJUywgQU5EIFRIRSBSRUZVU0FMIElTIFBBUlQgT0YgVEhFIFJVTElORyDilIDilIBcbiAqXG4gKiBSRUpFQ1QtU1RSVUNUVVJBTCwgcnVsZWQgYXQgZ3JhcGV2aW5lJ3MgcG9ydCAoUGhhc2UgNiwgMjAyNi0wOS0wOTsgRDY4KS4gTm90XG4gKiBcIm5vIHN1YmplY3RcIiDigJQgZ3JhcGV2aW5lIEhBUyBhbiBldmVudCBidXMgYW5kIGl0IGlzIHRoZSBidXNpZXN0IHRoaW5nIGluIHRoZVxuICogc3BlbGwg4oCUIGJ1dCB0aGUgdHdvIHNoYXBlcyBjYW5ub3QgYmUgY29uc3RydWN0ZWQgZnJvbSBlYWNoIG90aGVyOlxuICpcbiAqICAgdGhpcyBtb2R1bGUgIG9uZSBwcm9jZXNzLXdpZGUgYXJyYXkgY2FwcGVkIGF0IFJFUExBWV9CVUZGRVJfU0laRSwgd2l0aCBvbmVcbiAqICAgICAgICAgICAgICAgIG1vbm90b25pYyBgc2VxYCwgYW5kIHRoZSBoZWFkZXIgdGhyZWUgcGFyYWdyYXBocyB1cCBzYXlzIGluIGFzXG4gKiAgICAgICAgICAgICAgICBtYW55IHdvcmRzIHRoYXQgaXQgaXMgYSBSRVBMQVkgd2luZG93IGZvciByZWNvbm5lY3RzIHdpdGhpbiBvbmVcbiAqICAgICAgICAgICAgICAgIGRhZW1vbidzIGxpZmV0aW1lLCBOT1QgYSBkdXJhYmxlIGxvZy5cbiAqICAgZ3JhcGV2aW5lICAgIE4gZHVyYWJsZSBhcHBlbmQtb25seSBgLmpzb25sYCBmaWxlcywgb25lIHBlciBuYW1lZCBjaGFubmVsLFxuICogICAgICAgICAgICAgICAgZWFjaCB3aXRoIGl0cyBvd24gYG5leHRfaWRgLCByZXBsYXllZCBmcm9tIGRpc2sgYnlcbiAqICAgICAgICAgICAgICAgIGByZWFkQmFja2xvZ2AsIHN1cnZpdmluZyByZXN0YXJ0LCBgcm9sbGAsIGFyY2hpdmUgYW5kIGNsZWFyLlxuICpcbiAqICoqVGhlIHJlYWRlciB0aGF0IG1ha2VzIHRoZW0gaW5jb21wYXRpYmxlLCBhcyBhIG1lYXN1cmVtZW50IHJhdGhlciB0aGFuIGFuXG4gKiBhc3NlcnRpb246KiogZ3JhcGV2aW5lJ3MgYGxvYWRDaGFubmVsKClgIGRlcml2ZXMgYG5leHRfaWRgIGFzIGEgSElHSC1XQVRFUlxuICogTUFSSyBvdmVyIGV2ZXJ5IHBhcnNlYWJsZSBsaW5lIG9mIHRoZSBjaGFubmVsJ3MgZmlsZSBvbiBib290LiBUaGVyZSBpcyBub1xuICogYXJyYXkgdG8gYmUgdGhhdCBtYXJrIG9mLCBhbmQgbm8gY2FwIHRoYXQgd291bGQgbm90IHNpbGVudGx5IGRpc2NhcmQgaGlzdG9yeVxuICogYSBjYWxsZXIgY2FuIHN0aWxsIGFzayBmb3IgYnkgaWQuIEl0IGlzIHRoZSB0aGluZyB0aGlzIG1vZHVsZSdzIG93biBoZWFkZXJcbiAqIHNheXMgaXQgaXMgZGVsaWJlcmF0ZWx5IG5vdC5cbiAqXG4gKiAqKlRoZSB3aWRlbmluZyBOT1QgZG9uZSwgd2l0aCBpdHMgY29zdDoqKiBhZG1pdHRpbmcgYSBwZXItY2hhbm5lbCBkdXJhYmxlXG4gKiBzdG9yZSB3b3VsZCBjaGFuZ2UgYGNyZWF0ZUV2ZW50TG9nYCdzIHN0b3JhZ2UgYW5kIGl0cyBgc3Vic2NyaWJlYCBjb250cmFjdCBmb3JcbiAqIGZpdmUgb3RoZXIgZGFlbW9ucywgcmUtZW1pdHRpbmcgU0lYIGFydGlmYWN0cyBhY3Jvc3MgRklWRSBzcGVsbHMsIGVhY2ggb3dlZCBhXG4gKiBkcml2ZSDigJQgcGFpZCBieSBwb3J0cyB0aGF0IGFyZSBhbHJlYWR5IGZpbmlzaGVkIGFuZCBieSBhZ2VudHMgbm90IGluIHRoZSByb29tLlxuICogQSB3aWRlbmluZyByZW1haW5zIGF2YWlsYWJsZSBhcyBpdHMgb3duIGFyZ3VlZCBkZWNpc2lvbiB3aXRoIGl0cyBvd25cbiAqIGJsYXN0LXJhZGl1cyBjb3VudDsgaXQgaXMgbmV2ZXIgYSBzdGVwIGluc2lkZSBhIHBvcnQuXG4gKlxuICog4pqgIEFORCBUSEUgYGVwb2NoYCBBQk9WRSBJUyBUSEUgU0hBUlBFU1QgSEFMRiBPRiBXSFkgKEQ3MCkuIEdyYXBldmluZSdzIGlkcyBhcmVcbiAqIFJFQ09WRVJFRCBhY3Jvc3MgYSByZXN0YXJ0LCBzbyB0aGUgY29uZGl0aW9uIHBhcmFncmFwaCAyIGRlc2NyaWJlcyDigJQgaWRzXG4gKiBzdGFydGluZyBhZ2FpbiBhdCAxIOKAlCBjYW5ub3Qgb2NjdXIgdGhlcmUsIGFuZCBzdGFtcGluZyBvbmUgYW55d2F5IGlzIG5vdFxuICogaW5lcnQ6IGB0YWlsRXZlbnRzYCdzIGBvbkVwb2NoQ2hhbmdlYCBzZXRzIHRoZSBjdXJzb3IgdG8gMCwgYW5kIGdyYXBldmluZSdzXG4gKiB0YWlsIHJvdXRlIGFuc3dlcnMgYHNpbmNlPTBgIHdpdGggdGhlIFdIT0xFIGNoYW5uZWwgbG9nIG9mZiBkaXNrLCBpbnRvIGFuXG4gKiBhZ2VudCdzIHBpcGUsIG9uIGV2ZXJ5IGByb2xsYC4gVGhlIGVwb2NoJ3MgY2xpZW50LXNpZGUgYWN0aW9uIGlzIFwieW91ciBjdXJzb3JcbiAqIGlzIHdvcnRobGVzcywgc3RhcnQgb3ZlclwiLCBhbmQgdGhhdCBpcyBzYWZlIG9ubHkgd2hlcmUgc3RhcnRpbmcgb3ZlciBjb3N0cyBhXG4gKiBib3VuZGVkIGluLW1lbW9yeSByZXBsYXkgd2luZG93LlxuICovXG5cbi8qKiBUaGUgZGVmYXVsdCByZXBsYXkgd2luZG93LCBpbmhlcml0ZWQgZnJvbSBtaW5kLW1hcHBlcidzIG1lYXN1cmVkIGNhcC4gKi9cbmV4cG9ydCBjb25zdCBSRVBMQVlfQlVGRkVSX1NJWkUgPSAxMDAwO1xuXG4vKiogQSBmcmFtZSBhcyBpdCBnb2VzIG9uIHRoZSB3aXJlOiB0aGUgY2FsbGVyJ3MgcGF5bG9hZCBwbHVzIGEgbW9ub3RvbmljIGBpZGAsXG4gKiAgcGx1cyBhbiBgZXBvY2hgIHdoZW4gdGhlIGxvZyB3YXMgZ2l2ZW4gb25lLiAqL1xuZXhwb3J0IHR5cGUgRnJhbWU8VD4gPSBUICYgeyBpZDogbnVtYmVyOyBlcG9jaD86IHN0cmluZyB9O1xuXG5leHBvcnQgaW50ZXJmYWNlIEV2ZW50TG9nPFQ+IHtcbiAgLyoqIEFwcGVuZCBvbmUgZnJhbWUsIGZhbiBpdCBvdXQgdG8gbGl2ZSBzdWJzY3JpYmVycywgYW5kIHJldHVybiBpdC4gKi9cbiAgZW1pdChtc2c6IFQpOiBGcmFtZTxUPjtcbiAgLyoqXG4gICAqIFJlcGxheSBldmVyeXRoaW5nIGFmdGVyIGBzaW5jZWAsIHRoZW4gc3RheSBzdWJzY3JpYmVkLiBSZXR1cm5zIGFuXG4gICAqIHVuc3Vic2NyaWJlIGZ1bmN0aW9uLlxuICAgKlxuICAgKiDim5QgUkVQTEFZIEFORCBTVUJTQ1JJQkUgQVJFIE9ORSBDQUxMIE9OIFBVUlBPU0UuIERvaW5nIHRoZW0gaW4gdHdvIHN0ZXBzXG4gICAqIGxlYXZlcyBhIHdpbmRvdyBpbiB3aGljaCBhbiBlbWl0IGxhbmRzIGJldHdlZW4gdGhlIHJlcGxheSBsb29wIGFuZCB0aGVcbiAgICogYGFkZGAsIGFuZCB0aGF0IGZyYW1lIGlzIGRlbGl2ZXJlZCB0byBub2JvZHkg4oCUIHRoZSBzaGFwZSBmaXZlIGRhZW1vbnMgaGF2ZSxcbiAgICogc3Vydml2ZWQgYnkgbm90aGluZyBidXQgdGhlIHNpbmdsZS10aHJlYWRlZCBldmVudCBsb29wIGhhcHBlbmluZyB0byBjbG9zZVxuICAgKiBpdC4gRGVwZW5kaW5nIG9uIHRoYXQgaXMgZGVwZW5kaW5nIG9uIGFuIGltcGxlbWVudGF0aW9uIGRldGFpbCBvZiB0aGVcbiAgICogcnVudGltZSByYXRoZXIgdGhhbiBvbiB0aGUgY29kZS5cbiAgICovXG4gIHN1YnNjcmliZShzaW5jZTogbnVtYmVyLCBsaXN0ZW5lcjogKGZyYW1lOiBGcmFtZTxUPikgPT4gdm9pZCk6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgaGlnaGVzdCBpZCBlbWl0dGVkIHNvIGZhciDigJQgd2hhdCBgR0VUIC9zdGF0ZWAgcmV0dXJucyBhcyBgY3Vyc29yYC4gKi9cbiAgY3Vyc29yKCk6IG51bWJlcjtcbiAgLyoqIFRoZSBlcG9jaCBzdGFtcGVkIG9uIGV2ZXJ5IGZyYW1lLCBvciBgdW5kZWZpbmVkYCBpZiBub25lIHdhcyBjb25maWd1cmVkLiAqL1xuICByZWFkb25seSBlcG9jaDogc3RyaW5nIHwgdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRXZlbnRMb2c8VCBleHRlbmRzIG9iamVjdD4oXG4gIG9wdHM6IHsgZXBvY2g/OiBzdHJpbmc7IGJ1ZmZlclNpemU/OiBudW1iZXIgfSA9IHt9LFxuKTogRXZlbnRMb2c8VD4ge1xuICBjb25zdCBidWZmZXJTaXplID0gb3B0cy5idWZmZXJTaXplID8/IFJFUExBWV9CVUZGRVJfU0laRTtcbiAgY29uc3QgZXBvY2ggPSBvcHRzLmVwb2NoO1xuICBjb25zdCBidWZmZXI6IEFycmF5PEZyYW1lPFQ+PiA9IFtdO1xuICBjb25zdCBsaXN0ZW5lcnMgPSBuZXcgU2V0PChmcmFtZTogRnJhbWU8VD4pID0+IHZvaWQ+KCk7XG4gIGxldCBzZXEgPSAwO1xuXG4gIHJldHVybiB7XG4gICAgZXBvY2gsXG5cbiAgICBlbWl0KG1zZykge1xuICAgICAgc2VxICs9IDE7XG4gICAgICAvLyDim5QgVEhFIE1PTk9UT05JQyBJRCBXSU5TIE9WRVIgQU5ZVEhJTkcgSU4gVEhFIFBBWUxPQUQsIEFORCBVTlRJTCBOT1cgSVRcbiAgICAgIC8vIE9OTFkgQ0xBSU1FRCBUTy4gQm90aCBhZG9wdGluZyBkYWVtb25zIHdyb3RlIGB7IGlkOiArK3NlcSwgLi4ubXNnIH1gXG4gICAgICAvLyB1bmRlciBhIGNvbW1lbnQgc2F5aW5nIFwidGhlIG1vbm90b25pYyBgaWRgIE1VU1Qgd2luIG92ZXIgYW55IGBpZGAgaW5cbiAgICAgIC8vIHRoZSBwYXlsb2FkLCBzbyBjYWxsZXJzIGNhcnJ5IGEgcHJvamVjdCBpZGVudGlmaWVyIGFzIGBwcm9qZWN0SWRgLFxuICAgICAgLy8gbmV2ZXIgYGlkYFwiIOKAlCBidXQgc3ByZWFkIG9yZGVyIG1lYW5zIGEgcGF5bG9hZCBgaWRgIG92ZXJyb2RlIHRoZVxuICAgICAgLy8gY3Vyc29yLCBzaWxlbnRseSwgYW5kIHRoZSBjb252ZW50aW9uIGluIHRoZSBjb21tZW50IHdhcyB0aGUgb25seSB0aGluZ1xuICAgICAgLy8gaG9sZGluZyBpdC4gVGhlIGxpdGVyYWwga2VlcHMgYGlkYCBGSVJTVCBzbyB0aGUgd2lyZSBrZXkgb3JkZXIgaXNcbiAgICAgIC8vIHVuY2hhbmdlZDsgdGhlIGFzc2lnbm1lbnQgYWZ0ZXIgdGhlIHNwcmVhZCBpcyB3aGF0IG1ha2VzIHRoZSBzZW50ZW5jZVxuICAgICAgLy8gdHJ1ZS4gYGVwb2NoYCBpcyBzdGFtcGVkIHRoZSBzYW1lIHdheSBhbmQgZm9yIHRoZSBzYW1lIHJlYXNvbi5cbiAgICAgIGNvbnN0IGZyYW1lID0geyBpZDogc2VxLCAuLi5tc2cgfSBhcyBGcmFtZTxUPjtcbiAgICAgIGZyYW1lLmlkID0gc2VxO1xuICAgICAgaWYgKGVwb2NoICE9PSB1bmRlZmluZWQpIGZyYW1lLmVwb2NoID0gZXBvY2g7XG5cbiAgICAgIGJ1ZmZlci5wdXNoKGZyYW1lKTtcbiAgICAgIGlmIChidWZmZXIubGVuZ3RoID4gYnVmZmVyU2l6ZSkgYnVmZmVyLnNoaWZ0KCk7XG4gICAgICBmb3IgKGNvbnN0IGxpc3RlbmVyIG9mIGxpc3RlbmVycykgbGlzdGVuZXIoZnJhbWUpO1xuICAgICAgcmV0dXJuIGZyYW1lO1xuICAgIH0sXG5cbiAgICBzdWJzY3JpYmUoc2luY2UsIGxpc3RlbmVyKSB7XG4gICAgICAvLyBTZWUgdGhlIGhlYWRlciwgcG9pbnQgMzogYSBjdXJzb3IgYmV5b25kIG91ciBvd24gaXMgYSBjdXJzb3IgZnJvbSBhXG4gICAgICAvLyBQUklPUiBQUk9DRVNTLCBhbmQgdGhlIG9ubHkgdXNlZnVsIHJlYWRpbmcgb2YgaXQgaXMgXCJyZXBsYXkgd2hvbGVcIi5cbiAgICAgIC8vXG4gICAgICAvLyDimqAgQSBOT04tRklOSVRFIENVUlNPUiBBTFNPIE1FQU5TIFwiRlJPTSBUSEUgU1RBUlRcIiwgd2hpY2ggdGhlIGNvcGllcyBnb3RcbiAgICAgIC8vIHdyb25nIGJ5IGFjY2lkZW50OiB0aGV5IHdyb3RlIGBwYXJzZUludChwYXJhbSA/PyBcIi0xXCIpYCBhbmQgY29tcGFyZWRcbiAgICAgIC8vIGBpZCA+IHNpbmNlYCwgc28gYSB0eXBvJ2QgYD9zaW5jZT14YCBwcm9kdWNlZCBgTmFOYCwgZXZlcnkgY29tcGFyaXNvblxuICAgICAgLy8gd2FzIGZhbHNlLCBhbmQgdGhlIHRhaWwgb3BlbmVkIEVNUFRZIGFuZCBzdGF5ZWQgY29ubmVjdGVkIOKAlCB0aGUgc2FtZVxuICAgICAgLy8gc2lsZW50LWFuZC1jb25uZWN0ZWQgc3ltcHRvbSBhcyB0aGUgc3RhbGUgd2F0ZXJtYXJrLCBmcm9tIGEgZGlmZmVyZW50XG4gICAgICAvLyBjYXVzZS4gQWJzZW50IGFuZCB1bnBhcnNlYWJsZSBhcmUgdGhlIHNhbWUgcmVxdWVzdCBoZXJlLlxuICAgICAgY29uc3QgZnJvbSA9ICFOdW1iZXIuaXNGaW5pdGUoc2luY2UpIHx8IHNpbmNlID4gc2VxID8gLTEgOiBzaW5jZTtcbiAgICAgIGZvciAoY29uc3QgZnJhbWUgb2YgYnVmZmVyKSB7XG4gICAgICAgIGlmIChmcmFtZS5pZCA+IGZyb20pIGxpc3RlbmVyKGZyYW1lKTtcbiAgICAgIH1cbiAgICAgIGxpc3RlbmVycy5hZGQobGlzdGVuZXIpO1xuICAgICAgcmV0dXJuICgpID0+IHtcbiAgICAgICAgbGlzdGVuZXJzLmRlbGV0ZShsaXN0ZW5lcik7XG4gICAgICB9O1xuICAgIH0sXG5cbiAgICBjdXJzb3IoKSB7XG4gICAgICByZXR1cm4gc2VxO1xuICAgIH0sXG4gIH07XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGRhZW1vbiBsaWZlY3ljbGUgdGFpbDogdGhlIGlkbGUtY2xvc2UgZGVjaXNpb24sIHRoZSBzd2VlcFxuICogdGhhdCBtYWtlcyBpdCwgYW5kIHRoZSBib3VuZGVkIHRlYXJkb3duLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIGJvdW50eSDigJQgdGhlIGNlbnN1cydzXG4gKiBjb252ZXJnZW5jZSB0YXJnZXQgIzMg4oCUIHdpdGggYXN0cm9sYWJlJ3MgYHRpbWVvdXRNcyA+IDBgIGd1YXJkIGZvbGRlZCBpbixcbiAqIHdoaWNoIGlzIHRoZSBvbmUgdGhpbmcgYm91bnR5J3MgY29weSBkb2VzIG5vdCBleHByZXNzLlxuICpcbiAqIOKUgOKUgCDim5QgR1JBUEVWSU5FIEFET1BUUyBgZHJhaW5BbmRTdG9wYCBBTkQgTk9USElORyBFTFNFIEhFUkUg4oCUIFNQTElUIFBFUiBFWFBPUlRcbiAqXG4gKiBSdWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLCBhbmQgaXQgaXMgd3JpdHRlbiBkb3duXG4gKiBiZWNhdXNlIGEgcm93IGlzIGEgTU9EVUxFIGFuZCBcInBhcnRpYWxcIiBpcyBub3QgYW4gYW5zd2VyIHVudGlsIGl0IHNheXMgd2hpY2hcbiAqIGV4cG9ydHMuIEdyYXBldmluZSBpcyBsb25nLXJ1bm5pbmcsIHNvIG5vdGhpbmcgYWJvdXQgaXRzIGxpZmVjeWNsZSBtYWtlcyB0aGlzXG4gKiBtb2R1bGUgcmVhZCBhcyBpbmFwcGxpY2FibGUg4oCUIGFuZCB0d28gb2YgaXRzIHRocmVlIGV4cG9ydHMgc3RpbGwgaGF2ZSBub1xuICogc3ViamVjdCB0aGVyZTpcbiAqXG4gKiAgIGBzaG91bGRJZGxlQ2xvc2VgICAgICAgTk8gU1VCSkVDVC4gR3JhcGV2aW5lIHJ1bnMgbm8gaWRsZSBzd2VlcCBhbmQgaGFzIG5vXG4gKiAgIGBzdGFydEhvdXNla2VlcGluZ2AgICAgYC0tdGltZW91dGA7IGl0IGlzIGEgYnJva2VyIHRoYXQgc3RhbmRzIHVudGlsIGBzdG9wYFxuICogICAgICAgICAgICAgICAgICAgICAgICAgIChgREVMRVRFIC9gKSBvciBhIHNpZ25hbCwgYW5kIGl0IHRha2VzIG5vIHNuYXBzaG90LlxuICogICAgICAgICAgICAgICAgICAgICAgICAgIEFkb3B0aW5nIHRoZSBwYWlyLW1hbmFnZXIgd291bGQgbWVhbiB3cml0aW5nIGEgbm8tb3BcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgdG91Y2hgIGFuZCBhIGBzdWJzY3JpYmVyQ291bnRgIHRoYXQgZXhpc3RzIG9ubHkgdG9cbiAqICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gYSBudW1iZXIgbm9ib2R5IGFjdHMgb24g4oCUIHR3byBsaWVzIHRvIGdhaW4gYVxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBjbGVhckludGVydmFsYC5cbiAqICAgYGRyYWluQW5kU3RvcGAgICAgICAgICBBRE9QVEVELCBhbmQgaXQgaXMgYSBERS1EVVBMSUNBVElPTiByYXRoZXIgdGhhbiBhXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgZ2FpbjogZ3JhcGV2aW5lJ3MgdGVhcmRvd24gYWxyZWFkeSBXQVNcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgUHJvbWlzZS5yYWNlKFtzZXJ2ZXIuc3RvcCh0cnVlKSwgMjAwIG1zXSlgLCB3aGljaCBpc1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBzdG9wTXNgIGV4YWN0bHkuXG4gKlxuICog4pqgICoqQU5EIElUIElTIENBTExFRCBXSVRIIE5PIGBjbGllbnRzYCwgV0hJQ0ggSVMgQSBNRUFTVVJFTUVOVCwgTk9UIEFOXG4gKiBPVkVSU0lHSFQuKiogVGhpcyBtb2R1bGUgY2xvc2VzIGEgaGVsZCBjb25uZWN0aW9uIGJ5IGNhbGxpbmcgYGNsaWVudC5jbG9zZSgpYDtcbiAqIGdyYXBldmluZSdzIHN1YnNjcmliZXIgcmVjb3JkcyBhcmUgYHthbGlhcywgaHVtYW4sIGx1cmssIHNlbmR9YCBhbmQgY2Fycnkgbm9cbiAqIGBjbG9zZWAg4oCUIGl0cyBwZXItc3RyZWFtIHRlYXJkb3duIGlzIGEgY2xvc3VyZSBzdGFzaGVkIG9uIHRoZSBSZWFkYWJsZVN0cmVhbVxuICogY29udHJvbGxlciwgcmVhY2hhYmxlIG9ubHkgZnJvbSBgY2FuY2VsKClgLiBUaGVyZSBpcyBub3RoaW5nIHRvIGhhbmQgdGhlXG4gKiBhcmd1bWVudC4gYHNzZS50c2AncyBoZWFkZXIgY2FycmllcyB0aGUgcmVzdCBvZiB0aGF0IHJ1bGluZywgaW5jbHVkaW5nIHRoZVxuICogd2lkZW5pbmcgbm90IGRvbmUgYW5kIGl0cyBjb3N0IChzaXggYXJ0aWZhY3RzIGFjcm9zcyBmaXZlIHNwZWxscykuXG4gKlxuICog4pqgIEdyYXBldmluZSBhbHNvIHBhc3NlcyBgZ3JhY2VNczogMGAuIE5vdCBhIGRpc2FncmVlbWVudCB3aXRoIHRoZSBncmFjZVxuICogcGVyaW9kOiBpdCBlbWl0cyBubyBmYXJld2VsbCBmcmFtZSBhdCBkYWVtb24gc2h1dGRvd24sIGFuZCBpdHMgYERFTEVURSAvYFxuICogYWxyZWFkeSByZXR1cm5zIHRoZSByZXNwb25zZSBhbmQgc2NoZWR1bGVzIHRoZSB0ZWFyZG93biAxMCBtcyBsYXRlciwgc28gaXRzXG4gKiBmbHVzaCB3aW5kb3cgc2l0cyBhdCB0aGUgcm91dGUgcmF0aGVyIHRoYW4gaW4gdGhlIGRyYWluLlxuICovXG5cbmltcG9ydCB0eXBlIHsgU3NlQ2xpZW50cyB9IGZyb20gXCIuL3NzZS50c1wiO1xuXG4vKipcbiAqIFNob3VsZCB0aGUgZGFlbW9uIGlkbGUtY2xvc2U/XG4gKlxuICog4puUICoqYHN1YnNjcmliZXJDb3VudGAgSVMgQSBSRVFVSVJFRCBBUkdVTUVOVCwgQU5EIFRIQVQgSVMgVEhFIFdIT0xFIFBPSU5ULioqXG4gKiBUaGlzIGNsb3NlcyBjZW5zdXMgZGVmZWN0ICoqTDEqKiBieSBjb25zdHJ1Y3Rpb246IGdsYW1vdXIsIGltYWdvIGFuZCBtYWdwaWVcbiAqIGNvdW50ZWQgdGhlaXIgaWRsZSBmbG9vciBkb3duIHdoaWxlIGFuIGFnZW50IGhlbGQgYSB0YWlsIG9wZW4sIHNvIGFuIGFnZW50XG4gKiB3YXRjaGluZyBhIHF1aWV0IGJvYXJkIHdhcyBraWxsZWQgV0lUSCBJVFMgQ09OTkVDVElPTiBPUEVOLiBUaGVyZSBpcyBub1xuICogb3ZlcmxvYWQgb2YgdGhpcyBmdW5jdGlvbiB0aGF0IGNhbm5vdCBzZWUgaXRzIHN1YnNjcmliZXJzLCBzbyB0aGUgZGVmZWN0XG4gKiBjYW5ub3QgYmUgcmUtZXhwcmVzc2VkIGJ5IGEgY2FsbGVyIHdobyBmb3JnZXRzLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0NBUiBJVCBDQU1FIFdJVEgsIHJlLWhvbWVkIGZyb20gYm91bnR5IHZlcmJhdGltIGluIHN1YnN0YW5jZToqKlxuICogYSBib2FyZCBvbmx5IGNvdW50cyBpdHMgaWRsZSBmbG9vciBkb3duIHdoaWxlIFVOV0FUQ0hFRC4gQSBsaXZlIHN1YnNjcmliZXIg4oCUXG4gKiBhIGJyb3dzZXIgV2ViU29ja2V0LCBvciBhbiBhZ2VudCBTU0UgdGFpbCBvbiBgL2V2ZW50c2Ag4oCUIGtlZXBzIGl0IG9wZW5cbiAqIGluZGVmaW5pdGVseS4gU28gYHRpbWVvdXRgIG1lYW5zIFwibGluZ2VyIHRoaXMgbG9uZyBhZnRlciB0aGUgTEFTVCBzdWJzY3JpYmVyXG4gKiBsZWF2ZXNcIiwgTk9UIFwibWF4aW11bSBpZGxlIHdoaWxlIGNvbm5lY3RlZFwiLiBUaGUgc3dlZXAgYmVsb3cgYWxzbyB0b3VjaGVzIHRoZVxuICogYWN0aXZpdHkgY2xvY2sgb24gZXZlcnkgdGljayB3aGlsZSB3YXRjaGVkLCBzbyBvbmNlIHVud2F0Y2hlZCB0aGUgZmxvb3JcbiAqIGNvdW50cyBmcm9tIHRoYXQgbGFzdCBkaXNjb25uZWN0IGFuZCBub3QgZnJvbSB0aGUgbGFzdCByZXF1ZXN0LlxuICpcbiAqIOKaoCBgdGltZW91dE1zIDw9IDBgIG1lYW5zIE5FVkVSLCB3aGljaCBpcyBhc3Ryb2xhYmUncyBzdGFuZGluZy1vYnNlcnZhdG9yeVxuICogZGVmYXVsdCBhbmQgaXMgd2h5IHRoZSBndWFyZCBpcyBoZXJlIHJhdGhlciB0aGFuIGF0IGl0cyBvbmUgY2FsbCBzaXRlOiBhXG4gKiBzaW5nbGV0b24gZGFlbW9uIGlzIG1lYW50IHRvIHN0YW5kIHVudGlsIGl0IGlzIGV4cGxpY2l0bHkgY2xvc2VkLCBhbmQgYVxuICogYD49IDBgIGNvbXBhcmlzb24gd291bGQgY2xvc2UgaXQgb24gdGhlIGZpcnN0IHRpY2suXG4gKlxuICogQ2xvY2stZnJlZSBhbmQgZnMtZnJlZSwgc28gaXQgaXMgdGVzdGFibGUgd2l0aG91dCBhIGRhZW1vbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZElkbGVDbG9zZShcbiAgc3Vic2NyaWJlckNvdW50OiBudW1iZXIsXG4gIGlkbGVNczogbnVtYmVyLFxuICB0aW1lb3V0TXM6IG51bWJlcixcbik6IGJvb2xlYW4ge1xuICBpZiAodGltZW91dE1zIDw9IDApIHJldHVybiBmYWxzZTtcbiAgaWYgKHN1YnNjcmliZXJDb3VudCA+IDApIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGlkbGVNcyA+PSB0aW1lb3V0TXM7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSG91c2VrZWVwaW5nT3B0aW9ucyB7XG4gIC8qKiDim5QgUkVRVUlSRUQuIFNlZSBgc2hvdWxkSWRsZUNsb3NlYCDigJQgdGhpcyBpcyB3aGF0IGNsb3NlcyBMMS4gKi9cbiAgc3Vic2NyaWJlckNvdW50OiAoKSA9PiBudW1iZXI7XG4gIC8qKiBNaWxsaXNlY29uZHMgc2luY2UgdGhlIGxhc3QgYWN0aXZpdHkuICovXG4gIGlkbGVNczogKCkgPT4gbnVtYmVyO1xuICAvKiogUmVzZXQgdGhlIGFjdGl2aXR5IGNsb2NrLiBDYWxsZWQgb24gZXZlcnkgdGljayB0aGF0IGhhcyBhIHN1YnNjcmliZXIuICovXG4gIHRvdWNoOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGNvbmZpZ3VyZWQgaWRsZSB0aW1lb3V0IGluIG1zOyBgMGAgKG9yIGxlc3MpIG1lYW5zIG5ldmVyLiAqL1xuICB0aW1lb3V0TXM6IG51bWJlcjtcbiAgLyoqIEZpcmVkIG9uY2Ugd2hlbiB0aGUgZGFlbW9uIHNob3VsZCBjbG9zZSBpdHNlbGYuICovXG4gIG9uSWRsZUNsb3NlOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGRlYm91bmNlZCBzbmFwc2hvdCwgaWYgdGhlIHNwZWxsIGhhcyBvbmUuICovXG4gIHNuYXBzaG90Pzoge1xuICAgIGRpcnR5OiAoKSA9PiBib29sZWFuO1xuICAgIGNsZWFyOiAoKSA9PiB2b2lkO1xuICAgIHdyaXRlOiAoKSA9PiB2b2lkIHwgUHJvbWlzZTx2b2lkPjtcbiAgfTtcbiAgLyoqIFN3ZWVwIGludGVydmFsOyBib3RoIGFkb3B0aW5nIGRhZW1vbnMgdXNlZCAyNTAgbXMuICovXG4gIHRpY2tNcz86IG51bWJlcjtcbiAgLyoqIFNuYXBzaG90IGludGVydmFsOyBib3RoIGFkb3B0aW5nIGRhZW1vbnMgdXNlZCAxMDAwIG1zLiAqL1xuICBzbmFwc2hvdE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFN0YXJ0IHRoZSB0d28gc3RhbmRpbmcgdGltZXJzIGV2ZXJ5IHNlc3Npb24gZGFlbW9uIHJ1bnMg4oCUIHRoZSBpZGxlIHN3ZWVwIGFuZFxuICogdGhlIGRlYm91bmNlZCBzbmFwc2hvdCDigJQgYW5kIHJldHVybiB0aGUgZnVuY3Rpb24gdGhhdCBzdG9wcyBib3RoLlxuICpcbiAqIFRoZXkgYXJlIE9ORSBjYWxsIGJlY2F1c2UgdGhleSBoYXZlIGFsd2F5cyBiZWVuIG9uZSBsaWZldGltZTogZXZlcnkgY29weVxuICogY2xlYXJlZCBib3RoIGluIHRoZSBzYW1lIHR3byBsaW5lcyBhZnRlciBgYXdhaXQgZG9uZWAsIGFuZCB0aGUgcGFpciB0aGF0IGdldHNcbiAqIGZvcmdvdHRlbiBpcyB0aGUgcGFpciB3aG9zZSB0aW1lcnMga2VlcCBhIHByb2Nlc3MgYWxpdmUgYWZ0ZXIgdGVhcmRvd24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFydEhvdXNla2VlcGluZyhvcHRzOiBIb3VzZWtlZXBpbmdPcHRpb25zKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHRpY2tNcyA9IG9wdHMudGlja01zID8/IDI1MDtcbiAgY29uc3Qgc25hcHNob3RNcyA9IG9wdHMuc25hcHNob3RNcyA/PyAxMDAwO1xuXG4gIGNvbnN0IGlkbGVUaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICBjb25zdCBzdWJzY3JpYmVycyA9IG9wdHMuc3Vic2NyaWJlckNvdW50KCk7XG4gICAgaWYgKHN1YnNjcmliZXJzID4gMCkgb3B0cy50b3VjaCgpO1xuICAgIGlmIChzaG91bGRJZGxlQ2xvc2Uoc3Vic2NyaWJlcnMsIG9wdHMuaWRsZU1zKCksIG9wdHMudGltZW91dE1zKSkgb3B0cy5vbklkbGVDbG9zZSgpO1xuICB9LCB0aWNrTXMpO1xuXG4gIGNvbnN0IHNuYXAgPSBvcHRzLnNuYXBzaG90O1xuICBjb25zdCBzbmFwVGltZXIgPSBzbmFwXG4gICAgPyBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICAgIGlmICghc25hcC5kaXJ0eSgpKSByZXR1cm47XG4gICAgICAgIHNuYXAuY2xlYXIoKTtcbiAgICAgICAgdm9pZCBzbmFwLndyaXRlKCk7XG4gICAgICB9LCBzbmFwc2hvdE1zKVxuICAgIDogbnVsbDtcblxuICByZXR1cm4gKCkgPT4ge1xuICAgIGNsZWFySW50ZXJ2YWwoaWRsZVRpbWVyKTtcbiAgICBpZiAoc25hcFRpbWVyICE9PSBudWxsKSBjbGVhckludGVydmFsKHNuYXBUaW1lcik7XG4gIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRHJhaW5PcHRpb25zIHtcbiAgLyoqIFRoZSBib3VuZCBzZXJ2ZXIuIFR5cGVkIHN0cnVjdHVyYWxseSBzbyB0aGUga2l0IHN0YXlzIGZyZWUgb2YgYGJ1bmAuICovXG4gIHNlcnZlcjogeyBzdG9wKGNsb3NlQWN0aXZlQ29ubmVjdGlvbnM/OiBib29sZWFuKTogdW5rbm93biB9O1xuICAvKiogTGl2ZSBTU0UgdGFpbHM7IGV2ZXJ5IHJlZ2lzdGVyZWQgY2xvc2VyIGlzIGludm9rZWQuICovXG4gIGNsaWVudHM/OiBTc2VDbGllbnRzO1xuICAvKiogTGl2ZSBXZWJTb2NrZXRzLiAqL1xuICBzb2NrZXRzPzogSXRlcmFibGU8eyBjbG9zZSgpOiB2b2lkIH0+O1xuICAvKiogSG93IGxvbmcgcXVldWVkIGZyYW1lcyBnZXQgdG8gZmx1c2ggYmVmb3JlIGFueXRoaW5nIGlzIGNsb3NlZC4gKi9cbiAgZ3JhY2VNcz86IG51bWJlcjtcbiAgLyoqIEhvdyBsb25nIHRoZSBncmFjZWZ1bCBzdG9wIGdldHMgYmVmb3JlIHRlYXJkb3duIHByb2NlZWRzIHJlZ2FyZGxlc3MuICovXG4gIHN0b3BNcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBDbG9zZSBldmVyeSBoZWxkIGNvbm5lY3Rpb24gYW5kIHN0b3AgdGhlIHNlcnZlciwgaW4gYm91bmRlZCB0aW1lLlxuICpcbiAqIOKblCAqKlRIRSBHUkFDRSBQRVJJT0QgSVMgTk9UIFBPTElURU5FU1MuKiogQSBgY2xvc2VkYCBmcmFtZSBlbWl0dGVkIGFuZCB0aGVuXG4gKiBmb2xsb3dlZCBpbW1lZGlhdGVseSBieSBhbiBhZ2dyZXNzaXZlIGBzZXJ2ZXIuc3RvcCh0cnVlKWAgaXMgYSBmcmFtZSB0aGVcbiAqIGNsaWVudCBuZXZlciBzZWVzIOKAlCB0aGUgcXVldWUgZ29lcyB3aXRoIHRoZSBzb2NrZXQuIFRoZSAxNTAgbXMgaXMgd2hhdCB0dXJuc1xuICogXCJ0aGUgZGFlbW9uIHRvbGQgeW91IHdoeSBpdCBkaWVkXCIgZnJvbSBhIGhvcGUgaW50byBhbiBvYnNlcnZhdGlvbiwgYW5kIGV2ZXJ5XG4gKiBvbmUgb2YgdGhlIGVpZ2h0IGRhZW1vbnMgY29udmVyZ2VkIG9uIHRoYXQgbnVtYmVyIGluZGVwZW5kZW50bHkuXG4gKlxuICog4puUICoqQU5EIFRIRSBTVE9QIElTIFJBQ0VELCBCRUNBVVNFIEEgU0xPVyBTT0NLRVQgTVVTVCBOT1QgQkUgQUJMRSBUTyBIQU5HXG4gKiBURUFSRE9XTi4qKiBgc2VydmVyLnN0b3AodHJ1ZSlgIGF3YWl0cyBpdHMgY29ubmVjdGlvbnM7IG9uZSB3ZWRnZWQgcGVlciBpc1xuICogZW5vdWdoIHRvIHBhcmsgaXQgZm9yZXZlciwgd2hpY2ggaXMgaG93IGEgMjMtbWludXRlIGhhbmcgc2hpcHBlZCBvbmNlLlxuICpcbiAqIOKaoCAqKldIQVQgSVMgREVMSUJFUkFURUxZIE5PVCBIRVJFOiBib3VudHkncyBzaHV0ZG93biB3YXRjaGRvZy4qKiBCb3VudHkgYXJtc1xuICogYSBSRUYnZCBgc2V0VGltZW91dGAgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBpZiB0ZWFyZG93biBkb2VzIG5vdCBmaW5pc2gsXG4gKiBhbmQgdGhlIGNlbnN1cyBpcyByaWdodCB0aGF0IGl0IGlzIHRoZSBjb3JwdXMncyBvbmx5IHVuY29uZGl0aW9uYWxcbiAqIHRlcm1pbmF0aW9uIGd1YXJhbnRlZS4gSXQgYmVsb25ncyB0byBib3VudHkncyBURUFSRE9XTiDigJQgdGhlIHN0cmV0Y2ggd2hlcmVcbiAqIG5vdGhpbmcgYm91bmRzIHdoYXQgaXMgYmVpbmcgd2FpdGVkIG9uLiDim5QgKipUSElTIFBBUkFHUkFQSCBTQUlEIFwiU0lHTkFMXG4gKiBQQVRIXCIgVU5USUwgRDUzLCBBTkQgVEhFIENPREUgQUdSRUVEIFdJVEggSVQsIFdISUNIIFdBUyBUSEUgREVGRUNULioqIEJvdW50eVxuICogaGFzIEZPVVIgd2F5cyBpbnRvIG9uZSB0ZWFyZG93biAoYSBzaWduYWwsIGEgYGNsb3NlYCB2ZXJiLCB0aGUgYnJvd3NlcidzXG4gKiBjbG9zZSBvdmVyIHRoZSBXZWJTb2NrZXQsIGFuIGlkbGUgdGltZW91dCkgYW5kIG9ubHkgdGhlIHNpZ25hbCBvbmUgYXJtZWQgdGhlXG4gKiB0aW1lciwgd2hpbGUgdGhlIGNvbW1lbnQgYWJvdmUgaXQgY2xhaW1lZCB0aGUgZW5kaW5nIHdhcyB1bmNvbmRpdGlvbmFsLlxuICogRHJpdmVuIHdpdGggYSBwbGFudGVkIGhhbmc6IHRoZSBvdGhlciB0aHJlZSByYW4gcGFzdCAxMCBzLCB0aGUgaWRsZSBvbmVcbiAqIGluY2x1ZGVkIOKAlCB0aGUgb3JwaGFuLWRhZW1vbiBjbGFzcyB0aGUgMjMtbWludXRlIGhhbmcgY2FtZSBmcm9tLiBUaGUgYXJtaW5nXG4gKiBub3cgbGl2ZXMgaW4gdGhlIFJFU09MVkUgdGhhdCBhbGwgZm91ciBlbnRyaWVzIHBhc3MgdGhyb3VnaC4gKipUaGUgbGVzc29uIGZvclxuICogYW4gYWRvcHRlciBpcyB0aGUgY291bnQsIG5vdCB0aGUgcGxhY2VtZW50OiBlbnVtZXJhdGUgZXZlcnkgZW50cnkgaW50byB0aGVcbiAqIHRlYXJkb3duIGJlZm9yZSB5b3UgYmVsaWV2ZSBhIGd1YXJhbnRlZSBjb3ZlcnMgaXQuKiogVGhlIHR3b1xuICogZGFlbW9ucyBhZG9wdGluZyB0aGlzIG1vZHVsZSByZWdpc3RlciBubyBzaWduYWwgaGFuZGxlcnMsIGFuZCB0aGVpciB3aG9sZVxuICogdGVhcmRvd24gaXMgYm91bmRlZCBieSB0aGUgdHdvIG51bWJlcnMgYWJvdmU7IGFkZGluZyBhbiBleGl0IGhlcmUgd291bGQgcHV0XG4gKiB0aGUgaG91c2UncyBvbmx5IHVuY29uZGl0aW9uYWwgYHByb2Nlc3MuZXhpdGAgaW5zaWRlIGEgbW9kdWxlIGV2ZXJ5IHNwZWxsIGlzXG4gKiBhYm91dCB0byBidW5kbGUsIG9uZSBwaGFzZSBhZnRlciBEOCB0b29rIGV4YWN0bHkgdGhhdCBoYXphcmQgT1VUIG9mIGBkaWVgLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VOVEVOQ0UgVEhBVCBVU0VEIFRPIEVORCBUSEFUIFBBUkFHUkFQSCBXQVMgQSBQUkVESUNUSU9OLCBXSElDSFxuICogQk9VTlRZJ1MgT1dOIFBPUlQgRkFMU0lGSUVELioqIEl0IHJlYWQ6IFwid2hlbiBhIHNwZWxsIHdpdGggYSBzaWduYWwgcGF0aFxuICogYWRvcHRzIHRoaXMsIHRoZSB3YXRjaGRvZyBhcnJpdmVzIGFzIGFuIG9wdGlvbiBvbiB0aGVzZSBhcmd1bWVudHMgYW5kIHRoZVxuICogcmVhc29uaW5nIGlzIGFscmVhZHkgd3JpdHRlbiBkb3duLlwiIGJvdW50eSBhZG9wdGVkIGBkcmFpbkFuZFN0b3BgIG9uXG4gKiAyMDI2LTA5LTA5IChQaGFzZSA0KSBhbmQgdGhlIG9wdGlvbiB3YXMgTk9UIGFkZGVkLCBiZWNhdXNlIHRoZSB3aW5kb3cgaXNcbiAqIHdyb25nLiAqKkEgYHdhdGNoZG9nTXNgIG9uIHRoZXNlIGFyZ3VtZW50cyB3b3VsZCBhcm0gYXQgRFJBSU4gdGltZTsgYm91bnR5J3NcbiAqIGFybXMgYXQgU0lHTkFMIHRpbWUqKiwgYW5kIHRoZSB3aG9sZSByZWFzb24gaXQgZXhpc3RzIGlzIHRoZSBzdHJldGNoIEJFVFdFRU5cbiAqIHRob3NlIHR3byBwb2ludHMg4oCUIGBhd2FpdCBkb25lYCwgYW4gZnMgYXBwZW5kIHRvIHRoZSBkYWVtb24gbG9nLCBhIGZ1bGxcbiAqIHNuYXBzaG90IHdyaXRlIHRoYXQgY2FuIHJvdGF0ZSBhbmQgQ09QWSBhIGJhY2t1cCBvZiBhIGxhcmdlIGJvYXJkLCBhIGBjbG9zZWRgXG4gKiBmcmFtZSBhbmQgYSBicm9hZGNhc3QuIGBkcmFpbkFuZFN0b3BgJ3Mgb3duIGJvZHkgaXMgYWxyZWFkeSBib3VuZGVkIGJ5IHRoZSB0d29cbiAqIG51bWJlcnMgYWJvdmUsIHNvIGEgd2F0Y2hkb2cgc2NvcGVkIHRvIGl0IHdvdWxkIGd1YXJkIHRoZSBvbmUgc3RyZXRjaCB0aGF0XG4gKiBjYW5ub3QgaGFuZyBhbmQgYWJhbmRvbiB0aGUgc3RyZXRjaCB0aGF0IGNhbjogaXQgd291bGQgUkVBRCBhcyBhZG9wdGlvbiBhbmRcbiAqIEJFIGEgbmFycm93aW5nIG9mIHRoZSBjb3JwdXMncyBvbmx5IHVuY29uZGl0aW9uYWwgdGVybWluYXRpb24gZ3VhcmFudGVlLiBUaGVcbiAqIDIzLW1pbnV0ZSBoYW5nIHRoaXMgcHJvamVjdCBrZWVwcyBjaXRpbmcgaGFwcGVuZWQgaW4gdGhlIHVuYm91bmRlZCBzdHJldGNoLlxuICpcbiAqIOKaoCAqKlNPIFRIRSBSVUxFIEZPUiBUSEUgTkVYVCBTUEVMTCwgV0hJQ0ggSVMgVEhFIFRSQU5TRkVSQUJMRSBIQUxGOioqIHRoZVxuICogcXVlc3Rpb24gaXMgbmV2ZXIgXCJkb2VzIHRoaXMgbW9kdWxlIGhhdmUgYSBwbGFjZSB0byBwdXQgYSB3YXRjaGRvZ1wiIGJ1dFxuICogXCJkb2VzIHRoZSB3YXRjaGRvZydzIHdpbmRvdyBjb2luY2lkZSB3aXRoIHRoaXMgbW9kdWxlJ3NcIi4gV2hlcmUgYSBzcGVsbCdzXG4gKiB0ZWFyZG93biBoYXMgdW5ib3VuZGVkIHdvcmsgQkVGT1JFIHRoZSBkcmFpbiwgdGhlIHdhdGNoZG9nIGJlbG9uZ3MgYXQgdGhlXG4gKiBzcGVsbCwgd3JhcHBlZCBhcm91bmQgYWxsIG9mIGl0IOKAlCBhbmQgYXJvdW5kIEVWRVJZIFdBWSBJTiwgd2hpY2ggaXMgdGhlIGhhbGZcbiAqIEQ1MyBoYWQgdG8gcmVwYWlyIGFmdGVyIHRoaXMgaGVhZGVyIHdhcyB3cml0dGVuLiBJZiBhIHNwZWxsIGV2ZXIgYXBwZWFycyB3aG9zZSBzaWduYWwgcGF0aFxuICogZW50ZXJzIGBkcmFpbkFuZFN0b3BgIGltbWVkaWF0ZWx5LCBhZGQgdGhlIG9wdGlvbiBUSEVOIOKAlCBhbmQgdGhlIG9wdGlvbiBtdXN0XG4gKiB0YWtlIGFuIGBvbkV4cGlyZWAgY2FsbGJhY2sgcmF0aGVyIHRoYW4gZXhpdGluZywgc28gdGhlIGBwcm9jZXNzLmV4aXRgIHN0YXlzXG4gKiBvdXRzaWRlIGEgbW9kdWxlIGV2ZXJ5IHNwZWxsIGJ1bmRsZXMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkcmFpbkFuZFN0b3Aob3B0czogRHJhaW5PcHRpb25zKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGdyYWNlTXMgPSBvcHRzLmdyYWNlTXMgPz8gMTUwO1xuICBjb25zdCBzdG9wTXMgPSBvcHRzLnN0b3BNcyA/PyAyMDA7XG5cbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgZ3JhY2VNcykpO1xuXG4gIGlmIChvcHRzLmNsaWVudHMpIHtcbiAgICBmb3IgKGNvbnN0IGNsaWVudCBvZiBbLi4ub3B0cy5jbGllbnRzXSkgY2xpZW50LmNsb3NlKCk7XG4gIH1cbiAgaWYgKG9wdHMuc29ja2V0cykge1xuICAgIGZvciAoY29uc3Qgd3Mgb2YgWy4uLm9wdHMuc29ja2V0c10pIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLmNsb3NlKCk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICBQcm9taXNlLnJlc29sdmUob3B0cy5zZXJ2ZXIuc3RvcCh0cnVlKSksXG4gICAgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgc3RvcE1zKSksXG4gIF0pO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBhc3NldC1zZXJ2aW5nIHRyaW8gZm9yIGEgc3BlbGwgZGFlbW9uOiB3aGljaCBzdXJmYWNlIG1vZGUgd2VcbiAqIGFyZSBpbiwgd2hhdCBjb250ZW50IHR5cGUgYSBmaWxlIGdldHMsIGFuZCBob3cgYSBmaWxlIHVuZGVyIGBkaXN0L2AgaXNcbiAqIGFuc3dlcmVkLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIGFuZCB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3MgYXJ0aWZhY3QuXG4gKlxuICogRXh0cmFjdGVkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgZnJvbSB0aGUgZWlnaHQgYEJ1bi5zZXJ2ZWAgYmFja2VuZHNcbiAqIGNlbnN1c2VkIGluIGBkb2NzL2ludmVzdGlnYXRpb25zLzIwMjYtMDktMDgtZGFlbW9uLXNwaW5lLWNlbnN1cy5tZGAsIHdoaWNoXG4gKiBtZWFzdXJlZCBgcmVzb2x2ZU1vZGVgIGFzIGJ5dGUtaWRlbnRpY2FsIGluIGFsbCBlaWdodCAodGhlIG9ubHkgbWQ1IGRpZmZlcmVuY2VcbiAqIGJlaW5nIHRoZSBgZXhwb3J0YCBrZXl3b3JkKSwgdGhlIGNvbnRlbnQtdHlwZSBtYXAgYXMgZGlmZmVyaW5nIGluIGV4YWN0bHlcbiAqIG9uZSBjZWxsLCBhbmQgdGhlIGZpbGUgaGFsZiBvZiBgc2VydmVEaXN0YCBhcyBpZGVudGljYWwgaW4gZml2ZS5cbiAqXG4gKiDilIDilIAgV0hBVCBERUxJQkVSQVRFTFkgRElEIE5PVCBDT01FIEFMT05HIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICoqVGhlIFVSTC10by1maWxlbmFtZSBtYXBwaW5nIHN0YXlzIGluIGVhY2ggcm91dGVyLioqIFRoZSBjZW5zdXMgbWFya2VkIHR3b1xuICogb2YgdGhlIGVpZ2h0IGBzZXJ2ZURpc3RgIGRpdmVyZ2VuY2VzIERFTElCRVJBVEUgYW5kIGJvdGggbGl2ZSBpbiB0aGF0IGhhbGY6XG4gKiBkaWdlc3RpZnkgc3Vic3RpdHV0ZXMgaW50byB0aGUgZW50cnkgSFRNTCBpbiBtZW1vcnksIGFuZCBncmFwZXZpbmUgc2VydmVzIGl0c1xuICogc3VyZmFjZSBhdCBgL3dhdGNoYCByYXRoZXIgdGhhbiBhdCBgL2AuIEEgc2lnbmF0dXJlIHdpZGUgZW5vdWdoIHRvIGFic29yYlxuICogdGhvc2Ugc3RvcHMgYmVpbmcgYSBmaWxlIHNlcnZlciBhbmQgYmVjb21lcyBhIHJvdXRlci4gU28gdGhlIGNhbGxlciBkZWNpZGVzXG4gKiBXSElDSCBmaWxlIChgcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSlgKSwgYW5kIHRoaXMgbW9kdWxlXG4gKiBkZWNpZGVzIHdoZXRoZXIgdGhhdCBmaWxlIG1heSBiZSByZWFkIGFuZCB3aGF0IGl0IGlzIHNlcnZlZCBhcy5cbiAqXG4gKiDilIDilIAgQU5EIFwiV0hFVEhFUiBJVCBNQVkgQkUgUkVBRFwiIElTIE5PVyBBIFdISVRFTElTVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBFeHRyYWN0ZWQgd2l0aCB0aHJlZSBndWFyZHMgKGVtcHR5IC8gYC4uYCAvIG5lc3RlZCkgYW5kIGBleGlzdHNTeW5jYCBmb3IgdGhlXG4gKiByZXN0LCB3aGljaCB3YXMgdHJ1ZSBvZiBhIGBkaXN0L2AgdGhhdCBoZWxkIG9ubHkgYSBzdXJmYWNlLiBQaGFzZSAxYiBwdXQgZXZlcnlcbiAqIGRhZW1vbidzIEJVTkRMRSBpbiB0aGF0IHNhbWUgZGlyZWN0b3J5LCBhbmQgYWxsIGZpdmUgYWRvcHRlcnMgc2VydmVkIGl0OlxuICogYC9jbGkuanNgLCBgL3NlcnZlci5qc2AsIGAvam9pbi5qc2AgYXQgMjAwLCBieXRlLWlkZW50aWNhbCB0byB0aGUgY29tbWl0dGVkXG4gKiBhcnRpZmFjdHMsIGVtYmVkZGVkIHNvdXJjZW1hcHMgYW5kIGFsbC4gYHNlcnZlRnJvbURpc3RgIG5vdyBzZXJ2ZXMgb25seSB3aGF0IHRoZVxuICogYnVpbHQgYGluZGV4Lmh0bWxgIHRyYW5zaXRpdmVseSBsaW5rcyDigJQgc2VlIGBzdXJmYWNlV2hpdGVsaXN0YCBiZWxvdywgd2hpY2ggaXNcbiAqIHRoZSBzaGFwZSBkaWdlc3RpZnkgcHJvdmVkIGxvY2FsbHkgaW4gYGQ4Y2JhZmZgIGFuZCB0aGlzIGlzIGl0cyBvbmUgZWRpdCBmb3JcbiAqIGZpdmUgc3BlbGxzLlxuICovXG5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG4vKipcbiAqIFJlbGVhc2UgaWZmIGA8ZGlzdERpcj4vaW5kZXguaHRtbGAgZXhpc3RzOyBlbHNlIGRldi4gVGhlIGVudiBvdmVycmlkZVxuICogKGBTUEVMTEJPT0tfU1VSRkFDRV9NT0RFYCkgd2lucyBlaXRoZXIgd2F5IOKAlCBzZWFtcyBDb250cmFjdCAxLlxuICpcbiAqIOKblCAqKlRIRSBGSUxFLCBORVZFUiBUSEUgRElSRUNUT1JZLCBBTkQgVEhBVCBJUyBBIFNDQVIgTk9UIEEgU1RZTEUgQ0hPSUNFLioqXG4gKiBSZS1ob21lZCBmcm9tIGJvdW50eSBhbmQgbWFncGllLCB3aGljaCBlYXJuZWQgaXQgaW5kZXBlbmRlbnRseTpcbiAqXG4gKiAtIG1hZ3BpZSdzIGBkaXN0L2AgQUxSRUFEWSBFWElTVEVEIGhvbGRpbmcgYGNsaS5qc2AgYW5kIG5vIGBpbmRleC5odG1sYCxcbiAqICAgd2hpY2ggaXMgcHJlY2lzZWx5IHdoeSBpdHMgZGFlbW9uIHN0YXllZCBjb3JyZWN0bHkgaW4gREVWIG1vZGUgdGhyb3VnaCB0aGVcbiAqICAgd2hvbGUgb2YgU2xpY2UgMi4gYGRpc3QvYCBleGlzdGluZyBpcyBub3QgdGhlIGRpc2NyaW1pbmF0b3IuXG4gKiAtIGJvdW50eSBzYXlzIHRoZSBzYW1lIHRoaW5nIGZyb20gdGhlIG90aGVyIHNpZGU6IGEgYnVpbHQgQkFDS0VORCBwdXRzXG4gKiAgIGBjbGkuanNgIChhbmQgbm93IGBzZXJ2ZXIuanNgKSBpbiBgZGlzdC9gIHdpdGggbm8gc3VyZmFjZSBhbnl3aGVyZSBuZWFyIGl0LlxuICpcbiAqIOKaoCAqKkFORCBUSEUgUFJFRElDQVRFIElTIEFOIFVOSEFTSEVEIEZJTEVOQU1FLCBXSElDSCBJUyBBIFNUQU5ESU5HXG4gKiBBU1NVTVBUSU9OIEFCT1VUIFRIRSBTVVJGQUNFIEJVSUxELioqIFJlbGVhc2UgbW9kZSBpcyBjaG9zZW4gYnkgT05FIGxpdGVyYWxcbiAqIG5hbWUuIEEgc3VyZmFjZSBidWlsZCB0aGF0IGV2ZXIgZW1pdHRlZCBhIGNvbnRlbnQtaGFzaGVkIGVudHJ5IGRvY3VtZW50IHdvdWxkXG4gKiBsZWF2ZSBubyBgaW5kZXguaHRtbGAgaGVyZSwgZXZlcnkgZGFlbW9uIHdvdWxkIHNpbGVudGx5IHJlc29sdmUgREVWLCBhbmQgdGhlXG4gKiBvbmx5IHN5bXB0b20gYW55b25lIGNhbiBzZWUgaXMgdGhlIGBtb2RlYCBmaWVsZCBvbiBhIGhhbmRzaGFrZSBub2JvZHkgcmVhZHMgaW5cbiAqIGFuZ2VyLiBgc3JjL2J1aWxkLnRzYCBlbWl0cyB0aGUgZW50cnkgdW5oYXNoZWQgdG9kYXkgKG9ubHkgdGhlIEpTIGFuZCBDU1NcbiAqIGNodW5rcyBjYXJyeSBoYXNoZXMpIGFuZCBDb250cmFjdCAyIHBpbnMgdGhhdCBmbGF0IGxheW91dDsgdGhpcyBjb21tZW50IGlzXG4gKiB0aGUgbm90ZSB0aGF0IHNheXMgd2hhdCB0aGUgcGluIGlzIGxvYWQtYmVhcmluZyBGT1IuXG4gKlxuICog4pqgIE5vdGhpbmcgYW5ub3VuY2VzIHRoZSBmbGlwIGZyb20gZGV2IHRvIHJlbGVhc2UgZWl0aGVyOiB0aGUgZmlyc3Qgc3VyZmFjZVxuICogYnVpbGQgdG8gbGFuZCBhbiBgaW5kZXguaHRtbGAgYmVzaWRlIGEgZGFlbW9uIGZsaXBzIGl0LCBzaWxlbnRseSwgb24gdGhlIG5leHRcbiAqIGJvb3QuIFRoYXQgaXMgd2h5IGBtb2RlYCByaWRlcyB0aGUgcmVhZHkgZnJhbWUg4oCUIHdpdGggcm9vdCBkZXBzIHByZXNlbnQgYSBkZXZcbiAqIGRhZW1vbiByZW5kZXJzIGFuIGlkZW50aWNhbC1sb29raW5nIHN1cmZhY2UsIHNvIFwiaXQgbG9va3MgcmlnaHRcIiBjYW5ub3RcbiAqIHZlcmlmeSBDb250cmFjdCAxLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZU1vZGUoZGlzdERpcjogc3RyaW5nKTogXCJkZXZcIiB8IFwicmVsZWFzZVwiIHtcbiAgY29uc3Qgb3ZlcnJpZGUgPSBwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFO1xuICBpZiAob3ZlcnJpZGUgPT09IFwiZGV2XCIgfHwgb3ZlcnJpZGUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gb3ZlcnJpZGU7XG4gIHJldHVybiBleGlzdHNTeW5jKGpvaW4oZGlzdERpciwgXCJpbmRleC5odG1sXCIpKSA/IFwicmVsZWFzZVwiIDogXCJkZXZcIjtcbn1cblxuLyoqXG4gKiBUaGUgY29udGVudCB0eXBlcyBhIGJ1aWx0IHN1cmZhY2UgYWN0dWFsbHkgc2hpcHMuIEV4dGVuc2lvbnMgb3V0c2lkZSB0aGVcbiAqIG1hcCBnZXQgYGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbWAg4oCUIGEgZGVsaWJlcmF0ZSByZWZ1c2FsIHRvIGd1ZXNzLCBzaW5jZVxuICogYW55dGhpbmcgbm90IGluIHRoaXMgbGlzdCBpcyBub3Qgc29tZXRoaW5nIENvbnRyYWN0IDIncyBidWlsZCBlbWl0cy5cbiAqXG4gKiDimqAgKipgY2hhcnNldD11dGYtOGAgT04gSFRNTCBJUyBUSEUgQ0VOU1VTJ1MgT05FIERJVkVSR0VOQ0UsIFJFU09MVkVEIFRPV0FSRFxuICogVEhFIENPUlJFQ1QgQ09QWS4qKiBUaHJlZSBvZiB0aGUgZWlnaHQgZGFlbW9ucyBjYXJyaWVkIGl0IGFuZCBmaXZlIGRpZCBub3Q7XG4gKiB0aGUgY2Vuc3VzIGdyYWRlZCB0aGF0IGBzdGFsZWAgd2l0aCB6ZXJvIGRlc2lnbiBjb250ZW50LiBJdCBpcyBrZXB0IGJlY2F1c2VcbiAqIGl0IGlzIHRoZSByaWdodCBhbnN3ZXIg4oCUIGFuIEhUTUwgZG9jdW1lbnQgc2VydmVkIHdpdGggbm8gY2hhcnNldCBpcyBkZWNvZGVkXG4gKiBieSB0aGUgYnJvd3NlcidzIGd1ZXNzIOKAlCBhbmQgaXQgaXMgdGhlIG9uZSB3aXJlLW9ic2VydmFibGUgY2hhbmdlIHRoaXNcbiAqIGNvbnZlcmdlbmNlIG1ha2VzIHRvIGEgcmVzcG9uc2UgaGVhZGVyLiBSZWNvcmRlZCBhcyBELW5vdGUgaW4gdGhlIHBoYXNlIGxvZ1xuICogcmF0aGVyIHRoYW4gc211Z2dsZWQuXG4gKi9cbmNvbnN0IFNUQVRJQ19DT05URU5UX1RZUEVTOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcIi5odG1sXCI6IFwidGV4dC9odG1sOyBjaGFyc2V0PXV0Zi04XCIsXG4gIFwiLmpzXCI6IFwidGV4dC9qYXZhc2NyaXB0XCIsXG4gIFwiLmNzc1wiOiBcInRleHQvY3NzXCIsXG4gIFwiLmpzb25cIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gIFwiLnN2Z1wiOiBcImltYWdlL3N2Zyt4bWxcIixcbiAgXCIucG5nXCI6IFwiaW1hZ2UvcG5nXCIsXG59O1xuXG4vKiogVGhlIGNvbnRlbnQgdHlwZSBmb3IgYSBmaWxlbmFtZSBvciBhbiBleHRlbnNpb24uIFVua25vd24gZXh0ZW5zaW9ucywgYW5kXG4gKiAgbmFtZXMgd2l0aCBubyBleHRlbnNpb24gYXQgYWxsLCBnZXQgYGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbWAuICovXG5leHBvcnQgZnVuY3Rpb24gY29udGVudFR5cGVGb3IobmFtZU9yRXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBkb3QgPSBuYW1lT3JFeHQubGFzdEluZGV4T2YoXCIuXCIpO1xuICBjb25zdCBleHQgPSBkb3QgPT09IC0xID8gXCJcIiA6IG5hbWVPckV4dC5zbGljZShkb3QpO1xuICByZXR1cm4gU1RBVElDX0NPTlRFTlRfVFlQRVNbZXh0XSA/PyBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiO1xufVxuXG4vKipcbiAqIEFuc3dlciBPTkUgZmlsZSBmcm9tIGBkaXN0RGlyYCwgb3IgYG51bGxgIGlmIHRoZSBjYWxsZXIgc2hvdWxkIGtlZXAgcm91dGluZy5cbiAqXG4gKiBgcmVsYCBpcyBhIGJhcmUgZmlsZW5hbWUg4oCUIHRoZSBlbnRyeSBkb2N1bWVudCBvciBvbmUgaGFzaGVkIGNodW5rLiBDb250cmFjdFxuICogMidzIGJ1aWx0IHN1cmZhY2UgaXMgRkxBVCBhbmQgbGlua3MgaXRzIGNodW5rcyByZWxhdGl2ZWx5LCBzbyBhIGxlZ2l0aW1hdGVcbiAqIGFzc2V0IHJlcXVlc3QgaXMgbmV2ZXIgbmVzdGVkIGFuZCBuZXZlciBjb250YWlucyBgLi5gOyBib3RoIGFyZSByZWZ1c2VkXG4gKiBoZXJlIHJhdGhlciB0aGFuIGluIHRoZSByb3V0ZXIsIGJlY2F1c2UgdGhlIGd1YXJkIHByb3RlY3RzIHRoZSByZWFkIGFuZCB0aGVcbiAqIHJlYWQgaXMgd2hhdCBsaXZlcyBpbiB0aGlzIGZpbGUuXG4gKlxuICog4puUIEFORCBgZXhpc3RzU3luY2AgSVMgTk8gTE9OR0VSIFRIRSBQRVJNSVNTSU9OLiBBIGZpbGUgdW5kZXIgYGRpc3REaXJgIGlzXG4gKiBzZXJ2ZWQgb25seSBpZiBpdCBpcyBpbiBgc3VyZmFjZVdoaXRlbGlzdChkaXN0RGlyKWAg4oCUIHdoYXQgdGhlIGJ1aWx0XG4gKiBgaW5kZXguaHRtbGAgdHJhbnNpdGl2ZWx5IExJTktTLiBgZGlzdC9gIHN0b3BwZWQgYmVpbmcgYSBzdXJmYWNlIGRpcmVjdG9yeVxuICogd2hlbiB0aGUgYmFja2VuZCBjb252ZXJnZW5jZSBidWlsdCB0aGUgZGFlbW9ucyBpbnRvIGl0LCBhbmQgdGhlIGd1YXJkcyBhYm92ZVxuICogZG8gbm90IGRpc3Rpbmd1aXNoIGBpbmRleC08aGFzaD4uanNgIGZyb20gYHNlcnZlci5qc2AuIFJlYWQgdGhhdCBmdW5jdGlvbidzXG4gKiBoZWFkZXIgYmVmb3JlIHRvdWNoaW5nIHRoaXMgbGluZTsgdGhlIHdoaXRlbGlzdCBpcyB0aGUgZGVmZW5jZS5cbiAqXG4gKiDimqAgVGhlIG5lc3RpbmcgcmVmdXNhbCBpcyBhbHNvIHdoYXQga2VlcHMgYW4gYXNzZXQgc2VydmUgY2xlYXIgb2YgYSBzcGVsbCdzXG4gKiBvd24gcm91dGVzOiBtYWdwaWUsIGJvdW50eSwgZ2xhbW91ciBhbmQgaW1hZ28gZWFjaCBoYXZlIGFuIGAvYXNzZXRzLzxuYW1lPmBcbiAqIHJvdXRlIG9uZSBsZXZlbCBkZWVwLCBhbmQgdGhpcyByZXR1cm5pbmcgYG51bGxgIG9uIGFueXRoaW5nIHdpdGggYSBzbGFzaCBpblxuICogaXQgaXMgd2hhdCBzdG9wcyB0aGUgdHdvIGZpZ2h0aW5nLiBUaGUgd2hpdGVsaXN0IGdvdmVybnMgYGRpc3QvYCByZWFkcyBPTkxZXG4gKiDigJQgaXQgbmV2ZXIgc2VlcyB0aG9zZSByb3V0ZXMgYW5kIG11c3QgbmV2ZXIgYmUgd2lkZW5lZCBpbnRvIHRoZW0uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXJ2ZUZyb21EaXN0KGRpc3REaXI6IHN0cmluZywgcmVsOiBzdHJpbmcpOiBSZXNwb25zZSB8IG51bGwge1xuICBpZiAoIXJlbCB8fCByZWwuaW5jbHVkZXMoXCIuLlwiKSB8fCByZWwuaW5jbHVkZXMoXCIvXCIpKSByZXR1cm4gbnVsbDtcbiAgaWYgKCFzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXIpLmhhcyhyZWwpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZmlsZSA9IGpvaW4oZGlzdERpciwgcmVsKTtcbiAgaWYgKCFleGlzdHNTeW5jKGZpbGUpKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIG5ldyBSZXNwb25zZShCdW4uZmlsZShmaWxlKSwgeyBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IGNvbnRlbnRUeXBlRm9yKHJlbCkgfSB9KTtcbn1cblxuLyoqIGBzcmNgL2BocmVmYCB2YWx1ZXMgaW4gYSBidWlsdCBlbnRyeSBkb2N1bWVudCwgYC4vYC1wcmVmaXhlZCBvciBiYXJlLiAqL1xuY29uc3QgRU5UUllfUkVGX1JFID0gLyg/OnNyY3xocmVmKVxccyo9XFxzKlwiKD86XFwuXFwvKT8oW15cIl0rKVwiL2c7XG5cbi8qKiBBIGAuL2AtUFJFRklYRUQgc2libGluZyBzcGVjaWZpZXIg4oCUIGBcIi4vbmFtZVwiYCwgYCcuL25hbWUnYCwgYCguL25hbWUpYCDigJQgd2hpY2hcbiAqICBpcyB0aGUgb25seSBzaGFwZSBhIGJ1bmRsZXIgZW1pdHMgZm9yIGEgc2libGluZyBjaHVuay4gUmVxdWlyaW5nIHRoZSBgLi9gIGlzXG4gKiAgd2hhdCBrZWVwcyBhIHN0cmluZyBsaXRlcmFsIHRoYXQgbWVyZWx5IFNBWVMgYGNsaS5qc2Agb3V0IG9mIHRoZSBzZXQuICovXG5jb25zdCBSRUxBVElWRV9SRUZfUkUgPSAvW1wiJyhdXFwuXFwvKFteXCInKClcXHNdKylbXCInKV0vZztcblxuLyoqIE9ubHkgdGV4dCB0aGUgYnVpbGQgZW1pdHMgYXMgc3VyZmFjZSBjb2RlIGlzIHNjYW5uZWQgZm9yIG9ud2FyZCByZWZlcmVuY2VzLlxuICogIEEgYC5wbmdgIGlzIGEgbGVhZjsgb3BlbmluZyBpdCB3b3VsZCBiZSByZWFkaW5nIGEgYmluYXJ5IGZvciBmaWxlbmFtZXMuICovXG5jb25zdCBUUkFOU0lUSVZFX0VYVFMgPSBbXCIuanNcIiwgXCIuY3NzXCJdO1xuXG4vKiogT25lIGRlcml2YXRpb24gcGVyIGBkaXN0L2AsIGZvciB0aGUgbGlmZSBvZiB0aGUgcHJvY2VzcyDigJQgYGRpc3QvYCBpcyBhIGJ1aWxkXG4gKiAgYXJ0aWZhY3QgYW5kIGRvZXMgbm90IGNoYW5nZSB1bmRlciBhIHJ1bm5pbmcgZGFlbW9uLiBLZXllZCBieSBkaXJlY3Rvcnkgc29cbiAqICB0d28gZGFlbW9ucyBpbiBvbmUgcHJvY2VzcyAoYW5kIGV2ZXJ5IHRlc3Qgd2l0aCBpdHMgb3duIHRlbXAgdHJlZSkgc3RheVxuICogIGluZGVwZW5kZW50LiAqL1xuY29uc3Qgd2hpdGVsaXN0Q2FjaGUgPSBuZXcgTWFwPHN0cmluZywgUmVhZG9ubHlTZXQ8c3RyaW5nPj4oKTtcblxuZnVuY3Rpb24gcmVmc0luKHRleHQ6IHN0cmluZywgcmU6IFJlZ0V4cCk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIChcbiAgICBbLi4udGV4dC5tYXRjaEFsbChyZSldXG4gICAgICAubWFwKChbLCByZWZdKSA9PiByZWYpXG4gICAgICAvLyBBIFRZUEUgUFJFRElDQVRFLCBhbmQgaG9uZXN0IG9ubHkgYmVjYXVzZSBpdHMgZmlyc3QgY2xhdXNlIHdhcyBhbHJlYWR5XG4gICAgICAvLyBoZXJlOiBgISFyZWZgIGlzIHRoZSBydW50aW1lIGNoZWNrIHRoYXQgbWFrZXMgYHJlZiBpcyBzdHJpbmdgIHRydWUgKHRoZVxuICAgICAgLy8gRkVMTCBzZW50ZW5jZSdzIHByZWRpY2F0ZSByb3V0ZSwgdGFrZW4gd2l0aCBpdHMgY2xhdXNlIOKAlCB0eXBlLWRlYnQgVDM2KS5cbiAgICAgIC5maWx0ZXIoXG4gICAgICAgIChyZWYpOiByZWYgaXMgc3RyaW5nID0+XG4gICAgICAgICAgISFyZWYgJiZcbiAgICAgICAgICAhcmVmLmluY2x1ZGVzKFwiL1wiKSAmJlxuICAgICAgICAgICFyZWYuaW5jbHVkZXMoXCIuLlwiKSAmJlxuICAgICAgICAgICFyZWYuaW5jbHVkZXMoXCI6XCIpICYmXG4gICAgICAgICAgIXJlZi5zdGFydHNXaXRoKFwiI1wiKSAmJlxuICAgICAgICAgICFyZWYuc3RhcnRzV2l0aChcIj9cIiksXG4gICAgICApXG4gICk7XG59XG5cbi8qKlxuICogVGhlIG5hbWVzIHVuZGVyIGBkaXN0RGlyYCBhIGJyb3dzZXIgbWF5IGZldGNoOiB0aGUgZW50cnkgZG9jdW1lbnQsIHBsdXMgdGhlXG4gKiBUUkFOU0lUSVZFIGNsb3N1cmUgb2Ygd2hhdCBpdCBsaW5rcy5cbiAqXG4gKiDim5QgKipBIFdISVRFTElTVCwgQU5EIFRIRSBMRUFLIElUIFJFUExBQ0VEIElTIFdIWS4qKiBVbnRpbCB0aGlzIGZpeCB0aGUgZmlsZVxuICogaGFsZiBvZiB0aGlzIG1vZHVsZSBoYWQgZXhhY3RseSB0aHJlZSBndWFyZHMg4oCUIGVtcHR5LCBgLi5gLCBuZXN0ZWQg4oCUIGFuZFxuICogYGV4aXN0c1N5bmNgIGRlY2lkZWQgdGhlIHJlc3QuIFRoYXQgd2FzIGNvcnJlY3QgZm9yIGFzIGxvbmcgYXMgYGRpc3QvYCBoZWxkXG4gKiBvbmx5IGEgc3VyZmFjZS4gVGhlIGJhY2tlbmQgY29udmVyZ2VuY2UgbW92ZWQgZXZlcnkgc3BlbGwncyBJTVBMRU1FTlRBVElPTlxuICogaW50byB0aGUgc2FtZSBkaXJlY3RvcnksIGFuZCB0aGUgc2VydmUgZGlkIHdoYXQgaXQgd2FzIHdyaXR0ZW4gdG8gZG86XG4gKlxuICogICBHRVQgL2NsaS5qcyAgICAgMjAwICAyNDIsNDMxIEIgIHRleHQvamF2YXNjcmlwdCAgIOKGkCBib3VudHksIGJ5dGUtaWRlbnRpY2FsXG4gKiAgIEdFVCAvc2VydmVyLmpzICAyMDAgIDI3Niw0MTUgQiAgdGV4dC9qYXZhc2NyaXB0ICAgICAgdG8gdGhlIGNvbW1pdHRlZFxuICogICBHRVQgL2pvaW4uanMgICAgMjAwICAgNDcsMzQ4IEIgIHRleHQvamF2YXNjcmlwdCAgICAgIGFydGlmYWN0c1xuICpcbiAqIGFuZCB0aG9zZSBidW5kbGVzIGFyZSBidWlsdCB3aXRoIHRoZSBzb3VyY2VtYXAgRU1CRURERUQsIHNvIGVhY2ggb25lIGNhcnJpZXNcbiAqIHRoZSBjb21wbGV0ZSBvcmlnaW5hbCBUeXBlU2NyaXB0LiBGaXZlIHNwZWxscyDigJQgYXN0cm9sYWJlLCBib3VudHksIGdsYW1vdXIsIGltYWdvLCBtYWdwaWVcbiAqIOKAlCBlbGV2ZW4gYXJ0aWZhY3RzLCBhbGwgcmVhY2hhYmxlIGJ5IGFueSBicm93c2VyIHRoYXQgY2FuIHJlYWNoIHRoZSBkYWVtb24uXG4gKiBEaWdlc3RpZnkgaGl0IHRoZSBpZGVudGljYWwgZGVmZWN0IG9uZSBicmFuY2ggZWFybGllciBhbmQgYW5zd2VyZWQgaXQgbG9jYWxseTtcbiAqIHRoaXMgaXMgdGhhdCBhbnN3ZXIgcmUtaG9tZWQgdG8gdGhlIG9uZSBwbGFjZSBhbGwgZml2ZSBjYWxsZXJzIGFscmVhZHkgc2hhcmUuXG4gKlxuICog4puUICoqREVSSVZFRCwgTk9UIEVOVU1FUkFURUQsIEFORCBOT1QgTUFUQ0hFRCBCWSBTSEFQRS4qKiBBIGxpdGVyYWwgbmFtZSBsaXN0XG4gKiBpcyB3cm9uZyBhdCB0aGUgbmV4dCBidWlsZCAodGhlIGNodW5rcyBjYXJyeSBjb250ZW50IGhhc2hlcykuIEEgc2hhcGUgbWF0Y2hcbiAqIChgaW5kZXgtPGhhc2g+LmpzYCkgaXMgd3JvbmcgdGhlIGZpcnN0IHRpbWUgdGhlIGJ1bmRsZXIgc3BsaXRzIGEgY2h1bmsuIEFza2luZ1xuICogdGhlIGVudHJ5IGRvY3VtZW50IHdoYXQgaXQgbG9hZHMgaXMgdGhlIG9ubHkgZm9ybXVsYXRpb24gdGhhdCBpcyB0cnVlIG9mXG4gKiB3aGF0ZXZlciBgYnVuIHJ1biBidWlsZGAgYWN0dWFsbHkgZW1pdHRlZC5cbiAqXG4gKiDim5QgKipBTkQgVEhFIENMT1NVUkUgSVMgVFJBTlNJVElWRSBGT1IgVEhFIFNBTUUgUkVBU09OLioqIGBpbmRleC5odG1sYCBsaW5rc1xuICogb25lIGNodW5rIHRvZGF5OyBhIHNwbGl0IGJ1aWxkIGhhcyB0aGF0IGNodW5rIGBpbXBvcnQgXCIuL2NodW5rLTxoYXNoPi5qc1wiYCxcbiAqIHdoaWNoIHRoZSBlbnRyeSBkb2N1bWVudCBuZXZlciBuYW1lcy4gU28gZXZlcnkgYWRtaXR0ZWQgYC5qc2AvYC5jc3NgIGlzIGl0c2VsZlxuICogc2Nhbm5lZCBmb3IgYC4vYC1wcmVmaXhlZCBzaWJsaW5ncywgdW50aWwgdGhlIHNldCBzdG9wcyBncm93aW5nIOKAlCBhIHdoaXRlbGlzdFxuICogdGhhdCByZWFkIG9ubHkgdGhlIGVudHJ5IHdvdWxkIDQwNCBhIGxlZ2l0aW1hdGUgY2h1bmsgaW4gcmVsZWFzZSwgYW5kIG9ubHkgaW5cbiAqIHJlbGVhc2UuXG4gKlxuICog4puUICoqTUVNQkVSU0hJUCBJUyBBTiBFWEFDVCBNQVRDSCwgV0hJQ0ggTUFLRVMgVEhFIFJFRlVTQUwgQ0FTRS1JTlNFTlNJVElWRSBCWVxuICogQ09OU1RSVUNUSU9OLioqIEFQRlMgaXMgY2FzZS1pbnNlbnNpdGl2ZSwgc28gYC9JTkRFWC5IVE1MYCBhbmQgYC9pTmRFeC5IdE1sYFxuICogcmVzb2x2ZSB0byB0aGUgc2FtZSBpbm9kZSBhIGNhc2Utc2Vuc2l0aXZlIGJsYWNrbGlzdCB3b3VsZCBtaXNzIChtZWFzdXJlZCBvblxuICogYWxsIGZpdmUgc3BlbGxzIGJlZm9yZSB0aGlzIGZpeDogZm91ciB2YXJpYW50cywgZm91ciAyMDBzLCB0aHJlZSBvZiB0aGVtIGFzXG4gKiBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYCBiZWNhdXNlIHRoZSBjb250ZW50LXR5cGUgbG9va3VwIGlzIGNhc2Utc2Vuc2l0aXZlXG4gKiB0b28pLiBBIHNldCBvZiBleGFjdGx5IHRoZSBlbWl0dGVkIG5hbWVzIHJlZnVzZXMgZXZlcnkgdmFyaWFudCBvZiBldmVyeSBuYW1lXG4gKiDigJQgc2VydmFibGUgb3Igbm90IOKAlCB3aXRoIG5vIGxvd2VyLWNhc2UgcGFzcyBhbnl3aGVyZS5cbiAqXG4gKiDimqAgKipUSEUgVFJBREU6KiogYSBmaWxlIHRoZSBlbnRyeSBncmFwaCBkb2VzIG5vdCByZWZlcmVuY2Ug4oCUIGEgbGF6aWx5IGZldGNoZWRcbiAqIGNodW5rLCBhIGZvbnQgcHVsbGVkIGJ5IGEgQ1NTIGB1cmwoKWAgdGhpcyBzY2FuIGRvZXMgbm90IG1vZGVsLCBhbiBhc3NldCB0aGVcbiAqIGJ1aWxkIGVtaXRzIGJ1dCBub3RoaW5nIGxpbmtzIOKAlCA0MDRzIGluIHJlbGVhc2Ugd2l0aCBub3RoaW5nIHJlZC4gRWFjaFxuICogYWRvcHRlcidzIGByZWxlYXNlLXNlcnZlLnRlc3QudHNgIGhvbGRzIHRoZSBpbnN0cnVtZW50OiBhbiBJTlZFTlRPUlkgY2VsbCB0aGF0XG4gKiBhY2NvdW50cyBmb3IgZXZlcnkgZmlsZSBpbiBgZGlzdC9gIGFzIHNlcnZlZCBvciBkZWxpYmVyYXRlbHkgcmVmdXNlZCwgc28gYW5cbiAqIHVubGlua2VkIGVtaXNzaW9uIGdvZXMgcmVkIGF0IGJ1aWxkIHRpbWUgcmF0aGVyIHRoYW4gc2lsZW50IGF0IHJ1bnRpbWUuXG4gKlxuICog4pqgIFRoZSBlbnRyeSBkb2N1bWVudCBpcyBJTiB0aGUgc2V0LCBiZWNhdXNlIHRoZSBob3VzZSBjYWxsZXIgbWFwcyBgL2AgdG9cbiAqIGBpbmRleC5odG1sYCBhbmQgdGhhdCBpcyB0aGUgc3VyZmFjZS4gQSBzcGVsbCB0aGF0IG11c3QgbmV2ZXIgaGFuZCBvdmVyIGl0c1xuICogb24tZGlzayBlbnRyeSDigJQgZGlnZXN0aWZ5IHN1YnN0aXR1dGVzIGEgcGF5bG9hZCBpbnRvIGl0IGluIG1lbW9yeSDigJQgcmVmdXNlc1xuICogdGhhdCBPTkUgbmFtZSBpbiBpdHMgb3duIHJvdXRlciwgYWJvdmUgdGhpcyBjYWxsLiBUaGF0IHJlZnVzYWwgaXMgdGhlIHNwZWxsJ3M7XG4gKiBldmVyeXRoaW5nIGVsc2UgaGVyZSBpcyB0aGUga2l0J3MuXG4gKi9cbmZ1bmN0aW9uIHN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcjogc3RyaW5nKTogUmVhZG9ubHlTZXQ8c3RyaW5nPiB7XG4gIGNvbnN0IGNhY2hlZCA9IHdoaXRlbGlzdENhY2hlLmdldChkaXN0RGlyKTtcbiAgaWYgKGNhY2hlZCkgcmV0dXJuIGNhY2hlZDtcblxuICBjb25zdCBuYW1lcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBlbnRyeSA9IGpvaW4oZGlzdERpciwgXCJpbmRleC5odG1sXCIpO1xuICBpZiAoZXhpc3RzU3luYyhlbnRyeSkpIHtcbiAgICBuYW1lcy5hZGQoXCJpbmRleC5odG1sXCIpO1xuICAgIGNvbnN0IGh0bWwgPSByZWFkRmlsZVN5bmMoZW50cnksIFwidXRmOFwiKTtcbiAgICBjb25zdCBwZW5kaW5nID0gWy4uLnJlZnNJbihodG1sLCBFTlRSWV9SRUZfUkUpLCAuLi5yZWZzSW4oaHRtbCwgUkVMQVRJVkVfUkVGX1JFKV07XG4gICAgLy8gVW50aWwgdGhlIHNldCBzdG9wcyBncm93aW5nOiBlYWNoIGFkbWl0dGVkIGNodW5rIG1heSBuYW1lIHRoZSBuZXh0IG9uZS5cbiAgICB3aGlsZSAocGVuZGluZy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBuYW1lID0gcGVuZGluZy5wb3AoKSBhcyBzdHJpbmc7XG4gICAgICBpZiAobmFtZXMuaGFzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgIC8vIOKaoCBSRUZFUkVOQ0VEICoqQU5EKiogUFJFU0VOVC4gQSBtaW5pZmllZCBidW5kbGUgY2FuIGNvbnRhaW4gYSBzdHJpbmdcbiAgICAgIC8vIHRoYXQgbWVyZWx5IExPT0tTIGxpa2Ugb25lOyBhZG1pdHRpbmcgb25seSBuYW1lcyB0aGF0XG4gICAgICAvLyBhcmUgYWN0dWFsbHkgb24gZGlzayBrZWVwcyB0aGUgc2NhbiBmcm9tIHdpZGVuaW5nIHRoZSBzZXQgb24gYVxuICAgICAgLy8gY29pbmNpZGVuY2UsIGFuZCBhIG5hbWUgdGhhdCBpcyBhYnNlbnQgNDA0cyBpZGVudGljYWxseSBlaXRoZXIgd2F5LlxuICAgICAgY29uc3QgZmlsZSA9IGpvaW4oZGlzdERpciwgbmFtZSk7XG4gICAgICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIGNvbnRpbnVlO1xuICAgICAgbmFtZXMuYWRkKG5hbWUpO1xuICAgICAgaWYgKCFUUkFOU0lUSVZFX0VYVFMuc29tZSgoZXh0KSA9PiBuYW1lLmVuZHNXaXRoKGV4dCkpKSBjb250aW51ZTtcbiAgICAgIHBlbmRpbmcucHVzaCguLi5yZWZzSW4ocmVhZEZpbGVTeW5jKGZpbGUsIFwidXRmOFwiKSwgUkVMQVRJVkVfUkVGX1JFKSk7XG4gICAgfVxuICB9XG5cbiAgd2hpdGVsaXN0Q2FjaGUuc2V0KGRpc3REaXIsIG5hbWVzKTtcbiAgcmV0dXJuIG5hbWVzO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBzZXJ2ZXIgc2lkZSBvZiB0aGUgU1NFIHRhaWwg4oCUIHRoZSBkYWVtb24tc2lkZSB0d2luIG9mXG4gKiBgdGFpbEV2ZW50cy50c2AuIFRoYXQgbW9kdWxlIGRlY2lkZXMgd2hhdCBhIGNhbGxlciBvYnNlcnZlczsgdGhpcyBvbmUgZGVjaWRlc1xuICogd2hhdCBhIGNhbGxlciBpcyBzZW50LlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIGV4Y2VwdCBpdHNcbiAqIG93biBzaWJsaW5nIHR5cGVzLCB3aGljaCBpcyBzdGlsbCBpbnNpZGUgdGhlIGxlYWYuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIG1pbmQtbWFwcGVyJ3MgYHNzZVJlc3BvbnNlYCxcbiAqIHRoZSBjZW5zdXMncyBjb252ZXJnZW5jZSB0YXJnZXQgIzE6IHRoZSBvbmx5IG9uZSBvZiB0aGUgc2V2ZW4gd2l0aCBhXG4gKiBvbmNlLW9ubHkgdGVhcmRvd24gZnVubmVsLCB0aGUgb25seSBvbmUgd2lyZWQgdG8gYHJlcS5zaWduYWxgLCBhbmQgdGhlIG9ubHlcbiAqIG9uZSB3aG9zZSBjb21tZW50IHJlY29yZHMgYSBNRUFTVVJFRCByZXN1bHQgcmF0aGVyIHRoYW4gYSBiZWxpZWYuXG4gKlxuICog4pSA4pSAIOKblCBBTkQgV0hBVCBUSEUgQ09QWSBMRUZUIEJFSElORCwgU0FJRCBIRVJFIEJFQ0FVU0UgQSBMT1NTIFJFQ09SREVEIE9OTFkgSU5cbiAqICAgIEEgUE9SVCdTIEpPVVJOQUwgR0VUUyBSRS1MSVRJR0FURUQgQlkgRVZFUlkgU1BFTEwgQUZURVIgSVQgKEQ3OS9EODUpIOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSBzZW50ZW5jZSBhYm92ZSBuYW1lcyBhIFNPVVJDRSB0aGlzIG1vZHVsZSBoYWQgbmV2ZXIgYmVlbiBjaGVja2VkIGFnYWluc3Q6XG4gKiBEMSBydWxlZCB0aGUgc3BpbmUgYmUgcHJvdmVuIG9uIHRoZSB0d28gc3BlbGxzIHRoYXQgYWxyZWFkeSBidWlsdCwgYW5kIGJvdGggb2ZcbiAqIHRob3NlIGFyZSBkb3duc3RyZWFtIEZPUktTIG9mIHRoZSBtaW5kLW1hcHBlciBsaW5lLCBzbyB0aGUgYm91bmRhcmllcyB3ZXJlXG4gKiBzZXR0bGVkIGFnYWluc3QgdHdvIGNvcGllcyB3aGlsZSB0aGUgb3JpZ2luYWwgd2FzIG5vdCBpbiB0aGUgcm9vbS4gKipBXG4gKiBjb252ZXJnZW5jZSBjYW4gbmFtZSBpdHMgc291cmNlIGFuZCBzdGlsbCBuZXZlciBjb25zdWx0IGl0LioqXG4gKlxuICogV2hlbiBpdCB3YXMgZmluYWxseSBjb25zdWx0ZWQgKFBoYXNlIDcsIHRoZSBsYXN0IHBvcnQpLCBleGFjdGx5IE9ORSBwcm9wZXJ0eVxuICogb2YgdGhlIHNvdXJjZSB3YXMgbWlzc2luZyBoZXJlLCBhbmQgaXQgb2NjdXBpZWQgbm8gdHlwZTogKiptaW5kLW1hcHBlciB3cm90ZVxuICogaXRzIGB0YWlsIC0taW5ib3VuZGAgZ3JvdW5kaW5nIGZyYW1lIEJFRk9SRSB0aGUgcmVwbGF5Kiog4oCUIG9uZSBsaW5lIGFib3ZlXG4gKiBgYnVzLnN1YnNjcmliZWAg4oCUIHNvIGl0IHdhcyB0aGUgc3RyZWFtJ3MgZmlyc3QgZGF0YSBsaW5lLiBgb25PcGVuYCBmaXJlcyBhdFxuICogdGhlIEVORCBvZiBgc3RhcnRgLCBhZnRlciB0aGUgcHJlYW1ibGUsIGFmdGVyIGBsb2cuc3Vic2NyaWJlYCwgYWZ0ZXJcbiAqIGBjbGllbnRzLmFkZGAsIHNvIGEgY2FsbGVyIHRoYXQgc3VwcGxpZWQgaXRzIG93biBgY2xpZW50c2Agc2V0IGFuZCBzZW50IGZyb21cbiAqIHRoZXJlIHdvdWxkIGxhbmQgdGhlIGZyYW1lIEFGVEVSIHRoZSByZXBsYXllZCBiYWNrbG9nLiBUaGF0IGlzIEVYUFJFU1NJQkxFLFxuICogd2hpY2ggaXMgd2hhdCBtYWtlcyB0aGlzIGEgbWVhc3VyZW1lbnQgcmF0aGVyIHRoYW4gYW4gYXNzZXJ0aW9uOiB0aGVcbiAqIHBsYXlib29rJ3MgdHlwZS10by10eXBlIGNvbXBhdGliaWxpdHkgcHJvY2VkdXJlIGFuc3dlcnMgXCJyZXByZXNlbnRhYmxlXCIgaGVyZVxuICogKHRoZSBzdWJqZWN0IHR5cGUgaXMgYFNldDxTc2VDbGllbnQ+YCwgdGhlIHNwZWxsIGtlZXBzIG5vIHJlZ2lzdHJ5LCBzbyB5b3VcbiAqIHBhc3MgYW4gZW1wdHkgc2V0KSBhbmQgYSB0eXBlIGNoZWNrIGNhbm5vdCBzZWUgYSBQT1NJVElPTi5cbiAqXG4gKiAqKlRoZSBkaXNwb3NpdGlvbiB3YXMgUkVTVE9SRSwgbm90IEtFRVAtTE9DQUwgYW5kIG5vdCBGSUxFKiog4oCUIHNlZVxuICogYG9wZW5GcmFtZXNgIGJlbG93LCB3aGVyZSB0aGUgdHdvIG51bWJlcnMgdGhhdCBwZXJtaXQgaXQgYXJlIHJlY29yZGVkIGFuZFxuICogZHJpdmVuLiBUaGUgZ2VuZXJhbGlzYXRpb24sIHdoaWNoIGlzIHRoZSBwYXJ0IHdvcnRoIGNhcnJ5aW5nOiB3aGVyZSBhXG4gKiBtb2R1bGUncyBzdWJqZWN0IGlzIGEgU0VRVUVOQ0UgT0YgV1JJVEVTLCBjb21wYXJlIHRoZSBPUkRFUiBvZiBpdHMgaG9va3NcbiAqIGFnYWluc3QgdGhlIG9yZGVyIHRoZSBhZG9wdGluZyBzcGVsbCB3cml0ZXMgaW4uIFR3byBob29rcyB3aXRoIHRoZSByaWdodFxuICogc2lnbmF0dXJlcyBpbiB0aGUgd3Jvbmcgb3JkZXIgYXJlIGFzIGluY29tcGF0aWJsZSBhcyB0d28gdHlwZXMgdGhhdCB3aWxsIG5vdFxuICogdW5pZnksIGFuZCBvbmx5IG9uZSBvZiB0aGUgdHdvIGNhbiBiZSBTRUVOIGJ5IGEgY29tcGF0aWJpbGl0eSBjaGVjay5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSLCBSRS1IT01FRDogYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgRE9FUyBOT1QgREVURUNUIEEgREVBRFxuICogICAgQ0xJRU5ULiBNRUFTVVJFRCBPTiBCVU4gMS4zLjE0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFNpeCBkYWVtb25zIHdyaXRlIGEgaGVhcnRiZWF0IGFzIGB0cnkgeyBjb250cm9sbGVyLmVucXVldWUoLi4uKSB9IGNhdGNoIHt9YFxuICogd2l0aCBhIGNvbW1lbnQgc2F5aW5nIHRoZSBjYXRjaCBpcyBob3cgYSBkZXBhcnRlZCBjbGllbnQgaXMgbm90aWNlZC4gSXQgaXNcbiAqIG5vdDogZW5xdWV1ZSBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gQlVGRkVSUyBTSUxFTlRMWSBhbmQgbmV2ZXIgdGhyb3dzLCBzbyB0aGVcbiAqIGNhdGNoIG5ldmVyIGZpcmVzIGFuZCB0aG9zZSBkYWVtb25zJyBkZWFkLWNsaWVudCBkZXRlY3Rpb24gcmVzdHMgb24gYVxuICogbWVjaGFuaXNtIHRoZWlyIG93biBjb21tZW50cyBkZXNjcmliZSBpbmNvcnJlY3RseS4gV2hhdCBhY3R1YWxseSByZWNsYWltcyB0aGVcbiAqIGNvbm5lY3Rpb24gaXMgdGhlIHN0cmVhbSdzIGBjYW5jZWwoKWAg4oCUIGFuZCwgZm9yIGEgY2xpZW50IHRoYXQgbmV2ZXIgY2xvc2VzXG4gKiB0aGUgc29ja2V0LCBgcmVxLnNpZ25hbGAuXG4gKlxuICogU28gdGhlIGZ1bm5lbCBiZWxvdyBpcyB0aGUgbG9hZC1iZWFyaW5nIHBhcnQuIGB0ZWFyZG93bigpYCBydW5zIEFUIE1PU1QgT05DRVxuICogZnJvbSBldmVyeSBwYXRoIHRoZXJlIGlzIOKAlCBgY2FuY2VsKClgLCBhbiBhYm9ydCBvbiB0aGUgcmVxdWVzdCBzaWduYWwsIGFuZFxuICogdGhlIGJlbHQtYW5kLWJyYWNlcyBlbnF1ZXVlIGNhdGNoIOKAlCBhbmQgaXQgaXMgd2hlcmUgdGhlIHN1YnNjcmliZXIgY291bnQgYW5kXG4gKiBhbnkgcHJlc2VuY2UgZGVjcmVtZW50IHJpZGUuIEJvdW5kaW5nIHByZXNlbmNlIGFjY3VyYWN5IGlzIGJvdW5kaW5nIHRoYXRcbiAqIGZ1bm5lbC5cbiAqXG4gKiDimqAgS25vd24gaG9sZSwgYWNjZXB0ZWQgYW5kIGluaGVyaXRlZDogQnVuJ3Mgb3duIGBmZXRjaCgpYCByZWFkZXIgYC5jYW5jZWwoKWBcbiAqIGNsb3NlcyBub3RoaW5nIGNsaWVudC1zaWRlIGFuZCB0aGUgc2VydmVyIGNhbm5vdCBzZWUgaXQuIFJlYWwgY2xpZW50cyBjbG9zZVxuICogdGhlIHNvY2tldC5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBET0VTIE5PVCBBRE9QVCBUSElTLCBBTkQgVEhFIFJFRlVTQUwgSVMgUEFSVCBPRiBUSEUgUlVMSU5HIOKUgOKUgFxuICpcbiAqIFJFSkVDVC1TVFJVQ1RVUkFMLCBydWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLlxuICogR3JhcGV2aW5lIEhBUyBhbiBTU0UgcmVnaXN0cnkgYW5kIGl0IGlzIHRoZSBidXNpZXN0IHRoaW5nIGluIHRoZSBzcGVsbDsgdGhlXG4gKiB0d28gdHlwZXMgc2ltcGx5IGNhbm5vdCBiZSBjb25zdHJ1Y3RlZCBmcm9tIGVhY2ggb3RoZXI6XG4gKlxuICogICB0aGlzIG1vZHVsZSAgYFNzZUNsaWVudHMgPSBTZXQ8U3NlQ2xpZW50PmAgd2hlcmUgYFNzZUNsaWVudCA9IHtjbG9zZSwgc2VuZH1gXG4gKiAgICAgICAgICAgICAgICDigJQgYSByZWdpc3RyeSBvZiBBTk9OWU1PVVMgY2xvc2VycywgYW5kIGBzaXplYCBpcyB0aGUgb25seSB0aGluZ1xuICogICAgICAgICAgICAgICAgYW55IGFkb3B0aW5nIGRhZW1vbiByZWFkcyBvZmYgaXQuXG4gKiAgIGdyYXBldmluZSAgICBgTWFwPHN5bWJvbCwge2FsaWFzLCBodW1hbiwgbHVyaywgc2VuZH0+YCwgcGVyIGNoYW5uZWwuXG4gKlxuICogKipUaGUgcmVhZGVycyB0aGF0IG1ha2UgdGhlbSBpbmNvbXBhdGlibGUsIGNvdW50ZWQgcmF0aGVyIHRoYW4gYXNzZXJ0ZWQ6IFNJWFxuICogcm91dGVzIHJlYWQgYGFsaWFzYC9gaHVtYW5gL2BsdXJrYCoqIOKAlCBgR0VUIC9jaGFubmVsc2AgKHRocm91Z2hcbiAqIGBsaXN0Q2hhbm5lbHNgIOKGkiBgdmlzaWJsZVN1YnNgKSwgYEdFVCAvcHJlc2VuY2VgLCBgUE9TVCAvY2hhbm5lbHNgLFxuICogYFBPU1QgL2Fubm91bmNlYCwgYFBPU1QgL2NoYW5uZWxzLzpuYW1lL21lc3NhZ2VzYCwgYW5kXG4gKiBgR0VUIC9jaGFubmVscy86bmFtZS9zdWJzY3JpYmVyc2AuIGBhbGlhc2AgaXMgYSBuYW1lIGEgaHVtYW4gc2VlcyBpbiBhIHJvc3RlcixcbiAqIGBodW1hbmAgdGVsbHMgYW4gYWdlbnQgaXQgaXMgdGFsa2luZyB0byBhIHBlcnNvbiwgYW5kIGBsdXJrYCBleGNsdWRlcyBhXG4gKiBjb25uZWN0aW9uIGZyb20gZXZlcnkgcHJlc2VuY2UgY291bnQuIFRoZXJlIGlzIG5vIHdheSB0byBwdXQgYW55IG9mIHRoYXQgaW50b1xuICogYSBzZXQgb2YgY2xvc2Vycy4gQWRvcHRpbmcgdGhpcyBtb2R1bGUgd291bGQgbm90IGJlIGRlYWQgY29kZTsgaXQgd291bGQgYmUgYVxuICogcmV3cml0ZSBvZiB3aGF0IGdyYXBldmluZSBJUy5cbiAqXG4gKiDimqAgKipBTkQgVEhFIExJU1QgSVMgREVMSUJFUkFURUxZIE5PVCBUSEUgT0JWSU9VUyBPTkUuKiogVGhlIHBvcnQncyBmaXJzdFxuICogY291bnQgbmFtZWQgdGhlIGByb2xsYC9jbGVhciBicm9hZGNhc3QsIHRoZSBhcmNoaXZlIGxpdmUtZ3VhcmQgYW5kIHR3b1xuICogUkVHSVNUUkFUSU9OUyDigJQgYW5kIGV2ZXJ5IG9uZSBvZiB0aG9zZSBpcyBhIHNpdGUgdGhpcyBtb2R1bGUncyB0eXBlIHdvdWxkXG4gKiBzZXJ2ZSBwZXJmZWN0bHk6IHRoZSBicm9hZGNhc3QgcmVhZHMgb25seSBgcy5zZW5kYCwgdGhlIGxpdmUtZ3VhcmQgb25seVxuICogYHN1YnNjcmliZXJzLnNpemVgICh3aGljaCB0aGlzIGhlYWRlciBpdHNlbGYgc2F5cyBpcyBhbGwgYW55IGFkb3B0ZXIgcmVhZHMpLFxuICogYW5kIGEgcmVnaXN0cmF0aW9uIFdSSVRFUyB0aGUgcmVjb3JkIHJhdGhlciB0aGFuIHJlYWRpbmcgaXQuIFRoZSBzaXggYWJvdmUgYXJlXG4gKiB0aGUgb25lcyB0aGF0IHJlYWQgYSBmaWVsZCB0aGUga2l0J3MgYFNzZUNsaWVudGAgZG9lcyBub3QgaGF2ZTsgdGhlIHdyaXRlcnNcbiAqIChgL3dhaXRgJ3MgcHJlc2VuY2UgcmVnaXN0cmF0aW9uIGFuZCB0aGUgdGFpbCdzKSBhcmUgbmFtZWQgc2VwYXJhdGVseSBiZWNhdXNlXG4gKiBhIHdyaXRlciBpcyBub3QgZXZpZGVuY2Ugb2YgYW55dGhpbmcuIENvdW50ZWQgaW4gdGhlIHByZS1wb3J0IGRhZW1vbixcbiAqIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvZ3JhcGV2aW5lL3NjcmlwdHMvZGFlbW9uLnRzYCBvbiBgZGV2ZWxvcGA6XG4gKiBsLjQyMSwgNzM5LTc0NywgODI2LCA4ODYtODg3LCAxMDQ5LTEwNTQsIDExODItMTE4OCDigJQgd3JpdGVycyBhdCAxMTExLTExMTIgYW5kXG4gKiAxMzA3LiAoQ29ycmVjdGVkIDIwMjYtMDktMDkgaW4gdGhlIHJlcGFpciBjaGFwdGVyOyBENjgncyByZXF1aXJlbWVudCBpcyB0aGF0XG4gKiB0aGUgcmVmdXNhbCBiZSB3cml0dGVuIHdoZXJlIHRoZSBuZXh0IHJlYWRlciBtZWV0cyBpdCwgd2hpY2ggbWFrZXMgYVxuICogbWlzLW1lYXN1cmVkIGxpc3Qgd29yc2UgdGhhbiBub25lLilcbiAqXG4gKiDimqAgQW5kIGdyYXBldmluZSdzIHJlY29yZHMgY2Fycnkgbm8gYGNsb3NlYCBhdCBhbGwg4oCUIHRoZSBwZXItc3RyZWFtIHRlYXJkb3duIGlzXG4gKiBhIGNsb3N1cmUgc3Rhc2hlZCBvbiB0aGUgUmVhZGFibGVTdHJlYW0gY29udHJvbGxlciwgcmVhY2hhYmxlIG9ubHkgZnJvbVxuICogYGNhbmNlbCgpYCDigJQgd2hpY2ggaXMgYWxzbyB3aHkgYGhvdXNla2VlcGluZ2AncyBgZHJhaW5BbmRTdG9wYCBpcyBhZG9wdGVkXG4gKiB0aGVyZSB3aXRoIGl0cyBgY2xpZW50c2AgYXJndW1lbnQgZGVsaWJlcmF0ZWx5IGVtcHR5LlxuICpcbiAqICoqVGhlIHdpZGVuaW5nIE5PVCBkb25lLCB3aXRoIGl0cyBjb3N0OioqIGFkbWl0dGluZyBhbiBhbGlhcy1iZWFyaW5nIHJlY29yZFxuICogd291bGQgY2hhbmdlIHRoZSB0eXBlIGZpdmUgb3RoZXIgZGFlbW9ucyBjb21waWxlIGFnYWluc3QgYW5kIHJlLWVtaXQgU0lYXG4gKiBhcnRpZmFjdHMgYWNyb3NzIEZJVkUgc3BlbGxzLCBlYWNoIG93ZWQgYSBkcml2ZS4gSXQgd291bGQgYWxzbyByZS1jcmVhdGUgdGhlXG4gKiB0aGluZyB0aGlzIHJlZ2lzdHJ5IGV4aXN0cyB0byBzdG9wLCBhbmQgdGhpcyBmaWxlJ3Mgb3duIGJvdW5kYXJ5IHBhcmFncmFwaFxuICogc2F5cyBob3c6IGEgc2lnbmF0dXJlIHdpZGUgZW5vdWdoIHRvIGFic29yYiBldmVyeSBjYWxsZXIncyBzaGFwZSBzdG9wcyBiZWluZyBhXG4gKiByZWdpc3RyeSBhbmQgYmVjb21lcyBhIHVuaW9uLiBUaGUgY2Vuc3VzIGNvbnZlcmdlZCBjb3BpZXMgaW50byBvbmUgbW9kdWxlIGJ5XG4gKiBmaW5kaW5nIHdoYXQgdGhleSBTSEFSRUQ7IGEgbW9kdWxlIHdpZGVuZWQgdG8gZml0IHRoZSBvbmUgc3BlbGwgdGhhdCBzaGFyZXNcbiAqIG5vdGhpbmcgaXMgdGhvc2UgY29waWVzIGFnYWluIHdpdGggYSB1bmlvbiB0eXBlIG92ZXIgdGhlIHRvcC4gVGhlIHNwZWxsIGtlZXBzXG4gKiBpdHMgb3duLCBhbmQgYSB3aWRlbmluZyByZW1haW5zIGEgc2VwYXJhdGUsIGFyZ3VlZCBkZWNpc2lvbi5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEV2ZW50TG9nLCBGcmFtZSB9IGZyb20gXCIuL2V2ZW50TG9nLnRzXCI7XG5cbi8qKlxuICogT25lIG9wZW4gU1NFIHN0cmVhbSwgYXMgdGhlIGRhZW1vbiBjYW4gYWN0IG9uIGl0OiBlbmQgaXQsIG9yIHB1c2ggYSBmcmFtZSB0b1xuICogaXQgdGhhdCBkaWQgbm90IGNvbWUgb3V0IG9mIHRoZSBsb2cuXG4gKlxuICog4puUIElUIElTIE5PVCBBIENPTlRST0xMRVIuIFRoZSBjb3BpZXMgaGVsZFxuICogYFNldDxSZWFkYWJsZVN0cmVhbURlZmF1bHRDb250cm9sbGVyPmAgYW5kIGNsb3NlZCB0aGVtIGRpcmVjdGx5IGF0IHRlYXJkb3duLFxuICogd2hpY2ggYnlwYXNzZXMgdGhlIHRlYXJkb3duIGZ1bm5lbCBhYm92ZSDigJQgdGhlIGhlYXJ0YmVhdCBpbnRlcnZhbCBmb3IgdGhhdFxuICogc3RyZWFtIHdhcyBjbGVhcmVkIG9ubHkgYmVjYXVzZSBhIHNlY29uZCBgU2V0YCBvZiB0aW1lcnMgd2FzIGtlcHQgaW4gcGFyYWxsZWxcbiAqIGFuZCBzd2VwdCBzZXBhcmF0ZWx5LiBFdmVyeXRoaW5nIGhlcmUgZ29lcyB0aHJvdWdoIHRoZSBmdW5uZWwsIGFuZCBhIGBzZW5kYFxuICogYWZ0ZXIgdGVhcmRvd24gaXMgYSBuby1vcCByYXRoZXIgdGhhbiBhIHRocm93LlxuICpcbiAqIOKaoCAqKmBzZW5kYCBBUlJJVkVEIElOIFBIQVNFIDIsIEZST00gVEhFIEZJUlNUIENPTlNVTUVSIFRIQVQgV0FTIE5PVCBPTkUgT0YgVEhFXG4gKiBUV08gVEhJUyBNT0RVTEUgV0FTIERFU0lHTkVEIEFHQUlOU1QuKiogYXN0cm9sYWJlIGFuZCBtYWdwaWUgYW5ub3VuY2UgcHJlc2VuY2VcbiAqIG92ZXIgdGhlaXIgYnJvd3NlciBXRUJTT0NLRVQsIHNvIGEgcmVnaXN0cnkgb2YgYmFyZSBjbG9zZXJzIHdhcyBzdWZmaWNpZW50IGFuZFxuICogdGhlIGJvdW5kYXJ5IGxvb2tlZCByaWdodC4gZ2xhbW91ciBhbm5vdW5jZXMgaXQgb24gdGhlIEFHRU5UJ3MgU1NFIHRhaWwg4oCUXG4gKiBge3R5cGU6XCJjb25uZWN0ZWRcIn1gIC8gYHt0eXBlOlwiZGlzY29ubmVjdGVkXCJ9YCwgZGVsaWJlcmF0ZWx5IHVubG9nZ2VkLCBzbyBhXG4gKiByZWNvbm5lY3RpbmcgYWdlbnQgZG9lcyBub3QgcmUtc2VlIGV2ZXJ5IHBhc3QgY29ubmVjdCBhbmQgc28gdGhlIGZyYW1lIG5ldmVyXG4gKiBhZHZhbmNlcyBhIHRhaWwgY3Vyc29yLiBUaGF0IGlzIG5vdCBhIGdsYW1vdXIgcXVpcms7IGl0IGlzIHRoZSBnZW5lcmFsIHNoYXBlXG4gKiBvZiBcInRlbGwgdGhlIGxpdmUgc3Vic2NyaWJlcnMgc29tZXRoaW5nIHRoYXQgaXMgbm90IHBhcnQgb2YgdGhlIGhpc3RvcnlcIiwgYW5kXG4gKiBhIHJlZ2lzdHJ5IHRoYXQgY2FuIG9ubHkgRU5EIGEgc3RyZWFtIGNhbm5vdCBleHByZXNzIGl0LiBXaXRob3V0IHRoaXMgdGhlXG4gKiBzcGVsbCB3b3VsZCBoYXZlIGhhZCB0byBrZWVwIGl0cyBvd24gcGFyYWxsZWwgYFNldGAgb2YgY29udHJvbGxlcnMsIHdoaWNoIGlzXG4gKiBleGFjdGx5IHRoZSBkcmlmdCB0aGlzIHJlZ2lzdHJ5IGV4aXN0cyB0byByZW1vdmUuXG4gKi9cbmV4cG9ydCB0eXBlIFNzZUNsaWVudCA9IHtcbiAgLyoqIEVuZCB0aGlzIHN0cmVhbSwgdGhyb3VnaCB0aGUgdGVhcmRvd24gZnVubmVsLCBhdCBtb3N0IG9uY2UuICovXG4gIGNsb3NlKCk6IHZvaWQ7XG4gIC8qKiBXcml0ZSBvbmUgcmF3IFNTRSBjaHVuayB0byB0aGlzIHN0cmVhbS4gTm8tb3Agb25jZSB0b3JuIGRvd24uICovXG4gIHNlbmQoY2h1bms6IHN0cmluZyk6IHZvaWQ7XG59O1xuXG4vKipcbiAqIFRoZSBsaXZlLXRhaWwgcmVnaXN0cnkuIGBzaXplYCBpcyB0aGUgZGFlbW9uJ3MgU1NFIHN1YnNjcmliZXIgY291bnQg4oCUIHRoZVxuICogbnVtYmVyIGBzaG91bGRJZGxlQ2xvc2VgIG11c3Qgc2VlIOKAlCBhbmQgY2xvc2luZyBldmVyeSBlbnRyeSBpcyB3aGF0IGEgZHJhaW5cbiAqIGRvZXMuXG4gKi9cbmV4cG9ydCB0eXBlIFNzZUNsaWVudHMgPSBTZXQ8U3NlQ2xpZW50PjtcblxuZXhwb3J0IGludGVyZmFjZSBTc2VPcHRpb25zPFQgZXh0ZW5kcyBvYmplY3Q+IHtcbiAgLyoqIFRoZSBsb2cgdG8gcmVwbGF5IGZyb20gYW5kIHN1YnNjcmliZSB0by4gKi9cbiAgbG9nOiBFdmVudExvZzxUPjtcbiAgLyoqIFRoZSBjYWxsZXIncyByZXN1bWUgY3Vyc29yLiBBYnNlbnQgb3IgdW5wYXJzZWFibGUgcmVwbGF5cyBmcm9tIHRoZSBzdGFydC4gKi9cbiAgc2luY2U6IG51bWJlcjtcbiAgLyoqIEhlYXJ0YmVhdCBjb21tZW50IGludGVydmFsLiBNVVNUIHN0YXkgd2VsbCB1bmRlciB0aGUgc2VydmVyJ3NcbiAgICogIGBpZGxlVGltZW91dGAg4oCUIHNlZSBgaGVhcnRiZWF0LnRzYCwgd2hpY2ggaXMgd2hlcmUgdGhhdCBwYWlyIGxpdmVzLiAqL1xuICBoZWFydGJlYXRNczogbnVtYmVyO1xuICAvKiogTGl2ZW5lc3MgcmVnaXN0cnk7IHRoZSBzdHJlYW0gYWRkcyBpdHNlbGYgb24gb3BlbiBhbmQgcmVtb3ZlcyBpdHNlbGYgaW5cbiAgICogIHRoZSB0ZWFyZG93biBmdW5uZWwuICovXG4gIGNsaWVudHM/OiBTc2VDbGllbnRzO1xuICAvKiogYHJlcS5zaWduYWxgIOKAlCB0aGUgb25seSB0aGluZyB0aGF0IHJlY2xhaW1zIGEgY2xpZW50IHRoYXQgd2VudCBhd2F5XG4gICAqICB3aXRob3V0IGNhbmNlbGxpbmcgdGhlIHN0cmVhbS4gKi9cbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIC8qKiBTZXJ2ZXItc2lkZSBmaWx0ZXIuIEEgcmVqZWN0ZWQgZnJhbWUgaXMgbm90IHNlbnQ7IHRoZSBjbGllbnQgc3RpbGxcbiAgICogIGFkdmFuY2VzIGl0cyBjdXJzb3IgcGFzdCBpdCwgd2hpY2ggaXMgYHRhaWxFdmVudHNgJ3MgZG9jdW1lbnRlZCBydWxlLiAqL1xuICBmaWx0ZXI/OiAoZnJhbWU6IEZyYW1lPFQ+KSA9PiBib29sZWFuO1xuICAvKipcbiAgICogUmF3IFNTRSBjaHVua3Mgd3JpdHRlbiB0byBUSElTIHN0cmVhbSBCRUZPUkUgdGhlIHJlcGxheSDigJQgYWZ0ZXIgdGhlXG4gICAqIGBcIjogY29ubmVjdGVkXCJgIHByZWFtYmxlIGFuZCBiZWZvcmUgYGxvZy5zdWJzY3JpYmVgLCBzbyB3aGF0ZXZlciBpdCByZXR1cm5zXG4gICAqIGlzIHRoZSBzdHJlYW0ncyBmaXJzdCBEQVRBIGxpbmUgcmF0aGVyIHRoYW4gYSBmcmFtZSBidXJpZWQgYmVoaW5kIGFcbiAgICogcmVwbGF5ZWQgYmFja2xvZy5cbiAgICpcbiAgICog4puUIElUIElTIEEgUE9TSVRJT04sIFdISUNIIElTIFdIWSBgb25PcGVuYCBDT1VMRCBOT1QgU0VSVkUgKEQ4NSkuIGBvbk9wZW5gXG4gICAqIGZpcmVzIGF0IHRoZSBlbmQgb2YgYHN0YXJ0YCDigJQgYWZ0ZXIgdGhlIHByZWFtYmxlLCBhZnRlciBgbG9nLnN1YnNjcmliZWAsXG4gICAqIGFmdGVyIGBjbGllbnRzLmFkZGAg4oCUIHNvIGEgY2FsbGVyIHRoYXQgc3VwcGxpZXMgaXRzIG93biBgY2xpZW50c2Agc2V0IGFuZFxuICAgKiBzZW5kcyBmcm9tIHRoZXJlIGxhbmRzIGl0cyBmcmFtZSBBRlRFUiB0aGUgYmFja2xvZy4gVGhhdCBpcyBleHByZXNzaWJsZSBhbmRcbiAgICogaXQgaXMgdGhlIHdyb25nIG9yZGVyLCB3aGljaCBpcyB0aGUgbmVhci1taXNzIHRoYXQgbWFrZXMgdGhpcyBhIG1lYXN1cmVtZW50XG4gICAqIHJhdGhlciB0aGFuIGFuIGFzc2VydGlvbjogbm90aGluZyBhYm91dCB0aGUgVFlQRVMgcHJldmVudHMgaXQsIGFuZCBhXG4gICAqIHR5cGUtdG8tdHlwZSBjb21wYXRpYmlsaXR5IGNoZWNrIGNhbm5vdCBzZWUgYSBwb3NpdGlvbi5cbiAgICpcbiAgICog4puUIFJFU1RPUkVEIEZST00gVEhFIFNQRUxMIFRISVMgTU9EVUxFIFdBUyBDT05WRVJHRUQgVE9XQVJELCBBTkQgSVQgSVMgQVxuICAgKiBSRVNUT1JBVElPTiBSQVRIRVIgVEhBTiBBIFdJREVOSU5HIE9OIFRXTyBNRUFTVVJFRCBOVU1CRVJTIChENzkvRDg1KS5cbiAgICogbWluZC1tYXBwZXIncyBgc3NlUmVzcG9uc2VgIHdyb3RlIGl0cyBgdGFpbCAtLWluYm91bmRgIGdyb3VuZGluZyBmcmFtZSBvbmVcbiAgICogbGluZSBBQk9WRSBgYnVzLnN1YnNjcmliZWA7IHRoaXMgbW9kdWxlJ3MgY29udmVyZ2VuY2UgZHJvcHBlZCB0aGUgcG9zaXRpb24sXG4gICAqIHNvIHRoZSBvbmx5IHByb3BlcnR5IG1pbmQtbWFwcGVyIGNvdWxkIG5vdCBhZG9wdCB3YXMgdGhlIG9yZGVyaW5nLiBBcHBsaWVkLFxuICAgKiB3aXRoIGV2ZXJ5IGtpdC1idW5kbGluZyBzcGVsbCByZWJ1aWx0OiAqKihhKSBzb3VyY2UgZWRpdHMgbmVlZGVkIGF0IHRoZVxuICAgKiBvdGhlciBmaXZlIGFkb3B0ZXJzOiBaRVJPKiog4oCUIHRoZSBmaWVsZCBpcyBvcHRpb25hbCBhbmQgbm9ib2R5IHBhc3NlcyBpdDtcbiAgICogKiooYikgYnl0ZXMgb2YgYW55IG90aGVyIGFkb3B0ZXIncyBXSVJFIHRoYXQgZGlmZmVyOiBaRVJPKiog4oCUIGFzdHJvbGFiZSxcbiAgICogYm91bnR5LCBnbGFtb3VyLCBpbWFnbyBhbmQgbWFncGllIHdlcmUgZHJpdmVuIHVuZGVyIHRoZWlyIG93biBzdWl0ZXMgYW5kXG4gICAqIHRoZWlyIHJlbGVhc2UgZHJpdmVzLCBhbmQgbm9uZSBvZiB0aGVtIHdyaXRlcyBhdCBvcGVuLiBCb3RoIG51bWJlcnMgemVybyBpc1xuICAgKiB3aGF0IFwidGhlIGtpdCByZW1vdmVkIGl0IHdoZW4gaXQgY29waWVkXCIgbWVhbnMgb3BlcmF0aW9uYWxseS5cbiAgICpcbiAgICog4pqgIEFORCBUSEUgSE9PSyBXQVMgUkVKRUNURUQgT05DRSwgRk9SIEEgUkVBU09OIFRIQVQgRE9FUyBOT1QgUkVBQ0ggVEhJU1xuICAgKiBDQVNFLiBEMzIncyBub3QtdGFrZW4gYXJndWVkIGFnYWluc3QgXCJhIGBzc2VSZXNwb25zZWAgaG9vayB0aGF0IGhhbmRzIHRoZVxuICAgKiBjYWxsZXIgYSByYXcgYHNlbmRgIOKApiB0aGUgY2FsbGVyIHRoZW4gaGFzIHRvIGtlZXAgaXRzIG93biBjb2xsZWN0aW9uIG9mXG4gICAqIHRoZW1cIiDigJQgYWdhaW5zdCBnbGFtb3VyJ3MgcHJlc2VuY2UgQlJPQURDQVNULCB3aGljaCBwdXNoZXMgdG9cbiAgICogYWxyZWFkeS1vcGVuIHN0cmVhbXMgZnJvbSBvdXRzaWRlIGFuZCBkb2VzIG5lZWQgYSBjb2xsZWN0aW9uLiBUaGlzIGlzIG9uZVxuICAgKiBmcmFtZSwgb24gb25lIHN0cmVhbSwgYXQgb3BlbiwgYW5kIHRoZSBjYWxsZXIga2VlcHMgbm8gY29sbGVjdGlvbiBhdCBhbGwuXG4gICAqIEEgcmVqZWN0aW9uIGlzIHNjb3BlZCB0byB0aGUgY2FzZSB0aGF0IHByb2R1Y2VkIGl0LlxuICAgKi9cbiAgb3BlbkZyYW1lcz86ICgpID0+IHN0cmluZ1tdO1xuICAvKiogUnVuIGFmdGVyIHRoZSBzdHJlYW0gaXMgc3Vic2NyaWJlZCAocHJlc2VuY2UgdXAsIGFjdGl2aXR5IHRvdWNoKS4gKi9cbiAgb25PcGVuPzogKCkgPT4gdm9pZDtcbiAgLyoqIFJ1biBleGFjdGx5IG9uY2UsIGZyb20gd2hpY2hldmVyIHRlYXJkb3duIHBhdGggZmlyZXMgZmlyc3QuICovXG4gIG9uQ2xvc2U/OiAoKSA9PiB2b2lkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3NlUmVzcG9uc2U8VCBleHRlbmRzIG9iamVjdD4ob3B0czogU3NlT3B0aW9uczxUPik6IFJlc3BvbnNlIHtcbiAgY29uc3QgeyBsb2csIHNpbmNlLCBoZWFydGJlYXRNcywgY2xpZW50cywgc2lnbmFsLCBmaWx0ZXIsIG9wZW5GcmFtZXMsIG9uT3Blbiwgb25DbG9zZSB9ID0gb3B0cztcblxuICBsZXQgdW5zdWJzY3JpYmU6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBsZXQga2VlcGFsaXZlOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRJbnRlcnZhbD4gfCBudWxsID0gbnVsbDtcbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICAvLyBUaGUgcmVnaXN0cnkgZW50cnkgZm9yIFRISVMgc3RyZWFtLiBJdHMgbWV0aG9kcyBhcmUgZmlsbGVkIGluIGJ5IGBzdGFydGAsXG4gIC8vIHdoaWNoIGlzIHdoZXJlIHRoZSBjb250cm9sbGVyIGV4aXN0czsgdGhlIG9iamVjdCBpZGVudGl0eSBpcyBzdGFibGUgZnJvbVxuICAvLyBoZXJlIHNvIGB0ZWFyZG93bmAgY2FuIHJlbW92ZSBleGFjdGx5IHRoaXMgZW50cnkuXG4gIGNvbnN0IGNsaWVudDogU3NlQ2xpZW50ID0geyBjbG9zZTogKCkgPT4ge30sIHNlbmQ6ICgpID0+IHt9IH07XG5cbiAgY29uc3QgdGVhcmRvd24gPSAoKSA9PiB7XG4gICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgIGNsb3NlZCA9IHRydWU7XG4gICAgaWYgKGtlZXBhbGl2ZSAhPT0gbnVsbCkgY2xlYXJJbnRlcnZhbChrZWVwYWxpdmUpO1xuICAgIHVuc3Vic2NyaWJlPy4oKTtcbiAgICBjbGllbnRzPy5kZWxldGUoY2xpZW50KTtcbiAgICBvbkNsb3NlPy4oKTtcbiAgfTtcblxuICBjb25zdCBzdHJlYW0gPSBuZXcgUmVhZGFibGVTdHJlYW0oe1xuICAgIHN0YXJ0KGNvbnRyb2xsZXIpIHtcbiAgICAgIGNvbnN0IGVuY29kZXIgPSBuZXcgVGV4dEVuY29kZXIoKTtcbiAgICAgIGNvbnN0IHNhZmVFbnF1ZXVlID0gKGNodW5rOiBzdHJpbmcpID0+IHtcbiAgICAgICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnRyb2xsZXIuZW5xdWV1ZShlbmNvZGVyLmVuY29kZShjaHVuaykpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICB0ZWFyZG93bigpO1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgY2xpZW50LmNsb3NlID0gKCkgPT4ge1xuICAgICAgICB0ZWFyZG93bigpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnRyb2xsZXIuY2xvc2UoKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLyogYWxyZWFkeSBjbG9zZWQgYnkgdGhlIHJ1bnRpbWUgKi9cbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIC8vIOKblCBgc2VuZGAgR09FUyBUSFJPVUdIIGBzYWZlRW5xdWV1ZWAsIHNvIGFuIG91dC1vZi1iYW5kIGZyYW1lIG9iZXlzIHRoZVxuICAgICAgLy8gc2FtZSBjbG9zZWQtY2hlY2sgYW5kIHRoZSBzYW1lIHRlYXJkb3duLW9uLXRocm93IGFzIGEgbG9nZ2VkIG9uZS4gQVxuICAgICAgLy8gZGFlbW9uIG11c3Qgbm90IGJlIGFibGUgdG8gd3JpdGUgdG8gYSBzdHJlYW0gdGhpcyBtb2R1bGUgaGFzIHRvcm4gZG93bi5cbiAgICAgIGNsaWVudC5zZW5kID0gc2FmZUVucXVldWU7XG5cbiAgICAgIC8vIOKblCBBTiBPUEVOSU5HIENPTU1FTlQsIEJFRk9SRSBBTllUSElORyBFTFNFLiBJdCBmbHVzaGVzIHRoZSByZXNwb25zZVxuICAgICAgLy8gaGVhZGVycyBpbW1lZGlhdGVseTogc29tZSBIVFRQIGNsaWVudHMg4oCUIEJ1bidzIG93biBgZmV0Y2goKWAgaW5jbHVkZWQg4oCUXG4gICAgICAvLyBidWZmZXIgdW50aWwgdGhlIGZpcnN0IGJ5dGUgb2YgYm9keSBhcnJpdmVzLCBzbyBhIGdlbnVpbmVseSBxdWlldCBTU0VcbiAgICAgIC8vIHN0cmVhbSB3b3VsZCBvdGhlcndpc2UgbGVhdmUgdGhlIGNhbGxlcidzIGBmZXRjaCgpYCB1bnJlc29sdmVkLiBFdmVyeVxuICAgICAgLy8gaG91c2UgdGFpbCBjbGllbnQgcmVhZHMgYDpgIGxpbmVzIGFzIGNvbW1lbnRzIGFuZCBkcm9wcyB0aGVtLlxuICAgICAgc2FmZUVucXVldWUoXCI6IGNvbm5lY3RlZFxcblxcblwiKTtcblxuICAgICAgLy8g4puUIEJFRk9SRSBUSEUgUkVQTEFZLCBBTkQgVEhFIE9SREVSIElTIFRIRSBXSE9MRSBQT0lOVCDigJQgc2VlXG4gICAgICAvLyBgb3BlbkZyYW1lc2AgaW4gdGhlIG9wdGlvbnMgYWJvdmUuIEEgZ3JvdW5kaW5nIGZyYW1lIHdyaXR0ZW4gaGVyZSBpc1xuICAgICAgLy8gdGhlIHN0cmVhbSdzIGZpcnN0IGRhdGEgbGluZTsgd3JpdHRlbiBmcm9tIGBvbk9wZW5gIGl0IGFycml2ZXMgYWZ0ZXJcbiAgICAgIC8vIHRoZSByZXBsYXllZCBiYWNrbG9nLCB3aGljaCBpcyBhIGRpZmZlcmVudCBjb250cmFjdCB3ZWFyaW5nIHRoZSBzYW1lXG4gICAgICAvLyB0eXBlcy5cbiAgICAgIGlmIChvcGVuRnJhbWVzKSBmb3IgKGNvbnN0IGNodW5rIG9mIG9wZW5GcmFtZXMoKSkgc2FmZUVucXVldWUoY2h1bmspO1xuXG4gICAgICB1bnN1YnNjcmliZSA9IGxvZy5zdWJzY3JpYmUoc2luY2UsIChmcmFtZSkgPT4ge1xuICAgICAgICBpZiAoZmlsdGVyICYmICFmaWx0ZXIoZnJhbWUpKSByZXR1cm47XG4gICAgICAgIHNhZmVFbnF1ZXVlKGBkYXRhOiAke0pTT04uc3RyaW5naWZ5KGZyYW1lKX1cXG5cXG5gKTtcbiAgICAgIH0pO1xuXG4gICAgICBrZWVwYWxpdmUgPSBzZXRJbnRlcnZhbCgoKSA9PiBzYWZlRW5xdWV1ZShcIjogaGJcXG5cXG5cIiksIGhlYXJ0YmVhdE1zKTtcbiAgICAgIHNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIHRlYXJkb3duLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICBjbGllbnRzPy5hZGQoY2xpZW50KTtcbiAgICAgIG9uT3Blbj8uKCk7XG4gICAgfSxcbiAgICBjYW5jZWwoKSB7XG4gICAgICB0ZWFyZG93bigpO1xuICAgIH0sXG4gIH0pO1xuXG4gIHJldHVybiBuZXcgUmVzcG9uc2Uoc3RyZWFtLCB7XG4gICAgaGVhZGVyczoge1xuICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJ0ZXh0L2V2ZW50LXN0cmVhbVwiLFxuICAgICAgXCJDYWNoZS1Db250cm9sXCI6IFwibm8tY2FjaGVcIixcbiAgICAgIENvbm5lY3Rpb246IFwia2VlcC1hbGl2ZVwiLFxuICAgIH0sXG4gIH0pO1xufVxuIiwKICAgICIvLyBGaW5kaW5nIHdoZXJlIGEgbm90ZSBiZWxvbmdzLCBpbiBhIGRvY3VtZW50IHRoYXQgaGFzIG1vdmVkIHVuZGVyIGl0IChFNDUpLlxuLy9cbi8vIOKblCBRVU9URUQtVEVYVCBBTkNIT1JJTkcsIEFORCBUSEUgQUxURVJOQVRJVkUgSVMgV0hZLiBBbiBvZmZzZXQgZ29lcyBzdGFsZSBvblxuLy8gdGhlIG5leHQga2V5c3Ryb2tlOiBmaXggYSB0eXBvIHRocmVlIGxpbmVzIHVwIGFuZCBldmVyeSBub3RlIGJlbG93IHBvaW50cyBhdFxuLy8gdGhlIHdyb25nIHdvcmRzLiBQaW5uaW5nIGEgbm90ZSB0byB0aGUgVkVSU0lPTiBpdCB3YXMgbWFkZSBvbiB3b3VsZCBiZSBleGFjdFxuLy8gZm9yZXZlciBhbmQgdXNlbGVzcyDigJQgdGhlIHN0YXRlZCB1c2UgaXMgbWFraW5nIG5vdGVzIFdISUxFIHJlYWRpbmcgYW5kXG4vLyBlZGl0aW5nLCBhbmQgYSBub3RlIHRoYXQgZGV0YWNoZXMgdGhlIG1vbWVudCB5b3UgZWRpdCBpcyBhIG5vdGUgeW91IGNhbm5vdFxuLy8gdXNlLiBTbyBhIG5vdGUgcmVtZW1iZXJzIHRoZSBURVhUIGl0IHdhcyBtYWRlIG9uLCBwbHVzIGEgbGl0dGxlIG9mIHdoYXRcbi8vIHN1cnJvdW5kZWQgaXQsIGFuZCBpcyByZS1mb3VuZCBvbiBldmVyeSByZWFkIChDb2xlIGFwcHJvdmVkIHRoZSB0cmFkZTogXCJ3ZVxuLy8gdGVzdCBpdCBvdXQgYW5kIHNlZSBpZiBpdCB3b3JrcyBhbmQgYWRqdXN0IGFzIG5lZWRlZFwiKS5cbi8vXG4vLyDim5QgQU5EIElUIFNBWVMgV0hFTiBJVCBIQVMgTE9TVC4gVGhlIGZvdXJ0aCBvdXRjb21lIGlzIE9SUEhBTkVEIOKAlCB0aGUgcXVvdGUgaXNcbi8vIGdvbmUgYW5kIHRoZSBub3RlIGlzIHNob3duIGRldGFjaGVkIHJhdGhlciB0aGFuIHBpbm5lZCBzb21ld2hlcmUgcGxhdXNpYmxlLlxuLy8gVmlzaWJsZS1hbmQtd3JvbmcgYmVhdHMgaW52aXNpYmxlLWFuZC13cm9uZzsgYSBub3RlIHNpbGVudGx5IHJlLWFuY2hvcmVkIG9udG9cbi8vIHVucmVsYXRlZCB3b3JkcyBpcyB0aGUgZmFpbHVyZSB0aGlzIGRlc2lnbiBleGlzdHMgdG8gYXZvaWQuXG5cbi8qKiBIb3cgbXVjaCB0ZXh0IGVpdGhlciBzaWRlIGlzIGtlcHQsIHRvIHRlbGwgaWRlbnRpY2FsIHF1b3RlcyBhcGFydC4gKi9cbmV4cG9ydCBjb25zdCBDT05URVhUX0NIQVJTID0gNDg7XG5cbi8qKiBXaGF0IGEgbm90ZSByZW1lbWJlcnMgYWJvdXQgd2hlcmUgaXQgd2FzIG1hZGUuICovXG5leHBvcnQgdHlwZSBBbmNob3IgPSB7XG4gIC8qKiBUaGUgdGV4dCB0aGUgbm90ZSB3YXMgbWFkZSBvbi4gRW1wdHkgbWVhbnMgdGhlIG5vdGUgaXMgYWJvdXQgdGhlIGRvY3VtZW50LiAqL1xuICBxdW90ZTogc3RyaW5nO1xuICAvKiogVGhlIGNoYXJhY3RlcnMgaW1tZWRpYXRlbHkgYmVmb3JlIGFuZCBhZnRlciB0aGUgcXVvdGUsIHdoZW4gaXQgd2FzIG1hZGUuICovXG4gIGJlZm9yZTogc3RyaW5nO1xuICBhZnRlcjogc3RyaW5nO1xuICAvKiogV2hlcmUgaXQgd2FzIHRoZW4g4oCUIGEgSElOVCBmb3IgY2hvb3NpbmcgYmV0d2VlbiBpZGVudGljYWwgcXVvdGVzLCBuZXZlciBhIHNvdXJjZSBvZiB0cnV0aC4gKi9cbiAgYXQ6IG51bWJlcjtcbn07XG5cbi8qKiBXaGVyZSBhIG5vdGUgYmVsb25ncyBub3csIGFuZCBob3cgc3VyZSB3ZSBhcmUuICovXG5leHBvcnQgdHlwZSBGb3VuZCA9XG4gIHwgeyBmcm9tOiBudW1iZXI7IHRvOiBudW1iZXI7IGhvdzogXCJjb250ZXh0XCIgfCBcInVuaXF1ZVwiIHwgXCJuZWFyZXN0XCIgfVxuICB8IHsgZnJvbTogbnVsbDsgdG86IG51bGw7IGhvdzogXCJvcnBoYW5lZFwiIH07XG5cbmNvbnN0IE9SUEhBTkVEOiBGb3VuZCA9IHsgZnJvbTogbnVsbCwgdG86IG51bGwsIGhvdzogXCJvcnBoYW5lZFwiIH07XG5cbi8qKiBUYWtlIGFuIGFuY2hvciBmcm9tIGEgc2VsZWN0aW9uIOKAlCB3aGF0IHRoZSBub3RlIHdpbGwgcmVtZW1iZXIuICovXG5leHBvcnQgZnVuY3Rpb24gYW5jaG9yT2YodGV4dDogc3RyaW5nLCBmcm9tOiBudW1iZXIsIHRvOiBudW1iZXIpOiBBbmNob3Ige1xuICByZXR1cm4ge1xuICAgIHF1b3RlOiB0ZXh0LnNsaWNlKGZyb20sIHRvKSxcbiAgICBiZWZvcmU6IHRleHQuc2xpY2UoTWF0aC5tYXgoMCwgZnJvbSAtIENPTlRFWFRfQ0hBUlMpLCBmcm9tKSxcbiAgICBhZnRlcjogdGV4dC5zbGljZSh0bywgdG8gKyBDT05URVhUX0NIQVJTKSxcbiAgICBhdDogZnJvbSxcbiAgfTtcbn1cblxuLyoqIEV2ZXJ5IGluZGV4IGF0IHdoaWNoIGBuZWVkbGVgIG9jY3VycyBpbiBgaGF5YCwgaW5jbHVkaW5nIG92ZXJsYXBzLiAqL1xuZnVuY3Rpb24gb2NjdXJyZW5jZXMoaGF5OiBzdHJpbmcsIG5lZWRsZTogc3RyaW5nKTogbnVtYmVyW10ge1xuICBpZiAobmVlZGxlID09PSBcIlwiKSByZXR1cm4gW107XG4gIGNvbnN0IGZvdW5kOiBudW1iZXJbXSA9IFtdO1xuICBsZXQgaSA9IGhheS5pbmRleE9mKG5lZWRsZSk7XG4gIHdoaWxlIChpICE9PSAtMSkge1xuICAgIGZvdW5kLnB1c2goaSk7XG4gICAgaSA9IGhheS5pbmRleE9mKG5lZWRsZSwgaSArIDEpO1xuICB9XG4gIHJldHVybiBmb3VuZDtcbn1cblxuLyoqXG4gKiBXaGVyZSB0aGUgbm90ZSBiZWxvbmdzIGluIGB0ZXh0YCBub3cuXG4gKlxuICogRm91ciBhbnN3ZXJzLCB0cmllZCBpbiBvcmRlciwgYW5kIGVhY2ggc2F5cyBob3cgaXQgd2FzIHJlYWNoZWQgc28gdGhlIHN1cmZhY2VcbiAqIGNhbiBzaG93IGEgcmUtYW5jaG9yZWQgbm90ZSBkaWZmZXJlbnRseSBmcm9tIGEgY2VydGFpbiBvbmU6XG4gKlxuICogMS4gKipjb250ZXh0Kiog4oCUIHRoZSBxdW90ZSBXSVRIIGl0cyBzdXJyb3VuZGluZ3Mgb2NjdXJzIGV4YWN0bHkgb25jZS4gVGhlXG4gKiAgICBzdHJvbmdlc3QgYW5zd2VyOiB0d28gaWRlbnRpY2FsIHNlbnRlbmNlcyBhcmUgdG9sZCBhcGFydCBieSB3aGF0IGlzXG4gKiAgICBhcm91bmQgdGhlbS5cbiAqIDIuICoqdW5pcXVlKiog4oCUIHRoZSBxdW90ZSBvY2N1cnMgZXhhY3RseSBvbmNlLiBJdHMgc3Vycm91bmRpbmdzIGNoYW5nZWQsIHRoZVxuICogICAgdGV4dCBkaWQgbm90LlxuICogMy4gKipuZWFyZXN0Kiog4oCUIHRoZSBxdW90ZSBvY2N1cnMgc2V2ZXJhbCB0aW1lczsgdGhlIG9uZSBjbG9zZXN0IHRvIHdoZXJlIGl0XG4gKiAgICB1c2VkIHRvIGJlIHdpbnMuIEEgZ3Vlc3MsIGFuZCBsYWJlbGxlZCBhcyBvbmUuXG4gKiA0LiAqKm9ycGhhbmVkKiog4oCUIHRoZSBxdW90ZSBpcyBnb25lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZEFuY2hvcih0ZXh0OiBzdHJpbmcsIGFuY2hvcjogQW5jaG9yKTogRm91bmQge1xuICBpZiAoYW5jaG9yLnF1b3RlID09PSBcIlwiKSByZXR1cm4gT1JQSEFORUQ7XG5cbiAgLy8gMS4gV2l0aCBjb250ZXh0LiBUaGUgcmVjb3JkZWQgY29udGV4dCBtYXkgaXRzZWxmIGJlIGNsaXBwZWQgYXQgYSBkb2N1bWVudFxuICAvLyAgICBlZGdlLCBzbyB0aGUgd2hvbGUgcnVuIGlzIHNlYXJjaGVkIHJhdGhlciB0aGFuIGFzc2VtYmxlZCBibGluZGx5LlxuICBjb25zdCB3aXRoQ29udGV4dCA9IGFuY2hvci5iZWZvcmUgKyBhbmNob3IucXVvdGUgKyBhbmNob3IuYWZ0ZXI7XG4gIGNvbnN0IGNvbnRleHRzID0gb2NjdXJyZW5jZXModGV4dCwgd2l0aENvbnRleHQpO1xuICBpZiAoY29udGV4dHMubGVuZ3RoID09PSAxKSB7XG4gICAgY29uc3QgZnJvbSA9IChjb250ZXh0c1swXSBhcyBudW1iZXIpICsgYW5jaG9yLmJlZm9yZS5sZW5ndGg7XG4gICAgcmV0dXJuIHsgZnJvbSwgdG86IGZyb20gKyBhbmNob3IucXVvdGUubGVuZ3RoLCBob3c6IFwiY29udGV4dFwiIH07XG4gIH1cblxuICBjb25zdCBoaXRzID0gb2NjdXJyZW5jZXModGV4dCwgYW5jaG9yLnF1b3RlKTtcbiAgaWYgKGhpdHMubGVuZ3RoID09PSAwKSByZXR1cm4gT1JQSEFORUQ7XG5cbiAgLy8gMi4gVGhlIHF1b3RlIGFsb25lLCBvbmNlLlxuICBpZiAoaGl0cy5sZW5ndGggPT09IDEpIHtcbiAgICBjb25zdCBmcm9tID0gaGl0c1swXSBhcyBudW1iZXI7XG4gICAgcmV0dXJuIHsgZnJvbSwgdG86IGZyb20gKyBhbmNob3IucXVvdGUubGVuZ3RoLCBob3c6IFwidW5pcXVlXCIgfTtcbiAgfVxuXG4gIC8vIDMuIFNldmVyYWwg4oCUIHRha2UgdGhlIG9uZSBuZWFyZXN0IHdoZXJlIGl0IHdhcy4gYGF0YCBpcyBhIGhpbnQsIHdoaWNoIGlzXG4gIC8vICAgIHdoeSB0aGlzIGFuc3dlciBpcyBsYWJlbGxlZDogdGhlIG5vdGUgbWF5IGhhdmUgbGFuZGVkIG9uIGEgdHdpbi5cbiAgbGV0IGJlc3QgPSBoaXRzWzBdIGFzIG51bWJlcjtcbiAgZm9yIChjb25zdCBoaXQgb2YgaGl0cykgaWYgKE1hdGguYWJzKGhpdCAtIGFuY2hvci5hdCkgPCBNYXRoLmFicyhiZXN0IC0gYW5jaG9yLmF0KSkgYmVzdCA9IGhpdDtcbiAgcmV0dXJuIHsgZnJvbTogYmVzdCwgdG86IGJlc3QgKyBhbmNob3IucXVvdGUubGVuZ3RoLCBob3c6IFwibmVhcmVzdFwiIH07XG59XG5cbi8qKiBBIG9uZS1saW5lIHZlcnNpb24gb2YgdGhlIHF1b3RlLCBmb3IgYSBsaXN0IHRoYXQgY2Fubm90IHNob3cgYWxsIG9mIGl0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHF1b3RlTGFiZWwocXVvdGU6IHN0cmluZywgbWF4ID0gNjApOiBzdHJpbmcge1xuICBjb25zdCBmbGF0ID0gcXVvdGUucmVwbGFjZSgvXFxzKy9ndSwgXCIgXCIpLnRyaW0oKTtcbiAgcmV0dXJuIGZsYXQubGVuZ3RoIDw9IG1heCA/IGZsYXQgOiBgJHtmbGF0LnNsaWNlKDAsIG1heCAtIDEpLnRyaW1FbmQoKX3igKZgO1xufVxuIiwKICAgICIvLyBDb21wYXJpbmcgdHdvIHRleHRzLCBhbmQgdGFraW5nIHBhcnQgb2Ygb25lIGludG8gdGhlIG90aGVyIChFMzYpLlxuLy9cbi8vIOKblCBPTkUgRElGRiwgQ09NUFVURUQgSU4gVEhFIERBRU1PTi4gYEBjb2RlbWlycm9yL21lcmdlYCB3YXMgbWVhc3VyZWQgZmlyc3Rcbi8vIGFuZCBpdCBpcyBidW5kbGUtY2xlYW4g4oCUIGl0cyBvbmx5IGRlcGVuZGVuY2llcyBhcmUgYEBjb2RlbWlycm9yL2xhbmd1YWdlYCxcbi8vIGBzdGF0ZWAsIGB2aWV3YCBhbmQgYEBsZXplci9oaWdobGlnaHRgLCBldmVyeSBvbmUgb2Ygd2hpY2ggdGhlIHN1cmZhY2Vcbi8vIGFscmVhZHkgc2hpcHMsIHNvIHdhcmQgMWIgaGFzIG5vdGhpbmcgdG8gc2F5IGFib3V0IGl0LiBJdCBpcyBub3QgdXNlZFxuLy8gYW55d2F5LCBhbmQgdGhlIHJlYXNvbiBpcyBub3Qgd2VpZ2h0OiBpdCB3b3VsZCBnaXZlIHRoZSBTVVJGQUNFIGl0cyBvd25cbi8vIGRpZmYgd2hpbGUgdGhlIGBkaWZmYCBDTEkgdmVyYiB1c2VkIHRoaXMgbW9kdWxlJ3MsIGFuZCBhIGh1bmsgdGhlIGh1bWFuXG4vLyBhY2NlcHRzIHdvdWxkIHRoZW4gYmUgYSBodW5rIGEgZGlmZmVyZW50IGVuZ2luZSBmb3VuZC4gVHdvIGRpZmYgZW5naW5lcyBvdmVyXG4vLyBvbmUgZG9jdW1lbnQgaXMgdGhlIGxvY2tzdGVwLW1pcnJvciBkcmlmdCB0aGlzIHJlcG8gaGFzIGFscmVhZHkgcGFpZCBmb3Jcbi8vIG9uY2UuIFRoZSBzdXJmYWNlIHJlbmRlcnMgdGhlIGh1bmtzIHRoZSBkYWVtb24gY29tcHV0ZWQsIGFuZCBgbWVyZ2VgIGFwcGxpZXNcbi8vIHRoZSBzYW1lIG9uZXMg4oCUIHNvIGEgbWlzbWF0Y2ggaXMgbm90IGEgYnVnIHRoYXQgY2FuIGJlIHdyaXR0ZW4gaGVyZS5cbi8vXG4vLyBXaGF0IHRoaXMgZGVsaWJlcmF0ZWx5IGlzIG5vdDogYSBzZW1hbnRpYyBvciBzeW50YWN0aWMgZGlmZi4gSXQgY29tcGFyZXNcbi8vIExJTkVTLCB0aGVuIHJlZmluZXMgaW5zaWRlIHBhaXJlZCBsaW5lcyBieSBXT1JELCB3aGljaCBpcyB3aGF0IGEgcHJvc2Vcbi8vIHJlYWRlciB3YW50cyDigJQgbW92ZWQgcGFyYWdyYXBocyByZWFkIGFzIGEgZGVsZXRlIGFuZCBhbiBhZGQsIGFuZCB0aGF0IGlzXG4vLyB0aGUgaG9uZXN0IGFuc3dlciByYXRoZXIgdGhhbiBhIHdyb25nIGNsZXZlciBvbmUuXG5pbXBvcnQgdHlwZSB7IERpZmYsIERpZmZIdW5rLCBEaWZmTGluZSwgRGlmZlNwYW4gfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKipcbiAqIFNwbGl0dGluZyBvbiBcIlxcblwiIGFuZCBqb2luaW5nIG9uIFwiXFxuXCIgcm91bmQtdHJpcHMgZXhhY3RseSwgSU5DTFVESU5HIHRoZVxuICogdHJhaWxpbmcgZW1wdHkgc3RyaW5nIGEgZmlsZSBlbmRpbmcgaW4gYSBuZXdsaW5lIHByb2R1Y2VzLiBUaGF0IGVtcHR5IGxpbmVcbiAqIGlzIHJlYWwgYXMgZmFyIGFzIHRoaXMgbW9kdWxlIGlzIGNvbmNlcm5lZCwgd2hpY2ggaXMgd2hhdCBrZWVwcyBhIG1lcmdlIGZyb21cbiAqIHF1aWV0bHkgYWRkaW5nIG9yIGRyb3BwaW5nIGEgZmluYWwgbmV3bGluZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNwbGl0TGluZXModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC5zcGxpdChcIlxcblwiKTtcbn1cblxuLyoqXG4gKiBUaGUgY2FwIG9uIE15ZXJzJyBEIOKAlCB0aGUgbnVtYmVyIG9mIGVkaXRzIGl0IHdpbGwgd2FsayBiZWZvcmUgZ2l2aW5nIHVwLlxuICogVHdvIHRleHRzIGRpZmZlcmluZyBieSBtb3JlIHRoYW4gdGhpcyBhcmUgbm90IHNvbWV0aGluZyBhIGh1bWFuIHJlYWRzIGh1bmtcbiAqIGJ5IGh1bmsgYW55d2F5LCBhbmQgdGhlIHF1YWRyYXRpYyB3b3JzdCBjYXNlIGlzIHdoYXQgdGhlIGNhcCBleGlzdHMgdG8ga2VlcFxuICogb3V0IG9mIGEgZGFlbW9uIHNlcnZpbmcgYSBzdXJmYWNlLlxuICovXG5jb25zdCBNQVhfRURJVFMgPSAzMDAwO1xuXG4vKipcbiAqIE15ZXJzJyBncmVlZHkgTyhORCkgZGlmZiBvdmVyIGxpbmVzLiBSZXR1cm5zIHRoZSB0cmFjZSBvZiBWIGFycmF5cywgb3IgbnVsbFxuICogd2hlbiB0aGUgdGV4dHMgZGlmZmVyIGJ5IG1vcmUgdGhhbiBgTUFYX0VESVRTYC5cbiAqL1xuZnVuY3Rpb24gbXllcnNUcmFjZShhOiBzdHJpbmdbXSwgYjogc3RyaW5nW10pOiBJbnQzMkFycmF5W10gfCBudWxsIHtcbiAgY29uc3QgbiA9IGEubGVuZ3RoO1xuICBjb25zdCBtID0gYi5sZW5ndGg7XG4gIGNvbnN0IG1heCA9IE1hdGgubWluKG4gKyBtLCBNQVhfRURJVFMpO1xuICBjb25zdCBzaXplID0gMiAqIG1heCArIDE7XG4gIGNvbnN0IG9mZnNldCA9IG1heDtcbiAgbGV0IHYgPSBuZXcgSW50MzJBcnJheShzaXplKTtcbiAgY29uc3QgdHJhY2U6IEludDMyQXJyYXlbXSA9IFtdO1xuICBmb3IgKGxldCBkID0gMDsgZCA8PSBtYXg7IGQrKykge1xuICAgIHRyYWNlLnB1c2godi5zbGljZSgpKTtcbiAgICBmb3IgKGxldCBrID0gLWQ7IGsgPD0gZDsgayArPSAyKSB7XG4gICAgICAvLyBUYWtlIHRoZSBsb25nZXIgb2YgdGhlIHR3byByZWFjaGFibGUgcGF0aHM6IGRvd24gKGFuIGluc2VydGlvbikgd2hlblxuICAgICAgLy8gayBpcyBhdCB0aGUgbG93ZXIgZWRnZSBvciB0aGUgZG93bi1uZWlnaGJvdXIgaGFzIGNvbWUgZnVydGhlci5cbiAgICAgIGNvbnN0IGRvd24gPSB2W29mZnNldCArIGsgKyAxXSBhcyBudW1iZXI7XG4gICAgICBjb25zdCByaWdodCA9IHZbb2Zmc2V0ICsgayAtIDFdIGFzIG51bWJlcjtcbiAgICAgIGxldCB4OiBudW1iZXI7XG4gICAgICBpZiAoayA9PT0gLWQgfHwgKGsgIT09IGQgJiYgcmlnaHQgPCBkb3duKSkgeCA9IGRvd247XG4gICAgICBlbHNlIHggPSByaWdodCArIDE7XG4gICAgICBsZXQgeSA9IHggLSBrO1xuICAgICAgd2hpbGUgKHggPCBuICYmIHkgPCBtICYmIGFbeF0gPT09IGJbeV0pIHtcbiAgICAgICAgeCsrO1xuICAgICAgICB5Kys7XG4gICAgICB9XG4gICAgICB2W29mZnNldCArIGtdID0geDtcbiAgICAgIGlmICh4ID49IG4gJiYgeSA+PSBtKSByZXR1cm4gdHJhY2U7XG4gICAgfVxuICAgIHYgPSB2LnNsaWNlKCk7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiBXYWxrIHRoZSB0cmFjZSBiYWNrd2FyZHMgaW50byBhIGxpc3Qgb2YgbGluZSBvcGVyYXRpb25zLCBmcm9udCB0byBiYWNrLiAqL1xuZnVuY3Rpb24gYmFja3RyYWNrKGE6IHN0cmluZ1tdLCBiOiBzdHJpbmdbXSwgdHJhY2U6IEludDMyQXJyYXlbXSk6IERpZmZMaW5lW10ge1xuICBjb25zdCBvZmZzZXQgPSBNYXRoLm1pbihhLmxlbmd0aCArIGIubGVuZ3RoLCBNQVhfRURJVFMpO1xuICBjb25zdCBvdXQ6IERpZmZMaW5lW10gPSBbXTtcbiAgbGV0IHggPSBhLmxlbmd0aDtcbiAgbGV0IHkgPSBiLmxlbmd0aDtcbiAgZm9yIChsZXQgZCA9IHRyYWNlLmxlbmd0aCAtIDE7IGQgPj0gMDsgZC0tKSB7XG4gICAgY29uc3QgdiA9IHRyYWNlW2RdIGFzIEludDMyQXJyYXk7XG4gICAgY29uc3QgayA9IHggLSB5O1xuICAgIGxldCBwcmV2SzogbnVtYmVyO1xuICAgIGlmIChrID09PSAtZCB8fCAoayAhPT0gZCAmJiAodltvZmZzZXQgKyBrIC0gMV0gYXMgbnVtYmVyKSA8ICh2W29mZnNldCArIGsgKyAxXSBhcyBudW1iZXIpKSlcbiAgICAgIHByZXZLID0gayArIDE7XG4gICAgZWxzZSBwcmV2SyA9IGsgLSAxO1xuICAgIGNvbnN0IHByZXZYID0gdltvZmZzZXQgKyBwcmV2S10gYXMgbnVtYmVyO1xuICAgIGNvbnN0IHByZXZZID0gcHJldlggLSBwcmV2SztcbiAgICB3aGlsZSAoeCA+IHByZXZYICYmIHkgPiBwcmV2WSkge1xuICAgICAgeC0tO1xuICAgICAgeS0tO1xuICAgICAgb3V0LnB1c2goeyBvcDogXCJzYW1lXCIsIGE6IHgsIGI6IHksIHRleHQ6IGFbeF0gYXMgc3RyaW5nIH0pO1xuICAgIH1cbiAgICBpZiAoZCA9PT0gMCkgYnJlYWs7XG4gICAgaWYgKHggPiBwcmV2WCkge1xuICAgICAgeC0tO1xuICAgICAgb3V0LnB1c2goeyBvcDogXCJkZWxcIiwgYTogeCwgdGV4dDogYVt4XSBhcyBzdHJpbmcgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHktLTtcbiAgICAgIG91dC5wdXNoKHsgb3A6IFwiYWRkXCIsIGI6IHksIHRleHQ6IGJbeV0gYXMgc3RyaW5nIH0pO1xuICAgIH1cbiAgfVxuICBvdXQucmV2ZXJzZSgpO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogRXZlcnkgbGluZSBhcyBvbmUgcmVwbGFjZW1lbnQg4oCUIHRoZSBob25lc3QgYW5zd2VyIHdoZW4gTXllcnMgZ2l2ZXMgdXAuICovXG5mdW5jdGlvbiBjb2Fyc2VMaW5lcyhhOiBzdHJpbmdbXSwgYjogc3RyaW5nW10pOiBEaWZmTGluZVtdIHtcbiAgcmV0dXJuIFtcbiAgICAuLi5hLm1hcCgodGV4dCwgaSkgPT4gKHsgb3A6IFwiZGVsXCIgYXMgY29uc3QsIGE6IGksIHRleHQgfSkpLFxuICAgIC4uLmIubWFwKCh0ZXh0LCBpKSA9PiAoeyBvcDogXCJhZGRcIiBhcyBjb25zdCwgYjogaSwgdGV4dCB9KSksXG4gIF07XG59XG5cbi8qKiBHcm91cCB0aGUgbGluZSBvcHMgaW50byBjb250aWd1b3VzIGh1bmtzLCBudW1iZXJlZCBmcm9tIDEuICovXG5mdW5jdGlvbiBjb2xsZWN0KGxpbmVzOiBEaWZmTGluZVtdKTogRGlmZkh1bmtbXSB7XG4gIGNvbnN0IGh1bmtzOiBEaWZmSHVua1tdID0gW107XG4gIGxldCBpID0gMDtcbiAgbGV0IGlkID0gMTtcbiAgd2hpbGUgKGkgPCBsaW5lcy5sZW5ndGgpIHtcbiAgICBpZiAoKGxpbmVzW2ldIGFzIERpZmZMaW5lKS5vcCA9PT0gXCJzYW1lXCIpIHtcbiAgICAgIGkrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBzdGFydCA9IGk7XG4gICAgd2hpbGUgKGkgPCBsaW5lcy5sZW5ndGggJiYgKGxpbmVzW2ldIGFzIERpZmZMaW5lKS5vcCAhPT0gXCJzYW1lXCIpIGkrKztcbiAgICBjb25zdCBydW4gPSBsaW5lcy5zbGljZShzdGFydCwgaSk7XG4gICAgY29uc3QgZGVsID0gcnVuLmZpbHRlcigobCkgPT4gbC5vcCA9PT0gXCJkZWxcIik7XG4gICAgY29uc3QgYWRkID0gcnVuLmZpbHRlcigobCkgPT4gbC5vcCA9PT0gXCJhZGRcIik7XG4gICAgLy8gV2hlcmUgdGhlIGh1bmsgc2l0cyBpbiBlYWNoIHRleHQ6IHRoZSBpbmRleCBvZiB0aGUgZmlyc3QgbGluZSBpdCB0b3VjaGVzLFxuICAgIC8vIGFuZCBmb3IgYSBwdXJlIGluc2VydGlvbiwgdGhlIHBvaW50IGl0IGlzIGluc2VydGVkIEFULlxuICAgIGNvbnN0IGFGcm9tID0gZGVsLmxlbmd0aCA/ICgoZGVsWzBdIGFzIERpZmZMaW5lKS5hIGFzIG51bWJlcikgOiBuZXh0SW5kZXgobGluZXMsIHN0YXJ0LCBcImFcIik7XG4gICAgY29uc3QgYkZyb20gPSBhZGQubGVuZ3RoID8gKChhZGRbMF0gYXMgRGlmZkxpbmUpLmIgYXMgbnVtYmVyKSA6IG5leHRJbmRleChsaW5lcywgc3RhcnQsIFwiYlwiKTtcbiAgICBodW5rcy5wdXNoKHtcbiAgICAgIGlkOiBpZCsrLFxuICAgICAgYUZyb20sXG4gICAgICBhVG86IGFGcm9tICsgZGVsLmxlbmd0aCxcbiAgICAgIGJGcm9tLFxuICAgICAgYlRvOiBiRnJvbSArIGFkZC5sZW5ndGgsXG4gICAgICBkZWw6IGRlbC5tYXAoKGwpID0+IGwudGV4dCksXG4gICAgICBhZGQ6IGFkZC5tYXAoKGwpID0+IGwudGV4dCksXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIGh1bmtzO1xufVxuXG4vKipcbiAqIFRoZSBpbmRleCBhIHB1cmUgaW5zZXJ0aW9uIG9yIGRlbGV0aW9uIHNpdHMgYXQ6IHRoZSBsaW5lIG51bWJlciBvZiB0aGUgbmV4dFxuICogYHNhbWVgIGxpbmUgb24gdGhhdCBzaWRlLCBvciB0aGUgZW5kIG9mIHRoYXQgdGV4dCB3aGVuIHRoZXJlIGlzIG5vbmUuXG4gKi9cbmZ1bmN0aW9uIG5leHRJbmRleChsaW5lczogRGlmZkxpbmVbXSwgZnJvbTogbnVtYmVyLCBzaWRlOiBcImFcIiB8IFwiYlwiKTogbnVtYmVyIHtcbiAgZm9yIChsZXQgaSA9IGZyb207IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGF0ID0gKGxpbmVzW2ldIGFzIERpZmZMaW5lKVtzaWRlXTtcbiAgICBpZiAoYXQgIT09IHVuZGVmaW5lZCkgcmV0dXJuIGF0O1xuICB9XG4gIGxldCBsYXN0ID0gLTE7XG4gIGZvciAoY29uc3QgbCBvZiBsaW5lcykge1xuICAgIGNvbnN0IGF0ID0gbFtzaWRlXTtcbiAgICBpZiAoYXQgIT09IHVuZGVmaW5lZCAmJiBhdCA+IGxhc3QpIGxhc3QgPSBhdDtcbiAgfVxuICByZXR1cm4gbGFzdCArIDE7XG59XG5cbi8qKiBXb3Jkcywgd2hpdGVzcGFjZSBydW5zIGFuZCBwdW5jdHVhdGlvbiBydW5zLCBrZXB0IHNlcGFyYXRlIHNvIHNwYW5zIGFsaWduLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdvcmRzKGxpbmU6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIGxpbmUubWF0Y2goL1xccyt8W1xccHtMfVxccHtOfV9dK3xbXlxcc1xccHtMfVxccHtOfV9dKy9ndSkgPz8gW107XG59XG5cbi8qKiBUaGUgd29yZC1sZXZlbCBkaWZmIG9mIG9uZSBsaW5lIHBhaXIsIGFzIHNwYW5zIG92ZXIgZWFjaCBzaWRlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZmluZShiZWZvcmU6IHN0cmluZywgYWZ0ZXI6IHN0cmluZyk6IHsgZGVsOiBEaWZmU3BhbltdOyBhZGQ6IERpZmZTcGFuW10gfSB7XG4gIGNvbnN0IGEgPSB3b3JkcyhiZWZvcmUpO1xuICBjb25zdCBiID0gd29yZHMoYWZ0ZXIpO1xuICBjb25zdCB0cmFjZSA9IG15ZXJzVHJhY2UoYSwgYik7XG4gIGlmICghdHJhY2UpXG4gICAgcmV0dXJuIHsgZGVsOiBbeyB0ZXh0OiBiZWZvcmUsIGNoYW5nZWQ6IHRydWUgfV0sIGFkZDogW3sgdGV4dDogYWZ0ZXIsIGNoYW5nZWQ6IHRydWUgfV0gfTtcbiAgY29uc3Qgb3BzID0gYmFja3RyYWNrKGEsIGIsIHRyYWNlKTtcbiAgY29uc3QgZGVsOiBEaWZmU3BhbltdID0gW107XG4gIGNvbnN0IGFkZDogRGlmZlNwYW5bXSA9IFtdO1xuICBmb3IgKGNvbnN0IG9wIG9mIG9wcykge1xuICAgIGlmIChvcC5vcCA9PT0gXCJzYW1lXCIpIHtcbiAgICAgIHB1c2goZGVsLCBvcC50ZXh0LCBmYWxzZSk7XG4gICAgICBwdXNoKGFkZCwgb3AudGV4dCwgZmFsc2UpO1xuICAgIH0gZWxzZSBpZiAob3Aub3AgPT09IFwiZGVsXCIpIHB1c2goZGVsLCBvcC50ZXh0LCB0cnVlKTtcbiAgICBlbHNlIHB1c2goYWRkLCBvcC50ZXh0LCB0cnVlKTtcbiAgfVxuICByZXR1cm4geyBkZWwsIGFkZCB9O1xufVxuXG4vKiogQXBwZW5kLCBtZXJnaW5nIGludG8gdGhlIHByZXZpb3VzIHNwYW4gd2hlbiBpdCBjYXJyaWVzIHRoZSBzYW1lIHZlcmRpY3QuICovXG5mdW5jdGlvbiBwdXNoKHNwYW5zOiBEaWZmU3BhbltdLCB0ZXh0OiBzdHJpbmcsIGNoYW5nZWQ6IGJvb2xlYW4pOiB2b2lkIHtcbiAgY29uc3QgbGFzdCA9IHNwYW5zW3NwYW5zLmxlbmd0aCAtIDFdO1xuICBpZiAobGFzdCAmJiBsYXN0LmNoYW5nZWQgPT09IGNoYW5nZWQpIGxhc3QudGV4dCArPSB0ZXh0O1xuICBlbHNlIHNwYW5zLnB1c2goeyB0ZXh0LCBjaGFuZ2VkIH0pO1xufVxuXG4vKipcbiAqIFJlZmluZSBhIGh1bmsncyBsaW5lcyB3aGVuIHRoZXkgY2FuIGJlIFBBSVJFRC4gQSBodW5rIHJlcGxhY2luZyB0aHJlZSBsaW5lc1xuICogd2l0aCB0aHJlZSBpcyBwYWlyZWQgbGluZSBieSBsaW5lOyBhIDEtZm9yLW1hbnkgaHVuayBpcyBub3QsIGFuZCBnZXRzIG5vXG4gKiBzcGFucyByYXRoZXIgdGhhbiBhbiBhcmJpdHJhcnkgcGFpcmluZyDigJQgc2hvd2luZyBhIHdvcmQtbGV2ZWwgZGlmZiBhZ2FpbnN0XG4gKiB0aGUgd3JvbmcgbGluZSBpcyB3b3JzZSB0aGFuIHNob3dpbmcgbm9uZS5cbiAqL1xuZnVuY3Rpb24gcmVmaW5lSHVuayhsaW5lczogRGlmZkxpbmVbXSwgaHVuazogRGlmZkh1bmspOiB2b2lkIHtcbiAgaWYgKGh1bmsuZGVsLmxlbmd0aCAhPT0gaHVuay5hZGQubGVuZ3RoIHx8IGh1bmsuZGVsLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICBjb25zdCBkZWxzID0gbGluZXMuZmlsdGVyKChsKSA9PiBsLm9wID09PSBcImRlbFwiICYmIGluUmFuZ2UobC5hLCBodW5rLmFGcm9tLCBodW5rLmFUbykpO1xuICBjb25zdCBhZGRzID0gbGluZXMuZmlsdGVyKChsKSA9PiBsLm9wID09PSBcImFkZFwiICYmIGluUmFuZ2UobC5iLCBodW5rLmJGcm9tLCBodW5rLmJUbykpO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGRlbHMubGVuZ3RoICYmIGkgPCBhZGRzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgZCA9IGRlbHNbaV0gYXMgRGlmZkxpbmU7XG4gICAgY29uc3QgYWQgPSBhZGRzW2ldIGFzIERpZmZMaW5lO1xuICAgIGNvbnN0IHsgZGVsLCBhZGQgfSA9IHJlZmluZShkLnRleHQsIGFkLnRleHQpO1xuICAgIGQuc3BhbnMgPSBkZWw7XG4gICAgYWQuc3BhbnMgPSBhZGQ7XG4gIH1cbn1cblxuZnVuY3Rpb24gaW5SYW5nZShhdDogbnVtYmVyIHwgdW5kZWZpbmVkLCBmcm9tOiBudW1iZXIsIHRvOiBudW1iZXIpOiBib29sZWFuIHtcbiAgcmV0dXJuIGF0ICE9PSB1bmRlZmluZWQgJiYgYXQgPj0gZnJvbSAmJiBhdCA8IHRvO1xufVxuXG4vKiogQ29tcGFyZSB0d28gdGV4dHMgYnkgbGluZSwgcmVmaW5lZCBieSB3b3JkIGluc2lkZSBwYWlyZWQgbGluZXMuICovXG5leHBvcnQgZnVuY3Rpb24gZGlmZlRleHQoYmVmb3JlOiBzdHJpbmcsIGFmdGVyOiBzdHJpbmcpOiBEaWZmIHtcbiAgaWYgKGJlZm9yZSA9PT0gYWZ0ZXIpIHtcbiAgICBjb25zdCBsaW5lcyA9IHNwbGl0TGluZXMoYmVmb3JlKS5tYXAoKHRleHQsIGkpID0+ICh7XG4gICAgICBvcDogXCJzYW1lXCIgYXMgY29uc3QsXG4gICAgICBhOiBpLFxuICAgICAgYjogaSxcbiAgICAgIHRleHQsXG4gICAgfSkpO1xuICAgIHJldHVybiB7IGxpbmVzLCBodW5rczogW10sIHNhbWU6IHRydWUsIGNvYXJzZTogZmFsc2UgfTtcbiAgfVxuICBjb25zdCBhID0gc3BsaXRMaW5lcyhiZWZvcmUpO1xuICBjb25zdCBiID0gc3BsaXRMaW5lcyhhZnRlcik7XG4gIGNvbnN0IHRyYWNlID0gbXllcnNUcmFjZShhLCBiKTtcbiAgY29uc3QgY29hcnNlID0gdHJhY2UgPT09IG51bGw7XG4gIGNvbnN0IGxpbmVzID0gdHJhY2UgPyBiYWNrdHJhY2soYSwgYiwgdHJhY2UpIDogY29hcnNlTGluZXMoYSwgYik7XG4gIGNvbnN0IGh1bmtzID0gY29sbGVjdChsaW5lcyk7XG4gIGZvciAoY29uc3QgaCBvZiBodW5rcykgcmVmaW5lSHVuayhsaW5lcywgaCk7XG4gIHJldHVybiB7IGxpbmVzLCBodW5rcywgc2FtZTogZmFsc2UsIGNvYXJzZSB9O1xufVxuXG4vKipcbiAqIFRha2UgaHVua3MgZnJvbSB0aGUgcmlnaHQgc2lkZSBpbnRvIHRoZSBsZWZ0LiBgdGFrZWAgaXMgdGhlIGlkcyB0byBhcHBseTtcbiAqIGV2ZXJ5IGh1bmsgbm90IG5hbWVkIGlzIGxlZnQgYXMgdGhlIGxlZnQgc2lkZSBoYXMgaXQuXG4gKlxuICog4puUIEFQUExJRUQgQkFDSyBUTyBGUk9OVCwgc28gYW4gZWFybGllciBodW5rJ3MgbGluZSBudW1iZXJzIGFyZSBzdGlsbCB0aGVcbiAqIG9uZXMgdGhlIGRpZmYgcmVwb3J0ZWQgd2hlbiBpdCBpcyByZWFjaGVkLiBBcHBseWluZyBmcm9udCB0byBiYWNrIHdvdWxkXG4gKiBzaGlmdCBldmVyeSBsYXRlciBodW5rIGJ5IHRoZSBzaXplIG9mIHRoZSBjaGFuZ2UganVzdCBtYWRlIOKAlCB0aGUgY2xhc3NpYyB3YXlcbiAqIGEgbXVsdGktaHVuayBtZXJnZSBsYW5kcyBpdHMgbGFzdCBodW5rIGluIHRoZSB3cm9uZyBwbGFjZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5SHVua3MoYmVmb3JlOiBzdHJpbmcsIGh1bmtzOiBEaWZmSHVua1tdLCB0YWtlOiBudW1iZXJbXSk6IHN0cmluZyB7XG4gIGNvbnN0IHdhbnRlZCA9IG5ldyBTZXQodGFrZSk7XG4gIGNvbnN0IGNob3NlbiA9IGh1bmtzLmZpbHRlcigoaCkgPT4gd2FudGVkLmhhcyhoLmlkKSkuc29ydCgoeCwgeSkgPT4geS5hRnJvbSAtIHguYUZyb20pO1xuICBjb25zdCBsaW5lcyA9IHNwbGl0TGluZXMoYmVmb3JlKTtcbiAgZm9yIChjb25zdCBoIG9mIGNob3NlbikgbGluZXMuc3BsaWNlKGguYUZyb20sIGguYVRvIC0gaC5hRnJvbSwgLi4uaC5hZGQpO1xuICByZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cblxuLyoqIFVuaWZpZWQtZGlmZiB0ZXh0LCBmb3IgdGhlIGFnZW50J3MgYGRpZmZgIHZlcmIuIGBjb250ZXh0YCBsaW5lcyBlaXRoZXIgc2lkZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1bmlmaWVkKFxuICBkaWZmOiBEaWZmLFxuICBvcHRzOiB7IGZyb206IHN0cmluZzsgdG86IHN0cmluZzsgY29udGV4dD86IG51bWJlciB9ID0geyBmcm9tOiBcImFcIiwgdG86IFwiYlwiIH0sXG4pOiBzdHJpbmcge1xuICBpZiAoZGlmZi5zYW1lKSByZXR1cm4gXCJcIjtcbiAgY29uc3QgY29udGV4dCA9IG9wdHMuY29udGV4dCA/PyAzO1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW2AtLS0gJHtvcHRzLmZyb219YCwgYCsrKyAke29wdHMudG99YF07XG4gIC8vIEh1bmtzIGNsb3NlciB0b2dldGhlciB0aGFuIDLDlyBjb250ZXh0IHNoYXJlIG9uZSBoZWFkZXIsIHRoZSB3YXkgZXZlcnlcbiAgLy8gb3RoZXIgZGlmZiB0b29sIGpvaW5zIHRoZW0g4oCUIG90aGVyd2lzZSB0aGUgY29udGV4dCBsaW5lcyBwcmludCB0d2ljZS5cbiAgY29uc3QgZ3JvdXBzOiBEaWZmSHVua1tdW10gPSBbXTtcbiAgZm9yIChjb25zdCBoIG9mIGRpZmYuaHVua3MpIHtcbiAgICBjb25zdCBsYXN0ID0gZ3JvdXBzW2dyb3Vwcy5sZW5ndGggLSAxXTtcbiAgICBjb25zdCBwcmV2ID0gbGFzdD8uW2xhc3QubGVuZ3RoIC0gMV07XG4gICAgaWYgKHByZXYgJiYgaC5hRnJvbSAtIHByZXYuYVRvIDw9IGNvbnRleHQgKiAyKSAobGFzdCBhcyBEaWZmSHVua1tdKS5wdXNoKGgpO1xuICAgIGVsc2UgZ3JvdXBzLnB1c2goW2hdKTtcbiAgfVxuICBjb25zdCBhID0gc3BsaXRMaW5lcyhzaWRlVGV4dChkaWZmLCBcImFcIikpO1xuICBjb25zdCBiID0gc3BsaXRMaW5lcyhzaWRlVGV4dChkaWZmLCBcImJcIikpO1xuICBmb3IgKGNvbnN0IGdyb3VwIG9mIGdyb3Vwcykge1xuICAgIGNvbnN0IGZpcnN0ID0gZ3JvdXBbMF0gYXMgRGlmZkh1bms7XG4gICAgY29uc3QgbGFzdCA9IGdyb3VwW2dyb3VwLmxlbmd0aCAtIDFdIGFzIERpZmZIdW5rO1xuICAgIGNvbnN0IGFTdGFydCA9IE1hdGgubWF4KDAsIGZpcnN0LmFGcm9tIC0gY29udGV4dCk7XG4gICAgY29uc3QgYUVuZCA9IE1hdGgubWluKGEubGVuZ3RoLCBsYXN0LmFUbyArIGNvbnRleHQpO1xuICAgIGNvbnN0IGJTdGFydCA9IE1hdGgubWF4KDAsIGZpcnN0LmJGcm9tIC0gY29udGV4dCk7XG4gICAgY29uc3QgYkVuZCA9IE1hdGgubWluKGIubGVuZ3RoLCBsYXN0LmJUbyArIGNvbnRleHQpO1xuICAgIG91dC5wdXNoKGBAQCAtJHthU3RhcnQgKyAxfSwke2FFbmQgLSBhU3RhcnR9ICske2JTdGFydCArIDF9LCR7YkVuZCAtIGJTdGFydH0gQEBgKTtcbiAgICBsZXQgYXQgPSBhU3RhcnQ7XG4gICAgZm9yIChjb25zdCBoIG9mIGdyb3VwKSB7XG4gICAgICBmb3IgKDsgYXQgPCBoLmFGcm9tOyBhdCsrKSBvdXQucHVzaChgICR7YVthdF19YCk7XG4gICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgaC5kZWwpIG91dC5wdXNoKGAtJHtsaW5lfWApO1xuICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGguYWRkKSBvdXQucHVzaChgKyR7bGluZX1gKTtcbiAgICAgIGF0ID0gaC5hVG87XG4gICAgfVxuICAgIGZvciAoOyBhdCA8IGFFbmQ7IGF0KyspIG91dC5wdXNoKGAgJHthW2F0XX1gKTtcbiAgfVxuICByZXR1cm4gYCR7b3V0LmpvaW4oXCJcXG5cIil9XFxuYDtcbn1cblxuLyoqIFJlYnVpbGQgb25lIHNpZGUncyB0ZXh0IGZyb20gdGhlIGxpbmUgb3BzIOKAlCB1c2VkIGJ5IGB1bmlmaWVkYCBmb3IgY29udGV4dC4gKi9cbmZ1bmN0aW9uIHNpZGVUZXh0KGRpZmY6IERpZmYsIHNpZGU6IFwiYVwiIHwgXCJiXCIpOiBzdHJpbmcge1xuICBjb25zdCBza2lwID0gc2lkZSA9PT0gXCJhXCIgPyBcImFkZFwiIDogXCJkZWxcIjtcbiAgcmV0dXJuIGRpZmYubGluZXNcbiAgICAuZmlsdGVyKChsKSA9PiBsLm9wICE9PSBza2lwKVxuICAgIC5tYXAoKGwpID0+IGwudGV4dClcbiAgICAuam9pbihcIlxcblwiKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKipcbiAqIFRoZSBzbWFsbGVzdCBiZWF0IHRoaXMgbW9kdWxlIHdpbGwgaGFuZCBiYWNrLCBpbiBtcyDigJQgdGhlIEZMT09SIGhhbGYgb2YgdGhlXG4gKiBjbGFtcCB3aG9zZSBjZWlsaW5nIGlzIGBpZGxlVGltZW91dCAvIDJgLlxuICpcbiAqIOKblCBJVCBFWElTVFMgQkVDQVVTRSBgaW50T3JgIFBBUlNFUyBXSVRIIGBwYXJzZUludGAsIEFORCBgcGFyc2VJbnRgIElTIExFTklFTlRcbiAqIFdIRVJFIElUIE1BVFRFUlMgTU9TVC4gYGludE9yYCBmYWxscyBiYWNrIHNhZmVseSBvbiBldmVyeXRoaW5nIHRoYXQgTE9PS1NcbiAqIGhvc3RpbGUg4oCUIGBcIlwiYCwgYFwiMFwiYCwgYFwiLTFcImAsIGBcImFiY1wiYCwgYFwiTmFOXCJgLCBgXCJJbmZpbml0eVwiYCBhbGwgdGFrZSB0aGVcbiAqIGZhbGxiYWNrIOKAlCBhbmQgdGhlbiByZWFkcyBgXCIxZTlcImAsIHRoZSBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXRcbiAqIGh1Z2VcIiwgYXMgKioxKiouIE1FQVNVUkVEIGF0IGdyYXBldmluZSdzIFBoYXNlIDYgcmVwYWlyLCBiZWZvcmUgdGhpcyBmbG9vcjpcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTFlOWAgcHV0IH41Mjgga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0VcbiAqIGNsaWVudCBpbiA1MjggbXMuIGBcIjMuOVwiYCBnaXZlcyAzIG1zIGFuZCBgXCI1YWJjXCJgIGdpdmVzIDUgbXMgdGhlIHNhbWUgd2F5LlxuICogQSBrbm9iIHdob3NlIGZhc3Rlc3Qgc2V0dGluZyBpcyBzcGVsbGVkIGxpa2UgaXRzIHNsb3dlc3QgaXMgYSBmbG9vZC5cbiAqXG4gKiDimqAgKipUSEUgRkxPT1IgSVMgSEVSRSBBTkQgTk9UIElOIGBpbnRPcmAg4oCUIHRoYXQgaXMgdGhlIHJ1bGluZywgbm90IGFuXG4gKiBhY2NpZGVudCBvZiB3aGVyZSBpdCB3YXMgZWFzeSB0byB3cml0ZSoqIChENzYpLiBgaW50T3JgIGlzIHRoZSBnZW5lcmFsIHBhcnNlclxuICogYmVoaW5kIGV2ZXJ5IGVudiBrbm9iIGluIHRoZSBraXQ7IHRoZXJlIGlzIG5vIHNpbmdsZSByb3N0ZXItY29ycmVjdCBtaW5pbXVtXG4gKiBmb3IgXCJhIHBvc2l0aXZlIGludGVnZXJcIiwgYW5kIHRpZ2h0ZW5pbmcgaXRzIFBBUlNFIChyZWplY3RpbmcgYDFlOWAgb3V0cmlnaHQpXG4gKiB3b3VsZCBjaGFuZ2Ugd2hhdCBldmVyeSBvdGhlciBrbm9iIGFjY2VwdHMsIHNpbGVudGx5LCBmb3IgdmFsdWVzIG5vYm9keSBoYXNcbiAqIGF1ZGl0ZWQuIGBoZWFydGJlYXRNc2AgYWxyZWFkeSBvd25zIG9uZSBlbmQgb2YgdGhpcyBpbnZhcmlhbnQsIGFuZCA1MDAgd2FzXG4gKiBhbHJlYWR5IHdyaXR0ZW4gaW50byBpdCBhcyB0aGUgc21hbGxlc3QgY2VpbGluZyBpdCB3b3VsZCBjb21wdXRlLiBUaGUgZmxvb3JcbiAqIGJlbG9uZ3MgYmVzaWRlIHRoZSBjZWlsaW5nLCB3aGVyZSB0aGUgcXVhbnRpdHkgaXMga25vd24uXG4gKi9cbmV4cG9ydCBjb25zdCBNSU5fSEVBUlRCRUFUX01TID0gNTAwO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4g4pqgIGBwYXJzZUludGAgc2VtYW50aWNzOiBgXCIxZTlcImBcbiAqICBpcyAxIGFuZCBgXCI1YWJjXCJgIGlzIDUuIEFueSBjYWxsZXIgd2l0aCBhIGtub3duIHNhZmUgbWluaW11bSBtdXN0IGNsYW1wIOKAlFxuICogIHNlZSBgTUlOX0hFQVJUQkVBVF9NU2AuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqIFRoZSBzZXJ2ZXIncyBgaWRsZVRpbWVvdXRgLCBpbiBTRUNPTkRTLCBjbGFtcGVkIHRvIHdoYXQgQnVuIGFjY2VwdHMuICovXG5leHBvcnQgZnVuY3Rpb24gaWRsZVRpbWVvdXRTZWMocmF3Pzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjayA9IE1BWF9JRExFX1RJTUVPVVRfU0VDKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKE1BWF9JRExFX1RJTUVPVVRfU0VDLCBpbnRPcihyYXcsIGZhbGxiYWNrKSkpO1xufVxuXG4vKipcbiAqIFRoZSBTU0UgaGVhcnRiZWF0LCBpbiBtcywgQ0xBTVBFRCBBVCBCT1RIIEVORFM6IG5ldmVyIGFib3ZlIGhhbGYgdGhlIGlkbGVcbiAqIHRpbWVvdXQsIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiBUaGUgY2VpbGluZyBpcyBhc3Ryb2xhYmUncywgYW5kIHRoZSBjZW5zdXMgbmFtZWQgaXQgY29udmVyZ2VuY2UgdGFyZ2V0ICM0OlxuICogdGhlIG90aGVyIGRhZW1vbnMgaGFyZC1jb2RlIDE1IHMgYWdhaW5zdCAyNTUgcyBhbmQgd3JpdGUgdGhlIHJlbGF0aW9uc2hpcFxuICogb25seSBpbiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBFbmZvcmNpbmdcbiAqIGBoZWFydGJlYXQgPD0gaWRsZVRpbWVvdXQgLyAyYCBtYWtlcyB0aGUgaW52YXJpYW50IHRydWUgZm9yIEFOWSBjb25maWd1cmVkXG4gKiBwYWlyLCB3aGljaCBpcyBleGFjdGx5IHRoZSBpbnZhcmlhbnQgd2hvc2UgdmlvbGF0aW9uIGNhdXNlZCB0aGUgYnVnIGFib3ZlLlxuICpcbiAqIOKaoCBUaGUgZmxvb3IgY2Fubm90IGZpZ2h0IHRoZSBjZWlsaW5nOiB0aGUgY2VpbGluZyBleHByZXNzaW9uIGlzIGl0c2VsZlxuICogYE1hdGgubWF4KDUwMCwg4oCmKWAsIHNvIGl0IGlzIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYCBhbmQgdGhlIHR3b1xuICogY2xhbXBzIGNhbiBuZXZlciBjcm9zcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgY29uc3QgY2VpbGluZyA9IE1hdGgubWF4KE1JTl9IRUFSVEJFQVRfTVMsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKTtcbiAgcmV0dXJuIE1hdGgubWluKE1hdGgubWF4KGludE9yKHJhdywgZmFsbGJhY2spLCBNSU5fSEVBUlRCRUFUX01TKSwgY2VpbGluZyk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIHNjcmlwdG9yaXVtJ3MgY29ubmVjdGlvbi10aW1pbmcgY29uc3RhbnRzIOKAlCBUSEUgT05FIENPUFksIGltcG9ydGVkIGJ5IGJvdGhcbiAqIGhhbHZlcyAoYGNsaS50c2AncyB0YWlsIHdhdGNoZG9nLCBgc2VydmVyLnRzYCdzIFNTRSBoZWFydGJlYXQgYW5kIGlkbGVcbiAqIHRpbWVvdXQpLiBLaXQgdmVyZGljdCBgaGVhcnRiZWF0YDogU1VCSkVDVCDigJQgdGhlIHNlYW0gZXhpc3RzIGJlY2F1c2UgdGhlIENMSVxuICogYW5kIHRoZSBkYWVtb24gYXJlIHR3byBwcm9jZXNzZXMgdGhhdCBtdXN0IGFncmVlIG9uIG9uZSBpbnZhcmlhbnRcbiAqIChgaWRsZVRpbWVvdXQgPiBoZWFydGJlYXRgLCBgd2F0Y2hkb2cgPiBoZWFydGJlYXRgKSwgYW5kIG5laXRoZXIgbWF5IGltcG9ydFxuICogdGhlIG90aGVyLlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgYGRpc3QvY2xpLmpzYCBkcmFncyB0aGUgc2VydmVyIGdyYXBoIGFuZCB0aGUgc2VhbSBjbG9zZXMuXG4gKi9cblxuaW1wb3J0IHtcbiAgREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKiBCdW4ncyBtYXhpbXVtOiBhIGhlbGQgU1NFIHRhaWwgbXVzdCBvdXRsaXZlIEJ1bidzIDEwIHMgZGVmYXVsdC4gKi9cbmV4cG9ydCBjb25zdCBJRExFX1RJTUVPVVRfU0VDID0gTUFYX0lETEVfVElNRU9VVF9TRUM7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdC4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gREVGQVVMVF9IRUFSVEJFQVRfTVM7XG5cbi8qKiBUaGUgdGFpbCB3YXRjaGRvZzogdGhyZWUgbWlzc2VkIGJlYXRzIG9mIFRISVMgZGFlbW9uJ3MgaGVhcnRiZWF0LCBkZXJpdmVkLiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUyk7XG4iLAogICAgIi8vIFVuZG8gYW5kIHJlZG8gZm9yIHRoZSBDT05URVhUIOKAlCBtb3ZpbmcgdGhpbmdzIGFyb3VuZCwgYWRkaW5nLCBoaWRpbmcgKEU2MCkuXG4vL1xuLy8g4puUIFRISVMgSVMgTk9UIFRIRSBFRElUT1InUyBVTkRPLCBhbmQgdGhlIHN1cmZhY2Ugc2F5cyBzbyBieSBwdXR0aW5nIHRoZXNlXG4vLyBhcnJvd3MgaW4gdGhlIGNvbnRleHQgaGVhZGVyIHJhdGhlciB0aGFuIGFueXdoZXJlIG5lYXIgdGhlIHRleHQuIENvZGVNaXJyb3Inc1xuLy8gaGlzdG9yeSBvd25zIGtleXN0cm9rZXMgaW5zaWRlIGEgZG9jdW1lbnQ7IHRoaXMgb3ducyBhY3RzIG9uIHRoZSBTSEFQRSBvZiB0aGVcbi8vIGNvbnRleHQsIHdoaWNoIGlzIHRoZSB0aGluZyB0aGF0IGhhZCBubyB3YXkgYmFjayBhdCBhbGwuIENvbGU6IFwibGV0dGluZyB0aGVcbi8vIHVzZXIga25vdyB0aGF0IHRoZXJlJ3MgYW4gdW5kbyBmb3IgdGhpcyBzaWRlYmFyIHRoYXQgaXNuJ3QgdGhlIHNhbWUgYXMgdW5kb1xuLy8gcmVkbyB3aGVuIHlvdSdyZSBpbiB0aGUgZWRpdG9yLlwiXG4vL1xuLy8g4puUIFVORE9JTkcgQSBDUkVBVElPTiBERUxFVEVTLCBCVVQgT05MWSBCRUhJTkQgQSBDT05GSVJNQVRJT04uIFRoaXMgc3RhcnRlZCBhc1xuLy8gYSBoYXJkIGJsb2NrIOKAlCB1bmRvIG5ldmVyIGRlbGV0ZXMg4oCUIGFuZCBDb2xlIHB1c2hlZCBiYWNrLCBjb3JyZWN0bHk6IGJsb2NraW5nXG4vLyBkb2VzIG5vdCByZWZ1c2Ugb25lIHN0ZXAsIGl0IFNUUkFORFMgRVZFUllUSElORyBCRUhJTkQgSVQuIENyZWF0ZSBhIGZvbGRlciwgZG9cbi8vIHR3byBtb3ZlcywgYW5kIHlvdSBjYW4gdW5kbyB0aGUgbW92ZXMgYW5kIHRoZW4gbWVldCBhIHdhbGwgeW91IGNhbiBuZXZlclxuLy8gcGFzcywgYXQgd2hpY2ggcG9pbnQgdGhlIGhpc3RvcnkgaGFzIHN0b3BwZWQgYmVpbmcgYSBoaXN0b3J5LiBBbmQgdGhlIHRoaW5nXG4vLyB1bmRvIHdvdWxkIHJlbW92ZSBpcyBvbmUgdGhlIHNlc3Npb24gaXRzZWxmIG1hZGUgbW9tZW50cyBhZ28sIHVzdWFsbHkgZW1wdHkg4oCUXG4vLyBjYXRlZ29yaWNhbGx5IGRpZmZlcmVudCBmcm9tIGRlbGV0aW5nIHdvcmssIGFuZCB0aGUgYXBwIGFscmVhZHkgaGFzIHRoZVxuLy8gcGF0dGVybiBmb3IgaXQgaW4gdGhlIHZlcnNpb24tZGVsZXRlIGRpYWxvZy4gU28gdGhlIGFycm93IHN0YXlzIGVuYWJsZWQgYW5kXG4vLyB0aGUgQ09ORklSTUFUSU9OIGlzIHRoZSBnYXRlLlxuLy9cbi8vIOKblCBXSVRIIE9ORSBIQVJEIExJTUlUIFRIQVQgSVMgTk9UIE5FR09USUFCTEUgQlkgRElBTE9HOiBhIE5PTi1FTVBUWSBmb2xkZXIgaXNcbi8vIHJlZnVzZWQgb3V0cmlnaHQuIFVuZG8gd29ya3MgYmFja3dhcmRzLCBzbyBpdCBlbXB0aWVzIGEgZm9sZGVyIGJlZm9yZSBpdFxuLy8gcmVhY2hlcyB0aGF0IGZvbGRlcidzIGNyZWF0aW9uOyBpZiB0aGUgZm9sZGVyIHN0aWxsIGhhcyBjb250ZW50cywgc29tZXRoaW5nXG4vLyBwdXQgdGhlbSB0aGVyZSB0aGF0IHRoaXMgaGlzdG9yeSBkb2VzIG5vdCBrbm93IGFib3V0LCBhbmQgcmVtb3ZpbmcgYVxuLy8gZGlyZWN0b3J5IHRyZWUgaXMgYSBkaWZmZXJlbnQgYWN0IGZyb20gcmVtb3ZpbmcgdGhlIGVtcHR5IHRoaW5nIHlvdSBqdXN0XG4vLyBtYWRlLiBUaGF0IGNhc2Ugc3RvcHMgYW5kIHNheXMgd2h5LlxuLy9cbi8vIOKaoCBUSEUgSU5WRVJTRSBJUyBCVUlMVCBXSEVOIFRIRSBBQ1QgSEFQUEVOUywgZnJvbSB3aGF0IHdhcyBhY3R1YWxseSB0cnVlXG4vLyB0aGVuIOKAlCBub3QgcmVjb25zdHJ1Y3RlZCBsYXRlciBmcm9tIHRoZSBvcC4gQSBgbW92ZWAgcmVjb3JkcyB3aGVyZSB0aGUgdGhpbmdcbi8vIENBTUUgZnJvbSBiZWNhdXNlIG9ubHkgdGhlIG1vdmVyIGtub3dzOyBhIGBoaWRlYCByZWNvcmRzIHRoZSBlbnRyeSdzIHdob2xlXG4vLyBoaWRkZW4gbGlzdCBiZWNhdXNlIHRoYXQgaXMgd2hhdCByZXN0b3JlcyBpdCBleGFjdGx5LCBpbmNsdWRpbmcgdGhlIGNhc2Vcbi8vIHdoZXJlIGhpZGluZyByZW1vdmVkIGEgc2luZ2xlLWRvY3VtZW50IGVudHJ5IG91dHJpZ2h0LlxuaW1wb3J0IHR5cGUgeyBTdHJ1Y3R1cmVPcCB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKlxuICogSG93IHRvIHB1dCBvbmUgYWN0IGJhY2suIEVhY2ggdmFyaWFudCBpcyBzb21ldGhpbmcgdGhlIHNlc3Npb24gY2FuIGFscmVhZHlcbiAqIGRvLCBzbyB1bmRvIGludHJvZHVjZXMgbm8gbmV3IHdheSB0byBjaGFuZ2UgdGhlIHdvcmxkIOKAlCBpdCBvbmx5IHJlcGxheXMgdGhlXG4gKiBleGlzdGluZyBvbmVzIHdpdGggcmVjb3JkZWQgYXJndW1lbnRzLlxuICovXG5leHBvcnQgdHlwZSBJbnZlcnNlID1cbiAgfCB7IGtpbmQ6IFwibW92ZVwiOyBwYXRoOiBzdHJpbmc7IGludG86IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcInJlbmFtZVwiOyBwYXRoOiBzdHJpbmc7IG5hbWU6IHN0cmluZyB9XG4gIC8qKiBTZXQgYW4gZW50cnkncyBoaWRkZW4gbGlzdCB0byBleGFjdGx5IHRoZXNlIHJlbGF0aXZlIHBhdGhzLiAqL1xuICB8IHsga2luZDogXCJoaWRkZW5cIjsgZW50cnk6IHN0cmluZzsgcmVsczogc3RyaW5nW10gfVxuICAvKiogUHV0IGEgd2hvbGUgZG9jdW1lbnQgb3IgZm9sZGVyIGJhY2sgaW4gdGhlIGNvbnRleHQuICovXG4gIHwgeyBraW5kOiBcImNvbnRleHQuYWRkXCI7IHBhdGg6IHN0cmluZyB9XG4gIC8qKiBUYWtlIGEgY29udGV4dCBlbnRyeSBiYWNrIG91dCAodGhlIGludmVyc2Ugb2YgcHV0dGluZyBvbmUgaW4pLiAqL1xuICB8IHsga2luZDogXCJjb250ZXh0LnJlbW92ZVwiOyBlbnRyeTogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwid29ya3NwYWNlXCI7IHBhdGg6IHN0cmluZyB9XG4gIC8qKlxuICAgKiBSZW1vdmUgd2hhdCB0aGUgYWN0IGNyZWF0ZWQuIGBkaXJgIGRlY2lkZXMgYm90aCB0aGUgZGlhbG9nJ3Mgd29yZHMgYW5kIHRoZVxuICAgKiBlbXB0aW5lc3MgcnVsZSDigJQgYSBmaWxlIGlzIGNvbmZpcm1lZCwgYSBmb2xkZXIgaXMgY29uZmlybWVkIEFORCBtdXN0IGJlXG4gICAqIGVtcHR5LlxuICAgKi9cbiAgfCB7IGtpbmQ6IFwiZGVsZXRlXCI7IHBhdGg6IHN0cmluZzsgZGlyOiBib29sZWFuIH07XG5cbi8qKiBPbmUgYWN0LCB3aXRoIHRoZSB3YXkgYmFjayBhbmQgYSBzZW50ZW5jZSBmb3IgdGhlIGFycm93J3MgdG9vbHRpcC4gKi9cbmV4cG9ydCB0eXBlIEFjdCA9IHtcbiAgLyoqIFdoYXQgaGFwcGVuZWQsIGZvciB0aGUgdG9vbHRpcDogXCJtb3ZlZCBub3RlLm1kIGludG8gZHJhZnRzXCIuICovXG4gIGxhYmVsOiBzdHJpbmc7XG4gIGludmVyc2U6IEludmVyc2U7XG59O1xuXG4vKipcbiAqIFdoYXQgdGhlIHNlc3Npb24ga25ldyBiZWZvcmUgdGhlIGFjdCDigJQgdGhlIHBhcnRzIGFuIGludmVyc2UgbWF5IG5lZWQuXG4gKlxuICog4pqgIFBhc3NlZCBpbiByYXRoZXIgdGhhbiByZWFkIGJhY2sgYWZ0ZXJ3YXJkcywgYmVjYXVzZSBldmVyeSBmaWVsZCBoZXJlIGlzXG4gKiBzb21ldGhpbmcgdGhlIGFjdCBpdHNlbGYgQ0hBTkdFUy4gUmVhZGluZyBgaGlkZGVuYCBhZnRlciBhIGhpZGUgcmV0dXJucyB0aGVcbiAqIGxpc3QgaW5jbHVkaW5nIHRoZSB0aGluZyBqdXN0IGhpZGRlbiwgd2hpY2ggcmVzdG9yZXMgbm90aGluZy5cbiAqL1xuZXhwb3J0IHR5cGUgQmVmb3JlID0ge1xuICAvKiogVGhlIGVudHJ5J3MgaGlkZGVuIGxpc3QgYmVmb3JlIHRoZSBhY3QsIHdoZW4gdGhlIGFjdCB0b3VjaGVkIG9uZS4gKi9cbiAgaGlkZGVuPzogeyBlbnRyeTogc3RyaW5nOyByZWxzOiBzdHJpbmdbXSB9O1xuICAvKiogVGhlIHdvcmtzcGFjZSBiZWZvcmUgdGhlIGFjdC4gKi9cbiAgd29ya3NwYWNlPzogc3RyaW5nO1xufTtcblxuLyoqIFdoYXQgdGhlIGFjdCByZXR1cm5lZCDigJQgdGhlIHNlc3Npb24ncyBvd24gcmVzdWx0LCBuYXJyb3dlZCB0byB3aGF0IHdlIHVzZS4gKi9cbmV4cG9ydCB0eXBlIEFmdGVyID0ge1xuICBwYXRoPzogc3RyaW5nO1xuICAvKiogV2hlcmUgYSBtb3ZlIG9yIHJlbmFtZSBjYW1lIEZST00uICovXG4gIGZyb20/OiBzdHJpbmc7XG4gIC8qKiBUaGUgZm9sZGVyIGBzZXQubWFrZWAgY3JlYXRlZC4gKi9cbiAgZm9sZGVyPzogc3RyaW5nO1xuICAvKiogVGhlIGVudHJ5IGEgaGlkZSB0b3VjaGVkLCBhbmQgd2hldGhlciBpdCByZW1vdmVkIHRoYXQgZW50cnkgZW50aXJlbHkuICovXG4gIGVudHJ5Pzogc3RyaW5nO1xuICByZW1vdmVkRW50cnk/OiBib29sZWFuO1xufTtcblxuY29uc3QgYmFzZSA9IChwOiBzdHJpbmcpOiBzdHJpbmcgPT4gcC5zcGxpdChcIi9cIikucG9wKCkgPz8gcDtcbmNvbnN0IHBhcmVudCA9IChwOiBzdHJpbmcpOiBzdHJpbmcgPT4gcC5zbGljZSgwLCBNYXRoLm1heCgwLCBwLmxhc3RJbmRleE9mKFwiL1wiKSkpIHx8IFwiL1wiO1xuXG4vKipcbiAqIFRoZSB3YXkgYmFjayBmcm9tIG9uZSBhY3QuXG4gKlxuICogUmV0dXJucyBudWxsIGZvciBhbiBhY3Qgbm90IHdvcnRoIGEgaGlzdG9yeSBlbnRyeSBhdCBhbGwg4oCUIGB1bmhpZGVgIG9uIGFuXG4gKiBlbnRyeSB0aGF0IGhhZCBub3RoaW5nIGhpZGRlbiBjaGFuZ2VkIG5vdGhpbmcsIGFuZCBhbiB1bmRvIGFycm93IHRoYXQgc3RlcHNcbiAqIG92ZXIgbm8tb3BzIGlzIGFuIGFycm93IHRoYXQgbGllcyBhYm91dCBob3cgZmFyIGJhY2sgaXQgY2FuIGdvLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhbkludmVyc2Uob3A6IFN0cnVjdHVyZU9wLCBhZnRlcjogQWZ0ZXIsIGJlZm9yZTogQmVmb3JlKTogQWN0IHwgbnVsbCB7XG4gIHN3aXRjaCAob3AudHlwZSkge1xuICAgIC8vIOKUgOKUgCBicm91Z2h0IHNvbWV0aGluZyBpbnRvIGV4aXN0ZW5jZTogbm8gaW52ZXJzZSB0aGF0IGRvZXMgbm90IGRlbGV0ZSDilIDilIBcbiAgICBjYXNlIFwiZG9jLmNyZWF0ZVwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGBjcmVhdGVkICR7YmFzZShhZnRlci5wYXRoID8/IFwiXCIpfWAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJkZWxldGVcIiwgcGF0aDogYWZ0ZXIucGF0aCA/PyBcIlwiLCBkaXI6IGZhbHNlIH0sXG4gICAgICB9O1xuICAgIGNhc2UgXCJmb2xkZXIuY3JlYXRlXCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYGNyZWF0ZWQgdGhlIGZvbGRlciAke2Jhc2UoYWZ0ZXIucGF0aCA/PyBcIlwiKX1gLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiZGVsZXRlXCIsIHBhdGg6IGFmdGVyLnBhdGggPz8gXCJcIiwgZGlyOiB0cnVlIH0sXG4gICAgICB9O1xuICAgIGNhc2UgXCJpbXBvcnRcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgY29waWVkIGluICR7YmFzZShhZnRlci5wYXRoID8/IFwiXCIpfWAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJkZWxldGVcIiwgcGF0aDogYWZ0ZXIucGF0aCA/PyBcIlwiLCBkaXI6IGZhbHNlIH0sXG4gICAgICB9O1xuICAgIGNhc2UgXCJzZXQubWFrZVwiOlxuICAgICAgLy8g4pqgIFRIRSBGT0xERVIgSVMgVEhFIFRISU5HIFRPIFVORE8sIG5vdCB0aGUgbW92ZSBpbnNpZGUgaXQuIGBzZXQubWFrZWBcbiAgICAgIC8vIGNyZWF0ZXMgYSBmb2xkZXIgYW5kIG1vdmVzIHRoZSBkb2N1bWVudCBpbiwgc28gdGhlIGludmVyc2UgaXMgdG9cbiAgICAgIC8vIHJlbW92ZSB0aGUgZm9sZGVyIOKAlCB3aGljaCB0aGUgZW1wdGluZXNzIHJ1bGUgd2lsbCByZWZ1c2Ugd2hpbGUgdGhlXG4gICAgICAvLyBkb2N1bWVudCBpcyBzdGlsbCBpbiB0aGVyZS4gVGhhdCByZWZ1c2FsIGlzIGNvcnJlY3QgYW5kIHJlYWRhYmxlXG4gICAgICAvLyAoXCJ0aGUgZm9sZGVyIGlzIG5vdCBlbXB0eVwiKSwgYW5kIHRoZSB3YXkgdGhyb3VnaCBpdCBpcyB0byBtb3ZlIHRoZVxuICAgICAgLy8gZG9jdW1lbnQgb3V0IGZpcnN0LCB3aGljaCBpcyBpdHNlbGYgYW4gdW5kb2FibGUgYWN0LlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGB0dXJuZWQgJHtiYXNlKG9wLnBhdGgpfSBpbnRvIGEgc2V0YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImRlbGV0ZVwiLCBwYXRoOiBhZnRlci5mb2xkZXIgPz8gXCJcIiwgZGlyOiB0cnVlIH0sXG4gICAgICB9O1xuXG4gICAgLy8g4pSA4pSAIHJldmVyc2libGUsIHdpdGggYXJndW1lbnRzIG9ubHkgdGhlIGFjdCBrbmV3IOKUgOKUgFxuICAgIGNhc2UgXCJtb3ZlXCI6IHtcbiAgICAgIGlmIChhZnRlci5wYXRoID09PSB1bmRlZmluZWQgfHwgYWZ0ZXIuZnJvbSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbnVsbDtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgbW92ZWQgJHtiYXNlKGFmdGVyLmZyb20pfSBpbnRvICR7YmFzZShwYXJlbnQoYWZ0ZXIucGF0aCkpfWAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJtb3ZlXCIsIHBhdGg6IGFmdGVyLnBhdGgsIGludG86IHBhcmVudChhZnRlci5mcm9tKSB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgY2FzZSBcInJlbmFtZVwiOiB7XG4gICAgICBpZiAoYWZ0ZXIucGF0aCA9PT0gdW5kZWZpbmVkIHx8IGFmdGVyLmZyb20gPT09IHVuZGVmaW5lZCkgcmV0dXJuIG51bGw7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYHJlbmFtZWQgJHtiYXNlKGFmdGVyLmZyb20pfSB0byAke2Jhc2UoYWZ0ZXIucGF0aCl9YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcInJlbmFtZVwiLCBwYXRoOiBhZnRlci5wYXRoLCBuYW1lOiBiYXNlKGFmdGVyLmZyb20pIH0sXG4gICAgICB9O1xuICAgIH1cbiAgICBjYXNlIFwiaGlkZVwiOiB7XG4gICAgICAvLyBUd28gc2hhcGVzOiBoaWRpbmcgb25lIGl0ZW0gaW5zaWRlIGEgc2V0LCBvciBoaWRpbmcgYSBzaW5nbGUtZG9jdW1lbnRcbiAgICAgIC8vIGVudHJ5LCB3aGljaCByZW1vdmVzIHRoZSBlbnRyeSBvdXRyaWdodC5cbiAgICAgIGlmIChhZnRlci5yZW1vdmVkRW50cnkpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBsYWJlbDogYHJlbW92ZWQgJHtiYXNlKGFmdGVyLnBhdGggPz8gXCJcIil9IGZyb20gdGhlIGNvbnRleHRgLFxuICAgICAgICAgIGludmVyc2U6IHsga2luZDogXCJjb250ZXh0LmFkZFwiLCBwYXRoOiBhZnRlci5wYXRoID8/IFwiXCIgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGhhZCA9IGJlZm9yZS5oaWRkZW47XG4gICAgICBpZiAoIWhhZCkgcmV0dXJuIG51bGw7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYHJlbW92ZWQgJHtiYXNlKGFmdGVyLnBhdGggPz8gXCJcIil9IGZyb20gdGhlIGNvbnRleHRgLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiaGlkZGVuXCIsIGVudHJ5OiBoYWQuZW50cnksIHJlbHM6IGhhZC5yZWxzIH0sXG4gICAgICB9O1xuICAgIH1cbiAgICBjYXNlIFwidW5oaWRlXCI6IHtcbiAgICAgIGNvbnN0IGhhZCA9IGJlZm9yZS5oaWRkZW47XG4gICAgICAvLyBOb3RoaW5nIHdhcyBoaWRkZW4sIHNvIG5vdGhpbmcgaGFwcGVuZWQ6IG5vdCBoaXN0b3J5LlxuICAgICAgaWYgKCFoYWQgfHwgaGFkLnJlbHMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgYnJvdWdodCBiYWNrICR7aGFkLnJlbHMubGVuZ3RofSBoaWRkZW4gaXRlbSR7aGFkLnJlbHMubGVuZ3RoID09PSAxID8gXCJcIiA6IFwic1wifWAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJoaWRkZW5cIiwgZW50cnk6IGhhZC5lbnRyeSwgcmVsczogaGFkLnJlbHMgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIGNhc2UgXCJ3b3Jrc3BhY2Uuc2V0XCI6IHtcbiAgICAgIGNvbnN0IHdhcyA9IGJlZm9yZS53b3Jrc3BhY2U7XG4gICAgICBpZiAod2FzID09PSB1bmRlZmluZWQgfHwgd2FzID09PSBhZnRlci5wYXRoKSByZXR1cm4gbnVsbDtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgc2V0IHRoZSB3b3Jrc3BhY2UgdG8gJHtiYXNlKGFmdGVyLnBhdGggPz8gXCJcIil9YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcIndvcmtzcGFjZVwiLCBwYXRoOiB3YXMgfSxcbiAgICAgIH07XG4gICAgfVxuICB9XG59XG5cbi8qKiBXaGF0IHRoZSBhcnJvd3MgbmVlZCB0byBrbm93LCBhbmQgbm90aGluZyBlbHNlLiAqL1xuZXhwb3J0IHR5cGUgSGlzdG9yeVZpZXcgPSB7XG4gIGNhblVuZG86IGJvb2xlYW47XG4gIGNhblJlZG86IGJvb2xlYW47XG4gIC8qKiBcIm1vdmVkIG5vdGUubWQgaW50byBkcmFmdHNcIiwgZm9yIHRoZSB0b29sdGlwLiAqL1xuICB1bmRvTGFiZWw/OiBzdHJpbmc7XG4gIHJlZG9MYWJlbD86IHN0cmluZztcbiAgLyoqXG4gICAqIFNldCB3aGVuIHRoZSBuZXh0IHVuZG8gd291bGQgREVMRVRFIHNvbWV0aGluZywgc28gdGhlIHN1cmZhY2UgY2FuIHJhaXNlIGFcbiAgICogY29uZmlybWF0aW9uIGJlZm9yZSBzZW5kaW5nIGl0LiBQcmVzZW50IG1lYW5zIFwiYXNrIGZpcnN0XCIsIG5vdCBcInJlZnVzZVwiLlxuICAgKi9cbiAgdW5kb0RlbGV0ZXM/OiB7IHBhdGg6IHN0cmluZzsgZGlyOiBib29sZWFuIH07XG59O1xuXG4vKipcbiAqIFRoZSB0d28gc3RhY2tzLlxuICpcbiAqIOKaoCBJTiBNRU1PUlksIE5PVCBJTiBUSEUgTUFOSUZFU1QsIGFuZCB0aGF0IGlzIGEgZGVjaXNpb24gcmF0aGVyIHRoYW5cbiAqIGxhemluZXNzOiBhbiBpbnZlcnNlIHJlY29yZGVkIG5vdyBkZXNjcmliZXMgdGhlIHdvcmxkIGFzIGl0IGlzIG5vdywgYW5kIGFcbiAqIHNlc3Npb24gcmVzdG9yZWQgdG9tb3Jyb3cgbWF5IG1lZXQgYSBmaWxlIHNvbWVib2R5IGhhcyBzaW5jZSBtb3ZlZCBieSBoYW5kLlxuICogT2ZmZXJpbmcgYW4gdW5kbyB3aG9zZSBhcmd1bWVudHMgaGF2ZSBnb25lIHN0YWxlIGlzIHdvcnNlIHRoYW4gc3RhcnRpbmcgZWFjaFxuICogc2Vzc2lvbiB3aXRoIGFuIGVtcHR5IGhpc3Rvcnkg4oCUIHNvIHRoZSBhcnJvd3MgYXJlIGdyZXkgYWZ0ZXIgYSByZXN0b3JlLCB3aGljaFxuICogaXMgaG9uZXN0IGFib3V0IHdoYXQgY2FuIHN0aWxsIGJlIHB1dCBiYWNrLlxuICovXG5leHBvcnQgY2xhc3MgSGlzdG9yeSB7XG4gIHByaXZhdGUgdW5kb3M6IEFjdFtdID0gW107XG4gIHByaXZhdGUgcmVkb3M6IEFjdFtdID0gW107XG5cbiAgLyoqIFJlY29yZCBhbiBhY3QuIEEgbmV3IGFjdCBtYWtlcyB0aGUgcmVkbyBzdGFjayBtZWFuaW5nbGVzcy4gKi9cbiAgZGlkKGFjdDogQWN0IHwgbnVsbCk6IHZvaWQge1xuICAgIGlmICghYWN0KSByZXR1cm47XG4gICAgdGhpcy51bmRvcy5wdXNoKGFjdCk7XG4gICAgdGhpcy5yZWRvcyA9IFtdO1xuICB9XG5cbiAgLyoqIFdoYXQgdGhlIG5leHQgdW5kbyB3b3VsZCBkbywgd2l0aG91dCBkb2luZyBpdC4gKi9cbiAgcGVla1VuZG8oKTogQWN0IHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMudW5kb3NbdGhpcy51bmRvcy5sZW5ndGggLSAxXSA/PyBudWxsO1xuICB9XG5cbiAgcGVla1JlZG8oKTogQWN0IHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMucmVkb3NbdGhpcy5yZWRvcy5sZW5ndGggLSAxXSA/PyBudWxsO1xuICB9XG5cbiAgLyoqXG4gICAqIFRha2UgdGhlIG5leHQgdW5kbywgaGF2aW5nIGFwcGxpZWQgaXQuIGByZWRvYCBpcyB0aGUgYWN0IHRoYXQgd291bGQgcHV0IGl0XG4gICAqIGJhY2sg4oCUIGJ1aWx0IGJ5IHRoZSBjYWxsZXIsIGJlY2F1c2Ugb25seSB0aGUgY2FsbGVyIGtub3dzIHdoYXQgaXRzIG93blxuICAgKiBpbnZlcnNlIHByb2R1Y2VkLlxuICAgKi9cbiAgdG9va1VuZG8ocmVkbzogQWN0IHwgbnVsbCk6IHZvaWQge1xuICAgIGNvbnN0IGFjdCA9IHRoaXMudW5kb3MucG9wKCk7XG4gICAgaWYgKCFhY3QpIHJldHVybjtcbiAgICBpZiAocmVkbykgdGhpcy5yZWRvcy5wdXNoKHJlZG8pO1xuICB9XG5cbiAgdG9va1JlZG8odW5kbzogQWN0IHwgbnVsbCk6IHZvaWQge1xuICAgIGNvbnN0IGFjdCA9IHRoaXMucmVkb3MucG9wKCk7XG4gICAgaWYgKCFhY3QpIHJldHVybjtcbiAgICBpZiAodW5kbykgdGhpcy51bmRvcy5wdXNoKHVuZG8pO1xuICB9XG5cbiAgdmlldygpOiBIaXN0b3J5VmlldyB7XG4gICAgY29uc3QgdW5kbyA9IHRoaXMucGVla1VuZG8oKTtcbiAgICBjb25zdCByZWRvID0gdGhpcy5wZWVrUmVkbygpO1xuICAgIGNvbnN0IGRlbGV0ZXMgPSB1bmRvPy5pbnZlcnNlLmtpbmQgPT09IFwiZGVsZXRlXCIgPyB1bmRvLmludmVyc2UgOiB1bmRlZmluZWQ7XG4gICAgcmV0dXJuIHtcbiAgICAgIC8vIOKblCBBIERFTEVUSU5HIFVORE8gSVMgU1RJTEwgVU5ET0FCTEUg4oCUIHRoZSBnYXRlIGlzIHRoZSBkaWFsb2csIG5vdCB0aGVcbiAgICAgIC8vIGRpc2FibGVkIHN0YXRlIChDb2xlJ3MgcnVsaW5nLCByZXZlcnNpbmcgYW4gZWFybGllciBkZXNpZ24gdGhhdFxuICAgICAgLy8gc3RyYW5kZWQgZXZlcnkgYWN0IGJlaGluZCBhIGNyZWF0aW9uKS5cbiAgICAgIGNhblVuZG86IHVuZG8gIT09IG51bGwsXG4gICAgICBjYW5SZWRvOiByZWRvICE9PSBudWxsLFxuICAgICAgLi4uKHVuZG8gPyB7IHVuZG9MYWJlbDogdW5kby5sYWJlbCB9IDoge30pLFxuICAgICAgLi4uKHJlZG8gPyB7IHJlZG9MYWJlbDogcmVkby5sYWJlbCB9IDoge30pLFxuICAgICAgLi4uKGRlbGV0ZXMgPyB7IHVuZG9EZWxldGVzOiB7IHBhdGg6IGRlbGV0ZXMucGF0aCwgZGlyOiBkZWxldGVzLmRpciB9IH0gOiB7fSksXG4gICAgfTtcbiAgfVxuXG4gIC8qKiBIb3cgZGVlcCB0aGUgc3RhY2tzIGFyZSDigJQgZm9yIHRlc3RzIGFuZCBmb3IgYHN0YXRlIC0tZnVsbGAuICovXG4gIGRlcHRoKCk6IHsgdW5kbzogbnVtYmVyOyByZWRvOiBudW1iZXIgfSB7XG4gICAgcmV0dXJuIHsgdW5kbzogdGhpcy51bmRvcy5sZW5ndGgsIHJlZG86IHRoaXMucmVkb3MubGVuZ3RoIH07XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgTkFUSVZFIGZpbGUgcGlja2VyIOKAlCB0aGUgYWZmb3JkYW5jZSBhIHdlYiBwYWdlIGNhbm5vdCBoYXZlLlxuICpcbiAqIEEgYnJvd3NlcidzIG93biBgPGlucHV0IHR5cGU9XCJmaWxlXCI+YCBhbmQgYHNob3dPcGVuRmlsZVBpY2tlcigpYCBib3RoIGhhbmRcbiAqIGJhY2sgZmlsZSBDT05URU5UIGFuZCBhIG5hbWUsIG5ldmVyIGEgcGF0aCAoYW5kIEJyYXZlLCBDb2xlJ3MgYnJvd3NlcixcbiAqIGRpc2FibGVzIHRoZSBGaWxlIFN5c3RlbSBBY2Nlc3MgQVBJIG91dHJpZ2h0KS4gQSBjb3B5IGlzIGFsbCBhIHBhZ2UgY2FuIGRvXG4gKiB3aXRoIHRoYXQsIHdoaWNoIGlzIGV4YWN0bHkgd2hhdCBhIGRyb3AgYWxyZWFkeSBkb2VzIChFMjMpLiBCdXQgc2NyaXB0b3JpdW0nc1xuICogZGFlbW9uIGlzIGEgTE9DQUwgUFJPQ0VTUzogaXQgY2FuIGFzayB0aGUgT1MgZm9yIGl0cyBvd24gb3BlbiBkaWFsb2cgYW5kIGdldFxuICogYmFjayBhIHJlYWwgZmlsZXN5c3RlbSBwYXRoIOKAlCBzbyBcIkNob29zZeKAplwiIGxpbmtzIHRoZSByZWFsIGZpbGUgKEUxKSBpbnN0ZWFkXG4gKiBvZiBjb3B5aW5nIGl0LlxuICpcbiAqIEV2ZXJ5dGhpbmcgaGVyZSBpcyBwdXJlOiB3aGljaCBhcmd2IHRvIHJ1biwgYW5kIGhvdyB0byByZWFkIHdoYXQgaXQgcHJpbnRlZC5cbiAqIFRoZSBzcGF3bmluZyAoYW5kIHRoZSBvbmUtYXQtYS10aW1lIHJ1bGUpIGlzIHRoZSBkYWVtb24ncy5cbiAqL1xuXG5leHBvcnQgdHlwZSBQaWNrS2luZCA9IFwiZmlsZVwiIHwgXCJmb2xkZXJcIjtcblxuLyoqIEFuIEFwcGxlU2NyaXB0IHRoYXQgcHV0cyBvbmUgUE9TSVggcGF0aCBwZXIgbGluZSBvbiBzdGRvdXQuICovXG5mdW5jdGlvbiBhcHBsZVNjcmlwdChraW5kOiBQaWNrS2luZCwgcHJvbXB0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBxdW90ZWQgPSBwcm9tcHQucmVwbGFjZSgvW1wiXFxcXF0vZywgXCJcIik7XG4gIGNvbnN0IGNob29zZSA9XG4gICAga2luZCA9PT0gXCJmaWxlXCJcbiAgICAgID8gYGNob29zZSBmaWxlIHdpdGggcHJvbXB0IFwiJHtxdW90ZWR9XCIgd2l0aCBtdWx0aXBsZSBzZWxlY3Rpb25zIGFsbG93ZWRgXG4gICAgICA6IGB7Y2hvb3NlIGZvbGRlciB3aXRoIHByb21wdCBcIiR7cXVvdGVkfVwifWA7XG4gIHJldHVybiBbXG4gICAgYHNldCBjaG9zZW4gdG8gJHtjaG9vc2V9YCxcbiAgICAnc2V0IG91dCB0byBcIlwiJyxcbiAgICBcInJlcGVhdCB3aXRoIGYgaW4gY2hvc2VuXCIsXG4gICAgXCJzZXQgb3V0IHRvIG91dCAmIFBPU0lYIHBhdGggb2YgZiAmIGxpbmVmZWVkXCIsXG4gICAgXCJlbmQgcmVwZWF0XCIsXG4gICAgXCJyZXR1cm4gb3V0XCIsXG4gIF0uam9pbihcIlxcblwiKTtcbn1cblxuLyoqXG4gKiBUaGUgY29tbWFuZCB0aGF0IG9wZW5zIHRoZSBPUydzIHBpY2tlciwgb3IgbnVsbCB3aGVyZSB0aGVyZSBpcyBub25lIOKAlCB0aGVcbiAqIGNhbGxlciB0aGVuIHNheXMgc28gcmF0aGVyIHRoYW4gaGFuZ2luZyBvbiBhIGRpYWxvZyBub2JvZHkgd2lsbCBzZWUuXG4gKiBgemVuaXR5QXRgIGlzIHdoZXJlIGEgTGludXggemVuaXR5IHdhcyBmb3VuZCAodGhlIGNhbGxlciBsb29rcyBpdCB1cCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwaWNrZXJDb21tYW5kKFxuICBwbGF0Zm9ybTogc3RyaW5nLFxuICBraW5kOiBQaWNrS2luZCxcbiAgcHJvbXB0OiBzdHJpbmcsXG4gIHplbml0eUF0Pzogc3RyaW5nIHwgbnVsbCxcbik6IHN0cmluZ1tdIHwgbnVsbCB7XG4gIGlmIChwbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIikgcmV0dXJuIFtcIm9zYXNjcmlwdFwiLCBcIi1lXCIsIGFwcGxlU2NyaXB0KGtpbmQsIHByb21wdCldO1xuICBpZiAocGxhdGZvcm0gPT09IFwid2luMzJcIikgcmV0dXJuIG51bGw7IC8vIFBvd2VyU2hlbGwncyBkaWFsb2cgbmVlZHMgYSBTVEEgaG9zdDsgbm90IHdyaXR0ZW4gdW50aWwgYXNrZWQgZm9yXG4gIGlmICh6ZW5pdHlBdClcbiAgICByZXR1cm4gW1xuICAgICAgemVuaXR5QXQsXG4gICAgICBcIi0tZmlsZS1zZWxlY3Rpb25cIixcbiAgICAgIC4uLihraW5kID09PSBcImZvbGRlclwiID8gW1wiLS1kaXJlY3RvcnlcIl0gOiBbXCItLW11bHRpcGxlXCJdKSxcbiAgICAgIFwiLS1zZXBhcmF0b3I9XFxuXCIsXG4gICAgICBgLS10aXRsZT0ke3Byb21wdH1gLFxuICAgIF07XG4gIHJldHVybiBudWxsO1xufVxuXG4vKiogVGhlIHBhdGhzIGEgcGlja2VyIHByaW50ZWQ6IG9uZSBwZXIgbGluZSwgYmxhbmtzIGRyb3BwZWQsIG9yZGVyIGtlcHQuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VQaWNrZXJPdXRwdXQoc3Rkb3V0OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBzdGRvdXRcbiAgICAuc3BsaXQoXCJcXG5cIilcbiAgICAubWFwKChsKSA9PiBsLnRyaW0oKSlcbiAgICAuZmlsdGVyKChsKSA9PiBsLnN0YXJ0c1dpdGgoXCIvXCIpKVxuICAgIC5tYXAoKGwpID0+IChsLmxlbmd0aCA+IDEgJiYgbC5lbmRzV2l0aChcIi9cIikgPyBsLnNsaWNlKDAsIC0xKSA6IGwpKTtcbn1cblxuLyoqIEEgY2FuY2VsbGVkIGRpYWxvZyBpcyBub3QgYSBmYWlsdXJlIOKAlCBvc2FzY3JpcHQgZXhpdHMgMSwgemVuaXR5IGV4aXRzIDEsIGFuZCBub3RoaW5nIHdhcyBjaG9zZW4uICovXG5leHBvcnQgZnVuY3Rpb24gd2FzQ2FuY2VsbGVkKGV4aXRDb2RlOiBudW1iZXIsIHN0ZG91dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBleGl0Q29kZSAhPT0gMCAmJiBwYXJzZVBpY2tlck91dHB1dChzdGRvdXQpLmxlbmd0aCA9PT0gMDtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgc2Vzc2lvbiDigJQgdGhlIGRhZW1vbidzIHN0YXRlLCBhbmQgdGhlIG9ubHkgY29kZSB0aGF0IHdyaXRlcyBhIGZpbGUuXG4gKlxuICogRTgncyBzaGFwZSwgdGhlIGhvdXNlJ3MgXCJtYXRlcmlhbGl6ZWQgcGF0aFwiIHBhdHRlcm46IHRoZSBkYWVtb24gb3ducyB0aGVcbiAqIHNlc3Npb24gKGNvbnRleHQsIGRvY3MsIHZlcnNpb25zLCB3aGljaCBpcyBhY3RpdmUsIHRoZSBjaGF0KSBhbmQgcGVyc2lzdHMgaXRcbiAqIGFzIGBtYW5pZmVzdC5qc29uYDsgZXZlcnkgdmVyc2lvbidzIFRFWFQgaXMgYSBmaWxlIGluIHRoZSBzZXNzaW9uIGZvbGRlciwgc29cbiAqIHRoZSBhZ2VudCBlZGl0cyB2ZXJzaW9ucyB3aXRoIGl0cyBvd24gZmlsZSB0b29scy5cbiAqXG4gKiAgICAgJFNDUklQVE9SSVVNX0hPTUUvc2Vzc2lvbnMvPHNlc3Npb25JZD4vXG4gKiAgICAgICBtYW5pZmVzdC5qc29uICAgICAgICAgICAgICB3cml0dGVuIGF0b21pY2FsbHksIG9uIGV2ZXJ5IGNoYW5nZVxuICogICAgICAgZG9jcy88c2x1Zz4vdjEubWQsIHYyLm1kICAgb25lIGZpbGUgcGVyIHZlcnNpb25cbiAqXG4gKiBUaGUgdGhyZWUgd3JpdGUgcnVsZXMsIGVhY2ggYSBkZWNpc2lvbiByYXRoZXIgdGhhbiBhIGhhYml0OlxuICpcbiAqIC0gKipUaGUgb3JpZ2luYWwgaXMgd3JpdHRlbiBPTkxZIGJ5IGBzYXZlYCoqIChFNykuIE9wZW5pbmcgY29waWVzIGl0IHRvIHYxO1xuICogICBub3RoaW5nIGVsc2UgdG91Y2hlcyBpdC5cbiAqIC0gKipFdmVyeSB3cml0ZSB0aGlzIG1vZHVsZSBtYWtlcyBpcyByZW1lbWJlcmVkIGJ5IGNvbnRlbnQgaGFzaCoqICh0aGVcbiAqICAgYG93bmVkYCBtYXApIHNvIHRoZSB3YXRjaGVyIGNhbiB0ZWxsIHRoZSBkYWVtb24ncyBvd24gd3JpdGVzIGZyb20gYW55b25lXG4gKiAgIGVsc2UncyAoaW52ZXN0aWdhdGlvbiDCpzUpLiBBIHdyaXRlIHRvIHRoZSBBQ1RJVkUgdmVyc2lvbiB0aGF0IGlzIG5vdCBvdXJzXG4gKiAgIGlzIGFuIEUyIHZpb2xhdGlvbiB0aGUgZGFlbW9uIGFubm91bmNlcy5cbiAqIC0gKipUaGUgYWdlbnQgbmV2ZXIgd3JpdGVzIHRoZSBhY3RpdmUgdmVyc2lvbioqIChFMikg4oCUIGVuZm9yY2VkIHNvY2lhbGx5IGJ5XG4gKiAgIFNLSUxMLm1kIGFuZCBkZXRlY3RlZCBoZXJlLCBub3QgcHJldmVudGVkOiB0aGUgZmlsZSBpcyB0aGUgYWdlbnQncyBtZWRpdW0uXG4gKlxuICogTm90aGluZyBoZXJlIGtub3dzIGFib3V0IHNvY2tldHMsIEhUVFAgb3IgdGhlIGV2ZW50IGxvZy4gVGhlIGRhZW1vbiBjYWxscyBhXG4gKiBtZXRob2QsIGdldHMgYSByZXN1bHQsIGFuZCBkZWNpZGVzIHdoYXQgdG8gYnJvYWRjYXN0OyB0aGF0IHNwbGl0IGlzIHdoYXRcbiAqIGxldHMgdGhlIHVuaXQgY2VsbHMgZHJpdmUgdGhlIHdob2xlIG1vZGVsIHdpdGggYSB0ZW1wIGhvbWUuXG4gKi9cblxuaW1wb3J0IHtcbiAgY2xvc2VTeW5jLFxuICBleGlzdHNTeW5jLFxuICBta2RpclN5bmMsXG4gIG9wZW5TeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICByZWFkU3luYyxcbiAgcmVhbHBhdGhTeW5jLFxuICByZW5hbWVTeW5jLFxuICAvLyDimqAgYHJtZGlyU3luY2AgcmF0aGVyIHRoYW4gYHJtU3luYyjigKYsIHtyZWN1cnNpdmU6dHJ1ZX0pYCBPTiBQVVJQT1NFOiBpdFxuICAvLyB0aHJvd3MgRU5PVEVNUFRZLCB3aGljaCBpcyBhIHNlY29uZCBuZXQgdW5kZXIgYHJlbW92ZUNyZWF0ZWRgJ3Mgb3duXG4gIC8vIGVtcHRpbmVzcyBjaGVjay4gQSByZWN1cnNpdmUgZGVsZXRlIHdvdWxkIG1ha2UgdGhlIGJ1ZyBpdCBwcmV2ZW50c1xuICAvLyB1bnJlY292ZXJhYmxlIHJhdGhlciB0aGFuIGxvdWQuXG4gIHJtZGlyU3luYyxcbiAgcm1TeW5jLFxuICBzdGF0U3luYyxcbiAgdW5saW5rU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGV4dG5hbWUsIGlzQWJzb2x1dGUsIGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB3cml0ZUZpbGVBdG9taWMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZGlzY292ZXJ5LnRzXCI7XG5pbXBvcnQgeyB0eXBlIEFuY2hvciwgYW5jaG9yT2YsIGZpbmRBbmNob3IgfSBmcm9tIFwiLi9hbmNob3JzXCI7XG5pbXBvcnQgeyBhcHBseUh1bmtzLCBkaWZmVGV4dCB9IGZyb20gXCIuL2RpZmZcIjtcbmltcG9ydCB7XG4gIGJvZHlMaW5lT2Zmc2V0LFxuICBidWlsZEJsb2NrLFxuICBndWVzc1R5cGUsXG4gIG1hdGNoZXNGaWx0ZXIsXG4gIHJlYWRNZXRhLFxuICBzZXRLZXksXG4gIHNwbGl0RnJvbnRtYXR0ZXIsXG4gIHN1bW1hcml6ZSxcbiAgdGl0bGVGcm9tQm9keSxcbiAgd2l0aEJsb2NrLFxufSBmcm9tIFwiLi9mcm9udG1hdHRlclwiO1xuaW1wb3J0IHsgdHlwZSBCdW5kbGVJbmRleCwgYnVpbGRHcmFwaCwgdHlwZSBSZXNvbHV0aW9uLCByZXNvbHZlVGFyZ2V0IH0gZnJvbSBcIi4vbGlua3NcIjtcbmltcG9ydCB0eXBlIHtcbiAgQ2hhdE1lc3NhZ2UsXG4gIENoYXRXaG8sXG4gIENvbnRleHRFbnRyeSxcbiAgRGlmZlBheWxvYWQsXG4gIERpZmZTaWRlLFxuICBEb2NNZXRhLFxuICBEb2NTdW1tYXJ5LFxuICBEb2NWaWV3LFxuICBHcmFwaFBheWxvYWQsXG4gIE1ldGFGaWx0ZXIsXG4gIE1vdmVQbGFuLFxuICBOb3RlLFxuICBQbGFjZWROb3RlLFxuICBQdWJsaWNTdGF0ZSxcbiAgU2VsZWN0aW9uLFxuICBUYXNrLFxuICBWZXJzaW9uLFxuICBWZXJzaW9uQXV0aG9yLFxufSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuaW1wb3J0IHsgdHlwZSBDYW5kaWRhdGUsIHR5cGUgU2VhcmNoUmVwb3J0LCBzZWFyY2hEb2N1bWVudHMgfSBmcm9tIFwiLi9zZWFyY2hcIjtcbmltcG9ydCB7XG4gIERPQ19FWFRFTlNJT05TLFxuICBkb2NQYXRocyxcbiAgZW50cnlGb3JQYXRoLFxuICBmaW5kTm9kZSxcbiAgaXNEb2NOYW1lLFxuICBsb2NhdGUsXG4gIE1JUlJPUl9OT0RFX0NBUCxcbiAgc2NhblRyZWUsXG4gIHRvUG9zaXgsXG59IGZyb20gXCIuL3RyZWVcIjtcblxuZXhwb3J0IGNvbnN0IE1BTklGRVNUX0ZPUk1BVCA9IDE7XG5cbi8qKiBUaGUgbW9zdCBkb2N1bWVudHMgb25lIGZyb250bWF0dGVyIHNjYW4gcmVhZHMuICovXG5leHBvcnQgY29uc3QgTUVUQV9TQ0FOX0NBUCA9IDUwMDtcbi8qKiBBIGZyb250bWF0dGVyIGJsb2NrIGxpdmVzIGF0IHRoZSB0b3Agb2YgYSBmaWxlOyB0aGlzIGlzIGhvdyBtdWNoIHdlIHJlYWQgdG8gZmluZCBpdC4gKi9cbmNvbnN0IE1FVEFfSEVBRF9CWVRFUyA9IDgxOTI7XG5cbi8qKiBUaGUgZmlyc3QgOCBLQiBvZiBhIGZpbGUsIGFzIHRleHQg4oCUIGVub3VnaCBmb3IgYW55IGZyb250bWF0dGVyIGJsb2NrLiAqL1xuZnVuY3Rpb24gcmVhZEhlYWQocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgbGV0IGZkOiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgZmQgPSBvcGVuU3luYyhwYXRoLCBcInJcIik7XG4gICAgY29uc3QgYnVmID0gQnVmZmVyLmFsbG9jKE1FVEFfSEVBRF9CWVRFUyk7XG4gICAgY29uc3QgcmVhZCA9IHJlYWRTeW5jKGZkLCBidWYsIDAsIE1FVEFfSEVBRF9CWVRFUywgMCk7XG4gICAgcmV0dXJuIGJ1Zi5zdWJhcnJheSgwLCByZWFkKS50b1N0cmluZyhcInV0ZjhcIik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBcIlwiO1xuICB9IGZpbmFsbHkge1xuICAgIGlmIChmZCAhPT0gdW5kZWZpbmVkKSBjbG9zZVN5bmMoZmQpO1xuICB9XG59XG5cbnR5cGUgRG9jUmVjb3JkID0ge1xuICBzbHVnOiBzdHJpbmc7XG4gIG5hbWU6IHN0cmluZztcbiAgb3JpZ2luYWw6IHN0cmluZztcbiAgZW50cnlJZDogc3RyaW5nIHwgbnVsbDtcbiAgcmVsOiBzdHJpbmcgfCBudWxsO1xuICBleHQ6IHN0cmluZztcbiAgdmVyc2lvbnM6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+W107XG4gIGFjdGl2ZTogbnVtYmVyO1xuICAvKipcbiAgICogVGhlIG5leHQgdmVyc2lvbiBudW1iZXIgdG8gaGFuZCBvdXQg4oCUIE1PTk9UT05JQywgYW5kIG5ldmVyIGRlcml2ZWQgZnJvbVxuICAgKiB0aGUgdmVyc2lvbnMgc3RpbGwgcHJlc2VudCAoRTQxKS4gTnVtYmVyaW5nIGFzIGBtYXgoZXhpc3RpbmcpICsgMWAgd2FzXG4gICAqIGNvcnJlY3Qgd2hpbGUgbm90aGluZyBjb3VsZCBiZSBkZWxldGVkOyB0aGUgbW9tZW50IGEgdmVyc2lvbiBjYW4gYmVcbiAgICogcmVtb3ZlZCwgZGVsZXRpbmcgdGhlIGhpZ2hlc3QgbWFrZXMgdGhlIG5leHQgb25lIFJFVVNFIGl0cyBudW1iZXIsIGFuZCBhXG4gICAqIGB2M2AgbmFtZWQgaW4gYSBjaGF0IG1lc3NhZ2UsIGEgbG9nIGxpbmUgb3IgYW4gYWdlbnQncyBub3RlcyB3b3VsZCB0aGVuXG4gICAqIHBvaW50IGF0IGEgZGlmZmVyZW50IGRvY3VtZW50LiBBYnNlbnQgb24gYSBtYW5pZmVzdCB3cml0dGVuIGJlZm9yZSBFNDEg4oCUXG4gICAqIGB0YWtlVmVyc2lvbmAgZGVyaXZlcyBpdCBvbmNlLCBmcm9tIHRoZSBoaWdoZXN0IHRoYXQgZXZlciB3YXMuXG4gICAqL1xuICBuZXh0VmVyc2lvbj86IG51bWJlcjtcbiAgLyoqIE5vdGVzIG9uIHRoaXMgZG9jdW1lbnQgKEU0NSkuIFN0b3JlZCBpbiB0aGUgbWFuaWZlc3Q6IHRoZXkgdHJhdmVsIHdpdGggdGhlXG4gICAqICBzZXNzaW9uIGFuZCBuZXZlciBsaXR0ZXIgdGhlIGh1bWFuJ3MgZm9sZGVyLiAqL1xuICBub3Rlcz86IE5vdGVbXTtcbiAgLyoqIEhhc2ggb2YgdGhlIG9yaWdpbmFsIGFzIHdlIGxhc3QgcmVhZCBvciB3cm90ZSBpdCDigJQgYXQgb3Blbiwgc2F2ZSwgcmV2ZXJ0XG4gICAqICBhbmQgcmVsb2FkIOKAlCBzbyBhIHJlc3RvcmUgY2FuIHRlbGwgdGhhdCBpdCBjaGFuZ2VkIHdoaWxlIG5vIGRhZW1vbiB3YXNcbiAgICogIHdhdGNoaW5nICh2ZXJpZnktcGFzcyBmaXggMikuICovXG4gIG9yaWdpbmFsSGFzaDogc3RyaW5nO1xuICAvKiogU2V0IG9ubHkgYnkgYG9wZW5QYXRoYCwgd2hpY2ggYWRtaXRzIGEgZG9jLXR5cGUgZmlsZSBJTlNJREUgYSBjb250ZXh0XG4gICAqICBlbnRyeS4gYHNhdmVgIHdyaXRlcyBubyBvcmlnaW5hbCB0aGF0IGxhY2tzIGl0ICh2ZXJpZnktcGFzcyBmaXggMWMpLiAqL1xuICBhZG1pdHRlZD86IGJvb2xlYW47XG4gIG91dHNpZGVDaGFuZ2VkOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgTWFuaWZlc3QgPSB7XG4gIGZvcm1hdDogbnVtYmVyO1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIGNvbnRleHQ6IENvbnRleHRFbnRyeVtdO1xuICBkb2NzOiBEb2NSZWNvcmRbXTtcbiAgb3BlbkRvYzogc3RyaW5nIHwgbnVsbDtcbiAgY2hhdDogQ2hhdE1lc3NhZ2VbXTtcbiAgLyoqIFRoZSB3b3JrIHF1ZXVlIChFNTApLiBBYnNlbnQgaW4gYSBtYW5pZmVzdCB3cml0dGVuIGJlZm9yZSBpdCBleGlzdGVkLiAqL1xuICB0YXNrcz86IFRhc2tbXTtcbiAgLyoqIEUyMydzIHdvcmtzcGFjZS4gQWJzZW50IGluIGEgbWFuaWZlc3Qgd3JpdHRlbiBiZWZvcmUgaXQgZXhpc3RlZDogdGhlIHVzZXIncyBob21lLiAqL1xuICB3b3Jrc3BhY2U/OiBzdHJpbmc7XG59O1xuXG4vKiogQSByZWZ1c2FsIHRoZSBkYWVtb24gdHVybnMgaW50byBhbiBIVFRQIHN0YXR1cyDigJQgYGNob2ljZXNgIHdoZW4gdGhlIHNldCBpcyBpbiBoYW5kIChBMSkuICovXG5leHBvcnQgY2xhc3MgU2Vzc2lvbkVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgcmVhZG9ubHkgc3RhdHVzOiA0MDAgfCA0MDQgfCA0MDksXG4gICAgcmVhZG9ubHkgY2hvaWNlcz86IHN0cmluZ1tdLFxuICApIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgfVxufVxuXG5leHBvcnQgY29uc3QgY29udGVudEhhc2ggPSAodGV4dDogc3RyaW5nKTogc3RyaW5nID0+IEJ1bi5oYXNoKHRleHQpLnRvU3RyaW5nKDE2KTtcblxuY29uc3QgcmFuZEhleCA9IChuOiBudW1iZXIpID0+XG4gIEFycmF5LmZyb20oY3J5cHRvLmdldFJhbmRvbVZhbHVlcyhuZXcgVWludDhBcnJheShuKSkpXG4gICAgLm1hcCgoYikgPT4gYi50b1N0cmluZygxNikucGFkU3RhcnQoMiwgXCIwXCIpKVxuICAgIC5qb2luKFwiXCIpO1xuXG5leHBvcnQgY29uc3QgbmV3U2Vzc2lvbklkID0gKCk6IHN0cmluZyA9PiByYW5kSGV4KDQpO1xuXG4vKiogQSBwYXRoJ3MgcmVhbHBhdGgsIG9yIHRoZSBwYXRoIGl0c2VsZiB3aGVuIGl0IGNhbm5vdCBiZSByZXNvbHZlZCAoZ29uZSkuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhbE9yKHA6IHN0cmluZyk6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHJlYWxwYXRoU3luYyhwKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHA7XG4gIH1cbn1cblxuLyoqIFdoYXQgYSB3YXRjaGVyIGV2ZW50IHR1cm5lZCBvdXQgdG8gYmUuIGBudWxsYCA9IG5vdGhpbmcgKG91cnMsIG9yIG5vIGNoYW5nZSkuICovXG5leHBvcnQgdHlwZSBGaWxlRXZlbnQgPVxuICB8IHsga2luZDogXCJ2ZXJzaW9uLmNoYW5nZWRcIjsgZG9jOiBzdHJpbmc7IHZlcnNpb246IG51bWJlcjsgdGV4dDogc3RyaW5nOyBhY3RpdmU6IGZhbHNlIH1cbiAgfCB7XG4gICAgICBraW5kOiBcImFjdGl2ZS5vdXRzaWRlXCI7XG4gICAgICBkb2M6IHN0cmluZztcbiAgICAgIHZlcnNpb246IG51bWJlcjtcbiAgICAgIHBhdGg6IHN0cmluZztcbiAgICAgIC8qKiBUaGUgbmV3IGFnZW50IHZlcnNpb24gdGhlIG91dHNpZGUgdGV4dCB3YXMgcHJlc2VydmVkIGFzLiAqL1xuICAgICAgcHJlc2VydmVkQXM6IG51bWJlcjtcbiAgICAgIHByZXNlcnZlZFBhdGg6IHN0cmluZztcbiAgICB9XG4gIHwgeyBraW5kOiBcInZlcnNpb24uY3JlYXRlZFwiOyBkb2M6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyOyBwYXRoOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJvcmlnaW5hbC5yZWxvYWRlZFwiOyBkb2M6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyOyB0ZXh0OiBzdHJpbmc7IG9yaWdpbmFsOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJvcmlnaW5hbC5jb25mbGljdFwiOyBkb2M6IHN0cmluZzsgb3JpZ2luYWw6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcInRyZWVcIjsgZW50cnlJZDogc3RyaW5nIH07XG5cbmV4cG9ydCBjbGFzcyBTZXNzaW9uIHtcbiAgcmVhZG9ubHkgZGlyOiBzdHJpbmc7XG4gIHByaXZhdGUgbTogTWFuaWZlc3Q7XG4gIC8qKiBwYXRoIOKGkiBoYXNoIG9mIHRoZSBkYWVtb24ncyBsYXN0IHdyaXRlIHRvIGl0LiAqL1xuICBwcml2YXRlIG93bmVkID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgLyoqIHNsdWcg4oaSIGhhc2ggb2YgdGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgY3VycmVudCB0ZXh0LiAqL1xuICBwcml2YXRlIGFjdGl2ZUhhc2ggPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAvKiogc2x1ZyDihpIgdGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCBhcyB0aGUgZGFlbW9uIGxhc3Qgd3JvdGUgKG9yIGFkb3B0ZWQpXG4gICAqICBpdCDigJQgd2hhdCBhbiBvdXRzaWRlIHdyaXRlIHRvIHRoZSBhY3RpdmUgdmVyc2lvbiBpcyByZXZlcnRlZCB0by4gKi9cbiAgcHJpdmF0ZSBsYXN0QWN0aXZlVGV4dCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIC8qKiBXaGF0IGEgcmVzdG9yZSBmb3VuZCBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgbm8gZGFlbW9uIHdhcyB3YXRjaGluZy4gKi9cbiAgcmVzdG9yZUZpbmRpbmdzOiB7IGRvYzogc3RyaW5nOyBvcmlnaW5hbDogc3RyaW5nOyBtaXNzaW5nOiBib29sZWFuIH1bXSA9IFtdO1xuXG4gIHByaXZhdGUgY29uc3RydWN0b3IoXG4gICAgcmVhZG9ubHkgaG9tZTogc3RyaW5nLFxuICAgIG1hbmlmZXN0OiBNYW5pZmVzdCxcbiAgKSB7XG4gICAgdGhpcy5tID0gbWFuaWZlc3Q7XG4gICAgdGhpcy5kaXIgPSBqb2luKGhvbWUsIFwic2Vzc2lvbnNcIiwgbWFuaWZlc3Quc2Vzc2lvbklkKTtcbiAgfVxuXG4gIHN0YXRpYyBjcmVhdGUoaG9tZTogc3RyaW5nLCBzZXNzaW9uSWQ6IHN0cmluZyA9IG5ld1Nlc3Npb25JZCgpLCB3b3Jrc3BhY2U/OiBzdHJpbmcpOiBTZXNzaW9uIHtcbiAgICBjb25zdCBzID0gbmV3IFNlc3Npb24oaG9tZSwge1xuICAgICAgZm9ybWF0OiBNQU5JRkVTVF9GT1JNQVQsXG4gICAgICBzZXNzaW9uSWQsXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICBjb250ZXh0OiBbXSxcbiAgICAgIGRvY3M6IFtdLFxuICAgICAgb3BlbkRvYzogbnVsbCxcbiAgICAgIGNoYXQ6IFtdLFxuICAgICAgLi4uKHdvcmtzcGFjZSA/IHsgd29ya3NwYWNlOiByZXNvbHZlKHdvcmtzcGFjZSkgfSA6IHt9KSxcbiAgICB9KTtcbiAgICBta2RpclN5bmMoam9pbihzLmRpciwgXCJkb2NzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gcztcbiAgfVxuXG4gIC8qKiBSZWxvYWQgYSBzZXNzaW9uIGZyb20gaXRzIG1hbmlmZXN0IChgb3BlbiAtLXJlc3RvcmUgPGlkPmApLiAqL1xuICBzdGF0aWMgcmVzdG9yZShob21lOiBzdHJpbmcsIHNlc3Npb25JZDogc3RyaW5nKTogU2Vzc2lvbiB7XG4gICAgY29uc3QgcGF0aCA9IGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiLCBzZXNzaW9uSWQsIFwibWFuaWZlc3QuanNvblwiKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vIHNhdmVkIHNlc3Npb24gJHtzZXNzaW9uSWR9YCwgNDA0KTtcbiAgICBjb25zdCBtID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSBhcyBNYW5pZmVzdDtcbiAgICBpZiAobS5mb3JtYXQgIT09IE1BTklGRVNUX0ZPUk1BVClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYHNlc3Npb24gJHtzZXNzaW9uSWR9IGhhcyBtYW5pZmVzdCBmb3JtYXQgJHttLmZvcm1hdH1gLCA0MDkpO1xuICAgIGNvbnN0IHMgPSBuZXcgU2Vzc2lvbihob21lLCBtKTtcbiAgICBta2RpclN5bmMoam9pbihzLmRpciwgXCJkb2NzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAvLyBNaXJyb3JzIGFyZSByZS1yZWFkLCBub3QgdHJ1c3RlZDogdGhlIGZvbGRlciBtYXkgaGF2ZSBjaGFuZ2VkIHdoaWxlIG5vXG4gICAgLy8gZGFlbW9uIHdhcyB3YXRjaGluZyBpdC5cbiAgICBmb3IgKGNvbnN0IGUgb2Ygcy5tLmNvbnRleHQpIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIikgcy5yZXNjYW4oZS5pZCk7XG4gICAgZm9yIChjb25zdCBkIG9mIHMubS5kb2NzKSB7XG4gICAgICBjb25zdCBwID0gcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSk7XG4gICAgICBjb25zdCB0ZXh0ID0gZXhpc3RzU3luYyhwKSA/IHJlYWRGaWxlU3luYyhwLCBcInV0ZjhcIikgOiBcIlwiO1xuICAgICAgcy5hZG9wdEFjdGl2ZShkLCB0ZXh0KTtcbiAgICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggMjogYW4gb3JpZ2luYWwgY2hhbmdlZCB3aGlsZSB0aGUgc2Vzc2lvbiB3YXMgY2xvc2VkXG4gICAgICAvLyB3YXMgaW52aXNpYmxlIGhlcmUsIHNvIHRoZSBuZXh0IFNhdmUgb3Zlcndyb3RlIGl0IHVuYW5ub3VuY2VkLiBUaGVcbiAgICAgIC8vIG1hbmlmZXN0IGhvbGRzIHRoZSBvcmlnaW5hbCdzIGhhc2ggYXMgb2YgdGhlIGxhc3Qgb3Blbi9zYXZlL3JldmVydC9cbiAgICAgIC8vIHJlbG9hZDsgYSBkaWZmZXJlbnQgaGFzaCBub3cgaXMgYW4gb3V0c2lkZSBjaGFuZ2UsIG1hcmtlZCBleGFjdGx5IGFzIGFcbiAgICAgIC8vIGxpdmUgb25lIHdpdGggYSBkaXJ0eSBidWZmZXIgaXMg4oCUIGFza2VkLCBuZXZlciBtZXJnZWQgb3IgcmVsb2FkZWQuXG4gICAgICBsZXQgbm93OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICAgIHRyeSB7XG4gICAgICAgIG5vdyA9IGNvbnRlbnRIYXNoKHJlYWRGaWxlU3luYyhkLm9yaWdpbmFsLCBcInV0ZjhcIikpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIG5vdyA9IG51bGw7XG4gICAgICB9XG4gICAgICBpZiAobm93ID09PSBudWxsIHx8IG5vdyAhPT0gZC5vcmlnaW5hbEhhc2gpIHtcbiAgICAgICAgZC5vdXRzaWRlQ2hhbmdlZCA9IHRydWU7XG4gICAgICAgIHMucmVzdG9yZUZpbmRpbmdzLnB1c2goeyBkb2M6IGQuc2x1Zywgb3JpZ2luYWw6IGQub3JpZ2luYWwsIG1pc3Npbmc6IG5vdyA9PT0gbnVsbCB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHMucmVzdG9yZUZpbmRpbmdzLmxlbmd0aCA+IDApIHMucGVyc2lzdCgpO1xuICAgIHJldHVybiBzO1xuICB9XG5cbiAgc3RhdGljIGxpc3RTYXZlZChob21lOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiByZWFkZGlyU3luYyhqb2luKGhvbWUsIFwic2Vzc2lvbnNcIikpLmZpbHRlcigoaWQpID0+XG4gICAgICAgIGV4aXN0c1N5bmMoam9pbihob21lLCBcInNlc3Npb25zXCIsIGlkLCBcIm1hbmlmZXN0Lmpzb25cIikpLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG4gIH1cblxuICBnZXQgaWQoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5tLnNlc3Npb25JZDtcbiAgfVxuXG4gIGdldCBkb2NzRGlyKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGpvaW4odGhpcy5kaXIsIFwiZG9jc1wiKTtcbiAgfVxuXG4gIGdldCBvcGVuRG9jU2x1ZygpOiBzdHJpbmcgfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5tLm9wZW5Eb2M7XG4gIH1cblxuICBnZXQgY29udGV4dCgpOiByZWFkb25seSBDb250ZXh0RW50cnlbXSB7XG4gICAgcmV0dXJuIHRoaXMubS5jb250ZXh0O1xuICB9XG5cbiAgLyoqXG4gICAqIEV2ZXJ5IGRpcmVjdG9yeSB0aGUgd2F0Y2hlciBtdXN0IHNlZTogdGhlIHNlc3Npb24ncyBkb2NzLCBlYWNoIGVudHJ5IHJvb3QsXG4gICAqIGFuZCB0aGUgUkVBTCBkaXJlY3Rvcnkgb2YgZXZlcnkgb3BlbmVkIG9yaWdpbmFsLlxuICAgKlxuICAgKiDim5QgVkVSSUZZLVBBU1MgRklYIDM6IGVhY2ggcm9vdCBpcyB3YXRjaGVkIGF0IGl0cyBSRUFMUEFUSCAoYHdhdGNoYCksIGFuZFxuICAgKiBhbiBldmVudCBpcyByZXBvcnRlZCB1bmRlciB0aGUgcGF0aCBmb3JtIHRoZSBzZXNzaW9uIHN0b3JlcyAoYHBhdGhgKS4gQVxuICAgKiB3YXRjaCBvbiBhIHN5bWxpbmtlZCBkaXJlY3Rvcnkg4oCUIGEgc3ltbGlua2VkIGhvbWUsIGEgc3ltbGlua2VkIGZvbGRlclxuICAgKiBlbnRyeSDigJQgb3Igb24gdGhlIGxpbmsncyBvd24gZGlyZWN0b3J5IGZvciBhIHN5bWxpbmtlZCBvcmlnaW5hbCBzYXdcbiAgICogbm90aGluZyB3aGVuIHRoZSBUQVJHRVQgY2hhbmdlZCAoRlNFdmVudHMgcmVwb3J0cyByZWFsIHBhdGhzKS4gQSBzeW1saW5rZWRcbiAgICogb3JpZ2luYWwgaXMgbWF0Y2hlZCBiYWNrIHRvIGl0cyBkb2MgYnkgcmVhbHBhdGggaW4gYG9uRmlsZUV2ZW50YC5cbiAgICovXG4gIHdhdGNoUm9vdHMoKTogeyBwYXRoOiBzdHJpbmc7IHdhdGNoOiBzdHJpbmc7IHJlY3Vyc2l2ZTogYm9vbGVhbjsgZW50cnlJZD86IHN0cmluZyB9W10ge1xuICAgIGNvbnN0IHJvb3RzOiB7IHBhdGg6IHN0cmluZzsgd2F0Y2g6IHN0cmluZzsgcmVjdXJzaXZlOiBib29sZWFuOyBlbnRyeUlkPzogc3RyaW5nIH1bXSA9IFtcbiAgICAgIHsgcGF0aDogdGhpcy5kb2NzRGlyLCB3YXRjaDogcmVhbE9yKHRoaXMuZG9jc0RpciksIHJlY3Vyc2l2ZTogdHJ1ZSB9LFxuICAgIF07XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KVxuICAgICAgcm9vdHMucHVzaCh7XG4gICAgICAgIHBhdGg6IGUucm9vdCxcbiAgICAgICAgd2F0Y2g6IHJlYWxPcihlLnJvb3QpLFxuICAgICAgICByZWN1cnNpdmU6IGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiLFxuICAgICAgICBlbnRyeUlkOiBlLmlkLFxuICAgICAgfSk7XG4gICAgZm9yIChjb25zdCBkIG9mIHRoaXMubS5kb2NzKSB7XG4gICAgICBjb25zdCByZWFsRGlyID0gZGlybmFtZShyZWFsT3IoZC5vcmlnaW5hbCkpO1xuICAgICAgaWYgKFxuICAgICAgICAhcm9vdHMuc29tZSgocikgPT4gci53YXRjaCA9PT0gcmVhbERpciAmJiByLnJlY3Vyc2l2ZSA9PT0gZmFsc2UpICYmXG4gICAgICAgICFyb290cy5zb21lKFxuICAgICAgICAgIChyKSA9PiByLnJlY3Vyc2l2ZSAmJiAocmVhbERpciA9PT0gci53YXRjaCB8fCByZWFsRGlyLnN0YXJ0c1dpdGgoci53YXRjaCArIHNlcCkpLFxuICAgICAgICApXG4gICAgICApXG4gICAgICAgIHJvb3RzLnB1c2goeyBwYXRoOiByZWFsRGlyLCB3YXRjaDogcmVhbERpciwgcmVjdXJzaXZlOiBmYWxzZSB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHJvb3RzO1xuICB9XG5cbiAgLy8g4pSA4pSAIHBlcnNpc3RlbmNlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIHBlcnNpc3QoKTogdm9pZCB7XG4gICAgbWtkaXJTeW5jKHRoaXMuZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVBdG9taWMoam9pbih0aGlzLmRpciwgXCJtYW5pZmVzdC5qc29uXCIpLCBgJHtKU09OLnN0cmluZ2lmeSh0aGlzLm0sIG51bGwsIDIpfVxcbmApO1xuICB9XG5cbiAgcHJpdmF0ZSB3cml0ZU93bmVkKHBhdGg6IHN0cmluZywgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gICAgbWtkaXJTeW5jKGRpcm5hbWUocGF0aCksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIC8vIFJlbWVtYmVyIEJFRk9SRSB3cml0aW5nOiB0aGUgd2F0Y2hlcidzIGV2ZW50IGNhbiBhcnJpdmUgYmVmb3JlIHRoaXNcbiAgICAvLyBmdW5jdGlvbiByZXR1cm5zLCBhbmQgaXQgbXVzdCBmaW5kIHRoZSBoYXNoIGFscmVhZHkgdGhlcmUuXG4gICAgdGhpcy5vd25lZC5zZXQocGF0aCwgY29udGVudEhhc2godGV4dCkpO1xuICAgIHdyaXRlRmlsZVN5bmMocGF0aCwgdGV4dCk7XG4gIH1cblxuICBwcml2YXRlIGFkb3B0QWN0aXZlKGQ6IERvY1JlY29yZCwgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgcCA9IHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpO1xuICAgIHRoaXMub3duZWQuc2V0KHAsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLmFjdGl2ZUhhc2guc2V0KGQuc2x1ZywgY29udGVudEhhc2godGV4dCkpO1xuICAgIHRoaXMubGFzdEFjdGl2ZVRleHQuc2V0KGQuc2x1ZywgdGV4dCk7XG4gIH1cblxuICBwcml2YXRlIHdyaXRlQWN0aXZlKGQ6IERvY1JlY29yZCwgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy53cml0ZU93bmVkKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCB0ZXh0KTtcbiAgICB0aGlzLmFjdGl2ZUhhc2guc2V0KGQuc2x1ZywgY29udGVudEhhc2godGV4dCkpO1xuICAgIHRoaXMubGFzdEFjdGl2ZVRleHQuc2V0KGQuc2x1ZywgdGV4dCk7XG4gIH1cblxuICAvKiogS2VlcCBhbiBvdXRzaWRlIHdyaXRlIHRvIHRoZSBhY3RpdmUgdmVyc2lvbiBhcyBhIE5FVyBhZ2VudCB2ZXJzaW9uLiAqL1xuICBwcml2YXRlIHByZXNlcnZlT3V0c2lkZShkOiBEb2NSZWNvcmQsIHRleHQ6IHN0cmluZyk6IFZlcnNpb24ge1xuICAgIGNvbnN0IG4gPSB0aGlzLnRha2VWZXJzaW9uKGQpO1xuICAgIGNvbnN0IHJlYzogT21pdDxWZXJzaW9uLCBcInBhdGhcIj4gPSB7XG4gICAgICBuLFxuICAgICAgYXV0aG9yOiBcImFnZW50XCIsXG4gICAgICBmcm9tOiBkLmFjdGl2ZSxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIGxhYmVsOiBgb3V0c2lkZSB3cml0ZSB0byB2JHtkLmFjdGl2ZX1gLFxuICAgIH07XG4gICAgZC52ZXJzaW9ucy5wdXNoKHJlYyk7XG4gICAgdGhpcy53cml0ZU93bmVkKHRoaXMudmVyc2lvblBhdGgoZCwgbiksIHRleHQpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IC4uLnJlYywgcGF0aDogdGhpcy52ZXJzaW9uUGF0aChkLCBuKSB9O1xuICB9XG5cbiAgLyoqIFRydWUgaWZmIGB0ZXh0YCBhdCBgcGF0aGAgaXMgZXhhY3RseSB3aGF0IHRoZSBkYWVtb24gbGFzdCB3cm90ZSB0aGVyZS4gKi9cbiAgaXNPd25Xcml0ZShwYXRoOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLm93bmVkLmdldChwYXRoKSA9PT0gY29udGVudEhhc2godGV4dCk7XG4gIH1cblxuICAvLyDilIDilIAgY29udGV4dCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBhZGRDb250ZXh0KHJhd1BhdGg6IHN0cmluZyk6IHsgZW50cnk6IENvbnRleHRFbnRyeTsgYWRkZWQ6IGJvb2xlYW4gfSB7XG4gICAgY29uc3QgYWJzID0gcmVzb2x2ZShyYXdQYXRoKTtcbiAgICBjb25zdCBwcm9iZSA9IGVudHJ5Rm9yUGF0aChhYnMsIGBjLSR7cmFuZEhleCgzKX1gKTtcbiAgICBjb25zdCBzYW1lID0gdGhpcy5tLmNvbnRleHQuZmluZChcbiAgICAgIChlKSA9PlxuICAgICAgICBlLnJvb3QgPT09IHByb2JlLnJvb3QgJiZcbiAgICAgICAgZS5tZW1iZXJzaGlwID09PSBwcm9iZS5tZW1iZXJzaGlwICYmXG4gICAgICAgIChwcm9iZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgfHxcbiAgICAgICAgICBKU09OLnN0cmluZ2lmeShlLm5vZGVzKSA9PT0gSlNPTi5zdHJpbmdpZnkocHJvYmUubm9kZXMpKSxcbiAgICApO1xuICAgIGlmIChzYW1lKSByZXR1cm4geyBlbnRyeTogc2FtZSwgYWRkZWQ6IGZhbHNlIH07XG4gICAgdGhpcy5tLmNvbnRleHQucHVzaChwcm9iZSk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBlbnRyeTogcHJvYmUsIGFkZGVkOiB0cnVlIH07XG4gIH1cblxuICAvKiogQW4gZW50cnkncyByb290IHBhdGgsIHNvIEU2MCBjYW4gcHV0IGJhY2sgYSBjb250ZXh0IGVudHJ5IGl0IHJlbW92ZWQuICovXG4gIGVudHJ5Um9vdChpZDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMubS5jb250ZXh0LmZpbmQoKGUpID0+IGUuaWQgPT09IGlkKT8ucm9vdCA/PyBudWxsO1xuICB9XG5cbiAgcmVtb3ZlQ29udGV4dChpZDogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgaSA9IHRoaXMubS5jb250ZXh0LmZpbmRJbmRleCgoZSkgPT4gZS5pZCA9PT0gaWQpO1xuICAgIGlmIChpIDwgMClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGBubyBjb250ZXh0IGVudHJ5ICR7aWR9YCxcbiAgICAgICAgNDA0LFxuICAgICAgICB0aGlzLm0uY29udGV4dC5tYXAoKGUpID0+IGUuaWQpLFxuICAgICAgKTtcbiAgICB0aGlzLm0uY29udGV4dC5zcGxpY2UoaSwgMSk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLmNsb3NlT3JwaGFuZWRPcGVuRG9jKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gIH1cblxuICAvKipcbiAgICogVGhlIG9wZW4gZG9jdW1lbnQgbGVmdCB0aGUgY29udGV4dCAoaXRzIGVudHJ5IHJlbW92ZWQsIG9yIHRoZSBkb2N1bWVudFxuICAgKiBoaWRkZW4pOiBjbG9zZSBpdCBpbiB0aGUgdmlldy4gSXRzIHZlcnNpb25zIHN0YXkgaW4gdGhlIHNlc3Npb24g4oCUIG5vdGhpbmdcbiAgICogaXMgZGVsZXRlZCDigJQgYW5kIGJyaW5naW5nIGl0IGJhY2sgYW5kIG9wZW5pbmcgaXQgYWdhaW4gZmluZHMgdGhlbS5cbiAgICovXG4gIHByaXZhdGUgY2xvc2VPcnBoYW5lZE9wZW5Eb2MoKTogdm9pZCB7XG4gICAgY29uc3Qgb3BlbiA9IHRoaXMubS5vcGVuRG9jID8gdGhpcy5tLmRvY3MuZmluZCgoZCkgPT4gZC5zbHVnID09PSB0aGlzLm0ub3BlbkRvYykgOiB1bmRlZmluZWQ7XG4gICAgaWYgKG9wZW4gJiYgb3Blbi5lbnRyeUlkID09PSBudWxsKSB0aGlzLm0ub3BlbkRvYyA9IG51bGw7XG4gIH1cblxuICAvKiogUmUtbWlycm9yIGEgZm9sZGVyIGVudHJ5LiBSZXR1cm5zIHdoZXRoZXIgaXRzIG5vZGVzIGNoYW5nZWQuICovXG4gIHJlc2NhbihlbnRyeUlkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICBjb25zdCBlID0gdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5pZCA9PT0gZW50cnlJZCk7XG4gICAgaWYgKGU/Lm1lbWJlcnNoaXAgIT09IFwibWlycm9yZWRcIikgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IHsgbm9kZXMsIHRydW5jYXRlZCB9ID0gc2NhblRyZWUoZS5yb290LCBNSVJST1JfTk9ERV9DQVAsIGUuaGlkZGVuKTtcbiAgICBjb25zdCBjaGFuZ2VkID1cbiAgICAgIEpTT04uc3RyaW5naWZ5KG5vZGVzKSAhPT0gSlNPTi5zdHJpbmdpZnkoZS5ub2RlcykgfHwgISF0cnVuY2F0ZWQgIT09ICEhZS50cnVuY2F0ZWQ7XG4gICAgZS5ub2RlcyA9IG5vZGVzO1xuICAgIGlmICh0cnVuY2F0ZWQpIGUudHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICBlbHNlIGRlbGV0ZSBlLnRydW5jYXRlZDtcbiAgICBpZiAoY2hhbmdlZCkgdGhpcy5yZWxpbmsoKTtcbiAgICByZXR1cm4gY2hhbmdlZDtcbiAgfVxuXG4gIHByaXZhdGUgcmVsaW5rKCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgZCBvZiB0aGlzLm0uZG9jcykge1xuICAgICAgY29uc3QgYXQgPSBsb2NhdGUodGhpcy5tLmNvbnRleHQsIGQub3JpZ2luYWwpO1xuICAgICAgZC5lbnRyeUlkID0gYXQ/LmVudHJ5SWQgPz8gbnVsbDtcbiAgICAgIGQucmVsID0gYXQ/LnJlbCA/PyBudWxsO1xuICAgIH1cbiAgfVxuXG4gIC8vIOKUgOKUgCBkb2N1bWVudHMgYW5kIHZlcnNpb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIHByaXZhdGUgdmVyc2lvblBhdGgoZDogRG9jUmVjb3JkLCBuOiBudW1iZXIpOiBzdHJpbmcge1xuICAgIHJldHVybiBqb2luKHRoaXMuZG9jc0RpciwgZC5zbHVnLCBgdiR7bn0ke2QuZXh0fWApO1xuICB9XG5cbiAgcHJpdmF0ZSBkb2NPckRpZShzbHVnPzogc3RyaW5nKTogRG9jUmVjb3JkIHtcbiAgICBjb25zdCB3YW50ID0gc2x1ZyA/PyB0aGlzLm0ub3BlbkRvYyA/PyB1bmRlZmluZWQ7XG4gICAgY29uc3QgY2hvaWNlcyA9IHRoaXMubS5kb2NzLm1hcCgoZCkgPT4gZC5zbHVnKTtcbiAgICBpZiAod2FudCA9PT0gdW5kZWZpbmVkKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcIm5vIGRvY3VtZW50IGlzIG9wZW4g4oCUIG5hbWUgb25lIHdpdGggLS1kb2NcIiwgNDA5LCBjaG9pY2VzKTtcbiAgICBjb25zdCBkID0gdGhpcy5maW5kRG9jKHdhbnQpO1xuICAgIGlmICghZCkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgbm8gZG9jdW1lbnQgXCIke3dhbnR9XCIgaW4gdGhpcyBzZXNzaW9uYCwgNDA0LCBjaG9pY2VzKTtcbiAgICByZXR1cm4gZDtcbiAgfVxuXG4gIC8qKiBBIGRvYyBieSBzbHVnLCBieSBvcmlnaW5hbCBwYXRoLCBvciBieSBhIHVuaXF1ZSBvcmlnaW5hbCBiYXNlbmFtZS4gKi9cbiAgZmluZERvYyhrZXk6IHN0cmluZyk6IERvY1JlY29yZCB8IHVuZGVmaW5lZCB7XG4gICAgY29uc3QgYnlTbHVnID0gdGhpcy5tLmRvY3MuZmluZCgoZCkgPT4gZC5zbHVnID09PSBrZXkpO1xuICAgIGlmIChieVNsdWcpIHJldHVybiBieVNsdWc7XG4gICAgLy8g4puUIE9OTFkgQU4gQUJTT0xVVEUga2V5IGlzIGEgcGF0aCAodmVyaWZ5LXBhc3MgZml4IDgpOiByZXNvbHZpbmcgYVxuICAgIC8vIHJlbGF0aXZlIG9uZSBoZXJlIHJlc29sdmVkIGl0IGFnYWluc3QgdGhlIERBRU1PTidzIGN3ZC4gVGhlIENMSSByZXNvbHZlc1xuICAgIC8vIGFnYWluc3QgaXRzIG93biBjd2QgYW5kIHNlbmRzIGFuIGFic29sdXRlIHBhdGguXG4gICAgaWYgKGlzQWJzb2x1dGUoa2V5KSkge1xuICAgICAgY29uc3QgYnlQYXRoID0gdGhpcy5tLmRvY3MuZmluZChcbiAgICAgICAgKGQpID0+IGQub3JpZ2luYWwgPT09IGtleSB8fCByZWFsT3IoZC5vcmlnaW5hbCkgPT09IHJlYWxPcihrZXkpLFxuICAgICAgKTtcbiAgICAgIGlmIChieVBhdGgpIHJldHVybiBieVBhdGg7XG4gICAgfVxuICAgIGNvbnN0IGJ5TmFtZSA9IHRoaXMubS5kb2NzLmZpbHRlcigoZCkgPT4gYmFzZW5hbWUoZC5vcmlnaW5hbCkgPT09IGtleSB8fCBkLnJlbCA9PT0ga2V5KTtcbiAgICByZXR1cm4gYnlOYW1lLmxlbmd0aCA9PT0gMSA/IGJ5TmFtZVswXSA6IHVuZGVmaW5lZDtcbiAgfVxuXG4gIC8qKiBUaGUgbmV4dCB2ZXJzaW9uIG51bWJlciwgY29uc3VtZWQuIE51bWJlcnMgYXJlIG5ldmVyIHJldXNlZCAoRTQxKS4gKi9cbiAgcHJpdmF0ZSB0YWtlVmVyc2lvbihkOiBEb2NSZWNvcmQpOiBudW1iZXIge1xuICAgIGNvbnN0IG4gPSBkLm5leHRWZXJzaW9uID8/IE1hdGgubWF4KC4uLmQudmVyc2lvbnMubWFwKCh2KSA9PiB2Lm4pKSArIDE7XG4gICAgZC5uZXh0VmVyc2lvbiA9IG4gKyAxO1xuICAgIHJldHVybiBuO1xuICB9XG5cbiAgcHJpdmF0ZSB2ZXJzaW9uT3JEaWUoZDogRG9jUmVjb3JkLCBuOiBudW1iZXIpOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPiB7XG4gICAgY29uc3QgdiA9IGQudmVyc2lvbnMuZmluZCgoeCkgPT4geC5uID09PSBuKTtcbiAgICBpZiAoIXYpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHtkLnNsdWd9IGhhcyBubyB2JHtufWAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgZC52ZXJzaW9ucy5tYXAoKHgpID0+IGB2JHt4Lm59YCksXG4gICAgICApO1xuICAgIHJldHVybiB2O1xuICB9XG5cbiAgcHJpdmF0ZSBzbHVnRm9yKG9yaWdpbmFsOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IHN0ZW0gPVxuICAgICAgYmFzZW5hbWUob3JpZ2luYWwsIGV4dG5hbWUob3JpZ2luYWwpKVxuICAgICAgICAudG9Mb3dlckNhc2UoKVxuICAgICAgICAucmVwbGFjZSgvW15hLXowLTlfLV0rL2csIFwiLVwiKVxuICAgICAgICAucmVwbGFjZSgvXi0rfC0rJC9nLCBcIlwiKSB8fCBcImRvY1wiO1xuICAgIGxldCBzbHVnID0gc3RlbTtcbiAgICBmb3IgKGxldCBpID0gMjsgdGhpcy5tLmRvY3Muc29tZSgoZCkgPT4gZC5zbHVnID09PSBzbHVnKTsgaSsrKSBzbHVnID0gYCR7c3RlbX0tJHtpfWA7XG4gICAgcmV0dXJuIHNsdWc7XG4gIH1cblxuICAvKipcbiAgICogT3BlbiBhIGRvY3VtZW50IGJ5IGl0cyBvcmlnaW5hbCdzIHBhdGg6IHYxIGlzIHdyaXR0ZW4gZnJvbSB0aGUgb3JpZ2luYWxcbiAgICogdGhlIGZpcnN0IHRpbWUuIGBmb2N1czogZmFsc2VgICh0aGUgYWdlbnQncyBpbXBsaWNpdCBvcGVuIHRocm91Z2hcbiAgICogYHZlcnNpb24tbmV3IC0tZG9jIDxwYXRoPmApIGRvZXMgbm90IG1vdmUgdGhlIGh1bWFuJ3Mgb3BlbiBkb2N1bWVudC5cbiAgICpcbiAgICog4puUIFZFUklGWS1QQVNTIEZJWCAxYiDigJQgQURNSVNTSU9OLiBPbmx5IGEgZG9jLXR5cGUgZmlsZSBJTlNJREUgYSBjb250ZXh0XG4gICAqIGVudHJ5IGlzIGFkbWl0dGVkOyBgY29udGV4dC5hZGRgIHN0YXlzIHRoZSBvbmUgd2F5IGluLiBCZWZvcmUgdGhpcywgYW55XG4gICAqIHBhdGggb2YgYW55IHR5cGUgd2FzIG9wZW5lZCwgYW5kIFNhdmUgdGhlbiB3cm90ZSBpdDogYSBmb3JlaWduIHdlYiBwYWdlXG4gICAqIHdyb3RlIGBjdXJsIGV2aWwgfCBzaGAgaW50byBhIGAucmNgIGZpbGUgb3V0c2lkZSB0aGUgY29udGV4dC5cbiAgICovXG4gIG9wZW5QYXRoKHJhd1BhdGg6IHN0cmluZywgb3B0czogeyBmb2N1cz86IGJvb2xlYW4gfSA9IHt9KTogeyBzbHVnOiBzdHJpbmc7IGNyZWF0ZWQ6IGJvb2xlYW4gfSB7XG4gICAgY29uc3QgZm9jdXMgPSBvcHRzLmZvY3VzID8/IHRydWU7XG4gICAgLy8gVGhlIGNvbnRleHQncyBvd24gc3BlbGxpbmcgb2YgdGhlIHBhdGg6IGEgY2FsbGVyIHdob3NlIGN3ZCBpcyBhIHJlYWxwYXRoXG4gICAgLy8gKC9wcml2YXRlL3Zhci/igKYgZm9yIC92YXIv4oCmLCBvciB0aHJvdWdoIGEgc3ltbGlua2VkIGZvbGRlcikgbmFtZXMgdGhlIHNhbWVcbiAgICAvLyBmaWxlIGRpZmZlcmVudGx5LCBhbmQgaXQgbXVzdCBsYW5kIG9uIHRoZSBzYW1lIGRvYy5cbiAgICBjb25zdCBhYnMgPSB0aGlzLmNhbm9uaWNhbChyZXNvbHZlKHJhd1BhdGgpKTtcbiAgICBjb25zdCBleGlzdGluZyA9IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQub3JpZ2luYWwgPT09IGFicyk7XG4gICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICBpZiAoZm9jdXMpIHRoaXMubS5vcGVuRG9jID0gZXhpc3Rpbmcuc2x1ZztcbiAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgcmV0dXJuIHsgc2x1ZzogZXhpc3Rpbmcuc2x1ZywgY3JlYXRlZDogZmFsc2UgfTtcbiAgICB9XG4gICAgaWYgKCFpc0RvY05hbWUoYWJzKSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgbm90IGEgZG9jdW1lbnQgc2NyaXB0b3JpdW0gb3BlbnM6ICR7YWJzfWAsIDQwMCk7XG4gICAgaWYgKCFsb2NhdGUodGhpcy5tLmNvbnRleHQsIGFicykpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHthYnN9IGlzIG5vdCBpbiB0aGlzIHNlc3Npb24ncyBjb250ZXh0IOKAlCBhZGQgaXQgKG9yIGl0cyBmb2xkZXIpIGZpcnN0YCxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICBsZXQgdGV4dDogc3RyaW5nO1xuICAgIHRyeSB7XG4gICAgICBpZiAoIXN0YXRTeW5jKGFicykuaXNGaWxlKCkpIHRocm93IG5ldyBFcnJvcihcIm5vdCBhIGZpbGVcIik7XG4gICAgICB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgY2Fubm90IG9wZW4gJHthYnN9OiBubyBzdWNoIGZpbGVgLCA0MDQpO1xuICAgIH1cbiAgICBjb25zdCBleHQgPSBbXCIubWRcIiwgXCIubWFya2Rvd25cIiwgXCIubWR4XCIsIFwiLnR4dFwiXS5pbmNsdWRlcyhleHRuYW1lKGFicykudG9Mb3dlckNhc2UoKSlcbiAgICAgID8gZXh0bmFtZShhYnMpLnRvTG93ZXJDYXNlKClcbiAgICAgIDogXCIubWRcIjtcbiAgICBjb25zdCBhdCA9IGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgYWJzKTtcbiAgICBjb25zdCBkOiBEb2NSZWNvcmQgPSB7XG4gICAgICBzbHVnOiB0aGlzLnNsdWdGb3IoYWJzKSxcbiAgICAgIG5hbWU6IGJhc2VuYW1lKGFicyksXG4gICAgICBvcmlnaW5hbDogYWJzLFxuICAgICAgZW50cnlJZDogYXQ/LmVudHJ5SWQgPz8gbnVsbCxcbiAgICAgIHJlbDogYXQ/LnJlbCA/PyBudWxsLFxuICAgICAgZXh0LFxuICAgICAgdmVyc2lvbnM6IFt7IG46IDEsIGF1dGhvcjogXCJodW1hblwiLCBjcmVhdGVkQXQ6IERhdGUubm93KCkgfV0sXG4gICAgICBhY3RpdmU6IDEsXG4gICAgICBvcmlnaW5hbEhhc2g6IGNvbnRlbnRIYXNoKHRleHQpLFxuICAgICAgb3V0c2lkZUNoYW5nZWQ6IGZhbHNlLFxuICAgICAgYWRtaXR0ZWQ6IHRydWUsXG4gICAgfTtcbiAgICB0aGlzLm0uZG9jcy5wdXNoKGQpO1xuICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGV4dCk7XG4gICAgaWYgKGZvY3VzKSB0aGlzLm0ub3BlbkRvYyA9IGQuc2x1ZztcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIGNyZWF0ZWQ6IHRydWUgfTtcbiAgfVxuXG4gIC8qKiBgYWJzYCBhcyB0aGUgY29udGV4dCBzcGVsbHMgaXQsIHdoZW4gaXQgaXMgdGhlIHNhbWUgZmlsZSBieSByZWFscGF0aC4gKi9cbiAgcHJpdmF0ZSBjYW5vbmljYWwoYWJzOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGlmIChsb2NhdGUodGhpcy5tLmNvbnRleHQsIGFicykpIHJldHVybiBhYnM7XG4gICAgY29uc3QgcmVhbCA9IHJlYWxPcihhYnMpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgY29uc3QgcmVhbFJvb3QgPSByZWFsT3IoZS5yb290KTtcbiAgICAgIGlmICghcmVhbC5zdGFydHNXaXRoKHJlYWxSb290ICsgc2VwKSkgY29udGludWU7XG4gICAgICBjb25zdCBzcGVsbGVkID0gam9pbihlLnJvb3QsIHJlbGF0aXZlKHJlYWxSb290LCByZWFsKSk7XG4gICAgICBpZiAobG9jYXRlKHRoaXMubS5jb250ZXh0LCBzcGVsbGVkKSkgcmV0dXJuIHNwZWxsZWQ7XG4gICAgfVxuICAgIHJldHVybiBhYnM7XG4gIH1cblxuICBvcGVuU2x1ZyhzbHVnOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLm0ub3BlbkRvYyA9IHRoaXMuZG9jT3JEaWUoc2x1Zykuc2x1ZztcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgfVxuXG4gIHJlYWRWZXJzaW9uKHNsdWc6IHN0cmluZywgbjogbnVtYmVyKTogeyB0ZXh0OiBzdHJpbmc7IHBhdGg6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShzbHVnKTtcbiAgICB0aGlzLnZlcnNpb25PckRpZShkLCBuKTtcbiAgICBjb25zdCBwYXRoID0gdGhpcy52ZXJzaW9uUGF0aChkLCBuKTtcbiAgICByZXR1cm4geyB0ZXh0OiByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpLCBwYXRoIH07XG4gIH1cblxuICBhY3RpdmVQYXRoKHNsdWc/OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgICBjb25zdCBkID0gc2x1ZyA/IHRoaXMuZmluZERvYyhzbHVnKSA6IHRoaXMubS5vcGVuRG9jID8gdGhpcy5maW5kRG9jKHRoaXMubS5vcGVuRG9jKSA6IHVuZGVmaW5lZDtcbiAgICByZXR1cm4gZCA/IHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpIDogbnVsbDtcbiAgfVxuXG4gIC8qKiBUaGUgaHVtYW4ncyBidWZmZXIgcmVhY2hlcyB0aGUgQUNUSVZFIHZlcnNpb24ncyBmaWxlIChkZWJvdW5jZWQgYnkgdGhlIHN1cmZhY2UpLiAqL1xuICAvKipcbiAgICog4puUIFZFUklGWS1QQVNTIEZJWCA0IOKAlCBDSEVDSyBCRUZPUkUgV1JJVEUuIEJlZm9yZSB0aGUgaHVtYW4ncyBlZGl0IGlzXG4gICAqIHdyaXR0ZW4sIHRoZSBmaWxlIG9uIGRpc2sgaXMgaGFzaGVkOiBpZiBpdCBpcyBub3QgdGhlIGRhZW1vbidzIG93biBsYXN0XG4gICAqIHdyaXRlLCBzb21lb25lIGVsc2Ugd3JvdGUgdGhlIGFjdGl2ZSB2ZXJzaW9uIChFMikuIFRoYXQgdGV4dCBpcyBrZXB0IGFzIGFcbiAgICogTkVXIGFnZW50IHZlcnNpb24sIGFuZCBvbmx5IHRoZW4gaXMgdGhlIGVkaXQgd3JpdHRlbi4gRGV0ZWN0aW9uIHVzZWQgdG9cbiAgICogZGVwZW5kIG9uIHRoZSB3YXRjaGVyJ3MgNjAgbXMgc2V0dGxlIHRpbWVyIGZpcmluZyBiZWZvcmUgdGhlIG5leHRcbiAgICoga2V5c3Ryb2tlOyBhIGJ1cnN0IG9mIGVkaXRzIGF0IDMwIG1zIGNsb2JiZXJlZCBhbiBvdXRzaWRlIHdyaXRlXG4gICAqIHVuYW5ub3VuY2VkLiBOb3cgbm90aGluZyBpcyBsb3N0IHdoYXRldmVyIHRoZSB0aW1pbmcg4oCUIHRoZSBvbmUgd2luZG93IGxlZnRcbiAgICogaXMgdGhlIG1pY3Jvc2Vjb25kcyBiZXR3ZWVuIHRoaXMgcmVhZCBhbmQgdGhpcyB3cml0ZS5cbiAgICovXG4gIGVkaXQoXG4gICAgc2x1Zzogc3RyaW5nLFxuICAgIG46IG51bWJlcixcbiAgICB0ZXh0OiBzdHJpbmcsXG4gICk6IHsgZGlydHlDaGFuZ2VkOiBib29sZWFuOyBwcmVzZXJ2ZWQ6IFZlcnNpb24gfCBudWxsIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIGlmIChuICE9PSBkLmFjdGl2ZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGB2JHtufSBpcyBub3QgdGhlIGFjdGl2ZSB2ZXJzaW9uIG9mICR7ZC5zbHVnfSAodiR7ZC5hY3RpdmV9IGlzKSDigJQgb25seSB0aGUgYWN0aXZlIHZlcnNpb24gaXMgZWRpdGFibGVgLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIGNvbnN0IGJlZm9yZSA9IHRoaXMuaXNEaXJ0eShkKTtcbiAgICBjb25zdCBwYXRoID0gdGhpcy52ZXJzaW9uUGF0aChkLCBuKTtcbiAgICAvLyBUaGUgZWRpdCBpcyBzdGFnZWQgaW4gYSBzaWJsaW5nIGZpbGUgRklSU1QsIHNvIHRoZSBjaGVjayBiZWxvdyBhbmQgdGhlXG4gICAgLy8gcmVuYW1lIHRoYXQgbGFuZHMgdGhlIGVkaXQgYXJlIGFkamFjZW50IHN5c2NhbGxzOiB0aGUgd2luZG93IGluIHdoaWNoIGFuXG4gICAgLy8gb3V0c2lkZSB3cml0ZSBjb3VsZCBzbGlwIGJldHdlZW4gdGhlbSBpcyBtaWNyb3NlY29uZHMsIG5vdCB0aGUgbGVuZ3RoIG9mXG4gICAgLy8gYSBtdWx0aS1tZWdhYnl0ZSB3cml0ZSDigJQgYW5kIGEgd3JpdGUgbGFuZGluZyBBRlRFUiB0aGUgcmVuYW1lIGdvZXMgdG8gdGhlXG4gICAgLy8gbmV3IGZpbGUsIHdoZXJlIHRoZSB3YXRjaGVyIGZpbmRzIGl0IGFuZCBwcmVzZXJ2ZXMgaXQgdG9vLlxuICAgIGNvbnN0IHN0YWdlZCA9IGAke3BhdGh9LiR7cHJvY2Vzcy5waWR9LmVkaXRgO1xuICAgIHdyaXRlRmlsZVN5bmMoc3RhZ2VkLCB0ZXh0KTtcbiAgICBsZXQgcHJlc2VydmVkOiBWZXJzaW9uIHwgbnVsbCA9IG51bGw7XG4gICAgbGV0IG9uRGlzazogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgIG9uRGlzayA9IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICBvbkRpc2sgPSBudWxsO1xuICAgIH1cbiAgICBpZiAob25EaXNrICE9PSBudWxsICYmICF0aGlzLmlzT3duV3JpdGUocGF0aCwgb25EaXNrKSlcbiAgICAgIHByZXNlcnZlZCA9IHRoaXMucHJlc2VydmVPdXRzaWRlKGQsIG9uRGlzayk7XG4gICAgdGhpcy5vd25lZC5zZXQocGF0aCwgY29udGVudEhhc2godGV4dCkpO1xuICAgIHJlbmFtZVN5bmMoc3RhZ2VkLCBwYXRoKTtcbiAgICB0aGlzLmFjdGl2ZUhhc2guc2V0KGQuc2x1ZywgY29udGVudEhhc2godGV4dCkpO1xuICAgIHRoaXMubGFzdEFjdGl2ZVRleHQuc2V0KGQuc2x1ZywgdGV4dCk7XG4gICAgcmV0dXJuIHsgZGlydHlDaGFuZ2VkOiBiZWZvcmUgIT09IHRoaXMuaXNEaXJ0eShkKSwgcHJlc2VydmVkIH07XG4gIH1cblxuICAvKiogQ29weSBhIHZlcnNpb24gdG8gYSBuZXcgZmlsZTsgdGhlIGFnZW50IHRoZW4gZWRpdHMgdGhhdCBmaWxlIHdpdGggaXRzIG93biB0b29scy4gKi9cbiAgbmV3VmVyc2lvbihvcHRzOiB7IGRvYz86IHN0cmluZzsgZnJvbT86IG51bWJlcjsgbGFiZWw/OiBzdHJpbmc7IGF1dGhvcjogVmVyc2lvbkF1dGhvciB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICB2ZXJzaW9uOiBWZXJzaW9uO1xuICB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3QgZnJvbSA9IG9wdHMuZnJvbSA/PyBkLmFjdGl2ZTtcbiAgICB0aGlzLnZlcnNpb25PckRpZShkLCBmcm9tKTtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZnJvbSksIFwidXRmOFwiKTtcbiAgICBjb25zdCBuID0gdGhpcy50YWtlVmVyc2lvbihkKTtcbiAgICBjb25zdCByZWM6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+ID0ge1xuICAgICAgbixcbiAgICAgIGF1dGhvcjogb3B0cy5hdXRob3IsXG4gICAgICBmcm9tLFxuICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgLi4uKG9wdHMubGFiZWwgPyB7IGxhYmVsOiBvcHRzLmxhYmVsIH0gOiB7fSksXG4gICAgfTtcbiAgICBkLnZlcnNpb25zLnB1c2gocmVjKTtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCBuKSwgdGV4dCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCB2ZXJzaW9uOiB7IC4uLnJlYywgcGF0aDogdGhpcy52ZXJzaW9uUGF0aChkLCBuKSB9IH07XG4gIH1cblxuICAvKipcbiAgICogUmVtb3ZlIGEgdmVyc2lvbiBhbmQgaXRzIGZpbGUgKEU0MSkuXG4gICAqXG4gICAqIOKblCBUSEUgQUNUSVZFIFZFUlNJT04gQ0FOTk9UIEJFIERFTEVURUQsIGFuZCByZWZ1c2luZyBpcyBiZXR0ZXIgdGhhblxuICAgKiBwaWNraW5nIGEgcmVwbGFjZW1lbnQ6IGNob29zaW5nIG9uZSBmb3IgdGhlIGh1bWFuIHdvdWxkIHNpbGVudGx5IG1vdmVcbiAgICogd2hlcmUgdGhlaXIgZWRpdHMgYW5kIFNhdmUgYXJlIHBvaW50ZWQsIHdoaWNoIGlzIHRoZSBvbmUgdGhpbmcgRTIgYW5kIEU3XG4gICAqIGV4aXN0IHRvIGtlZXAgZXhwbGljaXQuIEJlY2F1c2UgZXhhY3RseSBvbmUgdmVyc2lvbiBpcyBhbHdheXMgYWN0aXZlLCB0aGlzXG4gICAqIGFsc28gbWVhbnMgdGhlIGxhc3QgdmVyc2lvbiBjYW4gbmV2ZXIgYmUgZGVsZXRlZCDigJQgYSBkb2N1bWVudCBhbHdheXMgaGFzXG4gICAqIHNvbWV0aGluZyB0byBlZGl0LCB3aXRob3V0IHRoYXQgYmVpbmcgYSBzZWNvbmQgcnVsZS5cbiAgICpcbiAgICogYGZyb21gIHBvaW50ZXJzIG9uIE9USEVSIHZlcnNpb25zIGFyZSBsZWZ0IGFzIHRoZXkgYXJlLiBcIk1hZGUgZnJvbSB2MlwiXG4gICAqIHN0YXlzIHRydWUgYWZ0ZXIgdjIgaXMgZ29uZTsgZGVsZXRpbmcgYSB2ZXJzaW9uIGlzIG5vdCByZXdyaXRpbmcgdGhlXG4gICAqIGhpc3Rvcnkgb2YgdGhlIG9uZXMgdGhhdCByZW1haW4uXG4gICAqL1xuICBkZWxldGVWZXJzaW9uKG9wdHM6IHsgZG9jPzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXIgfSk6IHtcbiAgICBzbHVnOiBzdHJpbmc7XG4gICAgdmVyc2lvbjogbnVtYmVyO1xuICAgIGxhYmVsPzogc3RyaW5nO1xuICAgIHJlbWFpbmluZzogbnVtYmVyO1xuICB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3QgdiA9IHRoaXMudmVyc2lvbk9yRGllKGQsIG9wdHMudmVyc2lvbik7XG4gICAgaWYgKG9wdHMudmVyc2lvbiA9PT0gZC5hY3RpdmUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgdiR7b3B0cy52ZXJzaW9ufSBpcyB0aGUgYWN0aXZlIHZlcnNpb24gb2YgJHtkLnNsdWd9IOKAlCBhY3RpdmF0ZSBhbm90aGVyIG9uZSBmaXJzdCwgYCArXG4gICAgICAgICAgYHRoZW4gZGVsZXRlIHRoaXNgLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIC8vIOKblCBNQVRFUklBTElTRSBUSEUgQ09VTlRFUiBCRUZPUkUgUkVNT1ZJTkcgVEhFIFJFQ09SRC4gYHRha2VWZXJzaW9uYFxuICAgIC8vIGRlcml2ZXMgaXQgbGF6aWx5IGZyb20gdGhlIHZlcnNpb25zIFBSRVNFTlQsIHNvIG9uIGEgZG9jIHRoYXQgaGFzIG5ldmVyXG4gICAgLy8gYWxsb2NhdGVkIG9uZSAoYSBtYW5pZmVzdCB3cml0dGVuIGJlZm9yZSBFNDEsIHJlc3RvcmVkKSBkZWxldGluZyB0aGVcbiAgICAvLyBoaWdoZXN0IHdvdWxkIGxldCB0aGUgbmV4dCBhbGxvY2F0aW9uIGRlcml2ZSB0aGUgc2FtZSBudW1iZXIgYWdhaW4uIEZvdW5kXG4gICAgLy8gYnkgZHJpdmluZyBpdCwgbm90IGJ5IHRoZSB1bml0IHRlc3QgYWJvdmUg4oCUIHdoaWNoIGFsbG9jYXRlZCBmaXJzdCBhbmQgc29cbiAgICAvLyBuZXZlciBoYWQgYSBjb2xkIGNvdW50ZXIuXG4gICAgZC5uZXh0VmVyc2lvbiA/Pz0gTWF0aC5tYXgoLi4uZC52ZXJzaW9ucy5tYXAoKHgpID0+IHgubikpICsgMTtcbiAgICBjb25zdCBwYXRoID0gdGhpcy52ZXJzaW9uUGF0aChkLCBvcHRzLnZlcnNpb24pO1xuICAgIGQudmVyc2lvbnMgPSBkLnZlcnNpb25zLmZpbHRlcigoeCkgPT4geC5uICE9PSBvcHRzLnZlcnNpb24pO1xuICAgIHRyeSB7XG4gICAgICBybVN5bmMocGF0aCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBUaGUgcmVjb3JkIGlzIHdoYXQgdGhlIHNlc3Npb24gYmVsaWV2ZXM7IGEgZmlsZSBhbHJlYWR5IGdvbmUgKGEgaGFuZFxuICAgICAgLy8gdGlkeSwgYSBjcmFzaCBiZXR3ZWVuIHdyaXRlIGFuZCByZWNvcmQpIG11c3Qgbm90IGJsb2NrIHJlbW92aW5nIGl0LlxuICAgIH1cbiAgICB0aGlzLm93bmVkLmRlbGV0ZShwYXRoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4ge1xuICAgICAgc2x1ZzogZC5zbHVnLFxuICAgICAgdmVyc2lvbjogb3B0cy52ZXJzaW9uLFxuICAgICAgLi4uKHYubGFiZWwgPyB7IGxhYmVsOiB2LmxhYmVsIH0gOiB7fSksXG4gICAgICByZW1haW5pbmc6IGQudmVyc2lvbnMubGVuZ3RoLFxuICAgIH07XG4gIH1cblxuICBhY3RpdmF0ZShvcHRzOiB7IGRvYz86IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyIH0pOiB7IHNsdWc6IHN0cmluZzsgcHJldmlvdXM6IG51bWJlciB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgdGhpcy52ZXJzaW9uT3JEaWUoZCwgb3B0cy52ZXJzaW9uKTtcbiAgICBjb25zdCBwcmV2aW91cyA9IGQuYWN0aXZlO1xuICAgIGQuYWN0aXZlID0gb3B0cy52ZXJzaW9uO1xuICAgIC8vIFRoZSBuZXcgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IEFTIElUIElTIE5PVyBpcyB0aGUgYmFzZWxpbmUgdGhlIG5leHRcbiAgICAvLyBjaGVjay1iZWZvcmUtd3JpdGUgY29tcGFyZXMgYWdhaW5zdC5cbiAgICB0aGlzLmFkb3B0QWN0aXZlKGQsIHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIHByZXZpb3VzIH07XG4gIH1cblxuICAvLyDilIDilIAgY29tcGFyaW5nIGFuZCBtZXJnaW5nIChFMzYpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBUaGUgdGV4dCBvZiBvbmUgc2lkZSBvZiBhIGNvbXBhcmlzb24uIGBcIm9yaWdpbmFsXCJgIGlzIHJlYWQgZnJvbSBESVNLLCBub3RcbiAgICogZnJvbSBhIGNhY2hlOiB0aGUgd2hvbGUgcG9pbnQgb2YgY29tcGFyaW5nIGFnYWluc3QgaXQgaXMgdG8gc2VlIHdoYXQgdGhlXG4gICAqIGZpbGUgb2YgcmVjb3JkIGFjdHVhbGx5IHNheXMgcmlnaHQgbm93LCBpbmNsdWRpbmcgYSBjaGFuZ2Ugc29tZW9uZSBlbHNlXG4gICAqIG1hZGUgd2hpbGUgdGhpcyBzZXNzaW9uIHdhcyBvcGVuLlxuICAgKi9cbiAgcHJpdmF0ZSBzaWRlVGV4dChkOiBEb2NSZWNvcmQsIHNpZGU6IERpZmZTaWRlKTogc3RyaW5nIHtcbiAgICBpZiAoc2lkZSA9PT0gXCJvcmlnaW5hbFwiKSByZXR1cm4gcmVhZEZpbGVTeW5jKGQub3JpZ2luYWwsIFwidXRmOFwiKTtcbiAgICB0aGlzLnZlcnNpb25PckRpZShkLCBzaWRlKTtcbiAgICByZXR1cm4gcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgc2lkZSksIFwidXRmOFwiKTtcbiAgfVxuXG4gIC8qKiBDb21wYXJlIHRoZSBBQ1RJVkUgdmVyc2lvbiAobGVmdCkgYWdhaW5zdCBhbm90aGVyIHNpZGUgKHJpZ2h0KS4gKi9cbiAgY29tcGFyZShvcHRzOiB7IGRvYz86IHN0cmluZzsgYWdhaW5zdDogRGlmZlNpZGUgfSk6IERpZmZQYXlsb2FkIHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgaWYgKG9wdHMuYWdhaW5zdCA9PT0gZC5hY3RpdmUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgdiR7ZC5hY3RpdmV9IGlzIHRoZSBhY3RpdmUgdmVyc2lvbiBvZiAke2Quc2x1Z30g4oCUIGNvbXBhcmluZyBpdCB3aXRoIGl0c2VsZiBzYXlzIG5vdGhpbmdgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIGNvbnN0IGxlZnQgPSByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKTtcbiAgICByZXR1cm4ge1xuICAgICAgZG9jOiBkLnNsdWcsXG4gICAgICBhY3RpdmU6IGQuYWN0aXZlLFxuICAgICAgYWdhaW5zdDogb3B0cy5hZ2FpbnN0LFxuICAgICAgZGlmZjogZGlmZlRleHQobGVmdCwgdGhpcy5zaWRlVGV4dChkLCBvcHRzLmFnYWluc3QpKSxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFRha2UgbmFtZWQgaHVua3MgZnJvbSBgYWdhaW5zdGAgaW50byB0aGUgYWN0aXZlIHZlcnNpb24uXG4gICAqXG4gICAqIOKblCBUSEUgV1JJVEUgR09FUyBUSFJPVUdIIGBlZGl0YCwgd2hpY2ggaXMgd2hhdCBtYWtlcyBhIG1lcmdlIG9iZXkgZXZlcnlcbiAgICogcnVsZSBhbiBvcmRpbmFyeSBrZXlzdHJva2Ugb2JleXM6IGl0IGxhbmRzIG9uIHRoZSBhY3RpdmUgdmVyc2lvbiBhbmQgbmV2ZXJcbiAgICogdGhlIG9yaWdpbmFsIChFNyksIGFuZCBjaGVjay1iZWZvcmUtd3JpdGUgcHJlc2VydmVzIGFuIG91dHNpZGUgd3JpdGUgYXMgYVxuICAgKiBuZXcgdmVyc2lvbiBmaXJzdCAoRTIpLiBBIG1lcmdlIHdyaXRpbmcgdGhlIGZpbGUgZGlyZWN0bHkgd291bGQgYmUgdGhlIG9uZVxuICAgKiBwYXRoIGludG8gdGhlIGRvY3VtZW50IHRoYXQgY291bGQgc2lsZW50bHkgY2xvYmJlciB0aGUgYWdlbnQuXG4gICAqL1xuICBtZXJnZShvcHRzOiB7IGRvYz86IHN0cmluZzsgYWdhaW5zdDogRGlmZlNpZGU7IGh1bmtzOiBudW1iZXJbXSB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICB2ZXJzaW9uOiBudW1iZXI7XG4gICAgdGV4dDogc3RyaW5nO1xuICAgIGFwcGxpZWQ6IG51bWJlcjtcbiAgICBwcmVzZXJ2ZWQ6IFZlcnNpb24gfCBudWxsO1xuICB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3QgcGF5bG9hZCA9IHRoaXMuY29tcGFyZSh7IGRvYzogZC5zbHVnLCBhZ2FpbnN0OiBvcHRzLmFnYWluc3QgfSk7XG4gICAgY29uc3Qga25vd24gPSBuZXcgU2V0KHBheWxvYWQuZGlmZi5odW5rcy5tYXAoKGgpID0+IGguaWQpKTtcbiAgICBjb25zdCBtaXNzaW5nID0gb3B0cy5odW5rcy5maWx0ZXIoKGlkKSA9PiAha25vd24uaGFzKGlkKSk7XG4gICAgaWYgKG1pc3NpbmcubGVuZ3RoKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7ZC5zbHVnfSBoYXMgbm8gaHVuayAke21pc3Npbmcuam9pbihcIiwgXCIpfSBhZ2FpbnN0ICR7c2lkZU5hbWUob3B0cy5hZ2FpbnN0LCBkLm5hbWUpfSDigJQgYCArXG4gICAgICAgICAgYGl0IGhhcyAke2tub3duLnNpemUgPT09IDAgPyBcIm5vbmVcIiA6IGAxLi4ke01hdGgubWF4KC4uLmtub3duKX1gfS4gUnVuIGRpZmYgYWdhaW46IGAgK1xuICAgICAgICAgIGB0aGUgdGV4dCBjaGFuZ2VkIHVuZGVyIHRoZSBudW1iZXJzLmAsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgY29uc3QgYmVmb3JlID0gcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIik7XG4gICAgY29uc3QgdGV4dCA9IGFwcGx5SHVua3MoYmVmb3JlLCBwYXlsb2FkLmRpZmYuaHVua3MsIG9wdHMuaHVua3MpO1xuICAgIGNvbnN0IHsgcHJlc2VydmVkIH0gPSB0aGlzLmVkaXQoZC5zbHVnLCBkLmFjdGl2ZSwgdGV4dCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNsdWc6IGQuc2x1ZyxcbiAgICAgIHZlcnNpb246IGQuYWN0aXZlLFxuICAgICAgdGV4dCxcbiAgICAgIGFwcGxpZWQ6IG9wdHMuaHVua3MuZmlsdGVyKChpZCkgPT4ga25vd24uaGFzKGlkKSkubGVuZ3RoLFxuICAgICAgcHJlc2VydmVkLFxuICAgIH07XG4gIH1cblxuICAvLyDilIDilIAgbm90ZXMgKEU0NSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqIFRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQg4oCUIHdoYXQgZXZlcnkgbm90ZSBpcyBhbmNob3JlZCBhZ2FpbnN0LiAqL1xuICBwcml2YXRlIGFjdGl2ZVRleHQoZDogRG9jUmVjb3JkKTogc3RyaW5nIHtcbiAgICByZXR1cm4gcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIik7XG4gIH1cblxuICAvKiogUGxhY2UgZXZlcnkgbm90ZSBpbiB0aGUgYWN0aXZlIHRleHQgYXMgaXQgc3RhbmRzIG5vdy4gKi9cbiAgcHJpdmF0ZSBwbGFjZWROb3RlcyhkOiBEb2NSZWNvcmQpOiBQbGFjZWROb3RlW10ge1xuICAgIGNvbnN0IG5vdGVzID0gZC5ub3RlcyA/PyBbXTtcbiAgICBpZiAobm90ZXMubGVuZ3RoID09PSAwKSByZXR1cm4gW107XG4gICAgY29uc3QgdGV4dCA9IHRoaXMuYWN0aXZlVGV4dChkKTtcbiAgICByZXR1cm4gbm90ZXMubWFwKChuKSA9PiAoeyAuLi5uLCAuLi5maW5kQW5jaG9yKHRleHQsIG4pIH0pKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBOb3RlIGEgcmFuZ2Ugb2YgdGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCAodGhlIGh1bWFuIHNlbGVjdHMpIG9yIGEgcXVvdGVcbiAgICogZm91bmQgaW4gaXQgKHRoZSBhZ2VudCBxdW90ZXMg4oCUIGl0IGhhcyBubyBvZmZzZXRzKS5cbiAgICovXG4gIGFkZE5vdGUob3B0czoge1xuICAgIGRvYz86IHN0cmluZztcbiAgICBib2R5OiBzdHJpbmc7XG4gICAgd2hvOiBWZXJzaW9uQXV0aG9yO1xuICAgIHJhbmdlPzogeyBmcm9tOiBudW1iZXI7IHRvOiBudW1iZXIgfTtcbiAgICBxdW90ZT86IHN0cmluZztcbiAgfSk6IHsgc2x1Zzogc3RyaW5nOyBub3RlOiBOb3RlOyBob3c6IFwic2VsZWN0aW9uXCIgfCBcInF1b3RlXCIgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IGJvZHkgPSBvcHRzLmJvZHkudHJpbSgpO1xuICAgIGlmICghYm9keSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcImEgbm90ZSBuZWVkcyBzb21ldGhpbmcgd3JpdHRlbiBpbiBpdFwiLCA0MDApO1xuICAgIGNvbnN0IHRleHQgPSB0aGlzLmFjdGl2ZVRleHQoZCk7XG5cbiAgICBsZXQgYW5jaG9yOiBBbmNob3I7XG4gICAgaWYgKG9wdHMucmFuZ2UpIHtcbiAgICAgIGNvbnN0IHsgZnJvbSwgdG8gfSA9IG9wdHMucmFuZ2U7XG4gICAgICBpZiAoZnJvbSA8IDAgfHwgdG8gPiB0ZXh0Lmxlbmd0aCB8fCBmcm9tID49IHRvKVxuICAgICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICAgIGAke2Zyb219Li4ke3RvfSBpcyBub3QgYSByYW5nZSBpbiB2JHtkLmFjdGl2ZX0gb2YgJHtkLnNsdWd9ICgke3RleHQubGVuZ3RofSBjaGFyYWN0ZXJzKWAsXG4gICAgICAgICAgNDAwLFxuICAgICAgICApO1xuICAgICAgYW5jaG9yID0gYW5jaG9yT2YodGV4dCwgZnJvbSwgdG8pO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBxdW90ZSA9IG9wdHMucXVvdGUgPz8gXCJcIjtcbiAgICAgIGlmICghcXVvdGUpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXCJhIG5vdGUgbmVlZHMgYSBzZWxlY3Rpb24gb3IgYSBxdW90ZVwiLCA0MDApO1xuICAgICAgY29uc3QgYXQgPSB0ZXh0LmluZGV4T2YocXVvdGUpO1xuICAgICAgLy8g4puUIFJFRlVTRUQsIG5vdCBhbmNob3JlZCBob3BlZnVsbHkuIEEgcXVvdGUgdGhlIGFjdGl2ZSB2ZXJzaW9uIGRvZXMgbm90XG4gICAgICAvLyBjb250YWluIHdvdWxkIGJlY29tZSBhbiBvcnBoYW4gdGhlIG1vbWVudCBpdCB3YXMgbWFkZSwgd2hpY2ggcmVhZHMgYXNcbiAgICAgIC8vIFwidGhlIHRleHQgY2hhbmdlZFwiIHdoZW4gdGhlIHRydXRoIGlzIFwieW91IHF1b3RlZCBzb21ldGhpbmcgZWxzZVwiLlxuICAgICAgaWYgKGF0ID09PSAtMSlcbiAgICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgICBgdiR7ZC5hY3RpdmV9IG9mICR7ZC5zbHVnfSBkb2VzIG5vdCBjb250YWluIHRoYXQgdGV4dCDigJQgcXVvdGUgaXQgZXhhY3RseSBhcyBpdCBhcHBlYXJzYCxcbiAgICAgICAgICA0MDQsXG4gICAgICAgICk7XG4gICAgICBhbmNob3IgPSBhbmNob3JPZih0ZXh0LCBhdCwgYXQgKyBxdW90ZS5sZW5ndGgpO1xuICAgIH1cblxuICAgIGNvbnN0IG5vdGU6IE5vdGUgPSB7XG4gICAgICBpZDogYG4ke0RhdGUubm93KCkudG9TdHJpbmcoMzYpfSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgNil9YCxcbiAgICAgIHZlcnNpb246IGQuYWN0aXZlLFxuICAgICAgLi4uYW5jaG9yLFxuICAgICAgYm9keSxcbiAgICAgIHdobzogb3B0cy53aG8sXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICByZXNvbHZlZDogZmFsc2UsXG4gICAgfTtcbiAgICBkLm5vdGVzID0gWy4uLihkLm5vdGVzID8/IFtdKSwgbm90ZV07XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBub3RlLCBob3c6IG9wdHMucmFuZ2UgPyBcInNlbGVjdGlvblwiIDogXCJxdW90ZVwiIH07XG4gIH1cblxuICAvKiogTm90ZXMgb24gYSBkb2N1bWVudCwgcGxhY2VkIOKAlCBgYWxsYCBpbmNsdWRlcyB0aGUgcmVzb2x2ZWQgb25lcy4gKi9cbiAgbm90ZXNPZihvcHRzOiB7IGRvYz86IHN0cmluZzsgYWxsPzogYm9vbGVhbiB9KTogeyBzbHVnOiBzdHJpbmc7IG5vdGVzOiBQbGFjZWROb3RlW10gfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IHBsYWNlZCA9IHRoaXMucGxhY2VkTm90ZXMoZCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBub3Rlczogb3B0cy5hbGwgPyBwbGFjZWQgOiBwbGFjZWQuZmlsdGVyKChuKSA9PiAhbi5yZXNvbHZlZCkgfTtcbiAgfVxuXG4gIHByaXZhdGUgbm90ZU9yRGllKGQ6IERvY1JlY29yZCwgaWQ6IHN0cmluZyk6IE5vdGUge1xuICAgIGNvbnN0IG5vdGUgPSAoZC5ub3RlcyA/PyBbXSkuZmluZCgobikgPT4gbi5pZCA9PT0gaWQpO1xuICAgIGlmICghbm90ZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Quc2x1Z30gaGFzIG5vIG5vdGUgJHtpZH1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIChkLm5vdGVzID8/IFtdKS5tYXAoKG4pID0+IG4uaWQpLFxuICAgICAgKTtcbiAgICByZXR1cm4gbm90ZTtcbiAgfVxuXG4gIC8qKiBDaGFuZ2Ugd2hhdCBhIG5vdGUgU0FZUy4gSXRzIGFuY2hvciBpcyB1bnRvdWNoZWQg4oCUIGl0IGlzIHN0aWxsIGFib3V0IHRoZVxuICAgKiAgc2FtZSBwYXNzYWdlLCB3aGljaCBpcyB3aHkgZWRpdGluZyBkb2VzIG5vdCByZS1xdW90ZSAoRTQ2KS4gKi9cbiAgZWRpdE5vdGUob3B0czogeyBkb2M/OiBzdHJpbmc7IGlkOiBzdHJpbmc7IGJvZHk6IHN0cmluZyB9KTogeyBzbHVnOiBzdHJpbmc7IG5vdGU6IE5vdGUgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IG5vdGUgPSB0aGlzLm5vdGVPckRpZShkLCBvcHRzLmlkKTtcbiAgICBjb25zdCBib2R5ID0gb3B0cy5ib2R5LnRyaW0oKTtcbiAgICBpZiAoIWJvZHkpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXCJhIG5vdGUgbmVlZHMgc29tZXRoaW5nIHdyaXR0ZW4gaW4gaXRcIiwgNDAwKTtcbiAgICBub3RlLmJvZHkgPSBib2R5O1xuICAgIG5vdGUuZWRpdGVkQXQgPSBEYXRlLm5vdygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1Zywgbm90ZSB9O1xuICB9XG5cbiAgcmVzb2x2ZU5vdGUob3B0czogeyBkb2M/OiBzdHJpbmc7IGlkOiBzdHJpbmc7IHJlc29sdmVkOiBib29sZWFuIH0pOiB7XG4gICAgc2x1Zzogc3RyaW5nO1xuICAgIG5vdGU6IE5vdGU7XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBub3RlID0gdGhpcy5ub3RlT3JEaWUoZCwgb3B0cy5pZCk7XG4gICAgbm90ZS5yZXNvbHZlZCA9IG9wdHMucmVzb2x2ZWQ7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBub3RlIH07XG4gIH1cblxuICByZW1vdmVOb3RlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBpZDogc3RyaW5nIH0pOiB7IHNsdWc6IHN0cmluZzsgbm90ZTogTm90ZSB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3Qgbm90ZSA9IHRoaXMubm90ZU9yRGllKGQsIG9wdHMuaWQpO1xuICAgIGQubm90ZXMgPSAoZC5ub3RlcyA/PyBbXSkuZmlsdGVyKChuKSA9PiBuLmlkICE9PSBvcHRzLmlkKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIG5vdGUgfTtcbiAgfVxuXG4gIC8qKiBTYXZlOiB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IG92ZXIgdGhlIG9yaWdpbmFsLiBUaGUgT05MWSB3cml0ZSB0byBpdCAoRTcpLiAqL1xuICBzYXZlKHNsdWc6IHN0cmluZyk6IHsgb3JpZ2luYWw6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggMWM6IFNhdmUgd3JpdGVzIG9ubHkgYW4gb3JpZ2luYWwgYWRtaXR0ZWQgYnlcbiAgICAvLyBgb3BlblBhdGhgIChhIGRvYy10eXBlIGZpbGUgaW5zaWRlIGEgY29udGV4dCBlbnRyeSkuIENoZWNrZWQgYWdhaW4gaGVyZVxuICAgIC8vIHNvIG5vIG90aGVyIHBhdGggaW50byB0aGUgbWFuaWZlc3Qg4oCUIGEgaGFuZC1lZGl0ZWQgb25lLCBhIGZ1dHVyZSB2ZXJiIOKAlFxuICAgIC8vIGNhbiB0dXJuIFNhdmUgaW50byBcIndyaXRlIGFueSBmaWxlXCIuXG4gICAgaWYgKCFkLmFkbWl0dGVkIHx8ICFpc0RvY05hbWUoZC5vcmlnaW5hbCkpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgcmVmdXNpbmcgdG8gc2F2ZSAke2Qub3JpZ2luYWx9OiBpdCB3YXMgbm90IG9wZW5lZCBmcm9tIHRoZSBjb250ZXh0YCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIik7XG4gICAgdGhpcy53cml0ZU93bmVkKGQub3JpZ2luYWwsIHRleHQpO1xuICAgIGQub3JpZ2luYWxIYXNoID0gY29udGVudEhhc2godGV4dCk7XG4gICAgZC5vdXRzaWRlQ2hhbmdlZCA9IGZhbHNlO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IG9yaWdpbmFsOiBkLm9yaWdpbmFsLCB2ZXJzaW9uOiBkLmFjdGl2ZSB9O1xuICB9XG5cbiAgLyoqIFJldmVydDogdGhlIG9yaWdpbmFsJ3MgdGV4dCBiYWNrIG92ZXIgdGhlIGFjdGl2ZSB2ZXJzaW9uLiAqL1xuICByZXZlcnQoc2x1Zzogc3RyaW5nKTogeyB2ZXJzaW9uOiBudW1iZXI7IHRleHQ6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShzbHVnKTtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKGQub3JpZ2luYWwsIFwidXRmOFwiKTtcbiAgICBkLm9yaWdpbmFsSGFzaCA9IGNvbnRlbnRIYXNoKHRleHQpO1xuICAgIGQub3V0c2lkZUNoYW5nZWQgPSBmYWxzZTtcbiAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRleHQpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHZlcnNpb246IGQuYWN0aXZlLCB0ZXh0IH07XG4gIH1cblxuICBwcml2YXRlIGlzRGlydHkoZDogRG9jUmVjb3JkKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuICh0aGlzLmFjdGl2ZUhhc2guZ2V0KGQuc2x1ZykgPz8gXCJcIikgIT09IGQub3JpZ2luYWxIYXNoO1xuICB9XG5cbiAgLy8g4pSA4pSAIHRoZSB3YXRjaGVyJ3MgcXVlc3Rpb246IHdob3NlIHdyaXRlIHdhcyB0aGF0PyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogQ2xhc3NpZnkgb25lIGZpbGVzeXN0ZW0gZXZlbnQuIFJlYWRzIHRoZSBmaWxlOyByZXR1cm5zIGBudWxsYCB3aGVuIGl0IGlzXG4gICAqIHRoZSBkYWVtb24ncyBvd24gd3JpdGUsIHVuY2hhbmdlZCwgZ29uZSwgb3Igbm90IG91cnMgdG8gY2FyZSBhYm91dC5cbiAgICovXG4gIG9uRmlsZUV2ZW50KGFiczogc3RyaW5nKTogRmlsZUV2ZW50IHwgbnVsbCB7XG4gICAgLy8gQSB2ZXJzaW9uIGZpbGUgdW5kZXIgZG9jcy88c2x1Zz4vdk4uZXh0P1xuICAgIGlmIChhYnMuc3RhcnRzV2l0aCh0aGlzLmRvY3NEaXIgKyBzZXApKSB7XG4gICAgICBjb25zdCByZXN0ID0gYWJzLnNsaWNlKHRoaXMuZG9jc0Rpci5sZW5ndGggKyAxKS5zcGxpdChzZXApO1xuICAgICAgaWYgKHJlc3QubGVuZ3RoICE9PSAyKSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IFtzbHVnLCBmaWxlXSA9IHJlc3QgYXMgW3N0cmluZywgc3RyaW5nXTtcbiAgICAgIGNvbnN0IGQgPSB0aGlzLm0uZG9jcy5maW5kKCh4KSA9PiB4LnNsdWcgPT09IHNsdWcpO1xuICAgICAgY29uc3QgbWF0Y2ggPSAvXnYoXFxkKykoXFwuW2Etel0rKSQvLmV4ZWMoZmlsZSk7XG4gICAgICBpZiAoIWQgfHwgIW1hdGNoIHx8IG1hdGNoWzJdICE9PSBkLmV4dCkgcmV0dXJuIG51bGw7XG4gICAgICBjb25zdCBuID0gTnVtYmVyKG1hdGNoWzFdKTtcbiAgICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgICB0cnkge1xuICAgICAgICB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgaWYgKHRoaXMuaXNPd25Xcml0ZShhYnMsIHRleHQpKSByZXR1cm4gbnVsbDtcbiAgICAgIGlmICghZC52ZXJzaW9ucy5zb21lKCh2KSA9PiB2Lm4gPT09IG4pKSB7XG4gICAgICAgIC8vIFRoZSBhZ2VudCB3cm90ZSBhIHZlcnNpb24gZmlsZSBieSBoYW5kIHJhdGhlciB0aGFuIHRocm91Z2hcbiAgICAgICAgLy8gYHZlcnNpb24tbmV3YCDigJQgYWRvcHQgaXQgcmF0aGVyIHRoYW4gbGVhdmUgYSBmaWxlIHRoZSBzdXJmYWNlIGNhbm5vdCBzZWUuXG4gICAgICAgIGQudmVyc2lvbnMucHVzaCh7IG4sIGF1dGhvcjogXCJhZ2VudFwiLCBjcmVhdGVkQXQ6IERhdGUubm93KCkgfSk7XG4gICAgICAgIGQudmVyc2lvbnMuc29ydCgoYSwgYikgPT4gYS5uIC0gYi5uKTtcbiAgICAgICAgdGhpcy5vd25lZC5zZXQoYWJzLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgICByZXR1cm4geyBraW5kOiBcInZlcnNpb24uY3JlYXRlZFwiLCBkb2M6IGQuc2x1ZywgdmVyc2lvbjogbiwgcGF0aDogYWJzIH07XG4gICAgICB9XG4gICAgICBpZiAobiA9PT0gZC5hY3RpdmUpIHtcbiAgICAgICAgLy8gRTIsIHJlZnVzZWQgYW5kIFJFLUxBQkVMTEVEOiB0aGUgb3V0c2lkZSB0ZXh0IGJlY29tZXMgYSBuZXcgYWdlbnRcbiAgICAgICAgLy8gdmVyc2lvbiwgYW5kIHRoZSBhY3RpdmUgdmVyc2lvbiBnb2VzIGJhY2sgdG8gdGhlIGRhZW1vbidzIG93biBsYXN0XG4gICAgICAgIC8vIHRleHQg4oCUIHNvIHRoZSBhY3RpdmUgdmVyc2lvbiBvbmx5IGV2ZXIgaG9sZHMgd2hhdCB0aGUgaHVtYW4gdHlwZWQsXG4gICAgICAgIC8vIGFuZCBub3RoaW5nIGFueW9uZSB3cm90ZSBpcyBsb3N0ICh2ZXJpZnktcGFzcyBmaXggNCwgd2F0Y2hlciBoYWxmKS5cbiAgICAgICAgY29uc3Qga2VwdCA9IHRoaXMucHJlc2VydmVPdXRzaWRlKGQsIHRleHQpO1xuICAgICAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRoaXMubGFzdEFjdGl2ZVRleHQuZ2V0KGQuc2x1ZykgPz8gdGV4dCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAga2luZDogXCJhY3RpdmUub3V0c2lkZVwiLFxuICAgICAgICAgIGRvYzogZC5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IG4sXG4gICAgICAgICAgcGF0aDogYWJzLFxuICAgICAgICAgIHByZXNlcnZlZEFzOiBrZXB0Lm4sXG4gICAgICAgICAgcHJlc2VydmVkUGF0aDoga2VwdC5wYXRoLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgdGhpcy5vd25lZC5zZXQoYWJzLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgICByZXR1cm4geyBraW5kOiBcInZlcnNpb24uY2hhbmdlZFwiLCBkb2M6IGQuc2x1ZywgdmVyc2lvbjogbiwgdGV4dCwgYWN0aXZlOiBmYWxzZSB9O1xuICAgIH1cblxuICAgIC8vIEFuIG9wZW5lZCBvcmlnaW5hbCDigJQgYnkgaXRzIHN0b3JlZCBwYXRoLCBvciBieSByZWFscGF0aCBmb3IgYSBzeW1saW5rP1xuICAgIGNvbnN0IGQgPSB0aGlzLm0uZG9jcy5maW5kKCh4KSA9PiB4Lm9yaWdpbmFsID09PSBhYnMgfHwgcmVhbE9yKHgub3JpZ2luYWwpID09PSBhYnMpO1xuICAgIGlmIChkKSB7XG4gICAgICBsZXQgdGV4dDogc3RyaW5nO1xuICAgICAgdHJ5IHtcbiAgICAgICAgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGggPSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgICAgIGlmIChoID09PSBkLm9yaWdpbmFsSGFzaCkgcmV0dXJuIG51bGw7IC8vIG91ciBvd24gc2F2ZSwgb3Igbm8gY2hhbmdlXG4gICAgICBjb25zdCBjbGVhbiA9ICF0aGlzLmlzRGlydHkoZCk7XG4gICAgICBpZiAoY2xlYW4pIHtcbiAgICAgICAgZC5vcmlnaW5hbEhhc2ggPSBoO1xuICAgICAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRleHQpO1xuICAgICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBraW5kOiBcIm9yaWdpbmFsLnJlbG9hZGVkXCIsXG4gICAgICAgICAgZG9jOiBkLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICAgICAgdGV4dCxcbiAgICAgICAgICBvcmlnaW5hbDogZC5vcmlnaW5hbCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGlmIChkLm91dHNpZGVDaGFuZ2VkKSByZXR1cm4gbnVsbDsgLy8gYWxyZWFkeSBhc2tlZFxuICAgICAgZC5vdXRzaWRlQ2hhbmdlZCA9IHRydWU7XG4gICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgIHJldHVybiB7IGtpbmQ6IFwib3JpZ2luYWwuY29uZmxpY3RcIiwgZG9jOiBkLnNsdWcsIG9yaWdpbmFsOiBkLm9yaWdpbmFsIH07XG4gICAgfVxuXG4gICAgLy8gU29tZXRoaW5nIHVuZGVyIGEgbWlycm9yZWQgcm9vdDogdGhlIHRyZWUgbWF5IGhhdmUgY2hhbmdlZC5cbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiAmJiAoYWJzID09PSBlLnJvb3QgfHwgYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMucmVzY2FuKGUuaWQpID8geyBraW5kOiBcInRyZWVcIiwgZW50cnlJZDogZS5pZCB9IDogbnVsbDtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICAvLyDilIDilIAgc3RydWN0dXJlIChFMjLigJNFMjQpOiByZWFsIGNoYW5nZXMgb24gZGlzaywgb25lIHBhdGggZm9yIGJvdGggcGFydGllcyDilIDilIBcbiAgLy9cbiAgLy8gRXZlcnkgbWV0aG9kIGJlbG93IGRvZXMgdGhlIGNoYW5nZSBPTiBESVNLIGFuZCB0aGVuIGJyaW5ncyB0aGUgY29udGV4dFxuICAvLyBtb2RlbCBiYWNrIGluIGxpbmUgd2l0aCBpdC4gVGhlIHN1cmZhY2UgcmVhY2hlcyB0aGVtIHRocm91Z2ggbWVudXMgYW5kXG4gIC8vIGRyYWcgYW5kIGRyb3AsIHRoZSBhZ2VudCB0aHJvdWdoIENMSSB2ZXJiczsgdGhlIGRhZW1vbiBhbm5vdW5jZXMgZWFjaCBvbmVcbiAgLy8gdW5kZXIgdGhlIG5hbWUgb2Ygd2hvZXZlciBkaWQgaXQuIFR3byBydWxlcyBob2xkIHRocm91Z2hvdXQ6XG4gIC8vXG4gIC8vIC0gTk9USElORyBJUyBERUxFVEVELiBgaGlkZWAgdGFrZXMgYSBub2RlIG91dCBvZiBTY3JpcHRvcml1bTsgdGhlIGZpbGUgc3RheXMuXG4gIC8vIC0gTk9USElORyBJUyBPVkVSV1JJVFRFTi4gQSBkZXN0aW5hdGlvbiB0aGF0IGV4aXN0cyBpcyByZWZ1c2VkIChhbiBleHBsaWNpdFxuICAvLyAgIG5hbWUpIG9yIGdpdmVuIGEgZnJlZSBuYW1lIChhIGRlZmF1bHQgb25lLCBhIGRyb3ApOyBmaWxlcyBhcmUgY3JlYXRlZFxuICAvLyAgIHdpdGggdGhlIGV4Y2x1c2l2ZSBmbGFnLCBzbyBhIHJhY2UgY2Fubm90IGNsb2JiZXIgZWl0aGVyLlxuXG4gIC8qKiBFMjM6IHdoZXJlIGRyb3BzIGFuZCBuZXcgdG9wLWxldmVsIGRvY3VtZW50cyBsYW5kLiAqL1xuICBnZXQgd29ya3NwYWNlKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHRoaXMubS53b3Jrc3BhY2UgPz8gaG9tZWRpcigpO1xuICB9XG5cbiAgc2V0V29ya3NwYWNlKHJhd1BhdGg6IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGFicyA9IHJlc29sdmUocmF3UGF0aCk7XG4gICAgbGV0IGlzRGlyID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGlzRGlyID0gc3RhdFN5bmMoYWJzKS5pc0RpcmVjdG9yeSgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgbm8gc3VjaCBmb2xkZXI6ICR7YWJzfWAsIDQwNCk7XG4gICAgfVxuICAgIGlmICghaXNEaXIpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYHRoZSB3b3Jrc3BhY2UgbXVzdCBiZSBhIGZvbGRlcjogJHthYnN9YCwgNDAwKTtcbiAgICB0aGlzLm0ud29ya3NwYWNlID0gYWJzO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicyB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEhvdyBhIHBhdGggcmVhZHMgaW4gYSBjaGF0IGxpbmU6IGBzZXQvcmVsYCBpbnNpZGUgYSBzZXQsIGEgc2luZ2xlXG4gICAqIGRvY3VtZW50J3MgZmlsZSBuYW1lLCBgd29ya3NwYWNlL+KApmAgaW4gdGhlIHdvcmtzcGFjZSwgZWxzZSBgfi/igKZgLlxuICAgKi9cbiAgZGlzcGxheShhYnM6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIpIHtcbiAgICAgICAgaWYgKGFicyA9PT0gZS5yb290KSByZXR1cm4gZS5sYWJlbDtcbiAgICAgICAgaWYgKGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpIHJldHVybiBgJHtlLmxhYmVsfS8ke3RvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKX1gO1xuICAgICAgfSBlbHNlIGlmIChlLm5vZGVzLnNvbWUoKG4pID0+IGpvaW4oZS5yb290LCBuLnJlbCkgPT09IGFicykpIHJldHVybiBlLmxhYmVsO1xuICAgIH1cbiAgICBpZiAoYWJzLnN0YXJ0c1dpdGgodGhpcy53b3Jrc3BhY2UgKyBzZXApKVxuICAgICAgcmV0dXJuIGB3b3Jrc3BhY2UvJHt0b1Bvc2l4KHJlbGF0aXZlKHRoaXMud29ya3NwYWNlLCBhYnMpKX1gO1xuICAgIGNvbnN0IGhvbWUgPSBob21lZGlyKCk7XG4gICAgcmV0dXJuIGFicyA9PT0gaG9tZSA/IFwiflwiIDogYWJzLnN0YXJ0c1dpdGgoaG9tZSArIHNlcCkgPyBgfiR7YWJzLnNsaWNlKGhvbWUubGVuZ3RoKX1gIDogYWJzO1xuICB9XG5cbiAgLyoqXG4gICAqIGBhYnNgIHNwZWxsZWQgdGhlIHdheSB0aGUgY29udGV4dCBzcGVsbHMgaXQuIEEgY2FsbGVyIHdob3NlIGN3ZCBpcyBhXG4gICAqIHJlYWxwYXRoICgvcHJpdmF0ZS92YXIv4oCmIGZvciAvdmFyL+KApiwgYSBzeW1saW5rZWQgZm9sZGVyKSBuYW1lcyB0aGUgc2FtZVxuICAgKiBwbGFjZSBkaWZmZXJlbnRseSwgYW5kIGl0IG11c3QgbGFuZCBvbiB0aGUgc2FtZSBub2RlLlxuICAgKi9cbiAgcHJpdmF0ZSBzcGVsbChhYnM6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKHRoaXMubS5jb250ZXh0LnNvbWUoKGUpID0+IGFicyA9PT0gZS5yb290IHx8IGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpKSByZXR1cm4gYWJzO1xuICAgIGNvbnN0IHJlYWwgPSByZWFsT3IoYWJzKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGNvbnN0IHJlYWxSb290ID0gcmVhbE9yKGUucm9vdCk7XG4gICAgICBpZiAocmVhbCA9PT0gcmVhbFJvb3QpIHJldHVybiBlLnJvb3Q7XG4gICAgICBpZiAocmVhbC5zdGFydHNXaXRoKHJlYWxSb290ICsgc2VwKSkgcmV0dXJuIGpvaW4oZS5yb290LCByZWxhdGl2ZShyZWFsUm9vdCwgcmVhbCkpO1xuICAgIH1cbiAgICByZXR1cm4gYWJzO1xuICB9XG5cbiAgcHJpdmF0ZSBpc1dvcmtzcGFjZShhYnM6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBhYnMgPT09IHRoaXMud29ya3NwYWNlIHx8IHJlYWxPcihhYnMpID09PSByZWFsT3IodGhpcy53b3Jrc3BhY2UpO1xuICB9XG5cbiAgLyoqIFRoZSBtaXJyb3JlZCBlbnRyeSB0aGF0IGNvdmVycyBgYWJzYCAoaXRzIHJvb3QsIG9yIGFueXRoaW5nIHVuZGVyIGl0KSwgaWYgYW55LiAqL1xuICBwcml2YXRlIGNvdmVyaW5nRW50cnkoYWJzOiBzdHJpbmcsIGV4Y2VwdD86IHN0cmluZyk6IENvbnRleHRFbnRyeSB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMubS5jb250ZXh0LmZpbmQoXG4gICAgICAoZSkgPT5cbiAgICAgICAgZS5pZCAhPT0gZXhjZXB0ICYmXG4gICAgICAgIGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiICYmXG4gICAgICAgIChhYnMgPT09IGUucm9vdCB8fCBhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSxcbiAgICApO1xuICB9XG5cbiAgLyoqXG4gICAqIEEgZm9sZGVyIHRoaW5ncyBtYXkgYmUgbWFkZSBpbiBvciBtb3ZlZCBpbnRvOiBhIG1pcnJvcmVkIGVudHJ5J3Mgcm9vdCwgYVxuICAgKiB2aXNpYmxlIGZvbGRlciB1bmRlciBvbmUsIG9yIHRoZSB3b3Jrc3BhY2UuIFJldHVybnMgdGhlIGFic29sdXRlIGZvbGRlcjtcbiAgICogcmVmdXNlcyBhbnl0aGluZyBlbHNlIOKAlCB0aGUgY29udGV4dCBzdGF5cyB0aGUgd2F5IGluICh2ZXJpZnktcGFzcyBmaXggMWIpLlxuICAgKi9cbiAgcHJpdmF0ZSBkZXN0aW5hdGlvbk9yRGllKHJhd0Rpcjogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBhYnMgPSB0aGlzLnNwZWxsKHJlc29sdmUocmF3RGlyKSk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwICE9PSBcIm1pcnJvcmVkXCIpIGNvbnRpbnVlO1xuICAgICAgaWYgKGFicyA9PT0gZS5yb290KSByZXR1cm4gYWJzO1xuICAgICAgaWYgKGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpIHtcbiAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKGUubm9kZXMsIHRvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKSk7XG4gICAgICAgIGlmIChub2RlPy5raW5kID09PSBcImdyb3VwXCIpIHJldHVybiBhYnM7XG4gICAgICB9XG4gICAgfVxuICAgIGlmICh0aGlzLmlzV29ya3NwYWNlKGFicykpIHJldHVybiB0aGlzLndvcmtzcGFjZTtcbiAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgYCR7YWJzfSBpcyBub3QgYSBmb2xkZXIgaW4gdGhpcyBzZXNzaW9uIOKAlCBuYW1lIGEgc2V0LCBhIGZvbGRlciBpbnNpZGUgb25lLCBvciB0aGUgd29ya3NwYWNlICgke3RoaXMud29ya3NwYWNlfSlgLFxuICAgICAgNDAwLFxuICAgICk7XG4gIH1cblxuICAvKiogQSBkb2N1bWVudCBvciBmb2xkZXIgc2hvd24gaW4gdGhlIGNvbnRleHQsIHdpdGggd2hlcmUgaXQgaXMgc2hvd24uICovXG4gIHByaXZhdGUgaXRlbU9yRGllKHJhd1BhdGg6IHN0cmluZyk6IHtcbiAgICBhYnM6IHN0cmluZztcbiAgICBlbnRyeTogQ29udGV4dEVudHJ5O1xuICAgIC8qKiBUaGUgd2hvbGUgZW50cnkgKGEgc2V0J3Mgb3duIGZvbGRlciwgYSBsaXN0ZWQgZG9jdW1lbnQpLCBvciBhIG5vZGUgaW5zaWRlIGEgc2V0LiAqL1xuICAgIHdob2xlOiBib29sZWFuO1xuICAgIGRpcjogYm9vbGVhbjtcbiAgfSB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zcGVsbChyZXNvbHZlKHJhd1BhdGgpKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibGlzdGVkXCIpIHtcbiAgICAgICAgY29uc3Qgb25seSA9IGUubm9kZXNbMF07XG4gICAgICAgIGlmIChlLm5vZGVzLmxlbmd0aCA9PT0gMSAmJiBvbmx5Py5raW5kID09PSBcImRvY1wiICYmIGpvaW4oZS5yb290LCBvbmx5LnJlbCkgPT09IGFicylcbiAgICAgICAgICByZXR1cm4geyBhYnMsIGVudHJ5OiBlLCB3aG9sZTogdHJ1ZSwgZGlyOiBmYWxzZSB9O1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChhYnMgPT09IGUucm9vdCkgcmV0dXJuIHsgYWJzLCBlbnRyeTogZSwgd2hvbGU6IHRydWUsIGRpcjogdHJ1ZSB9O1xuICAgICAgaWYgKGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpIHtcbiAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKGUubm9kZXMsIHRvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKSk7XG4gICAgICAgIGlmIChub2RlKSByZXR1cm4geyBhYnMsIGVudHJ5OiBlLCB3aG9sZTogZmFsc2UsIGRpcjogbm9kZS5raW5kID09PSBcImdyb3VwXCIgfTtcbiAgICAgIH1cbiAgICB9XG4gICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHthYnN9IGlzIG5vdCBzaG93biBpbiB0aGlzIHNlc3Npb24ncyBjb250ZXh0YCwgNDA0KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBgcmF3UGF0aGAgaWYgdGhlIGNvbnRleHQgc2hvd3MgaXQg4oCUIGEgZG9jdW1lbnQgb3IgZm9sZGVyIGluIGEgc2V0LCBhXG4gICAqIGxpc3RlZCBkb2N1bWVudCwgYSBzZXQncyBvd24gZm9sZGVyIOKAlCBvciBpdCBpcyB0aGUgd29ya3NwYWNlOyByZWZ1c2VkXG4gICAqIG90aGVyd2lzZS4gRm9yIGFjdHMgdGhhdCByZWFjaCBvdXRzaWRlIHRoZSBzcGVsbCAocmV2ZWFsaW5nIGEgcGF0aCBpbiB0aGVcbiAgICogZmlsZSBtYW5hZ2VyKSwgc28gYSBwYWdlIGNhbm5vdCBhaW0gdGhlbSBhdCBhbiBhcmJpdHJhcnkgcGF0aC5cbiAgICovXG4gIHNob3duUGF0aChyYXdQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc3BlbGwocmVzb2x2ZShyYXdQYXRoKSk7XG4gICAgaWYgKHRoaXMuaXRlbUF0KGFicykpIHJldHVybiBhYnM7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiB0aGlzLmRlc3RpbmF0aW9uT3JEaWUoYWJzKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YWJzfSBpcyBub3Qgc2hvd24gaW4gdGhpcyBzZXNzaW9uYCwgNDAwKTtcbiAgICB9XG4gIH1cblxuICAvKiogUmVmdXNlIGEgbmFtZSB0aGF0IGlzIG5vdCBvbmUgcGxhaW4gZmlsZSBvciBmb2xkZXIgbmFtZS4gKi9cbiAgcHJpdmF0ZSBuYW1lT3JEaWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBuID0gbmFtZS50cmltKCk7XG4gICAgaWYgKFxuICAgICAgbiA9PT0gXCJcIiB8fFxuICAgICAgbiA9PT0gXCIuXCIgfHxcbiAgICAgIG4gPT09IFwiLi5cIiB8fFxuICAgICAgbi5zdGFydHNXaXRoKFwiLlwiKSB8fFxuICAgICAgL1svXFxcXFxcMF0vLnRlc3QobikgfHxcbiAgICAgIG4ubGVuZ3RoID4gMjU1XG4gICAgKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYFwiJHtuYW1lfVwiIGlzIG5vdCBhIHVzYWJsZSBuYW1lIOKAlCBvbmUgcGxhaW4gbmFtZSwgbm8gc2xhc2hlcywgbm90IHN0YXJ0aW5nIHdpdGggYSBkb3RgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIHJldHVybiBuO1xuICB9XG5cbiAgLyoqIEEgZG9jdW1lbnQgbmFtZTogYSBuYW1lIHdpdGhvdXQgYSBkb2N1bWVudCBleHRlbnNpb24gZ2V0cyBgLm1kYC4gKi9cbiAgcHJpdmF0ZSBkb2NOYW1lT3JEaWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBuID0gdGhpcy5uYW1lT3JEaWUobmFtZSk7XG4gICAgcmV0dXJuIGlzRG9jTmFtZShuKSA/IG4gOiBgJHtufS5tZGA7XG4gIH1cblxuICAvKipcbiAgICogQWZ0ZXIgc29tZXRoaW5nIG1vdmVkIG9uIGRpc2sgZnJvbSBgZnJvbWAgdG8gYHRvYCwgYnJpbmcgdGhlIG1vZGVsIHdpdGggaXQ6XG4gICAqIG9wZW5lZCBkb2N1bWVudHMga2VlcCB0aGVpciB2ZXJzaW9ucyB1bmRlciB0aGUgbmV3IHBhdGgsIGVudHJpZXMgcm9vdGVkIGF0XG4gICAqIG9yIGhvbGRpbmcgdGhlIG1vdmVkIHRoaW5nIGZvbGxvdyBpdCwgYW5kIGV2ZXJ5IG1pcnJvciBpcyByZS1yZWFkLiBBbiBlbnRyeVxuICAgKiB0aGF0IG5vdyBzaXRzIGluc2lkZSBhbm90aGVyIHNldCBpcyBkcm9wcGVkIOKAlCB0aGUgc2V0IHNob3dzIGl0IGFscmVhZHkuXG4gICAqL1xuICBwcml2YXRlIGZvbGxvd01vdmUoZnJvbTogc3RyaW5nLCB0bzogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgbW92ZWQgPSAocDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCA9PlxuICAgICAgcCA9PT0gZnJvbSA/IHRvIDogcC5zdGFydHNXaXRoKGZyb20gKyBzZXApID8gdG8gKyBwLnNsaWNlKGZyb20ubGVuZ3RoKSA6IG51bGw7XG4gICAgZm9yIChjb25zdCBkIG9mIHRoaXMubS5kb2NzKSB7XG4gICAgICBjb25zdCBub3cgPSBtb3ZlZChkLm9yaWdpbmFsKTtcbiAgICAgIGlmIChub3cpIHtcbiAgICAgICAgZC5vcmlnaW5hbCA9IG5vdztcbiAgICAgICAgZC5uYW1lID0gYmFzZW5hbWUobm93KTtcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgZHJvcCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJsaXN0ZWRcIikge1xuICAgICAgICBjb25zdCBvbmx5ID0gZS5ub2Rlc1swXTtcbiAgICAgICAgaWYgKG9ubHk/LmtpbmQgIT09IFwiZG9jXCIpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBub3cgPSBtb3ZlZChqb2luKGUucm9vdCwgb25seS5yZWwpKTtcbiAgICAgICAgaWYgKCFub3cpIGNvbnRpbnVlO1xuICAgICAgICBpZiAodGhpcy5jb3ZlcmluZ0VudHJ5KG5vdywgZS5pZCkpIGRyb3AuYWRkKGUuaWQpO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBlLnJvb3QgPSBkaXJuYW1lKG5vdyk7XG4gICAgICAgICAgZS5sYWJlbCA9IGJhc2VuYW1lKG5vdyk7XG4gICAgICAgICAgZS5ub2RlcyA9IFt7IGtpbmQ6IFwiZG9jXCIsIHJlbDogYmFzZW5hbWUobm93KSB9XTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3Qgbm93ID0gbW92ZWQoZS5yb290KTtcbiAgICAgICAgaWYgKCFub3cpIGNvbnRpbnVlO1xuICAgICAgICBpZiAodGhpcy5jb3ZlcmluZ0VudHJ5KG5vdywgZS5pZCkpIGRyb3AuYWRkKGUuaWQpO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBlLnJvb3QgPSBub3c7XG4gICAgICAgICAgZS5sYWJlbCA9IGJhc2VuYW1lKG5vdykgfHwgbm93O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHRoaXMubS5jb250ZXh0ID0gdGhpcy5tLmNvbnRleHQuZmlsdGVyKChlKSA9PiAhZHJvcC5oYXMoZS5pZCkpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiKSB0aGlzLnJlc2NhbihlLmlkKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICB9XG5cbiAgLyoqIEFmdGVyIGEgZmlsZSBvciBmb2xkZXIgbGFuZGVkIGF0IGBhYnNgOiByZS1yZWFkIHRoZSBzZXQgaXQgaXMgaW4sIG9yIGdpdmUgaXQgYW4gZW50cnkuICovXG4gIHByaXZhdGUgYWRvcHROZXcoYWJzOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBzZXQgPSB0aGlzLmNvdmVyaW5nRW50cnkoYWJzKTtcbiAgICBpZiAoc2V0KSB0aGlzLnJlc2NhbihzZXQuaWQpO1xuICAgIGVsc2UgdGhpcy5tLmNvbnRleHQucHVzaChlbnRyeUZvclBhdGgoYWJzLCBgYy0ke3JhbmRIZXgoMyl9YCkpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gIH1cblxuICAvKiogQSBuYW1lIGluIGBkaXJgIHRoYXQgaXMgZnJlZTogYG5hbWVgLCBlbHNlIGBzdGVtIDIuZXh0YCwgYHN0ZW0gMy5leHRgLCDigKYgKi9cbiAgcHJpdmF0ZSBmcmVlTmFtZShkaXI6IHN0cmluZywgbmFtZTogc3RyaW5nLCBpc0RpcjogYm9vbGVhbik6IHN0cmluZyB7XG4gICAgaWYgKCFleGlzdHNTeW5jKGpvaW4oZGlyLCBuYW1lKSkpIHJldHVybiBuYW1lO1xuICAgIGNvbnN0IGV4dCA9IGlzRGlyID8gXCJcIiA6IGV4dG5hbWUobmFtZSk7XG4gICAgY29uc3Qgc3RlbSA9IGV4dCA/IG5hbWUuc2xpY2UoMCwgLWV4dC5sZW5ndGgpIDogbmFtZTtcbiAgICBmb3IgKGxldCBpID0gMjsgOyBpKyspIHtcbiAgICAgIGNvbnN0IG4gPSBgJHtzdGVtfSAke2l9JHtleHR9YDtcbiAgICAgIGlmICghZXhpc3RzU3luYyhqb2luKGRpciwgbikpKSByZXR1cm4gbjtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHJlZnVzZUV4aXN0aW5nKGFiczogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKGV4aXN0c1N5bmMoYWJzKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YWJzfSBhbHJlYWR5IGV4aXN0cyDigJQgbm90aGluZyB3YXMgb3ZlcndyaXR0ZW5gLCA0MDkpO1xuICB9XG5cbiAgY3JlYXRlRG9jKHJhd0Rpcjogc3RyaW5nLCBuYW1lPzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZGlyID0gdGhpcy5kZXN0aW5hdGlvbk9yRGllKHJhd0Rpcik7XG4gICAgY29uc3QgZmlsZSA9XG4gICAgICBuYW1lID09PSB1bmRlZmluZWQgPyB0aGlzLmZyZWVOYW1lKGRpciwgXCJVbnRpdGxlZC5tZFwiLCBmYWxzZSkgOiB0aGlzLmRvY05hbWVPckRpZShuYW1lKTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgZmlsZSk7XG4gICAgdGhpcy5yZWZ1c2VFeGlzdGluZyhhYnMpO1xuICAgIHdyaXRlRmlsZVN5bmMoYWJzLCBcIlwiLCB7IGZsYWc6IFwid3hcIiB9KTtcbiAgICB0aGlzLmFkb3B0TmV3KGFicyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzIH07XG4gIH1cblxuICBjcmVhdGVGb2xkZXIocmF3RGlyOiBzdHJpbmcsIG5hbWU/OiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkaXIgPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3RGlyKTtcbiAgICBjb25zdCBmb2xkZXIgPVxuICAgICAgbmFtZSA9PT0gdW5kZWZpbmVkID8gdGhpcy5mcmVlTmFtZShkaXIsIFwiTmV3IGZvbGRlclwiLCB0cnVlKSA6IHRoaXMubmFtZU9yRGllKG5hbWUpO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBmb2xkZXIpO1xuICAgIHRoaXMucmVmdXNlRXhpc3RpbmcoYWJzKTtcbiAgICBta2RpclN5bmMoYWJzKTtcbiAgICB0aGlzLmFkb3B0TmV3KGFicyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzIH07XG4gIH1cblxuICAvKipcbiAgICogRTI2OiB3aGF0IGEgbW92ZSBXT1VMRCBkbywgZm9yIHRoZSBjb25maXJtYXRpb24gdGhlIHN1cmZhY2Ugc2hvd3MgYmVmb3JlXG4gICAqIG1vdmluZyBhIEZPTERFUi4gUmVhZHMgbm90aGluZyBidXQgdGhlIGRpc2sgYW5kIHJlZnVzZXMgZXhhY3RseSB3aGF0XG4gICAqIGBtb3ZlYCB3b3VsZCByZWZ1c2UsIHNvIGEgY29uZmlybWVkIG1vdmUgY2Fubm90IHRoZW4gZmFpbCBvbiBhZG1pc3Npb24uXG4gICAqXG4gICAqIFRoZSBnaXQgaGFsZiBpcyBoZXJlIGJlY2F1c2Ugb25seSB0aGUgZGFlbW9uIGNhbiBzZWUgYSBgLmdpdGA6IGEgZm9sZGVyXG4gICAqIGRyYWdnZWQgb3V0IG9mIGEgcmVwb3NpdG9yeSBpcyB0aGUgY2FzZSB3aGVyZSB0aGUgY29uc2VxdWVuY2UgcmVhY2hlcyBwYXN0XG4gICAqIHNjcmlwdG9yaXVtIChDb2xlIG1vdmVkIHRoaXMgcHJvamVjdCdzIG93biBkb2NzIGZvbGRlciBpbnRvIGhpcyB3b3Jrc3BhY2UsXG4gICAqIGFuZCBnaXQgc2F3IHNpeCBkZWxldGVkIGZpbGVzKS5cbiAgICovXG4gIG1vdmVQbGFuKHJhd1BhdGg6IHN0cmluZywgcmF3SW50bzogc3RyaW5nKTogTW92ZVBsYW4ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBjb25zdCBpbnRvID0gdGhpcy5kZXN0aW5hdGlvbk9yRGllKHJhd0ludG8pO1xuICAgIGNvbnN0IGZyb21SZXBvID0gZ2l0Um9vdE9mKGRpcm5hbWUoaXRlbS5hYnMpKTtcbiAgICBjb25zdCBpbnRvUmVwbyA9IGdpdFJvb3RPZihpbnRvKTtcbiAgICByZXR1cm4ge1xuICAgICAgZnJvbTogaXRlbS5hYnMsXG4gICAgICBpbnRvLFxuICAgICAgbmFtZTogYmFzZW5hbWUoaXRlbS5hYnMpLFxuICAgICAgZm9sZGVyOiBpdGVtLmRpcixcbiAgICAgIGRvY3M6IGl0ZW0uZGlyID8gY291bnREb2NzKGl0ZW0uYWJzKSA6IDEsXG4gICAgICByZXBvOiBmcm9tUmVwbyA/IGJhc2VuYW1lKGZyb21SZXBvKSA6IG51bGwsXG4gICAgICBsZWF2ZXNSZXBvOiBmcm9tUmVwbyAhPT0gbnVsbCAmJiBmcm9tUmVwbyAhPT0gaW50b1JlcG8sXG4gICAgfTtcbiAgfVxuXG4gIG1vdmUocmF3UGF0aDogc3RyaW5nLCByYXdJbnRvOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZnJvbTogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBjb25zdCBpbnRvID0gdGhpcy5kZXN0aW5hdGlvbk9yRGllKHJhd0ludG8pO1xuICAgIGlmIChpbnRvID09PSBpdGVtLmFicyB8fCBpbnRvLnN0YXJ0c1dpdGgoaXRlbS5hYnMgKyBzZXApKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgY2Fubm90IG1vdmUgJHt0aGlzLmRpc3BsYXkoaXRlbS5hYnMpfSBpbnRvIGl0c2VsZmAsIDQwMCk7XG4gICAgaWYgKGRpcm5hbWUoaXRlbS5hYnMpID09PSBpbnRvKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHt0aGlzLmRpc3BsYXkoaXRlbS5hYnMpfSBpcyBhbHJlYWR5IGluIHRoYXQgZm9sZGVyYCwgNDAwKTtcbiAgICBjb25zdCB0byA9IGpvaW4oaW50bywgYmFzZW5hbWUoaXRlbS5hYnMpKTtcbiAgICB0aGlzLnJlZnVzZUV4aXN0aW5nKHRvKTtcbiAgICB0aGlzLnJlbmFtZU9yRGllKGl0ZW0uYWJzLCB0byk7XG4gICAgdGhpcy5mb2xsb3dNb3ZlKGl0ZW0uYWJzLCB0byk7XG4gICAgaWYgKCF0aGlzLml0ZW1BdCh0bykpIHRoaXMuYWRvcHROZXcodG8pO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IHRvLCBmcm9tOiBpdGVtLmFicyB9O1xuICB9XG5cbiAgcmVuYW1lKHJhd1BhdGg6IHN0cmluZywgbmFtZTogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IGZyb206IHN0cmluZyB9IHtcbiAgICBjb25zdCBpdGVtID0gdGhpcy5pdGVtT3JEaWUocmF3UGF0aCk7XG4gICAgbGV0IG5leHQgPSB0aGlzLm5hbWVPckRpZShuYW1lKTtcbiAgICAvLyBBIGRvY3VtZW50IGtlZXBzIGEgZG9jdW1lbnQgZXh0ZW5zaW9uOiBcIm5vdGVzXCIgcmVuYW1lcyBub3Rlcy5tZCB0b1xuICAgIC8vIG5vdGVzLm1kLCBub3QgdG8gYW4gZXh0ZW5zaW9ubGVzcyBmaWxlIFNjcmlwdG9yaXVtIHdvdWxkIHN0b3Agc2hvd2luZy5cbiAgICBpZiAoIWl0ZW0uZGlyICYmICFpc0RvY05hbWUobmV4dCkpIG5leHQgKz0gZXh0bmFtZShpdGVtLmFicykgfHwgXCIubWRcIjtcbiAgICBjb25zdCB0byA9IGpvaW4oZGlybmFtZShpdGVtLmFicyksIG5leHQpO1xuICAgIGlmICh0byA9PT0gaXRlbS5hYnMpIHJldHVybiB7IHBhdGg6IHRvLCBmcm9tOiBpdGVtLmFicyB9O1xuICAgIC8vIEEgY2FzZS1vbmx5IHJlbmFtZSBvbiBhIGNhc2UtaW5zZW5zaXRpdmUgZGlzayBmaW5kcyBcIml0c2VsZlwiIGV4aXN0aW5nLlxuICAgIGlmICh0by50b0xvd2VyQ2FzZSgpICE9PSBpdGVtLmFicy50b0xvd2VyQ2FzZSgpKSB0aGlzLnJlZnVzZUV4aXN0aW5nKHRvKTtcbiAgICB0aGlzLnJlbmFtZU9yRGllKGl0ZW0uYWJzLCB0byk7XG4gICAgdGhpcy5mb2xsb3dNb3ZlKGl0ZW0uYWJzLCB0byk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogdG8sIGZyb206IGl0ZW0uYWJzIH07XG4gIH1cblxuICBwcml2YXRlIHJlbmFtZU9yRGllKGZyb206IHN0cmluZywgdG86IHN0cmluZyk6IHZvaWQge1xuICAgIHRyeSB7XG4gICAgICByZW5hbWVTeW5jKGZyb20sIHRvKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zdCBjb2RlID0gKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlO1xuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgY29kZSA9PT0gXCJFWERFVlwiXG4gICAgICAgICAgPyBgY2Fubm90IG1vdmUgJHtmcm9tfSB0byBhbm90aGVyIGRpc2sgKCR7dG99KSDigJQgY29weSBpdCBpbnN0ZWFkYFxuICAgICAgICAgIDogYGNhbm5vdCBtb3ZlICR7ZnJvbX0gdG8gJHt0b306ICR7Y29kZSA/PyBTdHJpbmcoZSl9YCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvKiogV2hldGhlciBgYWJzYCBpcyBzaG93biBhbnl3aGVyZSBpbiB0aGUgY29udGV4dCBub3cuICovXG4gIHByaXZhdGUgaXRlbUF0KGFiczogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgdHJ5IHtcbiAgICAgIHRoaXMuaXRlbU9yRGllKGFicyk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cblxuICAvKiogXCJSZW1vdmUgZnJvbSBTY3JpcHRvcml1bVwiIOKAlCBuZXZlciBmcm9tIGRpc2sgKEUyNCkuICovXG4gIGhpZGUocmF3UGF0aDogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IGVudHJ5OiBzdHJpbmc7IHJlbW92ZWRFbnRyeTogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBpdGVtID0gdGhpcy5pdGVtT3JEaWUocmF3UGF0aCk7XG4gICAgaWYgKGl0ZW0ud2hvbGUpIHtcbiAgICAgIHRoaXMucmVtb3ZlQ29udGV4dChpdGVtLmVudHJ5LmlkKTtcbiAgICAgIHJldHVybiB7IHBhdGg6IGl0ZW0uYWJzLCBlbnRyeTogaXRlbS5lbnRyeS5pZCwgcmVtb3ZlZEVudHJ5OiB0cnVlIH07XG4gICAgfVxuICAgIGNvbnN0IHJlbCA9IHRvUG9zaXgocmVsYXRpdmUoaXRlbS5lbnRyeS5yb290LCBpdGVtLmFicykpO1xuICAgIGl0ZW0uZW50cnkuaGlkZGVuID0gWy4uLihpdGVtLmVudHJ5LmhpZGRlbiA/PyBbXSkuZmlsdGVyKChoKSA9PiBoICE9PSByZWwpLCByZWxdO1xuICAgIHRoaXMucmVzY2FuKGl0ZW0uZW50cnkuaWQpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5jbG9zZU9ycGhhbmVkT3BlbkRvYygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IGl0ZW0uYWJzLCBlbnRyeTogaXRlbS5lbnRyeS5pZCwgcmVtb3ZlZEVudHJ5OiBmYWxzZSB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBoaWRkZW4gbGlzdCBvZiB0aGUgZW50cnkgYSBwYXRoIGJlbG9uZ3MgdG8sIEJFRk9SRSBhbnl0aGluZyBjaGFuZ2VzIGl0XG4gICAqIOKAlCB3aGF0IEU2MCByZWNvcmRzIHNvIGEgaGlkZSBjYW4gYmUgcHV0IGJhY2sgZXhhY3RseS5cbiAgICovXG4gIGhpZGRlbkJlZm9yZShyYXdQYXRoOiBzdHJpbmcpOiB7IGVudHJ5OiBzdHJpbmc7IHJlbHM6IHN0cmluZ1tdIH0gfCBudWxsIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgICAgcmV0dXJuIHsgZW50cnk6IGl0ZW0uZW50cnkuaWQsIHJlbHM6IFsuLi4oaXRlbS5lbnRyeS5oaWRkZW4gPz8gW10pXSB9O1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9XG5cbiAgLyoqIFRoZSBzYW1lLCBhZGRyZXNzZWQgYnkgZW50cnkg4oCUIHdoYXQgYHVuaGlkZWAgbmVlZHMgcmVjb3JkZWQuICovXG4gIGhpZGRlbk9mRW50cnkoZW50cnlJZDogc3RyaW5nKTogeyBlbnRyeTogc3RyaW5nOyByZWxzOiBzdHJpbmdbXSB9IHwgbnVsbCB7XG4gICAgY29uc3QgZSA9IHRoaXMubS5jb250ZXh0LmZpbmQoKHgpID0+IHguaWQgPT09IGVudHJ5SWQpO1xuICAgIHJldHVybiBlID8geyBlbnRyeTogZS5pZCwgcmVsczogWy4uLihlLmhpZGRlbiA/PyBbXSldIH0gOiBudWxsO1xuICB9XG5cbiAgLyoqXG4gICAqIFNldCBhbiBlbnRyeSdzIGhpZGRlbiBsaXN0IHRvIGV4YWN0bHkgYHJlbHNgIChFNjAncyBpbnZlcnNlIG9mIGJvdGggaGlkZVxuICAgKiBhbmQgdW5oaWRlKS4gUmV0dXJucyB3aGF0IGl0IFdBUywgc28gdGhlIGNhbGxlciBjYW4gYnVpbGQgdGhlIG9wcG9zaXRlIGFjdFxuICAgKiB3aXRob3V0IHJlYWRpbmcgc3RhdGUgaXQgaGFzIGFscmVhZHkgY2hhbmdlZC5cbiAgICovXG4gIHJlc3RvcmVIaWRkZW4oZW50cnlJZDogc3RyaW5nLCByZWxzOiBzdHJpbmdbXSk6IHsgZW50cnk6IHN0cmluZzsgd2FzOiBzdHJpbmdbXSB9IHtcbiAgICBjb25zdCBlID0gdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5pZCA9PT0gZW50cnlJZCk7XG4gICAgaWYgKCFlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vIGNvbnRleHQgZW50cnkgJHtlbnRyeUlkfWAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgdGhpcy5tLmNvbnRleHQubWFwKCh4KSA9PiB4LmlkKSxcbiAgICAgICk7XG4gICAgY29uc3Qgd2FzID0gWy4uLihlLmhpZGRlbiA/PyBbXSldO1xuICAgIGlmIChyZWxzLmxlbmd0aCA9PT0gMCkgZGVsZXRlIGUuaGlkZGVuO1xuICAgIGVsc2UgZS5oaWRkZW4gPSBbLi4ucmVsc107XG4gICAgdGhpcy5yZXNjYW4oZS5pZCk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLmNsb3NlT3JwaGFuZWRPcGVuRG9jKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgZW50cnk6IGUuaWQsIHdhcyB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFJlbW92ZSBzb21ldGhpbmcgdGhpcyBzZXNzaW9uIGNyZWF0ZWQgKEU2MCdzIHVuZG8gb2YgYSBjcmVhdGlvbikuXG4gICAqXG4gICAqIOKblCBBIE5PTi1FTVBUWSBESVJFQ1RPUlkgSVMgUkVGVVNFRCwgYW5kIG5vIGRpYWxvZyBjYW4gYXV0aG9yaXNlIGl0LiBVbmRvXG4gICAqIHdvcmtzIGJhY2t3YXJkcywgc28gaXQgZW1wdGllcyBhIGZvbGRlciBiZWZvcmUgaXQgcmVhY2hlcyB0aGF0IGZvbGRlcidzXG4gICAqIGNyZWF0aW9uOyBpZiB0aGUgZm9sZGVyIHN0aWxsIGhhcyBjb250ZW50cyB0aGVuIHNvbWV0aGluZyBwdXQgdGhlbSB0aGVyZVxuICAgKiB0aGF0IHRoZSBoaXN0b3J5IGRvZXMgbm90IGtub3cgYWJvdXQsIGFuZCByZW1vdmluZyBhIGRpcmVjdG9yeSBUUkVFIGlzIGFcbiAgICogZGlmZmVyZW50IGFjdCBmcm9tIHJlbW92aW5nIHRoZSBlbXB0eSB0aGluZyB5b3UganVzdCBtYWRlLiAoQ29sZSBydWxlZCB0aGVcbiAgICogZmlsZSBjYXNlIHRoZSBvdGhlciB3YXkg4oCUIGNvbmZpcm1lZCwgbm90IHJlZnVzZWQg4oCUIGFuZCB0aGlzIGxpbWl0IGlzIHRoZVxuICAgKiBjYXJ2ZS1vdXQgaGUgYWNjZXB0ZWQuKVxuICAgKlxuICAgKiDimqAgSXQgYWxzbyByZWZ1c2VzIGFueXRoaW5nIHRoYXQgaXMgbm90IHdoZXJlIHRoZSBoaXN0b3J5IHNhaWQgaXQgd2FzOiBhXG4gICAqIHBhdGggdGhhdCBoYXMgYmVjb21lIGEgZGlyZWN0b3J5LCBvciBhIGRpcmVjdG9yeSB0aGF0IGhhcyBiZWNvbWUgYSBmaWxlLFxuICAgKiBtZWFucyB0aGUgd29ybGQgbW92ZWQgYW5kIHRoZSByZWNvcmRlZCBpbnZlcnNlIG5vIGxvbmdlciBkZXNjcmliZXMgaXQuXG4gICAqL1xuICByZW1vdmVDcmVhdGVkKHJhd1BhdGg6IHN0cmluZywgZGlyOiBib29sZWFuKTogeyBwYXRoOiBzdHJpbmc7IHJlbW92ZWQ6IGJvb2xlYW4gfSB7XG4gICAgY29uc3QgYWJzID0gcmVzb2x2ZShyYXdQYXRoKTtcbiAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICB0cnkge1xuICAgICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gQWxyZWFkeSBnb25lOiB0aGUgdW5kbyBoYXMgbm90aGluZyB0byBkbywgd2hpY2ggaXMgbm90IGFuIGVycm9yLlxuICAgICAgcmV0dXJuIHsgcGF0aDogYWJzLCByZW1vdmVkOiBmYWxzZSB9O1xuICAgIH1cbiAgICBpZiAoc3QuaXNEaXJlY3RvcnkoKSAhPT0gZGlyKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7dGhpcy5kaXNwbGF5KGFicyl9IGlzICR7c3QuaXNEaXJlY3RvcnkoKSA/IFwiYSBmb2xkZXJcIiA6IFwiYSBmaWxlXCJ9IG5vdyDigJQgdGhlIGNoYW5nZSB0aGlzIHdvdWxkIHVuZG8gbm8gbG9uZ2VyIGRlc2NyaWJlcyBpdGAsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgaWYgKGRpcikge1xuICAgICAgY29uc3QgbGVmdCA9IHJlYWRkaXJTeW5jKGFicyk7XG4gICAgICBpZiAobGVmdC5sZW5ndGggPiAwKVxuICAgICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICAgIGAke3RoaXMuZGlzcGxheShhYnMpfSBpcyBub3QgZW1wdHkgKCR7bGVmdC5sZW5ndGh9IGl0ZW0ke2xlZnQubGVuZ3RoID09PSAxID8gXCJcIiA6IFwic1wifSkg4oCUIG1vdmUgd2hhdCBpcyBpbnNpZGUgaXQgb3V0IGZpcnN0YCxcbiAgICAgICAgICA0MDksXG4gICAgICAgICAgbGVmdC5zbGljZSgwLCAxMCksXG4gICAgICAgICk7XG4gICAgICBybWRpclN5bmMoYWJzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdW5saW5rU3luYyhhYnMpO1xuICAgIH1cbiAgICAvLyBXaGF0ZXZlciBwb2ludGVkIGF0IGl0IG11c3Qgc3RvcCBwb2ludGluZyBhdCBpdC5cbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHRoaXMucmVzY2FuKGUuaWQpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5jbG9zZU9ycGhhbmVkT3BlbkRvYygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicywgcmVtb3ZlZDogdHJ1ZSB9O1xuICB9XG5cbiAgdW5oaWRlKGVudHJ5SWQ6IHN0cmluZyk6IHsgZW50cnk6IHN0cmluZzsgcmVzdG9yZWQ6IG51bWJlciB9IHtcbiAgICBjb25zdCBlID0gdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5pZCA9PT0gZW50cnlJZCk7XG4gICAgaWYgKCFlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vIGNvbnRleHQgZW50cnkgJHtlbnRyeUlkfWAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgdGhpcy5tLmNvbnRleHQubWFwKCh4KSA9PiB4LmlkKSxcbiAgICAgICk7XG4gICAgY29uc3QgcmVzdG9yZWQgPSBlLmhpZGRlbj8ubGVuZ3RoID8/IDA7XG4gICAgZGVsZXRlIGUuaGlkZGVuO1xuICAgIHRoaXMucmVzY2FuKGUuaWQpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgZW50cnk6IGUuaWQsIHJlc3RvcmVkIH07XG4gIH1cblxuICAvKipcbiAgICogRTIyOiBhIHNpbmdsZSBkb2N1bWVudCBiZWNvbWVzIGEgc2V0IOKAlCBhIGZvbGRlciBuYW1lZCBmb3IgaXQgYmVzaWRlIGl0LCB0aGVcbiAgICogZG9jdW1lbnQgbW92ZWQgaW4sIGFuZCB0aGUgZW50cnkgKHNhbWUgaWQpIG5vdyBtaXJyb3JzIHRoYXQgZm9sZGVyLlxuICAgKi9cbiAgbWFrZVNldChyYXdQYXRoOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZm9sZGVyOiBzdHJpbmc7IGVudHJ5OiBzdHJpbmcgfSB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGlmIChpdGVtLmVudHJ5Lm1lbWJlcnNoaXAgIT09IFwibGlzdGVkXCIgfHwgaXRlbS5kaXIpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHt0aGlzLmRpc3BsYXkoaXRlbS5hYnMpfSBpcyBhbHJlYWR5IGluIGEgc2V0IOKAlCBtYWtlIGEgZm9sZGVyIHRoZXJlIGluc3RlYWRgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoaXRlbS5hYnMpO1xuICAgIGNvbnN0IHN0ZW0gPSBiYXNlbmFtZShpdGVtLmFicywgZXh0bmFtZShpdGVtLmFicykpIHx8IFwiVW50aXRsZWRcIjtcbiAgICBjb25zdCBmb2xkZXIgPSBqb2luKHBhcmVudCwgdGhpcy5mcmVlTmFtZShwYXJlbnQsIHN0ZW0sIHRydWUpKTtcbiAgICBta2RpclN5bmMoZm9sZGVyKTtcbiAgICBjb25zdCB0byA9IGpvaW4oZm9sZGVyLCBiYXNlbmFtZShpdGVtLmFicykpO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICBjb25zdCBlID0gaXRlbS5lbnRyeTtcbiAgICBlLm1lbWJlcnNoaXAgPSBcIm1pcnJvcmVkXCI7XG4gICAgZS5yb290ID0gZm9sZGVyO1xuICAgIGUubGFiZWwgPSBiYXNlbmFtZShmb2xkZXIpO1xuICAgIGUubm9kZXMgPSBbXTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiB0bywgZm9sZGVyLCBlbnRyeTogZS5pZCB9O1xuICB9XG5cbiAgLyoqIFRoZSBtb3N0IHRleHQgb25lIGltcG9ydCBjYXJyaWVzIOKAlCBhIGRvY3VtZW50LCBub3QgYSBkYXRhIGR1bXAuICovXG4gIHN0YXRpYyByZWFkb25seSBJTVBPUlRfTUFYX0JZVEVTID0gOCAqIDEwMjQgKiAxMDI0O1xuXG4gIC8qKlxuICAgKiBFMjMncyBkcm9wOiBhIENPUFkgb2YgYSBmaWxlJ3MgdGV4dCwgd3JpdHRlbiB1bmRlciBhIGZyZWUgbmFtZSBpbnRvIGBpbnRvYFxuICAgKiAoZGVmYXVsdDogdGhlIHdvcmtzcGFjZSksIHRoZW4gc2hvd24gbGlrZSBhbnkgb3RoZXIgZG9jdW1lbnQuXG4gICAqL1xuICBpbXBvcnRUZXh0KG5hbWU6IHN0cmluZywgdGV4dDogc3RyaW5nLCByYXdJbnRvPzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZmlsZSA9IHRoaXMubmFtZU9yRGllKG5hbWUpO1xuICAgIGlmICghaXNEb2NOYW1lKGZpbGUpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vdCBhIGRvY3VtZW50IFNjcmlwdG9yaXVtIG9wZW5zICgke0RPQ19FWFRFTlNJT05TLmpvaW4oXCIgXCIpfSk6ICR7ZmlsZX1gLFxuICAgICAgICA0MDAsXG4gICAgICAgIFsuLi5ET0NfRVhURU5TSU9OU10sXG4gICAgICApO1xuICAgIGlmIChCdWZmZXIuYnl0ZUxlbmd0aCh0ZXh0KSA+IFNlc3Npb24uSU1QT1JUX01BWF9CWVRFUylcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2ZpbGV9IGlzIGxhcmdlciB0aGFuICR7U2Vzc2lvbi5JTVBPUlRfTUFYX0JZVEVTIC8gMTAyNCAvIDEwMjR9IE1CIOKAlCBub3QgaW1wb3J0ZWRgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIGNvbnN0IGRpciA9IHRoaXMuZGVzdGluYXRpb25PckRpZShyYXdJbnRvID8/IHRoaXMud29ya3NwYWNlKTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgdGhpcy5mcmVlTmFtZShkaXIsIGZpbGUsIGZhbHNlKSk7XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIHRleHQsIHsgZmxhZzogXCJ3eFwiIH0pO1xuICAgIHRoaXMuYWRvcHROZXcoYWJzKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBjaGF0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8vIOKUgOKUgCB0aGUgd29yayBxdWV1ZSAoRTUwKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogU3RhcnQgYSB0YXNrLiBJdCBpcyBBTk5PVU5DRUQgYXMgYSBjaGF0IG1lc3NhZ2UgYW5kIHJlY29yZGVkIGFzIGEgdGFzayBhdFxuICAgKiB0aGUgc2FtZSBtb21lbnQg4oCUIENvbGUncyBmcmFtaW5nLCBcImEgbWVzc2FnZSB0aGF0IGNhbiBiZSBtYXJrZWQgZG9uZVwiIOKAlFxuICAgKiBzbyB0aGUgY29udmVyc2F0aW9uIHJlYWRzIGFzIGEgbmFycmF0aXZlIGFuZCB0aGUgcXVldWUgcmVhZHMgYXMgc3RhdGUsXG4gICAqIG92ZXIgb25lIGZhY3QgcmF0aGVyIHRoYW4gdHdvLlxuICAgKi9cbiAgc3RhcnRUYXNrKHRleHQ6IHN0cmluZywgd2hvOiBWZXJzaW9uQXV0aG9yKTogVGFzayB7XG4gICAgY29uc3QgYm9keSA9IHRleHQudHJpbSgpO1xuICAgIGlmICghYm9keSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcImEgdGFzayBuZWVkcyB0byBzYXkgd2hhdCB0aGUgd29yayBpc1wiLCA0MDApO1xuICAgIGNvbnN0IG1lc3NhZ2UgPSB0aGlzLmFkZE1lc3NhZ2Uod2hvLCBib2R5KTtcbiAgICBjb25zdCB0YXNrOiBUYXNrID0ge1xuICAgICAgaWQ6IGB0LSR7cmFuZEhleCg0KX1gLFxuICAgICAgdGV4dDogYm9keSxcbiAgICAgIHdobyxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIG1lc3NhZ2VJZDogbWVzc2FnZS5pZCxcbiAgICB9O1xuICAgIHRoaXMubS50YXNrcyA9IFsuLi4odGhpcy5tLnRhc2tzID8/IFtdKSwgdGFza107XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHRhc2s7XG4gIH1cblxuICBwcml2YXRlIHRhc2tPckRpZShpZDogc3RyaW5nKTogVGFzayB7XG4gICAgY29uc3QgdGFzayA9ICh0aGlzLm0udGFza3MgPz8gW10pLmZpbmQoKHQpID0+IHQuaWQgPT09IGlkKTtcbiAgICBpZiAoIXRhc2spXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm8gdGFzayAke2lkfSBpbiB0aGlzIHNlc3Npb25gLFxuICAgICAgICA0MDQsXG4gICAgICAgICh0aGlzLm0udGFza3MgPz8gW10pLmZpbHRlcigodCkgPT4gdC5kb25lQXQgPT09IHVuZGVmaW5lZCkubWFwKCh0KSA9PiB0LmlkKSxcbiAgICAgICk7XG4gICAgcmV0dXJuIHRhc2s7XG4gIH1cblxuICAvKiogU2F5IHdoYXQgaXMgYmVpbmcgZG9uZSByaWdodCBub3cg4oCUIGZvciB3b3JrIHdpdGggc3RlcHMgd29ydGggd2F0Y2hpbmcuICovXG4gIHNldFRhc2tTdGF0dXMoaWQ6IHN0cmluZywgc3RhdHVzOiBzdHJpbmcpOiBUYXNrIHtcbiAgICBjb25zdCB0YXNrID0gdGhpcy50YXNrT3JEaWUoaWQpO1xuICAgIGlmICh0YXNrLmRvbmVBdCAhPT0gdW5kZWZpbmVkKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgdGFzayAke2lkfSBpcyBhbHJlYWR5IGRvbmUg4oCUIGl0cyBzdGF0dXMgY2Fubm90IGNoYW5nZWAsIDQwOSk7XG4gICAgdGFzay5zdGF0dXMgPSBzdGF0dXMudHJpbSgpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB0YXNrO1xuICB9XG5cbiAgLyoqXG4gICAqIE1hcmsgaXQgZG9uZS4gSWRlbXBvdGVudCBvbiBwdXJwb3NlOiBhIHRhc2sgZmluaXNoZWQgdHdpY2Ug4oCUIGFuIGFnZW50XG4gICAqIHJldHJ5aW5nLCBhIGh1bWFuIGNsaWNraW5nIGFzIHRoZSBhZ2VudCByZXBvcnRzIOKAlCBpcyBub3QgYW4gZXJyb3IsIGFuZFxuICAgKiByZWZ1c2luZyB3b3VsZCBtYWtlIHRoZSBzdXJmYWNlIGhhbmRsZSBhIHJhY2UgaXQgZGlkIG5vdCBjYXVzZS5cbiAgICovXG4gIGZpbmlzaFRhc2soaWQ6IHN0cmluZywgb3V0Y29tZT86IHN0cmluZyk6IHsgdGFzazogVGFzazsgYWxyZWFkeTogYm9vbGVhbiB9IHtcbiAgICBjb25zdCB0YXNrID0gdGhpcy50YXNrT3JEaWUoaWQpO1xuICAgIGNvbnN0IGFscmVhZHkgPSB0YXNrLmRvbmVBdCAhPT0gdW5kZWZpbmVkO1xuICAgIGlmICghYWxyZWFkeSkge1xuICAgICAgdGFzay5kb25lQXQgPSBEYXRlLm5vdygpO1xuICAgICAgdGFzay5zdGF0dXMgPSB1bmRlZmluZWQ7XG4gICAgICBpZiAob3V0Y29tZT8udHJpbSgpKSB0YXNrLm91dGNvbWUgPSBvdXRjb21lLnRyaW0oKTtcbiAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIH1cbiAgICByZXR1cm4geyB0YXNrLCBhbHJlYWR5IH07XG4gIH1cblxuICAvKipcbiAgICogRm9yZ2V0IGEgdGFzayBlbnRpcmVseSDigJQgZm9yIG9uZSBzdGFydGVkIGJ5IG1pc3Rha2UuIE1hcmtpbmcgaXQgZG9uZSB3b3VsZFxuICAgKiBwdXQgYSB0aGluZyB0aGF0IG5ldmVyIGhhcHBlbmVkIGludG8gdGhlIHJlY29yZDsgYSBxdWV1ZSB5b3UgY2Fubm90IGNsZWFyXG4gICAqIG9mIGl0cyBvd24gbWlzdGFrZXMgc3RvcHMgYmVpbmcgYSB0cnVzdHdvcnRoeSBhY2NvdW50IG9mIHRoZSB3b3JrLlxuICAgKi9cbiAgcmVtb3ZlVGFzayhpZDogc3RyaW5nKTogVGFzayB7XG4gICAgY29uc3QgdGFzayA9IHRoaXMudGFza09yRGllKGlkKTtcbiAgICB0aGlzLm0udGFza3MgPSAodGhpcy5tLnRhc2tzID8/IFtdKS5maWx0ZXIoKHQpID0+IHQuaWQgIT09IGlkKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gdGFzaztcbiAgfVxuXG4gIC8qKlxuICAgKiBGb3JnZXQgZXZlcnkgZmluaXNoZWQgdGFzay4gT3V0c3RhbmRpbmcgb25lcyBhcmUgdW50b3VjaGVkIOKAlCBjbGVhcmluZyBpc1xuICAgKiB0aWR5aW5nIHdoYXQgaXMgT1ZFUiwgbmV2ZXIgYWJhbmRvbmluZyB3b3JrIHN0aWxsIGluIGZsaWdodC5cbiAgICovXG4gIGNsZWFyRG9uZVRhc2tzKCk6IG51bWJlciB7XG4gICAgY29uc3QgYmVmb3JlID0gKHRoaXMubS50YXNrcyA/PyBbXSkubGVuZ3RoO1xuICAgIHRoaXMubS50YXNrcyA9ICh0aGlzLm0udGFza3MgPz8gW10pLmZpbHRlcigodCkgPT4gdC5kb25lQXQgPT09IHVuZGVmaW5lZCk7XG4gICAgY29uc3QgY2xlYXJlZCA9IGJlZm9yZSAtICh0aGlzLm0udGFza3M/Lmxlbmd0aCA/PyAwKTtcbiAgICBpZiAoY2xlYXJlZCA+IDApIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiBjbGVhcmVkO1xuICB9XG5cbiAgLyoqIE5ld2VzdCBmaXJzdCDigJQgYSBxdWV1ZSBpcyByZWFkIGZyb20gdGhlIHRvcC4gKi9cbiAgdGFza3MoKTogVGFza1tdIHtcbiAgICByZXR1cm4gWy4uLih0aGlzLm0udGFza3MgPz8gW10pXS5zb3J0KChhLCBiKSA9PiBiLmNyZWF0ZWRBdCAtIGEuY3JlYXRlZEF0KTtcbiAgfVxuXG4gIGFkZE1lc3NhZ2UoXG4gICAgd2hvOiBDaGF0V2hvLFxuICAgIHRleHQ6IHN0cmluZyxcbiAgICBleHRyYTogeyBzZWxlY3Rpb24/OiBTZWxlY3Rpb24gfCBudWxsOyBhY3RpdmVQYXRoPzogc3RyaW5nIHwgbnVsbCB9ID0ge30sXG4gICk6IENoYXRNZXNzYWdlIHtcbiAgICBjb25zdCBtc2c6IENoYXRNZXNzYWdlID0geyBpZDogYG0tJHtyYW5kSGV4KDQpfWAsIHdobywgdGV4dCwgdHM6IERhdGUubm93KCksIC4uLmV4dHJhIH07XG4gICAgdGhpcy5tLmNoYXQucHVzaChtc2cpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiBtc2c7XG4gIH1cblxuICAvLyDilIDilIAgdmlld3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqIEEgZG9jdW1lbnQncyBmcm9udG1hdHRlciwgZnJvbSB0aGUgQUNUSVZFIHZlcnNpb24ncyB0ZXh0IOKAlCB3aGF0IHRoZSBodW1hblxuICAgKiAgaXMgcmVhZGluZywgd2hpY2ggaXMgbm90IGFsd2F5cyB3aGF0IGlzIG9uIGRpc2sgKEUzMikuICovXG4gIHByaXZhdGUgbWV0YU9mKGQ6IERvY1JlY29yZCk6IERvY1ZpZXdbXCJtZXRhXCJdIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHJlYWRNZXRhKHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgfVxuXG4gIGRvY1ZpZXcoZDogRG9jUmVjb3JkKTogRG9jVmlldyB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG1ldGE6IHRoaXMubWV0YU9mKGQpLFxuICAgICAgc2x1ZzogZC5zbHVnLFxuICAgICAgbmFtZTogZC5uYW1lLFxuICAgICAgb3JpZ2luYWw6IGQub3JpZ2luYWwsXG4gICAgICBlbnRyeUlkOiBkLmVudHJ5SWQsXG4gICAgICByZWw6IGQucmVsLFxuICAgICAgdmVyc2lvbnM6IGQudmVyc2lvbnMubWFwKCh2KSA9PiAoeyAuLi52LCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIHYubikgfSkpLFxuICAgICAgbm90ZXM6IHRoaXMucGxhY2VkTm90ZXMoZCksXG4gICAgICBhY3RpdmU6IGQuYWN0aXZlLFxuICAgICAgZGlydHk6IHRoaXMuaXNEaXJ0eShkKSxcbiAgICAgIG91dHNpZGVDaGFuZ2VkOiBkLm91dHNpZGVDaGFuZ2VkLFxuICAgIH07XG4gIH1cblxuICBkb2Moc2x1Zzogc3RyaW5nKTogRG9jVmlldyB7XG4gICAgcmV0dXJuIHRoaXMuZG9jVmlldyh0aGlzLmRvY09yRGllKHNsdWcpKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBGcm9udG1hdHRlciBmb3IgZXZlcnkgZG9jdW1lbnQgaW4gdGhlIGNvbnRleHQsIGJ5IHBhdGggKEUzMikuXG4gICAqXG4gICAqIENhY2hlZCBieSBwYXRoIGFuZCBtdGltZSwgYW5kIHJlYWQgSEVBRC1GSVJTVDogYSBmcm9udG1hdHRlciBibG9jayBzaXRzIGF0XG4gICAqIHRoZSB0b3Agb2YgYSBmaWxlLCBzbyBhIDMwMCBLQiBkb2N1bWVudCBjb3N0cyA4IEtCIG9mIHJlYWQuIFRoZSBjYXAga2VlcHMgYVxuICAgKiAyLDAwMC1ub2RlIG1pcnJvciBmcm9tIG1lYW5pbmcgMiwwMDAgcmVhZHMgcGVyIHNuYXBzaG90LCBhbmQgaGl0dGluZyBpdCBpc1xuICAgKiBTQUlEIG9uIHRoZSB3aXJlIHJhdGhlciB0aGFuIGxlZnQgdG8gbG9vayBsaWtlIGRvY3VtZW50cyB3aXRob3V0IGFueS5cbiAgICovXG4gIHByaXZhdGUgbWV0YUNhY2hlID0gbmV3IE1hcDxzdHJpbmcsIHsgbXRpbWVNczogbnVtYmVyOyBzdW1tYXJ5OiBEb2NTdW1tYXJ5IHwgbnVsbCB9PigpO1xuXG4gIGNvbnRleHRNZXRhKGNhcCA9IE1FVEFfU0NBTl9DQVApOiB7IG1hcDogUmVjb3JkPHN0cmluZywgRG9jU3VtbWFyeT47IHRydW5jYXRlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBtYXA6IFJlY29yZDxzdHJpbmcsIERvY1N1bW1hcnk+ID0ge307XG4gICAgbGV0IHNlZW4gPSAwO1xuICAgIGxldCB0cnVuY2F0ZWQgPSBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGZvciAoY29uc3QgYWJzIG9mIGRvY1BhdGhzKGUpKSB7XG4gICAgICAgIGlmIChzZWVuID49IGNhcCkge1xuICAgICAgICAgIHRydW5jYXRlZCA9IHRydWU7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgc2VlbisrO1xuICAgICAgICBsZXQgbXRpbWVNczogbnVtYmVyO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIG10aW1lTXMgPSBzdGF0U3luYyhhYnMpLm10aW1lTXM7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGhpdCA9IHRoaXMubWV0YUNhY2hlLmdldChhYnMpO1xuICAgICAgICBsZXQgc3VtbWFyeTogRG9jU3VtbWFyeSB8IG51bGw7XG4gICAgICAgIGlmIChoaXQgJiYgaGl0Lm10aW1lTXMgPT09IG10aW1lTXMpIHN1bW1hcnkgPSBoaXQuc3VtbWFyeTtcbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgc3VtbWFyeSA9IHN1bW1hcml6ZShyZWFkTWV0YShyZWFkSGVhZChhYnMpKSk7XG4gICAgICAgICAgdGhpcy5tZXRhQ2FjaGUuc2V0KGFicywgeyBtdGltZU1zLCBzdW1tYXJ5IH0pO1xuICAgICAgICB9XG4gICAgICAgIGlmIChzdW1tYXJ5KSBtYXBbYWJzXSA9IHN1bW1hcnk7XG4gICAgICB9XG4gICAgICBpZiAodHJ1bmNhdGVkKSBicmVhaztcbiAgICB9XG4gICAgcmV0dXJuIHsgbWFwLCB0cnVuY2F0ZWQgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBPbmUgZG9jdW1lbnQncyBmcm9udG1hdHRlciBhcyByZWFkLCBvciBldmVyeSBjb250ZXh0IGRvY3VtZW50J3MgKEUzMikuIFRoZVxuICAgKiBhZ2VudCBnZXRzIHRoZSBkYWVtb24ncyBwYXJzZSByYXRoZXIgdGhhbiByZS1yZWFkaW5nIHRoZSBZQU1MIGl0c2VsZi5cbiAgICovXG4gIG1ldGFGb3IocmF3UGF0aD86IHN0cmluZyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBpZiAocmF3UGF0aCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBhYnMgPSB0aGlzLnNob3duUGF0aChyYXdQYXRoKTtcbiAgICAgIGNvbnN0IG1ldGEgPSByZWFkTWV0YShyZWFkSGVhZChhYnMpKTtcbiAgICAgIHJldHVybiB7IHBhdGg6IGFicywgbWV0YSwgLi4uKG1ldGEgPyB7fSA6IHsgbm90ZTogXCJubyBmcm9udG1hdHRlciBibG9ja1wiIH0pIH07XG4gICAgfVxuICAgIGNvbnN0IG91dDogeyBwYXRoOiBzdHJpbmc7IG1ldGE6IERvY01ldGEgfCBudWxsIH1bXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dClcbiAgICAgIGZvciAoY29uc3QgYWJzIG9mIGRvY1BhdGhzKGUpKSBvdXQucHVzaCh7IHBhdGg6IGFicywgbWV0YTogcmVhZE1ldGEocmVhZEhlYWQoYWJzKSkgfSk7XG4gICAgcmV0dXJuIHsgZG9jdW1lbnRzOiBvdXQsIGNvdW50OiBvdXQubGVuZ3RoIH07XG4gIH1cblxuICAvKipcbiAgICogcGRvY3MncyBgZmluZGAsIG92ZXIgdGhpcyBzZXNzaW9uJ3MgY29udGV4dC4gU2FtZSBmaWx0ZXIgbmFtZXMsIHNhbWVcbiAgICogQU5EaW5nLCBhbmQgdGhlIHNhbWUgcnVsZSB0aGF0IGFuIGVtcHR5IHJlc3VsdCBpcyBhbiBBTlNXRVI6IGBjb3VudGAgc2F5c1xuICAgKiBob3cgbWFueSBtYXRjaGVkLCBhbmQgdGhlIGNhbGxlciByZWFkcyB0aGF0IHJhdGhlciB0aGFuIHRoZSBleGl0IGNvZGUuXG4gICAqL1xuICBmaW5kKGZpbHRlcjogTWV0YUZpbHRlcik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBtYXRjaGVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdID0gW107XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KVxuICAgICAgZm9yIChjb25zdCBhYnMgb2YgZG9jUGF0aHMoZSkpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHJlYWRNZXRhKHJlYWRIZWFkKGFicykpO1xuICAgICAgICBpZiAoIW1hdGNoZXNGaWx0ZXIobWV0YSwgZmlsdGVyKSkgY29udGludWU7XG4gICAgICAgIG1hdGNoZXMucHVzaCh7XG4gICAgICAgICAgcGF0aDogYWJzLFxuICAgICAgICAgIGVudHJ5OiBlLmlkLFxuICAgICAgICAgIC4uLihtZXRhPy50eXBlID8geyB0eXBlOiBtZXRhLnR5cGUgfSA6IHt9KSxcbiAgICAgICAgICAuLi4obWV0YT8udGl0bGUgPyB7IHRpdGxlOiBtZXRhLnRpdGxlIH0gOiB7fSksXG4gICAgICAgICAgLi4uKG1ldGE/LmRlc2NyaXB0aW9uID8geyBkZXNjcmlwdGlvbjogbWV0YS5kZXNjcmlwdGlvbiB9IDoge30pLFxuICAgICAgICAgIHN0YXR1czogbWV0YT8uc3RhdHVzID8/IG51bGwsXG4gICAgICAgICAgLi4uKG1ldGE/LmxpZmVjeWNsZSA/IHsgbGlmZWN5Y2xlOiBtZXRhLmxpZmVjeWNsZSB9IDoge30pLFxuICAgICAgICAgIHRhZ3M6IG1ldGE/LnRhZ3MgPz8gW10sXG4gICAgICAgICAgZGF0ZTogbWV0YT8uZGF0ZSA/PyBudWxsLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICByZXR1cm4geyBtYXRjaGVzLCBjb3VudDogbWF0Y2hlcy5sZW5ndGggfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBPbmUgc2V0J3MgbWFwIChFMzMpOiBpdHMgZG9jdW1lbnRzIGFzIG5vZGVzLCBhbmQgdGhlIGZvdXIgc291cmNlcyBvZiBlZGdlc1xuICAgKiDigJQgYm9keSBsaW5rcywgd2lraSBsaW5rcywgdHlwZWQgbGlua3MgYW5kIGZyb250bWF0dGVyIHJlZmVyZW5jZXMuXG4gICAqL1xuICBncmFwaEZvcihlbnRyeUlkPzogc3RyaW5nKTogR3JhcGhQYXlsb2FkIHtcbiAgICBjb25zdCBlID0gZW50cnlJZFxuICAgICAgPyB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4LmlkID09PSBlbnRyeUlkKVxuICAgICAgOiB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4Lm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIik7XG4gICAgaWYgKCFlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgZW50cnlJZCA/IGBubyBjb250ZXh0IGVudHJ5ICR7ZW50cnlJZH1gIDogXCJ0aGlzIHNlc3Npb24gaGFzIG5vIHNldCB0byBtYXBcIixcbiAgICAgICAgNDA0LFxuICAgICAgICB0aGlzLm0uY29udGV4dC5tYXAoKHgpID0+IHguaWQpLFxuICAgICAgKTtcbiAgICBjb25zdCBwYXRocyA9IGRvY1BhdGhzKGUpO1xuICAgIGNvbnN0IGluZGV4OiBCdW5kbGVJbmRleCA9IHtcbiAgICAgIHJvb3Q6IGUucm9vdCxcbiAgICAgIHBhdGhzLFxuICAgICAgbWV0YU9mOiAocCkgPT4gcmVhZE1ldGEocmVhZEhlYWQocCkpLFxuICAgICAgZXhpc3RzOiAocCkgPT4gZXhpc3RzU3luYyhwKSxcbiAgICAgIHJlcG9Sb290OiBnaXRSb290T2YoZS5yb290KSxcbiAgICB9O1xuICAgIGNvbnN0IGcgPSBidWlsZEdyYXBoKGluZGV4LCAocCkgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIHNwbGl0RnJvbnRtYXR0ZXIocmVhZEZpbGVTeW5jKHAsIFwidXRmOFwiKSkuYm9keTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gXCJcIjtcbiAgICAgIH1cbiAgICB9KTtcbiAgICByZXR1cm4geyBlbnRyeTogZS5pZCwgLi4uZyB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFNlYXJjaCBldmVyeXRoaW5nIGluIHRoZSBjb250ZXh0OiBmdXp6eSBvdmVyIG5hbWVzLCBleGFjdCBvdmVyIGNvbnRlbnQgKEU1OSkuXG4gICAqXG4gICAqIOKblCBUSElTIElTIFdIWSBUSEUgVkVSQiBFWElTVFMgQVQgQUxMLCBhbmQgdGhlIHJlYXNvbiBpcyBvbmUgbGluZTogYVxuICAgKiBkb2N1bWVudCBvcGVuIGluIHRoZSBzZXNzaW9uIGlzIHNob3duIGFzIGl0cyBBQ1RJVkUgVkVSU0lPTiwgd2hpY2ggbGl2ZXNcbiAgICogdW5kZXIgdGhlIHNlc3Npb24gaG9tZSBhbmQgbm90IGF0IHRoZSBvcmlnaW5hbCBwYXRoLiBBbiBhZ2VudCBncmVwcGluZyB0aGVcbiAgICogd29ya3NwYWNlIHRoZXJlZm9yZSBmaW5kcyB0aGUgU0FWRUQgZmlsZSBhbmQgc2lsZW50bHkgbWlzc2VzIHRoZSB0ZXh0IHRoZVxuICAgKiBodW1hbiBpcyByZWFkaW5nIOKAlCBzbyBcInNlYXJjaCB3aGF0IHlvdSBjYW4gc2VlXCIgaXMgYSBxdWVzdGlvbiBvbmx5IHRoZVxuICAgKiBzZXNzaW9uIGNhbiBhbnN3ZXIuIEV2ZXJ5dGhpbmcgZWxzZSBhYm91dCBzZWFyY2hpbmcgZmlsZXMsIGFuIGFnZW50IGNhblxuICAgKiBhbHJlYWR5IGRvIHdpdGggZ3JlcCwgd2hpY2ggaXMgd2h5IHRoZXJlIGlzIG5vIGluLWRvY3VtZW50IHZlcmIuXG4gICAqXG4gICAqIOKaoCBIaWRkZW4gZG9jdW1lbnRzIGFyZSBleGNsdWRlZCwgYmVjYXVzZSB0aGUgY29udGV4dCBpcyB3aGF0IHRoZSBodW1hblxuICAgKiBjaG9zZSB0byBsb29rIGF0OyBhIHJlc3VsdCB0aGV5IGNhbm5vdCBzZWUgaW4gdGhlIHNpZGViYXIgd291bGQgYmUgYSByZXN1bHRcbiAgICogdGhleSBjYW5ub3Qgb3Blbi5cbiAgICovXG4gIHNlYXJjaEFsbChvcHRzOiB7IHF1ZXJ5OiBzdHJpbmc7IGxpbWl0PzogbnVtYmVyIH0pOiBTZWFyY2hSZXBvcnQge1xuICAgIGNvbnN0IGNhbmRpZGF0ZXM6IENhbmRpZGF0ZVtdID0gW107XG4gICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGZvciAoY29uc3QgZW50cnkgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGZvciAoY29uc3QgcGF0aCBvZiBkb2NQYXRocyhlbnRyeSkpIHtcbiAgICAgICAgaWYgKHNlZW4uaGFzKHBhdGgpKSBjb250aW51ZTtcbiAgICAgICAgc2Vlbi5hZGQocGF0aCk7XG4gICAgICAgIGNvbnN0IHJlY29yZCA9IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQub3JpZ2luYWwgPT09IHBhdGgpO1xuICAgICAgICBjb25zdCB0aXRsZSA9IHJlYWRNZXRhKHJlYWRIZWFkKHBhdGgpKT8udGl0bGU7XG4gICAgICAgIGNhbmRpZGF0ZXMucHVzaCh7XG4gICAgICAgICAgcGF0aCxcbiAgICAgICAgICBuYW1lOiBiYXNlbmFtZShwYXRoKSxcbiAgICAgICAgICAuLi4ocmVjb3JkID8geyBzbHVnOiByZWNvcmQuc2x1ZywgdmVyc2lvbjogcmVjb3JkLmFjdGl2ZSB9IDoge30pLFxuICAgICAgICAgIC4uLih0aXRsZSA/IHsgdGl0bGUgfSA6IHt9KSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBzZWFyY2hEb2N1bWVudHMoXG4gICAgICBjYW5kaWRhdGVzLFxuICAgICAgb3B0cy5xdWVyeSxcbiAgICAgIChjKSA9PiB7XG4gICAgICAgIC8vIFRoZSBBQ1RJVkUgVkVSU0lPTiB3aGVuIHRoZSBzZXNzaW9uIGhhcyBvbmUg4oCUIHNlZSB0aGUgbm90ZSBhYm92ZS5cbiAgICAgICAgY29uc3QgcmVjb3JkID1cbiAgICAgICAgICBjLnNsdWcgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQuc2x1ZyA9PT0gYy5zbHVnKTtcbiAgICAgICAgaWYgKHJlY29yZCkgcmV0dXJuIHRoaXMuYWN0aXZlVGV4dChyZWNvcmQpO1xuICAgICAgICByZXR1cm4gcmVhZEZpbGVTeW5jKGMucGF0aCwgXCJ1dGY4XCIpO1xuICAgICAgfSxcbiAgICAgIG9wdHMubGltaXQgIT09IHVuZGVmaW5lZCA/IHsgdG90YWw6IG9wdHMubGltaXQgfSA6IHt9LFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogRXZlcnkgbGluayBpbiBhIHNldCB0aGF0IG5vdGhpbmcgYW5zd2VycyDigJQgdGhlIHJlcG9ydCB5b3UgY2FuIEFDVCBvbiAoRTU0KS5cbiAgICpcbiAgICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBncmFwaGAgQUxSRUFEWSBIQUQgVEhFIEZBQ1RTIEFORCBTVElMTCBESUQgTk9UIEFOU1dFUlxuICAgKiBUSEUgUVVFU1RJT04uIENvbGUgYXNrZWQgd2hldGhlciBhbiBhZ2VudCBjYW4gY2hlY2sgZGFuZ2xpbmcgbGlua3M7IHRoZVxuICAgKiBob25lc3QgYW5zd2VyIHdhcyBcInllcywgYnkgZmV0Y2hpbmcgYSBzZXQncyB3aG9sZSBtYXAgYW5kIGZpbHRlcmluZyBzZXZlcmFsXG4gICAqIGh1bmRyZWQgZWRnZXNcIiwgd2hpY2ggaXMgYSBkaWZmZXJlbnQgdGhpbmcgZnJvbSBiZWluZyBhYmxlIHRvIGNoZWNrIHRoZW0uXG4gICAqIFRoaXMgc2F5cyBvbmx5IHdoYXQgaXMgYnJva2VuLCBhbmQgc2F5cyBpdCBhcyBgZmlsZTpsaW5lYCBwbHVzIFRIRSBTVFJJTkdcbiAgICogVEhFIERPQ1VNRU5UIEFDVFVBTExZIENPTlRBSU5TIOKAlCB3aGljaCBpcyB3aGF0IHlvdSBuZWVkIHRvIHJlcGFpciBvbmUsIGFuZFxuICAgKiB3aGF0IHRoZSBtYXAncyByZXNvbHZlZCBgdG9gIGhhZCBxdWlldGx5IHRocm93biBhd2F5LlxuICAgKlxuICAgKiDimqAgTk9UIEFOIEVSUk9SLiBBIGRhbmdsaW5nIGxpbmsgaXMgYSBmYWN0IGFib3V0IGEgc2V0LCBub3QgYSBmYWlsdXJlOiBPS0ZcbiAgICogwqcxMSdzIHJ1bGUsIGFuZCBpdCBpcyB3aHkgdGhpcyByZXBvcnRzIGFuZCBleGl0cyB6ZXJvLiBEb2N1bWVudHMgdGhhdCBwb2ludFxuICAgKiBhdCB0aGluZ3Mgbm90IHdyaXR0ZW4geWV0IGFyZSBub3JtYWwgaW4gYSB3b3JsZCBiaWJsZS5cbiAgICovXG4gIGRhbmdsaW5nTGlua3MoZW50cnlJZD86IHN0cmluZyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBnID0gdGhpcy5ncmFwaEZvcihlbnRyeUlkKTtcbiAgICBjb25zdCBicm9rZW4gPSBnLmVkZ2VzLmZpbHRlcigoZSkgPT4gZS5zdGF0ZSA9PT0gXCJtaXNzaW5nXCIpO1xuICAgIC8vIOKblCBCT0RZIExJTkVTIEJFQ09NRSBGSUxFIExJTkVTIEhFUkUuIExpbmtzIGFyZSBleHRyYWN0ZWQgZnJvbSB0aGUgYm9keSxcbiAgICAvLyBzbyB0aGUgbnVtYmVyIHRoZSBncmFwaCBjYXJyaWVzIGlzIHNob3J0IGJ5IGhvd2V2ZXIgbXVjaCBmcm9udG1hdHRlciB0aGVcbiAgICAvLyBkb2N1bWVudCBoYXMg4oCUIGFuZCBhIHJlcG9ydCBpcyBmb3Igb3BlbmluZyBhIGZpbGUgYXQgYSBsaW5lLlxuICAgIGNvbnN0IG9mZnNldHMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICAgIGNvbnN0IG9mZnNldE9mID0gKHBhdGg6IHN0cmluZyk6IG51bWJlciA9PiB7XG4gICAgICBjb25zdCBrbm93biA9IG9mZnNldHMuZ2V0KHBhdGgpO1xuICAgICAgaWYgKGtub3duICE9PSB1bmRlZmluZWQpIHJldHVybiBrbm93bjtcbiAgICAgIGxldCBvZmYgPSAwO1xuICAgICAgdHJ5IHtcbiAgICAgICAgb2ZmID0gYm9keUxpbmVPZmZzZXQocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogdW5yZWFkYWJsZSDigJQgcmVwb3J0IHRoZSBib2R5IGxpbmUgcmF0aGVyIHRoYW4gbm90aGluZyAqL1xuICAgICAgfVxuICAgICAgb2Zmc2V0cy5zZXQocGF0aCwgb2ZmKTtcbiAgICAgIHJldHVybiBvZmY7XG4gICAgfTtcbiAgICByZXR1cm4ge1xuICAgICAgZW50cnk6IGcuZW50cnksXG4gICAgICByb290OiBnLnJvb3QsXG4gICAgICBjb3VudDogYnJva2VuLmxlbmd0aCxcbiAgICAgIGxpbmtzOiBicm9rZW4ubWFwKChlKSA9PiAoe1xuICAgICAgICBmcm9tOiBlLmZyb20sXG4gICAgICAgIC4uLihlLmxpbmUgIT09IHVuZGVmaW5lZCA/IHsgbGluZTogZS5saW5lICsgb2Zmc2V0T2YoZS5mcm9tKSB9IDoge30pLFxuICAgICAgICAvLyBXaGF0IHRoZSBkb2N1bWVudCBzYXlzLCBub3Qgd2hhdCB3ZSBsb29rZWQgZm9yLlxuICAgICAgICAuLi4oZS5yYXcgIT09IHVuZGVmaW5lZCA/IHsgd3JvdGU6IGUucmF3IH0gOiB7fSksXG4gICAgICAgIC8vIFdoZXJlIHRoZSByZXNvbHV0aW9uIGVuZGVkIHVwLCBzbyBhIG5lYXItbWlzcyBpcyB2aXNpYmxlLlxuICAgICAgICB0cmllZDogZS50byxcbiAgICAgICAgc291cmNlOiBlLnNvdXJjZSxcbiAgICAgICAgLi4uKGUua2V5ID8geyBrZXk6IGUua2V5IH0gOiB7fSksXG4gICAgICAgIC4uLihlLnJlbC5sZW5ndGggPyB7IHJlbDogZS5yZWwgfSA6IHt9KSxcbiAgICAgIH0pKSxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFdoYXQgY2l0ZXMgYSBkb2N1bWVudC4gYHJlbGF0ZWRgIChmcm9udG1hdHRlcikgYW5kIGBsaW5rc2AgKGJvZHkpIGFyZSBrZXB0XG4gICAqIEFQQVJULCB3aGljaCBpcyBob3cgcGRvY3MgcmVwb3J0cyBpdCBhbmQgdGhlIGRpc3RpbmN0aW9uIGlzIHJlYWw6IG9uZSBpcyBhXG4gICAqIGNsYWltIGFib3V0IHRoZSBkb2N1bWVudCwgdGhlIG90aGVyIGEgY2l0YXRpb24gaW4gcHJvc2UuXG4gICAqL1xuICBiYWNrbGlua3MocmF3UGF0aDogc3RyaW5nKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc2hvd25QYXRoKHJhd1BhdGgpO1xuICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5tLmNvbnRleHQuZmluZChcbiAgICAgIChlKSA9PiBlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiAmJiAoYWJzID09PSBlLnJvb3QgfHwgYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSksXG4gICAgKTtcbiAgICBpZiAoIWVudHJ5KSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Fic30gaXMgbm90IGluc2lkZSBhIHNldCwgc28gbm90aGluZyBtYXBzIGl0YCwgNDAwKTtcbiAgICBjb25zdCBnID0gdGhpcy5ncmFwaEZvcihlbnRyeS5pZCk7XG4gICAgY29uc3QgaW5ib3VuZCA9IGcuZWRnZXMuZmlsdGVyKCh4KSA9PiB4LnRvID09PSBhYnMpO1xuICAgIGNvbnN0IHRpdGxlID0gKHA6IHN0cmluZykgPT4gZy5ub2Rlcy5maW5kKChuKSA9PiBuLnBhdGggPT09IHApPy50aXRsZSA/PyBiYXNlbmFtZShwKTtcbiAgICByZXR1cm4ge1xuICAgICAgdGFyZ2V0OiB7IHBhdGg6IGFicywgdGl0bGU6IHRpdGxlKGFicykgfSxcbiAgICAgIHJlbGF0ZWQ6IGluYm91bmRcbiAgICAgICAgLmZpbHRlcigoeCkgPT4geC5zb3VyY2UgPT09IFwiZnJvbnRtYXR0ZXJcIilcbiAgICAgICAgLm1hcCgoeCkgPT4gKHsgcGF0aDogeC5mcm9tLCB0aXRsZTogdGl0bGUoeC5mcm9tKSwga2V5OiB4LmtleSB9KSksXG4gICAgICBsaW5rczogaW5ib3VuZFxuICAgICAgICAuZmlsdGVyKCh4KSA9PiB4LnNvdXJjZSA9PT0gXCJsaW5rXCIpXG4gICAgICAgIC5tYXAoKHgpID0+ICh7IHBhdGg6IHguZnJvbSwgdGl0bGU6IHRpdGxlKHguZnJvbSksIHJlbDogeC5yZWwgfSkpLFxuICAgICAgY291bnQ6IGluYm91bmQubGVuZ3RoLFxuICAgIH07XG4gIH1cblxuICAvKiogV2hlcmUgZG9lcyB0aGlzIGxpbmsgZ28/IFRoZSBzdXJmYWNlIGFza3MgYmVmb3JlIGZvbGxvd2luZyBvbmUgKEUzMykuICovXG4gIHJlc29sdmVMaW5rKGZyb206IHN0cmluZywgdGFyZ2V0OiBzdHJpbmcpOiBSZXNvbHV0aW9uIHtcbiAgICBjb25zdCBzcmMgPSB0aGlzLnNob3duUGF0aChmcm9tKTtcbiAgICBjb25zdCBlbnRyeSA9IHRoaXMubS5jb250ZXh0LmZpbmQoXG4gICAgICAoZSkgPT4gZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgJiYgc3JjLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSxcbiAgICApO1xuICAgIGNvbnN0IHJvb3QgPSBlbnRyeT8ucm9vdCA/PyBkaXJuYW1lKHNyYyk7XG4gICAgY29uc3QgcGF0aHMgPSBlbnRyeSA/IGRvY1BhdGhzKGVudHJ5KSA6IFtzcmNdO1xuICAgIHJldHVybiByZXNvbHZlVGFyZ2V0KHRhcmdldCwgc3JjLCB7XG4gICAgICByb290LFxuICAgICAgcGF0aHMsXG4gICAgICBtZXRhT2Y6IChwKSA9PiByZWFkTWV0YShyZWFkSGVhZChwKSksXG4gICAgICBleGlzdHM6IChwKSA9PiBleGlzdHNTeW5jKHApLFxuICAgICAgcmVwb1Jvb3Q6IGdpdFJvb3RPZihyb290KSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXaGF0IGEgZnJvbnRtYXR0ZXIgYmxvY2sgZm9yIHRoaXMgZG9jdW1lbnQgV09VTEQgc2F5IChFMzUpLiBTdWdnZXN0ZWQsIG5vdFxuICAgKiB3cml0dGVuOiB0aGUgdHlwZSBjb21lcyBmcm9tIHRoZSBkb2N1bWVudHMgYmVzaWRlIGl0LCB0aGUgdGl0bGUgZnJvbSBpdHNcbiAgICogb3duIEgxLCBhbmQgYGRlc2NyaXB0aW9uYCBpcyBsZWZ0IGJsYW5rIGZvciB3aG9ldmVyIGZpbGxzIGl0IGluLlxuICAgKi9cbiAgc3VnZ2VzdE1ldGEocmF3UGF0aDogc3RyaW5nLCBieT86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBibG9jazogc3RyaW5nOyB0eXBlPzogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc2hvd25QYXRoKHJhd1BhdGgpO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgaWYgKHNwbGl0RnJvbnRtYXR0ZXIodGV4dCkucmF3ICE9PSBudWxsKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHtiYXNlbmFtZShhYnMpfSBhbHJlYWR5IGhhcyBmcm9udG1hdHRlcmAsIDQwOSk7XG4gICAgY29uc3QgZm9sZGVyID0gZGlybmFtZShhYnMpO1xuICAgIGNvbnN0IHNpYmxpbmdzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dClcbiAgICAgIGZvciAoY29uc3QgcCBvZiBkb2NQYXRocyhlKSlcbiAgICAgICAgaWYgKHAgIT09IGFicyAmJiBkaXJuYW1lKHApID09PSBmb2xkZXIpIHtcbiAgICAgICAgICBjb25zdCB0ID0gcmVhZE1ldGEocmVhZEhlYWQocCkpPy50eXBlO1xuICAgICAgICAgIGlmICh0KSBzaWJsaW5ncy5wdXNoKHQpO1xuICAgICAgICB9XG4gICAgY29uc3QgdHlwZSA9IGd1ZXNzVHlwZShzaWJsaW5ncywgYmFzZW5hbWUoZm9sZGVyKSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHBhdGg6IGFicyxcbiAgICAgIHR5cGUsXG4gICAgICBibG9jazogYnVpbGRCbG9jayh7XG4gICAgICAgIC4uLih0eXBlID8geyB0eXBlIH0gOiB7fSksXG4gICAgICAgIC4uLih0aXRsZUZyb21Cb2R5KHRleHQpID8geyB0aXRsZTogdGl0bGVGcm9tQm9keSh0ZXh0KSBhcyBzdHJpbmcgfSA6IHt9KSxcbiAgICAgICAgLi4uKGJ5ID8geyBieSB9IDoge30pLFxuICAgICAgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXcml0ZSBhIG5ldyBibG9jayBpbnRvIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZSAoRTM1KS5cbiAgICpcbiAgICog4puUIFRISVMgV1JJVEVTIFRIRSBPUklHSU5BTCwgd2hpY2ggRTcgb3RoZXJ3aXNlIHJlc2VydmVzIGZvciBTYXZlIOKAlCBhbmRcbiAgICogdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW4gb3ZlcnNpZ2h0OiB0aGUgYWdlbnQncyB2ZXJiIHdyaXRlcyB0aGUgZmlsZSwgYW5kXG4gICAqIGlmIHRoZSBodW1hbiBoYXMgdW5zYXZlZCBlZGl0cyB0byBpdCB0aGUgQ09ORkxJQ1QgQkFSIGFwcGVhcnMgYW5kIHRoZXlcbiAgICogY2hvb3NlIChDb2xlOiBcIndlIGNhbiBhZGp1c3QgaWYgbmVlZGVkIGFmdGVyIGdldHRpbmcgYWN0dWFsIHVzYWdlIGJlaGluZFxuICAgKiB1c1wiKS4gUmVmdXNpbmcgd2hpbGUgYSBidWZmZXIgaXMgZGlydHkgd291bGQgbGV0IGFuIG9wZW4gZG9jdW1lbnQgYmxvY2sgdGhlXG4gICAqIGFnZW50IGluZGVmaW5pdGVseS4gVGhlIEhVTUFOJ3Mgb3duIHBhdGggbmV2ZXIgY29tZXMgaGVyZTogdGhlaXIgXCJhZGRcbiAgICogZnJvbnRtYXR0ZXJcIiBpcyBhbiBlZGl0IHRvIHRoZWlyIGJ1ZmZlciwgd2hpY2ggU2F2ZSB3cml0ZXMgbGlrZSBhbnkgb3RoZXIuXG4gICAqL1xuICBtZXRhSW5pdChyYXdQYXRoOiBzdHJpbmcsIG9wdHM6IHsgdHlwZT86IHN0cmluZzsgYnk/OiBzdHJpbmcgfSA9IHt9KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IHN1Z2dlc3RlZCA9IHRoaXMuc3VnZ2VzdE1ldGEocmF3UGF0aCwgb3B0cy5ieSk7XG4gICAgY29uc3QgYWJzID0gc3VnZ2VzdGVkLnBhdGg7XG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICBjb25zdCBibG9jayA9IG9wdHMudHlwZVxuICAgICAgPyBidWlsZEJsb2NrKHtcbiAgICAgICAgICB0eXBlOiBvcHRzLnR5cGUsXG4gICAgICAgICAgLi4uKHRpdGxlRnJvbUJvZHkodGV4dCkgPyB7IHRpdGxlOiB0aXRsZUZyb21Cb2R5KHRleHQpIGFzIHN0cmluZyB9IDoge30pLFxuICAgICAgICAgIC4uLihvcHRzLmJ5ID8geyBieTogb3B0cy5ieSB9IDoge30pLFxuICAgICAgICB9KVxuICAgICAgOiBzdWdnZXN0ZWQuYmxvY2s7XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIHdpdGhCbG9jayh0ZXh0LCBibG9jaykpO1xuICAgIHRoaXMubWV0YUNhY2hlLmRlbGV0ZShhYnMpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicywgdHlwZTogb3B0cy50eXBlID8/IHN1Z2dlc3RlZC50eXBlID8/IG51bGwsIGFkZGVkOiB0cnVlIH07XG4gIH1cblxuICAvKiogU2V0IGtleXMgaW4gYW4gZXhpc3RpbmcgYmxvY2sg4oCUIGEgTElORSBlZGl0IGVhY2gsIHNvIG5vdGhpbmcgZWxzZSBtb3Zlcy4gKi9cbiAgbWV0YVNldChyYXdQYXRoOiBzdHJpbmcsIHBhaXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc2hvd25QYXRoKHJhd1BhdGgpO1xuICAgIGxldCB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgIGlmIChzcGxpdEZyb250bWF0dGVyKHRleHQpLnJhdyA9PT0gbnVsbClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YmFzZW5hbWUoYWJzKX0gaGFzIG5vIGZyb250bWF0dGVyIOKAlCBhZGQgaXQgZmlyc3QgKG1ldGEtaW5pdClgLCA0MDkpO1xuICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHBhaXJzKSkge1xuICAgICAgaWYgKCEvXltBLVphLXpfXVtBLVphLXowLTlfLi1dKiQvLnRlc3Qoa2V5KSlcbiAgICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgXCIke2tleX1cIiBpcyBub3QgYSBmcm9udG1hdHRlciBrZXlgLCA0MDApO1xuICAgICAgdGV4dCA9IHNldEtleSh0ZXh0LCBrZXksIHZhbHVlKTtcbiAgICB9XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIHRleHQpO1xuICAgIHRoaXMubWV0YUNhY2hlLmRlbGV0ZShhYnMpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicywgc2V0OiBPYmplY3Qua2V5cyhwYWlycykgfTtcbiAgfVxuXG4gIC8qKiBUaGUgc2Vzc2lvbidzIGhhbGYgb2YgYFB1YmxpY1N0YXRlYDsgdGhlIGRhZW1vbiBhZGRzIHRoZSBob21lLWxldmVsIGBwcmVmc2AgYW5kIGB1c2VySG9tZWAuICovXG4gIC8qKlxuICAgKiBUaGUgY29udmVyc2F0aW9uLCB3aXRob3V0IGJ1aWxkaW5nIGEgc25hcHNob3QgYXJvdW5kIGl0LlxuICAgKlxuICAgKiDimqAgRTUzJ3MgYXR0ZW50aW9uIHRpY2sgcnVucyBldmVyeSBzZWNvbmQgYW5kIG9ubHkgbmVlZHMgdGhlIGNoYXQ7IGNhbGxpbmdcbiAgICogYHZpZXcoKWAgZm9yIGl0IHdvdWxkIHJlLXJlYWQgZXZlcnkgZG9jdW1lbnQncyBmcm9udG1hdHRlciBvbiBhIHRpbWVyLlxuICAgKi9cbiAgbWVzc2FnZXMoKTogcmVhZG9ubHkgQ2hhdE1lc3NhZ2VbXSB7XG4gICAgcmV0dXJuIHRoaXMubS5jaGF0O1xuICB9XG5cbiAgdmlldyhcbiAgICBtb2RlOiBcImRldlwiIHwgXCJyZWxlYXNlXCIsXG4gICAgc2VsZWN0aW9uOiBTZWxlY3Rpb24gfCBudWxsLFxuICAgIC8vIOKaoCBgd2FpdGluZ2AgaXMgdGhlIFNFUlZFUidzIHRvIGFkZCAoRTUzKTogaXQgZGVwZW5kcyBvbiB0aGUgY2xvY2sgYW5kIG9uXG4gICAgLy8gdGhlIHNub296ZSB0aGUgc2VydmVyIGhvbGRzLCBuZWl0aGVyIG9mIHdoaWNoIGJlbG9uZ3MgaW4gdGhlIHNlc3Npb24uXG4gICAgLy8g4pqgIGB3YWl0aW5nYCBhbmQgYGhpc3RvcnlgIGFyZSB0aGUgU0VSVkVSJ3MgdG8gYWRkIChFNTMsIEU2MCk6IG9uZSBkZXBlbmRzXG4gICAgLy8gb24gdGhlIGNsb2NrIGFuZCB0aGUgc25vb3plIGl0IGhvbGRzLCB0aGUgb3RoZXIgb24gdGhlIGluLW1lbW9yeSBhY3RcbiAgICAvLyBzdGFja3MuIE5laXRoZXIgYmVsb25ncyBpbiB0aGUgc2Vzc2lvbidzIHBlcnNpc3RlZCBzdGF0ZS5cbiAgKTogT21pdDxQdWJsaWNTdGF0ZSwgXCJwcmVmc1wiIHwgXCJ1c2VySG9tZVwiIHwgXCJ3YWl0aW5nXCIgfCBcImhpc3RvcnlcIj4ge1xuICAgIGNvbnN0IG1ldGEgPSB0aGlzLmNvbnRleHRNZXRhKCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNlc3Npb25JZDogdGhpcy5tLnNlc3Npb25JZCxcbiAgICAgIGhvbWU6IHRoaXMuaG9tZSxcbiAgICAgIHdvcmtzcGFjZTogdGhpcy53b3Jrc3BhY2UsXG4gICAgICBkb2NNZXRhOiBtZXRhLm1hcCxcbiAgICAgIC4uLihtZXRhLnRydW5jYXRlZCA/IHsgZG9jTWV0YVRydW5jYXRlZDogdHJ1ZSB9IDoge30pLFxuICAgICAgbW9kZSxcbiAgICAgIGNvbnRleHQ6IHRoaXMubS5jb250ZXh0LFxuICAgICAgZG9jczogdGhpcy5tLmRvY3MubWFwKChkKSA9PiB0aGlzLmRvY1ZpZXcoZCkpLFxuICAgICAgb3BlbkRvYzogdGhpcy5tLm9wZW5Eb2MsXG4gICAgICBzZWxlY3Rpb24sXG4gICAgICBjaGF0OiB0aGlzLm0uY2hhdCxcbiAgICAgIHRhc2tzOiB0aGlzLnRhc2tzKCksXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIFRoZSBnaXQgd29ya2luZyB0cmVlIGBkaXJgIGlzIGluLCBvciBudWxsLiBBIGAuZ2l0YCBFTlRSWSwgbm90IGEgZGlyZWN0b3J5XG4gKiB0ZXN0OiBhIHdvcmt0cmVlIGFuZCBhIHN1Ym1vZHVsZSBib3RoIGhhdmUgYC5naXRgIGFzIGEgRklMRS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdpdFJvb3RPZihkaXI6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBsZXQgYXQgPSBkaXI7XG4gIGZvciAoOzspIHtcbiAgICBpZiAoZXhpc3RzU3luYyhqb2luKGF0LCBcIi5naXRcIikpKSByZXR1cm4gYXQ7XG4gICAgY29uc3QgdXAgPSBkaXJuYW1lKGF0KTtcbiAgICBpZiAodXAgPT09IGF0KSByZXR1cm4gbnVsbDtcbiAgICBhdCA9IHVwO1xuICB9XG59XG5cbi8qKiBEb2N1bWVudHMgdW5kZXIgYSBmb2xkZXIsIGZvciBzYXlpbmcgaG93IG11Y2ggYSBtb3ZlIG1vdmVzLiAqL1xuZnVuY3Rpb24gY291bnREb2NzKGRpcjogc3RyaW5nKTogbnVtYmVyIHtcbiAgbGV0IG4gPSAwO1xuICBjb25zdCB3YWxrID0gKGF0OiBzdHJpbmcpID0+IHtcbiAgICBsZXQgbmFtZXM6IHN0cmluZ1tdO1xuICAgIHRyeSB7XG4gICAgICBuYW1lcyA9IHJlYWRkaXJTeW5jKGF0KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzKSB7XG4gICAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgICBjb25zdCBhYnMgPSBqb2luKGF0LCBuYW1lKTtcbiAgICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHdhbGsoYWJzKTtcbiAgICAgIGVsc2UgaWYgKGlzRG9jTmFtZShuYW1lKSkgbisrO1xuICAgIH1cbiAgfTtcbiAgd2FsayhkaXIpO1xuICByZXR1cm4gbjtcbn1cblxuLyoqXG4gKiBIb3cgYSBjb21wYXJpc29uIHNpZGUgcmVhZHMgaW4gYSBtZXNzYWdlIHRvIGEgaHVtYW4gb3IgYW4gYWdlbnQuXG4gKlxuICog4puUIFRIRSBGSUxFIElTIE5BTUVELCBOT1QgREVTQ1JJQkVEIChFNDMsIHJldmlzZWQpLiBcIlRoZSBvcmlnaW5hbFwiIHNvdW5kZWRcbiAqIHRlbXBvcmFsIHdoZW4gdGhlIHRoaW5nIGlzIGxvY2F0aW9uYWw7IFwidGhlIHNhdmVkIGZpbGVcIiBmaXhlZCB0aGF0IGJ1dCByZWFkc1xuICogY2lyY3VsYXIgdGhlIG1vbWVudCBpdCBpcyBhIERFU1RJTkFUSU9OIOKAlCBcInNhdmUgdG8gdGhlIHNhdmVkIGZpbGVcIiBzYXlzXG4gKiBub3RoaW5nLiBObyBub3VuIGVuY2Fwc3VsYXRlcyBcInRoaXMgZmlsZSwgYXQgdGhpcyBwbGFjZVwiLCBzbyB0aGUgZmlsZSBnZXRzXG4gKiBpdHMgb3duIG5hbWU6IGBub3RlLm1kYC4gQ29sZTogXCJ0aGF0J3MgcHJvYmFibHkgY2xvc2VyIHRvIHRoZSByaWdodCBhbnN3ZXJcbiAqIHZlcnN1cyB0cnlpbmcgdG8gY29tZSB1cCB3aXRoIGEgd29yZCB0aGF0IGVuY2Fwc3VsYXRlcyBpdC5cIlxuICpcbiAqIGBmaWxlYCBpcyB0aGUgZG9jdW1lbnQncyBuYW1lIHdoZW4gdGhlIGNhbGxlciBrbm93cyBpdDsgd2l0aG91dCBvbmUgdGhpc1xuICogZmFsbHMgYmFjayB0byBhIGdlbmVyaWMsIHdoaWNoIGlzIG9ubHkgZm9yIGNvbnRleHRzIHRoYXQgaGF2ZSBubyBkb2N1bWVudCBpblxuICogaGFuZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNpZGVOYW1lKHNpZGU6IERpZmZTaWRlLCBmaWxlPzogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHNpZGUgIT09IFwib3JpZ2luYWxcIikgcmV0dXJuIGB2JHtzaWRlfWA7XG4gIHJldHVybiBmaWxlID8/IFwidGhlIHNhdmVkIGZpbGVcIjtcbn1cbiIsCiAgICAiLyoqXG4gKiBPS0YgZnJvbnRtYXR0ZXIsIHJlYWQgKEUzMikuIFRoZSBkYWVtb24gcGFyc2VzOyB0aGUgc3VyZmFjZSByZW5kZXJzIHdoYXQgaXRcbiAqIGlzIGdpdmVuIOKAlCBgQnVuLllBTUwucGFyc2VgIGlzIGhlcmUsIHNvIG5vIFlBTUwgcGFyc2VyIHJlYWNoZXMgdGhlIGJyb3dzZXIuXG4gKlxuICog4puUIFRIRSBTUEVDJ1MgVEVNUEVSIElTIFRIRSBQT0lOVCwgQU5EIElUIElTIE5PVCBUSEUgVVNVQUwgT05FLiBBIGNvbnN1bWVyXG4gKiBcIk1VU1QgTk9UIHJlamVjdCBkb2N1bWVudHNcIiBmb3IgdW5rbm93biB0eXBlcywgdW5rbm93biBrZXlzLCBtaXNzaW5nIG9wdGlvbmFsXG4gKiBmaWVsZHMgb3IgYnJva2VuIGxpbmtzLCBhbmQgXCJTSE9VTEQgcHJlc2VydmUgdW5rbm93biBrZXlzIHdoZW4gcm91bmQtdHJpcHBpbmdcIlxuICogKE9LRiAwLjIgwqcxMSkuIFNvIG5vdGhpbmcgaGVyZSB2YWxpZGF0ZXM6IGEgZG9jdW1lbnQgd2hvc2UgZnJvbnRtYXR0ZXIgd2lsbFxuICogbm90IHBhcnNlIGtlZXBzIGl0cyB0ZXh0IGFuZCByZXBvcnRzIHRoZSByZWFzb24sIGV2ZXJ5IGtleSBzdXJ2aXZlcyBpblxuICogYGZpZWxkc2Agd2hldGhlciBvciBub3QgdGhpcyBzcGVsbCBoYXMgaGVhcmQgb2YgaXQsIGFuZCBgdHlwZWAg4oCUIHRoZSBPTkVcbiAqIHJlcXVpcmVkIGZpZWxkIOKAlCBiZWluZyBhYnNlbnQgaXMgYSBmYWN0IHRvIHNob3csIG5ldmVyIGFuIGVycm9yIHRvIHJhaXNlLlxuICpcbiAqIFRoZSBERVJJVkVEIHZhbHVlcyAodHJ1c3QsIHN0YWxlbmVzcykgYXJlIGNvbXB1dGVkIG9uIHJlYWQgYW5kIG5ldmVyIHN0b3JlZCxcbiAqIHdoaWNoIGlzIGFsc28gdGhlIHNwZWMncyBydWxlOiBhIHRydXN0IHRpZXIgd3JpdHRlbiBpbnRvIGEgZmlsZSB3b3VsZCBiZSBhXG4gKiBjbGFpbSBhYm91dCBpdHNlbGYuXG4gKi9cbmltcG9ydCB0eXBlIHsgRG9jTWV0YSwgRG9jU3VtbWFyeSwgVHJ1c3RUaWVyIH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcblxuLyoqIEEgZnJvbnRtYXR0ZXIgYmxvY2s6IGAtLS1gIG9uIGl0cyBvd24gZmlyc3QgbGluZSwgdG8gdGhlIG5leHQgYC0tLWAgbGluZS4gKi9cbmNvbnN0IEJMT0NLID0gL14tLS1cXHI/XFxuKFtcXHNcXFNdKj8pXFxyP1xcbi0tLVsgXFx0XSooPzpcXHI/XFxufCQpLztcblxuLyoqXG4gKiBTcGxpdCBhIGRvY3VtZW50IGludG8gaXRzIHJhdyBmcm9udG1hdHRlciBibG9jayBhbmQgdGhlIGJvZHkgYmVuZWF0aCBpdC5cbiAqIFB1cmUgc3RyaW5nIHdvcmssIG5vIFlBTUwg4oCUIHRoZSBTVVJGQUNFIGhhcyB0aGUgc2FtZSBmdW5jdGlvbiAoaXQgbXVzdCBzdHJpcFxuICogdGhlIGJsb2NrIGJlZm9yZSByZW5kZXJpbmcpIGFuZCBgZnJvbnRtYXR0ZXIudGVzdC50c2AgaG9sZHMgdGhlIHR3byBlcXVhbC5cbiAqL1xuLyoqXG4gKiBIb3cgbWFueSBsaW5lcyBvZiBhIGRvY3VtZW50IGNvbWUgQkVGT1JFIGl0cyBib2R5IOKAlCB0aGUgZnJvbnRtYXR0ZXIgYmxvY2sgYW5kXG4gKiBpdHMgZGVsaW1pdGVycy5cbiAqXG4gKiDim5QgV0lUSE9VVCBUSElTIEEgUkVQT1JURUQgTElORSBOVU1CRVIgSVMgQSBMSUUuIExpbmtzIGFyZSBleHRyYWN0ZWQgZnJvbSB0aGVcbiAqIEJPRFksIHNvIGEgbGluayBvbiBib2R5IGxpbmUgOSBvZiBhIGRvY3VtZW50IHdpdGggZm91ciBsaW5lcyBvZiBmcm9udG1hdHRlclxuICogaXMgb24gRklMRSBsaW5lIDEzIOKAlCBhbmQgYSByZXBvcnQgdGhhdCBzYXlzIDkgc2VuZHMgd2hvZXZlciBpcyBmaXhpbmcgaXQgdG9cbiAqIHRoZSB3cm9uZyBwbGFjZSwgY29uZmlkZW50bHkuIENhdWdodCB0aGUgbW9tZW50IEU1NCdzIHJlcG9ydCB3YXMgZmlyc3QgcmVhZFxuICogYWdhaW5zdCBhIGRvY3VtZW50IHRoYXQgaGFkIGZyb250bWF0dGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYm9keUxpbmVPZmZzZXQodGV4dDogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgeyBib2R5IH0gPSBzcGxpdEZyb250bWF0dGVyKHRleHQpO1xuICBjb25zdCBwcmVmaXggPSB0ZXh0LnNsaWNlKDAsIHRleHQubGVuZ3RoIC0gYm9keS5sZW5ndGgpO1xuICBsZXQgbGluZXMgPSAwO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHByZWZpeC5sZW5ndGg7IGkrKykgaWYgKHByZWZpeC5jaGFyQ29kZUF0KGkpID09PSAxMCkgbGluZXMrKztcbiAgcmV0dXJuIGxpbmVzO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3BsaXRGcm9udG1hdHRlcih0ZXh0OiBzdHJpbmcpOiB7IHJhdzogc3RyaW5nIHwgbnVsbDsgYm9keTogc3RyaW5nIH0ge1xuICBjb25zdCBtID0gQkxPQ0suZXhlYyh0ZXh0KTtcbiAgaWYgKCFtKSByZXR1cm4geyByYXc6IG51bGwsIGJvZHk6IHRleHQgfTtcbiAgcmV0dXJuIHsgcmF3OiBtWzFdID8/IFwiXCIsIGJvZHk6IHRleHQuc2xpY2UobVswXS5sZW5ndGgpIH07XG59XG5cbi8qKiBPS0YncyB0aHJlZSwgYW5kIGFueXRoaW5nIGVsc2UgYSBwcm9kdWNlciB3cm90ZS4gYHN0YWJsZWAgaXMgdGhlIGRlZmF1bHQuICovXG5mdW5jdGlvbiBzdGF0dXNPZihmaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogc3RyaW5nIHtcbiAgY29uc3QgcyA9IGZpZWxkcy5zdGF0dXM7XG4gIHJldHVybiB0eXBlb2YgcyA9PT0gXCJzdHJpbmdcIiAmJiBzLnRyaW0oKSAhPT0gXCJcIiA/IHMgOiBcInN0YWJsZVwiO1xufVxuXG5jb25zdCBhc0xpc3QgPSAodjogdW5rbm93bik6IHN0cmluZ1tdID0+XG4gIEFycmF5LmlzQXJyYXkodikgPyB2LmZpbHRlcigoeCkgPT4gdHlwZW9mIHggPT09IFwic3RyaW5nXCIpIDogdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgPyBbdl0gOiBbXTtcblxuLyoqIEFuIGFjdG9yIGlzIGh1bWFuIGlmZiBpdCBpcyBzcGVsbGVkIGBodW1hbjo8aWQ+YCDigJQgT0tGIDAuMiDCpzYncyBydWxlLiAqL1xuY29uc3QgaXNIdW1hbiA9IChhY3RvcjogdW5rbm93bik6IGJvb2xlYW4gPT5cbiAgdHlwZW9mIGFjdG9yID09PSBcInN0cmluZ1wiICYmIGFjdG9yLnRvTG93ZXJDYXNlKCkuc3RhcnRzV2l0aChcImh1bWFuOlwiKTtcblxuLyoqXG4gKiBPS0YncyB0cnVzdCB0aWVycywgREVSSVZFRDogbm8gYHZlcmlmaWVkYCDihpIgdW52ZXJpZmllZDsgdmVyaWZpZWQgYnkgbWFjaGluZXNcbiAqIG9ubHkg4oaSIG1hY2hpbmUtY29uZmlybWVkOyB2ZXJpZmllZCBieSBhIGBodW1hbjo8aWQ+YCDihpIgaHVtYW4tcmV2aWV3ZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0cnVzdFRpZXIoZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFRydXN0VGllciB7XG4gIGNvbnN0IHZlcmlmaWVkID0gZmllbGRzLnZlcmlmaWVkO1xuICBjb25zdCBldmVudHMgPSBBcnJheS5pc0FycmF5KHZlcmlmaWVkKSA/IHZlcmlmaWVkIDogdmVyaWZpZWQgPyBbdmVyaWZpZWRdIDogW107XG4gIGlmIChldmVudHMubGVuZ3RoID09PSAwKSByZXR1cm4gXCJ1bnZlcmlmaWVkXCI7XG4gIGZvciAoY29uc3QgZSBvZiBldmVudHMpXG4gICAgaWYgKGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgaXNIdW1hbigoZSBhcyB7IGJ5PzogdW5rbm93biB9KS5ieSkpIHJldHVybiBcImh1bWFuLXJldmlld2VkXCI7XG4gIHJldHVybiBcIm1hY2hpbmUtY29uZmlybWVkXCI7XG59XG5cbi8qKiBgc3RhbGVfYWZ0ZXJgIGlzIGFuIElOU1RBTlQsIG5vdCBhIFRUTDogc3RhbGUgd2hlbiBub3cgPj0gaXQuICovXG5leHBvcnQgZnVuY3Rpb24gaXNTdGFsZShmaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBub3c6IG51bWJlcik6IGJvb2xlYW4ge1xuICBjb25zdCBhdCA9IGZpZWxkcy5zdGFsZV9hZnRlcjtcbiAgY29uc3QgdCA9XG4gICAgYXQgaW5zdGFuY2VvZiBEYXRlID8gYXQuZ2V0VGltZSgpIDogdHlwZW9mIGF0ID09PSBcInN0cmluZ1wiID8gRGF0ZS5wYXJzZShhdCkgOiBOdW1iZXIuTmFOO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHQpICYmIG5vdyA+PSB0O1xufVxuXG4vKiogV2hlbiB0aGUgY29udGVudCBsYXN0IG1lYW5pbmdmdWxseSBjaGFuZ2VkLCBwZXIgYGdlbmVyYXRlZC5hdGAsIGFzIGFuIElTTyBkYXRlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdlbmVyYXRlZEF0KGZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgZyA9IGZpZWxkcy5nZW5lcmF0ZWQ7XG4gIGNvbnN0IGF0ID0gZyAmJiB0eXBlb2YgZyA9PT0gXCJvYmplY3RcIiA/IChnIGFzIHsgYXQ/OiB1bmtub3duIH0pLmF0IDogdW5kZWZpbmVkO1xuICBpZiAoYXQgaW5zdGFuY2VvZiBEYXRlKSByZXR1cm4gYXQudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCk7XG4gIGlmICh0eXBlb2YgYXQgPT09IFwic3RyaW5nXCIpIHtcbiAgICBjb25zdCB0ID0gRGF0ZS5wYXJzZShhdCk7XG4gICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZSh0KSA/IG5ldyBEYXRlKHQpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApIDogYXQ7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmNvbnN0IHN0ciA9ICh2OiB1bmtub3duKTogc3RyaW5nIHwgdW5kZWZpbmVkID0+XG4gIHR5cGVvZiB2ID09PSBcInN0cmluZ1wiICYmIHYudHJpbSgpICE9PSBcIlwiID8gdi50cmltKCkgOiB1bmRlZmluZWQ7XG5cbi8qKlxuICogUmVhZCBhIGRvY3VtZW50J3MgZnJvbnRtYXR0ZXIuIFJldHVybnMgbnVsbCB3aGVuIHRoZXJlIGlzIG5vIGJsb2NrIGF0IGFsbCDigJRcbiAqIHdoaWNoIGlzIGEgbm9ybWFsIGRvY3VtZW50LCBub3QgYSBkZWZlY3QuIEEgYmxvY2sgdGhhdCB3aWxsIG5vdCBwYXJzZSBjb21lc1xuICogYmFjayB3aXRoIGBlcnJvcmAgc2V0IGFuZCBldmVyeSBvdGhlciBmaWVsZCBlbXB0eTogc2FpZCwgbm90IHN3YWxsb3dlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWRNZXRhKHRleHQ6IHN0cmluZywgbm93ID0gRGF0ZS5ub3coKSk6IERvY01ldGEgfCBudWxsIHtcbiAgY29uc3QgeyByYXcgfSA9IHNwbGl0RnJvbnRtYXR0ZXIodGV4dCk7XG4gIGlmIChyYXcgPT09IG51bGwpIHJldHVybiBudWxsO1xuICBsZXQgZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICBsZXQgZXJyb3I6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQgPSBCdW4uWUFNTC5wYXJzZShyYXcpIGFzIHVua25vd247XG4gICAgaWYgKHBhcnNlZCAmJiB0eXBlb2YgcGFyc2VkID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHBhcnNlZCkpXG4gICAgICBmaWVsZHMgPSBwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgZWxzZSBpZiAocGFyc2VkICE9PSBudWxsICYmIHBhcnNlZCAhPT0gdW5kZWZpbmVkKVxuICAgICAgZXJyb3IgPSBcInRoZSBmcm9udG1hdHRlciBpcyBub3QgYSBtYXBwaW5nIG9mIGtleXMgdG8gdmFsdWVzXCI7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBlcnJvciA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZS5zcGxpdChcIlxcblwiKVswXSA6IFN0cmluZyhlKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIHJhdyxcbiAgICBmaWVsZHMsXG4gICAgdHlwZTogc3RyKGZpZWxkcy50eXBlKSxcbiAgICB0aXRsZTogc3RyKGZpZWxkcy50aXRsZSksXG4gICAgZGVzY3JpcHRpb246IHN0cihmaWVsZHMuZGVzY3JpcHRpb24pLFxuICAgIHN0YXR1czogc3RhdHVzT2YoZmllbGRzKSxcbiAgICB0YWdzOiBhc0xpc3QoZmllbGRzLnRhZ3MpLFxuICAgIGxpZmVjeWNsZTogc3RyKGZpZWxkcy5saWZlY3ljbGUpLFxuICAgIHRydXN0OiB0cnVzdFRpZXIoZmllbGRzKSxcbiAgICBzdGFsZTogaXNTdGFsZShmaWVsZHMsIG5vdyksXG4gICAgZGF0ZTogZ2VuZXJhdGVkQXQoZmllbGRzKSxcbiAgICAuLi4oZXJyb3IgPyB7IGVycm9yIH0gOiB7fSksXG4gIH07XG59XG5cbi8qKiBUaGUgc21hbGwgc2hhcGUgdGhlIHNpZGViYXIgbmVlZHMgZm9yIGV2ZXJ5IGNvbnRleHQgZG9jdW1lbnQuICovXG5leHBvcnQgZnVuY3Rpb24gc3VtbWFyaXplKG1ldGE6IERvY01ldGEgfCBudWxsKTogRG9jU3VtbWFyeSB8IG51bGwge1xuICBpZiAoIW1ldGEpIHJldHVybiBudWxsO1xuICByZXR1cm4ge1xuICAgIC4uLihtZXRhLnR5cGUgPyB7IHR5cGU6IG1ldGEudHlwZSB9IDoge30pLFxuICAgIC4uLihtZXRhLnRpdGxlID8geyB0aXRsZTogbWV0YS50aXRsZSB9IDoge30pLFxuICAgIHN0YXR1czogbWV0YS5zdGF0dXMsXG4gICAgdGFnczogbWV0YS50YWdzLFxuICAgIHRydXN0OiBtZXRhLnRydXN0LFxuICAgIHN0YWxlOiBtZXRhLnN0YWxlLFxuICAgIC4uLihtZXRhLmxpZmVjeWNsZSA/IHsgbGlmZWN5Y2xlOiBtZXRhLmxpZmVjeWNsZSB9IDoge30pLFxuICAgIC4uLihtZXRhLmVycm9yID8geyBlcnJvcjogbWV0YS5lcnJvciB9IDoge30pLFxuICB9O1xufVxuXG4vKiogcGRvY3MncyBmaWx0ZXIgdm9jYWJ1bGFyeSwgc28gd2hhdCB0aGUgaHVtYW4gbGVhcm5zIHRoZXJlIGhvbGRzIGhlcmUuICovXG5leHBvcnQgdHlwZSBNZXRhRmlsdGVyID0ge1xuICB0eXBlPzogc3RyaW5nO1xuICBzdGF0dXM/OiBzdHJpbmc7XG4gIGxpZmVjeWNsZT86IHN0cmluZztcbiAgdGFnPzogc3RyaW5nO1xuICAvKiogQW4gSVNPIGRhdGU7IG1hdGNoZXMgZG9jdW1lbnRzIHdob3NlIGBnZW5lcmF0ZWQuYXRgIGlzIG9uIG9yIGFmdGVyIGl0LiAqL1xuICBzaW5jZT86IHN0cmluZztcbn07XG5cbi8qKlxuICogRmlsdGVycyBhcmUgQU5EZWQsIGFuZCBldmVyeSBvbmUgaXMgb3B0aW9uYWwg4oCUIGEgYmFyZSBmaWx0ZXIgbWF0Y2hlcyBhbGwuXG4gKlxuICog4puUIEEgRE9DVU1FTlQgV0lUSCBOTyBGUk9OVE1BVFRFUiBNQVRDSEVTIE9OTFkgVEhFIEVNUFRZIEZJTFRFUiwgYW5kIHRoYXRcbiAqIGluY2x1ZGVzIGAtLXN0YXR1cyBzdGFibGVgLiBBYnNlbnQgYHN0YXR1c2AgZGVmYXVsdHMgdG8gYHN0YWJsZWAgZm9yIGFuIE9LRlxuICogZG9jdW1lbnQgKMKnNSksIGJ1dCBhIGRvY3VtZW50IHdpdGggbm8gYmxvY2sgYXQgYWxsIGlzIG5vdCBtYWtpbmcgdGhlIGNsYWltOlxuICogYGZpbmQgLS1zdGF0dXMgc3RhYmxlYCBhc2tzIHdoaWNoIGRvY3VtZW50cyBTQVkgdGhleSBhcmUgc3RhYmxlLCBhbmQgYSBmaWxlXG4gKiB3aXRoIG5vIGZyb250bWF0dGVyIHNheXMgbm90aGluZy4gUmVhZGluZyB0aGUgZGVmYXVsdCB0aGUgb3RoZXIgd2F5IHdvdWxkIHB1dFxuICogZXZlcnkgdW50b3VjaGVkIG5vdGUgaW4gdGhlIHJlc3VsdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hdGNoZXNGaWx0ZXIobWV0YTogRG9jTWV0YSB8IG51bGwsIGZpbHRlcjogTWV0YUZpbHRlcik6IGJvb2xlYW4ge1xuICBpZiAobWV0YSA9PT0gbnVsbCkgcmV0dXJuIE9iamVjdC52YWx1ZXMoZmlsdGVyKS5ldmVyeSgodikgPT4gdiA9PT0gdW5kZWZpbmVkKTtcbiAgaWYgKGZpbHRlci50eXBlICE9PSB1bmRlZmluZWQgJiYgbWV0YS50eXBlICE9PSBmaWx0ZXIudHlwZSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoZmlsdGVyLnN0YXR1cyAhPT0gdW5kZWZpbmVkICYmIG1ldGEuc3RhdHVzICE9PSBmaWx0ZXIuc3RhdHVzKSByZXR1cm4gZmFsc2U7XG4gIGlmIChmaWx0ZXIubGlmZWN5Y2xlICE9PSB1bmRlZmluZWQgJiYgbWV0YS5saWZlY3ljbGUgIT09IGZpbHRlci5saWZlY3ljbGUpIHJldHVybiBmYWxzZTtcbiAgaWYgKGZpbHRlci50YWcgIT09IHVuZGVmaW5lZCAmJiAhbWV0YS50YWdzLmluY2x1ZGVzKGZpbHRlci50YWcpKSByZXR1cm4gZmFsc2U7XG4gIGlmIChmaWx0ZXIuc2luY2UgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICghbWV0YS5kYXRlKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKG1ldGEuZGF0ZSA8IGZpbHRlci5zaW5jZSkgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyDilIDilIAgV1JJVElORyAoRTM1KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyDim5QgRVZFUlkgV1JJVEUgSEVSRSBJUyBBIFRFWFQgRURJVCwgTkVWRVIgQSBSRVNFUklBTElTQVRJT04uIFBhcnNpbmcgYSBibG9ja1xuLy8gYW5kIHByaW50aW5nIGl0IGJhY2sgcmVvcmRlcnMga2V5cywgZHJvcHMgY29tbWVudHMgYW5kIGNoYW5nZXMgcXVvdGluZyDigJQgYW5kXG4vLyB0aGUgc3BlYyBhc2tzIGEgY29uc3VtZXIgdG8gXCJwcmVzZXJ2ZSB1bmtub3duIGtleXMgd2hlbiByb3VuZC10cmlwcGluZ1wiXG4vLyAowqcxMSksIHdoaWNoIGlzIHByZWNpc2VseSB3aGF0IHRoYXQgbG9zZXMuIFNvIGEgbmV3IGJsb2NrIGlzIEJVSUxUICh0aGVyZSBpc1xuLy8gbm90aGluZyB0byBwcmVzZXJ2ZSB5ZXQpIGFuZCBhbiBleGlzdGluZyBvbmUgaXMgZWRpdGVkIGEgTElORSBhdCBhIHRpbWUuXG5cbi8qKiBUaGUgZG9jdW1lbnQncyBmaXJzdCBIMSwgd2hpY2ggaXMgdGhlIHRpdGxlIGEgaHVtYW4gYWxyZWFkeSB3cm90ZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0aXRsZUZyb21Cb2R5KGJvZHk6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGZvciAoY29uc3QgbGluZSBvZiBib2R5LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgY29uc3QgbSA9IC9eI1xccysoLis/KVxccyokLy5leGVjKGxpbmUpO1xuICAgIGlmIChtKSByZXR1cm4gbVsxXTtcbiAgICBpZiAobGluZS50cmltKCkgIT09IFwiXCIgJiYgIWxpbmUuc3RhcnRzV2l0aChcIiNcIikpIGJyZWFrOyAvLyBwcm9zZSBiZWZvcmUgYW55IGhlYWRpbmdcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIEEgYHR5cGVgIHRvIFNVR0dFU1QgZm9yIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZS5cbiAqXG4gKiDim5QgRlJPTSBUSEUgTkVJR0hCT1VSUywgTkVWRVIgRlJPTSBBIEZJWEVEIExJU1QuIE9LRidzIGB0eXBlYCBpcyBcIm5vdFxuICogY2VudHJhbGx5IHJlZ2lzdGVyZWRcIiBhbmQgZXZlcnkgY29ycHVzIGludmVudHMgaXRzIG93biDigJQgYHJlcG9ydGAsIGBydWxlYCxcbiAqIGBhcmNoZXR5cGVgIGluIG9uZSwgc29tZXRoaW5nIGVsc2UgaW4gdGhlIG5leHQg4oCUIHNvIHRoZSBvbmx5IGhvbmVzdCBzb3VyY2UgaXNcbiAqIHdoYXQgdGhlIGRvY3VtZW50cyBiZXNpZGUgdGhpcyBvbmUgYWxyZWFkeSBzYXkuIFRoZSBmb2xkZXIncyBuYW1lIGlzIHRoZVxuICogZmFsbGJhY2ssIGFuZCB3aGVuIG5laXRoZXIgYW5zd2Vycywgbm90aGluZyBpcyBzdWdnZXN0ZWQ6IGEgYmxhbmsgdGhlIGh1bWFuXG4gKiBmaWxscyBiZWF0cyBhIHBsYXVzaWJsZSBndWVzcyAoU0NIRU1BLm1kJ3Mgb3duIHJ1bGUgYWJvdXQgYGdlbmVyYXRlZC5ieWApLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ3Vlc3NUeXBlKHNpYmxpbmdUeXBlczogcmVhZG9ubHkgc3RyaW5nW10sIGZvbGRlcjogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgY291bnRzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgZm9yIChjb25zdCB0IG9mIHNpYmxpbmdUeXBlcykgaWYgKHQpIGNvdW50cy5zZXQodCwgKGNvdW50cy5nZXQodCkgPz8gMCkgKyAxKTtcbiAgY29uc3QgYmVzdCA9IFsuLi5jb3VudHMuZW50cmllcygpXS5zb3J0KChhLCBiKSA9PiBiWzFdIC0gYVsxXSB8fCBhWzBdLmxvY2FsZUNvbXBhcmUoYlswXSkpWzBdO1xuICBpZiAoYmVzdCkgcmV0dXJuIGJlc3RbMF07XG4gIGNvbnN0IG5hbWUgPSBmb2xkZXIudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChuYW1lID09PSBcIlwiIHx8IG5hbWUgPT09IFwiLlwiIHx8IG5hbWUgPT09IFwiL1wiKSByZXR1cm4gdW5kZWZpbmVkO1xuICAvLyBgZGVjaXNpb25zL2Ag4oaSIGBkZWNpc2lvbmA7IGBkb2NzL2Ag4oaSIGBkb2NgLiBBIHBsdXJhbCBmb2xkZXIgbmFtZXMgaXRzIGtpbmQuXG4gIHJldHVybiBuYW1lLmVuZHNXaXRoKFwiaWVzXCIpXG4gICAgPyBgJHtuYW1lLnNsaWNlKDAsIC0zKX15YFxuICAgIDogbmFtZS5lbmRzV2l0aChcInNcIilcbiAgICAgID8gbmFtZS5zbGljZSgwLCAtMSlcbiAgICAgIDogbmFtZTtcbn1cblxuLyoqIEEgWUFNTCBzY2FsYXIsIHF1b3RlZCBvbmx5IHdoZW4gaXQgbXVzdCBiZS4gKi9cbmZ1bmN0aW9uIHNjYWxhcih2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIC9eW1xcdyAuLCcnL0ArLV0qJC8udGVzdCh2YWx1ZSkgJiYgIS9eXFxzfFxccyQvLnRlc3QodmFsdWUpICYmIHZhbHVlICE9PSBcIlwiXG4gICAgPyB2YWx1ZVxuICAgIDogSlNPTi5zdHJpbmdpZnkodmFsdWUpO1xufVxuXG5leHBvcnQgdHlwZSBOZXdNZXRhID0ge1xuICB0eXBlPzogc3RyaW5nO1xuICB0aXRsZT86IHN0cmluZztcbiAgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gIHN0YXR1cz86IHN0cmluZztcbiAgdGFncz86IHN0cmluZ1tdO1xuICAvKiogYGdlbmVyYXRlZC5ieWAg4oCUIHRoZSBhY3RvciwgcmVjb3JkZWQgaG9uZXN0bHkgb3IgbGVmdCBgdW5rbm93bmAuICovXG4gIGJ5Pzogc3RyaW5nO1xuICBhdD86IHN0cmluZztcbn07XG5cbi8qKlxuICogQSBmcm9udG1hdHRlciBibG9jayBmb3IgYSBkb2N1bWVudCB0aGF0IGhhcyBub25lLiBPS0YncyByZWNvbW1lbmRlZCBzZXQgaW5cbiAqIHRoZSBvcmRlciB0aGUgY29ycG9yYSB3cml0ZSBpdCwgd2l0aCBgZGVzY3JpcHRpb25gIGxlZnQgRU1QVFkgZm9yIHRoZSBhdXRob3I6XG4gKiBhIG9uZS1saW5lIHN1bW1hcnkgbm9ib2R5IHdyb3RlIGlzIHdvcnNlIHRoYW4gYSBibGFuayB0aGF0IGFza3MgdG8gYmUgZmlsbGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRCbG9jayhtZXRhOiBOZXdNZXRhKTogc3RyaW5nIHtcbiAgY29uc3QgYXQgPSBtZXRhLmF0ID8/IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCk7XG4gIGNvbnN0IGxpbmVzID0gW1xuICAgIGB0eXBlOiAke3NjYWxhcihtZXRhLnR5cGUgPz8gXCJcIil9YCxcbiAgICBgdGl0bGU6ICR7c2NhbGFyKG1ldGEudGl0bGUgPz8gXCJcIil9YCxcbiAgICBgZGVzY3JpcHRpb246ICR7bWV0YS5kZXNjcmlwdGlvbiA/IHNjYWxhcihtZXRhLmRlc2NyaXB0aW9uKSA6IFwiXCJ9YCxcbiAgICBgdGFnczogWyR7KG1ldGEudGFncyA/PyBbXSkubWFwKHNjYWxhcikuam9pbihcIiwgXCIpfV1gLFxuICAgIGBzdGF0dXM6ICR7c2NhbGFyKG1ldGEuc3RhdHVzID8/IFwiZHJhZnRcIil9YCxcbiAgICBgZ2VuZXJhdGVkOiB7IGJ5OiAke3NjYWxhcihtZXRhLmJ5ID8/IFwidW5rbm93blwiKX0sIGF0OiAke2F0fSB9YCxcbiAgXTtcbiAgcmV0dXJuIGAtLS1cXG4ke2xpbmVzLmpvaW4oXCJcXG5cIil9XFxuLS0tXFxuYDtcbn1cblxuLyoqXG4gKiBQdXQgYSBuZXcgYmxvY2sgYXQgdGhlIHRvcCBvZiBhIGRvY3VtZW50IHRoYXQgaGFzIG5vbmUuIE5vIGJsYW5rIGxpbmUgaXNcbiAqIGluc2VydGVkOiB0aGUgY29ycG9yYSB3cml0ZSB0aGUgYm9keSBkaXJlY3RseSB1bmRlciB0aGUgY2xvc2luZyBgLS0tYCwgYW5kIGFcbiAqIGJsb2NrIHRoYXQgYWRkcyBvbmUgd291bGQgc2hvdyBhcyBhIGRpZmYgb24gZXZlcnkgZG9jdW1lbnQgaXQgdG91Y2hlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdpdGhCbG9jayh0ZXh0OiBzdHJpbmcsIGJsb2NrOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7YmxvY2t9JHt0ZXh0fWA7XG59XG5cbi8qKlxuICogU2V0IG9uZSBrZXkgaW4gYW4gRVhJU1RJTkcgYmxvY2ssIGFzIGEgbGluZSBlZGl0OiB0aGUga2V5J3MgbGluZSBpcyByZXBsYWNlZFxuICogd2hlcmUgaXQgZXhpc3RzIGFuZCBhcHBlbmRlZCBiZWZvcmUgdGhlIGNsb3NpbmcgYC0tLWAgd2hlcmUgaXQgZG9lcyBub3QuXG4gKiBFdmVyeXRoaW5nIGVsc2Ug4oCUIG9yZGVyLCBjb21tZW50cywgc3BhY2luZywga2V5cyB0aGlzIHNwZWxsIG5ldmVyIGhlYXJkIG9mIOKAlFxuICogc3Vydml2ZXMgYnl0ZSBmb3IgYnl0ZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldEtleSh0ZXh0OiBzdHJpbmcsIGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgeyByYXcgfSA9IHNwbGl0RnJvbnRtYXR0ZXIodGV4dCk7XG4gIGlmIChyYXcgPT09IG51bGwpIHRocm93IG5ldyBFcnJvcihcInRoaXMgZG9jdW1lbnQgaGFzIG5vIGZyb250bWF0dGVyIGJsb2NrXCIpO1xuICBjb25zdCBsaW5lID0gYCR7a2V5fTogJHtzY2FsYXIodmFsdWUpfWA7XG4gIGNvbnN0IGtleUxpbmUgPSBuZXcgUmVnRXhwKGBeJHtrZXkucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xcXVxcXFxdL2csIFwiXFxcXCQmXCIpfVxcXFxzKjpgKTtcbiAgY29uc3QgbGluZXMgPSByYXcuc3BsaXQoXCJcXG5cIik7XG4gIGNvbnN0IGF0ID0gbGluZXMuZmluZEluZGV4KChsKSA9PiBrZXlMaW5lLnRlc3QobCkpO1xuICBpZiAoYXQgPT09IC0xKSBsaW5lcy5wdXNoKGxpbmUpO1xuICBlbHNlIHtcbiAgICAvLyBBIG11bHRpLWxpbmUgdmFsdWUgKGEgZm9sZGVkIGRlc2NyaXB0aW9uLCBhIG5lc3RlZCBtYXBwaW5nKSBpcyB0aGVcbiAgICAvLyBrZXkncyBsaW5lIFBMVVMgZXZlcnkgaW5kZW50ZWQgbGluZSB1bmRlciBpdDsgYWxsIG9mIHRoZW0gZ28uXG4gICAgbGV0IGVuZCA9IGF0ICsgMTtcbiAgICB3aGlsZSAoZW5kIDwgbGluZXMubGVuZ3RoICYmIC9eXFxzK1xcUy8udGVzdChsaW5lc1tlbmRdID8/IFwiXCIpKSBlbmQrKztcbiAgICBsaW5lcy5zcGxpY2UoYXQsIGVuZCAtIGF0LCBsaW5lKTtcbiAgfVxuICBjb25zdCByZWJ1aWx0ID0gbGluZXMuam9pbihcIlxcblwiKTtcbiAgcmV0dXJuIHRleHQucmVwbGFjZShyYXcsIHJlYnVpbHQpO1xufVxuIiwKICAgICIvKipcbiAqIExpbmtzIGJldHdlZW4gZG9jdW1lbnRzIChFMzMpOiB3aGF0IGEgZG9jdW1lbnQgcG9pbnRzIGF0LCBhbmQgd2hhdCB0aGF0XG4gKiByZXNvbHZlcyB0byBpbnNpZGUgYSBzZXQuXG4gKlxuICog4pSA4pSAIEZPVVIgU09VUkNFUyBPRiBFREdFUywgQU5EIFRIRVkgQVJFIE5PVCBPTkUgS0lORCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAgIDEuIG1hcmtkb3duIGxpbmtzICAgICAgYFtsYWJlbF0oLi9vdGhlci5tZClgICAgICAg4oCUIGJvZHlcbiAqICAgMi4gd2lraSBsaW5rcyAgICAgICAgICBgW1tvdGhlci1kb2N8bGFiZWxdXWAgICAgICDigJQgYm9keVxuICogICAzLiBmcm9udG1hdHRlciB2YWx1ZXMgIGByZWxhdGVkOiBbY29uY2VwdC94XWAgICAgIOKAlCBhdXRob3JlZCBpbnRlbnRcbiAqICAgNC4gYHNvdXJjZXNbXS5yZXNvdXJjZWAgICAgICAgICAgICAgICAgICAgICAgICAgICDigJQgYXV0aG9yZWQgaW50ZW50XG4gKlxuICogcGRvY3Mga2VlcHMgdGhlIGZyb250bWF0dGVyIGVkZ2UgYW5kIHRoZSBib2R5LWxpbmsgZWRnZSBBUEFSVCAoYHJlbGF0ZWRbXWBcbiAqIGFuZCBgbGlua3NbXWAgaW4gaXRzIGBiYWNrbGlua3NgIG91dHB1dCksIGFuZCB0aGUgZGlzdGluY3Rpb24gaXMgcmVhbDogYVxuICogYHJlbGF0ZWRgIGtleSBpcyBhIGNsYWltIHRoZSBhdXRob3IgbWFkZSBhYm91dCB0aGUgZG9jdW1lbnQgYXMgYSB3aG9sZSwgYVxuICogYm9keSBsaW5rIGlzIGEgY2l0YXRpb24gYXQgYSBwbGFjZSBpbiB0aGUgcHJvc2UuIFRoZXkgc3RheSBhcGFydCBoZXJlIHRvby5cbiAqXG4gKiDilIDilIAgVFlQRUQgTElOS1MgKE9wZXJhdG9yJ3Mgc2hhcGUsIENvbGUgMjAyNi0wOS0xMSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQSByZWxhdGlvbiByaWRlcyB0aGUgbGluayBhcyBhIHF1ZXJ5OiBgW2xhYmVsXSguL290aGVyLm1kP3JlbD1leHRlbmRzKWAsXG4gKiBgW1tvdGhlcj9yZWw9c3VwZXJzZWRlc3xsYWJlbF1dYC4gQ29waWVkIGV4YWN0bHkgZnJvbSBPcGVyYXRvcidzIHBhcnNlclxuICogKGBwYWNrYWdlcy9zaGFyZWQvc3JjL2xpbmtzL2ApOiBvbmUgbGluayBjYXJyaWVzIEFMTCBvZiBpdHMgcmVscywgdGhleSBhcmVcbiAqIG5vcm1hbGlzZWQgKGxvd2VyY2FzZWQsIHRyaW1tZWQsIGRlZHVwZWQsIGZpcnN0LWF1dGhvcmVkIG9yZGVyIGtlcHQpIGJ1dFxuICogdGhlaXIgU1BFTExJTkcgaXMgbm90IGNhbm9uaWNhbGlzZWQsIGFuZCAqKmEgYmFyZSBsaW5rIGlzIGBbXWAg4oCUIHRoZSBBQlNFTkNFXG4gKiBvZiBhbiBhc3NlcnRpb24sIG5vdCBhbiBpbXBsaWNpdCBgcmVmZXJlbmNlc2AqKi4gQSBncmFwaCBtdXN0IG5vdCBkcmF3IGFcbiAqIGNsYWltIG5vYm9keSBtYWRlLlxuICpcbiAqIOKUgOKUgCBXSEFUIEEgQlVORExFIElTIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIE9LRidzIGJ1bmRsZS1yZWxhdGl2ZSBmb3JtIChgL2NvbmNlcHRzL3gubWRgKSBtZWFucyB0aGUgQlVORExFIHJvb3QsIG5vdCB0aGVcbiAqIGZpbGVzeXN0ZW0gcm9vdCwgc28gYSByZXNvbHZlciBuZWVkcyBhIGJ1bmRsZSBiZWZvcmUgaXQgY2FuIHJlc29sdmUgYW55dGhpbmc6XG4gKiAqKmEgc2V0J3MgZW50cnkgcm9vdCBpcyB0aGUgYnVuZGxlKiogKEUzMykuIEEgdGFyZ2V0IHRoYXQgZXNjYXBlcyBpdCBpcyBub3QgYW5cbiAqIGVycm9yIOKAlCB0aGUgc3BlYyByZXF1aXJlcyB0b2xlcmF0aW5nIGJyb2tlbiBsaW5rcyDigJQgaXQgaXMgYW4gZWRnZSBtYXJrZWRcbiAqIGBvdXRzaWRlYCBvciBgbWlzc2luZ2AsIHdoaWNoIHRoZSBzdXJmYWNlIG9mZmVycyB0byBhZGQgcmF0aGVyIHRoYW4gZm9sbG93LlxuICovXG5pbXBvcnQge1xuICBiYXNlbmFtZSxcbiAgZGlybmFtZSxcbiAgZXh0bmFtZSxcbiAgam9pbixcbiAgbm9ybWFsaXplLFxuICByZWxhdGl2ZSxcbiAgcmVzb2x2ZSBhcyByZXNvbHZlUGF0aCxcbn0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBEb2NNZXRhIH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcbmltcG9ydCB7IHRvUG9zaXggfSBmcm9tIFwiLi90cmVlXCI7XG5cbmV4cG9ydCB0eXBlIExpbmtLaW5kID0gXCJtYXJrZG93blwiIHwgXCJ3aWtpXCI7XG5cbi8qKiBPbmUgbGluayBhcyB3cml0dGVuLCBiZWZvcmUgYW55dGhpbmcgaXMgcmVzb2x2ZWQuICovXG5leHBvcnQgdHlwZSBMaW5rUmVmID0ge1xuICBraW5kOiBMaW5rS2luZDtcbiAgLyoqIFRoZSB0YXJnZXQgYXMgYXV0aG9yZWQsIHdpdGggaXRzIHF1ZXJ5IGFuZCBhbmNob3Igc3RyaXBwZWQuICovXG4gIHRhcmdldDogc3RyaW5nO1xuICAvKipcbiAgICogVGhlIHRhcmdldCBFWEFDVExZIGFzIHdyaXR0ZW4g4oCUIHF1ZXJ5LCBhbmNob3IsIHBlcmNlbnQtZW5jb2RpbmcgYW5kIGFsbC5cbiAgICpcbiAgICog4puUIFRISVMgSVMgV0hBVCBNQUtFUyBBIERBTkdMSU5HIExJTksgRklYQUJMRS4gYHRhcmdldGAgaXMgdGhlIHJlc29sdmVkXG4gICAqIHNoYXBlLCBzbyBhIHJlcG9ydCBidWlsdCBmcm9tIGl0IHRlbGxzIHlvdSB0byBsb29rIGZvciBgZGVlcC5tZGAgd2hlbiB0aGVcbiAgICogZG9jdW1lbnQgYWN0dWFsbHkgc2F5cyBgLi9taXNzaW5nL2RlZXAubWQ/cmVsPXhgIOKAlCBhIHN0cmluZyB0aGF0IGlzIG5vdCBpblxuICAgKiB0aGUgZmlsZS4gV2hvZXZlciAob3Igd2hhdGV2ZXIpIGdvZXMgdG8gcmVwYWlyIHRoZSBsaW5rIG5lZWRzIHRoZSBzdHJpbmdcbiAgICogdGhhdCBpcyB0aGVyZS5cbiAgICovXG4gIHJhdzogc3RyaW5nO1xuICAvKiogMS1iYXNlZCBsaW5lIGluIHRoZSBib2R5IHRoZSBsaW5rIHdhcyB3cml0dGVuIG9uLCBmb3IgdGhlIHNhbWUgcmVhc29uLiAqL1xuICBsaW5lOiBudW1iZXI7XG4gIC8qKiBSZWxhdGlvbnMgZnJvbSBgP3JlbD1gOyBFTVBUWSBtZWFucyBubyBhc3NlcnRpb24sIG5ldmVyIGByZWZlcmVuY2VzYC4gKi9cbiAgcmVsOiBzdHJpbmdbXTtcbiAgbGFiZWw/OiBzdHJpbmc7XG59O1xuXG4vKiogQSByZWZlcmVuY2UgZm91bmQgaW4gZnJvbnRtYXR0ZXIsIHdpdGggdGhlIGtleSB0aGF0IGNhcnJpZWQgaXQuICovXG5leHBvcnQgdHlwZSBGaWVsZFJlZiA9IHsga2V5OiBzdHJpbmc7IHZhbHVlOiBzdHJpbmcgfTtcblxuY29uc3QgRkVOQ0VfTElORSA9IC9eKD86YGBgfH5+fikvO1xuXG4vKipcbiAqIFN0cmlwIGZlbmNlZCBjb2RlIGJsb2Nrcy4gQSBkb2N1bWVudCBhYm91dCBsaW5rcyBxdW90ZXMgbGluayBzeW50YXgsIGFuZCB0aGVcbiAqIHdpa2kgdGhpcyB3YXMgYnVpbHQgYWdhaW5zdCBkb2VzIGV4YWN0bHkgdGhhdCDigJQgd2l0aG91dCB0aGlzLCBTQ0hFTUEubWQnc1xuICogZXhhbXBsZXMgYmVjb21lIGVkZ2VzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd2l0aG91dEZlbmNlcyhib2R5OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGxldCBmZW5jZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGZvciAoY29uc3QgbGluZSBvZiBib2R5LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgY29uc3QgbSA9IEZFTkNFX0xJTkUuZXhlYyhsaW5lKTtcbiAgICBpZiAoZmVuY2UgPT09IG51bGwgJiYgbSkge1xuICAgICAgZmVuY2UgPSBtWzBdO1xuICAgICAgb3V0LnB1c2goXCJcIik7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGZlbmNlICE9PSBudWxsKSB7XG4gICAgICBpZiAobSAmJiBsaW5lLnN0YXJ0c1dpdGgoZmVuY2UpKSBmZW5jZSA9IG51bGw7XG4gICAgICBvdXQucHVzaChcIlwiKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBvdXQucHVzaChsaW5lKTtcbiAgfVxuICByZXR1cm4gb3V0LmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKiBgP3JlbD1hLGJgIOKGkiBgW1wiYVwiLFwiYlwiXWAsIG5vcm1hbGlzZWQgdGhlIHdheSBPcGVyYXRvciBub3JtYWxpc2VzIHRoZW0uICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VSZWwocXVlcnk6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZ1tdIHtcbiAgaWYgKCFxdWVyeSkgcmV0dXJuIFtdO1xuICBjb25zdCBtID0gLyg/Ol58Wz8mXSlyZWw9KFteJl0qKS8uZXhlYyhxdWVyeSk7XG4gIGlmICghbSkgcmV0dXJuIFtdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCByYXcgb2YgZGVjb2RlVVJJQ29tcG9uZW50KG1bMV0gPz8gXCJcIikuc3BsaXQoXCIsXCIpKSB7XG4gICAgY29uc3QgcmVsID0gcmF3LnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAgIGlmIChyZWwgPT09IFwiXCIgfHwgc2Vlbi5oYXMocmVsKSkgY29udGludWU7XG4gICAgc2Vlbi5hZGQocmVsKTtcbiAgICBvdXQucHVzaChyZWwpO1xuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBTcGxpdCBhIHdyaXR0ZW4gdGFyZ2V0IGludG8gaXRzIHBhdGgsIGl0cyBxdWVyeSBhbmQgaXRzIGFuY2hvci4gKi9cbi8qKlxuICogUGVyY2VudC1kZWNvZGluZywgd2hpY2ggYSBtYXJrZG93biBsaW5rIHRhcmdldCBjYXJyaWVzIHdoZW5ldmVyIHRoZSBmaWxlIGl0XG4gKiBuYW1lcyBoYXMgYSBzcGFjZSBpbiBpdCDigJQgYE1hcmVuJ3MlMjBCYWtlcnkubWRgIChFNDkpLlxuICpcbiAqIOKblCBJVCBNVVNUIE5PVCBUSFJPVy4gYGRlY29kZVVSSUNvbXBvbmVudGAgcmVqZWN0cyBhIGxvbmUgYCVgLCBhbmQgYSBmaWxlXG4gKiBjYWxsZWQgYDEwMCUgZG9uZS5tZGAgaXMgYSBwZXJmZWN0bHkgb3JkaW5hcnkgdGhpbmcgdG8gbGluayB0by4gQW5cbiAqIHVuZGVjb2RhYmxlIHRhcmdldCBpcyByZXR1cm5lZCBhcyBpdCBzdGFuZHM6IHdvcnN0IGNhc2UgaXQgZmFpbHMgdG8gcmVzb2x2ZSxcbiAqIHdoaWNoIGlzIHRoZSBiZWhhdmlvdXIgYmVmb3JlIGRlY29kaW5nIGV4aXN0ZWQsIHJhdGhlciB0aGFuIHRha2luZyB0aGUgZ3JhcGhcbiAqIGRvd24gd2l0aCBpdC5cbiAqL1xuZnVuY3Rpb24gZGVjb2RlUGF0aChyYXc6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghcmF3LmluY2x1ZGVzKFwiJVwiKSkgcmV0dXJuIHJhdztcbiAgdHJ5IHtcbiAgICByZXR1cm4gZGVjb2RlVVJJQ29tcG9uZW50KHJhdyk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiByYXc7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNwbGl0VGFyZ2V0KHJhdzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IHF1ZXJ5Pzogc3RyaW5nOyBhbmNob3I/OiBzdHJpbmcgfSB7XG4gIGNvbnN0IGhhc2ggPSByYXcuaW5kZXhPZihcIiNcIik7XG4gIGNvbnN0IHdpdGhvdXRBbmNob3IgPSBoYXNoID09PSAtMSA/IHJhdyA6IHJhdy5zbGljZSgwLCBoYXNoKTtcbiAgY29uc3QgYW5jaG9yID0gaGFzaCA9PT0gLTEgPyB1bmRlZmluZWQgOiByYXcuc2xpY2UoaGFzaCArIDEpO1xuICBjb25zdCBxID0gd2l0aG91dEFuY2hvci5pbmRleE9mKFwiP1wiKTtcbiAgcmV0dXJuIHtcbiAgICBwYXRoOiBkZWNvZGVQYXRoKChxID09PSAtMSA/IHdpdGhvdXRBbmNob3IgOiB3aXRob3V0QW5jaG9yLnNsaWNlKDAsIHEpKS50cmltKCkpLFxuICAgIC4uLihxID09PSAtMSA/IHt9IDogeyBxdWVyeTogd2l0aG91dEFuY2hvci5zbGljZShxICsgMSkgfSksXG4gICAgLi4uKGFuY2hvciA/IHsgYW5jaG9yIH0gOiB7fSksXG4gIH07XG59XG5cbmNvbnN0IEVYVEVSTkFMID0gL15bYS16XVthLXowLTkrLi1dKjovaTtcbmNvbnN0IE1EX0xJTksgPSAvKCE/KVxcWyhbXlxcXVxcbl0qKVxcXVxcKChbXilcXHNdKykoPzpcXHMrXCJbXlwiXSpcIik/XFwpL2c7XG5jb25zdCBXSUtJX0xJTksgPSAvXFxbXFxbKFteXFxdXFxuXSspXFxdXFxdL2c7XG5cbi8qKiBFdmVyeSBsaW5rIGEgZG9jdW1lbnQncyBCT0RZIHBvaW50cyBhdCDigJQgZXh0ZXJuYWwgdGFyZ2V0cyBhbmQgaW1hZ2VzIGxlZnQgb3V0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RMaW5rcyhib2R5OiBzdHJpbmcpOiBMaW5rUmVmW10ge1xuICBjb25zdCB0ZXh0ID0gd2l0aG91dEZlbmNlcyhib2R5KTtcbiAgY29uc3Qgb3V0OiBMaW5rUmVmW10gPSBbXTtcbiAgLy8g4pqgIExJTkUgTlVNQkVSUyBTVVJWSVZFIGB3aXRob3V0RmVuY2VzYCBBTkQgT0ZGU0VUUyBETyBOT1Q6IGl0IGJsYW5rcyBlYWNoXG4gIC8vIGZlbmNlZCBsaW5lIHJhdGhlciB0aGFuIGRlbGV0aW5nIGl0LCBzbyB0aGUgbGluZSBDT1VOVCBpcyBwcmVzZXJ2ZWQgd2hpbGVcbiAgLy8gdGhlIGNoYXJhY3RlciBvZmZzZXRzIGFyZSBub3QuIENvdW50aW5nIG5ld2xpbmVzIGlzIHRoZXJlZm9yZSBzb3VuZDsgdXNpbmdcbiAgLy8gYG0uaW5kZXhgIGFzIGEgY2hhcmFjdGVyIHBvc2l0aW9uIGluIHRoZSBvcmlnaW5hbCBib2R5IHdvdWxkIG5vdCBiZS5cbiAgY29uc3QgbGluZUF0ID0gKGF0OiBudW1iZXIpID0+IHtcbiAgICBsZXQgbGluZSA9IDE7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBhdCAmJiBpIDwgdGV4dC5sZW5ndGg7IGkrKykgaWYgKHRleHQuY2hhckNvZGVBdChpKSA9PT0gMTApIGxpbmUrKztcbiAgICByZXR1cm4gbGluZTtcbiAgfTtcbiAgZm9yIChjb25zdCBtIG9mIHRleHQubWF0Y2hBbGwoTURfTElOSykpIHtcbiAgICBpZiAobVsxXSA9PT0gXCIhXCIpIGNvbnRpbnVlOyAvLyBhbiBpbWFnZSBpcyBub3QgYSBkb2N1bWVudCBsaW5rXG4gICAgY29uc3QgcmF3ID0gbVszXSA/PyBcIlwiO1xuICAgIGlmIChFWFRFUk5BTC50ZXN0KHJhdykgfHwgcmF3LnN0YXJ0c1dpdGgoXCIjXCIpKSBjb250aW51ZTtcbiAgICBjb25zdCB7IHBhdGgsIHF1ZXJ5IH0gPSBzcGxpdFRhcmdldChyYXcpO1xuICAgIGlmIChwYXRoID09PSBcIlwiKSBjb250aW51ZTtcbiAgICBvdXQucHVzaCh7XG4gICAgICBraW5kOiBcIm1hcmtkb3duXCIsXG4gICAgICB0YXJnZXQ6IHBhdGgsXG4gICAgICByYXcsXG4gICAgICBsaW5lOiBsaW5lQXQobS5pbmRleCA/PyAwKSxcbiAgICAgIHJlbDogcGFyc2VSZWwocXVlcnkpLFxuICAgICAgLi4uKG1bMl0gPyB7IGxhYmVsOiBtWzJdIH0gOiB7fSksXG4gICAgfSk7XG4gIH1cbiAgZm9yIChjb25zdCBtIG9mIHRleHQubWF0Y2hBbGwoV0lLSV9MSU5LKSkge1xuICAgIGNvbnN0IGlubmVyID0gbVsxXSA/PyBcIlwiO1xuICAgIGNvbnN0IHBpcGUgPSBpbm5lci5pbmRleE9mKFwifFwiKTtcbiAgICBjb25zdCB0YXJnZXRQYXJ0ID0gcGlwZSA9PT0gLTEgPyBpbm5lciA6IGlubmVyLnNsaWNlKDAsIHBpcGUpO1xuICAgIGNvbnN0IGxhYmVsID0gcGlwZSA9PT0gLTEgPyB1bmRlZmluZWQgOiBpbm5lci5zbGljZShwaXBlICsgMSkudHJpbSgpO1xuICAgIGNvbnN0IHsgcGF0aCwgcXVlcnkgfSA9IHNwbGl0VGFyZ2V0KHRhcmdldFBhcnQpO1xuICAgIGlmIChwYXRoID09PSBcIlwiKSBjb250aW51ZTtcbiAgICBvdXQucHVzaCh7XG4gICAgICBraW5kOiBcIndpa2lcIixcbiAgICAgIHRhcmdldDogcGF0aCxcbiAgICAgIHJhdzogdGFyZ2V0UGFydCxcbiAgICAgIGxpbmU6IGxpbmVBdChtLmluZGV4ID8/IDApLFxuICAgICAgcmVsOiBwYXJzZVJlbChxdWVyeSksXG4gICAgICAuLi4obGFiZWwgPyB7IGxhYmVsIH0gOiB7fSksXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIERvZXMgdGhpcyBmcm9udG1hdHRlciB2YWx1ZSBMT09LIGxpa2UgYSBkb2N1bWVudCByZWZlcmVuY2U/ICovXG5leHBvcnQgZnVuY3Rpb24gbG9va3NMaWtlUmVmKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgc3RyaW5nIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIGZhbHNlO1xuICBjb25zdCB2ID0gdmFsdWUudHJpbSgpO1xuICBpZiAodiA9PT0gXCJcIiB8fCBFWFRFUk5BTC50ZXN0KHYpKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiB2LmluY2x1ZGVzKFwiL1wiKSB8fCB2LnRvTG93ZXJDYXNlKCkuZW5kc1dpdGgoXCIubWRcIik7XG59XG5cbi8qKlxuICogUmVmZXJlbmNlcyBpbnNpZGUgZnJvbnRtYXR0ZXIsIHdoYXRldmVyIGtleSBjYXJyaWVzIHRoZW0g4oCUIGByZWxhdGVkYCxcbiAqIGBzdXBlcnNlZGVzYCwgYHNvdXJjZXNbXS5yZXNvdXJjZWAsIG9yIGEga2V5IGludmVudGVkIHRvbW9ycm93LiBUaGUgU0hBUEVcbiAqIGRlY2lkZXMgKGEgc2xhc2ggb3IgYSBgLm1kYCksIHdoaWNoIGlzIHdoeSBiYXJlIGB0YWdzYCBhcmUgbm90IHJlZmVyZW5jZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaWVsZFJlZnMoZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgbWF4RGVwdGggPSA0KTogRmllbGRSZWZbXSB7XG4gIGNvbnN0IG91dDogRmllbGRSZWZbXSA9IFtdO1xuICBjb25zdCB3YWxrID0gKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgZGVwdGg6IG51bWJlcikgPT4ge1xuICAgIGlmIChkZXB0aCA+IG1heERlcHRoKSByZXR1cm47XG4gICAgaWYgKGxvb2tzTGlrZVJlZih2YWx1ZSkpIG91dC5wdXNoKHsga2V5LCB2YWx1ZTogdmFsdWUudHJpbSgpIH0pO1xuICAgIGVsc2UgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSBmb3IgKGNvbnN0IHYgb2YgdmFsdWUpIHdhbGsoa2V5LCB2LCBkZXB0aCArIDEpO1xuICAgIGVsc2UgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIilcbiAgICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSlcbiAgICAgICAgd2FsayhgJHtrZXl9LiR7a31gLCB2LCBkZXB0aCArIDEpO1xuICB9O1xuICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhmaWVsZHMpKSB3YWxrKGssIHYsIDApO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogV2hlcmUgYSB0YXJnZXQgbGFuZGVkLiBgb3V0c2lkZWAgZXhpc3RzIG9uIGRpc2sgYnV0IG5vdCBpbiB0aGlzIGJ1bmRsZS4gKi9cbmV4cG9ydCB0eXBlIFJlc29sdXRpb24gPVxuICB8IHsgc3RhdGU6IFwiaW4tYnVuZGxlXCI7IHBhdGg6IHN0cmluZyB9XG4gIHwgeyBzdGF0ZTogXCJvdXRzaWRlXCI7IHBhdGg6IHN0cmluZyB9XG4gIHwgeyBzdGF0ZTogXCJtaXNzaW5nXCI7IHRyaWVkOiBzdHJpbmcgfTtcblxuZXhwb3J0IHR5cGUgQnVuZGxlSW5kZXggPSB7XG4gIC8qKiBUaGUgc2V0J3Mgcm9vdCDigJQgT0tGJ3MgYnVuZGxlLCBhbmQgd2hhdCBhIGAvYC10YXJnZXQgaXMgcmVsYXRpdmUgdG8uICovXG4gIHJvb3Q6IHN0cmluZztcbiAgLyoqIEFic29sdXRlIHBhdGhzIG9mIGV2ZXJ5IGRvY3VtZW50IGluIHRoZSBidW5kbGUuICovXG4gIHBhdGhzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIEEgZG9jdW1lbnQncyBwYXJzZWQgZnJvbnRtYXR0ZXIsIGZvciBgdHlwZS9zbHVnYCByZXNvbHV0aW9uLiAqL1xuICBtZXRhT2Y6IChwYXRoOiBzdHJpbmcpID0+IERvY01ldGEgfCBudWxsO1xuICAvKiogRG9lcyB0aGlzIHBhdGggZXhpc3Qgb24gZGlzaz8gKEluamVjdGVkLCBzbyB0aGUgcmVzb2x2ZXIgc3RheXMgcHVyZS4pICovXG4gIGV4aXN0czogKHBhdGg6IHN0cmluZykgPT4gYm9vbGVhbjtcbiAgLyoqXG4gICAqIFRoZSBnaXQgd29ya2luZyB0cmVlIHRoZSBidW5kbGUgc2l0cyBpbiwgd2hlbiB0aGVyZSBpcyBvbmUuIEEgdGhpcmQgcGxhY2VcbiAgICogYW4gdW5hbmNob3JlZCBwYXRoIGlzIHRyaWVkOiBwZG9jcyB3cml0ZXMgcmVwby1yZWxhdGl2ZSBwYXRoc1xuICAgKiAoYGRvY3MvcGxheWJvb2tzL2Zvby5tZGApIGFuZCB0aGUgd2lraSdzIHJ1bGUgcGFnZXMgY2FycnkgcmVwby1yZWxhdGl2ZVxuICAgKiBgY2hlY2tlcjpgIHZhbHVlcywgYW5kIG5laXRoZXIgcmVzb2x2ZXMgZnJvbSB0aGUgZG9jdW1lbnQgb3IgdGhlIGJ1bmRsZS5cbiAgICovXG4gIHJlcG9Sb290Pzogc3RyaW5nIHwgbnVsbDtcbn07XG5cbmNvbnN0IHN0ZW0gPSAocDogc3RyaW5nKSA9PiBiYXNlbmFtZShwLCBleHRuYW1lKHApKTtcblxuLyoqXG4gKiBSZXNvbHZlIG9uZSB3cml0dGVuIHRhcmdldCBhZ2FpbnN0IHRoZSBidW5kbGUuXG4gKlxuICogRm91ciBmb3JtcywgaW4gb3JkZXI6IGEgYnVuZGxlLXJlbGF0aXZlIHBhdGggKGAveC95Lm1kYCksIGEgcmVsYXRpdmUgcGF0aFxuICogKGAuL3kubWRgLCBgLi4veC95Lm1kYCksIGEgYHR5cGUvc2x1Z2Aga2V5IOKAlCBwZG9jcycgYW5kIHRoZSB3aWtpJ3Mgb3duIGZvcm0sXG4gKiB3aGljaCByZXNvbHZlcyBieSBUWVBFIGFuZCBCQVNFTkFNRSBzbyBhIHBhZ2UgY2FuIG1vdmUgZm9sZGVycyB3aXRob3V0XG4gKiBicmVha2luZyBpbmJvdW5kIHJlZmVyZW5jZXMg4oCUIGFuZCBhIGJhcmUgbmFtZSAoYSB3aWtpIGxpbmspLCBieSBiYXNlbmFtZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVUYXJnZXQocmF3VGFyZ2V0OiBzdHJpbmcsIGZyb206IHN0cmluZywgaW5kZXg6IEJ1bmRsZUluZGV4KTogUmVzb2x1dGlvbiB7XG4gIC8vIOKblCBTUExJVCBGSVJTVCwgQkVDQVVTRSBUSEUgQ0FMTEVSUyBESVNBR1JFRSBBQk9VVCBXSEFUIFRIRVkgSEFORCBPVkVSLlxuICAvLyBgZXh0cmFjdExpbmtzYCBzcGxpdHMgYSB0YXJnZXQgYmVmb3JlIGl0IGV2ZXIgZ2V0cyBoZXJlIChFNDkpLCBidXQgdGhlXG4gIC8vIENMSUNLIHBhdGggZG9lcyBub3Q6IGBsaW5rLm9wZW5gIGNhcnJpZXMgdGhlIGhyZWYgZXhhY3RseSBhcyB0aGUgZG9jdW1lbnRcbiAgLy8gd3JvdGUgaXQuIFNvIGFuIE9wZXJhdG9yIHR5cGVkIGxpbmsg4oCUIGBNYXJlbidzJTIwQmFrZXJ5Lm1kP3JlbD1sb2NhdGVkLWluYFxuICAvLyDigJQgYXJyaXZlZCB3aXRoIGl0cyBxdWVyeSBhbmQgaXRzIGVuY29kaW5nIGludGFjdCwgYGV4dG5hbWVgIHJlYWRcbiAgLy8gYC5tZD9yZWw9bG9jYXRlZC1pbmAsIGFuZCB0aGUgbG9va3VwIHdlbnQgaHVudGluZyBmb3IgYSBmaWxlIG5hbWVkIGFmdGVyXG4gIC8vIHRoZSB3aG9sZSBzdHJpbmcuIFRoZSBHUkFQSCBkcmV3IHRoYXQgZWRnZSBjb3JyZWN0bHkgdGhlIGVudGlyZSB0aW1lLCB3aGljaFxuICAvLyBpcyB3aGF0IG1hZGUgaXQgcHV6emxpbmc6IHRoZSBzYW1lIGxpbmsgd2FzIGZpbmUgaW4gdGhlIG1hcCBhbmQgZGVhZCB1bmRlclxuICAvLyB0aGUgcG9pbnRlci4gU3BsaXR0aW5nIGhlcmUgZml4ZXMgZXZlcnkgY2FsbGVyIGF0IG9uY2UgYW5kIGlzIGlkZW1wb3RlbnRcbiAgLy8gZm9yIHRoZSB0d28gdGhhdCBoYWQgYWxyZWFkeSBkb25lIGl0LiAoQ29sZSBmb3VuZCBpdCBieSBjbGlja2luZyBvbmUgaW5cbiAgLy8gSG9sbG93YnJvb2ssIDIwMjYtMDktMTQuKVxuICBjb25zdCB0YXJnZXQgPSBzcGxpdFRhcmdldChyYXdUYXJnZXQpLnBhdGg7XG4gIC8vIOKblCBXSEFUIE1BS0VTIEEgVEFSR0VUIEEgUEFUSCBSQVRIRVIgVEhBTiBBIEtFWSwgYW5kIHRoZSBjYXNlIHRoYXQgdGF1Z2h0XG4gIC8vIGl0OiBgW3RoZSBsaW50ZXJdKGxpbnQudHMpYCBpbiB0aGUgcmVhbCB3aWtpIGhhcyBubyBgLi9gIGFuZCBpcyBub3QgYSBgLm1kYCxcbiAgLy8gc28gYSBydWxlIGtleWVkIG9uIHRob3NlIHR3byByZWFkIGl0IGFzIGEgTkFNRSBhbmQgcmVwb3J0ZWQgaXQgbWlzc2luZ1xuICAvLyB3aGlsZSB0aGUgZmlsZSBzYXQgcmlnaHQgdGhlcmUuIEEgdGFyZ2V0IGlzIGEgcGF0aCB3aGVuIGl0IGlzIGFuY2hvcmVkXG4gIC8vIChgL2AsIGAuL2AsIGAuLi9gKSBvciBjYXJyaWVzIEFOWSBleHRlbnNpb247IGBjb25jZXB0L2V4aXQtY29kZXNgIGhhc1xuICAvLyBuZWl0aGVyLCB3aGljaCBpcyB3aGF0IGtlZXBzIGEgYHR5cGUvc2x1Z2Aga2V5IGEga2V5LlxuICBjb25zdCBsb29rc1BhdGggPVxuICAgIHRhcmdldC5zdGFydHNXaXRoKFwiL1wiKSB8fFxuICAgIHRhcmdldC5zdGFydHNXaXRoKFwiLi9cIikgfHxcbiAgICB0YXJnZXQuc3RhcnRzV2l0aChcIi4uL1wiKSB8fFxuICAgIGV4dG5hbWUodGFyZ2V0KSAhPT0gXCJcIjtcbiAgaWYgKGxvb2tzUGF0aCkge1xuICAgIC8vIEFuIFVOQU5DSE9SRUQgcGF0aCAoYHNyYy9hY2Mva2l0L3gudHNgLCBgcmVwb3J0cy9hLm1kYCDigJQgbm8gYC4vYCBhbmQgbm9cbiAgICAvLyBsZWFkaW5nIGAvYCkgaXMgYW1iaWd1b3VzOiByZWxhdGl2ZSB0byB0aGUgZG9jdW1lbnQsIG9yIHRvIHRoZSBidW5kbGU/XG4gICAgLy8gQm90aCBhcmUgdHJpZWQsIGRvY3VtZW50IGZpcnN0LiBNZWFzdXJlZCBvbiB0aGUgcmVhbCB3aWtpLCB3aGVyZSBhIHJ1bGVcbiAgICAvLyBwYWdlJ3MgYGNoZWNrZXI6IHNyYy9hY2Mva2l0L2NoZWNrZXJzL+KApmAgd2FzIHJlcG9ydGVkIG1pc3Npbmcgd2hpbGVcbiAgICAvLyByZXNvbHZpbmcgZnJvbSB0aGUgYnVuZGxlIHJvb3Qgd291bGQgaGF2ZSBmb3VuZCBpdC5cbiAgICBjb25zdCBhbmNob3JlZCA9IHRhcmdldC5zdGFydHNXaXRoKFwiL1wiKSB8fCB0YXJnZXQuc3RhcnRzV2l0aChcIi4vXCIpIHx8IHRhcmdldC5zdGFydHNXaXRoKFwiLi4vXCIpO1xuICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSB0YXJnZXQuc3RhcnRzV2l0aChcIi9cIilcbiAgICAgID8gW25vcm1hbGl6ZShqb2luKGluZGV4LnJvb3QsIHRhcmdldCkpXVxuICAgICAgOiBhbmNob3JlZFxuICAgICAgICA/IFtub3JtYWxpemUocmVzb2x2ZVBhdGgoZGlybmFtZShmcm9tKSwgdGFyZ2V0KSldXG4gICAgICAgIDogW1xuICAgICAgICAgICAgbm9ybWFsaXplKHJlc29sdmVQYXRoKGRpcm5hbWUoZnJvbSksIHRhcmdldCkpLFxuICAgICAgICAgICAgbm9ybWFsaXplKGpvaW4oaW5kZXgucm9vdCwgdGFyZ2V0KSksXG4gICAgICAgICAgICAuLi4oaW5kZXgucmVwb1Jvb3QgPyBbbm9ybWFsaXplKGpvaW4oaW5kZXgucmVwb1Jvb3QsIHRhcmdldCkpXSA6IFtdKSxcbiAgICAgICAgICBdO1xuICAgIGNvbnN0IHRyaWVkID0gY2FuZGlkYXRlcy5tYXAoKGMpID0+IChleHRuYW1lKGMpID09PSBcIlwiID8gYCR7Y30ubWRgIDogYykpO1xuICAgIGZvciAoY29uc3QgYyBvZiB0cmllZCkgaWYgKGluZGV4LnBhdGhzLmluY2x1ZGVzKGMpKSByZXR1cm4geyBzdGF0ZTogXCJpbi1idW5kbGVcIiwgcGF0aDogYyB9O1xuICAgIGZvciAoY29uc3QgYyBvZiB0cmllZCkgaWYgKGluZGV4LmV4aXN0cyhjKSkgcmV0dXJuIHsgc3RhdGU6IFwib3V0c2lkZVwiLCBwYXRoOiBjIH07XG4gICAgcmV0dXJuIHsgc3RhdGU6IFwibWlzc2luZ1wiLCB0cmllZDogdHJpZWRbMF0gYXMgc3RyaW5nIH07XG4gIH1cbiAgY29uc3Qgc2xhc2ggPSB0YXJnZXQuaW5kZXhPZihcIi9cIik7XG4gIGlmIChzbGFzaCA+IDApIHtcbiAgICAvLyBgdHlwZS9zbHVnYDogdGhlIHR5cGUgaXMgYSBjbGFpbSB0aGUgdGFyZ2V0J3Mgb3duIGZyb250bWF0dGVyIG11c3QgbWFrZS5cbiAgICBjb25zdCB0eXBlID0gdGFyZ2V0LnNsaWNlKDAsIHNsYXNoKTtcbiAgICBjb25zdCBzbHVnID0gdGFyZ2V0LnNsaWNlKHNsYXNoICsgMSk7XG4gICAgZm9yIChjb25zdCBwIG9mIGluZGV4LnBhdGhzKVxuICAgICAgaWYgKHN0ZW0ocCkgPT09IHNsdWcgJiYgaW5kZXgubWV0YU9mKHApPy50eXBlID09PSB0eXBlKVxuICAgICAgICByZXR1cm4geyBzdGF0ZTogXCJpbi1idW5kbGVcIiwgcGF0aDogcCB9O1xuICB9XG4gIGNvbnN0IGhpdCA9IGluZGV4LnBhdGhzLmZpbmQoKHApID0+IHN0ZW0ocCkgPT09IHN0ZW0odGFyZ2V0KSk7XG4gIGlmIChoaXQpIHJldHVybiB7IHN0YXRlOiBcImluLWJ1bmRsZVwiLCBwYXRoOiBoaXQgfTtcbiAgcmV0dXJuIHsgc3RhdGU6IFwibWlzc2luZ1wiLCB0cmllZDogdGFyZ2V0IH07XG59XG5cbi8qKiBBbiBlZGdlIGluIGEgc2V0J3MgbWFwLiBgcmVsYCBlbXB0eSBtZWFucyBubyBhc3NlcnRpb24gd2FzIG1hZGUuICovXG5leHBvcnQgdHlwZSBFZGdlID0ge1xuICBmcm9tOiBzdHJpbmc7XG4gIC8qKiBBYnNvbHV0ZSBwYXRoIHdoZW4gcmVzb2x2ZWQ7IHRoZSB3cml0dGVuIHRhcmdldCB3aGVuIG5vdC4gKi9cbiAgdG86IHN0cmluZztcbiAgLyoqIEEgYm9keSBsaW5rLCBvciBhIGZyb250bWF0dGVyIHZhbHVlIOKAlCBrZXB0IGFwYXJ0LCBhcyBwZG9jcyBrZWVwcyB0aGVtLiAqL1xuICBzb3VyY2U6IFwibGlua1wiIHwgXCJmcm9udG1hdHRlclwiO1xuICAvKiogVGhlIGZyb250bWF0dGVyIGtleSB0aGF0IGNhcnJpZWQgaXQgKGByZWxhdGVkYCwgYHNvdXJjZXMucmVzb3VyY2VgLCDigKYpLiAqL1xuICBrZXk/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBGb3IgYSBCT0RZIGxpbms6IHRoZSB0YXJnZXQgYXMgd3JpdHRlbiwgYW5kIHRoZSBsaW5lIGl0IGlzIG9uLiBBYnNlbnQgZm9yIGFcbiAgICogZnJvbnRtYXR0ZXIgcmVmZXJlbmNlLCB3aGVyZSBga2V5YCBpcyB0aGUgYWRkcmVzcyBpbnN0ZWFkLlxuICAgKi9cbiAgcmF3Pzogc3RyaW5nO1xuICBsaW5lPzogbnVtYmVyO1xuICByZWw6IHN0cmluZ1tdO1xuICBzdGF0ZTogUmVzb2x1dGlvbltcInN0YXRlXCJdO1xufTtcblxuZXhwb3J0IHR5cGUgR3JhcGhOb2RlID0ge1xuICBwYXRoOiBzdHJpbmc7XG4gIHJlbDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICB0eXBlPzogc3RyaW5nO1xuICBzdGF0dXM6IHN0cmluZztcbiAgc3RhbGU6IGJvb2xlYW47XG4gIHRhZ3M6IHN0cmluZ1tdO1xuICBsaW5rc091dDogbnVtYmVyO1xuICBsaW5rc0luOiBudW1iZXI7XG59O1xuXG5leHBvcnQgdHlwZSBHcmFwaCA9IHtcbiAgcm9vdDogc3RyaW5nO1xuICBub2RlczogR3JhcGhOb2RlW107XG4gIGVkZ2VzOiBFZGdlW107XG4gIC8qKiBUYXJnZXRzIG5vdGhpbmcgaW4gdGhlIGJ1bmRsZSBhbnN3ZXJzIOKAlCBzYWlkLCBuZXZlciBhbiBlcnJvciAoT0tGIMKnMTEpLiAqL1xuICBkYW5nbGluZzogbnVtYmVyO1xufTtcblxuLyoqIEJ1aWxkIGEgc2V0J3MgbWFwOiBub2RlcyBhcmUgaXRzIGRvY3VtZW50cywgZWRnZXMgYXJlIHRoZSBmb3VyIHNvdXJjZXMuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRHcmFwaChpbmRleDogQnVuZGxlSW5kZXgsIGJvZHlPZjogKHBhdGg6IHN0cmluZykgPT4gc3RyaW5nLCBjYXAgPSA0MDApOiBHcmFwaCB7XG4gIGNvbnN0IHBhdGhzID0gaW5kZXgucGF0aHMuc2xpY2UoMCwgY2FwKTtcbiAgY29uc3QgZWRnZXM6IEVkZ2VbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGZyb20gb2YgcGF0aHMpIHtcbiAgICBjb25zdCBtZXRhID0gaW5kZXgubWV0YU9mKGZyb20pO1xuICAgIGZvciAoY29uc3QgbGluayBvZiBleHRyYWN0TGlua3MoYm9keU9mKGZyb20pKSkge1xuICAgICAgY29uc3QgciA9IHJlc29sdmVUYXJnZXQobGluay50YXJnZXQsIGZyb20sIGluZGV4KTtcbiAgICAgIGVkZ2VzLnB1c2goe1xuICAgICAgICBmcm9tLFxuICAgICAgICB0bzogci5zdGF0ZSA9PT0gXCJtaXNzaW5nXCIgPyByLnRyaWVkIDogci5wYXRoLFxuICAgICAgICBzb3VyY2U6IFwibGlua1wiLFxuICAgICAgICByYXc6IGxpbmsucmF3LFxuICAgICAgICBsaW5lOiBsaW5rLmxpbmUsXG4gICAgICAgIHJlbDogbGluay5yZWwsXG4gICAgICAgIHN0YXRlOiByLnN0YXRlLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgcmVmIG9mIG1ldGEgPyBmaWVsZFJlZnMobWV0YS5maWVsZHMpIDogW10pIHtcbiAgICAgIGNvbnN0IHIgPSByZXNvbHZlVGFyZ2V0KHJlZi52YWx1ZSwgZnJvbSwgaW5kZXgpO1xuICAgICAgZWRnZXMucHVzaCh7XG4gICAgICAgIGZyb20sXG4gICAgICAgIHRvOiByLnN0YXRlID09PSBcIm1pc3NpbmdcIiA/IHIudHJpZWQgOiByLnBhdGgsXG4gICAgICAgIHNvdXJjZTogXCJmcm9udG1hdHRlclwiLFxuICAgICAgICBrZXk6IHJlZi5rZXksXG4gICAgICAgIHJlbDogW10sXG4gICAgICAgIHN0YXRlOiByLnN0YXRlLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG4gIGNvbnN0IG91dE9mID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgY29uc3QgaW50b09mID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgZm9yIChjb25zdCBlIG9mIGVkZ2VzKSB7XG4gICAgb3V0T2Yuc2V0KGUuZnJvbSwgKG91dE9mLmdldChlLmZyb20pID8/IDApICsgMSk7XG4gICAgaWYgKGUuc3RhdGUgPT09IFwiaW4tYnVuZGxlXCIpIGludG9PZi5zZXQoZS50bywgKGludG9PZi5nZXQoZS50bykgPz8gMCkgKyAxKTtcbiAgfVxuICBjb25zdCBub2RlczogR3JhcGhOb2RlW10gPSBwYXRocy5tYXAoKHBhdGgpID0+IHtcbiAgICBjb25zdCBtZXRhID0gaW5kZXgubWV0YU9mKHBhdGgpO1xuICAgIHJldHVybiB7XG4gICAgICBwYXRoLFxuICAgICAgcmVsOiB0b1Bvc2l4KHJlbGF0aXZlKGluZGV4LnJvb3QsIHBhdGgpKSxcbiAgICAgIHRpdGxlOiBtZXRhPy50aXRsZSA/PyBzdGVtKHBhdGgpLFxuICAgICAgLi4uKG1ldGE/LnR5cGUgPyB7IHR5cGU6IG1ldGEudHlwZSB9IDoge30pLFxuICAgICAgc3RhdHVzOiBtZXRhPy5zdGF0dXMgPz8gXCJzdGFibGVcIixcbiAgICAgIHN0YWxlOiBtZXRhPy5zdGFsZSA/PyBmYWxzZSxcbiAgICAgIHRhZ3M6IG1ldGE/LnRhZ3MgPz8gW10sXG4gICAgICBsaW5rc091dDogb3V0T2YuZ2V0KHBhdGgpID8/IDAsXG4gICAgICBsaW5rc0luOiBpbnRvT2YuZ2V0KHBhdGgpID8/IDAsXG4gICAgfTtcbiAgfSk7XG4gIHJldHVybiB7XG4gICAgcm9vdDogaW5kZXgucm9vdCxcbiAgICBub2RlcyxcbiAgICBlZGdlcyxcbiAgICBkYW5nbGluZzogZWRnZXMuZmlsdGVyKChlKSA9PiBlLnN0YXRlID09PSBcIm1pc3NpbmdcIikubGVuZ3RoLFxuICB9O1xufVxuIiwKICAgICIvKipcbiAqIENvbnRleHQgZW50cmllcyBvbiBkaXNrIOKAlCBidWlsZGluZyBhbiBlbnRyeSBmcm9tIGEgcGF0aCAoRTE1J3Mgb25lIG1vZGVsKSxcbiAqIG1pcnJvcmluZyBhIGZvbGRlciBpbnRvIGEgbm9kZSB0cmVlLCBhbmQgbGlzdGluZyBhIGRpcmVjdG9yeSBmb3IgdGhlXG4gKiBzdXJmYWNlJ3MgcGF0aCBjb21wbGV0aW9uIChgZnMubGlzdGApLlxuICpcbiAqIFB1cmUgb3ZlciB0aGUgZmlsZXN5c3RlbTogbm8gZGFlbW9uIHN0YXRlLCBzbyB0aGUgdW5pdCBjZWxscyBkcml2ZSBpdCB3aXRoIGFcbiAqIHRlbXAgZGlyZWN0b3J5IGFuZCBub3RoaW5nIGVsc2UuXG4gKi9cblxuaW1wb3J0IHsgcmVhZGRpclN5bmMsIHN0YXRTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luLCByZWxhdGl2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBDb250ZXh0RW50cnksIENvbnRleHROb2RlLCBGc0xpc3RFbnRyeSB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKiBXaGF0IHNjcmlwdG9yaXVtIG9wZW5zIGFzIGEgZG9jdW1lbnQuIEV2ZXJ5dGhpbmcgZWxzZSBpcyBub3Qgc2hvd24uICovXG5leHBvcnQgY29uc3QgRE9DX0VYVEVOU0lPTlMgPSBbXCIubWRcIiwgXCIubWFya2Rvd25cIiwgXCIubWR4XCIsIFwiLnR4dFwiXSBhcyBjb25zdDtcblxuZXhwb3J0IGZ1bmN0aW9uIGlzRG9jTmFtZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgbG93ZXIgPSBuYW1lLnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiBET0NfRVhURU5TSU9OUy5zb21lKChleHQpID0+IGxvd2VyLmVuZHNXaXRoKGV4dCkpO1xufVxuXG4vKiogRGlyZWN0b3JpZXMgYSBtaXJyb3IgbmV2ZXIgZGVzY2VuZHMgaW50byDigJQgbm9pc2UsIG5vdCBkb2N1bWVudHMuICovXG5jb25zdCBTS0lQX0RJUlMgPSBuZXcgU2V0KFtcIm5vZGVfbW9kdWxlc1wiLCBcIi5naXRcIiwgXCJkaXN0XCIsIFwib3V0XCIsIFwiY292ZXJhZ2VcIl0pO1xuXG4vKipcbiAqIFRoZSBtb3N0IG5vZGVzIG9uZSBtaXJyb3JlZCBzY2FuIHdpbGwgaG9sZC4gQSBmb2xkZXIgZW50cnkgcG9pbnRlZCBhdCBhIGh1Z2VcbiAqIHRyZWUgbXVzdCBub3Qgc3RhbGwgdGhlIGRhZW1vbiBvciBmbG9vZCBldmVyeSBzdGF0ZSBicm9hZGNhc3Q7IGhpdHRpbmcgdGhlXG4gKiBjYXAgc2V0cyBgdHJ1bmNhdGVkYCBvbiB0aGUgZW50cnkgc28gdGhlIHN1cmZhY2UgY2FuIFNBWSB0aGUgbGlzdCBpcyBzaG9ydFxuICogcmF0aGVyIHRoYW4gcmVuZGVyIGEgc2hvcnQgbGlzdCBhcyBhIGNvbXBsZXRlIG9uZS5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JUlJPUl9OT0RFX0NBUCA9IDIwMDA7XG5cbmV4cG9ydCBjb25zdCB0b1Bvc2l4ID0gKHA6IHN0cmluZykgPT4gcC5zcGxpdChzZXApLmpvaW4oXCIvXCIpO1xuXG4vKipcbiAqIE1pcnJvciBgcm9vdGAgaW50byBhIHNvcnRlZCBub2RlIHRyZWU6IGdyb3VwcyBmaXJzdCwgdGhlbiBkb2NzLCBieSBuYW1lLlxuICogYGhpZGRlbmAgcmVscyAoRTI0J3MgXCJSZW1vdmUgZnJvbSBTY3JpcHRvcml1bVwiKSBhcmUgc2tpcHBlZCwgYSBmb2xkZXIgd2l0aFxuICogZXZlcnl0aGluZyB1bmRlciBpdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjYW5UcmVlKFxuICByb290OiBzdHJpbmcsXG4gIGNhcCA9IE1JUlJPUl9OT0RFX0NBUCxcbiAgaGlkZGVuOiByZWFkb25seSBzdHJpbmdbXSA9IFtdLFxuKTogeyBub2RlczogQ29udGV4dE5vZGVbXTsgdHJ1bmNhdGVkOiBib29sZWFuIH0ge1xuICBsZXQgY291bnQgPSAwO1xuICBsZXQgdHJ1bmNhdGVkID0gZmFsc2U7XG4gIGNvbnN0IHNraXAgPSBuZXcgU2V0KGhpZGRlbik7XG4gIGNvbnN0IHdhbGsgPSAoZGlyOiBzdHJpbmcpOiBDb250ZXh0Tm9kZVtdID0+IHtcbiAgICBsZXQgbmFtZXM6IHN0cmluZ1tdO1xuICAgIHRyeSB7XG4gICAgICBuYW1lcyA9IHJlYWRkaXJTeW5jKGRpcik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICAgIGNvbnN0IGdyb3VwczogQ29udGV4dE5vZGVbXSA9IFtdO1xuICAgIGNvbnN0IGRvY3M6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMuc29ydCgoYSwgYikgPT4gYS5sb2NhbGVDb21wYXJlKGIpKSkge1xuICAgICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNvdW50ID49IGNhcCkge1xuICAgICAgICB0cnVuY2F0ZWQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgcmVsID0gdG9Qb3NpeChyZWxhdGl2ZShyb290LCBhYnMpKTtcbiAgICAgIGlmIChza2lwLmhhcyhyZWwpKSBjb250aW51ZTtcbiAgICAgIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICAgIGlmIChTS0lQX0RJUlMuaGFzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgY29uc3QgY2hpbGRyZW4gPSB3YWxrKGFicyk7XG4gICAgICAgIC8vIEEgZm9sZGVyIGhvbGRpbmcgb25seSBub24tZG9jdW1lbnRzIChpbWFnZXMsIGFzc2V0cykgaXMgbm9pc2UgaW4gYVxuICAgICAgICAvLyBkb2NzIG1pcnJvciBhbmQgaXMgbGVmdCBvdXQuIEEgVFJVTFkgRU1QVFkgZm9sZGVyIGlzIGtlcHQ6IGl0IGlzIG9uZVxuICAgICAgICAvLyBzb21lYm9keSBqdXN0IG1hZGUgdG8gcHV0IGRvY3VtZW50cyBpbiAoXCJOZXcgZm9sZGVyXCIsIEUyNCksIGFuZFxuICAgICAgICAvLyBsZWF2aW5nIGl0IG91dCBtYWRlIGl0IHZhbmlzaCB0aGUgbW9tZW50IGl0IHdhcyBjcmVhdGVkLlxuICAgICAgICBpZiAoY2hpbGRyZW4ubGVuZ3RoID4gMCB8fCBpc0VtcHR5RGlyKGFicykpIGdyb3Vwcy5wdXNoKHsga2luZDogXCJncm91cFwiLCByZWwsIGNoaWxkcmVuIH0pO1xuICAgICAgfSBlbHNlIGlmIChzdC5pc0ZpbGUoKSAmJiBpc0RvY05hbWUobmFtZSkpIHtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgZG9jcy5wdXNoKHsga2luZDogXCJkb2NcIiwgcmVsIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gWy4uLmdyb3VwcywgLi4uZG9jc107XG4gIH07XG4gIGNvbnN0IG5vZGVzID0gd2Fsayhyb290KTtcbiAgcmV0dXJuIHsgbm9kZXMsIHRydW5jYXRlZCB9O1xufVxuXG4vKiogTm90aGluZyBpbiBpdCBidXQgZG90ZmlsZXMgKGEgYC5EU19TdG9yZWAgZG9lcyBub3QgbWFrZSBhIGZvbGRlciBmdWxsKS4gKi9cbmZ1bmN0aW9uIGlzRW1wdHlEaXIoZGlyOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhZGRpclN5bmMoZGlyKS5ldmVyeSgobikgPT4gbi5zdGFydHNXaXRoKFwiLlwiKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKiogVGhlIG5vZGUgYXQgYHJlbGAgaW4gYSB0cmVlLCBvciB1bmRlZmluZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZE5vZGUobm9kZXM6IHJlYWRvbmx5IENvbnRleHROb2RlW10sIHJlbDogc3RyaW5nKTogQ29udGV4dE5vZGUgfCB1bmRlZmluZWQge1xuICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICBpZiAobi5yZWwgPT09IHJlbCkgcmV0dXJuIG47XG4gICAgaWYgKG4ua2luZCA9PT0gXCJncm91cFwiICYmIHJlbC5zdGFydHNXaXRoKGAke24ucmVsfS9gKSkgcmV0dXJuIGZpbmROb2RlKG4uY2hpbGRyZW4sIHJlbCk7XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGNsYXNzIFBhdGhFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgbWVzc2FnZTogc3RyaW5nLFxuICAgIHJlYWRvbmx5IGNvZGU6IFwibWlzc2luZ1wiIHwgXCJub3QtYS1kb2NcIixcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gIH1cbn1cblxuLyoqXG4gKiBBbiBlbnRyeSBmb3IgYW4gYWJzb2x1dGUgcGF0aC4gQSBkaXJlY3RvcnkgaXMgYG1pcnJvcmVkYDsgYSBkb2N1bWVudCBmaWxlIGlzXG4gKiBgbGlzdGVkYCwgcm9vdGVkIGF0IGl0cyBwYXJlbnQsIGhvbGRpbmcgb25seSBpdHNlbGYgKEUxNSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbnRyeUZvclBhdGgoYWJzOiBzdHJpbmcsIGlkOiBzdHJpbmcpOiBDb250ZXh0RW50cnkge1xuICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgdHJ5IHtcbiAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoYG5vIHN1Y2ggZmlsZSBvciBmb2xkZXI6ICR7YWJzfWAsIFwibWlzc2luZ1wiKTtcbiAgfVxuICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgIGNvbnN0IHsgbm9kZXMsIHRydW5jYXRlZCB9ID0gc2NhblRyZWUoYWJzKTtcbiAgICByZXR1cm4ge1xuICAgICAgaWQsXG4gICAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSB8fCBhYnMsXG4gICAgICByb290OiBhYnMsXG4gICAgICBtZW1iZXJzaGlwOiBcIm1pcnJvcmVkXCIsXG4gICAgICBub2RlcyxcbiAgICAgIC4uLih0cnVuY2F0ZWQgPyB7IHRydW5jYXRlZCB9IDoge30pLFxuICAgIH07XG4gIH1cbiAgaWYgKCFpc0RvY05hbWUoYWJzKSkge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoXG4gICAgICBgbm90IGEgZG9jdW1lbnQgc2NyaXB0b3JpdW0gb3BlbnMgKCR7RE9DX0VYVEVOU0lPTlMuam9pbihcIiBcIil9KTogJHthYnN9YCxcbiAgICAgIFwibm90LWEtZG9jXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIGxhYmVsOiBiYXNlbmFtZShhYnMpLFxuICAgIHJvb3Q6IGRpcm5hbWUoYWJzKSxcbiAgICBtZW1iZXJzaGlwOiBcImxpc3RlZFwiLFxuICAgIG5vZGVzOiBbeyBraW5kOiBcImRvY1wiLCByZWw6IGJhc2VuYW1lKGFicykgfV0sXG4gIH07XG59XG5cbi8qKiBFdmVyeSBkb2Mgbm9kZSdzIGFic29sdXRlIHBhdGgsIGRlcHRoLWZpcnN0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRvY1BhdGhzKGVudHJ5OiBDb250ZXh0RW50cnkpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgd2FsayA9IChub2RlczogQ29udGV4dE5vZGVbXSkgPT4ge1xuICAgIGZvciAoY29uc3QgbiBvZiBub2Rlcykge1xuICAgICAgaWYgKG4ua2luZCA9PT0gXCJkb2NcIikgb3V0LnB1c2goam9pbihlbnRyeS5yb290LCBuLnJlbCkpO1xuICAgICAgZWxzZSB3YWxrKG4uY2hpbGRyZW4pO1xuICAgIH1cbiAgfTtcbiAgd2FsayhlbnRyeS5ub2Rlcyk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBXaGljaCBlbnRyeSAoaWYgYW55KSBob2xkcyBgYWJzYCwgYW5kIGF0IHdoYXQgYHJlbGAuICovXG5leHBvcnQgZnVuY3Rpb24gbG9jYXRlKFxuICBlbnRyaWVzOiBDb250ZXh0RW50cnlbXSxcbiAgYWJzOiBzdHJpbmcsXG4pOiB7IGVudHJ5SWQ6IHN0cmluZzsgcmVsOiBzdHJpbmcgfSB8IG51bGwge1xuICBmb3IgKGNvbnN0IGUgb2YgZW50cmllcykge1xuICAgIGlmIChkb2NQYXRocyhlKS5pbmNsdWRlcyhhYnMpKSByZXR1cm4geyBlbnRyeUlkOiBlLmlkLCByZWw6IHRvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKSB9O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIE9uZSBkaXJlY3RvcnksIGZvciB0aGUgc3VyZmFjZSdzIGFkZC1ieS1wYXRoIGNvbXBsZXRpb246IHN1YmRpcmVjdG9yaWVzIGFuZFxuICogZG9jdW1lbnRzIG9ubHksIGRpcmVjdG9yaWVzIGZpcnN0LiBgfmAgaXMgZXhwYW5kZWQgYnkgdGhlIGNhbGxlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxpc3REaXIoZGlyOiBzdHJpbmcpOiBGc0xpc3RFbnRyeVtdIHtcbiAgY29uc3QgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICBjb25zdCBvdXQ6IEZzTGlzdEVudHJ5W10gPSBbXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzKSB7XG4gICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICBsZXQgaXNEaXIgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgaXNEaXIgPSBzdGF0U3luYyhhYnMpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGlzRGlyIHx8IGlzRG9jTmFtZShuYW1lKSkgb3V0LnB1c2goeyBuYW1lLCBwYXRoOiBhYnMsIGRpcjogaXNEaXIgfSk7XG4gIH1cbiAgcmV0dXJuIG91dC5zb3J0KChhLCBiKSA9PiAoYS5kaXIgPT09IGIuZGlyID8gYS5uYW1lLmxvY2FsZUNvbXBhcmUoYi5uYW1lKSA6IGEuZGlyID8gLTEgOiAxKSk7XG59XG4iLAogICAgIi8vIEZpbmRpbmcgdGhpbmdzIGFjcm9zcyBldmVyeXRoaW5nIGluIHRoZSBjb250ZXh0IChFNTkpLlxuLy9cbi8vIOKblCBUV08gTUFUQ0hFUlMsIE9OIFBVUlBPU0UsIGJlY2F1c2UgdGhleSBhbnN3ZXIgZGlmZmVyZW50IHF1ZXN0aW9ucy4gTm90ZVxuLy8gYXBwcyBzcGxpdCB0aGVzZSBhbmQgaXQgaXMgbm90IGFuIGFjY2lkZW50OiBGVVpaWSBvbiBuYW1lcyBpcyBmb3IganVtcGluZ1xuLy8gKFwibWFiYWtcIiDihpIgTWFyZW4ncyBCYWtlcnkpLCBhbmQgRVhBQ1Qgb24gY29udGVudCBpcyBmb3IgZmluZGluZyAoXCJ3aGVyZSBkaWQgSVxuLy8gc2F5ICdhc2tpbmctbmljZWx5J1wiKS4gRnV6enkgZnVsbC10ZXh0IHdvdWxkIGJlIHRoZSB3b3JzdCBvZiBib3RoIOKAlCBzZWFyY2hpbmdcbi8vIGBicmlkZ2VgIHdvdWxkIHN1cmZhY2UgZG9jdW1lbnRzIHRoYXQgbWVyZWx5IGNvbnRhaW4gc2ltaWxhci1sb29raW5nIGxldHRlcnMsXG4vLyBhbmQgeW91IGNvdWxkIG5vIGxvbmdlciB0cnVzdCBcInRoaXMgcGhyYXNlIGlzIG9uIGxpbmUgMjlcIiwgd2hpY2ggaXMgdGhlIG9ubHlcbi8vIHRoaW5nIGEgY29udGVudCBzZWFyY2ggaXMgZm9yLiAoQ29sZSByYWlzZWQgRnVzZSBmb3IgdGhlIG5hbWUgaGFsZiBhbmQgY2hvc2Vcbi8vIHRoZSBoYW5kLXJvbGxlZCBzY29yZXI6IHRoZXJlIGlzIG5vIHNlY29uZCBlbmdpbmUgdGhpcyBoYXMgdG8gYWdyZWUgd2l0aCwgc29cbi8vIGZ1enp5IHJhbmtpbmcgaXMgYSBzZWxmLWNvbnRhaW5lZCB0YXN0ZSBqdWRnbWVudCB3aXRoIG5vIGRyaWZ0IHJpc2suKVxuLy9cbi8vIOKaoCBBTkQgSVQgU0VBUkNIRVMgV0hBVCBUSEUgSFVNQU4gSVMgTE9PS0lORyBBVCwgd2hpY2ggaXMgbm90IGFsd2F5cyB0aGUgZmlsZS5cbi8vIEEgZG9jdW1lbnQgb3BlbiBpbiB0aGUgc2Vzc2lvbiBpcyBzaG93biBhcyBpdHMgQUNUSVZFIFZFUlNJT04sIHdoaWNoIGxpdmVzXG4vLyB1bmRlciB0aGUgc2Vzc2lvbiBob21lIHJhdGhlciB0aGFuIGF0IHRoZSBvcmlnaW5hbCBwYXRoIOKAlCBzbyBhbiBlZGl0IG1hZGUgdHdvXG4vLyBtaW51dGVzIGFnbyBtdXN0IHN0aWxsIGJlIGZpbmRhYmxlLiBUaGF0IGFzeW1tZXRyeSBpcyBhbHNvIHRoZSByZWFzb24gdGhpc1xuLy8gZXhpc3RzIGZvciB0aGUgQUdFTlQgYXQgYWxsOiBncmVwIG92ZXIgdGhlIHdvcmtzcGFjZSBmaW5kcyB0aGUgU0FWRUQgZmlsZSBhbmRcbi8vIHNpbGVudGx5IG1pc3NlcyB0aGUgdmVyc2lvbiBiZWluZyByZWFkLiBUaGUgY2FsbGVyIHN1cHBsaWVzIHRoZSB0ZXh0IHBlclxuLy8gZG9jdW1lbnQgZm9yIGV4YWN0bHkgdGhpcyByZWFzb24gKHNlZSBgU2Vzc2lvbi5zZWFyY2hBbGxgKS5cblxuLyoqIE9uZSBsaW5lIHRoYXQgbWF0Y2hlZCwgd2l0aCB0aGUgb2Zmc2V0cyBvZiB0aGUgaGl0IGluc2lkZSB0aGUgZG9jdW1lbnQuICovXG5leHBvcnQgdHlwZSBIaXQgPSB7XG4gIC8qKiAxLWJhc2VkLCBzbyBpdCBjYW4gYmUgc2hvd24gYW5kIG9wZW5lZC4gKi9cbiAgbGluZTogbnVtYmVyO1xuICAvKiogVGhlIGxpbmUsIGZvciBjb250ZXh0IGluIHRoZSByZXN1bHQgbGlzdC4gKi9cbiAgdGV4dDogc3RyaW5nO1xuICAvKiogT2Zmc2V0cyBvZiB0aGUgbWF0Y2ggd2l0aGluIHRoZSBkb2N1bWVudCwgZm9yIHJldmVhbC1hbmQtc2VsZWN0LiAqL1xuICBmcm9tOiBudW1iZXI7XG4gIHRvOiBudW1iZXI7XG59O1xuXG4vKipcbiAqIEhvdyBtdWNoIG9mIGEgbGluZSBpcyB3b3J0aCBjYXJyeWluZyBiYWNrLiBBIHJlc3VsdCBsaXN0IGlzIGEgbGlzdCwgYW5kIGFcbiAqIGRvY3VtZW50IHdpdGggYSA0LDAwMC1jaGFyYWN0ZXIgcGFyYWdyYXBoIHNob3VsZCBub3Qgc2VuZCBhbGwgb2YgaXQgcGVyIGhpdC5cbiAqL1xuY29uc3QgTElORV9DQVAgPSAyNDA7XG5cbi8qKiBFdmVyeSBtYXRjaCBvZiBgcXVlcnlgIGluIGB0ZXh0YCwgYXQgbW9zdCBgbGltaXRgIG9mIHRoZW0uICovXG5leHBvcnQgZnVuY3Rpb24gc2VhcmNoVGV4dCh0ZXh0OiBzdHJpbmcsIHF1ZXJ5OiBzdHJpbmcsIGxpbWl0ID0gNTApOiBIaXRbXSB7XG4gIGNvbnN0IG5lZWRsZSA9IHF1ZXJ5LnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICBpZiAobmVlZGxlID09PSBcIlwiIHx8IGxpbWl0IDw9IDApIHJldHVybiBbXTtcbiAgY29uc3QgaGF5ID0gdGV4dC50b0xvd2VyQ2FzZSgpO1xuICBsZXQgYXQgPSBoYXkuaW5kZXhPZihuZWVkbGUpO1xuICBpZiAoYXQgPT09IC0xKSByZXR1cm4gW107XG4gIC8vIExpbmUgc3RhcnRzLCB3YWxrZWQgT05DRS4gQSBwZXItaGl0IGBsYXN0SW5kZXhPZihcIlxcblwiKWAgaXMgcXVhZHJhdGljIG92ZXIgYVxuICAvLyBkb2N1bWVudCB0aGF0IG1hdGNoZXMgb24gZXZlcnkgbGluZSwgd2hpY2ggaXMgZXhhY3RseSB0aGUgZG9jdW1lbnQgc29tZW9uZVxuICAvLyBzZWFyY2hlcyBmb3IgYSBjb21tb24gd29yZC5cbiAgY29uc3Qgc3RhcnRzOiBudW1iZXJbXSA9IFswXTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCB0ZXh0Lmxlbmd0aDsgaSsrKSBpZiAodGV4dC5jaGFyQ29kZUF0KGkpID09PSAxMCkgc3RhcnRzLnB1c2goaSArIDEpO1xuICBjb25zdCBoaXRzOiBIaXRbXSA9IFtdO1xuICBsZXQgY3Vyc29yID0gMDtcbiAgd2hpbGUgKGF0ICE9PSAtMSAmJiBoaXRzLmxlbmd0aCA8IGxpbWl0KSB7XG4gICAgd2hpbGUgKGN1cnNvciArIDEgPCBzdGFydHMubGVuZ3RoICYmIChzdGFydHNbY3Vyc29yICsgMV0gYXMgbnVtYmVyKSA8PSBhdCkgY3Vyc29yKys7XG4gICAgY29uc3QgbGluZVN0YXJ0ID0gc3RhcnRzW2N1cnNvcl0gYXMgbnVtYmVyO1xuICAgIGNvbnN0IGxpbmVFbmQgPSBjdXJzb3IgKyAxIDwgc3RhcnRzLmxlbmd0aCA/IChzdGFydHNbY3Vyc29yICsgMV0gYXMgbnVtYmVyKSAtIDEgOiB0ZXh0Lmxlbmd0aDtcbiAgICBjb25zdCB3aG9sZSA9IHRleHQuc2xpY2UobGluZVN0YXJ0LCBsaW5lRW5kKTtcbiAgICBoaXRzLnB1c2goe1xuICAgICAgbGluZTogY3Vyc29yICsgMSxcbiAgICAgIHRleHQ6IHdob2xlLmxlbmd0aCA+IExJTkVfQ0FQID8gYCR7d2hvbGUuc2xpY2UoMCwgTElORV9DQVAgLSAxKX3igKZgIDogd2hvbGUsXG4gICAgICBmcm9tOiBhdCxcbiAgICAgIHRvOiBhdCArIG5lZWRsZS5sZW5ndGgsXG4gICAgfSk7XG4gICAgLy8g4pqgIEFEVkFOQ0UgUEFTVCBUSEUgTUFUQ0gsIE5PVCBUSEUgTElORTogdHdvIGhpdHMgb24gb25lIGxpbmUgYXJlIHR3b1xuICAgIC8vIGhpdHMsIGFuZCBzdGVwcGluZyBieSBsaW5lIHdvdWxkIHNpbGVudGx5IGRyb3AgdGhlIHNlY29uZC5cbiAgICBhdCA9IGhheS5pbmRleE9mKG5lZWRsZSwgYXQgKyBuZWVkbGUubGVuZ3RoKTtcbiAgfVxuICByZXR1cm4gaGl0cztcbn1cblxuLyoqIElzIHRoaXMgY2hhcmFjdGVyIGEgd29yZCBib3VuZGFyeSBmb3Igc2NvcmluZyBwdXJwb3Nlcz8gKi9cbmZ1bmN0aW9uIGlzQm91bmRhcnkoY2g6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gY2ggPT09IFwiIFwiIHx8IGNoID09PSBcIi1cIiB8fCBjaCA9PT0gXCJfXCIgfHwgY2ggPT09IFwiL1wiIHx8IGNoID09PSBcIi5cIiB8fCBjaCA9PT0gXCInXCI7XG59XG5cbi8qKlxuICogSG93IHdlbGwgYG5hbWVgIG1hdGNoZXMgYHF1ZXJ5YCBhcyBhIGZ1enp5IHN1YnNlcXVlbmNlIOKAlCBoaWdoZXIgaXMgYmV0dGVyLFxuICogYG51bGxgIHdoZW4gdGhlIHF1ZXJ5J3MgY2hhcmFjdGVycyBkbyBub3QgYXBwZWFyIGluIG9yZGVyIGF0IGFsbC5cbiAqXG4gKiBUaGUgd2VpZ2h0cyBlbmNvZGUgd2hhdCBzb21lb25lIHR5cGluZyBpbnRvIGEganVtcCBib3ggbWVhbnM6XG4gKlxuICogLSAqKmNvbnRpZ3VpdHkqKiBkb21pbmF0ZXMsIGJlY2F1c2UgYG1hcmVgIG1lYW5pbmcgYE1hcmVuYCBpcyB0aGUgY29tbW9uIGNhc2VcbiAqICAgYW5kIGBt4oCmYeKApnLigKZlYCBzY2F0dGVyZWQgdGhyb3VnaCBhIHNlbnRlbmNlIGlzIHRoZSByYXJlIG9uZTtcbiAqIC0gKip3b3JkIHN0YXJ0cyoqIHNjb3JlLCBzbyBgbWJgIGZpbmRzIGBNYXJlbidzIEJha2VyeWAgcmF0aGVyIHRoYW4gYE51bWJlcmA7XG4gKiAtICoqZWFybGllciBpcyBiZXR0ZXIqKiwgYW5kIGEgKipzaG9ydGVyIG5hbWUqKiB3aW5zIGEgdGllLCBiZWNhdXNlIHRoZSB0aGluZ1xuICogICB5b3UgbWVhbnQgaXMgdXN1YWxseSB0aGUgdGhpbmcgd2l0aCBsZXNzIGFyb3VuZCBpdC5cbiAqXG4gKiDimqAgVEhFIE5VTUJFUlMgQVJFIFRBU1RFLCBOT1QgVFJVVEguIFRoZXkgYXJlIHBpbm5lZCBieSBjZWxscyB0aGF0IGFzc2VydFxuICogT1JERVJJTkdTIChcInRoaXMgYmVhdHMgdGhhdFwiKSByYXRoZXIgdGhhbiB2YWx1ZXMsIHNvIHRoZXkgY2FuIGJlIHJldHVuZWRcbiAqIHdpdGhvdXQgcmV3cml0aW5nIHRoZSB0ZXN0cyDigJQgd2hpY2ggaXMgdGhlIG9ubHkgd2F5IGEgc2NvcmVyIGxpa2UgdGhpcyBzdGF5c1xuICogY2hhbmdlYWJsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjb3JlTmFtZShuYW1lOiBzdHJpbmcsIHF1ZXJ5OiBzdHJpbmcpOiBudW1iZXIgfCBudWxsIHtcbiAgY29uc3QgcSA9IHF1ZXJ5LnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICBpZiAocSA9PT0gXCJcIikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGhheSA9IG5hbWUudG9Mb3dlckNhc2UoKTtcbiAgbGV0IHNjb3JlID0gMDtcbiAgbGV0IGF0ID0gMDtcbiAgbGV0IHJ1biA9IDA7XG4gIGZvciAoY29uc3QgY2ggb2YgcSkge1xuICAgIGNvbnN0IGZvdW5kID0gaGF5LmluZGV4T2YoY2gsIGF0KTtcbiAgICBpZiAoZm91bmQgPT09IC0xKSByZXR1cm4gbnVsbDtcbiAgICBydW4gPSBmb3VuZCA9PT0gYXQgJiYgYXQgPiAwID8gcnVuICsgMSA6IDA7XG4gICAgc2NvcmUgKz0gMTAgKyBydW4gKiAxMjtcbiAgICBpZiAoZm91bmQgPT09IDAgfHwgaXNCb3VuZGFyeShoYXlbZm91bmQgLSAxXSBhcyBzdHJpbmcpKSBzY29yZSArPSAxNDtcbiAgICAvLyBEaXN0YW5jZSBmcm9tIHdoZXJlIHdlIHdlcmUgbG9va2luZyBjb3N0cywgc28gc2NhdHRlcmVkIG1hdGNoZXMgcmFuayBsb3cuXG4gICAgc2NvcmUgLT0gTWF0aC5taW4oZm91bmQgLSBhdCwgMTIpO1xuICAgIGF0ID0gZm91bmQgKyAxO1xuICB9XG4gIC8vIEEgd2hvbGUtd29yZCBzdWJzdHJpbmcgaXMgdGhlIHN0cm9uZ2VzdCBzaWduYWwgdGhlcmUgaXM7IHNheSBzbyBsb3VkbHkuXG4gIGlmIChoYXkuaW5jbHVkZXMocSkpIHNjb3JlICs9IDQwO1xuICBpZiAoaGF5LnN0YXJ0c1dpdGgocSkpIHNjb3JlICs9IDI1O1xuICAvLyBTaG9ydGVyIG5hbWVzIHdpbiB0aWVzLlxuICBzY29yZSAtPSBNYXRoLm1pbihuYW1lLmxlbmd0aCwgNDApIC8gNDtcbiAgcmV0dXJuIHNjb3JlO1xufVxuXG4vKiogQSBkb2N1bWVudCB0aGUgTkFNRSBtYXRjaGVkLiAqL1xuZXhwb3J0IHR5cGUgTmFtZU1hdGNoID0ge1xuICBwYXRoOiBzdHJpbmc7XG4gIHNsdWc/OiBzdHJpbmc7XG4gIG5hbWU6IHN0cmluZztcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIHNjb3JlOiBudW1iZXI7XG59O1xuXG4vKipcbiAqIOKblCBUSEUgU1dBUCBTRUFNIChDb2xlKTogXCJpZiB3ZSBmaW5kIHRoYXQgYWN0dWFsbHkgd2Ugc2hvdWxkIHVzZSBGdXNlLCBpdCdzXG4gKiBmYWlybHkgZWFzeSB0byByZXBsYWNlLlwiXG4gKlxuICogVGhlIGludGVyZmFjZSBpcyBDT1JQVVMtU0hBUEVEIOKAlCB0YWtlIHRoZSB3aG9sZSBjYW5kaWRhdGUgbGlzdCBhbmQgYSBxdWVyeSxcbiAqIHJldHVybiBhIHJhbmtlZCBzbGljZSDigJQgYW5kIHRoYXQgc2hhcGUgaXMgdGhlIHdob2xlIHBvaW50LiBBIHBlci1pdGVtXG4gKiBgc2NvcmUobmFtZSwgcXVlcnkpYCBob29rIHdvdWxkIGhhdmUgbG9va2VkIGxpa2UgdGhlIHNtYWxsZXIgYWJzdHJhY3Rpb24gYW5kXG4gKiB3b3VsZCBoYXZlIEZPVUdIVCB0aGUgdmVyeSBsaWJyYXJ5IGl0IGV4aXN0cyB0byBhZG1pdDogRnVzZSBpbmRleGVzIGEgbGlzdFxuICogYW5kIHNlYXJjaGVzIGl0LCBpdCBkb2VzIG5vdCBzY29yZSBvbmUgc3RyaW5nIGF0IGEgdGltZS4gV3JpdHRlbiB0aGlzIHdheSxcbiAqIG1vdmluZyB0byBGdXNlIGlzIGEgbmV3IGZ1bmN0aW9uIGFuZCBvbmUgZGVmYXVsdCBjaGFuZ2VkOlxuICpcbiAqICAgICBjb25zdCBmdXNlTmFtZXM6IE5hbWVTZWFyY2ggPSAoY2FuZGlkYXRlcywgcXVlcnksIGxpbWl0KSA9PiB7XG4gKiAgICAgICBjb25zdCBmdXNlID0gbmV3IEZ1c2UoY2FuZGlkYXRlcywgeyBrZXlzOiBbXCJuYW1lXCIsIFwidGl0bGVcIl0sIOKApiB9KTtcbiAqICAgICAgIHJldHVybiBmdXNlLnNlYXJjaChxdWVyeSwgeyBsaW1pdCB9KS5tYXAo4oCmKTtcbiAqICAgICB9O1xuICpcbiAqIE5vdGhpbmcgZWxzZSBpbiB0aGlzIG1vZHVsZSwgdGhlIHNlc3Npb24sIHRoZSB3aXJlIG9yIHRoZSBzdXJmYWNlIG1vdmVzLlxuICovXG5leHBvcnQgdHlwZSBOYW1lU2VhcmNoID0gKFxuICBjYW5kaWRhdGVzOiByZWFkb25seSBDYW5kaWRhdGVbXSxcbiAgcXVlcnk6IHN0cmluZyxcbiAgbGltaXQ6IG51bWJlcixcbikgPT4gTmFtZU1hdGNoW107XG5cbi8qKiBBIGRvY3VtZW50IHRoZSBDT05URU5UIG1hdGNoZWQuICovXG5leHBvcnQgdHlwZSBUZXh0TWF0Y2ggPSB7XG4gIHBhdGg6IHN0cmluZztcbiAgc2x1Zz86IHN0cmluZztcbiAgbmFtZTogc3RyaW5nO1xuICB2ZXJzaW9uPzogbnVtYmVyO1xuICBoaXRzOiBIaXRbXTtcbn07XG5cbmV4cG9ydCB0eXBlIFNlYXJjaFJlcG9ydCA9IHtcbiAgcXVlcnk6IHN0cmluZztcbiAgLyoqIE5hbWUvdGl0bGUgbWF0Y2hlcywgYmVzdCBmaXJzdCDigJQgdGhlIGp1bXAgbGlzdC4gKi9cbiAgZG9jdW1lbnRzOiBOYW1lTWF0Y2hbXTtcbiAgLyoqIENvbnRlbnQgbWF0Y2hlcywgaW4gY29udGV4dCBvcmRlciDigJQgdGhlIGZpbmQgbGlzdC4gKi9cbiAgdGV4dDogVGV4dE1hdGNoW107XG4gIC8qKiBUb3RhbCBjb250ZW50IGhpdHMgcmVwb3J0ZWQuICovXG4gIGNvdW50OiBudW1iZXI7XG4gIC8qKiBUcnVlIHdoZW4gYSBjYXAgc3RvcHBlZCB0aGUgc2VhcmNoIGVhcmx5LCBzbyBcIjNcIiBhbmQgXCIzIG9mIG1vcmVcIiBkaWZmZXIuICovXG4gIHRydW5jYXRlZDogYm9vbGVhbjtcbn07XG5cbi8qKiBQZXItZG9jdW1lbnQgY29udGVudCBjYXAsIHNvIG9uZSBlbm9ybW91cyBkb2N1bWVudCBjYW5ub3QgZmlsbCB0aGUgcmVwb3J0LiAqL1xuZXhwb3J0IGNvbnN0IFBFUl9ET0MgPSAyMDtcbi8qKiBXaG9sZS1yZXBvcnQgY29udGVudCBjYXAuICovXG5leHBvcnQgY29uc3QgVE9UQUwgPSAyMDA7XG4vKiogSG93IG1hbnkgbmFtZSBtYXRjaGVzIGFyZSB3b3J0aCBzaG93aW5nLiAqL1xuZXhwb3J0IGNvbnN0IE5BTUVTID0gMTA7XG5cbi8qKlxuICogVGhlIGRlZmF1bHQgYE5hbWVTZWFyY2hgOiBgc2NvcmVOYW1lYCBvdmVyIGV2ZXJ5IGNhbmRpZGF0ZSwgcmFua2VkLlxuICpcbiAqIEEgZG9jdW1lbnQncyBUSVRMRSBpcyBtYXRjaGVkIGFzIHdlbGwgYXMgaXRzIGZpbGVuYW1lIOKAlCBhbiBPS0YgZG9jdW1lbnQnc1xuICogbmFtZSBhbmQgdGl0bGUgb2Z0ZW4gZGlmZmVyIGFuZCB0aGUgaHVtYW4gbWF5IHJlbWVtYmVyIGVpdGhlciDigJQgYW5kIHRoZVxuICogYmV0dGVyIG9mIHRoZSB0d28gc2NvcmVzIGlzIHRoZSBvbmUgdGhhdCBjb3VudHMuXG4gKi9cbmV4cG9ydCBjb25zdCByYW5rTmFtZXM6IE5hbWVTZWFyY2ggPSAoY2FuZGlkYXRlcywgcXVlcnksIGxpbWl0KSA9PiB7XG4gIGNvbnN0IG91dDogTmFtZU1hdGNoW10gPSBbXTtcbiAgZm9yIChjb25zdCBjIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICBjb25zdCBieU5hbWUgPSBzY29yZU5hbWUoYy5uYW1lLCBxdWVyeSk7XG4gICAgY29uc3QgYnlUaXRsZSA9IGMudGl0bGUgPT09IHVuZGVmaW5lZCA/IG51bGwgOiBzY29yZU5hbWUoYy50aXRsZSwgcXVlcnkpO1xuICAgIGlmIChieU5hbWUgPT09IG51bGwgJiYgYnlUaXRsZSA9PT0gbnVsbCkgY29udGludWU7XG4gICAgb3V0LnB1c2goe1xuICAgICAgcGF0aDogYy5wYXRoLFxuICAgICAgLi4uKGMuc2x1ZyAhPT0gdW5kZWZpbmVkID8geyBzbHVnOiBjLnNsdWcgfSA6IHt9KSxcbiAgICAgIG5hbWU6IGMubmFtZSxcbiAgICAgIC4uLihjLnRpdGxlICE9PSB1bmRlZmluZWQgPyB7IHRpdGxlOiBjLnRpdGxlIH0gOiB7fSksXG4gICAgICBzY29yZTogTWF0aC5tYXgoYnlOYW1lID8/IC1JbmZpbml0eSwgYnlUaXRsZSA/PyAtSW5maW5pdHkpLFxuICAgIH0pO1xuICB9XG4gIG91dC5zb3J0KChhLCBiKSA9PiBiLnNjb3JlIC0gYS5zY29yZSB8fCBhLm5hbWUubG9jYWxlQ29tcGFyZShiLm5hbWUpKTtcbiAgcmV0dXJuIG91dC5zbGljZSgwLCBsaW1pdCk7XG59O1xuXG5leHBvcnQgdHlwZSBDYW5kaWRhdGUgPSB7XG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBiYXNlbmFtZSwgd2hpY2ggaXMgd2hhdCBhIGh1bWFuIHR5cGVzIGF0LiAqL1xuICBuYW1lOiBzdHJpbmc7XG4gIHNsdWc/OiBzdHJpbmc7XG4gIHRpdGxlPzogc3RyaW5nO1xuICB2ZXJzaW9uPzogbnVtYmVyO1xufTtcblxuLyoqXG4gKiBTZWFyY2ggYSBsaXN0IG9mIGNhbmRpZGF0ZXMgZm9yIGJvdGgga2luZHMgb2YgbWF0Y2guXG4gKlxuICogYHJlYWRgIG1heSB0aHJvdyBvciByZXR1cm4gbnVsbCBmb3IgYSBkb2N1bWVudCB0aGF0IGhhcyBiZWVuIGRlbGV0ZWQgdW5kZXJcbiAqIHRoZSBjb250ZXh0IOKAlCBhIHNlYXJjaCBpcyBub3QgdGhlIG1vbWVudCB0byBmYWlsIG92ZXIgdGhhdCwgc28gaXQgaXMgc2tpcHBlZFxuICogcmF0aGVyIHRoYW4gcmVwb3J0ZWQgYXMgYSBkb2N1bWVudCB3aXRoIG5vIGhpdHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZWFyY2hEb2N1bWVudHMoXG4gIGNhbmRpZGF0ZXM6IHJlYWRvbmx5IENhbmRpZGF0ZVtdLFxuICBxdWVyeTogc3RyaW5nLFxuICByZWFkOiAoYzogQ2FuZGlkYXRlKSA9PiBzdHJpbmcgfCBudWxsLFxuICBjYXBzOiB7IHBlckRvYz86IG51bWJlcjsgdG90YWw/OiBudW1iZXI7IG5hbWVzPzogbnVtYmVyOyBuYW1lU2VhcmNoPzogTmFtZVNlYXJjaCB9ID0ge30sXG4pOiBTZWFyY2hSZXBvcnQge1xuICBjb25zdCBxID0gcXVlcnkudHJpbSgpO1xuICBpZiAocSA9PT0gXCJcIikgcmV0dXJuIHsgcXVlcnk6IFwiXCIsIGRvY3VtZW50czogW10sIHRleHQ6IFtdLCBjb3VudDogMCwgdHJ1bmNhdGVkOiBmYWxzZSB9O1xuICBjb25zdCBwZXJEb2MgPSBjYXBzLnBlckRvYyA/PyBQRVJfRE9DO1xuICBjb25zdCB0b3RhbCA9IGNhcHMudG90YWwgPz8gVE9UQUw7XG4gIGNvbnN0IG5hbWVzID0gY2Fwcy5uYW1lcyA/PyBOQU1FUztcblxuICBjb25zdCBzY29yZWQgPSAoY2Fwcy5uYW1lU2VhcmNoID8/IHJhbmtOYW1lcykoY2FuZGlkYXRlcywgcSwgbmFtZXMpO1xuXG4gIGNvbnN0IHRleHQ6IFRleHRNYXRjaFtdID0gW107XG4gIGxldCBjb3VudCA9IDA7XG4gIGxldCB0cnVuY2F0ZWQgPSBmYWxzZTtcbiAgZm9yIChjb25zdCBjIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICBpZiAoY291bnQgPj0gdG90YWwpIHtcbiAgICAgIHRydW5jYXRlZCA9IHRydWU7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgbGV0IGJvZHk6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBib2R5ID0gcmVhZChjKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGJvZHkgPSBudWxsO1xuICAgIH1cbiAgICBpZiAoYm9keSA9PT0gbnVsbCkgY29udGludWU7XG4gICAgY29uc3Qgcm9vbSA9IE1hdGgubWluKHBlckRvYywgdG90YWwgLSBjb3VudCk7XG4gICAgY29uc3QgaGl0cyA9IHNlYXJjaFRleHQoYm9keSwgcSwgcm9vbSArIDEpO1xuICAgIGlmIChoaXRzLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG4gICAgaWYgKGhpdHMubGVuZ3RoID4gcm9vbSkgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICBjb25zdCBrZXB0ID0gaGl0cy5zbGljZSgwLCByb29tKTtcbiAgICBjb3VudCArPSBrZXB0Lmxlbmd0aDtcbiAgICB0ZXh0LnB1c2goe1xuICAgICAgcGF0aDogYy5wYXRoLFxuICAgICAgLi4uKGMuc2x1ZyAhPT0gdW5kZWZpbmVkID8geyBzbHVnOiBjLnNsdWcgfSA6IHt9KSxcbiAgICAgIG5hbWU6IGMubmFtZSxcbiAgICAgIC4uLihjLnZlcnNpb24gIT09IHVuZGVmaW5lZCA/IHsgdmVyc2lvbjogYy52ZXJzaW9uIH0gOiB7fSksXG4gICAgICBoaXRzOiBrZXB0LFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIHsgcXVlcnk6IHEsIGRvY3VtZW50czogc2NvcmVkLCB0ZXh0LCBjb3VudCwgdHJ1bmNhdGVkIH07XG59XG4iLAogICAgIi8vIElzIHRoZSBodW1hbiB3YWl0aW5nIG9uIGFuIGFuc3dlciwgYW5kIGZvciBob3cgbG9uZyAoRTUzKT9cbi8vXG4vLyDim5QgREVSSVZFRCwgTk9UIERFQ0xBUkVEIOKAlCBDb2xlJ3MgcnVsaW5nLCBhbmQgdGhlIHJlYXNvbiBpcyBsb2FkLWJlYXJpbmc6IFwid2Vcbi8vIGNvdWxkIGFkZCBzb21lIGFmZm9yZGFuY2UgdGhhdCBzZW5kcyBhIGNoZWNrLWluIHdpdGggYW4gYWdlbnTigKYgd2hlcmUgd2UncmVcbi8vIG5vdCBhZGRpbmcgbW9yZSB0YXNrcyBmb3IgdGhlIGFnZW50IHRvIGhhdmUgdG8gZXhwbGljaXRseSBkby5cIiBBbiBhZ2VudCB0aGF0XG4vLyBtdXN0IHJlbWVtYmVyIHRvIHNheSBcInRoaW5raW5nXCIgd2lsbCBmb3JnZXQgZXhhY3RseSB3aGVuIGl0IG1hdHRlcnMg4oCUIGl0IGlzXG4vLyBidXN5LCB3aGljaCBpcyB0aGUgd2hvbGUgc2l0dWF0aW9uIGJlaW5nIHNpZ25hbGxlZC4gU28gbm90aGluZyBoZXJlIGFza3MgdGhlXG4vLyBhZ2VudCBmb3IgYW55dGhpbmcuIFRoZSBzdGF0ZSBpcyByZWFkIG9mZiB0aGUgY29udmVyc2F0aW9uOiBhIGh1bWFuIG1lc3NhZ2Vcbi8vIHdpdGggbm8gYWdlbnQgbWVzc2FnZSBhZnRlciBpdCBpcyBhIGh1bWFuIHdhaXRpbmcuXG4vL1xuLy8g4puUIEFORCBUSEUgQUdFTlQnUyBSRVBMWSBJUyBUSEUgQ09NUExFVElPTiBTSUdOQUwsIHdoaWNoIGlzIG1pbmQtbWFwcGVyJ3Ncbi8vIHJ1bGUgKFIxMSBTRUFNIDIpIGFuZCBpcyBzdG9sZW4gZGVsaWJlcmF0ZWx5LiBUaGVyZSBpcyBubyBgZG9uZWAgc3RhdGUgdG9cbi8vIGVtaXQsIHNvIHRoZXJlIGlzIG5vIGBkb25lYCBzdGF0ZSB0byBnZXQgb3V0IG9mIHN5bmMuIE9uZSBjb25zZXF1ZW5jZSB3b3J0aFxuLy8gbmFtaW5nIGJlY2F1c2UgaXQgZmVsbCBvdXQgZm9yIGZyZWU6IGBzdGFydFRhc2tgIHBvc3RzIGl0cyBhbm5vdW5jZW1lbnQgQVNcbi8vIFRIRSBBR0VOVCAoRTUwKSwgc28gdGhlIGhhcHB5IHBhdGggQ29sZSBkZXNjcmliZWQg4oCUIFwiZ3JlYXQsIEknbSBnb2luZyB0byBnZXRcbi8vIHRoYXQgc3RhcnRlZFwiLCB0aGVuIGEgdGFzaywgdGhlbiBhIHN1YmFnZW50IOKAlCBjbGVhcnMgdGhpcyBieSBjb25zdHJ1Y3Rpb24uXG4vL1xuLy8g4pqgIEEgU1lTVEVNIExJTkUgSVMgTk9UIEEgUkVQTFkuIGBhbm5vdW5jZSgpYCBuYXJyYXRlcyBhZ2VudCBBQ1RTIChcIkFnZW50XG4vLyBub3RlZCDigKYgb24gbWFyZW5cIiksIHdoaWNoIGlzIGV2aWRlbmNlIG9mIGxpZmUgYnV0IG5vdCBhIGNoZWNrLWluIHdpdGggdGhlXG4vLyBwZXJzb24gd2FpdGluZy4gQ291bnRpbmcgaXQgd291bGQgc2lsZW5jZSB0aGUgc2lnbmFsIHByZWNpc2VseSBpbiB0aGUgY2FzZVxuLy8gdGhpcyBleGlzdHMgZm9yOiBhbiBhZ2VudCB0aGF0IGlzIGJ1c3kgZG9pbmcgdGhpbmdzIGFuZCBoYXMgbm90IHNhaWQgYSB3b3JkXG4vLyB0byB0aGUgaHVtYW4uIE9ubHkgYHdobyA9PT0gXCJhZ2VudFwiYCBjbGVhcnMuXG5pbXBvcnQgdHlwZSB7IENoYXRXaG8sIFdhaXRpbmcgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKipcbiAqIEhvdyBsb25nIGEgaHVtYW4gd2FpdHMgYmVmb3JlIHRoZSB3YWl0IGlzIHdvcnRoIHJlcG9ydGluZy4gMzAgcywgQ29sZSdzXG4gKiBudW1iZXIg4oCUIGxvbmcgZW5vdWdoIHRoYXQgYW4gb3JkaW5hcnkgYW5zd2VyIG5ldmVyIHRyaXBzIGl0LCBzaG9ydCBlbm91Z2hcbiAqIHRoYXQgaXQgaXMgc3RpbGwgdGhlIHNhbWUgbW9tZW50IGZvciB0aGUgcGVyc29uIHNpdHRpbmcgdGhlcmUuXG4gKi9cbmV4cG9ydCBjb25zdCBTVEFMTF9NUyA9IDMwXzAwMDtcblxuLyoqIFdoYXQgYSBzbm9vemUgYnV5cywgd2hlbiB0aGUgYWdlbnQgZG9lcyBub3QgbmFtZSBhIGR1cmF0aW9uLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfU05PT1pFX01TID0gMTIwXzAwMDtcblxuLy8gYFdhaXRpbmdgIGl0c2VsZiBsaXZlcyBpbiBgcHJvdG9jb2wudHNgIOKAlCBpdCByaWRlcyBpbiBgUHVibGljU3RhdGVgLCBhbmQgdGhhdFxuLy8gZmlsZSBpcyBpbXBvcnQtZnJlZSBvbiBwdXJwb3NlLiBJdHMgYGJhZGdlYCBjYXJyaWVzIHRoZSBydWxlIHRoYXQgbWF0dGVyczpcbi8vIOKblCBTVEFMTEVEIE1VU1QgTk9UIFBVTFNFLiBBIHB1bHNlIG92ZXIgYSB3ZWRnZWQgYWdlbnQgaXMgZmFsc2UgbGl2ZW5lc3Mg4oCUIHRoZVxuLy8gYW5pbWF0aW9uIGNsYWltcyBcInNvbWV0aGluZyBpcyBoYXBwZW5pbmdcIiB3aGVuIHRoZSBob25lc3QgYW5zd2VyIGlzIFwiSSBjYW5ub3Rcbi8vIHRlbGwgYW55IG1vcmVcIi4gbWluZC1tYXBwZXIgc2VwYXJhdGVzIHRoZXNlIHR3byBmb3IgdGhlIHNhbWUgcmVhc29uLlxuXG50eXBlIE1zZyA9IHsgaWQ6IHN0cmluZzsgd2hvOiBDaGF0V2hvOyB0czogbnVtYmVyIH07XG5cbi8qKlxuICogVGhlIGh1bWFuIG1lc3NhZ2Ugbm90aGluZyBoYXMgYW5zd2VyZWQgeWV0LCBvciBudWxsLlxuICpcbiAqIGBhY2tub3dsZWRnZWRVbnRpbGAgaXMgYSBzbm9vemUgKHRoZSBhZ2VudCBzYWlkIGl0IGlzIHN0aWxsIHdvcmtpbmcpLiBXaGlsZVxuICogaXQgaG9sZHMsIHRoZSBiYWRnZSBzdGF5cyBhIHB1bHNlIHBhc3QgdGhlIHN0YWxsIHRocmVzaG9sZCDigJQgdGhlIGFnZW50XG4gKiB2b2x1bnRlZXJlZCBldmlkZW5jZSBvZiBsaWZlLCBzbyBzaG93aW5nIFwibWF5IGJlIHN0dWNrXCIgd291bGQgYmUgdGhlIGxpZS5cbiAqIFdoZW4gaXQgRVhQSVJFUyB0aGUgYmFkZ2UgZ29lcyBzdGFsbGVkIGFnYWluLCBiZWNhdXNlIHRoZSBodW1hbiBpcyBvd2VkIHRoZVxuICogdHJ1dGggZXZlbnR1YWxseTsgdGhhdCBleHBpcnkgaXMgZGVsaWJlcmF0ZWx5IG5vdCBhIHJlYXNvbiB0byBudWRnZSB0aGUgYWdlbnRcbiAqIGEgc2Vjb25kIHRpbWUgKHNlZSB0aGUgc2VydmVyJ3Mgb25jZS1wZXItbWVzc2FnZSBydWxlKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdhaXRpbmdPbihcbiAgY2hhdDogcmVhZG9ubHkgTXNnW10sXG4gIG5vdzogbnVtYmVyLFxuICBvcHRzOiB7IHN0YWxsTXM/OiBudW1iZXI7IGFja25vd2xlZGdlZFVudGlsPzogbnVtYmVyIH0gPSB7fSxcbik6IFdhaXRpbmcgfCBudWxsIHtcbiAgY29uc3Qgc3RhbGxNcyA9IG9wdHMuc3RhbGxNcyA/PyBTVEFMTF9NUztcbiAgLy8gV2FsayBiYWNrIHRvIHRoZSBsYXN0IHRoaW5nIHRoYXQgd2FzIG5vdCBuYXJyYXRpb24uIEEgaHVtYW4gdGhlcmUgbWVhbnNcbiAgLy8gbm9ib2R5IGhhcyBhbnN3ZXJlZCB0aGVtLlxuICBsZXQgcGVuZGluZzogTXNnIHwgbnVsbCA9IG51bGw7XG4gIGZvciAobGV0IGkgPSBjaGF0Lmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgY29uc3QgbSA9IGNoYXRbaV07XG4gICAgaWYgKCFtIHx8IG0ud2hvID09PSBcInN5c3RlbVwiKSBjb250aW51ZTtcbiAgICBpZiAobS53aG8gPT09IFwiYWdlbnRcIikgcmV0dXJuIG51bGw7XG4gICAgcGVuZGluZyA9IG07XG4gICAgYnJlYWs7XG4gIH1cbiAgaWYgKCFwZW5kaW5nKSByZXR1cm4gbnVsbDtcblxuICAvLyDimqAgVGhlIEZJUlNUIG9mIHRoZSB1bmFuc3dlcmVkIHJ1biwgbm90IHRoZSBsYXN0LiBTb21lb25lIHdobyBzZW5kcyB0aHJlZVxuICAvLyBtZXNzYWdlcyB3aGlsZSB3YWl0aW5nIGhhcyBiZWVuIHdhaXRpbmcgc2luY2UgdGhlIGZpcnN0IG9uZSwgYW5kIHJlc2V0dGluZ1xuICAvLyB0aGUgY2xvY2sgb24gZXZlcnkgZm9sbG93LXVwIHdvdWxkIG1lYW4gdGhlIG1vcmUgYW54aW91cyB0aGV5IGdldCwgdGhlXG4gIC8vIGxvbmdlciB3ZSBjbGFpbSB0aGV5IGhhdmUgYmVlbiB3YWl0aW5nIGlzIHplcm8uXG4gIGxldCBzaW5jZSA9IHBlbmRpbmcudHM7XG4gIGxldCBtZXNzYWdlSWQgPSBwZW5kaW5nLmlkO1xuICBmb3IgKGxldCBpID0gY2hhdC5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgIGNvbnN0IG0gPSBjaGF0W2ldO1xuICAgIGlmICghbSB8fCBtLndobyA9PT0gXCJzeXN0ZW1cIikgY29udGludWU7XG4gICAgaWYgKG0ud2hvICE9PSBcImh1bWFuXCIpIGJyZWFrO1xuICAgIHNpbmNlID0gbS50cztcbiAgICBtZXNzYWdlSWQgPSBtLmlkO1xuICB9XG5cbiAgY29uc3QgYWNrbm93bGVkZ2VkID0gb3B0cy5hY2tub3dsZWRnZWRVbnRpbCAhPT0gdW5kZWZpbmVkICYmIG5vdyA8IG9wdHMuYWNrbm93bGVkZ2VkVW50aWw7XG4gIGNvbnN0IHN0YWxsZWQgPSBub3cgLSBzaW5jZSA+PSBzdGFsbE1zICYmICFhY2tub3dsZWRnZWQ7XG4gIHJldHVybiB7IG1lc3NhZ2VJZCwgc2luY2UsIGJhZGdlOiBzdGFsbGVkID8gXCJzdGFsbGVkXCIgOiBcIndvcmtpbmdcIiB9O1xufVxuXG4vKiogV2hhdCB0aGUgY29udmVyc2F0aW9uIHNob3dzLCBwZXIgYmFkZ2UuIG1pbmQtbWFwcGVyJ3Mgd29yZHMsIG5lYXIgZW5vdWdoLiAqL1xuZXhwb3J0IGNvbnN0IFdBSVRJTkdfTEFCRUw6IFJlY29yZDxXYWl0aW5nW1wiYmFkZ2VcIl0sIHN0cmluZz4gPSB7XG4gIHdvcmtpbmc6IFwid29ya2luZyBvbiB0aGlz4oCmXCIsXG4gIHN0YWxsZWQ6IFwidG9vayB0aGlzIGluLCB0aGVuIHdlbnQgcXVpZXQg4oCUIG1heSBiZSBzdHVja1wiLFxufTtcbiIKICBdLAogICJtYXBwaW5ncyI6ICI7Ozs7QUFxREEseUJB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QU8sUUFBUSxPQUFPLGFBQWEsUUFBUSxFQUFFLFVBQVUsT0FBTyxDQUFDLEVBQUUsQ0FBQztBQUFBLENBQzVGO0FBQUEsSUFDQSxPQUFPLFdBQVcsTUFBTSxJQUFJLFdBQVcsTUFBTSxJQUFJO0FBQUE7QUFBQSxFQUVuRCxRQUFRLE9BQU8sTUFDYixHQUFHLEtBQUssVUFBVSxFQUFFLEtBQUssb0JBQW9CLEVBQUUsUUFBUSxNQUFNLEVBQUUsTUFBTSxZQUFZLEVBQUUsV0FBVyxNQUFNLEVBQUUsTUFBTSxLQUFLLEVBQUUsSUFBSSxDQUFDO0FBQUEsQ0FDMUg7QUFBQSxFQUNBLE1BQU0sTUFBTSxNQUFNLEVBQUU7QUFBQSxFQUNwQixNQUFNLEVBQUU7QUFBQSxFQUVSLElBQUksSUFBSSxTQUFTLEtBQUssTUFBTSxLQUFLO0FBQUEsSUFDL0IsSUFBSTtBQUFBLE1BQ0YsSUFBSSxVQUFTLE1BQU0sR0FBRyxFQUFFLFNBQVM7QUFBQSxRQUFHLFlBQVcsTUFBTSxHQUFHO0FBQUEsTUFDeEQsTUFBTTtBQUFBLEVBR1Y7QUFBQSxFQUNBLE9BQU8sSUFBSTtBQUFBO0FBUWIsZUFBc0IsR0FBRyxHQUFvQjtBQUFBLEVBQzNDLE9BQU8sTUFBTSxLQUFLLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztBQUFBOyIsCiAgImRlYnVnSWQiOiAiRDFGQzI2MDYyQTRBNTZGNzY0NzU2RTIxNjQ3NTZFMjEiLAogICJuYW1lcyI6IFtdCn0=
